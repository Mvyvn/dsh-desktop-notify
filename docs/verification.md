# 验证矩阵（维护期）

目标不是"再搭一套 E2E"，而是把**已经存在的三个探针**放进明确的节奏里，让"改坏了什么"在正确的阶段暴露。

## 每次提交（自动，Linux CI）

`.github/workflows/ci.yml`，矩阵 Node 20 / 24，`timeout-minutes: 10`：

| 步骤 | 覆盖什么 |
| --- | --- |
| `npm ci --ignore-scripts` | 依赖可安装（含 koffi 的平台预编译包）；不需要原生构建 |
| `npm run check` | 每个 `lib/*.js` 的语法 + 仓内 `.ps1` 的 UTF-8 BOM（当前仓库没有 `.ps1`，规则保留） |
| `npm test` | `pretest` 先构建（三个 tsconfig）→ 全部单测：宿主事件流、门控、公开 API、D-Bus 编组、主题判定、图标、状态容器、客户端半区、**常驻句柄不钉住事件循环** |
| `git diff --exit-code -- lib` | `lib/` 与 `src/` 一致：改了源码却忘记提交产物会在这里失败 |
| `node scripts/theme-probe.mjs` | 主题探测在 Linux 路径下不炸（无桌面总线时也不炸） |
| 清单校验 | `package.json` 的 `name` / `dsh.bundle` / `dsh.client.platform` |

**CI 里跑不到的**（runner 没有桌面会话、没有 AUMID、没有真实点击）：WinRT Toast 本身、AUMID、自定义协议注册与激活、真实通知点击、真实桌面 D-Bus。
`scripts/dsh-runtime-probe.mjs` 也不在 CI：它需要一份 `deepseek-harness` 源码 checkout + tsx。

## 发布前（真机 smoke）

### Windows

```powershell
node scripts/winrt-probe.mjs        # 真实 Toast：图标、AUMID、协议激活路径
node scripts/theme-probe.mjs        # 注册表主题（HKCU\...\Themes\Personalize）
node scripts/dsh-runtime-probe.mjs  # 把插件挂进 DSH 自带 cordis 跑契约自检（需 harness checkout）
```

再手工点一次通知，按当前渠道确认：

1. **Web Notification（有在线页面 + 已授权，默认走这条）**：通知由浏览器弹出 → 点击后**浏览器自己**切到已有 DSH 标签页（若标签页已关，则新开一个并跳转）。核对 `GET /dnotify/status?t=<当前令牌>`：
   - `lastRoute` 应为 `{"mode":"web", …}`；若为 `"native"`，看它的 `reason`（`no-online-page` / `permission-not-granted` / `deliver-failed` / `no-shown-ack` / `show-error`）。
   - `lastSwReport` 应依次出现 `shown` 与 `{"kind":"focused","how":"by-pageId","focused":true}`（`how=by-pageId` 表示按 clientId 精确命中，而不是靠标题猜）。
2. **降级路径（原生 Toast）**：把浏览器里的通知权限改成"阻止"（或关掉 DSH 页面）→ 通知变为原生 Toast → 点击后**新开一个标签页**跳到 DSH 深链（`#dsh-notify=<目标>`），不经过任何中转页。
3. **权限引导**：清除权限后刷新页面，应出现一次性的居中卡片「开启桌面通知」；点「设置」才会弹浏览器授权框。
4. **启动播报**：重启后应在数秒内（等一个有权限的在线页面，最多 5 秒）发出，标题应为「🚀 DSH 插件挂载成功」、正文以 `共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：` 开头；点它应落在 **设置 → 内置插件**（不是侧栏「插件」页）。
5. **设置页**：打开插件管理里的 @mvyvn/dsh-desktop-notify 卡片，确认状态行、总开关、对外 API、调试模式与 11 类推送的开关/静默档位都在；改一项后**不重启**，行为应立即变化（`/status` 的 `config` 反映新值）。
6. **两类后台提醒**：创建一个定时任务（**创建时不提醒**）→ 等它**触发**时应收到「⏰ 定时任务已启动」；跑一个母会话的后台任务，结算后应收到「🧰 后台任务结束」。核对 `/status` 的 `scheduleLog`（应出现 `delivered`）与 `jobLog`（应出现 `type=settled`，`awaited=true` 同样通知）。

### Linux（KDE / GNOME 各一次）

```bash
node scripts/theme-probe.mjs   # portal（org.freedesktop.appearance color-scheme）路径
```

再手工点一次通知（`ActionInvoked` → 宿主 `/dnotify/activate`），并在**没有**会话总线时确认进程不崩、不挂。

## 不变量（改动时最容易破的）

1. **常驻句柄一律 unref**：SSE 心跳、D-Bus 常驻 socket、请求超时计时器、主题兜底/轮询计时器。
   插件不得让宿主进程无法结束 —— `tests/handles.test.mjs` 用"假总线 + 子进程能否自己退出"把它钉死。
2. **SSE 断连严格幂等**：`req.on('close')` 与 `res.on('close')` 各来一次，只有第一次能递减注册表的连接计数，
   否则活着的页面会被误判成不可投递 → 退化成新开标签。
3. **认领 ≠ 跳转**：`claim` 只代表"某个页面接了这一单"，结果由客户端回报 `/dnotify/navigated`。
