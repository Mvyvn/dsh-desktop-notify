#!/usr/bin/env node
// 帧率压测/实测 —— 回答一个问题：**目标帧率到底能不能落地？**
//
// 为什么需要它：代码里"240fps"曾经只存在于注释里（实际帧周期 8ms = 125fps）。
// 只读代码永远说不清"稳不稳"，必须用**真实定时器**跑一段，然后看：
//   · 实际渲染帧率（controller.status().frames.fps）
//   · 真正交给串口的帧数、被背压丢掉的帧数
//   · 相邻两次"写入被接受"的间隔分布（P50/P95/P99/max）——抖动的直接证据
//   · 发送队列峰值（说明会不会越追越晚）
//
// 它不是单测（单测用可控时钟，验逻辑），这里用的是真时钟 + 一个**串行化的
// worker 模型**：Windows 上 WriteFile 在 worker 线程里串行执行，26B @115200 占 2.257ms，
// 所以模型是"一帧排队 + 线上时间"而不是"写完立刻完成"。
//
// 用法：
//   node scripts/led-fps-probe.mjs                 # 10 秒，默认 240fps
//   node scripts/led-fps-probe.mjs --seconds=30 --fps=125
//   node scripts/led-fps-probe.mjs --stress        # 额外注入主线程卡顿，验"丢欠帧不补跑"
//
// ⚠️ 测量边界：固件的握手回包只能证明"设备身份 + 链路活着"，**不能逐帧确认颜色已应用**。
// 所以要证明"灯板真的稳定收到 240 帧/秒"，最终仍需逻辑分析仪量 UART 波形
// （或者给固件加帧序号+确认，那是另一套协议）。

import { createLedController } from '../lib/led-controller.js'
import { createLedRuntime } from '../lib/led-runtime.js'
import { BAUD_RATE, MODE, VERIFY_REPLY, frameBytes } from '../lib/led-protocol.js'
import { frameBudget, frameBudgetText, monotonicNow } from '../lib/led-timing.js'

const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=')
      return [k, v === undefined ? 'true' : v]
    }),
)
const seconds = Math.max(1, Number(args.get('seconds') ?? 10) || 10)
const fps = Number(args.get('fps') ?? 0) || 0            // 0 = 用 led-timing 的目标帧率
const stress = args.get('stress') === 'true'
const quiet = args.get('quiet') === 'true'

const LEDS_BYTES = frameBytes(MODE.LEDS)
const wireMs = (LEDS_BYTES * 10 * 1000) / BAUD_RATE

// ── 串行化的 worker 模型 ────────────────────────────────────────────────────
// inflight = 已交给 worker 还没回报 written 的帧数（真实实现里就是这个语义）。
let inflight = 0
let inflightPeak = 0
let busyUntil = 0
/** 接收队列：**每个验证帧都要回包**（真固件就是这么答的）。 */
const rxQueue = []
/** 被接受进队列的 LEDS 帧（时刻 = 主线程交给 worker 的时刻）。 */
const accepted = []
/** worker 回报"写完"的时刻（这才是真正上线的时间）。 */
const delivered = []
let transportDropped = 0
let bytesIn = 0

const handle = {
  write(bytes, options) {
    // 有界队列：动画帧可丢（与 serial-win32 的 MAX_INFLIGHT_WRITES=1 同策略）
    if (options && options.coalesce === true && inflight >= 1) { transportDropped += 1; return -1 }
    const n = bytes.length
    bytesIn += n
    const isLeds = bytes[2] === MODE.LEDS
    if (isLeds) {
      accepted.push(monotonicNow())
    }
    // 验证帧 → 板子 ~15ms 后回 ASCII（链路的主动探测靠它；不回包就会被判"设备拔了"）
    if (bytes[2] === MODE.VERIFY) {
      setTimeout(() => rxQueue.push(Buffer.from(VERIFY_REPLY, 'ascii')), 15)
    }
    inflight += 1
    if (inflight > inflightPeak) inflightPeak = inflight
    // worker 串行：这一帧真正开始传的时刻 = max(现在, 上一帧传完)
    const now = monotonicNow()
    const start = Math.max(now, busyUntil)
    busyUntil = start + (n * 10 * 1000) / BAUD_RATE
    const doneAt = busyUntil
    setTimeout(() => {
      inflight -= 1
      if (isLeds) delivered.push(monotonicNow())
    }, Math.max(0, doneAt - now))
    return n
  },
  read() {
    const out = rxQueue.length > 0 ? rxQueue.shift() : Buffer.alloc(0)
    return out
  },
  close() { /* 压测不真的关 */ },
  pending() { return inflight },
}

// ── 控制器（真实定时器、真实链路、假串口）──────────────────────────────────
const running = () => ({
  id: 'probe', status: 'running', origin: 'user', session: { id: 'probe', header: {} },
})
const agents = {
  roots: () => [running()],
  list: () => [running()],
  get: () => running(),
}
const ctx = { get: (name) => (name === 'agents' ? agents : undefined) }
const config = {
  enabled: true, port: 'COM7', brightness: 160, buzzer: false,
  attention: true, master: true, idleOffMs: 120_000,
}

/** 主线程卡顿注入：每 25 帧忙等 ms 毫秒（模拟采样/GC/宿主其它活儿）。 */
const stalls = { injected: 0, totalMs: 0 }
let frameCount = 0

