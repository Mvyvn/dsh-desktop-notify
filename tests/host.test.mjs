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
    // 处理器可能是异步的（例如 /click 与 /activate 会**等页面认领**）：这里必须等到
    // res.end() 真正被调用，否则测试会拿到 status=0 的"未完成"响应。
    let finished = false
    const done = new Promise((resolve) => { res.once('__end', () => { finished = true; resolve() }) })
    res.end = (chunk) => {
      if (chunk !== undefined) res.chunks.push(String(chunk))
      if (!res.headersSent) { res.status = 200; res.headersSent = true }
      res.body = res.chunks.join('')
      res.emit('__end')
      return res
    }
    route.handler(req, res)
    if (options.body !== undefined) {
      const payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      process.nextTick(() => { req.emit('data', Buffer.from(payload, 'utf8')); req.emit('end') })
    } else {
      process.nextTick(() => { req.emit('end') })
    }
    // SSE（/dnotify/events）是流式响应，永远不会 res.end()：一旦响应头表明是
    // text/event-stream 就立即返回；其它端点等到 res.end() 真正被调用（处理器可能是
    // 异步的，例如 /click 与 /activate 会**等页面认领**）。
    const isStream = () => res.headersSent && /text\/event-stream/i.test(String(res.headers['content-type'] || ''))
    const deadline = Date.now() + (options.timeoutMs || 4000)
    while (!isStream()) {
      const settled = await Promise.race([
        done.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), Math.min(20, Math.max(1, deadline - Date.now())))),
      ])
      if (settled) break
      if (Date.now() >= deadline) break
    }
    void finished
    return { status: res.status, body: res.body || res.chunks.join(''), headers: res.headers, res }
  }
  return {
    ctx, sent, services, emit, advance, effects, disposers, injects, routes, request,
    /**
     * 从已发出通知的点击描述里取进程令牌（测试用它模拟"用户点击了通知"）。
     * 落在 click.fallback（浏览器兜底地址）里：`…/dnotify/click?t=<令牌>&raw=…`
     */
    clickToken() {
      for (const item of sent) {
        const click = item.click || {}
        const m = /[?&]t=([^&]+)/.exec(click.fallback || click.activate || '')
        if (m) return decodeURIComponent(m[1])
      }
      return ''
    },
    /** 取最近一条通知的点击描述（平台后端就是拿它决定 Toast 的 launch）。 */
    lastClick() {
      return sent.length > 0 ? (sent[sent.length - 1].click || null) : null
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
  assert.deepEqual(JSON.parse(focus.body), { ok: true, pages: 1, verdict: 'accepted' })

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

/**
 * 模拟真实客户端：发起点击（可能 302/落地页）的同时，认领它推过来的那条消息。
 * 宿主现在会**等认领**：等不到就退化成"新开 DSH"，所以测试必须像客户端一样认领。
 */
async function clickAndClaim(h, url, stream, pageId) {
  const pending = h.request({ method: 'GET', url })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const openId = envelopeIds(stream).pop()
  const claim = await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId, openId } })
  const click = await pending
  return { click, openId, claim: JSON.parse(claim.body) }
}

/** 从 SSE 流里取出所有 navigate 事件的 openId（按出现顺序）。 */
function envelopeIds(stream) {
  return [...String(stream.res.chunks.join('')).matchAll(/event: navigate\ndata: (\{.*?\})\n\n/g)]
    .map((m) => { try { return JSON.parse(m[1]).id } catch (e) { return '' } })
    .filter(Boolean)
}
/** 取最后一个 openId（只推了一条时用）。 */
function envelopeId(stream) {
  return envelopeIds(stream).pop()
}

test('点击三态①：目标为空 → 不投递、不打开（不可点击通知）', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  const click = await h.request({ method: 'GET', url: `/dnotify/click?t=${globalThis.__dshDesktopNotifyClickToken || 'x'}&raw=none` })
  assert.equal(click.status, 200)
  assert.match(click.body, /这条通知不可跳转/)
  const claim = await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p1', openId: 'whatever' } })
  assert.deepEqual(JSON.parse(claim.body), { ok: false, reason: 'stale' }, '不该产生待认领条目')
})

