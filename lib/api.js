// DSH 桌面通知 — 对外推送 API（供其它插件调用）
//
// 经 Cordis 服务暴露：其它插件 `ctx.get('desktopNotify')` 取用。
//   push(item)        走聚焦门控（按会话：你正在看的那个会话会被静默）
//   pushAlways(item)  绕过聚焦门控，始终推送
//
// item 载荷：{ title, message?, urgency?, sessionId? }
//   sessionId 用于会话级门控（可传会话对象、id 或它们的数组）。

import { sessionIdList } from './gate.js'

const URGENCIES = new Set(['low', 'normal', 'critical'])
const MAX_TITLE = 160
const MAX_MESSAGE = 400

/**
 * 归一外部传入的通知载荷；标题为空视为无效（返回 null，不推送）。
 * @param {{title?: unknown, message?: unknown, urgency?: unknown, sessionId?: unknown}} item
 * @returns {{title: string, message: string, urgency: string, sessionIds: string[]} | null}
 */
export function normalizeNotifyItem(item) {
  if (!item || typeof item !== 'object') return null
  const title = String(item.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
  if (!title) return null
  const message = String(item.message ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
  const urgency = URGENCIES.has(item.urgency) ? item.urgency : 'normal'
  return { title, message, urgency, sessionIds: sessionIdList(item.sessionId) }
}

/**
 * 构造对外 API。
 * @param {{notify: (title: string, message: string, urgency: string, sessionIds: string[]) => unknown,
 *          enqueue: (item: {title: string, message: string, urgency: string}) => void}} deps
 */
export function createNotifyApi(deps) {
  const { notify, enqueue } = deps
  return {
    /**
     * 走聚焦门控推送：只有"你正在看的那个会话"会被静默。
     * @returns {boolean} 载荷有效并入队返回 true；标题为空返回 false（未推送）
     */
    push(item) {
      const it = normalizeNotifyItem(item)
      if (!it) return false
      notify(it.title, it.message, it.urgency, it.sessionIds)
      return true
    },
    /**
     * 绕过聚焦门控推送：无论页面是否聚焦、正在看哪个会话，都弹。
     * @returns {boolean} 载荷有效并入队返回 true；标题为空返回 false（未推送）
     */
    pushAlways(item) {
      const it = normalizeNotifyItem(item)
      if (!it) return false
      enqueue({ title: it.title, message: it.message, urgency: it.urgency })
      return true
    },
  }
}
