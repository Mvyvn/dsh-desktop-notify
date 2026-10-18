// LED 串口线协议 v1（本分支专属）—— 帧编解码 + 状态/效果词表（纯函数，无副作用）
//
// 这个模块是"主机 half"与"固件 half"之间**唯一**的契约：两边都按这里编/解帧，
// 因此它必须能被单测穷举（见 tests/led-protocol.test.mjs）与固件自测
// （firmware/host/sim_main.c 会重放同一批测试向量）。
//
// ── 为什么是「语义帧 + 固件本地渲染」而不是「像素流」────────────────────────
// 串口带宽是硬约束：115200 8N1 约 11.5 KB/s，一条 60 灯珠的 WS2812 灯带每帧就要
// 180 字节，30fps 就是 5.4 KB/s —— 一半带宽只够点亮一条灯带，而且主机一卡灯就卡。
// 所以这里把**表现力放在固件里**，线上一律只传"语义"：
//   · 一次状态变化 = 1 个 SCENE 帧（11 字节 ≈ 0.96ms@115200），之后主机不用再说话；
//   · 动画、缓动、亮度曲线全在固件端按本地时钟跑，主机卡顿不影响观感；
//   · 覆盖层（OVERLAY）自带 TTL，固件到期自己回落，省掉"撤销帧"这类往返；
//   · 1 字节即可表达 256 色（RGB332），1 字节即可表达百分比进度。
// 这套设计的直接收益：稳态下**平均带宽 < 20 字节/秒**（只有 1s 一次的心跳），
// 9600 波特的老式 USB-TTL 也跑得动。
//
// ── 帧格式 ─────────────────────────────────────────────────────────────────
//   SOF0 SOF1 | TYPE | SEQ | LEN | PAYLOAD(LEN) | CRC8
//    0xA5 0x5A
//   · 双字节魔数：单字节魔数在设备中途上电（半帧对齐）时会被误同步；
//   · SEQ 由主机自增（回绕），固件只在 ACK/去重时用，不影响渲染；
//   · LEN 是**载荷长度**（0..32），整帧长度 = 6 + LEN；
//   · CRC8(poly 0x07, init 0x00) 覆盖 TYPE/SEQ/LEN/PAYLOAD，**不含魔数**；
//     固件用它丢弃被截断/串扰的帧，而不是把垃圾当命令执行。
//
// ── ASCII 兜底模式 ─────────────────────────────────────────────────────────
// 板子还没打、或手头只有串口助手时，固件同样接受按行读取的 ASCII 命令
// （`S:RUN` / `B:128` / `E:3,255,255,255,5`），方便 bring-up 阶段先点灯再联调。
// ASCII 与二进制不冲突：0xA5 不是可打印字符，固件按首字节分流。

/** 线协议版本（固件在 HELLO_ACK 里回报，主机据此决定能不能用新帧）。 */
export const LED_WIRE_VERSION = 1

/** 帧头双字节魔数。 */
export const FRAME_SOF0 = 0xa5
export const FRAME_SOF1 = 0x5a
/** 单帧载荷上限（超出的帧在编码时就拒绝，避免线上出现固件解析不了的帧）。 */
export const MAX_PAYLOAD = 32
/** 整帧固定开销：SOF0+SOF1+TYPE+SEQ+LEN+CRC8。 */
export const FRAME_OVERHEAD = 6
/** 整帧最大长度。 */
export const MAX_FRAME = FRAME_OVERHEAD + MAX_PAYLOAD

/** 主机 → 设备 的帧类型。 */
export const FRAME = {
  /** 握手：载荷 [wireVersion, flags]。设备回 HELLO_ACK。 */
  HELLO: 0x01,
  /** 语义状态（主力帧）：载荷 [state, flags, brightness, progress, accent]。 */
  SCENE: 0x02,
  /** 显式效果：载荷 [effect, speed, brightness, color, param]。 */
  EFFECT: 0x03,
  /** 全局亮度上限：载荷 [level]。 */
  BRIGHT: 0x04,
  /** 瞬态覆盖层（自带 TTL）：载荷 [effect, speed, brightness, color, ttlHi, ttlLo, repeat]。 */
  OVERLAY: 0x05,
  /** 进度条：载荷 [percent, color, brightness]。 */
  PROGRESS: 0x06,
  /** 设备配置：载荷 [key, u32le]。 */
  CONFIG: 0x07,
  /** 心跳：载荷 []。设备回 PONG。 */
  PING: 0x08,
  /** 清空覆盖层/复位渲染：载荷 []。 */
  CLEAR: 0x09,
  /** 直写一段灯珠（能力位 PIXELS 时才可用）：载荷 [start, count, r, g, b]。 */
  PIXELS: 0x0a,
  /** 主动离线（熄灭 + 让固件进入"主机已退出"态）：载荷 [reason]。 */
  BYE: 0x0b,
} as const

