/**
 * pill-isolation.test — "界面上那一半不许连累配对链路"这条隔离的对照测试。
 *
 * 2026-10-03 这一半原来是右栏自动弹码 + 一条只读路由；现在它是状态栏那颗 pill 的四条路由
 * （发码 / 图 / 状态 / 退出配对）。隔离的形状没变：**它需要宿主的 `webServer` 服务，
 * 而主插件刻意不写任何 `inject:` 闸门**，所以"这代宿主没这个服务"时只有这一旁路不起，
 * 配对、中继、状态快照一行都不受影响。原来这条隔离是靠"拆成两个 cordis 条目"这个结构
 * 提供的，现在由 `src/pill/start.ts` 的软探测提供——所以必须有对照测试钉住，
 * 否则"结构"没了，隔离也就没了。
 *
 * 判据的形式是**对照**而不是"没报错就行"：同一个假上下文跑两遍 `apply()`，唯一的差别是
 * 有没有 `webServer`，然后要求主链路上每一项可观察状态**逐字段相等**、字段集合逐个相同。
 * 为什么必须做到这个强度：本插件真实发生过的最坏故障是 fiber 被标 FAILED →
 * 宿主把它那几个 `ctx.inject` 子 fiber 一起 dispose → carrier=none、配对链路整条没
 * （取证见 `src/index.ts` apply() 里那条纪律）。"没抛异常"抓不到这种形状，而对照能。
 *
 * 四种 webServer 形态都覆盖：① 没这个服务；② 有，正常挂上；③ 有但 `register()` 抛错
 * （路由名被别的插件占了）；④ 有，但 `pill.enabled:false` 显式关掉。③ 与 ④ 最阴，
 * 因为它们是"我们这一半失败/被关"在宿主的对象上。
 *
 * 另外两条与 2026-10-03 那轮删除直接相关：**配对入口不可用时必须有 `warn:pill`**
 * （`/drc` 命令与终端文本码都删了，路由没挂上就没有任何配对入口，不留痕就是静默失败）；
 * 以及**不再注册任何命令**（`/drc` 整条已删，命令注册这条路不该再被碰）。
 *
 * 中继一律指 `ws://127.0.0.1:1`（必然拒绝），这样"连不上"是确定的而不是竞态。
 * 载具的等待由 `waitForCarrier()` 轮询（见下），不靠任何"宽限期配置"——
 * `carrierGraceMs` 这个键 2026-10-06 已删（全 src 零读取，见 shell/config.ts）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.js'
import {
  PAIR_IMAGE_ROUTE,
  PAIR_NEW_ROUTE,
  PAIR_STATUS_ROUTE,
  PAIR_UNPAIR_ROUTE,
  registerPillRoutes,
  type PillRouteDeps,
} from '../src/pill/routes.js'
import { startPill } from '../src/pill/start.js'

/** 一眼假的 token：仓库里不许出现真凭据，这条只验形状（同 status.test.ts）。 */
const FAKE_TOKEN = 'fake-host-token-not-a-real-secret-0123456789abcdef'

/**
 * 主链路上可比对的稳定字段。`pill` 与 `problems` 单独断言（它们**应该**随 webServer 有无而变），
 * `relay`/`probe` 有时序所以另做形状断言（见 waitForCarrier 的注释）。
 */
const MAIN_LINK_KEYS = [
  'carrier',
  'conversations',
  'pendingPairs',
  'mockBridgeForced',
  'hostTokenShape',
  'serverUrl',
  'hostLabel',
  'unarchiveOnPrompt',
] as const

interface RegisterCall {
  path: string
  kind: string
  /** 挂上去的真实 handler——接线测试就是打它，不是再自己拼一遍 deps。 */
  handler?: (request: unknown, response: unknown) => unknown
}

