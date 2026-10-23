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
import { messageOf } from '../shell/log-line.js'
import { randomBytes } from 'node:crypto'
import {
  type CmdPayload,
  type EndpointFrame,
  type EvPayload,
  base64Text,
  encToClient,
  helloForHost,
  isRetryableError,
  open,
  pairBegin,
  pairGrant,
  parseCmdPayload,
  parseRelayFrameText,
  ping as pingFrame,
  resync as resyncFrame,
  seal,
  sessionLeave,
  summary as summaryFrame,
  type StatusDigest,
} from '@dsh-remote/protocol'
import { ConversationBook, DEFAULT_PRUNE_POLICY, type PairSlot, type PrunePolicy } from '../core/keys.js'
import type { Clock } from '../ports/index.js'

export interface RelayClientOptions {
  url: string
  hostId: string
  label: string
  /**
   * 本端软件版本（2026-10-22）：**给了就填进 `hello` 帧**，不给就不带。
   *
   * ⚠️ **`hello` 是明文帧** ⇒ 中继看得见 ⇒ **默认不给**（`undefined`）
   * ⇒ 发出去的帧**逐字节与加这个字段之前相同** ⇒ **零知识不变**。
   * 只有显式打开（`DRC_REPORT_VERSION=1`）的部署才会给。
   */
  softwareVersion?: string
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
   * **手机端点了「解除配对」**（`peer-left{unpaired:true}`，2026-10-23 补）。
   *
   * 与 `onClientLeft` 是两件事，别合并：那条是"掉线，会话留着等它回来"（D3），
   * 这条是"这部手机再也不带这个 convId 回来了"——会话已经在本文件里作废，
   * 上层还要做的是**让主机屏幕回到"能再配一次"的样子**。
   *
   * 为什么必须由本文件提供这个出口：解配那一刻主机还缺一张码。屏幕那张已被
   * 这次配对消费掉（中继 `claim` 即烧），而自动发码 `pairOnStartSec` 默认 **0**
   * ⇒ 没有任何东西会补 ⇒ pill 停在「未连接」+ 一颗「刷新」按钮，用户以为坏了
   * （2026-10-23 用户报："手机端退出配对，主机端不会自动刷码"）。
   * 主机自己那颗「退出配对」按钮（`unpairAll`）早就会补一张，两端语义应当对称。
   */
  onClientUnpaired?: (conversationId: string) => void
  /**
   * **某个客户端回到了这条会话**（与 `onClientLeft` 严格成对）——2026-10-08 补。
   *
   * ## 为什么必须由本文件来判、而不是由调用方去猜
   *
   * "手机回来了"这件事在链路上**没有一条专门的帧**。中继侧那条无 token 的
   * `peer-joined` 重放 2026-10-06 就删掉了（`server.ts` 里留着取证注释：它当年把
   * hostId 塞进 clientId 字段，语义就是错的），而 `peerJoinedForHost` 的
   * `pairingToken` 是**必填**参数 ⇒ 现在中继只会在**配对那一刻**通知主机。
   * 于是"手机回前台 / 切回网络"这条路上，主机**什么都不会收到**：
   * 它既不知道客户端离开过（`peer-left` 会到），也不知道它回来了。
   *
   * 而主机确实知道 —— 只是没人把那个事实说出来：`peer-left` 会把这台手机从
   * `conversation.clientIds` 里摘掉（不摘的话 status.json 里"有几台手机"永远清不掉），
   * 此后**第一帧解得开的密文**到达时它又被加回去。那次"加回去"就是"它回来了"。
   *
   * ## 为什么必须修（规范 §13.2 L4）
   *
   * L4 写的是 host MUST 在**（重）连上**与状态变化时各发一次 `ev.host_info`。
   * 缺了这一条，"重连"那一半从来没有发生过 —— 而它的后果正好是本轮 B4 要的东西：
   * 手机在 `_onHelloOk` 里把上一连接的那份结论清空（那是对的：新连接 = 上一代的状态作废），
   * 此后**再也收不到**新的 `ev.host_info` ⇒ 重连后手机手上什么都没有，
   * 断线重连永远走整页重读（且**不报错**）。`index.ts` 那段"这个位置同时覆盖新配对与重连"
   * 的注释是**照设计意图写的**，不是照实际调用链写的（实际只有配对那一半）。
   *
   * ## 为什么在**解密的循环之前**触发
   *
   * 帧顺序是判据的一部分：手机重连后必定先发 `cmd.list_sessions`（`_onHelloOk`），
   * 而页面是在**收到它对应的 `ev.session_changed`** 时才把 status 翻成 `online`，
   * 并在那一刻调 `_tryLoadDelta()`。所以 `ev.host_info` 必须排在那条回执**之前**
   * 走出去，手机才可能在同一个批次里"先知道这一代主机的状态、再做附件的决定"。
   *
   * ⚠️ **真正决定顺序的是"同一个 tick"，不是"在这段代码里的第几行"**（2026-10-08 实测）：
   * `onCommand` 是 `void runtime.handleCommand(...)`，而 `handleCommand` 是 async、
   * 处理 `cmd.session_history` 时必然先 `await readHistory(...)`，所以**无论如何**它的回执
   * 都排在本次帧处理之后。把这一行挪到 `decryptedAny` 那一段（循环之后）跑 e2e —— **仍然绿**。
   * 把触发推迟一个 tick（`setTimeout(..., 0)`，即"别在帧处理路径里干重活"那种写法）
   * —— **立刻红**，报的是 `ev.host_info` 掉到了最后一条。
   * 所以这一条的判据在 `e2e/wire-resume-delta.test.mjs` 的帧顺序断言上，而它挡的是
   * "**推迟宣告**"这一类改法，不是"挪一行"。放在循环之前只是顺带更稳（不依赖下游是异步的）。
   *
   * 代价是"加回成员"这一刻还没验 MAC。可接受，理由两条：`frame.clientId` 不是
   * 发送方自称的，是中继按**已认证连接**填进去的；而且它触发的动作只是"再报一次
   * 自己的能力面"，既不含密钥也不改状态。
   *
   * ## 3.2 起它还有一个触发点：**刚配对完的那一帧**（2026-10-21）
   *
   * 上面那一整套的隐含前提是"`peer-joined` 那一刻手机已经拿得到密钥"。3.2 把配对改成
   * `pair-grant` 之后这个前提**不成立了**：`peer-joined` 先到（手机连上就发），
   * `pair-grant` 后到，而用户还得比对 6 位数字才装 psk。于是 `index.ts` 在
   * `onPeerJoined` 里推的能力面与挂起卡**全部被静默丢掉**（判据：`e2e/mp-client.test.mjs`
   * 的 12j —— 它红了整整一轮才发现"扫码配完对，主机自报的限额永远到不了手机"）。
   *
   * 所以本回调的语义统一成一句话：**"这台手机的密钥面可以用来推东西了"**，两个触发点
   * ——① `peer-left` 之后的第一帧解得开的东西（回来）；② 刚配对的会话的第一帧解得开的
   * 东西（配完）。两者都是"第一帧解得开的密文"，实现上是同一个判断
   * （{@link awaitingKeys}）。
   */
  onClientRejoined?: (conversationId: string, clientId: string) => void
  /**
   * 按 `peer-joined` 回传的 pairingToken 取本地那张码。
   * 取不到必须返回 null 并由调用方拒绝这条配对——**不允许**退化成"取最新的一张"，
   * 那正是多码并存事故的形状。
   */
  lookupPairingSlot: (token: string) => PairSlot | null
  /** `pair-ready` 到达：调用方据此改写本地 PSK 过期时间。 */
  onPairReady: (pairingToken: string, ttlMs: number) => void
  /**
   * 手机拿着小程序码场景来认领，并带了一枚一次性公钥（2026-10-21）。
   *
   * 回调负责：算出 6 位数字挂到状态上（给人看）、等用户确认后再回 `pair-grant`。
   * **未接这个回调也不影响老链路**：没有 `clientPub` 的认领根本不会产生这条帧。
   */
  onPairRequest?: (pairingToken: string, clientPub: string, sessionId: string) => void
  /** 主机侧确认之后回给手机的 psk 密文（2026-10-21）。 */
  sendPairGrant?(granted: { sessionId: string; hostPub: string; nonce: string; wrappedPsk: string }): void
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
   * @param pairingToken **是哪一张码失败的**；中继电器在"收到坏帧，点不出是哪一张"
   *        这一档给不出名字（`server.ts` 的 `bad_frame` 分支），此时接线方**必须**
   *        退回"当前展示的那张"—— 见下面那条误伤的说明。
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
   * 缺省是 undefined 而不是必填：**中继不总能点出是哪一张**（收到坏帧那条分支没有
   * token 可点名，`server.ts` 里那条 `bad_frame`）。缺省时接线方按"当前展示的那张"兜底。
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
  /**
   * 中继在 hello-ok 里**声明**的能力面（M-C，PLAN-v5）："按声明开"的判据本体。
   *
   * 与 generation 同一清点：新连接 = 上一代声明作废，重新记。没声明 `digest.v1`
   * 就发 `summary` 会被老中继回 `unknown_frame` —— "老端点零报错"被自己破掉。
   */
  private relayCaps: Record<string, true> = {}
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
  /**
   * **刚配对、还一次都没解开过东西**的会话（2026-10-21）。
   *
   * 3.2 起配对只有 `pair-grant` 一条路：手机在 `peer-joined` 那一刻手上**没有 psk**
   * （它在 `pair-grant` 里，用户比对完 6 位数字才装进 `kH2C`）。所以那一刻推过去的东西
   * （`ev.host_info`、挂起的审批/提问）它**一帧都解不开**，而且是静默丢
   * （`client.js` 的 `_onEncrypted` 开头就 `if (!this.kH2C) return false`，连
   * "解密失败"都不记）。⇒ 真正该记的时刻是**这台手机的第一帧解得开的东西到了**，
   * 那才证明密钥面已就绪。这个集合就是"还没等到那一刻"的名单。
   *
   * 名字里的 keys 指手机的 `kH2C`：主机侧 `kC2H/kH2C` 在 `open()` 时就有，无意义。
   */
  private readonly awaitingKeys = new Set<string>()

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

