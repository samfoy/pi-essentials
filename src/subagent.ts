/**
 * Subagent Extension
 *
 * Provides `subagent` and `subagent_status` tools for spawning background pi
 * instances whose results auto-inject back into the parent session.
 *
 * Two modes:
 *   - background (default): `pi -p` in a detached process. Fast, no TUI.
 *   - interactive: Full pi in a tmux window. User can switch to it to watch or steer.
 *     The subagent writes its result file; a watcher detects completion and injects.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, execFileSync } from "node:child_process";
import { writeFile, readFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Ensure the subagent runner script exists in ~/.pi/agent/bin/.
 * Creates it on first use so the extension is self-contained.
 */
function ensureRunner(): string {
  const binDir = join(homedir(), ".pi", "agent", "bin");
  const runner = join(binDir, "subagent-run.sh");
  if (existsSync(runner)) return runner;

  mkdirSync(binDir, { recursive: true });
  writeFileSync(runner, RUNNER_SCRIPT, { mode: 0o755 });
  return runner;
}

const RUNNER_SCRIPT = `#!/usr/bin/env bash
# subagent-run.sh — Run a pi subagent non-interactively, capture results.
set -euo pipefail

ID="\${1:?Usage: subagent-run.sh <id> [working-dir]}"
WORKDIR="\${2:-$(pwd)}"

PROMPT_FILE="/tmp/subagent-\${ID}-prompt.md"
RESULT_FILE="/tmp/subagent-\${ID}-result.md"
ERR_LOG="/tmp/subagent-\${ID}-err.log"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "ERROR: Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

cd "$WORKDIR"

TASK=$(cat "$PROMPT_FILE")

FULL_PROMPT="You are a subagent spawned by a parent agent to complete a specific task.
Complete the task below thoroughly, then provide a clear SUMMARY section at the end.

## Task
\${TASK}

## Instructions
- Use all available tools (read, bash, edit, etc.) as needed
- Be thorough but focused on the task
- End your response with a section starting with '## Summary' containing:
  - What you found / what you did
  - Key results, data, or conclusions
  - Any issues or follow-ups for the parent agent"

echo "$FULL_PROMPT" | pi -p --no-session > "$RESULT_FILE" 2>"$ERR_LOG"

EXIT_CODE=$?

echo "" >> "$RESULT_FILE"
echo "---" >> "$RESULT_FILE"
echo "_Subagent \${ID} completed at $(date -u +%Y-%m-%dT%H:%M:%SZ) (exit: \${EXIT_CODE})_" >> "$RESULT_FILE"

exit $EXIT_CODE
`;

interface SubagentEntry {
  mode: "background" | "interactive";
  startTime: number;
  task: string;
  resultFile: string;
  pid?: number;
  tmuxSession?: string;
  watcher?: ReturnType<typeof setInterval>;
}

