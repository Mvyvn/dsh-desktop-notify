# 快速上手

## 前置条件

1. `dsh web` 已启动过至少一次（`$DSH_HOME/profiles/web` 已生成）；DSH 版本在 **`>= 0.1.7-rc.2` 且 `<= 0.2.0-rc.2`** 之间。
2. **不需要 Python、不需要 pip**：发送层是进程内原生直连——Windows 用 koffi 直调 WinRT，Linux 直连 D-Bus（`org.freedesktop.Notifications`）。
3. Windows 上不需要手动装 `koffi`：它是本包的普通依赖，插件管理器会装好。

装好后可以先跑一条冒烟测试，确认发送层本身可用（在仓库目录里执行）：

```powershell
node scripts/winrt-probe.mjs    # Windows：按当前主题注册 AUMID 图标 + 发一条真实 Toast
node scripts/theme-probe.mjs    # Windows/Linux：主题检查 + 切换事件跟踪自检（不改系统主题）
```

```bash
# Linux（在桌面会话里执行）
node --input-type=module -e "import('./lib/toast-linux.js').then(m => m.sendToast({ title: 'DSH 通知测试', message: 'D-Bus 直连可用' }))"
```

## 安装

### 方式一：插件管理器 → 按包名安装（推荐）

1. DSH → **插件管理** → **添加插件**；
2. 安装目标填包名 **`@mvyvn/dsh-desktop-notify`**；
3. 插件管理器会从 registry 取包、装好运行时依赖 `koffi`（Windows 发 WinRT Toast 用），并把本包登记为 profile bundle 启用——宿主半区由包内 `cordis.patch.yml` 挂载，浏览器半区由 `dsh.client` 声明后自动提供；
4. **完全重启 `dsh web`**（结束进程重开，不是刷新页面），并**刷新一次 DSH 页面**。

### 方式二：插件管理器 → 按本地路径安装（开发 / 离线）

同一个入口，安装目标填**本机插件目录的实际路径**。管理器会用 `link:` 形态把它记进 profile 的 `dependencies`，后续改源码后重新 `npm run build` 即可生效。

> `node_modules/@mvyvn/dsh-desktop-notify` 必须是**指向包目录的符号链接**。实体目录会遮蔽链接——**不要**手工把目录拷进 profile 的 `node_modules`，也不要用 shell 脚本复刻安装步骤：依赖安装、bundle 选择、启用都归插件管理器负责。

### npm 形态（开发者）

```bash
npm i @mvyvn/dsh-desktop-notify     # 包内自带构建产物 lib/，装完不需要再编译
```

要在别的工程里引用，宿主半区 `import '@mvyvn/dsh-desktop-notify'`，浏览器半区 `@mvyvn/dsh-desktop-notify/client`。

### 从源码构建（开发者路径）

```bash
git clone https://github.com/Mvyvn/dsh-desktop-notify.git
cd dsh-desktop-notify
npm install
npm run build        # tsc ×3 → lib/
```

`lib/` 是随包分发的产物，DSH 直接加载它、不做编译。**改完源码必须重新 `npm run build` 并重启 `dsh web`**，宿主才会加载到新代码。

AUMID `DSH` 注册表键（`DisplayName` 固定 **DeepSeek Harness** + `IconUri`，Toast 来源行的名字与图标）由**插件自己**在启动时按当前系统主题写好，不需要安装步骤参与。

## 授权通知权限

Web Notification 路线需要浏览器通知权限，而浏览器要求用户手势才弹授权框，所以插件不做自动弹窗：首次加载页面时会出现一张一次性卡片「开启桌面通知」——点「设置」弹授权框，点「取消」只关掉卡片。未授权时不会失败，会自动降级为原生 Toast。

在浏览器站点设置里改权限会被即时感知（另附「⚠️ DSH 权限变更」通知），不需要重启。

## 验证

1. 把 DSH 页面**切到别的会话、别的标签或最小化**（离开你正在看的会话）；
2. 给 agent 一个小任务（或启动一个后台任务），等它干完；
3. 系统通知出现（如「✅ DSH 任务完成」或「🧰 后台任务结束」），正文带 `工作区/会话名:...` 前缀；
4. 回到页面**停在那个会话**再试一次——不弹（按会话防打扰生效，聚焦静止超 2 分钟恢复推送）；切去别的会话时它的提醒会照常弹。

## 配置一览

插件管理 → @mvyvn/dsh-desktop-notify 卡片 → **设置**：

| 项 | 说明 |
| --- | --- |
| 运行状态 | 「运行模式：正常」（浏览器通知可用）/「运行模式：降级」（附原因：总开关已关闭、浏览器未授予通知权限、Service Worker 尚未就绪）/「运行状态：关闭」 |
| 总开关 | 关闭后本插件不推送任何通知 |
| 对外 API | 允许其它插件经 `ctx.get('desktopNotify')` 推送 |
| 调试模式 | 状态日志写入 `$DSH_HOME/logs/dsh-desktop-notify/dsh-desktop-notify.log`（>1MB 轮转，保留 5 份；错误日志不受此开关限制，仍打到终端） |
| 各预设推送 | 11 类通知各自的开关 + 静默模式；启动播报与权限变更没有会话归属，显示为「始终推送」 |

静默模式三档：

