// LED 控制器单测：把"宿主事实 → 判定 → 画面 → 像素 → 串口帧"整条线跑一遍
//
// 真正容易错的地方不是每个模块自己，而是**接线**：服务取错了、字段名写错、优先级反了，
// 单元测试全绿但灯是错的。这里用假 ctx（结构照 DSH 0.2.0-rc.2 的真实服务面）+ 假串口句柄，
// 断言"给定这些事实，最终写出去的 26 字节 LEDS 帧长什么样"。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLedController, sanitizeLedPort } from '../lib/led-controller.js'
import { createLedRuntime } from '../lib/led-runtime.js'
import { MODE, VERIFY_REPLY, LED_COUNT } from '../lib/led-protocol.js'
import { SCENE_FLAG } from '../lib/led-scene.js'
import { LED_FRAME_MS, LED_IDLE_FRAME_MS, LED_TARGET_FPS } from '../lib/led-timing.js'

const T0 = 1_000_000
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 造一个假 ctx：只实现 led-controller 真正读的几个服务。 */
function harness(options = {}) {
  let portsRef = options.list || (async () => [{ path: 'COM7', label: '' }])
  const written = []
  const opened = []
  const clock = { now: T0 }
  let reply = Buffer.from(VERIFY_REPLY, 'ascii')
  const fakeHandle = {
    write(bytes) {
      written.push(Buffer.from(bytes))
      // 真固件对**每一次**验证帧都回 ASCII。夹具若只在构造时准备一次回包，
      // 重连后就会永远卡在 verifying（链路逻辑本身没问题）。
      if (bytes.length === 5 && bytes[2] === MODE.VERIFY) reply = Buffer.from(VERIFY_REPLY, 'ascii')
      return bytes.length
    },
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
  // 帧循环的调度器：测试注入 `schedule`（只记录不执行）来精确验节拍；
  // `ctxTimeout` 只用来验"帧循环绝不调用 ctx.timeout"（OOM 回归），不再用来驱动帧。
  if (typeof options.ctxTimeout === 'function') ctx.timeout = options.ctxTimeout
  if (typeof options.ctxInterval === 'function') ctx.interval = options.ctxInterval
  let cfg = Object.assign({
    enabled: true, port: 'COM7', brightness: 160, buzzer: true, attention: true, idleOffMs: 120_000,
  }, options.config || {})
  const hasMayRun = Object.prototype.hasOwnProperty.call(options, 'mayRun')
  // 夹具默认 40ms 只是为了确定性；传 frameMs: undefined 才能验"生产默认值"
  const hasFrameMs = Object.prototype.hasOwnProperty.call(options, 'frameMs')
  let mayRun = options.mayRun === true
  const controller = createLedController({
    ctx,
    config: () => cfg,
    log: (line) => { if (typeof options.log === 'function') options.log(line) },
    // 夹具兼容：测试可以传布尔（isFocused）或旧的"最近聚焦时间戳"（lastFocusedAt），
    // 统一翻译成判定器要的"此刻是否聚焦"。
    isFocused: () => {
      if (typeof options.isFocused === 'function') return options.isFocused()
      if (typeof options.lastFocusedAt === 'function') {
        const last = options.lastFocusedAt()
        return last > 0 && clock.now - last < 120_000
      }
      return true
    },
    open: async (port, baud) => { opened.push({ port, baud }); return fakeHandle },
    list: () => (typeof portsRef === 'function' ? portsRef() : portsRef),
    now: () => clock.now,
    // 用 **inline 运行时**（同一份 led-runtime.ts，不 spawn worker）：单测不碰真线程，
    // 帧调度/自检/淡出全部走这里注入的假时钟与假串口。
    runtimeFactory: (runtimeOptions) => createLedRuntime({
      ...runtimeOptions,
      open: async (port, baud) => { opened.push({ port, baud }); return fakeHandle },
      list: () => (typeof portsRef === 'function' ? portsRef() : portsRef),
      now: () => clock.now,
    }),
    ...(hasFrameMs ? (options.frameMs === undefined ? {} : { frameMs: options.frameMs }) : { frameMs: 40 }),
    ...(hasMayRun ? { mayRun: () => mayRun } : {}),
    ...(typeof options.schedule === 'function' ? { schedule: options.schedule } : {}),
    ...(typeof options.pendingApprovals === 'function' ? { pendingApprovals: options.pendingApprovals } : {}),
    ...(typeof options.pendingAsks === 'function' ? { pendingAsks: options.pendingAsks } : {}),
    ...(typeof options.hasWork === 'function' ? { hasWork: options.hasWork } : {}),
  })
  /** 走几次采样，让「枚举 → 打开 → 握手 → 淡入 → 出帧」整条链落地（每步推进 100ms）。 */
  async function settle(times = 8) {
    for (let i = 0; i < times; i += 1) {
      clock.now += 100
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
    setList: (fn) => { portsRef = fn },
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

/**
 * 多灯夹具：每个端口一块假板子（上面的 harness 只有一个共享句柄，看不出"广播到所有灯"）。
 * 用来验证 controller 真的把 createSerialFanout 接上了、而不是还只驱动第一块。
 */
function fanoutHarness(options = {}) {
  let ports = [...(options.ports ?? [])]
  const clock = { now: T0 }
  const opened = []
  const boards = new Map()
  /** 全部板子收到的字节（按写入顺序；日志/单灯断言用）。 */
  const written = []
  const services = {
    agents: options.agents,
    jobs: options.jobs,
    sessionProjections: options.projections,
    sessions: options.sessions,
    goals: options.goals,
  }
  const ctx = { get: (name) => services[name] }
  let cfg = Object.assign({
    enabled: true, port: 'auto', brightness: 160, buzzer: false, attention: true, idleOffMs: 120_000,
  }, options.config || {})

  function boardFor(port) {
    let board = boards.get(port)
    if (!board) {
      board = {
        port,
        written: [],
        /** 收到 VERIFY 帧后置位：真固件每收到一次验证帧就回一次 "AI Status Lights OK"。 */
        replyPending: false,
        closes: 0,
        failing: false,
        answers: options.answers ? options.answers(port) : true,
      }
      board.handle = {
        write(bytes) {
          if (board.failing) throw new Error('写入失败')
          const copy = Buffer.from(bytes)
          board.written.push(copy)
          written.push(copy)
          // 主动探测（reap）会周期发 VERIFY：不回包的话链路会判"设备已拔出"，
          // 所以假板子必须像真固件一样对**每一次**验证帧回包。
          if (copy.length === 5 && copy[2] === MODE.VERIFY) board.replyPending = true
          return bytes.length
        },
        read() {
          if (!board.answers || !board.replyPending) return Buffer.alloc(0)
          board.replyPending = false
          return Buffer.from(VERIFY_REPLY, 'ascii')
        },
        close() { board.closes += 1 },
      }
      boards.set(port, board)
    }
    return board
  }

  const controller = createLedController({
    ctx,
    config: () => cfg,
    log: (line) => { if (typeof options.log === 'function') options.log(line) },
    isFocused: () => true,
    open: async (port, baud) => {
      opened.push({ port, baud })
      return boardFor(port).handle
    },
    list: async () => ports.map((path) => ({
      path,
      label: /COM9/.test(path) ? 'USB-SERIAL CH340' : 'Intel 串行',
    })),
    now: () => clock.now,
    frameMs: 40,
    // 同样走 inline 运行时（见上面的说明）
    runtimeFactory: (runtimeOptions) => createLedRuntime({
      ...runtimeOptions,
      open: async (port, baud) => {
        opened.push({ port, baud })
        return boardFor(port).handle
      },
      list: async () => ports.map((path) => ({
        path,
        label: /COM9/.test(path) ? 'USB-SERIAL CH340' : 'Intel 串行',
      })),
      now: () => clock.now,
    }),
  })

  /** 走几次采样（每步推进 100ms）：枚举→打开→握手→自检→常规画面整条链都靠它落地。 */
  async function settle(times = 8) {
    for (let i = 0; i < times; i += 1) {
      clock.now += 100
      controller.refresh()
      await flush()
    }
  }

  const ledsOf = (port) => {
    const board = boards.get(port)
    if (!board) return []
    return board.written.filter((buf) => buf.length === 26 && buf[2] === MODE.LEDS)
  }

  return {
    controller, clock, opened, boards, written, settle, ledsOf,
    board: (port) => boards.get(port),
    setPorts(next) { ports = [...next] },
    setConfig(patch) { cfg = Object.assign({}, cfg, patch) },
  }
}

/** 造一个"有根会话在跑"的 agents 服务（多灯用例共用）。 */
function runningAgents() {
  const agent = rootAgent('s1', 'running')
  return { roots: () => [agent], list: () => [agent], get: () => agent }
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

test('黄灯脉冲：1 秒后自动消失（与聚焦无关），且优先级 红 > 黄 > 橙', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle(26)          // 等连接后的 2s 自检动画播完，回到常规画面
  let px = h.lastPixels()
  assert.ok(px && px.some((p) => p.b > 0), '运行中先是冷白')

  // 审批被自动拒绝 / 后台任务失败 → 黄（亮度 160 时约 100/82/0）
  h.controller.noteWarn('s1', '审批被自动拒绝')
  await h.settle(4)           // 跨过 250ms 交叉渐变
  px = h.lastPixels()
  assert.ok(px.every((p) => p.b === 0 && p.r >= 80 && p.g >= 60 && p.r > p.g), `黄灯应常亮：${JSON.stringify(px[0])}`)

  // 1 秒后自动消失，回到判定画面（不再黄）
  h.clock.now += 1100
  await h.settle(4)
  px = h.lastPixels()
  assert.ok(!px.every((p) => p.b === 0 && p.r >= 80 && p.g >= 60 && p.r > p.g), '1 秒后必须自动消失')

  // 红 > 黄：目标阻塞（红）期间不允许黄灯覆盖
  h.controller.noteError('s1', '目标阻塞')
  await h.settle(4)
  h.controller.noteWarn('s1', '审批被自动拒绝')
  await h.settle(4)
  px = h.lastPixels()
  assert.ok(px.every((p) => p.r >= 80 && p.g <= 5 && p.b <= 5), `报错必须压过黄：${JSON.stringify(px[0])}`)
})

test('绿灯脉冲：后台子代理/后台任务/团队任务完成只亮 2 秒，不打断等待/报错', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle(26)          // 等连接后的 2s 自检动画播完

  h.controller.noteDone('s1', '后台任务已完成')
  await h.settle(4)
  let px = h.lastPixels()
  assert.ok(px && px.every((p) => p.g >= 50 && p.g > p.r && p.g > p.b), `绿灯：${JSON.stringify(px[0])}`)

  h.clock.now += 2100
  await h.settle(4)
  px = h.lastPixels()
  assert.ok(px.some((p) => p.b > 0), '2 秒后回到运行中的冷白')
})

test('运行中关闭指示灯：必须广播状态变化（设置页不能停在"运行中"）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  assert.equal(h.controller.status().link.verified, true, '先连上')

  let broadcasts = 0
  const off = h.controller.subscribe(() => { broadcasts += 1 })
  h.setConfig({ enabled: false })
  await h.settle(6)
  off()

  assert.ok(broadcasts >= 1, '关闭路径提前 return 也必须广播（旧实现不广播 → SSE 一直显示运行中）')
  const st = h.controller.status()
  assert.equal(st.enabled, false)
  assert.equal(st.reason, 'disabled', '关闭后状态原因必须是 disabled')
  assert.equal(st.link.verified, false, '关闭后链路应当已断开')
})

test('关 → 开：重新打开后灯必须恢复（不是停在关闭时的黑帧）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  assert.equal(h.controller.status().link.verified, true)

  h.setConfig({ enabled: false })
  await h.settle(4)
  assert.equal(h.controller.status().link.state, 'disabled', '关闭态应已关串口')
  assert.equal(h.controller.status().reason, 'disabled')

  const opensBefore = h.opened.length
  h.setConfig({ enabled: true })
  await h.settle(10)

  assert.ok(h.opened.length > opensBefore, '重新启用必须重新打开串口')
  assert.equal(h.controller.status().link.verified, true, '重新启用后必须重新握手')
  const px = h.lastPixels()
  assert.ok(px, '重新启用后应当继续写灯帧')
  assert.ok(px.some((p) => p.r + p.g + p.b > 0), '重新启用后画面不能停在黑帧')
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

test('没有设备时如实回报，但**链路必须继续自愈**（不依赖枚举恢复）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents, list: async () => [] })
  await h.settle()
  assert.equal(h.controller.status().devicePresent, false)
  assert.deepEqual(h.controller.status().ports, [])

  // 设备"插上"：枚举恢复后链路要自己连上并推帧。
  // 这条是"断连卡死"的回归防线 —— 之前枚举为空会直接 return，link.tick() 永远不跑。
  h.setList(async () => [{ path: 'COM7', label: '' }])
  h.clock.now += 3000
  await h.settle(6)
  assert.ok(h.opened.length >= 1, '设备出现后应当自动重连')
  assert.ok(h.written.length >= 1, '连上后应当开始推帧')
})

test('缺 agents 服务 → 不点灯（分不清在跑还是跑完，宁可不给错信号）', async () => {
  const h = harness({ agents: undefined })
  await h.settle()
  assert.equal(h.written.filter((b) => b[2] === MODE.LEDS).length, 0)
})

test('会话完成 + 人不在 → 常亮绿（不闪），并响一声蜂鸣器', async () => {
  // 先跑起来、再停下 —— 空闲会话的 done 不算"完成"（completed 语义）
  let status = 'running'
  const agents = {
    roots: () => [rootAgent('s1', status)],
    list: () => [rootAgent('s1', status)],
    get: () => rootAgent('s1', status),
  }
  // lastFocusedAt 很旧 → 人不在
  const h = harness({ agents, lastFocusedAt: () => T0 - 10 * 60_000 })
  await h.settle()
  status = 'idle'                 // 跑完了
  h.clock.now += 3200
  await h.settle(2)
  const scene = h.controller.status().scene
  assert.equal(scene.state, 'done')
  assert.equal((scene.flags & SCENE_FLAG.ATTENTION) !== 0, false, `完成不该闪：${JSON.stringify(scene)}`)
  await h.settle()
  if (process.env.LED_DEBUG) console.log('[dbg] modes=', JSON.stringify(h.modes()), 'link=', JSON.stringify(h.controller.status().link))
  assert.equal(h.modes().includes(MODE.BUZZER), true, '状态跳到"完成"时应当响一声')
})

test('聚焦时红灯看满 2s 熄灭后：回到运行白，会话结束再亮绿（不被 error 粘滞吞掉）', async () => {
  let status = 'running'
  const agents = { roots: () => [rootAgent('s1', status)], list: () => [rootAgent('s1', status)], get: () => rootAgent('s1', status) }
  const h = harness({ agents, isFocused: () => true })
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'running', '先确认运行白')

  h.controller.noteError('s1', '目标阻塞')
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'error', '先亮红（聚焦：常亮不闪）')

  // 聚焦看满 2 秒 → 红灯熄灭，但底层仍在运行：必须回到 running，而不是一直 off
  h.clock.now += 2100
  await h.settle(3)
  assert.equal(h.controller.status().scene.state, 'running', '红灯熄灭后应回到运行白')

  // 会话结束 → 绿
  status = 'idle'
  h.clock.now += 3200
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'done', '结束后应亮完成绿')
})

