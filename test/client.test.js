/**
 * 客户端半边的装配烟测。
 *
 * `lib/client.js` 是经典脚本：DSH 用 `window.__ModuleLoader__.load({id, factory})`
 * 装它，然后调 `exports.apply(ctx)`。这里用假 window / 假 React 跑一遍，
 * 挡住「语法对但一装就炸」的问题 —— 这个文件在 DSH 里出错只会显示成空卡片，
 * 没有堆栈可看，所以在测试里先把结构走通。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * 极简 React 替身。
 *
 * 够用即可：`useState` 真的存值、`useEffect` 真的跑（收集起来由测试驱动），
 * 这样才能看到「数据加载完之后」的 DOM，而不是永远停在加载态。
 */
function fakeReact() {
  /** @type {Map<number, { value: any, set: (next: any) => void }>} */
  const slots = new Map()
  /** @type {Array<() => void | (() => void)>} */
  const effects = []
  let cursor = 0

  const React = {
    useState(initial) {
      const index = cursor++
      if (!slots.has(index)) {
        slots.set(index, {
          value: typeof initial === 'function' ? initial() : initial,
          set(next) {
            const current = slots.get(index)
            current.value = typeof next === 'function' ? next(current.value) : next
          },
        })
      }
      const slot = slots.get(index)
      return [slot.value, slot.set]
    },
    // 依赖数组当键：同一位置同一依赖不再重复跑
    useEffect(fn, deps) {
      const index = 1000 + cursor++
      const key = deps === undefined ? index : `${index}:${JSON.stringify(deps)}`
      if (slots.has(key)) return
      slots.set(key, { value: true, set() {} })
      effects.push(fn)
    },
    useMemo: fn => fn(),
    useCallback: fn => fn,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  }
  const jsx = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  }

  return {
    React,
    jsx,
    /** 清掉 hook 游标（每次渲染都要重置，否则位置会漂）。 */
    reset() {
      cursor = 0
    },
    /** 跑一遍收集到的 effect 并清空。 */
    async flushEffects() {
      const pending = effects.splice(0, effects.length)
      for (const fn of pending) fn()
      // effect 里通常有 Promise，等一轮微任务
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

/**
 * 在假的全局环境里装载客户端脚本。
 * @returns {{ exports: any, loaded: any, harness: ReturnType<typeof fakeReact> }}
 */
function load() {
  const harness = fakeReact()
  const { React, jsx } = harness
  let captured
  const styleTags = []

  globalThis.window = {
    __ModuleLoader__: {
      load: entry => {
        captured = entry
      },
    },
  }
  globalThis.document = {
    head: { appendChild: tag => styleTags.push(tag) },
    createElement: () => ({ dataset: {}, textContent: '' }),
  }

  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', SOURCE)
  run(globalThis.window, globalThis.document)

  assert.ok(captured !== undefined, '客户端脚本应当调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-plugin-axolotl', '插件 id 要与包名一致')

  const requireMock = name => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsx
    throw new Error(`客户端脚本不该 require "${name}"`)
  }
  return { exports: captured.factory(requireMock), loaded: captured, harness }
}

/** 假的 client ctx：slots + inject。 */
function fakeClientCtx() {
  const registered = []
  const injected = []
  const ctx = {
    inject: (names, callback) => {
      injected.push(names)
      const scoped = {
        slots: {
          register: (slot, component) => {
            registered.push({ slot, component })
            return () => {}
          },
          inject: (name, factory) => {
            injected.push(`slot:${name}`)
            return factory()
          },
        },
      }
      callback(scoped)
      return () => {}
    },
    effect: (factory) => {
      factory()
      return () => {}
    },
  }
  return { ctx, registered, injected }
}

test('客户端脚本能被 ModuleLoader 装载并导出 apply', () => {
  const mod = load()
  assert.equal(typeof mod.exports.apply, 'function')
  assert.deepEqual(mod.exports.inject, [], '客户端不强制依赖任何服务')
  assert.equal(typeof mod.exports.version, 'string')
})

test('apply 注册设置卡片', () => {
  const mod = load()
  const { ctx, registered, injected } = fakeClientCtx()
  mod.exports.apply(ctx)
  assert.ok(injected.some(entry => Array.isArray(entry) && entry.includes('slots')), '应当请求 slots 服务')
  assert.equal(registered.length, 1, '应当注册一个设置卡片')
  assert.equal(registered[0].slot.name, 'plugins.bundle.config')
  assert.equal(registered[0].slot.key, 'dsh-plugin-axolotl')
  assert.equal(typeof registered[0].component, 'function', '卡片应当是组件函数')
})

test('没有 slots 服务时 apply 不抛异常', () => {
  const mod = load()
  const bare = { inject: (names, callback) => callback({}), effect: () => () => {} }
  assert.doesNotThrow(() => mod.exports.apply(bare))
})

test('卡片能渲染出标题与令牌输入框', async () => {
  const mod = load()
  const { ctx, registered } = fakeClientCtx()
  mod.exports.apply(ctx)

  // 第一帧是加载态，跑完 effect（两次 fetch）后再渲一帧
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/status')) {
      return {
        json: async () => ({
          ok: true,
          result: {
            launcher: { name: 'Axolotl Launcher', version: '1.11.0-beta.2' },
            upstreamUrl: 'http://127.0.0.1:5219/mcp',
            authenticated: false,
            connected: true,
            controlSession: null,
            upstreamTools: 269,
          },
        }),
      }
    }
    return {
      json: async () => ({
        ok: true,
        result: {
          upstreamUrl: 'http://127.0.0.1:5219/mcp',
          sessionPolicy: 'auto',
          sessionIdleMs: 900000,
          sessionRetryMs: 45000,
          toolCallTimeoutMs: 120000,
          autoConnect: true,
          exposeRawTool: true,
          requireApproval: true,
          auth: { configured: false },
        },
      }),
    }
  }

  mod.harness.reset()
  registered[0].component({ locale: 'zh' })
  await mod.harness.flushEffects()

  mod.harness.reset()
  const tree = registered[0].component({ locale: 'zh' })

  const found = []
  const texts = []
  /**
   * 摊平组件树。
   *
   * 关键：函数型节点（`Field` / `Check`）要先**调用**才能看到里面的 input ——
   * 它们是组件不是宿主元素，光走 props.children 会漏掉整块。
   */
  const walk = node => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node !== 'object') {
      if (typeof node === 'string') texts.push(node)
      return
    }
    if (typeof node.type === 'function') {
      mod.harness.reset()
      walk(node.type(node.props ?? {}))
      return
    }
    if (node.type === 'input' && node.props?.type === 'password') found.push(node.props)
    walk(node.props?.children)
  }
  walk(tree)

  const allText = texts.join(' ')
  assert.match(allText, /美西螈启动器/, '卡片标题应当渲染出来')
  assert.match(allText, /连接令牌/, '应当有令牌字段')
  assert.equal(found.length, 1, `应当有一个密码输入框（连接令牌），实际 ${found.length}`)
  assert.equal(found[0].autoComplete, 'off', '令牌输入不该被浏览器自动填充')
  assert.equal(found[0].value, '', '令牌框初始为空，不回显已保存的值')
})

