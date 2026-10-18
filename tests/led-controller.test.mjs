// LED 控制器单测：把"宿主事实 → 判定 → 画面 → 像素 → 串口帧"整条线跑一遍
//
// 真正容易错的地方不是每个模块自己，而是**接线**：服务取错了、字段名写错、优先级反了，
// 单元测试全绿但灯是错的。这里用假 ctx（结构照 DSH 0.2.0-rc.2 的真实服务面）+ 假串口句柄，
// 断言"给定这些事实，最终写出去的 26 字节 LEDS 帧长什么样"。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLedController } from '../lib/led-controller.js'
import { MODE, VERIFY_REPLY, LED_COUNT } from '../lib/led-protocol.js'
import { SCENE_FLAG } from '../lib/led-scene.js'

const T0 = 1_000_000
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 造一个假 ctx：只实现 led-controller 真正读的几个服务。 */
function harness(options = {}) {
  const written = []
  const opened = []
  const clock = { now: T0 }
  let reply = Buffer.from(VERIFY_REPLY, 'ascii')
  const fakeHandle = {
    write(bytes) { written.push(Buffer.from(bytes)); return bytes.length },
    read() { const out = reply; reply = Buffer.alloc(0); return out },
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
    enabled: true, port: 'COM7', brightness: 160, buzzer: true, attention: true, idleOffMs: 120_000,
  }, options.config || {})
  const hasMayRun = Object.prototype.hasOwnProperty.call(options, 'mayRun')
  let mayRun = options.mayRun === true
  const controller = createLedController({
    ctx,
    config: () => cfg,
    log: () => {},
    lastFocusedAt: options.lastFocusedAt || (() => T0),
    open: async (port, baud) => { opened.push({ port, baud }); return fakeHandle },
    list: options.list || (async () => [{ path: 'COM7', label: '' }]),
    now: () => clock.now,
    frameMs: 40,
    ...(hasMayRun ? { mayRun: () => mayRun } : {}),
  })
  /** 走几次采样，让「枚举 → 打开 → 握手 → 出帧」整条链落地。 */
  async function settle(times = 4) {
    for (let i = 0; i < times; i += 1) {
      controller.refresh()
      await flush()
    }
  }
  /** 最近一帧 LEDS 帧解出来的像素。 */
  const lastPixels = () => {
    const frame = [...written].reverse().find((buf) => buf.length === 26 && buf[2] === MODE.LEDS)
    if (!frame) return null
    const out = []
    for (let i = 0; i < LED_COUNT; i += 1) out.push({ r: frame[3 + i * 3], g: frame[4 + i * 3], b: frame[5 + i * 3] })
    return out
  }
  const modes = () => written.map((buf) => buf[2])
  return {
    controller, clock, opened, written, settle, lastPixels, modes,
    setConfig(patch) { cfg = Object.assign({}, cfg, patch) },
    setMayRun(value) { mayRun = value },
    handler: fakeHandle,
  }
}

function rootAgent(id, status) {
  return {
    id, status,
    session: { id, header: {} },
    origin: 'user',
  }
}

test('有会话在跑 → 推 LEDS 帧，且颜色属于"运行中"（冷白）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  assert.equal(h.opened.length, 1, '应当打开串口')
  assert.equal(h.opened[0].baud, 115200, '波特率由固件固定')
  const pixels = h.lastPixels()
  assert.ok(pixels, '应当写出 26 字节 LEDS 帧')
  assert.equal(pixels.length, 7)
  const lit = pixels.filter((p) => p.r + p.g + p.b > 0)
  assert.ok(lit.length > 0, '运行中必须有灯亮')
  const head = lit.reduce((a, b) => (a.r + a.g + a.b > b.r + b.g + b.b ? a : b))
  assert.ok(head.b > 0 && head.r > 0, `冷白/白：${JSON.stringify(head)}`)
})

test('灯带未启用 → 不开串口、不写字节', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents, config: { enabled: false } })
  await h.settle()
  assert.equal(h.opened.length, 0)
  assert.equal(h.written.length, 0)
})

test('未接管的实例（热重载中的旧实例）绝不碰串口', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents, mayRun: false })
  await h.settle()
  assert.equal(h.opened.length, 0, '没接管就不该打开串口（串口是独占资源）')
  h.setMayRun(true)
  await h.settle()
  assert.equal(h.opened.length, 1, '接管之后才打开')
})

test('没有串口设备 → 不驱动、不尝试打开，并如实回报 devicePresent=false', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents, list: async () => [] })
  await h.settle()
  assert.equal(h.controller.status().devicePresent, false)
  assert.deepEqual(h.controller.status().ports, [])
  assert.equal(h.opened.length, 0)
  assert.equal(h.written.length, 0)
})

