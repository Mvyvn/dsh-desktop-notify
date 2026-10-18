// 主机端渲染器 —— 语义画面 + 时间 → 7 颗 WS2812B 的像素
//
// 为什么动画在主机：真固件（AI_Status_Lights）只有"设 7 颗灯颜色"和"蜂鸣"两条命令，
// 没有任何本地动画/亮度/覆盖层概念。所以主机每帧算好像素再推（26 字节，30fps ≈ 780 B/s，
// 115200 只占 ~7%）。好处是改个动画不用重烧固件；代价是主机卡顿时灯会顿一下
// （串口链路层做了"帧没变就不发"和断线重连，卡顿不会累积）。
//
// 纯函数：同样的 (画面, 时刻) 一定得到同样的像素 —— 单测直接按时刻断言。

import { LED_COUNT, scaleColor, type Pixels, type Rgb } from './led-protocol.js'
import { SCENE_FLAG, type LedScene } from './led-scene.js'

/** 语义状态的主色（RGB）。 */
export const STATE_COLOR: Record<LedScene['state'], Rgb> = {
  running: { r: 0xc8, g: 0xd2, b: 0xe0 },   // 冷白：在干活
  waiting: { r: 0xff, g: 0xa0, b: 0x00 },   // 琥珀：等你
  done: { r: 0x00, g: 0xc8, b: 0x53 },      // 绿：完成
  error: { r: 0xff, g: 0x17, b: 0x44 },     // 红：异常
  off: { r: 0, g: 0, b: 0 },
}

/** 运行中的"彗星"速度（毫秒/灯位）。 */
const COMET_MS_PER_LED = 220
/** 提醒（自上次聚焦未回来）时的双闪周期。 */
const ALERT_PERIOD_MS = 1600
const ALERT_ON_MS = 110
const ALERT_GAP_MS = 110

const BLACK: Rgb = { r: 0, g: 0, b: 0 }

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/** 把 0..1 的强度乘到颜色上（再交给上层统一乘亮度）。 */
function dim(color: Rgb, k: number): Rgb {
  const f = clamp01(k)
  return {
    r: Math.round(color.r * f),
    g: Math.round(color.g * f),
    b: Math.round(color.b * f),
  }
}

/** 提醒包络：周期内两个 110ms 的亮块（"滴滴"两下的视觉效果）。 */
export function alertEnvelope(nowMs: number): number {
  const t = ((nowMs % ALERT_PERIOD_MS) + ALERT_PERIOD_MS) % ALERT_PERIOD_MS
  if (t < ALERT_ON_MS) return 1
  if (t < ALERT_ON_MS + ALERT_GAP_MS) return 0
  const t2 = t - (ALERT_ON_MS + ALERT_GAP_MS)
  if (t2 < ALERT_ON_MS) return 1
  return 0
}

/** 平滑呼吸：0..1（周期 2.4s）。 */
function breathe(nowMs: number, periodMs = 2400): number {
  const phase = (nowMs % periodMs) / periodMs
  return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2)   // 0 → 1 → 0
}

/**
 * 渲染一帧像素。
 * @param scene 语义画面（judge 产出）
 * @param nowMs 单调时钟（毫秒）
 */
export function renderPixels(scene: LedScene, nowMs: number): Pixels {
  const base = STATE_COLOR[scene.state] ?? BLACK
  const brightness = scene.state === 'off' ? 0 : scene.brightness
  if (brightness <= 0) return Array.from({ length: LED_COUNT }, () => BLACK)

  // 夜间再暗一档
  const nightK = (scene.flags & SCENE_FLAG.NIGHT) !== 0 ? 0.5 : 1
  const level = Math.round(brightness * nightK)
  const alerting = (scene.flags & SCENE_FLAG.ATTENTION) !== 0
  const muted = (scene.flags & SCENE_FLAG.MUTED) !== 0
  const out: Rgb[] = []

  switch (scene.state) {
    case 'running': {
      // 白色彗星来回跑：位置走乒乓，亮度沿"头亮尾暗"衰减。
      const span = (LED_COUNT - 1) * 2
      const pos = ((nowMs / COMET_MS_PER_LED) % span + span) % span
      const head = pos <= LED_COUNT - 1 ? pos : span - pos
      // 提醒期间：整条带子额外叠一个 25% 的底，跟着双闪走
      const floor = alerting ? 0.25 * alertEnvelope(nowMs) : 0.06
      for (let i = 0; i < LED_COUNT; i += 1) {
        const k = Math.max(floor, Math.max(0, 1 - Math.abs(i - head) / 2))
        out.push(scaleColor(dim(base, k), level))
      }
      break
    }
    case 'waiting': {
      // 琥珀呼吸；提醒时叠双闪（呼吸 × 双闪取较亮者）
      const k = muted ? 0.7 : Math.max(0.35, breathe(nowMs))
      const flash = alerting ? alertEnvelope(nowMs) : 0
      const finalK = Math.max(k, flash)
      for (let i = 0; i < LED_COUNT; i += 1) out.push(scaleColor(dim(base, finalK), level))
      break
    }
    case 'done': {
      // 绿：安静时轻呼吸；提醒时双闪；已看过（MUTED）就常亮暗绿
      const flash = alerting ? alertEnvelope(nowMs) : 0
      const k = alerting ? Math.max(0.3, flash) : (muted ? 0.8 : Math.max(0.45, breathe(nowMs, 3600)))
      for (let i = 0; i < LED_COUNT; i += 1) out.push(scaleColor(dim(base, k), level))
      break
    }
    case 'error': {
      // 红：2Hz 硬闪；提醒时叠双闪（更急）
      const blink = ((nowMs % 500) / 500) < 0.6 ? 1 : 0.12
      const flash = alerting ? alertEnvelope(nowMs) : 0
      const k = alerting ? Math.max(blink, flash) : blink
      for (let i = 0; i < LED_COUNT; i += 1) out.push(scaleColor(dim(base, k), level))
      break
    }
    default:
      for (let i = 0; i < LED_COUNT; i += 1) out.push(BLACK)
      break
  }
  return out
}
