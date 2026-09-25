// DSH 桌面通知 — 系统深浅色跟踪（宿主半区）
//
// 通知图标必须与通知背景形成对比，而背景跟系统主题走、图标本身不会被反色：
//   深色主题 → 白鱼；浅色主题 → 黑鱼（见 lib/icons.js 与 scripts/make-icon.py）。
//
// 因此这里做两件事：
//   1. 模式检查：启动时读一次系统主题（Windows 读注册表，Linux 查 portal）；
//   2. 切换事件跟踪：Windows 用 RegNotifyChangeKeyValue 拿"注册表变更"事件，
//      Linux 订阅 org.freedesktop.portal.Settings 的 SettingChanged 信号；
//      两者都再挂一个低频兜底重读（事件注册失败、portal 晚启动等场景）。
//
// 平台后端按需动态 import：win32 之外的平台**绝不能**加载 theme-win32.js，
// 反之亦然（各自顶层会 load 平台专属的 DLL / 走 D-Bus）。
//
// 对外只暴露：currentTheme() / startThemeWatch() / stopThemeWatch() / onThemeChange()。

import { THEME_DARK, THEME_LIGHT, normalizeTheme } from './theme-codec.js'

export { THEME_DARK, THEME_LIGHT }

/** 兜底重读间隔：事件驱动的通道都不可靠时的安全网（portal 晚启动、注册表通知被策略拦）。 */
export const THEME_VERIFY_MS = 60000
/** 失败的读取最短重试间隔（避免 portal 不存在时每 60s 也刷日志）。 */
export const THEME_RETRY_MS = 300000

const BACKENDS = { win32: './theme-win32.js', linux: './theme-linux.js' }

/** 当前生效主题：读不到时保持原值，启动默认深色（旧版白色图标的行为）。 */
let current = THEME_DARK
/** 主题状态世代：每次真正变化 +1，供在途读取判断自己是否已经陈旧。 */
let themeGeneration = 0
const listeners = new Set()

let backend = null
let backendLoaded = false
let backendError = null
let unwatch = null
let verifyTimer = null
let refreshing = false
let refreshQueued = false
let refreshQueuedForce = false
let lastReadAt = 0
let lastReadOk = false
let warnedBackend = false

/** 当前生效主题（发送时按它选图标）。 */
export function currentTheme() {
  return current
}

/**
 * 订阅主题变化。
 * @param {(theme: string) => void} listener
 * @returns {() => void} 取消订阅
 */
