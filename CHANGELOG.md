# Changelog

## 1.0.0 (2026-04-21)


### Features

* add auto-title extension ([#1](https://github.com/samfoy/pi-essentials/issues/1)) ([4a1df40](https://github.com/samfoy/pi-essentials/commit/4a1df404085dcfc12949d980f8513099ff53fba6))
* add context-pruner extension ([77b3305](https://github.com/samfoy/pi-essentials/commit/77b330540105fc39d7d6a7b0351a9ca4cf6d53e8))
* add daily_log tool with configurable env vars ([5f5c2e7](https://github.com/samfoy/pi-essentials/commit/5f5c2e73afd0d907a8d01762911217a98f3a6725))
* add tests for pure functions, document daily-log in README ([54026d7](https://github.com/samfoy/pi-essentials/commit/54026d748ff4a907ed3df72e033b9585e2dfeb17))
* initial release — auto-session-name, compact-header, clipboard-image, image-pruner, markdown-viewer, screenshot, subagent ([77025cf](https://github.com/samfoy/pi-essentials/commit/77025cf739d08308e3b313a67ba25bbaf1f9cdab))


### Bug Fixes

* address review feedback from samfoy ([c176d80](https://github.com/samfoy/pi-essentials/commit/c176d8091833377816f3a9dab770355714e0324a))
* clone messages in image-context-pruner instead of mutating in-place ([043d3bb](https://github.com/samfoy/pi-essentials/commit/043d3bb330cdeb7fa01341be0c4b2ee5740933d5))
* guard event.text with optional chaining ([1a524a6](https://github.com/samfoy/pi-essentials/commit/1a524a605f79fe0ed8e9a9d45d88bf62c997c186))
* poll for pi readiness before pasting prompt ([5ea7f8a](https://github.com/samfoy/pi-essentials/commit/5ea7f8a47a6bc6fac426c9f4e4ce348599300b27))
* reduce context-pruner aggressiveness ([512a919](https://github.com/samfoy/pi-essentials/commit/512a919c82804d8d89c137f2e540a12c05cb5a05))
* scope package name to @samfp/pi-essentials ([cdaeb86](https://github.com/samfoy/pi-essentials/commit/cdaeb86a7f16a48ae3ccec2dba9b2b581251687e))
* use tmux new-window to avoid iTerm2 tmux -CC session capture ([1c4db4f](https://github.com/samfoy/pi-essentials/commit/1c4db4f8a3d5b24ee25d7f11691b356fed9ead26))
* use tmux paste-buffer for multi-line interactive subagent prompts ([568d502](https://github.com/samfoy/pi-essentials/commit/568d50257666ee395564386fbcc8e01dab19c877))
* use tmux paste-buffer for multi-line interactive subagent prompts ([6134a06](https://github.com/samfoy/pi-essentials/commit/6134a067258412ccf1d1a8edf1533cacf858f8a1))
