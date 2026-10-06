// 对外 LED 控制 API —— 本分支专属的「串口控制协议」对外面（严格档）
//
// 其它插件经 `ctx.get('desktopNotify').led` 使用；协议版本与主线通知 API 分开标注，
// 因为**这个分支不并入主线**：
//   · NOTIFY_API_VERSION  → '1.1.0-led.1'（通知 API 的次版本，新增 led 能力）
//   · LED_API_VERSION     → '1.0.0-led.1'（串口控制协议的特殊版本，本分支专属）
//   · LED_WIRE_VERSION    → 1（真正上串口的帧版本，固件在 HELLO_ACK 里回报）
//
// 设计原则与主线一致（见 api.ts 的版本约定）：
//   1. 未知字段一律忽略；非法**取值**一律拒绝并如实回报 reason，不猜意图；
//   2. 结果对象只增不改；
//   3. capabilities 让调用方探测能力，而不是靠版本号猜。
//
// 为什么 API 不直接暴露"写字节"：裸字节会让调用方绕过 LEN/CRC/类型校验，
// 一路把设备写进没人能复现的状态。这里只放行**白名单帧类型**（FRAME 里的那些），
// 而且载荷仍然走同一套 clamp 逻辑（见 frame()）。

import {
  FRAME, LED_EFFECTS, LED_STATES, LED_WIRE_VERSION, LED_EFFECT_CODE,
  clampInt, clampBrightness, encodeFrame, rgbToRgb332,
  scenePayload, effectPayload, overlayPayload, type LedEffect, type LedState,
} from './led-protocol.js'

/** 本分支的串口控制协议版本（与通知 API 版本分开标注）。 */
export const LED_API_VERSION = '1.0.0-led.1'

/** LED 能力清单（只增不减）。 */
export const LED_API_CAPABILITIES: readonly string[] = [
  'led.protocol.v1',   // 线协议 v1
  'led.scene',         // 语义状态帧（绿/红/黄/白）
  'led.effect',        // 显式效果（流动/呼吸/闪烁/彩虹…）
  'led.overlay',       // 带 TTL 的瞬态覆盖层
  'led.brightness',    // 亮度
  'led.progress',      // 进度条（1 字节百分比）
  'led.frame',         // 白名单原始帧
  'led.ack',           // 解除提醒闩
  'led.preview',       // 手动点灯（诊断/bring-up）
  'led.status',        // 链路与判定状态
]

/** 一次 LED 操作的结果。 */
export interface LedOpResult {
  readonly ok: boolean
  /** 是否真的写到了串口（链路没连上时为 false，但 ok 仍为 true——请求本身合法）。 */
  readonly queued: boolean
  /** '' | 'invalid-payload' | 'led-disabled' | 'link-down' | 'unsupported-frame' | 'not-supported' */
  readonly reason: string
  readonly protocolVersion: string
}

/** 控制器端口（由 led-controller 提供；本模块只依赖这个窄接口，便于单测）。 */
export interface LedPort {
  /** 灯带功能是否启用（设置页开关）。 */
  enabled(): boolean
  sendFrame(type: number, payload: readonly number[]): boolean
  acknowledge(): void
  preview(state: LedState, brightness?: number): boolean
  status(): unknown
}

export interface LedApi {
  /** 串口控制协议版本（本分支特殊版本）。 */
  readonly protocolVersion: string
  /** 线协议版本（固件握手用）。 */
  readonly wireVersion: number
  readonly capabilities: readonly string[]
  status(): unknown
  scene(input: unknown): LedOpResult
  effect(input: unknown): LedOpResult
  overlay(input: unknown): LedOpResult
  brightness(level: unknown): LedOpResult
  progress(percent: unknown, color?: unknown): LedOpResult
  clear(): LedOpResult
  frame(input: unknown): LedOpResult
  acknowledge(): LedOpResult
  preview(state: unknown, brightness?: unknown): LedOpResult
}

/** 允许透过 frame() 直发的帧类型（设备→主机 的回包类型一律不放行）。 */
const WRITABLE_FRAMES: readonly number[] = [
  FRAME.HELLO, FRAME.SCENE, FRAME.EFFECT, FRAME.BRIGHT, FRAME.OVERLAY,
  FRAME.PROGRESS, FRAME.CONFIG, FRAME.PING, FRAME.CLEAR, FRAME.PIXELS, FRAME.BYE,
]

function result(ok: boolean, queued: boolean, reason: string): LedOpResult {
  return { ok, queued, reason, protocolVersion: LED_API_VERSION }
}

/** 解析颜色：接受 '#rrggbb' / {r,g,b} / RGB332 数字；非法返回 null。 */
function parseColor(raw: unknown): { r: number; g: number; b: number } | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'object') {
    const c = raw as { r?: unknown; g?: unknown; b?: unknown }
    return {
      r: clampInt(Number(c.r), 0, 255),
      g: clampInt(Number(c.g), 0, 255),
      b: clampInt(Number(c.b), 0, 255),
    }
  }
  if (typeof raw === 'string') {
    const hex = /^#?([0-9a-f]{6})$/i.exec(raw.trim())
    if (!hex || hex[1] === undefined) return null
    const value = parseInt(hex[1], 16)
    return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
  }
  return null
}

function parseState(raw: unknown): LedState | null {
  return typeof raw === 'string' && (LED_STATES as readonly string[]).includes(raw) ? raw as LedState : null
}

function parseEffect(raw: unknown): LedEffect | null {
  return typeof raw === 'string' && (LED_EFFECTS as readonly string[]).includes(raw) ? raw as LedEffect : null
}

