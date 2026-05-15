// src/markdown-viewer.ts
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEditTool, createReadTool, createWriteTool, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Image, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

// src/markdown-utils.ts
function isMd(filePath) {
  return /\.(md|mdx|markdown)$/i.test(filePath || "");
}
function extractMermaidBlocks(content) {
  const blocks = [];
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

// src/markdown-viewer.ts
var MERMAID_DIR = path.join(os.tmpdir(), "pi-mermaid");
function ensureMermaidDir() {
  if (!fs.existsSync(MERMAID_DIR)) fs.mkdirSync(MERMAID_DIR, { recursive: true });
  return MERMAID_DIR;
}
function renderMermaidSync(code, index) {
  try {
    const dir = ensureMermaidDir();
    const b64Code = Buffer.from(code).toString("base64");
    const outFile = path.join(dir, `diagram-${Date.now()}-${index}.jpg`);
    execSync(`curl -sf -o "${outFile}" "https://mermaid.ink/img/${b64Code}"`, {
      timeout: 15e3,
      stdio: "pipe"
    });
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) return null;
    const base64 = fs.readFileSync(outFile).toString("base64");
    return { filePath: outFile, base64 };
  } catch {
    return null;
  }
}
function buildMdView(content, mermaidResults, theme) {
  const container = new Container();
  const mdTheme = getMarkdownTheme();
  container.addChild(new Markdown(content, 1, 0, mdTheme));
  if (mermaidResults.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", "\u2500\u2500\u2500 Mermaid Diagrams \u2500\u2500\u2500"), 1, 0));
    for (let i = 0; i < mermaidResults.length; i++) {
      const mr = mermaidResults[i];
      try {
        const img = new Image(mr.base64, "image/jpeg", { fallbackColor: (s) => theme.fg("muted", s) }, {
          maxWidthCells: 80,
          maxHeightCells: 40
        });
        container.addChild(img);
      } catch {
      }
      container.addChild(new Text(theme.fg("dim", `\u{1F4CE} ${mr.filePath}`), 1, 0));
    }
  }
  return container;
}
function enrichMdDetails(mdContent, existingDetails) {
  const mermaidBlocks = extractMermaidBlocks(mdContent);
  const mermaidResults = [];
  for (let i = 0; i < mermaidBlocks.length; i++) {
    const result = renderMermaidSync(mermaidBlocks[i], i);
    if (result) mermaidResults.push(result);
  }
  return {
    ...existingDetails ?? {},
    _mdContent: mdContent,
    _mermaidResults: mermaidResults
  };
}
function markdown_viewer_default(pi) {
  const cwd = process.cwd();
  let lastMdPath = null;
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
          result.details = enrichMdDetails(text.text, result.details);
        }
      }
      return result;
    },
    renderCall(args, theme) {
      let t = theme.fg("toolTitle", theme.bold("read "));
      t += theme.fg("accent", args.path);
      if (args.offset || args.limit) {
        const parts = [];
        if (args.offset) parts.push(`offset=${args.offset}`);
        if (args.limit) parts.push(`limit=${args.limit}`);
        t += theme.fg("dim", ` (${parts.join(", ")})`);
      }
      if (isMd(args.path)) t += theme.fg("muted", " [md]");
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
      const details = result.details;
      const content = result.content[0];
      if (content?.type === "image") return new Text(theme.fg("success", "Image loaded"), 0, 0);
      if (content?.type !== "text") return new Text(theme.fg("error", "No content"), 0, 0);
      const lineCount = content.text.split("\n").length;
      let summary = theme.fg("success", `${lineCount} lines`);
      if (details?.truncation?.truncated) {
        summary += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
      }
      if (expanded && details?._mdContent) {
        const container = new Container();
        container.addChild(new Text(summary, 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(buildMdView(details._mdContent, details._mermaidResults ?? [], theme));
        return container;
      }
      if (expanded) {
        const lines = content.text.split("\n").slice(0, 15);
        let t = summary;
        for (const line of lines) t += `
${theme.fg("dim", line)}`;
        if (lineCount > 15) t += `
${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
        return new Text(t, 0, 0);
      }
      if (details?._mdContent) summary += theme.fg("muted", " (Ctrl+O for rendered view)");
      return new Text(summary, 0, 0);
    }
  });
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
        result.details = enrichMdDetails(params.content, result.details);
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
      const details = result.details;
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
    }
  });
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
        try {
          const resolved = path.resolve(cwd, params.path);
          const content = fs.readFileSync(resolved, "utf-8");
          result.details = enrichMdDetails(content, result.details);
        } catch {
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
      const details = result.details;
      const content = result.content[0];
      if (content?.type === "text" && content.text.startsWith("Error")) {
        return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
      }
      if (!details?.diff) {
        const summary2 = theme.fg("success", "Applied");
        return new Text(summary2, 0, 0);
      }
      const diffLines = details.diff.split("\n");
      let additions = 0;
      let removals = 0;
      for (const line of diffLines) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        if (line.startsWith("-") && !line.startsWith("---")) removals++;
      }
      let summary = theme.fg("success", `+${additions}`) + theme.fg("dim", " / ") + theme.fg("error", `-${removals}`);
      if (expanded && details._mdContent) {
        const container = new Container();
        container.addChild(new Text(summary, 0, 0));
        container.addChild(new Spacer(1));
        let diffText = "";
        for (const line of diffLines.slice(0, 30)) {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            diffText += `${theme.fg("success", line)}
`;
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            diffText += `${theme.fg("error", line)}
`;
          } else {
            diffText += `${theme.fg("dim", line)}
`;
          }
        }
        if (diffLines.length > 30) diffText += theme.fg("muted", `... ${diffLines.length - 30} more diff lines`);
        container.addChild(new Text(diffText.trimEnd(), 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", "\u2500\u2500\u2500 Rendered \u2500\u2500\u2500"), 1, 0));
        container.addChild(buildMdView(details._mdContent, details._mermaidResults ?? [], theme));
        return container;
      }
      if (expanded) {
        let t = summary;
        for (const line of diffLines.slice(0, 30)) {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            t += `
${theme.fg("success", line)}`;
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            t += `
${theme.fg("error", line)}`;
          } else {
            t += `
${theme.fg("dim", line)}`;
          }
        }
        if (diffLines.length > 30) t += `
${theme.fg("muted", `... ${diffLines.length - 30} more diff lines`)}`;
        return new Text(t, 0, 0);
      }
      if (details?._mdContent) summary += theme.fg("muted", " (Ctrl+O for rendered view)");
      return new Text(summary, 0, 0);
    }
  });
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
      let content;
      try {
        content = fs.readFileSync(resolved, "utf-8");
      } catch (e) {
        ctx.ui.notify(`Cannot read ${resolved}: ${e.message}`, "error");
        return;
      }
      const mermaidBlocks = extractMermaidBlocks(content);
      const mermaidResults = [];
      for (let i = 0; i < mermaidBlocks.length; i++) {
        const result = renderMermaidSync(mermaidBlocks[i], i);
        if (result) mermaidResults.push(result);
      }
      if (mermaidBlocks.length > 0 && mermaidResults.length === 0) {
        ctx.ui.notify("Mermaid blocks found but rendering failed (mermaid.ink unreachable?)", "warning");
      }
      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", `\u2500\u2500\u2500 ${filePath} \u2500\u2500\u2500`), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(buildMdView(content, mermaidResults, theme));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "Press Escape to close"), 1, 0));
        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            if (data === "\x1B" || data === "") done();
          }
        };
      });
    }
  });
  pi.registerCommand("mermaid", {
    description: "Render a mermaid diagram. Usage: /mermaid <file.mmd> or /mermaid (uses last .md file's mermaid blocks)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/mermaid requires interactive mode", "error");
        return;
      }
      let codes = [];
      const arg = args?.trim();
      if (arg && fs.existsSync(path.resolve(ctx.cwd, arg))) {
        const resolved = path.resolve(ctx.cwd, arg);
        const content = fs.readFileSync(resolved, "utf-8");
        if (resolved.endsWith(".mmd") || resolved.endsWith(".mermaid")) {
          codes = [content];
        } else {
          codes = extractMermaidBlocks(content);
          if (codes.length === 0) codes = [content];
        }
      } else if (arg) {
        codes = [arg];
      } else if (lastMdPath) {
        try {
          const content = fs.readFileSync(path.resolve(ctx.cwd, lastMdPath), "utf-8");
          codes = extractMermaidBlocks(content);
        } catch {
        }
      }
      if (codes.length === 0) {
        ctx.ui.notify("No mermaid code found. Usage: /mermaid <file.mmd>", "warning");
        return;
      }
      const results = [];
      for (let i = 0; i < codes.length; i++) {
        const result = renderMermaidSync(codes[i], i);
        if (result) results.push(result);
        else ctx.ui.notify(`Failed to render mermaid block ${i + 1}`, "warning");
      }
      if (results.length === 0) {
        ctx.ui.notify("All mermaid blocks failed to render", "error");
        return;
      }
      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", `\u2500\u2500\u2500 Mermaid (${results.length} diagram${results.length > 1 ? "s" : ""}) \u2500\u2500\u2500`), 1, 0));
        container.addChild(new Spacer(1));
        for (let i = 0; i < results.length; i++) {
          const mr = results[i];
          try {
            container.addChild(new Image(mr.base64, "image/jpeg", { fallbackColor: (s) => theme.fg("muted", s) }, {
              maxWidthCells: 80,
              maxHeightCells: 40
            }));
          } catch {
            container.addChild(new Text(theme.fg("muted", `Diagram ${i + 1} saved to: ${mr.filePath}`), 1, 0));
          }
          if (i < results.length - 1) container.addChild(new Spacer(1));
        }
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "Press Escape to close"), 1, 0));
        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            if (data === "\x1B" || data === "") done();
          }
        };
      });
    }
  });
}
export {
  markdown_viewer_default as default,
  extractMermaidBlocks,
  isMd
};
//# sourceMappingURL=markdown-viewer.js.map
