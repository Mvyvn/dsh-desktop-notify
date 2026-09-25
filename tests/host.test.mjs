// 宿主半区集成测试：用假 ctx 把 lib/index.js 的 apply() 真跑起来，
// 按 DSH 0.1.7-rc.2 的**真实契约**派发事件 / 读服务，断言通知的触发与文案。
//   npm test
//
// 覆盖（每一条都对应一个真实契约，见 DSH 源码）：
//   · agent/status {agent,status}：仅根 agent 的 idle 触发，3s 去抖后带回复摘要
//   · session/event approval/asked+decided（outcome 'rejected'）→ 审批被拒通知
//   · tools/execute waterfall：ask_user_question 派发 → 等待输入通知，且必须 next()
//   · subagent/end {id} → 后台子代理结束（会话归属 = 主会话 + 子会话）
//   · goal/changed {change:{operation,goal}} → complete / block（blockedReason.message）
//   · jobs.events.subscribe({owners:'all'}) 的 settled 事件 → 后台任务结束（awaited 跳过）
//   · connection.rpc.handle 两参签名 + {ok:true,value} / {ok:false,error{...}} 返回体，
//     并且必须在**注入了 webServer 的 ctx** 上注册（否则 cordis 注入守卫会让插件激活失败）
//   · 聚焦门控：正在看的会话静默、其它会话照常弹
//   · fs.resolve 异步返回后，工作区名前缀生效
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply, inject as declaredInject } from '../lib/index.js'

