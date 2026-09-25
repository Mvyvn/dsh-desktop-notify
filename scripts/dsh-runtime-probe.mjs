// dsh-desktop-notify — 真运行时探针：把宿主半区挂进 **DSH 自带的 cordis** 里跑一遍。
//
//   node scripts/dsh-runtime-probe.mjs
//   DSH_CHECKOUT=/path/to/deepseek-harness node scripts/dsh-runtime-probe.mjs
//
// 为什么需要它：单元测试用的是手写的假 ctx，锁住的是"我们以为的契约"；这个探针锁的是
// "真 cordis 到底怎么派发"——服务注入、作用域事件投递、ctx.inject 延迟注册、ctx.provide
// 注销、ctx.effect 清理。DSH 升级后先跑它，能第一时间发现契约漂移。
//
// 需要一份 DSH 源码 checkout（默认 D:\Program\deepseek-harness，可用 DSH_CHECKOUT 覆盖），
// 因为要用对方 vendor/ 里已构建好的 cordis 与 timer。**全程不发真实通知**：
// 发送出口通过 config.sender 收口。
//
// 想额外验证"作用域事件投递"这一项，需用 tsx 运行（scope 包只有 TS 源码）：
//   node --import <checkout>/node_modules/tsx/dist/esm/index.mjs scripts/dsh-runtime-probe.mjs
// 没有 tsx 时该项标记 SKIP，其余检查照常。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CHECKOUT = process.env.DSH_CHECKOUT || 'D:\\Program\\deepseek-harness'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
// 检查结果走这条已绑定的输出：运行期间 console.log 会被临时接管去收集插件日志
const realLog = console.log.bind(console)

let failed = 0
function check(label, ok, detail = '') {
  realLog(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}
function skip(label, why) {
  realLog(`SKIP  ${label} — ${why}`)
}

async function loadModule(relPath) {
  const path = join(CHECKOUT, relPath)
  if (!existsSync(path)) throw new Error('缺少 ' + path + '（DSH checkout 路径不对？用 DSH_CHECKOUT 指定）')
  return import(pathToFileURL(path).href)
}

if (!existsSync(CHECKOUT)) {
  console.error(`[runtime-probe] 找不到 DSH checkout：${CHECKOUT}`)
  console.error('               设置 DSH_CHECKOUT 指向 deepseek-harness 源码目录后重试。')
  process.exit(1)
}

const { Context } = await loadModule('vendor/cordis/lib/index.js')
const Timer = (await loadModule('vendor/timer/lib/index.js')).default
const plugin = await import(pathToFileURL(join(REPO_ROOT, 'lib', 'index.js')).href)

const sent = []
const debugLines = []
let rpcHandler = null
let rpcChannel = ''
let rpcDisposed = false

const rootSession = { id: 's1', header: { cwd: join('D:', 'ws', 'proj') } }
const rootAgent = { id: 's1', session: rootSession }

const ctx = new Context()
ctx.plugin(Timer)
ctx.provide('connection', {
  rpc: {
    handle(channel, handler) {
      rpcChannel = channel
      rpcHandler = handler
      return () => { rpcDisposed = true }
    },
  },
})
ctx.provide('sessions', { get: () => undefined })
ctx.provide('sessionTitle', { get: () => undefined })
ctx.provide('agents', { roots: () => [rootAgent] })
ctx.provide('fs', { resolve: async () => 'target', processPath: () => join('D:', 'ws', 'proj') })

// 插件的 debug 日志先收进缓冲区，最后统一打印（避免与检查结果交错）
console.log = (...args) => debugLines.push(args.map(String).join(' '))
const fiber = ctx.plugin(plugin, { debug: true, sender: (item) => { sent.push(item) } })
await tick(30)

check('插件能在真 cordis 里挂载（inject 的 connection/timer 都满足）', !fiber.error, String(fiber.error ?? ''))
check('desktopNotify 服务已注册', typeof ctx.get('desktopNotify')?.push === 'function')
check('rpc 通道名正确', rpcChannel === '/dnotify', rpcChannel)

const okReply = await rpcHandler('page-focus', { focused: true, pageId: 'p1', sessionId: 's1' })
check('rpc 返回 { ok: true, value } 结构', okReply?.ok === true && typeof okReply.value?.pages === 'number', JSON.stringify(okReply))
const badReply = await rpcHandler('nope', {})
check('rpc 未知 endpoint 返回结构化 error', badReply?.ok === false && !!badReply.error?.code, JSON.stringify(badReply))

// ---- 作用域事件投递（需要 tsx 才能 import scope 包）----
let scopeApi = null
try {
  scopeApi = await loadModule('packages/core/scope/src/index.ts')
} catch (e) {
  skip('作用域事件投递（agent/status / session/event）', '用 tsx 运行本脚本才能加载 TS 源码的 scope 包')
}
if (scopeApi) {
  await rpcHandler('page-focus', { focused: false, pageId: 'p1' })
  ctx.emit(scopeApi.scopeTarget(rootSession, undefined), 'session/event', rootSession, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '真机 cordis 验证' }] } },
  })
  ctx.emit(scopeApi.scopeTarget(rootAgent, rootAgent), 'agent/status', { agent: rootAgent, status: 'running' })
  await tick(10)
  ctx.emit(scopeApi.scopeTarget(rootAgent, rootAgent), 'agent/status', { agent: rootAgent, status: 'idle' })
  await tick(3500)
  check('未打标签的插件监听器能收到作用域事件并弹出完成通知',
    sent.length === 1 && /真机 cordis 验证/.test(sent[0].message), JSON.stringify(sent))
}

