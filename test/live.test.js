/**
 * 端到端集成测试：直接连真的启动器。
 *
 * 只有装了启动器并且它在跑时才有意义，所以默认跳过 —— 用 `AXOLOTL_LIVE=1` 打开。
 * 这样 CI 上 `pnpm test` 永远是绿的，本地想验真机时又不至于要改代码。
 *
 *   set AXOLOTL_LIVE=1
 *   node --test test/live.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Catalog } from '../src/catalog.js'
import { AxolotlService } from '../src/service.js'
import { SessionManager } from '../src/session.js'
import { Upstream } from '../src/upstream.js'

const LIVE = process.env.AXOLOTL_LIVE === '1'
const URL = process.env.AXOLOTL_MCP_URL ?? 'http://127.0.0.1:5219/mcp'

/** 造一套连真启动器的依赖。 */
function harness() {
  const log = () => {}
  const upstream = new Upstream({ url: URL, log })
  const catalog = new Catalog({ upstream, log })
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 45_000, log })
  const service = new AxolotlService({ upstream, catalog, session, requireApproval: false, log })
  return { upstream, catalog, session, service }
}

test('连上启动器并拿到目录', { skip: !LIVE }, async () => {
  const { upstream, catalog, service } = harness()
  try {
    await catalog.load()
    assert.ok(catalog.tools.length > 0, '上游工具清单不该为空')
    assert.ok(catalog.domains.size >= 8, `领域划分应该覆盖大部分，实际 ${catalog.domains.size}`)
    const status = await service.status()
    assert.equal(status.connected, true)
    assert.ok(status.upstreamTools > 0)
  } finally {
    await upstream.close()
  }
})

test('读操作能拿到数据', { skip: !LIVE }, async () => {
  const { upstream, service, session } = harness()
  try {
    const instances = await service.call('instance_list', { limit: 5 })
    assert.equal(instances.ok, true, `instance_list 失败：${instances.error}`)
    assert.ok(Array.isArray(instances.value?.items), '应当返回 items 数组')
  } finally {
    await session.close('test done')
    await upstream.close()
  }
})

test('数组型 structuredContent 被包成 items', { skip: !LIVE }, async () => {
  const { upstream, service, session } = harness()
  try {
    const result = await service.call('process_list', {})
    assert.equal(result.ok, true, `process_list 失败：${result.error}`)
    // 上游直接返回数组，service 归一化后应当是 {items: [...]}
    const value = result.value
    assert.ok(value !== null && typeof value === 'object', '结果应当是对象')
    assert.ok(Array.isArray(value.items ?? value), '应当是数组或被包成 items')
  } finally {
    await session.close('test done')
    await upstream.close()
  }
})

test('业务错误被识别为失败而不是成功', { skip: !LIVE }, async () => {
  const { upstream, service, session } = harness()
  try {
    const result = await service.call('world_get', { instance_id: 'local:nonexistent', world_id: 'nope' })
    assert.equal(result.ok, false, '不存在的存档应当报失败')
    assert.ok(typeof result.error === 'string' && result.error.length > 0)
  } finally {
    await session.close('test done')
    await upstream.close()
  }
})

test('控制会话自动开关，且能复用', { skip: !LIVE }, async () => {
  const { upstream, service, session } = harness()
  try {
    const first = await service.call('instance_list', { limit: 1 })
    assert.equal(first.ok, true)
    const id = session.id
    assert.ok(typeof id === 'string' && id.length > 0, '应当自动开了控制会话')
    const second = await service.call('instance_list', { limit: 1 })
    assert.equal(second.ok, true)
    assert.equal(session.id, id, '第二次应当复用同一个会话')
  } finally {
    await session.close('test done')
    await upstream.close()
  }
})

test('上游不可达时给出可读的中文错误', { skip: !LIVE }, async () => {
  const log = () => {}
  const upstream = new Upstream({ url: 'http://127.0.0.1:59999/mcp', log })
  const catalog = new Catalog({ upstream, log })
  const session = new SessionManager({ upstream, policy: 'auto', idleMs: 60_000, retryMs: 0, log })
  const service = new AxolotlService({ upstream, catalog, session, requireApproval: false, log })
  try {
    const result = await service.call('instance_list', {})
    assert.equal(result.ok, false)
    assert.match(result.error, /连不上美西螈启动器/)
    assert.match(result.error, /不用重启 DSH/)
  } finally {
    await upstream.close()
  }
})
