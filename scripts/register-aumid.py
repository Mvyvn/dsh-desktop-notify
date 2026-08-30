# dsh-desktop-notify — 注册 Windows 应用身份（AUMID）图标
#
# 背景：Windows Toast 顶部/通知中心里的"程序应用图标"（app identity icon）
# 来自 AUMID 解析，与 toast 内嵌的 appLogoOverride（右下角小图）是两回事。
# 非打包桌面应用的 AUMID 图标有两个来源：
#   1. 注册表 HKCU\SOFTWARE\Classes\AppUserModelId\<AUMID>\IconUri
#   2. 带 System.AppUserModel.ID 属性的快捷方式（微软推荐，Windows 10 1607+）
# 本脚本两者都做，但只写 DSH 自己的键和快捷方式——不触碰任何 Python 相关注册表项。
#
# 用法：
#   python scripts/register-aumid.py --target <exe> --icon <ico> --lnk <path>
#     [--app-id DSH] [--display-name DSH]
#
# 依赖：仅标准库（ctypes / winreg），不修改全局 Python 环境。

import argparse
import ctypes
import ctypes.wintypes as wt
import sys
import uuid
import winreg
from ctypes import POINTER, Structure, byref, c_ubyte, c_uint, c_ushort, c_void_p, c_wchar_p, cast
from pathlib import Path

HRESULT = ctypes.c_long
ole32 = ctypes.oledll.ole32  # 仅用 COM 启动器，不引入第三方依赖
shell32 = ctypes.windll.shell32

GPS_READWRITE = 0x00000002

class GUID(Structure):
    _fields_ = [
        ("Data1", c_uint),
        ("Data2", c_ushort),
        ("Data3", c_ushort),
        ("Data4", c_ubyte * 8),
    ]

def guid(s: str) -> GUID:
    u = uuid.UUID(s)
    return GUID(u.time_low, u.time_mid, u.time_hi_version, (c_ubyte * 8)(*u.bytes[8:]))

CLSID_ShellLink = guid("{00021401-0000-0000-C000-000000000046}")
IID_IShellLinkW = guid("{000214F9-0000-0000-C000-000000000046}")
IID_IPersistFile = guid("{0000010B-0000-0000-C000-000000000046}")
IID_IPropertyStore = guid("{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}")

# vtable 偏移必须严格匹配 COM 接口声明顺序（IUnknown 3 个方法在前）。
def vtable_call(ppv, index, restype, argtypes, *args):
    vtbl = cast(ppv, POINTER(POINTER(c_void_p))).contents
    fn = cast(vtbl[index], ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes))
    return fn(ppv, *args)

def com_query_interface(ppv, iid):
    out = c_void_p()
    hr = vtable_call(ppv, 0, HRESULT, [POINTER(GUID), POINTER(c_void_p)], byref(iid), byref(out))
    if hr < 0:
        raise OSError(f"QueryInterface failed: 0x{hr & 0xFFFFFFFF:08X}")
    return out

class PROPERTYKEY(Structure):
    _fields_ = [("fmtid", GUID), ("pid", c_uint)]

class PropVariant(Structure):
    _fields_ = [
        ("vt", c_ushort),
        ("wReserved1", c_ushort),
        ("wReserved2", c_ushort),
        ("wReserved3", c_ushort),
        ("pszVal", c_wchar_p),  # union 首字段：LPWSTR（64 位下位于 offset 8）
    ]

VT_LPWSTR = 31

PKEY_APPUSERMODEL_ID = PROPERTYKEY(
    guid("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}"), 5
)

