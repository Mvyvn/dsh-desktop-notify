// 「聚焦提醒判断器」单测
//
// 锁住的核心语义（用户需求原文：基于聚焦状态，自上次聚焦后再未回来则灯会一直处于提醒状态）：
//   · 人不在时出现"值得看"的结果 → 上闩，灯带 ATTENTION（一直提醒）
//   · 闩只在"人回来"或"显式确认"时解除 —— 不会因为时间流逝自己消失
//   · AI 又跑起来时，闩仍然在（底色告诉你在干活，提醒位告诉你上次没看）
//   · 已看过之后，完成状态安静一会儿就熄灯（卧室场景）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLedJudge, FOCUS_FRESH_MS } from '../lib/led-judge.js'
import { SCENE_FLAG } from '../lib/led-scene.js'
import { emptyFacts, createWorkLedger, aggregateVerdict } from '../lib/lifecycle.js'

const T0 = 1_000_000
const AWAY = { lastFocusedAt: 0 }

/** 用真账本产出一个 verdict，避免手搓结构（判定逻辑本身由 lifecycle.test 覆盖）。 */
function verdictOf(patch, at) {
  const ledger = createWorkLedger()
  ledger.observe('s1', Object.assign(emptyFacts(), patch), at)
  return aggregateVerdict(ledger.evaluateAll(at + 1))
}

test('没有任何会话 → 灯灭', () => {
  const judge = createLedJudge()
  const scene = judge.update(undefined, AWAY, T0)
  assert.equal(scene.state, 'off')
  assert.equal(scene.brightness, 0)
})

test('运行中且人不在 → 白色流动，不带提醒位', () => {
  const judge = createLedJudge()
  const scene = judge.update(verdictOf({ agentRunning: true }, T0), AWAY, T0)
  assert.equal(scene.state, 'running')
  assert.equal(scene.flags & SCENE_FLAG.ATTENTION, 0)
  assert.equal(scene.latched, false)
})

test('完成且人不在 → 上闩，带 ATTENTION（一直提醒）', () => {
  const judge = createLedJudge()
  const scene = judge.update(verdictOf({}, T0), AWAY, T0)
  assert.equal(scene.state, 'done')
  assert.ok(scene.flags & SCENE_FLAG.ATTENTION)
  assert.equal(scene.latched, true)
  assert.match(scene.reason, /提醒中/)
})

test('提醒不会随时间自己消失：一小时后再判，仍然是提醒态', () => {
  const judge = createLedJudge()
  judge.update(verdictOf({}, T0), AWAY, T0)
  const later = judge.update(verdictOf({}, T0), AWAY, T0 + 3600_000)
  assert.ok(later.flags & SCENE_FLAG.ATTENTION)
  assert.equal(later.state, 'done')
})

test('人回来了（新的聚焦上报）→ 提醒解除，转安静版', () => {
  const judge = createLedJudge()
  judge.update(verdictOf({}, T0), AWAY, T0)
  const back = judge.update(verdictOf({}, T0), { lastFocusedAt: T0 + 1000 }, T0 + 1001)
  assert.equal(back.latched, false)
  assert.equal(back.flags & SCENE_FLAG.ATTENTION, 0)
  assert.ok(back.flags & SCENE_FLAG.MUTED)
})

test('聚焦过期（超过保鲜窗口）算作人不在', () => {
  const judge = createLedJudge()
  const stale = judge.update(verdictOf({}, T0), { lastFocusedAt: T0 - FOCUS_FRESH_MS - 1 }, T0)
  assert.equal(stale.latched, true)
})

test('闩生效期间 AI 又跑起来：底色是 running，提醒位仍在', () => {
  const judge = createLedJudge()
  judge.update(verdictOf({}, T0), AWAY, T0)
  const running = judge.update(verdictOf({ agentRunning: true }, T0 + 10), AWAY, T0 + 11)
  assert.equal(running.state, 'running')
  assert.ok(running.flags & SCENE_FLAG.ATTENTION)
  assert.equal(running.latched, true)
})

test('等待你回答 → 黄灯提醒（优先级高于运行中）', () => {
  const judge = createLedJudge()
  const scene = judge.update(verdictOf({ waitingUser: 1, agentRunning: true }, T0), AWAY, T0)
  assert.equal(scene.state, 'waiting')
  assert.ok(scene.flags & SCENE_FLAG.ATTENTION)
})

