// 指示灯"画面"模型 —— 判定结果与渲染器之间的那一层（纯类型 + 纯函数）
//
// 为什么单独一个模块：真固件（AI_Status_Lights）只有"设 7 颗灯颜色"和"蜂鸣"两条命令，
// 所以**动画、亮度、提醒包络全部在主机端完成**。这一层是"要显示什么"的语义，
// `led-render.ts` 负责把它变成 7 颗灯的像素，`led-judge.ts` 负责产出它。

/** 语义状态（决定颜色/动画）。 */
export type LedState = 'off' | 'running' | 'waiting' | 'done' | 'error' | 'warn'
export const LED_STATES: readonly LedState[] = ['off', 'running', 'waiting', 'done', 'error', 'warn']

/**
 * 画面标志位。
 * ATTENTION —— "自上次聚焦后再没回来"：固件没有提醒动画，改由主机渲染（呼吸 + 周期双闪）。
 * MUTED     —— 已看过：安静版（不闪）。
 * NIGHT     —— 夜间：整体再暗一档。
 */
export const SCENE_FLAG = {
  ATTENTION: 0x01,
  MUTED: 0x02,
  NIGHT: 0x04,
} as const

/** 亮度上限（主机端乘到每个通道；固件没有亮度命令，所以这里是 0..255 全量程）。 */
export const MAX_BRIGHTNESS = 255

export function clampBrightness(value: number): number {
  if (!Number.isFinite(value)) return 0
  const n = Math.trunc(value)
  if (n < 0) return 0
  if (n > MAX_BRIGHTNESS) return MAX_BRIGHTNESS
  return n
}

/** 一个画面：状态 + 标志 + 亮度（+ 给诊断看的说明）。 */
export interface LedScene {
  readonly state: LedState
  readonly flags: number
  readonly brightness: number
  /** 提醒闩是否生效（诊断用，不参与线协议）。 */
  readonly latched: boolean
  /** 一句话说明为什么是这个画面。 */
  readonly reason: string
}

/** 空画面（关灯）。 */
export const OFF_SCENE: LedScene = {
  state: 'off', flags: 0, brightness: 0, latched: false, reason: '未启用',
}

/** 画面签名：变了才需要重新渲染/写串口。 */
export function sceneSignature(scene: LedScene): string {
  return `${scene.state}|${scene.flags}|${scene.brightness}`
}

/**
 * **会改变像素**的画面签名（链路用来决定"要不要重新起渐变 / 重置动画相位"）。
 *
 * 为什么不能直接用 `state|flags|brightness`：`MUTED` 只在 `waiting` 里影响渲染
 * （停止呼吸）；`running` / `done` / `error` 的渲染**完全忽略** MUTED。
 * 而 MUTED 是随"页面聚焦"变化的——切一次标签页/应用就会 `running → running+muted`。
 * 旧实现把这种"语义变化但画面不变"当成新画面：重置 `sceneSince`（彗星相位回到起点、
 * 逐灯 stagger 重新展开）再叠 250ms 交叉渐变 → 用户看到的就是**切标签页时严重闪烁**。
 * 现在的判据只保留真正影响像素的位（ATTENTION / NIGHT 对所有状态都影响渲染）。
 */
export function sceneVisualKey(scene: LedScene): string {
  const visualFlags = (scene.flags & (SCENE_FLAG.ATTENTION | SCENE_FLAG.NIGHT))
    | (scene.state === 'waiting' ? (scene.flags & SCENE_FLAG.MUTED) : 0)
  return `${scene.state}|${visualFlags}|${scene.brightness}`
}

/** 诊断文本（日志/端点用）。 */
export function describeScene(scene: LedScene): string {
  const bits: string[] = []
  if ((scene.flags & SCENE_FLAG.ATTENTION) !== 0) bits.push('attention')
  if ((scene.flags & SCENE_FLAG.MUTED) !== 0) bits.push('muted')
  if ((scene.flags & SCENE_FLAG.NIGHT) !== 0) bits.push('night')
  return `${scene.state}${bits.length ? '+' + bits.join('+') : ''} bright=${scene.brightness}${scene.latched ? ' [提醒中]' : ''}`
}

/** 语义状态 → 中文短词（UI/日志共用）。 */
export const SCENE_WORD: Record<LedState, string> = {
  running: '运行中', waiting: '等待你', done: '已完成', error: '异常', warn: '警告', off: '熄灭',
}
