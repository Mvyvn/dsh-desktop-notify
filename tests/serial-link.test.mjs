// 串口链路（真协议）：握手 / 像素流 / 去重 / 心跳 / 重连
//
// 全部用注入的假句柄跑，不需要真板子。真实打开的路径见 serial-port.ts（Windows: koffi）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSerialLink, pickAutoPort, autoPortOrder, isValidPortName, RECONNECT_BACKOFF_MS, WRITE_DROPPED,
} from '../lib/serial-link.js'
import { VERIFY_REPLY, encodeLeds, encodeBuzzer } from '../lib/led-protocol.js'
import { OFF_SCENE } from '../lib/led-scene.js'
import { renderPixels } from '../lib/led-render.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function makeLink(port = 'COM7', options = {}) {
  const state = { now: 1000 }
  const written = []
  const opened = []
  // writeOnce / shortOnce：模拟**瞬时**故障（一次失败后恢复正常），用来验证"不轻易发黑帧"。
  // pending：模拟 Windows 传输层"还有一帧没落地"（自适应冗余的第二份要据此跳过）。
  const failing = { open: '', write: false, busy: false, writeOnce: false, shortOnce: 0, pending: 0 }
  let queue = options.reply === false ? Buffer.alloc(0) : Buffer.from(VERIFY_REPLY, 'ascii')
  /** 让下一次 read() 收到一条验证回包（握手 / 主动探测用）。 */
  const replyNow = () => { queue = Buffer.from(VERIFY_REPLY, 'ascii') }
  const handle = {
    write(buf, writeOptions) {
      if (failing.write) throw new Error('写入失败')
      if (failing.writeOnce) { failing.writeOnce = false; throw new Error('瞬时写入失败') }
      // 短写：只接受一部分（固件/驱动超时的典型表现），这一帧必须算失败
      if (failing.shortOnce > 0) { const n = failing.shortOnce; failing.shortOnce = 0; return n }
      // 有界队列模型：传输层积压时，**可丢的动画帧**被拒绝（控制帧必达）
      if (failing.busy && writeOptions && writeOptions.coalesce === true) return WRITE_DROPPED
      written.push(Buffer.from(buf))
      return buf.length
    },
    read() {
      const out = queue
      queue = Buffer.alloc(0)
      return out
    },
    close() {},
    pending() { return failing.pending },
  }
  const link = createSerialLink({
    port,
    open: async (p, b) => {
      if (failing.open) throw new Error(failing.open)
      opened.push({ port: p, baud: b })
      return handle
    },
    list: options.list || (async () => [{ path: 'COM7', label: 'USB-SERIAL CH340' }]),
    now: () => state.now,
    log: () => {},
    verifyTimeoutMs: 1000,
    heartbeatMs: 5000,
  })
  return {
    link, written, opened, failing, handle, state,
    advance(ms) { state.now += ms },
    /** 让下一次 read() 收到一条验证回包（握手 / 主动探测用）。 */
    replyNow,
    /** 连接到握手通过（省得每个用例重复三行）。 */
    async connect() {
      link.tick()
      await flush()
      replyNow()            // 重连时第一轮已经消费过回包：补一条，否则会卡在 verifying
      link.tick()
      await flush()
      assert.equal(link.status().state, 'ready', `握手应成功：${JSON.stringify(link.status())}`)
    },
  }
}

test('握手：打开后先发验证帧，收到 "AI Status Lights OK" 才算连上', async () => {
  const h = makeLink('COM7')
  h.link.tick()
  await flush()
  assert.equal(h.opened.length, 1)
  assert.equal(h.opened[0].baud, 115200)
  assert.equal(h.link.status().state, 'verifying')
  assert.equal(h.written[0].toString('hex'), '55aa00ffbb')
  h.link.tick()
  await flush()
  const status = h.link.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.verified, true)
  assert.equal(status.reply.verifies, 1)
})

test('握手超时：回包没来 → verify-timeout + 退避重试（不是本板子就别硬点亮）', async () => {
  const h = makeLink('COM7', { reply: false })
  h.link.tick()
  await flush()
  h.advance(1200)
  h.link.tick()
  await flush()
  const status = h.link.status()
  assert.equal(status.state, 'error')
  assert.equal(status.errorCode, 'verify-timeout')
  assert.ok(status.retryInMs > 0)
  assert.match(status.lastError, /没有回应验证帧/)
})

test('端口 auto：从枚举里挑（优先 CH340）', async () => {
  const h = makeLink('auto', {
    list: async () => [
      { path: 'COM3', label: 'Intel 串行' },
      { path: 'COM11', label: 'USB-SERIAL CH340' },
    ],
  })
  await h.connect()
  assert.equal(h.opened[0].port, 'COM11')
})

test('一个串口都没有 → errorCode=no-device（"还没接线"，不是故障）', async () => {
  const h = makeLink('auto', { list: async () => [] })
  h.link.tick()
  await flush()
  const status = h.link.status()
  assert.equal(status.errorCode, 'no-device')
  assert.match(status.lastError, /没有找到任何串口设备/)
  assert.ok(status.retryInMs > 0)
})