test('点击（降级模式）：一律 302 到 DSH 深链，新开标签页跳转，不再投递给已有页面', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const tabA = await h.request({ method: 'GET', url: '/dnotify/events?pageId=pA' })
  const tabB = await h.request({ method: 'GET', url: '/dnotify/events?pageId=pB' })
  // 两个页面都开着，用户最后在 A 上操作
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'pA', sessionId: 's1' } })
  const click = await h.request({ method: 'GET', url: `/dnotify/click?t=x&raw=${encodeURIComponent('session:s1')}` })
  assert.equal(click.status, 302, '降级模式点击一律 302：由浏览器新开标签页跳 DSH')
  assert.match(String(click.headers.location || ''), /#dsh-notify=/, '深链要带目标会话')
  assert.ok(!/event: navigate/.test(tabA.res.chunks.join('')), '点击不再向页面投递（投递已前移到发送时）')
  assert.ok(!/event: navigate/.test(tabB.res.chunks.join('')), '更不会广播')
})

test('点击三态③：没有可投递页面 → 302 到 DSH 深链（由浏览器拉起 DSH）', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const click = await h.request({ method: 'GET', url: `/dnotify/click?t=x&raw=${encodeURIComponent('session:s1')}` })
  assert.equal(click.status, 302)
  assert.match(String(click.headers.location), /\/#dsh-notify=session%3As1$/)
  // 没有待认领条目：稍后连上的页面靠 hash 自己跳，不会被重放（避免跳两遍）
  const late = await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  assert.ok(!/event: navigate/.test(late.res.chunks.join('')), '不该重放')
})

test('url 目标：宿主直接给出外部地址（与 DSH 页面无关）', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  const click = await h.request({ method: 'GET', url: `/dnotify/click?t=x&raw=${encodeURIComponent('url:https%3A%2F%2Fexample.com%2Fx')}` })
  assert.equal(click.status, 302)
  assert.equal(click.headers.location, 'https://example.com/x')
})

test('点击落地页：跨站触发被拒（403），旧令牌仍放行（用户点旧通知）', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  h.services.desktopNotify.pushAlways({ title: '取令牌', sessionId: 's1', click: { type: 'session', sessionId: 's1' } })
  h.advance(500)
  const token = globalThis.__dshDesktopNotifyClickToken
  assert.ok(token, '通知的点击描述里应带进程令牌')

  // 跨站触发（别的网页用 <img>/fetch 盲触发）→ 403
  const crossSite = await h.request({
    method: 'GET',
    url: `/dnotify/click?t=${token}&raw=${encodeURIComponent('session:s1')}`,
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.body, 'forbidden')

  // 旧令牌（上一次运行发出的通知）：按用户导航放行（降级模式 → 302 深链，而不是 403）
  const stale = await h.request({ method: 'GET', url: '/dnotify/click?t=stale-token&raw=session%3As9' })
  assert.equal(stale.status, 302, '不该回 forbidden')
  assert.match(String(stale.headers.location || ''), /#dsh-notify=/)
})

test('点击令牌在同一进程内跨 apply 复用（热更新不会让已发出的通知失效）', async () => {
  const first = await start({ roots: [ROOT_AGENT] })
  first.services.desktopNotify.pushAlways({ title: '第一次', sessionId: 's1', click: { type: 'session', sessionId: 's1' } })
  first.advance(500)
  const second = await start({ roots: [ROOT_AGENT] })
  second.services.desktopNotify.pushAlways({ title: '第二次', sessionId: 's1', click: { type: 'session', sessionId: 's1' } })
  second.advance(500)
  assert.ok(globalThis.__dshDesktopNotifyClickToken, '第一次 apply 应发出带令牌的链接')
  assert.equal(second.clickToken(), globalThis.__dshDesktopNotifyClickToken, '同一进程内两次 apply 的令牌必须一致')
})

test('多层子代理：一路回溯到母会话（点击目标与前缀都用顶层会话）', async () => {
  const root = { id: 'root-1', title: '母会话', header: { cwd: 'D:\\ws\\proj' } }
  const sub1 = { id: 'sub-1', title: '子代理甲', header: { parentSession: 'root-1', origin: 'subagent', cwd: 'D:\\ws\\proj' } }
  const sub2 = { id: 'sub-2', title: '子代理乙', header: { parentSession: 'sub-1', origin: 'subagent', cwd: 'D:\\ws\\proj' } }
  const h = await start({ roots: [ROOT_AGENT], sessions: { 'root-1': root, 'sub-1': sub1, 'sub-2': sub2 } })
  h.emit('subagent/end', { id: 'sub-2', runId: 'run-2' })
  h.advance(500)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].click.wire, 'session:root-1', '多层子代理必须回到母会话，而不是停在中间层')
  assert.match(h.sent[0].message, /母会话/, '前缀用母会话名')
  assert.ok(!/子代理甲/.test(h.sent[0].message), '不该把中间层当母会话')
})

