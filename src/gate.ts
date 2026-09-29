// 聚焦门控 — 纯逻辑状态机（无宿主依赖，便于单测）
//
// 语义：只有"你正在看的那个会话"才静默——浏览器半区为每个页面上报
// {聚焦状态, 当前选中的会话 id}，宿主据此判定某条通知是否该被静默。
//   · 页面聚焦 + 该页面选中的会话 ∈ 通知所属会话 → 静默
//   · 通知未携带会话 id（归属不明）→ 不静默，照常推送
//   · 无聚焦页面 / 聚焦静止超时 → 推送
//
// 注意：门控只决定"要不要弹"，与"点击跳到哪里"完全无关（后者见 protocol.ts / activation.ts）。

/** 聚焦"保鲜"时长：聚焦页面超过此时长没有活动上报，视为已失焦（2 分钟）。 */
export const FOCUS_STALE_MS = 120_000
/** 页面条目存活时长：超过此时长没有任何上报的页面条目被清理（异常关闭兜底，10 分钟）。 */
export const PAGE_STALE_MS = 600_000

interface GatePage {
  at: number
  sessionId: string
}

export interface FocusGate {
  /** 记录/更新一个聚焦页面（sessionId 取不到时传空串）。 */
  setPage(pageId: unknown, at: number, sessionId?: unknown): void
  /** 页面失焦/关闭：直接移除条目。 */
  clearPage(pageId: unknown): void
  /** 清理长时间无上报的残留条目（页面异常关闭时 pagehide 可能丢失）。 */
  prune(now: number): void
  /** 判定是否静默：sessionIds 为空数组 = 归属不明 → 不静默。 */
  silenced(sessionIds: readonly string[], now: number): boolean
  /** 当前保留的页面条目数（含已失焦但未过期的"保鲜"条目）。 */
  readonly size: number
}

/**
 * 归一"通知所属会话"：接受会话对象（取 .id）、字符串 id、或它们的数组。
 * @returns 去重后的非空字符串 id
 */
export function sessionIdList(input: unknown): string[] {
  const out: string[] = []
  const push = (value: unknown): void => {
    if (value === undefined || value === null) return
    if (typeof value === 'object') {
      const id = (value as { id?: unknown }).id
      if (id !== undefined && id !== null) push(id)
      return
    }
    const text = String(value)
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  if (Array.isArray(input)) {
    for (const value of input) push(value)
  } else {
    push(input)
  }
  return out
}

export function createFocusGate(options: { focusStaleMs?: number; pageStaleMs?: number } = {}): FocusGate {
  const focusStaleMs = options.focusStaleMs ?? FOCUS_STALE_MS
  const pageStaleMs = options.pageStaleMs ?? PAGE_STALE_MS
  const pages = new Map<string, GatePage>()

  const setPage = (pageId: unknown, at: number, sessionId?: unknown): void => {
    const key = String(pageId)
    const session = sessionId === undefined || sessionId === null ? '' : String(sessionId)
    pages.set(key, { at, sessionId: session })
  }
  const clearPage = (pageId: unknown): void => {
    pages.delete(String(pageId))
  }
  const prune = (now: number): void => {
    for (const [id, record] of [...pages]) {
      if (now - record.at > pageStaleMs) pages.delete(id)
    }
  }
  const silenced = (sessionIds: readonly string[], now: number): boolean => {
    prune(now)
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return false
    for (const record of pages.values()) {
      if (now - record.at >= focusStaleMs) continue
      if (record.sessionId !== '' && sessionIds.includes(record.sessionId)) return true
    }
    return false
  }

  return {
    setPage,
    clearPage,
    prune,
    silenced,
    get size(): number {
      return pages.size
    },
  }
}
