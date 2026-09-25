// 浏览器半区（lib/client.js）单测：在 Node 里搭一个最小的 window/document 假环境，
// 按 __ModuleLoader__ 协议取出工厂函数，用假 ctx 真跑一遍 apply()。
//   npm test
//
// 之前这一半完全没有测试（两次独立审阅都点了这个缺口），而它承载着"会话级静默"
// 的全部输入：选中会话读错 = 门控永远失效。这里锁住：
//   · 选中会话取自 sessions 快照的 byId[*].retainedBy.mainView（0.1.7 没有 current）
//   · 上报走官方 ctx.get('connection').rpc.call；pagehide 走 raw fetch + keepalive
//     且 URL 是文档相对形式（挂载在子路径下也正确）
//   · DOM 事件显式包装（Event 不能被当成 focused=true）
//   · 聚焦心跳只在聚焦时上报；卸载时监听器/订阅/心跳全部清理
//   · sessions 服务晚就绪时，订阅后立刻补报一次
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8',
)

/** 取一次 lib/client.js 注册的工厂函数（每次调用都重新求值，互不干扰）。 */
function loadFactory() {
  let registration = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (entry) => { registration = entry } },
      sessionStorage: null,
      location: { origin: 'http://127.0.0.1:3080' },
      addEventListener() {},
      removeEventListener() {},
    },
    document: {},
  }
  const fn = new Function('window', 'document', 'crypto', 'fetch', 'setInterval', 'clearInterval', 'URL', CLIENT_SOURCE)
  fn(sandbox.window, sandbox.document, globalThis.crypto, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval, globalThis.URL)
  assert.ok(registration, 'client.js 必须通过 __ModuleLoader__.load 注册')
  assert.equal(registration.id, 'dsh-desktop-notify')
  return registration.factory
}

/** 搭一个假页面环境 + 假 ctx，返回可断言的一切。 */
function harness(options = {}) {
  const rpcCalls = []
  const fetches = []
  const listeners = new Map()
  const intervals = new Set()
  const effects = []
  const injects = []
  let focused = options.focused !== false
  let visible = options.visible !== false

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

  const storage = new Map()
  const window = {
    __ModuleLoader__: { load: () => { throw new Error('这里不该再注册') } },
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    location: { origin: 'http://127.0.0.1:3080' },
    addEventListener: add('window'),
    removeEventListener: remove('window'),
  }
  const document = {
    addEventListener: add('document'),
    removeEventListener: remove('document'),
    get visibilityState() { return visible ? 'visible' : 'hidden' },
    hasFocus: () => focused,
  }

  const sessionsState = { byId: options.byId || {} }
  const subscribers = new Set()
  const sessions = {
    list: {
      getSnapshot: () => sessionsState,
      subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn) },
    },
  }
  const connection = {
    rpc: {
      call: (channel, endpoint, payload) => {
        rpcCalls.push({ channel, endpoint, payload })
        return Promise.resolve({ ok: true, value: {} })
      },
    },
  }

  const factory = loadFactory()
  const exports = factory(() => { throw new Error('client.js 不该 require 任何模块') })

  const services = { connection, sessions: options.sessionsReady === false ? undefined : sessions }
  // 记录真实的 disposer（ctx.effect 的返回值），卸载测试必须调它们而不是再跑一遍 setup
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

  const runtime = {
    rpcCalls, fetches, listeners, intervals, effects, injects, subscribers, disposers,
    window, document, services, sessionsState, subscribers2: subscribers,
    setFocused: (v) => { focused = v },
    setVisible: (v) => { visible = v },
    dispatch,
    fireSubscribers: () => { for (const fn of [...subscribers]) fn() },
    countListeners: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    setInterval: (fn, ms) => { const t = { fn, ms }; intervals.add(t); return t },
    clearInterval: (t) => { intervals.delete(t) },
    fetch: (url, init) => {
      fetches.push({ url, init })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          type: 'server-response',
          rpcId: JSON.parse(init.body).rpcId,
          result: { ok: true, value: {} },
        }),
      })
    },
    exports,
    ctx,
  }
  return runtime
}

