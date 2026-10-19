# Changelog

## [2.4.16] - 2026-10-20

### 前台诊断：记录 Windows 拒绝现场

- `focus-win32` 的返回值新增 `diag`：调用进程 PID、前台窗口的 pid/exe/类名/标题/visible/iconic、
  目标窗口同组信息、`SPI_GETFOREGROUNDLOCKTIMEOUT`、`GetLastInputInfo` 计算的最后输入年龄、
  `SetForegroundWindow` 返回值与 `GetLastError`。
- 宿主在 `前台激活 …` 后再写一行 `前台诊断: {json}`，下次点击可直接看到“前台是谁/是否最小化/
  锁超时/最后输入”等判定条件；若最终是靠“观察到已在前台”成功，`diag.lastDenied` 保留最后一次
  `SetForegroundWindow` 失败时的同一组现场。
- 说明：`SetForegroundWindow` 没有官方拒绝原因；Windows 11 上
  `SPI_GETFOREGROUNDLOCKTIMEOUT` 固定返回 `2147483647`（无参考意义），该字段只用于记录。
- 行为不变：仍是 best-effort，不新增抢前台技巧。

## [2.4.15] - 2026-10-20

### 诊断：把 focus/设置跳转的真实结果写进日志

- `/dnotify/sw/report` 的字段白名单补上 `from/status/windowFound/atFront/attempts/reason/
  stage/result/elapsedMs`。此前 SW 上报的 `focus-result` 只剩 `kind`，日志看不出成功失败。
- 页面打开「设置 → 内置插件」时上报 `settings-open`：`start` / `ok` /
  `cell-click-timeout` / `cell-missing-timeout` / `open-timeout`，带耗时。
  这能把“浏览器已到前台但设置没打开”和“前台没成功”分开。

## [2.4.14] - 2026-10-20

### 前台：优先用浏览器 API 的结果，不再把枚举当轮询

- **浏览器 API 优先**：`WindowClient.focus()` 之后，`GetForegroundWindow()` 若已是受支持的
  浏览器窗口（firefox/chrome/msedge/brave/vivaldi/opera/librewolf），直接判定成功，不枚举、
  不额外抢；通知中心等占前台时先短暂等待重读，仍不是浏览器才**回退一次枚举**（按 DSH 标题/
  唯一候选），避免把 EnumWindows 当作轮询手段。
- **openWindow**：保留返回的 `WindowClient` 并调用 `focus()`；页面注册（load）后才请求宿主。
- **窗口身份类型**：Win32 `BOOL` 统一声明为 32 位 `int`；`EnumWindowsProc` 回调返回 `int`；
  `OpenProcess` 的 inherit 参数传 `0`（此前用 bool 会在部分调用下取不到进程名）。
- **合并限流**：去掉“800ms 内直接丢弃”，改为 in-flight 合并；上一次没到前台时，期间到达的
  请求在结束后补跑一次，成功则不重试。
- **可观测性**：`/dnotify/focus` 现在等本次尝试结束，返回
  `{windowFound, atFront, attempts, reason}`；SW `requestHostFocus()` 等待响应并回报
  `focus-result` / `focus-request-failed`，不再把 HTTP 200 当“已成功”。
- **SW 生命周期**：`register-page` / `show-notification` 用 `event.waitUntil` 跟踪异步 IDB/展示；
  `page-focus` 的失焦只允许清掉当前最后聚焦的同一 pageId，避免迟到 blur 清空别的标签页。

## [2.4.13] - 2026-10-20

### 前台：等页面 ack 后再请求 + 有限重试/校验（仍用 koffi，不换 ps1）

- **时序**：SW 不再在 `postMessage('dsh-navigate')` 后立刻请求 `/focus`。页面应用完跳转
  （`applyTargetWithRetry` 落地或重试结束）后回 `dsh-navigated` + nonce，SW 收到 ack 才请求；
  旧页面 bundle 不 ack 时 2s 超时兜底。新开窗口等新页面 `register-page`（load）或 1.5s 超时。
- **helper**：`focus-win32` 改为约 2s 内最多 8 次有限重试——每轮重新 `EnumWindows`（窗口/标题
  可能还在更新）→ `ShowWindowAsync` → 等一帧 → `SetForegroundWindow` → 等 120ms 用
  `GetForegroundWindow` 验证；成功即返回，失败才继续，仍失败记录 `atFront=False`。
- **FFI**：`EnumWindowsProc` 的 `lParam` 从 `long` 改为 `intptr_t`（x64 `LPARAM` 是
  `intptr_t`；本轮虽只传 0/不读，仍按真实签名声明）。
- 修正 SW 遗留的“页面在跳转后请求前台”旧注释；测试锁住“未 ack 不得请求、ack 后才请求”。

## [2.4.12] - 2026-10-20

### 子代理终止原因补全

- `subagent/end.stopReason` 映射补齐：`aborted`（手动终止/取消，含 `abort/cancelled/canceled/
  killed/terminated/stopped/interrupted` 别名）→“已终止”；`error/failed/failure`→“出错”；
  `max-tokens`→“达到 token 上限”；`refusal/refused`→“拒绝执行”；`timeout`→“超时”。
- **只有明确的 `completed` 才算正常结束**；缺少 `stopReason` 或未知值按终止处理，
  显示“未提供终止原因”或“终止（原值）”，不再出现空白的 `子代理:`。

## [2.4.11] - 2026-10-20

### 前台激活改 koffi，删除 focus.ps1

- `/dnotify/focus` 不再 spawn PowerShell：宿主按平台动态 import `src/focus-win32.ts`，
  用 **koffi 直接调 user32**：`EnumWindows` → 按 `MozillaWindowClass`/`Chrome_WidgetWin_1`
  + 进程名（firefox/chrome/msedge/brave/vivaldi/opera/librewolf）排除 VS Code 等 Electron，
  再找标题含 dsh/deepseek/harness 的窗口 → `ShowWindowAsync(SW_RESTORE)` + `SetForegroundWindow`。
- 删除 `assets/dsh-notify-focus.ps1`（以及 `%TEMP%\dsh-notify-focus.log`）；结果改写宿主日志
  `前台激活 hwnd=… set=… atFront=… title=…`。没有浏览器窗口时只记录“跳过”，不 spawn 任何进程。
- 仍然只是**一次最简单的 Win32 尝试**：不保证后台进程能绕过 Windows 前台锁。

### 灯：回退为只看标签页级

- 回退 2.4.9 的“按每种通知预设 silence 分级”：灯不再区分 session/tab，统一使用
  **标签页级聚焦**（`PageRegistry.focusedLive`：任一 DSH 页面可见且持焦点即算“人在看”）。
- 删除 `isSessionFocused`、每会话 `focusLevel` 及 `noteDone/noteWarn/noteError` 的级别参数；
  红灯“看满 2 秒”也只看标签页级。通知的静默判定仍按各自预设，和灯互不影响。

## [2.4.10] - 2026-10-20

### 会话终止（红）与后台子代理终止（黄）

- **会话终止**：监听 DSH 已有的 `session/event` → `turn/end.reason`（没有单独的
  `session/end` 运行时事件）。只处理根会话自己的 turn：
  - `aborted` + `AgentCancelCause`：`user` → 用户中止；`parent` → 母会话中止；
    `disposed` → 会话已关闭；`hook` → 被 hook 中止（带原因）；
  - `error`（`LlmFailure`，含模型断链）→ 出错：<message/code>；
  - `max-tokens` → 达到输出 token 上限；`blocked` → 回合被阻塞；
    `crash-orphaned` → 异常中断（进程崩溃）。
  - 通知标题 `⛔ DSH 会话终止`，正文 `工作区/会话名:终止原因`，灯 **红**；
    随后根 agent idle 的 800ms 任务完成通知在 5s 内被抑制，不会红/绿互相覆盖。
- **后台子代理终止**：复用现有 `subagent/end.stopReason`：
  `aborted/error/max-tokens/refusal` 等非 `completed` → 标题 `⏹️ DSH 后台子代理终止`，
  正文 `工作区/母会话名:子代理名:终止原因`，灯 **黄**；`completed` 仍走原绿色完成。
- 没有新增事件源/定时器/轮询：全部沿用 DSH 的 `turn/end`、`subagent/end` 与现有 `notify`/`note*`。

## [2.4.9] - 2026-10-20

### 浏览器通知点击前台：只保留最简单的 Win32 尝试

- 删除所有前台“技巧”：不再有 COM `AppActivate`、UIA `SetFocus`、关闭通知中心的 Esc、
  3.6s 重试、`AttachThreadInput`、TOPMOST、稳定校验；SW→页面 `focusUrl` 时序与
  `/dnotify/page-focus` 下发 `focusUrl` 也一并删除。
- 现在只有一条最短路径：SW `WindowClient.focus()` → postMessage 跳转 → 直接 `GET /dnotify/focus`；
  宿主 helper 只做 `ShowWindowAsync(SW_RESTORE)` + `SetForegroundWindow`，记录一次结果
  （`set=/atFront=`）。抢不到就抢不到，不再叠任何补丁。
- 无目标通知的规则不变：宿主不下发 `target/deepLink/focusUrl`，SW 通知 data 只有 `pageId`，
  点击只关闭、不 focus / openWindow / 请求前台。

### 灯：聚焦级别改为取各通知预设的 silence

- 灯不再直接读“标签页是否聚焦”的全局门控，而是按事件/会话的预设级别：
  - `silence='tab'`（看着标签页时静默）→ **标签页级**：任一 DSH 标签页聚焦即算“已看”；
  - `silence='session'`（看着会话时静默）→ **会话级**：只有正在看这个会话才算“已看”；
  - `silence='never'`（从不静默）→ 按 **会话级**处理（与默认一致）。
- 控制器新增 `isSessionFocused`（来自 `gate.silenced`）与每会话 `focusLevel`，`noteDone/noteWarn/noteError`
  可带级别；目标/子代理/团队/后台任务/审批被拒分别取 `goal/subagent/team/jobs/denied` 的预设。
  默认预设都是 session，因此“看着别的会话时”不再被误判成已看。

## [2.4.8] - 2026-10-20

### 灯：删除目标不参与判定（不灭灯、不抑制 done）

- 目标被删除（`clear`）时**不做任何灯动作**：不 `noteDone/noteWarn/noteError`，也不再有
  "删除就抑制 done 直到下一次活动"的 `suppressDone` 支路。
- 灯完全按当前事实走：原本运行白就继续白，完成绿就继续绿，不会被强制熄灭一段时间。
- 同步删除控制器 `noteCanceled` API 与其测试。

## [2.4.7] - 2026-10-20

### 点击跳转回退到 2.4.5（浏览器通知路径已验证可用）

- 2.4.7 曾把 `focusBrowserWindow()` 加到 `/dnotify/click` 与 `/dnotify/activate`，
  并在 `target=none` 时收紧行为；实测导致浏览器通知点击的跳转/前台回归。
  按要求**回退这部分**：`/click`、`/activate` 不再额外抢前台，`target=none` 的 SW 语义也恢复。
- 保留 2.4.5 已经修好的路径：SW 点击后请求 `/dnotify/focus`；页面收到 `dsh-navigate`
  时用最近通知的 `focusUrl` 补一次；Win32 helper 与 `/focus` 端点不变。

### 浏览器通知：所有点击跳转都补前台

- `/dnotify/page-focus` 的响应现在下发本进程的 `focusUrl`；**任何**页面收到 SW 的
  `dsh-navigate` 都能补一次 `/dnotify/focus`，不要求它自己显示过那条通知
  （解决"通知显示页 ≠ 点击落页"时旧 SW 没有 focusUrl 的问题）。
- SW 在"找不到目标页面、需要 openWindow 新开"的分支也调用 `requestHostFocus()`，
  新开窗口同样补一次前台；有目标页时仍然先 `WindowClient.focus()` 再 postMessage + `/focus`。
- **无点击跳转目标（`target=none`）的通知保持原样**：SW 点击只关闭通知，不 focus、
  不 `openWindow`、不请求 `/focus`——不会因为补前台多开一个页面。
