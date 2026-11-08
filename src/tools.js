/**
 * 模型侧工具：11 个（9 个领域 + status + raw）。
 *
 * 设计取舍：**不把 269 个上游工具摊平成 269 个 DSH 工具**。理由：
 *   - `tools/list` 的完整 schema 约 195 KB，全量进系统提示会挤掉真正的工作内容
 *   - 上游 beta 会加工具，摊平就得跟着改注册表
 *
 * 收成领域工具之后，每个工具的描述里只列 op 名字（约 9 KB 总量）。需要精确参数时
 * 用 `op: 'help'` 现查 —— 这一步的代价（一次工具调用）远小于把 195 KB 常驻上下文。
 *
 * @module dsh-plugin-axolotl/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { DOMAINS, helpFor, suggestOps } from './domains.js'

/** 图片值的 schema，与 DSH 内建 `read_image` 的 IMAGE_VALUE_SCHEMA 对齐。 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

/** 所有领域工具共用的输出 schema。 */
const DOMAIN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: '给模型看的可读文本' },
    payload: { type: 'json', description: '上游返回的原始结构化数据' },
    images: {
      type: 'array',
      items: IMAGE_VALUE_SCHEMA,
      description: '上游返回的图片（截图、皮肤纹理），已转成附件引用',
    },
  },
}

/**
 * 把上游结果格式化成可读文本。
 *
 * 优先用上游自带的 text 块（它的排版比 JSON 好看），没有就 JSON 美化。
 * 太长要截断 —— 一个操作记录列表可能有几百行，全塞给模型没意义。
 *
 * @param {{ text?: string, value?: unknown }} outcome
 * @param {number} [limit]
 */
function formatOutcome(outcome, limit = 8000) {
  const raw = outcome.text !== undefined && outcome.text.trim() !== ''
    ? outcome.text
    : outcome.value === undefined
      ? '(上游没有返回内容)'
      : JSON.stringify(outcome.value, null, 2)
  if (raw.length <= limit) return raw
  return `${raw.slice(0, limit)}\n… (还有 ${raw.length - limit} 个字符，用 axolotl_raw 或收窄参数再看)`
}

/**
 * 把上游 base64 图片转成 DSH 附件引用。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Array<{ data: string, mimeType: string }>} images
 */
