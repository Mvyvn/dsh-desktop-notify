// Toast XML 组装（纯函数，便于单测）
//
// Windows Toast 的 appLogoOverride 与协议激活都在这里拼：把 XML 从 winrt.ts
// 里抽出来，才能在非 Windows 平台上用单测锁住转义与属性（点错一个引号就是
// "通知发不出去"，而 WinRT 只会回一个 HRESULT）。
//
// 点击语义只由 `launch` 决定（由 winrt.ts 按 ClickTarget 算好）：
//   launch 为空        → 普通 Toast：点击只消失，**不跳转**（配置里没留点击目标）
//   launch 非空        → 协议激活：点击由系统打开该地址
//                        · `dsh-notify:<wire>`  自定义协议 → 本机转发器 → /dnotify/activate
//                        · `http(s)://…`        浏览器落地页 / 外部地址
/**
 * XML 属性/文本转义（标题、正文、图片 URI、launch 地址都要过一遍）。
 */
export function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
/** 拼一条 ToastGeneric 的 Toast XML。 */
export function buildToastXml(item) {
    const title = escapeXml(item.title ?? '');
    const message = escapeXml(item.message ?? '');
    const iconUri = typeof item.iconUri === 'string' ? item.iconUri : '';
    const launch = typeof item.launch === 'string' ? item.launch : '';
    const iconAttr = iconUri !== '' ? `<image placement="appLogoOverride" src="${escapeXml(iconUri)}"/>` : '';
    const toastAttr = launch !== '' ? ` activationType="protocol" launch="${escapeXml(launch)}"` : '';
    return `<?xml version="1.0" encoding="utf-8"?><toast${toastAttr}>`
        + `<visual><binding template="ToastGeneric"><text>${title}</text><text>${message}</text>${iconAttr}</binding></visual></toast>`;
}
