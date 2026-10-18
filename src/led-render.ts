// 主机端渲染器 —— 语义画面 + 时间 → 7 颗 WS2812B 的像素
//
// 为什么动画在主机：真固件（AI_Status_Lights）只有"设 7 颗灯颜色"和"蜂鸣"两条命令，
// 没有任何本地动画/亮度/覆盖层概念。所以主机每帧算好像素再推（26 字节，30fps ≈ 780 B/s，
// 115200 只占 ~7%）。好处是改个动画不用重烧固件；代价是主机卡顿时灯会顿一下
// （串口链路层做了"帧没变就不发"和断线重连，卡顿不会累积）。
//
// 纯函数：同样的 (画面, 时刻) 一定得到同样的像素 —— 单测直接按时刻断言。

import { LED_COUNT, clampByte, scaleColor, type Pixels, type Rgb } from './led-protocol.js'
import { SCENE_FLAG, type LedScene } from './led-scene.js'

/** 语义状态的主色（RGB）。 */
export const STATE_COLOR: Record<LedScene['state'], Rgb> = {
  running: { r: 0xc8, g: 0xd2, b: 0xe0 },   // 冷白：在干活
  waiting: { r: 0xff, g: 0xa0, b: 0x00 },   // 琥珀：等你
  done: { r: 0x00, g: 0xc8, b: 0x53 },      // 绿：完成
  error: { r: 0xff, g: 0x00, b: 0x00 },     // **纯红**：之前的 #FF1744 偏粉（看起来像玫红）
  off: { r: 0, g: 0, b: 0 },
}

/** 运行中的"彗星"速度（毫秒/灯位）。 */
const COMET_MS_PER_LED = 170   // 一趟 ≈1.0s；两端减速靠"中间更快"补偿
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
export function breathe(nowMs: number, periodMs = 2400): number {
  const phase = (nowMs % periodMs) / periodMs
  return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2)   // 0 → 1 → 0
}

/** ease-in-out（三次）：渐变的"曲速"感就靠它，线性看起来会发硬。 */
export function smootherstep(k: number): number {
  const t = clamp01(k)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** HSV → RGB（自检彩虹用；h 0..360、s/v 0..1）。 */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hh = ((h % 360) + 360) % 360
  const c = clamp01(v) * clamp01(s)
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = clamp01(v) - c
  let r = 0; let g = 0; let b = 0
  if (hh < 60) { r = c; g = x } else if (hh < 120) { r = x; g = c }
  else if (hh < 180) { g = c; b = x } else if (hh < 240) { g = x; b = c }
  else if (hh < 300) { r = x; b = c } else { r = c; b = x }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }
}

/** 自检动画：先流淌全彩光谱，再定格在结果色（总时长默认 1.1s）。 */
export type SelfTestResult = 'ok' | 'degraded' | 'error'
export const SWEEP_MS = 1333   // 1600 ÷ 1.2：自检彩虹流转速度 ×1.2
export function renderSelfTest(nowMs: number, startedAt: number, result: SelfTestResult, totalMs = 2000, brightness = 255): Pixels {
  const t = Math.max(0, nowMs - startedAt)
  // 自检动画同样受**亮度百分比**控制（与常规画面走同一个 gamma 映射）
  const level = Math.round(255 * Math.pow(clamp01(brightness / 255), 2))
  const color = result === 'ok' ? STATE_COLOR.done : result === 'degraded' ? STATE_COLOR.waiting : STATE_COLOR.error
  const out: Rgb[] = []
  if (t <= SWEEP_MS) {
    const fade = clamp01(t / 100)
    const sweep = t / SWEEP_MS
    for (let i = 0; i < LED_COUNT; i += 1) {
      // 色相 = 位置 + 时间：一条从左往右流淌的彩虹；用满亮度，别被淡入压低
      const hue = (i / LED_COUNT) * 360 + sweep * 720
      out.push(scaleColor(hsvToRgb(hue, 0.95, 1), level))
    }
    void fade
    return out
  }
  if (t >= totalMs) return Array.from({ length: LED_COUNT }, () => BLACK)
  // 结果色**保持到最后一帧**：之前末段自己先淡到黑，交接时看起来"结果色没效果"，
  // 然后真实画面又整段亮起来，像闪了一下。交接收尾交给 link.restartFade()。
  for (let i = 0; i < LED_COUNT; i += 1) out.push(scaleColor(color, level))
  return out
}

export function easeInOut(k: number): number {
  const f = clamp01(k)
  return f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2
}

