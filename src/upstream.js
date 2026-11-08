/**
 * 上游 MCP 客户端：把「美西螈启动器」当成一个 MCP 服务器来用。
 *
 * 这个模块解决的是**会话寿命**问题。启动器（Rust/rmcp 实现）每 15 秒通过独立 SSE 流
 * ping 一次客户端，10 秒内没应答就杀掉整个 MCP 会话 —— 之后所有调用都返回 404。
 * 官方 SDK 的 `StreamableHTTPClientTransport` 会自动应答 ping，前提是客户端对象一直活着。
 *
 * 所以这里代持一个常驻客户端，而不是每次调用新建连接：
 *   - 单飞（single-flight）建连，避免并发首调用开两条连接
 *   - 连接断了自动重连，并在上层重试一次
 *   - 上游不可达时给可读的中文错误，而不是 `fetch failed`
 *
 * @module dsh-plugin-axolotl/upstream
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * 上游有几个工具（process_list、operations_list…）把 structuredContent 直接塞成数组，
 * 而 SDK 的 CallToolResultSchema 要求它是对象，`client.callTool` 在本地校验时会把整个
 * 结果判为非法。这里绕开 SDK 校验自己发 `tools/call` —— 鸭子类型的 safeParse 就行。
 */
const LOOSE_RESULT = {
  safeParse(value) {
    return { success: true, data: value }
  },
}

/**
 * 从错误里挖出 HTTP 状态码。
 *
 * 踩过的坑：SDK 把状态码放在 `error.code`，**消息里只有一句空的**
 * `Streamable HTTP error: Error POSTing to endpoint: ` —— 所以拿正则去扫消息
 * 永远扫不到 401，认证失败会被误判成「会话没了」再去重连一次。
 *
 * @param {unknown} error
 * @returns {number | undefined}
 */
export function statusOf(error) {
  for (const candidate of [error?.code, error?.status, error?.statusCode, error?.cause?.status, error?.cause?.code]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate)
  }
  return undefined
}

/** 判断一个错误是不是「会话没了，重连就好」。 */
export function isSessionGone(error) {
  // 认证失败也表现为 "Error POSTing to endpoint"，但它重连一万次也没用 —— 先排掉
  if (statusOf(error) === 401 || statusOf(error) === 403) return false
  const text = String(error?.message ?? error)
  return /Error POSTing to endpoint|not connected|Connection closed|404|session/i.test(text)
}

/** 判断一个错误是不是「上游根本没连上」。 */
export function isUnreachable(error) {
  const text = String(error?.message ?? error)
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|not connected|Connection closed/i.test(text)
}

/**
 * 判断一个错误是不是「认证没过」。
 *
 * 启动器开了「要求身份验证」但没带令牌（或令牌错）时，握手阶段回 401/403。
 * 这类错误和「启动器没开」完全不同 —— 端口是通的，只是身份不对，
 * 提示必须能引导用户去填令牌，而不是让人去查启动器开没开。
 *
 * 状态码优先看 `error.code`（SDK 的真实位置），
 * 消息正则只是兜底：别的传输层实现可能把状态写进文本里。
 */
export function isUnauthorized(error) {
  const status = statusOf(error)
  if (status === 401 || status === 403) return true
  const text = String(error?.message ?? error)
  // 不带 \b 边界：`HTTP 401`、`401 Unauthorized`、`status=401` 都要认出来
  return /(?:^|\D)(401|403)(?:\D|$)|Unauthorized|Forbidden|invalid[_ ]token|missing[_ ]token/i.test(text)
}

/**
 * 一个上游连接。
 *
 * 用类而不是闭包，是为了让「重连」有明确的对象边界：旧实例被 `close()` 之后，
 * 持有它的调用方拿到的错误一定是干净的，不会和新建的连接串味。
 */
export class Upstream {
  /**
   * @param {{ url: string, token?: string, timeoutMs?: number, log?: (message: string) => void }} options
   */
  constructor(options) {
    this.url = options.url
    // 启动器开「要求身份验证」后，每个 HTTP 请求都要带 Bearer 令牌。
    // 空串等同于没配 —— 否则会发出一个空的 Authorization 头，反而更像错误请求。
    this.token = typeof options.token === 'string' && options.token !== '' ? options.token : undefined
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.log = options.log ?? (() => {})
    /** @type {{ client: Client, transport: StreamableHTTPClientTransport } | undefined} */
    this.connection = undefined
    /** @type {Promise<{ client: Client, transport: StreamableHTTPClientTransport }> | undefined} */
    this.connecting = undefined
    this.lastError = undefined
  }