export default function (pi: ExtensionAPI) {
  const active = new Map<string, SubagentEntry>();

  pi.on("session_start", async () => {
    // Clear stale entries on reload (processes may still run, but we lose tracking)
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
    }
    active.clear();
  });

  // Clean up watchers on shutdown
  pi.on("session_shutdown", async () => {
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
    }
  });

  /**
   * Inject the result of a completed subagent back into the parent session.
   */
  async function injectResult(id: string, entry: SubagentEntry, exitCode?: number) {
    const elapsed = Math.round((Date.now() - entry.startTime) / 1000);
    if (entry.watcher) clearInterval(entry.watcher);
    active.delete(id);

    let content: string;
    try {
      const result = await readFile(entry.resultFile, "utf8");
      content = `## Subagent \`${id}\` completed (${elapsed}s)\n\n${result}`;
    } catch {
      let errMsg = "";
      try {
        errMsg = await readFile(`/tmp/subagent-${id}-err.log`, "utf8");
      } catch {}
      const exitInfo = exitCode !== undefined ? `, exit: ${exitCode}` : "";
      content = `## Subagent \`${id}\` failed (${elapsed}s${exitInfo})\n\n${errMsg || "No output. Check /tmp/subagent-" + id + "-err.log"}`;
    }

    pi.sendMessage(
      { customType: "subagent-result", content, display: true },
      { triggerTurn: true, deliverAs: "followUp" }
    );

    // Clean up prompt file
    unlink(`/tmp/subagent-${id}-prompt.md`).catch(() => {});
  }

  /**
   * Spawn in background mode: pi -p, detached process.
   */
  function spawnBackground(id: string, task: string, cwd: string): SubagentEntry {
    const resultFile = `/tmp/subagent-${id}-result.md`;
    const runner = ensureRunner();
    const proc = spawn(runner, [id, cwd], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });

    const entry: SubagentEntry = {
      mode: "background",
      startTime: Date.now(),
      task,
      resultFile,
      pid: proc.pid,
    };

    proc.on("close", (code) => injectResult(id, entry, code ?? undefined));
    proc.unref();
    return entry;
  }

  /**
   * Spawn in interactive mode: full pi in a tmux session.
   * User can switch to the tmux window to watch or steer.
   */
  function spawnInteractive(id: string, task: string, cwd: string): SubagentEntry {
    const tmuxName = `subagent-${id}`;
    const resultFile = `/tmp/subagent-${id}-result.md`;
    const promptFile = `/tmp/subagent-${id}-prompt.md`;

    // Detect the parent tmux session. Creating a new window inside it
    // avoids iTerm2's tmux -CC capturing a new session (which redirects
    // the pi pane and breaks prompt delivery).
    let parentSession = "";
    try {
      parentSession = execFileSync("tmux", ["display-message", "-p", "#{session_name}"],
        { encoding: "utf8" }).trim();
    } catch { /* not in tmux */ }

    let pasteTarget: string;

    if (parentSession) {
      // New window in the current session — shows as a tab in iTerm2
      pasteTarget = `${parentSession}:${tmuxName}`;
      execFileSync("tmux", [
        "new-window", "-t", parentSession, "-n", tmuxName, "-c", cwd, "pi",
      ], { stdio: "ignore" });
    } else {
      // No parent session — fall back to detached session
      pasteTarget = tmuxName;
      execFileSync("tmux", [
        "new-session", "-d", "-s", tmuxName, "-c", cwd, "pi",
      ], { stdio: "ignore" });
      // Detached sessions default to 80x24; resize so pi's TUI doesn't crash
      try {
        execFileSync("tmux", ["resize-window", "-t", tmuxName, "-x", "200", "-y", "50"],
          { stdio: "ignore" });
      } catch { /* session may have died */ }
    }

    // Build the prompt — instruct pi to write results and exit when done
    const framedTask = `${task}

When you have completed the task, do these two things:
1. Use the write tool to save your complete findings/summary to ${resultFile}
2. Then say "SUBAGENT COMPLETE" so I know you're done.`;

    // Wait for pi to finish loading, then paste the prompt as one block.
    // tmux send-keys treats \n as Enter keypresses, splitting multi-line
    // prompts into separate inputs. Use load-buffer + paste-buffer instead.
    // Poll the pane until pi's status bar appears (indicates ready for input).
    const maxWaitMs = 30_000;
    const pollMs = 1_000;
    const waitStart = Date.now();

    const readyPoller = setInterval(() => {
      try {
        const pane = execFileSync("tmux", ["capture-pane", "-t", pasteTarget, "-p"],
          { encoding: "utf8" });
        const ready = /\$\d+\.\d+/.test(pane); // pi's cost indicator in status bar
        if (!ready && Date.now() - waitStart < maxWaitMs) return;

        clearInterval(readyPoller);
        writeFileSync(promptFile, framedTask);
        const bufferName = `${tmuxName}-prompt`;
        execFileSync("tmux", ["load-buffer", "-b", bufferName, promptFile], { stdio: "ignore" });
        execFileSync("tmux", ["paste-buffer", "-dp", "-b", bufferName, "-t", pasteTarget], { stdio: "ignore" });
        execFileSync("tmux", ["send-keys", "-t", pasteTarget, "Enter"], { stdio: "ignore" });
      } catch {
        // pane may have died
        if (Date.now() - waitStart >= maxWaitMs) clearInterval(readyPoller);
      }
    }, pollMs);

    const entry: SubagentEntry = {
      mode: "interactive",
      startTime: Date.now(),
      task,
      resultFile,
      tmuxSession: pasteTarget,
    };

    // Poll for completion: result file exists OR tmux target is gone
    entry.watcher = setInterval(async () => {
      const alive = isTargetAlive(pasteTarget);
      let resultExists = false;
      try {
        await access(resultFile);
        resultExists = true;
      } catch {}

      if (resultExists) {
        if (alive) {
          // Result written but pi may still be wrapping up — short grace period
          setTimeout(() => injectResult(id, entry), 3000);
          if (entry.watcher) clearInterval(entry.watcher);
        } else {
          injectResult(id, entry);
        }
      } else if (!alive) {
        // Target died without writing result
        injectResult(id, entry);
      }
    }, 5000);

    return entry;
  }

  function isTargetAlive(target: string): boolean {
    try {
      execFileSync("tmux", ["display-message", "-t", target, "-p", ""], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  // ─── Tools ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a background pi subagent to work on a task. The subagent runs non-interactively with full tool access (read, bash, edit, write). Results are auto-injected back into this conversation when the subagent finishes. Use for research, analysis, code review, data gathering — anything that can run independently.",
    promptSnippet: "Spawn background pi subagent — results auto-inject when done",
    promptGuidelines: [
      "Use subagent for independent tasks (research, analysis, review) that don't need user interaction",
      "Keep subagent tasks focused and self-contained — include all context the subagent needs",
      "Use short descriptive IDs like 'cr-review', 'coverage', 'pipeline-check'",
      "Max 3-4 concurrent subagents to avoid rate limits",
      "Subagent results arrive as messages — you'll get a turn to incorporate them",
      "Interactive mode spawns pi in a tmux window the user can switch to and steer, with results still auto-injecting when done",
    ],
    parameters: Type.Object({
      id: Type.String({
        description:
          "Short descriptive ID for this subagent (e.g. 'cr-review', 'coverage-check', 'error-research')",
      }),
      task: Type.String({
        description:
          "Detailed task description. Be specific — include file paths, URLs, criteria. The subagent has full tool access.",
      }),
      workingDir: Type.Optional(
        Type.String({
          description: "Working directory for the subagent (default: current directory)",
        })
      ),
      interactive: Type.Optional(
        Type.Boolean({
          description:
            "If true, spawns a full pi session in a tmux window the user can switch to. Default: false (background pi -p).",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { id, task, interactive } = params;
      const cwd = params.workingDir || ctx.cwd;

      if (active.has(id)) {
        throw new Error(
          `Subagent '${id}' is already running. Use a different ID or wait for it to finish.`
        );
      }

      // Write prompt file (used by background mode runner)
      await writeFile(`/tmp/subagent-${id}-prompt.md`, task, "utf8");

      const entry = interactive
        ? spawnInteractive(id, task, cwd)
        : spawnBackground(id, task, cwd);

      active.set(id, entry);

      const modeInfo = interactive
        ? `Interactive pi in tmux window 'subagent-${id}'. Switch to it:\n  tmux select-window -t ${entry.tmuxSession}`
        : `Background process (PID: ${entry.pid})`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Subagent '${id}' spawned. ${modeInfo}\nWorking in ${cwd}. Results will auto-inject when complete.`,
          },
        ],
        details: {
          id,
          mode: interactive ? "interactive" : "background",
          pid: entry.pid,
          tmuxSession: entry.tmuxSession,
          cwd,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: "Check the status of running subagents",
    promptSnippet: "Check running subagent status",
    parameters: Type.Object({}),

    async execute() {
      if (active.size === 0) {
        return {
          content: [{ type: "text" as const, text: "No subagents currently running." }],
          details: {},
        };
      }

      const now = Date.now();
      const lines = Array.from(active.entries()).map(([id, entry]) => {
        const elapsed = Math.round((now - entry.startTime) / 1000);
        const mode = entry.mode === "interactive" ? "tmux" : "bg";
        const attach =
          entry.mode === "interactive"
            ? ` — \`tmux select-window -t ${entry.tmuxSession}\``
            : "";
        return `- **${id}** [${mode}] — running for ${elapsed}s${attach}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `**${active.size} subagent(s) running:**\n${lines.join("\n")}`,
          },
        ],
        details: { count: active.size, ids: Array.from(active.keys()) },
      };
    },
  });
}