/**
 * 两帧像素按 k（0=全 a，1=全 b）混合 —— **在 OKLab 里插值**。
 *
 * 为什么不在 sRGB 里直接 lerp：sRGB 的 8 位值不是感知均匀的，红→绿直接平均会经过
 * 一段发灰的浑浊色；OKLab 是感知均匀空间，插值出来的中间色看起来"就是那两个颜色之间的
 * 那个颜色"。对 7 颗灯的交叉渐变，这是观感差别最大的一步。
 */
export function blendPixels(a: Pixels, b: Pixels, k: number): Pixels {
  const f = clamp01(k)
  const out: Rgb[] = []
  for (let i = 0; i < LED_COUNT; i += 1) {
    const pa = a[i] ?? BLACK
    const pb = b[i] ?? BLACK
    if (f <= 0) { out.push({ ...pa }); continue }
    if (f >= 1) { out.push({ ...pb }); continue }
    const ca = srgbToOklab(pa)
    const cb = srgbToOklab(pb)
    const mixed = oklabToSrgb({
      L: ca.L + (cb.L - ca.L) * f,
      a: ca.a + (cb.a - ca.a) * f,
      b: ca.b + (cb.b - ca.b) * f,
    })
    // **逐通道夹在两端点之间**：OKLab 的逆变换会轻微越界，
    // 不夹的话渐变中会出现"比两端都亮"的瞬间（用户看到的就是"亮度先冲高再落下来"）。
    out.push({
      r: clampBetween(mixed.r, pa.r, pb.r),
      g: clampBetween(mixed.g, pa.g, pb.g),
      b: clampBetween(mixed.b, pa.b, pb.b),
    })
  }
  return out
}

interface Oklab { L: number; a: number; b: number }

/** 把 x 夹到 a、b 之间（a/b 无序）。 */
function clampBetween(x: number, a: number, b: number): number {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return Math.max(lo, Math.min(hi, Math.round(x)))
}

const toLinear = (v: number): number => {
  const x = v / 255
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}
const toSrgbByte = (x: number): number => {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}

export function srgbToOklab(c: Rgb): Oklab {
  const r = toLinear(c.r)
  const g = toLinear(c.g)
  const b = toLinear(c.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  }
}

