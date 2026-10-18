#!/usr/bin/env node
// 内存探针 —— 回答一个问题：**240fps 的推帧路径会不会漏内存？**
//
// 背景：宿主 `dsh web` 曾以 4GB 堆 OOM 崩掉（Mark-Compact 反复无效，说明是"活对象"而不是垃圾
// 太多）。LED 帧循环每秒渲染 240 帧、每帧都要编码 26 字节并 postMessage，是最像"高频分配"的地方，
// 所以先用可控时钟把它单独跑起来，看 **GC 之后存活堆** 是否有增长趋势。
//
// 用法：node --expose-gc scripts/led-mem-probe.mjs [--seconds=120] [--fps=240] [--stress]
//
// 判读：
//   · 存活堆（gc 后 heapUsed）在预热后应该**平**（±几 MB 的锯齿正常）；
//   · 线性增长 > ~0.5 MB/min 就说明有东西被留住了，需要按场景二分（渲染 / 队列 / 串口模型）。
// ⚠️ 它模拟的是链路与渲染层；真正的 Windows worker 线程路径不在这里（那条用 --workers 测）。

import { createLedController } from '../lib/led-controller.js'
import { BAUD_RATE, MODE, VERIFY_REPLY, frameBytes } from '../lib/led-protocol.js'
import { monotonicNow } from '../lib/led-timing.js'

const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=')
      return [k, v === undefined ? 'true' : v]
    }),
)
const seconds = Math.max(5, Number(args.get('seconds') ?? 120) || 120)
const fps = Number(args.get('fps') ?? 0) || 0
const stress = args.get('stress') === 'true'
const LEDS_BYTES = frameBytes(MODE.LEDS)

// ── 串口模型（与 led-fps-probe 同构：串行化线上时间 + 有界在飞）────────────────
let inflight = 0
let busyUntil = 0
const rx = []
const handle = {
  write(bytes, options) {
    if (options && options.coalesce === true && inflight >= 1) return -1
    if (bytes[2] === MODE.VERIFY) setTimeout(() => rx.push(Buffer.from(VERIFY_REPLY, 'ascii')), 5)
    inflight += 1
    const now = monotonicNow()
    const start = Math.max(now, busyUntil)
    busyUntil = start + (bytes.length * 10 * 1000) / BAUD_RATE
    setTimeout(() => { inflight -= 1 }, Math.max(0, busyUntil - now))
    return bytes.length
  },
  read() { return rx.length > 0 ? rx.shift() : Buffer.alloc(0) },
  close() {},
  pending() { return inflight },
}

const running = () => ({
  id: 'mem', status: 'running', origin: 'user', session: { id: 'mem', header: {} },
})
const agents = { roots: () => [running()], list: () => [running()], get: () => running() }
const ctx = { get: (name) => (name === 'agents' ? agents : undefined) }
const config = {
  enabled: true, port: 'COM7', brightness: 160, buzzer: false,
  attention: true, master: true, idleOffMs: 120_000,
}

const controller = createLedController({
  ctx,
  config: () => config,
  log: () => {},
  isFocused: () => false,
  open: async () => handle,
  list: async () => [{ path: 'COM7', label: 'mem' }],
  ...(fps > 0 ? { frameMs: 1000 / fps } : {}),
})
controller.start()

/** 每 5 秒强制一次 full GC 再读存活堆：只有"收集之后仍然活着"的才算泄漏。 */
const samples = []
const sample = () => {
  if (typeof global.gc === 'function') global.gc()
  const m = process.memoryUsage()
  samples.push({ t: Date.now(), heap: m.heapUsed, rss: m.rss, external: m.external, frames: controller.status().frames.rendered })
}
const timer = setInterval(sample, 5000)
sample()

const end = Date.now() + seconds * 1000
const stressTimer = stress
  ? setInterval(() => {
    // 制造"事件循环被占"的窗口：帧循环会走"丢欠帧"分支
    const until = monotonicNow() + 5 + Math.random() * 10
    while (monotonicNow() < until) { /* busy */ }
  }, 200)
  : null

await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
clearInterval(timer)
if (stressTimer) clearInterval(stressTimer)
sample()
const st = controller.status()
controller.stop()

const mb = (n) => (n / 1024 / 1024).toFixed(1)
const first = samples[1] ?? samples[0]        // 跳过首样（模块初始化）
const last = samples[samples.length - 1]
const spanMin = (last.t - first.t) / 60000
const growth = (last.heap - first.heap) / 1024 / 1024
const perMin = spanMin > 0 ? growth / spanMin : 0

console.log(`[mem] ${seconds}s @ ${fps > 0 ? Math.round(fps) : 240}fps${stress ? '（注入卡顿）' : ''}，`
  + `共渲染 ${st.frames.rendered} 帧、推 ${st.link.framesSent} 帧、丢 ${st.link.dropped} 帧`)
console.log('  时刻(s)  存活堆(MB)  RSS(MB)  external(MB)  已渲染帧')
for (const s of samples) {
  console.log(`  ${String(((s.t - samples[0].t) / 1000).toFixed(0)).padStart(6)}  ${mb(s.heap).padStart(9)}  ${mb(s.rss).padStart(7)}  ${mb(s.external).padStart(11)}  ${String(s.frames).padStart(9)}`)
}
console.log('')
console.log(`存活堆：首样 ${mb(first.heap)}MB → 末样 ${mb(last.heap)}MB，`
  + `增长 ${growth.toFixed(1)}MB / ${spanMin.toFixed(1)}min = **${perMin.toFixed(2)} MB/min**`)
console.log(perMin > 0.5
  ? '⚠️ 有增长趋势：这条路径存在"被留住"的对象，需要按渲染/队列/串口模型逐段二分'
  : '✅ 预热后存活堆基本平：240fps 的渲染 + 编码 + 入队路径**没有**泄漏迹象')
process.exit(0)