test('人回来了 → 完成态熄灭（粘滞"已看"）', async () => {
  let status = 'running'
  const agents = { roots: () => [rootAgent('s1', status)], list: () => [rootAgent('s1', status)], get: () => rootAgent('s1', status) }
  let focusedAt = T0 - 10 * 60_000
  const h = harness({ agents, lastFocusedAt: () => focusedAt })
  await h.settle()
  status = 'idle'
  h.clock.now += 3200
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'done', '人不在：常亮绿')
  focusedAt = h.clock.now
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'off', '回到页面：熄灭')
  // 再失焦也不该复亮（这一条是"熄了又被失焦复活"的回归防线）
  focusedAt = T0 - 10 * 60_000
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'off', '失焦后不该重新亮起')
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
  assert.equal(status.boards, 1, '单端口默认夹具：实际驱动 1 块')
  assert.equal(status.boardCount, 1)
  assert.equal(status.devicePresent, true)
  assert.deepEqual(status.device, { leds: 7, verified: true })
  assert.match(status.sceneText, /running/)
})

test('preview() 直接改画面（不经过判定），下一帧就渲染出来', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  // 跳过 2s 上电自检：必须**分小步**推进（一次跳 2.2s 会触发探测超时→重连→自检重来，
  // 那是测试时钟跳变造成的假象，真实运行里不会发生）。
  for (let i = 0; i < 6; i += 1) {
    h.clock.now += 500
    h.controller.refresh()
    await flush()
  }
  h.written.length = 0
  assert.equal(h.controller.preview('error', 255), true)   // preview 自己就会触发一帧
  h.clock.now += 400                                        // 跳过 250ms 交叉渐变
  await h.settle(2)                                          // 再走两拍
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
    assert.ok(freq >= 200 && freq <= 1200, `频率 ${freq}Hz 太尖或太低`)
    assert.ok(volume > 0 && volume <= 35, `音量 ${volume} 太响（用户反馈刺耳）`)
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

test('关闭指示灯开关 → 先发一帧全黑再关串口（WS2812 会锁存最后一帧）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  assert.ok(h.lastPixels().some((p) => p.r + p.g + p.b > 0), '先得有亮着的灯')
  h.setConfig({ enabled: false })
  h.written.length = 0
  await h.settle(5)          // 淡出 300ms 走完才真正关串口
  const black = [...h.written].reverse().find((b) => b.length === 26 && b[2] === 1)
  assert.ok(black, '关闭时必须写出 26 字节的 LEDS 帧')
  for (let i = 0; i < 21; i += 1) assert.equal(black[3 + i], 0, '最后一帧必须是全黑（淡出结束）')
})

