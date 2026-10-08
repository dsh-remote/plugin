/**
 * relay — 主机侧的中继客户端：鉴权、重连、配对通道密钥簿、数据面密封。
 *
 * 三条来自线上事故的硬要求（取证 docs/legacy-spec/relay-and-wireformat.md §2.3）：
 *
 * 1. **`pair-ready.ttlMs` 是服务端权威 TTL**，必须据此改写本地过期时间。
 *    忘了这一步 → 主机提前清掉 PSK → `peer-joined` 找不到密钥 → 静默丢 peer
 *    → 手机端表现为"配对成功但列表永远空白"。
 * 2. **`peer-joined` 里的 `pairingToken` 是唯一合法的取密钥依据**。
 *    多张码同时挂着时按"手机实际用的那张"取 PSK；取不到就拒绝这条配对，
 *    绝不退化成"取最新的一个"（那正是当初的 bug）。
 * 3. **中继重启后，本地会话会变成"有密钥但没人路由"的孤儿**。
 *    这条**不是靠"收到 hello-ok 就清空"来处理的** —— 见下面「generation 现在只喂给发码窗口」：
 *    主机侧分不出"中继重启"与"自己重启"，而清空是误伤更贵的那一侧（要用户重扫）。
 *    孤儿会话由既有的「只允许一台」策略回收（新配对时作废其余通道），
 *    手机侧则早已撞上 `unknown_session` → needs-pair，两边都有出口。
 *
 * 方向约定：主机用 `h2c` 密钥**加密下行**、用 `c2h` 密钥**解密上行**；
 * 与小程序侧正好互为镜像，两把密钥由同一 PSK + convId 派生（冻结项 B5）。
 *
 * ## `hello-ok` 里的 generation 现在只喂给发码窗口（2026-10-04）
 *
 * 它**不再**用来清会话。原来这里是"每次收到 hello-ok 就 +1，然后 `closeBefore` 把全部会话丢掉"，
 * 而 `generation` 其实是**主机进程内的自增计数器**——于是**主机自己重启**也被当成"中继重启"，
 * 每次重启都自毁全部配对，手机必须重新扫码（那正是本文件要修的东西）。
 *
 * 判据换成两条真正有信息的：
 * - **结构性变化（新配对 / 作废）立刻落盘**（`onStructuralChange`），崩了也不丢；
 * - `generation` 只回答"中继的 pending-pair 表是不是被清空了"——它是内存态，中继一重启就空，
 *   于是挂在屏幕上的那张码成了死码，`PairingWindow` 必须换一张。**它管的是码，不是会话。**
 *
 * 中继重启后残留的会话（密钥还在、中继表里已经没有路由）由既有的「只允许一台」策略回收：
 * 新配对一发生，`onPeerJoined` 就把新通道以外的全部作废（见 index.ts）。
 * 手机那边则早就撞上 `unknown_session` → needs-pair（e2e restart-resume 的 (b) 用例锁着这条）。
 */
import { WebSocket } from 'ws'
import { randomBytes } from 'node:crypto'
import {
  type CapabilityId,
  type CmdPayload,
  type EndpointFrame,
  type EvPayload,
  base64Text,
  encToClient,
  helloForHost,
  isRetryableError,
  open,
  pairBegin,
  parseCmdPayload,
  parseRelayFrameText,
  ping as pingFrame,
  resync as resyncFrame,
  seal,
  sessionLeave,
} from 'dsh-remote-wire'
import { ConversationBook, DEFAULT_PRUNE_POLICY, type PairSlot, type PrunePolicy } from '../core/keys.js'
import type { Clock } from '../ports/index.js'

/**
 * 本插件在 `hello` 里声明的能力（规范 §5.3 C1/C3）。
 *
 * **只列真正接上了的**，逐条对应一处实现：
 * - `attachments`：`shell/uploads.ts` + `core/runtime.ts` 的整批先验后写；
 * - `history`：`cmd.session_history` 走游标分页（`runtime.ts` 的 historyFace）；
 * - `new-session.workspace`：`cmd.new_session.workspace` 已接线（`carrier-services.ts` 的
 *   `badWorkspace()` 拿到的就是手机传来的路径，不是自己推断的）；
 * - `get-pending`：`cmd.get_pending` 有实现；
 * - `keep-awake`：`cmd.keep_awake` + `ev.keep_awake_state` 有实现（mp 侧没界面，见 HANDOFF §5-14）；
 * - `model`：`ev.model` 有实现；
 * - `retry-compaction`：`ev.retry` / `ev.compaction` 都有（真机各 18 次）；
 * - `idempotency`：`IdempotencyLedger` 按 cmdId 去重（规范 §10.2）；
 * - `resync`：鉴权后发 `resync`。
 *
 * **刻意不列**：`drc.host.info`（`ev.host_info` 还没做，HANDOFF §3.6）、
 * `drc.crypto.v2`（棘轮是规划中的破坏性变更）、`drc.pairing.token`（6 位码单独输入那条路已删）。
 * 列一个没实现的能力 = 手机按"支持"表现，而实际会干等 12 秒——比不列更糟。
 */
const HOST_CAPABILITIES: readonly CapabilityId[] = [
  'drc.v1',
  'drc.pairing.qr',
  'drc.payload.attachments',
  'drc.payload.history',
  'drc.payload.new-session.workspace',
  'drc.payload.get-pending',
  'drc.payload.keep-awake',
  'drc.payload.model',
  'drc.payload.retry-compaction',
  'drc.cmd.idempotency',
  'drc.data.enc-batch',
  'drc.host.resync',
]

