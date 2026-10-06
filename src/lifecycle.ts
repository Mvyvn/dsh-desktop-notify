// 「真完成检查器」—— 判定一个会话到底是不是真的结束了（纯逻辑，无宿主依赖）
//
// ── 为什么需要它 ───────────────────────────────────────────────────────────
// DSH 的 `agent/status = idle` 只表示**这一轮驱动结束**，不等于"会话完成"：
//   · 后台子代理还在跑（AI 在等它回来继续）；
//   · 后台任务（jobs）未结算（status = running / stopping）；
//   · agent 的 inbox 里还压着消息（next-turn / next-step）—— AI **会被再次调起**；
//   · 当前目标（goal）还是 active（既没完成也没暂停），goal-round-driver 还会继续推；
//   · 回合边界还开着（turn/start 之后没有 turn/end）；
//   · 有人正等你回答/审批（userQuestions 投影有 active 项）。
// 这些情况下把灯变成"绿色完成"，人躺床上就会白等一场。所以本模块把上述事实收进
// 一个账本（ledger），再给出**唯一**的判定：running / waiting / done / error。
//
// ── 数据从哪来（宿主接线见 src/index.ts，事实来源均已核对 DSH 0.2.0-rc.2）──
//   · ctx.agents.list() / get()          —— agent.status（'idle'|'running'）、
//                                           session.header.{parentSession,origin} 血缘
//   · ctx.jobs.list(sessionId)           —— 同步！过滤 status running|stopping
//   · ctx.sessionProjections.stateOf()   —— 'turnBoundary'（回合是否开着）、
//                                           'userQuestions'（是否在等用户）、
//                                           'inbox'（待办输入）、'goal'（目标阶段）
//   · ctx.goals.get(agent)               —— GoalView.phase（active|paused|blocked|complete）
//   · 事件流（jobs settled / approval decided / goal changed）—— 异常与阶段变化的即时来源
// 每一项都是**可选能力**：服务没装时对应事实缺省为"没有"，判定退化成只按 agent 状态，
// 而不是整个功能失效（DSH 里 ctx.get('jobs') === undefined 是"没这个能力"，
// 不等于"没有后台任务"——这点必须显式区分，否则会把"没装服务"误判成"已完成"）。
//
// ── 判定优先级（顺序本身就是语义）──────────────────────────────────────────
//   1. 有人在等你（提问/审批）         → waiting
//   2. 刚发生过异常（任务失败/审批被拒）→ error（有保鲜期，过期回到普通判定）
//   3. 还有未结算的工作                 → running（这才是"AI 仍在运行"）
//   4. 目标被阻塞                       → waiting（需要人来解，AI 不会自己继续）
//   5. 目标 active 但没有 agent 在跑    → running（round-driver 会再次调起它）
//   6. 其余                             → done
//
// 纯函数 + 显式账本，是为了能在单测里穷举这些组合（tests/lifecycle.test.mjs）。

import { createBoundedMap } from './state.js'
import type { BoundedMap } from './state.js'

/** 目标阶段词表（与 DSH `GoalPhase` 一一对应：注意是 `complete` 不是 `completed`）。 */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** 一个会话的工作阶段。 */
export type WorkPhase = 'running' | 'waiting' | 'done' | 'error'

/**
 * 一次**快照观测**：宿主在同一个时刻把该会话的所有事实读一遍（全部同步 API），
 * 交给账本判定。用快照而不是"靠事件累加"，是因为 DSH 的这些事实本来就都有同步查询，
 * 事件只用来做即时触发与异常记账 —— 少一份"事件漏了状态就永远错"的隐患。
 */
export interface WorkFacts {
  /** 根 agent（或其后代）是否在跑。 */
  readonly agentRunning: boolean
  /** 活着的子代理数（origin === 'subagent' 且在本会话血缘下）。 */
  readonly liveSubagents: number
  /** 未结算的后台任务数（jobs.list() 里 running|stopping）。 */
  readonly openJobs: number
  /** agent inbox 里压着的消息数：>0 = "还会被再次调起"。 */
  readonly pendingInbox: number
  /** 回合边界是否开着（turnBoundary 投影 openTurnStartSeq != null）。 */
  readonly openTurn: boolean
  /** 正在等你回答/审批的项数（userQuestions 投影 active 项 + 悬置的审批）。 */
  readonly waitingUser: number
  /** 当前目标阶段；null = 无目标（或 goal 能力缺失）。 */
  readonly goalPhase: GoalPhase | null
  /** 未完成待办数：**只进说明文字，不作判定依据**（待办不负责把 AI 再次调起）。 */
  readonly unfinishedTodos: number
}

/** 全空事实（服务缺失时的缺省值，也是"真的什么都没有"的形状）。 */
export function emptyFacts(): WorkFacts {
  return {
    agentRunning: false,
    liveSubagents: 0,
    openJobs: 0,
    pendingInbox: 0,
    openTurn: false,
    waitingUser: 0,
    goalPhase: null,
    unfinishedTodos: 0,
  }
}

