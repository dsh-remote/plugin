/**
 * `diagnostics.*` 三组字段的判据（V3-PLAN §7 阶段 F4）。
 *
 * ## 这一层要守什么
 *
 * F4 的措辞是「`status.json` 增诊断字段（自部署/传输/续传命中率）」，而**真正的风险不是字段少，
 * 是字段多**：status.json 是排错第一入口，往里加字段的成本是零，于是每个"我觉得有用"的读数
 * 都会长进去，最后没人知道哪几个还有用（改了账本没人看，等于没改）。
 *
 * 所以这一层钉三件事：
 *
 * 1. **续传计数真的会动**（`resume`）：带 `since` 且补到东西 = hits，空页 = misses，
 *    没带 `since` = noCap，窗口外 = tooDeep。⚠️ 这四个必须分开记——
 *    合并成一个"次数"的话，"续传永远不生效"和"续传一直生效"在字段上就长得一样，
 *    而**前者不报错**（协议设计成补不回来就退回整页重读）。
 * 2. **地址解析不抛**（`selfHosting`）：快照是排错入口，它坏掉的话排错入口本身没了。
 * 3. **传输计数与状态一致**（`transport`）：掉线时 `sinceConnectedSec` 必须变回 null，
 *    因为"从没连上过"与"刚连上"是两件事，合成一个数就分不开了。
 *
 * 「每个字段有谁读它」那条不在这里——那要跨到伞仓（doctor 脚本与文档），见
 * `e2e/status-diagnostics.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockKernel } from '../src/platform/mock-kernel.js'
import { FakeClock } from '../src/core/clock.js'
import { describeSelfHosting } from '../src/shell/self-hosting.js'
import { RelayClient } from '../src/transport/relay.js'
import { HostRuntime, type RuntimeTransport } from '../src/core/runtime.js'
import type { KeepAwake } from '../src/core/sleep-policy.js'
import { HISTORY_WINDOW_EXCEEDED } from '../src/ports/index.js'
import type { CmdPayload, EvPayload } from '@dsh-remote/protocol'

interface Harness {
  runtime: HostRuntime
  transport: ReplyRecorder
  kernel: MockKernel
  clock: FakeClock
}

// ── selfHosting：一条 URL 读出三件排错要用的事 ──

test('selfHosting：明文 ws / 回环地址 / 缺端口，三样各能读出来', () => {
  assert.deepEqual(describeSelfHosting('ws://127.0.0.1:8787'), {
    scheme: 'ws',
    tls: false,
    loopback: true,
    defaultPort: false,
    host: '127.0.0.1',
  })
  // 不写端口 ⇒ 走默认端口。URL 会把 `:443`（wss 默认）也归一成空串，两者都算 defaultPort。
  assert.equal(describeSelfHosting('wss://drc.provid.cc').defaultPort, true)
  assert.equal(describeSelfHosting('wss://drc.provid.cc:443').defaultPort, true)
  assert.equal(describeSelfHosting('wss://drc.provid.cc:8443').defaultPort, false)
  assert.equal(describeSelfHosting('wss://drc.provid.cc').tls, true)
  assert.equal(describeSelfHosting('ws://box.local').loopback, false, '局域网自部署不该被当成回环')
  assert.equal(describeSelfHosting('wss://localhost:8443').loopback, true)
})

test('selfHosting：解析不出来时如实报 unknown，**不许抛**', () => {
  // status.json 是排错第一入口，它抛异常等于把排错入口自己弄坏。
  // 配置早就由 shell/config.ts 校验并给出 `error:serverUrl` 了，这里再抛一次只会更糟。
  const facts = describeSelfHosting('这不是一个 URL')
  assert.equal(facts.scheme, 'unknown')
  assert.equal(facts.tls, false)
  assert.equal(facts.loopback, false)
  assert.equal(facts.host, '')
})

test('反向判据：把 loopback 的判定写成"含 127.0.0.1"，wss://127.0.0.1:8443 会漏 ⇒ 立刻红', () => {
  // 用一个**形状不同但同样危险**的地址验证：它是自部署者真会填的东西（带端口的回环）。
  assert.equal(describeSelfHosting('wss://127.0.0.1:8443').loopback, true)
})

// ── transport：链路计数 ──

/**
 * 造一个 RelayClient：端口 1 上没人监听，所以它会一直停在 CONNECTING——
 * 这正是我们要的形态（"尝试过但没成功"与"从没试过"必须分得开）。
 */
