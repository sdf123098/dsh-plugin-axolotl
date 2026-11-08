/** 领域划分的单元测试。纯函数，不依赖 DSH 也不依赖启动器。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DOMAINS, SKIP_DOMAIN, classify, describeOp, groupByDomain, helpFor, suggestOps } from '../src/domains.js'

test('classify 把每个前缀都归到对应领域', () => {
  assert.equal(classify('instance_list'), 'instances')
  assert.equal(classify('install_job_get'), 'instances')
  assert.equal(classify('download_job_list'), 'instances')
  assert.equal(classify('process_list'), 'instances')
  assert.equal(classify('launch_set_memory'), 'launch')
  assert.equal(classify('metadata_list_game_versions'), 'launch')
  assert.equal(classify('core_preview_jar'), 'launch')
  assert.equal(classify('content_list'), 'content')
  assert.equal(classify('resource_search'), 'content')
  assert.equal(classify('modpack_prepare_install'), 'content')
  assert.equal(classify('file_read_text'), 'files')
  assert.equal(classify('archive_create'), 'files')
  assert.equal(classify('nbt_read'), 'files')
  assert.equal(classify('world_list'), 'worlds')
  assert.equal(classify('seed_get_biome'), 'worlds')
  assert.equal(classify('schematic_open'), 'schematics')
  assert.equal(classify('server_list'), 'servers')
  assert.equal(classify('multiplayer_host'), 'servers')
  assert.equal(classify('ui_screenshot'), 'ui')
  assert.equal(classify('settings_get'), 'system')
  assert.equal(classify('get_launcher_capabilities'), 'system')
})

test('classify 对认不出来的名字退回 system，不丢工具', () => {
  assert.equal(classify('some_future_tool'), 'system')
  assert.equal(classify('zzz'), 'system')
})

test('每个领域的 id 唯一', () => {
  const ids = DOMAINS.map((domain) => domain.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('会话工具被排除在领域之外', () => {
  for (const name of ['start_session', 'end_session', 'get_launcher_info', 'get_launcher_capabilities']) {
    assert.ok(SKIP_DOMAIN.has(name), `${name} 应当在 SKIP_DOMAIN 里`)
  }
})

test('groupByDomain 分组、排序、并跳过会话工具', () => {
  const tools = [
    { name: 'instance_list' },
    { name: 'instance_get' },
    { name: 'world_list' },
    { name: 'start_session' },
    { name: 'end_session' },
  ]
  const domains = groupByDomain(tools)
  assert.deepEqual(domains.get('instances').map((t) => t.name), ['instance_get', 'instance_list'])
  assert.deepEqual(domains.get('worlds').map((t) => t.name), ['world_list'])
  const all = [...domains.values()].flat().map((t) => t.name)
  assert.ok(!all.includes('start_session'))
})

test('describeOp 去掉 session_id 并区分必填/可选', () => {
  const text = describeOp({
    name: 'world_get',
    description: '读一个存档的元数据。\n第二行。',
    inputSchema: {
      type: 'object',
      required: ['instance_id', 'world_id', 'session_id'],
      properties: {
        instance_id: { type: 'string' },
        world_id: { type: 'string' },
        session_id: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  })
  assert.match(text, /必填: instance_id, world_id/)
  assert.ok(!text.includes('session_id'), 'session_id 不该出现在提示里')
  assert.match(text, /可选: limit/)
  // 说明压成一行（一个 op 占一行，方便模型扫）
  const lines = text.split('\n')
  assert.equal(lines.length, 2, '一个 op 应当是两行：标题 + 说明')
})

test('describeOp 处理没有 description / schema 的工具', () => {
  const text = describeOp({ name: 'weird_tool' })
  assert.match(text, /- weird_tool/)
})

test('helpFor 给每个工具一行', () => {
  const text = helpFor([
    { name: 'a_one', description: 'first' },
    { name: 'a_two', description: 'second' },
  ])
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 2)
})

test('suggestOps 在 op 打错时给出候选', () => {
  const tools = [{ name: 'instance_list' }, { name: 'instance_get' }, { name: 'world_list' }]
  assert.deepEqual(suggestOps('instance_lst', tools), ['instance_list'])
  assert.deepEqual(suggestOps('screenshot', tools), [])
})
