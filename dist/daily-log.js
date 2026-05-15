// src/daily-log.ts
import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
function ok(text) {
  return { content: [{ type: "text", text }], details: {} };
}
function err(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], details: {} };
}
function resolveDir(envVal) {
  const raw = envVal || "~/daily-notes";
  return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}
function todayStr() {
  const now = /* @__PURE__ */ new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function nowTimestamp() {
  const now = /* @__PURE__ */ new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${todayStr()} ${h}:${min}`;
}
function ensureDailyNote(dir, date, section) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  if (existsSync(path)) return path;
  const createCmd = process.env.DAILY_LOG_CREATE_CMD;
  if (createCmd) {
    try {
      execSync(createCmd, { env: { ...process.env, DATE: date } });
      if (existsSync(path)) return path;
    } catch {
    }
  }
  const template = process.env.DAILY_LOG_TEMPLATE;
  if (template && existsSync(template)) {
    try {
      let content = readFileSync(template, "utf-8");
      content = content.replace(/\{\{date\}\}/g, date);
      writeFileSync(path, content, "utf-8");
      return path;
    } catch {
    }
  }
  writeFileSync(path, `# ${date}

${section}
`, "utf-8");
  return path;
}
function daily_log_default(pi) {
  pi.registerTool({
    name: "daily_log",
    label: "Daily Log",
    description: "Append a timestamped entry to today's daily note. Use for notable events, task completions, decisions, and memorable moments. Creates the daily note if it doesn't exist.",
    parameters: Type.Object({
      entry: Type.String({ description: "The journal entry text (timestamp is added automatically)" })
    }),
    async execute(_toolCallId, input) {
      try {
        const dir = resolveDir(process.env.DAILY_LOG_DIR);
        const section = process.env.DAILY_LOG_SECTION || "## Journal";
        const date = todayStr();
        const path = ensureDailyNote(dir, date, section);
        const timestamp = nowTimestamp();
        const line = `- ${timestamp} \u2014 ${input.entry}`;
        let content = readFileSync(path, "utf-8");
        const sectionIdx = content.indexOf(section);
        if (sectionIdx === -1) {
          content = content.trimEnd() + `

${section}
${line}
`;
        } else {
          const afterHeader = sectionIdx + section.length;
          const nextSection = content.indexOf("\n## ", afterHeader);
          if (nextSection === -1) {
            content = content.trimEnd() + `
${line}
`;
          } else {
            content = content.slice(0, nextSection).trimEnd() + `
${line}
` + content.slice(nextSection);
          }
        }
        writeFileSync(path, content, "utf-8");
        return ok(`Logged to ${date}: ${line}`);
      } catch (e) {
        return err(`Failed to log: ${e.message}`);
      }
    }
  });
}
export {
  daily_log_default as default,
  nowTimestamp,
  resolveDir,
  todayStr
};
//# sourceMappingURL=daily-log.js.map
