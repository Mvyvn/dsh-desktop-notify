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

const URGENCIES: readonly string[] = ['low', 'normal', 'critical']
const MAX_TITLE = 160
const MAX_MESSAGE = 400
const PAGE_TARGETS: readonly string[] = ['settings-plugins', 'plugins']

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
}

export interface NotifyApi {
  push(item: unknown): boolean
  pushAlways(item: unknown): boolean
  notify(item: unknown): NotifyOutcome
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

  function deliver(item: unknown): NotifyOutcome {
    const normalized = normalizeNotifyItem(item)
    if (normalized === null) return { ok: false, queued: false, silenced: false, reason: 'invalid-payload' }
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
    }
  }

  return {
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
  }
}

/** 便捷重导出：其它插件构造 click 时不必依赖内部路径。 */
export { clickNone, clickUrl }
export type { FocusGate }
