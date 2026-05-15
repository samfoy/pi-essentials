// src/subagent.ts
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, execFileSync } from "node:child_process";
import { readFile, unlink, access } from "node:fs/promises";
import { existsSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";

// src/subagent-diagnostics.ts
var STDERR_TAIL_BYTES = 2e3;
var MAX_ACTIVITY_LINE_CHARS = 256;
var DEFAULT_MAX_ACTIVITY_EVENTS = 20;
function truncateTail(s, maxChars) {
  if (s.length <= maxChars) return s;
  let truncated = s.length - maxChars;
  for (let i = 0; i < 3; i++) {
    const suffix2 = `\u2026(${truncated} chars truncated)`;
    const keep2 = Math.max(0, maxChars - suffix2.length);
    const actual = s.length - keep2;
    if (actual === truncated) break;
    truncated = actual;
  }
  const suffix = `\u2026(${truncated} chars truncated)`;
  const keep = Math.max(0, maxChars - suffix.length);
  return s.slice(0, keep) + suffix;
}
function formatToolCallFull(event, maxLineChars = MAX_ACTIVITY_LINE_CHARS) {
  const { name, arguments: args } = event;
  const detail = formatToolDetail(name, args);
  const line = `- ${name}: ${detail}`;
  return truncateTail(line, maxLineChars);
}
function formatToolDetail(name, args) {
  const str = (v) => typeof v === "string" ? v : void 0;
  switch (name) {
    case "bash": {
      const cmd = str(args.command) ?? "";
      return `$ ${cmd}`;
    }
    case "read":
    case "write":
    case "edit":
      return str(args.file_path) ?? str(args.path) ?? "(no path)";
    case "grep": {
      const pattern = str(args.pattern) ?? "(no pattern)";
      const path = str(args.path) ?? ".";
      return `${pattern} in ${path}`;
    }
    case "find":
      return str(args.pattern) ?? str(args.path) ?? "(no pattern)";
    case "ls":
      return str(args.path) ?? ".";
    default:
      try {
        return JSON.stringify(args);
      } catch {
        return "(unserializable args)";
      }
  }
}
function buildActivityTrail(events, opts = {}) {
  if (events.length === 0) return "";
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_ACTIVITY_EVENTS;
  if (maxEvents <= 0) return "";
  const maxLineChars = opts.maxLineChars ?? MAX_ACTIVITY_LINE_CHARS;
  const total = events.length;
  const shown = total > maxEvents ? events.slice(total - maxEvents) : events;
  const elided = total - shown.length;
  const headerParts = [`${total} tool call${total === 1 ? "" : "s"}`];
  if (elided > 0) {
    headerParts.push(`showing last ${shown.length}`);
    if (opts.eventsFile) {
      headerParts.push(`older ${elided} in ${opts.eventsFile}`);
    } else {
      headerParts.push(`${elided} older elided`);
    }
  } else if (opts.eventsFile) {
    headerParts.push(`full events in ${opts.eventsFile}`);
  }
  const header = `**Activity (${headerParts.join("; ")}):**`;
  const lines = shown.map((e) => formatToolCallFull(e, maxLineChars));
  return `${header}

${lines.join("\n")}`;
}
function fenceFor(content) {
  let longestRun = 0;
  let currentRun = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 96) {
      currentRun++;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}
function formatFailureBody(d) {
  const parts = [];
  if (d.errorMessage && d.errorMessage.trim()) {
    parts.push(`**Error:** ${d.errorMessage.trim()}`);
  }
  const meta = [];
  if (d.stopReason && d.stopReason.trim() !== "end_turn") meta.push(`stop=${d.stopReason.trim()}`);
  if (d.exitCode !== void 0 && d.exitCode !== 0) meta.push(`exit=${d.exitCode}`);
  if (d.signal) meta.push(`signal=${d.signal}`);
  if (meta.length > 0) parts.push(`**Status:** ${meta.join(", ")}`);
  const stderrTrimmed = (d.stderr || "").trim();
  if (stderrTrimmed) {
    const tail = stderrTrimmed.length > STDERR_TAIL_BYTES ? `\u2026(truncated; tail ${STDERR_TAIL_BYTES} bytes)
${stderrTrimmed.slice(-STDERR_TAIL_BYTES)}` : stderrTrimmed;
    const fence = fenceFor(tail);
    parts.push(`**stderr:**

${fence}
${tail}
${fence}`);
  }
  if (d.activityTrail && d.activityTrail.trim()) {
    parts.push(d.activityTrail.trim());
  }
  if (d.usageLine && d.usageLine.trim()) {
    parts.push(`**Usage before failure:** ${d.usageLine.trim()}`);
  }
  const partialOutputTrimmed = (d.partialOutput || "").trim();
  if (partialOutputTrimmed && partialOutputTrimmed !== "(no output)") {
    parts.push(`**Partial output:**

${partialOutputTrimmed}`);
  }
  return parts.length === 0 ? "(no diagnostic information captured \u2014 check the post-mortem .jsonl)" : parts.join("\n\n");
}

// src/subagent.ts
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
function formatTokens(n) {
  if (n < 1e3) return String(n);
  if (n < 1e4) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e6) return `${Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
function formatUsage(u, model) {
  const p = [];
  if (u.turns) p.push(`${u.turns}t`);
  if (u.input) p.push(`\u2191${formatTokens(u.input)}`);
  if (u.output) p.push(`\u2193${formatTokens(u.output)}`);
  if (u.cost) p.push(`$${u.cost.toFixed(3)}`);
  if (model) p.push(model);
  return p.join(" ");
}
function getFinalText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const texts = [];
      for (const part of msg.content) {
        if (part.type === "text") texts.push(part.text);
      }
      if (texts.length > 0) return texts.join("").trim();
    }
  }
  return "";
}
function shortenPath(p) {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
function formatToolCallShort(name, args) {
  switch (name) {
    case "bash": {
      const cmd = args.command || "...";
      return `$ ${cmd.length > 50 ? cmd.slice(0, 50) + "\u2026" : cmd}`;
    }
    case "read":
      return `read ${shortenPath(args.file_path || args.path || "...")}`;
    case "write":
      return `write ${shortenPath(args.file_path || args.path || "...")}`;
    case "edit":
      return `edit ${shortenPath(args.file_path || args.path || "...")}`;
    default:
      return name;
  }
}
function getPiInvocation(args) {
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
function elapsedStr(start, end) {
  const s = ((end || Date.now()) - start) / 1e3;
  return s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}m`;
}
function subagent_default(pi) {
  const active = /* @__PURE__ */ new Map();
  let widgetCtx = null;
  function updateWidget() {
    if (!widgetCtx) return;
    const running = [...active.values()].filter((r) => r.exitCode === void 0);
    if (running.length === 0) {
      widgetCtx.ui.setWidget("subagent-status", void 0);
      return;
    }
    widgetCtx.ui.setWidget("subagent-status", (_tui, theme) => {
      const lines = running.map((r) => {
        const elapsed = elapsedStr(r.startTime);
        const icon = r.mode === "interactive" ? "\u{1F5A5}" : "\u23F3";
        const activity = r.lastToolCall ? theme.fg("dim", ` \u2192 ${r.lastToolCall}`) : theme.fg("dim", " starting\u2026");
        const usage = r.usage.turns > 0 ? theme.fg("muted", ` [${formatUsage(r.usage)}]`) : "";
        return `${icon} ${theme.fg("accent", r.id)} ${theme.fg("dim", elapsed)}${activity}${usage}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    });
  }
  function killRun(run, reason) {
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    if (run.watcher) clearInterval(run.watcher);
    if (run.mode === "background" && run.proc) {
      try {
        run.proc.kill("SIGTERM");
      } catch {
      }
      setTimeout(() => {
        try {
          run.proc?.kill("SIGKILL");
        } catch {
        }
      }, 5e3);
    }
    if (run.mode === "interactive" && run.tmuxSession) {
      try {
        execFileSync("tmux", ["send-keys", "-t", run.tmuxSession, "C-c", ""], { stdio: "ignore" });
        execFileSync("tmux", ["send-keys", "-t", run.tmuxSession, "exit", "Enter"], { stdio: "ignore" });
      } catch {
      }
    }
    run.exitCode = reason === "timeout" ? 124 : 130;
    run.finishedAt = Date.now();
    const elapsed = elapsedStr(run.startTime, run.finishedAt);
    active.delete(run.id);
    updateWidget();
    const label = reason === "timeout" ? `timed out after ${Math.round((run.timeoutMs || 0) / 6e4)}min` : "killed by user";
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: `## Subagent \`${run.id}\` ${label} (${elapsed})

The subagent was ${label}.`,
        display: true
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }
  function spawnBackground(id, task, cwd) {
    const run = {
      id,
      task,
      mode: "background",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage()
    };
    const framedTask = [
      "IMPORTANT: You are running as a subagent. Do NOT spawn sub-subagents \u2014 do all the work yourself directly.",
      "",
      task
    ].join("\n");
    const piArgs = ["--mode", "json", "-p", "--no-session", framedTask];
    const invocation = getPiInvocation(piArgs);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    run.proc = proc;
    const eventsPath = `/tmp/subagent-${id}-events.jsonl`;
    let eventStream;
    try {
      eventStream = createWriteStream(eventsPath, { flags: "w" });
      eventStream.on("error", () => {
        try {
          eventStream?.destroy();
        } catch {
        }
        eventStream = void 0;
      });
    } catch {
      eventStream = void 0;
    }
    let buffer = "";
    let stderr = "";
    let completed = false;
    const finishRun = (code) => {
      if (completed) return;
      if (run.timeoutTimer) {
        clearTimeout(run.timeoutTimer);
        run.timeoutTimer = void 0;
      }
      completed = true;
      if (buffer.trim()) processLine(buffer);
      run.exitCode = code;
      run.finishedAt = Date.now();
      try {
        eventStream?.end();
      } catch {
      }
      const elapsed = elapsedStr(run.startTime, run.finishedAt);
      const output = getFinalText(run.messages);
      const isError = run.exitCode !== 0 || run.signal !== void 0 || run.stopReason === "error" || run.stopReason === "aborted";
      const resultPath = `/tmp/subagent-${id}-result.md`;
      try {
        writeFileSync(resultPath, output || "(no output)");
      } catch {
      }
      const usageStr = formatUsage(run.usage, run.model);
      let content;
      if (isError) {
        const events = [];
        for (const msg of run.messages) {
          if (msg.role !== "assistant") continue;
          for (const part of msg.content) {
            if (part.type === "toolCall") {
              events.push({
                name: part.name,
                arguments: part.arguments
              });
            }
          }
        }
        const activityTrail = buildActivityTrail(events, {
          eventsFile: eventStream ? eventsPath : void 0
        });
        const body = formatFailureBody({
          errorMessage: run.errorMessage,
          stopReason: run.stopReason,
          exitCode: run.exitCode,
          signal: run.signal,
          stderr,
          activityTrail,
          usageLine: run.usage.turns > 0 ? usageStr : void 0,
          partialOutput: output
        });
        const footer = eventStream ? `_Post-mortem: \`jq . < ${eventsPath}\`_` : "";
        content = `## Subagent \`${id}\` failed (${elapsed})

${body}${footer ? `

${footer}` : ""}`;
      } else {
        content = `## Subagent \`${id}\` completed (${elapsed}, ${usageStr})

${output}`;
      }
      active.delete(id);
      updateWidget();
      try {
        proc.kill();
      } catch {
      }
      pi.sendMessage(
        { customType: "subagent-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    };
    const processLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "agent_end") {
        finishRun(0);
        return;
      }
      if (event.type === "turn_end" && event.message) {
        const msg = event.message;
        const hasToolCall = msg.content.some((p) => p.type === "toolCall");
        const errored = msg.stopReason === "error" || msg.stopReason === "aborted";
        if (!hasToolCall && !errored) {
          finishRun(0);
          return;
        }
      }
      if (event.type === "message_end" && event.message) {
        const msg = event.message;
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
          for (const part of msg.content) {
            if (part.type === "toolCall") {
              run.lastToolCall = formatToolCallShort(part.name, part.arguments);
            }
          }
        }
        updateWidget();
      }
      if (event.type === "tool_result_end" && event.message) {
        run.messages.push(event.message);
        updateWidget();
      }
    };
    proc.stdout.on("data", (data) => {
      try {
        eventStream?.write(data);
      } catch {
      }
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code, signal) => {
      if (signal) run.signal = signal;
      finishRun(code ?? 0);
    });
    proc.on("error", () => {
      run.errorMessage = "Failed to spawn pi process";
      finishRun(1);
    });
    proc.unref();
    return run;
  }
  function isTargetAlive(target) {
    try {
      execFileSync("tmux", ["display-message", "-t", target, "-p", ""], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  function spawnInteractive(id, task, cwd) {
    const tmuxName = `subagent-${id}`;
    const resultFile = `/tmp/subagent-${id}-result.md`;
    const promptFile = `/tmp/subagent-${id}-prompt.md`;
    let parentSession = "";
    try {
      parentSession = execFileSync(
        "tmux",
        ["display-message", "-p", "#{session_name}"],
        { encoding: "utf8" }
      ).trim();
    } catch {
    }
    let pasteTarget;
    if (parentSession) {
      pasteTarget = `${parentSession}:${tmuxName}`;
      execFileSync("tmux", [
        "new-window",
        "-t",
        parentSession,
        "-n",
        tmuxName,
        "-c",
        cwd,
        "pi"
      ], { stdio: "ignore" });
    } else {
      pasteTarget = tmuxName;
      execFileSync("tmux", [
        "new-session",
        "-d",
        "-s",
        tmuxName,
        "-c",
        cwd,
        "pi"
      ], { stdio: "ignore" });
      try {
        execFileSync(
          "tmux",
          ["resize-window", "-t", tmuxName, "-x", "200", "-y", "50"],
          { stdio: "ignore" }
        );
      } catch {
      }
    }
    const framedTask = `${task}

When you have completed the task, do these two things:
1. Use the write tool to save your complete findings/summary to ${resultFile}
2. Then say "SUBAGENT COMPLETE" so I know you're done.`;
    const maxWaitMs = 3e4;
    const waitStart = Date.now();
    const readyPoller = setInterval(() => {
      try {
        const pane = execFileSync(
          "tmux",
          ["capture-pane", "-t", pasteTarget, "-p"],
          { encoding: "utf8" }
        );
        const ready = /\$\d+\.\d+/.test(pane);
        if (!ready && Date.now() - waitStart < maxWaitMs) return;
        clearInterval(readyPoller);
        writeFileSync(promptFile, framedTask);
        const bufferName = `${tmuxName}-prompt`;
        execFileSync("tmux", ["load-buffer", "-b", bufferName, promptFile], { stdio: "ignore" });
        execFileSync("tmux", ["paste-buffer", "-dp", "-b", bufferName, "-t", pasteTarget], { stdio: "ignore" });
        execFileSync("tmux", ["send-keys", "-t", pasteTarget, "Enter"], { stdio: "ignore" });
      } catch {
        if (Date.now() - waitStart >= maxWaitMs) {
          clearInterval(readyPoller);
          injectResult();
        }
      }
    }, 1e3);
    const run = {
      id,
      task,
      mode: "interactive",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
      tmuxSession: pasteTarget,
      resultFile
    };
    const injectResult = async () => {
      const elapsed = elapsedStr(run.startTime);
      if (run.timeoutTimer) {
        clearTimeout(run.timeoutTimer);
        run.timeoutTimer = void 0;
      }
      if (run.watcher) clearInterval(run.watcher);
      active.delete(id);
      updateWidget();
      let content;
      try {
        const result = await readFile(resultFile, "utf8");
        content = `## Subagent \`${id}\` completed (${elapsed})

${result}`;
      } catch {
        let errMsg = "";
        try {
          errMsg = await readFile(`/tmp/subagent-${id}-err.log`, "utf8");
        } catch {
        }
        content = `## Subagent \`${id}\` failed (${elapsed})

${errMsg || "No output."}`;
      }
      pi.sendMessage(
        { customType: "subagent-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" }
      );
      unlink(`/tmp/subagent-${id}-prompt.md`).catch(() => {
      });
    };
    run.watcher = setInterval(async () => {
      const alive = isTargetAlive(pasteTarget);
      let resultExists = false;
      try {
        await access(resultFile);
        resultExists = true;
      } catch {
      }
      if (resultExists) {
        if (alive) {
          setTimeout(() => injectResult(), 3e3);
          if (run.watcher) clearInterval(run.watcher);
        } else {
          injectResult();
        }
      } else if (!alive) {
        injectResult();
      }
    }, 5e3);
    return run;
  }
  pi.on("session_start", async (_event, ctx) => {
    widgetCtx = ctx;
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    }
    active.clear();
  });
  pi.on("session_shutdown", async () => {
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    }
    widgetCtx = null;
  });
  pi.on("agent_turn_start", async (_event, ctx) => {
    widgetCtx = ctx;
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn a background pi subagent to work on a task. Returns immediately \u2014 the subagent runs in the background with full tool access. Live progress shown in a widget. Results auto-inject when complete. Use for research, analysis, code review, data gathering \u2014 anything that can run independently.",
    promptSnippet: "Spawn background pi subagent \u2014 results auto-inject when done",
    promptGuidelines: [
      "Use subagent for independent tasks (research, analysis, review) that don't need user interaction",
      "Keep subagent tasks focused and self-contained \u2014 include all context the subagent needs",
      "Use short descriptive IDs like 'cr-review', 'coverage', 'pipeline-check'",
      "Max 3-4 concurrent subagents to avoid rate limits",
      "Subagent results arrive as messages \u2014 you'll get a turn to incorporate them",
      "Interactive mode spawns pi in a tmux window the user can switch to and steer, with results still auto-injecting when done"
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "Short descriptive ID for this subagent (e.g. 'cr-review', 'coverage-check', 'error-research')"
      }),
      task: Type.String({
        description: "Detailed task description. Be specific \u2014 include file paths, URLs, criteria. The subagent has full tool access."
      }),
      workingDir: Type.Optional(
        Type.String({ description: "Working directory for the subagent (default: current directory)" })
      ),
      interactive: Type.Optional(
        Type.Boolean({
          description: "If true, spawns a full pi session in a tmux window the user can switch to. Default: false (background pi -p)."
        })
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in minutes. Subagent is auto-killed when exceeded. Default: 10."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { id, task, interactive, timeout } = params;
      const cwd = params.workingDir || ctx.cwd;
      widgetCtx = ctx;
      if (active.has(id)) {
        throw new Error(`Subagent '${id}' is already running. Use a different ID or wait for it to finish.`);
      }
      const timeoutMs = (timeout || 10) * 6e4;
      if (interactive) {
        const run2 = spawnInteractive(id, task, cwd);
        run2.timeoutMs = timeoutMs;
        run2.timeoutTimer = setTimeout(() => killRun(run2, "timeout"), timeoutMs);
        active.set(id, run2);
        updateWidget();
        return {
          content: [{
            type: "text",
            text: `Subagent '${id}' spawned in tmux window. Switch to it:
  tmux select-window -t ${run2.tmuxSession}
Results will auto-inject when complete.`
          }],
          details: { id, mode: "interactive", tmuxSession: run2.tmuxSession, cwd }
        };
      }
      const run = spawnBackground(id, task, cwd);
      run.timeoutMs = timeoutMs;
      run.timeoutTimer = setTimeout(() => killRun(run, "timeout"), timeoutMs);
      active.set(id, run);
      updateWidget();
      return {
        content: [{
          type: "text",
          text: `Subagent '${id}' spawned in background. Live progress in widget above. Results will auto-inject when complete.`
        }],
        details: { id, mode: "background", cwd }
      };
    }
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
          content: [{ type: "text", text: "No subagents currently running." }],
          details: {}
        };
      }
      const now = Date.now();
      const lines = Array.from(active.entries()).map(([id, run]) => {
        const elapsed = elapsedStr(run.startTime);
        const mode = run.mode === "interactive" ? "tmux" : "bg";
        const activity = run.lastToolCall ? ` \u2014 ${run.lastToolCall}` : "";
        const usage = run.usage.turns > 0 ? ` [${formatUsage(run.usage)}]` : "";
        const attach = run.tmuxSession ? ` \u2014 \`tmux select-window -t ${run.tmuxSession}\`` : "";
        return `- **${id}** [${mode}] ${elapsed}${activity}${usage}${attach}`;
      });
      return {
        content: [{
          type: "text",
          text: `**${active.size} subagent(s) running:**
${lines.join("\n")}`
        }],
        details: { count: active.size, ids: Array.from(active.keys()) }
      };
    }
  });
  pi.registerTool({
    name: "subagent_kill",
    label: "Kill Subagent",
    description: "Terminate a running subagent by ID",
    promptSnippet: "Kill a running subagent",
    parameters: Type.Object({
      id: Type.String({
        description: "ID of the subagent to kill"
      })
    }),
    async execute(_toolCallId, params) {
      const { id } = params;
      const run = active.get(id);
      if (!run) {
        throw new Error(`No subagent with ID '${id}' found. It may have already completed.`);
      }
      if (run.exitCode !== void 0) {
        throw new Error(`Subagent '${id}' has already finished.`);
      }
      killRun(run, "killed");
      return {
        content: [{
          type: "text",
          text: `Subagent '${id}' has been killed.`
        }],
        details: { id, killed: true }
      };
    }
  });
}
export {
  subagent_default as default
};
//# sourceMappingURL=subagent.js.map
