// Service Worker 单测：把 assets/dnotify-sw.js 放进 vm，按浏览器事件形状直接驱动。
//   npm test
//
// 锁住的行为：
//   · 无可点击目标的通知：data 里没有 action；notificationclick 只关闭，不 focus/openWindow/请求前台。
//   · 可点击通知：focus 目标页、postMessage 带 target + nonce；页面 ack 后才请求 /focus。
//   · openWindow 后等新页面注册（或超时）再请求 /focus。
//   · 旧页面 bundle 的 target:'none' 被归一化成"没有动作"；旧的可点击字段仍然兼容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'dnotify-sw.js'), 'utf8',
)

function client(overrides = {}) {
  const c = {
    id: 'c1',
    url: 'http://127.0.0.1:3080/#/session/s1',
    focusCalls: 0,
    messages: [],
    autoAck: true,
    onPost: null,
    focus() { this.focusCalls += 1; return Promise.resolve(this) },
    postMessage(message) {
      this.messages.push(message)
      if (this.onPost) this.onPost(message)
    },
    ...overrides,
  }
  return c
}

/** 最小 ServiceWorkerGlobalScope：只实现 SW 真正用到的 API。 */
function createSw() {
  const listeners = new Map()
  const clients = []
  const shown = []
  const opened = []
  const fetches = []
  let closed = 0
  let focusUrl = ''
  let openedFocus = 0

  const self = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    skipWaiting() {},
    clients: {
      matchAll: async () => clients.slice(),
      claim: async () => {},
      openWindow: async (url) => {
        opened.push(String(url))
        // 新页面注册（load 完成）后才允许请求前台；测试里立即模拟。
        setTimeout(() => dispatch('message', {
          data: { type: 'register-page', pageId: 'new-page' },
          source: { id: 'new-page' },
        }), 0)
        return { focus: async () => { openedFocus += 1; return this } }
      },
    },
    registration: {
      showNotification: async (title, options) => {
        shown.push({ title: String(title), options })
        return { title: String(title) }
      },
    },
    location: { origin: 'http://127.0.0.1:3080' },
  }

  const sandbox = {
    self,
    // Node 的 URL 要显式注入（vm 上下文没有 web 全局）。
    URL,
    fetch: (url) => { fetches.push(String(url)); return Promise.resolve({}) },
    setTimeout,
    clearTimeout,
    console,
    // 故意不提供 IndexedDB：SW 的 idb() 必须安全回退到 null。
    indexedDB: undefined,
  }
  vm.createContext(sandbox)
  new vm.Script(SOURCE, { filename: 'dnotify-sw.js' }).runInContext(sandbox)

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  function dispatch(type, event) {
    for (const fn of listeners.get(type) || []) fn(event)
  }

  async function show(extra) {
    dispatch('message', {
      data: {
        type: 'show-notification',
        pageId: 'p1',
        title: '标题',
        body: '正文',
        tag: 'tag-1',
        ...extra,
      },
      source: { id: 'c1' },
    })
    await tick()
    await tick()
    assert.equal(shown.length, 1, 'show-notification 应产生一条系统通知')
    return shown[0]
  }

  async function click(data, options = {}) {
    let waited = null
    dispatch('notificationclick', {
      notification: { close() { closed += 1 }, data },
      waitUntil(promise) { waited = promise },
    })
    if (options.autoAck === false) {
      // 测试可控 ack：先返回 waitUntil，调用方确认“未请求前台”后再手动 ack。
      return {
        waited,
        ack() {
          const msg = clients.flatMap((c) => c.messages).find((m) => m && m.nonce)
          if (msg) dispatch('message', { data: { type: 'dsh-navigated', nonce: msg.nonce }, source: { id: 'c1' } })
        },
      }
    }
    if (waited) await waited
    await tick()
  }

  return {
    addClient: (c) => {
      if (!c) return
      if (c.autoAck !== false) {
        c.onPost = (msg) => {
          if (!msg || !msg.nonce) return
          setTimeout(() => dispatch('message', {
            data: { type: 'dsh-navigated', nonce: msg.nonce },
            source: { id: c.id },
          }), 0)
        }
      }
      clients.push(c)
    },
    show,
    click,
    shown,
    opened,
    fetches,
    get closed() { return closed },
    get openedFocus() { return openedFocus },
    get focusUrl() { return focusUrl },
  }
}