/** 造一个够用的假 cordis ctx：事件总线 + 定时器 + 服务表 + rpc + inject。 */
function harness(options = {}) {
  const sent = []
  const handlers = new Map()
  const effects = []
  const disposers = []
  const injects = []
  const timers = new Map()
  const services = {}
  let timerId = 0
  let now = 0

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(fn)
    return () => {
      const list = handlers.get(event) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    }
  }
  function emit(event, ...args) {
    for (const fn of [...(handlers.get(event) || [])]) fn(...args)
  }
  function effect(fn) {
    effects.push(fn)
    const disposer = fn()
    // 记录真实的 disposer（ctx.effect 的返回值）：卸载测试要调它，而不是再跑一遍 setup
    const off = () => { if (typeof disposer === 'function') disposer() }
    disposers.push(off)
    return off
  }
  function timeout(fn, ms) {
    const id = ++timerId
    timers.set(id, { fn, at: now + ms })
    // 真 cordis 的 ctx.timeout / ctx.effect 返回 `Disposable<Promise<void>>`
    // （fiber.ts:64-74：可调用 + thenable，**没有 .catch**）。这里保持同样的形状，
    // 免得再出现"在返回值上调 .catch 把整条 /dnotify 路由打挂"的事故。
    const dispose = () => { timers.delete(id) }
    dispose.then = (onFulfilled) => { if (typeof onFulfilled === 'function') onFulfilled(dispose); return dispose }
    return dispose
  }
  /** 推进假定时器（含推进过程中新排的定时器），并把期间到期的都执行掉。 */
  function advance(ms) {
    const target = now + ms
    for (;;) {
      let next = null
      for (const [id, t] of timers) {
        if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t }
      }
      if (!next) break
      now = next.t.at
      timers.delete(next.id)
      next.t.fn()
    }
    now = target
  }

  services.sessions = {
    get: (id) => (options.sessions ? options.sessions[String(id)] : undefined),
  }
  services.sessionTitle = {
    get: (session) => (session && session.title ? { title: session.title } : undefined),
  }
  services.agents = { roots: () => options.roots || [] }
  services.fs = {
    resolve: async () => 'target',
    processPath: () => options.cwd || '',
  }
  if (options.loader) services.loader = options.loader
  // webServer 一直提供：真实组合里它由 web-app bundle 提供，插件用它拼点击跳转地址，
  // 也用它挂自带的 /dnotify 路由（聚焦上报 + 点击投递）。routes 里保留整条路由，
  // 测试可以拿 handler 直接发假请求（见下面的 request()）。
  const routes = []
  services.webServer = Object.assign({
    host: '127.0.0.1',
    port: 3080,
    register: (route) => {
      routes.push(route)
      return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1) }
    },
  }, options.webServer || {})

  // 插件现在自带 HTTP 路由（不再用 DSH 的 connection.rpc.handle：0.1.7-rc.2 里它的
  // owner 解析到服务注册 ctx 的影子 fiber，读 webServer 必撞注入守卫，通道根本挂不上）。
  // 所以这里只需要：webServer.register 能收下路由（供测试直接调用 handler），
  // connection.admit 能放过/拒绝请求（模拟 Host/Origin 栅栏 + 浏览器鉴权）。
  const declared = new Set(declaredInject)
  const denied = (name) => { throw new Error(`cannot get property "${name}" without inject`) }
  let admitRejection = undefined
  services.connection = {
    admit: () => (admitRejection === undefined ? { peer: { id: 'probe' } } : { rejection: admitRejection }),
  }
  function bind(scope, allowed) {
    for (const name of allowed) {
      Object.defineProperty(scope, name, {
        configurable: true,
        get: () => services[name],
      })
    }
    return scope
  }

  const ctx = bind({
    get: (name) => services[name],
    on,
    effect,
    timeout,
    provide: (name, value) => {
      services[name] = value
      return () => { delete services[name] }
    },
    inject: (deps, cb) => {
      injects.push({ deps, cb })
      // 真 cordis 在 deps 全部就绪时调用 cb；这里同样在服务都存在时立即调用
      if (deps.every((dep) => services[dep] !== undefined)) {
        return cb(bind({ get: (name) => services[name], effect, timeout }, deps))
      }
      return undefined
    },
  }, ['connection', ...declaredInject])

  // 没声明在 inject 里的服务属性一律不可读（与 cordis 的守卫一致）
  for (const name of Object.keys(services)) {
    if (name === 'connection' || declared.has(name)) continue
    Object.defineProperty(ctx, name, { configurable: true, get: () => denied(name) })
  }
  void declared
  /**
   * 造一对假 req/res 调 `/dnotify` 的 handler（测试直接走真实路由分支）。
   * @returns {Promise<{status: number, body: string, headers: object}>}
   */
  async function request(options = {}) {
    const route = routes[routes.length - 1]
    if (!route || typeof route.handler !== 'function') throw new Error('没有已挂载的 /dnotify 路由')
    const req = new EventEmitter()
    req.method = options.method || 'GET'
    req.url = options.url || '/dnotify/page-focus'
    req.headers = options.headers || {}
    req.destroy = () => {}
    const res = new EventEmitter()
    res.status = 0
    res.headers = {}
    res.headersSent = false
    res.chunks = []
    res.writeHead = (status, headers) => {
      res.status = status
      res.headers = headers || {}
      res.headersSent = true
    }
    res.write = (chunk) => { res.chunks.push(String(chunk)); return true }
    res.end = (chunk) => {
      if (chunk !== undefined) res.chunks.push(String(chunk))
      if (!res.headersSent) { res.status = 200; res.headersSent = true }
      res.body = res.chunks.join('')
      return res
    }
    route.handler(req, res)
    if (options.body !== undefined) {
      const payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      process.nextTick(() => { req.emit('data', Buffer.from(payload, 'utf8')); req.emit('end') })
    } else {
      process.nextTick(() => { req.emit('end') })
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { status: res.status, body: res.body || res.chunks.join(''), headers: res.headers, res }
  }
  return {
    ctx, sent, services, emit, advance, effects, disposers, injects, routes, request,
    /** 从已发出通知的点击链接里取进程令牌（测试用它模拟"用户点击了通知"）。 */
    clickToken() {
      for (const item of sent) {
        const m = /[?&]t=([^&]+)/.exec(item.url || '')
        if (m) return decodeURIComponent(m[1])
      }
      return ''
    },
    /** 让下一次 connection.admit() 返回拒绝（401/403），模拟栅栏/鉴权失败。 */
    setAdmitRejection(status) { admitRejection = status },
    /** 触发某个延迟注册的服务（模拟服务晚挂载）。 */
    mount(deps, ctxForService) {
      const hit = injects.filter((entry) => entry.deps.includes(deps))
      for (const entry of hit) entry.cb(ctxForService)
      return hit.length
    },
  }
}