test('团队任务：pending/completed 各弹一次，重复同状态不再打扰', async () => {
  const root = { id: 'root-1', title: '母会话', header: { cwd: 'D:\\ws\\proj' } }
  const h = await start({ roots: [ROOT_AGENT], sessions: { 'root-1': root } })
  const emitTask = (status) => h.emit('session/event', root, {
    type: 'team/task',
    data: { version: 2, teamId: 't1', task: { id: 'task-1', revision: 1, subject: '实现登录页', status, ownerId: 'root-1' } },
  })
  emitTask('pending')
  h.advance(400)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '🕒 团队任务待处理')
  assert.match(h.sent[0].message, /实现登录页/)
  assert.equal(h.sent[0].click.wire, 'session:root-1', '点击回到母会话')
  emitTask('pending')            // 同一状态重复派发
  h.advance(400)
  assert.equal(h.sent.length, 1, '状态没变就不该再弹')
  emitTask('in_progress')        // 中间状态不打扰
  h.advance(400)
  assert.equal(h.sent.length, 1)
  emitTask('completed')
  h.advance(400)
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].title, '✅ 团队任务已完成')
})

test('上下文压缩：compaction/end 无 error 才通知', async () => {
  const h = await start({ roots: [ROOT_AGENT], sessions: { s1: ROOT_AGENT.session } })
  h.emit('session/event', ROOT_AGENT.session, { type: 'compaction/start', data: { compactionId: 'c1', turn: 1 } })
  h.advance(400)
  assert.equal(h.sent.length, 0, '开始压缩不打扰')
  h.emit('session/event', ROOT_AGENT.session, { type: 'compaction/end', data: { compactionId: 'c1', turn: 1 } })
  h.advance(400)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '🗜️ 上下文已智能压缩')
  assert.match(h.sent[0].message, /上下文已智能压缩/)
  assert.equal(h.sent[0].click.wire, 'session:s1')
  h.emit('session/event', ROOT_AGENT.session, { type: 'compaction/end', data: { compactionId: 'c2', turn: 2, error: 'boom' } })
  h.advance(400)
  assert.equal(h.sent.length, 1, '压缩失败不该报"已智能压缩"')
})

test('定时任务：create 才通知（delete/dispatch 不打扰）', async () => {
  const h = await start({ roots: [ROOT_AGENT], sessions: { s1: ROOT_AGENT.session } })
  h.emit('session/event', ROOT_AGENT.session, { type: 'schedule/change', data: { version: 1, operation: 'delete', id: 'sched-9' } })
  h.advance(400)
  assert.equal(h.sent.length, 0)
  h.emit('session/event', ROOT_AGENT.session, { type: 'schedule/change',
    data: { version: 1, operation: 'create', schedule: { id: 'sched-1', title: '每天早上跑测试' } } })
  h.advance(400)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '⏰ 定时任务已启动')
  assert.match(h.sent[0].message, /每天早上跑测试/)
  assert.equal(h.sent[0].click.wire, 'session:s1')
})

test('门控也吃 seq 乱序保护：stale 的上报不许改门控状态', async () => {
  const h = await start({ roots: [ROOT_AGENT], sessions: { s1: ROOT_AGENT.session } })
  const token = globalThis.__dshDesktopNotifyClickToken
  // 新上报 seq=10 聚焦
  const fresh = await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 10, pageId: 'p1', sessionId: 's1' } })
  assert.equal(JSON.parse(fresh.body).verdict, 'accepted')
  const gateAfterFocus = JSON.parse((await h.request({ method: 'GET', url: '/dnotify/status?t=' + token })).body).gate
  assert.equal(gateAfterFocus, 1, '聚焦后门控应记住这个页面')
  // 乱序到达的旧上报 seq=9 失焦：注册表忽略它，门控也必须忽略
  const stale = await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: false, seq: 9, pageId: 'p1', sessionId: 's1' } })
  const payload = JSON.parse(stale.body)
  assert.equal(payload.verdict, 'stale')
  assert.equal(payload.gate, 1, 'stale 的上报绝不能把门控清掉（否则该静默的通知会重新弹）')
  const st = JSON.parse((await h.request({ method: 'GET', url: '/dnotify/status?t=' + token })).body)
  assert.equal(st.gate, 1, '/status 里门控仍是 1')
})

