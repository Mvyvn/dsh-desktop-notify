// DSH 桌面通知 — 通知图标解析（纯逻辑 + 文件系统探测，便于单测）
//
// 通知背景色跟随系统主题，而图标本身不会被反色：
//   深色主题 → 背景深、用白色鱼形；浅色主题 → 背景浅、用黑色鱼形。
// 两套图标都是透明底 PNG/ICO，像素形状完全一致，只有前景色不同
// （由 scripts/make-icon.py 从 assets/dsh-logo.svg 一次生成）。
//
// 旧版本只随包带了白色图标（assets/dsh.png|ico，作者当时是暗色模式），
// 因此这里保留回退链：主题图标缺失 → 旧白色图标 → 空（不发图，不影响通知本身）。

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEME_DARK, THEME_LIGHT, normalizeTheme } from './theme-codec.js'

/** 随包资源目录。 */
export const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

export { THEME_DARK, THEME_LIGHT, normalizeTheme }

/** 每个主题对应的图标文件：dark=白鱼（配深色背景），light=黑鱼（配浅色背景）。 */
export const THEME_ICON_FILES = {
  [THEME_DARK]: { png: 'dsh-dark.png', ico: 'dsh-dark.ico' },
  [THEME_LIGHT]: { png: 'dsh-light.png', ico: 'dsh-light.ico' },
}

/** 旧版单色（白鱼）图标：主题图标缺失时的回退。 */
export const LEGACY_ICON_FILES = { png: 'dsh.png', ico: 'dsh.ico' }

/**
 * 按主题解析图标绝对路径。
 * @param {unknown} theme 主题（不认识/缺省 → 深色）
 * @param {{assetsDir?: string, exists?: (path: string) => boolean}} [options]
 *   便于单测：注入自定义资源目录与存在性判断
 * @returns {{theme: string, png: string, ico: string, legacy: boolean}}
 *   `legacy: true` 表示当前用的是旧版白色图标（请求的主题图标缺失）
 */
export function iconPathsFor(theme, options = {}) {
  const variant = normalizeTheme(theme)
  const dir = options.assetsDir || ASSETS_DIR
  const exists = options.exists || existsSync
  const themed = THEME_ICON_FILES[variant]
  const pick = (file) => {
    const path = join(dir, file)
    return exists(path) ? path : ''
  }
  const png = pick(themed.png)
  const ico = pick(themed.ico)
  if (png && ico) return { theme: variant, png, ico, legacy: false }
  // 主题图标不全（旧版安装/资源被裁剪）：回退旧白色图标，缺什么补什么
  const legacyPng = png || pick(LEGACY_ICON_FILES.png)
  const legacyIco = ico || pick(LEGACY_ICON_FILES.ico)
  return { theme: variant, png: legacyPng, ico: legacyIco, legacy: true }
}

/**
 * Windows 的 WinRT/注册表接口只吃 `file:///` URI（反斜杠必须换成斜杠）。
 * @param {string} path
 * @returns {string} 空路径返回空串
 */
export function toFileUri(path) {
  if (!path) return ''
  return 'file:///' + String(path).replace(/\\/g, '/')
}
