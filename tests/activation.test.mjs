// 页面注册表 + 激活决策单测（src/pages.ts / src/activation.ts → lib/*.js）
//   npm test（会先跑 npm run build）
//
// 这两块合起来就是"三态点击"的可证明部分：
//   目标为空 → ignore；有目标 + 有可投递页面 → deliver；有目标 + 无页面 → open-app；
//   外部地址 → open-url。
// 另外锁住"当前聚焦"与"最后用过"的分工、失焦清除、seq 乱序保护、连接计数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PageRegistry, pickDeliveryPage } from '../lib/pages.js'
import { planActivation, planOpensWindow } from '../lib/activation.js'
import { clickNone, clickSession, clickUrl, clickPage } from '../lib/protocol.js'

const T = 1_000_000

function withPages() {
  const registry = new PageRegistry()
  registry.attachStream('pA', T)
  registry.attachStream('pB', T)
  return registry
}

test('选页：优先当前聚焦，其次最后用过，都没有则 undefined', () => {
  const registry = withPages()
  assert.equal(pickDeliveryPage(registry, T), undefined, '没人上报过 → 没有可投递页面')
  registry.report({ pageId: 'pA', seq: 1, focused: true, sessionId: 's1' }, T)
  assert.equal(pickDeliveryPage(registry, T)?.pageId, 'pA')
  registry.report({ pageId: 'pB', seq: 1, focused: true, sessionId: 's2' }, T + 10)
  registry.report({ pageId: 'pA', seq: 2, focused: false, sessionId: 's1' }, T + 20)
  assert.equal(pickDeliveryPage(registry, T + 20)?.pageId, 'pB', '此刻聚焦的是 B')
  // B 也失焦（用户切去别的应用）：当前没有聚焦页面，但仍应投给"最后用过的" B
  registry.report({ pageId: 'pB', seq: 2, focused: false, sessionId: 's2' }, T + 30)
  assert.equal(registry.focusedLive(T + 40), undefined, '都失焦后没有"当前聚焦"页面')
  assert.equal(pickDeliveryPage(registry, T + 40)?.pageId, 'pB', '但仍投给最后用过的页面')
})

test('seq 乱序保护：同页面旧序号一律 stale，不覆盖新状态', () => {
  const registry = withPages()
  assert.equal(registry.report({ pageId: 'pA', seq: 10, focused: true, sessionId: 's1' }, T), 'accepted')
  assert.equal(registry.report({ pageId: 'pA', seq: 9, focused: false, sessionId: 's1' }, T + 1), 'stale')
  assert.equal(registry.get('pA')?.focused, true, '旧序号不能把聚焦状态抹掉')
  assert.equal(registry.report({ pageId: 'pA', seq: 11, focused: false, sessionId: 's1' }, T + 2), 'accepted')
  // 旧客户端不带 seq：跳过乱序保护而不是拒收
  assert.equal(registry.report({ pageId: 'pA', focused: true, sessionId: 's1' }, T + 3), 'accepted')
})

test('连接计数：刷新时"新连接建立/旧连接关闭"任意先后都不会误判离线', () => {
  const registry = new PageRegistry()
  registry.attachStream('p1', T)
  registry.attachStream('p1', T + 1)      // 刷新：新连接先到
  registry.detachStream('p1', T + 2)      // 旧连接随后关闭
  assert.equal(registry.get('p1')?.streams, 1, '页面仍然在线（不能被布尔标志覆盖）')
  registry.detachStream('p1', T + 3)
  assert.equal(registry.get('p1')?.streams, 0)
})

test('存在性 ≠ 可投递性：没有连接就不算可投递（但 recentPage 仍能看到它）', () => {
  const registry = new PageRegistry()
  registry.report({ pageId: 'p1', seq: 1, focused: true, sessionId: 's1' }, T)
  assert.equal(pickDeliveryPage(registry, T), undefined, '没有 SSE 连接 → 不能投递')
  assert.equal(registry.recentPage(T)?.pageId, 'p1', '但它确实存在（仅用于诊断）')
})

test('长时间无上报的离线页面会被清理，"最后用过"随之失效', () => {
  const registry = new PageRegistry({ idleTtlMs: 1000 })
  registry.attachStream('p1', T)
  registry.report({ pageId: 'p1', seq: 1, focused: true, sessionId: 's1' }, T)
  registry.detachStream('p1', T)
  registry.prune(T + 2000)
  assert.equal(registry.size, 0)
  assert.equal(pickDeliveryPage(registry, T + 2000), undefined)
})

test('激活决策：三态互斥且可证明', () => {
  const registry = withPages()
  const ctx = { registry, now: T, appUrl: (t) => `http://app/#dsh-notify=${encodeURIComponent('session:' + (t.sessionId ?? ''))}` }
  // ① 目标为空 → ignore，不开任何窗口
  assert.deepEqual(planActivation(clickNone(), ctx), { action: 'ignore', reason: 'no-target' })
  // ③ 有目标但没有可投递页面 → open-app（新开 DSH）
  const openApp = planActivation(clickSession('s1'), ctx)
  assert.equal(openApp.action, 'open-app')
  assert.match(String(openApp.url), /#dsh-notify=session%3As1$/)
  assert.equal(planOpensWindow(openApp), true)
  // ② 有目标 + 有聚焦页面 → deliver（**不开窗口**）
  registry.report({ pageId: 'pA', seq: 1, focused: true, sessionId: 's1' }, T)
  const deliver = planActivation(clickSession('s1'), ctx)
  assert.equal(deliver.action, 'deliver')
  assert.equal(deliver.pageId, 'pA')
  assert.equal(planOpensWindow(deliver), false, 'deliver 绝不产生窗口')
  // ④ 外部地址：永远交给系统，和 DSH 页面无关
  assert.deepEqual(planActivation(clickUrl('https://example.com/x'), ctx), { action: 'open-url', url: 'https://example.com/x' })
  // page 目标同样遵循三态
  assert.equal(planActivation(clickPage('plugins'), ctx).action, 'deliver')
})
