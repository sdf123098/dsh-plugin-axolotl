/** 令牌与认证行为的单元测试。用假上游，不需要真启动器。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SessionManager } from '../src/session.js'
import { AxolotlService } from '../src/service.js'
import { isSessionGone, isUnauthorized, statusOf } from '../src/upstream.js'

/** 造一个会抛指定错误的假上游。 */
function failingUpstream(error) {
  const calls = []
  return {
    calls,
    url: 'http://127.0.0.1:5219/mcp',
    connected: false,
    authenticated: false,
    lastError: undefined,
    token: undefined,
    async call(name, args) {
      calls.push({ name, args })
      throw error
    },
    async listTools() {
      throw error
    },
    async ensure() {
      throw error
    },
    async close() {},
    offlineMessage: (d) => `连不上美西螈启动器：${d}`,
    authMessage: (d) => `启动器拒绝了这次连接（${d}）`,
    setToken() {
      return false
    },
  }
}

/** 造一个最小可用的 catalog。 */
function fakeCatalog() {
  return {
    ready: false,
    tools: [],
    domains: new Map(),
    capabilities: new Map(),
    async load() {},
    capabilityOf: () => ({ session: true, full: false, readOnly: false, deferred: false }),
    domainTools: () => [],
  }
}

test('isUnauthorized 认得 401 / 403 / unauthorized', () => {
  assert.equal(isUnauthorized(new Error('MCP error -32603: HTTP 401 Unauthorized')), true)
  assert.equal(isUnauthorized(new Error('Forbidden')), true)
  assert.equal(isUnauthorized(new Error('invalid_token')), true)
  assert.equal(isUnauthorized(new Error('missing token')), true)
})

test('isUnauthorized 靠 error.code 认 401 —— 真机就是这个形状', () => {
  // 实测：启动器开身份验证后，SDK 抛的错误**消息里只有空尾巴**，
  // 状态码在 error.code 上。只扫消息会漏判，进而把它当成「会话没了」去重连。
  const error = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: '), { code: 401 })
  assert.equal(statusOf(error), 401)
  assert.equal(isUnauthorized(error), true)
  assert.equal(isSessionGone(error), false, '认证失败不该被当成会话过期去重连')
})

test('statusOf 也能从 cause 与字符串里取状态码', () => {
  assert.equal(statusOf({ cause: { status: 403 } }), 403)
  assert.equal(statusOf({ code: '401' }), 401)
  assert.equal(statusOf(new Error('no status here')), undefined)
  assert.equal(statusOf(undefined), undefined)
})

test('isUnauthorized 不误判断线', () => {
  assert.equal(isUnauthorized(new Error('fetch failed')), false)
  assert.equal(isUnauthorized(new Error('ECONNREFUSED')), false)
})

test('认证失败时给出填令牌的提示，而不是「启动器没开」', async () => {
  // 用真的 Upstream 取文案，假上游只负责抛出 401 —— 这样文案本身也被测到
  const { Upstream } = await import('../src/upstream.js')
  const real = new Upstream({ url: 'http://127.0.0.1:5219/mcp' })

  const upstream = {
    ...failingUpstream(new Error('HTTP 401 Unauthorized')),
    authMessage: (d) => real.authMessage(d),
    offlineMessage: (d) => real.offlineMessage(d),
  }
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0 })
  const service = new AxolotlService({
    upstream,
    catalog: fakeCatalog(),
    session,
    requireApproval: false,
  })
  const result = await service.call('instance_list', {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unauthorized')
  assert.match(result.error, /启动器拒绝了这次连接/)
  assert.match(result.error, /连接令牌/)
  assert.match(result.error, /要求身份验证/)
  assert.ok(!result.error.includes('连不上美西螈启动器'), '不该说成连不上')
})

test('上游不可达时给出「启动器没开」的提示，而不是认证错误', async () => {
  const upstream = failingUpstream(new Error('fetch failed'))
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0 })
  const service = new AxolotlService({
    upstream,
    catalog: fakeCatalog(),
    session,
    requireApproval: false,
  })
  const result = await service.call('instance_list', {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'offline')
  assert.match(result.error, /连不上美西螈启动器/)
})

test('Upstream 构造：空令牌等同于没配', async () => {
  const { Upstream } = await import('../src/upstream.js')
  const upstream = new Upstream({ url: 'http://127.0.0.1:1/mcp', token: '' })
  assert.equal(upstream.authenticated, false)
  const withToken = new Upstream({ url: 'http://127.0.0.1:1/mcp', token: 'abc' })
  assert.equal(withToken.authenticated, true)
})

test('Upstream.setToken 换令牌时断开连接', async () => {
  const { Upstream } = await import('../src/upstream.js')
  const upstream = new Upstream({ url: 'http://127.0.0.1:1/mcp', token: 'old' })
  // 假装连着
  upstream.connection = { client: { close: async () => {} }, transport: {} }
  const changed = upstream.setToken('new')
  assert.equal(changed, true)
  assert.equal(upstream.token, 'new')
  assert.equal(upstream.connected, false, '换令牌后必须重连')
})

test('Upstream.setToken 值没变时不重连', async () => {
  const { Upstream } = await import('../src/upstream.js')
  const upstream = new Upstream({ url: 'http://127.0.0.1:1/mcp', token: 'same' })
  upstream.connection = { client: { close: async () => {} }, transport: {} }
  assert.equal(upstream.setToken('same'), false)
  assert.equal(upstream.connected, true, '没变就不该断')
})

test('Upstream.setToken 传空串表示清掉令牌', async () => {
  const { Upstream } = await import('../src/upstream.js')
  const upstream = new Upstream({ url: 'http://127.0.0.1:1/mcp', token: 'abc' })
  upstream.setToken('')
  assert.equal(upstream.authenticated, false)
})
