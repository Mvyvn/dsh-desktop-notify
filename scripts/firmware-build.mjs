// 固件侧构建与自测入口
//
//   node scripts/firmware-build.mjs            自动找编译器并跑两个自测
//   node scripts/firmware-build.mjs --check     只做 vectors.h 漂移检查（不需要编译器）
//
// 为什么要这么一层：
//   · core/ 是纯 C，能在 PC 上编译 —— 协议解析、状态映射、亮度/合成这些**真正容易错**
//     的地方因此可以逐条断言，而不是等板子打出来才发现；
//   · .ino 本来最容易"写完没人验证"：这里用 firmware/host/stub/ 的 Arduino 桩把它
//     真的跑起来（喂真实帧、推进假时钟、检查像素）；
//   · vectors.h 由主机侧编码器生成，这里做一次漂移检查：改了协议却忘了重新生成，
//     或者两端编码漂移，都会在这里红。
//
// 找不到任何 C/C++ 编译器时**明确跳过**并把原因打出来（不伪装成通过）。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderVectorsHeader } from './gen-led-vectors.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostDir = join(root, 'firmware', 'host')
const coreDir = join(root, 'firmware', 'core')

/** vectors.h 是否与主机侧编码器一致（不需要编译器）。 */
export function checkVectorDrift() {
  const target = join(hostDir, 'vectors.h')
  if (!existsSync(target)) return { ok: false, reason: 'firmware/host/vectors.h 不存在，请先运行 node scripts/gen-led-vectors.mjs' }
  const actual = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  const expected = renderVectorsHeader().replace(/\r\n/g, '\n')
  if (actual !== expected) return { ok: false, reason: 'vectors.h 与 src/led-protocol.ts 的编码结果不一致，请运行 node scripts/gen-led-vectors.mjs' }
  return { ok: true, reason: '' }
}

/** 找一个可用的 C 编译器。 */
export function findCompiler() {
  const probe = (cmd, args) => {
    try {
      const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, shell: false })
      return res.status === 0
    } catch (e) { return false }
  }
  if (probe('gcc', ['--version'])) return { kind: 'gcc', cc: 'gcc', cxx: 'g++' }
  if (probe('cc', ['--version'])) return { kind: 'gcc', cc: 'cc', cxx: 'c++' }
  if (probe('clang', ['--version'])) return { kind: 'clang', cc: 'clang', cxx: 'clang++' }
  if (process.platform === 'win32') {
    const vcvars = findVcvars()
    if (vcvars) return { kind: 'msvc', vcvars }
  }
  return null
}

/** 定位 vcvars64.bat（先问 vswhere，再扫常见安装目录）。 */
function findVcvars() {
  const candidates = []
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (existsSync(vswhere)) {
    const res = spawnSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8', timeout: 20000 })
    const install = (res.stdout || '').trim().split(/\r?\n/)[0]
    if (install) candidates.push(join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))
  }
  for (const drive of ['C:', 'D:', 'E:']) {
    for (const edition of ['Community', 'Professional', 'Enterprise', 'BuildTools']) {
      candidates.push(join(`${drive}\\`, 'Program Files', 'Microsoft Visual Studio', '2022', edition, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))
      candidates.push(join(`${drive}\\`, 'VisualStudio', edition, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))
    }
  }
  for (const path of candidates) if (path && existsSync(path)) return path
  return null
}

/** 跑一条命令并实时转发输出。 */
function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', timeout: 180000, ...options })
  return res.status === 0
}

/**
 * 在 Windows 上跑一串 MSVC 命令。
 * ⚠️ 不走 `spawnSync('cmd', ['/c', line])`：cmd.exe 对 `/c "…"` 里的引号有自己的
 * 解析规则（外层引号会被吃掉、内层 `&&` 与引号组合会散架），实测会静默失败。
 * 写一个临时 .bat 再执行，绕开全部引号地狱。
 */
function runBat(lines) {
  const bat = join(hostDir, '.tmp-firmware-build.bat')
  writeFileSync(bat, ['@echo off', ...lines].join('\r\n') + '\r\n', 'utf8')
  try {
    return run('cmd', ['/c', bat])
  } finally {
    try { rmSync(bat, { force: true }) } catch (e) { /* ignore */ }
  }
}