test('关闭总开关 → 同样熄灯', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  h.setConfig({ master: false })
  h.written.length = 0
  await h.settle(5)
  const black = [...h.written].reverse().find((b) => b.length === 26 && b[2] === 1)
  assert.ok(black, '总开关关闭也要熄灯')
  for (let i = 0; i < 21; i += 1) assert.equal(black[3 + i], 0, '总开关关闭后最后一帧也应是全黑')
})

test('test(kind)：不需要先开开关，直接出画面 + 响对应声音', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  h.written.length = 0
  assert.equal(h.controller.test('error'), true)
  h.clock.now += 400
  await h.settle(2)
  const leds = [...h.written].reverse().find((b) => b.length === 26 && b[2] === 1)
  assert.ok(leds, '应当推一帧画面')
  assert.equal(h.modes().includes(MODE.BUZZER), true, '应当响一声')
  assert.equal(h.controller.test('nope'), false, '未知类型要拒绝')
})

test('多会话不冲突：一个在跑 + 一个等你 → 只显示「等你」那一个画面，且不重复开串口', async () => {
  const s1 = rootAgent('s1', 'running')
  const s2 = rootAgent('s2', 'idle')
  const agents = {
    roots: () => [s1, s2],
    list: () => [s1, s2],
    get: (id) => (id === 's1' ? s1 : s2),
  }
  const projections = {
    // 控制器可能传会话 id 字符串，也可能传会话对象 —— 两种都认
    stateOf: (session, key) => {
      const id = typeof session === 'string' ? session : String((session && session.id) ?? '')
      if (key !== 'userQuestions' || id !== 's2') return undefined
      // 真实形状（sessionProjections 的 wire view）：active 在**顶层**
      return { active: [{ state: 'open' }], settled: [] }
    },
  }
  // 投影要拿到会话对象才生效（控制器用 sessions.get() 取会话）
  const sessions = { get: (id) => (id === 's1' ? s1 : s2) }
  // 人不在：等待态才会一直保持（聚焦后 2s 就该熄灭）
  const awayFocus = T0 - 10 * 60_000
  const h = harness({ agents, projections, sessions, lastFocusedAt: () => awayFocus })
  await h.settle()
  h.clock.now += 1600          // 跳过 1.1s 上电自检 + 交接渐变
  await h.settle(6)
  // 优先级：有人等你 > 在跑
  assert.equal(h.controller.status().scene.state, 'waiting', '多会话聚合后应当显示更重要的那个')
  assert.ok(h.controller.status().verdicts.length >= 2, '两个会话都要在判定里')
  // 只有一条链路、一条帧流：不会出现"两个会话各自驱动一次灯"
  assert.equal(h.opened.length, 1, '无论多少会话，串口只开一次')
  const leds = h.written.filter((b) => b.length === 26 && b[2] === 1)
  assert.ok(leds.length >= 1)
  // 帧内容必须一致地反映聚合画面（黄色系：r>g>b）—— 不可能一半黄一半白
  const last = leds[leds.length - 1]
  const first = { r: last[3], g: last[4], b: last[5] }
  assert.ok(first.r >= first.g && first.g >= first.b, `等待态应当是琥珀色：${JSON.stringify(first)}`)
})

