# 工作原理

## 双半区架构

```
┌─────────────────────────── Browser（页面）───────────────────────────┐
│ 原生事件（零轮询）→ 上报 {focused, pageId, sessionId, permission}      │
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
│  POST /dnotify/page-focus                                            │
│    focused=true  → gate/pages.set(pageId, {at, sessionId})           │
│    focused=false → gate.clearPage(pageId)                            │
│                                                                      │
│  ctx.on('agent/status')        ──┐                                   │
│  ctx.on('session/event')       ──┤  去抖/去重/文案组装                │
│  ctx.on('tools/execute')       ──┼──► notify(title, message, urgency, │
│  ctx.on('subagent/end')        ──┤             会话归属, click)       │
│  ctx.on('goal/changed')        ──┤        │ 门控 lib/gate.js：        │
│  jobs.events 'settled' 订阅    ──┘        │ 聚焦页面选中该会话 → 静默  │
│                                           │ 会话归属不明 → 照常推送    │
│                             队列（≤32 条，200ms 间隔，失败单次重排队） │
│                                     ▼                               │
│              主题：theme.js 读深/浅色 + 跟踪切换事件 → 选图标          │
│              分流：有在线页面且权限 granted → SSE 推给页面 → SW 显示   │
│                    否则 → 发送层 winrt.js（Windows / koffi 直调 WinRT）│
│                           toast-linux.js（Linux / D-Bus 直连会话总线）│
└──────────────────────────────────────┬───────────────────────────────┘
                                       ▼
                      系统通知（Windows Toast / Linux 桌面通知）
```

## 聚焦门控（按会话）

- 浏览器半区（`lib/client.js`）以 `document.hasFocus()` + `visibilityState === 'visible'` 判定聚焦，由 `focus`/`blur`/`visibilitychange`/`pagehide` **原生事件即时触发**（无轮询定时器）；聚焦页面的用户活动（键盘/鼠标/滚动，10s 节流）持续"保鲜"，另有 **1 分钟聚焦心跳**（只在聚焦时打点，失焦/隐藏即停）——否则"盯着屏幕读两分钟、没碰鼠标"会超出宿主 2 分钟的保鲜期而被误判失焦，本该静默的提醒照弹。
- **会话归属**：同一次上报还带 `sessionId` = 该页面**当前选中的会话**，取客户端快照里"被主视图保留"的那个（`byId[*].retainedBy.mainView > 0`，与官方 ui-layout / ui-session 同一判据）；`sessions.list.subscribe()` 让"切换会话"即时重报（不必等下一次聚焦事件）。服务未就绪或取不到时上报 `null`（宿主按"归属不明"处理：照常推送）。
- **上报通道**：插件自带的 `POST /dnotify/page-focus`（纯 JSON POST，同源 fetch 自带 cookie；`pagehide` 那一次用 `keepalive` 保证送达），URL 用文档相对形式（挂载在子路径下也正确）。
- **判定（`lib/gate.js`，纯逻辑 + 单测 `tests/gate.test.mjs`）**：`silenced = 存在聚焦且未超 2 分钟的页面，且该页面选中的会话 ∈ 通知所属会话`。于是"我在看会话 A，会话 B 完成"照常弹；**通知拿不到会话归属时（例如 owner 已清理的后台任务）一律不静默**。
- 子代理结束通知的会话归属 = 主会话 + 子会话：正在看其中任一个都不打扰。
- **残留清理**：页面异常关闭或浏览器退出导致失焦上报丢失时，条目残留；10 分钟无上报的条目自动移除（崩溃兜底）。
- **乱序保护**：每次上报带单调序号，宿主只接受更新的那条——"切走又切回"这种快速切换不会因为上报乱序而留下过期的聚焦状态。

## 各通知钩子

