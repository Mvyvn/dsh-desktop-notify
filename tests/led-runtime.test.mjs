// 灯运行时单测（inline：不 spawn worker）—— 验"时间驱动"这一层本身。
//
// 为什么单独一个文件：帧循环已经从控制器搬到了 led-runtime.ts，而它现在要能在
// **任意线程**里跑（worker 里一份、主线程回退一份）。所以它自己的行为（节拍/漂移/丢欠帧/
// 按需 240fps/自检/熄灯淡出/多音排队）必须用它自己的夹具锁住，不能再依赖控制器接线。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLedRuntime, FADE_OUT_MS, REDUNDANT_FRAME_MS, REDUNDANT_TARGET_FPS } from '../lib/led-runtime.js'
import { createLedRuntimeBridge } from '../lib/led-runtime-bridge.js'
import { BAUD_RATE, MODE, VERIFY_REPLY, LED_COUNT } from '../lib/led-protocol.js'
import { WRITE_DROPPED } from '../lib/serial-link.js'
import { LED_FRAME_MS, LED_IDLE_FRAME_MS, LED_TARGET_FPS } from '../lib/led-timing.js'

const T0 = 1_000_000
/** 让 list/open 的 Promise 链落地（fanout 的发现/打开都是异步的）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 只记录、不执行的帧调度器：让节拍逻辑完全可控（与控制器测试同一套思路）。 */
function recorder() {
  const fired = []
  const schedule = (cb, ms) => { fired.push({ cb, ms }); return () => {} }
  return { fired, schedule }
}

/**
 * 运行时夹具：假时钟 + 假串口句柄（收到验证帧就回 ASCII）+ 可控调度器。
 * 注意时钟只在 `clock.now` 上推进，`tick()`/`settle()` 都不会自己动它。
 *
 * `io` 是传输层行为开关（热路径测试用）：
 *   · `dropLeds`：积压 → 动画帧被拒绝（WRITE_DROPPED，不是故障）；
 *   · `pending`：还有一帧没落地（冗余的第二份要据此跳过）。
 */
function fixture(options = {}) {
  const written = []
  const opened = []
  const clock = { now: T0 }
  const io = { dropLeds: false, pending: 0 }
  let reply = Buffer.from(VERIFY_REPLY, 'ascii')
  const handle = {
    closed: 0,
    write(bytes, writeOptions) {
      if (io.dropLeds && writeOptions && writeOptions.coalesce === true) return WRITE_DROPPED
      written.push(Buffer.from(bytes))
      return bytes.length
    },
    // 每次都回验证串：真实固件对**每一次** 0x00 都回 ASCII（健康探针靠它）
    read() {
      const out = reply.length > 0 ? reply : Buffer.from(VERIFY_REPLY, 'ascii')
      reply = Buffer.alloc(0)
      return out
    },
    pending() { return io.pending },
    close() { handle.closed += 1 },
  }
  const runtime = createLedRuntime({
    port: options.port ?? 'COM7',
    baud: BAUD_RATE,
    ...(options.frameMs !== undefined ? { frameMs: options.frameMs } : {}),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    open: async (port, baud) => { opened.push({ port, baud }); return handle },
    list: async () => [{ path: 'COM7', label: '' }],
    now: () => clock.now,
  })
  /** 走几拍（每步推进 100ms），让"枚举 → 打开 → 握手 → 出帧"落地。 */
  async function settle(times = 10) {
    for (let i = 0; i < times; i += 1) {
      clock.now += 100
      runtime.tick()
      await flush()
    }
  }
  const leds = () => written.filter((b) => b.length === 26 && b[2] === MODE.LEDS)
  const buzzers = () => written.filter((b) => b[2] === MODE.BUZZER)
  const pixelsOf = (frame) => {
    const out = []
    for (let i = 0; i < LED_COUNT; i += 1) {
      out.push({ r: frame[3 + i * 3], g: frame[4 + i * 3], b: frame[5 + i * 3] })
    }
    return out
  }
  return { runtime, clock, written, opened, handle, io, settle, leds, buzzers, pixelsOf }
}

const RUNNING = { state: 'running', flags: 0, brightness: 160, latched: false, reason: 'test' }

// ── 帧调度 ──────────────────────────────────────────────────────────────────

