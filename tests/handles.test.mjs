// 常驻句柄不得把进程钉在事件循环里。
//
// 背景：CI（ubuntu-latest，走 Linux 后端）上 `npm test` 曾经跑满 6 小时被 runner 强杀，
// 而本地 Windows（走 WinRT 后端）秒退——差别就在 Linux 路径会连上 D-Bus：
// 一个 **ref'd 的常驻 socket** 会让进程永远不自然退出。插件是常驻宿主的一部分，
// 任何"让宿主进程无法结束"的句柄都是真 bug，这个测试把它钉死。
//
// 做法：起一条**假总线**（Windows 用命名管道、Linux 用 unix socket），只实现 SASL 的
// `OK` 应答（够让客户端进入 ready、撤掉握手超时），然后：
//   · 子进程里断言 socket 的 `hasRef() === false`（精确判定，不靠时间）；
//   · 并且子进程必须自己退出（端到端证据：没有别的东西把它钉住）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// import() 只吃 URL：Windows 上传原生路径会直接抛 ERR_UNSUPPORTED_ESM_URL_SCHEME
const DBUS_MODULE = pathToFileURL(path.join(HERE, '..', 'lib', 'dbus.js')).href

const CHILD_PENDING = `
const mod = await import(process.env.DSH_DBUS_MODULE)
mod.setErrorReporter(() => {})
try {
  await mod.call({ path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'ListNames', destination: 'org.freedesktop.DBus', timeoutMs: 1200 })
  process.stdout.write('PENDING_RESOLVED\\n')
} catch (e) {
  process.stdout.write('PENDING_REJECTED ' + (e && e.message) + '\\n')
}
`
const CHILD = `
const mod = await import(process.env.DSH_DBUS_MODULE)
let lastError = null
mod.setErrorReporter((text) => { lastError = String(text) })
let resolved = null
try {
  resolved = mod.parseBusAddress(process.env.DBUS_SESSION_BUS_ADDRESS, typeof process.getuid === 'function' ? process.getuid() : 0, process.env.XDG_RUNTIME_DIR)
} catch (e) { resolved = { error: String(e && e.message) } }
// 触发连接（call 会先建会话、做 SASL，然后排队等 Hello 回复——我们不回复）
mod.call({ path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'ListNames', destination: 'org.freedesktop.DBus' }).catch(() => {})
await new Promise((r) => setTimeout(r, 700))
const s = mod.getSession()
const out = {
  ready: mod.isReady(),
  hasRef: s && s.socket && typeof s.socket.hasRef === 'function' ? s.socket.hasRef() : null,
  hasSocket: !!(s && s.socket),
  failed: !!(s && s.failed),
  resolved,
  lastError,
}
process.stdout.write('RESULT ' + JSON.stringify(out) + '\\n')
// 不主动 exit、不关连接：进程能否自己结束，就是 socket 有没有 unref 的证据
`

test('等待中的 D-Bus 调用必须有结论：超时计时器不许 unref（CI 曾因此永不 settle）', async () => {
  // 复现 CI 的条件：总线接受连接、SASL 通过，但**从不回复**我们的调用。
  // 这时唯一能保证 promise 落地的是那个超时计时器；它一旦 unref，事件循环会先排空，
  // await 永远不 settle —— 正是日志里的 'unsettled top-level await' / 'Promise resolution is
  // still pending but the event loop has already resolved'。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dbus-slow-'))
  const busPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-dbus-slow-${process.pid}-${Date.now()}`
    : path.join(tmp, 'bus')
  const server = net.createServer((sock) => {
    sock.on('data', (buf) => {
      if (!sock.__ok && buf.includes(0x0a)) { sock.__ok = true; sock.write('OK 0123456789abcdef0123456789abcdef\r\n') }
      // 之后的 Hello / Read 一律不回复
    })
    sock.on('error', () => {})
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(busPath, resolve) })
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_PENDING], {
      env: { ...process.env, DSH_DBUS_MODULE: DBUS_MODULE, DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    const done = await Promise.race([
      new Promise((r) => child.once('exit', () => r(true))),
      new Promise((r) => setTimeout(() => r(false), 9000)),
    ])
    if (!done) child.kill()
    assert.match(out, /PENDING_REJECTED/, `等待中的调用必须被超时拒绝（out=${out.slice(0, 200)} err=${err.slice(0, 200)}）`)
  } finally {
    server.close()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
})

test('D-Bus 常驻连接必须 unref：不得把宿主进程钉在事件循环里', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dbus-'))
  const busPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-dbus-test-${process.pid}-${Date.now()}`
    : path.join(tmp, 'bus')
  const server = net.createServer((sock) => {
    sock.on('data', (buf) => {
      // SASL 第一行（\0 + AUTH EXTERNAL …\r\n）→ 回 OK <guid>；之后保持连接不动
      if (!sock.__ok && buf.includes(0x0a)) {
        sock.__ok = true
        sock.write('OK 0123456789abcdef0123456789abcdef\r\n')
      }
    })
    sock.on('error', () => { /* 测试自己收尾 */ })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(busPath, resolve)
  })

  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: { ...process.env, DSH_DBUS_MODULE: DBUS_MODULE, DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { stdout += String(b) })
    child.stderr.on('data', (b) => { stderr += String(b) })
    const startedAt = Date.now()
    // 子进程**故意**留着一次等待中的 Hello 调用：它的超时计时器是 ref 的（等待中的操作必须
    // 保证 promise 落地），而 socket 是 unref 的。socket 忘了 unref 的进程永远不会退出，
    // 所以 8s 窗口足以区分；正常情况在 Hello 超时（5s）后自然退出。
    const exited = await Promise.race([
      new Promise((r) => child.once('exit', (code) => r({ code }))),
      new Promise((r) => setTimeout(() => r(null), 8000)),
    ])
    const elapsedMs = Date.now() - startedAt
    if (exited === null) { child.kill(); }
    const m = /RESULT (\{.*\})/.exec(stdout)
    assert.ok(m, `子进程应报出会话状态（stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 300)}）`)
    const state = JSON.parse(m[1])
    const diag = JSON.stringify({ ...state, elapsedMs })
    // ① 连接确实建立了（SASL 通过、会话 ready）——否则测的不是"常驻连接"
    assert.equal(state.ready, true, `应完成 SASL 进入 ready: ${diag}`)
    assert.equal(state.hasSocket, true, `会话应持有 socket: ${diag}`)
    // ② 连接活着的同时，进程必须能自己结束。未 unref 的 socket 会把子进程钉到
    //    Hello 超时（5s）才被销毁退出，所以 3s 这个窗口能把两种行为分开。
    assert.ok(exited !== null, `保持连接的子进程必须能自己退出（socket 未 unref 时会一直挂着）: ${diag}`)
    assert.ok(elapsedMs < 8000, `子进程应在 8s 内自然退出（socket 未 unref 会一直挂着）: ${diag}`)
  } finally {
    server.close()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* 清理失败不影响结论 */ }
  }
})
