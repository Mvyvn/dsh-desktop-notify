// 对外推送 API（供其它插件调用）—— 类型化后的通知入参/出参
//
// 经 Cordis 服务暴露：其它插件 `ctx.get('desktopNotify')` 取用。
//   push(item)        走聚焦门控（按会话：你正在看的那个会话会被静默）
//   pushAlways(item)  绕过聚焦门控，始终推送
//   notify(item)      与 push 同路径，但返回结构化结果（是否入队 / 是否被静默 / 原因）
//
// item 载荷：{ title, message?, urgency?, sessionId?, click? }
//   sessionId —— **只用于会话级门控**（可传会话对象、id 或它们的数组）；
//   click     —— **只决定点击后做什么**，四态：
//                 不传 / null            → 不可点击，点了不跳转（默认）
//                 { type:'session', sessionId } → 跳到该会话
//                 { type:'page', page:'settings-plugins'|'plugins' } → 跳到内置页面
//                 { type:'url', url:'https://…' } → 打开外部地址
//   兼容旧字段：`url: 'https://…'` 等价于 `click: { type:'url', url }`。
//
// ⚠️ push 返回 true 的含义是"**真的入队了**"：被门控静默、命中同文案去重、
// 或当前平台没有通知后端时都返回 false。

import { clickNone, clickUrl, type ClickTarget, type PageTarget } from './protocol.js'
import { sessionIdList, type FocusGate } from './gate.js'
import { truncateText } from './text.js'
import type { NotificationItem, Urgency } from './notify.js'
import type { LedApi } from './led-api.js'

const URGENCIES: readonly string[] = ['low', 'normal', 'critical']
const MAX_TITLE = 160
const MAX_MESSAGE = 400
const PAGE_TARGETS: readonly string[] = ['settings-plugins', 'plugins']

/**
 * 对外 API 的**基线协议版本**。
 *
 * 约定（给未来留扩展空间，同时保证老调用方不被破坏）：
 *   1. 载荷里的**未知字段一律忽略**（不报错、不猜测）——新增可选字段不会破坏老调用方；
 *   2. 载荷里可以带 `v: '1.0.0'` 声明协议版本；不认识的**更高主版本**不会中断推送，
 *      但会在结果里回带 `unsupportedVersion: true`，调用方可据此降级；
 *   3. 结果对象的字段**只增不改**：现有 push/pushAlways/notify 的返回语义保持不变；
 *   4. `capabilities` 让调用方探测能力，而不是靠版本号猜。新增能力只往数组里加。
 *
 * ⚠️ 本分支（feat/led-serial-ticker）把版本提到 `1.1.0-led.1`：**主版本仍是 1**，
 * 因此老调用方的 `unsupportedVersion` 判定不受影响；`-led.1` 后缀只用来标明
 * "这份构建带着一条不并入主线的串口灯带协议"。串口协议自己另有一个特殊版本号
 * （见 led-api.ts 的 LED_API_VERSION）。
 */
export const NOTIFY_API_VERSION = '1.1.0-led.1'

/** 本版本提供的能力清单（只增不减）。 */
export const NOTIFY_API_CAPABILITIES: readonly string[] = [
  'push',              // 走聚焦门控的推送
  'pushAlways',        // 绕过门控的强制推送
  'notify',            // 带结构化结果的推送
  'click.session',     // click: { type: 'session', sessionId }
  'click.page',        // click: { type: 'page', page }
  'click.url',         // click: { type: 'url', url }
  'click.legacy-url',  // 兼容旧字段 url: 'https://…'
  'web-notification',  // 浏览器通知渠道（含 shown 回执与原生兜底）
  'dialog.four-state', // 诊断端点 /dnotify/status
  // ---- 本分支新增：USB 串口 LED 状态灯 ----
  'led.serial',        // 串口通道（`desktopNotify.led`）
  'led.scene',         // 语义状态：running/waiting/done/error（绿/黄/白/红）
  'led.effect',        // 显式效果（流动/呼吸/闪烁/彩虹…）
  'led.overlay',       // 带 TTL 的瞬态覆盖层（固件自己到期回落）
  'led.brightness',    // 亮度
  'led.progress',      // 进度条
  'led.frame',         // 白名单原始帧
  'led.ack',           // 解除"自上次聚焦未回来"的提醒闩
  'led.status',        // 链路与判定状态
]

/** 归一后的通知载荷。 */
export interface NormalizedNotifyItem {
  readonly title: string
  readonly message: string
  readonly urgency: Urgency
  readonly sessionIds: readonly string[]
  readonly click: ClickTarget
}

/** 推送结果明细。 */
export interface NotifyOutcome {
  readonly ok: boolean
  readonly queued: boolean
  readonly silenced: boolean
  /** '' | 'invalid-payload' | 'silenced' | 'duplicate' | 'dropped' */
  readonly reason: string
  /** 回带本次请求声明的协议版本（没声明就是当前版本）。 */
  readonly apiVersion: string
  /** 请求声明的版本高于本插件认识的主版本时为 true（仍然尽力推送）。 */
  readonly unsupportedVersion: boolean
}

export interface NotifyApi {
  /** 本插件实现的协议版本（本分支：1.1.0-led.1）。 */
  readonly apiVersion: string
  /** 能力清单，供调用方探测。 */
  readonly capabilities: readonly string[]
  push(item: unknown): boolean
  pushAlways(item: unknown): boolean
  notify(item: unknown): NotifyOutcome
  /**
   * 串口 LED 控制面（本分支专属）。灯带功能未启用/平台不支持时为 null——
   * 调用方**必须判空**，不要假设它一定在。
   */
  readonly led: LedApi | null
}