- **真正修复 helper 不执行**：宿主 spawn PowerShell 时用了 `detached: true`；Windows 上
  detached PowerShell 会以 0 退出但**根本不执行 `-File`**（最小脚本复现：detached 不写文件，
  non-detached 正常）。这就是之前 `/focus` 有宿主日志、却既无 helper 日志也无前台的原因。
  改为 `stdio:'ignore' + windowsHide + unref`（不 detached），并记录 spawn error/exit code。
- **前台激活本身也加强了**：优先用旧版跑通过的 **WScript.Shell COM `AppActivate`**
  （少一层“调用进程不在前台”的守卫）和 **UIA `AutomationElement.SetFocus()`**；
  不行才在约 3.6s 内重试 `ShowWindow + AttachThreadInput + SetForegroundWindow`，
  最后 `SwitchToThisWindow` 并用 `GetForegroundWindow()` 验证。
  ⚠️ ALT 只在第一次尝试时注入——每轮注入输入会不断刷新前台锁，反而永远等不到它过期。
  实在抢不到焦点时用 `SetWindowPos(TOPMOST→NOTOPMOST)` 至少把浏览器窗口抬到可见层
  （日志 `raised=True`）。实测 `tries=1 set1=False atFront=True fg=<hwnd>`（COM 直接成功）。

### 修：重启后残留阻塞仍然亮红（上一版快照没生效）

- 根因：`ctx.inject(['goals','agents'])` 的启动快照在真实宿主里没有拿到目标（没有日志），
  所以补发事件和 facts 都还是把旧 blocked 当新异常。
- 改为**不依赖 goals 服务**：控制器在启动后的采集窗口（10s）内记录每个会话当时的目标阶段；
  其中 blocked 的会话直接 `acknowledgeBlocked`，补发的同阶段 `block` 事件由
  `startupGoalPhase()` 识别并跳过。阶段变化后快照失效，新阻塞/完成照常处理。
- complete 的补发同样按"启动时已是 complete"跳过，不再重启后重新亮绿。

### 运行律动：整体 +3%，两端 5% 减速回退

- `COMET_MS_PER_LED` = 170 / 1.03 ≈ **165.05ms/灯位**（整体加快 3%）；
- 去掉上一版的相位微扰，只保留单摆曲线（端点速度为 0），两端不再额外减速。

## [2.4.6] - 2026-10-20

### 设置跳转：新版 DSH 把设置收进左下角「账号菜单」

- 新版 DSH 网页端也没有独立的「设置」按钮了：设置项在
  `button[aria-label="账号菜单"][aria-haspopup="menu"]` 打开的菜单里。
  之前只找「设置」按钮，账号菜单根本没被打开 → 菜单项的「设置」不存在 →
  一直重试到 10s 超时（用户看到的"不手动点账号菜单就卡住"）。
- 修复：网页端也走「账号菜单 → 设置」路径；触发器按 `账号|账户|Account|用户|User`
  匹配，点开后等 120ms 再找菜单项；没有「设置」就 Esc 关掉（不点第一个 menu 按钮）。
  桌面端仍不合成快捷键（原生输入接管）。

### 灯：重启后残留目标状态不再补报

- DSH 重启后会补发 `goal/changed block/complete`（同一 goal revision），旧逻辑把它当新事件
  → 红灯/通知/绿灯再出现一次。现在启动时通过 `goals.get()` 快照**所有已存在目标的
  id:revision**，同 revision 的补发事件直接跳过；控制器把其中 blocked 的会话标成
  "启动前已看过"，不会从 facts 里再判出一次 error。新 revision（新阻塞/完成）仍正常响应。

### 运行中律动：整体 +5%，两端再 -5%

- `COMET_MS_PER_LED` 170 → **161.5ms**（一趟约 0.97s，整体加快 5%）；
- 位置曲线加相位微扰 `uw = u - a·sin(2πu)/(2π)`（a≈0.0488）：
  端点绝对速度 ≈ 原来的 0.95（两端再减慢 5%），中段 ≈ 1.05。

## [2.4.5] - 2026-10-20

### 浏览器通知（非协议模式）也能把窗口带到前台

- 页面收到 SW 的 `dsh-navigate`（通知点击）时，用最近一条通知随附的 `focusUrl` 请求
  `/dnotify/focus`；宿主用 Win32 `SetForegroundWindow`（独立 PowerShell，ALT 解前台锁）抬窗口。
- 这样**不依赖 SW 先更新**：即使浏览器里还是旧版 `dnotify-sw.js`（不会自己 fetch `/focus`），
  新的 `lib/client.js` 也能补上这次前台激活。反过来，新 SW 也会自己请求，二者幂等（宿主 800ms 节流）。
- 真机实测（直接运行 helper，当前 Firefox 窗口）：`set=True`，即 `SetForegroundWindow` 成功；
  `activated=False` 只是 `AppActivate` 的返回值，不影响 `set`。
- 注意：页面需要刷新一次以加载新的 `lib/client.js`；Windows 前台锁在少数情况下仍可能拒绝（日志可查）。

## [2.4.4] - 2026-10-20

### 修：聚焦时红灯 2s 熄灭后，灯卡在 off、吞掉运行白/完成绿

- 根因：目标 blocked 是**持续事实**。聚焦看满 2 秒后熄灭只清了 `lastError`，
  `goalPhase=blocked` 仍让账本每次判定为 error；判定器把 error 当"已看"跳过，
  但账本再也不会给出 running/done —— 于是红灯熄灭后一直 off。
- 修复：账本新增 `blockedAcked`。红灯被看到（聚焦满 2 秒 / 显式确认）时同时
  `acknowledgeBlocked()`，blocked 不再压住 running/done；下列情况自动恢复：
  - 离开 blocked（goalPhase 变化）→ 清除；
  - 新的阻塞/异常事件（`noteError`）→ 清除并重新亮红。
- 顺带消除红灯熄灭后每 1.5s 刷一次 `异常已被看到，清除账本中的异常记录` 的日志噪音。
- 新增回归：聚焦 error → 2s 熄灭 → 运行白 → 结束绿；blocked 看过后回 running/done，
  新阻塞重新亮红。

## [2.4.3] - 2026-10-20

### 点击跳转：前台置顶 + 自检跳转速度

- **点击后浏览器窗口不来前台**：浏览器通知点击时 SW 仍先 `WindowClient.focus()`（切标签页），
  随后请求宿主新增的 `/dnotify/focus`；宿主异步 spawn 独立 PowerShell 做
  `ShowWindow(SW_RESTORE) + ALT 解前台锁 + SetForegroundWindow/AppActivate`，不阻塞点击链路。
  只对 Windows 生效，`focusWindow: false` 可关；找不到唯一浏览器窗口时不动（不抢焦点）。
- **自检提示（启动播报）点击跳设置更跟手**：设置弹窗轮询 120ms → **100ms**、入口重试
  600ms → **300ms**，设置一出现就立刻点；等待上限仍 10s。**只等设置弹窗，不打开插件面板兜底**。

### 灯：颜色、闪烁衔接、优先级、目标删除

- **黄灯 2s → 1s**；**橙灯改得更橙**（`#ffa000` → `#ff8800`），与黄灯拉开色差。
- **红灯双闪包络两端加 25ms 渐变**：不再方波硬切，被确认/切场景时不会停在"亮到一半/暗到一半"；
  链路本身仍从当前像素交叉渐变。
- **统一优先级：报错（含目标阻塞） > 等待 > 运行中 > 完成**。旧实现先看等待、且目标阻塞排在
  pending 之后 → 跑着时"目标阻塞"的红灯要等运行结束才出现；现在阻塞立即红，不再等。
- **目标被删除（clear）≠ 完成**：删除不亮绿灯，抑制 done 画面直到下一次真实活动
  （running/waiting/error）；之后新工作的完成才重新亮绿。

### 测试

- 新增：生命周期"阻塞压过运行中"、控制器"删除目标不亮绿 / 下一次活动恢复"、
  提醒包络渐变、`/dnotify/focus` 令牌保护；全量 **423 tests pass**。

## [2.4.2] - 2026-10-20

### 灯色映射调整：后台任务完成移出绿灯

- **后台任务完成不再点灯**（与团队任务待处理/上下文压缩/定时任务启动/插件挂载同组）。
- 保留：任务完成、后台子代理结束、目标已完成、团队任务已完成 → 绿（2s）；
  后台任务**失败/被终止** → 黄（2s）；目标阻塞 → 红。

## [2.4.1] - 2026-10-20

### Windows Toast 发送移入独立 worker（真机验证通过）

- 新增 `src/toast-worker.ts` / `src/toast-bridge.ts`：WinRT 的 `RoActivateInstance` /
  `LoadXml` / `Show` 全是**同步 COM**（实测单条可 >100ms），现在在独立 worker 线程执行，
  主线程只 `postMessage` —— 发通知不再顶住事件循环（心跳/SSE/灯采样/UI）。
- **安全网**：worker 启动先 probe（只初始化 WinRT + 建 notifier，**不弹通知**）；
  probe 失败 / 超时 / 线程退出 → 自动回退主线程 inline（行为与 2.4.0 完全一致）；
  单条发送报错 → 该条 inline 补发一次，worker 继续用；probe 期间的通知先排队。
- `registerClickProtocol` 的结果通过消息同步给 worker，点击仍走 `dsh-notify:` 协议
  （不会退化成浏览器落地页）。
- **真机验证**（Windows 11）：新增 `scripts/toast-worker-probe.mjs`，实测
  inline probe/send OK → worker probe OK → worker 发送成功（无 inline 回退）→ close 后
  回退 inline 成功；Windows 通知中心可查到三条验证 Toast。
- 单测 `tests/toast-bridge.test.mjs`（假 worker）覆盖：probe 成功走 worker、probe 失败
  回退、线程退出回退、单条失败补发、probe 超时、协议同步。

### 说明：Firefox 源码映射 404

- 浏览器 devtools 里的 `source-map-loader ... 404`（`/plugins/??...client.js.map&rev=…`）
  是**重建后旧 bundle rev 的源码映射请求**：插件 `lib/` 一改，DSH 的 client 模块图 rev
  就变，devtools 还拿着旧 rev 去取 map，宿主只保留当前/上一批 rev → 404。
  纯 devtools 现象，不影响功能；**刷新页面**后 rev 对齐即消失（插件侧无需也无法改）。

## [2.4.0] - 2026-10-20

### 指示灯：新增「黄灯」与事件→灯色映射（用户指定）

- 新状态 `warn`（黄，`#FFD000`）：**无论是否聚焦都只亮 2 秒**，优先级
  **红（error）> 黄（warn）> 橙（waiting）> 绿（done）> 白（running）**；
  黄/绿脉冲不会打断橙/红画面。
- 事件映射：任务完成 / 后台子代理结束 / 后台任务完成 / 目标已完成 / 团队任务已完成 → **绿（2s）**；
  等待你回答 → 橙呼吸；审批被自动拒绝、后台任务失败或被终止 → **黄（2s）**；
  目标阻塞 → **红**；团队任务待处理 / 上下文压缩 / 定时任务启动 / 插件挂载 → **不点灯**。
- 律动（running）曲线改为**单摆式**（端点速度严格为 0）：折返处不再有一帧内反向造成的
  2 LSB 凹陷 —— 这就是"两头极快微闪"的根因（旧曲线端点仍有 0.7 倍速）。
- 修复关灯再开灯后灯概率不亮：重新启用时取消残留淡出、把当前画面重新下发给链路，
  链路 closed 时立刻重开；关闭路径现在**也会广播状态**（设置页不再停在"运行中"）。
- 设置页「点击测试」新增「警告」一项；`/dnotify/led` 的 `test` 白名单接受 `warn`。

### 对外 API v1.1.0（兼容旧 API）

- `NOTIFY_API_VERSION = '1.1.0'`；`LED_API_VERSION = '1.1.0-led.3'`；新增能力
  `led.scene.warn` / `led.host-only`。
- **1.0.x 调用方完全兼容**：返回字段与行为不变；外部 `push` / `notify` **默认不点灯**
  （灯只跟随宿主事件，想主动点灯必须显式调用 `desktopNotify.led`）。
- README 新增「串口 LED 状态灯：给其它插件调用（对外 API）」子节（归在通用对外 API 一节下），
  写明状态、优先级、版本与兼容约定。
