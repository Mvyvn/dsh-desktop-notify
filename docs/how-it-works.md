# 工作原理

## 双半区架构

```
┌─────────────────────────── Browser（页面）───────────────────────────┐
│ 原生事件（零轮询）→ POST /dnotify/page-focus {focused, pageId}        │
│   focus / blur ─────────► 窗口/标签聚焦切换（即时）                    │
│   visibilitychange ─────► 标签隐藏/切走/最小化（兜底）                 │
│   pagehide ─────────────► 页面卸载前强制上报失焦（keepalive 送达）     │
│   keydown/mousedown/     │                                           │
│   pointermove/scroll ───► 用户活动（节流 10s）聚焦"保鲜"              │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌─────────────────────────── Host（Node 进程）─────────────────────────┐
│  ctx.connection.rpc.handle('/dnotify')                               │
│    focused=true  → pages.set(pageId, now)   ← 多页面聚合：            │
│    focused=false → pages.delete(pageId)      任一页面聚焦即静默        │
│                                                                      │
│  ctx.on('agent/status')      ──┐                                     │
│  ctx.on('session/event')     ──┤  去抖/合并/文案组装                  │
│  ctx.on('tools/execute')     ──┼──► notify(title, message, urgency)  │
│  ctx.on('subagent/end')      ──┤        │ 门控：聚焦且 2 分钟内        │
│  ctx.on('goal/changed')      ──┤        │ 有活动上报 → 静默丢弃        │
│  ctx.on('jobs.onJobDone')    ──┘        ▼                            │
│                             队列（200ms 间隔，失败单次重排队）          │
│                                     ▼                               │
│                   常驻 Python 助手（stdin 逐行 JSON）                 │
└──────────────────────────────────────┬───────────────────────────────┘
                                       ▼
                       desktop-notifier（Windows Toast）
```

## 聚焦门控

- 浏览器半区（`lib/client.js`）以 `document.hasFocus()` + `visibilityState === 'visible'` 判定聚焦，由 `focus`/`blur`/`visibilitychange`/`pagehide` **原生事件即时触发**（无轮询定时器）；聚焦页面的用户活动（键盘/鼠标/滚动，10s 节流）持续"保鲜"。
- ⚠️ 事件监听必须用显式包装（`() => report()`）：DOM 监听器会把 Event 对象作为第一参数传入，若直接绑 `report(force)`，`!!Event === true` 会把失焦事件误报为聚焦（曾为此引入的回归 Bug）。
- 宿主端按**页面 id 聚合**（`pages` Map）：任一页面聚焦且最近 2 分钟内有活动上报 → 静默；非聚焦/无页面/聚焦静止超 2 分钟 → 推送。
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

## 为什么审批被拒走 `session/event` 而不是 `approval/request`

`dsh-user-approval` 的 `decide()` 在 `never` 政策下直接返回 `'rejected'`，**不会派发** `approval/request` waterfall。但每次询问/裁决都会在会话日志落审计事件 `approval/asked` + `approval/decided`。因此插件监听 `session/event`（post-commit 追加流）读取这对审计事件——`never` 政策下每条被拒操作都会产生一条完整记录。

## 常驻 Python 助手

- dsh 启动时随插件拉起一个 Python 进程（`python -X utf8 -c PY_HELPER <icon>`），导入 desktop-notifier/WinRT 一次，此后逐行从 stdin 读取 JSON 载荷发送 Toast——单条毫秒级、无冷启动；
- 单事件循环 + 守护线程：同步读 stdin 保证顺序，发送经 `run_coroutine_threadsafe` 提交到常驻 loop，`fut.result(timeout=10)` 串行等待；
- 崩溃自动重建（写失败/进程退出 → dead 标记 → 下条重新拉起）；插件卸载时 `terminate()` 树级清理；队列 200ms 间隔防轰炸，发送失败单次重排队。

## 消息缓存

- `lastTextBySession`：仅缓存"最近一条助手回复摘要"（≤220 字符），任务完成通知**消费即释放**（推送或被门控静默丢弃都释放），下次回复自动重建——内存只留活跃条目；
- `askAtBySession`：提问时刻（15 秒内抑制任务完成通知），过期条目惰性清理；
- `asksById`：审批配对，`decided` 后即删；重启后全部自动初始化。

## 调试开关

`config.debug`（默认 `false`）：关闭时终端不输出任何 `[dsh-desktop-notify]` 状态信息。排查时在 profile 层 `cordis.patch.yml` 覆盖 `desktop-notify` 行：

```yaml
- id: desktop-notify
  config: { debug: true }
```

开启后终端输出 notify 决策 / 聚焦上报 / fire / onJobDone 等状态日志。
