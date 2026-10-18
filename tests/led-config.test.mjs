// LED 配置归一测试
//
// 设置页是"用户能填任意字符串"的地方：端口打错、亮度填 999、波特率填 0 都不该让
// 灯带功能整体挂掉，而应该**回落到默认值**并在诊断里看得出来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLedConfig, DEFAULT_LED_CONFIG, LED_BAUD_RATES, Config } from '../lib/config.js'

test('缺省：全部回落到默认（LED 默认关闭）', () => {
  const cfg = resolveLedConfig(undefined)
  assert.deepEqual(cfg, DEFAULT_LED_CONFIG)
  assert.equal(cfg.enabled, false, '默认必须关闭：多数人机器上并没有这块板子')
})

test('正常取值原样通过', () => {
  const cfg = resolveLedConfig({
    ledEnabled: true, ledPort: 'COM7', ledBaud: 115200, ledBrightness: 120, ledAttention: true, ledIdleOffSec: 30,
  })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.port, 'COM7')
  assert.equal(cfg.baud, 115200)
  assert.equal(cfg.brightness, 120)
  assert.equal(cfg.attention, true)
  assert.equal(cfg.idleOffMs, 30000)
})

test('亮度夹到 0..254：255 是"设备默认"的哨兵，不能让用户配置落进哨兵', () => {
  assert.equal(resolveLedConfig({ ledBrightness: 255 }).brightness, 254)
  assert.equal(resolveLedConfig({ ledBrightness: 999 }).brightness, 254)
  assert.equal(resolveLedConfig({ ledBrightness: -3 }).brightness, 0)
  assert.equal(resolveLedConfig({ ledBrightness: 'x' }).brightness, DEFAULT_LED_CONFIG.brightness)
})

test('波特率只接受白名单（写错的表现是"灯乱闪"而不是报错，必须在配置层挡住）', () => {
  for (const baud of LED_BAUD_RATES) assert.equal(resolveLedConfig({ ledBaud: baud }).baud, baud)
  assert.equal(resolveLedConfig({ ledBaud: 12345 }).baud, DEFAULT_LED_CONFIG.baud)
  assert.equal(resolveLedConfig({ ledBaud: 0 }).baud, DEFAULT_LED_CONFIG.baud)
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
})

test('schemastery 模式里有这些字段（设置页据此渲染）', () => {
  // 不强依赖 schemastery 的内部结构：能取到 dict 就断言，取不到就跳过
  // （Config 模式本身在 host.test.mjs 的设置页用例里已覆盖）
  const shape = Config && Config.dict ? Config.dict : null
  if (!shape) return
  for (const key of ['ledEnabled', 'ledPort', 'ledBaud', 'ledBrightness', 'ledAttention', 'ledIdleOffSec']) {
    assert.ok(key in shape, `配置模式缺少 ${key}`)
  }
})