- README 补充 Firefox 已知问题：点击通知不跳转（Firefox 系统通知中心行为，插件无法修复），
  手动把 `alerts.useSystemBackend.windows.notificationserver.enabled` 设为 `false` 缓解。

### 非灯逻辑审计与并发/异步改进

- **Linux 点击通知修复**：`xdg-desktop-portal` OpenURI 的 `ssa{sv}` 编组对齐错误
  （dict entry 未 8 对齐，严格实现会拒收）→ 已在同一 writer 内对齐并加单测。
- `/dnotify/*` body 读取加上限（超限回 400）、`lastSwReport` 改白名单+截断、日志单条截断、
  filelog 队列加**字节上限**（原来是条数上限，挡不住 MB 级单行）。
- 点击协议注册：只在 `launchMode === 'protocol'` 时注册，并改用 koffi 直写注册表
  （去掉每次 apply 串行 6 个 `spawnSync('reg')`）；删除"已移除协议"的过期注释。
- 通知发送：真实平台后端（WinRT 同步 COM）改为 `setImmediate` 投递，不再阻塞事件回调；
  图标路径按主题缓存（通知热路径不再 `existsSync`）。
- SSE 连接加硬上限（`/events` 32、`/led-events` 8，超限 503）；实现原来只写注释的
  `ledEventStreams` 计数。
- 定时任务快照 `sync()` 改单飞（事件密集时不再互相覆盖 `known`）；D-Bus 待发队列满时
  不再静默丢；认证缓冲加 8KB 上限；`Reader` 字符串/签名解码加越界检查。
- 主题读取超时定时器 `unref`；`nudgeLed` 无灯时不再排定时器且卸载时清理；
  `shownPending` 淘汰/结算时取消兜底定时器；通知 id 不再生成两次（诊断可对上）。
- 浏览器半区：`fetch` 加 5s 超时、`form.set` 拒绝不再 unhandled、一次性定时器自摘除、
  权限 `onchange` 与 SW 晚到回调加卸载守卫；`assistant/message` 摘要只扫到 220 字符。
- 后端动态 import 失败时降级（不再让整个插件模块加载失败）；配置类型表改用 `hasOwn`
  （防 `__proto__` 原型键）。
- **审计"可延后"项同批完成**：`PageRegistry` 加 `maxPages=64` 硬上限（有活跃 SSE 的页面
  绝不被误删，宁可暂时超限）；SW `activate` 时清理 7 天前的 pageId→clientId 映射与失效内存键；
  `agents.roots()` 加 400ms 短缓存、任务摘要只记根会话并刷新 LRU 顺序；审批配对被有界容器
  淘汰时改用通用文案推送（不再静默丢）；灯状态端点复用上一拍判定快照（卡顿哨兵不再触发
  `evaluateAll`）；D-Bus `Reader.array` 加越界检查；修正 `lifecycle.ts` 两处缩进。

## [2.3.0] - 2026-10-20

### 灯的运行时迁移到独立 worker：主线程卡顿不再影响灯

- **主线程只剩"采样 → 判定 → 下发语义画面"**：240fps 帧循环、渲染/交叉渐变、自检动画、
  熄灯淡出、蜂鸣排队、串口链路管理全部搬进 `led-runtime-worker`（再往下才是原生串口 worker）。
  主线程 `applyScene()` 同画面 0.097µs（签名去重后才 postMessage）、`status()` 读缓存 0.004µs；
  主线程事件循环卡顿/GC **不会让灯掉帧**，灯侧阻塞/崩溃也只影响灯 worker。
- **故障隔离与回退**：worker 崩溃/退出 → 状态置 error + 5s 退避自动重启（stop 后不再重启）；
  新建失败 / 起不来回退 inline 运行时并打日志；`DSH_LED_RUNTIME=inline` 可强制旧路径排障。
- **退出路径**：唯一允许主线程同步等待的地方 —— 发 `shutdown`（SharedArrayBuffer + Atomics），
  最多等 1200ms 让 worker 自己完成同步淡出→全黑→close；典型 <150ms。
- 新增 `src/led-runtime.ts` / `src/led-runtime-worker.ts` / `src/led-runtime-bridge.ts`；
  `led-controller.ts` 相应删掉时间驱动部分（帧循环/自检/fadeOut/直连 link）。
- **现场诊断结论**（用户报"卡顿更明显"）：主线程实测 `frameMaxMs ≤ 0.1ms`、`sampleMaxMs ≈ 2.5ms`，
  但 `maxLateMs` 偶发 11–274ms —— 停顿来自灯之外（宿主 GC/其它会话负载），不是渲染慢；
  独立 worker 后灯不再吃这些停顿。同时 `[mem]` 显示 **堆 337MB / 10 分钟、≈0KB/帧**（堆泄漏已修）。

### 串口配置：手动端口支持英文逗号分隔多个

- `COM5,COM9` → 只驱动这两块（各自独立链路、互不影响）；
  `/dev/ttyUSB0,/dev/ttyUSB1` 同理。
- 写了 `auto`（如 `auto,COM5`）→ **整体按 auto**（auto 已包含所有灯，其余项忽略）。
- 空项/非法项丢弃、重复项去重；全非法退回 auto（不把灯钉死在死端口）；
  手动端口之间改列表只增删变化的端口，保留的口不重连（不闪灯）。
- 设置页串口说明加括号并注明"多个用英文逗号分隔"。

### 设置页：删掉两处条件提示文字

- 「指示灯状态」下方可能出现的原因说明、以及「点击测试」下方可能出现的"未连接"提示，
  按要求**全部删除**（原因仍进日志/诊断端点）。
- 新增公共 `useMenuDismiss`（点外面/Esc 收起、焦点回触发钮、禁用自动收起）。

### 日志与诊断

- **日志全异步**：`filelog` 改为内存队列 + `fs.promises` 批量落盘（原来每条 `appendFileSync`
  都在主线程同步写盘，debug 打开时是卡顿/帧抖的一个来源）；队列有上限、轮转仍保留。
- `job settled` 日志里超长的命令 label 截断到 160 字符（不再把几 KB 的 PowerShell 命令写进日志）。
- 新增 `[led-perf]` 实时采集（仅 debug，每 10s）：`fps / idle / skipped / maxLate / frameMax /
  sampleMax / boards / link / sent / drop / heap` —— 一眼分清"灯渲染慢"还是"主线程被卡住"。

### 修复：切标签页/切应用时灯的严重闪烁（焦点门控误判为"新画面"）

- **根因**：页面聚焦状态翻转会让 judge 给 `running` 画面打/去 `MUTED` 标记。链路层旧判据
  用完整 `state|flags` 当"画面变了" → 重置 `sceneSince`（彗星相位回到起点、逐灯 stagger
  重新展开）并叠 250ms 交叉渐变。切一次标签页/应用就闪一次，连续切就严重闪烁。
- **修复**：新增 `sceneVisualKey()`，只用**真正会改变像素**的位（ATTENTION / NIGHT / waiting
  的 MUTED；running/done/error 的 MUTED 不参与渲染）。只改语义不改像素的画面变化不再重置
  相位/触发渐变。回归测试覆盖 `running→running+muted` 不重置、`waiting→waiting+muted` 仍渐变。
- 顺带修：`wake()` 以前只在空闲节拍生效 → preview/点击测试要等下一拍；现在任何画面变化都
  立刻渲染一帧。测试夹具也补上"每次 VERIFY 都回包"（否则重连后夹具自己把链路卡在 verifying）。

### 稳态动画不再做时间抖动（彗星到两端时的 240Hz 微闪）

- 旧实现每帧对 running/waiting 做 ±1 LSB 时间抖动；彗星到达两端时速度≈0，同一颗灯的
  目标值连续多帧不变，抖动让它每帧在两个相邻灰度间来回跳 → 极快微闪。
- 量化：2400 帧里逐通道"±1 来回跳"次数，原始渲染 **4** 次，加抖动后 **16264** 次。
- 现在抖动只保留在 250ms 交叉渐变窗口（画面快速变化、抖动被运动掩盖）；稳态输出纯 8 位。
  回归测试断言稳态帧逐字节等于渲染器输出、且来回跳次数 ≤20。

### 无固件改动的"状态级校验 + 自适应冗余"（应对掉帧/接触不良）

- 固件颜色 payload 定长 21B、**没有逐帧 ACK/CRC** → 不改固件无法做线缆级压缩/逐帧校验/重传。
  能做的是"状态级韧性"：每帧都是绝对状态，丢帧下一帧自动纠正。
- **自适应双发冗余**：10s 质量窗口内出现持续丢帧/写失败/探测超时/重连 → 判 `suspect/bad`，
  保持 10s：唯一帧降到 **120fps**，每帧**连写两份**（第二份必达；`pending===0` 才补，
  背压优先）。线上占用仍 ≈54.2%，不额外带宽；单帧丢失时另一份 2.26ms 后补上。
  单帧偶发丢**不算**劣化（避免"丢帧→双发→更积压→更多丢帧"自维持循环）。
- **快速健康探针**：劣化期 0x00 验证帧 2500/1200ms → 800/400ms（≈0.05% 带宽），
  reap 看门狗 1000ms → 250ms；掉线判定最坏 ~2.2s → **~0.65s**。
- **坏帧重试**：短写/0 字节不推进发送快照，下一拍自动重发；瞬时首次写失败不再发黑帧
  （只有确认断开或 5s 内重复失败才黑），避免接触不良时闪黑。
- 仍做不到：压缩、逐帧 CRC、ACK/选择性重传、设备端丢帧统计。若改固件的最小协议见
  `docs/serial-protocol.md`（seq+CRC+ACK 或 0x00 回包带丢帧计数）。

### 串口说明文案

- 改为：`（默认auto = 自动模式，也可手动填写 COM 或 /dev/ttyUSB 等，可使用多个英文逗号分隔多选）`。

## [2.2.0] - 2026-10-20

### 稳定性（OOM 根因方向）：帧循环不再每帧创建宿主定时器

- **证据**（崩溃进程的 2.58GB heap snapshot）：21 分钟里留存 **318,031 个 `Timeout` +
  319,891 个 `Error` + 6.1M closures + 3.5M `system/Context`**；`Timeout` 数 ≈ 240/s × 21min，
  与帧循环"每帧一次 `ctx.timeout`"完全吻合（cordis 的 timer 服务每次调用都会 `ctx.effect()`
  注册一棵 effect 对象树）。多处采样点还显示堆/帧 ≈ **7KB/帧**（3768MB / 545612 帧等），
  最终撞上 Node 4GB 堆上限（Mark-Compact 反复无效）。
- **修复**：帧调度**只使用进程级 `setTimeout`**（`options.schedule` 仅测试注入），
  `stop()` 与插件卸载时 `clearTimeout`；全文件不再引用 `ctx.timeout`（1.5s 采样仍用
  `ctx.interval`，单次 effect）。**按需帧循环**：动画/渐变/自检/握手时 4.1667ms，
  off / 稳态 done 降到 **250ms/帧**（心跳、探测、重试保留），场景变化立即唤醒并同步出一帧。
  空闲调度从 240 次/秒 → **约 4 次/秒**；300k 帧的分配微基准 GC 489 次 → **6 次**。
- **诊断增强**：`[mem]` 看门狗新增"**每帧堆增量**"（`≈7KB/帧` 这类泄漏一眼可见），
  堆增长异常时**打到终端**（不再只在 debug 文件里）；`stallProbe` 只在调试模式取
  `status()`（卡顿时不再加重主线程负担，且每 10s 一条）。
- `nudgeLed` 采样自适应：采样自身耗时 > 8ms 时自动拉长去抖窗口（上限 1s），
  事件风暴不会反过来压住帧循环。

### 多灯同步：`auto` = 同时驱动所有应答的灯

- 新增 `src/serial-fanout.ts`：每个端口一条**独立子链路**（独立 worker / 有界队列 / 重连），
  一份画面广播给所有板子；`auto` 每 15s 重扫挂上新插入的灯，不应答的口冷却 30s，
  已握手后掉线的板子由子链路自己退避重连（一块掉线不影响另一块）。
