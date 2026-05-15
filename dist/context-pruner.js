// src/context-pruner.ts
import { Type } from "@sinclair/typebox";
function ok(text) {
  return { content: [{ type: "text", text }], details: {} };
}
var PRUNABLE_TOOLS = /* @__PURE__ */ new Set([
  "knowledge_search",
  "session_search",
  "session_read",
  "graph_query",
  "graph_path",
  "code_search",
  "code_overview"
]);
var PRUNE_THRESHOLD = 4;
var NUDGE = `
<context_management>
You have search/read tool results accumulating in context. When you've finished a research phase and are moving on (to implementation, a different question, or a new line of investigation), call context_prune on results you no longer need to reference directly. Do NOT prune results you're still actively working with \u2014 only prune once you've extracted what you need and are done with that line of inquiry. Prune by tool_name (most recent call) or tool_use_id for precision.
</context_management>`;
function contextPruner(pi) {
  const pruned = /* @__PURE__ */ new Map();
  const prunableCalls = /* @__PURE__ */ new Map();
  const latestByTool = /* @__PURE__ */ new Map();
  let hasPrunableTools = false;
  pi.on("session_start", async () => {
    pruned.clear();
    prunableCalls.clear();
    latestByTool.clear();
    hasPrunableTools = false;
  });
  pi.on("tool_execution_end", async (event) => {
    if (PRUNABLE_TOOLS.has(event.toolName)) {
      prunableCalls.set(event.toolCallId, event.toolName);
      latestByTool.set(event.toolName, event.toolCallId);
      hasPrunableTools = true;
    }
  });
  pi.on("context", async (event) => {
    if (pruned.size === 0) return;
    let replaced = 0;
    const messages = event.messages.map((msg) => {
      if (msg.role !== "toolResult") return msg;
      const summary = pruned.get(msg.toolCallId);
      if (!summary) return msg;
      replaced++;
      return {
        ...msg,
        content: [{ type: "text", text: `[pruned] ${summary}` }]
      };
    });
    if (replaced > 0) return { messages };
  });
  pi.on("before_agent_start", async (event) => {
    const unpruned = [...prunableCalls.keys()].filter((id) => !pruned.has(id)).length;
    if (unpruned < PRUNE_THRESHOLD) return;
    return { systemPrompt: event.systemPrompt + NUDGE };
  });
  pi.registerTool({
    name: "context_prune",
    description: "Replace a previous tool result with a short summary to free context space. Use after processing results from search tools (knowledge_search, session_search, graph_query, code_search, session_read, code_overview). Pass either the tool_use_id or the tool_name (prunes the most recent call to that tool).",
    parameters: Type.Object({
      tool_use_id: Type.Optional(Type.String({ description: "tool_use_id of the result to replace" })),
      tool_name: Type.Optional(Type.String({ description: "Tool name \u2014 prunes the most recent call (e.g. 'knowledge_search')" })),
      summary: Type.String({ description: "Brief summary of useful content (1-3 sentences)" })
    }),
    async execute(toolCallId, input) {
      let { tool_use_id, tool_name, summary } = input;
      if (!tool_use_id && tool_name) {
        tool_use_id = latestByTool.get(tool_name);
        if (!tool_use_id) return ok(`No recent ${tool_name} call found to prune.`);
      }
      if (!tool_use_id) return ok("Provide either tool_use_id or tool_name.");
      if (pruned.has(tool_use_id)) return ok(`Already pruned.`);
      pruned.set(tool_use_id, summary);
      const resolvedName = tool_name || prunableCalls.get(tool_use_id);
      const label = resolvedName ? ` (${resolvedName})` : "";
      return ok(`Pruned${label}. Summary replaces original on next turn.`);
    }
  });
}
export {
  contextPruner as default
};
//# sourceMappingURL=context-pruner.js.map
