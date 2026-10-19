// 串口 worker —— **所有 koffi 同步原生调用都只活在这个线程里**。
//
// 为什么必须有它：Win32 串口同步 API 在"设备被拔掉"时可能永久阻塞
// （WriteFile 写超时为 0 永不返回、CreateFileW 卡在驱动枚举里）。
// 这些调用如果跑在 DSH 主线程，一次拔线就把整个事件循环冻死 ——
// 页面、定时器、日志全停，Ctrl+C 都进不去，只能杀终端。
// 关进 worker 之后：它卡死只死它自己，主线程用 ping/pong 看门狗发现后
// terminate() 掉它、换一个新的，DSH 全程不卡。
//
// 协议（parentPort）：
//   入: {t:'open', path, baud, dtr?, rts?} | {t:'write', data:ArrayBuffer}
//     | {t:'writeSync', data:ArrayBuffer} | {t:'close'} | {t:'ping', seq}
//   出: {t:'opened'} | {t:'openError', message}
//     | {t:'written', n, total} | {t:'writeError', message}
//     | {t:'data', data:ArrayBuffer} | {t:'closed'} | {t:'pong', seq}
//
// `writeSync` 的结果不走消息回传（主线程此时被 Atomics.wait 挡着，收不到消息）：
// 写完直接写进 workerData.sync（SharedArrayBuffer）+ Atomics.notify 唤醒主线程。

import { parentPort, workerData } from 'node:worker_threads'
import koffi from 'koffi'

import { isVerifyFrame, pumpIntervalMs, replyWindowFor } from './serial-pump.js'

const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const OPEN_EXISTING = 3
const MAXDWORD = 0xffffffff
const PURGE_TXABORT = 0x0001
const PURGE_RXABORT = 0x0002
const PURGE_TXCLEAR = 0x0004
const PURGE_RXCLEAR = 0x0008
const DCB_SIZE = 28
const TIMEOUTS_SIZE = 20

