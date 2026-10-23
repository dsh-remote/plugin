/**
 * capabilities — "这台内核**此刻**能不能收图片"的探测（规范 §13.1）。
 *
 * ## ⚠️ 2026-10-11 晚：能力位（capability ids）整条机制已删除
 *
 * 这个文件以前还负责两件事，现在都没有了：
 * - `HOST_CAPABILITIES`（构建级清单）—— 喂 `hello.capabilities`；
 * - `effectiveCapabilities()`（运行级清单）—— 喂 `ev.host_info.caps`。
 *
 * 它们存在的意义是让手机在"对端可能不支持某个载荷"时降级（典型是
 * `drc.payload.resume` ⇒ 不发 `since`、退回重拉一页）。三端同版本发版 ⇒
 * 没有"可能不支持"这回事，能力位连同协议层的注册表一起删掉了。
 *
 * ⇒ 断线重连时手机**总是**发 `since`；宿主这一代内核没有 `readHistory` 时，
 * `cmd.session_history` 会明确拒绝（见 `runtime.ts` 那条分支），
 * 手机把它当"这一次续传失败"处理并退回整页重读（`client.js` 的 `resumeHistory`
 * 把 `!res.ok` 映射成 `{mode:'full'}`）。**多一次往返，但不会漏消息。**
 *
 * ## 图片这条为什么留下
 *
 * 它答的不是"协议上支持吗"，而是"这台主机**此刻**真的收得下图片吗"——
 * 而那是内核/模型适配器的事（同样一台主机上文件附件能用、图片不能用是真实存在的），
 * 与"我们自己的两个版本要不要互相兼容"是两回事。它喂的是
 * `ev.host_info.limits.maxImageAttachments` 这个**数字**，不是能力位。
 */

/**
 * 内核对"图片通路"的自述（`carrier-services.ts` 的 `attachmentFace()`）。
 *
 * 返回值是那三个字符串之一（`absent (…)` 是"这一代内核没有图片通路"）。
 * **刻意可选**：所以"端口没声明"与"端口说没有"必须分成两件事
 * （见 `imageAttachmentsSupported`）。
 */
export interface CapabilityProbe {
  imageFace?: () => string
}

/**
 * 图片通路三态：**yes / no / unknown**。
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
