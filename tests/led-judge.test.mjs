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
const AWAY = { focused: false }

/** 产出一个"异常"verdict（后台任务失败）。 */
function errorVerdictOf(at) {
  const ledger = createWorkLedger()
  ledger.observe('s1', emptyFacts(), at)
  ledger.noteError('s1', '后台任务失败', at)
  return aggregateVerdict(ledger.evaluateAll(at + 1))
}

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

test('完成且人不在 → 常亮绿（**不闪**，绿灯不该被提醒闩拉去双闪）', () => {
  const judge = createLedJudge()
  // 先"干过活"再停下 —— 空闲会话的 done 不算完成（见 completed 语义）。
  // 必须用**同一个账本**：sawWork 记在账本条目上。
  const ledger = createWorkLedger()
  ledger.observe('s1', Object.assign(emptyFacts(), { agentRunning: true }), T0)
  judge.update(aggregateVerdict(ledger.evaluateAll(T0 + 10)), AWAY, T0 + 10)
  ledger.observe('s1', emptyFacts(), T0 + 700)
  judge.update(aggregateVerdict(ledger.evaluateAll(T0 + 800)), AWAY, T0 + 800)
  const scene = judge.update(aggregateVerdict(ledger.evaluateAll(T0 + 3100)), AWAY, T0 + 3100)
  assert.equal(scene.state, 'done')
  assert.equal(scene.flags & SCENE_FLAG.ATTENTION, 0, '完成不该带提醒位')
  assert.equal(scene.latched, false)
  // done 渲染本身就是常亮（不呼吸、不闪）；MUTED 只是"看过"的标记，人不在时还没有
  assert.equal(scene.flags & SCENE_FLAG.MUTED, 0, '人不在时还没有"已看"标记')
})

test('等你（黄）一直在：一小时后再判仍然是黄灯', () => {
  const judge = createLedJudge()
  const waiting = verdictOf({ waitingUser: 1 }, T0)
  judge.update(waiting, AWAY, T0)
  judge.update(waiting, AWAY, T0 + 3100)
  const later = judge.update(waiting, AWAY, T0 + 3600_000)
  assert.equal(later.state, 'waiting', '没被回答就一直黄着')
})

test('人回来了（新的聚焦上报）→ 提醒解除，灯熄灭', () => {
  const j = createLedJudge()
  const away = { focused: false }
  const AWAY_LATE = T0 + 3100
  j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, away, T0)
  const awayScene = j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, away, T0 + 3100)
  assert.equal(awayScene.state, 'done', '人不在：常亮绿')
  const back = j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, { focused: true }, T0 + 4000)
  assert.equal(back.latched, false, '回到页面：提醒解除')
  assert.equal(back.state, 'off', '回到页面：直接熄灭')
})

test('失焦不到 3 秒不算离开（迟滞防 flap）', () => {
  const judge = createLedJudge()
  const err = errorVerdictOf(T0)
  judge.update(err, { focused: true }, T0)
  const tooSoon = judge.update(err, { focused: false }, T0 + 2000)
  assert.equal(tooSoon.latched, false, '失焦 2s 不该上闩')
  const after = judge.update(err, { focused: false }, T0 + 5200)
  assert.equal(after.latched, true, '失焦满 3s（自首次失焦算）应当上闩')
})

test('闩生效期间 AI 又跑起来：底色是 running，提醒位仍在', () => {
  const judge = createLedJudge()
  judge.update(errorVerdictOf(T0), AWAY, T0)
  judge.update(errorVerdictOf(T0), AWAY, T0 + 3100)
  const running = judge.update(verdictOf({ agentRunning: true }, T0 + 10), AWAY, T0 + 3200)
  assert.equal(running.state, 'running')
  assert.ok(running.flags & SCENE_FLAG.ATTENTION)
  assert.equal(running.latched, true)
})

test('等待你回答 → 黄灯提醒（优先级高于运行中）', () => {
  const judge = createLedJudge()
  const scene = judge.update(verdictOf({ waitingUser: 1, agentRunning: true }, T0), AWAY, T0)
  assert.equal(scene.state, 'waiting', '有人在等你回答时，优先级高于"在跑"')
  assert.equal(scene.flags & SCENE_FLAG.ATTENTION, 0, '黄灯只呼吸，不叠双闪')
})

