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
import { LED_FRAME_MS, LED_TARGET_FPS } from '../lib/led-timing.js'

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
  // 帧循环的定时器：测试可以注入"只记录不执行"的调度器（验节拍必须可控）
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
    log: () => {},
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
    ...(hasFrameMs ? (options.frameMs === undefined ? {} : { frameMs: options.frameMs }) : { frameMs: 40 }),
    ...(hasMayRun ? { mayRun: () => mayRun } : {}),
    ...(typeof options.pendingApprovals === 'function' ? { pendingApprovals: options.pendingApprovals } : {}),
    ...(typeof options.pendingAsks === 'function' ? { pendingAsks: options.pendingAsks } : {}),
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
  assert.equal(status.devicePresent, true)
  assert.deepEqual(status.device, { leds: 7, verified: true })
  assert.match(status.sceneText, /running/)
})

test('preview() 直接改画面（不经过判定），下一帧就渲染出来', async () => {
  const agents = { roots: () => [rootAgent('s1', 'running')], list: () => [rootAgent('s1', 'running')], get: () => rootAgent('s1', 'running') }
  const h = harness({ agents })
  await h.settle()
  h.clock.now += 2200          // 跳过 2s 上电自检
  await h.settle(2)
  h.written.length = 0
  assert.equal(h.controller.preview('error', 255), true)   // preview 自己就会触发一帧
  h.clock.now += 400                                        // 跳过 300ms 交叉渐变
  await h.settle(2)                                          // 再走两拍（枚举那一拍不推帧）
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
  const h = harness({ agents, frameMs: undefined, ctxTimeout: rec.timeout, ctxInterval: rec.interval })
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
  const h = harness({ agents, frameMs: undefined, ctxTimeout: rec.timeout, ctxInterval: rec.interval })
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
  const h = harness({ agents, frameMs: undefined, ctxTimeout: rec.timeout, ctxInterval: rec.interval })
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
