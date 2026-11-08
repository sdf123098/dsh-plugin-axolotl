/**
 * 领域划分：把上游 269 个工具收成 9 个领域工具。
 *
 * 为什么要收：`tools/list` 的完整 schema 约 195 KB，全量灌进系统提示不现实。
 * 收窄之后每个领域工具只列 op 名字（约 9 KB），需要的参数用 `op: 'help'` 现查，
 * 或者用 `axolotl_raw` 直接调。
 *
 * 分类是**按工具名前缀**算的，不写死工具清单 —— 上游 beta 加新工具时自动归位，
 * 认不出来的落到 `system`，不会丢。
 *
 * @module dsh-plugin-axolotl/domains
 */

/** 9 个领域。`prefixes` 的顺序有意义：先匹配到的赢。 */
export const DOMAINS = [
  {
    id: 'instances',
    label: '实例与安装/下载队列',
    prefixes: ['instance_', 'install_job_', 'download_job_', 'download_history_', 'process_'],
  },
  {
    id: 'launch',
    label: '启动、游戏版本元数据、核心 JAR 组件',
    prefixes: ['launch_', 'metadata_', 'core_'],
  },
  {
    id: 'content',
    label: '模组/资源包/光影与该实例内容',
    prefixes: ['resource_', 'content_', 'modpack_'],
  },
  {
    id: 'files',
    label: '实例内文件、压缩包、NBT',
    prefixes: ['file_', 'archive_', 'nbt_'],
  },
  {
    id: 'worlds',
    label: '存档与种子工具',
    prefixes: ['world_', 'seed_'],
  },
  {
    id: 'schematics',
    label: '投影/结构文件（.schem、.litematic）',
    prefixes: ['schematic_'],
  },
  {
    id: 'servers',
    label: '专用服务器与联机',
    prefixes: ['server_', 'multiplayer_'],
  },
  {
    id: 'ui',
    label: '启动器界面：读结构、截图、导航、点击、输入、滚动',
    prefixes: ['ui_'],
  },
  {
    id: 'system',
    label: '设置、代理、存储、数据库、日志、账号、皮肤、截图库、更新、操作记录',
    prefixes: [
      'get_launcher_',
      'java_',
      'settings_',
      'proxy_',
      'network_',
      'storage_',
      'database_',
      'logs_',
      'news_',
      'privacy_',
      'account_',
      'skin_',
      'cape_',
      'screenshot_',
      'shortcut_',
      'system_',
      'launcher_',
      'operations_',
    ],
  },
]

/**
 * 会话生命周期由插件自动管理，这几个不暴露给模型 —— 免得模型手动开关和自动逻辑打架。
 * `get_launcher_capabilities` 的内容已经内化成了每个工具的必填参数提示。
 */
export const SKIP_DOMAIN = new Set([
  'get_launcher_capabilities',
  'start_session',
  'end_session',
  'get_launcher_info',
])

/**
 * 按名字判断领域。认不出来的一律归 `system`（宁可多放，不能丢）。
 * @param {string} name 上游工具名
 * @returns {string} 领域 id
 */
export function classify(name) {
  for (const domain of DOMAINS) {
    for (const prefix of domain.prefixes) {
      if (name.startsWith(prefix)) return domain.id
    }
  }
  return 'system'
}

/**
 * 把上游工具列表分到各领域，并按名字排序保证输出稳定。
 * @param {Array<{ name: string, description?: string, inputSchema?: unknown }>} tools
 * @returns {Map<string, Array<{ name: string, description?: string, inputSchema?: unknown }>>}
 */
export function groupByDomain(tools) {
  const domains = new Map()
  for (const tool of tools) {
    if (SKIP_DOMAIN.has(tool.name)) continue
    const id = classify(tool.name)
    if (!domains.has(id)) domains.set(id, [])
    domains.get(id).push(tool)
  }
  for (const list of domains.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return domains
}

/**
 * 一个 op 的说明文本：名字、必填参数、说明首行。
 * @param {{ name: string, description?: string, inputSchema?: { properties?: Record<string, unknown>, required?: string[] } }} tool
 * @param {number} [descriptionLimit]
 */
export function describeOp(tool, descriptionLimit = 200) {
  const schema = tool.inputSchema ?? {}
  const required = (schema.required ?? []).filter((key) => key !== 'session_id')
  const optional = Object.keys(schema.properties ?? {}).filter(
    (key) => key !== 'session_id' && !required.includes(key),
  )
  const head = required.length > 0 ? `(必填: ${required.join(', ')})` : ''
  const tail = optional.length > 0 ? ` [可选: ${optional.join(', ')}]` : ''
  const flat = String(tool.description ?? '').replace(/\s+/g, ' ').trim()
  const text = flat.length > descriptionLimit ? `${flat.slice(0, descriptionLimit - 1)}…` : flat
  return `- ${tool.name}${head}${tail}\n  ${text}`
}

/**
 * 一个领域里全部 op 的说明。
 * @param {Array<{ name: string, description?: string, inputSchema?: unknown }>} tools
 */
export function helpFor(tools) {
  return tools.map((tool) => describeOp(tool)).join('\n')
}

/**
 * 找领域里最接近的几个 op 名，用于「op 打错了」时给出建议。
 *
 * 用编辑距离排序而不是前缀匹配：`instance_lst` 与 `instance_list` 差 1 个字符，
 * 与 `instance_get` 共享 9 个字符前缀但差了 5 个 —— 前缀法会把两个都列出来，
 * 反而淹没了正确答案。
 *
 * @param {string} op
 * @param {Array<{ name: string }>} tools
 * @param {number} [limit]
 */
export function suggestOps(op, tools, limit = 6) {
  const needle = op.replace(/^axolotl_/, '').toLowerCase()
  if (needle === '') return []

  const scored = []
  for (const tool of tools) {
    const name = tool.name.toLowerCase()
    if (name === needle) continue
    // 包含关系直接算很近（用户可能少打了前缀或某个词）
    if (name.includes(needle) || needle.includes(name)) {
      scored.push({ name: tool.name, distance: 0 })
      continue
    }
    const distance = editDistance(needle, name)
    // 阈值随名字长度放宽：长名字允许改错更多字符
    const threshold = Math.max(2, Math.floor(name.length / 4))
    if (distance <= threshold) scored.push({ name: tool.name, distance })
  }

  if (scored.length === 0) return []
  // 只保留最接近的那一档。`instance_lst` 与 `instance_list` 差 1 个字符、
  // 与 `instance_get` 差 2 个 —— 后者也过得了阈值，但列出来只是噪声。
  const best = Math.min(...scored.map((entry) => entry.distance))
  return scored
    .filter((entry) => entry.distance === best)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name)
}

/**
 * Levenshtein 距离，只保留两行，长名字也不吃内存。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[b.length]
}