/** apply 一份插件并等 fs.resolve 那个微任务落地。 */
async function start(options = {}) {
  const h = harness(options)
  let config = { debug: false, sender: (item) => { h.sent.push(item) } }
  if (options.config) config = { ...config, ...options.config }
  apply(h.ctx, config)
  await Promise.resolve()
  await Promise.resolve()
  h.advance(1)   // 让 fs.resolve 的 then 之外的定时器无副作用地走一遍
  return h
}

/** 假 loader：模拟 profile 组合里的插件行（fiber.state: 2=ACTIVE 3=FAILED）。 */
function fakeLoader(rows) {
  return {
    entries: () => rows.map((row) => ({
      options: { id: row.id, name: row.name || row.id },
      disabled: row.disabled === true,
      fiber: row.state === undefined ? undefined : { state: row.state },
    })),
    await: async () => {},
  }
}

/** 启动播报用真实 setTimeout（300ms 落位），等它跑完。 */
const settleStartup = () => new Promise((resolve) => setTimeout(resolve, 450))

const ROOT_AGENT = { id: 's1', session: { id: 's1', title: '会话一', header: { cwd: 'D:\\ws\\proj' } } }

test('根 agent 空闲 3s 后弹出"任务完成"，带工作区/会话前缀与回复摘要', async () => {
  const h = await start({ roots: [ROOT_AGENT], sessions: { s1: ROOT_AGENT.session } })
  h.emit('session/event', ROOT_AGENT.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '改好了  三个文件' }] } },
  })
  h.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  h.advance(1000)
  assert.deepEqual(h.sent, [], '运行中不通知')
  h.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  h.advance(3000)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '✅ DSH 任务完成')
  assert.equal(h.sent[0].message, 'proj/会话一:改好了 三个文件')
  assert.equal(h.sent[0].urgency, 'low')
})

test('子代理的 idle 不触发任务完成通知', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const sub = { id: 'sub-9', session: { id: 'sub-9' } }
  h.emit('agent/status', { agent: sub, status: 'idle' })
  h.advance(5000)
  assert.deepEqual(h.sent, [])
})

test('正在看的会话被静默，其它会话照常弹', async () => {
  const other = { id: 's2', session: { id: 's2', title: '会话二' } }
  const h = await start({ roots: [ROOT_AGENT, other], sessions: { s1: ROOT_AGENT.session } })
  const focus = await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, pageId: 'p1', sessionId: 's1' } })
  assert.equal(focus.status, 200)
  assert.deepEqual(JSON.parse(focus.body), { ok: true, pages: 1 })

  h.emit('session/event', ROOT_AGENT.session, {
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A 完成' }] } },
  })
  h.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  h.advance(4000)
  assert.deepEqual(h.sent, [], '正在看的会话应静默')

  h.emit('session/event', other.session, {
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'B 完成' }] } },
  })
  h.emit('agent/status', { agent: other, status: 'idle' })
  h.advance(4000)
  assert.equal(h.sent.length, 1, '没在看的会话照常弹')
  assert.match(h.sent[0].message, /B 完成/)
})

test('自带 /dnotify 路由挂在 webServer 上，卸载时摘掉', async () => {
  const h = await start({ roots: [ROOT_AGENT], sessions: { s1: ROOT_AGENT.session } })
  assert.equal(h.routes.length, 1)
  assert.equal(h.routes[0].path, '/dnotify')
  assert.equal(h.routes[0].kind, 'prefix')
  // 卸载时把路由摘掉，避免热更新后留下悬挂路由
  h.disposers.forEach((off) => off())
  assert.deepEqual(h.routes, [])
})

