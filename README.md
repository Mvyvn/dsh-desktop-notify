# DSH 桌面通知（dsh-desktop-notify）

为 [DSH](https://github.com/deepseek-ai/dsh) 打造的 Windows 桌面通知插件，随 `dsh web` 启动自动加载（无需审批）。

- **任务完成**：agent 干完活回到空闲时，弹「✅ DSH 任务完成」+ 会话标题与最后回复摘要
- **等待你回答**：AI 发起 `ask_user_question` 提问时，弹「❓ DSH 等待你的输入」提醒你回来
- **审批被自动拒绝**：`never` 审批政策下操作被静默拒绝时，弹「🚫 操作被自动拒绝」告知
- **后台任务结束**：后台子代理 / 目标完成或卡住 / 后台命令任务结束时逐一提醒
- **防打扰**：仅当 DSH 页面不可见时才弹（浏览器半区实时上报可见性），不打断你盯着屏幕干活
- 通知由 Python [`desktop-notifier`](https://github.com/samschott/desktop-notifier) 发送（Windows Toast）

## 截图

| 任务完成 | 等待输入 | 审批被拒 |
| :---: | :---: | :---: |
| ![notify-task-done](screenshots/notify-task-done.png) | ![notify-question](screenshots/notify-question.png) | ![notify-denied](screenshots/notify-denied.png) |

| 子任务结束 | 目标完成/卡住 | 后台任务结束 |
| :---: | :---: | :---: |
| ![notify-subagent](screenshots/notify-subagent.png) | ![notify-goal](screenshots/notify-goal.png) | ![notify-job](screenshots/notify-job.png) |

## 安装

前置条件：

1. 已启动过一次 `dsh web`（需已生成 web profile）；
2. 本机有 Python 3.8+，且已安装 `desktop-notifier`（`pip install desktop-notifier`，Windows 会自动带上 WinRT 后端依赖）。

```powershell
# Windows
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

```bash
# macOS / Linux（通知走各平台原生后端，用法相同）
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
bash scripts/install.sh
```

脚本会把插件装入 `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/`（`$DSH_HOME` 默认 `~/.dsh`），并把包注册进 web profile 的 `package.json`（dependencies + bundles），然后**完全重启 `dsh web`**（结束进程重开，不是刷新页面）。

验证：切到别的窗口，让 agent 跑一个小任务，完成后右下角应弹出 Toast；页面可见时则不弹。

## 通知一览

| 通知 | 触发钩子 | 正文 |
| --- | --- | --- |
| ✅ 任务完成 | `agent/status` running→idle（仅根 agent，3 秒去抖） | 会话标题 + 最后回复摘要 |
| ❓ 等待你回答 | `tools/execute` 捕获 `ask_user_question` 派发 | 问题标题 + 问题文本 |
| 🚫 审批被自动拒绝 | `session/event` 流 `approval/asked`+`decided` 审计对 | 工具名 + 拒绝原因 |
| 🤖 后台子任务结束 | `subagent/end` | provider + stopReason + 输出摘要 |
| 🎯 目标完成 / 阻塞 | `goal/changed` | 目标 + 阻塞原因 |
| 🧰 后台任务结束 | jobs 服务 `onJobDone` | 任务 label + 状态 |

## 项目结构

```
dsh-desktop-notify/
├── lib/          # 宿主端 index.js + 浏览器端 client.js
├── scripts/      # 安装脚本 install.ps1 / install.sh
├── docs/         # 架构、原理、上手文档
├── screenshots/
├── cordis.patch.yml
└── package.json
```

## 工作机制与限制

- **双半区**：Host 半区监听宿主事件并调用一次性 Python 进程发 Toast；浏览器半区（`lib/client.js`）通过官方 Connection RPC 通道 `/dnotify` 上报页面可见性，页面可见时静音（客户端每 30 秒心跳 + `visibilitychange` 即时上报，页面关闭 90 秒后视为不可见）。
- **`never` 政策下的审批通知**：`approval/request` waterfall 在 `never` 政策下不会派发，因此插件改从会话日志的 `approval/asked`/`approval/decided` 审计对获取被拒记录。想收到这类通知请保持审批政策为 `never`。
- 依赖桌面通知后端（Windows Toast 由 `desktop-notifier` + WinRT 驱动）；Windows **专注助手/勿扰模式**可能吞掉 Toast。
- 主要在 Windows 开发测试；macOS/Linux 路径与通知后端未实测，欢迎反馈。

## 许可证

[MIT](LICENSE) © 2026 沐云 (Mvyvn)
