/**
 * Diagnostic helpers for the subagent extension.
 *
 * Extracted into its own module so unit tests can import the pure
 * functions without dragging in the peer deps the main `subagent.ts`
 * needs (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`,
 * `@sinclair/typebox`). Keep this file free of peer-dep imports.
 */
import { homedir } from "node:os";

/**
 * Shape of the diagnostic fields used to render a failure body.
 * Kept as a narrow input type so the formatter can be unit-tested
 * without constructing a full TrackedRun (which carries ChildProcess etc.).
 */
export interface FailureDiagnostics {
  errorMessage?: string;
  stopReason?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stderr?: string;
  /** Pre-rendered markdown block for the subagent's recent tool-call trail.
   *  Build with {@link buildActivityTrail} from the run's ToolCallEvent[]. */
  activityTrail?: string;
  /** Pre-formatted usage string (e.g. "5t ↑100k ↓1k $0.05"). Passed as a
   *  string rather than a structured Usage object to keep this module free
   *  of the peer-dep imports that carry the Usage type. */
  usageLine?: string;
  /** Partial assistant text produced before the failure. Named 'partialOutput'
   *  to match the **Partial output:** section label shown to the reader. */
  partialOutput?: string;
}

/**
 * Minimal shape of a tool-call event the activity-trail formatter consumes.
 * The subagent extension extracts these from assistant messages; we don't
 * import `Message` from `@mariozechner/pi-ai` here to keep this module
 * peer-dep-free.
 */
export interface ToolCallEvent {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Max stderr bytes rendered into the failure body. Prevents a huge
 * stderr dump from drowning the parent agent's context. Tail-end is
 * kept because error traces usually appear at the bottom.
 */
export const STDERR_TAIL_BYTES = 2000;

/**
 * Max per-event width rendered into the activity trail. Chosen as an
 * "unreasonable" ceiling — real paths max out around 150 chars, real
 * bash commands around 200. At 256 the head (command name + first
 * args, or the first directory segments of a path) is always intact;
 * the tail gets trimmed with an explicit "…(N chars truncated)" signal
 * so the reader knows more exists in the events.jsonl.
 */
export const MAX_ACTIVITY_LINE_CHARS = 256;

/**
 * Max number of tool-call events shown in the activity trail. Older
 * events are elided from the body; they live in the events.jsonl if a
 * reader needs deeper forensics. Chosen to keep the trail bounded at
 * ~20 * 256 = ~5KB in the worst case — small enough for the parent
 * agent's context, large enough to cover the span of a failing subagent's
 * final activity burst.
 */
export const DEFAULT_MAX_ACTIVITY_EVENTS = 20;

/**
 * Tail-truncate `s` to at most `maxChars`. If shorter, returned as-is.
 * If longer, keeps the first `maxChars - suffix.length` characters and
 * appends a suffix declaring the truncated-byte count so the reader
 * can correlate with the full value in events.jsonl.
 *
 * The truncated count is the **actual** number of chars dropped
 * (`s.length - keep`), not the naive `s.length - maxChars` — they differ
 * by the suffix length, and the suffix counts against the budget.
 * Converges in one iteration for realistic inputs; a second pass covers
 * the rare case where the true count's digit width differs from the
 * first-pass approximation (e.g., first pass assumed "99 chars" but the
 * true count is 100, shifting the suffix by 1 char).
 *
 * Output-length invariant: `out.length <= maxChars` holds **for
 * `maxChars >= suffix.length` (~21 chars)**, which covers every caller
 * in this module. Below that threshold the suffix itself exceeds the
 * cap and the output degrades to the suffix alone (still longer than
 * maxChars). No caller is allowed to go that small in practice.
 */
export function truncateTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let truncated = s.length - maxChars; // first-pass approximation
  for (let i = 0; i < 3; i++) {
    const suffix = `…(${truncated} chars truncated)`;
    const keep = Math.max(0, maxChars - suffix.length);
    const actual = s.length - keep;
    if (actual === truncated) break;
    truncated = actual;
  }
  const suffix = `…(${truncated} chars truncated)`;
  const keep = Math.max(0, maxChars - suffix.length);
  return s.slice(0, keep) + suffix;
}

/**
 * Options controlling how a tool-call event is rendered for human display.
 *
 * - `maxLineChars` — hard cap on the returned string (characters).
 * - `pathStyle` — `'full'` keeps paths as-is; `'collapsed'` replaces the
 *   home directory prefix with `~` to fit tighter budgets.
 * - `format` — `'trail'` (default) produces `- name: detail` suitable for
 *   activity trails; `'widget'` produces a compact label (`$ cmd`, `read ~…`)
 *   for live status widgets.
 */
