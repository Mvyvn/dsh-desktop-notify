// 串口链路层 —— 握手、像素流、去重、重连（纯逻辑 + 注入式打开，便于单测）
//
// 真硬件：AI Status Lights（CH32V003 + 7×WS2812B + 无源蜂鸣器），协议见 led-protocol.ts。
// 这一层只干五件事：
//   1. **握手**：打开后先发 VERIFY，收到 `AI Status Lights OK\r\n` 才算连上 ——
//      这台机器上还插着手机/下载器之类的 COM 口，不能"打开就算成功"；
//   2. **渲染**：把当前语义画面按时刻渲染成 7 颗灯的像素（led-render.ts）；
//   3. **去重**：像素没变就不写（稳态 0 字节/秒；动画时才每帧 26 字节）；
//   4. **心跳**：像素没变也每 5s 重发一次，防止丢帧后灯卡在旧画面上；
//   5. **重连**：端口被拔/被占用/不是本板子时按退避重试（1s→2s→5s→10s→30s）。
//
// 打开/枚举都是注入的（options.open / options.list），单测用假句柄穷举：
// 写失败、半包回包、握手超时、设备中途掉线、端口从 auto 变成 COM5……
import { BAUD_RATE, createReplyScanner, encodeBuzzer, encodeLeds, encodeVerify, pixelsEqual, } from './led-protocol.js';
import { renderPixels } from './led-render.js';
import { OFF_SCENE } from './led-scene.js';
/** 重连退避档位（毫秒）。 */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
/** 心跳周期：像素没变也重发一次。 */
export const HEARTBEAT_MS = 5000;
/** 握手超时：打开后这么久没等到验证回包就判"这不是本板子"。 */
export const VERIFY_TIMEOUT_MS = 1500;
export function createSerialLink(options) {
    const now = options.now ?? (() => Date.now());
    const log = options.log ?? (() => { });
    const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    const backoff = options.backoffMs ?? RECONNECT_BACKOFF_MS;
    const verifyTimeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
    let port = String(options.port ?? '').trim();
    let baud = Math.max(1200, Math.trunc(options.baud ?? BAUD_RATE) || BAUD_RATE);
    let handle = null;
    let state = 'idle';
    let openedFor = '';
    let attempt = 0;
    let nextRetryAt = 0;
    let openedAt = 0;
    let verified = false;
    let lastWriteAt = 0;
    let lastError = '';
    let lastErrorCode = '';
    let framesSent = 0;
    let bytesSent = 0;
    let scene = OFF_SCENE;
    let lastPixels = [];
    let lastSentAt = 0;
    let sentPixels = [];
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
            closeHandle('配置变化');
            attempt = 0;
            nextRetryAt = 0;
            state = 'idle';
        },
        applyScene(next) {
            scene = next;
        },
        tick() {
            const t = now();
            if (handle === null) {
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
            // 3) 渲染 + 去重 + 心跳
            const pixels = renderPixels(scene, t);
            lastPixels = pixels;
            const changed = !pixelsEqual(pixels, sentPixels);
            const due = t - lastSentAt >= heartbeatMs;
            if (!changed && !due)
                return;
            if (writeAll(encodeLeds(pixels))) {
                sentPixels = pixels;
                lastSentAt = t;
            }
        },
        beep(beep) {
            if (handle === null || !verified)
                return false;
            return writeAll(encodeBuzzer(beep));
        },
        rawFrame(frame) {
            if (handle === null || !verified)
                return false;
            return writeAll(frame);
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
    function fail(message, code = 'open-failed') {
        lastError = message;
        lastErrorCode = code;
        state = 'error';
        closeHandle(message);
        const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 30000;
        attempt += 1;
        nextRetryAt = now() + wait;
        log(`[led] 串口故障（${code || '-'}）：${message}；${wait}ms 后重试（第 ${attempt} 次）`);
    }
    function writeAll(frame) {
        if (handle === null)
            return false;
        try {
            const written = handle.write(frame);
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
    function drainReplies() {
        if (handle === null)
            return;
        try {
            const chunk = handle.read();
            if (chunk.length === 0)
                return;
            const found = scanner.push(chunk);
            if (found > 0 && !verified) {
                verified = true;
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
        state = 'opening';
        try {
            let target = port;
            if (target === '' || target === 'auto') {
                const ports = await options.list();
                target = pickAutoPort(ports);
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
            const h = await options.open(target, baud);
            handle = h;
            openedFor = target;
            openedAt = now();
            verified = false;
            scanner.reset();
            state = 'verifying';
            // 立刻发验证帧：板子回 ASCII，回包到了才算连上
            writeAll(encodeVerify());
        }
        catch (e) {
            fail(e.message, 'open-failed');
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