- **手动填 `COMx` = 只驱动那一块**；`flush()/close()/beep/rawFrame/setOverride` 全部广播。
- 多灯时每块各占 54.2% 带宽（互不共享）；`status()` 聚合为"至少一块就绪即 ready"，
  额外给出 `boards` / `boardCount` / `verifiedCount`。
- 顺带修掉"多串口逐个握手"里选错口死磕的问题（先前候选轮转已做，现在被扇出层取代）。

### 串口 worker：零分配读取泵 + 自适应轮询

- 读缓冲 256B、"已读字节数"、"已写字节数"改为**模块级预分配复用**，空转轮次 0 分配；
  `listPorts` 的枚举缓冲也提出循环。
- 读取泵自适应：打开端口后 / 写出验证帧后 **2ms** 快轮询 2s，其余 **30ms**；
  收到任意数据立即降速。180 万次/小时的 syscall → 约 12 万次/小时（约 -93%），
  最坏（回包一直不来）也比旧行为少约 20%。同轮次微基准 CPU 约 25~30× 下降。
- 读失败只报一次并停泵（旧实现每 2ms 报一条，会灌爆故障链路）；`reportFault` 单 worker 只报一次；
  `close()` 清空 pending；POSIX 读复用缓冲。

### LED 渲染与采样

- `led-render.ts` 增加就地渲染/混合/抖动入口（`createPixelFrame` + `*Into`），
  `led-protocol.ts` 增加 `encodeLedsInto`；`serial-link.ts` 每帧走复用缓冲 —— 像素输出逐字节不变，
  300k 帧的 GC 次数从 489 降到 6。
- 采样遍历去重：每拍只调一次 `agents.list()`，建一次"会话→根 / 父→子代理 / 根→族"索引，
  `collectFacts` / 族提问扫描 / hasWork 共用；`ledger.evaluateAll()` 每拍只算一次。
  修复多根会话时的 O(roots×agents) 采样开销（它会拖慢 240fps 帧循环）。
- `status().frames` 增加 `idle / idleFrameMs / maxLateMs / frameMaxMs / sampleMaxMs`
  （"卡顿是掉帧还是采样拖慢"一眼可见）。
- 「聚焦跟踪持续提醒」改为**始终开启**：设置页删掉该开关行，旧的 `ledAttention` 配置字段
  仅保留兼容（不再参与判定）。

### 设置页

- 修「各预设推送」静默模式下拉**选中项勾号缺失**：`SilenceMenu → MenuItem` 漏传
  `selected` / `value` 两个 prop。
- 菜单公共逻辑抽成 `useMenuDismiss`：点外面 / **Esc** 收起、Esc 后焦点回触发钮、禁用自动收起，
  成对挂载/摘除全局监听；`noSession` 的提前 return 移到所有 hooks 之后（避免 hooks 数量不一致）。
- 菜单项改 `role="menuitemradio"` + `aria-checked`，浮层加 `aria-label`。

### 通知点击与延迟

- **修点击跳转的 401**（"dsh web authentication required…"）：深链（`/#dsh-notify=…`）
  现在经 `ctx.get('connection').authenticatedUrl()` 带上 DSH 进程启动令牌，
  `/dnotify/click` 的 302、`/dnotify/activate` 的 open-*、浏览器通知的 deepLink 统一走这一处；
  无该服务（老宿主/精简组合）时保持原行为。
- **修 PowerShell 命令注入**：自定义协议转发器不再把 `%1` 拼进 `-Command` 的脚本文本，
  改为固定脚本 `assets/dsh-notify-click.ps1`（`-File`，URI 只作 `$args[0]`），脚本内按
  `none/session/page/url` 白名单 + 长度/控制字符校验；端点等作为注册表数据值读取；
  脚本缺失时不注册（不留必然失败的处理器）。`package.json` 纳入 `assets/*.ps1`，
  `check-syntax.mjs` 的 BOM 检查扩展到 assets。
- **完成通知去抖 3s → 800ms**：灯是事件即时亮的，通知不该慢 3 秒；根 agent 再次 running 仍会取消。

### 文档与工程

- `tsconfig` strict/include 纳入 `serial-pump.ts`、`serial-fanout.ts`。
- 新增 `scripts/locked.mjs`（开发用构建互斥，多个会话/Agent 并行跑 `npm test` 时不再互踩）。
- 文档对齐：多灯同步、心跳 1s、读取泵自适应、帧循环按需、蜂鸣频率、
  兼容范围 `>=0.2.0-rc.2 <=0.2.1-rc.2`。

## [2.1.4] - 2026-10-19

### 帧率与背压：把"240fps"从注释变成实测

上一版有四处互相矛盾的数字：`led-controller` 注释写"默认 40ms（25fps）"、代码回退值其实是
**8ms（125fps）**、CHANGELOG 写"240fps / 默认 4ms"、README 写"25fps / 650 B/s"；
而 `MIN_WRITE_GAP_MS = 4` 只是**写入上限**，并不会把 125fps 的帧循环提到 240。现在只有一份真相。

- **目标帧率统一到 `src/led-timing.ts`**：`LED_TARGET_FPS = 240`、帧周期 4.1667ms，
  `frameMs` 默认值就是它（生产环境不再传）。26B @115200 = 2.257ms 线上时间 → 占用 54.2%，
  线速上限 443fps。启动日志会打一行帧预算，`status().frames` 报告目标 vs 实测。
- **写入下限改为按波特率算**：`minWriteGapMs()` = 线上时间 × 1.15 ≈ 2.6ms。旧值写死 4ms，
  只比 4.1667ms 的帧周期小一点，定时器一抖就会把目标帧率自己砍掉。
- **帧循环**：改用单调时钟（`performance.now()`）；回调迟到 ≥1 帧时**丢欠帧、重新对齐**，
  不再 0 延迟补跑（补跑 = 卡一下之后猛跳）。
- **有界发送队列 + 背压**：Windows 侧 worker 同时只留 1 帧，积压时**丢过期的动画帧**
  （`WRITE_DROPPED`），下一次用最新画面重发；握手/蜂鸣/熄灯等**控制帧必达**。
  主动丢帧不再被当成"写失败"，不会因为积压触发重连。
- **POSIX 短写/EAGAIN**：`O_NONBLOCK` 下可能只写出一部分，旧实现把半帧当成功 →
  固件校验错整帧丢弃。现在余量留在队首、下次续写（有界队列 4 帧）。
- **实测脚本 `scripts/led-fps-probe.mjs`**（真实定时器 + 串行化写入模型）：
  240fps 连续 180 秒 → 渲染 240.08fps、交给串口 238.2fps（42863 帧 / 1.11 MB）、
  队列峰值 2、背压丢帧 13（0.03%）、P99 间隔 6.18ms；
  叠加主线程卡顿（272 次 / 2.0s）60 秒 → 渲染 239.0fps、丢欠帧 118、背压丢帧 45，**不补跑**。
- **诊断**：`status().frames = { targetFps, frameMs, rendered, skipped, fps }`；
  `link.status()` 新增 `dropped`（背压丢帧）与 `pending`（在飞帧数）。
- **异步故障接进链路**：worker 卡死 / 串口线程退出以前只是"记个数"——`onFault` 从来没被注册，
  看门狗 terminate 之后链路收不到通知，画面静止时要等下一次写返回 0 才发现（灯像"卡住"）。
  现在打开成功后立刻注册，并带代次校验（旧 worker 的迟到故障不会关掉新连接）。
- **迟到句柄的代次校验补齐**：`tryOpen()` 在 `await open()` 之后也校验代次，过期句柄**关掉**、
  绝不安装（原来只校验了枚举那一步，"打开期间被关掉"会装进一个已失效的原生句柄）。
- **熄灯帧的落地保证**：`flush()` 优先走**同步写**——Windows 用 `Atomics.wait` + worker
  `Atomics.notify`（不需要事件循环，进程退出路径也等得到），POSIX 用有界重试；
  `close()` 的 worker 收尾宽限按在飞帧数放宽。语义仍是"字节已被驱动接受"，
  不是 WS2812 已刷新（协议没有逐帧回执，文档里写明了这个边界）。
- **统一的发送队列**（新增 `src/serial-tx.ts`，纯逻辑 + 单测）：两个平台共用同一套语义——
  有界 4 帧、**动画帧最新优先**、**控制帧必达 FIFO**、短写不截断、已开始写的帧永不丢弃。
  修掉两处真实缺陷：POSIX 的同步熄灯写会**绕过队列插队**（黑帧可能先被串口接受，旧帧余量
  再被 `close()` 追发到它后面）；POSIX 驱动恢复后会把积压的旧动画逐帧发完才追到最新画面。
- **外部 API 也受背压**：`rawFrame()` 现在按 MODE 分类——颜色帧（`0x01`）与内部动画帧同策略
  （可丢、最新优先），验证/蜂鸣等控制帧仍必达。否则其它插件高频调用 `led.pixels()`
  就能绕过背压把 worker 队列灌满。API 结果里的 `queued: false` 只表示"这次没写出去"。
- **打开操作的所有权令牌**（`openToken`）：打开超时后旧一轮的失败不再 `fail()` 打掉新一轮
  （异常路径也校验代次），它的 `finally` 也无权清掉新一轮的 `opening` —— 否则第三轮会并发
  CreateFile 同一个端口。
- 文档：README 的 LED 章节已从"分支专属"移到标准能力区，`docs/serial-protocol.md` 去掉分支标注。
- 记录边界：握手回包只证明设备身份，**不能逐帧确认颜色已应用**；要证明板子端稳定收
  240fps 仍需逻辑分析仪量 UART 波形（或给固件加帧序号 + 回执）。

### 串口 LED 状态灯（新增能力）

- **兼容范围调整**：`peerDependencies["@deepseek-ai/dsh"]` 由 `>=0.1.7-rc.2 <=0.2.0-rc.2`
  改为 **`>=0.2.0-rc.2 <=0.2.1-rc.2`** —— 只承诺实测过、且服务面完全对齐的这条线
  （0.2.0-rc.2 起的事件面与投影形状是本实现的前提；0.2.1-rc.2 为当前验证上限）。


- **帧率 25fps → 125fps**（`frameMs` 8ms）：一帧 26 字节 @115200 只要 2.26ms。
  （当时这里误写成"240fps / 默认 4ms"，实际回退值是 8ms —— 矛盾的来龙去脉见最上面「帧率与背压」。）
- **交叉渐变（程序化，不用逐个设置）**：链路层比较画面签名，**任何**画面变化都从"上一帧实际
  渲染出的像素"按 ease-in-out 混合到新画面（默认 300ms）。新变化随时打断旧渐变、从当前像素
  重新起步 —— 所以"后一条通知迅速覆盖前一条"是天然行为，不需要给每种状态单独配过渡。
- **熄灯也淡出**：关闭指示灯/总开关不再硬灭，而是 300ms 淡到黑再关串口（**最后一帧用
  `flush()` 强制落地**，绕过写入间隔门控 —— 否则灯会停在半亮）。
- **安全门控**：
  - 写入间隔下限 4ms（当时的硬上限；现已改为按波特率算的 `minWriteGapMs()` ≈ 2.6ms），
    宁可丢帧也不把串口写缓冲灌爆；
  - 蜂鸣器冷却 1.5s：多会话接连结算时不会"连珠炮"；
  - `test()` 走 5 秒手动画面（之前只推一帧，下一次采样就盖掉，看起来只有"一闪"）。
- **多会话不冲突**：所有根会话先聚合成**一个**画面（等你 > 异常 > 在跑 > 完成），由单实例独占
  串口；新增测试锁住"两个会话 → 一条帧流、串口只开一次"。
- **修复**：1 秒一次的端口枚举在飞时，采样会把串口**关掉**（`if (scanning) link.close()`）——
  链路每秒被断开重连一次，灯会闪、preview/test 也会失效。现在枚举期间只是跳过推帧，不关串口；
  且 `devicePresent === false` 时，若链路已握手成功就继续驱动（相信握手，而不是枚举）。
- **上电自检彩虹停留过久**：端口扫描周期 5s → **1s**（板子上电会显示一次彩虹，直到我们推第一帧）。

### 真机联调反馈：熄灯、状态卡精简、点击测试、提示音降噪

