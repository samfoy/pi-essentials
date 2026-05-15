// src/auto-title.ts
import { basename } from "node:path";
function auto_title_default(pi) {
  let titled = false;
  let lastLabel;
  const tmuxPane = process.env.TMUX_PANE;
  const inTmux = !!process.env.TMUX && !!tmuxPane;
  let windowId;
  async function resolveWindowId() {
    if (!inTmux || windowId) return windowId;
    try {
      const { stdout, code } = await pi.exec("tmux", ["display-message", "-p", "-t", tmuxPane, "#{window_id}"]);
      if (code === 0 && stdout?.trim()) windowId = stdout.trim();
    } catch (e) {
      console.debug("[auto-title]", e);
    }
    return windowId;
  }
  function truncate(text, max) {
    const clean = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.slice(0, max) + "\u2026" : clean;
  }
  async function setTmuxTitle(label, cwd, ctx) {
    const folder = basename(cwd) || cwd;
    const paneTitle = `\u03C0 - ${folder} - ${label}`;
    ctx.ui.setTitle(paneTitle);
    const target = await resolveWindowId();
    if (!target) {
      lastLabel = label;
      return;
    }
    try {
      await pi.exec("tmux", ["rename-window", "-t", target, label]);
      if (tmuxPane) {
        await pi.exec("tmux", ["select-pane", "-t", tmuxPane, "-T", paneTitle]);
      }
      lastLabel = label;
    } catch (e) {
      console.debug("[auto-title]", e);
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    titled = !!pi.getSessionName();
    lastLabel = void 0;
  });
  pi.on("input", async (event, ctx) => {
    if (!ctx.hasUI) return { action: "continue" };
    if (!event.text?.trim()) return { action: "continue" };
    if (!titled && !pi.getSessionName()) {
      titled = true;
      const label = truncate(event.text, 40);
      await setTmuxTitle(label, ctx.cwd, ctx);
    }
    return { action: "continue" };
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const name = pi.getSessionName();
    if (name && name !== lastLabel) await setTmuxTitle(name, ctx.cwd, ctx);
  });
}
export {
  auto_title_default as default
};
//# sourceMappingURL=auto-title.js.map
