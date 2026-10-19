#!/usr/bin/env node
// 构建/测试互斥（开发工具，不进 npm 包）——多个并发会话（人或 Agent）同时跑 `npm test`
// 会各自执行 pretest 的 `tsc`，一起写 lib/：一边在被读取、一边在被重写，
// 失败会变得不可复现（而且会浪费大量时间互相怀疑）。
//
// 用法：node scripts/locked.mjs <命令> [参数...]
//   node scripts/locked.mjs npm test
//   node scripts/locked.mjs npm run check
//
// 锁 = 目录 `.tmp-build-lock`（已命中 .gitignore 的 `.tmp-*` 规则）。
// 超过 STALE_MS 的锁视为残留（上次进程被杀），自动清掉。
// 拿不到锁就排队等（最多 WAIT_MS），等不到直接失败并打印持锁者信息。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lockDir = join(root, '.tmp-build-lock')
const ownerFile = join(lockDir, 'owner')
const WAIT_MS = 15 * 60 * 1000
const STALE_MS = 20 * 60 * 1000

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function release() {
  try { rmSync(lockDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
}

function stale() {
  try {
    const at = Number(readFileSync(ownerFile, 'utf8').split(' ')[0])
    return !Number.isFinite(at) || Date.now() - at > STALE_MS
  } catch (e) {
    return true
  }
}

let owned = false
const startedAt = Date.now()
while (!owned) {
  try {
    mkdirSync(lockDir)
    writeFileSync(ownerFile, `${Date.now()} ${process.pid} ${process.argv.slice(2).join(' ')}`)
    owned = true
  } catch (e) {
    if (stale()) { release(); continue }
    if (Date.now() - startedAt > WAIT_MS) {
      let holder = '?'
      try { holder = readFileSync(ownerFile, 'utf8') } catch (e2) { /* ignore */ }
      console.error(`[locked] 等待构建锁超时；持锁者：${holder}`)
      process.exit(1)
    }
    sleep(250)
  }
}

let code = 1
try {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd) {
    console.error('[locked] 用法：node scripts/locked.mjs <命令> [参数...]')
    process.exit(2)
  }
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) console.error(`[locked] 启动失败：${result.error.message}`)
  code = result.status === null ? 1 : result.status
} finally {
  if (owned && existsSync(lockDir)) release()
}
process.exit(code)
