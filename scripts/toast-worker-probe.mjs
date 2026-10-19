// dsh-desktop-notify — 「Toast 发送 worker」真机验证（Windows）。
//
// 为什么要这个脚本：WinRT 的 Show 是同步 COM 调用（单条可 >100ms），生产环境把它放进
// 独立 worker（lib/toast-worker.js），由 lib/toast-bridge.js 决定何时回退主线程。
// 这里在真机上验证三条路径：
//   1. inline：主线程 probe + sendToast（worker 不可用时的兜底，必须始终可用）；
//   2. worker：probe 通过后由 worker 线程发送（不触发 inline 回退）；
//   3. close 后：桥已关闭 → 后续发送回退 inline（通知不能丢）。
//
// 运行：node scripts/toast-worker-probe.mjs
// 会真实弹出 3 条 Toast（A/B/C），并在通知中心留痕。
import * as winrt from '../lib/winrt.js'
import { createToastSender } from '../lib/toast-bridge.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fallbackItems = []

function inlineSend(item) {
  fallbackItems.push(String(item && item.title))
  try { winrt.sendToast(item) } catch (e) { console.error('[probe] inline fallback failed:', e && e.message) }
}

const inlineProbe = winrt.probeBackend()
console.log('[probe] inline probe =', JSON.stringify(inlineProbe))
if (!inlineProbe.ok) process.exit(2)

winrt.sendToast({
  title: 'DSH Toast worker 验证 A · inline',
  message: 'inline WinRT sendToast（兜底路径）',
  urgency: 'low',
  click: { wire: 'none' },
})
console.log('[probe] inline sendToast = ok')

const sender = createToastSender({
  log: (line) => console.log('[probe]', line),
  inlineSend,
  probeTimeoutMs: 3000,
  tag: 'probe',
})
const mode = await Promise.race([sender.ready(), sleep(6000).then(() => 'timeout')])
console.log('[probe] worker decision =', mode, '| sender.mode =', sender.mode)

sender.send({
  title: 'DSH Toast worker 验证 B · worker',
  message: 'WinRT 在独立 worker 线程发送',
  urgency: 'low',
  click: { wire: 'none' },
})
await sleep(1000)
console.log('[probe] worker send: mode =', sender.mode, '| inline fallbacks =', JSON.stringify(fallbackItems))

sender.close()
sender.send({
  title: 'DSH Toast worker 验证 C · closed→inline',
  message: '桥关闭后回退主线程发送',
  urgency: 'low',
  click: { wire: 'none' },
})
await sleep(500)
console.log('[probe] after close: inline fallbacks =', JSON.stringify(fallbackItems))

const workerOk = mode === 'worker' && sender.mode === 'closed'
const fallbackOk = fallbackItems.length === 1
if (!workerOk) console.error('[probe] worker 路径未生效（decision=' + mode + '）')
if (!fallbackOk) console.error('[probe] 回退路径不符合预期：' + JSON.stringify(fallbackItems))
console.log('[probe]', workerOk && fallbackOk ? 'PASS' : 'FAIL')
process.exit(workerOk && fallbackOk ? 0 : 1)
