/**
 * capabilities — 本插件声明的能力面（规范 §5.3 / §17.4），以及"**这一轮真正成立**"的那一份。
 *
 * ## 为什么要有这个文件（而不是留在 `transport/relay.ts` 里）
 *
 * 这份清单原来住在 `transport/relay.ts` 的模块常量里，只喂 `hello`。
 * 但 v3 的 `ev.host_info.caps`（§13.2）要用**同一份**清单——而它是 `core/runtime.ts`
 * 发的。留在 transport 里就得让 core 反向依赖 transport（分层是反的），
 * 或者把清单抄第二遍（那就等于埋了一个"两份清单迟早不同步"的坑）。
 * 所以它搬到 core：清单是"本插件支持什么"，与"怎么把这些字节送出去"无关。
 *
 * ## 两个层次必须分开：**构建级** vs **运行级**
 *
 * - `HOST_CAPABILITIES` = **构建级**：这一版代码实现了什么。喂 `hello`。
 *   它只能这么粗——`hello` 在认证前、`runtime.start()` 之前就要发出去，
 *   那一刻内核端口的能力面还没探过。
 * - `effectiveCapabilities()` = **运行级**：这一轮跑起来之后**真正成立**的那几条。
 *   喂 `ev.host_info.caps`。差集来自"内核这一代没有某个服务"。
 *
 * 用运行级那份回答手机的"对端支持什么"，是规范 §13.1 的全部要点：
 * 同一个"功能存在"在手机上可能表现为可点 / 置灰 / 不出现，而**从形状里推断
 * 必然在边界情形下静默错**。所以要说就说准的。
 */
import type { CapabilityId } from '@dsh-remote/protocol'

/**
 * 本插件在 `hello` 里声明的能力（规范 §5.3 C1/C3）。
 *
 * **只列真正接上了的**，逐条对应一处实现：
 * - `attachments`：`shell/uploads.ts` + `core/runtime.ts` 的整批先验后写；
 * - `history`：`cmd.session_history` 走游标分页（`runtime.ts` 的 historyFace）；
 * - `resume`：`cmd.session_history.since` + `latestSeq` 真的实现了
 *   （`platform/carrier-services.ts` 的 `historyPageFromLog`；2026-10-08 之前这条
 *   在**真实载体**上是缺的，只有 mock 有 —— 补上它之后才允许在这里声明）；
 * - `new-session.workspace`：`cmd.new_session.workspace` 已接线（`carrier-services.ts` 的
 *   `badWorkspace()` 拿到的就是手机传来的路径，不是自己推断的）；
 * - `get-pending`：`cmd.get_pending` 有实现；
 * - `keep-awake`：`cmd.keep_awake` + `ev.keep_awake_state` 有实现（mp 侧没界面，见 HANDOFF §5-14）；
 * - `model`：`ev.model` 有实现；
 * - `retry-compaction`：`ev.retry` / `ev.compaction` 都有（真机各 18 次）；
 * - `idempotency`：`IdempotencyLedger` 按 cmdId 去重（规范 §10.2）；
 * - `resync`：鉴权后发 `resync`；
 * - `host.info`：本文件 + `runtime.ts` 的 `sendHostInfo()`（§13.2，GAP-5 的收口）。
 *
 * **刻意不列**：`drc.crypto.v2`（棘轮是规划中的破坏性变更）、
 * `drc.pairing.token`（6 位码单独输入那条路已删）。
 * 列一个没实现的能力 = 手机按"支持"表现，而实际会干等 12 秒——比不列更糟。
 */
export const HOST_CAPABILITIES: readonly CapabilityId[] = [
  'drc.v1',
  'drc.pairing.qr',
  'drc.payload.attachments',
  'drc.payload.history',
  'drc.payload.resume',
  'drc.payload.new-session.workspace',
  'drc.payload.get-pending',
  'drc.payload.keep-awake',
  'drc.payload.model',
  'drc.payload.retry-compaction',
  'drc.cmd.idempotency',
  'drc.data.enc-batch',
  'drc.host.resync',
  'drc.host.info',
]

/**
 * 内核端口里"某条能力靠什么成立"的探测表。
 *
 * 加一项的门槛：**这一代内核真的可能没有它**，而且缺了之后行为会不同。
 * 目前有两条，理由各自写在下面。
 */
