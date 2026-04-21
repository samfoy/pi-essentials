/**
 * Auto Title Extension
 *
 * Sets the tmux window name + terminal title from the first user input
 * of an unnamed session. No-ops in headless mode (`pi -p`), so background
 * subagents spawned with an inherited `TMUX_PANE` don't rename the parent.
 *
 * Refreshes the title on `agent_end` if `pi.getSessionName()` has been
 * updated (e.g. by `auto-session-name`, `/name`, or other extensions),
 * so the tmux window tracks the cleaned session name rather than staying
 * on the raw first-input truncation forever.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
  let titled = false;
  let lastLabel: string | undefined;

  const tmuxPane = process.env.TMUX_PANE;
  const inTmux = !!process.env.TMUX && !!tmuxPane;
  let windowId: string | undefined;

  async function resolveWindowId() {
    if (!inTmux || windowId) return windowId;
    try {
      const { stdout, code } = await pi.exec("tmux", ["display-message", "-p", "-t", tmuxPane!, "#{window_id}"]);
      if (code === 0 && stdout?.trim()) windowId = stdout.trim();
    } catch (e) { console.debug("[auto-title]", e); }
    return windowId;
  }

  function truncate(text: string, max: number): string {
    const clean = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.slice(0, max) + "…" : clean;
  }

  async function setTmuxTitle(label: string, cwd: string, ctx: ExtensionContext) {
    const folder = basename(cwd) || cwd;
    const paneTitle = `π - ${folder} - ${label}`;
    ctx.ui.setTitle(paneTitle);
    const target = await resolveWindowId();
    if (!target) { lastLabel = label; return; }
    try {
      await pi.exec("tmux", ["rename-window", "-t", target, label]);
      if (tmuxPane) {
        await pi.exec("tmux", ["select-pane", "-t", tmuxPane, "-T", paneTitle]);
      }
      lastLabel = label;
    } catch (e) { console.debug("[auto-title]", e); }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    titled = !!pi.getSessionName();
    lastLabel = undefined;
  });

  pi.on("input", async (event, ctx) => {
    if (!ctx.hasUI) return { action: "continue" as const };
    if (!event.text?.trim()) return { action: "continue" as const };
    if (!titled && !pi.getSessionName()) {
      titled = true; // claim flag before the await so concurrent inputs don't double-paint
      const label = truncate(event.text, 40);
      await setTmuxTitle(label, ctx.cwd, ctx);
    }
    return { action: "continue" as const };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const name = pi.getSessionName();
    if (name && name !== lastLabel) await setTmuxTitle(name, ctx.cwd, ctx);
  });
}
