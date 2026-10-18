// 串口发送队列（纯逻辑，两个平台共用同一套语义）
//
// 为什么单独成一个模块：Windows 侧"在飞 1 帧 + 动画帧可丢"的策略在 serial-win32 里，
// POSIX 侧过去只有"最多 4 条 FIFO"，两边行为不一致，而且下面两个问题都出在这：
//   · POSIX 同步写会**绕过队列插队**（熄灯帧可能先被接受，残旧帧的余量再被 close 追发上去）；
//   · POSIX 恢复后会把积压的旧动画帧逐帧发完才追到最新画面（画面越走越晚）。
// 所以把两个平台都要的语义收成一份纯逻辑，便于单测穷举：
//
//   · **动画帧（coalesce）**：最新帧优先 —— 新的进来时丢掉"尚未开始发送"的旧动画帧；
//     队列满时直接丢弃（调用方下一次用最新画面重发，而不是让旧画面排队）。
//   · **控制帧**（验证 / 蜂鸣 / 熄灯 / 自检覆盖）：一律入队、严格 FIFO、绝不丢、绝不插队；
//     队列满时先挤掉一个"还没开始发的动画帧"腾位置，挤不出来才报 'full'（由链路判故障）。
//   · **短写**：余量留在队首继续写，绝不把一帧从中间截断（固件按整帧校验，半帧必然丢弃）。
//   · 已经写出过一部分的帧标记 started，**永不丢弃** —— 丢在中间会让固件收到半帧。

/** 队列条目。 */
export interface TxEntry {
  /** 待写字节（短写之后是当前帧的余量）。 */
  buf: Buffer
  /** true = 可丢弃的动画帧；false = 必达的控制帧。 */
  readonly coalesce: boolean
  /** 已经写出过一部分（这种帧不能再丢）。 */
  started: boolean
}

export type TxPushResult = 'ok' | 'dropped' | 'full'

export interface TxDrainOptions {
  /** 真正写一次；返回 0 表示写不动（EAGAIN / 缓冲满），队列保持不变。 */
  readonly writeOnce: (buf: Buffer) => number
  readonly now: () => number
  /** 排空截止时刻（相对 `now` 的同一时间源）。 */
  readonly deadline: number
  /** 等待用的同步小睡（由平台提供：POSIX 用 Atomics.wait）。 */
  readonly sleep: (ms: number) => void
}

export interface TxQueue {
  /** 队列长度（= 还没发完的帧数）。 */
  readonly size: number
  /** 入队并按需推一次。 */
  push(bytes: Buffer, coalesce: boolean): TxPushResult
  /** 推一次（短写会把余量留在队首）。 */
  pump(writeOnce: (buf: Buffer) => number): void
  /** 在 deadline 前排空；返回是否真的排空。 */
  drain(options: TxDrainOptions): boolean
  /** 队列里是否还有某一帧（同步写用它判断"我这一帧发出去了没有"）。 */
  has(entry: TxEntry): boolean
  /** 清空（关闭时用）。 */
  clear(): void
}

export const DEFAULT_TX_MAX = 4

export function createTxQueue(max: number = DEFAULT_TX_MAX): TxQueue {
  const queue: TxEntry[] = []
  const cap = Math.max(1, Math.trunc(max) || DEFAULT_TX_MAX)

  /** 丢掉所有"还没开始发送"的动画帧（队首若是半帧/控制帧会保留）。 */
  function dropUnstartedAnimation(): void {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const frame = queue[i] as TxEntry
      if (frame.coalesce && !frame.started) queue.splice(i, 1)
    }
  }

  function push(bytes: Buffer, coalesce: boolean): TxPushResult {
    if (!coalesce) {
      if (queue.length >= cap) {
        // 控制帧必达：先挤掉一个还没开始发的动画帧腾位置；挤不出来才是真塞不下
        let victim = -1
        for (let i = queue.length - 1; i >= 0; i -= 1) {
          const frame = queue[i] as TxEntry
          if (frame.coalesce && !frame.started) { victim = i; break }
        }
        if (victim < 0) return 'full'
        queue.splice(victim, 1)
      }
      queue.push({ buf: Buffer.from(bytes), coalesce: false, started: false })
      return 'ok'
    }
    // 动画帧：最新优先 —— 旧动画帧（尚未开始发送的）直接作废
    dropUnstartedAnimation()
    if (queue.length >= cap) return 'dropped'
    queue.push({ buf: Buffer.from(bytes), coalesce: true, started: false })
    return 'ok'
  }

  function pump(writeOnce: (buf: Buffer) => number): void {
    while (queue.length > 0) {
      const head = queue[0] as TxEntry
      let n = 0
      try {
        n = writeOnce(head.buf)
      } catch (e) {
        return                      // 写异常：保持队列原样，交给下一次/超时
      }
      if (!Number.isFinite(n) || n <= 0) return   // EAGAIN：缓冲满，下次再来
      head.started = true
      if (n >= head.buf.length) { queue.shift(); continue }
      head.buf = head.buf.subarray(n)             // 短写：余量留队首，别截断这一帧
      return
    }
  }

  function drain(options: TxDrainOptions): boolean {
    for (;;) {
      pump(options.writeOnce)
      if (queue.length === 0) return true
      if (options.now() >= options.deadline) return false
      options.sleep(1)
    }
  }

  return {
    get size() { return queue.length },
    push,
    pump,
    drain,
    has: (entry: TxEntry) => queue.indexOf(entry) >= 0,
    clear: () => { queue.length = 0 },
  }
}
