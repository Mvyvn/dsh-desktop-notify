// 多灯扇出层：auto 发现 / 广播 / 冷却 / 故障隔离 / 手动端口
//
// 全部用注入的假 list/open 句柄跑，不需要真板子（与 serial-link.test.mjs 同一套注入方式），
// 时钟也是注入的：这层的价值就在"什么时候建子链路、什么时候关、什么时候重试"，
// 用真实时间写会变成 flaky 的睡眠测试。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSerialFanout, parsePortSpec } from '../lib/serial-fanout.js'
import { VERIFY_REPLY, encodeLeds } from '../lib/led-protocol.js'
import { renderPixels } from '../lib/led-render.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 一块假板子：应不应答验证帧、写失败开关、收到的字节。 */
function makeBoard(port, answers) {
  return {
    port,
    answers,
    written: [],
    /** 下次 read() 要交给链路的回包。每次 open 都重新准备（重连后板子会再回一次）。 */
    replyQueue: Buffer.alloc(0),
    closes: 0,
    failing: false,
  }
}

/**
 * 假世界：端口枚举 + 打开句柄。
 * 每个端口对应一块假板子；`answers(port)` 决定它在验证窗口内回不回包。
 */
function makeWorld(initialPorts, options = {}) {
  const clock = { now: 10_000 }
  const ports = [...initialPorts]
  const boards = new Map()
  const opened = []
  const listCalls = []
  const logs = []
  const answers = options.answers ?? (() => true)

  function boardFor(port) {
    let board = boards.get(port)
    if (!board) {
      board = makeBoard(port, answers(port))
      boards.set(port, board)
    }
    return board
  }

  async function open(port, baud) {
    opened.push({ port, baud })
    const board = boardFor(port)
    board.replyQueue = Buffer.from(board.answers ? VERIFY_REPLY : '', 'ascii')
    return {
      write(buf) {
        if (board.failing) throw new Error('写入失败')
        board.written.push(Buffer.from(buf))
        return buf.length
      },
      read() {
        const out = board.replyQueue
        board.replyQueue = Buffer.alloc(0)
        return out
      },
      close() { board.closes += 1 },
    }
  }

  async function list() {
    listCalls.push(clock.now)
    return ports.map((path) => ({
      path,
      // USB 转串口优先（autoPortOrder 的排序依据）；这里只影响发现顺序，不影响结论。
      label: /COM(7|11|13)/.test(path) ? 'USB-SERIAL CH340' : 'Intel 串行',
    }))
  }

  return { clock, ports, boards, opened, listCalls, logs, open, list }
}

function makeFanout(world, overrides = {}) {
  const fanout = createSerialFanout({
    port: 'auto',
    open: world.open,
    list: world.list,
    now: () => world.clock.now,
    log: (line) => world.logs.push(line),
    verifyTimeoutMs: 1500,
    heartbeatMs: 5000,
    discoverEveryMs: 15_000,
    rejectCooldownMs: 30_000,
    ...overrides,
  })
  return fanout
}

/** 跑几拍（每拍等异步 open/list 落地）。auto 发现→打开→握手正好需要 3 拍。 */
async function pump(fanout, ticks = 3) {
  for (let i = 0; i < ticks; i += 1) {
    fanout.tick()
    await flush()
  }
}

