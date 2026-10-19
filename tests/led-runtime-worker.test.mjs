// 灯运行时 worker 冒烟测试 —— 只验"线程能起来、协议能走、能正常退出"。
//
// 不接真串口：workerData.serial=false 时 worker 用测试桩（list 返回空、open 抛错），
// 于是它走"没有设备"这条真实路径：状态 = error / no-device，但线程本身健康。
// 场景里真正要防的是：worker 起不来、消息协议写错、shutdown 等 SAB 永远等不到。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'

import { createLedRuntimeBridge } from '../lib/led-runtime-bridge.js'

const workerUrl = new URL('../lib/led-runtime-worker.js', import.meta.url)
const WAIT_MS = 8000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function spawnWorker() {
  return new Worker(workerUrl, {
    workerData: { port: 'auto', baud: 115200, frameMs: 16, tag: 'smoke', serial: false },
    execArgv: [],
  })
}

/** 等一条满足条件的消息；超时/提前退出都失败（避免测试进程被挂死）。 */
function waitFor(worker, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`等待 ${label} 超时`)) }, WAIT_MS)
    const onMessage = (msg) => { if (predicate(msg)) { cleanup(); resolve(msg) } }
    const onError = (err) => { cleanup(); reject(err) }
    const onExit = (code) => { cleanup(); reject(new Error(`worker 提前退出 code=${code}（等 ${label}）`)) }
    function cleanup() {
      clearTimeout(timer)
      worker.removeListener('message', onMessage)
      worker.removeListener('error', onError)
      worker.removeListener('exit', onExit)
    }
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
  })
}

test('真实 worker：启动 → ready + status；无设备时 state=error / no-device', async () => {
  const worker = spawnWorker()
  try {
    const ready = await waitFor(worker, (msg) => msg.t === 'ready', 'ready')
    assert.equal(ready.tag, 'smoke')

    // 主线程允许驱动之后，运行时的 fanout 才会去发现/打开串口（功能关着时不碰设备）
    worker.postMessage({ t: 'drive', on: true })

    const status = await waitFor(
      worker,
      (msg) => msg.t === 'status' && msg.link && msg.link.state === 'error',
      'state=error 的状态',
    )
    assert.equal(status.link.errorCode, 'no-device', `期望 no-device，实际 ${status.link.errorCode} / ${status.link.lastError}`)
    assert.equal(status.link.verified, false)
    assert.equal(status.link.verifiedCount, 0)
    assert.equal(status.link.boards.length, 0)
    assert.equal(status.link.boardCount, 0)
    // 帧统计必须跨线程如实上报（这是"240fps 在 worker 里"的唯一证据）
    assert.equal(status.frames.frameMs, 16)
    assert.ok(Math.abs(status.frames.targetFps - 62.5) < 1e-6)
    assert.ok(status.frames.rendered >= 1, `worker 帧循环应当在跑：${JSON.stringify(status.frames)}`)
    assert.equal(status.fading, false)
    assert.equal(status.selfTest, false)

    // 主动查询也应当即时回一条 status（桥的缓存靠它刷新）
    worker.postMessage({ t: 'status', seq: 7 })
    const queried = await waitFor(worker, (msg) => msg.t === 'status' && msg.seq > status.seq, '主动查询的 status')
    assert.equal(queried.link.state, 'error')
  } finally {
    try { await worker.terminate() } catch (e) { /* ignore */ }
  }
})

test('真实 worker：close → closed；shutdown 写回 SAB 并正常退出（code=0）', async () => {
  const worker = spawnWorker()
  let exited = null
  worker.on('exit', (code) => { exited = code })
  try {
    await waitFor(worker, (msg) => msg.t === 'ready', 'ready')

    worker.postMessage({ t: 'close' })
    await waitFor(worker, (msg) => msg.t === 'closed', 'closed')
    const disabled = await waitFor(
      worker,
      (msg) => msg.t === 'status' && msg.link && msg.link.state === 'disabled',
      '关闭后的状态',
    )
    assert.equal(disabled.link.verified, false)

    // 退出路径：主线程同步等 SAB（最多 1200ms）；worker 写结果并 Atomics.notify
    const sync = new SharedArrayBuffer(4)
    const view = new Int32Array(sync)
    worker.postMessage({ t: 'shutdown', sync })
    const deadline = Date.now() + 5000
    while (Atomics.load(view, 0) === 0 && Date.now() < deadline) {
      Atomics.wait(view, 0, 0, 50)
    }
    assert.equal(Atomics.load(view, 0), 1, 'shutdown 应当把结果（1=成功）写回 SAB')

    // worker 必须自己退（不能把线程/进程钉住）
    const exitDeadline = Date.now() + 5000
    while (exited === null && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(exited, 0, `worker 应当以 code=0 退出，实际 ${exited}`)
  } finally {
    try { await worker.terminate() } catch (e) { /* ignore */ }
  }
})

test('桥接（真实 worker）：主线程只读缓存；worker 无设备 → 状态 error/no-device；stop() 安全', async () => {
  const runtime = createLedRuntimeBridge({
    port: 'auto',
    baud: 115200,
    frameMs: 16,
    open: async () => { throw new Error('桥接测试不该走 inline') },
    list: async () => [],
    log: () => {},
    // 让 worker 不碰真串口（同一个冒烟桩）：本用例只验"主↔worker 的协议接线"
    workerData: { serial: false },
  })
  try {
    runtime.start()
    runtime.setDriving(true)          // 触发 spawn
    runtime.applyScene({ state: 'running', flags: 0, brightness: 160, latched: false, reason: 'bridge-smoke' })

    // 主线程的 status() 是缓存：等 worker 把 error/no-device 报上来
    let status = runtime.status()
    const deadline = Date.now() + WAIT_MS
    while (Date.now() < deadline) {
      status = runtime.status()
      if (status.link.errorCode === 'no-device' && status.link.state === 'error') break
      await sleep(50)
    }
    assert.equal(status.link.state, 'error', `worker 无设备时状态应当上浮：${JSON.stringify(status.link)}`)
    assert.equal(status.link.errorCode, 'no-device')
    assert.equal(status.link.verified, false)
    // 帧统计必须是 worker 线程报上来的（frameMs 来自 workerData）
    assert.equal(status.frames.frameMs, 16)
    assert.ok(status.frames.rendered >= 1, `worker 帧循环应当在跑：${JSON.stringify(status.frames)}`)

    // 主线程侧额外的动作都不能抛（桥必须兜住 worker 的一切异常）
    assert.doesNotThrow(() => runtime.tick())
    assert.doesNotThrow(() => runtime.flush())
  } finally {
    assert.doesNotThrow(() => runtime.stop())   // 退出路径：同步等 SAB ≤1200ms
  }
})
