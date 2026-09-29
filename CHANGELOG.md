# Changelog

## [1.6.3] - 2026-09-30

- **转发器无条件留痕**：只要 Windows 调用了协议处理器，就往 `%TEMP%\dsh-notify-activate.log` 写一行 `invoked <uri>`。用于把"点击根本没触发协议"与"触发了但后续失败"分开——这是排查"点了没反应"的第一现场。
- **`config.launchMode`**：`'protocol'`（默认，自定义协议，不新开标签）| `'browser'`（Toast 直接带浏览器落地页）。后者会在通知中心留一个标签页，但**一定能到达宿主**；协议激活在某些环境下不触发时用它兜底。
- `/dnotify/status` 增加 `launchMode` 与 `recentSent`（最近 12 条通知的标题 + 点击目标 + 实际 launch），可以直接回答"我刚才点的那条到底可不可点击"。
- 通知本身没有点击目标时（`click` 缺省）会记一条日志，避免"这条点了没反应"被当成 bug。
- 测试：143 项全绿。

## [1.6.2] - 2026-09-30

- **"投出去了"不再等于"跳了"**：`res.write()` 成功只说明数据交给了 socket，浏览器可能没收到（重连中/标签页冻结/旧客户端）。现在投递后会**等页面认领**（默认 1.5s，`config.claimWaitMs` 可调）：等到了才算 `delivered`；没等到就**退化成新开 DSH 深链**，绝不静默失败。浏览器落地页同理（没认领就 302）。
- **激活器不再吞异常**：转发器的 `catch` 现在会写一行日志到 `%TEMP%\dsh-notify-activate.log`，并退回浏览器落地页——以前任何一步出错的表现都是"点了没反应"。
- **客户端不再按 targetPageId 预过滤**：过滤掉就变成静默失败；归属由宿主在 `/claim` 裁决，被拒时重报身份自愈。
- **新增只读诊断端点 `/dnotify/status?t=<令牌>`**：返回页面注册表（pageId/聚焦/连接数/seq）、待认领、最近一次激活与认领、当前流——排查"点了没反应"时用它分清"没投出去 / 投了没认领 / 认领了没跳"。
- 测试：143 项全绿（新增"投了没人认领 → 改走新开"与"诊断端点"）。

## [1.6.1] - 2026-09-30

- **点击后页面没到前台 → 看起来像"点了没反应"**。两条都补上：
  - 转发器在 `delivered`（已有页面收到跳转）时用 `AppActivate` 把带 DSH 标签的浏览器窗口带到前台（无需编译 C#，约 0.2s；优先标题含 dsh/deepseek/harness 的窗口，只有一个浏览器窗口时用它，不确定就不动、不抢焦点）。`config.focusWindow: false` 可关。
  - 页面侧在认领成功后先 `window.focus()` 再落 UI（浏览器可能忽略，忽略无害）。
- 说明：重启**之前**产生的旧通知带的是 http 落地页（兼容兜底），点它会新开一个标签页；重启后新产生的通知走 `dsh-notify:` 协议，不再新开标签。
- 测试：141 项全绿；真机链路（注册表 → 隐藏转发器 → `/dnotify/activate` → 定向投递 → 页面内打开设置）复验通过，浏览器页数保持 1。

## [1.6.0] - 2026-09-30

**点击跳转重做为"先决策、再决定要不要开窗口"**（三态互斥且可证明：无目标不跳转 / 有页面只让该页面跳转 / 无页面才新开 DSH）。为此引入 TypeScript 6 类型化核心与配套状态机。

