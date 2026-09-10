// DSH 桌面通知 — Linux 发送模块（纯 JS 直连 D-Bus，无子进程、无第三方依赖）
//
// 链路：会话总线（$DBUS_SESSION_BUS_ADDRESS 或 /run/user/<uid>/bus）
//   → SASL EXTERNAL 握手（\0 + AUTH EXTERNAL <hex uid> → OK <guid> → BEGIN）
//   → 调 org.freedesktop.Notifications.Notify（对象 /org/freedesktop/Notifications）
//   → 消息编组（小端，method_call，header fields：PATH/INTERFACE/MEMBER/DESTINATION/SIGNATURE）
//
// 发送是异步 fire-and-forget：连接惰性建立并常驻复用，断开后下次发送自动重连；
// 调用方（lib/index.js 的队列）不被阻塞。错误走 console.error，不打断宿主。
//
// 编组逻辑是平台无关的纯函数（marshalNotifyCall / parseBusAddress / authLine /
// messageLength），可在任何平台上单测（tests/dbus.test.mjs）。

import { connect } from 'node:net'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const ICON_PATH = join(ASSETS, 'dsh.png')
const HAS_ICON = existsSync(ICON_PATH)

const APP_NAME = 'DSH'
const DESTINATION = 'org.freedesktop.Notifications'
const OBJECT_PATH = '/org/freedesktop/Notifications'
const INTERFACE = 'org.freedesktop.Notifications'
const MEMBER = 'Notify'
/** Notify 的方法签名：app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout */
const NOTIFY_SIGNATURE = 'susssasa{sv}i'

const METHOD_CALL = 1
const METHOD_RETURN = 2
const MESSAGE_ERROR = 3
const PROTOCOL_VERSION = 1

/** urgency 提示值（0 低 / 1 正常 / 2 紧急） */
const URGENCY_VALUE = { low: 0, normal: 1, critical: 2 }
/** 未指定超时：交给桌面环境决定 */
const DEFAULT_EXPIRE_TIMEOUT = -1
/** 未连上时最多缓存多少条待发通知 */
const MAX_PENDING = 32

// ---------------------------------------------------------------------------
// 编组（marshalling）— 纯函数，便于单测
// ---------------------------------------------------------------------------

class Writer {
  constructor() {
    this.parts = []
    this.length = 0
  }
  /** 按 D-Bus 规则补零到 n 字节边界 */
  align(n) {
    const pad = (n - (this.length % n)) % n
    if (pad > 0) this.raw(Buffer.alloc(pad))
    return this
  }
  raw(buf) {
    this.parts.push(buf)
    this.length += buf.length
    return this
  }
  u8(v) {
    const b = Buffer.alloc(1)
    b.writeUInt8(v & 0xff, 0)
    return this.raw(b)
  }
  u32(v) {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v >>> 0, 0)
    return this.raw(b)
  }
  i32(v) {
    const b = Buffer.alloc(4)
    b.writeInt32LE(v | 0, 0)
    return this.raw(b)
  }
  /** STRING / OBJECT_PATH：对齐 4 + uint32 长度 + UTF-8 字节 + NUL */
  str(s) {
    const data = Buffer.from(String(s), 'utf8')
    this.align(4)
    this.u32(data.length)
    this.raw(data)
    return this.u8(0)
  }
  /** SIGNATURE：1 字节长度 + ASCII 字节 + NUL（对齐 1） */
  sig(s) {
    const data = Buffer.from(String(s), 'ascii')
    this.u8(data.length)
    this.raw(data)
    return this.u8(0)
  }
  buffer() {
    return Buffer.concat(this.parts)
  }
}

/** 写一个 header field：struct(yv)，元素对齐 8 */
function headerField(w, code, signature, write) {
  w.align(8)
  w.u8(code)
  w.sig(signature)
  write(w)
}