test('运行时帧循环：默认节拍 = 目标帧率（240fps），不是悄悄写死的 8ms', () => {
  const rec = recorder()
  const f = fixture({ schedule: rec.schedule })
  // 有连续动画（running）才会按目标帧率跑；这里不启动链路，只验第 0 拍
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  f.runtime.start()
  assert.equal(rec.fired.length, 1, '启动后应当只排一帧')
  assert.ok(Math.abs(rec.fired[0].ms - LED_FRAME_MS) < 1e-9,
    `默认帧周期必须是 ${LED_FRAME_MS}ms（目标 240fps），实际排了 ${rec.fired[0].ms}ms`)
  const frames = f.runtime.status().frames
  assert.equal(frames.targetFps, LED_TARGET_FPS)
  assert.ok(Math.abs(frames.frameMs - LED_FRAME_MS) < 1e-9)
  assert.equal(frames.rendered, 0, '还没跑帧，渲染数应为 0')
  assert.equal(frames.idleFrameMs, LED_IDLE_FRAME_MS)
  f.runtime.stop()
})

test('运行时帧循环：轻微迟到按"预期时刻"补偿（不累积漂移）', () => {
  const rec = recorder()
  const f = fixture({ schedule: rec.schedule })
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  f.runtime.start()
  try {
    const first = rec.fired.shift()
    f.clock.now += LED_FRAME_MS + 0.3      // 迟到 0.3ms（不到一帧）
    first.cb()
    const next = rec.fired.shift()
    assert.ok(Math.abs(next.ms - (LED_FRAME_MS - 0.3)) < 1e-6,
      `应当按预期时刻补偿（≈${LED_FRAME_MS - 0.3}ms），实际 ${next.ms}ms`)
    assert.equal(f.runtime.status().frames.skipped, 0, '不到一帧的迟到不算丢帧')
    assert.equal(f.runtime.status().frames.rendered, 1)
  } finally {
    f.runtime.stop()
  }
})

test('运行时帧循环：迟到 ≥1 帧时丢欠帧、重新对齐（绝不 0 延迟补跑）', () => {
  const rec = recorder()
  const f = fixture({ schedule: rec.schedule })
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  f.runtime.start()
  try {
    const first = rec.fired.shift()
    f.clock.now += 40                     // 线程卡了 40ms（≈9 帧）
    first.cb()
    const next = rec.fired.shift()
    assert.ok(next.ms >= LED_FRAME_MS - 1e-9,
      `迟到后必须重新对齐到未来一帧（≈${LED_FRAME_MS}ms），实际 ${next.ms}ms —— 0 延迟就是补跑`)
    const frames = f.runtime.status().frames
    assert.ok(frames.skipped >= 9, `应当记下丢掉的欠帧，实际 ${frames.skipped}`)
    assert.equal(frames.rendered, 1, '只渲染当前这一帧，不补跑历史帧')
  } finally {
    f.runtime.stop()
  }
})

test('运行时按需：稳态降到空闲节拍，画面一变立刻唤醒并切回 240fps', async () => {
  const rec = recorder()
  const f = fixture({ schedule: rec.schedule })
  // 先握手成功（稳态画面 = off），这样后续"画面变 running"才是那条按需唤醒的判据
  f.runtime.setDriving(true)
  await f.settle()
  assert.equal(f.runtime.status().link.verified, true)
  f.runtime.start()
  try {
    const first = rec.fired.shift()
    assert.ok(Math.abs(first.ms - LED_FRAME_MS) < 1e-9, '启动先按动画节拍跑一拍（设备可能正等握手）')
    f.clock.now += first.ms
    first.cb()
    const idle = rec.fired.shift()
    assert.ok(Math.abs(idle.ms - LED_IDLE_FRAME_MS) < 1e-6,
      `稳态（已握手 + off 画面）应排 ${LED_IDLE_FRAME_MS}ms，实际 ${idle.ms}ms`)
    const frames = f.runtime.status().frames
    assert.equal(frames.idle, true, '空闲节拍要如实报告 idle=true（状态页/probe 不能误读成掉帧）')
    assert.equal(frames.skipped, 0, '空闲节拍不能被记成"丢了几十帧"')

    // 空闲节拍下迟到不到两个周期：不记欠帧
    f.clock.now += LED_IDLE_FRAME_MS + 20
    idle.cb()
    assert.equal(f.runtime.status().frames.skipped, 0)
    const renderedBefore = f.runtime.status().frames.rendered

    // **立刻唤醒**：连续动画画面（running）→ 必须当场出一帧并切回 240fps
    f.clock.now += 10
    f.runtime.applyScene(RUNNING)
    const after = f.runtime.status().frames
    assert.ok(after.rendered > renderedBefore, '唤醒必须当场渲染一帧（不能等 250ms 才动）')
    assert.equal(after.idle, false, '连续动画必须回到动画节拍')
    const next = rec.fired[rec.fired.length - 1]
    assert.ok(Math.abs(next.ms - LED_FRAME_MS) < 1e-6,
      `唤醒后应排 ${LED_FRAME_MS}ms，实际 ${next.ms}ms`)
  } finally {
    f.runtime.stop()
  }
})

