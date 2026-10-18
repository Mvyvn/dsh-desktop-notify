// 主机端渲染器测试：语义画面 + 时刻 → 7 颗灯的像素
//
// 固件没有动画能力，所以"好不好看"全在这里。断言要**可核对**：
// 同一时刻的像素是确定的、亮度是乘出来的、提醒是双闪的、熄灯是真的黑。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPixels, alertEnvelope, STATE_COLOR, blendPixels } from '../lib/led-render.js'
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

test('异常：**只有提醒时才闪**，否则常亮纯红（人回来了就别再骚扰）', () => {
  const at = (ms, flags = 0) => renderPixels({ state: 'error', flags, brightness: 255, latched: false, reason: '' }, ms)
  const sum = (px) => px.reduce((n, p) => n + p.r + p.g + p.b, 0)

  // 无提醒：任何时刻都一样亮（常亮），并且是纯红
  const a = at(0)
  const b = at(400)
  assert.equal(sum(a), sum(b), '没有提醒闩时不该闪（常亮）')
  const px = a[0]
  assert.ok(px.r > 0 && px.g === 0 && px.b === 0, `常亮也必须是纯红：${JSON.stringify(px)}`)

  // 有提醒：会随时间变化（闪），且有暗段
  const blinkSum = [0, 200, 400, 600, 800].map((ms) => sum(at(ms, 1   /* SCENE_FLAG.ATTENTION */)))
  assert.ok(new Set(blinkSum).size > 1, `带提醒时应当在闪：${JSON.stringify(blinkSum)}`)
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
test('流转：从左边切入、折返处连续（不闪不抖）、两端更慢（总时长不变）', () => {
  const MS = 170                     // 与 led-render 的 COMET_MS_PER_LED 一致
  const leg = 6 * MS
  const at = (age) => renderPixels(scene('running', 0, 255), 1e9, age)
  const lum = (px) => px.map((p) => p.r + p.g + p.b)
  const com = (age) => {
    const l = lum(at(age))
    let s = 0
    let w = 0
    l.forEach((v, i) => { s += i * v; w += v })
    return w ? s / w : 0
  }

  // 1) 从左边切入
  const early = lum(at(200))
  assert.ok(early[0] + early[1] > 0, '刚出现时应当在左侧')
  assert.equal(early[5] + early[6], 0, '右侧此刻应当还没亮')

  // 2) 折返处**完全连续**（这是"转向闪一下"的回归防线）
  const before = lum(at(leg - 1))
  const after = lum(at(leg + 1))
  const maxDiff = Math.max(...before.map((v, i) => Math.abs(v - after[i])))
  assert.ok(maxDiff <= 8, `折返前后应当几乎一致：maxDiff=${maxDiff}`)

  // 3) 两端更慢：中段位移明显大于贴近端点时的位移
  const midStep = com(500) - com(400)
  const endStep = com(leg - 60) - com(leg - 160)
  assert.ok(midStep > endStep * 1.4, `两端应当更慢：mid=${midStep.toFixed(2)} end=${endStep.toFixed(2)}`)

  // 4) 任何时刻都不该全黑
  for (const age of [200, 500, 900, leg, leg + 400]) {
    assert.ok(lum(at(age)).some((v) => v > 0), `${age}ms 不该全黑`)
  }
})
test('交叉渐变不会把亮度冲高（逐通道夹在两端点之间）', () => {
  const a = [{ r: 0, g: 200, b: 0 }]   // 亮绿
  const b = [{ r: 30, g: 0, b: 40 }]   // 暗紫
  for (let i = 1; i < 10; i += 1) {
    const mid = blendPixels(a, b, i / 10)[0]
    assert.ok(mid.r >= 0 && mid.r <= 30, 'r 必须夹在两端点之间')
    assert.ok(mid.g >= 0 && mid.g <= 200, 'g 必须夹在两端点之间')
    assert.ok(mid.b >= 0 && mid.b <= 40, 'b 必须夹在两端点之间')
  }
})

test('异常色是纯红（不是偏粉的玫红）', () => {
  assert.deepEqual(STATE_COLOR.error, { r: 255, g: 0, b: 0 })
})


test('折返处连续：转向前后两帧差异很小（不再"熄灭一下"）', () => {
  const leg = 6 * 280          // 单程 1680ms
  const before = renderPixels(scene('running', 0, 255), leg - 5)
  const after = renderPixels(scene('running', 0, 255), leg + 5)
  let maxDiff = 0
  for (let i = 0; i < 7; i += 1) {
    for (const ch of ['r', 'g', 'b']) {
      maxDiff = Math.max(maxDiff, Math.abs(before[i][ch] - after[i][ch]))
    }
  }
  // 方向翻转会让尾巴镜像，允许一定差异；关键是**不能熄灭**
  assert.ok(maxDiff <= 160, `折返前后差异应当可控：maxDiff=${maxDiff}`)
  assert.ok(before.some((p) => p.r + p.g + p.b > 0) && after.some((p) => p.r + p.g + p.b > 0), '折返前后都必须有光（不能熄灭一下）')
})
