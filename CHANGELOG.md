# Changelog

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
