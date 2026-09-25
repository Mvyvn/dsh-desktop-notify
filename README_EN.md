# DSH Desktop Notify (dsh-desktop-notify)

Desktop notifications for [DSH](https://github.com/deepseek-ai/dsh) on Windows and Linux, auto-loaded on every `dsh web` start (no approval). Currently targeting **DSH 0.1.7-rc.2** (the `jobs` service surface, client session snapshot and friends follow that version's contracts).

- **Task done**: when the agent goes idle, show "✅ DSH 任务完成" with "workspace/session: last-reply summary"
- **Waiting for your input**: when the agent dispatches `ask_user_question`, ping you to come back
- **Approval auto-denied**: with the `never` approval policy, silently rejected operations get a "🚫 操作被自动拒绝" notice
- **Background task ended**: background subagents / goal complete or blocked / background jobs each notify on settle
- **Startup report**: exactly one notification per `dsh web` start — "插件启动成功:共有 N 个插件成功加载", or the ids and count of the plugins that did not activate
- **Click-through**: session notifications jump back to that session, the startup report opens the Plugins panel; a notification without a target simply dismisses on click
- **Do-not-disturb**: **only the session you are currently looking at is silenced** — a notification is withheld only while a focused page has that very session selected; another window/tab, a minimized browser, or a different selected session (parallel sessions/workspaces) all let it through
- **DSH fish icon**: both the toast logo and the app identity icon use the DSH logo (transparent PNG/ICO), not a system default — **two variants** (white fish on dark themes, black fish on light themes) switched automatically with the system theme
- **Native, in-process delivery**: Windows calls WinRT directly through [koffi](https://koffi.dev/) to raise toasts, Linux talks to D-Bus (`org.freedesktop.Notifications`) directly — **no Python, no subprocess, no cold start** (click-through on Linux uses xdg-desktop-portal OpenURI, also without a subprocess)

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

The script copies the plugin into `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/` (`$DSH_HOME` defaults to `~/.dsh`) and registers the name in the web profile's `dsh.profile.bundles` — deliberately **not** in `dependencies`: npm hosts an unrelated plugin under the same name, so a dependency entry would make any `npm install` fetch that one and overwrite this local copy (the tradeoff is that an `npm install` in that profile treats this manually installed directory as extraneous and prunes it — re-run this script to restore it). On Windows it also makes the `koffi` runtime dependency resolvable from the profile (installs it with npm, or copies it from this repo's `node_modules`; **dependency first, plugin copy second**, otherwise npm prunes the freshly copied plugin) and writes the AUMID `DSH` registry key for the **current system theme** (the app icon shown atop toasts; the plugin rewrites it on every theme switch). Then **fully restart `dsh web`** (stop the process and start it again — a page refresh is not enough).

Verify: switch to another window, let the agent run a small task, and a toast should appear in the bottom-right corner; **while you stay on that very session** nothing pops — but switching to another session (or another tab) lets its notifications through again (a focused page left untouched for 2 minutes counts as unfocused and resumes pushing). You can also run the smoke tests directly:

```powershell
node scripts/winrt-probe.mjs    # Windows: registers the AUMID key (theme-picked icon) and raises a real toast
node scripts/theme-probe.mjs    # Windows/Linux: mode check + switch-event tracking self-test (never touches your theme)
node scripts/dsh-runtime-probe.mjs   # mounts the host half inside DSH's own cordis for a contract self-test (sends nothing)
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
| 🧰 Job done | `jobs.events` `settled` event (`onJobDone` was removed in 0.1.7; `kind='subagent'` jobs belong to the row above and are not reported twice) | the owner session (unknown ⇒ never silenced) | workspace/session: job name done/failed/killed |
| 🚀 Startup report | after `apply`, waits for the composition to settle (`loader.await()`) then counts the plugin rows | none (always pushed) | 插件启动成功:共有 N 个插件成功加载 / 有 N 个插件启动失败:加载失败的插件为 a、b |

The workspace prefix is resolved per session (parallel sessions in different workspaces each show their own), and the session name comes from the `sessionTitle` service. Gating only compares sessions; it never changes the wording.
A settlement with `awaited === true` (a caller was waiting and already got the result) is not reported; a backgrounded one-shot subagent is both a `subagent/end` and a `kind='subagent'` job, so only the former reports it.

## Calling it from your own plugin (public API)

The plugin registers a Cordis service named `desktopNotify`, so **your own plugin can push notifications through it**:

```js
// in your plugin (host half, apply)
export function apply(ctx) {
  const desktopNotify = ctx.get('desktopNotify')   // optional service: undefined when this plugin is absent
  if (!desktopNotify) return

  // 1) through the focus gate: only the session you are looking at is silenced
  desktopNotify.push({
    title: 'Build finished',
    message: 'workspace/session: all green',
    urgency: 'normal',        // 'low' | 'normal' | 'critical', defaults to normal
    sessionId: agent.session, // optional: enables per-session gating; omit to always push
  })

  // 2) bypassing the gate: pops no matter what is focused or selected
  desktopNotify.pushAlways({ title: 'Disk almost full', message: '1 GB left', urgency: 'critical' })

  // 3) want the details (queued? silenced? why?) use notify()
  const result = desktopNotify.notify({ title: 'Build finished', sessionId: agent.session })
  // { ok: true, queued: false, silenced: true, reason: 'silenced' }

  // 4) click-through: `url` is optional; with only `sessionId` the host builds a "jump back to that session" link
  desktopNotify.push({ title: 'Build finished', sessionId: agent.session })
  desktopNotify.push({ title: 'Open the docs', url: 'https://example.com/doc' })   // http/https only
}
```

- `true` means the item was **actually queued**; a focus-gated silence, a duplicate within the 1.5 s dedupe window, or a platform with no sender all return `false` (use `notify()` to tell them apart — it returns `{ ok: false, reason: 'invalid-payload' }` for a bad payload). **An empty title always returns `false` and pushes nothing.** `pushAlways` means "always": it skips both the gate and the dedupe window.
- `title` is capped at 160 chars and `message` at 400 (truncated without splitting surrogate pairs such as emoji); items still go out 200 ms apart, and the queue holds at most 32 items (the oldest is dropped past that).
- `sessionId` accepts a session object, an id, or an array of them (for subagents pass both the main and the child session). `url` is the **address a click opens** (http/https only); with no `url` but a `sessionId` the host builds a "jump back to that session" link; with neither the notification is not clickable.
- For a hard dependency write `inject: ['desktopNotify']` (your plugin then waits for this one); otherwise treat it as optional via `ctx.get`.

## Project layout

```
dsh-desktop-notify/
├── lib/          # host index.js (gating / queue / platform dispatch) + gate.js (per-session gate) + api.js (public push API)
│                 # senders: winrt.js (Windows / koffi → WinRT), toast-linux.js (Linux / D-Bus)
│                 # theme: theme.js (state + platform dispatch), theme-win32.js (registry + change events),
│                 #        theme-linux.js (portal + signal), theme-codec.js (pure decisions), icons.js (theme → icon)
│                 # plumbing: dbus.js (resident session bus: Hello/calls/signals), win32-registry.js (registry + wait handles),
│                 #           state.js (bounded containers + dedupe), text.js (truncation), client.js (browser focus/session reporting)
├── assets/       # notification icons: dsh-dark.{png,ico} (white fish / dark themes), dsh-light.{png,ico} (black fish / light themes),
│                 #                    dsh.{png,ico} kept as legacy-path copies
├── scripts/      # install.ps1 / install.sh, syntax self-check check-syntax.mjs
│                 # smoke tests: winrt-probe.mjs (raises a real toast), theme-probe.mjs (theme check + switch events)
│                 # contract self-check dsh-runtime-probe.mjs (mounts the host half inside DSH's own cordis)
│                 # icon generator make-icon.py (development-time only; needs Python)
├── tests/        # node --test unit tests (host event-flow integration / browser half / focus gate / public API
│                 #                / D-Bus marshalling+decoding / theme decisions / icon resolution / bounded containers / text truncation)
├── docs/         # architecture, how-it-works, getting-started
├── screenshots/
├── cordis.patch.yml
└── package.json
```

## How it works & limitations

- **Focus gating (per session, event-driven, zero polling)**: the browser half (`lib/client.js`) reports, over the official Connection RPC channel `/dnotify`, whether the page is focused **and which session it currently has selected** (the session "retained by the main view" in the harness client `sessions` snapshot — `byId[*].retainedBy.mainView`, the same probe official ui-layout/ui-session use; a session switch re-reports immediately) — focused means `visibilityState === 'visible' && document.hasFocus()`, driven by native `focus`/`blur`/`visibilitychange`/`pagehide` events (page close is reliably reported via `keepalive`); user activity on the focused page (keyboard/mouse/scroll, throttled to 10 s) keeps it "fresh", plus a 1-minute focused heartbeat so "reading without touching the mouse" is not mistaken for a blur. The host aggregates per page × session (`lib/gate.js`): a notification is silenced **only when a focused page has exactly that session selected** — while you are reading session A, a finish in session B still pops. Notifications without a session (e.g. a job whose owner was already cleaned up) are never silenced. A focused-but-idle page (2 minutes without activity) counts as unfocused, and page entries that stopped reporting are pruned (10 minutes, crash fallback).
- **Delivery layer (native, in-process)**: `lib/index.js` loads the sender for the current platform (koffi is never imported off Windows).
  - **Windows (`lib/winrt.js`)**: drives WinRT through koffi (`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId('DSH')` → `XmlDocument.LoadXml` → `Show`) with no Python helper and no subprocess; before the first toast it idempotently writes `HKCU\SOFTWARE\Classes\AppUserModelId\DSH` (`DisplayName` + `IconUri`) so the notification center shows the icon.
  - **Linux (`lib/toast-linux.js`)**: speaks the D-Bus wire protocol in pure JS (`$DBUS_SESSION_BUS_ADDRESS` or `/run/user/<uid>/bus`, SASL EXTERNAL handshake → `Hello` registration → `org.freedesktop.Notifications.Notify`) with no `notify-send` subprocess; the connection is kept and reused, reconnects after a drop (30 s failure cooldown, de-duplicated errors), and carries title/body/icon/urgency as method arguments. `Hello` is mandatory on a real bus — without it even AddMatch/signal subscription fails, which the theme watcher needs.
  - Both platforms share one send queue: 200 ms spacing, a failed send is re-queued once, at most 32 items.
- **Theme and icons**: notification backgrounds follow the system light/dark scheme while the icon itself is never inverted, so the package ships two transparent-background sets (`dsh-dark.*` white fish / `dsh-light.*` black fish). `lib/theme.js` reads once at startup and then follows switch events: on **Windows** it reads `HKCU\...\Themes\Personalize\SystemUsesLightTheme` (falling back to `AppsUseLightTheme`) and uses `RegNotifyChangeKeyValue` as an asynchronous event plus a 2 s non-blocking handle check; on **Linux** it reads xdg-desktop-portal's `org.freedesktop.appearance/color-scheme` and subscribes to the same interface's `SettingChanged` signal (environment heuristics when no portal exists). Either channel can be unavailable (policy/permissions/no portal), so both carry a 60 s fallback re-read; a theme change also rewrites the AUMID icon so the notification-center app icon follows.
- **Click-through (Windows protocol activation / Linux portal OpenURI)**: the host turns a click into opening `http://127.0.0.1:<port>/dnotify/click?t=<process token>&target=<target>`.
  - That address is a **tiny landing page that only records the target and tries to close itself** (it is not a DSH page): an already-open DSH page receives the target over SSE (`/dnotify/events`) and claims it via `/dnotify/claim` — **first come, first served; the host lets exactly one page through**. So the switch happens **in the page you already have open**, never in a new DSH page, and exactly one page switches when several are open. Whether the landing page may close itself is up to the browser (Chrome/Edge refuse script-closing an OS-opened tab, so it stays on a one-line "已通知 DSH 切换" notice).
  - **Windows**: the toast uses `activationType="protocol"` + `launch=URL`, so the system opens the address directly — no COM activator registration. A toast without a URL is plain: clicking just dismisses it.
  - **Linux**: a notification with a URL declares a `default` action, waits for the `Notify` reply to learn its id, and on `ActionInvoked` opens the address through xdg-desktop-portal `OpenURI` (no subprocess; when no portal exists it logs one line).
  - Targets: **session notifications** → `session:<session id>`, switched in place through the public `ctx.get('uiWorkspace').openSession(id)` (the same path a sidebar click takes; a **subagent** session lands on the subagent view per ui-workspace rules, a **background job** returns to its owning session). **The startup report** → `page:settings-plugins`: it synthesizes ⌘/Ctrl+, to open Settings and then clicks the "内置插件" nav cell; when Settings cannot be opened it falls back to the **Plugins panel** (`pluginNavigation.openBundle`). A notification without a target simply dismisses on click.
  - The older `#dsh-notify=<target>` form still works (manual opens, or as a fallback when SSE is unavailable).
- **Startup report (once per process)**: after `apply`, the plugin waits for the composition to settle, then counts the plugin rows in `ctx.get('loader')` — ACTIVE fibers count as loaded, while FAILED / missing fiber / still waiting for services are reported by `entry.options.id`; explicitly `disabled` rows are ignored. No `loader` service (a non-profile composition) ⇒ silently skipped. The once-per-process flag lives on `globalThis`, so an HMR re-apply does not re-announce.
- **Message cache**: only the latest assistant-reply summary (≤220 chars) is cached per session, released as soon as the task-done notification consumes it; every per-session/per-id cache is **bounded** (128 summaries, 64 approval pairs, 32 ask-timestamps — the oldest is evicted past that), so a resident host does not grow with the number of sessions; the same text from the same source within 1.5 s pops only once (no double toast on a re-dispatched event or a retry, while two identically-named jobs still each get their own toast); re-initialized on restart.
- **Approval notices under `never`**: the `approval/request` waterfall is not dispatched under the `never` policy, so the plugin reads the `approval/asked`/`approval/decided` audit pair from the session log instead. Keep the approval policy `never` to receive these notices.
- **Notification icon**: the toast `appLogoOverride` only accepts PNG/JPG/GIF (SVG is not supported), so the plugin ships four images (`assets/dsh-dark.png|ico` white fish, `assets/dsh-light.png|ico` black fish, rasterized once from the DSH favicon by `scripts/make-icon.py` — that script is a development-time asset tool, not needed to install or run the plugin) and picks a set from the current system theme at send time; the old paths `assets/dsh.png|ico` remain as compatibility copies of the dark (white-fish) variant. The app identity icon atop toasts / in the notification center comes from the AUMID `DSH` registry key `IconUri` (DSH-only keys), rewritten with the theme as well.
- **Debug log switch**: off by default — the terminal prints no `[dsh-desktop-notify]` **status** lines. For troubleshooting, override the `desktop-notify` row in the profile's `cordis.patch.yml` (`config: { debug: true }`) and restart; the terminal then logs notify decisions / focus reports / fire / job settled / theme. **Error** logs are not gated by this switch: send failures, D-Bus errors, hook exceptions and the no-backend notice still go to stderr.
- Depends on the platform notification backend: Windows Toast via WinRT, Linux via the desktop session's D-Bus notification service (KDE/GNOME). Windows **Focus Assist** and Linux do-not-disturb switches may swallow notifications.
- **Platforms**: Windows is tested in practice (Windows 11); Linux speaks D-Bus directly (Kubuntu/KDE, Ubuntu/GNOME and other desktop sessions — a plain SSH session with no desktop bus gets no notifications) and its marshalling is unit-tested; a macOS backend is not implemented yet (the plugin loads and logs a single "no backend" notice).

## License

[MIT](LICENSE) © 2026 沐云 (Mvyvn)
