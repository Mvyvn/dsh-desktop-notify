// 串口 worker —— **所有 koffi 同步原生调用都只活在这个线程里**。
//
// 为什么必须有它：Win32 串口同步 API 在"设备被拔掉"时可能永久阻塞
// （WriteFile 写超时为 0 永不返回、CreateFileW 卡在驱动枚举里）。
// 这些调用如果跑在 DSH 主线程，一次拔线就把整个事件循环冻死 ——
// 页面、定时器、日志全停，Ctrl+C 都进不去，只能杀终端。
// 关进 worker 之后：它卡死只死它自己，主线程用 ping/pong 看门狗发现后
// terminate() 掉它、换一个新的，DSH 全程不卡。
//
// 协议（parentPort）：
//   入: {t:'open', path, baud, dtr?, rts?} | {t:'write', data:ArrayBuffer}
//     | {t:'writeSync', data:ArrayBuffer} | {t:'close'} | {t:'ping', seq}
//   出: {t:'opened'} | {t:'openError', message}
//     | {t:'written', n, total} | {t:'writeError', message}
//     | {t:'data', data:ArrayBuffer} | {t:'closed'} | {t:'pong', seq}
//
// `writeSync` 的结果不走消息回传（主线程此时被 Atomics.wait 挡着，收不到消息）：
// 写完直接写进 workerData.sync（SharedArrayBuffer）+ Atomics.notify 唤醒主线程。
import { parentPort, workerData } from 'node:worker_threads';
import koffi from 'koffi';
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const MAXDWORD = 0xffffffff;
const PURGE_TXABORT = 0x0001;
const PURGE_RXABORT = 0x0002;
const PURGE_TXCLEAR = 0x0004;
const PURGE_RXCLEAR = 0x0008;
const DCB_SIZE = 28;
const TIMEOUTS_SIZE = 20;
const kernel32 = koffi.load('kernel32.dll');
const CreateFileW = kernel32.func('CreateFileW', 'void*', ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*']);
const GetCommState = kernel32.func('GetCommState', 'int32', ['void*', 'void*']);
const SetCommState = kernel32.func('SetCommState', 'int32', ['void*', 'void*']);
const SetCommTimeouts = kernel32.func('SetCommTimeouts', 'int32', ['void*', 'void*']);
const PurgeComm = kernel32.func('PurgeComm', 'int32', ['void*', 'uint32']);
const ReadFile = kernel32.func('ReadFile', 'int32', ['void*', 'void*', 'uint32', 'void*', 'void*']);
const WriteFile = kernel32.func('WriteFile', 'int32', ['void*', 'void*', 'uint32', 'void*', 'void*']);
const CloseHandle = kernel32.func('CloseHandle', 'int32', ['void*']);
/** 同步写的回执区：[0] = 结果（>0 已接受字节数 / -1 失败 / 0 还没完成）。 */
const syncBuf = workerData?.sync
    ? new Int32Array(workerData.sync)
    : null;
/**
 * 枚举本机串口（注册表 HARDWARE\DEVICEMAP\SERIALCOMM）。
 *
 * ⚠️ 必须留在 worker 里：设备**正在被拔掉**的那一瞬间，注册表/设备栈的查询会卡住，
 * 主线程上做这件事就是"快速插拔必现卡死"的直接原因（慢速插拔时设备栈稳定，看不出来）。
 */
function listPorts() {
    const out = [];
    try {
        const advapi32 = koffi.load('advapi32.dll');
        const RegOpenKeyExW = advapi32.func('RegOpenKeyExW', 'int32', ['void*', 'str16', 'uint32', 'uint32', 'void**']);
        const RegEnumValueW = advapi32.func('RegEnumValueW', 'int32', ['void*', 'uint32', 'void*', 'void*', 'void*', 'void*', 'void*', 'void*']);
        const RegCloseKey = advapi32.func('RegCloseKey', 'int32', ['void*']);
        const voidPtr = koffi.pointer(koffi.types.void);
        const HKEY_LOCAL_MACHINE = 0x80000002n;
        const KEY_READ = 0x20019;
        const outPtr = koffi.alloc(voidPtr, 1);
        const hr = RegOpenKeyExW(HKEY_LOCAL_MACHINE, 'HARDWARE\\DEVICEMAP\\SERIALCOMM', 0, KEY_READ, outPtr);
        if (hr !== 0)
            return out;
        const key = koffi.decode(outPtr, voidPtr);
        try {
            for (let i = 0; i < 64; i += 1) {
                const nameBuf = Buffer.alloc(512);
                const nameLen = koffi.alloc('uint32', 1);
                koffi.encode(nameLen, 'uint32', 256);
                const typeOut = koffi.alloc('uint32', 1);
                const dataBuf = Buffer.alloc(512);
                const dataLen = koffi.alloc('uint32', 1);
                koffi.encode(dataLen, 'uint32', 256);
                const rc = RegEnumValueW(key, i, nameBuf, nameLen, null, typeOut, dataBuf, dataLen);
                if (rc !== 0)
                    break;
                const port = dataBuf.subarray(0, koffi.decode(dataLen, 'uint32')).toString('utf16le').replace(/\0+$/, '');
                const label = nameBuf.subarray(0, koffi.decode(nameLen, 'uint32') * 2).toString('utf16le').replace(/\0+$/, '');
                if (port)
                    out.push({ path: port, label });
            }
        }
        finally {
            RegCloseKey(key);
        }
    }
    catch (e) { /* 没权限/键不存在：当作没有串口 */ }
    return out;
}
function isInvalidHandle(h) {
    return h === null || h === 0n || h === 0xffffffffn || h === 0xffffffffffffffffn;
}
let handle = null;
let closed = false;
/** 与 serial-win32.ts 完全一致的打开流程（8N1、无流控、不置 DTR/RTS）。 */
function openPort(path, baud, dtr, rts) {
    const devicePath = /^\\\\\.\\/.test(path) ? path : `\\\\.\\${path.replace(/^\\\\\.\\/, '')}`;
    const h = CreateFileW(devicePath, GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, null);
    if (isInvalidHandle(h))
        return `打不开串口 ${path}`;
    const dcb = Buffer.alloc(DCB_SIZE);
    dcb.writeUInt32LE(DCB_SIZE, 0);
    if (GetCommState(h, dcb) === 0) {
        CloseHandle(h);
        return `串口 ${path} 配置读取失败`;
    }
    dcb.writeUInt32LE(baud >>> 0, 4);
    let flags = 1;
    if (dtr)
        flags |= 1 << 4;
    if (rts)
        flags |= 1 << 12;
    dcb.writeUInt32LE(flags >>> 0, 8);
    dcb.writeUInt16LE(0, 12);
    dcb.writeUInt16LE(0, 14);
    dcb.writeUInt16LE(0, 16);
    dcb.writeUInt8(8, 18);
    dcb.writeUInt8(0, 19);
    dcb.writeUInt8(1, 20);
    dcb.writeUInt8(0, 21);
    dcb.writeUInt8(0, 22);
    dcb.writeUInt8(0, 23);
    dcb.writeUInt8(0, 24);
    dcb.writeUInt8(0, 25);
    dcb.writeUInt16LE(0, 26);
    if (SetCommState(h, dcb) === 0) {
        CloseHandle(h);
        return `串口 ${path} 不支持该波特率`;
    }
    const timeouts = Buffer.alloc(TIMEOUTS_SIZE);
    timeouts.writeUInt32LE(MAXDWORD, 0); // ReadIntervalTimeout → ReadFile 立即返回
    timeouts.writeUInt32LE(0, 4);
    timeouts.writeUInt32LE(0, 8);
    // 写超时 200ms：拔线时正在写的 WriteFile 最多卡 200ms 就返回失败（这个 worker 即使卡住也只死自己）
    timeouts.writeUInt32LE(0, 12);
    timeouts.writeUInt32LE(200, 16);
    if (SetCommTimeouts(h, timeouts) === 0) {
        CloseHandle(h);
        return `串口 ${path} 初始化失败`;
    }
    PurgeComm(h, PURGE_TXCLEAR | PURGE_RXCLEAR);
    handle = h;
    closed = false;
    return null;
}
/** 读泵：worker 自己每 2ms 轮一次（阻塞也只堵 worker 自己）。 */
const pump = setInterval(() => {
    if (handle === null || closed)
        return;
    try {
        const buf = Buffer.alloc(256);
        const got = Buffer.alloc(4);
        const ok = ReadFile(handle, buf, 256, got, null);
        if (ok === 0)
            return;
        const n = got.readUInt32LE(0);
        if (n > 0)
            parentPort?.postMessage({ t: 'data', data: buf.subarray(0, n) });
    }
    catch (e) {
        try {
            parentPort?.postMessage({ t: 'writeError', seq: 0, message: `读失败：${e.message}` });
        }
        catch (e2) { /* ignore */ }
    }
}, 2);
if (typeof pump.unref === 'function')
    pump.unref();
parentPort?.on('message', (msg) => {
    try {
        if (msg.t === 'ping') {
            parentPort?.postMessage({ t: 'pong', seq: msg.seq });
            return;
        }
        if (msg.t === 'list') {
            const ports = listPorts();
            parentPort?.postMessage({ t: 'ports', seq: msg.seq, ports });
            return;
        }
        if (msg.t === 'open') {
            const err = openPort(String(msg.path), Number(msg.baud), msg.dtr === true, msg.rts === true);
            parentPort?.postMessage(err === null ? { t: 'opened' } : { t: 'openError', message: err });
            return;
        }
        if (msg.t === 'write') {
            if (handle === null || closed) {
                parentPort?.postMessage({ t: 'writeError', seq: msg.seq, message: '串口已关闭' });
                return;
            }
            const bytes = Buffer.from(msg.data);
            const written = Buffer.alloc(4);
            const ok = WriteFile(handle, bytes, bytes.length, written, null);
            const n = ok === 0 ? 0 : written.readUInt32LE(0);
            parentPort?.postMessage(n === bytes.length
                ? { t: 'written', seq: msg.seq, n, total: bytes.length }
                : { t: 'writeError', seq: msg.seq, message: `写入不完整（${n}/${bytes.length} 字节）` });
            return;
        }
        if (msg.t === 'writeSync') {
            // 同步写：主线程在 Atomics.wait 上等结果（熄灯那一帧必须真的交出去）。
            let n = -1;
            if (handle !== null && !closed) {
                try {
                    const bytes = Buffer.from(msg.data);
                    const written = Buffer.alloc(4);
                    const ok = WriteFile(handle, bytes, bytes.length, written, null);
                    const got = ok === 0 ? -1 : written.readUInt32LE(0);
                    n = got === bytes.length ? bytes.length : -1; // 短写按失败算（整帧语义）
                }
                catch (e) {
                    n = -1;
                }
            }
            if (syncBuf !== null) {
                Atomics.store(syncBuf, 0, n);
                Atomics.notify(syncBuf, 0);
            }
            return;
        }
        if (msg.t === 'close') {
            if (!closed) {
                closed = true;
                // ⚠️ 只清**接收**缓冲：PURGE_TXABORT/TXCLEAR 会把还在发的一帧（例如退出前的全黑帧）
                // 直接丢弃 → 灯留在最后那个颜色上。
                try {
                    if (handle !== null)
                        PurgeComm(handle, PURGE_RXABORT | PURGE_RXCLEAR);
                }
                catch (e) { /* ignore */ }
                try {
                    if (handle !== null)
                        CloseHandle(handle);
                }
                catch (e) { /* ignore */ }
                handle = null;
            }
            parentPort?.postMessage({ t: 'closed' });
            return;
        }
    }
    catch (e) {
        try {
            parentPort?.postMessage({ t: 'writeError', message: e.message });
        }
        catch (e2) { /* ignore */ }
    }
});
// worker 就绪信号（主线程据此知道 koffi 在这个线程里加载成功）
parentPort?.postMessage({ t: 'ready', pid: process.pid, tag: workerData?.tag ?? '' });
