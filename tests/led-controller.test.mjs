// LED 控制器单测：把"宿主事实 → 判定 → 画面 → 串口帧"这条线整条跑一遍
//
// 为什么这层也要测：真正容易错的地方不是每个模块自己，而是**接线**——
// 服务取错了、字段名写错、判定的优先级反了，单元测试全绿但灯是错的。
// 这里用假 ctx（结构照 DSH 0.2.0-rc.2 的真实服务面）+ 假串口句柄，
// 断言"给定这些事实，最终写出去的 SCENE 帧长什么样"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLedController } from '../lib/led-controller.js'
import { createFrameParser, FRAME, LED_STATE_CODE, SCENE_FLAG } from '../lib/led-protocol.js'

const T0 = 1_000_000

/** 造一个假 ctx：只实现 led-controller 真正读的几个服务。 */
function harness(options = {}) {
  const written = []
  const opened = []
  const clock = { now: T0 }
  const fakeHandle = {
    write(bytes) { written.push(Buffer.from(bytes)); return bytes.length },
    read() { return Buffer.alloc(0) },
    close() { fakeHandle.closed += 1 },
    closed: 0,
  }
  const services = {
    agents: options.agents,
    jobs: options.jobs,
    sessionProjections: options.projections,
    sessions: options.sessions,
    goals: options.goals,
  }
  const ctx = { get: (name) => services[name] }
  let cfg = Object.assign({
    enabled: true, port: 'COM7', baud: 115200, brightness: 160, attention: true, idleOffMs: 120_000,
  }, options.config || {})
  // ⚠️ 必须区分"没传这个选项"与"传了 false"：前者=总是允许，后者=不许驱动
  const hasMayRun = Object.prototype.hasOwnProperty.call(options, 'mayRun')
  let mayRun = options.mayRun === true
  const controller = createLedController({
    ctx,
    config: () => cfg,
    log: () => {},
    lastFocusedAt: options.lastFocusedAt || (() => T0),   // 默认"人就在看"，避免提醒闩干扰
    open: async (port, baud) => { opened.push({ port, baud }); return fakeHandle },
    list: async () => [],
    now: () => clock.now,
    ...(hasMayRun ? { mayRun: () => mayRun } : {}),
  })
  /** 取出写出去的最后一帧 SCENE。 */
  const lastScene = () => {
    const parser = createFrameParser()
    const frames = written.flatMap((buf) => parser.push(buf)).filter((f) => f.type === FRAME.SCENE)
    return frames.length > 0 ? frames[frames.length - 1] : null
  }
  return {
    controller, clock, opened, written, lastScene,
    setConfig(patch) { cfg = Object.assign({}, cfg, patch) },
    setMayRun(value) { mayRun = value },
    handle: fakeHandle,
  }
}

/** 造一个根 agent（DSH 的 Agent 形状：id + session.header）。 */
function rootAgent(id, status = 'idle') {
  return { id, status, session: { id, header: { cwd: 'D:\\ws' } } }
}
/** 造一个子代理 agent（血缘靠 header.parentSession + origin==='subagent'）。 */
function subAgent(id, parent, status = 'running') {
  return { id, status, session: { id, header: { parentSession: parent, origin: 'subagent' } } }
}

test('agent 在跑 → SCENE 是 running（白，流动）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: (id) => (id === 's1' ? rootAgent('s1', 'running') : undefined),
  }
  const h = harness({ agents })
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  const frame = h.lastScene()
  assert.ok(frame, '应当写出 SCENE 帧')
  assert.equal(frame.payload[0], LED_STATE_CODE.running)
  assert.equal(h.opened.length, 1)
  assert.deepEqual(h.opened[0], { port: 'COM7', baud: 115200 })
})

test('没有任何未结算工作 → done（人不在看时带提醒位）', async () => {
  const agents = {
    roots: () => [rootAgent('s1')],
    list: () => [rootAgent('s1')],
    get: (id) => (id === 's1' ? rootAgent('s1') : undefined),
  }
  const h = harness({ agents, lastFocusedAt: () => 0 })   // 从未聚焦 = 人不在
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  const frame = h.lastScene()
  assert.equal(frame.payload[0], LED_STATE_CODE.done)
  assert.equal((frame.payload[1] & SCENE_FLAG.ATTENTION) !== 0, true, '人不在时应当一直提醒')
})

test('一轮结束但子代理还在跑 → 仍判 running（这是本功能的核心）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'idle')],
    list: () => [rootAgent('s1', 'idle'), subAgent('sub-1', 's1', 'running')],
    get: (id) => (id === 's1' ? rootAgent('s1', 'idle') : undefined),
  }
  const h = harness({ agents })
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  assert.equal(h.lastScene().payload[0], LED_STATE_CODE.running)
})

test('后台任务未结算 → running', async () => {
  const agents = {
    roots: () => [rootAgent('s1')],
    list: () => [rootAgent('s1')],
    get: (id) => (id === 's1' ? rootAgent('s1') : undefined),
  }
  const jobs = {
    list: () => ([
      { id: 'j1', owner: 's1', status: 'running' },
      { id: 'j2', owner: 's1', status: 'completed' },
    ]),
  }
  const h = harness({ agents, jobs })
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  assert.equal(h.lastScene().payload[0], LED_STATE_CODE.running)
})