test('auto：两块都应答 → 都挂上，且收到逐字节相同的帧', async () => {
  const world = makeWorld(['COM3', 'COM7'])
  const fanout = makeFanout(world)
  await pump(fanout, 3)

  const st = fanout.status()
  assert.equal(st.verified, true)
  assert.equal(st.boardCount, 2)
  assert.equal(st.verifiedCount, 2)
  assert.deepEqual(st.boards.map((b) => b.port).sort(), ['COM3', 'COM7'])
  assert.match(st.port, /COM3/)
  assert.match(st.port, /COM7/)

  // 稳态画面（done + MUTED 不闪烁、不做时间抖动）→ 两块渲染结果必须逐字节一致。
  const scene = { state: 'done', flags: 2, brightness: 255, latched: false, reason: 'test' }
  fanout.applyScene(scene)
  world.clock.now += 500           // 跳过 300ms 交叉渐变
  fanout.tick()

  const frames = ['COM3', 'COM7'].map((p) => world.boards.get(p).written.filter((b) => b[2] === 0x01).at(-1))
  assert.ok(frames[0], 'COM3 应当收到 LEDS 帧')
  assert.ok(frames[1], 'COM7 应当收到 LEDS 帧')
  assert.equal(frames[0].toString('hex'), frames[1].toString('hex'), '同一画面 → 两块收到逐字节相同的帧')
  assert.equal(
    frames[0].toString('hex'),
    encodeLeds(renderPixels(scene, world.clock.now)).toString('hex'),
    '帧内容必须就是渲染器的输出（扇出层不改画面）',
  )

  // 蜂鸣/控制帧也广播到每一块（只让一块响等于没做多灯）
  for (const board of world.boards.values()) board.written.length = 0
  assert.equal(fanout.beep({ freqHz: 440, volume: 50, durationMs: 100 }), true)
  for (const p of ['COM3', 'COM7']) {
    const last = world.boards.get(p).written.at(-1)
    assert.ok(last && last[2] === 0x02, `${p} 应当收到蜂鸣帧`)
  }
})

test('auto：一块不应答 → 只挂应答的那块，且 30s 冷却期内不再试', async () => {
  const world = makeWorld(['COM3', 'COM7'], { answers: (port) => port === 'COM7' })
  const fanout = makeFanout(world)
  await pump(fanout, 3)

  assert.equal(fanout.status().verified, true, 'COM7 应当已握手')
  assert.equal(fanout.status().boardCount, 2, '两块都在候选窗口里')

  // 越过 COM3 的 1500ms 验证窗口：子链路自己判 verify-timeout → 扇出层关掉并冷却
  world.clock.now += 1600
  fanout.tick()
  await flush()

  const st = fanout.status()
  assert.equal(st.boardCount, 1)
  assert.equal(st.verifiedCount, 1)
  assert.deepEqual(st.boards.map((b) => b.port), ['COM7'])
  assert.equal(world.opened.filter((o) => o.port === 'COM3').length, 1, '不应答的口只试一次（不替它无限重试）')

  // 冷却期内（<30s）重新枚举也不该再打开 COM3
  world.clock.now += 15_000
  fanout.tick()
  await flush()
  assert.equal(world.opened.filter((o) => o.port === 'COM3').length, 1, '冷却期内不能再试 COM3')

  // 冷却结束（>30s）后，下一轮枚举重新尝试（可能是刚换的新灯）
  world.clock.now += 16_000
  fanout.tick()
  await flush()
  fanout.tick()
  await flush()
  assert.equal(world.opened.filter((o) => o.port === 'COM3').length, 2, '冷却结束后应重新尝试')
})

test('手动端口：只开那一块，不枚举（list 一次都不调用）', async () => {
  const world = makeWorld(['COM3', 'COM7'])
  const fanout = makeFanout(world, { port: 'COM7' })
  await pump(fanout, 3)

  const st = fanout.status()
  assert.equal(st.verified, true)
  assert.equal(st.port, 'COM7')
  assert.equal(st.boardCount, 1)
  assert.equal(world.listCalls.length, 0, '手动模式不该枚举端口')
  assert.deepEqual(world.opened.map((o) => o.port), ['COM7'])
  assert.equal(world.opened[0].baud, 115200)
})

