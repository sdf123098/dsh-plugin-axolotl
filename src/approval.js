/**
 * 审批接入：把「需要完全访问权限」的写操作接到 DSH 的审批流上。
 *
 * 为什么值得做：启动器自己有权限模型，但它的「完全访问模式」是一个全局开关 ——
 * 打开之后删实例、删存档、改设置全都不再问。DSH 这边的审批是**按次**的，
 * 用户能在删之前看到「这次要删什么」。
 *
 * 实现方式：`tools/pre-execute` 是 DSH 的工具执行前闸门，返回 `{kind:'ask'}`
 * 就会走公用的审批通道（`approval.request`）。这里只在两个条件都满足时 ask：
 *   1. 插件配置 `requireApproval` 开着
 *   2. 当前会话的审批策略不是 `never`（用户已经明确关掉审批时再问是骚扰）
 *
 * @module dsh-plugin-axolotl/approval
 */

/** 危险措辞：这些 op 的审批文案要说清楚操作后果，不能只报工具名。 */
const INTENT = [
  { pattern: /^instance_delete$/, verb: '永久删除这个实例及其全部存档、快照备份' },
  { pattern: /^instance_reinstall$/, verb: '重装这个实例（会重新下载并覆盖核心文件）' },
  { pattern: /^instance_duplicate$/, verb: '复制一份实例（会占用磁盘空间）' },
  { pattern: /^instance_execute_upgrade$/, verb: '按升级方案改写这个实例的内容' },
  { pattern: /^instance_execute_import$/, verb: '把导入方案写入这个实例' },
  { pattern: /^instance_group_delete$/, verb: '删除这个实例分组' },
  { pattern: /^world_delete$/, verb: '永久删除这个存档' },
  { pattern: /^world_backup$/, verb: '为这个存档创建备份' },
  { pattern: /^world_rename$/, verb: '重命名这个存档' },
  { pattern: /^world_update_settings$/, verb: '改写这个存档的游戏规则与设置' },
  { pattern: /^content_remove$/, verb: '从实例里移除这个内容' },
  { pattern: /^content_set_enabled$/, verb: '启用/停用这个内容' },
  { pattern: /^file_trash$/, verb: '把文件移入回收站' },
  { pattern: /^file_write$/, verb: '写入文件（覆盖原内容）' },
  { pattern: /^file_move$/, verb: '移动文件' },
  { pattern: /^file_copy$/, verb: '复制文件' },
  { pattern: /^nbt_patch$/, verb: '改写 NBT 数据' },
  { pattern: /^backup_restore$/, verb: '用备份覆盖当前实例内容' },
  { pattern: /^backup_delete_snapshot$/, verb: '永久删除一个备份快照' },
  { pattern: /^server_delete$/, verb: '永久删除这个服务器及其文件' },
  { pattern: /^server_kill$/, verb: '强制结束服务器进程' },
  { pattern: /^server_console_send$/, verb: '向服务器控制台发送命令' },
  { pattern: /^java_install$/, verb: '下载并安装 Java 运行时' },
  { pattern: /^java_remove_registration$/, verb: '注销一个 Java 运行时' },
  { pattern: /^settings_patch$/, verb: '修改启动器设置' },
  { pattern: /^launcher_restart$/, verb: '重启启动器' },
  { pattern: /^launcher_exit$/, verb: '退出启动器' },
  { pattern: /^resource_execute_plan$/, verb: '执行内容安装方案' },
  { pattern: /^resource_execute_changes$/, verb: '批量改动实例内容' },
  { pattern: /^resource_history_rollback$/, verb: '回滚内容历史' },
  { pattern: /^modpack_execute_install$/, verb: '安装整合包（会大量写入磁盘）' },
  { pattern: /^account_remove$/, verb: '移除这个账号' },
  { pattern: /^skin_delete$/, verb: '删除这个皮肤' },
  { pattern: /^screenshot_delete$/, verb: '删除截图文件' },
  { pattern: /^database_backup$/, verb: '备份启动器数据库' },
  { pattern: /^database_copy_channel$/, verb: '在发布通道之间复制数据库' },
  { pattern: /^storage_clean_metadata$/, verb: '清理元数据缓存' },
  { pattern: /^core_remove_component$/, verb: '移除核心组件' },
  { pattern: /^core_replace_jar$/, verb: '替换核心 JAR' },
]

/**
 * 给一个 op 编一句能读的审批理由。
 *
 * @param {string} op 上游工具名
 * @param {Record<string, unknown>} args
 * @param {{ instanceId?: string }} [context]
 * @returns {string}
 */
export function describeIntent(op, args = {}, context = {}) {
  const intent = INTENT.find((entry) => entry.pattern.test(op))
  const verb = intent?.verb ?? '执行一个需要完全访问权限的写操作'
  const target = args.instance_id ?? context.instanceId
  const bits = []
  if (typeof target === 'string' && target !== '') bits.push(`实例 ${target}`)
  for (const key of ['world_id', 'path', 'name', 'entry_id', 'server_id', 'file_name']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') bits.push(`${key}=${value}`)
  }
  const suffix = bits.length > 0 ? `（${bits.join('，')}）` : ''
  return `${verb}：${op}${suffix}`
}

/**
 * 注册执行前闸门。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   catalog: import('./catalog.js').Catalog,
 *   requireApproval: boolean,
 *   log?: (message: string) => void,
 * }} options
 * @returns {() => void} 卸载函数
 */
export function installApprovalGate(ctx, options) {
  if (!options.requireApproval) {
    options.log?.('approval gate disabled by config')
    return () => {}
  }

  const listener = async (exec, next) => {
    // 只拦自己的工具：名字是 axolotl_* 且参数里有 op
    const toolName = String(exec?.name ?? '')
    if (!toolName.startsWith('axolotl_')) return next()

    const args = exec?.arguments ?? {}
    const op = typeof args.op === 'string' && args.op !== '' ? args.op : toolName === 'axolotl_raw' ? args.tool : undefined
    if (typeof op !== 'string' || op === '' || op === 'help' || op === 'list') return next()

    const capability = options.catalog.capabilityOf(op)
    // 只读、或不需要完全访问的，直接放行
    if (capability.readOnly || !capability.full) return next()

    // 审批策略是 never 时再 ask 只会被立刻拒掉（approval.decide 里明确写了这条），
    // 与其让用户莫名其妙看到「被拒绝」，不如放行交给启动器自己的权限模型。
    const approval = ctx.get('approval')
    if (approval !== undefined && typeof approval.effectivePolicy === 'function' && exec.agent !== undefined) {
      try {
        if (approval.effectivePolicy(exec.agent.session) === 'never') return next()
      } catch {
        // 拿不到策略就按「该问」处理，宁可多问一次
      }
    }

    const reason = describeIntent(op, args.args ?? {}, { instanceId: args.instance_id })
    return { kind: 'ask', reason, displayReason: reason }
  }

  return ctx.on('tools/pre-execute', listener)
}