test('打不开端口 → open-failed；写失败 → write-failed', async () => {
  const h = makeLink('COM7')
  h.failing.open = '打不开串口 COM7'
  h.link.tick()
  await flush()
  assert.equal(h.link.status().errorCode, 'open-failed')
  h.failing.open = ''
  h.advance(RECONNECT_BACKOFF_MS[0])
  await h.connect()
  h.link.applyScene({ state: 'running', flags: 0, brightness: 200, latched: false, reason: '' })
  h.failing.write = true
  h.link.tick()
  assert.equal(h.link.status().errorCode, 'write-failed')
})

test('连上后：画面渲染成 26 字节 LEDS 帧；像素没变不重复写；5s 心跳重发', async () => {
  const h = makeLink('COM7')
  await h.connect()
  h.written.length = 0
  h.link.applyScene({ state: 'waiting', flags: 0, brightness: 200, latched: false, reason: '' })
  h.advance(500)          // 跳过淡入
  h.link.tick()
  const first = h.written[0]
  assert.equal(first.length, 26)
  assert.equal(first[0], 0x55)
  assert.equal(first[1], 0xaa)
  assert.equal(first[2], 0x01, 'MODE 0x01 = 设 7 灯颜色')
  assert.equal(first[25], 0xbb)
  h.link.tick()
  assert.equal(h.written.length, 1, '同一时刻像素没变 → 不写')
  h.advance(1000)
  h.link.tick()
  assert.equal(h.written.length, 2, '心跳 1s 到点要重发')
})

test('动画在动时每帧都写（像素变了就该发）', async () => {
  const h = makeLink('COM7')
  await h.connect()
  h.written.length = 0
  h.link.applyScene({ state: 'running', flags: 0, brightness: 200, latched: false, reason: '' })
  h.link.tick()
  h.advance(200)
  h.link.tick()
  assert.equal(h.written.length, 2, '彗星在动，两帧像素不同')
})

test('像素内容与渲染器一致（链路不偷偷改画面）', async () => {
  const h = makeLink('COM7')
  await h.connect()
  h.written.length = 0
  const scene = { state: 'done', flags: 2 /* MUTED：稳态，不做时间抖动 */, brightness: 255, latched: false, reason: '' }
  h.link.applyScene(scene)
  h.advance(500)          // 跳过 300ms 交叉渐变
  h.link.tick()
  const expected = encodeLeds(renderPixels(scene, 1500))
  assert.equal(h.written[h.written.length - 1].toString('hex'), expected.toString('hex'))
})

test('蜂鸣：10 字节 MODE 0x02（握手前不发）', async () => {
  const h = makeLink('COM7')
  h.link.tick()
  await flush()
  assert.equal(h.link.beep({ freqHz: 2000, volume: 100, durationMs: 500 }), false, '没握手就不该发')
  h.link.tick()
  await flush()
  h.written.length = 0
  assert.equal(h.link.beep({ freqHz: 2000, volume: 100, durationMs: 500 }), true)
  assert.equal(
    h.written[0].toString('hex'),
    encodeBuzzer({ freqHz: 2000, volume: 100, durationMs: 500 }).toString('hex'),
  )
})

test('close() 之后状态是 disabled，且不再写', async () => {
  const h = makeLink('COM7')
  await h.connect()
  h.link.close()
  assert.equal(h.link.status().state, 'disabled')
  h.written.length = 0
  h.link.tick()
  assert.equal(h.written.length, 0)
})

test('pickAutoPort / autoPortOrder / isValidPortName', () => {
  assert.equal(pickAutoPort([]), '')
  assert.equal(pickAutoPort([{ path: 'COM3', label: '' }, { path: 'COM11', label: 'CH340' }]), 'COM11')
  assert.equal(pickAutoPort([{ path: 'COM3', label: '' }, { path: 'COM9', label: '' }]), 'COM9')
  assert.equal(pickAutoPort([{ path: '/dev/ttyUSB0', label: '' }]), '/dev/ttyUSB0')
  // USB 转串口优先（CH34x / VCP / USBSER），同组 COM 号从大到小
  assert.deepEqual(
    autoPortOrder([
      { path: 'COM3', label: 'Intel 串行' },
      { path: 'COM20', label: '\\Device\\VCP0' },
      { path: 'COM7', label: 'USB-SERIAL CH340' },
    ]),
    ['COM20', 'COM7', 'COM3'],
  )
  assert.equal(isValidPortName('COM7'), true)
  assert.equal(isValidPortName('/dev/ttyUSB0'), true)
  assert.equal(isValidPortName('auto'), false)
  assert.equal(isValidPortName(''), false)
  assert.equal(isValidPortName('COM7; rm -rf'), false)
})

test('多串口同时在线：先试的口握手失败 → **换下一个候选**（不再死磕 COM19）', async () => {
  const clock = { now: 10_000 }
  const opened = []
  const silent = () => ({ write: (b) => b.length, read: () => Buffer.alloc(0), close: () => {} })
  const answering = () => {
    let reply = Buffer.from(VERIFY_REPLY, 'ascii')
    return {
      write: (b) => b.length,
      read: () => { const out = reply; reply = Buffer.alloc(0); return out },
      close: () => {},
    }
  }
  const link = createSerialLink({
    port: 'auto',
    open: async (p) => {
      opened.push(p)
      return p === 'COM7' ? answering() : silent()
    },
    list: async () => [
      { path: 'COM19', label: 'USB-SERIAL CH340' },
      { path: 'COM7', label: 'USB-SERIAL CH340' },
    ],
    now: () => clock.now,
    log: () => {},
    verifyTimeoutMs: 1500,
  })
  link.tick()                       // 打开候选 #1（COM19：按 COM 号大的先）
  await flush()
  assert.equal(opened[0], 'COM19')
  assert.equal(link.status().state, 'verifying')

  clock.now += 900                  // 越过候选窗口（800ms）
  link.tick()
  await flush()
  assert.equal(link.status().errorCode, 'verify-timeout')
  assert.match(link.status().lastError, /COM19/)

  clock.now += 300                  // 250ms 后换下一个，而不是重试 COM19
  link.tick()
  await flush()
  assert.deepEqual(opened, ['COM19', 'COM7'], '必须换下一个候选')

  link.tick()                       // COM7 回包 → 握手成功
  await flush()
  const status = link.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.port, 'COM7')
  assert.equal(status.verified, true)
})

