// DSH 桌面通知 — D-Bus 会话总线客户端（纯 JS，无子进程、无第三方依赖）
//
// 通知发送与主题跟踪共用一条常驻连接：Linux 上既要发
// org.freedesktop.Notifications.Notify，又要读/订阅
// org.freedesktop.portal.Settings 的 color-scheme——两条独立连接纯属浪费。
//
// 链路：会话总线（$DBUS_SESSION_BUS_ADDRESS 或 /run/user/<uid>/bus）
//   → SASL EXTERNAL 握手（\0 + AUTH EXTERNAL <hex uid> → OK <guid> → BEGIN）
//   → **Hello**（总线强制：未 Hello 之前发别的消息会被断开/拒绝）
//   → 方法调用（编组 method_call，按 serial 与 method_return/error 配对）
//   → 信号订阅（AddMatch + 按 interface/member 路由）
//
// 编组/解码是平台无关的纯函数（可在任何平台上单测，tests/dbus.test.mjs）。
// 连接是惰性建立并常驻复用的：断开后下次发送自动重连，失败有冷却与错误去重。

import { connect } from 'node:net'

const METHOD_CALL = 1
const METHOD_RETURN = 2
const MESSAGE_ERROR = 3
const MESSAGE_SIGNAL = 4
const PROTOCOL_VERSION = 1

/** 未连上时最多缓存多少条待发消息（超出丢最旧）。 */
const MAX_PENDING = 32
/** 入站缓冲区上限：对端异常刷数据时不能无限增长。 */
const MAX_INBOUND = 1 << 20
/** 握手（连接 + SASL + Hello）总超时。 */
const HANDSHAKE_TIMEOUT_MS = 15000
/** 失败后的冷却：避免每条通知都新建连接、每次都在同一处失败并刷屏日志。 */
const RETRY_COOLDOWN_MS = 30000
/** 方法调用默认超时。 */
const DEFAULT_CALL_TIMEOUT_MS = 5000

// ---------------------------------------------------------------------------
// 编组（marshalling）— 纯函数，便于单测
// ---------------------------------------------------------------------------

