# 验证矩阵（维护期）

目标不是"再搭一套 E2E"，而是把**已经存在的三个探针**放进明确的节奏里，让"改坏了什么"在正确的阶段暴露。

## 每次提交（自动，Linux CI）

`.github/workflows/ci.yml`，矩阵 Node 20 / 24，`timeout-minutes: 10`：

| 步骤 | 覆盖什么 |
| --- | --- |
| `npm ci --ignore-scripts` | 依赖可安装（含 koffi 的平台预编译包）；不需要原生构建 |
| `npm run check` | 每个 `lib/*.js` 的语法 + `install.ps1` 的 UTF-8 BOM |
| `npm test` | `pretest` 先构建（三个 tsconfig）→ 153 项单测：宿主事件流、门控、公开 API、D-Bus 编组、主题判定、图标、状态容器、客户端半区、**常驻句柄不钉住事件循环** |
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

再手工点一次通知，确认：落地页立即出现 → DSH 页面**就地**切过去（不新开标签）；
然后 `GET /dnotify/status?t=<当前令牌>` 看 `lastClaim`（谁认领了）与 `lastNavigate`
（认领后到底跳没跳成：`done` / `not-found`）。这两条是"点了没反应"类问题的唯一痕迹。

### Linux（KDE / GNOME 各一次）

```bash
node scripts/theme-probe.mjs   # portal（org.freedesktop.appearance color-scheme）路径
```

再手工点一次通知（`ActionInvoked` → 宿主 `/dnotify/activate`），并在**没有**会话总线时确认进程不崩、不挂。

## 不变量（改动时最容易破的）

1. **常驻句柄一律 unref**：SSE 心跳、D-Bus 常驻 socket、请求超时计时器、主题兜底/轮询计时器。
   插件不得让宿主进程无法结束 —— `tests/handles.test.mjs` 用"假总线 + 子进程能否自己退出"把它钉死
   （CI 曾经因此挂满 6 小时）。
2. **SSE 断连严格幂等**：`req.on('close')` 与 `res.on('close')` 各来一次，只有第一次能递减注册表的连接计数，
   否则活着的页面会被误判成不可投递 → 退化成新开标签。
3. **认领 ≠ 跳转**：`claim` 只代表"某个页面接了这一单"，结果由客户端回报 `/dnotify/navigated`。
