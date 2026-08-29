# 工作原理

## 双半区架构

```
┌─────────────────────────── Host（Node 进程）───────────────────────────┐
│  ctx.on('agent/status')        ──┐                                      │
│  ctx.on('session/event')       ──┤  去抖/合并/文案组装                   │
│  ctx.on('tools/execute')       ──┼──► notify(title, message, urgency)   │
│  ctx.on('subagent/end')        ──┤        │   │                         │
│  ctx.on('goal/changed')        ──┤        │   └─ 700ms 队列间隔          │
│  ctx.on('jobs.onJobDone')      ──┘        ▼                             │
│                            subprocess.spawn(python -X utf8 -c PY …)     │
│                                     │                                   │
└─────────────────────────────────────┼───────────────────────────────────┘
                                      ▼
                      desktop-notifier（Windows Toast）

┌────────────────────────── Browser（页面）───────────────────────────────┐
│ document.visibilityState ──► POST /dnotify/page-visibility             │
│   （visibilitychange 即时 + 30 秒心跳）        │                          │
└───────────────────────────────────────────────┼─────────────────────────┘
                                                ▼
                    ctx.connection.rpc.handle('/dnotify', …)  → state.pageVisible
```

## 通知门控

- `state.pageVisible` 由浏览器半区经 Connection RPC 通道 `/dnotify` 上报；
- 页面可见 → 通知被丢弃；不可见 → 进入发送队列；
- 页面关闭后 90 秒未再上报，视为不可见（防止“关页面前最后状态是可见”导致漏通知）。

## 各通知钩子

| 通知 | 钩子 | 触发点 | 防打扰细节 |
| --- | --- | --- | --- |
| 任务完成 | `agent/status` | agent `running→idle` | 仅根 agent（`agents.roots()` 过滤子代理）；3 秒去抖（goal 连续轮次之间短暂 idle 不弹）；仅当本进程内产出过助手回复才弹 |
| 等待输入 | `tools/execute` | `ask_user_question` 派发瞬间 | 记录提问时间，15 秒内抑制随后的「任务完成」，避免双重打扰 |
| 审批被拒 | `session/event` | `approval/decided` 且 `outcome==='rejected'` | 与 `approval/asked` 按 id 配对取工具名与原因 |
| 子任务结束 | `subagent/end` | 子代理收敛 | 正文带 stopReason 与末条输出摘要 |
| 目标完成/阻塞 | `goal/changed` | `operation==='complete'\|'block'` | 阻塞时附 `blockedReason.message` |
| 后台任务 | `jobs.onJobDone` | 任务 settle | 跳过 `reported` 的任务，正文带 label/status |

## 为什么审批被拒走 `session/event` 而不是 `approval/request`

`dsh-user-approval` 的 `decide()` 在 `never` 政策下直接返回 `'rejected'`，**不会派发** `approval/request` waterfall。但每次询问/裁决都会在会话日志落审计事件 `approval/asked` + `approval/decided`。因此插件监听 `session/event`（post-commit 追加流）读取这对审计事件——`never` 政策下每条被拒操作都会产生一条完整记录。

## Python 发送进程

- 每条通知 spawn 一次 `python -X utf8 -c <脚本>`，载荷经 `argv[1]` 传 JSON（`{t,m,u}`）；
- `-X utf8` 保证中文正确；spawn 失败/非零退出会在宿主日志打印 `[dsh-desktop-notify]` 前缀诊断；
- 一次性进程无需生命周期管理：插件停止时无残留子进程。
