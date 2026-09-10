# 快速上手

## 前置条件

1. `dsh web` 已启动过至少一次（`$DSH_HOME/profiles/web` 已生成）。
2. **不需要 Python、不需要 pip**：发送层是进程内原生直连——Windows 用 koffi 直调 WinRT，Linux 直连 D-Bus（`org.freedesktop.Notifications`）。
3. Windows 上先确认 `koffi` 能装（安装脚本会自动处理；网络受限时会从本仓库 `node_modules` 拷贝）。

Windows 可以先跑一条冒烟测试，确认能弹 Toast：

```powershell
node scripts/winrt-probe.mjs
```

## 安装

```powershell
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

```bash
# Linux
bash scripts/install.sh
```

脚本会：

1. 把 `lib/`、`assets/`、`cordis.patch.yml`、`package.json` 复制到 `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/`；
2. 把 `dsh-desktop-notify` 注册进 web profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`，幂等，重复执行不产生重复项）；
3. **Windows**：确保运行时依赖 `koffi` 在 profile 中可用（npm 安装，失败则从本仓库 `node_modules` 拷贝）；写好 AUMID `DSH` 注册表键（`DisplayName` + `IconUri`，Toast 顶部"程序应用图标"的来源，只写 DSH 自己的键）；
4. 提示你**完全重启 `dsh web`**（结束进程重开，不是刷新页面）。

## 验证

1. 重启后把 DSH 页面**切到后台或最小化**（非聚焦）；
2. 给 agent 一个小任务（或启动一个后台任务），等它干完；
3. 右下角出现 Toast（如「✅ DSH 任务完成」或「🧰 后台任务结束」），正文带 `工作区/会话名:...` 前缀；
4. 回到页面保持聚焦再试一次——聚焦时不弹（防打扰生效，聚焦静止超 2 分钟恢复推送）。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 什么通知都不弹 | 先跑 `node scripts/winrt-probe.mjs`（Windows）确认发送层本身可用；再看插件是否加载（终端 `config.debug: true` 后有 `[dsh-desktop-notify] plugin ready`）；确认 Windows 通知设置里「DSH」应用未被专注助手/勿扰拦截 |
| 提示 `Cannot find package 'koffi'` | profile 里缺运行时依赖：在 `$DSH_HOME/profiles/web` 下执行 `npm install koffi --legacy-peer-deps`，或重跑 `scripts/install.ps1`（会从本仓库 `node_modules` 拷贝一份） |
| 页面非聚焦也不弹 | 在 profile 层开启调试开关（`config: { debug: true }`）后重启，看终端 `[dsh-desktop-notify]` 日志：确认 `onJobDone`/`notify` 是否触发、`silenced` 值、`fire` 是否执行 |
| 聚焦判定异常（该静默没静默/该推没推） | 确认页面加载的是最新 `client.js`（Ctrl+F5 强制刷新）；聚焦判定 = `visibilityState === 'visible' && document.hasFocus()` |
| 通知中心图标是空白/默认图标 | AUMID 键未写成功：`Get-ItemProperty 'HKCU:\SOFTWARE\Classes\AppUserModelId\DSH'` 应能看到 `DisplayName`/`IconUri`；缺失时重跑安装脚本（插件首次发送也会补写一次） |
| 只有部分类别弹 | 逐类核对触发场景；「审批被自动拒绝」仅当审批政策为 `never` 且确有操作被拒时触发 |

## 调试开关

默认关闭（终端零状态输出）。排查时在 profile 的 `cordis.patch.yml` 覆盖 `desktop-notify` 行：

```yaml
- id: desktop-notify
  config: { debug: true }
```

重启后终端输出 `[dsh-desktop-notify]` 状态日志（notify 决策/聚焦上报/fire/onJobDone 等）。