const controller = createLedController({
  ctx,
  config: () => config,
  log: quiet ? () => {} : (line) => console.log(line),
  isFocused: () => false,
  open: async () => handle,
  list: async () => [{ path: 'COM7', label: 'probe' }],
  ...(fps > 0 ? { frameMs: 1000 / fps } : {}),
  // 探针走 **inline 运行时**：假串口句柄没法跨线程，而 worker 里跑的是同一份
  // led-runtime.ts —— 这里量到的节拍就是 worker 里的节拍（区别只在执行线程）。
  // 想在真实 worker 里看帧率，用 `DSH_LED_RUNTIME` 那一套 + 真设备（/dnotify/led 的 status）。
  runtimeFactory: (runtimeOptions) => createLedRuntime(runtimeOptions),
})

const budget = frameBudget(LEDS_BYTES, BAUD_RATE, fps > 0 ? fps : undefined)
console.log(`[probe] ${frameBudgetText(budget)}`)
console.log(`[probe] 一帧 ${LEDS_BYTES} B，模型线上时间 ${wireMs.toFixed(3)}ms，运行 ${seconds}s`
  + `${stress ? '（注入主线程卡顿）' : ''}`)
controller.start()

// 周期注入卡顿：用 setInterval 也行，但为了"真的卡住主线程"必须忙等。
const stallTimer = stress
  ? setInterval(() => {
    const ms = 3 + Math.random() * 9
    const end = monotonicNow() + ms
    while (monotonicNow() < end) { /* 忙等：等价于主线程被占住 */ }
    stalls.injected += 1
    stalls.totalMs += ms
  }, 220)
  : null
if (stallTimer && typeof stallTimer.unref === 'function') stallTimer.unref()

// 采样 status（走的是同一个时钟，可以顺带验证 status() 不贵）
const statusTimer = setInterval(() => {
  const s = controller.status()
  frameCount = s.frames.rendered
}, 500)
if (typeof statusTimer.unref === 'function') statusTimer.unref()

await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
clearInterval(statusTimer)
if (stallTimer) clearInterval(stallTimer)

const status = controller.status()
controller.stop()

// ── 统计 ────────────────────────────────────────────────────────────────────
function quantile(sorted, q) {
  if (sorted.length === 0) return 0
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[at]
}
function gaps(times) {
  const out = []
  for (let i = 1; i < times.length; i += 1) out.push(times[i] - times[i - 1])
  return out.sort((a, b) => a - b)
}
const acceptedGaps = gaps(accepted)
const deliveredGaps = gaps(delivered)
const span = accepted.length > 1 ? (accepted[accepted.length - 1] - accepted[0]) / 1000 : 0
const sendFps = span > 0 ? (accepted.length - 1) / span : 0
const deliveredSpan = delivered.length > 1 ? (delivered[delivered.length - 1] - delivered[0]) / 1000 : 0
const deliveredFps = deliveredSpan > 0 ? (delivered.length - 1) / deliveredSpan : 0
const fmt = (n, d = 2) => Number(n).toFixed(d)

const frames = status.frames
console.log('')
console.log('─ 结果 ' + '─'.repeat(52))
console.log(`目标帧率        ${fmt(frames.targetFps, 0)}fps（${fmt(frames.frameMs, 3)}ms/帧，写入下限 ${fmt(budget.minGapMs)}ms）`)
console.log(`渲染帧率(实测)  ${fmt(frames.fps)}fps  ← controller.status().frames.fps（2s 窗口）`)
console.log(`渲染帧数        ${frames.rendered}（迟到丢弃的欠帧 ${frames.skipped}）`)
console.log(`交给串口的帧    ${accepted.length}（${fmt(sendFps)}fps；字节 ${bytesIn}）`)
console.log(`worker 回报完成 ${delivered.length}（${fmt(deliveredFps)}fps）`)
console.log(`链路背压丢帧    ${status.link.dropped}（传输层按 coalesce 拒绝，不是故障）`)
console.log(`传输/有界队列丢帧 ${transportDropped}（in-flight>1 时拒绝动画帧）`)
console.log(`发送队列峰值    ${inflightPeak} 帧（>2 说明 worker 跟不上）`)
if (stress) console.log(`注入卡顿        ${stalls.injected} 次，共 ${fmt(stalls.totalMs, 0)}ms`)
const rows = [
  ['接受帧间隔', acceptedGaps, 1000 / (fps > 0 ? fps : 240)],
  ['完成帧间隔', deliveredGaps, 1000 / (fps > 0 ? fps : 240)],
]
console.log('')
console.log('间隔分布(ms)    P50     P95     P99     max    帧周期')
for (const [name, list, target] of rows) {
  console.log(
    `${name.padEnd(12)}${fmt(quantile(list, 0.5)).padStart(7)}`
    + `${fmt(quantile(list, 0.95)).padStart(8)}`
    + `${fmt(quantile(list, 0.99)).padStart(8)}`
    + `${fmt(list.length > 0 ? list[list.length - 1] : 0).padStart(8)}`
    + `${fmt(target).padStart(9)}`,
  )
}
const verdict = frames.fps > 0 && frames.fps >= frames.targetFps * 0.75
console.log('')
console.log(verdict
  ? `✅ 实测渲染帧率 ${fmt(frames.fps)}fps ≥ 目标 ${fmt(frames.targetFps, 0)}fps 的 75%，节拍成立`
  : `⚠️ 实测渲染帧率 ${fmt(frames.fps)}fps 未达目标 ${fmt(frames.targetFps, 0)}fps（Windows 定时器分辨率/主线程负载限制）`)
process.exit(0)
