/**
 * entry.test — 宿主侧的接线：软探测两个服务、起节拍、挂路由、卸载时收干净。
 *
 * 这一层不重复测 presenter / route 的判断（那两个文件各测各的），它测的是**它们被接起来了**：
 * 一次 `apply` 之后，真实地渲染出一张 PNG、真实地把它写进磁盘、并且路由给出的地址**指向
 * 那个真的存在的文件**。中间任何一环没接上，这个断言就会红。
 *
 * 另外几条都是"宿主加载纪律"的形状：`apply` 在任何情况下都不许向外抛（抛出去宿主那一行
 * fiber 就失败）、没有服务时什么都不做、只有一半服务时不起、卸载时路由与节拍都要收回。
 *
 * 落点（2026-10-02 改）：图该落在**请求那条会话的工作区**的 `.dsh` 下，工作区从主插件
 * `provide` 的 `dshRemoteControl.sessionWorkspace()` 问来；问不到才退回配置里的
 * `imageFile`。所以这里既要有"落了工作区、兜底位没被写"的正面，也要有"写不成 → 答 none、
 * 绝不交出指向不存在文件的地址"的反面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../src/entry.js'
import { PAIRING_ROUTE } from '../src/route.js'

const HOST_HEADERS = { host: '127.0.0.1:5173' }

interface Captured {
  /** setInterval 回调（entry 只起一个）。 */
  ticks: Array<() => void>
  /** clearInterval 被调了几次。 */
  cleared: number
}

interface Route {
  kind: string
  path: string
  handler: (request: unknown, response: unknown) => unknown
}

interface Setup {
  ctx: Record<string, unknown>
  routes: Route[]
  disposers: Array<() => void>
  unregistered: () => number
}

function remoteWith(
  pairing: unknown,
  sessionWorkspace?: (sessionId: string) => string | undefined,
): Record<string, unknown> {
  return { state: { pairing }, ...(sessionWorkspace === undefined ? {} : { sessionWorkspace }) }
}

/**
 * 造一版码，**形状照抄宿主 provide 出来的那一版**：`expiresAt` 是 ISO 字符串
 * （`describeActivePairing()` 的序列化结果，见 packages/plugin/src/index.ts），
 * 不是主插件内部的毫秒数。这一层的测试如果只喂毫秒 fixture，就正好绕过了
 * 真机上"每版码都被判过期"的那个 bug。
 */
function pairingWith(qr: string, expiresAtMs: number): { qr: string; expiresAt: string } {
  return { qr, expiresAt: new Date(expiresAtMs).toISOString() }
}

function setup(
  options: {
    remote?: unknown
    web?: boolean
    get?: boolean
    inject?: boolean
    effect?: boolean
    onDispose?: boolean
    scopedInject?: boolean
  } = {},
): Setup {
  const routes: Route[] = []
  let unregistered = 0
  const web = {
    register: (route: Route) => {
      routes.push(route)
      return () => {
        unregistered += 1
      }
    },
  }
  const remote = options.remote ?? remoteWith(null)
  const disposers: Array<() => void> = []
  const ctx: Record<string, unknown> = {}
  if (options.get !== false) {
    ctx.get = (name: string, _optional?: boolean) => {
      if (name === 'dshRemoteControl') return remote
      if (name === 'webServer' && options.web !== false) return web
      return undefined
    }
  }
  if (options.inject !== false) {
    ctx.inject = (_names: string[], callback: (scoped: unknown) => void) => {
      // 真宿主给的是**作用域化上下文**（要在它上面 get 才拿得到服务），
      // 这里就按那个形状喂，免得测出来的是"回调参数=服务"这个错的形状。
      if (options.scopedInject)
        callback({
          get: (name: string) => (name === 'dshRemoteControl' ? remote : name === 'webServer' ? web : undefined),
        })
    }
  }
  if (options.effect !== false) {
    ctx.effect = (execute: () => (() => unknown) | void) => {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }
  }
  if (options.onDispose) ctx.onDispose = (fn: () => void) => disposers.push(fn)
  return { ctx, routes, disposers, unregistered: () => unregistered }
}

/**
 * 用真的 Timer 句柄伪装节拍：`clearInterval` 收到的必须是一个真句柄，
 * 否则"卸载时到底清没清"这条断言测的就是假对象的行为了。
 * 补丁在整个测试体期间生效（clearInterval 在 apply 返回之后才被调用）。
 */