test('异常 → 红灯提醒', () => {
  const judge = createLedJudge()
  const ledger = createWorkLedger()
  ledger.observe('s1', emptyFacts(), T0)
  ledger.noteError('s1', '后台任务失败', T0)
  judge.update(aggregateVerdict(ledger.evaluateAll(T0 + 1)), AWAY, T0 + 1)
  const scene = judge.update(aggregateVerdict(ledger.evaluateAll(T0 + 1)), AWAY, T0 + 3100)
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
  bright.update(errorVerdictOf(T0), AWAY, T0)
  dim.update(errorVerdictOf(T0), AWAY, T0)
  assert.equal(bright.update(errorVerdictOf(T0), AWAY, T0 + 3100).brightness, 148)
  assert.equal(dim.update(errorVerdictOf(T0), AWAY, T0 + 3100).brightness, 100)
})

test('完成：页面内静态保持 2s 后熄灭（不再用 idleOffMs）', () => {
  const j = createLedJudge()
  const here = { focused: true }
  const a = j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, here, T0)
  assert.equal(a.state, 'done', '先显示')
  const b = j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, here, T0 + 2100)
  assert.equal(b.state, 'off', '2s 后熄灭')
})

test('不看屏幕时不会熄灯（提醒期间不计熄灯倒计时）', () => {
  const judge = createLedJudge({ attentionEnabled: true, brightness: 160, idleOffMs: 1000, boostWhenAway: true })
  judge.update(verdictOf({ waitingUser: 1 }, T0), AWAY, T0)
  assert.equal(judge.update(verdictOf({ waitingUser: 1 }, T0), AWAY, T0 + 3100).state, 'waiting')
  assert.equal(judge.update(verdictOf({ waitingUser: 1 }, T0), AWAY, T0 + 5000).state, 'waiting')
  assert.equal(judge.update(verdictOf({ waitingUser: 1 }, T0), AWAY, T0 + 60000).state, 'waiting')
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
  judge.update(errorVerdictOf(T0), AWAY, T0)
  judge.update(errorVerdictOf(T0), AWAY, T0 + 3100)
  const gone = judge.update(undefined, AWAY, T0 + 3200)
  assert.equal(gone.state, 'off')
  assert.equal(judge.latch !== null, true)
  const back = judge.update(verdictOf({}, T0), { focused: true }, T0 + 21)
  assert.equal(back.latched, false)
})

test('两种情形：不在页面一直保持（聚焦即熄）；本来在页面则静态 2s 后熄', () => {
  const T = 5_000_000
  const away = { focused: false }
  const AWAY_LATE = T0 + 3100      // 10 分钟前才聚焦过 = 人不在
  const here = { focused: true }                    // 正聚焦

  // A. 不在页面：完成 → 绿常亮，且一直不熄（30 秒后仍有画面）
  let j = createLedJudge()
  j.update({ phase: 'running', reasons: ['在跑'], sessionId: 's1' }, away, T)
  j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, away, T + 700)
  j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, away, T + 3100)
  const later = j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, away, T + 30_000)
  assert.equal(later.state, 'done', '人不在时应一直保持绿色')
  assert.ok((later.flags & 2) === 0, '不该是唤醒态')

  // A2. 回到页面 → 立刻熄灭（不需要再等 2 秒）
  const back = j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, { focused: true }, T + 30_100)
  assert.equal(back.state, 'off', '回到页面应当立刻熄灭')

  // B. 本来就在页面：2 秒内保持（静态），2 秒后熄灭
  j = createLedJudge()
  const b1 = j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, here, T)
  assert.equal(b1.state, 'done', '页面内先保持')
  const b2 = j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, here, T + 1_900)
  assert.equal(b2.state, 'done', '1.9s 时还在')
  const b3 = j.update({ phase: 'done', reasons: ['回合结束'], sessionId: 's1' }, here, T + 2_100)
  assert.equal(b3.state, 'off', '2s 后熄灭')

  // C. 等待（黄）：**不管聚焦与否都呼吸**，直到被回答/超时（用户明确要求）
  j = createLedJudge()
  const wAway = j.update({ phase: 'waiting', reasons: ['在等你'], sessionId: 's1' }, away, T)
  assert.equal(wAway.state, 'waiting')
  assert.ok((wAway.flags & 2) === 0, '人不在：呼吸')
  const wHere = j.update({ phase: 'waiting', reasons: ['在等你'], sessionId: 's1' }, here, T + 30_000)
  assert.equal(wHere.state, 'waiting', '页面内也**不熄**（问题还挂着）')
  assert.ok((wHere.flags & 2) === 0, '页面内也**不静态**：继续呼吸')

  // D. 异常：不在页面 → 挂提醒（闪）；在页面 → 不挂（常亮），2s 后熄灭
  j = createLedJudge()
  j.update({ phase: 'error', reasons: ['任务失败'], sessionId: 's1' }, away, T)
  const eAway = j.update({ phase: 'error', reasons: ['任务失败'], sessionId: 's1' }, away, T + 3100)
  assert.equal(eAway.state, 'error')
  assert.equal(eAway.latched, true, '人不在（满 3s）：红灯要闪')
  j = createLedJudge()
  const e1 = j.update({ phase: 'error', reasons: ['任务失败'], sessionId: 's1' }, here, T)
  assert.equal(e1.latched, false, '页面内：红灯常亮不闪')
  const e2 = j.update({ phase: 'error', reasons: ['任务失败'], sessionId: 's1' }, here, T + 2_100)
  assert.equal(e2.state, 'off', '页面内 2s 后熄灭')
})