test('端口解析：英文逗号分隔多个端口；出现 auto 就整体按 auto（包含关系），非法项丢弃', () => {
  const spec = (raw) => parsePortSpec(raw)
  assert.deepEqual(spec(''), { auto: true, ports: [] })
  assert.deepEqual(spec('auto'), { auto: true, ports: [] })
  assert.deepEqual(spec('AUTO'), { auto: true, ports: [] }, 'auto 大小写不敏感')
  assert.deepEqual(spec('auto,COM5'), { auto: true, ports: [] }, 'auto 已包含其它 → 忽略 COM5')
  assert.deepEqual(spec('COM5,auto'), { auto: true, ports: [] })
  assert.deepEqual(spec('COM5'), { auto: false, ports: ['COM5'] })
  assert.deepEqual(spec('COM5, COM9'), { auto: false, ports: ['COM5', 'COM9'] }, '逗号分隔 + 去空白')
  assert.deepEqual(spec('COM5,COM5'), { auto: false, ports: ['COM5'] }, '重复项去重')
  assert.deepEqual(spec('COM5,,foo,COM9'), { auto: false, ports: ['COM5', 'COM9'] }, '空项/非法项丢弃')
  assert.deepEqual(spec('foo,bar'), { auto: true, ports: [] }, '全非法 → 退回 auto（不把灯钉死在死端口）')
  assert.deepEqual(spec('/dev/ttyUSB0,/dev/ttyUSB1'), { auto: false, ports: ['/dev/ttyUSB0', '/dev/ttyUSB1'] })
})

test('手动多端口：逗号分隔时每个口都打开、都收帧；改成子集时关掉多余的口', async () => {
  const world = makeWorld(['COM3', 'COM7', 'COM11'])
  const fanout = makeFanout(world, { port: 'COM3,COM7' })
  await pump(fanout, 3)

  const st = fanout.status()
  assert.equal(st.verified, true)
  assert.equal(st.boardCount, 2)
  assert.equal(st.verifiedCount, 2)
  assert.equal(st.port, 'COM3, COM7')
  assert.equal(world.listCalls.length, 0, '手动多端口也不枚举')
  assert.deepEqual(world.opened.map((o) => o.port).sort(), ['COM3', 'COM7'], '只开列出的口')

  const scene = { state: 'done', flags: 2, brightness: 255, latched: false, reason: 'test' }
  fanout.applyScene(scene)
  world.clock.now += 500
  fanout.tick()
  for (const p of ['COM3', 'COM7']) {
    assert.ok(world.boards.get(p).written.some((b) => b[2] === 0x01), `${p} 应当收到 LEDS 帧`)
  }
  assert.equal(world.boards.has('COM11'), false, '没列出的口连假板子都不该被创建（从未 open）')
  assert.equal(world.opened.some((o) => o.port === 'COM11'), false, '没列出的口不该被打开')

  // 改成子集：COM7 应被关闭，只剩 COM3
  fanout.configure('COM3', 115200)
  await flush()
  fanout.tick()
  await flush()
  assert.ok(world.boards.get('COM7').closes >= 1, '从列表里移除的端口应当关闭')
  assert.equal(world.boards.get('COM3').closes, 0, '保留的端口不重建')
  assert.equal(fanout.status().boardCount, 1)
  assert.equal(fanout.status().port, 'COM3')

  // 再填 auto,COM9：整体 auto（会枚举现有三个口），不按手动 COM9 处理
  fanout.configure('auto,COM9', 115200)
  await pump(fanout, 2)
  assert.equal(world.listCalls.length > 0, true, 'auto 模式应当开始枚举')
})

