// DSH 桌面通知 — 常驻 host 插件（web-profile bundle，免审批，随 dsh web 启动加载）。
//
// 监听宿主事件 → 组装文案 → 通过 subprocess 服务调用一次性 Python 进程
// （desktop-notifier）发送 Windows Toast。页面可见性门控由浏览器半区
// lib/client.js 经官方 Connection RPC 通道 /dnotify 上报。
//
// 通知类别：
//   ✅ 任务完成      agent/status running→idle（仅根 agent，3s 去抖）
//   ❓ 等待你回答    tools/execute 捕获 ask_user_question 派发
//   🚫 审批被自动拒绝 session/event 流 approval/asked+decided 审计对（never 政策下
//                     approval/request waterfall 不会派发，只能走会话日志）
//   🤖 后台子任务结束 subagent/end
//   🎯 目标完成/阻塞 goal/changed
//   🧰 后台任务结束  jobs.onJobDone

const PY_SRC = [
  'import sys, json, asyncio',
  'from desktop_notifier import DesktopNotifier, Urgency',
  'async def main():',
  '    p = json.loads(sys.argv[1])',
  "    n = DesktopNotifier(app_name='DSH')",
  "    u = Urgency.Low if p.get('u') == 'low' else Urgency.Normal",
  "    await n.send(title=p['t'], message=p.get('m', ''), urgency=u)",
  '    await asyncio.sleep(0.8)',
  'asyncio.run(main())',
].join('\n')

export const name = 'dsh-desktop-notify'
export const inject = ['connection', 'timer']

export function apply(ctx) {
  const state = {
    pageVisible: false,
    lastReportAt: 0,
    pythonPath: 'python',
    cwd: '',
    lastTextBySession: new Map(),
    askAtBySession: new Map(),
    asksById: new Map(),
    pendingIdle: new Map(),
  }

  const timers = new Set()
  ctx.effect(() => () => {
    for (const cancel of timers) {
      try { cancel() } catch (e) { /* ignore */ }
    }
    timers.clear()
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
      (p) => { state.pythonPath = p },
      () => subprocess.resolveExecutable('py').then(
        (p) => { state.pythonPath = p },
        () => { /* keep default */ },
      ),
    )
  }
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandboxPolicy !== undefined && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) {
    state.cwd = sandboxPolicy.workspaceRoot
  }
  if (!state.cwd) {
    const fsSvc = ctx.get('fs')
    if (fsSvc !== undefined && typeof fsSvc.resolve === 'function') {
      fsSvc.resolve('.').then((t) => {
        try { state.cwd = fsSvc.processPath(t) } catch (e) { /* ignore */ }
      }, () => { /* ignore */ })
    }
  }

  function fire(item) {
    if (subprocess === undefined) return
    if (!state.cwd) {
      console.error('[dsh-desktop-notify] no cwd resolved, skipped:', item.title)
      return
    }
    const payload = JSON.stringify({
      t: String(item.title).slice(0, 160),
      m: String(item.message || '').slice(0, 400),
      u: item.urgency === 'low' ? 'low' : 'normal',
    })
    let handle
    try {
      handle = subprocess.spawn({
        argv: [state.pythonPath, '-X', 'utf8', '-c', PY_SRC, payload],
        cwd: state.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 2048 }, stderr: { maxBytes: 2048 } },
        graceMs: 10000,
      })
    } catch (e) {
      console.error('[dsh-desktop-notify] spawn threw:', e && e.message)
      return
    }
    handle.done.then((o) => {
      if (o.exitCode !== 0) {
        let err = ''
        try { if (handle.collected.stderr) err = handle.collected.stderr.readFrom(0).text } catch (e) { /* ignore */ }
        console.error('[dsh-desktop-notify] python exited', o.exitCode, err.slice(0, 500))
      }
    }, (e) => console.error('[dsh-desktop-notify] spawn failed:', e && e.message))
  }

  // ---- 门控 + 间隔队列 ----
  const queue = []
  let draining = false
  function notify(title, message, urgency) {
    const now = Date.now()
    if (state.pageVisible && now - state.lastReportAt < 90000) return
    queue.push({ title, message, urgency })
    if (!draining) {
      draining = true
      const step = () => {
        if (queue.length === 0) {
          draining = false
          return
        }
        fire(queue.shift())
        later(step, 700)
      }
      step()
    }
  }

  // ---- Connection RPC：浏览器半区上报页面可见性 ----
  ctx.connection.rpc.handle('/dnotify', async (endpoint, payload) => {
    if (endpoint === 'page-visibility') {
      state.pageVisible = !!(payload && payload.visible)
      state.lastReportAt = Date.now()
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
          notify('🚫 操作被自动拒绝', (info.tool || '工具') + (info.reason ? ' — ' + info.reason : ''), 'normal')
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
        notify('✅ DSH 任务完成', (title ? title + ' — ' : '') + summary, 'low')
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
        if (exec.agent && exec.agent.id !== undefined) state.askAtBySession.set(String(exec.agent.id), Date.now())
        notify('❓ DSH 等待你的输入', (h ? '[' + h + '] ' : '') + q, 'normal')
      }
    } catch (e) {
      console.error('[dsh-desktop-notify] ask hook error:', e && e.message)
    }
    return next()
  })

  // ---- 后台子任务结束 ----
  ctx.on('subagent/end', (info) => {
    try {
      if (!info) return
      let text = ''
      if (Array.isArray(info.lastAssistantMessage)) {
        for (const b of info.lastAssistantMessage) {
          if (b && b.type === 'text' && typeof b.text === 'string') text += (text ? ' ' : '') + b.text
        }
      }
      text = text.replace(/\s+/g, ' ').trim().slice(0, 220)
      notify(
        '🤖 后台子任务结束',
        (info.provider ? String(info.provider) + ' · ' : '') + String(info.stopReason || 'settled') + (text ? ' — ' + text : ''),
        'low',
      )
    } catch (e) { /* ignore */ }
  })

  // ---- 目标完成 / 阻塞 ----
  ctx.on('goal/changed', (payload) => {
    try {
      const change = payload && payload.change
      const goal = change && change.goal
      if (!goal) return
      const objective = String(goal.objective || '').slice(0, 200)
      if (change.operation === 'complete') {
        notify('🎯 目标已完成', objective, 'normal')
      } else if (change.operation === 'block') {
        const br = goal.blockedReason
        notify('🎯 目标已阻塞', objective + (br && br.message ? ' — ' + String(br.message).slice(0, 160) : ''), 'normal')
      }
    } catch (e) { /* ignore */ }
  })

  // ---- 后台任务（jobs）结束 ----
  const jobs = ctx.get('jobs')
  if (jobs !== undefined && typeof jobs.onJobDone === 'function') {
    ctx.effect(() => jobs.onJobDone((snapshot) => {
      try {
        const s = snapshot || {}
        if (s.reported) return
        notify(
          '🧰 后台任务结束',
          String(s.label || s.id || 'job') + ' · ' + String(s.status || '') + (s.detail ? ' — ' + String(s.detail).slice(0, 140) : ''),
          'low',
        )
      } catch (e) { /* ignore */ }
    }))
  }

  console.log('[dsh-desktop-notify] plugin ready; python =', state.pythonPath)
}
