# 架构

## 包结构

```
lib/index.js   宿主半区（ESM，export name/inject/apply(ctx, config)）
lib/client.js  浏览器半区（window.__ModuleLoader__.load 包裹，标准 cordis client 插件）
assets/        通知图标 dsh.png / dsh.ico（DSH Logo，透明底；由 scripts/make-icon.py 栅格化）
scripts/       install.ps1 / install.sh、make-icon.py（图标生成）、register-aumid.py（AUMID 注册）
cordis.patch.yml   bundle patch：把宿主半区作为一行插入 web profile composition（含 config.debug 默认值）
```

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
| `connection` | Connection RPC 通道 `/dnotify`（页面聚焦上报） | `inject`（硬依赖） |
| `timer` | 去抖 / 队列间隔 | `inject`（硬依赖） |
| `subprocess` | spawn 常驻 Python 助手 | `ctx.get`（可选） |
| `sandboxPolicy` / `fs` | 解析工作目录（python spawn 的 cwd） | `ctx.get`（可选） |
| `agents` / `sessions` / `sessionTitle` | 根 agent 过滤 / 会话与主会话解析 / 会话标题 | `ctx.get`（可选） |
| `jobs` | 后台任务完成通知 | `ctx.get`（可选） |

## 状态与副作用

- 全部监听器、定时器、effect 都挂在插件 Fiber 上（`ctx.on` / `ctx.effect` / `ctx.timeout` 返回的 disposer），插件停止或更新时自动清理；常驻 helper 在卸载时 `terminate()`；
- **`pages`**：页面聚焦聚合集合（pageId → 最近聚焦上报时间），任一页面聚焦即静默；10 分钟无上报的条目自动移除（异常关闭兜底）；
- **缓存**：`lastTextBySession`（回复摘要，任务完成消费即释放）、`askAtBySession`（提问时刻，15s 抑制，惰性清理）、`asksById`（审批配对，decided 即删）——全部只缓存标量叶子字段，不持有 live 对象；
- 无持久化状态：重启即从零开始，事件流自然重建上下文。

## 故障排查

- 状态日志默认关闭（`config.debug: false`），排查时在 profile 层开启后看终端 `[dsh-desktop-notify]` 前缀输出（notify 决策/聚焦上报/fire/onJobDone）；
- 错误日志（`console.error`）不受开关限制：python 解析失败、spawn 失败、非零退出、钩子异常；
- 浏览器半区问题看页面控制台的 `dnotify` RPC 报错（envelope 校验失败会抛 `dnotify RPC …`）；
- 插件未激活：用 `dsh web --dump-config` 确认 composition 里存在 `desktop-notify` 行；确认 `connection`/`timer` 服务在 web profile 中存在。