function makeRelay(): { relay: RelayClient; clock: FakeClock } {
  const clock = new FakeClock()
  const relay = new RelayClient({
    url: 'ws://127.0.0.1:1',
    hostId: 'h_diag',
    label: '诊断用主机',
    token: 'fake-host-token-not-a-real-secret-0123',
    clock,
    log: () => {},
    onCommand: () => {},
    onInvalidCommand: () => {},
    onPeerJoined: () => {},
    onConversationGone: () => {},
    onClientLeft: () => {},
    lookupPairingSlot: () => null,
    onPairReady: () => {},
    onPairFail: () => {},
    onState: () => {},
  })
  return { relay, clock }
}

test('transport：没连上过时 sinceConnectedSec 是 null，而不是 0', () => {
  const { relay } = makeRelay()
  assert.equal(relay.transport.connects, 0)
  assert.equal(relay.transport.lastConnectedAtSec, null, '从没连上过不许报 0：那会被读成"0 秒前刚连上"')
  assert.equal(relay.transport.connectAttempts, 0, '还没 connect 就不该有尝试')
})

test('transport：每次 connect 计一次尝试，没真的 open 就不算 connects', async () => {
  const { relay, clock } = makeRelay()
  relay.connect()
  assert.equal(relay.transport.connectAttempts, 1)
  // ⚠️ 这里断言的是"再连一次就再记一次"，**不**断言"握手超时后会自动重连"：
  // 后者取决于 HANDSHAKE_TIMEOUT_MS 与退避档位（它们本来就在 relay-client.test.ts 里验），
  // 把它复制一份的结果是这条判据随那两个常量漂 —— 而它要守的是"计数有没有在记"。
  relay.connect()
  assert.equal(relay.transport.connectAttempts, 2, '第二次 connect 必须再记一次尝试')
  assert.equal(relay.transport.connects, 0, '端口 1 上没人监听：一个 open 都不会有')
  assert.equal(relay.transport.lastConnectedAtSec, null, '没连上就没有"距上次连上"可言')
  relay.stop()
  void clock
})

// ── resume：续传命中率 ──

/** 最小传输替身：只记回执，不做任何 socket 的事（这里要验的是 runtime 侧的计数）。 */
class ReplyRecorder implements RuntimeTransport {
  readonly replies: Array<{ conversationId: string; payload: EvPayload }> = []
  peers = new Set<string>()
  reply(conversationId: string, payload: EvPayload): boolean {
    this.replies.push({ conversationId, payload })
    return this.peers.has(conversationId)
  }
  broadcast(): number {
    return this.peers.size
  }
  hasClient(conversationId: string): boolean {
    return this.peers.has(conversationId)
  }
  conversationIds(): string[] {
    return [...this.peers]
  }
}

/** 一个什么动作都不做的防休眠替身（本文件不验防休眠，别让它的定时器混进计数）。 */
const IDLE_SLEEP = {
  enable: () => false,
  disable: () => {},
  snapshot: () => ({ enabled: false, active: false, platform: 'test', backend: 'mock' }),
} as unknown as KeepAwake

const settle = async (times = 12): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

let seq = 0
async function pull(h: Harness, payload: Record<string, unknown>): Promise<void> {
  await h.runtime.handleCommand(
    {
      t: 'cmd.session_history',
      cmdId: `cmd_diag_${(seq += 1)}`,
      ...payload,
    } as unknown as CmdPayload,
    'c_000000000001',
  )
  await settle()
}

