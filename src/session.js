/**
 * 控制会话：启动器几乎所有的业务工具都要先 `start_session` 拿一个 `session_id`，
 * 而且同一时刻**只允许一个**控制会话。
 *
 * 这带来三件事，全在这里处理：
 *   1. 自动开：模型不该知道 session_id 这回事，调用前补上就行
 *   2. 自动关：闲置太久要还给启动器，否则别的客户端（比如启动器自己的界面）连不上
 *   3. 抢占期重试：旧连接被强杀后启动器要等心跳超时（约 30 秒）才释放，
 *      这段时间 start_session 会返回 `Another control session or approval request is active`
 *
 * @module dsh-plugin-axolotl/session
 */

/** 上游表示「会话被占」的错误码。 */
const BUSY_PATTERN = /Another control session|approval request is active/i

/**
 * 管理一个控制会话的完整生命周期。
 */
export class SessionManager {
  /**
   * @param {{
   *   upstream: import('./upstream.js').Upstream,
   *   policy: 'auto' | 'persistent' | 'manual',
   *   idleMs: number,
   *   retryMs: number,
   *   log?: (message: string) => void,
   * }} options
   */
  constructor(options) {
    this.upstream = options.upstream
    this.policy = options.policy
    this.idleMs = options.idleMs
    this.retryMs = options.retryMs
    this.log = options.log ?? (() => {})
    /** @type {{ id: string | undefined, lastUsed: number }} */
    this.current = { id: undefined, lastUsed: 0 }
    /** 上游重连后要清掉旧 session_id（新连接上它一定无效）。 */
    this.upstream.resetSessionHook = () => {
      if (this.current.id !== undefined) this.log(`upstream reconnected, dropping session ${this.current.id}`)
      this.current = { id: undefined, lastUsed: 0 }
    }
  }

  /** 当前会话 id，没有则 undefined。 */
  get id() {
    return this.current.id
  }

  /** 会话是否闲置过期。 */
  get stale() {
    return this.current.id !== undefined && Date.now() - this.current.lastUsed > this.idleMs
  }

  /**
   * 拿一个可用的 session_id，必要时新开。
   *
   * 重试预算是为了盖过启动器的心跳超时：被强杀的旧连接要等约 30 秒才释放。
   *
   * @returns {Promise<string>}
   */
  async ensure() {
    if (this.current.id !== undefined) {
      if (!this.stale) return this.current.id
      await this.close('idle timeout')
    }
    if (this.policy === 'manual') {
      throw new Error(
        '控制会话策略是 manual，插件不会自动向启动器申请会话。'
          + '在插件设置里改成 auto，或者先在启动器界面点「AI 已连接」授权。',
      )
    }

    const deadline = Date.now() + this.retryMs
    let lastError
    let attempt = 0
    // 先无条件试一次再进循环：retryMs 为 0 时 deadline 等于现在，
    // `while (Date.now() < deadline)` 一次都不进，会变成「永不尝试」。
    do {
      attempt += 1
      const result = await this.upstream.call('start_session', {})
      const structured = result?.structuredContent ?? {}
      const id = structured.session_id ?? structured.sessionId
      if (typeof id === 'string' && id !== '') {
        this.current = { id, lastUsed: Date.now() }
        this.log(`control session opened ${id} (full_access=${structured.full_access === true}, attempt ${attempt})`)
        return id
      }

      // 上游的 error 是 {code, message} 对象。直接 String() 会变成 "[object Object]"，
      // 正则永远匹配不上，重试逻辑就形同虚设 —— 必须把 message 抽出来。
      const error = structured.error
      const message = String(
        (error && typeof error === 'object' ? error.message : error) ?? 'start_session 没有返回 session_id',
      )
      lastError = message
      if (!BUSY_PATTERN.test(message)) throw new Error(`无法申请控制会话：${message}`)
      if (Date.now() >= deadline) break

      const wait = Math.min(5000, 1000 * attempt)
      this.log(`start_session busy (attempt ${attempt}): ${message}; waiting ${wait}ms`)
      await new Promise((resolve) => setTimeout(resolve, wait))
    } while (Date.now() < deadline)

    throw new Error(
      `启动器上还有一个控制会话没释放（${lastError}）。`
        + '通常是旧的连接还占着（比如上一次 DSH 窗口，或被强杀的进程）；等半分钟它会自动清掉，'
        + '也可以点启动器标题栏的「AI 已连接」手动断开。',
    )
  }

  /** 记录一次使用，推迟闲置计时。 */
  touch() {
    if (this.current.id !== undefined) this.current.lastUsed = Date.now()
  }

  /**
   * 关掉会话，把控制权还给启动器。
   * @param {string} reason
   */
  async close(reason) {
    const { id } = this.current
    this.current = { id: undefined, lastUsed: 0 }
    if (id === undefined) return
    try {
      await this.upstream.call('end_session', { session_id: id })
      this.log(`control session closed (${reason})`)
    } catch (error) {
      this.log(`failed to close control session: ${String(/** @type {{ message?: string }} */ (error)?.message ?? error)}`)
    }
  }

  /** 空闲巡检：由插件在定时器里调。 */
  async reapIfIdle() {
    if (this.stale) await this.close('idle timeout')
  }
}
