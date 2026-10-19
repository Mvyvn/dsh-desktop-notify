// 灯运行时桥（主线程半区）—— 把"灯的全部时间驱动逻辑"关进独立 worker。
//
// 为什么需要它（用户任务4）：
//   · 灯相关阻塞不能破坏主插件：串口原生调用已经在 serial-worker 里，但**帧循环 + 渲染 +
//     自检/淡出**过去仍在主线程；主线程一卡（现场实测 30~196ms 停顿），灯动画就掉帧。
//   · 现在这些全部在 led-runtime-worker 里：主线程对灯只剩下"下发语义画面 + 读缓存状态"。
//     主线程每拍 applyScene 也**不会**变成消息风暴 —— 这里按签名合并，只保留最新画面。
//
// 生命周期：
//   · 懒启动：只有真的要碰灯（applyScene / setDriving(true) / beep / 自检 / 原始帧）时
//     才 spawn worker。功能一直关着 → 不占线程。
//   · worker error/exit → 状态置 error，5s 后自动重启（stop() 之后不再重启）。
//   · spawn 失败 / worker 起不来 → **回退 inline runtime**（同一份 led-runtime.ts 在主线程跑），
//     功能仍然可用，并打日志说明；`DSH_LED_RUNTIME=inline` 可强制这条路径。
//
// 主线程开销：
//   · status() = 读缓存快照（零分配，不碰串口、不碰 worker）；
//   · applyScene() = 一次签名比较，变了才 postMessage；
//   · tick() = no-op（帧由 worker 自己推）；
//   · shutdownFade() = 退出路径：发 shutdown + Atomics.wait ≤1200ms（**允许**，仅此一处）。

import { Worker } from 'node:worker_threads'

import { LED_IDLE_FRAME_MS, LED_FRAME_MS } from './led-timing.js'
import { OFF_SCENE, sceneSignature, type LedScene } from './led-scene.js'
import { BAUD_RATE, type Beep } from './led-protocol.js'
import type { SelfTestResult } from './led-render.js'
import type { FanoutStatus } from './serial-fanout.js'
import type { LinkStatus } from './serial-link.js'
import {
  createLedRuntime,
  type BeepStep, type LedRuntime, type LedRuntimeFrames, type LedRuntimeOptions, type LedRuntimeStatus,
} from './led-runtime.js'

/** worker 崩溃后的重启间隔（stop() 之后不再重启）。 */
export const RUNTIME_RESTART_MS = 5000
/** 退出路径最多等 worker 多久（同步淡出 ~120ms + 全黑帧 + close）。 */
export const SHUTDOWN_WAIT_MS = 1200

export interface LedRuntimeBridgeOptions extends LedRuntimeOptions {
  /** 线程标签（日志/诊断用）。 */
  readonly tag?: string
  /**
   * 额外的 workerData（诊断/测试用：例如 `{ serial: false }` 让 worker 不碰真串口，
   * 只跑协议与状态机）。生产不传。
   */
  readonly workerData?: Readonly<Record<string, unknown>>
}

/** 没连上时的空链路状态（缓存默认值；字段与 FanoutStatus 同形）。 */
function emptyLink(port: string, baud: number): FanoutStatus {
  const base: LinkStatus = {
    state: 'disabled',
    port,
    baud,
    lastWriteAt: 0,
    framesSent: 0,
    bytesSent: 0,
    dropped: 0,
    pending: 0,
    lastError: '',
    errorCode: '',
    retryInMs: 0,
    verified: false,
    reply: { verifies: 0, dropped: 0 },
    scene: 'off bright=0',
    pixels: [],
  }
  return { ...base, boards: [], boardCount: 0, verifiedCount: 0 }
}

function emptyFrames(frameMs: number): LedRuntimeFrames {
  return {
    targetFps: Math.round((1000 / frameMs) * 1000) / 1000,
    frameMs,
    rendered: 0,
    skipped: 0,
    fps: 0,
    idle: false,
    idleFrameMs: LED_IDLE_FRAME_MS,
    maxLateMs: 0,
    frameMaxMs: 0,
    // 还没收到 worker 的 status：按健康态报（worker 一上来就会用真实值覆盖）
    redundant: false,
    uniqueFpsTarget: Math.round((1000 / frameMs) * 1000) / 1000,
  }
}