export interface RelayClientOptions {
  url: string
  hostId: string
  label: string
  /** 中继侧 `DRC_HOST_TOKEN` 的同值副本；只在这一条出站帧上出现。 */
  token: string
  clock: Clock
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 解出一条命令（已经过 MAC 校验）。 */
  onCommand: (conversationId: string, cmd: CmdPayload, clientId?: string) => void
  /**
   * 一条**解得开、但形状过不了 schema** 的指令（2026-10-07 补）。
   *
   * ## 这为什么必须是一个单独的出口
   *
   * 手机发出去的是**加密**的：它在那一端是能过 schema 的（否则 `sendCmd` 自己就拒了）。
   * 所以"到主机这边过不去"只可能是两端协议版本不一致——最典型的场景是手机把一个
   * 新字段（例如超长的 `mediaType`）或一个主机这一代还没发版的命令送了过来。
   *
   * 从前这一路只写一行日志就 `continue`，后果是：**手机干等满 12 秒**的
   * `COMMAND_TIMEOUT_MS`，然后拿到一句「主机没有回应这条指令」——而根因一个字都没留下。
   * 用户与日志里都没有"哪条指令被拒了"这句话，只能靠猜（§5-9）。
   *
   * 有了这个出口，主机能按 `cmdId` 回一条 `ev.result{ok:false}`，
   * 手机那一端立刻拿到可读的原因，而不是等超时。
   *
   * 只有**拿到了 `cmdId`** 才可能回执（回执按 cmdId 结算，见 `client.js` 的 `_cmdWaiters`），
   * 所以 `cmdId` 是 `string | undefined`：没有它时调用方只能记日志，这无可奈何——
   * 那也是为什么协议要求每条 `cmd.*` 都带 `cmdId`。
   */
  onInvalidCommand?: (conversationId: string, cmdId: string | undefined, payloadType: string) => void
  /** 一条新配对建立：调用方要立刻把会话与防休眠状态推过去。 */
  onPeerJoined: (conversationId: string, pairingToken: string | undefined) => void
  /** 一条配对通道被彻底作废（本端解不开、或本端主动声明它没人接了）。 */
  onConversationGone: (conversationId: string) => void
  /** 某个客户端离开，但**会话保留**（D3）：它下次用同一个 convId 回来时还能接上。 */
  onClientLeft: (conversationId: string, clientId: string) => void
  /**
   * 按 `peer-joined` 回传的 pairingToken 取本地那张码。
   * 取不到必须返回 null 并由调用方拒绝这条配对——**不允许**退化成"取最新的一张"，
   * 那正是多码并存事故的形状。
   */
  lookupPairingSlot: (token: string) => PairSlot | null
  /** `pair-ready` 到达：调用方据此改写本地 PSK 过期时间。 */
  onPairReady: (pairingToken: string, ttlMs: number) => void
  /**
   * 中继宣告"这张配对码没配上"（`expired` / `already_used` / `rate_limited` /
   * `invalid_or_expired`）。
   *
   * 这个回调**必须被接上**（index.ts 的 `onPairFail`）：中继说码废了，而主机这边
   * 一张都不换的话，屏幕上那张死码会一直挂着，用户对着 `already_used` 反复扫，
   * 只能等 TTL 走完（`pairOnStartSec` 默认 0，没有任何东西会自动补发）。
   * 接线方要做的是"清展示位 + 作废这张 + 按需补一张"；被限速时不建议立刻再申请。
   */
  /**
   * @param pairingToken **是哪一张码失败的**；中继没给（更老的一版）时为 undefined，
   *        此时接线方**必须**退回"当前展示的那张"—— 见下面那条误伤的说明。
   *
   * ## 为什么这个参数是必需的（2026-10-07 补）
   *
   * 这个帧原先只有 `reason`，而接线方的处理是"作废**当前展示的那张**"——
   * 于是它只能拿 `active.pairing` 顶罪。多码并存时那会**作废错的那张**：
   * 屏幕上是码 B（完全有效），用户扫了一张早就过期的码 A → 中继回
   * `invalid_or_expired` → 主机把 B 记进 `spentTokens` 并 forget，再补一张 C。
   *
   * 症状不是"多扫一次码"：B 的 PSK 被丢弃意味着那条配对通道作废，
   * 而这正是本文件头引用的那起「取错 PSK 全线解不开」事故的前置条件。
   *
   * 缺省是 undefined 而不是必填：发它的是中继，而"新主机 + 老中继"是真实组合
   * （中继升级要重启容器、插件升级只要重开 Harness，两者节奏不同）。
   */
  onPairFail?: (reason: string, pairingToken: string | undefined) => void
  /**
   * 中继的错误帧（2026-10-07 接上）。
   *
   * 此前这一帧只被记进日志：主机**从不**按 `code` 分支，于是协议层那条
   * "发出去的是机器可判的码"（规范 §12）在本端完全没被用上。接上之后至少有一件事
   * 变得可能：**限流**有了确切的信号来源——配对限流在中继那条路径上被折成了
   * `invalid_or_expired`（中继只把 `rate_limited` 写进自己的日志），主机只能从
   * 这里的 `rate_limited` 知道"刚才是被限速了，现在再申请一张只会继续被拒"。
   *
   * `retryAfterMs` 是中继给的等待建议（毫秒，可选）。编不出来的那种错误不带它，
   * 所以缺省时调用方要自己选一个退避。
   */
  onRelayError?: (code: string, retryAfterMs: number | undefined) => void
  /** 连接状态变化，直接进 status.json。 */
  onState: (state: RelayStateInfo) => void
  /** 重连后的第一批帧之前要不要等一会（手机端可能还在旧 convId 上发）。 */
  handshakeTimeoutMs?: number
  /** 配对通道的剪枝策略（不传用默认：空闲 24h 或超过 64 条）。 */
  prunePolicy?: PrunePolicy
  /**
   * 会话簿发生了**结构性**变化（新配对建立 / 会话被作废或剪掉）：调用方要立刻落盘。
   *
   * 为什么单独一条而不是复用 `onState`：`seqHost` 与 `lastActivityAt` 每广播一次就变，
   * 挂在状态回调上等于每 3 秒写一次盘；而新配对这种只发生一次的事绝不能等到下一次 tick。
   */
  onStructuralChange?: () => void
  /**
   * 只改了 `seqHost` / `lastActivityAt` 之类的高频变动：调用方**只标脏、别写盘**。
   *
   * 为什么要与 `onStructuralChange` 分开：这两件事每次广播 / 每条上行帧都会发生，
   * 挂上去等于每十几秒写一次盘。而它们丢了无所谓——`seqHost` 只是本地编号（客户端从不读，
   * F13），`lastActivityAt` 差几秒不影响剪枝判定。批量落在 status 的 3 秒 tick 上做。
   */
  onBookActivity?: () => void
  /** 存活探针间隔（默认 20 秒）与等 pong 的上限（默认 10 秒）。 */
  probeIntervalMs?: number
  probeTimeoutMs?: number
}

