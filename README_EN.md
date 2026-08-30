# DSH Desktop Notify (dsh-desktop-notify)

Windows desktop notifications for [DSH](https://github.com/deepseek-ai/dsh), auto-loaded on every `dsh web` start (no approval).

- **Task done**: when the agent goes idle, show "✅ DSH 任务完成" with "workspace/session: last-reply summary"
- **Waiting for your input**: when the agent dispatches `ask_user_question`, ping you to come back
- **Approval auto-denied**: with the `never` approval policy, silently rejected operations get a "🚫 操作被自动拒绝" notice
- **Background task ended**: background subagents / goal complete or blocked / background jobs each notify on settle
- **Do-not-disturb**: notifications are silenced **only while a DSH page has focus** (browser window focused and the tab active); whenever nothing is focused — another window/tab, minimized, browser closed or never opened — notifications are pushed
- **DSH fish icon**: both the toast logo and the app identity icon use the DSH logo (transparent PNG/ICO), not the Python default
- Toasts are sent by a **resident Python helper** ([`desktop-notifier`](https://github.com/samschott/desktop-notifier) + WinRT) — started once with dsh, payloads over stdin line by line, no per-notification cold start

## Screenshots

| Task done | Waiting for input | Approval denied |
| :---: | :---: | :---: |
| ![notify-task-done](screenshots/notify-task-done.png) | ![notify-question](screenshots/notify-question.png) | ![notify-denied](screenshots/notify-denied.png) |

| Subagent done | Goal complete/blocked | Job done |
| :---: | :---: | :---: |
| ![notify-subagent](screenshots/notify-subagent.png) | ![notify-goal](screenshots/notify-goal.png) | ![notify-job](screenshots/notify-job.png) |

## Install

Prerequisites:

1. `dsh web` started at least once (so the web profile exists);
2. Python 3.8+ with `desktop-notifier` installed (`pip install desktop-notifier`; the WinRT backend dependency comes along on Windows).

```powershell
# Windows
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

```bash
# macOS / Linux (same usage; the notification backend is the platform native one)
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
bash scripts/install.sh
```

The script copies the plugin into `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/` (`$DSH_HOME` defaults to `~/.dsh`), registers it in the web profile's `package.json` (dependencies + bundles), registers the Windows app identity (AUMID `DSH` — the app icon shown atop toasts), then you **fully restart `dsh web`** (stop the process and start it again — a page refresh is not enough).

Verify: switch to another window, let the agent run a small task, and a toast should appear in the bottom-right corner; while the DSH page is focused, nothing pops (a focused page left untouched for 2 minutes counts as unfocused and resumes pushing).

## Notification catalog

| Notification | Hook | Body |
| --- | --- | --- |
| ✅ Task done | `agent/status` running→idle (root agents only, 3 s debounce) | workspace/session: last-reply summary |
| ❓ Waiting for input | `tools/execute` catches `ask_user_question` dispatch | workspace/session: [type] question |
| 🚫 Approval auto-denied | `session/event` feed `approval/asked`+`decided` audit pair | workspace/session: tool-reason |
| 🤖 Subagent done | `subagent/end` | workspace/main session: subagent name done |
| 🎯 Goal complete / blocked | `goal/changed` | workspace/session: objective-done / objective-block reason |
| 🧰 Job done | jobs service `onJobDone` | workspace/session: job name done |

The workspace prefix is resolved per session (parallel sessions in different workspaces each show their own), and the session name comes from the `sessionTitle` service.

## Project layout

```
dsh-desktop-notify/
├── lib/          # host index.js (gating / queue / resident helper) + browser client.js (focus event reporting)
├── assets/       # notification icons dsh.png / dsh.ico (DSH fish logo, transparent)
├── scripts/      # install.ps1 / install.sh, icon generator make-icon.py, AUMID registrar register-aumid.py
├── docs/         # architecture, how-it-works, getting-started
├── screenshots/
├── cordis.patch.yml
└── package.json
```

## How it works & limitations

- **Focus gating (event-driven, zero polling)**: the browser half (`lib/client.js`) reports page focus over the official Connection RPC channel `/dnotify` — focused means `visibilityState === 'visible' && document.hasFocus()`, driven by native `focus`/`blur`/`visibilitychange`/`pagehide` events (page close is reliably reported via `keepalive`); user activity on the focused page (keyboard/mouse/scroll, throttled to 10 s) keeps it "fresh". The host aggregates per page (any focused page silences), treats a focused-but-idle page (2 minutes without activity) or no page at all as unfocused and resumes pushes, and auto-prunes page entries that stopped reporting (10 minutes, crash fallback).
- **Resident Python helper**: spawned once when dsh starts (desktop-notifier/WinRT imported once); notifications are delivered as JSON lines over stdin — millisecond latency, no cold start; auto-rebuilds on crash, terminated when dsh stops; 200 ms queue spacing, single retry-queue on write failure.
- **Message cache**: only the latest assistant-reply summary (≤220 chars) is cached per session, released as soon as the task-done notification consumes it; ask-timestamps (15 s suppression) are pruned when stale; re-initialized on restart.
- **Approval notices under `never`**: the `approval/request` waterfall is not dispatched under the `never` policy, so the plugin reads the `approval/asked`/`approval/decided` audit pair from the session log instead. Keep the approval policy `never` to receive these notices.
- **Notification icon**: the toast `appLogoOverride` only accepts PNG/JPG/GIF (SVG is not supported) and `desktop-notifier` defaults to its bundled python.png — the plugin ships `assets/dsh.png` (rasterized from the DSH favicon by `scripts/make-icon.py`; transparent background, white fish); the app identity icon atop toasts / in the notification center comes from the AUMID `DSH` shortcut + registry written by `scripts/register-aumid.py` (DSH-only keys, nothing Python-related is touched).
- **Debug log switch**: off by default — the terminal prints no `[dsh-desktop-notify]` status lines. For troubleshooting, override the `desktop-notify` row in the profile's `cordis.patch.yml` (`config: { debug: true }`) and restart; the terminal then logs notify decisions / focus reports / fire / onJobDone.
- Depends on a desktop notification backend (Windows Toast via `desktop-notifier` + WinRT); Windows **Focus Assist** may swallow toasts.
- Developed and tested on Windows; macOS/Linux paths and backends are untested — feedback welcome.

## License

[MIT](LICENSE) © 2026 沐云 (Mvyvn)
