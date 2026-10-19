// 多灯扇出层 —— 一份画面同时驱动所有应答握手的 AI Status Lights
//
// 为什么单独一层：serial-link.ts 管的是"**一条**串口从握手到重连"（单句柄；auto 模式
// 也只会挑最先应答的那一块）。而用户要的是：auto 模式 = 同时驱动所有插着的灯；
// 手动填 COMx = 只驱动那一块。所以这一层只做三件事，不碰任何串口/协议细节：
//   1. **发现**：auto 模式下枚举端口，按 autoPortOrder 给每个候选建一条**固定端口**的子链路，
//      各自独立握手；应答的都保留（多灯全要），不应答/打不开的关掉并冷却；
//   2. **广播**：scene / override / flush / beep / rawFrame 原样发给每个子链路；
//   3. **聚合**：把 N 条子链路的状态合成**一个** LinkStatus 给控制器（接口与 SerialLink 同形）。
//
// 故障隔离是子链路自带的：端口固定时 createSerialLink 会自己直连、退避重连，
// 一块掉线不会影响另一块；这里**不替子链路重连**，也不共享句柄。

import { BAUD_RATE, type Pixels } from './led-protocol.js'
import { OFF_SCENE, type LedScene } from './led-scene.js'
import { monotonicNow } from './led-timing.js'
import {
  createSerialLink, autoPortOrder,
  type LinkErrorCode, type LinkPortInfo, type LinkQuality, type LinkState, type LinkStatus, type SerialLink, type SerialLinkOptions,
} from './serial-link.js'

/** auto 模式重新枚举的周期：插拔后最多这么久就能把新灯挂上。 */
export const DISCOVER_EVERY_MS = 15_000
/** 候选口"不应答 / 打不开"后的冷却：避免每轮都去砸一个不是板子的口。 */
export const REJECT_COOLDOWN_MS = 30_000
/** 枚举卡死的兜底：超过这么久没返回就作废本轮（Windows 枚举偶尔卡在设备栈里）。 */
const DISCOVER_TIMEOUT_MS = 5000

/**
 * 聚合状态里的一块板子（诊断/设置页用）。
 * 只给 `status()` 的扩展字段用；控制器原来的 `status().verified/state/errorCode`
 * 语义不变，所以老调用方不需要改。
 */
export interface FanoutBoard {
  readonly port: string
  readonly verified: boolean
  readonly state: LinkState
}

/**
 * 扇出层聚合后的链路状态：**就是 LinkStatus** + 板子明细。
 * 额外字段保持可诊断，但不改变既有字段含义（`verified` = 至少一块握手成功）。
 */
export interface FanoutStatus extends LinkStatus {
  readonly boards: readonly FanoutBoard[]
  /** 当前挂着的板子数（含正在重连的；不等于 verified 的数量）。 */
  readonly boardCount: number
  /** 当前握手成功的板子数。 */
  readonly verifiedCount: number
}

export interface SerialFanoutOptions extends SerialLinkOptions {
  /** auto 模式重新枚举周期（默认 DISCOVER_EVERY_MS）。 */
  readonly discoverEveryMs?: number
  /** 不应答端口的冷却时长（默认 REJECT_COOLDOWN_MS）。 */
  readonly rejectCooldownMs?: number
}

/**
 * 对外接口与 SerialLink 同形（多出来的只有 `status()` 的板子明细）。
 * 控制器可以把它当 SerialLink 用。
 */
export interface SerialFanout extends SerialLink {
  status(): FanoutStatus
}

/** 一条子链路：`probing` = auto 发现时建的候选，握手成功前失败就关掉（不无限重试）。 */
interface ChildLink {
  readonly link: SerialLink
  probing: boolean
}

/**
 * 端口配置解析：`auto` 或**英文逗号分隔的多个端口**。
 *
 * 规则（用户指定）：
 *   · `auto` / 空串 → 自动模式（驱动所有应答的灯）；
 *   · `COM5,COM9` / `/dev/ttyUSB0,/dev/ttyUSB1` → 手动模式，只驱动列出的口；
 *   · 只要出现 `auto`（大小写不敏感，例如 `auto,COM5`）→ **整体按 auto**，其余项因为
 *     "auto 已经包含它们"直接忽略；
 *   · 空项/非法项丢弃（避免把 `COM5,,foo` 这种输入变成死端口）；全非法 → 退回 auto，
 *     宁可自动发现，也不要因为手滑把灯永久钉在一个不存在的口上。
 */
export interface PortSpec {
  readonly auto: boolean
  /** 手动模式下的端口列表（已去重、保持书写顺序）；auto 时为空数组。 */
  readonly ports: readonly string[]
}

