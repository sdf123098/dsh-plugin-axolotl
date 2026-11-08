/**
 * 配置：插件侧设置页的字段定义与默认值。
 *
 * 用 schemastery（DSH 宿主自带）而不是手写校验，有两个好处：
 *   1. 设置页的控件由 schema 生成，不用两边各写一份
 *   2. 非法值在加载期就报错，而不是等到调用时才炸
 *
 * @module dsh-plugin-axolotl/config
 */

import z from '@deepseek-ai/schemastery'

/** 控制会话开法的三种策略。 */
export const SESSION_POLICIES = ['auto', 'persistent', 'manual']

/** 部署配置默认值；patch 行的 `config` 会覆盖同名项。 */
export const DEFAULTS = {
  upstreamUrl: 'http://127.0.0.1:5219/mcp',
  authToken: undefined,
  autoConnect: true,
  sessionPolicy: 'auto',
  sessionIdleMs: 15 * 60 * 1000,
  sessionRetryMs: 45_000,
  exposeRawTool: true,
  requireApproval: true,
  toolCallTimeoutMs: 120_000,
}

/**
 * 插件配置 schema。
 *
 * `.default()` 让每一项都可以省略；`.description()` 是设置页显示给用户的文案。
 */
export const Config = z.object({
  upstreamUrl: z
    .string()
    .default(DEFAULTS.upstreamUrl)
    .description('美西螈启动器内置 MCP 的地址。默认 http://127.0.0.1:5219/mcp，换端口时改这里。'),

  authToken: z
    .string()
    .default('')
    .description(
      '连接令牌。启动器的「设置 → MCP 服务器 → 要求身份验证」打开后，客户端必须带上它。'
        + '在插件设置页里填，会以 Bearer 头随每次请求发送；留空表示不用。',
    ),

  autoConnect: z
    .boolean()
    .default(DEFAULTS.autoConnect)
    .description('DSH 启动时自动连接启动器。关掉后工具仍会出现，但首次调用才连。'),

  sessionPolicy: z
    .union(SESSION_POLICIES)
    .default(DEFAULTS.sessionPolicy)
    .description(
      '控制会话策略。auto：按需开关（推荐）；persistent：一直持有，响应更快但会占着启动器的「AI 已连接」；'
        + 'manual：不自动开会话，需要你先在别处授权。',
    ),

  sessionIdleMs: z
    .number()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .default(DEFAULTS.sessionIdleMs)
    .description('控制会话闲置多久后自动关闭。启动器同一时刻只认一个会话，及时关掉别人才能连。'),

  sessionRetryMs: z
    .number()
    .min(0)
    .max(5 * 60 * 1000)
    .default(DEFAULTS.sessionRetryMs)
    .description(
      '撞上「另一个控制会话占用」时最多等多久。启动器要等心跳超时（约 30 秒）才释放旧会话，'
        + '所以这个值别低于 35 秒，否则刚重启 DSH 的头半分钟会一直失败。',
    ),

  exposeRawTool: z
    .boolean()
    .default(DEFAULTS.exposeRawTool)
    .description('是否注册 axolotl_raw 逃生口。关掉后只能用 9 个领域工具，上下文更省。'),

  requireApproval: z
    .boolean()
    .default(DEFAULTS.requireApproval)
    .description(
      '需要完全访问权限的写操作（删实例、删存档、改设置、装 Java）是否走 DSH 审批。'
        + '关掉就完全交给启动器自己的权限模型。注意：审批策略是 never 的会话里不会真的问。',
    ),

  toolCallTimeoutMs: z
    .number()
    .min(1_000)
    .max(30 * 60 * 1000)
    .default(DEFAULTS.toolCallTimeoutMs)
    .description('单次上游调用超时。下载、安装这类操作会返回 operation_id 让你轮询，不占这个超时。'),
})

/**
 * 把 patch 行传下来的配置与默认值合并。
 * @param {Record<string, unknown> | undefined} raw
 * @returns {Record<string, unknown>}
 */
export function resolveConfig(raw) {
  const merged = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value !== undefined && key in DEFAULTS) merged[key] = value
  }
  return merged
}
