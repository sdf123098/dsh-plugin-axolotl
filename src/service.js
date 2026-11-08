/**
 * 服务层：工具与 HTTP 面板共用同一套调用逻辑，不各写一遍。
 *
 * 一次调用要处理的事，按发生顺序：
 *   1. 确保目录已加载（决定要不要补 session_id）
 *   2. 会话过期就关掉重开
 *   3. 补 session_id
 *   4. 调上游；失败时区分「会话没了」「上游没开」「业务拒绝」
 *   5. 归一化结果，并把图片转成 attachment 引用
 *
 * @module dsh-plugin-axolotl/service
 */

import { businessErrorOf, errorText, imagesOf, normalizeResult, structuredOf, textOf } from './normalize.js'
import { isSessionGone, isUnauthorized, isUnreachable } from './upstream.js'

/**
 * @typedef {{
 *   ok: boolean,
 *   value?: any,
 *   text?: string,
 *   images?: Array<{ data: string, mimeType: string }>,
 *   error?: string,
 *   code?: string,
 * }} CallOutcome
 */

export class AxolotlService {
  /**
   * @param {{
   *   upstream: import('./upstream.js').Upstream,
   *   catalog: import('./catalog.js').Catalog,
   *   session: import('./session.js').SessionManager,
   *   requireApproval: boolean,
   *   log?: (message: string) => void,
   *   onCatalogReady?: () => void,
   * }} options
   */
  constructor(options) {
    this.upstream = options.upstream
    this.catalog = options.catalog
    this.session = options.session
    this.requireApproval = options.requireApproval
    this.log = options.log ?? (() => {})
    /** 目录首次加载完成时回调，用于补注册领域工具（注册是同步的，不能塞进 load）。 */
    this.onCatalogReady = options.onCatalogReady ?? (() => {})
  }

  /**
   * 确保目录已加载，首次就绪时触发一次回调。
   *
   * 回调必须是**幂等**的：`status()` 与普通调用都可能撞上「第一次」，
   * 谁先到谁触发，两边都会调。
   */
  async ensureCatalog() {
    const first = !this.catalog.ready
    await this.catalog.load()
    if (first && this.catalog.ready) this.onCatalogReady()
  }

  /**
   * 调一个上游工具，返回归一化后的结果。
   *
   * 不抛异常：所有失败都折成 `{ ok: false, error }`，让工具侧统一渲染成
   * `isError` 结果。这样模型能读到原因，DSH 侧也不会看到异常。
   *
   * @param {string} name 上游工具名
   * @param {Record<string, unknown>} args
   * @param {{ allowRetry?: boolean }} [options]
   * @returns {Promise<CallOutcome>}
   */
  async call(name, args = {}, options = {}) {
    const allowRetry = options.allowRetry !== false
    try {
      await this.ensureCatalog()
    } catch (error) {
      // 目录加载失败不阻断：按保守默认值（需要会话）继续，真连不上下面会给出可读错误
      this.log(`catalog load failed during ${name}: ${errorText(error)}`)
    }

    /** @type {Record<string, unknown>} */
    const payload = { ...args }
    const capability = this.catalog.capabilityOf(name)

    try {
      if (capability.session) {
        payload.session_id = await this.session.ensure()
      }

      const raw = await this.upstream.call(name, payload)
      this.session.touch()

      const normalized = normalizeResult(raw)
      const businessError = businessErrorOf(normalized)
      if (businessError.isError) {
        return {
          ok: false,
          error: businessError.message ?? '上游返回了错误',
          code: businessError.code,
          value: structuredOf(normalized),
        }
      }

      return {
        ok: true,
        value: structuredOf(normalized),
        text: textOf(normalized),
        images: imagesOf(normalized),
      }
    } catch (error) {
      const message = errorText(error)

      // 认证失败要排在断线前面判断：401 也可能带 "Connection closed" 字样，
      // 而这两种情况的处置完全不同（一个去填令牌，一个去开启动器）。
      if (isUnauthorized(error)) {
        return { ok: false, error: this.upstream.authMessage(), code: 'unauthorized' }
      }

      if (allowRetry && isSessionGone(error)) {
        this.log(`call ${name} lost the session (${message}); reconnecting and retrying once`)
        await this.session.close('session lost')
        await this.upstream.ensure({ force: true }).catch(() => {})
        await this.catalog.load({ force: true }).catch(() => {})
        return this.call(name, args, { allowRetry: false })
      }

      if (isUnreachable(error)) {
        return { ok: false, error: this.upstream.offlineMessage(message), code: 'offline' }
      }

      return { ok: false, error: message }
    }
  }

  /** 速览：版本、连接、会话、各领域工具数、运行中的实例。 */
  async status() {
    await this.ensureCatalog().catch(() => {})
    const info = await this.call('get_launcher_info', {}, { allowRetry: false }).catch(() => ({ ok: false }))
    const counts = [...(this.catalog.domains ?? new Map())]
      .map(([id, list]) => `${id}=${list.length}`)
      .join('  ')

    return {
      launcher: info.ok === true ? info.value ?? {} : undefined,
      upstreamUrl: this.upstream.url,
      authenticated: this.upstream.authenticated,
      connected: this.upstream.connected,
      lastError: this.upstream.lastError,
      controlSession: this.session.id ?? null,
      upstreamTools: this.catalog.tools?.length ?? 0,
      domains: counts,
    }
  }
}