  /**
   * **传输诊断**（进 status.json 的 `diagnostics.transport`，V3-PLAN §7 阶段 F4）。
   *
   * 为什么要有：`relay`/`relayProblem` 只说"此刻连没连上"，而排错真正要答的是
   * **"它连得上吗"**——一条长期停在 `connecting` 且不报错的链（版本不匹配）
   * 与一条每 3 秒重连一次的链（网络/白名单）在字段上完全一样。
   * `connects > 1` 就是"它至少掉过一次"，`lastConnectedAtSec` 让"多久没连上过"可读。
   */
  private readonly transportCount = { connects: 0, connectAttempts: 0, disconnects: 0 }
  private connectedAtMs: number | null = null
  get transport(): {
    connects: number
    connectAttempts: number
    disconnects: number
    /**
     * 距上次**连上**过了多少秒；从未连上是 `null`。
     *
     * ⚠️ 是 `null` 而不是 0：「0」会被读成"0 秒前刚连上"，而那与"从来没连上过"
     * 是两件完全不同的事 —— 后者正是最该被人看见的一种。
     */
    lastConnectedAtSec: number | null
  } {
    const now = this.options.clock.now()
    const lastConnectedAtSec =
      this.connectedAtMs === null ? null : Math.max(0, Math.floor((now - this.connectedAtMs) / 1000))
    return { ...this.transportCount, lastConnectedAtSec }
  }

