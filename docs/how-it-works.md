# 工作原理

## 双半区架构

```
┌─────────────────────────── Browser（页面）───────────────────────────┐
│ 原生事件（零轮询）→ 上报 {focused, pageId, sessionId}                  │
│   focus / blur ─────────► 窗口/标签聚焦切换（即时）                    │
│   visibilitychange ─────► 标签隐藏/切走/最小化（兜底）                 │
│   pagehide ─────────────► 页面卸载前强制上报失焦（keepalive 送达）     │
│   keydown/mousedown/     │                                           │
│   pointermove/scroll ───► 用户活动（节流 10s）聚焦"保鲜"              │
│   1 分钟心跳 ───────────► 聚焦但静止时续期（不被保鲜超时误判）          │
│   sessions.list 订阅 ───► 切换会话即时重报当前会话 id                  │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌─────────────────────────── Host（Node 进程）─────────────────────────┐
│  ctx.connection.rpc.handle('/dnotify')                               │
│    focused=true  → pages.set(pageId, {at, sessionId})                │
│    focused=false → pages.delete(pageId)                              │
│                                                                      │
│  ctx.on('agent/status')        ──┐                                   │
│  ctx.on('session/event')       ──┤  去抖/去重/文案组装                │
│  ctx.on('tools/execute')       ──┼──► notify(title, message, urgency, │
│  ctx.on('subagent/end')        ──┤             会话归属)              │
│  ctx.on('goal/changed')        ──┤        │ 门控 lib/gate.js：        │
│  jobs.events 'settled' 订阅    ──┘        │ 聚焦页面选中该会话 → 静默  │
│                                           │ 会话归属不明 → 照常推送    │
│                             队列（≤32 条，200ms 间隔，失败单次重排队） │
│                                     ▼                               │
│              主题：theme.js 读深/浅色 + 跟踪切换事件 → 选图标          │
│                   发送层：winrt.js（Windows / koffi 直调 WinRT）      │
│                           toast-linux.js（Linux / D-Bus 直连会话总线）│
└──────────────────────────────────────┬───────────────────────────────┘
                                       ▼
                      系统通知（Windows Toast / Linux 桌面通知）
```

## 聚焦门控（按会话）

- 浏览器半区（`lib/client.js`）以 `document.hasFocus()` + `visibilityState === 'visible'` 判定聚焦，由 `focus`/`blur`/`visibilitychange`/`pagehide` **原生事件即时触发**（无轮询定时器）；聚焦页面的用户活动（键盘/鼠标/滚动，10s 节流）持续"保鲜"，另有 **1 分钟聚焦心跳**（只在聚焦时打点，失焦/隐藏即停）——否则"盯着屏幕读两分钟、没碰鼠标"会超出宿主 2 分钟的保鲜期而被误判失焦，本该静默的提醒照弹。
- ⚠️ 事件监听必须用显式包装（`() => report()`）：DOM 监听器会把 Event 对象作为第一参数传入，若直接绑 `report(force)`，`!!Event === true` 会把失焦事件误报为聚焦（曾为此引入的回归 Bug）。
- **会话归属**：同一次上报还带 `sessionId` = 该页面**当前选中的会话**。0.1.7 的客户端快照（`SessionListState`）里没有 `current`，选中态的表达是"被主视图保留"：`byId[*].retainedBy.mainView > 0`（官方 ui-layout / ui-session / ui-open-in-app 用的都是这个判据）；`sessions.list.subscribe()` 让"切换会话"即时重报（不必等下一次聚焦事件）。服务未就绪或取不到时上报 `null`。
- **上报通道**：优先用官方连接服务 `ctx.get('connection').rpc.call('/dnotify', 'page-focus', payload)`（载体可能不是 fetch，自己发包会绕过它）；只有 `pagehide` 那一次用手写 `fetch`（要 `keepalive` 保证送达），URL 用文档相对形式 `dnotify/page-focus`（挂载在子路径下也正确）。
- **判定（`lib/gate.js`，纯逻辑 + 单测 `tests/gate.test.mjs`）**：`silenced = 存在聚焦且未超 2 分钟的页面，且该页面选中的会话 ∈ 通知所属会话`。于是"我在看会话 A，会话 B 完成"照常弹；**通知拿不到会话归属时（例如 owner 已清理的后台任务）一律不静默**。
- 子代理结束通知的会话归属 = 主会话 + 子会话：正在看其中任一个都不打扰。
- **残留清理**：页面异常关闭或浏览器退出导致失焦上报丢失时，条目残留；10 分钟无上报的条目自动移除（崩溃兜底）。

