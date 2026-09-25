// DSH 桌面通知 — Linux 发送模块（纯 JS 直连 D-Bus，无子进程、无第三方依赖）
//
// 链路：lib/dbus.js 的常驻会话总线（SASL EXTERNAL → Hello → 方法调用）
//   → org.freedesktop.Notifications.Notify
//   → 消息编组（小端，method_call，header fields：PATH/INTERFACE/MEMBER/DESTINATION/SIGNATURE）
//
// 发送是异步 fire-and-forget：连接由 lib/dbus.js 惰性建立并常驻复用，
// 断开后下次发送自动重连；调用方（lib/index.js 的队列）不被阻塞。
// 通知被服务拒绝时经 setErrorReporter 上报一条日志，不打断宿主。
//
// 应用图标按当前系统主题选 assets/dsh-{dark,light}.png（见 lib/icons.js、lib/theme.js）。
// 编组逻辑是平台无关的纯函数（marshalNotifyBody / NOTIFY_SIGNATURE），可在任何平台上单测。

import { Writer, closeSession, sendCall, setErrorReporter } from './dbus.js'
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

/** urgency 提示值（0 低 / 1 正常 / 2 紧急） */
const URGENCY_VALUE = { low: 0, normal: 1, critical: 2 }
/** 未指定超时：交给桌面环境决定 */
const DEFAULT_EXPIRE_TIMEOUT = -1

// ---------------------------------------------------------------------------
// 编组（marshalling）— 纯函数，便于单测
// ---------------------------------------------------------------------------

/**
 * 编组 Notify 的方法体（签名 susssasa{sv}i）。
 * hints 里**始终**带一条 urgency——非空数组的元素对齐没有歧义（空 a{sv} 的对齐
 * 在实现间存在分歧，故意避开）。
 * @param {{title?: string, message?: string, urgency?: string, iconPath?: string}} item
 * @returns {Buffer}
 */
export function marshalNotifyBody(item) {
  const w = new Writer()
  w.str(APP_NAME)                                   // s app_name
  w.u32(0)                                          // u replaces_id
  w.str(item.iconPath || iconPathsFor(currentTheme()).png) // s app_icon
  w.str(truncateText(item.title || '', 160))     // s summary
  w.str(truncateText(item.message || '', 400))   // s body
  w.align(4)
  w.u32(0)                                          // as actions（空数组，元素对齐 4 无歧义）
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
 * 发送一条桌面通知（异步 fire-and-forget；失败只记录，不抛给调用方）。
 * @param {{title?: string, message?: string, urgency?: string, iconPath?: string}} item
 */
export function sendToast(item) {
  sendCall({
    destination: DESTINATION,
    path: OBJECT_PATH,
    interface: INTERFACE,
    member: MEMBER,
    signature: NOTIFY_SIGNATURE,
    body: marshalNotifyBody({
      title: item && item.title,
      message: item && item.message,
      urgency: item && item.urgency,
      iconPath: item && item.iconPath,
    }),
  })
}

/** 主动断开（插件卸载时调用）。 */
export function closeToastConnection() {
  closeSession()
}