/** 用同一个 window 环境装载工厂（让 client.js 里的 window/document 闭包生效）。 */
function loadInto(rt) {
  let registration = null
  rt.window.__ModuleLoader__ = { load: (entry) => { registration = entry } }
  const fn = new Function('window', 'document', 'crypto', 'fetch', 'setInterval', 'clearInterval', 'URL', CLIENT_SOURCE)
  fn(rt.window, rt.document, globalThis.crypto, rt.fetch, rt.setInterval, rt.clearInterval, globalThis.URL)
  const exports = registration.factory(() => { throw new Error('client.js 不该 require 任何模块') })
  return exports
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('选中会话取自 retainedBy.mainView（客户端快照没有 current）', async () => {
  const rt = harness({
    byId: {
      's-other': { id: 's-other', retainedBy: {} },
      's-main': { id: 's-main', retainedBy: { mainView: 1 } },
    },
  })
  const exports = loadInto(rt)
  exports.apply(rt.ctx)
  await tick()
  assert.equal(rt.rpcCalls.length, 1)
  assert.deepEqual(rt.rpcCalls[0], {
    channel: '/dnotify',
    endpoint: 'page-focus',
    payload: { focused: true, pageId: rt.rpcCalls[0].payload.pageId, sessionId: 's-main' },
  })
  assert.match(rt.rpcCalls[0].payload.pageId, /^p-/, 'pageId 形如 p-…')
})

test('没有会话被主视图保留时上报 null（宿主按"归属不明"照常推送）', async () => {
  const rt = harness({ byId: { a: { id: 'a', retainedBy: { sidebarView: 1 } } } })
  const exports = loadInto(rt)
  exports.apply(rt.ctx)
  await tick()
  assert.equal(rt.rpcCalls[0].payload.sessionId, null)
})

test('DOM 事件被显式包装：blur 不会因为 Event 对象被当成 focused=true', async () => {
  const rt = harness({ byId: {} })
  const exports = loadInto(rt)
  exports.apply(rt.ctx)
  await tick()
  rt.rpcCalls.length = 0

  rt.setFocused(false)
  rt.dispatch('window', 'blur')          // 监听器收到 Event 对象
  await tick()
  assert.equal(rt.rpcCalls.length, 1)
  assert.equal(rt.rpcCalls[0].payload.focused, false, 'blur 必须上报失焦')

  rt.setFocused(true)
  rt.dispatch('window', 'focus')
  await tick()
  assert.equal(rt.rpcCalls[1].payload.focused, true)

  // 最小化/后台标签：visibilityState 不是 visible 时一律算失焦
  rt.setVisible(false)
  rt.dispatch('document', 'visibilitychange')
  await tick()
  assert.equal(rt.rpcCalls[2].payload.focused, false)
})

test('pagehide 走 raw fetch + keepalive，且用文档相对路径', async () => {
  const rt = harness({ byId: {} })
  const exports = loadInto(rt)
  exports.apply(rt.ctx)
  await tick()
  rt.dispatch('window', 'pagehide')
  await tick()
  assert.equal(rt.fetches.length, 1, 'pagehide 必须用 fetch（官方封装不带 keepalive）')
  assert.equal(rt.fetches[0].url, 'dnotify/page-focus', '必须是文档相对路径')
  assert.equal(rt.fetches[0].init.keepalive, true)
  const body = JSON.parse(rt.fetches[0].init.body)
  assert.equal(body.type, 'client-request')
  assert.equal(body.method, 'page-focus')
  assert.equal(body.payload.focused, false)
})

test('聚焦心跳只在聚焦时上报，且间隔小于宿主 2 分钟保鲜期', async () => {
  const rt = harness({ byId: {} })
  const exports = loadInto(rt)
  exports.apply(rt.ctx)
  await tick()
  const interval = [...rt.intervals][0]
  assert.ok(interval, '必须挂心跳')
  assert.ok(interval.ms <= 90000, `心跳间隔 ${interval.ms}ms 必须显著小于 120s`)

  rt.rpcCalls.length = 0
  interval.fn()
  await tick()
  assert.equal(rt.rpcCalls.length, 1, '聚焦时心跳上报')
  rt.setFocused(false)
  interval.fn()
  await tick()
  assert.equal(rt.rpcCalls.length, 1, '失焦时心跳不打扰宿主')
})

test('sessions 服务晚就绪：订阅后立刻补报一次，不等下一次心跳', async () => {
  const rt = harness({ byId: { 's-main': { id: 's-main', retainedBy: { mainView: 1 } } }, sessionsReady: false })
  const exports = loadInto(rt)
  exports.apply(rt.ctx)
  await tick()
  assert.equal(rt.rpcCalls[0].payload.sessionId, null, '服务没就绪时只能报 null')

  // 服务出现 → ctx.inject 回调触发
  rt.services.sessions = {
    list: {
      getSnapshot: () => rt.sessionsState,
      subscribe: (fn) => { rt.subscribers.add(fn); return () => rt.subscribers.delete(fn) },
    },
  }
  rt.injects[rt.injects.length - 1].cb({
    get: (n) => rt.services[n],
    effect: (fn) => { fn(); return () => {} },
  })
  await tick()
  assert.equal(rt.rpcCalls.length, 2, '订阅后必须补报一次')
  assert.equal(rt.rpcCalls[1].payload.sessionId, 's-main')
})

test('会话切换即时重报；卸载后监听器/订阅/心跳全部清理', async () => {
  const rt = harness({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } })
  const exports = loadInto(rt)
  const disposed = exports.apply(rt.ctx)
  void disposed
  await tick()
  const listenersBefore = rt.countListeners()
  assert.ok(listenersBefore >= 8, `应挂上 8 个监听器（实际 ${listenersBefore}）`)
  assert.equal(rt.subscribers.size, 1, '会话订阅已挂')

  rt.rpcCalls.length = 0
  rt.sessionsState.byId = { s2: { id: 's2', retainedBy: { mainView: 1 } } }
  rt.fireSubscribers()
  await tick()
  assert.equal(rt.rpcCalls.length, 1, '切换会话即时重报')
  assert.equal(rt.rpcCalls[0].payload.sessionId, 's2')

  // 卸载：调 ctx.effect 返回的真实 disposer
  for (const off of rt.disposers) off()
  assert.equal(rt.countListeners(), 0, '所有 DOM 监听器都要摘掉')
  assert.equal(rt.subscribers.size, 0, '会话订阅要退掉')
  assert.equal(rt.intervals.size, 0, '心跳要清掉')
})