test('优先级：报错 0 ＞ 等待 1 ＞ 完成 2 ＞ 运行中 3（高打断低，低排队）', () => {
  const T = 6_000_000
  const ledger = createWorkLedger()
  ledger.observe('s1', emptyFacts(), T)
  // 同时存在：异常 + 等待 + 完成条件
  ledger.noteError('s1', '后台任务失败', T)

  const judge = createLedJudge()
  const errFirst = judge.update(aggregateVerdict(ledger.evaluateAll(T + 1)), { focused: false }, T + 1)
  assert.equal(errFirst.state, 'error', '最高优先级：红灯')

  // 看到并熄灭之后，低优先级应当"排队"接着显示
  const here = { focused: true }
  judge.update(aggregateVerdict(ledger.evaluateAll(T + 2)), here, T + 2)
  const offAfterSeen = judge.update(aggregateVerdict(ledger.evaluateAll(T + 200)), here, T + 3100)
  assert.equal(offAfterSeen.state, 'off', '异常被看到 → 熄灭（10 分钟内仍有保鲜期）')

  // 新异常到来 → 重新亮（粘滞标记要被复位）
  ledger.noteError('s1', '又一次失败', T + 4000)
  judge.resetErrorAck()
  const again = judge.update(aggregateVerdict(ledger.evaluateAll(T + 4001)), { focused: false }, T + 4001)
  assert.equal(again.state, 'error', '新异常应当重新点亮红灯')
})

test('完成排在运行之前：别的会话在跑时，完成仍能播报', () => {
  const T = 7_000_000
  const ledger = createWorkLedger()
  ledger.observe('busy', Object.assign(emptyFacts(), { agentRunning: true }), T)
  ledger.observe('finished', emptyFacts(), T)
  const v = aggregateVerdict(ledger.evaluateAll(T + 10))
  assert.equal(v.phase, 'done', '完成（2）应当压过运行中（3）')
})

test('多会话：一个完成时另一些还在跑 → 先播报完成，看过之后回到运行中；第二个完成再播报', () => {
  const T = 8_000_000
  const ledger = createWorkLedger()
  ledger.observe('busy', Object.assign(emptyFacts(), { agentRunning: true }), T)

  const judge = createLedJudge()
  const here = { focused: true }

  // 只有 busy 在跑：白
  const white = judge.update(ledger.evaluateAll(T + 1), here, T + 1)
  assert.equal(white.state, 'running')

  // s1 先干过活，然后完成（busy 仍在跑）。注意要越过 600ms 完成稳定窗口。
  ledger.observe('s1', Object.assign(emptyFacts(), { agentRunning: true }), T + 500)
  ledger.observe('s1', emptyFacts(), T + 1000)
  judge.update(ledger.evaluateAll(T + 1050), here, T + 1050)
  const green = judge.update(ledger.evaluateAll(T + 1700), here, T + 1700)
  assert.equal(green.state, 'done', '完成要打断运行中的白')

  // 在页面里看满 2 秒：熄灭 → 排队中的"运行中"接上
  const afterGreen = judge.update(ledger.evaluateAll(T + 4400), here, T + 4400)
  assert.equal(afterGreen.state, 'running', '完成播报结束后回到运行中（低优先级排队）')

  // s2 也干过活然后完成：即使"上一条完成"已经看过，新完成要再播报一次
  ledger.observe('s2', Object.assign(emptyFacts(), { agentRunning: true }), T + 4500)
  ledger.observe('s2', emptyFacts(), T + 5000)
  judge.update(ledger.evaluateAll(T + 5050), here, T + 5050)
  const green2 = judge.update(ledger.evaluateAll(T + 5750), here, T + 5750)
  assert.equal(green2.state, 'done', '第二会话完成应当重新播报')
})
