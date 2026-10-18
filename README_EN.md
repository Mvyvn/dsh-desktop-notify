# DSH Desktop Notify (@mvyvn/dsh-desktop-notify)

Desktop notifications for [DSH](https://github.com/deepseek-ai/dsh) on Windows and Linux. The plugin loads automatically on every `dsh web` start — no approval step.

**Version 2.1.0** · Compatible with **DSH `>=0.1.7-rc.2` and `<=0.2.0-rc.2`** (the `peerDependencies` range declared in `package.json`; other minor releases inside that range are not individually tested).

## Building from source (developer path)

```bash
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
npm install
npm run build        # tsc ×3 → lib/
```

The `lib/` output is what ships and what DSH loads at runtime (DSH never compiles a plugin). **After changing the source you must run `npm run build` and restart `dsh web`** before the host picks up the new code.

The manifest itself is a valid bundle: `dsh.bundle.patch` points at `cordis.patch.yml` (the host half's row), `dsh.client` declares the browser half, and `koffi` is a regular `dependencies` entry. The AUMID `DSH` registry key is written by the **plugin itself** at startup, following the current system theme (`DisplayName` is exactly **DeepSeek Harness**) — no install script is involved.

## Requirements

| Item | Requirement |
| --- | --- |
| **DSH** | **`>= 0.1.7-rc.2` and `<= 0.2.0-rc.2`**. The service surface this plugin relies on (`connection` / `webServer` / `jobs` / `subagent` / `schedule` / `loader` / cordis) is unchanged across that range; nothing outside it is claimed to work |
| Declared range | `peerDependencies: { "@deepseek-ai/dsh": ">=0.1.7-rc.2 <=0.2.0-rc.2" }` — DSH's boot-time compatibility preflight uses it to refuse a mismatched combination (including newer 0.2.x releases) |
| Runtime | Windows needs [koffi](https://koffi.dev/) to raise WinRT toasts (declared as a regular dependency, installed for you); Linux needs nothing extra (pure-JS D-Bus) |
| Browser | Firefox / Chromium-based (the Web Notification route uses a Service Worker and `WindowClient.focus()`, see below) |

## Features

- **Task done**: when an agent goes idle, show "✅ DSH 任务完成" with "workspace/session: last-reply summary"
- **Waiting for your input**: when the agent dispatches `ask_user_question`, ping you to come back
- **Approval auto-denied**: under the `never` approval policy, silently rejected operations get a "🚫 DSH 操作被自动拒绝" notice
- **Background work finished**: background subagents / goal completed or blocked / background jobs each notify on settle
- **Scheduled task fired**: reported when a scheduled task is actually **delivered (fired)** — creating one stays quiet
- **Startup report**: exactly one notification per `dsh web` start — "🚀 DSH 插件挂载成功", body `共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：正常/降级`; when some plugins failed the title becomes "⚠️ DSH 插件挂载异常" and the body lists the count and ids. Sent once per start
- **Click-through**: session and page notifications jump back to the right place; a notification without a target just dismisses on click
- **Two delivery channels**: with an online DSH page that has notification permission the plugin uses **Web Notification** (the browser itself focuses the right tab, no intermediate page); otherwise it falls back to a **native toast** (clicking opens a new tab on the DSH deep link)
- **Every title carries the `DSH` prefix**: the icon and the source line belong to whoever raised the notification (Web Notification shows the browser's identity and cannot be changed), so the branding lives in the title — every title is "emoji + DSH + text"
- **Instant permission-change notice**: title "⚠️ DSH 权限变更", body `dsh-desktop-notify 跟踪到消息提醒权限变更为:xxx，插件运行模式同步变更为xxx` (`xxx` is `granted`/`denied`/`default` and `正常`/`降级`); it bypasses the focus gate and does not repeat for an unchanged state
- **DSH icons**: both the native toast logo and the app identity use the DSH logo (transparent PNG/ICO), with light and dark variants picked from the system theme
- **Native, in-process delivery**: Windows calls WinRT through koffi, Linux talks to D-Bus (`org.freedesktop.Notifications`) directly — **no Python, no subprocess**

## Install
> npm package: `@mvyvn/dsh-desktop-notify` — repository: <https://github.com/Mvyvn/dsh-desktop-notify>.
> The DSH plugin manager can install straight from the **npm package name**; an absolute local path also works.

Prerequisite: **`dsh web` started at least once** (so the web profile exists). No Python, no pip.

### Option 1 — install by package name (recommended)

In DSH open **Plugin Manager** → add plugin, and enter the package name **`@mvyvn/dsh-desktop-notify`**. The plugin manager resolves it from the registry, installs the runtime dependencies, registers the package as a profile bundle and enables it.

Then **fully restart `dsh web`** (stop the process and start it again — a page refresh is not enough) and **refresh the DSH page once**.

### Option 2: install from the GitHub repository

Use the same **add plugin** entry in the DSH plugin manager, with the repository URL:
<https://github.com/Mvyvn/dsh-desktop-notify>. The manager fetches the repository, installs its runtime
dependencies, and registers the package as a profile bundle.

### First run: grant notification permission (required for the Web Notification route)

Browsers only show the permission prompt after a user gesture, so the plugin never opens it automatically. Instead it shows a one-off centered card inside the DSH page:

> **开启桌面通知** — "Settings" opens the browser permission prompt; "Cancel" only dismisses the card. Closing the card in any tab closes it in the others too.

Allow it and notifications are shown by the browser, with clicks focusing the existing DSH tab precisely. If permission is missing or denied nothing breaks: the plugin falls back to native toasts whose click opens a new tab. The active mode is written into the **startup report** body (the full line is `共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：正常` or `…：降级`). Changing the permission in your browser's site settings is noticed immediately — no restart.

## Notification catalog

| Notification | Trigger | Session used for silencing | Body |
| --- | --- | --- | --- |
| ✅ Task done | `agent/status` running→idle (root agents only, 3 s debounce) | the agent's session | workspace/session: last-reply summary |
| ❓ Waiting for input | `tools/execute` catches an `ask_user_question` dispatch | the asking session itself | workspace/session: [type] question |
| 🚫 Approval auto-denied | `session/event` feed, the `approval/asked`+`decided` audit pair | the session the denied operation ran in | workspace/session: tool-reason |
| 🤖 Subagent done | `subagent/end` | the main session **and** the child session (looking at either one silences it) | workspace/main session: subagent name done |
| 🎯 Goal completed / blocked | `goal/changed` | the goal's session | workspace/session: objective-done / objective-block reason |
| 🧰 Job done | `jobs.events` `settled` (`awaited` also notifies; `kind='subagent'` jobs belong to the row above) | the owner session **and** the main session of its subagent | workspace/main session: job name done/failed/killed |
| 🕒 Team task pending / ✅ Team task done | `session/event` `team/task` (state changes only) | the task owner's main session | workspace/session: task title |
| 🗜️ Context compacted | `session/event` `compaction/end` (failures carrying `error` are skipped) | that session itself (its parent/child sessions still notify) | workspace/session: 上下文已智能压缩 |
| ⏰ Scheduled task fired | `schedule/changed` → `catalog()` compared by **delivery record** (`lastDelivery` must change) | that scheduled task's session | workspace/session: task title |
| 🚀 Plugins loaded / ⚠️ Plugins failed | after `apply`, wait for the composition to settle and count plugin rows; **waits for an online page with permission** (up to 5 s, then falls back) | none (always pushed) | 共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：正常/降级 / 存在 N 个插件运行异常：a、b |

The "workspace" prefix is resolved per session (parallel sessions in different workspaces each show their own) and the session name comes from the `sessionTitle` service. **Gating only compares sessions and never changes the wording; the click target and the silencing decision are separate things** — a subagent notice is silenced by the child session but always clicks through to the main session.

### Per-category settings

**Every category is configurable** (Plugin Manager → the @mvyvn/dsh-desktop-notify row → settings): a master switch, debug mode, the public-API switch, and per-category switches plus a **three-level silence mode**:

| Silence mode | Shown in the settings page | Meaning |
| --- | --- | --- |
| `session` (default) | 看着该会话时静默 | Do not disturb while you are looking at the session the notification belongs to |
| `tab` | 看着任意 DSH 标签页时静默 | **Tab level**: quiet whenever any DSH tab is visible and focused |
| `never` | 从不静默 | Never silenced (the startup report and permission notices default to this; neither has a session, so the settings page shows them as "无会话归属 · 始终推送") |

Changes are written back to the profile's `cordis.patch.yml` and the loader reloads in place — **no restart needed**.

The levels are deliberately different: **subagents** gate on "main session + child session", **jobs** on "owner session + its subagent's main session", everything else on the session itself (so a notice still arrives while you are looking at its parent or child session).

The top of the settings page also shows a runtime status line: "运行模式：正常" (browser notifications available), "运行模式：降级" with the reason (master switch off / browser permission not granted / Service Worker not ready), or "运行状态：关闭".

## Calling it from your own plugin (public API)

**Baseline protocol version: `1.0.0`** (`NOTIFY_API_VERSION`). Compatibility rules: **unknown payload fields are ignored** (new optional fields never break an existing caller); a payload may declare `v: '1.0.0'`, and a **higher major version** does not stop delivery — the result just carries `unsupportedVersion: true`; result fields are **additive only**; use `capabilities` to probe for features (`push` / `pushAlways` / `notify` / `click.session` / `click.page` / `click.url` / `click.legacy-url` / `web-notification` / `dialog.four-state`) instead of guessing from the version.

The plugin registers a Cordis service named `desktopNotify`, so **your own plugin can push notifications through it**:

```js
// in your plugin (host half, apply)
export function apply(ctx) {
  const desktopNotify = ctx.get('desktopNotify')   // optional service: undefined when this plugin is absent
  if (!desktopNotify) return

  // 0) branch on capabilities when you need to
  if (!desktopNotify.capabilities.includes('click.page')) return

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
  // { ok: true, queued: false, silenced: true, reason: 'silenced', apiVersion: '1.0.0', unsupportedVersion: false }

  // 4) click-through: declare it explicitly with `click` (four states) — no `click` means NOT clickable
  desktopNotify.push({ title: 'Build finished', sessionId: agent.session,
    click: { type: 'session', sessionId: agent.session } })            // jump back to that session
  desktopNotify.push({ title: 'Open the docs', click: { type: 'url', url: 'https://example.com/doc' } })
  desktopNotify.push({ title: 'Just a notice' })                       // clicking does nothing
}
```

- `true` means the item was **actually queued**; a focus-gated silence, a duplicate within the 1.5 s dedupe window, or a platform with no notification backend all return `false` (use `notify()` to tell them apart). **An empty title always returns `false` and pushes nothing.** `pushAlways` means "always": it skips both the gate and the dedupe window.
- `title` is capped at 160 chars and `message` at 400 (truncated without splitting surrogate pairs such as emoji); items go out 200 ms apart, and the queue holds at most 32 items (the oldest is dropped past that).
- **`sessionId` only drives the gate, `click` only drives the click.** `click` is a four-state union:

  | `click` | clicking the notification |
  | --- | --- |
  | omitted / `null` | **does nothing** (not clickable) |
  | `{ type: 'session', sessionId }` | jumps to that session (subagent sessions open the subagent view) |
  | `{ type: 'page', page: 'settings-plugins' \| 'plugins' }` | opens that built-in page |
  | `{ type: 'url', url: 'https://…' }` | opens the external address (http/https only) |

  An unrecognized shape (missing fields, unknown `page`, non-http(s) `url`) is treated as **not clickable** — the plugin never guesses. The legacy `url: 'https://…'` field still works and means `{ type: 'url', url }`.
- `sessionId` accepts a session object, an id, or an array of them (for subagents pass both the main and the child session).
- For a hard dependency write `inject: ['desktopNotify']` (your plugin then waits for this one); otherwise treat it as optional via `ctx.get`.
- With the settings page's **public API** switch off, the service still exists (`apiVersion` / `capabilities` stay readable so callers can probe) but `push` / `pushAlways` never enqueue, and `notify()` honestly returns `reason: 'api-disabled'`.

## Troubleshooting: why a notice did not pop (or a click did nothing)

The host exposes the token-protected diagnostic endpoint `GET /dnotify/status?t=<process token>`. The token is per process: read it from the `t=` parameter of a notification click URL (a native toast lands on `/dnotify/click?t=…&raw=…`) or from the profile logs.

| Field | Meaning |
| --- | --- |
| `lastRoute` | Which channel the last notification took: `mode: "web"` (browser notification) or `"native"` (toast), plus a `reason`: `no-online-page` / `permission-not-granted` / `deliver-failed` / `no-shown-ack` / `show-error` |
| `lastSwReport` | The most recent report from the Service Worker or a page: `register` / `shown` / `click` / `focused` / `show-error` / `show-request` … |
| `lastNotify` / `notifyLog` | The last few `notify()` outcomes: `queued` / `silenced` (you were looking at that session) / `duplicate` (inside the dedupe window) / `dropped` |
| `recentSent` | The last 12 notifications sent: title, click target (`wire`) and the actual launch URL — answers "was the notification I clicked even clickable?" |
| `pages` / `pending` / `lastActivate` / `lastClaim` / `lastNavigate` | The click chain: page registry / pending activations / last activation decision / claim / the navigation result reported by the client (`not-found` means the target session is not in the client catalogue) |
| `config` | The configuration **actually in effect** (master switch, debug, public API, per-category switches and silence levels) plus the loaded build's path and mtime — confirms which artifact the host is running |
| `eventLog` | The last few `session/event` types — tells you whether a hook event reached the plugin at all |
| `jobLog` | The whole `jobs` chain: `hooked` plus each event's `type/status/awaited/kind` |
| `scheduleLog` | `schedule/changed` versus the `catalog()` comparison (`delivered` marks a "just fired" decision) |

## Project layout

```
dsh-desktop-notify/
├── src/          # TypeScript source (strict + erasableSyntaxOnly, TS7-ready) → compiled to lib/
│                 # protocol.ts (ClickTarget four states + wire format), pages.ts (page registry state machine)
│                 # activation.ts (activation decisions), gate.ts (per-session gate), api.ts (public push API)
│                 # index.ts (routes/queue/events/channel split), client.ts (browser half), config.ts (settings schema)
│                 # senders: winrt.ts (Windows / koffi → WinRT), toast-linux.ts (Linux / D-Bus)
│                 # theme*.ts, plumbing: dbus.ts / win32-registry.ts / state.ts / text.ts
├── lib/          # build output (committed; DSH loads it directly at runtime)
├── assets/       # dnotify-sw.js (the notification Service Worker, served by the host at /dnotify/sw.js)
│                 # icons: dsh-dark.{png,ico} (white fish / dark themes), dsh-light.{png,ico} (black fish / light themes),
│                 #        dsh.{png,ico} kept as legacy-path copies
├── locale/       # settings-page strings (zh / en)
├── scripts/      # syntax self-check check-syntax.mjs, test entry run-tests.mjs
│                 # smoke tests winrt-probe.mjs, theme-probe.mjs, contract self-check dsh-runtime-probe.mjs
│                 # icon generator make-icon.py (development-time only, needs Python)
├── tests/        # node --test unit tests (protocol / registry / activation / host event-flow integration
│                 #                / browser half / focus gate / public API / D-Bus marshalling / theme decisions
│                 #                / icon resolution / bounded containers / text truncation / handle invariants)
├── docs/         # architecture, how-it-works, getting-started, verification matrix, TS6→TS7 migration notes
├── cordis.patch.yml
└── package.json
```

> Verification: every push runs Linux CI (syntax / unit tests / TS→lib consistency / theme / manifest); before a release the Windows and Linux smoke checks are run on real machines — see [docs/verification.md](docs/verification.md).
>
> Build: `npm run build` (three configs: `tsconfig.json` for the strict core, `tsconfig.platform.json` for the platform layer, `tsconfig.client.json` for the browser half, compiled as a script). `npm test` builds first. Migration notes live in [docs/migration-ts6-ts7.md](docs/migration-ts6-ts7.md).

## How it works & limitations

### Delivery channels (mixed backend, decided at send time)

```
notification produced
 ├─ an online DSH page exists and has notification permission → Web Notification
 │    page → Service Worker → showNotification()
 │    click = notificationclick → clients.matchAll() → WindowClient.focus()
 │      · a DSH window exists → the browser itself hands that tab back (exact, no title guessing)
 │      · no window            → clients.openWindow(<DSH deep link>) opens DSH directly (no intermediate page)
 │    traits: no landing page, no UIA/accessibility, no PowerShell, instant focus
 └─ otherwise → native toast (Windows WinRT / Linux D-Bus)
       click → opens the DSH deep link in a new tab; the active mode only shows up in the startup report body
       (with `launchMode: 'protocol'` the click uses custom-protocol activation instead and opens no tab — see "Other options")
```

- **The Service Worker ships with the plugin** (`assets/dnotify-sw.js`, served by the host at `/dnotify/sw.js` with `Service-Worker-Allowed: /`). It is **not a browser extension** and needs no installation.
- **Notifications belong to the Service Worker**: once registered, clicking still works after every DSH tab is closed (it opens a new one when no window matches) — that is expected behaviour. It does require the browser to still be running.
- **Producing** a notification needs a page online (a local process cannot wake the SW without Web Push, which this plugin does not use), so with no page the plugin falls back to a native toast; both routes end in "you can see it and click it".
- **Delivery receipt for browser notifications**: after handing the content to the page the plugin waits briefly for a display receipt; without one, or when the SW reports an error, it falls back to a native toast — a duplicate is better than a silent loss.
- **The source line (app name + icon) belongs to the process that raises the notification**: Web Notification shows the browser's identity (Firefox etc.) and cannot be changed; only a native toast shows the AUMID brand name (**DeepSeek Harness**) and the plugin icon. You cannot have both.
- **Fallback detection**: the page's reported `Notification.permission` is not `granted`, or the content could not be pushed to the page. Permission changes are reported **immediately** through the page-side Permissions API `onchange` (with a report on every focus as backstop), so toggling it in site settings takes effect at once and raises the "⚠️ DSH 权限变更" notice.

### Focus gating (per session, event-driven, zero polling)

The browser half (`lib/client.js`) reports over the plugin's own `/dnotify/page-focus` route whether the page is focused **and which session it currently has selected** (the session "retained by the main view" in the harness client `sessions` snapshot — the same probe official ui-layout/ui-session use; a session switch re-reports immediately). Focused means `visibilityState === 'visible' && document.hasFocus()`, driven by native `focus`/`blur`/`visibilitychange`/`pagehide` events (page close is reliably reported via `keepalive`); user activity on the focused page (keyboard/mouse/scroll, throttled to 10 s) keeps it "fresh".

The host aggregates per page × session (`lib/gate.js`):

> **Silenced ⇔ a focused page exists and the session it currently has selected matches the notification's session list.**

- Switching to another window/tab or minimising **restores pushing immediately**; with no focused page nothing is ever silenced.
- **Notifications without a session** (for example the startup report) are **never silenced**.
- A focused page with no activity for 2 minutes counts as unfocused, and page entries that stopped reporting are pruned after 10 minutes.

### Delivery layer (native, in-process)

- **Windows (`lib/winrt.js`)**: drives WinRT through koffi (`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId('DSH')` → `XmlDocument.LoadXml` → `Show`), with no Python helper and no subprocess; before the first toast it idempotently writes `HKCU\SOFTWARE\Classes\AppUserModelId\DSH` (`DisplayName = DeepSeek Harness` + `IconUri`, rewritten with the theme).
- **Linux (`lib/toast-linux.js`)**: speaks the D-Bus wire protocol in pure JS (`$DBUS_SESSION_BUS_ADDRESS` or `/run/user/<uid>/bus`, SASL EXTERNAL → `Hello` → `org.freedesktop.Notifications.Notify`) with no `notify-send`; the connection is kept and reused, reconnecting after a drop. `app_name` is likewise **DeepSeek Harness**, with the theme-appropriate icon.
- Both platforms share one send queue: 200 ms spacing, a failed send is re-queued once, at most 32 items.

### Theme and icons

Notification backgrounds follow the system light/dark scheme while icons are never inverted, so the package ships two transparent-background sets (`dsh-dark.*` white fish / `dsh-light.*` black fish). `lib/theme.js` reads once at startup and then follows switch events: on **Windows** it reads `HKCU\...\Themes\Personalize\SystemUsesLightTheme` (falling back to `AppsUseLightTheme`) and uses `RegNotifyChangeKeyValue` plus a 2 s non-blocking handle check; on **Linux** it reads xdg-desktop-portal's `org.freedesktop.appearance/color-scheme` and subscribes to the same interface's `SettingChanged` signal (environment heuristics when no portal exists). Both channels carry a 60 s fallback re-read.

### Click targets

- **Session notifications** → `session:<session id>`, switched in place through the public `ctx.get('uiWorkspace').openSession(id)`.
- **Subagents and jobs** → the click always targets the **main session** (the host walks `header.parentSession` up to the top), while the subagent's own name appears in the body. **This is separate from silencing**, which uses the session the event belongs to.
- **The startup report** → `page:settings-plugins`: the client clicks the sidebar's **real settings entry** (accessible name "设置", including the desktop "account menu → settings" path), then the "内置插件" navigation tile inside the settings dialog, verifying it actually landed; it retries for up to 10 s because a freshly opened deep-link page may take a few seconds to mount. It **never** falls back to the sidebar Plugins panel — a wrong landing spot is worse than none.
- A `{ type: 'url' }` target is unrelated to DSH pages and is handed straight to the system/browser.
- With an online page, clicking creates **no new window**: the target is pushed to that page over `/dnotify/events` and applied in place; only when no page can take it does the plugin open the `#dsh-notify=<target>` deep link.
- Compatibility: the legacy `url` field (http/https) means `{ type: 'url' }`, and older `#dsh-notify=<target>` deep links and `/dnotify/click?target=<target>` URLs still work.

### Other notes

- **Startup report (once per start)**: after `apply`, the plugin waits for the composition to settle and then counts the plugin rows in `ctx.get('loader')` — ACTIVE fibers count as loaded, while FAILED / missing fiber / still waiting for services are reported by `entry.options.id`; explicitly `disabled` rows are ignored. It **waits for an online page with notification permission** before sending (5 s by default, then falls back to a native toast) so the report can use the browser route. The once-per-process flag lives on `globalThis`, so a reload does not re-announce.
- **Message cache**: only the latest assistant-reply summary (≤220 chars) is cached per session, released as soon as the task-done notification consumes it; every per-session/per-id cache is **bounded** (128 summaries, 64 approval pairs, 32 ask-timestamps — oldest evicted), so a resident host does not grow with the number of sessions; the same text from the same source within 1.5 s pops only once (the dedupe key is title + body + source id + session), so two identically-named jobs and two parallel sessions each get their own toast.
- **Approval notices under `never`**: the `approval/request` waterfall is not dispatched under the `never` policy, so the plugin reads the `approval/asked`/`approval/decided` audit pair from the session log instead. Keep the approval policy `never` to receive these notices.
- **Depends on the platform notification backend**: Windows Toast via WinRT, Linux via the desktop session's D-Bus notification service. Windows **Focus Assist** / do-not-disturb, Linux do-not-disturb switches, and the browser's own "quiet notifications" can all swallow a notification (such suppression is invisible to the plugin — `showNotification()` still "succeeds").
- **Platforms**: Windows is tested in practice (Windows 11 + Firefox); Linux speaks D-Bus directly (Kubuntu/KDE, Ubuntu/GNOME and other desktop sessions — a plain SSH session with no desktop bus gets no notifications) and its marshalling is unit-tested; a macOS backend is not implemented yet (the plugin loads and logs a single "no backend" notice).
- **Debug log**: off by default; turn on **debug mode** in the settings page (equivalent to `config: { debug: true }` on the `desktop-notify` row in the profile's `cordis.patch.yml`). Status logs are then **written to a file instead of the terminal**:
  `$DSH_HOME/logs/dsh-desktop-notify/dsh-desktop-notify.log` (rotated above 1 MB, five files kept; `$DSH_HOME` defaults to `~/.dsh`). The same file also captures the cordis logs of this plugin's fiber. **Error** logs are not gated by this switch and still go straight to the terminal. Beyond logs, the `/dnotify/status` fields above are the better tool for after-the-fact checks.
- **Other options** (written on the `desktop-notify` row in the profile's `cordis.patch.yml`; they are not in the settings page): `launchMode: 'browser' | 'protocol'` for native-toast clicks (default `browser`: the toast carries the browser landing page, which always reaches the host at the cost of a leftover landing tab; `protocol` uses the custom scheme and opens no tab), `startupWaitMs` (how long the startup report waits for a page, default 5000) and `claimWaitMs` (how long a delivery waits to be claimed, default 1500). Except for `launchMode`, which is read when the plugin loads (changing it needs a `dsh web` restart), these are read each time they are used.

## License

**GNU General Public License v3.0 or later (GPL-3.0-or-later)** — full text in [LICENSE](LICENSE); copyright and credit: **© 2026 沐云 (Mvyvn) &lt;mvyvn@qq.com&gt; and contributors** (see `author` / `contributors` in `package.json`).

- **You may**: use, copy, distribute and modify it freely, **including commercially** (internal company use, shipping it with a product, or running a paid service).
- **You must**: ① **attribute** — whether you redistribute the original or a modified version, you must **keep the author credit and copyright notice** (the line above, plus `author` / `contributors` in `package.json`); do not remove them or replace them with your own name; ② **stay open** — when you distribute a modified version, you must publish the complete corresponding source under the same license and state your changes.
- No warranty (see GPL sections 15 and 16).

> This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but **without any warranty**, without even the implied warranty of merchantability or fitness for a particular purpose.

