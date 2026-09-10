// 对外推送 API 单测（node:test，无第三方依赖）
//   npm test
//
// 锁住的核心语义：
//   · push 走聚焦门控（把会话归属交给门控），pushAlways 绕过门控直接入队
//   · 标题为空视为无效载荷：不推送、返回 false（不产生空通知）
//   · 载荷归一：长度截断、urgency 白名单、sessionId 归一为字符串数组
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifyApi, normalizeNotifyItem } from '../lib/api.js'

function harness() {
  const pushed = []
  const queued = []
  const api = createNotifyApi({
    notify: (title, message, urgency, sessionIds) => { pushed.push({ title, message, urgency, sessionIds }) },
    enqueue: (item) => { queued.push(item) },
  })
  return { api, pushed, queued }
}

test('push 走门控路径并把会话归属交给门控', () => {
  const { api, pushed, queued } = harness()
  assert.equal(api.push({ title: '构建完成', message: '全部通过', sessionId: 's1' }), true)
  assert.deepEqual(pushed, [{ title: '构建完成', message: '全部通过', urgency: 'normal', sessionIds: ['s1'] }])
  assert.deepEqual(queued, [])
})

test('pushAlways 绕过门控直接入队', () => {
  const { api, pushed, queued } = harness()
  assert.equal(api.pushAlways({ title: '磁盘告急', message: '剩余 1GB' }), true)
  assert.deepEqual(queued, [{ title: '磁盘告急', message: '剩余 1GB', urgency: 'normal' }])
  assert.deepEqual(pushed, [])
})

test('标题为空或缺失时不推送', () => {
  const { api, pushed, queued } = harness()
  assert.equal(api.push({ message: '没有标题' }), false)
  assert.equal(api.push({ title: '   ' }), false)
  assert.equal(api.push(undefined), false)
  assert.equal(api.pushAlways(null), false)
  assert.deepEqual(pushed, [])
  assert.deepEqual(queued, [])
})

test('归一：空白压缩、超长截断、urgency 白名单', () => {
  const it = normalizeNotifyItem({
    title: '  多   空格  标题  ',
    message: 'x'.repeat(500),
    urgency: 'critical',
  })
  assert.equal(it.title, '多 空格 标题')
  assert.equal(it.message.length, 400)
  assert.equal(it.urgency, 'critical')
  assert.deepEqual(normalizeNotifyItem({ title: 't', urgency: 'urgent' }).urgency, 'normal')
})

test('归一：sessionId 接受字符串、会话对象与数组', () => {
  assert.deepEqual(normalizeNotifyItem({ title: 't', sessionId: 's1' }).sessionIds, ['s1'])
  assert.deepEqual(normalizeNotifyItem({ title: 't', sessionId: { id: 's2' } }).sessionIds, ['s2'])
  assert.deepEqual(normalizeNotifyItem({ title: 't', sessionId: ['s1', { id: 's2' }, 's1'] }).sessionIds, ['s1', 's2'])
  assert.deepEqual(normalizeNotifyItem({ title: 't' }).sessionIds, [])
})

test('缺省 message 归一为空串而不是 undefined', () => {
  const { api, queued } = harness()
  api.pushAlways({ title: '只有标题' })
  assert.deepEqual(queued, [{ title: '只有标题', message: '', urgency: 'normal' }])
})
