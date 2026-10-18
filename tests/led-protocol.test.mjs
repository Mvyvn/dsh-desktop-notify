// LED 串口线协议单测（node:test，无第三方依赖）
//
// 锁住的核心语义：
//   · 帧格式：A5 5A | TYPE | SEQ | LEN | PAYLOAD | CRC8，载荷上限 32
//   · CRC8 的标准校验值（"123456789" → 0xF4），保证固件端算的是同一个多项式
//   · 解析器能跨 chunk 拼接、能重同步（坏帧不能把解析器永久带偏）
//   · SCENE / EFFECT / OVERLAY / CONFIG 载荷布局（固件自测重放同一批向量）
//   · RGB332 往返、ASCII 兜底命令解析
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeFrame, createFrameParser, crc8, rgbToRgb332, rgb332ToRgb,
  scenePayload, decodeScene, effectPayload, overlayPayload, configPayload,
  stateFromCode, effectFromCode, frameTypeName, describeFrame,
  parseAsciiLine, LED_STATE_CODE, LED_EFFECT_CODE, FRAME, REPLY,
  FRAME_SOF0, FRAME_SOF1, MAX_PAYLOAD, clampBrightness, MAX_EXPLICIT_BRIGHTNESS,
} from '../lib/led-protocol.js'

test('CRC8 标准校验值：poly 0x07/init 0x00 下 "123456789" = 0xF4', () => {
  const bytes = Buffer.from('123456789', 'ascii')
  assert.equal(crc8(bytes), 0xf4)
})

test('编一帧：帧头、长度、CRC 都符合约定', () => {
  const frame = encodeFrame(FRAME.SCENE, 0x2a, [1, 2, 3])
  assert.equal(frame[0], FRAME_SOF0)
  assert.equal(frame[1], FRAME_SOF1)
  assert.equal(frame[2], FRAME.SCENE)
  assert.equal(frame[3], 0x2a)
  assert.equal(frame[4], 3)
  assert.deepEqual([...frame.subarray(5, 8)], [1, 2, 3])
  assert.equal(frame[8], crc8(frame.subarray(2, 8)))
  assert.equal(frame.length, 6 + 3)
})

test('空载荷帧（心跳）也能编', () => {
  const frame = encodeFrame(FRAME.PING, 7)
  assert.equal(frame.length, 6)
  assert.equal(frame[4], 0)
})

test('载荷超长直接抛错（宁可在主机侧炸，也不发固件解析不了的帧）', () => {
  assert.throws(() => encodeFrame(FRAME.EFFECT, 1, new Array(MAX_PAYLOAD + 1).fill(0)), /载荷过长/)
  assert.doesNotThrow(() => encodeFrame(FRAME.EFFECT, 1, new Array(MAX_PAYLOAD).fill(0)))
})

test('解析器：一次喂一帧，字段原样出', () => {
  const parser = createFrameParser()
  const frame = encodeFrame(FRAME.EFFECT, 9, [1, 2, 3, 4, 5])
  const out = parser.push(frame)
  assert.equal(out.length, 1)
  assert.equal(out[0].type, FRAME.EFFECT)
  assert.equal(out[0].seq, 9)
  assert.deepEqual(out[0].payload, [1, 2, 3, 4, 5])
  assert.equal(parser.stats.frames, 1)
  assert.equal(parser.stats.crcErrors, 0)
})

test('解析器：跨 chunk 的半个帧要能拼起来', () => {
  const parser = createFrameParser()
  const frame = encodeFrame(FRAME.SCENE, 1, scenePayload({ state: 'running' }))
  const part1 = parser.push(frame.subarray(0, 4))
  assert.deepEqual(part1, [])
  const part2 = parser.push(frame.subarray(4))
  assert.equal(part2.length, 1)
  assert.equal(part2[0].type, FRAME.SCENE)
})

