// 设置页 UI 的渲染护栏
//
// 为什么专门写这一个测试文件：设置页是**唯一在浏览器里才跑**的一段代码，
// 之前没有任何测试覆盖，于是"把带 hooks 的组件当普通函数调用"这种错误
// （React 的 "Rendered more hooks than during the previous render"）
// 一路溜到了用户面前 —— 表现是**整个设置界面直接消失**。
//
// 这里用一个遵守 hooks 规则的迷你 React 真渲染 Section：先渲染"配置还没到"的分支，
// 再渲染"配置就绪"的分支（正是线上会走的路径）。hook 数量在两次渲染之间不一致就抛错，
// 和 React 行为一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * 迷你 React：够跑设置页，并且**强制 hooks 规则**。
 * 只实现 Setting 页用到的 createElement / useState / useRef / useEffect。
 */
function createMiniReact() {
  const instances = new Map()
  let current = null
  let pending = []

  const React = {
    createElement(type, props) {
      const children = []
      for (let i = 2; i < arguments.length; i += 1) {
        const child = arguments[i]
        if (Array.isArray(child)) children.push(...child.flat(Infinity))
        else children.push(child)
      }
      const next = Object.assign({}, props || {})
      // React 语义：children 进 props（组件里读 props.children，不是读 element.children）
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { __el: true, type, props: next }
    },
    useState(initial) {
      if (!current) throw new Error('useState 必须在组件渲染期间调用')
      const inst = current
      const index = inst.index++
      if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [inst.hooks[index], (next) => {
        inst.hooks[index] = typeof next === 'function' ? next(inst.hooks[index]) : next
      }]
    },
    useRef(initial) {
      if (!current) throw new Error('useRef 必须在组件渲染期间调用')
      const inst = current
      const index = inst.index++
      if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
      return inst.hooks[index]
    },
    useEffect(fn, deps) {
      if (!current) throw new Error('useEffect 必须在组件渲染期间调用')
      const inst = current
      const index = inst.index++
      const prev = inst.effects[index]
      const same = prev !== undefined && Array.isArray(deps) && Array.isArray(prev.deps) &&
        deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]))
      if (!same) pending.push({ inst, index, fn, deps })
    },
  }

  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map((child, i) => renderNode(child, path + '.' + i))
    if (!node.__el) return null
    const { type, props } = node
    if (typeof type === 'function') {
      const key = path + '|' + (type.name || 'anon')
      let inst = instances.get(key)
      // 首次挂载没有"上一次渲染"可比：React 只在**更新**时比较 hook 数量
      const isMount = inst === undefined
      if (isMount) {
        inst = { hooks: [], effects: {}, index: 0, count: 0 }
        instances.set(key, inst)
      }
      const prevCount = inst.count
      inst.index = 0
      const prevCurrent = current
      current = inst
      let out
      try { out = type(props) } finally { current = prevCurrent }
      inst.count = inst.index
      // React 的两条硬规则：每次**更新**渲染的 hook 数量必须与上次一致
      if (!isMount) {
        if (inst.count > prevCount) {
          throw new Error(`Rendered more hooks than during the previous render (${key}: ${prevCount} → ${inst.count})`)
        }
        if (inst.count < prevCount) {
          throw new Error(`Rendered fewer hooks than during the previous render (${key}: ${prevCount} → ${inst.count})`)
        }
      }
      return renderNode(out, path)
    }
    const kids = props.children === undefined ? [] : (Array.isArray(props.children) ? props.children : [props.children])
    return { __host: type, props, children: kids.map((c, i) => renderNode(c, path + '.' + i)) }
  }

  return {
    React,
    /** 调试用：当前记录到的组件实例（键=路径，值=hook 数量与首槽）。 */
    inspect() {
      const out = {}
      for (const [key, inst] of instances) {
        let first = 'undefined'
        try { first = JSON.stringify(inst.hooks[0]) } catch (e) { first = 'circular' }
        out[key] = { hooks: inst.count, first: first === undefined ? 'undefined' : String(first).slice(0, 90) }
      }
      return out
    },
    /** 渲染一次（并在提交后同步执行 effect，模拟 React 的 commit 阶段）。 */
    render(element) {
      pending = []
      const tree = renderNode(element, 'root')
      const queue = pending
      pending = []
      for (const entry of queue) {
        const cleanup = entry.fn()
        entry.inst.effects[entry.index] = { deps: entry.deps, cleanup }
      }
      return tree
    },
  }
}

