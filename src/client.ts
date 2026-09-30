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
(window as any).__ModuleLoader__.load({
  id: 'dsh-desktop-notify',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var ROUTE_PREFIX = 'dnotify'      // 文档相对：挂载在子路径下时也正确
    var FOCUS_ENDPOINT = 'page-focus'
    var EVENTS_ENDPOINT = 'events'
    var NAVIGATED_ENDPOINT = 'navigated'   // 认领后回报“到底跳没跳成”
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
    function post(endpoint: string, body?: unknown, keepalive?: boolean) {
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
    function isFocused(): boolean {
      try {
        if (document.visibilityState !== 'visible') return false
        return document.hasFocus()
      } catch (e) { return false }
    }

    // 页面唯一 id（sessionStorage 持久：同一标签页刷新后 id 不变，host 端覆盖旧条目）
    //
    // ⚠️ 浏览器的"复制标签页"会连 sessionStorage 一起复制 ⇒ 两个标签页可能拿到同一个 id，
    // 于是 focus/blur 互相覆盖、同一条跳转被两边抢（定向 SSE 会把事件发给两个标签页）。
    // 所以取到 id 之后用 BroadcastChannel 探一次：真有活着的同 id 页面就换身份，
    // 并重连 SSE（流是按 pageId 归属的）+ 重报聚焦。
    var pageId = null
    var pageIdProbed = false
    /** 生成新身份并持久化（刷新后仍是它——认领归属靠这个稳定性）。 */
    function newPageId(): string {
      return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    }
    /**
     * 身份探测：有另一个**活着**的标签页用同一个 id 时，换 id + 重连 SSE + 重报聚焦。
     * 只做一次；BroadcastChannel 不可用（老浏览器/单测环境）就保持持久化身份。
     */
    function probePageIdCollision(): void {
      if (pageIdProbed) return
      pageIdProbed = true
      try {
        var BC = (window && (window as any).BroadcastChannel)
          || (typeof BroadcastChannel === 'function' ? (BroadcastChannel as any) : null)
        if (!BC) return
        var chan = new BC('dsh-notify-pageid')
        var mine = pageId
        var taken = false
        chan.onmessage = function (ev: any) {
          var d = ev && ev.data
          if (!d) return
          if (d.probe && d.probe !== mine) { try { chan.postMessage({ alive: d.probe }) } catch (e) { /* ignore */ } ; return }
          if (d.alive === mine) taken = true
        }
        chan.postMessage({ probe: mine })
        // Node（单测）里的 BroadcastChannel 会钉住事件循环；浏览器没有 unref，跳过即可
        if (typeof chan.unref === 'function') chan.unref()
        setTimeout(function () {
          if (!taken) return
          try { console.warn('[dsh-desktop-notify] 检测到同 id 的活页面（多半是复制标签页），换用新页面身份') } catch (e) { /* ignore */ }
          pageId = newPageId()
          try { window.sessionStorage.setItem('dsh-notify-page-id', pageId) } catch (e) { /* ignore */ }
          try { closeEventStream(); openEventStream() } catch (e) { /* ignore */ }
          try { report(true) } catch (e) { /* ignore */ }
        }, 200)
      } catch (e) { /* 探测失败就用持久化身份 */ }
    }
    function getPageId(): string {
      if (pageId) return pageId
      try {
        pageId = window.sessionStorage.getItem('dsh-notify-page-id')
        if (!pageId) {
          pageId = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
          window.sessionStorage.setItem('dsh-notify-page-id', pageId)
        } else {
          probePageIdCollision()   // 持久化身份可能是"复制标签页"带过来的：探一次
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
    function nextSeq(): number {
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
    function readSessionId(): string | null {
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
    function onSessionChanged(): void {
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
    function clientService(name: string): any {
      try {
        return ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get(name) : null
      } catch (e) { return null }
    }
    function findButton(root: any, pattern: RegExp): any {
      try {
        var buttons = root.querySelectorAll('button,a,[role="menuitem"],[role="button"]')
        for (var i = 0; i < buttons.length; i++) {
          // 按**可访问名**匹配：DSH 的设置导航格把标签放在 aria-label 上，
          // 只看 textContent 会漏掉（DSH 自己的 e2e 也是 getByRole('button', { name } )）。
          var el = buttons[i]
          var label = ''
          try { label = String(el.getAttribute('aria-label') || el.getAttribute('title') || '') } catch (e) { label = '' }
          if (!label) label = String(el.textContent || '')
          label = label.replace(/\s+/g, ' ').trim()
          if (pattern.test(label)) return el
        }
      } catch (e) { /* ignore */ }
      return null
    }
    function settingsModal(): any {
      try {
        var byAttr = document.querySelector('[data-shortcut-modal="settings"]')
        if (byAttr) return byAttr
        // 真实结构是一个 role=dialog 的设置对话框（可访问名「设置」/「Settings」）。
        // 只认私有 data 属性会一直找不到弹窗 → 于是退回侧栏「插件」页，落点就错了。
        var dialogs = document.querySelectorAll('[role="dialog"]')
        for (var i = 0; i < dialogs.length; i++) {
          var name = String(dialogs[i].getAttribute('aria-label') || '').trim()
          if (/设置|Settings|首选项|Preferences/.test(name)) return dialogs[i]
        }
        return dialogs.length === 1 ? dialogs[0] : null
      } catch (e) { return null }
    }
    /** 打开插件面板（公开服务 pluginNavigation，退路 layout.selectPanel）。 */
    /**
     * 点完把焦点让出去：DSH 设置面板的导航格会留下 `:focus-visible` 的蓝白描边，
     * 用户看到的就是"莫名其妙的蓝白色边框"。合成 click 本身不动焦点，但面板打开后的焦点管理
     * 会落在第一个导航格上，所以处理完显式 blur 一次。
     */
    function blurActive(): void {
      try {
        var el: any = document.activeElement
        if (el && typeof el.blur === 'function') el.blur()
      } catch (e) { /* ignore */ }
    }
    function openPluginsPanel(): boolean {
      var nav = clientService('pluginNavigation')
      if (nav && typeof nav.openBundle === 'function') {
        try { nav.openBundle('dsh-desktop-notify'); blurActive(); return true } catch (e) { /* 试下一个 */ }
      }
      var layout = clientService('layout')
      if (layout && typeof layout.selectPanel === 'function') {
        try { layout.selectPanel('plugins'); blurActive(); return true } catch (e) { /* ignore */ }
      }
      return false
    }
    /**
     * 打开「设置 → 内置插件」。
     *
     * DSH 没有公开 API 能打开设置（状态在 ui-settings-general 的私有 store 里），但界面里有
     * 一个**稳定的入口**：侧边栏的设置按钮 `<button aria-label="设置" aria-haspopup="dialog">`
     * （0.2.0-rc.2 实测）。所以顺序改成"先点真实入口，再谈合成快捷键"：
     *   ① 设置已经打开 → 直接点「内置插件」导航格；
     *   ② 点真实设置入口（最稳、最快，~几十 ms）；
     *   ③ 合成设置快捷键（web 绑定是 primary+alt+Comma，desktop 是 primary+Comma）；
     *   ④ 插件面板（功能等价：列出/启停内置插件）。
     *
     * ⚠️ 这里**绝不**再"随便点一个 `[aria-haspopup="menu"]`"：DOM 里第一个菜单按钮通常是
     * 「在应用中打开」（文件资源管理器 / VS Code），点了会在屏幕上留下一个多余的菜单
     * ——这是 1.6.3 及以前的实际 bug。真要开菜单也必须先确认它里面有「设置」，没有就按 Esc 关掉。
     */
    function openSettingsPlugins(): boolean {
      // 深链是"刚加载完的页面"：DSH 的界面往往要几秒才挂载出来，之前 2 秒就放弃 →
      // 用户看到新 tab 开了、却停在原处。这里改成**重试到成功或超时**（10s）。
      var deadline = Date.now() + 10000
      var lastEntry = 0
      var lastCellClick = 0
      var done = false
      var timer = setInterval(function () {
        if (!clientAlive()) { clearInterval(timer); return }
        if (done) { clearInterval(timer); return }
        var modal = settingsModal()
        if (modal) {
          var cell = findButton(modal, /内置插件|Built-in plugins/i)
          if (cell) {
            // 已经是当前分区就不用再点（避免连点：合成 click 会反复触发导航）
            var current = ''
            try { current = String(cell.getAttribute('aria-current') || '') } catch (e) { current = '' }
            if (current === 'true') { done = true; clearInterval(timer); return }
            var now = Date.now()
            if (now - lastCellClick >= 600) {
              lastCellClick = now
              try { (cell as HTMLElement).click() } catch (e) { /* ignore */ }
              blurActive()
            }
            if (now > deadline) {
              done = true
              clearInterval(timer)
              try { console.warn('[dsh-desktop-notify] 点了「内置插件」但没等到它就位，停止尝试') } catch (e) { /* ignore */ }
            }
            return
          }
          // 弹窗在、导航格还没渲染完是常态（设置面板懒渲染）→ 继续等，不动作
          if (Date.now() > deadline) {
            done = true
            clearInterval(timer)
            try { console.warn('[dsh-desktop-notify] 设置已打开但没等到「内置插件」导航格，停止尝试') } catch (e) { /* ignore */ }
          }
          return
        }
        if (Date.now() > deadline) {
          done = true
          clearInterval(timer)
          try { console.warn('[dsh-desktop-notify] 没能打开设置（绝不降级到侧栏插件页）') } catch (e) { /* ignore */ }
          return
        }
        // 弹窗不在：最多每 600ms 试一次入口，优先级 真实设置按钮 → 账号菜单 → 合成快捷键
        if (Date.now() - lastEntry < 600) return
        lastEntry = Date.now()
        if (clickSettingsLauncher()) return
        if (isDesktopApp()) { clickAccountMenuSettings(); return }
        synthesizeSettingsShortcut(true)
        setTimeout(function () { if (!settingsModal()) synthesizeSettingsShortcut(false) }, 120)
      }, 120)
      return true
    }
    /** 点真实的「设置」入口（按 aria-label/title 精确匹配，不碰其它菜单）。 */
    function clickSettingsLauncher() {
      try {
        var candidates = document.querySelectorAll('button,[role="button"],a')
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i]
          var label = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim()
          if (!/^(设置|Settings|首选项|Preferences)$/.test(label)) continue
          if (el.getAttribute('aria-haspopup') === 'menu') continue   // 菜单类入口交给下面的安全路径
          try { (el as HTMLElement).click(); return true } catch (e) { /* 试下一个 */ }
        }
      } catch (e) { /* ignore */ }
      return false
    }
    /** @param {boolean} withAlt web 绑定需要 alt（0.2.0-rc.2 起），desktop 绑定不需要 */
    function synthesizeSettingsShortcut(withAlt: boolean): void {
      try {
        var Keyboard = window.KeyboardEvent || (typeof KeyboardEvent === 'function' ? KeyboardEvent : null)
        if (!Keyboard) return
        var mac = /Mac|iPhone|iPad/.test(String(navigator.platform || navigator.userAgent || ''))
        window.dispatchEvent(new Keyboard('keydown', {
          key: ',', code: 'Comma', ctrlKey: !mac, metaKey: mac, altKey: !!withAlt, bubbles: true, cancelable: true,
        }))
      } catch (e) { /* ignore */ }
    }
    /**
     * 安全地走一次"菜单 → 设置"：只考虑**看起来像账号/设置**的菜单按钮，而且必须先确认菜单里
     * 真的有「设置」才点；没有就把菜单关掉（Esc）。绝不点 DOM 里第一个 `aria-haspopup="menu"`
     * ——那通常是「在应用中打开」，会在屏幕上留下多余的菜单（1.6.3 及以前的实际 bug）。
     */
    function clickAccountMenuSettings() {
      try {
        var triggers = document.querySelectorAll('button[aria-haspopup="menu"]')
        for (var i = 0; i < triggers.length; i++) {
          var trigger = triggers[i]
          var label = String(trigger.getAttribute('aria-label') || trigger.getAttribute('title') || trigger.textContent || '')
            .replace(/\s+/g, ' ').trim()
          if (!/设置|Settings|账户|Account|用户|User|首选项|Preferences/i.test(label)) continue
          try { (trigger as HTMLElement).click() } catch (e) { continue }
          var doc = trigger.ownerDocument
          var item = findButton(doc, /^(设置|Settings)$/)
          if (item) { try { (item as HTMLElement).click() } catch (e) { /* ignore */ } }
          else {
            // 不是设置菜单：按 Esc 关掉，别把菜单留在屏幕上
            try {
              var Keyboard = window.KeyboardEvent || (typeof KeyboardEvent === 'function' ? KeyboardEvent : null)
              if (Keyboard) doc.dispatchEvent(new Keyboard('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
            } catch (e) { /* ignore */ }
          }
          return
        }
      } catch (e) { /* ignore */ }
    }
    /**
     * 切换会话。三态返回（旧版把"openSession 抛错"直接变成 `location.reload()`，
     * 而 reload 前 hash 已被清掉 → 页面原地刷新但**不跳转**，正是那个确定性 bug）：
     *   'done'      已经处理（含"本来就在这个会话"）
     *   'not-ready' uiWorkspace 还没就绪 → 交给上层重试
     *   'not-found' 会话不在客户端目录里（openSession 抛错）→ 明确失败，**不刷新**
     */
    function switchSession(id: string): string {
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
    function applyTarget(target: string): string {
      if (target === 'none' || target === '') return 'done'
      if (target.indexOf('page:settings-plugins') === 0) { openSettingsPlugins(); return 'done' }
      if (target.indexOf('page:') === 0) { openPluginsPanel(); return 'done' }
      if (target.indexOf('session:') === 0) return switchSession(target.slice('session:'.length))
      // url 目标不会投递到页面（宿主直接开系统浏览器，避免被弹窗拦截），这里只兜底忽略
      return 'done'
    }
    /**
     * 处理未就绪时有限次重试；'not-found'（会话真的不在目录里）立即放弃、绝不刷新。
     *
     * 每次拿到终态都回报一次结果：**认领成功 ≠ 跳转成功**——通知活得比会话久时
     * （会话被删/归档、客户端目录里没有它），宿主已经按"已认领"停掉了新开兜底，
     * 而这里只会得到 'not-found'。回报出去，宿主至少能留下可诊断的记录，
     * 不再是"点了通知什么都没发生，也没有任何痕迹"。
     */
    function applyTargetWithRetry(target: string, openId?: string): void {
      var first = applyTarget(target)
      if (first !== 'not-ready') { reportNavigate(openId, first); return }
      var attempts = 0
      var timer = setInterval(function () {
        if (!clientAlive()) { clearInterval(timer); return }
        attempts += 1
        var result = applyTarget(target)
        if (result !== 'not-ready' || attempts >= NAV_RETRIES) {
          clearInterval(timer)
          if (result !== 'not-ready') reportNavigate(openId, result)
        }
      }, NAV_RETRY_MS)
    }
    /** 把"这次跳转最后到底成没成"回报给宿主（尽力而为，失败只记控制台）。 */
    function reportNavigate(openId: string | undefined, result: string): void {
      if (!openId) return
      try {
        post(NAVIGATED_ENDPOINT, { pageId: getPageId(), openId: String(openId), result: String(result) })
          .catch(function () { /* ignore */ })
      } catch (e) { /* ignore */ }
      if (result === 'not-found') {
        try { console.warn('[dsh-desktop-notify] 通知已认领，但目标在客户端目录里不存在（会话可能已被删除/归档）') } catch (e) { /* ignore */ }
      }
    }
    /**
     * 让浏览器自己接管通知点击：注册插件自带的 Service Worker（**不是扩展**，无需安装）。
     *
     *   notificationclick → clients.matchAll() → WindowClient.focus()
     *     · 标签页在后台 → Firefox 自己把它交还给用户 ✓
     *     · 标签页已在前台 → focus() 基本是 no-op ✓
     * 不涉及 UIA/无障碍、SetForegroundWindow、PowerShell，也没有中转页。
     */
    var swRegistration: any = null
    function announceToServiceWorker(reg: any): void {
      try {
        var target = navigator.serviceWorker.controller || (reg && reg.active)
        if (target) target.postMessage({ type: 'register-page', pageId: getPageId() })
      } catch (e) { /* ignore */ }
    }
    function sendToServiceWorker(msg: any): boolean {
      try {
        var reg = swRegistration
        var target = navigator.serviceWorker.controller || (reg && (reg.active || reg.waiting || reg.installing))
        if (!target) return false
        target.postMessage(msg)
        return true
      } catch (e) { return false }
    }
    /** 每一步都回报宿主（/dnotify/sw/report → /status.lastSwReport）：失败不再无声。 */
    function reportSw(payload: any): void {
      try {
        fetch(ROUTE_PREFIX + '/sw/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ from: 'page' }, payload)),
        }).catch(function () { /* ignore */ })
      } catch (e) { /* ignore */ }
    }
    function notifyPermission(): string {
      try { return (typeof Notification === 'undefined') ? 'unsupported' : String(Notification.permission) } catch (e) { return 'unknown' }
    }
    /** 权限不是 granted 时申请一次；Firefox 要用户手势，所以同时给出居中提示（见 showPermissionBanner）。 */
    function ensureNotifyPermission(): void {
      var state = notifyPermission()
      if (state === 'granted') return
      if (state === 'denied' || state === 'unsupported') { reportSw({ kind: 'permission', state: state }); return }
      try {
        Notification.requestPermission().then(function (s) {
          reportSw({ kind: 'permission', state: String(s) })
          if (String(s) !== 'granted') showPermissionBanner()
        }).catch(function (e) {
          reportSw({ kind: 'permission-error', message: String((e && e.message) || e) })
        })
      } catch (e) { /* ignore */ }
    }
    /**
     * 权限不到位时的一次性居中提示：**那一次点击就是手势**，浏览器授权框随即正常弹出。
     * 不做自动弹窗（Firefox 会拒绝无手势的 requestPermission）。
     */
    var permissionBannerShown = false

    /**
     * 客户端定时器登记表：插件卸载或 HMR 重载时必须**全部**清掉 ——
     * 否则旧实例的跳转重试（最长 ~10s）、workspace 等待（最长 ~15s）与聚焦心跳会继续跑，
     * 并且和"新实例"抢着上报/跳转。
     */
    var clientTimers: any[] = []
    /** 插件卸载/HMR 后置 true：所有客户端定时器回调据此**立即自杀**（不依赖能否拿到 id）。 */
    var clientDisposed = false
    function clientAlive(): boolean { return !clientDisposed }
    /** 事件驱动之外的轮询兜底周期（只在"事件丢失"时起作用，不是主路径）。 */
    var SW_ANNOUNCE_FALLBACK_MS = 30000
    function trackTimer(id: any): any { clientTimers.push(id); return id }
    function clearClientTimers(): void {
      for (var i = 0; i < clientTimers.length; i += 1) {
        try { clearInterval(clientTimers[i]) } catch (e) { /* ignore */ }
        try { clearTimeout(clientTimers[i]) } catch (e) { /* ignore */ }
      }
      clientTimers.length = 0
      clientDisposed = true
    }

    function prefersDark(): boolean {
      try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) } catch (e) { return false }
    }

    /**
     * 解析 DSH 主题 token 的**实际颜色值**。
     *
     * 两个坑，都踩过：
     *   ① 直接写 `var(--dsw-alias-…)`：卡片挂在 `document.body` 上，而 token 定义在 DSH 自己的
     *      容器作用域里，`var()` 在 body 上取不到 → 落回兜底值（深色主题下变白板）。
     *   ② 只问 `document.documentElement`：token 通常写成 `:root{浅色}` + `.dark{深色}`，
     *      深色覆盖挂在更里层的容器上，问根元素**永远拿到浅色值** → 卡片太浅。
     * 所以：从一个 DSH 容器出发**往上走**，取最近一处有定义的值（自定义属性默认继承，
     * 元素上的 computed value 已经是当前作用域生效的那个），根元素只作最后手段。
     */
    function themeColor(name: string, lightFallback: string, darkFallback: string): string {
      var fallback = prefersDark() ? darkFallback : lightFallback
      try {
        var node: any = document.querySelector('[class*="dsw"], [data-dsw-root], #root > div, #root') || document.body
        while (node) {
          var value = getComputedStyle(node).getPropertyValue(name)
          if (value && value.trim()) return value.trim()
          node = node.parentElement
        }
      } catch (e) { /* ignore */ }
      return fallback
    }

    /**
     * 在给定底色上可读的文字颜色（sRGB 相对亮度的近似）。
     *
     * 深色主题下 `--dsw-alias-brand-primary` 本身就是**亮色**，写死白字会"字和底融成一片"，
     * 所以按底色亮度自动选深色字或白字。
     */
    function readableOn(color: string): string {
      try {
        var text = String(color || '').replace(/\s+/g, '')
        var r = 255; var g = 255; var b = 255
        if (text.charAt(0) === '#') {
          var hex = text.slice(1)
          if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2)
          r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16)
        } else {
          var m = text.match(/rgba?\(([^)]+)\)/)
          if (m) {
            var parts = m[1].split(',')
            r = parseFloat(parts[0]); g = parseFloat(parts[1]); b = parseFloat(parts[2])
          }
        }
        if (isNaN(r) || isNaN(g) || isNaN(b)) return '#ffffff'
        var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        return lum > 0.6 ? '#111111' : '#ffffff'
      } catch (e) { return '#ffffff' }
    }

    /**
     * 关掉卡片（并允许以后再次提示）。跨标签页联动：任一标签页关掉/点了「设置」，
     * 其它标签页的卡片立刻跟着关 —— 用 BroadcastChannel，老浏览器退 localStorage 事件。
     */
    var bannerClosedAt = 0
    function closePermissionBanner(broadcast: boolean): void {
      try {
        var stale = document.querySelectorAll('[data-dsh-notify-banner]')
        for (var i = 0; i < stale.length; i += 1) {
          var el = stale[i]
          if (el && el.parentNode) el.parentNode.removeChild(el)
        }
      } catch (e) { /* ignore */ }
      permissionBannerShown = false   // 解除"已提示"锁：再次降级要能重新弹
      if (!broadcast) return
      bannerClosedAt = Date.now()
      try {
        if (bannerChannel) bannerChannel.postMessage({ type: 'banner-closed' })
      } catch (e) { /* ignore */ }
      try { localStorage.setItem('dsh-notify-banner-closed', String(bannerClosedAt)) } catch (e) { /* ignore */ }
    }
    var bannerChannel: any = null
    try { bannerChannel = new (window as any).BroadcastChannel('dsh-desktop-notify') } catch (e) { bannerChannel = null }
    if (bannerChannel) {
      try {
        bannerChannel.onmessage = function (event: any) {
          if (event && event.data && event.data.type === 'banner-closed') closePermissionBanner(false)
        }
      } catch (e) { /* ignore */ }
    }
    // 监听函数要具名，才能在卸载时摘掉（客户端测试会检查"所有 DOM 监听器都要摘掉"）
    var onBannerStorage = function (event: any): void {
      if (event && event.key === 'dsh-notify-banner-closed') closePermissionBanner(false)
    }
    try { window.addEventListener('storage', onBannerStorage) } catch (e) { /* ignore */ }

    function showPermissionBanner(): void {
      if (permissionBannerShown) return
      permissionBannerShown = true
      try {
        // 先清掉可能残留的旧卡片（旧版本 client.js 留下的、或上一轮没关干净的）
        try {
          var old = document.querySelectorAll('[data-dsh-notify-banner]')
          for (var k = 0; k < old.length; k += 1) {
            if (old[k] && old[k].parentNode) old[k].parentNode.removeChild(old[k])
          }
        } catch (e) { /* ignore */ }

        // 与 DSH 自己的弹窗（ui-primitives/Modal.module.css）逐项对齐：
        //   卡片背景 --dsw-alias-bg-layer-2（不是 bg-overlay：深色主题下 overlay 是中灰 rgb(97,102,107)，
        //   layer-2 是 rgb(44,44,46)，和 DSH 弹窗一致；浅色主题下两者都接近纯白）
        //   遮罩 --dsw-alias-bg-mask-1（浅色 rgba(0,0,0,.24) / 深色 .5）、圆角 radius-panel、投影 elevation-prominent
        var bg = themeColor('--dsw-alias-bg-layer-2', '#ffffff', '#2c2c2e')
        var mask = themeColor('--dsw-alias-bg-mask-1', 'rgba(0,0,0,.24)', 'rgba(0,0,0,.5)')
        var radius = themeColor('--dsw-radius-panel', '12px', '12px')
        var elevation = themeColor('--dsw-elevation-prominent', '0 12px 40px rgba(0,0,0,.35)', '0 12px 40px rgba(0,0,0,.5)')
        var label1 = themeColor('--dsw-alias-label-primary', '#111111', '#f5f5f5')
        var label2 = themeColor('--dsw-alias-label-secondary', '#6b6b6b', '#a8a8a8')
        var border2 = themeColor('--dsw-alias-border-l2', 'rgba(0,0,0,.18)', 'rgba(255,255,255,.20)')
        var brand = themeColor('--dsw-alias-brand-primary', '#4c6ef5', '#6b8afd')
        var layer2 = themeColor('--dsw-alias-bg-layer-2', '#f2f2f2', '#3a3a3a')

        // 模态：遮罩 + 卡片（结构与 DSH 自己的弹窗一致：标题 / 说明 / 右下角两个按钮）
        var box = document.createElement('div')
        box.setAttribute('data-dsh-notify-banner', '1')
        box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;'
          + 'justify-content:center;background:' + mask

        var card = document.createElement('div')
        card.setAttribute('role', 'dialog')
        card.setAttribute('aria-label', '开启桌面通知')
        card.style.cssText = 'background:' + bg + ';color:' + label1 + ';'
          + 'border:none;border-radius:' + radius + ';'
          + 'box-shadow:' + elevation + ';padding:20px 22px;max-width:400px;width:calc(100% - 48px);'
          + 'font:inherit'

        var title = document.createElement('div')
        title.textContent = '开启桌面通知'
        title.style.cssText = 'font-size:15px;font-weight:600;line-height:22px;margin-bottom:6px'

        var desc = document.createElement('div')
        desc.textContent = 'DSH 需要浏览器通知权限才能把提醒直接送到桌面。点「设置」立即申请；'
          + '也可以稍后在浏览器的站点设置里允许。'
        desc.style.cssText = 'color:' + label2 + ';font-size:13px;line-height:20px;margin-bottom:16px'

        var actions = document.createElement('div')
        actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'

        // 按钮：DSH 的度量（高 32px、圆角 8px、内边距 0 16px、正文 13px）
        var btn = 'height:32px;padding:0 16px;border-radius:8px;cursor:pointer;font:inherit;font-size:13px;'
          + 'line-height:1;display:inline-flex;align-items:center;justify-content:center'

        var cancel = document.createElement('button')   // 取消：不弹授权框，只关掉
        cancel.type = 'button'
        cancel.textContent = '取消'
        cancel.style.cssText = btn + ';background:' + layer2 + ';color:' + label1 + ';border:1px solid ' + border2
        cancel.addEventListener('click', function () { closePermissionBanner(true) })

        var accept = document.createElement('button')   // 设置：弹浏览器授权框
        accept.type = 'button'
        accept.textContent = '设置'
        accept.style.cssText = btn + ';background:' + brand + ';color:' + readableOn(brand) + ';border:none'
        accept.addEventListener('click', function () {
          closePermissionBanner(true)
          ensureNotifyPermission()
        })

        actions.appendChild(cancel)
        actions.appendChild(accept)
        card.appendChild(title)
        card.appendChild(desc)
        card.appendChild(actions)
        box.appendChild(card)
        document.body.appendChild(box)
      } catch (e) { /* ignore */ }
    }
    /**
     * 权限变化事件管线：`navigator.permissions.query({name:'notifications'})` 返回的
     * PermissionStatus 带 `onchange` —— 用户在站点设置里允许/阻止时会**立即**触发，
     * 不必等下一次聚焦上报（旧做法就是靠聚焦上报与 30 秒轮询，可能要等一会儿才发现）。
     * 变化时：① 立刻回报宿主（宿主据此切渠道，必要时弹一条"已切换为降级模式"的原生提醒）；
     * ② 掉到非 granted 时把授权提示重新显示出来。
     */
    var permissionStatus: any = null
    function watchNotifyPermission(): void {
      try {
        var perms = (navigator as any).permissions
        if (!perms || typeof perms.query !== 'function') return
        perms.query({ name: 'notifications' }).then(function (status) {
          permissionStatus = status
          var fire = function () {
            var state = String(status.state || notifyPermission())
            reportSw({ kind: 'permission', state: state, pageId: getPageId() })
            // 恢复权限后解除"已提示过"的锁：再次掉到不可用时**必须**重新弹卡片
            // （旧实现把卡片当成一次性开关，第二次降级就再也不提示了）
            if (state === 'granted') permissionBannerShown = false
            else showPermissionBanner()
          }
          status.onchange = fire
          fire()   // 查询一次就把当前状态报上去（省掉"注册后再等一轮"）
        }).catch(function () { /* 不支持 permissions.query（老浏览器）→ 退回聚焦上报 */ })
      } catch (e) { /* ignore */ }
    }
    // SW 事件（具名函数：卸载时要摘掉，否则 HMR 后新旧实例各报一次）
    var onSwControllerChange = function (): void { announceToServiceWorker(swRegistration) }
    var onSwReAnnounce = function (event: any): void {
      var msg = event && event.data
      // SW 冷启动/被回收后它的 pageId→clientId 映射会丢，由 SW 主动要求重报 ——
      // 事件驱动，取代原来的「每 30 秒轮询重报」。
      if (msg && msg.type === 're-announce') announceToServiceWorker(swRegistration)
    }
    var swRegisterPromise: Promise<any> | null = null
    /** 接线只做一次：注册、监听、权限观察、首次回报。 */
    function wireServiceWorker(reg: any): void {
      swRegistration = reg
      announceToServiceWorker(reg)
      navigator.serviceWorker.addEventListener('controllerchange', onSwControllerChange)
      navigator.serviceWorker.addEventListener('message', onSwReAnnounce)
      try { navigator.serviceWorker.ready.then(function () { announceToServiceWorker(reg) }) } catch (e) { /* ignore */ }
      reportSw({ kind: 'register', pageId: getPageId(), permission: notifyPermission() })
      if (notifyPermission() !== 'granted') showPermissionBanner()
      watchNotifyPermission()
      // 纯事件驱动：focus/visibility/pagehide/controllerchange + SW 主动要求重报
      // （SW 被回收后它自己会要一轮；映射另有 IndexedDB 持久化，不需要页面轮询）。
    }
    /**
     * 幂等注册：`openEventStream()` 与「投递失败重试」两处都会调它。旧实现每次都重新
     * register 并再挂一遍 controllerchange 监听、再加一个 30 秒定时器，于是同一次启动会
     * 出现多个监听器/定时器（生命周期泄漏 + 重复上报）。现在复用同一个 promise：
     * 失败时清空以便下次重试，但**不会**重复接线。
     */
    function registerServiceWorker(): Promise<any> | null {
      if (!('serviceWorker' in navigator)) return null
      if (swRegisterPromise) return swRegisterPromise
      try {
        swRegisterPromise = navigator.serviceWorker.register(ROUTE_PREFIX + '/sw.js', { scope: '/' })
          .catch(function () { return navigator.serviceWorker.register(ROUTE_PREFIX + '/sw.js') })
          .then(function (reg) { wireServiceWorker(reg); return reg })
          .catch(function (e) {
            reportSw({ kind: 'register-error', message: String((e && e.message) || e) })
            swRegisterPromise = null   // 允许重试；接线仍然只有成功那次
            return null
          })
      } catch (e) { swRegisterPromise = null }
      return swRegisterPromise
    }
    // SW → 页面：点击通知后要求把目标会话切过来
    try {
      navigator.serviceWorker.addEventListener('message', function (event) {
        var msg = event && event.data
        if (!msg || msg.type !== 'dsh-navigate') return
        reportSw({ kind: 'navigate-from-sw', target: String(msg.target || '') })
        if (msg.target) applyTargetWithRetry(String(msg.target))
      })
    } catch (e) { /* ignore */ }
    /**
     * 通知内容到达（正式路径 `notify` 与验证用 `poc-notify` 共用本处理器）：
     * 交给 SW 显示系统通知；点击时由 SW 精确激活本标签页并把 target 送回来。
     */
    function showNotificationFor(envelope: any): void {
      var state = notifyPermission()
      if (state !== 'granted') { ensureNotifyPermission(); showPermissionBanner() }
      var sent = sendToServiceWorker({
        type: 'show-notification',
        title: String(envelope.title || 'DSH 通知'),
        body: String(envelope.body || '点击查看'),
        tag: String(envelope.tag || ('dsh-' + String(envelope.id || Date.now()))),
        pageId: getPageId(),
        target: String(envelope.target || ''),
        deepLink: String(envelope.deepLink || ''),
      })
      reportSw({ kind: 'show-request', sent: sent, permission: state, tag: String(envelope.tag || ''), target: String(envelope.target || '') })
      if (!sent) {
        // 通知没能交给 SW（SW 还没 ready / 页面刚加载）：立刻上报失败，
        // 让宿主用原生 Toast 兜底，而不是干等满 ACK 期限。
        reportSw({ kind: 'show-error', tag: String(envelope.tag || ''), message: 'sw-not-ready' })
        registerServiceWorker()
      }
    }
    /** 认领**这一次**点击：带 openId，连点两条通知也不会认领错。 */
    function claimOpen(openId: string): void {
      var body = { pageId: getPageId(), openId: String(openId) }
      post(CLAIM_ENDPOINT, body).then(function (res) {
        if (res && res.ok === true && res.target) {
          // 页面可能在后台标签里：先请求把本窗口带到前台（浏览器可以忽略，忽略也无害），
          // 再把目标落到 UI 上——否则用户会觉得"点了没反应"。
          try { window.focus() } catch (e) { /* ignore */ }
          applyTargetWithRetry(String(res.target), openId)
        } else if (res && res.reason === 'not-owner') {
          // 本页的 pageId 在宿主那边已经过期（例如刷新过/身份被覆盖）：重报一次身份，
          // 下一次点击就能找到我。绝不静默丢弃。
          try { console.warn('[dsh-desktop-notify] 这次点击不属于本页面，已重报身份') } catch (e) { /* ignore */ }
          report(true)
        } else if (res && res.ok === false) {
          try { console.warn('[dsh-desktop-notify] 认领失败:', res.reason) } catch (e) { /* ignore */ }
        }
      }).catch(function () { /* 宿主不可达：忽略，下次事件再说 */ })
    }
    /**
     * 常驻 SSE：宿主把点击**定向**推给某个页面（此刻聚焦的，或最后用过且仍在线的），
     * 从不广播——所以这里把 pageId 一并报上去，宿主才知道哪条连接是谁。
     */
    function openEventStream(): void {
      if (eventStream) return
      if (typeof window.EventSource !== 'function') return
      registerServiceWorker()
      try {
        eventStream = new window.EventSource(ROUTE_PREFIX + '/' + EVENTS_ENDPOINT
          + '?pageId=' + encodeURIComponent(getPageId()))
        eventStream.addEventListener('navigate', function (event) {
          var envelope = null
          try { envelope = JSON.parse((event && event.data) || '{}') } catch (e) { envelope = null }
          if (!envelope || !envelope.id) return
          // 不在这里按 targetPageId 过滤：过滤掉就变成"静默失败"（宿主以为投递成功）。
          // 归属由宿主在 /claim 里裁决；被拒时重报一次身份自愈（pageId 变过的情况）。
          claimOpen(String(envelope.id))
        })
        // 通知内容到达：交给 SW 显示系统通知（正式路径 notify 与验证用 poc-notify 共用）
        var onNotify = function (event) {
          var envelope = null
          try { envelope = JSON.parse((event && event.data) || '{}') } catch (e) { envelope = null }
          if (envelope) showNotificationFor(envelope)
        }
        eventStream.addEventListener('notify', onNotify)
        eventStream.addEventListener('poc-notify', onNotify)
        eventStream.addEventListener('error', function () {
          // EventSource 自己会按 retry 重连；这里只在彻底关闭时清空引用
          try { if (eventStream && eventStream.readyState === 2) eventStream = null } catch (e) { /* ignore */ }
        })
      } catch (e) { eventStream = null }
    }
    function closeEventStream(): void {
      if (!eventStream) return
      try { eventStream.close() } catch (e) { /* ignore */ }
      eventStream = null
    }
    /** hash 深链（没有已打开页面时宿主 302 过来，或用户手动打开）：就地处理。 */
    function handleHashTarget(): void {
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
    function isDesktopApp(): boolean {
      // DSH 桌面端（Electron）由 preload 在 <html data-platform=…> 上标出平台。关键差异：
      // 桌面端的快捷键由**原生输入**接管，合成 DOM keydown 不会触发命令，所以那边只走
      // “点真实入口”这条路，不用白等两段快捷键超时（也少一次无意义的 DOM 事件）。
      try {
        var el = document && document.documentElement
        return !!(el && el.dataset && el.dataset.platform)
      } catch (e) { return false }
    }
    function waitForWorkspaceThen(raw: string): void {
      var attempts = 0
      var timer = setInterval(function () {
        if (!clientAlive()) { clearInterval(timer); return }
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
    function report(forced?: boolean, keepalive?: boolean) {
      try {
        var focused = typeof forced === 'boolean' ? forced : isFocused()
        post(FOCUS_ENDPOINT, {
          focused: focused,
          pageId: getPageId(),
          // 单调序号：宿主的页面注册表据此丢弃乱序到达的旧状态
          seq: nextSeq(),
          // 当前选中的会话（取不到就是 null：宿主对"归属不明"的通知照常推送）
          sessionId: readSessionId(),
          // 通知权限一起带上：用户可能在站点设置里手动允许过（不经过我们的申请流程），
          // 而宿主的分流要靠它决定走浏览器通知还是降级到原生 Toast。
          permission: notifyPermission(),
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

    /**
     * 插件设置页（挂 `plugins.row.config`，与 dsh-path-guard 同一做法）。
     *
     * - 组件只 `require('react')`（平台种子模块），**不 import 任何 `@deepseek-ai/dsh-client-*`**；
     * - 读写走 `ctx.configForms.get(命名空间)`，命名空间 = profile patch 里的 **row id**（desktop-notify）；
     *   写入由 settings 服务原子写回 `cordis.patch.yml` 并原地重载插件，**不需要重启**；
     * - 只有宿主 `Config` 里标了 `.volatile()` 的字段可写（见 src/config.ts）；
     * - 样式全用主题 token（`--dsw-alias-*` / `--dsw-radius-*`），深浅色自动跟随。
     */
    var SETTINGS_NS = 'desktop-notify'
    var SETTINGS_PKG = 'dsh-desktop-notify'
    var KIND_LABELS: Record<string, string> = {
      task: '任务完成', ask: '等待你的输入', denied: '操作被自动拒绝', subagent: '后台子代理结束',
      goal: '目标完成/阻塞', jobs: '后台任务结束', schedule: '定时任务已启动', team: '团队任务',
      compaction: '上下文压缩', startup: '启动播报（插件挂载）', permission: '通知权限变更',
    }
    var KIND_ORDER = Object.keys(KIND_LABELS)

    function settingsSection(ctx: any): any {
      var React = require('react')
      var h = React.createElement
      var forms = ctx.configForms
      var form = forms && typeof forms.get === 'function' ? forms.get(SETTINGS_NS) : null

      function useSnapshot() {
        var pair = React.useState(form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : null)
        var snap = pair[0]
        var setSnap = pair[1]
        React.useEffect(function () {
          if (!form || typeof form.subscribe !== 'function') return undefined
          setSnap(form.getSnapshot())
          return form.subscribe(function () { setSnap(form.getSnapshot()) })
        }, [])
        return snap
      }

      var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' }
      var labelStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: '13px' }
      var subStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' }

      function Box(props: any) {
        return h('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-lg, 10px)', padding: '12px 14px', marginTop: '10px' } }, props.children)
      }
      function Toggle(props: any) {
        return h('label', { style: rowStyle },
          h('input', {
            type: 'checkbox', checked: props.checked === true, disabled: props.disabled === true,
            'data-dsh-notify-setting': props.field,
            onChange: function (event: any) { props.onChange(event.target.checked) },
          }),
          h('span', { style: labelStyle }, props.label),
          props.hint ? h('span', { style: subStyle }, props.hint) : null)
      }

      function Section(props: any) {
        var snap = useSnapshot()
        // summary 视图（插件卡片上的一行摘要）
        if (props && props.view === 'summary') {
          return h('span', { style: subStyle }, '桌面通知设置')
        }
        if (!form || !snap || snap.status !== 'ready') {
          return h('div', { style: subStyle }, snap && snap.status === 'unavailable' ? '该插件当前不可配置（宿主未提供 Config）' : '正在读取配置…')
        }
        var value = snap.value || {}
        var writable = snap.writable !== false
        var types = Array.isArray(value.types) ? value.types.slice() : []
        function setType(kind: string, patch: any) {
          var found = false
          var next = types.map(function (row: any) {
            if (row && row.kind === kind) { found = true; return Object.assign({}, row, patch) }
            return row
          })
          if (!found) next.push(Object.assign({ kind: kind, enabled: true, silence: 'session' }, patch))
          return form.set('types', next)
        }
        function rowOf(kind: string) {
          for (var i = 0; i < types.length; i += 1) if (types[i] && types[i].kind === kind) return types[i]
          return { kind: kind, enabled: true, silence: 'session' }
        }
        return h('div', { 'data-dsh-notify-settings': '1' },
          h('div', { style: labelStyle }, 'dsh-desktop-notify 运行模式与推送开关'),
          h(Box, null,
            h(Toggle, { field: 'enabled', label: '总开关', checked: value.enabled !== false, disabled: !writable, hint: '关闭后本插件不推送任何通知', onChange: function (v: boolean) { form.set('enabled', v) } }),
            h(Toggle, { field: 'debug', label: '调试模式', checked: value.debug === true, disabled: !writable, hint: '状态日志写入 $DSH_HOME/logs/dsh-desktop-notify/', onChange: function (v: boolean) { form.set('debug', v) } }),
            h(Toggle, { field: 'apiEnabled', label: '对外 API', checked: value.apiEnabled !== false, disabled: !writable, hint: '允许其它插件经 ctx.get(\'desktopNotify\') 推送', onChange: function (v: boolean) { form.set('apiEnabled', v) } })),
          h('div', { style: Object.assign({}, labelStyle, { marginTop: '14px' }) }, '各预设推送'),
          h(Box, null,
            KIND_ORDER.map(function (kind) {
              var row = rowOf(kind)
              return h('div', { key: kind, style: rowStyle },
                h('input', {
                  type: 'checkbox', checked: row.enabled !== false, disabled: !writable,
                  'data-dsh-notify-kind': kind,
                  onChange: function (event: any) { setType(kind, { enabled: event.target.checked }) },
                }),
                h('span', { style: Object.assign({}, labelStyle, { minWidth: '140px' }) }, KIND_LABELS[kind]),
                h('select', {
                  value: row.silence === 'never' ? 'never' : 'session', disabled: !writable,
                  'data-dsh-notify-silence': kind,
                  style: { font: 'inherit', fontSize: '12px', background: 'transparent', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm, 6px)', padding: '2px 6px' },
                  onChange: function (event: any) { setType(kind, { silence: event.target.value }) },
                },
                h('option', { value: 'session' }, '看着该会话时静默'),
                h('option', { value: 'never' }, '从不静默')))
            })),
          h('div', { style: Object.assign({}, subStyle, { marginTop: '10px' }) }, '改动即时生效（写入 profile 的 cordis.patch.yml 并原地重载，无需重启）。'))
      }
      return Section
    }

    /** 注册设置页：插件卡片（row）与 bundle 两处入口都挂上。 */
    function installSettingsPage(ctx: any): void {
      try {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return
        var Section = settingsSection(ctx)
        ctx.slots.inject('plugins.row.config', function () {
          return ctx.slots.register({ name: 'plugins.row.config', key: SETTINGS_PKG + '#' + SETTINGS_NS }, Section)
        })
        ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register({ name: 'plugins.bundle.config', key: SETTINGS_PKG }, Section)
        })
      } catch (e) { /* 没有 slot 服务（旧 DSH / 非 Web）就跳过设置页 */ }
    }

    ;(exports as any).name = 'dsh-desktop-notify'
    // slots/configForms/locale 是设置页要用的客户端服务；缺它们时 apply 仍会被调用，
    // installSettingsPage 里再做一次能力检查（旧 DSH 上只是没有设置页）。
    ;(exports as any).inject = ['slots', 'configForms']
    ;(exports as any).apply = function apply(ctx: any) {
      ctxRef = ctx
      installSettingsPage(ctx)
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
          if (!clientAlive()) { clearInterval(heartbeat); return }
          if (isFocused()) report()
        }, HEARTBEAT_MS)

        return function () {
          clearInterval(heartbeat)
          // 客户端自己的定时器全部清掉（跳转重试、workspace 等待、冲突探测…），
          // 否则 HMR/卸载后旧实例还会继续跑并与新实例抢着上报/跳转。
          clearClientTimers()
          // SW 事件监听也要摘（否则 HMR 后新旧实例各报一次 register/permission）
          try { navigator.serviceWorker.removeEventListener('controllerchange', onSwControllerChange) } catch (e) { /* ignore */ }
          try { navigator.serviceWorker.removeEventListener('message', onSwReAnnounce) } catch (e) { /* ignore */ }
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
          try { window.removeEventListener('storage', onBannerStorage) } catch (e) { /* ignore */ }
          try { if (bannerChannel) bannerChannel.close() } catch (e) { /* ignore */ }
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
