# 架构

## 包结构

```
lib/index.js   宿主半区（ESM，export name/inject/apply）
lib/client.js  浏览器半区（window.__ModuleLoader__.load 包裹，标准 cordis client 插件）
cordis.patch.yml   bundle patch：把宿主半区作为一行插入 web profile composition
```

## 常驻加载（无需审批）

`dsh-desktop-notify` 是一个 **web profile bundle**：

1. 包内 `cordis.patch.yml` 声明一行 `- id: desktop-notify / name: 'dsh-desktop-notify'`；
2. profile 的 `package.json` 在 `dsh.profile.bundles` 中登记本包——每次 `dsh web` 启动，loader 按 bundle 层组合该行；
3. 行存在即成为 loader entry，`dsh-client-modules` 扫描到包的 `dsh.client` 声明后，通过 `/plugins/<id>/client.js` 提供浏览器半区；
4. 与动态插件不同，bundle 行属于 profile 本身，**不产生审批请求**。

## 宿主半区依赖的服务

| 服务 | 用途 | 获取方式 |
| --- | --- | --- |
| `connection` | Connection RPC 通道 `/dnotify`（页面可见性上报） | `inject`（硬依赖） |
| `timer` | 去抖 / 队列间隔 | `inject`（硬依赖） |
| `subprocess` | spawn Python 发 Toast | `ctx.get`（可选） |
| `sandboxPolicy` / `fs` | 解析工作目录（python spawn 的 cwd） | `ctx.get`（可选） |
| `agents` / `sessionTitle` | 根 agent 过滤 / 会话标题 | `ctx.get`（可选） |
| `jobs` | 后台任务完成通知 | `ctx.get`（可选） |

## 状态与副作用

- 全部监听器、定时器、effect 都挂在插件 Fiber 上（`ctx.on` / `ctx.effect` / `ctx.timeout` 返回的 disposer），插件停止或更新时自动清理；
- 仅缓存标量叶子字段（会话 id → 摘要文本、审批 id → 工具名/原因），不持有 live 对象；
- 无持久化状态：重启即从零开始，事件流自然重建上下文。

## 故障排查

- 宿主日志按 `[dsh-desktop-notify]` 前缀输出：python 解析失败、spawn 失败、非零退出、钩子异常；
- 浏览器半区问题看页面控制台的 `dnotify` RPC 报错（envelope 校验失败会抛 `dnotify RPC …`）；
- 插件未激活：用 `dsh web --dump-config` 确认 composition 里存在 `desktop-notify` 行；确认 `connection`/`timer` 服务在 web profile 中存在（`dsh-skill-manager` 等 bundle 依赖同一批服务）。
