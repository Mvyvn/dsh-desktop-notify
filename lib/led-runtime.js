// 灯运行时 —— **平台无关**的"一条灯带从画面到串口"的全部时间驱动逻辑。
//
// 为什么把这一层单独拆出来（用户任务4）：
//   过去 led-controller.ts 里既有"读 ctx 事实 → 判定"（只能主线程），又有
//   "串口链路 + 240fps 帧循环 + 渲染 + 自检 + 熄灯淡出"（纯时间驱动）。后者跟宿主毫无关系，
//   却被钉在主线程上：主线程打个 30~196ms 的停顿，灯就跟着掉帧；
//   反过来灯的渲染/GC 也在跟宿主抢同一个事件循环。
//
// 现在这一层可以在**任意线程**里跑：
//   · 主线程：`led-runtime-bridge.ts` 把它塞进独立 worker；
//   · worker：`led-runtime-worker.ts` 直接 `createLedRuntime`；
//   · 测试/排障：直接在本线程 `createLedRuntime`（与旧实现逐拍等价）。
//
// 职责边界（这一层**不碰** ctx / 配置 / 判定，只吃语义画面）：
//   · 帧循环：raw setTimeout（**绝不用主机 timer 服务**，240fps 会注册对象树把堆撑爆）、
//     单调时钟、漂移补偿、迟到丢欠帧（不补跑）、按需 240fps / 空闲 250ms；
//   · 渲染：交给 serial-link（含交叉渐变与复用缓冲）；
//   · 自检覆盖动画（renderSelfTest）与自动交还画面；
//   · 熄灯淡出（fadeOut → 全黑 flush → close）与退出同步淡出（shutdownFade）；
//   · 蜂鸣多音排队（固件一次只响一个，多音用定时器排队）；
//   · **自适应冗余**（task-8）：读链路 quality/redundancy，劣化时把唯一帧降到 120fps，
//     由 serial-link 每帧双发（线上占用不变），并收紧看门狗让快速健康探针跑起来。
//
// ⚠️ 同步等待只出现在 shutdownFade()：它是**退出路径**；正常运行路径一个同步等待都没有。
import { createSerialFanout } from './serial-fanout.js';
import { renderSelfTest, smootherstep } from './led-render.js';
import { OFF_SCENE, SCENE_FLAG } from './led-scene.js';
import { BAUD_RATE } from './led-protocol.js';
import { LED_FRAME_MS, LED_IDLE_FRAME_MS, clampFrameMs, monotonicNow, } from './led-timing.js';
/** 关灯淡出的默认时长（与串口链路的交叉渐变同速：300ms ÷ 1.2）。 */
export const FADE_OUT_MS = 250;
/**
 * 自适应冗余时的**唯一帧**目标帧率。
 *
 * 链路劣化后每帧由 serial-link 连续写两份（相邻 2×2.26ms），所以唯一帧降到 120fps：
 * 线上占用 = 2 × 2.26ms / 8.33ms ≈ 54%，和健康期 240fps 单调发一模一样。
 * 单帧丢失/损坏时另一份几乎立刻补上，视觉上仍是接近 240fps 的平滑动画。
 */
