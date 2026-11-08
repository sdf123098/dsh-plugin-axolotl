/**
 * 客户端半边：插件设置卡片。
 *
 * DSH 用 `window.__ModuleLoader__.load({ id, factory })` 装这类经典脚本，
 * 然后调 `exports.apply(ctx)`。`require` 只能拿到 `react` 与 `react/jsx-runtime` ——
 * 所以这里不 import 任何宿主组件，全部用原生元素画。
 *
 * 视觉上跟宿主一致靠 CSS 变量（`--dsw-alias-*`），不写死颜色。
 *
 * @module dsh-plugin-axolotl/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-axolotl',
  factory: require => {
    'use strict'
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const jsx = require('react/jsx-runtime')

    const API = '/axolotl/api'

    /** 写请求的 CSRF 标记头：别的站点构造不出来，等于挡住跨源表单提交。 */
    const WRITE_HEADER = 'x-dsh-axolotl'

    /** 设置页里的一组文案。 */
    const TEXTS = {
      zh: {
        title: '美西螈启动器',
        description: '把 Axolotl Launcher 的 269 个 MCP 工具收成 9 个领域工具，截图直接返回图片。',
        status: '连接状态',
        connected: '已连接',
        disconnected: '未连接',
        authenticated: '已带令牌',
        anonymous: '未带令牌',
        launcher: '启动器',
        toolCount: '上游工具',
        session: '控制会话',
        none: '无',
        upstream: '上游地址',
        upstreamHint: '启动器内置 MCP 的地址。默认 http://127.0.0.1:5219/mcp。',
        token: '连接令牌',
        tokenHint: '启动器的「设置 → MCP 服务器 → 要求身份验证」打开后，必须在这里填上令牌。留空表示不用。',
        tokenConfigured: '已配置（不回显）',
        tokenEmpty: '未配置',
        clearToken: '清除令牌',
        behaviour: '行为',
        autoConnect: 'DSH 启动时自动连接',
        exposeRaw: '暴露 axolotl_raw 逃生口（关掉更省上下文，需重启 DSH）',
        requireApproval: '写操作走 DSH 审批',
        requireApprovalHint: '只在会话审批策略不是「从不询问」时才会真的弹确认。',
        sessionPolicy: '控制会话策略',
        policyAuto: '按需开关（推荐）',
        policyPersistent: '常驻',
        policyManual: '不自动开',
        sessionIdle: '会话闲置多久自动关（秒）',
        sessionRetry: '会话被占用时重试多久（秒）',
        timeout: '单次调用超时（秒）',
        test: '测试连接',
        testing: '正在测试…',
        save: '保存',
        saving: '正在保存…',
        saved: '已保存',
        reopenHint: '改启动器地址或令牌后会立刻重连。',
        daemonOffline: '连不上启动器。打开启动器，或检查「设置 → MCP 服务器」里的启用开关。',
        restartNeeded: '这一项要重启 DSH 才生效。',
      },
      en: {
        title: 'Axolotl Launcher',
        description: 'Folds the Axolotl Launcher’s 269 MCP tools into 9 domain tools; screenshots come back as real images.',
        status: 'Connection',
        connected: 'Connected',
        disconnected: 'Disconnected',
        authenticated: 'Token sent',
        anonymous: 'No token',
        launcher: 'Launcher',
        toolCount: 'Upstream tools',
        session: 'Control session',
        none: 'none',
        upstream: 'Upstream URL',
        upstreamHint: 'The launcher’s built-in MCP endpoint. Defaults to http://127.0.0.1:5219/mcp.',
        token: 'Connection token',
        tokenHint: 'Required when the launcher’s “Settings → MCP server → Require authentication” is on. Leave empty for none.',
        tokenConfigured: 'Configured (never echoed)',
        tokenEmpty: 'Not configured',
        clearToken: 'Clear token',
        behaviour: 'Behaviour',
        autoConnect: 'Connect on DSH start',
        exposeRaw: 'Expose axolotl_raw escape hatch (off saves context; needs a DSH restart)',
        requireApproval: 'Route write operations through DSH approval',
        requireApprovalHint: 'Only asks when the session approval policy is not “never”.',
        sessionPolicy: 'Control session policy',
        policyAuto: 'On demand (recommended)',
        policyPersistent: 'Always held',
        policyManual: 'Never open automatically',
        sessionIdle: 'Close the session after idle (seconds)',
        sessionRetry: 'Retry a busy session for (seconds)',
        timeout: 'Per-call timeout (seconds)',
        test: 'Test connection',
        testing: 'Testing…',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        reopenHint: 'Changing the URL or token reconnects immediately.',
        daemonOffline: 'Cannot reach the launcher. Start it, or check “Settings → MCP server → Enable”.',
        restartNeeded: 'This one takes effect after a DSH restart.',
      },
    }

    /**
     * 调后端。
     * @param {string} method
     * @param {unknown} [body]
     */
    async function callApi(method, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', [WRITE_HEADER]: '1' },
            body: JSON.stringify(body),
          }
      const response = await fetch(`${API}/${method}`, { ...init, credentials: 'same-origin' })
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined) throw new Error(`HTTP ${response.status}`)
      if (payload.ok !== true) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      return payload.result
    }

    /** 极简样式：只用宿主暴露的别名变量，深浅色都跟着走。 */
    const css = `
      .axo{display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:1.55}
      .axo-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .axo-title{font-weight:600;font-size:14px;margin:0}
      .axo-desc{margin:4px 0 0;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px}
      .axo-dot{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}
      .axo-dot i{width:8px;height:8px;border-radius:50%;display:inline-block}
      .axo-ok{background:#3fb950}
      .axo-bad{background:#d64545}
      .axo-grid{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12px;
        padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-module-platform,#8080800f)}
      .axo-grid dt{color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;margin:0}
      .axo-grid dd{margin:0;font-variant-numeric:tabular-nums;word-break:break-all}
      .axo-field{display:flex;flex-direction:column;gap:6px}
      .axo-label{font-weight:500}
      .axo-hint{margin:0;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px}
      .axo-input,.axo-select{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;font:inherit;
        color:inherit;background:var(--dsw-alias-bg-module-platform,#8080800f);
        border:1px solid var(--dsw-alias-line-secondary,#00000014)}
      .axo-input:focus,.axo-select:focus{outline:2px solid var(--dsw-alias-state-business-primary,#2f81f7);outline-offset:-1px}
      .axo-row{display:flex;align-items:center;gap:8px}
      .axo-check{display:flex;align-items:flex-start;gap:8px}
      .axo-check input{margin-top:2px;flex:none}
      .axo-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .axo-btn{padding:7px 14px;border-radius:8px;font:inherit;cursor:pointer;
        border:1px solid var(--dsw-alias-line-secondary,#00000014);
        background:var(--dsw-alias-bg-module-platform,#8080800f);color:inherit}
      .axo-btn:disabled{opacity:.5;cursor:default}
      .axo-btn-primary{background:var(--dsw-alias-state-business-primary,#2f81f7);color:#fff;border-color:transparent}
      .axo-msg{font-size:12px;margin:0}
      .axo-msg-ok{color:#3fb950}
      .axo-msg-bad{color:#d64545}
      .axo-msg-info{color:var(--dsw-alias-label-tertiary,#81858c);white-space:pre-wrap}
      .axo-sep{height:1px;background:var(--dsw-alias-line-secondary,#00000014);margin:2px 0}
    `

    /** 注入一次样式。 */
    function ensureStyle() {
      const key = '__dsh_axolotl_style__'
      if (document[key] === true) return
      const tag = document.createElement('style')
      tag.dataset.source = 'dsh-plugin-axolotl'
      tag.textContent = css
      document.head.appendChild(tag)
      document[key] = true
    }

    /** 一个字段的标签 + 输入 + 说明。 */
    function Field(props) {
      return jsx.jsxs('div', {
        className: 'axo-field',
        children: [
          jsx.jsx('label', { className: 'axo-label', htmlFor: props.id, children: props.label }),
          props.children,
          props.hint === undefined ? null : jsx.jsx('p', { className: 'axo-hint', children: props.hint }),
        ],
      })
    }

    /** 勾选项。 */
    function Check(props) {
      return jsx.jsxs('label', {
        className: 'axo-check',
        children: [
          jsx.jsx('input', {
            type: 'checkbox',
            checked: props.checked,
            disabled: props.disabled === true,
            onChange: event => props.onChange(event.target.checked),
          }),
          jsx.jsxs('span', {
            children: [
              jsx.jsx('span', { children: props.label }),
              props.hint === undefined
                ? null
                : jsx.jsx('p', { className: 'axo-hint', children: props.hint }),
            ],
          }),
        ],
      })
    }

    /**
     * 设置卡片。
     *
     * 状态全在组件里，不进宿主 store —— 这个插件没有跨视图共享的需求，
     * 用 React 自己的 state 更直接，也少一层要维护的同步。
     */
    function AxolotlCard(props) {
      const t = TEXTS[props.locale === 'en' ? 'en' : 'zh']
      const [status, setStatus] = React.useState(undefined)
      const [loaded, setLoaded] = React.useState(false)
      const [form, setForm] = React.useState(undefined)
      const [tokenDraft, setTokenDraft] = React.useState('')
      const [busy, setBusy] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)

      React.useEffect(() => {
        ensureStyle()
        let cancelled = false
        Promise.all([callApi('status').catch(() => undefined), callApi('config')])
          .then(([statusResult, configResult]) => {
            if (cancelled) return
            setStatus(statusResult)
            setForm({
              upstreamUrl: configResult.upstreamUrl ?? '',
              sessionPolicy: configResult.sessionPolicy ?? 'auto',
              sessionIdleMs: configResult.sessionIdleMs ?? 900000,
              sessionRetryMs: configResult.sessionRetryMs ?? 45000,
              toolCallTimeoutMs: configResult.toolCallTimeoutMs ?? 120000,
              autoConnect: configResult.autoConnect !== false,
              exposeRawTool: configResult.exposeRawTool !== false,
              requireApproval: configResult.requireApproval !== false,
              auth: configResult.auth ?? { configured: false },
            })
            setLoaded(true)
          })
          .catch(error => {
            if (cancelled) return
            setNotice({ kind: 'bad', text: String(error?.message ?? error) })
            setLoaded(true)
          })
        return () => {
          cancelled = true
        }
      }, [])

      if (loaded === false || form === undefined) {
        return jsx.jsx('div', { className: 'axo', children: jsx.jsx('p', { className: 'axo-hint', children: '…' }) })
      }

      const update = (key, value) => setForm(previous => ({ ...previous, [key]: value }))

      const refreshStatus = () => callApi('status').then(setStatus).catch(() => {})

      const runTest = async () => {
        setBusy('test')
        setNotice(undefined)
        try {
          const result = await callApi('test', {
            upstreamUrl: form.upstreamUrl,
            // 有草稿就用草稿；没有就交给后端用已保存的令牌
            authToken: tokenDraft === '' ? undefined : tokenDraft,
          })
          setNotice(
            result.ok
              ? { kind: 'ok', text: `${t.connected} · ${result.toolCount} tools · ${result.elapsedMs}ms` }
              : { kind: 'bad', text: result.message ?? result.reason },
          )
          await refreshStatus()
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy(undefined)
        }
      }

      const save = async () => {
        setBusy('save')
        setNotice(undefined)
        try {
          const patch = {
            upstreamUrl: form.upstreamUrl,
            sessionPolicy: form.sessionPolicy,
            sessionIdleMs: Number(form.sessionIdleMs),
            sessionRetryMs: Number(form.sessionRetryMs),
            toolCallTimeoutMs: Number(form.toolCallTimeoutMs),
            autoConnect: form.autoConnect,
            exposeRawTool: form.exposeRawTool,
            requireApproval: form.requireApproval,
          }
          if (tokenDraft !== '') patch.authToken = tokenDraft
          const result = await callApi('config.set', { patch })
          setForm(previous => ({ ...previous, ...result.config, auth: result.config.auth }))
          setTokenDraft('')
          setNotice({ kind: 'ok', text: t.saved })
          await refreshStatus()
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy(undefined)
        }
      }

      const clearToken = async () => {
        setBusy('token')
        setNotice(undefined)
        try {
          const result = await callApi('config.set', { patch: { authToken: '' } })
          setForm(previous => ({ ...previous, ...result.config, auth: result.config.auth }))
          setTokenDraft('')
          setNotice({ kind: 'ok', text: t.saved })
          await refreshStatus()
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy(undefined)
        }
      }

      const connected = status?.connected === true
      const authLabel = form.auth?.configured === true ? t.tokenConfigured : t.tokenEmpty

      return jsx.jsxs('div', {
        className: 'axo',
        children: [
          jsx.jsxs('div', {
            className: 'axo-head',
            children: [
              jsx.jsxs('div', {
                children: [
                  jsx.jsx('h3', { className: 'axo-title', children: t.title }),
                  jsx.jsx('p', { className: 'axo-desc', children: t.description }),
                ],
              }),
              jsx.jsxs('span', {
                className: 'axo-dot',
                children: [
                  jsx.jsx('i', { className: connected ? 'axo-ok' : 'axo-bad' }),
                  `${connected ? t.connected : t.disconnected} · ${status?.authenticated === true ? t.authenticated : t.anonymous}`,
                ],
              }),
            ],
          }),

          jsx.jsxs('dl', {
            className: 'axo-grid',
            children: [
              jsx.jsx('dt', { children: t.launcher }),
              jsx.jsx('dd', {
                children: status?.launcher === undefined
                  ? '—'
                  : `${status.launcher.name ?? '?'} ${status.launcher.version ?? '?'}`,
              }),
              jsx.jsx('dt', { children: t.toolCount }),
              jsx.jsx('dd', { children: status?.upstreamTools ?? 0 }),
              jsx.jsx('dt', { children: t.session }),
              jsx.jsx('dd', { children: status?.controlSession ?? t.none }),
            ],
          }),

          connected ? null : jsx.jsx('p', { className: 'axo-msg axo-msg-info', children: t.daemonOffline }),

          jsx.jsx('div', { className: 'axo-sep' }),

          jsx.jsxs(Field, {
            id: 'axo-upstream',
            label: t.upstream,
            hint: t.upstreamHint,
            children: [
              jsx.jsx('input', {
                id: 'axo-upstream',
                className: 'axo-input',
                type: 'text',
                spellCheck: false,
                value: form.upstreamUrl,
                onChange: event => update('upstreamUrl', event.target.value),
              }),
            ],
          }),

          jsx.jsxs(Field, {
            id: 'axo-token',
            label: t.token,
            hint: t.tokenHint,
            children: [
              jsx.jsxs('div', {
                className: 'axo-row',
                children: [
                  jsx.jsx('input', {
                    id: 'axo-token',
                    className: 'axo-input',
                    type: 'password',
                    autoComplete: 'off',
                    spellCheck: false,
                    placeholder: authLabel,
                    value: tokenDraft,
                    onChange: event => setTokenDraft(event.target.value),
                  }),
                  form.auth?.configured === true
                    ? jsx.jsx('button', {
                        type: 'button',
                        className: 'axo-btn',
                        disabled: busy !== undefined,
                        onClick: clearToken,
                        children: t.clearToken,
                      })
                    : null,
                ],
              }),
            ],
          }),

          jsx.jsx('div', { className: 'axo-sep' }),

          jsx.jsxs('div', {
            className: 'axo-field',
            children: [
              jsx.jsx('span', { className: 'axo-label', children: t.behaviour }),
              jsx.jsx(Check, {
                checked: form.autoConnect,
                label: t.autoConnect,
                onChange: value => update('autoConnect', value),
              }),
              jsx.jsx(Check, {
                checked: form.exposeRawTool,
                label: t.exposeRaw,
                hint: t.restartNeeded,
                onChange: value => update('exposeRawTool', value),
              }),
              jsx.jsx(Check, {
                checked: form.requireApproval,
                label: t.requireApproval,
                hint: t.requireApprovalHint,
                onChange: value => update('requireApproval', value),
              }),
            ],
          }),

          jsx.jsxs(Field, {
            id: 'axo-policy',
            label: t.sessionPolicy,
            children: [
              jsx.jsxs('select', {
                id: 'axo-policy',
                className: 'axo-select',
                value: form.sessionPolicy,
                onChange: event => update('sessionPolicy', event.target.value),
                children: [
                  jsx.jsx('option', { value: 'auto', children: t.policyAuto }),
                  jsx.jsx('option', { value: 'persistent', children: t.policyPersistent }),
                  jsx.jsx('option', { value: 'manual', children: t.policyManual }),
                ],
              }),
            ],
          }),

          jsx.jsxs('div', {
            className: 'axo-row',
            children: [
              jsx.jsxs(Field, {
                id: 'axo-idle',
                label: t.sessionIdle,
                children: [
                  jsx.jsx('input', {
                    id: 'axo-idle',
                    className: 'axo-input',
                    type: 'number',
                    min: 60,
                    value: Math.round(form.sessionIdleMs / 1000),
                    onChange: event => update('sessionIdleMs', Number(event.target.value) * 1000),
                  }),
                ],
              }),
              jsx.jsxs(Field, {
                id: 'axo-retry',
                label: t.sessionRetry,
                children: [
                  jsx.jsx('input', {
                    id: 'axo-retry',
                    className: 'axo-input',
                    type: 'number',
                    min: 0,
                    value: Math.round(form.sessionRetryMs / 1000),
                    onChange: event => update('sessionRetryMs', Number(event.target.value) * 1000),
                  }),
                ],
              }),
              jsx.jsxs(Field, {
                id: 'axo-timeout',
                label: t.timeout,
                children: [
                  jsx.jsx('input', {
                    id: 'axo-timeout',
                    className: 'axo-input',
                    type: 'number',
                    min: 1,
                    value: Math.round(form.toolCallTimeoutMs / 1000),
                    onChange: event => update('toolCallTimeoutMs', Number(event.target.value) * 1000),
                  }),
                ],
              }),
            ],
          }),

          jsx.jsxs('div', {
            className: 'axo-actions',
            children: [
              jsx.jsx('button', {
                type: 'button',
                className: 'axo-btn axo-btn-primary',
                disabled: busy !== undefined,
                onClick: save,
                children: busy === 'save' ? t.saving : t.save,
              }),
              jsx.jsx('button', {
                type: 'button',
                className: 'axo-btn',
                disabled: busy !== undefined,
                onClick: runTest,
                children: busy === 'test' ? t.testing : t.test,
              }),
              notice === undefined
                ? null
                : jsx.jsx('p', {
                    className: `axo-msg axo-msg-${notice.kind}`,
                    children: notice.text,
                  }),
            ],
          }),

          jsx.jsx('p', { className: 'axo-hint', children: t.reopenHint }),
        ],
      })
    }

    /**
     * 挂载。
     *
     * `slots` 是可选的：纯 CLI 客户端没有它，那时插件应当照常加载，
     * 只是没有设置卡片 —— 不能因为等一个服务把整个客户端卡住。
     */
    function apply(ctx) {
      ensureStyle()
      const mount = scoped => {
        const slots = scoped?.slots
        if (slots === undefined || typeof slots.register !== 'function') return undefined
        return scoped.slots.inject('plugins.bundle.config', () =>
          scoped.slots.register(
            {
              name: 'plugins.bundle.config',
              key: 'dsh-plugin-axolotl',
              inject: () => ({}),
            },
            AxolotlCard,
          ),
        )
      }
      if (typeof ctx.inject === 'function') {
        return ctx.inject(['slots'], scoped => mount(scoped))
      }
      try {
        return mount(ctx)
      } catch {
        return undefined
      }
    }

    exports.apply = apply
    exports.inject = []
    exports.version = '0.2.1'
    return module.exports
  },
})


