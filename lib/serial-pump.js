// 串口读取泵的节奏策略 —— 纯函数（无定时器、无 I/O），便于单测穷举。
//
// 背景：worker 的读取泵过去固定每 2ms 轮一次，即使根本没数据可读。
// 一小时约 180 万轮，每轮还要两次 Buffer.alloc（256B 读缓冲 + 4B 已读字节数）。
// 但串口上**没有主动上报**：主机只在两种窗口里需要"尽快收包"——
//   · 刚打开端口（固件可能立刻回握手信息，也可能稍后收到验证帧才回包）；
//   · 刚写出一帧验证帧 MODE=0x00（固件回 21 字节 ASCII "AI Status Lights OK\r\n"）。
// 其余时间收包慢一点，只影响"探测回包"的到达延迟（链路侧容忍 1.2s），
// 而动画帧是写路径（消息驱动）推下去的，完全不依赖读取泵。
//
// 所以：窗口内 2ms（FAST），窗口外 30ms（IDLE）。窗口 2000ms 覆盖链路
// "打开后 400ms 补发一次验证帧"与"探测回包最多等 1200ms"这两个时间点。
import { HEAD1, HEAD2, MODE } from './led-protocol.js';
/** 窗口内的轮询间隔（ms）：验证回包通常几毫秒内到。 */
export const SERIAL_PUMP_FAST_MS = 2;
/** 窗口外的轮询间隔（ms）：只收探测回包，不需要更密（25~50 区间）。 */
export const SERIAL_PUMP_IDLE_MS = 30;
/** "可能在等回包"的窗口时长（ms）。 */
export const SERIAL_REPLY_WINDOW_MS = 2000;
/**
 * 开一个回包窗口，返回窗口截止时刻（与 `nowMs` 同一时间源）。
 * 时长非法/非正 = 不开窗口（返回 `nowMs`），避免一个坏参数把泵永远钉在 2ms。
 */
export function replyWindowFor(nowMs, windowMs = SERIAL_REPLY_WINDOW_MS) {
    const span = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0;
    return nowMs + span;
}
/** 此刻该用多长间隔轮询：还在等回包用 2ms，其余用 30ms（边界即窗口到期）。 */
export function pumpIntervalMs(nowMs, replyWindowUntil) {
    return nowMs < replyWindowUntil ? SERIAL_PUMP_FAST_MS : SERIAL_PUMP_IDLE_MS;
}
/**
 * 是不是一帧验证命令（`55 AA | MODE | ... | BB`，第 3 字节是 MODE）。
 *
 * 只用于"写成功之后开回包窗口"的判定，不解析余下字节 ——
 * 校验和/帧尾由固件判定，主机这里多解析一遍只会引入第二套真相。
 */
export function isVerifyFrame(bytes) {
    return bytes.length >= 3 && bytes[0] === HEAD1 && bytes[1] === HEAD2 && bytes[2] === MODE.VERIFY;
}
