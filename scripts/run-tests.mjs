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

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
if (result.error) {
  console.error('[dsh-desktop-notify] 无法启动 node --test:', result.error.message)
  process.exit(1)
}
process.exit(result.status === null ? 1 : result.status)
