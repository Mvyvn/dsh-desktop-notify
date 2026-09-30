// 对外推送 API 单测（node:test，无第三方依赖）
//   npm test
//
// 锁住的核心语义：
//   · push 走聚焦门控，**如实返回是否真的入队**（被静默/去重/无后端都是 false）
//   · pushAlways 绕过门控直接入队
//   · notify 返回结构化结果，便于调用方区分 invalid / silenced / duplicate / dropped
//   · 标题为空视为无效载荷：不推送、返回 false（不产生空通知）
//   · 载荷归一：长度截断、urgency 白名单、sessionId 归一为字符串数组
//   · **点击目标是显式的**：sessionId 只管门控；不传 click 就是不可点击（点了不跳转）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifyApi, normalizeNotifyItem } from '../lib/api.js'

function harness(result = { queued: true, silenced: false, reason: '' }) {
  const pushed = []
  const queued = []
  const api = createNotifyApi({
    notify: (title, message, urgency, sessionIds, opts) => {
      pushed.push({ title, message, urgency, sessionIds, options: opts })
      return result
    },
    enqueue: (item) => { queued.push(item); return true },
  })
  return { api, pushed, queued }
}

test('push 走门控路径并把会话归属交给门控', () => {
  const { api, pushed, queued } = harness()
  assert.equal(api.push({ title: '构建完成', message: '全部通过', sessionId: 's1' }), true)
  assert.deepEqual(pushed, [{
    title: '构建完成', message: '全部通过', urgency: 'normal', sessionIds: ['s1'],
    options: { click: { type: 'none' } },
  }])
  assert.deepEqual(queued, [])
})

test('点击目标：显式 click 生效；只有 sessionId 时**不可点击**', () => {
  const { api, pushed } = harness()
  api.push({ title: '显式会话', click: { type: 'session', sessionId: 's9' } })
  api.push({ title: '只有会话归属', sessionId: 's9' })
  api.push({ title: '什么都没有' })
  api.push({ title: '旧字段 url', url: 'https://example.com/x' })
  assert.deepEqual(pushed[0].options.click, { type: 'session', sessionId: 's9' })
  assert.deepEqual(pushed[1].options.click, { type: 'none' }, 'sessionId 不再隐式生成跳转链接')
  assert.deepEqual(pushed[2].options.click, { type: 'none' })
  assert.deepEqual(pushed[3].options.click, { type: 'url', url: 'https://example.com/x' }, '旧 url 字段仍然兼容')
})

test('click 的非法形状一律归一为 none（不猜测意图）', () => {
  const { api, pushed } = harness()
  api.push({ title: 'a', click: { type: 'session' } })                 // 缺 sessionId
  api.push({ title: 'b', click: { type: 'page', page: 'not-a-page' } }) // 不在白名单
  api.push({ title: 'c', click: { type: 'url', url: 'file:///C:/x' } }) // 非 http(s)
  api.push({ title: 'd', click: null })
  api.push({ title: 'e', click: 'session:s1' })                         // 字符串不是合法形状
  assert.deepEqual(pushed.map((p) => p.options.click), [
    { type: 'none' }, { type: 'none' }, { type: 'none' }, { type: 'none' }, { type: 'none' },
  ])
})

test('pushAlways 也带点击目标（显式 click / 旧 url / 无）', () => {
  const { api, queued } = harness()
  api.pushAlways({ title: '强制', click: { type: 'session', sessionId: 's1' } })
  api.pushAlways({ title: '强制带链接', url: 'https://example.com/a' })
  api.pushAlways({ title: '不可点击' })
  assert.deepEqual(queued.map((q) => q.click.type), ['session', 'url', 'none'])
  assert.equal(queued[1].click.url, 'https://example.com/a')
})

test('归一：url 字段只接受 http/https，其它协议丢弃', () => {
  const clickOf = (item) => normalizeNotifyItem(item).click
  assert.deepEqual(clickOf({ title: 't', url: 'https://example.com' }), { type: 'url', url: 'https://example.com' })
  assert.deepEqual(clickOf({ title: 't', url: '  http://127.0.0.1:3080/x  ' }), { type: 'url', url: 'http://127.0.0.1:3080/x' })
  assert.deepEqual(clickOf({ title: 't', url: 'file:///C:/x' }), { type: 'none' })
  assert.deepEqual(clickOf({ title: 't', url: 'javascript:alert(1)' }), { type: 'none' })
  assert.deepEqual(clickOf({ title: 't' }), { type: 'none' })
})

test('push 被门控静默时返回 false（旧实现会误报 true）', () => {
  const { api, pushed } = harness({ queued: false, silenced: true, reason: 'silenced' })
  assert.equal(api.push({ title: '静默的', sessionId: 's1' }), false)
  assert.equal(pushed.length, 1, '仍然走过门控判定，只是没入队')
})

test('pushAlways 绕过门控直接入队', () => {
  const { api, pushed, queued } = harness()
  assert.equal(api.pushAlways({ title: '磁盘告急', message: '剩余 1GB' }), true)
  assert.deepEqual(queued, [{ title: '磁盘告急', message: '剩余 1GB', urgency: 'normal', click: { type: 'none' } }])
  assert.deepEqual(pushed, [])
})

test('notify 返回结构化结果：入队/静默/无效载荷', () => {
  const ok = harness()
  assert.deepEqual(ok.api.notify({ title: '正常', sessionId: 's1' }),
    { ok: true, queued: true, silenced: false, reason: '', apiVersion: '1.0.0', unsupportedVersion: false })

  const silenced = harness({ queued: false, silenced: true, reason: 'silenced' })
  assert.deepEqual(silenced.api.notify({ title: '静默', sessionId: 's1' }),
    { ok: true, queued: false, silenced: true, reason: 'silenced', apiVersion: '1.0.0', unsupportedVersion: false })

  const dup = harness({ queued: false, silenced: false, reason: 'duplicate' })
  assert.deepEqual(dup.api.notify({ title: '重复' }),
    { ok: true, queued: false, silenced: false, reason: 'duplicate', apiVersion: '1.0.0', unsupportedVersion: false })
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
  assert.deepEqual(queued, [{ title: '只有标题', message: '', urgency: 'normal', click: { type: 'none' } }])
})

test('对外 API 基线协议 v1.0.0：可探测版本与能力，未知字段忽略，更高主版本只回带标记', async () => {
  const api = createNotifyApi({ notify: () => ({ queued: true }), enqueue: () => true })
  assert.equal(api.apiVersion, '1.0.0')
  assert.ok(api.capabilities.includes('click.session'))
  assert.ok(api.capabilities.includes('click.url'))
  assert.equal(api.notify({ title: 'x', v: '9.0.0' }).unsupportedVersion, true)
  assert.equal(api.notify({ title: 'x', v: '9.0.0' }).apiVersion, '9.0.0')
  assert.equal(api.notify({ title: 'x', 未来字段: 1 }).ok, true, '未知字段一律忽略')
})
