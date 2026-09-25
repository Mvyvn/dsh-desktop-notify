// DSH 桌面通知 — Win32 注册表与等待句柄（koffi 直调 advapi32/kernel32）
//
// 两处用到：
//   · lib/winrt.js        —— 写 AUMID 图标键（Toast 顶部"程序应用图标"）
//   · lib/theme-win32.js  —— 读系统深浅色 + 用 RegNotifyChangeKeyValue 跟踪切换
// 把 koffi 的函数声明集中在这里，避免同一条 DLL 被重复 load/声明（也少一处踩坑面）。
//
// ⚠️ 本模块顶层就 load advapi32.dll：只能在 win32 平台被 import。

import * as koffi from 'koffi'

export const HKEY_CURRENT_USER = 0x80000001n
export const KEY_QUERY_VALUE = 0x0001
export const KEY_SET_VALUE = 0x0002
export const KEY_NOTIFY = 0x0010
export const REG_SZ = 1
export const REG_DWORD = 4
/** 值被改写时通知（RegNotifyChangeKeyValue 的过滤器）。 */
export const REG_NOTIFY_CHANGE_LAST_SET = 0x00000004
export const WAIT_OBJECT_0 = 0
export const WAIT_TIMEOUT = 0x102

const voidPtr = koffi.pointer(koffi.types.void)

const advapi32 = koffi.load('advapi32.dll')
const kernel32 = koffi.load('kernel32.dll')

const RegCreateKeyExW = advapi32.func('RegCreateKeyExW', 'int32',
  ['void*', 'str16', 'uint32', 'void*', 'uint32', 'uint32', 'void*', 'void**', 'void*'])
const RegOpenKeyExW = advapi32.func('RegOpenKeyExW', 'int32',
  ['void*', 'str16', 'uint32', 'uint32', 'void**'])
const RegSetValueExW = advapi32.func('RegSetValueExW', 'int32',
  ['void*', 'str16', 'uint32', 'uint32', 'void*', 'uint32'])
const RegQueryValueExW = advapi32.func('RegQueryValueExW', 'int32',
  ['void*', 'str16', 'void*', 'void*', 'void*', 'void*'])
const RegCloseKey = advapi32.func('RegCloseKey', 'int32', ['void*'])
const RegDeleteKeyW = advapi32.func('RegDeleteKeyW', 'int32', ['void*', 'str16'])
const RegNotifyChangeKeyValue = advapi32.func('RegNotifyChangeKeyValue', 'int32',
  ['void*', 'int32', 'uint32', 'void*', 'int32'])

const CreateEventW = kernel32.func('CreateEventW', 'void*',
  ['void*', 'int32', 'int32', 'str16'])
const WaitForSingleObject = kernel32.func('WaitForSingleObject', 'uint32',
  ['void*', 'uint32'])
const CloseHandle = kernel32.func('CloseHandle', 'int32', ['void*'])

/** 把 HKEY 句柄包成 koffi 能吃的形式（BigInt 预定义键或解码出的指针）。 */
function hkeyArg(hkey) {
  return hkey
}
/**
 * 打开注册表键（只读）。
 * @param {bigint|unknown} root 预定义根键（如 HKEY_CURRENT_USER）
 * @param {string} subKey 子键路径
 * @param {number} access 访问权限位（默认 KEY_QUERY_VALUE）
 * @returns {unknown} 句柄；失败返回 0
 */
export function openKey(root, subKey, access = KEY_QUERY_VALUE) {
  const out = koffi.alloc(voidPtr, 1)
  const hr = RegOpenKeyExW(hkeyArg(root), subKey, 0, access, out)
  if (hr !== 0) return 0
  return koffi.decode(out, voidPtr)
}

/**
 * 创建（或打开）注册表键。
 * @returns {unknown} 句柄；失败返回 0
 */
export function createKey(root, subKey, access = KEY_SET_VALUE | KEY_QUERY_VALUE) {
  const out = koffi.alloc(voidPtr, 1)
  const hr = RegCreateKeyExW(hkeyArg(root), subKey, 0, null, 0, access, null, out, null)
  if (hr !== 0) return 0
  return koffi.decode(out, voidPtr)
}