test('路由的信任栅栏：connection.admit 拒绝时返回 401/403，不处理请求', async () => {
  const h = await start({ roots: [ROOT_AGENT], sessions: { s1: ROOT_AGENT.session } })
  h.setAdmitRejection(401)
  const rejected = await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, pageId: 'p1' } })
  assert.equal(rejected.status, 401)
  h.setAdmitRejection(undefined)
  const ok = await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, pageId: 'p1' } })
  assert.equal(ok.status, 200)
})

test('点击落地页：令牌不对返回 403，令牌正确则记录目标', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  // 令牌只从插件自己发出的点击链接里能拿到（同一进程内一致）
  h.services.desktopNotify.pushAlways({ title: '取令牌', sessionId: 's1' })
  h.advance(500)
  const token = h.clickToken()
  assert.ok(token, '通知的点击链接里应带进程令牌')

  const bad = await h.request({ method: 'GET', url: '/dnotify/click?t=wrong&target=session:s1' })
  assert.equal(bad.status, 403)

  const target = 'session:s1'
  const good = await h.request({ method: 'GET', url: `/dnotify/click?t=${token}&target=${encodeURIComponent(target)}` })
  assert.equal(good.status, 200)
  assert.match(good.body, /已通知 DSH 切换/)
  // 目标进入待认领队列：第一个认领者拿到，第二个拿不到（多页面只切一个）
  const first = await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p1' } })
  assert.deepEqual(JSON.parse(first.body), { ok: true, target })
  const second = await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p2' } })
  assert.deepEqual(JSON.parse(second.body), { ok: false, reason: 'none' })
})

test('点击落地页：非法目标被忽略（不会进待认领队列）', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  h.services.desktopNotify.pushAlways({ title: '取令牌', sessionId: 's1' })
  h.advance(500)
  const bad = await h.request({ method: 'GET', url: `/dnotify/click?t=${h.clickToken()}&target=${encodeURIComponent('javascript:alert(1)')}` })
  assert.equal(bad.status, 200)
  const claim = await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p1' } })
  assert.deepEqual(JSON.parse(claim.body), { ok: false, reason: 'none' })
})

test('SSE：连接的页面立刻拿到待处理跳转，新点击会推给已连接的页面', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  h.services.desktopNotify.pushAlways({ title: '取令牌', sessionId: 's1' })
  h.advance(500)
  const stream = await h.request({ method: 'GET', url: '/dnotify/events' })
  assert.equal(stream.status, 200)
  assert.match(String(stream.headers['content-type']), /text\/event-stream/)
  assert.match(stream.res.chunks.join(''), /retry: 2000/)
  // 新点击 → 已连接的流上出现 navigate 事件
  await h.request({ method: 'GET', url: `/dnotify/click?t=${h.clickToken()}&target=${encodeURIComponent('page:plugins')}` })
  assert.match(stream.res.chunks.join(''), /event: navigate/)
  assert.match(stream.res.chunks.join(''), /page:plugins/)
  // 未知端点 404
  const unknown = await h.request({ method: 'GET', url: '/dnotify/nope' })
  assert.equal(unknown.status, 404)
})

test('SSE：流断开后不再推送，也不会因为心跳而报错', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  h.services.desktopNotify.pushAlways({ title: '取令牌', sessionId: 's1' })
  h.advance(500)
  const stream = await h.request({ method: 'GET', url: '/dnotify/events' })
  stream.res.emit('close')   // 页面关闭：摘掉订阅 + 停掉心跳
  const click = await h.request({ method: 'GET', url: `/dnotify/click?t=${h.clickToken()}&target=${encodeURIComponent('page:plugins')}` })
  assert.equal(click.status, 200, '断开后新点击不应把路由打挂')
  const claim = await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p1' } })
  assert.deepEqual(JSON.parse(claim.body), { ok: true, target: 'page:plugins' }, '目标仍可被认领')
})

