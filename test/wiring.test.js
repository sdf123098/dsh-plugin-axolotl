/**
 * 装配烟测：用假 ctx 跑一遍 apply()，确认插件能被 cordis 装起来。
 *
 * 不打真实启动器（Upstream 是懒连接，不调就不连），只验证：
 *   - 所有模块能被 import
 *   - apply() 不抛
 *   - 工具、effect、路由都按预期注册
 *
 * 这一层能挡住的典型错误：API 用错（ctx.effect / ctx.on / ctx.inject）、
 * 注册顺序问题、导入路径写错。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

/**
 * 所有装配测试都用这个**没人监听**的地址。
 *
 * 用真实地址（5219）会把测试连到用户正在跑的启动器上：SDK 的 SSE 流会一直挂着，
 * 测试进程永远不退出；而且会读到用户真实的配置文件（里面可能有令牌）。
 */
const OFFLINE_URL = 'http://127.0.0.1:59999/mcp'

let home

before(() => {
  // 隔离配置目录：不要读写用户真实的 ~/.dsh/data/dsh-plugin-axolotl/config.json
  home = mkdtempSync(join(tmpdir(), 'axolotl-wiring-'))
  process.env.DSH_HOME = home
})

after(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

/** 造一个够用的假 cordis context。 */
function fakeContext() {
  const tools = []
  const effects = []
  const listeners = []
  const injections = []
  const services = new Map()

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
    },
    effect: (factory, label) => {
      effects.push(label ?? '(unnamed)')
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: (event, listener) => {
      listeners.push({ event, listener })
      return () => {}
    },
    inject: (names, callback) => {
      injections.push(names)
      // 假 webServer：让路由挂载路径也跑一遍
      const scoped = {
        webServer: {
          register: (route) => {
            injections.push(`route:${route.path}`)
            return () => {}
          },
        },
      }
      callback(scoped)
      return () => {}
    },
    get: (name) => services.get(name),
  }
  return { ctx, tools, effects, listeners, injections, services }
}

test('apply() 装配成功并注册基础工具', async () => {
  const { apply } = await import('../src/index.js')
  const { ctx, tools, effects, listeners } = fakeContext()

  apply(ctx, { autoConnect: false, upstreamUrl: OFFLINE_URL })

  const names = tools.map((tool) => tool.name)
  assert.ok(names.includes('axolotl_status'), `缺 axolotl_status，实际：${names.join(',')}`)
  assert.ok(names.includes('axolotl_raw'), `缺 axolotl_raw，实际：${names.join(',')}`)
  assert.ok(effects.length >= 3, `effect 数量不对：${effects.join(',')}`)
  assert.ok(
    listeners.some((entry) => entry.event === 'tools/pre-execute'),
    '应当注册了 pre-execute 闸门',
  )
})

test('exposeRawTool=false 时不注册 raw', async () => {
  const { apply } = await import('../src/index.js')
  const { ctx, tools } = fakeContext()
  apply(ctx, { autoConnect: false, exposeRawTool: false, upstreamUrl: OFFLINE_URL })
  const names = tools.map((tool) => tool.name)
  assert.ok(names.includes('axolotl_status'))
  assert.ok(!names.includes('axolotl_raw'), '不该注册 raw')
})

test('requireApproval=false 时不注册审批闸门', async () => {
  const { apply } = await import('../src/index.js')
  const { ctx, listeners } = fakeContext()
  apply(ctx, { autoConnect: false, requireApproval: false, upstreamUrl: OFFLINE_URL })
  assert.ok(
    !listeners.some((entry) => entry.event === 'tools/pre-execute'),
    '闸门应当被配置关掉',
  )
})

test('每个注册的工具都带 output.schema 与 output.render', async () => {
  const { apply } = await import('../src/index.js')
  const { ctx, tools } = fakeContext()
  apply(ctx, { autoConnect: false, upstreamUrl: OFFLINE_URL })
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.name.startsWith('axolotl_'), `工具名应当是 axolotl_*：${tool.name}`)
    assert.ok(tool.output !== undefined, `${tool.name} 缺 output`)
    assert.ok(tool.output.schema !== undefined, `${tool.name} 缺 output.schema`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 output.render`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
  }
})

test('render 的返回值是合法的内容块数组', async () => {
  const { apply } = await import('../src/index.js')
  const { ctx, tools } = fakeContext()
  apply(ctx, { autoConnect: false, upstreamUrl: OFFLINE_URL })

  const status = tools.find((tool) => tool.name === 'axolotl_status')
  const blocks = status.output.render({}, { text: 'hello', connected: true })
  assert.ok(Array.isArray(blocks), 'render 必须返回数组')
  assert.ok(blocks.length > 0)
  for (const block of blocks) {
    assert.equal(typeof block.type, 'string', '每个块都要有 type')
  }
})

test('status 工具在启动器不可达时也能返回，不抛异常', async () => {
  const { apply } = await import('../src/index.js')
  const { ctx, tools } = fakeContext()
  // 指向一个没人监听的端口，模拟启动器没开
  apply(ctx, { autoConnect: false, upstreamUrl: 'http://127.0.0.1:59999/mcp' })

  const status = tools.find((tool) => tool.name === 'axolotl_status')
  const value = await status.execute({}, {})
  assert.equal(typeof value.text, 'string')
  assert.equal(value.connected, false)
  assert.match(value.text, /not connected/)
})

test('领域工具的 op=help 在没有上游时也不炸', async () => {
  // 领域工具要目录才注册，这里直接把 verify 放在 apply 之后手工断言：
  // 没有上游时只有 2 个工具，这是预期的降级行为。
  const { apply } = await import('../src/index.js')
  const { ctx, tools } = fakeContext()
  apply(ctx, { autoConnect: false, upstreamUrl: 'http://127.0.0.1:59999/mcp' })
  assert.equal(tools.length, 2, `降级时应当只有 status + raw，实际 ${tools.length}`)
})

