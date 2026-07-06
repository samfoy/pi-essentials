import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildActivityTrail,
  collapsePath,
  DEFAULT_MAX_ACTIVITY_EVENTS,
  fenceFor,
  formatFailureBody,
  formatToolCall,
  formatToolCallFull,
  MAX_ACTIVITY_LINE_CHARS,
  STDERR_TAIL_BYTES,
  type ToolCallEvent,
  truncateTail,
} from "../subagent-diagnostics.ts";

/**
 * Unit tests for the subagent failure-body formatter.
 *
 * Pure function, no peer-dep imports. Exercises the diagnostic fields
 * the upstream extension lost to "run.errorMessage || stderr || '(no output)'"
 * before the PR #X / fix/subagent-diagnostic-info branch.
 */

describe("formatFailureBody", () => {
  describe("fallback path", () => {
    it("empty input returns the explicit fallback, not an empty string", () => {
      const body = formatFailureBody({});
      assert.match(body, /no diagnostic information captured/);
      // The phrasing MUST surface that the failure info was lost — not
      // imply "(no output)" as if that were the subagent's own response.
      assert.doesNotMatch(body, /^\s*$/);
    });

    it("undefined/empty strings are treated as absent (don't render empty sections)", () => {
      const body = formatFailureBody({
        errorMessage: "",
        stopReason: undefined,
        stderr: "   ",
        activityTrail: "",
        usageLine: "",
        partialOutput: "",
      });
      assert.match(body, /no diagnostic information captured/);
    });
  });

  describe("sections render only when relevant", () => {
    it("errorMessage renders as **Error:** line", () => {
      const body = formatFailureBody({ errorMessage: "Rate limit exceeded" });
      assert.match(body, /\*\*Error:\*\* Rate limit exceeded/);
    });

    it("status omits stopReason='end_turn' (normal completion)", () => {
      const body = formatFailureBody({ stopReason: "end_turn", exitCode: 1 });
      assert.doesNotMatch(body, /end_turn/);
      assert.match(body, /\bexit=1\b/);
    });

    it("status omits exitCode=0 (even on failure paths where signal is the real cause)", () => {
      const body = formatFailureBody({ exitCode: 0, signal: "SIGTERM" });
      assert.doesNotMatch(body, /exit=0/);
      assert.match(body, /signal=SIGTERM/);
    });

    it("status renders all non-trivial fields in one line", () => {
      const body = formatFailureBody({
        stopReason: "error",
        exitCode: 1,
        signal: "SIGTERM",
      });
      assert.match(body, /\*\*Status:\*\* stop=error, exit=1, signal=SIGTERM/);
    });

    it("stderr wraps in a fenced code block", () => {
      const body = formatFailureBody({
        stderr: "something broke\nmore context",
      });
      assert.match(body, /\*\*stderr:\*\*/);
      assert.match(body, /```\nsomething broke\nmore context\n```/);
    });

    it("stderr gets truncated to tail when longer than STDERR_TAIL_BYTES", () => {
      // Fill with a repeating marker so we can assert head dropped, tail kept.
      const head = "HEAD_MARKER_SHOULD_BE_GONE\n";
      const mid = "x".repeat(STDERR_TAIL_BYTES);
      const tail = "\nTAIL_MARKER_SHOULD_REMAIN";
      const body = formatFailureBody({ stderr: head + mid + tail });
      assert.match(body, /TAIL_MARKER_SHOULD_REMAIN/);
      assert.doesNotMatch(body, /HEAD_MARKER_SHOULD_BE_GONE/);
      assert.match(body, /\(truncated; tail 2000 bytes\)/);
    });

    it("activityTrail renders verbatim as a markdown block", () => {
      const trail =
        "**Activity (2 tool calls):**\n\n- read: /some/path\n- bash: $ ls";
      const body = formatFailureBody({ activityTrail: trail });
      assert.match(body, /\*\*Activity \(2 tool calls\):\*\*/);
      assert.match(body, /- read: \/some\/path/);
      assert.match(body, /- bash: \$ ls/);
    });

    it("usageLine renders verbatim", () => {
      const body = formatFailureBody({ usageLine: "5t ↑100k ↓1k $0.05" });
      assert.match(body, /\*\*Usage before failure:\*\* 5t ↑100k ↓1k \$0.05/);
    });

    it("finalText renders as partial output when non-empty", () => {
      const body = formatFailureBody({ partialOutput: "I was trying to help." });
      assert.match(body, /\*\*Partial output:\*\*/);
      assert.match(body, /I was trying to help\./);
    });

    it("finalText='(no output)' is suppressed — it's the subagent's own no-output marker, not useful context", () => {
      const body = formatFailureBody({ partialOutput: "(no output)" });
      assert.doesNotMatch(body, /Partial output/);
      assert.match(body, /no diagnostic information captured/);
    });
  });

  describe("composition", () => {
    it("full failure renders every section in stable order", () => {
      const body = formatFailureBody({
        errorMessage: "Rate limit exceeded",
        stopReason: "error",
        exitCode: 1,
        signal: "SIGTERM",
        stderr: "upstream returned 429",
        activityTrail: "**Activity (1 tool call):**\n\n- bash: $ ls /x",
        usageLine: "5t ↑100k",
        partialOutput: "I was trying to help.",
      });

      // Order: Error → Status → stderr → Activity → Usage → Partial output
      const iError = body.indexOf("**Error:**");
      const iStatus = body.indexOf("**Status:**");
      const iStderr = body.indexOf("**stderr:**");
      const iActivity = body.indexOf("**Activity (");
      const iUsage = body.indexOf("**Usage before failure:**");
      const iPartial = body.indexOf("**Partial output:**");

      assert.ok(iError >= 0, "error section present");
      assert.ok(iStatus > iError, "status after error");
      assert.ok(iStderr > iStatus, "stderr after status");
      assert.ok(iActivity > iStderr, "activity after stderr");
      assert.ok(iUsage > iActivity, "usage after activity");
      assert.ok(iPartial > iUsage, "partial output after usage");
    });

    it("sections are separated by blank lines (render as discrete markdown blocks)", () => {
      const body = formatFailureBody({
        errorMessage: "err",
        activityTrail: "**Activity (1 tool call):**\n\n- bash: $ x",
      });
      assert.match(body, /\*\*Error:\*\* err\n\n\*\*Activity \(/);
    });

    it("signal-kill with otherwise clean exit still surfaces the signal", () => {
      // Repro of the Real World failure mode that motivated this change:
      // pi -p's subprocess gets SIGTERM'd mid-run. exitCode is null (→ undefined
      // here), signal is SIGTERM, no errorMessage, empty stderr. Previously
      // rendered as literally "(no output)"; should now surface the signal.
      const body = formatFailureBody({
        signal: "SIGTERM",
        partialOutput: "Now I'll write the deliverable.",
      });
      assert.match(body, /signal=SIGTERM/);
      assert.match(body, /Now I'll write the deliverable\./);
    });

    it("thin-diagnostic case (only stopReason='aborted', nothing else) still fires a Status line", () => {
      const body = formatFailureBody({ stopReason: "aborted" });
      assert.match(body, /\*\*Status:\*\* stop=aborted/);
      assert.doesNotMatch(body, /no diagnostic information captured/);
    });
  });
});

describe("fenceFor", () => {
  it("default fence is 3 backticks when content has none", () => {
    assert.equal(fenceFor("plain text\nno backticks"), "```");
  });

  it("single backtick in content still allows 3-backtick fence", () => {
    assert.equal(fenceFor("has one ` inside"), "```");
  });

  it("double backtick in content still allows 3-backtick fence", () => {
    assert.equal(fenceFor("has two `` inside"), "```");
  });

  it("triple backtick in content forces 4-backtick fence", () => {
    assert.equal(fenceFor("has three ``` inside"), "````");
  });

  it("backtick runs are counted correctly across whitespace (non-contiguous runs don't aggregate)", () => {
    // Two separate runs of 2 backticks — longest run is 2, fence is 3.
    assert.equal(fenceFor("run 1: `` and run 2: ``"), "```");
  });

  it("very long run of backticks picks fence one longer", () => {
    const content = "`".repeat(10);
    assert.equal(fenceFor(content), "`".repeat(11));
  });
});

describe("truncateTail", () => {
  it("short strings pass through unchanged", () => {
    assert.equal(truncateTail("hello", 100), "hello");
  });

  it("exact-length string is not truncated", () => {
    const s = "a".repeat(256);
    assert.equal(truncateTail(s, 256), s);
  });

  it("long string is tail-stripped with '…(N chars truncated)' suffix", () => {
    const s = "a".repeat(300);
    const out = truncateTail(s, 256);
    assert.match(out, /…\(\d+ chars truncated\)$/);
    assert.ok(out.length <= 256, "output length never exceeds maxChars");
  });

  it("reports the actual chars dropped (including suffix budget)", () => {
    // The suffix counts against the budget: if maxChars=100 and s.length=500,
    // naive arithmetic says 400 chars were dropped, but the suffix itself
    // takes ~22 chars away from `keep`, so the true number dropped is ~422.
    const s = "a".repeat(500);
    const out = truncateTail(s, 100);
    const match = out.match(/…\((\d+) chars truncated\)$/);
    assert.ok(match, "output has truncated-count suffix");
    const reportedCount = Number(match![1]);
    // The invariant: reportedCount === s.length - (out.length - suffix.length)
    // which simplifies to: reportedCount === s.length - keep, and keep is
    // chosen so that keep + suffix.length === maxChars. So the reported
    // count must be strictly larger than the naive (s.length - maxChars).
    assert.ok(
      reportedCount > s.length - 100,
      `reported ${reportedCount} should exceed naive ${s.length - 100}`,
    );
    // And the total output still fits within the cap.
    assert.ok(out.length <= 100);
  });

  it("head is preserved verbatim (tail is the cheap loss)", () => {
    const head = "IDENTIFYING_PREFIX ";
    const tail = "x".repeat(500);
    const out = truncateTail(head + tail, 100);
    assert.ok(out.startsWith(head), "identifying prefix is intact");
  });

  it("degenerate maxChars=0: output degrades to suffix alone (invariant documented)", () => {
    // Documents the corner-case: suffix is ~21 chars; when maxChars=0 there's
    // no room for content. Output exceeds the cap in this case — the
    // invariant only holds for maxChars >= suffix.length. No caller in the
    // module is allowed to go this small; this test pins the degraded
    // behaviour so any future caller knows what to expect.
    const s = "abc";
    const out = truncateTail(s, 0);
    assert.match(out, /…\(\d+ chars truncated\)$/);
    // Output DOES exceed the cap here — that's by design; the alternative
    // (silently dropping the suffix) would hide the truncation entirely.
    assert.ok(out.length > 0);
  });
});

describe("formatToolCallFull", () => {
  it("bash renders as '- bash: $ <full command>'", () => {
    const event: ToolCallEvent = {
      name: "bash",
      arguments: { command: "ls -la /foo" },
    };
    assert.equal(formatToolCallFull(event), "- bash: $ ls -la /foo");
  });

  it("read/write/edit render with full file_path, no home-tilde collapse", () => {
    const longPath =
      "/local/home/someone/workplace/deeply/nested/project/src/file.ts";
    for (const name of ["read", "write", "edit"]) {
      const event: ToolCallEvent = {
        name,
        arguments: { file_path: longPath },
      };
      const out = formatToolCallFull(event);
      assert.equal(out, `- ${name}: ${longPath}`);
      assert.doesNotMatch(out, /^\s*- \w+: ~/, "no ~ collapse");
    }
  });

  it("falls back to `path` if `file_path` is absent (legacy key)", () => {
    const event: ToolCallEvent = {
      name: "read",
      arguments: { path: "/legacy/path.txt" },
    };
    assert.equal(formatToolCallFull(event), "- read: /legacy/path.txt");
  });

  it("grep renders pattern + search path", () => {
    const event: ToolCallEvent = {
      name: "grep",
      arguments: { pattern: "needle", path: "/haystack" },
    };
    assert.equal(formatToolCallFull(event), "- grep: needle in /haystack");
  });

  it("grep defaults to '.' when no path is given", () => {
    const event: ToolCallEvent = {
      name: "grep",
      arguments: { pattern: "x" },
    };
    assert.equal(formatToolCallFull(event), "- grep: x in .");
  });

  it("unknown tools render their args as compact JSON", () => {
    const event: ToolCallEvent = {
      name: "custom-thing",
      arguments: { foo: "bar", n: 42 },
    };
    const out = formatToolCallFull(event);
    assert.match(out, /^- custom-thing: /);
    assert.match(out, /"foo":"bar"/);
  });

  it("truncates at MAX_ACTIVITY_LINE_CHARS (256) by default", () => {
    const longCmd = "a".repeat(500);
    const event: ToolCallEvent = {
      name: "bash",
      arguments: { command: longCmd },
    };
    const out = formatToolCallFull(event);
    assert.ok(out.length <= MAX_ACTIVITY_LINE_CHARS,
      `line length ${out.length} exceeds cap ${MAX_ACTIVITY_LINE_CHARS}`);
    assert.match(out, /…\(\d+ chars truncated\)$/);
  });

  it("accepts a custom maxLineChars override", () => {
    const event: ToolCallEvent = {
      name: "bash",
      arguments: { command: "a".repeat(200) },
    };
    const out = formatToolCallFull(event, 50);
    assert.ok(out.length <= 50);
  });

  it("unknown tool with JSON.stringify-throwing args falls back to '(unserializable args)'", () => {
    // BigInt serialization throws TypeError. The try/catch should swallow it.
    const event: ToolCallEvent = {
      name: "custom-thing",
      arguments: { big: BigInt(1) as unknown as string },
    };
    const out = formatToolCallFull(event);
    assert.match(out, /- custom-thing: \(unserializable args\)$/);
  });

  it("unknown tool with circular-ref args falls back to '(unserializable args)'", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const event: ToolCallEvent = {
      name: "custom-thing",
      arguments: circular,
    };
    const out = formatToolCallFull(event);
    assert.match(out, /- custom-thing: \(unserializable args\)$/);
  });
});

describe("formatToolCall — widget format", () => {
  const WIDGET_OPTS = { maxLineChars: 80, pathStyle: "collapsed" as const, format: "widget" as const };
  const HOME = process.env.HOME ?? "/home/test";

  it("bash: short command passes through verbatim", () => {
    const event: ToolCallEvent = { name: "bash", arguments: { command: "ls -la" } };
    assert.equal(formatToolCall(event, WIDGET_OPTS), "$ ls -la");
  });

  it("bash: command longer than 50 chars is truncated with ellipsis", () => {
    const long = "a".repeat(60);
    const event: ToolCallEvent = { name: "bash", arguments: { command: long } };
    const out = formatToolCall(event, WIDGET_OPTS);
    assert.equal(out, `$ ${"a".repeat(50)}\u2026`);
  });

  it("bash: missing command arg uses '...'", () => {
    const event: ToolCallEvent = { name: "bash", arguments: {} };
    assert.equal(formatToolCall(event, WIDGET_OPTS), "$ ...");
  });

  it("read: path is collapsed to ~", () => {
    const event: ToolCallEvent = {
      name: "read",
      arguments: { file_path: `${HOME}/Projects/foo.ts` },
    };
    const out = formatToolCall(event, WIDGET_OPTS);
    assert.equal(out, `read ~/Projects/foo.ts`);
  });

  it("write: includes 'write' action word", () => {
    const event: ToolCallEvent = {
      name: "write",
      arguments: { file_path: `${HOME}/out.txt` },
    };
    assert.ok(formatToolCall(event, WIDGET_OPTS).startsWith("write "));
  });

  it("edit: includes 'edit' action word", () => {
    const event: ToolCallEvent = {
      name: "edit",
      arguments: { file_path: `${HOME}/src/main.ts` },
    };
    assert.ok(formatToolCall(event, WIDGET_OPTS).startsWith("edit "));
  });

  it("unknown tool: returns tool name only", () => {
    const event: ToolCallEvent = { name: "knowledge_search", arguments: { query: "foo" } };
    assert.equal(formatToolCall(event, WIDGET_OPTS), "knowledge_search");
  });

  it("collapsePath: replaces home prefix with ~", () => {
    assert.equal(collapsePath(`${HOME}/foo`, HOME), "~/foo");
  });

  it("collapsePath: leaves non-home paths untouched", () => {
    assert.equal(collapsePath("/tmp/bar", HOME), "/tmp/bar");
  });
});

describe("formatToolCall — trail format (pathStyle: full)", () => {
  it("produces same output as formatToolCallFull", () => {
    const events: ToolCallEvent[] = [
      { name: "bash", arguments: { command: "ls" } },
      { name: "read", arguments: { file_path: "/home/user/file.ts" } },
      { name: "grep", arguments: { pattern: "TODO", path: "/src" } },
    ];
    for (const e of events) {
      assert.equal(
        formatToolCall(e, { maxLineChars: MAX_ACTIVITY_LINE_CHARS, pathStyle: "full", format: "trail" }),
        formatToolCallFull(e),
      );
    }
  });
});

describe("buildActivityTrail", () => {
  const mkBash = (cmd: string): ToolCallEvent => ({
    name: "bash",
    arguments: { command: cmd },
  });
  const mkRead = (path: string): ToolCallEvent => ({
    name: "read",
    arguments: { file_path: path },
  });

  it("returns empty string on empty input (caller can guard and omit)", () => {
    assert.equal(buildActivityTrail([]), "");
  });

  it("empty events + eventsFile still returns empty string (contract: no header without content)", () => {
    assert.equal(
      buildActivityTrail([], { eventsFile: "/tmp/x.jsonl" }),
      "",
      "eventsFile is ignored when there are no events to point at",
    );
  });

  it("maxEvents=0 returns empty string (no dangling header)", () => {
    // Edge case: the shown window would be [], producing a header over
    // an empty bullet list. Treated as "nothing to show" at the contract
    // boundary so callers don't have to special-case it.
    assert.equal(
      buildActivityTrail([mkBash("ls"), mkBash("pwd")], { maxEvents: 0 }),
      "",
    );
  });

  it("negative maxEvents also returns empty string", () => {
    assert.equal(
      buildActivityTrail([mkBash("ls")], { maxEvents: -5 }),
      "",
    );
  });

  it("renders single-event trail with 'N tool call' header (singular)", () => {
    const out = buildActivityTrail([mkBash("ls")]);
    assert.match(out, /\*\*Activity \(1 tool call\):\*\*/);
    assert.match(out, /- bash: \$ ls/);
  });

  it("renders multi-event trail with 'N tool calls' header (plural)", () => {
    const out = buildActivityTrail([mkBash("ls"), mkRead("/foo")]);
    assert.match(out, /\*\*Activity \(2 tool calls\):\*\*/);
  });

  it("preserves chronological order (oldest first in the shown window)", () => {
    const events = [mkBash("first"), mkBash("second"), mkBash("third")];
    const out = buildActivityTrail(events);
    const iFirst = out.indexOf("first");
    const iSecond = out.indexOf("second");
    const iThird = out.indexOf("third");
    assert.ok(iFirst >= 0 && iSecond > iFirst && iThird > iSecond);
  });

  it("caps at DEFAULT_MAX_ACTIVITY_EVENTS, showing the most recent N", () => {
    const many: ToolCallEvent[] = Array.from(
      { length: DEFAULT_MAX_ACTIVITY_EVENTS + 5 },
      (_, i) => mkBash(`cmd-${i}`),
    );
    const out = buildActivityTrail(many);
    // Oldest events elided
    assert.doesNotMatch(out, /cmd-0\b/);
    assert.doesNotMatch(out, /cmd-4\b/);
    // First kept event at the slice boundary (cap+5 total, keep last 20 →
    // first kept is index 5). Pins the slice boundary so future changes
    // don't silently shift which events get elided.
    assert.match(out, /cmd-5\b/);
    // Recent events kept
    assert.match(out, /cmd-24\b/);
    // Header reports the elision
    assert.match(out, /showing last 20/);
    assert.match(out, /5 older elided/);
  });

  it("when eventsFile is provided and events are elided, points reader at the file", () => {
    const many = Array.from({ length: 25 }, (_, i) => mkBash(`cmd-${i}`));
    const out = buildActivityTrail(many, {
      eventsFile: "/tmp/subagent-xyz-events.jsonl",
    });
    assert.match(out, /older 5 in \/tmp\/subagent-xyz-events\.jsonl/);
  });

  it("when eventsFile is provided but nothing is elided, still points at the file for truncation-recovery", () => {
    const out = buildActivityTrail([mkBash("ls")], {
      eventsFile: "/tmp/subagent-xyz-events.jsonl",
    });
    assert.match(out, /full events in \/tmp\/subagent-xyz-events\.jsonl/);
  });

  it("respects a custom maxEvents override", () => {
    const events = [mkBash("a"), mkBash("b"), mkBash("c"), mkBash("d")];
    const out = buildActivityTrail(events, { maxEvents: 2 });
    assert.match(out, /showing last 2/);
    assert.match(out, /2 older elided/);
    assert.match(out, /- bash: \$ c/);
    assert.match(out, /- bash: \$ d/);
    assert.doesNotMatch(out, /- bash: \$ a\b/);
  });

  it("truncates per-line at the configured maxLineChars", () => {
    const events = [mkBash("a".repeat(500))];
    const out = buildActivityTrail(events, { maxLineChars: 100 });
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    for (const line of lines) {
      assert.ok(line.length <= 100, `line exceeds cap: ${line.length}`);
    }
  });
});
