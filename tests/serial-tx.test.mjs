// 发送队列语义（两个平台共用）：有界 / 最新帧优先 / 控制帧必达 / 短写不截断
//
// 这组测试对应一个真实缺陷：POSIX 侧的同步写会**绕过队列插队**，而它的 close 又会把
// 残旧帧的余量追发上去 —— 熄灯帧可能不是最后一帧。现在两个平台共用 serial-tx.ts，
// 语义用单测钉死。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTxQueue, DEFAULT_TX_MAX } from '../lib/serial-tx.js'

const frameBytes = (label, n = 26) => Buffer.alloc(n, label)

/** 记录每次真正写出去的字节，用来验证顺序与完整性。 */
function recorder() {
  const chunks = []
  return {
    chunks,
    writeOnce: (buf) => { chunks.push(Buffer.from(buf)); return buf.length },
    all: () => Buffer.concat(chunks),
    labels: () => chunks.map((b) => String.fromCharCode(b[0])).join(''),
  }
}

test('控制帧：严格 FIFO，绝不丢、绝不插队', () => {
  const q = createTxQueue(4)
  const rec = recorder()
  assert.equal(q.push(frameBytes('A'.charCodeAt(0)), false), 'ok')
  assert.equal(q.push(frameBytes('B'.charCodeAt(0)), false), 'ok')
  q.pump(rec.writeOnce)
  assert.equal(rec.labels(), 'AB')
  assert.equal(q.size, 0)
})

test('动画帧：最新优先 —— 新的进来会把还没开始发的旧动画帧直接作废', () => {
  const q = createTxQueue(4)
  assert.equal(q.push(frameBytes('1'.charCodeAt(0)), true), 'ok')
  assert.equal(q.push(frameBytes('2'.charCodeAt(0)), true), 'ok')
  assert.equal(q.push(frameBytes('3'.charCodeAt(0)), true), 'ok')
  assert.equal(q.size, 1, '同一时刻只保留最新一帧动画')
  const rec = recorder()
  q.pump(rec.writeOnce)
  assert.equal(rec.labels(), '3')
})

test('短写：余量留在队首继续写，绝不把一帧从中间截断', () => {
  const q = createTxQueue(4)
  const frame = frameBytes('X'.charCodeAt(0), 26)
  q.push(frame, false)
  const chunks = []
  // 模拟非阻塞串口：一次只吃得下 10 字节
  const greedy = (buf) => { const n = Math.min(10, buf.length); chunks.push(Buffer.from(buf.subarray(0, n))); return n }
  q.pump(greedy)
  assert.equal(q.size, 1, '没写完就还在队列里')
  q.pump(greedy)
  q.pump(greedy)
  assert.equal(q.size, 0)
  assert.deepEqual(Buffer.concat(chunks), frame, '顺序与内容必须与原始帧完全一致')
})

test('已经写出过一部分的帧永不丢弃（否则固件收到半帧只能整帧丢掉）', () => {
  const q = createTxQueue(2)
  q.push(frameBytes('H'.charCodeAt(0), 26), true)   // 动画帧也可能正在写
  q.pump((buf) => Math.min(10, buf.length))         // 只写出 10 字节 → started = true
  // 新的动画帧进来：旧的"已开始"帧必须保留，不能被最新优先顶掉
  assert.equal(q.push(frameBytes('N'.charCodeAt(0)), true), 'ok')
  assert.equal(q.size, 2)
  const rec = recorder()
  q.pump(rec.writeOnce)
  assert.equal(rec.labels(), 'HN', '半帧的余量先写完，新帧排在后面')
  assert.equal(q.size, 0)
})

test('队列满：控制帧挤掉一个未开始的动画帧；全是控制帧才报 full', () => {
  const q = createTxQueue(2)
  q.push(frameBytes('a'.charCodeAt(0)), true)
  q.push(frameBytes('b'.charCodeAt(0)), true)   // 最新优先：a 作废，剩 b
  assert.equal(q.size, 1)
  q.push(frameBytes('c'.charCodeAt(0)), false)  // 控制帧
  assert.equal(q.size, 2)
  // 再来控制帧：挤掉还没开始发的动画帧 b，给 D 腾位置
  assert.equal(q.push(frameBytes('D'.charCodeAt(0)), false), 'ok')
  assert.equal(q.size, 2)
  const rec = recorder()
  q.pump(rec.writeOnce)
  assert.equal(rec.labels(), 'cD', 'b 被挤掉，控制帧顺序保持')
  // 全是控制帧时不再挤：报 full（由链路判故障走重连，不能无限堆积）
  q.push(frameBytes('E'.charCodeAt(0)), false)
  q.push(frameBytes('F'.charCodeAt(0)), false)
  assert.equal(q.size, 2)
  assert.equal(q.push(frameBytes('G'.charCodeAt(0)), false), 'full')
})

test('队列满且全是控制帧时，动画帧直接丢弃（返回 dropped，不是故障）', () => {
  const q = createTxQueue(2)
  q.push(frameBytes('A'.charCodeAt(0)), false)
  q.push(frameBytes('B'.charCodeAt(0)), false)
  assert.equal(q.push(frameBytes('x'.charCodeAt(0)), true), 'dropped')
  assert.equal(q.size, 2)
})

test('drain：写不动就按 deadline 放弃；能写就排空并返回 true', () => {
  const q = createTxQueue(4)
  q.push(frameBytes('B'.charCodeAt(0), 26), false)   // 早先排队的普通帧
  q.push(frameBytes('K'.charCodeAt(0), 26), false)   // 熄灯帧（最后入队）
  // ① 完全写不动（EAGAIN）：排到 deadline 就停
  let t = 0
  const stuck = q.drain({
    writeOnce: () => 0, now: () => t, deadline: 5, sleep: () => { t += 1 },
  })
  assert.equal(stuck, false)
  assert.equal(q.size, 2, '没排空就不能假装成功（熄灯帧还留在队列里）')
  // ② 恢复可写：排空，且熄灯帧是**最后一个**出去的
  const rec = recorder()
  const ok = q.drain({
    writeOnce: rec.writeOnce, now: () => t, deadline: 100, sleep: () => { t += 1 },
  })
  assert.equal(ok, true)
  assert.equal(q.size, 0)
  assert.equal(rec.labels(), 'BK', '顺序必须是 旧帧 → 熄灯帧')
})

test('默认上限 4 帧（约 104 字节）：够吸收抖动，又不会被灌爆', () => {
  assert.equal(DEFAULT_TX_MAX, 4)
})
