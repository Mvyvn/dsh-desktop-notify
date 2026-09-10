// DSH 桌面通知 — 常驻 host 插件（web-profile bundle，免审批，随 dsh web 启动加载）。
//
// 监听宿主事件 → 组装文案 → 按平台交给发送层发系统通知：
//   Windows → lib/winrt.js（koffi 直调 WinRT 发 Toast，首次发送补写 AUMID 注册表图标）
//   Linux   → lib/toast-linux.js（纯 JS 直连 D-Bus org.freedesktop.Notifications，无子进程）
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
//   🧰 后台任务结束  jobs.onJobDone
//
// 另外对外提供 ctx.get('desktopNotify') 服务（见 lib/api.js），其它插件可直接推送。

import { createFocusGate, sessionIdList } from './gate.js'
import { createNotifyApi } from './api.js'
import { truncateText } from './text.js'

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
export const inject = ['connection', 'timer']

// 调试日志开关（默认关闭）：config.debug 由插件行的 config 提供（cordis.patch.yml），
// 关闭时终端不输出任何 [dsh-desktop-notify] 状态信息，避免污染终端上下文。
// 开启方法：在 profile 的 cordis.patch.yml 中覆盖 desktop-notify 行：
//   - id: desktop-notify
//     config: { debug: true }
export function apply(ctx, config) {
  const DEBUG = !!(config && config.debug)
  const log = (...args) => { if (DEBUG) console.log(...args) }
  const state = {
    cwd: '',
    workspaceName: '',
    lastTextBySession: new Map(),
    askAtBySession: new Map(),
    asksById: new Map(),
    pendingIdle: new Map(),
  }
  // 聚焦门控：按"页面 × 会话"判定（纯逻辑在 lib/gate.js，便于单测）。
  // 聚焦静默超时 2 分钟：聚焦页面无任何用户活动上报视为失焦——同时覆盖
  // "用户聚焦静止"与"页面崩溃无上报"；页面条目 10 分钟无上报自动清理。
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
      if (typeof cwd === 'string' && cwd) {
        const norm = cwd.replace(/[\\/]+$/, '')
        const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
        return i >= 0 ? norm.slice(i + 1) : norm
      }
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
  // 子会话 → 主会话对象（经 header.parentSession 回溯；取不到返回 undefined）
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
  // 记录"提问时刻"（15s 内抑制任务完成通知）；顺带惰性清理过期条目——
  // 过期条目对抑制逻辑毫无用处，清理不退化任何功能，只回收内存。
  function rememberAskAt(id) {
    const now = Date.now()
    if (state.askAtBySession.size >= 16) {
      for (const [k, v] of state.askAtBySession) {
        if (now - v > 15000) state.askAtBySession.delete(k)
      }
    }
    state.askAtBySession.set(id, now)
  }
  // 记录待裁决的审批（等 approval/decided 配对）。孤儿条目（会话被中断、宿主在裁决前退出）
  // 永远不会被删除，常驻进程里必须有上限兜底：超限先丢最旧的（最可能已经无效）。
  const MAX_PENDING_ASKS = 64
  function rememberAsk(id, info) {
    if (!state.asksById.has(id) && state.asksById.size >= MAX_PENDING_ASKS) {
      const overflow = state.asksById.size - MAX_PENDING_ASKS + 1
      let dropped = 0
      for (const key of state.asksById.keys()) {
        state.asksById.delete(key)
        if (++dropped >= overflow) break
      }
    }
    state.asksById.set(id, info)
  }

  const timers = new Set()
  ctx.effect(() => () => {
    for (const cancel of timers) {
      try { cancel() } catch (e) { /* ignore */ }
    }
    timers.clear()
    // Linux 发送层持有常驻 D-Bus 连接，卸载时一并关掉
    if (backend && typeof backend.closeToastConnection === 'function') {
      try { backend.closeToastConnection() } catch (e) { /* ignore */ }
    }
  })
  function later(fn, ms) {
    const cancel = ctx.timeout(() => {
      timers.delete(cancel)
      fn()
    }, ms)
    timers.add(cancel)
    return cancel
  }

  // ---- 工作目录（用于派生工作区名；WinRT 发送不需要 cwd）----
  if (!state.cwd) {
    const fsSvc = ctx.get('fs')
    if (fsSvc !== undefined && typeof fsSvc.resolve === 'function') {
      fsSvc.resolve('.').then((t) => {
        try { state.cwd = fsSvc.processPath(t) } catch (e) { /* ignore */ }
      }, () => { /* ignore */ })
    }
  }
  function deriveWorkspaceName() {
    if (!state.cwd) return ''
    const norm = String(state.cwd).replace(/[\\/]+$/, '')
    const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
    return i >= 0 ? norm.slice(i + 1) : norm
  }
  state.workspaceName = deriveWorkspaceName()

  // ---- 发送：交给平台发送层（Windows 同步、Linux 异步；失败单次重排队）----
  function fire(item) {
    log(`[dsh-desktop-notify] fire -> ${process.platform}:`, item.title)
    try {
      sendToast({
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
    queue.push(item)
    if (draining) return
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
  }

  // 聚焦门控（按会话）：静默条件 = 存在"聚焦且未超时"的页面，且该页面当前选中的
  // 会话 ∈ 通知所属会话；通知未携带会话 id（归属不明，例如 owner 已清理的后台任务）
  // 一律不静默、照常推送。
  function notify(title, message, urgency, sessionOrIds) {
    const sessionIds = sessionIdList(sessionOrIds)
    const silenced = gate.silenced(sessionIds, Date.now())
    log(`[dsh-desktop-notify] notify(${title}) pages=${gate.size} session=${sessionIds.join(',') || '-'} silenced=${silenced}`)
    if (silenced) return false
    enqueue({ title, message, urgency })
    return true
  }

  // ---- 对外 API：其它插件经 ctx.get('desktopNotify') 推送 ----
  //   push(item)       走聚焦门控（按会话）
  //   pushAlways(item) 绕过门控，始终弹
  // item = { title, message?, urgency?: 'low'|'normal'|'critical', sessionId? }
  const disposeNotifyApi = ctx.provide('desktopNotify', createNotifyApi({ notify, enqueue }))
  if (typeof disposeNotifyApi === 'function') ctx.effect(() => disposeNotifyApi)

  // ---- Connection RPC：浏览器半区上报"页面聚焦 + 当前选中会话"（按页面聚合）----
  ctx.connection.rpc.handle('/dnotify', async (endpoint, payload) => {
    if (endpoint === 'page-focus') {
      const pageId = payload && payload.pageId ? String(payload.pageId) : 'page'
      const sessionId = payload && payload.sessionId !== undefined && payload.sessionId !== null
        ? String(payload.sessionId)
        : ''
      if (payload && payload.focused) gate.setPage(pageId, Date.now(), sessionId)
      else gate.clearPage(pageId)
      log(`[dsh-desktop-notify] page-focus ${pageId} -> ${payload && payload.focused ? 'focused' : 'unfocused'} session=${sessionId || '-'} (pages=${gate.size})`)
      return { ok: true }
    }
    return { ok: false, reason: 'unknown endpoint: ' + endpoint }
  }, { authority: 'loopback' })

  // ---- session 事件流：回复摘要 + 审批审计对 ----
  ctx.on('session/event', (session, event) => {
    try {
      const type = event && event.type
      const data = (event && event.data) || {}
      if (type === 'assistant/message') {
        const msg = data.message
        let text = ''
        if (msg && Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b && b.type === 'text' && typeof b.text === 'string') text += (text ? ' ' : '') + b.text
          }
        }
        text = truncateText(text.replace(/\s+/g, ' ').trim(), 220)
        // 记录所有会话摘要（含子代理，备用后续功能）；消费即释放控制内存
        if (text && session && session.id !== undefined) state.lastTextBySession.set(String(session.id), text)
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
        if (info && data.outcome === 'rejected') {
          const t = sessionTitleText(session)
          notify('🚫 操作被自动拒绝', (locPrefix(t, session) ? locPrefix(t, session) + ':' : '') + (info.tool || '工具') + '-' + (info.reason || '操作被自动拒绝'), 'normal', session)
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
      const prevCancel = state.pendingIdle.get(agentId)
      if (prevCancel) {
        prevCancel()
        state.pendingIdle.delete(agentId)
      }
      if (payload.status !== 'idle') return
      const agentsSvc = ctx.get('agents')
      if (agentsSvc !== undefined && typeof agentsSvc.roots === 'function') {
        let isRoot = true
        try { isRoot = agentsSvc.roots().some((a) => String(a.id) === agentId) } catch (e) { /* ignore */ }
        if (!isRoot) return
      }
      const cancel = later(() => {
        state.pendingIdle.delete(agentId)
        const summary = state.lastTextBySession.get(agentId)
        // 消费即释放：无论推送成功还是被门控静默丢弃，这次"完成"的消费已结束，
        // 摘要不再有用；下次该会话产生新回复时自动重新写入（内存只留活跃条目）。
        state.lastTextBySession.delete(agentId)
        if (!summary) return
        const lastAsk = state.askAtBySession.get(agentId) || 0
        if (Date.now() - lastAsk < 15000) return
        let title = ''
        const st = ctx.get('sessionTitle')
        if (st !== undefined && typeof st.get === 'function') {
          try {
            const snap = st.get(agent.session)
            if (snap && typeof snap.title === 'string') title = snap.title
          } catch (e) { /* ignore */ }
        }
        // 消息格式：工作区/会话名:结尾输出内容（工作区按会话动态解析，多工作区并行正常）
        notify('✅ DSH 任务完成', (locPrefix(title, agent.session) ? locPrefix(title, agent.session) + ':' : '') + summary, 'low', agent.session)
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
        if (exec.agent && exec.agent.id !== undefined) rememberAskAt(String(exec.agent.id))
        const t = sessionTitleText(exec.agent && exec.agent.session)
        notify('❓ DSH 等待你的输入', (locPrefix(t, exec.agent && exec.agent.session) ? locPrefix(t, exec.agent && exec.agent.session) + ':' : '') + (h ? '[' + h + '] ' : '') + q, 'normal', exec.agent && exec.agent.session)
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
      notify('🤖 后台子代理结束', (locPrefix(mainTitle, main || subId) ? locPrefix(mainTitle, main || subId) + ':' : '') + (sessionTitleText(subId) || subId || '后台子代理') + '已完成', 'low', [main, subId])
    } catch (e) { /* ignore */ }
  })

  // ---- 目标完成 / 阻塞 ----
  ctx.on('goal/changed', (payload) => {
    try {
      const change = payload && payload.change
      const goal = change && change.goal
      if (!goal) return
      const objective = truncateText(goal.objective || '', 200)
      const goalSession = payload && payload.agent && payload.agent.session
      const t = sessionTitleText(goalSession)
      if (change.operation === 'complete') {
        notify('🎯 目标已完成', (locPrefix(t, goalSession) ? locPrefix(t, goalSession) + ':' : '') + objective + '-已完成', 'normal', goalSession)
      } else if (change.operation === 'block') {
        const br = goal.blockedReason
        notify('🎯 目标已阻塞', (locPrefix(t, goalSession) ? locPrefix(t, goalSession) + ':' : '') + objective + (br && br.message ? '-' + truncateText(br.message, 160) : ''), 'normal', goalSession)
      }
    } catch (e) { /* ignore */ }
  })

  // ---- 后台任务（jobs）结束 ----
  // jobs 是可选服务，不能写进 export const inject（无 jobs 的组合会让整个插件不加载）；
  // 但**也不能**在 apply 里 ctx.get 一次就算数——cordis 对未 inject 的服务不会重跑 apply，
  // 比本插件晚挂载的 jobs 会让钩子永不注册（「后台任务结束」通知静默失效）。
  // 所以先探测，缺了就用 ctx.inject 延迟注册：服务出现时自动生效，消失时随 fiber 卸载。
  function registerJobHook(jobsCtx) {
    const svc = jobsCtx && jobsCtx.jobs
    if (!svc || typeof svc.onJobDone !== 'function') {
      log('[dsh-desktop-notify] jobs 服务存在但没有 onJobDone，跳过后台任务通知')
      return
    }
    jobsCtx.effect(() => svc.onJobDone((snapshot, owner) => {
      try {
        const s = snapshot || {}
        log(`[dsh-desktop-notify] onJobDone ${s.id} label=${s.label} status=${s.status} reported=${s.reported} owner=${owner ? owner.id : 'none'}`)
        if (s.reported) return
        // 前缀 = 工作区/主会话名（owner 的会话优先，其次 ownerSession id；工作区按会话 cwd 解析）
        const jobSession = (owner && owner.session) || s.ownerSession
        const mainTitle = sessionTitleText(owner && owner.session) || sessionTitleText(s.ownerSession) || ''
        notify(
          '🧰 后台任务结束',
          (locPrefix(mainTitle, jobSession) ? locPrefix(mainTitle, jobSession) + ':' : '') + String(s.label || s.id || '后台任务') + '已完成',
          'low',
          jobSession, // 取不到会话归属时 notify 不静默（照常推送）
        )
      } catch (e) { /* ignore */ }
    }))
  }
  const jobsSvc = ctx.get('jobs')
  if (jobsSvc !== undefined && typeof jobsSvc.onJobDone === 'function') {
    log('[dsh-desktop-notify] jobs service: available')
    registerJobHook(ctx)
  } else {
    log('[dsh-desktop-notify] jobs service: pending — 用 ctx.inject 等它就绪')
    ctx.inject(['jobs'], registerJobHook)
  }

  log('[dsh-desktop-notify] plugin ready (WinRT direct)')
}