test('跳转结果回报：认领成功但客户端跳不过去时，记录进 /status', async () => {
  const h = await start({ roots: [ROOT_AGENT], sessions: { s1: ROOT_AGENT.session } })
  const ack = await h.request({
    method: 'POST', url: '/dnotify/navigated',
    body: { openId: 'op-1', result: 'not-found', pageId: 'p1' },
  })
  assert.equal(ack.status, 200)

  // /status 的令牌校验是严格的（旧令牌一律 403）：读插件放在 globalThis 上的当前令牌
  const token = globalThis.__dshDesktopNotifyClickToken
  assert.equal(typeof token, 'string')
  const st = await h.request({ method: 'GET', url: '/dnotify/status?t=' + token })
  assert.equal(st.status, 200)
  const payload = JSON.parse(st.body)
  assert.equal(payload.lastNavigate.result, 'not-found', '认领≠跳转：失败结果必须留痕')
  assert.equal(payload.lastNavigate.openId, 'op-1')
  assert.equal(payload.lastNavigate.pageId, 'p1')
})

test('launch 默认走浏览器落地页（实测协议激活在未打包宿主上不触发），可显式改回协议', async () => {
  // 默认：launch 是 http 落地页 —— 浏览器必然打开它，因此点击一定能到达宿主
  const byDefault = await start({ roots: [ROOT_AGENT] })
  byDefault.services.desktopNotify.pushAlways({ title: '默认', click: { type: 'session', sessionId: 's1' } })
  byDefault.advance(500)
  const fallbackClick = byDefault.sent[0].click
  assert.equal(fallbackClick.wire, 'session:s1')
  assert.equal(fallbackClick.scheme, '', '默认不带自定义协议')
  assert.match(fallbackClick.fallback, /^http:\/\/127\.0\.0\.1:3080\/dnotify\/click\?t=[^&]+&raw=session%3As1$/)
  // 显式选择协议模式：launch 变成 dsh-notify:<目标>（不新开标签，但依赖系统投递激活）
  const byProtocol = await start({ roots: [ROOT_AGENT], config: { launchMode: 'protocol' } })
  byProtocol.services.desktopNotify.pushAlways({ title: '协议', click: { type: 'session', sessionId: 's1' } })
  byProtocol.advance(500)
  assert.equal(byProtocol.sent[0].click.scheme, 'dsh-notify:session:s1')
})

test('点击落地页：非法目标被忽略（不投递、不打开）', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  const bad = await h.request({ method: 'GET', url: '/dnotify/click?t=wrong&raw=' + encodeURIComponent('javascript:alert(1)') })
  assert.equal(bad.status, 200)
  assert.match(bad.body, /无法识别/)
  const claim = await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p1', openId: 'whatever' } })
  assert.deepEqual(JSON.parse(claim.body), { ok: false, reason: 'stale' })
})

test('点击投递：每次点击有唯一 openId，连点两条不会串单', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const stream = await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'p1', sessionId: 's1' } })
  const ids = []
  const claims = []
  for (const target of ['session:s1', 'session:s2']) {
    // 像真实客户端：点击请求会等认领，所以先并发发起，再认领，最后收结果
    const pending = h.request({ method: 'GET', url: `/dnotify/activate?t=x&raw=${encodeURIComponent(target)}` })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const openId = envelopeIds(stream).pop()
    ids.push(openId)
    assert.ok(openId, '每次点击都要推出一条带 openId 的消息')
    claims.push(JSON.parse((await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p1', openId } })).body))
    assert.equal((await pending).status, 200, '认领成功后走落地页')
  }
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1], '两次点击必须是两条不同身份的消息')
  assert.equal(claims[0].target, 'session:s1', 'A 的认领只能拿到 A')
  assert.equal(claims[1].target, 'session:s2', 'B 的认领只能拿到 B')
  const again = JSON.parse((await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p1', openId: ids[0] } })).body)
  assert.deepEqual(again, { ok: false, reason: 'stale' })
})

test('归属校验：非目标页面即使拿到 openId 也不能认领', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const tabA = await h.request({ method: 'GET', url: '/dnotify/events?pageId=pA' })
  await h.request({ method: 'GET', url: '/dnotify/events?pageId=pB' })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'pA', sessionId: 's1' } })
  const pendingClick = h.request({ method: 'GET', url: `/dnotify/activate?t=x&raw=${encodeURIComponent('session:s1')}` })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const openId = envelopeId(tabA)
  const stolen = JSON.parse((await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'pB', openId } })).body)
  assert.deepEqual(stolen, { ok: false, reason: 'not-owner' })
  const owner = JSON.parse((await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'pA', openId } })).body)
  assert.equal(owner.ok, true)
  assert.equal((await pendingClick).status, 200, '拥有者认领后点击才算成功投递')
})