test('所有串口都没应答：轮完一轮给出可操作提示，并进入 10s 重试', async () => {
  const clock = { now: 10_000 }
  const opened = []
  const silent = () => ({ write: (b) => b.length, read: () => Buffer.alloc(0), close: () => {} })
  const link = createSerialLink({
    port: 'auto',
    open: async (p) => { opened.push(p); return silent() },
    list: async () => [
      { path: 'COM19', label: '' },
      { path: 'COM7', label: '' },
    ],
    now: () => clock.now,
    log: () => {},
    verifyTimeoutMs: 1500,
  })
  link.tick(); await flush()        // COM19
  clock.now += 900; link.tick(); await flush()
  clock.now += 300; link.tick(); await flush()   // COM7
  clock.now += 900; link.tick(); await flush()   // 两个都不应答
  clock.now += 300; link.tick(); await flush()   // 候选耗尽 → 判定"没有可用设备"
  assert.deepEqual(opened, ['COM19', 'COM7'], '每个候选只试一次（不重复砸同一个口）')
  const status = link.status()
  assert.equal(status.errorCode, 'no-device')
  assert.match(status.lastError, /没有回应验证帧/)
  assert.ok(status.retryInMs > 0)
})

test('OFF_SCENE 常量的形状（链路默认画面）', () => {
  assert.equal(OFF_SCENE.state, 'off')
  assert.equal(OFF_SCENE.brightness, 0)
})

/** 把一帧 26 字节的 LEDS 帧解成 7 颗像素。 */
function decodePixels(frame) {
  const out = []
  for (let i = 0; i < 7; i += 1) out.push({ r: frame[3 + i * 3], g: frame[4 + i * 3], b: frame[5 + i * 3] })
  return out
}

test('画面切换有交叉渐变：300ms 内逐步混合，不是硬切', async () => {
  const h = makeLink('COM7')
  await h.connect()
  const A = { state: 'running', flags: 0, brightness: 255, latched: false, reason: '' }
  const B = { state: 'done', flags: 2 /* MUTED */, brightness: 255, latched: false, reason: '' }
  h.link.applyScene(A)
  h.link.tick()                                  // 先推 A
  const frameA = decodePixels(h.written[h.written.length - 1])
  h.link.applyScene(B)                           // 触发渐变
  h.advance(150)                                 // 渐变中点
  h.link.tick()
  const mid = decodePixels(h.written[h.written.length - 1])
  h.advance(400)                                 // 渐变结束
  h.link.tick()
  const end = decodePixels(h.written[h.written.length - 1])
  assert.notDeepEqual(mid, frameA, '中点不该还是旧画面（那就是硬切）')
  assert.notDeepEqual(mid, end, '中点也不该已经是新画面')
  // 中点的绿色分量应当介于 A 与 B 之间（A 冷白 r≈b、B 绿为主）
  assert.ok(mid[0].g > 0 && mid[0].g <= end[0].g, '渐变中途绿色应当在爬升')
})

test('并发开串口守卫：open 还在飞时不重复开同一个端口（否则会崩进程）', async () => {
  const { createSerialLink } = await import('../lib/serial-link.js')
  const clock = { now: 1000 }
  let openCalls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const handle = { write: (b) => b.length, read: () => Buffer.alloc(0), close: () => {} }
  const link = createSerialLink({
    port: 'COM7',
    open: async () => { openCalls += 1; await gate; return handle },
    list: async () => [{ path: 'COM7', label: '' }],
    now: () => clock.now,
    log: () => {},
  })
  link.tick()            // 第一次：发起 open（被 gate 挂起）
  clock.now += 8
  link.tick()            // 帧循环再来：守卫应当挡掉
  clock.now += 8
  link.tick()
  assert.equal(openCalls, 1, `同一个端口只能有一个 open 在飞：${openCalls}`)
  release()
  await flush()
  assert.ok(openCalls === 1)
})

test('主动探测：定期发验证帧，收不到回包就判断开（拔线时 WriteFile 可能"假成功"）', async () => {
  const h = makeLink('COM7')
  await h.connect()
  h.written.length = 0
  h.advance(2600)
  h.link.reap()
  const probe = h.written.find((b) => b.length === 5 && b[2] === 0)
  assert.ok(probe, '应当发出验证帧（MODE 0x00）')
  // 设备已经拔了：一直收不到回包
  h.advance(1300)
  h.link.reap()
  const status = h.link.status()
  assert.equal(status.state, 'error')
  assert.equal(status.errorCode, 'verify-timeout')
  assert.match(status.lastError, /无响应/)
})

