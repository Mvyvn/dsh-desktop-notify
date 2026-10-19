// 画面视觉键：只有会改变像素的位才参与"是否重新渐变/重置动画相位"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCENE_FLAG, sceneVisualKey } from '../lib/led-scene.js'

const scene = (state, flags, brightness = 200) => ({ state, flags, brightness, latched: false, reason: '' })

test('sceneVisualKey：running/done/error 忽略 MUTED（渲染不读它）', () => {
  for (const state of ['running', 'done', 'error']) {
    assert.equal(sceneVisualKey(scene(state, 0)), sceneVisualKey(scene(state, SCENE_FLAG.MUTED)),
      `${state} 的 MUTED 不影响像素，视觉键必须一致`)
  }
})

test('sceneVisualKey：waiting 的 MUTED 影响呼吸 → 必须区分', () => {
  assert.notEqual(sceneVisualKey(scene('waiting', 0)), sceneVisualKey(scene('waiting', SCENE_FLAG.MUTED)))
})

test('sceneVisualKey：ATTENTION / NIGHT / 亮度 / 状态变化都算视觉变化', () => {
  assert.notEqual(sceneVisualKey(scene('done', 0)), sceneVisualKey(scene('done', SCENE_FLAG.ATTENTION)))
  assert.notEqual(sceneVisualKey(scene('running', 0)), sceneVisualKey(scene('running', SCENE_FLAG.NIGHT)))
  assert.notEqual(sceneVisualKey(scene('running', 0, 200)), sceneVisualKey(scene('running', 0, 201)))
  assert.notEqual(sceneVisualKey(scene('running', 0)), sceneVisualKey(scene('done', 0)))
})
