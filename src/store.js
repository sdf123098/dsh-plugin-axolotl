/**
 * 配置持久化：设置页改的值要能活过重启。
 *
 * 为什么不直接改 `cordis.patch.yml`：那是用户手写的部署文件，插件不该覆写它 ——
 * 用户下次编辑会和插件写入打架，而且 YAML 注释会被吃掉。
 *
 * 所以分两层：
 *   - `cordis.patch.yml` 里的 `config` 是**部署默认值**（用户或发行方定的）
 *   - 设置页改的写进 `<dsh home>/data/dsh-plugin-axolotl/config.json`，覆盖同名项
 *
 * 这样「部署配置」和「用户偏好」各归各的，谁也不毁谁。
 *
 * @module dsh-plugin-axolotl/store
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 可以在设置页改的字段。令牌单独处理（见 {@link maskToken}）。 */
export const EDITABLE = [
  'upstreamUrl',
  'authToken',
  'autoConnect',
  'sessionPolicy',
  'sessionIdleMs',
  'sessionRetryMs',
  'exposeRawTool',
  'requireApproval',
  'toolCallTimeoutMs',
]

/**
 * 配置文件的路径。
 *
 * `DSH_HOME` 优先（DSH 自己的约定），否则退回 `~/.dsh`。
 */
export function configPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'data', 'dsh-plugin-axolotl', 'config.json')
}

/** 读过一次就记住，避免每次调用都碰磁盘。 */
let cache

/**
 * 读用户覆盖项。
 * @returns {Record<string, unknown>}
 */
export function readOverrides() {
  if (cache !== undefined) return cache
  try {
    const text = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(text)
    cache = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // 文件不存在、权限不够、JSON 坏了 —— 都按「没有覆盖项」处理，不让插件起不来
    cache = {}
  }
  return cache
}

/**
 * 写用户覆盖项。只保留 {@link EDITABLE} 里的字段。
 *
 * @param {Record<string, unknown>} patch 要合并进去的字段
 * @returns {{ ok: true, config: Record<string, unknown> } | { ok: false, error: string }}
 */
export function writeOverrides(patch) {
  const next = { ...readOverrides() }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!EDITABLE.includes(key)) continue
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  try {
    const file = configPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    cache = next
    return { ok: true, config: next }
  } catch (error) {
    return { ok: false, error: String(/** @type {{ message?: string }} */ (error)?.message ?? error) }
  }
}

/** 清掉缓存，下次读盘。测试用。 */
export function resetCache() {
  cache = undefined
}

/**
 * 合并三层配置：默认值 ← 部署配置 ← 用户覆盖。
 *
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown> | undefined} deploy  patch 行里的 config
 * @param {Record<string, unknown>} overrides  设置页写入的
 * @returns {Record<string, unknown>}
 */
export function mergeConfig(defaults, deploy, overrides) {
  const merged = { ...defaults }
  for (const [key, value] of Object.entries(deploy ?? {})) {
    if (value !== undefined && key in defaults) merged[key] = value
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined && key in defaults) merged[key] = value
  }
  // 令牌为空字符串等同于没设，避免把空串当成「已配置」
  if (merged.authToken === '') delete merged.authToken
  return merged
}

/**
 * 令牌的对外形态：永远不回显真值，只说有没有配。
 *
 * 设置页是浏览器环境，把令牌原样送到前端意味着它会出现在 DOM、devtools、
 * 以及任何一次网络抓包里。既然用户只需要「改」和「清」，回显没有收益。
 *
 * @param {string | undefined} token
 */
export function maskToken(token) {
  if (typeof token !== 'string' || token === '') return { configured: false }
  return { configured: true, preview: `${token.slice(0, 4)}…${token.slice(-4)}`, length: token.length }
}