/** 从渲染树里收集所有文本（断言"界面上真的有这些字"）。 */
function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (node.children) for (const child of node.children) texts(child, out)
  return out
}

/** 按条件收集宿主节点（点击步进箭头之类要用）。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (typeof node === 'string') return out
  if (node.__host) {
    if (predicate(node)) out.push(node)
    if (node.children) for (const child of node.children) findAll(child, predicate, out)
  }
  return out
}

/** 起一个够用的浏览器环境并把 lib/client.js 跑起来，返回 Section 组件。 */
function loadSettingsSection({ form, ledStatus } = {}) {
  const listeners = new Map()
  const add = (target) => (type, fn) => {
    const key = target + ':' + type
    if (!listeners.has(key)) listeners.set(key, new Set())
    listeners.get(key).add(fn)
  }
  const remove = (target) => (type, fn) => {
    const set = listeners.get(target + ':' + type)
    if (set) set.delete(fn)
  }
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
    EventSource: class {
      constructor() { this.readyState = 0; this.handlers = {} }
      addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn) }
      close() { this.readyState = 2 }
    },
  }

  let registration = null
  window.__ModuleLoader__.load = (entry) => { registration = entry }
  const load = new Function(
    'window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'navigator',
    CLIENT_SOURCE,
  )
  const fetches = []
  load(
    window, document,
    (url) => {
      fetches.push(String(url))
      // /dnotify/led 的响应可以按用例注入（其余端点回一个空壳即可）
      const payload = ledStatus !== undefined && String(url).indexOf('led') >= 0 ? ledStatus : { ok: true }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
    },
    () => 0, () => {}, () => 0, () => {},
    { platform: 'Win32', userAgent: 'node' },
  )

  const mini = createMiniReact()
  const registered = []
  const injects = []
  const slots = {
    inject: (_name, cb) => { cb() },
    register: (meta, component) => { registered.push({ meta, component }); return () => {} },
  }
  const ctx = {
    slots,
    configForms: { get: () => (typeof form === 'function' ? form() : (form || null)) },
    effect: (fn) => { const off = fn(); return () => { if (typeof off === 'function') off() } },
    // 真实 cordis：服务已在就立即执行；服务晚到则在出现时执行。
    // 设置页就是靠这个回调重新解析 configForms 的（见 useConfigForm 的说明）。
    inject: (deps, cb) => { injects.push({ deps, cb }); return () => {} },
    on: () => () => {},
    get: () => undefined,
    fireInject(dep) {
      for (const entry of injects) if (entry.deps.includes(dep)) entry.cb()
    },
  }
  const exports = registration.factory((name) => {
    if (name === 'react') return mini.React
    throw new Error(`client.js 不该 require ${name}`)
  })
  exports.apply(ctx)

  const entry = registered.find((r) => r.meta && r.meta.name === 'plugins.row.config')
  assert.ok(entry, '设置页必须注册到 plugins.row.config')
  assert.ok(styles.length > 0, '设置页应当注入自己的样式')
  return { Section: entry.component, mini, registered, document, ctx, styles, apply: exports.apply, fetches, moduleId: registration.id, moduleName: exports.name }
}