## 各通知钩子

| 通知 | 钩子 | 触发点 | 正文格式 |
| --- | --- | --- | --- |
| ✅ 任务完成 | `agent/status` | 根 agent `running→idle`，3 秒去抖 | `工作区/会话名:结尾输出内容` |
| ❓ 等待你回答 | `tools/execute` | `ask_user_question` 派发瞬间 | `工作区/会话名:[类型] 内容` |
| 🚫 审批被自动拒绝 | `session/event` | `approval/decided` 且 `outcome==='rejected'` | `工作区/会话名:工具名-拒绝原因` |
| 🤖 后台子代理结束 | `subagent/end` | 子代理收敛 | `工作区/主会话名:子代理名已完成` |
| 🎯 目标完成 / 阻塞 | `goal/changed` | `complete` / `block` | `工作区/会话名:目标-已完成 / 目标-阻塞原因` |
| 🧰 后台任务结束 | `jobs.events` 的 `settled` | 任务结算且 `awaited === false`（`kind='subagent'` 由上一行负责） | `工作区/会话名:后台任务名已完成/失败/被终止` |
| 🚀 启动播报 | `loader` 的插件行状态 | 每次启动一次（等组合稳定后） | `插件启动成功:共有 N 个插件成功加载` / `有 N 个插件启动失败:加载失败的插件为 a、b` |

- 前缀的**工作区按会话动态解析**（会话 `header.cwd` 的目录名；取不到用启动目录，多工作区并行时各显示自己的工作区）；会话名取 `sessionTitle` 服务。
- 子代理/后台任务的主会话经 `session.header.parentSession` 回溯。
- 每条通知同时把**会话归属**交给门控（见上节）：任务完成/提问/审批/目标用各自 `agent.session`/`session`；子代理用 `[主会话, 子会话]`；后台任务用 `job.owner`（0.1.7 起是 SessionId），取不到则不静默。
- 后台任务的 `awaited === true`（有调用方在等这次结算、结果已交给它）不通知——对应 0.1.6 及更早版本的 `snapshot.reported`。
- `kind === 'subagent'` 的 job 不在这里报：后台一次性子代理同时会走 `subagent/end`（`tool-subagent` 用 `jobs.start({ kind: 'subagent' })` 注册），两边都报就是两条 toast。
- 根 agent 判定优先问 `agents.roots()`；服务缺失或此刻根列表为空时退回会话谱系（`header.origin === 'subagent'` / `delegationDepth`），避免"拿不到 roots 就把所有任务完成通知静默丢掉"。
- 任务完成通知按"该会话有没有产出过内容"决定发不发（不按正文是否非空）：最后一轮只有工具调用时退化成"任务已完成"，而不是整条丢掉。

## 启动播报

- 触发：插件 `apply` 之后等组合稳定（`ctx.get('loader').await()`，与 app-boot 的启动审计同一原语）再数一遍 `ctx.get('loader').entries()`。
- 判定：`fiber.state === 2`（ACTIVE）算加载成功；`3`（FAILED）、没有 fiber、等不来服务（PENDING/LOADING）都算"没加载起来"并列出 `entry.options.id`；`entry.disabled` 的行不计入。
- 只推一次：进程级标记放 `globalThis`（模块被 HMR 重新求值也不会重播）；没有 `loader` 服务（非 profile 组合）就跳过。
- 正文按用户要的格式：成功 `插件启动成功:共有 N 个插件成功加载`，失败 `有 N 个插件启动失败:加载失败的插件为 a、b`。

