// 「真完成检查器」单测
//
// 锁住的核心语义（这几条就是用户提的原始需求）：
//   · 一轮结束（agent idle）但**还有子代理/后台任务/待办输入/开着的回合/active 目标**
//     → 判定仍是 running，绝不能报"完成"
//   · 有人等着回答 → waiting
//   · 目标 blocked → waiting（需要人处理），不是"完成"
//   · 服务缺失（事实全空）→ done（降级但不崩）
//   · 异常有保鲜期，过期不再停留在 error
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkLedger, emptyFacts, aggregateVerdict, phaseLabel } from '../lib/lifecycle.js'

const T0 = 1_000_000
const facts = (patch) => Object.assign(emptyFacts(), patch)

test('什么都没有 → done', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({}), T0)
  const v = ledger.evaluate('s1', T0 + 10)
  assert.equal(v.phase, 'done')
  assert.equal(v.pending, 0)
})

test('一轮结束但子代理还在跑 → running（不是完成）', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ liveSubagents: 2 }), T0)
  const v = ledger.evaluate('s1', T0 + 10)
  assert.equal(v.phase, 'running')
  assert.equal(v.pending, 2)
  assert.match(v.reasons.join(' '), /2 个子代理未结束/)
})

test('一轮结束但后台任务未结算 → running', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ openJobs: 1 }), T0)
  const v = ledger.evaluate('s1', T0 + 10)
  assert.equal(v.phase, 'running')
  assert.match(v.reasons.join(' '), /1 个后台任务未结算/)
})

test('inbox 里还有待处理输入（会被再次调起）→ running', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ pendingInbox: 1 }), T0)
  const v = ledger.evaluate('s1', T0 + 10)
  assert.equal(v.phase, 'running')
  assert.match(v.reasons.join(' '), /会被再次调起/)
})

test('回合边界还开着 → running', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ openTurn: true }), T0)
  assert.equal(ledger.evaluate('s1', T0 + 10).phase, 'running')
})

test('目标 active 且没有任何 agent 在跑 → 仍判 running（round-driver 会再调起）', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ goalPhase: 'active' }), T0)
  const v = ledger.evaluate('s1', T0 + 10)
  assert.equal(v.phase, 'running')
  assert.match(v.reasons.join(' '), /会被再次调起/)
})

test('目标 complete / paused / 无目标 → done', () => {
  const ledger = createWorkLedger()
  ledger.observe('a', facts({ goalPhase: 'complete' }), T0)
  ledger.observe('b', facts({ goalPhase: 'paused' }), T0)
  ledger.observe('c', facts({}), T0)
  assert.equal(ledger.evaluate('a', T0 + 1).phase, 'done')
  assert.equal(ledger.evaluate('b', T0 + 1).phase, 'done')
  assert.equal(ledger.evaluate('c', T0 + 1).phase, 'done')
})

test('目标 blocked → waiting（要人来解，不是完成）', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ goalPhase: 'blocked' }), T0)
  const v = ledger.evaluate('s1', T0 + 1)
  assert.equal(v.phase, 'waiting')
  assert.match(v.reasons.join(' '), /目标已阻塞/)
})

test('有人等你回答 → waiting，且优先级高于一切运行中工作', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ waitingUser: 1, agentRunning: true, liveSubagents: 3, openJobs: 2 }), T0)
  const v = ledger.evaluate('s1', T0 + 1)
  assert.equal(v.phase, 'waiting')
  assert.equal(v.waiting, 1)
  assert.match(v.reasons.join(' '), /等待你的输入\/审批 1 项/)
})

test('异常在保鲜期内 → error；过期后回到普通判定', () => {
  const ledger = createWorkLedger({ errorTtlMs: 1000 })
  ledger.observe('s1', facts({}), T0)
  ledger.noteError('s1', '后台任务失败（job-1）', T0)
  assert.equal(ledger.evaluate('s1', T0 + 999).phase, 'error')
  assert.equal(ledger.evaluate('s1', T0 + 1001).phase, 'done')
})

test('等待优先于异常（等着你回答比"刚才失败过"更该显示）', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ waitingUser: 1 }), T0)
  ledger.noteError('s1', '任意异常', T0)
  assert.equal(ledger.evaluate('s1', T0 + 1).phase, 'waiting')
})

test('clearError 之后不再滞留 error', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({}), T0)
  ledger.noteError('s1', 'x', T0)
  assert.equal(ledger.evaluate('s1', T0 + 1).phase, 'error')
  ledger.clearError('s1')
  assert.equal(ledger.evaluate('s1', T0 + 1).phase, 'done')
})

