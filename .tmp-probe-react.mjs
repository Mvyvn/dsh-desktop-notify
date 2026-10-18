// 临时探针：用**真 React**（DSH Web 用的那份）渲染设置页，把 mini-React 测不出来的
// 渲染期异常 / 规则-of-hooks 违规暴露出来。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const REACT_DIR = 'D:/Program/deepseek-harness/apps/web/node_modules/react'
const SERVER_DIR = 'D:/Program/deepseek-harness/apps/web/node_modules/react-dom/server.browser.js'

const reactMod = await import(pathToFileURL(REACT_DIR + '/index.js').href)
const React = reactMod.default ?? reactMod
const serverMod = await import(pathToFileURL(SERVER_DIR).href)
const renderToStaticMarkup = serverMod.renderToStaticMarkup ?? serverMod.default?.renderToStaticMarkup

const listeners = new Map()
const add = (t) => (type, fn) => { const k = t + ':' + type; if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k).add(fn) }
const remove = (t) => (type, fn) => { const s = listeners.get(t + ':' + type); if (s) s.delete(fn) }
const styles = []
const elements = new Map()
const document = {
  addEventListener: add('document'),
  removeEventListener: remove('document'),
  visibilityState: 'visible',
  hasFocus: () => true,
  documentElement: { dataset: {} },
  head: { appendChild: (el) => { styles.push(el); if (el.id) elements.set(el.id, el) } },
  getElementById: (id) => (elements.has(id) ? elements.get(id) : null),
  createElement: (tag) => ({ tag, id: '', textContent: '' }),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { appendChild: () => {} },
}
const window = {
  __ModuleLoader__: { load: () => { throw new Error('不该再注册') } },
  sessionStorage: { getItem: () => null, setItem: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  location: { origin: 'http://127.0.0.1:3080', pathname: '/', search: '', hash: '', reload: () => {} },
  history: { replaceState: () => {} },
  addEventListener: add('window'),
  removeEventListener: remove('window'),
  dispatchEvent: () => {},
  navigator: { userAgent: 'node', platform: 'Win32' },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
}
const fetchStub = (url) => {
  const payload = String(url).includes('led')
    ? { ok: true, reason: 'ok', devicePresent: true, ports: ['COM7'], link: { state: 'ready', verified: true, reply: { verifies: 1, dropped: 0 } }, device: { leds: 7, verified: true }, scene: { state: 'running', flags: 0, brightness: 160 }, verdicts: [] }
    : { ok: true }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
}

let registration = null
window.__ModuleLoader__.load = (entry) => { registration = entry }
const CLIENT_SOURCE = readFileSync('lib/client.js', 'utf8')
const load = new Function(
  'window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'navigator',
  CLIENT_SOURCE,
)
load(window, document, fetchStub, setTimeout, clearTimeout, setInterval, clearInterval, window.navigator)

const exports = registration.factory((name) => {
  if (name === 'react') return React
  throw new Error('client.js 不该 require ' + name)
})

const form = {
  getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, apiEnabled: true, debug: false, types: [], ledEnabled: true, ledPort: 'auto', ledBuzzer: true, ledBrightness: 160, ledAttention: true, ledIdleOffSec: 120 } }),
  subscribe: () => () => {},
  set: () => {},
}
const registered = []
const ctx = {
  slots: {
    inject: (name, fn) => { try { fn() } catch (e) { console.log('  slots.inject(' + name + ') 回调抛错：', e && e.message) } },
    register: (meta, comp) => { registered.push({ meta, comp }); return { meta, comp } },
  },
  configForms: { get: (ns) => (ns === 'desktop-notify' ? form : null) },
  get: () => undefined,
  inject: (deps, fn) => { if (typeof fn === 'function') fn(ctx) },
  provide: () => () => {},
  effect: (fn) => { try { fn() } catch (e) { /* ignore */ } },
  on: () => () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  interval: () => () => {},
  platform: 'Win32',
  connection: { admit: () => undefined },
  locale: { get: () => '' },
}

try {
  exports.apply(ctx)
  console.log('apply OK')
} catch (e) {
  console.log('apply 抛错：', e && e.message)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 10).join('\n'))
  process.exit(2)
}

console.log('注册到的 slot：', registered.map((r) => r.meta.name).join(', ') || '(无！这就是"设置页消失"的原因)')
const Section = registered.length > 0 ? registered[0].comp : null
if (!Section) process.exit(3)

for (const view of ['summary', undefined]) {
  try {
    const html = renderToStaticMarkup(React.createElement(Section, view ? { view } : null))
    console.log((view ?? 'full') + ' 渲染 OK，长度 ' + html.length)
  } catch (e) {
    console.log((view ?? 'full') + ' 渲染抛错：', e && e.message)
    if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 8).join('\n'))
  }
}
