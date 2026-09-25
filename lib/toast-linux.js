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

const APP_NAME = 'DSH'
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

/** 通知 id → 点击要打开的地址（有上限；只保留带 url 的通知）。 */
const MAX_CLICK_TARGETS = 32
const clickTargets = new Map()
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

function rememberClickTarget(id, url) {
  if (!Number.isFinite(id) || !url) return
  if (clickTargets.size >= MAX_CLICK_TARGETS) {
    const oldest = clickTargets.keys().next().value
    clickTargets.delete(oldest)
  }
  clickTargets.set(id, url)
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

/** 订阅 ActionInvoked（只挂一次）：点击带 url 的通知时打开对应地址。 */
function bindClickHandler() {
  if (clickSignalBound) return
  clickSignalBound = true
  onSignal({ interface: INTERFACE, member: 'ActionInvoked' }, (args) => {
    const id = args && args[0]
    const action = args && args[1]
    const url = clickTargets.get(id)
    clickTargets.delete(id)
    if (!url || (action !== DEFAULT_ACTION && action !== OPEN_ACTION_LABEL)) return
    void openViaPortal(url).catch((e) => {
      console.error('[dsh-desktop-notify] 点击跳转失败（portal OpenURI 不可用）:', e && e.message,
        '目标:', url)
    })
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
 * @param {{title?: string, message?: string, urgency?: string, iconPath?: string, url?: string}} item
 */
export function sendToast(item) {
  const url = typeof item?.url === 'string' ? item.url : ''
  const body = marshalNotifyBody({
    title: item && item.title,
    message: item && item.message,
    urgency: item && item.urgency,
    iconPath: item && item.iconPath,
    clickable: !!url,
  })
  const request = {
    destination: DESTINATION,
    path: OBJECT_PATH,
    interface: INTERFACE,
    member: MEMBER,
    signature: NOTIFY_SIGNATURE,
    body,
  }
  if (!url) {
    sendCall(request)   // 不可点击：仍然 fire-and-forget，不占等待表
    return
  }
  // 可点击：需要 Notify 返回的通知 id 才能把 ActionInvoked 映射回地址
  bindClickHandler()
  call({ ...request, timeoutMs: 5000 }).then((reply) => {
    const id = Array.isArray(reply) ? reply[0] : undefined
    if (Number.isFinite(id)) rememberClickTarget(id, url)
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
  clickSignalBound = false
  closeSession()
}