const PORT_NAME_RE = /^(COM\d+|\/dev\/[A-Za-z0-9._-]+)$/i

/** 把配置里的端口字符串解析成 {@link PortSpec}（纯函数，单测直接穷举）。 */
export function parsePortSpec(raw: unknown): PortSpec {
  const text = String(raw ?? '').trim()
  if (text === '') return { auto: true, ports: [] }
  const tokens = text.split(',').map((token) => token.trim()).filter((token) => token !== '')
  if (tokens.some((token) => token.toLowerCase() === 'auto')) return { auto: true, ports: [] }
  const ports: string[] = []
  for (const token of tokens) {
    if (!PORT_NAME_RE.test(token)) continue
    if (!ports.includes(token)) ports.push(token)
  }
  if (ports.length === 0) return { auto: true, ports: [] }
  return { auto: false, ports }
}

/** 配置签名：值没变就不重建链路。 */
function specKey(spec: PortSpec): string {
  return spec.auto ? 'auto' : spec.ports.join(',')
}

/** 聚合 state 时"谁更差"：有 ready 时另算，其余取最差（error > opening > verifying > idle）。 */
const STATE_SEVERITY: Record<LinkState, number> = {
  disabled: 0, idle: 1, verifying: 2, opening: 3, error: 4, ready: 5,
}

