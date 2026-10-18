// 串口链路层 —— 去重、心跳、重连、收包（纯逻辑 + 注入式打开，便于单测）
//
// 这一层只干四件事，全部与"插上的是什么硬件"无关：
//   1. **去重**：只有画面签名变了才写帧（稳态平均带宽 < 20 B/s 的关键）；
//   2. **心跳**：画面没变也每 5s 重发一次 SCENE —— 固件据此判定"主机还活着"，
//      丢一帧不会让灯一直卡在旧状态；
//   3. **重连**：端口被拔/被占用/波特率不对时，按退避重试（1s→2s→5s→10s→30s），
//      而不是疯狂重试把宿主日志刷爆；
//   4. **收包**：非阻塞读回 ACK/PONG/按键事件（按键可以当"我知道了"，见 led-judge）。
//
// 打开动作是注入进来的（options.open），所以单测能用假句柄穷举：
// 写失败、半包、CRC 错、设备中途掉线、端口从 auto 变成 COM5……
// 真实现见 serial-port.ts（Windows: koffi 直调 kernel32）。
import { encodeFrame, createFrameParser, scenePayload, frameTypeName, FRAME, REPLY, LED_WIRE_VERSION, } from './led-protocol.js';
/** 重连退避档位（毫秒）。 */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
/** 心跳周期：画面没变也重发一次（固件端 3× 心跳没收到就进"失联"表现）。 */
export const HEARTBEAT_MS = 5000;
/**
 * 建链路。**不会自己开定时器**：tick() 由宿主按自己的节奏调（便于测试与热重载清理）。
 */
