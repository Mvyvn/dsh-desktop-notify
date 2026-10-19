// 串口传输层 —— Linux / macOS 兜底实现
//
// 目标平台是 Windows（见 serial-win32.ts 的 koffi 直调），这一份是**尽力而为**的兜底：
//   · 用 `stty` 配置波特率（termios 的 ioctl 在 Linux 是 TCSETS2、在 macOS 是 IOSSIOSPEED，
//     结构体布局还随平台变；为了不引原生依赖，交给系统自带的 stty 最稳）；
//   · 打开设备一律带 O_NONBLOCK + O_NOCTTY：否则某些 USB 串口在 DTR 未拉高时会
//     **阻塞打开**，把宿主事件循环钉死；
//   · 读也是非阻塞的：没有数据返回空 Buffer（EAGAIN 与"读到 0 字节"同等处理）。
//
// 能力边界写在文档里：Windows 是一等公民，POSIX 只承诺"能点灯"。
//
// ⚠️ 非阻塞写的坑（这次补齐）：`O_NONBLOCK` 下 `writeSync` 可能**只写出去一部分**
// （内核发送缓冲快满），也可能直接抛 EAGAIN。上一版把它当"写成功/写失败"处理，
// 高频推帧时会**把一整帧截断**：固件收到半帧 → 校验错 → 整帧丢弃，表现是灯偶尔顿一下。
// 现在这里有一个小的有界发送队列：短写留下余量、EAGAIN 留到下一次 pump（每次
// read/write 都会 pump），动画帧满了就丢（`WRITE_DROPPED`），控制帧满了才报失败。
import { openSync, readSync, writeSync as fsWriteSync, closeSync, constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { WRITE_DROPPED } from './serial-link.js';
import { createTxQueue } from './serial-tx.js';
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0o4000;
const O_NOCTTY = fsConstants.O_NOCTTY ?? 0o400;
/** 空读取的共享返回值：`read()` 每帧都会被调一次，没数据时不该每次分配。 */
const EMPTY = Buffer.alloc(0);
/** 同步小睡的复用等待区（drain 会按 1ms 反复睡，不能每次 new 一块 SharedArrayBuffer）。 */
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
/** 同步小睡（只在同步写/关机路径用：此刻不该再排事件循环）。 */
function sleepBrief(ms) {
    try {
        Atomics.wait(sleepBuf, 0, 0, ms);
    }
    catch (e) { /* 极端环境没有 Atomics：直接不睡 */ }
}
/**
 * 打开串口（8N1、raw、无流控）。
 * @throws 打不开设备或 stty 配置失败时抛错（调用方据此走重连退避）
 */
export function openPosixSerial(path, baud) {
    let fd = -1;
    try {
        fd = openSync(path, fsConstants.O_RDWR | O_NOCTTY | O_NONBLOCK);
    }
    catch (e) {
        throw new Error(`打不开串口 ${path}：${e.message}`);
    }
    // stty 配置：raw（不做任何字符转换）+ 8N1 + 关流控。失败即视为不可用（宁可报错也别乱发字节）。
    const args = ['-F', path, 'raw', String(baud), 'cs8', '-parenb', '-cstopb', '-crtscts', '-ixon', '-ixoff'];
    const stty = spawnSync('stty', args, { timeout: 3000 });
    if (stty.error || stty.status !== 0) {
        // macOS 的 stty 用 -f 而不是 -F
        const fallback = spawnSync('stty', ['-f', path, 'raw', String(baud), 'cs8', '-parenb', '-cstopb'], { timeout: 3000 });
        if (fallback.error || fallback.status !== 0) {
            try {
                closeSync(fd);
            }
            catch (e) { /* ignore */ }
            throw new Error(`无法配置 ${path}`);
        }
    }
    let closed = false;
    /**
     * 发送队列（与 Windows 共用同一套语义，见 serial-tx.ts）：
     * 动画帧最新优先、控制帧必达 FIFO、短写留余量。**同步写也排队**——
     * 过去它绕过队列直接写，熄灯帧可能先被接受，旧帧余量再被 close 追发上去（顺序就乱了）。
     */
    const tx = createTxQueue(4);
    /**
     * 读取缓冲复用：`read()` 每帧（4ms）都会被调一次，过去即使没数据也 `Buffer.alloc(max)`。
     * 这里复用一块缓冲；**只在真的读到字节时才复制出去**，所以返回值语义不变
     * （调用方拿到的是独立 Buffer，不会在下一次 read 时被改写）。
     */
    let readBuf = null;
    let readBufSize = 0;
    const readInto = (size) => {
        if (readBuf === null || readBufSize !== size) {
            readBuf = Buffer.allocUnsafe(size);
            readBufSize = size;
        }
        return readBuf;
    };
    /** 真正写一次；EAGAIN（缓冲满）当 0 处理，交给队列下次再试。 */
    const writeOnce = (buf) => {
        try {
            return fsWriteSync(fd, buf);
        }
        catch (e) {
            return 0;
        }
    };
    return {
        path,
        baud,
        write(bytes, options) {
            if (closed)
                return 0;
            const result = tx.push(bytes, options?.coalesce === true);
            if (result === 'dropped')
                return WRITE_DROPPED; // 动画帧被最新帧顶掉：不是故障
            if (result === 'full')
                return 0; // 真塞不下（队列里全是控制帧/半帧）
            tx.pump(writeOnce);
            // 入队即返回整帧长度（与 win32 句柄的语义一致）；真正的完成由下一次 pump 补上。
            return bytes.length;
        },
        read(max = 256) {
            if (closed)
                return EMPTY;
            tx.pump(writeOnce); // 读之前先把没写完的余量推出去
            const size = Math.max(1, Math.trunc(max) || 256);
            try {
                const buf = readInto(size);
                const n = readSync(fd, buf, 0, size, null);
                // 有数据才复制（回包很少见）；空读零分配
                return n > 0 ? Buffer.from(buf.subarray(0, n)) : EMPTY;
            }
            catch (e) {
                return EMPTY; // EAGAIN：没有数据
            }
        },
        pending() { return tx.size; },
        /**
         * **同步**写一帧（熄灯/退出路径专用）：入队后按 FIFO 排空，最多等 timeoutMs。
         *
         * 关键是**不插队**：它和普通帧走同一条队列，所以顺序天然正确；只有"整个队列排空"
         * 才返回整帧长度，否则返回 0（这一帧可能连一半都没出去，close 时会再尽力一次）。
         * 只保证"字节已被内核接受"，不等于 WS2812 已经刷新（协议没有逐帧回执）。
         */
        writeSync(bytes, timeoutMs = 400) {
            if (closed)
                return 0;
            if (tx.push(bytes, false) !== 'ok')
                return 0;
            const ok = tx.drain({
                writeOnce,
                now: () => Date.now(),
                deadline: Date.now() + Math.max(1, timeoutMs),
                sleep: sleepBrief,
            });
            return ok ? bytes.length : 0;
        },
        close() {
            if (closed)
                return;
            // 收尾：先有界地把队列排空（~20ms）—— 熄灯帧排在队尾，丢掉它 = 退出后灯还亮着
            try {
                tx.drain({
                    writeOnce,
                    now: () => Date.now(),
                    deadline: Date.now() + 20,
                    sleep: sleepBrief,
                });
            }
            catch (e) { /* 最后一次尽力 */ }
            closed = true;
            tx.clear();
            readBuf = null;
            readBufSize = 0;
            try {
                closeSync(fd);
            }
            catch (e) { /* ignore */ }
        },
    };
}
/** 枚举常见串口设备节点（/dev/ttyUSB* /dev/ttyACM* /dev/ttyS* /dev/cu.usb*）。 */
export function listPosixSerialPorts() {
    const out = [];
    let names = [];
    try {
        names = readdirSync('/dev');
    }
    catch (e) {
        return out;
    }
    const patterns = [
        { re: /^ttyUSB\d+$/, label: 'USB 串口' },
        { re: /^ttyACM\d+$/, label: 'USB CDC/ACM' },
        { re: /^cu\.usb\w+$/, label: 'USB 串口 (macOS)' },
        { re: /^ttyAMA\d+$/, label: '板载串口' },
        { re: /^ttyS\d+$/, label: '板载串口' },
    ];
    for (const name of names.sort()) {
        for (const { re, label } of patterns) {
            if (re.test(name)) {
                out.push({ path: `/dev/${name}`, label });
                break;
            }
        }
    }
    return out;
}