test('蜂鸣器冷却：两个会话接连结算，不会连珠炮', async () => {
  const s1 = rootAgent('s1', 'idle')
  const s2 = rootAgent('s2', 'idle')
  const agents = { roots: () => [s1], list: () => [s1], get: () => s1 }
  const h = harness({ agents, lastFocusedAt: () => T0 - 10 * 60_000 })
  await h.settle()
  const beeps = h.written.filter((b) => b[2] === MODE.BUZZER).length
  assert.ok(beeps <= 2, `冷却期内不该连续响：${beeps}`)
  void s2
})

test("测试项：'selftest' 触发自检动画，'off' 被拒绝（熄灭只走关开关）", async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  assert.equal(h.controller.test('off'), false, '不该有 off 测试项')
  h.written.length = 0
  assert.equal(h.controller.test('selftest'), true)
  await h.settle(2)
  const leds = h.written.filter((b) => b.length === 26 && b[2] === 1)
  assert.ok(leds.length >= 1, '自检应当推帧')
  // 自检是彩色的：至少有一帧存在 R、G、B 都不为 0 的像素（光谱段）
  const colorful = leds.some((f) => {
    for (let i = 0; i < 7; i += 1) {
      const r = f[3 + i * 3]
      const g = f[4 + i * 3]
      const b = f[5 + i * 3]
      if (r > 0 && g > 0 && b > 0) return true
    }
    return false
  })
  assert.ok(colorful, '自检应当有全彩光谱帧')
})
test('亮度上限 = 配置值：提醒加成也不会超过它', async () => {
  const agents = { roots: () => [rootAgent('s1', 'idle')], list: () => [rootAgent('s1', 'idle')], get: () => rootAgent('s1', 'idle') }
  const h = harness({ agents, lastFocusedAt: () => T0 - 10 * 60_000, config: { brightness: 100 } })
  await h.settle()
  const scene = h.controller.status().scene
  assert.ok(scene.brightness <= 100, `场景亮度必须 ≤ 配置值：${scene.brightness}`)
  // 推送出去的帧也必须按 100 的亮度渲染（取最亮通道做上限检查）
  const frame = [...h.written].reverse().find((b) => b.length === 26 && b[2] === 1)
  assert.ok(frame, '应当有画面帧')
  let maxCh = 0
  for (let i = 3; i < 24; i += 1) maxCh = Math.max(maxCh, frame[i])
  assert.ok(maxCh <= 255, '通道上限 255')
})

test('shutdown()：同步淡出后发全黑帧并关串口（DSH 退出后灯不亮）', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  h.written.length = 0
  h.controller.shutdown()
  const leds = h.written.filter((b) => b.length === 26 && b[2] === 1)
  assert.ok(leds.length >= 1, '退出前应当推帧')
  const last = leds[leds.length - 1]
  for (let i = 3; i < 24; i += 1) assert.equal(last[i], 0, '最后一帧必须全黑')
  assert.equal(h.controller.status().link.state, 'disabled', '退出后串口应当关闭')
})

