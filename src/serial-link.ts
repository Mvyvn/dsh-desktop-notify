// 串口链路层 —— 去重、心跳、重连、收包（纯逻辑 + 注入式打开，便于单测）
//
// 这一层只干四件事，全部与"插上的是什么硬件"无关：
//   1. **去重**：只有画面签名变了才写帧（稳态平均带宽 < 20 B/s 的关键）；
//   2. **心跳**：画面没变也每 5s 重发一次 SCENE —— 固件据此判定"主机还活着"，
//      丢一帧不会让灯一直卡在旧状态；
//   3. **重连**：端口被拔/被占用/波特率不对时，按退避重试（1s→2s→5s→10s→30s），
//      而不是疯狂重试把宿主日志刷爆；
//   4. **收包**：非阻塞读回 ACK/PONG/按键事件（按键可以当"我知道了"，见 led-judge）。
//
// 打开动作是注入进来的（options.open），所以单测能用假句柄穷举：
// 写失败、半包、CRC 错、设备中途掉线、端口从 auto 变成 COM5……
// 真实现见 serial-port.ts（Windows: koffi 直调 kernel32）。

import {
  encodeFrame, createFrameParser, scenePayload, frameTypeName,
  FRAME, REPLY, LED_WIRE_VERSION, type FrameParserStats, type SceneInput,
} from './led-protocol.js'
import type { LedScene } from './led-judge.js'

/**
 * 链路层看到的"句柄"与"端口"是**结构性**类型，不是 serial-port.ts 里的那个实现类。
 * 这样做的原因有两个：
 *   · 依赖倒置：链路逻辑（去重/心跳/重连）与"插的是什么硬件"完全解耦，单测传假句柄即可；
 *   · 编译分层：本模块属于**核心层**（tsconfig.json 严格档），不能被平台层的实现文件
 *     拖进来（平台层是 koffi/DOM 粘合，走 tsconfig.platform.json 的宽松档）。
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

/** 链路状态。 */
export type LinkState = 'disabled' | 'idle' | 'opening' | 'ready' | 'error'

/**
 * 故障的**机器可读**分类（给设置页那行状态文案用）。
 * 为什么要有它：`state === 'error'` 把两件完全不同的事混在一起 ——
 *   · 没插设备（`no-device`）：这不是故障，是"还没接线"，界面该说"未连接"；
 *   · 打不开/写不进（`open-failed` / `write-failed` / `read-failed`）：这才是真异常。
 * 靠 `lastError` 的文案去猜（字符串匹配）太脆，所以给一个明确码。
 */
export type LinkErrorCode = '' | 'no-device' | 'open-failed' | 'write-failed' | 'read-failed'

/** 重连退避档位（毫秒）。 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10000, 30000]
/** 心跳周期：画面没变也重发一次（固件端 3× 心跳没收到就进"失联"表现）。 */
export const HEARTBEAT_MS = 5000
/** 设备信息（HELLO_ACK 回报，给诊断端点与"固件版本不对"的提示用）。 */
export interface DeviceInfo {
  readonly wireVersion: number
  readonly leds: number
  readonly maxBrightness: number
  readonly caps: number
}

export interface LinkStatus {
  readonly state: LinkState
  readonly port: string
  readonly baud: number
  /** 最近一次写成功的时间（0 = 还没成功过）。 */
  readonly lastWriteAt: number
  readonly framesSent: number
  readonly bytesSent: number
  /** 最近一次错误文本（空串 = 无错误）。 */
  readonly lastError: string
  /** 故障分类（`''` = 无故障）。见 LinkErrorCode 的说明。 */
  readonly errorCode: LinkErrorCode
  /** 距离下次重连还有多少毫秒（0 = 不在等待）。 */
  readonly retryInMs: number
  readonly device: DeviceInfo | null
  readonly parser: FrameParserStats
  /** 当前期望画面的人类可读描述（诊断用）。 */
  readonly scene: string
}