/** 设备 → 主机 的帧类型。 */
export const REPLY = {
  ACK: 0x81,
  NAK: 0x82,
  HELLO_ACK: 0x83,
  PONG: 0x84,
  EVENT: 0x85,
} as const

/** 所有合法的帧类型（解析器用它过滤垃圾）。 */
export const FRAME_TYPES: readonly number[] = [...Object.values(FRAME), ...Object.values(REPLY)]

/**
 * 语义状态。主机的"真完成检查器"（lifecycle.ts）只产出这五个之一：
 *   off      插件未启用 / 无会话在跑，灯灭
 *   running  AI 仍在运行（含等待子代理、后台任务、未完成目标）
 *   waiting  在等你：提问 / 审批 / 被阻塞的目标
 *   done     真正完成（无任何未结算工作）
 *   error    异常：审批被拒、后台任务失败、目标阻塞、插件挂载异常
 */
export type LedState = 'off' | 'running' | 'waiting' | 'done' | 'error'
export const LED_STATES: readonly LedState[] = ['off', 'running', 'waiting', 'done', 'error']

/** 状态 → 线码（词表只增不改，改了就破坏与旧固件的兼容）。 */
export const LED_STATE_CODE: Record<LedState, number> = {
  off: 0x00,
  running: 0x01,
  waiting: 0x02,
  done: 0x03,
  error: 0x04,
}

/** 线码 → 状态（未知码返回 null：调用方**不猜**）。 */
export function stateFromCode(code: number): LedState | null {
  for (const state of LED_STATES) {
    if (LED_STATE_CODE[state] === code) return state
  }
  return null
}

/**
 * SCENE 帧的 flags 位。
 * bit0 ATTENTION —— "自上次聚焦后再没回来"的提醒态：固件把该状态渲染成**加强提醒**
 *                  （更亮的呼吸 + 周期性闪），这正是需求里"灯一直处于提醒状态"。
 * bit1 MUTED     —— 用户已看过/已抑制：固件降到安静版（不闪，只留颜色）。
 * bit2 NIGHT     —— 夜间模式：整体亮度再打一档（躺床上不想被晃）。
 * bit3 TRANSIENT —— 本状态是"过场"（例如完成瞬间的短亮），固件按 param 的秒数后回落。
 */
export const SCENE_FLAG = {
  ATTENTION: 0x01,
  MUTED: 0x02,
  NIGHT: 0x04,
  TRANSIENT: 0x08,
} as const

/**
 * 亮度哨兵：0xFF = 「用设备端配置的默认亮度」。
 *
 * ⚠️ **因此显式亮度上限是 254**（见 MAX_EXPLICIT_BRIGHTNESS）。
 * 这不是洁癖：固件自测曾经抓到过真实事故 —— 主机想发"最亮(255)"，固件按哨兵解释成
 * "用我的默认亮度(160)"，于是"调到最亮反而变暗"。0..254 与 255 只差 1/255 的亮度，
 * 但语义从此没有歧义：**线上出现 255 就一定是"设备自己决定"**。
 */
export const BRIGHTNESS_DEFAULT = 0xff
/** 显式亮度上限（255 被哨兵占用）。 */
export const MAX_EXPLICIT_BRIGHTNESS = 254
/** 把显式亮度夹到合法范围（0..254）。 */
export function clampBrightness(value: number): number {
  return clampInt(value, 0, MAX_EXPLICIT_BRIGHTNESS)
}
/**
 * 颜色哨兵：RGB332 的 0xFF = 「用该状态的默认色」。
 * 想要"接近白"的自定义色时用 0xFE（252,252,255），肉眼与纯白无差。
 */
export const COLOR_DEFAULT = 0xff
/** progress 字段的"无进度"哨兵（0..100 之外）。 */
export const PROGRESS_NONE = 0xff