test('护栏存在的理由：带 hooks 的组件不能被当普通函数调用', () => {
  // 静态兜底：编译产物里出现 `TextRow({` / `StepperRow({` 这种"直接调用组件"的写法
  // 就说明又踩坑了（InputRow 时代的同类错误曾把整棵设置树打崩）
  for (const name of ['TextRow', 'StepperRow', 'Stepper', 'LedStatusCard', 'Chevron']) {
    assert.equal(new RegExp(name + '\\(\\{').test(CLIENT_SOURCE), false,
      `${name} 含 hooks（或为组件），必须写成 h(${name}, {...})，不能当普通函数调用`)
  }
  assert.equal(/h\(TextRow,/.test(CLIENT_SOURCE), true, 'TextRow 应当通过 h() 渲染')
  assert.equal(/h\(StepperRow,/.test(CLIENT_SOURCE), true, 'StepperRow 应当通过 h() 渲染')
})

test('串口那行的说明与标签左右排（不再另起一行），指示灯状态下方留出间距', () => {
  const form = {
    getSnapshot: () => ({
      status: 'ready', writable: true,
      value: { enabled: true, types: [], ledEnabled: true, ledPort: 'auto', ledBuzzer: true, ledBrightness: 160, ledAttention: true, ledIdleOffSec: 120 },
    }),
    subscribe: () => () => {},
    set: () => {},
  }
  const { Section, mini } = loadSettingsSection({ form })
  mini.render(mini.React.createElement(Section, null))
  const tree = mini.render(mini.React.createElement(Section, null))

  // 标签与说明同一个横向 flex 容器（而不是上下两行）
  const hintNode = findAll(tree, (n) => n.props && Array.isArray(n.children) && typeof n.children[0] === 'string' && n.children[0].startsWith('auto = 自动模式'))
  assert.equal(hintNode.length, 1, '串口说明应当渲染出来')
  const inlineParents = findAll(tree, (n) => n.props && n.props.style && n.props.style.flexDirection === 'row' &&
    Array.isArray(n.children) && n.children.some((child) => child && child.children && child.children[0] === '串口'))
  assert.equal(inlineParents.length >= 1, true, '串口的说明应与标签放在同一行（flexDirection: row）')

  // 状态行容器要有额外下间距（把状态块与下面的开关行分开）
  const statusBlock = findAll(tree, (n) => n.props && n.props.style && n.props.style.paddingBottom === '14px')
  assert.equal(statusBlock.length >= 1, true, '指示灯状态块应当有额外下间距')
})

test('设置页：配置从"未就绪"过渡到"就绪"时，hook 数量必须保持一致（否则整棵设置树被打崩）', () => {
  let ready = false
  const setCalls = []
  const form = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      value: {
        enabled: true, apiEnabled: true, debug: false, types: [],
        ledEnabled: false, ledPort: 'auto', ledBuzzer: true, ledBrightness: 160,
        ledAttention: true, ledIdleOffSec: 120,
      },
    }),
    subscribe: () => () => {},
    set: (key, value) => { setCalls.push([key, value]) },
  }
  const { Section, mini, ctx } = loadSettingsSection({ form: () => (ready ? form : null) })

  // 第 1 次：挂载时配置服务还没到（真实首屏就是这个分支）
  mini.render(mini.React.createElement(Section, null))
  // 表单到位（真实路径：cordis 的 inject 回调 → resolve() → setState → React 重渲染）
  ready = true
  ctx.fireInject('configForms')
  // 第 2 次：同一次挂载的更新渲染 —— 老代码在这里抛
  // "Rendered more hooks than during the previous render"（设置界面整片消失）
  const mid = mini.render(mini.React.createElement(Section, null))
  assert.ok(texts(mid).join('').includes('正在读取配置'), 'form 到位但快照还没读到时显示"正在读取配置…"')
  // 第 3 次：useSnapshot 的 effect 读到快照之后的重渲染 —— 完整设置界面
  const tree = mini.render(mini.React.createElement(Section, null))

  const words = texts(tree).join('|')
  // 想看最终文案长什么样：DSH_NOTIFY_DUMP_SETTINGS=1 node --test tests/client-settings.test.mjs
  if (process.env.DSH_NOTIFY_DUMP_SETTINGS) console.log('[设置页文案] ' + words.split('|').join(' / '))
  for (const label of ['桌面通知', '指示灯', '启用任务状态指示灯', '串口', '亮度', '完成时响一声', '熄灯延时（秒）', '聚焦跟踪持续提醒', '各预设推送']) {
    assert.ok(words.includes(label), `设置页应当渲染出「${label}」，实际文本：${words.slice(0, 240)}`)
  }
  // 用户明确要求：删掉的部分就是"不需要第二行字" —— 这些说明文案不许再出现
  for (const gone of ['USB 转串口的彩色灯珠', '115200 足够', '躺床上', '自上次聚焦后', '255 是']) {
    assert.equal(words.includes(gone), false, `不该再渲染说明文字「${gone}」`)
  }
})