export class Writer {
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
  /** uint32：先按 4 字节对齐（D-Bus 每个值都要对齐到自身边界，别指望调用方记得）。 */
  u32(v) {
    this.align(4)
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v >>> 0, 0)
    return this.raw(b)
  }
  /** int32：同上，先对齐。 */
  i32(v) {
    this.align(4)
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
 * 编组一条完整的 method_call 消息。
 * @param {{path: string, interface: string, member: string, destination?: string,
 *          signature?: string, body?: Buffer, serial: number}} m
 * @returns {Buffer}
 */
export function marshalMethodCall(m) {
  const body = m.body || Buffer.alloc(0)
  const w = new Writer()
  w.u8(0x6c)               // 'l' 小端
  w.u8(METHOD_CALL)
  w.u8(0)                  // flags：期待回复，便于记录错误
  w.u8(PROTOCOL_VERSION)
  w.u32(body.length)       // body 长度
  w.u32(m.serial)          // serial
  w.align(4)
  const fieldsLenPos = w.length
  w.u32(0)                 // header fields 数组长度占位（固定头到 offset 12）
  w.align(8)
  const fieldsStart = w.length
  headerField(w, 1, 'o', (x) => x.str(m.path))
  headerField(w, 2, 's', (x) => x.str(m.interface))
  headerField(w, 3, 's', (x) => x.str(m.member))
  if (m.destination) headerField(w, 6, 's', (x) => x.str(m.destination))
  const signature = m.signature || ''
  if (signature) headerField(w, 8, 'g', (x) => x.sig(signature))
  const fieldsLen = w.length - fieldsStart
  const head = w.buffer()
  head.writeUInt32LE(fieldsLen, fieldsLenPos)
  const pad = Buffer.alloc((8 - (head.length % 8)) % 8)
  return Buffer.concat([head, pad, body])
}

/**
 * 读取缓冲区里第一条消息需要的总长度（用于给流入的回复/错误/信号分帧）。
 * @param {Buffer} buf
 * @returns {number} 固定头不足 16 字节、或不是little-endian（本实现只支持
 *   `l`）时返回 0；否则返回该条消息的总字节数
 *   （调用方用 `buf.length >= 返回值` 判断是否收全）
 */
export function messageLength(buf) {
  if (buf.length < 16) return 0
  // 端序字节必须是小端 'l'：规范允许 'B'，但本实现全程小端，
  // 遇到大端对端要明确拒绝而不是把所有字段解错位。
  if (buf.readUInt8(0) !== 0x6c) return 0
  const bodyLen = buf.readUInt32LE(4)
  const fieldsLen = buf.readUInt32LE(12)
  const headerLen = 16 + fieldsLen
  const padded = headerLen + ((8 - (headerLen % 8)) % 8)
  return padded + bodyLen
}

/**
 * 解析 D-Bus 会话总线地址。
 * 支持 `unix:path=` / `unix:abstract=`（键值顺序任意，允许 `;` 分隔多段地址）；
 * 其它传输（tcp:/autolaunch: 等）与缺省情况回退到 XDG_RUNTIME_DIR 或
 * /run/user/<uid>/bus。
 * @param {string|undefined} address $DBUS_SESSION_BUS_ADDRESS
 * @param {number} uid 当前用户 uid
 * @param {string|undefined} [xdgRuntimeDir] $XDG_RUNTIME_DIR
 * @returns {{path: string}}
 */
export function parseBusAddress(address, uid, xdgRuntimeDir) {
  const fromEnv = typeof address === 'string' && address ? address : ''
  for (const element of fromEnv.split(';')) {
    if (!element.startsWith('unix:')) continue
    // 键值顺序不固定：逐个 key=value 找 path / abstract
    const params = element.slice('unix:'.length).split(',')
    let abstract = ''
    for (const param of params) {
      const eq = param.indexOf('=')
      if (eq < 0) continue
      const key = param.slice(0, eq)
      const value = param.slice(eq + 1)
      if (key === 'path' && value) return { path: value }
      if (key === 'abstract' && value) abstract = value
    }
    if (abstract) return { path: '\0' + abstract }  // Node 用前导 NUL 表示抽象套接字
  }
  const runtimeDir = typeof xdgRuntimeDir === 'string' && xdgRuntimeDir ? xdgRuntimeDir : ''
  if (runtimeDir) return { path: runtimeDir.replace(/[\\/]+$/, '') + '/bus' }
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

/**
 * 服务端要求补发初始响应（`DATA`）时要回的整行。
 * ⚠️ 必须带 `DATA ` 前缀：裸十六进制行不是合法命令，服务端只会回 `ERROR`，
 * 而调用方会把健康的总线误判为认证失败并进入 30s 冷却。
 * @param {number} uid
 * @returns {string} 形如 `DATA 31303030\r\n`
 */
export function dataLine(uid) {
  const decimal = String(Number.isInteger(uid) && uid >= 0 ? uid : 0)
  return 'DATA ' + Buffer.from(decimal, 'ascii').toString('hex') + '\r\n'
}

// ---------------------------------------------------------------------------
// 解码（解码器只覆盖本插件用到的类型：y b n q i u x t d s o g v a(){}）
// ---------------------------------------------------------------------------

/** 各类型的对齐字节数（D-Bus 规范；VARIANT 是 1，DICT_ENTRY 是 8）。 */
export function alignmentOf(signature) {
  switch (signature[0]) {
    case 'y': case 'g': case 'v': return 1
    case 'n': case 'q': return 2
    case 'b': case 'i': case 'u': case 'h': case 's': case 'o': case 'a': return 4
    case 'x': case 't': case 'd': case '(': case '{': return 8
    default: return 1
  }
}

/** 按签名逐字节读取 D-Bus 值。 */
export class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf
    this.offset = offset
  }
  align(n) {
    this.offset += (n - (this.offset % n)) % n
    return this
  }
  u8() { const v = this.buf.readUInt8(this.offset); this.offset += 1; return v }
  i16() { this.align(2); const v = this.buf.readInt16LE(this.offset); this.offset += 2; return v }
  u16() { this.align(2); const v = this.buf.readUInt16LE(this.offset); this.offset += 2; return v }
  i32() { this.align(4); const v = this.buf.readInt32LE(this.offset); this.offset += 4; return v }
  u32() { this.align(4); const v = this.buf.readUInt32LE(this.offset); this.offset += 4; return v }
  i64() { this.align(8); const v = this.buf.readBigInt64LE(this.offset); this.offset += 8; return v }
  u64() { this.align(8); const v = this.buf.readBigUInt64LE(this.offset); this.offset += 8; return v }
  double() { this.align(8); const v = this.buf.readDoubleLE(this.offset); this.offset += 8; return v }
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
  /** 解一个变体：返回其内层值（丢弃内层签名——本插件只关心值本身）。 */
  variant() {
    const inner = this.sig()
    return this.value(inner)
  }
  /** 按签名解一个值。 */
  value(signature) {
    const sig = signature
    const c = sig[0]
    switch (c) {
      case 'y': return this.u8()
      case 'b': return this.u32() !== 0
      case 'n': return this.i16()
      case 'q': return this.u16()
      case 'i': return this.i32()
      case 'u': return this.u32()
      case 'x': return this.i64()
      case 't': return this.u64()
      case 'd': return this.double()
      case 'h': return this.u32()          // unix fd：只取索引，不接收 fd
      case 's': case 'o': return this.str()
      case 'g': return this.sig()
      case 'v': return this.variant()
      case 'a': return this.array(sig.slice(1))
      case '(': return this.struct(sig)
      default: throw new Error('dbus: 不支持的签名 ' + JSON.stringify(sig))
    }
  }
  /**
   * 数组：对齐 4 + uint32 字节长度，**再按元素对齐补零**，然后才是元素数据
   * （规范：长度只数元素数据，不含长度与首元素之间的对齐填充——字典项对齐 8，
   * 漏掉这一步会让 a{sv} 之后的字段整体错位）。
   */
  array(elementSig) {
    this.align(4)
    const byteLen = this.u32()
    this.align(alignmentOf(elementSig))
    const end = this.offset + byteLen
    const out = []
    if (elementSig[0] === '{') {
      // 字典项签名形如 {sv}：键是**第一个完整类型**，其余全部是值类型
      // （注意：D-Bus 签名里没有逗号分隔符，不能按 ',' 切）
      const parts = splitSignature(elementSig.slice(1, -1))
      const keySig = parts[0]
      const valSig = parts.slice(1).join('')
      while (this.offset < end) {
        this.align(8)
        if (this.offset >= end) break
        const key = this.value(keySig)
        out.push([key, this.value(valSig)])
      }
    } else {
      while (this.offset < end) out.push(this.value(elementSig))
    }
    this.offset = end
    return out
  }
  /** 结构体：对齐 8，按字段顺序解。 */
  struct(sig) {
    this.align(8)
    const fields = splitSignature(sig.slice(1, -1))
    return fields.map((f) => this.value(f))
  }
}

