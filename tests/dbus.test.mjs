// Linux D-Bus 层单测（node:test，无第三方依赖；编组/解码是平台无关的纯逻辑）
//   npm test
//
// 锁住：
//   · method_call 编组：小端固定头、body 长度、serial、header fields
//   · 解码器与编组器互逆：Reader 能把 marshalMethodCall / marshalNotifyBody 解回来
//   · Notify 方法体 susssasa{sv}i 的字段与对齐（含 a{sv} hints 的 urgency）
//   · 分帧函数 messageLength 与自身产出长度一致
//   · 总线地址解析、SASL EXTERNAL 认证行、签名切分
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIELD, Reader, Writer, authLine, dataLine, decodeMessage, marshalMethodCall, messageLength,
  parseBusAddress, splitSignature,
} from '../lib/dbus.js'
import { NOTIFY_SIGNATURE, marshalNotifyBody } from '../lib/toast-linux.js'

const ICON = '/opt/dsh/assets/dsh-dark.png'

function decodeNotifyBody(body) {
  const r = new Reader(body)
  const out = {}
  out.appName = r.str()
  out.replacesId = r.u32()
  out.appIcon = r.str()
  out.summary = r.str()
  out.body = r.str()
  out.actions = r.array('s')
  out.hints = Object.fromEntries(r.array('{sv}'))
  out.expireTimeout = r.i32()
  return out
}

test('method_call 头部是小端且字段齐全', () => {
  const frame = marshalMethodCall({
    path: '/org/freedesktop/Notifications',
    interface: 'org.freedesktop.Notifications',
    member: 'Notify',
    destination: 'org.freedesktop.Notifications',
    signature: NOTIFY_SIGNATURE,
    body: marshalNotifyBody({ title: 't', iconPath: ICON }),
    serial: 7,
  })
  assert.equal(frame.readUInt8(0), 0x6c)   // 'l'
  assert.equal(frame.readUInt8(1), 1)      // METHOD_CALL
  assert.equal(frame.readUInt8(3), 1)      // 协议版本
  assert.equal(frame.readUInt32LE(8), 7)   // serial
  assert.equal(messageLength(frame), frame.length)

  const msg = decodeMessage(frame)
  assert.equal(msg.type, 1)
  assert.equal(msg.serial, 7)
  assert.equal(msg.fields[FIELD.PATH], '/org/freedesktop/Notifications')
  assert.equal(msg.fields[FIELD.INTERFACE], 'org.freedesktop.Notifications')
  assert.equal(msg.fields[FIELD.MEMBER], 'Notify')
  assert.equal(msg.fields[FIELD.DESTINATION], 'org.freedesktop.Notifications')
  assert.equal(msg.signature, NOTIFY_SIGNATURE)
  // body 解出来必须和方法体逐字段一致
  const decoded = new Reader(msg.body)
  assert.equal(decoded.str(), 'DSH')
})

test('无 body 的调用不写 SIGNATURE 字段（Hello）', () => {
  const frame = marshalMethodCall({
    path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus',
    member: 'Hello',
    serial: 2,
  })
  const msg = decodeMessage(frame)
  assert.equal(msg.signature, '')
  assert.equal(msg.body.length, 0)
  assert.equal(msg.fields[FIELD.DESTINATION], undefined)
})

test('方法体字段与 Notify 签名一致', () => {
  const body = marshalNotifyBody({ title: '✅ 任务完成', message: '工作区/会话:完毕', iconPath: ICON })
  const frame = marshalMethodCall({
    path: '/org/freedesktop/Notifications',
    interface: 'org.freedesktop.Notifications',
    member: 'Notify',
    signature: NOTIFY_SIGNATURE,
    body,
    serial: 1,
  })
  const decoded = decodeNotifyBody(decodeMessage(frame).body)
  assert.equal(decoded.appName, 'DSH')
  assert.equal(decoded.replacesId, 0)
  assert.equal(decoded.appIcon, ICON)
  assert.equal(decoded.summary, '✅ 任务完成')
  assert.equal(decoded.body, '工作区/会话:完毕')
  assert.deepEqual(decoded.actions, [])
  assert.equal(decoded.expireTimeout, -1)
})

test('hints 始终带一条 urgency，且映射到 D-Bus 取值', () => {
  const urgencyOf = (urgency) => decodeNotifyBody(
    marshalNotifyBody({ title: 't', urgency, iconPath: ICON }),
  ).hints
  assert.deepEqual(urgencyOf('low'), { urgency: 0 })
  assert.deepEqual(urgencyOf('normal'), { urgency: 1 })
  assert.deepEqual(urgencyOf('critical'), { urgency: 2 })
  assert.deepEqual(urgencyOf(undefined), { urgency: 1 })
  assert.deepEqual(urgencyOf('未知档位'), { urgency: 1 })
})