// ── 自检 / 淡出 / 退出 ──────────────────────────────────────────────────────

test('自检：覆盖渲染出全彩光谱帧，到期自动交还画面（status().selfTest 归零）', async () => {
  const f = fixture()
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  await f.settle()
  assert.equal(f.runtime.status().link.verified, true, '先得握手成功（自检只在连上后跑）')

  f.written.length = 0
  f.runtime.startSelfTest('ok', 200, 160)
  assert.equal(f.runtime.status().selfTest, true)

  // 光谱段（0~0.9s）：至少一帧存在 R/G/B 都不为 0 的像素
  let colorful = false
  for (let i = 0; i < 5; i += 1) {
    f.clock.now += 40
    f.runtime.tick()
    for (const frame of f.leds()) {
      if (f.pixelsOf(frame).some((p) => p.r > 0 && p.g > 0 && p.b > 0)) colorful = true
    }
  }
  assert.ok(colorful, '自检应当有全彩光谱帧')
  assert.ok(f.leds().length >= 1, '自检应当推帧')

  // 到期：运行时自己交还画面（覆盖动画撤掉）
  f.clock.now += 400
  f.runtime.tick()
  assert.equal(f.runtime.status().selfTest, false, '自检到期必须自动交还画面')
})

test('fadeOut：返回 true 表示淡出进行中；结束后发全黑帧并关串口', async () => {
  const f = fixture()
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  await f.settle()
  assert.equal(f.runtime.status().link.verified, true)
  f.written.length = 0

  assert.equal(f.runtime.fadeOut(RUNNING, 150), true, '淡出应当启动')
  assert.equal(f.runtime.status().fading, true)
  f.clock.now += 60
  f.runtime.tick()
  assert.equal(f.runtime.fadeOut(RUNNING, 150), true, '淡出进行中：再问一次仍然 true（调用方不能 blackout）')

  f.clock.now += 200
  f.runtime.tick()
  const status = f.runtime.status()
  assert.equal(status.fading, false, '淡出必须结束')
  assert.equal(status.link.state, 'disabled', '淡出结束应当关串口')
  assert.equal(f.handle.closed, 1)
  const frames = f.leds()
  assert.ok(frames.length >= 1, '淡出过程应当推帧')
  const last = frames[frames.length - 1]
  for (let i = 3; i < 24; i += 1) assert.equal(last[i], 0, '最后一帧必须全黑（WS2812 锁存）')
  assert.equal(f.runtime.fadeOut(RUNNING, 150), false, '串口已关：不再有淡出')
})

test('fadeOut：没握手时返回 false（调用方走 blackout 兜底）', () => {
  const f = fixture()
  assert.equal(f.runtime.fadeOut(RUNNING, FADE_OUT_MS), false)
  assert.equal(f.runtime.status().fading, false)
})

test('关 → 开：重新启用必须恢复画面并重新打开链路（灯不会"丢"）', async () => {
  // 用户实测：关掉「启用任务状态指示灯」再打开，灯概率不亮；自检结束后回到的是
  // 关闭期间被淡出改暗的画面。根因是 applyScene 的签名去重以为 worker 已有该画面。
  const f = fixture()
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  await f.settle()
  assert.equal(f.runtime.status().link.verified, true, '先连上')

  // 模拟控制器关闭：先停驱动，再走淡出
  f.runtime.setDriving(false)
  assert.equal(f.runtime.fadeOut(RUNNING, 100), true)
  f.clock.now += 150
  f.runtime.tick()
  assert.equal(f.runtime.status().link.state, 'disabled', '关闭态应当已经关串口')

  // 重新启用：必须取消/重新打开，并且把 RUNNING 画面重新交给链路
  f.clock.now += 10
  f.runtime.setDriving(true)
  await f.settle()
  assert.equal(f.runtime.status().link.verified, true, '重新启用后必须重新握手')
  assert.ok(f.opened.length >= 2, '重新启用需要重新 open')
  const frames = f.leds()
  assert.ok(frames.length >= 1, '重新启用后应当继续写灯帧')
  const last = frames[frames.length - 1]
  const lit = []
  for (let i = 0; i < LED_COUNT; i += 1) lit.push(last[3 + i * 3] + last[4 + i * 3] + last[5 + i * 3])
  assert.ok(lit.some((v) => v > 0), '重新启用后画面不能停在黑帧')
})