/** 关闭句柄（0/null 安全）。 */
export function closeKey(hkey) {
  if (!hkey) return
  try { RegCloseKey(hkey) } catch (e) { /* ignore */ }
}

/** 写 REG_SZ。数据是 UTF-16LE + 结尾 NUL 的字节块，koffi 可直接吃 Node Buffer。 */
export function setString(hkey, name, value) {
  const buf = Buffer.from(String(value) + '\0', 'utf16le')
  const hr = RegSetValueExW(hkey, name, 0, REG_SZ, buf, buf.length)
  if (hr !== 0) throw new Error(`RegSetValueExW(${name}) failed: 0x${(hr >>> 0).toString(16)}`)
}

/**
 * 读 REG_SZ。
 * ⚠️ 按 size 逐字节取，不要用 str16 解码：越界读会直接崩进程。
 * @returns {string|undefined}
 */
export function getString(hkey, name, maxBytes = 1024) {
  const typeOut = koffi.alloc('uint32', 1)
  const sizeOut = koffi.alloc('uint32', 1)
  koffi.encode(sizeOut, 'uint32', maxBytes)
  const dataOut = koffi.alloc('uint8', maxBytes)
  const hr = RegQueryValueExW(hkey, name, null, typeOut, dataOut, sizeOut)
  if (hr !== 0) return undefined
  if (koffi.decode(typeOut, 'uint32') !== REG_SZ) return undefined
  const size = koffi.decode(sizeOut, 'uint32')
  if (size < 2 || size > maxBytes) return undefined
  const bytes = Buffer.from(koffi.decode(dataOut, koffi.array('uint8', size)))
  return bytes.toString('utf16le').replace(/\0+$/, '')
}

/**
 * 读 REG_DWORD。
 * @returns {number|undefined} 非 DWORD 或不存在时 undefined
 */
export function getDword(hkey, name) {
  const typeOut = koffi.alloc('uint32', 1)
  const sizeOut = koffi.alloc('uint32', 1)
  koffi.encode(sizeOut, 'uint32', 4)
  const dataOut = koffi.alloc('uint32', 1)
  const hr = RegQueryValueExW(hkey, name, null, typeOut, dataOut, sizeOut)
  if (hr !== 0) return undefined
  if (koffi.decode(typeOut, 'uint32') !== REG_DWORD) return undefined
  if (koffi.decode(sizeOut, 'uint32') !== 4) return undefined
  return koffi.decode(dataOut, 'uint32') >>> 0
}

/**
 * 一次性读某个子键下的 DWORD（内部开关句柄）。
 * @returns {number|undefined}
 */
export function readDword(root, subKey, name) {
  const hkey = openKey(root, subKey)
  if (!hkey) return undefined
  try {
    return getDword(hkey, name)
  } finally {
    closeKey(hkey)
  }
}

/**
 * 删除子键（自检脚本清理临时键用；键不存在时返回 false）。
 * @returns {boolean}
 */
export function deleteKey(root, subKey) {
  try {
    return RegDeleteKeyW(hkeyArg(root), subKey) === 0
  } catch (e) {
    return false
  }
}

/** 建一个自动重置事件（等待一次后自动回到未触发）。 */
export function createEvent() {
  return CreateEventW(null, 0, 0, null) || 0
}

/** 非阻塞检查事件是否已触发。 */
export function isEventSignaled(handle) {
  if (!handle) return false
  try { return WaitForSingleObject(handle, 0) === WAIT_OBJECT_0 } catch (e) { return false }
}

/** 关闭句柄（0/null 安全）。 */
export function closeHandle(handle) {
  if (!handle) return
  try { CloseHandle(handle) } catch (e) { /* ignore */ }
}

/**
 * 注册"键变化"异步通知：变化时系统把 event 置为有信号。
 * 每次触发后必须重新调用本函数（一次性注册）。
 * @returns {boolean} 是否注册成功
 */
export function notifyKeyChange(hkey, eventHandle) {
  if (!hkey || !eventHandle) return false
  try {
    const hr = RegNotifyChangeKeyValue(hkey, 1, REG_NOTIFY_CHANGE_LAST_SET, eventHandle, 1)
    return hr === 0
  } catch (e) {
    return false
  }
}