test('正文里含多字节字符与换行时不破坏编组', () => {
  const text = '中文🙂\n第二行\ttab'
  const decoded = decodeNotifyBody(marshalNotifyBody({ title: text, message: text, iconPath: ICON }))
  assert.equal(decoded.summary, text)
  assert.equal(decoded.body, text)
})

test('超长文案截断，避免超出通知服务限制', () => {
  const decoded = decodeNotifyBody(marshalNotifyBody({
    title: 'x'.repeat(300), message: 'y'.repeat(900), iconPath: ICON,
  }))
  assert.equal(decoded.summary.length, 160)
  assert.equal(decoded.body.length, 400)
})

test('总线地址解析：环境变量 path / abstract / 键序任意 / XDG 回退', () => {
  assert.deepEqual(parseBusAddress('unix:path=/run/user/1000/bus', 1000), { path: '/run/user/1000/bus' })
  assert.deepEqual(
    parseBusAddress('unix:abstract=/tmp/dbus-Ab12,guid=ff00', 1000),
    { path: '\0/tmp/dbus-Ab12' },
  )
  // 键值顺序不固定（规范允许任意顺序），path 在后面也要认出来
  assert.deepEqual(
    parseBusAddress('unix:guid=ff00,path=/tmp/bus', 1000),
    { path: '/tmp/bus' },
  )
  // 多段地址（; 分隔）：取 unix: 那一段
  assert.deepEqual(
    parseBusAddress('tcp:host=localhost,port=1234;unix:path=/tmp/x', 1000),
    { path: '/tmp/x' },
  )
  // 认不出传输时：优先 $XDG_RUNTIME_DIR，其次 /run/user/<uid>/bus
  assert.deepEqual(parseBusAddress('', 1000, '/run/user/1000'), { path: '/run/user/1000/bus' })
  assert.deepEqual(parseBusAddress('tcp:host=localhost', 1000, '/xdg/'), { path: '/xdg/bus' })
  assert.deepEqual(parseBusAddress('', 1000), { path: '/run/user/1000/bus' })
  assert.deepEqual(parseBusAddress(undefined, 0), { path: '/run/user/0/bus' })
})

test('SASL EXTERNAL 首行是 uid 十进制字符串的十六进制', () => {
  assert.equal(authLine(1000), 'AUTH EXTERNAL 31303030')
  assert.equal(authLine(0), 'AUTH EXTERNAL 30')
})

test('SASL DATA 续行必须带 DATA 前缀（裸十六进制会被服务端回 ERROR）', () => {
  assert.equal(dataLine(1000), 'DATA 31303030\r\n')
  assert.equal(dataLine(0), 'DATA 30\r\n')
})

test('分帧拒绝大端消息（0x42）而不是把字段解错位', () => {
  const frame = marshalMethodCall({ path: '/p', interface: 'i.f', member: 'M', serial: 3 })
  const bigEndian = Buffer.from(frame)
  bigEndian.writeUInt8(0x42, 0)   // 'B'
  assert.equal(messageLength(bigEndian), 0, '大端帧必须被拒绝')
  assert.equal(messageLength(frame), frame.length, '小端帧照常分帧')
})

/**
 * 测试侧编组一条 method_return / error 帧（插件只发 method_call，
 * 但必须能解总线的回复——Hello、portal 读取都靠它）。
 */
function marshalReply({ type = 2, serial, replySerial, sender = ':1.0', signature = '', body = Buffer.alloc(0), errorName }) {
  const w = new Writer()
  w.u8(0x6c).u8(type).u8(0).u8(1)
  w.u32(body.length).u32(serial)
  w.align(4)
  const fieldsLenPos = w.length
  w.u32(0)
  w.align(8)
  const fieldsStart = w.length
  w.align(8).u8(FIELD.REPLY_SERIAL).sig('u').u32(replySerial)
  w.align(8).u8(FIELD.SENDER).sig('s').str(sender)
  if (errorName) { w.align(8).u8(FIELD.ERROR_NAME).sig('s').str(errorName) }
  if (signature) { w.align(8).u8(FIELD.SIGNATURE).sig('g').sig(signature) }
  const head = w.buffer()
  head.writeUInt32LE(w.length - fieldsStart, fieldsLenPos)
  const pad = Buffer.alloc((8 - (head.length % 8)) % 8)
  return Buffer.concat([head, pad, body])
}