test('淡出未完成就重新启用：淡出被取消，串口不会被关掉', async () => {
  const f = fixture()
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  await f.settle()
  assert.equal(f.runtime.status().link.verified, true)
  const closedBefore = f.handle.closed

  f.runtime.setDriving(false)
  assert.equal(f.runtime.fadeOut(RUNNING, 2000), true, '开始一段很长的淡出')
  f.clock.now += 100
  f.runtime.tick()
  assert.equal(f.runtime.status().fading, true)

  f.runtime.setDriving(true)                 // 淡出到一半又打开
  assert.equal(f.runtime.status().fading, false, '重新启用必须取消残留淡出')
  f.clock.now += 2500
  f.runtime.tick()
  assert.equal(f.handle.closed, closedBefore, '残留淡出不能把刚打开的串口关掉')
  assert.equal(f.runtime.status().link.verified, true, '重新启用后链路仍在')
})

test('shutdownFade：同步淡出 + 全黑帧 + 关串口（退出路径）', async () => {
  const f = fixture()
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  await f.settle()
  assert.equal(f.runtime.status().link.verified, true)
  f.written.length = 0

  f.runtime.shutdownFade()                 // 同步：内部 sleep ~120ms
  const frames = f.leds()
  assert.ok(frames.length >= 2, '退出前应当有多级淡出帧')
  const last = frames[frames.length - 1]
  for (let i = 3; i < 24; i += 1) assert.equal(last[i], 0, '退出最后一帧必须全黑')
  assert.equal(f.handle.closed, 1, '退出后串口必须关闭')
  assert.equal(f.runtime.status().link.state, 'disabled')
  f.runtime.stop()
})

test('shutdownFade：没握手也安全（只关句柄，不抛）', () => {
  const f = fixture()
  assert.doesNotThrow(() => f.runtime.shutdownFade())
  assert.equal(f.runtime.status().link.state, 'disabled')
})

// ── 蜂鸣多音 ────────────────────────────────────────────────────────────────

test('蜂鸣多音排队：第一声同步发，后续按 at 定时（固件一次只响一个）', async () => {
  const f = fixture()
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  await f.settle()
  assert.equal(f.runtime.status().link.verified, true)
  f.written.length = 0

  const ok = f.runtime.beepPattern([
    { at: 0, beep: { freqHz: 520, volume: 16, durationMs: 60 } },
    { at: 20, beep: { freqHz: 660, volume: 18, durationMs: 60 } },
  ])
  assert.equal(ok, true)
  assert.equal(f.buzzers().length, 1, '第一声必须同步写出去（点一下就要有反馈）')
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(f.buzzers().length, 2, '第二声应当由定时器排队补上')
  const freqs = f.buzzers().map((b) => b[3] | (b[4] << 8))
  assert.deepEqual(freqs, [520, 660])
  f.runtime.stop()
})

test('蜂鸣多音：未握手时不发、返回 false（不记账，连上后补响）', () => {
  const f = fixture()
  const ok = f.runtime.beepPattern([{ at: 0, beep: { freqHz: 520, volume: 16, durationMs: 60 } }])
  assert.equal(ok, false)
  assert.equal(f.written.length, 0)
  assert.equal(f.runtime.beep({ freqHz: 520, volume: 16, durationMs: 60 }), false)
})

// ── 其他接口 ────────────────────────────────────────────────────────────────

test('rawFrame / flush / configure：原样交给链路', async () => {
  const f = fixture()
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  await f.settle()
  f.written.length = 0

  // 运行时不做协议校验（那是 led-controller/led-protocol 的职责）：原样写下去
  const frame = Buffer.from([0x55, 0xaa, MODE.BUZZER, 0x0a, 0x00, 0x10, 0x20, 0x00, 0x55])
  assert.equal(f.runtime.rawFrame(frame), true)
  assert.equal(f.written.length, 1)
  assert.equal(f.written[0].toString('hex'), frame.toString('hex'))

  assert.equal(f.runtime.flush({ state: 'off', flags: 0, brightness: 0, latched: false, reason: '测试' }), true)
  const last = f.leds().at(-1)
  assert.ok(last, 'flush 应当写出 LEDS 帧')
  for (let i = 3; i < 24; i += 1) assert.equal(last[i], 0, 'flush 熄灯帧必须全黑')
  f.runtime.stop()
})

