// AI Status Lights 串口协议 —— 真硬件（CH32V003F4P6 + 7×WS2812B + 无源蜂鸣器）
//
// 依据：https://github.com/Mvyvn/AI_Status_Lights（README 与 `User/protocol.c` 已核对）
//
//   +------+------+------+------------------+----------+------+
//   | 0x55 | 0xAA | MODE | PAYLOAD (0..21B) | CHECKSUM | 0xBB |
//   +------+------+------+------------------+----------+------+
//
//   校验：从 0x55 开始累加到 payload 最后字节，取低 8 位（**不含帧尾 0xBB**）
//   命令：0x00 验证（回 ASCII "AI Status Lights OK\r\n"）
//         0x01 设置 7 颗灯颜色（payload 21B = 7×(R,G,B)）
//         0x02 蜂鸣（payload 5B = 频率 u16LE + 音量 u8 + 时长 u16LE）
//   容错：校验错/帧尾错/未知 MODE 整帧丢弃；`55 55 AA` 也能正确重同步；
//         帧内字节间隔超过 20ms 视为半截帧丢弃（固件的 20ms 看门狗）。
//
// ⚠️ 与上一版（自造 A5 5A + CRC8 + 语义帧）完全不同：那是"板子还没打、固件没写"时的
// 设计稿。真固件只有这 3 条命令，**动画必须在主机渲染**成 7 颗灯的像素再推下去：
// 26 字节/帧，30fps ≈ 780 B/s，115200 只占 ~7%。
//
// 本模块是纯函数（无 I/O、无定时器），主机编码与回包解析都能被单测穷举。
/** 串口参数由固件固定：115200 8-N-1。 */
export const BAUD_RATE = 115200;
/** 板载灯珠数量（固件写死 7 颗，索引 0 = 最靠近 MCU 的那颗）。 */
export const LED_COUNT = 7;
/** 帧头 / 帧尾 / 命令码。 */
export const HEAD1 = 0x55;
export const HEAD2 = 0xaa;
export const TAIL = 0xbb;
export const MODE = { VERIFY: 0x00, LEDS: 0x01, BUZZER: 0x02 };
/** 各命令的 payload 长度（与固件 `protocol_payload_len()` 一致）。 */
export const PAYLOAD_LEN = {
    [MODE.VERIFY]: 0,
    [MODE.LEDS]: LED_COUNT * 3,
    [MODE.BUZZER]: 5,
};
/** 验证帧的固定回包（21 字节 ASCII）。 */
export const VERIFY_REPLY = 'AI Status Lights OK\r\n';
/** 半截帧看门狗：固件 20ms，主机侧按同样口径判"这帧还没收完"。 */
export const FRAME_TIMEOUT_MS = 20;
export function clampByte(value) {
    if (!Number.isFinite(value))
        return 0;
    const n = Math.trunc(value);
    if (n < 0)
        return 0;
    if (n > 255)
        return 255;
    return n;
}
export function clampInt(value, lo, hi) {
    if (!Number.isFinite(value))
        return lo;
    const n = Math.trunc(value);
    if (n < lo)
        return lo;
    if (n > hi)
        return hi;
    return n;
}
/** 累加和：从帧头 0x55 开始累加，低 8 位（不含帧尾）。 */
export function checksum(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 1)
        sum = (sum + (bytes[i] ?? 0)) & 0xff;
    return sum;
}
/** 组一帧：`55 AA MODE PAYLOAD CHECKSUM BB`。 */
export function encodeFrame(mode, payload = []) {
    const expected = PAYLOAD_LEN[mode];
    if (expected === undefined)
        throw new Error(`未知 MODE 0x${clampByte(mode).toString(16)}`);
    if (payload.length !== expected) {
        throw new Error(`MODE 0x${mode.toString(16)} 需要 ${expected} 字节载荷，收到 ${payload.length}`);
    }
    const body = Buffer.allocUnsafe(3 + payload.length);
    body[0] = HEAD1;
    body[1] = HEAD2;
    body[2] = clampByte(mode);
    for (let i = 0; i < payload.length; i += 1)
        body[3 + i] = clampByte(payload[i] ?? 0);
    const frame = Buffer.allocUnsafe(body.length + 2);
    body.copy(frame, 0);
    frame[body.length] = checksum(body);
    frame[body.length + 1] = TAIL;
    return frame;
}
/** 验证帧（5 字节）。 */
export function encodeVerify() {
    return encodeFrame(MODE.VERIFY, []);
}
/** 7 颗灯的颜色帧（26 字节）。亮度由主机渲染时自己乘（固件没有亮度命令）。 */
export function encodeLeds(pixels) {
    if (pixels.length !== LED_COUNT)
        throw new Error(`需要 ${LED_COUNT} 颗灯，收到 ${pixels.length} 颗`);
    const payload = [];
    for (const px of pixels)
        payload.push(clampByte(px.r), clampByte(px.g), clampByte(px.b));
    return encodeFrame(MODE.LEDS, payload);
}
/** 蜂鸣帧（10 字节）。 */
export function encodeBuzzer(beep) {
    const freq = clampInt(beep.freqHz, 20, 20000);
    const volume = clampInt(beep.volume, 0, 100);
    const duration = clampInt(beep.durationMs, 0, 65535);
    return encodeFrame(MODE.BUZZER, [
        freq & 0xff, (freq >> 8) & 0xff,
        volume,
        duration & 0xff, (duration >> 8) & 0xff,
    ]);
}
export function createReplyScanner() {
    const needle = Buffer.from(VERIFY_REPLY, 'ascii');
    let buffer = Buffer.alloc(0);
    const stats = { verifies: 0, dropped: 0 };
    return {
        push(chunk) {
            if (chunk.length === 0)
                return 0;
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            let found = 0;
            for (;;) {
                const at = buffer.indexOf(needle);
                if (at < 0)
                    break;
                found += 1;
                stats.verifies += 1;
                buffer = buffer.subarray(at + needle.length);
            }
            // 有界：最多留"needle 长度 - 1"字节（可能是下一帧回包的开头）
            if (buffer.length > needle.length) {
                stats.dropped += buffer.length - (needle.length - 1);
                buffer = buffer.subarray(buffer.length - (needle.length - 1));
            }
            return found;
        },
        reset() {
            buffer = Buffer.alloc(0);
        },
        get stats() {
            return stats;
        },
    };
}
/** 调试用：一帧的可读描述。 */
export function describeFrame(frame) {
    if (frame.length < 5)
        return `raw(${frame.length}B)`;
    const mode = frame[2] ?? 0;
    const name = mode === MODE.VERIFY ? 'VERIFY' : mode === MODE.LEDS ? 'LEDS' : mode === MODE.BUZZER ? 'BUZZER' : `MODE(0x${mode.toString(16)})`;
    return `${name} ${frame.length}B`;
}
// ── 动画用的纯工具 ─────────────────────────────────────────────────────────
/** 把 0..255 的亮度乘到通道上（主机端亮度：固件没有亮度命令）。 */
export function scaleColor(color, level) {
    const k = clampInt(level, 0, 255);
    return {
        r: Math.round((color.r * k) / 255),
        g: Math.round((color.g * k) / 255),
        b: Math.round((color.b * k) / 255),
    };
}
/** 两个像素缓冲是否逐字节相同（帧去重：相同就不写串口）。 */
export function pixelsEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i += 1) {
        const x = a[i];
        const y = b[i];
        if (!x || !y)
            return false;
        if (x.r !== y.r || x.g !== y.g || x.b !== y.b)
            return false;
    }
    return true;
}