| 通知 | 钩子 | 触发点 | 正文格式 |
| --- | --- | --- | --- |
| ✅ 任务完成 | `agent/status` | 根 agent `running→idle`，3 秒去抖 | `工作区/会话名:结尾输出内容` |
| ❓ 等待你回答 | `tools/execute` | `ask_user_question` 派发瞬间 | `工作区/会话名:[类型] 内容` |
| 🚫 审批被自动拒绝 | `session/event` | `approval/asked` + `approval/decided` 审计对 | `工作区/会话名:工具名-拒绝原因` |
| 🤖 后台子代理结束 | `subagent/end` | 子代理收敛 | `工作区/主会话名:子代理名已完成` |
| 🎯 目标完成 / 阻塞 | `goal/changed` | `complete` / `block` | `工作区/会话名:目标-已完成 / 目标-阻塞原因` |
| 🧰 后台任务结束 | `jobs.events` 的 `settled` | 任务结算（**`awaited` 也通知**；`kind='subagent'` 由上一行负责） | `工作区/主会话名:后台任务名已完成/失败/被终止` |
| 🕒 / ✅ 团队任务 | `session/event` 的 `team/task` | 只对状态变化发（`in_progress`/`deleted` 不打扰） | `工作区/会话名:任务标题` |
| 🗜️ 上下文已智能压缩 | `session/event` 的 `compaction/end` | 压缩结束（带 `error` 的不报） | `工作区/会话名:上下文已智能压缩` |
| ⏰ 定时任务已启动 | Cordis 事件 `schedule/changed` | 读 `catalog()` 比对投递记录，`lastDelivery` 变化才算触发 | `工作区/会话名:定时任务标题` |
| 🚀 插件挂载成功 / ⚠️ 插件挂载异常 | `loader` 的插件行状态 | 每次启动一次（等组合稳定 + 等一个有权限的在线页面，最多 5 秒） | `共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：正常/降级` / `存在 N 个插件运行异常：a、b` |
| ⚠️ DSH 权限变更 | 页面上报的通知权限 | 状态**发生迁移**时（首次得知只记基线） | `dsh-desktop-notify 跟踪到消息提醒权限变更为:xxx，插件运行模式同步变更为正常/降级（浏览器通知不可用）` |

- 前缀的**工作区按会话动态解析**（会话 `header.cwd` 的目录名；取不到用启动目录，多工作区并行时各显示自己的工作区）；会话名取 `sessionTitle` 服务。
- 子代理/后台任务的主会话沿 `session.header.parentSession` 一路回溯到**顶层**（多层子代理也回到真正的母会话），点击目标与前缀都用母会话。
- 每条通知同时把**会话归属**交给门控（见上节）：任务完成/提问/审批/目标用各自 `agent.session`/`session`；子代理用 `[主会话, 子会话]`；后台任务用 `job.owner`，取不到则不静默。
- 后台任务的 `awaited === true`（有调用方在等这次结算）**也通知**："你正看着这个会话"这种打扰由聚焦门控判断，钩子层不猜。
- 静默范围分三档：子代理用 `[主会话, 子会话]`；后台任务用 `[所属会话, 其所属子代理的主会话]`；**定时任务/压缩/目标/提问/审批被拒只看该会话本身**（你正看着它的子代理或母会话时也会推送）。点击目标与静默判定是两件事：点击固定指母会话。
- `kind === 'subagent'` 的 job 不在这里报：后台一次性子代理同时会走 `subagent/end`，两边都报就是两条 toast。
- 根 agent 判定优先问 `agents.roots()`；服务缺失或此刻根列表为空时退回会话谱系（`header.origin === 'subagent'` / `delegationDepth`），不会因为"拿不到 roots"就把任务完成通知全部丢掉。
- 任务完成通知按"该会话有没有产出过内容"决定发不发（不按正文是否非空）：最后一轮只有工具调用时退化成"任务已完成"，而不是整条丢掉。

## 启动播报

