/** 配置存储的单元测试。用临时目录，不碰真实配置。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

let home
let store

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'axolotl-store-'))
  process.env.DSH_HOME = home
  // store 模块在 import 时不会读盘，但缓存要清掉
  store = await import('../src/store.js')
  store.resetCache()
})

after(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

test('没有配置文件时返回空对象，不抛异常', () => {
  store.resetCache()
  assert.deepEqual(store.readOverrides(), {})
})

test('写入后能读回来，且落在 DSH_HOME 下', () => {
  store.resetCache()
  const result = store.writeOverrides({ upstreamUrl: 'http://127.0.0.1:6000/mcp' })
  assert.equal(result.ok, true)
  assert.equal(result.config.upstreamUrl, 'http://127.0.0.1:6000/mcp')

  const file = store.configPath()
  assert.ok(file.startsWith(home), `配置应当落在 DSH_HOME 下：${file}`)
  assert.equal(existsSync(file), true)

  store.resetCache()
  assert.equal(store.readOverrides().upstreamUrl, 'http://127.0.0.1:6000/mcp')
})

test('只接受可编辑字段，其它键被丢弃', () => {
  store.resetCache()
  store.writeOverrides({ upstreamUrl: 'http://a', 不该存在: 'x', sessionPolicy: 'manual' })
  store.resetCache()
  const overrides = store.readOverrides()
  assert.equal(overrides.sessionPolicy, 'manual')
  assert.ok(!('不该存在' in overrides))
})

test('值为 undefined 表示删除该覆盖项', () => {
  store.resetCache()
  store.writeOverrides({ upstreamUrl: 'http://b' })
  store.resetCache()
  store.writeOverrides({ upstreamUrl: undefined })
  store.resetCache()
  assert.ok(!('upstreamUrl' in store.readOverrides()))
})

test('令牌能存能读', () => {
  store.resetCache()
  store.writeOverrides({ authToken: 'secret-token-123' })
  store.resetCache()
  assert.equal(store.readOverrides().authToken, 'secret-token-123')
})

test('配置文件坏了按「没有覆盖项」处理', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  const file = store.configPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{ 这不是 JSON', 'utf8')
  store.resetCache()
  assert.deepEqual(store.readOverrides(), {})
  // 恢复成合法文件，别影响后面的测试
  store.writeOverrides({ upstreamUrl: 'http://127.0.0.1:5219/mcp' })
})

test('mergeConfig 三层覆盖顺序正确', () => {
  const defaults = { a: 1, b: 2, c: 3 }
  const deploy = { b: 20, c: 30 }
  const overrides = { c: 300 }
  assert.deepEqual(store.mergeConfig(defaults, deploy, overrides), { a: 1, b: 20, c: 300 })
})

test('mergeConfig 忽略不在默认值里的键', () => {
  const merged = store.mergeConfig({ a: 1 }, { 陌生键: 'x' }, {})
  assert.deepEqual(merged, { a: 1 })
})

test('mergeConfig 把空令牌当作没设', () => {
  const merged = store.mergeConfig({ authToken: undefined }, { authToken: '' }, {})
  assert.ok(!('authToken' in merged), '空串不该留下 authToken 键')
})

test('maskToken 不回显真值', () => {
  const masked = store.maskToken('abcdefghijklmnop')
  assert.equal(masked.configured, true)
  assert.ok(!JSON.stringify(masked).includes('abcdefghijklmnop'), '不该包含完整令牌')
  assert.match(masked.preview, /^abcd…mnop$/)
})

test('maskToken 对空值只说「没配」', () => {
  assert.deepEqual(store.maskToken(''), { configured: false })
  assert.deepEqual(store.maskToken(undefined), { configured: false })
})
