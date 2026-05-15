// src/auto-session-name.ts
function auto_session_name_default(pi) {
  let named = false;
  pi.on("session_start", async (_event, ctx) => {
    named = !!pi.getSessionName();
  });
  pi.on("agent_end", async (event) => {
    if (named) return;
    const userMsg = event.messages.find((m) => m.role === "user");
    if (!userMsg) return;
    const text = typeof userMsg.content === "string" ? userMsg.content : userMsg.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    if (!text) return;
    const name = text.slice(0, 60).replace(/\n/g, " ").trim();
    if (name) {
      pi.setSessionName(name);
      named = true;
    }
  });
}
export {
  auto_session_name_default as default
};
//# sourceMappingURL=auto-session-name.js.map
