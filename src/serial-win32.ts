// Win32 串口实现 —— **主线程只做队列，不做任何耗时原生调用**。
//
// 为什么改成 worker：
//   Win32 的同步串口 API 在"设备被拔掉"这类状态下可能长时间甚至永久阻塞
//   （WriteFile 卡在驱动里、CreateFileW 卡在枚举里）。只要这些调用跑在 DSH 主线程，
//   一次拔线就能把整个事件循环冻死：页面不响应、定时器不走、Ctrl+C 都送不进去，
//   只能关终端（用户实测就是这么卡死的）。
//
//   现在所有 koffi 串口调用都关在 `serial-worker.ts` 那个线程里：
//     · 主线程 `write()` 只把帧丢进队列、立刻返回（不碰原生）；
//     · 主线程 `read()` 只从接收队列取字节（不碰原生）；
//     · worker 卡死时，主线程的看门狗 terminate() 掉它并报故障，DSH 全程可用。
//
// 因此这里的"写成功"含义是**已交给 worker**；真正的完成/失败通过 `onFault`
// 异步通知链路，链路据此走既有的 fail() 重连路径。

import { Worker } from 'node:worker_threads'
import koffi from 'koffi'

import { WRITE_DROPPED, type LinkHandle, type LinkWriteOptions } from './serial-link.js'

/** 主线程侧句柄：多一个"故障回调"，把 worker 里的失败转给链路。 */
export interface Win32SerialHandle extends LinkHandle {
  onFault?: (message: string) => void
}

/** 打开/关闭等待上限：超时就 terminate（说明原生调用卡住了）。 */
const OPEN_TIMEOUT_MS = 4000
/** 一帧最长等待：超过就认为 worker 卡住，杀掉重来。 */
const WRITE_WATCHDOG_MS = 1200
/** 接收队列上限（读得不够快时丢最旧的，绝不无限增长）。 */
const RX_LIMIT_BYTES = 64 * 1024
/**
 * 发送队列上限（**有界队列**）：worker 里同时只允许有 1 帧。
 *
 * 为什么必须有：主线程 `write()` 只是 postMessage（立刻返回成功），真正的
 * WriteFile 在 worker 里串行执行 —— 26B @115200 要 2.26ms。如果主线程按 240fps
 * （4.17ms/帧）推，而某段时间 worker 慢下来（驱动阻塞、USB 忙），消息就会在
 * worker 的消息队列里**无限堆积**：主线程以为"已经在推了"，实际灯在读几秒钟前的画面，
 * 而且是越追越晚。加了上限之后，积压时**丢掉过期的动画帧**、只留最新画面，
 * 最坏情况退化成"帧率降低"，而不是"画面越走越延迟"。
 *
 * 控制帧（握手/蜂鸣/熄灯）不走这个门控：它们必须按顺序全到，队列最多因此多 1 帧。
 */
const MAX_INFLIGHT_WRITES = 1

const workerUrl = new URL('./serial-worker.js', import.meta.url)

/** 空读取的共享返回值：`read()` 每 4ms 被调一次，没数据时不该每次分配一个空 Buffer。 */
const EMPTY_RX = Buffer.alloc(0)

/**
 * 把 worker 发来的结构化克隆包成 Buffer。
 *
 * 结构化克隆给到的是**这次消息新分配**的 ArrayBuffer/Uint8Array，所以这里做视图即可，
 * 不要再 `Buffer.from(msg.data)` 复制一遍（那是接收路径上每块的额外一次拷贝）。
 */
function chunkView(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return null
}

/**
 * 打开串口（异步：spawn worker → 等 ready → 下发 open → 等 opened）。
 * @param options.dtr 默认 false：不置 DTR/RTS，避免一开端口就复位单片机
 */