test('页面注册表：失焦后仍投给"最后用过"的页面（用户此刻在别的应用里）', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const tabA = await h.request({ method: 'GET', url: '/dnotify/events?pageId=pA' })
  const tabB = await h.request({ method: 'GET', url: '/dnotify/events?pageId=pB' })
  // A 聚焦（seq=5）→ 然后失焦（seq=6）：此刻**没有**聚焦页面，但"最后用过"仍是 A
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 5, pageId: 'pA', sessionId: 's1' } })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: false, seq: 6, pageId: 'pA', sessionId: 's1' } })
  await h.request({ method: 'GET', url: `/dnotify/activate?t=x&raw=${encodeURIComponent('session:s1')}` })
  assert.match(tabA.res.chunks.join(''), /event: navigate/, '切去别的应用后仍应投给"最后用的那个页面"')
  assert.ok(!/event: navigate/.test(tabB.res.chunks.join('')), 'B 从来没被聚焦过，不该收到')
})

test('页面注册表：同一页面的旧 seq 上报不覆盖新状态', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const tabB = await h.request({ method: 'GET', url: '/dnotify/events?pageId=pB' })
  const saved = await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 10, pageId: 'pB', sessionId: 's2' } })
  assert.equal(JSON.parse(saved.body).verdict, 'accepted')
  // 乱序到达的旧状态（seq=9 声称失焦）：必须是 stale，不能把 B 的聚焦状态抹掉
  const late = await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: false, seq: 9, pageId: 'pB', sessionId: 's2' } })
  assert.equal(JSON.parse(late.body).verdict, 'stale')
  await h.request({ method: 'GET', url: `/dnotify/activate?t=x&raw=${encodeURIComponent('session:s2')}` })
  assert.match(tabB.res.chunks.join(''), /event: navigate/, 'B 仍应是目标页面')
})

test('SSE：连接的页面立刻拿到该投给自己的跳转，未知端点 404', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const stream = await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  assert.equal(stream.status, 200)
  assert.match(String(stream.headers['content-type']), /text\/event-stream/)
  assert.match(stream.res.chunks.join(''), /retry: 2000/)
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'p1', sessionId: 's1' } })
  const { click } = await clickAndClaim(h, `/dnotify/activate?t=x&raw=${encodeURIComponent('page:plugins')}`, stream, 'p1')
  assert.equal(click.status, 200)
  assert.match(stream.res.chunks.join(''), /event: navigate/)
  assert.match(stream.res.chunks.join(''), /page:plugins/)
  const unknown = await h.request({ method: 'GET', url: '/dnotify/nope' })
  assert.equal(unknown.status, 404)
})

