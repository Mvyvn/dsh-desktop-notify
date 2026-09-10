// koffi 直调 WinRT 发送 Toast — Statics 路径（explorer 刷新 AUMID 后验证）
// 链路：ToastNotificationManagerStatics.CreateToastNotifier('DSH')
//   → IXmlDocument.LoadXml → ToastNotificationFactory.CreateInstance → IToastNotifier.Show
import * as koffi from 'koffi'

const combase = koffi.load('combase.dll')
const GUID = koffi.struct('GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) })
const voidPtr = koffi.pointer(koffi.types.void)
const GUIDPtr = koffi.pointer(GUID)
const RoInitialize = combase.func('RoInitialize', 'int32', ['uint32'])
const RoGetActivationFactory = combase.func('RoGetActivationFactory', 'int32', ['void*', GUIDPtr, 'void**'])
const RoActivateInstance = combase.func('RoActivateInstance', 'int32', ['void*', 'void**'])
const WindowsCreateString = combase.func('WindowsCreateString', 'int32', ['str16', 'uint32', 'void**'])
const WindowsDeleteString = combase.func('WindowsDeleteString', 'int32', ['void*'])
RoInitialize(0)
function hstr(s) { const o = koffi.alloc(voidPtr, 1); const hr = WindowsCreateString(s, s.length, o); if (hr < 0) throw new Error('hstr ' + hr); return koffi.decode(o, voidPtr) }
function guid(s) { const h = s.replace(/-/g, ''); return { Data1: parseInt(h.slice(0, 8), 16) >>> 0, Data2: parseInt(h.slice(8, 12), 16), Data3: parseInt(h.slice(12, 16), 16), Data4: Array.from({ length: 8 }, (_, i) => parseInt(h.slice(16 + i * 2, 18 + i * 2), 16)) } }
function vtblCall(obj, index, retType, argTypes, ...args) {
  const vtbl = koffi.decode(obj, voidPtr)
  const fn = koffi.decode(vtbl + BigInt(index * 8), voidPtr)
  return koffi.call(fn, koffi.proto(null, retType, ['void*', ...argTypes]), obj, ...args)
}
// 接口 IID（windows-rs 元数据确认）：
const IID_STATICS5 = guid('D6F5F569-D40D-407C-8989-88CAB42CFD14')       // GetDefault 所在接口
const IID_FORUSER = guid('79AB57F6-43FE-487B-8A7F-99567200AE94')        // ToastNotificationManagerForUser
const IID_TOAST_FACTORY = guid('04124B20-82C6-4229-B109-FD9ED4662B53')

// 1) Manager Statics5 工厂 → 槽 6 GetDefault() → ToastNotificationManagerForUser
const factory = koffi.alloc(voidPtr, 1)
const iid = koffi.alloc(GUID, 1)
koffi.encode(iid, GUID, IID_STATICS5)
const cls = hstr('Windows.UI.Notifications.ToastNotificationManager')
const hrF = RoGetActivationFactory(cls, iid, factory)
WindowsDeleteString(cls)
if (hrF < 0) throw new Error(`factory 0x${(hrF >>> 0).toString(16)}`)
const mgr = koffi.decode(factory, voidPtr)
const forUserPtr = koffi.alloc(voidPtr, 1)
const hrG = vtblCall(mgr, 6, 'int32', ['void**'], forUserPtr)
if (hrG < 0) throw new Error(`GetDefault 0x${(hrG >>> 0).toString(16)}`)
const forUser = koffi.decode(forUserPtr, voidPtr)
console.log('forUser ok')

// 2) ForUser 槽 7 CreateToastNotifierWithId('DSH')
const appId = hstr('DSH')
const notifierPtr = koffi.alloc(voidPtr, 1)
const hrN = vtblCall(forUser, 7, 'int32', ['void*', 'void**'], appId, notifierPtr)
WindowsDeleteString(appId)
if (hrN < 0) throw new Error(`CreateToastNotifierWithId 0x${(hrN >>> 0).toString(16)}`)
const notifier = koffi.decode(notifierPtr, voidPtr)
console.log('notifier ok')

// 3) XmlDocument 实例 + QI IXmlDocumentIO → LoadXml（HSTRING）
//    注意：LoadXml 不在 IXmlDocument 上，而在 IXmlDocumentIO（6CD0E74E-EE65-4489-9EBF-CA43E87BA637，槽 6）
const IID_XMLDOC_IO = guid('6CD0E74E-EE65-4489-9EBF-CA43E87BA637')
const ICON = 'file:///C:/Users/SuSeventeen/.dsh/profiles/web/node_modules/dsh-desktop-notify/assets/dsh.png'
const XML = `<?xml version="1.0" encoding="utf-8"?><toast launch="default"><visual><binding template="ToastGeneric"><text>koffi WinRT 直调（Statics5/ForUser）</text><text>dsh-desktop-notify:Node 直调 Windows Runtime，无 Python</text><image placement="appLogoOverride" src="${ICON}"/></binding></visual><audio silent="true"/></toast>`
const xmlCls = hstr('Windows.Data.Xml.Dom.XmlDocument')
const xmlInst = koffi.alloc(voidPtr, 1)
const hrX = RoActivateInstance(xmlCls, xmlInst)
WindowsDeleteString(xmlCls)
if (hrX < 0) throw new Error(`XmlDocument 0x${(hrX >>> 0).toString(16)}`)
const xmlDoc = koffi.decode(xmlInst, voidPtr)
const ioIid = koffi.alloc(GUID, 1)
koffi.encode(ioIid, GUID, IID_XMLDOC_IO)
const ioPtr = koffi.alloc(voidPtr, 1)
const hrQ = vtblCall(xmlDoc, 0, 'int32', [GUIDPtr, 'void**'], ioIid, ioPtr)
if (hrQ < 0) throw new Error(`QI IXmlDocumentIO 0x${(hrQ >>> 0).toString(16)}`)
const xmlIO = koffi.decode(ioPtr, voidPtr)
const hrL = (() => {
  const xmlH = hstr(XML) // WinRT 字符串参数是 HSTRING
  const hr = vtblCall(xmlIO, 6, 'int32', ['void*'], xmlH)
  WindowsDeleteString(xmlH)
  return hr
})()
if (hrL < 0) throw new Error(`LoadXml 0x${(hrL >>> 0).toString(16)}`)

// 4) ToastNotification 工厂 + CreateInstance
const tCls = hstr('Windows.UI.Notifications.ToastNotification')
const tFactory = koffi.alloc(voidPtr, 1)
const tIid = koffi.alloc(GUID, 1)
koffi.encode(tIid, GUID, IID_TOAST_FACTORY)
const hrT = RoGetActivationFactory(tCls, tIid, tFactory)
WindowsDeleteString(tCls)
if (hrT < 0) throw new Error(`Toast factory 0x${(hrT >>> 0).toString(16)}`)
const tf = koffi.decode(tFactory, voidPtr)
const toastPtr = koffi.alloc(voidPtr, 1)
const hrC = vtblCall(tf, 6, 'int32', ['void*', 'void**'], xmlDoc, toastPtr)
if (hrC < 0) throw new Error(`CreateInstance 0x${(hrC >>> 0).toString(16)}`)
const toast = koffi.decode(toastPtr, voidPtr)

// 5) Show（IToastNotifier 槽 6）
const hrS = vtblCall(notifier, 6, 'int32', ['void*'], toast)
if (hrS < 0) throw new Error(`Show 0x${(hrS >>> 0).toString(16)}`)
console.log('SHOW OK')