- **点击目标改为显式四态**（`click`）：`none`（不传即此项）/ `session` / `page` / `url`。`sessionId` 只用于聚焦门控，不再隐式生成跳转链接——旧版"留空"根本表达不出"不要跳转"。旧字段 `url`（http/https）仍兼容。
- **每条点击有身份**：`openId` 精确认领 + **归属校验**（非目标页面拿到 id 也认领不了），删除"广播后谁先 claim 谁赢"。
- **页面注册表**（`src/pages.ts`）：`{pageId, seq, focused, sessionId, 连接数}`；只接受更大的 `seq`（focus/blur 乱序不覆盖新状态，失焦清除"当前聚焦"但保留"最后用过"）；连接数用计数而非布尔（刷新时新旧连接任意先后都不会误判离线）。选页：此刻聚焦 → 最后聚焦且在线 → 都没有就新开。
- **Windows 不再经过浏览器**：Toast 用 `dsh-notify:` 自定义协议，插件启动时把 `HKCU\Software\Classes\dsh-notify` 指向本进程的 `/dnotify/activate`；隐藏 PowerShell 一跳只负责"问宿主该怎么做"，只有宿主回答 `open` 才真正打开地址 → **有页面时点击零新窗口**。可配 `clickProtocol: false` 关掉。
- **Linux 在宿主进程内决策**：`ActionInvoked` → 宿主决策 → 需要时才调 portal `OpenURI`。
- **删除 `location.reload()` 兜底**：`openSession()` 抛错时明确失败并记日志，不再"原地刷新但不跳转"（旧版 reload 前 hash 已被清掉）。
- **新端点** `GET /dnotify/activate?raw=<目标>`：返回 `{action:'delivered'|'open'|'ignore', url?}`，由平台侧执行唯一需要开窗口的动作。
- **DSH 兼容**：声明 `peerDependencies: { "@deepseek-ai/dsh": ">=0.1.7-rc.2 <0.3.0" }`（`peerDependenciesMeta.optional` 挡住 npm 自动安装整棵 DSH 依赖树；DSH 自己的兼容性预检只看 `peerDependencies`）。已实测 DSH **0.2.0-rc.2**：核心服务包（connection / webserver / jobs / subagent / scope / loader / cordis）两版之间零改动；适配其 web 端设置快捷键改为 **primary+alt+Comma**。
- **TypeScript 6 基线**：`src/**/*.ts`（strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `erasableSyntaxOnly`，TS7 就绪）编译到 `lib/`；`npm run build`，`npm test` 自动先构建。迁移进度见 `docs/migration-ts6-ts7.md`。
- 测试：141 项全绿（新增协议、注册表、激活决策、三态点击、归属校验、seq 乱序、激活端点等用例；真机验证含"有已打开页面 → 页面内跳转且零新窗口"）。

## [1.5.4] - 2026-09-25

- **修复点击跳转的三处结构性问题**（都表现为"偶发点了没反应 / 跳错页面"）：
  1. **认领没有身份**：SSE 事件里明明带了 target，客户端却丢掉它、再由 `/claim` 去读全局"最新一条"。连点两条通知会串单（A 的 claim 认领到 B）。现在每次点击生成唯一 `openId`，`/claim` 按 `openId` 精确认领，重复认领返回 `{ok:false, reason:'stale'}`。
  2. **"先到先得"被当成"正在用的页面"**：原先广播给所有页面、谁先抢到 claim 谁执行——后台标签页完全可能先到。现在 `GET /dnotify/events?pageId=<id>` 让每条连接自报身份，宿主记住**最后一次上报聚焦的页面**，点击只定向推给它；只有它不在线时才退回广播（仍按 openId 先到先得）。
  3. **没有已打开的 DSH 页面时点击必然空转**：SSE 没有订阅者时落地页只显示一行字。现在 `/dnotify/click` 直接 **302 到 `/#dsh-notify=<目标>`**，由浏览器拉起 DSH、页面启动后走 `handleHashTarget()` 完成跳转；该条待认领记录同时作废，避免稍后连上的页面重放（跳两遍）。
- 顺带：`openEventStream()` 不再在 apply 里重复调用（只由 `ctx.effect` 建立、卸载时关闭）；`switchSession()` 旁注明 DSH 0.1.7-rc.2 的 `openSession()` 是**同步 void**，故"不抛错"即成功信号。
- 测试：新增「连点两条不串单」「只推给最后一次聚焦的页面」「无页面时 302 且不重放」「点击后新连上的页面收到完整信封」「客户端认领带 openId」；全套 124 项。

## [1.5.3] - 2026-09-25

