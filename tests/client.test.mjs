// 浏览器半区（lib/client.js）单测：在 Node 里搭一个最小的 window/document 假环境，
// 按 __ModuleLoader__ 协议取出工厂函数，用假 ctx 真跑一遍 apply()。
//   npm test
//
// 锁住的行为：
//   · 选中会话取自 sessions 快照的 byId[*].retainedBy.mainView（0.1.7 没有 current）
//   · 聚焦/会话上报走自带的文档相对路由 dnotify/page-focus（纯 JSON POST；pagehide 带 keepalive）
//   · DOM 事件显式包装（Event 不能被当成 focused=true）；心跳只在聚焦时上报
//   · 点击通知：SSE(dnotify/events) 收到 navigate → POST dnotify/claim 认领 →
//     只有拿到 target 的页面执行跳转（多页面只切一个由 host 侧先到先得保证）
//   · 跳转目标：session:<id> → uiWorkspace.openSession；page:settings-plugins →
//     合成快捷键打开设置并点「内置插件」，打不开就退回插件面板；page:plugins → 插件面板
//   · 旧式 #dsh-notify= hash 仍能处理；卸载时监听器/订阅/心跳/SSE 全部清理
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8',
)

/** 造一个假 DOM 元素（只需要 textContent / click()）。 */
function element(label) {
  return {
    tagName: 'BUTTON',
    textContent: label,
    clicks: 0,
    click() { this.clicks += 1 },
    querySelectorAll: () => [],
  }
}

