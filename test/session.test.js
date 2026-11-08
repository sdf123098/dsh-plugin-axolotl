/** 控制会话的单元测试。用假上游，不需要启动器。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SessionManager } from '../src/session.js'

/**
 * 造一个假上游：按队列返回预设响应，并记录调用。
 * @param {Array<any | ((name: string) => any) | Error>} responses
 */
function fakeUpstream(responses) {
  const calls = []
  let index = 0
  return {
    calls,
    url: 'http://fake',
    connected: true,
    async call(name, args) {
      calls.push({ name, args })
      const next = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(name) : next
    },
  }
}

/** 一个「开成功」的响应。 */
function opened(id = 'session-1') {
  return { structuredContent: { session_id: id, full_access: true } }
}

/** 一个「被占用」的响应。注意 error 是对象，这是上游的真实形状。 */
function busy() {
  return {
    structuredContent: {
      error: { code: 'control_not_granted', message: 'Another control session or approval request is active' },
    },
  }
}

test('ensure 开一个会话并复用', async () => {
  const upstream = fakeUpstream([opened('abc')])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0 })
  assert.equal(await session.ensure(), 'abc')
  assert.equal(await session.ensure(), 'abc')
  assert.equal(upstream.calls.length, 1, '第二次不该再开')
})

test('ensure 在被占用时重试，直到拿到会话', async () => {
  const upstream = fakeUpstream([busy(), busy(), opened('later')])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 20_000 })
  assert.equal(await session.ensure(), 'later')
  assert.equal(upstream.calls.length, 3)
})

test('ensure 在重试预算用完后给出可读错误', async () => {
  const upstream = fakeUpstream([busy()])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 1_500 })
  await assert.rejects(session.ensure(), /还有一个控制会话没释放/)
})

test('ensure 对非占用类错误立即失败，不浪费重试预算', async () => {
  const upstream = fakeUpstream([{ structuredContent: { error: { code: 'boom', message: '设备不可用' } } }])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 30_000 })
  await assert.rejects(session.ensure(), /无法申请控制会话：设备不可用/)
  assert.equal(upstream.calls.length, 1, '不该重试')
})

test('manual 策略下拒绝自动开会话', async () => {
  const upstream = fakeUpstream([opened('x')])
  const session = new SessionManager({ upstream, policy: 'manual', idleMs: 60_000, retryMs: 0 })
  await assert.rejects(session.ensure(), /manual/)
  assert.equal(upstream.calls.length, 0)
})

test('close 把会话还给上游', async () => {
  const upstream = fakeUpstream([opened('s1'), { structuredContent: { ended: true } }])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0 })
  await session.ensure()
  await session.close('test')
  assert.equal(session.id, undefined)
  assert.equal(upstream.calls.at(-1).name, 'end_session')
  assert.equal(upstream.calls.at(-1).args.session_id, 's1')
})

test('close 在没有会话时是空操作', async () => {
  const upstream = fakeUpstream([opened()])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0 })
  await session.close('noop')
  assert.equal(upstream.calls.length, 0)
})

test('闲置过期后重新开会话', async () => {
  const upstream = fakeUpstream([opened('old'), { structuredContent: { ended: true } }, opened('new')])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0 })
  assert.equal(await session.ensure(), 'old')
  // 手动把时间推到过期
  session.current.lastUsed = Date.now() - 120_000
  assert.equal(session.stale, true)
  assert.equal(await session.ensure(), 'new')
})

test('touch 推迟闲置计时', async () => {
  const upstream = fakeUpstream([opened('s')])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0 })
  await session.ensure()
  const before = session.current.lastUsed
  await new Promise((resolve) => setTimeout(resolve, 5))
  session.touch()
  assert.ok(session.current.lastUsed > before)
  assert.equal(session.stale, false)
})

test('reapIfIdle 只在过期时关会话', async () => {
  const upstream = fakeUpstream([opened('s'), { structuredContent: { ended: true } }])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0 })
  await session.ensure()
  await session.reapIfIdle()
  assert.equal(session.id, 's', '没过期不该关')
  session.current.lastUsed = Date.now() - 120_000
  await session.reapIfIdle()
  assert.equal(session.id, undefined)
})

test('上游重连后丢掉旧 session_id', async () => {
  const upstream = fakeUpstream([opened('s')])
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0 })
  await session.ensure()
  upstream.resetSessionHook()
  assert.equal(session.id, undefined)
})