## 点击跳转

1. 宿主按当前通知的会话归属生成目标（`session:<id>`），启动播报用 `page:settings-plugins`；地址取自 `webServer` 服务的 `host:port`（退路 `DSH_WEB_URL`），拼成
   `http://127.0.0.1:<port>/dnotify/click?t=<进程令牌>&target=<目标>`。令牌每次进程随机生成，防止任意网页靠 `<img>` 之类盲触发跳转。
   > 1.6.1 曾注册 `dsh-notify:` 自定义协议 + 隐藏 PowerShell 一跳来避免"点击新开标签页"；
   > 用户判定该做法低效（每次点击起一个进程），1.6.2 已按要求移除：统一走这个 http 落地页，
   > **接受浏览器新开一个标签页**——那是系统打开 URL 的固有行为，浏览器也拒绝脚本关闭它。
2. 发送层落地：
   - **Windows**：Toast XML 加 `activationType="protocol"` + `launch=URL`，点击由系统交给浏览器打开（不需要注册 COM 激活器）；没有 URL 的 Toast 保持普通形态。
   - **Linux**：`actions` 加 `default` 动作，等 `Notify` 回复拿到通知 id 并记下 id→URL；收到 `ActionInvoked` 后用 xdg-desktop-portal `OpenURI` 打开（无子进程）。
3. 点击落地页（`/dnotify/click`）不是 DSH 页面，只做两件事：校验令牌并把目标存成"待认领"，返回一行提示并尝试 `window.close()`（浏览器通常拒绝脚本关闭系统打开的标签，于是它停在那行提示上）。
4. 已打开的 DSH 页面通过 SSE（`/dnotify/events`）立刻收到目标 → `POST /dnotify/claim` 认领 → **先到先得，宿主只放行一个页面**（认领即清空），所以多页面并存时只切一个，切的是"你已经在用的那个页面"（新开的落地标签页不参与跳转）。
5. 客户端执行目标：
   - `session:<id>` → `ctx.get('uiWorkspace').openSession(id)`（与点侧栏会话行同一条链路）；服务未就绪就重试；会话不在客户端目录里（同步抛错）则退回"写 `dsh.sessions.current` + 整页刷新"。子代理会话由 ui-workspace 自己的规则解析成**子代理界面**；后台任务通知的目标就是它的**主会话**。
   - `page:settings-plugins` → 合成 ⌘/Ctrl+, 打开「设置」，再点弹窗里的「内置插件」导航格；两条路（快捷键、账号菜单）都不行就退回**插件面板**。
   - `page:plugins` → `ctx.get('pluginNavigation').openBundle('dsh-desktop-notify')`（退路 `layout.selectPanel('plugins')`）。
6. 旧的 `#dsh-notify=<目标>` hash 形式仍兼容：解析后立刻 `history.replaceState` 清掉，避免刷新重复触发。

> ⚠️ SSE 心跳别碰 cordis 定时器的返回值：`ctx.timeout/ctx.effect` 返回的是
> `Disposable<Promise<void>>`（`fiber.ts:64-74`：**可调用 + thenable，没有 `.catch`**）。
> 1.6.1 在它上面调了 `.catch`，结果 SSE 一建立就抛 `keepAlive.catch is not a function`，
> 整条 `/dnotify` 请求失败、跳转全挂。现在心跳用自管的 `setInterval`（自终止 + `unref`）。

## 与宿主的通信：自带的 /dnotify 路由

浏览器半区不再用 DSH 的 `connection.rpc.handle`——0.1.7-rc.2 里 `rpc` 取值器把 owner 解析成服务注册 ctx 的**影子 fiber**（`service.ts` 的 `symbols.shadow`），随后 `handle` 内部要 `owner.webServer.register(route)`（`rpc-host.ts:86-93/171-195`）：实测那条 fiber 链上读不到 `webServer`，cordis 注入守卫直接抛 `cannot get property "webServer" without inject`——把 `webServer` 写进插件 inject 也没用（查的不是本插件的 fiber），于是路由静默没挂上，前端只看到 405/404。DSH 自己的生产代码只用 `rpc.intercept`（不碰 webServer），`handle` 实际只在测试里用。

