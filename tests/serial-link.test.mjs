// 串口链路（真协议）：握手 / 像素流 / 去重 / 心跳 / 重连
//
// 全部用注入的假句柄跑，不需要真板子。真实打开的路径见 serial-port.ts（Windows: koffi）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSerialLink, pickAutoPort, isValidPortName, RECONNECT_BACKOFF_MS, WRITE_DROPPED,
} from '../lib/serial-link.js'
import { VERIFY_REPLY, encodeLeds, encodeBuzzer } from '../lib/led-protocol.js'
import { OFF_SCENE } from '../lib/led-scene.js'
import { renderPixels } from '../lib/led-render.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function makeLink(port = 'COM7', options = {}) {
  const state = { now: 1000 }
  const written = []
  const opened = []
  const failing = { open: '', write: false, busy: false }
  let queue = options.reply === false ? Buffer.alloc(0) : Buffer.from(VERIFY_REPLY, 'ascii')
  const handle = {
    write(buf, writeOptions) {
      if (failing.write) throw new Error('写入失败')
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
    link, written, opened, failing, handle,
    advance(ms) { state.now += ms },
    /** 连接到握手通过（省得每个用例重复三行）。 */
    async connect() {
      link.tick()
      await flush()
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

test('pickAutoPort / isValidPortName', () => {
  assert.equal(pickAutoPort([]), '')
  assert.equal(pickAutoPort([{ path: 'COM3', label: '' }, { path: 'COM11', label: 'CH340' }]), 'COM11')
  assert.equal(pickAutoPort([{ path: 'COM3', label: '' }, { path: 'COM9', label: '' }]), 'COM9')
  assert.equal(pickAutoPort([{ path: '/dev/ttyUSB0', label: '' }]), '/dev/ttyUSB0')
  assert.equal(isValidPortName('COM7'), true)
  assert.equal(isValidPortName('/dev/ttyUSB0'), true)
  assert.equal(isValidPortName('auto'), false)
  assert.equal(isValidPortName(''), false)
  assert.equal(isValidPortName('COM7; rm -rf'), false)
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

