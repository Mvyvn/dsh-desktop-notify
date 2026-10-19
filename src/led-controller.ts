// LED 控制器 —— 把 DSH 的运行时事实变成串口帧（平台胶合层）
//
// 分工：
//   · lifecycle.ts   纯逻辑：事实 → running / waiting / done / error
//   · led-judge.ts   纯逻辑：判定 + 聚焦事实 → 画面（含"人没回来就一直提醒"的闩）
//   · serial-link.ts 纯逻辑：**一条**串口 → 握手/去重/心跳/重连 → 串口字节
//   · serial-fanout.ts 多灯扇出：auto=同时驱动所有应答的灯，手动端口=只驱动那一块
//   · **本文件**只做两件事：从 ctx 上把事实读出来、把上面几层串起来。
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
import { createLedJudge } from './led-judge.js'
import { createLedRuntimeBridge } from './led-runtime-bridge.js'
import {
  FADE_OUT_MS, type BeepStep, type LedRuntime, type LedRuntimeOptions,
} from './led-runtime.js'
import { isValidPortName, type LinkHandle, type LinkPortInfo, type LinkStatus } from './serial-link.js'
import { SCENE_FLAG, clampBrightness, describeScene, sceneSignature, type LedScene, type LedState } from './led-scene.js'
import type { SelfTestResult } from './led-render.js'
import { BAUD_RATE, LED_COUNT, MODE, encodeBuzzer, encodeFrame, frameBytes, type Beep } from './led-protocol.js'
import { LED_IDLE_FRAME_MS, frameBudget, frameBudgetText, monotonicNow } from './led-timing.js'

/** 控制器运行时配置（每次采样现读，设置页改了立刻生效）。 */
export interface LedRuntimeConfig {
  readonly enabled: boolean
  readonly port: string
  readonly brightness: number
  /** 总开关（插件 enabled）：关掉就是整块插件停用，灯也要灭。 */
  readonly master: boolean
  /** 蜂鸣器开关（硬件支持，可关）。 */
  readonly buzzer: boolean
  readonly attention: boolean
  readonly idleOffMs: number
}

export const DEFAULT_LED_CONFIG: LedRuntimeConfig = {
  enabled: false,
  port: 'auto',
  brightness: 160,
  master: true,
  buzzer: true,
  attention: true,
  idleOffMs: 120_000,
}

export interface LedControllerOptions {
  readonly ctx: any
  readonly config: () => LedRuntimeConfig
  readonly log: (line: string) => void
  /** 标签页级聚焦：任一 DSH 页面可见且持焦点（主门控 focusedLive）。 */
  readonly isFocused: () => boolean
  /** 该会话当前悬置的审批数（审批没有宿主查询 API，只能靠事件配对记账）。 */
  readonly pendingApprovals?: (sessionId: string) => number
  /**
   * 该会话"正在等回答"的提问数（宿主用 tools/execute 钩子配对）。
   * 必须用它而不是 usreQuestions 投影：投影只收录**带 timeout** 的提问。
   */
  readonly pendingAsks?: (sessionId: string) => number
  /**
   * 这个会话是否**干过活**（宿主从 session/event 的 turn/start、tool/call 溯源）。
   * 灯带用它区分"完成"与"空闲"——空闲会话不该点亮绿灯。
   */
  readonly hasWork?: (sessionId: string) => boolean
  /** 注入点：默认走 serial-port.ts（按平台动态加载）。 */
  readonly open?: (port: string, baud: number) => Promise<LinkHandle>
  readonly list?: () => Promise<LinkPortInfo[]>
  readonly now?: () => number
  /** 采样周期（毫秒）。500ms 足够跟手，也不会给宿主添负担。 */
  readonly tickMs?: number
  /**
   * 动画帧周期（毫秒）。**默认 = led-timing.ts 的目标帧率**（240fps → 4.1667ms），
   * 生产环境不要传（传了就有了第二份真相）；只有测试夹具为了确定性才显式指定。
   * 它会被转交给灯运行时（worker 用 workerData.frameMs；inline 用构造参数）。
   */
  readonly frameMs?: number
  /**
   * 帧循环的调度实现（默认 = **进程级 setTimeout**）。
   *
   * ⚠️ 帧调度**绝不能**走宿主的 timer 服务（ctx.timeout）：DSH 的 timer 服务每次调用
   * 都会注册一个 effect，240fps 下等于每秒 240 棵对象树 —— 实测 21 分钟、2.58GB heap
   * snapshot 里留了 318,031 个 Timeout + 319,891 个 Error（≈240/s × 21min），最后把宿主
   * 堆撑爆。帧循环是每 4ms 一次的热路径，只允许用原始 setTimeout。
   * 这个选项只给测试/特殊宿主注入可控调度器用（测试靠它驱动帧）；它随运行时一起生效。
   */
  readonly schedule?: (cb: () => void, delayMs: number) => () => void
  /**
   * 灯运行时工厂（默认 = worker 桥 `createLedRuntimeBridge`）。
   *
   * 单测传 `createLedRuntime`（inline，不 spawn worker）；排障可以用
   * `DSH_LED_RUNTIME=inline` 让默认工厂也走主线程。
   */
  readonly runtimeFactory?: (options: LedRuntimeOptions) => LedRuntime
  /** 蜂鸣器总开关（默认开）。 */
  readonly buzzer?: () => boolean
  /**
   * 允许驱动串口的判定（热重载用）。
   * 这个插件在 HMR 后可能同时存在新旧两个实例，而**串口是独占资源**：
   * 两个实例各开一次 → 后开的那个必然失败并进入重连循环，日志里全是噪声。
   * 所以跟路由/通知一样，只有"接管成功的最新实例"才允许驱动；其余实例的控制器
   * 每次采样直接关掉链路并返回。缺省 = 总是允许（单实例 / 测试）。
   */
  readonly mayRun?: () => boolean
}

export interface LedStatus {
  readonly enabled: boolean
  /** 'ok' | 'disabled' | 'no-agents-service' | 'no-session' */
  readonly reason: string
  readonly port: string
  readonly scene: LedScene
  readonly sceneText: string
  readonly link: LinkStatus
  /**
   * 当前**实际在驱动**的灯数（握手成功的板子数）。auto 模式下 >1 表示多灯同步；
   * 诊断端点/日志用它说明"多灯模式是否真的挂了多块"，而不是只看 port 字符串。
   */
  readonly boards: number
  /** 当前挂着的板子数（含掉线重连中的；>= boards）。 */
  readonly boardCount: number
  /** 每个会话的判定（按"最需要你看"排序）。 */
  readonly verdicts: WorkVerdict[]
  /** 设备端能力（HELLO_ACK 回报；没握手成功时 null）。 */
  readonly device: { leds: number; verified: boolean } | null
  /** 当前是否有人在看页面（主门控 PageRegistry.focusedLive 的结论）。 */
  readonly focused: boolean
  /**
   * 本机**是否存在串口设备**（枚举结果，不代表能打开）。
   * `undefined` = 还没扫过（刚启动那几百毫秒）。
   * 设置页据此判定「未连接」并在未连接时禁用启用开关 —— 所以**即使功能关着也要扫**。
   */
  readonly devicePresent: boolean | undefined
  /** 扫到的端口名（诊断用）。 */
  readonly ports: readonly string[]
  /** 帧循环的**目标 vs 实测**（"写着 240 实际跑 125"就是靠这个露出来的）。 */
  readonly frames: FrameStats
}

