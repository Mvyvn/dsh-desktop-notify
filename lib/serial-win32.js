// 串口传输层 —— Windows（koffi 直调 kernel32，无原生依赖）
//
// 为什么不用 `serialport` 之类的 npm 包：
//   · 本插件的依赖面刻意保持极小（现有依赖只有 schemastery + koffi），
//     `serialport` 带原生二进制，装不上/版本不匹配时整个插件就加载不了；
//   · koffi 已经是本仓库既有依赖（WinRT Toast 在用），直接调 CreateFileW /
//     SetCommState / WriteFile 就够了 —— 我们只需要"打开、配置、写字节、非阻塞读"。
//
// ⚠️ 本模块顶层就 koffi.load('kernel32.dll')：只能在 win32 平台被 import
//    （与 winrt.ts / win32-registry.ts 同一约定）。
//
// 实测确认（本机 Windows，koffi 3.x，2026-10）：
//   · `CreateFileW` 声明成 'void*' 返回值时，koffi 返回 **BigInt**；打不开端口得到
//     0xFFFFFFFFFFFFFFFF（INVALID_HANDLE_VALUE），句柄为 0 表示 NULL；
//   · 该 BigInt 可以直接回传给其它 'void*' 形参（CloseHandle/GetCommState 均正常）；
//   · 打不开时 GetCommState 返回 0 —— 用它做"句柄真的能用吗"的二次校验，
//     免得把 INVALID_HANDLE_VALUE 当成有效句柄继续写。
import * as koffi from 'koffi';
const kernel32 = koffi.load('kernel32.dll');
const CreateFileW = kernel32.func('CreateFileW', 'void*', ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*']);
const GetCommState = kernel32.func('GetCommState', 'int32', ['void*', 'void*']);
const SetCommState = kernel32.func('SetCommState', 'int32', ['void*', 'void*']);
const SetCommTimeouts = kernel32.func('SetCommTimeouts', 'int32', ['void*', 'void*']);
const WriteFile = kernel32.func('WriteFile', 'int32', ['void*', 'void*', 'uint32', 'void*', 'void*']);
const ReadFile = kernel32.func('ReadFile', 'int32', ['void*', 'void*', 'uint32', 'void*', 'void*']);
const CloseHandle = kernel32.func('CloseHandle', 'int32', ['void*']);
const PurgeComm = kernel32.func('PurgeComm', 'int32', ['void*', 'uint32']);
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const PURGE_TXABORT = 0x0001;
const PURGE_RXABORT = 0x0002;
const PURGE_TXCLEAR = 0x0004;
const PURGE_RXCLEAR = 0x0008;
/** DCB 结构体长度（Win32 固定 28 字节）。 */
const DCB_SIZE = 28;
/** COMMTIMEOUTS 长度（5 × DWORD）。 */
const TIMEOUTS_SIZE = 20;
const MAXDWORD = 0xffffffff;
/** 句柄归一成 BigInt：koffi 对 'void*' 有时给 BigInt、有时给 Number。 */
function toBigInt(handle) {
    if (typeof handle === 'bigint')
        return handle;
    if (typeof handle === 'number')
        return BigInt(Math.trunc(handle));
    return 0n;
}
/** 句柄是否无效（NULL 或 INVALID_HANDLE_VALUE，32/64 位都认）。 */
export function isInvalidHandle(handle) {
    const value = toBigInt(handle);
    return value === 0n || value === 0xffffffffn || value === 0xffffffffffffffffn;
}
/**
 * 打开串口（8N1、无流控）。
 *
 * DTR/RTS 默认**都不置位**：CH340/CP2102 的 DTR/RTS 常被接到 MCU 的复位脚，
 * 一打开端口就把板子复位是常见坑（表现为"每次启动灯都重启一次"）。
 * 需要复位能力时由调用方显式传 `dtr: true`。
 */
export function openWin32Serial(path, baud, options = {}) {
    // COM10 及以上必须加 \\.\ 前缀（COM1..COM9 也接受这种写法）
    const devicePath = /^\\\\\.\\/.test(path) ? path : `\\\\.\\${path.replace(/^\\\\\.\\/, '')}`;
    const handle = CreateFileW(devicePath, GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, null);
    if (isInvalidHandle(handle)) {
        throw new Error(`打不开串口 ${path}（可能被占用、已拔出，或名字不对）`);
    }
    const dcb = Buffer.alloc(DCB_SIZE);
    dcb.writeUInt32LE(DCB_SIZE, 0);
    if (GetCommState(handle, dcb) === 0) {
        CloseHandle(handle);
        throw new Error(`串口 ${path} 无法读取配置（GetCommState 失败）`);
    }
    dcb.writeUInt32LE(baud >>> 0, 4);
    // flags：bit0 fBinary 必须为 1，否则 Win32 串口行为未定义；
    //        fDtrControl(bit4-5)/fRtsControl(bit12-13)：0=disable 1=enable
    let flags = 1;
    if (options.dtr === true)
        flags |= 1 << 4;
    if (options.rts === true)
        flags |= 1 << 12;
    dcb.writeUInt32LE(flags >>> 0, 8);
    dcb.writeUInt16LE(0, 12); // wReserved
    dcb.writeUInt16LE(0, 14); // XonLim
    dcb.writeUInt16LE(0, 16); // XoffLim
    dcb.writeUInt8(8, 18); // ByteSize = 8
    dcb.writeUInt8(0, 19); // Parity = none
    dcb.writeUInt8(0, 20); // StopBits = 1
    dcb.writeUInt8(0, 21); // XonChar
    dcb.writeUInt8(0, 22); // XoffChar
    dcb.writeUInt8(0, 23); // ErrorChar
    dcb.writeUInt8(0, 24); // EofChar
    dcb.writeUInt8(0, 25); // EvtChar
    dcb.writeUInt16LE(0, 26); // wReserved1
    if (SetCommState(handle, dcb) === 0) {
        CloseHandle(handle);
        throw new Error(`串口 ${path} 不支持 ${baud} 波特率（SetCommState 失败）`);
    }
    // 读超时设成"立即返回"：ReadFile 不阻塞事件循环，主机侧用轮询就能收 ACK/按键事件。
    const timeouts = Buffer.alloc(TIMEOUTS_SIZE);
    timeouts.writeUInt32LE(MAXDWORD, 0); // ReadIntervalTimeout
    timeouts.writeUInt32LE(0, 4); // ReadTotalTimeoutMultiplier
    timeouts.writeUInt32LE(0, 8); // ReadTotalTimeoutConstant
    timeouts.writeUInt32LE(0, 12); // WriteTotalTimeoutMultiplier
    timeouts.writeUInt32LE(0, 16); // WriteTotalTimeoutConstant
    if (SetCommTimeouts(handle, timeouts) === 0) {
        CloseHandle(handle);
        throw new Error(`串口 ${path} 无法设置超时（SetCommTimeouts 失败）`);
    }
    PurgeComm(handle, PURGE_TXCLEAR | PURGE_RXCLEAR);
    let closed = false;
    return {
        path,
        baud,
        write(bytes) {
            if (closed)
                return 0;
            const written = Buffer.alloc(4);
            const ok = WriteFile(handle, bytes, bytes.length, written, null);
            if (ok === 0)
                return 0;
            return written.readUInt32LE(0);
        },
        read(max = 256) {
            if (closed)
                return Buffer.alloc(0);
            const buf = Buffer.alloc(max);
            const got = Buffer.alloc(4);
            const ok = ReadFile(handle, buf, max, got, null);
            if (ok === 0)
                return Buffer.alloc(0);
            const n = got.readUInt32LE(0);
            return n > 0 ? buf.subarray(0, n) : Buffer.alloc(0);
        },
        close() {
            if (closed)
                return;
            closed = true;
            try {
                PurgeComm(handle, PURGE_TXABORT | PURGE_RXABORT | PURGE_TXCLEAR | PURGE_RXCLEAR);
            }
            catch (e) { /* ignore */ }
            try {
                CloseHandle(handle);
            }
            catch (e) { /* ignore */ }
        },
    };
}
/**
 * 枚举本机串口（注册表 HARDWARE\DEVICEMAP\SERIALCOMM）。
 *
 * 只用注册表而不是 SetupAPI：SetupAPI 要写一大坨结构体与设备信息集遍历，
 * 而这里只需要"有哪些 COMn 可用"。键不存在（本机一个串口都没有）时返回空数组。
 * @returns 形如 [{ path: 'COM3', label: '\\Device\\VCP0' }]
 */
export function listWin32SerialPorts() {
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
    catch (e) { /* 没有注册表权限/键不存在：当作"没有串口" */ }
    return out;
}