test('写 0 字节时 **不能递归风暴**（曾经 142ms 内 3372 条日志，随后栈溢出卡死主线程）', async () => {
  const { createSerialLink } = await import('../lib/serial-link.js')
  const clock = { now: 1000 }
  const logs = []
  // 句柄：永远写 0 字节（等价于"设备被拔掉，写超时返回 0"）
  const deadHandle = { write: () => 0, read: () => Buffer.alloc(0), close: () => {} }
  let opens = 0
  const link = createSerialLink({
    port: 'COM7',
    open: async () => { opens += 1; return deadHandle },
    list: async () => [{ path: 'COM7', label: '' }],
    now: () => clock.now,
    log: (line) => logs.push(line),
  })
  // 握手阶段就会写验证帧 → 0 字节 → fail
  link.tick()
  await flush()
  for (let i = 0; i < 40; i += 1) {
    clock.now += 8
    link.tick()          // 帧循环不断尝试写
  }
  const zeroLogs = logs.filter((l) => l.includes('写入 0 字节')).length
  const failLogs = logs.filter((l) => l.includes('串口故障')).length
  assert.ok(zeroLogs <= 3, `"写入 0 字节"日志必须节流：${zeroLogs} 条`)
  assert.ok(failLogs <= 5, `故障日志必须节流：${failLogs} 条`)
  assert.equal(link.status().verified, false, '绝不能算连上（写 0 字节 = 设备不在）')
  const st = link.status().state
  assert.ok(st !== 'ready', `状态应当已离开 ready，实际：${st}`)
})

test('背压：积压时**丢动画帧**（不是故障），恢复后立刻用最新画面重发；控制帧必达', async () => {
  const h = makeLink('COM7')
  await h.connect()
  h.link.applyScene({ state: 'running', flags: 0, brightness: 160, latched: false, reason: 'test' })
  h.advance(100)
  h.link.tick()                                  // 先正常写一帧
  const before = h.written.length
  assert.ok(before > 0, '应当已经写过帧')

  // 传输层积压（Windows：worker 里还有一帧没落地；POSIX：发送队列满）
  h.failing.busy = true
  h.advance(100)
  h.link.tick()
  const s = h.link.status()
  assert.equal(h.written.length, before, '积压期间不能再往队列里塞动画帧')
  assert.equal(s.dropped, 1, '应当记为"主动丢弃的动画帧"')
  assert.equal(s.state, 'ready', '丢帧是背压，绝不能触发重连')
  assert.equal(s.errorCode, '', '丢帧不能记成写失败')
  assert.equal(s.lastError, '')

  // 控制帧（蜂鸣）不受背压影响：必达
  assert.equal(h.link.beep({ freqHz: 440, volume: 50, durationMs: 100 }), true)
  assert.equal(h.written[h.written.length - 1][2], 0x02, '蜂鸣帧必须真的写出去')

  // 恢复：下一帧用**最新**画面重发（不是重发被丢掉的那一帧）
  h.failing.busy = false
  h.advance(100)
  h.link.tick()
  const sent = h.written.filter((b) => b[2] === 0x01)
  assert.equal(sent.length, 2, '积压前一帧 + 恢复后一帧（被丢掉的那帧不补发）')
  assert.equal(h.link.status().dropped, 1, '恢复发送后不应再丢')
})

test('传输层的异步故障必须接进链路（worker 卡死/线程退出不能只靠"下一次写"才发现）', async () => {
  const h = makeLink('COM7')
  await h.connect()
  assert.equal(typeof h.handle.onFault, 'function', '链路必须注册 onFault')
  h.handle.onFault('串口线程退出（code=1）')
  const s = h.link.status()
  assert.equal(s.state, 'error')
  assert.equal(s.verified, false, '故障后必须丢掉"已握手"')
  assert.match(s.lastError, /串口线程退出/)
})

test('旧连接（已关闭）的迟到故障不能让新连接走重连', async () => {
  const h = makeLink('COM7')
  await h.connect()
  const staleFault = h.handle.onFault
  h.link.close()
  h.advance(10)
  staleFault('迟到的线程退出')            // 旧 worker 的故障在关掉之后才到
  const s = h.link.status()
  assert.equal(s.state, 'disabled', '旧代次的故障必须被忽略')
  assert.equal(s.lastError, '')
})

test('打开期间连接被关闭 → 迟到的句柄必须被关掉，绝不会装进链路', async () => {
  const state = { now: 5000 }
  let resolveOpen
  let closedCount = 0
  const stale = {
    write: (b) => b.length,
    read: () => Buffer.alloc(0),
    close: () => { closedCount += 1 },
  }
  const link = createSerialLink({
    port: 'COM9',
    open: () => new Promise((resolve) => { resolveOpen = resolve }),
    list: async () => [{ path: 'COM9', label: '' }],
    now: () => state.now,
    log: () => {},
  })
  link.tick()                      // 发起 open（挂起）
  await flush()
  link.close()                     // 打开还没回来，用户把指示灯关了
  resolveOpen(stale)               // 迟到的句柄
  await flush()
  assert.equal(closedCount, 1, '过期句柄必须被关闭（否则泄漏一个已失效的原生句柄）')
  assert.equal(link.status().verified, false)
  assert.notEqual(link.status().state, 'verifying', '绝不能因为过期句柄变成"正在验证"')
})