test('method_return：REPLY_SERIAL 是 uint32 而不是字符串（Hello/portal 回复全靠它）', () => {
  const body = new Writer().str(':1.42').buffer()
  const msg = decodeMessage(marshalReply({ serial: 2, replySerial: 7, signature: 's', body }))
  assert.equal(msg.type, 2)
  assert.equal(msg.serial, 2)
  assert.equal(msg.fields[FIELD.REPLY_SERIAL], 7, '必须解成数字 7，而不是被当成串长')
  assert.equal(msg.fields[FIELD.SENDER], ':1.0')
  assert.equal(msg.signature, 's')
  assert.equal(new Reader(msg.body).str(), ':1.42')
})

test('error 回复：ERROR_NAME 与正文可读', () => {
  const body = new Writer().str('no such method').buffer()
  const msg = decodeMessage(marshalReply({
    type: 3, serial: 3, replySerial: 9, signature: 's', body,
    errorName: 'org.freedesktop.DBus.Error.UnknownMethod',
  }))
  assert.equal(msg.type, 3)
  assert.equal(msg.fields[FIELD.REPLY_SERIAL], 9)
  assert.equal(msg.fields[FIELD.ERROR_NAME], 'org.freedesktop.DBus.Error.UnknownMethod')
  assert.equal(new Reader(msg.body).str(), 'no such method')
})

test('信号帧：SettingChanged 的 (ssv) 载核可解', () => {
  const w = new Writer()
  w.str('org.freedesktop.appearance').str('color-scheme').sig('v').sig('u').u32(1)
  const body = w.buffer()
  const frame = marshalReply({ type: 4, serial: 4, replySerial: 0, signature: 'ssv', body })
  const msg = decodeMessage(frame)
  assert.equal(msg.type, 4)
  const r = new Reader(msg.body)
  assert.deepEqual(splitSignature(msg.signature).map((s) => r.value(s)),
    ['org.freedesktop.appearance', 'color-scheme', 1])
})

test('分帧：固定头不足返回 0，头齐了给出该消息总长度', () => {
  const frame = marshalMethodCall({
    path: '/p', interface: 'i.f', member: 'M',
    body: marshalNotifyBody({ title: 't', iconPath: ICON }), serial: 5,
  })
  assert.equal(messageLength(frame.subarray(0, 8)), 0)
  // 头已齐、正文还没收全：仍返回该消息需要的总长度，由调用方比对缓冲区大小
  assert.equal(messageLength(frame.subarray(0, frame.length - 1)), frame.length)
  assert.equal(messageLength(frame), frame.length)
})

test('签名切分：数组/字典/结构体/嵌套', () => {
  assert.deepEqual(splitSignature('susssasa{sv}i'), ['s', 'u', 's', 's', 's', 'as', 'a{sv}', 'i'])
  assert.deepEqual(splitSignature(''), [])
  assert.deepEqual(splitSignature('aai'), ['aai'])
  assert.deepEqual(splitSignature('(uu)v'), ['(uu)', 'v'])
  assert.deepEqual(splitSignature('a(ss)'), ['a(ss)'])
})

test('Reader：字符串/数组/字典/变体/结构体解码', () => {
  // 手工编组：长度字段必须按"元素数据字节数"填，这里用 Writer 自己量，避免手算对齐
  const strings = new Writer()
  strings.str('a').str('b')
  const dict = new Writer()
  dict.align(8).str('k').sig('v').sig('u').u32(1)
  const w = new Writer()
  w.str('hello').u32(42)
  w.align(4).u32(strings.length).raw(strings.buffer())
  w.align(4).u32(dict.length).raw(dict.buffer())
  w.align(8).i32(-1).i32(2)   // 结构体 (ii)：对齐 8 + 两个 int32
  const r = new Reader(w.buffer())
  assert.equal(r.value('s'), 'hello')
  assert.equal(r.value('u'), 42)
  assert.deepEqual(r.array('s'), ['a', 'b'])
  assert.deepEqual(r.array('{sv}'), [['k', 1]])
  assert.deepEqual(r.value('(ii)'), [-1, 2])
})

test('Reader：变体内层签名决定解码方式', () => {
  const w = new Writer()
  w.sig('v').sig('s').str('portal')
  const r = new Reader(w.buffer())
  assert.equal(r.value('v'), 'portal')
})
