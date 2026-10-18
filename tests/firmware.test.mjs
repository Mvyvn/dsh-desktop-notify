// 固件与线协议的联动测试
//
// 三层守护：
//   1. **向量漂移**：firmware/host/vectors.h 必须与 src/led-protocol.ts 的编码结果逐字节一致
//      （改了协议忘了重新生成 → 这里红）；
//   2. **固件核心自测**：firmware/core 的纯 C 引擎在 PC 上编译并跑断言
//      （协议解析、状态映射、亮度/伽马、覆盖层 TTL、失联兜底、ASCII 兜底）；
//   3. **草图冒烟**：Arduino 草图在桩上真的跑 setup()/loop()，喂真实帧后检查像素。
// 没有 C/C++ 编译器时第 2、3 步显式跳过（不伪装成通过），第 1 步一定会跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkVectorDrift, findCompiler } from '../scripts/firmware-build.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('firmware/host/vectors.h 与主机侧编码器一致（协议漂移守护）', () => {
  const drift = checkVectorDrift()
  assert.equal(drift.ok, true, drift.reason)
})

test('固件核心自测 + 草图冒烟（需要本机有 C/C++ 编译器，否则跳过）', (t) => {
  const compiler = findCompiler()
  if (compiler === null) {
    t.skip('本机没有 gcc/clang/MSVC，跳过固件编译自测（node scripts/firmware-build.mjs 可手动跑）')
    return
  }
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'firmware-build.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240000,
  })
  const output = `${res.stdout || ''}${res.stderr || ''}`
  assert.equal(res.status, 0, `固件自测失败：\n${output}`)
  assert.match(output, /固件自测全部通过/)
  assert.match(output, /项检查，0 项失败/)
})
