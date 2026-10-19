// 串口链路层 —— 握手、像素流、去重、重连（纯逻辑 + 注入式打开，便于单测）
//
// 真硬件：AI Status Lights（CH32V003 + 7×WS2812B + 无源蜂鸣器），协议见 led-protocol.ts。
// 这一层只干五件事：
//   1. **握手**：打开后先发 VERIFY，收到 `AI Status Lights OK\r\n` 才算连上 ——
//      这台机器上还插着手机/下载器之类的 COM 口，不能"打开就算成功"；
//   2. **渲染**：把当前语义画面按时刻渲染成 7 颗灯的像素（led-render.ts）；
//   3. **去重**：像素没变就不写（稳态 0 字节/秒；动画时才每帧 26 字节）；
//   4. **心跳**：像素没变也每 1s 重发一次，防止丢帧后灯卡在旧画面上；
//   5. **重连**：端口被拔/被占用/不是本板子时按退避重试（300ms→1s→2s→5s→10s）。
//
// 打开/枚举都是注入的（options.open / options.list），单测用假句柄穷举：
// 写失败、半包回包、握手超时、设备中途掉线、端口从 auto 变成 COM5……

import {
  BAUD_RATE, LED_COUNT, createReplyScanner, encodeBuzzer, encodeLeds, encodeLedsInto, encodeVerify, frameBytes,
  pixelsEqual, type Beep, type Pixels, type ReplyScannerStats, MODE,
} from './led-protocol.js'
import { createPixelFrame, renderPixels, smootherstep } from './led-render.js'
import { OFF_SCENE, SCENE_FLAG, sceneVisualKey, type LedScene } from './led-scene.js'
import { minWriteGapMs, monotonicNow } from './led-timing.js'

/** 重连退避档位（毫秒）。 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [300, 1000, 2000, 5000, 10000]  // 首轮 300ms：插拔后尽快回来
/** 心跳周期：像素没变也重发一次。 */
export const HEARTBEAT_MS = 1000   // 1s：断线后 ~1s 内就能从写失败发现
/** 握手超时：打开后这么久没等到验证回包就判"这不是本板子"。 */
export const VERIFY_TIMEOUT_MS = 1500

/**
 * 链路质量（自适应冗余的判据，不参与线协议）。
 *   · ok      —— 窗口内没有劣化信号；
 *   · suspect —— 有可恢复的劣化（丢帧/单次写失败/一次重连）：开始**每帧双发**；
 *   · bad     —— 已确认异常（探测回包超时 / 连续写失败 / 短时间多次重连）。
 */
export type LinkQuality = 'ok' | 'suspect' | 'bad'

/** 质量信号窗口：窗口内没有新信号，质量才算恢复（与冗余保持同窗）。 */
export const QUALITY_WINDOW_MS = 10_000
/** 劣化后冗余保持时长：这段时间内每帧双发；之后再没新信号就自动退出。 */
export const REDUNDANCY_HOLD_MS = 10_000
/** 冗余期间的主动探测频率（用空闲带宽换"设备还在"的确定性）。 */
export const PROBE_EVERY_DEGRADED_MS = 800
/** 冗余期间的探测容忍时间（正常回包几十毫秒；再慢就当掉线）。 */
export const PROBE_TIMEOUT_DEGRADED_MS = 400
/** 窗口内丢帧达到这个数 → suspect（偶发单帧是正常抖动）。 */
const DROPPED_SUSPECT = 2
/** 窗口内写失败达到这个数 → bad。 */
const WRITE_FAIL_BAD = 2
/** 窗口内重连达到这个数 → bad。 */
const RECONNECT_BAD = 2
/** 两次故障间隔小于这个值 = "重复失败"（确认不是瞬时抖动）→ 允许发黑帧。 */
const FAIL_CONFIRM_MS = 5000

/**
 * `write()` 的返回：**丢弃**（不是故障）。
 *
 * 传入 `coalesce` 的帧是**可丢的动画帧**：传输层有积压时直接丢掉它，让下一次
 * 用"最新画面"重发，而不是让过期画面排队。0 表示"设备没响应"，-1 表示"我们主动丢的"，
 * 两者必须分开 —— 否则一积压就会被判成故障、触发重连。
 */
export const WRITE_DROPPED = -1

export interface LinkWriteOptions {
  /**
   * true = 可丢弃的动画帧：传输层允许在积压时拒绝（返回 `WRITE_DROPPED`）。
   * false/省略 = **必达**控制帧（握手、蜂鸣、熄灯、自检覆盖）—— 必须按顺序全部送达。
   */
  readonly coalesce?: boolean
}

/**
 * 链路层看到的"句柄"与"端口"是**结构性**类型，不是 serial-port.ts 里的实现类：
 * 依赖倒置（链路逻辑与硬件解耦，单测传假句柄）+ 编译分层（核心层不能被平台层拖进来）。
 */
