/**
 * 插件配置模式（schemastery）——设置页由它生成，字段顺序就是用户看到的顺序。
 *
 * **volatile 规则**（`@deepseek-ai/schemastery` 的 `validateVolatileSchema`）：
 * volatile 字段不能嵌在另一个 volatile 里，数组元素也不能是 volatile。
 * 因此"可编辑列表"按官方发布的写法：**整个数组 volatile，元素模式保持普通**
 * （同 `llm-deepseek` 的 `models: z.array(catalogModel).volatile()`）。
 * 只有 volatile 字段会被投影成可编辑表单（settings 服务）。
 *
 * @module dsh-desktop-notify/config
 */
import z from '@deepseek-ai/schemastery'

/** 可单独开关的预设推送（一个字面量数组，客户端与服务端共用同一份真源）。 */
export const NOTIFY_KINDS = [
  'task',        // ✅ DSH 任务完成
  'ask',         // ❓ DSH 等待你的输入
  'denied',      // 🚫 DSH 操作被自动拒绝
  'subagent',    // 🤖 DSH 后台子代理结束
  'goal',        // 🎯 DSH 目标已完成 / 已阻塞
  'jobs',        // 🧰 DSH 后台任务结束
  'schedule',    // ⏰ DSH 定时任务已启动
  'team',        // 🕒/✅ DSH 团队任务
  'compaction',  // 🗜️ DSH 上下文已智能压缩
  'startup',     // 🚀 DSH 插件挂载成功 / 异常
  'permission',  // ⚠️ DSH 权限变更
] as const

export type NotifyKind = (typeof NOTIFY_KINDS)[number]

/**
 * 静默模式三档：
 *   session —— 按该通知的**会话**归属静默（默认；看住那个会话就不打扰）
 *   tab     —— **标签页级**：只要任一 DSH 标签页可见且持有焦点（浏览器原生的
 *              `document.hasFocus()` + `visibilityState`，由页面事件即时上报），就静默。
 *              这是"看着 DSH 就别弹"的粗档，比 session 更安静。
 *   never   —— 从不静默
 */
export const SILENCE_MODES = ['session', 'tab', 'never'] as const
export type SilenceMode = (typeof SILENCE_MODES)[number]

/** 每种通知的默认值（默认行为 = 加设置页之前的行为，升级不改变体感）。 */
const DEFAULTS: Record<NotifyKind, { enabled: boolean; silence: SilenceMode }> = {
  task: { enabled: true, silence: 'session' },
  ask: { enabled: true, silence: 'session' },
  denied: { enabled: true, silence: 'session' },
  // 子代理与后台任务：调用点给的是「母会话 + 子会话」这一族，看住任一都不打扰
  subagent: { enabled: true, silence: 'session' },
  jobs: { enabled: true, silence: 'session' },
  goal: { enabled: true, silence: 'session' },
  schedule: { enabled: true, silence: 'session' },
  team: { enabled: true, silence: 'session' },
  compaction: { enabled: true, silence: 'session' },
  // 启动播报与权限变更：无会话归属，本来就永不静默
  startup: { enabled: true, silence: 'never' },
  permission: { enabled: true, silence: 'never' },
}

/** 默认列表（同时也是设置页"恢复默认"的参照）。 */
export const DEFAULT_KIND_SETTINGS = NOTIFY_KINDS.map((kind) => ({
  kind,
  enabled: DEFAULTS[kind].enabled,
  silence: DEFAULTS[kind].silence,
}))

export interface KindSetting {
  kind: string
  enabled: boolean
  silence: string
}

export interface NotifyConfig {
  /** 总开关：关闭后本插件不再推送任何通知（含权限变更与启动播报）。 */
  enabled?: boolean
  /** 调试模式：状态日志写入 $DSH_HOME/logs/dsh-desktop-notify/（不再刷终端）。 */
  debug?: boolean
  /** 对外 API 开关：关闭后其它插件拿到的 push/notify 一律返回未入队。 */
  apiEnabled?: boolean
  /** 各预设推送的开关与静默模式。 */
  types?: KindSetting[]
}

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  debug: z.boolean().default(false).volatile(),
  apiEnabled: z.boolean().default(true).volatile(),
  // 整个数组 volatile、元素普通 —— 见文件头的 volatile 规则
  types: z.array(z.object({
    kind: z.string(),
    enabled: z.boolean(),
    silence: z.union([...SILENCE_MODES]),
  })).default(DEFAULT_KIND_SETTINGS).volatile(),
})

/** 把"用户配的列表"补全成"每种通知都有值"的完整视图（缺项回落到默认）。 */
export function resolveKindSettings(configured: unknown): Record<string, { enabled: boolean; silence: SilenceMode }> {
  const out: Record<string, { enabled: boolean; silence: SilenceMode }> = {}
  for (const kind of NOTIFY_KINDS) out[kind] = { ...DEFAULTS[kind] }
  if (Array.isArray(configured)) {
    for (const row of configured) {
      if (!row || typeof row !== 'object') continue
      const entry = row as { kind?: unknown; enabled?: unknown; silence?: unknown }
      const kind = typeof entry.kind === 'string' ? entry.kind : ''
      if (!kind || !(kind in out)) continue
      out[kind] = {
        enabled: entry.enabled === undefined ? out[kind].enabled : entry.enabled === true,
        silence: SILENCE_MODES.includes(entry.silence as SilenceMode)
          ? (entry.silence as SilenceMode)
          : out[kind].silence,
      }
    }
  }
  return out
}
