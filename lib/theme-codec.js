// DSH 桌面通知 — 主题判定纯逻辑（无平台依赖，便于单测）
//
// 两个平台各自的"系统深浅色"信号，最终都要归一到 'dark' / 'light'：
//   Windows：HKCU\...\Themes\Personalize\SystemUsesLightTheme（DWORD，1=浅色）
//   Linux  ：org.freedesktop.portal.Settings 的 org.freedesktop.appearance
//            color-scheme（u，0=无偏好 / 1=偏好深色 / 2=偏好浅色）
// 判定不出来时返回 null —— 由调用方决定回退（保持上一次结果或默认深色），
// 绝不把"读不到"当成"浅色"（那会让暗色用户的通知图标突然变黑看不见）。

export const THEME_DARK = 'dark'
export const THEME_LIGHT = 'light'

/**
 * Windows 注册表 DWORD → 主题。
 * @param {unknown} value SystemUsesLightTheme / AppsUseLightTheme 的取值
 * @returns {'dark'|'light'|null} 读不到（undefined/null/非数字）时 null
 */
export function themeFromLightFlag(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value === 0 ? THEME_DARK : THEME_LIGHT
}

/**
 * xdg-desktop-portal 的 color-scheme 取值 → 主题。
 * @param {unknown} value 0=无偏好 / 1=深色 / 2=浅色
 * @returns {'dark'|'light'|null} 无偏好或未知时 null
 */
export function themeFromColorScheme(value) {
  if (value === 1 || value === 1n) return THEME_DARK
  if (value === 2 || value === 2n) return THEME_LIGHT
  return null
}

/**
 * 环境变量兜底（portal 不可用时）：GTK_THEME 之类会带 `:dark` / `:light` 后缀。
 * 只在明确带后缀时才给结论，避免瞎猜。
 * @param {Record<string, string|undefined>} [env]
 * @returns {'dark'|'light'|null}
 */
export function themeFromEnv(env = process.env) {
  const gtk = env && env.GTK_THEME
  if (typeof gtk === 'string' && gtk) {
    if (/:dark\s*$/i.test(gtk)) return THEME_DARK
    if (/:light\s*$/i.test(gtk)) return THEME_LIGHT
  }
  return null
}

/**
 * 把任意值归一为已知主题（不认识的一律按深色——与旧版的白色图标行为一致）。
 * @param {unknown} value
 * @returns {'dark'|'light'}
 */
export function normalizeTheme(value) {
  return value === THEME_LIGHT ? THEME_LIGHT : THEME_DARK
}