export interface LinkHandle {
  /**
   * 写一帧。
   * @returns 接受的字节数；`0` = 设备没响应；`WRITE_DROPPED`(-1) = 传输层按
   *          `options.coalesce` 主动丢弃（有积压），**不是故障**。
   * @param options.coalesce 见 LinkWriteOptions。
   */
  write(bytes: Buffer, options?: LinkWriteOptions): number
  read(max?: number): Buffer
  close(): void
  /** 发送队列里还没落地的帧数（诊断/背压用；不实现就当 0）。 */
  pending?(): number
  /**
   * 传输层**自己**发现的异步故障（worker 卡死、串口线程退出、写超时）。
   * 链路把它当写失败处理（关句柄 + 走重连）；**不是**"这一帧被丢弃"的通知。
   */
  onFault?: (message: string) => void
  /**
   * **同步**写一帧：阻塞到传输层确认"字节已被接受"，最多 `timeoutMs`。
   * 只给"丢了这一帧灯就停在错误颜色上"的场合（熄灯/退出）—— 它会阻塞主线程。
   * 异步写只保证"交给 worker"，进程/线程被收走时那一帧可能还没发出去。
   */
  writeSync?(bytes: Buffer, timeoutMs?: number): number
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
  /**
   * 被**主动丢弃**的动画帧数（积压时的背压结果，不是故障）。
   * 它和 framesSent 一起才能说明"实际推了多少帧"——只看 framesSent 会把
   * "主线程以为发出去了、其实还在队列里"当成成功。
   */
  readonly dropped: number
  /** 此刻发送队列里还没落地的帧数（Windows：worker 尚未回报 written）。 */
  readonly pending: number
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
  /**
   * 链路质量（自适应冗余判据；见 {@link LinkQuality}）。
   * 可选字段：旧调用方/替身不提供时按 'ok' 处理。
   */
  readonly quality?: LinkQuality
  /**
   * 是否处于**自适应冗余**：劣化后 10s 内每帧双发 + 快速健康探针。
   * 可选字段：旧调用方/替身不提供时按 false 处理。
   */
  readonly redundancy?: boolean
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
  /** 健康期主动探测周期（默认 2500ms；劣化期自动提到 800ms）。 */
  readonly probeEveryMs?: number
  /** 健康期探测容忍时间（默认 1200ms；劣化期自动降到 400ms）。 */
  readonly probeTimeoutMs?: number
  /** 劣化期（自适应冗余）的探测周期（默认 800ms）。 */
  readonly probeEveryDegradedMs?: number
  /** 劣化期（自适应冗余）的探测容忍时间（默认 400ms）。 */
  readonly probeTimeoutDegradedMs?: number
}

export interface SerialLink {
  configure(port: string, baud?: number): void
  /** 推入当前语义画面（链路会在每次 tick 时按时刻渲染）。 */
  applyScene(scene: LedScene): void
  /** 由宿主定时器驱动：连接管理 + 握手 + 渲染 + 收发。 */
  tick(): void
  /**
   * 这一层此刻是否**需要连续帧**（控制器按需调度用）。
   *
   * opening/verifying（握手/重连）、交叉渐变窗口、覆盖动画，以及 running/waiting/error
   * 这类连续动画画面 → true；稳态（off / done）→ false（靠心跳 + 主动探测就够）。
   * 可选：实现方（多灯扇出层）没有这个方法时，控制器会退回保守判据（握手状态 + 画面状态）。
   */
  needsFrames?(): boolean
  /** 立刻响一声（不经过判定；诊断/联调用）。 */
  beep(beep: Beep): boolean
  /** 原样写一帧（已经编码好的；对外 API 的 raw 出口用）。 */
  rawFrame(frame: Buffer): boolean
  /** 帧内容覆盖（自检动画用）：给了就替代常规画面渲染，null 取消。 */
  setOverride(fn: ((nowMs: number) => Pixels) | null): void
  /** 从当前像素重新起一段渐变（自检结束回到常规画面时用，避免硬切）。 */
  restartFade(): void
  /**
   * 立刻把某个画面推下去：**绕过**写入间隔与去重。
   * 只给"必须落地"的场合用（熄灯、淡出结束）—— 这里丢一帧，灯就停在半亮上。
   */
  flush(scene?: LedScene): boolean
  /**
   * 看门狗：把"已握手但长时间写不出去"判成故障并关掉句柄（交给重连）。
   * 没有它，拔线后如果恰好没有写操作，状态会永远停在"运行中"。
   */
  reap(): void
  /** 手动重发验证帧。 */
  verify(): boolean
  status(): LinkStatus
  close(): void
}