export interface SerialLinkOptions {
  /** 端口：'' 或 'auto' = 自动挑（见 serial-port.pickAutoPort）。 */
  readonly port: string
  readonly baud: number
  /** 真正打开串口（注入点：单测传假实现）。 */
  readonly open: (port: string, baud: number) => Promise<LinkHandle>
  /** 枚举可用端口（自动挑端口用）。 */
  readonly list: () => Promise<LinkPortInfo[]>
  /** 时钟（单测可注入）。 */
  readonly now?: () => number
  readonly log?: (line: string) => void
  /** 收到设备事件（按键等）。 */
  readonly onEvent?: (event: { code: number; arg: number }) => void
  /** 可调参数（单测用）。 */
  readonly heartbeatMs?: number
  readonly backoffMs?: readonly number[]
}

export interface SerialLink {
  /** 配置变化（设置页改了端口/波特率）：不匹配就断开重连。 */
  configure(port: string, baud: number): void
  /** 推入期望画面（内部去重 + 心跳）。 */
  apply(scene: LedScene): void
  /** 由宿主定时器驱动：连接管理 + 心跳 + 收包。 */
  tick(): void
  /** 直发一帧（对外 API 用；返回是否真的写出去了）。 */
  sendFrame(type: number, payload: readonly number[]): boolean
  /** 当前状态快照。 */
  status(): LinkStatus
  /** 关闭（插件卸载）。 */
  close(): void
}

/**
 * 建链路。**不会自己开定时器**：tick() 由宿主按自己的节奏调（便于测试与热重载清理）。
 */