/**
 * 编组 Notify 的方法体（签名 susssasa{sv}i）。
 * hints 里**始终**带一条 urgency——非空数组的元素对齐没有歧义（空 a{sv} 的对齐
 * 在实现间存在分歧，故意避开）。
 * @param {{title?: string, message?: string, urgency?: string, iconPath?: string}} item
 * @returns {Buffer}
 */
export function marshalNotifyBody(item) {
  const w = new Writer()
  w.str(APP_NAME)                                   // s app_name
  w.u32(0)                                          // u replaces_id
  w.str(item.iconPath || (HAS_ICON ? ICON_PATH : '')) // s app_icon
  w.str(String(item.title || '').slice(0, 160))     // s summary
  w.str(String(item.message || '').slice(0, 400))   // s body
  w.align(4)
  w.u32(0)                                          // as actions（空数组，元素对齐 4 无歧义）
  // a{sv} hints：一条 urgency
  w.align(4)
  const hintsLenPos = w.length
  w.u32(0)                                          // 长度占位
  w.align(8)                                        // 元素（dict entry）对齐
  const hintsStart = w.length
  w.str('urgency')
  w.sig('y')
  w.u8(URGENCY_VALUE[item.urgency] === undefined ? URGENCY_VALUE.normal : URGENCY_VALUE[item.urgency])
  const hintsLen = w.length - hintsStart
  w.i32(DEFAULT_EXPIRE_TIMEOUT)                     // i expire_timeout
  const buf = w.buffer()
  buf.writeUInt32LE(hintsLen, hintsLenPos)
  return buf
}

/**
 * 编组一条完整的 Notify 方法调用消息。
 * @param {{title?: string, message?: string, urgency?: string, iconPath?: string, serial: number}} request
 * @returns {Buffer}
 */
export function marshalNotifyCall(request) {
  const body = marshalNotifyBody(request)
  const w = new Writer()
  w.u8(0x6c)               // 'l' 小端
  w.u8(METHOD_CALL)
  w.u8(0)                  // flags：期待回复，便于记录错误
  w.u8(PROTOCOL_VERSION)
  w.u32(body.length)       // body 长度
  w.u32(request.serial)    // serial
  w.align(4)
  const fieldsLenPos = w.length
  w.u32(0)                 // header fields 数组长度占位（固定头到 offset 12）
  w.align(8)
  const fieldsStart = w.length
  headerField(w, 1, 'o', (x) => x.str(OBJECT_PATH))
  headerField(w, 2, 's', (x) => x.str(INTERFACE))
  headerField(w, 3, 's', (x) => x.str(MEMBER))
  headerField(w, 6, 's', (x) => x.str(DESTINATION))
  headerField(w, 8, 'g', (x) => x.sig(NOTIFY_SIGNATURE))
  const fieldsLen = w.length - fieldsStart
  const head = w.buffer()
  head.writeUInt32LE(fieldsLen, fieldsLenPos)
  const pad = Buffer.alloc((8 - (head.length % 8)) % 8)
  return Buffer.concat([head, pad, body])
}

/**
 * 读取缓冲区里第一条消息需要的总长度（用于给流入的回复/错误分帧）。
 * @param {Buffer} buf
 * @returns {number} 固定头不足 16 字节时返回 0；否则返回该条消息的总字节数
 *   （调用方用 `buf.length >= 返回值` 判断是否收全）
 */
export function messageLength(buf) {
  if (buf.length < 16) return 0
  const bodyLen = buf.readUInt32LE(4)
  const fieldsLen = buf.readUInt32LE(12)
  const headerLen = 16 + fieldsLen
  const padded = headerLen + ((8 - (headerLen % 8)) % 8)
  return padded + bodyLen
}

/**
 * 解析 D-Bus 会话总线地址。
 * @param {string|undefined} address $DBUS_SESSION_BUS_ADDRESS
 * @param {number} uid 当前用户 uid（未给出时回退 /run/user/0/bus）
 * @returns {{path: string}}
 */
