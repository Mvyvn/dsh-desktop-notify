// LED 控制器 —— 把 DSH 的运行时事实变成串口帧（平台胶合层）
//
// 分工：
//   · lifecycle.ts   纯逻辑：事实 → running / waiting / done / error
//   · led-judge.ts   纯逻辑：判定 + 聚焦事实 → 画面（含"人没回来就一直提醒"的闩）
//   · serial-link.ts 纯逻辑：画面 → 去重/心跳/重连 → 串口字节
//   · **本文件**只做两件事：从 ctx 上把事实读出来、把上面三层串起来。
//
// 事实来源（全部已核对 DSH 0.2.0-rc.2 源码，见各处 file:line）：
//   ctx.agents.list()/get()          agent.status、session.header.{parentSession,origin}
//   ctx.jobs.list(sessionId)         **同步**；status: running|stopping 即"未结算"
//   ctx.sessionProjections.stateOf() 'turnBoundary' / 'userQuestions' / 'inbox' / 'todos'
//   ctx.goals.get(agent)             GoalView.phase（⚠️ 收的是 Agent，不是 sessionId）
//
// ⚠️ 一条铁律：`ctx.get('xxx') === undefined` 是"**没装这个能力**"，不是"没有活动"。
// 所以每个来源都要显式判空，判定层要知道"哪些事实这次根本没读到"——
// 否则服务缺失会被静默当成"已完成"，那比不做还糟。

import {
  createWorkLedger, aggregateVerdict, emptyFacts,
  type WorkFacts, type WorkVerdict, type GoalPhase,
} from './lifecycle.js'
import { createLedJudge, describeScene, type LedScene } from './led-judge.js'
import { createSerialLink, isValidPortName, type LinkHandle, type LinkPortInfo, type LinkStatus } from './serial-link.js'
import { FRAME, LED_STATE_CODE, PROGRESS_NONE, encodeFrame, clampBrightness, type LedState } from './led-protocol.js'

/** 控制器运行时配置（每次采样现读，设置页改了立刻生效）。 */
export interface LedRuntimeConfig {
  readonly enabled: boolean
  readonly port: string
  readonly baud: number
  readonly brightness: number
  readonly attention: boolean
  readonly idleOffMs: number
}

export const DEFAULT_LED_CONFIG: LedRuntimeConfig = {
  enabled: false,
  port: 'auto',
  baud: 115200,
  brightness: 160,
  attention: true,
  idleOffMs: 120_000,
}

export interface LedControllerOptions {
  readonly ctx: any
  readonly config: () => LedRuntimeConfig
  readonly log: (line: string) => void
  /** 最近一次"页面聚焦"上报的时刻（0 = 从未）。 */
  readonly lastFocusedAt: () => number
  /** 该会话当前悬置的审批数（审批没有宿主查询 API，只能靠事件配对记账）。 */
  readonly pendingApprovals?: (sessionId: string) => number
  /** 注入点：默认走 serial-port.ts（按平台动态加载）。 */
  readonly open?: (port: string, baud: number) => Promise<LinkHandle>
  readonly list?: () => Promise<LinkPortInfo[]>
  readonly now?: () => number
  /** 采样周期（毫秒）。500ms 足够跟手，也不会给宿主添负担。 */
  readonly tickMs?: number
}

export interface LedStatus {
  readonly enabled: boolean
  /** 'ok' | 'disabled' | 'no-agents-service' | 'no-session' */
  readonly reason: string
  readonly port: string
  readonly baud: number
  readonly scene: LedScene
  readonly sceneText: string
  readonly link: LinkStatus
  /** 每个会话的判定（按"最需要你看"排序）。 */
  readonly verdicts: WorkVerdict[]
  /** 设备端能力（HELLO_ACK 回报；没握手成功时 null）。 */
  readonly device: LinkStatus['device']
  /** 距离上次"页面聚焦"上报过了多久（-1 = 从未上报过）。 */
  readonly focusedAgoMs: number
}

export interface LedController {
  start(): void
  stop(): void
  /** 立刻重算并推帧（事件驱动用；tick 也会算，不是必须）。 */
  refresh(): void
  status(): LedStatus
  /** 解除提醒闩（板上按键 / 诊断端点 / UI 按钮）。 */
  acknowledge(): void
  /** 记一笔异常（后台任务失败、审批被拒…）——下一次判定进入 error。 */
  noteError(sessionId: string, reason: string): void
  /** 直发一帧（对外 API 的"串口控制协议"出口）。 */
  sendFrame(type: number, payload: readonly number[]): boolean
  /** 手动点灯（不经过判定；诊断与 bring-up 联调用）。 */
  preview(state: LedState, brightness?: number): boolean
}

