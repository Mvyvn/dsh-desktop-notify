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
      var STAGES = ['launcher', 'shortcut-web', 'shortcut-desktop', 'account-menu', 'plugins-panel']
      var stageIndex = 0
      var iterations = 0
      var done = false
      var modalWait = 0
      var timer = setInterval(function () {
        if (done) { clearInterval(timer); return }
        iterations += 1
        var modal = settingsModal()
        if (modal) {
          var cell = findButton(modal, /内置插件|Built-in plugins/i)
          if (cell) {
            try { (cell as HTMLElement).click() } catch (e) { /* ignore */ }
            done = true
            clearInterval(timer)
            return
          }
          // 弹窗在、导航格还没渲染完是常态（设置面板懒渲染）。以前一看到弹窗就收摊，
          // 用户会停在"设置"而不是"设置 → 内置插件"。这里最多再等 2.5s 等它渲染出来；
          // 真等不到就停下（设置已经打开了，交给用户自己点），并留一条日志。
          modalWait += 1
          if (modalWait >= 25) {
            try { console.warn('[dsh-desktop-notify] 设置已打开，但没等到「内置插件」导航格，停止尝试') } catch (e) { /* ignore */ }
            done = true
            clearInterval(timer)
          }
          return
        }
        var stage = STAGES[stageIndex]
        // 每段最多等 5 拍（500ms），全部走完 ~2s 就退到插件面板——不再让人等 6 秒
        if (iterations === 1 || iterations % 5 === 1) {
          if (stage === 'launcher') clickSettingsLauncher()
          else if (stage === 'shortcut-web') { if (!isDesktopApp()) synthesizeSettingsShortcut(true) }
          else if (stage === 'shortcut-desktop') { if (!isDesktopApp()) synthesizeSettingsShortcut(false) }
          else if (stage === 'account-menu') clickAccountMenuSettings()
          // 关键：**绝不**退到侧栏「插件」页。目标是"设置 → 内置插件"，落到「插件」页就是错的
          // （这正是用户指出的问题）。找不到入口就继续等，等不到只留日志、让用户停在原处。
          else if (stage === 'plugins-panel') { done = true; clearInterval(timer); console.warn('[dsh-desktop-notify] 没能打开设置；不降级到侧栏插件页'); return }
        }
        if (iterations % 5 === 0) stageIndex += 1
        if (stageIndex >= STAGES.length) { done = true; clearInterval(timer); console.warn('[dsh-desktop-notify] 没能打开设置；不降级到侧栏插件页') }
      }, 100)
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
    function showPermissionBanner(): void {
      if (permissionBannerShown) return
      permissionBannerShown = true
      try {
        var box = document.createElement('div')
        box.setAttribute('data-dsh-notify-banner', '1')
        box.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:50%;transform:translate(-50%,-50%);'
          + 'background:#1f2430;color:#fff;font:14px/1.6 system-ui,sans-serif;padding:18px 22px;border-radius:10px;'
          + 'box-shadow:0 10px 40px rgba(0,0,0,.45);max-width:340px;text-align:center;cursor:pointer'
        box.textContent = '点击以允许发送通知'
        box.addEventListener('click', function () {
          try { box.remove() } catch (e) { /* ignore */ }
          ensureNotifyPermission()
        })
        document.body.appendChild(box)
      } catch (e) { /* ignore */ }
    }
    function registerServiceWorker(): void {
      if (!('serviceWorker' in navigator)) return
      try {
        navigator.serviceWorker.register(ROUTE_PREFIX + '/sw.js', { scope: '/' })
          .catch(function () { return navigator.serviceWorker.register(ROUTE_PREFIX + '/sw.js') })
          .then(function (reg) {
            swRegistration = reg
            announceToServiceWorker(reg)
            navigator.serviceWorker.addEventListener('controllerchange', function () { announceToServiceWorker(reg) })
            try { navigator.serviceWorker.ready.then(function () { announceToServiceWorker(reg) }) } catch (e) { /* ignore */ }
            // SW 冷启动/被回收后映射会丢：周期性重报
            setInterval(function () {
              announceToServiceWorker(reg)
              // 顺带把权限变化告诉宿主（用户手动改过站点权限时也能收敛）
              reportSw({ kind: 'permission', state: notifyPermission(), pageId: getPageId() })
            }, 30000)
            reportSw({ kind: 'register', pageId: getPageId(), permission: notifyPermission() })
            if (notifyPermission() !== 'granted') showPermissionBanner()
          })
          .catch(function (e) {
            reportSw({ kind: 'register-error', message: String((e && e.message) || e) })
          })
      } catch (e) { /* ignore */ }
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
        // 图标走宿主路由（按主题返回 PNG；Web Notification 不认 .ico）
        icon: String(location.origin + ROUTE_PREFIX + '/icon.png'),
        pageId: getPageId(),
        target: String(envelope.target || ''),
        deepLink: String(envelope.deepLink || ''),
      })
      reportSw({ kind: 'show-request', sent: sent, permission: state, target: String(envelope.target || '') })
      if (!sent) registerServiceWorker()
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

    ;(exports as any).apply = function apply(ctx: any) {
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