| 档位 | 含义 |
| --- | --- |
| `session`（默认） | 你正看着这条通知所属的会话时不打扰 |
| `tab` | 只要任一 DSH 标签页可见且持有焦点就不打扰 |
| `never` | 从不静默 |

改动由设置服务写回 profile 的 `cordis.patch.yml` 并由 loader 就地重载，**不需要重启**。

少数配置项只在 profile 的 `cordis.patch.yml` 里改（不在设置页）：`launchMode`（原生 Toast 点击方式，默认 `browser`；改动需重启 `dsh web`）、`startupWaitMs`（启动播报等页面的上限，默认 5000）、`claimWaitMs`（投递后等认领的上限，默认 1500）。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 什么通知都不弹 | 先跑上面的冒烟测试确认发送层本身可用；再看插件是否加载（开启调试模式后看日志文件里有没有 `plugin ready`）；确认系统通知设置里「DSH」未被专注助手/勿扰拦截 |
| 提示 `Cannot find package 'koffi'`（仅 Windows） | profile 里缺运行时依赖，**整个插件都不会加载**（不是只少发送层）：在插件管理里卸载后重新安装本插件，让管理器重新装依赖 |
| 插件装好后不见了 / 不再弹通知（Windows） | 多半是 profile 里跑过别的 `npm install` 把它清掉了：用插件管理重新安装本插件，它会被登记为 profile bundle，不再受此影响 |
| 不确定 koffi 到底从哪加载 | 在 profile 目录里执行 `node -e "console.log(require.resolve('koffi'))"`：路径应落在 `profiles/web/node_modules/` 下；若指向 DSH 自己的目录（例如 `deepseek-harness/...`），说明只是借用上游依赖，DSH 换布局就会失效 |
| Linux 没有通知 | 必须是有桌面会话的环境（`echo $DBUS_SESSION_BUS_ADDRESS` 或 `/run/user/$(id -u)/bus` 存在）；纯 SSH/容器里没有会话总线，日志会出现 `D-Bus 连接失败`（同一原因只打一条，失败后 30 秒内不重连） |
| 离开聚焦会话也不弹 | 开启调试模式看日志：确认 `notify` 是否触发、`session=` 与 `silenced=` 的值、`fire` 是否执行；若 `silenced=false` 却一直不弹，看 `plugin ready (…, backend=…)` 是否为 `none` |
| 后台任务结束不弹 | 先看 `GET /dnotify/status` 的 `jobLog`：出现 `hooked` 说明事件流订阅挂上了，出现 `type=settled` 说明结算事件到了（`awaited=true` 也会通知）；再看 `notifyLog` 里该条的出口（`silenced` 表示你正看着那个会话） |
| 定时任务提醒不弹 / 一创建就弹 | 提醒应在**触发时**出现，不是创建时。看 `/status` 的 `scheduleLog`：`schedule/changed` 表示 DSH 的广播到达了，`delivered` 表示判定为"刚触发"；只有前者说明只是创建/编辑 |
| 启动播报里运行模式写着降级 | 说明发送那一刻没有"已授权通知权限的在线页面"：刷新 DSH 页面并在卡片上点「设置」授权，下次重启即显示 `正常` |
| 这条提醒为什么没弹 | 直接看 `/status`：`lastRoute`（走了 Web Notification 还是降级原生 Toast，以及原因）、`lastNotify`/`notifyLog`（`silenced` 你正看着该会话 / `duplicate` 去重窗口内 / `queued` 已入队）、`eventLog`（钩子事件到底有没有到达插件）。令牌是进程级的，从通知点击地址里的 `t=` 取 |
| 通知图标在浅色主题下看不见 | 说明用的是白鱼图标：确认 `node scripts/theme-probe.mjs` 报出的当前主题是否正确、`assets/dsh-light.*` 是否存在；主题切换后最多等 60 秒兜底重读生效 |
| 点了通知没跳转 | 看 `/status` 的 `lastActivate`（决策是 `deliver` / `open` / `ignore`）、`pending`（有投递但没人认领）、`lastClaim` 与 `lastNavigate`（`not-found` 表示目标会话不在客户端目录里）；`recentSent` 能确认那条通知究竟可不可点击 |
| 聚焦判定异常（该静默没静默/该推没推） | 确认页面加载的是最新 `client.js`（Ctrl+F5 强制刷新）；聚焦判定 = `visibilityState === 'visible' && document.hasFocus()` |
| 通知中心图标是空白/默认图标 | AUMID 键未写成功：`Get-ItemProperty 'HKCU:\SOFTWARE\Classes\AppUserModelId\DSH'` 应能看到 `DisplayName`/`IconUri`；缺失时重启 `dsh web`（插件首次发送也会补写一次，失败后 1 分钟会再试） |
| 只有部分类别弹 | 逐类核对设置页里的开关与静默档位；「审批被自动拒绝」仅当审批政策为 `never` 且确有操作被拒时触发 |

## 调试开关

默认关闭。勾选设置页的**调试模式**，或等价地在 profile 的 `cordis.patch.yml` 覆盖 `desktop-notify` 行：

```yaml
- id: desktop-notify
  config: { debug: true }
```

状态日志写入 `$DSH_HOME/logs/dsh-desktop-notify/dsh-desktop-notify.log`（>1MB 轮转，保留 5 份），包含 notify 决策、聚焦上报、fire、job settled、主题等；同一个文件也接住本插件 fiber 上的 cordis 日志。**错误**日志不受开关限制，仍然打到终端。
