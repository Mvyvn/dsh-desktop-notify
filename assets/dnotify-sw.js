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

/**
 * pageId → clientId。
 *
 * 内存里一份，IndexedDB 里一份：SW 被浏览器回收后内存会清空，而 **client id 在标签页
 * 存活期间是稳定的**，所以从 IndexedDB 恢复出来的映射依然有效。
 * 注意：映射查不到时**绝不猜**另一个 DSH 标签页 —— 宁可新开一个，也不要跳到错误的标签页。
 */
const pageClients = new Map()

const IDB_NAME = 'dsh-desktop-notify'
const IDB_STORE = 'page-clients'

function idb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(IDB_STORE, { keyPath: 'pageId' }) } catch (e) { /* 已存在 */ }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch (e) { resolve(null) }
  })
}

async function rememberPage(pageId, clientId) {
  pageClients.set(pageId, clientId)
  const db = await idb()
  if (!db) return
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put({ pageId, clientId, at: Date.now() })
  } catch (e) { /* ignore */ }
}

async function recallPage(pageId) {
  const cached = pageClients.get(pageId)
  if (cached) return cached
  const db = await idb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(pageId)
      req.onsuccess = () => {
        const row = req.result
        if (row && row.clientId) { pageClients.set(pageId, row.clientId); resolve(row.clientId) }
        else resolve(null)
      }
      req.onerror = () => resolve(null)
    } catch (e) { resolve(null) }
  })
}

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
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await self.clients.claim()
  // SW 冷启动/被回收后内存映射为空：**主动**让在线页面重报身份（事件驱动，取代页面侧轮询）
  await askPagesToReAnnounce()
})()))

/** 让所有在线 DSH 页面重新报一次 pageId → clientId。 */
async function askPagesToReAnnounce() {
  try {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) {
      if (!isDshClient(c)) continue
      try { c.postMessage({ type: 're-announce' }) } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data.type === 'register-page' && event.source && event.source.id) {
    rememberPage(String(data.pageId), event.source.id)
    report({ kind: 'register', pageId: String(data.pageId), clientId: event.source.id })
  }
  // 页面要弹通知时顺手把身份也记下来（自愈：即使 register 那次丢了也能补上）
  if (data.type === 'page-focus') {
    lastFocusedPageId = data.focused === false ? '' : String(data.pageId || '')
  }
  if (data.type === 'show-notification') {
    if (data.pageId && event.source && event.source.id) rememberPage(String(data.pageId), event.source.id)
    showNotification(data)
  }
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
    report({ kind: 'show-error', tag: String(data.tag || 'dsh-poc'), message: String((e && e.message) || e) })
    return null
  }
}

function isDshClient(client) {
  const url = String((client && client.url) || '')
  if (url.indexOf('/dnotify/click') >= 0) return false
  // 宿主 origin 是动态的（dsh web 可换端口/主机名），用 SW 自身 origin 判断，
  // 不能硬编码 127.0.0.1:3080 —— 否则"只有一个 DSH 窗口就直接用它"这条回退永远不成立。
  try { return new URL(url).origin === String(self.location.origin) } catch (e) { return false }
}

/** 最近一次处于聚焦状态的 pageId（页面 focus/blur 时主动告知）。 */
let lastFocusedPageId = ''

/**
 * 选点击的目标标签页。规则（**全部基于证据，不猜**）：
 *   1. 目标是 `page:…`（例如启动播报 → 设置/内置插件）：优先**你正在用的那个标签页** ——
 *      这类目标与具体会话无关，任何 DSH 标签页都能自己导航过去；跳到"旧页面"反而突兀。
 *   2. 目标是 `session:…`：优先**通知产生时那个页面**（它最可能已经持有该会话的上下文）。
 *   3. 前两条落空时，依次退到"最近聚焦的标签页"→"**只有一个** DSH 窗口就直接用它"。
 *      只有一个窗口时不存在歧义，不该新开 —— 这正好覆盖"启动瞬间页面还没注册完就点了通知"。
 *   4. 仍然没有目标 → openWindow(深链) 新开（宁可新开，也不跳到错误的标签页）。
 */
function pickTargetClient(all, data, mappedId) {
  const dshClients = all.filter(isDshClient)
  const byId = (id) => (id ? all.find((c) => c.id === id) || null : null)
  const lastFocusedClient = byId(lastFocusedPageId ? (pageClients.get(lastFocusedPageId) || null) : null)
  const isPageTarget = String(data.target || '').indexOf('page:') === 0

  if (isPageTarget && lastFocusedClient) return { target: lastFocusedClient, how: 'page-target-favors-focused-tab' }
  const mapped = byId(mappedId)
  if (mapped) return { target: mapped, how: 'by-pageId' }
  if (lastFocusedClient) return { target: lastFocusedClient, how: 'by-last-focused-page' }
  if (dshClients.length === 1) return { target: dshClients[0], how: 'only-dsh-client' }
  return { target: null, how: mappedId ? 'target-client-gone' : 'no-mapping' }
}

async function focusTarget(data) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const pageId = String(data.pageId || '')
  let wantedId = pageId ? await recallPage(pageId) : null
  let picked = pickTargetClient(all, data, wantedId)

  if (!picked.target && pageId) {
    // 映射缺失（SW 刚被回收、IndexedDB 不可用、或注册那次丢了）：先**问一轮**页面身份，
    // 给一个很短的窗口；问到就用，问不到再按规则退（绝不退化成"随便挑一个 DSH 标签页"）。
    await askPagesToReAnnounce()
    const deadline = Date.now() + 200
    while (Date.now() < deadline && !wantedId) {
      await new Promise((r) => setTimeout(r, 20))
      wantedId = await recallPage(pageId)
    }
    if (wantedId) {
      const again = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      picked = pickTargetClient(again, data, wantedId)
      if (picked.target) picked.how = picked.how + '-after-reannounce'
    }
  }
  const target = picked.target
  const how = picked.how
  report({
    kind: 'click',
    pageId,
    total: all.length,
    dshClients: all.filter(isDshClient).length,
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
