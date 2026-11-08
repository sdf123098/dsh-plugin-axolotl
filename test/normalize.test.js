/** 结果归一化的单元测试。全是纯函数。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  businessErrorOf,
  errorText,
  firstLine,
  imagesOf,
  normalizeResult,
  structuredOf,
  textOf,
} from '../src/normalize.js'

test('normalizeResult 把数组 structuredContent 包成 items', () => {
  const result = { content: [], structuredContent: [{ id: 1 }, { id: 2 }] }
  assert.deepEqual(normalizeResult(result).structuredContent, { items: [{ id: 1 }, { id: 2 }] })
})

test('normalizeResult 把标量包成 value', () => {
  assert.deepEqual(normalizeResult({ structuredContent: 42 }).structuredContent, { value: 42 })
  assert.deepEqual(normalizeResult({ structuredContent: 'text' }).structuredContent, { value: 'text' })
})

test('normalizeResult 不动已经合法的对象', () => {
  const result = { structuredContent: { ok: true } }
  assert.equal(normalizeResult(result).structuredContent.ok, true)
  assert.deepEqual(normalizeResult(result).structuredContent, { ok: true })
})

test('normalizeResult 对 null / 非对象原样返回', () => {
  assert.equal(normalizeResult(null), null)
  assert.equal(normalizeResult('x'), 'x')
  assert.equal(normalizeResult(undefined), undefined)
})

test('businessErrorOf 认得对象形式的错误', () => {
  const error = businessErrorOf({
    structuredContent: { error: { code: 'not_found', message: 'World not found' } },
  })
  assert.equal(error.isError, true)
  assert.equal(error.code, 'not_found')
  assert.equal(error.message, 'World not found')
})

test('businessErrorOf 认得字符串形式的错误', () => {
  const error = businessErrorOf({ structuredContent: { error: 'boom' } })
  assert.equal(error.isError, true)
  assert.equal(error.message, 'boom')
})

test('businessErrorOf 对正常结果返回 isError: false', () => {
  assert.equal(businessErrorOf({ structuredContent: { items: [] } }).isError, false)
  assert.equal(businessErrorOf({ structuredContent: { error: null } }).isError, false)
  assert.equal(businessErrorOf(null).isError, false)
})

test('errorText 去掉重复的 MCP error 前缀', () => {
  assert.equal(errorText(new Error('MCP error -32602: Missing argument: "update_id"')), 'Missing argument: "update_id"')
  assert.equal(errorText(new Error('MCP error -32602: MCP error -32602: boom')), 'boom')
  assert.equal(errorText(new Error('plain')), 'plain')
  assert.equal(errorText('string error'), 'string error')
})

test('structuredOf 优先用 structuredContent', () => {
  assert.deepEqual(structuredOf({ structuredContent: { a: 1 }, content: [] }), { a: 1 })
})

test('structuredOf 在没有 structuredContent 时解析 text 块', () => {
  const result = { content: [{ type: 'text', text: '{"items":[]}' }] }
  assert.deepEqual(structuredOf(result), { items: [] })
})

test('structuredOf 对不是 JSON 的 text 原样返回', () => {
  const result = { content: [{ type: 'text', text: 'not json' }] }
  assert.equal(structuredOf(result), 'not json')
})

test('textOf 拼接所有 text 块', () => {
  const result = {
    content: [
      { type: 'text', text: 'line1' },
      { type: 'image', data: 'xx' },
      { type: 'text', text: 'line2' },
    ],
  }
  assert.equal(textOf(result), 'line1\nline2')
})

test('imagesOf 只取带 data 的 image 块', () => {
  const result = {
    content: [
      { type: 'text', text: 'x' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'image', data: 'BBBB' },
      { type: 'image' },
    ],
  }
  const images = imagesOf(result)
  assert.equal(images.length, 2)
  assert.equal(images[0].mimeType, 'image/png')
  assert.equal(images[1].mimeType, 'image/png', '缺 mimeType 时默认 png')
})

test('firstLine 压平并截断', () => {
  assert.equal(firstLine('a\n\n  b   c'), 'a b c')
  assert.equal(firstLine('x'.repeat(200)).endsWith('…'), true)
})
