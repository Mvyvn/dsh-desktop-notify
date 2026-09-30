// 点击协议单测（src/protocol.ts → lib/protocol.js）
//   npm test（会先跑 npm run build）
//
// 这一层是"点击要做什么"的唯一真源：四态显式建模 + 线格式严格解码。
// 重点锁住**不猜测**：认不出的目标一律 null，绝不"尽力而为"地跳到别的东西上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clickNone, clickSession, clickPage, clickUrl,
  encodeClickTarget, decodeClickTarget, activateQuery, needsDshPage,
} from '../lib/protocol.js'

test('编码：四态各有确定线格式', () => {
  assert.equal(encodeClickTarget(clickNone()), 'none')
  assert.equal(encodeClickTarget(clickSession('s1')), 'session:s1')
  assert.equal(encodeClickTarget(clickPage('settings-plugins')), 'page:settings-plugins')
  assert.equal(encodeClickTarget(clickPage('plugins')), 'page:plugins')
  assert.equal(encodeClickTarget(clickUrl('https://example.com/a b')), 'url:https%3A%2F%2Fexample.com%2Fa%20b')
})

test('解码：往返一致', () => {
  for (const target of [clickNone(), clickSession('s-1'), clickPage('plugins'), clickUrl('http://127.0.0.1:3080/x?a=1&b=2')]) {
    assert.deepEqual(decodeClickTarget(encodeClickTarget(target)), target)
  }
})

test('解码：严格白名单，认不出就是 null', () => {
  assert.deepEqual(decodeClickTarget(''), { type: 'none' }, '空串按 none（历史链接没带目标）')
  assert.deepEqual(decodeClickTarget('none'), { type: 'none' })
  assert.equal(decodeClickTarget('javascript:alert(1)'), null)
  assert.equal(decodeClickTarget('session:'), null)
  assert.equal(decodeClickTarget('session:' + 'x'.repeat(300)), null)
  assert.equal(decodeClickTarget('page:not-a-page'), null)
  assert.equal(decodeClickTarget('url:file%3A%2F%2FC%3A%2Fx'), null, 'url 目标只允许 http(s)')
  assert.equal(decodeClickTarget('url:%E0%A4%A'), null, '坏编码不该抛异常')
  assert.equal(decodeClickTarget('dsh-notify:session:s1'), null, '带 scheme 的完整 URI 不由这一层处理')
})

test('clickUrl：空壳 URL 必须挡掉（协议前缀正则不够）', () => {
  // 这些都能过 /^https?:\/\//，但系统打开必然失败 → 不该成为可点击目标
  assert.equal(clickUrl('http://'), null)
  assert.equal(clickUrl('https://'), null)
  assert.equal(clickUrl('https://not a valid url'), null)
  assert.equal(clickUrl('https://[invalid'), null)
  assert.equal(clickUrl('file:///C:/x'), null)
  assert.equal(clickUrl('javascript:alert(1)'), null)
  // 正常地址仍然通过，且**保持原串**（规范化会补尾斜杠，改变既有线格式）
  assert.deepEqual(clickUrl('https://example.com'), { type: 'url', url: 'https://example.com' })
  assert.deepEqual(clickUrl('  http://127.0.0.1:3080/x?y=1  '), { type: 'url', url: 'http://127.0.0.1:3080/x?y=1' })
})

test('clickUrl：只接受 http(s) 且长度合理', () => {
  assert.deepEqual(clickUrl('  https://example.com  '), { type: 'url', url: 'https://example.com' })
  assert.equal(clickUrl('ftp://example.com'), null)
  assert.equal(clickUrl(''), null)
  assert.equal(clickUrl('https://example.com/' + 'a'.repeat(2100)), null)
})

test('needsDshPage：只有 session/page 需要 DSH 页面', () => {
  assert.equal(needsDshPage(clickSession('s1')), true)
  assert.equal(needsDshPage(clickPage('plugins')), true)
  assert.equal(needsDshPage(clickNone()), false)
  assert.equal(needsDshPage(clickUrl('https://example.com')), false)
})

test('activateQuery：给激活端点用的 query 片段已编码', () => {
  assert.equal(activateQuery(clickSession('s1')), 'raw=session%3As1')
  assert.equal(activateQuery(clickUrl('https://example.com/a b')), 'raw=url%3Ahttps%253A%252F%252Fexample.com%252Fa%2520b')
})