/** 把一个签名串切成顶层类型列表（处理 a{…} 与 (…) 嵌套）。 */
export function splitSignature(sig) {
  const out = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < sig.length; i++) {
    const c = sig[i]
    if (c === 'a' && depth === 0) { cur += c; continue }
    if (c === '(' || c === '{') depth++
    cur += c
    if (c === ')' || c === '}') depth--
    if (depth === 0) { out.push(cur); cur = '' }
  }
  if (cur) out.push(cur)
  return out
}

/** header field 编号（D-Bus 规范）。 */
export const FIELD = {
  PATH: 1, INTERFACE: 2, MEMBER: 3, ERROR_NAME: 4,
  REPLY_SERIAL: 5, DESTINATION: 6, SENDER: 7, SIGNATURE: 8, UNIX_FDS: 9,
}

/**
 * 每个 header field 的**类型**（规范固定）：1=o 2=s 3=s 4=s 5=u 6=s 7=s 8=g 9=u。
 * ⚠️ 5（REPLY_SERIAL）与 9（UNIX_FDS）是 uint32，不能当字符串解——按字符串读会
 * 把长度字段当成串长、把后续字段整体读错位，于是**所有方法回复都配不上号**
 * （Hello 超时、portal 读取失败这类"整条链路静默失效"的根因）。
 */
const FIELD_TYPES = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g', 9: 'u' }