export function parseBusAddress(address, uid) {
  const fromEnv = typeof address === 'string' && address ? address : ''
  // 地址里键值以 `,` 或 `;` 分隔，取值到下一个分隔符为止
  const unixPath = /(?:^|;)unix:path=([^;,]+)/.exec(fromEnv)
  if (unixPath) return { path: unixPath[1] }
  const abstract = /(?:^|;)unix:abstract=([^;,]+)/.exec(fromEnv)
  if (abstract) return { path: '\0' + abstract[1] }  // Node 用前导 NUL 表示抽象套接字
  const id = Number.isInteger(uid) && uid >= 0 ? uid : 0
  return { path: `/run/user/${id}/bus` }
}

/**
 * SASL EXTERNAL 的首个认证行：uid 的十进制字符串按字节十六进制编码。
 * @param {number} uid
 * @returns {string} 形如 `AUTH EXTERNAL 31303030`
 */
export function authLine(uid) {
  const decimal = String(Number.isInteger(uid) && uid >= 0 ? uid : 0)
  return 'AUTH EXTERNAL ' + Buffer.from(decimal, 'ascii').toString('hex')
}

// ---------------------------------------------------------------------------
// 连接与会话管理
// ---------------------------------------------------------------------------

let session = null
let serial = 0
/** 未连上（或冷却中）时暂存的待发帧：放在模块级，跨会话重建不丢 */
const pending = []
/** 失败后的冷却截止时间：避免每条通知都新建连接、每次都在同一处失败并刷屏日志 */
let nextAttemptAt = 0
/** 最近一次打印过的错误：跨会话去重（同一个原因只报一次） */
let lastLoggedError = null

const HANDSHAKE_TIMEOUT_MS = 15000
const RETRY_COOLDOWN_MS = 30000

function nextSerial() {
  serial = serial >= 0xffffffff ? 1 : serial + 1
  return serial
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}

function logErrorOnce(reason) {
  if (lastLoggedError === reason) return
  lastLoggedError = reason
  console.error('[dsh-desktop-notify] D-Bus 连接失败:', reason)
}

/** 从错误消息体里尽力取出可读文本（错误消息体通常是一个 s） */
function errorText(body) {
  if (!body || body.length < 5) return ''
  const len = body.readUInt32LE(0)
  if (len <= 0 || 4 + len + 1 > body.length) return ''
  return body.subarray(4, 4 + len).toString('utf8')
}

function handleMessages(s) {
  for (;;) {
    const total = messageLength(s.buffer)
    if (total === 0 || s.buffer.length < total) return
    const msg = s.buffer.subarray(0, total)
    s.buffer = s.buffer.subarray(total)
    const type = msg.readUInt8(1)
    const msgSerial = msg.readUInt32LE(8)
    const bodyLen = msg.readUInt32LE(4)
    if (type === MESSAGE_ERROR) {
      const fieldsLen = msg.readUInt32LE(12)
      const bodyStart = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8)
      const text = bodyLen > 0 ? errorText(msg.subarray(bodyStart, bodyStart + bodyLen)) : ''
      console.error(`[dsh-desktop-notify] D-Bus 通知被拒绝（serial ${msgSerial}）: ${text || '未知错误'}`)
    }
    // method_return 与信号（NameAcquired 等）无需处理
  }
}

function handleAuth(s, chunk) {
  s.authBuffer = Buffer.concat([s.authBuffer, chunk])
  for (;;) {
    const idx = s.authBuffer.indexOf('\r\n')
    if (idx < 0) return
    const line = s.authBuffer.subarray(0, idx).toString('ascii')
    s.authBuffer = s.authBuffer.subarray(idx + 2)
    if (line.startsWith('OK')) {
      s.socket.write('BEGIN\r\n')
      s.ready = true
      s.socket.setTimeout(0)          // 握手完成：撤掉超时，别误杀常驻连接
      nextAttemptAt = 0               // 连上了：解除冷却
      lastLoggedError = null
      // 认证结束后剩余字节已经是消息流
      if (s.authBuffer.length > 0) {
        s.buffer = Buffer.concat([s.buffer, s.authBuffer])
        s.authBuffer = Buffer.alloc(0)
        handleMessages(s)
      }
      flushPending()
      return
    }
    if (line.startsWith('REJECTED')) {
      if (!s.triedAnonymous) {
        s.triedAnonymous = true
        s.socket.write('AUTH ANONYMOUS\r\n')
        continue
      }
      fail(s, 'SASL 认证被拒绝：' + line)
      return
    }
    if (line.startsWith('DATA')) {
      // 服务端要求补发初始响应
      s.socket.write(Buffer.from(Buffer.from(String(currentUid()), 'ascii').toString('hex') + '\r\n', 'ascii'))
      continue
    }
    if (line.startsWith('ERROR')) {
      fail(s, 'SASL 错误：' + line)
      return
    }
    // AGREE_UNIX_FD 等其它行忽略
  }
}

