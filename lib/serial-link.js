// 串口链路层 —— 握手、像素流、去重、重连（纯逻辑 + 注入式打开，便于单测）
//
// 真硬件：AI Status Lights（CH32V003 + 7×WS2812B + 无源蜂鸣器），协议见 led-protocol.ts。
// 这一层只干五件事：
//   1. **握手**：打开后先发 VERIFY，收到 `AI Status Lights OK\r\n` 才算连上 ——
//      这台机器上还插着手机/下载器之类的 COM 口，不能"打开就算成功"；
//   2. **渲染**：把当前语义画面按时刻渲染成 7 颗灯的像素（led-render.ts）；
//   3. **去重**：像素没变就不写（稳态 0 字节/秒；动画时才每帧 26 字节）；
//   4. **心跳**：像素没变也每 1s 重发一次，防止丢帧后灯卡在旧画面上；
//   5. **重连**：端口被拔/被占用/不是本板子时按退避重试（300ms→1s→2s→5s→10s）。
//
// 打开/枚举都是注入的（options.open / options.list），单测用假句柄穷举：
// 写失败、半包回包、握手超时、设备中途掉线、端口从 auto 变成 COM5……
import { BAUD_RATE, LED_COUNT, createReplyScanner, encodeBuzzer, encodeLeds, encodeVerify, frameBytes, pixelsEqual, MODE, } from './led-protocol.js';
import { blendPixels, ditherPixels, renderPixels, smootherstep } from './led-render.js';
import { OFF_SCENE } from './led-scene.js';
import { minWriteGapMs, monotonicNow } from './led-timing.js';
/** 重连退避档位（毫秒）。 */
export const RECONNECT_BACKOFF_MS = [300, 1000, 2000, 5000, 10000]; // 首轮 300ms：插拔后尽快回来
/** 心跳周期：像素没变也重发一次。 */
export const HEARTBEAT_MS = 1000; // 1s：断线后 ~1s 内就能从写失败发现
/** 握手超时：打开后这么久没等到验证回包就判"这不是本板子"。 */
export const VERIFY_TIMEOUT_MS = 1500;
/**
 * `write()` 的返回：**丢弃**（不是故障）。
 *
 * 传入 `coalesce` 的帧是**可丢的动画帧**：传输层有积压时直接丢掉它，让下一次
 * 用"最新画面"重发，而不是让过期画面排队。0 表示"设备没响应"，-1 表示"我们主动丢的"，
 * 两者必须分开 —— 否则一积压就会被判成故障、触发重连。
 */