- **修复：点之前发出的通知得到 `forbidden`**。点击令牌原先在每次 `apply` 时重新生成，而热更新/替换插件文件都会重跑 `apply`——已经躺在通知中心里的通知（带旧令牌）因此一律被 403 拒掉。现在：
  - 令牌放 `globalThis`，**同一进程内跨 re-apply 复用**；
  - `/dnotify/click` 只拦**真正的跨站触发**（`Sec-Fetch-Site: cross-site` → 403），其余情况即使令牌过期（上一次运行发的旧通知）也照常跳转——目标本身另有白名单约束，"点到旧通知"是正常用户行为；
  - 目标非法时落地页显示「这条通知的目标已失效」，不再是一句 `forbidden`。
- 测试：新增「旧令牌非跨站放行」「同一进程跨 apply 令牌一致」，并把跨站拒绝改成显式用例；全套 120 项。

## [1.5.2] - 2026-09-25

- **新增启动播报**：每次 `dsh web` 启动后推一条通知——`插件启动成功:共有 N 个插件成功加载`；有插件没激活时改为 `有 N 个插件启动失败:加载失败的插件为 …`。数的是 `loader` 里的插件行（ACTIVE 算成功，FAILED / 没有 fiber / 等不来服务都算没起来并列出 `entry.options.id`，主动 `disabled` 不计入），每次启动只推一次。
- **新增点击跳转**：点击通知打开 `http://127.0.0.1:<端口>/dnotify/click?t=<进程令牌>&target=<目标>`（只记录目标的落地页，浏览器会新开一个标签页）；已打开的 DSH 页面通过 SSE（`/dnotify/events`）收到目标，再用 `/dnotify/claim` **先到先得**认领，多页面并存时只切一个、切的是你正在用的那个页面。Windows 用 `activationType="protocol"`（不需要注册 COM 激活器），Linux 走 xdg-desktop-portal `OpenURI`（不起子进程）。
  - 目标：会话通知 → `session:<id>`（`uiWorkspace.openSession`，子代理会话进子代理界面、后台任务回主会话）；启动播报 → `page:settings-plugins`（合成 ⌘/Ctrl+, 开「设置」再点「内置插件」，打不开则退回插件面板）；旧式 `#dsh-notify=` 深链兼容。
  - 对外 API：`push`/`pushAlways`/`notify` 载荷新增 `url`（只接受 http/https）；只给 `sessionId` 时宿主自动生成会话链接。
- **修复：聚焦上报与会话级静默从未生效**。DSH 0.1.7-rc.2 的 `connection.rpc.handle` 把 owner 解析成连接服务的影子 fiber，随后要 `owner.webServer.register(route)`（`rpc-host.ts:86-93/171-195`）——那条 fiber 链上读不到 `webServer`，cordis 抛 `cannot get property "webServer" without inject`，通道静默没注册（前端只看到 405）。改为插件自带 `/dnotify` 前缀路由（`ctx.webServer.register` + `connection.admit` 信任栅栏，纯 JSON POST）。
- **插件简介**改为「DSH桌面通知」（原先一长串中英混排说明显示不下）；Toast XML 组装抽到 `lib/toast-xml.js`（转义/协议激活有纯函数单测）。
- 两个已踩过的坑记在这里：① `ctx.timeout/ctx.effect` 返回 `Disposable<Promise<void>>`（可调用 + thenable，**没有 `.catch`**），在它上面调 `.catch` 会让整条路由 500——SSE 心跳改用自管 `setInterval`（自终止 + `unref`）；② BroadcastChannel 在同源同文档之间也会投递，靠它"交接给别的页面"会把跳转判给自己，所以投递改由宿主仲裁。
- 测试：宿主 32 项 + 浏览器 14 项，全套 118 项；`theme-probe` / `dsh-runtime-probe` 真机契约自检通过。

## [1.4.0] - 2026-09-25