/** 帧循环统计：把 `frames.targetFps` 与 `frames.fps` 一比就知道有没有达标。 */
export interface FrameStats {
  readonly targetFps: number
  readonly frameMs: number
  /** 本进程累计渲染的帧数。 */
  readonly rendered: number
  /** 因为回调迟到而**丢弃的欠帧**数（不补跑过期帧）。 */
  readonly skipped: number
  /** 最近 2 秒的实测帧率（窗口还没满时为 0）。 */
  readonly fps: number
  /**
   * 当前是否**空闲低频**节拍。
   * true 时 fps 只有约 1000/idleFrameMs，这是有意为之 —— 状态页/probe 不要把它误读成掉帧；
   * 动画需要连续帧时控制器会自动切回 targetFps。
   */
  readonly idle: boolean
  /** 空闲节拍的帧周期（毫秒）；活跃时 targetFps 仍然是动画节拍。 */
  readonly idleFrameMs: number
  /** 最近 2 秒窗口内单帧的**最大迟到**（ms）—— 卡顿的直接证据。 */
  readonly maxLateMs: number
  /** 最近 2 秒窗口内"渲染 + 写串口"单帧最长耗时（ms）。 */
  readonly frameMaxMs: number
  /** 最近 2 秒窗口内"一次采样"（tick）最长耗时（ms）—— 采样拖慢帧循环时一眼可见。 */
  readonly sampleMaxMs: number
}