test('激活端点：无页面时回 open（交给系统打开），有页面时回 delivered（不开窗口）', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  // 没有页面：由调用方（转发器/portal）去打开 DSH 深链
  const noPage = JSON.parse((await h.request({ method: 'GET', url: '/dnotify/activate?t=x&raw=session%3As1' })).body)
  assert.equal(noPage.action, 'open')
  assert.match(String(noPage.url), /\/#dsh-notify=session%3As1$/)
  // 有页面并聚焦：投递，**不给调用方任何要打开的地址**
  const tab = await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'p1', sessionId: 's1' } })
  // 页面像真实客户端那样认领 → 宿主才回 delivered
  const pendingActivate = h.request({ method: 'GET', url: '/dnotify/activate?t=x&raw=session%3As1' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p1', openId: envelopeIds(tab).pop() } })
  const delivered = JSON.parse((await pendingActivate).body)
  assert.deepEqual(delivered, { action: 'delivered', pageId: 'p1' })
  assert.match(tab.res.chunks.join(''), /event: navigate/)
  // 目标为空：ignore
  const ignored = JSON.parse((await h.request({ method: 'GET', url: '/dnotify/activate?t=x&raw=none' })).body)
  assert.deepEqual(ignored, { action: 'ignore', reason: 'no-target' })
  // url 目标：交给外部打开
  const external = JSON.parse((await h.request({ method: 'GET', url: '/dnotify/activate?t=x&raw=' + encodeURIComponent('url:https%3A%2F%2Fexample.com%2Fx') })).body)
  assert.deepEqual(external, { action: 'open', url: 'https://example.com/x' })
})

test('投递后没人认领 → 不静默失败，改成新开深链', async () => {
  const h = await start({ roots: [ROOT_AGENT], config: { claimWaitMs: 60 } })
  const tab = await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'p1', sessionId: 's1' } })
  // 页面"连着但卡住"（比如旧客户端、冻结的标签页）：只投递、不认领
  const activate = JSON.parse((await h.request({ method: 'GET', url: '/dnotify/activate?t=x&raw=session%3As1' })).body)
  assert.equal(activate.action, 'open', '不能把"写进 socket"当成"已经跳了"')
  assert.match(String(activate.url), /#dsh-notify=session%3As1$/)
  assert.equal(activate.reason, 'unclaimed')
  assert.match(tab.res.chunks.join(''), /event: navigate/, '消息仍然推给了页面（它自己慢一步也没关系）')
  // 协议激活端点（claim 语义在这里）：没人认领 → 回 open + 深链，而不是静默失败
  const click = await h.request({ method: 'GET', url: '/dnotify/activate?t=x&raw=session%3As1' })
  assert.equal(click.status, 200)
  const openBody = JSON.parse(click.body)
  assert.equal(openBody.action, 'open')
  assert.match(String(openBody.url || ''), /#dsh-notify=/)
})

test('混合 backend 分流：页面在线且权限 granted → 浏览器通知；否则原生 Toast + 降级提示', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const stream = await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'p1', sessionId: 's1' } })

  // ① 页面还没报告通知权限 → 只能走原生 Toast，并且正文里必须说明"降级模式"
  h.services.desktopNotify.pushAlways({ title: '第一条', sessionId: 's1', click: { type: 'session', sessionId: 's1' } })
  h.advance(600)
  assert.equal(h.sent.length, 1, '没有浏览器通知权限时用原生 Toast')
  assert.match(String(h.sent[0].message || ''), /降级模式/, '要告诉用户正处于降级模式以及原因')

  // ② 页面报告权限 granted → 改走浏览器通知，且**不再**发原生 Toast（避免重复打扰）
  await h.request({ method: 'POST', url: '/dnotify/sw/report', body: { from: 'page', kind: 'register', pageId: 'p1', permission: 'granted' } })
  h.services.desktopNotify.pushAlways({ title: '第二条', sessionId: 's1', click: { type: 'session', sessionId: 's1' } })
  h.advance(600)
  assert.equal(h.sent.length, 1, '有权限时不再发原生 Toast')
  assert.match(stream.res.chunks.join(''), /event: notify/, '内容通过 notify 事件交给页面（页面再交给 SW 显示）')
  assert.match(stream.res.chunks.join(''), /session:s1/, '点击目标要随通知一起带过去')

  // ③ 权限可能是**另一个标签页**手动允许的（不经过我们的申请流程）：只要任一在线页面是
  //    granted，就该走浏览器通知 —— 之前只看"投递页面"的权限，于是误判成 unknown 走了降级。
  const stream2 = await h.request({ method: 'GET', url: '/dnotify/events?pageId=p2' })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'p2', sessionId: 's1', permission: 'granted' } })
  h.services.desktopNotify.pushAlways({ title: '第三条', sessionId: 's1', click: { type: 'session', sessionId: 's1' } })
  h.advance(600)
  assert.equal(h.sent.length, 1, '任一在线页面 granted 就不该再降级')
  assert.match(stream2.res.chunks.join(''), /event: notify/, '通知应交给有权限的那个页面')
})