test('颜色都走宿主变量（十六进制只作为 var() 的回退值）', () => {
  assert.ok(SOURCE.includes('--dsw-alias-'), '样式应当引用宿主的别名变量')

  // 允许两种十六进制：
  //   1. var(--dsw-alias-xxx, #rrggbb) 里的回退值 —— 变量缺失时的兜底
  //   2. 三个状态色（成功绿 / 失败红 / 白字），语义固定，不随主题变
  const STATUS_COLORS = new Set(['#3fb950', '#d64545', '#fff', '#ffffff'])
  const hexes = SOURCE.match(/#(?:[0-9a-fA-F]{3}){1,2}\b/g) ?? []

  const bare = []
  for (const hex of hexes) {
    if (STATUS_COLORS.has(hex.toLowerCase())) continue
    // 看它前面 80 个字符里有没有未闭合的 var(
    const index = SOURCE.indexOf(hex)
    const before = SOURCE.slice(Math.max(0, index - 80), index)
    if (/var\([^)]*,\s*$/.test(before)) continue
    bare.push(hex)
  }
  assert.deepEqual(bare, [], `这些颜色既不是变量回退也不是状态色：${bare.join(',')}`)
})

test('请求带 CSRF 标记头', () => {
  assert.ok(SOURCE.includes("'x-dsh-axolotl'") || SOURCE.includes('x-dsh-axolotl'), '写请求应当带自定义头')
  assert.ok(SOURCE.includes("credentials: 'same-origin'"), '应当携带同源凭据')
})
