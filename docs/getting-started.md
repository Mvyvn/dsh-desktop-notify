# 快速上手

## 前置条件

1. `dsh web` 已启动过至少一次（`$DSH_HOME/profiles/web` 已生成）。
2. Python 3.8+ 已安装，且装有 `desktop-notifier`：

   ```powershell
   pip install desktop-notifier
   ```

   Windows 下会自动带上 WinRT 后端依赖；装完可以先跑一条冒烟测试确认 Toast 能弹：

   ```powershell
   python -c "import asyncio; from desktop_notifier import DesktopNotifier; asyncio.run(DesktopNotifier(app_name='DSH').send(title='test', message='hello'))"
   ```

## 安装

```powershell
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

脚本会：

1. 把 `lib/`、`assets/`、`scripts/register-aumid.py`、`cordis.patch.yml`、`package.json` 复制到 `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/`；
2. 把 `dsh-desktop-notify` 注册进 web profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`，幂等，重复执行不产生重复项）；
3. 注册 Windows 应用身份（AUMID `DSH` 快捷方式 + 注册表，Toast 顶部"程序应用图标"的来源；只写 DSH 自己的键）；
4. 提示你**完全重启 `dsh web`**（结束进程重开，不是刷新页面）。

## 验证

1. 重启后把 DSH 页面**切到后台或最小化**（非聚焦）；
2. 给 agent 一个小任务（或启动一个后台任务），等它干完；
3. 右下角出现 Toast（如「✅ DSH 任务完成」或「🧰 后台任务结束」），正文带 `工作区/会话名:...` 前缀；
4. 回到页面保持聚焦再试一次——聚焦时不弹（防打扰生效，聚焦静止超 2 分钟恢复推送）。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 什么通知都不弹 | 检查 Python + desktop-notifier 是否装好（见上冒烟测试）；检查 Windows 通知设置里「DSH」应用未被专注助手/勿扰拦截 |
| 页面非聚焦也不弹 | 在 profile 层开启调试开关（`config: { debug: true }`）后重启，看终端 `[dsh-desktop-notify]` 日志：确认 `onJobDone`/`notify` 是否触发、`silenced` 值、`fire` 是否写入 helper |
| 聚焦判定异常（该静默没静默/该推没推） | 确认页面加载的是最新 `client.js`（Ctrl+F5 强制刷新）；聚焦判定 = `visibilityState === 'visible' && document.hasFocus()` |
| 只有部分类别弹 | 逐类核对触发场景；「审批被自动拒绝」仅当审批政策为 `never` 且确有操作被拒时触发 |

## 调试开关

默认关闭（终端零状态输出）。排查时在 profile 的 `cordis.patch.yml` 覆盖 `desktop-notify` 行：

```yaml
- id: desktop-notify
  config: { debug: true }
```

重启后终端输出 `[dsh-desktop-notify]` 状态日志（notify 决策/聚焦上报/fire/onJobDone 等）。
