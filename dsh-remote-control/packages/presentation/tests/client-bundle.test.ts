/**
 * client-bundle.test — 在 vm 里真跑一遍**打出来的** `dist/bundle/client.cjs`。
 *
 * 为什么要在产物上测、而不是 import 源码：这一半真正容易错的地方是**外壳**
 * （`window.__ModuleLoader__.load({id, factory})` 的 id/闭合/导出形状）和
 * "装载之后到底注册了什么"。外壳写错的表现是整页 web boot 失败——真机上要重启应用才看得见，
 * 所以这里用 Node 的 vm 造一个最小的浏览器环境，把产物原样执行：
 *
 *   1. 外壳注册成功、id 与包名一致、导出的是 `{name, inject, apply}`（inject 必须含 sidebarRight，
 *      否则宿主 ctx 的 Proxy 读它会抛错 → apply 失败 → 整页起不来）；
 *   2. apply 之后会把路由地址推进右栏，且**同一个 epoch 只推一次**（换码才再推）；
 *   3. 页面不可见时一次请求都不发；会话面板没挂上时静默等待；
 *   4. 任何一步出错都只记一条 console.error，绝不把异常抛出 apply。
 *
 * 这里不测"右栏会不会真的打开"——那是真机验收（见 HANDOFF 的验收清单）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(here, '..', 'bundle', 'client.cjs')
const ROUTE = '/plugins/dsh-remote-control-presentation/pairing'

interface ClientModule {
  name: string
  inject: string[]
  apply(ctx: unknown): void
}

interface Harness {
  module: ClientModule
  /** 右栏被推开的地址（按先后顺序）。 */
  opened: string[]
  /** fetch 收到的 URL。 */
  requests: string[]
  /** 被记下来的 console.error。 */
  errors: string[]
  /** 触发一次宿主侧节拍。 */
  tick(): void
  /** 换掉下一次 fetch 的应答。 */
  reply(body: unknown, init?: { ok?: boolean; status?: number }): void
  /** 登记过的卸载函数（ctx.effect 的那一份）。 */
  disposable(): (() => void) | undefined
}