export function createSerialLink(options: SerialLinkOptions): SerialLink {
  const now = options.now ?? monotonicNow
  const log = options.log ?? (() => {})
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const backoff = options.backoffMs ?? RECONNECT_BACKOFF_MS
  const verifyTimeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS

  let port = String(options.port ?? '').trim()
  let baud = Math.max(1200, Math.trunc(options.baud ?? BAUD_RATE) || BAUD_RATE)
  let handle: LinkHandle | null = null
  let state: LinkState = 'idle'
  let openedFor = ''
  /** 上次**握手成功**的端口：重连时直接开它，避免每次都枚举。 */
  let lastGoodPort = ''
  /** 上次枚举时刻（枚举节流：≥5 秒一次；它不是状态源，只是兜底发现）。 */
  let lastEnumerateAt = 0
  const ENUMERATE_EVERY_MS = 5000
  /**
   * 自动发现：**候选轮转**（对齐参考上位机 `ail_link.find_device`）。
   *
   * 参考实现是"列出所有串口 → 逐个发验证帧 → 谁应答谁就是板子"；我们过去只挑**一个**
   * 候选硬试，一旦选错（比如把手机当成灯，日志里的"串口 COM19 没有回应验证帧"）
   * 就会一直重试那个口，永远轮不到真正的板子。现在：
   *   一轮里每个口试一次（0.8s 握手窗口）→ 失败的口冷却 30s → 成功即记住 lastGoodPort。
   */
  let candidateQueue: string[] = []
  /** 枚举结果缓存（候选轮转期间复用；避免每 250ms 就枚举一次）。 */
  let knownPorts: LinkPortInfo[] = []
  /** 被拒绝（无应答 / 打不开）的端口 → 冷却截止时刻。 */
  const rejectedUntil = new Map<string, number>()
  const REJECT_COOLDOWN_MS = 30_000
  /** 候选口的握手窗口（参考上位机每口 0.3s、最多 3 次；这里 0.8s 内发两次验证帧）。 */
  const PROBE_HANDSHAKE_MS = 800
  /** 换下一个候选的间隔：多口机器上不能走指数退避（会把发现拖到 10s+）。 */
  const CANDIDATE_RETRY_MS = 250
  /** 本次打开是"探测候选"还是"直连已知口"：决定握手窗口与失败处理。 */
  let probingNow = false
  /** 这次打开已经发了几次验证帧（固件偶尔丢帧）。 */
  let verifySends = 0
  /** 握手截止时刻。 */
  let verifyDeadlineAt = 0
  /** 是否有一个 open() 正在飞（防止 8ms 帧循环并发 CreateFile 同一端口）。 */
  let opening = false
  /**
   * 打开操作的**所有权令牌**：每轮 open 领一个号。
   *
   * 为什么光有 `opening` 布尔不够（用户/GPT 审查指出）：打开超时后我们会把 `opening`
   * 清掉让下一轮能跑，但**上一轮并没有被取消**——它随后失败时仍会执行 `catch { fail() }`
   * 把新一轮刚建立的状态打掉，它的 `finally { opening = false }` 还会把新一轮的互斥解开。
   * 有了令牌：catch 里比对代次（过期失败不触发重连），finally 只允许"当前所有者"清标记。
   */
  let openToken = 0
  /**
   * 生命周期代次：每次 close/stop 递增。
   * 异步 open() 回来时要对一下代次 —— 否则"打开过程中被关掉"会把一个**已过期**的句柄
   * 装进 handle，之后的读写就打在无效句柄上（koffi 层可能直接崩进程）。
   */
  let gen = 0
  /** open() 起始时刻（用于打开超时兜底：CreateFile 对已移除设备可能长时间不返回）。 */
  let openStartedAt = 0
  const OPEN_TIMEOUT_MS = 3000
  let attempt = 0
  let nextRetryAt = 0
  let openedAt = 0
  let verified = false
  let lastWriteAt = 0
  let lastError = ''
  let lastErrorCode: LinkErrorCode = ''
  let framesSent = 0
  let bytesSent = 0
  /** 积压时被主动丢掉的动画帧（背压，不是故障）。 */
  let droppedFrames = 0
  let scene: LedScene = OFF_SCENE
  let lastPixels: Pixels = []
  let lastSentAt = 0
  /**
   * 已写入串口那一帧的**快照**（去重基准），以及"有没有发过帧"。
   *
   * 不能直接记 `pixels` 引用：像素缓冲现在是复用的（下一帧就地改写），
   * 引用一存就会变成"自己和自己比"—— 去重永远命中、画面再也不更新。
   */
  let hasSent = false
  const sentFrame = createPixelFrame()
  /** 常规画面渲染目标（复用，不再每帧新建 7 个像素对象）。 */
  const renderFrame = createPixelFrame()
  /** 渐变/抖动的工作缓冲（复用）。 */
  const outFrame = createPixelFrame()
  /** 渐变起点的快照（复用；渐变的 300ms 里每帧都要读它）。 */
  const fadeFrame = createPixelFrame()
  /** 编码目标（复用 26 字节；句柄 write() 会拷走字节，见 encodeLedsInto 注释）。 */
  const ledsFrame = Buffer.allocUnsafe(frameBytes(MODE.LEDS))
  /** 看门狗阈值：握手后这么久没成功写出一个字节，就认为设备已经没了。 */
  const STALE_MS = 3000
  /** 健康期主动探测周期：定期发验证帧，收不到回包才算真的断了。 */
  const probeEveryBase = Math.max(200, Math.trunc(options.probeEveryMs ?? 2500) || 2500)
  /** 健康期探测容忍时间（板子回 21 字节 ASCII，正常几十毫秒）。 */
  const probeTimeoutBase = Math.max(100, Math.trunc(options.probeTimeoutMs ?? 1200) || 1200)
  /** 劣化期（冗余）的探测节奏：用空闲带宽换"设备还在"的确定性。 */
  const probeEveryDegraded = Math.max(100, Math.trunc(options.probeEveryDegradedMs ?? PROBE_EVERY_DEGRADED_MS) || PROBE_EVERY_DEGRADED_MS)
  const probeTimeoutDegraded = Math.max(100, Math.trunc(options.probeTimeoutDegradedMs ?? PROBE_TIMEOUT_DEGRADED_MS) || PROBE_TIMEOUT_DEGRADED_MS)
  let lastProbeAt = 0
  let probeSentAt = 0
  /** 自适应冗余：截止时刻（劣化信号会把它一再往后推，健康后自动到期）。 */
  let redundancyUntil = 0
  /** 上一次"已连接状态下"的故障时刻（判断"重复失败"→ 才允许发黑帧）。 */
  let lastFailAt = 0
  /** 连续写失败计数（成功后清零；用于把"瞬时一次"与"持续写不出去"分开）。 */
  let consecutiveWriteFails = 0
  /** 质量信号窗口起点与窗口内计数（见 QUALITY_WINDOW_MS）。 */
  let qualityWindowAt = 0
  let winDropped = 0
  let winWriteFail = 0
  let winProbeTimeout = 0
  let winReconnect = 0
  /** 交叉渐变的起点（'' = 无渐变）。 */
  let fadeFrom: Pixels = []
  let fadeStart = 0
  let frameSeq = 0
  /** 当前画面是什么时候开始的（逐灯进入的 age 基准）。 */
  let sceneSince = 0
  const FADE_MS = 250        // 300ms ÷ 1.2（用户要求渐变整体提速 1.2×）
  /** 覆盖渲染（自检动画）；null = 走常规 renderPixels。 */
  let override: ((nowMs: number) => Pixels) | null = null
  /**
   * 两次写入的**物理下限**（毫秒）：一帧在线上要占的时间 × 1.15。
   * 26B @115200 ≈ 2.26ms → 2.6ms；只是"不比线速更快地灌数据"的保护，
   * 必须小于帧周期（4.1667ms），否则目标 240fps 会被自己的门控砍掉。
   */
  let minGapMs = minWriteGapMs(frameBytes(MODE.LEDS), baud)
  /** 一帧 LEDS 的字节数（线上时间/占用率都按它算）。 */
  const LEDS_FRAME_BYTES = frameBytes(MODE.LEDS)
  const scanner = createReplyScanner()

  const api: SerialLink = {
    configure(nextPort, nextBaud) {
      const p = String(nextPort ?? '').trim()
      const b = Math.max(1200, Math.trunc(nextBaud ?? baud) || BAUD_RATE)
      if (p === port && b === baud) return
      log(`[led] 串口配置变化：${port || 'auto'}@${baud} → ${p || 'auto'}@${b}`)
      port = p
      baud = b
      minGapMs = minWriteGapMs(LEDS_FRAME_BYTES, baud)
      closeHandle('配置变化')
      attempt = 0
      nextRetryAt = 0
      state = 'idle'
    },
    applyScene(next) {
      // 画面一变就记下"从哪淡入"：240Hz 下这 300ms 的交叉渐变看起来才是连续的，
      // 否则白→绿是硬切（用户明确要"曲速渐变"）。
      //
      // ⚠️ 判据必须是**会改变像素**的键（sceneVisualKey），不能用完整 flags：
      // 切标签页/切应用会让页面聚焦状态翻转 → judge 给 running 画面打/去 MUTED 标记。
      // MUTED 在 running/done/error 的渲染里根本不参与（只影响 waiting 的呼吸），
      // 旧实现却把它当新画面：重置 sceneSince（彗星回到起点、逐灯 stagger 重新展开）
      // 再叠 250ms 渐变 → 用户看到"切一次标签页就闪一次、连续切就严重闪烁"。
      if (sceneVisualKey(next) !== sceneVisualKey(scene)) {
        // 快照：像素缓冲会被下一帧就地改写，渐变起点必须拷进独立缓冲
        if (lastPixels.length > 0) fadeFrame.copyFrom(lastPixels)
        fadeFrom = lastPixels.length > 0 ? fadeFrame.pixels : []
        fadeStart = now()
        sceneSince = now()
      }
      scene = next
    },
    tick() {
      const t = now()
      if (handle === null) {
        // ⚠️ opening 守卫：open() 是异步的，而帧循环 4ms 一次 —— 没有守卫会
        // 并发 CreateFile 同一个端口，产生多个句柄；之后在已关闭/泄漏的句柄上
        // 读写会让 koffi 打到无效句柄，直接崩进程（"插灯时 DSH 崩溃"）。
        if (opening) {
          // 打开超时兜底：CreateFile 对"已移除但端口名还在"的设备可能长时间不返回。
          // 不兜底的话 opening 永远为 true → 再也不重试 → 灯彻底卡死。
          if (openStartedAt > 0 && t - openStartedAt > OPEN_TIMEOUT_MS) {
            opening = false
            openToken += 1       // 让在飞的那一轮**失去所有权**：它的 finally 不能替下一轮放锁
            gen += 1             // 迟到的句柄会被代次校验丢弃并关闭
            openStartedAt = 0
            fail('打开串口超时（设备可能已移除）', 'open-failed')
          }
          return
        }
        if (t >= nextRetryAt) void tryOpen(t)
        return
      }
      // 1) 握手阶段：只等回包
      if (!verified) {
        drainReplies()
        if (verified) return
        // 固件偶尔丢一帧：截止前再补发一次验证帧（参考上位机默认重试 3 次）
        if (verifySends < 2 && t - openedAt >= 400) {
          verifySends += 1
          writeAll(encodeVerify())
        }
        if (t >= verifyDeadlineAt) {
          if (probingNow && openedFor !== '') {
            // 这个口不是板子（或没烧固件）：冷却它，**立刻换下一个候选**
            rejectedUntil.set(openedFor, t + REJECT_COOLDOWN_MS)
            candidateQueue = []
            log(`[led] 串口 ${openedFor} 没有回应验证帧 → 换下一个候选（冷却 ${Math.round(REJECT_COOLDOWN_MS / 1000)}s）`)
            fail(`串口 ${openedFor} 没有回应验证帧（可能不是 AI Status Lights）`, 'verify-timeout', CANDIDATE_RETRY_MS)
          } else {
            // 直连"上次成功的口"失败：清掉记忆，下一轮重新枚举 + 逐个探测
            lastGoodPort = ''
            fail(`串口 ${openedFor} 没有回应验证帧（可能不是 AI Status Lights）`, 'verify-timeout')
          }
        }
        return
      }
      // 2) 已连上：读回包（板子目前只回验证串，读走避免缓冲堆满）
      drainReplies()
      // 3) 渲染 + 交叉渐变 + 去重 + 心跳（全部走复用缓冲，稳态每帧 0 分配）
      const target = override !== null ? override(t) : renderFrame.render(scene, t, t - sceneSince)
      let pixels: Pixels = target
      if (fadeStart > 0) {
        const k = smootherstep((t - fadeStart) / FADE_MS)
        if (k >= 1) {
          fadeStart = 0
          fadeFrom = []
        } else {
          // 渐变期间保留时间抖动（低亮度只有几级台阶，±1 LSB 能铺平；时段只有 250ms，
          // 且画面在快速变化，抖动本身不可见）。
          outFrame.blend(fadeFrom, target, k)
          outFrame.dither(frameSeq++)
          pixels = outFrame.pixels
        }
      }
      // ⚠️ **稳态动画不再做时间抖动**（上一版这里对 running/waiting 每帧 ±1 LSB 交替）。
      // 实测：彗星走到两端时速度≈0，同一颗灯的目标值连续多帧不变，而抖动让它每帧在
      // 两个相邻灰度间来回跳（240Hz）—— 看起来就是"律动核心到两头时的极快微闪"。
      // 量化校验：2400 帧里逐通道"±1 来回跳"的次数，原始渲染 4 次，加抖动后 16264 次。
      // 抖动只在交叉渐变（画面快速变化、抖动被运动掩盖）时保留，稳态改回纯 8 位输出。
      lastPixels = pixels
      // 安全门控 ①：写入间隔不下于"这帧真正要占用的线上时间"。
      // 它保护的是**串口**（灌爆 USB 转串口的发送缓冲 → 灯一顿一顿的），不是帧率目标；
      // 帧率目标由控制器的帧周期决定，这里只做物理下限。宁可丢帧也不堆队列。
      if (hasSent && t - lastSentAt < minGapMs) return
      const changed = !hasSent || !pixelsEqual(pixels, sentFrame.pixels)
      const due = t - lastSentAt >= heartbeatMs
      if (!changed && !due) return
      // 自适应冗余：链路劣化时这一帧**写两遍**（第一份可丢动画帧 + 第二份必达控制帧）。
      // 判定必须在第一份之前做：写出去之后 pending 就变 1 了；而第二份只在**传输层没积压**
      // 时才补 —— 否则等于把队列灌满，画面只会更晚（背压优先于冗余）。
      const wantRedundant = redundancyActive(t) && pendingNow() === 0
      // 安全门控 ②：**可丢的动画帧** —— 传输层积压时直接丢，下一次用最新画面重发。
      // 画面本来就是按绝对时刻算的，过期帧补发只会让灯"越追越晚"。
      if (writeAll(encodeLedsInto(pixels, ledsFrame), true)) {
        sentFrame.copyFrom(pixels)
        hasSent = true
        lastSentAt = t
        // 第二份：句柄在 write() 返回前会拷走字节（见 encodeLedsInto 注释），复用同一缓冲安全。
        if (wantRedundant) writeAll(ledsFrame, false)
      }
    },
    beep(beep) {
      if (handle === null || !verified) return false
      return writeAll(encodeBuzzer(beep))          // 控制帧：必达，不可丢
    },
    rawFrame(frame) {
      if (handle === null || !verified) return false
      // 颜色帧（MODE.LEDS）与内部动画帧同一策略：可丢、最新画面优先。
      // 否则外部 API（desktopNotify.led.pixels）高频调用就能绕过背压把 worker 队列灌满；
      // 验证/蜂鸣等控制帧仍然必达。
      return writeAll(frame, frame.length > 2 && frame[2] === MODE.LEDS)
    },
    restartFade() {
      // 快照：自检结束回到常规画面时从"当前像素"渐入（像素缓冲是复用的）
      if (lastPixels.length > 0) fadeFrame.copyFrom(lastPixels)
      fadeFrom = lastPixels.length > 0 ? fadeFrame.pixels : []
      fadeStart = now()
    },
    setOverride(fn) {
      override = fn
    },
    flush(next) {
      if (next) scene = next
      if (handle === null || !verified) return false
      const pixels = renderPixels(scene, now())
      lastPixels = pixels
      fadeStart = 0
      fadeFrom = []
      if (writeLanding(encodeLeds(pixels))) {
        sentFrame.copyFrom(pixels)
        hasSent = true
        lastSentAt = now()
        return true
      }
      return false
    },
    needsFrames() {
      // 握手/重连完全靠帧循环推进（验证帧重发、候选轮转、打开重试）
      if (state === 'opening' || state === 'verifying') return true
      if (handle !== null && !verified) return true
      // 交叉渐变窗口：逐帧按绝对时刻算进度，必须连续帧
      if (fadeStart > 0) return true
      // 覆盖动画（自检）
      if (override !== null) return true
      // 连续动画画面：流转/呼吸/闪烁
      if (scene.state === 'running' || scene.state === 'waiting' || scene.state === 'error') return true
      // done/off 是稳态；带提醒（正常不会出现，防御性）仍要闪
      return (scene.flags & SCENE_FLAG.ATTENTION) !== 0
    },
    reap() {
      if (!verified || handle === null) return
      const t = now()
      // 冗余期用"快速健康探针"：0x00 的频率与容忍时间都收紧，回包一缺就重连，
      // 不等健康期的 2.5s/1.2s。带宽成本几乎为零（5 字节/秒都不到）。
      const redundant = redundancyActive(t)
      const probeTimeout = redundant ? probeTimeoutDegraded : probeTimeoutBase
      const probeEvery = redundant ? probeEveryDegraded : probeEveryBase
      // ① 写了这么久都没成功过 → 断（确认断开 → 允许发黑帧）
      if (lastWriteAt > 0 && t - lastWriteAt > STALE_MS) {
        fail('串口无响应（可能已拔出）', 'write-failed', undefined, true)
        return
      }
      // ② **主动探测**：拔掉 USB 后 Windows 往往仍让 WriteFile "成功"（写进缓冲丢弃），
      //    所以"写成功"不能证明设备还在。定期发一帧验证命令，收不到回包才判定断开。
      if (probeSentAt > 0 && t - probeSentAt <= probeTimeout) return
      if (probeSentAt > 0 && t - probeSentAt > probeTimeout) {
        probeSentAt = 0
        noteQualitySignal(t, 'probe-timeout')
        fail('串口无响应（可能已拔出）', 'verify-timeout', undefined, true)
        return
      }
      if (t - lastProbeAt >= probeEvery) {
        lastProbeAt = t
        if (writeAll(encodeVerify())) probeSentAt = t
      }
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
        dropped: droppedFrames,
        pending: pendingNow(),
        lastError,
        errorCode: lastErrorCode,
        retryInMs: handle === null && nextRetryAt > t ? nextRetryAt - t : 0,
        verified,
        reply: scanner.stats,
        scene: `${scene.state}${scene.flags ? '+' + scene.flags : ''} bright=${scene.brightness}`,
        pixels: lastPixels,
        quality: computeQuality(t),
        redundancy: redundancyActive(t),
      }
    },
    close() {
      closeHandle('插件卸载')
      state = 'disabled'
    },
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  function closeHandle(why: string): void {
    // 代次自增**放在最前面**：即使此刻没有句柄，也要让"正在飞的 open()"失效，
    // 否则关掉之后那个迟到的句柄会被装回来（之后的读写就打在已过期句柄上）。
    gen += 1
    if (handle === null) return
    try { handle.close() } catch (e) { /* ignore */ }
    handle = null
    openedFor = ''
    verified = false
    hasSent = false
    log(`[led] 串口已关闭（${why}）`)
  }

  // ── 链路质量（自适应冗余判据）─────────────────────────────────────────────

  /** 滚动质量窗口：窗口过期就清零计数（纯时间驱动，不需要定时器）。 */
  function rollQualityWindow(t: number): void {
    if (qualityWindowAt === 0) { qualityWindowAt = t; return }
    if (t - qualityWindowAt < QUALITY_WINDOW_MS) return
    qualityWindowAt = t
    winDropped = 0
    winWriteFail = 0
    winProbeTimeout = 0
    winReconnect = 0
  }

  /**
   * 记一个劣化信号：按类型计数；**只有质量真的掉下 ok 才进入冗余保持期**。
   *
   * 为什么不是"任何一个信号都进冗余"：传输层丢动画帧本来就是设计内的背压
   * （积压时丢旧帧、发最新帧）。单次丢帧就双发，会让线上占用翻倍 → 更容易积压 →
   * 更多丢帧，自我维持成恶性循环。所以单帧抖动只看不报；窗口内累计到阈值
   * （或一次写失败/一次重连/一次探测超时）才切冗余。
   *
   * **只统计"已连接链路"上的劣化**：自动发现时"这个口不是板子"的握手失败不算 ——
   * 否则每次插一个新的非板子串口都会白降频 10 秒。
   */
  function noteQualitySignal(t: number, kind: 'dropped' | 'write-fail' | 'probe-timeout' | 'reconnect'): void {
    rollQualityWindow(t)
    if (kind === 'dropped') winDropped += 1
    else if (kind === 'write-fail') winWriteFail += 1
    else if (kind === 'probe-timeout') winProbeTimeout += 1
    else winReconnect += 1
    if (computeQuality(t) !== 'ok') redundancyUntil = t + REDUNDANCY_HOLD_MS
  }

  function computeQuality(t: number): LinkQuality {
    rollQualityWindow(t)
    if (winProbeTimeout >= 1 || winWriteFail >= WRITE_FAIL_BAD || winReconnect >= RECONNECT_BAD) return 'bad'
    if (winDropped >= DROPPED_SUSPECT || winWriteFail >= 1 || winReconnect >= 1) return 'suspect'
    return 'ok'
  }

  /** 自适应冗余是否生效（劣化后保持 10s；之后没有新信号就自动退出）。 */
  function redundancyActive(t: number): boolean {
    return t < redundancyUntil
  }

  /** 传输层当前积压的帧数（没实现 pending 的句柄按 0 处理）。 */
  function pendingNow(): number {
    if (handle === null || typeof handle.pending !== 'function') return 0
    try {
      return handle.pending()
    } catch (e) {
      return 0
    }
  }

  /** fail() 重入保护：断线熄灯那次写失败绝不能再触发一次 fail（否则递归风暴）。 */
  let inFail = false

  /**
   * 记一次链路故障并进入重连。
   *
   * `confirmed` = 这次故障已能确认设备确实不在了（探测超时 / 读失败 / 传输层硬故障）。
   * **只有"确认断开"或"短时间内重复失败"才发黑帧**：瞬时写失败先不发黑 ——
   * WS2812 锁存的那一帧本来就是绝对状态，重连后下一帧会立刻纠正；
   * 而黑一下比"停在旧颜色"更刺眼，也更容易被用户当成设备挂了。
   */
  function fail(message: string, code: LinkErrorCode = 'open-failed', retryMs?: number, confirmed = false): void {
    if (inFail) return
    inFail = true
    const t = now()
    const wasConnected = verified && handle !== null
    const repeat = wasConnected && lastFailAt > 0 && t - lastFailAt < FAIL_CONFIRM_MS
    const blackout = wasConnected && (confirmed || repeat)
    // 确认断开才先把灯熄掉：WS2812 会锁存最后一帧，不熄就会"卡在最后一个颜色上"。
    try {
      if (blackout && handle !== null) {
        // **裸写**：直接调句柄，不走 writeAll（不进统计、不打日志、绝不再次 fail）
        handle.write(encodeLeds(Array.from({ length: LED_COUNT }, () => ({ r: 0, g: 0, b: 0 }))))
      }
    } catch (e) { /* ignore */ }
    if (wasConnected) {
      lastFailAt = t
      noteQualitySignal(t, 'reconnect')
    }
    // 候选轮转时用固定短间隔（retryMs）；直连已知口才走指数退避
    const wait = retryMs ?? (backoff[Math.min(attempt, backoff.length - 1)] ?? 30000)
    try {
      lastError = message
      lastErrorCode = code
      state = 'error'
      closeHandle(message)
      attempt += 1
      nextRetryAt = now() + wait
    } finally {
      inFail = false
    }
    failStreak += 1
    if (failStreak <= 3 || failStreak % 30 === 0) {
      log(`[led] 串口故障（${code || '-'}）：${message}；${wait}ms 后重试（第 ${attempt} 次）`)
    }
  }

  /** 连续失败计数（日志节流用：第 1~3 次逐条，之后每 30 次一条）。 */
  let failStreak = 0
  /** "写入 0 字节"日志的节流时间戳。 */
  let zeroLogAt = 0

  /** 这个口是不是还在冷却期（拒绝过 = 握手无应答 / 打不开）。 */
  function isRejected(path: string, t: number): boolean {
    const until = rejectedUntil.get(path)
    if (until === undefined) return false
    if (until <= t) { rejectedUntil.delete(path); return false }
    return true
  }

  function writeAll(frame: Buffer, coalesce = false): boolean {
    if (handle === null) return false
    const t = now()
    try {
      const written = handle.write(frame, { coalesce })
      if (written === WRITE_DROPPED) {
        // 传输层积压 → 这帧主动丢掉（背压），**不是故障**：
        // 不更新 lastWriteAt、不进 framesSent，下一次 tick 会用最新画面重发。
        droppedFrames += 1
        // 已连接链路上的丢帧是**劣化信号**（自适应冗余据此切双发）；握手/控制帧的丢帧不算
        if (verified) noteQualitySignal(t, 'dropped')
        return false
      }
      if (written === 0) {
        // 0 字节：串口超时后"成功返回但没传出去"是 Windows 允许的行为。
        // 日志**节流**：帧循环 240 次/秒，每条都记会把日志刷爆（曾经 142ms 内 3372 条）。
        if (t - zeroLogAt > 2000) { zeroLogAt = t; log('[led] 写入 0 字节（串口超时/设备已移除）') }
      }
      if (written !== frame.length) {
        consecutiveWriteFails += 1
        if (verified) noteQualitySignal(t, 'write-fail')
        fail(`写入不完整（${written}/${frame.length} 字节）`, 'write-failed', undefined, consecutiveWriteFails >= 2)
        return false
      }
      framesSent += 1
      bytesSent += written
      lastWriteAt = now()
      consecutiveWriteFails = 0
      return true
    } catch (e) {
      consecutiveWriteFails += 1
      if (verified) noteQualitySignal(now(), 'write-fail')
      fail((e as Error).message, 'write-failed', undefined, consecutiveWriteFails >= 2)
      return false
    }
  }

  /**
   * "**必须落地**"的那一帧（熄灯/退出）：句柄支持同步写就等它确认，否则退回异步写。
   *
   * 为什么需要：异步 `write()` 只保证"交给 worker/内核缓冲"。进程退出、worker 被
   * terminate、或者驱动缓冲还满着的时候，那一帧可能根本没发出去 —— 而 WS2812B
   * **锁存最后一帧**，结果就是"DSH 关了，灯还亮在最后一个颜色上"。
   * 同步路径的意义是：等 WriteFile 真的返回成功（= 字节已被驱动接受）再往下走。
   * ⚠️ 它阻塞主线程（一帧 ~2.3ms，最坏等 timeout），只准用在关机类路径上。
   */
  function writeLanding(frame: Buffer): boolean {
    if (handle === null) return false
    if (typeof handle.writeSync !== 'function') return writeAll(frame)
    try {
      const written = handle.writeSync(frame, 400)
      if (written !== frame.length) return false   // 别在关机路径上再触发 fail()/重连
      framesSent += 1
      bytesSent += written
      lastWriteAt = now()
      return true
    } catch (e) {
      return false
    }
  }

  function drainReplies(): void {
    if (handle === null) return
    try {
      const chunk = handle.read()
      if (chunk.length === 0) return
      const found = scanner.push(chunk)
      if (found > 0) {
        probeSentAt = 0          // 回包到了：探测通过
        consecutiveWriteFails = 0
      }
      if (found > 0 && !verified) {
        verified = true
        lastGoodPort = openedFor
        failStreak = 0
        attempt = 0
        lastProbeAt = now()
        probeSentAt = 0
        state = 'ready'
        attempt = 0
        lastError = ''
        lastErrorCode = ''
        hasSent = false
        // 找到真板子：清空候选轮转状态（下次重连直接开这个口）；把它从冷却表里摘掉
        candidateQueue = []
        rejectedUntil.delete(openedFor)
        log(`[led] 握手成功：${openedFor} 是 AI Status Lights`)
      }
    } catch (e) {
      // 读失败 = 句柄真的坏了（不是瞬时写抖动）：确认断开，允许发黑帧
      fail(`读取串口失败：${(e as Error).message}`, 'read-failed', undefined, true)
    }
  }

  async function tryOpen(t: number): Promise<void> {
    if (opening) return
    opening = true
    const myToken = (openToken += 1)
    openStartedAt = now()
    state = 'opening'
    // 本次打开所属的代次：任何 await 回来之后都要对一次，过期就整轮作废
    const openGen = gen
    try {
      let target = port
      probingNow = false
      if (target === '' || target === 'auto') {
        // **事件驱动优先**：重连时先直接开"上次成功的端口"（CreateFile 对不存在的口
        // 会立刻失败，比枚举便宜，也不撞"正在插拔、枚举卡住"的窗口）。
        // 没有记忆 / 记忆的口已被拒绝 → 按候选队列**逐个探测**（对齐参考上位机）：
        // 过去的做法是"只挑一个硬试"，选错（COM19 是手机）就永远轮不到真正的板子。
        const nowMs = now()
        const good = lastGoodPort
        if (good !== '' && !isRejected(good, nowMs)) {
          target = good
        } else {
          if (candidateQueue.length === 0) {
            // 枚举：候选轮完一轮后至少隔 5s 再枚举（枚举本身是"卡死风险"操作）
            if (knownPorts.length === 0 || nowMs - lastEnumerateAt >= ENUMERATE_EVERY_MS) {
              const ports = await options.list()
              if (openGen !== gen) return // 枚举期间连接被关闭/复位 → 这次结果作废
              lastEnumerateAt = now()
              knownPorts = Array.from(ports)
              const order = autoPortOrder(knownPorts)
              log(`[led] 串口候选：${order.join(', ') || '无'}（逐个发验证帧找板子）`)
            }
            candidateQueue = autoPortOrder(knownPorts).filter((p) => !isRejected(p, nowMs))
          }
          if (candidateQueue.length === 0) {
            lastError = knownPorts.length === 0
              ? '没有找到任何串口设备'
              : '所有串口都没有回应验证帧（板子可能没插好 / 没烧录 / 口被别的程序占用）'
            lastErrorCode = 'no-device'
            state = 'error'
            nextRetryAt = t + 10_000
            attempt += 1
            return
          }
          target = candidateQueue.shift() as string
          probingNow = true
        }
      }
      let h
      try {
        h = await options.open(target, baud)
      } catch (e) {
        // 打不开（被别的程序占着 / 已拔出）→ 让它冷却，下一轮换下一个候选
        if (probingNow && target !== '') rejectedUntil.set(target, t + REJECT_COOLDOWN_MS)
        if (target !== '' && target === lastGoodPort) lastGoodPort = ''
        throw e
      }
      // **代次校验（关键）**：await 期间连接可能被关掉/改配置/已判故障，
      // 这时返回的句柄已经过期。直接装进去 → 之后在已关闭的句柄上读写
      // （koffi 层可能直接崩进程）。过期就**关掉它**，一个字段都不改。
      if (openGen !== gen) {
        try { h.close() } catch (e) { /* ignore */ }
        return
      }
      handle = h
      openedFor = target
      openedAt = now()
      verified = false
      verifySends = 1
      verifyDeadlineAt = openedAt + (probingNow ? PROBE_HANDSHAKE_MS : verifyTimeoutMs)
      scanner.reset()
      state = 'verifying'
      // 把传输层的异步故障接进链路（worker 卡死/串口线程退出/写超时）。
      // 没有这一步，"看门狗 terminate + 报故障"那一套是死代码：故障只能等
      // 下一次写返回 0 才被发现，画面静止时会拖很久（灯看起来就是"卡住"）。
      // ⚠️ 代次校验：旧 worker 的迟到故障绝不能让**新**连接走重连。
      const faultGen = openGen
      h.onFault = (message: string) => {
        if (faultGen !== gen) return
        // 传输层自报的故障（worker 卡死/线程退出/写超时）= 确认断开 → 允许发黑帧
        fail(message, 'write-failed', undefined, true)
      }
      // 立刻发验证帧：板子回 ASCII，回包到了才算连上
      writeAll(encodeVerify())
    } catch (e) {
      // 过期尝试的失败**不能**触发 fail()：那会把新一轮刚打开/正在打开的连接打掉。
      // （超时恢复已经给过对方一次机会并递增了代次，这里必须认代次。）
      if (openGen === gen && myToken === openToken) fail((e as Error).message, 'open-failed')
    } finally {
      // 只有"当前所有者"才能清互斥标记：否则旧一轮的 finally 会替新一轮放锁，
      // 让第三轮并发进来（两个 CreateFile 打同一个端口）。
      if (myToken === openToken) { opening = false; openStartedAt = 0 }
    }
  }

  return api
}

