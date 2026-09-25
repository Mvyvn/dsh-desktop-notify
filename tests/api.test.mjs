// 对外推送 API 单测（node:test，无第三方依赖）
//   npm test
//
// 锁住的核心语义：
//   · push 走聚焦门控，**如实返回是否真的入队**（被静默/去重/无后端都是 false）
//   · pushAlways 绕过门控直接入队
//   · notify 返回结构化结果，便于调用方区分 invalid / silenced / duplicate / dropped
//   · 标题为空视为无效载荷：不推送、返回 false（不产生空通知）
//   · 载荷归一：长度截断、urgency 白名单、sessionId 归一为字符串数组
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifyApi, normalizeNotifyItem } from '../lib/api.js'

function harness(result = { queued: true, silenced: false, reason: '' }, options = {}) {
  const pushed = []
  const queued = []
  const api = createNotifyApi({
    notify: (title, message, urgency, sessionIds, opts) => {
      pushed.push({ title, message, urgency, sessionIds, options: opts })
      return result
    },
    enqueue: (item) => { queued.push(item); return true },
    link: options.link,
  })
  return { api, pushed, queued }
}

test('push 走门控路径并把会话归属交给门控', () => {
  const { api, pushed, queued } = harness()
  assert.equal(api.push({ title: '构建完成', message: '全部通过', sessionId: 's1' }), true)
  assert.deepEqual(pushed, [{ title: '构建完成', message: '全部通过', urgency: 'normal', sessionIds: ['s1'], options: { url: '' } }])
  assert.deepEqual(queued, [])
})

test('点击跳转：显式 url 优先，其次用宿主给的会话链接', () => {
  const { api, pushed } = harness({ queued: true }, {
    link: (ids) => (ids.length > 0 ? `http://127.0.0.1:3080/#dsh-notify=session%3A${ids[0]}` : ''),
  })
  api.push({ title: '显式链接', url: 'http://127.0.0.1:3080/#dsh-notify=page%3Aplugins' })
  api.push({ title: '按会话自动生成', sessionId: 's9' })
  api.push({ title: '什么都没有' })
  assert.equal(pushed[0].options.url, 'http://127.0.0.1:3080/#dsh-notify=page%3Aplugins')
  assert.equal(pushed[1].options.url, 'http://127.0.0.1:3080/#dsh-notify=session%3As9')
  assert.equal(pushed[2].options.url, '')
})

test('pushAlways 也带点击链接（会话链接 / 显式 url）', () => {
  const { api, queued } = harness({ queued: true }, { link: (ids) => (ids.length ? 'http://x/#dsh-notify=session%3A' + ids[0] : '') })
  api.pushAlways({ title: '强制', sessionId: 's1' })
  api.pushAlways({ title: '强制带链接', url: 'https://example.com/a' })
  api.pushAlways({ title: '不可点击' })
  assert.deepEqual(queued.map((q) => q.url ?? null), [
    'http://x/#dsh-notify=session%3As1',
    'https://example.com/a',
    null,
  ])
})

test('归一：url 只接受 http/https，其它协议丢弃', () => {
  assert.equal(normalizeNotifyItem({ title: 't', url: 'https://example.com' }).url, 'https://example.com')
  assert.equal(normalizeNotifyItem({ title: 't', url: '  http://127.0.0.1:3080/x  ' }).url, 'http://127.0.0.1:3080/x')
  assert.equal(normalizeNotifyItem({ title: 't', url: 'file:///C:/x' }).url, '')
  assert.equal(normalizeNotifyItem({ title: 't', url: 'javascript:alert(1)' }).url, '')
  assert.equal(normalizeNotifyItem({ title: 't' }).url, '')
})

test('push 被门控静默时返回 false（旧实现会误报 true）', () => {
  const { api, pushed } = harness({ queued: false, silenced: true, reason: 'silenced' })
  assert.equal(api.push({ title: '静默的', sessionId: 's1' }), false)
  assert.equal(pushed.length, 1, '仍然走过门控判定，只是没入队')
})

test('pushAlways 绕过门控直接入队', () => {
  const { api, pushed, queued } = harness()
  assert.equal(api.pushAlways({ title: '磁盘告急', message: '剩余 1GB' }), true)
  assert.deepEqual(queued, [{ title: '磁盘告急', message: '剩余 1GB', urgency: 'normal' }])
  assert.deepEqual(pushed, [])
})

test('notify 返回结构化结果：入队/静默/无效载荷', () => {
  const ok = harness()
  assert.deepEqual(ok.api.notify({ title: '正常', sessionId: 's1' }),
    { ok: true, queued: true, silenced: false, reason: '' })

  const silenced = harness({ queued: false, silenced: true, reason: 'silenced' })
  assert.deepEqual(silenced.api.notify({ title: '静默', sessionId: 's1' }),
    { ok: true, queued: false, silenced: true, reason: 'silenced' })

  const dup = harness({ queued: false, silenced: false, reason: 'duplicate' })
  assert.deepEqual(dup.api.notify({ title: '重复' }),
    { ok: true, queued: false, silenced: false, reason: 'duplicate' })
})

test('标题为空或缺失时不推送', () => {
  const { api, pushed, queued } = harness()
  assert.equal(api.push({ message: '没有标题' }), false)
  assert.equal(api.push({ title: '   ' }), false)
  assert.equal(api.push(undefined), false)
  assert.equal(api.pushAlways(null), false)
  assert.equal(api.notify({}).ok, false)
  assert.equal(api.notify({}).reason, 'invalid-payload')
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