test('故障隔离：一块中途掉线 → 另一块继续推帧，掉线那块自己重连', async () => {
  const world = makeWorld(['COM3', 'COM7'])
  const fanout = makeFanout(world)
  await pump(fanout, 3)
  assert.equal(fanout.status().verified, true)

  const scene = { state: 'running', flags: 0, brightness: 200, latched: false, reason: '' }
  fanout.applyScene(scene)
  world.clock.now += 500
  fanout.tick()
  const com7FramesBefore = world.boards.get('COM7').written.filter((b) => b[2] === 0x01).length
  assert.ok(com7FramesBefore > 0)

  // COM3 拔线/写失败：子链路自己处理重连，不能影响 COM7
  world.boards.get('COM3').failing = true
  world.clock.now += 100
  fanout.tick()
  world.clock.now += 100
  fanout.tick()

  const broken = fanout.status()
  assert.equal(broken.verified, true, '只要还有一块在，整体 verified 必须为 true')
  assert.equal(broken.state, 'ready')
  const com7FramesAfter = world.boards.get('COM7').written.filter((b) => b[2] === 0x01).length
  assert.ok(com7FramesAfter > com7FramesBefore, 'COM7 应当继续收到帧')
  // 掉线那块仍留在列表里（等它自己退避重连），但状态是 error
  assert.equal(broken.boardCount, 2)
  assert.equal(broken.boards.find((b) => b.port === 'COM3').state, 'error')

  // 插回来：子链路退避 300ms 后重开，重新握手成功 → 两块都恢复
  world.boards.get('COM3').failing = false
  world.clock.now += 400
  fanout.tick()
  await flush()
  fanout.tick()
  await flush()
  assert.equal(fanout.status().verifiedCount, 2, '掉线那块应当重连回来')
})

test('新端口后来出现：下一轮枚举自动挂上，不影响已连的灯', async () => {
  const world = makeWorld(['COM7'])
  const fanout = makeFanout(world)
  await pump(fanout, 3)
  assert.equal(fanout.status().verifiedCount, 1)

  world.ports.push('COM11')
  world.clock.now += 16_000
  await pump(fanout, 3)

  const st = fanout.status()
  assert.equal(st.verifiedCount, 2)
  assert.deepEqual(st.boards.map((b) => b.port).sort(), ['COM11', 'COM7'])
  assert.deepEqual(world.opened.map((o) => o.port).sort(), ['COM11', 'COM7'])
})

test('configure：auto → COMx 只留一块；空字符串 = 回到 auto', async () => {
  const world = makeWorld(['COM3', 'COM7'])
  const fanout = makeFanout(world)
  await pump(fanout, 3)
  assert.equal(fanout.status().boardCount, 2)
  const com3Closes = world.boards.get('COM3').closes
  const com7Closes = world.boards.get('COM7').closes

  // 改成手动 COM7：旧的两条子链路必须先关掉，然后只开 COM7
  fanout.configure('COM7')
  assert.equal(fanout.status().boardCount, 0)
  assert.ok(world.boards.get('COM3').closes > com3Closes, '旧子链路必须被关闭')
  assert.ok(world.boards.get('COM7').closes > com7Closes, '旧子链路必须被关闭')
  await pump(fanout, 3)
  assert.equal(fanout.status().port, 'COM7')
  assert.equal(fanout.status().boardCount, 1)
  assert.equal(fanout.status().verified, true)
  assert.equal(world.opened.filter((o) => o.port === 'COM3').length, 1, '手动模式不能再打开 COM3')
  assert.equal(world.opened.filter((o) => o.port === 'COM7').length, 2)

  // 同配置重复 configure 是 no-op（不能因为 controller 每拍都调就反复重连）
  const closesAfter = world.boards.get('COM7').closes
  fanout.configure('COM7')
  assert.equal(world.boards.get('COM7').closes, closesAfter)

  // 空字符串 = auto：重新枚举，把两块都挂回来
  fanout.configure('')
  assert.equal(fanout.status().boardCount, 0)
  await pump(fanout, 3)
  const st = fanout.status()
  assert.equal(st.boardCount, 2)
  assert.equal(st.verifiedCount, 2)
  assert.match(st.port, /COM3/)
  assert.match(st.port, /COM7/)
})

