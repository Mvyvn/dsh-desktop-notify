// 主题判定与状态机单测（node:test，无第三方依赖）
//   npm test
//
// 锁住：
//   · Windows 注册表 DWORD / portal color-scheme → 主题的映射（读不到必须是 null，
//     不能把"读不到"当成浅色——暗色用户的通知图标会突然变黑看不见）
//   · 环境变量兜底只在明确带 :dark/:light 后缀时给结论
//   · 主题状态机：变化才通知订阅者、订阅者异常不影响状态、stop 后可重新 start
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  THEME_DARK, THEME_LIGHT, normalizeTheme, themeFromColorScheme, themeFromEnv, themeFromLightFlag,
} from '../lib/theme-codec.js'
import {
  currentTheme, onThemeChange, refreshTheme, resetThemeState, setTheme, startThemeWatch,
  stopThemeWatch,
} from '../lib/theme.js'

test('Windows：SystemUsesLightTheme/AppsUseLightTheme 的 DWORD → 主题', () => {
  assert.equal(themeFromLightFlag(1), THEME_LIGHT)
  assert.equal(themeFromLightFlag(0), THEME_DARK)
  assert.equal(themeFromLightFlag(undefined), null)
  assert.equal(themeFromLightFlag(null), null)
  assert.equal(themeFromLightFlag('1'), null)
  assert.equal(themeFromLightFlag(NaN), null)
})

test('portal：color-scheme 0/1/2 → 主题或未知', () => {
  assert.equal(themeFromColorScheme(1), THEME_DARK)
  assert.equal(themeFromColorScheme(2), THEME_LIGHT)
  assert.equal(themeFromColorScheme(1n), THEME_DARK)
  assert.equal(themeFromColorScheme(0), null, '0=无偏好，必须交回退而不是猜')
  assert.equal(themeFromColorScheme(undefined), null)
  assert.equal(themeFromColorScheme('2'), null)
})

test('环境变量兜底：只在明确后缀时给结论', () => {
  assert.equal(themeFromEnv({ GTK_THEME: 'Adwaita:dark' }), THEME_DARK)
  assert.equal(themeFromEnv({ GTK_THEME: 'Adwaita:light' }), THEME_LIGHT)
  assert.equal(themeFromEnv({ GTK_THEME: 'Adwaita' }), null)
  assert.equal(themeFromEnv({}), null)
  assert.equal(themeFromEnv(undefined), null)
})

test('normalizeTheme：未知一律按深色（与旧版白图标一致）', () => {
  assert.equal(normalizeTheme('light'), THEME_LIGHT)
  assert.equal(normalizeTheme('dark'), THEME_DARK)
  assert.equal(normalizeTheme('LIGHT'), THEME_DARK)
  assert.equal(normalizeTheme(undefined), THEME_DARK)
  assert.equal(normalizeTheme(0), THEME_DARK)
})

test('状态机:变化才通知，订阅者抛异常不影响状态与其它订阅者', () => {
  resetThemeState()
  const seen = []
  const off1 = onThemeChange((theme) => { seen.push('a:' + theme); throw new Error('boom') })
  const off2 = onThemeChange((theme) => { seen.push('b:' + theme) })
  assert.equal(currentTheme(), THEME_DARK, '默认深色')
  assert.equal(setTheme(THEME_DARK), false, '同值不算变化')
  assert.deepEqual(seen, [])
  assert.equal(setTheme(THEME_LIGHT), true)
  assert.equal(currentTheme(), THEME_LIGHT)
  assert.deepEqual(seen, ['a:light', 'b:light'])
  off1()
  off2()
  assert.equal(setTheme(THEME_DARK), true)
  assert.deepEqual(seen, ['a:light', 'b:light'], '退订后不再收到')
  resetThemeState()
})

test('主题跟踪在本平台可启动、可停止、可重复启动（不抛异常）', async () => {
  resetThemeState()
  const theme = await startThemeWatch()
  assert.ok(theme === THEME_DARK || theme === THEME_LIGHT, `主题取值合法（实际 ${theme}）`)
  // refreshTheme 的返回值只有 null / 'dark' / 'light' 三种，断言类型而不是"不等于 undefined"
  const read = await refreshTheme()
  assert.ok(read === null || read === THEME_DARK || read === THEME_LIGHT, `读取结果合法（实际 ${read}）`)
  // 幂等：重复启动不改变状态（也不该重新建连/重挂监听）
  assert.equal(currentTheme(), theme)
  assert.equal(await startThemeWatch(), theme)
  // 失败退避存在时，force 必须能穿透它（总线就绪后的补读靠这条）
  assert.ok(await refreshTheme({ force: true }) !== undefined)
  stopThemeWatch()
  assert.equal(await startThemeWatch(), currentTheme(), 'stop 后可以重新启动')
  stopThemeWatch()
  resetThemeState()
})
