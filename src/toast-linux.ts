// DSH 桌面通知 — Linux 发送模块（纯 JS 直连 D-Bus，无子进程、无第三方依赖）
//
// 链路：lib/dbus.js 的常驻会话总线（SASL EXTERNAL → Hello → 方法调用）
//   → org.freedesktop.Notifications.Notify
//   → 消息编组（小端，method_call，header fields：PATH/INTERFACE/MEMBER/DESTINATION/SIGNATURE）
//
// 发送是异步的：连接由 lib/dbus.js 惰性建立并常驻复用，断开后下次发送自动重连；
// 调用方（lib/index.js 的队列）不被阻塞。通知被服务拒绝时经 setErrorReporter 上报日志。
//
// 点击跳转（item.url）：带 url 的通知会声明一个 `default` 动作，桌面环境点击后发
// `ActionInvoked` 信号；本模块收到后调 **xdg-desktop-portal 的 OpenURI** 打开地址
// ——仍然不拉起任何子进程（不做 xdg-open 兜底，portal 不可用时只记一条日志）。
//
// 应用图标按当前系统主题选 assets/dsh-{dark,light}.png（见 lib/icons.js、lib/theme.js）。
// 编组逻辑是平台无关的纯函数（marshalNotifyBody / NOTIFY_SIGNATURE），可在任何平台上单测。

import { Writer, call, closeSession, onSignal, sendCall, setErrorReporter } from './dbus.js'
import { currentTheme } from './theme.js'
import { iconPathsFor } from './icons.js'
import { truncateText } from './text.js'

// 通知里显示的"应用名"（Linux 上就是这一项决定来源行，可以随便改；
// Windows 上对应的东西是 AUMID 的 DisplayName，见 winrt.ts）
const APP_NAME = 'DeepSeek Harness'
const DESTINATION = 'org.freedesktop.Notifications'
const OBJECT_PATH = '/org/freedesktop/Notifications'
const INTERFACE = 'org.freedesktop.Notifications'
const MEMBER = 'Notify'
/** Notify 的方法签名：app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout */
export const NOTIFY_SIGNATURE = 'susssasa{sv}i'

/** 默认动作键：桌面环境把"点击通知本体"映射到它。 */
export const DEFAULT_ACTION = 'default'
/** 动作按钮上的文字（有 default 动作时同时给一个显式按钮）。 */
const OPEN_ACTION_LABEL = '打开'

/** urgency 提示值（0 低 / 1 正常 / 2 紧急） */
const URGENCY_VALUE = { low: 0, normal: 1, critical: 2 }
/** 未指定超时：交给桌面环境决定 */
const DEFAULT_EXPIRE_TIMEOUT = -1

// OpenURI portal（打开链接；无子进程）
const PORTAL_DESTINATION = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'
const PORTAL_OPEN_URI = 'org.freedesktop.portal.OpenURI'

/** 通知 id → 点击意图（有上限；只保留可点击的通知）。 */
const MAX_CLICK_TARGETS = 32
const clickTargets = new Map()
/** 刚发出、还没等到 Notify 回复的通知 id → 意图：覆盖"用户比回复更快点击"的窗口。 */
const pendingClicks = []
const MAX_PENDING_CLICKS = 8
let clickSignalBound = false

// ---------------------------------------------------------------------------
// 编组（marshalling）— 纯函数，便于单测
// ---------------------------------------------------------------------------

/**
 * 编组 Notify 的方法体（签名 susssasa{sv}i）。
 * hints 里**始终**带一条 urgency——非空数组的元素对齐没有歧义（空 a{sv} 的对齐
 * 在实现间存在分歧，故意避开）。
 * @param {{title?: string, message?: string, urgency?: string, iconPath?: string, clickable?: boolean}} item
 * @returns {Buffer}
 */