/**
 * 解析一条完整消息（头 + body）。
 * @param {Buffer} msg
 * @returns {{type: number, flags: number, serial: number, fields: Record<number, unknown>,
 *            signature: string, body: Buffer}}
 */
export function decodeMessage(msg) {
  const bodyLen = msg.readUInt32LE(4)
  const serial = msg.readUInt32LE(8)
  const fieldsLen = msg.readUInt32LE(12)
  const fields = {}
  let offset = 16
  const fieldsEnd = 16 + fieldsLen
  while (offset < fieldsEnd) {
    offset += (8 - (offset % 8)) % 8
    const code = msg.readUInt8(offset); offset += 1
    const r = new Reader(msg, offset)
    const sig = r.sig()
    offset = r.offset
    const value = new Reader(msg, offset)
    // 用字段编号对应的类型解码（不是变体自带的签名——header field 的类型由编号定死）
    const declared = FIELD_TYPES[code] || (sig === 'g' ? 'g' : 's')
    fields[code] = value.value(declared)
    offset = value.offset
  }
  const bodyStart = (() => { const h = 16 + fieldsLen; return h + ((8 - (h % 8)) % 8) })()
  return {
    type: msg.readUInt8(1),
    flags: msg.readUInt8(2),
    serial,
    fields,
    signature: fields[8] || '',
    body: msg.subarray(bodyStart, bodyStart + bodyLen),
  }
}

// ---------------------------------------------------------------------------
// 会话管理
// ---------------------------------------------------------------------------

let session = null
let serial = 0
/** 未连上（或冷却中）时暂存的待发帧：放在模块级，跨会话重建不丢。 */
const pending = []
/** 等待回复的调用：serial → {resolve, reject, timer, member}。 */
const calls = new Map()
/** 已超时、但帧可能还排在 pending 里的 serial（flush 时丢弃，避免"无人认领的错误"）。 */
const expiredCalls = new Set()
/** 信号订阅：{interface, member, path?, handler}。 */
const signalHandlers = new Set()
/** AddMatch 规则：rule → 引用计数（多条订阅共用一个规则时只发一次 AddMatch）。 */
const matchRules = new Map()
/** 失败后的冷却截止时间。 */
let nextAttemptAt = 0
/** 最近一次打印过的错误：跨会话去重（同一个原因只报一次）。 */
let lastLoggedError = null
/** Hello 完成前不发应用消息（总线强制：未注册就发别的消息会被断开）。 */
let helloPending = false
let uniqueName = ''
/** 建连尝试的世代号：旧 socket 的回调不能再改新会话的状态。 */
let generation = 0
/** 无等待者的错误上报钩子（fire-and-forget 调用被总线拒绝时用）。 */
let errorReporter = null
/** 连接就绪（Hello 完成）时的回调：主题跟踪等"需要总线才能读"的调用借此补一次。 */
const readyHooks = new Set()

/**
 * 注册"总线就绪"回调（每次 Hello 完成都会调用；返回取消函数）。
 * @param {() => void} cb
 * @returns {() => void}
 */
export function onReady(cb) {
  if (typeof cb !== 'function') return () => {}
  readyHooks.add(cb)
  return () => readyHooks.delete(cb)
}

/**
 * 注册"无人等待的错误"上报钩子（例如 Notify 被通知服务拒绝）。
 * @param {((error: Error) => void)|null} fn
 */
export function setErrorReporter(fn) {
  errorReporter = typeof fn === 'function' ? fn : null
}

function nextSerial() {
  serial = serial >= 0xffffffff ? 1 : serial + 1
  return serial
}

/** 记一个"已超时"的 serial（有上限：调用超时通常是批量发生的）。 */
function rememberExpired(serialOfCall) {
  if (expiredCalls.size >= 64) {
    const oldest = expiredCalls.values().next().value
    expiredCalls.delete(oldest)
  }
  expiredCalls.add(serialOfCall)
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}

function logErrorOnce(reason) {
  if (lastLoggedError === reason) return
  lastLoggedError = reason
  console.error('[dsh-desktop-notify] D-Bus:', reason)
}