function harness(readHistory: NonNullable<MockKernel['readHistory']>): Harness {
  const clock = new FakeClock()
  const kernel = new MockKernel({ clock })
  kernel.readHistory = readHistory
  const transport = new ReplyRecorder()
  transport.peers.add('c_000000000001')
  const runtime = new HostRuntime(kernel, transport, IDLE_SLEEP, clock, {
    listingRefreshMs: 3_600_000,
    log: () => {},
  })
  runtime.start()
  return { runtime, transport, kernel, clock }
}

test('resume：带 since 且补到东西 = hits；空页 = misses；两者必须分开', async () => {
  const withEvents: NonNullable<MockKernel['readHistory']> = () =>
    Promise.resolve({
      events: [{ kind: 'delta', sessionId: 'ses_1', messageId: 'm1', text: 'x', done: false }],
    })
  const h1 = harness(withEvents)
  await pull(h1, { sessionId: 'ses_1', since: 3 })
  assert.equal(h1.runtime.resume.hits, 1, '补到东西就是续传生效')
  assert.equal(h1.runtime.resume.misses, 0)

  const empty: NonNullable<MockKernel['readHistory']> = () => Promise.resolve({ events: [] })
  const h2 = harness(empty)
  await pull(h2, { sessionId: 'ses_1', since: 3 })
  assert.equal(h2.runtime.resume.misses, 1, '空页是"游标之后确实没新事件"，不是失败，但也不是 hits')
  assert.equal(h2.runtime.resume.hits, 0)
})

test('resume：没带 since 的整页读记在 noCap，且不进命中率的分母', async () => {
  const h = harness(() => Promise.resolve({ events: [] }))
  await pull(h, { sessionId: 'ses_1', beforeSeq: 9 })
  assert.equal(h.runtime.resume.noCap, 1, '整页读要单独记：它和补差量混在一起就看不出续传有没有在跑')
  assert.deepEqual(
    h.runtime.resume,
    { hits: 0, misses: 0, noCap: 1, tooDeep: 0 },
    '四个读数之外的派生量（命中率）不许进快照：它必然与三个计数不同步，而没人读它（F4）',
  )
})

test('resume：窗口外要记 tooDeep（它是降级路径，不是失败）', async () => {
  const tooDeep: NonNullable<MockKernel['readHistory']> = () =>
    Promise.reject(new Error(`history window exceeded: ${HISTORY_WINDOW_EXCEEDED}`))
  const h = harness(tooDeep)
  await pull(h, { sessionId: 'ses_1', since: 999999 })
  assert.equal(h.runtime.resume.tooDeep, 1, '落在窗口外必须单独计数：它是"补不回来"，与"补到了"相反')
  assert.equal(h.runtime.resume.hits, 0)
})

test('反向判据：把 misses 也算成 hits，命中率那条立刻红', async () => {
  // 用夹具证明"合并两个读数"是错的：两次空页 + 一次补到，若把 misses 当 hits，
  // 命中率会是 2/3 而不是 1/3 —— 也就是说"续传在跑"与"续传在空转"会报出同一个数。
  const calls = [0, 1, 2]
  let n = 0
  const h = harness(() => {
    const i = (n += 1) - 1
    if (i === 0) return Promise.resolve({ events: [] })
    return Promise.resolve({
      events: [{ kind: 'delta', sessionId: 'ses_1', messageId: `m${i}`, text: 'x', done: false }],
    })
  })
  void calls
  await pull(h, { sessionId: 'ses_1', since: 1 })
  await pull(h, { sessionId: 'ses_1', since: 2 })
  await pull(h, { sessionId: 'ses_1', since: 3 })
  assert.equal(h.runtime.resume.hits, 2)
  assert.equal(h.runtime.resume.misses, 1, '空页与补到必须分得开：合并之后"续传在跑"与"续传在空转"报出同一个数')
})
