# 架构

## 包结构

```
lib/index.js   宿主半区（ESM，export name/inject/apply(ctx, config)）
lib/gate.js    按"页面 × 会话"的聚焦门控（纯逻辑，tests/gate.test.mjs 覆盖）
lib/api.js     对外推送 API（desktopNotify 服务的载荷归一与双模式路由，tests/api.test.mjs 覆盖）
lib/winrt.js   Windows 发送层（koffi 直调 WinRT + AUMID 注册表写入）
lib/client.js  浏览器半区（window.__ModuleLoader__.load 包裹，标准 cordis client 插件）
assets/        通知图标 dsh.png / dsh.ico（DSH Logo，透明底；由 scripts/make-icon.py 栅格化）
scripts/       install.ps1 / install.sh（安装）、winrt-probe.mjs（Windows 冒烟测试）、make-icon.py（图标生成）
tests/         node --test 单测
cordis.patch.yml   bundle patch：把宿主半区作为一行插入 web profile composition（含 config.debug 默认值）
```

## 对外提供的服务

| 服务 | 内容 | 说明 |
| --- | --- | --- |
| `desktopNotify` | `push(item)` / `pushAlways(item)` | `ctx.provide` 注册；`push` 走聚焦门控（按会话），`pushAlways` 绕过门控。载荷 `{ title, message?, urgency?, sessionId? }`，逻辑在 `lib/api.js` |

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
| `timer` | 去抖 / 队列间隔 | `inject`（硬依赖） |
| `sandboxPolicy` / `fs` | 解析工作目录（派生工作区名） | `ctx.get`（可选） |
| `agents` / `sessions` / `sessionTitle` | 根 agent 过滤 / 会话与主会话解析 / 会话标题 | `ctx.get`（可选） |
| `jobs` | 后台任务完成通知 | `ctx.get`（可选） |

浏览器半区读客户端 `sessions` 服务（`list.getSnapshot().current` = 当前选中会话，`list.subscribe` 观察切换）；取不到就上报 `null`，宿主对"归属不明"的通知照常推送。

发送层不需要任何宿主服务：Windows 走 koffi 直调 WinRT（`koffi` 是包依赖，需在 profile 的 `node_modules` 中可解析）。

## 状态与副作用

- 全部监听器、定时器、effect 都挂在插件 Fiber 上（`ctx.on` / `ctx.effect` / `ctx.timeout` 返回的 disposer），插件停止或更新时自动清理；
- **聚焦门控状态（`lib/gate.js`）**：`pages` = pageId → `{at, sessionId}`（该页面最近聚焦上报时间 + 当前选中会话）；静默判定按会话而非全局，10 分钟无上报的条目自动移除（异常关闭兜底）；
- **缓存**：`lastTextBySession`（回复摘要，任务完成消费即释放）、`askAtBySession`（提问时刻，15s 抑制，惰性清理）、`asksById`（审批配对，decided 即删）——全部只缓存标量叶子字段，不持有 live 对象；
- 无持久化状态：重启即从零开始，事件流自然重建上下文。

## 故障排查

- 状态日志默认关闭（`config.debug: false`），排查时在 profile 层开启后看终端 `[dsh-desktop-notify]` 前缀输出（notify 决策/聚焦上报/fire/onJobDone）；
- 错误日志（`console.error`）不受开关限制：koffi 加载失败、WinRT 调用失败码、钩子异常；
- 浏览器半区问题看页面控制台的 `dnotify` RPC 报错（envelope 校验失败会抛 `dnotify RPC …`）；
- 插件未激活：用 `dsh web --dump-config` 确认 composition 里存在 `desktop-notify` 行；确认 `connection`/`timer` 服务在 web profile 中存在。
