# 工作原理

## 双半区架构

```
┌─────────────────────────── Browser（页面）───────────────────────────┐
│ 原生事件（零轮询）→ POST /dnotify/page-focus                          │
│                      {focused, pageId, sessionId}                    │
│   focus / blur ─────────► 窗口/标签聚焦切换（即时）                    │
│   visibilitychange ─────► 标签隐藏/切走/最小化（兜底）                 │
│   pagehide ─────────────► 页面卸载前强制上报失焦（keepalive 送达）     │
│   keydown/mousedown/     │                                           │
│   pointermove/scroll ───► 用户活动（节流 10s）聚焦"保鲜"              │
│   sessions.list 订阅 ───► 切换会话即时重报当前会话 id                  │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌─────────────────────────── Host（Node 进程）─────────────────────────┐
│  ctx.connection.rpc.handle('/dnotify')                               │
│    focused=true  → pages.set(pageId, {at, sessionId})                │
│    focused=false → pages.delete(pageId)                              │
│                                                                      │
│  ctx.on('agent/status')      ──┐                                     │
│  ctx.on('session/event')     ──┤  去抖/合并/文案组装                  │
│  ctx.on('tools/execute')     ──┼──► notify(title, message, urgency,   │
│  ctx.on('subagent/end')      ──┤             会话归属)                │
│  ctx.on('goal/changed')      ──┤        │ 门控 lib/gate.js：          │
│  ctx.on('jobs.onJobDone')    ──┘        │ 聚焦页面选中该会话 → 静默    │
│                                         │ 会话归属不明 → 照常推送      │
│                             队列（200ms 间隔，失败单次重排队）          │
│                                     ▼                               │
│                   发送层：winrt.js（Windows / koffi 直调 WinRT）      │
│                           toast-linux.js（Linux / D-Bus 直连会话总线）│
└──────────────────────────────────────┬───────────────────────────────┘
                                       ▼
                      系统通知（Windows Toast / Linux 桌面通知）
```

## 聚焦门控（按会话）

- 浏览器半区（`lib/client.js`）以 `document.hasFocus()` + `visibilityState === 'visible'` 判定聚焦，由 `focus`/`blur`/`visibilitychange`/`pagehide` **原生事件即时触发**（无轮询定时器）；聚焦页面的用户活动（键盘/鼠标/滚动，10s 节流）持续"保鲜"。
- ⚠️ 事件监听必须用显式包装（`() => report()`）：DOM 监听器会把 Event 对象作为第一参数传入，若直接绑 `report(force)`，`!!Event === true` 会把失焦事件误报为聚焦（曾为此引入的回归 Bug）。
- **会话归属**：同一次上报还带 `sessionId` = 该页面**当前选中的会话**，取自 harness 客户端 `sessions` 服务的 `list.getSnapshot().current`；`sessions.list.subscribe()` 让"切换会话"即时重报（不必等下一次聚焦事件）。服务未就绪或取不到时上报 `null`。
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
| 🧰 后台任务结束 | `jobs.onJobDone` | 任务 settle | `工作区/会话名:后台任务名已完成` |

- 前缀的**工作区按会话动态解析**（会话 `header.cwd` 的目录名，多工作区并行时各显示自己的工作区）；会话名取 `sessionTitle` 服务。
- 子代理/后台任务的主会话经 `session.header.parentSession` 回溯。
- 每条通知同时把**会话归属**交给门控（见上节）：任务完成/提问/审批/目标用各自 `agent.session`/`session`；子代理用 `[主会话, 子会话]`；后台任务用 `owner.session || ownerSession`，取不到则不静默。

## 为什么审批被拒走 `session/event` 而不是 `approval/request`

`dsh-user-approval` 的 `decide()` 在 `never` 政策下直接返回 `'rejected'`，**不会派发** `approval/request` waterfall。但每次询问/裁决都会在会话日志落审计事件 `approval/asked` + `approval/decided`。因此插件监听 `session/event`（post-commit 追加流）读取这对审计事件——`never` 政策下每条被拒操作都会产生一条完整记录。

## 发送层（进程内原生直连）

