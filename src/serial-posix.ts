// 串口传输层 —— Linux / macOS 兜底实现
//
// 目标平台是 Windows（见 serial-win32.ts 的 koffi 直调），这一份是**尽力而为**的兜底：
//   · 用 `stty` 配置波特率（termios 的 ioctl 在 Linux 是 TCSETS2、在 macOS 是 IOSSIOSPEED，
//     结构体布局还随平台变；为了不引原生依赖，交给系统自带的 stty 最稳）；
//   · 打开设备一律带 O_NONBLOCK + O_NOCTTY：否则某些 USB 串口在 DTR 未拉高时会
//     **阻塞打开**，把宿主事件循环钉死；
//   · 读也是非阻塞的：没有数据返回空 Buffer（EAGAIN 与"读到 0 字节"同等处理）。
//
// 能力边界写在文档里：Windows 是一等公民，POSIX 只承诺"能点灯"。
//
// ⚠️ 非阻塞写的坑（这次补齐）：`O_NONBLOCK` 下 `writeSync` 可能**只写出去一部分**
// （内核发送缓冲快满），也可能直接抛 EAGAIN。上一版把它当"写成功/写失败"处理，
// 高频推帧时会**把一整帧截断**：固件收到半帧 → 校验错 → 整帧丢弃，表现是灯偶尔顿一下。
// 现在这里有一个小的有界发送队列：短写留下余量、EAGAIN 留到下一次 pump（每次
// read/write 都会 pump），动画帧满了就丢（`WRITE_DROPPED`），控制帧满了才报失败。

