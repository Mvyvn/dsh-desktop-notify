// DSH 桌面通知 — Windows Toast 发送模块（koffi 直调 WinRT，无 Python、无子进程）
//
// 链路（已在 Windows 11 + Node 24 实测通过）：
//   ToastNotificationManager(Statics5) 工厂
//     → 槽6 GetDefault() → ToastNotificationManagerForUser
//     → 槽7 CreateToastNotifierWithId('DSH') → IToastNotifier（缓存复用）
//     → XmlDocument 激活 → QI IXmlDocumentIO → 槽6 LoadXml(HSTRING)
//     → ToastNotification 工厂(04124B20) → 槽6 CreateInstance(xml)
//     → IToastNotifier 槽6 Show(toast)
//
// 接口 IID 与 vtable 槽位均来自 windows-rs 元数据（microsoft/windows-rs）核对。
// 注意：desktop-notifier 走的也是 ForUser 变体（CreateToastNotifierWithId）；
// 旧 Statics.CreateToastNotifier(appId) 在部分系统返回 0x80070490（AUMID 快捷方式
// 注册未被识别），因此必须走 GetDefault → ForUser。

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as koffi from 'koffi'

const ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'dsh.png')
const HAS_ICON = existsSync(ICON_PATH)
const APP_ID = 'DSH'

// ---- combase（Windows Runtime 入口）----
const combase = koffi.load('combase.dll')
const GUID = koffi.struct('GUID', {
  Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8),
})
const voidPtr = koffi.pointer(koffi.types.void)
const GUIDPtr = koffi.pointer(GUID)

const RoInitialize = combase.func('RoInitialize', 'int32', ['uint32'])
const RoGetActivationFactory = combase.func('RoGetActivationFactory', 'int32', ['void*', GUIDPtr, 'void**'])
const RoActivateInstance = combase.func('RoActivateInstance', 'int32', ['void*', 'void**'])
const WindowsCreateString = combase.func('WindowsCreateString', 'int32', ['str16', 'uint32', 'void**'])
const WindowsDeleteString = combase.func('WindowsDeleteString', 'int32', ['void*'])

// IID（windows-rs 元数据核对）
const IID_STATICS5 = guid('D6F5F569-D40D-407C-8989-88CAB42CFD14')       // GetDefault 所在接口
const IID_XMLDOC_IO = guid('6CD0E74E-EE65-4489-9EBF-CA43E87BA637')      // IXmlDocumentIO.LoadXml
const IID_TOAST_FACTORY = guid('04124B20-82C6-4229-B109-FD9ED4662B53')

function guid(s) {
  const h = s.replace(/-/g, '')
  return {
    Data1: parseInt(h.slice(0, 8), 16) >>> 0,
    Data2: parseInt(h.slice(8, 12), 16),
    Data3: parseInt(h.slice(12, 16), 16),
    Data4: Array.from({ length: 8 }, (_, i) => parseInt(h.slice(16 + i * 2, 18 + i * 2), 16)),
  }
}

let initialized = false
function ensureInitialized() {
  if (initialized) return
  // RO_INIT_MULTITHREADED(1)；若已以其他模式初始化则忽略
  const hr = RoInitialize(1)
  if (hr < 0 && hr !== 0x80010106) throw new Error(`RoInitialize failed: 0x${(hr >>> 0).toString(16)}`)
  initialized = true
}

function hstr(s) {
  const out = koffi.alloc(voidPtr, 1)
  const hr = WindowsCreateString(s, s.length, out)
  if (hr < 0) throw new Error(`WindowsCreateString failed: 0x${(hr >>> 0).toString(16)}`)
  return koffi.decode(out, voidPtr)
}
function releaseHString(h) {
  try { WindowsDeleteString(h) } catch (e) { /* ignore */ }
}

// COM vtable 调用：objAddr 为接口对象地址（bigint），index 为方法序号，args 不含 this
function vtblCall(objAddr, index, retType, argTypes, ...args) {
  const vtblAddr = koffi.decode(objAddr, voidPtr)
  const fnPtr = koffi.decode(vtblAddr + BigInt(index * 8), voidPtr)
  if (fnPtr === null) throw new Error(`null vtable slot ${index}`)
  const type = koffi.proto(null, retType, ['void*', ...argTypes])
  return koffi.call(fnPtr, type, objAddr, ...args)
}

// 缓存的 WinRT 对象（进程生命周期内复用）
let cached = null // { notifier }