export function marshalNotifyBody(item) {
  const w = new Writer()
  w.str(APP_NAME)                                   // s app_name
  w.u32(0)                                          // u replaces_id
  w.str(item.iconPath || iconPathsFor(currentTheme()).png) // s app_icon
  w.str(truncateText(item.title || '', 160))     // s summary
  w.str(truncateText(item.message || '', 400))   // s body
  // as actions：可点击时给 default + 一个按钮，否则空数组（元素对齐 4 无歧义）
  w.align(4)
  if (item.clickable) {
    const actions = new Writer()
    actions.str(DEFAULT_ACTION).str(OPEN_ACTION_LABEL)
    w.u32(actions.length)
    w.raw(actions.buffer())
  } else {
    w.u32(0)
  }
  // a{sv} hints：一条 urgency
  w.align(4)
  const hintsLenPos = w.length
  w.u32(0)                                          // 长度占位
  w.align(8)                                        // 元素（dict entry）对齐
  const hintsStart = w.length
  w.str('urgency')
  w.sig('y')
  w.u8(URGENCY_VALUE[item.urgency] === undefined ? URGENCY_VALUE.normal : URGENCY_VALUE[item.urgency])
  const hintsLen = w.length - hintsStart
  w.i32(DEFAULT_EXPIRE_TIMEOUT)                     // i expire_timeout
  const buf = w.buffer()
  buf.writeUInt32LE(hintsLen, hintsLenPos)
  return buf
}

// ---------------------------------------------------------------------------
// 点击 → 打开链接
// ---------------------------------------------------------------------------

/** 记住"这条通知点击要做什么"。 */
function rememberClickTarget(id, intent) {
  if (!Number.isFinite(id) || !intent) return
  if (clickTargets.size >= MAX_CLICK_TARGETS) {
    const oldest = clickTargets.keys().next().value
    clickTargets.delete(oldest)
  }
  clickTargets.set(id, intent)
}

/**
 * 点击处理：Linux 的点击是**宿主进程内**的事件（不需要浏览器），所以这里直接按
 * 三态语义走宿主决策：
 *   · 外部地址           → 直接 portal OpenURI
 *   · session / page 目标 → GET 激活端点，由宿主决定"投递给已打开页面"还是"新开 DSH"
 *     宿主回 open 才调 portal（delivered 时一个窗口都不开）
 */
async function handleClick(intent) {
  if (typeof intent === 'string') {
    await openViaPortal(intent)
    return
  }
  const response = await fetch(intent.activate, { method: 'GET' })
  if (!response.ok) throw new Error(`activate HTTP ${response.status}`)
  const plan = await response.json()
  if (plan && plan.action === 'open' && typeof plan.url === 'string' && plan.url) {
    await openViaPortal(plan.url)
  }
}

/** 订阅 ActionInvoked（只挂一次）：点击可点击通知时执行宿主给出的计划。 */
function bindClickHandler() {
  if (clickSignalBound) return
  clickSignalBound = true
  onSignal({ interface: INTERFACE, member: 'ActionInvoked' }, (args) => {
    const id = args && args[0]
    const action = args && args[1]
    if (action !== DEFAULT_ACTION && action !== OPEN_ACTION_LABEL) return
    let intent = clickTargets.get(id)
    clickTargets.delete(id)
    if (intent === undefined) {
      // 极快点击：Notify 的回复还没回来。用最近一条待认领的意图兜底（有界 + 5s 窗口）。
      const now = Date.now()
      while (pendingClicks.length > 0 && now - pendingClicks[0].at > 5000) pendingClicks.shift()
      // 兜底只能用在"因果关系唯一"的时候：pendingClicks 按时间排序，若同时有 ≥2 条待处理，
      // shift() 可能把 B 的点击算成 A（连发两条通知 + 极快点击的理论竞态）。
      // 宁可漏一次跳转，也不能跳到错的会话上。
      if (pendingClicks.length === 1) {
        const fallback = pendingClicks.shift()
        if (fallback) intent = fallback.intent
      } else if (pendingClicks.length > 1) {
        console.error('[dsh-desktop-notify] 收到通知 id 未知的点击，且有 ' + pendingClicks.length + ' 条待处理，无法确定归属，已放弃')
      }
    }
    if (intent === undefined) return
    void handleClick(intent).catch((e) => {
      console.error('[dsh-desktop-notify] 点击跳转失败（portal/fetch 不可用）:', e && e.message)
    })
  })
}