test('熄灯帧走**同步写**：句柄支持 writeSync 时必须等它落地（否则退出后灯还亮着）', async () => {
  const h = makeLink('COM7')
  await h.connect()
  let syncCalls = 0
  let asyncCalls = 0
  const origWrite = h.handle.write
  h.handle.write = (buf, opts) => { asyncCalls += 1; return origWrite.call(h.handle, buf, opts) }
  h.handle.writeSync = (buf) => { syncCalls += 1; return buf.length }
  assert.equal(h.link.flush({ state: 'off', flags: 0, brightness: 0, latched: false, reason: 'test' }), true)
  assert.equal(syncCalls, 1, '必须走同步写')
  assert.equal(asyncCalls, 0, '不许退回"只入队"的异步写')

  // 同步写失败不能把链路判死（关机路径上再触发重连没有意义）
  h.handle.writeSync = () => 0
  assert.equal(h.link.flush({ state: 'off', flags: 0, brightness: 0, latched: false, reason: 'test' }), false)
  assert.equal(h.link.status().state, 'ready')
})

test('打开超时后，旧一轮的**失败**不能打掉新一轮（异常路径也要认代次与所有权）', async () => {
  const state = { now: 1000 }
  const opens = []
  const link = createSerialLink({
    port: 'COM9',
    open: () => new Promise((resolve, reject) => { opens.push({ resolve, reject }) }),
    list: async () => [{ path: 'COM9', label: '' }],
    now: () => state.now,
    log: () => {},
    backoffMs: [100],
    verifyTimeoutMs: 1000,
  })
  link.tick()                       // 第一轮 A（挂起）
  await flush()
  assert.equal(opens.length, 1)

  // ① 打开超时（>3s）：强制恢复，允许下一轮
  state.now += 3500
  link.tick()
  assert.equal(link.status().state, 'error')
  assert.match(link.status().lastError, /串口超时/)

  // ② 退避到期 → 第二轮 B 开始
  state.now += 200
  link.tick()
  await flush()
  assert.equal(opens.length, 2, '应当开始第二轮打开')
  assert.equal(link.status().state, 'opening')

  // ③ A 这时才失败：绝不能触发 fail()（否则新一轮刚建立的状态就被打掉）
  opens[0].reject(new Error('CreateFile 卡死'))
  await flush()
  assert.equal(link.status().state, 'opening', '旧一轮的失败不能改变新一轮的状态')
  assert.ok(!/卡死/.test(link.status().lastError), `旧一轮的错误不该写进状态：${link.status().lastError}`)

  // ④ A 的 finally 也不能替 B 放锁：此时 tick 不该并发开第三轮
  link.tick()
  await flush()
  assert.equal(opens.length, 2, '旧一轮的 finally 不能清掉新一轮的 opening 标记')

  // ⑤ B 正常完成：证明它没有被上一轮搅坏
  opens[1].resolve({
    write: (b) => b.length,
    read: () => Buffer.from(VERIFY_REPLY, 'ascii'),
    close: () => {},
  })
  await flush()
  link.tick()
  await flush()
  assert.equal(link.status().state, 'ready', '新一轮应当能正常握手')
})

test('外部 API 的颜色帧同样受背压保护（不能被高频调用绕过）；控制帧仍必达', async () => {
  const h = makeLink('COM7')
  await h.connect()
  const colorFrame = encodeLeds(Array.from({ length: 7 }, () => ({ r: 9, g: 8, b: 7 })))
  h.failing.busy = true
  assert.equal(h.link.rawFrame(colorFrame), false, '积压时颜色帧应被丢弃（最新画面优先）')
  assert.equal(h.link.status().dropped, 1)
  assert.equal(h.link.status().state, 'ready', '丢帧不是故障')
  // 控制帧（验证）不受背压影响
  assert.equal(h.link.verify(), true)
  h.failing.busy = false
  assert.equal(h.link.rawFrame(colorFrame), true, '恢复后颜色帧照常发')
})


// ── 按需帧循环的判据 + 复用缓冲的逐帧正确性 ────────────────────────────────

test('needsFrames()：握手/渐变/连续动画要连续帧，稳态 off/done 不要', async () => {
  const h = makeLink('COM7')
  h.link.tick()
  await flush()
  assert.equal(h.link.status().state, 'verifying')
  assert.equal(h.link.needsFrames(), true, '握手窗口需要连续帧（验证帧重发/超时判定靠它）')
  h.link.tick()
  await flush()
  assert.equal(h.link.status().state, 'ready')
  assert.equal(h.link.needsFrames(), false, 'off 是稳态：心跳 + 探测就够，不需要 240fps')

  const running = { state: 'running', flags: 0, brightness: 200, latched: false, reason: '' }
  h.link.applyScene(running)
  h.link.tick()
  assert.equal(h.link.needsFrames(), true, 'running 的流转是连续动画')

  h.advance(500)
  const done = { state: 'done', flags: 2 /* MUTED */, brightness: 255, latched: false, reason: '' }
  h.link.applyScene(done)
  h.link.tick()
  assert.equal(h.link.needsFrames(), true, '画面切换的交叉渐变窗口需要连续帧')
  h.advance(500)
  h.link.tick()
  assert.equal(h.link.needsFrames(), false, '渐变结束后的 done 是稳态')

  // 异常即使暂时不闪（没有提醒闩）也按连续帧处理：闪烁是红灯语义的一部分
  h.link.applyScene({ state: 'error', flags: 0, brightness: 255, latched: false, reason: '' })
  h.advance(500)
  h.link.tick()
  assert.equal(h.link.needsFrames(), true, 'error 需要连续帧')
})

