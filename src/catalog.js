/**
 * 上游目录：每次连接后重新拉一遍工具清单与权限表。
 *
 * 为什么每次连接都重拉而不是启动时拉一次：
 *   - 启动器还是 beta，工具集会变（1.10.5 只有 3 个工具，1.11.0 有 269 个）
 *   - 权限表（read_only / requires_full_access / requires_session）决定了要不要开会话、
 *     要不要走审批，猜错了会白开一次会话或者误拦
 *   - 上游没开时必须能降级，不能因为拉不到目录就让插件加载失败
 *
 * @module dsh-plugin-axolotl/catalog
 */

import { groupByDomain } from './domains.js'

/**
 * 一个上游工具的能力描述。
 * @typedef {{
 *   session: boolean,
 *   full: boolean,
 *   readOnly: boolean,
 *   deferred: boolean,
 * }} Capability
 */

/**
 * 工具目录。
 */
export class Catalog {
  /**
   * @param {{ upstream: import('./upstream.js').Upstream, log?: (message: string) => void }} options
   */
  constructor(options) {
    this.upstream = options.upstream
    this.log = options.log ?? (() => {})
    /** @type {Array<{ name: string, description?: string, inputSchema?: any }> | undefined} */
    this.tools = undefined
    /** @type {Map<string, Capability> | undefined} */
    this.capabilities = undefined
    /** @type {Map<string, Array<any>> | undefined} */
    this.domains = undefined
    /** @type {Promise<void> | undefined} */
    this.loading = undefined
    this.loadedAt = 0
  }

  /** 目录是否已加载。 */
  get ready() {
    return this.tools !== undefined
  }

  /**
   * 加载（或复用）目录。
   * @param {{ force?: boolean }} [options]
   */
  async load({ force = false } = {}) {
    if (this.tools !== undefined && !force) return
    if (this.loading !== undefined) return this.loading
    this.loading = this.#load().finally(() => {
      this.loading = undefined
    })
    return this.loading
  }

  async #load() {
    const tools = await this.upstream.listTools()
    /** @type {Map<string, Capability>} */
    const capabilities = new Map()

    try {
      const caps = await this.upstream.call('get_launcher_capabilities', {})
      const entries = caps?.structuredContent?.tools ?? []
      for (const entry of entries) {
        capabilities.set(entry.name, {
          session: entry.requires_session === true,
          full: entry.requires_full_access === true,
          readOnly: entry.read_only === true,
          deferred: entry.returns_operation_id === true,
        })
      }
    } catch (error) {
      // 权限表拿不到就按名字猜：除了三个会话工具，其余都需要会话。宁可多开一次会话，
      // 也不要因为少开而让调用失败 —— 会话是可复用且会自动关的。
      this.log(`capabilities unavailable, falling back to name heuristics: ${String(error?.message ?? error)}`)
    }

    for (const tool of tools) {
      if (capabilities.has(tool.name)) continue
      capabilities.set(tool.name, {
        session: !['get_launcher_info', 'start_session', 'end_session', 'get_launcher_capabilities'].includes(tool.name),
        full: false,
        readOnly: false,
        deferred: false,
      })
    }

    this.tools = tools
    this.capabilities = capabilities
    this.domains = groupByDomain(tools)
    this.loadedAt = Date.now()
    this.log(
      `catalog loaded: ${tools.length} upstream tools -> ${[...this.domains]
        .map(([id, list]) => `${id}:${list.length}`)
        .join(' ')}`,
    )
  }

  /**
   * 一个工具的能力；目录没加载时返回保守默认值。
   * @param {string} name
   * @returns {Capability}
   */
  capabilityOf(name) {
    return (
      this.capabilities?.get(name) ?? {
        session: true,
        full: false,
        readOnly: false,
        deferred: false,
      }
    )
  }

  /**
   * 某领域的工具列表。
   * @param {string} domainId
   */
  domainTools(domainId) {
    return this.domains?.get(domainId) ?? []
  }
}
