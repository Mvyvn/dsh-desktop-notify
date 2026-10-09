// 串口链路层单测（假句柄，不需要真硬件）
//
// 板子还没打，但链路逻辑必须现在就能验证。这里锁住：
//   · 打开后先握手（HELLO），随后按画面变化发 SCENE
//   · **去重**：画面没变不重复写；到心跳周期才重发（这就是"平均带宽 < 20 B/s"的来源）
//   · 写失败 → 进 error 状态并退避，退避期内不重试
//   · 收包：HELLO_ACK 更新设备信息、EVENT 回调按键
//   · 端口 "auto" → 从枚举结果里挑（COM3+ 优先）
//   · 配置变化（设置页改端口/波特率）→ 断开重连
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSerialLink, sceneSignature, pickAutoPort, isValidPortName, RECONNECT_BACKOFF_MS } from '../lib/serial-link.js'
import { encodeFrame, createFrameParser, FRAME, REPLY } from '../lib/led-protocol.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))
const scene = (patch = {}) => Object.assign({ state: 'running', flags: 0, brightness: 160, progress: 255, latched: false, reason: '' }, patch)

/** 假串口：记录写入、可注入读取与失败。 */
function fakePort() {
  const state = { written: [], reads: [], closed: 0, failWrite: false, failOpen: '', opened: null }
  state.handle = {
    write(bytes) {
      if (state.failWrite) return 0
      state.written.push(Buffer.from(bytes))
      return bytes.length
    },
    read() { return state.reads.shift() ?? Buffer.alloc(0) },
    close() { state.closed += 1 },
  }
  state.open = async (port, baud) => {
    if (state.failOpen) throw new Error(state.failOpen)
    state.opened = { port, baud }
    return state.handle
  }
  state.frames = (type) => {
    const parser = createFrameParser()
    return state.written.flatMap((buf) => parser.push(buf)).filter((f) => f.type === type)
  }
  return state
}

function makeLink(port, overrides = {}) {
  const fake = fakePort()
  const clock = { now: 1000 }
  const events = []
  const link = createSerialLink(Object.assign({
    port,
    baud: 115200,
    open: fake.open,
    list: async () => [{ path: 'COM1', label: '' }, { path: 'COM7', label: '' }],
    now: () => clock.now,
    onEvent: (e) => events.push(e),
    heartbeatMs: 5000,
  }, overrides))
  return { fake, clock, link, events }
}

test('打开串口后先发握手（HELLO），随后才发画面', async () => {
  const { fake, link, clock } = makeLink('COM7')
  link.apply(scene())
  link.tick()
  await flush()
  const hello = fake.frames(FRAME.HELLO)
  assert.equal(hello.length, 1)
  assert.equal(fake.opened.port, 'COM7')
  assert.equal(fake.opened.baud, 115200)
  link.tick()
  assert.equal(fake.frames(FRAME.SCENE).length, 1)
  assert.equal(link.status().state, 'ready')
  assert.equal(link.status().lastWriteAt, clock.now)
})

test('画面没变不重复写；到心跳周期才重发（去重是带宽的关键）', async () => {
  const { fake, link, clock } = makeLink('COM7')
  link.apply(scene())
  link.tick(); await flush()
  link.tick()                                  // 第一次发
  assert.equal(fake.frames(FRAME.SCENE).length, 1)
  clock.now += 1000
  link.tick()                                  // 没变、没到心跳 → 不发
  assert.equal(fake.frames(FRAME.SCENE).length, 1)
  clock.now += 4000
  link.tick()                                  // 累计 5s → 心跳重发
  assert.equal(fake.frames(FRAME.SCENE).length, 2)
  link.apply(scene({ state: 'done' }))         // 画面变化 → 立刻发
  link.tick()
  assert.equal(fake.frames(FRAME.SCENE).length, 3)
  assert.equal(fake.frames(FRAME.SCENE)[2].payload[0], 3)
})

test('稳态带宽：心跳 5s 一次，平均 < 5 字节/秒', async () => {
  const { fake, link, clock } = makeLink('COM7')
  link.apply(scene())
  link.tick(); await flush()
  link.tick()
  const base = fake.written.reduce((n, b) => n + b.length, 0)
  for (let i = 0; i < 60; i += 1) { clock.now += 5000; link.tick() }
  const total = fake.written.reduce((n, b) => n + b.length, 0) - base
  // 60 次心跳 × 11 字节 / 300 秒 ≈ 2.2 B/s
  assert.ok(total / 300 < 5, `实际 ${(total / 300).toFixed(2)} B/s`)
})

test('写失败 → error + 退避；退避期内不重试，到点才重开', async () => {
  const { fake, link, clock } = makeLink('COM7')
  link.apply(scene())
  link.tick(); await flush()
  fake.failWrite = true
  link.tick()
  assert.equal(link.status().state, 'error')
  assert.match(link.status().lastError, /写入不完整/)
  assert.equal(fake.closed, 1)
  clock.now += RECONNECT_BACKOFF_MS[0] - 1
  link.tick()
  assert.equal(link.status().state, 'error')     // 还没到点
  clock.now += 1
  fake.failWrite = false
  link.tick(); await flush()
  assert.equal(link.status().state, 'ready')
  assert.equal(link.status().framesSent > 0, true)
})