test('亮度/熄灯延时用标准步进控件：箭头按步长提交，且不会越过上下限', () => {
  const setCalls = []
  const form = {
    getSnapshot: () => ({
      status: 'ready', writable: true,
      value: { enabled: true, types: [], ledEnabled: true, ledPort: 'auto', ledBuzzer: true, ledBrightness: 160, ledAttention: true, ledIdleOffSec: 120 },
    }),
    subscribe: () => () => {},
    set: (key, value) => { setCalls.push([key, value]) },
  }
  const { Section, mini } = loadSettingsSection({ form })
  mini.render(mini.React.createElement(Section, null))
  const tree = mini.render(mini.React.createElement(Section, null))

  const byLabel = (label) => {
    const hits = findAll(tree, (n) => n.props && n.props['aria-label'] === label)
    assert.equal(hits.length, 1, `应当有且只有一个「${label}」按钮`)
    return hits[0]
  }
  byLabel('增大亮度').props.onClick()
  assert.deepEqual(setCalls.pop(), ['ledBrightness', 170])
  byLabel('减小亮度').props.onClick()
  assert.deepEqual(setCalls.pop(), ['ledBrightness', 150])
  byLabel('增大熄灯延时（秒）').props.onClick()
  assert.deepEqual(setCalls.pop(), ['ledIdleOffSec', 130])

  // 步进控件本体是标准胶囊（两个数值字段各一个）
  const pills = findAll(tree, (n) => n.props && n.props.className === 'dsh-notify-stepper')
  assert.equal(pills.length, 2, '亮度/熄灯延时各一个步进控件（波特率由固件固定，已删）')
  const inputs = findAll(tree, (n) => n.props && n.props.className === 'dsh-notify-input')
  assert.equal(inputs.length, 1, '串口用标准文本输入')

  // 胶囊宽度按位数撑开（DSH 自己的区间步进控件同款解法：calc(Nch + 52px) + 左右各 26px 内边距）
  const values = findAll(tree, (n) => n.props && n.props.className === 'dsh-notify-stepper-value')
  assert.deepEqual(values.map((n) => n.props.style.width), ['calc(3ch + 52px)', 'calc(3ch + 52px)'])
})

test('行标题格式：一律用标准设置字段的 13px / 字重 500（删掉第二行后不再显得又小又轻）', () => {
  const form = {
    getSnapshot: () => ({
      status: 'ready', writable: true,
      value: { enabled: true, types: [], ledEnabled: true, ledPort: 'auto', ledBuzzer: true, ledBrightness: 160, ledAttention: true, ledIdleOffSec: 120 },
    }),
    subscribe: () => () => {},
    set: () => {},
  }
  const { Section, mini } = loadSettingsSection({ form })
  mini.render(mini.React.createElement(Section, null))
  const tree = mini.render(mini.React.createElement(Section, null))
  const labelOf = (text) => {
    const hits = findAll(tree, (n) => n.props && n.props.style && Array.isArray(n.children) && n.children[0] === text)
    assert.equal(hits.length >= 1, true, `应当渲染出标题「${text}」`)
    return hits[0].props.style
  }
  for (const text of ['启用任务状态指示灯', '聚焦跟踪持续提醒', '亮度', '完成时响一声', '熄灯延时（秒）', '串口']) {
    assert.equal(labelOf(text).fontSize, '13px', `「${text}」应当用标准字段字号`)
    assert.equal(labelOf(text).fontWeight, 500, `「${text}」应当加粗（标准字段字重）`)
  }
})

test('标准控件样式：填充式无边框（与 dsh-path-guard 同族），行内不再画分割线', () => {
  // 控件面 = 内联 CONTROL（填充、无边框），照 dsh-path-guard 的 CONTROL：
  // 32px / --dsw-radius-sm / bg-module-platform / border:none。
  // 明确**不是**宿主那个描边式设置字段（0.5px border-l4 + bg-layer-3 + 聚焦变蓝）——
  // 深色主题下那圈描边就是用户说的"多余的白边"。
  assert.match(CLIENT_SOURCE, /height: '32px'[\s\S]{0,200}border: 'none'[\s\S]{0,200}background: 'var\(--dsw-alias-bg-module-platform\)'/)
  assert.equal(/--dsw-alias-border-l4/.test(CLIENT_SOURCE), false, '控件不该再有任何描边 token')
  assert.equal(/border-top:0\.5px solid var\(--dsw-alias-border-l2\)\}/.test(CLIENT_SOURCE), false, '行间分割线已按要求删除')
  // 聚焦不画环（填充本身就是可点提示），placeholder / disabled 由样式表兜
  assert.match(CLIENT_SOURCE, /\.dsh-notify-input:focus-visible\{outline:none\}/)
  assert.match(CLIENT_SOURCE, /\.dsh-notify-input::placeholder\{color:var\(--dsw-alias-label-dimmed\)\}/)
  // 步进胶囊与文本输入同为 32px，整列行高才一致
  assert.match(CLIENT_SOURCE, /\.dsh-notify-stepper\{[^}]*height:32px/)
})

