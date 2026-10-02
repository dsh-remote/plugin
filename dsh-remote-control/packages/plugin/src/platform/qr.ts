/**
 * qr — 配对二维码：矩阵来自 `qrcode`（node-qrcode），呈现层自己写。
 *
 * 为什么不自己写编码器：旧实现试过，被第三方解码器对拍抓出码字层的系统性差异后否决
 * （取证 packages/plugin 旧 qr.ts 文件头，基线 b026d63:packages/plugin/src/qr.ts:5-9）。
 * node-qrcode 的实测结论在 docs/legacy-spec/open-source-options.md §A.3：
 * 真实配对 URI（98 B 典型 / 188 B 最坏）在 L/M/Q/H 四档纠错、12 组尺寸下全部被
 * zxing 解出，CJK 载荷 round-trip 正确，纯 JS 无原生模块。
 *
 * 呈现层必须自己写的原因：宿主的 TUI 五花八门——有的会吞连续空格、有的没有方块字形、
 * 有的用比例字体。所以默认样式是 `ascii`（`##` / `..`，每个亮模块都占一个真实字形），
 * 它在任何渲染器下都不会错位。`half` 最紧凑但最脆。
 *
 * 一个终端格子大约是"高 = 2×宽"，所以每个模块画两个字符宽，否则二维码会被拉成长方形，
 * 手机很难对上焦。
 */
import QRCode from 'qrcode'

export type QrStyle = 'ascii' | 'block' | 'half'

export interface QrOptions {
  /** 纠错等级；屏幕对手机取景用 M 足够。 */
  ecc?: 'L' | 'M' | 'Q' | 'H'
  /** 静默区（模块数）。规范要 4，屏幕取景 2 通常也能扫。 */
  quietZone?: number
  style?: QrStyle
  /** 用 ANSI 黑底白字包住输出。默认关：宿主不解析 ANSI 时会打成乱码。 */
  ansi?: boolean
}

/** 取二维码的布尔矩阵（含静默区）。 */
export async function qrMatrix(text: string, ecc: 'L' | 'M' | 'Q' | 'H' = 'M', quietZone = 2): Promise<boolean[][]> {
  const qr = QRCode.create(text, { errorCorrectionLevel: ecc })
  const size = qr.modules.size
  const total = size + quietZone * 2
  const out: boolean[][] = []
  for (let y = 0; y < total; y++) {
    const row: boolean[] = []
    for (let x = 0; x < total; x++) {
      const mx = x - quietZone
      const my = y - quietZone
      const dark = mx >= 0 && mx < size && my >= 0 && my < size && Boolean(qr.modules.get(my, mx))
      row.push(dark)
    }
    out.push(row)
  }
  return out
}

/** 渲染成终端文本。 */
export async function renderTerminalQr(text: string, options: QrOptions = {}): Promise<string> {
  const { ecc = 'M', quietZone = 2, style = 'ascii', ansi = false } = options
  const matrix = await qrMatrix(text, ecc, quietZone)
  let body: string
  if (style === 'half') {
    const lines: string[] = []
    for (let y = 0; y < matrix.length; y += 2) {
      const top = matrix[y] as boolean[]
      const bottom = (matrix[y + 1] ?? top.map(() => false)) as boolean[]
      let line = ''
      for (let x = 0; x < top.length; x++) {
        line += top[x] && bottom[x] ? '█' : top[x] ? '▀' : bottom[x] ? '▄' : ' '
      }
      lines.push(line)
    }
    body = lines.join('\n')
  } else {
    const dark = style === 'ascii' ? '##' : '██'
    const light = style === 'ascii' ? '..' : '  '
    body = matrix.map((row) => row.map((cell) => (cell ? dark : light)).join('')).join('\n')
  }
  return ansi ? `\x1b[30;107m${body}\x1b[0m` : body
}

/**
 * 生成 PNG。
 *
 * 为什么这是配对二维码的**首选输出**：DSH 的命令 API 只接受纯文本结果
 * （`{kind, text}`，没有图片或附件类型），所以命令里没法把图交给 TUI；
 * 但插件跑在主机上，可以直接写一个 PNG 并把它打开——真图像永远扫得出来。
 */
export async function qrPng(
  text: string,
  options: { ecc?: 'L' | 'M' | 'Q' | 'H'; quietZone?: number; scale?: number } = {},
): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    errorCorrectionLevel: options.ecc ?? 'M',
    margin: options.quietZone ?? 4,
    scale: options.scale ?? 8,
    type: 'png',
  })
}

/** 二维码的模块数（测试用来断言静默区与几何，不依赖肉眼）。 */
export async function qrModuleCount(text: string, ecc: 'L' | 'M' | 'Q' | 'H' = 'M'): Promise<number> {
  return QRCode.create(text, { errorCorrectionLevel: ecc }).modules.size
}
