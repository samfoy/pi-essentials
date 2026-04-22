# pi-essentials

Essential extensions for [pi](https://github.com/badlogic/pi-coding-agent) — quality-of-life improvements that every setup should have.

## Install

```bash
pi install npm:@samfp/pi-essentials
```

## What's Included

| Extension | What it does |
|-----------|-------------|
| **Auto Session Name** | Names sessions from the first user message — no more `unnamed-session-1` |
| **Compact Header** | Clean table-style startup header with keybinding reference |
| **Clipboard Image** | Paste base64 image data (PNG/JPEG) directly into the prompt |
| **Image Context Pruner** | Strips images from older messages to save context tokens |
| **Markdown Viewer** | Rendered markdown preview on Ctrl+O for `.md` files, plus `/mdview` and `/mermaid` commands |
| **Screenshot** | `/ss` command — grab clipboard image or send a file to the agent. Requires kitty terminal + `kitten` binary |
| **Context Pruner** | `context_prune` tool — lets the agent replace bulky search results with short summaries to free context space |
| **Daily Log** | `daily_log` tool — append timestamped entries to a daily markdown note (configurable via env vars) |
| **Subagent** | `subagent` and `subagent_status` tools for spawning background pi instances whose results auto-inject back |

## Requirements

- pi 0.57+
- For screenshots: kitty terminal with `clipboard_control read-clipboard`, tmux with `allow-passthrough on`, `~/.local/bin/kitten`
- For mermaid rendering: internet access (uses mermaid.ink API)

## License

MIT