import { openSync, readSync, writeSync as fsWriteSync, closeSync, constants as fsConstants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

import { WRITE_DROPPED, type LinkWriteOptions } from './serial-link.js'

/** 打开并配置好的串口句柄。 */
export interface PosixSerialHandle {
  readonly path: string
  readonly baud: number
  write(bytes: Buffer, options?: LinkWriteOptions): number
  read(max?: number): Buffer
  close(): void
  /** 队列里还没写完的帧数（背压诊断用）。 */
  pending(): number
  /** 同步写（熄灯/退出路径专用）：返回真正写出的字节数。 */
  writeSync(bytes: Buffer, timeoutMs?: number): number
}

const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0o4000
const O_NOCTTY = fsConstants.O_NOCTTY ?? 0o400

/** 同步小睡（只在同步写/关机路径用：此刻不该再排事件循环）。 */
function sleepBrief(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch (e) { /* 极端环境没有 Atomics：直接不睡 */ }
}

/**
 * 打开串口（8N1、raw、无流控）。
 * @throws 打不开设备或 stty 配置失败时抛错（调用方据此走重连退避）
 */
export function openPosixSerial(path: string, baud: number): PosixSerialHandle {
  let fd = -1
  try {
    fd = openSync(path, fsConstants.O_RDWR | O_NOCTTY | O_NONBLOCK)
  } catch (e) {
    throw new Error(`打不开串口 ${path}：${(e as Error).message}`)
  }
  // stty 配置：raw（不做任何字符转换）+ 8N1 + 关流控。失败即视为不可用（宁可报错也别乱发字节）。
  const args = ['-F', path, 'raw', String(baud), 'cs8', '-parenb', '-cstopb', '-crtscts', '-ixon', '-ixoff']
  const stty = spawnSync('stty', args, { timeout: 3000 })
  if (stty.error || stty.status !== 0) {
    // macOS 的 stty 用 -f 而不是 -F
    const fallback = spawnSync('stty', ['-f', path, 'raw', String(baud), 'cs8', '-parenb', '-cstopb'], { timeout: 3000 })
    if (fallback.error || fallback.status !== 0) {
      try { closeSync(fd) } catch (e) { /* ignore */ }
      throw new Error(`无法配置 ${path}`)
    }
  }
  let closed = false
  /** 有界发送队列：队首可能是"上一帧没写完的余量"（短写）。 */
  const queue: Buffer[] = []
  /** 发送队列上限：4 帧 ≈ 104 字节。到上限说明设备/驱动已经卡住。 */
  const MAX_QUEUE = 4

  /** 尽力把队列推出去：短写留余量，EAGAIN（缓冲满）留到下一次。 */
  function pump(): void {
    while (queue.length > 0) {
      const head = queue[0] as Buffer
      let n = 0
      try {
        n = fsWriteSync(fd, head)
      } catch (e) {
        // EAGAIN/EWOULDBLOCK：发送缓冲满。不是错误，下次再来（不能在这里自旋：
        // 非阻塞 fd 上重试只会立刻再抛一次，把主线程钉死）。
        return
      }
      if (n <= 0) return
      if (n >= head.length) { queue.shift(); continue }
      queue[0] = head.subarray(n)   // 短写：把余量留在队首，别截断这一帧
      return
    }
  }

  return {
    path,
    baud,
    write(bytes: Buffer, options?: LinkWriteOptions): number {
      if (closed) return 0
      if (queue.length >= MAX_QUEUE) {
        // 队列满：动画帧可丢（链路下一次用最新画面重发），控制帧不能丢 —— 当"写失败"
        // 处理，让链路走既有的重连路径，而不是无限堆积。
        return options?.coalesce === true ? WRITE_DROPPED : 0
      }
      try { queue.push(Buffer.from(bytes)) } catch (e) { return 0 }
      pump()
      // 入队即返回整帧长度（与 win32 句柄的语义一致）；真正的完成由下一次 pump 补上。
      return bytes.length
    },
    read(max = 256): Buffer {
      if (closed) return Buffer.alloc(0)
      pump()                        // 读之前先把上一帧没写完的余量推出去
      try {
        const buf = Buffer.alloc(max)
        const n = readSync(fd, buf, 0, max, null)
        return n > 0 ? buf.subarray(0, n) : Buffer.alloc(0)
      } catch (e) {
        return Buffer.alloc(0)   // EAGAIN：没有数据
      }
    },
    pending(): number { return queue.length },
    /**
     * **同步**写一帧（熄灯/退出路径专用）：非阻塞 fd 上短写/EAGAIN 都要重试，
     * 这里用有界睡眠（每次 1ms，最多 timeoutMs）把这一帧"推到底"。
     * 只保证"字节已被内核接受"，不等于 WS2812 已经刷新（协议没有逐帧回执）。
     */
    writeSync(bytes: Buffer, timeoutMs = 400): number {
      if (closed) return 0
      pump()                       // 先把队列里的旧帧推完，别把顺序打乱
      const deadline = Date.now() + Math.max(1, timeoutMs)
      let off = 0
      while (off < bytes.length) {
        try {
          off += fsWriteSync(fd, bytes.subarray(off))
        } catch (e) {
          // EAGAIN：缓冲满，等一会儿再试
        }
        if (off >= bytes.length) break
        if (Date.now() >= deadline) break
        sleepBrief(1)
      }
      return off
    },
    close(): void {
      if (closed) return
      closed = true
      try { pump() } catch (e) { /* 最后一次尽力 */ }
      try { closeSync(fd) } catch (e) { /* ignore */ }
    },
  }
}

/** 枚举常见串口设备节点（/dev/ttyUSB* /dev/ttyACM* /dev/ttyS* /dev/cu.usb*）。 */
export function listPosixSerialPorts(): Array<{ path: string; label: string }> {
  const out: Array<{ path: string; label: string }> = []
  let names: string[] = []
  try { names = readdirSync('/dev') } catch (e) { return out }
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /^ttyUSB\d+$/, label: 'USB 串口' },
    { re: /^ttyACM\d+$/, label: 'USB CDC/ACM' },
    { re: /^cu\.usb\w+$/, label: 'USB 串口 (macOS)' },
    { re: /^ttyAMA\d+$/, label: '板载串口' },
    { re: /^ttyS\d+$/, label: '板载串口' },
  ]
  for (const name of names.sort()) {
    for (const { re, label } of patterns) {
      if (re.test(name)) { out.push({ path: `/dev/${name}`, label }); break }
    }
  }
  return out
}
