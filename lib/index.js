// DSH 桌面通知 — 常驻 host 插件（web-profile bundle，免审批，随 dsh web 启动加载）。
//
// 监听宿主事件 → 组装文案 → 经常驻 Python 助手（stdin 逐行 JSON）发送 Windows
// Toast。聚焦门控由浏览器半区 lib/client.js 经官方 Connection RPC 通道 /dnotify
// 上报：仅 DSH 网页聚焦时静默，非聚焦（即使窗口在前台）一律推送。
//
// 通知类别：
//   ✅ 任务完成      agent/status running→idle（仅根 agent，3s 去抖）
//   ❓ 等待你回答    tools/execute 捕获 ask_user_question 派发
//   🚫 审批被自动拒绝 session/event 流 approval/asked+decided 审计对（never 政策下
//                     approval/request waterfall 不会派发，只能走会话日志）
//   🤖 后台子代理结束 subagent/end
//   🎯 目标完成/阻塞 goal/changed
//   🧰 后台任务结束  jobs.onJobDone

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 通知图标：Windows Toast 的 appLogoOverride 只支持 PNG/JPG/GIF（SVG 不行），
// 而 desktop-notifier 默认用自带的 python.png —— 因此预栅格化 assets/dsh.png
// （见 scripts/make-icon.py），随包安装并在每次发送时传给 Python 端。
const ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'dsh.png')
const HAS_ICON = existsSync(ICON_PATH)

