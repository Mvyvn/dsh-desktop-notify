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
import { openSync, readSync, writeSync, closeSync, constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0o4000;
const O_NOCTTY = fsConstants.O_NOCTTY ?? 0o400;
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
    return {
        path,
        baud,
        write(bytes) {
            if (closed)
                return 0;
            try {
                return writeSync(fd, bytes);
            }
            catch (e) {
                return 0;
            }
        },
        read(max = 256) {
            if (closed)
                return Buffer.alloc(0);
            try {
                const buf = Buffer.alloc(max);
                const n = readSync(fd, buf, 0, max, null);
                return n > 0 ? buf.subarray(0, n) : Buffer.alloc(0);
            }
            catch (e) {
                return Buffer.alloc(0); // EAGAIN：没有数据
            }
        },
        close() {
            if (closed)
                return;
            closed = true;
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
