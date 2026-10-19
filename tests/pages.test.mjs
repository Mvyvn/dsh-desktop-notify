// 页面注册表：硬上限与"在线页面绝不被误删"的边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PageRegistry } from '../lib/pages.js'

const report = (pageId, focused = false) => ({ pageId, focused })

test('PageRegistry：超过 maxPages 时淘汰"没连接且最久没上报"的页面', () => {
  const reg = new PageRegistry({ maxPages: 2, idleTtlMs: 60_000 })
  let now = 1000
  reg.report(report('p1'), now)
  now += 10
  reg.report(report('p2'), now)
  now += 10
  reg.report(report('p3'), now)
  assert.equal(reg.size, 2)
  assert.equal(reg.get('p1'), undefined, '最久没上报的 p1 被淘汰')
  assert.ok(reg.get('p2'))
  assert.ok(reg.get('p3'))
})

test('PageRegistry：有活跃 SSE 的页面不被上限误删（宁可暂时超限）', () => {
  const reg = new PageRegistry({ maxPages: 1, idleTtlMs: 60_000 })
  reg.attachStream('a', 1000)          // 有连接
  reg.report(report('b'), 1001)        // 触发上限
  assert.ok(reg.get('a'), '在线页面不能因上限被删')
  assert.equal(reg.size, 2, '只剩在线页面时允许暂时超限')
})

test('PageRegistry：被淘汰的页面若是 lastFocused，相应地清掉', () => {
  const reg = new PageRegistry({ maxPages: 1, idleTtlMs: 60_000 })
  reg.report(report('focused', true), 1000)
  reg.report(report('other'), 1001)
  assert.equal(reg.lastFocusedLive(1002), undefined, '被淘汰的焦点页面不能再被选中')
})