test('复用像素/帧缓冲：每帧内容仍等于该时刻的纯渲染（不被上一帧污染）', async () => {
  const h = makeLink('COM7')
  await h.connect()
  // error + ATTENTION：会按绝对时刻闪动，但 error 不做时间抖动 —— 可以逐字节对拍
  const scene = { state: 'error', flags: 1 /* ATTENTION */, brightness: 255, latched: true, reason: '' }
  h.link.applyScene(scene)
  h.advance(500)                       // 跳过 250ms 交叉渐变（t=1500）
  h.written.length = 0
  h.link.tick()
  const frame1 = h.written[h.written.length - 1]
  assert.equal(frame1.toString('hex'), encodeLeds(renderPixels(scene, 1500)).toString('hex'),
    '第一帧必须等于 t=1500 的纯渲染结果')

  // 200ms 后：闪动相位变了（800ms 周期），像素必须跟着变，且仍与纯渲染一致
  h.advance(200)                       // t=1700
  h.link.tick()
  const frame2 = h.written[h.written.length - 1]
  assert.equal(frame2.toString('hex'), encodeLeds(renderPixels(scene, 1700)).toString('hex'),
    '第二帧必须等于 t=1700 的纯渲染结果（复用缓冲不能被上一帧残留污染）')
  assert.notEqual(frame1.toString('hex'), frame2.toString('hex'), '闪动相位不同，两帧内容不该相同')
})

test('复用发送快照：画面来回切换时去重仍然正确（不会"自己等于自己"而停更）', async () => {
  const h = makeLink('COM7')
  await h.connect()
  const A = { state: 'error', flags: 0, brightness: 255, latched: false, reason: '' }
  const B = { state: 'done', flags: 2 /* MUTED */, brightness: 255, latched: false, reason: '' }
  h.link.applyScene(A)
  h.advance(500)
  h.link.tick()                                     // 写 A（红）
  const n1 = h.written.length
  assert.ok(n1 >= 1)
  h.advance(500)
  h.link.tick()
  assert.equal(h.written.length, n1, '稳态同一画面不重复写（去重生效）')
  h.link.applyScene(B)
  h.advance(500)
  h.link.tick()                                     // 写 B（绿）
  assert.equal(h.written.length, n1 + 1, '换画面必须写出新帧')
  const green = h.written[h.written.length - 1]
  assert.equal(green.toString('hex'), encodeLeds(renderPixels(B, 2500)).toString('hex'))
  // 再切回 A：发送快照是拷贝而不是复用的像素引用，必须识别出"变了"并重新写
  h.link.applyScene(A)
  h.advance(500)
  h.link.tick()
  assert.equal(h.written.length, n1 + 2, '切回旧画面也必须重新写（快照不能是复用缓冲的引用）')
  const red = h.written[h.written.length - 1]
  assert.equal(red.toString('hex'), encodeLeds(renderPixels(A, 3000)).toString('hex'))
})

test('稳态动画不再做时间抖动：彗星到两端不会 240Hz ±1 微闪（回归）', async () => {
  // 现场问题：律动核心到达两头时速度≈0，同一颗灯连续多帧目标值不变；旧实现每帧
  // 对动画帧做 ±1 LSB 时间抖动，于是它在两个相邻灰度间以 240Hz 来回跳 → 极快微闪。
  // 现在抖动只保留在 250ms 交叉渐变窗口内（快速变化时不可见），稳态输出纯 8 位。
  const h = makeLink('COM7')
  await h.connect()
  const scene = { state: 'running', flags: 0, brightness: 191, latched: false, reason: '' }
  const T0 = 1000
  h.link.applyScene(scene)
  const body = []
  for (let i = 1; i <= 400; i += 1) {
    h.advance(1000 / 240)
    h.link.tick()
    const last = h.written[h.written.length - 1]
    if (!last || last[2] !== 0x01) continue
    // 跳过淡入（250ms ≈ 60 帧）
    if (i * (1000 / 240) > 400) body.push(Buffer.from(last.subarray(3, 24)))
  }
  assert.ok(body.length > 250, `应采到足够多的稳态帧（${body.length}）`)
  let flips = 0
  for (let i = 1; i < body.length - 1; i += 1) {
    for (let led = 0; led < 7; led += 1) {
      for (const off of [0, 1, 2]) {
        const a = body[i - 1][led * 3 + off]
        const b = body[i][led * 3 + off]
        const c = body[i + 1][led * 3 + off]
        if (Math.abs(b - a) === 1 && Math.abs(c - b) === 1 && Math.sign(b - a) !== Math.sign(c - b)) flips += 1
      }
    }
  }
  assert.ok(flips <= 20, `稳态动画不应再逐帧 ±1 抖动（来回次数 ${flips}）`)
  // 最后一帧必须**逐字节等于**纯渲染输出（没有抖动、没有额外处理）
  const lastFrame = h.written[h.written.length - 1]
  const expected = encodeLeds(renderPixels(scene, 1000 + 400 * (1000 / 240), 400 * (1000 / 240)))
  assert.equal(lastFrame.toString('hex'), expected.toString('hex'), '稳态帧必须等于渲染器输出（抖动已移除）')
})

