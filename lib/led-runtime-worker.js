// 灯运行时 worker —— 帧循环/渲染/串口链路的**专用线程**。
//
// 为什么单开一个线程（用户任务4）：灯的逻辑必须**并发于**主插件逻辑，两个方向都要隔离：
//   · 灯相关阻塞（串口原生调用卡死、渲染/GC、自检动画）不能破坏主插件；
//   · 主线程偶发 30~196ms 停顿（其它会话重负载）不能把 240fps 的灯动画拖出掉帧。
// serial-win32 本来就把原生调用关进了 serial-worker；这里再把"节拍 + 渲染"也搬进来，
// 于是主线程对灯只剩下"下发语义画面"这一个动作。
//
// 线程结构（嵌套 worker 是允许的）：
//   DSH 主线程
//     └─ led-runtime-worker（本文件：帧循环 + 渲染 + fanout）
//          └─ serial-worker（serial-win32 每次 open 一条：所有 koffi 调用）
//
// 协议（parentPort）：
//   入: {t:'config', port, baud} | {t:'scene', scene} | {t:'drive', on} | {t:'hold', ms}
//     | {t:'selfTest', result, totalMs, brightness?} | {t:'beep', beep}
//     | {t:'beepPattern', steps} | {t:'raw', data:ArrayBuffer}
//     | {t:'fadeOut', scene, durationMs} | {t:'flush', scene?} | {t:'close'}
//     | {t:'status', seq} | {t:'shutdown', sync:SharedArrayBuffer}
//   出: {t:'ready', pid, tag}
//     | {t:'status', seq, link, frames, scene, fading, selfTest}
//     | {t:'log', line} | {t:'error', message} | {t:'closed'} | {t:'shutdownDone'}
//
// scene 合并：主线程每拍都会 applyScene，这里只保留**最新**一个，在事件循环的下一拍
// 统一下发 —— 多个排队消息不会变成多次渲染。
//
// shutdown：worker 执行同步淡出 + 全黑 + close，把结果写进 SharedArrayBuffer 并
// Atomics.notify；主线程最多等 1200ms（**退出路径**）。写 SAB 之后 worker 立刻退出。
import { parentPort, workerData } from 'node:worker_threads';
import { createLedRuntime } from './led-runtime.js';
import { BAUD_RATE, clampByte, clampInt } from './led-protocol.js';
import { LED_FRAME_MS } from './led-timing.js';
import { listSerialPorts, openSerialPort } from './serial-port.js';
const data = workerData ?? {};
const tag = String(data.tag ?? 'led');
/**
 * 测试/排障开关：`serial: false` 时不碰真串口（list 返回空、open 抛错）。
 * 冒烟测试用它验证"没有设备 → state=error/no-device → 可正常退出"这条路径。
 */
const fakeSerial = data.serial === false;
const baud = Number.isFinite(Number(data.baud)) ? Math.trunc(Number(data.baud)) : BAUD_RATE;
const frameMs = Number.isFinite(Number(data.frameMs)) && Number(data.frameMs) > 0
    ? Number(data.frameMs)
    : LED_FRAME_MS;
const port = parentPort;
if (port === null)
    throw new Error('led-runtime-worker 只能作为 worker_threads 入口运行');
function send(msg, transfer) {
    try {
        if (transfer === undefined)
            port.postMessage(msg);
        else
            port.postMessage(msg, transfer);
    }
    catch (e) { /* 主线程已经走了：消息没人收就算了 */ }
}
/** 测试桩：没有串口设备（list 空 + open 抛错），用于冒烟测试。 */
const fakeOpen = async (_path, _baud) => {
    throw new Error('测试桩：本机没有串口设备');
};
const fakeList = async () => [];
const runtime = createLedRuntime({
    port: typeof data.port === 'string' && data.port.trim() !== '' ? data.port.trim() : 'auto',
    baud,
    frameMs,
    open: fakeSerial ? fakeOpen : openSerialPort,
    list: fakeSerial ? fakeList : listSerialPorts,
    log: (line) => send({ t: 'log', line }),
});
// ── scene 合并：只保留最新 ──────────────────────────────────────────────────
let pendingScene = null;
let sceneScheduled = false;
function flushScene() {
    sceneScheduled = false;
    const scene = pendingScene;
    pendingScene = null;
    if (scene !== null)
        runtime.applyScene(scene);
}
function scheduleScene(scene) {
    pendingScene = scene;
    if (sceneScheduled)
        return;
    sceneScheduled = true;
    setImmediate(flushScene);
}
// ── 状态上报：每 500ms 一次 + 状态一变立即一次 ─────────────────────────────
let statusSeq = 0;
let lastSignature = '';
function statusMessage() {
    const st = runtime.status();
    statusSeq += 1;
    return {
        t: 'status', seq: statusSeq,
        link: st.link, frames: st.frames, scene: st.scene,
        fading: st.fading, selfTest: st.selfTest,
    };
}
/** 轻量签名：只放"变了就该让主线程知道"的字段（帧计数每帧都变，不进签名）。 */
function statusSignature() {
    const st = runtime.status();
    const l = st.link;
    return [
        l.state, l.verified ? 1 : 0, l.verifiedCount, l.boardCount, l.errorCode, l.port,
        st.frames.idle ? 1 : 0,
        st.scene.state, st.scene.flags, st.scene.brightness,
        st.fading ? 1 : 0, st.selfTest ? 1 : 0,
    ].join('|');
}
function maybeSendStatus() {
    const signature = statusSignature();
    if (signature === lastSignature)
        return;
    lastSignature = signature;
    send(statusMessage());
}
const statusTimer = setInterval(() => {
    // 定时上报：主线程的 status() 是缓存快照，靠它保持新鲜（帧计数/诊断极值也在里面）
    lastSignature = statusSignature();
    send(statusMessage());
}, 500);
if (typeof statusTimer.unref === 'function')
    statusTimer.unref();