export function onThemeChange(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 写入当前主题；变化时通知订阅者。
 * @param {unknown} theme
 * @returns {boolean} 是否发生变化
 */
export function setTheme(theme) {
  const next = normalizeTheme(theme)
  if (next === current) return false
  current = next
  themeGeneration += 1   // 让在途的陈旧读取知道自己该退让
  for (const listener of listeners) {
    try { listener(next) } catch (e) { /* 订阅者自己炸不能影响主题状态 */ }
  }
  return true
}

/** 仅测试用：把状态复位（模块级单例，测试间必须隔离）。 */
export function resetThemeState() {
  stopThemeWatch()
  current = THEME_DARK
  themeGeneration += 1
  listeners.clear()
  backend = null
  backendLoaded = false
  backendError = null
  lastReadAt = 0
  lastReadOk = false
  refreshing = false
  refreshQueued = false
  refreshQueuedForce = false
}

/**
 * 读一次系统主题并写入状态。读不到时保持原值（返回 null）。
 * @param {{force?: boolean}} [options] force=true 跳过失败退避（事件驱动路径：
 *   既然已经发生"可能变化"的信号，就值得立刻重读一次）
 */
export async function refreshTheme(options = {}) {
  if (!backend) return null
  // 已有一次读取在飞：记一个"待重读"，等它结束再补一次，避免切换事件正好撞上
  // 在途读取而被丢掉（那样要等 60s 兜底才生效）。
  if (refreshing) {
    refreshQueued = true
    // force 必须一起传递：总线就绪时的补读正好会撞上冷启动那次在途读取，
    // 若重放时丢掉 force，就会被失败退避挡掉——正是 M2 想修的场景。
    if (options.force) refreshQueuedForce = true
    return null
  }
  const now = Date.now()
  // 失败后的退避：portal 不存在时别每次都发起调用（force 用于事件/总线就绪后的补读）
  if (!options.force && !lastReadOk && lastReadAt && now - lastReadAt < THEME_RETRY_MS) return null
  refreshing = true
  lastReadAt = now
  // 读取开始时的状态世代：读取期间若有事件派发的结论落地（setTheme 会 +1），
  // 这次读到的就是陈旧值，必须丢弃而不是覆盖更新的结论。
  const generationAtStart = themeGeneration
  let theme = null
  try {
    theme = await backend.read()
    if (themeGeneration !== generationAtStart) {
      return null   // 期间已有更新的事件结论：保留它
    }
    lastReadOk = theme === THEME_DARK || theme === THEME_LIGHT
    if (lastReadOk) setTheme(theme)
  } catch (e) {
    lastReadOk = false
    theme = null
  } finally {
    refreshing = false
  }
  if (refreshQueued) {
    refreshQueued = false
    const force = refreshQueuedForce
    refreshQueuedForce = false
    void refreshTheme(force ? { force: true } : undefined)
  }
  return theme
}

async function loadBackend() {
  const spec = BACKENDS[process.platform]
  if (!spec) return null
  try {
    return await import(spec)
  } catch (e) {
    backendError = e
    return null
  }
}

/**
 * 启动主题跟踪（幂等）。任何失败都只降级，不影响通知发送。
 * @returns {Promise<'dark'|'light'>} 启动后的主题
 */
export async function startThemeWatch() {
  if (backendLoaded) return current
  backendLoaded = true
  backend = await loadBackend()
  if (!backend) {
    if (!warnedBackend) {
      warnedBackend = true
      if (backendError) {
        console.error('[dsh-desktop-notify] 主题后端加载失败，图标固定用深色款:',
          backendError && backendError.message)
      }
    }
    return current
  }
  // Windows 后端可以同步读：先立即定准一次，避免"启动到首次读取之间"用错图标
  if (typeof backend.readSync === 'function') {
    try {
      const sync = backend.readSync()
      if (sync) { lastReadOk = true; lastReadAt = Date.now(); setTheme(sync) }
    } catch (e) { /* 交给异步路径 */ }
  }
  try {
    await refreshTheme()
  } catch (e) { /* ignore */ }
  if (typeof backend.watch === 'function') {
    try {
      unwatch = backend.watch((theme) => {
        // 信号里已带结论时直接采用（少一次往返）；否则强制回读
        // （事件即"可能变了"，不该被失败退避挡住）
        if (theme === THEME_DARK || theme === THEME_LIGHT) {
          lastReadOk = true
          lastReadAt = Date.now()
          setTheme(theme)
        } else {
          void refreshTheme({ force: true })
        }
      })
    } catch (e) {
      unwatch = null
    }
  }
  if (!verifyTimer) {
    verifyTimer = setInterval(() => { void refreshTheme() }, THEME_VERIFY_MS)
    if (typeof verifyTimer.unref === 'function') verifyTimer.unref()
  }
  return current
}

/** 停止主题跟踪并释放平台资源（插件卸载时调用）。 */
export function stopThemeWatch() {
  if (verifyTimer) {
    clearInterval(verifyTimer)
    verifyTimer = null
  }
  if (typeof unwatch === 'function') {
    try { unwatch() } catch (e) { /* ignore */ }
  }
  unwatch = null
  if (backend && typeof backend.dispose === 'function') {
    try { backend.dispose() } catch (e) { /* ignore */ }
  }
  backend = null
  backendLoaded = false
}