于是插件自带一个 `/dnotify` 前缀路由（`ctx.webServer.register`；`webServer` 必须写在插件 `inject` 里）：

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/dnotify/page-focus` | POST | 页面聚焦状态 + 当前选中会话（会话级门控的输入） |
| `/dnotify/events` | GET | SSE：把待处理的跳转推给已打开的页面（25s 心跳注释保活） |
| `/dnotify/claim` | POST | 认领跳转，先到先得（返回 `{ ok, target }`） |
| `/dnotify/click` | GET | 通知点击落地页（进程令牌校验；记录目标 + 自关） |

除 `/click` 外都先过 `ctx.connection.admit(req)`（DSH 自己的 Host/Origin 栅栏 + 浏览器鉴权）：没有页面 cookie 的请求得到 401，不会误触发状态。`/click` 用进程令牌校验——它是系统/浏览器直接打开的顶层导航（没有 Origin，也不该要求 cookie）。

## 为什么审批被拒走 `session/event` 而不是 `approval/request`

`dsh-user-approval` 的 `decide()` 在 `never` 政策下直接返回 `'rejected'`，**不会派发** `approval/request` waterfall。但每次询问/裁决都会在会话日志落审计事件 `approval/asked` + `approval/decided`。因此插件监听 `session/event`（post-commit 追加流）读取这对审计事件——`never` 政策下每条被拒操作都会产生一条完整记录。

## 发送层（进程内原生直连）

- **Windows（`lib/winrt.js`，koffi）**：`ToastNotificationManager` 工厂 → 槽 6 `GetDefault()` → `ToastNotificationManagerForUser` → 槽 7 `CreateToastNotifierWithId('DSH')`（notifier 进程内缓存复用）→ `XmlDocument` 激活 → QI `IXmlDocumentIO` → 槽 6 `LoadXml(HSTRING)` → `ToastNotification` 工厂 → 槽 6 `CreateInstance` → `IToastNotifier` 槽 6 `Show`。
  - 不用旧 `Statics.CreateToastNotifier(appId)`：本机（Windows 11 26100）返回 `0x80070490`，必须走 `ForUser` 变体；
  - WinRT 字符串参数一律 HSTRING（`WindowsCreateString`），不是 LPCWSTR；
  - 首次发送前幂等写入 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH`（`DisplayName` + `IconUri`，advapi32 直调），供通知中心显示"程序应用图标"；写失败只影响图标，不影响 Toast，且失败后 1 分钟会再试一次（成功则永久缓存）；
  - 无 Python、无子进程、无冷启动：单条发送是纯进程内几次 vtable 调用；`RoActivateInstance` / `RoGetActivationFactory` / `QI` 拿到的接口引用都在用完后 `Release`（notifier 进程内缓存复用），避免常驻宿主每发一条就漏一个对象。