test('无点击目标：通知 data 只有 pageId，点击只关闭（不 focus / openWindow / 请求前台）', async () => {
  const sw = createSw()
  const c = client()
  sw.addClient(c)
  const note = await sw.show({})
  assert.equal(note.options.data.action, undefined, '没有 target 就没有 action')
  assert.equal(note.options.data.pageId, 'p1')
  assert.equal(note.options.data.target, undefined)
  assert.equal(note.options.data.deepLink, undefined)
  assert.equal(note.options.data.focusUrl, undefined)

  await sw.click(note.options.data)
  assert.equal(sw.closed, 1, '点击仍然关闭通知')
  assert.equal(c.focusCalls, 0, '无目标通知不能切标签页')
  assert.deepEqual(c.messages, [], '不能 postMessage 跳转指令')
  assert.deepEqual(sw.opened, [], '不能新开窗口')
  assert.equal(sw.fetches.some((url) => /\/dnotify\/focus\?/.test(url)), false, '不能请求宿主前台')
})

test('旧页面 bundle 的 target:none + deepLink 也只关闭（归一化，不是靠点击时判断）', async () => {
  const sw = createSw()
  const c = client()
  sw.addClient(c)
  const note = await sw.show({
    target: 'none',
    deepLink: 'http://127.0.0.1:3080/#dsh-notify=none',
    focusUrl: 'http://127.0.0.1:3080/dnotify/focus?t=old',
  })
  assert.equal(note.options.data.action, undefined, "'none' 在展示时就被归一化成没有动作")
  await sw.click(note.options.data)
  assert.equal(c.focusCalls, 0)
  assert.deepEqual(sw.opened, [])
  assert.equal(sw.fetches.some((url) => /\/dnotify\/focus\?/.test(url)), false)
})

test('可点击通知：页面 ack 跳转完成后才请求前台（不在点击瞬间抢）', async () => {
  const sw = createSw()
  const c = client()
  sw.addClient(c)
  const focusUrl = 'http://127.0.0.1:3080/dnotify/focus?t=test-token'
  const deepLink = 'http://127.0.0.1:3080/#dsh-notify=session%3As1'
  const note = await sw.show({ target: 'session:s1', deepLink, focusUrl })
  assert.ok(note.options.data.action, '有 target 就必须有 action')
  assert.equal(note.options.data.action.target, 'session:s1')
  assert.equal(note.options.data.action.deepLink, deepLink)
  assert.equal(note.options.data.action.focusUrl, focusUrl)

  await sw.click(note.options.data)
  assert.equal(c.focusCalls, 1, 'WindowClient.focus() 必须调用')
  assert.equal(c.messages.length, 1)
  assert.equal(c.messages[0].type, 'dsh-navigate')
  assert.equal(c.messages[0].target, 'session:s1')
  assert.equal(c.messages[0].focusUrl, undefined, '页面不再承担前台请求')
  assert.equal(sw.fetches.includes(focusUrl), true, '页面 ack 后请求 /focus')
})

test('页面未 ack 前不请求前台，ack 后才请求', async () => {
  const sw = createSw()
  const c = client({ autoAck: false })
  sw.addClient(c)
  const focusUrl = 'http://127.0.0.1:3080/dnotify/focus?t=slow-ack'
  const note = await sw.show({ target: 'session:s1', deepLink: '', focusUrl })
  const pending = await sw.click(note.options.data, { autoAck: false })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sw.fetches.includes(focusUrl), false, '页面处理跳转前不得请求前台')
  pending.ack()
  await pending.waited
  assert.equal(sw.fetches.includes(focusUrl), true, 'ack 后才请求前台')
})

test('可点击但找不到页面：openWindow(deepLink) 后补一次宿主前台', async () => {
  const sw = createSw()
  const focusUrl = 'http://127.0.0.1:3080/dnotify/focus?t=test-token'
  const deepLink = 'http://127.0.0.1:3080/#dsh-notify=session%3As9'
  const note = await sw.show({ target: 'session:s9', deepLink, focusUrl })
  await sw.click(note.options.data)
  assert.deepEqual(sw.opened, [deepLink])
  assert.equal(sw.openedFocus, 1, 'openWindow 返回的 WindowClient 也要 focus()')
  assert.equal(sw.fetches.includes(focusUrl), true, '新开窗口就绪后再请求前台')
})

test('旧的可点击字段（无 action）仍然兼容：切标签页并带跳转目标', async () => {
  const sw = createSw()
  const c = client()
  sw.addClient(c)
  const note = await sw.show({ target: 'page:plugins', deepLink: '', focusUrl: '' })
  assert.equal(note.options.data.action.target, 'page:plugins')
  await sw.click(note.options.data)
  assert.equal(c.focusCalls, 1)
  assert.equal(c.messages[0].target, 'page:plugins')
})
