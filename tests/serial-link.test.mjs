// 串口链路（真协议）：握手 / 像素流 / 去重 / 心跳 / 重连
//
// 全部用注入的假句柄跑，不需要真板子。真实打开的路径见 serial-port.ts（Windows: koffi）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSerialLink, pickAutoPort, isValidPortName, RECONNECT_BACKOFF_MS,
} from '../lib/serial-link.js'
import { VERIFY_REPLY, encodeLeds, encodeBuzzer } from '../lib/led-protocol.js'
import { OFF_SCENE } from '../lib/led-scene.js'
import { renderPixels } from '../lib/led-render.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function makeLink(port = 'COM7', options = {}) {
  const state = { now: 1000 }
  const written = []
  const opened = []
  const failing = { open: '', write: false }
  let queue = options.reply === false ? Buffer.alloc(0) : Buffer.from(VERIFY_REPLY, 'ascii')
  const handle = {
    write(buf) {
      if (failing.write) throw new Error('写入失败')
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
    link, written, opened, failing,
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
  h.link.tick()
  const first = h.written[0]
  assert.equal(first.length, 26)
  assert.equal(first[0], 0x55)
  assert.equal(first[1], 0xaa)
  assert.equal(first[2], 0x01, 'MODE 0x01 = 设 7 灯颜色')
  assert.equal(first[25], 0xbb)
  h.link.tick()
  assert.equal(h.written.length, 1, '同一时刻像素没变 → 不写')
  h.advance(5000)
  h.link.tick()
  assert.equal(h.written.length, 2, '心跳到点要重发')
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
  const scene = { state: 'done', flags: 0, brightness: 255, latched: false, reason: '' }
  h.link.applyScene(scene)
  h.link.tick()
  const expected = encodeLeds(renderPixels(scene, 1000))
  assert.equal(h.written[0].toString('hex'), expected.toString('hex'))
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
