// DSH 桌面通知 — 文本小工具（纯逻辑，便于单测）
//
// 按长度截断时不能把 UTF-16 代理对切成两半：孤立高代理编码成 UTF-8 会变成
// U+FFFD 替换字符，真实出现在发给系统通知的载荷里（emoji 尤其容易踩到）。

/**
 * 按 UTF-16 码元数截断，但绝不产生孤立代理。
 * 截断点落在代理对中间时向前退一个码元——少一个字符好过出现 U+FFFD。
 * @param {unknown} value 待截断的值（非字符串会被 String() 归一）
 * @param {number} max 最大码元数
 * @returns {string}
 */
export function truncateText(value, max) {
  const text = String(value === undefined || value === null ? '' : value)
  if (!Number.isFinite(max) || max <= 0) return ''
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  const cut = last >= 0xd800 && last <= 0xdbff ? max - 1 : max
  return text.slice(0, cut)
}
