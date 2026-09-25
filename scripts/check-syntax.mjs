// dsh-desktop-notify — 语法自检：把 lib/ 下每个模块都过一遍 `node --check`。
//
// 为什么不写成 package.json 里一长串 `node --check a && node --check b ...`：
// 那样每加一个模块都要记得补一条，漏了就没人检查（而且顺序固定、失败点难读）。
// 这里自动枚举 lib/*.js，新增文件自动纳入。
//
// 用法：npm run check
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const files = readdirSync(libDir).filter((name) => name.endsWith('.js')).sort()

if (files.length === 0) {
  console.error('[dsh-desktop-notify] lib/ 下没有 .js 模块')
  process.exit(1)
}

let failed = 0
for (const name of files) {
  const file = join(libDir, name)
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.error) {
    console.error(`[dsh-desktop-notify] 无法启动 node --check: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) failed += 1
}

if (failed > 0) {
  console.error(`[dsh-desktop-notify] ${failed}/${files.length} 个模块语法检查失败`)
  process.exit(1)
}
console.log(`[dsh-desktop-notify] 语法检查通过（${files.length} 个模块）`)
