/** 审批文案的单元测试。纯函数。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeIntent } from '../src/approval.js'

test('删除类操作说清楚后果', () => {
  const text = describeIntent('instance_delete', { instance_id: 'local:abc' })
  assert.match(text, /永久删除/)
  assert.match(text, /instance_delete/)
  assert.match(text, /local:abc/)
})

test('存档操作带上存档 id', () => {
  const text = describeIntent('world_delete', { instance_id: 'local:abc', world_id: '新的世界' })
  assert.match(text, /永久删除/)
  assert.match(text, /world_id=新的世界/)
})

test('文件操作带上路径', () => {
  const text = describeIntent('file_write', { path: 'options.txt' })
  assert.match(text, /写入文件/)
  assert.match(text, /path=options.txt/)
})

test('instance_id 可以从 context 传入', () => {
  const text = describeIntent('content_remove', {}, { instanceId: 'local:xyz' })
  assert.match(text, /实例 local:xyz/)
})

test('不认识的 op 用通用措辞而不是空', () => {
  const text = describeIntent('some_new_tool', {})
  assert.match(text, /需要完全访问权限/)
  assert.match(text, /some_new_tool/)
})

test('没有参数时不留下空括号', () => {
  const text = describeIntent('launcher_exit', {})
  assert.ok(!text.includes('（）'), `不该有空括号：${text}`)
})
