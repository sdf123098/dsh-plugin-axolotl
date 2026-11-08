/**
 * 插件入口。
 *
 * 挂载顺序有讲究：
 *   1. 先建上游客户端与目录（不 await —— 启动器没开时不能让 DSH 卡住）
 *   2. 注册工具时目录可能是空的，`applyTools` 用「先探测一次」来兜
 *   3. webServer 是**可选**的：纯 CLI profile 里没有它，插件应当照常激活
 *
 * @module dsh-plugin-axolotl
 */

import { readFileSync } from 'node:fs'

import { installApprovalGate } from './approval.js'
import { Catalog } from './catalog.js'
import { Config, DEFAULTS } from './config.js'
import { AxolotlService } from './service.js'
import { SessionManager } from './session.js'
import { maskToken, mergeConfig, readOverrides, writeOverrides } from './store.js'
import { registerBaseTools, registerDomainTools } from './tools.js'
import { Upstream, isUnauthorized, isUnreachable } from './upstream.js'
import { errorText } from './normalize.js'

export { Config }

/** Cordis 插件名。 */
export const name = 'axolotl-host'

/**
 * 必需服务：工具注册表。
 *
 * `attachments` 不在这里 —— 它只在需要直出图片时才用，缺失时降级为「只返回路径」；
 * 写进 inject 会让没有附件存储的 profile 整个加载失败。
 */
export const inject = ['tools']

/** 从 package.json 读版本，避免面板显示和实际装的不一致。 */
function readVersion() {
  try {
    const url = new URL('../package.json', import.meta.url)
    return String(JSON.parse(readFileSync(url, 'utf8')).version)
  } catch {
    return '0.0.0-unknown'
  }
}

const VERSION = readVersion()

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  // 三层合并：内置默认 ← patch 行的部署配置 ← 设置页写入的用户覆盖。
  // 这样用户改过的东西能活过重启，而部署方在 patch 里定的基线不会被插件覆写。
  const config = mergeConfig(DEFAULTS, rawConfig, readOverrides())
  const log = (message) => ctx.logger?.info?.(`[axolotl] ${message}`) ?? console.log(`[axolotl] ${message}`)

  const upstream = new Upstream({
    url: config.upstreamUrl,
    token: config.authToken,
    timeoutMs: config.toolCallTimeoutMs,
    log,
  })
  const catalog = new Catalog({ upstream, log })
  const session = new SessionManager({
    upstream,
    policy: config.sessionPolicy,
    idleMs: config.sessionIdleMs,
    retryMs: config.sessionRetryMs,
    log,
  })
  let domainsRegistered = false
  const service = new AxolotlService({
    upstream,
    catalog,
    session,
    requireApproval: config.requireApproval,
    log,
    // 目录首次就绪时补注册领域工具。注册是同步的，不能塞进 catalog.load()，
    // 所以由 service 在「第一次加载成功」时回调。幂等：只补一次。
    onCatalogReady: () => {
      if (domainsRegistered) return
      domainsRegistered = true
      const domains = registerDomainTools(ctx, { service, catalog })
      log(`catalog ready, +${domains.length} domain tool(s): ${domains.join(', ')}`)
    },
  })

  // 工具注册是同步的，但领域划分依赖上游目录。这里先同步注册 status + raw
  // （它们不依赖目录），再异步补领域工具 —— 目录一到就补上。
  //
  // 代价是插件激活后的头几百毫秒只有 2 个工具。可以接受：注册表变化会 emit
  // `tools/change`，DSH 下一次组装提示词就能看到完整工具集。
  const base = registerBaseTools(ctx, {
    service,
    catalog,
    exposeRawTool: config.exposeRawTool,
  })
  log(`registered ${base.length} base tool(s): ${base.join(', ')}`)

  // 审批闸门：需要完全访问权限的写操作走 DSH 自己的审批流。
  // 注册在工具注册之后没关系 —— 闸门按工具名匹配，与注册顺序无关。
  const disposeGate = installApprovalGate(ctx, { catalog, requireApproval: config.requireApproval, log })
  ctx.effect(() => disposeGate, 'axolotl: approval gate')

  ctx.effect(() => {
    let disposed = false
    void (async () => {
      if (!config.autoConnect) return
      try {
        await catalog.load()
        if (disposed) return
        // 目录就绪 → service 的回调会补注册领域工具；这里只是触发一次
        service.onCatalogReady()
      } catch (error) {
        log(`initial connect failed (will retry on first call): ${String(/** @type {{ message?: string }} */ (error)?.message ?? error)}`)
      }
    })()
    return () => {
      disposed = true
    }
  }, 'axolotl: initial connect')

  // 空闲巡检：定时把闲置的控制会话还给启动器。启动器同一时刻只认一个会话，
  // 不及时还的话用户在启动器界面上点不动「AI 已连接」。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void session.reapIfIdle()
    }, Math.max(30_000, Math.min(60_000, Math.floor(config.sessionIdleMs / 4))))
    // unref：巡检定时器不该让宿主进程活着。DSH 主进程有自己的生命周期，
    // 但测试、脚本、短命 profile 里没有 unref 就会永远挂住不退。
    timer.unref?.()
    return () => {
      clearInterval(timer)
    }
  }, 'axolotl: session reaper')

  // 卸载时把会话还回去，否则启动器会一直显示「AI 已连接」直到心跳超时
  ctx.effect(() => () => {
    void session.close('plugin unloading')
  }, 'axolotl: session cleanup')

  // 设置页 / 面板用的 HTTP 路由。webServer 是可选的：纯 CLI profile 里没有它。
  ctx.effect(() => {
    const mount = (scoped) => {
      const webServer = scoped?.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') return undefined
      return webServer.register({
        kind: 'prefix',
        path: '/axolotl/api',
        handler: async (req, res) => {
          await handleApi(req, res, { service, catalog, session, config, upstream, version: VERSION })
        },
      })
    }
    if (typeof ctx.inject === 'function') {
      return ctx.inject(['webServer'], (scoped) => mount(scoped))
    }
    try {
      return mount(ctx)
    } catch {
      return undefined
    }
  }, 'axolotl: /axolotl/api routes')

  log(`host ready (${VERSION}) — upstream ${config.upstreamUrl}, session policy ${config.sessionPolicy}`)
}