export interface RelayStateInfo {
  relay: 'online' | 'connecting' | 'offline'
  problem?: string
  clients: number
  conversations: number
  generation: number
}

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000
const HANDSHAKE_TIMEOUT_MS = 10_000
/**
 * 主机侧存活探针的节奏：每 20 秒问中继一句 `ping`，10 秒内没拿到 `pong` 就强拆。
 *
 * 为什么必须有它（2026-10-05 线上取证）：socket **半开**时两头都是瞎的——
 * 对端已经走了（中继早把主机摘了、`hosts` 归零），本地一个 FIN/RST 都收不到，
 * `close` 事件永远不来，于是状态一直报 online、重连永远不会开始。
 * 实测：中继重启后主机重连成功，28 分钟后连接半开，中继 17:54 起就再无主机，
 * 而插件直到进程重启都认为自己在线——手机上看到的就是"配对着却连不上"。
 * 中继那侧本来就有心跳（它 ping 主机、2×60s 判死），缺的是主机这半边。
 */
const PROBE_INTERVAL_MS = 20_000
const PROBE_TIMEOUT_MS = 10_000
/** 已声明作废的 convId 记住多少条：远超一次会话里可能出现的配对通道数，又不会无界增长。 */
const VOIDED_MAX = 256

export class RelayClient {
  readonly conversations = new ConversationBook()
  private socket: WebSocket | undefined
  /**
   * **主机侧连接代号**：每收到一次 `hello-ok` 就 +1。
   *
   * 它现在**只**喂给 `PairingWindow`（"中继的 pending-pair 表是不是清空了"），
   * 绝不用来清会话 —— 理由见文件头。它递增本身没有权威性（中继不回代次），
   * 所以配对窗口用它判"换码"是保守正确的：中继真重启时代次一定变了，
   * 中继没重启时多换一张码的代价只是浪费一个 6 位码。
   */
  private generation = 0
  private attempts = 0
  private stopped = false
  private reconnectTimer: unknown
  private handshakeTimer: unknown
  /** 存活探针的下一次提问（自重启的 setTimeout 链，见 {@link startProbe}）。 */
  private probeTimer: unknown
  /** 已提问、还没等到 pong 的那个定时器；undefined = 当前没有待答的问题。 */
  private pongDeadline: unknown
  /** 连续解不开的会话：解不开说明这端已经没有对应密钥，留着它只会让手机永远转圈。 */
  private readonly undecryptable = new Map<string, number>()
  /** 已经向中继声明过的 convId（防重复 `session-leave`）；有上界，见 {@link VOIDED_MAX}。 */
  private readonly voided = new Set<string>()

  constructor(private readonly options: RelayClientOptions) {}

  /** 已配对的会话数（`status.json` 与"有没有人能收"的判据都读它）。 */
  get conversationCount(): number {
    return this.conversations.size
  }

  /**
   * 当前连着的**手机台数**（去重的 clientId）。
   *
   * 与 `conversationCount` 分开是因为「解除配对 → 重新配对」会开一条新会话，
   * 手机却还是那一台：拿会话数当手机数报，用户解完配对看到数字变大，
   * 会以为解配没生效。
   */
  get clientCount(): number {
    return this.conversations.clientCount()
  }

  /** 本轮已连上的中继代号（`status.json` 与配对窗口都读它）。 */
  get relayGeneration(): number {
    return this.generation
  }

  /**
   * 恢复上次进程留下的会话（密钥来自 `pair-store`）。
   *
   * **恢复出来的会话里 `clientIds` 是空的**（见 `ConversationBook.restore`），所以
   * `conversationCount > 0` 而 `clientCount === 0` 是这一阶段的正常形态：
   * 密钥还在、手机还没回来。调用方据此知道**不能**等 `onPeerJoined` 才启动内核订阅
   * —— 否则主机重启后手机能连上、主机却不订阅任何事件，表现与配对丢失一模一样。
   */
  restoreConversations(records: Parameters<ConversationBook['restore']>[0]): string[] {
    /**
     * 被丢弃的记录要走日志，而这条出口是**每次调用都重挂**的：
     * 它挂在一个长寿命对象（`conversations`）上，而 `restoreConversations`
     * 在一次进程里只被调一次——但"只调一次"不是这行代码的保证，
     * 而"上一个调用方留下的钩子还挂着"是一个比"没有钩子"更难查的状态。
     */
    this.conversations.onRestoreRejected = (conversationId, reason) => {
      this.options.log('stored conversation rejected', { conversationId, reason })
    }
    const restored = this.conversations.restore(records, this.options.clock.now())
    this.conversations.onRestoreRejected = undefined
    if (restored.length > 0) {
      this.options.log('conversations restored from disk', {
        count: restored.length,
        // 记一下有没有手机已经登记进来了：恢复阶段应当恒为 0。
        clients: this.conversations.clientCount(),
      })
    }
    if (restored.length < records.length) {
      /**
       * **丢了要说得比"恢复了几条"更响**（2026-10-07）。
       *
       * `count: 2` 那一行只说"恢复了几条"，而用户看到的是"我明明配对过、
       * 手机却要重扫"——那一句没有任何提示。两条数放在一起才构成一个完整事实：
       * 盘上有 3 条、恢复了 2 条，于是"那第 3 条为什么没回来"有了解释。
       */
      this.options.log('some stored conversations were dropped', {
        onDisk: records.length,
        restored: restored.length,
        dropped: records.length - restored.length,
      })
    }
    return restored
  }