test('异常 → 红灯提醒', () => {
  const judge = createLedJudge()
  const ledger = createWorkLedger()
  ledger.observe('s1', emptyFacts(), T0)
  ledger.noteError('s1', '后台任务失败', T0)
  const scene = judge.update(aggregateVerdict(ledger.evaluateAll(T0 + 1)), AWAY, T0 + 1)
  assert.equal(scene.state, 'error')
  assert.ok(scene.flags & SCENE_FLAG.ATTENTION)
})

test('关掉「聚焦前持续提醒」开关 → 不再上闩（退化成普通显示）', () => {
  const judge = createLedJudge({ attentionEnabled: false, brightness: 160, idleOffMs: 0, boostWhenAway: true })
  const scene = judge.update(verdictOf({}, T0), AWAY, T0)
  assert.equal(scene.latched, false)
  assert.equal(scene.flags & SCENE_FLAG.ATTENTION, 0)
})

test('人不在时加一档亮度（躺床上要一眼看到）', () => {
  const bright = createLedJudge({ attentionEnabled: true, brightness: 100, idleOffMs: 0, boostWhenAway: true })
  const dim = createLedJudge({ attentionEnabled: true, brightness: 100, idleOffMs: 0, boostWhenAway: false })
  assert.equal(bright.update(verdictOf({}, T0), AWAY, T0).brightness, 148)
  assert.equal(dim.update(verdictOf({}, T0), AWAY, T0).brightness, 100)
})

test('看过之后，完成状态静置 idleOffMs 就熄灯；0 = 永不熄', () => {
  const judge = createLedJudge({ attentionEnabled: true, brightness: 160, idleOffMs: 1000, boostWhenAway: true })
  const here = { lastFocusedAt: T0 }
  assert.equal(judge.update(verdictOf({}, T0), here, T0 + 1).state, 'done')
  assert.equal(judge.update(verdictOf({}, T0), here, T0 + 500).state, 'done')
  assert.equal(judge.update(verdictOf({}, T0), here, T0 + 1500).state, 'off')
  const never = createLedJudge({ attentionEnabled: true, brightness: 160, idleOffMs: 0, boostWhenAway: true })
  never.update(verdictOf({}, T0), here, T0)
  assert.equal(never.update(verdictOf({}, T0), here, T0 + 999999).state, 'done')
})

test('不看屏幕时不会熄灯（提醒期间不计熄灯倒计时）', () => {
  const judge = createLedJudge({ attentionEnabled: true, brightness: 160, idleOffMs: 1000, boostWhenAway: true })
  judge.update(verdictOf({}, T0), AWAY, T0)
  assert.equal(judge.update(verdictOf({}, T0), AWAY, T0 + 5000).state, 'done')
  assert.equal(judge.update(verdictOf({}, T0), AWAY, T0 + 60000).latched, true)
})

test('显式确认（板上按键/诊断端点）解除提醒', () => {
  const judge = createLedJudge()
  judge.update(verdictOf({}, T0), AWAY, T0)
  const acked = judge.acknowledge(T0 + 10)
  assert.equal(acked.latched, false)
  assert.equal(acked.flags & SCENE_FLAG.ATTENTION, 0)
  assert.equal(judge.latch, null)
})

test('签名只在画面真的变了时才变（串口去重靠它）', () => {
  const judge = createLedJudge()
  judge.update(verdictOf({ agentRunning: true }, T0), AWAY, T0)
  const sig1 = judge.signature()
  judge.update(verdictOf({ agentRunning: true }, T0), AWAY, T0 + 100)
  assert.equal(judge.signature(), sig1)
  judge.update(verdictOf({}, T0), AWAY, T0 + 200)
  assert.notEqual(judge.signature(), sig1)
})

test('没有会话时保留闩（人还没回来，回来之前不该把提醒作废）', () => {
  const judge = createLedJudge()
  judge.update(verdictOf({}, T0), AWAY, T0)
  const gone = judge.update(undefined, AWAY, T0 + 10)
  assert.equal(gone.state, 'off')
  assert.equal(judge.latch !== null, true)
  const back = judge.update(verdictOf({}, T0), { lastFocusedAt: T0 + 20 }, T0 + 21)
  assert.equal(back.latched, false)
})