/** 显式效果词表（EFFECT/OVERLAY 帧用；SCENE 帧由固件按状态自选）。 */
export type LedEffect =
  | 'solid'         // 常亮
  | 'breathe'       // 呼吸（正弦）
  | 'blink'         // 方波闪
  | 'flow'          // 单向流动（跑马，左→右）
  | 'flow-back'     // 单向流动（右→左）
  | 'flow-both'     // 左右往复流动（需求里的"白色左右流动"）
  | 'chase'         // 单点追逐
  | 'rainbow'       // 彩虹循环
  | 'sparkle'       // 随机星点
  | 'wipe'          // 扫过一遍
  | 'progress'      // 进度条（用 PROGRESS 帧的 percent）
  | 'double-flash'  // 双闪（告警）

export const LED_EFFECTS: readonly LedEffect[] = [
  'solid', 'breathe', 'blink', 'flow', 'flow-back', 'flow-both',
  'chase', 'rainbow', 'sparkle', 'wipe', 'progress', 'double-flash',
]

export const LED_EFFECT_CODE: Record<LedEffect, number> = {
  solid: 0x00,
  breathe: 0x01,
  blink: 0x02,
  flow: 0x03,
  'flow-back': 0x04,
  'flow-both': 0x05,
  chase: 0x06,
  rainbow: 0x07,
  sparkle: 0x08,
  wipe: 0x09,
  progress: 0x0a,
  'double-flash': 0x0b,
}

export function effectFromCode(code: number): LedEffect | null {
  for (const effect of LED_EFFECTS) {
    if (LED_EFFECT_CODE[effect] === code) return effect
  }
  return null
}

/** 固件能力位（HELLO_ACK 的 caps 字段，只增不减）。 */
export const LED_CAP = {
  /** 支持 EFFECT/OVERLAY 任意效果。 */
  EFFECTS: 0x0001,
  /** 支持 PIXELS 直写。 */
  PIXELS: 0x0002,
  /** 支持 PROGRESS 进度条。 */
  PROGRESS: 0x0004,
  /** 支持 CONFIG 配置帧。 */
  CONFIG: 0x0008,
  /** 板上有按键（EVENT 上报）。 */
  BUTTON: 0x0010,
} as const

/** CONFIG 帧的键。 */
export const CONFIG_KEY = {
  /** u32：灯珠数量。 */
  LED_COUNT: 1,
  /** u32：全局亮度上限（0..255）。 */
  MAX_BRIGHTNESS: 2,
  /** u32：0=线性亮度，1=伽马校正（默认 1，低亮时观感更好）。 */
  GAMMA: 3,
  /** u32：链路静默多少毫秒后固件进入"失联"表现（0=永不）。 */
  LINK_TIMEOUT_MS: 4,
  /** u32：0=不反转灯序，1=反转（灯带装反了不用重新焊）。 */
  REVERSE: 5,
  /** u32：设备端默认亮度（SCENE 里 brightness=0xFF 时用它）。 */
  DEFAULT_BRIGHTNESS: 6,
} as const

/** 设备 → 主机 的 EVENT 码。 */
export const LED_EVENT = {
  /** 按键短按（用于"我知道了"消除提醒；能力位 BUTTON 时才可能出现）。 */
  BUTTON_PRESS: 0x01,
  /** 按键长按（用于强制清空覆盖层/复位）。 */
  BUTTON_HOLD: 0x02,
  /** 链路超时后固件自报"我已进入失联态"。 */
  LINK_LOST: 0x03,
  /** 链路恢复。 */
  LINK_UP: 0x04,
} as const

// ── CRC8 ────────────────────────────────────────────────────────────────────
// poly 0x07（CRC-8/ATM）、init 0x00、不反转、不异或输出：固件里 6 行查表就能算完。
const CRC8_TABLE = (() => {
  const table = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) {
    let crc = i
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
    }
    table[i] = crc
  }
  return table
})()

/** 计算 CRC8（覆盖 TYPE/SEQ/LEN/PAYLOAD）。 */
export function crc8(bytes: ArrayLike<number>, start = 0, end = bytes.length): number {
  let crc = 0
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i] ?? 0
    crc = (CRC8_TABLE[(crc ^ byte) & 0xff] ?? 0) & 0xff
  }
  return crc
}

