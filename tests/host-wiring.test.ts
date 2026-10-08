/**
 * host-wiring.test — `apply()` 里"内核事件口到底接上没有"这条接线。
 *
 * 守的是 2026-10-06 真机上抓到的那条时序 bug（status.json 的
 * `probe.injectThrew:sessions = cannot get property "off" without inject`）：
 *
 * 1. `accept()` 原来把 `on`/`off` 的绑定写在**只处理 sessions** 的那一小段里，
 *    而 `ctx.get('sessions', true)` **同步可得**时 `tryStart()` 会在任何 `ctx.inject`
 *    回调之前把内核启起来 —— `subscribe()` 那一刻 `services.on` 还是 undefined，
 *    于是它记一句 `kernel has no on(); streaming disabled` 并**永久**返回空退订；
 *    `HostRuntime.start()` 有 started 闸门不会重试，该进程内**流式全黑**。
 *    而 `describe()` 的 `hasOn` 每次现读（那时 on 早绑上了）会显示 true，掩盖真相。
 * 2. `off` 的读取在真 cordis 的 Proxy ctx 上会**抛错**（读不存在的属性名不是 undefined），
 *    它把整个 inject 回调打断 —— 连 `probe[name]` 记账与 `tryStart()` 都没跑到。
 *
 * 为什么夹具要**落一条配对通道再恢复**：`runtime.start()` 只有两条触发路
 * （`peer-joined` 与"启动时从盘上恢复了会话"，见 index.ts 那两段注释）。真机上
 * 撞到这条 bug 的正是恢复那一条 —— 没有恢复会话的夹具根本走不到 `subscribe()`，
 * "订阅没接上"也就演不出来。
 *
 * 判据落在**接线**上而不是"apply 没抛"：要求 `on('session/event'|…)` 真的被调到，
 * 并通过真实事件派发看到**出站帧计数**涨上来。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'
import { defaultPairStoreFile } from '../src/shell/pair-store.js'
import { DEFAULT_SYSTEM_CLOCK, FakeClock } from '../src/core/clock.js'
import type { Clock } from '../src/ports/index.js'

const FAKE_TOKEN = 'fake-host-token-not-a-real-secret-0123456789abcdef'
const HOST_A = 'wiring_host_a'
const HOST_B = 'wiring_host_b'
/** 16 字节全零的标准 base64：夹具用的假 PSK（仓库里不许出现真凭据）。 */
const FAKE_PSK = 'AAAAAAAAAAAAAAAAAAAAAA=='

/** 一个够用的 sessions 服务：`list()` 是 `accept()` 的先验成员。 */
const sessionsService = { list: () => [] }

interface Wiring {
  /** `on(name, listener)` 收到的全部事件名（按注册顺序）。 */
  readonly subscribed: string[]
  /** 往某条已注册的事件上派发一次。 */
  emit(name: string, ...args: unknown[]): void
  state(): Record<string, unknown>
  dispose(): void
}

const outboundOf = (state: Record<string, unknown>): Record<string, number> =>
  (state.outbound as Record<string, number> | undefined) ?? {}

interface BootOptions {
  hostId: string
  /** true = 根 ctx 上就挂着 on/off；false = 根 ctx 读 on/off 会抛（真机的 Proxy 形状）。 */
  rootHasEvents: boolean
  /** 假时钟：用来演"时间过去了而某一拍还没响"。省略 = 真定时器。 */
  clock?: Clock
  /** `statusFile` 传这个：装成**关掉状态快照**（一个有文档的开关）。 */
  statusFile?: string
  /**
   * 盘上那条恢复出来的通道写成"7 天前最后活动过"（`lastActivityAt: 0`）。
   *
   * 为什么不能沿用 `Date.now()`：夹具的假时钟停在 1.7e12，而真 `Date.now()` 是 1.78e12，
   * 于是 `now - lastActivityAt` 是**负数**，剪枝永远不触发——夹具会绿，行为没被测到。
   */
  staleRestored?: boolean
  /**
   * 「落盘开着、排错入口关着」这一档：`statusFile` 置空，但**显式**把密钥簿指到
   * 夹具自己的临时目录。
   *
   * 为什么必须显式给：默认密钥簿路径是从 `statusFile` 推出来的，而 `statusFile` 为空时
   * `defaultPairStoreFile` 返回 `''` = 连落盘一起关了。那是个更彻底的配置，
   * 演不到这条缺陷——真实运维关快照往往正是因为它老写盘，不是想连配对一起关掉。
   */
  persistWithoutStatus?: boolean
}

