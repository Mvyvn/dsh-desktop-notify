// 主机端渲染器测试：语义画面 + 时刻 → 7 颗灯的像素
//
// 固件没有动画能力，所以"好不好看"全在这里。断言要**可核对**：
// 同一时刻的像素是确定的、亮度是乘出来的、提醒是双闪的、熄灯是真的黑。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderPixels, alertEnvelope, STATE_COLOR, blendPixels,
  renderPixelsInto, blendPixelsInto, ditherPixels, ditherPixelsInto, createPixelFrame,
} from '../lib/led-render.js'
import { encodeLeds, encodeLedsInto } from '../lib/led-protocol.js'
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

test('提醒（ATTENTION）：双闪包络两端有短渐变（中断时不会停在半亮/半暗）', () => {
  assert.equal(alertEnvelope(0), 0, '起点从暗开始，不在方波边缘硬切')
  assert.ok(alertEnvelope(40) > 0.99)
  assert.ok(alertEnvelope(55) > 0.99)
  assert.ok(alertEnvelope(100) > 0 && alertEnvelope(100) < 1, '下降沿是渐变的')
  assert.equal(alertEnvelope(150), 0)
  assert.ok(alertEnvelope(300) > 0.99, '第二个亮块')
  assert.equal(alertEnvelope(400), 0)
  // 画面真的跟着包络变（取第二个亮块的峰值 300ms 对暗段 400ms）
  const on = renderPixels(scene('waiting', SCENE_FLAG.ATTENTION, 255), 300)
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
  const MS = 170 / 1.03              // 与 led-render 的 COMET_MS_PER_LED 一致（整体 +3%）
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
test('折返点不再有单帧凹陷（两头微闪回归）：折返处速度为零、无逐帧来回跳', () => {
  const MS = 170 / 1.03
  const leg = 6 * MS
  const at = (age) => renderPixels(scene('running', 0, 191), 1e9, age)
  const STEP = 1000 / 240
  // 1) 两个来回内，任何通道都不出现"a→b→a"的逐帧方向反转（旧曲线在折返处有 ±2 凹陷）
  const frames = []
  for (let age = 0; age <= leg * 4; age += STEP) frames.push(at(age))
  let reverses = 0
  for (let i = 1; i < frames.length - 1; i += 1) {
    for (let p = 0; p < 7; p += 1) {
      for (const ch of ['r', 'g', 'b']) {
        const a = frames[i - 1][p][ch]
        const b = frames[i][p][ch]
        const c = frames[i + 1][p][ch]
        if (b !== a && c === a && Math.abs(a - b) <= 3) reverses += 1
      }
    }
  }
  assert.equal(reverses, 0, `折返处不该再逐帧来回跳（${reverses} 次）`)

  // 2) 折返前后 ±40ms 内，相邻帧的单通道变化必须 ≤1 LSB
  //    （旧实现实测 42→41→43：单帧 2 LSB 凹陷，240Hz 下就是"极快微闪"）
  for (const center of [leg, leg * 2]) {
    let prev = null
    for (let age = center - 40; age <= center + 40; age += STEP) {
      const px = at(age)
      if (prev !== null) {
        for (let p = 0; p < 7; p += 1) {
          for (const ch of ['r', 'g', 'b']) {
            const delta = Math.abs(px[p][ch] - prev[p][ch])
            assert.ok(delta <= 1,
              `折返点 ${center}ms 附近单帧变化应 ≤1：led${p}.${ch} ${prev[p][ch]}→${px[p][ch]}（Δ=${delta}）`)
          }
        }
      }
      prev = px
    }
  }

  // 3) 端点速度为零：折返前后 10ms 内位置几乎不动（单摆曲线）
  const com = (age) => {
    const px = at(age)
    let s = 0
    let w = 0
    px.forEach((p, i) => { const v = p.r + p.g + p.b; s += i * v; w += v })
    return w ? s / w : 0
  }
  for (const center of [leg, leg * 2]) {
    const near = Math.abs(com(center) - com(center - 10))
    const mid = Math.abs(com(leg / 2) - com(leg / 2 - 10))
    assert.ok(mid > near * 3, `端点应明显更慢：mid=${mid.toFixed(3)} near=${near.toFixed(3)}`)
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

test('警告（黄）：常亮、不随时间变化（2s 瞬态由控制器计时，渲染层不做呼吸/闪烁）', () => {
  const a = renderPixels(scene('warn', 0, 255), 0)
  const b = renderPixels(scene('warn', 0, 255), 1700)
  assert.deepEqual(a, b, '黄灯常亮，渲染结果不随时刻变化')
  const px = a[0]
  assert.ok(px.r > 200 && px.g > 150 && px.b < 40, `黄：${JSON.stringify(px)}`)
  assert.deepEqual(STATE_COLOR.warn, { r: 255, g: 0xd0, b: 0 })
  // 黄是红/橙之后的第三档：高红、高绿、低蓝（不是橙的 255/160/0，也不是红）
  assert.ok(STATE_COLOR.warn.g > 180 && STATE_COLOR.warn.g < 230, `黄的正确绿通道：${STATE_COLOR.warn.g}`)
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

// ── in-place 渲染（帧循环复用缓冲）与纯函数逐字节对拍 ───────────────────────
// 帧循环 240fps：每帧渲染 = 7 个像素 + 渐变混合 + 抖动 + 编码 26 字节。
// in-place 入口写进预分配缓冲（不再每帧新建对象）；纯函数版本保留给测试与一次性调用。
// 两者必须**逐字节一致** —— 这是"减分配不能改像素输出"的验收口径。

const SCENE_GRID = []
for (const state of ['off', 'running', 'waiting', 'done', 'error']) {
  for (const flags of [0, 1, 2, 4, 3, 5]) {
    for (const brightness of [0, 1, 33, 128, 200, 255]) {
      SCENE_GRID.push({ state, flags, brightness, latched: (flags & 1) !== 0, reason: '' })
    }
  }
}
const TIME_GRID = [0, 7.5, 123.456, 400, 900, 1600, 2400, 5000.25, 1_000_003.75]

test('in-place 渲染与纯函数逐字节一致（状态×标志×亮度×时刻全矩阵，复用同一块缓冲）', () => {
  const reused = []
  for (const s of SCENE_GRID) {
    for (const nowMs of TIME_GRID) {
      const age = (nowMs * 1.7) % 2000
      assert.deepEqual(
        renderPixelsInto(reused, s, nowMs, age),
        renderPixels(s, nowMs, age),
        `不一致：${JSON.stringify(s)} t=${nowMs}`,
      )
    }
    // age 未知（Infinity）也要一致：running 的相位会退回绝对时刻
    assert.deepEqual(renderPixelsInto(reused, s, 1234), renderPixels(s, 1234))
  }
  assert.equal(reused.length, 7)
})

test('in-place 混合与纯函数逐字节一致（端点/中段，且不改两个入参）', () => {
  const a = Array.from({ length: 7 }, (_, i) => ({ r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 53) % 256 }))
  const b = Array.from({ length: 7 }, (_, i) => ({ r: 255 - (i * 29) % 256, g: (i * 13) % 256, b: 255 - (i * 61) % 256 }))
  const aCopy = a.map((px) => ({ ...px }))
  const bCopy = b.map((px) => ({ ...px }))
  const out = []
  for (const k of [-0.5, 0, 0.01, 0.25, 0.5, 0.75, 0.99, 1, 1.5]) {
    assert.deepEqual(blendPixelsInto(out, a, b, k), blendPixels(a, b, k), `k=${k}`)
  }
  assert.deepEqual(a, aCopy, '混合不能改入参 a')
  assert.deepEqual(b, bCopy, '混合不能改入参 b')
})

test('in-place 抖动与纯函数逐字节一致（不改入参）', () => {
  const src = Array.from({ length: 7 }, (_, i) => ({ r: i * 20, g: 255 - i * 20, b: (i * 7) % 256 }))
  const copy = src.map((px) => ({ ...px }))
  for (const frame of [0, 1, 2, 3, 17, 1000]) {
    const out = src.map((px) => ({ ...px }))
    assert.deepEqual(ditherPixelsInto(out, frame), ditherPixels(src, frame), `frame=${frame}`)
  }
  assert.deepEqual(src, copy, '抖动不能改入参')
})

test('可复用像素帧：反复渲染返回同一块缓冲，内容始终等于纯函数', () => {
  const frame = createPixelFrame()
  assert.equal(frame.pixels.length, 7)
  for (const s of SCENE_GRID.slice(0, 30)) {
    assert.equal(frame.render(s, 1234, 100), frame.pixels, '必须复用同一块缓冲（不每帧新建对象）')
    assert.deepEqual(frame.pixels, renderPixels(s, 1234, 100))
  }
  const a = renderPixels(scene('waiting', 0, 255), 0)
  const b = renderPixels(scene('done', SCENE_FLAG.MUTED, 255), 0)
  assert.deepEqual(frame.blend(a, b, 0.5), blendPixels(a, b, 0.5))
  assert.deepEqual(frame.copyFrom(a), a)
  assert.deepEqual(frame.dither(7), ditherPixels(a, 7))
})

test('encodeLedsInto：写预分配 26 字节缓冲，输出与 encodeLeds 逐字节一致', () => {
  const cases = [
    Array.from({ length: 7 }, () => ({ r: 255, g: 160, b: 0 })),
    Array.from({ length: 7 }, (_, i) => ({ r: i * 36, g: 255 - i * 36, b: (i * 73) % 256 })),
    Array.from({ length: 7 }, () => ({ r: 300, g: -5, b: 128.7 })),   // 夹紧路径
  ]
  const frame = Buffer.alloc(26)
  for (const pixels of cases) {
    assert.equal(encodeLedsInto(pixels, frame).toString('hex'), encodeLeds(pixels).toString('hex'))
  }
  // 同一个缓冲连续写两帧：第二帧必须完全覆盖，不能残留上一帧的字节
  encodeLedsInto(cases[0], frame)
  const first = frame.toString('hex')
  encodeLedsInto(cases[1], frame)
  assert.equal(frame.toString('hex'), encodeLeds(cases[1]).toString('hex'))
  assert.notEqual(frame.toString('hex'), first)
  assert.throws(() => encodeLedsInto(cases[0], Buffer.alloc(25)), /26 字节/)
  assert.throws(() => encodeLedsInto(cases[0].slice(1), Buffer.alloc(26)), /需要 7 颗灯/)
})