/** 从错误消息体里尽力取出可读文本（错误消息体通常是一个 s）。 */
export function errorText(msg) {
  try {
    if (!msg.body || msg.body.length < 5) return ''
    const r = new Reader(msg.body)
    return r.str()
  } catch (e) { return '' }
}

/** 连接是否已就绪（Hello 完成）。 */
export function isReady() {
  return !!(session && session.ready)
}

/** 当前连接的唯一名（Hello 返回；未连接时为空串）。 */
export function busName() {
  return uniqueName
}

function rejectPending(reason) {
  for (const [key, entry] of calls) {
    clearTimeout(entry.timer)
    calls.delete(key)
    // 这些帧可能还排在 pending 里：记下来，等重连 flush 时丢弃，
    // 免得"注定无人认领的请求"换来一条误导性的错误日志
    rememberExpired(key)
    try { entry.reject(new Error(reason)) } catch (e) { /* ignore */ }
  }
}

function dispatchSignal(msg) {
  const iface = msg.fields[FIELD.INTERFACE]
  const member = msg.fields[FIELD.MEMBER]
  const path = msg.fields[FIELD.PATH]
  for (const sub of signalHandlers) {
    if (sub.interface !== iface || sub.member !== member) continue
    if (sub.path && sub.path !== path) continue
    try {
      const reader = new Reader(msg.body)
      const args = splitSignature(msg.signature).map((s) => reader.value(s))
      sub.handler(args, msg)
    } catch (e) {
      console.error('[dsh-desktop-notify] D-Bus 信号处理失败:', e && e.message)
    }
  }
}

function handleMessage(msg) {
  if (msg.type === METHOD_RETURN || msg.type === MESSAGE_ERROR) {
    const replySerial = msg.fields[FIELD.REPLY_SERIAL]
    const entry = calls.get(replySerial)
    if (entry) {
      calls.delete(replySerial)
      clearTimeout(entry.timer)
      if (msg.type === MESSAGE_ERROR) {
        const name = msg.fields[FIELD.ERROR_NAME] || 'error'
        const text = errorText(msg)
        entry.reject(new Error(`${name}${text ? ': ' + text : ''}`))
      } else {
        try {
          const reader = new Reader(msg.body)
          entry.resolve(splitSignature(msg.signature).map((s) => reader.value(s)))
        } catch (e) {
          entry.reject(e)
        }
      }
      return
    }
    // 没有等待者的错误（fire-and-forget 调用被拒）：交给上报钩子，别静默吞掉
    if (msg.type === MESSAGE_ERROR && errorReporter) {
      const name = msg.fields[FIELD.ERROR_NAME] || 'error'
      const text = errorText(msg)
      try { errorReporter(new Error(`${name}${text ? ': ' + text : ''}`)) } catch (e) { /* ignore */ }
    }
    return
  }
  if (msg.type === MESSAGE_SIGNAL) dispatchSignal(msg)
}

function handleInbound() {
  if (!session) return   // 连接已被主动关闭：在途的 data 事件不能再往下解析
  for (;;) {
    // 大端对端（或垃圾数据）：明确失败并冷却，而不是在这里静静卡住
    if (session.buffer.length >= 16 && session.buffer.readUInt8(0) !== 0x6c) {
      fail(session, `对端使用了非小端消息（0x${session.buffer.readUInt8(0).toString(16)}），本实现只支持小端`)
      return
    }
    const total = messageLength(session.buffer)
    if (total === 0 || session.buffer.length < total) return
    const raw = session.buffer.subarray(0, total)
    session.buffer = session.buffer.subarray(total)
    let msg
    try {
      msg = decodeMessage(raw)
    } catch (e) {
      logErrorOnce('消息解析失败: ' + (e && e.message))
      continue
    }
    try {
      handleMessage(msg)
    } catch (e) {
      console.error('[dsh-desktop-notify] D-Bus 消息处理失败:', e && e.message)
    }
  }
}

/**
 * 写一帧到 socket 并吞掉同步异常。
 * ⚠️ 认证/Hello 阶段的写入同样需要兜底：Node 一般通过异步 'error' 事件报告
 * "写入已销毁的 socket"，但同步抛出的情况一旦发生就是宿主进程的未捕获异常。
 * @returns {boolean} 是否写入成功
 */