- **Linux（`lib/toast-linux.js` + `lib/dbus.js`，纯 JS D-Bus）**：直连会话总线（`$DBUS_SESSION_BUS_ADDRESS`，缺省 `/run/user/<uid>/bus`）——
  - 地址解析支持 `unix:path=`（首选）；`unix:abstract=` 也认，但 Node/libuv 用 C 字符串长度定位 Unix 套接字，抽象命名空间地址实测会直接 `EINVAL`，此时日志会明确提示改用文件路径形式；
  - 认证：写入 NUL 字节后发 `AUTH EXTERNAL <uid 十进制字符串的十六进制>`，收到 `OK <guid>` 再发 `BEGIN`（被拒时退回 `AUTH ANONYMOUS` 一次）；
  - **`BEGIN` 之后必须先发 `Hello`**（总线强制：客户端注册前发别的消息会被拒/被断），拿到唯一名之后才发应用消息；未 Hello 完成前消息排队；
  - 发送：自实现的编组器产出小端 `method_call`（header fields：PATH/INTERFACE/MEMBER/DESTINATION/SIGNATURE，body 签名 `susssasa{sv}i`）后写 socket；`hints` 里**始终带一条 urgency**（0/1/2），刻意避开"空 `a{sv}` 的元素对齐在实现间有分歧"这个坑；
  - 解码器覆盖 `y b n q i u x t d s o g v a(){}`，按 serial 与 `method_return`/`error` 配对（超时 5s），并按 interface/member 路由信号（`AddMatch` 在连接重建后自动重发）——通知发送与主题跟踪因此共用一条常驻连接；
  - 连接常驻复用、断开即重连；未连上时最多缓存 32 条待发；连接/握手有 15 秒超时（半开的总线不会让通知永远堆在待发里），失败后 30 秒内不再重连且同一原因只打一条错误日志；入站缓冲上限 1 MiB；通知被拒（`ERROR` 回复，且没有等待者）走 `console.error`，不打断宿主；
  - 不起 `notify-send` 子进程；编组/解码平台无关，由 `tests/dbus.test.mjs` 做往返校验。
- 队列 200ms 间隔防轰炸，上限 32 条（超出丢最旧）；发送抛错时单次重排队；同来源同文案 1.5 秒内只发一条。

## 主题与图标选择

- 通知背景色跟随系统深浅色，而图标**不会被反色**：白图标放在浅色通知背景上等于看不见。所以随包带两套透明底 PNG/ICO（`assets/dsh-dark.*` 白鱼、`assets/dsh-light.*` 黑鱼），发送时按 `lib/theme.js` 的当前值挑一套。
- **模式检查**：Windows 读 `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\SystemUsesLightTheme`（1=浅色；缺失退 `AppsUseLightTheme`，都没有则保持默认深色）。Linux 读 xdg-desktop-portal 的 `org.freedesktop.appearance/color-scheme`（0=无偏好/1=深色/2=浅色），无 portal 时退 `GTK_THEME` 后缀启发式。
- **切换事件跟踪**：Windows 用 `RegNotifyChangeKeyValue(..., hEvent, 异步)` 注册"键值被改写"通知，之后每 2 秒做一次 `WaitForSingleObject(hEvent, 0)`（纯句柄检查，不读注册表、不占线程），触发后重读主题并重新注册（该注册是一次性的）。Linux 订阅同接口的 `SettingChanged(namespace, key, value)` 信号，值里带结论时直接采用，否则回读一次。
- 两条通道都可能不可用（Windows 策略拦注册表通知、Linux 没有 portal），所以 `lib/theme.js` 另有 **60 秒兜底重读**；读失败时保持上一次结果，**绝不把"读不到"当成浅色**（否则暗色用户的通知图标会突然变成黑鱼看不见）。
- 主题变化时 Windows 侧还会改写 AUMID 的 `IconUri`，让通知中心里"程序应用图标"同步换色。
- 自检：`node scripts/theme-probe.mjs` 打印当前主题与两套图标路径，并用一个临时注册表键验证"变更事件 → 回调"整条链路（不碰系统主题）。

## 对外推送 API（供其它插件）

插件在 `apply` 里用 `ctx.provide('desktopNotify', api)` 暴露三个方法（实现在 `lib/api.js`）：

| 方法 | 门控 | 用途 |
| --- | --- | --- |
| `push(item)` | 走聚焦门控（按会话） | 与内置 6 类通知同待遇：你看的那个会话静默，其它照常弹 |
| `pushAlways(item)` | 绕过门控 | 无论聚焦与否都弹（紧急提醒） |
| `notify(item)` | 走聚焦门控 | 同 `push`，但返回 `{ ok, queued, silenced, reason }` 明细 |

