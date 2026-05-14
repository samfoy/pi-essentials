/**
 * Screenshot Extension
 *
 * Reads screenshots directly from your local clipboard over SSH
 * using kitty's clipboard protocol.
 *
 * Requirements:
 *   - kitty terminal locally with: clipboard_control read-clipboard
 *   - tmux: set -g allow-passthrough on
 *   - kitten binary on remote (~/.local/bin/kitten)
 *
 * Usage:
 *   /ss [prompt]         - Grab clipboard image and send to agent
 *   /ss <path> [prompt]  - Send an image file from disk
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type MediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const KITTEN = join(homedir(), ".local", "bin", "kitten");

const MIME_TYPES: { mime: MediaType; ext: string }[] = [
	{ mime: "image/png", ext: ".png" },
	{ mime: "image/jpeg", ext: ".jpg" },
	{ mime: "image/gif", ext: ".gif" },
	{ mime: "image/webp", ext: ".webp" },
];

function mediaTypeFromExt(ext: string): MediaType {
	const e = ext.toLowerCase();
	if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
	if (e === ".gif") return "image/gif";
	if (e === ".webp") return "image/webp";
	return "image/png";
}

function resolvePath(p: string): string {
	if (p.startsWith("~")) return join(homedir(), p.slice(1));
	return p;
}

function isImagePath(arg: string): boolean {
	const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
	if (arg.startsWith("/") || arg.startsWith("~") || arg.startsWith(".")) return true;
	if (IMAGE_EXTS.has(extname(arg).toLowerCase())) return true;
	return false;
}

function readClipboardImage(): { data: string; mime: MediaType } | null {
	for (const { mime } of MIME_TYPES) {
		try {
			const buf = execFileSync(KITTEN, ["clipboard", "--get-clipboard", "--mime", mime], {
				timeout: 5000,
				maxBuffer: 50 * 1024 * 1024,
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (buf.length > 0) {
				return { data: buf.toString("base64"), mime };
			}
		} catch {
			// This mime type not available, try next
		}
	}
	return null;
}

function sendImage(pi: ExtensionAPI, data: string, mime: MediaType, prompt: string, isIdle: boolean) {
	const content: any[] = [
		{ type: "image", source: { type: "base64", mediaType: mime, data } },
		{ type: "text", text: prompt || "Here's a screenshot." },
	];

	if (isIdle) {
		pi.sendUserMessage(content);
	} else {
		pi.sendUserMessage(content, { deliverAs: "followUp" });
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ss", {
		description: "Send a screenshot to the agent. Reads from clipboard, or specify a file path.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// If first arg looks like a file path, read from disk
			if (trimmed && isImagePath(trimmed.split(/\s/)[0])) {
				const parts = trimmed.split(/\s+/);
				const imagePath = resolvePath(parts[0]);
				const prompt = parts.slice(1).join(" ");

				try {
					const buf = readFileSync(imagePath);
					sendImage(pi, buf.toString("base64"), mediaTypeFromExt(extname(imagePath)), prompt, ctx.isIdle());
				} catch (err) {
					ctx.ui.notify(`Failed to read ${imagePath}: ${err}`, "error");
				}
				return;
			}

			// Otherwise, read from clipboard via kitten
			if (!existsSync(KITTEN)) {
				ctx.ui.notify(`kitten not found at ${KITTEN}`, "error");
				return;
			}

			const result = readClipboardImage();
			if (!result) {
				ctx.ui.notify("No image found in clipboard", "warning");
				return;
			}

			sendImage(pi, result.data, result.mime, trimmed, ctx.isIdle());
		},
	});
}