/** 判定结果（供 LED 与通知共用）。 */
export interface WorkVerdict {
  readonly sessionId: string
  readonly phase: WorkPhase
  /** "为什么是这个阶段"的人类可读理由（进 /dnotify/status、日志与灯带调试）。 */
  readonly reasons: readonly string[]
  /** 该阶段的起始时刻（阶段不变时保持，用于"亮了多久"与完成去抖）。 */
  readonly since: number
  /** 仍被判定为"运行中"的工作项数量（子代理+未结算任务+待办输入+开着的回合+agent）。 */
  readonly pending: number
  /** 在等人的项数。 */
  readonly waiting: number
}

/** 单个会话的账本条目。 */
export interface WorkEntry {
  sessionId: string
  facts: WorkFacts
  /** 最近一次异常（任务失败/审批被拒/目标阻塞），带保鲜期。 */
  lastError: { at: number; reason: string } | null
  /** 最近一次被更新（用于清理久未出现的会话）。 */
  updatedAt: number
}

export interface LedgerOptions {
  /** 会话条目上限（常驻进程里必须有限）。 */
  readonly maxSessions?: number
  /** 异常保鲜期：超过这个时长没有新异常，判定不再停留在 error。 */
  readonly errorTtlMs?: number
  /** 久未更新的会话条目在 evaluate 时被清理。 */
  readonly staleMs?: number
}

const DEFAULT_MAX_SESSIONS = 64
const DEFAULT_ERROR_TTL_MS = 10 * 60_000
const DEFAULT_STALE_MS = 30 * 60_000

export interface WorkLedger {
  /** 推入一次快照观测（不存在就建档；超过上限时按写入顺序淘汰最旧的）。 */
  observe(sessionId: string, facts: WorkFacts, at: number): void
  /** 记录一次异常（后台任务失败、审批被拒、插件挂载异常…）。 */
  noteError(sessionId: string, reason: string, at: number): void
  /** 清掉异常（例如之后又跑成功了）。 */
  clearError(sessionId: string): void
  /** 判定单个会话。 */
  evaluate(sessionId: string, now: number): WorkVerdict
  /** 判定所有已知会话，按"最需要你看"排序返回（error → waiting → running → done）。 */
  evaluateAll(now: number): WorkVerdict[]
  /** 已知会话 id（诊断用）。 */
  sessions(): string[]
  /** 原始快照（/dnotify/status 用）。 */
  snapshot(now: number): Array<WorkEntry & { verdict: WorkVerdict }>
  /** 手工清空（单测与"清空状态"端点用）。 */
  clear(): void
}

/** 阶段优先级（数字越小越"需要人"）。 */
const PHASE_RANK: Record<WorkPhase, number> = { error: 0, waiting: 1, running: 2, done: 3 }

/**
 * 建账本。所有 Map 都有上限：会话可能成百上千地开，而条目只在会话消失时才回收。
 */