export interface CapabilityProbe {
  /** `KernelPort.readHistory`：宿主没有 `sessionQuery.readSession` 时它是 `undefined`。 */
  readHistory?: unknown
  /**
   * `KernelPort.imageFace`：宿主**此刻**有没有图片通路。
   *
   * **刻意是可选的**，所以"端口没声明"与"端口说没有"必须分成两件事
   * （见 `imageAttachmentsSupported`）。
   */
  imageFace?: () => string
}

/**
 * 图片通路三态：**yes / no / unknown**。
 *
 * ## 为什么图片要单列一条，而不复用能力位
 *
 * `drc.payload.attachments` 这一位覆盖的是 **images / files 两样**，而 2026-10-09
 * 取证到的事实是：同一台主机上**文件附件能用、图片不能用**是可能的
 * （web profile 的 dsh 0.1.0-rc.6：`attachments` 服务在，但模型适配器
 * `dsh-llm-deepseek` 直接抛 `UNSUPPORTED_CONTENT` 拒绝一切图片内容）。
 * ⇒ 用那一位开关会把**能用的文件附件一起关掉**，那是拿一个真功能陪一个假事实。
 *
 * 所以图片走 `ev.host_info.limits.maxImageAttachments`，与
 * `maxFileAttachments`（没配落盘目录就报 0）**同一个形状、同一套理由**：
 * 那两个数字回答的是"这台主机**此刻**真的能收几张"，不是"协议上界是几张"。
 *
 * ## 三态各自的代价（取值规则见函数体）
 *
 * - `no`：手机**早知道**——"+"里那一项在选之前就是灰的，而不是传完整个附件才被拒。
 * - `unknown`：端口没声明这一项。我们**没有证据**，而报 0 会让 mock / 夹具载体
 *   突然失去图片功能（那是一次真的功能回退）。⇒ 保守报"支持"，
 *   代价是那一台上图片会在**发送时**被明确拒绝（不是静默丢弃）。
 */
export type ImageSupport = 'yes' | 'no' | 'unknown'

/**
 * 这台内核**此刻**能不能收图片。
 *
 * 判据是 `carrier-services.ts` 的 `attachmentFace()` 那三个返回值：
 * `commands.prompt` / `attachments.admitPromptContent` 是两条真通路，
 * `absent (…)` 是"这一代内核没有图片通路"。
 *
 * ⚠️ 判**前缀**而不是等值：`absent` 那一支还带着 `commands=… attachments=…`
 * 的现场信息（排错要用），等值比对会把它当成"不认识的状态"而误报 yes。
 */
export function imageAttachmentsSupported(probe: CapabilityProbe): ImageSupport {
  const face = typeof probe.imageFace === 'function' ? probe.imageFace() : undefined
  if (typeof face !== 'string') return 'unknown'
  return face.startsWith('absent') ? 'no' : 'yes'
}

/**
 * 这一轮**真正成立**的能力位。
 *
 * ## 目前只有 `resume` 会被筛掉，以及为什么它必须被筛
 *
 * `drc.payload.resume` 的含义是"支持 `cmd.session_history.since` 补差量"。
 * 而 `KernelPort.readHistory` 是**可选**的：宿主这一代没有 `sessionQuery` 时
 * 那条命令会被明确拒绝（见 `runtime.ts` 的 `cmd.session_history` 分支）。
 * 那种主机上仍报 `resume` 的后果是：手机按"支持"表现，断线重连时发 `since`，
 * 然后**永远收不到**差量页——而它已经不再走"重拉一页"那条路了。
 * 用户看到的是"重连之后少了十几行"，静默且无从归因。
 *
 * ## 为什么这里是"减"而不是"加"
 *
 * 清单按**构建级**写全、按运行态做减法：漏减一项的代价是上面那种静默降级，
 * 而误减一项的代价是"明明支持却退回重拉一页"——慢，但**不会坏**。
 * 两边的代价不对称，所以默认往保守的方向倒（少报是安全侧）。
 */
export function effectiveCapabilities(probe: CapabilityProbe): CapabilityId[] {
  const canReadHistory = typeof probe.readHistory === 'function'
  return HOST_CAPABILITIES.filter((id) => (id === 'drc.payload.resume' ? canReadHistory : true))
}