def create_shortcut_with_aumid(lnk_path: str, target: str, icon_path: str, app_id: str) -> None:
    ole32.CoInitialize(None)
    try:
        # 1) 新建 shell link：目标 + 图标
        ppv = c_void_p()
        hr = ole32.CoCreateInstance(byref(CLSID_ShellLink), None, 1, byref(IID_IShellLinkW), byref(ppv))
        if hr < 0:
            raise OSError(f"CoCreateInstance(ShellLink) failed: 0x{hr & 0xFFFFFFFF:08X}")
        ishell = ppv
        try:
            vtable_call(ishell, 20, HRESULT, [c_wchar_p], target)                      # SetPath
            vtable_call(ishell, 17, HRESULT, [c_wchar_p, ctypes.c_int], icon_path, 0)  # SetIconLocation
            pf = com_query_interface(ishell, IID_IPersistFile)
            try:
                hr = vtable_call(pf, 6, HRESULT, [c_wchar_p, wt.BOOL], lnk_path, True)  # Save
                if hr < 0:
                    raise OSError(f"IPersistFile.Save failed: 0x{hr & 0xFFFFFFFF:08X}")
            finally:
                vtable_call(pf, 2, HRESULT, [])  # Release
        finally:
            vtable_call(ishell, 2, HRESULT, [])  # Release

        # 2) 重新打开并写入 System.AppUserModel.ID
        # 注意：IShellLink 对象 QI 出的 IPropertyStore 是只读的（SetValue 返回
        # STG_E_INVALIDFLAG），必须用 SHGetPropertyStoreFromParsingName 打开
        # .lnk 文件的可写属性存储。
        ps = c_void_p()
        shell32.SHGetPropertyStoreFromParsingName.restype = HRESULT
        shell32.SHGetPropertyStoreFromParsingName.argtypes = [
            c_wchar_p, c_void_p, ctypes.c_uint, POINTER(GUID), POINTER(c_void_p),
        ]
        hr = shell32.SHGetPropertyStoreFromParsingName(
            lnk_path, None, GPS_READWRITE, byref(IID_IPropertyStore), byref(ps))
        if hr < 0:
            raise OSError(f"SHGetPropertyStoreFromParsingName failed: 0x{hr & 0xFFFFFFFF:08X}")
        try:
            pv = PropVariant()
            pv.vt = VT_LPWSTR
            pv.pszVal = app_id
            hr = vtable_call(ps, 6, HRESULT, [POINTER(PROPERTYKEY), POINTER(PropVariant)],
                             byref(PKEY_APPUSERMODEL_ID), byref(pv))
            if hr < 0:
                raise OSError(f"IPropertyStore.SetValue failed: 0x{hr & 0xFFFFFFFF:08X}")
            hr = vtable_call(ps, 7, HRESULT, [])  # Commit
            if hr < 0:
                raise OSError(f"IPropertyStore.Commit failed: 0x{hr & 0xFFFFFFFF:08X}")

            # ---- 自验证：读回 AppUserModelID ----
            read = PropVariant()
            hr = vtable_call(ps, 5, HRESULT, [POINTER(PROPERTYKEY), POINTER(PropVariant)],
                             byref(PKEY_APPUSERMODEL_ID), byref(read))
            got = None
            if hr >= 0 and read.vt == VT_LPWSTR:
                got = read.pszVal
            print(f"[register-aumid] verify: AppUserModelID='{got}'")
            if got != app_id:
                raise OSError(f"AppUserModelID read-back mismatch: {got!r} != {app_id!r}")
        finally:
            vtable_call(ps, 2, HRESULT, [])  # Release
    finally:
        ole32.CoUninitialize()

def write_registry(app_id: str, display_name: str, icon_uri: str) -> None:
    """写 DSH 专属 AUMID 注册表键（HKCU）；不触碰任何其它键。"""
    key_path = rf"SOFTWARE\Classes\AppUserModelId\{app_id}"
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, display_name)
        if icon_uri:
            winreg.SetValueEx(key, "IconUri", 0, winreg.REG_SZ, icon_uri)

def main() -> None:
    ap = argparse.ArgumentParser(description="Register DSH AUMID shortcut + registry icon (DSH-only keys)")
    ap.add_argument("--target", required=True, help="shortcut target exe (absolute path)")
    ap.add_argument("--icon", required=True, help="icon file (absolute path, .ico)")
    ap.add_argument("--lnk", required=True, help="shortcut .lnk path")
    ap.add_argument("--app-id", default="DSH")
    ap.add_argument("--display-name", default="DSH")
    args = ap.parse_args()

    icon_uri = "file:///" + str(Path(args.icon).resolve()).replace("\\", "/")

    create_shortcut_with_aumid(args.lnk, args.target, args.icon, args.app_id)
    write_registry(args.app_id, args.display_name, icon_uri)
    print(f"[register-aumid] shortcut: {args.lnk}")
    print(f"[register-aumid] registry: HKCU\\SOFTWARE\\Classes\\AppUserModelId\\{args.app_id} "
          f"(DisplayName='{args.display_name}', IconUri={icon_uri})")

if __name__ == "__main__":
    main()
