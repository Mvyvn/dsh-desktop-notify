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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFocusGate, sessionIdList } from './gate.js'
import { createNotifyApi } from './api.js'
import {
  clickNone, clickSession, clickPage, clickUrl,
  decodeClickTarget, encodeClickTarget, activateQuery, needsDshPage,
} from './protocol.js'
import { PageRegistry } from './pages.js'
import { planActivation } from './activation.js'
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
/** 团队任务"上一次状态"的记录上限（只用来判定状态变化，避免同一任务重复弹）。 */
const MAX_TEAM_TASKS = 128
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
    lastTextBySession: createBoundedMap<string, { text: string }>(MAX_LAST_TEXT),
    askAtBySession: createBoundedMap<string, number>(MAX_ASK_AT),
    asksById: createBoundedMap<string, any>(MAX_PENDING_ASKS),
    pendingIdle: new Map(),
    /** 团队任务 id → 上一次状态（只对变化发通知；有界）。 */
    teamTaskStatus: createBoundedMap<string, string>(MAX_TEAM_TASKS),
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
  /**
   * 沿 `header.parentSession` 一路回溯到**顶层主会话**（母会话）。
   * 旧实现只往上走一层：多层子代理（子代理再派子代理）会停在中间层，于是
   *   ① 通知前缀里的会话名不是母会话；② 点击目标指向中间层子会话——客户端目录里
   *   未必能解析，表现就是"点了不跳转"。现在一路走到没有父会话为止。
   */
  function rootSessionFor(sessionOrId) {
    try {
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.get !== 'function') return undefined
      let sess = typeof sessionOrId === 'string' ? sessions.get(sessionOrId) : sessionOrId
      if (!sess) return undefined
      const seen = new Set()
      for (let depth = 0; depth < 32; depth += 1) {
        const id = sess.id === undefined || sess.id === null ? '' : String(sess.id)
        if (id && seen.has(id)) return sess                 // 谱系成环：停下，别死循环
        if (id) seen.add(id)
        const parent = sess.header && sess.header.parentSession
        if (!parent) return sess                            // 没有父会话 → 它就是顶层
        const next = typeof parent === 'string' ? sessions.get(parent) : parent
        if (!next) return sess                              // 父不在目录里：用当前这层（比子层更接近母会话）
        sess = next
      }
    } catch (e) { /* ignore */ }
    return undefined
  }
  /** 主会话（母会话）的 id；取不到返回空串。 */
  function rootSessionIdOf(sessionOrId) {
    const root = rootSessionFor(sessionOrId)
    const id = root && root.id !== undefined && root.id !== null ? String(root.id) : ''
    if (id) return id
    // 回溯失败时退回"直接 id"：至少能指向调用方给的那个会话
    const direct = sessionIdList(sessionOrId)
    return direct.length > 0 ? direct[0] : ''
  }
  function mainSessionFor(subId) {
    return rootSessionFor(subId)
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

  const timers = new Set<() => void>()
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
  // 队列里存的是 **ClickTarget**（`{type:…}`），这里统一转成平台要的**启动描述**
  // （wire/open/scheme/activate/fallback 三套地址）。放在 fire 里而不是 notify 里，
  // 是因为 pushAlways 会绕过 notify 直接入队——两处各转一次必然漂移。
  //
  // 分流（混合 backend，唯一的判定点）：
  //   有在线 DSH 页面 **且** 它的通知权限是 granted → 走浏览器自己的通知（页面 → SW → showNotification）
  //      点击 = SW 的 notificationclick → clients.matchAll() → WindowClient.focus()
  //      ⇒ 前台/后台都由浏览器自己处理，没有中转页、没有 UIA、没有外部进程
  //   其余情况 → 原生 Toast（点击打开 DSH 深链），并在正文里标明"降级模式"
  /**
   * 启动播报要等"有一个在线 DSH 页面"再发。
   *
   * 原因：启动播报发出时页面通常还没连上来 → 分流只能走原生 Toast（降级）。而这条通知恰恰
   * 是"点一下跳到设置→内置插件"的入口，走浏览器通知才有意义。等页面出现（最多 5s）再发，
   * 超时仍会发（降级），不让播报丢失。
   */
  let pendingStartup: (() => void) | null = null
  function sendWhenPageOnline(send: () => void, waitMs = 5000): void {
    const now = Date.now()
    if (pages.focusedLive(now) || pages.lastFocusedLive(now)) { send(); return }
    pendingStartup = send
    const wait = Number.isFinite(Number(config && config.startupWaitMs)) ? Number(config.startupWaitMs) : waitMs
    log(`[dsh-desktop-notify] 启动播报：等在线 DSH 页面出现（最多 ${wait}ms）再发，以便走浏览器通知`)
    setTimeout(() => {
      if (pendingStartup !== send) return
      pendingStartup = null
      log('[dsh-desktop-notify] 启动播报：等页面超时，降级为原生 Toast')
      try { send() } catch (e) { /* ignore */ }
    }, waitMs)
  }
  /** 页面一上线/一上报权限就检查：只有"有 granted 的页面"才把启动播报放出去（否则继续等）。 */
  function maybeFlushStartup(): void {
    if (!pendingStartup) return
    const pick = pickNotifyPage()
    if (!pick || pick.permission !== 'granted') return
    const flush = pendingStartup
    pendingStartup = null
    try { flush() } catch (e) { /* ignore */ }
  }
  /** 页面自报的通知权限（有界）：来自 /dnotify/sw/report 与每次 page-focus 上报。 */
  const pageNotify = createBoundedMap<string, { permission: string; at: number }>(64)
  /**
   * 挑一个"能用来发浏览器通知"的页面。
   *
   * 顺序：当前聚焦 → 最后聚焦 → 任何在线页面；并且**要求它的通知权限是 granted**。
   * 不只看"投递页面"是有原因的：权限可能是用户后来在站点设置里手动允许的，而那个页面恰好
   * 不是投递目标（多标签页时很常见）——之前就是这样把它误判成 unknown 而走了降级。
   */
  function pickNotifyPage(): { pageId: string; permission: string } | null {
    const now = Date.now()
    const order: string[] = []
    const snap = pages.focusedLive(now) ?? pages.lastFocusedLive(now)
    if (snap && snap.pageId) order.push(String(snap.pageId))
    for (const [, meta] of openStreams) {
      const id = String((meta && meta.pageId) || '')
      if (id && order.indexOf(id) < 0) order.push(id)
    }
    let fallback: { pageId: string; permission: string } | null = null
    for (const pageId of order) {
      const rec = pageNotify.get(pageId)
      const permission = rec ? rec.permission : 'unknown'
      if (permission === 'granted') return { pageId, permission }
      if (!fallback) fallback = { pageId, permission }
    }
    return fallback
  }
  /** 把通知内容交给那个页面（页面再交给 SW 显示）；返回是否至少推给了一条连接。 */
  function deliverNotifyToPage(pageId: string, envelope: any): number {
    const payload = `event: notify\ndata: ${JSON.stringify(envelope)}\n\n`
    let sent = 0
    for (const [res, meta] of [...openStreams]) {
      if (meta.pageId !== pageId) continue
      try { res.write(payload); sent += 1 } catch (e) { dropStream(res) }
    }
    return sent
  }
  function fire(item) {
    log(`[dsh-desktop-notify] fire -> ${process.platform}:`, item.title)
    try {
      const click = item.click && typeof item.click === 'object' && typeof item.click.type === 'string'
        ? describeClick(item.click)
        : (item.click && typeof item.click === 'object' ? item.click : emptyClick())
      // 留一条"我发过什么、它可点击吗"的记录（有界），排查点击问题时对着它看
      recentSent.push({ at: Date.now(), title: item.title, message: item.message || '', wire: click.wire, launch: click.scheme || click.fallback || '' })
      if (recentSent.length > 12) recentSent.shift()
      if (click.wire === 'none') log(`[dsh-desktop-notify] 这条通知不可点击（无 click 目标）: ${item.title}`)

      // ---- 混合 backend 的分流（唯一判定点）----
      const pick = pickNotifyPage()
      const web = !!(pick && pick.permission === 'granted')
      if (web) {
        const id = 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
        const sent = deliverNotifyToPage(pick.pageId, {
          id,
          title: String(item.title || 'DSH 通知'),
          body: String(item.message || ''),
          tag: id,
          target: click.wire,
          // SW 在"找不到任何 DSH 窗口"时会用这个地址 openWindow。这里给**DSH 深链本身**，
          // 而不是 /dnotify/click 中转地址 —— 那样点击会先开中转页再 302（多一跳、还闪一下）。
          deepLink: (() => { try { return appUrlFor(item.click || emptyClick()) } catch (e) { return '' } })(),
        })
        if (sent > 0) {
          lastRoute = { at: Date.now(), mode: 'web', pageId: pick.pageId, permission: pick.permission, reason: '' }
          log(`[dsh-desktop-notify] 走浏览器通知（页面 ${pick.pageId.slice(0, 8)}）: ${item.title}`)
          return
        }
        lastRoute = { at: Date.now(), mode: 'native', pageId: pick.pageId, permission: pick.permission, reason: 'deliver-failed' }
        log('[dsh-desktop-notify] 页面在，但通知没推出去（连接刚断？），降级为原生 Toast')
      }

      // 降级：没有在线页面，或页面没有通知权限 → 原生 Toast，并在正文里说明降级原因
      const degraded = !web && !!pick
      lastRoute = {
        at: Date.now(),
        mode: 'native',
        pageId: pick ? pick.pageId : '',
        permission: pick ? pick.permission : 'no-page',
        reason: !pick ? 'no-online-page' : (web ? 'deliver-failed' : 'permission-not-granted'),
      }
      log(`[dsh-desktop-notify] 走原生 Toast（原因 ${lastRoute.reason}，页面权限 ${lastRoute.permission}）: ${item.title}`)
      sink({
        title: item.title,
        message: degraded
          ? String(item.message || '') + ' · 降级模式：浏览器通知不可用，点击将新开标签页'
          : (item.message || ''),
        urgency: item.urgency,
        click,
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
  // options.click：**显式的点击目标**（ClickTarget）。不传 = none = 点了不跳转。
  //   注意与旧版的区别：旧版会按会话归属自动生成跳转链接，于是"留空"根本表达不出
  //   "不要跳转"；现在两者彻底分开——sessionId 只管门控，click 只管点击行为。
  function notify(title, message, urgency, sessionOrIds, options: any = {}) {
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
    const click = options.click && typeof options.click === 'object' ? options.click : clickNone()
    const queued = enqueue({ title, message, urgency, click })
    return { queued, silenced: false, reason: queued ? '' : 'dropped' }
  }

  // ---- 点击目标 → 启动描述 ----
  // 三套地址一次算好，平台后端各取所需：
  //   wire     'none' | 'session:<id>' | 'page:<名字>' | 'url:<encoded>'
  //   open     url 目标的真实地址（url 目标不需要 DSH，直接开）
  //   scheme   `dsh-notify:<wire>`（Windows 自定义协议；已注册时 Toast 走它，
  //            点击 → 本机转发器 → POST /dnotify/activate → 宿主**先决策再开窗口**）
  //   activate `<origin>/dnotify/activate?t=<令牌>&raw=<wire>`（转发器/Linux 后端调用）
  //   fallback `<origin>/dnotify/click?t=<令牌>&raw=<wire>`（协议没注册时的浏览器兜底）
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
  /** none 目标的空描述（平台后端据此判定"不可点击"）。 */
  function emptyClick() {
    return { wire: 'none', open: '', scheme: '', activate: '', fallback: '' }
  }
  /** 把 ClickTarget 展开成启动描述。 */
  function describeClick(target) {
    if (!target || target.type === 'none') return emptyClick()
    const wire = encodeClickTarget(target)
    if (target.type === 'url') {
      return { wire, open: target.url, scheme: target.url, activate: '', fallback: target.url }
    }
    const origin = webOrigin()
    return {
      wire,
      open: '',
      // launchMode: 'browser' 时不使用自定义协议，Toast 直接带浏览器落地页——
      // 代价是通知中心会留一个标签页，但**一定能到达宿主**（浏览器必然打开它）。
      // 用于协议点击不触发的环境，或想稳妥些的用户。
      scheme: launchMode === 'protocol' && origin ? `dsh-notify:${wire}` : '',
      activate: origin ? `${origin}/dnotify/activate?t=${CLICK_TOKEN}&${activateQuery(target)}` : '',
      fallback: origin ? `${origin}/dnotify/click?t=${CLICK_TOKEN}&${activateQuery(target)}` : '',
    }
  }
  /** DSH 应用地址（带 hash 深链）：没有已打开页面时由它把 DSH 拉起来并跳转。 */
  function appUrlFor(target) {
    const origin = webOrigin()
    if (!origin) return ''
    return `${origin}/#dsh-notify=${encodeURIComponent(encodeClickTarget(target))}`
  }
  /** 会话 → 点击目标（取不到 id 就是 none：宁可不可点击，也不要瞎跳）。 */
  function clickForSession(session) {
    const ids = sessionIdList(session)
    const first = ids.length > 0 ? ids[0] : ''
    return first ? clickSession(first) : clickNone()
  }
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
      // 等页面在线再发：否则启动瞬间没有页面连上来，必然走降级（原生 Toast）
      sendWhenPageOnline(() => notify(failed.length === 0 ? '🚀 DSH 启动完成' : '⚠️ DSH 启动有插件未加载',
        body, failed.length === 0 ? 'low' : 'normal', undefined,
        { dedupeKey: 'startup', click: clickPage('settings-plugins') }))
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
   * 每一次点击 = 一条有身份、**已定向**的消息：
   *   · openId 精确认领（连点两条不会串单）
   *   · envelope.targetPageId 在投递时就定好，claim 时校验归属 —— 不存在"谁先抢到"，
   *     也不存在广播（review 第 5、9 条）
   *   · 30s 没人认领就过期
   */
  const pendingOpens = createBoundedMap<string, any>(MAX_PENDING_OPENS)
  /** SSE 订阅：res → { pageId, stopPing }。 */
  const openStreams = new Map()
  /** 页面注册表：存在性 / 当前聚焦 / 序号，见 src/pages.ts。 */
  const pages = new PageRegistry()
  /** openId → 认领握手回调（等页面真的 claim）。 */
  const claimWaiters = new Map<string, () => void>()
  /** 最近一次激活/认领，供 /dnotify/status 诊断（不常驻增长）。 */
  let lastActivate = null
  let lastClaim = null
  /** 最近一次"认领后回报的跳转结果"：认领成功 ≠ 跳转成功，这一条是唯一的诊断痕迹。 */
  let lastNavigate: any = null
  /** 投递后等认领的时长：等不到就退化成"新开 DSH"，避免"投了但没跳"。 */
  const CLAIM_WAIT_MS = Number.isFinite(config && config.claimWaitMs) && config.claimWaitMs >= 0
    ? Number(config.claimWaitMs)
    : 1500
  /**
   * Toast 的点击怎么走（实测结论：Windows 11 + 未打包的 Win32 宿主下，Toast 的
   * `activationType="protocol"` **不会**把自定义 scheme 投递给我们的注册表处理器——
   * `Start-Process 'dsh-notify:…'` 能触发，真实点击却什么都不发生）。
   *   · 'browser'（默认）→ Toast 直接带浏览器落地页：必然能到达宿主。代价是通知中心
   *                        会留下一个落地页标签（浏览器不允许脚本关闭系统打开的标签）。
   *   · 'protocol'        → 自定义协议 + 本机转发器：不新开标签，但在上述环境下点击无效。
   */
  const launchMode = config && config.launchMode === 'protocol' ? 'protocol' : 'browser'
  /** 最近发出的通知（title + 点击目标），供 /dnotify/status 排查"我点的是哪条"。 */
  const recentSent: Array<{ at: number; title: unknown; message: string; wire: string; launch: string }> = []
  function expireOpens(now = Date.now()) {
    for (const [id, envelope] of [...pendingOpens.entries()]) {
      if (now - envelope.at > PENDING_TTL_MS) pendingOpens.delete(id)
    }
  }
  function dropStream(res) {
    const meta = openStreams.get(res)
    openStreams.delete(res)
    if (meta && typeof meta.stopPing === 'function') meta.stopPing()
    if (meta && meta.pageId) pages.detachStream(meta.pageId, Date.now())
  }
  /**
   * 把一次点击**定向**投给某个页面（不广播）。
   * @returns {{envelope: object, delivered: number}}
   */
  function deliverToPage(target: any, pageId: string): { envelope: any; delivered: number } {
    const envelope = {
      id: randomToken(),
      target: encodeClickTarget(target),
      targetPageId: pageId,
      at: Date.now(),
    }
    expireOpens()
    pendingOpens.set(envelope.id, envelope)
    const payload = `event: navigate\ndata: ${JSON.stringify(envelope)}\n\n`
    let delivered = 0
    for (const [res, meta] of [...openStreams]) {
      if (meta.pageId !== pageId) continue
      try {
        res.write(payload)
        delivered += 1
      } catch (e) {
        dropStream(res)
      }
    }
    log(`[dsh-desktop-notify] deliver ${envelope.target} id=${envelope.id.slice(0, 6)} -> ${pageId}`
      + ` (${delivered} stream; open=[${[...openStreams.values()].map((m) => m.pageId || '-').join(',')}])`)
    return { envelope, delivered }
  }
  /**
   * 三态决策 + 执行（review 第 7 条的 activation bus）：
   *   ignore     目标为空 → 什么都不做
   *   deliver    有目标 + 有可投递页面 → 只推给那个页面（**不产生任何窗口**）
   *   open-app   有目标 + 无页面 → 返回 DSH 深链，由调用方（转发器/portal/浏览器）打开
   *   open-url   外部地址 → 直接返回该地址
   * @param {object} target ClickTarget
   * @returns {{plan: object, envelope?: object}}
   */
  function activate(target: any): { plan: any; envelope?: any } {
    const plan = planActivation(target, {
      registry: pages,
      appUrl: (t) => appUrlFor(t),
      now: Date.now(),
    })
    if (plan.action === 'deliver') {
      const { envelope, delivered } = deliverToPage(target, plan.pageId)
      if (delivered > 0) return { plan, envelope }
      // 页面刚好在这一刻断线：退化成"新开"，而不是无限重试。
      // 同时把这页的连接计数归零（自愈）：否则它会一直被选成目标却永远投不出去。
      pages.detachStream(plan.pageId, Date.now())
      log(`[dsh-desktop-notify] 目标页面 ${plan.pageId} 投递失败（连接已断），改为新开`)
      return { plan: { action: 'open-app', url: appUrlFor(target) } }
    }
    return { plan }
  }
  /** 等待某个 openId 被页面认领（认领 = 页面真的收到并执行了）。 */
  function waitForClaim(openId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        claimWaiters.delete(openId)
        resolve(false)
      }, timeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
      claimWaiters.set(openId, () => {
        clearTimeout(timer)
        claimWaiters.delete(openId)
        resolve(true)
      })
    })
  }
  /**
   * 把"投递"确认成"真的跳了"：
   * `res.write()` 成功只说明数据交给了 socket，不代表浏览器收到、更不代表页面执行了跳转。
   * 所以投递后再等一次 `/claim`——**没等到就退化成"新开 DSH"**，绝不让点击静默失败。
   * @returns {Promise<boolean>} 是否已被认领
   */
  async function confirmDelivery(envelope, timeoutMs) {
    if (!envelope) return false
    const claimed = await waitForClaim(envelope.id, timeoutMs)
    if (!claimed) {
      pendingOpens.delete(envelope.id)
      log(`[dsh-desktop-notify] ${envelope.id.slice(0, 6)} 投递后 ${timeoutMs}ms 内无人认领 → 改为新开`)
    }
    return claimed
  }
  function readJsonBody(req: any, limit = 8192): Promise<any> {
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
  /** 通知点击落地页：尽力自关（关不掉就显示一行提示）。 */
  function clickLandingPage(debugInfo, line) {
    const safe = String(debugInfo).replace(/[<>&"]/g, '')
    return '<!doctype html><meta charset="utf-8"><title>DSH 通知</title>'
      + '<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;color:#888}</style>'
      + `<p>${String(line).replace(/[<>&"]/g, '')}</p><script>try{window.close()}catch(e){}</script>`
      + `<!-- target=${safe} -->`
  }
  /**
   * 让 **浏览器自己**处理通知点击。
   *
   * 关键能力是 Service Worker 的 `notificationclick` → `clients.matchAll()` → `WindowClient.focus()`：
   * 同源、事件驱动、浏览器内部完成 —— 不需要浏览器扩展、不需要 UIA/无障碍、不需要
   * SetForegroundWindow 或 PowerShell，也没有"外部进程去控制浏览器标签页"的越权问题。
   *
   * 脚本是仓库里的真实文件 `assets/dnotify-sw.js`（插件自身提供，**不是扩展**，无需安装）。
   */
  function swScript(): string {
    try {
      return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'dnotify-sw.js'), 'utf8')
    } catch (e) {
      log('[dsh-desktop-notify] 读取 SW 脚本失败: ' + (e as Error).message)
      return '// sw script missing'
    }
  }
  let lastSwReport: any = null
  /** 最近一次通知走了哪条路（web / native）以及原因 —— 一眼看清为什么降级。 */
  let lastRoute: any = null
  /**
   * 静态资源（SW 脚本、通知图标）必须能被浏览器直接取到：注册 SW 与"通知系统抓图标"都不带
   * DSH 页面的鉴权头，过 admit() 会 401 —— 图标就退回浏览器默认图标（用户看到的是 Firefox 的图标）。
   * 用函数判断（而不是内联比较）是为了不让 TS 的别名条件分析把 path 收窄成字面量类型。
   */
  function isStaticAssetPath(path: string, method: string): boolean {
    return method === 'GET' && path === 'sw.js'
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
      // 线格式：新链接用 raw=<wire>；旧链接用 target=<wire>（0.1.x 时代发出、可能还在
      // 通知中心里）——两者都按同一套严格解码处理，非法即忽略。
      const raw = url.searchParams.get('raw') || url.searchParams.get('target') || ''
      const target = decodeClickTarget(raw)
      if (target === null) {
        log(`[dsh-desktop-notify] 点击目标非法，已忽略: ${raw}`)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(clickLandingPage(raw, '这条通知的跳转目标无法识别'))
        return
      }
      // 混合 backend：**只有降级模式才会产生原生 Toast**（有页面且权限 granted 时走浏览器通知，
      // 那条路上的点击由浏览器自己的 SW 处理，根本不会到这里）。所以这里一律新开标签页跳深链。
      // 刻意**不**调用 activate()：那会顺带把 navigate 事件投给已有页面，而新架构里
      // "投递"已经前移到**发送时**（走 notify 事件给页面 → SW 显示通知）。
      if (needsDshPage(target)) {
        const url2 = appUrlFor(target)
        lastActivate = { at: Date.now(), raw, action: 'open', pageId: '', url: url2 }
        log(`[dsh-desktop-notify] click -> 降级模式：新开标签页跳到 ${url2}`)
        res.writeHead(302, { location: url2, 'cache-control': 'no-store' })
        res.end()
        return
      }
      const { plan } = activate(target)
      lastActivate = { at: Date.now(), raw, action: plan.action, pageId: plan.pageId || '', url: plan.url || '' }
      if (plan.action === 'open-app' || plan.action === 'open-url') {
        log(`[dsh-desktop-notify] click -> ${plan.action} ${plan.url}`)
        res.writeHead(302, { location: plan.url, 'cache-control': 'no-store' })
        res.end()
        return
      }
      // ignore：配置里点了不留跳转，浏览器不该走到这里（旧链接兜底）
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(clickLandingPage('', '这条通知不可跳转'))
      return
    }

    // 激活端点：由本机转发器（Windows 自定义协议）或 Linux 后端调用，**没有浏览器参与**。
    // 宿主在这里决策，并让调用方去执行唯一需要开窗口的动作（open-*）。
    // 令牌校验同 /click（旧令牌放行，只拦明显的跨站来源）。
    if (path === 'activate' && method === 'GET') {
      const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
      if (site === 'cross-site') { res.writeHead(403); res.end('forbidden'); return }
      const raw = url.searchParams.get('raw') || ''
      log(`[dsh-desktop-notify] activate raw=${JSON.stringify(raw)} site=${site || '-'}`)
      const target = decodeClickTarget(raw)
      if (target === null) {
        lastActivate = { at: Date.now(), raw, action: 'ignore', reason: 'bad-target' }
        json(res, 200, { action: 'ignore', reason: 'bad-target' })
        return
      }
      const { plan, envelope } = activate(target)
      lastActivate = { at: Date.now(), raw, action: plan.action, pageId: plan.pageId || '', url: plan.url || '' }
      if (plan.action === 'deliver') {
        if (await confirmDelivery(envelope, CLAIM_WAIT_MS)) {
          json(res, 200, { action: 'delivered', pageId: plan.pageId })
          return
        }
        // 页面在，但（重连中/卡住/不是新客户端）没认领：宁可新开一次，也不要静默失败
        const url = appUrlFor(target)
        log(`[dsh-desktop-notify] activate -> 页面未认领，改走深链 ${url}`)
        lastActivate = { at: Date.now(), raw, action: 'open', pageId: plan.pageId || '', url, reason: 'unclaimed' }
        json(res, 200, { action: 'open', url, reason: 'unclaimed' })
        return
      }
      if (plan.action === 'open-app' || plan.action === 'open-url') {
        log(`[dsh-desktop-notify] activate -> open ${plan.url}`)
        json(res, 200, { action: 'open', url: plan.url })
        return
      }
      json(res, 200, { action: 'ignore', reason: 'no-target' })
      return
    }

    // 只读诊断端点：知道进程令牌的本机调用可以看到"页面注册表 / 待认领 / 最近一次激活与认领"。
    // 排查"点了没反应"时，这是唯一能分清"没投出去 / 投了没认领 / 认领了没跳"的地方。
    if (path === 'status' && method === 'GET') {
      if ((url.searchParams.get('t') || '') !== CLICK_TOKEN) { res.writeHead(403); res.end('forbidden'); return }
      expireOpens()
      json(res, 200, {
        origin: webOrigin(),
        launchMode,
        pages: pages.snapshot(),
        recentSent,
        pending: [...pendingOpens].map(([, envelope]) => ({
          id: envelope.id,
          target: envelope.target,
          pageId: envelope.targetPageId,
          ageMs: Date.now() - envelope.at,
        })),
        lastActivate,
        lastClaim,
        lastNavigate,
        lastSwReport,
        lastRoute,
        streams: [...openStreams.values()].map((m) => m.pageId || ''),
        gate: gate.size,
      })
      return
    }

    // 其余端点都来自 DSH 页面：先过 DSH 自己的信任栅栏 + 浏览器鉴权
    // 例外：静态资源（SW 脚本、通知图标）必须能被浏览器直接取到 —— 注册 SW 与"通知系统抓图标"
    // 都不带 DSH 页面的鉴权头，过 admit() 会 401，图标就退回浏览器默认图标（用户看到的就是
    // Firefox 的图标而不是插件图标）。
    const isStaticAsset = isStaticAssetPath(path, method)
    if (!isStaticAsset) {
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
    }

    if (path === 'events' && method === 'GET') {
      // 页面自报 pageId：注册表据此把跳转**定向**给某个页面，而不是广播让所有页面抢。
      const pageId = url.searchParams.get('pageId') || ''
      // 有页面上线了：如果它已经带着 granted 权限，就把"等页面再发"的启动播报放出去
      // （权限稍后才上报的情况由 /page-focus、/sw/report 那两处再检查一次）
      maybeFlushStartup()
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      if (pageId) pages.attachStream(pageId, Date.now())
      // 这条连接建立前若已有待认领的点击：只回放**本来就投给这个页面**的那条
      expireOpens()
      for (const [, envelope] of pendingOpens) {
        if (envelope.targetPageId !== pageId) continue
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
      // ⚠️ 断开时必须**同时**把注册表里的连接计数减掉：只删 openStreams 会让页面注册表
      // 永远以为这页还"可投递"（幽灵在线页面），于是点击被判定为可投递、实际写不出去，
      // 再退化成"新开"——用户看到的是"该就地跳转却开了新标签"。
      // 而且必须**严格幂等**：`req.on('close')` 与 `res.on('close')` 都会调到这里，
      // 只有第一次成功摘除订阅时才允许递减计数，否则"旧连接关闭"会把"新连接刚建好"的
      // 计数减回去 → 活着的页面被误判成不可投递 → 同样退化成新开。
      const drop = () => {
        const meta = openStreams.get(res)
        if (!meta) return
        openStreams.delete(res)
        if (typeof meta.stopPing === 'function') meta.stopPing()
        if (meta.pageId) pages.detachStream(meta.pageId, Date.now())
      }
      req.on('close', drop)
      res.on('close', drop)
      log(`[dsh-desktop-notify] events stream open (pages=${openStreams.size})`)
      return
    }

    // 说明：曾经加过 /dnotify/icon.png 给 Web Notification 当 icon。**已移除** ——
    // Windows 上那一行（应用图标 + 应用名）来自"发通知的进程身份"（Firefox），
    // 内容图标既改不了它、在 Firefox 里也不一定渲染，留着只是自欺欺人。
    // 想要品牌化的来源行只能用原生 Toast（AUMID 的 DisplayName + IconUri）。

    if (path === 'sw.js' && method === 'GET') {
      // service-worker-allowed 让该脚本可以声明 scope=/（脚本在 /dnotify 下，但要控制 DSH 页面本身）
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'service-worker-allowed': '/',
      })
      res.end(swScript())
      return
    }

    if (path === 'sw/report' && method === 'POST') {
      // SW 与页面把每一步结果写到这里（成功/失败/降级原因都留痕，不再无声）
      const body = await readJsonBody(req)
      lastSwReport = { at: Date.now(), ...(body || {}) }
      // 顺便记下"这个页面的通知权限"：分流要靠它决定走浏览器通知还是降级到原生 Toast
      const rid = lastSwReport.pageId ? String(lastSwReport.pageId) : ''
      const perm = lastSwReport.permission !== undefined ? String(lastSwReport.permission) : (lastSwReport.state !== undefined ? String(lastSwReport.state) : '')
      if (rid && perm) pageNotify.set(rid, { permission: perm, at: Date.now() })
      maybeFlushStartup()
      log(`[dsh-desktop-notify] SW: ${JSON.stringify(lastSwReport)}`)
      json(res, 200, { ok: true })
      return
    }

    if (path === 'poc-notify' && method === 'GET') {
      // 让在线 DSH 页面显示一条通知（点击由 SW 接管，不经过原生 Toast）
      const target = url.searchParams.get('target') || 'page:settings-plugins'
      const envelope = { id: 'poc-' + Date.now().toString(36), target, targetPageId: '', at: Date.now() }
      let sent = 0
      for (const [streamRes] of [...openStreams]) {
        try { streamRes.write(`event: poc-notify\ndata: ${JSON.stringify(envelope)}\n\n`); sent += 1 } catch (e) { /* ignore */ }
      }
      log(`[dsh-desktop-notify] PoC 通知已发给 ${sent} 个在线页面`)
      json(res, 200, { ok: sent > 0, sent })
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
      // **归属校验**：这条点击投递时就属于某个页面，别的页面即使拿到 openId 也不认领
      // （review 第 9 条：确定性路由，而不是"谁先到谁赢"）。
      if (envelope.targetPageId && pageId && envelope.targetPageId !== pageId) {
        log(`[dsh-desktop-notify] claim 被拒：${envelope.id.slice(0, 6)} 属于 ${envelope.targetPageId}，来自 ${pageId}`)
        json(res, 200, { ok: false, reason: 'not-owner' })
        return
      }
      pendingOpens.delete(envelope.id)
      lastClaim = { at: Date.now(), openId: envelope.id, target: envelope.target, pageId: pageId || '' }
      const handoff = claimWaiters.get(envelope.id)
      if (handoff) handoff()
      log(`[dsh-desktop-notify] claim ${envelope.target} by ${pageId || '?'} (id=${envelope.id.slice(0, 6)})`)
      json(res, 200, { ok: true, target: envelope.target, openId: envelope.id })
      return
    }

  if (path === 'navigated' && method === 'POST') {
    // 认领成功 ≠ 跳转成功。客户端把 applyTarget 的终态回报到这里：
    //   done      已经切过去了；
    //   not-found 目标在客户端目录里不存在（会话被删/归档）——宿主此时已按"已认领"
    //             停掉了新开兜底，所以这条记录是"点了却没跳"唯一的诊断痕迹。
    const body = await readJsonBody(req)
    if (!body || typeof body !== 'object') { json(res, 400, { ok: false, reason: 'bad-body' }); return }
    const openId = body.openId ? String(body.openId) : ''
    const result = body.result ? String(body.result) : ''
    lastNavigate = {
      at: Date.now(),
      openId,
      result,
      pageId: body.pageId ? String(body.pageId) : '',
      target: lastClaim && lastClaim.openId === openId ? lastClaim.target : '',
    }
    log(`[dsh-desktop-notify] navigate ${result}${result === 'not-found' ? ' ⚠️ 已认领但客户端跳不过去（目标不存在？）' : ''} by ${lastNavigate.pageId || '?'} (id=${openId.slice(0, 6)})`)
    json(res, 200, { ok: true })
    return
  }

    if (path === 'page-focus' && method === 'POST') {
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object') { json(res, 400, { ok: false, reason: 'bad-body' }); return }
      const pageId = body.pageId ? String(body.pageId) : 'page'
      const sessionId = body.sessionId === undefined || body.sessionId === null ? '' : String(body.sessionId)
      const seq = Number.isFinite(body.seq) ? Number(body.seq) : undefined
      const focused = body.focused === true
      // 通知权限随聚焦上报一起带过来（用户可能在站点设置里手动允许过，不会触发我们的申请流程）：
      // 分流要靠它决定走浏览器通知还是降级到原生 Toast。
      if (typeof body.permission === 'string' && body.permission) {
        pageNotify.set(pageId, { permission: String(body.permission), at: Date.now() })
        maybeFlushStartup()
      }
      // 注册表：seq 更新才生效（乱序保护；旧客户端不带 seq 时跳过该保护）；
      // 失焦清"当前聚焦"，但保留"最后用过"——用户切去别的应用时仍要跳那个页面。
      const verdict = pages.report({ pageId, seq, focused, sessionId }, Date.now())
      // 门控与注册表必须吃**同一个新鲜度结论**：verdict==='stale' 说明这条上报比已记录的更旧，
      // 注册表已经正确忽略了它——门控也必须忽略。否则 "seq=10 focused" 之后到达的
      // "seq=9 unfocused" 会把刚聚焦的页面从静默集合里清掉（该静默的通知重新弹），反之亦然。
      if (verdict === 'stale') {
        log(`[dsh-desktop-notify] page-focus ${pageId} seq=${seq === undefined ? '-' : seq} stale（乱序丢弃，门控不动）`)
        json(res, 200, { ok: true, pages: pages.size, verdict, gate: gate.size })
        return
      }
      // 门控按"聚焦且未超时"的页面集合判定（与页面注册表互补：门控看会话，注册表看投递）
      if (focused) gate.setPage(pageId, Date.now(), sessionId)
      else gate.clearPage(pageId)
      log(`[dsh-desktop-notify] page-focus ${pageId} seq=${seq === undefined ? '-' : seq} -> ${focused ? 'focused' : 'unfocused'} session=${sessionId || '-'} (pages=${pages.size} gate=${gate.size} ${verdict})`)
      json(res, 200, { ok: true, pages: pages.size, verdict })
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

  // ---- 点击激活：把自定义协议指向**本进程**的激活端点 ----
  // 端口/令牌每次启动都会变，所以每次启动都重写一次（幂等）。注册失败不影响通知，
  // 只是点击会退回浏览器落地页（也就是会新开一个标签页）。
  // 放在路由之后：CLICK_TOKEN 与 webOrigin() 到这里都已就绪。
  // config.clickProtocol: false 关掉注册；config.focusWindow: false 关掉"投递后把浏览器
  // 窗口带到前台"（隔离验证 / 嵌入宿主用）。
  try {
    const wantProtocol = !(config && config.clickProtocol === false)
    if (wantProtocol && backend && typeof backend.registerClickProtocol === 'function') {
      const origin = webOrigin()
      const focusWindow = !(config && config.focusWindow === false)
      const ok = origin
        ? backend.registerClickProtocol({
          activate: `${origin}/dnotify/activate?t=${CLICK_TOKEN}`,
          fallback: `${origin}/dnotify/click?t=${CLICK_TOKEN}&raw=`,
        }, { focusWindow })
        : false
      log(`[dsh-desktop-notify] 点击协议注册: ${ok ? 'ok' : '未启用（退回浏览器落地页）'} focusWindow=${focusWindow}`)
    } else if (!wantProtocol) {
      log('[dsh-desktop-notify] 点击协议注册已按配置关闭（点击走浏览器落地页）')
    }
  } catch (e) {
    console.error('[dsh-desktop-notify] 点击协议注册失败:', e && e.message)
  }

  // ---- 点击协议（不经过浏览器）----
  // 1.6.1 曾注册 `dsh-notify:` 自定义协议 + 一跳 PowerShell 转发器来避免"点击新开一个
  // 标签页"。用户判定这种做法低效（每次点击起一个进程），已按要求移除：现在统一走
  // http 落地页，接受浏览器新开一个标签页。留这段注释是为了说明"为什么不再有协议注册"。

  // ---- session 事件流：回复摘要 + 审批审计对 ----
  ctx.on('session/event', (session: any, event: any) => {
    try {
      const type = event && event.type
      const data: any = (event && event.data) || {}

      // ---- 团队任务（DSH agent-team，0.2.0-rc.2 起的事件面）----
      //   team/task: { version: 2, teamId, task: TeamTaskSnapshot }
      //   TeamTaskSnapshot.status: pending | in_progress | completed | deleted
      // 只对**状态变化**发通知（每次 mutation 都会带新 revision 重发同一条任务）。
      if (type === 'team/task') {
        const task = data.task || {}
        const taskId = String(task.id || '')
        const status = String(task.status || '')
        if (taskId && (status === 'pending' || status === 'completed')) {
          const prev = state.teamTaskStatus.get(taskId)
          state.teamTaskStatus.set(taskId, status)
          if (prev !== status) {
            const subject = truncateText(String(task.subject || task.description || taskId).replace(/\s+/g, ' ').trim(), 160)
            const owner = task.ownerId ? String(task.ownerId) : ''
            const root = rootSessionIdOf(owner || session)
            const rootTitle = sessionTitleText(root || session)
            notify(status === 'completed' ? '✅ 团队任务已完成' : '🕒 团队任务待处理',
              withPrefix(rootTitle, root || session, subject),
              status === 'completed' ? 'low' : 'normal',
              [root, owner, session].filter((v) => !!v),
              { dedupeKey: 'team:' + taskId + ':' + status, click: clickForSession(root || owner || session) })
          }
        }
        return
      }

      // ---- 上下文智能压缩 ----
      //   compaction/end: { compactionId, turn, error? } —— 无 error 才算"压缩成功"
      if (type === 'compaction/end') {
        if (data.error) return
        const root = rootSessionIdOf(session)
        notify('🗜️ 上下文已智能压缩', withPrefix(sessionTitleText(root || session), root || session, '上下文已智能压缩'),
          'low', [root || session], { dedupeKey: 'compact:' + String(data.compactionId || ''), click: clickForSession(root || session) })
        return
      }

      // ---- 定时任务（DSH schedule）----
      //   schedule/change: { version, operation: 'create'|'delete'|dispatch…, schedule?, id? }
      // 只报 create（"已启动"）：delete/dispatch 不打扰。
      if (type === 'schedule/change') {
        if (String(data.operation || '') !== 'create') return
        const schedule = data.schedule || {}
        const root = rootSessionIdOf(session)
        const what = truncateText(String(schedule.title || schedule.prompt || schedule.id || '定时任务').replace(/\s+/g, ' ').trim(), 160)
        notify('⏰ 定时任务已启动', withPrefix(sessionTitleText(root || session), root || session, what),
          'low', [root || session], { dedupeKey: 'schedule:' + String(schedule.id || data.id || what), click: clickForSession(root || session) })
        return
      }

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
            withPrefix(sessionTitleText(session), session, ((info as any).tool || '工具') + '-' + ((info as any).reason || '操作被自动拒绝')),
            'normal', session, { dedupeKey: 'approval:' + id, click: clickForSession(session) })
        }
      }
    } catch (e) {
      console.error('[dsh-desktop-notify] session feed hook error:', e && e.message)
    }
  })

  // ---- 任务完成：根 agent idle 持续 3s ----
  ctx.on('agent/status', (payload: any) => {
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
        notify('✅ DSH 任务完成', withPrefix(title, agent.session, (entry as any).text || '任务已完成'),
          'low', agent.session, { dedupeKey: 'session:' + sessionKey, click: clickForSession(agent.session) })
      }, 3000)
      state.pendingIdle.set(agentId, () => { try { cancel() } catch (e) { /* ignore */ } })
    } catch (e) {
      console.error('[dsh-desktop-notify] status hook error:', e && e.message)
    }
  })

  // ---- ask_user_question 派发 ----
  ctx.on('tools/execute', (exec: any, next: any) => {
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
          'normal', session, { dedupeKey: exec.callId ? 'ask:' + exec.callId : '', click: clickForSession(session) })
      }
    } catch (e) {
      console.error('[dsh-desktop-notify] ask hook error:', e && e.message)
    }
    return next()
  })

  // ---- 后台子代理结束 ----
  ctx.on('subagent/end', (info: any) => {
    try {
      if (!info) return
      const subId = String(info.id)
      // 前缀 = 工作区/**顶层母会话**名（多层子代理也一路回溯到母会话），正文 = 子代理名已完成
      const main = mainSessionFor(subId)
      const mainTitle = main ? sessionTitleText(main) : ''
      // 会话归属 = 主会话 + 子会话本身：你正在看其中任一个，这条就不必打扰。
      // 点击跳转指向**母会话**：子代理（尤其是多层）的会话 id 客户端目录里未必解析得到，
      // 而"回到母会话"是用户真正要的落点（子代理自身的会话名在正文里已经写明）。
      notify('🤖 后台子代理结束',
        withPrefix(mainTitle, main || subId, (sessionTitleText(subId) || subId || '后台子代理') + '已完成'),
        'low', [main, subId], {
          dedupeKey: 'subagent:' + (info.runId || subId),
          click: clickForSession(main || subId),
        })
    } catch (e) { /* ignore */ }
  })

  // ---- 目标完成 / 阻塞 ----
  // GoalChanged = { operation, ref, goal? }（goal 仅在 clear 时缺失）；
  // GoalOperation: create|edit|pause|resume|complete|block|clear
  ctx.on('goal/changed', (payload: any) => {
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
        notify('🎯 目标已完成', withPrefix(t, goalSession, objective + '-已完成'), 'normal', goalSession, { dedupeKey: goalKey, click: clickForSession(goalSession) })
      } else if (change.operation === 'block') {
        // blockedReason 是 { code, message } 对象（不是字符串）
        const br = goal.blockedReason
        notify('🎯 目标已阻塞',
          withPrefix(t, goalSession, objective + (br && br.message ? '-' + truncateText(br.message, 160) : '')),
          'normal', goalSession, { dedupeKey: goalKey, click: clickForSession(goalSession) })
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
        // owner 可能是**子代理会话**（子代理派生的后台任务）：一路回溯到母会话，
        // 否则点击会因为客户端目录里没有这个子会话而"点了不跳"。
        const jobRoot = rootSessionIdOf(jobSession)
        const mainTitle = sessionTitleText(jobRoot || jobSession)
        const label = String(job.label || job.id || '后台任务')
        const status = String(job.status || '')
        const suffix = status === 'failed' ? '失败' : status === 'killed' ? '被终止' : '已完成'
        log(`[dsh-desktop-notify] job settled ${job.id} label=${job.label} status=${status} cause=${event.cause} owner=${jobSession || '-'} root=${jobRoot || '-'}`)
        notify('🧰 后台任务结束',
          withPrefix(mainTitle, jobRoot || jobSession, label + suffix),
          status === 'failed' ? 'normal' : 'low',
          [jobRoot, jobSession].filter((v) => !!v), // 取不到会话归属时 notify 不静默（照常推送）
          { dedupeKey: 'job:' + String(job.id || ''), click: clickForSession(jobRoot || jobSession) })   // 同名任务在同一窗口内结算也要各自弹
      } catch (e) { /* ignore */ }
    }))
  })

  // 启动播报：每次进程启动只推一次（放在最后，确保所有监听/服务都已就绪）
  reportStartupOnce()

  log(`[dsh-desktop-notify] plugin ready (${process.platform}, backend=${backend ? 'yes' : 'none'})`)
}