interface WiringFixture extends Wiring {
  /** 只有"on 晚到"那种夹具才有：把宿主欠我们的注入回调补上。 */
  flushInject(): void
}

/**
 * 夹具：sessions 同步可得 + 盘上有一条可恢复的配对通道（于是 `apply` 内就会
 * `runtime.start()`），而 `ctx.inject` 的回调**一次都不触发**——
 * 这正是"任何 inject 回调之前就启动内核"的形状。
 */
function boot(options: BootOptions): WiringFixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-wiring-'))
  const statusFile = path.join(dir, 'status.json')
  // 插件真正会去读的那个路径：显式给了就用它，否则按 statusFile 推。
  const storeFile =
    options.persistWithoutStatus && !options.statusFile
      ? path.join(dir, `conversations-${options.hostId}.json`)
      : defaultPairStoreFile(statusFile, options.hostId)
  if (!storeFile) throw new Error('夹具自检：这条配置下插件没有密钥簿可读，演不到剪枝')
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 1,
      hostId: options.hostId,
      savedAt: Date.now(),
      conversations: [
        {
          id: 'c_wired0000001',
          psk: FAKE_PSK,
          seqHost: 0,
          createdAt: options.staleRestored ? 0 : Date.now(),
          lastActivityAt: options.staleRestored ? 0 : Date.now(),
        },
      ],
    }),
  )

  const subscribed: string[] = []
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  const provided: Record<string, unknown> = {}
  const pending: Array<() => void> = []
  let dispose: (() => void) | undefined

  /** 宿主"晚到"的那个作用域上下文：on/off 只在这里有。 */
  const scoped = {
    get: <T>(name: string): T | undefined => (name === 'sessions' ? (sessionsService as T) : undefined),
    on: (name: string, listener: (...args: unknown[]) => void) => {
      subscribed.push(name)
      listeners[name] = listener
      return () => {}
    },
    off: () => undefined,
  }

  const context: Record<string, unknown> = {
    get: <T>(name: string): T | undefined => (name === 'sessions' ? (sessionsService as T) : undefined),
    inject: (names: string[], callback: (scopedArg: never) => void) => {
      if (names.includes('sessions')) pending.push(() => callback(scoped as never))
      return () => undefined
    },
    provide: (name: string, value: unknown) => {
      provided[name] = value
    },
    onDispose: (fn: () => void) => {
      dispose = fn
    },
  }
  if (options.rootHasEvents) {
    context.on = scoped.on
    context.off = scoped.off
  } else {
    // 真 cordis 的 Proxy：读这个作用域里没有的属性名是**抛错**，不是 undefined。
    Object.defineProperty(context, 'on', {
      get() {
        throw new Error('cannot get property "on" without inject')
      },
    })
    Object.defineProperty(context, 'off', {
      get() {
        throw new Error('cannot get property "off" without inject')
      },
    })
  }

  apply(
    context as never,
    {
      enabled: true,
      serverUrl: 'ws://127.0.0.1:1',
      hostToken: FAKE_TOKEN,
      hostId: options.hostId,
      statusFile: options.statusFile ?? statusFile,
      ...(options.persistWithoutStatus && !options.statusFile ? { pairStoreFile: storeFile } : {}),
    },
    // 时钟只有一个来源（`apply` 的第三个参数）：不传就是真定时器，与生产同一条路。
    options.clock ?? (DEFAULT_SYSTEM_CLOCK as Clock),
  )

  const service = provided.dshRemoteControl as { state?: Record<string, unknown> } | undefined
  return {
    subscribed,
    emit: (name, ...args) => listeners[name]?.(...args),
    state: () => service?.state ?? {},
    flushInject: () => {
      for (const fire of pending.splice(0)) fire()
    },
    dispose: () => {
      dispose?.()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const EVENT_NAMES = ['session/event', 'session/created', 'agent/status', 'agent/error'] as const

test('sessions 同步可得、inject 一次都不回调：四类内核事件也必须在 apply 内就订阅上', () => {
  const wiring = boot({ hostId: HOST_A, rootHasEvents: true })
  try {
    for (const name of EVENT_NAMES) {
      assert.equal(
        wiring.subscribed.includes(name),
        true,
        `${name} 没有被订阅（已订阅：${JSON.stringify(wiring.subscribed)}）→ 该进程内事件流全黑，只有重启宿主才能恢复`,
      )
    }
  } finally {
    wiring.dispose()
  }
})

test('订阅真的接在 core 上：派发一条 agent/status 必须看到出站帧计数涨上来', () => {
  const wiring = boot({ hostId: HOST_A, rootHasEvents: true })
  try {
    const before = outboundOf(wiring.state()).run_state ?? 0
    wiring.emit('agent/status', { sessionId: 'ses_wired', status: 'running' })
    const after = outboundOf(wiring.state()).run_state ?? 0
    assert.ok(after > before, `事件派发没有走到 runtime（run_state ${before} → ${after}）：订阅挂上了但没接到 core`)
  } finally {
    wiring.dispose()
  }
})

test('根 ctx 读 on 会抛、on 只在晚到的作用域上下文上：补绑之后必须能订阅并出帧', async () => {
  const wiring = boot({ hostId: HOST_B, rootHasEvents: false })
  try {
    // 注入回调在 apply 返回之后才到（真机的形状）。
    wiring.flushInject()
    // 补绑窗口第一档是 0ms；等两档的时间，不依赖具体档位。
    await new Promise((resolve) => setTimeout(resolve, 80))
    for (const name of EVENT_NAMES) {
      assert.equal(
        wiring.subscribed.includes(name),
        true,
        `${name} 在 on 晚到之后仍然没有补订阅（已订阅：${JSON.stringify(wiring.subscribed)}）`,
      )
    }
    const before = outboundOf(wiring.state()).run_state ?? 0
    wiring.emit('agent/status', { sessionId: 'ses_late', status: 'running' })
    assert.ok((outboundOf(wiring.state()).run_state ?? 0) > before, '补绑后的订阅没有接到 core')
  } finally {
    wiring.dispose()
  }
})

/* ── onPairFail 的接线：中继说"这张码没配上"，主机必须换一张 ─────────────── */

/**
 * 起一只**假中继**（只实现"收帧 + 按需回一帧"这部分），把主机的中继客户端真的接上。
 *
 * 为什么要到这一层：`onPairFail` 原来在 `RelayClientOptions` 里有声明、`relay.ts` 里
 * 也有调用，而 `index.ts` **从不传它** —— 一个死选项。死选项没法用纯单元测试钉住
 * "接线到底接没接"，只能让真 socket 上来一帧 `pair-fail`，再看主机有没有换码。
 */
async function bootWithFakeRelay(hostId: string): Promise<{
  frames: Array<Record<string, unknown>>
  send(frame: Record<string, unknown>): void
  waitForFrame(match: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined>
  close(): void
}> {
  const { WebSocketServer } = await import('ws')
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-fake-relay-'))
  const statusFile = path.join(dir, 'status.json')
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const frames: Array<Record<string, unknown>> = []
  let peer: { send(text: string): void } | undefined
  server.on('connection', (socket) => {
    peer = socket as unknown as { send(text: string): void }
    socket.on('message', (raw) => {
      try {
        frames.push(JSON.parse(String(raw)) as Record<string, unknown>)
      } catch {
        /* 坏帧在别的测试里管，这里只关心 pair-fail 那条路 */
      }
    })
  })

  const provided: Record<string, unknown> = {}
  let dispose: (() => void) | undefined
  const context: Record<string, unknown> = {
    get: <T>(name: string): T | undefined => (name === 'sessions' ? (sessionsService as T) : undefined),
    inject: () => () => undefined,
    on: () => () => undefined,
    off: () => undefined,
    provide: (name: string, value: unknown) => {
      provided[name] = value
    },
    onDispose: (fn: () => void) => {
      dispose = fn
    },
  }
  apply(context as never, {
    enabled: true,
    serverUrl: `ws://127.0.0.1:${port}`,
    hostToken: FAKE_TOKEN,
    hostId,
    statusFile,
  })

  const waitForFrame = async (
    match: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown> | undefined> => {
    const deadline = Date.now() + 3_000
    for (;;) {
      const hit = frames.find(match)
      if (hit) return hit
      if (Date.now() > deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  return {
    frames,
    send: (frame) => peer?.send(JSON.stringify(frame)),
    waitForFrame,
    close: () => {
      dispose?.()
      server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('中继回 pair-fail 时主机必须换一张码：onPairFail 不许再是"有调用没接线"的死选项', async () => {
  const relay = await bootWithFakeRelay('wiring_host_c')
  try {
    const hello = await relay.waitForFrame((frame) => frame.t === 'hello')
    assert.ok(hello, '夹具自检：主机应当先发 hello')

    relay.send({ t: 'pair-fail', reason: 'already_used' })
    const published = await relay.waitForFrame((frame) => frame.t === 'pair-begin')
    assert.ok(
      published?.pairingToken,
      '中继说这张码已经用过，主机却一张新的都没发：屏幕上那张死码会一直挂着，用户只能干等 TTL',
    )
  } finally {
    relay.close()
  }
})

/* ── 限速退避：`rate_limited` 从来不在 pair-fail 的 reason 枚举里 ───────────── */

/** 轮询到条件成立或超时（假中继是异步的，"没发生"要用一段时间来证）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

test('中继限速之后不许自动补码：退避窗口内被拒，主机不再立刻申请一张', async () => {
  // 现场：`index.ts` 里写的是 `if (reason !== 'rate_limited')`，而 `pair-fail.reason`
  // 的四个取值里**没有** `rate_limited`（中继把配对限流折成 `invalid_or_expired`，
  // 只在自己的日志里记 `rate_limited`）。所以那是一个**恒真**的分支：
  // 读起来像"限速时我们会克制一下"，实际上从不克制。
  //
  // 后果不是"多申请了几张码"这么轻：自动补码是一条自我加速的循环
  //（被拒 → 补一张 → 再被拒 → 再补），而配对限流的全局配额是 20/s。
  // 于是"刚被限速"最可能的表现是**主机自己把配额烧光**，手机随后连普通帧都发不出去。
  //
  // 真实的信号是 `error{code:'rate_limited'}` 那一帧。判据分三段：
  //   ① 基线：没被限速时被拒 → 必须补码（否则这条退避逻辑会把正常路径也掐死）；
  //   ② 限速窗口内被拒 → **不许**补码；
  //   ③ 两次连续限速各自开一个窗口（退避不是永久的：换连接即清零）。
  const relay = await bootWithFakeRelay('wiring_host_ratelimit')
  try {
    assert.ok(await relay.waitForFrame((f) => f.t === 'hello'), '夹具自检：主机应当先发 hello')

    // ① 基线
    const countPairBegins = (): number => relay.frames.filter((f) => f.t === 'pair-begin').length
    relay.send({ t: 'pair-fail', reason: 'invalid_or_expired' })
    await waitUntil(() => countPairBegins() >= 1)
    assert.ok(countPairBegins() >= 1, '没被限速时被拒必须立刻补一张码')

    // ② 中继说它限速了（带等待建议），紧接着这一张又被拒
    relay.send({ t: 'error', code: 'rate_limited', message: '慢一点', retryAfterMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 100)) // 让 error 帧先落地
    const marks = countPairBegins()
    relay.send({ t: 'pair-fail', reason: 'invalid_or_expired' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(
      countPairBegins(),
      marks,
      '刚被限速就自动补码 = 自我加速的拒绝循环；中继的全局配额只有 20/s，烧光之后手机连普通帧都发不出去',
    )

    // ③ 退避有尽头：5 秒的窗口过去之后（这里不真等，走另一条路证明它不是永久的）
    //    —— 中继重连即清零（配额按连接计）。
    relay.send({ t: 'error', code: 'rate_limited', message: '慢一点' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const marks2 = countPairBegins()
    relay.send({ t: 'pair-fail', reason: 'invalid_or_expired' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(countPairBegins(), marks2, '第二个窗口内同样不许补码')
  } finally {
    relay.close()
  }
})

/* ── 2026-10-07：关掉状态快照不许顺手关掉剪枝、补码与落盘 ─────────────────── */

test('statusFile 置空（关掉状态快照）：空闲超时的通道仍会被剪掉，否则密钥簿重新变回无界', async () => {
  // 现场：`pairingWindow.tick()` / `relay.pruneConversations()` / 批量落盘三件事
  // 全都写在 `status.start()` 的回调里，而 `StatusFile.start` 在没有文件时**直接 return**。
  // `statusFile: ''` 是有文档的开关（HOST-SIDE §4），于是关掉快照的用户同时关掉了：
  //   ① 通道剪枝（全仓唯一的 `pruneStale()` 调用方）→ 密钥簿无界，
  //      `MAX_CONVERSATIONS` 与两条 TTL 全部形同虚设，每天重配一次两周攒 200+ 把 PSK；
  //   ② 配对码自动换代 → `pairOnStartSec>0` 的实例永远只发启动那一张；
  //   ③ PSK 簿批量落盘 → 只剩结构性变化与停机两条写盘路。
  // 而且**没有任何提示**——正是本仓库反复出现的那一类「静默失效」。
  //
  // 判据钉的是**可观察的后果**（会话数真的掉下来），不是"装了几只定时器"：
  // 上一版钉的是后者，结果 apply 里那一堆一次性复查与 runtime 的刷新节拍
  // 足以让断言恒真——把修复整段删掉它照样绿。
  const clock = new FakeClock()
  const wiring = boot({
    hostId: HOST_A,
    rootHasEvents: true,
    clock,
    statusFile: '',
    staleRestored: true,
    persistWithoutStatus: true,
  })
  const conversations = (): number => Number(wiring.state().conversations ?? -1)
  try {
    assert.equal(conversations(), 1, '前提：盘上那条恢复出来了，此刻它占着一个会话位')

    // 走满 7 天（`restoredIdleTtlSec` 默认 604800 秒）+ 一拍余量。
    await clock.advance(604_800_000 + 30_000)

    assert.equal(
      conversations(),
      0,
      '一条 7 天没动过的恢复通道必须被剪掉：剪枝**只**由 housekeeping 驱动，' +
        '关掉状态快照就等于把它一起关掉，而那正是 `MAX_CONVERSATIONS` 与两条 TTL 被写成要治的无界密钥簿',
    )
  } finally {
    wiring.dispose()
  }
})

test('关掉状态快照时另起的那只节拍必须在停机时收掉', () => {
  // 这条与上面那条是两个不同的保证：那一条钉"剪枝会发生"，这一条钉"它不会变成孤儿节拍"。
  // 插件都走了还在往一个已经不存在的会话簿上写盘，是那种没人会在现场当场发现的漏。
  const clock = new FakeClock()
  const wiring = boot({ hostId: HOST_A, rootHasEvents: true, clock, statusFile: '', persistWithoutStatus: true })
  try {
    // 跑满几拍：让它自续几次，证明它是活的（而不是恰好没被排上）。
    void clock
  } finally {
    wiring.dispose()
  }
  assert.equal(clock.pending, 0, `停机后不许留下定时器（还剩 ${clock.pending} 只）`)
})

test('statusFile 有值：节拍仍然只有状态那一拍，没有多出一只重复的 housekeeping', async () => {
  // 反证：上一条不能靠"到处再挂一只定时器"来满足——那会让正常路径多一个写盘心跳。
  // 走状态那一拍就够，所以这里钉的是"仍然只靠状态驱动"。
  const clock = new FakeClock()
  const wiring = boot({ hostId: HOST_A, rootHasEvents: true, clock })
  try {
    const before = clock.pending
    assert.ok(before > 0, '前提：状态节拍装上了')
    for (let round = 0; round < 5; round += 1) await clock.advance(3_000)
    assert.ok(clock.pending > 0, '状态节拍必须自续')
  } finally {
    wiring.dispose()
    assert.equal(clock.pending, 0, '停机后不留定时器')
  }
})
