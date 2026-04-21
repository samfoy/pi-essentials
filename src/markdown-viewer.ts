/**
 * Markdown Viewer Extension
 *
 * Renders markdown files in the terminal when viewing tool output.
 *
 * Features:
 * - Ctrl+O on read/write/edit of .md files shows rendered markdown
 * - Mermaid code blocks rendered as images (requires `mmdc` CLI + image-capable terminal)
 * - /mdview [path] — render a markdown file on demand
 * - /mermaid — render mermaid from a file or stdin
 *
 * Install mermaid CLI: npm install -g @mermaid-js/mermaid-cli
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, EditToolDetails, ReadToolDetails, Theme } from "@mariozechner/pi-coding-agent";
import { createEditTool, createReadTool, createWriteTool, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Image, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { isMd, extractMermaidBlocks } from "./markdown-utils.js";

export { isMd, extractMermaidBlocks };
const MERMAID_DIR = path.join(os.tmpdir(), "pi-mermaid");

function ensureMermaidDir(): string {
	if (!fs.existsSync(MERMAID_DIR)) fs.mkdirSync(MERMAID_DIR, { recursive: true });
	return MERMAID_DIR;
}


interface MermaidResult {
	filePath: string;
	base64: string;
}

/** Render mermaid via mermaid.ink API, returns file path + base64 or null */
function renderMermaidSync(code: string, index: number): MermaidResult | null {
	try {
		const dir = ensureMermaidDir();
		const b64Code = Buffer.from(code).toString("base64");
		const outFile = path.join(dir, `diagram-${Date.now()}-${index}.jpg`);
		execSync(`curl -sf -o "${outFile}" "https://mermaid.ink/img/${b64Code}"`, {
			timeout: 15000,
			stdio: "pipe",
		});
		if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) return null;
		const base64 = fs.readFileSync(outFile).toString("base64");
		return { filePath: outFile, base64 };
	} catch {
		return null;
	}
}

interface MdDetails {
	_mdContent?: string;
	_mermaidResults?: MermaidResult[];
}

/** Build a rendered markdown Container with optional mermaid images */
function buildMdView(
	content: string,
	mermaidResults: MermaidResult[],
	theme: Theme,
): Container {
	const container = new Container();
	const mdTheme = getMarkdownTheme();
	container.addChild(new Markdown(content, 1, 0, mdTheme));

	if (mermaidResults.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", "─── Mermaid Diagrams ───"), 1, 0));
		for (let i = 0; i < mermaidResults.length; i++) {
			const mr = mermaidResults[i];
			try {
				const img = new Image(mr.base64, "image/jpeg", { fallbackColor: (s: string) => theme.fg("muted", s) }, {
					maxWidthCells: 80,
					maxHeightCells: 40,
				});
				container.addChild(img);
			} catch {
				// Image constructor failed
			}
			// Always show file path as fallback
			container.addChild(new Text(theme.fg("dim", `📎 ${mr.filePath}`), 1, 0));
		}
	}

	return container;
}