/** 沿 `session.header.parentSession` 往上回溯到根会话 id（有环保护）。 */
export function rootOf(ctx: any, sessionId: string): string {
  try {
    const sessions = ctx.get('sessions')
    if (!sessions || typeof sessions.get !== 'function') return sessionId
    let current = sessions.get(sessionId)
    const seen = new Set<string>()
    for (let depth = 0; depth < 32 && current; depth += 1) {
      const id = String(current.id ?? '')
      if (id === '' || seen.has(id)) break
      seen.add(id)
      const parent = current.header && current.header.parentSession
      if (!parent) return id
      const next = typeof parent === 'string' ? sessions.get(parent) : parent
      if (!next) return id
      current = next
    }
    return sessionId
  } catch (e) {
    return sessionId
  }
}

/** 子代理判定：官方做法（packages/subagent/subagent/src/archive-admission.ts:49-71）。 */
function isSubagentAgent(agent: any): boolean {
  const header = agent && agent.session && agent.session.header
  return !!(header && header.origin === 'subagent' && header.parentSession !== undefined)
}

/**
 * 收集一个会话的全部事实。
 * 每步独立 try/catch：某一项服务缺失/报错不能让整次判定崩掉；
 * 缺失项记进 `missing`，最终写进日志（"能力缺失"是排查灯不对的第一线索）。
 */
export function collectFacts(ctx: any, rootSessionId: string, agents: any, missing: Set<string>): WorkFacts {
  const mutable = { ...emptyFacts() } as { -readonly [K in keyof WorkFacts]: WorkFacts[K] }

  // ---- agent 状态 + 血缘 ----
  let rootAgent: any = null
  try {
    rootAgent = agents && typeof agents.get === 'function' ? agents.get(rootSessionId) : null
  } catch (e) { rootAgent = null }
  if (rootAgent && rootAgent.status === 'running') mutable.agentRunning = true

  const lineage = new Set<string>([rootSessionId])
  try {
    const all = typeof agents.list === 'function' ? agents.list() : []
    // 先把子代理按父会话归拢，再从根往下走（多层子代理也只算一次）
    const childrenOf = new Map<string, any[]>()
    for (const agent of all) {
      if (!isSubagentAgent(agent)) continue
      const parent = String(agent.session.header.parentSession)
      const bucket = childrenOf.get(parent)
      if (bucket) bucket.push(agent)
      else childrenOf.set(parent, [agent])
    }
    const queue = [rootSessionId]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const child of childrenOf.get(current) ?? []) {
        const id = String(child.id ?? '')
        if (id === '' || lineage.has(id)) continue
        lineage.add(id)
        queue.push(id)
        // 只算"正在跑"的：agent 从注册表移除才算结束，而 idle 的子代理可能只是等待唤醒
        if (child.status === 'running') mutable.liveSubagents += 1
      }
    }
  } catch (e) { /* 血缘读不到就只按根 agent 判定 */ }

  // ---- 后台任务（同步查询；未结算 = running | stopping）----
  try {
    const jobs = ctx.get('jobs')
    if (jobs && typeof jobs.list === 'function') {
      const list = jobs.list(rootSessionId) || []
      let open = 0
      for (const job of list) {
        const status = String(job && job.status)
        if (status !== 'running' && status !== 'stopping') continue
        const owner = job && job.owner !== undefined && job.owner !== null ? String(job.owner) : ''
        // 无主 job 不归属任何会话：算进去会让所有会话一起变"运行中"，故忽略
        if (owner !== '' && !lineage.has(owner)) continue
        open += 1
      }
      mutable.openJobs = open
    } else {
      missing.add('jobs')
    }
  } catch (e) { missing.add('jobs') }

  // ---- 会话投影：回合边界 / 待办输入 / 提问 / 待办 ----
  try {
    const projections = ctx.get('sessionProjections')
    const sessions = ctx.get('sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(rootSessionId) : undefined
    if (projections && typeof projections.stateOf === 'function' && session) {
      const turn = projections.stateOf(session, 'turnBoundary')
      if (turn && turn.openTurnStartSeq !== null && turn.openTurnStartSeq !== undefined) mutable.openTurn = true

      const inbox = projections.stateOf(session, 'inbox')
      if (inbox && typeof inbox === 'object') {
        const nextTurn = Array.isArray(inbox['next-turn']) ? inbox['next-turn'].length : 0
        const nextStep = Array.isArray(inbox['next-step']) ? inbox['next-step'].length : 0
        mutable.pendingInbox = nextTurn + nextStep
      }

      // 官方唯一有投影的"等用户"信号：userQuestions.active 里 state === 'open'
      const questions = projections.stateOf(session, 'userQuestions')
      const active = questions && questions.questions && Array.isArray(questions.questions.active)
        ? questions.questions.active
        : []
      let openQuestions = 0
      for (const q of active) {
        const state = q && q.state !== undefined ? String(q.state) : 'open'
        if (state === 'open') openQuestions += 1
      }
      mutable.waitingUser = openQuestions

      const todos = projections.stateOf(session, 'todos')
      if (Array.isArray(todos)) {
        mutable.unfinishedTodos = todos.filter((t: any) => t && t.status !== 'completed').length
      }
    } else {
      missing.add('sessionProjections')
    }
  } catch (e) { missing.add('sessionProjections') }

  // ---- 目标阶段 ----
  try {
    const goals = ctx.get('goals')
    if (goals && typeof goals.get === 'function' && rootAgent) {
      // ⚠️ 收 Agent 不是 sessionId；agent 不是 live 时会抛 GOAL_AGENT_NOT_LIVE
      const view = goals.get(rootAgent)
      const phase = view && typeof view.phase === 'string' ? view.phase : ''
      if (phase === 'active' || phase === 'paused' || phase === 'blocked' || phase === 'complete') {
        mutable.goalPhase = phase as GoalPhase
      }
    }
  } catch (e) { /* 没有目标 / agent 已不是 live：都当"没有目标" */ }

  return mutable
}

