// DSH 桌面通知 — 聚焦门控（纯逻辑，无宿主依赖，便于单测）
//
// 语义：只有"你正在看的那个会话"才静默——浏览器半区为每个页面上报
// {聚焦状态, 当前选中的会话 id}，宿主据此判定某条通知是否该被静默。
//   · 页面聚焦 + 该页面选中的会话 ∈ 通知所属会话 → 静默
//   · 通知未携带会话 id（归属不明）→ 不静默，照常推送
//   · 无聚焦页面 / 聚焦静止超时 → 推送

/** 聚焦"保鲜"时长：聚焦页面超过此时长没有活动上报，视为已失焦（2 分钟）。 */
export const FOCUS_STALE_MS = 120000
/** 页面条目存活时长：超过此时长没有任何上报的页面条目被清理（异常关闭兜底，10 分钟）。 */
export const PAGE_STALE_MS = 600000

/**
 * 归一"通知所属会话"：接受会话对象（取 .id）、字符串 id、或它们的数组。
 * @param {unknown} input
 * @returns {string[]} 去重后的非空字符串 id
 */
export function sessionIdList(input) {
  const out = []
  const push = (v) => {
    if (v === undefined || v === null) return
    if (typeof v === 'object') {
      if (v.id !== undefined && v.id !== null) push(v.id)
      return
    }
    const s = String(v)
    if (s && !out.includes(s)) out.push(s)
  }
  if (Array.isArray(input)) { for (const v of input) push(v) } else push(input)
  return out
}

/**
 * 建立一个按"页面 × 会话"判定的聚焦门控。
 * @param {{focusStaleMs?: number, pageStaleMs?: number}} [options]
 */
export function createFocusGate(options = {}) {
  const focusStaleMs = options.focusStaleMs ?? FOCUS_STALE_MS
  const pageStaleMs = options.pageStaleMs ?? PAGE_STALE_MS
  /** @type {Map<string, {at: number, sessionId: string}>} */
  const pages = new Map()

  /** 记录/更新一个聚焦页面（sessionId 取不到时传空串）。 */
  function setPage(pageId, at, sessionId) {
    pages.set(String(pageId), { at, sessionId: sessionId === undefined || sessionId === null ? '' : String(sessionId) })
  }
  /** 页面失焦/关闭：直接移除条目。 */
  function clearPage(pageId) {
    pages.delete(String(pageId))
  }
  /** 清理长时间无上报的残留条目（页面异常关闭时 pagehide 可能丢失）。 */
  function prune(now) {
    for (const [id, rec] of pages) {
      if (now - rec.at > pageStaleMs) pages.delete(id)
    }
  }
  /**
   * 判定是否静默。
   * @param {string[]} sessionIds 通知所属会话 id（空数组 = 归属不明 → 不静默）
   * @param {number} now 当前时间戳（注入以便测试）
   * @returns {boolean}
   */
  function silenced(sessionIds, now) {
    prune(now)
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return false
    for (const rec of pages.values()) {
      if (now - rec.at >= focusStaleMs) continue
      if (rec.sessionId && sessionIds.includes(rec.sessionId)) return true
    }
    return false
  }

  return {
    setPage,
    clearPage,
    prune,
    silenced,
    /** 当前保留的页面条目数（含已失焦但未过期的"保鲜"条目）。 */
    get size() { return pages.size },
  }
}