- **关闭开关即熄灯**：WS2812B 会锁存最后一帧 —— 之前关掉「启用任务状态指示灯」只是停止推流，
  灯会一直亮在最后那个颜色上。现在关闭指示灯开关 / 关闭总开关 / 热重载让位 / 插件卸载，
  都会**先发一帧全黑**再关串口（`blackout()`），并有测试断言那帧 21 个通道全 0。
- **状态卡只留一个短词**：去掉「COM13 · 7 灯珠」与「画面：已完成」两行；只有**没连上**时
  才显示原因（没有找到串口设备 / 具体错误），免得"未连接"没有解释。
- **蜂鸣器开关**：改名「启用状态指示蜂鸣器」，移到「启用任务状态指示灯」正下方；
  **握手成功前灰掉**（固件没有"蜂鸣器在不在"的查询，用"板子握手"作为代理）。
- **新增「点击测试」**（该组卡片最下方）：下拉选 运行中/等待你/已完成/异常 + 测试按钮，
  直接显示对应画面并按该状态响一声；`POST /dnotify/led { op:'test', kind }`，
  不需要先打开指示灯开关之外的额外条件（但需要板子已连上）。
- **提示音降噪**：用户实测 880/1175Hz、音量 45 仍然刺耳 —— 改为 **330~880Hz、音量 22~30**、
  时长 120~200ms（完成仍是上行两声 660→880）。

### 修复：设置卡片消失（客户端插件 id 与安装名不一致）

作者在 main 上把 npm 包改名为 `@mvyvn/dsh-desktop-notify` 后，客户端 bundle 里注册的 id 也跟着
变成了新名；但本机 profile 仍按旧名 `dsh-desktop-notify` 安装 —— DSH 加载客户端插件时会拿
**安装名**核对 bundle 注册的 id，对不上就整块客户端半区不加载：**设置卡片消失，而通知照常**
（通知走宿主半区），现场没有任何报错，很难排查。

- 把散落在 4 处的包名收敛成一个常量 `PLUGIN_ID`（bundle id / 面板 id / 设置槽 key / `exports.name`），
  值取**本机 profile 实际安装的名字**，并在注释里写清"改安装名时四处一起改"；
- 新增护栏测试：四处必须同源，且注册的槽 key 必须以插件 id 开头 —— 以后再漂移会直接变红。

### 适配真机 AI Status Lights（协议重写）

