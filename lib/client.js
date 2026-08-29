// DSH 桌面通知 — 浏览器半区（web-profile bundle，免审批）。
// 包装在 shell 的 __ModuleLoader__ 格式中；通过官方 Connection RPC 通道
// /dnotify 向 host 上报页面可见性（协议与 @deepseek-ai/dsh-client-connection
// 的 createWebConnectionRpc 相同）。host 收到 visible=false 才允许弹通知。
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
        body: JSON.stringify(message),
      }).then(function (res) {
        if (!res.ok) throw new Error('dnotify RPC ' + endpoint + ': HTTP ' + res.status)
        return res.json()
      }).then(function (full) {
        if (!full || full.type !== 'server-response' || full.rpcId !== message.rpcId) throw new Error('dnotify RPC envelope mismatch for ' + endpoint)
        return full.result
      })
    }

    function report() {
      try {
        var visible = document.visibilityState === 'visible'
        rpcCall('/dnotify', 'page-visibility', { visible: visible }).catch(function () {})
      } catch (e) { /* ignore */ }
    }

    exports.apply = function apply(ctx) {
      report()
      document.addEventListener('visibilitychange', report)
      ctx.effect(function () {
        return function () { document.removeEventListener('visibilitychange', report) }
      })
      var timer = ctx.get('timer')
      if (timer !== undefined && typeof timer.interval === 'function') {
        var cancel = timer.interval(report, 30000)
        ctx.effect(function () {
          return function () { try { cancel() } catch (e) { /* ignore */ } }
        })
      }
    }

    return module.exports
  },
})
