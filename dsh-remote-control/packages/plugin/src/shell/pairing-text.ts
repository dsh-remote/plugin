/**
 * pairing-text — `/drc pair` 的文本输出（纯函数，所以这条拍板能被单测锁住）。
 *
 * **2026-10-02 翻转**：原拍板是「出文本二维码，图片版是显式旁路」。真机取证推翻了它——
 * DSH 命令卡把等宽输出按 `line-height: 1.6` 渲染，行间留白把半块二维码横切成条，
 * zxing 在 ≥1.15 行距就解不出来（实测，见 `shell/config.ts` 的 `qrImage` 默认值注释）。
 * 所以现在**默认输出图片路径**，文本二维码降级为 `qrImage:false` 时的退路。
 *
 * 无论走哪条路，输出本身必须自足：6 位配对码 + 可粘贴的 URI + TTL + 一次性提示。
 * 这条如果没有测试，将来很容易又"顺手加一句 open 更好用"。
 *
 * 为什么最终仍可能落到文本：宿主的命令 API 只接受纯文本结果（没有图片/附件返回类型），
 * 所以我们能把 PNG 写到磁盘、把**路径**写进文本，但不能把图直接塞进卡片。
 */
export interface PairingTextView {
  /** 6 位配对码。 */
  token: string
  /** 完整的 `dshr:/p?...` 载荷：既是二维码的内容，也是可粘贴的那一行。 */
  qr: string
  /** 本地记录的过期时刻（毫秒）；服务端权威 TTL 到达后已改写。 */
  expiresAt: number
  /** 当前时刻（注入，便于测试）。 */
  now: number
  qrImage: boolean
  /**
   * 二维码 PNG 的**绝对路径**，由调用方按当前会话的工作区解析好后传进来
   * （`<workspace>/.dsh/pairing-qr.png`，解析不出工作区时是 `~/.dsh/pairing-qr.png`）。
   * 这里是纯函数，不认识"工作区"这个概念，也就不该自己去拼路径——拼法只有 `shell/status.ts`
   * 一处，卡片上印的路径与真正落盘的路径因此不可能分叉。
   * 空串 = 这一版没有图（图片模式关掉，或 statusFile 没配），正文不许报路径。
   */
  imageFile: string
  /** 已经渲染好的终端二维码；`qrImage` 模式下不需要它，所以可选。 */
  terminalQr?: string
}

/** 中继没连上时的说法：必须指出去哪看原因，而不是"失败了"。 */
export const PAIR_UNAVAILABLE_TEXT = '中继还没连上，暂时无法配对。看 status.json 的 relayProblem。'

export function pairingPairText(view: PairingTextView): string {
  const ttlSec = Math.max(0, Math.round((view.expiresAt - view.now) / 1000))
  const lines = [`配对码 ${view.token} · ${ttlSec} 秒内有效 · 一次性`, '小程序里扫码，或手输这 6 位数字。']
  if (view.qrImage && view.imageFile) {
    // 图片是默认路径：正文只说"扫这张图"，不再塞那段在 DSH 里扫不出来的文本码。
    // "打开这张 PNG"只能当兜底：`/drc pair` 之后右栏会**自己弹出**二维码
    // （`packages/presentation`，装了那一行才成立），把开图写成主路径等于让用户
    // 白跑一趟去找文件——而这正是本命令当初被要求别做的事。
    lines.push('', `二维码会自动弹出到右栏；没弹出就打开这张 PNG 再扫：${view.imageFile}`)
  } else if (view.terminalQr) {
    lines.push('', view.terminalQr)
  }
  // 扫不出来时（比例字体、吞字形的渲染器、或行高把码切开了）这条路仍然成立：配对页可以直接粘这一行。
  lines.push('', view.qr)
  if (!view.qrImage) lines.push('', '（如需图片版：把 patch 里的 qrImage 设为 true）')
  return lines.join('\n')
}
