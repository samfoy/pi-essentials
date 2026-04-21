import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectBase64Image } from "../clipboard-image.js";

describe("detectBase64Image", () => {
  it("detects PNG base64 (iVBOR prefix)", () => {
    const pngData = "iVBOR" + "A".repeat(200);
    const result = detectBase64Image(pngData);
    assert.ok(result);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.remaining, "");
    assert.equal(result.data, pngData);
  });

  it("detects JPEG base64 (/9j/ prefix)", () => {
    const jpegData = "/9j/" + "A".repeat(200);
    const result = detectBase64Image(jpegData);
    assert.ok(result);
    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.remaining, "");
  });

  it("returns null for non-image text", () => {
    const result = detectBase64Image("Hello, this is just regular text.");
    assert.equal(result, null);
  });

  it("returns null for empty string", () => {
    const result = detectBase64Image("");
    assert.equal(result, null);
  });

  it("returns null for short base64 that looks like PNG", () => {
    // Below MIN_BASE64_LENGTH threshold
    const result = detectBase64Image("iVBORABC");
    assert.equal(result, null);
  });

  it("extracts base64 embedded in text and keeps remaining", () => {
    const pngData = "iVBOR" + "A".repeat(200);
    const input = `Please analyze this image: ${pngData} thanks!`;
    const result = detectBase64Image(input);
    assert.ok(result);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.data, pngData);
    assert.ok(result.remaining.includes("Please analyze"));
    assert.ok(result.remaining.includes("thanks!"));
  });

  it("strips newlines from base64 data", () => {
    const pngData = "iVBOR" + "A".repeat(100) + "\n" + "B".repeat(100);
    const result = detectBase64Image(pngData);
    assert.ok(result);
    assert.ok(!result.data.includes("\n"));
  });
});