export interface ToolCallRenderOptions {
  maxLineChars: number;
  pathStyle: "full" | "collapsed";
  format?: "trail" | "widget";
}

/** Replace the home directory prefix with `~` for compact display. */
export function collapsePath(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Single source of truth for rendering a {@link ToolCallEvent} as a
 * human-readable string.  Parameterised on {@link ToolCallRenderOptions}
 * so the widget and the activity trail share the same argument-parsing
 * logic; only the truncation budget, path style, and output format differ.
 *
 * **trail** format (default): `- name: detail` — suitable for markdown
 * activity trails rendered in failure bodies.
 *
 * **widget** format: compact label (`$ cmd`, `read ~/path`) — byte-identical
 * to the former `formatToolCallShort` when called with
 * `{ maxLineChars: 80, pathStyle: 'collapsed', format: 'widget' }`.
 */
export function formatToolCall(
  event: ToolCallEvent,
  opts: ToolCallRenderOptions,
): string {
  const { name, arguments: args } = event;
  const { maxLineChars, pathStyle, format = "trail" } = opts;
  const home = homedir();

  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;

  const resolvePath = (v: string): string =>
    pathStyle === "collapsed" ? collapsePath(v, home) : v;

  if (format === "widget") {
    // Compact label format — preserves previous formatToolCallShort output.
    let label: string;
    switch (name) {
      case "bash": {
        const cmd = str(args.command) ?? "...";
        const trimmed = cmd.length > 50 ? cmd.slice(0, 50) + "\u2026" : cmd;
        label = `$ ${trimmed}`;
        break;
      }
      case "read":
        label = `read ${resolvePath((str(args.file_path) ?? str(args.path) ?? "...") as string)}`;
        break;
      case "write":
        label = `write ${resolvePath((str(args.file_path) ?? str(args.path) ?? "...") as string)}`;
        break;
      case "edit":
        label = `edit ${resolvePath((str(args.file_path) ?? str(args.path) ?? "...") as string)}`;
        break;
      default:
        label = name;
    }
    return truncateTail(label, maxLineChars);
  }

  // trail format: `- name: detail`
  let detail: string;
  switch (name) {
    case "bash": {
      const cmd = str(args.command) ?? "";
      detail = `$ ${cmd}`;
      break;
    }
    case "read":
    case "write":
    case "edit":
      detail = resolvePath(str(args.file_path) ?? str(args.path) ?? "(no path)");
      break;
    case "grep": {
      const pattern = str(args.pattern) ?? "(no pattern)";
      const path = resolvePath(str(args.path) ?? ".");
      detail = `${pattern} in ${path}`;
      break;
    }
    case "find":
      detail = resolvePath(str(args.pattern) ?? str(args.path) ?? "(no pattern)");
      break;
    case "ls":
      detail = resolvePath(str(args.path) ?? ".");
      break;
    default:
      try {
        detail = JSON.stringify(args);
      } catch {
        detail = "(unserializable args)";
      }
  }
  return truncateTail(`- ${name}: ${detail}`, maxLineChars);
}

/**
 * Format one tool-call event as a single-line `- tool: detail` entry,
 * truncated to `maxLineChars`. Never collapses paths or elides known
 * arg structure within the budget — full fidelity is the point of the
 * trail.
 *
 * @deprecated Use {@link formatToolCall} with `{ pathStyle: 'full', format: 'trail' }` instead.
 */
export function formatToolCallFull(
  event: ToolCallEvent,
  maxLineChars: number = MAX_ACTIVITY_LINE_CHARS,
): string {
  return formatToolCall(event, {
    maxLineChars,
    pathStyle: "full",
    format: "trail",
  });
}

/**
 * Render the subagent's tool-call history as a markdown-formatted activity
 * trail. Shows the last `maxEvents` events in chronological order (oldest
 * first within the shown window), each line capped at `maxLineChars`.
 *
 * If more events occurred than are shown, the header discloses the elided
 * count and — when `eventsFile` is provided — points the reader at the
 * events.jsonl for the full sequence.
 *
 * Returns an empty string when `events` is empty so callers can guard
 * with `if (trail) { ... }` to omit the section entirely.
 */
export function buildActivityTrail(
  events: readonly ToolCallEvent[],
  opts: {
    maxEvents?: number;
    maxLineChars?: number;
    eventsFile?: string;
  } = {},
): string {
  if (events.length === 0) return "";
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_ACTIVITY_EVENTS;
  // maxEvents ≤ 0 would otherwise render a header over an empty bullet
  // list — the dangling-header artifact the correctness review flagged.
  // Treat as "nothing to show" and defer to the caller to omit the section.
  if (maxEvents <= 0) return "";
  const maxLineChars = opts.maxLineChars ?? MAX_ACTIVITY_LINE_CHARS;

  const total = events.length;
  const shown = total > maxEvents ? events.slice(total - maxEvents) : events;
  const elided = total - shown.length;

  const headerParts: string[] = [`${total} tool call${total === 1 ? "" : "s"}`];
  if (elided > 0) {
    headerParts.push(`showing last ${shown.length}`);
    if (opts.eventsFile) {
      headerParts.push(`older ${elided} in ${opts.eventsFile}`);
    } else {
      headerParts.push(`${elided} older elided`);
    }
  } else if (opts.eventsFile) {
    // Even when nothing was elided, point at the jsonl so the reader
    // knows where the un-truncated content of any 256-capped line lives.
    headerParts.push(`full events in ${opts.eventsFile}`);
  }
  const header = `**Activity (${headerParts.join("; ")}):**`;

  const lines = shown.map((e) => formatToolCallFull(e, maxLineChars));
  return `${header}\n\n${lines.join("\n")}`;
}

/**
 * Choose a backtick-fence long enough that it cannot collide with any
 * run of backticks inside the content. CommonMark requires the opening
 * and closing fences to share length and for any backticks inside the
 * body to be shorter. A naked \`\`\` fence around stderr that itself
 * contains \`\`\` (rare but real — e.g. a stderr trace that quoted a
 * markdown snippet) splits the block in half and breaks the rendering
 * for every consumer downstream.
 *
 * Exported for test coverage of the fence-length logic.
 */
export function fenceFor(content: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 96 /* backtick */) {
      currentRun++;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  // Minimum fence is three backticks; otherwise one longer than the
  // longest inner run.
  return "`".repeat(Math.max(3, longestRun + 1));
}

/**
 * Render the body of a `## Subagent ... failed` message with all
 * diagnostic context available. Pure function — testable in isolation
 * (see `src/tests/subagent-diagnostics.test.ts`).
 *
 * Empty input fields are omitted. If NOTHING is known, returns a
 * clear "no diagnostic information captured" fallback — more useful
 * than silent emptiness because it tells the parent agent that the
 * harness itself lost the failure detail.
 */
export function formatFailureBody(d: FailureDiagnostics): string {
  const parts: string[] = [];

  if (d.errorMessage && d.errorMessage.trim()) {
    parts.push(`**Error:** ${d.errorMessage.trim()}`);
  }

  const meta: string[] = [];
  // Suppress "end_turn" — it signals normal completion, not a failure mode.
  if (d.stopReason && d.stopReason.trim() !== "end_turn") meta.push(`stop=${d.stopReason.trim()}`);
  if (d.exitCode !== undefined && d.exitCode !== 0) meta.push(`exit=${d.exitCode}`);
  if (d.signal) meta.push(`signal=${d.signal}`);
  if (meta.length > 0) parts.push(`**Status:** ${meta.join(", ")}`);

  const stderrTrimmed = (d.stderr || "").trim();
  if (stderrTrimmed) {
    const tail =
      stderrTrimmed.length > STDERR_TAIL_BYTES
        ? `…(truncated; tail ${STDERR_TAIL_BYTES} bytes)\n${stderrTrimmed.slice(-STDERR_TAIL_BYTES)}`
        : stderrTrimmed;
    const fence = fenceFor(tail);
    parts.push(`**stderr:**\n\n${fence}\n${tail}\n${fence}`);
  }

  if (d.activityTrail && d.activityTrail.trim()) {
    parts.push(d.activityTrail.trim());
  }

  if (d.usageLine && d.usageLine.trim()) {
    parts.push(`**Usage before failure:** ${d.usageLine.trim()}`);
  }

  const partialOutputTrimmed = (d.partialOutput || "").trim();
  if (partialOutputTrimmed && partialOutputTrimmed !== "(no output)") {
    parts.push(`**Partial output:**\n\n${partialOutputTrimmed}`);
  }

  return parts.length === 0
    ? "(no diagnostic information captured — check the post-mortem .jsonl)"
    : parts.join("\n\n");
}