- **适配 DSH 0.1.7-rc.2**：`jobs` 服务面在 0.1.7-alpha.1 被合并成一条事件流（`onJobDone`/`JobSnapshot` 已移除），改用 `jobs.events.subscribe({ owners: 'all' })` 的 `settled` 事件——`owner` 现在是 SessionId、`reported` 由 `awaited` 取代（已被等待方收走的结算不重复打扰），正文按 status 区分「已完成/失败/被终止」；`connection.rpc.handle` 回到两参签名并返回 `{ ok: true, value }` / `{ ok: false, error: { code, message, details } }`；删掉 `dsh.client.inject` 里并不存在的 `@deepseek-ai/dsh-client-runtime` 与对应 `peerDependencies`（声明了也不生效）。
- **修复会话级静默完全失效**：客户端会话快照（`SessionListState`）里**没有** `current` 字段，浏览器半区改读 `byId[*].retainedBy.mainView > 0`（官方 ui-layout / ui-session / ui-open-in-app 用的同一判据）；上报改走官方 `ctx.get('connection').rpc.call`（载体可能不是 fetch），只有 `pagehide` 那一次用 raw fetch（要 `keepalive`）且改文档相对路径；会话订阅改用 `ctx.inject` 等服务就绪；新增 1 分钟聚焦心跳，避免「盯着屏幕读两分钟没碰鼠标」被保鲜超时误判为失焦而误弹。
- **新增深浅两套通知图标 + 系统主题跟踪**：通知背景跟随系统深浅色，而图标不会被反色——随包新增 `assets/dsh-light.{png,ico}`（黑鱼，浅色主题用）与 `assets/dsh-dark.{png,ico}`（白鱼），发送时按当前主题选一套（旧路径 `dsh.{png,ico}` 保留为深色版本副本）。Windows 读 `HKCU\...\Themes\Personalize\SystemUsesLightTheme`（退 `AppsUseLightTheme`），用 `RegNotifyChangeKeyValue` 异步事件 + 2 秒非阻塞句柄检查跟踪切换；Linux 读 xdg-desktop-portal 的 `OrgFreedesktopAppearance/color-scheme` 并订阅 `SettingChanged` 信号；两条通道都挂 60 秒兜底重读，读不到时保持原值（绝不把「读不到」当成浅色）。主题变化时同步改写 AUMID 图标，通知中心的应用图标一起换色。
- **Linux D-Bus 层重写**：抽出 `lib/dbus.js`（常驻会话总线：SASL EXTERNAL → **Hello** 注册 → 方法调用与回复按 serial 配对 → `AddMatch` 信号订阅 → 断线重连/冷却/错误去重），通知发送与主题跟踪共用一条连接；补齐总线强制的 `Hello` 握手（没有它连信号订阅都做不了），并修正 `method_return` 里 `REPLY_SERIAL`/`UNIX_FDS` 被当字符串解码导致回复整体错位的问题。
- **修复与加固**：`fs.resolve` 是异步的，默认工作区名原先恒为空串（多工作区回退场景前缀丢失）；`agents.roots()` 拿不到或为空时不再把「任务完成」通知整类静默丢掉（退回会话谱系判断）；按会话/按 id 的缓存全部改为有界容器（回复摘要 64 / 审批配对 64 / 提问时刻 32，超出淘汰最旧），常驻进程不再随会话数增长；同文案 1.5 秒内只弹一次；待发队列上限 32 条；`desktopNotify` 服务重复注册不再让整个插件挂掉；热更新时「新 apply 先跑、旧 cleanup 后跑」不会把新的主题监听停掉。
- **对外 API 语义修正**：`push()` 原先只要载荷有效就返回 `true`（被静默时也是 `true`），现在只有**真的入队**才返回 `true`，并新增 `notify(item)` 返回 `{ ok, queued, silenced, reason }` 明细（`reason`: `''` / `invalid-payload` / `silenced` / `duplicate` / `dropped`）。
- **自检工具**：`scripts/check-syntax.mjs`（自动枚举 `lib/*.js` 逐个 `node --check`）、`scripts/theme-probe.mjs`（主题检查 + 切换事件链路自检，用临时注册表键，不碰系统主题）、`scripts/dsh-runtime-probe.mjs`（把宿主半区挂进 DSH 自带的 cordis 跑注入/作用域事件/延迟注册/注销清理的契约自检，不发真实通知）；`scripts/make-icon.py` 一次生成深浅两套图标。

## [1.3.12] - 2026-09-11