- 触发：插件 `apply` 之后等组合稳定（`ctx.get('loader').await()`，与 app-boot 的启动审计同一原语）再数一遍 `ctx.get('loader').entries()`。
- 判定：`fiber.state === 2`（ACTIVE）算加载成功；`3`（FAILED）、没有 fiber、等不来服务（PENDING/LOADING）都算"没加载起来"并列出 `entry.options.id`；`entry.disabled` 的行不计入。
- 只推一次：进程级标记放 `globalThis`（插件热重载重新 apply 也不会重播）；没有 `loader` 服务（非 profile 组合）就跳过。
- **等一个有通知权限的在线页面再发**（默认最多 5 秒，超时降级为原生 Toast）：启动瞬间页面通常还没连上来，不等就只能走降级；而这条通知恰好是"点一下跳到设置→内置插件"的入口。运行模式在**发送那一刻**判定，并且只有这条播报的正文附带模式说明。
- 正文格式：成功 `共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：正常/降级`，失败 `存在 N 个插件运行异常：a、b，dsh-desktop-notify 运行模式：…`。

## 通知渠道与点击跳转（混合 backend）

发送时按"有没有可用的在线页面"分流，两条路的点击都由**拥有该能力的一方**处理：

```
产生通知
 ├─ 有在线 DSH 页面，且其通知权限为 granted → Web Notification
 │    页面收到 SSE 的 notify 事件 → 交给 Service Worker → showNotification()
 │    点击 = notificationclick → clients.matchAll({type:'window',includeUncontrolled:true})
 │      · 命中 DSH 窗口 → WindowClient.focus()：由**浏览器自己**把那个标签页交还给用户
 │      · 没有窗口      → clients.openWindow(<DSH 深链>)：直接开 DSH，不经中转页
 └─ 其余情况 → 原生 Toast（Windows WinRT / Linux D-Bus）
       点击 → GET /dnotify/click → **302 到 DSH 深链**（新标签页）
```

1. Service Worker 是**插件自带的**（`assets/dnotify-sw.js`，宿主经 `/dnotify/sw.js` 提供，带 `Service-Worker-Allowed: /`），不是浏览器扩展、无需安装。页面注册后上报自己的 `pageId`，SW 维护 `pageId → clientId` 映射（写入 IndexedDB，SW 被浏览器回收后依然可用）。
2. **点击不需要页面在**：通知属于 SW（注册一次后浏览器一直记得），所以即使所有 DSH 标签页都关了，点击仍由 SW 接管；找不到窗口就开新的。注意它依赖浏览器仍在运行。
3. **通知的产生需要页面在线**：本地无法唤醒 SW（除非引入 Web Push，本项目不做）。所以无页面时走原生 Toast —— 两条路的结果都是"看得见、点得跳"。
4. **显示回执与兜底**：内容交给页面后，宿主等一个很短的显示回执（SW 报 `shown`）；超时或收到 `show-error` 时改用原生 Toast —— 宁可重复一条，也不静默丢掉。
5. **来源行由发通知的进程决定**：Web Notification 显示浏览器身份（Firefox 等），无法修改；只有原生 Toast 显示 AUMID 品牌名（**DeepSeek Harness**）与插件图标。二者不可兼得，默认走 Web Notification。
6. **权限引导**：浏览器要求用户手势才弹授权框，因此页面显示一次性卡片「开启桌面通知」；权限状态随每次聚焦上报同步给宿主，因此手动在站点设置里授权也会被立刻识别。
7. **降级判定**：`lastRoute.reason` 会写清原因（`no-online-page` / `permission-not-granted` / `deliver-failed` / `no-shown-ack` / `show-error`）。`/dnotify/click` 一律 302 到 DSH 深链（`#dsh-notify=<目标>`），客户端解析后清掉 hash，避免刷新重复触发。
8. 客户端执行目标：
   - `session:<id>` → `ctx.get('uiWorkspace').openSession(id)`（与点侧栏会话行同一条链路）；服务未就绪就重试；会话不在客户端目录里（同步抛错）则只记一行日志放弃。子代理会话由 ui-workspace 自己的规则解析成**子代理界面**；子代理/后台任务通知的目标是它的**主会话**。
   - `page:settings-plugins` → 先点侧边栏**真实设置入口**（可访问名「设置」；桌面端走「账号菜单 → 设置」），再在设置对话框（`role="dialog"` + 可访问名「设置」）里按**可访问名**点「内置插件」导航格并验证已就位（`aria-current`）；打不开就重试（深链场景下界面可能几秒后才挂载，最多 10 秒）。**不会**退到侧栏「插件」页——落点错了就是错。
   - `page:plugins` → `ctx.get('pluginNavigation').openBundle('@mvyvn/dsh-desktop-notify')`（退路 `layout.selectPanel('plugins')`）。

