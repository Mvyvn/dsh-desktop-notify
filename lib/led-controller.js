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
import { BAUD_RATE, LED_COUNT, MODE, encodeBuzzer, encodeFrame } from './led-protocol.js';
export const DEFAULT_LED_CONFIG = {
    enabled: false,
    port: 'auto',
    brightness: 160,
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
            // 官方唯一有投影的"等用户"信号：userQuestions.active 里 state === 'open'
            const questions = projections.stateOf(session, 'userQuestions');
            const active = questions && questions.questions && Array.isArray(questions.questions.active)
                ? questions.questions.active
                : [];
            let openQuestions = 0;
            for (const q of active) {
                const state = q && q.state !== undefined ? String(q.state) : 'open';
                if (state === 'open')
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
    const now = options.now ?? (() => Date.now());
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
    /** 上一次响过蜂鸣器的状态（同状态不重复响）。 */
    let lastBeepState = null;
    /** preview 的手动画面与生效截止时刻（压过判定画面一小段时间）。 */
    let manualScene = null;
    let manualUntil = 0;
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
    const PORT_SCAN_MS = 5000;
    /** 扫一次本机串口（**只枚举、不打开**，所以不占用任何资源）。 */
    async function scanPorts() {
        if (scanning)
            return;
        scanning = true;
        try {
            const list = await listPorts();
            devicePresent = list.length > 0;
            availablePorts = list.map((p) => p.path);
        }
        catch (e) {
            // 枚举失败不动上次结论：宁可显示旧状态，也不要因为一次异常就说"没设备"
            log(`[led] 串口枚举失败：${e.message}`);
        }
        finally {
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
                buzzer: c.buzzer !== false,
                attention: c.attention !== false,
                idleOffMs: Math.max(0, Math.trunc(c.idleOffMs) || 0),
            };
        }
        catch (e) {
            return DEFAULT_LED_CONFIG;
        }
    }
    /** 一次采样：读事实 → 判定 → 画面 → 串口。 */
    function tick() {
        const cfg = config();
        const at = now();
        link.configure(cfg.port, BAUD_RATE); // 固件固定 115200，不给用户调          // 端口/波特率改了立刻重连
        // 串口探测**先于**启用判定：功能关着也要知道本机有没有设备（设置页靠它判「未连接」）
        if (lastPortScanAt === 0 || at - lastPortScanAt >= PORT_SCAN_MS) {
            lastPortScanAt = at;
            void scanPorts();
        }
        const key = keyOf(cfg);
        if (key !== judgeConfigKey) {
            // 判定器持有"提醒闩"状态：只在配置真的变了时重建，避免每次采样把闩清零
            judge = createLedJudge({
                attentionEnabled: cfg.attention,
                brightness: cfg.brightness,
                idleOffMs: cfg.idleOffMs,
                boostWhenAway: true,
            });
            judgeConfigKey = key;
        }
        if (!cfg.enabled) {
            if (!disabledLogged) {
                log('[led] 灯带未启用（设置页可开）');
                disabledLogged = true;
            }
            link.close();
            return;
        }
        disabledLogged = false;
        // 热重载期间可能存在多个实例：只有接管成功的那一个才允许碰串口（独占资源）
        if (options.mayRun && !options.mayRun()) {
            link.close();
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
            // 悬置的审批由宿主事件配对记账（DSH 没有查询 API）
            if (options.pendingApprovals) {
                const pending = options.pendingApprovals(rootId);
                if (pending > 0)
                    facts.waitingUser = facts.waitingUser + pending;
            }
            ledger.observe(rootId, facts, at);
        }
        const verdict = aggregateVerdict(ledger.evaluateAll(at));
        const judged = judge.update(verdict, { lastFocusedAt: options.lastFocusedAt() }, at);
        // preview（诊断端点/API）在 5 秒内压过判定画面，之后就自动回到判定结果
        const manual = manualScene !== null && at < manualUntil ? manualScene : null;
        const scene = manual === null ? judged : manual;
        link.applyScene(scene);
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
        const count = sessions.size;
        if (count !== lastVerdictCount) {
            lastVerdictCount = count;
            if (count === 0)
                log('[led] 当前没有活跃根会话');
        }
        // 驱动条件（只挡"碰串口"，不影响上面的判定）：
        //   · 正在枚举端口 → 先等结论；枚举**失败**时不留死锁（devicePresent 保持上次值/undefined）
        //   · 没设备 → 不驱动、也不去尝试打开（用户要求"即使检测到已打开也关闭"）；
        //     这里**不写回配置**：设置值原样保留，插上灯就按它生效。
        if (scanning) {
            link.close();
            return;
        }
        if (devicePresent === false) {
            if (!noDeviceLogged) {
                log('[led] 未检测到串口设备：指示灯不驱动（插上后自动恢复）');
                noDeviceLogged = true;
            }
            link.close();
            return;
        }
        noDeviceLogged = false;
        link.tick();
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
     *   · 频率压在 440~1175Hz：无源蜂鸣器 2kHz 以上会很尖（像报警器），中低频柔和得多；
     *   · 音量 40~55（0~100，占空比上限 50%）：够穿透房间，又不至于吓一跳；
     *   · "完成"上行两声（880→1175）像轻轻的一个 ding-dong；"异常"低沉两声（440）更沉。
     * 固件一次只响一个，所以多音用定时器排队（stop() 里统一清）。
     */
    const BEEP_PATTERNS = {
        done: [
            { at: 0, beep: { freqHz: 880, volume: 45, durationMs: 110 } },
            { at: 160, beep: { freqHz: 1175, volume: 45, durationMs: 150 } },
        ],
        waiting: [
            { at: 0, beep: { freqHz: 660, volume: 40, durationMs: 100 } },
        ],
        error: [
            { at: 0, beep: { freqHz: 440, volume: 55, durationMs: 170 } },
            { at: 220, beep: { freqHz: 440, volume: 50, durationMs: 170 } },
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
        // 没连上就别记账：连上之后补响一次（否则"跳变发生在插线之前"就永远不响）
        if (!link.beep(pattern[0].beep))
            return;
        lastBeepState = scene.state;
        for (const step of pattern.slice(1))
            queueBeep(step.beep, step.at);
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
            const ms = options.tickMs ?? 500;
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
            // 第二个定时器：动画帧。~25fps 只做"渲染 + 写串口"，不重新采样事实
            // （采样要读 agents/jobs/projections，30 倍频率太浪费）。
            frameTimer = schedule(() => { try {
                link.tick();
            }
            catch (e) { /* 帧级异常不打断采样 */ } }, options.frameMs ?? 40);
            log(`[led] 控制器已启动（每 ${ms}ms 采样、每 ${options.frameMs ?? 40}ms 渲染一帧）`);
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
                focusedAgoMs: options.lastFocusedAt() > 0 ? at - options.lastFocusedAt() : -1,
                devicePresent,
                ports: availablePorts,
            };
        },
        acknowledge() {
            judge.acknowledge(now());
            refresh();
        },
        noteError(sessionId, reason) {
            const root = rootOf(ctx, String(sessionId));
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