export async function openWin32Serial(
  path: string,
  baud: number,
  options: { dtr?: boolean; rts?: boolean } = {},
): Promise<Win32SerialHandle> {
  // 同步写的握手区：worker 写完后在这里写结果并唤醒主线程（不需要事件循环）。
  // 见 writeSync() 的说明 —— 只有"熄灯/退出"那一帧走这条路。
  const syncSab = new SharedArrayBuffer(4)
  const syncView = new Int32Array(syncSab)
  // execArgv 传空：避免继承父进程的 --input-type/--eval 之类参数（worker 是**文件**，不是 eval）
  const worker = new Worker(workerUrl, { workerData: { tag: path, sync: syncSab }, execArgv: [] })
  // 不让这个线程把宿主/测试进程的事件循环钉住：
  // 消息照常收发，但"没有别的活儿"时进程可以正常退出（否则单测会被它挂死）。
  worker.unref()
  let closed = false
  let dead = false
  /** onFault 只报一次：一个 worker 的致命故障重复上报会让链路把重连次数/退避算错。 */
  let faultReported = false
  let fault: ((message: string) => void) | undefined

  const reportFault = (message: string): void => {
    if (closed || faultReported) return
    // 还没挂 onFault（open 尚未返回）：不吞这次故障，留给下一条；
    // 这个窗口极小（微任务级），且启动期失败本来就走 open() 的异常路径。
    if (fault === undefined) return
    faultReported = true
    fault(message)
  }

  const rx: Buffer[] = []
  let rxBytes = 0
  /** 尚未被 worker 回报 written 的帧：seq → 入队时刻（不用每帧再分配一个对象）。 */
  const pending = new Map<number, number>()
  let seq = 0

  const pushRx = (chunk: Buffer): void => {
    rx.push(chunk)
    rxBytes += chunk.length
    while (rxBytes > RX_LIMIT_BYTES && rx.length > 1) {
      const dropped = rx.shift() as Buffer
      rxBytes -= dropped.length
    }
  }

  const waiters: Array<(msg: any) => void> = []
  const nextMessage = (timeoutMs: number): Promise<any> => new Promise((resolve, reject) => {
    const handler = (msg: any): void => { clearTimeout(timer); resolve(msg) }
    const timer = setTimeout(() => {
      const at = waiters.indexOf(handler)
      if (at >= 0) waiters.splice(at, 1)
      reject(new Error('worker 无响应（原生调用可能卡住）'))
    }, timeoutMs)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()
    waiters.push(handler)
  })

  worker.on('message', (msg: any) => {
    if (msg && typeof msg.t === 'string') {
      if (msg.t === 'data') {
        const chunk = chunkView(msg.data)
        if (chunk !== null) pushRx(chunk)
        return
      }
      if (msg.t === 'written') { pending.delete(Number(msg.seq)); return }
      if (msg.t === 'writeError') {
        pending.delete(Number(msg.seq))
        reportFault(String(msg.message ?? '写入失败'))
        return
      }
    }
    const waiter = waiters.shift()
    if (waiter) waiter(msg)
  })
  worker.on('error', (err) => {
    dead = true
    // 启动阶段（还没等到 ready）必须把等待者叫醒，否则 open() 会永远挂着
    const waiter = waiters.shift()
    if (waiter) waiter({ t: 'workerError', message: err.message })
    reportFault(`串口线程异常：${err.message}`)
  })
  worker.on('exit', (code) => {
    dead = true
    const waiter = waiters.shift()
    if (waiter) waiter({ t: 'workerError', message: `串口线程退出（code=${code}）` })
    reportFault(`串口线程退出（code=${code}）`)
  })

  /** 看门狗：worker 卡在原生调用里时，主线程照样活着 —— 杀掉它并报故障。 */
  const watchdog = setInterval(() => {
    if (dead || closed) return
    const now = Date.now()
    let hung = false
    for (const [s, at] of pending) {
      if (now - at > WRITE_WATCHDOG_MS) { pending.delete(s); hung = true }
    }
    if (!hung) return
    dead = true
    void worker.terminate()
    reportFault('串口写入超时（设备可能已拔出）')
  }, 250)
  if (typeof (watchdog as any).unref === 'function') (watchdog as any).unref()

  const abort = (err: unknown): never => {
    closed = true
    clearInterval(watchdog)
    void worker.terminate()
    throw err instanceof Error ? err : new Error(String(err))
  }

  try {
    const ready = await nextMessage(OPEN_TIMEOUT_MS)
    if (ready && ready.t === 'workerError') return abort(new Error(String(ready.message)))
    if (!ready || ready.t !== 'ready') return abort(new Error('串口线程启动异常'))
  } catch (e) {
    return abort(e)
  }

  worker.postMessage({ t: 'open', path, baud, dtr: options.dtr === true, rts: options.rts === true })
  try {
    const res = await nextMessage(OPEN_TIMEOUT_MS)
    if (res && res.t === 'workerError') return abort(new Error(String(res.message)))
    if (res && res.t === 'openError') return abort(new Error(String(res.message)))
    if (!res || res.t !== 'opened') return abort(new Error('串口打开失败'))
  } catch (e) {
    return abort(e)
  }

  return {
    get onFault() { return fault },
    set onFault(fn: ((message: string) => void) | undefined) { fault = fn },
    /** 此刻还没被 worker 回报 written 的帧数（背压诊断用）。 */
    pending(): number { return pending.size },
    /**
     * 交给 worker。
     *
     * 返回值语义：`bytes.length` = **已入队**（真正的完成/失败走 onFault，主线程不阻塞）；
     * `WRITE_DROPPED` = 按 `options.coalesce` 主动丢弃（有积压）。
     * 注意"已入队"**不等于"已上灯"** —— 这正是必须有 pending()/看门狗的原因。
     */
    write(bytes: Buffer, options?: LinkWriteOptions): number {
      if (closed || dead) return 0
      // 有界队列：动画帧可丢（下一次用最新画面重发），控制帧必达。
      if (options?.coalesce === true && pending.size >= MAX_INFLIGHT_WRITES) return WRITE_DROPPED
      const id = (seq += 1)
      pending.set(id, Date.now())
      // ⚠️ 不能用 Buffer.from(bytes) 再转移它的 backing ArrayBuffer：
      // 小 Buffer 来自 Node 的 8KB **共享池**，转移等于把整个池从主线程 detach 掉
      // （之后主线程所有小 Buffer 分配都会坏掉），而且 worker 拿到的是"池起点"而不是帧起点。
      // 正确做法：分配一块**独占**的精确大小内存再转移。
      const copy = new Uint8Array(bytes.length)
      copy.set(bytes)
      try {
        worker.postMessage({ t: 'write', seq: id, data: copy }, [copy.buffer])
      } catch (e) {
        pending.delete(id)
        return 0
      }
      return bytes.length
    },
    /** 只从队列取字节 —— 主线程不碰任何原生 API。 */
    read(max = 256): Buffer {
      if (rx.length === 0 || max <= 0) return EMPTY_RX
      const out: Buffer[] = []
      let got = 0
      while (rx.length > 0 && got < max) {
        const head = rx[0]
        const need = max - got
        if (head.length <= need) { out.push(head); rx.shift(); got += head.length }
        else { out.push(head.subarray(0, need)); rx[0] = head.subarray(need); got += need }
      }
      rxBytes -= got
      return Buffer.concat(out, got)
    },
    /**
     * **同步**写一帧：阻塞到 worker 回报 WriteFile 的结果（或超时）。
     *
     * 为什么必须同步：异步 write 只保证"交给 worker"。进程退出 / worker 被 terminate /
     * 驱动缓冲还满时，那一帧可能根本没发出去，而 WS2812B 锁存最后一帧 ——
     * 表现就是"DSH 关了，灯还亮着"。所以熄灯/退出这一帧用 `Atomics.wait` 等 worker：
     * worker 把结果写进 SharedArrayBuffer 并 notify，**主线程不需要事件循环**就能醒。
     *
     * 代价：阻塞主线程一帧的线上时间（~2.3ms；最坏等 timeout）。只准用在关机类路径。
     */
    writeSync(bytes: Buffer, timeoutMs = 400): number {
      if (closed || dead) return 0
      Atomics.store(syncView, 0, 0)          // 0 = 还没回来（>0 = 已接受字节数，-1 = 失败）
      const copy = new Uint8Array(bytes.length)
      copy.set(bytes)
      try {
        worker.postMessage({ t: 'writeSync', data: copy }, [copy.buffer])
      } catch (e) {
        return 0
      }
      Atomics.wait(syncView, 0, 0, Math.max(1, timeoutMs))
      const n = Atomics.load(syncView, 0)
      return n > 0 ? n : 0
    },
    close(): void {
      if (closed) return
      closed = true
      clearInterval(watchdog)
      pending.clear()
      try { worker.postMessage({ t: 'close' }) } catch (e) { /* ignore */ }
      // 收尾宽限：没有在飞帧就 150ms；有的话按"一帧最多 200ms 写超时"放宽，
      // 免得 terminate 把还在发的最后一帧（熄灯帧）截断。
      const grace = Math.min(2000, 150 + pending.size * 250)
      const timer = setTimeout(() => { void worker.terminate() }, grace)
      if (typeof (timer as any).unref === 'function') (timer as any).unref()
    },
  }
}

