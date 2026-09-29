// Toast XML 组装单测（node:test，无第三方依赖）
//   npm test
//
// 锁住两件容易静默出错的事：
//   · 转义（标题/正文带 & < > " ' 时不能把 XML 拼坏——拼坏了 WinRT 只回一个 HRESULT）
//   · 点击语义只由 launch 决定：非空才写 activationType/launch（protocol 激活），
//     空就是普通 Toast（点击只消失，**不跳转**——配置里没留点击目标）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToastXml, escapeXml } from '../lib/toast-xml.js'

test('普通 Toast：不写 activationType/launch（点击不跳转）', () => {
  const xml = buildToastXml({ title: '标题', message: '正文' })
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?><toast>'))
  assert.ok(!xml.includes('activationType'))
  assert.ok(!xml.includes('launch='))
  assert.ok(xml.includes('<text>标题</text><text>正文</text>'))
})

test('带 launch：协议激活，地址已转义', () => {
  const xml = buildToastXml({
    title: 't', message: 'm',
    launch: 'dsh-notify:session:s1',
  })
  assert.ok(xml.includes('activationType="protocol"'))
  assert.ok(xml.includes('launch="dsh-notify:session:s1"'))
})

test('带图标：appLogoOverride 指向 file:/// 地址', () => {
  const xml = buildToastXml({ title: 't', message: 'm', iconUri: 'file:///D:/a/dsh-dark.png' })
  assert.ok(xml.includes('<image placement="appLogoOverride" src="file:///D:/a/dsh-dark.png"/>'))
})

test('转义：标题/正文/地址里的特殊字符不会破坏 XML', () => {
  const xml = buildToastXml({
    title: 'a & b <c> "d" \'e\'',
    message: '<script>',
    launch: 'http://x/?a=1&b=2',
  })
  assert.ok(xml.includes('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'))
  assert.ok(xml.includes('&lt;script&gt;'))
  assert.ok(xml.includes('launch="http://x/?a=1&amp;b=2"'))
  assert.ok(!xml.includes('<script>'))
})

test('转义表覆盖五个必须转的字符', () => {
  assert.equal(escapeXml('&'), '&amp;')
  assert.equal(escapeXml('<'), '&lt;')
  assert.equal(escapeXml('>'), '&gt;')
  assert.equal(escapeXml('"'), '&quot;')
  assert.equal(escapeXml("'"), '&apos;')
})

test('空/缺省字段不产生空属性（不写空 launch、不写空 image）', () => {
  const xml = buildToastXml({ title: '', message: '', iconUri: '', launch: '' })
  assert.ok(!xml.includes('launch='))
  assert.ok(!xml.includes('<image'))
  assert.ok(xml.includes('<text></text><text></text>'))
})
