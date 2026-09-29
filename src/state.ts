// 有界容器与去重（纯逻辑，便于单测）
//
// 常驻宿主里所有"按会话 / 按 id"的缓存都必须有上限：会话可能成百上千地开，
// 而插件只在会话完成时消费一次条目——没有上限就是稳定的内存增长。
// 另外通知本身要去重：同一条文案在极短时间内重复触发（事件重发、重试）时
// 只弹一次，避免连点式打扰。

/** 有界映射：满了先丢最旧的（写入顺序 = 淘汰顺序）。 */
export interface BoundedMap<K, V> {
  readonly size: number
  has(key: K): boolean
  get(key: K): V | undefined
  set(key: K, value: V): V
  delete(key: K): boolean
  clear(): void
  keys(): IterableIterator<K>
  entries(): IterableIterator<[K, V]>
  [Symbol.iterator](): IterableIterator<[K, V]>
}

/**
 * 建立有界映射。
 * 接口只暴露插件用得到的部分，避免调用方误用无限增长的 API。
 * ⚠️ 注意迭代产出的是 `[key, value]` 条目（没有 `.values()`）——按值使用会静默出错。
 * @param limit 最大条目数（<=0 视为 1）
 */
export function createBoundedMap<K, V>(
  limit: number,
  onEvict?: (key: K, value: V | undefined) => void,
): BoundedMap<K, V> {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  const map = new Map<K, V>()
  return {
    get size(): number { return map.size },
    has(key: K): boolean { return map.has(key) },
    get(key: K): V | undefined { return map.get(key) },
    set(key: K, value: V): V {
      if (map.has(key)) {
        map.delete(key)          // 重新插入：最近写入的排到最后
      } else if (map.size >= max) {
        const oldest = map.keys().next().value as K
        const evicted = map.get(oldest)
        map.delete(oldest)
        if (onEvict) onEvict(oldest, evicted)
      }
      map.set(key, value)
      return value
    },
    delete(key: K): boolean { return map.delete(key) },
    clear(): void { map.clear() },
    keys(): IterableIterator<K> { return map.keys() },
    entries(): IterableIterator<[K, V]> { return map.entries() },
    [Symbol.iterator](): IterableIterator<[K, V]> { return map.entries() },
  }
}

/**
 * 建立去重器：同一个 key 在 windowMs 内只放行一次。
 * @param windowMs 去重窗口
 * @param limit 记忆条数上限
 * @returns true = 应当发送
 */
export function createDeduper(windowMs: number, limit = 16): (key: string, now: number) => boolean {
  const seen = createBoundedMap<string, number>(limit)
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0
  return function shouldSend(key: string, now: number): boolean {
    if (window === 0) return true
    const last = seen.get(key)
    if (last !== undefined && now - last < window) return false
    seen.set(key, now)
    return true
  }
}
