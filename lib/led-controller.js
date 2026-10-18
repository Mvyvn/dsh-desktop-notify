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
import { createWorkLedger, aggregateVerdict, emptyFacts, } from './lifecycle.js';
import { createLedJudge } from './led-judge.js';
import { createSerialLink, isValidPortName } from './serial-link.js';
import { clampBrightness, describeScene, sceneSignature } from './led-scene.js';
import { renderSelfTest, smootherstep } from './led-render.js';
import { BAUD_RATE, LED_COUNT, MODE, encodeBuzzer, encodeFrame, frameBytes } from './led-protocol.js';
import { LED_FRAME_MS, LED_TARGET_FPS, clampFrameMs, frameBudget, frameBudgetText, monotonicNow } from './led-timing.js';
export const DEFAULT_LED_CONFIG = {
    enabled: false,
    port: 'auto',
    brightness: 160,
    master: true,
    buzzer: true,
    attention: true,
    idleOffMs: 120_000,
};
/** 沿 `session.header.parentSession` 往上回溯到根会话 id（有环保护）。 */
export function rootOf(ctx, sessionId) {
    try {
        const sessions = ctx.get('sessions');
        if (!sessions || typeof sessions.get !== 'function')
            return sessionId;
        let current = sessions.get(sessionId);
        const seen = new Set();
        for (let depth = 0; depth < 32 && current; depth += 1) {
            const id = String(current.id ?? '');
            if (id === '' || seen.has(id))
                break;
            seen.add(id);
            const parent = current.header && current.header.parentSession;
            if (!parent)
                return id;
            const next = typeof parent === 'string' ? sessions.get(parent) : parent;
            if (!next)
                return id;
            current = next;
        }
        return sessionId;
    }
    catch (e) {
        return sessionId;
    }
}
/** 子代理判定：官方做法（packages/subagent/subagent/src/archive-admission.ts:49-71）。 */
function isSubagentAgent(agent) {
    const header = agent && agent.session && agent.session.header;
    return !!(header && header.origin === 'subagent' && header.parentSession !== undefined);
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
export function openQuestionCount(ctx, sessionId) {
    try {
        const projections = ctx.get('sessionProjections');
        const sessions = ctx.get('sessions');
        const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
        if (!projections || typeof projections.stateOf !== 'function' || !session)
            return { count: 0, shape: 'none' };
        const state = projections.stateOf(session, 'userQuestions');
        const top = Array.isArray(state?.active) ? state.active : null;
        const nested = Array.isArray(state?.questions?.active) ? state.questions.active : null;
        const active = top ?? nested ?? [];
        const shape = top !== null ? 'top' : nested !== null ? 'nested' : 'none';
        let count = 0;
        for (const q of active) {
            const s = q && q.state !== undefined ? String(q.state) : 'open';
            if (s === 'open' || s === 'continued')
                count += 1;
        }
        return { count, shape };
    }
    catch (e) {
        return { count: 0, shape: 'error' };
    }
}
export function collectFacts(ctx, rootSessionId, agents, missing) {
    const mutable = { ...emptyFacts() };
    // ---- agent 状态 + 血缘 ----
    let rootAgent = null;
    try {
        rootAgent = agents && typeof agents.get === 'function' ? agents.get(rootSessionId) : null;
    }
    catch (e) {
        rootAgent = null;
    }
    if (rootAgent && rootAgent.status === 'running')
        mutable.agentRunning = true;
    const lineage = new Set([rootSessionId]);
    try {
        const all = typeof agents.list === 'function' ? agents.list() : [];
        // 先把子代理按父会话归拢，再从根往下走（多层子代理也只算一次）
        const childrenOf = new Map();
        for (const agent of all) {
            if (!isSubagentAgent(agent))
                continue;
            const parent = String(agent.session.header.parentSession);
            const bucket = childrenOf.get(parent);
            if (bucket)
                bucket.push(agent);
            else
                childrenOf.set(parent, [agent]);
        }
        const queue = [rootSessionId];
        while (queue.length > 0) {
            const current = queue.shift();
            for (const child of childrenOf.get(current) ?? []) {
                const id = String(child.id ?? '');
                if (id === '' || lineage.has(id))
                    continue;
                lineage.add(id);
                queue.push(id);
                // 只算"正在跑"的：agent 从注册表移除才算结束，而 idle 的子代理可能只是等待唤醒
                if (child.status === 'running')
                    mutable.liveSubagents += 1;
            }
        }
    }
    catch (e) { /* 血缘读不到就只按根 agent 判定 */ }
    // ---- 后台任务（同步查询；未结算 = running | stopping）----
    try {
        const jobs = ctx.get('jobs');
        if (jobs && typeof jobs.list === 'function') {
            const list = jobs.list(rootSessionId) || [];
            let open = 0;
            for (const job of list) {
                const status = String(job && job.status);
                if (status !== 'running' && status !== 'stopping')
                    continue;
                const owner = job && job.owner !== undefined && job.owner !== null ? String(job.owner) : '';
                // 无主 job 不归属任何会话：算进去会让所有会话一起变"运行中"，故忽略
                if (owner !== '' && !lineage.has(owner))
                    continue;
                open += 1;
            }
            mutable.openJobs = open;
        }
        else {
            missing.add('jobs');
        }
    }
    catch (e) {
        missing.add('jobs');
    }
    // ---- 会话投影：回合边界 / 待办输入 / 提问 / 待办 ----
    try {
        const projections = ctx.get('sessionProjections');
        const sessions = ctx.get('sessions');
        const session = sessions && typeof sessions.get === 'function' ? sessions.get(rootSessionId) : undefined;
        if (projections && typeof projections.stateOf === 'function' && session) {
            const turn = projections.stateOf(session, 'turnBoundary');
            if (turn && turn.openTurnStartSeq !== null && turn.openTurnStartSeq !== undefined)
                mutable.openTurn = true;
            const inbox = projections.stateOf(session, 'inbox');
            if (inbox && typeof inbox === 'object') {
                const nextTurn = Array.isArray(inbox['next-turn']) ? inbox['next-turn'].length : 0;
                const nextStep = Array.isArray(inbox['next-step']) ? inbox['next-step'].length : 0;
                mutable.pendingInbox = nextTurn + nextStep;
            }
            // 官方"等用户"信号：userQuestions 投影。
            // ⚠️ 形状：stateOf() 给的是**wire view** = { active: [...], settled: [...] }
            //    （active 在顶层！）。老代码读 questions.questions.active → 永远是 0，
            //    所以黄灯从来没亮过。这里两种形状都兼容，防止宿主版本差异再次踩坑。
            const view = projections.stateOf(session, 'userQuestions');
            const active = Array.isArray(view?.active)
                ? view.active
                : Array.isArray(view?.questions?.active)
                    ? view.questions.active
                    : [];
            let openQuestions = 0;
            for (const q of active) {
                const state = q && q.state !== undefined ? String(q.state) : 'open';
                // open = 正在等你回答；continued = 超时后仍在等你补答（同样算"等你"）
                if (state === 'open' || state === 'continued')
                    openQuestions += 1;
            }
            mutable.waitingUser = openQuestions;
            const todos = projections.stateOf(session, 'todos');
            if (Array.isArray(todos)) {
                mutable.unfinishedTodos = todos.filter((t) => t && t.status !== 'completed').length;
            }
        }
        else {
            missing.add('sessionProjections');
        }
    }
    catch (e) {
        missing.add('sessionProjections');
    }
    // ---- 目标阶段 ----
    try {
        const goals = ctx.get('goals');
        if (goals && typeof goals.get === 'function' && rootAgent) {
            // ⚠️ 收 Agent 不是 sessionId；agent 不是 live 时会抛 GOAL_AGENT_NOT_LIVE
            const view = goals.get(rootAgent);
            const phase = view && typeof view.phase === 'string' ? view.phase : '';
            if (phase === 'active' || phase === 'paused' || phase === 'blocked' || phase === 'complete') {
                mutable.goalPhase = phase;
            }
        }
    }
    catch (e) { /* 没有目标 / agent 已不是 live：都当"没有目标" */ }
    return mutable;
}
export function createLedController(options) {
    const { ctx, log } = options;
    // **单调时钟**：帧节拍用 Date.now() 会被 1ms 量化（4.17ms 的周期直接抖成 4/5ms），
    // 而且系统校时往回跳一下就可能让节拍停住。业务时间戳（日志/落盘）另用 Date.now()。
    const now = options.now ?? monotonicNow;
    const ledger = createWorkLedger();
    let judgeConfigKey = '';
    let judge = createLedJudge();
    const keyOf = (cfg) => [cfg.attention, cfg.brightness, cfg.idleOffMs].join('|');
    /** 端口枚举（链路与"有没有设备"探测共用一份实现）。 */
    const listPorts = options.list ?? (async () => {
        const mod = await import('./serial-port.js');
        return mod.listSerialPorts();
    });
    const link = createSerialLink({
        port: options.config().port,
        baud: BAUD_RATE,
        open: options.open ?? (async (port, baud) => {
            const mod = await import('./serial-port.js');
            return mod.openSerialPort(port, baud);
        }),
        list: listPorts,
        now,
        log,
    });
    let timer = null;
    let frameTimer = null;
    /** 帧循环统计（目标 vs 实测：只在 status() 里读，热路径只做两个整数自增）。 */
    let framesRendered = 0;
    let framesSkipped = 0;
    let fpsWindowAt = 0;
    let fpsWindowCount = 0;
    let measuredFps = 0;
    /** 帧循环的目标帧率与周期（start() 里按 led-timing 定；status() 原样报告）。 */
    let frameTargetFps = LED_TARGET_FPS;
    let framePeriodMs = LED_FRAME_MS;
    /** 上一次响过蜂鸣器的状态（同状态不重复响）。 */
    let lastBeepState = null;
    /** preview 的手动画面与生效截止时刻（压过判定画面一小段时间）。 */
    let manualScene = null;
    let manualUntil = 0;
    /** 关灯淡出：从哪个画面开始、什么时候开始、持续多久。 */
    let fadeOut = null;
    const FADE_OUT_MS = 250; // 与 link 的渐变同速（300ms ÷ 1.2）
    /** 蜂鸣器冷却：多会话齐结算时避免连珠炮。 */
    const BEEP_COOLDOWN_MS = 1500;
    let lastBeepAt = 0;
    /** 异常画面开始时刻（用于 20s 后自动确认）。 */
    let errorSeenAt = 0;
    /** 状态变化订阅者（SSE）。 */
    const listeners = new Set();
    /** 上一次广播出去的签名（变了才推）。 */
    let lastBroadcast = '';
    /** 上电自检：只跑一次（握手成功那一刻），1.1 秒后回到常规画面。 */
    let selfTest = null;
    /** 上一次采样时链路是否已握手（用来检测"刚连上"这个边界）。 */
    let wasVerified = false;
    /** 排队中的提示音定时器（stop() 里统一清）。 */
    const beepTimers = new Set();
    let warnedNoAgents = false;
    let disabledLogged = false;
    let lastSceneSignature = '';
    let lastVerdictCount = -1;
    /** 端口扫描结果：即使功能关着也扫 —— 设置页要靠它判「未连接」并禁用启用开关。 */
    let devicePresent;
    let availablePorts = [];
    let lastPortScanAt = 0;
    let scanning = false;
    let noDeviceLogged = false;
    // 扫描只用于"设置页显示有没有设备"这一件事；连接本身是**事件驱动**的
    // （直连上次成功的端口 + 主动探测），所以不需要每秒枚举。
    const PORT_SCAN_MS = 15000;
    /** 设置页在轮询状态（说明有人在看这张卡片）→ 允许按需扫一次（节流 1s）。 */
    let onDemandScanAt = 0;
    /**
     * 扫一次本机串口（**只枚举、不打开**）。
     * 枚举是"事件驱动"的兜底：连接本身靠直连上次成功的端口 + 主动探测，不需要枚举。
     */
    let scanStartedAt = 0;
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
    let scanGen = 0;
    async function scanPorts() {
        if (scanning) {
            // 枚举卡死兜底：正常几毫秒，超过 5 秒就当它挂了
            if (now() - scanStartedAt > 5000) {
                scanning = false;
                scanGen += 1; // 让在飞的那次作废（它的结果与 finally 都将被忽略）
                log('[led] 串口枚举超时，强制恢复（在飞的那次作废）');
            }
            else
                return;
        }
        const gen = (scanGen += 1);
        scanning = true;
        scanStartedAt = now();
        try {
            const list = await listPorts();
            if (gen !== scanGen)
                return; // 已过期的结果：丢弃，绝不覆盖新结果
            devicePresent = list.length > 0;
            availablePorts = list.map((p) => p.path);
        }
        catch (e) {
            // 枚举失败不动上次结论：宁可显示旧状态，也不要因为一次异常就说"没设备"
            if (gen === scanGen)
                log(`[led] 串口枚举失败：${e.message}`);
        }
        finally {
            // 只有"当代"扫描才有资格释放互斥锁
            if (gen === scanGen)
                scanning = false;
        }
    }
    function config() {
        try {
            const c = options.config();
            return {
                enabled: c.enabled === true,
                port: typeof c.port === 'string' && c.port.trim() !== '' ? c.port.trim() : 'auto',
                // 亮度现在**纯主机端**（真固件没有亮度命令）：0..255 直接乘到每个通道
                brightness: clampBrightness(Math.trunc(c.brightness)),
                master: c.master !== false,
                buzzer: c.buzzer !== false,
                attention: c.attention !== false,
                idleOffMs: Math.max(0, Math.trunc(c.idleOffMs) || 0),
            };
        }
        catch (e) {
            return DEFAULT_LED_CONFIG;
        }
    }
    /**
     * 按需扫描（给"设置页打开着"这种明确需要设备状态的场景用）。
     * 节流 1s：页面每秒轮询一次状态，不能每次都真的去枚举。
     */
    function scanIfStale(maxAgeMs) {
        const at = now();
        if (onDemandScanAt !== 0 && at - onDemandScanAt < 1000)
            return;
        if (devicePresent !== undefined && at - lastPortScanAt < maxAgeMs)
            return;
        onDemandScanAt = at;
        lastPortScanAt = at;
        void scanPorts();
    }
    /** 一次采样：读事实 → 判定 → 画面 → 串口。 */
    function tick() {
        const cfg = config();
        const at = now();
        link.configure(cfg.port, BAUD_RATE); // 固件固定 115200，不给用户调          // 端口/波特率改了立刻重连
        // 串口探测**先于**启用判定：功能关着也要知道本机有没有设备（设置页靠它判「未连接」）。
        // 但**已握手成功时直接跳过**：设备显然在，枚举没有信息量（也省掉和设备栈打交道的机会）。
        const connectedNow = link.status().verified === true;
        if (!connectedNow && (lastPortScanAt === 0 || at - lastPortScanAt >= PORT_SCAN_MS)) {
            lastPortScanAt = at;
            void scanPorts();
        }
        const key = keyOf(cfg);
        if (key !== judgeConfigKey) {
            // 判定器持有"提醒闩"状态：只在配置真的变了时重建，避免每次采样把闩清零
            judge = createLedJudge({
                attentionEnabled: cfg.attention,
                brightness: cfg.brightness,
                // 熄灯延时**硬编码**（设置页不再暴露）：完成且已看过 120s 后熄灯
                idleOffMs: 2_000,
                boostWhenAway: true,
                maxBrightness: cfg.brightness,
            });
            judgeConfigKey = key;
        }
        if (!cfg.enabled || !cfg.master) {
            if (!disabledLogged) {
                log(cfg.master ? '[led] 灯带未启用（设置页可开）' : '[led] 总开关关闭：灯带一并熄灭');
                disabledLogged = true;
            }
            // 关灯也要"曲速渐变"：交给帧循环做淡出（300ms），淡完再关串口。
            // 没连上/已经在淡出 → 直接走 blackout 兜底（不能卡在这里）。
            if (fadeOut === null && link.status().verified) {
                // 自检动画让路：关灯优先
                selfTest = null;
                link.setOverride(null);
                fadeOut = { scene: judge.scene, start: now(), duration: FADE_OUT_MS };
                frameTick(); // 立刻推第一帧，别等下一个采样/帧周期
                return;
            }
            if (fadeOut !== null) {
                frameTick(); // 采样也在推进淡出（不只有一个帧定时器在跑）
                return;
            }
            blackout();
            return;
        }
        disabledLogged = false;
        fadeOut = null;
        // 热重载期间可能存在多个实例：只有接管成功的那一个才允许碰串口（独占资源）
        if (options.mayRun && !options.mayRun()) {
            blackout();
            return;
        }
        const agents = ctx.get('agents');
        if (!agents || typeof agents.list !== 'function') {
            // 没有 agents 服务就分不清"在跑"和"跑完了"——宁可不点灯，也不要给错信号
            if (!warnedNoAgents) {
                log('[led] 没有 agents 服务：无法判定运行状态，灯带保持关闭');
                warnedNoAgents = true;
            }
            return;
        }
        warnedNoAgents = false;
        const missing = new Set();
        let roots = [];
        try {
            roots = typeof agents.roots === 'function' ? agents.roots() : agents.list();
        }
        catch (e) {
            roots = [];
        }
        const sessions = new Set();
        for (const agent of roots) {
            const sessionId = String((agent && agent.session && agent.session.id) ?? (agent && agent.id) ?? '');
            if (sessionId === '')
                continue;
            const rootId = rootOf(ctx, sessionId);
            sessions.add(rootId);
            const facts = collectFacts(ctx, rootId, agents, missing);
            // **提问可能出现在子会话里**（子代理/团队任务也能 ask_user_question），
            // 而 collectFacts 只读根会话的投影 —— 这里把同族的每个会话都扫一遍。
            try {
                const family = new Set([rootId]);
                const list = typeof agents.list === 'function' ? agents.list() : [];
                for (const a of list) {
                    const sid = String((a && a.session && a.session.id) ?? (a && a.id) ?? '');
                    if (sid !== '' && rootOf(ctx, sid) === rootId)
                        family.add(sid);
                }
                let open = 0;
                let shapeSeen = 'none';
                for (const sid of family) {
                    const r = openQuestionCount(ctx, sid);
                    open += r.count;
                    if (r.shape !== 'none')
                        shapeSeen = r.shape;
                }
                if (open > 0)
                    facts.waitingUser = facts.waitingUser + open;
                else if (family.size > 1)
                    facts.userQuestionFamily = family.size;
                void shapeSeen;
            }
            catch (e) { /* 读不到就算了，别影响判定 */ }
            // 悬置的审批由宿主事件配对记账（DSH 没有查询 API）
            if (options.pendingApprovals) {
                const pending = options.pendingApprovals(rootId);
                if (pending > 0)
                    facts.waitingUser = facts.waitingUser + pending;
            }
            // **事件溯源**：这个会话是否真的跑过（空闲会话不算"完成"）
            if (options.hasWork) {
                let ran = options.hasWork(rootId);
                if (!ran) {
                    const list = typeof agents.list === 'function' ? agents.list() : [];
                    for (const a of list) {
                        const sid = String((a && a.session && a.session.id) ?? (a && a.id) ?? '');
                        if (sid !== '' && rootOf(ctx, sid) === rootId && options.hasWork(sid)) {
                            ran = true;
                            break;
                        }
                    }
                }
                if (ran)
                    facts.everRan = true;
            }
            // **黄灯的主信号**：正在等回答的提问（阻塞式提问在投影里查不到）
            if (options.pendingAsks) {
                const asking = options.pendingAsks(rootId);
                if (asking > 0)
                    facts.waitingUser = facts.waitingUser + asking;
            }
            ledger.observe(rootId, facts, at);
        }
        // 以宿主为准：本次 roots() 里没有的会话立刻从账本删掉（不再靠"多久没更新"清理）
        ledger.retain(sessions);
        const verdict = aggregateVerdict(ledger.evaluateAll(at));
        // 聚焦信息**如实传**：0 表示"从未上报过"，判定器按"不在页面"处理。
        // 之前这里把 0 换成 at（当成刚聚焦），导致从未上报过聚焦时
        // 判定器永远以为你在页面 —— 用户看到的"非聚焦规则完全不生效"就是这个。
        // 把**全部会话的判定**交给判定器仲裁（报错＞等待＞完成＞运行中，已看过的跳过 → 低优先级排队）
        const allVerdicts = verdict === undefined ? [] : ledger.evaluateAll(at);
        const judged = judge.update(allVerdicts, { focused: options.isFocused ? options.isFocused() : true }, at);
        // 异常被"看到"（quiet 熄灯）后，必须把它从账本里清掉：
        // 否则 10 分钟保鲜期内聚合判定永远是 error → 聚焦态 2s 熄灯 →
        // 之后无论多少任务完成/在跑，灯都不再亮（用户看到的"报异常后卡死"）。
        if (verdict !== undefined && verdict.phase === 'error' && judged.state === 'off') {
            ledger.clearAllErrors();
            log('[led] 异常已被看到，清除账本中的异常记录');
        }
        // preview（诊断端点/API）在 5 秒内压过判定画面，之后就自动回到判定结果
        const manual = manualScene !== null && at < manualUntil ? manualScene : null;
        const scene = manual === null ? judged : manual;
        // **亮度上限 = 配置值**：所有画面上报的 brightness 都是"不超过配置亮度"的百分比值，
        // 判定里的 +48 提醒加成也会被这里压回配置上限。
        const capped = scene.brightness > cfg.brightness ? { ...scene, brightness: cfg.brightness } : scene;
        link.applyScene(capped);
        const signature = sceneSignature(scene);
        if (signature !== lastSceneSignature) {
            lastSceneSignature = signature;
            const why = verdict ? verdict.reasons.join('；') : '无会话';
            log(`[led] ${scene.state}${scene.latched ? '（提醒中）' : ''} → ${describeScene(scene)}｜${why}${missing.size > 0 ? `｜能力缺失：${[...missing].join(',')}` : ''}`);
        }
        // 每次采样都问一遍（内部按"上次响过的状态"去重）：这样才能覆盖
        // "跳变发生时还没握手、连上之后补一声"的情况 —— 否则插线前的完成就永远不响。
        if (manual === null)
            maybeBeep(scene);
        // 红灯闪烁的规格（用户明确要求）：
        //   · 页面**聚焦**时：闪 2 秒后自动结束 → 转常亮红；
        //   · 页面**不聚焦**时：一直闪（800ms 周期），直到你回到页面再看 2 秒。
        const focusFresh = options.isFocused ? options.isFocused() : true;
        if (scene.state === 'error') {
            if (!focusFresh) {
                // 人不在：保持闪烁，并把计时清零（回来之后重新计 2s）
                errorSeenAt = 0;
            }
            else if (errorSeenAt === 0) {
                errorSeenAt = at;
            }
            else if (at - errorSeenAt >= 2_000) {
                judge.acknowledge(at);
                errorSeenAt = 0;
            }
        }
        else {
            errorSeenAt = 0;
        }
        const count = sessions.size;
        if (count !== lastVerdictCount) {
            lastVerdictCount = count;
            if (count === 0)
                log('[led] 当前没有活跃根会话');
        }
        // 驱动条件（只挡"碰串口"，不影响上面的判定）：
        //   · 正在枚举端口 → 这一拍先不推帧，但**绝不能关串口**：
        //     枚举是 1 秒一次的常态操作，关掉再重连会让灯闪、也会打断 preview/test。
        //   · 没设备 → 不驱动（用户要求"即使检测到已打开也关闭"）；但如果链路已经握手成功，
        //     说明设备其实在（枚举可能只是没列出来），那就继续驱动，别自己把自己掐了。
        // 枚举结果只是**提示**，绝不能拿它挡住院内重连：
        // 之前这里"如果没枚举到设备就直接 return"，链路自己的重试/探测整个轮不到执行 ——
        // 一次枚举失败或滞后（插拔后 COM 号变动、注册表延迟）就会让链路永久卡死。
        // 现在：枚举只用来打日志，重连完全由 link 自己的退避 + 探测负责。
        if (scanning)
            return;
        if (devicePresent === false && !link.status().verified && !noDeviceLogged) {
            log('[led] 枚举暂未列出串口：仍然让链路自己重试（不依赖枚举恢复）');
            noDeviceLogged = true;
        }
        if (devicePresent !== false)
            noDeviceLogged = false;
        expireSelfTest();
        const nowVerified = link.status().verified;
        if (nowVerified && !wasVerified && selfTest === null) {
            // 每次（重新）握手成功都跑一遍自检：插拔/重启后也能看到。
            // 但此刻若正在报异常，就别拿自检动画把它盖掉 2 秒（异常优先级最高）。
            if (judge.scene.state === 'error')
                log('[led] 当前有异常，跳过自检动画');
            else
                startSelfTest(missing.size > 0 ? 'degraded' : 'ok');
        }
        wasVerified = nowVerified;
        link.tick();
        // 看门狗 + 状态广播（事件驱动，不靠前端轮询）
        try {
            link.reap();
            const st = apiStatusBrief();
            if (st !== lastBroadcast) {
                lastBroadcast = st;
                for (const cb of listeners) {
                    try {
                        cb();
                    }
                    catch (e) { /* 单个订阅者出错不影响别人 */ }
                }
            }
        }
        catch (e) { /* ignore */ }
    }
    /** 手动点灯（preview）：压过判定画面 5 秒，之后自动回到判定结果。 */
    function setManualScene(scene, ttlMs = 5000) {
        manualScene = scene;
        manualUntil = now() + Math.max(0, Math.trunc(ttlMs));
        link.applyScene(scene);
        link.tick();
    }
    /**
     * 提示音（无源蜂鸣器）。挑音原则：**别刺耳、但要听得见**。
     * 用户实测反馈：880/1175Hz + 音量 45 仍然**太刺耳** —— 所以整体再降一档：
     *   · 频率 330~880Hz（无源蜂鸣器 1kHz 以上就偏尖，2kHz 像报警器）；
     *   · 音量 22~30（0~100，占空比上限 50%），够听见但不惊；
     *   · 时长压短（120~200ms），"完成"仍是上行两声（660→880）像轻轻一个 ding-dong。
     * 固件一次只响一个，多音用定时器排队（stop() 里统一清）。
     */
    const BEEP_PATTERNS = {
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
    };
    /** 状态跳变时响一声（无源蜂鸣器）—— 躺床上不用看屏幕也知道结果。 */
    function maybeBeep(scene) {
        if (!cfgBuzzer())
            return;
        if (scene.state === lastBeepState)
            return;
        const pattern = BEEP_PATTERNS[scene.state];
        if (pattern === undefined) {
            lastBeepState = scene.state;
            return;
        }
        // 安全门控 ②：蜂鸣器冷却。
        // 多会话同时结算时，聚合画面会在短时间内来回跳变 —— 没有冷却就会"连珠炮"。
        // 冷却期内只记账不发声（状态已经记下，不会再补响）。
        const at = now();
        if (at - lastBeepAt < BEEP_COOLDOWN_MS) {
            lastBeepState = scene.state;
            return;
        }
        // 没连上就别记账：连上之后补响一次（否则"跳变发生在插线之前"就永远不响）
        if (!link.beep(pattern[0].beep))
            return;
        lastBeepAt = at;
        lastBeepState = scene.state;
        for (const step of pattern.slice(1))
            queueBeep(step.beep, step.at);
    }
    /**
     * 熄灯。
     *
     * ⚠️ WS2812B **会锁存最后一帧**：只是关掉串口，灯会一直亮在最后那个颜色上。
     * 所以"关闭开关"必须显式发一帧全黑再关串口 —— 否则用户看到的就是
     * "开关关了灯还亮着"。（这也是本文件里唯一"关灯"的正路。）
     */
    function blackout() {
        try {
            if (link.status().verified) {
                link.flush({ state: 'off', flags: 0, brightness: 0, latched: false, reason: '关闭' });
            }
        }
        catch (e) { /* 串口已经拔了就算了 */ }
        link.close();
    }
    /**
     * 帧循环体：240Hz 只做"渲染 + 写串口"，不重新采样事实。
     * 关灯淡出也在这里收尾 —— 淡到 0 之后才真正关串口（否则 WS2812 会停在半亮）。
     */
    /** 启动上电自检动画（握手后自动跑；测试控件里的「自检」也走这里）。 */
    /** 自检结果对应的蜂鸣（短促、不刺耳）。 */
    const SELF_TEST_BEEP = {
        ok: [
            { at: 0, beep: { freqHz: 620, volume: 14, durationMs: 90 } },
            { at: 130, beep: { freqHz: 820, volume: 15, durationMs: 110 } },
        ],
        degraded: [{ at: 0, beep: { freqHz: 520, volume: 14, durationMs: 140 } }],
        error: [
            { at: 0, beep: { freqHz: 300, volume: 18, durationMs: 150 } },
            { at: 200, beep: { freqHz: 300, volume: 15, durationMs: 150 } },
        ],
    };
    function startSelfTest(result, totalMs = 2000) {
        const startedAt = now();
        selfTest = { startedAt, result };
        link.setOverride((t) => renderSelfTest(t, startedAt, result, totalMs, cfgBrightness()));
        log(`[led] 自检动画：${result}（光谱 0.9s → 结果色 0.7s）`);
        // 自检结果也用声音报一次：不看灯也能知道是否就绪
        if (cfgBuzzer()) {
            const pattern = SELF_TEST_BEEP[result];
            if (link.beep(pattern[0].beep)) {
                for (const step of pattern.slice(1))
                    queueBeep(step.beep, step.at);
            }
        }
    }
    /** 自检到期就交还画面（采样与帧循环都会调用 —— 不能只靠帧循环）。 */
    function expireSelfTest() {
        if (selfTest === null)
            return;
        if (now() - selfTest.startedAt < 2000)
            return;
        selfTest = null;
        link.setOverride(null);
        link.restartFade();
    }
    function frameTick() {
        // 关灯优先：淡出期间自检动画必须让路（否则淡到一半又被覆盖回去）
        if (fadeOut !== null) {
            const t = now();
            const progress = Math.min(1, (t - fadeOut.start) / Math.max(1, fadeOut.duration));
            if (progress >= 1) {
                fadeOut = null;
                // 最后一帧必须真的落地：写入间隔门控会把它丢掉，灯就停在半亮上。
                link.flush({ state: 'off', flags: 0, brightness: 0, latched: false, reason: '关闭' });
                link.close();
                return;
            }
            // 淡出也用 smootherstep 反着走
            const k = 1 - smootherstep(progress);
            const base = fadeOut.scene;
            link.applyScene({ ...base, brightness: Math.round(base.brightness * k) });
            link.tick();
            return;
        }
        // 上电自检：覆盖渲染一段时间后自动交还画面（交接带一段渐变，不硬切）
        if (selfTest !== null) {
            expireSelfTest();
            if (selfTest !== null) {
                link.tick();
                return;
            }
        }
        link.tick();
    }
    /** 同步睡眠（只在退出路径用：进程马上要没了，阻塞几百毫秒没关系）。 */
    function sleepMs(ms) {
        try {
            const buf = new SharedArrayBuffer(4);
            Atomics.wait(new Int32Array(buf), 0, 0, ms);
        }
        catch (e) {
            const end = Date.now() + ms;
            while (Date.now() < end) { /* 忙等兜底 */ }
        }
    }
    /**
     * 退出前熄灯：**同步**淡出（~300ms）再发全黑帧然后关串口。
     * 为什么必须同步：插件卸载后帧循环已经停了，异步淡出来不及跑；
     * 而 WS2812 会锁存最后一帧 —— 不同步做完，DSH 一关灯就永远亮在那里。
     */
    function shutdownFade() {
        try {
            if (!link.status().verified) {
                link.close();
                return;
            }
            const base = judge.scene;
            if (base.state !== 'off' && base.brightness > 0) {
                const steps = 4;
                for (let i = steps - 1; i >= 0; i -= 1) {
                    const k = Math.pow(i / steps, 1.6);
                    link.flush({ ...base, brightness: Math.round(base.brightness * k), latched: false, reason: '退出' });
                    sleepMs(30);
                }
            }
            link.flush({ state: 'off', flags: 0, brightness: 0, latched: false, reason: '退出' });
        }
        catch (e) { /* 串口已经没了 */ }
        link.close();
    }
    /** 排队一次延迟响铃（避免"完成"的上行第二音被吞掉）。 */
    function queueBeep(beep, delayMs) {
        const timer = setTimeout(() => {
            beepTimers.delete(timer);
            try {
                link.beep(beep);
            }
            catch (e) { /* 串口掉线就算了 */ }
        }, Math.max(0, delayMs));
        if (typeof timer.unref === 'function')
            timer.unref();
        beepTimers.add(timer);
    }
    function cfgBuzzer() {
        return config().buzzer;
    }
    /** 当前亮度百分比（自检/覆盖动画也要受它控制）。 */
    function cfgBrightness() {
        return config().brightness;
    }
    /** 广播用的轻量签名：链路状态 + 场景 + 是否检测到设备。 */
    function apiStatusBrief() {
        const ls = link.status();
        const sc = judge.scene;
        return [ls.state, ls.verified ? 1 : 0, ls.errorCode, ls.port, sc.state, sc.flags, sc.brightness, devicePresent === false ? 0 : 1].join('|');
    }
    function refresh() {
        try {
            tick();
        }
        catch (e) {
            log(`[led] 采样失败：${e.message}`);
        }
    }
    return {
        start() {
            if (timer)
                return;
            const ms = options.tickMs ?? 1500;
            // 定时器优先走 cordis 的 timer 服务（插件卸载时随 fiber 自动清理）。
            // 但它**不是所有宿主都有**（嵌入式宿主/测试桩常常只实现 ctx.timeout）：
            // 那种情况下退回进程级 setInterval，并在 stop() 里明确清掉，避免热重载后重复采样。
            const schedule = typeof ctx.interval === 'function'
                ? (cb, delay) => ctx.interval(cb, delay)
                : (cb, delay) => {
                    const handle = setInterval(cb, delay);
                    if (typeof handle.unref === 'function')
                        handle.unref();
                    return () => clearInterval(handle);
                };
            timer = schedule(() => refresh(), ms);
            // 动画帧循环：**单调时钟 + 漂移补偿 + 迟到丢欠帧**。
            //   ① 单调时钟（见 now 的定义）：Date.now() 只有 1ms 分辨率，4.17ms 的节拍会被量化成 4/5ms；
            //   ② 漂移补偿：按"预期时刻"排下一次（delay = expected - now），回调耗时不累积成永久漂移；
            //   ③ 迟到 ≥1 帧：**丢掉欠下的帧、从当前时刻重新对齐**，绝不补跑 ——
            //      画面本来就按绝对时刻渲染，补跑过期帧只会白烧 CPU，还会瞬间把串口队列灌满
            //      （用户看到的就是"卡一下然后猛跳"）。
            // 帧循环只做"渲染 + 写串口"，不重新采样事实（采样要读 agents/jobs/projections）。
            const frameMs = clampFrameMs(options.frameMs);
            framePeriodMs = frameMs;
            frameTargetFps = Math.round((1000 / frameMs) * 1000) / 1000; // 4.1667ms → 240（去掉浮点尾巴）
            const scheduleOnce = typeof ctx.timeout === 'function'
                ? (cb, delay) => ctx.timeout(cb, delay)
                : (cb, delay) => {
                    const handle = setTimeout(cb, delay);
                    if (typeof handle.unref === 'function')
                        handle.unref();
                    return () => clearTimeout(handle);
                };
            let expected = now() + frameMs;
            const step = () => {
                try {
                    frameTick();
                }
                catch (e) { /* 帧级异常不打断采样 */ }
                framesRendered += 1;
                const t = now();
                // 实测帧率（2 秒窗口）：短窗口会被一次抖动带偏，长窗口才说明"稳不稳"。
                if (fpsWindowAt === 0) {
                    fpsWindowAt = t;
                    fpsWindowCount = framesRendered;
                }
                else if (t - fpsWindowAt >= 2000) {
                    measuredFps = ((framesRendered - fpsWindowCount) * 1000) / (t - fpsWindowAt);
                    fpsWindowAt = t;
                    fpsWindowCount = framesRendered;
                }
                expected += frameMs;
                if (t - expected >= frameMs) {
                    // 落后一帧以上（主线程卡了/定时器被压后）：欠的帧丢掉，重新对齐，不补跑
                    framesSkipped += Math.round((t - expected) / frameMs) + 1;
                    expected = t + frameMs;
                }
                frameTimer = scheduleOnce(step, Math.max(0, expected - t));
            };
            frameTimer = scheduleOnce(step, frameMs);
            log(`[led] 控制器已启动（每 ${ms}ms 采样、每 ${frameMs.toFixed(2)}ms 渲染一帧 ≈ ${Math.round(1000 / frameMs)}fps）`);
            log(`[led] 串口帧预算：${frameBudgetText(frameBudget(frameBytes(MODE.LEDS), BAUD_RATE, 1000 / frameMs))}`);
            void scanPorts(); // 立刻探一次设备：设置页首屏就能给出正确的状态词
            refresh();
        },
        stop() {
            if (timer) {
                try {
                    timer();
                }
                catch (e) { /* ignore */ }
                timer = null;
            }
            if (frameTimer) {
                try {
                    frameTimer();
                }
                catch (e) { /* ignore */ }
                frameTimer = null;
            }
            for (const t of beepTimers)
                clearTimeout(t);
            beepTimers.clear();
            link.close();
        },
        refresh,
        status() {
            const cfg = config();
            const agents = ctx.get('agents');
            const at = now();
            // 有人在看设置页（轮询状态）→ 允许按需扫一次设备；没人看就不扫。
            // 这样枚举频率由"有没有人在看"决定，而不是无条件定时。
            scanIfStale(5000);
            const verdicts = ledger.evaluateAll(at);
            let reason = 'ok';
            if (!cfg.enabled)
                reason = 'disabled';
            else if (!agents || typeof agents.list !== 'function')
                reason = 'no-agents-service';
            else if (verdicts.length === 0)
                reason = 'no-session';
            const linkStatus = link.status();
            return {
                enabled: cfg.enabled,
                reason,
                port: cfg.port,
                baud: BAUD_RATE,
                scene: judge.scene,
                sceneText: describeScene(judge.scene),
                link: linkStatus,
                verdicts,
                device: linkStatus.verified ? { leds: LED_COUNT, verified: true } : null,
                focused: options.isFocused(),
                devicePresent,
                ports: availablePorts,
                frames: {
                    targetFps: frameTargetFps,
                    frameMs: framePeriodMs,
                    rendered: framesRendered,
                    skipped: framesSkipped,
                    fps: measuredFps,
                },
            };
        },
        acknowledge() {
            judge.acknowledge(now());
            ledger.clearAllErrors(); // 用户点"我知道了"= 异常已看到，别再毒化聚合
            refresh();
        },
        shutdown() {
            shutdownFade();
        },
        subscribe(cb) {
            listeners.add(cb);
            return () => { listeners.delete(cb); };
        },
        /** 点击测试：显示某个状态的画面（5 秒）+ 按该状态响对应的提示音。 */
        test(kind, ttlMs = 5000) {
            const cfg = config();
            const allowed = ['running', 'waiting', 'done', 'error', 'selftest'];
            if (!allowed.includes(kind))
                return false;
            if (!link.status().verified)
                return false;
            if (kind === 'selftest') {
                startSelfTest('ok');
                return true;
            }
            // 走"手动画面"而不是只推一帧：否则下一次 500ms 采样就会把它盖回去，
            // 用户看到的只是一闪（也就看不到彗星/呼吸，更谈不上渐变）。
            setManualScene({
                state: kind, flags: 0, brightness: cfg.brightness, latched: false, reason: 'test',
            }, ttlMs);
            const pattern = BEEP_PATTERNS[kind] ?? [];
            if (cfg.buzzer && pattern.length > 0) {
                // 第一声同步发（点一下就要有反馈），后续音用定时器排队
                link.beep(pattern[0].beep);
                lastBeepAt = now();
                for (const step of pattern.slice(1))
                    queueBeep(step.beep, step.at);
            }
            return true;
        },
        noteError(sessionId, reason) {
            const root = rootOf(ctx, String(sessionId));
            judge.resetErrorAck(); // 新异常 → 允许红灯重新闪
            ledger.noteError(root, reason, now());
            refresh();
        },
        sendFrame(mode, payload) {
            const cfg = config();
            if (!cfg.enabled)
                return false;
            // 真固件只认 3 条命令：0x00 验证 / 0x01 7 灯颜色 / 0x02 蜂鸣。
            // 长度与命令码都交给 encodeFrame 校验（未知 MODE 直接抛，不会把垃圾写进串口）。
            try {
                return link.rawFrame(encodeFrameChecked(mode, payload));
            }
            catch (e) {
                log(`[led] 拒绝自定义帧：${e.message}`);
                return false;
            }
        },
        beep(beep) {
            const cfg = config();
            if (!cfg.enabled)
                return false;
            const merged = {
                freqHz: Number(beep && beep.freqHz !== undefined ? beep.freqHz : 1800),
                volume: Number(beep && beep.volume !== undefined ? beep.volume : 60),
                durationMs: Number(beep && beep.durationMs !== undefined ? beep.durationMs : 120),
            };
            return link.rawFrame(encodeBuzzer(merged));
        },
        preview(state, brightness) {
            const cfg = config();
            if (!cfg.enabled)
                return false;
            // 直接改画面（不经过判定），下一帧就会渲染出来；不写配置、不影响闩
            setManualScene({
                state, flags: 0,
                brightness: brightness === undefined ? cfg.brightness : clampBrightness(Math.trunc(brightness)),
                latched: false,
                reason: 'preview',
            });
            return true;
        },
    };
}
/** 校验并编码自定义帧（对外 API 用；未知 MODE / 长度不对都抛）。 */
function encodeFrameChecked(mode, payload) {
    const known = mode === MODE.VERIFY || mode === MODE.LEDS || mode === MODE.BUZZER;
    if (!known)
        throw new Error(`未知 MODE 0x${Number(mode).toString(16)}（真固件只支持 0x00/0x01/0x02）`);
    return encodeFrame(mode, payload);
}
/** 校验设置页填进来的端口名（任意字符串不能直接进 CreateFileW）。 */
export function sanitizeLedPort(raw) {
    const text = String(raw ?? '').trim();
    if (text === '' || text === 'auto')
        return 'auto';
    return isValidPortName(text) ? text : '';
}
/** 协议编码的再导出：对外 API 要发自定义帧时不必依赖内部路径。 */
export { encodeFrame, encodeLeds, encodeVerify } from './led-protocol.js';