const kernel32 = koffi.load('kernel32.dll')
const CreateFileW = kernel32.func('CreateFileW', 'void*', ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*'])
const GetCommState = kernel32.func('GetCommState', 'int32', ['void*', 'void*'])
const SetCommState = kernel32.func('SetCommState', 'int32', ['void*', 'void*'])
const SetCommTimeouts = kernel32.func('SetCommTimeouts', 'int32', ['void*', 'void*'])
const PurgeComm = kernel32.func('PurgeComm', 'int32', ['void*', 'uint32'])
const ReadFile = kernel32.func('ReadFile', 'int32', ['void*', 'void*', 'uint32', 'void*', 'void*'])
const WriteFile = kernel32.func('WriteFile', 'int32', ['void*', 'void*', 'uint32', 'void*', 'void*'])
const CloseHandle = kernel32.func('CloseHandle', 'int32', ['void*'])

/** 同步写的回执区：[0] = 结果（>0 已接受字节数 / -1 失败 / 0 还没完成）。 */
const syncBuf = (workerData as any)?.sync
  ? new Int32Array((workerData as any).sync as SharedArrayBuffer)
  : null

// ── 复用的原生调用缓冲 ─────────────────────────────────────────────────────
// 这些是"每轮读取/每帧写入"都会用到、但内容不需要保留的临时内存。
// 过去每轮 new 一次：2ms 泵一小时 ~180 万轮 × 2 块（其中 256B 还要清零）→
// 数百万临时 Buffer 与每秒数百 MB 的零填充。预分配后空转轮次**零分配**。
const READ_CHUNK_BYTES = 256
const readBuf = Buffer.allocUnsafe(READ_CHUNK_BYTES)
const readDone = Buffer.allocUnsafe(4)
const writeDone = Buffer.allocUnsafe(4)
const EMPTY = Buffer.alloc(0)

/**
 * 枚举本机串口（注册表 HARDWARE\DEVICEMAP\SERIALCOMM）。
 *
 * ⚠️ 必须留在 worker 里：设备**正在被拔掉**的那一瞬间，注册表/设备栈的查询会卡住，
 * 主线程上做这件事就是"快速插拔必现卡死"的直接原因（慢速插拔时设备栈稳定，看不出来）。
 */
function listPorts(): Array<{ path: string; label: string }> {
  const out: Array<{ path: string; label: string }> = []
  try {
    const advapi32 = koffi.load('advapi32.dll')
    const RegOpenKeyExW = advapi32.func('RegOpenKeyExW', 'int32', ['void*', 'str16', 'uint32', 'uint32', 'void**'])
    const RegEnumValueW = advapi32.func('RegEnumValueW', 'int32',
      ['void*', 'uint32', 'void*', 'void*', 'void*', 'void*', 'void*', 'void*'])
    const RegCloseKey = advapi32.func('RegCloseKey', 'int32', ['void*'])
    const voidPtr = koffi.pointer(koffi.types.void)
    const HKEY_LOCAL_MACHINE = 0x80000002n
    const KEY_READ = 0x20019
    const outPtr = koffi.alloc(voidPtr, 1)
    const hr = RegOpenKeyExW(HKEY_LOCAL_MACHINE, 'HARDWARE\\DEVICEMAP\\SERIALCOMM', 0, KEY_READ, outPtr)
    if (hr !== 0) return out
    const key = koffi.decode(outPtr, voidPtr)
    try {
      // 枚举缓冲/长度指针提到循环外复用：RegEnumValueW 每轮只读写这几块，
      // 64 个值过去要分配 64×4 块（这里不是热路径，但没有理由继续每轮分配）。
      const nameBuf = Buffer.alloc(512)
      const dataBuf = Buffer.alloc(512)
      const nameLen = koffi.alloc('uint32', 1)
      const typeOut = koffi.alloc('uint32', 1)
      const dataLen = koffi.alloc('uint32', 1)
      for (let i = 0; i < 64; i += 1) {
        koffi.encode(nameLen, 'uint32', 256)   // 每个值都要重填 in/out 长度
        koffi.encode(dataLen, 'uint32', 256)
        const rc = RegEnumValueW(key, i, nameBuf, nameLen, null, typeOut, dataBuf, dataLen)
        if (rc !== 0) break
        const port = dataBuf.subarray(0, koffi.decode(dataLen, 'uint32')).toString('utf16le').replace(/\0+$/, '')
        const label = nameBuf.subarray(0, koffi.decode(nameLen, 'uint32') * 2).toString('utf16le').replace(/\0+$/, '')
        if (port) out.push({ path: port, label })
      }
    } finally {
      RegCloseKey(key)
    }
  } catch (e) { /* 没权限/键不存在：当作没有串口 */ }
  return out
}

function isInvalidHandle(h: unknown): boolean {
  return h === null || h === 0n || h === 0xffffffffn || h === 0xffffffffffffffffn
}

let handle: unknown = null
let closed = false

/** 与 serial-win32.ts 完全一致的打开流程（8N1、无流控、不置 DTR/RTS）。 */
function openPort(path: string, baud: number, dtr: boolean, rts: boolean): string | null {
  const devicePath = /^\\\\\.\\/.test(path) ? path : `\\\\.\\${path.replace(/^\\\\\.\\/, '')}`
  const h = CreateFileW(devicePath, GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, null)
  if (isInvalidHandle(h)) return `打不开串口 ${path}`
  const dcb = Buffer.alloc(DCB_SIZE)
  dcb.writeUInt32LE(DCB_SIZE, 0)
  if (GetCommState(h, dcb) === 0) { CloseHandle(h); return `串口 ${path} 配置读取失败` }
  dcb.writeUInt32LE(baud >>> 0, 4)
  let flags = 1
  if (dtr) flags |= 1 << 4
  if (rts) flags |= 1 << 12
  dcb.writeUInt32LE(flags >>> 0, 8)
  dcb.writeUInt16LE(0, 12); dcb.writeUInt16LE(0, 14); dcb.writeUInt16LE(0, 16)
  dcb.writeUInt8(8, 18); dcb.writeUInt8(0, 19); dcb.writeUInt8(1, 20)
  dcb.writeUInt8(0, 21); dcb.writeUInt8(0, 22); dcb.writeUInt8(0, 23); dcb.writeUInt8(0, 24); dcb.writeUInt8(0, 25)
  dcb.writeUInt16LE(0, 26)
  if (SetCommState(h, dcb) === 0) { CloseHandle(h); return `串口 ${path} 不支持该波特率` }
  const timeouts = Buffer.alloc(TIMEOUTS_SIZE)
  timeouts.writeUInt32LE(MAXDWORD, 0)   // ReadIntervalTimeout → ReadFile 立即返回
  timeouts.writeUInt32LE(0, 4)
  timeouts.writeUInt32LE(0, 8)
  // 写超时 200ms：拔线时正在写的 WriteFile 最多卡 200ms 就返回失败（这个 worker 即使卡住也只死自己）
  timeouts.writeUInt32LE(0, 12)
  timeouts.writeUInt32LE(200, 16)
  if (SetCommTimeouts(h, timeouts) === 0) { CloseHandle(h); return `串口 ${path} 初始化失败` }
  PurgeComm(h, PURGE_TXCLEAR | PURGE_RXCLEAR)
  handle = h
  closed = false
  readFailed = false
  // 刚打开：固件可能已经在回包；即使没有，链路也会马上发验证帧（那会再开一次窗口）
  openReplyWindow()
  // ⚠️ **必须在这里真正启动泵**：openReplyWindow() 只在"已有定时器"时重排，
  // 首次打开时 pumpTimer 还是 null —— 少了这一行，worker 永远不会 ReadFile，
  // 握手回包永远收不到（真机上表现为"插了灯也不亮/一直异常"）。
  schedulePump()
  return null
}

// ── 读取泵（自适应节奏） ──────────────────────────────────────────────────
// 只"可能在等回包"时（打开端口后 / 写出一帧验证帧后）用 2ms，其余时间 30ms。
// 判定与常量在 serial-pump.ts（纯函数、可单测），这里只负责定时与收包。

let replyWindowUntil = 0
/** 读失败只报一次：过去每 2ms 报一条 writeError，故障链路与消息队列都被灌爆。 */
let readFailed = false
let pumpTimer: ReturnType<typeof setTimeout> | null = null

/** 停泵（close / 读失败 / 释放句柄时调用）。 */
function stopPump(): void {
  if (pumpTimer !== null) {
    clearTimeout(pumpTimer)
    pumpTimer = null
  }
  replyWindowUntil = 0
}

/**
 * 排下一轮读取。
 *
 * 用 setTimeout 链而不是 setInterval：**读完再排**，所以 ReadFile 卡在驱动里时
 * 不会积压一串到点的回调；间隔也能每轮按"是否在等回包"重新算。
 * unref：worker 的存活由 parentPort 决定，泵不能把进程钉住（枚举 worker 里尤其明显）。
 */
function schedulePump(): void {
  if (pumpTimer !== null || handle === null || closed || readFailed) return
  const delay = pumpIntervalMs(performance.now(), replyWindowUntil)
  const timer = setTimeout(() => {
    pumpTimer = null
    readOnce()
    if (handle !== null && !closed && !readFailed) schedulePump()
  }, delay)
  if (typeof timer.unref === 'function') timer.unref()
  pumpTimer = timer
}

/** 进入 2ms 快轮询窗口；若当前排的是 30ms 慢轮询就提前唤醒（握手别多等一个周期）。 */
function openReplyWindow(): void {
  replyWindowUntil = replyWindowFor(performance.now())
  if (pumpTimer !== null) {
    clearTimeout(pumpTimer)
    pumpTimer = null
    schedulePump()
  }
}

/** 写完一帧验证命令后开回包窗口（只在整帧写成功之后调用：失败时没有回包可等）。 */
function noteVerifyWrite(bytes: Buffer): void {
  if (isVerifyFrame(bytes)) openReplyWindow()
}

/**
 * 读一次。没数据时**零分配**（复用 readBuf/readDone）。
 * 读失败视为设备已不可用：停泵 + 只报一次故障，交给主线程的重连路径。
 */
function readOnce(): void {
  if (handle === null || closed) return
  try {
    const ok = ReadFile(handle, readBuf, READ_CHUNK_BYTES, readDone, null)
    if (ok === 0) {
      readFailed = true
      stopPump()
      try { parentPort?.postMessage({ t: 'writeError', seq: 0, message: '读串口失败（设备可能已拔出）' }) } catch (e) { /* ignore */ }
      return
    }
    const n = readDone.readUInt32LE(0)
    if (n === 0) return
    // 要等的数据已经开始到了：剩下半行用 30ms 轮询也来得及（21 字节线上只要 ~1.8ms）
    replyWindowUntil = 0
    // subarray 只是视图；postMessage 在返回前完成结构化克隆，
    // 下一轮覆盖 readBuf 不会踩到这次已发出的数据。
    parentPort?.postMessage({ t: 'data', data: readBuf.subarray(0, n) })
  } catch (e) {
    readFailed = true
    stopPump()
    try { parentPort?.postMessage({ t: 'writeError', seq: 0, message: `读失败：${(e as Error).message}` }) } catch (e2) { /* ignore */ }
  }
}

/** 把主线程转移过来的 ArrayBuffer 包成 Buffer 视图（不复制：那块内存已经是本线程独占的）。 */
function frameView(data: unknown): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return EMPTY
}

