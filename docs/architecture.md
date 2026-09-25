# 架构

## 包结构

```
lib/index.js          宿主半区（ESM，export name/inject/apply(ctx, config)；按平台动态加载发送层）
lib/gate.js           按"页面 × 会话"的聚焦门控（纯逻辑，tests/gate.test.mjs 覆盖）
lib/api.js            对外推送 API（desktopNotify 服务的载荷归一与双模式路由，tests/api.test.mjs 覆盖）
lib/winrt.js          Windows 发送层（koffi 直调 WinRT + AUMID 注册表写入）
lib/win32-registry.js Win32 注册表与等待句柄（winrt.js 与 theme-win32.js 共用同一批声明）
lib/toast-linux.js    Linux 发送层（Notify 编组；连接/调用交给 lib/dbus.js）
lib/dbus.js           D-Bus 会话总线客户端（SASL → Hello → 方法调用/回复配对/信号订阅/重连，tests/dbus.test.mjs 覆盖）
lib/theme.js          系统深浅色状态机 + 平台后端分发（60s 兜底重读）
lib/theme-codec.js    主题判定纯逻辑（注册表 DWORD / portal color-scheme / 环境变量）
lib/theme-win32.js    Windows 主题后端（注册表读取 + RegNotifyChangeKeyValue 变更事件）
lib/theme-linux.js    Linux 主题后端（xdg-desktop-portal Read + SettingChanged 信号）
lib/icons.js          按主题解析图标路径（深浅两套 + 旧路径回退，tests/icons.test.mjs 覆盖）
lib/state.js          有界容器与去重（tests/state.test.mjs 覆盖）
lib/text.js           代理对安全的截断（tests/text.test.mjs 覆盖）
lib/client.js         浏览器半区（window.__ModuleLoader__.load 包裹，标准 cordis client 插件）
assets/               通知图标：dsh-dark.{png,ico} 白鱼 / dsh-light.{png,ico} 黑鱼；dsh.{png,ico} 兼容副本
                      （均由 scripts/make-icon.py 从 dsh-logo.svg 栅格化）
scripts/              install.ps1 / install.sh（安装）、check-syntax.mjs（语法自检）
                      winrt-probe.mjs（真发一条 Toast）、theme-probe.mjs（主题检查+切换事件自检）
                      dsh-runtime-probe.mjs（把宿主半区挂进 DSH 自带的 cordis 跑契约自检）、make-icon.py（图标生成）
tests/                node --test 单测（含 tests/host.test.mjs 的宿主事件流集成测试）
cordis.patch.yml      bundle patch：把宿主半区作为一行插入 web profile composition（含 config.debug 默认值）
```

## 对外提供的服务

| 服务 | 内容 | 说明 |
| --- | --- | --- |
| `desktopNotify` | `push(item)` / `pushAlways(item)` / `notify(item)` | `ctx.provide` 注册；`push` 走聚焦门控（按会话）并如实返回是否入队，`pushAlways` 绕过门控，`notify` 返回 `{ ok, queued, silenced, reason }`。载荷 `{ title, message?, urgency?, sessionId? }`，逻辑在 `lib/api.js` |

其它插件 `ctx.get('desktopNotify')` 取用（可选服务），或 `inject: ['desktopNotify']` 声明硬依赖。

## 常驻加载（无需审批）

`dsh-desktop-notify` 是一个 **web profile bundle**：

1. 包内 `cordis.patch.yml` 声明一行 `- id: desktop-notify / name: 'dsh-desktop-notify'`；
2. profile 的 `package.json` 在 `dsh.profile.bundles` 中登记本包——每次 `dsh web` 启动，loader 按 bundle 层组合该行；
3. 行存在即成为 loader entry，`dsh-client-modules` 扫描到包的 `dsh.client` 声明后，通过 `/plugins/<id>/client.js` 提供浏览器半区；
4. 与动态插件不同，bundle 行属于 profile 本身，**不产生审批请求**；
5. 插件行 `config`（默认 `{ debug: false }`）在 profile 层可覆盖——调试日志开关。

## 宿主半区依赖的服务

| 服务 | 用途 | 获取方式 |
| --- | --- | --- |
| `connection` | Connection RPC 通道 `/dnotify`（页面聚焦与选中会话上报） | `inject`（硬依赖） |
| `timer` | 去抖 / 队列间隔（`ctx.timeout`） | `inject`（硬依赖） |
| `fs` | 解析工作目录（派生工作区名） | `ctx.get`（可选） |
| `agents` / `sessions` / `sessionTitle` | 根 agent 过滤 / 会话与主会话解析 / 会话标题 | `ctx.get`（可选，每次用时惰性取） |
| `jobs` | 后台任务完成通知（`jobs.events.subscribe({ owners: 'all' }, …)` 的 `settled` 事件；0.1.7 起 `onJobDone` 已移除） | 用 `ctx.inject(['jobs'], …)` 延迟注册——**不能**只在 apply 里 get 一次，晚挂载的 jobs 会让钩子永不注册 |