export function createLedController(options: LedControllerOptions): LedController {
  const { ctx, log } = options
  const now = options.now ?? (() => Date.now())
  const ledger = createWorkLedger()
  let judgeConfigKey = ''
  let judge = createLedJudge()

  const keyOf = (cfg: LedRuntimeConfig): string => [cfg.attention, cfg.brightness, cfg.idleOffMs].join('|')

  const link = createSerialLink({
    port: options.config().port,
    baud: options.config().baud,
    open: options.open ?? (async (port: string, baud: number) => {
      const mod = await import('./serial-port.js')
      return mod.openSerialPort(port, baud)
    }),
    list: options.list ?? (async () => {
      const mod = await import('./serial-port.js')
      return mod.listSerialPorts()
    }),
    now,
    log,
    onEvent: (event) => {
      // 板上按键 = "我知道了"：解除提醒闩（除"人回来了"之外的第二条解除路径）
      if (event.code === 1 /* LED_EVENT.BUTTON_PRESS */) {
        log('[led] 板上按键：解除提醒')
        judge.acknowledge(now())
        refresh()
      }
    },
  })

  let timer: (() => void) | null = null
  let warnedNoAgents = false
  let disabledLogged = false
  let lastSceneSignature = ''
  let lastVerdictCount = -1

  function config(): LedRuntimeConfig {
    try {
      const c = options.config()
      return {
        enabled: c.enabled === true,
        port: typeof c.port === 'string' && c.port.trim() !== '' ? c.port.trim() : 'auto',
        baud: Number.isFinite(c.baud) && c.baud >= 1200 ? Math.trunc(c.baud) : 115200,
        // 显式亮度 0..254：255 是"用设备默认"的哨兵（见 led-protocol.ts 的说明）
        brightness: clampBrightness(Math.trunc(c.brightness)),
        attention: c.attention !== false,
        idleOffMs: Math.max(0, Math.trunc(c.idleOffMs) || 0),
      }
    } catch (e) {
      return DEFAULT_LED_CONFIG
    }
  }

  /** 一次采样：读事实 → 判定 → 画面 → 串口。 */
  function tick(): void {
    const cfg = config()
    link.configure(cfg.port, cfg.baud)          // 端口/波特率改了立刻重连
    const key = keyOf(cfg)
    if (key !== judgeConfigKey) {
      // 判定器持有"提醒闩"状态：只在配置真的变了时重建，避免每次采样把闩清零
      judge = createLedJudge({
        attentionEnabled: cfg.attention,
        brightness: cfg.brightness,
        idleOffMs: cfg.idleOffMs,
        boostWhenAway: true,
      })
      judgeConfigKey = key
    }

    if (!cfg.enabled) {
      if (!disabledLogged) { log('[led] 灯带未启用（设置页可开）'); disabledLogged = true }
      link.close()
      return
    }
    disabledLogged = false

    const agents = ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') {
      // 没有 agents 服务就分不清"在跑"和"跑完了"——宁可不点灯，也不要给错信号
      if (!warnedNoAgents) {
        log('[led] 没有 agents 服务：无法判定运行状态，灯带保持关闭')
        warnedNoAgents = true
      }
      return
    }
    warnedNoAgents = false

    const at = now()
    const missing = new Set<string>()
    let roots: any[] = []
    try {
      roots = typeof agents.roots === 'function' ? agents.roots() : agents.list()
    } catch (e) { roots = [] }

    const sessions = new Set<string>()
    for (const agent of roots) {
      const sessionId = String((agent && agent.session && agent.session.id) ?? (agent && agent.id) ?? '')
      if (sessionId === '') continue
      const rootId = rootOf(ctx, sessionId)
      sessions.add(rootId)
      const facts = collectFacts(ctx, rootId, agents, missing)
      // 悬置的审批由宿主事件配对记账（DSH 没有查询 API）
      if (options.pendingApprovals) {
        const pending = options.pendingApprovals(rootId)
        if (pending > 0) (facts as any).waitingUser = facts.waitingUser + pending
      }
      ledger.observe(rootId, facts, at)
    }

    const verdict = aggregateVerdict(ledger.evaluateAll(at))
    const scene = judge.update(verdict, { lastFocusedAt: options.lastFocusedAt() }, at)
    link.apply(scene)

    const signature = `${LED_STATE_CODE[scene.state]}|${scene.flags}|${scene.brightness}|${scene.progress}`
    if (signature !== lastSceneSignature) {
      lastSceneSignature = signature
      const why = verdict ? verdict.reasons.join('；') : '无会话'
      log(`[led] ${scene.state}${scene.latched ? '（提醒中）' : ''} → ${describeScene(scene)}｜${why}${missing.size > 0 ? `｜能力缺失：${[...missing].join(',')}` : ''}`)
    }
    const count = sessions.size
    if (count !== lastVerdictCount) {
      lastVerdictCount = count
      if (count === 0) log('[led] 当前没有活跃根会话')
    }
    link.tick()
  }

  function refresh(): void {
    try { tick() } catch (e) { log(`[led] 采样失败：${(e as Error).message}`) }
  }

  return {
    start() {
      if (timer) return
      const ms = options.tickMs ?? 500
      // 定时器优先走 cordis 的 timer 服务（插件卸载时随 fiber 自动清理）。
      // 但它**不是所有宿主都有**（嵌入式宿主/测试桩常常只实现 ctx.timeout）：
      // 那种情况下退回进程级 setInterval，并在 stop() 里明确清掉，避免热重载后重复采样。
      const schedule = typeof ctx.interval === 'function'
        ? (cb: () => void, delay: number) => ctx.interval(cb, delay)
        : (cb: () => void, delay: number) => {
          const handle = setInterval(cb, delay)
          if (typeof handle.unref === 'function') handle.unref()
          return () => clearInterval(handle)
        }
      timer = schedule(() => refresh(), ms)
      log(`[led] 控制器已启动（每 ${ms}ms 采样一次）`)
      refresh()
    },
    stop() {
      if (timer) { try { timer() } catch (e) { /* ignore */ } timer = null }
      link.close()
    },
    refresh,
    status() {
      const cfg = config()
      const agents = ctx.get('agents')
      const at = now()
      const verdicts = ledger.evaluateAll(at)
      let reason = 'ok'
      if (!cfg.enabled) reason = 'disabled'
      else if (!agents || typeof agents.list !== 'function') reason = 'no-agents-service'
      else if (verdicts.length === 0) reason = 'no-session'
      const linkStatus = link.status()
      return {
        enabled: cfg.enabled,
        reason,
        port: cfg.port,
        baud: cfg.baud,
        scene: judge.scene,
        sceneText: describeScene(judge.scene),
        link: linkStatus,
        verdicts,
        device: linkStatus.device,
        focusedAgoMs: options.lastFocusedAt() > 0 ? at - options.lastFocusedAt() : -1,
      }
    },
    acknowledge() {
      judge.acknowledge(now())
      refresh()
    },
    noteError(sessionId, reason) {
      const root = rootOf(ctx, String(sessionId))
      ledger.noteError(root, reason, now())
      refresh()
    },
    sendFrame(type, payload) {
      const cfg = config()
      if (!cfg.enabled) return false
      return link.sendFrame(type, payload)
    },
    preview(state, brightness) {
      const cfg = config()
      if (!cfg.enabled) return false
      return link.sendFrame(FRAME.SCENE, [
        LED_STATE_CODE[state],
        0,
        brightness === undefined ? cfg.brightness : clampBrightness(Math.trunc(brightness)),
        PROGRESS_NONE,
        0xff,
      ])
    },
  }
}

/** 校验设置页填进来的端口名（任意字符串不能直接进 CreateFileW）。 */
export function sanitizeLedPort(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (text === '' || text === 'auto') return 'auto'
  return isValidPortName(text) ? text : ''
}

/** 帧编码的再导出：对外 API 要发自定义帧时不必依赖内部路径。 */
export { encodeFrame }