test('页面失焦后恢复推送', async () => {
  const h = await start({ roots: [ROOT_AGENT], sessions: { s1: ROOT_AGENT.session } })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, pageId: 'p1', sessionId: 's1' } })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: false, pageId: 'p1' } })

  h.emit('session/event', ROOT_AGENT.session, {
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '失焦后要弹' }] } },
  })
  h.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  h.advance(4000)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].message, /失焦后要弹/)
})

test('审批被拒：approval/asked + decided(rejected) 配对后通知', async () => {
  const h = await start()
  h.emit('session/event', ROOT_AGENT.session, {
    type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', reason: '危险命令' },
  })
  h.advance(10)
  assert.deepEqual(h.sent, [], '只 asked 不通知')
  h.emit('session/event', ROOT_AGENT.session, { type: 'approval/decided', data: { id: 'ap-1', outcome: 'rejected' } })
  h.advance(500)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '🚫 操作被自动拒绝')
  assert.match(h.sent[0].message, /bash-危险命令/)
})

test('审批被允许（allowed-once）不通知', async () => {
  const h = await start()
  h.emit('session/event', ROOT_AGENT.session, {
    type: 'approval/asked', data: { id: 'ap-2', toolName: 'bash' },
  })
  h.emit('session/event', ROOT_AGENT.session, { type: 'approval/decided', data: { id: 'ap-2', outcome: 'allowed-once' } })
  h.advance(500)
  assert.deepEqual(h.sent, [])
})

test('ask_user_question：通知等待输入并继续 tools/execute 瀑布', async () => {
  const h = await start()
  let nexted = false
  h.emit('tools/execute', {
    name: 'ask_user_question',
    arguments: { questions: [{ header: '范围', question: '要改哪些文件？' }] },
    agent: ROOT_AGENT,
  }, () => { nexted = true; return Promise.resolve({ content: [] }) })
  assert.equal(nexted, true, 'waterfall 必须调用 next()')
  h.advance(500)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '❓ DSH 等待你的输入')
  assert.match(h.sent[0].message, /\[范围\] 要改哪些文件？/)
})

test('其它工具不产生等待输入通知', async () => {
  const h = await start()
  h.emit('tools/execute', { name: 'bash', arguments: {}, agent: ROOT_AGENT }, () => Promise.resolve({}))
  h.advance(500)
  assert.deepEqual(h.sent, [])
})

test('subagent/end：按主会话回溯工作区与标题', async () => {
  const subSession = { id: 'child-1', title: '子代理', header: { parentSession: 's1' } }
  const h = await start({
    sessions: { s1: ROOT_AGENT.session, 'child-1': subSession },
  })
  h.emit('subagent/end', { runId: 'run-1', provider: 'inproc', id: 'child-1', local: false, stopReason: 'completed' })
  h.advance(500)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '🤖 后台子代理结束')
  assert.equal(h.sent[0].message, 'proj/会话一:子代理已完成')
})

test('goal/changed：complete 与 block（blockedReason.message）', async () => {
  const h = await start()
  h.emit('goal/changed', {
    agent: ROOT_AGENT,
    change: { operation: 'complete', ref: { id: 'g1', revision: 2 }, goal: { objective: '把插件升到 0.1.7' } },
  })
  h.advance(500)
  assert.equal(h.sent[0].title, '🎯 目标已完成')
  assert.match(h.sent[0].message, /把插件升到 0\.1\.7-已完成/)

  h.emit('goal/changed', {
    agent: ROOT_AGENT,
    change: {
      operation: 'block',
      ref: { id: 'g1', revision: 3 },
      goal: { objective: '把插件升到 0.1.7', blockedReason: { code: 'waiting-input', message: '缺少 CI 令牌' } },
    },
  })
  h.advance(500)
  assert.equal(h.sent[1].title, '🎯 目标已阻塞')
  assert.match(h.sent[1].message, /缺少 CI 令牌/)
})