/**
/**
 * 枚举本机串口（**异步**，在 worker 里读注册表）。
 *
 * 为什么不能在主线程做：设备**正在被拔掉**的瞬间，注册表/设备栈查询会卡住 ——
 * 那正是"快速插拔必现卡死"的直接原因（慢速插拔时设备栈稳定，所以看不出来）。
 * 这里用一条常驻的枚举 worker：调用串行化、结果缓存 400ms、卡住就 terminate 重来。
 */
let listWorker: Worker | null = null
let listSeq = 0
let listInflight: Promise<Array<{ path: string; label: string }>> | null = null
let listCache: { at: number; ports: Array<{ path: string; label: string }> } = { at: 0, ports: [] }
const LIST_TIMEOUT_MS = 1500
const LIST_CACHE_MS = 400

function ensureListWorker(): Worker {
  if (listWorker !== null) return listWorker
  const w = new Worker(workerUrl, { workerData: { tag: 'list' }, execArgv: [] })
  w.unref()                       // 不钉住宿主/测试进程的事件循环
  w.on('error', () => { try { void w.terminate() } catch (e) { /* ignore */ } if (listWorker === w) listWorker = null })
  w.on('exit', () => { if (listWorker === w) listWorker = null })
  listWorker = w
  return w
}

/** 枚举本机串口（永不抛；卡住/失败都返回空数组）。 */
export async function listWin32SerialPorts(): Promise<Array<{ path: string; label: string }>> {
  const now = Date.now()
  if (now - listCache.at < LIST_CACHE_MS) return listCache.ports
  if (listInflight !== null) return listInflight          // 并发调用合并成一次

  listInflight = new Promise((resolve) => {
    const worker = ensureListWorker()
    const mySeq = (listSeq += 1)
    let settled = false
    const finish = (ports: Array<{ path: string; label: string }>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.removeListener('message', onMessage)
      listCache = { at: Date.now(), ports }
      listInflight = null
      resolve(ports)
    }
    const onMessage = (msg: any): void => {
      if (!msg || msg.t !== 'ports' || msg.seq !== mySeq) return
      finish(Array.isArray(msg.ports) ? msg.ports : [])
    }
    const timer = setTimeout(() => {
      // 卡住了（设备正在消失）：杀掉这条 worker，本次当作"没有串口"，下次重建
      try { void worker.terminate() } catch (e) { /* ignore */ }
      if (listWorker === worker) listWorker = null
      finish([])
    }, LIST_TIMEOUT_MS)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()
    worker.on('message', onMessage)
    try {
      worker.postMessage({ t: 'list', seq: mySeq })
    } catch (e) {
      finish([])
    }
  })
  return listInflight
}