function writeRaw(s, data) {
  try {
    s.socket.write(data)
    return true
  } catch (e) {
    logErrorOnce('写入失败: ' + (e && e.message))
    return false
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
      writeRaw(s, 'BEGIN\r\n')
      s.ready = true
      s.socket.setTimeout(0)          // 握手完成：撤掉超时，别误杀常驻连接
      nextAttemptAt = 0               // 连上了：解除冷却
      lastLoggedError = null
      // 认证结束后剩余字节已经是消息流
      if (s.authBuffer.length > 0) {
        s.buffer = Buffer.concat([s.buffer, s.authBuffer])
        s.authBuffer = Buffer.alloc(0)
      }
      beginHello(s)
      return
    }
    if (line.startsWith('REJECTED')) {
      if (!s.triedAnonymous) {
        s.triedAnonymous = true
        writeRaw(s, 'AUTH ANONYMOUS\r\n')
        continue
      }
      fail(s, 'SASL 认证被拒绝：' + line)
      return
    }
    if (line.startsWith('DATA')) {
      // 服务端要求补发初始响应：必须带 `DATA ` 前缀（见 dataLine 的说明）
      writeRaw(s, dataLine(currentUid()))
      continue
    }
    if (line.startsWith('ERROR')) {
      fail(s, 'SASL 错误：' + line)
      return
    }
    // AGREE_UNIX_FD 等其它行忽略
  }
}

/** BEGIN 之后必须先 Hello：总线在客户端注册前会拒绝（甚至断开）其它消息。 */
function beginHello(s) {
  helloPending = true
  const serialOfCall = nextSerial()
  const hello = marshalMethodCall({
    path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus',
    member: 'Hello',
    destination: 'org.freedesktop.DBus',
    serial: serialOfCall,
  })
  const entry = {
    serial: serialOfCall,
    timer: setTimeout(() => {
      calls.delete(serialOfCall)
      fail(s, `Hello 超时（${DEFAULT_CALL_TIMEOUT_MS}ms）`)
    }, DEFAULT_CALL_TIMEOUT_MS),
    resolve: (args) => {
      uniqueName = typeof args[0] === 'string' ? args[0] : ''
      helloPending = false
      onSessionReady(s)
    },
    reject: (err) => { fail(s, 'Hello 被拒绝: ' + (err && err.message)) },
  }
  calls.set(serialOfCall, entry)
  writeRaw(s, hello)
}

function onSessionReady(s) {
  if (session !== s) return
  // 重新声明已有订阅规则（重连后总线上的 match 规则不会保留），并**重建引用计数**：
  // 否则之后退订会按"没有计数"直接 RemoveMatch，把仍在用同一条规则的订阅一起摘掉。
  // ⚠️ 同一条规则只发一次 AddMatch：按订阅逐条发会在每次重连后往总线上叠一份，
  // 若守护进程不去重，信号会被投递 N 次 → 本地分发器把同一个 handler 跑 N 遍。
  matchRules.clear()
  for (const sub of signalHandlers) {
    const rule = ruleOf(sub)
    matchRules.set(rule, (matchRules.get(rule) || 0) + 1)
  }
  for (const rule of matchRules.keys()) applyMatchRule(rule)
  flushPending()
  // 总线刚可用：通知关心"要连上才能读"的调用方（例如 Linux 主题 portal 读取）
  for (const cb of readyHooks) {
    try { cb() } catch (e) { /* 回调自己炸不能影响总线 */ }
  }
}

function ruleOf(sub) {
  let rule = `type='signal',interface='${sub.interface}',member='${sub.member}'`
  if (sub.path) rule += `,path='${sub.path}'`
  return rule
}

function fail(s, reason) {
  // 幂等：Hello 的 reject 会再调一次 fail，否则日志原因被包装两层、冷却被重复计时
  if (s.failed) return
  s.ready = false
  s.failed = true
  helloPending = false
  nextAttemptAt = Date.now() + RETRY_COOLDOWN_MS   // 冷却：短时间内不再新建连接
  rejectPending('D-Bus 连接失败: ' + reason)
  try { s.socket.destroy() } catch (e) { /* ignore */ }
  logErrorOnce(reason)
}

