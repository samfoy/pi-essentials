/**
 * Auto Title Extension
 *
 * Sets the tmux window name + terminal title from the first user input
 * of an unnamed session. No-ops in headless mode (`pi -p`), so background
 * subagents spawned with an inherited `TMUX_PANE` don't rename the parent.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
  let titled = false;

  const tmuxPane = process.env.TMUX_PANE;
  const inTmux = !!process.env.TMUX && !!tmuxPane;
  let windowId: string | undefined;

  async function resolveWindowId() {
    if (!inTmux || windowId) return windowId;
    try {
      const { stdout, code } = await pi.exec("tmux", ["display-message", "-p", "-t", tmuxPane!, "#{window_id}"]);
      if (code === 0 && stdout?.trim()) windowId = stdout.trim();
    } catch {}
    return windowId;
  }

  function truncate(text: string, max: number): string {
    const clean = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.slice(0, max) + "…" : clean;
  }

  async function setTmuxTitle(label: string, cwd: string, ctx: { ui: { setTitle: (t: string) => void } }) {
    const folder = basename(cwd) || cwd;
    const paneTitle = `π - ${folder} - ${label}`;
    ctx.ui.setTitle(paneTitle);
    const target = await resolveWindowId();
    if (!target) return;
    try {
      await pi.exec("tmux", ["rename-window", "-t", target, label]);
      if (tmuxPane) {
        await pi.exec("tmux", ["select-pane", "-t", tmuxPane, "-T", paneTitle]);
      }
    } catch {}
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    titled = !!pi.getSessionName();
  });

  pi.on("input", async (event, ctx) => {
    if (!ctx.hasUI) return { action: "continue" as const };
    if (!event.text.trim()) return { action: "continue" as const };
    if (!titled && !pi.getSessionName()) {
      const label = truncate(event.text, 40);
      await setTmuxTitle(label, ctx.cwd, ctx);
      titled = true;
    }
    return { action: "continue" as const };
  });
}