// ── 颜色 ────────────────────────────────────────────────────────────────────
/** RGB888 → RGB332（1 字节 256 色；线上省 2 字节/帧）。 */
export function rgbToRgb332(r: number, g: number, b: number): number {
  const ri = clampByte(r) >> 5
  const gi = clampByte(g) >> 5
  const bi = clampByte(b) >> 6
  return ((ri << 5) | (gi << 2) | bi) & 0xff
}

/** RGB332 → RGB888（固件端用同一套位扩展，保证两端颜色一致）。 */
export function rgb332ToRgb(value: number): { r: number; g: number; b: number } {
  const v = clampByte(value)
  const r = ((v >> 5) & 0x07) * 36
  const g = ((v >> 2) & 0x07) * 36
  const b = (v & 0x03) * 85
  return { r, g, b }
}

/** 语义状态在固件里的**默认色**（与 SCENE 帧的 accent 无关时用）：off=黑、running=白… */
export const STATE_COLOR: Record<LedState, { r: number; g: number; b: number }> = {
  off: { r: 0, g: 0, b: 0 },
  running: { r: 255, g: 255, b: 255 },
  waiting: { r: 255, g: 176, b: 0 },
  done: { r: 0, g: 255, b: 64 },
  error: { r: 255, g: 0, b: 0 },
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0
  const n = Math.trunc(value)
  if (n < 0) return 0
  if (n > 255) return 255
  return n
}

/** 把数值夹到 [lo, hi]（非数字取 lo）。 */
export function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  const n = Math.trunc(value)
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

// ── 帧编解码 ────────────────────────────────────────────────────────────────

/** 解出的一帧。 */
export interface LedFrame {
  readonly type: number
  readonly seq: number
  readonly payload: readonly number[]
}

/**
 * 编一帧。载荷超长直接抛错 —— 宁可在主机侧炸掉，也不要在线上发一个固件解析不了的帧。
 * @param payload 0..MAX_PAYLOAD 字节
 */
export function encodeFrame(type: number, seq: number, payload: readonly number[] = []): Buffer {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`LED 帧载荷过长：${payload.length} > ${MAX_PAYLOAD}`)
  }
  const body = Buffer.allocUnsafe(3 + payload.length)
  body[0] = clampByte(type)
  body[1] = clampByte(seq)
  body[2] = payload.length
  for (let i = 0; i < payload.length; i += 1) body[3 + i] = clampByte(payload[i] ?? 0)
  const frame = Buffer.allocUnsafe(FRAME_OVERHEAD + payload.length)
  frame[0] = FRAME_SOF0
  frame[1] = FRAME_SOF1
  body.copy(frame, 2)
  frame[frame.length - 1] = crc8(body)
  return frame
}

/** 手写解析状态机的诊断计数（/dnotify 端点会回显，排查"灯不听话"时先看这里）。 */
export interface FrameParserStats {
  frames: number
  crcErrors: number
  /** 因魔数不同步而丢弃的字节数（持续增长 = 波特率/线序不对）。 */
  resyncs: number
  /** 收到未知类型/超长长度而丢掉的帧数。 */
  dropped: number
}

export interface FrameParser {
  /** 喂一段字节，返回本次解出的完整帧（可能 0..n 个）。 */
  push(chunk: Uint8Array): LedFrame[]
  /** 复位（重新打开串口/切换波特率时用）。 */
  reset(): void
  readonly stats: Readonly<FrameParserStats>
}

/**
 * 增量帧解析器：可跨 chunk 拼接、可重同步、CRC 不符即丢帧。
 * 关键点：**丢帧必须回到魔数搜索**，否则一个坏 LEN 会把解析器永久带偏。
 */
