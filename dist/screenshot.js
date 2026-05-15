// src/screenshot.ts
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join } from "node:path";
import { homedir } from "node:os";
var KITTEN = join(homedir(), ".local", "bin", "kitten");
var MIME_TYPES = [
  { mime: "image/png", ext: ".png" },
  { mime: "image/jpeg", ext: ".jpg" },
  { mime: "image/gif", ext: ".gif" },
  { mime: "image/webp", ext: ".webp" }
];
function mediaTypeFromExt(ext) {
  const e = ext.toLowerCase();
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".gif") return "image/gif";
  if (e === ".webp") return "image/webp";
  return "image/png";
}
function resolvePath(p) {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return p;
}
function isImagePath(arg) {
  const IMAGE_EXTS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
  if (arg.startsWith("/") || arg.startsWith("~") || arg.startsWith(".")) return true;
  if (IMAGE_EXTS.has(extname(arg).toLowerCase())) return true;
  return false;
}
function readClipboardImage() {
  for (const { mime } of MIME_TYPES) {
    try {
      const buf = execFileSync(KITTEN, ["clipboard", "--get-clipboard", "--mime", mime], {
        timeout: 5e3,
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"]
      });
      if (buf.length > 0) {
        return { data: buf.toString("base64"), mime };
      }
    } catch {
    }
  }
  return null;
}
function sendImage(pi, data, mime, prompt, isIdle) {
  const content = [
    { type: "image", source: { type: "base64", mediaType: mime, data } },
    { type: "text", text: prompt || "Here's a screenshot." }
  ];
  if (isIdle) {
    pi.sendUserMessage(content);
  } else {
    pi.sendUserMessage(content, { deliverAs: "followUp" });
  }
}
function screenshot_default(pi) {
  pi.registerCommand("ss", {
    description: "Send a screenshot to the agent. Reads from clipboard, or specify a file path.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
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
    }
  });
}
export {
  screenshot_default as default
};
//# sourceMappingURL=screenshot.js.map
