// Linux D-Bus 发送层单测（node:test，无第三方依赖；编组是平台无关的纯逻辑）
//   npm test
//
// 用一份测试侧的解码器把 marshalNotifyCall 产出的字节流解回来，锁住：
//   · 小端 method_call 头、body 长度、serial、header fields（PATH/INTERFACE/MEMBER/DESTINATION/SIGNATURE）
//   · Notify 方法体 susssasa{sv}i 的字段与对齐（含 a{sv} hints 的 urgency）
//   · 分帧函数 messageLength 与自身产出长度一致
//   · 总线地址解析与 SASL EXTERNAL 认证行
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  authLine, marshalNotifyCall, messageLength, parseBusAddress,
} from '../lib/toast-linux.js'

const NOTIFY_SIGNATURE = 'susssasa{sv}i'

// ---- 测试侧解码器（只覆盖本模块用到的类型）----
class Reader {
  constructor(buf) { this.buf = buf; this.offset = 0 }
  align(n) { this.offset += (n - (this.offset % n)) % n; return this }
  u8() { const v = this.buf.readUInt8(this.offset); this.offset += 1; return v }
  u32() { this.align(4); const v = this.buf.readUInt32LE(this.offset); this.offset += 4; return v }
  i32() { this.align(4); const v = this.buf.readInt32LE(this.offset); this.offset += 4; return v }
  str() {
    const len = this.u32()
    const s = this.buf.subarray(this.offset, this.offset + len).toString('utf8')
    this.offset += len + 1
    return s
  }
  sig() {
    const len = this.u8()
    const s = this.buf.subarray(this.offset, this.offset + len).toString('ascii')
    this.offset += len + 1
    return s
  }
}

function decodeMessage(message) {
  const r = new Reader(message)
  const endian = String.fromCharCode(r.u8())
  const type = r.u8()
  const flags = r.u8()
  const version = r.u8()
  const bodyLen = r.u32()
  const serial = r.u32()
  const fieldsLen = r.u32()
  r.align(8)
  const fieldsStart = r.offset
  const fields = {}
  while (r.offset < fieldsStart + fieldsLen) {
    r.align(8)
    const code = r.u8()
    const sig = r.sig()
    fields[code] = sig === 'g' ? r.sig() : r.str()
  }
  r.align(8)
  const bodyStart = r.offset
  assert.equal(bodyStart + bodyLen, message.length, 'body 长度与实际字节数一致')
  return { endian, type, flags, version, bodyLen, serial, fields, body: new Reader(message.subarray(bodyStart)) }
}

function decodeNotifyBody(body) {
  const out = {}
  out.appName = body.str()
  out.replacesId = body.u32()
  out.appIcon = body.str()
  out.summary = body.str()
  out.body = body.str()
  body.align(4)
  out.actionsLen = body.u32()
  // a{sv}：长度为元素数据字节数，元素前按 8 对齐
  body.align(4)
  const hintsLen = body.u32()
  body.align(8)
  const hintsEnd = body.offset + hintsLen
  out.hints = {}
  while (body.offset < hintsEnd) {
    body.align(8)
    const key = body.str()
    const sig = body.sig()
    out.hints[key] = sig === 'y' ? body.u8() : null
  }
  out.expireTimeout = body.i32()
  return out
}

test('消息头是小端 method_call 且字段齐全', () => {
  const frame = marshalNotifyCall({ title: '标题', message: '正文', urgency: 'normal', serial: 7 })
  assert.equal(messageLength(frame), frame.length)
  const msg = decodeMessage(frame)
  assert.equal(msg.endian, 'l')
  assert.equal(msg.type, 1)
  assert.equal(msg.version, 1)
  assert.equal(msg.serial, 7)
  assert.equal(msg.fields[1], '/org/freedesktop/Notifications')
  assert.equal(msg.fields[2], 'org.freedesktop.Notifications')
  assert.equal(msg.fields[3], 'Notify')
  assert.equal(msg.fields[6], 'org.freedesktop.Notifications')
  assert.equal(msg.fields[8], NOTIFY_SIGNATURE)
})

test('方法体字段与 Notify 签名一致', () => {
  const frame = marshalNotifyCall({ title: '✅ 任务完成', message: '工作区/会话:完毕', serial: 1 })
  const body = decodeNotifyBody(decodeMessage(frame).body)
  assert.equal(body.appName, 'DSH')
  assert.equal(body.replacesId, 0)
  assert.equal(body.summary, '✅ 任务完成')
  assert.equal(body.body, '工作区/会话:完毕')
  assert.equal(body.actionsLen, 0)
  assert.equal(body.expireTimeout, -1)
  assert.ok(body.appIcon.endsWith('dsh.png'), 'app_icon 指向随包 PNG')
})

test('hints 始终带一条 urgency，且映射到 D-Bus 取值', () => {
  const urgencyOf = (urgency) => decodeNotifyBody(
    decodeMessage(marshalNotifyCall({ title: 't', urgency, serial: 2 })).body,
  ).hints
  assert.deepEqual(urgencyOf('low'), { urgency: 0 })
  assert.deepEqual(urgencyOf('normal'), { urgency: 1 })
  assert.deepEqual(urgencyOf('critical'), { urgency: 2 })
  assert.deepEqual(urgencyOf(undefined), { urgency: 1 })
  assert.deepEqual(urgencyOf('未知档位'), { urgency: 1 })
})

test('正文里含多字节字符与换行时不破坏编组', () => {
  const text = '中文🙂\n第二行\ttab'
  const frame = marshalNotifyCall({ title: text, message: text, serial: 3 })
  const body = decodeNotifyBody(decodeMessage(frame).body)
  assert.equal(body.summary, text)
  assert.equal(body.body, text)
})

test('超长文案截断，避免超出通知服务限制', () => {
  const frame = marshalNotifyCall({ title: 'x'.repeat(300), message: 'y'.repeat(900), serial: 4 })
  const body = decodeNotifyBody(decodeMessage(frame).body)
  assert.equal(body.summary.length, 160)
  assert.equal(body.body.length, 400)
})

test('总线地址解析：环境变量 path / abstract / 缺省回退', () => {
  assert.deepEqual(parseBusAddress('unix:path=/run/user/1000/bus', 1000), { path: '/run/user/1000/bus' })
  assert.deepEqual(
    parseBusAddress('unix:abstract=/tmp/dbus-Ab12,guid=ff00', 1000),
    { path: '\0/tmp/dbus-Ab12' },
  )
  assert.deepEqual(parseBusAddress('', 1000), { path: '/run/user/1000/bus' })
  assert.deepEqual(parseBusAddress(undefined, 0), { path: '/run/user/0/bus' })
})

test('SASL EXTERNAL 首行是 uid 十进制字符串的十六进制', () => {
  assert.equal(authLine(1000), 'AUTH EXTERNAL 31303030')
  assert.equal(authLine(0), 'AUTH EXTERNAL 30')
})

test('分帧：固定头不足返回 0，头齐了给出该消息总长度', () => {
  const frame = marshalNotifyCall({ title: 't', serial: 5 })
  assert.equal(messageLength(frame.subarray(0, 8)), 0)
  // 头已齐、正文还没收全：仍返回该消息需要的总长度，由调用方比对缓冲区大小
  assert.equal(messageLength(frame.subarray(0, frame.length - 1)), frame.length)
  assert.equal(messageLength(frame), frame.length)
})