export function createFrameParser(): FrameParser {
  const buffer: number[] = []
  const stats: FrameParserStats = { frames: 0, crcErrors: 0, resyncs: 0, dropped: 0 }

  const findSof = (): number => {
    for (let i = 0; i + 1 < buffer.length; i += 1) {
      if (buffer[i] === FRAME_SOF0 && buffer[i + 1] === FRAME_SOF1) return i
    }
    return -1
  }

  return {
    push(chunk: Uint8Array): LedFrame[] {
      for (let i = 0; i < chunk.length; i += 1) buffer.push(chunk[i] ?? 0)
      const out: LedFrame[] = []
      for (;;) {
        if (buffer.length < 2) break
        const start = findSof()
        if (start < 0) {
          // 没有魔数：只保留最后 1 字节（它可能是被截断的 SOF0）
          const keep = buffer[buffer.length - 1] === FRAME_SOF0 ? 1 : 0
          stats.resyncs += buffer.length - keep
          buffer.splice(0, buffer.length - keep)
          break
        }
        if (start > 0) {
          stats.resyncs += start
          buffer.splice(0, start)
        }
        if (buffer.length < 5) break                       // 头部还没到齐（SOF0 SOF1 TYPE SEQ LEN）
        const type = buffer[2] ?? 0
        const seq = buffer[3] ?? 0
        const len = buffer[4] ?? 0
        if (len > MAX_PAYLOAD || !FRAME_TYPES.includes(type)) {
          stats.dropped += 1
          buffer.splice(0, 2)                              // 只吃掉一个魔数，重新同步
          continue
        }
        const total = FRAME_OVERHEAD + len
        if (buffer.length < total) break
        const body = buffer.slice(2, total - 1)
        const expected = buffer[total - 1] ?? 0
        if (crc8(body) !== expected) {
          stats.crcErrors += 1
          buffer.splice(0, 2)                              // 同上：重新同步而不是相信 LEN
          continue
        }
        stats.frames += 1
        out.push({ type, seq, payload: buffer.slice(5, total - 1) })
        buffer.splice(0, total)
      }
      return out
    },
    reset(): void {
      buffer.length = 0
    },
    get stats(): Readonly<FrameParserStats> {
      return stats
    },
  }
}

// ── 语义帧构造（主机侧唯一入口，避免各处手拼字节）──────────────────────────

/** SCENE 帧入参。 */
export interface SceneInput {
  readonly state: LedState
  /** 关注位（见 SCENE_FLAG），缺省 0。 */
  readonly flags?: number
  /** 亮度 0..255 或 BRIGHTNESS_DEFAULT。 */
  readonly brightness?: number
  /** 进度 0..100 或 PROGRESS_NONE。 */
  readonly progress?: number
  /** 强调色 RGB332；缺省 0xFF 表示"用该状态的默认色"。 */
  readonly accent?: number
}

/** SCENE 的载荷（导出以便测试与文档共用一份真源）。 */
export function scenePayload(scene: SceneInput): number[] {
  return [
    LED_STATE_CODE[scene.state],
    (scene.flags ?? 0) & 0xff,
    scene.brightness === undefined ? BRIGHTNESS_DEFAULT : clampBrightness(scene.brightness),
    scene.progress === undefined ? PROGRESS_NONE : clampInt(scene.progress, 0, 100),
    scene.accent === undefined ? COLOR_DEFAULT : clampByte(scene.accent),
  ]
}

/** 解 SCENE 载荷（固件自测与主机回读共用）。 */
export function decodeScene(payload: readonly number[]): SceneInput | null {
  if (payload.length < 5) return null
  const state = stateFromCode(payload[0] ?? 0xff)
  if (state === null) return null
  return {
    state,
    flags: payload[1] ?? 0,
    brightness: payload[2] ?? BRIGHTNESS_DEFAULT,
    progress: payload[3] ?? PROGRESS_NONE,
    accent: payload[4] ?? BRIGHTNESS_DEFAULT,
  }
}

/** EFFECT/OVERLAY 帧入参。 */
export interface EffectInput {
  readonly effect: LedEffect
  /** 速度 1..255（越大越快；固件把它映射到自己的动画时钟）。 */
  readonly speed?: number
  readonly brightness?: number
  /** 颜色 RGB888（编码成 RGB332 上线）。 */
  readonly color?: { r: number; g: number; b: number }
  /** 效果相关参数（宽度/密度/次数），缺省 0。 */
  readonly param?: number
}

export function effectPayload(input: EffectInput): number[] {
  const color = input.color ?? { r: 255, g: 255, b: 255 }
  return [
    LED_EFFECT_CODE[input.effect],
    clampInt(input.speed ?? 5, 1, 255),
    input.brightness === undefined ? BRIGHTNESS_DEFAULT : clampBrightness(input.brightness),
    rgbToRgb332(color.r, color.g, color.b),
    clampInt(input.param ?? 0, 0, 255),
  ]
}