> 跳转结果会回报给宿主（`/dnotify/navigated`）：认领成功 ≠ 跳转成功，`not-found` 表示目标会话已不在客户端目录里，这是"点了却没跳"唯一的诊断痕迹。

## 与宿主的通信：自带的 /dnotify 路由

浏览器半区不使用 DSH 的 `connection.rpc.handle`，而是走插件自己注册的 `/dnotify` 前缀路由（`ctx.webServer.register`；`webServer` 因此写在插件 `inject` 里）。这样协议的每个字段都由插件自己定义，也能把"点击通知"的投递通道一起做进同一条路由。

| 端点 | 方法 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `/dnotify/page-focus` | POST | `admit()` | 页面聚焦状态 + 当前选中会话 + 通知权限（会话级门控与渠道分流的输入） |
| `/dnotify/events` | GET | `admit()` | SSE：把 `notify`（通知内容）/`navigate`（跳转）推给已打开的页面（25s 心跳保活） |
| `/dnotify/claim` | POST | `admit()` | 认领跳转（带 `openId`，并校验页面归属——不是"谁先抢到"） |
| `/dnotify/navigated` | POST | `admit()` | 客户端回报跳转终态（`done` / `not-found`） |
| `/dnotify/sw/report` | POST | `admit()` | SW 与页面上报：`register` / `shown` / `click` / `focused` / `show-error` / `show-request` 等 |
| `/dnotify/sw.js` | GET | **无**（静态资源） | 提供通知用 Service Worker（注册 SW 的请求不带页面鉴权头） |
| `/dnotify/click` | GET | 进程令牌 `t=` | 浏览器/系统打开的点击落地页：校验后 302 到 DSH 深链 |
| `/dnotify/activate` | GET | 进程令牌 `t=`（**必须匹配**） | 本机转发器与 Linux 后端的激活端点：宿主决策后返回 `{action: 'delivered'\|'open'\|'ignore'}` |
| `/dnotify/status` | GET | 进程令牌 `t=`（**必须匹配**） | 令牌保护的诊断快照 |
| `/dnotify/poc-notify` | GET | `admit()` | 开发期触发器：让在线页面弹一条通知，用于验证 SW 链路 |

除静态资源 `/sw.js` 外都先过 `ctx.connection.admit(req)`（DSH 自己的 Host/Origin 栅栏 + 浏览器鉴权）：没有页面 cookie 的请求得到 401，不会误触发状态。

两个令牌端点语义不同：`/activate` 由本机进程调用，所以**必须**带当前进程令牌（错令牌一律 403）；`/click` 是用户点击旧通知的顶层导航（可能带着上一次运行发出的令牌），因此只拦**真正的跨站触发**（`Sec-Fetch-Site: cross-site`），令牌不匹配时按用户导航放行、但**只允许站内目标**——外部地址必须令牌匹配，避免 loopback 端点变成开放重定向。

## 为什么审批被拒走 `session/event` 而不是 `approval/request`

`dsh-user-approval` 的 `decide()` 在 `never` 政策下直接返回 `'rejected'`，**不会派发** `approval/request` waterfall。但每次询问/裁决都会在会话日志落审计事件 `approval/asked` + `approval/decided`。因此插件监听 `session/event`（post-commit 追加流）读取这对审计事件——`never` 政策下每条被拒操作都会产生一条完整记录。

## 发送层（进程内原生直连）

