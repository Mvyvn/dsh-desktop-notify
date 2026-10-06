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
import { createLedApi } from '../lib/led-api.js'

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
    { ok: true, queued: true, silenced: false, reason: '', apiVersion: '1.1.0-led.1', unsupportedVersion: false })

  const silenced = harness({ queued: false, silenced: true, reason: 'silenced' })
  assert.deepEqual(silenced.api.notify({ title: '静默', sessionId: 's1' }),
    { ok: true, queued: false, silenced: true, reason: 'silenced', apiVersion: '1.1.0-led.1', unsupportedVersion: false })

  const dup = harness({ queued: false, silenced: false, reason: 'duplicate' })
  assert.deepEqual(dup.api.notify({ title: '重复' }),
    { ok: true, queued: false, silenced: false, reason: 'duplicate', apiVersion: '1.1.0-led.1', unsupportedVersion: false })
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

test('对外 API v1.1.0-led.1：可探测版本与能力，未知字段忽略，更高主版本只回带标记', async () => {
  const api = createNotifyApi({ notify: () => ({ queued: true }), enqueue: () => true })
  assert.equal(api.apiVersion, '1.1.0-led.1')
  assert.ok(api.capabilities.includes('click.session'))
  assert.ok(api.capabilities.includes('click.url'))
  // 主版本仍是 1：老调用方的"更高主版本"降级判定不受本分支影响
  assert.equal(api.notify({ title: 'x', v: '9.0.0' }).unsupportedVersion, true)
  assert.equal(api.notify({ title: 'x', v: '9.0.0' }).apiVersion, '9.0.0')
  assert.equal(api.notify({ title: 'x', 未来字段: 1 }).ok, true, '未知字段一律忽略')
})

test('LED 控制面：没接灯带时 led 为 null（调用方必须判空）', () => {
  const api = createNotifyApi({ notify: () => ({ queued: true }), enqueue: () => true })
  assert.equal(api.led, null)
  assert.ok(api.capabilities.includes('led.serial'))
  assert.ok(api.capabilities.includes('led.scene'))
})

test('LED 控制面：语义帧/效果/亮度/进度/确认都能下发，非法载荷如实拒绝', () => {
  const frames = []
  const acked = []
  const previews = []
  const port = {
    enabled: () => true,
    sendFrame: (type, payload) => { frames.push({ type, payload }); return true },
    acknowledge: () => acked.push(1),
    preview: (state, brightness) => { previews.push({ state, brightness }); return true },
    status: () => ({ ok: true }),
  }
  const api = createNotifyApi({ notify: () => ({ queued: true }), enqueue: () => true, led: () => createLedApi(port) })
  const led = api.led
  assert.ok(led)
  assert.equal(led.protocolVersion, '1.0.0-led.1')
  assert.equal(led.wireVersion, 1)

  assert.equal(led.scene({ state: 'done' }).queued, true)
  assert.equal(frames[0].type, 0x02)
  assert.equal(frames[0].payload[0], 0x03)          // done 的线码
  assert.equal(led.effect({ effect: 'flow-both', speed: 9 }).ok, true)
  assert.equal(frames[1].type, 0x03)
  assert.equal(led.overlay({ effect: 'double-flash', ttlMs: 1500 }).ok, true)
  assert.equal(led.brightness(120).ok, true)
  assert.equal(led.progress(42).ok, true)
  assert.equal(led.clear().ok, true)
  assert.equal(led.acknowledge().ok, true)
  assert.equal(acked.length, 1)
  assert.equal(led.preview('waiting', 90).ok, true)
  assert.deepEqual(previews, [{ state: 'waiting', brightness: 90 }])

  // 非法载荷：拒绝但**不写串口**
  const before = frames.length
  assert.equal(led.scene({ state: 'nope' }).reason, 'invalid-payload')
  assert.equal(led.scene(null).ok, false)
  assert.equal(led.effect({ effect: '不存在' }).ok, false)
  assert.equal(led.brightness('abc').ok, false)
  assert.equal(led.progress(NaN).ok, false)
  assert.equal(led.frame({ type: 0x82, payload: [] }).reason, 'unsupported-frame')
  assert.equal(frames.length, before, '被拒绝的请求一个字节都不该写出去')
})

test('LED 控制面：灯带没启用时请求合法但不入队（reason=led-disabled）', () => {
  const port = {
    enabled: () => false,
    sendFrame: () => { throw new Error('不该被调用') },
    acknowledge: () => {},
    preview: () => false,
    status: () => ({}),
  }
  const led = createLedApi(port)
  const outcome = led.scene({ state: 'running' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.queued, false)
  assert.equal(outcome.reason, 'led-disabled')
})

test('LED 控制面：链路没连上时如实回 link-down（不假装成功）', () => {
  const port = {
    enabled: () => true,
    sendFrame: () => false,
    acknowledge: () => {},
    preview: () => false,
    status: () => ({}),
  }
  const led = createLedApi(port)
  assert.equal(led.scene({ state: 'error' }).reason, 'link-down')
})

test('LED 控制面：原始帧走白名单，且载荷先过一遍编码校验', () => {
  const frames = []
  const led = createLedApi({
    enabled: () => true,
    sendFrame: (type, payload) => { frames.push({ type, payload }); return true },
    acknowledge: () => {},
    preview: () => true,
    status: () => ({}),
  })
  assert.equal(led.frame({ type: 0x08, payload: [] }).ok, true)
  assert.equal(frames[0].type, 0x08)
  assert.equal(led.frame({ type: 'x' }).ok, false)
  assert.equal(led.frame({ type: 0x01, payload: new Array(40).fill(0) }).ok, false, '超长载荷在 API 层就被挡住')
})