- **新增 Linux 支持**：`lib/toast-linux.js` 用纯 JS 直说 D-Bus 协议（`$DBUS_SESSION_BUS_ADDRESS` 或 `/run/user/<uid>/bus`，SASL EXTERNAL 握手 → `org.freedesktop.Notifications.Notify`），不调用 `notify-send`、不新增依赖；连接常驻复用、断开自动重连，编组逻辑有单测（`npm test`）。`lib/index.js` 按平台动态加载发送层——win32 之外不再 import koffi。
- **新增对外推送 API**：插件注册 Cordis 服务 `desktopNotify`，其它插件 `ctx.get('desktopNotify')` 即可推送——`push(item)` 走聚焦门控（按会话），`pushAlways(item)` 绕过门控始终弹；载荷 `{ title, message?, urgency?, sessionId? }`，标题为空不推送。逻辑在 `lib/api.js` 并有单测（`npm test`）。
- **聚焦门控改为按会话**：浏览器半区上报"页面聚焦状态 + 该页面当前选中的会话"（客户端 `sessions` 服务的 `list.current`，切换会话即时重报），宿主按"页面 × 会话"判定——**只静默你正在看的那个会话**，看会话 A 时会话 B 完成照样弹；拿不到会话归属的通知（例如 owner 已清理的后台任务）一律推送。门控逻辑抽到 `lib/gate.js` 并有单测（`npm test`）。
- **发送层重写为进程内原生直连**：Windows 用 `koffi` 直调 WinRT 发 Toast（`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId` → `XmlDocument.LoadXml` → `Show`），彻底移除 Python 助手、`desktop-notifier` 依赖与 stdin 子进程协议——单条发送是几次进程内 vtable 调用，无冷启动、无进程重建逻辑。
- AUMID 图标改为插件自己维护：首次发送前幂等写入 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH`（`DisplayName` + `IconUri`，经 advapi32 直调），不再需要快捷方式与 Python 注册脚本；`scripts/register-aumid.py` 已删除。
- 安装脚本更新：`scripts/install.ps1` 移除 Python 前置，改为**真实探测** `koffi` 能否 `require`（原先按 `build/` 目录判断会把装好的 koffi 误报为缺失），离线回退会连 `@koromix/koffi-<平台>-<架构>` 一起拷贝；登记项写入包的真实版本号；补 UTF-8 BOM 以免 PowerShell 5.1 下中文乱码。`scripts/install.sh` 面向 Linux（D-Bus 原生通知）。
- `scripts/winrt-probe.mjs` 改为调用 `lib/winrt.js` 的正式代码路径（注册 AUMID + 发一条真实 Toast），作为合并/安装前的冒烟测试。
- **一轮独立审查后的加固**：`jobs` 钩子改用 `ctx.inject` 延迟注册（服务晚挂载也不会让「后台任务结束」通知永久静默）；D-Bus 连接加 15s 超时与失败冷却、错误去重（挂死的总线不再让通知静默堆积）；审批配对缓存加上限 64（孤儿条目不无界增长）；文本截断不再切断 emoji 等代理对（新增 `lib/text.js`）；AUMID 注册失败允许 1 分钟后重试；WinRT 接口引用按 COM 规则释放（常驻宿主不再每条泄漏对象）；客户端重复加载不再重复挂监听；抽象总线地址失败时给出替代方案提示。

## [1.0.0] - 2026-08-29

- 首个正式版本：随 `dsh web` 自动加载的桌面通知插件（免审批 bundle 形态）。
- 通知类别：
  - ✅ 任务完成（`agent/status` running→idle，仅根 agent，3 秒去抖，会话标题 + 回复摘要）
  - ❓ 等待你回答（`tools/execute` 捕获 `ask_user_question` 派发）
  - 🚫 审批被自动拒绝（`session/event` 流 `approval/asked`+`decided` 审计对）
  - 🤖 后台子任务结束（`subagent/end`）
  - 🎯 目标完成 / 阻塞（`goal/changed`）
  - 🧰 后台任务结束（jobs `onJobDone`）
- 防打扰：浏览器半区经 Connection RPC 通道 `/dnotify` 上报页面可见性，仅页面不可见时弹（30 秒心跳 + `visibilitychange` 即时上报，页面关闭 90 秒后视为不可见）。
- 通知由一次性 Python 进程 + `desktop-notifier`（Windows Toast）发送；700ms 队列间隔防轰炸；提问后 15 秒内抑制「任务完成」避免双重打扰。
- 修复：`ctx.connection.rpc.handle` 补第三参 `{ authority: 'loopback' }`（dsh-client-connection rc 新增必填 `options.authority`，缺失会导致插件树加载失败）。
