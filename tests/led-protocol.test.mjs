// 真协议（AI Status Lights）的编码/校验/回包扫描测试
//
// 最关键的一组断言直接用**项目 README 给出的示例帧**（校验位是人家算好的）：
// 我们的编码器必须逐字节复现，否则一定是协议理解错了。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MODE, PAYLOAD_LEN, LED_COUNT, VERIFY_REPLY, BAUD_RATE,
  checksum, encodeFrame, encodeVerify, encodeLeds, encodeBuzzer,
  createReplyScanner, pixelsEqual, scaleColor, describeFrame, clampByte,
} from '../lib/led-protocol.js'

const hex = (buf) => Buffer.from(buf).toString('hex').toUpperCase().replace(/(..)(?!$)/g, '$1 ').trim()

test('串口参数与灯珠数由固件固定：115200、7 颗', () => {
  assert.equal(BAUD_RATE, 115200)
  assert.equal(LED_COUNT, 7)
  assert.deepEqual(PAYLOAD_LEN, { 0: 0, 1: 21, 2: 5 })
})

test('验证帧 = README 示例 `55 AA 00 FF BB`', () => {
  assert.equal(hex(encodeVerify()), '55 AA 00 FF BB')
  assert.equal(checksum([0x55, 0xaa, 0x00]), 0xff)
})

test('7 灯全红 = README 示例帧（26 字节）', () => {
  const red = Array.from({ length: LED_COUNT }, () => ({ r: 255, g: 0, b: 0 }))
  const frame = encodeLeds(red)
  assert.equal(frame.length, 26)
  assert.equal(hex(frame), '55 AA 01 FF 00 00 FF 00 00 FF 00 00 FF 00 00 FF 00 00 FF 00 00 FF 00 00 F9 BB')
})

test('7 灯彩虹 = README 示例帧', () => {
  const rainbow = [
    { r: 255, g: 0, b: 0 },      // 红
    { r: 255, g: 96, b: 0 },     // 橙
    { r: 255, g: 255, b: 0 },    // 黄
    { r: 0, g: 255, b: 0 },      // 绿
    { r: 0, g: 255, b: 255 },    // 青
    { r: 0, g: 0, b: 255 },      // 蓝
    { r: 160, g: 0, b: 255 },    // 紫
  ]
  assert.equal(hex(encodeLeds(rainbow)), '55 AA 01 FF 00 00 FF 60 00 FF FF 00 00 FF 00 00 FF FF 00 00 FF A0 00 FF F7 BB')
})

test('蜂鸣 = README 示例帧（小端：频率 + 音量 + 时长）', () => {
  assert.equal(hex(encodeBuzzer({ freqHz: 2000, volume: 100, durationMs: 500 })), '55 AA 02 D0 07 64 F4 01 31 BB')
  assert.equal(hex(encodeBuzzer({ freqHz: 1000, volume: 80, durationMs: 1000 })), '55 AA 02 E8 03 50 E8 03 27 BB')
})

test('校验和 = 从 0x55 累加到 payload 最后字节，取低 8 位', () => {
  assert.equal(checksum([0x55, 0xaa, 0x01, 0xff, 0x00, 0x00]), 0xff)
  assert.equal(checksum([0xff, 0xff, 0xff]), 0xfd)
  const frame = encodeFrame(MODE.VERIFY, [])
  assert.equal(frame[3], checksum(frame.subarray(0, 3)))
})

test('参数夹紧：蜂鸣频率 20..20000、音量 0..100、时长 0..65535', () => {
  const hi = encodeBuzzer({ freqHz: 99999, volume: 999, durationMs: 999999 })
  assert.equal(hi[3] | (hi[4] << 8), 20000)
  assert.equal(hi[5], 100)
  assert.equal(hi[6] | (hi[7] << 8), 65535)
  const lo = encodeBuzzer({ freqHz: 1, volume: -3, durationMs: -1 })
  assert.equal(lo[3] | (lo[4] << 8), 20)
  assert.equal(lo[5], 0)
  assert.equal(lo[6] | (lo[7] << 8), 0)
})

test('未知 MODE / 载荷长度不对 → 抛错（不猜意图）', () => {
  assert.throws(() => encodeFrame(0x03, []), /未知 MODE/)
  assert.throws(() => encodeFrame(0x01, new Array(20).fill(0)), /需要 21 字节/)
  assert.throws(() => encodeLeds([{ r: 0, g: 0, b: 0 }]), /需要 7 颗灯/)
  // 通道值超界按字节夹紧，不抛
  assert.equal(encodeLeds(Array.from({ length: 7 }, () => ({ r: 300, g: -5, b: 128.7 })))[3], 255)
})

test('回包扫描器：跨 chunk 也能认出 "AI Status Lights OK\\r\\n"，且不会无限增长', () => {
  const scanner = createReplyScanner()
  const reply = Buffer.from(VERIFY_REPLY, 'ascii')
  assert.equal(scanner.push(reply.subarray(0, 5)), 0)
  assert.equal(scanner.push(reply.subarray(5)), 1)
  assert.equal(scanner.stats.verifies, 1)
  assert.equal(scanner.push(Buffer.concat([reply, reply])), 2)
  assert.equal(scanner.stats.verifies, 3)
  for (let i = 0; i < 10; i += 1) scanner.push(Buffer.from('xxxxxxxxxxxxxxxxxxxx'))
  assert.ok(scanner.stats.dropped > 0)
  assert.equal(scanner.push(reply), 1)
})

test('亮度缩放与像素比较（主机端亮度的实现基础）', () => {
  assert.deepEqual(scaleColor({ r: 200, g: 100, b: 50 }, 0), { r: 0, g: 0, b: 0 })
  assert.deepEqual(scaleColor({ r: 200, g: 100, b: 50 }, 255), { r: 200, g: 100, b: 50 })
  assert.deepEqual(scaleColor({ r: 200, g: 100, b: 50 }, 128), { r: 100, g: 50, b: 25 })
  assert.equal(pixelsEqual([{ r: 1, g: 2, b: 3 }], [{ r: 1, g: 2, b: 3 }]), true)
  assert.equal(pixelsEqual([{ r: 1, g: 2, b: 3 }], [{ r: 1, g: 2, b: 4 }]), false)
  assert.equal(pixelsEqual([{ r: 1, g: 2, b: 3 }], []), false)
})

test('clampByte / describeFrame 的小行为', () => {
  assert.equal(clampByte(Number.NaN), 0)
  assert.equal(clampByte(-1), 0)
  assert.equal(clampByte(255.9), 255)
  assert.equal(describeFrame(encodeVerify()), 'VERIFY 5B')
  assert.equal(describeFrame(encodeLeds(Array.from({ length: 7 }, () => ({ r: 0, g: 0, b: 0 })))), 'LEDS 26B')
  assert.equal(describeFrame(Buffer.from([1])), 'raw(1B)')
})
