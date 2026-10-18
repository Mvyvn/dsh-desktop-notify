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
import { createBoundedMap } from './state.js';
/** 全空事实（服务缺失时的缺省值，也是"真的什么都没有"的形状）。 */
export function emptyFacts() {
    return {
        agentRunning: false,
        liveSubagents: 0,
        openJobs: 0,
        pendingInbox: 0,
        openTurn: false,
        waitingUser: 0,
        everRan: false,
        goalPhase: null,
        unfinishedTodos: 0,
    };
}
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_ERROR_TTL_MS = 10 * 60_000;
const DEFAULT_STALE_MS = 30 * 60_000;
/**
 * 显示优先级（**数字越小越高**）——用户定的顺序：
 *   报错 0 ＞ 等待 1 ＞ 完成 2 ＞ 运行中 3
 *
 * 语义：高优先级的灯会**打断**低优先级的灯；被打断的低优先级状态不会丢，
 * 它留在账本里"排队"，等高优先级结束/被看到之后再显示出来。
 * 注意 done 排在 running 之前：这样别的会话跑着的时候，某个会话完成仍能播报 2 秒。
 */
const PHASE_RANK = { error: 0, waiting: 1, done: 2, running: 3 };
/**
 * 建账本。所有 Map 都有上限：会话可能成百上千地开，而条目只在会话消失时才回收。
 */
