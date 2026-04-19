/**
 * daily-log — Append timestamped entries to a daily markdown note.
 *
 * Maintains daily notes in YYYY-MM-DD.md format with a configurable
 * journal section header. Creates the note if it doesn't exist.
 *
 * Configuration via environment variables:
 *   DAILY_LOG_DIR       — Directory for daily notes (default: ~/daily-notes)
 *   DAILY_LOG_SECTION   — Section header to append under (default: ## Journal)
 *   DAILY_LOG_TEMPLATE  — Path to a template file for new notes (optional)
 *   DAILY_LOG_CREATE_CMD — Shell command to create new notes (optional, receives DATE env var)
 */
import type { ExtensionAPI, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

type ToolResult = AgentToolResult<unknown>;
function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}
function err(text: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], details: {} };
}

function resolveDir(envVal: string | undefined): string {
  const raw = envVal || "~/daily-notes";
  return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function nowTimestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${todayStr()} ${h}:${min}`;
}

function ensureDailyNote(dir: string, date: string, section: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);

  if (existsSync(path)) return path;

  // Try custom create command
  const createCmd = process.env.DAILY_LOG_CREATE_CMD;
  if (createCmd) {
    try {
      execSync(createCmd, { env: { ...process.env, DATE: date } });
      if (existsSync(path)) return path;
    } catch { /* fall through */ }
  }

  // Try template file
  const template = process.env.DAILY_LOG_TEMPLATE;
  if (template && existsSync(template)) {
    try {
      let content = readFileSync(template, "utf-8");
      content = content.replace(/\{\{date\}\}/g, date);
      writeFileSync(path, content, "utf-8");
      return path;
    } catch { /* fall through */ }
  }

  // Default minimal note
  writeFileSync(path, `# ${date}\n\n${section}\n`, "utf-8");
  return path;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "daily_log",
    label: "Daily Log",
    description:
      "Append a timestamped entry to today's daily note. " +
      "Use for notable events, task completions, decisions, and memorable moments. " +
      "Creates the daily note if it doesn't exist.",
    parameters: Type.Object({
      entry: Type.String({ description: "The journal entry text (timestamp is added automatically)" }),
    }),
    async execute(_toolCallId: string, input: { entry: string }) {
      try {
        const dir = resolveDir(process.env.DAILY_LOG_DIR);
        const section = process.env.DAILY_LOG_SECTION || "## Journal";
        const date = todayStr();
        const path = ensureDailyNote(dir, date, section);
        const timestamp = nowTimestamp();
        const line = `- ${timestamp} — ${input.entry}`;

        let content = readFileSync(path, "utf-8");

        // Find the target section and append after it
        const sectionIdx = content.indexOf(section);

        if (sectionIdx === -1) {
          // Section not found — append it at the end
          content = content.trimEnd() + `\n\n${section}\n${line}\n`;
        } else {
          // Find the end of this section (next ## header or EOF)
          const afterHeader = sectionIdx + section.length;
          const nextSection = content.indexOf("\n## ", afterHeader);

          if (nextSection === -1) {
            // Target section is the last section — append at end
            content = content.trimEnd() + `\n${line}\n`;
          } else {
            // Insert before the next section
            content =
              content.slice(0, nextSection).trimEnd() +
              `\n${line}\n` +
              content.slice(nextSection);
          }
        }

        writeFileSync(path, content, "utf-8");

        return ok(`Logged to ${date}: ${line}`);
      } catch (e: any) {
        return err(`Failed to log: ${e.message}`);
      }
    },
  });
}
