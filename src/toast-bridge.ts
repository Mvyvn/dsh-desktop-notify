// Windows Toast 发送桥 —— 主线程侧：把发送交给独立 worker，失败则回退 inline。
//
// 为什么需要它（审计 #4）：
//   WinRT 的 Show 是**同步 COM**（koffi 直调），实测单条可 >100ms。即使把调用挪出
//   事件回调（setImmediate），它仍会占住主线程；通知频繁时主线程会周期性卡顿。
//   这里用与 serial/led 相同的 worker 模式：主线程只 postMessage，COM 在 worker 里跑。
//
// 安全网（任何一步失败都不能让通知静默丢）：
//   · worker 启动后先 **probe**（只初始化 WinRT + 建 notifier，不发通知）；
//   · probe 失败 / 超时 / 线程退出 → 永久回退 inline（主线程直接 sendToast，行为同 2.4.0）；
//   · 单条 toast 发送报错 → 该条用 inline 重发一次，worker 继续用；
//   · 进程退出/插件卸载 → close() 关线程；worker 已 unref，不会拖住宿主退出。

import { Worker } from 'node:worker_threads'

/** 只依赖 worker_threads 的一小部分（测试可注入假实现）。 */
export interface ToastWorkerLike {
  postMessage(msg: any): void
  on(event: 'message' | 'error' | 'exit', cb: (arg: any) => void): void
  terminate(): unknown
  unref?(): void
}

export interface ToastSenderOptions {
  readonly log?: (line: string) => void
  /** 回退路径：主线程直接发送（生产环境是 index.ts 的 sendToast）。 */
  readonly inlineSend: (item: any) => void
  /** 测试注入：返回 null/抛异常都视为"worker 不可用" → inline。 */
  readonly createWorker?: () => ToastWorkerLike | null
  /** probe 超时（超时即回退 inline；默认 2500ms）。 */
  readonly probeTimeoutMs?: number
  /** probe/队列的标签（日志用）。 */
  readonly tag?: string
}

export type ToastSenderMode = 'probing' | 'worker' | 'inline' | 'closed'

export interface ToastSender {
  /** 发一条 Toast（异步；调用方不被 COM 阻塞）。 */
  send(item: any): void
  /** 同步"自定义协议是否可用"给 worker（点击跳转走协议还是浏览器落地页）。 */
  syncClickProtocol(ready: boolean): void
  /** 当前模式：'probing'（尚未决定）/ 'worker' / 'inline' / 'closed'。 */
  readonly mode: ToastSenderMode
  /** 第一次决定用 worker 还是 inline 时 resolve（验证/测试用）。 */
  ready(): Promise<'worker' | 'inline'>
  close(): void
}

const DEFAULT_PROBE_TIMEOUT_MS = 2500
/** probe 期间最多缓存多少条通知（此时通常还没发几条；超了丢最旧并记日志）。 */
const MAX_PENDING_QUEUE = 32

function defaultCreateWorker(): ToastWorkerLike {
  const worker = new Worker(new URL('./toast-worker.js', import.meta.url), { execArgv: [] })
  if (typeof (worker as any).unref === 'function') (worker as any).unref()
  return worker as unknown as ToastWorkerLike
}

