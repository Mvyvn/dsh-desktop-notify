# DSH 桌面通知（dsh-desktop-notify）

为 [DSH](https://github.com/deepseek-ai/dsh) 打造的桌面通知插件（Windows / Linux），随 `dsh web` 启动自动加载（无需审批）。

- **任务完成**：agent 干完活回到空闲时，弹「✅ DSH 任务完成」+「工作区/会话名:结尾输出内容」
- **等待你回答**：AI 发起 `ask_user_question` 提问时，弹「❓ DSH 等待你的输入」提醒你回来
- **审批被自动拒绝**：`never` 审批政策下操作被静默拒绝时，弹「🚫 操作被自动拒绝」告知
- **后台任务结束**：后台子代理 / 目标完成或卡住 / 后台命令任务结束时逐一提醒
- **防打扰**：**只静默"你正在看的那个会话"**——页面聚焦且其中当前选中的正是这条通知所属会话时才不弹；切到别的窗口/标签、最小化，或者你正在看别的会话（多会话/多工作区并行），提醒照常推送
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

验证：切到别的窗口，让 agent 跑一个小任务，完成后应弹出系统通知；**停在你正在看的那个会话**里则不弹——但如果你切去别的会话（或别的标签），它的提醒会照常弹（聚焦静止 2 分钟视为失焦，恢复提醒）。也可以直接跑冒烟测试：

```powershell
node scripts/winrt-probe.mjs   # Windows：注册 AUMID + 发一条真实 Toast
```

```bash
# Linux：发一条通知（桌面会话里执行；纯 SSH/无桌面会话不会弹）
node --input-type=module -e "import('./lib/toast-linux.js').then(m => m.sendToast({ title: 'DSH 通知测试', message: 'D-Bus 直连可用' }))"
```

## 通知一览

| 通知 | 触发钩子 | 静默判定用的会话 | 正文格式 |
| --- | --- | --- | --- |
| ✅ 任务完成 | `agent/status` running→idle（仅根 agent，3 秒去抖） | 该 agent 的会话 | 工作区/会话名:结尾输出内容 |
| ❓ 等待你回答 | `tools/execute` 捕获 `ask_user_question` 派发 | 发起提问的会话 | 工作区/会话名:[类型] 内容 |
| 🚫 审批被自动拒绝 | `session/event` 流 `approval/asked`+`decided` 审计对 | 被拒操作所在会话 | 工作区/会话名:工具名-拒绝原因 |
| 🤖 后台子代理结束 | `subagent/end` | 主会话或子会话 | 工作区/主会话名:子代理名已完成 |
| 🎯 目标完成 / 阻塞 | `goal/changed` | 目标所属会话 | 工作区/会话名:目标-已完成 / 目标-阻塞原因 |
| 🧰 后台任务结束 | jobs 服务 `onJobDone` | owner 会话（取不到则不静默） | 工作区/会话名:后台任务名已完成 |

前缀的"工作区"按会话动态解析（多工作区并行时各显示自己的工作区名），"会话名"取 `sessionTitle` 服务。门控只比对会话，不影响文案。

## 给其它插件调用（对外 API）

本插件把自己注册成 Cordis 服务 `desktopNotify`，**你自己的插件可以直接调用它推送通知**，两种模式：

```js
// 在你的插件里（宿主半区 apply）
export function apply(ctx) {
  const notify = ctx.get('desktopNotify')   // 可选服务：本插件未加载时为 undefined
  if (!notify) return

  // 1) 走聚焦门控：只有"你正在看的那个会话"会被静默
  notify.push({
    title: '构建完成',
    message: '工作区/会话:全部通过',
    urgency: 'normal',      // 'low' | 'normal' | 'critical'，缺省 normal
    sessionId: agent.session, // 可选：传了就按会话门控；不传则始终推送
  })

  // 2) 绕过聚焦门控：无论页面是否聚焦、正在看哪个会话，都弹
  notify.pushAlways({ title: '磁盘告急', message: '剩余 1GB', urgency: 'critical' })
}
```

- 返回 `true` 表示已受理入队；**标题为空返回 `false` 且不推送**（避免空通知）。
- `title` 最长 160 字符、`message` 最长 400 字符，超出截断；队列仍按 200ms 间隔逐条发送。
- `sessionId` 可传会话对象、会话 id 或它们的数组（子代理场景可同时传主会话与子会话）。
- 想全局取用可写 `inject: ['desktopNotify']`（硬依赖，本插件缺失时你的插件不会加载）；否则用 `ctx.get` 按可选服务处理。

## 项目结构

```
dsh-desktop-notify/
├── lib/          # 宿主端 index.js（门控/队列/平台分发）+ gate.js（按会话门控）+ api.js（对外推送 API）
│                 # 发送层：winrt.js（Windows / koffi 直调 WinRT）、toast-linux.js（Linux / D-Bus 直连）
│                 # client.js（浏览器端聚焦与会话上报）
├── assets/       # 通知图标 dsh.png / dsh.ico（DSH Logo，透明底）
├── scripts/      # 安装脚本 install.ps1 / install.sh、WinRT 冒烟测试 winrt-probe.mjs、图标生成 make-icon.py
├── tests/        # node --test 单测（聚焦门控 / 对外 API / D-Bus 编组）
├── docs/         # 架构、原理、上手文档
├── screenshots/
├── cordis.patch.yml
└── package.json
```

## 工作机制与限制

- **聚焦门控（按会话，事件驱动零轮询）**：浏览器半区（`lib/client.js`）通过官方 Connection RPC 通道 `/dnotify` 上报"页面是否聚焦"以及"该页面当前选中的会话"（取 harness 客户端 `sessions` 服务的 `list.current`，会话切换即时重报）——聚焦判定为 `visibilityState === 'visible' && document.hasFocus()`，由 `focus`/`blur`/`visibilitychange`/`pagehide` 原生事件即时触发（页面关闭经 `keepalive` 可靠上报失焦）；聚焦页面上的用户活动（键盘/鼠标/滚动，节流 10 秒）保持"保鲜"。宿主端按"页面 × 会话"聚合（`lib/gate.js`）：**只有存在聚焦页面、且该页面选中的会话正是通知所属会话时才静默**；正在看会话 A 时，会话 B 完成照样弹。**拿不到会话归属的通知**（例如 owner 已清理的后台任务）一律推送，不静默。聚焦静止超 2 分钟视为失焦，异常关闭残留的页面条目 10 分钟自动清理。
- **发送层（原生直连，无子进程）**：`lib/index.js` 按平台动态加载发送层（win32 之外不会 import koffi）。
  - **Windows（`lib/winrt.js`）**：koffi 直调 WinRT（`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId('DSH')` → `XmlDocument.LoadXml` → `Show`），不拉起任何 Python/子进程；首次发送前幂等写入 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH`（`DisplayName` + `IconUri`）供通知中心显示图标。
  - **Linux（`lib/toast-linux.js`）**：纯 JS 直说 D-Bus 协议（`$DBUS_SESSION_BUS_ADDRESS` 或 `/run/user/<uid>/bus`，SASL EXTERNAL 握手 → 调 `org.freedesktop.Notifications.Notify`），不调用 `notify-send`；连接常驻复用、断开自动重连，标题/正文/图标/urgency 都随方法参数发出。
  - 两平台共用同一条发送队列：200ms 间隔防轰炸，发送失败单次重排队。
- **消息缓存**：仅缓存"最近一条助手回复摘要"（≤220 字符），任务完成通知消费后即释放；提问时刻（15 秒抑制）条目过期自动清理；重启自动初始化。
- **`never` 政策下的审批通知**：`approval/request` waterfall 在 `never` 政策下不会派发，因此插件改从会话日志的 `approval/asked`/`approval/decided` 审计对获取被拒记录。想收到这类通知请保持审批政策为 `never`。
- **通知图标**：Toast 的 appLogoOverride 只接受 PNG/JPG/GIF（不支持 SVG），插件随包携带 `assets/dsh.png`（由 `scripts/make-icon.py` 从 DSH favicon 栅格化，透明底白鱼；该脚本只是开发期换图工具，装插件时不需要跑，也不需要 Python）；Toast 顶部/通知中心的程序应用图标来自 AUMID `DSH` 的注册表键 `IconUri`（只写 DSH 自己的键）。
- 依赖系统桌面通知后端：Windows Toast 由 WinRT 提供，Linux 由桌面会话的 D-Bus 通知服务（KDE/GNOME 等）提供；Windows **专注助手/勿扰模式**、Linux 的勿扰开关都可能吞掉通知。
- **平台**：Windows 已实测（Windows 11）；Linux 走 D-Bus（Kubuntu/KDE、Ubuntu/GNOME 等桌面会话；无桌面会话的纯 SSH 环境不会弹通知），D-Bus 编组有单测覆盖；macOS 后端暂未实现（会加载但只记录一条"无后端"提示）。
- **调试日志开关**：默认关闭，终端不输出任何 `[dsh-desktop-notify]` 状态信息。排查时可在 profile 的 `cordis.patch.yml` 中覆盖 `desktop-notify` 行开启（`config: { debug: true }`），重启后终端会输出 notify 决策/聚焦上报/fire 等状态日志。

## 许可证

[MIT](LICENSE) © 2026 沐云 (Mvyvn)
