/**
 * 结果归一化：把上游那些不合规范的返回值收拾成 DSH 能吃的形状。
 *
 * 上游有三类麻烦：
 *   1. `structuredContent` 是数组（process_list、operations_list…）—— MCP 规范要求对象
 *   2. 业务错误塞在 `structuredContent.error` 里且 `isError` 为 false —— 模型看不出失败
 *   3. 图片走 base64 内联 —— DSH 侧要的是 attachment 引用
 *
 * @module dsh-plugin-axolotl/normalize
 */

/**
 * 数组包成 `{items: [...]}`，标量包成 `{value: ...}`。
 *
 * MCP 规范要求 `structuredContent` 是对象，但上游有十几个工具直接塞数组，
 * SDK 校验会判为非法并丢掉结果。包一层即可，数据一个不丢。
 *
 * @param {unknown} result
 * @returns {unknown}
 */
export function normalizeResult(result) {
  if (!result || typeof result !== 'object') return result
  const structured = /** @type {Record<string, unknown>} */ (result).structuredContent
  if (Array.isArray(structured)) {
    return { ...result, structuredContent: { items: structured } }
  }
  if (structured !== undefined && (typeof structured !== 'object' || structured === null)) {
    return { ...result, structuredContent: { value: structured } }
  }
  return result
}

/**
 * 上游把错误放在 `structuredContent.error` 里，`isError` 仍是 false。
 * 对模型来说这是「调用失败」，必须让它看见 —— 否则它会以为成功了继续往下做。
 *
 * @param {unknown} result normalizeResult 之后的结果
 * @returns {{ isError: boolean, code?: string, message?: string }}
 */
export function businessErrorOf(result) {
  if (!result || typeof result !== 'object') return { isError: false }
  const structured = /** @type {Record<string, unknown>} */ (result).structuredContent
  const error = structured?.error
  if (error === undefined || error === null) return { isError: false }
  if (typeof error === 'string') return { isError: true, message: error }
  if (typeof error === 'object') {
    const record = /** @type {Record<string, unknown>} */ (error)
    return {
      isError: true,
      code: typeof record.code === 'string' ? record.code : undefined,
      message: typeof record.message === 'string' ? record.message : JSON.stringify(record),
    }
  }
  return { isError: true, message: String(error) }
}

/**
 * 把上游/传输层的错误转成一句话。
 *
 * 上游把「参数校验失败」回成 JSON-RPC error（-32602），SDK 会抛 McpError。
 * 对模型来说那不是协议故障，而是「这次参数不对」—— 去掉重复的 `MCP error -32602: `
 * 前缀，让它能读到真正的原因。
 *
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  const raw = String(/** @type {{ message?: string }} */ (error)?.message ?? error)
  return raw.replace(/^(MCP error -?\d+:\s*)+/, '').trim()
}

/**
 * 从 MCP 结果里取出 structuredContent，没有就从 text 块里 JSON.parse。
 *
 * @param {unknown} result
 * @returns {any}
 */
export function structuredOf(result) {
  if (!result || typeof result !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (result)
  if (record.structuredContent !== undefined) return record.structuredContent
  const content = record.content
  if (Array.isArray(content)) {
    const text = content.find((block) => block?.type === 'text')?.text
    if (typeof text === 'string' && text.trim() !== '') {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
  }
  return undefined
}

/**
 * 从 MCP 结果里取出第一段文本。
 *
 * @param {unknown} result
 * @returns {string}
 */
export function textOf(result) {
  if (!result || typeof result !== 'object') return ''
  const content = /** @type {Record<string, unknown>} */ (result).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 列出结果里的图片块。
 *
 * @param {unknown} result
 * @returns {Array<{ data: string, mimeType: string }>}
 */
export function imagesOf(result) {
  if (!result || typeof result !== 'object') return []
  const content = /** @type {Record<string, unknown>} */ (result).content
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block?.type === 'image' && typeof block.data === 'string')
    .map((block) => ({ data: block.data, mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png' }))
}

/**
 * 把一段值压成一行，用于工具描述里的预览。
 *
 * @param {unknown} value
 * @param {number} [limit]
 */
export function firstLine(value, limit = 88) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}