  connect(): void {
    if (this.stopped) return
    this.closeSocket()
    this.transportCount.connectAttempts += 1
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
      this.transportCount.connects += 1
      this.connectedAtMs = this.options.clock.now()
      // D5：主机与客户端共用一条注册帧。PSK 从不上网（D1），这里只有 host token。
      // `protocol` 由构造器恒写成本端版本（单版本制，见协议层的 `negotiate.ts`）。
      this.raw(
        helloForHost({
          token: this.options.token,
          hostId: this.options.hostId,
          label: this.options.label,
          // ⚠️ **缺省就不带这个键** ⇒ 不开开关的部署发出去的帧逐字节相同（零知识不变）。
          ...(this.options.softwareVersion === undefined ? {} : { softwareVersion: this.options.softwareVersion }),
        }),
      )
    })
    socket.on('message', (raw) => this.onFrame(String(raw)))
    // 存活探针：半开连接在本地是隐形的（对端走了、close 永不来），只能靠问。
    this.startProbe(socket)
    socket.on('close', (code, reason) => {
      this.options.clock.clearTimeout(timeout)
      this.transportCount.disconnects += 1
      this.connectedAtMs = null
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

  /**
   * 断开并在 `delayMs` 之后重连一次（2026-10-11 晚加，给"自愈冷却窗口"用）。
   *
   * ⚠️ 为什么不能只"什么都不做"：中继拒绝 host token 时**不关连接**，而 `hello` 只在
   * `open` 时发一次 ⇒ 一条被拒的 socket 会以"连接中"的样子永远挂着、再也不会有第二帧
   * 进来。所以"现在不想重试"也必须**排一次**重连，只是在 `delayMs` 之后。
   *
   * 已经排着一次就**不重复排**（与 `scheduleReconnect` 同一条纪律）：否则每个
   * `bad_token` 都排一发，等于把冷却窗口作废。
   */
  reconnectIn(delayMs: number, reason: string): void {
    if (this.stopped) return
    this.closeSocket()
    if (this.reconnectTimer !== undefined) return
    this.emitState('offline', reason)
    this.reconnectTimer = this.options.clock.setTimeout(
      () => {
        this.reconnectTimer = undefined
        this.connect()
      },
      Math.max(0, delayMs),
    )
  }

  /**
   * 换掉主机令牌并**立刻重连**（2026-10-11 晚加，给"认领自愈"用）。
   *
   * ## 为什么必须是"换 + 重连"，不能只换
   *
   * `hello` 帧**只在 `open` 那一刻发一次**（见 `connect()`），而中继拒绝一枚 host token
   * 时是回一条 `error{bad_token}` 然后**继续挂着这条 socket**。所以本地把 token 改了，
   * 这条已经在线的（但没通过鉴权的）连接也不会重新认一次 —— 它会一直"连接中"。
   *
   * ⇒ 关掉旧 socket 再连一次：新 socket 的 `open` 会用**新令牌**重发 `hello`。
   * 另外把 `attempts` 归零：退避是给"网络不通"用的，不该让一次成功的令牌更换
   * 还背着之前累积的指数退避（最坏要等 BACKOFF_MAX_MS 才用上新令牌）。
   */
  replaceToken(token: string): void {
    this.options.token = token
    if (this.reconnectTimer !== undefined) {
      this.options.clock.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.attempts = 0
    if (this.stopped) return
    // `connect()` 第一句就是 `closeSocket()`：旧监听器会先被摘干净，再见新连接。
    this.connect()
  }

  /**
   * 断开并按**正常退避**重连（2026-10-11 晚加，给"认领自愈失败"那条路用）。
   *
   * 与 `replaceToken` 的差别只有一处：**不动 `attempts`**，所以下次重连仍按指数退避，
   * 不会变成"失败一次就立刻重连一次"的紧凑循环。
   *
   * 为什么需要它：中继拒绝 host token 时**不会关连接**，而 `hello` 只在 `open` 时发一次
   * ⇒ 插件不自己重连的话，这台主机会以"连接中"的样子**永远挂着**（连 auth failed
   * 日志都不会再有第二条）。
   */
  reconnectWithBackoff(problem: string): void {
    if (this.stopped) return
    this.closeSocket()
    this.scheduleReconnect(problem)
  }

  /** 发布一张新的配对码（PSK 留在本地，中继只拿到 6 位码）。
   *
   * 返回 false = socket 不在 OPEN 状态、这条 `pair-begin` **根本没上过网**。
   * 调用方不能把这张码记成"有效"，否则 status.json 会展示一张中继没见过的码，
   * 而手机扫它必然失败（取证 docs/legacy-spec/host-plugin-runtime.md §6.2）。
   */
  /**
   * 把 psk 的密文回给手机（2026-10-21）。**只有主机确认之后才会走到这里**：
   * 调用点是 `POST /pair/approve`，而那条路由要 `x-drc-pair` + 回环源。
   */
  sendPairGrant(granted: { sessionId: string; hostPub: string; nonce: string; wrappedPsk: string }): void {
    this.raw(pairGrant(granted.sessionId, granted.hostPub, granted.nonce, granted.wrappedPsk))
  }

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

  /**
   * 向一条配对会话发一条载荷；返回 false = 这条会话已经没了，或**现在没有活着的客户端**
   * （且调用方没带 `includeNoClient`）。
   *
   * `includeNoClient`（P1-3 后半步，2026-10-22）：**run 输出**（内核事件管道转发的
   * delta/tool/run-state/todo/retry/compaction）在没人听时也要上线 —— 中继的环形缓冲
   * 会把它接住，手机重连 `hello.resume` 时补投（§10.8）。周期状态帧不带它（见
   * `broadcast` 的注释：5737 的噪声就是它们刷出来的）。
   */
  send(conversationId: string, payload: EvPayload, opts?: { includeNoClient?: boolean }): boolean {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return false
    // 有密钥 ≠ 有人能收到。手机退到后台/断开时会话要留着（D3 靠它重建路由）。
    // 周期状态帧（session_changed/model/keep_awake_state）在没人听时**不上线**：
    // 手机不在的时候主机照样每 15 秒产生一轮状态，以前每一帧都会被中继计成一次丢帧
    // （真机实测 45 秒涨 9，`droppedFrames` 就一直是这一路噪声主导）。
    // run 输出则相反：不上线 = 用户回来看到"内容跳变"，那才是不可恢复的损失。
    if (conversation.clientIds.size === 0 && !opts?.includeNoClient) return false
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

  broadcast(payload: EvPayload, opts?: { includeNoClient?: boolean }): number {
    let sent = 0
    for (const id of this.conversations.ids()) {
      // 没有活客户端的会话**不上线**（除非调用方带 `includeNoClient` = run 输出）：
      // 手机不在的时候主机照样每 15 秒产生一轮状态，以前每一帧都会被中继计成一次丢帧
      // （真机实测 45 秒涨 9，`droppedFrames` 就一直是这一路噪声主导）。跳过之后调用方
      // 仍会把这次记成 `*_no_peer`——那是本地计数，说的是"主机想发、当时没人听"，
      // 与"帧上了线又被丢"是两件事，前者不该污染后者。
      //
      // run 输出（`includeNoClient`）语义相反：**离线期的输出必须上线**，中继的环形
      // 缓冲接住、手机重连补投（P1-3）。那种帧的"没人收"是暂时的（环在收），
      // 记 `*_no_peer` 反而是假账 —— 所以 `send` 对它们返回 true。
      if (!this.conversations.hasClient(id) && !opts?.includeNoClient) continue
      if (this.send(id, payload, opts)) sent += 1
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
   * 登记状态摘要（M2，REVIEW §5.1）：控制面**明文**帧，中继存进会话条目并落盘。
   *
   * 与 `broadcast` 的两条差别：
   * ① **不看 hasClient** —— 摘要的消费者恰恰是"手机不在的那段时间"（中继存着，
   *    回头给手机回放"最后已知"），没人听才是它最该登记的时刻；
   * ② 走 `raw()` 不走加密信封 —— 它是零知识边界上唯一被中继读取的业务面，
   *    形状防线在协议侧 `statusDigest`（strict：自由文本键整帧拒收）。
   *
   * 作废（voided）的通道跳过：那条已经对中继宣布过"别再转"，别再写它的条目。
   */
  pushSummary(digest: StatusDigest): number {
    // 按声明开（M-C）：中继没声明 digest.v1 ⇒ 一个字节都不发。
    // 老中继解析不了 `summary` 帧（回 unknown_frame），发了就是给两端刷错误。
    if (!this.relayCaps['digest.v1']) return 0
    let sent = 0
    for (const id of this.conversations.ids()) {
      if (this.voided.has(id)) continue
      if (this.raw(summaryFrame(id, digest))) sent += 1
    }
    return sent
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
    this.awaitingKeys.delete(conversationId)
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
        // 能力面跟着连接走（M-C）：新连接 = 重新记，别把上一代的声明带过来。
        this.relayCaps = {}
        if (Array.isArray(frame.capabilities)) {
          for (const id of frame.capabilities) if (typeof id === 'string') this.relayCaps[id] = true
        }
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
      case 'pair-request':
        /**
         * 小程序码路线（2026-10-21）：中继把手机的一次性公钥转给主机。
         * 这里**只上报**，不自动放行 —— 放行必须等人比对 6 位数字（见 shell/pair-approval.ts）。
         */
        this.options.onPairRequest?.(frame.pairingToken, frame.clientPub, frame.sessionId)
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
        /**
         * 但"连着"不等于"解得开"：这条通道的 psk 要到 `pair-grant` 之后才装进手机
         * （见 {@link awaitingKeys}）。登记进名单，等它第一帧解得开的东西到了再喊人推能力面。
         */
        this.awaitingKeys.add(frame.sessionId)
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
          // 作废之后再补一张码（顺序不能反：作废会走 `onConversationGone` 清确认码，
          // 补发要在那之后，否则新码可能被当成旧会话的收尾一起处理掉）。
          this.options.onClientUnpaired?.(frame.sessionId)
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
        // `retryAfterMs` 用 `in` 收窄而不是直接取：协议里它是**可选的**
        // （不是每个错误码都知道该等多久），所以这里要的是"有就用、没有就退回自己的下限"。
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
    //
    // ⚠️ **"本来不在表里"是唯一能读到"客户端回来了"的地方**（2026-10-08）：
    // `peer-left` 摘成员、这里加成员，两次之间的第一次加回就是它回来了。
    // 配对那一刻**不会**重复触发——`peer-joined` 分支已经把它记进去了（下面那一段）。
    // 回调为什么必须在解密之前触发：见 `RelayClientOptions.onClientRejoined` 的注释。
    const rejoined = frame.clientId !== undefined && !conversation.clientIds.has(frame.clientId)
    if (frame.clientId) conversation.clientIds.add(frame.clientId)
    if (rejoined && frame.clientId) this.options.onClientRejoined?.(frame.sessionId, frame.clientId)
    const records = frame.items ?? (frame.ciphertext === undefined ? [] : [{ ciphertext: frame.ciphertext }])
    let decryptedAny = false
    let undecryptableInFrame = 0
    for (const record of records) {
      if (!base64Text.safeParse(record.ciphertext).success) continue
      const decrypted = open<unknown>(conversation.kC2H, { ciphertext: record.ciphertext })
      if (!decrypted) {
        // ⚠️ **一帧记一次，不逐项记**（2026-10-13 review，与 mp 侧同一条契约）。
        // 这里只做标记，循环之后统一记一次 —— 批量帧下逐项各记一次的话，
        // **一条**含两个坏项的帧就能把"两次机会"烧光、直接作废配对，
        // 而手机侧（`core/client.js` 的 enc-batch 分支）修的正是同一个病。
        undecryptableInFrame += 1
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
      /**
       * **刚配对的那条会话，第一帧解得开的东西就是"密钥面就绪"的唯一信号**
       * （{@link awaitingKeys} 与 `onClientRejoined` 第二条触发点）。
       *
       * 位置必须在 `parseCmdPayload` / `onCommand` 之前：手机配完对立刻发
       * `cmd.list_sessions`（`client.js` 的 `_onPaired` 末尾），而能力面那一帧要排在
       * 它的回执**之前** —— 与重连那条路同一条帧顺序纪律。
       */
      if (this.awaitingKeys.delete(frame.sessionId) && frame.clientId) {
        this.options.onClientRejoined?.(frame.sessionId, frame.clientId)
      }
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
    /**
     * 与 mp 侧同一条契约（`core/client.js` 的 enc-batch 分支，那里有完整取证）：
     *
     * - **有形状合法却解不开的、且一条都没解开** ⇒ 这帧真的坏了，记**一次**
     *   （不论坏了几条——一条批量帧不该比一条单帧更"坏"）；
     * - **混合帧**（至少一条 MAC 过了）⇒ **不计**：密钥被证明是对的，
     *   坏项只是损坏，不是密钥不匹配（mp 侧：`tried > 0 && !opened` 才记）。
     * - 全是形状不对的（base64 都不是）⇒ 上面循环里已经 skip，一次都不记。
     *
     * 旧行为是逐项记：一条含 2 个坏项的批量帧当场作废配对，手机被迫重扫。
     */
    if (undecryptableInFrame > 0) {
      this.options.log('inbound frame had undecryptable items', {
        conversationId: frame.sessionId,
        undecryptable: undecryptableInFrame,
        total: records.length,
        counted: !decryptedAny,
      })
    }
    if (undecryptableInFrame > 0 && !decryptedAny) this.noteUndecryptable(frame.sessionId)
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