// ── 无固件改动的"状态级韧性"：自适应冗余 / 快速探针 / 坏帧重试 ──────────────
// 前提（必须说清楚）：固件没有逐帧 ACK/CRC、颜色 payload 长度固定 21B —— 所以
// **不可能**做线缆级压缩/逐帧校验/逐帧重传。能做的是"状态级韧性"：
//   · 每帧都是绝对状态 → 丢一帧下一帧自动纠正；
//   · 劣化时同一帧连发两遍（第二份必达），唯一帧降到 120fps，线上占用不变；
//   · 劣化期用 0x00 验证帧做快速健康探针（800ms/400ms）；
//   · 瞬时失败不轻易打黑帧，短写/丢帧不推进"已发送快照"。

const isBlackLeds = (frame) => frame.length === 26 && frame[2] === 0x01
  && frame.subarray(3, 24).every((byte) => byte === 0)
const ledsFrames = (list) => list.filter((b) => b.length === 26 && b[2] === 0x01)
const verifyFrames = (list) => list.filter((b) => b.length === 5 && b[2] === 0x00)

test('自适应韧性：瞬时写失败不打黑帧，但进入冗余；5s 内重复失败（确认断开）才发黑', async () => {
  const h = makeLink('COM7')
  await h.connect()
  const running = { state: 'running', flags: 0, brightness: 200, latched: false, reason: '' }
  h.link.applyScene(running)
  h.advance(500)                     // 跳过交叉渐变
  h.link.tick()
  h.written.length = 0

  // ① 第一次失败是"瞬时抖动"（一次抛错，句柄本身还能用）→ 不该把灯打黑
  h.failing.writeOnce = true
  h.advance(10)
  h.link.tick()
  assert.equal(h.link.status().errorCode, 'write-failed')
  assert.equal(h.written.some(isBlackLeds), false, '瞬时一次写失败不该发黑帧')
  assert.equal(h.link.status().quality, 'suspect', '单次写失败 → suspect')
  assert.equal(h.link.status().redundancy, true, '劣化后进入自适应冗余')

  // ② 5 秒内再次失败：重复失败 = 确认不是抖动 → 这时才允许发黑帧
  h.advance(RECONNECT_BACKOFF_MS[0])
  await h.connect()
  h.link.applyScene(running)
  h.advance(500)
  h.link.tick()
  h.written.length = 0
  h.failing.writeOnce = true
  h.advance(10)
  h.link.tick()
  assert.equal(h.written.some(isBlackLeds), true, '短时间内重复失败 → 发黑帧（灯锁存的是旧颜色）')
})

test('自适应冗余：连续丢帧 → 每帧双发（pending=0 才补第二份）、探测提速；健康 10s 后退出', async () => {
  const h = makeLink('COM7')
  await h.connect()
  const running = { state: 'running', flags: 0, brightness: 160, latched: false, reason: '' }
  h.link.applyScene(running)
  h.advance(500)
  h.link.tick()
  h.written.length = 0

  // 传输层连续积压：两帧被丢 → 质量掉到 suspect → 进入冗余
  h.failing.busy = true
  h.advance(10)
  h.link.tick()
  h.advance(10)
  h.link.tick()
  assert.equal(ledsFrames(h.written).length, 0, '积压期动画帧被丢弃（不是故障）')
  assert.equal(h.link.status().quality, 'suspect')
  assert.equal(h.link.status().redundancy, true, '劣化后进入自适应冗余')

  // 恢复：同一拍写两份（第一份可丢动画帧 + 第二份必达），逐字节相同
  h.failing.busy = false
  h.written.length = 0
  h.advance(10)
  h.link.tick()
  const pair = ledsFrames(h.written)
  assert.equal(pair.length, 2, '冗余期一帧必须写两遍')
  assert.equal(pair[0].toString('hex'), pair[1].toString('hex'), '两份必须逐字节相同')

  // 传输层还有一帧没落地（pending>0）→ 不补第二份，避免把队列灌满
  h.written.length = 0
  h.failing.pending = 1
  h.advance(10)
  h.link.tick()
  assert.equal(ledsFrames(h.written).length, 1, 'pending>0 时不补第二份（背压优先于冗余）')
  h.failing.pending = 0

  // 快速健康探针：冗余期 800ms 就发一次 0x00（健康期是 2500ms）
  h.written.length = 0
  h.advance(900)
  h.link.reap()
  assert.equal(verifyFrames(h.written).length, 1, '冗余期应当 800ms 发一次验证探针')
  // 设备回包 → 探测通过（保持健康；换一个更晚的时刻再确认一次）
  h.replyNow()
  h.advance(50)
  h.link.tick()
  assert.equal(h.link.status().state, 'ready', '回包恢复后链路仍然 ready')

  // 保持期（10s）内没有新劣化信号 → 到期自动退出冗余，回到单发
  for (let i = 0; i < 26; i += 1) {   // 每 400ms 一帧（保持 lastWriteAt 新鲜），共 ~10.4s
    h.advance(400)
    h.link.tick()
  }
  const healthy = h.link.status()
  assert.equal(healthy.quality, 'ok', `10s 无新信号后质量应恢复：${JSON.stringify({ quality: healthy.quality, errorCode: healthy.errorCode })}`)
  assert.equal(healthy.redundancy, false, '健康后必须退出冗余')
  h.written.length = 0
  h.advance(400)
  h.link.tick()
  assert.equal(ledsFrames(h.written).length, 1, '退出冗余后回到单发')
})