test('解析器：CRC 错丢帧并重同步，后续好帧照常解出', () => {
  const parser = createFrameParser()
  const bad = encodeFrame(FRAME.SCENE, 1, [1, 1, 1, 1, 1])
  bad[bad.length - 1] ^= 0xff
  const good = encodeFrame(FRAME.PING, 2)
  const out = parser.push(Buffer.concat([bad, good]))
  assert.equal(out.length, 1)
  assert.equal(out[0].type, FRAME.PING)
  assert.equal(parser.stats.crcErrors, 1)
})

test('解析器：垃圾字节被丢掉，不影响后面的好帧', () => {
  const parser = createFrameParser()
  const good = encodeFrame(FRAME.SCENE, 3, scenePayload({ state: 'done' }))
  const out = parser.push(Buffer.concat([Buffer.from('hello world\r\n'), good]))
  assert.equal(out.length, 1)
  assert.equal(out[0].type, FRAME.SCENE)
  assert.ok(parser.stats.resyncs >= 13)
})

test('解析器：未知类型 / 超长 LEN 的帧被丢弃且不卡死', () => {
  const parser = createFrameParser()
  const bogus = Buffer.from([FRAME_SOF0, FRAME_SOF1, 0x77, 0x01, 0x02, 0, 0])
  const good = encodeFrame(FRAME.SCENE, 4, scenePayload({ state: 'error' }))
  const out = parser.push(Buffer.concat([bogus, good]))
  assert.equal(out.length, 1)
  assert.equal(out[0].payload[0], LED_STATE_CODE.error)
  assert.ok(parser.stats.dropped >= 1)
})

test('SCENE 载荷：五字节布局与解码往返', () => {
  const payload = scenePayload({ state: 'waiting', flags: 0x01, brightness: 200, progress: 42, accent: 0x1b })
  assert.deepEqual(payload, [LED_STATE_CODE.waiting, 0x01, 200, 42, 0x1b])
  const decoded = decodeScene(payload)
  assert.equal(decoded.state, 'waiting')
  assert.equal(decoded.flags, 0x01)
  assert.equal(decoded.brightness, 200)
  assert.equal(decoded.progress, 42)
  assert.equal(decoded.accent, 0x1b)
})

test('SCENE 缺省：亮度/进度用哨兵值（固件据此用自己的默认亮度）', () => {
  const payload = scenePayload({ state: 'running' })
  assert.equal(payload[2], 0xff)
  assert.equal(payload[3], 0xff)
  assert.equal(payload[4], 0xff)
})

test('亮度哨兵：显式亮度上限是 254，255 永远表示"设备自己决定"', () => {
  // 这条是固件自测抓到的真实事故的回归：主机发"最亮(255)"曾被固件当成
  // "用我的默认亮度(160)"，表现就是"调到最亮反而变暗"。
  assert.equal(clampBrightness(255), MAX_EXPLICIT_BRIGHTNESS)
  assert.equal(clampBrightness(254), 254)
  assert.equal(clampBrightness(-1), 0)
  assert.equal(clampBrightness(NaN), 0)
  assert.equal(scenePayload({ state: 'done', brightness: 255 })[2], 254, '显式 255 必须被夹到 254')
  assert.equal(scenePayload({ state: 'done', brightness: 999 })[2], 254)
  assert.equal(effectPayload({ effect: 'solid', brightness: 255 })[2], 254)
  assert.equal(effectPayload({ effect: 'solid' })[2], 0xff, '不传亮度才是"设备默认"')
})

test('SCENE 解码：未知状态码返回 null（不猜）', () => {
  assert.equal(decodeScene([0x7f, 0, 0, 0, 0]), null)
  assert.equal(decodeScene([0x01, 0]), null)     // 载荷太短
})