async function withTimers<T>(run: (captured: Captured) => Promise<T> | T): Promise<T> {
  const captured: Captured = { ticks: [], cleared: 0 }
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = ((callback: () => void) => {
    captured.ticks.push(callback)
    // 一个真的、永不触发的句柄（顶到最大延时并 unref），这样 clearInterval 有真东西可清。
    const handle = realSet(() => {}, 0x7fffffff)
    handle.unref?.()
    return handle
  }) as never
  globalThis.clearInterval = ((handle: Parameters<typeof realClear>[0]) => {
    captured.cleared += 1
    realClear(handle)
  }) as never
  try {
    return await run(captured)
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the route to answer "ready"')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function askRoute(route: Route, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0
  let payload = ''
  const response = {
    writeHead: (code: number) => {
      status = code
    },
    end: (chunk?: unknown) => {
      payload = typeof chunk === 'string' ? chunk : ''
    },
  }
  await route.handler({ method: 'GET', url, headers: HOST_HEADERS }, response)
  return { status, body: JSON.parse(payload) as Record<string, unknown> }
}

function tempImageFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-entry-'))
  return { file: path.join(dir, 'sidebar-qr.png'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('两个服务都到齐：起节拍、挂路由，节拍跑出来的图真的在磁盘上', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({
      remote: remoteWith(pairingWith('dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token', Date.now() + 60_000)),
    })
    await withTimers(async (captured) => {
      apply(setupResult.ctx, { imageFile: file, refreshMs: 1000 })

      assert.equal(setupResult.routes.length, 1, '路由必须挂上')
      assert.equal(setupResult.routes[0]?.path, PAIRING_ROUTE)
      assert.equal(captured.ticks.length, 1, '节拍必须起起来')

      const answer = await waitFor(async () => {
        const got = await askRoute(setupResult.routes[0]!, '/?session=sess-1')
        return got.status === 200 && got.body.state === 'ready' ? got : undefined
      })
      assert.equal(typeof answer.body.epoch, 'string')
      assert.equal(typeof answer.body.expiresAt, 'number')
      const address = String(answer.body.address)
      assert.ok(address.startsWith('dsh-resource://file/session/sess-1/'), address)
      assert.ok(address.endsWith(encodeURIComponent(path.basename(file))), address)
      assert.ok(existsSync(file), '地址指向的 PNG 必须真的存在')
      // 地址里绝不能出现码本身（路由是浏览器可达的，码带着一次性 token + PSK）。
      assert.ok(!JSON.stringify(answer).includes('fake-psk'))
      assert.ok(!JSON.stringify(answer).includes('fake-token'))
    })
  } finally {
    cleanup()
  }
})

test('会话工作区解析得出来：图落在 <工作区>/.dsh/sidebar-qr.png，配置里的 imageFile 当兜底不用', async () => {
  const { file: fallback, cleanup } = tempImageFile()
  const workspace = mkdtempSync(path.join(tmpdir(), 'drc-entry-ws-'))
  try {
    const setupResult = setup({
      remote: remoteWith(
        pairingWith('dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token', Date.now() + 60_000),
        (sessionId) => (sessionId === 'sess-1' ? workspace : undefined),
      ),
    })
    await withTimers(async () => {
      apply(setupResult.ctx, { imageFile: fallback, refreshMs: 1000 })
      const answer = await waitFor(async () => {
        const got = await askRoute(setupResult.routes[0]!, '/?session=sess-1')
        return got.status === 200 && got.body.state === 'ready' ? got : undefined
      })
      const address = String(answer.body.address)
      // 工作区是绝对路径 → 会话作用域地址里出现双斜杠，这是宿主 parseFileAddress 认的形状。
      assert.ok(address.startsWith('dsh-resource://file/session/sess-1//'), address)
      assert.ok(address.endsWith('/.dsh/sidebar-qr.png'), address)
      assert.ok(existsSync(path.join(workspace, '.dsh', 'sidebar-qr.png')), '图必须落在会话工作区的 .dsh 下')
      assert.equal(existsSync(fallback), false, '工作区解析得出来时不该再往兜底位置写')
    })
  } finally {
    cleanup()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('工作区解析不出来（老主插件 / 服务形状不对）：退回配置里的 imageFile，两边仍指同一个文件', async () => {
  const { file: fallback, cleanup } = tempImageFile()
  try {
    const setupResult = setup({
      remote: remoteWith(pairingWith('dsh-rc://pair?psk=fake-psk', Date.now() + 60_000), () => {
        throw new Error('跨包调用炸了')
      }),
    })
    await withTimers(async () => {
      apply(setupResult.ctx, { imageFile: fallback, refreshMs: 1000 })
      const answer = await waitFor(async () => {
        const got = await askRoute(setupResult.routes[0]!, '/?session=sess-1')
        return got.status === 200 && got.body.state === 'ready' ? got : undefined
      })
      assert.ok(String(answer.body.address).endsWith(encodeURIComponent(path.basename(fallback))))
      assert.ok(existsSync(fallback), '兜底落点必须真的写出文件')
    })
  } finally {
    cleanup()
  }
})

test('落盘写不进去 → 200 + none，绝不交出指向不存在文件的地址', async () => {
  const { file: fallback, cleanup } = tempImageFile()
  const workspace = mkdtempSync(path.join(tmpdir(), 'drc-entry-badws-'))
  try {
    // 把"工作区"指到一个**文件**上：`<文件>/.dsh/` 建不出来，writePrivatePng 必然 false。
    const notADir = path.join(workspace, 'not-a-dir')
    writeFileSync(notADir, 'x')
    // 这个计数是"路由真的走到了落点解析那一步"的证据：只有快照 ready 才会去问工作区，
    // 于是它排除了"tick 还没跑完所以答 none"这种假绿。
    let asked = 0
    const setupResult = setup({
      remote: remoteWith(pairingWith('dsh-rc://pair?psk=fake-psk', Date.now() + 60_000), () => {
        asked += 1
        return notADir
      }),
    })
    await withTimers(async () => {
      apply(setupResult.ctx, { imageFile: fallback, refreshMs: 1000 })
      await waitFor(async () => {
        const got = await askRoute(setupResult.routes[0]!, '/?session=sess-1')
        return asked > 0 ? got : undefined
      })
      const answer = await askRoute(setupResult.routes[0]!, '/?session=sess-1')
      assert.deepEqual(answer.body, { state: 'none' })
      assert.equal(existsSync(fallback), false, '兜底位置也不该被写：写不成就不该交地址')
    })
  } finally {
    cleanup()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('过期的码：路由一直答 none，且绝不落盘', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({ remote: remoteWith(pairingWith('dsh-rc://pair?psk=fake-psk', Date.now() - 1)) })
    await withTimers(async () => {
      apply(setupResult.ctx, { imageFile: file, refreshMs: 1000 })
      await new Promise((resolve) => setTimeout(resolve, 120))
      const answer = await askRoute(setupResult.routes[0]!, '/?session=sess-1')
      assert.deepEqual(answer, { status: 200, body: { state: 'none' } })
      assert.equal(existsSync(file), false, '过期的码不该写出任何文件')
    })
  } finally {
    cleanup()
  }
})

test('只有 dshRemoteControl、没有 webServer：什么都不做（图落了盘也没人知道地址）', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({ web: false })
    await withTimers((captured) => {
      apply(setupResult.ctx, { imageFile: file, refreshMs: 1000 })
      assert.equal(setupResult.routes.length, 0)
      assert.equal(captured.ticks.length, 0)
    })
  } finally {
    cleanup()
  }
})

test('服务改从 inject 回调（作用域上下文）里拿：同样能起', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({ get: false, scopedInject: true })
    await withTimers((captured) => {
      apply(setupResult.ctx, { imageFile: file, refreshMs: 1000 })
      assert.equal(setupResult.routes.length, 1)
      assert.equal(captured.ticks.length, 1)
    })
  } finally {
    cleanup()
  }
})

test('探测本身抛错（宿主 ctx 是 Proxy，读不存在的属性会抛）：apply 绝不外抛', () => {
  const ctx: Record<string, unknown> = {
    get: () => {
      throw new Error('cannot get property "webServer" without inject')
    },
    inject: () => {
      throw new Error('cannot get property "inject" without inject')
    },
    effect: () => {
      throw new Error('cannot get property "effect" without inject')
    },
  }
  assert.doesNotThrow(() => apply(ctx, { enabled: true }))
})

test('disabled：直接不做事', async () => {
  const setupResult = setup({})
  await withTimers((captured) => {
    apply(setupResult.ctx, { enabled: false })
    assert.equal(setupResult.routes.length, 0)
    assert.equal(captured.ticks.length, 0)
  })
})

test('卸载：effect 的注销函数把路由与节拍一起收回', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({})
    await withTimers((captured) => {
      apply(setupResult.ctx, { imageFile: file, refreshMs: 1000 })
      assert.equal(setupResult.disposers.length, 1, '必须登记卸载钩子')
      assert.equal(setupResult.unregistered(), 0)
      setupResult.disposers[0]!()
      assert.equal(setupResult.unregistered(), 1, '路由要注销')
      assert.equal(captured.cleared, 1, '节拍要清掉')
      // 重复调用是幂等的（宿主可能既 dispose fiber 又走 onDispose）。
      setupResult.disposers[0]!()
      assert.equal(setupResult.unregistered(), 1)
      assert.equal(captured.cleared, 1)
    })
  } finally {
    cleanup()
  }
})

test('没有 effect 口的代际：退回 onDispose，且仍能收回', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({ effect: false, onDispose: true })
    await withTimers(() => {
      apply(setupResult.ctx, { imageFile: file, refreshMs: 1000 })
      assert.equal(setupResult.routes.length, 1)
      assert.equal(setupResult.disposers.length, 1)
      setupResult.disposers[0]!()
      assert.equal(setupResult.unregistered(), 1)
    })
  } finally {
    cleanup()
  }
})