/** 建一个"页面"：假 window/document/ctx/定时器，装出 lib/client.js 的 apply。 */
function createPage(options = {}) {
  const fetches = []
  const listeners = new Map()
  const timers = new Map()
  const effects = []
  const injects = []
  const sessionStorage = new Map()
  const opened = []
  const state = {
    focused: options.focused !== false,
    visible: options.visible !== false,
    reloads: 0,
    hash: options.hash || '',
    settingsModal: options.settingsModal || null,
    documentButtons: options.documentButtons || [],
    eventSource: null,
    keyboardEvents: [],
  }
  let timerId = 0
  let now = 0

  const add = (target) => (type, fn) => {
    const key = target + ':' + type
    if (!listeners.has(key)) listeners.set(key, new Set())
    listeners.get(key).add(fn)
  }
  const remove = (target) => (type, fn) => {
    const set = listeners.get(target + ':' + type)
    if (set) set.delete(fn)
  }
  const dispatch = (target, type) => {
    for (const fn of [...(listeners.get(target + ':' + type) || [])]) fn({ type })
  }

  const window = {
    __ModuleLoader__: { load: () => { throw new Error('这里不该再注册') } },
    sessionStorage: {
      getItem: (k) => (sessionStorage.has(k) ? sessionStorage.get(k) : null),
      setItem: (k, v) => sessionStorage.set(k, String(v)),
    },
    localStorage: {
      getItem: (k) => (options.storage && options.storage.has(k) ? options.storage.get(k) : null),
      setItem: (k, v) => { if (options.storage) options.storage.set(k, String(v)) },
    },
    location: {
      origin: 'http://127.0.0.1:3080',
      pathname: '/',
      search: '',
      get hash() { return state.hash },
      reload() { state.reloads += 1 },
    },
    history: { replaceState: () => { state.hash = '' } },
    addEventListener: add('window'),
    removeEventListener: remove('window'),
    dispatchEvent: (event) => { state.keyboardEvents.push(event) },
    EventSource: class {
      constructor(url) {
        this.url = url
        this.readyState = 0
        this.handlers = {}
        state.eventSource = this
      }
      addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn) }
      emit(type, data) { for (const fn of this.handlers[type] || []) fn({ type: type, data: data }) }
      close() { this.readyState = 2; state.eventSource = null }
    },
    KeyboardEvent: class {
      constructor(type, init) { Object.assign(this, init, { type }) }
    },
  }
  const document = {
    addEventListener: add('document'),
    removeEventListener: remove('document'),
    get visibilityState() { return state.visible ? 'visible' : 'hidden' },
    hasFocus: () => state.focused,
    // 桌面端（Electron）判定读 <html data-platform=…>：给骨架一个可控的 dataset
    get documentElement() { return { dataset: options.desktopPlatform ? { platform: options.desktopPlatform } : {} } },
    querySelector: (selector) => {
      if (selector === '[data-shortcut-modal="settings"]') return state.settingsModal
      if (selector === 'button[aria-haspopup="menu"]') return state.menuTrigger || null
      return null
    },
    querySelectorAll: (selector) => {
      // 新实现用 `document.querySelectorAll('button,[role="button"],a')` 找真实设置入口
      if (typeof selector === 'string' && /button/i.test(selector)) {
        return options.launcher ? [options.launcher] : state.documentButtons
      }
      return state.documentButtons
    },
  }

  const sessionsState = { byId: options.byId || {} }
  const subscribers = new Set()
  const sessions = {
    list: {
      getSnapshot: () => sessionsState,
      subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn) },
    },
  }
  const services = { sessions: options.sessionsReady === false ? undefined : sessions }
  if (options.uiWorkspace) {
    services.uiWorkspace = {
      openSession: (id) => {
        if (options.openSessionThrows) throw new Error('unknown session')
        opened.push(id)
      },
    }
  }
  if (options.pluginNavigation) services.pluginNavigation = { openBundle: (name) => { opened.push('panel:' + name) } }
  if (options.layout) services.layout = { selectPanel: (id) => { opened.push('panel:' + id) } }

  const disposers = []
  const makeEffect = (fn) => {
    const d = fn()
    const off = () => { if (typeof d === 'function') d() }
    disposers.push(off)
    return off
  }
  const ctx = {
    get: (name) => services[name],
    effect: makeEffect,
    inject: (deps, cb) => {
      injects.push({ deps, cb })
      if (options.sessionsReady !== false && deps.includes('sessions')) {
        cb({ get: (n) => services[n], effect: makeEffect })
      }
    },
  }

  const setTimeoutFake = (fn, ms) => {
    const id = ++timerId
    timers.set(id, { fn, at: now + (Number(ms) || 0), interval: null })
    return id
  }
  const setIntervalFake = (fn, ms) => {
    const period = Number(ms) || 1
    const id = ++timerId
    timers.set(id, { fn, at: now + period, interval: period })
    return id
  }
  const clearTimer = (id) => { timers.delete(id) }

  let registration = null
  window.__ModuleLoader__.load = (entry) => { registration = entry }
  const load = new Function(
    'window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'navigator',
    CLIENT_SOURCE,
  )
  load(
    window, document,
    (url, init) => {
      fetches.push({ url, init })
      const body = init && init.body ? JSON.parse(init.body) : {}
      const response = (options.responses || {})[url]
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(response === undefined ? { ok: true, pages: 1 } : response(body)),
      })
    },
    setTimeoutFake, clearTimer, setIntervalFake, clearTimer,
    { platform: options.platform || 'Win32', userAgent: 'node' },
  )
  const exports = registration.factory(() => { throw new Error('client.js 不该 require 任何模块') })

  /** 推进假定时器（周期回调按间隔重排；上限防死循环）。 */
  function advance(ms) {
    const target = now + ms
    for (let guard = 0; guard < 1000; guard += 1) {
      let next = null
      for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t }
      if (!next) break
      now = next.t.at
      if (next.t.interval === null) timers.delete(next.id)
      else next.t.at = now + next.t.interval
      next.t.fn()
    }
    now = target
  }

  return {
    ctx, exports, fetches, listeners, injects, disposers, sessionsState, subscribers,
    services, window, document, dispatch, state, opened,
    get hash() { return state.hash },
    setFocused: (v) => { state.focused = v },
    setVisible: (v) => { state.visible = v },
    setSettingsModal: (el) => { state.settingsModal = el },
    get reloads() { return state.reloads },
    fireSubscribers: () => { for (const fn of [...subscribers]) fn() },
    countListeners: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    /** 最近一次上报的载荷（按 URL 过滤）。 */
    lastFetch: (suffix) => fetches.filter((f) => f.url.endsWith(suffix)).pop(),
    advance,
    unsubscribe: () => { for (const off of disposers) off() },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const deepLink = (target) => '#dsh-notify=' + encodeURIComponent(target)

test('选中会话取自 retainedBy.mainView（客户端快照没有 current）', async () => {
  const page = createPage({
    byId: {
      's-other': { id: 's-other', retainedBy: {} },
      's-main': { id: 's-main', retainedBy: { mainView: 1 } },
    },
  })
  page.exports.apply(page.ctx)
  await tick()
  const report = page.lastFetch('dnotify/page-focus')
  assert.equal(report.url, 'dnotify/page-focus', '文档相对路径')
  assert.equal(report.init.method, 'POST')
  const body = JSON.parse(report.init.body)
  assert.equal(body.sessionId, 's-main')
  assert.equal(body.focused, true)
  assert.match(body.pageId, /^p-/)
})

test('没有会话被主视图保留时上报 null（宿主按"归属不明"照常推送）', async () => {
  const page = createPage({ byId: { a: { id: 'a', retainedBy: { sidebarView: 1 } } } })
  page.exports.apply(page.ctx)
  await tick()
  assert.equal(JSON.parse(page.lastFetch('dnotify/page-focus').init.body).sessionId, null)
})

test('DOM 事件被显式包装：blur 不会因为 Event 对象被当成 focused=true', async () => {
  const page = createPage({ byId: {} })
  page.exports.apply(page.ctx)
  await tick()

  page.setFocused(false)
  page.dispatch('window', 'blur')
  await tick()
  assert.equal(JSON.parse(page.lastFetch('dnotify/page-focus').init.body).focused, false, 'blur 必须上报失焦')

  page.setFocused(true)
  page.dispatch('window', 'focus')
  await tick()
  assert.equal(JSON.parse(page.lastFetch('dnotify/page-focus').init.body).focused, true)

  page.setVisible(false)
  page.dispatch('document', 'visibilitychange')
  await tick()
  assert.equal(JSON.parse(page.lastFetch('dnotify/page-focus').init.body).focused, false)
})

test('pagehide 上报失焦并带 keepalive', async () => {
  const page = createPage({ byId: {} })
  page.exports.apply(page.ctx)
  await tick()
  page.dispatch('window', 'pagehide')
  await tick()
  const report = page.lastFetch('dnotify/page-focus')
  assert.equal(report.init.keepalive, true)
  assert.equal(JSON.parse(report.init.body).focused, false)
})

test('聚焦心跳只在聚焦时上报（间隔小于宿主 2 分钟保鲜期）', async () => {
  const page = createPage({ byId: {} })
  page.exports.apply(page.ctx)
  await tick()
  const before = page.fetches.length
  page.advance(60000)
  await tick()
  assert.equal(page.fetches.length, before + 1, '聚焦时心跳上报')
  page.setFocused(false)
  page.advance(60000)
  await tick()
  assert.equal(page.fetches.length, before + 1, '失焦时心跳不打扰宿主')
})

test('sessions 服务晚就绪：订阅后立刻补报一次', async () => {
  const page = createPage({
    byId: { 's-main': { id: 's-main', retainedBy: { mainView: 1 } } },
    sessionsReady: false,
  })
  page.exports.apply(page.ctx)
  await tick()
  assert.equal(JSON.parse(page.lastFetch('dnotify/page-focus').init.body).sessionId, null)

  page.services.sessions = {
    list: {
      getSnapshot: () => page.sessionsState,
      subscribe: (fn) => { page.subscribers.add(fn); return () => page.subscribers.delete(fn) },
    },
  }
  page.injects[page.injects.length - 1].cb({
    get: (n) => page.services[n],
    effect: (fn) => { fn(); return () => {} },
  })
  await tick()
  assert.equal(JSON.parse(page.lastFetch('dnotify/page-focus').init.body).sessionId, 's-main')
})

test('会话切换即时重报；卸载后监听器/订阅/SSE 全部清理', async () => {
  const page = createPage({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } })
  page.exports.apply(page.ctx)
  await tick()
  assert.ok(page.countListeners() >= 9, `应挂上 9 个监听器（实际 ${page.countListeners()}）`)
  assert.equal(page.subscribers.size, 1)
  assert.ok(page.state.eventSource, 'SSE 应已连接')
  assert.match(page.state.eventSource.url, /^dnotify\/events\?pageId=/, 'SSE 要带上自己的 pageId（宿主据此定向投递）')

  page.sessionsState.byId = { s2: { id: 's2', retainedBy: { mainView: 1 } } }
  page.fireSubscribers()
  await tick()
  assert.equal(JSON.parse(page.lastFetch('dnotify/page-focus').init.body).sessionId, 's2', '切换会话即时重报')

  page.unsubscribe()
  assert.equal(page.countListeners(), 0, '所有 DOM 监听器都要摘掉')
  assert.equal(page.subscribers.size, 0, '会话订阅要退掉')
  assert.equal(page.state.eventSource, null, 'SSE 要关掉')
})