test('迟到结果作废：configure 之后回来的枚举结果不能再挂子链路', async () => {
  const world = makeWorld(['COM3', 'COM7'])
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fanout = createSerialFanout({
    port: 'auto',
    open: world.open,
    // 枚举挂起：模拟 Windows 设备栈慢/卡，期间用户把端口改成了手动 COM7
    list: () => gate.then(() => world.list()),
    now: () => world.clock.now,
    log: (line) => world.logs.push(line),
    verifyTimeoutMs: 1500,
    heartbeatMs: 5000,
  })
  fanout.tick()                       // 发起枚举（挂起）
  fanout.configure('COM7')            // 代次 +1：这轮枚举必须作废
  release()
  await flush()

  assert.equal(fanout.status().boardCount, 0, '迟到的枚举结果不能给 auto 模式挂子链路')
  await pump(fanout, 3)
  assert.deepEqual(world.opened.map((o) => o.port), ['COM7'], '手动模式只开 COM7')
})

test('needsFrames：枚举在飞 / 握手窗口要连续帧，稳态（off）不要', async () => {
  const world = makeWorld(['COM3', 'COM7'])
  const fanout = makeFanout(world)

  fanout.tick()                          // 发起枚举（在飞）
  assert.equal(fanout.needsFrames(), true, '枚举在飞时要连续帧把候选挂上')
  await flush()                          // 子链路建好，还没打开

  fanout.tick()
  await flush()                          // 打开 → 各自在验证窗口里
  assert.equal(fanout.needsFrames(), true, '握手窗口要连续帧（验证帧重发/回包读取靠它推进）')

  fanout.tick()
  await flush()                          // 握手成功；场景是 off 稳态
  assert.equal(fanout.status().verified, true)
  assert.equal(fanout.needsFrames(), false, 'off 稳态不需要连续帧（心跳/探测够用）')
})

test('flush / close 广播到每一块（关灯不能只关一块）', async () => {
  const world = makeWorld(['COM3', 'COM7'])
  const fanout = makeFanout(world)
  await pump(fanout, 3)

  const off = { state: 'off', flags: 0, brightness: 0, latched: false, reason: '关闭' }
  assert.equal(fanout.flush(off), true)
  const black = encodeLeds(Array.from({ length: 7 }, () => ({ r: 0, g: 0, b: 0 })))
  for (const p of ['COM3', 'COM7']) {
    const frame = world.boards.get(p).written.filter((b) => b[2] === 0x01).at(-1)
    assert.ok(frame, `${p} 应当收到熄灯帧`)
    assert.equal(frame.toString('hex'), black.toString('hex'), `${p} 必须收到全黑帧`)
  }

  fanout.close()
  assert.equal(fanout.status().state, 'disabled')
  assert.equal(fanout.status().verified, false)
  for (const p of ['COM3', 'COM7']) {
    assert.ok(world.boards.get(p).closes > 0, `${p} 的句柄必须被关闭`)
  }
})

test('setOverride / restartFade 广播：自检动画对每块灯生效', async () => {
  const world = makeWorld(['COM3', 'COM7'])
  const fanout = makeFanout(world)
  await pump(fanout, 3)

  const fixed = Array.from({ length: 7 }, (_, i) => ({ r: 10 + i, g: 20 + i, b: 30 + i }))
  fanout.setOverride(() => fixed)
  fanout.tick()
  const expected = encodeLeds(fixed).toString('hex')
  for (const p of ['COM3', 'COM7']) {
    const frame = world.boards.get(p).written.filter((b) => b[2] === 0x01).at(-1)
    assert.ok(frame, `${p} 应当收到覆盖渲染帧`)
    assert.equal(frame.toString('hex'), expected, `${p} 的覆盖画面必须一致`)
  }

  // 清掉覆盖 + restartFade：广播不抛异常，下一拍照常推进
  fanout.setOverride(null)
  fanout.restartFade()
  world.clock.now += 400
  fanout.tick()
  for (const p of ['COM3', 'COM7']) assert.ok(world.boards.get(p).written.length > 0)
})
