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

```bash
# Linux: fires one notification (run inside a desktop session; plain SSH has no bus)
node --input-type=module -e "import('./lib/toast-linux.js').then(m => m.sendToast({ title: 'DSH notify test', message: 'direct D-Bus works' }))"
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

## Calling it from your own plugin (public API)

The plugin registers a Cordis service named `desktopNotify`, so **your own plugin can push notifications through it** in two modes:

```js
// in your plugin (host half, apply)
export function apply(ctx) {
  const notify = ctx.get('desktopNotify')   // optional service: undefined when this plugin is absent
  if (!notify) return

  // 1) through the focus gate: only the session you are looking at is silenced
  notify.push({
    title: 'Build finished',
    message: 'workspace/session: all green',
    urgency: 'normal',        // 'low' | 'normal' | 'critical', defaults to normal
    sessionId: agent.session, // optional: enables per-session gating; omit to always push
  })

  // 2) bypassing the gate: pops no matter what is focused or selected
  notify.pushAlways({ title: 'Disk almost full', message: '1 GB left', urgency: 'critical' })
}
```

- `true` means the item was accepted into the queue; **an empty title returns `false` and pushes nothing**.
- `title` is capped at 160 chars and `message` at 400 (truncated); items still go out 200 ms apart.
- `sessionId` accepts a session object, an id, or an array of them (for subagents pass both the main and the child session).
- For a hard dependency write `inject: ['desktopNotify']` (your plugin then waits for this one); otherwise treat it as optional via `ctx.get`.

## Project layout

```
dsh-desktop-notify/
├── lib/          # host index.js (gating / queue / platform dispatch) + gate.js (per-session gate) + api.js (public push API)
│                 # senders: winrt.js (Windows / koffi → WinRT), toast-linux.js (Linux / D-Bus)
│                 # client.js (browser focus + session reporting)
├── assets/       # notification icons dsh.png / dsh.ico (DSH fish logo, transparent)
├── scripts/      # install.ps1 / install.sh, WinRT smoke test winrt-probe.mjs, icon generator make-icon.py
├── tests/        # node --test unit tests (focus gate / public API / D-Bus marshalling)
├── docs/         # architecture, how-it-works, getting-started
├── screenshots/
├── cordis.patch.yml
└── package.json
```

## How it works & limitations

- **Focus gating (per session, event-driven, zero polling)**: the browser half (`lib/client.js`) reports, over the official Connection RPC channel `/dnotify`, whether the page is focused **and which session it currently has selected** (read from the harness client `sessions` service, `list.current`; a session switch re-reports immediately) — focused means `visibilityState === 'visible' && document.hasFocus()`, driven by native `focus`/`blur`/`visibilitychange`/`pagehide` events (page close is reliably reported via `keepalive`); user activity on the focused page (keyboard/mouse/scroll, throttled to 10 s) keeps it "fresh". The host aggregates per page × session (`lib/gate.js`): a notification is silenced **only when a focused page has exactly that session selected** — while you are reading session A, a finish in session B still pops. Notifications without a session (e.g. a job whose owner was already cleaned up) are never silenced. A focused-but-idle page (2 minutes without activity) counts as unfocused, and page entries that stopped reporting are pruned (10 minutes, crash fallback).
- **Delivery layer (native, in-process)**: `lib/index.js` loads the sender for the current platform (koffi is never imported off Windows).
  - **Windows (`lib/winrt.js`)**: drives WinRT through koffi (`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId('DSH')` → `XmlDocument.LoadXml` → `Show`) with no Python helper and no subprocess; before the first toast it idempotently writes `HKCU\SOFTWARE\Classes\AppUserModelId\DSH` (`DisplayName` + `IconUri`) so the notification center shows the icon.
  - **Linux (`lib/toast-linux.js`)**: speaks the D-Bus wire protocol in pure JS (`$DBUS_SESSION_BUS_ADDRESS` or `/run/user/<uid>/bus`, SASL EXTERNAL handshake → `org.freedesktop.Notifications.Notify`) with no `notify-send` subprocess; the connection is kept and reused, reconnects after a drop, and carries title/body/icon/urgency as method arguments.
  - Both platforms share one send queue: 200 ms spacing, a failed send is re-queued once.
- **Message cache**: only the latest assistant-reply summary (≤220 chars) is cached per session, released as soon as the task-done notification consumes it; ask-timestamps (15 s suppression) are pruned when stale; re-initialized on restart.
- **Approval notices under `never`**: the `approval/request` waterfall is not dispatched under the `never` policy, so the plugin reads the `approval/asked`/`approval/decided` audit pair from the session log instead. Keep the approval policy `never` to receive these notices.
- **Notification icon**: the toast `appLogoOverride` only accepts PNG/JPG/GIF (SVG is not supported), so the plugin ships `assets/dsh.png` (rasterized from the DSH favicon by `scripts/make-icon.py`; transparent background, white fish — that script is a development-time asset tool, not needed to install or run the plugin); the app identity icon atop toasts / in the notification center comes from the AUMID `DSH` registry key `IconUri` (DSH-only keys).
- **Debug log switch**: off by default — the terminal prints no `[dsh-desktop-notify]` status lines. For troubleshooting, override the `desktop-notify` row in the profile's `cordis.patch.yml` (`config: { debug: true }`) and restart; the terminal then logs notify decisions / focus reports / fire / onJobDone.
- Depends on the platform notification backend: Windows Toast via WinRT, Linux via the desktop session's D-Bus notification service (KDE/GNOME). Windows **Focus Assist** and Linux do-not-disturb switches may swallow notifications.
- **Platforms**: Windows is tested in practice (Windows 11); Linux speaks D-Bus directly (Kubuntu/KDE, Ubuntu/GNOME and other desktop sessions — a plain SSH session with no desktop bus gets no notifications) and its marshalling is unit-tested; a macOS backend is not implemented yet (the plugin loads and logs a single "no backend" notice).

## License

[MIT](LICENSE) © 2026 沐云 (Mvyvn)