test('goal/changed：clear（没有 goal）不通知', async () => {
  const h = await start()
  h.emit('goal/changed', { agent: ROOT_AGENT, change: { operation: 'clear', ref: { id: 'g1', revision: 4 } } })
  h.advance(500)
  assert.deepEqual(h.sent, [])
})

test('jobs：0.1.7 的 events.subscribe(settled) 触发后台任务通知，awaited 跳过', async () => {
  const h = await start()
  const listeners = []
  const mounted = h.mount('jobs', {
    jobs: {
      events: {
        subscribe: (filter, listener) => {
          listeners.push({ filter, listener })
          return () => listeners.splice(listeners.indexOf(listener), 1)
        },
      },
    },
    effect: (fn) => { fn(); return () => {} },
  })
  assert.equal(mounted, 1, 'jobs 必须走 ctx.inject 延迟注册')
  assert.deepEqual(listeners[0].filter, { owners: 'all' })

  // 非 settled 事件不通知
  listeners[0].listener({ type: 'progress', job: { id: 'j1', label: '构建', status: 'running' } })
  // 已被等待方收走的结算不通知
  listeners[0].listener({ type: 'settled', awaited: true, cause: 'producer', job: { id: 'j1', label: '构建', status: 'completed' } })
  h.advance(500)
  assert.deepEqual(h.sent, [])

  listeners[0].listener({ type: 'settled', awaited: false, cause: 'producer', job: { id: 'j2', label: '构建', status: 'completed' } })
  listeners[0].listener({ type: 'settled', awaited: false, cause: 'kill', job: { id: 'j3', label: '测试', status: 'killed' } })
  listeners[0].listener({ type: 'settled', awaited: false, cause: 'producer', job: { id: 'j4', label: '部署', status: 'failed', owner: 's1' } })
  h.advance(1000)
  assert.equal(h.sent.length, 3)
  assert.equal(h.sent[0].title, '🧰 后台任务结束')
  assert.match(h.sent[0].message, /构建已完成/)
  assert.match(h.sent[1].message, /测试被终止/)
  assert.match(h.sent[2].message, /部署失败/)
  assert.equal(h.sent[2].urgency, 'normal', '失败的任务用 normal 提醒')
})

test('jobs 服务没有 events 时只记日志，不影响其它通知', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  h.mount('jobs', { jobs: {}, effect: () => () => {} })
  h.emit('session/event', ROOT_AGENT.session, {
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '照常工作' }] } },
  })
  h.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  h.advance(4000)
  assert.equal(h.sent.length, 1)
})

test('agents.roots() 为空时退回会话谱系判断，不丢任务完成通知', async () => {
  const h = await start({ roots: [] })
  const forked = { id: 's7', session: { id: 's7', title: '普通会话' } }
  const child = { id: 's8', session: { id: 's8', header: { origin: 'subagent' } } }
  h.emit('session/event', forked.session, {
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '根会话完成' }] } },
  })
  h.emit('agent/status', { agent: forked, status: 'idle' })
  h.emit('session/event', child.session, {
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '子会话完成' }] } },
  })
  h.emit('agent/status', { agent: child, status: 'idle' })
  h.advance(4000)
  assert.equal(h.sent.length, 1, '只有非子代理会话触发')
  assert.match(h.sent[0].message, /根会话完成/)
})

test('工作区名来自 fs.resolve 的异步结果（会话没有 cwd 时的回退）', async () => {
  const bare = { id: 's9', session: { id: 's9', title: '无 cwd 会话' } }
  const h = await start({ cwd: 'D:\\ws\\另一个项目', roots: [bare] })
  h.emit('session/event', bare.session, {
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好了' }] } },
  })
  h.emit('agent/status', { agent: bare, status: 'idle' })
  h.advance(4000)
  assert.equal(h.sent[0].message, '另一个项目/无 cwd 会话:好了')
})

