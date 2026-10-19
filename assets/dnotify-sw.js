/**
 * dsh-desktop-notify · Service Worker（由插件自身提供，**不是浏览器扩展**）
 *
 * 为什么需要它：把"哪个标签页该被激活"这件事，交回**浏览器自己**。
 * `notificationclick` 里的 `WindowClient.focus()` 是浏览器内部的受信任能力：
 * 同源、事件驱动、不需要 UIA / 扩展。
 * 页面跳转 ack 后，才请宿主做一次最简单的 Win32 前台尝试（koffi，不是 PowerShell）。
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
/** 等页面处理完 `dsh-navigate` 的 ack；超时仍请求（旧页面 bundle 不会回 ack）。 */
const NAV_ACK_TIMEOUT_MS = 2000
/** 新开窗口后等页面注册（load 完成）的超时；超时仍请求，由宿主 helper 重试枚举窗口。 */
const OPEN_WINDOW_READY_MS = 1500
const pendingNavAcks = new Map()
const pendingPageReady = []

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
    }).catch(() => {})   // 宿主不在时 fetch 是 rejection：必须接住，否则 SW 里会报 unhandled rejection
  } catch (e) { /* 宿主不在时忽略 */ }
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await self.clients.claim()
  // 清理：内存映射只保留仍活着的标签页；IndexedDB 里删掉 7 天前的行。
  await prunePageClients()
  // SW 冷启动/被回收后内存映射为空：**主动**让在线页面重报身份（事件驱动，取代页面侧轮询）
  await askPagesToReAnnounce()
})()))

/**
 * 清理 pageId → clientId 映射。
 *
 * 为什么要做：pageId 每次页面加载都会换新的，而内存 Map 与 IndexedDB 以前只增不删；
 * 长期使用后（尤其 SW 被反复唤醒）会留一坨永远不可能再命中的行/键。
 *  - 内存：只保留 `clients.matchAll()` 里仍在的 client（SW 内存随实例回收，这里顺手清）；
 *  - IndexedDB：删掉 7 天前的行（client id 在标签页存活期间稳定，跨天基本已失效）。
 */
async function prunePageClients() {
  try {
    const live = new Set()
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) live.add(c.id)
    for (const [pageId, clientId] of [...pageClients]) {
      if (!live.has(clientId)) pageClients.delete(pageId)
    }
  } catch (e) { /* ignore */ }
  try {
    const db = await idb()
    if (!db) return
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const tx = db.transaction(IDB_STORE, 'readwrite')
    const req = tx.objectStore(IDB_STORE).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const row = cursor.value
      if (!row || typeof row.at !== 'number' || row.at < cutoff) {
        try { cursor.delete() } catch (e) { /* ignore */ }
      }
      cursor.continue()
    }
  } catch (e) { /* IndexedDB 不可用就算了 */ }
}

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
  const extend = (promise) => {
    if (promise && typeof event.waitUntil === 'function') {
      try { event.waitUntil(promise) } catch (e) { /* ignore */ }
    }
    return promise
  }
  if (data.type === 'register-page' && event.source && event.source.id) {
    extend(rememberPage(String(data.pageId), event.source.id))
    report({ kind: 'register', pageId: String(data.pageId), clientId: event.source.id })
    signalPageReady()
  }
  // 页面已应用完 dsh-navigate（跳转落地/重试结束）→ 放行前台请求。
  if (data.type === 'dsh-navigated') {
    const finish = pendingNavAcks.get(String(data.nonce || ''))
    if (finish) finish()
  }
  // 页面要弹通知时顺手把身份也记下来（自愈：即使 register 那次丢了也能补上）
  if (data.type === 'page-focus') {
    const pageId = String(data.pageId || '')
    // 只允许"当前最后聚焦的页面"被它自己的失焦消息清掉，避免 A 的迟到 blur 抹掉 B 的 focus。
    if (data.focused === false) {
      if (lastFocusedPageId === pageId) lastFocusedPageId = ''
    } else if (pageId) {
      lastFocusedPageId = pageId
    }
  }
  if (data.type === 'show-notification') {
    if (data.pageId && event.source && event.source.id) extend(rememberPage(String(data.pageId), event.source.id))
    extend(showNotification(data))
  }
})

/**
 * 从通知数据里取出"点击动作"，没有就返回 null。
 *
 * 新宿主/页面：无可点击目标时**根本不发** target/deepLink/focusUrl，通知 data 里没有 action。
 * 旧页面 bundle 可能仍发 target:'none'：归一化成"没有动作"（只关闭通知）。
 * 这里做一次归一化后，`focusTarget` / 跳转代码里不再需要判断 target === 'none'。
 */
function actionOf(data) {
  if (!data) return null
  // 新数据形状：action 在展示时就已经归一化好。
  if (data.action && typeof data.action === 'object') {
    const target = String(data.action.target || '')
    if (!target || target === 'none') return null
    return {
      target,
      deepLink: String(data.action.deepLink || ''),
      focusUrl: String(data.action.focusUrl || ''),
    }
  }
  // 旧数据形状（通知已展示、SW 升级后才点击）：兼容旧页面 bundle 的顶层字段。
  const target = String(data.target || '')
  if (!target || target === 'none') return null
  return {
    target,
    deepLink: String(data.deepLink || ''),
    focusUrl: String(data.focusUrl || ''),
  }
}

