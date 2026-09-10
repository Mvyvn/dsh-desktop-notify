// 聚焦门控单测（node:test，无第三方依赖）
//   node --test tests/
//
// 锁住的核心语义：
//   · 只有"聚焦页面当前选中的会话"的通知才静默；看会话 A 时会话 B 照常弹
//   · 归属不明（拿不到会话 id）的通知一律推送，不静默
//   · 聚焦静止超时 / 页面残留超时清除
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFocusGate, sessionIdList, FOCUS_STALE_MS, PAGE_STALE_MS } from '../lib/gate.js'

const T0 = 1_000_000

test('没有页面上报时一律推送', () => {
  const gate = createFocusGate()
  assert.equal(gate.silenced(['s1'], T0), false)
})

test('聚焦页面选中的会话与该通知同属一个会话时静默', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, 's1')
  assert.equal(gate.silenced(['s1'], T0 + 1000), true)
})

test('看会话 A 时，会话 B 的通知照常推送', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, 's1')
  assert.equal(gate.silenced(['s2'], T0 + 1000), false)
})

test('通知拿不到会话归属时不静默', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, 's1')
  assert.equal(gate.silenced([], T0 + 1000), false)
})

test('页面没上报会话 id 时不会误静默任何会话', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, '')
  assert.equal(gate.silenced(['s1'], T0 + 1000), false)
})

test('多个页面：只要有一个聚焦页面选中该会话就静默', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, 's-other')
  gate.setPage('p2', T0, 's1')
  assert.equal(gate.silenced(['s1'], T0 + 1000), true)
})

test('页面失焦后不再静默', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, 's1')
  gate.clearPage('p1')
  assert.equal(gate.silenced(['s1'], T0 + 1000), false)
})

test('聚焦静止超过保鲜时长视为失焦', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, 's1')
  assert.equal(gate.silenced(['s1'], T0 + FOCUS_STALE_MS - 1), true)
  assert.equal(gate.silenced(['s1'], T0 + FOCUS_STALE_MS), false)
})

test('长时间无上报的页面条目被清理', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, 's1')
  assert.equal(gate.size, 1)
  gate.silenced(['s1'], T0 + PAGE_STALE_MS + 1)
  assert.equal(gate.size, 0)
})

test('子代理通知：主会话或子会话任一被选中都静默', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, 'sub-1')
  assert.equal(gate.silenced(sessionIdList(['main-1', 'sub-1']), T0 + 1000), true)
})

test('会话切换即时生效：同一页面改报新会话后，旧会话通知恢复推送', () => {
  const gate = createFocusGate()
  gate.setPage('p1', T0, 's1')
  assert.equal(gate.silenced(['s1'], T0 + 1000), true)
  gate.setPage('p1', T0 + 2000, 's2')
  assert.equal(gate.silenced(['s1'], T0 + 3000), false)
  assert.equal(gate.silenced(['s2'], T0 + 3000), true)
})

test('sessionIdList 归一：会话对象 / 字符串 / 数组 / 空值', () => {
  assert.deepEqual(sessionIdList(undefined), [])
  assert.deepEqual(sessionIdList(null), [])
  assert.deepEqual(sessionIdList('s1'), ['s1'])
  assert.deepEqual(sessionIdList({ id: 's1' }), ['s1'])
  assert.deepEqual(sessionIdList([{ id: 's1' }, 's2', 's1', undefined]), ['s1', 's2'])
  assert.deepEqual(sessionIdList({}), [])
})
