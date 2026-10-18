// LED 配置归一测试
//
// 设置页是"用户能填任意字符串"的地方：端口打错、亮度填 999 都不该让灯带功能整体挂掉，
// 而应该**回落到默认值**并在诊断里看得出来。
//
// ⚠️ 波特率不再是配置项：真固件（AI_Status_Lights）把 115200 写死在 USART1 上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLedConfig, DEFAULT_LED_CONFIG, Config } from '../lib/config.js'

test('缺省：全部回落到默认（LED 默认关闭）', () => {
  const cfg = resolveLedConfig(undefined)
  assert.deepEqual(cfg, DEFAULT_LED_CONFIG)
  assert.equal(cfg.enabled, false, '默认必须关闭：多数人机器上并没有这块板子')
  assert.equal(cfg.buzzer, true, '蜂鸣器默认开（硬件支持）')
})

test('正常取值原样通过', () => {
  const cfg = resolveLedConfig({
    ledEnabled: true, ledPort: 'COM7', ledBrightness: 120, ledBuzzer: false, ledAttention: true, ledIdleOffSec: 30,
  })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.port, 'COM7')
  assert.equal(cfg.brightness, 120)
  assert.equal(cfg.buzzer, false)
  assert.equal(cfg.attention, true)
  assert.equal(cfg.idleOffMs, 30000)
})

test('亮度夹到 0..255（纯主机端：没有"设备默认"哨兵了）', () => {
  assert.equal(resolveLedConfig({ ledBrightness: 255 }).brightness, 255)
  assert.equal(resolveLedConfig({ ledBrightness: 999 }).brightness, 255)
  assert.equal(resolveLedConfig({ ledBrightness: -3 }).brightness, 0)
  assert.equal(resolveLedConfig({ ledBrightness: 'x' }).brightness, DEFAULT_LED_CONFIG.brightness)
})

test('端口：空串回落到 auto，非字符串不炸', () => {
  assert.equal(resolveLedConfig({ ledPort: '' }).port, 'auto')
  assert.equal(resolveLedConfig({ ledPort: '  ' }).port, 'auto')
  assert.equal(resolveLedConfig({ ledPort: 42 }).port, 'auto')
  assert.equal(resolveLedConfig({ ledPort: '/dev/ttyUSB0' }).port, '/dev/ttyUSB0')
})

test('熄灯延时：负数/非法回落到默认，0 保留（0 = 永不熄）', () => {
  assert.equal(resolveLedConfig({ ledIdleOffSec: 0 }).idleOffMs, 0)
  assert.equal(resolveLedConfig({ ledIdleOffSec: -5 }).idleOffMs, DEFAULT_LED_CONFIG.idleOffMs)
  assert.equal(resolveLedConfig({ ledIdleOffSec: 'x' }).idleOffMs, DEFAULT_LED_CONFIG.idleOffMs)
})

test('布尔字段只认真正的布尔值', () => {
  assert.equal(resolveLedConfig({ ledEnabled: 'yes' }).enabled, false)
  assert.equal(resolveLedConfig({ ledEnabled: true }).enabled, true)
  assert.equal(resolveLedConfig({ ledAttention: 0 }).attention, true, '非法值回落默认(true)')
  assert.equal(resolveLedConfig({ ledBuzzer: 0 }).buzzer, true, '非法值回落默认(true)')
  assert.equal(resolveLedConfig({ ledBuzzer: false }).buzzer, false)
})

test('schemastery 模式里有这些字段（设置页据此渲染），且不再有 ledBaud', () => {
  const shape = Config && Config.dict ? Config.dict : null
  if (!shape) return
  for (const key of ['ledEnabled', 'ledPort', 'ledBrightness', 'ledBuzzer', 'ledAttention', 'ledIdleOffSec']) {
    assert.ok(key in shape, `配置模式缺少 ${key}`)
  }
  assert.equal('ledBaud' in shape, false, '波特率由固件固定，不该再是配置项')
})