function fail(s, reason) {
  s.ready = false
  s.failed = true
  nextAttemptAt = Date.now() + RETRY_COOLDOWN_MS   // 冷却：短时间内不再新建连接
  try { s.socket.destroy() } catch (e) { /* ignore */ }
  logErrorOnce(reason)
}

function flushPending() {
  if (!session || !session.ready) return
  const items = pending.splice(0, pending.length)
  for (const frame of items) {
    try { session.socket.write(frame) } catch (e) { /* ignore */ }
  }
}

function createSession() {
  if (Date.now() < nextAttemptAt) return null   // 冷却中：帧继续排队，不建连
  const { path } = parseBusAddress(process.env.DBUS_SESSION_BUS_ADDRESS, currentUid())
  const s = {
    socket: null,
    ready: false,
    failed: false,
    triedAnonymous: false,
    buffer: Buffer.alloc(0),
    authBuffer: Buffer.alloc(0),
  }
  const socket = connect({ path })
  s.socket = socket
  // 半开/挂死的总线（接受连接但不回 SASL）必须有超时兜底，
  // 否则 ready 永远为 false、通知全部堆在 pending 里静默丢失。
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
    if (!s.ready) fail(s, `连接或握手超时（${HANDSHAKE_TIMEOUT_MS / 1000}s 内未完成认证）: ${path}`)
  })
  socket.on('connect', () => {
    socket.write(Buffer.from([0]))  // 认证前的 NUL 字节
    socket.write(authLine(currentUid()) + '\r\n')
  })
  socket.on('data', (chunk) => {
    if (s.ready) {
      s.buffer = Buffer.concat([s.buffer, chunk])
      handleMessages(s)
    } else {
      handleAuth(s, chunk)
    }
  })
  socket.on('error', (err) => {
    s.ready = false
    s.failed = true
    nextAttemptAt = Date.now() + RETRY_COOLDOWN_MS
    logErrorOnce((err && err.message) || String(err))   // Node 的 message 里已含地址
  })
  socket.on('close', () => {
    s.ready = false
    if (session === s) session = null  // 下次发送时重建
  })
  return s
}

/**
 * 发送一条桌面通知（异步 fire-and-forget；失败只记录，不抛给调用方）。
 * @param {{title?: string, message?: string, urgency?: string}} item
 */
export function sendToast(item) {
  const frame = marshalNotifyCall({
    title: item && item.title,
    message: item && item.message,
    urgency: item && item.urgency,
    serial: nextSerial(),
  })
  if (!session || session.failed) {
    const next = createSession()
    if (next) session = next
  }
  const s = session
  if (s && s.ready) {
    try {
      s.socket.write(frame)
    } catch (e) {
      logErrorOnce('写入失败: ' + (e && e.message))
      session = null
      nextAttemptAt = Date.now() + RETRY_COOLDOWN_MS
      if (pending.length >= MAX_PENDING) pending.shift()
      pending.push(frame)
    }
    return
  }
  if (pending.length >= MAX_PENDING) pending.shift()
  pending.push(frame)
}

/** 主动断开（插件卸载时调用）。 */
export function closeToastConnection() {
  pending.length = 0
  if (!session) return
  try { session.socket.destroy() } catch (e) { /* ignore */ }
  session = null
}