function emptyStatus(port: string, baud: number, frameMs: number): LedRuntimeStatus {
  return {
    link: emptyLink(port, baud),
    frames: emptyFrames(frameMs),
    scene: OFF_SCENE,
    fading: false,
    selfTest: false,
  }
}

export function createLedRuntimeBridge(options: LedRuntimeBridgeOptions): LedRuntime {
  const log = options.log ?? (() => {})
  const frameMs = Number.isFinite(Number(options.frameMs)) && Number(options.frameMs) > 0
    ? Number(options.frameMs)
    : LED_FRAME_MS

  // 排障/对比：强制在主线程跑（等价于 2.2.0 的行为）
  if (process.env.DSH_LED_RUNTIME === 'inline') {
    log('[led] DSH_LED_RUNTIME=inline：灯运行时跑在主线程（排障模式）')
    return createLedRuntime(options)
  }

  let worker: Worker | null = null
  let inline: LedRuntime | null = null
  let started = false
  let stopped = false
  let ready = false
  /** 已经回退到 inline（不再尝试 worker）。 */
  let fellBack = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  let configPort = String(options.port ?? 'auto') || 'auto'
  let configBaud = Number.isFinite(Number(options.baud)) ? Number(options.baud) : BAUD_RATE
  let driving = false
  let lastScene: LedScene = OFF_SCENE
  /** 最近一次发给 worker 的画面签名（合并：同一画面不重复 post）。 */
  let lastSentScene = ''
  let cached = emptyStatus(configPort, configBaud, frameMs)
  let lastFadeAt = 0
  let lastFadeMs = 0
  /** 崩溃重启的退避截止时刻（Date.now 口径）。 */
  let respawnAt = 0

  const workerUrl = new URL('./led-runtime-worker.js', import.meta.url)

  function post(msg: any, transfer?: readonly any[]): boolean {
    const target = worker
    if (target === null) return false
    try {
      if (transfer === undefined) target.postMessage(msg)
      else target.postMessage(msg, transfer as any)
      return true
    } catch (e) {
      return false
    }
  }

  /** worker 起不来 / 崩溃后：把状态标成 error（绝不把异常抛给宿主）。 */
  function markError(reason: string): void {
    const link = cached.link
    cached = {
      ...cached,
      link: {
        ...link,
        state: 'error',
        verified: false,
        verifiedCount: 0,
        lastError: reason,
        errorCode: link.errorCode === '' ? 'write-failed' : link.errorCode,
      },
    }
  }

  function replayInline(runtime: LedRuntime): void {
    runtime.configure(configPort, configBaud)
    runtime.setDriving(driving)
    if (driving || lastScene.state !== 'off') runtime.applyScene(lastScene)
    if (started) runtime.start()
  }

  /** 回退到主线程运行时（保证功能可用；串口调用仍然走 serial-worker，不在主线程做原生）。 */
  function fallbackInline(reason: string): LedRuntime {
    if (inline === null) {
      log(`[led] ${reason} → 回退主线程运行时（灯功能保持可用）`)
      inline = createLedRuntime(options)
      replayInline(inline)
    }
    return inline
  }

  function onWorkerMessage(msg: any): void {
    if (!msg || typeof msg.t !== 'string') return
    if (msg.t === 'ready') {
      ready = true
      return
    }
    if (msg.t === 'status') {
      ready = true
      if (msg.link && msg.frames) {
        cached = {
          link: msg.link as FanoutStatus,
          frames: msg.frames as LedRuntimeFrames,
          scene: (msg.scene as LedScene) ?? cached.scene,
          fading: msg.fading === true,
          selfTest: msg.selfTest === true,
        }
            if (cached.fading) return
        // 淡出结束/被取消：让下一次 fadeOut() 重新按缓存判断
        lastFadeAt = 0
      }
      return
    }
    if (msg.t === 'log') {
      log(String(msg.line ?? ''))
      return
    }
    if (msg.t === 'error') {
      markError(String(msg.message ?? '灯运行时错误'))
      return
    }
  }

  function clearRestart(): void {
    if (restartTimer === null) return
    clearTimeout(restartTimer)
    restartTimer = null
  }

  function onWorkerGone(reason: string): void {
    if (worker === null) return
    const wasReady = ready
    worker = null
    ready = false
    if (stopped || fellBack) return
    log(`[led] ${reason}`)
    markError(reason)
    if (!wasReady) {
      // 从没就绪 = 启动就失败（模块加载/环境问题）：回退 inline，而不是每 5s 崩一次
      fellBack = true
      fallbackInline('LED worker 未能启动')
      return
    }
    if (restartTimer !== null) return
    // 退避窗口：这期间即使控制器每拍都在 setDriving/applyScene，也不允许提前重建线程
    respawnAt = Date.now() + RUNTIME_RESTART_MS
    log(`[led] ${Math.round(RUNTIME_RESTART_MS / 1000)}s 后自动重启灯运行时`)
    restartTimer = setTimeout(() => {
      restartTimer = null
      spawnWorker()
    }, RUNTIME_RESTART_MS)
    if (typeof (restartTimer as any).unref === 'function') (restartTimer as any).unref()
  }

  function spawnWorker(): void {
    if (worker !== null || stopped || fellBack) return
    respawnAt = 0
    let created: Worker
    try {
      // execArgv 传空：避免继承父进程的 --input-type/--eval 之类参数（worker 是文件，不是 eval）
      created = new Worker(workerUrl, {
        workerData: {
          ...(options.workerData ?? {}),
          port: configPort,
          baud: configBaud,
          frameMs,
          tag: options.tag ?? 'led',
        },
        execArgv: [],
      })
    } catch (e) {
      fellBack = true
      fallbackInline(`LED worker 启动失败：${(e as Error).message}`)
      return
    }
    worker = created
    // 不让这条线程把宿主/测试进程的事件循环钉住（消息照收，没别的事时进程可正常退出）
    created.unref()
    created.on('message', onWorkerMessage)
    created.on('error', (err) => onWorkerGone(`LED worker 异常：${err.message}`))
    created.on('exit', (code) => onWorkerGone(`LED worker 退出（code=${code}）`))
    ready = false
    // 启动时把当前状态补一遍（worker 在注册监听前的消息会被排队，不会丢）
    post({ t: 'config', port: configPort, baud: configBaud })
    post({ t: 'drive', on: driving })
    lastSentScene = sceneSignature(lastScene)
    post({ t: 'scene', scene: lastScene })
  }

  /** 懒启动：真的要碰灯了才 spawn（功能一直关着就不占线程）。 */
  function ensureWorker(): void {
    if (inline !== null || fellBack) return
    // 崩溃后的退避窗口内不重建（避免控制器每 1.5s 采样把"5s 退避"变成"立刻重启"）
    if (Date.now() < respawnAt) return
    if (worker === null && !stopped) spawnWorker()
  }

  return {
    start() {
      started = true
      if (inline !== null) inline.start()
    },
    stop() {
      stopped = true
      clearRestart()
      if (inline !== null) {
        inline.stop()
        return
      }
      const target = worker
      worker = null
      ready = false
      if (target === null) return
      // 退出路径：先同步淡出熄灯（WS2812 会锁存最后一帧），再收线程
      try {
        const sync = new SharedArrayBuffer(4)
        target.postMessage({ t: 'shutdown', sync })
        Atomics.wait(new Int32Array(sync), 0, 0, SHUTDOWN_WAIT_MS)
      } catch (e) { /* ignore */ }
      try { void target.terminate() } catch (e) { /* ignore */ }
    },
    configure(port, baud) {
      const nextPort = String(port ?? 'auto') || 'auto'
      const nextBaud = Number.isFinite(Number(baud)) ? Number(baud) : configBaud
      if (nextPort === configPort && nextBaud === configBaud) return
      configPort = nextPort
      configBaud = nextBaud
      const runtime = inline
      if (runtime !== null) { runtime.configure(nextPort, nextBaud); return }
      post({ t: 'config', port: configPort, baud: configBaud })
    },
    applyScene(scene) {
      lastScene = scene
      const runtime = inline
      if (runtime !== null) { runtime.applyScene(scene); return }
      const signature = sceneSignature(scene)
      ensureWorker()
      if (signature === lastSentScene) return
      if (post({ t: 'scene', scene })) lastSentScene = signature
    },
    setDriving(on) {
      if (on === driving) {
        if (on) ensureWorker()
        return
      }
      driving = on
      if (on) {
        // **关 → 开**：允许把当前画面重新下发。否则 applyScene 的签名去重会以为
        // "worker 已经有这个画面"而跳过 —— 但关闭期间 worker 已经淡出并关掉链路，
        // 它内部的 fanout.scene 也被淡出改写成暗/黑；重新握手后灯不会亮。
        // 这就是"关掉再打开，灯概率丢失"的根因（自检结束后回到的是黑画面）。
        lastSentScene = ''
        lastFadeAt = 0
      }
      const runtime = inline
      if (runtime !== null) { runtime.setDriving(on); return }
      if (on) ensureWorker()
      post({ t: 'drive', on })
    },
    holdContinuous(ms) {
      const runtime = inline
      if (runtime !== null) { runtime.holdContinuous(ms); return }
      post({ t: 'hold', ms })
    },
    startSelfTest(result: SelfTestResult, totalMs = 2000, brightness = 255) {
      const runtime = inline
      if (runtime !== null) { runtime.startSelfTest(result, totalMs, brightness); return }
      ensureWorker()
      post({ t: 'selfTest', result, totalMs, brightness })
    },
    beep(beep: Beep) {
      const runtime = inline
      if (runtime !== null) return runtime.beep(beep)
      ensureWorker()
      return post({ t: 'beep', beep }) && cached.link.verified
    },
    beepPattern(pattern: readonly BeepStep[]) {
      const runtime = inline
      if (runtime !== null) return runtime.beepPattern(pattern)
      ensureWorker()
      return post({ t: 'beepPattern', steps: pattern }) && cached.link.verified
    },
    rawFrame(frame) {
      const runtime = inline
      if (runtime !== null) return runtime.rawFrame(frame)
      ensureWorker()
      // 转移一块**独占**内存（不能转移共享池里的 Buffer 视图，见 serial-win32 的同款说明）
      const copy = new Uint8Array(frame.length)
      copy.set(frame)
      return post({ t: 'raw', data: copy }, [copy.buffer]) && cached.link.verified
    },
    fadeOut(scene, durationMs = 250) {
      const runtime = inline
      if (runtime !== null) return runtime.fadeOut(scene, durationMs)
      // 没有 worker = 从来没碰过灯 → 没有可淡出的设备
      if (worker === null) return false
      // 链路没握手（已经关掉/从没连上）就没有可淡出的像素：必须返回 false，
      // 让控制器走 blackout 收尾。旧实现只要"消息投递成功"就返回 true，于是关闭态
      // 每一拍都被告知"还在淡出"，blackout 永远不执行。
      if (cached.link.verified !== true) return false
      const duration = Math.max(1, Math.trunc(durationMs) || 250)
      // 已在淡出窗口内：不重复下发（主线程每 1.5s 采样会再问一次）
      if (lastFadeAt !== 0 && Date.now() - lastFadeAt < lastFadeMs + 1000) return true
      if (cached.fading) return true
      lastFadeAt = Date.now()
      lastFadeMs = duration
      return post({ t: 'fadeOut', scene, durationMs: duration })
    },
    flush(scene) {
      const runtime = inline
      if (runtime !== null) return scene === undefined ? runtime.flush() : runtime.flush(scene)
      if (worker === null) return false
      return post({ t: 'flush', scene })
    },
    close() {
      const runtime = inline
      if (runtime !== null) { runtime.close(); return }
      post({ t: 'close' })
    },
    shutdownFade() {
      const runtime = inline
      if (runtime !== null) { runtime.shutdownFade(); return }
      const target = worker
      if (target === null) return
      try {
        const sync = new SharedArrayBuffer(4)
        target.postMessage({ t: 'shutdown', sync })
        // **退出路径**：唯一允许主线程同步等待的地方（正常运行路径绝不允许）
        Atomics.wait(new Int32Array(sync), 0, 0, SHUTDOWN_WAIT_MS)
      } catch (e) { /* ignore */ }
      stopped = true
      clearRestart()
      worker = null
      ready = false
      cached = {
        ...emptyStatus(configPort, configBaud, frameMs),
        link: { ...emptyLink(configPort, configBaud), state: 'disabled' },
      }
        try { void target.terminate() } catch (e) { /* ignore */ }
    },
    tick() {
      // worker 模式下帧全部由它自己推：主线程这里什么都不做（采样之外的额外开销 = 0）
      if (inline !== null) inline.tick()
    },
    status() {
      return cached
    },
  }
}
