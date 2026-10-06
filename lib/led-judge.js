// 「聚焦提醒判断器」—— 决定灯什么时候该"一直提醒"，什么时候可以安静下来
//
// ── 需求 ───────────────────────────────────────────────────────────────────
// "基于聚焦状态，自上次聚焦后再未回来，则灯会一直处于提醒状态。"
// 也就是说：**提醒是否解除，取决于人有没有回来，而不是过了多久**。钉钉式的"弹一下
// 就消失"在这里是错的——人躺床上根本没看屏幕，灯必须一直提醒到人真的回到 DSH 页面。
//
// ── 语义 ───────────────────────────────────────────────────────────────────
//   · 聚焦 = 浏览器半区上报过 `focused`，且在保鲜窗口内（默认沿用 gate 的 2 分钟）。
//   · 出现"值得看"的结果（done / waiting / error）且**此刻人不在** → 上闩（latch）。
//   · 闩只在"人回来"（新的 focused 上报）或显式确认（板上按键 / 诊断端点）时解除。
//   · 闩生效期间，即使 AI 又跑起来了，灯也会带 ATTENTION 位：底色告诉你"在干活"，
//     提醒位告诉你"上次的结论你还没看"——两个事实都不会被吞掉。
//
// ── 为什么不用"定时器 + 倒计时"─────────────────────────────────────────────
// 倒计时会在人不在时悄悄放过提醒；而且宿主进程休眠/恢复后倒计时不可信。
// 这里只有两个输入：**有没有新结果**、**人回来没有**——都是可判定的事实。
//
// 纯状态机（无宿主依赖），单测见 tests/led-judge.test.mjs。
import { SCENE_FLAG, PROGRESS_NONE, clampBrightness } from './led-protocol.js';
/** 聚焦保鲜窗口：与 gate.ts 的 FOCUS_STALE_MS 一致（2 分钟）。 */
export const FOCUS_FRESH_MS = 120_000;
export const DEFAULT_JUDGE_CONFIG = {
    attentionEnabled: true,
    brightness: 160,
    idleOffMs: 120_000,
    boostWhenAway: true,
};
const OFF_SCENE = {
    state: 'off', flags: 0, brightness: 0, progress: PROGRESS_NONE, latched: false, reason: '未启用',
};
/** 阶段 → 灯的语义状态。 */
function stateOf(phase) {
    switch (phase) {
        case 'running': return 'running';
        case 'waiting': return 'waiting';
        case 'done': return 'done';
        case 'error': return 'error';
        default: return 'off';
    }
}
/** "值得人看一眼"的阶段：只有这三种会上闩。 */
function worthAttention(phase) {
    return phase === 'done' || phase === 'waiting' || phase === 'error';
}
export function createLedJudge(config = DEFAULT_JUDGE_CONFIG) {
    const cfg = {
        attentionEnabled: config.attentionEnabled,
        // 显式亮度上限 254：255 是"用设备默认"的哨兵（见 led-protocol.ts 的说明）
        brightness: clampBrightness(config.brightness),
        idleOffMs: Math.max(0, Math.trunc(config.idleOffMs) || 0),
        boostWhenAway: config.boostWhenAway,
    };
    let latch = null;
    /** 上一次"完成/等待/异常"画面的起始时刻（用于 idleOff 熄灯判定）。 */
    let settledAt = 0;
    let current = OFF_SCENE;
    const focused = (focus, now) => {
        const fresh = focus.freshMs ?? FOCUS_FRESH_MS;
        return focus.lastFocusedAt > 0 && now - focus.lastFocusedAt < fresh;
    };
    const render = (phase, verdict, focus, now) => {
        if (phase === null || verdict === undefined) {
            // 没有会话：灯灭。**闩保留**——人还没回来，回来之前不该悄悄把提醒作废；
            // 但确实没有画面可显示（无会话），所以只输出 off。
            return { ...OFF_SCENE, brightness: 0, latched: latch !== null, reason: '没有活跃会话' };
        }
        const here = focused(focus, now);
        if (here)
            latch = null; // 人回来了 → 提醒使命结束
        else if (cfg.attentionEnabled && worthAttention(phase) && latch === null) {
            latch = { phase, since: now };
        }
        const state = stateOf(phase);
        let flags = 0;
        let brightness = cfg.brightness;
        let reason = verdict.reasons.length > 0 ? verdict.reasons.join('；') : phase;
        if (latch !== null) {
            flags |= SCENE_FLAG.ATTENTION;
            if (cfg.boostWhenAway)
                brightness = clampBrightness(brightness + 48);
            reason = `提醒中（自上次聚焦未回来）：${reason}`;
            // 提醒期间不计熄灯倒计时：人没回来就不该熄
            settledAt = 0;
        }
        else if (phase === 'done') {
            // 已看过：安静版（固件不再闪，只留颜色），过 idleOffMs 后熄灭
            flags |= SCENE_FLAG.MUTED;
            brightness = clampBrightness(Math.round(brightness * 0.65));
            if (settledAt === 0)
                settledAt = now;
            if (cfg.idleOffMs > 0 && now - settledAt >= cfg.idleOffMs) {
                return { state: 'off', flags: 0, brightness: 0, progress: PROGRESS_NONE, latched: false, reason: '已完成并看过，熄灯' };
            }
        }
        if (phase !== 'done')
            settledAt = 0;
        return { state, flags, brightness, progress: PROGRESS_NONE, latched: latch !== null, reason };
    };
    return {
        update(verdict, focus, now) {
            const phase = verdict === undefined ? null : verdict.phase;
            current = render(phase, verdict, focus, now);
            return current;
        },
        acknowledge(now) {
            latch = null;
            if (current.state === 'done')
                settledAt = now;
            current = { ...current, flags: current.flags & ~SCENE_FLAG.ATTENTION, latched: false, reason: '已确认（按键/手动）' };
            return current;
        },
        get latch() { return latch; },
        get scene() { return current; },
        signature() {
            return [current.state, current.flags, current.brightness, current.progress].join('|');
        },
    };
}
/** 供诊断端点直接读的闩快照。 */
export function describeScene(scene) {
    const bits = [];
    if ((scene.flags & SCENE_FLAG.ATTENTION) !== 0)
        bits.push('attention');
    if ((scene.flags & SCENE_FLAG.MUTED) !== 0)
        bits.push('muted');
    if ((scene.flags & SCENE_FLAG.NIGHT) !== 0)
        bits.push('night');
    if ((scene.flags & SCENE_FLAG.TRANSIENT) !== 0)
        bits.push('transient');
    return `${scene.state}${bits.length ? '+' + bits.join('+') : ''} bright=${scene.brightness}${scene.latched ? ' [提醒中]' : ''}`;
}