  connect(): void {
    if (this.stopped) return
    this.closeSocket()
    this.options.log('relay connecting', { url: this.options.url })
    let socket: WebSocket
    try {
      socket = new WebSocket(this.options.url)
    } catch (error) {
      this.scheduleReconnect(`socket 创建失败：${messageOf(error)}`)
      return
    }
    this.socket = socket
    this.emitState('connecting')
    const timeout = this.options.clock.setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        this.options.log('relay handshake timeout')
        socket.terminate()
        this.scheduleReconnect('握手超时')
      }
    }, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    this.handshakeTimer = timeout

    socket.on('open', () => {
      this.options.clock.clearTimeout(timeout)
      this.attempts = 0
      // D5：主机与客户端共用一条注册帧。PSK 从不上网（D1），这里只有 host token。
      //
      // ⚠️ `capabilities` 是**本插件真实支持的那几张**（规范 §5.3 C1/C3），不是全集。
      // 它的用处是让对端能区分"这一代主机没有这个能力"与"它有但没开"——
      // 而后者在 mp 侧是从**看能力面**推断出来的（`dsh-remote-mp` 不做别的协商），
      // 所以少报一个 id 的代价是"明明支持却按不支持表现"，多报一个的代价是
      // "发过去手机上干等 12 秒"。取交集要保守：这里报的都是**有实现且有判据钉着**的。
      this.raw(
        helloForHost({
          token: this.options.token,
          hostId: this.options.hostId,
          label: this.options.label,
          capabilities: HOST_CAPABILITIES,
        }),
      )
    })
    socket.on('message', (raw) => this.onFrame(String(raw)))
    // 存活探针：半开连接在本地是隐形的（对端走了、close 永不来），只能靠问。
    this.startProbe(socket)
    socket.on('close', (code, reason) => {
      this.options.clock.clearTimeout(timeout)
      this.emitState('offline', `连接关闭 ${code} ${reason ? reason.toString() : ''}`.trim())
      this.options.log('relay closed', { code })
      this.scheduleReconnect(`closed ${code}`)
    })
    socket.on('error', (error) => {
      this.options.log('relay socket error', { message: messageOf(error) })
      this.emitState('offline', messageOf(error))
    })
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) {
      this.options.clock.clearTimeout(this.reconnectTimer)
      // 句柄要一起清掉：`scheduleReconnect` 靠它判"已经排着一次重连"，
      // 留着它会让人以为还有一次重连在路上。
      this.reconnectTimer = undefined
    }
    this.closeSocket()
    this.emitState('offline', 'stopped')
  }

  /** 发布一张新的配对码（PSK 留在本地，中继只拿到 6 位码）。
   *
   * 返回 false = socket 不在 OPEN 状态、这条 `pair-begin` **根本没上过网**。
   * 调用方不能把这张码记成"有效"，否则 status.json 会展示一张中继没见过的码，
   * 而手机扫它必然失败（取证 docs/legacy-spec/host-plugin-runtime.md §6.2）。
   */
  publishPairing(slot: PairSlot): boolean {
    return this.raw(pairBegin(slot.token))
  }

  /**
   * 按策略剪掉"再也不会被用"的配对通道（一天没收发，或超出条数上界）。
   *
   * 必须**同时**告诉中继与上层：只删本地内存的话，中继仍会把手机的密文转过来，
   * 而手机看到的是一个不再有人应答的对端——正是复核 R1 那个静默黑洞的另一个入口。
   * 所以这里走 `voidConversation`（发 `session-leave` + 回调 `onConversationGone`）。
   */
  pruneConversations(now = this.options.clock.now()): string[] {
    const dropped = this.conversations.pruneStale(now, this.options.prunePolicy ?? DEFAULT_PRUNE_POLICY)
    for (const id of dropped) this.voidConversation(id)
    if (dropped.length > 0)
      this.options.log('pruned stale conversations', { count: dropped.length, remaining: this.conversations.size })
    return dropped
  }

  /** 向一条配对会话发一条载荷；返回 false = 这条会话已经没了，或**现在没有活着的客户端**。 */
  send(conversationId: string, payload: EvPayload): boolean {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return false
    // 有密钥 ≠ 有人能收到。手机退到后台/断开时会话要留着（D3 靠它重建路由），
    // 但往一条空会话发帧只有两个后果：中继计一次丢帧，和本地白做一次加密。
    if (conversation.clientIds.size === 0) return false
    const record = seal(conversation.kH2C, payload)
    /**
     * **出站体积闸**（2026-10-07 审计补上）。`encToClient` 是协议层里唯一一处执行
     * `MAX_CIPHERTEXT_BYTES` 的地方，注释写着"超过上限对侧静默丢帧"——而主机原来
     * 直接手拼 `{t:'enc',…}`，**这条路上一个体积闸都没有**。
     *
     * 后果不是"这一帧丢了"：超限时中继的 `parseEndpointFrame` 会回一条 `error{bad_frame}`，
     * 而插件对 `error` 帧**只记日志**（见 `onFrame` 的 `case 'error'`），手机上于是走完
     * 15 秒 `HISTORY_TIMEOUT_MS` 留下一句"读不到"——正是本仓库最典型的
     * 「功能看着正常、其实什么也没发生」。
     *
     * 闸门留在协议层（不在这儿重抄一遍上限）：同源同口径，将来上限变了不会只改一半。
     * 过不了就**当成没发出去**返回 false，让 `countOutbound` 如实记一次 `_no_peer`，
     * 而不是把一条注定被丢的帧当成已送达。
     */
    let frame: Record<string, unknown>
    try {
      frame = encToClient(conversationId, ++conversation.seqHost, record.ciphertext)
    } catch (error) {
      this.options.log('outbound frame rejected by the wire size cap', {
        sessionId: conversationId,
        message: messageOf(error),
      })
      return false
    }
    // 活动时刻**在闸门之后**才记：一条注定发不出去的帧不该把这条通道"用活"，
    // 否则剪枝的空闲判据永远等不到它（那正是"PSK 簿永远不剪"的成因之一）。
    conversation.lastActivityAt = this.options.clock.now()
    this.options.onBookActivity?.()
    return this.raw(frame)
  }

  broadcast(payload: EvPayload): number {
    let sent = 0
    for (const id of this.conversations.ids()) {
      // 没有活客户端的会话**不上线**：手机不在的时候主机照样每 15 秒产生一轮状态，
      // 以前每一帧都会被中继计成一次丢帧（真机实测 45 秒涨 9，`droppedFrames` 就一直是
      // 这一路噪声主导）。跳过之后调用方仍会把这次记成 `*_no_peer`——那是本地计数，
      // 说的是"主机想发、当时没人听"，与"帧上了线又被丢"是两件事，前者不该污染后者。
      if (!this.conversations.hasClient(id)) continue
      if (this.send(id, payload)) sent += 1
    }
    return sent
  }

  /**
   * 这条会话**现在**有没有能收到东西的手机。
   *
   * 原来这个方法叫 `hasPeer`、答的是"我手里有没有这条通道的密钥"——两者在手机上线时恰好
   * 同真，所以错误一直藏着：手机断开后审批仍然"发得出去"（发进一条空会话），
   * 桌面那一半要等满 180 秒才拿到决定权。名字换成 `hasClient` 是为了让下一次
   * 想写 `conversations.has()` 的人当场看见这两个概念不是一回事。
   */
  hasClient(conversationId: string): boolean {
    return this.conversations.hasClient(conversationId)
  }

  conversationIds(): string[] {
    return this.conversations.ids()
  }

  /**
   * 作废一条配对通道：本地删密钥 + 告诉中继"这条别再转给我了" + 通知上层。
   *
   * **本端没有记录时同样要发 `session-leave`**（复核 R1①）。这是"主机重启之后"的出口：
   * PSK 随进程没了，中继却还留着会话并继续把手机的密文转过来。若这里因为
   * `!has(id)` 直接 return（第一版就是这么写的），中继永远不知道该删这条会话，
   * 手机也就永远撞不上 `unknown_session` → 表现是"发什么都没反应、也不提示重新配对"，
   * 而这是整条链路上唯一能让手机脱身的机制。
   *
   * 幂等：同一条通道只声明一次（`voided` 有上界，避免长会话里堆内存）。
   * 重新配对（`peer-joined`）会清掉这条记录，所以下次作废仍能声明。
   *
   * ## 先发再记账（2026-10-07 审计）
   *
   * 原来 `voided.add()` 在 `raw()` **之前**，而 `raw()` 对非 OPEN 的 socket 是静默
   * `return false`（中继抖一下或重启时，退避最长 30 秒以上）。于是这一帧没发出去，
   * 通道却已经被标成"声明过了"，**此后任何重试都被第 346 行挡掉**——包括设计上
   * 明确依赖的那条出路（`onEncrypted` 收到这条会话的密文 → 本端已无钥匙 →
   * 再调一次 `voidConversation`，见 `onFrame`）。
   *
   * 症状：中继那边的路由还在，手机继续对着一个听不见的对端发帧，既收不到回执也撞不上
   * `unknown_session`，而 `index.ts` 明明向用户承诺过"中继会收到 `session-leave`、
   * 手机端会显示「主机已断开，请重新配对」"。
   *
   * （下一次 `resync` 会把中继没列出的会话删掉，所以最坏是拖到下一次重连——
   * 但那是在拿一条已经许诺过的保证去换一个碰巧会到来的兜底。）
   */
  voidConversation(conversationId: string): void {
    if (this.voided.has(conversationId)) return
    this.undecryptable.delete(conversationId)
    this.conversations.close(conversationId)
    // 作废是一条通道的消失，属于结构性变化：立刻落盘，别等下一次 tick。
    this.options.onStructuralChange?.()
    const told = this.raw(sessionLeave(conversationId))
    // **只有真的发出去了才记账**：没发出去就必须留着"还没说过"这个状态，
    // 好让下一次调用（peer-joined 之外就是那条 onEncrypted 重试路）能再试一遍。
    if (told) {
      if (this.voided.size >= VOIDED_MAX) {
        const oldest = this.voided.values().next().value
        if (oldest !== undefined) this.voided.delete(oldest)
      }
      this.voided.add(conversationId)
    } else {
      this.options.log('session-leave not sent (socket not open); it will be retried', { conversationId })
    }
    this.options.onConversationGone(conversationId)
  }

  /**
   * 发一帧。
   *
   * 参数类型是 `EndpointFrame | Record<string, unknown>`：出站控制帧现在一律由
   * 协议层的构造器产出（`helloForHost` / `pairBegin` / `sessionLeave` / `resync` /
   * `ping` / `encToClient`），**参数表以外的字段在类型上写不出来**。
   * 留 `Record<string, unknown>` 是因为 `send()` 那条路塞的是 `encToClient` 的返回值，
   * 而它的类型来自协议层的 `RelayOutbound`（`[key: string]: unknown`）——
   * 收窄成 `EndpointFrame` 会因为 `seq` 可选这类细节而不必要地卡住调用方。
   */
  private raw(frame: EndpointFrame | Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    try {
      this.socket.send(JSON.stringify(frame))
      return true
    } catch (error) {
      this.options.log('relay send failed', { message: messageOf(error) })
      return false
    }
  }

  private onFrame(text: string): void {
    const frame = parseRelayFrameText(text)
    if (!frame) {
      // 只记形状不记内容：坏帧的原文可能是半条配对码，日志里不许出现凭据与业务明文。
      this.options.log('relay frame rejected', { bytes: text.length })
      return
    }
    switch (frame.t) {
      case 'hello-ok': {
        // **这里曾经有一行 `closeBefore` 把全部会话清掉**，理由写的是"中继重启过：
        // 它手里的 convId 全没了，本地留着也只会解不开"。但 `this.generation` 是
        // **主机进程内的自增计数器**，中继重启与主机重启在这里长得一模一样——
        // 于是每次主机重启（自举迭代、改配置、崩溃重启）都自毁全部配对，
        // 手机只能重新扫码。详见文件头。
        //
        // 现在只推进连接代号（喂给发码窗口），会话一律留着。
        this.generation += 1
        this.emitState('online')
        // `resync` 声明的是"本端**仍持有密钥**的会话"。恢复出来的会话必须列进去，
        // 否则中继的 resync 会把它们当成主机已经放弃的通道删掉，
        // 手机下次发帧就撞 `unknown_session`（= 免扫码重连失败的典型症状）。
        this.raw(resyncFrame(this.conversations.ids()))
        this.options.log('relay online', {
          generation: this.generation,
          conversations: this.conversations.size,
          clients: this.conversations.clientCount(),
        })
        return
      }
      case 'pair-ready':
        this.options.onPairReady(frame.pairingToken, frame.ttlMs)
        return
      case 'peer-joined': {
        // 只有带 pairingToken 的那一条才是"新客户端加入"；重连通知没有 token（客户端的 id 填在 clientId 位）。
        if (!frame.pairingToken) {
          // **重连也要登记成员。** 成员表原来只靠"收到过这台手机的 enc 帧"长出来
          // （见 onEncrypted），于是手机回前台之后、在它第一次发东西之前，本端以为
          // "这条会话没人"——任何以"有没有活客户端"为准的判断（要不要广播、
          // 审批该不该交还桌面、status.json 里那台数）都会错一拍。
          const conversation = this.conversations.get(frame.sessionId)
          if (conversation && frame.clientId) conversation.clientIds.add(frame.clientId)
          return
        }
        const slot = this.options.lookupPairingSlot(frame.pairingToken)
        if (!slot) {
          this.options.log('peer-joined without a known pairing token', { sessionId: frame.sessionId })
          return
        }
        this.conversations.open({
          id: frame.sessionId,
          psk: slot.psk,
          now: this.options.clock.now(),
        })
        // **新通道立刻落盘**：配对成功这一刻是用户刚扫完码的那几秒，
        // 此时崩了而没落盘，用户看到的下一次表现是"手机还在说已连接、主机却不理它"，
        // 而按键重新配对的成本远高于每秒写一次盘。
        this.options.onStructuralChange?.()
        // 新通道同样立刻记成员：这一帧就带着 clientId，等它发第一帧才记会让"刚配好的手机"
        // 在头几秒里被当成没连着。
        if (frame.clientId) this.conversations.get(frame.sessionId)?.clientIds.add(frame.clientId)
        // 这条通道现在又有密钥了：清掉"已声明作废"的记号，否则下次真要作废时发不出去。
        this.voided.delete(frame.sessionId)
        this.raw(resyncFrame(this.conversations.ids()))
        this.emitState('online')
        this.options.onPeerJoined(frame.sessionId, frame.pairingToken)
        return
      }
      case 'peer-left':
        // 发给主机的这一帧含义是"某个客户端走了"，会话**必须留着**（D3）：
        // 手机回前台时用同一个 convId 回来，成员表还在，路由就能重建。
        // 反过来，发给客户端的 peer-left 只有一个合法触发（主机离开），
        // 那由中继侧保证，本端不猜。
        // 成员表要在这里摘掉这个 clientId：会话留着 ≠ 这台手机还连着。
        // 不摘的话，一部解了配的手机在 status.json 里仍然算"已连接"，
        // 而它再也不会回来 —— 那个状态没有任何东西会清掉。
        // **主动解配**：中继告诉我们这一条是用户点的「解除配对」，不是掉线。
        // 这时那条会话必须一起作废——手机 unpair() 里已经 _forgetPairing() 清了 convId，
        // 它再也不会带这个 convId 回来。留着它就是一条永远清不掉的幽灵：
        // clientCount 归 0 而 conversationCount 仍是 1，pill 于是永远说「手机离线」
        // （2026-10-05 用户报：「mp 端解除配对，dsh 端执行的是手机离线」）。
        //
        // 走 voidConversation 而不是只摘成员：它同时会落盘、发 session-leave、
        // 通知 onConversationGone —— 与主机自己那侧「退出配对」完全同一条路，
        // 两端解配的语义这才对称（原来只有主机→手机那侧是对称的）。
        if (frame.unpaired) {
          this.voidConversation(frame.sessionId)
          return
        }
        if (frame.clientId) this.conversations.get(frame.sessionId)?.clientIds.delete(frame.clientId)
        this.options.onClientLeft(frame.sessionId, frame.clientId)
        this.emitState('online')
        return
      case 'paired':
        return
      case 'pair-fail':
        // 第一版这个 case 根本没有：手机扫码后中继回了"这张码已用过/已过期"，
        // 主机一侧完全无痕，status.json 也看不出配对为什么没成。
        // 清槽是安全的：这张码的 PSK 已经不可能再被用上了。
        this.options.log('pair failed', { reason: frame.reason })
        this.options.onPairFail?.(frame.reason, frame.pairingToken)
        return
      case 'error':
        // 中继只会把错误码发给"该对它负责"的那一端；本端把它记进状态，
        // 会话清理交给 enc 路径（那里才知道具体是哪条通道）。
        //
        // **按码分支**（2026-10-07 接线）：此前这一帧只被记进日志，主机从不按 `code`
        // 判断，于是协议层那张"哪些码值得原样重试"的表在本端完全没被用上。
        // 判据是 `isRetryableError`（协议层 §12.2）——它把"重发有没有可能在下一次成功"
        // 变成一个事实，而这张表**不在本文件里**是有理由的：哪些码可重试是协议知识，
        // 本地退避的具体秒数才是本端的策略。
        //
        // ⚠️ 刻意**不**在这里自动重发：`bad_frame` / `unknown_frame` 标的是**对端的 bug**，
        // 把它们当可重试会让主机在一条永远不会自愈的连接上无限重试，而重试是有限额度的
        // ——它会把额度耗在"重发同一条坏帧"上。真正需要动作的只有一个码：
        // `rate_limited`，而它的处置（暂缓发码）已经由 `onRelayError` 交给策略层。
        this.options.log('relay error frame', {
          code: frame.code,
          retryable: isRetryableError(frame.code),
          ...(frame.message === undefined ? {} : { message: frame.message }),
        })
        // 交给策略层（2026-10-07）：此前这一帧只被记进日志，主机从不按 code 分支。
        // `retryAfterMs` 用 `in` 收窄而不是直接取：主机钉的那一版 wire 里可能还没有
        // 这个字段（加性的、可选的），中继也可能是更老的一版。这里要的是
        // "有就用、没有就退回自己的下限"，所以对字段存在与否做一次显式判定。
        const hinted = 'retryAfterMs' in frame ? frame.retryAfterMs : undefined
        this.options.onRelayError?.(frame.code, typeof hinted === 'number' ? hinted : undefined)
        return
      case 'pong':
        // 探针的答复到了：这一轮的问题作废（没有待答问题时可视为心跳噪声）。
        this.clearPongDeadline()
        return
      case 'enc':
      case 'enc-batch':
        this.onEncrypted(frame)
        return
      default:
        // F1 的纪律：新帧名必须被静默忽略、不许破坏状态，但**必须留痕**。
        // 没有这一条的话，中继侧加一个名字、主机侧永远是哑的，只能靠猜。
        this.options.log('relay frame ignored (no handler)', { t: (frame as { t?: string }).t ?? '?' })
        return
    }
  }

  private onEncrypted(frame: {
    sessionId: string
    clientId?: string
    ciphertext?: string
    items?: Array<{ ciphertext: string }>
  }): void {
    const conversation = this.conversations.get(frame.sessionId)
    if (!conversation) {
      // 本端已经没有这把钥匙：留着通道只会让手机对着一个听不见的对端说话。
      this.voidConversation(frame.sessionId)
      return
    }
    // 登记这台手机。**必须在这里记，不能只在 open() 时记**：open() 那一刻
    // 成员表是空的（配对刚发生），此后进来的每一帧才带得上 clientId。
    // 漏了这一步的话 `clientCount()` 恒为 0，status.json 里"有几台手机"
    // 永远是 0 —— 那不是"没人连"，是没人记。
    if (frame.clientId) conversation.clientIds.add(frame.clientId)
    const records = frame.items ?? (frame.ciphertext === undefined ? [] : [{ ciphertext: frame.ciphertext }])
    let decryptedAny = false
    for (const record of records) {
      if (!base64Text.safeParse(record.ciphertext).success) continue
      const decrypted = open<unknown>(conversation.kC2H, { ciphertext: record.ciphertext })
      if (!decrypted) {
        // 解不开 = 这端已经没有对应密钥，交给"两次就作废"那条出口。
        this.noteUndecryptable(frame.sessionId)
        continue
      }
      /**
       * **MAC 过了就算这条会话有活动**，与它后面过不过 schema 无关（2026-10-07 挪到这）。
       *
       * 原来 `decryptedAny` 记在 schema 通过之后，于是"解得开但形状不对"的帧不会更新
       * `lastActivityAt` —— 那条会话会被剪枝判成闲置。而活动的定义是"这端有人在说话"，
       * 一条真实配对客户端发来的、我们能解的帧当然算；它形状不对是**协议版本**的事，
       * 不是"没人理这条通道"的事。
       * 攻击面也没变化：能产出这种帧的人必须先拿到 PSK。
       */
      // MAC 过了不等于形状对。`onCommand` 下游是 `switch (cmd.t)` + 真实内核调用，
      // 把未校验的对象直接递下去 = 让手机用一条密文决定宿主被怎么调用。
      decryptedAny = true
      const cmd = parseCmdPayload(decrypted)
      if (!cmd) {
        const name =
          typeof (decrypted as { t?: unknown }).t === 'string' ? String((decrypted as { t?: unknown }).t) : '?'
        const cmdId = (decrypted as { cmdId?: unknown }).cmdId
        this.options.log('inbound payload failed cmd schema', { sessionId: frame.sessionId, t: name })
        // 交出去而不是只记日志：没有这一条，手机那边就是干等 12 秒再报
        // 「主机没有回应」，而根因只活在主机的日志里。
        this.options.onInvalidCommand?.(frame.sessionId, typeof cmdId === 'string' ? cmdId : undefined, name)
        continue
      }
      this.options.onCommand(frame.sessionId, cmd, (frame as { clientId?: string }).clientId)
    }
    // 有实际收发就不算"闲置"：剪枝看的是最后活动时刻，不是创建时刻。
    if (decryptedAny) {
      conversation.lastActivityAt = this.options.clock.now()
      this.options.onBookActivity?.()
      this.undecryptable.delete(frame.sessionId)
    }
  }

  /** 两次解不开就作废（与手机端"两帧解不开就丢配对"对称，避免一端永久静默）。 */
  private noteUndecryptable(conversationId: string): void {
    const count = (this.undecryptable.get(conversationId) ?? 0) + 1
    this.undecryptable.set(conversationId, count)
    this.options.log('inbound frame could not be decrypted', { conversationId, count })
    if (count >= 2) this.voidConversation(conversationId)
  }

  private scheduleReconnect(problem: string): void {
    if (this.stopped) return
    /**
     * **已经排着一次重连就不再排**（2026-10-06）。
     *
     * 握手超时那条路会**同时**踩到两个调用点：超时回调里 `terminate()` + 直接
     * `scheduleReconnect('握手超时')`，而 `terminate()` 又会逼出 `close` 事件、
     * 那条路径再 `scheduleReconnect('closed …')` 一次。两个 timer 各自延时执行，
     * 不但退避按 2 的幂翻倍（4 倍增长），后一个还会把前一个刚建立的连接掐掉
     * —— 表现是"刚连上又断"的抖动。
     */
    if (this.reconnectTimer !== undefined) return
    this.emitState('offline', problem)
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts)
    this.attempts += 1
    const delay = base + Math.floor((randomBytes(2).readUInt16BE(0) / 65536) * 500)
    this.reconnectTimer = this.options.clock.setTimeout(() => {
      // 定时器已经用掉了：不清的话下面每一次 scheduleReconnect 都会被上面那道闸门挡回去，
      // 重连就此永久停摆（比双 timer 更糟）。
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = undefined
    if (this.handshakeTimer !== undefined) {
      this.options.clock.clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
    }
    // 探针跟着连接走：不清的话旧 socket 的提问会把新连接判死（表现为连上就重连）。
    this.stopProbe()
    if (!socket) return
    socket.removeAllListeners()
    // 摘完监听器必须补一个 error 兜底，**不能只靠下面的 try/catch**。
    // 原因：socket 还在 CONNECTING 时 ws 的 close() 会走 abortHandshake，那条路径是
    // `process.nextTick(emitErrorAndClose, ...)` —— 错误是**异步**发出来的，
    // 同步的 try/catch 根本拦不到；而此时 removeAllListeners() 已经把 error 监听器
    // 一起摘了，于是它无人接手、升级成 uncaughtException 把进程带崩。
    // 表现就是 e2e 偶发红：'WebSocket was closed before the connection was established'
    // （只有在"连接还没建好就停机"这个窗口里才触发，所以时红时绿）。
    socket.on('error', () => {})
    try {
      socket.close()
    } catch {
      /* 已经关了 */
    }
  }

  // ── 存活探针 ────────────────────────────────────────────────────────

  /**
   * 每隔 `probeIntervalMs` 问中继一句 `ping`，并给答复留 `probeTimeoutMs`。
   *
   * 用**自重启的 setTimeout 链**而不是 setInterval：时钟接口只有 setTimeout
   * （见 `Clock`），而且链式写法天然带上"上一轮还没答就下一轮"的语义——
   * 超时判死之后这条链也跟着 socket 一起被 closeSocket 收掉。
   *
   * `ping`/`pong` 是协议里本来就有的一对应用帧（中继无条件回 pong），
   * 所以这一跳不需要动线协议；不直接用 ws 协议层 ping 是因为那一条在
   * Node 的 ws 里由库自动应答，两端都"看得见"却都不留痕，排障时查不到。
   */
  private startProbe(socket: WebSocket): void {
    this.stopProbe()
    const interval = this.options.probeIntervalMs ?? PROBE_INTERVAL_MS
    const timeout = this.options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    const ask = (): void => {
      // 连接已经换了/停了：这条链到此为止（closeSocket 会负责清定时器，
      // 这里只保证不再对旧 socket 发问）。
      if (this.stopped || this.socket !== socket) return
      if (socket.readyState === WebSocket.OPEN) {
        this.raw(pingFrame(this.options.clock.now()))
        this.clearPongDeadline()
        this.pongDeadline = this.options.clock.setTimeout(() => {
          // terminate 而不是 close：半开连接上 close() 要等 TCP 挥手，
          // 而那条路早就断了——强拆才会逼出 close 事件，进而走重连。
          this.options.log('relay probe timeout', { waitedMs: timeout })
          socket.terminate()
        }, timeout)
      }
      this.probeTimer = this.options.clock.setTimeout(ask, interval)
    }
    this.probeTimer = this.options.clock.setTimeout(ask, interval)
  }

  private stopProbe(): void {
    if (this.probeTimer !== undefined) {
      this.options.clock.clearTimeout(this.probeTimer)
      this.probeTimer = undefined
    }
    this.clearPongDeadline()
  }

  private clearPongDeadline(): void {
    if (this.pongDeadline !== undefined) {
      this.options.clock.clearTimeout(this.pongDeadline)
      this.pongDeadline = undefined
    }
  }

  private emitState(relay: RelayStateInfo['relay'], problem?: string): void {
    this.options.onState({
      relay,
      ...(problem === undefined ? {} : { problem }),
      // 之前这里写的是 `conversations.size`，把"会话数"顶替成了"客户端数"：
      // 一部手机解配再重配就多一条会话，于是这个字段会**变大** ——
      // 拿它回答"现在有几台手机连着"会得出相反的结论。
      clients: this.conversations.clientCount(),
      conversations: this.conversations.size,
      generation: this.generation,
    })
  }
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error)
}
