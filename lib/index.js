// DSH 桌面通知 — 常驻 host 插件（web-profile bundle，免审批，随 dsh web 启动加载）。
//
// 监听宿主事件 → 组装文案 → 按平台交给发送层发系统通知：
//   Windows → lib/winrt.js（koffi 直调 WinRT 发 Toast，首次发送补写 AUMID 注册表图标）
//   Linux   → lib/toast-linux.js（纯 JS 直连 D-Bus，与主题跟踪共用一条常驻连接）
// 图标与系统主题：lib/theme.js 做模式检查（Windows 读注册表、Linux 查 portal）并跟踪
// 切换事件（RegNotifyChangeKeyValue / SettingChanged），发送时按当前主题选
// assets/dsh-{dark,light}.{png,ico}——浅色背景下白图标会看不见。
//
// 聚焦门控由浏览器半区 lib/client.js 经官方 Connection RPC 通道 /dnotify 上报：
// 上报内容 = 该页面是否聚焦 + 该页面当前选中的会话 id；宿主据此**按会话**判定——
// 只有"你正在看的那个会话"的通知静默，其它会话（以及归属不明的通知）照常推送。
//
// 通知类别：
//   ✅ 任务完成      agent/status running→idle（仅根 agent，3s 去抖）
//   ❓ 等待你回答    tools/execute 捕获 ask_user_question 派发
//   🚫 审批被自动拒绝 session/event 流 approval/asked+decided 审计对（never 政策下
//                     approval/request waterfall 不会派发，只能走会话日志）
//   🤖 后台子代理结束 subagent/end
//   🎯 目标完成/阻塞 goal/changed
//   🧰 后台任务结束  jobs.events 的 settled 事件（0.1.7 起 onJobDone 已移除）
//
// 另外对外提供 ctx.get('desktopNotify') 服务（见 lib/api.js），其它插件可直接推送。

import { createFocusGate, sessionIdList } from './gate.js'
import { createNotifyApi } from './api.js'
import { createBoundedMap, createDeduper } from './state.js'
import { truncateText } from './text.js'
import { startThemeWatch, stopThemeWatch } from './theme.js'

// 发送层按平台动态加载：win32 之外**绝不能** import winrt.js
// （它顶层 koffi.load('combase.dll') 在非 Windows 平台会直接失败）。
const BACKENDS = { win32: './winrt.js', linux: './toast-linux.js' }
const backend = BACKENDS[process.platform] ? await import(BACKENDS[process.platform]) : null
let warnedNoBackend = false

/** 发送一条系统通知（各平台发送层都不阻塞调用方）。 */
function sendToast(item) {
  if (backend) return backend.sendToast(item)
  if (!warnedNoBackend) {
    warnedNoBackend = true
    console.error(`[dsh-desktop-notify] 当前平台（${process.platform}）暂无通知后端，已跳过发送`)
  }
}

export const name = 'dsh-desktop-notify'
// connection/timer/webServer 是必需服务；jobs/sessions/sessionTitle/agents/fs 都是可选的，
// 一律用 ctx.get / ctx.inject 惰性取——写进 inject 会让缺服务的组合整个插件不加载。
//
// ⚠️ webServer 必须在这里，不能只靠 ctx.inject([...]) 里那个子 ctx：
// DSH 的 `connection.rpc` 取值器把 owner 解析成**当前活动 fiber 的 ctx**（rpc-host.ts:86-93），
// 再用 `owner.webServer.register(route)` 挂路由（:171-195）。实测（0.1.7-rc.2）在
// `ctx.inject(['connection','webServer'], scope => scope.connection.rpc.handle(...))` 里，
// 活动 fiber 仍是插件自己的 fiber → owner.webServer 触发注入守卫
// `cannot get property "webServer" without inject` → 路由静默没挂上（HTTP 表现：405/404）。
// 把 webServer 写进插件 inject 后 owner 就能读到它，通道正常注册。
// 代价：没有 web 服务的组合里本插件会停在"等待 webServer"——但 connection 本身就
// 传递依赖 webServer，插件一半功能也依赖浏览器页面，这个依赖是诚实的。
export const inject = ['connection', 'timer', 'webServer']

/** 主题跟踪的持有者标记（模块级单例状态，见 apply 里的说明）。 */
let themeHolder = null

/** 点击令牌：/dnotify/click 用它标记"这条通知是本进程发出的"。 */
function randomToken() {
  try {
    const bytes = new Uint8Array(12)
    globalThis.crypto.getRandomValues(bytes)
    return Buffer.from(bytes).toString('base64url')
  } catch (e) {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  }
}

/** 点击目标的白名单：session:<id> / page:<名字>（客户端只认这几类）。 */
function isValidTarget(target) {
  return typeof target === 'string'
    && (/^session:[A-Za-z0-9._:-]{1,200}$/.test(target) || /^page:[a-z-]{1,40}$/.test(target))
}

// 点击令牌放 globalThis：热更新/替换插件文件会让 apply 重跑，若每次都换新令牌，
// 之前发出的通知立刻失效（实测：点旧通知返回 403 forbidden）。
const TOKEN_FLAG = '__dshDesktopNotifyClickToken'

// 启动播报只做一次：进程级标记（放 globalThis，模块被 HMR 重新求值也不会重播）。
const STARTUP_FLAG = '__dshDesktopNotifyStartupReported'
// cordis 的 FiberState 是 const enum（编译期内联），运行时只有数字：
// PENDING=0 LOADING=1 ACTIVE=2 FAILED=3 DISPOSED=4 UNLOADING=5
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

// 上限常量集中在这里，便于一眼看清常驻进程里的内存边界。
/** 每会话"最近一条回复摘要"的条数上限。 */
const MAX_LAST_TEXT = 128
/** 待裁决审批（等 approval/decided 配对）的条数上限。 */
const MAX_PENDING_ASKS = 64
/** "提问时刻"记录的条数上限（15s 内抑制任务完成通知）。 */
const MAX_ASK_AT = 32
/** 待发通知队列上限：发送层持续失败时不能无限堆积。 */
const MAX_QUEUE = 32
/** 同一文案的去重窗口：事件重发/重试时不连弹两条。 */
const DEDUPE_MS = 1500
/** 去重记忆条数：窗口内不同文案的峰值高于此值时，旧 key 会被淘汰而可能重复弹。 */
const DEDUPE_KEYS = 64