export function createSerialLink(options) {
    const now = options.now ?? (() => Date.now());
    const log = options.log ?? (() => { });
    const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    const backoff = options.backoffMs ?? RECONNECT_BACKOFF_MS;
    let port = String(options.port ?? '').trim();
    let baud = Math.max(1200, Math.trunc(options.baud) || 115200);
    let handle = null;
    let state = 'idle';
    let openedFor = ''; // 当前句柄对应的端口（配置变了要重开）
    let attempt = 0;
    let nextRetryAt = 0;
    let lastWriteAt = 0;
    let lastError = '';
    let framesSent = 0;
    let bytesSent = 0;
    let device = null;
    let seq = 0;
    let wanted = null;
    let sentSignature = '';
    let lastHeartbeatAt = 0;
    const parser = createFrameParser();
    const api = {
        configure(nextPort, nextBaud) {
            const p = String(nextPort ?? '').trim();
            const b = Math.max(1200, Math.trunc(nextBaud) || 115200);
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
        apply(scene) {
            wanted = scene;
        },
        tick() {
            const t = now();
            // 1) 连接管理
            if (handle === null && t >= nextRetryAt)
                void tryOpen(t);
            if (handle === null)
                return;
            // 2) 收包（非阻塞）：ACK/PONG/按键事件
            drainInput();
            // 3) 发送：画面变化立刻发；否则按心跳重发
            if (wanted === null)
                return;
            const signature = sceneSignature(wanted);
            const changed = signature !== sentSignature;
            const due = t - lastHeartbeatAt >= heartbeatMs;
            if (!changed && !due)
                return;
            if (sendScene(wanted, t)) {
                sentSignature = signature;
                lastHeartbeatAt = t;
            }
        },
        sendFrame(type, payload) {
            if (handle === null)
                return false;
            try {
                const frame = encodeFrame(type, nextSeq(), payload);
                const written = handle.write(frame);
                if (written !== frame.length) {
                    fail(`写入不完整（${written}/${frame.length} 字节）`);
                    return false;
                }
                framesSent += 1;
                bytesSent += written;
                lastWriteAt = now();
                return true;
            }
            catch (e) {
                fail(e.message);
                return false;
            }
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
                retryInMs: handle === null && nextRetryAt > t ? nextRetryAt - t : 0,
                device,
                parser: parser.stats,
                scene: wanted === null ? '(未设置)' : sceneSignature(wanted),
            };
        },
        close() {
            closeHandle('插件卸载');
            state = 'disabled';
        },
    };
    const nextSeq = () => {
        seq = (seq + 1) & 0xff;
        return seq;
    };
    function closeHandle(why) {
        if (handle === null)
            return;
        try {
            handle.close();
        }
        catch (e) { /* ignore */ }
        handle = null;
        openedFor = '';
        log(`[led] 串口已关闭（${why}）`);
    }
    function fail(message) {
        lastError = message;
        state = 'error';
        closeHandle(message);
        const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 30000;
        attempt += 1;
        nextRetryAt = now() + wait;
        log(`[led] 串口故障：${message}；${wait}ms 后重试（第 ${attempt} 次）`);
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
            state = 'ready';
            attempt = 0;
            lastError = '';
            sentSignature = '';
            lastHeartbeatAt = 0;
            parser.reset();
            log(`[led] 串口已打开：${target}@${baud}`);
            // 握手：告诉固件线协议版本，顺带探能力（没回也不影响，SCENE 是自解释的）
            api.sendFrame(FRAME.HELLO, [LED_WIRE_VERSION, 0]);
        }
        catch (e) {
            fail(e.message || '打开串口失败');
        }
    }
    function sendScene(scene, t) {
        const input = {
            state: scene.state,
            flags: scene.flags,
            brightness: scene.brightness,
            progress: scene.progress,
        };
        const ok = api.sendFrame(FRAME.SCENE, scenePayload(input));
        if (ok)
            lastWriteAt = t;
        return ok;
    }
    function drainInput() {
        if (handle === null)
            return;
        let chunk;
        try {
            chunk = handle.read(256);
        }
        catch (e) {
            fail(`读取串口失败：${e.message}`);
            return;
        }
        if (chunk.length === 0)
            return;
        for (const frame of parser.push(chunk)) {
            switch (frame.type) {
                case REPLY.ACK:
                    break;
                case REPLY.NAK:
                    log(`[led] 固件回 NAK seq=${frame.payload[0]} code=${frame.payload[1]}`);
                    break;
                case REPLY.HELLO_ACK: {
                    device = {
                        wireVersion: frame.payload[0] ?? 0,
                        leds: frame.payload[1] ?? 0,
                        maxBrightness: frame.payload[2] ?? 255,
                        caps: (frame.payload[3] ?? 0) | ((frame.payload[4] ?? 0) << 8),
                    };
                    log(`[led] 固件握手：wire=v${device.wireVersion} leds=${device.leds} caps=0x${device.caps.toString(16)}`);
                    if (device.wireVersion > LED_WIRE_VERSION) {
                        log(`[led] 警告：固件协议版本 v${device.wireVersion} 高于主机认识的 v${LED_WIRE_VERSION}，可能有新帧无法使用`);
                    }
                    break;
                }
                case REPLY.PONG:
                    break;
                case REPLY.EVENT: {
                    const code = frame.payload[0] ?? 0;
                    const arg = frame.payload[1] ?? 0;
                    log(`[led] 设备事件 code=${code} arg=${arg}`);
                    options.onEvent?.({ code, arg });
                    break;
                }
                default:
                    log(`[led] 收到未处理的回包：${frameTypeName(frame.type)}`);
            }
        }
    }
    return api;
}
/** 画面签名（去重用）：只包含真正会被线上帧表达的信息。 */
export function sceneSignature(scene) {
    return `${scene.state}|${scene.flags}|${scene.brightness}|${scene.progress}`;
}
/**
 * 从枚举结果里挑一个"最像是我们那块板子"的端口。
 *
 * 经验规则：USB 转串口（CH340/CP2102/FT232）拿到的是 COM3 及以上；
 * COM1/COM2 往往是主板自带的、或者被别的软件占着。所以优先取编号大的。
 * 排序理由写在这里，免得以后有人以为这是随便排的。
 */
export function pickAutoPort(ports) {
    if (ports.length === 0)
        return '';
    const score = (path) => {
        const win = /^COM(\d+)$/i.exec(path);
        if (win) {
            const n = Number(win[1]);
            return n >= 3 ? 1000 + n : n; // USB 转串口优先，且编号大的更可能是它
        }
        if (/^\/dev\/tty(USB|ACM)\d+$/.test(path))
            return 2000;
        if (/^\/dev\/cu\.usb/.test(path))
            return 2000;
        if (/^\/dev\/tty(AMA|S)\d+$/.test(path))
            return 10;
        return 1;
    };
    return [...ports].sort((a, b) => score(b.path) - score(a.path))[0]?.path ?? '';
}
/** 端口名是否像个合法串口（防止把任意字符串塞进 CreateFileW）。 */
export function isValidPortName(path) {
    const text = String(path).trim();
    if (text === '')
        return false;
    if (/^COM\d{1,3}$/i.test(text))
        return true;
    if (/^\/dev\/[A-Za-z0-9._-]{1,64}$/.test(text))
        return true;
    return false;
}