test('坏帧重试：短写算失败、不推进已发送快照 → 重连后当前画面立刻重发', async () => {
  const h = makeLink('COM7')
  await h.connect()
  // 静态画面（done+MUTED：不呼吸、不抖动）→ 任何时刻渲染结果都相同，便于逐字节对拍
  const scene = { state: 'done', flags: 2, brightness: 255, latched: false, reason: '' }
  h.link.applyScene(scene)
  h.advance(500)
  h.link.tick()
  const good = h.written[h.written.length - 1]
  assert.equal(good[2], 0x01)

  h.written.length = 0
  h.failing.shortOnce = 10          // 驱动只接受 10/26 字节（超时/接触不良）
  h.advance(5001)                   // 静态画面不会主动重写，跨过心跳周期逼出一次写
  h.link.tick()
  assert.equal(h.link.status().errorCode, 'write-failed', '短写必须判失败（半帧固件会整帧丢掉）')
  assert.equal(h.written.some(isBlackLeds), false, '瞬时短写不打黑帧')

  // 重连后：当前画面必须重新落地（坏帧绝不能被当成"已经发过"）
  h.advance(RECONNECT_BACKOFF_MS[0])
  await h.connect()
  h.advance(500)
  h.written.length = 0
  h.link.tick()
  const again = ledsFrames(h.written).at(-1)
  assert.ok(again, '重连后必须重发当前帧')
  assert.equal(again.toString('hex'), good.toString('hex'), '重发的应当就是当前画面（不是半截坏帧里的旧数据）')
})

test('质量信号只统计"已连接链路"：自动发现时选错口（非板子）不会白降频', async () => {
  const clock = { now: 10_000 }
  const opened = []
  const silent = () => ({ write: (b) => b.length, read: () => Buffer.alloc(0), close: () => {} })
  let reply = Buffer.from(VERIFY_REPLY, 'ascii')
  const answering = () => ({
    write: (b) => b.length,
    read: () => { const out = reply; reply = Buffer.alloc(0); return out },
    close: () => {},
  })
  const link = createSerialLink({
    port: 'auto',
    open: async (p) => { opened.push(p); return p === 'COM7' ? answering() : silent() },
    list: async () => [
      { path: 'COM19', label: 'USB-SERIAL CH340' },   // 先试（COM 号大）但不是板子
      { path: 'COM7', label: 'USB-SERIAL CH340' },
    ],
    now: () => clock.now,
    log: () => {},
    verifyTimeoutMs: 1500,
  })
  link.tick(); await flush()
  clock.now += 900; link.tick(); await flush()      // COM19 握手失败 → 换候选
  clock.now += 300; link.tick(); await flush()      // COM7
  link.tick(); await flush()                        // 握手成功
  assert.equal(link.status().state, 'ready')
  assert.equal(link.status().quality, 'ok', '选错口的握手失败不算链路劣化')
  assert.equal(link.status().redundancy, false, '不该因为发现过程降频')
})

test('切标签页（running→running+muted）不能重置彗星相位/重新渐变（严重闪烁回归）', async () => {
  // 用户实测：切换浏览器标签页/其它应用时灯严重闪烁。
  // 根因：焦点翻转会让 judge 给 running 画面打/去 MUTED；旧 applyScene 用完整 flags 判"画面变了"
  // → 重置 sceneSince（彗星相位回起点、stagger 重新展开）并叠 250ms 渐变。
  // MUTED 在 running 渲染里根本不参与，所以这类变化必须完全忽略。
  const h = makeLink('COM7')
  await h.connect()
  const base = { state: 'running', flags: 0, brightness: 191, latched: false, reason: '' }
  h.link.applyScene(base)                 // sceneSince = 1000
  for (let i = 0; i < 150; i += 1) {      // 走到相位中段（~625ms）
    h.advance(1000 / 240)
    h.link.tick()
  }
  h.link.applyScene({ ...base, flags: 2 }) // 焦点翻转：仅 MUTED，像素语义不变
  h.advance(1000 / 240)
  h.link.tick()
  const t = 1000 + 151 * (1000 / 240)
  const last = h.written[h.written.length - 1]
  const expected = encodeLeds(renderPixels({ ...base, flags: 2 }, t, t - 1000))
  assert.equal(last.toString('hex'), expected.toString('hex'),
    '焦点翻转只改 MUTED：相位与渐变都不能重置（帧必须等于原相位渲染）')
})

test('等待画面（waiting→waiting+muted）是真实视觉变化：仍然走渐变', async () => {
  const h = makeLink('COM7')
  await h.connect()
  const waiting = { state: 'waiting', flags: 0, brightness: 191, latched: false, reason: '' }
  h.link.applyScene(waiting)
  h.advance(500)
  h.link.tick()
  h.link.applyScene({ ...waiting, flags: 2 })   // 停止呼吸 = 视觉变化
  h.advance(1000 / 240)
  h.link.tick()
  const last = h.written[h.written.length - 1]
  const pure = encodeLeds(renderPixels({ ...waiting, flags: 2 }, 1000 + 500 + 1000 / 240, 500 + 1000 / 240))
  assert.notEqual(last.toString('hex'), pure.toString('hex'), 'waiting 的 MUTED 会改画面，必须允许渐变')
})