/** 宿主内部投递回调签名。 */
export interface NotifyDeps {
  notify(
    title: string,
    message: string,
    urgency: Urgency,
    sessionIds: readonly string[],
    options: { click: ClickTarget },
  ): { queued?: boolean; silenced?: boolean; reason?: string } | undefined
  enqueue(item: NotificationItem): boolean
  /** LED 控制面（可缺省：没有灯带功能的构建里就是 undefined）。 */
  led?: () => LedApi | null
}

/**
 * 解析 click 字段：接受 ClickTarget 形状、null/undefined（→ none）、以及旧字段 url。
 * 非法形状一律**当作 none**（而不是猜测意图）。
 */
function parseClick(raw: unknown, legacyUrl: unknown): ClickTarget {
  if (raw !== undefined && raw !== null && typeof raw === 'object') {
    const candidate = raw as { type?: unknown; sessionId?: unknown; page?: unknown; url?: unknown }
    switch (candidate.type) {
      case 'none':
        return clickNone()
      case 'session':
        return typeof candidate.sessionId === 'string' && candidate.sessionId !== ''
          ? { type: 'session', sessionId: candidate.sessionId }
          : clickNone()
      case 'page':
        return typeof candidate.page === 'string' && PAGE_TARGETS.includes(candidate.page)
          ? { type: 'page', page: candidate.page as PageTarget }
          : clickNone()
      case 'url':
        return typeof candidate.url === 'string' ? clickUrl(candidate.url) ?? clickNone() : clickNone()
      default:
        return clickNone()
    }
  }
  // 兼容旧字段 url：只有 http/https 才认
  if (typeof legacyUrl === 'string') return clickUrl(legacyUrl) ?? clickNone()
  return clickNone()
}

/**
 * 归一外部传入的通知载荷；标题为空视为无效（返回 null，不推送）。
 */
export function normalizeNotifyItem(item: unknown): NormalizedNotifyItem | null {
  if (item === null || typeof item !== 'object') return null
  const fields = item as { title?: unknown; message?: unknown; urgency?: unknown; sessionId?: unknown; click?: unknown; url?: unknown }
  const title = truncateText(String(fields.title ?? '').replace(/\s+/g, ' ').trim(), MAX_TITLE)
  if (title === '') return null
  const message = truncateText(String(fields.message ?? '').replace(/\s+/g, ' ').trim(), MAX_MESSAGE)
  const urgency: Urgency = typeof fields.urgency === 'string' && URGENCIES.includes(fields.urgency)
    ? (fields.urgency as Urgency)
    : 'normal'
  return {
    title,
    message,
    urgency,
    sessionIds: sessionIdList(fields.sessionId),
    click: parseClick(fields.click, fields.url),
  }
}

export function createNotifyApi(deps: NotifyDeps): NotifyApi {
  const { notify, enqueue } = deps

  /** 请求声明的协议版本：缺省视为当前版本；只比较主版本（未来次版本应保持兼容）。 */
  function declaredVersion(item: unknown): { version: string; unsupported: boolean } {
    const raw = item && typeof item === 'object' ? (item as { v?: unknown; apiVersion?: unknown }) : {}
    const text = typeof raw.v === 'string' ? raw.v : (typeof raw.apiVersion === 'string' ? raw.apiVersion : '')
    if (!text) return { version: NOTIFY_API_VERSION, unsupported: false }
    const major = Number(String(text).split('.')[0])
    const ownMajor = Number(NOTIFY_API_VERSION.split('.')[0])
    return { version: text, unsupported: Number.isFinite(major) && major > ownMajor }
  }

  function deliver(item: unknown): NotifyOutcome {
    const declared = declaredVersion(item)
    const normalized = normalizeNotifyItem(item)
    if (normalized === null) {
      return {
        ok: false, queued: false, silenced: false, reason: 'invalid-payload',
        apiVersion: declared.version, unsupportedVersion: declared.unsupported,
      }
    }
    const result = notify(
      normalized.title,
      normalized.message,
      normalized.urgency,
      normalized.sessionIds,
      { click: normalized.click },
    ) ?? {}
    const queued = result.queued === true
    return {
      ok: true,
      queued,
      silenced: result.silenced === true,
      reason: queued ? '' : (result.reason ?? 'dropped'),
      apiVersion: declared.version,
      unsupportedVersion: declared.unsupported,
    }
  }

  return {
    apiVersion: NOTIFY_API_VERSION,
    capabilities: NOTIFY_API_CAPABILITIES,
    push(item: unknown): boolean {
      return deliver(item).queued
    },
    pushAlways(item: unknown): boolean {
      const normalized = normalizeNotifyItem(item)
      if (normalized === null) return false
      return enqueue({
        title: normalized.title,
        message: normalized.message,
        urgency: normalized.urgency,
        click: normalized.click,
      }) === true
    },
    notify(item: unknown): NotifyOutcome {
      return deliver(item)
    },
    get led(): LedApi | null {
      // 每次读都现问：设置页刚打开灯带开关时，已持有 desktopNotify 的插件立刻就能用
      try { return deps.led ? deps.led() : null } catch (e) { return null }
    },
  }
}

/** 便捷重导出：其它插件构造 click 时不必依赖内部路径。 */
export { clickNone, clickUrl }
export type { FocusGate }
