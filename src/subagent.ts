/**
 * Subagent Extension — fire-and-forget with streaming progress.
 *
 * Two modes:
 *   - background (default): Spawns `pi --mode json -p --no-session`.
 *     Returns immediately. Parses JSON events in background for live
 *     widget updates. Injects result via sendMessage when done.
 *   - interactive: Full pi in a tmux window. Same as before.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, execFileSync } from "node:child_process";
import { writeFile, readFile, unlink, access } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Message } from "@mariozechner/pi-ai";

// ── Types ──────────────────────────────────────────────────────────────

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface TrackedRun {
  id: string;
  task: string;
  mode: "background" | "interactive";
  startTime: number;
  finishedAt?: number;
  exitCode?: number;
  // Background-only streaming state
  messages: Message[];
  usage: Usage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  lastToolCall?: string;
  // Interactive-only
  tmuxSession?: string;
  resultFile?: string;
  watcher?: ReturnType<typeof setInterval>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsage(u: Usage, model?: string): string {
  const p: string[] = [];
  if (u.turns) p.push(`${u.turns}t`);
  if (u.input) p.push(`↑${formatTokens(u.input)}`);
  if (u.output) p.push(`↓${formatTokens(u.output)}`);
  if (u.cost) p.push(`$${u.cost.toFixed(3)}`);
  if (model) p.push(model);
  return p.join(" ");
}

function getFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function shortenPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCallShort(name: string, args: Record<string, any>): string {
  switch (name) {
    case "bash": {
      const cmd = (args.command as string) || "...";
      return `$ ${cmd.length > 50 ? cmd.slice(0, 50) + "…" : cmd}`;
    }
    case "read":
      return `read ${shortenPath((args.file_path || args.path || "...") as string)}`;
    case "write":
      return `write ${shortenPath((args.file_path || args.path || "...") as string)}`;
    case "edit":
      return `edit ${shortenPath((args.file_path || args.path || "...") as string)}`;
    default:
      return name;
  }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = (process.execPath.split("/").pop() || "").toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function elapsedStr(start: number, end?: number): string {
  const s = ((end || Date.now()) - start) / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}m`;
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const active = new Map<string, TrackedRun>();
  let widgetCtx: any = null; // stash ctx for widget updates

  // ── Widget: live status of all running subagents ──

  function updateWidget() {
    if (!widgetCtx) return;
    const running = [...active.values()].filter((r) => r.exitCode === undefined);
    if (running.length === 0) {
      widgetCtx.ui.setWidget("subagent-status", undefined);
      return;
    }

    widgetCtx.ui.setWidget("subagent-status", (_tui: any, theme: any) => {
      const lines = running.map((r) => {
        const elapsed = elapsedStr(r.startTime);
        const icon = r.mode === "interactive" ? "🖥" : "⏳";
        const activity = r.lastToolCall
          ? theme.fg("dim", ` → ${r.lastToolCall}`)
          : theme.fg("dim", " starting…");
        const usage = r.usage.turns > 0 ? theme.fg("muted", ` [${formatUsage(r.usage)}]`) : "";
        return `${icon} ${theme.fg("accent", r.id)} ${theme.fg("dim", elapsed)}${activity}${usage}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    });
  }

  // ── Background mode: fire-and-forget with JSON streaming ──

  function spawnBackground(
    id: string,
    task: string,
    cwd: string,
  ): TrackedRun {
    const run: TrackedRun = {
      id,
      task,
      mode: "background",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
    };

    const piArgs: string[] = ["--mode", "json", "-p", "--no-session", task];
    const invocation = getPiInvocation(piArgs);

    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let stderr = "";
    let completed = false;

    const finishRun = (code: number) => {
      if (completed) return;
      completed = true;
      if (buffer.trim()) processLine(buffer);
      run.exitCode = code;
      run.finishedAt = Date.now();

      const elapsed = elapsedStr(run.startTime, run.finishedAt);
      const output = getFinalText(run.messages);
      const isError = run.exitCode !== 0 || run.stopReason === "error" || run.stopReason === "aborted";

      // Write result file for interop
      const resultPath = `/tmp/subagent-${id}-result.md`;
      try { writeFileSync(resultPath, output || "(no output)"); } catch {}

      // Build injection message
      const usageStr = formatUsage(run.usage, run.model);
      let content: string;
      if (isError) {
        const err = run.errorMessage || stderr || "(no output)";
        content = `## Subagent \`${id}\` failed (${elapsed})\n\n${err}`;
      } else {
        content = `## Subagent \`${id}\` completed (${elapsed}, ${usageStr})\n\n${output}`;
      }

      active.delete(id);
      updateWidget();

      // Kill the process if it's still hanging around
      try { proc.kill(); } catch {}

      pi.sendMessage(
        { customType: "subagent-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }

      // agent_end or a turn_end with no pending tool calls means the run
      // is complete — don't wait for process close (pi --mode json -p can
      // hang in extension shutdown for minutes).
      if (event.type === "agent_end") {
        finishRun(0);
        return;
      }
      if (event.type === "turn_end" && event.message) {
        const msg = event.message as Message;
        const hasToolCall = msg.content.some((p: any) => p.type === "toolCall");
        const errored = msg.stopReason === "error" || msg.stopReason === "aborted";
        if (!hasToolCall && !errored) {
          finishRun(0);
          return;
        }
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        run.messages.push(msg);
        if (msg.role === "assistant") {
          run.usage.turns++;
          const u = msg.usage;
          if (u) {
            run.usage.input += u.input || 0;
            run.usage.output += u.output || 0;
            run.usage.cacheRead += u.cacheRead || 0;
            run.usage.cacheWrite += u.cacheWrite || 0;
            run.usage.cost += u.cost?.total || 0;
          }
          if (!run.model && msg.model) run.model = msg.model;
          if (msg.stopReason) run.stopReason = msg.stopReason;
          if (msg.errorMessage) run.errorMessage = msg.errorMessage;

          // Track latest tool call for widget display
          for (const part of msg.content) {
            if (part.type === "toolCall") {
              run.lastToolCall = formatToolCallShort(part.name, part.arguments);
            }
          }
        }
        updateWidget();
      }

      if (event.type === "tool_result_end" && event.message) {
        run.messages.push(event.message as Message);
        updateWidget();
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      // finishRun is idempotent — may have already been called via agent_end
      finishRun(code ?? 0);
    });

    proc.on("error", () => {
      run.errorMessage = "Failed to spawn pi process";
      finishRun(1);
    });

    // Don't keep parent alive waiting for child
    proc.unref();
    return run;
  }

  // ── Interactive mode: tmux ──

  function isTargetAlive(target: string): boolean {
    try {
      execFileSync("tmux", ["display-message", "-t", target, "-p", ""], { stdio: "ignore" });
      return true;
    } catch { return false; }
  }

  function spawnInteractive(id: string, task: string, cwd: string): TrackedRun {
    const tmuxName = `subagent-${id}`;
    const resultFile = `/tmp/subagent-${id}-result.md`;
    const promptFile = `/tmp/subagent-${id}-prompt.md`;

    let parentSession = "";
    try {
      parentSession = execFileSync("tmux", ["display-message", "-p", "#{session_name}"],
        { encoding: "utf8" }).trim();
    } catch {}

    let pasteTarget: string;

    if (parentSession) {
      pasteTarget = `${parentSession}:${tmuxName}`;
      execFileSync("tmux", [
        "new-window", "-t", parentSession, "-n", tmuxName, "-c", cwd, "pi",
      ], { stdio: "ignore" });
    } else {
      pasteTarget = tmuxName;
      execFileSync("tmux", [
        "new-session", "-d", "-s", tmuxName, "-c", cwd, "pi",
      ], { stdio: "ignore" });
      try {
        execFileSync("tmux", ["resize-window", "-t", tmuxName, "-x", "200", "-y", "50"],
          { stdio: "ignore" });
      } catch {}
    }

    const framedTask = `${task}

When you have completed the task, do these two things:
1. Use the write tool to save your complete findings/summary to ${resultFile}
2. Then say "SUBAGENT COMPLETE" so I know you're done.`;

    const maxWaitMs = 30_000;
    const waitStart = Date.now();
    const readyPoller = setInterval(() => {
      try {
        const pane = execFileSync("tmux", ["capture-pane", "-t", pasteTarget, "-p"],
          { encoding: "utf8" });
        const ready = /\$\d+\.\d+/.test(pane);
        if (!ready && Date.now() - waitStart < maxWaitMs) return;

        clearInterval(readyPoller);
        writeFileSync(promptFile, framedTask);
        const bufferName = `${tmuxName}-prompt`;
        execFileSync("tmux", ["load-buffer", "-b", bufferName, promptFile], { stdio: "ignore" });
        execFileSync("tmux", ["paste-buffer", "-dp", "-b", bufferName, "-t", pasteTarget], { stdio: "ignore" });
        execFileSync("tmux", ["send-keys", "-t", pasteTarget, "Enter"], { stdio: "ignore" });
      } catch {
        if (Date.now() - waitStart >= maxWaitMs) clearInterval(readyPoller);
      }
    }, 1000);

    const run: TrackedRun = {
      id,
      task,
      mode: "interactive",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
      tmuxSession: pasteTarget,
      resultFile,
    };

    const injectResult = async () => {
      const elapsed = elapsedStr(run.startTime);
      if (run.watcher) clearInterval(run.watcher);
      active.delete(id);
      updateWidget();

      let content: string;
      try {
        const result = await readFile(resultFile, "utf8");
        content = `## Subagent \`${id}\` completed (${elapsed})\n\n${result}`;
      } catch {
        let errMsg = "";
        try { errMsg = await readFile(`/tmp/subagent-${id}-err.log`, "utf8"); } catch {}
        content = `## Subagent \`${id}\` failed (${elapsed})\n\n${errMsg || "No output."}`;
      }

      pi.sendMessage(
        { customType: "subagent-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" }
      );
      unlink(`/tmp/subagent-${id}-prompt.md`).catch(() => {});
    };

    run.watcher = setInterval(async () => {
      const alive = isTargetAlive(pasteTarget);
      let resultExists = false;
      try { await access(resultFile); resultExists = true; } catch {}

      if (resultExists) {
        if (alive) {
          setTimeout(() => injectResult(), 3000);
          if (run.watcher) clearInterval(run.watcher);
        } else {
          injectResult();
        }
      } else if (!alive) {
        injectResult();
      }
    }, 5000);

    return run;
  }

  // ── Lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    widgetCtx = ctx;
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
    }
    active.clear();
  });

  pi.on("session_shutdown", async () => {
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
    }
    widgetCtx = null;
  });

  // Stash ctx from agent turns so widget works
  pi.on("agent_turn_start", async (_event, ctx) => {
    widgetCtx = ctx;
  });

  // ── Tools ──

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a background pi subagent to work on a task. " +
      "Returns immediately — the subagent runs in the background with full tool access. " +
      "Live progress shown in a widget. Results auto-inject when complete. " +
      "Use for research, analysis, code review, data gathering — anything that can run independently.",
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
        description: "Short descriptive ID for this subagent (e.g. 'cr-review', 'coverage-check', 'error-research')",
      }),
      task: Type.String({
        description: "Detailed task description. Be specific — include file paths, URLs, criteria. The subagent has full tool access.",
      }),
      workingDir: Type.Optional(
        Type.String({ description: "Working directory for the subagent (default: current directory)" })
      ),
      interactive: Type.Optional(
        Type.Boolean({
          description: "If true, spawns a full pi session in a tmux window the user can switch to. Default: false (background pi -p).",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { id, task, interactive } = params;
      const cwd = params.workingDir || ctx.cwd;
      widgetCtx = ctx; // ensure widget works

      if (active.has(id)) {
        throw new Error(`Subagent '${id}' is already running. Use a different ID or wait for it to finish.`);
      }

      if (interactive) {
        const run = spawnInteractive(id, task, cwd);
        active.set(id, run);
        updateWidget();

        return {
          content: [{
            type: "text" as const,
            text: `Subagent '${id}' spawned in tmux window. Switch to it:\n  tmux select-window -t ${run.tmuxSession}\nResults will auto-inject when complete.`,
          }],
          details: { id, mode: "interactive", tmuxSession: run.tmuxSession, cwd },
        };
      }

      // Background mode — fire and forget
      const run = spawnBackground(id, task, cwd);
      active.set(id, run);
      updateWidget();

      return {
        content: [{
          type: "text" as const,
          text: `Subagent '${id}' spawned in background. Live progress in widget above. Results will auto-inject when complete.`,
        }],
        details: { id, mode: "background", cwd },
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
      const lines = Array.from(active.entries()).map(([id, run]) => {
        const elapsed = elapsedStr(run.startTime);
        const mode = run.mode === "interactive" ? "tmux" : "bg";
        const activity = run.lastToolCall ? ` — ${run.lastToolCall}` : "";
        const usage = run.usage.turns > 0 ? ` [${formatUsage(run.usage)}]` : "";
        const attach = run.tmuxSession ? ` — \`tmux select-window -t ${run.tmuxSession}\`` : "";
        return `- **${id}** [${mode}] ${elapsed}${activity}${usage}${attach}`;
      });

      return {
        content: [{
          type: "text" as const,
          text: `**${active.size} subagent(s) running:**\n${lines.join("\n")}`,
        }],
        details: { count: active.size, ids: Array.from(active.keys()) },
      };
    },
  });
}