test('打不开端口 → error，退避后自动重试（板子还没插上也不会刷爆日志）', async () => {
  const { fake, link, clock } = makeLink('COM7')
  fake.failOpen = '端口被占用'
  link.tick(); await flush()
  assert.equal(link.status().state, 'error')
  assert.match(link.status().lastError, /端口被占用/)
  assert.ok(link.status().retryInMs > 0)
  fake.failOpen = ''
  clock.now += RECONNECT_BACKOFF_MS[0]
  link.tick(); await flush()
  assert.equal(link.status().state, 'ready')
})

test('端口 auto：从枚举里挑（COM3+ 优先，COM1 让位）', async () => {
  const { fake, link } = makeLink('auto')
  link.tick(); await flush()
  assert.equal(fake.opened.port, 'COM7')
  assert.equal(link.status().port, 'COM7')
})

test('端口 auto 且一个串口都没有 → errorCode=no-device（"还没接线"，不是故障）', async () => {
  const { link } = makeLink('auto', { list: async () => [] })
  link.tick(); await flush()
  assert.equal(link.status().state, 'error')
  assert.match(link.status().lastError, /没有找到任何串口设备/)
  // 关键：设置页据此说"未连接"而不是"异常" —— 没插灯不是故障
  assert.equal(link.status().errorCode, 'no-device')
  assert.ok(link.status().retryInMs > 0, '仍然按退避重试：插上就自动连')
})

test('打不开端口 → errorCode=open-failed；写失败 → write-failed（与"没插设备"分开）', async () => {
  const { fake, link, clock } = makeLink('COM7')
  fake.failOpen = '打不开串口 COM7'
  link.tick(); await flush()
  assert.equal(link.status().errorCode, 'open-failed')
  fake.failOpen = ''
  clock.now += RECONNECT_BACKOFF_MS[0]      // 退避到点才重试
  link.tick(); await flush()
  assert.equal(link.status().errorCode, '', '打开成功后清掉故障码')
  link.apply(scene())                       // 有画面才谈得上写
  fake.failWrite = true
  link.tick()
  assert.equal(link.status().errorCode, 'write-failed')
})

test('收包：HELLO_ACK 更新设备信息，EVENT 触发回调（板上按键=我知道了）', async () => {
  const { fake, link, events } = makeLink('COM7')
  link.tick(); await flush()
  fake.reads.push(encodeFrame(REPLY.HELLO_ACK, 0, [1, 60, 200, 0x1f, 0]))
  fake.reads.push(encodeFrame(REPLY.EVENT, 0, [1, 0]))
  link.apply(scene())
  link.tick()          // 一次 tick 读一包：先拿 HELLO_ACK
  link.tick()          // 再读一包：拿 EVENT
  const device = link.status().device
  assert.equal(device.wireVersion, 1)
  assert.equal(device.leds, 60)
  assert.equal(device.maxBrightness, 200)
  assert.equal(device.caps, 0x001f)
  assert.deepEqual(events, [{ code: 1, arg: 0 }])
})

test('配置变化（设置页改了端口）→ 关旧句柄、下次 tick 重开', async () => {
  const { fake, link } = makeLink('COM7')
  link.tick(); await flush()
  assert.equal(link.status().state, 'ready')
  link.configure('COM9', 9600)
  assert.equal(fake.closed, 1)
  assert.equal(link.status().state, 'idle')
  link.tick(); await flush()
  assert.equal(fake.opened.port, 'COM9')
  assert.equal(fake.opened.baud, 9600)
})

test('sendFrame 在未连接时返回 false（对外 API 要如实回报）', () => {
  const { link } = makeLink('COM7')
  assert.equal(link.sendFrame(FRAME.PING, []), false)
})

test('close 之后状态为 disabled', async () => {
  const { link } = makeLink('COM7')
  link.tick(); await flush()
  link.close()
  assert.equal(link.status().state, 'disabled')
})

test('sceneSignature 只用线上真正表达的字段', () => {
  const a = sceneSignature(scene({ reason: 'A' }))
  const b = sceneSignature(scene({ reason: 'B' }))
  assert.equal(a, b)
  assert.notEqual(a, sceneSignature(scene({ brightness: 161 })))
})

test('pickAutoPort：USB 串口优先且编号大的在前；空列表返回空串', () => {
  assert.equal(pickAutoPort([]), '')
  assert.equal(pickAutoPort([{ path: 'COM1' }, { path: 'COM3' }, { path: 'COM12' }]), 'COM12')
  assert.equal(pickAutoPort([{ path: 'COM1' }, { path: 'COM2' }]), 'COM2')
  assert.equal(pickAutoPort([{ path: '/dev/ttyAMA0' }, { path: '/dev/ttyUSB0' }]), '/dev/ttyUSB0')
})

test('isValidPortName：只接受 COMx 与 /dev/xxx', () => {
  assert.equal(isValidPortName('COM7'), true)
  assert.equal(isValidPortName('com12'), true)
  assert.equal(isValidPortName('/dev/ttyUSB0'), true)
  assert.equal(isValidPortName(''), false)
  assert.equal(isValidPortName('; rm -rf /'), false)
  assert.equal(isValidPortName('COM7; echo'), false)
})
