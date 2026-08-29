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

1. 把 `lib/`、`cordis.patch.yml`、`package.json` 复制到 `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/`；
2. 把 `dsh-desktop-notify` 注册进 web profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`，幂等，重复执行不产生重复项）；
3. 提示你**完全重启 `dsh web`**（结束进程重开，不是刷新页面）。

## 验证

1. 重启后切到别的窗口（让 DSH 页面不可见）；
2. 给 agent 一个小任务，等它干完；
3. 约 3.5 秒后右下角出现「✅ DSH 任务完成」Toast，正文带会话标题和最后回复摘要；
4. 回到页面再试一次——页面可见时不弹（防打扰生效）。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 什么通知都不弹 | 检查 Python + desktop-notifier 是否装好（见上冒烟测试）；检查 Windows 通知设置里「DSH」应用未被专注助手/勿扰拦截 |
| 页面可见时也弹 | 浏览器半区未加载或 RPC 上报失败：刷新页面后观察；检查浏览器控制台是否有 `dnotify` 相关报错 |
| 只有部分类别弹 | 逐类核对触发场景；「审批被自动拒绝」仅当审批政策为 `never` 且确有操作被拒时触发 |
