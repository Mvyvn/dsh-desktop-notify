// 生成 firmware/host/vectors.h —— 主机侧编码器产出测试向量，固件侧反向解码核对
//
//   真源：src/led-protocol.ts（主机编码）
//   用途：firmware/host/sim_main.c --selftest 会逐字段解码这些字节并断言
//   守护：tests/firmware.test.mjs 会重新生成一遍并与仓库里的文件比对（防止漂移）
//
// 手改这个生成物没有意义：改了下次被测出来，而且固件那边也会跟着错。
//   node scripts/gen-led-vectors.mjs           写入文件
//   node scripts/gen-led-vectors.mjs --print   只打印（测试比对用）
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  encodeFrame, scenePayload, effectPayload, overlayPayload, configPayload,
  FRAME, LED_STATE_CODE, LED_EFFECT_CODE, SCENE_FLAG, PROGRESS_NONE, BRIGHTNESS_DEFAULT,
  rgbToRgb332, crc8, LED_WIRE_VERSION,
} from '../lib/led-protocol.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 测试向量：每一组都要能被固件解析器逐字段复现。 */
export function vectorSet() {
  return [
    { name: 'hello', type: FRAME.HELLO, seq: 1, payload: [LED_WIRE_VERSION, 0] },
    { name: 'scene-running', type: FRAME.SCENE, seq: 2, payload: scenePayload({ state: 'running', brightness: 160 }) },
    { name: 'scene-done-attention', type: FRAME.SCENE, seq: 3, payload: scenePayload({ state: 'done', flags: SCENE_FLAG.ATTENTION, brightness: 208 }) },
    { name: 'scene-waiting-muted', type: FRAME.SCENE, seq: 4, payload: scenePayload({ state: 'waiting', flags: SCENE_FLAG.MUTED, brightness: 104 }) },
    { name: 'scene-error', type: FRAME.SCENE, seq: 5, payload: scenePayload({ state: 'error', brightness: 254, progress: PROGRESS_NONE, accent: 0xff }) },
    {
      name: 'effect-flow-both', type: FRAME.EFFECT, seq: 6,
      payload: effectPayload({ effect: 'flow-both', speed: 9, brightness: 128, color: { r: 255, g: 255, b: 255 }, param: 3 }),
    },
    {
      name: 'overlay-double-flash', type: FRAME.OVERLAY, seq: 7,
      payload: overlayPayload({ effect: 'double-flash', speed: 12, brightness: 255, color: { r: 255, g: 0, b: 0 }, ttlMs: 1500, repeat: 3 }),
    },
    { name: 'progress-42', type: FRAME.PROGRESS, seq: 8, payload: [42, rgbToRgb332(0, 200, 255), BRIGHTNESS_DEFAULT] },
    { name: 'config-link-timeout', type: FRAME.CONFIG, seq: 9, payload: configPayload(4, 15000) },
    { name: 'ping', type: FRAME.PING, seq: 10, payload: [] },
  ].map((vector) => ({ ...vector, bytes: [...encodeFrame(vector.type, vector.seq, vector.payload)] }))
}

function cArray(name, bytes) {
  const body = bytes.map((b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(', ')
  return `static const uint8_t ${name}[] = { ${body} };`
}

/** 渲染 vectors.h 的完整文本（测试与 CLI 共用同一份）。 */
export function renderVectorsHeader() {
  const vectors = vectorSet()
  const lines = []
  lines.push('/*')
  lines.push(' * vectors.h — 主机侧编码器产出的测试向量（自动生成，请勿手改）')
  lines.push(' *')
  lines.push(' *   生成：node scripts/gen-led-vectors.mjs')
  lines.push(' *   真源：src/led-protocol.ts')
  lines.push(' *   守护：tests/firmware.test.mjs 会重新生成并比对，改坏了两边都会红')
  lines.push(' *')
  lines.push(' * 固件侧（firmware/host/sim_main.c --selftest）逐字段解码这些字节，')
  lines.push(' * 两端编码/解码只要有一处漂移，测试立刻失败。')
  lines.push(' */')
  lines.push('#ifndef LED_VECTORS_H')
  lines.push('#define LED_VECTORS_H')
  lines.push('')
  lines.push('#include <stdint.h>')
  lines.push('')
  lines.push('typedef struct {')
  lines.push('  const char *name;')
  lines.push('  const uint8_t *bytes;')
  lines.push('  uint16_t len;')
  lines.push('  uint8_t type;')
  lines.push('  uint8_t seq;')
  lines.push('  uint8_t plen;')
  lines.push('  uint8_t payload[32];')
  lines.push('} led_vector_t;')
  lines.push('')
  vectors.forEach((vector, index) => {
    lines.push(`/* ${vector.name}: ${vector.bytes.length} 字节，CRC=0x${crc8(vector.bytes.slice(2, -1)).toString(16).toUpperCase()} */`)
    lines.push(cArray(`VEC_${index}`, vector.bytes))
  })
  lines.push('')
  lines.push('static const led_vector_t LED_VECTORS[] = {')
  vectors.forEach((vector, index) => {
    const payload = vector.payload.length === 0 ? '' : vector.payload.join(', ')
    lines.push(`  { "${vector.name}", VEC_${index}, ${vector.bytes.length}, 0x${vector.type.toString(16).padStart(2, '0').toUpperCase()}, ${vector.seq}, ${vector.payload.length}, { ${payload} } },`)
  })
  lines.push('};')
  lines.push('')
  lines.push('#define LED_VECTORS_COUNT (sizeof(LED_VECTORS) / sizeof(LED_VECTORS[0]))')
  lines.push('')
  lines.push('#endif /* LED_VECTORS_H */')
  lines.push('')
  return lines.join('\n')
}

const target = join(root, 'firmware', 'host', 'vectors.h')
const text = renderVectorsHeader()
// 只有**直接被当成脚本运行**时才写文件：被 tests / firmware-build.mjs import 时
// 只提供 renderVectorsHeader()（否则一 import 就偷偷改仓库文件，排查起来很费解）。
const isMain = process.argv[1] && process.argv[1].endsWith('gen-led-vectors.mjs')
if (!isMain) {
  // 被 import：什么都不做
} else if (process.argv.includes('--print')) {
  process.stdout.write(text)
} else {
  writeFileSync(target, text, 'utf8')
  console.log(`[led] 已写入 ${target}（${vectorSet().length} 个向量，${text.length} 字节）`)
  console.log(`[led] 状态码参考：running=${LED_STATE_CODE.running} done=${LED_STATE_CODE.done} waiting=${LED_STATE_CODE.waiting} error=${LED_STATE_CODE.error}`)
  console.log(`[led] 效果码参考：flow-both=${LED_EFFECT_CODE['flow-both']} breathe=${LED_EFFECT_CODE.breathe}`)
}
