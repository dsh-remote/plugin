/**
 * pairing-text — `/drc pair` 的文本输出（纯函数，所以这条拍板能被单测锁住）。
 *
 * 用户的原话是「二维码不要用打开一个图片的方式，不要脱离 dsh，ansi 或者更优雅的方式」。
 * 落到实现上有两层：
 *
 * 1. **默认值**（`shell/config.ts` 里 `qrImage`/`qrOpen`/`qrAnsi` 默认 false、`qrStyle` 默认 `half`）
 *    已经有断言守着；
 * 2. **命令输出本身**必须是自足的：二维码 + 可粘贴的 URI + TTL + 一次性。
 *    这条如果没有测试，将来很容易又"顺手加一句 open 更好用"。
 *
 * 为什么文本是主路径而不是兜底：宿主的命令 API 只接受纯文本结果
 * （没有图片/附件返回类型），写 PNG 再叫系统查看器打开，等于把"在 DSH 里完成的配对"
 * 搬到 DSH 外面去回答。半块字符（▀▄█）在一个终端格子≈"高=2×宽"的假设下最接近正方形取景，
 * 因此是最容易扫对的文本样式；ANSI 反色默认关，因为宿主按纯文本渲染时会把转义序列打成乱码。
 */
import { pairingImagePath } from './status.js'

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
  statusFile: string
  /** 已经渲染好的终端二维码（渲染是异步的，所以由调用方传进来）。 */
  terminalQr: string
}

/** 中继没连上时的说法：必须指出去哪看原因，而不是"失败了"。 */
export const PAIR_UNAVAILABLE_TEXT = '中继还没连上，暂时无法配对。看 status.json 的 relayProblem。'

export function pairingPairText(view: PairingTextView): string {
  const ttlSec = Math.max(0, Math.round((view.expiresAt - view.now) / 1000))
  return [
    `配对码 ${view.token} · ${ttlSec} 秒内有效 · 一次性`,
    '小程序里扫码，或手输这 6 位数字。',
    '',
    view.terminalQr,
    '',
    // 扫不出来时（比例字体、吞字形的渲染器）这条路仍然成立：配对页可以直接粘这一行。
    view.qr,
    '',
    view.qrImage ? `另已写出图片 ${pairingImagePath(view.statusFile)}` : '（如需图片版：把 patch 里的 qrImage 设为 true）',
  ].join('\n')
}