export function createToastSender(options: ToastSenderOptions): ToastSender {
  const log = options.log ?? (() => {})
  const tag = options.tag ?? 'toast'
  const probeTimeoutMs = Math.max(100, Number(options.probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS)

  let mode: ToastSenderMode = 'probing'
  let worker: ToastWorkerLike | null = null
  let nextId = 1
  let probeId = 0
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  let clickReady = false
  /** 还没决定用哪条路径时先排队。 */
  const queue: any[] = []
  /** 已交给 worker、还没回执的条目（worker 崩溃时用 inline 补发）。 */
  const pending = new Map<number, any>()
  let resolveReady: (value: 'worker' | 'inline') => void = () => {}
  const readyPromise = new Promise<'worker' | 'inline'>((resolve) => { resolveReady = resolve })
  let readySettled = false

  function settleReady(value: 'worker' | 'inline'): void {
    if (readySettled) return
    readySettled = true
    resolveReady(value)
  }

  function safeInlineSend(item: any): void {
    try {
      options.inlineSend(item)
    } catch (e) {
      log(`[${tag}] inline 发送失败：${(e as Error).message}`)
    }
  }

  function flushQueueToInline(): void {
    if (queue.length === 0) return
    const items = queue.splice(0, queue.length)
    log(`[${tag}] 回退 inline：补发 ${items.length} 条排队通知`)
    for (const item of items) safeInlineSend(item)
  }

  function fallback(reason: string, terminate = true): void {
    if (mode === 'inline' || mode === 'closed') return
    log(`[${tag}] 发送 worker 不可用（${reason}）→ 回退主线程 inline（通知继续可用）`)
    mode = 'inline'
    if (probeTimer !== null) { clearTimeout(probeTimer); probeTimer = null }
    const current = worker
    worker = null
    if (current !== null && terminate) { try { current.terminate() } catch (e) { /* ignore */ } }
    // worker 里可能还有已 Show 但没回执的：无法确认，用 inline 补一次（宁可重复也不丢）
    if (pending.size > 0) {
      const items = [...pending.values()]
      pending.clear()
      for (const item of items) safeInlineSend(item)
    }
    flushQueueToInline()
    settleReady('inline')
  }

  function postToWorker(msg: any): boolean {
    const target = worker
    if (target === null) return false
    try {
      target.postMessage(msg)
      return true
    } catch (e) {
      return false
    }
  }

  function flushQueueToWorker(): void {
    if (queue.length === 0) return
    const items = queue.splice(0, queue.length)
    for (const item of items) sendViaWorker(item)
  }

  function sendViaWorker(item: any): void {
    const id = nextId++
    pending.set(id, item)
    if (!postToWorker({ t: 'toast', id, item })) {
      pending.delete(id)
      safeInlineSend(item)
    }
  }

  function send(item: any): void {
    if (mode === 'closed' || mode === 'inline') { safeInlineSend(item); return }
    if (mode === 'worker') { sendViaWorker(item); return }
    if (queue.length >= MAX_PENDING_QUEUE) {
      queue.shift()
      log(`[${tag}] probe 期间队列已满，丢弃最旧的一条待发通知`)
    }
    queue.push(item)
  }

  function sendProbe(): void {
    if (mode !== 'probing') return
    probeId = nextId++
    postToWorker({ t: 'probe', id: probeId })
    if (probeTimer !== null) clearTimeout(probeTimer)
    probeTimer = setTimeout(() => {
      probeTimer = null
      fallback(`probe 超时 ${probeTimeoutMs}ms`)
    }, probeTimeoutMs)
    if (typeof (probeTimer as any).unref === 'function') (probeTimer as any).unref()
  }

  function onMessage(msg: any): void {
    if (!msg || typeof msg.t !== 'string') return
    if (msg.t === 'ready') {
      if (mode === 'probing' && probeId === 0) sendProbe()
      return
    }
    if (msg.t === 'probe-reply') {
      if (!msg.ok) { fallback(`probe 失败：${msg.message || 'unknown'}`); return }
      if (mode !== 'probing') return
      if (probeTimer !== null) { clearTimeout(probeTimer); probeTimer = null }
      mode = 'worker'
      log(`[${tag}] 发送 worker 就绪（WinRT 在独立线程）`)
      postToWorker({ t: 'clickProtocol', ready: clickReady })
      flushQueueToWorker()
      settleReady('worker')
      return
    }
    if (msg.t === 'sent') {
      pending.delete(msg.id)
      return
    }
    if (msg.t === 'error') {
      const item = pending.get(msg.id)
      pending.delete(msg.id)
      log(`[${tag}] worker 发送失败（${msg.message || 'unknown'}）→ 该条用 inline 补发`)
      if (item !== undefined) safeInlineSend(item)
    }
  }

  function spawn(): void {
    let created: ToastWorkerLike | null = null
    try {
      created = options.createWorker ? options.createWorker() : defaultCreateWorker()
    } catch (e) {
      created = null
    }
    if (created === null) { fallback('worker 创建失败', false); return }
    worker = created
    try { worker.unref?.() } catch (e) { /* ignore */ }
    worker.on('message', onMessage)
    worker.on('error', (err: any) => fallback(`worker 异常：${(err && err.message) || err}`))
    worker.on('exit', (code: any) => fallback(`worker 退出（code=${code}）`, false))
    sendProbe()
  }

  spawn()

  return {
    send,
    syncClickProtocol(ready: boolean) {
      clickReady = ready === true
      if (worker !== null) postToWorker({ t: 'clickProtocol', ready: clickReady })
    },
    get mode() { return mode },
    ready() { return readyPromise },
    close() {
      if (mode === 'closed') return
      const wasProbing = mode === 'probing'
      mode = 'closed'
      if (probeTimer !== null) { clearTimeout(probeTimer); probeTimer = null }
      const current = worker
      worker = null
      if (current !== null) {
        try { current.postMessage({ t: 'shutdown' }) } catch (e) { /* ignore */ }
        try { current.terminate() } catch (e) { /* ignore */ }
      }
      pending.clear()
      queue.length = 0
      if (wasProbing) settleReady('inline')
    },
  }
}