- **Windows（`lib/winrt.js`，koffi）**：`ToastNotificationManager` 工厂 → 槽 6 `GetDefault()` → `ToastNotificationManagerForUser` → 槽 7 `CreateToastNotifierWithId('DSH')`（notifier 进程内缓存复用）→ `XmlDocument` 激活 → QI `IXmlDocumentIO` → 槽 6 `LoadXml(HSTRING)` → `ToastNotification` 工厂 → 槽 6 `CreateInstance` → `IToastNotifier` 槽 6 `Show`。
  - 不用旧 `Statics.CreateToastNotifier(appId)`：本机（Windows 11 26100）返回 `0x80070490`，必须走 `ForUser` 变体；
  - WinRT 字符串参数一律 HSTRING（`WindowsCreateString`），不是 LPCWSTR；
  - 首次发送前幂等写入 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH`（`DisplayName` + `IconUri`，advapi32 直调），供通知中心显示"程序应用图标"；写失败只影响图标，不影响 Toast，且失败后 1 分钟会再试一次（成功则永久缓存）；
  - 无 Python、无子进程、无冷启动：单条发送是纯进程内几次 vtable 调用；`RoActivateInstance` / `RoGetActivationFactory` / `QI` 拿到的接口引用都在用完后 `Release`（notifier 进程内缓存复用），避免常驻宿主每发一条就漏一个对象。
- **Linux（`lib/toast-linux.js`，纯 JS D-Bus）**：直连会话总线（`$DBUS_SESSION_BUS_ADDRESS`，缺省 `/run/user/<uid>/bus`）——
  - 地址解析支持 `unix:path=`（首选）；`unix:abstract=` 也认，但 Node/libuv 用 C 字符串长度定位 Unix 套接字，抽象命名空间地址实测会直接 `EINVAL`，此时日志会明确提示改用文件路径形式；
  - 认证：写入 NUL 字节后发 `AUTH EXTERNAL <uid 十进制字符串的十六进制>`，收到 `OK <guid>` 再发 `BEGIN`（被拒时退回 `AUTH ANONYMOUS` 一次）；
  - 发送：自实现的编组器产出小端 `method_call`（header fields：PATH/INTERFACE/MEMBER/DESTINATION/SIGNATURE，body 签名 `susssasa{sv}i`）后写 socket；`hints` 里**始终带一条 urgency**（0/1/2），刻意避开"空 `a{sv}` 的元素对齐在实现间有分歧"这个坑；
  - 连接常驻复用、断开即重连；未连上时最多缓存 32 条待发；连接/握手有 15 秒超时（半开的总线不会让通知永远堆在待发里），失败后 30 秒内不再重连且同一原因只打一条错误日志；错误（`ERROR` 类型的回复）走 `console.error`，不打断宿主；
  - 不起 `notify-send` 子进程；编组逻辑平台无关，由 `tests/dbus.test.mjs` 用测试侧解码器做往返校验。
- 队列 200ms 间隔防轰炸；发送抛错时单次重排队。

## 对外推送 API（供其它插件）

插件在 `apply` 里用 `ctx.provide('desktopNotify', api)` 暴露两个方法（实现在 `lib/api.js`）：

| 方法 | 门控 | 用途 |
| --- | --- | --- |
| `push(item)` | 走聚焦门控（按会话） | 与内置 6 类通知同待遇：你看的那个会话静默，其它照常弹 |
| `pushAlways(item)` | 绕过门控 | 无论聚焦与否都弹（紧急提醒） |

载荷 `{ title, message?, urgency?, sessionId? }`；标题为空返回 `false` 且不推送，其余情况返回 `true` 表示**已被 API 受理**（是否真的弹仍取决于门控：被静默时返回值同样是 `true`，不区分）；`sessionId` 决定会话级门控归属（不传则 `push` 也始终推送）。入队后与内置通知共用同一队列（200ms 间隔）。

## 消息缓存

- `lastTextBySession`：仅缓存"最近一条助手回复摘要"（≤220 字符），任务完成通知**消费即释放**（推送或被门控静默丢弃都释放），下次回复自动重建——内存只留活跃条目；
- `askAtBySession`：提问时刻（15 秒内抑制任务完成通知），过期条目惰性清理；
- `asksById`：审批配对，`decided` 后即删；孤儿条目（会话被中断、始终没等到裁决）最多保留 64 条，超限先丢最旧的；重启后全部自动初始化。

## 调试开关

`config.debug`（默认 `false`）：关闭时终端不输出 `[dsh-desktop-notify]` **状态**日志（notify 决策 / 聚焦上报 / fire / onJobDone 等）。排查时在 profile 层 `cordis.patch.yml` 覆盖 `desktop-notify` 行：

```yaml
- id: desktop-notify
  config: { debug: true }
```

**错误**日志不受这个开关限制：发送失败、D-Bus 连接/认证错误、钩子异常、无通知后端提示都照常打印到 stderr。
