/**
 * 调试日志落文件（小型带轮转的写入器）。
 *
 * 为什么自己写：DSH **没有**给插件"写日志文件"的 API（`ctx.logger` 默认只 console +
 * 内存环形缓冲），官方做法是用 `ctx.logger.exporter()` 自己接管输出。这里就是那个接管端：
 *   目录  $DSH_HOME/logs/dsh-desktop-notify/（DSH 自己的启动诊断日志也在 $DSH_HOME/logs/ 下）
 *   文件  dsh-desktop-notify.log，超过 maxBytes 轮转成 .1/.2…，最多保留 keep 份
 *   （全仓唯一的既有轮转先例是 desktop 崩溃报告：保留最近 10 份）
 *
 * 一切失败都吞掉：日志写不出去**绝不能**影响通知本身。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface FileSinkOptions {
  readonly dir: string
  readonly name: string
  readonly maxBytes?: number
  readonly keep?: number
}

/** DSH 的 home：优先 $DSH_HOME，退回 ~/.dsh（与 DSH 自己的 logs 目录同一层）。 */
export function dshHome(): string {
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return env || join(homedir(), '.dsh')
}

/** 日志目录（$DSH_HOME/logs/<插件名>）。 */
export function logDirFor(pluginName: string): string {
  return join(dshHome(), 'logs', pluginName)
}

export function createFileSink(options: FileSinkOptions): (line: string) => void {
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const keep = Math.max(1, options.keep ?? 5)
  const at = (n: number): string => join(options.dir, n === 0 ? options.name : `${options.name}.${n}`)
  let ready = false

  const ensureDir = (): void => {
    if (ready) return
    mkdirSync(options.dir, { recursive: true })
    ready = true
  }
  const rotate = (): void => {
    // 先把最旧的一份删掉：否则 at(keep-1) 会被改名成 at(keep)，磁盘上多留一份
    try { rmSync(at(keep), { force: true }) } catch (e) { /* ignore */ }
    for (let i = keep - 1; i >= 1; i -= 1) {
      try { if (existsSync(at(i))) renameSync(at(i), at(i + 1)) } catch (e) { /* ignore */ }
    }
    try { if (existsSync(at(0))) renameSync(at(0), at(1)) } catch (e) { /* ignore */ }
  }

  return (line: string): void => {
    try {
      ensureDir()
      try { if (statSync(at(0)).size > maxBytes) rotate() } catch (e) { /* 首次写时文件还不存在 */ }
      appendFileSync(at(0), line + '\n')
    } catch (e) { /* 日志失败不影响通知 */ }
  }
}