export const REDUNDANT_TARGET_FPS = 120;
/** 冗余模式的唯一帧周期（8.3333ms）。 */
export const REDUNDANT_FRAME_MS = 1000 / REDUNDANT_TARGET_FPS;
/** 冗余期看门狗（主动探测）走得更勤：reap 间隔从 1s 收紧到 250ms。 */
const REAP_EVERY_DEGRADED_MS = 250;
/** 健康期的看门狗间隔（探测/心跳/验证帧都靠它推进）。 */
const REAP_EVERY_MS = 1000;
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
/** 默认帧调度：**原始 setTimeout**（绝不用宿主的 timer 服务，见文件头）。 */
function defaultSchedule(cb, delayMs) {
    const handle = setTimeout(cb, delayMs);
    if (typeof handle.unref === 'function')
        handle.unref();
    return () => clearTimeout(handle);
}
export function createLedRuntime(options) {
    const now = options.now ?? monotonicNow;
    const log = options.log ?? (() => { });
    const scheduleFrame = options.schedule ?? defaultSchedule;
    const link = createSerialFanout({
        port: options.port,
        baud: options.baud ?? BAUD_RATE,
        open: options.open,
        list: options.list,
        now,
        log,
    });
    // ── 帧循环状态 ────────────────────────────────────────────────────────────
    let frameTimer = null;
    let frameStarted = false;
    /** 空闲节拍（true）还是连续动画节拍（false）。 */
    let idleMode = false;
    /** 本拍预期触发的单调时刻（漂移补偿基准）。 */
    let frameExpected = 0;
    /** 防止 wake 与定时器回调重入。 */
    let frameInStep = false;
    let frameWakeQueued = false;
    /** 动画目标帧率/周期（健康态基准；不随冗余/空闲改变 —— 状态页拿它做"目标 vs 实测"）。 */
    let frameTargetFps = Math.round((1000 / LED_FRAME_MS) * 1000) / 1000;
    let framePeriodMs = LED_FRAME_MS;
    /**
     * **当前正在等待的间隔**（由上一拍 schedule 决定）。
     * 迟到/欠帧口径必须按它算：空闲 250ms 或冗余 8.33ms 都不是 4.17ms 的错。
     */
    let periodInEffect = LED_FRAME_MS;
    // ── 帧统计（热路径只做整数自增；2 秒窗口滚动才公布）───────────────────────
    let framesRendered = 0;
    let framesSkipped = 0;
    let fpsWindowAt = 0;
    let fpsWindowCount = 0;
    let measuredFps = 0;
    let maxLateMs = 0;
    let frameMaxMs = 0;
    let winMaxLate = 0;
    let winMaxFrame = 0;
    // ── 语义状态（本层只吃"画面"，不碰判定）──────────────────────────────────
    let driving = false;
    /** 保持连续帧的截止时刻（手动画面）。 */
    let holdUntil = 0;
    let lastApplied = OFF_SCENE;
    /** 最近一次看门狗时刻（reap 不需要每帧跑）。 */
    let lastReapAt = 0;
    /**
     * 冗余状态缓存：reap 间隔要看它，但 `link.status()` 会分配对象 ——
     * 不能每帧都问（240fps 热路径），所以每 250ms 才刷新一次。
     */
    let redundantCached = false;
    let reapPolicyAt = 0;
    /** 自检覆盖动画。 */
    let selfTest = null;
    /** 关灯淡出进度。 */
    let fadeOut = null;
    /** 排队中的提示音定时器（stop() 里统一清）。 */
    const beepTimers = new Set();
    function cancelFrameTimer() {
        if (frameTimer === null)
            return;
        try {
            frameTimer();
        }
        catch (e) { /* ignore */ }
        frameTimer = null;
    }
    /**
     * 现在需不需要**连续帧**（按需运行的核心判据）。
     *
     * 需要：自检/手动画面/关灯淡出、链路握手窗口、交叉渐变窗口，以及 running/waiting/error
     * 这类连续动画画面。稳态（off / 已看过的 done）只要心跳 + 看门狗 + 验证帧，
     * 250ms 一拍完全够 —— 空闲时每秒 240 次唤醒纯属浪费。
     */
    function needsContinuousFrames() {
        if (fadeOut !== null || selfTest !== null)
            return true;
        if (now() < holdUntil)
            return true;
        if (!driving)
            return false;
        if (link.needsFrames !== undefined) {
            if (link.needsFrames())
                return true;
        }
        else {
            // 替身/老实现没有 needsFrames 时的保守回退：握手状态 + 最近下发的画面状态
            const state = link.status().state;
            if (state === 'opening' || state === 'verifying')
                return true;
            if (lastApplied.state === 'running' || lastApplied.state === 'waiting'
                || lastApplied.state === 'error' || (lastApplied.flags & SCENE_FLAG.ATTENTION) !== 0)
                return true;
        }
        return false;
    }
    /** 自检到期就交还画面（采样与帧循环都会调用 —— 不能只靠帧循环）。 */
    function expireSelfTest() {
        if (selfTest === null)
            return;
        if (now() - selfTest.startedAt < selfTest.totalMs)
            return;
        selfTest = null;
        link.setOverride(null);
        link.restartFade();
    }
    /** 看门狗 + 链路推进（每帧/每拍都会走这里）。 */
    function tickLink() {
        const t = now();
        try {
            link.tick();
        }
        catch (e) {
            log(`[led] 帧 tick 异常：${e.message}`);
        }
        // 冗余期把看门狗收紧到 250ms：快速探针（800ms 一次、400ms 容忍）才跑得起来。
        // 冗余状态每 250ms 采样一次（status() 会分配对象，不能每帧问）。
        if (t - reapPolicyAt >= 250) {
            reapPolicyAt = t;
            try {
                redundantCached = link.status().redundancy === true;
            }
            catch (e) {
                redundantCached = false;
            }
        }
        if (t - lastReapAt < (redundantCached ? REAP_EVERY_DEGRADED_MS : REAP_EVERY_MS))
            return;
        lastReapAt = t;
        try {
            link.reap();
        }
        catch (e) { /* 看门狗自己绝不抛 */ }
    }
    /**
     * 一拍的推进（旧 controller 的 frameTick）：淡出 → 自检 → 链路。
     * **不**做帧统计；帧循环的一拍与采样驱动的 `tick()` 共用。
     */
    function advance() {
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
            tickLink();
            return;
        }
        // 上电自检：覆盖渲染一段时间后自动交还画面（交接带一段渐变，不硬切）
        if (selfTest !== null) {
            expireSelfTest();
            if (selfTest !== null) {
                tickLink();
                return;
            }
        }
        // 功能关着/未接管：不驱动链路。否则 link.tick() 会自己重连（关掉的灯反复开串口），
        // 而且"重连中"会把空闲节拍又拉回 240fps —— 等于灯关了还在空转。
        if (!driving)
            return;
        tickLink();
    }
    /**
     * 立刻唤醒帧循环：取消待触发的定时器、**马上渲染一帧**、按需切回连续节拍。
     *
     * ⚠️ 不能只在"空闲节拍"时生效：画面变化（preview/点击测试/自检/场景跳变）必须**立刻**
     * 出一帧，不能等下一个 4.17ms / 250ms 周期。旧实现只在 idle 时唤醒，单测里
     * "preview 后下一帧就该是红色"因此变成依赖真实定时器而失败；现场点击测试也要等一拍。
     */
    function wakeFrames() {
        if (!frameStarted || frameInStep)
            return;
        cancelFrameTimer();
        idleMode = false;
        frameExpected = now();
        step();
    }
    /**
     * 帧循环的一拍。
     *
     * 节拍（空闲 250ms / 动画 4.1667ms）由 needsContinuousFrames() 决定，但
     * **迟到/欠帧口径按本拍实际排的周期算** —— 不能拿 4.17ms 去衡量 250ms 的空闲节拍，
     * 否则每一拍都会被记成"丢了 60 帧"（状态页会把空闲误读成严重掉帧）。
     */
    function step() {
        frameTimer = null;
        if (!frameStarted)
            return;
        if (frameInStep) {
            frameWakeQueued = true;
            return;
        }
        frameInStep = true;
        const t0 = now();
        try {
            advance();
        }
        catch (e) { /* 帧级异常不打断运行时 */ }
        const t = now();
        framesRendered += 1;
        const spent = t - t0;
        if (spent > winMaxFrame)
            winMaxFrame = spent;
        // 实测帧率（2 秒窗口）：短窗口会被一次抖动带偏，长窗口才说明"稳不稳"。
        if (fpsWindowAt === 0) {
            fpsWindowAt = t;
            fpsWindowCount = framesRendered;
        }
        else if (t - fpsWindowAt >= 2000) {
            measuredFps = ((framesRendered - fpsWindowCount) * 1000) / (t - fpsWindowAt);
            fpsWindowAt = t;
            fpsWindowCount = framesRendered;
            // 窗口滚动时公布诊断极值（status 里可见），然后清零
            maxLateMs = winMaxLate;
            frameMaxMs = winMaxFrame;
            winMaxLate = 0;
            winMaxFrame = 0;
        }
        // 迟到/欠帧口径按**上一拍实际排的间隔**算（空闲 250ms 与冗余 8.33ms 都不能按 4.17 衡量）
        const scheduled = periodInEffect;
        const late = Math.max(0, t - frameExpected);
        if (late > winMaxLate)
            winMaxLate = late;
        frameExpected += scheduled;
        if (late >= scheduled * 2) {
            // 落后两个周期以上（线程卡了/定时器被压后）：欠的帧丢掉，重新对齐，不补跑
            framesSkipped += Math.round(late / scheduled);
            frameExpected = t + scheduled;
        }
        // 按需切换节拍：连续动画结束 → 空闲；画面/链路需要连续帧 → 动画节拍。
        // 自适应冗余：链路劣化时唯一帧降到 120fps（每帧由链路口发两份，线上占用不变）。
        // 冗余状态用 tickLink() 每 250ms 刷新的缓存 —— 热路径绝不能每帧调 link.status()。
        const nextIdle = !needsContinuousFrames();
        const nextPeriod = nextIdle ? LED_IDLE_FRAME_MS : (redundantCached ? REDUNDANT_FRAME_MS : framePeriodMs);
        let delay;
        if (nextIdle !== idleMode || nextPeriod !== periodInEffect) {
            // 节拍切换（空闲↔动画、健康↔冗余）都重新对齐，避免把旧周期欠账算到新周期上
            idleMode = nextIdle;
            periodInEffect = nextPeriod;
            frameExpected = t + nextPeriod;
            delay = nextPeriod;
        }
        else {
            delay = Math.max(0, frameExpected - t);
        }
        frameInStep = false;
        frameTimer = scheduleFrame(step, delay);
        if (frameWakeQueued) {
            frameWakeQueued = false;
            wakeFrames();
        }
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
    return {
        start() {
            if (frameStarted)
                return;
            const frameMs = clampFrameMs(options.frameMs);
            framePeriodMs = frameMs;
            frameTargetFps = Math.round((1000 / frameMs) * 1000) / 1000; // 4.1667ms → 240（去掉浮点尾巴）
            // 启动先按连续节拍跑：设备可能正等着握手，第一拍后 step() 会自己判断该不该降频。
            frameStarted = true;
            idleMode = false;
            periodInEffect = frameMs;
            frameExpected = now() + frameMs;
            frameTimer = scheduleFrame(step, frameMs);
        },
        stop() {
            frameStarted = false;
            cancelFrameTimer();
            for (const t of beepTimers)
                clearTimeout(t);
            beepTimers.clear();
            selfTest = null;
            fadeOut = null;
            holdUntil = 0;
            link.setOverride(null);
            link.close();
        },
        configure(port, baud) {
            link.configure(port, baud ?? options.baud ?? BAUD_RATE);
        },
        applyScene(scene) {
            lastApplied = scene;
            link.applyScene(scene);
            // 画面一变（或开始交叉渐变）就立刻切回连续帧：空闲节拍下不能等 250ms 才看见变化
            if (needsContinuousFrames())
                wakeFrames();
        },
        setDriving(on) {
            if (driving === on)
                return;
            driving = on;
            if (!on)
                return;
            // **关 → 开**的恢复路径（用户实测两次：关掉再打开，灯概率"丢失"）：
            //   ① 取消正在进行的关灯淡出 —— 否则它会在 250ms 后把刚打开的串口关掉；
            //   ② 把当前画面重新交给链路 —— 关闭期间 fanout 里的 scene 已被淡出改暗、
            //      甚至被 blackout 成 off；不重发的话，重新握手后链路会按"暗/黑"渲染，
            //      要等下一次画面变化才亮（而 running 画面签名可能一直不变）。
            //   ③ 立刻跑一拍 —— fanout 处于 closed 时要在这一拍重新枚举/打开，
            //      不能等空闲节拍的 250ms（避免"打开后空白一拍"）。
            if (fadeOut !== null)
                fadeOut = null;
            if (lastApplied.state !== 'off')
                link.applyScene(lastApplied);
            // 只有"链路已经被 close"（关闭态的收尾）才需要在这一拍重新枚举/打开；
            // 正常首次驱动/运行中切换交给既有帧循环，不要额外插一拍（会打乱帧统计与单测口径）。
            let needsReopen = false;
            try {
                needsReopen = link.status().state === 'disabled';
            }
            catch (e) {
                needsReopen = false;
            }
            if (needsReopen && frameStarted) {
                if (frameInStep) {
                    frameWakeQueued = true;
                    return;
                }
                cancelFrameTimer();
                idleMode = false;
                frameExpected = now();
                step();
            }
        },
        holdContinuous(ms) {
            holdUntil = now() + Math.max(0, Math.trunc(ms) || 0);
            if (needsContinuousFrames())
                wakeFrames();
        },
        startSelfTest(result, totalMs = 2000, brightness = 255) {
            const startedAt = now();
            const total = Math.max(1, Math.trunc(totalMs) || 2000);
            selfTest = { startedAt, result, totalMs: total };
            link.setOverride((t) => renderSelfTest(t, startedAt, result, total, brightness));
            // 自检是连续动画：立刻从空闲节拍切回连续帧
            wakeFrames();
        },
        beep(beep) {
            try {
                return link.beep(beep);
            }
            catch (e) {
                return false;
            }
        },
        beepPattern(pattern) {
            if (pattern.length === 0)
                return false;
            const first = pattern[0];
            if (first === undefined)
                return false;
            let sent = false;
            try {
                sent = link.beep(first.beep);
            }
            catch (e) {
                sent = false;
            }
            if (!sent)
                return false;
            for (const step of pattern.slice(1))
                queueBeep(step.beep, step.at);
            return true;
        },
        rawFrame(frame) {
            try {
                return link.rawFrame(frame);
            }
            catch (e) {
                return false;
            }
        },
        fadeOut(scene, durationMs = FADE_OUT_MS) {
            // 已经在淡出：返回 true（调用方据此**不要**立刻 blackout，否则淡到一半就被掐掉）
            if (fadeOut !== null)
                return true;
            if (!link.status().verified)
                return false;
            // 自检动画让路：关灯优先
            selfTest = null;
            link.setOverride(null);
            fadeOut = { scene, start: now(), duration: Math.max(1, Math.trunc(durationMs) || FADE_OUT_MS) };
            wakeFrames();
            return true;
        },
        flush(scene) {
            try {
                return scene === undefined ? link.flush() : link.flush(scene);
            }
            catch (e) {
                return false;
            }
        },
        close() {
            try {
                link.close();
            }
            catch (e) { /* ignore */ }
        },
        shutdownFade() {
            try {
                if (!link.status().verified) {
                    link.close();
                    return;
                }
                // 用最后下发的画面当淡出起点（控制器已经按亮度上限压过它）
                const base = fadeOut !== null ? fadeOut.scene : lastApplied;
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
        },
        tick() {
            try {
                advance();
            }
            catch (e) {
                log(`[led] 运行时 tick 异常：${e.message}`);
            }
            if (needsContinuousFrames())
                wakeFrames();
        },
        status() {
            const linkStatus = link.status();
            const redundant = linkStatus.redundancy === true;
            return {
                link: linkStatus,
                frames: {
                    targetFps: frameTargetFps,
                    frameMs: framePeriodMs,
                    rendered: framesRendered,
                    skipped: framesSkipped,
                    fps: measuredFps,
                    idle: idleMode,
                    idleFrameMs: LED_IDLE_FRAME_MS,
                    maxLateMs,
                    frameMaxMs,
                    redundant,
                    // 唯一帧目标：健康 240；冗余 120（每帧发两份，线上占用≈54% 不变）
                    uniqueFpsTarget: redundant ? REDUNDANT_TARGET_FPS : Math.round((1000 / framePeriodMs) * 1000) / 1000,
                },
                scene: lastApplied,
                fading: fadeOut !== null,
                selfTest: selfTest !== null,
            };
        },
    };
}
