/**
 * Pure utility functions for markdown-viewer.
 * Extracted for testability (no pi-coding-agent / pi-tui dependencies).
 */

export function isMd(filePath: string): boolean {
	return /\.(md|mdx|markdown)$/i.test(filePath || "");
}

export function extractMermaidBlocks(content: string): string[] {
	const blocks: string[] = [];
	const re = /```mermaid\s*\n([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		blocks.push(m[1].trim());
	}
	return blocks;
}