- **Windows（`lib/winrt.js`，koffi）**：`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId('DSH')`（notifier 进程内缓存复用）→ `XmlDocument` 激活 → `LoadXml` → `ToastNotification` → `Show`。
  - 不用旧 `Statics.CreateToastNotifier(appId)`：本机返回 `0x80070490`，必须走 `ForUser` 变体；
  - WinRT 字符串参数一律 HSTRING（`WindowsCreateString`），不是 LPCWSTR；
  - 首次发送前幂等写入 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH`（`DisplayName` + `IconUri`），供通知中心显示"程序应用图标"；写失败只影响图标，不影响 Toast，且失败后 1 分钟会再试一次（成功则永久缓存）；
  - 无 Python、无子进程、无冷启动；拿到的接口引用用完即 `Release`，常驻宿主不会每发一条就漏一个对象。
- **Linux（`lib/toast-linux.js` + `lib/dbus.js`，纯 JS D-Bus）**：直连会话总线（`$DBUS_SESSION_BUS_ADDRESS`，缺省 `/run/user/<uid>/bus`）——
  - 地址解析支持 `unix:path=`（首选）；`unix:abstract=` 也认，但 Node/libuv 用 C 字符串长度定位 Unix 套接字，抽象命名空间地址会直接 `EINVAL`，此时日志会明确提示改用文件路径形式；
  - 认证：写入 NUL 字节后发 `AUTH EXTERNAL <uid 十进制字符串的十六进制>`，收到 `OK <guid>` 再发 `BEGIN`（被拒时退回 `AUTH ANONYMOUS` 一次）；
  - **`BEGIN` 之后必须先发 `Hello`**（总线强制：客户端注册前发别的消息会被拒/被断），拿到唯一名之后才发应用消息；未 Hello 完成前消息排队；
  - 发送：自实现的编组器产出小端 `method_call`（header fields：PATH/INTERFACE/MEMBER/DESTINATION/SIGNATURE，body 签名 `susssasa{sv}i`）后写 socket；`hints` 里**始终带一条 urgency**（0/1/2），避开"空 `a{sv}` 的元素对齐在实现间有分歧"这个坑；
  - 解码器覆盖 `y b n q i u x t d s o g v a(){}`，按 serial 与 `method_return`/`error` 配对（超时 5s），并按 interface/member 路由信号（`AddMatch` 在连接重建后自动重发）——通知发送与主题跟踪因此共用一条常驻连接；
  - 连接常驻复用、断开即重连；未连上时最多缓存 32 条待发；连接/握手有 15 秒超时（半开的总线不会让通知永远堆在待发里），失败后 30 秒内不再重连且同一原因只打一条错误日志；入站缓冲上限 1 MiB；通知被拒（`ERROR` 回复且没有等待者）走 `console.error`，不打断宿主；
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

插件在 `apply` 里用 `ctx.provide('desktopNotify', api)` 暴露服务（实现在 `lib/api.js`）：

| 成员 | 说明 |
| --- | --- |
| `apiVersion` | 基线协议版本，当前 **`1.0.0`** |
| `capabilities` | 能力清单，供调用方探测（只增不减）：`push` / `pushAlways` / `notify` / `click.session` / `click.page` / `click.url` / `click.legacy-url` / `web-notification` / `dialog.four-state` |
| `push(item)` | 走聚焦门控（按会话），返回是否**真的入队** |
| `pushAlways(item)` | 绕过门控与去重窗口，始终弹 |
| `notify(item)` | 同 `push`，但返回 `{ ok, queued, silenced, reason, apiVersion, unsupportedVersion }` |

载荷 `{ title, message?, urgency?, sessionId?, click?, v? }`；标题为空 → `ok: false, reason: 'invalid-payload'` 且不推送。`push`/`pushAlways` 返回 `true` 表示**真的入队了**：被静默、命中同文案去重、没有平台后端时都是 `false`（`reason` 分别为 `silenced` / `duplicate` / `dropped`）。`sessionId` 决定会话级门控归属（不传则 `push` 也始终推送），可传会话对象、id 或它们的数组；`click` 只决定点击行为（见项目 README 的四态表）。载荷里未知字段一律忽略，声明更高的主版本不会中断推送，只在结果里回带 `unsupportedVersion: true`。

入队后与内置通知共用同一队列（200ms 间隔，上限 32 条）。设置页的**对外 API** 开关关闭后，`apiVersion` / `capabilities` 仍可读（便于探测），但推送一律不入队、`notify()` 返回 `reason: 'api-disabled'`。

## 消息缓存

所有按会话/按 id 的缓存都走 `lib/state.js` 的**有界容器**：超出上限先丢最旧的，常驻宿主不随会话数增长。

- `lastTextBySession`：仅缓存"最近一条助手回复摘要"（≤220 字符，最多 128 条），任务完成通知**消费即释放**（推送或被门控静默丢弃都释放），下次回复自动重建；
- `askAtBySession`：提问时刻（15 秒内抑制任务完成通知，最多 32 条）；
- `asksById`：审批配对（最多 64 条），`decided` 后即删；孤儿条目（会话被中断、始终没等到裁决）由上限兜底淘汰；重启后全部自动初始化；
- 去重器：**同来源同文案** 1.5 秒内只弹一次（最多记 64 条 key）。去重键 = 标题 + 正文 + 来源标识（`job.id` / approval id / `runId` / 目标 revision）+ **会话归属**，所以"两个同名后台任务在同一秒内结算""两个并行会话弹出同前缀同结尾的提醒"都各弹各的，而被重复派发的同一个事件不会连弹。

## 调试开关

`config.debug`（默认 `false`）：关闭时**状态**日志（notify 决策 / 聚焦上报 / fire / job settled / 主题等）不输出。开启方式：设置页的「调试模式」开关，或等价地在 profile 层 `cordis.patch.yml` 覆盖 `desktop-notify` 行：

```yaml
- id: desktop-notify
  config: { debug: true }