test('inbox 里压着待处理输入（会被再次调起）→ running', async () => {
  const agents = {
    roots: () => [rootAgent('s1')],
    list: () => [rootAgent('s1')],
    get: (id) => (id === 's1' ? rootAgent('s1') : undefined),
  }
  const sessions = { get: (id) => (id === 's1' ? { id: 's1', header: {} } : undefined) }
  const projections = { stateOf: (session, key) => (key === 'inbox' ? { 'next-turn': [{}, {}], 'next-step': [] } : undefined) }
  const h = harness({ agents, sessions, projections })
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  assert.equal(h.lastScene().payload[0], LED_STATE_CODE.running)
})

test('有人等你回答（userQuestions 投影）→ waiting（黄）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: (id) => (id === 's1' ? rootAgent('s1', 'running') : undefined),
  }
  const sessions = { get: (id) => (id === 's1' ? { id: 's1', header: {} } : undefined) }
  const projections = {
    stateOf: (session, key) => (key === 'userQuestions' ? { questions: { active: [{ state: 'open' }] } } : undefined),
  }
  const h = harness({ agents, sessions, projections })
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  assert.equal(h.lastScene().payload[0], LED_STATE_CODE.waiting)
})

test('目标 blocked → waiting；目标 active 但没人跑 → running', async () => {
  const build = (phase) => {
    const agents = {
      roots: () => [rootAgent('s1')],
      list: () => [rootAgent('s1')],
      get: (id) => (id === 's1' ? rootAgent('s1') : undefined),
    }
    const goals = { get: () => ({ phase }) }
    return harness({ agents, goals })
  }
  const blocked = build('blocked')
  blocked.controller.refresh()
  await new Promise((r) => setImmediate(r))
  blocked.controller.refresh()
  assert.equal(blocked.lastScene().payload[0], LED_STATE_CODE.waiting)

  const active = build('active')
  active.controller.refresh()
  await new Promise((r) => setImmediate(r))
  active.controller.refresh()
  assert.equal(active.lastScene().payload[0], LED_STATE_CODE.running, 'active 目标会被 round-driver 再调起')
})

test('未接管的实例（热重载中的旧实例）绝不碰串口', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: (id) => (id === 's1' ? rootAgent('s1', 'running') : undefined),
  }
  const h = harness({ agents, mayRun: false })
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  assert.equal(h.opened.length, 0, '没接管就不该打开串口（串口是独占资源）')
  assert.equal(h.written.length, 0)

  h.setMayRun(true)
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  assert.equal(h.opened.length, 1, '接管之后才打开')
  assert.ok(h.lastScene())
})

test('灯带未启用 → 不开串口、不写字节（默认就是关的）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: (id) => (id === 's1' ? rootAgent('s1', 'running') : undefined),
  }
  const h = harness({ agents, config: { enabled: false } })
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  assert.equal(h.opened.length, 0)
  assert.equal(h.written.length, 0)
  assert.equal(h.controller.status().reason, 'disabled')
})

test('缺少 agents 服务时不点灯（分不清在跑还是跑完，宁可不给错信号）', async () => {
  const h = harness({})
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  assert.equal(h.opened.length, 0)
  assert.equal(h.controller.status().reason, 'no-agents-service')
})

test('noteError → 红灯（异常保鲜期内）', async () => {
  const agents = {
    roots: () => [rootAgent('s1')],
    list: () => [rootAgent('s1')],
    get: (id) => (id === 's1' ? rootAgent('s1') : undefined),
  }
  const h = harness({ agents, lastFocusedAt: () => 0 })
  h.controller.noteError('s1', '后台任务失败')
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  assert.equal(h.lastScene().payload[0], LED_STATE_CODE.error)
})

test('画面没变就不重复写（去重发生在链路层，这里确认端到端成立）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: (id) => (id === 's1' ? rootAgent('s1', 'running') : undefined),
  }
  const h = harness({ agents })
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < 5; i += 1) h.controller.refresh()
  const parser = createFrameParser()
  const scenes = h.written.flatMap((buf) => parser.push(buf)).filter((f) => f.type === FRAME.SCENE)
  assert.equal(scenes.length, 1, `steady 状态下只该写 1 帧，实际 ${scenes.length}`)
})

test('status() 回带每会话判定与链路信息（诊断端点就是它）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: (id) => (id === 's1' ? rootAgent('s1', 'running') : undefined),
  }
  const h = harness({ agents })
  h.controller.refresh()
  await new Promise((r) => setImmediate(r))
  h.controller.refresh()
  const status = h.controller.status()
  assert.equal(status.enabled, true)
  assert.equal(status.verdicts.length, 1)
  assert.equal(status.verdicts[0].sessionId, 's1')
  assert.equal(status.verdicts[0].phase, 'running')
  assert.match(status.verdicts[0].reasons.join(' '), /agent 正在运行/)
  assert.equal(status.link.state, 'ready')
  assert.ok(status.sceneText.includes('running'))
})