/** 让 DSH 页面自己弹一条系统通知；点击会回到本 SW 的 notificationclick。 */
async function showNotification(data) {
  try {
    // 没有点击动作的通知：data 里只有 pageId，没有 target/deepLink/focusUrl。
    // 点击时 SW 一眼就能看出"没有可执行动作"，无需按通知类型再分支。
    const action = actionOf(data)
    const notificationData = { pageId: String(data.pageId || '') }
    if (action) notificationData.action = action
    const reg = await self.registration.showNotification(String(data.title || 'DSH'), {
      body: String(data.body || ''),
      tag: String(data.tag || 'dsh-poc'),
      // 图标：宿主已移除 /dnotify/icon.png（页面从不传 icon），这里只做透传。
      icon: data.icon ? String(data.icon) : undefined,
      data: notificationData,
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
function pickTargetClient(all, action, mappedId) {
  const dshClients = all.filter(isDshClient)
  const byId = (id) => (id ? all.find((c) => c.id === id) || null : null)
  const lastFocusedClient = byId(lastFocusedPageId ? (pageClients.get(lastFocusedPageId) || null) : null)
  const isPageTarget = String(action.target || '').indexOf('page:') === 0

  if (isPageTarget && lastFocusedClient) return { target: lastFocusedClient, how: 'page-target-favors-focused-tab' }
  const mapped = byId(mappedId)
  if (mapped) return { target: mapped, how: 'by-pageId' }
  if (lastFocusedClient) return { target: lastFocusedClient, how: 'by-last-focused-page' }
  if (dshClients.length === 1) return { target: dshClients[0], how: 'only-dsh-client' }
  return { target: null, how: mappedId ? 'target-client-gone' : 'no-mapping' }
}

/**
 * 等页面把 `dsh-navigate` 真正应用完（页面 ack），避免在跳转/窗口标题稳定前抢前台。
 * 旧页面 bundle 不会 ack：到超时后照样请求，不能因此永远不抬窗口。
 */
function waitForNavigateAck(nonce) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      pendingNavAcks.delete(nonce)
      resolve()
    }
    pendingNavAcks.set(nonce, finish)
    setTimeout(finish, NAV_ACK_TIMEOUT_MS)
  })
}

/** 新开窗口后等任意页面完成注册（load）；超时也继续请求。 */
function waitForPageReady() {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      const at = pendingPageReady.indexOf(finish)
      if (at >= 0) pendingPageReady.splice(at, 1)
      resolve()
    }
    pendingPageReady.push(finish)
    setTimeout(finish, OPEN_WINDOW_READY_MS)
  })
}

function signalPageReady() {
  for (const finish of pendingPageReady.slice()) finish()
}

/**
 * 请求宿主做最简单的前台尝试（ShowWindowAsync + SetForegroundWindow）。
 * 只在"页面跳转完成/新窗口就绪"之后调用，避免点击瞬间撞上仍在关闭的通知中心。
 * 等待响应并回报结果：HTTP 200 只代表请求被接受，真正的 atFront 由宿主返回。
 */
async function requestHostFocus(action) {
  if (!action || !action.focusUrl) return
  try {
    const res = await fetch(String(action.focusUrl), { keepalive: true })
    if (res && res.ok === false) {
      report({ kind: 'focus-request-failed', status: res.status })
      return
    }
    let body = null
    try { body = await res.json() } catch (e) { /* 旧宿主/非 JSON：保留 accepted 即可 */ }
    report({
      kind: 'focus-result',
      status: res ? res.status : 0,
      windowFound: !!(body && body.windowFound),
      atFront: !!(body && body.atFront),
      attempts: body && body.attempts ? body.attempts : 0,
      reason: body && body.reason ? String(body.reason) : '',
    })
  } catch (e) {
    report({ kind: 'focus-request-error', message: String((e && e.message) || e) })
  }
}

async function focusTarget(data) {
  const action = actionOf(data)
  // 没有动作 = 点击只关闭通知。通知在 notificationclick 里已经 close()；这里不再
  // focus / openWindow / 请求宿主前台，因此无目标通知不可能产生任何窗口或抢焦点。
  if (!action) return
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const pageId = String(data.pageId || '')
  let wantedId = pageId ? await recallPage(pageId) : null
  let picked = pickTargetClient(all, action, wantedId)

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
      picked = pickTargetClient(again, action, wantedId)
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
    if (action.deepLink) {
      // 先挂等待再 openWindow，避免新页面注册太快、消息在 await 返回前就到达。
      const ready = waitForPageReady()
      let opened = null
      try { opened = await self.clients.openWindow(String(action.deepLink)) } catch (e) { /* ignore */ }
      // openWindow 的返回值是 WindowClient：浏览器 API 能直接聚焦就别让宿主猜窗口。
      if (opened && typeof opened.focus === 'function') {
        try { await opened.focus() } catch (e) { /* ignore */ }
      }
      await ready
      await requestHostFocus(action)
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
  report({ kind: 'focused', pageId, how, focused })
  const nonce = 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  const acked = waitForNavigateAck(nonce)
  try {
    target.postMessage({ type: 'dsh-navigate', target: action.target, nonce })
  } catch (e) {
    // 页面已不可用：不等 ack，直接补一次前台（窗口可能还在）。
    await requestHostFocus(action)
    return
  }
  // 页面跳转真正落地后再请求前台；旧页面不 ack 时由超时兜底。
  await acked
  report({ kind: 'navigate-ack', pageId, nonce })
  await requestHostFocus(action)
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = (event.notification && event.notification.data) || {}
  event.waitUntil(focusTarget(data))
})

self.addEventListener('notificationclose', () => report({ kind: 'closed' }))