// ── 消息处理 ───────────────────────────────────────────────────────────────
function frameView(value) {
    if (value instanceof ArrayBuffer)
        return Buffer.from(value);
    if (ArrayBuffer.isView(value))
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return Buffer.alloc(0);
}
function normalizeBeep(raw) {
    return {
        freqHz: clampInt(Number(raw?.freqHz ?? 1800) || 1800, 1, 20000),
        volume: clampByte(Number(raw?.volume ?? 60)),
        durationMs: clampInt(Number(raw?.durationMs ?? 120) || 120, 1, 5000),
    };
}
function normalizePattern(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const step of raw) {
        if (!step || typeof step !== 'object')
            continue;
        out.push({ at: Math.max(0, Math.trunc(Number(step.at) || 0)), beep: normalizeBeep(step.beep) });
    }
    return out;
}
function doShutdown(sync) {
    let ok = 1;
    try {
        runtime.shutdownFade();
    }
    catch (e) {
        ok = 0;
        send({ t: 'error', message: `退出熄灯失败：${e.message}` });
    }
    try {
        runtime.stop();
    }
    catch (e) { /* ignore */ }
    try {
        if (sync instanceof SharedArrayBuffer) {
            const view = new Int32Array(sync);
            Atomics.store(view, 0, ok);
            Atomics.notify(view, 0);
        }
    }
    catch (e) { /* ignore */ }
    send({ t: 'shutdownDone' });
    // SAB 已经写了：主线程不需要再等消息，worker 立刻退（不把进程/线程钉住）
    setImmediate(() => {
        try {
            process.exit(0);
        }
        catch (e) { /* ignore */ }
    });
}
port.on('message', (msg) => {
    try {
        switch (msg?.t) {
            case 'config':
                runtime.configure(String(msg.port ?? 'auto'), Number(msg.baud) || baud);
                break;
            case 'scene':
                if (msg.scene && typeof msg.scene === 'object')
                    scheduleScene(msg.scene);
                break;
            case 'drive':
                runtime.setDriving(msg.on === true);
                break;
            case 'hold':
                runtime.holdContinuous(Number(msg.ms) || 0);
                break;
            case 'selfTest':
                runtime.startSelfTest(String(msg.result), Number(msg.totalMs) || 2000, Number.isFinite(Number(msg.brightness)) ? Number(msg.brightness) : 255);
                break;
            case 'beep':
                runtime.beep(normalizeBeep(msg.beep));
                break;
            case 'beepPattern':
                runtime.beepPattern(normalizePattern(msg.steps));
                break;
            case 'raw': {
                const frame = frameView(msg.data);
                if (frame.length > 0)
                    runtime.rawFrame(frame);
                break;
            }
            case 'fadeOut':
                if (msg.scene && typeof msg.scene === 'object') {
                    runtime.fadeOut(msg.scene, Number(msg.durationMs) || undefined);
                }
                break;
            case 'flush':
                runtime.flush(msg.scene && typeof msg.scene === 'object' ? msg.scene : undefined);
                break;
            case 'close':
                runtime.close();
                send({ t: 'closed' });
                break;
            case 'status':
                send(statusMessage());
                break;
            case 'shutdown':
                doShutdown(msg.sync);
                return;
            default:
                break;
        }
        maybeSendStatus();
    }
    catch (e) {
        send({ t: 'error', message: e.message });
    }
});
// 启动帧循环，然后通知主线程"就绪"（桥据此区分"启动失败"与"运行中崩溃"）。
runtime.start();
send({ t: 'ready', pid: process.pid, tag });
lastSignature = statusSignature();
send(statusMessage());
