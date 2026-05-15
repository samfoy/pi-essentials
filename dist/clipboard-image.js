// src/clipboard-image.ts
var BASE64_SIGNATURES = {
  iVBOR: "image/png",
  "/9j/": "image/jpeg"
};
var MIN_BASE64_LENGTH = 100;
function detectBase64Image(text) {
  const trimmed = text.trim();
  for (const [sig, mimeType] of Object.entries(BASE64_SIGNATURES)) {
    if (trimmed.startsWith(sig) && trimmed.length > MIN_BASE64_LENGTH && /^[A-Za-z0-9+/\n\r=]+$/.test(trimmed)) {
      return { data: trimmed.replace(/[\n\r]/g, ""), mimeType, remaining: "" };
    }
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
function clipboard_image_default(pi) {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!event.text) return { action: "continue" };
    const detected = detectBase64Image(event.text);
    if (!detected) return { action: "continue" };
    const prompt = detected.remaining || "Describe this image. What do you see?";
    ctx.ui.notify("\u{1F4CB} Base64 image detected \u2014 attaching to prompt", "info");
    const images = [
      ...event.images ?? [],
      { type: "image", data: detected.data, mimeType: detected.mimeType }
    ];
    return { action: "transform", text: prompt, images };
  });
}
export {
  clipboard_image_default as default,
  detectBase64Image
};
//# sourceMappingURL=clipboard-image.js.map
