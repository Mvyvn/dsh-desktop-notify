// 帧时间预算 —— **目标帧率的唯一真相**。
//
// 为什么单独一个模块：这些数字原来散落在四个文件里，结果互相矛盾：
//   · led-controller 的注释写"默认 40ms（25fps）"，代码回退值却是 8ms（125fps）；
//   · serial-link 写死 MIN_WRITE_GAP_MS = 4（≈250 写入/秒），它只是**上限**，
//     并不会把帧循环提到 240；
//   · CHANGELOG / README / serial-protocol.md 三处又各写一套（240fps / 25fps / 650 B/s）。
// 于是"代码里写着 240Hz、实际跑 125Hz"这种事就必然发生。现在只有这一份：
//
//   帧周期 = 1000 / LED_TARGET_FPS          （240fps → 4.1667ms）
//   线上时间 = 字节数 × 10bit / 波特率       （26B @115200 → 2.257ms，8-N-1）
//   写入下限 = 线上时间 × 1.15              （≈2.6ms；必须 < 帧周期，否则目标帧率自己把自己卡掉）
//   带宽占用 = 线上时间 / 帧周期             （2.257 / 4.1667 ≈ 54.2%）
//
// 边界（想验证就得按这个口径）：115200 的物理上限是 1000/2.257 ≈ 443fps，
// 240fps 留了约 46% 余量；但**能不能稳**还取决于 Windows 定时器分辨率（约 1ms）、
// USB 转串口驱动与固件解析速度 —— 见 docs/serial-protocol.md「帧率与背压」。
/** 目标帧率：动画渲染 + 推帧的节拍。*/
export const LED_TARGET_FPS = 240;
/** 目标帧周期（毫秒）。*/
export const LED_FRAME_MS = 1000 / LED_TARGET_FPS;
/**
 * 空闲节拍（毫秒）—— **没有连续动画时**的帧周期（约 4fps）。
 *
 * 为什么需要它：帧循环过去从插件启动起就按 240fps 空转，和"有没有 AI 任务在跑"无关 ——
 * 空闲时每秒 240 次定时器唤醒 + 240 次渲染，纯属白烧（还一直分配像素对象）。
 * 但帧循环不能停：心跳（HEARTBEAT_MS=1000，通知灯"我还在"）、串口看门狗（reap）、
 * 验证帧/重连重试都要靠它推进。250ms 一拍既覆盖这些需求，又比 240fps 少 60 倍唤醒。
 *
 * 约束（改这个数先看这几条）：
 *   · 必须 < HEARTBEAT_MS（1000），否则心跳会被空闲节拍拖慢；
 *   · 必须 > 交互动画帧周期，否则"空闲"没有意义；
 *   · 需要连续动画时（running/waiting/error、淡入淡出、自检、握手）控制器会切回 LED_FRAME_MS。
 */
export const LED_IDLE_FRAME_MS = 250;
/**
 * 允许的最快节拍（400fps）。
 * 26B @115200 线上 443fps 是硬天花板，写再多也只是堆在驱动里；超过它没有意义。
 */
export const MAX_TARGET_FPS = 400;
/** 允许的最慢节拍（1fps）：防止配置/测试写错把帧循环搞成"几乎不走"。 */
export const MIN_TARGET_FPS = 1;
/** 8-N-1：每字节 10 bit（1 起始 + 8 数据 + 1 停止，无校验）。 */
const BITS_PER_BYTE = 10;
/**
 * 一帧在线上占用的时间（毫秒）。
 * @param bytes 帧长（LEDS 帧 = 26）
 * @param baud 波特率（固件固定 115200）
 */
export function wireTimeMs(bytes, baud) {
    const b = Number.isFinite(baud) && baud > 0 ? baud : 115200;
    const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    return (n * BITS_PER_BYTE * 1000) / b;
}
/** 把期望的帧周期夹到合法区间。 */
export function clampFrameMs(ms) {
    const fallback = LED_FRAME_MS;
    const v = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : fallback;
    return Math.min(1000 / MIN_TARGET_FPS, Math.max(1000 / MAX_TARGET_FPS, v));
}
/**
 * 两次写入之间的最小间隔（毫秒）—— **物理下限**，不是目标。
 *
 * 它的作用只是"绝不比线速更快地往串口灌数据"：帧循环抖得再厉害（一次补跑、
 * 事件驱动的额外 tick），也不会把 USB 转串口的发送缓冲灌爆（灌爆的表现是灯一顿一顿的）。
 * 所以它必须**小于** `LED_FRAME_MS`，否则目标 240fps 会被自己的门控砍掉。
 */
export function minWriteGapMs(frameBytes, baud) {
    // 1.15 = 15% 余量：波特率有 ±2% 误差，驱动按块发送还会再攒一点。
    return wireTimeMs(frameBytes, baud) * 1.15;
}
export function frameBudget(frameBytes, baud, targetFps = LED_TARGET_FPS) {
    const frameMs = 1000 / targetFps;
    const wireMs = wireTimeMs(frameBytes, baud);
    return {
        targetFps,
        frameMs,
        wireMs,
        usage: wireMs / frameMs,
        minGapMs: minWriteGapMs(frameBytes, baud),
        maxFps: 1000 / wireMs,
    };
}
/** 预算的一行人话（启动日志、设置页诊断、压测脚本共用同一段口径）。 */
export function frameBudgetText(b) {
    const pct = Math.round(b.usage * 1000) / 10;
    return `目标 ${Math.round(b.targetFps)}fps（${b.frameMs.toFixed(2)}ms/帧），`
        + `一帧 ${b.wireMs.toFixed(2)}ms 线上时间（占用 ${pct}%，线速上限 ${Math.round(b.maxFps)}fps），`
        + `写入下限 ${b.minGapMs.toFixed(2)}ms`;
}
/**
 * 单调时钟（毫秒，带小数）。
 *
 * 帧循环必须用它，不能用 `Date.now()`：
 *   · Date.now() 只有 1ms 分辨率，4.1667ms 的节拍被量化成 4/5ms 抖动；
 *   · Date.now() 会被系统校时**往回调**（NTP/手动改时间），一调就可能让帧循环停住或爆发。
 * 业务时间戳（日志、通知记录）仍然用 Date.now()，两者不要混用。
 */
export function monotonicNow() {
    const perf = globalThis.performance;
    if (perf && typeof perf.now === 'function')
        return perf.now();
    return Date.now();
}