// 常驻 Python 助手：启动一次（导入 desktop-notifier/WinRT），此后逐行从 stdin
// 读取 JSON 载荷发送 Toast —— 消除"每条通知冷启一个 Python 进程"的延迟。
// 单事件循环 + 守护线程：同步读 stdin 保证顺序，发送经 run_coroutine_threadsafe
// 提交到常驻 loop，fut.result() 串行等待，避免每次发送重建事件循环。
const PY_HELPER = [
  'import sys, json, asyncio, threading',
  'from pathlib import Path',
  'from desktop_notifier import DesktopNotifier, Urgency, Icon',
  'def main():',
  "    icon = Icon(path=Path(sys.argv[1])) if len(sys.argv) > 1 and sys.argv[1] else None",
  "    n = DesktopNotifier(app_name='DSH', app_icon=icon)",
  '    loop = asyncio.new_event_loop()',
  '    th = threading.Thread(target=loop.run_forever, daemon=True)',
  '    th.start()',
  '    for line in sys.stdin:',
  '        line = line.strip()',
  '        if not line:',
  '            continue',
  '        try:',
  '            p = json.loads(line)',
  "            u = Urgency.Low if p.get('u') == 'low' else Urgency.Normal",
  "            fut = asyncio.run_coroutine_threadsafe(n.send(title=p['t'], message=p.get('m', ''), urgency=u), loop)",
  '            fut.result(timeout=10)',
  '        except Exception as e:',
  "            sys.stderr.write('ERR %r\\n' % (e,))",
  '            sys.stderr.flush()',
  '    loop.call_soon_threadsafe(loop.stop)',
  '    th.join(timeout=2)',
  'main()',
].join('\n')

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
    pages: new Map(),  // pageId → 最近聚焦上报时间；任一页面聚焦即静默（多标签聚合）
    pythonPath: 'python',
    cwd: '',
    workspaceName: '',
    icon: HAS_ICON ? ICON_PATH : '',
    lastTextBySession: new Map(),
    askAtBySession: new Map(),
    asksById: new Map(),
    pendingIdle: new Map(),
  }
  // 聚焦静默超时（2 分钟）：聚焦页面无任何用户活动上报视为失焦——
  // 同时覆盖"用户聚焦静止"与"页面崩溃无上报"两种场景。
  // 锁屏/睡眠/切窗口/切标签都有即时 blur/visibilitychange/pagehide 事件，不受此限。
  const FOCUS_STALE_MS = 120000
  let helper = null  // 常驻 Python 助手（{ handle, dead }）

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

  // 常驻 Python 助手随 dsh 启动：cwd 与 python 路径就绪后立即拉起（懒初始化兜底）。
  function tryLaunchHelper() {
    if (helper || !state.cwd || subprocess === undefined) return
    ensureHelper()
  }

  const timers = new Set()
  ctx.effect(() => () => {
    for (const cancel of timers) {
      try { cancel() } catch (e) { /* ignore */ }
    }
    timers.clear()
    if (helper) {
      try { helper.handle.terminate() } catch (e) { /* ignore */ }
      helper = null
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

  // ---- Python 解释器解析 + 工作目录 ----
  const subprocess = ctx.get('subprocess')
  if (subprocess !== undefined && typeof subprocess.resolveExecutable === 'function') {
    subprocess.resolveExecutable('python').then(
      (p) => { state.pythonPath = p; tryLaunchHelper() },
      () => subprocess.resolveExecutable('py').then(
        (p) => { state.pythonPath = p; tryLaunchHelper() },
        () => { tryLaunchHelper() /* keep default */ },
      ),
    )
  }
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandboxPolicy !== undefined && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) {
    state.cwd = sandboxPolicy.workspaceRoot
    tryLaunchHelper()
  }
  if (!state.cwd) {
    const fsSvc = ctx.get('fs')
    if (fsSvc !== undefined && typeof fsSvc.resolve === 'function') {
      fsSvc.resolve('.').then((t) => {
        try { state.cwd = fsSvc.processPath(t) } catch (e) { /* ignore */ }
        tryLaunchHelper()
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

  // ---- 常驻 Python 助手：启动一次，逐行 stdin 发送 ----
  function ensureHelper() {
    if (helper && !helper.dead) return helper
    const argv = [state.pythonPath, '-X', 'utf8', '-c', PY_HELPER]
    if (state.icon) argv.push(state.icon)
    let handle
    try {
      handle = subprocess.spawn({
        argv,
        cwd: state.cwd,
        stdio: { stdin: 'pipe', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 10000,
      })
    } catch (e) {
      console.error('[dsh-desktop-notify] helper spawn threw:', e && e.message)
      return null
    }
    helper = { handle, dead: false }
    handle.done.then((o) => {
      // 清理竞态：插件卸载 terminate() 后 helper 可能已置 null，或被崩溃重建的新 helper
      // 替换——只有仍是同一个 handle 时才标记 dead（否则会写 null 或误标新 helper）。
      if (helper === null || helper.handle !== handle) return
      helper.dead = true
      if (o.exitCode !== 0) {
        let err = ''
        try { if (handle.collected.stderr) err = handle.collected.stderr.readFrom(0).text } catch (e) { /* ignore */ }
        console.error('[dsh-desktop-notify] helper exited', o.exitCode, err.slice(0, 500))
      }
    }, (e) => {
      if (helper === null || helper.handle !== handle) return
      helper.dead = true
      console.error('[dsh-desktop-notify] helper spawn failed:', e && e.message)
    })
    return helper
  }

  function fire(item) {
    if (subprocess === undefined) return
    if (!state.cwd) {
      console.error('[dsh-desktop-notify] no cwd resolved, skipped:', item.title)
      return
    }
    const h = ensureHelper()
    if (!h) {
      // helper 拉不起来：单次重排队（_retried 防无限重试），下轮重建后再发
      log('[dsh-desktop-notify] fire: helper unavailable, requeue', item.title)
      if (!item._retried) { item._retried = true; queue.unshift(item) }
      return
    }
    log('[dsh-desktop-notify] fire -> helper:', item.title)
    const payload = JSON.stringify({
      t: String(item.title).slice(0, 160),
      m: String(item.message || '').slice(0, 400),
      u: item.urgency === 'low' ? 'low' : 'normal',
    }) + '\n'
    const onErr = (err) => {
      h.dead = true
      console.error('[dsh-desktop-notify] helper stdin write failed:', err && err.message)
      if (!item._retried) { item._retried = true; queue.unshift(item) }
    }
    try {
      h.handle.stdin.write(payload, (err) => { if (err) onErr(err) })
    } catch (e) {
      onErr(e)
    }
  }

  // ---- 门控 + 间隔队列 ----
  const queue = []
  let draining = false
  function notify(title, message, urgency) {
    const now = Date.now()
    // 聚焦门控：任一 DSH 页面聚焦且 2 分钟内有过活动上报 → 静默；
    // 无页面 / 非聚焦 / 聚焦静止超 2 分钟 / 页面崩溃无上报 → 一律推送。
    // 残留条目清理：页面异常关闭/浏览器退出导致 pagehide 上报丢失时，
    // 条目会残留在集合里；10 分钟无任何上报的条目视为已离开，自动移除。
    if (state.pages.size > 0) {
      const STALE_PAGE_MS = 600000
      for (const [id, t] of state.pages) {
        if (now - t > STALE_PAGE_MS) state.pages.delete(id)
      }
    }
    let recentFocus = 0
    if (state.pages.size > 0) {
      for (const t of state.pages.values()) {
        if (t > recentFocus) recentFocus = t
      }
    }
    const silenced = recentFocus > 0 && now - recentFocus < FOCUS_STALE_MS
    log(`[dsh-desktop-notify] notify(${title}) pages=${state.pages.size} recentFocusAge=${recentFocus ? Math.round((now - recentFocus) / 1000) + 's' : '-'} silenced=${silenced}`)
    if (silenced) return
    queue.push({ title, message, urgency })
    if (!draining) {
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
  }

  // ---- Connection RPC：浏览器半区上报页面聚焦状态（按页面聚合）----
  ctx.connection.rpc.handle('/dnotify', async (endpoint, payload) => {
    if (endpoint === 'page-focus') {
      const pageId = payload && payload.pageId ? String(payload.pageId) : 'page'
      if (payload && payload.focused) state.pages.set(pageId, Date.now())
      else state.pages.delete(pageId)
      log(`[dsh-desktop-notify] page-focus ${pageId} -> ${payload && payload.focused ? 'focused' : 'unfocused'} (pages=${state.pages.size})`)
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
        text = text.replace(/\s+/g, ' ').trim().slice(0, 220)
        // 记录所有会话摘要（含子代理，备用后续功能）；消费即释放控制内存
        if (text && session && session.id !== undefined) state.lastTextBySession.set(String(session.id), text)
      } else if (type === 'approval/asked') {
        if (data && data.id !== undefined) {
          state.asksById.set(String(data.id), {
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
          notify('🚫 操作被自动拒绝', (locPrefix(t, session) ? locPrefix(t, session) + ':' : '') + (info.tool || '工具') + '-' + (info.reason || '操作被自动拒绝'), 'normal')
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
        notify('✅ DSH 任务完成', (locPrefix(title, agent.session) ? locPrefix(title, agent.session) + ':' : '') + summary, 'low')
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
        notify('❓ DSH 等待你的输入', (locPrefix(t, exec.agent && exec.agent.session) ? locPrefix(t, exec.agent && exec.agent.session) + ':' : '') + (h ? '[' + h + '] ' : '') + q, 'normal')
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
      notify('🤖 后台子代理结束', (locPrefix(mainTitle, main || subId) ? locPrefix(mainTitle, main || subId) + ':' : '') + (sessionTitleText(subId) || subId || '后台子代理') + '已完成', 'low')
    } catch (e) { /* ignore */ }
  })

  // ---- 目标完成 / 阻塞 ----
  ctx.on('goal/changed', (payload) => {
    try {
      const change = payload && payload.change
      const goal = change && change.goal
      if (!goal) return
      const objective = String(goal.objective || '').slice(0, 200)
      const t = sessionTitleText(payload && payload.agent && payload.agent.session)
      if (change.operation === 'complete') {
        notify('🎯 目标已完成', (locPrefix(t, payload && payload.agent && payload.agent.session) ? locPrefix(t, payload && payload.agent && payload.agent.session) + ':' : '') + objective + '-已完成', 'normal')
      } else if (change.operation === 'block') {
        const br = goal.blockedReason
        notify('🎯 目标已阻塞', (locPrefix(t, payload && payload.agent && payload.agent.session) ? locPrefix(t, payload && payload.agent && payload.agent.session) + ':' : '') + objective + (br && br.message ? '-' + String(br.message).slice(0, 160) : ''), 'normal')
      }
    } catch (e) { /* ignore */ }
  })

  // ---- 后台任务（jobs）结束 ----
  const jobs = ctx.get('jobs')
  log('[dsh-desktop-notify] jobs service:', jobs === undefined ? 'MISSING' : 'available')
  if (jobs !== undefined && typeof jobs.onJobDone === 'function') {
    ctx.effect(() => jobs.onJobDone((snapshot, owner) => {
      try {
        const s = snapshot || {}
        log(`[dsh-desktop-notify] onJobDone ${s.id} label=${s.label} status=${s.status} reported=${s.reported} owner=${owner ? owner.id : 'none'}`)
        if (s.reported) return
        // 前缀 = 工作区/主会话名（owner 的会话优先，其次 ownerSession id；工作区按会话 cwd 解析）
        const mainTitle = sessionTitleText(owner && owner.session) || sessionTitleText(s.ownerSession) || ''
        notify(
          '🧰 后台任务结束',
          (locPrefix(mainTitle, (owner && owner.session) || s.ownerSession) ? locPrefix(mainTitle, (owner && owner.session) || s.ownerSession) + ':' : '') + String(s.label || s.id || '后台任务') + '已完成',
          'low',
        )
      } catch (e) { /* ignore */ }
    }))
  }

  log('[dsh-desktop-notify] plugin ready; python =', state.pythonPath)
}