/**
 * 假 ctx 的 `get`。cordis 那侧的签名是泛型的（`get<T>(name, optional?) => T | undefined`），
 * 写成 `(name: string) => 具体对象 | undefined` 会在 `apply(ctx)` 的边界上红——
 * 所以这里保持泛型，值在内部断言一次。
 */
function fakeGet(byName: Record<string, unknown>): <T>(name: string, optional?: true) => T | undefined {
  return <T>(name: string): T | undefined => byName[name] as T | undefined
}

interface Booted {
  state(): Record<string, unknown>
  /**
   * 注册出去的**命令**个数。`/drc` 整条已删（2026-10-03），所以这个数必须恒为 0——
   * 留着它不是"还能注册"，而是钉住"这条路上不该再有东西"。
   */
  commandCount: number
  providedKeys: string[]
  registerCalls: RegisterCall[]
  unregistered: () => number
  /**
   * 只有 `lateWeb` 模式有意义：把宿主欠我们的那次 `ctx.inject(['webServer'], cb)` 回调补上，
   * 演"服务在 apply 返回**之后**才到"。真机上就是这个形状——2026-10-03 重启后 `status.json`
   * 同时写着 `routes:"registered"` 和 `problems:["warn:pill"]`，因为那条 warn 曾是在 apply
   * 里一次性 push 的启动快照。
   */
  flushInject(): void
  waitForCarrier(): Promise<Record<string, unknown>>
  dispose(): void
}