export function createSerialLink(options: SerialLinkOptions): SerialLink {
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => {})
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const backoff = options.backoffMs ?? RECONNECT_BACKOFF_MS

  let port = String(options.port ?? '').trim()
  let baud = Math.max(1200, Math.trunc(options.baud) || 115200)
  let handle: LinkHandle | null = null
  let state: LinkState = 'idle'
  let openedFor = ''                       // 当前句柄对应的端口（配置变了要重开）
  let attempt = 0
  let nextRetryAt = 0
  let lastWriteAt = 0
  let lastError = ''
  let lastErrorCode: LinkErrorCode = ''
  let framesSent = 0
  let bytesSent = 0
  let device: DeviceInfo | null = null
  let seq = 0
  let wanted: LedScene | null = null
  let sentSignature = ''
  let lastHeartbeatAt = 0

  const parser = createFrameParser()

  const api: SerialLink = {
    configure(nextPort, nextBaud) {
      const p = String(nextPort ?? '').trim()
      const b = Math.max(1200, Math.trunc(nextBaud) || 115200)
      if (p === port && b === baud) return
      log(`[led] 串口配置变化：${port || 'auto'}@${baud} → ${p || 'auto'}@${b}`)
      port = p
      baud = b
      closeHandle('配置变化')
      attempt = 0
      nextRetryAt = 0
      state = 'idle'
    },
    apply(scene) {
      wanted = scene
    },
    tick() {
      const t = now()
      // 1) 连接管理
      if (handle === null && t >= nextRetryAt) void tryOpen(t)
      if (handle === null) return
      // 2) 收包（非阻塞）：ACK/PONG/按键事件
      drainInput()
      // 3) 发送：画面变化立刻发；否则按心跳重发
      if (wanted === null) return
      const signature = sceneSignature(wanted)
      const changed = signature !== sentSignature
      const due = t - lastHeartbeatAt >= heartbeatMs
      if (!changed && !due) return
      if (sendScene(wanted, t)) {
        sentSignature = signature
        lastHeartbeatAt = t
      }
    },
    sendFrame(type, payload) {
      if (handle === null) return false
      try {
        const frame = encodeFrame(type, nextSeq(), payload)
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
        device,
        parser: parser.stats,
        scene: wanted === null ? '(未设置)' : sceneSignature(wanted),
      }
    },
    close() {
      closeHandle('插件卸载')
      state = 'disabled'
    },
  }

  const nextSeq = (): number => {
    seq = (seq + 1) & 0xff
    return seq
  }

  function closeHandle(why: string): void {
    if (handle === null) return
    try { handle.close() } catch (e) { /* ignore */ }
    handle = null
    openedFor = ''
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

  async function tryOpen(t: number): Promise<void> {
    state = 'opening'
    try {
      let target = port
      if (target === '' || target === 'auto') {
        const ports = await options.list()
        target = pickAutoPort(ports)
        if (target === '') {
          // 没插设备**不是故障**：给它单独的码，设置页据此说"未连接"而不是"异常"
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
      state = 'ready'
      attempt = 0
      lastError = ''
      lastErrorCode = ''
      sentSignature = ''
      lastHeartbeatAt = 0
      parser.reset()
      log(`[led] 串口已打开：${target}@${baud}`)
      // 握手：告诉固件线协议版本，顺带探能力（没回也不影响，SCENE 是自解释的）
      api.sendFrame(FRAME.HELLO, [LED_WIRE_VERSION, 0])
    } catch (e) {
      fail((e as Error).message || '打开串口失败')
    }
  }

  function sendScene(scene: LedScene, t: number): boolean {
    const input: SceneInput = {
      state: scene.state,
      flags: scene.flags,
      brightness: scene.brightness,
      progress: scene.progress,
    }
    const ok = api.sendFrame(FRAME.SCENE, scenePayload(input))
    if (ok) lastWriteAt = t
    return ok
  }

  function drainInput(): void {
    if (handle === null) return
    let chunk: Buffer
    try {
      chunk = handle.read(256)
    } catch (e) {
      fail(`读取串口失败：${(e as Error).message}`, 'read-failed')
      return
    }
    if (chunk.length === 0) return
    for (const frame of parser.push(chunk)) {
      switch (frame.type) {
        case REPLY.ACK:
          break
        case REPLY.NAK:
          log(`[led] 固件回 NAK seq=${frame.payload[0]} code=${frame.payload[1]}`)
          break
        case REPLY.HELLO_ACK: {
          device = {
            wireVersion: frame.payload[0] ?? 0,
            leds: frame.payload[1] ?? 0,
            maxBrightness: frame.payload[2] ?? 255,
            caps: (frame.payload[3] ?? 0) | ((frame.payload[4] ?? 0) << 8),
          }
          log(`[led] 固件握手：wire=v${device.wireVersion} leds=${device.leds} caps=0x${device.caps.toString(16)}`)
          if (device.wireVersion > LED_WIRE_VERSION) {
            log(`[led] 警告：固件协议版本 v${device.wireVersion} 高于主机认识的 v${LED_WIRE_VERSION}，可能有新帧无法使用`)
          }
          break
        }
        case REPLY.PONG:
          break
        case REPLY.EVENT: {
          const code = frame.payload[0] ?? 0
          const arg = frame.payload[1] ?? 0
          log(`[led] 设备事件 code=${code} arg=${arg}`)
          options.onEvent?.({ code, arg })
          break
        }
        default:
          log(`[led] 收到未处理的回包：${frameTypeName(frame.type)}`)
      }
    }
  }

  return api
}

/** 画面签名（去重用）：只包含真正会被线上帧表达的信息。 */
export function sceneSignature(scene: LedScene): string {
  return `${scene.state}|${scene.flags}|${scene.brightness}|${scene.progress}`
}

/**
 * 从枚举结果里挑一个"最像是我们那块板子"的端口。
 *
 * 经验规则：USB 转串口（CH340/CP2102/FT232）拿到的是 COM3 及以上；
 * COM1/COM2 往往是主板自带的、或者被别的软件占着。所以优先取编号大的。
 * 排序理由写在这里，免得以后有人以为这是随便排的。
 */
export function pickAutoPort(ports: readonly LinkPortInfo[]): string {
  if (ports.length === 0) return ''
  const score = (path: string): number => {
    const win = /^COM(\d+)$/i.exec(path)
    if (win) {
      const n = Number(win[1])
      return n >= 3 ? 1000 + n : n         // USB 转串口优先，且编号大的更可能是它
    }
    if (/^\/dev\/tty(USB|ACM)\d+$/.test(path)) return 2000
    if (/^\/dev\/cu\.usb/.test(path)) return 2000
    if (/^\/dev\/tty(AMA|S)\d+$/.test(path)) return 10
    return 1
  }
  return [...ports].sort((a, b) => score(b.path) - score(a.path))[0]?.path ?? ''
}

/** 端口名是否像个合法串口（防止把任意字符串塞进 CreateFileW）。 */
export function isValidPortName(path: string): boolean {
  const text = String(path).trim()
  if (text === '') return false
  if (/^COM\d{1,3}$/i.test(text)) return true
  if (/^\/dev\/[A-Za-z0-9._-]{1,64}$/.test(text)) return true
  return false
}