/** 编译并运行 C 版自测（sim_main.c）。 */
function buildSim(compiler) {
  if (compiler.kind === 'msvc') {
    const out = join(hostDir, 'sim.exe')
    const ok = runBat([
      `call "${compiler.vcvars}" >nul 2>&1`,
      `cd /d "${hostDir}"`,
      `cl /nologo /utf-8 /std:c11 /W4 /Fe:"${out}" sim_main.c "${join(coreDir, 'led_protocol.c')}" "${join(coreDir, 'led_engine.c')}"`,
    ])
    if (!ok) return { ok: false, reason: 'MSVC 编译失败' }
    return { ok: run(out, ['--selftest']), reason: 'sim.exe --selftest', bin: out }
  }
  const out = join(hostDir, 'sim')
  const args = ['-std=c99', '-Wall', '-Wextra', '-O1', '-I', coreDir, '-o', out,
    join(hostDir, 'sim_main.c'), join(coreDir, 'led_protocol.c'), join(coreDir, 'led_engine.c')]
  if (!run(compiler.cc, args)) return { ok: false, reason: 'gcc/clang 编译失败' }
  return { ok: run(out, ['--selftest']), reason: 'sim --selftest', bin: out }
}

/** 编译并运行草图冒烟测试（sketch_check.cpp，用 Arduino 桩）。 */
function buildSketchCheck(compiler) {
  const stubDir = join(hostDir, 'stub')
  if (compiler.kind === 'msvc') {
    const out = join(hostDir, 'sketch_check.exe')
    const ok = runBat([
      `call "${compiler.vcvars}" >nul 2>&1`,
      `cd /d "${hostDir}"`,
      `cl /nologo /utf-8 /std:c++17 /EHsc /W4 /I "${stubDir}" /I "${coreDir}" /Fe:"${out}" sketch_check.cpp "${join(coreDir, 'led_protocol.c')}" "${join(coreDir, 'led_engine.c')}"`,
    ])
    if (!ok) return { ok: false, reason: 'MSVC 编译草图失败' }
    return { ok: run(out, []), reason: 'sketch_check.exe', bin: out }
  }
  // gcc/clang：C 文件用 C 编译器编成目标文件，再和 C++ 草图和主程序链接
  const objProtocol = join(hostDir, 'led_protocol.o')
  const objEngine = join(hostDir, 'led_engine.o')
  const out = join(hostDir, 'sketch_check')
  if (!run(compiler.cc, ['-std=c99', '-O1', '-I', coreDir, '-c', join(coreDir, 'led_protocol.c'), '-o', objProtocol])) {
    return { ok: false, reason: '编译 led_protocol.c 失败' }
  }
  if (!run(compiler.cc, ['-std=c99', '-O1', '-I', coreDir, '-c', join(coreDir, 'led_engine.c'), '-o', objEngine])) {
    return { ok: false, reason: '编译 led_engine.c 失败' }
  }
  const args = ['-std=c++17', '-Wall', '-O1', '-I', stubDir, '-I', coreDir, '-o', out,
    join(hostDir, 'sketch_check.cpp'), objProtocol, objEngine]
  if (!run(compiler.cxx, args)) return { ok: false, reason: 'g++/clang++ 编译草图失败' }
  return { ok: run(out, []), reason: 'sketch_check', bin: out }
}

const isMain = process.argv[1] && process.argv[1].endsWith('firmware-build.mjs')
if (isMain) {
  const drift = checkVectorDrift()
  if (!drift.ok) {
    console.error(`[led] 测试向量漂移：${drift.reason}`)
    process.exit(1)
  }
  console.log('[led] vectors.h 与主机编码器一致')
  if (process.argv.includes('--check')) process.exit(0)

  const compiler = findCompiler()
  if (compiler === null) {
    console.log('[led] 未找到 C/C++ 编译器（gcc/clang/MSVC），跳过固件编译自测')
    console.log('[led] 提示：Windows 上装 Visual Studio（含 C++ 工具链）或用 winget 装 LLVM/ MinGW 即可自动启用')
    process.exit(0)
  }
  console.log(`[led] 使用编译器：${compiler.kind}${compiler.vcvars ? ` (${compiler.vcvars})` : ''}`)

  const sim = buildSim(compiler)
  const sketch = buildSketchCheck(compiler)
  if (!sim.ok) {
    console.error(`[led] 固件核心自测失败：${sim.reason}`)
    process.exit(1)
  }
  if (!sketch.ok) {
    console.error(`[led] 草图冒烟测试失败：${sketch.reason}`)
    process.exit(1)
  }
  console.log('[led] 固件自测全部通过')
}