function boot(
  options: {
    webServer?: unknown
    /** `register()` 一律抛（路由名被占）。 */
    registerThrows?: boolean
    /** 只有第 N 条之后抛——用来演"三条里挂上一部分"。 */
    registerThrowsFrom?: number
    pillEnabled?: boolean
    /**
     * `webServer` 不在 `ctx.get` 上给，只在 `flushInject()` 之后才"到"——
     * 演真机那个形状：注入回调可能在 `apply()` 返回之后才触发。
     */
    lateWeb?: boolean
  } = {},
): Booted {
  const disposers: Array<() => void> = []
  const provided: Record<string, unknown> = {}
  const registerCalls: RegisterCall[] = []
  let commandCount = 0
  let unregistered = 0
  let disposed = false
  const statusDir = mkdtempSync(path.join(tmpdir(), 'drc-isolation-'))

  const wantsWeb =
    options.webServer !== undefined ||
    options.lateWeb !== undefined ||
    options.registerThrows !== undefined ||
    options.registerThrowsFrom !== undefined ||
    options.pillEnabled !== undefined
  const web = wantsWeb
    ? {
        register: (route: RegisterCall) => {
          registerCalls.push(route)
          if (options.registerThrows) throw new Error('这个路由名已经被占了')
          if (options.registerThrowsFrom !== undefined && registerCalls.length > options.registerThrowsFrom)
            throw new Error('这条路径宿主不给挂')
          return () => {
            unregistered += 1
          }
        },
      }
    : undefined

  // `lateWeb` 时 apply 那一刻这里是空的：ctx.get('webServer', true) 拿不到，只有
  // flushInject() 把服务放进来了才算"晚到"。对象引用被 fakeGet 闭包捕获，所以 mutation 有效。
  const services: Record<string, unknown> = web && !options.lateWeb ? { webServer: web } : {}
  const pendingInject: Array<() => void> = []

  const context = {
    // 假的/非 cordis 上下文：命令这一路留着只为**计数**——`/drc` 已删，这里必须恒为 0。
    get: fakeGet(services),
    inject: (names: string[], callback: (scoped: never) => void) => {
      // 只欠 `webServer` 那一条：别的注入保持原样（从不触发），否则这条 fixture 会变竞态测试。
      if (options.lateWeb && names.includes('webServer')) {
        // 真 cordis 会把一个"只能读 webServer"的作用域上下文当参数传进来；这里给一个
        // 假的 get-only 上下文，走的正是 pill.ts 里 pickFrom() 的第一条读法。
        pendingInject.push(() => callback({ get: fakeGet(services) } as never))
      }
      return () => undefined
    },
    provide: (name: string, value: unknown) => {
      provided[name] = value
    },
    commands: {
      register: () => {
        commandCount += 1
      },
    },
    on: () => () => undefined,
    off: () => undefined,
    onDispose: (fn: () => void) => void disposers.push(fn),
  }

  apply(context, {
    enabled: true,
    // 故意不可达：这条要的是"中继连不上"这个确定分支，不许它真连上任何东西。
    serverUrl: 'ws://127.0.0.1:1',
    hostToken: FAKE_TOKEN,
    hostId: 'isolation_host',
    // 本机名还在**状态快照**里（配置回显那一路），只是 pill 弹窗里已经撤了（现在那三行是中继/状态/版本）。
    hostLabel: 'linbin-desk',
    statusFile: path.join(statusDir, 'status.json'),
    mockBridge: true,
    pairOnStartSec: 0,
    pill: { enabled: options.pillEnabled ?? true },
  })

  const service = provided.dshRemoteControl as
    | {
        state?: Record<string, unknown>
      }
    | undefined

  return {
    state: () => service?.state ?? { relay: 'not-provided' },
    get commandCount() {
      return commandCount
    },
    providedKeys: Object.keys(provided),
    registerCalls,
    unregistered: () => unregistered,
    flushInject(): void {
      if (web) services.webServer = web
      for (const fire of pendingInject.splice(0)) fire()
    },
    /**
     * 等到"载具已决定 + 中继真的走完一次连接尝试"，并**返回那一刻的快照**。
     *
     * 为什么必须返回快照而不是让断言各自再读一次：中继的保活重连在跑，
     * `relay` 会在 `offline ⇄ connecting` 之间跳。CI（Node 20 作业）上实测抓到过
     * "等载具时读到 offline，回头再读变成 connecting"导致的假红。
     * 对照测试要比的是**同一时刻的两份状态**，所以等待条件与取样必须是同一次动作。
     */
    async waitForCarrier() {
      const deadline = Date.now() + 8000
      for (;;) {
        const state = service?.state ?? {}
        if (state.carrier === 'mock' && state.relay === 'offline') return state
        if (Date.now() > deadline) {
          throw new Error(
            `等不到"载具决定 + 中继走完一次连接尝试"：${JSON.stringify(service?.state ?? {}).slice(0, 220)}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
    dispose(): void {
      // 有守卫：主插件的 stop() 不做幂等保护（relay.stop() 被调两次会重复 removeAllListeners），
      // 而这条测试故意会在断言中途 dispose 一次、finally 再 dispose 一次。
      if (disposed) return
      disposed = true
      for (const fn of disposers.splice(0)) {
        try {
          fn()
        } catch {
          /* 关停失败不该污染断言结果 */
        }
      }
      rmSync(statusDir, { recursive: true, force: true })
    },
  }
}

/** 快照里那条 `warn:pill`（配对入口不可用）；没有就返回 undefined。 */
function pillProblem(state: Record<string, unknown>): string | undefined {
  const problems = (state.problems ?? []) as string[]
  return problems.find((entry) => entry === 'warn:pill')
}

test('缺 webServer：provide 照常、一个命令都没注册，路由一次都没去挂，但配对入口不可用要说话', async () => {
  const without = boot({})
  try {
    const state = await without.waitForCarrier()
    assert.equal(without.commandCount, 0, '/drc 整条已删，命令注册这条路不该再被碰')
    assert.deepEqual(without.providedKeys, ['dshRemoteControl'], 'provide 必须照常发生')
    assert.equal(without.registerCalls.length, 0, '没有 webServer 就不该有人去挂路由')
    // 这条是"配不了对"的排查入口：probe 必须说清是没探到，而不是沉默。
    assert.equal((state.pill as Record<string, string>).webServer, 'none')
    assert.equal(state.relay, 'offline', `中继应当明确连不上（收到 ${String(state.relay)}）`)
    // **删掉命令行兜底之后新加的那道锁**：没入口这件事必须落在 problems 里，
    // 而"为什么没入口"必须能从同一个快照的探针里读出来（problems 只带 `level:field`）。
    assert.equal(pillProblem(state), 'warn:pill', `必须有 warn:pill 一条：${JSON.stringify(state.problems)}`)
    assert.equal(
      (state.pill as Record<string, string>).webServer,
      'none',
      '探针要指得出是"没探到 webServer"，否则那条 warn 等于只说了"不行"',
    )
  } finally {
    without.dispose()
  }
})

test('webServer 晚到（注入回调在 apply 返回之后才触发）：挂上之后 warn:pill 必须自己消失', async () => {
  // 真机的形状：`webServer` 是 `ctx.inject` 的回调给的，可能在 apply 返回之后才到。
  // 那条 warn 曾经是在 apply 里一次性 push 进 `problems` 的，于是启动快照会永远带着
  // "配对入口不可用"，哪怕四条路由后来挂上了——2026-10-03 重装重启后 status.json 里
  // `routes:"registered"` 与 `problems:["warn:pill"]` 并存，就是这么来的。
  const late = boot({ webServer: true, lateWeb: true })
  try {
    const early = late.state()
    assert.equal((early.pill as Record<string, string>).webServer, 'none', 'apply 那一刻还没拿到服务')
    assert.equal(pillProblem(early), 'warn:pill', '还没挂上时报 warn 是对的，这条不是误伤')

    late.flushInject()
    const state = await late.waitForCarrier()
    assert.equal((state.pill as Record<string, string>).webServer, 'via inject')
    assert.equal((state.pill as Record<string, string>).routes, 'registered', '四条路由补挂上了')
    assert.equal(late.registerCalls.length, 4, '四条一起挂')
    assert.equal(
      pillProblem(state),
      undefined,
      `routes 已 registered 却还报 warn:pill = 启动快照的假警报：${JSON.stringify(state.problems)}`,
    )
    late.dispose()
    assert.equal(late.unregistered(), 4, '晚到挂上的路由，停机时同样要注销干净')
  } finally {
    late.dispose()
  }
})

test('对照：主链路字段逐个相等、字段集合逐个相同，差别只允许出现在 pill 与那条 warn 上', async () => {
  const without = boot({})
  const withWeb = boot({ webServer: true })
  try {
    const a = await without.waitForCarrier()
    const b = await withWeb.waitForCarrier()
    for (const key of MAIN_LINK_KEYS) {
      assert.deepEqual(
        b[key],
        a[key],
        `主链路字段 ${key} 因为多了个 webServer 就变了：${JSON.stringify(a[key])} → ${JSON.stringify(b[key])}`,
      )
    }
    // 反证：上面那个循环不是"两边都空所以相等"。主链路必须真的有内容。
    assert.equal(a.carrier, 'mock', `载具应当是 mock（收到 ${String(a.carrier)}）`)
    assert.equal(a.relay, 'offline', `中继状态应当已经落到 offline（收到 ${String(a.relay)}）——否则这轮对照没有牙`)
    assert.equal(
      JSON.stringify(
        Object.keys(a)
          .filter((key) => key !== 'pill' && key !== 'problems')
          .sort(),
      ),
      JSON.stringify(
        Object.keys(b)
          .filter((key) => key !== 'pill' && key !== 'problems')
          .sort(),
      ),
      '两边快照的字段集合必须一致：少一个字段就是主链路被连带了',
    )

    // 命令这一路已经没有了（`/drc` 2026-10-03 整条删）：两边都不许冒出任何命令。
    assert.equal(without.commandCount, 0, '没有 webServer 时也不许注册命令')
    assert.equal(withWeb.commandCount, 0, '有 webServer 时同样不许注册命令')

    // 唯一允许的两处差别，都要精确断言而不是"允许不同"。
    assert.equal((a.pill as Record<string, string>).webServer, 'none')
    assert.equal((b.pill as Record<string, string>).webServer, 'via get')
    assert.equal((b.pill as Record<string, string>).routes, 'registered', '四条路由一起挂上')
    assert.deepEqual(
      withWeb.registerCalls.map((call) => call.path),
      [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE, PAIR_UNPAIR_ROUTE],
      '四条路由一起挂：发码 + 弹窗的图 + 抬头状态 + 退出配对',
    )
    // problems 的差别必须是**恰好那一条** warn:pill，多一条少一条都算红。
    assert.ok(pillProblem(a), '没 webServer 那侧必须有 warn:pill')
    assert.equal(pillProblem(b), undefined, '挂上了就不该再有 warn:pill')
    assert.deepEqual(
      (a.problems as string[]).filter((entry) => !entry.startsWith('warn:pill')),
      b.problems as string[],
      '除了那一条，两边的 problems 必须逐字相同',
    )
    assert.equal(without.unregistered(), 0)
    // 停机要连着把路由注销掉：漏了的话换一代宿主会撞上"路由名已占用"，
    // 而表现是"重载一次之后那颗 pill 再也不出现"。这里在断言之后 dispose，两个 finally
    // 里的 dispose 是同一次（helper 内部有 once 守卫）。
    withWeb.dispose()
    assert.equal(withWeb.unregistered(), 4, '四条路由都要注销')
  } finally {
    without.dispose()
    withWeb.dispose()
  }
})

test('配对入口只有 pill：两种宿主上都不注册任何命令，凭据也就无从经命令行外泄', async () => {
  const without = boot({})
  const withWeb = boot({ webServer: true })
  try {
    await without.waitForCarrier()
    await withWeb.waitForCarrier()
    for (const [label, booted] of [
      ['没 webServer', without],
      ['有 webServer', withWeb],
    ] as const) {
      assert.equal(booted.commandCount, 0, `${label} 这一侧不该注册任何命令（/drc 已整条删掉）`)
    }
  } finally {
    without.dispose()
    withWeb.dispose()
  }
})

test('register() 抛错（路由名被占）：只废掉界面那一半，命令与中继不受影响，且报 warn:pill', async () => {
  const hostile = boot({ registerThrows: true })
  const control = boot({})
  try {
    const state = await hostile.waitForCarrier()
    const baseline = await control.waitForCarrier()
    assert.equal(hostile.commandCount, 0, '我们这一半失败，也不许冒出命令')
    assert.equal(state.relay, baseline.relay, '中继状态不许因为路由失败而变')
    assert.equal(state.carrier, baseline.carrier, '载具状态不许因为路由失败而变')
    assert.ok(
      String((state.pill as Record<string, string>).routes ?? '').startsWith('register threw'),
      '路由注册抛错必须在 probe 里留痕，不然排查时会以为是"没有码"：' + JSON.stringify(state.pill),
    )
    assert.equal(hostile.registerCalls.length, 1, '第一条注册就抛了，后三条不该再试')
    assert.ok(pillProblem(state), '挂不上 = 没有配对入口，这条 warn 必须在')
  } finally {
    hostile.dispose()
    control.dispose()
  }
})

test('四条里只挂上两条：available 仍是 false——pill 点不开就是没有配对入口', async () => {
  const partial = boot({ registerThrowsFrom: 2 })
  try {
    const state = await partial.waitForCarrier()
    assert.equal(partial.registerCalls.length, 3, '第三条就抛了，所以只试到三条')
    assert.equal((state.pill as Record<string, string>).routes, 'register threw: 这条路径宿主不给挂')
    assert.ok(pillProblem(state), '只要有一条没挂上，pill 就点不开，必须报')
    partial.dispose()
    assert.equal(partial.unregistered(), 2, '挂上的那两条要收回；没挂上的不该留下半个注销')
  } finally {
    partial.dispose()
  }
})

test('pill.enabled=false：显式关掉唯一配对入口，路由一条都不挂，但必须说话', async () => {
  const off = boot({ webServer: true, pillEnabled: false })
  try {
    const state = await off.waitForCarrier()
    assert.equal(off.registerCalls.length, 0, '关掉了就不该去挂路由')
    assert.equal((state.pill as Record<string, string>).pill, 'disabled')
    assert.equal(off.commandCount, 0, '关掉界面入口也不该冒出命令（本来就没有了）')
    assert.equal(state.relay, 'offline')
    // 这一条是"代价要能被查见"的锁：默认值是开，所以只有用户自己关才会走到这里，
    // 而关掉之后这台主机就没有任何配对入口了——不说话的静默失败是最难查的那种。
    assert.equal(pillProblem(state), 'warn:pill', `关掉唯一入口必须留一条 warn：${JSON.stringify(state.problems)}`)
    assert.equal(
      (state.pill as Record<string, string>).pill,
      'disabled',
      '探针要分清"用户关的"与"挂不上"，否则运维会去查宿主的毛病',
    )
  } finally {
    off.dispose()
  }
})

test('pill 那四条挂上去的就是带守卫的那四条（接线，不是又拼一遍 deps）', async () => {
  const withWeb = boot({ webServer: true })
  try {
    const state = await withWeb.waitForCarrier()
    assert.equal(state.relay, 'offline', '这条 fixture 的中继是故意不可达的')
    // 四条都在、顺序与 registerPillRoutes 一致。
    assert.deepEqual(
      withWeb.registerCalls.map((call) => call.path),
      [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE, PAIR_UNPAIR_ROUTE],
      '四条路由一起挂：发码 + 弹窗的图 + 抬头状态 + 退出配对',
    )

    const handlerFor = (p: string) => {
      const found = withWeb.registerCalls.find((call) => call.path === p)
      assert.ok(found?.handler, `${p} 没挂上或没带 handler：${JSON.stringify(withWeb.registerCalls)}`)
      return found!.handler as (request: unknown, response: unknown) => unknown
    }
    const run = async (p: string, method: string, headers: Record<string, string>) => {
      let status = 0
      let body = ''
      const res = {
        writeHead: (code: number) => {
          status = code
        },
        end: (chunk?: unknown) => {
          body = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
        },
      }
      await handlerFor(p)({ method, url: '/', headers }, res)
      return { status, body }
    }

    // 发码：真机那个形状（环回 Host + 自定义头，**没有 Origin**）走通，
    // 落到"现在发不出码"这个确定分支。
    const ok = await run(PAIR_NEW_ROUTE, 'POST', { host: '127.0.0.1:5173', 'x-drc-pair': '1' })
    assert.equal(ok.status, 200, ok.body)
    assert.deepEqual(JSON.parse(ok.body), { state: 'unavailable', reason: 'relay-offline' })

    // 被拒的几种形状都要在**挂上去的那条**上生效，而不是只在单元测试里生效。
    const noMarker = await run(PAIR_NEW_ROUTE, 'POST', { host: '127.0.0.1:5173' })
    assert.equal(noMarker.status, 403, '少了自定义头就该拒')
    assert.equal(JSON.parse(noMarker.body).guard, 'pair-marker-missing')
    assert.equal(
      (
        await run(PAIR_NEW_ROUTE, 'POST', {
          host: '127.0.0.1:5173',
          'x-drc-pair': '1',
          origin: 'https://evil.example.com',
        })
      ).status,
      403,
      '跨站 Origin',
    )
    assert.equal(
      (await run(PAIR_NEW_ROUTE, 'POST', { host: '127.0.0.1:5173', 'x-drc-pair': '1', origin: 'dsh-app://app' }))
        .status,
      200,
      '宿主自己的自定义 scheme 算"自己"——真机上文档 origin 就是这个形状',
    )
    assert.equal((await run(PAIR_NEW_ROUTE, 'GET', { host: '127.0.0.1:5173', 'x-drc-pair': '1' })).status, 405)

    // 图片：没有效码 → 204；非环回 Host → 403。
    assert.equal((await run(PAIR_IMAGE_ROUTE, 'GET', { host: '127.0.0.1:5173' })).status, 204)
    assert.equal((await run(PAIR_IMAGE_ROUTE, 'GET', { host: 'evil.example.com' })).status, 403)

    // 退出配对：真机形状（环回 Host + 自定义头，没有 Origin）→ 200；GET → 405；少了头 → 403。
    const unpaired = await run(PAIR_UNPAIR_ROUTE, 'POST', { host: '127.0.0.1:5173', 'x-drc-pair': '1' })
    assert.equal(unpaired.status, 200, unpaired.body)
    assert.deepEqual(JSON.parse(unpaired.body), { state: 'ok', unpaired: 0 }, '这台没配上，unpaired=0 也是成功')
    assert.equal((await run(PAIR_UNPAIR_ROUTE, 'GET', { host: '127.0.0.1:5173', 'x-drc-pair': '1' })).status, 405)
    assert.equal((await run(PAIR_UNPAIR_ROUTE, 'POST', { host: '127.0.0.1:5173' })).status, 403)

    // 抬头那句状态 + 点开那几行（待处理 / 中继 / 状态 / 版本）：只读（Origin 缺席放过），字段集合就那六个。
    // `relay` 允许 offline / connecting 两种——保活重连在跑，这里钉死一种就是计时器测试。
    const status = await run(PAIR_STATUS_ROUTE, 'GET', { host: '127.0.0.1:5173' })
    assert.equal(status.status, 200, status.body)
    const shown = JSON.parse(status.body) as Record<string, unknown>
    assert.deepEqual(
      Object.keys(shown).sort(),
      ['paired', 'pairings', 'relay', 'serverUrl', 'version', 'waiting', 'waitingOldestSec'],
      '状态路由多出字段就是要重新审一遍（这七个全是非凭据；本机名 2026-10-03 撤了）',
    )
    assert.ok(shown.relay === 'offline' || shown.relay === 'connecting', `relay 取值：${String(shown.relay)}`)
    assert.equal(shown.paired, 0)
    assert.equal(shown.serverUrl, 'ws://127.0.0.1:1', '中继地址就是插件连的那个，浏览器面不许自己猜')
    // 版本号只有 bundle 那一步的 define 能给出；这里跑的是源码，必须落回 dev——
    // 那条 assert 钉的就是 version.ts 的兜底，别哪天把它变成 undefined 送上屏幕。
    assert.equal(shown.version, 'dev', `源码直跑的版本必须是 dev：${String(shown.version)}`)

    // 凭据红线：这条走的是**挂上去的**那条发码路由。此刻中继不可达，所以它回的是
    // `unavailable`——那种回答本来就不含 token，把凭据断言跑在它上面是**空断言**
    // （2026-10-06 修：那时候 `!ok.body.includes('psk')` 永远成立，因为它连 token 都没有）。
    // 这里只钉"发不出码的回答恰好是这两个字段"；真正的凭据红线钉在下面
    // 「凭据红线：真发码那一条回答里只有 token」那一条上（那里喂的是一张真码）。
    assert.deepEqual(
      Object.keys(JSON.parse(ok.body)).sort(),
      ['reason', 'state'],
      `发不出码的回答只该有这两个字段：${ok.body}`,
    )
    assert.ok(!ok.body.includes('psk'), `回答里出现了 psk：${ok.body}`)
    assert.ok(!ok.body.includes('dshr:'), `回答里出现了配对 URI：${ok.body}`)
  } finally {
    withWeb.dispose()
  }
})

test('凭据红线：真发码（state:"ready"）那一条回答里只有 token，没有 psk / dshr: / 完整 URI', async () => {
  // 用**与插件同一个注册入口**（`registerPillRoutes`）挂上四条，再打那条发码路由：
  // 只差"中继可达"这一个条件——中继在这套夹具里故意不可达，所以真码由 deps 直接给。
  const fakePsk = 'A'.repeat(64)
  const fakeToken = '482913'
  const fakeQr = `dshr:/p?v=1&s=ws://relay&n=host&psk=${fakePsk}&t=${fakeToken}`
  const live = { qr: fakeQr, token: fakeToken, expiresAt: Date.now() + 60_000 }
  const handlers = new Map<string, (request: unknown, response: unknown) => unknown>()
  const web = {
    register: (route: { path: string; handler: (request: unknown, response: unknown) => unknown }) => {
      handlers.set(route.path, route.handler)
      return () => handlers.delete(route.path)
    },
  }
  const unregister = registerPillRoutes(web as never, {
    ensureFresh: () => live,
    current: () => live,
    status: () => ({
      relay: 'online',
      paired: 0,
      pairings: 0,
      serverUrl: 'wss://relay.example.com:443/relay',
      version: 'dev',
      waiting: 0,
      waitingOldestSec: 0,
    }),
    unpair: () => 0,
    log: () => {},
  } satisfies PillRouteDeps)
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number) => {
      status = code
    },
    end: (chunk?: unknown) => {
      body = typeof chunk === 'string' ? chunk : ''
    },
  }
  try {
    const handler = handlers.get(PAIR_NEW_ROUTE)
    assert.ok(handler, '发码那条必须挂上')
    await handler!({ method: 'POST', url: '/', headers: { host: '127.0.0.1:5173', 'x-drc-pair': '1' } }, res)
  } finally {
    unregister()
  }
  assert.equal(status, 200, body)
  const answer = JSON.parse(body) as Record<string, unknown>
  assert.equal(answer.state, 'ready', '前提：这一次真的发了一张码')
  assert.equal(answer.token, fakeToken, '6 位码要给——弹窗上"或手输这 6 位数字"靠它')
  assert.deepEqual(
    Object.keys(answer).sort(),
    ['epoch', 'expiresInMs', 'state', 'token'],
    `真发码的回答只该有这四个字段：${body}`,
  )
  for (const secret of [fakePsk, fakeQr, 'psk', 'dshr:']) {
    assert.ok(!body.includes(secret), `真发码的回答里出现了 ${secret}：${body}`)
  }
})

test('startPill：stop() 之后 available 必须变 false——路由都摘了还说入口在，主插件就不再报 warn:pill', () => {
  const registered: string[] = []
  let unregistered = 0
  const web = {
    register: (route: { path: string }) => {
      registered.push(route.path)
      return () => {
        unregistered += 1
      }
    },
  }
  const handle = startPill({ get: fakeGet({ webServer: web }) }, {
    enabled: true,
    ensureFresh: () => null,
    current: () => null,
    status: () => ({
      relay: 'idle',
      paired: 0,
      pairings: 0,
      serverUrl: 'ws://127.0.0.1:1',
      version: 'dev',
      waiting: 0,
      waitingOldestSec: 0,
    }),
    unpair: () => 0,
    log: () => {},
  } satisfies PillRouteDeps & { enabled: boolean })
  assert.equal(handle.available, true, '四条挂上了就该说可用')
  assert.deepEqual(registered, [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE, PAIR_UNPAIR_ROUTE])
  handle.stop()
  assert.equal(unregistered, 4, '停机要把四条一起注销')
  assert.equal(
    handle.available,
    false,
    'stop() 之后仍说可用 = 快照会说"配对入口在"，而它已经被摘干净了（表现是"配不了对且没人说为什么"）',
  )
  assert.equal(handle.probe.routes, 'registered', 'probe 里"起过"的留痕可以留，但 available 必须跟着停')
  handle.stop() // 幂等：再停一次不许变回 true
  assert.equal(handle.available, false)
})
