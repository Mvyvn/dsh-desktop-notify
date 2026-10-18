// 串口门面 —— 按平台选实现（宿主只 import 这一个模块）
//
// 为什么要有这一层：win32 实现顶层就 koffi.load('kernel32.dll')，非 Windows 平台
// **绝不能**静态 import（与 winrt.ts / toast-linux.ts 同一约定）。所以这里用
// **动态 import + 平台判定**，把"平台差异"关在一个文件里：两份平台实现都只在
// 真正要用的时候才被求值，Linux 上永远不会去碰 kernel32.dll。
//
// 打开动作因此是异步的（动态 import 本身是 Promise），但**打开之后的写入是同步的**——
// 一次状态变化就写 11 个字节，没有必要为它引入异步队列。
//
// 句柄与端口信息的类型定义在 serial-link.ts（核心层）：这里只做"平台实现 → 结构类型"
// 的适配，保证链路逻辑不依赖任何平台文件。
let win32Module = null;
let posixModule = null;
async function win32() {
    win32Module ??= (await import('./serial-win32.js'));
    return win32Module;
}
async function posix() {
    posixModule ??= (await import('./serial-posix.js'));
    return posixModule;
}
/** 本平台是否有串口能力。 */
export function serialSupported() {
    return process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin';
}
/** 枚举本机串口（失败返回空数组，绝不抛）。 */
export async function listSerialPorts() {
    try {
        if (process.platform === 'win32')
            return (await win32()).listWin32SerialPorts();
        if (process.platform === 'linux' || process.platform === 'darwin')
            return (await posix()).listPosixSerialPorts();
    }
    catch (e) { /* 没权限/没设备：当作没有 */ }
    return [];
}
/**
 * 打开串口。
 * @param options.dtr 只在 win32 有效（默认 false：不置 DTR/RTS，避免一开端口就复位单片机）
 */
export async function openSerialPort(path, baud, options = {}) {
    if (process.platform === 'win32')
        return (await win32()).openWin32Serial(path, baud, options);
    if (process.platform === 'linux' || process.platform === 'darwin')
        return (await posix()).openPosixSerial(path, baud);
    throw new Error(`当前平台（${process.platform}）没有串口实现`);
}