test('since 只在阶段变化时更新（"亮了多久"要可信）', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ agentRunning: true }), T0)
  const a = ledger.evaluate('s1', T0 + 1000)
  const b = ledger.evaluate('s1', T0 + 5000)
  assert.equal(a.since, T0)          // 阶段从"观测到 running 的那一刻"算起
  assert.equal(a.since, b.since)
  ledger.observe('s1', facts({}), T0 + 6000)
  assert.equal(ledger.evaluate('s1', T0 + 6000).phase, 'done')
  assert.equal(ledger.evaluate('s1', T0 + 6000).since, T0 + 6000)
})

test('aggregateVerdict：error > waiting > running > done；同阶段取最早发生的', () => {
  const ledger = createWorkLedger()
  ledger.observe('done1', facts({}), T0)
  ledger.observe('run1', facts({ agentRunning: true }), T0)
  ledger.observe('wait1', facts({ waitingUser: 2 }), T0)
  ledger.noteError('err1', 'boom', T0)
  ledger.observe('err1', facts({}), T0)
  const all = ledger.evaluateAll(T0 + 10)
  const best = aggregateVerdict(all)
  assert.equal(best.phase, 'error')
  assert.equal(best.sessionId, 'err1')
  assert.equal(aggregateVerdict([]), undefined)
})

test('evaluateAll 排序：最需要人看的排前面，同阶段先发生的在前', () => {
  const ledger = createWorkLedger()
  ledger.observe('later', facts({ waitingUser: 1 }), T0 + 5000)
  ledger.observe('earlier', facts({ waitingUser: 1 }), T0)
  ledger.observe('running', facts({ agentRunning: true }), T0)
  ledger.observe('done', facts({}), T0)
  const order = ledger.evaluateAll(T0 + 6000).map((v) => v.sessionId)
  assert.deepEqual(order, ['earlier', 'later', 'running', 'done'])
})

test('久未更新的会话会被清理（常驻进程里不能无限长）', () => {
  const ledger = createWorkLedger({ staleMs: 1000, maxSessions: 4 })
  ledger.observe('s1', facts({ agentRunning: true }), T0)
  assert.deepEqual(ledger.sessions(), ['s1'])
  ledger.evaluateAll(T0 + 2000)
  assert.deepEqual(ledger.sessions(), [])
})

test('会话条目上限：超出后淘汰最旧的', () => {
  const ledger = createWorkLedger({ maxSessions: 2 })
  ledger.observe('a', facts({}), T0)
  ledger.observe('b', facts({}), T0 + 1)
  ledger.observe('c', facts({}), T0 + 2)
  assert.deepEqual(ledger.sessions().sort(), ['b', 'c'])
})

test('未知会话的判定不抛（等价于"没有未结算工作"）', () => {
  const ledger = createWorkLedger()
  const v = ledger.evaluate('nope', T0)
  assert.equal(v.phase, 'done')
  assert.deepEqual(v.reasons, ['未知会话'])
})

test('observe 会归一脏输入（NaN/负数/未知阶段）', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', { agentRunning: 'yes', liveSubagents: -3, openJobs: NaN, pendingInbox: 2.7, openTurn: 1, waitingUser: null, goalPhase: 'bogus', unfinishedTodos: undefined }, T0)
  const entry = ledger.snapshot(T0).find((e) => e.sessionId === 's1')
  assert.equal(entry.facts.agentRunning, false)
  assert.equal(entry.facts.liveSubagents, 0)
  assert.equal(entry.facts.openJobs, 0)
  assert.equal(entry.facts.pendingInbox, 2)
  assert.equal(entry.facts.openTurn, false)
  assert.equal(entry.facts.waitingUser, 0)
  assert.equal(entry.facts.goalPhase, null)
  assert.equal(entry.facts.unfinishedTodos, 0)
})

test('待办未完成只进说明文字，不把会话判成 running', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ unfinishedTodos: 3 }), T0)
  const v = ledger.evaluate('s1', T0 + 1)
  assert.equal(v.phase, 'done')
  assert.match(v.reasons.join(' '), /3 项待办未勾选/)
})

test('phaseLabel 五态都有中文', () => {
  assert.equal(phaseLabel('running'), '运行中')
  assert.equal(phaseLabel('waiting'), '等待你')
  assert.equal(phaseLabel('done'), '已完成')
  assert.equal(phaseLabel('error'), '异常')
})
