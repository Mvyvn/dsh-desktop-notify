// 通知图标解析单测（node:test，无第三方依赖）
//   npm test
//
// 锁住：
//   · 深浅两套图标各自解析到 dsh-{dark,light}.{png,ico}
//   · 主题图标缺失时回退旧版单色图标（升级安装/资源被裁剪的老包）
//   · Windows 用的 file:/// URI 反斜杠转换
//   · 仓库里真的存在这四张图（防止"代码改了、图忘了提交"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import {
  ASSETS_DIR, LEGACY_ICON_FILES, THEME_ICON_FILES, iconPathsFor, normalizeTheme, toFileUri,
} from '../lib/icons.js'

const ALL = (path) => path.endsWith('.png') || path.endsWith('.ico')

test('深色主题用白鱼、浅色主题用黑鱼', () => {
  const dark = iconPathsFor('dark', { exists: ALL })
  assert.equal(basename(dark.png), 'dsh-dark.png')
  assert.equal(basename(dark.ico), 'dsh-dark.ico')
  assert.equal(dark.legacy, false)
  const light = iconPathsFor('light', { exists: ALL })
  assert.equal(basename(light.png), 'dsh-light.png')
  assert.equal(basename(light.ico), 'dsh-light.ico')
  assert.equal(light.legacy, false)
})

test('主题不认识时按深色（旧默认）', () => {
  assert.equal(iconPathsFor(undefined, { exists: ALL }).theme, 'dark')
  assert.equal(iconPathsFor('purple', { exists: ALL }).theme, 'dark')
  assert.equal(normalizeTheme('light'), 'light')
})

test('主题图标缺失时回退旧版单色图标', () => {
  const onlyLegacy = (path) => path.includes(LEGACY_ICON_FILES.png) || path.includes(LEGACY_ICON_FILES.ico)
  const light = iconPathsFor('light', { exists: onlyLegacy })
  assert.equal(basename(light.png), LEGACY_ICON_FILES.png)
  assert.equal(basename(light.ico), LEGACY_ICON_FILES.ico)
  assert.equal(light.legacy, true)
})

test('完全没有图标文件时给出空路径（不抛异常、不发图）', () => {
  const none = iconPathsFor('dark', { exists: () => false })
  assert.equal(none.png, '')
  assert.equal(none.ico, '')
  assert.equal(none.legacy, true)
})

test('file:/// URI：反斜杠换正斜杠，空路径给空串', () => {
  assert.equal(toFileUri('C:\\dir\\dsh-light.ico'), 'file:///C:/dir/dsh-light.ico')
  assert.equal(toFileUri(''), '')
  assert.equal(toFileUri(undefined), '')
})

test('仓库里四张主题图标都在（assets 目录已随包提交）', () => {
  for (const theme of ['dark', 'light']) {
    const files = THEME_ICON_FILES[theme]
    for (const file of [files.png, files.ico]) {
      assert.ok(existsSync(`${ASSETS_DIR}\\${file}`) || existsSync(`${ASSETS_DIR}/${file}`), `缺少 assets/${file}`)
    }
  }
  // 旧路径仍在（兼容旧安装与文档截图）
  assert.ok(existsSync(`${ASSETS_DIR}/${LEGACY_ICON_FILES.png}`) || existsSync(`${ASSETS_DIR}\\${LEGACY_ICON_FILES.png}`))
})