/** Enrich tool result details with markdown content and mermaid images */
function enrichMdDetails(
	mdContent: string,
	existingDetails: Record<string, any> | undefined,
): Record<string, any> {
	const mermaidBlocks = extractMermaidBlocks(mdContent);
	const mermaidResults: MermaidResult[] = [];
	for (let i = 0; i < mermaidBlocks.length; i++) {
		const result = renderMermaidSync(mermaidBlocks[i], i);
		if (result) mermaidResults.push(result);
	}
	return {
		...(existingDetails ?? {}),
		_mdContent: mdContent,
		_mermaidResults: mermaidResults,
	};
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	let lastMdPath: string | null = null;

	// ── Override read ──────────────────────────────────────────────
	const origRead = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: origRead.description,
		parameters: origRead.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			const result = await origRead.execute(toolCallId, params, signal, onUpdate);
			if (isMd(params.path)) {
				lastMdPath = params.path;
				const text = result.content[0];
				if (text?.type === "text") {
					result.details = enrichMdDetails(text.text, result.details as any);
				}
			}
			return result;
		},

		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("read "));
			t += theme.fg("accent", args.path);
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				t += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			if (isMd(args.path)) t += theme.fg("muted", " [md]");
			return new Text(t, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);

			const details = result.details as (ReadToolDetails & MdDetails) | undefined;
			const content = result.content[0];

			if (content?.type === "image") return new Text(theme.fg("success", "Image loaded"), 0, 0);
			if (content?.type !== "text") return new Text(theme.fg("error", "No content"), 0, 0);

			const lineCount = content.text.split("\n").length;
			let summary = theme.fg("success", `${lineCount} lines`);
			if (details?.truncation?.truncated) {
				summary += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
			}

			// Expanded .md → rendered markdown
			if (expanded && details?._mdContent) {
				const container = new Container();
				container.addChild(new Text(summary, 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(buildMdView(details._mdContent, details._mermaidResults ?? [], theme));
				return container;
			}

			// Expanded non-md → raw preview
			if (expanded) {
				const lines = content.text.split("\n").slice(0, 15);
				let t = summary;
				for (const line of lines) t += `\n${theme.fg("dim", line)}`;
				if (lineCount > 15) t += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
				return new Text(t, 0, 0);
			}

			if (details?._mdContent) summary += theme.fg("muted", " (Ctrl+O for rendered view)");
			return new Text(summary, 0, 0);
		},
	});

	// ── Override write ─────────────────────────────────────────────
	const origWrite = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: origWrite.description,
		parameters: origWrite.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			const result = await origWrite.execute(toolCallId, params, signal, onUpdate);
			if (isMd(params.path)) {
				lastMdPath = params.path;
				result.details = enrichMdDetails(params.content, result.details as any);
			}
			return result;
		},

		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("write "));
			t += theme.fg("accent", args.path);
			const lineCount = args.content.split("\n").length;
			t += theme.fg("dim", ` (${lineCount} lines)`);
			if (isMd(args.path)) t += theme.fg("muted", " [md]");
			return new Text(t, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);

			const details = result.details as MdDetails | undefined;
			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			let summary = theme.fg("success", "Written");

			if (expanded && details?._mdContent) {
				const container = new Container();
				container.addChild(new Text(summary, 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(buildMdView(details._mdContent, details._mermaidResults ?? [], theme));
				return container;
			}

			if (details?._mdContent) summary += theme.fg("muted", " (Ctrl+O for rendered view)");
			return new Text(summary, 0, 0);
		},
	});

	// ── Override edit ──────────────────────────────────────────────
	const origEdit = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: origEdit.description,
		parameters: origEdit.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			const result = await origEdit.execute(toolCallId, params, signal, onUpdate);
			if (isMd(params.path)) {
				lastMdPath = params.path;
				// Read the file after edit to get full rendered content
				try {
					const resolved = path.resolve(cwd, params.path);
					const content = fs.readFileSync(resolved, "utf-8");
					result.details = enrichMdDetails(content, result.details as any);
				} catch {
					/* file read failed, skip md enrichment */
				}
			}
			return result;
		},

		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("edit "));
			t += theme.fg("accent", args.path);
			if (isMd(args.path)) t += theme.fg("muted", " [md]");
			return new Text(t, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

			const details = result.details as (EditToolDetails & MdDetails) | undefined;
			const content = result.content[0];

			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			if (!details?.diff) {
				const summary = theme.fg("success", "Applied");
				return new Text(summary, 0, 0);
			}

			// Count diff stats
			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let summary = theme.fg("success", `+${additions}`) + theme.fg("dim", " / ") + theme.fg("error", `-${removals}`);

			if (expanded && details._mdContent) {
				// Show diff + rendered markdown
				const container = new Container();
				container.addChild(new Text(summary, 0, 0));
				container.addChild(new Spacer(1));

				// Diff
				let diffText = "";
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						diffText += `${theme.fg("success", line)}\n`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						diffText += `${theme.fg("error", line)}\n`;
					} else {
						diffText += `${theme.fg("dim", line)}\n`;
					}
				}
				if (diffLines.length > 30) diffText += theme.fg("muted", `... ${diffLines.length - 30} more diff lines`);
				container.addChild(new Text(diffText.trimEnd(), 0, 0));

				// Rendered result
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("accent", "─── Rendered ───"), 1, 0));
				container.addChild(buildMdView(details._mdContent, details._mermaidResults ?? [], theme));
				return container;
			}

			if (expanded) {
				// Non-md expanded: just show diff
				let t = summary;
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						t += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						t += `\n${theme.fg("error", line)}`;
					} else {
						t += `\n${theme.fg("dim", line)}`;
					}
				}
				if (diffLines.length > 30) t += `\n${theme.fg("muted", `... ${diffLines.length - 30} more diff lines`)}`;
				return new Text(t, 0, 0);
			}

			if (details?._mdContent) summary += theme.fg("muted", " (Ctrl+O for rendered view)");
			return new Text(summary, 0, 0);
		},
	});

	// ── /mdview command ───────────────────────────────────────────
	pi.registerCommand("mdview", {
		description: "Render a markdown file in the terminal. Usage: /mdview [path]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/mdview requires interactive mode", "error");
				return;
			}

			const filePath = args?.trim() || lastMdPath;
			if (!filePath) {
				ctx.ui.notify("Usage: /mdview <path> (or read a .md file first)", "warning");
				return;
			}

			const resolved = path.resolve(ctx.cwd, filePath);
			let content: string;
			try {
				content = fs.readFileSync(resolved, "utf-8");
			} catch (e: any) {
				ctx.ui.notify(`Cannot read ${resolved}: ${e.message}`, "error");
				return;
			}

			const mermaidBlocks = extractMermaidBlocks(content);
			const mermaidResults: MermaidResult[] = [];
			for (let i = 0; i < mermaidBlocks.length; i++) {
				const result = renderMermaidSync(mermaidBlocks[i], i);
				if (result) mermaidResults.push(result);
			}
			if (mermaidBlocks.length > 0 && mermaidResults.length === 0) {
				ctx.ui.notify("Mermaid blocks found but rendering failed (mermaid.ink unreachable?)", "warning");
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", `─── ${filePath} ───`), 1, 0));
				container.addChild(new Spacer(1));
				container.addChild(buildMdView(content, mermaidResults, theme));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", "Press Escape to close"), 1, 0));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (data === "\x1b" || data === "\x03") done();
					},
				};
			});
		},
	});

	// ── /mermaid command ──────────────────────────────────────────
	pi.registerCommand("mermaid", {
		description: "Render a mermaid diagram. Usage: /mermaid <file.mmd> or /mermaid (uses last .md file's mermaid blocks)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/mermaid requires interactive mode", "error");
				return;
			}

			let codes: string[] = [];
			const arg = args?.trim();

			if (arg && fs.existsSync(path.resolve(ctx.cwd, arg))) {
				const resolved = path.resolve(ctx.cwd, arg);
				const content = fs.readFileSync(resolved, "utf-8");
				if (resolved.endsWith(".mmd") || resolved.endsWith(".mermaid")) {
					codes = [content];
				} else {
					codes = extractMermaidBlocks(content);
					if (codes.length === 0) codes = [content]; // treat whole file as mermaid
				}
			} else if (arg) {
				// Treat argument as inline mermaid code
				codes = [arg];
			} else if (lastMdPath) {
				try {
					const content = fs.readFileSync(path.resolve(ctx.cwd, lastMdPath), "utf-8");
					codes = extractMermaidBlocks(content);
				} catch { /* */ }
			}

			if (codes.length === 0) {
				ctx.ui.notify("No mermaid code found. Usage: /mermaid <file.mmd>", "warning");
				return;
			}

			const results: MermaidResult[] = [];
			for (let i = 0; i < codes.length; i++) {
				const result = renderMermaidSync(codes[i], i);
				if (result) results.push(result);
				else ctx.ui.notify(`Failed to render mermaid block ${i + 1}`, "warning");
			}

			if (results.length === 0) {
				ctx.ui.notify("All mermaid blocks failed to render", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", `─── Mermaid (${results.length} diagram${results.length > 1 ? "s" : ""}) ───`), 1, 0));
				container.addChild(new Spacer(1));

				for (let i = 0; i < results.length; i++) {
					const mr = results[i];
					try {
						container.addChild(new Image(mr.base64, "image/jpeg", { fallbackColor: (s: string) => theme.fg("muted", s) }, {
							maxWidthCells: 80,
							maxHeightCells: 40,
						}));
					} catch {
						container.addChild(new Text(theme.fg("muted", `Diagram ${i + 1} saved to: ${mr.filePath}`), 1, 0));
					}
					if (i < results.length - 1) container.addChild(new Spacer(1));
				}

				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", "Press Escape to close"), 1, 0));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (data === "\x1b" || data === "\x03") done();
					},
				};
			});
		},
	});
}