export interface LedController {
  start(): void
  stop(): void
  /** 立刻重算并推帧（事件驱动用；tick 也会算，不是必须）。 */
  refresh(): void
  status(): LedStatus
  /** 解除提醒闩（板上按键 / 诊断端点 / UI 按钮）。 */
  acknowledge(): void
  /**
   * 记一笔**黄色警告**（审批被自动拒绝、后台任务失败/被终止）：只亮 1 秒，
   * 与聚焦无关；优先级介于"报错（红）"与"等你（橙）"之间。
   */
  noteWarn(sessionId: string, reason: string): void
  /** 记一笔**绿色完成事件**（后台子代理/团队任务/目标完成）：只亮 2 秒。 */
  noteDone(sessionId: string, reason: string): void
  /** 记一笔异常（目标阻塞…）——下一次判定进入 error。 */
  noteError(sessionId: string, reason: string): void
  /**
   * 控制器启动后的第一次观测里，某会话的目标阶段（active/blocked/complete/paused）；
   * 没有目标 = null。DSH 重启后会补发同一阶段最后一次 goal/changed，
   * 宿主用它区分"残留补发"与"真正的新事件"。
   */
  startupGoalPhase(sessionId: string): string | null
  /** 直发一帧（对外 API 的串口控制协议出口；MODE 必须 0x00/0x01/0x02）。 */
  sendFrame(mode: number, payload: readonly number[]): boolean
  /** 立刻响一声（无源蜂鸣器）。 */
  beep(beep?: Partial<Beep>): boolean
  /** 手动点灯（不经过判定；诊断与 bring-up 联调用）。 */
  preview(state: LedState, brightness?: number): boolean
  /** 点击测试：显示某个状态的画面 + 响对应提示音（不需要先开启指示灯开关）。 */
  test(kind: LedState | 'selftest', ttlMs?: number): boolean
  /**
   * 立刻熄灯（带淡出）。宿主要在**进程退出前同步**调用：
   * 帧循环那时已经停了，异步淡出来不及跑（WS2812 会锁存最后一帧）。
   */
  shutdown(): void
  /** 订阅状态变化（SSE 推送用）：状态签名一变就回调。返回取消订阅。 */
  subscribe(cb: () => void): () => void
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

/** 从 agent 取会话 id（宿主形状 `session.id`，兜底 `agent.id`）。 */
function sessionIdOfAgent(agent: any): string {
  return String((agent && agent.session && agent.session.id) ?? (agent && agent.id) ?? '')
}

/**
 * 一拍的 agent 索引 —— **每拍只调一次 agents.list()**。
 *
 * 为什么需要：旧的 tick() 对**每个根会话**都重新 `agents.list()`（collectFacts 建血缘、
 * 族提问扫描、hasWork 兜底各一次），并对每个会话重新 `rootOf()`，根会话多时是
 * O(roots × agents)。采样就跑在 240fps 的帧循环旁边，采样一慢灯就会顿一下。
 * 现在先建一次索引（会话→根、父→子代理、根→族），三处共用。
 */
export interface AgentIndex {
  /** 本拍 agents.list() 的原始结果（roots() 不可用时当作根列表）。 */
  readonly all: readonly any[]
  /** 会话 id → agent（来自本拍 list；缺失时退回 agents.get）。 */
  get(sessionId: string): any
  /** 父会话 id → 子代理 agent[]（只含 origin=subagent）。 */
  childrenOf(parentSessionId: string): readonly any[]
  /** 根会话 id → 族内全部会话 id（含根；来自本拍 list）。 */
  family(rootSessionId: string): readonly string[]
  /** 会话 id → 根会话 id（本拍内缓存，每个会话只回溯一次）。 */
  rootOf(sessionId: string): string
}

export function buildAgentIndex(ctx: any, agents: any): AgentIndex {
  let all: any[] = []
  try {
    all = agents && typeof agents.list === 'function' ? (agents.list() || []) : []
  } catch (e) { all = [] }

  const byId = new Map<string, any>()
  const children = new Map<string, any[]>()
  const rootCache = new Map<string, string>()
  const families = new Map<string, string[]>()
  const rootOfCached = (sessionId: string): string => {
    const hit = rootCache.get(sessionId)
    if (hit !== undefined) return hit
    const root = rootOf(ctx, sessionId)
    rootCache.set(sessionId, root)
    return root
  }
  for (const agent of all) {
    const sid = sessionIdOfAgent(agent)
    if (sid === '') continue
    byId.set(sid, agent)
    if (isSubagentAgent(agent)) {
      const parent = String(agent.session.header.parentSession)
      const bucket = children.get(parent)
      if (bucket) bucket.push(agent)
      else children.set(parent, [agent])
    }
    const rootId = rootOfCached(sid)
    const family = families.get(rootId)
    if (family) family.push(sid)
    else families.set(rootId, [sid])
  }
  const NO_CHILDREN: readonly any[] = []
  return {
    all,
    get(sessionId: string) {
      const hit = byId.get(sessionId)
      if (hit !== undefined) return hit
      try {
        return agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      } catch (e) { return undefined }
    },
    childrenOf(parent: string) { return children.get(parent) ?? NO_CHILDREN },
    family(rootId: string) {
      const hit = families.get(rootId)
      // 根不在本拍 list 里的极端情况：族里只有它自己（与旧实现的 Set([rootId]) 一致）
      return hit ?? [rootId]
    },
    rootOf(sessionId: string) { return rootCache.get(sessionId) ?? rootOfCached(sessionId) },
  }
}

/**
 * 收集一个会话的全部事实。
 * 每步独立 try/catch：某一项服务缺失/报错不能让整次判定崩掉；
 * 缺失项记进 `missing`，最终写进日志（"能力缺失"是排查灯不对的第一线索）。
 */
/**
 * 读某个会话"未回答的提问数"。
 *
 * 形状有两种（宿主状态 vs wire view，两种都要认）：
 *   · state   ：{ inheritedEventCount, timed, questions: { active, settled } }
 *   · view    ：{ active, settled }
 * 之前只认一种、且读错层级 → 黄灯永不出现。
 * @returns count + shape（shape 只用于日志诊断：top/nested/none/error）
 */
export function openQuestionCount(ctx: any, sessionId: string): { count: number; shape: string } {
  try {
    const projections = ctx.get('sessionProjections')
    const sessions = ctx.get('sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (!projections || typeof projections.stateOf !== 'function' || !session) return { count: 0, shape: 'none' }
    const state: any = projections.stateOf(session, 'userQuestions')
    const top = Array.isArray(state?.active) ? state.active : null
    const nested = Array.isArray(state?.questions?.active) ? state.questions.active : null
    const active = top ?? nested ?? []
    const shape = top !== null ? 'top' : nested !== null ? 'nested' : 'none'
    let count = 0
    for (const q of active) {
      const s = q && q.state !== undefined ? String(q.state) : 'open'
      if (s === 'open' || s === 'continued') count += 1
    }
    return { count, shape }
  } catch (e) {
    return { count: 0, shape: 'error' }
  }
}
export function collectFacts(ctx: any, rootSessionId: string, index: AgentIndex, missing: Set<string>): WorkFacts {
  const mutable = { ...emptyFacts() } as { -readonly [K in keyof WorkFacts]: WorkFacts[K] }

  // ---- agent 状态 + 血缘 ----
  let rootAgent: any = null
  try {
    rootAgent = index.get(rootSessionId)
  } catch (e) { rootAgent = null }
  if (rootAgent && rootAgent.status === 'running') mutable.agentRunning = true

  const lineage = new Set<string>([rootSessionId])
  try {
    // 子代理索引由调用方按"一拍一次"建好：多层子代理也只从根往下走一遍
    const queue = [rootSessionId]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const child of index.childrenOf(current)) {
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

      // 官方"等用户"信号：userQuestions 投影。
      // ⚠️ 形状：stateOf() 给的是**wire view** = { active: [...], settled: [...] }
      //    （active 在顶层！）。老代码读 questions.questions.active → 永远是 0，
      //    所以黄灯从来没亮过。这里两种形状都兼容，防止宿主版本差异再次踩坑。
      const view = projections.stateOf(session, 'userQuestions') as any
      const active: any[] = Array.isArray(view?.active)
        ? view.active
        : Array.isArray(view?.questions?.active)
          ? view.questions.active
          : []
      let openQuestions = 0
      for (const q of active) {
        const state = q && q.state !== undefined ? String(q.state) : 'open'
        // open = 正在等你回答；continued = 超时后仍在等你补答（同样算"等你"）
        if (state === 'open' || state === 'continued') openQuestions += 1
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
  // **单调时钟**：帧节拍用 Date.now() 会被 1ms 量化（4.17ms 的周期直接抖成 4/5ms），
  // 而且系统校时往回跳一下就可能让节拍停住。业务时间戳（日志/落盘）另用 Date.now()。
  const now = options.now ?? monotonicNow
  const ledger = createWorkLedger()
  let judgeConfigKey = ''
  let judge = createLedJudge()

  // 判定器重建条件：只跟"会改变画面"的配置有关。
  // attention 不在里面 —— 它现在恒开（设置页开关已移除），旧配置里的 false 不再生效。
  const keyOf = (cfg: LedRuntimeConfig): string => [cfg.brightness, cfg.idleOffMs].join('|')

  /** 端口枚举（控制器自己只做"有没有设备"探测；串口链路在运行时/worker 里另有发现逻辑）。 */
  const listPorts = options.list ?? (async () => {
    const mod = await import('./serial-port.js')
    return mod.listSerialPorts()
  })

  /**
   * 灯运行时（默认 worker 桥 = `led-runtime-bridge.ts`）。
   *
   * 这一层负责**全部时间驱动逻辑**（串口链路/240fps 帧循环/渲染/自检/熄灯淡出/蜂鸣排队），
   * 与宿主无关，所以能整体跑在独立 worker 里：主线程只剩"采样 → 判定 → 下发画面"。
   * 懒创建：只有真的要碰灯时才建（默认工厂在 worker 模式下也是第一次碰灯时才 spawn 线程）。
   */
  const runtimeFactory = options.runtimeFactory
    ?? ((runtimeOptions: LedRuntimeOptions) => createLedRuntimeBridge(runtimeOptions))
  let runtime: LedRuntime | null = null

  function runtimeOptions(): LedRuntimeOptions {
    const open = options.open ?? (async (port: string, baud: number) => {
      const mod = await import('./serial-port.js')
      return mod.openSerialPort(port, baud)
    })
    const list = options.list ?? (async () => {
      const mod = await import('./serial-port.js')
      return mod.listSerialPorts()
    })
    // 注入点全部原样转交：单测传假串口 + 假时钟/调度器，worker 模式由桥忽略不了的部分
    // 只用于 inline 回退（同一个 LedRuntimeOptions 形状）。
    const base: LedRuntimeOptions = {
      port: config().port,
      baud: BAUD_RATE,
      open,
      list,
      now,
      log,
      ...(options.frameMs !== undefined ? { frameMs: options.frameMs } : {}),
      ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    }
    return base
  }

  function ensureRuntime(): LedRuntime {
    if (runtime === null) runtime = runtimeFactory(runtimeOptions())
    return runtime
  }

  /** 安排脉冲到期：到点立刻清画面并重算（不能等下一次 1.5s 采样）。 */
  function armPulseTimer(ttlMs: number): void {
    if (pulseTimer !== null) { clearTimeout(pulseTimer); pulseTimer = null }
    pulseTimer = setTimeout(() => {
      pulseTimer = null
      pulse = null
      refresh()
    }, Math.max(1, ttlMs + 10))
    if (typeof (pulseTimer as any).unref === 'function') (pulseTimer as any).unref()
  }

  let timer: (() => void) | null = null
  /** 主线程采样耗时统计（2 秒窗口；帧统计在运行时里，这里只补采样这一项）。 */
  let sampleMaxMs = 0
  let winMaxSample = 0
  let sampleWindowAt = 0
  /** 上电自检的截止时刻（控制器侧只记"还在自检窗口内"，动画本身由运行时负责）。 */
  let selfTestUntil = 0
  /** 最近一次响过蜂鸣器的状态（同状态不重复响）。 */
  let lastBeepState: LedScene['state'] | null = null
  /** preview 的手动画面与生效截止时刻（压过判定画面一小段时间）。 */
  let manualScene: LedScene | null = null
  let manualUntil = 0
  /**
   * 瞬态事件画面（黄/绿脉冲）：不进入生命周期账本，只亮固定时长。
   *   · warn：审批被拒 / 后台任务失败 → 1s 常亮黄，**优先级 错误 > 黄 > 其它**；
   *   · done：后台子代理 / 后台任务 / 团队任务 / 目标完成 → 2s 常亮绿（只在 running/off 时覆盖）。
   */
  let pulse: { state: 'warn' | 'done'; reason: string; until: number } | null = null
  /** 脉冲到期定时器：保证"黄灯只亮 1 秒"不依赖下一次采样（采样 1.5s 一拍，会把黄灯拖长）。 */
  let pulseTimer: ReturnType<typeof setTimeout> | null = null
  const WARN_PULSE_MS = 1000
  const DONE_PULSE_MS = 2000
  /**
   * 控制器启动后的第一次观测：session → 当时的目标阶段。
   * DSH 重启后会补发同一阶段最后一次 goal/changed（block/complete），
   * 用这张表识别"残留补发"，不重复弹通知/点灯。阶段变化后条目自动失效。
   */
  const startupGoalPhases = new Map<string, string>()
  /** 启动快照的采集窗口：goal 投影可能比控制器晚一拍就绪，给 10s 收齐。 */
  let startupCollectUntil = 0
  let startupLogged = false
  /** 最近一次真正交给运行时的画面（/dnotify/led 状态端点用它，而不是 judge.scene）。 */
  let lastScene: LedScene | null = null
  /**
   * 最近一次采样的**聚合判定快照**。
   * 状态端点/卡顿哨兵/性能探针都会调 status()；如果每次都 `evaluateAll`（排序 + 遍历
   * 全部会话），在"已经卡顿"的现场再加一次 O(n log n) 只会雪上加霜。采样 1.5s 一次，
   * 状态读取用上一拍的结果完全够用；真正变化仍由 SSE 事件推。
   */
  let lastVerdicts: WorkVerdict[] = []
  /** 蜂鸣器冷却：多会话齐结算时避免连珠炮。 */
  const BEEP_COOLDOWN_MS = 1500
  let lastBeepAt = 0
  /** 异常画面开始时刻（用于 20s 后自动确认）。 */
  let errorSeenAt = 0
  /** 状态变化订阅者（SSE）。 */
  const listeners = new Set<() => void>()
  /** 上一次广播出去的签名（变了才推）。 */
  let lastBroadcast = ''
  /** 上一次采样时链路是否已握手（用来检测"刚连上"这个边界）。 */
  let wasVerified = false
  let warnedNoAgents = false
  let disabledLogged = false
  /**
   * 关闭后是否已经 blackout 过。
   * 关闭态每 1.5s 还会采样一次；没有这个标记会每拍都 `close()` 一次（worker/fanout 反复
   * 收 close 消息），而且"关闭 → 再打开"的边界会变得难以判断。
   */
  let disabledClosed = false
  let lastSceneSignature = ''
  let lastVerdictCount = -1
  /** 端口扫描结果：即使功能关着也扫 —— 设置页要靠它判「未连接」并禁用启用开关。 */
  let devicePresent: boolean | undefined
  let availablePorts: string[] = []
  let lastPortScanAt = 0
  let scanning = false
  let noDeviceLogged = false
  // 扫描只用于"设置页显示有没有设备"这一件事；连接本身是**事件驱动**的
  // （直连上次成功的端口 + 主动探测），所以不需要每秒枚举。
  const PORT_SCAN_MS = 15000

  /** 设置页在轮询状态（说明有人在看这张卡片）→ 允许按需扫一次（节流 1s）。 */
  let onDemandScanAt = 0
  let scanStartedAt = 0
  /**
   * 扫描代次：**超时恢复必须让在飞的那次作废**。
   *
   * 竞态（用户指出）：第 1 次枚举卡住 >5s → 我们强制 `scanning = false` 让第 2 次能跑；
   * 但第 1 次**并没有被取消**，它晚些返回时：
   *   · 会用**过期结果**覆盖 devicePresent/availablePorts（旧结果盖新结果）；
   *   · 它的 `finally` 会把 `scanning` 置 false —— 而那时是**第 2 次**持有互斥，
   *     等于提前放锁，第 3 次就能并发进来。
   * 所以每次扫描领一个代次，回来时对不上就**既不改状态、也不碰锁**。
   */
  let scanGen = 0
  async function scanPorts(): Promise<void> {
    if (scanning) {
      // 枚举卡死兜底：正常几毫秒，超过 5 秒就当它挂了
      if (now() - scanStartedAt > 5000) {
        scanning = false
        scanGen += 1 // 让在飞的那次作废（它的结果与 finally 都将被忽略）
        log('[led] 串口枚举超时，强制恢复（在飞的那次作废）')
      } else return
    }
    const gen = (scanGen += 1)
    scanning = true
    scanStartedAt = now()
    try {
      const list = await listPorts()
      if (gen !== scanGen) return // 已过期的结果：丢弃，绝不覆盖新结果
      devicePresent = list.length > 0
      availablePorts = list.map((p) => p.path)
    } catch (e) {
      // 枚举失败不动上次结论：宁可显示旧状态，也不要因为一次异常就说"没设备"
      if (gen === scanGen) log(`[led] 串口枚举失败：${(e as Error).message}`)
    } finally {
      // 只有"当代"扫描才有资格释放互斥锁
      if (gen === scanGen) scanning = false
    }
  }

  function config(): LedRuntimeConfig {
    try {
      const c = options.config()
      return {
        enabled: c.enabled === true,
        port: typeof c.port === 'string' && c.port.trim() !== '' ? c.port.trim() : 'auto',
        // 亮度现在**纯主机端**（真固件没有亮度命令）：0..255 直接乘到每个通道
        brightness: clampBrightness(Math.trunc(c.brightness)),
        master: c.master !== false,
        buzzer: c.buzzer !== false,
        attention: c.attention !== false,
        idleOffMs: Math.max(0, Math.trunc(c.idleOffMs) || 0),
      }
    } catch (e) {
      return DEFAULT_LED_CONFIG
    }
  }

  /**
   * 按需扫描（给"设置页打开着"这种明确需要设备状态的场景用）。
   * 节流 1s：页面每秒轮询一次状态，不能每次都真的去枚举。
   */
  function scanIfStale(maxAgeMs: number): void {
    const at = now()
    if (onDemandScanAt !== 0 && at - onDemandScanAt < 1000) return
    if (devicePresent !== undefined && at - lastPortScanAt < maxAgeMs) return
    onDemandScanAt = at
    lastPortScanAt = at
    void scanPorts()
  }

  /**
   * 熄灯。
   *
   * ⚠️ WS2812B **会锁存最后一帧**：只是关掉串口，灯会一直亮在最后那个颜色上。
   * 所以"关闭开关"必须显式发一帧全黑再关串口 —— 否则用户看到的就是
   * "开关关了灯还亮着"。（这也是本文件里唯一"关灯"的正路。）
   */
  function blackout(rt: LedRuntime): void {
    try {
      if (rt.status().link.verified) {
        rt.flush({ state: 'off', flags: 0, brightness: 0, latched: false, reason: '关闭' })
      }
    } catch (e) { /* 串口已经拔了就算了 */ }
    rt.close()
  }

  /** 一次采样：读事实 → 判定 → 画面 → 交由运行时（worker）渲染。 */
  function tick(): void {
    const cfg = config()
    const at = now()
    const rt = ensureRuntime()
    rt.configure(cfg.port, BAUD_RATE)   // 固件固定 115200，不给用户调；端口改了运行时会重连
    // 串口探测**先于**启用判定：功能关着也要知道本机有没有设备（设置页靠它判「未连接」）。
    // 但**已握手成功时直接跳过**：设备显然在，枚举没有信息量（也省掉和设备栈打交道的机会）。
    const connectedNow = rt.status().link.verified === true
    if (!connectedNow && (lastPortScanAt === 0 || at - lastPortScanAt >= PORT_SCAN_MS)) {
      lastPortScanAt = at
      void scanPorts()
    }
    const key = keyOf(cfg)
    if (key !== judgeConfigKey) {
      // 判定器持有"提醒闩"状态：只在配置真的变了时重建，避免每次采样把闩清零
      judge = createLedJudge({
        // **恒开**：设置页的「聚焦跟踪持续提醒」开关已被移除（该能力常驻）。
        // cfg.attention 字段保留只为兼容旧版本保存的配置，不再参与判定。
        attentionEnabled: true,
        brightness: cfg.brightness,
        // 熄灯延时**硬编码**（设置页不再暴露）：完成且已看过 120s 后熄灯
        idleOffMs: 2_000,
        boostWhenAway: true,
        maxBrightness: cfg.brightness,
      })
      judgeConfigKey = key
    }

    if (!cfg.enabled || !cfg.master) {
      // 功能关着：帧循环不再驱动链路 —— 否则 fanout 会自己重连（关掉的灯反复开串口）
      rt.setDriving(false)
      if (!disabledLogged) {
        log(cfg.master ? '[led] 灯带未启用（设置页可开）' : '[led] 总开关关闭：灯带一并熄灭')
        disabledLogged = true
      }
      // 关掉后链路已经 close：重新打开时必须按"新连接"处理（重握手 → 自检）。
      wasVerified = false
      // 关闭态也要**广播状态**：这条路径是提前 return 的，不广播的话设置页的 SSE
      // 永远收不到 reason=disabled，会一直显示"运行中"（用户报告的 bug）。
      if (disabledClosed) {
        broadcastStatus(rt, cfg)
        return
      }
      // 关灯也要"曲速渐变"：交给运行时做淡出（250ms），淡完自动发全黑帧并关串口。
      // 没连上/已经在淡出 → 直接走 blackout 兜底（不能卡在这里）。
      if (rt.fadeOut(judge.scene, FADE_OUT_MS)) {
        rt.tick()            // 采样也在推进淡出（不只有一个帧定时器在跑）
        broadcastStatus(rt, cfg)
        return
      }
      blackout(rt)
      disabledClosed = true
      broadcastStatus(rt, cfg)
      return
    }
    disabledClosed = false
    disabledLogged = false

    // 热重载期间可能存在多个实例：只有接管成功的那一个才允许碰串口（独占资源）
    if (options.mayRun && !options.mayRun()) {
      rt.setDriving(false)
      blackout(rt)
      broadcastStatus(rt, cfg)
      return
    }
    rt.setDriving(true)

    const agents = ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') {
      // 没有 agents 服务就分不清"在跑"和"跑完了"——宁可不点灯，也不要给错信号
      if (!warnedNoAgents) {
        log('[led] 没有 agents 服务：无法判定运行状态，灯带保持关闭')
        warnedNoAgents = true
      }
      broadcastStatus(rt, cfg)
      return
    }
    warnedNoAgents = false

    const missing = new Set<string>()
    // **每拍只调一次 agents.list()**：旧的实现对每个根会话都重新 list/rootOf/扫族，
    // 根会话多时是 O(roots × agents)，采样会被拖到毫秒级 —— 正好卡在 4.17ms 的帧预算里。
    const index = buildAgentIndex(ctx, agents)
    let roots: readonly any[] = []
    try {
      roots = typeof agents.roots === 'function' ? agents.roots() : index.all
    } catch (e) { roots = [] }

    const sessions = new Set<string>()
    for (const agent of roots) {
      const sessionId = sessionIdOfAgent(agent)
      if (sessionId === '') continue
      const rootId = index.rootOf(sessionId)
      sessions.add(rootId)
      const facts = collectFacts(ctx, rootId, index, missing)
      // **提问可能出现在子会话里**（子代理/团队任务也能 ask_user_question），
      // 而 collectFacts 只读根会话的投影 —— 这里把同族的每个会话都扫一遍（族索引本拍只建一次）。
      try {
        const family = index.family(rootId)
        let open = 0
        for (const sid of family) {
          const r = openQuestionCount(ctx, sid)
          open += r.count
        }
        if (open > 0) (facts as any).waitingUser = facts.waitingUser + open
        else if (family.length > 1) (facts as any).userQuestionFamily = family.length
      } catch (e) { /* 读不到就算了，别影响判定 */ }
      // 悬置的审批由宿主事件配对记账（DSH 没有查询 API）
      if (options.pendingApprovals) {
        const pending = options.pendingApprovals(rootId)
        if (pending > 0) (facts as any).waitingUser = facts.waitingUser + pending
      }
      // **事件溯源**：这个会话是否真的跑过（空闲会话不算"完成"）
      if (options.hasWork) {
        let ran = options.hasWork(rootId)
        if (!ran) {
          for (const sid of index.family(rootId)) {
            if (sid !== rootId && options.hasWork(sid)) { ran = true; break }
          }
        }
        if (ran) (facts as any).everRan = true
      }
      // **黄灯的主信号**：正在等回答的提问（阻塞式提问在投影里查不到）
      if (options.pendingAsks) {
        const asking = options.pendingAsks(rootId)
        if (asking > 0) (facts as any).waitingUser = facts.waitingUser + asking
      }
      ledger.observe(rootId, facts, at)
    }

    // 以宿主为准：本次 roots() 里没有的会话立刻从账本删掉（不再靠"多久没更新"清理）
    ledger.retain(sessions)
    // 启动后第一次观测（以及随后 10s）：记录每个会话当时的目标阶段；其中 blocked 的
    // 会话视为"重启前已看过"，避免历史阻塞在重启后重新亮红。阶段变化会让启动快照失效。
    if (startupCollectUntil === 0) startupCollectUntil = at + 10_000
    if (at <= startupCollectUntil) {
      for (const entry of ledger.snapshot(at)) {
        const phase = entry.facts.goalPhase
        if (phase === null || phase === undefined) continue
        startupGoalPhases.set(entry.sessionId, phase)
        if (phase === 'blocked') ledger.acknowledgeBlocked(entry.sessionId)
      }
    } else if (startupGoalPhases.size > 0) {
      // 阶段变了 → 不再算"启动残留"，之后的同阶段事件是新的
      const now = new Map<string, string>()
      for (const entry of ledger.snapshot(at)) {
        if (entry.facts.goalPhase !== null && entry.facts.goalPhase !== undefined) now.set(entry.sessionId, entry.facts.goalPhase)
      }
      for (const [id, phase] of startupGoalPhases) {
        if (now.get(id) !== phase) startupGoalPhases.delete(id)
      }
    }
    if (!startupLogged && at > startupCollectUntil && startupGoalPhases.size > 0) {
      startupLogged = true
      log(`[led] 启动快照：${startupGoalPhases.size} 个已存在的目标（补发的同阶段事件不重复报）`)
    }
    // 一次 evaluateAll 同时供"聚合仲裁"与"判定器仲裁"使用（过去这里重复算了两遍）。
    const allVerdicts = ledger.evaluateAll(at)
    lastVerdicts = allVerdicts
    const verdict = aggregateVerdict(allVerdicts)
    // 聚焦信息：灯只看标签页级（任一 DSH 页面可见且持焦点），不再按通知预设分级。
    const tabFocused = options.isFocused ? options.isFocused() : true
    const judged = judge.update(allVerdicts, { focused: tabFocused }, at)
    // 异常被"看到"（quiet 熄灯）后，必须把它从账本里清掉：
    // 否则 10 分钟保鲜期内聚合判定永远是 error → 聚焦态 2s 熄灯 →
    // 之后无论多少任务完成/在跑，灯都不再亮（用户看到的"报异常后卡死"）。
    if (verdict !== undefined && verdict.phase === 'error' && judged.state === 'off') {
      ledger.clearAllErrors()
      // 目标 blocked 是事实，不会因 clearAllErrors 消失；必须同时记"阻塞已被看到"，
      // 否则判定永远 error，红灯熄灭后运行白/完成绿都会被吞掉。
      ledger.acknowledgeBlocked()
      log('[led] 异常已被看到，清除账本中的异常记录')
    }
    // preview（诊断端点/API）在 5 秒内压过判定画面，之后就自动回到判定结果
    const manual = manualScene !== null && at < manualUntil ? manualScene : null
    // 瞬态事件画面（黄/绿脉冲）：先清过期，再按优先级叠加。
    if (pulse !== null && at >= pulse.until) pulse = null
    let scene = manual === null ? judged : manual
    if (manual === null && pulse !== null) {
      if (pulse.state === 'warn') {
        // 用户定的优先级：**报错 > 黄 > 等你/完成/运行**（黄灯压过橙呼吸，但不压红）。
        if (scene.state !== 'error') {
          scene = {
            state: 'warn', flags: 0, brightness: cfg.brightness, latched: false,
            reason: `警告：${pulse.reason}`,
          }
        }
      } else if (scene.state === 'running' || scene.state === 'off') {
        // 完成事件：只覆盖"在干活/熄灭"，不打断需要你处理的橙/红画面。
        scene = {
          state: 'done', flags: SCENE_FLAG.MUTED, brightness: cfg.brightness, latched: false,
          reason: `已完成：${pulse.reason}`,
        }
      }
    }
    // 目标删除不参与灯判定：这里不做任何 off/抑制，灯完全按当前事实继续走。
    // **亮度上限 = 配置值**：所有画面上报的 brightness 都是"不超过配置亮度"的百分比值，
    // 判定里的 +48 提醒加成也会被这里压回配置上限。
    const capped = scene.brightness > cfg.brightness ? { ...scene, brightness: cfg.brightness } : scene
    // 交给运行时：画面一变（或开始交叉渐变）它会立刻切回连续帧（空闲节拍下不能等 250ms 才看见）
    lastScene = capped
    rt.applyScene(capped)

    const signature = sceneSignature(scene)
    if (signature !== lastSceneSignature) {
      lastSceneSignature = signature
      const why = verdict ? verdict.reasons.join('；') : '无会话'
      log(`[led] ${scene.state}${scene.latched ? '（提醒中）' : ''} → ${describeScene(scene)}｜${why}${missing.size > 0 ? `｜能力缺失：${[...missing].join(',')}` : ''}`)
    }
    // 每次采样都问一遍（内部按"上次响过的状态"去重）：这样才能覆盖
    // "跳变发生时还没握手、连上之后补一声"的情况 —— 否则插线前的完成就永远不响。
    if (manual === null) maybeBeep(scene)
    // 红灯闪烁的规格（用户明确要求）：
    //   · 页面**聚焦**时：闪 2 秒后自动结束 → 转常亮红；
    //   · 页面**不聚焦**时：一直闪（800ms 周期），直到你回到页面再看 2 秒。
    // 错误的"看满 2 秒"按标签页级判：任一 DSH 标签页聚焦即算人在。
    const focusFresh = tabFocused
    if (scene.state === 'error') {
      if (!focusFresh) {
        // 人不在：保持闪烁，并把计时清零（回来之后重新计 2s）
        errorSeenAt = 0
      } else if (errorSeenAt === 0) {
        errorSeenAt = at
      } else if (at - errorSeenAt >= 2_000) {
        judge.acknowledge(at)
        // 已经在页面里看满 2 秒：错误/阻塞都算已看到，必须让判定落到 running/done，
        // 而不是留下"error 但已看"的粘滞状态把白/绿全吞掉。
        ledger.clearAllErrors()
        ledger.acknowledgeBlocked()
        errorSeenAt = 0
      }
    } else {
      errorSeenAt = 0
    }
    const count = sessions.size
    if (count !== lastVerdictCount) {
      lastVerdictCount = count
      if (count === 0) log('[led] 当前没有活跃根会话')
    }
    // 驱动条件（只挡"碰串口"，不影响上面的判定）：
    //   · 正在枚举端口 → 这一拍先不推帧，但**绝不能关串口**：
    //     枚举是 1 秒一次的常态操作，关掉再重连会让灯闪、也会打断 preview/test。
    //   · 没设备 → 不驱动（用户要求"即使检测到已打开也关闭"）；但如果链路已经握手成功，
    //     说明设备其实在（枚举可能只是没列出来），那就继续驱动，别自己把自己掐了。
    // 枚举结果只是**提示**，绝不能拿它挡住院内重连 —— 重连完全由运行时的退避 + 探测负责。
    // 枚举期间这一拍不推帧：自检到期/看门狗由**帧循环**继续推进（运行时在自己的线程里跑）。
    if (scanning) return
    if (devicePresent === false && !rt.status().link.verified && !noDeviceLogged) {
      log('[led] 枚举暂未列出串口：仍然让链路自己重试（不依赖枚举恢复）')
      noDeviceLogged = true
    }
    if (devicePresent !== false) noDeviceLogged = false
    const nowVerified = rt.status().link.verified
    // 自检窗口由控制器记账（运行时自己负责动画的到期交还）：避免每拍重复启动把动画重置。
    if (nowVerified && !wasVerified && at >= selfTestUntil) {
      // 每次（重新）握手成功都跑一遍自检：插拔/重启后也能看到。
      // 但此刻若正在报异常，就别拿自检动画把它盖掉 2 秒（异常优先级最高）。
      if (judge.scene.state === 'error') log('[led] 当前有异常，跳过自检动画')
      else startSelfTest(missing.size > 0 ? 'degraded' : 'ok')
    }
    wasVerified = nowVerified
    // 交付一拍给运行时（inline 模式下推进链路/淡出/看门狗；worker 模式是 no-op）。
    // 注意：这一拍必须在上面那些**枚举/设备提示**之后仍然执行 —— 已有测试证明
    // "枚举卡住时自检动画会永远停不下来"（preview 之后还是彩虹帧）。
    rt.tick()
    // 看门狗 + 状态广播（事件驱动，不靠前端轮询）
    broadcastStatus(rt, cfg)
  }

  /** 手动点灯（preview）：压过判定画面 5 秒，之后自动回到判定结果。 */
  function setManualScene(scene: LedScene, ttlMs = 5000): void {
    manualScene = scene
    manualUntil = now() + Math.max(0, Math.trunc(ttlMs))
    const rt = ensureRuntime()
    // 手动画面是连续动画（呼吸/闪烁）：让运行时保持连续帧（static 画面也要渐变流畅）
    rt.holdContinuous(Math.max(0, Math.trunc(ttlMs)))
    rt.applyScene(scene)
  }

  /**
   * 提示音（无源蜂鸣器）。挑音原则：**别刺耳、但要听得见**。
   * 用户实测反馈：880/1175Hz + 音量 45 仍然**太刺耳** —— 所以整体再降一档：
   *   · 频率 330~880Hz（无源蜂鸣器 1kHz 以上就偏尖，2kHz 像报警器）；
   *   · 音量 22~30（0~100，占空比上限 50%），够听见但不惊；
   *   · 时长压短（120~200ms），"完成"仍是上行两声（660→880）像轻轻一个 ding-dong。
   * 固件一次只响一个，多音由**运行时**排队（worker 里用定时器，stop() 统一清）。
   */
  const BEEP_PATTERNS: Record<string, readonly BeepStep[]> = {
    done: [
      { at: 0, beep: { freqHz: 520, volume: 16, durationMs: 120 } },
      { at: 170, beep: { freqHz: 660, volume: 18, durationMs: 160 } },
    ],
    waiting: [
      { at: 0, beep: { freqHz: 400, volume: 14, durationMs: 100 } },
    ],
    error: [
      { at: 0, beep: { freqHz: 260, volume: 20, durationMs: 200 } },
      { at: 260, beep: { freqHz: 260, volume: 16, durationMs: 200 } },
    ],
  }

  /** 状态跳变时响一声（无源蜂鸣器）—— 躺床上不用看屏幕也知道结果。 */
  function maybeBeep(scene: LedScene): void {
    if (!cfgBuzzer()) return
    if (scene.state === lastBeepState) return
    const pattern = BEEP_PATTERNS[scene.state]
    if (pattern === undefined) { lastBeepState = scene.state; return }
    // 安全门控 ②：蜂鸣器冷却。
    // 多会话同时结算时，聚合画面会在短时间内来回跳变 —— 没有冷却就会"连珠炮"。
    // 冷却期内只记账不发声（状态已经记下，不会再补响）。
    const at = now()
    if (at - lastBeepAt < BEEP_COOLDOWN_MS) { lastBeepState = scene.state; return }
    // 没连上就别记账：连上之后补响一次（否则"跳变发生在插线之前"就永远不响）
    if (!ensureRuntime().beepPattern(pattern)) return
    lastBeepAt = at
    lastBeepState = scene.state
  }

  /** 自检结果对应的蜂鸣（短促、不刺耳）。 */
  const SELF_TEST_BEEP: Record<SelfTestResult, readonly BeepStep[]> = {
    ok: [
      { at: 0, beep: { freqHz: 620, volume: 14, durationMs: 90 } },
      { at: 130, beep: { freqHz: 820, volume: 15, durationMs: 110 } },
    ],
    degraded: [{ at: 0, beep: { freqHz: 520, volume: 14, durationMs: 140 } }],
    error: [
      { at: 0, beep: { freqHz: 300, volume: 18, durationMs: 150 } },
      { at: 200, beep: { freqHz: 300, volume: 15, durationMs: 150 } },
    ],
  }

  /** 启动上电自检动画（握手后自动跑；测试控件里的「自检」也走这里）。 */
  function startSelfTest(result: SelfTestResult, totalMs = 2000): void {
    const rt = ensureRuntime()
    selfTestUntil = now() + totalMs
    // 动画本体在运行时（worker）里：覆盖渲染 → 到期自动交还画面（交接带渐变）
    rt.startSelfTest(result, totalMs, cfgBrightness())
    log(`[led] 自检动画：${result}（光谱 0.9s → 结果色 0.7s）`)
    // 自检结果也用声音报一次：不看灯也能知道是否就绪
    if (cfgBuzzer()) rt.beepPattern(SELF_TEST_BEEP[result])
  }

  function cfgBuzzer(): boolean {
    return config().buzzer
  }

  /** 当前亮度百分比（自检覆盖动画也要受它控制）。 */
  function cfgBrightness(): number {
    return config().brightness
  }

  /** 广播用的轻量签名：链路状态 + 场景 + 是否检测到设备 + 功能开关。 */
  function apiStatusBrief(rt: LedRuntime, cfg: LedRuntimeConfig): string {
    const ls = rt.status().link
    const sc = lastScene ?? judge.scene
    // verifiedCount 进签名：多灯里掉一块（overall 仍 ready）时 UI 也要收到一次状态变化。
    // enabled/master 也必须进签名：关灯是**提前 return** 的路径，如果签名不变就永远不会推
    // 状态给页面 —— 用户关掉开关后，设置页会一直停在"运行中"（实测 bug）。
    return [
      ls.state, ls.verified ? 1 : 0, ls.verifiedCount, ls.errorCode, ls.port,
      sc.state, sc.flags, sc.brightness, devicePresent === false ? 0 : 1,
      cfg.enabled ? 1 : 0, cfg.master ? 1 : 0,
    ].join('|')
  }

  /** 状态签名一变就通知订阅者（SSE 推给设置页）。所有提前 return 的路径都必须调用它。 */
  function broadcastStatus(rt: LedRuntime, cfg: LedRuntimeConfig): void {
    try {
      const st = apiStatusBrief(rt, cfg)
      if (st === lastBroadcast) return
      lastBroadcast = st
      for (const cb of listeners) {
        try { cb() } catch (e) { /* 单个订阅者出错不影响别人 */ }
      }
    } catch (e) { /* 广播绝不打断采样 */ }
  }

  function refresh(): void {
    const startedAt = now()
    try { tick() } catch (e) { log(`[led] 采样失败：${(e as Error).message}`) }
    const spent = now() - startedAt
    if (spent > winMaxSample) winMaxSample = spent
    // 采样耗时的 2 秒窗口滚动（帧统计的窗口在运行时里，这里只公布采样这一项）
    const at = now()
    if (sampleWindowAt === 0) sampleWindowAt = at
    else if (at - sampleWindowAt >= 2000) {
      sampleMaxMs = winMaxSample
      winMaxSample = 0
      sampleWindowAt = at
    }
  }

  return {
    start() {
      if (timer) return
      const ms = options.tickMs ?? 1500
      // **采样**定时器（1.5s 一次，单个 effect）走 cordis 的 timer 服务，插件卸载时随
      // fiber 自动清理；宿主没有这个服务时退回进程级 setInterval（stop() 里清掉）。
      // ⚠️ 帧循环**不走**这里（见 led-runtime.ts）：每帧一次 ctx.timeout 会注册一棵
      // effect/Timeout 对象树，240fps 下会把宿主堆撑爆（实测 2.58GB OOM）。
      const schedule = typeof ctx.interval === 'function'
        ? (cb: () => void, delay: number) => ctx.interval(cb, delay)
        : (cb: () => void, delay: number) => {
          const handle = setInterval(cb, delay)
          if (typeof handle.unref === 'function') handle.unref()
          return () => clearInterval(handle)
        }
      timer = schedule(() => refresh(), ms)
      // 灯运行时（默认独立 worker）：**按需运行 + 单调时钟 + 漂移补偿 + 迟到丢欠帧**。
      //   ⓪ 定时器：原始 setTimeout（绝不用 ctx.timeout —— OOM 根因）；
      //   ① 按需：只有连续动画（running/waiting/error、渐变、自检、手动画面、握手）才 240fps；
      //      稳态（off / 已看过的 done）降到 LED_IDLE_FRAME_MS（250ms）；
      //   ② 单调时钟：Date.now() 只有 1ms 分辨率，4.17ms 的节拍会被量化成 4/5ms；
      //   ③ 漂移补偿：按"预期时刻"排下一次（delay = expected - now）；
      //   ④ 迟到 ≥1 帧：**丢掉欠下的帧、从当前时刻重新对齐**，绝不补跑。
      const rt = ensureRuntime()
      rt.start()
      const frames = rt.status().frames
      log(`[led] 控制器已启动（每 ${ms}ms 采样、动画时每 ${frames.frameMs.toFixed(2)}ms 渲染一帧 ≈ ${Math.round(frames.targetFps)}fps，空闲 ${LED_IDLE_FRAME_MS}ms/帧）`)
      log(`[led] 串口帧预算：${frameBudgetText(frameBudget(frameBytes(MODE.LEDS), BAUD_RATE, frames.targetFps))}`)
      log('[led] 灯运行时（帧循环/渲染/串口链路）独立于主插件：灯阻塞或主线程卡顿都不再互相影响')
      void scanPorts()          // 立刻探一次设备：设置页首屏就能给出正确的状态词
      refresh()
    },
    stop() {
      if (timer) { try { timer() } catch (e) { /* ignore */ } timer = null }
      if (pulseTimer !== null) { clearTimeout(pulseTimer); pulseTimer = null }
      pulse = null
      // 运行时 stop：停帧循环 + 清蜂鸣队列 + 关串口（worker 桥会先同步淡出再收线程）
      if (runtime !== null) runtime.stop()
    },
    refresh,
    status() {
      const cfg = config()
      const agents = ctx.get('agents')
      const at = now()
      // 有人在看设置页（轮询状态）→ 允许按需扫一次设备；没人看就不扫。
      // 这样枚举频率由"有没有人在看"决定，而不是无条件定时。
      scanIfStale(5000)
      const verdicts = lastVerdicts
      let reason = 'ok'
      // master（插件总开关）关掉时灯也一并熄灭，状态词必须是"未启用"而不是沿用旧链路状态。
      if (!cfg.enabled || !cfg.master) reason = 'disabled'
      else if (!agents || typeof agents.list !== 'function') reason = 'no-agents-service'
      else if (verdicts.length === 0) reason = 'no-session'
      const runtimeStatus = ensureRuntime().status()
      const linkStatus = runtimeStatus.link
      // 状态端点回报**实际下发的画面**（含黄/绿脉冲），而不是只回报判定器结果。
      const shown = lastScene ?? judge.scene
      return {
        enabled: cfg.enabled,
        reason,
        port: cfg.port,
        baud: BAUD_RATE,
        scene: shown,
        sceneText: describeScene(shown),
        link: linkStatus,
        // 多灯：verified 语义 = 至少一块可用；这里把"实际挂了几块"单独暴露出来。
        boards: linkStatus.verifiedCount,
        boardCount: linkStatus.boardCount,
        verdicts,
        device: linkStatus.verified ? { leds: LED_COUNT, verified: true } : null,
        focused: options.isFocused(),
        devicePresent,
        ports: availablePorts,
        frames: {
          ...runtimeStatus.frames,
          sampleMaxMs,
        },
      }
    },
    acknowledge() {
      judge.acknowledge(now())
      ledger.clearAllErrors()   // 用户点"我知道了"= 异常已看到，别再毒化聚合
      ledger.acknowledgeBlocked()
      refresh()
    },
    shutdown() {
      // 退出路径：worker 桥会同步淡出（≤1200ms）并收线程；inline 直接同步做
      if (runtime !== null) runtime.shutdownFade()
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    /** 点击测试：显示某个状态的画面（5 秒）+ 按该状态响对应的提示音。 */
    test(kind: LedState | 'selftest', ttlMs = 5000) {
      const cfg = config()
      const allowed: readonly string[] = ['running', 'waiting', 'done', 'error', 'warn', 'selftest']
      if (!allowed.includes(kind)) return false
      if (!ensureRuntime().status().link.verified) return false
      if (kind === 'selftest') {
        startSelfTest('ok')
        return true
      }
      // 走"手动画面"而不是只推一帧：否则下一次采样就会把它盖回去，
      // 用户看到的只是一闪（也就看不到彗星/呼吸，更谈不上渐变）。
      setManualScene({
        state: kind, flags: 0, brightness: cfg.brightness, latched: false, reason: 'test',
      }, ttlMs)
      const pattern = BEEP_PATTERNS[kind] ?? []
      if (cfg.buzzer && pattern.length > 0) {
        // 第一声同步发（点一下就要有反馈），后续音由运行时排队
        ensureRuntime().beepPattern(pattern)
        lastBeepAt = now()
      }
      return true
    },
    noteWarn(_sessionId, reason) {
      // 黄灯是**瞬态**的：不写账本、不挂提醒闩、不看聚焦，1 秒后自动消失。
      pulse = { state: 'warn', reason: String(reason || '警告'), until: now() + WARN_PULSE_MS }
      armPulseTimer(WARN_PULSE_MS)
      refresh()
    },
    noteDone(_sessionId, reason) {
      pulse = { state: 'done', reason: String(reason || '已完成'), until: now() + DONE_PULSE_MS }
      armPulseTimer(DONE_PULSE_MS)
      refresh()
    },
    startupGoalPhase(sessionId) {
      return startupGoalPhases.get(String(sessionId || '')) ?? null
    },
    noteError(sessionId, reason) {
      const root = rootOf(ctx, String(sessionId))
      judge.resetErrorAck()   // 新异常 → 允许红灯重新闪
      ledger.noteError(root, reason, now())
      refresh()
    },
    sendFrame(mode, payload) {
      const cfg = config()
      if (!cfg.enabled) return false
      // 真固件只认 3 条命令：0x00 验证 / 0x01 7 灯颜色 / 0x02 蜂鸣。
      // 长度与命令码都交给 encodeFrame 校验（未知 MODE 直接抛，不会把垃圾写进串口）。
      try {
        return ensureRuntime().rawFrame(encodeFrameChecked(mode, payload))
      } catch (e) {
        log(`[led] 拒绝自定义帧：${(e as Error).message}`)
        return false
      }
    },
    beep(beep?: Partial<Beep>) {
      const cfg = config()
      if (!cfg.enabled) return false
      const merged: Beep = {
        freqHz: Number(beep && beep.freqHz !== undefined ? beep.freqHz : 1800),
        volume: Number(beep && beep.volume !== undefined ? beep.volume : 60),
        durationMs: Number(beep && beep.durationMs !== undefined ? beep.durationMs : 120),
      }
      return ensureRuntime().rawFrame(encodeBuzzer(merged))
    },
    preview(state, brightness) {
      const cfg = config()
      if (!cfg.enabled) return false
      // 直接改画面（不经过判定），下一帧就会渲染出来；不写配置、不影响闩
      setManualScene({
        state, flags: 0,
        brightness: brightness === undefined ? cfg.brightness : clampBrightness(Math.trunc(brightness)),
        latched: false,
        reason: 'preview',
      })
      return true
    },
  }
}
/** 校验并编码自定义帧（对外 API 用；未知 MODE / 长度不对都抛）。 */
function encodeFrameChecked(mode: number, payload: readonly number[]): Buffer {
  const known = mode === MODE.VERIFY || mode === MODE.LEDS || mode === MODE.BUZZER
  if (!known) throw new Error(`未知 MODE 0x${Number(mode).toString(16)}（真固件只支持 0x00/0x01/0x02）`)
  return encodeFrame(mode, payload)
}

/**
 * 校验设置页填进来的端口串（任意字符串不能直接进 CreateFileW / /dev）。
 *
 * 支持**英文逗号分隔的多个手动端口**（例：`COM5,COM9` = 这两块都驱动）。
 * 语义边界：
 *   · 出现 `auto`（大小写不敏感，可出现在任意一项）→ 整体按 `'auto'` 处理，
 *     其余项直接忽略 —— auto 的含义是"所有应答握手的灯"，已经**包含**了任何手写端口；
 *   · 逐项 `isValidPortName` 校验并去重（非法项丢弃，空项丢弃）；
 *   · 全部非法 → `''`（与旧语义一致：这串输入不可用，交由调用方回退）。
 * 中文逗号/空格**不是**分隔符（真端口名里不可能出现它们，误当分隔符会把垃圾带下去）。
 * 返回值原样交给 fanout 的 parsePortSpec 再解析一次（两处规则一致，互为防线）。
 */
export function sanitizeLedPort(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (text === '') return 'auto'
  const tokens = text.split(',').map((token) => token.trim()).filter((token) => token !== '')
  // `auto` 已包含所有插着的灯：出现 auto 就整体走自动发现（忽略其它项）
  if (tokens.some((token) => token.toLowerCase() === 'auto')) return 'auto'
  const valid: string[] = []
  for (const token of tokens) {
    if (!isValidPortName(token)) continue
    if (valid.includes(token)) continue
    valid.push(token)
  }
  return valid.length > 0 ? valid.join(',') : ''
}

/** 协议编码的再导出：对外 API 要发自定义帧时不必依赖内部路径。 */
export { encodeFrame, encodeLeds, encodeVerify } from './led-protocol.js'
