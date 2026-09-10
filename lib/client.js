// DSH 桌面通知 — 浏览器半区（web-profile bundle，免审批）。
// 包装在 shell 的 __ModuleLoader__ 格式中；通过官方 Connection RPC 通道
// /dnotify 向 host 上报"页面聚焦状态 + 当前选中的会话 id"（协议与
// @deepseek-ai/dsh-client-connection 的 createWebConnectionRpc 相同）。
//
// 聚焦语义：只有浏览器窗口聚焦且当前标签活跃（visible && hasFocus）才算
// "在看 DSH"——非聚焦状态（切到别的窗口/别的标签/最小化）一律上报失焦，
// 由宿主据此推送提醒。
//
// 会话语义：同时上报"本页面当前选中的会话"（sessions 服务的 list.current），
// 让宿主能只静默"你正在看的那个会话"的提醒——看会话 A 时，会话 B 完成照样弹。
//
// 全部由原生事件驱动，无轮询定时器：
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

    // ---- Connection RPC 调用方（镜像 createWebConnectionRpc）----
    function rpcId() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      return 'rpc-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }
    function rpcCall(channel, endpoint, payload) {
      var message = { type: 'client-request', rpcId: rpcId(), method: endpoint, payload: payload === undefined ? {} : payload }
      return fetch(new URL(channel + '/' + endpoint, window.location.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: true,  // 页面卸载（pagehide）期间的请求也保证送达
        body: JSON.stringify(message),
      }).then(function (res) {
        if (!res.ok) throw new Error('dnotify RPC ' + endpoint + ': HTTP ' + res.status)
        return res.json()
      }).then(function (full) {
        if (!full || full.type !== 'server-response' || full.rpcId !== message.rpcId) throw new Error('dnotify RPC envelope mismatch for ' + endpoint)
        return full.result
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

    var lastActivityAt = 0
    // forced 只接受 boolean：true=强制聚焦上报，false=强制失焦上报。
    // 非 boolean（含 DOM Event 对象）一律忽略，改由 isFocused() 实时判定——
    // 避免 !!Event === true 把失焦事件误报为聚焦。
    function report(forced) {
      try {
        var focused = typeof forced === 'boolean' ? forced : isFocused()
        rpcCall('/dnotify', 'page-focus', {
          focused: focused,
          pageId: getPageId(),
          // 当前选中的会话（取不到就是 null：宿主对"归属不明"的通知照常推送）
          sessionId: readSessionId(),
        }).catch(function () {})
        watchSessions()  // 服务可能晚于插件就绪，借每次上报顺带补挂一次
      } catch (e) { /* ignore */ }
    }
    // 用户活动事件（节流 10s）：聚焦页面持续"保鲜"；非聚焦页不会产生活动事件
    function onActivity() {
      var now = Date.now()
      if (now - lastActivityAt < 10000) return
      lastActivityAt = now
      if (isFocused()) report()
    }

    // ---- 当前选中会话（harness 客户端 sessions 服务）----
    // sessions.list 是快照存储（SnapshotStore<SessionListState>），current 即
    // "本页面当前选中的会话"；服务可能晚于本插件就绪，故每次都惰性取。
    var ctxRef = null
    function sessionsService() {
      try {
        if (!ctxRef) return null
        var sessions = typeof ctxRef.get === 'function' ? ctxRef.get('sessions') : null
        if (!sessions && ctxRef.sessions) sessions = ctxRef.sessions
        if (sessions && sessions.list && typeof sessions.list.getSnapshot === 'function') return sessions
      } catch (e) { /* ignore */ }
      return null
    }
    function readSessionId() {
      var sessions = sessionsService()
      if (!sessions) return null
      try {
        var snap = sessions.list.getSnapshot()
        var id = snap && snap.current
        return id === undefined || id === null ? null : String(id)
      } catch (e) { return null }
    }
    var lastSessionId = null
    var sessionWatchBound = false
    var sessionDispose = null
    var teardown = null
    // 会话切换即时重报：让"切到别的会话"立刻改变静默归属，不必等下一次聚焦事件。
    function onSessionChanged() {
      var id = readSessionId()
      if (id === lastSessionId) return
      lastSessionId = id
      report()
    }
    function watchSessions() {
      if (sessionWatchBound) return
      var sessions = sessionsService()
      if (!sessions) return
      sessionWatchBound = true
      var dispose = null
      try {
        dispose = sessions.list.subscribe(function () { onSessionChanged() })
        sessionDispose = dispose
        ctxRef.effect(function () {
          return function () { try { dispose() } catch (e) { /* ignore */ } }
        })
      } catch (e) {
        // 挂不上就回滚，下一次上报再试（避免留下没人清理的订阅）
        try { if (dispose) dispose() } catch (cleanupError) { /* ignore */ }
        sessionWatchBound = false
        sessionDispose = null
      }
    }

    exports.apply = function apply(ctx) {
      // 热更新/重复加载时先撤掉上一轮的监听与订阅，避免监听器翻倍（每次都上报两遍）
      if (typeof teardown === 'function') {
        try { teardown() } catch (e) { /* ignore */ }
      }
      sessionWatchBound = false
      sessionDispose = null
      ctxRef = ctx
      var onFocus = function () { report() }
      var onBlur = function () { report() }
      var onVisibility = function () { report() }
      var onPageHide = function () { report(false) }
      lastSessionId = readSessionId()
      report()
      watchSessions()
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('pagehide', onPageHide)
      window.addEventListener('keydown', onActivity)
      window.addEventListener('mousedown', onActivity)
      window.addEventListener('pointermove', onActivity)
      window.addEventListener('scroll', onActivity, true)
      teardown = function () {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('keydown', onActivity)
        window.removeEventListener('mousedown', onActivity)
        window.removeEventListener('pointermove', onActivity)
        window.removeEventListener('scroll', onActivity, true)
        if (sessionDispose) { try { sessionDispose() } catch (e) { /* ignore */ } }
        sessionDispose = null
        sessionWatchBound = false
      }
      ctx.effect(function () { return teardown })
    }

    return module.exports
  },
})