// ---- ctx.inject 延迟注册（服务晚挂载）----
const jobSubs = []
ctx.provide('jobs', {
  events: {
    subscribe(filter, listener) {
      jobSubs.push({ filter, listener })
      return () => { jobSubs.push('disposed') }
    },
  },
})
await tick(30)
check('jobs 服务晚挂载后 events.subscribe 被调用',
  jobSubs.length === 1 && jobSubs[0].filter?.owners === 'all',
  JSON.stringify(jobSubs.map((s) => (typeof s === 'string' ? s : s.filter))))
if (jobSubs.length === 1) {
  const before = sent.length
  jobSubs[0].listener({ type: 'progress', job: { id: 'j0', label: '构建', status: 'running' } })
  jobSubs[0].listener({ type: 'settled', awaited: true, cause: 'producer', job: { id: 'j0', label: '构建', status: 'completed' } })
  await tick(200)
  check('非 settled / awaited 的结算不通知', sent.length === before, JSON.stringify(sent.slice(before)))
  jobSubs[0].listener({ type: 'settled', awaited: false, cause: 'producer', job: { id: 'j1', label: '真机构建', status: 'completed' } })
  await tick(300)
  check('settled(awaited=false) 弹出后台任务通知',
    sent.length === before + 1 && /真机构建已完成/.test(sent[sent.length - 1].message), JSON.stringify(sent.slice(before)))
}

// ---- 聚焦门控 + 对外 API 在真 cordis 下同样工作 ----
await rpcHandler('page-focus', { focused: true, pageId: 'p1', sessionId: 's1' })
const api = ctx.get('desktopNotify')
const beforeAlways = sent.length
check('正在看的会话 push 返回 false（被静默）', api.push({ title: '应被静默', sessionId: 's1' }) === false)
const always = api.pushAlways({ title: '强制弹出' })
await tick(300)
check('pushAlways 绕过门控并真的发出',
  always === true && sent.length === beforeAlways + 1 && sent[sent.length - 1].title === '强制弹出',
  JSON.stringify(sent.slice(beforeAlways)))
const detail = api.notify({ title: '结构化', sessionId: 's1' })
check('notify() 返回结构化明细', detail?.silenced === true && detail?.queued === false, JSON.stringify(detail))
check('工作区名前缀来自 fs.resolve 的异步结果',
  sent.some((item) => String(item.message).startsWith('proj:')), JSON.stringify(sent.map((s) => s.message)))

// ---- 卸载清理 ----
await fiber.dispose()
await tick(20)
console.log = realLog
check('卸载后 rpc handler 已注销', rpcDisposed)
check('卸载后 desktopNotify 服务已注销', ctx.get('desktopNotify') === undefined)
check('卸载后 jobs 订阅已释放', jobSubs.includes('disposed'))

if (debugLines.length > 0) {
  realLog('--- 插件 debug 日志 ---')
  for (const line of debugLines) realLog('  ' + line)
}realLog(failed === 0 ? '[runtime-probe] 全部通过' : `[runtime-probe] ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
