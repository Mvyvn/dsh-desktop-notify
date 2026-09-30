/**
 * dsh-desktop-notify · Service Worker（由插件自身提供，**不是浏览器扩展**）
 *
 * 为什么需要它：把"哪个标签页该被激活"这件事，交回**浏览器自己**。
 * `notificationclick` 里的 `WindowClient.focus()` 是浏览器内部的受信任能力：
 * 同源、事件驱动、不需要 UIA / SetForegroundWindow / PowerShell / 扩展。
 *
 * 三个状态：
 *   ① 没有 DSH 页面  → clients.openWindow(deepLink)
 *   ② DSH 在前台     → focus() 基本是 no-op
 *   ③ DSH 在后台     → focus() 由 Firefox 自己把那个标签页交还给用户输入焦点
 *
 * 每一步都往宿主回报（/dnotify/sw/report），便于出问题时有据可查。
 */

/** pageId → clientId（内容脚本注册；SW 被回收后为空，此时退化为"第一个 DSH client"） */
const pageClients = new Map()

function report(payload) {
  try {
    fetch('/dnotify/sw/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) { /* 宿主不在时忽略 */ }
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data.type === 'register-page' && event.source && event.source.id) {
    pageClients.set(String(data.pageId), event.source.id)
    report({ kind: 'register', pageId: String(data.pageId), clientId: event.source.id })
  }
  if (data.type === 'show-notification') showNotification(data)
})

/** 让 DSH 页面自己弹一条系统通知；点击会回到本 SW 的 notificationclick。 */
async function showNotification(data) {
  try {
    const reg = await self.registration.showNotification(String(data.title || 'DSH'), {
      body: String(data.body || ''),
      tag: String(data.tag || 'dsh-poc'),
      // 图标由宿主提供（GET /dnotify/icon.png，按主题返回 PNG —— Web Notification 不认 .ico）
      icon: data.icon ? String(data.icon) : undefined,
      data: {
        pageId: String(data.pageId || ''),
        target: String(data.target || ''),
        deepLink: String(data.deepLink || ''),
      },
    })
    report({ kind: 'shown', tag: String(data.tag || 'dsh-poc') })
    return reg
  } catch (e) {
    report({ kind: 'show-error', message: String((e && e.message) || e) })
    return null
  }
}

function isDshClient(client) {
  const url = String((client && client.url) || '')
  return url.indexOf('127.0.0.1:3080') >= 0 && url.indexOf('/dnotify/click') < 0
}

async function focusTarget(data) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const wantedId = data.pageId ? pageClients.get(String(data.pageId)) : null
  let target = wantedId ? all.find((c) => c.id === wantedId) : null
  let how = 'by-pageId'
  if (!target) {
    target = all.find(isDshClient) || null
    how = target ? 'fallback-first-dsh-client' : 'none'
  }
  report({
    kind: 'click',
    pageId: String(data.pageId || ''),
    total: all.length,
    how,
    urls: all.map((c) => String(c.url || '')).slice(0, 6),
  })

  if (!target) {
    if (data.deepLink) {
      try { await self.clients.openWindow(String(data.deepLink)) } catch (e) { /* ignore */ }
    }
    return
  }

  let focused = false
  try {
    const res = await target.focus()
    focused = !!res
  } catch (e) {
    report({ kind: 'focus-error', message: String((e && e.message) || e) })
  }
  report({ kind: 'focused', pageId: String(data.pageId || ''), how, focused })
  try { target.postMessage({ type: 'dsh-navigate', target: String(data.target || '') }) } catch (e) { /* ignore */ }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = (event.notification && event.notification.data) || {}
  event.waitUntil(focusTarget(data))
})

self.addEventListener('notificationclose', () => report({ kind: 'closed' }))
