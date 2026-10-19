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

test('目标 blocked → error（任务阻塞属于异常，不是"等你回话"）', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', { ...emptyFacts(), goalPhase: 'blocked' }, T0)
  const v = ledger.evaluateAll(T0)[0]
  assert.equal(v.phase, 'error', 'blocked 应当判成 error')
  assert.match(v.reasons.join(' '), /目标阻塞/)
})

test('目标 blocked 压过运行中：红灯必须立刻出现，不等任务跑完', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ goalPhase: 'blocked', agentRunning: true, liveSubagents: 2, openJobs: 1 }), T0)
  const v = ledger.evaluateAll(T0)[0]
  assert.equal(v.phase, 'error', 'running 不能盖住 blocked 红')
  assert.match(v.reasons.join(' '), /目标阻塞/)
})

test('blocked 被看到后回到真实工作状态，而不是一直 error', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ goalPhase: 'blocked', agentRunning: true }), T0)
  assert.equal(ledger.evaluate('s1', T0 + 1).phase, 'error')
  ledger.acknowledgeBlocked()
  assert.equal(ledger.evaluate('s1', T0 + 2).phase, 'running', '看过后红灯退出，回到运行白')

  // 工作结束 → done（goalPhase 仍是 blocked，但已确认过）
  ledger.observe('s1', facts({ goalPhase: 'blocked' }), T0 + 100)
  const done = ledger.evaluate('s1', T0 + 101)
  assert.equal(done.phase, 'done', '会话结束后应能显示完成绿')
  assert.equal(done.completed, true)

  // 再次进入 blocked 的新一次阻塞 → 重新亮红
  ledger.observe('s1', facts({ goalPhase: 'complete' }), T0 + 200)
  ledger.observe('s1', facts({ goalPhase: 'blocked' }), T0 + 300)
  assert.equal(ledger.evaluate('s1', T0 + 301).phase, 'error', '新阻塞要重新亮红')
})

test('异常压过失焦等待（统一优先级：红 > 橙）', () => {
  const ledger = createWorkLedger()
  ledger.observe('s1', facts({ waitingUser: 1 }), T0)
  ledger.noteError('s1', '目标阻塞', T0)
  assert.equal(ledger.evaluate('s1', T0 + 1).phase, 'error')
})

test('等待优先于普通运行中工作（但异常/阻塞会压过它）', () => {
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
  // 优先级：等待(1) ＞ 完成(2) ＞ 运行中(3)
  assert.deepEqual(order, ['earlier', 'later', 'done', 'running'])
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

test('快速切换会话：空闲会话不闪绿，真完成才播报（判据是宿主事件，不是时间窗口）', () => {
  const ledger = createWorkLedger()
  // s1 在跑（turn/start 已溯源）
  ledger.observe('s1', facts({ agentRunning: true, everRan: true }), T0)
  assert.equal(ledger.evaluate('s1', T0 + 100).phase, 'running')

  // 切到一个**空闲会话**：它是 done，但 completed=false → 不播报绿灯
  ledger.observe('idle', facts({}), T0 + 200)
  const idle = ledger.evaluate('idle', T0 + 200)
  assert.equal(idle.phase, 'done')
  assert.equal(idle.completed, false, '空闲会话不是完成')

  // s1 真的跑完了（everRan=true 且没活了）→ completed=true，立刻可播报
  ledger.observe('s1', facts({ everRan: true }), T0 + 300)
  const done = ledger.evaluate('s1', T0 + 300)
  assert.equal(done.phase, 'done')
  assert.equal(done.completed, true, '跑过再停 = 真完成')
})
test('空闲会话（从没干过活）的 done 不算完成 → 不会点亮绿灯', () => {
  const ledger = createWorkLedger()
  // s1 在跑；s2 是刚切过去的空闲会话（从没跑过任何东西）
  ledger.observe('s1', Object.assign(emptyFacts(), { agentRunning: true }), T0)
  ledger.observe('s2', emptyFacts(), T0)
  const all = ledger.evaluateAll(T0 + 100)
  const s2 = all.find((v) => v.sessionId === 's2')
  assert.equal(s2.phase, 'done', '空闲会话的阶段仍然是 done（没有未结算工作）')
  assert.equal(s2.completed, false, '但它**不是一次完成**，不该播报绿灯')

  // s2 真的干过活再停下 → 才算完成
  ledger.observe('s2', Object.assign(emptyFacts(), { agentRunning: true }), T0 + 1000)
  ledger.evaluate('s2', T0 + 1100)
  ledger.observe('s2', emptyFacts(), T0 + 2000)
  const settled = ledger.evaluate('s2', T0 + 3000)
  assert.equal(settled.phase, 'done')
  assert.equal(settled.completed, true, '干过活再停下才是完成')
})

test('快速回合：宿主事件说"跑过"，即使采样从没见到 pending>0 也算完成', () => {
  const ledger = createWorkLedger()
  // 只有 everRan 为 true（turn/start 事件来过），采样里从来没有 pending
  ledger.observe('s1', facts({ everRan: true }), T0)
  const settled = ledger.evaluate('s1', T0 + 100)
  assert.equal(settled.phase, 'done')
  assert.equal(settled.completed, true, '事件溯源认定它跑过 → 这是一次真完成')

  // 对照：同样没有 pending，但 everRan=false（纯空闲会话）→ 不算完成
  ledger.observe('s2', facts({}), T0)
  const idle = ledger.evaluate('s2', T0 + 100)
  assert.equal(idle.phase, 'done')
  assert.equal(idle.completed, false, '空闲会话不是完成')
})