function flushPending() {
  if (!isReady()) return
  const items = pending.splice(0, pending.length)
  for (const frame of items) {
    // 帧还排着队、等待它的调用却已超时：直接丢，别把注定无人认领的请求发出去
    // （否则它的错误回复会被当成"无人等待的错误"打进日志，纯噪声）。
    if (expiredCalls.size > 0 && expiredCalls.delete(frame.readUInt32LE(8))) continue
    try { session.socket.write(frame) } catch (e) { /* ignore */ }
  }
}

function createSession() {
  if (Date.now() < nextAttemptAt) return null   // 冷却中：消息继续排队，不建连
  const { path } = parseBusAddress(
    process.env.DBUS_SESSION_BUS_ADDRESS, currentUid(), process.env.XDG_RUNTIME_DIR,
  )
  const s = {
    socket: null,
    ready: false,
    failed: false,
    triedAnonymous: false,
    buffer: Buffer.alloc(0),
    authBuffer: Buffer.alloc(0),
    generation: ++generation,
  }
  const socket = connect({ path })
  s.socket = socket
  // 半开/挂死的总线（接受连接但不回 SASL）必须有超时兜底，
  // 否则 ready 永远为 false、消息全部堆在 pending 里静默丢失。
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
    if (s.generation !== generation) return   // 旧连接的回调：不碰当前会话
    if (!s.ready) fail(s, `连接或握手超时（${HANDSHAKE_TIMEOUT_MS / 1000}s 内未完成认证）: ${path}`)
  })
  socket.on('connect', () => {
    writeRaw(s, Buffer.from([0]))                       // 认证前的 NUL 字节
    writeRaw(s, authLine(currentUid()) + '\r\n')
  })
  socket.on('data', (chunk) => {
    if (s.generation !== generation) return   // 旧连接：直接丢弃
    if (s.ready) {
      s.buffer = Buffer.concat([s.buffer, chunk])
      if (s.buffer.length > MAX_INBOUND) {
        fail(s, `入站数据超过 ${MAX_INBOUND} 字节上限，疑似对端异常`)
        return
      }
      handleInbound()
    } else {
      handleAuth(s, chunk)
    }
  })
  socket.on('error', (err) => {
    // 旧连接的错误不能影响已经重建的新会话（否则会把新会话的 Hello 待发标志清掉）
    if (s.generation !== generation) return
    s.ready = false
    s.failed = true
    helloPending = false
    nextAttemptAt = Date.now() + RETRY_COOLDOWN_MS
    logErrorOnce((err && err.message) || String(err))   // Node 的 message 里已含地址
    if (path.startsWith('\0')) {
      // libuv 用 C 字符串长度定位 Unix 套接字，抽象命名空间地址（前导 NUL）在多数
      // Node 版本上连不通；会话总线通常也提供文件路径形式（/run/user/<uid>/bus）。
      logErrorOnce('总线地址是抽象命名空间（unix:abstract=…），Node 一般连不上；'
        + '请改用文件路径形式，例如 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus')
    }
  })
  socket.on('close', () => {
    if (s.generation !== generation) return   // 旧连接关闭：新会话的等待者与它无关
    s.ready = false
    helloPending = false
    if (session === s) {
      session = null  // 下次发送时重建
      uniqueName = ''
    }
    rejectPending('D-Bus 连接已关闭')
  })
  return s
}

/** 取（必要时建）当前会话；冷却中返回 null。 */
export function getSession() {
  if (session && session.ready) return session
  if (session && !session.failed && !session.ready) return session   // 握手中
  if (session && session.failed) session = null
  const next = createSession()
  if (next) session = next
  return session
}

/** 发一帧（不等回复）：未连上/未 Hello 时先排队。 */
export function send(frame) {
  const s = getSession()
  if (s && s.ready && !helloPending) {
    try {
      s.socket.write(frame)
      return true
    } catch (e) {
      logErrorOnce('写入失败: ' + (e && e.message))
      session = null
      nextAttemptAt = Date.now() + RETRY_COOLDOWN_MS
    }
  }
  if (pending.length >= MAX_PENDING) pending.shift()
  pending.push(frame)
  return false
}