// 调试日志开关（默认关闭）：config.debug 由插件行的 config 提供（cordis.patch.yml），
// 关闭时终端不输出任何 [dsh-desktop-notify] 状态信息，避免污染终端上下文。
// 开启方法：在 profile 的 cordis.patch.yml 中覆盖 desktop-notify 行：
//   - id: desktop-notify
//     config: { debug: true }
export function apply(ctx, config) {
  const DEBUG = !!(config && config.debug)
  const log = (...args) => { if (DEBUG) console.log(...args) }
  // 发送出口：默认走平台发送层；config.sender 用于测试与嵌入宿主
  // （YAML 里给不出函数，所以它是代码级配置，不占用户可见的开关面）。
  const sink = typeof (config && config.sender) === 'function'
    ? config.sender
    : (item) => sendToast(item)
  const hasSink = typeof (config && config.sender) === 'function' || !!backend
  const state = {
    cwd: '',
    workspaceName: '',
    // 全部有界：常驻宿主里按会话累积的缓存不能无限增长
    lastTextBySession: createBoundedMap(MAX_LAST_TEXT),
    askAtBySession: createBoundedMap(MAX_ASK_AT),
    asksById: createBoundedMap(MAX_PENDING_ASKS),
    pendingIdle: new Map(),
  }
  const shouldSend = createDeduper(DEDUPE_MS, DEDUPE_KEYS)
  // 聚焦门控：按"页面 × 会话"判定（纯逻辑在 lib/gate.js，便于单测）。
  // 聚焦静默超时 2 分钟：聚焦页面无任何用户活动上报视为失焦——同时覆盖
  // "用户聚焦静止"与"页面崩溃无上报"（浏览器半区有 1 分钟心跳兜底）；
  // 页面条目 10 分钟无上报自动清理。
  const gate = createFocusGate()

  // 按会话动态解析工作区名：会话 header.cwd 是它所属工作区；取不到回退启动时默认值。
  // 多工作区并行时，每个会话的通知前缀显示自己的工作区。
  function workspaceNameFor(sessionOrId) {
    try {
      const sessions = ctx.get('sessions')
      let sess = sessionOrId
      if (typeof sess === 'string') {
        if (sessions === undefined || typeof sessions.get !== 'function') return state.workspaceName
        sess = sessions.get(sess)
      }
      const cwd = sess && sess.header && sess.header.cwd
      if (typeof cwd === 'string' && cwd) return basename(cwd)
    } catch (e) { /* ignore */ }
    return state.workspaceName
  }
  // 统一消息前缀：工作区/会话名:正文（会话标题取不到则只带工作区）
  function sessionTitleText(sessionOrId) {
    const st = ctx.get('sessionTitle')
    if (st === undefined || typeof st.get !== 'function') return ''
    try {
      let sess = sessionOrId
      if (typeof sess === 'string') {
        const sessions = ctx.get('sessions')
        if (sessions !== undefined && typeof sessions.get === 'function') sess = sessions.get(sess)
        if (!sess) return ''
      }
      const snap = st.get(sess)
      if (snap && typeof snap.title === 'string') return snap.title
    } catch (e) { /* ignore */ }
    return ''
  }
  function locPrefix(extraTitle, sessionOrId) {
    const ws = workspaceNameFor(sessionOrId)
    if (ws) return extraTitle ? ws + '/' + extraTitle : ws
    return extraTitle || ''
  }
  // 一次算好"前缀:正文"，避免同一个表达式里重复解析工作区/会话标题
  function withPrefix(extraTitle, sessionOrId, body) {
    const prefix = locPrefix(extraTitle, sessionOrId)
    return prefix ? prefix + ':' + body : body
  }
  // 子会话 → 主会话对象（经 header.parentSession 回溯；取不到返回 undefined）。
  // 注意 parentSession 也用于"fork 出来的会话"，这里只服务于 subagent/end，
  // 传入的必然是子代理会话，直接回溯即可。
  function mainSessionFor(subId) {
    try {
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.get !== 'function') return undefined
      const sub = sessions.get(subId)
      if (!sub) return undefined
      const parent = sub.header && sub.header.parentSession
      if (!parent) return sub
      return typeof parent === 'string' ? sessions.get(parent) : parent
    } catch (e) { return undefined }
  }
  function basename(p) {
    const norm = String(p).replace(/[\\/]+$/, '')
    const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
    return i >= 0 ? norm.slice(i + 1) : norm
  }
  // 根 agent 判定：优先问 agents 服务；服务缺失或此时一个根都没有时，退回会话谱系
  // （子代理会话带 header.origin === 'subagent' / delegationDepth）。
  // 旧实现只看 roots()，一旦拿到空数组就把**所有**任务完成通知静默丢掉。
  function isRootAgent(agent) {
    const agentsSvc = ctx.get('agents')
    if (agentsSvc !== undefined && typeof agentsSvc.roots === 'function') {
      try {
        const roots = agentsSvc.roots()
        if (Array.isArray(roots) && roots.length > 0) {
          return roots.some((a) => a && String(a.id) === String(agent.id))
        }
      } catch (e) { /* 落到会话谱系判断 */ }
    }
    const header = agent.session && agent.session.header
    return !(header && (header.origin === 'subagent' || (header.delegationDepth || 0) > 0))
  }
  // 记录"提问时刻"（15s 内抑制任务完成通知）。有界容器会按写入顺序淘汰旧条目。
  function rememberAskAt(id) {
    state.askAtBySession.set(id, Date.now())
  }
  // 记录待裁决的审批（等 approval/decided 配对）。孤儿条目（会话被中断、宿主在裁决前
  // 退出）永远不会被删除，常驻进程里必须有上限兜底：有界容器先丢最旧的。
  function rememberAsk(id, info) {
    state.asksById.set(id, info)
  }

  const timers = new Set()
  // 主题跟踪：启动时读一次系统深浅色，之后跟随平台的切换事件（失败只降级不报错）。
  // ⚠️ 主题状态是模块级单例：若宿主热更新出现"新 apply 先跑、旧 cleanup 后跑"的顺序，
  // 旧的那次 stopThemeWatch 会把新监听停掉——所以按"持有者"判定，只有最后一任才停。
  themeHolder = {}
  const myThemeHold = themeHolder
  void startThemeWatch().then((theme) => {
    log(`[dsh-desktop-notify] theme: ${theme}`)
  }, () => { /* ignore */ })

  ctx.effect(() => () => {
    for (const cancel of timers) {
      try { cancel() } catch (e) { /* ignore */ }
    }
    timers.clear()
    if (themeHolder === myThemeHold) stopThemeWatch()
    // Linux 发送层持有常驻 D-Bus 连接，卸载时一并关掉
    if (backend && typeof backend.closeToastConnection === 'function') {
      try { backend.closeToastConnection() } catch (e) { /* ignore */ }
    }
  })
  function later(fn, ms) {
    let raw = null
    // 返回"自注销"的取消函数：被提前取消时也要把条目从 timers 里摘掉。
    // 否则每次"排期 → 被取消"（例如 idle 3s 去抖被下一次 running 打断）都会在
    // 常驻进程里留下一个死 disposer，直到插件卸载。
    const off = () => {
      if (raw && timers.delete(raw)) {
        try { raw() } catch (e) { /* ignore */ }
      }
    }
    raw = ctx.timeout(() => {
      timers.delete(raw)
      fn()
    }, ms)
    timers.add(raw)
    return off
  }

  // ---- 工作目录（用于派生工作区名；WinRT 发送不需要 cwd）----
  // fs.resolve 是异步的：默认工作区名必须在它回来之后再算，否则永远是空串。
  const fsSvc = ctx.get('fs')
  if (fsSvc !== undefined && typeof fsSvc.resolve === 'function') {
    Promise.resolve(fsSvc.resolve('.')).then((t) => {
      try {
        state.cwd = fsSvc.processPath(t)
        state.workspaceName = state.cwd ? basename(state.cwd) : ''
      } catch (e) { /* ignore */ }
      log(`[dsh-desktop-notify] workspace: ${state.workspaceName || '-'}`)
    }, () => { /* ignore */ })
  }

  // ---- 发送：交给平台发送层（Windows 同步、Linux 异步；失败单次重排队）----
  function fire(item) {
    log(`[dsh-desktop-notify] fire -> ${process.platform}:`, item.title)
    try {
      sink({
        title: item.title,
        message: item.message || '',
        urgency: item.urgency,
        url: item.url || '',   // 点击跳转目标（空 = 不可点击跳转）
      })
    } catch (e) {
      console.error('[dsh-desktop-notify] sendToast failed:', e && e.message)
      if (!item._retried) { item._retried = true; queue.unshift(item) }
    }
  }

  // ---- 门控 + 间隔队列 ----
  const queue = []
  let draining = false

  // 入队并按 200ms 间隔逐条发送（外部 API 的"绕过门控"路径也走这里）
  function enqueue(item) {
    if (!hasSink) {
      sendToast(item)   // 交给 sendToast 打一次"无后端"的日志，不占队列
      return false
    }
    if (queue.length >= MAX_QUEUE) {
      queue.shift()
      log('[dsh-desktop-notify] 队列已满，丢弃最旧的一条待发通知')
    }
    queue.push(item)
    if (draining) return true
    draining = true
    const step = () => {
      if (queue.length === 0) {
        draining = false
        return
      }
      fire(queue.shift())
      later(step, 200)
    }
    step()
    return true
  }

  // 聚焦门控（按会话）：静默条件 = 存在"聚焦且未超时"的页面，且该页面当前选中的
  // 会话 ∈ 通知所属会话；通知未携带会话 id（归属不明，例如 owner 已清理的后台任务）
  // 一律不静默、照常推送。
  // 返回值：{ queued, silenced, reason } —— push() 的布尔语义由此得出
  // （被静默 ≠ 已入队；去重命中/无后端也都没入队）。
  // options.dedupeKey：可选的"身份"后缀——同标题同正文但不是同一件事时（例如两个
  //   同名后台任务在同一秒内结算）必须各自弹，否则去重窗口会把它们合并成一条。
  // options.url：点击通知要跳转的地址（缺省时按会话归属自动生成会话链接）。
  function notify(title, message, urgency, sessionOrIds, options = {}) {
    const sessionIds = sessionIdList(sessionOrIds)
    const silenced = gate.silenced(sessionIds, Date.now())
    // 传了会话却归一不出 id（形状不认识）时留一条日志：否则门控会静默退化成
    // "永不静默"，而调用方看不出任何异常。
    if (sessionIds.length === 0 && sessionOrIds !== undefined && sessionOrIds !== null) {
      log('[dsh-desktop-notify] 会话归属无法归一（既不是 id 也不是带 id 的对象），按"归属不明"处理：不静默')
    }
    log(`[dsh-desktop-notify] notify(${title}) pages=${gate.size} session=${sessionIds.join(',') || '-'} silenced=${silenced}`)
    if (silenced) return { queued: false, silenced: true, reason: 'silenced' }
    // 同来源同文案去重：宿主事件可能重复派发，或本条刚从失败重试回来。
    // 键 = 标题 + 正文 + 来源标识 + 会话归属：会话也要进键，否则"两个会话在同一秒
    // 弹出同前缀同结尾的提醒"（并行根会话/agent-team）会被误判成重复而丢掉一条。
    const dedupeKey = options.dedupeKey
    const key = title + '\u0000' + (message || '') + '\u0000' + (dedupeKey || '') + '\u0000' + sessionIds.join(',')
    if (!shouldSend(key, Date.now())) {
      log('[dsh-desktop-notify] 同文案在去重窗口内，跳过')
      return { queued: false, silenced: false, reason: 'duplicate' }
    }
    const queued = enqueue({ title, message, urgency, url: clickUrl(options, sessionIds) })
    return { queued, silenced: false, reason: queued ? '' : 'dropped' }
  }

  // ---- 点击跳转的目标 ----
  // 通知被点击时打开 `${origin}/dnotify/click?t=<令牌>&target=<目标>`：那是一个只负责
  // "记录目标 + 自关"的极小落地页（浏览器会新开一个标签页，关不掉是浏览器对系统打开
  // 标签的限制——接受它，不再为了"少一个标签"去注册自定义协议 + 一跳转发进程）。
  // 已打开的 DSH 页面通过 SSE 收到目标，并且**只有一个页面认领执行**（见下面的路由与
  // lib/client.js），所以切换发生在你已经在用的那个页面上。
  // target 形如 `session:<id>`、`page:settings-plugins`、`page:plugins`。
  function webOrigin() {
    try {
      const ws = ctx.get('webServer')
      const port = ws && typeof ws.port === 'number' ? ws.port : 0
      if (port > 0) {
        const raw = ws && typeof ws.host === 'string' ? ws.host : ''
        const host = !raw || raw === '0.0.0.0' || raw === '::' ? '127.0.0.1' : raw
        return `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`
      }
    } catch (e) { /* ignore */ }
    // 回退：DSH 给子进程注入的 web 地址（host 进程自己不一定有，故只作兜底）
    const env = typeof process.env.DSH_WEB_URL === 'string' ? process.env.DSH_WEB_URL.replace(/\/+$/, '') : ''
    return env
  }
  function deepLink(target) {
    const origin = webOrigin()
    if (!origin || !target) return ''
    return `${origin}/dnotify/click?t=${CLICK_TOKEN}&target=${encodeURIComponent(target)}`
  }
  /** 该通知点击后要打开的地址：显式给了就用，否则按会话归属自动生成会话链接。 */
  function clickUrl(options, sessionIds) {
    if (typeof options.url === 'string' && options.url) return options.url
    const first = Array.isArray(sessionIds) && sessionIds.length > 0 ? sessionIds[0] : ''
    return first ? deepLink('session:' + first) : ''
  }
  /** 启动播报点击 → 「设置/内置插件」（客户端先试设置弹窗，再退回插件面板）。 */
  const pluginsPageUrl = () => deepLink('page:settings-plugins')

  // ---- 启动播报（每次启动一次）：插件加载结果 ----
  // 数一遍 profile 组合里的插件行：loader 服务只在 profile 组合里存在，没有就跳过。
  // 「插件」= composition 里的每一行（entry），disabled 是主动关掉的、不计入。
  function collectPluginStatus() {
    const loader = ctx.get('loader')
    if (!loader || typeof loader.entries !== 'function') return null
    let loaded = 0
    const failed = []
    for (const entry of loader.entries()) {
      const label = String((entry && entry.options && (entry.options.id || entry.options.name)) || '未知插件')
      let disabled = false
      try { disabled = !!entry.disabled } catch (e) { failed.push(label); continue }
      if (disabled) continue
      const fiber = entry.fiber
      if (!fiber) { failed.push(label); continue }   // 连 import 都没成功
      if (fiber.state === FIBER_ACTIVE) { loaded += 1; continue }
      // FAILED，或 await 之后仍停在 PENDING/LOADING（缺服务、卡住）都算"没加载起来"
      if (fiber.state !== FIBER_FAILED) log(`[dsh-desktop-notify] 插件 ${label} 未激活（fiber state=${String(fiber.state)}）`)
      failed.push(label)
    }
    return { loaded, failed }
  }
  function reportStartupOnce() {
    const g = globalThis
    if (g[STARTUP_FLAG]) return
    g[STARTUP_FLAG] = true
    void (async () => {
      // 等组合稳定：app-boot 的启动审计用的也是 loader.await()；再留一点落位时间，
      // 并加 10s 上限——即使 await 不返回也不能把播报永远拖住。
      try {
        const loader = ctx.get('loader')
        if (loader && typeof loader.await === 'function') {
          await Promise.race([loader.await(), new Promise((r) => { setTimeout(r, 10000).unref?.() })])
        }
      } catch (e) { /* 继续按当前状态报 */ }
      await new Promise((r) => { setTimeout(r, 300).unref?.() })
      let status = null
      try { status = collectPluginStatus() } catch (e) { status = null }
      if (!status) {
        log('[dsh-desktop-notify] 没有 loader 服务（非 profile 组合），跳过启动播报')
        return
      }
      const failed = [...new Set(status.failed)]
      const body = failed.length === 0
        ? `插件启动成功:共有 ${status.loaded} 个插件成功加载`
        : `有 ${failed.length} 个插件启动失败:加载失败的插件为 ${failed.join('、')}`
      log(`[dsh-desktop-notify] startup report: loaded=${status.loaded} failed=${failed.join(',') || '-'}`)
      notify(failed.length === 0 ? '🚀 DSH 启动完成' : '⚠️ DSH 启动有插件未加载',
        body, failed.length === 0 ? 'low' : 'normal', undefined,
        { dedupeKey: 'startup', url: pluginsPageUrl() })
    })()
  }

  // ---- 对外 API：其它插件经 ctx.get('desktopNotify') 推送 ----
  //   push(item)       走聚焦门控（按会话）
  //   pushAlways(item) 绕过门控，始终弹
  //   notify(item)     同上但返回结构化结果（是否入队/是否被静默/原因）
  // item = { title, message?, urgency?: 'low'|'normal'|'critical', sessionId?, url? }
  // ⚠️ 服务名可能已被上一轮加载注册（热更新/重复加载）：这时只记日志，不让整个插件挂掉。
  try {
    const disposeNotifyApi = ctx.provide('desktopNotify', createNotifyApi({
      notify,
      enqueue,
      link: (sessionIds) => clickUrl({}, sessionIds),
    }))
    if (typeof disposeNotifyApi === 'function') ctx.effect(() => disposeNotifyApi)
  } catch (e) {
    console.error('[dsh-desktop-notify] desktopNotify 服务注册失败（可能已注册）:', e && e.message)
  }

  // ---- 自带 HTTP 路由：浏览器半区上报聚焦/会话 + 通知点击的投递 ----
  //
  // 为什么不用 DSH 的 connection.rpc.handle：0.1.7-rc.2 里 `rpc` 取值器把 owner 解析成
  // 一个"影子 ctx"（service.ts 的 symbols.shadow → 服务的注册 ctx），随后 handle 内部要
  // `owner.webServer.register(route)`（rpc-host.ts:86-93/171-195）。实测该影子 ctx 的
  // fiber 链上读不到 webServer，cordis 注入守卫直接抛
  // `cannot get property "webServer" without inject`——把 webServer 写进插件 inject 也没用
  // （照样抛，因为查的不是本插件的 fiber）。DSH 自己生产代码只用 rpc.intercept（不碰
  // webServer），handle 实际只在测试里用。所以这里自己挂路由，协议也自己定（纯 JSON POST，
  // 前端用 fetch），顺带把"点击通知"的投递通道一起做了。
  //
  // 路由（都挂在 /dnotify 前缀下，文档相对路径，前端同源 fetch 自动带 cookie）：
  //   POST /dnotify/page-focus  { focused, pageId, sessionId } → 会话级门控的输入
  //                             + 记录"最后一次聚焦的页面"（定向投递用）
  //   GET  /dnotify/events?pageId=<页面 id>  text/event-stream：接收定向跳转
  //   POST /dnotify/claim       { pageId, openId } → 认领**这一次**点击（按 openId 事务化）
  //   GET  /dnotify/click?t=<进程令牌>&target=<目标> → 通知点击落地页
  // 除 /click 外都过 connection.admit()（Host/Origin 栅栏 + 浏览器鉴权）；/click 只拦
  // 真正的跨站触发（Sec-Fetch-Site: cross-site），目标本身另有白名单。
  const CLICK_TOKEN = (() => {
    const g = globalThis
    if (typeof g[TOKEN_FLAG] !== 'string' || g[TOKEN_FLAG] === '') g[TOKEN_FLAG] = randomToken()
    return g[TOKEN_FLAG]
  })()
  const PENDING_TTL_MS = 30000
  const MAX_PENDING_OPENS = 16
  /**
   * 每一次点击 = 一条有身份的待认领消息：
   *   · 按 openId 存（连点两条通知不会串单：claim(A) 只会拿到 A）
   *   · 定向投给"最后一次上报聚焦的页面"（那就是用户正在用的那个），它不在线时才广播兜底
   *   · 30s 没人认领就过期（浏览器没开页面时会走 302 回 hash 深链，不依赖这里）
   */
  const pendingOpens = createBoundedMap(MAX_PENDING_OPENS)
  /** SSE 订阅：res → { pageId, stopPing }。 */
  const openStreams = new Map()
  /** 最后一次上报 focused=true 的页面（用户正在用的那个），用于定向投递。 */
  let lastFocusedPageId = ''
  let lastFocusedAt = 0
  function expireOpens(now = Date.now()) {
    for (const [id, envelope] of [...pendingOpens.entries()]) {
      if (now - envelope.at > PENDING_TTL_MS) pendingOpens.delete(id)
    }
  }
  function dropStream(res) {
    const meta = openStreams.get(res)
    openStreams.delete(res)
    if (meta && typeof meta.stopPing === 'function') meta.stopPing()
  }
  function findStream(pageId) {
    if (!pageId) return null
    for (const [res, meta] of openStreams) if (meta.pageId === pageId) return res
    return null
  }
  /**
   * 发布一次点击：建档 + 定向投递。
   * @returns {{envelope: {id: string, target: string, at: number}, delivered: number}}
   *   delivered = 实际收到 navigate 的页面数（0 = 当前没有已连接的 DSH 页面）
   */
  function publishOpen(target) {
    const envelope = { id: randomToken(), target, at: Date.now() }
    expireOpens()
    pendingOpens.set(envelope.id, envelope)
    const payload = `event: navigate\ndata: ${JSON.stringify(envelope)}\n\n`
    // 只推给"最后一次聚焦的页面"——别再靠"谁先抢到 claim"猜前台；
    // 它不在线（或从来没上报过聚焦）时才退回广播，由各页面用 openId 先到先得。
    const selected = findStream(lastFocusedPageId)
    const targets = selected ? [[selected, openStreams.get(selected)]] : [...openStreams.entries()]
    let delivered = 0
    for (const [res] of targets) {
      try {
        res.write(payload)
        delivered += 1
      } catch (e) {
        dropStream(res)
      }
    }
    log(`[dsh-desktop-notify] open ${envelope.target} id=${envelope.id.slice(0, 6)} -> ${delivered} page(s)`
      + `${selected ? ` (focused=${lastFocusedPageId})` : ' (broadcast)'}`)
    return { envelope, delivered }
  }
  function readJsonBody(req, limit = 8192) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) { req.destroy(); resolve(null); return }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { resolve(null) }
      })
      req.on('error', () => resolve(null))
    })
  }
  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  /** 通知点击落地页：记录目标、尽力自关（关不掉就显示一行提示）。 */
  function clickLandingPage(target, valid = true) {
    const safe = String(target).replace(/[<>&"]/g, '')
    const line = valid ? '已通知 DSH 切换' : '这条通知的目标已失效'
    return '<!doctype html><meta charset="utf-8"><title>DSH 通知</title>'
      + '<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;color:#888}</style>'
      + `<p>${line}</p><script>try{window.close()}catch(e){}</script>`
      + `<!-- target=${safe} -->`
  }
  async function serveNotifyRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.replace(/^\/dnotify\/?/, '').replace(/\/+$/, '')
    const method = (req.method || 'GET').toUpperCase()

    // 点击落地：由系统/浏览器直接打开，没有 Origin。
    // target=<目标> → 记录目标 + 返回落地页（该页尝试自关；Chrome/Edge 拒绝脚本关闭
    // 系统打开的标签，所以通常会留下一个只显示"已通知 DSH 切换"的小标签页）。
    // 只拦**真正的跨站触发**（Sec-Fetch-Site: cross-site）：目标受白名单约束，而
    // "点到旧通知"是正常用户行为——旧通知的令牌可能是上一次运行/上一次 apply 发的，
    // 那种情况照常放行，不再回一个 forbidden。
    if (path === 'click' && method === 'GET') {
      const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
      if (site === 'cross-site') { res.writeHead(403); res.end('forbidden'); return }
      const token = url.searchParams.get('t') || ''
      if (token !== CLICK_TOKEN) {
        log(`[dsh-desktop-notify] 点击令牌不是当前进程的（旧通知/上一次运行），按用户导航放行 site=${site || '-'}`)
      }
      const target = url.searchParams.get('target') || ''
      const valid = isValidTarget(target)
      if (valid) {
        const { envelope, delivered } = publishOpen(target)
        if (delivered === 0) {
          // 当前没有任何已连接的 DSH 页面：别让这次点击石沉大海。
          // 直接把浏览器送到 DSH，用 hash 深链让刚启动的页面自己完成跳转
          // （client.js 的 handleHashTarget 就是为这条路径保留的）。
          // 这条待认领记录同时作废：否则等页面起来时会被认领第二次（跳两遍）。
          pendingOpens.delete(envelope.id)
          log(`[dsh-desktop-notify] click -> ${target} 无已连接页面，302 到 hash 深链`)
          res.writeHead(302, {
            location: `/#dsh-notify=${encodeURIComponent(target)}`,
            'cache-control': 'no-store',
          })
          res.end()
          return
        }
      } else if (target) {
        log(`[dsh-desktop-notify] 点击目标非法，已忽略: ${target}`)
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(clickLandingPage(target, valid))
      return
    }

    // 其余端点都来自 DSH 页面：先过 DSH 自己的信任栅栏 + 浏览器鉴权
    try {
      const admission = ctx.connection.admit(req)
      if (admission && 'rejection' in admission) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
    } catch (e) {
      console.error('[dsh-desktop-notify] admit 失败，拒绝该请求:', e && e.message)
      res.writeHead(403)
      res.end('forbidden')
      return
    }

    if (path === 'events' && method === 'GET') {
      // 页面在 query 里自报 pageId：宿主据此把跳转**定向**给"最后一次聚焦的那个页面"，
      // 而不是广播给所有页面让它们抢（抢到的未必是用户正在看的那个）。
      const pageId = url.searchParams.get('pageId') || ''
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      // 这条连接建立前若已有待认领的点击：只回放给它该收的那一条（定向或广播兜底）
      expireOpens()
      for (const [, envelope] of pendingOpens) {
        if (lastFocusedPageId && lastFocusedPageId !== pageId) break
        res.write(`event: navigate\ndata: ${JSON.stringify(envelope)}\n\n`)
      }
      // 心跳用自管的 setInterval：**不要**去 ctx.timeout/ctx.effect 的返回值上调
      // .then/.catch——cordis 那边返回的是 Disposable<Promise<void>>（thenable，没有
      // .catch），踩过一次：SSE 一建立就抛 keepAlive.catch is not a function，整条
      // /dnotify 请求失败、跳转全挂。这里只用"流还开着就再心跳一次"的自终止定时器。
      let pingTimer = null
      const stopPing = () => {
        if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null }
      }
      pingTimer = setInterval(() => {
        if (!openStreams.has(res)) { stopPing(); return }
        try { res.write(': ping\n\n') } catch (e) { dropStream(res); stopPing() }
      }, 25000)
      // 心跳不能把事件循环钉住：宿主进程该退就退（HTTP 服务自己会 hold 住它）
      if (pingTimer && typeof pingTimer.unref === 'function') pingTimer.unref()
      openStreams.set(res, { pageId, stopPing })
      const drop = () => {
        stopPing()
        openStreams.delete(res)
      }
      req.on('close', drop)
      res.on('close', drop)
      log(`[dsh-desktop-notify] events stream open (pages=${openStreams.size})`)
      return
    }

    if (path === 'claim' && method === 'POST') {
      const body = await readJsonBody(req)
      const openId = body && typeof body.openId === 'string' ? body.openId : ''
      const pageId = body && body.pageId ? String(body.pageId) : ''
      expireOpens()
      let envelope = openId ? pendingOpens.get(openId) : null
      if (!envelope && !openId) {
        // 兼容没带 openId 的旧客户端（浏览器可能还缓存着上一版 client bundle）：
        // 取最新一条，避免升级窗口里点不动。
        let latest = null
        for (const [, candidate] of pendingOpens) if (!latest || candidate.at > latest.at) latest = candidate
        envelope = latest
        if (envelope) log('[dsh-desktop-notify] claim 未带 openId（旧客户端），退回取最新一条')
      }
      if (!envelope) { json(res, 200, { ok: false, reason: 'stale' }); return }
      // 认领的是**这一次点击**：按 openId 精确删除，连点两条通知不会串单
      pendingOpens.delete(envelope.id)
      log(`[dsh-desktop-notify] claim ${envelope.target} by ${pageId || '?'} (id=${envelope.id.slice(0, 6)})`)
      json(res, 200, { ok: true, target: envelope.target, openId: envelope.id })
      return
    }

    if (path === 'page-focus' && method === 'POST') {
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object') { json(res, 400, { ok: false, reason: 'bad-body' }); return }
      const pageId = body.pageId ? String(body.pageId) : 'page'
      const sessionId = body.sessionId === undefined || body.sessionId === null ? '' : String(body.sessionId)
      if (body.focused) {
        gate.setPage(pageId, Date.now(), sessionId)
        // 记住"最后一次聚焦的页面"：点击通知时定向投给它（而不是广播让所有页面抢）
        lastFocusedPageId = pageId
        lastFocusedAt = Date.now()
      } else {
        gate.clearPage(pageId)
      }
      log(`[dsh-desktop-notify] page-focus ${pageId} -> ${body.focused ? 'focused' : 'unfocused'} session=${sessionId || '-'} (pages=${gate.size})`)
      json(res, 200, { ok: true, pages: gate.size })
      return
    }

    json(res, 404, { ok: false, reason: 'unknown-endpoint' })
  }
  try {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: '/dnotify',
      handler: (req, res) => {
        void serveNotifyRoute(req, res).catch((err) => {
          console.error('[dsh-desktop-notify] /dnotify 处理失败:', err && err.message)
          if (!res.headersSent) { res.writeHead(500); res.end() }
        })
      },
    })
    ctx.effect(() => () => {
      for (const [res, meta] of [...openStreams]) {
        if (meta && typeof meta.stopPing === 'function') meta.stopPing()
        try { res.end() } catch (e) { /* ignore */ }
      }
      openStreams.clear()
      disposeRoute()
    })
    log('[dsh-desktop-notify] /dnotify 路由已挂载（聚焦上报 + 点击投递）')
  } catch (e) {
    console.error('[dsh-desktop-notify] /dnotify 路由挂载失败（通知仍可用，但会话级静默与点击跳转会失效）:', e && e.message)
  }

  // ---- 点击协议（不经过浏览器）----
  // 1.6.1 曾注册 `dsh-notify:` 自定义协议 + 一跳 PowerShell 转发器来避免"点击新开一个
  // 标签页"。用户判定这种做法低效（每次点击起一个进程），已按要求移除：现在统一走
  // http 落地页，接受浏览器新开一个标签页。留这段注释是为了说明"为什么不再有协议注册"。

  // ---- session 事件流：回复摘要 + 审批审计对 ----
  ctx.on('session/event', (session, event) => {
    try {
      const type = event && event.type
      const data = (event && event.data) || {}
      if (type === 'assistant/message') {
        const msg = data.message
        let text = ''
        let blocks = 0
        if (msg && Array.isArray(msg.content)) {
          blocks = msg.content.length
          for (const b of msg.content) {
            if (b && b.type === 'text' && typeof b.text === 'string') text += (text ? ' ' : '') + b.text
          }
        }
        text = truncateText(text.replace(/\s+/g, ' ').trim(), 220)
        // 记录所有会话摘要（含子代理，备用后续功能）；有界容器负责回收内存。
        // 条目本身 = "该会话产出过内容"，正文可能为空（纯工具调用的消息）——
        // 任务完成时按"有没有条目"决定是否通知，而不是按"正文是否非空"。
        if (blocks > 0 && session && session.id !== undefined) {
          state.lastTextBySession.set(String(session.id), { text })
        }
      } else if (type === 'approval/asked') {
        if (data && data.id !== undefined) {
          rememberAsk(String(data.id), {
            tool: String(data.toolName || ''),
            reason: typeof data.reason === 'string' ? data.reason : '',
          })
        }
      } else if (type === 'approval/decided') {
        const id = data && data.id !== undefined ? String(data.id) : ''
        const info = state.asksById.get(id)
        state.asksById.delete(id)
        // 0.1.7 的 outcome 词表：'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
        if (info && data.outcome === 'rejected') {
          notify('🚫 操作被自动拒绝',
            withPrefix(sessionTitleText(session), session, (info.tool || '工具') + '-' + (info.reason || '操作被自动拒绝')),
            'normal', session, { dedupeKey: 'approval:' + id })
        }
      }
    } catch (e) {
      console.error('[dsh-desktop-notify] session feed hook error:', e && e.message)
    }
  })

  // ---- 任务完成：根 agent idle 持续 3s ----
  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent) return
      const agentId = String(agent.id)
      // 摘要按**会话 id**记录（session/event 给的键），这里也按会话 id 取；
      // agent.id 与根会话 id 相同，但显式取 session.id 更稳。
      const sessionKey = agent.session && agent.session.id !== undefined ? String(agent.session.id) : agentId
      const prevCancel = state.pendingIdle.get(agentId)
      if (prevCancel) {
        prevCancel()
        state.pendingIdle.delete(agentId)
      }
      // AgentStatus 只有 'idle' | 'running'：非 idle 一律不排期
      if (payload.status !== 'idle') return
      if (!isRootAgent(agent)) return
      const cancel = later(() => {
        state.pendingIdle.delete(agentId)
        const entry = state.lastTextBySession.get(sessionKey)
        // 消费即释放：无论推送成功还是被门控静默丢弃，这次"完成"的消费已结束，
        // 摘要不再有用；下次该会话产生新回复时自动重新写入。
        state.lastTextBySession.delete(sessionKey)
        // 没有条目 = 这轮没产出任何内容（空转/被中断）：不打扰
        if (!entry) return
        const lastAsk = state.askAtBySession.get(sessionKey) || 0
        if (Date.now() - lastAsk < 15000) return
        const title = sessionTitleText(agent.session)
        // 正文可能为空（最后一轮只有工具调用）：退化成"任务已完成"，总比整条丢掉好。
        // 去重键带会话（同一会话两次"完成"至少隔 3s 去抖，窗口内不可能重复），
        // 免得把"另一个会话恰好同前缀同结尾"的提醒当成重复丢掉。
        notify('✅ DSH 任务完成', withPrefix(title, agent.session, entry.text || '任务已完成'),
          'low', agent.session, { dedupeKey: 'session:' + sessionKey })
      }, 3000)
      state.pendingIdle.set(agentId, () => { try { cancel() } catch (e) { /* ignore */ } })
    } catch (e) {
      console.error('[dsh-desktop-notify] status hook error:', e && e.message)
    }
  })

  // ---- ask_user_question 派发 ----
  ctx.on('tools/execute', (exec, next) => {
    try {
      if (exec && exec.name === 'ask_user_question') {
        const args = exec.arguments || {}
        const qs = Array.isArray(args.questions) ? args.questions : []
        const first = qs[0] || {}
        const q = typeof first.question === 'string' ? first.question : ''
        const h = typeof first.header === 'string' ? first.header : ''
        const session = exec.agent && exec.agent.session
        if (session && session.id !== undefined) rememberAskAt(String(session.id))
        notify('❓ DSH 等待你的输入',
          withPrefix(sessionTitleText(session), session, (h ? '[' + h + '] ' : '') + q),
          'normal', session, { dedupeKey: exec.callId ? 'ask:' + exec.callId : '' })
      }
    } catch (e) {
      console.error('[dsh-desktop-notify] ask hook error:', e && e.message)
    }
    return next()
  })

  // ---- 后台子代理结束 ----
  ctx.on('subagent/end', (info) => {
    try {
      if (!info) return
      const subId = String(info.id)
      // 前缀 = 工作区/主会话名（主会话经 header.parentSession 回溯，工作区取主会话 cwd），
      // 正文 = 子代理名已完成
      const main = mainSessionFor(subId)
      const mainTitle = main ? sessionTitleText(main) : ''
      // 会话归属 = 主会话 + 子会话本身：你正在看其中任一个，这条就不必打扰。
      // 点击跳转则指向**子会话**：客户端 openSession(子会话 id) 会按 ui-workspace 的
      // 规则解析成子代理界面（replaceMain 里 sessions.subagentAddress(...)），
      // 所以点这条通知进入的是子代理视图而不是主会话。
      notify('🤖 后台子代理结束',
        withPrefix(mainTitle, main || subId, (sessionTitleText(subId) || subId || '后台子代理') + '已完成'),
        'low', [main, subId], { dedupeKey: 'subagent:' + (info.runId || subId), url: deepLink('session:' + subId) })
    } catch (e) { /* ignore */ }
  })

  // ---- 目标完成 / 阻塞 ----
  // GoalChanged = { operation, ref, goal? }（goal 仅在 clear 时缺失）；
  // GoalOperation: create|edit|pause|resume|complete|block|clear
  ctx.on('goal/changed', (payload) => {
    try {
      const change = payload && payload.change
      const goal = change && change.goal
      if (!goal) return
      const objective = truncateText(goal.objective || '', 200)
      const goalSession = payload && payload.agent && payload.agent.session
      const t = sessionTitleText(goalSession)
      // 同一次目标变更可能被重复派发；不同 revision 是不同的事，必须各自弹
      const ref = change.ref || {}
      const goalKey = 'goal:' + String(ref.id || '') + ':' + String(ref.revision === undefined ? '' : ref.revision)
      if (change.operation === 'complete') {
        notify('🎯 目标已完成', withPrefix(t, goalSession, objective + '-已完成'), 'normal', goalSession, { dedupeKey: goalKey })
      } else if (change.operation === 'block') {
        // blockedReason 是 { code, message } 对象（不是字符串）
        const br = goal.blockedReason
        notify('🎯 目标已阻塞',
          withPrefix(t, goalSession, objective + (br && br.message ? '-' + truncateText(br.message, 160) : '')),
          'normal', goalSession, { dedupeKey: goalKey })
      }
    } catch (e) { /* ignore */ }
  })

  // ---- 后台任务（jobs）结束 ----
  // jobs 是可选服务：不能写进 export const inject（无 jobs 的组合会让整个插件不加载），
  // 也不能只在 apply 里 ctx.get 一次——cordis 对未 inject 的服务不会重跑 apply，
  // 晚挂载的 jobs 会让钩子永不注册（「后台任务结束」通知静默失效）。
  // 统一用 ctx.inject 延迟注册：服务已在就立即执行，之后出现也会自动执行。
  //
  // ⚠️ 服务只能以属性形式在**注入了它的 ctx** 上读。在插件自身的 ctx 上读 `ctx.jobs`
  // 会被 cordis 的注入守卫拒绝（cannot get property "jobs" without inject）——
  // 而 `ctx.get('jobs')` 会越过隔离域拿到服务，导致"判断能用、真读就崩"。
  //
  // ⚠️ DSH 0.1.7-alpha.1 起 jobs 的服务面被合并成一条事件流：旧的 onJobDone/
  // JobSnapshot 已不存在，改为 events.subscribe(filter, listener)，settled 事件带
  // JobView（owner 是 SessionId，不再有 reported / ownerSession / outputTotal）。
  ctx.inject(['jobs'], (jobsCtx) => {
    const svc = jobsCtx.jobs
    if (!svc || !svc.events || typeof svc.events.subscribe !== 'function') {
      log('[dsh-desktop-notify] jobs 服务存在但没有 events.subscribe，跳过后台任务通知')
      return
    }
    log('[dsh-desktop-notify] jobs service: hooked')
    jobsCtx.effect(() => svc.events.subscribe({ owners: 'all' }, (event) => {
      try {
        if (!event || event.type !== 'settled') return
        const job = event.job || {}
        // awaited = 有调用方在等这次结算，结果已经交给它了（旧的 reported 语义）
        if (event.awaited) return
        // 后台子代理同时也是 kind='subagent' 的 job（tool-subagent 里 jobs.start 注册），
        // 它已经由 subagent/end 通知过一次——这里再报就是两条 toast。
        if (job.kind === 'subagent') return
        const jobSession = job.owner   // SessionId | undefined
        const mainTitle = sessionTitleText(jobSession)
        const label = String(job.label || job.id || '后台任务')
        const status = String(job.status || '')
        const suffix = status === 'failed' ? '失败' : status === 'killed' ? '被终止' : '已完成'
        log(`[dsh-desktop-notify] job settled ${job.id} label=${job.label} status=${status} cause=${event.cause}`)
        notify('🧰 后台任务结束',
          withPrefix(mainTitle, jobSession, label + suffix),
          status === 'failed' ? 'normal' : 'low',
          jobSession, // 取不到会话归属时 notify 不静默（照常推送）
          { dedupeKey: 'job:' + String(job.id || '') })   // 同名任务在同一窗口内结算也要各自弹
      } catch (e) { /* ignore */ }
    }))
  })

  // 启动播报：每次进程启动只推一次（放在最后，确保所有监听/服务都已就绪）
  reportStartupOnce()

  log(`[dsh-desktop-notify] plugin ready (${process.platform}, backend=${backend ? 'yes' : 'none'})`)
}
