// 跨 Node 版本的测试入口：不同版本对 `node --test` 的参数处理不一致——
//   Node 20：`node --test tests`（目录）可以，glob 会当成字面路径报 Could not find
//   Node 22+：只认文件或 glob，目录会当成模块报 Cannot find module
// 所以这里自己枚举 tests/*.test.mjs 再交给 node --test（显式文件列表两个版本线都认），
// `npm test` 因此在 Node 18+ 全都能跑，新增测试文件也不用改脚本。
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests')
const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(testsDir, name))

if (files.length === 0) {
  console.error('[dsh-desktop-notify] 没找到 tests/*.test.mjs')
  process.exit(1)
}

// `--test-reporter=spec` 让每个测试**边跑边打印**：真出现挂死时，日志最后一行就是卡住的那个
// （默认 reporter 只在全部结束时汇总，挂死时什么都看不到——CI 上曾为此白烧 6 小时）。
// `--test-force-exit`（Node 22+）：串口层会留下 worker / 原生句柄，
// 不加这个参数即使测试全绿进程也不退出（曾把 CI 挂死）。旧版本不支持就退回普通参数。
// 注意：不能用 allowedNodeEnvironmentFlags 判断（那是 NODE_OPTIONS 白名单，不含 CLI 开关），按主版本号判断。
const nodeMajor = Number(process.versions.node.split('.')[0]);
const forceExit = nodeMajor >= 22
const args = ['--test', '--test-reporter=spec', ...(forceExit ? ['--test-force-exit'] : []), ...files]
const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
if (result.error) {
  console.error('[dsh-desktop-notify] 无法启动 node --test:', result.error.message)
  process.exit(1)
}
process.exit(result.status === null ? 1 : result.status)