/**
 * 调用一个方法并等回复。
 * @param {{path: string, interface: string, member: string, destination?: string,
 *          signature?: string, body?: Buffer, timeoutMs?: number}} m
 * @returns {Promise<unknown[]>} 回复体的顶层值数组
 */
export function call(m) {
  return new Promise((resolve, reject) => {
    const frame = marshalMethodCall({
      path: m.path,
      interface: m.interface,
      member: m.member,
      destination: m.destination,
      signature: m.signature,
      body: m.body,
      serial: nextSerial(),
    })
    const s = getSession()
    if (!s) {
      reject(new Error('D-Bus 连接不可用（冷却中）'))
      return
    }
    const serialOfCall = frame.readUInt32LE(8)
    const timeoutMs = m.timeoutMs || DEFAULT_CALL_TIMEOUT_MS
    const entry = {
      serial: serialOfCall,
      timer: setTimeout(() => {
        calls.delete(serialOfCall)
        rememberExpired(serialOfCall)
        reject(new Error(`D-Bus 调用超时（${timeoutMs}ms）: ${m.interface}.${m.member}`))
      }, timeoutMs),
      resolve,
      reject,
    }
    calls.set(serialOfCall, entry)
    if (!send(frame)) {
      // 排队中：Hello/重连完成后 flushPending 会把它发出去，超时仍由上面的定时器兜底
    }
  })
}

/**
 * 编组并发出一次方法调用（不等回复；未连上时排队）。
 * @param {{path: string, interface: string, member: string, destination?: string,
 *          signature?: string, body?: Buffer}} m
 * @returns {boolean} 是否已直接写入连接（false = 仍在排队）
 */
export function sendCall(m) {
  const frame = marshalMethodCall({
    path: m.path,
    interface: m.interface,
    member: m.member,
    destination: m.destination,
    signature: m.signature,
    body: m.body,
    serial: nextSerial(),
  })
  return send(frame)
}

/** 订阅信号：AddMatch + 本地路由（连接重建后自动重新 AddMatch）。 */
export function onSignal(filter, handler) {
  const sub = { interface: filter.interface, member: filter.member, path: filter.path, handler }
  signalHandlers.add(sub)
  const rule = ruleOf(sub)
  const prev = matchRules.get(rule) || 0
  matchRules.set(rule, prev + 1)
  // 同一条规则只在 0→1 时发一次 AddMatch：总线不保证去重，重复规则会让信号
  // 被投递多次 → 本地分发器把同一个 handler 跑 N 遍。
  if (prev === 0) applyMatchRule(rule)
  return () => {
    signalHandlers.delete(sub)
    const n = (matchRules.get(rule) || 1) - 1
    if (n <= 0) {
      matchRules.delete(rule)
      dropMatchRule(rule)
    } else {
      matchRules.set(rule, n)
    }
  }
}

function applyMatchRule(rule) {
  if (!isReady()) return
  call({
    path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus',
    member: 'AddMatch',
    destination: 'org.freedesktop.DBus',
    signature: 's',
    body: new Writer().str(rule).buffer(),
  }).catch((e) => { logErrorOnce('AddMatch 失败: ' + (e && e.message)) })
}

function dropMatchRule(rule) {
  if (!isReady()) return
  call({
    path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus',
    member: 'RemoveMatch',
    destination: 'org.freedesktop.DBus',
    signature: 's',
    body: new Writer().str(rule).buffer(),
  }).catch((e) => { /* 连接已断时无须处理 */ })
}

/** 主动断开（插件卸载时调用）。 */
export function closeSession() {
  pending.length = 0
  signalHandlers.clear()
  matchRules.clear()
  rejectPending('D-Bus 连接已关闭')
  const s = session
  session = null
  uniqueName = ''
  helloPending = false
  if (s) {
    // 先落 ready 再销毁：销毁后仍可能有一次 data 事件在路上，
    // 那时 handleInbound 读到的 session 已是 null，不能让它继续按"已就绪"解析。
    s.ready = false
    s.failed = true
    generation += 1   // 让这条旧连接的所有回调（data/close/error）直接失效
    try { s.socket.destroy() } catch (e) { /* ignore */ }
  }
}