test('指示灯状态：没插设备 → "未连接"（不是"异常"），且不显示"画面"', async () => {
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, types: [], ledEnabled: true, ledPort: 'auto' } }),
    subscribe: () => () => {},
    set: () => {},
  }
  const h0 = loadSettingsSection({
    form,
    ledStatus: {
      ok: true, reason: 'ok',
      link: { state: 'error', errorCode: 'no-device', lastError: '没有找到任何串口设备' },
      scene: { state: 'running', flags: 0 },
    },
  })
  const { Section, mini } = h0
  const el = () => mini.React.createElement(Section, null)
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  mini.render(el())          // 1) 配置快照还没读到
  await flush()
  mini.render(el())          // 2) 快照就绪 → 卡片挂载并发出第一次轮询
  await flush()              //    等轮询的 promise 落地
  const words = texts(mini.render(el())).join('|')   // 3) 状态已就绪
  assert.ok(words.includes('指示灯状态：未连接'), `没插设备应是"未连接"：${words.slice(0, 200)}`)
  assert.ok(words.includes('没有找到串口设备'), '要说明原因（短句）')
  assert.equal(words.includes('异常'), false, '没插设备不该报成异常')
  assert.equal(words.includes('画面：'), false, '没连上就别谈"画面"，免得让人以为灯在亮')
})

test('指示灯状态：功能没开 → "未启用"，且不显示"画面"', async () => {
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, types: [], ledEnabled: false } }),
    subscribe: () => () => {},
    set: () => {},
  }
  const { Section, mini } = loadSettingsSection({
    form,
    ledStatus: { ok: true, reason: 'disabled', link: { state: 'disabled' }, scene: { state: 'off', flags: 0 } },
  })
  const el = () => mini.React.createElement(Section, null)
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  mini.render(el())
  await flush()
  mini.render(el())
  await flush()
  const words = texts(mini.render(el())).join('|')
  assert.ok(words.includes('指示灯状态：未启用'))
  assert.equal(words.includes('画面：'), false, '没启用就别说画面')
})

test('指示灯状态：连上之后 → "运行中" + 端口/灯珠 + 画面', async () => {
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, types: [], ledEnabled: true, ledPort: 'COM7' } }),
    subscribe: () => () => {},
    set: () => {},
  }
  const { Section, mini } = loadSettingsSection({
    form,
    ledStatus: {
      ok: true, reason: 'ok',
      link: { state: 'ready', port: 'COM7', baud: 115200, errorCode: '' },
      device: { leds: 60, wireVersion: 1 },
      scene: { state: 'done', flags: 1 },
    },
  })
  const el = () => mini.React.createElement(Section, null)
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  mini.render(el())
  await flush()
  mini.render(el())
  await flush()
  const words = texts(mini.render(el())).join('|')
  assert.ok(words.includes('指示灯状态：运行中'), words.slice(0, 200))
  assert.ok(words.includes('COM7 · 60 灯珠'), '已连接时给端口与灯珠数')
  assert.ok(words.includes('画面：已完成（提醒中）'), '已连接时才显示画面')
})

test('设置页样式表必须跟着代码更新（跨热重载的旧 CSS 不能被留在页面上）', () => {
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, types: [] } }),
    subscribe: () => () => {},
    set: () => {},
  }
  const first = loadSettingsSection({ form })
  const styleEl = first.styles[0]
  assert.ok(styleEl && styleEl.textContent.includes('.dsh-notify-stepper'), '应当注入设置页样式')
  // 模拟"客户端插件热重载"：同一个 document 上再 apply 一次，已存在的样式元素必须被刷新
  styleEl.textContent = '/* stale */'
  first.apply(first.ctx)
  assert.ok(styleEl.textContent.includes('.dsh-notify-stepper'), '已存在的样式元素也要更新内容，不能直接 return')
})

test('顺序：聚焦跟踪持续提醒紧跟启用开关，之后才是串口/亮度等字段', () => {
  const form = {
    getSnapshot: () => ({
      status: 'ready', writable: true,
      value: { enabled: true, types: [], ledEnabled: true, ledPort: 'auto', ledBuzzer: true, ledBrightness: 160, ledAttention: true, ledIdleOffSec: 120 },
    }),
    subscribe: () => () => {},
    set: () => {},
  }
  const { Section, mini } = loadSettingsSection({ form })
  mini.render(mini.React.createElement(Section, null))
  const words = texts(mini.render(mini.React.createElement(Section, null)))
  const at = (text) => words.indexOf(text)
  assert.ok(at('启用任务状态指示灯') >= 0 && at('聚焦跟踪持续提醒') >= 0, '两个开关都要在')
  assert.ok(at('启用任务状态指示灯') < at('聚焦跟踪持续提醒'), '提醒开关要紧跟启用开关')
  assert.ok(at('聚焦跟踪持续提醒') < at('串口'), '提醒开关要在串口等字段之前')
})