/**
 * 自动模式的**候选顺序**（对齐参考上位机 `ail_link.list_ports` 的排序思路）：
 * USB 转串口（CH34x / VCP / USBSER / 描述里带 "USB-SERIAL"）排在前面，
 * 同组内 COM 号**从大到小**（USB 口通常是后插的、号更大；也保留旧版行为）。
 *
 * 注意：顺序只是"先试谁"，**谁是真板子一律由握手回答**——所以哪怕排序全错，
 * 候选轮转也会一个一个试到对为止。
 */
export function autoPortOrder(ports: readonly LinkPortInfo[]): string[] {
  const isUsbSerial = (p: LinkPortInfo): boolean =>
    /CH34|ch341|ch343|ch9102|usb.?serial|VCP|USBSER/i.test(`${p.path} ${p.label}`)
  const comNumber = (p: LinkPortInfo): number => Number((/^COM(\d+)/i.exec(p.path) ?? [])[1] ?? 0)
  return Array.from(ports)
    .sort((a, b) => (
      (Number(isUsbSerial(b)) - Number(isUsbSerial(a)))     // USB 口优先（true 排前面）
      || (comNumber(b) - comNumber(a))                      // 其次 COM 号大的
      || a.path.localeCompare(b.path)
    ))
    .map((p) => p.path)
}

/** 自动挑端口（= 候选顺序里的第一个；保留给旧调用方/测试）。 */
export function pickAutoPort(ports: readonly LinkPortInfo[]): string {
  return autoPortOrder(ports)[0] ?? ''
}

/** 端口名是否看起来像一个合法串口（防止把 'auto' 之类当端口去打开）。 */
export function isValidPortName(path: string): boolean {
  const p = String(path ?? '').trim()
  if (p === '' || p.toLowerCase() === 'auto') return false
  return /^(COM\d+|\/dev\/[A-Za-z0-9._-]+)$/i.test(p)
}
