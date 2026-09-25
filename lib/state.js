// DSH 桌面通知 — 有界容器与去重（纯逻辑，便于单测）
//
// 常驻宿主里所有"按会话 / 按 id"的缓存都必须有上限：会话可能成百上千地开，
// 而插件只在会话完成时消费一次条目——没有上限就是稳定的内存增长。
// 另外通知本身要去重：同一条文案在极短时间内重复触发（事件重发、重试）时
// 只弹一次，避免连点式打扰。

/**
 * 建立有界映射：满了先丢最旧的（写入顺序 = 淘汰顺序）。
 * 接口只暴露插件用得到的部分，避免调用方误用无限增长的 API。
 * @param {number} limit 最大条目数（<=0 视为 1）
 * @param {(key: unknown, value: unknown) => void} [onEvict]
 */
export function createBoundedMap(limit, onEvict) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  const map = new Map()
  return {
    get size() { return map.size },
    has(key) { return map.has(key) },
    get(key) { return map.get(key) },
    set(key, value) {
      if (map.has(key)) {
        map.delete(key)          // 重新插入：最近写入的排到最后
      } else if (map.size >= max) {
        const oldest = map.keys().next().value
        const evicted = map.get(oldest)
        map.delete(oldest)
        if (onEvict) onEvict(oldest, evicted)
      }
      map.set(key, value)
      return value
    },
    delete(key) { return map.delete(key) },
    clear() { map.clear() },
    keys() { return map.keys() },
    entries() { return map.entries() },
    [Symbol.iterator]() { return map.entries() },
  }
}

/**
 * 建立去重器：同一个 key 在 windowMs 内只放行一次。
 * @param {number} windowMs 去重窗口
 * @param {number} [limit] 记忆条数上限
 * @returns {(key: string, now: number) => boolean} true = 应当发送
 */
export function createDeduper(windowMs, limit = 16) {
  const seen = createBoundedMap(limit)
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0
  return function shouldSend(key, now) {
    if (window === 0) return true
    const last = seen.get(key)
    if (last !== undefined && now - last < window) return false
    seen.set(key, now)
    return true
  }
}
