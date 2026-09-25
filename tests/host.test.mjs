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
//   · connection.rpc.handle 两参签名 + {ok:true,value} / {ok:false,error{...}} 返回体
//   · 聚焦门控：正在看的会话静默、其它会话照常弹
//   · fs.resolve 异步返回后，工作区名前缀生效
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

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
  let rpcHandler = null

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
    return () => timers.delete(id)
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

  const ctx = {
    get: (name) => services[name],
    on,
    effect,
    timeout,
    provide: (name, value) => {
      services[name] = value
      return () => { delete services[name] }
    },
    inject: (deps, cb) => { injects.push({ deps, cb }) },
    connection: {
      rpc: {
        handle: (channel, handler) => {
          rpcHandler = { channel, handler }
          return () => { rpcHandler = null }
        },
      },
    },
  }
  return {
    ctx, sent, services, emit, advance, effects, disposers, injects,
    get rpcHandler() { return rpcHandler },
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
  const focus = await h.rpcHandler.handler('page-focus', { focused: true, pageId: 'p1', sessionId: 's1' })
  assert.deepEqual(focus, { ok: true, value: { pages: 1 } })

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

test('页面失焦后恢复推送；未知 endpoint 返回结构化错误', async () => {
  const h = await start({ roots: [ROOT_AGENT], sessions: { s1: ROOT_AGENT.session } })
  await h.rpcHandler.handler('page-focus', { focused: true, pageId: 'p1', sessionId: 's1' })
  await h.rpcHandler.handler('page-focus', { focused: false, pageId: 'p1' })
  const unknown = await h.rpcHandler.handler('nope', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'dnotify/unknown-endpoint')

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
  await h.rpcHandler.handler('page-focus', { focused: true, pageId: 'p1', sessionId: 's1' })
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