  /** 当前是否连接着（不代表上游健康，只代表有活着的客户端对象）。 */
  get connected() {
    return this.connection !== undefined
  }

  /** 这次连接会不会带令牌。 */
  get authenticated() {
    return this.token !== undefined
  }

  /** 换令牌：断掉现有连接，下次调用用新令牌重连。 */
  setToken(token) {
    const next = typeof token === 'string' && token !== '' ? token : undefined
    if (next === this.token) return false
    this.token = next
    // 令牌变了，旧连接的身份就作废了 —— 必须重连
    void this.close()
    return true
  }

  /**
   * 建立一条新连接。
   * @returns {Promise<{ client: Client, transport: StreamableHTTPClientTransport }>}
   */
  async connect() {
    const headers = this.token === undefined ? {} : { Authorization: `Bearer ${this.token}` }
    const transport = new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers } })
    transport.onerror = (error) => this.log(`upstream transport error: ${String(error?.message ?? error)}`)
    const client = new Client({ name: 'dsh-plugin-axolotl', version: '0.1.0' }, { capabilities: {} })
    client.onclose = () => {
      this.log('upstream client closed')
      // 连接被对端关掉时清掉引用，下一次 ensure() 会重连
      if (this.connection?.client === client) this.connection = undefined
    }
    await client.connect(transport)
    this.log(`upstream connected url=${this.url} auth=${this.token === undefined ? 'none' : 'bearer'} session=${transport.sessionId}`)
    this.lastError = undefined
    this.resetSessionHook?.()
    return { client, transport }
  }

  /**
   * 确保有连接；并发调用共享同一次建连。
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{ client: Client, transport: StreamableHTTPClientTransport }>}
   */
  async ensure({ force = false } = {}) {
    if (force && this.connection !== undefined) {
      const stale = this.connection
      this.connection = undefined
      await stale.client.close().catch(() => {})
      this.log('upstream dropped for reconnect')
    }
    if (this.connection !== undefined) return this.connection
    if (this.connecting === undefined) {
      this.connecting = this.connect()
        .then((created) => {
          this.connection = created
          return created
        })
        .catch((error) => {
          this.lastError = String(error?.message ?? error)
          throw error
        })
        .finally(() => {
          this.connecting = undefined
        })
    }
    return this.connecting
  }

  /**
   * 调一个上游工具，返回未加工的结果。
   *
   * 走 `client.request` 而不是 `client.callTool`，原因见 {@link LOOSE_RESULT}。
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  async callRaw(name, args = {}) {
    const { client } = await this.ensure()
    return client.request({ method: 'tools/call', params: { name, arguments: args } }, LOOSE_RESULT)
  }

  /**
   * 调一个上游工具，`callRaw` 的便利包装。
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  async call(name, args = {}) {
    const result = await this.callRaw(name, args)
    return result
  }

  /** 列上游工具。 */
  async listTools() {
    const { client } = await this.ensure()
    const { tools } = await client.listTools()
    return tools
  }

  /** 关掉连接（插件卸载时调）。 */
  async close() {
    const current = this.connection
    this.connection = undefined
    if (current !== undefined) await current.client.close().catch(() => {})
  }

  /** 上游不可达时的可读错误文案。 */
  offlineMessage(detail) {
    return [
      `连不上美西螈启动器（${this.url}）：${detail}`,
      '多半是启动器没开，或者「设置 → MCP 服务器」里的启用开关关掉了。',
      '如果是刚打开「要求身份验证」，还要在插件设置里填上连接令牌。',
      '打开启动器后会自己重连，不用重启 DSH。',
    ].join('\n')
  }

  /**
   * 认证失败时的可读错误文案。
   *
   * 启动器开了「要求身份验证」而插件没配令牌（或配错了）时，握手被拒（HTTP 401）。
   * 这种错误的消息体是空的（启动器不回 body），单纯把消息丢给用户看不出该怎么办。
   */
  authMessage() {
    return [
      this.token === undefined
        ? '启动器拒绝了这次连接（HTTP 401）：没有带令牌。'
        : '启动器拒绝了这次连接（HTTP 401）：令牌不对或已失效。',
      '启动器开着「要求身份验证」，需要填写连接令牌：',
      '启动器 → 设置 → MCP 服务器 → 要求身份验证，旁边的令牌就是。',
      '在插件设置里填好，点「测试连接」，不用重启 DSH。',
    ].join('\n')
  }
}