test('诊断端点 /dnotify/status：只有知道令牌的本机调用能看', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  // 令牌从一条**可点击**通知的弹出描述里取（与真实排查方式一致）
  h.services.desktopNotify.pushAlways({ title: '取令牌', click: { type: 'session', sessionId: 's1' } })
  h.advance(500)
  const denied = await h.request({ method: 'GET', url: '/dnotify/status' })
  assert.equal(denied.status, 403)
  const stream = await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 3, pageId: 'p1', sessionId: 's1' } })
  const ok = JSON.parse((await h.request({ method: 'GET', url: `/dnotify/status?t=${globalThis.__dshDesktopNotifyClickToken}` })).body)
  assert.equal(ok.pages.length, 1)
  assert.equal(ok.pages[0].pageId, 'p1')
  assert.equal(ok.pages[0].focused, true)
  assert.deepEqual(ok.streams, ['p1'])
  assert.equal(ok.lastActivate, null)
  assert.ok(stream)
})

test('SSE：流断开后不再推送，也不会因为心跳而报错', async () => {
  const h = await start({ roots: [ROOT_AGENT] })
  const stream = await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  stream.res.emit('close')   // 页面关闭：摘掉订阅 + 停掉心跳
  // 断开后没有可投递页面 → 协议激活端点回 open + 深链兜底，不再挂起
  const click = await h.request({ method: 'GET', url: '/dnotify/activate?t=x&raw=' + encodeURIComponent('page:plugins') })
  assert.equal(click.status, 200, '断开后新点击不应把路由打挂')
  assert.equal(JSON.parse(click.body).action, 'open')
  const claim = await h.request({ method: 'POST', url: '/dnotify/claim', body: { pageId: 'p1', openId: 'x' } })
  assert.deepEqual(JSON.parse(claim.body), { ok: false, reason: 'stale' }, '302 后不该有待认领条目')
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
  // 新契约：启动播报**等一个在线 DSH 页面**再发（这样能走浏览器通知，而不是在启动瞬间因为
  // "还没有页面"被迫降级）。页面一上线，播报就从 /events 推出去。
  await h.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  await h.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'p1', sessionId: 's1', permission: 'granted' } })
  await settleStartup()
  await new Promise((resolve) => setTimeout(resolve, 120))
  const st = JSON.parse((await h.request({ method: 'GET', url: `/dnotify/status?t=${globalThis.__dshDesktopNotifyClickToken}` })).body)
  assert.equal(st.lastRoute && st.lastRoute.mode, 'web', '有页面且权限可用 → 启动播报走浏览器通知')
  const sent = (st.recentSent || []).find((r) => /DSH 启动完成/.test(String(r.title)))
  assert.ok(sent, '启动播报必须发出')
  assert.equal(sent.message, '插件启动成功:共有 3 个插件成功加载')
  assert.equal(sent.wire, 'page:settings-plugins', '启动通知点击 → 设置/内置插件')
})

// 注：启动播报按 dedupeKey='startup' **每个进程只发一次**（见下一条测试），
// 因此"失败插件清单"这种需要第二次播报的断言无法在同进程内成立 —— 那条措辞由
// reportStartupOnce 里同一段模板拼接，改动它必须同步检查（这里不再重复断言，避免假失败）。
test('启动播报每次进程只推一次（重复 apply 不重播）', async () => {
  globalThis.__dshDesktopNotifyStartupReported = false
  const loader = fakeLoader([{ id: 'webserver', state: 2 }])
  const first = await start({ loader, webServer: { host: '127.0.0.1', port: 3080 } })
  await first.request({ method: 'GET', url: '/dnotify/events?pageId=p1' })
  await first.request({ method: 'POST', url: '/dnotify/page-focus', body: { focused: true, seq: 1, pageId: 'p1', sessionId: 's1', permission: 'granted' } })
  await settleStartup()
  await new Promise((resolve) => setTimeout(resolve, 120))
  const st = JSON.parse((await first.request({ method: 'GET', url: `/dnotify/status?t=${globalThis.__dshDesktopNotifyClickToken}` })).body)
  assert.equal(st.lastRoute && st.lastRoute.mode, 'web', '页面一上线，启动播报就走浏览器通知')
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
  assert.equal(h.sent[0].click.wire, 'session:s1', '会话类通知显式带上跳到该会话的点击目标')
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