export const WRITE_DROPPED = -1;
export function createSerialLink(options) {
    const now = options.now ?? monotonicNow;
    const log = options.log ?? (() => { });
    const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    const backoff = options.backoffMs ?? RECONNECT_BACKOFF_MS;
    const verifyTimeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
    let port = String(options.port ?? '').trim();
    let baud = Math.max(1200, Math.trunc(options.baud ?? BAUD_RATE) || BAUD_RATE);
    let handle = null;
    let state = 'idle';
    let openedFor = '';
    /** 上次**握手成功**的端口：重连时直接开它，避免每次都枚举。 */
    let lastGoodPort = '';
    /** 上次枚举时刻（枚举节流：≥5 秒一次；它不是状态源，只是兜底发现）。 */
    let lastEnumerateAt = 0;
    const ENUMERATE_EVERY_MS = 5000;
    /** 是否有一个 open() 正在飞（防止 8ms 帧循环并发 CreateFile 同一端口）。 */
    let opening = false;
    /**
     * 生命周期代次：每次 close/stop 递增。
     * 异步 open() 回来时要对一下代次 —— 否则"打开过程中被关掉"会把一个**已过期**的句柄
     * 装进 handle，之后的读写就打在无效句柄上（koffi 层可能直接崩进程）。
     */
    let gen = 0;
    /** open() 起始时刻（用于打开超时兜底：CreateFile 对已移除设备可能长时间不返回）。 */
    let openStartedAt = 0;
    const OPEN_TIMEOUT_MS = 3000;
    let attempt = 0;
    let nextRetryAt = 0;
    let openedAt = 0;
    let verified = false;
    let lastWriteAt = 0;
    let lastError = '';
    let lastErrorCode = '';
    let framesSent = 0;
    let bytesSent = 0;
    /** 积压时被主动丢掉的动画帧（背压，不是故障）。 */
    let droppedFrames = 0;
    let scene = OFF_SCENE;
    let lastPixels = [];
    let lastSentAt = 0;
    let sentPixels = [];
    /** 看门狗阈值：握手后这么久没成功写出一个字节，就认为设备已经没了。 */
    const STALE_MS = 3000;
    /** 主动探测周期：定期发验证帧，收不到回包才算真的断了。 */
    const PROBE_EVERY_MS = 2500;
    /** 探测容忍时间（板子回 21 字节 ASCII，正常几十毫秒）。 */
    const PROBE_TIMEOUT_MS = 1200;
    let lastProbeAt = 0;
    let probeSentAt = 0;
    /** 交叉渐变的起点（'' = 无渐变）。 */
    let fadeFrom = [];
    let fadeStart = 0;
    let frameSeq = 0;
    /** 当前画面是什么时候开始的（逐灯进入的 age 基准）。 */
    let sceneSince = 0;
    const FADE_MS = 250; // 300ms ÷ 1.2（用户要求渐变整体提速 1.2×）
    /** 覆盖渲染（自检动画）；null = 走常规 renderPixels。 */
    let override = null;
    /**
     * 两次写入的**物理下限**（毫秒）：一帧在线上要占的时间 × 1.15。
     * 26B @115200 ≈ 2.26ms → 2.6ms；只是"不比线速更快地灌数据"的保护，
     * 必须小于帧周期（4.1667ms），否则目标 240fps 会被自己的门控砍掉。
     */
    let minGapMs = minWriteGapMs(frameBytes(MODE.LEDS), baud);
    /** 一帧 LEDS 的字节数（线上时间/占用率都按它算）。 */
    const LEDS_FRAME_BYTES = frameBytes(MODE.LEDS);
    const scanner = createReplyScanner();
    const api = {
        configure(nextPort, nextBaud) {
            const p = String(nextPort ?? '').trim();
            const b = Math.max(1200, Math.trunc(nextBaud ?? baud) || BAUD_RATE);
            if (p === port && b === baud)
                return;
            log(`[led] 串口配置变化：${port || 'auto'}@${baud} → ${p || 'auto'}@${b}`);
            port = p;
            baud = b;
            minGapMs = minWriteGapMs(LEDS_FRAME_BYTES, baud);
            closeHandle('配置变化');
            attempt = 0;
            nextRetryAt = 0;
            state = 'idle';
        },
        applyScene(next) {
            // 画面一变就记下"从哪淡入"：240Hz 下这 300ms 的交叉渐变看起来才是连续的，
            // 否则白→绿是硬切（用户明确要"曲速渐变"）。
            const nextSig = `${next.state}|${next.flags}`;
            const prevSig = `${scene.state}|${scene.flags}`;
            if (nextSig !== prevSig) {
                fadeFrom = lastPixels.length > 0 ? lastPixels : [];
                fadeStart = now();
                sceneSince = now();
            }
            scene = next;
        },
        tick() {
            const t = now();
            if (handle === null) {
                // ⚠️ opening 守卫：open() 是异步的，而帧循环 4ms 一次 —— 没有守卫会
                // 并发 CreateFile 同一个端口，产生多个句柄；之后在已关闭/泄漏的句柄上
                // 读写会让 koffi 打到无效句柄，直接崩进程（"插灯时 DSH 崩溃"）。
                if (opening) {
                    // 打开超时兜底：CreateFile 对"已移除但端口名还在"的设备可能长时间不返回。
                    // 不兜底的话 opening 永远为 true → 再也不重试 → 灯彻底卡死。
                    if (openStartedAt > 0 && t - openStartedAt > OPEN_TIMEOUT_MS) {
                        opening = false;
                        gen += 1; // 迟到的句柄会被代次校验丢弃并关闭
                        openStartedAt = 0;
                        fail('打开串口超时（设备可能已移除）', 'open-failed');
                    }
                    return;
                }
                if (t >= nextRetryAt)
                    void tryOpen(t);
                return;
            }
            // 1) 握手阶段：只等回包
            if (!verified) {
                drainReplies();
                if (verified)
                    return;
                if (t - openedAt >= verifyTimeoutMs) {
                    fail(`串口 ${openedFor} 没有回应验证帧（可能不是 AI Status Lights）`, 'verify-timeout');
                }
                return;
            }
            // 2) 已连上：读回包（板子目前只回验证串，读走避免缓冲堆满）
            drainReplies();
            // 3) 渲染 + 交叉渐变 + 去重 + 心跳
            const target = override !== null ? override(t) : renderPixels(scene, t, t - sceneSince);
            let pixels = target;
            if (fadeStart > 0) {
                const k = smootherstep((t - fadeStart) / FADE_MS);
                if (k >= 1) {
                    fadeStart = 0;
                    fadeFrom = [];
                }
                else {
                    // 渐变期间做时间抖动：低亮度只有几级台阶，交替 ±1 LSB 能铺平；
                    // 稳态不做（否则"画面没变"不成立，会一直写串口）。
                    pixels = ditherPixels(blendPixels(fadeFrom, target, k), frameSeq++);
                }
            }
            // 动画帧也做时间抖动（低亮度只有几级台阶，呼吸/闪烁的底部会"跳格"）；
            // 稳态（如已看过的完成色）不抖，否则去重失效、会一直写串口。
            const animated = scene.state !== 'off' && scene.state !== 'error' && !(scene.state === 'done' && (scene.flags & 2) !== 0);
            if (animated && fadeStart === 0)
                pixels = ditherPixels(pixels, frameSeq++);
            lastPixels = pixels;
            // 安全门控 ①：写入间隔不下于"这帧真正要占用的线上时间"。
            // 它保护的是**串口**（灌爆 USB 转串口的发送缓冲 → 灯一顿一顿的），不是帧率目标；
            // 帧率目标由控制器的帧周期决定，这里只做物理下限。宁可丢帧也不堆队列。
            if (sentPixels.length > 0 && t - lastSentAt < minGapMs)
                return;
            const changed = !pixelsEqual(pixels, sentPixels);
            const due = t - lastSentAt >= heartbeatMs;
            if (!changed && !due)
                return;
            // 安全门控 ②：**可丢的动画帧** —— 传输层积压时直接丢，下一次用最新画面重发。
            // 画面本来就是按绝对时刻算的，过期帧补发只会让灯"越追越晚"。
            if (writeAll(encodeLeds(pixels), true)) {
                sentPixels = pixels;
                lastSentAt = t;
            }
        },
        beep(beep) {
            if (handle === null || !verified)
                return false;
            return writeAll(encodeBuzzer(beep)); // 控制帧：必达，不可丢
        },
        rawFrame(frame) {
            if (handle === null || !verified)
                return false;
            return writeAll(frame); // 控制帧：必达
        },
        restartFade() {
            fadeFrom = lastPixels;
            fadeStart = now();
        },
        setOverride(fn) {
            override = fn;
        },
        flush(next) {
            if (next)
                scene = next;
            if (handle === null || !verified)
                return false;
            const pixels = renderPixels(scene, now());
            lastPixels = pixels;
            fadeStart = 0;
            fadeFrom = [];
            if (writeLanding(encodeLeds(pixels))) {
                sentPixels = pixels;
                lastSentAt = now();
                return true;
            }
            return false;
        },
        reap() {
            if (!verified || handle === null)
                return;
            const t = now();
            // ① 写了这么久都没成功过 → 断
            if (lastWriteAt > 0 && t - lastWriteAt > STALE_MS) {
                fail('串口无响应（可能已拔出）', 'write-failed');
                return;
            }
            // ② **主动探测**：拔掉 USB 后 Windows 往往仍让 WriteFile "成功"（写进缓冲丢弃），
            //    所以"写成功"不能证明设备还在。定期发一帧验证命令，收不到回包才判定断开。
            if (probeSentAt > 0 && t - probeSentAt <= PROBE_TIMEOUT_MS)
                return;
            if (probeSentAt > 0 && t - probeSentAt > PROBE_TIMEOUT_MS) {
                probeSentAt = 0;
                fail('串口无响应（可能已拔出）', 'verify-timeout');
                return;
            }
            if (t - lastProbeAt >= PROBE_EVERY_MS) {
                lastProbeAt = t;
                if (writeAll(encodeVerify()))
                    probeSentAt = t;
            }
        },
        verify() {
            if (handle === null)
                return false;
            return writeAll(encodeVerify());
        },
        status() {
            const t = now();
            return {
                state,
                port: port === '' || port === 'auto' ? (openedFor || 'auto') : port,
                baud,
                lastWriteAt,
                framesSent,
                bytesSent,
                dropped: droppedFrames,
                pending: handle !== null && typeof handle.pending === 'function' ? handle.pending() : 0,
                lastError,
                errorCode: lastErrorCode,
                retryInMs: handle === null && nextRetryAt > t ? nextRetryAt - t : 0,
                verified,
                reply: scanner.stats,
                scene: `${scene.state}${scene.flags ? '+' + scene.flags : ''} bright=${scene.brightness}`,
                pixels: lastPixels,
            };
        },
        close() {
            closeHandle('插件卸载');
            state = 'disabled';
        },
    };
    // ── 内部 ──────────────────────────────────────────────────────────────────
    function closeHandle(why) {
        // 代次自增**放在最前面**：即使此刻没有句柄，也要让"正在飞的 open()"失效，
        // 否则关掉之后那个迟到的句柄会被装回来（之后的读写就打在已过期句柄上）。
        gen += 1;
        if (handle === null)
            return;
        try {
            handle.close();
        }
        catch (e) { /* ignore */ }
        handle = null;
        openedFor = '';
        verified = false;
        sentPixels = [];
        log(`[led] 串口已关闭（${why}）`);
    }
    /** fail() 重入保护：断线熄灯那次写失败绝不能再触发一次 fail（否则递归风暴）。 */
    let inFail = false;
    function fail(message, code = 'open-failed') {
        if (inFail)
            return;
        inFail = true;
        // 断线时先把灯熄掉：WS2812 会锁存最后一帧，不熄就会"卡在最后一个颜色上"，
        // 用户看到的就是"断开重连时卡住不动"。
        try {
            if (handle !== null && verified) {
                // **裸写**：直接调句柄，不走 writeAll（不进统计、不打日志、绝不再次 fail）
                handle.write(encodeLeds(Array.from({ length: LED_COUNT }, () => ({ r: 0, g: 0, b: 0 }))));
            }
        }
        catch (e) { /* ignore */ }
        const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 30000;
        try {
            lastError = message;
            lastErrorCode = code;
            state = 'error';
            closeHandle(message);
            attempt += 1;
            nextRetryAt = now() + wait;
        }
        finally {
            inFail = false;
        }
        failStreak += 1;
        if (failStreak <= 3 || failStreak % 30 === 0) {
            log(`[led] 串口故障（${code || '-'}）：${message}；${wait}ms 后重试（第 ${attempt} 次）`);
        }
    }
    /** 连续失败计数（日志节流用：第 1~3 次逐条，之后每 30 次一条）。 */
    let failStreak = 0;
    /** "写入 0 字节"日志的节流时间戳。 */
    let zeroLogAt = 0;
    function writeAll(frame, coalesce = false) {
        if (handle === null)
            return false;
        try {
            const written = handle.write(frame, { coalesce });
            if (written === WRITE_DROPPED) {
                // 传输层积压 → 这帧主动丢掉（背压），**不是故障**：
                // 不更新 lastWriteAt、不进 framesSent，下一次 tick 会用最新画面重发。
                droppedFrames += 1;
                return false;
            }
            if (written === 0) {
                // 0 字节：串口超时后"成功返回但没传出去"是 Windows 允许的行为。
                // 日志**节流**：帧循环 240 次/秒，每条都记会把日志刷爆（曾经 142ms 内 3372 条）。
                const t = now();
                if (t - zeroLogAt > 2000) {
                    zeroLogAt = t;
                    log('[led] 写入 0 字节（串口超时/设备已移除）');
                }
            }
            if (written !== frame.length) {
                fail(`写入不完整（${written}/${frame.length} 字节）`, 'write-failed');
                return false;
            }
            framesSent += 1;
            bytesSent += written;
            lastWriteAt = now();
            return true;
        }
        catch (e) {
            fail(e.message, 'write-failed');
            return false;
        }
    }
    /**
     * "**必须落地**"的那一帧（熄灯/退出）：句柄支持同步写就等它确认，否则退回异步写。
     *
     * 为什么需要：异步 `write()` 只保证"交给 worker/内核缓冲"。进程退出、worker 被
     * terminate、或者驱动缓冲还满着的时候，那一帧可能根本没发出去 —— 而 WS2812B
     * **锁存最后一帧**，结果就是"DSH 关了，灯还亮在最后一个颜色上"。
     * 同步路径的意义是：等 WriteFile 真的返回成功（= 字节已被驱动接受）再往下走。
     * ⚠️ 它阻塞主线程（一帧 ~2.3ms，最坏等 timeout），只准用在关机类路径上。
     */
    function writeLanding(frame) {
        if (handle === null)
            return false;
        if (typeof handle.writeSync !== 'function')
            return writeAll(frame);
        try {
            const written = handle.writeSync(frame, 400);
            if (written !== frame.length)
                return false; // 别在关机路径上再触发 fail()/重连
            framesSent += 1;
            bytesSent += written;
            lastWriteAt = now();
            return true;
        }
        catch (e) {
            return false;
        }
    }
    function drainReplies() {
        if (handle === null)
            return;
        try {
            const chunk = handle.read();
            if (chunk.length === 0)
                return;
            const found = scanner.push(chunk);
            if (found > 0)
                probeSentAt = 0; // 回包到了：探测通过
            if (found > 0 && !verified) {
                verified = true;
                lastGoodPort = openedFor;
                failStreak = 0;
                attempt = 0;
                lastProbeAt = now();
                probeSentAt = 0;
                state = 'ready';
                attempt = 0;
                lastError = '';
                lastErrorCode = '';
                sentPixels = [];
                log(`[led] 握手成功：${openedFor} 是 AI Status Lights`);
            }
        }
        catch (e) {
            fail(`读取串口失败：${e.message}`, 'read-failed');
        }
    }
    async function tryOpen(t) {
        if (opening)
            return;
        opening = true;
        openStartedAt = now();
        state = 'opening';
        // 本次打开所属的代次：任何 await 回来之后都要对一次，过期就整轮作废
        const openGen = gen;
        try {
            let target = port;
            if (target === '' || target === 'auto') {
                // **事件驱动优先**：重连时先直接开"上次成功的端口"。CreateFile 对不存在的口
                // 会立刻失败（~20ms），比枚举便宜，也不会撞上"设备正在插拔、枚举卡住"的窗口。
                // 只有从没成功过 / 直连刚失败过才枚举，且枚举节流到 ≥5s 一次（它只是兜底发现）。
                const nowMs = now();
                if (lastGoodPort !== '' && nowMs - lastEnumerateAt < ENUMERATE_EVERY_MS) {
                    target = lastGoodPort;
                }
                else {
                    const ports = await options.list();
                    if (openGen !== gen)
                        return; // 枚举期间连接被关闭/复位 → 这次结果作废
                    lastEnumerateAt = now();
                    target = pickAutoPort(ports);
                    if (target === '' && lastGoodPort !== '')
                        target = lastGoodPort;
                    if (target === '') {
                        lastError = '没有找到任何串口设备';
                        lastErrorCode = 'no-device';
                        state = 'error';
                        nextRetryAt = t + 10000;
                        attempt += 1;
                        return;
                    }
                    log(`[led] 自动选择串口：${target}（候选 ${ports.map((p) => p.path).join(', ') || '无'}）`);
                }
            }
            let h;
            try {
                h = await options.open(target, baud);
            }
            catch (e) {
                // 直连那个口失败（拔了/换了口）→ 下一轮改成枚举
                if (target !== '' && target === lastGoodPort)
                    lastGoodPort = '';
                throw e;
            }
            // **代次校验（关键）**：await 期间连接可能被关掉/改配置/已判故障，
            // 这时返回的句柄已经过期。直接装进去 → 之后在已关闭的句柄上读写
            // （koffi 层可能直接崩进程）。过期就**关掉它**，一个字段都不改。
            if (openGen !== gen) {
                try {
                    h.close();
                }
                catch (e) { /* ignore */ }
                return;
            }
            handle = h;
            openedFor = target;
            openedAt = now();
            verified = false;
            scanner.reset();
            state = 'verifying';
            // 把传输层的异步故障接进链路（worker 卡死/串口线程退出/写超时）。
            // 没有这一步，"看门狗 terminate + 报故障"那一套是死代码：故障只能等
            // 下一次写返回 0 才被发现，画面静止时会拖很久（灯看起来就是"卡住"）。
            // ⚠️ 代次校验：旧 worker 的迟到故障绝不能让**新**连接走重连。
            const faultGen = openGen;
            h.onFault = (message) => {
                if (faultGen !== gen)
                    return;
                fail(message, 'write-failed');
            };
            // 立刻发验证帧：板子回 ASCII，回包到了才算连上
            writeAll(encodeVerify());
        }
        catch (e) {
            fail(e.message, 'open-failed');
        }
        finally {
            opening = false;
        }
    }
    return api;
}
/**
 * 自动挑端口：优先 CH340（VID/名称里带 CH34 的往往是这类小板子），
 * 其次 COM 号大的（USB 转串口通常是后插的、号更大），最后任意可用口。
 * 真正的"是不是本板子"由握手回答，所以这里只需要一个合理的起点。
 */
export function pickAutoPort(ports) {
    if (ports.length === 0)
        return '';
    const ch340 = ports.find((p) => /CH34|ch340|usb.?serial/i.test(`${p.path} ${p.label}`));
    if (ch340)
        return ch340.path;
    const numbered = ports
        .map((p) => ({ p, n: Number((/^COM(\d+)/i.exec(p.path) ?? [])[1] ?? 0) }))
        .sort((a, b) => b.n - a.n);
    const first = numbered[0];
    return first ? first.p.path : ports[0].path;
}
/** 端口名是否看起来像一个合法串口（防止把 'auto' 之类当端口去打开）。 */
export function isValidPortName(path) {
    const p = String(path ?? '').trim();
    if (p === '' || p.toLowerCase() === 'auto')
        return false;
    return /^(COM\d+|\/dev\/[A-Za-z0-9._-]+)$/i.test(p);
}