板子做出来了（[AI_Status_Lights](https://github.com/Mvyvn/AI_Status_Lights)：CH32V003 + 7×WS2812B +
无源蜂鸣器）。原先那套 `A5 5A + CRC8 + 语义帧` 是自己发明的设计稿，真固件不认，**整体换成真协议**。

- **协议重写**（`src/led-protocol.ts`）：`55 AA | MODE | PAYLOAD | 累加和 | BB`，三条命令
  （0x00 验证 / 0x01 设 7 颗灯颜色 / 0x02 蜂鸣）。测试直接用 README 的示例帧做向量逐字节比对。
- **动画搬到主机**（新增 `src/led-render.ts`）：固件没有动画/亮度/覆盖层，主机按时刻渲染
  7 颗灯的像素后推流（26 B/帧、~25fps ≈ 650 B/s）。亮度改为主机端乘通道（0..255）。
- **握手**：打开串口后先发验证帧，收到 `AI Status Lights OK\r\n` 才算连上 ——
  机器上还插着手机/下载器之类的 COM 口，"打开成功"不等于找对了设备。
- **蜂鸣器**：完成/等你/异常各一段提示音，挑的是 440~1175Hz、音量 40~55 的柔和双音；
  设置页新增「完成时响一声」开关。
- **删除波特率配置**：固件把 115200 写死，调不了就不给控件。
- **删除自制的固件目录与构建脚本**：真固件在 AI_Status_Lights 仓库。
- 灯带卡片的状态词收敛为五个（未连接 / 未启用 / 运行中 / 异常 / 启动中），
  未连接时禁用「启用」开关且不驱动串口（但**不写回配置**）。

## [2.1.0-led.1] - 2026-10-06

给"躺床上也能看到 AI 干完没有"做的一块 USB 转串口彩色灯珠板：**白=运行中（左右流动）、
黄=等你、绿=完成、红=异常**。LED 默认关闭，通知行为不受影响。

- **新增：真完成检查器**（`src/lifecycle.ts`）。DSH 的 `agent/status = idle` 只表示**这一轮**
  结束，不等于会话完成。检查器把"还有没有未结算的工作"收进一个账本，按优先级给出
  `running / waiting / done / error`：有人等你回答 → waiting；刚发生过异常（10 分钟保鲜）→ error；
  **子代理在跑 / 后台任务未结算（`ctx.jobs.list()` 的 running|stopping）/ inbox 里压着待处理输入
  （会被再次调起）/ 回合边界还开着 → running**；目标 `blocked` → waiting；目标 `active` 但没 agent
  在跑 → 仍判 running（round-driver 会再调起它）；其余才是 done。服务缺失时对应事实缺省为"没有"，
  但会在日志里明确写出"能力缺失"，不会把"没装服务"误判成"已完成"。
- **新增：聚焦提醒判断器**（`src/led-judge.ts`）。出现值得看的结果（完成/等待/异常）而人不在
  （2 分钟内没有聚焦上报）时上闩，灯进入**一直提醒**（呼吸 + 周期双闪）；闩**只**在人回到页面、
  或按板上按键时解除 —— 不靠倒计时，所以不会在你睡觉时悄悄放过。提醒期间 AI 又跑起来时，
  底色仍是"在跑"，提醒位同时保留（两个事实都不吞）。已看过则转安静版，`ledIdleOffSec` 秒后熄灯。
- **新增：串口线协议 v1 + 固件**（`firmware/`，纯 C99）。帧格式 `A5 5A | TYPE | SEQ | LEN | PAYLOAD | CRC8`，
  解析器是**可重同步的状态机**（不信任 LEN 字段）。表现力放在固件：主机只在画面变化时发 11 字节的
  语义帧，动画/亮度曲线/覆盖层全在本地渲染 —— **稳态平均 < 20 B/s**。覆盖层自带 TTL（省掉撤销帧）、
  进度条 1 字节百分比、颜色压成 RGB332、亮度三级（场景×全局上限×夜间）、灯序可反转、
  **失联兜底**（主机 3× 心跳没说话就切低亮蓝呼吸，不会继续假装"AI 在跑"）、板上按键可"我知道了"。
- **新增：PC 侧固件自测**（没有板子也能验证）。`firmware/core` 在主机上编译并跑 **119 项断言**
  （协议向量、CRC 错/垃圾/半帧的健壮性、状态映射、亮度与 γ、覆盖层 TTL、失联兜底、ASCII 兜底）；
  Arduino 草图用 `firmware/host/stub/` 的 Arduino 桩**真的跑起来**（喂真实帧、推进假时钟、检查像素，
  **17 项断言**）。`firmware/host/vectors.h` 由主机侧编码器生成，测试会做**漂移检查**——
  两端编码只要有一处不一致就红。`npm run test:firmware`。
- **新增：对外 API 的串口控制协议（特殊版本）**。`ctx.get('desktopNotify').led` 暴露
  `status/scene/effect/overlay/brightness/progress/frame/acknowledge/preview`；协议版本
  `LED_API_VERSION = '1.0.0-led.1'`（与通知 API 分开标注的版本号），线协议 `LED_WIRE_VERSION = 1`，
  通知 API 版本提到 `1.1.0-led.1`（**主版本仍是 1**，老调用方的降级判定不受影响）。
  非法载荷一律拒绝并如实回报 `reason`，且**一个字节都不会写出去**；`frame()` 只放行白名单帧类型。
- **新增：设置页的灯带卡片**（`src/client.ts`）：启用开关、串口（auto/COMx）、波特率、亮度、
  熄灯延时、聚焦提醒开关，以及每 3s 轮询的**实时链路状态**（已连接 / 固件尚未握手 / 打不开串口的原因）
  与「我知道了（解除提醒）」按钮。
- **新增：诊断端点** `GET|POST /dnotify/led?t=<令牌>`（status / ack / preview），
  `/dnotify/status` 增加 `led` 字段（画面、链路、每会话判定、设备能力）。板子还没打时，
  这是唯一能"看不到灯也能调试"的入口。
- **修复（协议设计缺陷，固件自测抓到）**：亮度哨兵 `0xFF` 与"最大亮度 255"撞车 ——
  主机发"最亮(255)"会被固件解释成"用我的默认亮度"，表现是**调到最亮反而变暗**。
  现在统一约定：**显式亮度 0..254，255 一律表示"设备自己决定"**，并有回归测试
  （`firmware/host/sim_main.c` 的 4.11、`tests/led-protocol.test.mjs`）。
- **修复（设置页卡片会直接失效）**：`/dnotify/led` 原先只认进程令牌，而设置页的灯带卡片是
  浏览器 fetch（拿不到令牌）→ 永远 403 → 卡片永远显示"读不到"。现在两条准入路径任一即可：
  本机脚本带令牌（与 `/status` 同级），页面请求走 DSH 自己的信任栅栏 + 浏览器鉴权
  （与 `/page-focus` 同级）。`tests/host.test.mjs` 锁住了这两条路径与 403 分支。
- **健壮性（热重载）**：串口是**独占资源**，HMR 后新旧实例并存时两个控制器会抢同一个 COM 口。
  现在与路由/通知的接管判定同一套：只有"接管成功的最新实例"允许驱动，其余实例每次采样
  直接关掉链路（`led-controller` 的 `mayRun` 选项，`tests/led-controller.test.mjs` 覆盖）。
- **设置页灯带卡片（`src/client.ts`）**：控件统一成**填充式无边框面**（与参照实现 `dsh-path-guard`
  的 `CONTROL` 同族：32px、`--dsw-radius-sm`、`bg-module-platform`、`border:none`、13px）——
  明确**不用**宿主那套"0.5px 描边 + `bg-layer-3` + 聚焦变蓝"的设置字段（深色主题下那圈描边就是
  一道多余的白边）。数值字段是同一套面上的步进胶囊：值居中 tabular-nums、箭头列 17×12 悬停显示、
  宽度按位数撑开（`calc(Nch + 52px)` + 左右 26px）以免箭头压住数字；波特率箭头在**白名单内**跳档
  （115200→230400）；箭头以"眼下输入框里的数"为基准，并在 `mousedown` 里 `preventDefault`
  （否则输入框先失焦触发一次写入、再被 click 的写入覆盖 → 表现就是"点了没反应"）。
  行节奏 12px 上下留白、**无分割线**、标签 13px/字重 500；「指示灯状态」下方留额外间距。
  文案精简：标题「指示灯」、状态只给一个短词（未识别/未启用/运行中/异常/不支持）、
  「启用任务状态指示灯」与「聚焦跟踪持续提醒」无第二行说明、串口提示与标签**左右排**；
  串口失败文案同步缩短（"打不开串口 COM7"），细节留在日志。
- **修复（设置页 UI 五处真问题，均由新增护栏抓到）**：① 四个输入行写成 `InputRow({...})`
  直接调用一个含 hooks 的组件 → hooks 记到 `Section` 头上，而 Section 有若干提前 return 的分支
  （读取中/不可配置/summary），配置到位后触发 React 的
  `Rendered more hooks than during the previous render (Section: 5 → 13)`，整棵设置树被打崩
  （现象就是"设置界面消失了"）；② 步进控件把 `bump(step)` 当方向传（内部已乘 step）→
  点一下亮度跳 100 并顶到上限 254；③ `StepperRow` 没把 `options` 透传 → 波特率箭头变成 ±1；
  ④ 样式表"已存在就 return" → 客户端插件热重载后**旧 CSS 一直留在页面上**（改了样式却看不到
  效果，箭头定位等全靠那几条规则）；⑤ 箭头按下先让输入框失焦，触发两次互相打架的写入。
  现已全部修好；`tests/client-settings.test.mjs` 用遵守 hooks 规则的迷你 React 真渲染设置页
  （未就绪→就绪、summary 往返、步进交互与上下限、白名单跳档、控件面与行高、样式表更新、
  文案与顺序不回归），把任一 bug 塞回去该文件必红。
- **指示灯状态只有五个词**（用户指定）：**未连接 / 未启用 / 运行中 / 异常 / 启动中**。
  判定顺序：本机**没有串口设备**（宿主每 5s 只枚举、不打开，所以功能关着也扫）→ 未连接；
  有设备但开关关着 → 未启用；链路已连上 → 运行中；打不开/写不进/端点不可达/平台不支持 → 异常；
  正在打开或还没拿到回包 → 启动中。**未连接时禁止启用**：开关显示为关且不可点，宿主侧也不驱动、
  不尝试打开串口（`LinkErrorCode` 把 `no-device` 与 `open-failed` 分开），但**不写回配置** ——
  你的设置值原样保留，插上灯就按它生效。只有真的连上链路时才显示「画面：…」。
- 测试：**283 项全绿**（新增 8 个测试文件：线协议、真完成判定、聚焦提醒闩、串口链路、
  控制器接线、LED 对外 API、LED 配置归一、**设置页渲染护栏**）；
  固件侧另有 **119 项 C 断言 + 17 项草图断言**（`npm run test:firmware`）。

## [2.0.0] - 2026-10-01

- **新增：插件设置页**（挂 `plugins.row.config`，与 `dsh-path-guard` 同一做法）：总开关、调试模式、对外 API 开关，以及 **11 种预设推送各自的开关 + 静默模式**。宿主侧新增 schemastery `Config`（按官方 volatile 规则：整个数组 volatile、元素普通），并把所有开关改为**运行时重读**——设置页改完由 settings 服务原子写回 `cordis.patch.yml` 并原地重载，无需重启。
- **新增：静默模式三档**（`session` 默认 / `tab` 标签页级 / `never`）。`tab` 用浏览器原生的"标签页可见且持焦点"这一级信号，是比会话级更安静的档位。
- **变更：页面身份唯一化**。不再从 sessionStorage 复用 pageId（复制标签页会把 sessionStorage 一起复制，两个标签页争同一个身份，旧实现要等 200ms 探测窗口后才换）——现在每次加载生成全新 id，从源头消除该竞争窗口。
- **对外 API 基线协议 v1.0.0**：服务上新增 `apiVersion` 与 `capabilities`（能力探测）；载荷可带 `v` 声明版本，**未知字段一律忽略**、更高主版本只回带 `unsupportedVersion` 而不中断推送；结果对象只增不改（新增 `apiVersion` / `unsupportedVersion`）。
- **调试日志落文件**：`config.debug` 开启后状态日志写入 `$DSH_HOME/logs/dsh-desktop-notify/dsh-desktop-notify.log`（>1MB 轮转、保留 5 份），不再刷终端；同一文件也接住本插件 fiber 上的 cordis 日志（`ctx.logger.exporter`）。错误日志不变。
- **修复**：启动播报等待时长配置 `startupWaitMs` 之前算出来却没用上（仍按默认 5s）——现在真正生效；自定义 `config.sender` 返回 rejected Promise 时同步 try/catch 抓不到、重试失效——现在归一成 Promise 再接住。
- **修复（Service Worker）**：`registerServiceWorker()` 改为幂等（同一个 promise 复用，不再重复挂 `controllerchange` 监听与定时器）；SW 事件监听与客户端定时器全部纳入卸载清理；SW 的 `pageId → clientId` 映射写入 IndexedDB 并在 SW 复活时主动要求页面重报（事件驱动；**查不到映射时不再乱猜一个 DSH 标签页**，宁可新开也不跳错）；新增 `shown` 显示回执：SSE 写成功不再等于成功，超时或 `show-error` 时用原生 Toast 兜底。

## [1.8.10] - 2026-10-01

- **变更：安装方式改走 DSH 自带的插件安装器，删除 `scripts/install.ps1` / `scripts/install.sh`**。官方插件文档明确要求「不要用 shell 命令复刻 `install_bundle` 的安装与 bundle 选择步骤」，而本包清单本就是一份合规 bundle（`dsh.bundle.patch` + `dsh.client` + `koffi` 在 `dependencies`），安装器能装依赖、选 bundle、启用并提示需批准的安装脚本；AUMID 注册表键由插件自己在启动时按主题写好，与安装步骤无关。README 与 `docs/getting-started.md` 改为：插件管理 → 添加插件 → 填本机目录路径或仓库地址。
- **变更：收紧依赖范围** `peerDependencies` 由 `>=0.1.7-rc.2 <0.3.0` 改为 **`>=0.1.7-rc.2 <=0.2.0-rc.2`** —— 只承诺实测过的这条线；0.2.x 的其它小版本可能有破坏性改动，不应预先声称兼容。README 的依赖需求表同步。

- **新增：浏览器通知渠道（Web Notification），有在线页面时默认走它**。浏览器半区注册插件自带的 Service Worker（`assets/dnotify-sw.js`，宿主在 `/dnotify/sw.js` 提供，**不是浏览器扩展、无需安装**）；通知由 `showNotification()` 显示，**点击由浏览器自己处理**：`notificationclick` → `clients.matchAll()` → `WindowClient.focus()`。于是"标签页在后台 → 精确切到已有那个标签页"不再需要 UIA/无障碍、`SetForegroundWindow`、PowerShell 或标题匹配；**没有窗口时用 `clients.openWindow(<DSH 深链>)` 直接开 DSH**，不再经过中转页。该链路跨浏览器（Firefox / Chromium 系）且天然跨平台（Linux 同样适用）。
- **新增：降级模式**。没有在线页面、或页面上报的通知权限不是 `granted` 时回退为原生 Toast，运行模式只出现在**启动播报**正文里（`共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：正常/降级`）；`/dnotify/click` 一律 302 到 DSH 深链（不再投递给已有页面）。**落地页与 UIA 前台激活那套实现整体删除**。
- **新增：通知权限的首授权引导**。浏览器要求用户手势才弹授权框，因此不做自动弹窗，改为在 DSH 页面显示一张一次性的居中卡片（**DSH 界面风格**：遮罩 + 卡片 + 标题 + 说明 + 右下角按钮，按钮高 32px / 圆角 8px），带「设置」与「取消」两个按钮：前者弹浏览器授权框，后者只关掉卡片。外观与 DSH 自己的弹窗（`ui-primitives/Modal.module.css`）**同源**：背景 `--dsw-alias-bg-layer-2`（深色 `rgb(44,44,46)`，与 DSH 弹窗一致；早先误用 `bg-overlay` → 深色下是中灰 `rgb(97,102,107)`，显得太浅）、遮罩 `--dsw-alias-bg-mask-1`、圆角 `--dsw-radius-panel`、投影 `--dsw-elevation-prominent`，并且是**解析成实际颜色值**后再写进内联样式（直接写 `var()` 在卡片挂到 `body` 上时取不到作用域 token；只问 `:root` 会永远拿到浅色那份）；「设置」按钮的文字颜色按底色亮度自动选深色/白色（深色主题的品牌色本身是亮色，写死白字会字底融为一体）；任一标签页关掉卡片时其它标签页跟着关（`BroadcastChannel` / `localStorage` 兜底），显示前清掉残留旧卡片；权限恢复后再降级会**重新提示**（不再是一次性开关）。权限变化由 Permissions API 的 `onchange` **即时**感知（见下），手动在站点设置里授权后无需重启即可走浏览器通知。
- **新增：`/dnotify/status` 诊断字段**（令牌保护）：`lastRoute`（走了哪条渠道及原因）、`lastSwReport`（SW 与页面回报）、`lastNotify`/`notifyLog`（每次入队/静默/去重的原因）、`eventLog`（最近的 `session/event` 类型）、`jobLog`（jobs 链路全程）、`scheduleLog`（定时任务比对结果）。"这条提醒为什么没弹"从此可查。
- **变更：所有通知标题带 `DSH` 前缀**（图标与来源行改不了，标题就是品牌位），并新增「⚠️ DSH 权限变更」通知：正文 `dsh-desktop-notify 跟踪到消息提醒权限变更为:xxx，插件运行模式同步变更为xxx`，由 Permissions API 的 `onchange` 触发、不受门控静默、重复状态不打扰（首次得知只记基线，不算变更）。
- **变更：来源行品牌化**。Windows 的 AUMID `DisplayName` 由 `DSH` 改为 **DeepSeek Harness**，Linux D-Bus 的 `app_name` 同步改为 **DeepSeek Harness**（原生 Toast 的来源行因此显示品牌名与插件图标；Web Notification 那一行由浏览器决定，无法修改）。
- **变更：启动播报文案**：标题「🚀 DSH 插件挂载成功」/「⚠️ DSH 插件挂载异常」，正文 `共有 N 个插件被成功加载，dsh-desktop-notify 运行模式：正常/降级`（异常时 `存在 N 个插件运行异常：<ids>，…`）。
- **变更：启动播报等一个有通知权限的在线页面再发**（最多 5 秒，超时降级为原生 Toast）。启动瞬间还没有页面连上来，不等就只能降级；而这条通知恰好是"点一下跳到设置→内置插件"的入口。
- **变更：定时任务改为"触发时"提醒**。原先监听会话事件 `schedule/change` 的 `operation='create'`，而该事件**从不出现在 `session/event` 里**（实测 `eventLog` 中一次都没有），这条通知一直是死代码。现在监听 DSH 真正对外广播的 Cordis 事件 `schedule/changed`，再用 `catalog()` 的**投递记录**（`lastDelivery`）做快照比对：只有新投递才算触发，创建本身不打扰。
- **变更：后台任务不再按 `awaited` 跳过**。母会话里跑的后台任务结算时 `awaited === true`，旧逻辑据此不通知；现在照常通知——"你正看着这个会话"这种打扰交给聚焦门控判断。`kind='subagent'` 的后台任务仍由「🤖 DSH 后台子代理结束」负责，避免同一件事两条。
- **变更：静默范围分三档**（点击目标与静默判定彻底分开）：**后台子代理**看"母会话 + 子会话本身"；**后台任务**看"所属会话 + 其所属子代理的母会话"；**定时任务 / 上下文压缩 / 目标 / 提问 / 审批被拒**只看**该会话本身**——你正看着它的子代理或母会话时也会推送。
- **修复：设置导航落点**。原先只认私有属性 `[data-shortcut-modal="settings"]`、按 `textContent` 找导航格，找不到设置对话框时会**退到侧栏「插件」页**（用户看到的错落点）。现在按真实结构（`role="dialog"` + 可访问名「设置」）打开、在对话框里按可访问名点「内置插件」并**验证就位**（`aria-current`），打不开就继续重试、**绝不**退到「插件」页。
- **修复：深链导航重试到就位**。深链打开的是刚加载的页面，DSH 界面往往要几秒才挂载，旧实现约 2 秒就放弃 → 表现为"新标签页开了但停在原处"。现在最多重试 10 秒。
- **修复：权限判定漏掉手动授权**。分流只看"投递页面"的权限，而权限可能是用户在站点设置里手动给的，于是误判为未知而走了降级。现在任一在线页面 `granted` 即走浏览器通知。
- **修复：静态资源放行**。`/dnotify/sw.js` 不再过 DSH 的鉴权栅栏（注册 SW 的请求不带那些头）。
- **还原云端线的既有修复**：断连幂等（`drop()` 只清理一次）、门控吃 `seq` 乱序、URL 校验、设置弹窗时序、Linux 兜底、等待中的调用保持 ref'd（CI 挂死的第二半）、句柄不变量单测、`withDeadline` 主题读取、CI 的依赖安装步骤与产物一致性门禁、koffi 3.3.2。
- **文档**：README 重写（删除截图段、明确依赖范围 `DSH >= 0.1.7-rc.2` 且 `<= 0.2.0-rc.2`、通知一览与静默规则按当前实现、新增"为什么这条提醒没弹"的诊断表）；`docs/` 同步更新。；新增「权限变化即时感知并提示降级」
- 测试：159 项全绿（新增：浏览器通知分流、降级提示、权限横幅与回报、定时任务触发判定、后台任务 `awaited` 通知、静默三档、设置导航不退到插件页、权限变化即时感知与"再次被阻止要再提醒"）。

## [1.7.0] - 2026-09-30

- **全量迁移到 TypeScript 6**：原先手写的 9 个模块（宿主 `index`、浏览器半区 `client`、`dbus`、`winrt`、`toast-linux`、`theme*`、`win32-registry`）全部变成 `src/*.ts`，`lib/*.js` 一律是构建产物。三个 tsconfig：核心层 strict（协议/页面/激活/门控/API/状态/图标/文本）、平台层先关 strict 再逐模块收紧、浏览器半区按**脚本**编译（`moduleDetection: "legacy"`，不产生 `export {}`）。`npm run build` 依次跑三个配置；`npm test` 自动先构建。行为不变：149 项单测 + `dsh-runtime-probe`（真 cordis）+ `theme-probe`（真注册表）全通过，忽略空白后的产物差异只剩缩进/分号这类格式。

- **新增三类通知**（DSH 0.2.0-rc.2 的事件面）：
  - 🕒 **团队任务待处理 / ✅ 团队任务已完成** —— `session/event` 的 `team/task`，只对**状态变化**发（`in_progress`/`deleted` 不打扰，同一状态重复派发也只弹一次）；
  - 🗜️ **上下文已智能压缩** —— `session/event` 的 `compaction/end`，带 `error` 的失败压缩不报；
  - ⏰ **定时任务已启动** —— `session/event` 的 `schedule/change` 的 `operation='create'`（`delete`/dispatch 不打扰）。
  正文统一为「工作区/会话名:内容」，点击回到对应会话。
- **修复子代理/后台任务定位不到母会话**：旧的 `mainSessionFor` 只沿 `header.parentSession` 往上走**一层**，多层子代理会停在中间层——前缀里的会话名不是母会话，点击目标指向一个客户端目录里解析不到的中间会话（表现就是"点了不跳"）。现在一路回溯到**顶层母会话**（带环路保护），子代理/后台任务的点击目标与前缀都用母会话。
- **修复点击启动播报后的多余菜单与卡顿**：旧实现把 DOM 里**第一个** `[aria-haspopup="menu"]` 当账号菜单点开——那通常是「在应用中打开」（文件资源管理器 / VS Code），于是屏幕上留下一个多余菜单；各段等待串起来最长约 6s。现在优先点侧边栏**真实设置入口**（`aria-label="设置"`，几十毫秒），快捷键只作次选，菜单路径必须先确认里面有「设置」才点、否则按 Esc 关掉，最坏 ~2s 退到插件面板。
- 测试：149 项全绿（新增：多层子代理回到母会话、团队任务状态变化去重、压缩成功/失败区分、定时任务只报 create、设置入口优先于合成快捷键）。

## [1.6.4] - 2026-09-30

- **默认改为浏览器落地页（`launchMode: 'browser'`）**。实测结论：Windows 11 上、未打包的 Win32 宿主里，Toast 的 `activationType="protocol"` **不会**把自定义 scheme 投递给注册表处理器——`Start-Process 'dsh-notify:…'` 能触发，真实点击却什么都不发生（日志里连一行 `invoked` 都没有）。所以默认让 Toast 直接带 `http://127.0.0.1:<端口>/dnotify/click?…`：浏览器必然会打开它，点击因此**一定能**到达宿主。代价是通知中心会留下一个落地页标签（浏览器不允许脚本关闭系统打开的标签）。想要"零新标签"且确认协议可用的环境可显式 `launchMode: 'protocol'`。
- **修复幽灵在线页面**：SSE 断开时的清理只删了 `openStreams`，忘了把页面注册表里的连接计数减掉——于是该页面永远被当成"可投递"，点击被判为可投递却写不出去，再退化成"新开"。现在两条清理路径都会减计数。
- 测试：144 项全绿（新增 launch 默认值/协议模式断言；SSE 断开后注册表一致）。

## [1.6.3] - 2026-09-30

- **转发器无条件留痕**：只要 Windows 调用了协议处理器，就往 `%TEMP%\dsh-notify-activate.log` 写一行 `invoked <uri>`。用于把"点击根本没触发协议"与"触发了但后续失败"分开——这是排查"点了没反应"的第一现场。
- **`config.launchMode`**：`'protocol'`（默认，自定义协议，不新开标签）| `'browser'`（Toast 直接带浏览器落地页）。后者会在通知中心留一个标签页，但**一定能到达宿主**；协议激活在某些环境下不触发时用它兜底。
- `/dnotify/status` 增加 `launchMode` 与 `recentSent`（最近 12 条通知的标题 + 点击目标 + 实际 launch），可以直接回答"我刚才点的那条到底可不可点击"。
- 通知本身没有点击目标时（`click` 缺省）会记一条日志，避免"这条点了没反应"被当成 bug。
- 测试：143 项全绿。

## [1.6.2] - 2026-09-30

- **"投出去了"不再等于"跳了"**：`res.write()` 成功只说明数据交给了 socket，浏览器可能没收到（重连中/标签页冻结/旧客户端）。现在投递后会**等页面认领**（默认 1.5s，`config.claimWaitMs` 可调）：等到了才算 `delivered`；没等到就**退化成新开 DSH 深链**，绝不静默失败。浏览器落地页同理（没认领就 302）。
- **激活器不再吞异常**：转发器的 `catch` 现在会写一行日志到 `%TEMP%\dsh-notify-activate.log`，并退回浏览器落地页——以前任何一步出错的表现都是"点了没反应"。
- **客户端不再按 targetPageId 预过滤**：过滤掉就变成静默失败；归属由宿主在 `/claim` 裁决，被拒时重报身份自愈。
- **新增只读诊断端点 `/dnotify/status?t=<令牌>`**：返回页面注册表（pageId/聚焦/连接数/seq）、待认领、最近一次激活与认领、当前流——排查"点了没反应"时用它分清"没投出去 / 投了没认领 / 认领了没跳"。
- 测试：143 项全绿（新增"投了没人认领 → 改走新开"与"诊断端点"）。

## [1.6.1] - 2026-09-30

- **点击后页面没到前台 → 看起来像"点了没反应"**。两条都补上：
  - 转发器在 `delivered`（已有页面收到跳转）时用 `AppActivate` 把带 DSH 标签的浏览器窗口带到前台（无需编译 C#，约 0.2s；优先标题含 dsh/deepseek/harness 的窗口，只有一个浏览器窗口时用它，不确定就不动、不抢焦点）。`config.focusWindow: false` 可关。
  - 页面侧在认领成功后先 `window.focus()` 再落 UI（浏览器可能忽略，忽略无害）。
- 说明：重启**之前**产生的旧通知带的是 http 落地页（兼容兜底），点它会新开一个标签页；重启后新产生的通知走 `dsh-notify:` 协议，不再新开标签。
- 测试：141 项全绿；真机链路（注册表 → 隐藏转发器 → `/dnotify/activate` → 定向投递 → 页面内打开设置）复验通过，浏览器页数保持 1。

## [1.6.0] - 2026-09-30

**点击跳转重做为"先决策、再决定要不要开窗口"**（三态互斥且可证明：无目标不跳转 / 有页面只让该页面跳转 / 无页面才新开 DSH）。为此引入 TypeScript 6 类型化核心与配套状态机。

- **点击目标改为显式四态**（`click`）：`none`（不传即此项）/ `session` / `page` / `url`。`sessionId` 只用于聚焦门控，不再隐式生成跳转链接——旧版"留空"根本表达不出"不要跳转"。旧字段 `url`（http/https）仍兼容。
- **每条点击有身份**：`openId` 精确认领 + **归属校验**（非目标页面拿到 id 也认领不了），删除"广播后谁先 claim 谁赢"。
- **页面注册表**（`src/pages.ts`）：`{pageId, seq, focused, sessionId, 连接数}`；只接受更大的 `seq`（focus/blur 乱序不覆盖新状态，失焦清除"当前聚焦"但保留"最后用过"）；连接数用计数而非布尔（刷新时新旧连接任意先后都不会误判离线）。选页：此刻聚焦 → 最后聚焦且在线 → 都没有就新开。
- **Windows 不再经过浏览器**：Toast 用 `dsh-notify:` 自定义协议，插件启动时把 `HKCU\Software\Classes\dsh-notify` 指向本进程的 `/dnotify/activate`；隐藏 PowerShell 一跳只负责"问宿主该怎么做"，只有宿主回答 `open` 才真正打开地址 → **有页面时点击零新窗口**。可配 `clickProtocol: false` 关掉。
- **Linux 在宿主进程内决策**：`ActionInvoked` → 宿主决策 → 需要时才调 portal `OpenURI`。
- **删除 `location.reload()` 兜底**：`openSession()` 抛错时明确失败并记日志，不再"原地刷新但不跳转"（旧版 reload 前 hash 已被清掉）。
- **新端点** `GET /dnotify/activate?raw=<目标>`：返回 `{action:'delivered'|'open'|'ignore', url?}`，由平台侧执行唯一需要开窗口的动作。
- **DSH 兼容**：声明 `peerDependencies: { "@deepseek-ai/dsh": ">=0.1.7-rc.2 <0.3.0" }`（`peerDependenciesMeta.optional` 挡住 npm 自动安装整棵 DSH 依赖树；DSH 自己的兼容性预检只看 `peerDependencies`）。已实测 DSH **0.2.0-rc.2**：核心服务包（connection / webserver / jobs / subagent / scope / loader / cordis）两版之间零改动；适配其 web 端设置快捷键改为 **primary+alt+Comma**。
- **TypeScript 6 基线**：`src/**/*.ts`（strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `erasableSyntaxOnly`，TS7 就绪）编译到 `lib/`；`npm run build`，`npm test` 自动先构建。迁移进度见 `docs/migration-ts6-ts7.md`。
- 测试：141 项全绿（新增协议、注册表、激活决策、三态点击、归属校验、seq 乱序、激活端点等用例；真机验证含"有已打开页面 → 页面内跳转且零新窗口"）。

## [1.5.4] - 2026-09-25

- **修复点击跳转的三处结构性问题**（都表现为"偶发点了没反应 / 跳错页面"）：
  1. **认领没有身份**：SSE 事件里明明带了 target，客户端却丢掉它、再由 `/claim` 去读全局"最新一条"。连点两条通知会串单（A 的 claim 认领到 B）。现在每次点击生成唯一 `openId`，`/claim` 按 `openId` 精确认领，重复认领返回 `{ok:false, reason:'stale'}`。
  2. **"先到先得"被当成"正在用的页面"**：原先广播给所有页面、谁先抢到 claim 谁执行——后台标签页完全可能先到。现在 `GET /dnotify/events?pageId=<id>` 让每条连接自报身份，宿主记住**最后一次上报聚焦的页面**，点击只定向推给它；只有它不在线时才退回广播（仍按 openId 先到先得）。
  3. **没有已打开的 DSH 页面时点击必然空转**：SSE 没有订阅者时落地页只显示一行字。现在 `/dnotify/click` 直接 **302 到 `/#dsh-notify=<目标>`**，由浏览器拉起 DSH、页面启动后走 `handleHashTarget()` 完成跳转；该条待认领记录同时作废，避免稍后连上的页面重放（跳两遍）。
- 顺带：`openEventStream()` 不再在 apply 里重复调用（只由 `ctx.effect` 建立、卸载时关闭）；`switchSession()` 旁注明 DSH 0.1.7-rc.2 的 `openSession()` 是**同步 void**，故"不抛错"即成功信号。
- 测试：新增「连点两条不串单」「只推给最后一次聚焦的页面」「无页面时 302 且不重放」「点击后新连上的页面收到完整信封」「客户端认领带 openId」；全套 124 项。

## [1.5.3] - 2026-09-25

- **修复：点之前发出的通知得到 `forbidden`**。点击令牌原先在每次 `apply` 时重新生成，而热更新/替换插件文件都会重跑 `apply`——已经躺在通知中心里的通知（带旧令牌）因此一律被 403 拒掉。现在：
  - 令牌放 `globalThis`，**同一进程内跨 re-apply 复用**；
  - `/dnotify/click` 只拦**真正的跨站触发**（`Sec-Fetch-Site: cross-site` → 403），其余情况即使令牌过期（上一次运行发的旧通知）也照常跳转——目标本身另有白名单约束，"点到旧通知"是正常用户行为；
  - 目标非法时落地页显示「这条通知的目标已失效」，不再是一句 `forbidden`。
- 测试：新增「旧令牌非跨站放行」「同一进程跨 apply 令牌一致」，并把跨站拒绝改成显式用例；全套 120 项。

## [1.5.2] - 2026-09-25

- **新增启动播报**：每次 `dsh web` 启动后推一条通知——`插件启动成功:共有 N 个插件成功加载`；有插件没激活时改为 `有 N 个插件启动失败:加载失败的插件为 …`。数的是 `loader` 里的插件行（ACTIVE 算成功，FAILED / 没有 fiber / 等不来服务都算没起来并列出 `entry.options.id`，主动 `disabled` 不计入），每次启动只推一次。
- **新增点击跳转**：点击通知打开 `http://127.0.0.1:<端口>/dnotify/click?t=<进程令牌>&target=<目标>`（只记录目标的落地页，浏览器会新开一个标签页）；已打开的 DSH 页面通过 SSE（`/dnotify/events`）收到目标，再用 `/dnotify/claim` **先到先得**认领，多页面并存时只切一个、切的是你正在用的那个页面。Windows 用 `activationType="protocol"`（不需要注册 COM 激活器），Linux 走 xdg-desktop-portal `OpenURI`（不起子进程）。
  - 目标：会话通知 → `session:<id>`（`uiWorkspace.openSession`，子代理会话进子代理界面、后台任务回主会话）；启动播报 → `page:settings-plugins`（合成 ⌘/Ctrl+, 开「设置」再点「内置插件」，打不开则退回插件面板）；旧式 `#dsh-notify=` 深链兼容。
  - 对外 API：`push`/`pushAlways`/`notify` 载荷新增 `url`（只接受 http/https）；只给 `sessionId` 时宿主自动生成会话链接。
- **修复：聚焦上报与会话级静默从未生效**。DSH 0.1.7-rc.2 的 `connection.rpc.handle` 把 owner 解析成连接服务的影子 fiber，随后要 `owner.webServer.register(route)`（`rpc-host.ts:86-93/171-195`）——那条 fiber 链上读不到 `webServer`，cordis 抛 `cannot get property "webServer" without inject`，通道静默没注册（前端只看到 405）。改为插件自带 `/dnotify` 前缀路由（`ctx.webServer.register` + `connection.admit` 信任栅栏，纯 JSON POST）。
- **插件简介**改为「DSH桌面通知」（原先一长串中英混排说明显示不下）；Toast XML 组装抽到 `lib/toast-xml.js`（转义/协议激活有纯函数单测）。
- 两个已踩过的坑记在这里：① `ctx.timeout/ctx.effect` 返回 `Disposable<Promise<void>>`（可调用 + thenable，**没有 `.catch`**），在它上面调 `.catch` 会让整条路由 500——SSE 心跳改用自管 `setInterval`（自终止 + `unref`）；② BroadcastChannel 在同源同文档之间也会投递，靠它"交接给别的页面"会把跳转判给自己，所以投递改由宿主仲裁。
- 测试：宿主 32 项 + 浏览器 14 项，全套 118 项；`theme-probe` / `dsh-runtime-probe` 真机契约自检通过。

## [1.4.0] - 2026-09-25

- **适配 DSH 0.1.7-rc.2**：`jobs` 服务面在 0.1.7-alpha.1 被合并成一条事件流（`onJobDone`/`JobSnapshot` 已移除），改用 `jobs.events.subscribe({ owners: 'all' })` 的 `settled` 事件——`owner` 现在是 SessionId、`reported` 由 `awaited` 取代（已被等待方收走的结算不重复打扰），正文按 status 区分「已完成/失败/被终止」；`connection.rpc.handle` 回到两参签名并返回 `{ ok: true, value }` / `{ ok: false, error: { code, message, details } }`；删掉 `dsh.client.inject` 里并不存在的 `@deepseek-ai/dsh-client-runtime` 与对应 `peerDependencies`（声明了也不生效）。
- **修复会话级静默完全失效**：客户端会话快照（`SessionListState`）里**没有** `current` 字段，浏览器半区改读 `byId[*].retainedBy.mainView > 0`（官方 ui-layout / ui-session / ui-open-in-app 用的同一判据）；上报改走官方 `ctx.get('connection').rpc.call`（载体可能不是 fetch），只有 `pagehide` 那一次用 raw fetch（要 `keepalive`）且改文档相对路径；会话订阅改用 `ctx.inject` 等服务就绪；新增 1 分钟聚焦心跳，避免「盯着屏幕读两分钟没碰鼠标」被保鲜超时误判为失焦而误弹。
- **新增深浅两套通知图标 + 系统主题跟踪**：通知背景跟随系统深浅色，而图标不会被反色——随包新增 `assets/dsh-light.{png,ico}`（黑鱼，浅色主题用）与 `assets/dsh-dark.{png,ico}`（白鱼），发送时按当前主题选一套（旧路径 `dsh.{png,ico}` 保留为深色版本副本）。Windows 读 `HKCU\...\Themes\Personalize\SystemUsesLightTheme`（退 `AppsUseLightTheme`），用 `RegNotifyChangeKeyValue` 异步事件 + 2 秒非阻塞句柄检查跟踪切换；Linux 读 xdg-desktop-portal 的 `OrgFreedesktopAppearance/color-scheme` 并订阅 `SettingChanged` 信号；两条通道都挂 60 秒兜底重读，读不到时保持原值（绝不把「读不到」当成浅色）。主题变化时同步改写 AUMID 图标，通知中心的应用图标一起换色。
- **Linux D-Bus 层重写**：抽出 `lib/dbus.js`（常驻会话总线：SASL EXTERNAL → **Hello** 注册 → 方法调用与回复按 serial 配对 → `AddMatch` 信号订阅 → 断线重连/冷却/错误去重），通知发送与主题跟踪共用一条连接；补齐总线强制的 `Hello` 握手（没有它连信号订阅都做不了），并修正 `method_return` 里 `REPLY_SERIAL`/`UNIX_FDS` 被当字符串解码导致回复整体错位的问题。
- **修复与加固**：`fs.resolve` 是异步的，默认工作区名原先恒为空串（多工作区回退场景前缀丢失）；`agents.roots()` 拿不到或为空时不再把「任务完成」通知整类静默丢掉（退回会话谱系判断）；按会话/按 id 的缓存全部改为有界容器（回复摘要 64 / 审批配对 64 / 提问时刻 32，超出淘汰最旧），常驻进程不再随会话数增长；同文案 1.5 秒内只弹一次；待发队列上限 32 条；`desktopNotify` 服务重复注册不再让整个插件挂掉；热更新时「新 apply 先跑、旧 cleanup 后跑」不会把新的主题监听停掉。
- **对外 API 语义修正**：`push()` 原先只要载荷有效就返回 `true`（被静默时也是 `true`），现在只有**真的入队**才返回 `true`，并新增 `notify(item)` 返回 `{ ok, queued, silenced, reason }` 明细（`reason`: `''` / `invalid-payload` / `silenced` / `duplicate` / `dropped`）。
- **自检工具**：`scripts/check-syntax.mjs`（自动枚举 `lib/*.js` 逐个 `node --check`）、`scripts/theme-probe.mjs`（主题检查 + 切换事件链路自检，用临时注册表键，不碰系统主题）、`scripts/dsh-runtime-probe.mjs`（把宿主半区挂进 DSH 自带的 cordis 跑注入/作用域事件/延迟注册/注销清理的契约自检，不发真实通知）；`scripts/make-icon.py` 一次生成深浅两套图标。

## [1.3.12] - 2026-09-11

- **新增 Linux 支持**：`lib/toast-linux.js` 用纯 JS 直说 D-Bus 协议（`$DBUS_SESSION_BUS_ADDRESS` 或 `/run/user/<uid>/bus`，SASL EXTERNAL 握手 → `org.freedesktop.Notifications.Notify`），不调用 `notify-send`、不新增依赖；连接常驻复用、断开自动重连，编组逻辑有单测（`npm test`）。`lib/index.js` 按平台动态加载发送层——win32 之外不再 import koffi。
- **新增对外推送 API**：插件注册 Cordis 服务 `desktopNotify`，其它插件 `ctx.get('desktopNotify')` 即可推送——`push(item)` 走聚焦门控（按会话），`pushAlways(item)` 绕过门控始终弹；载荷 `{ title, message?, urgency?, sessionId? }`，标题为空不推送。逻辑在 `lib/api.js` 并有单测（`npm test`）。
- **聚焦门控改为按会话**：浏览器半区上报"页面聚焦状态 + 该页面当前选中的会话"（客户端 `sessions` 服务的 `list.current`，切换会话即时重报），宿主按"页面 × 会话"判定——**只静默你正在看的那个会话**，看会话 A 时会话 B 完成照样弹；拿不到会话归属的通知（例如 owner 已清理的后台任务）一律推送。门控逻辑抽到 `lib/gate.js` 并有单测（`npm test`）。
- **发送层重写为进程内原生直连**：Windows 用 `koffi` 直调 WinRT 发 Toast（`ToastNotificationManager` → `ForUser` → `CreateToastNotifierWithId` → `XmlDocument.LoadXml` → `Show`），彻底移除 Python 助手、`desktop-notifier` 依赖与 stdin 子进程协议——单条发送是几次进程内 vtable 调用，无冷启动、无进程重建逻辑。
- AUMID 图标改为插件自己维护：首次发送前幂等写入 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH`（`DisplayName` + `IconUri`，经 advapi32 直调），不再需要快捷方式与 Python 注册脚本；`scripts/register-aumid.py` 已删除。
- 安装脚本更新：`scripts/install.ps1` 移除 Python 前置，改为**真实探测** `koffi` 能否 `require`（原先按 `build/` 目录判断会把装好的 koffi 误报为缺失），离线回退会连 `@koromix/koffi-<平台>-<架构>` 一起拷贝；登记项写入包的真实版本号；补 UTF-8 BOM 以免 PowerShell 5.1 下中文乱码。`scripts/install.sh` 面向 Linux（D-Bus 原生通知）。
- `scripts/winrt-probe.mjs` 改为调用 `lib/winrt.js` 的正式代码路径（注册 AUMID + 发一条真实 Toast），作为合并/安装前的冒烟测试。
- **一轮独立审查后的加固**：`jobs` 钩子改用 `ctx.inject` 延迟注册（服务晚挂载也不会让「后台任务结束」通知永久静默）；D-Bus 连接加 15s 超时与失败冷却、错误去重（挂死的总线不再让通知静默堆积）；审批配对缓存加上限 64（孤儿条目不无界增长）；文本截断不再切断 emoji 等代理对（新增 `lib/text.js`）；AUMID 注册失败允许 1 分钟后重试；WinRT 接口引用按 COM 规则释放（常驻宿主不再每条泄漏对象）；客户端重复加载不再重复挂监听；抽象总线地址失败时给出替代方案提示。

## [1.0.0] - 2026-08-29

- 首个正式版本：随 `dsh web` 自动加载的桌面通知插件（免审批 bundle 形态）。
- 通知类别：
  - ✅ 任务完成（`agent/status` running→idle，仅根 agent，3 秒去抖，会话标题 + 回复摘要）
  - ❓ 等待你回答（`tools/execute` 捕获 `ask_user_question` 派发）
  - 🚫 DSH 审批被自动拒绝（`session/event` 流 `approval/asked`+`decided` 审计对）
  - 🤖 后台子任务结束（`subagent/end`）
  - 🎯 DSH 目标完成 / 阻塞（`goal/changed`）
  - 🧰 DSH 后台任务结束（jobs `onJobDone`）
- 防打扰：浏览器半区经 Connection RPC 通道 `/dnotify` 上报页面可见性，仅页面不可见时弹（30 秒心跳 + `visibilitychange` 即时上报，页面关闭 90 秒后视为不可见）。
- 通知由一次性 Python 进程 + `desktop-notifier`（Windows Toast）发送；700ms 队列间隔防轰炸；提问后 15 秒内抑制「任务完成」避免双重打扰。
- 修复：`ctx.connection.rpc.handle` 补第三参 `{ authority: 'loopback' }`（dsh-client-connection rc 新增必填 `options.authority`，缺失会导致插件树加载失败）。