test('EFFECT 载荷：颜色压成 RGB332（1 字节省带宽）', () => {
  const payload = effectPayload({ effect: 'flow-both', speed: 9, brightness: 128, color: { r: 255, g: 255, b: 255 }, param: 3 })
  assert.equal(payload[0], LED_EFFECT_CODE['flow-both'])
  assert.equal(payload[1], 9)
  assert.equal(payload[2], 128)
  assert.equal(payload[3], rgbToRgb332(255, 255, 255))
  assert.equal(payload[4], 3)
})

test('OVERLAY 载荷：TTL 大端两字节 + 重复次数（固件自己到期回落）', () => {
  const payload = overlayPayload({ effect: 'double-flash', ttlMs: 0x1234, repeat: 3, color: { r: 0, g: 255, b: 0 } })
  assert.equal(payload.length, 8)               // 5（效果）+ 2（TTL）+ 1（重复次数）
  assert.equal(payload[5], 0x12)
  assert.equal(payload[6], 0x34)
  assert.equal(payload[7], 3)
  assert.equal(overlayPayload({ effect: 'blink', ttlMs: 70000 }).slice(5, 7).join(','), '255,255')  // 夹到 65535
})

test('CONFIG 载荷：小端 u32', () => {
  assert.deepEqual(configPayload(1, 60), [1, 60, 0, 0, 0])
  assert.deepEqual(configPayload(2, 0x01020304), [2, 0x04, 0x03, 0x02, 0x01])
})

test('RGB332 往返：量化误差在可接受范围内（LED 不需要 8 位精度）', () => {
  for (const [r, g, b] of [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 255, 64], [255, 176, 0]]) {
    const back = rgb332ToRgb(rgbToRgb332(r, g, b))
    assert.ok(Math.abs(back.r - r) <= 36, `r ${r} → ${back.r}`)
    assert.ok(Math.abs(back.g - g) <= 36, `g ${g} → ${back.g}`)
    assert.ok(Math.abs(back.b - b) <= 85, `b ${b} → ${back.b}`)
  }
})

test('词表：状态/效果码可逆，未知码返回 null', () => {
  assert.equal(stateFromCode(LED_STATE_CODE.done), 'done')
  assert.equal(stateFromCode(0x55), null)
  assert.equal(effectFromCode(LED_EFFECT_CODE.rainbow), 'rainbow')
  assert.equal(effectFromCode(0x55), null)
})

test('帧类型名与可读描述（日志排障用）', () => {
  assert.equal(frameTypeName(FRAME.SCENE), 'SCENE')
  assert.equal(frameTypeName(REPLY.HELLO_ACK), 'reply:HELLO_ACK')
  const scene = describeFrame({ type: FRAME.SCENE, seq: 1, payload: scenePayload({ state: 'done', flags: 0x01, brightness: 180 }) })
  assert.match(scene, /SCENE state=done\+attention bright=180/)
  const eff = describeFrame({ type: FRAME.EFFECT, seq: 2, payload: effectPayload({ effect: 'breathe' }) })
  assert.match(eff, /EFFECT effect=breathe/)
})

test('ASCII 兜底：状态、亮度、效果、进度、询问', () => {
  assert.deepEqual(parseAsciiLine('S:RUN'), { cmd: 'S', args: [], state: 'running' })
  assert.deepEqual(parseAsciiLine('B:128'), { cmd: 'B', args: [128] })
  assert.deepEqual(parseAsciiLine('E:3,255,176,0,5'), { cmd: 'E', args: [3, 255, 176, 0, 5] })
  assert.deepEqual(parseAsciiLine('P:42'), { cmd: 'P', args: [42] })
  assert.deepEqual(parseAsciiLine('?'), { cmd: '?', args: [] })
  assert.equal(parseAsciiLine('S:NOPE'), null)
  assert.equal(parseAsciiLine('X:1'), null)
  assert.equal(parseAsciiLine('# 注释'), null)
  assert.equal(parseAsciiLine(''), null)
  assert.equal(parseAsciiLine('E:1,abc'), null)
})