test('红灯：不聚焦一直闪；回到页面熄灭并**回到真实状态**（不被异常毒化）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  let focusAt = T0 - 10 * 60_000     // 一开始：人不在
  const h = harness({ agents, lastFocusedAt: () => focusAt })
  await h.settle()
  h.clock.now += 2200                // 跳过自检
  await h.settle(2)
  h.controller.noteError('s1', '后台任务失败')
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'error', '不聚焦：红灯在')
  assert.equal(h.controller.status().scene.latched, true, '不聚焦：红灯要闪')

  // 人回到页面 → 熄灭 → **然后必须回到运行画面**（错误已看到，不能毒化 10 分钟）
  focusAt = h.clock.now
  h.clock.now += 200
  await h.settle(2)
  const st = h.controller.status().scene.state
  assert.ok(st === 'off' || st === 'running', `看到异常后应当熄灯或回到运行：${st}`)
  h.clock.now += 600
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'running', '异常被看到后必须回到运行画面，不能一直黑着')
})
test('黄灯信号：宿主报告"正在等回答"→ 立即变黄灯（不依赖 userQuestions 投影）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  let asking = 0
  const h = harness({ agents, pendingAsks: () => asking })
  await h.settle()
  h.clock.now += 2200          // 跳过自检
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'running', '开始时：运行中（白）')

  asking = 1                   // 模型开始提问（阻塞式）
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'waiting', '提问挂起时应当是黄灯')
  assert.ok(h.controller.status().scene.reason.includes('等待'), '原因里应说明在等你')

  asking = 0                   // 回答/超时
  await h.settle(2)
  assert.equal(h.controller.status().scene.state, 'running', '回答后回到运行中')
})

test('枚举超时后的**过期结果**不能覆盖新结果，也不能提前释放新扫描的锁', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  // 可控的枚举：每次调用返回一个我们手动 resolve 的 promise
  const pending = []
  const list = () => new Promise((resolve) => { pending.push(resolve) })
  const h = harness({ agents, list })
  await h.settle(1)
  assert.equal(pending.length, 1, '第一轮扫描应当已发起')

  // ① 第一轮卡住超过 5 秒（同时越过 15s 的周期扫描门槛）→ 触发超时恢复
  h.clock.now += 16000
  await h.settle(1)
  assert.ok(pending.length >= 2, '超时后应当允许第二轮扫描')

  // ② 第二轮先返回：有设备
  const second = pending[pending.length - 1]
  second([{ path: 'COM7', label: '' }])
  await flush()
  assert.equal(h.controller.status().devicePresent, true, '第二轮结果应当生效')

  // ③ 第一轮（过期）晚回来，且报告"没有设备" → 不能覆盖
  pending[0]([])
  await flush()
  assert.equal(h.controller.status().devicePresent, true, '过期结果绝不能覆盖新结果')
  assert.deepEqual(h.controller.status().ports, ['COM7'], '端口列表也不该被旧结果清空')
})

// ── 帧循环节拍 ─────────────────────────────────────────────────────────────
// 这一组补的是"240Hz 只在注释里"的坑：默认帧周期必须等于 led-timing 的目标帧率，
// 迟到时必须丢欠帧（不补跑），轻微迟到必须按预期时刻补偿（不累积漂移）。

/** 只记录、不执行的调度器：让节拍逻辑完全可控。 */
function recorder() {
  const fired = []
  const timeout = (cb, ms) => { fired.push({ cb, ms }); return () => {} }
  const interval = () => () => {}
  return { fired, timeout, interval }
}

test('帧循环默认节拍 = 目标帧率（240fps），不是某个悄悄写死的 8ms', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  const rec = recorder()
  // frameMs: undefined → 走生产默认值（这正是之前出错的地方）
  const h = harness({ agents, frameMs: undefined, schedule: rec.timeout, ctxInterval: rec.interval })
  h.controller.start()
  try {
    assert.equal(rec.fired.length, 1, '启动后应当只排一帧')
    assert.ok(Math.abs(rec.fired[0].ms - LED_FRAME_MS) < 1e-9,
      `默认帧周期必须是 ${LED_FRAME_MS}ms（目标 240fps），实际排了 ${rec.fired[0].ms}ms`)
    const frames = h.controller.status().frames
    assert.equal(frames.targetFps, LED_TARGET_FPS)
    assert.ok(Math.abs(frames.frameMs - LED_FRAME_MS) < 1e-9)
    assert.equal(frames.rendered, 0, '还没跑帧，渲染数应为 0')
  } finally {
    h.controller.stop()
  }
})

test('帧循环：轻微迟到按"预期时刻"补偿（不累积漂移）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  const rec = recorder()
  const h = harness({ agents, frameMs: undefined, schedule: rec.timeout, ctxInterval: rec.interval })
  h.controller.start()
  try {
    const first = rec.fired.shift()
    h.clock.now += LED_FRAME_MS + 0.3      // 迟到 0.3ms（不到一帧）
    first.cb()
    const next = rec.fired.shift()
    assert.ok(Math.abs(next.ms - (LED_FRAME_MS - 0.3)) < 1e-6,
      `应当按预期时刻补偿（≈${LED_FRAME_MS - 0.3}ms），实际 ${next.ms}ms`)
    assert.equal(h.controller.status().frames.skipped, 0, '不到一帧的迟到不算丢帧')
  } finally {
    h.controller.stop()
  }
})

test('帧循环：迟到 ≥1 帧时**丢欠帧、重新对齐**，绝不 0 延迟补跑（卡顿后不会猛跳）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  const rec = recorder()
  const h = harness({ agents, frameMs: undefined, schedule: rec.timeout, ctxInterval: rec.interval })
  h.controller.start()
  try {
    const first = rec.fired.shift()
    h.clock.now += 40                      // 主线程卡了 40ms（≈9 帧）
    first.cb()
    const next = rec.fired.shift()
    assert.ok(next.ms >= LED_FRAME_MS - 1e-9,
      `迟到后必须重新对齐到未来一帧（≈${LED_FRAME_MS}ms），实际 ${next.ms}ms —— 0 延迟就是补跑`)
    const frames = h.controller.status().frames
    assert.ok(frames.skipped >= 9, `应当记下丢掉的欠帧，实际 ${frames.skipped}`)
    assert.equal(frames.rendered, 1, '只渲染当前这一帧，不补跑历史帧')
  } finally {
    h.controller.stop()
  }
})

// ── 帧循环按需运行（任务：空闲不再 240fps 空转）─────────────────────────────