/** 用 portal 打开链接（OpenURI：parent_window 传空串表示无父窗口）。 */
async function openViaPortal(url) {
  const options = new Writer()
  options.align(4)
  const entry = new Writer()
  entry.align(8).str('handle_token').sig('v').sig('s').str('dsh_notify_' + Date.now().toString(36))
  options.u32(entry.length)
  options.raw(entry.buffer())
  await call({
    destination: PORTAL_DESTINATION,
    path: PORTAL_PATH,
    interface: PORTAL_OPEN_URI,
    member: 'OpenURI',
    signature: 'ssa{sv}',
    body: new Writer().str('').str(url).raw(options.buffer()).buffer(),
    timeoutMs: 5000,
  })
}

// 通知被通知服务拒绝（例如没有 notification daemon）时只记一条日志：
// 常驻宿主里没有调用方在等这次发送，抛异常只会变成 unhandled rejection。
let lastNotifiedError = null
setErrorReporter((error) => {
  const message = (error && error.message) || String(error)
  if (lastNotifiedError === message) return
  lastNotifiedError = message
  console.error('[dsh-desktop-notify] D-Bus 通知被拒绝:', message)
})

/**
 * 发送一条桌面通知（不阻塞调用方；失败只记录，不抛）。
 * @param {{title?: string, message?: string, urgency?: string, iconPath?: string, click?: {wire: string, open: string, activate: string}}} item
 *   click.wire === 'none' 表示不可点击（不给 default 动作，点了什么都不发生）
 */
export function sendToast(item) {
  const click = item && item.click && typeof item.click === 'object' ? item.click : null
  const clickable = !!click && !!click.wire && click.wire !== 'none'
  // 外部地址：portal 直接开；session/page：交给宿主的激活端点决策
  const intent = !clickable ? null
    : (typeof click.open === 'string' && click.open ? click.open : { activate: click.activate })
  const body = marshalNotifyBody({
    title: item && item.title,
    message: item && item.message,
    urgency: item && item.urgency,
    iconPath: item && item.iconPath,
    clickable,
  })
  const request = {
    destination: DESTINATION,
    path: OBJECT_PATH,
    interface: INTERFACE,
    member: MEMBER,
    signature: NOTIFY_SIGNATURE,
    body,
  }
  if (!clickable) {
    sendCall(request)   // 不可点击：仍然 fire-and-forget，不占等待表
    return
  }
  // 可点击：需要 Notify 返回的通知 id 才能把 ActionInvoked 映射回意图。
  // 同时记一条 pending：用户可能在回复到达前就点了（极快点击的时序窗口）。
  bindClickHandler()
  if (pendingClicks.length >= MAX_PENDING_CLICKS) pendingClicks.shift()
  const stamp = { at: Date.now(), intent }
  pendingClicks.push(stamp)
  call({ ...request, timeoutMs: 5000 }).then((reply) => {
    const id = Array.isArray(reply) ? reply[0] : undefined
    if (!Number.isFinite(id)) return
    // 回复到了：从 pending 里摘掉，正式登记到 id 上
    const index = pendingClicks.indexOf(stamp)
    if (index >= 0) pendingClicks.splice(index, 1)
    rememberClickTarget(id, intent)
  }).catch((e) => {
    const message = (e && e.message) || String(e)
    if (lastNotifiedError === message) return
    lastNotifiedError = message
    console.error('[dsh-desktop-notify] D-Bus 通知被拒绝:', message)
  })
}

/** 主动断开（插件卸载时调用）。 */
export function closeToastConnection() {
  clickTargets.clear()
  pendingClicks.length = 0
  clickSignalBound = false
  closeSession()
}
