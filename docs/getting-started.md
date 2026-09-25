# 快速上手

## 前置条件

1. `dsh web` 已启动过至少一次（`$DSH_HOME/profiles/web` 已生成），且 DSH 版本为 **0.1.7-rc.2**（或与之契约一致的新版；`jobs` 服务面、客户端会话快照按 0.1.7 实现）。
2. **不需要 Python、不需要 pip**：发送层是进程内原生直连——Windows 用 koffi 直调 WinRT，Linux 直连 D-Bus（`org.freedesktop.Notifications`）。
3. Windows 上先确认 `koffi` 能装（安装脚本会自动处理；网络受限时会从本仓库 `node_modules` 拷贝）。

Windows / Linux 都可以先跑一条冒烟测试，确认发送层本身可用：

```powershell
node scripts/winrt-probe.mjs    # Windows：按当前主题注册 AUMID 图标 + 发一条真实 Toast
node scripts/theme-probe.mjs    # Windows/Linux：主题检查 + 切换事件跟踪自检（不改系统主题）
```

```bash
# Linux（在桌面会话里执行）
node --input-type=module -e "import('./lib/toast-linux.js').then(m => m.sendToast({ title: 'DSH 通知测试', message: 'D-Bus 直连可用' }))"
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

1. **Windows**：先确保运行时依赖 `koffi` 在 profile 中可用（npm 安装，失败则从本仓库 `node_modules` 拷贝）——**先装依赖再拷文件**，否则 npm 会把刚拷进去的插件当 extraneous 清掉；
2. 把 `lib/`、`assets/`、`cordis.patch.yml`、`package.json` 复制到 `$DSH_HOME/profiles/web/node_modules/dsh-desktop-notify/`；
3. 把 `dsh-desktop-notify` 登记进 web profile 的 `dsh.profile.bundles`（幂等，重复执行不产生重复项）；**不写 `dependencies`**——npm 上有个同名的**另一个**插件（与本仓库无关），写进去会让任何一次 `npm install` 去 registry 拉那一个覆盖本地这份（代价：在该 profile 里跑 `npm install` 会把这套手动安装的文件清掉，重跑脚本即可恢复）；
4. **Windows**：按**当前系统主题**写好 AUMID `DSH` 注册表键（`DisplayName` + `IconUri`，Toast 顶部"程序应用图标"的来源，只写 DSH 自己的键；插件运行时会随主题切换自动改写）；**Linux**：只用 `node:net` 连会话总线，零额外依赖；
5. 提示你**完全重启 `dsh web`**（结束进程重开，不是刷新页面）。

## 验证

1. 把 DSH 页面**切到别的会话、别的标签或最小化**（离开你正在看的会话）；
2. 给 agent 一个小任务（或启动一个后台任务），等它干完；
3. 系统通知出现（如「✅ DSH 任务完成」或「🧰 后台任务结束」），正文带 `工作区/会话名:...` 前缀；
4. 回到页面**停在那个会话**再试一次——不弹（按会话防打扰生效，聚焦静止超 2 分钟恢复推送）；切去别的会话时它的提醒会照常弹。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 什么通知都不弹 | 先跑上面的冒烟测试确认发送层本身可用；再看插件是否加载（终端 `config.debug: true` 后有 `[dsh-desktop-notify] plugin ready`）；确认系统通知设置里「DSH」未被专注助手/勿扰拦截 |
| 提示 `Cannot find package 'koffi'`（仅 Windows） | profile 里缺运行时依赖，**整个插件都不会加载**（不是只少发送层）：重跑 `scripts/install.ps1`（它会先在 profile 里装好 koffi 再拷插件），或手动在 `$DSH_HOME/profiles/web` 下 `npm install koffi --legacy-peer-deps` 后重跑安装脚本 |
| 插件装好后不见了 / 不再弹通知（Windows） | 多半是该 profile 里跑过 `npm install`：npm 会把不在 `dependencies` 里的手动安装目录当 extraneous 清掉。重跑 `scripts/install.ps1` 恢复（脚本刻意不写 `dependencies`，因为 npm 上有同名包，写进去会被拉取覆盖） |
| 不确定 koffi 到底从哪加载 | 在 profile 目录里执行 `node -e "console.log(require.resolve('koffi'))"`：路径应落在 `profiles/web/node_modules/` 下；若指向 DSH 自己的目录（例如 `deepseek-harness/...`），说明只是借用上游依赖，DSH 换布局就会失效 |
| Linux 没有通知 | 必须是有桌面会话的环境（`echo $DBUS_SESSION_BUS_ADDRESS` 或 `/run/user/$(id -u)/bus` 存在）；纯 SSH/容器里没有会话总线，日志会出现 `D-Bus 连接失败`（同一原因只打一条，失败后 30 秒内不重连） |
| 离开聚焦会话也不弹 | 在 profile 层开启调试开关（`config: { debug: true }`）后重启，看终端 `[dsh-desktop-notify]` 日志：确认 `notify` 是否触发、`session=` 与 `silenced=` 的值、`fire` 是否执行；若 `silenced=false` 却一直不弹，看 `plugin ready (…, backend=…)` 是否为 `none` |
| 后台任务结束不弹 | 看调试日志里 `jobs service: hooked` 与 `job settled …` 两行：前者说明事件流订阅挂上了（服务晚挂载也会自动补挂），后者说明结算事件到了；只有 `awaited=false` 的结算才通知 |
| 通知图标在浅色主题下看不见 | 说明用的是白鱼图标：确认 `node scripts/theme-probe.mjs` 报出的当前主题是否正确、`assets/dsh-light.*` 是否存在；主题切换后最多等 60 秒兜底重读生效 |
| 聚焦判定异常（该静默没静默/该推没推） | 确认页面加载的是最新 `client.js`（Ctrl+F5 强制刷新）；聚焦判定 = `visibilityState === 'visible' && document.hasFocus()` |
| 通知中心图标是空白/默认图标 | AUMID 键未写成功：`Get-ItemProperty 'HKCU:\SOFTWARE\Classes\AppUserModelId\DSH'` 应能看到 `DisplayName`/`IconUri`；缺失时重跑安装脚本（插件首次发送也会补写一次，失败后 1 分钟会再试） |
| 只有部分类别弹 | 逐类核对触发场景；「审批被自动拒绝」仅当审批政策为 `never` 且确有操作被拒时触发 |

## 调试开关

默认关闭（终端零状态输出）。排查时在 profile 的 `cordis.patch.yml` 覆盖 `desktop-notify` 行：

```yaml
- id: desktop-notify
  config: { debug: true }
```

重启后终端输出 `[dsh-desktop-notify]` 状态日志（notify 决策/聚焦上报/fire/job settled/主题等）。
