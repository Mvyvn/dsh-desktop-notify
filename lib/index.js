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
// connection/timer 是必需服务；jobs/sessions/sessionTitle/agents/fs 都是可选的，
// 一律用 ctx.get / ctx.inject 惰性取——写进 inject 会让缺服务的组合整个插件不加载。
export const inject = ['connection', 'timer']

/** 主题跟踪的持有者标记（模块级单例状态，见 apply 里的说明）。 */
let themeHolder = null

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
  // dedupeKey：可选的"身份"后缀——同标题同正文但不是同一件事时（例如两个同名后台
  // 任务在同一秒内结算）必须各自弹，否则去重窗口会把它们合并成一条。
  function notify(title, message, urgency, sessionOrIds, dedupeKey) {
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
    const key = title + '\u0000' + (message || '') + '\u0000' + (dedupeKey || '') + '\u0000' + sessionIds.join(',')
    if (!shouldSend(key, Date.now())) {
      log('[dsh-desktop-notify] 同文案在去重窗口内，跳过')
      return { queued: false, silenced: false, reason: 'duplicate' }
    }
    const queued = enqueue({ title, message, urgency })
    return { queued, silenced: false, reason: queued ? '' : 'dropped' }
  }

  // ---- 对外 API：其它插件经 ctx.get('desktopNotify') 推送 ----
  //   push(item)       走聚焦门控（按会话）
  //   pushAlways(item) 绕过门控，始终弹
  //   notify(item)     同上但返回结构化结果（是否入队/是否被静默/原因）
  // item = { title, message?, urgency?: 'low'|'normal'|'critical', sessionId? }
  // ⚠️ 服务名可能已被上一轮加载注册（热更新/重复加载）：这时只记日志，不让整个插件挂掉。
  try {
    const disposeNotifyApi = ctx.provide('desktopNotify', createNotifyApi({ notify, enqueue }))
    if (typeof disposeNotifyApi === 'function') ctx.effect(() => disposeNotifyApi)
  } catch (e) {
    console.error('[dsh-desktop-notify] desktopNotify 服务注册失败（可能已注册）:', e && e.message)
  }

  // ---- Connection RPC：浏览器半区上报"页面聚焦 + 当前选中会话"（按页面聚合）----
  // 0.1.7 的 handle 只有两个参数（历史上的 { authority } 第三参早已移除），
  // 返回值必须是 { ok: true, value } / { ok: false, error: { code, message, details } }。
  const disposeRpc = ctx.connection.rpc.handle('/dnotify', async (endpoint, payload) => {
    if (endpoint === 'page-focus') {
      const pageId = payload && payload.pageId ? String(payload.pageId) : 'page'
      const sessionId = payload && payload.sessionId !== undefined && payload.sessionId !== null
        ? String(payload.sessionId)
        : ''
      if (payload && payload.focused) gate.setPage(pageId, Date.now(), sessionId)
      else gate.clearPage(pageId)
      log(`[dsh-desktop-notify] page-focus ${pageId} -> ${payload && payload.focused ? 'focused' : 'unfocused'} session=${sessionId || '-'} (pages=${gate.size})`)
      return { ok: true, value: { pages: gate.size } }
    }
    return {
      ok: false,
      error: { code: 'dnotify/unknown-endpoint', message: 'unknown endpoint: ' + endpoint, details: {} },
    }
  })
  if (typeof disposeRpc === 'function') ctx.effect(() => disposeRpc)

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
            'normal', session, 'approval:' + id)
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
          'low', agent.session, 'session:' + sessionKey)
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
          'normal', session, exec.callId ? 'ask:' + exec.callId : '')
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
      // 会话归属 = 主会话 + 子会话本身：你正在看其中任一个，这条就不必打扰
      notify('🤖 后台子代理结束',
        withPrefix(mainTitle, main || subId, (sessionTitleText(subId) || subId || '后台子代理') + '已完成'),
        'low', [main, subId], 'subagent:' + (info.runId || subId))
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
        notify('🎯 目标已完成', withPrefix(t, goalSession, objective + '-已完成'), 'normal', goalSession, goalKey)
      } else if (change.operation === 'block') {
        // blockedReason 是 { code, message } 对象（不是字符串）
        const br = goal.blockedReason
        notify('🎯 目标已阻塞',
          withPrefix(t, goalSession, objective + (br && br.message ? '-' + truncateText(br.message, 160) : '')),
          'normal', goalSession, goalKey)
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
          'job:' + String(job.id || ''))   // 同名任务在同一窗口内结算也要各自弹
      } catch (e) { /* ignore */ }
    }))
  })

  log(`[dsh-desktop-notify] plugin ready (${process.platform}, backend=${backend ? 'yes' : 'none'})`)
}