export function oklabToSrgb(c: Oklab): Rgb {
  const l_ = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b
  const m_ = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b
  const s_ = c.L - 0.0894841775 * c.a - 1.2914855480 * c.b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return {
    r: toSrgbByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toSrgbByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toSrgbByte(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  }
}

/** 时间抖动：8 位通道在低亮度只有几个台阶，按帧交替 ±1 LSB 能把"台阶"铺成连续亮度。 */
export function ditherPixels(pixels: Pixels, frame: number): Pixels {
  return pixels.map((px, i) => ({
    r: clampByte(px.r + (((frame + i) % 2 === 0) ? 1 : 0)),
    g: clampByte(px.g + (((frame + i) % 2 === 1) ? 1 : 0)),
    b: clampByte(px.b),
  }))
}

/**
 * 渲染一帧像素。
 * @param scene 语义画面（judge 产出）
 * @param nowMs 单调时钟（毫秒）
 */
export function renderPixels(scene: LedScene, nowMs: number, ageMs = Number.POSITIVE_INFINITY): Pixels {
  const base = STATE_COLOR[scene.state] ?? BLACK
  const brightness = scene.state === 'off' ? 0 : scene.brightness
  if (brightness <= 0) return Array.from({ length: LED_COUNT }, () => BLACK)

  // 夜间再暗一档
  const nightK = (scene.flags & SCENE_FLAG.NIGHT) !== 0 ? 0.5 : 1
  // **亮度做感知（gamma）映射**：线性亮度在低端看起来是"啪一下亮起来"，
  // 加上 gamma≈2 之后 8 位通道的低端台阶被拉开，渐变看起来才顺。
  const linear = clamp01((brightness * nightK) / 255)
  const level = Math.round(255 * Math.pow(linear, 2))
  const alerting = (scene.flags & SCENE_FLAG.ATTENTION) !== 0
  const muted = (scene.flags & SCENE_FLAG.MUTED) !== 0
  const out: Rgb[] = []

  switch (scene.state) {
    case 'running': {
      // 流转（左右往返）—— 三条硬规则，都是踩过的坑：
      //  1) **相位锚定在"这个画面出现多久"**（ageMs），不再用绝对时间：
      //     否则插件启动时相位是随机的，光斑会从**中间**冒出来而不是从左边切入。
      //  2) **不要镜面/环绕补光**：两者都会在端点额外加光，把亮度重心往回拽
      //     （实测表现为"到边缘先回抖一下再折返"）。
      //  3) 光斑近似对称、只带一点点前导：重心基本跟着头部走，折返处不抖。
      const N = LED_COUNT
      const leg = (N - 1) * COMET_MS_PER_LED
      const roundTrip = leg * 2
      const phaseMs = Number.isFinite(ageMs) ? ageMs : nowMs
      const raw = ((phaseMs % roundTrip) + roundTrip) % roundTrip
      const forward = raw < leg
      const p = (forward ? raw : roundTrip - raw) / leg   // 0..1（锚定后从 0 开始）
      const dir = forward ? 1 : -1
      // 两端**减速**、中间加速（速度 = 1 - c·cos(2πp)，端点 1-c、中段 1+c）。
      // 用户要的是"两头慢一点"，于是靠抬高总速度来补偿总时长。
      const END_EASE = 0.3
      const pMove = p - (END_EASE / (Math.PI * 2)) * Math.sin(Math.PI * 2 * p)
      const head = pMove * (N - 1)
      // 不对称性（峰值前移 + 尾巴略长）随 sin(πp) 收敛：**到端点变成对称光斑**。
      // 这是"转向时整条闪一下"的根因 —— dir 翻转会让前后 σ 互换、峰值偏移跳变；
      // 端点对称后，翻转前后的画面完全一致，就不闪了。
      const asym = Math.sin(Math.PI * p)
      const peak = head + dir * 0.3 * asym
      const SIG_AHEAD = 1.0
      const SIG_BEHIND = 1.0 + 0.2 * asym
      const floor = alerting ? 0.18 * alertEnvelope(nowMs) : 0

      const STAGGER_MS = 55
      const RISER_MS = 180
      const reveal = (i: number): number => {
        const local = ageMs - i * STAGGER_MS
        if (!Number.isFinite(local)) return 1
        if (local <= 0) return 0
        return Math.min(1, local / RISER_MS)
      }
      for (let i = 0; i < N; i += 1) {
        const d = (i - peak) * dir
        const sigma = d > 0 ? SIG_AHEAD : SIG_BEHIND
        const k = Math.max(Math.exp(-((d / sigma) ** 2)), floor)
        out.push(scaleColor(dim(base, k * reveal(i)), level))
      }
      break
    }
    case 'waiting': {
      // 琥珀呼吸：**完整正弦**从 0.12 到 1.0。
      // 之前写成 Math.max(0.35, sin) 会把下半周期截成平底 —— 看起来就是"一顿一顿"。
      const wave = breathe(nowMs, 2400)
      // muted（看过了）只是不再脉动，**不降亮度**（和 done/error 保持同一条规则）
      const k = muted ? 1 : 0.12 + 0.88 * wave
      const flash = alerting ? alertEnvelope(nowMs) : 0
      const finalK = Math.max(k, flash)
      for (let i = 0; i < LED_COUNT; i += 1) out.push(scaleColor(dim(base, finalK), level))
      break
    }
    case 'done': {
      // 绿：**常亮**，不做任何呼吸 —— 渐变结束之后亮度就不该再变
      //（之前非 MUTED 时会呼吸，用户看到的是"淡入完成后又变了一下"）。
      // 只有"提醒中"才会周期性双闪，那时是有意为之。
      const flash = alerting ? alertEnvelope(nowMs) : 0
      // 不做任何"自动变暗"：亮度只由配置决定（muted 仅表示"看过了"，不再降档）
      const k = alerting ? Math.max(0.35, flash) : 1
      for (let i = 0; i < LED_COUNT; i += 1) out.push(scaleColor(dim(base, k), level))
      break
    }
    case 'error': {
      // 红：800ms 周期（你的规格）。边缘用 120ms 平滑；**不做时间抖动**（见 link 侧），
      // 抖在低亮度上会变成可见的"沙沙"闪动（慢放看出来的那种抖动）。
      const period = 800
      const onRatio = 0.55
      const e = 120 / 800
      const phase = (nowMs % period) / period
      const blinkOf = (x: number): number => {
        if (x < e) return x / e                        // 升（周期起点）
        if (x < onRatio - e) return 1                   // 亮平台
        if (x < onRatio) return 1 - (x - (onRatio - e)) / e   // 降
        return 0                                        // 其余时间**全灭**（不在末尾再升一次）
      }
      const blink = blinkOf(phase)
      const flash = alerting ? alertEnvelope(nowMs) : 0
      // **按需闪烁**：只有"提醒闩还挂着"（还没被看到）时才闪；
      // 人回来/确认之后转成**常亮红**，一直亮到保鲜期结束 —— 再闪就是骚扰。
      const k = alerting ? Math.max(blink, flash) : 1
      for (let i = 0; i < LED_COUNT; i += 1) out.push(scaleColor(dim(base, k), level))
      break
    }
    default:
      for (let i = 0; i < LED_COUNT; i += 1) out.push(BLACK)
      break
  }
  return out
}