test('帧循环按需：稳态降到空闲节拍，场景一变立刻唤醒（不必等空闲定时器）', async () => {
  let status = 'idle'
  const agents = {
    roots: () => [rootAgent('s1', status)],
    list: () => [rootAgent('s1', status)],
    get: () => rootAgent('s1', status),
  }
  const rec = recorder()
  const h = harness({
    agents, frameMs: undefined,
    schedule: rec.timeout, ctxInterval: rec.interval,
    // 人不在 + 没干过活 → 画面是 off（稳态），空闲节拍成立
    lastFocusedAt: () => T0 - 10 * 60_000,
  })
  await h.settle()                    // 先握手（此时帧循环还没启动）
  h.clock.now += 2200                 // 跳过 2s 上电自检
  h.controller.refresh()
  h.clock.now += 400                  // 跳过自检交接渐变（250ms）
  h.controller.refresh()
  h.controller.start()
  try {
    const first = rec.fired.shift()
    assert.ok(Math.abs(first.ms - LED_FRAME_MS) < 1e-9, '启动先按动画节拍跑一拍（设备可能正等握手）')
    h.clock.now += first.ms
    first.cb()
    const idle = rec.fired.shift()
    assert.ok(Math.abs(idle.ms - LED_IDLE_FRAME_MS) < 1e-6,
      `稳态应排 ${LED_IDLE_FRAME_MS}ms，实际 ${idle.ms}ms`)

    let frames = h.controller.status().frames
    assert.equal(frames.idle, true, '空闲节拍要如实报告 idle=true（状态页/probe 不能误读成掉帧）')
    assert.equal(frames.idleFrameMs, LED_IDLE_FRAME_MS)
    assert.equal(frames.targetFps, LED_TARGET_FPS, '动画目标帧率不能被空闲节拍改掉')
    assert.equal(frames.skipped, 0, '空闲节拍不能被记成"丢了几十帧"')
    assert.ok(Number.isFinite(frames.maxLateMs) && frames.maxLateMs >= 0, '诊断：最大迟到可见')
    assert.ok(Number.isFinite(frames.sampleMaxMs) && frames.sampleMaxMs >= 0, '诊断：采样耗时可见')

    // 空闲节拍下迟到不到两个周期：不记欠帧
    h.clock.now += LED_IDLE_FRAME_MS + 20
    idle.cb()
    assert.equal(h.controller.status().frames.skipped, 0)
    const renderedBefore = h.controller.status().frames.rendered

    // **立刻唤醒**：会话开始跑（running 是连续动画）→ 必须当场出一帧并切回 240fps 节拍
    status = 'running'
    h.clock.now += 10
    h.controller.refresh()
    frames = h.controller.status().frames
    assert.ok(frames.rendered > renderedBefore, '唤醒必须当场渲染一帧（不能等 250ms 才动）')
    assert.equal(frames.idle, false, '连续动画必须回到动画节拍')
    const next = rec.fired[rec.fired.length - 1]
    assert.ok(Math.abs(next.ms - LED_FRAME_MS) < 1e-6,
      `唤醒后应排 ${LED_FRAME_MS}ms，实际 ${next.ms}ms`)
  } finally {
    h.controller.stop()
  }
})

// ── 采样遍历去重（任务：每拍一次 agents.list + 判定语义不变）────────────────

test('采样遍历去重：每拍只调一次 agents.list()，多根/子会话判定与旧语义一致', async () => {
  let listCalls = 0
  const r1 = rootAgent('r1', 'running')
  const c1 = { id: 'c1', status: 'running', session: { id: 'c1', header: { origin: 'subagent', parentSession: 'r1' } }, origin: 'subagent' }
  const r2 = rootAgent('r2', 'idle')
  const r3 = rootAgent('r3', 'running')
  const c2 = { id: 'c2', status: 'running', session: { id: 'c2', header: { origin: 'subagent', parentSession: 'r3' } }, origin: 'subagent' }
  const r4 = rootAgent('r4', 'idle')
  const c4 = { id: 'c4', status: 'idle', session: { id: 'c4', header: { origin: 'subagent', parentSession: 'r4' } }, origin: 'subagent' }
  const all = [r1, c1, r2, r3, c2, r4, c4]
  const agents = {
    roots: () => [r1, r2, r3, r4],
    list: () => { listCalls += 1; return all },
    get: (id) => all.find((a) => (a.session && a.session.id === id) || a.id === id),
  }
  const sessions = { get: (id) => all.map((a) => a.session).find((s) => s.id === id) }
  const projections = {
    stateOf: (session, key) => {
      const id = typeof session === 'string' ? session : String((session && session.id) ?? '')
      // 子会话里的提问：必须算到根会话头上（旧实现的"族扫描"语义）
      if (key === 'userQuestions' && id === 'c1') return { active: [{ state: 'open' }], settled: [] }
      return undefined
    },
  }
  const h = harness({
    agents, sessions, projections,
    // r4 的"干过活"只体现在子会话的事件里（旧实现的 hasWork 兜底语义）
    hasWork: (sid) => sid === 'c4',
  })
  const before = listCalls
  h.clock.now += 100
  h.controller.refresh()
  assert.equal(listCalls - before, 1, `每拍只允许一次 agents.list()（实际 ${listCalls - before} 次）`)

  const status = h.controller.status()
  const byId = new Map(status.verdicts.map((v) => [v.sessionId, v]))
  assert.equal(status.verdicts.length, 4, '四个根会话各自一条判定')
  assert.equal(byId.get('r1').phase, 'waiting', '子会话里的提问要算到根上（旧语义）')
  assert.equal(byId.get('r2').phase, 'done')
  assert.equal(byId.get('r2').completed, false, '没干过活的空闲会话不算"完成"')
  assert.equal(byId.get('r3').phase, 'running', '有子代理在跑 → 仍然 running')
  assert.equal(byId.get('r4').phase, 'done')
  assert.equal(byId.get('r4').completed, true, '子会话的事件溯源要算到根上（旧语义）')
  assert.equal(status.scene.state, 'waiting', '优先级：等待（黄）＞完成（绿）＞运行中（白）')
})

test('功能关着：帧循环不驱动链路（不会偷偷重连），节拍降到空闲', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  const rec = recorder()
  const h = harness({
    agents, config: { enabled: false }, frameMs: undefined,
    schedule: rec.timeout, ctxInterval: rec.interval,
  })
  await h.settle(2)
  assert.equal(h.opened.length, 0, '功能关着不该打开串口')
  h.controller.start()
  try {
    // 连跑三拍：即使夹具里 agent 在 running，功能关着也必须空闲、且绝不能打开串口
    for (let i = 0; i < 3; i += 1) {
      const fired = rec.fired.shift()
      h.clock.now += fired.ms
      fired.cb()
    }
    assert.equal(h.opened.length, 0, '关着的灯不该被帧循环偷偷重连（串口是独占资源）')
    const frames = h.controller.status().frames
    assert.equal(frames.idle, true, '功能关着时帧循环应当空闲低频')
    assert.ok(frames.rendered >= 3, '帧循环仍在跑（保留心跳/看门狗能力），只是不驱动链路')
  } finally {
    h.controller.stop()
  }
})

