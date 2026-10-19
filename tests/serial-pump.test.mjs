// 读取泵的节奏策略（纯函数）——窗口内 2ms、窗口外 30ms，验证帧判定。
//
// 这组测试对应一个真实开销：2ms 固定泵一小时 ~180 万轮，每轮还要两次 Buffer.alloc。
// 定时器本身在 serial-worker.ts（没法在单测里跑真串口），所以把"什么时候该快"
// 这个唯一容易算错的判定抽成纯函数，在这里把边界与非法输入穷举掉。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SERIAL_PUMP_FAST_MS,
  SERIAL_PUMP_IDLE_MS,
  SERIAL_REPLY_WINDOW_MS,
  isVerifyFrame,
  pumpIntervalMs,
  replyWindowFor,
} from '../lib/serial-pump.js'
import { MODE, encodeBuzzer, encodeLeds, encodeVerify } from '../lib/led-protocol.js'

const FAST = SERIAL_PUMP_FAST_MS
const IDLE = SERIAL_PUMP_IDLE_MS

test('常量：窗口内 2ms；窗口外落在 25~50ms；窗口 2000ms', () => {
  assert.equal(FAST, 2, '握手回包要尽快收到，窗口内必须保持原来的 2ms')
  assert.ok(IDLE >= 25 && IDLE <= 50, `慢轮询应在 25~50ms（实际 ${IDLE}）`)
  assert.equal(SERIAL_REPLY_WINDOW_MS, 2000)
})

test('窗口内用快轮询（含刚开窗口的时刻）', () => {
  const until = replyWindowFor(1000)
  assert.equal(pumpIntervalMs(1000, until), FAST, '开窗口的瞬间就是快轮询')
  assert.equal(pumpIntervalMs(1001, until), FAST)
  assert.equal(pumpIntervalMs(2999, until), FAST, '到期前 1ms 仍是快轮询')
})

test('窗口到期即降速（边界时刻算到期，不能多快一轮）', () => {
  assert.equal(pumpIntervalMs(3000, 3000), IDLE)
  assert.equal(pumpIntervalMs(3001, 3000), IDLE)
  assert.equal(pumpIntervalMs(10_000, 3000), IDLE)
})

test('没有窗口 / 时间戳非法 → 慢轮询（不能让一个坏参数把泵钉在 2ms）', () => {
  assert.equal(pumpIntervalMs(0, 0), IDLE)
  assert.equal(pumpIntervalMs(123, -1), IDLE)
  assert.equal(pumpIntervalMs(NaN, 5000), IDLE, 'now 非法：比较不成立 → 慢')
  assert.equal(pumpIntervalMs(100, NaN), IDLE, '截止时刻非法：比较不成立 → 慢')
})

test('窗口时长：默认 2000ms，可覆盖；非正/非法时长等于不开窗口', () => {
  assert.equal(replyWindowFor(1000), 1000 + SERIAL_REPLY_WINDOW_MS)
  assert.equal(replyWindowFor(1000, 500), 1500)
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(replyWindowFor(1000, bad), 1000, `时长 ${bad} 不应产生快轮询窗口`)
  }
})

test('验证帧判定：55 AA | MODE=0x00 | …（只看第 3 字节，不重算校验和）', () => {
  assert.equal(isVerifyFrame(encodeVerify()), true)
  assert.equal(isVerifyFrame(Buffer.from([0x55, 0xaa, MODE.VERIFY])), true, '最短可判定前缀')
  assert.equal(isVerifyFrame([0x55, 0xaa, MODE.VERIFY, 0xff, 0xbb]), true, 'ArrayLike 也接受')
})

test('验证帧判定：其它命令 / 帧头不对 / 太短都不开快轮询窗口', () => {
  const pixels = Array.from({ length: 7 }, () => ({ r: 1, g: 2, b: 3 }))
  assert.equal(isVerifyFrame(encodeLeds(pixels)), false, 'LEDS（MODE=0x01）不是验证帧')
  assert.equal(isVerifyFrame(encodeBuzzer({ freqHz: 1000, volume: 50, durationMs: 100 })), false, 'BUZZER 不是验证帧')
  assert.equal(isVerifyFrame(Buffer.from([0xaa, 0x55, MODE.VERIFY])), false, '帧头顺序反了')
  assert.equal(isVerifyFrame(Buffer.from([0x55, 0xaa, MODE.LEDS])), false, '第 3 字节不是 0x00')
  assert.equal(isVerifyFrame(Buffer.from([0x55, 0xaa])), false, '不足 3 字节')
  assert.equal(isVerifyFrame(Buffer.alloc(0)), false)
  assert.equal(isVerifyFrame(encodeVerify().subarray(0, 2)), false)
})
