// 有界容器与去重单测（node:test，无第三方依赖）
//   npm test
//
// 常驻宿主的内存边界就靠这两个容器：条数上限必须真的生效（淘汰最旧），
// 去重窗口必须真的拦住重复文案、放行窗口外的再次触发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoundedMap, createDeduper } from '../lib/state.js'

test('有界映射：超过上限丢最旧的，size 不再增长', () => {
  const map = createBoundedMap(3)
  for (const k of ['a', 'b', 'c', 'd', 'e']) map.set(k, k)
  assert.equal(map.size, 3)
  assert.equal(map.has('a'), false)
  assert.equal(map.has('b'), false)
  assert.deepEqual([...map.keys()], ['c', 'd', 'e'])
  assert.equal(map.get('e'), 'e')
})

test('有界映射：重复写同一个 key 不占新位置，且刷新其为最新', () => {
  const map = createBoundedMap(3)
  map.set('a', 1)
  map.set('b', 2)
  map.set('c', 3)
  map.set('a', 11)      // 刷新 a → 最新
  map.set('d', 4)       // 淘汰最旧的 b
  assert.equal(map.size, 3)
  assert.equal(map.get('a'), 11)
  assert.equal(map.has('b'), false)
  assert.equal(map.has('d'), true)
})

test('有界映射：淘汰回调拿到的是被淘汰项的值（不是 undefined）', () => {
  const evicted = []
  const map = createBoundedMap(2, (key, value) => evicted.push([key, value]))
  map.set('a', 1)
  map.set('b', 2)
  map.set('c', 3)
  assert.deepEqual(evicted, [['a', 1]])
})

test('有界映射：非法上限退化为 1，delete/clear 可用', () => {
  const map = createBoundedMap(0)
  map.set('a', 1)
  map.set('b', 2)
  assert.equal(map.size, 1)
  assert.equal(map.has('b'), true)
  map.delete('b')
  assert.equal(map.size, 0)
  map.set('c', 3)
  map.clear()
  assert.equal(map.size, 0)
})

test('去重器：窗口内只放行一次，窗口外再次放行', () => {
  const shouldSend = createDeduper(1000)
  assert.equal(shouldSend('k', 0), true)
  assert.equal(shouldSend('k', 999), false)
  assert.equal(shouldSend('k', 1000), true, '窗口边界放行')
  assert.equal(shouldSend('other', 1000), true, '不同 key 互不影响')
})

test('去重器：窗口为 0 时一律放行（可关闭去重）', () => {
  const shouldSend = createDeduper(0)
  assert.equal(shouldSend('k', 0), true)
  assert.equal(shouldSend('k', 0), true)
})

test('去重器：记忆条数有上限，不会无限增长', () => {
  const shouldSend = createDeduper(1000, 2)
  assert.equal(shouldSend('a', 0), true)
  assert.equal(shouldSend('b', 0), true)
  assert.equal(shouldSend('c', 0), true)   // 淘汰 a 的记忆
  assert.equal(shouldSend('a', 1), true, 'a 的记忆已被淘汰 → 再次放行')
  assert.equal(shouldSend('c', 2), false)
})
