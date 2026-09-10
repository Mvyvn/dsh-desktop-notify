# Changelog

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
