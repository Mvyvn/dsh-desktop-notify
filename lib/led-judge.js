// 「聚焦提醒判断器」—— 决定灯什么时候该"一直提醒"，什么时候可以安静下来
//
// ── 需求 ───────────────────────────────────────────────────────────────────
// "基于聚焦状态，自上次聚焦后再未回来，则灯会一直处于提醒状态。"
// 提醒是否解除取决于**人有没有回来**，而不是过了多久。钉钉式"弹一下就消失"在这里是错的：
// 人躺床上根本没看屏幕，灯必须一直提醒到人真的回到 DSH 页面。
//
// ── 语义 ───────────────────────────────────────────────────────────────────
//   · 聚焦 = 浏览器半区上报过 `focused`，且在保鲜窗口内（沿用 gate 的 2 分钟）。
//   · 出现"值得看"的结果（done / waiting / error）且**此刻人不在** → 上闩。
//   · 闩只在"人回来"或显式确认（板上没有按键，主机会用诊断端点/UI 按钮）时解除。
//   · 闩生效期间即使 AI 又跑起来，画面也带 ATTENTION：底色说"在干活"，提醒说"上次没看"。
//
// 真固件没有动画能力，所以这里的 flags 只是**语义**；具体怎么闪由 `led-render.ts` 决定。
// 纯状态机（无宿主依赖），单测见 tests/led-judge.test.mjs。
import { SCENE_FLAG, OFF_SCENE, clampBrightness } from './led-scene.js';
/** 聚焦保鲜窗口：与 gate.ts 的 FOCUS_STALE_MS 一致（2 分钟）。 */
export const FOCUS_FRESH_MS = 120_000;
export const DEFAULT_JUDGE_CONFIG = {
    attentionEnabled: true,
    brightness: 160,
    idleOffMs: 120_000,
    boostWhenAway: true,
    maxBrightness: 255,
};
/** 阶段 → 灯的语义状态。 */
function stateOf(phase) {
    switch (phase) {
        case 'running': return 'running';
        case 'waiting': return 'waiting';
        case 'done': return 'done';
        case 'error': return 'error';
    }
}
/**
 * "值得用双闪打扰人"的阶段：只有**异常**。
 *  · 完成（绿）不该闪（之前它也在闩里 → 绿灯自己双闪）；
 *  · 等你（黄）按用户要求**一直在呼吸**，不需要额外的双闪叠加。
 */
