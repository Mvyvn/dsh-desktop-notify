# Changelog

## [1.1.0] - 2026-09-11

- **聚焦门控改为按会话**：浏览器半区上报"页面聚焦状态 + 该页面当前选中的会话"（客户端 `sessions` 服务的 `list.current`，切换会话即时重报），宿主按"页面 × 会话"判定——**只静默你正在看的那个会话**，看会话 A 时会话 B 完成照样弹；拿不到会话归属的通知（例如 owner 已清理的后台任务）一律推送。门控逻辑抽到 `lib/gate.js` 并有单测（`npm test`）。
- **发送层重写为进程内原生直连**：Windows 用 `koffi` 直调 WinRT 发 Toast（`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId` → `XmlDocument.LoadXml` → `Show`），彻底移除 Python 助手、`desktop-notifier` 依赖与 stdin 子进程协议——单条发送是几次进程内 vtable 调用，无冷启动、无进程重建逻辑。
- AUMID 图标改为插件自己维护：首次发送前幂等写入 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH`（`DisplayName` + `IconUri`，经 advapi32 直调），不再需要快捷方式与 Python 注册脚本；`scripts/register-aumid.py` 已删除。
- 安装脚本更新：`scripts/install.ps1` 移除 Python 前置，改为确保运行时依赖 `koffi` 在 profile 中可用（npm 安装，失败则从本仓库 `node_modules` 拷贝）并直接写 AUMID 注册表键；`scripts/install.sh` 面向 Linux（D-Bus 原生通知）。
- `scripts/winrt-probe.mjs` 改为调用 `lib/winrt.js` 的正式代码路径（注册 AUMID + 发一条真实 Toast），作为合并/安装前的冒烟测试。

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
