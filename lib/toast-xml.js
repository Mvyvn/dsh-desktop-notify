// DSH 桌面通知 — Toast XML 组装（纯函数，便于单测）
//
// Windows Toast 的 appLogoOverride 与协议激活都在这里拼：把 XML 从 lib/winrt.js
// 里抽出来，才能在非 Windows 平台上用单测锁住转义与属性（点错一个引号就是
// "通知发不出去"，而 WinRT 只会回一个 HRESULT）。

/**
 * XML 属性/文本转义（标题、正文、图片 URI、launch 地址都要过一遍）。
 * @param {unknown} s
 * @returns {string}
 */
export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 拼一条 ToastGeneric 的 Toast XML。
 * @param {{title?: string, message?: string, iconUri?: string, url?: string}} item
 *   iconUri 是 `file:///…` 形式的图片地址（空则不带头图）；
 *   url 非空时用协议激活（`activationType="protocol"`）——点击由系统直接打开该地址，
 *   不需要注册 COM 激活器；为空则是普通 Toast，点击只会消失。
 * @returns {string}
 */
export function buildToastXml(item) {
  const title = escapeXml(item.title || '')
  const message = escapeXml(item.message || '')
  const iconUri = typeof item.iconUri === 'string' ? item.iconUri : ''
  const url = typeof item.url === 'string' ? item.url : ''
  const iconAttr = iconUri ? `<image placement="appLogoOverride" src="${escapeXml(iconUri)}"/>` : ''
  const toastAttr = url ? ` activationType="protocol" launch="${escapeXml(url)}"` : ''
  return `<?xml version="1.0" encoding="utf-8"?><toast${toastAttr}>`
    + `<visual><binding template="ToastGeneric"><text>${title}</text><text>${message}</text>${iconAttr}</binding></visual></toast>`
}
