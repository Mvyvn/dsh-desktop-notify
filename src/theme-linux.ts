// DSH 桌面通知 — Linux 系统主题后端
//
// 检查：xdg-desktop-portal 的 org.freedesktop.portal.Settings.Read
//   ('org.freedesktop.appearance', 'color-scheme') → v(u)：0=无偏好 / 1=深色 / 2=浅色。
//   这是跨桌面（GNOME/KDE/…）的标准入口；portal 不可用时退到环境变量启发式。
// 切换事件：订阅同一接口的 SettingChanged(namespace, key, value) 信号
//   （lib/dbus.js 负责 AddMatch 与连接重建后的重新订阅）。
//
// 复用 lib/dbus.js 的常驻会话总线：与通知发送共一条连接，不额外建连。

import { Writer, call, onReady, onSignal } from './dbus.js'
import { themeFromColorScheme, themeFromEnv } from './theme-codec.js'

const PORTAL_DESTINATION = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'
const PORTAL_INTERFACE = 'org.freedesktop.portal.Settings'
const APPEARANCE_NAMESPACE = 'org.freedesktop.appearance'
const COLOR_SCHEME_KEY = 'color-scheme'

let unsubscribe = null
let unsubscribeReady = null

/**
 * 读一次系统主题：portal 优先，读不到再用环境变量兜底。
 *
 * ⚠️ 这里**不能**先判 isReady()：冷启动时总线还没建连，直接返回 null 会让调用方
 * 记一次"读取失败"，于是进入 5 分钟退避——浅色主题的用户在头几分钟里只能看到
 * 白鱼图标（正是本功能要修的场景）。dbus.call() 本身会惰性建连并排队，
 * 连不上时快速失败即可。
 *
 * @returns {Promise<'dark'|'light'|null>}
 */
export async function read() {
  const fromPortal = await readPortal()
  if (fromPortal) return fromPortal
  return themeFromEnv()
}

async function readPortal() {
  const body = new Writer().str(APPEARANCE_NAMESPACE).str(COLOR_SCHEME_KEY).buffer()
  const reply = await call({
    destination: PORTAL_DESTINATION,
    path: PORTAL_PATH,
    interface: PORTAL_INTERFACE,
    member: 'Read',
    signature: 'ss',
    body,
    timeoutMs: 4000,
  })
  return themeFromColorScheme(reply && reply[0])
}

/**
 * 跟踪主题切换：SettingChanged 信号 + 总线就绪时补读一次。
 * @param {(theme?: 'dark'|'light') => void} onChange 变化回调；能直接得出主题时带上主题
 * @returns {() => void} 取消跟踪
 */
export function watch(onChange) {
  if (unsubscribe) return unsubscribe
  unsubscribe = onSignal(
    { interface: PORTAL_INTERFACE, member: 'SettingChanged' },
    (args) => {
      const [namespace, key, value] = args || []
      if (namespace !== APPEARANCE_NAMESPACE || key !== COLOR_SCHEME_KEY) return
      // 信号里的值本身带有结论时直接给出，省一次 Read；"无偏好"则让调用方回读
      try { onChange(themeFromColorScheme(value) || undefined) } catch (e) { /* 订阅者异常不影响跟踪 */ }
    },
  )
  // 总线（冷启动时通常晚于本插件）刚就绪：强制回读一次，别等 60s 兜底
  unsubscribeReady = onReady(() => {
    try { onChange() } catch (e) { /* ignore */ }
  })
  return () => {
    if (typeof unsubscribe === 'function') unsubscribe()
    unsubscribe = null
    if (typeof unsubscribeReady === 'function') unsubscribeReady()
    unsubscribeReady = null
  }
}

/** 取消订阅（插件卸载时调用）。 */
export function dispose() {
  if (typeof unsubscribe === 'function') unsubscribe()
  unsubscribe = null
  if (typeof unsubscribeReady === 'function') unsubscribeReady()
  unsubscribeReady = null
}