/**
 * `/axolotl/api` 的请求处理。
 *
 * 方法表与工具共用同一个 service，面板看到的数据和模型看到的一致。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, any>} deps
 */
async function handleApi(req, res, deps) {
  const write = (status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  const { pathname } = new URL(req.url ?? '/', 'http://dsh.internal')
  const method = pathname.startsWith('/axolotl/api/') ? pathname.slice('/axolotl/api/'.length) : ''

  if (req.method === 'GET' && method === 'ping') {
    write(200, { ok: true, version: deps.version, pid: process.pid })
    return
  }
  if (req.method === 'GET' && method === 'status') {
    try {
      write(200, { ok: true, result: await deps.service.status() })
    } catch (error) {
      write(500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
    }
    return
  }
  if (req.method === 'GET' && method === 'config') {
    write(200, { ok: true, result: publicConfig(deps.config) })
    return
  }
  if (req.method !== 'POST') {
    write(405, { ok: false, error: { code: 'method', message: 'use POST' } })
    return
  }

  const body = await readJson(req)
  if (body === undefined) {
    write(400, { ok: false, error: { code: 'bad-request', message: 'body must be JSON' } })
    return
  }

  try {
    switch (method) {
      case 'test': {
        const result = await testConnection(deps, body)
        write(200, { ok: true, result })
        return
      }
      case 'config.set': {
        const patch = body?.patch
        if (patch === null || typeof patch !== 'object') {
          write(400, { ok: false, error: { code: 'bad-request', message: 'patch must be an object' } })
          return
        }
        const saved = writeOverrides(patch)
        if (!saved.ok) {
          write(500, { ok: false, error: { code: 'write-failed', message: saved.error } })
          return
        }
        const applied = applyConfigPatch(deps, patch)
        write(200, { ok: true, result: { config: publicConfig(deps.config), applied } })
        return
      }
      case 'connect': {
        await deps.catalog.load({ force: true })
        write(200, {
          ok: true,
          result: {
            connected: deps.upstream.connected,
            authenticated: deps.upstream.authenticated,
            tools: deps.catalog.tools?.length ?? 0,
          },
        })
        return
      }
      case 'disconnect': {
        await deps.session.close('user requested')
        await deps.upstream.close()
        write(200, { ok: true, result: { connected: false } })
        return
      }
      case 'session.open': {
        const id = await deps.session.ensure()
        write(200, { ok: true, result: { sessionId: id } })
        return
      }
      case 'session.close': {
        await deps.session.close('user requested')
        write(200, { ok: true, result: { sessionId: null } })
        return
      }
      case 'catalog':
        write(200, {
          ok: true,
          result: {
            tools: (deps.catalog.tools ?? []).map((tool) => tool.name),
            domains: Object.fromEntries(
              [...(deps.catalog.domains ?? new Map())].map(([id, list]) => [id, list.map((t) => t.name)]),
            ),
          },
        })
        return
      default:
        write(404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
    }
  } catch (error) {
    write(500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
  }
}

/**
 * 读请求体，最多 1 MB。JSON 解析失败返回 undefined。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1024 * 1024) {
        resolve(undefined)
        req.destroy()
      }
    })
    req.on('end', () => {
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * 给前端的配置视图。
 *
 * 令牌**永远不回显真值**：设置页只需要知道「配没配」和「改/清」，
 * 把原文送到浏览器意味着它会出现在 DOM、devtools 和任何一次抓包里。
 *
 * @param {Record<string, any>} config
 */
function publicConfig(config) {
  const { authToken, ...rest } = config
  return { ...rest, auth: maskToken(authToken) }
}

/**
 * 把设置页改的配置立刻应用到运行中的组件。
 *
 * 有些项改了必须重连（地址、令牌），有些只影响下一次调用（超时、工具集）。
 * 返回值告诉前端哪些当场生效了。
 *
 * @param {Record<string, any>} deps
 * @param {Record<string, any>} patch
 * @returns {string[]}
 */
function applyConfigPatch(deps, patch) {
  const applied = []

  if (typeof patch.upstreamUrl === 'string' && patch.upstreamUrl !== deps.upstream.url) {
    deps.upstream.url = patch.upstreamUrl
    deps.config.upstreamUrl = patch.upstreamUrl
    void deps.upstream.close()
    applied.push('upstreamUrl')
  }

  if ('authToken' in patch) {
    const changed = deps.upstream.setToken(patch.authToken)
    deps.config.authToken = patch.authToken === '' ? undefined : patch.authToken
    if (changed) applied.push('authToken')
  }

  if (typeof patch.sessionPolicy === 'string') {
    deps.session.policy = patch.sessionPolicy
    deps.config.sessionPolicy = patch.sessionPolicy
    applied.push('sessionPolicy')
  }
  if (typeof patch.sessionIdleMs === 'number') {
    deps.session.idleMs = patch.sessionIdleMs
    deps.config.sessionIdleMs = patch.sessionIdleMs
    applied.push('sessionIdleMs')
  }
  if (typeof patch.sessionRetryMs === 'number') {
    deps.session.retryMs = patch.sessionRetryMs
    deps.config.sessionRetryMs = patch.sessionRetryMs
    applied.push('sessionRetryMs')
  }
  if (typeof patch.toolCallTimeoutMs === 'number') {
    deps.upstream.timeoutMs = patch.toolCallTimeoutMs
    deps.config.toolCallTimeoutMs = patch.toolCallTimeoutMs
    applied.push('toolCallTimeoutMs')
  }
  if (typeof patch.autoConnect === 'boolean') {
    deps.config.autoConnect = patch.autoConnect
    applied.push('autoConnect')
  }
  if (typeof patch.requireApproval === 'boolean') {
    deps.service.requireApproval = patch.requireApproval
    deps.config.requireApproval = patch.requireApproval
    applied.push('requireApproval')
  }
  // exposeRawTool 需要重新注册工具，不能热改 —— 如实告诉前端
  if (typeof patch.exposeRawTool === 'boolean') {
    deps.config.exposeRawTool = patch.exposeRawTool
    applied.push('exposeRawTool(需重启 DSH 生效)')
  }

  return applied
}

/**
 * 测试连接：用给定（或当前）的地址与令牌握一次手。
 *
 * 不复用现有连接 —— 用户点「测试」就是想验**这组新参数**能不能用，
 * 拿旧连接回一句「通的」毫无意义。
 *
 * @param {Record<string, any>} deps
 * @param {{ upstreamUrl?: string, authToken?: string }} body
 */
async function testConnection(deps, body) {
  const url = typeof body?.upstreamUrl === 'string' && body.upstreamUrl !== '' ? body.upstreamUrl : deps.upstream.url
  // 前端传空串表示「用已保存的令牌」；传 null 表示「按无令牌测」
  const token = body?.authToken === null
    ? undefined
    : typeof body?.authToken === 'string' && body.authToken !== ''
      ? body.authToken
      : deps.upstream.token

  const probe = new Upstream({ url, token, log: () => {} })
  const started = Date.now()
  try {
    const tools = await probe.listTools()
    return {
      ok: true,
      url,
      authenticated: probe.authenticated,
      toolCount: tools.length,
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    const message = errorText(error)
    return {
      ok: false,
      url,
      authenticated: probe.authenticated,
      elapsedMs: Date.now() - started,
      reason: isUnauthorized(error) ? 'unauthorized' : isUnreachable(error) ? 'offline' : 'failed',
      message: isUnauthorized(error)
        ? probe.authMessage()
        : isUnreachable(error)
          ? probe.offlineMessage(message)
          : message,
    }
  } finally {
    await probe.close()
  }
}
