# DSH 桌面通知（dsh-desktop-notify）

为 [DSH](https://github.com/deepseek-ai/dsh) 打造的桌面通知插件（Windows / Linux），随 `dsh web` 启动自动加载（无需审批）。

## 依赖需求

| 项 | 要求 |
| --- | --- |
| **DSH** | **`>= 0.1.7-rc.2` 且 `<= 0.2.0-rc.2`**（**只承诺实测过的这条线**；0.2.x 的其它小版本可能有破坏性改动，不预先声称兼容。两个版本之间本插件依赖的服务面——`connection` / `webServer` / `jobs` / `subagent` / `schedule` / `scope` / `loader` / cordis——零改动） |
| 包内声明 | `peerDependencies: { "@deepseek-ai/dsh": ">=0.1.7-rc.2 <=0.2.0-rc.2" }`，DSH 启动时的兼容性预检会据此拦下不匹配的组合（含更新的 0.2.x） |
| 运行时 | Windows 需要 [koffi](https://koffi.dev/)（发 WinRT Toast，安装脚本会处理）；Linux 无额外依赖（纯 JS 直说 D-Bus） |
| 浏览器 | Firefox / Chromium 系（Web Notification 路线依赖 Service Worker 与 `WindowClient.focus()`，见下） |

## 能力

- **任务完成**：agent 干完活回到空闲时，弹「✅ DSH 任务完成」+「工作区/会话名:结尾输出内容」
- **等待你回答**：AI 发起 `ask_user_question` 提问时，弹「❓ DSH 等待你的输入」提醒你回来
- **审批被自动拒绝**：`never` 审批政策下操作被静默拒绝时，弹「🚫 DSH 操作被自动拒绝」告知
- **后台任务结束**：后台子代理 / 目标完成或卡住 / 后台命令任务结束时逐一提醒
- **定时任务触发**：定时任务**真正被投递（触发）时**提醒；只创建、还没触发时不打扰
- **启动播报**：每次 `dsh web` 启动后推一条「🚀 DSH 插件挂载成功」（正文 `共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：正常/降级`）；有插件异常时标题改为「⚠️ DSH 插件挂载异常」、正文列出数量与 id。每次启动只推一次
- **点击跳转**：会话类与页面类通知点击后跳回对应位置；没有跳转目标的通知点了只会消失
- **两种通知渠道**：有在线 DSH 页面且浏览器已授权时走 **Web Notification**（点击由浏览器自己精确激活标签页，零中转页）；否则降级为**原生 Toast**（点击新开标签页跳 DSH 深链，正文会标注「降级模式」）
- **标题一律带 `DSH` 前缀**：通知的图标与来源行由"谁发的通知"决定（Web Notification 显示浏览器身份，无法修改），所以品牌位落在标题上——每条通知标题都是「emoji + DSH + 内容」
- **权限变更即时通知**：标题「⚠️ DSH 权限变更」，正文 `dsh-desktop-notify 跟踪到消息提醒权限变更为:xxx，插件运行模式同步变更为xxx`（`xxx` 为 `granted`/`denied`/`default` 与 `正常`/`降级`）；不受聚焦门控静默，重复回报同一状态不打扰
- **DSH 图标**：原生 Toast 的图标与应用身份均用 DSH Logo（透明底 PNG/ICO），深浅两套按系统主题自动切换
- **原生直连发送**：Windows 用 koffi 直调 WinRT，Linux 直连 D-Bus（`org.freedesktop.Notifications`）——**无 Python、无子进程**

## 安装

**走 DSH 自带的插件安装器，不要用 shell 脚本手工往 profile 里拷** —— 依赖安装、bundle 选择、启用都由安装器负责（官方文档明确要求不要用 shell 复刻这些步骤）。

前置条件：**已启动过一次 `dsh web`**（需已生成 web profile）。不需要 Python、不需要 pip。

1. 取到插件目录：`git clone https://github.com/Mvyvn/dsh-desktop-notify.git`（也可以直接在 DSH 里填这个仓库地址）。
2. 在 DSH 里打开**插件管理** → **「添加插件」**，安装目标填：**本机插件目录的实际路径**（推荐，离线可用）或 **GitHub 仓库地址**。
3. 安装器会装好运行时依赖（`koffi`，已在 `dependencies` 里声明）、把本包选为 profile bundle 并启用；若它报告有待批准的安装脚本，按提示确认即可。
4. **完全重启 `dsh web`**（结束进程重开，不是刷新页面），并**刷新一次 DSH 页面**。

包清单本身就是一份合规 bundle：`dsh.bundle.patch` 指向 `cordis.patch.yml`（挂载宿主半区那一行），`dsh.client` 声明浏览器半区，`koffi` 是普通 `dependencies`。AUMID `DSH` 注册表键由**插件自己**在启动时按当前系统主题写好（`DisplayName` 固定为 **DeepSeek Harness**），不依赖任何安装脚本。

> ⚠️ 别用 `pnpm add dsh-desktop-notify` / `npm install dsh-desktop-notify`：npm 上有个**同名但无关**的插件，会装错。按上面填**本机目录路径**或本仓库地址即可。

### 首次使用：授予通知权限（走 Web Notification 路线时必需）

浏览器要求**用户手势**才弹授权框，所以插件不做自动弹窗，而是在 DSH 页面里显示一个一次性的居中提示：

> **开启桌面通知**（DSH 界面风格的模态卡片：遮罩 + 卡片 + 标题 + 说明 + 右下角按钮；高 32px、圆角 8px 的按钮，外观逐项对齐 DSH 自己的弹窗（`ui-primitives/Modal`）：背景 `--dsw-alias-bg-layer-2`、遮罩 `--dsw-alias-bg-mask-1`、圆角 `--dsw-radius-panel`、投影 `--dsw-elevation-prominent`，这些 token 的值都是**解析成实际颜色后再写进内联样式**，避免卡片挂在 `body` 上取不到作用域 token 而在深色主题下变白板）
>
> 「设置」→ 弹浏览器授权框；「取消」→ 只关掉卡片、不弹授权框。**任一标签页关掉卡片，其它标签页的卡片会跟着关**（`BroadcastChannel`，老浏览器退 `localStorage` 事件）；每次显示前还会清掉可能残留的旧卡片。

点「设置」后 → 浏览器授权框出现 → 允许。授权后通知由浏览器直接显示、点击可精确切回已有 DSH 标签页。**未授权**（或拒绝）时不会失败：自动降级为原生 Toast，点击新开标签页跳转，（运行模式只出现在**启动播报**的正文里：`，dsh-desktop-notify 运行模式：正常` 或 `…：降级`）。授权被拒后需要在浏览器站点设置里手动重开。

## 通知一览

| 通知 | 触发 | 静默判定用的会话 | 正文格式 |
| --- | --- | --- | --- |
| ✅ 任务完成 | `agent/status` running→idle（仅根 agent，3 秒去抖） | 该 agent 的会话 | 工作区/会话名:结尾输出内容 |
| ❓ 等待你回答 | `tools/execute` 捕获 `ask_user_question` 派发 | **发起提问的那个会话本身** | 工作区/会话名:[类型] 内容 |
| 🚫 DSH 审批被自动拒绝 | `session/event` 流 `approval/asked`+`decided` 审计对 | **被拒操作所在会话本身** | 工作区/会话名:工具名-拒绝原因 |
| 🤖 DSH 后台子代理结束 | `subagent/end` | **母会话 + 子代理会话**（看其中任一都静默） | 工作区/母会话名:子代理名已完成 |
| 🎯 DSH 目标完成 / 阻塞 | `goal/changed` | 目标所属会话 | 工作区/会话名:目标-已完成 / 目标-阻塞原因 |
| 🧰 DSH 后台任务结束 | `jobs.events` 的 `settled`（`awaited` 也通知；`kind='subagent'` 的 job 由上一行负责） | **所属会话 + 其所属子代理的母会话** | 工作区/母会话名:后台任务名已完成/失败/被终止 |
| 🕒 DSH 团队任务待处理 / ✅ DSH 团队任务已完成 | `session/event` 的 `team/task`（只对状态变化发） | 任务 owner 的母会话 | 工作区/会话名:任务标题 |
| 🗜️ DSH 上下文已智能压缩 | `session/event` 的 `compaction/end`（带 `error` 的不报） | **该会话本身**（看着它的父/子会话也照推） | 工作区/会话名:上下文已智能压缩 |
| ⏰ DSH 定时任务已启动 | `schedule/changed` → 读 `catalog()` 比对**投递记录**（`lastDelivery` 变化才算"触发"） | **该定时任务所属会话本身** | 工作区/会话名:定时任务标题 |
| 🚀 插件挂载成功 / ⚠️ 插件挂载异常 | 插件 `apply` 后等组合稳定数一遍插件行；**等一个有权限的在线页面**再发（最多 5 秒，超时降级） | 无（始终推送） | 共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：正常/降级 / 有 N 个插件启动失败:加载失败的插件为 a、b |

前缀的"工作区"按会话动态解析（多工作区并行时各显示自己的工作区名），"会话名"取 `sessionTitle` 服务。**门控只比对会话，不影响文案；点击目标与静默判定是两件事**——例如子代理的提醒按"子代理会话"静默，但点击固定指向母会话（子会话 id 客户端目录里未必解析得到，指过去就是"点了不跳"）。

**每类推送可单独配置**（插件页 → 插件管理里的 dsh-desktop-notify 卡片 → 设置）：总开关、调试模式、对外 API 开关，以及每种通知各自的开关与**静默模式三档**：

| 静默模式 | 含义 |
| --- | --- |
| `session`（默认） | 你正看着这条通知所属的会话时不打扰 |
| `tab` | **标签页级**：只要任一 DSH 标签页可见且持有焦点就不打扰（浏览器原生的 `document.hasFocus()` + `visibilityState`） |
| `never` | 从不静默（启动播报、权限变更默认走这档） |

改动写回 profile 的 `cordis.patch.yml` 并由 loader 原地重载，**不需要重启**。

静默规则的档位是有意区分的：**子代理**看"母会话 + 子会话"，**后台任务**看"所属会话 + 其母会话"，**其余**只看"该会话本身"（你正看着它的子代理或母会话时也会推送）。

## 给其它插件调用（对外 API）

**基线协议版本：`1.0.0`**（`NOTIFY_API_VERSION`）。兼容约定：载荷里的**未知字段一律忽略**（新增可选字段不破坏老调用方）；可带 `v: '1.0.0'` 声明版本，**更高的主版本**不会中断推送，但结果里会回带 `unsupportedVersion: true`；结果对象**只增不改**；用 `capabilities` 探测能力（`push` / `pushAlways` / `notify` / `click.session` / `click.page` / `click.url` / `click.legacy-url` / `web-notification` / `dialog.four-state`），不要靠版本号猜。

本插件把自己注册成 Cordis 服务 `desktopNotify`，**你自己的插件可以直接调用它推送通知**：

```js
// 在你的插件里（宿主半区 apply）
export function apply(ctx) {
  const desktopNotify = ctx.get('desktopNotify')   // 可选服务：本插件未加载时为 undefined
  if (!desktopNotify) return

  // 1) 走聚焦门控：只有"你正在看的那个会话"会被静默
  desktopNotify.push({
    title: '构建完成',
    message: '工作区/会话:全部通过',
    urgency: 'normal',      // 'low' | 'normal' | 'critical'，缺省 normal
    sessionId: agent.session, // 可选：传了就按会话门控；不传则始终推送
  })

  // 2) 绕过聚焦门控：无论页面是否聚焦、正在看哪个会话，都弹
  desktopNotify.pushAlways({ title: '磁盘告急', message: '剩余 1GB', urgency: 'critical' })

  // 3) 想要明细（是否真的入队/是否被静默/原因）用 notify()
  const result = desktopNotify.notify({ title: '构建完成', sessionId: agent.session })
  // { ok: true, queued: false, silenced: true, reason: 'silenced' }

  // 4) 点击跳转：用 click 显式声明（四态），**不传 click 就是不可点击**
  desktopNotify.push({ title: '构建完成', sessionId: agent.session,
    click: { type: 'session', sessionId: agent.session } })          // 点了跳回该会话
  desktopNotify.push({ title: '打开文档', click: { type: 'url', url: 'https://example.com/doc' } })
  desktopNotify.push({ title: '随便看看' })                            // 点了不跳转
}
```

- 返回 `true` 表示**真的入队了**；被聚焦门控静默、命中同文案去重（1.5 秒窗口）、或当前平台没有通知后端时都返回 `false`（想区分原因用 `notify()`）。**标题为空一律 `false` 且不推送**。`pushAlways` 是"强制弹"：既不看门控也不进去重窗口。
- `title` 最长 160 字符、`message` 最长 400 字符，超出截断（不会切断 emoji 这类代理对）；队列按 200ms 间隔逐条发送，上限 32 条（超出丢最旧的）。
- **`sessionId` 只管门控，`click` 只管点击**。`click` 是四态联合：

  | `click` | 点击后 |
  | --- | --- |
  | 不传 / `null` | **不跳转**（通知不可点击） |
  | `{ type: 'session', sessionId }` | 跳到该会话（子代理会话会进子代理界面） |
  | `{ type: 'page', page: 'settings-plugins' \| 'plugins' }` | 跳到该内置页面 |
  | `{ type: 'url', url: 'https://…' }` | 打开外部地址（只接受 http/https） |

  形状不认识（缺字段、`page` 不在白名单、`url` 非 http(s)）一律当成**不可点击**——不猜测意图。旧字段 `url: 'https://…'` 仍兼容，等价于 `{ type: 'url', url }`。
- `sessionId` 可传会话对象、会话 id 或它们的数组（子代理场景可同时传主会话与子会话）。
- 想全局取用可写 `inject: ['desktopNotify']`（硬依赖，本插件缺失时你的插件不会加载）；否则用 `ctx.get` 按可选服务处理。

## 排查：为什么这条提醒没弹

宿主暴露令牌保护的诊断端点 `GET /dnotify/status?t=<进程令牌>`（令牌见通知 URL 里的 `t=`，或 profile 日志）。与通知相关的字段：

| 字段 | 含义 |
| --- | --- |
| `lastRoute` | 最近一条通知走了哪条路：`mode: "web"`（浏览器通知）或 `"native"`（原生 Toast），以及 `reason`：`no-online-page` / `permission-not-granted` / `deliver-failed` |
| `lastSwReport` | Service Worker 与页面的最近一次回报：`register` / `permission` / `shown` / `click` / `focused` / `show-error` |
| `lastNotify` / `notifyLog` | 最近若干次 `notify()` 的出口：`queued`（已入队）/ `silenced`（你正看着该会话）/ `duplicate`（去重窗口内）/ `dropped` |
| `eventLog` | 最近若干条 `session/event` 的类型——用来判断某个钩子事件**到底有没有到达插件** |
| `jobLog` | `jobs` 链路全过程：`hooked` + 每条事件的 `type/status/awaited/kind` |
| `scheduleLog` | `schedule/changed` 与 `catalog()` 比对结果（`delivered` 表示判定为"刚触发"） |

## 项目结构

```
dsh-desktop-notify/
├── src/          # TypeScript 6 源码（strict + erasableSyntaxOnly，TS7 就绪）→ 编译到 lib/
│                 # protocol.ts（ClickTarget 四态 + 线格式）、pages.ts（页面注册表状态机）
│                 # activation.ts（激活决策）、gate.ts（按会话门控）、api.ts（对外推送 API）
│                 # text.ts（截断）、notify.ts（通知载荷模型）
├── lib/          # 构建产物 + 尚未迁移的手写模块
│                 # 宿主端 index.js（路由/队列/事件/分流）+ 发送层 winrt.js（Windows / koffi 直调 WinRT）
│                 #                                   toast-linux.js（Linux / D-Bus 直连）
│                 # 主题：theme.js（状态+平台分发）、theme-win32.js（注册表+变更事件）、theme-linux.js（portal+信号）
│                 #       theme-codec.js（判定纯逻辑）、icons.js（按主题选图标）
│                 # 基础设施：dbus.js（常驻会话总线）、win32-registry.js（注册表+等待句柄）
│                 #             state.js（有界容器+去重）、client.js（浏览器端：聚焦/会话上报 + SW 注册）
├── assets/       # dnotify-sw.js（通知用 Service Worker，由宿主在 /dnotify/sw.js 提供）
│                 # 图标：dsh-dark.{png,ico}（白鱼/深色主题）、dsh-light.{png,ico}（黑鱼/浅色主题）、dsh.{png,ico} 旧路径兼容
├── scripts/      # 语法自检 check-syntax.mjs（安装走 DSH 插件管理，本目录不放安装脚本）
│                 # 冒烟测试 winrt-probe.mjs、theme-probe.mjs、契约自检 dsh-runtime-probe.mjs
│                 # 图标生成 make-icon.py（开发期换图用，需 Python）
├── tests/        # node --test 单测（协议/注册表/激活 / 宿主集成事件流 / 浏览器半区 / 门控 / API
│                 #                / D-Bus 编组 / 主题判定 / 图标解析 / 有界容器 / 文本截断 / 句柄不变量）
├── docs/         # 架构、原理、上手文档 + TS6→TS7 迁移路线
├── cordis.patch.yml
└── package.json
```

> 验证：每次提交由 Linux CI 跑（语法 / 单测 / TS→lib 一致性 / 主题 / 清单）；发布前在真机上跑 Windows 与 Linux 的 smoke —— 清单见 [docs/verification.md](docs/verification.md)。

> 构建：`npm run build`（三个配置：`tsconfig.json` 核心层 strict → `tsconfig.platform.json` 平台层 → `tsconfig.client.json` 浏览器半区按脚本编译）。`npm test` 会先自动构建；提交时请一并提交 `lib/` 下的构建产物（插件运行时直接加载 `lib/`，DSH 不做编译）。迁移进度见 [docs/migration-ts6-ts7.md](docs/migration-ts6-ts7.md)。

## 工作机制与限制

### 通知渠道（混合 backend，发送时决定）

```
产生通知
 ├─ 有在线 DSH 页面，且该页面已授予通知权限 → Web Notification
 │    页面 → Service Worker → showNotification()
 │    点击 = notificationclick → clients.matchAll() → WindowClient.focus()
 │      · 有 DSH 窗口 → 由浏览器自己把那个标签页交还给用户（精确，不靠标题猜）
 │      · 没有窗口   → clients.openWindow(<DSH 深链>) 直接开 DSH（不经过中转页）
 │    特点：零中转页、无 UIA/无障碍、无 PowerShell、点击即切
 └─ 其余情况 → 原生 Toast（Windows WinRT / Linux D-Bus）
      点击 → 打开 DSH 深链（新标签页）；降级说明只出现在**启动播报**正文里（`· 运行模式：…`）
```

- **Service Worker 是插件自带的**（`assets/dnotify-sw.js`，宿主在 `/dnotify/sw.js` 提供，带 `Service-Worker-Allowed: /`），**不是浏览器扩展**，不需要安装任何东西。
- **通知属于 Service Worker**：注册过一次后，即使所有 DSH 标签页都关了，点击仍由 SW 接管（找不到窗口就开一个新的）——所以"关掉页面还能点通知跳转"是预期行为。注意：它依赖浏览器仍然运行。
- **通知的产生**需要页面在线（本地无法唤醒 SW，除非引入 Web Push，本插件不做）——因此无页面时走原生 Toast，两条路的结果都是"能看到并跳转"。
- **来源行（应用名 + 图标）由发通知的进程决定**：Web Notification 显示浏览器的身份（Firefox 等），无法改；只有原生 Toast 显示 AUMID 的品牌名（**DeepSeek Harness**）与插件图标。二者不能兼得。
- **降级模式的判断**：页面上报的 `Notification.permission` 不是 `granted`，或通知没能推给页面。权限变化由页面侧 Permissions API 的 `onchange` **即时**上报（外加每次聚焦上报兜底），因此你在站点设置里改权限后会立刻生效并收到「⚠️ DSH 权限变更」。

### 聚焦门控（按会话，事件驱动零轮询）

浏览器半区（`lib/client.js`）通过官方 Connection RPC 通道 `/dnotify` 上报"页面是否聚焦"以及"该页面当前选中的会话"（取 harness 客户端 `sessions` 快照里被主视图保留的那个会话——`byId[*].retainedBy.mainView`，与官方 ui-layout/ui-session 同一判据，会话切换即时重报）。聚焦判定为 `visibilityState === 'visible' && document.hasFocus()`，由 `focus`/`blur`/`visibilitychange`/`pagehide` 原生事件即时触发（页面关闭经 `keepalive` 可靠上报失焦）；聚焦页面上的用户活动（键盘/鼠标/滚动，节流 10 秒）保持"保鲜"。

宿主端按"页面 × 会话"聚合（`lib/gate.js`）：

> **静默 ⇔ 存在一个正在聚焦的页面，且它当前选中的会话命中这条通知的会话列表。**

- 切到别的窗口/标签、最小化 → **立刻恢复推送**；没有任何页面聚焦 → 一律推送；
- **拿不到会话归属的通知**（例如启动播报）**永不静默**；
- 聚焦静止超 2 分钟视为失焦，异常关闭残留的页面条目 10 分钟自动清理。

### 发送层（原生直连，无子进程）

- **Windows（`lib/winrt.js`）**：koffi 直调 WinRT（`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId('DSH')` → `XmlDocument.LoadXml` → `Show`），不拉起任何 Python/子进程；发送前幂等写入 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH`（`DisplayName = DeepSeek Harness` + `IconUri`，随主题改写）。
- **Linux（`lib/toast-linux.js`）**：纯 JS 直说 D-Bus 协议（`$DBUS_SESSION_BUS_ADDRESS` 或 `/run/user/<uid>/bus`，SASL EXTERNAL → `Hello` → `org.freedesktop.Notifications.Notify`），不调用 `notify-send`；连接常驻复用、断开自动重连。`app_name` 同样是 **DeepSeek Harness**，图标随主题选。
- 两平台共用同一条发送队列：200ms 间隔防轰炸，发送失败单次重排队，队列上限 32 条。

### 主题与图标

通知背景跟随系统深浅色，而图标不会被反色，所以随包带两套透明底图标（`dsh-dark.*` 白鱼 / `dsh-light.*` 黑鱼）。`lib/theme.js` 启动时读一次、之后跟踪切换事件：**Windows** 读 `HKCU\...\Themes\Personalize\SystemUsesLightTheme`（缺失退 `AppsUseLightTheme`），用 `RegNotifyChangeKeyValue` 异步事件 + 2 秒非阻塞句柄检查拿到切换通知；**Linux** 读 xdg-desktop-portal 的 `org.freedesktop.appearance/color-scheme`，订阅同接口的 `SettingChanged` 信号（portal 不可用时退环境变量启发式）。两条通道都挂 60 秒兜底重读。

### 点击目标语义

- **会话类通知** → `session:<会话 id>`，客户端用公开服务 `ctx.get('uiWorkspace').openSession(id)` 就地切换。
- **子代理与后台任务** → 点击一律指向**母会话**（宿主沿 `header.parentSession` 回溯到顶层；中间层 id 客户端目录里往往解析不到，表现就是"点了不跳"），子代理自己的名字写在正文里。**注意这与静默判定分开**：静默按事件所属会话判定。
- **启动播报** → `page:settings-plugins`：客户端先点侧边栏的**真实设置入口**（可访问名「设置」，含桌面端的「账号菜单 → 设置」），再在设置对话框里点「内置插件」导航格并**验证它已就位**（`aria-current`）；打不开就继续重试（深链场景下页面刚加载，界面可能几秒后才挂载，最多等 10 秒）。**不会**退到侧栏「插件」页——落点错了就是错。
- `{ type: 'url' }` 目标与 DSH 页面无关，直接交给系统/浏览器打开。
- 兼容：旧字段 `url`（http/https）等价于 `{ type: 'url' }`；旧的 `#dsh-notify=<目标>` 深链与 `/dnotify/click?target=<目标>` 旧链接仍然可用。

### 其它

- **启动播报（每次启动一次）**：插件 `apply` 后等组合稳定，数一遍 `ctx.get('loader')` 里的插件行——`fiber.state` 为 ACTIVE 的算成功，FAILED / 没有 fiber / 等不来服务的一律算"没加载起来"并列出 `entry.options.id`；主动 `disabled` 的行不计入。**等一个有通知权限的在线页面**再发（最多 5 秒，超时降级为原生 Toast），以便走浏览器通知。进程级标记放在 `globalThis`，热更新重复 apply 不会重播。
- **消息缓存**：仅缓存"最近一条助手回复摘要"（≤220 字符），任务完成通知消费后即释放；按会话/按 id 的缓存全部**有界**（摘要 128 条、审批配对 64 条、提问时刻 32 条，超出淘汰最旧）；**同来源同文案** 1.5 秒内只弹一次（去重键 = 标题 + 正文 + 来源 id + 会话归属，所以两个同名后台任务、两个并行会话的同类提醒都各弹各的）。
- **`never` 政策下的审批通知**：`approval/request` waterfall 在 `never` 政策下不会派发，因此插件改从会话日志的 `approval/asked`/`approval/decided` 审计对获取被拒记录。想收到这类通知请保持审批政策为 `never`。
- **依赖系统桌面通知后端**：Windows Toast 由 WinRT 提供，Linux 由桌面会话的 D-Bus 通知服务提供；Windows **专注助手/勿扰模式**、Linux 的勿扰开关、以及浏览器层面的"静默通知"都可能吞掉通知（这类抑制无法被程序感知——`showNotification()` 依然会"成功"）。
- **平台**：Windows 已实测（Windows 11 + Firefox）；Linux 走 D-Bus（Kubuntu/KDE、Ubuntu/GNOME 等桌面会话；无桌面会话的纯 SSH 环境不会弹通知），D-Bus 编组有单测覆盖；macOS 后端暂未实现（会加载但只记录一条"无后端"提示）。
- **调试日志**：默认关闭。开启方式是在 profile 的 `cordis.patch.yml` 里覆盖 `desktop-notify` 行（`config: { debug: true }`）；开启后状态日志**写入文件而不是刷终端**：
  `$DSH_HOME/logs/dsh-desktop-notify/dsh-desktop-notify.log`（超过 1MB 轮转，保留 5 份；`$DSH_HOME` 默认 `~/.dsh`）。同一个文件也会接住本插件 fiber 上的 cordis 日志（走官方 `ctx.logger.exporter()`）。**错误**日志不受开关限制，仍然直接打到终端。除了日志，`/dnotify/status` 的诊断字段（见上）更适合事后核对。

## 许可证

**GNU General Public License v3.0 或更高版本（GPL-3.0-or-later）** — 全文见 [LICENSE](LICENSE)，版权与署名：**© 2026 沐云 (Mvyvn) &lt;mvyvn@qq.com&gt; 及贡献者**（名单见 `package.json` 的 `author` / `contributors`）。

- **可以**：自由使用、复制、分发、修改，**包括商业用途**（公司内部使用、随产品分发、收费服务都可以）。
- **必须**：① **署名**——无论分发原版还是修改版，都必须**带上作者署名与版权声明**（上面那一行，以及 `package.json` 里的 `author` / `contributors`），不得删除或替换成自己的名字；② **开源**——分发修改版时，必须按同一许可证公开完整对应源码并标明改动。
- 不提供任何担保（详见 GPL 第 15、16 条）。

> 本程序是自由软件：你可以按自由软件基金会发布的 GNU 通用公共许可证（第 3 版，或你选择的任何更高版本）条款重新分发和/或修改它。本程序希望它有用，但**没有任何担保**，甚至没有适销性或特定用途适用性的默示担保。
