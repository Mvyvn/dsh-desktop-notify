// DSH 桌面通知 — 浏览器半区（web-profile bundle，免审批）。
// 包装在 shell 的 __ModuleLoader__ 格式中；通过官方 Connection RPC 通道
// /dnotify 向 host 上报"页面聚焦状态 + 当前选中的会话 id"。
//
// 聚焦语义：只有浏览器窗口聚焦且当前标签活跃（visible && hasFocus）才算
// "在看 DSH"——非聚焦状态（切到别的窗口/别的标签/最小化）一律上报失焦，
// 由宿主据此推送提醒；聚焦期间每分钟补一次心跳，避免"看着但不动鼠标"被宿主
// 的保鲜超时误判为失焦（那会导致本该静默的提醒照弹）。
//
// 会话语义：同时上报"本页面当前选中的会话"，让宿主能只静默"你正在看的那个
// 会话"——看会话 A 时，会话 B 完成照样弹。选中态从 sessions 快照的
// `byId[*].retainedBy.mainView` 读出（与官方 ui-layout / ui-session 同一判据；
// 0.1.7 的 SessionListState 里**没有** current 字段）。
//
// 事件驱动，无轮询：
//   focus / blur              窗口或标签聚焦状态切换（即时上报）
//   visibilitychange          标签页隐藏/切走/最小化（兜底上报）
//   pagehide                  页面卸载前强制上报失焦（keepalive 保证送达）
//   keydown/mousedown/pointermove/scroll  用户活动（节流 10s）保持聚焦"保鲜"
//   sessions.list.subscribe   会话切换（即时重报当前会话）
//
// ⚠️ 事件监听必须用显式包装（() => report()），绝不能直接传 report：
// DOM 监听器会被传入 Event 对象，而 !!Event === true，会把 blur/visibilitychange
// 变成恒上报 focused=true（此前正是这个 Bug 导致失焦上报永远不生效）。
window.__ModuleLoader__.load({
  id: 'dsh-desktop-notify',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var ROUTE_PREFIX = 'dnotify'      // 文档相对：挂载在子路径下时也正确
    var FOCUS_ENDPOINT = 'page-focus'
    var EVENTS_ENDPOINT = 'events'
    var CLAIM_ENDPOINT = 'claim'
    /** 聚焦心跳间隔：必须显著小于宿主 gate 的保鲜时长（2 分钟）。 */
    var HEARTBEAT_MS = 60000
    /** 用户活动事件的最小上报间隔。 */
    var ACTIVITY_THROTTLE_MS = 10000

    var ctxRef = null

    // ---- 与宿主通信 ----
    // 走本插件自己挂的 /dnotify 路由（纯 JSON POST，同源 fetch 自带 cookie）。
    // 不用 DSH 的 connection.rpc.call：0.1.7-rc.2 里 host 侧的 rpc.handle 会在
    // owner.webServer 上撞注入守卫（详见 lib/index.js 的注释），那条通道挂不上；
    // 而且自带路由还能顺带承载"点击通知"的 SSE 投递。
    function post(endpoint, body, keepalive) {
      return fetch(ROUTE_PREFIX + '/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: !!keepalive,   // 页面卸载期间（pagehide）也保证送达
        body: JSON.stringify(body || {}),
      }).then(function (res) {
        if (!res.ok) throw new Error('dnotify ' + endpoint + ': HTTP ' + res.status)
        return res.json()
      })
    }

    // 聚焦判定：浏览器窗口聚焦且当前标签活跃。
    // 最小化/后台标签时 visibilityState !== 'visible' → 一律视为非聚焦
    // （Firefox/Chrome 在最小化时 hasFocus() 可能仍返回 true，不能单独依赖它）。
    function isFocused() {
      try {
        if (document.visibilityState !== 'visible') return false
        return document.hasFocus()
      } catch (e) { return false }
    }

    // 页面唯一 id（sessionStorage 持久：同一标签页刷新后 id 不变，host 端覆盖旧条目）
    var pageId = null
    function getPageId() {
      if (pageId) return pageId
      try {
        pageId = window.sessionStorage.getItem('dsh-notify-page-id')
        if (!pageId) {
          pageId = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
          window.sessionStorage.setItem('dsh-notify-page-id', pageId)
        }
      } catch (e) {
        pageId = 'p-' + Math.random().toString(36).slice(2)
      }
      return pageId
    }

    // 上报序号：**单调递增**（刷新后继续涨，因为存在 sessionStorage 里）。
    // 宿主的页面注册表只接受更大的 seq，这样 focus/blur 两个 HTTP 请求乱序到达时，
    // 旧状态不会覆盖新状态（review 第 10 条）。
    var seqCounter = null
    function nextSeq() {
      if (seqCounter === null) {
        var stored = 0
        try { stored = Number(window.sessionStorage.getItem('dsh-notify-page-seq')) || 0 } catch (e) { stored = 0 }
        seqCounter = stored
      }
      seqCounter += 1
      try { window.sessionStorage.setItem('dsh-notify-page-seq', String(seqCounter)) } catch (e) { /* ignore */ }
      return seqCounter
    }

    // ---- 当前选中会话（harness 客户端 sessions 服务）----
    // sessions.list 是快照存储（ObservableSnapshot<SessionListState>），
    // 但快照里没有 current：选中态由"主视图保留"表达——byId[x].retainedBy.mainView > 0。
    // 官方 ui-layout / ui-session / ui-open-in-app 都用同一判据。
    var lastSessionId = null
    function readSessionId() {
      try {
        var sessions = ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get('sessions') : null
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return null
        var snap = sessions.list.getSnapshot()
        var rows = snap && snap.byId
        if (!rows) return null
        var ids = Object.keys(rows)
        for (var i = 0; i < ids.length; i++) {
          var row = rows[ids[i]]
          if (row && row.retainedBy && row.retainedBy.mainView > 0) return String(ids[i])
        }
      } catch (e) { /* ignore */ }
      return null
    }
    function onSessionChanged() {
      var id = readSessionId()
      if (id === lastSessionId) return
      lastSessionId = id
      report()
    }

    // ---- 点击通知的跳转 ----
    // 宿主收到点击后**先决策再开窗口**（lib/index.js 的 activate）：
    //   · 配置里没有点击目标        → 不跳转（通知不可点击）
    //   · 有目标 + 有可投递的 DSH 页面 → 只通过 SSE（dnotify/events）定向推给那一个页面，
    //                                  本页面用 dnotify/claim 按 openId 认领后执行
    //   · 有目标 + 没有 DSH 页面     → 宿主让系统/浏览器打开 `/#dsh-notify=<目标>`
    // 下面这三条只承担"最后一个公里"：把目标落到具体的会话/页面。
    //   session:<id>           → 切到该会话（子代理会话会按 ui-workspace 规则进子代理界面）
    //   page:settings-plugins  → 「设置 → 内置插件」（合成快捷键/账号菜单两条路，退回插件面板）
    //   page:plugins           → 插件面板
    var HASH_MARKER = '#dsh-notify='
    var NAV_RETRY_MS = 500
    var NAV_RETRIES = 20
    var eventStream = null
    function clientService(name) {
      try {
        return ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get(name) : null
      } catch (e) { return null }
    }
    function findButton(root, pattern) {
      try {
        var buttons = root.querySelectorAll('button,a,[role="menuitem"]')
        for (var i = 0; i < buttons.length; i++) {
          var label = String(buttons[i].textContent || '').replace(/\s+/g, ' ').trim()
          if (pattern.test(label)) return buttons[i]
        }
      } catch (e) { /* ignore */ }
      return null
    }
    function settingsModal() {
      try { return document.querySelector('[data-shortcut-modal="settings"]') } catch (e) { return null }
    }
    /** 打开插件面板（公开服务 pluginNavigation，退路 layout.selectPanel）。 */
    function openPluginsPanel() {
      var nav = clientService('pluginNavigation')
      if (nav && typeof nav.openBundle === 'function') {
        try { nav.openBundle('dsh-desktop-notify'); return true } catch (e) { /* 试下一个 */ }
      }
      var layout = clientService('layout')
      if (layout && typeof layout.selectPanel === 'function') {
        try { layout.selectPanel('plugins'); return true } catch (e) { /* ignore */ }
      }
      return false
    }
    /**
     * 打开「设置 → 内置插件」。DSH 没有公开 API 能打开设置（状态在 ui-settings-general 的
     * 私有 store 里），所以这里按"最能用的顺序"尝试：
     *   ① 合成设置快捷键 —— 注意 **0.2.0-rc.2 把 web 端的绑定改成了 primary+alt+Comma**
     *      （desktop:* 仍是 primary+Comma），所以先试 alt 组合，没反应再试不带 alt 的；
     *   ② 账号菜单里的「设置」；
     *   ③ 弹窗出现后点「内置插件」导航格。
     * 三条都没打开设置就退回插件面板（功能等价：列出/启停内置插件）。
     */
    function openSettingsPlugins() {
      var iterations = 0
      var done = false
      var stage = 'shortcut-web'   // → shortcut-desktop → account-menu → fallback
      var timer = setInterval(function () {
        if (done) { clearInterval(timer); return }
        iterations += 1
        if (iterations > 60) { done = true; clearInterval(timer); openPluginsPanel(); return }
        var modal = settingsModal()
        if (modal) {
          var cell = findButton(modal, /内置插件|Built-in plugins/i)
          if (cell) { try { cell.click() } catch (e) { /* ignore */ } }
          done = true
          clearInterval(timer)
          return   // 设置已经打开；即使没找到导航格也留给用户自己点
        }
        // 先按 web 绑定（primary+alt）试；约 1.2s 没反应再退回 desktop 绑定（仅 primary）
        if (stage === 'shortcut-web' && iterations === 1) synthesizeSettingsShortcut(true)
        else if (stage === 'shortcut-web' && iterations >= 12) { stage = 'shortcut-desktop'; synthesizeSettingsShortcut(false) }
        else if (stage === 'shortcut-desktop' && iterations === 24) { stage = 'account-menu'; clickAccountMenuSettings() }
        else if (stage === 'account-menu' && iterations >= 44) { stage = 'fallback'; done = true; clearInterval(timer); openPluginsPanel() }
      }, 100)
      return true
    }
    /** @param {boolean} withAlt web 绑定需要 alt（0.2.0-rc.2 起），desktop 绑定不需要 */
    function synthesizeSettingsShortcut(withAlt) {
      try {
        var Keyboard = window.KeyboardEvent || (typeof KeyboardEvent === 'function' ? KeyboardEvent : null)
        if (!Keyboard) return
        var mac = /Mac|iPhone|iPad/.test(String(navigator.platform || navigator.userAgent || ''))
        window.dispatchEvent(new Keyboard('keydown', {
          key: ',', code: 'Comma', ctrlKey: !mac, metaKey: mac, altKey: !!withAlt, bubbles: true, cancelable: true,
        }))
      } catch (e) { /* ignore */ }
    }
    function clickAccountMenuSettings() {
      try {
        var trigger = document.querySelector('button[aria-haspopup="menu"]')
        if (!trigger) return
        trigger.click()
        setTimeout(function () {
          var item = findButton(trigger.ownerDocument, /^(设置|Settings)$/)
          if (item) { try { item.click() } catch (e) { /* ignore */ } }
        }, 120)
      } catch (e) { /* ignore */ }
    }
    /**
     * 切换会话。三态返回（旧版把"openSession 抛错"直接变成 `location.reload()`，
     * 而 reload 前 hash 已被清掉 → 页面原地刷新但**不跳转**，正是那个确定性 bug）：
     *   'done'      已经处理（含"本来就在这个会话"）
     *   'not-ready' uiWorkspace 还没就绪 → 交给上层重试
     *   'not-found' 会话不在客户端目录里（openSession 抛错）→ 明确失败，**不刷新**
     */
    function switchSession(id) {
      if (!id) return 'done'
      if (readSessionId() === id) return 'done'   // 已经在这个会话：不折腾
      var workspace = clientService('uiWorkspace')
      if (!workspace || typeof workspace.openSession !== 'function') return 'not-ready'
      try {
        // 与点击侧栏会话行同一条链路；子代理会话由 ui-workspace 自己解析成子代理界面。
        // 契约核对（0.1.7-rc.2 与 0.2.0-rc.2 的 ui-workspace/src/client/navigation.ts:34 一致）：
        // `openSession(target: SessionTarget): void` 是**同步 void**，内部同步 retain +
        // 切主视图——"不抛错"就是这里能拿到的最强成功信号，没有 Promise 可 await。
        workspace.openSession(id)
        return 'done'
      } catch (e) {
        // 会话不在客户端目录里 / 已归档：明确失败并记一条日志。
        // 绝不 reload：刷新既不会让会话出现，还会让用户看到"点了没反应只是刷新了"。
        try { console.warn('[dsh-desktop-notify] 会话不在当前客户端目录，放弃跳转:', id) } catch (e2) { /* ignore */ }
        return 'not-found'
      }
    }
    /**
     * 执行一个点击目标（线格式：none / session:<id> / page:<名字> / url:<地址>）。
     * @returns {'done'|'not-ready'|'not-found'}
     */
    function applyTarget(target) {
      if (target === 'none' || target === '') return 'done'
      if (target.indexOf('page:settings-plugins') === 0) { openSettingsPlugins(); return 'done' }
      if (target.indexOf('page:') === 0) { openPluginsPanel(); return 'done' }
      if (target.indexOf('session:') === 0) return switchSession(target.slice('session:'.length))
      // url 目标不会投递到页面（宿主直接开系统浏览器，避免被弹窗拦截），这里只兜底忽略
      return 'done'
    }
    /**
     * 处理未就绪时有限次重试；'not-found'（会话真的不在目录里）立即放弃、绝不刷新。
     */
    function applyTargetWithRetry(target) {
      if (applyTarget(target) !== 'not-ready') return
      var attempts = 0
      var timer = setInterval(function () {
        attempts += 1
        if (applyTarget(target) !== 'not-ready' || attempts >= NAV_RETRIES) clearInterval(timer)
      }, NAV_RETRY_MS)
    }
    /** 认领**这一次**点击：带 openId，连点两条通知也不会认领错。 */
    function claimOpen(openId) {
      var body = { pageId: getPageId(), openId: String(openId) }
      post(CLAIM_ENDPOINT, body).then(function (res) {
        if (res && res.ok === true && res.target) applyTargetWithRetry(String(res.target))
        else if (res && res.reason === 'not-owner') {
          try { console.warn('[dsh-desktop-notify] 这次点击不属于本页面，已忽略') } catch (e) { /* ignore */ }
        }
      }).catch(function () { /* 宿主不可达：忽略，下次事件再说 */ })
    }
    /**
     * 常驻 SSE：宿主把点击**定向**推给某个页面（此刻聚焦的，或最后用过且仍在线的），
     * 从不广播——所以这里把 pageId 一并报上去，宿主才知道哪条连接是谁。
     */
    function openEventStream() {
      if (eventStream) return
      if (typeof window.EventSource !== 'function') return
      try {
        eventStream = new window.EventSource(ROUTE_PREFIX + '/' + EVENTS_ENDPOINT
          + '?pageId=' + encodeURIComponent(getPageId()))
        eventStream.addEventListener('navigate', function (event) {
          var envelope = null
          try { envelope = JSON.parse((event && event.data) || '{}') } catch (e) { envelope = null }
          if (!envelope || !envelope.id) return
          // 防御性校验：宿主只该把属于本页面的点击推过来
          if (envelope.targetPageId && envelope.targetPageId !== getPageId()) {
            try { console.warn('[dsh-desktop-notify] 收到不属于本页面的点击，忽略') } catch (e2) { /* ignore */ }
            return
          }
          claimOpen(String(envelope.id))
        })
        eventStream.addEventListener('error', function () {
          // EventSource 自己会按 retry 重连；这里只在彻底关闭时清空引用
          try { if (eventStream && eventStream.readyState === 2) eventStream = null } catch (e) { /* ignore */ }
        })
      } catch (e) { eventStream = null }
    }
    function closeEventStream() {
      if (!eventStream) return
      try { eventStream.close() } catch (e) { /* ignore */ }
      eventStream = null
    }
    /** hash 深链（没有已打开页面时宿主 302 过来，或用户手动打开）：就地处理。 */
    function handleHashTarget() {
      var raw = ''
      try {
        var hash = String(window.location.hash || '')
        var at = hash.indexOf(HASH_MARKER)
        if (at >= 0) raw = decodeURIComponent(hash.slice(at + HASH_MARKER.length))
      } catch (e) { raw = '' }
      if (!raw) return
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      } catch (e) { /* ignore */ }
      // 会话目标要等 uiWorkspace 就绪（刚打开的页面里会话目录可能还在加载，早试会得到
      // not-found——旧版就是这么一路走到 reload 的）；页面目标不需要等，直接执行。
      if (raw.indexOf('session:') === 0) waitForWorkspaceThen(raw)
      else applyTargetWithRetry(raw)
    }
    /** 等服务就绪后执行一次 hash 目标（最多等 ~15s，不刷新页面）。 */
    function waitForWorkspaceThen(raw) {
      var attempts = 0
      var timer = setInterval(function () {
        attempts += 1
        var workspace = clientService('uiWorkspace')
        if (workspace && typeof workspace.openSession === 'function') {
          clearInterval(timer)
          applyTargetWithRetry(raw)
          return
        }
        if (attempts >= 150) clearInterval(timer)
      }, 100)
    }

    var lastActivityAt = 0
    // forced 只接受 boolean：true=强制聚焦上报，false=强制失焦上报。
    // 非 boolean（含 DOM Event 对象）一律忽略，改由 isFocused() 实时判定——
    // 避免 !!Event === true 把失焦事件误报为聚焦。
    function report(forced, keepalive) {
      try {
        var focused = typeof forced === 'boolean' ? forced : isFocused()
        post(FOCUS_ENDPOINT, {
          focused: focused,
          pageId: getPageId(),
          // 单调序号：宿主的页面注册表据此丢弃乱序到达的旧状态
          seq: nextSeq(),
          // 当前选中的会话（取不到就是 null：宿主对"归属不明"的通知照常推送）
          sessionId: readSessionId(),
        }, keepalive).catch(function () {})
      } catch (e) { /* ignore */ }
    }
    // 用户活动事件（节流 10s）：聚焦页面持续"保鲜"；非聚焦页不会产生活动事件
    function onActivity() {
      var now = Date.now()
      if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return
      lastActivityAt = now
      if (isFocused()) report()
    }

    exports.apply = function apply(ctx) {
      ctxRef = ctx
      lastSessionId = readSessionId()

      // 监听与心跳都挂在 fiber 上：插件卸载/热更新时 cordis 自动清理，不会重复挂
      ctx.effect(function () {
        var onFocus = function () { report() }
        var onBlur = function () { report() }
        var onVisibility = function () { report() }
        var onPageHide = function () { report(false, true) }
        window.addEventListener('focus', onFocus)
        window.addEventListener('blur', onBlur)
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('pagehide', onPageHide)
        window.addEventListener('keydown', onActivity)
        window.addEventListener('mousedown', onActivity)
        window.addEventListener('pointermove', onActivity)
        window.addEventListener('scroll', onActivity, true)
        window.addEventListener('hashchange', handleHashTarget)

        // 点击通知的投递：SSE 常驻（宿主收到点击就推；本页认领后执行跳转）
        openEventStream()

        // 聚焦心跳：只在聚焦时打点，失焦/隐藏立刻停（后台标签页的定时器会被浏览器
        // 节流到分钟级，本来也不可靠，所以不可见时直接不依赖它）
        var heartbeat = setInterval(function () {
          if (isFocused()) report()
        }, HEARTBEAT_MS)

        return function () {
          clearInterval(heartbeat)
          closeEventStream()
          window.removeEventListener('focus', onFocus)
          window.removeEventListener('blur', onBlur)
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('pagehide', onPageHide)
          window.removeEventListener('keydown', onActivity)
          window.removeEventListener('mousedown', onActivity)
          window.removeEventListener('pointermove', onActivity)
          window.removeEventListener('scroll', onActivity, true)
          window.removeEventListener('hashchange', handleHashTarget)
        }
      })

      // 会话切换即时重报：让"切到别的会话"立刻改变静默归属，不必等下一次聚焦事件。
      // 服务可能晚于本插件就绪，故用 ctx.inject 等服务出现再挂（出现即执行）。
      ctx.inject(['sessions'], function (scope) {
        var sessions = typeof scope.get === 'function' ? scope.get('sessions') : scope.sessions
        if (!sessions || !sessions.list || typeof sessions.list.subscribe !== 'function') return
        scope.effect(function () {
          var dispose = sessions.list.subscribe(function () { onSessionChanged() })
          return function () { try { dispose() } catch (e) { /* ignore */ } }
        })
        // 服务就绪后才可能读到会话：立刻补报一次。否则宿主在首个心跳（≤60s）
        // 之前拿不到会话归属，静默判定会退化成"永不静默"。
        onSessionChanged()
      })

      report()
      // SSE 已在上面那个 ctx.effect 里建立（顺带拿到卸载时的清理），这里不再重复调用。
      // hash 深链仍要处理：宿主在没有已连接页面时会 302 到 /#dsh-notify=… 走这条路。
      handleHashTarget()
    }

    return module.exports
  },
})
