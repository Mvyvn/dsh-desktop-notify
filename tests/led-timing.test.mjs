// 帧时间预算：**目标帧率只有一个真相**。
//
// 这一组测试存在的理由很具体：上一版代码里 led-controller 的注释写"默认 40ms（25fps）"、
// 代码回退值却是 8ms（125fps）、CHANGELOG 写 240fps、README 写 25fps、serial-link 又写死
// 一个 4ms 的"240fps 硬上限"。四处数字互相矛盾 → "代码里写着 240Hz、实际跑 125Hz"。
// 所以这里把口径钉死：谁改了数字，测试就红。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LED_FRAME_MS, LED_IDLE_FRAME_MS, LED_TARGET_FPS, MAX_TARGET_FPS, clampFrameMs,
  frameBudget, frameBudgetText, minWriteGapMs, monotonicNow, wireTimeMs,
} from '../lib/led-timing.js'
import { BAUD_RATE, MODE, frameBytes } from '../lib/led-protocol.js'

test('一帧 LEDS = 26 字节，线上时间 2.257ms（8-N-1 每字节 10 bit）', () => {
  const bytes = frameBytes(MODE.LEDS)
  assert.equal(bytes, 26)
  const ms = wireTimeMs(bytes, BAUD_RATE)
  assert.ok(Math.abs(ms - 2.257) < 0.001, `实际 ${ms}`)
})

test('目标帧率 240fps → 帧周期 4.1667ms；串口占用 54.2%（可行，但不宽裕）', () => {
  assert.equal(LED_TARGET_FPS, 240)
  assert.ok(Math.abs(LED_FRAME_MS - 1000 / 240) < 1e-9)
  const budget = frameBudget(frameBytes(MODE.LEDS), BAUD_RATE)
  assert.ok(Math.abs(budget.usage - 0.542) < 0.005, `占用率 ${budget.usage}`)
  // 线速上限 ≈ 443fps：目标 240fps 留了约 46% 余量
  assert.ok(budget.maxFps > 400 && budget.maxFps < 460, `线速上限 ${budget.maxFps}`)
  assert.match(frameBudgetText(budget), /目标 240fps/)
})

test('写入下限必须严格小于帧周期 —— 否则目标帧率会被自己的门控砍掉', () => {
  const gap = minWriteGapMs(frameBytes(MODE.LEDS), BAUD_RATE)
  // 26B ≈ 2.26ms → 2.6ms 左右；比物理时间宽一点（波特率有误差）
  assert.ok(gap > wireTimeMs(26, BAUD_RATE), '下限必须高于线上时间，否则会灌爆驱动缓冲')
  assert.ok(gap < LED_FRAME_MS, `下限 ${gap} 必须 < 帧周期 ${LED_FRAME_MS}，否则 240fps 名存实亡`)
})

test('clampFrameMs：缺省就用目标帧率，异常值不会把帧循环搞坏', () => {
  assert.equal(clampFrameMs(undefined), LED_FRAME_MS)
  assert.equal(clampFrameMs(Number.NaN), LED_FRAME_MS)
  assert.equal(clampFrameMs(0), LED_FRAME_MS)
  assert.equal(clampFrameMs(-5), LED_FRAME_MS)
  // 比线速还快（< 1000/400）没有意义：夹到 400fps
  assert.ok(Math.abs(clampFrameMs(0.5) - 1000 / MAX_TARGET_FPS) < 1e-9)
  // 太慢也不行（最慢 1fps）
  assert.equal(clampFrameMs(999999), 1000)
  // 合法值原样保留（测试夹具常用 40ms）
  assert.equal(clampFrameMs(40), 40)
})

test('单调时钟：只增不减（不随系统校时回退）', () => {
  const a = monotonicNow()
  const b = monotonicNow()
  assert.ok(Number.isFinite(a) && Number.isFinite(b))
  assert.ok(b >= a, `单调时钟回退：${a} → ${b}`)
})

test('空闲节拍 200~250ms：明显慢于动画节拍，但快于心跳（不会被空闲节拍拖慢）', () => {
  // 帧循环按需运行：连续动画 240fps，稳态（off / done）降到这个周期。
  // 它必须比 HEARTBEAT_MS（1000ms，serial-link）快 —— 否则心跳、看门狗、验证帧都会被拖慢。
  assert.ok(Number.isFinite(LED_IDLE_FRAME_MS), '空闲节拍必须是有限数')
  assert.ok(LED_IDLE_FRAME_MS >= 200 && LED_IDLE_FRAME_MS <= 250,
    `空闲节拍必须在 200~250ms（实际 ${LED_IDLE_FRAME_MS}ms）`)
  assert.ok(LED_IDLE_FRAME_MS >= LED_FRAME_MS * 40,
    `空闲节拍要明显慢于动画（${LED_FRAME_MS}ms），实际 ${LED_IDLE_FRAME_MS}ms`)
  assert.ok(LED_IDLE_FRAME_MS < 1000, '必须快于 1s 心跳')
})