export function createWorkLedger(options: LedgerOptions = {}): WorkLedger {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  const errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const entries: BoundedMap<string, WorkEntry> = createBoundedMap<string, WorkEntry>(maxSessions)
  /** 阶段缓存：只在阶段真正变化时更新 since（"亮了多久"是给人看的）。 */
  const since = new Map<string, { phase: WorkPhase; at: number }>()

  const touch = (sessionId: string, at: number): WorkEntry => {
    const key = String(sessionId)
    let entry = entries.get(key)
    if (entry === undefined) {
      entry = { sessionId: key, facts: emptyFacts(), lastError: null, updatedAt: at }
      entries.set(key, entry)
    }
    entry.updatedAt = at
    return entry
  }

  const prune = (now: number): void => {
    for (const [key, entry] of [...entries]) {
      if (now - entry.updatedAt > staleMs) {
        entries.delete(key)
        since.delete(key)
      }
    }
  }

  const evaluateEntry = (entry: WorkEntry, now: number): WorkVerdict => {
    const f = entry.facts
    const reasons: string[] = []
    const pending =
      (f.agentRunning ? 1 : 0) + f.liveSubagents + f.openJobs + f.pendingInbox + (f.openTurn ? 1 : 0)
    const waiting = f.waitingUser
    const freshError = entry.lastError !== null && now - entry.lastError.at <= errorTtlMs

    let phase: WorkPhase
    if (waiting > 0) {
      phase = 'waiting'
      reasons.push(`等待你的输入/审批 ${waiting} 项`)
    } else if (freshError && entry.lastError !== null) {
      phase = 'error'
      reasons.push(`异常：${entry.lastError.reason}`)
    } else if (pending > 0) {
      phase = 'running'
      // 逐条列明"为什么还在跑"——这是本检查器存在的全部意义
      if (f.agentRunning) reasons.push('agent 正在运行')
      if (f.liveSubagents > 0) reasons.push(`${f.liveSubagents} 个子代理未结束`)
      if (f.openJobs > 0) reasons.push(`${f.openJobs} 个后台任务未结算`)
      if (f.pendingInbox > 0) reasons.push(`inbox 里还有 ${f.pendingInbox} 条待处理输入（会被再次调起）`)
      if (f.openTurn) reasons.push('回合边界仍开着')
    } else if (f.goalPhase === 'blocked') {
      phase = 'waiting'
      reasons.push('目标已阻塞，需要你处理')
    } else if (f.goalPhase === 'active') {
      // 双保险：正常路径下 active 目标会被 round-driver 再次调起，
      // 即使此刻没有任何 agent 在跑，也**不能**判成完成。
      phase = 'running'
      reasons.push('目标仍未完成也未暂停（active），会被再次调起')
    } else {
      phase = 'done'
      if (f.goalPhase === 'complete') reasons.push('目标已完成')
      else if (f.goalPhase === 'paused') reasons.push('目标已暂停')
      else reasons.push('没有未结算的工作')
      if (f.unfinishedTodos > 0) reasons.push(`（另有 ${f.unfinishedTodos} 项待办未勾选，不计入运行判定）`)
    }

    const key = entry.sessionId
    const prev = since.get(key)
    const at = prev === undefined || prev.phase !== phase ? now : prev.at
    since.set(key, { phase, at })
    return { sessionId: key, phase, reasons, since: at, pending, waiting }
  }

  return {
    observe(sessionId, facts, at) {
      const entry = touch(sessionId, at)
      // 只认识已知字段：宿主传进来的对象可能来自 any 边界，逐字段取默认值。
      entry.facts = {
        agentRunning: facts.agentRunning === true,
        liveSubagents: nonNegative(facts.liveSubagents),
        openJobs: nonNegative(facts.openJobs),
        pendingInbox: nonNegative(facts.pendingInbox),
        openTurn: facts.openTurn === true,
        waitingUser: nonNegative(facts.waitingUser),
        goalPhase: normalizeGoalPhase(facts.goalPhase),
        unfinishedTodos: nonNegative(facts.unfinishedTodos),
      }
      // 立刻按新事实刷一次阶段缓存：`since` 要等于"这个阶段**从哪一刻开始**"，
      // 而不是"第一次有人来问是哪一刻"——否则「亮了多久」会随查询时机漂移。
      evaluateEntry(entry, at)
    },
    noteError(sessionId, reason, at) {
      const entry = touch(sessionId, at)
      entry.lastError = { at, reason: String(reason) }
    },
    clearError(sessionId) {
      const entry = entries.get(String(sessionId))
      if (entry) entry.lastError = null
    },
    evaluate(sessionId, now) {
      const entry = entries.get(String(sessionId))
      if (entry === undefined) {
        return { sessionId: String(sessionId), phase: 'done', reasons: ['未知会话'], since: now, pending: 0, waiting: 0 }
      }
      return evaluateEntry(entry, now)
    },
    evaluateAll(now) {
      prune(now)
      const out: WorkVerdict[] = []
      for (const [, entry] of entries) out.push(evaluateEntry(entry, now))
      out.sort((a, b) => {
        const rank = PHASE_RANK[a.phase] - PHASE_RANK[b.phase]
        if (rank !== 0) return rank
        // 同阶段：等得越久越靠前（先发生的先提醒）
        return a.since - b.since
      })
      return out
    },
    sessions() {
      return [...entries.keys()]
    },
    snapshot(now) {
      prune(now)
      const out: Array<WorkEntry & { verdict: WorkVerdict }> = []
      for (const [, entry] of entries) {
        out.push({ ...entry, verdict: evaluateEntry(entry, now) })
      }
      return out
    },
    clear() {
      entries.clear()
      since.clear()
    },
  }
}

function nonNegative(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.trunc(n)
}

function normalizeGoalPhase(value: unknown): GoalPhase | null {
  return value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete' ? value : null
}

/**
 * 把多条 verdict 收敛成"灯该显示什么"。
 * 规则：error > waiting > running > done（见 PHASE_RANK），同阶段取等待最久的。
 * @returns undefined 表示没有任何会话（灯应当熄灭）
 */
export function aggregateVerdict(verdicts: readonly WorkVerdict[]): WorkVerdict | undefined {
  let best: WorkVerdict | undefined
  for (const v of verdicts) {
    if (best === undefined) { best = v; continue }
    const rank = PHASE_RANK[v.phase] - PHASE_RANK[best.phase]
    if (rank < 0 || (rank === 0 && v.since < best.since)) best = v
  }
  return best
}

/** 阶段 → 一句中文说明（日志/诊断端点用）。 */
export function phaseLabel(phase: WorkPhase): string {
  switch (phase) {
    case 'running': return '运行中'
    case 'waiting': return '等待你'
    case 'done': return '已完成'
    case 'error': return '异常'
  }
}
