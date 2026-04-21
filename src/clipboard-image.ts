/**
 * Clipboard Image Extension
 *
 * Detects raw base64 image data pasted into the prompt (e.g. from a macOS
 * clipboard-to-base64 shortcut) and converts it into a proper image
 * attachment so the LLM can see it.
 *
 * Supports PNG (iVBOR...) and JPEG (/9j/...) base64 signatures.
 *
 * If the paste is *only* base64 image data, a default prompt is injected.
 * If there's text alongside the base64, the text is kept and the image attached.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BASE64_SIGNATURES: Record<string, string> = {
	iVBOR: "image/png",
	"/9j/": "image/jpeg",
};

const MIN_BASE64_LENGTH = 100;

export function detectBase64Image(text: string): { data: string; mimeType: string; remaining: string } | null {
	const trimmed = text.trim();

	for (const [sig, mimeType] of Object.entries(BASE64_SIGNATURES)) {
		// Case 1: entire input is base64 image
		if (trimmed.startsWith(sig) && trimmed.length > MIN_BASE64_LENGTH && /^[A-Za-z0-9+/\n\r=]+$/.test(trimmed)) {
			return { data: trimmed.replace(/[\n\r]/g, ""), mimeType, remaining: "" };
		}

		// Case 2: base64 blob embedded in text
		const regex = new RegExp(`(${sig.replace("/", "\\/")}[A-Za-z0-9+/\\n\\r=]{${MIN_BASE64_LENGTH},})`);
		const match = trimmed.match(regex);
		if (match && match[1]) {
			const data = match[1].replace(/[\n\r]/g, "");
			const remaining = trimmed.replace(match[1], "").trim();
			return { data, mimeType, remaining };
		}
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		if (!event.text) return { action: "continue" as const };

		const detected = detectBase64Image(event.text);
		if (!detected) return { action: "continue" as const };

		const prompt = detected.remaining || "Describe this image. What do you see?";

		ctx.ui.notify("📋 Base64 image detected — attaching to prompt", "info");

		const images = [
			...(event.images ?? []),
			{ type: "image" as const, data: detected.data, mimeType: detected.mimeType },
		];

		return { action: "transform" as const, text: prompt, images };
	});
}
