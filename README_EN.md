# DSH Desktop Notify (dsh-desktop-notify)

Desktop notifications for [DSH](https://github.com/deepseek-ai/dsh) on Windows and Linux, auto-loaded on every `dsh web` start (no approval).

- **Task done**: when the agent goes idle, show "✅ DSH 任务完成" with "workspace/session: last-reply summary"
- **Waiting for your input**: when the agent dispatches `ask_user_question`, ping you to come back
- **Approval auto-denied**: with the `never` approval policy, silently rejected operations get a "🚫 操作被自动拒绝" notice
- **Background task ended**: background subagents / goal complete or blocked / background jobs each notify on settle
- **Do-not-disturb**: **only the session you are currently looking at is silenced** — a notification is withheld only while a focused page has that very session selected; another window/tab, a minimized browser, or a different selected session (parallel sessions/workspaces) all let it through
- **DSH fish icon**: both the toast logo and the app identity icon use the DSH logo (transparent PNG/ICO), not a system default
- **Native, in-process delivery**: Windows calls WinRT directly through [koffi](https://koffi.dev/) to raise toasts, Linux talks to D-Bus (`org.freedesktop.Notifications`) directly — **no Python, no subprocess, no cold start**

## Screenshots

| Task done | Waiting for input | Approval denied |
| :---: | :---: | :---: |
| ![notify-task-done](screenshots/notify-task-done.png) | ![notify-question](screenshots/notify-question.png) | ![notify-denied](screenshots/notify-denied.png) |

| Subagent done | Goal complete/blocked | Job done |
| :---: | :---: | :---: |
| ![notify-subagent](screenshots/notify-subagent.png) | ![notify-goal](screenshots/notify-goal.png) | ![notify-job](screenshots/notify-job.png) |

## Install

Prerequisite: **`dsh web` started at least once** (so the web profile exists). No Python, no pip.

```powershell
# Windows
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

```bash
# Linux (a real desktop session — notifications go through the session D-Bus)
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
bash scripts/install.sh
```

The script copies the plugin into `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/` (`$DSH_HOME` defaults to `~/.dsh`) and registers it in the web profile's `package.json` (dependencies + bundles). On Windows it also makes the `koffi` runtime dependency resolvable from the profile (installs it with npm, or copies it from this repo's `node_modules`) and writes the AUMID `DSH` registry key (the app icon shown atop toasts). Then **fully restart `dsh web`** (stop the process and start it again — a page refresh is not enough).

Verify: switch to another window, let the agent run a small task, and a toast should appear in the bottom-right corner; **while you stay on that very session** nothing pops — but switching to another session (or another tab) lets its notifications through again (a focused page left untouched for 2 minutes counts as unfocused and resumes pushing). You can also run the smoke test directly:

```powershell
node scripts/winrt-probe.mjs   # Windows: registers the AUMID key and raises a real toast
```

## Notification catalog

| Notification | Hook | Session used for silencing | Body |
| --- | --- | --- | --- |
| ✅ Task done | `agent/status` running→idle (root agents only, 3 s debounce) | the agent's session | workspace/session: last-reply summary |
| ❓ Waiting for input | `tools/execute` catches `ask_user_question` dispatch | the asking session | workspace/session: [type] question |
| 🚫 Approval auto-denied | `session/event` feed `approval/asked`+`decided` audit pair | the session that was denied | workspace/session: tool-reason |
| 🤖 Subagent done | `subagent/end` | main session or the child session | workspace/main session: subagent name done |
| 🎯 Goal complete / blocked | `goal/changed` | the goal's session | workspace/session: objective-done / objective-block reason |
| 🧰 Job done | jobs service `onJobDone` | the owner session (unknown ⇒ never silenced) | workspace/session: job name done |

The workspace prefix is resolved per session (parallel sessions in different workspaces each show their own), and the session name comes from the `sessionTitle` service. Gating only compares sessions; it never changes the wording.

## Project layout

```
dsh-desktop-notify/
├── lib/          # host index.js (gating / queue) + gate.js (per-session focus gate) + winrt.js (Windows sender) + browser client.js (reporting)
├── assets/       # notification icons dsh.png / dsh.ico (DSH fish logo, transparent)
├── scripts/      # install.ps1 / install.sh, WinRT smoke test winrt-probe.mjs, icon generator make-icon.py
├── tests/        # node --test unit tests (gating logic, …)
├── docs/         # architecture, how-it-works, getting-started
├── screenshots/
├── cordis.patch.yml
└── package.json
```

## How it works & limitations

- **Focus gating (per session, event-driven, zero polling)**: the browser half (`lib/client.js`) reports, over the official Connection RPC channel `/dnotify`, whether the page is focused **and which session it currently has selected** (read from the harness client `sessions` service, `list.current`; a session switch re-reports immediately) — focused means `visibilityState === 'visible' && document.hasFocus()`, driven by native `focus`/`blur`/`visibilitychange`/`pagehide` events (page close is reliably reported via `keepalive`); user activity on the focused page (keyboard/mouse/scroll, throttled to 10 s) keeps it "fresh". The host aggregates per page × session (`lib/gate.js`): a notification is silenced **only when a focused page has exactly that session selected** — while you are reading session A, a finish in session B still pops. Notifications without a session (e.g. a job whose owner was already cleaned up) are never silenced. A focused-but-idle page (2 minutes without activity) counts as unfocused, and page entries that stopped reporting are pruned (10 minutes, crash fallback).
- **Delivery layer (native, in-process)**: on Windows `lib/winrt.js` drives WinRT through koffi (`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId('DSH')` → `XmlDocument.LoadXml` → `Show`) with no Python helper and no subprocess; before the first toast it idempotently writes `HKCU\SOFTWARE\Classes\AppUserModelId\DSH` (`DisplayName` + `IconUri`) so the notification center shows the icon. The queue spaces sends by 200 ms and re-queues a failed send once.
- **Message cache**: only the latest assistant-reply summary (≤220 chars) is cached per session, released as soon as the task-done notification consumes it; ask-timestamps (15 s suppression) are pruned when stale; re-initialized on restart.
- **Approval notices under `never`**: the `approval/request` waterfall is not dispatched under the `never` policy, so the plugin reads the `approval/asked`/`approval/decided` audit pair from the session log instead. Keep the approval policy `never` to receive these notices.
- **Notification icon**: the toast `appLogoOverride` only accepts PNG/JPG/GIF (SVG is not supported), so the plugin ships `assets/dsh.png` (rasterized from the DSH favicon by `scripts/make-icon.py`; transparent background, white fish — that script is a development-time asset tool, not needed to install or run the plugin); the app identity icon atop toasts / in the notification center comes from the AUMID `DSH` registry key `IconUri` (DSH-only keys).
- **Debug log switch**: off by default — the terminal prints no `[dsh-desktop-notify]` status lines. For troubleshooting, override the `desktop-notify` row in the profile's `cordis.patch.yml` (`config: { debug: true }`) and restart; the terminal then logs notify decisions / focus reports / fire / onJobDone.
- Depends on the platform notification backend: Windows Toast via WinRT, Linux via the desktop session's D-Bus notification service (KDE/GNOME). Windows **Focus Assist** and Linux do-not-disturb switches may swallow notifications.
- Windows is tested in practice; Linux goes through D-Bus (no desktop session, e.g. plain SSH, means no notifications); a macOS backend is not implemented yet.

## License

[MIT](LICENSE) © 2026 沐云 (Mvyvn)
