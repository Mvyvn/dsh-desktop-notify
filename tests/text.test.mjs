// 文本工具单测（node:test，无第三方依赖）
//   npm test
//
// 锁住的核心语义：截断绝不产生孤立代理（孤立高代理编码成 UTF-8 会变成 U+FFFD，
// 真实出现在发给系统通知的载荷里）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncateText } from '../lib/text.js'
import { normalizeNotifyItem } from '../lib/api.js'

const isLoneHighSurrogate = (unit) => unit >= 0xd800 && unit <= 0xdbff
const hasReplacementChar = (s) => s.includes('\uFFFD')

test('未超长时原样返回', () => {
  assert.equal(truncateText('abc', 5), 'abc')
  assert.equal(truncateText('abc', 3), 'abc')
})

test('普通字符按码元截断', () => {
  assert.equal(truncateText('abcdef', 4), 'abcd')
})

test('截断点落在代理对中间时退一格，不产生孤立高代理', () => {
  const text = 'a'.repeat(3) + '\u{1F642}' + 'b'   // 代理对占第 4、5 位
  const cut = truncateText(text, 4)
  assert.equal(cut, 'aaa')
  assert.ok(!isLoneHighSurrogate(cut.charCodeAt(cut.length - 1)))
})

test('代理对完整落在边界内时照常保留', () => {
  const text = 'a'.repeat(3) + '\u{1F642}' + 'b'
  assert.equal(truncateText(text, 5), 'aaa\u{1F642}')
})

test('空值与非字符串归一', () => {
  assert.equal(truncateText(undefined, 10), '')
  assert.equal(truncateText(null, 10), '')
  assert.equal(truncateText(12345, 3), '123')
  assert.equal(truncateText('abc', 0), '')
})

test('长文本编码后不出现替换字符', () => {
  const text = 'a'.repeat(399) + '\u{1F642}' + 'b'
  const cut = truncateText(text, 400)
  assert.equal(cut.length, 399)
  assert.ok(!hasReplacementChar(Buffer.from(cut, 'utf8').toString('utf8')))
})

test('对外 API 的标题与正文截断同样不切断代理对', () => {
  const title = normalizeNotifyItem({ title: 'a'.repeat(159) + '\u{1F642}' + 'b' })
  assert.equal(title.title.length, 159)
  assert.ok(!isLoneHighSurrogate(title.title.charCodeAt(title.title.length - 1)))

  const message = normalizeNotifyItem({ title: 't', message: 'a'.repeat(399) + '\u{1F642}' + 'b' })
  assert.equal(message.message.length, 399)
  assert.ok(!isLoneHighSurrogate(message.message.charCodeAt(message.message.length - 1)))
})