/**
 * 建 LED API。
 * @param port 由 led-controller 提供的窄接口
 */
export function createLedApi(port: LedPort): LedApi {
  /** 统一的发送出口：先判启用，再判链路。 */
  const send = (type: number, payload: readonly number[]): LedOpResult => {
    if (!port.enabled()) return result(true, false, 'led-disabled')
    const queued = port.sendFrame(type, payload)
    return result(true, queued, queued ? '' : 'link-down')
  }

  return {
    protocolVersion: LED_API_VERSION,
    wireVersion: LED_WIRE_VERSION,
    capabilities: LED_API_CAPABILITIES,
    status() {
      return port.status()
    },
    scene(input) {
      if (input === null || typeof input !== 'object') return result(false, false, 'invalid-payload')
      const fields = input as Record<string, unknown>
      const state = parseState(fields.state)
      if (state === null) return result(false, false, 'invalid-payload')
      const flags = clampInt(Number(fields.flags ?? 0), 0, 255)
      const brightness = fields.brightness === undefined ? 0xff : clampBrightness(Number(fields.brightness))
      const progress = fields.progress === undefined ? 0xff : clampInt(Number(fields.progress), 0, 100)
      let accent = 0xff
      const color = parseColor(fields.color)
      if (color !== null) accent = rgbToRgb332(color.r, color.g, color.b)
      return send(FRAME.SCENE, scenePayload({ state, flags, brightness, progress, accent }))
    },
    effect(input) {
      if (input === null || typeof input !== 'object') return result(false, false, 'invalid-payload')
      const fields = input as Record<string, unknown>
      const effect = parseEffect(fields.effect)
      if (effect === null) return result(false, false, 'invalid-payload')
      const color = parseColor(fields.color)
      const payload = effectPayload({
        effect,
        speed: fields.speed === undefined ? 5 : clampInt(Number(fields.speed), 1, 255),
        brightness: fields.brightness === undefined ? 0xff : clampBrightness(Number(fields.brightness)),
        param: fields.param === undefined ? 0 : clampInt(Number(fields.param), 0, 255),
        ...(color === null ? {} : { color }),
      })
      return send(FRAME.EFFECT, payload)
    },
    overlay(input) {
      if (input === null || typeof input !== 'object') return result(false, false, 'invalid-payload')
      const fields = input as Record<string, unknown>
      const effect = parseEffect(fields.effect)
      if (effect === null) return result(false, false, 'invalid-payload')
      const color = parseColor(fields.color)
      const payload = overlayPayload({
        effect,
        speed: fields.speed === undefined ? 5 : clampInt(Number(fields.speed), 1, 255),
        brightness: fields.brightness === undefined ? 0xff : clampBrightness(Number(fields.brightness)),
        param: fields.param === undefined ? 0 : clampInt(Number(fields.param), 0, 255),
        ttlMs: fields.ttlMs === undefined ? 3000 : clampInt(Number(fields.ttlMs), 0, 65535),
        repeat: fields.repeat === undefined ? 0 : clampInt(Number(fields.repeat), 0, 255),
        ...(color === null ? {} : { color }),
      })
      return send(FRAME.OVERLAY, payload)
    },
    brightness(level) {
      const value = Number(level)
      if (!Number.isFinite(value)) return result(false, false, 'invalid-payload')
      return send(FRAME.BRIGHT, [clampInt(value, 0, 255)])
    },
    progress(percent, color) {
      const value = Number(percent)
      if (!Number.isFinite(value)) return result(false, false, 'invalid-payload')
      const rgb = parseColor(color) ?? { r: 0, g: 200, b: 255 }
      return send(FRAME.PROGRESS, [clampInt(value, 0, 100), rgbToRgb332(rgb.r, rgb.g, rgb.b), 0xff])
    },
    clear() {
      return send(FRAME.CLEAR, [])
    },
    frame(input) {
      if (input === null || typeof input !== 'object') return result(false, false, 'invalid-payload')
      const fields = input as { type?: unknown; payload?: unknown }
      const type = Number(fields.type)
      if (!Number.isFinite(type) || !WRITABLE_FRAMES.includes(Math.trunc(type))) {
        return result(false, false, 'unsupported-frame')
      }
      // 超长载荷**拒绝**而不是截断：悄悄砍掉调用方的字节会改变语义（而且对方看不到）
      const raw = Array.isArray(fields.payload) ? fields.payload : []
      if (raw.length > 32) return result(false, false, 'invalid-payload')
      const payload = raw.map((b) => clampInt(Number(b), 0, 255))
      // 先编一遍帧：载荷超长/类型非法在**这里**就暴露，而不是线上
      try {
        encodeFrame(Math.trunc(type), 0, payload)
      } catch (e) {
        return result(false, false, 'invalid-payload')
      }
      return send(Math.trunc(type), payload)
    },
    acknowledge() {
      port.acknowledge()
      return result(true, true, '')
    },
    preview(state, brightness) {
      const parsed = parseState(state)
      if (parsed === null) return result(false, false, 'invalid-payload')
      if (!port.enabled()) return result(true, false, 'led-disabled')
      const level = brightness === undefined ? undefined : clampBrightness(Number(brightness))
      const queued = level === undefined ? port.preview(parsed) : port.preview(parsed, level)
      return result(true, queued, queued ? '' : 'link-down')
    },
  }
}

/** 便捷查询：某个效果名是否被本版本支持（调用方探测用）。 */
export function ledSupportsEffect(name: string): boolean {
  return typeof name === 'string' && name in LED_EFFECT_CODE
}
