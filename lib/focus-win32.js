// 前台激活（仅 win32）：用 koffi 直接调 user32，不 spawn PowerShell。
//
// 这是**最简单**的 Win32 尝试（约 2s 内有限重试）：
//   枚举顶层窗口 → 找标题含 dsh/deepseek/harness 的浏览器窗口
//   → ShowWindowAsync(SW_RESTORE) → SetForegroundWindow → 用 GetForegroundWindow 验证，
//   没到前台就重新枚举再试。
// 不做 COM/UIA/Esc/AttachThreadInput/TOPMOST；后台进程被前台锁拒绝时最终记录失败。
//
// ⚠️ 本模块顶层 load user32.dll：只能在 win32 平台动态 import（index.ts 已按平台判断）。
import * as koffi from 'koffi';
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('EnumWindows', 'int', [koffi.pointer(EnumWindowsProc), 'intptr_t']);
const IsWindowVisible = user32.func('IsWindowVisible', 'int', ['void *']);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', ['void *', 'void *', 'int']);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['void *', 'void *', 'int']);
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['void *', 'void *']);
const ShowWindowAsync = user32.func('ShowWindowAsync', 'int', ['void *', 'int']);
const SetForegroundWindow = user32.func('SetForegroundWindow', 'int', ['void *']);
const GetForegroundWindow = user32.func('GetForegroundWindow', 'void *', []);
const IsIconic = user32.func('IsIconic', 'int', ['void *']);
const SystemParametersInfoW = user32.func('SystemParametersInfoW', 'int', ['uint32', 'uint32', 'void *', 'uint32']);
const GetLastInputInfo = user32.func('GetLastInputInfo', 'int', ['void *']);
const OpenProcess = kernel32.func('OpenProcess', 'void *', ['uint32', 'int', 'uint32']);
const QueryFullProcessImageNameW = kernel32.func('QueryFullProcessImageNameW', 'int', ['void *', 'uint32', 'void *', 'void *']);
const CloseHandle = kernel32.func('CloseHandle', 'int', ['void *']);
const GetLastError = kernel32.func('GetLastError', 'uint32', []);
const SetLastError = kernel32.func('SetLastError', 'void', ['uint32']);
const GetTickCount = kernel32.func('GetTickCount', 'uint32', []);
const GetCurrentProcessId = kernel32.func('GetCurrentProcessId', 'uint32', []);
const SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
const SW_RESTORE = 9;
/** 前台已在浏览器时直接成功；否则等通知中心关闭/窗口创建，再有限重试。 */
const MAX_ATTEMPTS = 8;
const RETRY_INTERVAL_MS = 150;
const SHOW_SETTLE_MS = 50;
const VERIFY_MS = 120;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** 真正的浏览器可执行名；Chrome_WidgetWin_1 也被 VS Code/Electron 使用，必须按进程名排除。 */
const BROWSER_EXES = new Set(['firefox', 'chrome', 'msedge', 'brave', 'vivaldi', 'opera', 'librewolf']);
const DSH_TITLE = /dsh|deepseek|harness/i;
function readWindowString(fn, hwnd, maxChars = 1024) {
    const buf = Buffer.alloc(maxChars * 2);
    const n = Number(fn(hwnd, buf, maxChars));
    if (!Number.isFinite(n) || n <= 0)
        return '';
    return buf.toString('utf16le', 0, Math.min(n, maxChars) * 2);
}
function processExeName(hwnd) {
    try {
        const pidBuf = Buffer.alloc(4);
        GetWindowThreadProcessId(hwnd, pidBuf);
        const pid = pidBuf.readUInt32LE(0);
        if (!pid)
            return '';
        const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (!handle)
            return '';
        try {
            const buf = Buffer.alloc(2048);
            const sizeBuf = Buffer.alloc(4);
            sizeBuf.writeUInt32LE(buf.length / 2, 0);
            if (!QueryFullProcessImageNameW(handle, 0, buf, sizeBuf))
                return '';
            const chars = sizeBuf.readUInt32LE(0);
            const full = buf.toString('utf16le', 0, Math.min(chars, buf.length / 2) * 2);
            return full.split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
        }
        finally {
            CloseHandle(handle);
        }
    }
    catch (e) {
        return '';
    }
}
function identifyWindow(hwnd) {
    try {
        if (!hwnd || !IsWindowVisible(hwnd))
            return null;
        const cls = readWindowString(GetClassNameW, hwnd, 256);
        if (cls !== 'MozillaWindowClass' && cls !== 'Chrome_WidgetWin_1' && cls !== 'Chrome_WidgetWin_0')
            return null;
        const exe = processExeName(hwnd);
        if (!BROWSER_EXES.has(exe))
            return null;
        const title = readWindowString(GetWindowTextW, hwnd);
        if (!title)
            return null;
        return { hwnd, title, cls, exe };
    }
    catch (e) {
        return null;
    }
}
function listBrowserWindows() {
    const out = [];
    try {
        EnumWindows((hwnd) => {
            try {
                const c = identifyWindow(hwnd);
                if (c)
                    out.push(c);
            }
            catch (e) { /* 单个窗口失败不影响其它窗口 */ }
            return 1;
        }, 0);
    }
    catch (e) { /* EnumWindows 本身失败 → 没有候选 */ }
    return out;
}
function describeWindow(hwnd) {
    if (!hwnd)
        return null;
    try {
        const pidBuf = Buffer.alloc(4);
        GetWindowThreadProcessId(hwnd, pidBuf);
        return {
            hwnd: String(hwnd),
            pid: pidBuf.readUInt32LE(0),
            exe: processExeName(hwnd),
            cls: readWindowString(GetClassNameW, hwnd, 256),
            title: readWindowString(GetWindowTextW, hwnd),
            visible: Boolean(IsWindowVisible(hwnd)),
            iconic: Boolean(IsIconic(hwnd)),
        };
    }
    catch (e) {
        return { hwnd: String(hwnd), error: String(e.message || e) };
    }
}
/** 记录 Windows 前台判定的当前输入；SetForegroundWindow 本身没有官方 reason。 */
function snapshot(target, lastSet) {
    let lockTimeoutMs = null;
    try {
        const buf = Buffer.alloc(4);
        if (SystemParametersInfoW(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, buf, 0))
            lockTimeoutMs = buf.readUInt32LE(0);
    }
    catch (e) { /* ignore */ }
    let lastInputAgeMs = null;
    try {
        const buf = Buffer.alloc(8);
        buf.writeUInt32LE(8, 0);
        if (GetLastInputInfo(buf)) {
            const dwTime = buf.readUInt32LE(4);
            lastInputAgeMs = (Number(GetTickCount()) - dwTime) >>> 0;
        }
    }
    catch (e) { /* ignore */ }
    const fgRaw = GetForegroundWindow();
    return {
        currentPid: Number(GetCurrentProcessId()),
        foregroundLockTimeoutMs: lockTimeoutMs,
        lastInputAgeMs,
        foreground: describeWindow(fgRaw ? fgRaw : null),
        target: describeWindow(target),
        set: lastSet ? lastSet.set : false,
        lastError: lastSet ? lastSet.lastError : null,
        note: 'SetForegroundWindow 无官方拒绝原因，以上为判定条件现场',
    };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * 优先使用浏览器 API 的结果：`WindowClient.focus()` 之后，当前前台窗口**就是**目标浏览器窗口。
 * 因此先看 GetForegroundWindow：
 *   1. 前台已是受支持的浏览器 → 直接成功（不枚举、不抢）；
 *   2. 前台还不是（通知中心/窗口创建中）→ 短暂等待后重读；
 *   3. 仍不是 → 才回退枚举，按 DSH 标题/唯一候选选窗口，再 ShowWindow+SetForegroundWindow。
 * 每轮只做一次前台检查，不把枚举当轮询手段；总时长约 2s。
 * @returns null = 始终没有可识别的浏览器窗口；否则返回最后一次结果。
 */
export async function focusBrowserWindow() {
    const startedAt = Date.now();
    let attempts = 0;
    let last = null;
    /** 最后一次"调用了 SetForegroundWindow 但没到前台"的现场；成功靠观察时也能带上。 */
    let lastDenied = null;
    const attachDenied = (result) => {
        if (lastDenied)
            result.diag.lastDenied = lastDenied;
        return result;
    };
    while (attempts < MAX_ATTEMPTS) {
        attempts += 1;
        const fgRaw = GetForegroundWindow();
        const foreground = fgRaw ? fgRaw : null;
        // 浏览器 API 已经把目标窗口激活了：前台浏览器窗口即答案，直接成功。
        const fgCandidate = foreground ? identifyWindow(foreground) : null;
        if (fgCandidate) {
            return {
                title: fgCandidate.title,
                hwnd: fgCandidate.hwnd,
                set: false,
                atFront: true,
                foreground: fgCandidate.hwnd,
                attempts,
                waitedMs: Date.now() - startedAt,
                diag: snapshot(fgCandidate.hwnd, null),
            };
        }
        // 通知中心/激活动画占着前台：等一小段再读；不要在这里枚举窗口。
        await delay(RETRY_INTERVAL_MS);
        const againRaw = GetForegroundWindow();
        const again = againRaw ? againRaw : null;
        const againCandidate = again ? identifyWindow(again) : null;
        if (againCandidate) {
            return {
                title: againCandidate.title,
                hwnd: againCandidate.hwnd,
                set: false,
                atFront: true,
                foreground: againCandidate.hwnd,
                attempts,
                waitedMs: Date.now() - startedAt,
                diag: snapshot(againCandidate.hwnd, null),
            };
        }
        // 仍没有浏览器前台：回退一次性枚举（窗口可能刚创建，标题可能还没稳定）。
        const candidates = listBrowserWindows();
        const matching = candidates.filter((c) => DSH_TITLE.test(c.title));
        const target = matching[0] || (candidates.length === 1 ? candidates[0] : null);
        if (!target) {
            await delay(RETRY_INTERVAL_MS);
            continue;
        }
        ShowWindowAsync(target.hwnd, SW_RESTORE);
        await delay(SHOW_SETTLE_MS);
        SetLastError(0);
        const set = Boolean(SetForegroundWindow(target.hwnd));
        const lastError = Number(GetLastError());
        await delay(VERIFY_MS);
        const finalRaw = GetForegroundWindow();
        const finalFg = finalRaw ? finalRaw : null;
        last = {
            title: target.title,
            hwnd: target.hwnd,
            set,
            atFront: finalFg !== null && finalFg === target.hwnd,
            foreground: finalFg,
            attempts,
            waitedMs: Date.now() - startedAt,
            diag: snapshot(target.hwnd, { set, lastError }),
        };
        if (last.atFront)
            return attachDenied(last);
        lastDenied = snapshot(target.hwnd, { set, lastError });
        await delay(RETRY_INTERVAL_MS);
    }
    return last ? attachDenied(last) : null;
}
