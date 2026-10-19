// Toast 发送桥：worker 就绪/失败回退/单条失败补发/协议同步。
//
// 真机行为由 verify 脚本覆盖；这里用假 worker 锁住**决策与回退策略**：
// 任何异常都不能让通知静默丢失（要么 worker 发出，要么 inline 补发）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToastSender } from '../lib/toast-bridge.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function fakeWorker(options = {}) {
  const handlers = new Map()
  const sent = []
  let toastCount = 0
  const worker = {
    sent,
    terminated: false,
    postMessage(msg) {
      sent.push(msg)
      if (msg.t === 'probe' && options.noProbeReply !== true) {
        setImmediate(() => handlers.get('message')?.({
          t: 'probe-reply', id: msg.id, ok: options.probeOk !== false, message: 'probe failed',
        }))
      }
      if (msg.t === 'toast') {
        toastCount += 1
        const fail = options.failToast === true || (options.failToast === 'once' && toastCount === 1)
        if (fail) {
          setImmediate(() => handlers.get('message')?.({ t: 'error', id: msg.id, message: 'Show failed' }))
        } else {
          setImmediate(() => handlers.get('message')?.({ t: 'sent', id: msg.id }))
        }
      }
    },
    on(event, cb) { handlers.set(event, cb) },
    terminate() { worker.terminated = true },
    unref() {},
    emit(event, arg) { handlers.get(event)?.(arg) },
  }
  return worker
}

test('probe 成功 → worker 发送，不走 inline', async () => {
  const w = fakeWorker()
  const inline = []
  const sender = createToastSender({ inlineSend: (item) => inline.push(item), createWorker: () => w, probeTimeoutMs: 100 })
  try {
    assert.equal(await sender.ready(), 'worker')
    assert.equal(sender.mode, 'worker')
    sender.send({ title: 'A' })
    await flush(); await flush()
    assert.equal(w.sent.filter((m) => m.t === 'toast').length, 1)
    assert.equal(inline.length, 0)

    sender.syncClickProtocol(true)
    assert.ok(w.sent.some((m) => m.t === 'clickProtocol' && m.ready === true), '协议状态要同步给 worker')
  } finally {
    sender.close()
  }
  assert.equal(w.terminated, true)
})

test('probe 失败 → 回退 inline，probe 期间排队的通知用 inline 补发', async () => {
  const w = fakeWorker({ probeOk: false })
  const inline = []
  const sender = createToastSender({ inlineSend: (item) => inline.push(item), createWorker: () => w, probeTimeoutMs: 100 })
  sender.send({ title: 'queued' })              // 还在 probe：先排队
  assert.equal(await sender.ready(), 'inline')
  await flush()
  assert.equal(sender.mode, 'inline')
  assert.deepEqual(inline, [{ title: 'queued' }])
  sender.send({ title: 'later' })                // 之后也走 inline
  assert.deepEqual(inline, [{ title: 'queued' }, { title: 'later' }])
  sender.close()
})

test('worker 在 probe 前退出 → 回退 inline（排队/已发未回执都补发）', async () => {
  const w = fakeWorker({ noProbeReply: true })
  const inline = []
  const sender = createToastSender({ inlineSend: (item) => inline.push(item), createWorker: () => w, probeTimeoutMs: 500 })
  sender.send({ title: 'queued' })
  w.emit('exit', 1)
  assert.equal(await sender.ready(), 'inline')
  assert.deepEqual(inline, [{ title: 'queued' }])
  sender.close()
})

test('单条发送失败 → 该条 inline 补发一次，worker 继续可用', async () => {
  const w = fakeWorker({ failToast: 'once' })
  const inline = []
  const sender = createToastSender({ inlineSend: (item) => inline.push(item), createWorker: () => w, probeTimeoutMs: 100 })
  try {
    await sender.ready()
    sender.send({ title: 'A' })
    await flush(); await flush()
    assert.deepEqual(inline, [{ title: 'A' }])
    assert.equal(sender.mode, 'worker', '单条失败不能整体降级')
    sender.send({ title: 'B' })
    await flush(); await flush()
    assert.equal(w.sent.filter((m) => m.t === 'toast').length, 2)
    assert.deepEqual(inline, [{ title: 'A' }], 'B 不再重复补发')
  } finally {
    sender.close()
  }
})

test('probe 超时 → 回退 inline', async () => {
  const w = fakeWorker({ noProbeReply: true })
  const inline = []
  const sender = createToastSender({ inlineSend: (item) => inline.push(item), createWorker: () => w, probeTimeoutMs: 20 })
  assert.equal(await sender.ready(), 'inline')
  assert.equal(sender.mode, 'inline')
  sender.close()
})
