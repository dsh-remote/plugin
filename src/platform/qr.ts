/**
 * qr — 配对二维码只有一种产物：**PNG**（矩阵来自 `qrcode` / node-qrcode）。
 *
 * 为什么不自己写编码器：旧实现试过，被第三方解码器对拍抓出码字层的系统性差异后否决
 * （取证基线 b026d63:packages/plugin/src/qr.ts:5-9）。node-qrcode 的实测结论在
 * docs/legacy-spec/open-source-options.md §A.3：真实配对 URI（98 B 典型 / 188 B 最坏）
 * 在 L/M/Q/H 四档纠错、12 组尺寸下全部被 zxing 解出，CJK 载荷 round-trip 正确，纯 JS 无原生模块。
 *
 * 为什么不再有终端文本码：DSH 命令卡按 `line-height:1.6` 渲染等宽输出，行间留白会把半块
 * 二维码横切成条——实测 zxing 在 ≥1.15 行距就解不出来，而宿主固定 1.6，也就是文本码在这个
 * （唯一）宿主上**从来就扫不出来**。它留着只有"看起来是个退路"这一种作用。
 * 2026-10-03 连 `ascii`/`block`/`half` 三种样式与 ANSI 反色一起删掉，配对出口只剩
 * 状态栏那颗 pill（`src/pill/routes.ts` 的 `GET /pairing.png`）。
 *
 * `qrMatrix` 仍然导出：它不是渲染层，是**几何与静默区**的判据来源——
 * 伞仓 `scripts/validate-qr.mjs` 拿它对拍"矩阵本身能不能被解出来"，那与用什么像素画无关。
 */
import QRCode from 'qrcode'

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

/**
 * 生成 PNG。
 *
 * 这是配对二维码唯一的出口：pill 的弹窗里那个 `<img>` 直接吃它（同域 HTTP，不经过磁盘），
 * 而"写一个 PNG 到工作区再让人打开"那条路已经随右栏方案一起删了。
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