浏览器半区读客户端 `sessions` 快照里"被主视图保留"的会话（`byId[*].retainedBy.mainView > 0`，与官方 ui-layout/ui-session 同一判据；0.1.7 的快照里**没有** `current` 字段），并订阅 `list.subscribe` 观察切换；取不到就上报 `null`，宿主对"归属不明"的通知照常推送。上报走官方连接服务 `ctx.get('connection').rpc.call('/dnotify', 'page-focus', payload)`；只有 `pagehide` 那一次改用手写 `fetch`（需要 `keepalive`，官方封装不暴露每次调用的 init），且 URL 用文档相对形式（挂载在子路径下也正确）。

发送层不需要任何宿主服务：`lib/index.js` 按 `process.platform` 动态 import（win32 之外不会加载 koffi）。Windows 侧 `koffi` 是包依赖：`winrt.js` 顶层就 `koffi.load('combase.dll')`，所以 **koffi 解析不到时整个插件都不会加载**（不是"只是发不出通知"）。Linux 侧只用 `node:net` 连 Unix 套接字，零额外依赖。

## 平台分发

| 平台 | 发送层 | 主题后端 | 说明 |
| --- | --- | --- | --- |
| `win32` | `lib/winrt.js` | `lib/theme-win32.js` | koffi 直调 WinRT 发 Toast；首次发送补写 AUMID 注册表图标，主题变化时改写；注册表变更事件用 `RegNotifyChangeKeyValue` + 2s 非阻塞句柄检查 |
| `linux` | `lib/toast-linux.js` | `lib/theme-linux.js` | 纯 JS 直连 D-Bus `org.freedesktop.Notifications.Notify`，与主题跟踪共用一条常驻连接；主题读 portal `color-scheme` 并订阅 `SettingChanged` |
| 其它 | 无 | 无 | 只打印一次"当前平台暂无通知后端"，不抛错、不影响宿主；主题保持默认深色（白鱼图标） |

主题通道不可用时（Windows 策略拦注册表通知、Linux 没有 portal）两条链路都还有 60s 兜底重读；读不到主题时保持上一次结果，绝不把"读不到"当成浅色。

## 状态与副作用

- 全部监听器、定时器、effect 都挂在插件 Fiber 上（`ctx.on` / `ctx.effect` / `ctx.timeout` 返回的 disposer），插件停止或更新时自动清理（卸载时顺带停掉主题跟踪、关掉 Linux 侧的 D-Bus 连接）；
- **聚焦门控状态（`lib/gate.js`）**：`pages` = pageId → `{at, sessionId}`（该页面最近聚焦上报时间 + 当前选中会话）；静默判定按会话而非全局，10 分钟无上报的条目自动移除（异常关闭兜底）；
- **缓存（`lib/state.js` 的有界容器）**：`lastTextBySession`（会话产出记录 + 回复摘要 128 条，任务完成消费即释放）、`askAtBySession`（提问时刻 32 条，15s 抑制）、`asksById`（审批配对 64 条，decided 即删）——超出上限先丢最旧的，常驻进程不随会话数增长；全部只缓存标量叶子字段，不持有 live 对象；
- **去重**：同来源同文案 1.5 秒窗口内只弹一次（事件重复派发、失败重投都不连弹）；去重键 = 标题 + 正文 + 来源标识（`job.id` / approval id / `runId` / 目标 revision）+ 会话归属，两个同名任务或两个并行会话的同类提醒不会被合并；
- **定时器**：`later()` 返回自注销的取消函数——被提前取消（idle 3s 去抖被下一次状态变化打断）时条目同时从集合里摘掉，常驻进程不会攒下作废的 disposer；
- **队列**：待发通知最多 32 条（超出丢最旧），成功路径 200ms 一条，失败单次重排队；
- 无持久化状态：重启即从零开始，事件流自然重建上下文（Linux 侧 D-Bus 连接也是进程内复用，未连上时最多缓存 32 条待发）。

## 故障排查

- 状态日志默认关闭（`config.debug: false`），排查时在 profile 层开启后看终端 `[dsh-desktop-notify]` 前缀输出（notify 决策/聚焦上报/fire/job settled/主题）；
- 错误日志（`console.error`）不受开关限制：koffi 加载失败、WinRT 调用失败码、D-Bus 连接/认证/被拒错误、主题切换事件注册失败、钩子异常；
- 主题与图标自检：`node scripts/theme-probe.mjs`（打印当前主题/两套图标路径，并用临时注册表键验证切换事件链路，不碰系统主题）；
- 契约自检（**DSH 升级后先跑这个**）：`node scripts/dsh-runtime-probe.mjs` 把宿主半区挂进 DSH 自带的 cordis（默认 checkout `D:\Program\deepseek-harness`，可用 `DSH_CHECKOUT` 覆盖）里，验证服务注入、作用域事件投递、`ctx.inject` 延迟注册、`ctx.provide` 注销、`ctx.effect` 清理——全程用 `config.sender` 收口，**不发真实通知**。加 tsx 运行可多验一项作用域事件投递（见脚本头部注释）；
- Windows 端到端自检：`node scripts/winrt-probe.mjs`（注册 AUMID + 真发一条 Toast）；
- 浏览器半区问题看页面控制台的 `dnotify` RPC 报错（envelope 校验失败会抛 `dnotify RPC …`）；
- 插件未激活：用 `dsh web --dump-config` 确认 composition 里存在 `desktop-notify` 行；确认 `connection`/`timer` 服务在 web profile 中存在。