test('DSH_LED_RUNTIME=inline：桥强制走主线程运行时（不 spawn worker，功能仍可用）', async () => {
  const written = []
  const clock = { now: T0 }
  const handle = {
    write(bytes) { written.push(Buffer.from(bytes)); return bytes.length },
    read() { return Buffer.alloc(0) },
    close() { /* ignore */ },
  }
  const previous = process.env.DSH_LED_RUNTIME
  process.env.DSH_LED_RUNTIME = 'inline'
  try {
    const runtime = createLedRuntimeBridge({
      port: 'COM7',
      baud: BAUD_RATE,
      open: async () => handle,
      list: async () => [],
      now: () => clock.now,
      log: () => {},
    })
    runtime.start()
    runtime.setDriving(true)
    runtime.applyScene(RUNNING)
    for (let i = 0; i < 4; i += 1) {
      clock.now += 100
      runtime.tick()
      await flush()
    }
    // 没设备（list 空）：链路会自己尝试并进入 error，但运行时本身必须活着、可查询
    const status = runtime.status()
    assert.ok(status.frames.frameMs > 0)
    assert.equal(typeof status.link.state, 'string')
    assert.equal(status.fading, false)
    runtime.stop()
  } finally {
    if (previous === undefined) delete process.env.DSH_LED_RUNTIME
    else process.env.DSH_LED_RUNTIME = previous
  }
})

// ── 自适应冗余（task-8）：链路劣化时唯一帧 120fps、每帧两份；健康 10s 后回 240 ──

test('运行时自适应冗余：劣化 → 唯一帧降到 120fps（每帧两份）；健康后回 240fps', async () => {
  const rec = recorder()
  const f = fixture({ schedule: rec.schedule })
  f.runtime.setDriving(true)
  f.runtime.applyScene(RUNNING)
  await f.settle()
  assert.equal(f.runtime.status().link.verified, true, '先握手成功')

  f.runtime.start()
  try {
    // 先跑两拍健康帧（单发）
    const step = (bumpMs) => {
      const fired = rec.fired.shift()
      assert.ok(fired, '帧必须已经排上')
      f.clock.now += bumpMs === undefined ? fired.ms : bumpMs
      fired.cb()
      return fired
    }
    step()
    step()
    let frames = f.runtime.status().frames
    assert.equal(frames.redundant, false, '健康态不是冗余')
    assert.equal(Math.round(frames.uniqueFpsTarget), LED_TARGET_FPS, '健康态唯一帧目标 = 240fps')
    assert.ok(Math.abs(rec.fired[rec.fired.length - 1].ms - LED_FRAME_MS) < 1e-6, '健康态按 4.17ms 排帧')

    // 传输层连续丢两帧（接触不良/积压的模型）→ 质量掉到 suspect → 冗余
    f.io.dropLeds = true
    step()
    step()
    assert.equal(f.runtime.status().link.redundancy, true, '劣化后链路进入冗余')
    f.io.dropLeds = false

    // 恢复后的这一拍：同一帧写两份（第一份可丢 + 第二份必达）
    const before = f.leds().length
    step(300)               // 顺带让 250ms 的冗余采样期到期
    const pair = f.leds().slice(before)
    assert.equal(pair.length, 2, `冗余期一帧应当写两份：${pair.length}`)
    assert.equal(pair[0].toString('hex'), pair[1].toString('hex'), '两份逐字节相同')

    // 下一个调度周期必须是 8.33ms（唯一帧 120fps），状态如实暴露
    const scheduled = rec.fired[rec.fired.length - 1]
    assert.ok(Math.abs(scheduled.ms - REDUNDANT_FRAME_MS) < 1e-6,
      `冗余期应排 ${REDUNDANT_FRAME_MS.toFixed(3)}ms，实际 ${scheduled.ms}ms`)
    frames = f.runtime.status().frames
    assert.equal(frames.redundant, true)
    assert.equal(frames.uniqueFpsTarget, REDUNDANT_TARGET_FPS, '唯一帧目标降到 120fps')
    assert.equal(frames.targetFps, LED_TARGET_FPS, '动画目标帧率仍应报 240（目标 vs 实测分开）')

    // 健康 10s（保持期到期）→ 退出冗余、回到 240fps 单发
    f.clock.now += 10_100
    const beforeJump = f.leds().length
    step(0)                 // 跳跃后的这一拍：链路已退出冗余 → 只写一份
    assert.equal(f.leds().length - beforeJump, 1, '退出冗余后必须回到单发')
    frames = f.runtime.status().frames
    assert.equal(frames.redundant, false, '健康 10s 后必须退出冗余')
    assert.equal(Math.round(frames.uniqueFpsTarget), LED_TARGET_FPS)
    const nextScheduled = rec.fired[rec.fired.length - 1]
    assert.ok(Math.abs(nextScheduled.ms - LED_FRAME_MS) < 1e-6,
      `退出冗余后应回到 ${LED_FRAME_MS}ms，实际 ${nextScheduled.ms}ms`)
  } finally {
    f.runtime.stop()
  }
})