test('同文案在去重窗口内只弹一次（事件重复派发不连弹）', async () => {
  const h = await start()
  const api = h.services.desktopNotify
  assert.equal(api.push({ title: '重复提醒', message: '同一件事' }), true)
  assert.equal(api.push({ title: '重复提醒', message: '同一件事' }), false, '第二条被去重')
  h.advance(1000)
  assert.equal(h.sent.length, 1)
})

test('对外 API：push 走门控并如实返回是否入队，pushAlways 绕过门控', async () => {
  const h = await start()
  const api = h.services.desktopNotify
  assert.ok(api, 'desktopNotify 服务必须注册')
  assert.equal(api.push({ title: '构建完成', message: '全部通过' }), true)
  h.advance(500)
  assert.equal(h.sent.length, 1)

  // 聚焦页正在看 s1 → push(sessionId: s1) 被静默，返回 false
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, pageId: 'p1', sessionId: 's1' } })
  assert.equal(api.push({ title: '被静默的', sessionId: 's1' }), false)
  assert.equal(api.pushAlways({ title: '强制弹出', sessionId: 's1' }), true)
  h.advance(500)
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].title, '强制弹出')

  // 结构化明细：被静默 / 载荷无效 都能区分
  const detail = api.notify({ title: '结构化', sessionId: 's1' })
  assert.deepEqual(detail, { ok: true, queued: false, silenced: true, reason: 'silenced' })
  assert.deepEqual(api.notify({ title: '' }), { ok: false, queued: false, silenced: false, reason: 'invalid-payload' })
})

test('jobs：kind=subagent 的 job 不再重复通知（subagent/end 已经报过）', async () => {
  const h = await start()
  const listeners = []
  h.mount('jobs', {
    jobs: { events: { subscribe: (filter, listener) => { listeners.push(listener); return () => {} } } },
    effect: (fn) => { fn(); return () => {} },
  })
  // 后台一次性子代理：tool-subagent 用 jobs.start({ kind: 'subagent' }) 注册，
  // 同一个 run 还会派发 subagent/end——两边都通知就是两条 toast。
  listeners[0]({ type: 'settled', awaited: false, cause: 'producer', job: { id: 'subagent-1', kind: 'subagent', label: '重构 auth 模块', status: 'completed', owner: 's1' } })
  h.advance(500)
  assert.deepEqual(h.sent, [])
  // 其它 kind 照常通知
  listeners[0]({ type: 'settled', awaited: false, cause: 'producer', job: { id: 'bash-1', kind: 'bash', label: 'npm test', status: 'completed' } })
  h.advance(500)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].message, /npm test已完成/)
})

test('同名后台任务在同一去重窗口内各自通知（去重键带 job.id）', async () => {
  const h = await start()
  const listeners = []
  h.mount('jobs', {
    jobs: { events: { subscribe: (f, l) => { listeners.push(l); return () => {} } } },
    effect: (fn) => { fn(); return () => {} },
  })
  listeners[0]({ type: 'settled', awaited: false, cause: 'producer', job: { id: 'bash-1', kind: 'bash', label: 'npm test', status: 'completed' } })
  listeners[0]({ type: 'settled', awaited: false, cause: 'producer', job: { id: 'bash-2', kind: 'bash', label: 'npm test', status: 'completed' } })
  h.advance(1000)
  assert.equal(h.sent.length, 2, '两个不同任务不能被同文案去重合并')
  assert.equal(h.sent[0].message, h.sent[1].message)
})

test('被取消的 idle 定时器不留在插件里（50 次 running/idle 后卸载不再逐个取消废定时器）', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  let cancelCalls = 0
  const originalTimeout = h.ctx.timeout
  h.ctx.timeout = (fn, ms) => {
    const cancel = originalTimeout(fn, ms)
    return () => { cancelCalls += 1; cancel() }
  }
  for (let i = 0; i < 50; i += 1) {
    h.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
    h.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  }
  h.advance(5000)   // 让最后一个 idle 去抖真正触发（走自清理路径）
  const before = cancelCalls
  for (const off of h.disposers) off()
  assert.ok(cancelCalls - before <= 1,
    `卸载时不该再逐个取消已作废的定时器（多取消了 ${cancelCalls - before} 个）`)
})