test('点击投递：SSE 收到 navigate 后认领并执行跳转', async () => {
  const page = createPage({
    uiWorkspace: {},
    responses: { 'dnotify/claim': () => ({ ok: true, target: 'session:s-target' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-1', target: 'ignored-by-client' }))
  await tick()
  const claim = page.lastFetch('dnotify/claim')
  assert.equal(claim.init.method, 'POST')
  const claimBody = JSON.parse(claim.init.body)
  assert.equal(claimBody.openId, 'op-1', '认领必须带上事件里的 openId（否则两次点击会串单）')
  assert.ok(claimBody.pageId, '认领要带 pageId')
  assert.deepEqual(page.opened, ['s-target'], '认领成功后切到该会话')
})

test('点击投递：认领失败（别的页面先拿到/已过期）时本页什么都不做', async () => {
  const page = createPage({
    uiWorkspace: {},
    responses: { 'dnotify/claim': () => ({ ok: false, reason: 'stale' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-1', target: 'ignored-by-client' }))
  await tick()
  assert.deepEqual(page.opened, [])
})

test('会话不在客户端目录里（openSession 抛错）时明确失败：不写持久化、**不刷新页面**', async () => {
  const storage = new Map()
  const page = createPage({
    uiWorkspace: {},
    openSessionThrows: true,
    storage,
    responses: { 'dnotify/claim': () => ({ ok: true, target: 'session:s-gone' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-1', target: 'ignored-by-client' }))
  await tick()
  // 旧实现会写 localStorage + location.reload()：hash 已被清掉 → 页面原地刷新但不跳转
  assert.equal(storage.get('dsh.sessions.current'), undefined, '不该再写持久化选中项')
  assert.equal(page.reloads, 0, '绝不刷新页面')
})

test('跳转 page:plugins → 插件面板（pluginNavigation）', async () => {
  const page = createPage({
    pluginNavigation: {},
    responses: { 'dnotify/claim': () => ({ ok: true, target: 'page:plugins' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-1', target: 'ignored-by-client' }))
  await tick()
  assert.deepEqual(page.opened, ['panel:dsh-desktop-notify'])
})

test('跳转结果回报：会话不在目录里时 POST /navigated（认领成功≠跳转成功）', async () => {
  const page = createPage({
    uiWorkspace: true,
    openSessionThrows: true,          // openSession 抛错 = 'not-found'
    responses: { 'dnotify/claim': () => ({ ok: true, target: 'session:s-gone' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-9', target: 'ignored' }))
  await tick()
  page.advance(200)
  await tick()
  const nav = page.fetches.filter((f) => String(f.url).includes('navigated'))
  assert.equal(nav.length, 1, '应回报一次跳转结果')
  const navBody = JSON.parse(nav[0].init.body)
  assert.equal(navBody.result, 'not-found')
  assert.equal(navBody.openId, 'op-9')
})

test('复制标签页身份碰撞：探到同 id 的活页面就换身份并重连 SSE', async () => {
  // sessionStorage 里带着「复制标签页」继承来的身份
  const storage = new Map([['dsh-notify-page-id', 'p-copied']])
  const page = createPage({ pluginNavigation: {}, storage })
  // 注入一个「另一个活页面」的 BroadcastChannel：收到探测就回 alive
  page.window.BroadcastChannel = function FakeBC() {
    this.onmessage = null
    this.postMessage = (m) => { if (m && m.probe && this.onmessage) this.onmessage({ data: { alive: m.probe } }) }
    this.close = () => {}
    this.unref = () => {}
  }
  page.exports.apply(page.ctx)
  await tick()
  page.advance(400)     // 探测窗口 200ms
  await tick()
  page.advance(400)     // 换身份 + 重连排在探测回调里，需要再推进一次
  await tick()
  // 骨架里 SSE 走的是假 EventSource（不产生 fetch），所以用"换身份后的重报"来观察：
  // 探测到碰撞后必须用**新** pageId 重报一次身份。
  const reports = page.fetches.filter((f) => String(f.url).includes('dnotify/page-focus'))
  assert.ok(reports.length >= 1, '换身份后必须重报一次聚焦（否则宿主还以为旧身份代表本页）')
  const lastBody = JSON.parse(reports[reports.length - 1].init.body)
  assert.ok(!/p-copied/.test(String(lastBody.pageId)), '重报必须用新身份，不能再和另一个标签页共用 id')
  assert.notEqual(String(lastBody.pageId), 'p-copied')
})

test('设置弹窗先出现、导航格后渲染：要等到「内置插件」而不是停在设置页', async () => {
  let cell = null
  const modal = { querySelectorAll: () => [element('通用')].concat(cell ? [cell] : []) }
  const page = createPage({
    pluginNavigation: {},
    responses: { 'dnotify/claim': () => ({ ok: true, target: 'page:settings-plugins' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-1', target: 'ignored' }))
  await tick()
  page.setSettingsModal(modal)   // 弹窗有了，但导航格还没渲染
  page.advance(300)
  await tick()
  assert.deepEqual(page.opened, [], '还没渲染出导航格时不该退到插件面板')
  cell = element('内置插件')      // 导航格延迟渲染出来
  page.advance(300)
  await tick()
  assert.equal(cell.clicks, 1, '等到导航格出现后必须点它')
})

test('DSH 桌面端不合成设置快捷键（快捷键由原生输入接管）', async () => {
  const page = createPage({
    desktopPlatform: 'win32',
    pluginNavigation: {},
    responses: { 'dnotify/claim': () => ({ ok: true, target: 'page:settings-plugins' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-1', target: 'ignored' }))
  await tick()
  page.advance(700)     // 桌面端：跳过两段快捷键，只走 launcher → 菜单
  await tick()
  assert.equal(page.state.keyboardEvents.length, 0, '桌面端合成 keydown 不会触发命令，不该白等')
  page.advance(1800)    // 走完剩余各段 → 退到能用的插件面板
  await tick()
  assert.deepEqual(page.opened, ['panel:dsh-desktop-notify'], '最后仍要退到能用的插件面板')
})

test('跳转 page:settings-plugins → 点真实设置入口打开设置并点「内置插件」', async () => {
  const cell = element('内置插件')
  const modal = { querySelectorAll: () => [element('通用'), cell] }
  const launcher = element('设置')
  launcher.getAttribute = (name) => (name === 'aria-label' ? '设置' : null)
  const page = createPage({
    pluginNavigation: {},
    launcher,
    responses: { 'dnotify/claim': () => ({ ok: true, target: 'page:settings-plugins' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-1', target: 'ignored-by-client' }))
  await tick()
  page.advance(150)     // 第一轮：设置还没开 → 点真实入口
  await tick()
  assert.equal(launcher.clicks, 1, '应优先点侧边栏真实设置入口（最快且不碰其它菜单）')
  assert.equal(page.state.keyboardEvents.length, 0, '入口能点就不该再合成快捷键')

  page.setSettingsModal(modal)   // 设置弹窗出现了
  page.advance(200)
  await tick()
  assert.equal(cell.clicks, 1, '应点开「内置插件」')
  assert.deepEqual(page.opened, [], '设置已打开，不该再退到插件面板')
})

test('跳转 page:settings-plugins → 没有真实入口时合成快捷键（web 绑定 primary+alt）', async () => {
  const cell = element('内置插件')
  const modal = { querySelectorAll: () => [element('通用'), cell] }
  const page = createPage({
    pluginNavigation: {},
    responses: { 'dnotify/claim': () => ({ ok: true, target: 'page:settings-plugins' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-1', target: 'ignored-by-client' }))
  await tick()
  page.advance(600)     // 入口那一段走完（~500ms）才会合成快捷键
  await tick()
  const keyEvent = page.state.keyboardEvents[0]
  assert.ok(keyEvent, '入口不可用时才合成快捷键')
  assert.equal(keyEvent.code, 'Comma')
  assert.equal(keyEvent.ctrlKey, true, 'Windows/Linux 用 Ctrl')
  assert.equal(keyEvent.altKey, true, '0.2.0-rc.2 的 web 绑定是 primary+alt')
  assert.equal(keyEvent.metaKey, false)

  page.setSettingsModal(modal)
  page.advance(200)
  await tick()
  assert.equal(cell.clicks, 1, '应点开「内置插件」')
})

test('跳转 page:settings-plugins：设置打不开就退回插件面板', async () => {
  const page = createPage({
    pluginNavigation: {},
    responses: { 'dnotify/claim': () => ({ ok: true, target: 'page:settings-plugins' }) },
  })
  page.exports.apply(page.ctx)
  await tick()
  page.state.eventSource.emit('navigate', JSON.stringify({ id: 'op-1', target: 'ignored-by-client' }))
  await tick()
  page.advance(5000)    // 40 次轮询后放弃 → 退路
  await tick()
  assert.deepEqual(page.opened, ['panel:dsh-desktop-notify'])
})

test('旧式 hash 深链仍可用（#dsh-notify=…，处理完清掉 hash）', async () => {
  const page = createPage({
    hash: deepLink('page:plugins'),
    pluginNavigation: {},
  })
  page.exports.apply(page.ctx)
  await tick()
  assert.deepEqual(page.opened, ['panel:dsh-desktop-notify'])
  assert.equal(page.hash, '', '处理完必须清掉 hash，避免刷新重复触发')
})
