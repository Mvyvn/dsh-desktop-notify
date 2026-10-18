// 主机端渲染器测试：语义画面 + 时刻 → 7 颗灯的像素
//
// 固件没有动画能力，所以"好不好看"全在这里。断言要**可核对**：
// 同一时刻的像素是确定的、亮度是乘出来的、提醒是双闪的、熄灯是真的黑。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPixels, alertEnvelope, STATE_COLOR } from '../lib/led-render.js'
import { SCENE_FLAG } from '../lib/led-scene.js'

const scene = (state, flags = 0, brightness = 255) => ({ state, flags, brightness, latched: (flags & SCENE_FLAG.ATTENTION) !== 0, reason: '' })
const sum = (pixels) => pixels.reduce((acc, px) => acc + px.r + px.g + px.b, 0)

test('熄灭：全黑（7 颗）', () => {
  const pixels = renderPixels(scene('off', 0, 255), 0)
  assert.equal(pixels.length, 7)
  assert.equal(sum(pixels), 0)
})

test('亮度 0 也是全黑；亮度减半则通道值减半', () => {
  assert.equal(sum(renderPixels(scene('done', SCENE_FLAG.MUTED, 0), 0)), 0)
  const full = renderPixels(scene('done', SCENE_FLAG.MUTED, 255), 0)
  const half = renderPixels(scene('done', SCENE_FLAG.MUTED, 128), 0)
  const f = full[0]
  const h = half[0]
  assert.ok(Math.abs(h.r - Math.round((f.r * 128) / 255)) <= 1)
  assert.ok(sum(half) < sum(full))
})

test('运行中：白/冷白 + 彗星会动（不同时刻像素不同）', () => {
  const a = renderPixels(scene('running', 0, 200), 0)
  const b = renderPixels(scene('running', 0, 200), 400)
  assert.notDeepEqual(a, b, '彗星应当在移动')
  // 暖色不该出现：白/冷白要求 r 与 b 接近，且 g 不低
  const head = a.reduce((best, px) => (px.r + px.g + px.b > best.r + best.g + best.b ? px : best), a[0])
  assert.ok(head.b > 0 && head.r > 0, `head=${JSON.stringify(head)}`)
  assert.ok(STATE_COLOR.running.g >= STATE_COLOR.running.r, '运行中用冷白')
})

test('等待用户：琥珀色呼吸（同一时刻确定、不同时刻变化）', () => {
  const a = renderPixels(scene('waiting', 0, 255), 0)
  const b = renderPixels(scene('waiting', 0, 255), 1200)
  assert.notDeepEqual(a, b, '呼吸要有起伏')
  const px = a[3]
  assert.ok(px.r > px.g && px.g > px.b, `琥珀色：${JSON.stringify(px)}`)
})

test('完成：绿色；已看过（MUTED）时安静常亮', () => {
  const muted = renderPixels(scene('done', SCENE_FLAG.MUTED, 255), 0)
  const muted2 = renderPixels(scene('done', SCENE_FLAG.MUTED, 255), 1700)
  assert.deepEqual(muted, muted2, '已看过就不该再呼吸/闪')
  assert.ok(muted[0].g > muted[0].r && muted[0].g > muted[0].b, '绿色主导')
})

test('异常：红色 2Hz 硬闪', () => {
  const on = renderPixels(scene('error', 0, 255), 0)      // 周期前 60% 亮
  const off = renderPixels(scene('error', 0, 255), 450)   // 后 40% 暗
  assert.ok(sum(on) > sum(off), '亮相应明显更亮')
  assert.ok(on[0].r > on[0].g && on[0].r > on[0].b, '红色主导')
})

test('提醒（ATTENTION）：双闪包络 —— 亮 110ms、灭 110ms、再亮 110ms', () => {
  assert.equal(alertEnvelope(0), 1)
  assert.equal(alertEnvelope(100), 1)
  assert.equal(alertEnvelope(150), 0)
  assert.equal(alertEnvelope(260), 1)
  assert.equal(alertEnvelope(400), 0)
  // 画面真的跟着包络变
  const on = renderPixels(scene('waiting', SCENE_FLAG.ATTENTION, 255), 0)
  const offPhase = renderPixels(scene('waiting', SCENE_FLAG.ATTENTION, 255), 400)
  assert.ok(sum(on) > sum(offPhase), '双闪的暗段应当更暗')
})

test('夜间再暗一档', () => {
  const day = renderPixels(scene('done', SCENE_FLAG.MUTED, 255), 0)
  const night = renderPixels(scene('done', SCENE_FLAG.MUTED | SCENE_FLAG.NIGHT, 255), 0)
  assert.ok(sum(night) < sum(day))
})

test('渲染是纯函数：同样输入同样输出', () => {
  const a = renderPixels(scene('running', 0, 160), 1234)
  const b = renderPixels(scene('running', 0, 160), 1234)
  assert.deepEqual(a, b)
})