test('启动播报：全部加载成功时推一次"插件启动成功:共有 N 个插件成功加载"', async () => {
  globalThis.__dshDesktopNotifyStartupReported = false
  const h = await start({
    loader: fakeLoader([
      { id: 'webserver', state: 2 },
      { id: 'desktop-notify', state: 2 },
      { id: 'some-experimental', state: 2 },
      { id: 'off-by-config', disabled: true },          // 主动关掉的不计入
    ]),
    webServer: { host: '127.0.0.1', port: 3080 },
  })
  await settleStartup()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '🚀 DSH 启动完成')
  assert.equal(h.sent[0].message, '插件启动成功:共有 3 个插件成功加载')
  assert.match(h.sent[0].url, /^http:\/\/127\.0\.0\.1:3080\/dnotify\/click\?t=[^&]+&target=page%3Asettings-plugins$/,
    '启动通知点击 → 设置/内置插件（经 /dnotify/click 落地页 + SSE 投递）')
})

test('启动播报：有插件没加载起来时列出它们的 id', async () => {
  globalThis.__dshDesktopNotifyStartupReported = false
  const h = await start({
    loader: fakeLoader([
      { id: 'webserver', state: 2 },
      { id: 'broken-one', state: 3 },      // FAILED
      { id: 'never-imported' },            // 连 fiber 都没有
      { id: 'stuck-pending', state: 0 },   // await 之后仍未激活
    ]),
    webServer: { host: '127.0.0.1', port: 3080 },
  })
  await settleStartup()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '⚠️ DSH 启动有插件未加载')
  assert.equal(h.sent[0].message, '有 3 个插件启动失败:加载失败的插件为 broken-one、never-imported、stuck-pending')
  assert.equal(h.sent[0].urgency, 'normal')
})

test('启动播报每次进程只推一次（重复 apply 不重播）', async () => {
  globalThis.__dshDesktopNotifyStartupReported = false
  const loader = fakeLoader([{ id: 'webserver', state: 2 }])
  const first = await start({ loader, webServer: { host: '127.0.0.1', port: 3080 } })
  await settleStartup()
  assert.equal(first.sent.length, 1)
  const second = await start({ loader, webServer: { host: '127.0.0.1', port: 3080 } })
  await settleStartup()
  assert.deepEqual(second.sent, [], '第二次 apply（热更新/重复加载）不再播报')
})

test('没有 loader 服务（非 profile 组合）时不播报、不报错', async () => {
  globalThis.__dshDesktopNotifyStartupReported = false
  const h = await start()
  await settleStartup()
  assert.deepEqual(h.sent, [])
})

test('会话类通知自动带上"跳转到该会话"的点击链接', async () => {
  globalThis.__dshDesktopNotifyStartupReported = true   // 本用例只关心会话链接
  const h = await start({
    roots: [ROOT_AGENT],
    sessions: { s1: ROOT_AGENT.session },
    webServer: { host: '127.0.0.1', port: 3080 },
  })
  h.emit('session/event', ROOT_AGENT.session, {
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '带链接的完成' }] } },
  })
  h.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  h.advance(4000)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].url, /\/dnotify\/click\?t=[^&]+&target=session%3As1$/)
})

test('卸载时清理定时器、主题跟踪与 D-Bus 连接（effect 必须返回清理函数）', async () => {
  const h = await start()
  assert.ok(h.effects.length >= 1)
  // 每个 effect 的 setup 都必须返回清理函数；disposer 调完不抛异常
  for (const fn of h.effects) {
    const disposer = fn()
    assert.equal(typeof disposer, 'function', 'effect 必须返回清理函数')
    disposer()
  }
  for (const off of h.disposers) off()
})
