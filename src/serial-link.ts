// 串口链路层 —— 握手、像素流、去重、重连（纯逻辑 + 注入式打开，便于单测）
//
// 真硬件：AI Status Lights（CH32V003 + 7×WS2812B + 无源蜂鸣器），协议见 led-protocol.ts。
// 这一层只干五件事：
//   1. **握手**：打开后先发 VERIFY，收到 `AI Status Lights OK\r\n` 才算连上 ——
//      这台机器上还插着手机/下载器之类的 COM 口，不能"打开就算成功"；
//   2. **渲染**：把当前语义画面按时刻渲染成 7 颗灯的像素（led-render.ts）；
//   3. **去重**：像素没变就不写（稳态 0 字节/秒；动画时才每帧 26 字节）；
//   4. **心跳**：像素没变也每 5s 重发一次，防止丢帧后灯卡在旧画面上；
//   5. **重连**：端口被拔/被占用/不是本板子时按退避重试（1s→2s→5s→10s→30s）。
//
// 打开/枚举都是注入的（options.open / options.list），单测用假句柄穷举：
// 写失败、半包回包、握手超时、设备中途掉线、端口从 auto 变成 COM5……

import {
  BAUD_RATE, createReplyScanner, encodeBuzzer, encodeLeds, encodeVerify,
  pixelsEqual, type Beep, type Pixels, type ReplyScannerStats,
} from './led-protocol.js'
import { renderPixels } from './led-render.js'
import { OFF_SCENE, type LedScene } from './led-scene.js'

/** 重连退避档位（毫秒）。 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10000, 30000]
/** 心跳周期：像素没变也重发一次。 */
export const HEARTBEAT_MS = 5000
/** 握手超时：打开后这么久没等到验证回包就判"这不是本板子"。 */
export const VERIFY_TIMEOUT_MS = 1500

/**
 * 链路层看到的"句柄"与"端口"是**结构性**类型，不是 serial-port.ts 里的实现类：
 * 依赖倒置（链路逻辑与硬件解耦，单测传假句柄）+ 编译分层（核心层不能被平台层拖进来）。
 */
export interface LinkHandle {
  write(bytes: Buffer): number
  read(max?: number): Buffer
  close(): void
}
export interface LinkPortInfo {
  readonly path: string
  readonly label: string
}

/** 链路状态。`ready` 只代表"握手通过"，不代表画面在变。 */
export type LinkState = 'disabled' | 'idle' | 'opening' | 'verifying' | 'ready' | 'error'

/** 没连上/握手失败的原因（给设置页说人话用）。 */
export type LinkErrorCode = '' | 'no-device' | 'open-failed' | 'verify-timeout' | 'write-failed' | 'read-failed'

export interface LinkStatus {
  readonly state: LinkState
  readonly port: string
  readonly baud: number
  readonly lastWriteAt: number
  readonly framesSent: number
  readonly bytesSent: number
  readonly lastError: string
  readonly errorCode: LinkErrorCode
  readonly retryInMs: number
  /** 握手是否通过（= 板子确认过"我是 AI Status Lights"）。 */
  readonly verified: boolean
  /** 回包扫描器统计（诊断用）。 */
  readonly reply: ReplyScannerStats
  /** 当前画面的人类可读描述。 */
  readonly scene: string
  /** 最近一帧像素（诊断/UI 预览用）。 */
  readonly pixels: Pixels
}

export interface SerialLinkOptions {
  /** 端口：'' 或 'auto' = 自动挑（见 serial-port.pickAutoPort）。 */
  readonly port: string
  readonly baud?: number
  /** 真正打开串口（注入点：单测传假实现）。 */
  readonly open: (port: string, baud: number) => Promise<LinkHandle>
  /** 枚举可用端口（自动挑端口用）。 */
  readonly list: () => Promise<LinkPortInfo[]>
  readonly now?: () => number
  readonly log?: (line: string) => void
  readonly heartbeatMs?: number
  readonly backoffMs?: readonly number[]
  readonly verifyTimeoutMs?: number
}