test('缺 agents 服务 → 不点灯（分不清在跑还是跑完，宁可不给错信号）', async () => {
  const h = harness({ agents: undefined })
  await h.settle()
  assert.equal(h.written.filter((b) => b[2] === MODE.LEDS).length, 0)
})

test('会话完成 + 人不在 → ATTENTION（提醒中），并响一声蜂鸣器', async () => {
  const done = { phase: 'done', reasons: ['回合结束且没有未结算工作'] }
  const agents = {
    roots: () => [rootAgent('s1', 'idle')],
    list: () => [rootAgent('s1', 'idle')],
    get: () => rootAgent('s1', 'idle'),
  }
  // lastFocusedAt 很旧 → 人不在
  const h = harness({ agents, lastFocusedAt: () => T0 - 10 * 60_000 })
  await h.settle()
  const scene = h.controller.status().scene
  assert.equal(scene.state, 'done')
  assert.equal((scene.flags & SCENE_FLAG.ATTENTION) !== 0, true, `应当是"提醒中"：${JSON.stringify(scene)}`)
  await h.settle()
  if (process.env.LED_DEBUG) console.log('[dbg] modes=', JSON.stringify(h.modes()), 'link=', JSON.stringify(h.controller.status().link))
  assert.equal(h.modes().includes(MODE.BUZZER), true, '状态跳到"完成"时应当响一声')
  assert.ok(h.controller.status().scene.latched)
})

test('人回来了 → 提醒解除（不再 ATTENTION）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'idle')], list: () => [rootAgent('s1', 'idle')], get: () => rootAgent('s1', 'idle') }
  let focusedAt = T0 - 10 * 60_000
  const h = harness({ agents, lastFocusedAt: () => focusedAt })
  await h.settle()
  assert.equal((h.controller.status().scene.flags & SCENE_FLAG.ATTENTION) !== 0, true)
  focusedAt = h.clock.now
  h.controller.refresh()
  assert.equal((h.controller.status().scene.flags & SCENE_FLAG.ATTENTION) !== 0, false)
  assert.equal(h.controller.status().scene.latched, false)
})

test('蜂鸣器关掉后不再响（设置页开关真的生效）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'idle')], list: () => [rootAgent('s1', 'idle')], get: () => rootAgent('s1', 'idle') }
  const h = harness({ agents, lastFocusedAt: () => T0 - 10 * 60_000, config: { buzzer: false } })
  await h.settle()
  assert.equal(h.modes().includes(MODE.BUZZER), false)
})

test('status() 回带链路、判定与设备信息（诊断端点就是它）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  const status = h.controller.status()
  assert.equal(status.enabled, true)
  assert.equal(status.verdicts.length, 1)
  assert.equal(status.verdicts[0].sessionId, 's1')
  assert.equal(status.verdicts[0].phase, 'running')
  assert.equal(status.link.state, 'ready', '握手通过后链路应当是 ready')
  assert.equal(status.link.verified, true)
  assert.equal(status.devicePresent, true)
  assert.deepEqual(status.device, { leds: 7, verified: true })
  assert.match(status.sceneText, /running/)
})

test('preview() 直接改画面（不经过判定），下一帧就渲染出来', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  h.written.length = 0
  assert.equal(h.controller.preview('error', 255), true)   // preview 自己就会触发一帧
  const pixels = h.lastPixels()
  assert.ok(pixels, 'preview 之后应当写出 LEDS 帧')
  const lit = pixels.find((p) => p.r + p.g + p.b > 0)
  assert.ok(lit && lit.r > lit.g && lit.r > lit.b, `preview(error) 应当是红色：${JSON.stringify(lit)}`)
})

test('提示音要柔和：频率 440~1200Hz、音量 ≤55（不刺耳但听得见）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'idle')], list: () => [rootAgent('s1', 'idle')], get: () => rootAgent('s1', 'idle') }
  const h = harness({ agents, lastFocusedAt: () => T0 - 10 * 60_000 })
  await h.settle()
  const beeps = h.written.filter((b) => b[2] === MODE.BUZZER)
  assert.ok(beeps.length >= 1, '完成时应当响')
  for (const frame of beeps) {
    const freq = frame[3] | (frame[4] << 8)
    const volume = frame[5]
    assert.ok(freq >= 440 && freq <= 1200, `频率 ${freq}Hz 太尖或太低`)
    assert.ok(volume > 0 && volume <= 55, `音量 ${volume} 不合适`)
  }
})

test('sendFrame 只放行真固件的三个 MODE，其余拒绝', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  assert.equal(h.controller.sendFrame(0x03, []), false, '未知 MODE 必须拒绝')
  assert.equal(h.controller.sendFrame(MODE.VERIFY, []), true)
  assert.equal(h.controller.sendFrame(MODE.BUZZER, [0xe8, 0x03, 50, 0x64, 0x00]), true)
})