```

开启后状态日志写入 `$DSH_HOME/logs/dsh-desktop-notify/dsh-desktop-notify.log`（>1MB 轮转、保留 5 份），不再刷终端；同一个文件也接住本插件 fiber 上的 cordis 日志。**错误**日志不受这个开关限制：发送失败、D-Bus 连接/认证错误、主题切换事件注册失败、钩子异常、无通知后端提示都照常打印到 stderr。

## 版本适配

插件声明的兼容范围是 **`>= 0.1.7-rc.2` 且 `<= 0.2.0-rc.2`**（见 `package.json` 的 `peerDependencies`）。升级 DSH 后建议先跑 `node scripts/dsh-runtime-probe.mjs`（把宿主半区挂进 DSH 自带的 cordis 里验证注入/作用域事件/延迟注册/注销清理，不发真实通知），它能第一时间发现契约漂移。

0.1.3 → 0.1.7 之间与本插件相关的契约变化：

| 变更 | 影响 | 现做法 |
| --- | --- | --- |
| `jobs.onJobDone` / `JobSnapshot` 被合并成一条事件流（0.1.7-alpha.1 起） | 「后台任务结束」通知会静默失效 | 改用 `jobs.events.subscribe({ owners: 'all' }, …)`，只处理 `settled`，字段 `job.owner`（SessionId）/`job.status`，`awaited` 等价于旧 `reported` |
| `connection.rpc.handle` 的第三个参数 `{ authority }` 被移除，且返回体要求 `{ ok: true, value }` / `{ ok: false, error }` | 旧的第 3 参被静默忽略；`{ ok: true }` 能过宿主但对官方客户端解码器不合法 | 插件不再使用该通道，改用自己的 `/dnotify` 路由 |
| 客户端会话快照不再有 `current` 字段 | 浏览器半区永远上报 `sessionId: null`，会话级静默完全失效 | 改读 `byId[*].retainedBy.mainView > 0` |
| `dsh.client.inject` 里写的 `@deepseek-ai/dsh-client-runtime` 这个包不存在 | 声明了也不生效（静默跳过），且 peerDependencies 是假的 | 删掉该字段与对应 peer 依赖（插件不静态依赖任何客户端包） |
| `AgentStatus` 只有 `'idle' \| 'running'`；`goal/changed` 的 `change.goal`、`blockedReason { code, message }`；审批 `outcome = 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` | 与实现一致，无需改动 | 已核对并在 `tests/host.test.mjs` 里按真实契约断言 |