function getNotifier() {
  if (cached) return cached.notifier
  const factory = koffi.alloc(voidPtr, 1)
  const iid = koffi.alloc(GUID, 1)
  koffi.encode(iid, GUID, IID_STATICS5)
  const cls = hstr('Windows.UI.Notifications.ToastNotificationManager')
  const hrF = RoGetActivationFactory(cls, iid, factory)
  releaseHString(cls)
  if (hrF < 0) throw new Error(`Manager factory failed: 0x${(hrF >>> 0).toString(16)}`)
  const mgr = koffi.decode(factory, voidPtr)
  const forUserPtr = koffi.alloc(voidPtr, 1)
  const hrG = vtblCall(mgr, 6, 'int32', ['void**'], forUserPtr) // GetDefault
  if (hrG < 0) throw new Error(`GetDefault failed: 0x${(hrG >>> 0).toString(16)}`)
  const forUser = koffi.decode(forUserPtr, voidPtr)
  const appId = hstr(APP_ID)
  const notifierPtr = koffi.alloc(voidPtr, 1)
  const hrN = vtblCall(forUser, 7, 'int32', ['void*', 'void**'], appId, notifierPtr) // CreateToastNotifierWithId
  releaseHString(appId)
  if (hrN < 0) throw new Error(`CreateToastNotifierWithId failed: 0x${(hrN >>> 0).toString(16)}`)
  cached = { notifier: koffi.decode(notifierPtr, voidPtr) }
  return cached.notifier
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 发送一条 Windows Toast（同步；失败抛 Error）。
 * @param {{title: string, message: string, iconPath?: string}} item
 */
export function sendToast(item) {
  ensureInitialized()
  const notifier = getNotifier()
  const title = String(item.title || '').slice(0, 160)
  const message = String(item.message || '').slice(0, 400)
  const icon = item.iconPath || (HAS_ICON ? ICON_PATH : '')
  const iconAttr = icon ? `<image placement="appLogoOverride" src="file:///${icon.replace(/\\/g, '/')}"/>` : ''
  const xml = `<?xml version="1.0" encoding="utf-8"?><toast launch="default"><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(message)}</text>${iconAttr}</binding></visual></toast>`

  // XmlDocument → IXmlDocumentIO.LoadXml
  const xmlCls = hstr('Windows.Data.Xml.Dom.XmlDocument')
  const xmlInst = koffi.alloc(voidPtr, 1)
  const hrX = RoActivateInstance(xmlCls, xmlInst)
  releaseHString(xmlCls)
  if (hrX < 0) throw new Error(`XmlDocument activate failed: 0x${(hrX >>> 0).toString(16)}`)
  const xmlDoc = koffi.decode(xmlInst, voidPtr)
  const ioIid = koffi.alloc(GUID, 1)
  koffi.encode(ioIid, GUID, IID_XMLDOC_IO)
  const ioPtr = koffi.alloc(voidPtr, 1)
  const hrQ = vtblCall(xmlDoc, 0, 'int32', [GUIDPtr, 'void**'], ioIid, ioPtr)
  if (hrQ < 0) throw new Error(`QI IXmlDocumentIO failed: 0x${(hrQ >>> 0).toString(16)}`)
  const xmlIO = koffi.decode(ioPtr, voidPtr)
  const xmlH = hstr(xml)
  const hrL = vtblCall(xmlIO, 6, 'int32', ['void*'], xmlH) // LoadXml(HSTRING)
  releaseHString(xmlH)
  if (hrL < 0) throw new Error(`LoadXml failed: 0x${(hrL >>> 0).toString(16)}`)

  // ToastNotification 工厂 → CreateInstance(xml)
  const tCls = hstr('Windows.UI.Notifications.ToastNotification')
  const tFactory = koffi.alloc(voidPtr, 1)
  const tIid = koffi.alloc(GUID, 1)
  koffi.encode(tIid, GUID, IID_TOAST_FACTORY)
  const hrT = RoGetActivationFactory(tCls, tIid, tFactory)
  releaseHString(tCls)
  if (hrT < 0) throw new Error(`Toast factory failed: 0x${(hrT >>> 0).toString(16)}`)
  const tf = koffi.decode(tFactory, voidPtr)
  const toastPtr = koffi.alloc(voidPtr, 1)
  const hrC = vtblCall(tf, 6, 'int32', ['void*', 'void**'], xmlDoc, toastPtr)
  if (hrC < 0) throw new Error(`CreateInstance failed: 0x${(hrC >>> 0).toString(16)}`)
  const toast = koffi.decode(toastPtr, voidPtr)

  // Show
  const hrS = vtblCall(notifier, 6, 'int32', ['void*'], toast)
  if (hrS < 0) throw new Error(`Show failed: 0x${(hrS >>> 0).toString(16)}`)
}