test('指示灯状态：首屏给"启动中"，不因为拿不到宿主状态而崩', () => {
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, types: [] } }),
    subscribe: () => () => {},
    set: () => {},
  }
  const { Section, mini } = loadSettingsSection({ form })
  mini.render(mini.React.createElement(Section, null))            // 挂载：effect 读快照
  const tree = mini.render(mini.React.createElement(Section, null)) // 更新渲染
  const words = texts(tree).join('|')
  assert.ok(words.includes('指示灯'), `应渲染指示灯卡片：${words.slice(0, 160)}`)
  assert.ok(words.includes('指示灯状态：启动中'), '还没拿到宿主回包时说"启动中"')
  // 状态词只有五个（用户指定）；不许再冒出别的词
  for (const gone of ['未识别', '不支持']) {
    assert.equal(words.includes(gone), false, `不该再出现「${gone}」`)
  }
})

test('指示灯状态：没设备时"未连接"优先于"未启用"，并锁死启用开关（不会偷偷改你的配置）', async () => {
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, types: [], ledEnabled: true } }),
    subscribe: () => () => {},
    set: () => {},
  }
  const { Section, mini } = loadSettingsSection({
    form,
    // 配置里 ledEnabled=true，但本机一个串口都没有 → 必须显示"未连接"，且开关显示为关、不可点
    ledStatus: { ok: true, reason: 'ok', devicePresent: false, ports: [], link: { state: 'disabled' }, scene: { state: 'off', flags: 0 } },
  })
  const el = () => mini.React.createElement(Section, null)
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  mini.render(el())
  await flush()
  mini.render(el())
  await flush()
  const tree = mini.render(el())
  const words = texts(tree).join('|')
  assert.ok(words.includes('指示灯状态：未连接'), `没设备应判"未连接"：${words.slice(0, 200)}`)
  assert.equal(words.includes('指示灯状态：未启用'), false, '"未连接"优先于"未启用"')

  // 启用开关：显示为关 + disabled（未连接时禁止启用）
  const enabledSwitch = findAll(tree, (n) => n.props && n.props['data-dsh-notify-setting'] === 'ledEnabled')[0]
  assert.ok(enabledSwitch, '应当渲染启用开关')
  assert.equal(enabledSwitch.props['aria-checked'], 'false', '未连接时开关显示为关')
  assert.equal(enabledSwitch.props.disabled, true, '未连接时开关不可点')
})

test('设置页：配置不可用（unavailable）时给提示而不是崩', () => {
  const form = {
    getSnapshot: () => ({ status: 'unavailable', writable: false, value: null }),
    subscribe: () => () => {},
    set: () => {},
  }
  const { Section, mini } = loadSettingsSection({ form })
  mini.render(mini.React.createElement(Section, null))
  const tree = mini.render(mini.React.createElement(Section, null))
  assert.ok(texts(tree).join('').includes('不可配置'))
})

test('插件 id 必须三处同源：bundle 注册 id / exports.name / 设置槽 key（对不上就整块客户端不加载）', () => {
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, types: [] } }),
    subscribe: () => () => {},
    set: () => {},
  }
  const h = loadSettingsSection({ form })
  // DSH 拿「安装包名」核对 bundle 注册的 id；本机 profile 按旧名安装，源码里用 PLUGIN_ID 收敛
  assert.equal(h.moduleId, 'dsh-desktop-notify', 'bundle id 必须等于安装名')
  assert.equal(h.moduleName, h.moduleId, 'exports.name 必须与 bundle id 同源')
  assert.ok(h.registered.length >= 2, '设置卡片要注册到 row 与 bundle 两处')
  for (const entry of h.registered) {
    const key = String(entry.meta.key)
    assert.ok(key === h.moduleId || key.startsWith(h.moduleId + '#'), '槽 key 必须以插件 id 开头：' + key)
  }
  // 源码层面再兜一层：四处都必须走常量，不许再出现散落的包名
  assert.match(CLIENT_SOURCE, /var PLUGIN_ID = 'dsh-desktop-notify'/)
  for (const site of ['id: PLUGIN_ID,', 'openBundle(PLUGIN_ID)', 'var SETTINGS_PKG = PLUGIN_ID', 'name = PLUGIN_ID']) {
    assert.ok(CLIENT_SOURCE.includes(site), '应当使用常量：' + site)
  }
})