parentPort?.on('message', (msg: any) => {
  try {
    if (msg.t === 'ping') {
      parentPort?.postMessage({ t: 'pong', seq: msg.seq })
      return
    }
    if (msg.t === 'list') {
      const ports = listPorts()
      parentPort?.postMessage({ t: 'ports', seq: msg.seq, ports })
      return
    }
    if (msg.t === 'open') {
      // 防御：正常是一轮一个 worker；万一同一 worker 再 open，先把旧句柄关掉，别泄漏
      if (handle !== null) {
        stopPump()
        try { CloseHandle(handle) } catch (e) { /* ignore */ }
        handle = null
      }
      const err = openPort(String(msg.path), Number(msg.baud), msg.dtr === true, msg.rts === true)
      parentPort?.postMessage(err === null ? { t: 'opened' } : { t: 'openError', message: err })
      return
    }
    if (msg.t === 'write') {
      if (handle === null || closed) { parentPort?.postMessage({ t: 'writeError', seq: msg.seq, message: '串口已关闭' }); return }
      // ArrayBuffer 是主线程转移过来的（独占内存）：包成视图即可，不复制。
      // 写完字节数落在复用的 writeDone 上，不再每帧 Buffer.alloc(4)。
      const bytes = frameView(msg.data)
      const ok = WriteFile(handle, bytes, bytes.length, writeDone, null)
      const n = ok === 0 ? 0 : writeDone.readUInt32LE(0)
      if (n === bytes.length) noteVerifyWrite(bytes)
      parentPort?.postMessage(n === bytes.length
        ? { t: 'written', seq: msg.seq, n, total: bytes.length }
        : { t: 'writeError', seq: msg.seq, message: `写入不完整（${n}/${bytes.length} 字节）` })
      return
    }
    if (msg.t === 'writeSync') {
      // 同步写：主线程在 Atomics.wait 上等结果（熄灯那一帧必须真的交出去）。
      let n = -1
      if (handle !== null && !closed && !readFailed) {
        try {
          const bytes = frameView(msg.data)
          const ok = WriteFile(handle, bytes, bytes.length, writeDone, null)
          const got = ok === 0 ? -1 : writeDone.readUInt32LE(0)
          n = got === bytes.length ? bytes.length : -1   // 短写按失败算（整帧语义）
          if (n > 0) noteVerifyWrite(bytes)
        } catch (e) {
          n = -1
        }
      }
      if (syncBuf !== null) {
        Atomics.store(syncBuf, 0, n)
        Atomics.notify(syncBuf, 0)
      }
      return
    }
    if (msg.t === 'close') {
      // 先停泵：句柄马上要被 CloseHandle，不能再有 ReadFile 打上去
      stopPump()
      if (!closed) {
        closed = true
        // ⚠️ 只清**接收**缓冲：PURGE_TXABORT/TXCLEAR 会把还在发的一帧（例如退出前的全黑帧）
        // 直接丢弃 → 灯留在最后那个颜色上。
        try { if (handle !== null) PurgeComm(handle, PURGE_RXABORT | PURGE_RXCLEAR) } catch (e) { /* ignore */ }
        try { if (handle !== null) CloseHandle(handle) } catch (e) { /* ignore */ }
        handle = null
      }
      parentPort?.postMessage({ t: 'closed' })
      return
    }
  } catch (e) {
    try { parentPort?.postMessage({ t: 'writeError', message: (e as Error).message }) } catch (e2) { /* ignore */ }
  }
})

// worker 就绪信号（主线程据此知道 koffi 在这个线程里加载成功）
parentPort?.postMessage({ t: 'ready', pid: process.pid, tag: workerData?.tag ?? '' })
