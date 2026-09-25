// DSH 桌面通知 — 对外推送 API（供其它插件调用）
//
// 经 Cordis 服务暴露：其它插件 `ctx.get('desktopNotify')` 取用。
//   push(item)        走聚焦门控（按会话：你正在看的那个会话会被静默）
//   pushAlways(item)  绕过聚焦门控，始终推送
//   notify(item)      与 push 同路径，但返回结构化结果（是否入队 / 是否被静默 / 原因）
//
// item 载荷：{ title, message?, urgency?, sessionId?, url? }
//   sessionId 用于会话级门控（可传会话对象、id 或它们的数组）；
//   url 是**点击通知要打开的地址**（http/https）——不传时宿主会按会话归属自动生成
//   "跳转到该会话"的链接；两者都没有则通知不可点击跳转。
//
// ⚠️ push 返回 true 的含义是"**真的入队了**"：被门控静默、命中同文案去重、
// 或当前平台没有通知后端时都返回 false（旧版把"载荷有效"当成 true，
// 调用方无法区分"静默了"和"发出去了"）。

import { sessionIdList } from './gate.js'
import { truncateText } from './text.js'

const URGENCIES = new Set(['low', 'normal', 'critical'])
const MAX_TITLE = 160
const MAX_MESSAGE = 400

/**
 * 归一外部传入的通知载荷；标题为空视为无效（返回 null，不推送）。
 * @param {{title?: unknown, message?: unknown, urgency?: unknown, sessionId?: unknown, url?: unknown}} item
 * @returns {{title: string, message: string, urgency: string, sessionIds: string[], url: string} | null}
 */
export function normalizeNotifyItem(item) {
  if (!item || typeof item !== 'object') return null
  const title = truncateText(String(item.title ?? '').replace(/\s+/g, ' ').trim(), MAX_TITLE)
  if (!title) return null
  const message = truncateText(String(item.message ?? '').replace(/\s+/g, ' ').trim(), MAX_MESSAGE)
  const urgency = URGENCIES.has(item.urgency) ? item.urgency : 'normal'
  // 只接受 http/https：标题/正文之外的东西最终会交给系统或浏览器打开，别的协议不该从这里出去
  const rawUrl = typeof item.url === 'string' ? item.url.trim() : ''
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : ''
  return { title, message, urgency, sessionIds: sessionIdList(item.sessionId), url }
}

/**
 * 构造对外 API。
 * @param {{notify: (title: string, message: string, urgency: string, sessionIds: unknown, options?: object) =>
 *            {queued?: boolean, silenced?: boolean, reason?: string},
 *          enqueue: (item: {title: string, message: string, urgency: string, url?: string}) => boolean,
 *          link?: (sessionIds: string[]) => string}} deps
 */
export function createNotifyApi(deps) {
  const { notify, enqueue, link } = deps
  /** 归一 + 走门控路径；返回结构化结果。 */
  function deliver(item) {
    const it = normalizeNotifyItem(item)
    if (!it) return { ok: false, queued: false, silenced: false, reason: 'invalid-payload' }
    const url = it.url || (typeof link === 'function' ? link(it.sessionIds) : '')
    const result = notify(it.title, it.message, it.urgency, it.sessionIds, { url }) || {}
    const queued = result.queued === true
    return {
      ok: true,
      queued,
      silenced: result.silenced === true,
      reason: queued ? '' : (result.reason || 'dropped'),
    }
  }
  return {
    /**
     * 走聚焦门控推送：只有"你正在看的那个会话"会被静默。
     * @returns {boolean} 真的入队了才返回 true（被静默/去重/无后端都是 false）
     */
    push(item) {
      return deliver(item).queued
    },
    /**
     * 绕过聚焦门控推送：无论页面是否聚焦、正在看哪个会话，都弹。
     * @returns {boolean} 真的入队了才返回 true；标题为空返回 false
     */
    pushAlways(item) {
      const it = normalizeNotifyItem(item)
      if (!it) return false
      const url = it.url || (typeof link === 'function' ? link(it.sessionIds) : '')
      // 空 url 不进载荷：不可点击的通知保持原样（也少一个字段）
      const payload = { title: it.title, message: it.message, urgency: it.urgency }
      if (url) payload.url = url
      return enqueue(payload) === true
    },
    /**
     * 走聚焦门控推送并返回明细。
     * @returns {{ok: boolean, queued: boolean, silenced: boolean, reason: string}}
     *   reason: '' | 'invalid-payload' | 'silenced' | 'duplicate' | 'dropped'
     */
    notify(item) {
      return deliver(item)
    },
  }
}