function worthAttention(phase) {
    return phase === 'error';
}
export function createLedJudge(config = DEFAULT_JUDGE_CONFIG) {
    const cfg = {
        attentionEnabled: config.attentionEnabled,
        brightness: clampBrightness(config.brightness),
        maxBrightness: clampBrightness(config.maxBrightness ?? 255),
        idleOffMs: Math.max(0, Math.trunc(config.idleOffMs) || 0),
        boostWhenAway: config.boostWhenAway,
    };
    let latch = null;
    /**
     * 这次异常是否已经被确认过（点通知 / 聚焦满 2s 自动确认）。
     * 确认后就**不再自动上闩**——否则下一拍又会把闩挂回去，红灯永远停不下来。
     * 新的异常（noteError）会把它重置。
     */
    /**
     * "已看到"的统一判据：**页面聚焦且当前阶段稳定满 2 秒**。
     * 不聚焦时永远不 quiet —— 所以绿灯一直常亮、黄灯一直呼吸、红灯一直闪。
     */
    /** 情形 B 的静态保持时长。 */
    const QUIET_MS = 2000;
    let lastPhase = '';
    /** 当前画面的起始时刻。 */
    let phaseSince = 0;
    /**
     * 上一次"已看"的画面键 = 阶段 + 会话 + 该阶段起始时刻。
     * 用它而不是只用阶段：多个会话里第二个完成、或同一会话再完成一轮，
     * 键都会变 → 灯会再亮一次（排队的人没被吃掉）。
     */
    let dismissedKey = null;
    /**
     * 每个**画面键**的显示状态：什么时候开始显示、开始显示时人是否在页面。
     * 用它来判"看过了"：
     *   · 离开时出现 → 回到页面时立刻算看过（立刻熄灭）；
     *   · 在页面里出现 → 显示满 2 秒才算看过；
     *   · **还没轮到显示的**（排队中被高优先级压着）→ 不算看过，轮到它时照常播报。
     */
    const screens = new Map();
    /** 当前阶段是不是"在页面里"出现的（决定回到页面时立刻熄还是等 2s）。 */
    let beganFocused = false;
    /** 失焦时刻（迟滞用）：离开不到 3 秒不算走。 */
    let unfocusedSince = 0;
    /**
     * 已经"处理完"的那个阶段（**粘滞**）：一旦看满 2 秒/从页面外回来，
     * 这个阶段就一直算"看过了"，直到阶段本身变化（新的完成/新的异常…）。
     * 不能每拍重算 —— 否则熄灯之后你一失焦，它又亮回来（用户报的第 3 条）。
     */
    let dismissedPhase = null; // 保留：当前已看掉的阶段（用于 resetErrorAck）
    let current = OFF_SCENE;
    // 聚焦结论由宿主直接给（标签页级）；判定器不维护任何时间窗。
    const focused = (focus, _now) => focus.focused;
    /** 画面键：阶段 + 会话 + 该阶段起点。用它可以区分"同一阶段的第二次完成"。 */
    const screenKeyOf = (v) => v === undefined ? '' : `${v.phase}|${v.sessionId}|${v.since}`;
    const render = (phase, verdict, focus, now) => {
        const here = focused(focus, now);
        // **人在页面里就一律撤掉提醒闩**（不管当前有没有画面/画面是什么）：
        // "提醒"只服务于"人不在"，回来之后它就没有意义了。
        // 这一步必须在下面任何早退分支之前完成 —— 否则"没有会话/画面被过滤"时闩会一直挂着。
        if (here && latch !== null)
            latch = null;
        if (phase === null || verdict === undefined) {
            // 没有会话：灯灭（闩已在上面按"人在不在"处理过）。
            return { ...OFF_SCENE, brightness: 0, latched: latch !== null, reason: '没有活跃会话' };
        }
        // ── 每个"画面"单独计时（键含会话与阶段起点：第二个完成的会话要重新播报）──
        const screenKey = screenKeyOf(verdict);
        if (screenKey !== lastPhase) {
            lastPhase = screenKey;
            phaseSince = now;
            beganFocused = here;
            dismissedPhase = null;
            dismissedKey = null;
        }
        const age = now - phaseSince;
        /**
         * 两种情形（用户定的规格）：
         *  A. **不在页面**（here=false）：一直保持 —— 绿常亮 / 黄呼吸 / 红慢闪，**不自行熄灭**。
         *     回到页面 → **立刻熄灭**（不用再等 2 秒）。
         *  B. **本来就在页面**（here=true，且这个状态是在页面里出现的）：
         *     静态保持 2 秒（绿/黄/红都是**常亮**，不呼吸不闪）→ 熄灭。
         * 运行中（running）永远不熄 —— 那是"还在干活"，本来就该亮着。
         */
        const seenNow = here && (!beganFocused || age >= QUIET_MS);
        // 运行中/等你 不参与"已看"：一个是"还在干活"，一个是"还在等你回答"，
        // 都必须**一直可见**（用户明确要求：黄灯无论聚焦与否都呼吸）。
        if (seenNow && phase !== 'running' && phase !== 'waiting') {
            dismissedPhase = phase;
            dismissedKey = screenKey;
        }
        const dismissed = dismissedKey === screenKey && phase !== 'running';
        // 等你（黄）是**持续状态**：看到了也不熄灯，只是停止呼吸。
        // 完成/异常是**一次性事件**：看过就熄灯。
        const shouldTurnOff = dismissed && phase !== 'waiting';
        // 提醒闩：只服务"人不在"时的提醒；回到页面就撤。
        // 加 3s 迟滞：切窗口几秒钟不算"人走了"（页面 focus/blur 成对 flap 是常态，
        // 没有迟滞的话每次 flap 都会触发一次提醒闪烁）。
        if (here)
            unfocusedSince = 0;
        else if (unfocusedSince === 0)
            unfocusedSince = now;
        if (here && latch !== null)
            latch = null;
        if (latch === null && cfg.attentionEnabled && !here && worthAttention(phase)
            && now - unfocusedSince >= 3000) {
            latch = { phase, since: now };
        }
        if (shouldTurnOff) {
            return {
                state: 'off',
                flags: 0,
                brightness: 0,
                latched: false,
                reason: `已看到（${beganFocused ? '页面内' : '回到页面'}），熄灭`,
            };
        }
        const state = stateOf(phase);
        let flags = 0;
        let brightness = Math.min(cfg.brightness, cfg.maxBrightness);
        let reason = verdict.reasons.length > 0 ? verdict.reasons.join('；') : phase;
        if (latch !== null) {
            flags |= SCENE_FLAG.ATTENTION;
            if (cfg.boostWhenAway)
                brightness = clampBrightness(brightness + 48);
            reason = `提醒中（自上次聚焦未回来）：${reason}`;
        }
        else if ((here || dismissed) && phase !== 'waiting') {
            // 完成/异常：看到过就静态（绿常亮、红不闪）。
            // **等你例外**：它要一直呼吸，直到问题被回答或超时。
            flags |= SCENE_FLAG.MUTED;
            reason = `已看：${reason}`;
        }
        return { state, flags, brightness: Math.min(brightness, cfg.maxBrightness), latched: latch !== null, reason };
    };
    return {
        update(verdicts, focus, now) {
            // 兼容：单个 verdict 也能传（老调用点/测试）
            const list = Array.isArray(verdicts)
                ? verdicts
                : verdicts === undefined ? [] : [verdicts];
            // **仲裁**：报错 0 ＞ 等待 1 ＞ 完成 2 ＞ 运行中 3。
            // 高优先级打断低优先级；被"看过"的那些跳过 → 低优先级自然排到队首。
            const rank = { error: 0, waiting: 1, done: 2, running: 3 };
            const sorted = [...list].sort((a, b) => (rank[a.phase] - rank[b.phase]) || (a.since - b.since));
            const here = focused(focus, now);
            const seen = (v) => {
                if (v.phase === 'running' || v.phase === 'waiting')
                    return false; // 这两个不参与"已看"
                const rec = screens.get(screenKeyOf(v));
                if (rec === undefined)
                    return false; // 还没轮到显示 → 不算看过
                if (rec.dismissed)
                    return true; // **粘滞**：看过就不再亮
                if (!here)
                    return false; // 人不在 → 一直保持
                if (!rec.beganFocused)
                    return true; // 离开时出现、回来即熄
                return now - rec.shownAt >= QUIET_MS; // 看满 2 秒
            };
            // **空闲会话 ≠ 完成**：快速切换会话时，刚切过去的空闲会话也是 done
            // （没有未结算工作），但它没干过活，不该点亮绿灯/打断运行中的白色流转。
            const announceable = sorted.filter((v) => v.phase !== 'done' || v.completed !== false);
            const picked = announceable.find((v) => dismissedKey !== screenKeyOf(v) && !seen(v));
            // 被"已看"过滤掉的画面，如果它正挂着提醒闩，就把闩撤掉（否则闩永远留着）
            for (const v of announceable) {
                if (latch !== null && latch.phase === v.phase && (dismissedKey === screenKeyOf(v) || seen(v)))
                    latch = null;
            }
            if (picked !== undefined) {
                const key = screenKeyOf(picked);
                if (!screens.has(key)) {
                    screens.set(key, { shownAt: now, beganFocused: here, dismissed: false });
                    if (screens.size > 64) { // 上限：常驻进程不能无限长
                        const oldest = screens.keys().next().value;
                        if (oldest !== undefined)
                            screens.delete(oldest);
                    }
                }
            }
            // 本轮被"看过"的画面 → 打上粘滞标记（失焦也不复活）
            for (const v of sorted) {
                const rec = screens.get(screenKeyOf(v));
                if (rec !== undefined && seen(v))
                    rec.dismissed = true;
            }
            current = render(picked === undefined ? null : picked.phase, picked, focus, now);
            return current;
        },
        acknowledge(_now) {
            latch = null;
            current = { ...current, flags: current.flags & ~SCENE_FLAG.ATTENTION, latched: false, reason: '已确认' };
            return current;
        },
        /** 新的异常到来：清掉"已确认"，让红灯重新闪。 */
        resetErrorAck() {
            // 新的异常到来：如果之前"异常"已经被看过（灯已熄），要清掉那个粘滞标记，
            // 让红灯重新亮起来 —— 也是"低等级灯排队"能继续推进的前提。
            // 把所有"异常"画面的已看标记清掉：新异常要像第一次一样重新播报
            for (const key of [...screens.keys()]) {
                if (key.startsWith('error|'))
                    screens.delete(key);
            }
            if (dismissedPhase === 'error') {
                dismissedPhase = null;
                dismissedKey = null;
            }
        },
        get latch() { return latch; },
        get scene() { return current; },
        signature() {
            return `${current.state}|${current.flags}|${current.brightness}`;
        },
    };
}