function load(
  options: { hidden?: boolean; requireThrows?: boolean; reply?: { body: unknown; ok?: boolean; status?: number } } = {},
): Harness {
  const opened: string[] = []
  const requests: string[] = []
  const errors: string[] = []
  const timers: Array<() => void> = []
  // apply 一返回就会跑第一次 poll（fetch 是**同步**发出去的），所以"第一次应答"必须在这里给，
  // 不能等 load() 返回之后再 reply —— 那时响应对象已经建好了。
  let next: { body: unknown; ok: boolean; status: number } = {
    body: options.reply?.body ?? { state: 'none' },
    ok: options.reply?.ok ?? true,
    status: options.reply?.status ?? 200,
  }
  let spec: { id?: string; factory?: (require: unknown) => ClientModule } | undefined

  const sandbox: Record<string, unknown> = {
    console: { error: (message: unknown) => errors.push(String(message)), warn: () => {}, log: () => {} },
    document: {
      visibilityState: options.hidden ? 'hidden' : 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    setInterval: (callback: () => void) => {
      timers.push(callback)
      return timers.length
    },
    clearInterval: () => {},
    fetch: async (url: string) => {
      requests.push(url)
      return { ok: next.ok, status: next.status, json: async () => next.body }
    },
    window: {
      __ModuleLoader__: {
        load: (loaded: unknown) => {
          spec = loaded as never
        },
      },
    },
  }
  runInContext(readFileSync(CLIENT, 'utf8'), createContext(sandbox), { filename: CLIENT })
  assert.ok(spec, '产物必须在装载时调用 __ModuleLoader__.load')
  assert.equal(typeof spec?.factory, 'function')
  const module = spec!.factory!((): never => {
    throw new Error('client 产物不该 require 任何东西')
  })

  let disposable: (() => void) | undefined
  const ctx = {
    sidebarRight: {
      require: () => {
        if (options.requireThrows) throw new Error('sidebarRight: no session surface is mounted')
        return { sessionId: 'sess-1' }
      },
      openResource: (address: string) => {
        opened.push(address)
      },
    },
    effect: (execute: () => unknown) => {
      const returned = execute()
      if (typeof returned === 'function') disposable = returned as () => void
    },
  }
  module.apply(ctx)

  return {
    module,
    opened,
    requests,
    errors,
    tick: () => {
      assert.equal(timers.length, 1, 'apply 必须起一个轮询节拍')
      timers[0]!()
    },
    reply: (body: unknown, init) => {
      next = { body, ok: init?.ok ?? true, status: init?.status ?? 200 }
    },
    disposable: () => disposable,
  }
}

/** 把跨 realm 的 promise 链推完（每轮 fetch 只有两个 await）。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function readyBody(
  epoch: string,
  address = 'dsh-resource://file/session/sess-1//Users/x/.dsh/a.png',
): Record<string, unknown> {
  return { state: 'ready', epoch, address, expiresAt: Date.now() + 60_000 }
}

test('外壳注册的形状：id 与包名一致，导出 name/inject/apply，inject 含 sidebarRight', () => {
  const harness = load()
  assert.equal(harness.module.name, 'dsh-remote-control-presentation')
  // 展开一次：vm 那个 realm 的数组与本 realm 的 Array.prototype 不是同一个，
  // deepStrictEqual 会因原型不同而红（与代码对错无关）。
  assert.deepEqual([...harness.module.inject], ['sidebarRight'])
  assert.equal(typeof harness.module.apply, 'function')
  assert.equal(harness.errors.length, 0)
})

test('有码就推右栏，地址原样来自路由；同一个 epoch 只推一次，换码再推', async () => {
  const harness = load({ reply: { body: readyBody('e1') } })
  await flush()
  assert.deepEqual(harness.requests, [`${ROUTE}?session=sess-1`])
  assert.deepEqual(harness.opened, ['dsh-resource://file/session/sess-1//Users/x/.dsh/a.png'])

  harness.tick()
  await flush()
  assert.equal(harness.opened.length, 1, '同一版码不该重复顶开右栏')

  harness.reply(readyBody('e2', 'dsh-resource://file/session/sess-1//Users/x/.dsh/b.png'))
  harness.tick()
  await flush()
  assert.deepEqual(harness.opened[1], 'dsh-resource://file/session/sess-1//Users/x/.dsh/b.png')
})

test('没有码 / 已过期 / state 不认识：一次都不推', async () => {
  const harness = load({ reply: { body: { state: 'none' } } })
  await flush()
  harness.reply({ state: 'ready', epoch: 'e9', address: 'x', expiresAt: Date.now() - 1 })
  harness.tick()
  await flush()
  assert.deepEqual(harness.opened, [])
  assert.equal(harness.errors.length, 0)
})

test('页面不可见时一次请求都不发（Electron 里窗口在后台是常态）', async () => {
  const harness = load({ hidden: true, reply: { body: readyBody('e1') } })
  await flush()
  harness.tick()
  await flush()
  assert.deepEqual(harness.requests, [])
  assert.deepEqual(harness.opened, [])
})

test('会话面板还没挂上（require 抛错）：静默等下一轮，不当故障记', async () => {
  const harness = load({ requireThrows: true, reply: { body: readyBody('e1') } })
  await flush()
  harness.tick()
  await flush()
  assert.deepEqual(harness.requests, [])
  assert.equal(harness.errors.length, 0, '这是正常的启动态，不该刷日志')
})

test('路由报错：只记一条 console.error，并把状态码带出来', async () => {
  const harness = load({ reply: { body: { error: 'boom' }, ok: false, status: 500 } })
  await flush()
  assert.ok(
    harness.errors.some((line) => line.includes('500')),
    harness.errors.join('\n'),
  )
  assert.deepEqual(harness.opened, [])
})

test('卸载函数被登记：调用它之后节拍停掉（再 tick 也不发请求）', async () => {
  const harness = load({ reply: { body: readyBody('e1') } })
  await flush()
  const dispose = harness.disposable()
  assert.equal(typeof dispose, 'function', '必须用 ctx.effect 登记卸载')
  dispose!()
  const requestsBefore = harness.requests.length
  harness.tick()
  await flush()
  assert.equal(harness.requests.length, requestsBefore, '停掉之后不该再发请求')
})