export function createWorkLedger(options = {}) {
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const entries = createBoundedMap(maxSessions);
    /** 阶段缓存：只在阶段真正变化时更新 since（"亮了多久"是给人看的）。 */
    const since = new Map();
    const touch = (sessionId, at) => {
        const key = String(sessionId);
        let entry = entries.get(key);
        if (entry === undefined) {
            entry = { sessionId: key, facts: emptyFacts(), lastError: null, updatedAt: at, sawWork: false };
            entries.set(key, entry);
        }
        entry.updatedAt = at;
        return entry;
    };
    const prune = (now) => {
        for (const [key, entry] of [...entries]) {
            if (now - entry.updatedAt > staleMs) {
                entries.delete(key);
                since.delete(key);
            }
        }
    };
    const evaluateEntry = (entry, now) => {
        const f = entry.facts;
        const reasons = [];
        const pending = (f.agentRunning ? 1 : 0) + f.liveSubagents + f.openJobs + f.pendingInbox + (f.openTurn ? 1 : 0);
        const waiting = f.waitingUser;
        const freshError = entry.lastError !== null && now - entry.lastError.at <= errorTtlMs;
        // 干过活：**宿主事件说它跑过**（最可靠），或这批事实里还有活/在等/出过错
        if (f.everRan || pending > 0 || waiting > 0 || freshError)
            entry.sawWork = true;
        let phase;
        if (waiting > 0) {
            phase = 'waiting';
            reasons.push(`等待你的输入/审批 ${waiting} 项`);
        }
        else if (freshError && entry.lastError !== null) {
            phase = 'error';
            reasons.push(`异常：${entry.lastError.reason}`);
        }
        else if (pending > 0) {
            phase = 'running';
            // 逐条列明"为什么还在跑"——这是本检查器存在的全部意义
            if (f.agentRunning)
                reasons.push('agent 正在运行');
            if (f.liveSubagents > 0)
                reasons.push(`${f.liveSubagents} 个子代理未结束`);
            if (f.openJobs > 0)
                reasons.push(`${f.openJobs} 个后台任务未结算`);
            if (f.pendingInbox > 0)
                reasons.push(`inbox 里还有 ${f.pendingInbox} 条待处理输入（会被再次调起）`);
            if (f.openTurn)
                reasons.push('回合边界仍开着');
        }
        else if (f.goalPhase === 'blocked') {
            // 目标 blocked = **任务阻塞**，属于"异常"（红），不是"等你"（黄）：
            // 它需要的是"去处理"，而不是"回答模型"。
            phase = 'error';
            reasons.push('目标阻塞（任务被卡住，需要处理）');
        }
        else if (f.goalPhase === 'active') {
            // 双保险：正常路径下 active 目标会被 round-driver 再次调起，
            // 即使此刻没有任何 agent 在跑，也**不能**判成完成。
            phase = 'running';
            reasons.push('目标仍未完成也未暂停（active），会被再次调起');
        }
        else {
            phase = 'done';
            if (f.goalPhase === 'complete')
                reasons.push('目标已完成');
            else if (f.goalPhase === 'paused')
                reasons.push('目标已暂停');
            else
                reasons.push('没有未结算的工作');
            if (f.unfinishedTodos > 0)
                reasons.push(`（另有 ${f.unfinishedTodos} 项待办未勾选，不计入运行判定）`);
        }
        const key = entry.sessionId;
        const prev = since.get(key);
        let at = prev === undefined || prev.phase !== phase ? now : prev.at;
        since.set(key, { phase, at });
        const completed = phase !== 'done' || entry.sawWork;
        return { sessionId: key, phase, reasons, since: at, pending, waiting, completed };
    };
    return {
        observe(sessionId, facts, at) {
            const entry = touch(sessionId, at);
            // 只认识已知字段：宿主传进来的对象可能来自 any 边界，逐字段取默认值。
            entry.facts = {
                agentRunning: facts.agentRunning === true,
                liveSubagents: nonNegative(facts.liveSubagents),
                openJobs: nonNegative(facts.openJobs),
                pendingInbox: nonNegative(facts.pendingInbox),
                openTurn: facts.openTurn === true,
                waitingUser: nonNegative(facts.waitingUser),
                everRan: facts.everRan === true,
                goalPhase: normalizeGoalPhase(facts.goalPhase),
                unfinishedTodos: nonNegative(facts.unfinishedTodos),
            };
            // 立刻按新事实刷一次阶段缓存：`since` 要等于"这个阶段**从哪一刻开始**"，
            // 而不是"第一次有人来问是哪一刻"——否则「亮了多久」会随查询时机漂移。
            evaluateEntry(entry, at);
        },
        noteError(sessionId, reason, at) {
            const entry = touch(sessionId, at);
            entry.lastError = { at, reason: String(reason) };
        },
        clearError(sessionId) {
            const entry = entries.get(String(sessionId));
            if (entry)
                entry.lastError = null;
        },
        /** 把所有会话的错误记录都清掉（错误画面已经被"看到"并熄灯之后调用）。 */
        clearAllErrors() {
            for (const [, entry] of entries.entries())
                entry.lastError = null;
        },
        evaluate(sessionId, now) {
            const entry = entries.get(String(sessionId));
            if (entry === undefined) {
                return { sessionId: String(sessionId), phase: 'done', reasons: ['未知会话'], since: now, pending: 0, waiting: 0, completed: false };
            }
            return evaluateEntry(entry, now);
        },
        retain(sessionIds) {
            const keep = new Set();
            for (const id of sessionIds)
                keep.add(String(id));
            for (const key of entries.keys()) {
                if (!keep.has(key)) {
                    entries.delete(key);
                    since.delete(key);
                }
            }
        },
        evaluateAll(now) {
            prune(now);
            const out = [];
            for (const [, entry] of entries)
                out.push(evaluateEntry(entry, now));
            out.sort((a, b) => {
                const rank = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
                if (rank !== 0)
                    return rank;
                // 同阶段：等得越久越靠前（先发生的先提醒）
                return a.since - b.since;
            });
            return out;
        },
        sessions() {
            return [...entries.keys()];
        },
        snapshot(now) {
            prune(now);
            const out = [];
            for (const [, entry] of entries) {
                out.push({ ...entry, verdict: evaluateEntry(entry, now) });
            }
            return out;
        },
        clear() {
            entries.clear();
            since.clear();
        },
    };
}
function nonNegative(value) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return 0;
    return Math.trunc(n);
}
function normalizeGoalPhase(value) {
    return value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete' ? value : null;
}
/**
 * 把多条 verdict 收敛成"灯该显示什么"。
 * 规则：error > waiting > running > done（见 PHASE_RANK），同阶段取等待最久的。
 * @returns undefined 表示没有任何会话（灯应当熄灭）
 */
export function aggregateVerdict(verdicts) {
    let best;
    for (const v of verdicts) {
        if (best === undefined) {
            best = v;
            continue;
        }
        const rank = PHASE_RANK[v.phase] - PHASE_RANK[best.phase];
        if (rank < 0 || (rank === 0 && v.since < best.since))
            best = v;
    }
    return best;
}
/** 阶段 → 一句中文说明（日志/诊断端点用）。 */
export function phaseLabel(phase) {
    switch (phase) {
        case 'running': return '运行中';
        case 'waiting': return '等待你';
        case 'done': return '已完成';
        case 'error': return '异常';
    }
}
