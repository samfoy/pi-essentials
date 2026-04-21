import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractMermaidBlocks, isMd } from "../markdown-utils.js";

describe("isMd", () => {
  it("returns true for .md files", () => {
    assert.equal(isMd("README.md"), true);
    assert.equal(isMd("/path/to/file.md"), true);
  });

  it("returns true for .mdx files", () => {
    assert.equal(isMd("page.mdx"), true);
  });

  it("returns true for .markdown files", () => {
    assert.equal(isMd("notes.markdown"), true);
  });

  it("is case-insensitive", () => {
    assert.equal(isMd("FILE.MD"), true);
    assert.equal(isMd("file.Mdx"), true);
  });

  it("returns false for non-markdown files", () => {
    assert.equal(isMd("file.ts"), false);
    assert.equal(isMd("file.txt"), false);
    assert.equal(isMd("file.json"), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isMd(""), false);
  });
});

describe("extractMermaidBlocks", () => {
  it("returns empty array when no mermaid blocks", () => {
    const content = "# Hello\n\nSome text\n\n```js\nconsole.log('hi')\n```\n";
    assert.deepEqual(extractMermaidBlocks(content), []);
  });

  it("extracts a single mermaid block", () => {
    const content = `# Diagram

\`\`\`mermaid
graph TD
    A --> B
\`\`\`
`;
    const blocks = extractMermaidBlocks(content);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0], "graph TD\n    A --> B");
  });

  it("extracts multiple mermaid blocks", () => {
    const content = `# Docs

\`\`\`mermaid
graph LR
    A --> B
\`\`\`

Some text between.

\`\`\`mermaid
sequenceDiagram
    Alice->>Bob: Hello
\`\`\`
`;
    const blocks = extractMermaidBlocks(content);
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].includes("graph LR"));
    assert.ok(blocks[1].includes("sequenceDiagram"));
  });

  it("ignores non-mermaid code blocks", () => {
    const content = `\`\`\`typescript
const x = 1;
\`\`\`

\`\`\`mermaid
pie title Pets
    "Dogs" : 386
    "Cats" : 85
\`\`\`

\`\`\`python
print("hello")
\`\`\`
`;
    const blocks = extractMermaidBlocks(content);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].includes("pie title"));
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(extractMermaidBlocks(""), []);
  });

  it("trims whitespace from extracted blocks", () => {
    const content = `\`\`\`mermaid
  graph TD
    A --> B
  
\`\`\``;
    const blocks = extractMermaidBlocks(content);
    assert.equal(blocks.length, 1);
    assert.ok(!blocks[0].startsWith("\n"));
    assert.ok(!blocks[0].endsWith("\n"));
  });
});