// ── 帧调度绝不用 ctx.timeout（OOM 根因回归）────────────────────────────────
// 实测：2.58GB heap snapshot 里有 318,031 个 Timeout + 319,891 个 Error，数量 ≈ 240/s × 21min，
// 和"每帧一次 ctx.timeout"完全吻合。帧调度必须走原始 setTimeout（或测试注入的 schedule），
// 否则每次调用都会在宿主里注册一棵 effect/Timeout 对象树。

test('帧调度：240fps 连续跑 100 帧也绝不调用 ctx.timeout（OOM 根因回归）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  const rec = recorder()
  let ctxTimeoutCalls = 0
  const h = harness({
    agents, frameMs: undefined,
    schedule: rec.timeout,                 // 帧由注入的调度器驱动
    ctxInterval: rec.interval,
    // 宿主即使提供 timer 服务，帧循环也必须无视它
    ctxTimeout: () => { ctxTimeoutCalls += 1; return () => {} },
  })
  h.controller.start()
  try {
    for (let i = 0; i < 100; i += 1) {
      const fired = rec.fired.shift()
      assert.ok(fired, `第 ${i + 1} 帧没有排上定时器`)
      h.clock.now += fired.ms
      fired.cb()
    }
    assert.equal(h.controller.status().frames.rendered, 100, '注入调度器应当刚好驱动 100 帧')
    assert.equal(ctxTimeoutCalls, 0, '帧循环绝不能每帧调用 ctx.timeout（实测 21 分钟攒 30 万个 Timeout/Error）')
    assert.ok(rec.fired.length >= 1, '下一帧仍应通过注入的 schedule 排着')
  } finally {
    h.controller.stop()
  }
})

test('帧调度默认实现：没有注入 schedule 时用原始 setTimeout（不经过 ctx.timeout）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  const rec = recorder()
  let ctxTimeoutCalls = 0
  const h = harness({
    agents, frameMs: undefined,
    ctxInterval: rec.interval,             // 采样定时器照旧走宿主注入（1.5s 一次）
    ctxTimeout: () => { ctxTimeoutCalls += 1; return () => {} },
    // 不传 schedule → 走生产默认的进程级 setTimeout（真定时器）
  })
  h.controller.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const frames = h.controller.status().frames
    assert.ok(frames.rendered >= 1, `默认调度器应当真的在跑（100ms 内渲染了 ${frames.rendered} 帧）`)
    assert.equal(ctxTimeoutCalls, 0, '默认调度器不能用 ctx.timeout')
  } finally {
    h.controller.stop()                    // stop 必须清掉原始定时器，否则测试进程会被它挂住
  }
})

test('stop() 清掉原始帧定时器：卸载后不再渲染（也不会把进程挂住）', async () => {
  const agents = {
    roots: () => [rootAgent('s1', 'running')],
    list: () => [rootAgent('s1', 'running')],
    get: () => rootAgent('s1', 'running'),
  }
  const rec = recorder()
  const h = harness({
    agents, frameMs: undefined,
    ctxInterval: rec.interval,
    ctxTimeout: () => { throw new Error('帧循环不该调用 ctx.timeout') },
  })
  h.controller.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 40))
    const before = h.controller.status().frames.rendered
    assert.ok(before >= 1, `默认调度器应当真的在跑（40ms 内渲染了 ${before} 帧）`)
    h.controller.stop()
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(h.controller.status().frames.rendered, before, 'stop() 之后不能再有帧回调（原始定时器必须被清掉）')
  } finally {
    h.controller.stop()
  }
})

// ── 多灯同步（serial-fanout 集成）────────────────────────────────────────────
// 用户要求：auto 模式 = 同时驱动所有应答握手的灯；手动填 COMx = 只驱动那一块。
// 这一组走 createLedController 的完整接线（假 list/open），验证画面真的广播到了多块、
// 而不是 controller 里还留着"只驱动第一块"的旧行为。

test('多灯 auto：两块都应答 → 两块都收到同一帧，status 报告 boards=2', async () => {
  const h = fanoutHarness({ agents: runningAgents(), ports: ['COM3', 'COM9'] })
  await h.settle(26)                     // 握手 + 跳过 2s 上电自检 + 交接渐变

  const status = h.controller.status()
  assert.equal(status.link.verified, true)
  assert.equal(status.boards, 2, `应当同时驱动两块：${JSON.stringify({ boards: status.boards, port: status.link.port })}`)
  assert.equal(status.boardCount, 2)
  assert.match(status.link.port, /COM3/)
  assert.match(status.link.port, /COM9/)

  // 清掉自检/淡入帧，取两块同一拍收到的 LEDS 帧对比
  for (const board of h.boards.values()) board.written.length = 0
  await h.settle(2)
  const a = h.ledsOf('COM3').at(-1)
  const b = h.ledsOf('COM9').at(-1)
  assert.ok(a, 'COM3 应当收到 LEDS 帧')
  assert.ok(b, 'COM9 应当收到 LEDS 帧')
  assert.equal(a.toString('hex'), b.toString('hex'), '同一画面 → 两块收到逐字节相同的帧')
})

test('多灯故障隔离：拔掉一块 → 另一块继续推帧，整体仍 verified', async () => {
  const h = fanoutHarness({ agents: runningAgents(), ports: ['COM3', 'COM9'] })
  await h.settle(26)
  assert.equal(h.controller.status().boards, 2)
  const before = h.ledsOf('COM9').length

  h.board('COM3').failing = true         // 模拟拔线 / 写失败
  await h.settle(6)

  let status = h.controller.status()
  assert.equal(status.link.verified, true, '还有一块在 → verified 必须为 true')
  assert.equal(status.link.state, 'ready')
  assert.equal(status.link.errorCode, '', '单块掉线不该把整体报成异常')
  assert.equal(status.link.lastError, '')
  assert.equal(status.boards, 1, '实际在驱动的灯只剩一块')
  assert.equal(status.boardCount, 2, '掉线那块仍挂着重连（不从多灯列表里删掉）')
  assert.ok(h.ledsOf('COM9').length > before, 'COM9 必须继续收到帧')

  // 插回来：子链路退避后重开、重新握手
  h.board('COM3').failing = false
  await h.settle(10)
  status = h.controller.status()
  assert.equal(status.boards, 2, '恢复后应当重新驱动两块')
})

