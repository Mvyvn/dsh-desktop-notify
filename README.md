# DSH 桌面通知（dsh-desktop-notify）

为 [DSH](https://github.com/deepseek-ai/dsh) 打造的桌面通知插件（Windows / Linux），随 `dsh web` 启动自动加载（无需审批）。

- **任务完成**：agent 干完活回到空闲时，弹「✅ DSH 任务完成」+「工作区/会话名:结尾输出内容」
- **等待你回答**：AI 发起 `ask_user_question` 提问时，弹「❓ DSH 等待你的输入」提醒你回来
- **审批被自动拒绝**：`never` 审批政策下操作被静默拒绝时，弹「🚫 操作被自动拒绝」告知
- **后台任务结束**：后台子代理 / 目标完成或卡住 / 后台命令任务结束时逐一提醒
- **防打扰**：**只有 DSH 网页处于聚焦状态**（浏览器窗口聚焦且标签页活跃）才静默；非聚焦——切到别的窗口/标签、最小化、浏览器未打开或已关闭——一律推送提醒
- **DSH图标**：Toast 右下角与应用身份图标均为 DSH Logo（透明底 PNG/ICO），非系统默认图标
- **原生直连发送**：Windows 用 [koffi](https://koffi.dev/) 直调 WinRT 发 Toast，Linux 直连 D-Bus（`org.freedesktop.Notifications`）——**无 Python、无子进程、无冷启动**

## 截图

| 任务完成 | 等待输入 | 审批被拒 |
| :---: | :---: | :---: |
| ![notify-task-done](screenshots/notify-task-done.png) | ![notify-question](screenshots/notify-question.png) | ![notify-denied](screenshots/notify-denied.png) |

| 子代理结束 | 目标完成/卡住 | 后台任务结束 |
| :---: | :---: | :---: |
| ![notify-subagent](screenshots/notify-subagent.png) | ![notify-goal](screenshots/notify-goal.png) | ![notify-job](screenshots/notify-job.png) |

## 安装

前置条件：**已启动过一次 `dsh web`**（需已生成 web profile）。不需要 Python、不需要 pip。

```powershell
# Windows
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

```bash
# Linux（KDE / GNOME 等桌面会话，走 D-Bus 原生通知）
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
bash scripts/install.sh
```

脚本会把插件装入 `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/`（`$DSH_HOME` 默认 `~/.dsh`），把包注册进 web profile 的 `package.json`（dependencies + bundles）。Windows 脚本还会：确保运行时依赖 `koffi` 在 profile 中可用（缺失时 `npm install koffi`，装不上则从本仓库 `node_modules` 拷贝），并写好 AUMID `DSH` 注册表键（Toast 顶部的程序应用图标来源）。之后**完全重启 `dsh web`**（结束进程重开，不是刷新页面）。

验证：切到别的窗口，让 agent 跑一个小任务，完成后右下角应弹出 Toast；页面聚焦时则不弹（聚焦静止 2 分钟视为失焦，恢复提醒）。也可以直接跑冒烟测试：

```powershell
node scripts/winrt-probe.mjs   # Windows：注册 AUMID + 发一条真实 Toast
```

## 通知一览

| 通知 | 触发钩子 | 正文格式 |
| --- | --- | --- |
| ✅ 任务完成 | `agent/status` running→idle（仅根 agent，3 秒去抖） | 工作区/会话名:结尾输出内容 |
| ❓ 等待你回答 | `tools/execute` 捕获 `ask_user_question` 派发 | 工作区/会话名:[类型] 内容 |
| 🚫 审批被自动拒绝 | `session/event` 流 `approval/asked`+`decided` 审计对 | 工作区/会话名:工具名-拒绝原因 |
| 🤖 后台子代理结束 | `subagent/end` | 工作区/主会话名:子代理名已完成 |
| 🎯 目标完成 / 阻塞 | `goal/changed` | 工作区/会话名:目标-已完成 / 目标-阻塞原因 |
| 🧰 后台任务结束 | jobs 服务 `onJobDone` | 工作区/会话名:后台任务名已完成 |

前缀的"工作区"按会话动态解析（多工作区并行时各显示自己的工作区名），"会话名"取 `sessionTitle` 服务。

## 项目结构

```
dsh-desktop-notify/
├── lib/          # 宿主端 index.js（门控/队列）+ winrt.js（Windows 发送）+ client.js（浏览器端聚焦上报）
├── assets/       # 通知图标 dsh.png / dsh.ico（DSH Logo，透明底）
├── scripts/      # 安装脚本 install.ps1 / install.sh、WinRT 冒烟测试 winrt-probe.mjs、图标生成 make-icon.py
├── docs/         # 架构、原理、上手文档
├── screenshots/
├── cordis.patch.yml
└── package.json
```

## 工作机制与限制

- **聚焦门控（事件驱动，零轮询）**：浏览器半区（`lib/client.js`）通过官方 Connection RPC 通道 `/dnotify` 上报页面聚焦状态——聚焦判定为 `visibilityState === 'visible' && document.hasFocus()`，由 `focus`/`blur`/`visibilitychange`/`pagehide` 原生事件即时触发（页面关闭经 `keepalive` 可靠上报失焦）；聚焦页面上的用户活动（键盘/鼠标/滚动，节流 10 秒）保持"保鲜"。宿主端按页面聚合（任一页面聚焦即静默），聚焦静止超 2 分钟或无任何页面视为失焦，恢复推送；异常关闭残留的页面条目 10 分钟自动清理。
- **发送层（原生直连，无子进程）**：Windows 由 `lib/winrt.js` 用 koffi 直调 WinRT（`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId('DSH')` → `XmlDocument.LoadXml` → `Show`），不拉起任何 Python/子进程；首次发送前幂等写入 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH`（`DisplayName` + `IconUri`）供通知中心显示图标。队列 200ms 间隔防轰炸，发送失败单次重排队。
- **消息缓存**：仅缓存"最近一条助手回复摘要"（≤220 字符），任务完成通知消费后即释放；提问时刻（15 秒抑制）条目过期自动清理；重启自动初始化。
- **`never` 政策下的审批通知**：`approval/request` waterfall 在 `never` 政策下不会派发，因此插件改从会话日志的 `approval/asked`/`approval/decided` 审计对获取被拒记录。想收到这类通知请保持审批政策为 `never`。
- **通知图标**：Toast 的 appLogoOverride 只接受 PNG/JPG/GIF（不支持 SVG），插件随包携带 `assets/dsh.png`（由 `scripts/make-icon.py` 从 DSH favicon 栅格化，透明底白鱼；该脚本只是开发期换图工具，装插件时不需要跑，也不需要 Python）；Toast 顶部/通知中心的程序应用图标来自 AUMID `DSH` 的注册表键 `IconUri`（只写 DSH 自己的键）。
- 依赖系统桌面通知后端：Windows Toast 由 WinRT 提供，Linux 由桌面会话的 D-Bus 通知服务（KDE/GNOME 等）提供；Windows **专注助手/勿扰模式**、Linux 的勿扰开关都可能吞掉通知。
- **调试日志开关**：默认关闭，终端不输出任何 `[dsh-desktop-notify]` 状态信息。排查时可在 profile 的 `cordis.patch.yml` 中覆盖 `desktop-notify` 行开启（`config: { debug: true }`），重启后终端会输出 notify 决策/聚焦上报/fire 等状态日志。
- Windows 已实测；Linux 走 D-Bus（无桌面会话/纯 SSH 环境不会有通知），macOS 后端暂未实现。

## 许可证

[MIT](LICENSE) © 2026 沐云 (Mvyvn)
