// dsh-desktop-notify — 自检：lib/ 每个模块过 `node --check`，.ps1 脚本必须带 UTF-8 BOM。
//
// 为什么不写成 package.json 里一长串 `node --check a && node --check b ...`：
// 那样每加一个模块都要记得补一条，漏了就没人检查（而且顺序固定、失败点难读）。
// 这里自动枚举 lib/*.js，新增文件自动纳入。
//
// 为什么还要查 BOM：scripts/install.ps1 里全是中文提示，而 Windows PowerShell 5.1
// 读无 BOM 的 UTF-8 文件会按 ANSI 解码——中文变乱码后**字符串都会解析失败**，
// 安装脚本直接语法报错退出（实测踩过：文件头少了 EF BB BF）。
//
// 用法：npm run check
import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(root, 'lib')
const scriptsDir = join(root, 'scripts')

let failed = 0

// 1) lib/*.js 语法
const files = readdirSync(libDir).filter((name) => name.endsWith('.js')).sort()
if (files.length === 0) {
  console.error('[dsh-desktop-notify] lib/ 下没有 .js 模块')
  process.exit(1)
}
for (const name of files) {
  const file = join(libDir, name)
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.error) {
    console.error(`[dsh-desktop-notify] 无法启动 node --check: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) failed += 1
}

// 2) scripts/*.ps1 必须是 UTF-8 BOM（否则 PowerShell 5.1 下中文乱码 → 解析失败）
const ps1Files = readdirSync(scriptsDir).filter((name) => name.endsWith('.ps1')).sort()
for (const name of ps1Files) {
  const bytes = readFileSync(join(scriptsDir, name)).subarray(0, 3)
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  if (!hasBom) {
    console.error(`[dsh-desktop-notify] scripts/${name} 缺少 UTF-8 BOM：`
      + 'Windows PowerShell 5.1 会按 ANSI 解码中文，脚本会直接解析失败')
    failed += 1
  }
}

if (failed > 0) {
  console.error(`[dsh-desktop-notify] 自检失败（${failed} 项）`)
  process.exit(1)
}
console.log(`[dsh-desktop-notify] 自检通过（${files.length} 个模块，${ps1Files.length} 个 PowerShell 脚本带 BOM）`)