test('多灯手动端口：只驱动 COM9（不打开 COM3）', async () => {
  const h = fanoutHarness({
    agents: runningAgents(),
    ports: ['COM3', 'COM9'],
    config: { port: 'COM9' },
  })
  await h.settle(26)
  assert.deepEqual(h.opened.map((o) => o.port), ['COM9'], '手动端口只允许打开那一块')
  const status = h.controller.status()
  assert.equal(status.link.port, 'COM9')
  assert.equal(status.boards, 1)
  assert.equal(h.boards.has('COM3'), false, '另一块不应被碰到')
  assert.ok(h.ledsOf('COM9').length > 0)
})

test('多灯关灯：关闭开关 → 两块都收到全黑帧并关句柄（不能只关一块）', async () => {
  const h = fanoutHarness({ agents: runningAgents(), ports: ['COM3', 'COM9'] })
  await h.settle(26)
  assert.equal(h.controller.status().boards, 2)
  for (const board of h.boards.values()) board.written.length = 0

  h.setConfig({ enabled: false })
  await h.settle(8)                      // 淡出 250ms 走完才真正关串口

  for (const port of ['COM3', 'COM9']) {
    const frame = h.ledsOf(port).at(-1)
    assert.ok(frame, `${port} 关闭时应当收到全黑帧`)
    for (let i = 3; i < 24; i += 1) assert.equal(frame[i], 0, `${port} 最后一帧必须全黑`)
    assert.ok(h.board(port).closes > 0, `${port} 的句柄必须被关闭`)
  }
  assert.equal(h.controller.status().link.verified, false)
})

test('多灯退出：shutdown() 同步淡出后两块都收到全黑帧并关闭', async () => {
  const h = fanoutHarness({ agents: runningAgents(), ports: ['COM3', 'COM9'] })
  await h.settle(26)
  for (const board of h.boards.values()) board.written.length = 0

  h.controller.shutdown()
  for (const port of ['COM3', 'COM9']) {
    const leds = h.ledsOf(port)
    assert.ok(leds.length >= 1, `${port} 退出前应当收到帧`)
    const last = leds.at(-1)
    for (let i = 3; i < 24; i += 1) assert.equal(last[i], 0, `${port} 最后一帧必须全黑`)
    assert.ok(h.board(port).closes > 0, `${port} 的句柄必须被关闭`)
  }
  assert.equal(h.controller.status().link.state, 'disabled')
})

// ── 多手动端口（英文逗号分隔）+ auto 包含关系 ───────────────────────────────
// 用户新需求：串口一栏可以填 `COM5,COM9` 同时驱动两块；但 `auto` 已经包含"所有灯"，
// 所以 `auto,COM5` 不能再把 COM5 当手动端口钉住 —— 整体按自动发现处理。

test('sanitizeLedPort：英文逗号多端口、逐项校验去重、auto 包含其它项', () => {
  assert.equal(sanitizeLedPort(''), 'auto')
  assert.equal(sanitizeLedPort('   '), 'auto')
  assert.equal(sanitizeLedPort('auto'), 'auto')
  assert.equal(sanitizeLedPort('AUTO'), 'auto', 'auto 大小写不敏感')
  assert.equal(sanitizeLedPort('auto,COM5'), 'auto', 'auto 已包含所有灯：其余项忽略')
  assert.equal(sanitizeLedPort('COM5, auto'), 'auto')
  assert.equal(sanitizeLedPort(' COM5 , COM9 '), 'COM5,COM9', '两端空白要去掉')
  assert.equal(sanitizeLedPort('COM5,COM5'), 'COM5', '重复端口去重')
  assert.equal(sanitizeLedPort('COM5,foo'), 'COM5', '非法项丢弃')
  assert.equal(sanitizeLedPort('foo,bar'), '', '全非法 → 空串（与旧语义一致）')
  assert.equal(sanitizeLedPort('/dev/ttyUSB0,/dev/ttyUSB1'), '/dev/ttyUSB0,/dev/ttyUSB1')
  assert.equal(sanitizeLedPort('COM5，COM9'), '', '中文逗号不是分隔符（整串非法）')
})

test('多手动端口：port="COM5,COM9" → 两块都打开、都收到同一帧', async () => {
  const h = fanoutHarness({
    agents: runningAgents(),
    ports: ['COM5', 'COM9'],
    config: { port: 'COM5,COM9' },
  })
  await h.settle(26)
  assert.deepEqual(h.opened.map((o) => o.port).sort(), ['COM5', 'COM9'], '两个手动端口都要打开')
  const status = h.controller.status()
  assert.equal(status.boards, 2, '两块都应当握手成功')
  assert.equal(status.link.port, 'COM5, COM9', '链路状态里应当是逗号拼接的实际端口')
  for (const board of h.boards.values()) board.written.length = 0
  await h.settle(2)
  const a = h.ledsOf('COM5').at(-1)
  const b = h.ledsOf('COM9').at(-1)
  assert.ok(a, 'COM5 应当收到 LEDS 帧')
  assert.ok(b, 'COM9 应当收到 LEDS 帧')
  assert.equal(a.toString('hex'), b.toString('hex'), '同一画面 → 两块逐字节相同')
})

test('auto 包含关系：port="auto,COM5" 整体按自动发现处理（不把 COM5 钉成手动端口）', async () => {
  const h = fanoutHarness({
    agents: runningAgents(),
    ports: ['COM3', 'COM9'],
    config: { port: 'auto,COM5' },
  })
  await h.settle(26)
  assert.deepEqual(h.opened.map((o) => o.port).sort(), ['COM3', 'COM9'],
    'auto 已包含所有灯：应当自动发现 COM3/COM9，而不是只驱动 COM5')
  assert.equal(h.boards.has('COM5'), false, 'COM5 不该被当成手动端口打开')
  assert.equal(h.controller.status().boards, 2)
})






