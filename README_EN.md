# DSH Desktop Notify (dsh-desktop-notify)

Windows desktop notifications for [DSH](https://github.com/deepseek-ai/dsh), auto-loaded on every `dsh web` start (no approval).

- **Task done**: when the agent goes idle, show "✅ DSH 任务完成" with the session title and a summary of the last reply
- **Waiting for your input**: when the agent dispatches `ask_user_question`, ping you to come back
- **Approval auto-denied**: with the `never` approval policy, silently rejected operations get a "🚫 操作被自动拒绝" notice
- **Background task ended**: background subagents / goal complete or blocked / background jobs each notify on settle
- **Do-not-disturb**: notifications only fire while the DSH page is not visible (the browser half reports visibility in real time)
- Toasts are sent via Python [`desktop-notifier`](https://github.com/samschott/desktop-notifier) (Windows Toast)

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

The script copies the plugin into `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/` (`$DSH_HOME` defaults to `~/.dsh`), registers it in the web profile's `package.json` (dependencies + bundles), then you **fully restart `dsh web`** (stop the process and start it again — a page refresh is not enough).

Verify: switch to another window, let the agent run a small task, and a toast should appear in the bottom-right corner; while the page is visible, nothing pops.

## Notification catalog

| Notification | Hook | Body |
| --- | --- | --- |
| ✅ Task done | `agent/status` running→idle (root agents only, 3 s debounce) | session title + last reply summary |
| ❓ Waiting for input | `tools/execute` catches `ask_user_question` dispatch | question header + text |
| 🚫 Approval auto-denied | `session/event` feed `approval/asked`+`decided` audit pair | tool name + reason |
| 🤖 Subagent done | `subagent/end` | provider + stopReason + output summary |
| 🎯 Goal complete / blocked | `goal/changed` | objective + block reason |
| 🧰 Job done | jobs service `onJobDone` | label + status |

## Project layout

```
dsh-desktop-notify/
├── lib/          # host index.js + browser client.js
├── scripts/      # install.ps1 / install.sh
├── docs/         # architecture, how-it-works, getting-started
├── screenshots/
├── cordis.patch.yml
└── package.json
```

## How it works & limitations

- **Two halves**: the Host half listens to host events and spawns a one-shot Python process for each toast; the browser half (`lib/client.js`) reports page visibility over the official Connection RPC channel `/dnotify` — while visible, notifications are silenced (30 s heartbeat + instant `visibilitychange` reports; 90 s after the page closes it counts as hidden).
- **Approval notices under `never`**: the `approval/request` waterfall is not dispatched under the `never` policy, so the plugin reads the `approval/asked`/`approval/decided` audit pair from the session log instead. Keep the approval policy `never` to receive these notices.
- Depends on a desktop notification backend (Windows Toast via `desktop-notifier` + WinRT); Windows **Focus Assist** may swallow toasts.
- Developed and tested on Windows; macOS/Linux paths and backends are untested — feedback welcome.

## License

[MIT](LICENSE) © 2026 沐云 (Mvyvn)