/** OVERLAY 帧入参：TTL 让固件自己回落，主机不需要发"撤销"。 */
export interface OverlayInput extends EffectInput {
  /** 存活毫秒（0 = 永久，直到 CLEAR）。 */
  readonly ttlMs?: number
  /** 重复次数（0 = 在 TTL 内循环）。 */
  readonly repeat?: number
}

export function overlayPayload(input: OverlayInput): number[] {
  const base = effectPayload(input)
  const ttl = clampInt(input.ttlMs ?? 3000, 0, 65535)
  return [...base, (ttl >> 8) & 0xff, ttl & 0xff, clampInt(input.repeat ?? 0, 0, 255)]
}

/** CONFIG 帧：小端 u32。 */
export function configPayload(key: number, value: number): number[] {
  const v = Number.isFinite(value) ? Math.trunc(value) >>> 0 : 0
  return [clampByte(key), v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
}

/** 帧类型 → 名字（日志/文档用）。 */
export function frameTypeName(type: number): string {
  for (const [name, code] of Object.entries(FRAME)) if (code === type) return name
  for (const [name, code] of Object.entries(REPLY)) if (code === type) return `reply:${name}`
  return `unknown(0x${clampByte(type).toString(16)})`
}

/** 一帧的可读描述（调试日志/诊断端点用，不做任何副作用）。 */
export function describeFrame(frame: LedFrame): string {
  const name = frameTypeName(frame.type)
  const hex = frame.payload.map((b) => clampByte(b).toString(16).padStart(2, '0')).join(' ')
  if (frame.type === FRAME.SCENE) {
    const scene = decodeScene(frame.payload)
    if (scene) {
      const bits: string[] = []
      if (((scene.flags ?? 0) & SCENE_FLAG.ATTENTION) !== 0) bits.push('attention')
      if (((scene.flags ?? 0) & SCENE_FLAG.MUTED) !== 0) bits.push('muted')
      if (((scene.flags ?? 0) & SCENE_FLAG.NIGHT) !== 0) bits.push('night')
      if (((scene.flags ?? 0) & SCENE_FLAG.TRANSIENT) !== 0) bits.push('transient')
      return `${name} state=${scene.state}${bits.length ? '+' + bits.join('+') : ''} bright=${scene.brightness} progress=${scene.progress}`
    }
  }
  if (frame.type === FRAME.EFFECT || frame.type === FRAME.OVERLAY) {
    const effect = effectFromCode(frame.payload[0] ?? 0xff)
    if (effect) return `${name} effect=${effect} speed=${frame.payload[1]} bright=${frame.payload[2]}`
  }
  return `${name} seq=${frame.seq} [${hex}]`
}

// ── ASCII 兜底 ──────────────────────────────────────────────────────────────
// bring-up 阶段手头只有串口助手时的最小命令集；固件与主机测试共用同一份解析规则。

/** ASCII 状态名（`S:RUN`）。 */
export const ASCII_STATE: Record<string, LedState> = {
  OFF: 'off',
  RUN: 'running',
  WAIT: 'waiting',
  DONE: 'done',
  ERR: 'error',
}

/**
 * 解析一行 ASCII 命令。
 * @returns 语义化的命令对象；不认识的行返回 null（固件忽略但会回一行 `# unknown`）
 */
export function parseAsciiLine(line: string): { cmd: string; args: number[]; state?: LedState } | null {
  const text = line.trim()
  if (text === '' || text.startsWith('#')) return null
  const colon = text.indexOf(':')
  const cmd = (colon < 0 ? text : text.slice(0, colon)).toUpperCase()
  const rest = colon < 0 ? '' : text.slice(colon + 1)
  if (cmd === '?') return { cmd: '?', args: [] }
  const parts = rest.split(',').map((p) => p.trim())
  if (cmd === 'S') {
    const state = ASCII_STATE[parts[0]?.toUpperCase() ?? '']
    return state === undefined ? null : { cmd, args: [], state }
  }
  const args: number[] = []
  for (const part of parts) {
    if (part === '') continue
    const n = Number(part)
    if (!Number.isFinite(n)) return null
    args.push(Math.trunc(n))
  }
  if (cmd === 'B' || cmd === 'P' || cmd === 'A' || cmd === 'E' || cmd === 'C') return { cmd, args }
  return null
}