export function createSerialFanout(options: SerialFanoutOptions): SerialFanout {
  const now = options.now ?? monotonicNow
  const log = options.log ?? (() => {})
  const discoverEveryMs = Math.max(1000, Math.trunc(options.discoverEveryMs ?? DISCOVER_EVERY_MS) || DISCOVER_EVERY_MS)
  const rejectCooldownMs = Math.max(1000, Math.trunc(options.rejectCooldownMs ?? REJECT_COOLDOWN_MS) || REJECT_COOLDOWN_MS)

  /** 端口模式：auto（发现所有灯）或**多个固定端口**（逗号分隔）；'' 归一成 auto。 */
  let spec = parsePortSpec(options.port)
  let baud = Math.max(1200, Math.trunc(options.baud ?? BAUD_RATE) || BAUD_RATE)
  /** 共享画面/覆盖：新加入的子链路也要立刻拿到它们，否则新插的灯会先黑一下。 */
  let scene: LedScene = OFF_SCENE
  let override: ((nowMs: number) => Pixels) | null = null
  /** 端口 → 子链路。Map 的插入顺序 = 发现顺序（autoPortOrder 排序后的）。 */
  const children = new Map<string, ChildLink>()
  /** 被拒绝（无应答 / 打不开）的端口 → 冷却截止时刻。 */
  const rejectedUntil = new Map<string, number>()
  /** 最近一次枚举的 start 时刻（节流：不是状态源，只决定"下一轮什么时候枚举"）。 */
  let lastDiscoverAt = 0
  let discovering = false
  let discoverStartedAt = 0
  /**
   * 异步代次（与 serial-link 的 gen/openToken 同一思路）：
   * configure/close 之后，在飞的枚举或打开结果一律作废 —— 否则旧结果会把已经
   * 关掉的端口重新挂上，或者用一个过期句柄去握手。
   */
  let gen = 0
  let discoverToken = 0
  /** close() 之后到下一次 tick 之间状态为 disabled；tick 时按当前模式重新开始。 */
  let closed = false
  /** 自动模式没有子链路时的"为什么没灯"（给 status() 说人话用）。 */
  let discoveryNotice: { message: string; code: LinkErrorCode } | null = null

  function isAuto(): boolean {
    return spec.auto
  }

  /** 给日志/状态用的模式文本。 */
  function modeLabel(): string {
    return spec.auto ? 'auto' : spec.ports.join(', ')
  }

  function isCooling(path: string, t: number): boolean {
    const until = rejectedUntil.get(path)
    if (until === undefined) return false
    if (until <= t) { rejectedUntil.delete(path); return false }
    return true
  }

  /** 建一条固定端口的子链路（它自己直连/重试；不参与 auto 枚举）。 */
  function makeChild(port: string, probing: boolean): ChildLink {
    const link = createSerialLink({
      port,
      baud,
      open: options.open,
      list: options.list,
      now,
      log,
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
      ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
      ...(options.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: options.verifyTimeoutMs } : {}),
    })
    // 新灯入列时立刻同步"当前要显示什么"：否则它要等到下一次 controller 采样才亮，
    // 而且覆盖渲染（自检动画）期间插上的灯会先显示常规画面。
    link.applyScene(scene)
    if (override !== null) link.setOverride(override)
    return { link, probing }
  }

  function tickChild(child: ChildLink): void {
    try {
      child.link.tick()
    } catch (e) {
      // 单个子链路的异常不能拖垮其它灯：具体故障由子链路自己的 fail()/重连处理。
      log(`[led] 子链路 tick 异常：${(e as Error).message}`)
    }
  }

  /** 广播一个调用（失败隔离：一条子链路抛异常不影响其它灯）。 */
  function broadcast(fn: (link: SerialLink) => boolean | void): boolean {
    let ok = false
    // 快照：回调里可能关掉子链路（close/configure），直接迭代 Map 会踩到已删除项。
    for (const child of Array.from(children.values())) {
      try {
        if (fn(child.link) === true) ok = true
      } catch (e) {
        log(`[led] 子链路广播失败：${(e as Error).message}`)
      }
    }
    return ok
  }

  /**
   * 清掉握手失败的**候选**子链路并冷却它。
   * 只处理 probing 的（auto 发现时建的）：已经握过手又掉线的板子交给子链路自己重连，
   * 不能因为一次断开就把它从多灯列表里删掉 —— 那会变成"拔一下就得等下一轮枚举"。
   */
  function pruneProbes(t: number): void {
    // 直接迭代（删除当前项对 Map 迭代器是安全的）：这一函数每拍跑两次，
    // 稳态下它只应该做"跳过已握手的子链路"这一件事，不给 240fps 路径添分配。
    for (const [path, child] of children) {
      if (!child.probing) continue
      const st = child.link.status()
      if (st.verified) { child.probing = false; continue }
      if (st.state !== 'error' && st.state !== 'disabled') continue
      const code: LinkErrorCode = st.errorCode !== '' ? st.errorCode : 'verify-timeout'
      const message = st.lastError !== '' ? st.lastError : `串口 ${path} 没有回应验证帧（可能不是 AI Status Lights）`
      child.link.close()
      children.delete(path)
      rejectedUntil.set(path, t + rejectCooldownMs)
      if (children.size === 0) discoveryNotice = { message, code }
      log(`[led] 串口 ${path} 未通过握手 → 关闭并冷却 ${Math.round(rejectCooldownMs / 1000)}s（${code}）`)
    }
  }

  /**
   * 周期枚举：把**新插入**的灯挂上。
   * 每轮给每个候选建一条子链路（各自 1500ms 验证窗口），而不是"挑一个试"——
   * 多灯场景下"挑"只能挑到一块；这里要的是"谁应答就留谁"。
   */
  function maybeDiscover(t: number): void {
    if (discovering) {
      // 枚举卡死兜底：清了标记才能在下一轮重来（正常枚举几毫秒）。
      if (discoverStartedAt > 0 && t - discoverStartedAt > DISCOVER_TIMEOUT_MS) {
        discovering = false
        discoverToken += 1
        discoverStartedAt = 0
        log('[led] 串口枚举超时，本轮作废')
      }
      return
    }
    if (lastDiscoverAt !== 0 && t - lastDiscoverAt < discoverEveryMs) return
    lastDiscoverAt = t
    discovering = true
    discoverStartedAt = t
    const token = (discoverToken += 1)
    const myGen = gen
    // 用 Promise.resolve 包一层：list() 同步抛异常时也走 catch，不让它从 tick() 里炸出去。
    void Promise.resolve()
      .then(() => options.list())
      .then((ports) => {
        if (myGen !== gen || token !== discoverToken) return   // configure/close 之后的迟到结果
        addCandidates(Array.from(ports), t)
      })
      .catch((e: unknown) => {
        if (myGen !== gen || token !== discoverToken) return
        const message = `串口枚举失败：${(e as Error).message}`
        log(`[led] ${message}`)
        if (children.size === 0) discoveryNotice = { message, code: 'no-device' }
      })
      .finally(() => {
        // 只有"当代"枚举才有资格清标记（同 serial-link 的 openToken 思路）。
        if (token === discoverToken) discovering = false
      })
  }

  function addCandidates(ports: readonly LinkPortInfo[], t: number): void {
    const order = autoPortOrder(ports)
    const added: string[] = []
    for (const path of order) {
      if (children.has(path)) continue        // 已挂着（可能正在重连）→ 不再建第二条
      if (isCooling(path, t)) continue        // 刚拒绝过的口：冷却期内不试
      children.set(path, makeChild(path, true))
      added.push(path)
    }
    if (added.length > 0) log(`[led] 串口发现：新增候选 ${added.join(', ')}（应答的保留，其余冷却）`)
    // 没有任何子链路时，给 status() 一个可操作的结论（设置页/日志要能回答"为什么没灯"）。
    if (children.size === 0) {
      discoveryNotice = ports.length === 0
        ? { message: '没有找到任何串口设备', code: 'no-device' }
        : { message: '所有串口都没有回应验证帧（板子可能没插好 / 没烧录 / 口被别的程序占用）', code: 'no-device' }
    }
  }

  /**
   * 手动端口模式：只为列出的端口建子链路（失败由子链路自己退避重连，不做发现）。
   * 多端口时**新增的不关旧的**；configure 改列表时会先整体关闭再重建。
   */
  function ensureManualChildren(): void {
    let added = 0
    for (const port of spec.ports) {
      if (children.has(port)) continue
      children.set(port, makeChild(port, false))
      added += 1
    }
    if (added > 0) log(`[led] 手动端口：只驱动 ${spec.ports.join(', ')}`)
  }

  function closeChildren(why: string): void {
    const count = children.size
    for (const child of children.values()) {
      try { child.link.close() } catch (e) { /* ignore */ }
    }
    children.clear()
    if (count > 0) log(`[led] 多灯链路已关闭（${why}，${count} 块）`)
  }

  /** 关掉不在 `keep` 里的子链路（手动端口改列表时，保留没变的端口，避免不必要的重连闪灯）。 */
  function closeNotIn(keep: readonly string[]): void {
    for (const [port, child] of [...children]) {
      if (keep.includes(port)) continue
      try { child.link.close() } catch (e) { /* ignore */ }
      children.delete(port)
    }
  }

  const api: SerialFanout = {
    configure(nextPort, nextBaud) {
      const next = parsePortSpec(nextPort)
      const b = Math.max(1200, Math.trunc(nextBaud ?? baud) || BAUD_RATE)
      if (specKey(next) === specKey(spec) && b === baud) return
      log(`[led] 多灯配置变化：${modeLabel()}@${baud} → ${next.auto ? 'auto' : next.ports.join(', ')}@${b}`)
      // 代次自增放在最前面：让在飞的枚举结果与打开句柄全部作废（否则迟到的结果会把
      // 旧端口的子链路装回来）。
      gen += 1
      discoverToken += 1
      discovering = false
      discoverStartedAt = 0
      // 模式切换（auto↔手动）或波特率变化必须整体重建；手动端口之间改列表则只动增删的，
      // 保留的口不重连（否则改一个端口会让所有灯闪一下）。
      if (next.auto !== spec.auto || b !== baud) closeChildren('配置变化')
      else if (!next.auto) closeNotIn(next.ports)
      spec = next
      baud = b
      lastDiscoverAt = 0
      discoveryNotice = null
      rejectedUntil.clear()
      closed = false
      // 手动端口的子链路由下一拍 tick() 建（与旧实现一致：configure 只改配置，
      // 不在调用栈里同步开串口 —— 也让"configure 后立即看 boardCount=0"的语义成立）。
    },
    applyScene(next) {
      scene = next
      broadcast((link) => link.applyScene(next))
    },
    tick() {
      if (closed) {
        // 与 createSerialLink 一致：close() 不是永久死亡。controller 在"重新启用"时
        // 会继续调 tick()，这里按当前模式重新开始发现（否则关一次灯就再也连不上了）。
        closed = false
        lastDiscoverAt = 0
        discoveryNotice = null
        rejectedUntil.clear()
      }
      const t = now()
      if (isAuto()) {
        pruneProbes(t)          // 先清掉上一拍就已失败的候选（别让它再退避重试一次）
        maybeDiscover(t)
      } else {
        ensureManualChildren()
      }
      // 子链路 tick 不会改这张表（发现/清理都在循环外），直接迭代即可（热路径不分配）。
      for (const child of children.values()) tickChild(child)
      // 本拍 tick 之后才进入 error 的候选也立刻清掉：否则下一拍它会先重试一次。
      if (isAuto()) pruneProbes(now())
    },
    needsFrames() {
      // 枚举在飞时必须保持连续帧：结果回来后才建子链路，下一拍才轮到打开/握手。
      if (discovering) return true
      // 每块板子各自判断（握手窗口、交叉渐变、自检覆盖、running/waiting/error）。
      // 一块在动就要连续帧，另一块稳态跟着多跑几帧无所谓（同一份画面，成本只是多写几帧）。
      for (const child of children.values()) {
        if (child.link.needsFrames !== undefined) {
          if (child.link.needsFrames()) return true
        } else {
          // 子链路没有 needsFrames（旧实现/替身）时的保守回退：握手窗口必须连续推进。
          const st = child.link.status()
          if (st.state === 'opening' || st.state === 'verifying') return true
        }
      }
      return false
    },
    beep(b) {
      return broadcast((link) => link.beep(b))
    },
    rawFrame(frame) {
      return broadcast((link) => link.rawFrame(frame))
    },
    setOverride(fn) {
      override = fn
      broadcast((link) => link.setOverride(fn))
    },
    restartFade() {
      broadcast((link) => link.restartFade())
    },
    flush(next) {
      if (next !== undefined) scene = next
      return broadcast((link) => link.flush(next))
    },
    reap() {
      broadcast((link) => link.reap())
    },
    verify() {
      return broadcast((link) => link.verify())
    },
    status() {
      const t = now()
      const entries = Array.from(children.entries()).map(([port, child]) => ({ port, status: child.link.status() }))
      const ready = entries.filter((e) => e.status.verified)
      const readyCount = ready.length

      let state: LinkState
      if (closed) state = 'disabled'
      else if (readyCount > 0) state = 'ready'
      else if (entries.length > 0) {
        state = 'idle'
        for (const e of entries) {
          if (STATE_SEVERITY[e.status.state] > STATE_SEVERITY[state]) state = e.status.state
        }
      } else if (isAuto() && discovering) state = 'opening'
      else if (isAuto() && discoveryNotice !== null) state = 'error'
      else state = 'idle'

      let framesSent = 0
      let bytesSent = 0
      let dropped = 0
      let pending = 0
      let verifies = 0
      let replyDropped = 0
      let lastWriteAt = 0
      let retryInMs = 0
      let lastError = ''
      let errorCode: LinkErrorCode = ''
      /**
       * 自适应冗余的聚合：多灯里**任何一块**处于劣化/冗余，都要按冗余处理
       * （运行时会据此把全局唯一帧率降到 120fps，避免双发把串口灌爆）。
       */
      let quality: LinkQuality = 'ok'
      let redundancy = false
      for (const e of entries) {
        const s = e.status
        framesSent += s.framesSent
        bytesSent += s.bytesSent
        dropped += s.dropped
        pending += s.pending
        verifies += s.reply.verifies
        replyDropped += s.reply.dropped
        if (s.lastWriteAt > lastWriteAt) lastWriteAt = s.lastWriteAt
        if (s.quality === 'bad') quality = 'bad'
        else if (s.quality === 'suspect' && quality === 'ok') quality = 'suspect'
        if (s.redundancy === true) redundancy = true
        if (readyCount === 0) {
          // 只有"一块都没连上"时才把错误冒泡给控制器；只要还有灯在正常显示，
          // 单块掉线的错误不该把整体状态打成 error（否则 UI 会误报）。
          if (s.lastError !== '' || s.errorCode !== '') {
            lastError = s.lastError
            errorCode = s.errorCode
          }
          if (s.retryInMs > 0 && (retryInMs === 0 || s.retryInMs < retryInMs)) retryInMs = s.retryInMs
        }
      }
      if (readyCount === 0 && entries.length === 0) {
        if (discoveryNotice !== null) {
          lastError = discoveryNotice.message
          errorCode = discoveryNotice.code
        }
        if (isAuto() && lastDiscoverAt > 0) retryInMs = Math.max(0, lastDiscoverAt + discoverEveryMs - t)
      }

      const ports = entries.map((e) => (e.status.port !== '' ? e.status.port : e.port))
      const firstReady = ready[0]
      let pixels: Pixels = []
      for (const e of ready) {
        if (e.status.pixels.length > 0) { pixels = e.status.pixels; break }
      }
      return {
        state,
        port: ports.length > 0 ? ports.join(', ') : modeLabel(),
        baud,
        lastWriteAt,
        framesSent,
        bytesSent,
        dropped,
        pending,
        lastError,
        errorCode,
        retryInMs,
        verified: readyCount > 0,
        // 回包统计求和（诊断用；各子链路的扫描器互不影响）。
        reply: { verifies, dropped: replyDropped },
        scene: firstReady !== undefined
          ? firstReady.status.scene
          : `${scene.state}${scene.flags ? '+' + scene.flags : ''} bright=${scene.brightness}`,
        pixels,
        boards: entries.map((e) => ({
          port: e.status.port !== '' ? e.status.port : e.port,
          verified: e.status.verified,
          state: e.status.state,
        })),
        boardCount: entries.length,
        verifiedCount: readyCount,
        quality,
        redundancy,
      }
    },
    close() {
      gen += 1
      discoverToken += 1
      discovering = false
      discoverStartedAt = 0
      closed = true
      closeChildren('关闭')
      rejectedUntil.clear()
      discoveryNotice = null
    },
  }

  return api
}
