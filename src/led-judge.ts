// 「聚焦提醒判断器」—— 决定灯什么时候该"一直提醒"，什么时候可以安静下来
//
// ── 需求 ───────────────────────────────────────────────────────────────────
// "基于聚焦状态，自上次聚焦后再未回来，则灯会一直处于提醒状态。"
// 提醒是否解除取决于**人有没有回来**，而不是过了多久。钉钉式"弹一下就消失"在这里是错的：
// 人躺床上根本没看屏幕，灯必须一直提醒到人真的回到 DSH 页面。
//
// ── 语义 ───────────────────────────────────────────────────────────────────
//   · 聚焦 = 浏览器半区上报过 `focused`，且在保鲜窗口内（沿用 gate 的 2 分钟）。
//   · 出现"值得看"的结果（done / waiting / error）且**此刻人不在** → 上闩。
//   · 闩只在"人回来"或显式确认（板上没有按键，主机会用诊断端点/UI 按钮）时解除。
//   · 闩生效期间即使 AI 又跑起来，画面也带 ATTENTION：底色说"在干活"，提醒说"上次没看"。
//
// 真固件没有动画能力，所以这里的 flags 只是**语义**；具体怎么闪由 `led-render.ts` 决定。
// 纯状态机（无宿主依赖），单测见 tests/led-judge.test.mjs。

import { SCENE_FLAG, OFF_SCENE, clampBrightness, type LedScene } from './led-scene.js'
import type { WorkPhase, WorkVerdict } from './lifecycle.js'

/** 聚焦保鲜窗口：与 gate.ts 的 FOCUS_STALE_MS 一致（2 分钟）。 */
export const FOCUS_FRESH_MS = 120_000

export interface JudgeConfig {
  /** 提醒闩总开关（设置页的「聚焦跟踪持续提醒」）。 */
  readonly attentionEnabled: boolean
  /** 基础亮度 0..255。 */
  readonly brightness: number
  /** 完成且已看过之后，多久熄灯（毫秒；0 = 永不熄，一直留一点绿）。 */
  readonly idleOffMs: number
  /** 人不在时是否额外加一档亮度（躺床上要能一眼看到）。 */
  readonly boostWhenAway: boolean
}

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  attentionEnabled: true,
  brightness: 160,
  idleOffMs: 120_000,
  boostWhenAway: true,
}

/** 判断"人此刻在不在"的输入。 */
export interface FocusFacts {
  /** 最近一次 focused 上报的时刻（0 = 从未上报过）。 */
  readonly lastFocusedAt: number
  /** 覆盖保鲜窗口（单测用）。 */
  readonly freshMs?: number
}

export interface LedJudge {
  /** 推入一次判定结果（undefined = 当前没有任何会话）。 */
  update(verdict: WorkVerdict | undefined, focus: FocusFacts, now: number): LedScene
  /** 显式确认（诊断端点 / UI 按钮）：解除提醒闩。 */
  acknowledge(now: number): LedScene
  /** 当前闩状态（诊断用）。 */
  readonly latch: { phase: WorkPhase; since: number } | null
  /** 当前画面（不推进状态）。 */
  readonly scene: LedScene
  /** 画面签名：变了才需要重新渲染/写串口。 */
  signature(): string
}

/** 阶段 → 灯的语义状态。 */
function stateOf(phase: WorkPhase): LedScene['state'] {
  switch (phase) {
    case 'running': return 'running'
    case 'waiting': return 'waiting'
    case 'done': return 'done'
    case 'error': return 'error'
  }
}

/** "值得人看一眼"的阶段：只有这三种会上闩。 */
function worthAttention(phase: WorkPhase): boolean {
  return phase === 'done' || phase === 'waiting' || phase === 'error'
}

export function createLedJudge(config: JudgeConfig = DEFAULT_JUDGE_CONFIG): LedJudge {
  const cfg: JudgeConfig = {
    attentionEnabled: config.attentionEnabled,
    brightness: clampBrightness(config.brightness),
    idleOffMs: Math.max(0, Math.trunc(config.idleOffMs) || 0),
    boostWhenAway: config.boostWhenAway,
  }
  let latch: { phase: WorkPhase; since: number } | null = null
  /** 上一次"完成"画面的起始时刻（用于 idleOff 熄灯判定）。 */
  let settledAt = 0
  let current: LedScene = OFF_SCENE

  const focused = (focus: FocusFacts, now: number): boolean => {
    const fresh = focus.freshMs ?? FOCUS_FRESH_MS
    return focus.lastFocusedAt > 0 && now - focus.lastFocusedAt < fresh
  }

  const render = (phase: WorkPhase | null, verdict: WorkVerdict | undefined, focus: FocusFacts, now: number): LedScene => {
    if (phase === null || verdict === undefined) {
      // 没有会话：灯灭。**闩保留**——人还没回来，回来之前不该悄悄把提醒作废。
      return { ...OFF_SCENE, brightness: 0, latched: latch !== null, reason: '没有活跃会话' }
    }
    const here = focused(focus, now)
    if (here) latch = null                                  // 人回来了 → 提醒使命结束
    else if (cfg.attentionEnabled && worthAttention(phase) && latch === null) {
      latch = { phase, since: now }
    }

    const state = stateOf(phase)
    let flags = 0
    let brightness = cfg.brightness
    let reason = verdict.reasons.length > 0 ? verdict.reasons.join('；') : phase

    if (latch !== null) {
      flags |= SCENE_FLAG.ATTENTION
      if (cfg.boostWhenAway) brightness = clampBrightness(brightness + 48)
      reason = `提醒中（自上次聚焦未回来）：${reason}`
      settledAt = 0            // 提醒期间不计熄灯倒计时：人没回来就不该熄
    } else if (phase === 'done') {
      flags |= SCENE_FLAG.MUTED
      brightness = clampBrightness(Math.round(brightness * 0.65))
      if (settledAt === 0) settledAt = now
      if (cfg.idleOffMs > 0 && now - settledAt >= cfg.idleOffMs) {
        return { state: 'off', flags: 0, brightness: 0, latched: false, reason: '已完成并看过，熄灯' }
      }
    }

    if (phase !== 'done') settledAt = 0
    return { state, flags, brightness, latched: latch !== null, reason }
  }

  return {
    update(verdict, focus, now) {
      const phase = verdict === undefined ? null : verdict.phase
      current = render(phase, verdict, focus, now)
      return current
    },
    acknowledge(now) {
      latch = null
      if (current.state === 'done') settledAt = now
      current = { ...current, flags: current.flags & ~SCENE_FLAG.ATTENTION, latched: false, reason: '已确认' }
      return current
    },
    get latch() { return latch },
    get scene() { return current },
    signature() {
      return `${current.state}|${current.flags}|${current.brightness}`
    },
  }
}