async function toAttachments(ctx, images) {
  if (images.length === 0) return []
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return []
  const refs = []
  for (const [index, image] of images.entries()) {
    try {
      const ref = await attachments.saveImage({
        data: Buffer.from(image.data, 'base64'),
        mediaType: image.mimeType,
        name: `axolotl-${Date.now()}-${index + 1}.${image.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
      })
      refs.push({
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      })
    } catch (error) {
      ctx.logger?.warn?.(`axolotl: 图片转附件失败：${String(/** @type {{ message?: string }} */ (error)?.message ?? error)}`)
    }
  }
  return refs
}

/**
 * 单个领域工具的定义。
 *
 * @param {{ id: string, label: string }} domain
 * @param {{ service: import('./service.js').AxolotlService, catalog: import('./catalog.js').Catalog, ctx: any }} options
 */
function domainTool(domain, { service, catalog, ctx }) {
  const tools = catalog.domainTools(domain.id)
  const names = tools.map((tool) => tool.name)
  const preview = names.length === 0 ? '' : `可选 op：${names.slice(0, 400).join(', ')}${names.length > 400 ? ' …' : ''}。`

  return defineTool({
    name: `axolotl_${domain.id}`,
    description:
      `${domain.label}。op 就是启动器的上游工具名；参数放 args（对象）。`
      + ` 传 op="help" 返回每个 op 的完整说明与必填参数。${preview}`,
    parameters: {
      op: { type: 'string', required: true, description: '上游工具名，或 help' },
      args: { type: 'json', description: '该 op 的参数对象；instance_id / session_id 会自动补' },
      instance_id: { type: 'string', description: '便捷写法：等价于 args.instance_id' },
    },
    output: {
      schema: DOMAIN_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: value.text }]
        for (const image of value.images ?? []) {
          blocks.push({ type: 'image', attachment: image })
        }
        return blocks
      },
    },
    async execute(args) {
      const op = String(args.op ?? '').trim()

      if (op === '' || op === 'help') {
        return {
          text: `${domain.label}\n${helpFor(catalog.domainTools(domain.id))}`,
          images: [],
        }
      }

      const known = catalog.domainTools(domain.id).find((tool) => tool.name === op)
      if (known === undefined) {
        const suggestions = suggestOps(op, DOMAINS.flatMap((entry) => catalog.domainTools(entry.id)))
        const hint = suggestions.length > 0 ? `\n\n可能想要：${suggestions.join(', ')}` : ''
        return {
          text:
            `op "${op}" 不在「${domain.label}」里。可用：\n`
            + `${catalog.domainTools(domain.id).map((tool) => tool.name).join(', ')}${hint}`,
          images: [],
        }
      }

      const payload = typeof args.args === 'object' && args.args !== null ? { ...args.args } : {}
      if (typeof args.instance_id === 'string' && payload.instance_id === undefined) {
        payload.instance_id = args.instance_id
      }

      const outcome = await service.call(op, payload)
      if (!outcome.ok) {
        throw new Error(outcome.error ?? '上游调用失败')
      }

      const images = await toAttachments(ctx, outcome.images ?? [])
      const text = formatOutcome(outcome)

      return {
        text,
        payload: outcome.value,
        ...(images.length === 0 ? {} : { images }),
      }
    },
  })
}

/**
 * 状态速览工具：不需要授权、不占控制会话也能回答「连上了没」。
 *
 * @param {{ service: import('./service.js').AxolotlService }} options
 */
function statusTool({ service }) {
  return defineTool({
    name: 'axolotl_status',
    description:
      '启动器状态速览：版本、是否连上、控制会话、各领域工具数。'
      + ' 启动器打不开或工具报错时先调这个，它给出的是诊断信息而不是业务结果。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          connected: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const status = await service.status()
      const launcher = status.launcher
      const lines = [
        launcher === undefined
          ? 'launcher: 未知（连不上）'
          : `launcher: ${launcher.name ?? '?'} ${launcher.version ?? '?'} (${launcher.platform ?? '?'})`,
        `upstream: ${status.upstreamUrl} ${status.connected ? 'connected' : 'not connected'}`
          + `${status.lastError === undefined ? '' : ` (${status.lastError})`}`,
        `control session: ${status.controlSession ?? 'none'}`,
        `upstream tools: ${status.upstreamTools}  ${status.domains}`,
      ]
      return { text: lines.join('\n'), connected: status.connected }
    },
  })
}

/**
 * 逃生口：按原名调任意上游工具。
 *
 * @param {{ service: import('./service.js').AxolotlService, catalog: import('./catalog.js').Catalog, ctx: any }} options
 */
function rawTool({ service, catalog, ctx }) {
  return defineTool({
    name: 'axolotl_raw',
    description:
      '逃生口：直接用启动器的上游工具名调用任意工具（269 个都能用），用于领域工具里没列到、'
      + '或需要精确掌握参数的情况。传 tool="list" 列出全部上游工具名。',
    parameters: {
      tool: { type: 'string', required: true, description: '上游工具名，或 list' },
      args: { type: 'json', description: '参数对象；session_id 会自动补' },
    },
    output: {
      schema: DOMAIN_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: value.text }]
        for (const image of value.images ?? []) blocks.push({ type: 'image', attachment: image })
        return blocks
      },
    },
    async execute(args) {
      const tool = String(args.tool ?? '').trim()
      if (tool === '' || tool === 'list') {
        await catalog.load().catch(() => {})
        return {
          text: (catalog.tools ?? []).map((entry) => entry.name).join('\n'),
          images: [],
        }
      }
      const payload = typeof args.args === 'object' && args.args !== null ? args.args : {}
      const outcome = await service.call(tool, payload)
      if (!outcome.ok) throw new Error(outcome.error ?? '上游调用失败')
      const images = await toAttachments(ctx, outcome.images ?? [])
      return {
        text: formatOutcome(outcome, 12000),
        payload: outcome.value,
        ...(images.length === 0 ? {} : { images }),
      }
    },
  })
}

/**
 * 注册全部工具。
 *
 * 分两个阶段，因为注册表不允许同名重复注册，而领域工具的划分依赖上游目录：
 *   - 阶段一（同步）：status + raw。目录没到也能用，至少能诊断「为什么连不上」
 *   - 阶段二（目录就绪后）：9 个领域工具
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ service: import('./service.js').AxolotlService, catalog: import('./catalog.js').Catalog, exposeRawTool: boolean }} options
 * @returns {string[]} 注册的工具名
 */
export function registerBaseTools(ctx, options) {
  const registered = []
  const context = { ...options, ctx }

  ctx.tools.register(statusTool(context))
  registered.push('axolotl_status')

  if (options.exposeRawTool) {
    ctx.tools.register(rawTool(context))
    registered.push('axolotl_raw')
  }

  return registered
}

/**
 * 注册 9 个领域工具。必须在目录加载之后调，且只调一次。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ service: import('./service.js').AxolotlService, catalog: import('./catalog.js').Catalog }} options
 * @returns {string[]} 注册的工具名
 */
export function registerDomainTools(ctx, options) {
  const registered = []
  const context = { ...options, ctx }
  for (const domain of DOMAINS) {
    if (options.catalog.domainTools(domain.id).length === 0) continue
    ctx.tools.register(domainTool(domain, context))
    registered.push(`axolotl_${domain.id}`)
  }
  return registered
}

export { formatOutcome }