载荷 `{ title, message?, urgency?, sessionId? }`；标题为空 → `ok: false, reason: 'invalid-payload'` 且不推送。`push`/`pushAlways` 返回 `true` 表示**真的入队了**：被静默、命中同文案去重、没有平台后端时都是 `false`（`reason` 分别为 `silenced` / `duplicate` / `dropped`）。`sessionId` 决定会话级门控归属（不传则 `push` 也始终推送）。入队后与内置通知共用同一队列（200ms 间隔，上限 32 条）。

## 消息缓存

所有按会话/按 id 的缓存都走 `lib/state.js` 的**有界容器**：超出上限先丢最旧的，常驻宿主不随会话数增长。

- `lastTextBySession`：仅缓存"最近一条助手回复摘要"（≤220 字符，最多 64 条），任务完成通知**消费即释放**（推送或被门控静默丢弃都释放），下次回复自动重建；
- `askAtBySession`：提问时刻（15 秒内抑制任务完成通知，最多 32 条）；
- `asksById`：审批配对（最多 64 条），`decided` 后即删；孤儿条目（会话被中断、始终没等到裁决）由上限兜底淘汰；重启后全部自动初始化；
- 去重器：**同来源同文案** 1.5 秒内只弹一次（最多记 64 条 key）。去重键 = 标题 + 正文 + 来源标识（`job.id` / approval id / `runId` / 目标 revision）+ **会话归属**，所以"两个同名后台任务在同一秒内结算""两个并行会话弹出同前缀同结尾的提醒"都各弹各的，而被重复派发的同一个事件不会连弹。

## 调试开关

`config.debug`（默认 `false`）：关闭时终端不输出 `[dsh-desktop-notify]` **状态**日志（notify 决策 / 聚焦上报 / fire / job settled / 主题等）。排查时在 profile 层 `cordis.patch.yml` 覆盖 `desktop-notify` 行：

```yaml
- id: desktop-notify
  config: { debug: true }
```

**错误**日志不受这个开关限制：发送失败、D-Bus 连接/认证错误、主题切换事件注册失败、钩子异常、无通知后端提示都照常打印到 stderr。

## 版本适配

当前适配 **DSH 0.1.7-rc.2**。升级 DSH 后建议先跑 `node scripts/dsh-runtime-probe.mjs`（把宿主半区挂进 DSH 自带的 cordis 里验证注入/作用域事件/延迟注册/注销清理，不发真实通知），它能第一时间发现契约漂移。

0.1.3 → 0.1.7 之间与本插件相关的契约变化：

| 变更 | 影响 | 现做法 |
| --- | --- | --- |
| `jobs.onJobDone` / `JobSnapshot` 被合并成一条事件流（0.1.7-alpha.1 起） | 「后台任务结束」通知会静默失效（旧代码的 `typeof onJobDone !== 'function'` 守卫只是不报错） | 改用 `jobs.events.subscribe({ owners: 'all' }, …)`，只处理 `settled`，字段 `job.owner`（SessionId）/`job.status`，`awaited` 等价于旧 `reported` |
| `connection.rpc.handle` 的第三个参数 `{ authority }` 早在 0.1.2 就已移除，且返回体要求 `{ ok: true, value }` / `{ ok: false, error }` | 旧的第 3 参被静默忽略；`{ ok: true }` 能过宿主但对官方客户端解码器不合法 | 两参调用，返回 `{ ok: true, value: { pages } }` / `{ ok: false, error: { code, message, details } }` |
| 客户端会话快照不再有 `current` 字段 | 浏览器半区永远上报 `sessionId: null`，会话级静默完全失效 | 改读 `byId[*].retainedBy.mainView > 0` |
| `dsh.client.inject` 里写的 `@deepseek-ai/dsh-client-runtime` 这个包不存在 | 声明了也不生效（静默跳过），且 peerDependencies 是假的 | 删掉该字段与对应 peer 依赖（插件不静态依赖任何客户端包） |
| `AgentStatus` 只有 `'idle' \| 'running'`；`goal/changed` 的 `change.goal`、`blockedReason { code, message }`；审批 `outcome = 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` | 与旧实现一致，无需改动 | 已核对并在 `tests/host.test.mjs` 里按真实契约断言 |
