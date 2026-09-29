// 页面注册表 — DSH 页面（标签页）的存在性 / 聚焦 / 序号状态机
//
// 解决的问题（review 第 4、6、10 条）：
//   · 原来只有一个 `lastFocusedPageId`：失焦不清、语义变成"历史上最后一次聚焦过的页面"，
//     而且无法区分"页面存在"与"SSE 可用"；多次 focus/blur 的 HTTP 到达乱序还会互相覆盖。
//   · 现在每个页面一条记录：focused（**当前**是否聚焦）、seq（页面自增序号，只接受更新的）、
//     streams（该页面活跃的 SSE 连接数，>0 才算"可投递"）、lastSeen。
//
// 两种"选页"语义是分开的，这一点很关键：
//   focusedLive()      —— **此刻**聚焦且有连接：用户在页面上操作时点通知，走它；
//   lastFocusedLive()  —— 曾经聚焦且仍有连接：用户切去别的应用（浏览器不在前台）时走它。
// 都没有 → 说明没有可投递的 DSH 页面 → 由 activation 层决定"新开"。
//
// 连接数用计数而不是布尔：页面刷新时"新连接建立"与"旧连接关闭"的先后顺序不确定，
// 布尔值会被旧连接的关闭覆盖，计数不会。

/** 页面自报的一次状态（HTTP POST /dnotify/page-focus）。 */
export interface PageReport {
  readonly pageId: string
  /**
   * 页面内自增序号：宿主只接受比已记录值更大的，避免 focus/blur 的乱序覆盖。
   * 旧客户端不带这个字段——那就跳过乱序保护（而不是拒收）。
   */
  readonly seq?: number
  readonly focused: boolean
  readonly sessionId?: string | null
}

/** 注册表里的一个页面快照。 */
export interface PageSnapshot {
  readonly pageId: string
  readonly focused: boolean
  readonly sessionId: string | null
  readonly seq: number
  readonly lastSeen: number
  readonly streams: number
}

/** 接受或拒绝一次上报。 */
export type ReportResult = 'accepted' | 'stale'

interface PageRecord {
  pageId: string
  focused: boolean
  sessionId: string | null
  seq: number
  lastSeen: number
  streams: number
}

export interface PageRegistryOptions {
  /** 多久没上报算过期（默认 5 分钟：客户端心跳 60s，留足冗余）。 */
  readonly idleTtlMs?: number
}

const DEFAULT_IDLE_TTL_MS = 300_000

export class PageRegistry {
  readonly #pages = new Map<string, PageRecord>()
  /** 曾经聚焦过的页面 id（"用户在用的那个"），页面消失时才清。 */
  #lastFocusedPageId = ''
  readonly #idleTtlMs: number

  constructor(options: PageRegistryOptions = {}) {
    this.#idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  }

  get size(): number {
    return this.#pages.size
  }

  /**
   * 处理一次页面状态上报。seq 不大于已记录值的一律丢弃（乱序保护）。
   * @returns 'accepted' 生效；'stale' 因序号过旧被忽略
   */
  report(report: PageReport, now: number): ReportResult {
    const existing = this.#pages.get(report.pageId)
    const seq = report.seq
    if (existing !== undefined && seq !== undefined && seq <= existing.seq) return 'stale'
    const record: PageRecord = {
      pageId: report.pageId,
      focused: report.focused,
      sessionId: report.sessionId ?? null,
      seq: seq ?? existing?.seq ?? 0,
      lastSeen: now,
      streams: existing?.streams ?? 0,
    }
    this.#pages.set(report.pageId, record)
    if (report.focused) this.#lastFocusedPageId = report.pageId
    // 失焦就把"当前聚焦"清掉（这正是旧实现漏掉的）；但 #lastFocusedPageId 保留，
    // 因为用户切去别的应用后我们仍要跳到"他最后用的那个 DSH 页面"。
    return 'accepted'
  }

  /** 一条 SSE 连接建立。 */
  attachStream(pageId: string, now: number): void {
    const record = this.#pages.get(pageId)
    if (record === undefined) {
      this.#pages.set(pageId, { pageId, focused: false, sessionId: null, seq: 0, lastSeen: now, streams: 1 })
      return
    }
    record.streams += 1
    record.lastSeen = now
  }

  /** 一条 SSE 连接关闭。 */
  detachStream(pageId: string, now: number): void {
    const record = this.#pages.get(pageId)
    if (record === undefined) return
    record.streams = Math.max(0, record.streams - 1)
    record.lastSeen = now
  }

  /** 清掉长时间没动静的页面（连接早断、也没再上报的）。 */
  prune(now: number): void {
    for (const [pageId, record] of [...this.#pages]) {
      if (record.streams > 0) continue
      if (now - record.lastSeen <= this.#idleTtlMs) continue
      this.#pages.delete(pageId)
      if (this.#lastFocusedPageId === pageId) this.#lastFocusedPageId = ''
    }
  }

  /** 此刻聚焦、且可投递（有活跃连接）的页面；多个时取 lastSeen 最新。 */
  focusedLive(now: number): PageSnapshot | undefined {
    this.prune(now)
    let best: PageRecord | undefined
    for (const record of this.#pages.values()) {
      if (!record.focused || record.streams <= 0) continue
      if (best === undefined || record.lastSeen >= best.lastSeen) best = record
    }
    return best === undefined ? undefined : snapshotOf(best)
  }

  /** 最后聚焦过、且仍可投递的页面（用户此刻在别的应用里）。 */
  lastFocusedLive(now: number): PageSnapshot | undefined {
    this.prune(now)
    if (this.#lastFocusedPageId === '') return undefined
    const record = this.#pages.get(this.#lastFocusedPageId)
    if (record === undefined || record.streams <= 0) return undefined
    return snapshotOf(record)
  }

  /**
   * 最近上报过、但**可能没有连接**的页面：只用于诊断/日志。
   * 决策绝不能用它——存在性不等于可投递性（review 第 6 条）。
   */
  recentPage(now: number): PageSnapshot | undefined {
    this.prune(now)
    let best: PageRecord | undefined
    for (const record of this.#pages.values()) {
      if (best === undefined || record.lastSeen > best.lastSeen) best = record
    }
    return best === undefined ? undefined : snapshotOf(best)
  }

  /** 供日志/测试查看某个页面的原始记录。 */
  get(pageId: string): PageSnapshot | undefined {
    const record = this.#pages.get(pageId)
    return record === undefined ? undefined : snapshotOf(record)
  }

  clear(): void {
    this.#pages.clear()
    this.#lastFocusedPageId = ''
  }

  /** 全部页面的快照（`/dnotify/status` 诊断端点用）。 */
  snapshot(): PageSnapshot[] {
    return [...this.#pages.values()].map(snapshotOf)
  }
}

function snapshotOf(record: PageRecord): PageSnapshot {
  return {
    pageId: record.pageId,
    focused: record.focused,
    sessionId: record.sessionId,
    seq: record.seq,
    lastSeen: record.lastSeen,
    streams: record.streams,
  }
}

/**
 * 选页：优先"此刻聚焦"，其次"最后聚焦过且还在线"。
 * @returns 目标页面；undefined 表示没有可投递的 DSH 页面
 */
export function pickDeliveryPage(registry: PageRegistry, now: number): PageSnapshot | undefined {
  return registry.focusedLive(now) ?? registry.lastFocusedLive(now)
}
