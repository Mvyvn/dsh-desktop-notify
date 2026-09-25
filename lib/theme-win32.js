// DSH 桌面通知 — Windows 系统主题后端
//
// 检查：HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize
//   · SystemUsesLightTheme —— 任务栏/通知中心的深浅色（Toast 背景跟它走），首选
//   · AppsUseLightTheme    —— 应用窗口深浅色，前者缺失时兜底
// 切换事件：RegNotifyChangeKeyValue(..., hEvent, 异步) 注册"键值被改写"通知，
//   系统把事件对象置为有信号；本模块用 2s 的非阻塞 WaitForSingleObject(…,0) 轮询该
//   事件（纯句柄检查，不读注册表、不占线程），触发后才重读主题并重新注册。
//   若注册表通知注册失败（策略/权限），退化为只靠 lib/theme.js 的低频兜底重读。
//
// ⚠️ 只能在 win32 平台被 import（顶层 koffi.load advapi32/kernel32）。

import {
  HKEY_CURRENT_USER, KEY_NOTIFY, KEY_QUERY_VALUE, closeHandle, closeKey, createEvent,
  isEventSignaled, notifyKeyChange, openKey, readDword,
} from './win32-registry.js'
import { themeFromLightFlag } from './theme-codec.js'

/** Toast 背景跟随"系统"主题（任务栏/操作中心），读不到再退到应用主题。 */
const PERSONALIZE_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
const SYSTEM_VALUE = 'SystemUsesLightTheme'
const APPS_VALUE = 'AppsUseLightTheme'

/** 事件句柄轮询间隔：只是一次 WaitForSingleObject(…,0)，开销可忽略。 */
const EVENT_POLL_MS = 2000

let eventHandle = 0
let keyHandle = 0
let pollTimer = null

/**
 * 同步读一次系统主题。
 * @returns {'dark'|'light'|null} 两个值都读不到时 null
 */
export function readSync() {
  const system = readDword(HKEY_CURRENT_USER, PERSONALIZE_KEY, SYSTEM_VALUE)
  const theme = themeFromLightFlag(system)
  if (theme) return theme
  return themeFromLightFlag(readDword(HKEY_CURRENT_USER, PERSONALIZE_KEY, APPS_VALUE))
}

/** 异步读取（与同步读取同源；接口与 Linux 后端保持一致）。 */
export async function read() {
  return readSync()
}

function disarm() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (keyHandle) {
    closeKey(keyHandle)
    keyHandle = 0
  }
  if (eventHandle) {
    closeHandle(eventHandle)
    eventHandle = 0
  }
}

function arm(onChange) {
  // 幂等：重复 arm 不先释放会覆盖旧的键/事件句柄，那一对就永远回收不掉了
  disarm()
  keyHandle = openKey(HKEY_CURRENT_USER, PERSONALIZE_KEY, KEY_QUERY_VALUE | KEY_NOTIFY)
  if (!keyHandle) return false
  eventHandle = createEvent()
  if (!eventHandle) return false
  if (!notifyKeyChange(keyHandle, eventHandle)) return false
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (!isEventSignaled(eventHandle)) return
      // 自动重置事件：等到即被清；立刻重新注册下一次通知（注册是一次性的）
      if (!notifyKeyChange(keyHandle, eventHandle)) {
        // 重新注册失败：停掉事件通道，交给 theme.js 的兜底重读
        disarm()
        return
      }
      try { onChange() } catch (e) { /* 订阅者异常不影响跟踪 */ }
    }, EVENT_POLL_MS)
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }
  return true
}

/**
 * 跟踪主题切换。
 * @param {() => void} onChange 主题可能变化时回调（由调用方重读）
 * @returns {() => void} 取消跟踪
 */
export function watch(onChange) {
  const ok = arm(onChange)
  if (!ok) {
    disarm()
    // 事件通道挂不上（策略/权限）不算致命：lib/theme.js 还有低频兜底重读，
    // 只是主题切换要等下一次轮询才生效——留一行日志便于排查。
    console.error('[dsh-desktop-notify] 主题切换事件注册失败，改用兜底轮询')
  }
  return () => disarm()
}

/** 进程内单例清理。 */
export function dispose() {
  disarm()
}