export interface SerialLink {
  configure(port: string, baud?: number): void
  /** 推入当前语义画面（链路会在每次 tick 时按时刻渲染）。 */
  applyScene(scene: LedScene): void
  /** 由宿主定时器驱动：连接管理 + 握手 + 渲染 + 收发。 */
  tick(): void
  /** 立刻响一声（不经过判定；诊断/联调用）。 */
  beep(beep: Beep): boolean
  /** 原样写一帧（已经编码好的；对外 API 的 raw 出口用）。 */
  rawFrame(frame: Buffer): boolean
  /** 手动重发验证帧。 */
  verify(): boolean
  status(): LinkStatus
  close(): void
}

export function createSerialLink(options: SerialLinkOptions): SerialLink {
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => {})
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const backoff = options.backoffMs ?? RECONNECT_BACKOFF_MS
  const verifyTimeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS

  let port = String(options.port ?? '').trim()
  let baud = Math.max(1200, Math.trunc(options.baud ?? BAUD_RATE) || BAUD_RATE)
  let handle: LinkHandle | null = null
  let state: LinkState = 'idle'
  let openedFor = ''
  let attempt = 0
  let nextRetryAt = 0
  let openedAt = 0
  let verified = false
  let lastWriteAt = 0
  let lastError = ''
  let lastErrorCode: LinkErrorCode = ''
  let framesSent = 0
  let bytesSent = 0
  let scene: LedScene = OFF_SCENE
  let lastPixels: Pixels = []
  let lastSentAt = 0
  let sentPixels: Pixels = []
  const scanner = createReplyScanner()

  const api: SerialLink = {
    configure(nextPort, nextBaud) {
      const p = String(nextPort ?? '').trim()
      const b = Math.max(1200, Math.trunc(nextBaud ?? baud) || BAUD_RATE)
      if (p === port && b === baud) return
      log(`[led] 串口配置变化：${port || 'auto'}@${baud} → ${p || 'auto'}@${b}`)
      port = p
      baud = b
      closeHandle('配置变化')
      attempt = 0
      nextRetryAt = 0
      state = 'idle'
    },
    applyScene(next) {
      scene = next
    },
    tick() {
      const t = now()
      if (handle === null) {
        if (t >= nextRetryAt) void tryOpen(t)
        return
      }
      // 1) 握手阶段：只等回包
      if (!verified) {
        drainReplies()
        if (verified) return
        if (t - openedAt >= verifyTimeoutMs) {
          fail(`串口 ${openedFor} 没有回应验证帧（可能不是 AI Status Lights）`, 'verify-timeout')
        }
        return
      }
      // 2) 已连上：读回包（板子目前只回验证串，读走避免缓冲堆满）
      drainReplies()
      // 3) 渲染 + 去重 + 心跳
      const pixels = renderPixels(scene, t)
      lastPixels = pixels
      const changed = !pixelsEqual(pixels, sentPixels)
      const due = t - lastSentAt >= heartbeatMs
      if (!changed && !due) return
      if (writeAll(encodeLeds(pixels))) {
        sentPixels = pixels
        lastSentAt = t
      }
    },
    beep(beep) {
      if (handle === null || !verified) return false
      return writeAll(encodeBuzzer(beep))
    },
    rawFrame(frame) {
      if (handle === null || !verified) return false
      return writeAll(frame)
    },
    verify() {
      if (handle === null) return false
      return writeAll(encodeVerify())
    },
    status() {
      const t = now()
      return {
        state,
        port: port === '' || port === 'auto' ? (openedFor || 'auto') : port,
        baud,
        lastWriteAt,
        framesSent,
        bytesSent,
        lastError,
        errorCode: lastErrorCode,
        retryInMs: handle === null && nextRetryAt > t ? nextRetryAt - t : 0,
        verified,
        reply: scanner.stats,
        scene: `${scene.state}${scene.flags ? '+' + scene.flags : ''} bright=${scene.brightness}`,
        pixels: lastPixels,
      }
    },
    close() {
      closeHandle('插件卸载')
      state = 'disabled'
    },
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  function closeHandle(why: string): void {
    if (handle === null) return
    try { handle.close() } catch (e) { /* ignore */ }
    handle = null
    openedFor = ''
    verified = false
    sentPixels = []
    log(`[led] 串口已关闭（${why}）`)
  }

  function fail(message: string, code: LinkErrorCode = 'open-failed'): void {
    lastError = message
    lastErrorCode = code
    state = 'error'
    closeHandle(message)
    const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 30000
    attempt += 1
    nextRetryAt = now() + wait
    log(`[led] 串口故障（${code || '-'}）：${message}；${wait}ms 后重试（第 ${attempt} 次）`)
  }

  function writeAll(frame: Buffer): boolean {
    if (handle === null) return false
    try {
      const written = handle.write(frame)
      if (written !== frame.length) {
        fail(`写入不完整（${written}/${frame.length} 字节）`, 'write-failed')
        return false
      }
      framesSent += 1
      bytesSent += written
      lastWriteAt = now()
      return true
    } catch (e) {
      fail((e as Error).message, 'write-failed')
      return false
    }
  }

  function drainReplies(): void {
    if (handle === null) return
    try {
      const chunk = handle.read()
      if (chunk.length === 0) return
      const found = scanner.push(chunk)
      if (found > 0 && !verified) {
        verified = true
        state = 'ready'
        attempt = 0
        lastError = ''
        lastErrorCode = ''
        sentPixels = []
        log(`[led] 握手成功：${openedFor} 是 AI Status Lights`)
      }
    } catch (e) {
      fail(`读取串口失败：${(e as Error).message}`, 'read-failed')
    }
  }

  async function tryOpen(t: number): Promise<void> {
    state = 'opening'
    try {
      let target = port
      if (target === '' || target === 'auto') {
        const ports = await options.list()
        target = pickAutoPort(ports)
        if (target === '') {
          lastError = '没有找到任何串口设备'
          lastErrorCode = 'no-device'
          state = 'error'
          nextRetryAt = t + 10000
          attempt += 1
          return
        }
        log(`[led] 自动选择串口：${target}（候选 ${ports.map((p) => p.path).join(', ') || '无'}）`)
      }
      const h = await options.open(target, baud)
      handle = h
      openedFor = target
      openedAt = now()
      verified = false
      scanner.reset()
      state = 'verifying'
      // 立刻发验证帧：板子回 ASCII，回包到了才算连上
      writeAll(encodeVerify())
    } catch (e) {
      fail((e as Error).message, 'open-failed')
    }
  }

  return api
}

/**
 * 自动挑端口：优先 CH340（VID/名称里带 CH34 的往往是这类小板子），
 * 其次 COM 号大的（USB 转串口通常是后插的、号更大），最后任意可用口。
 * 真正的"是不是本板子"由握手回答，所以这里只需要一个合理的起点。
 */
export function pickAutoPort(ports: readonly LinkPortInfo[]): string {
  if (ports.length === 0) return ''
  const ch340 = ports.find((p) => /CH34|ch340|usb.?serial/i.test(`${p.path} ${p.label}`))
  if (ch340) return ch340.path
  const numbered = ports
    .map((p) => ({ p, n: Number((/^COM(\d+)/i.exec(p.path) ?? [])[1] ?? 0) }))
    .sort((a, b) => b.n - a.n)
  const first = numbered[0]
  return first ? first.p.path : ports[0]!.path
}

/** 端口名是否看起来像一个合法串口（防止把 'auto' 之类当端口去打开）。 */
export function isValidPortName(path: string): boolean {
  const p = String(path ?? '').trim()
  if (p === '' || p.toLowerCase() === 'auto') return false
  return /^(COM\d+|\/dev\/[A-Za-z0-9._-]+)$/i.test(p)
}
