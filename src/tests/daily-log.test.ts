import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { todayStr, nowTimestamp, resolveDir } from "../daily-log.js";
import { homedir } from "node:os";
import { join } from "node:path";

describe("todayStr", () => {
  it("returns YYYY-MM-DD format", () => {
    const result = todayStr();
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches current date", () => {
    const now = new Date();
    const expected = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    assert.equal(todayStr(), expected);
  });
});

describe("nowTimestamp", () => {
  it("returns YYYY-MM-DD HH:MM format", () => {
    const result = nowTimestamp();
    assert.match(result, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("starts with today's date", () => {
    const result = nowTimestamp();
    assert.ok(result.startsWith(todayStr()));
  });
});

describe("resolveDir", () => {
  it("expands ~ to homedir", () => {
    const result = resolveDir("~/my-notes");
    assert.equal(result, join(homedir(), "my-notes"));
  });

  it("returns absolute path as-is", () => {
    const result = resolveDir("/tmp/notes");
    assert.equal(result, "/tmp/notes");
  });

  it("defaults to ~/daily-notes when undefined", () => {
    const result = resolveDir(undefined);
    assert.equal(result, join(homedir(), "daily-notes"));
  });

  it("defaults to ~/daily-notes when empty string", () => {
    const result = resolveDir("");
    assert.equal(result, join(homedir(), "daily-notes"));
  });
});
