/**
 * Terminal QR rendering, on top of the vendored `qrcode-generator`
 * (MIT, Kazuhiko Arase — see vendor/qrcode-generator.ts).
 *
 * Writing a QR encoder from scratch was tried first and abandoned: a QR code
 * with a single wrong module is just an unscannable image, and the
 * bit-exact reference validation (scripts/validate-qr.mjs) kept finding
 * systematic differences in the codeword layer. A proven implementation is
 * the honest choice; what remains here is presentation only.
 *
 * Terminal rendering uses Unicode half blocks (two module rows per text line)
 * with an explicit black-on-white ANSI palette, so the symbol is scannable
 * whether the terminal theme is dark or light.
 */
import qrcodeFactoryImport from './vendor/qrcode-generator.js'

/** Shape of the vendored factory we rely on (the file is @ts-nocheck'ed). */
interface QrInstance {
  addData(data: string, mode: string): void
  make(): void
  getModuleCount(): number
  isDark(row: number, col: number): boolean
}
type QrFactory = (typeNumber: number, ecc: string) => QrInstance

const qrcodeFactory = qrcodeFactoryImport as unknown as QrFactory

// The vendored default stringToBytes truncates charCodes to one byte, which
// silently corrupts every non-ASCII payload (the length undercounts, so a QR
// is emitted that LOOKS fine but decodes to mojibake). The UTF-8 encoder ships
// in the same file — just not as the default. Pairing URLs are pure ASCII
// today, but the failure mode is nasty and silent, so opt in unconditionally.
;(qrcodeFactory as unknown as { stringToBytes: unknown }).stringToBytes =
  (qrcodeFactory as unknown as { stringToBytesFuncs: Record<string, (s: string) => number[]> })
    .stringToBytesFuncs['UTF-8']!

type Ecc = 'L' | 'M' | 'Q' | 'H'

export interface TerminalQrOptions {
  /** Error-correction level. M is a good default for screen-to-phone scans. */
  ecc?: Ecc
  /** Quiet-zone width in modules. The spec asks for 4; 2 usually scans fine. */
  quietZone?: number
  /** Wrap the output in ANSI black-on-white. Default true. */
  ansi?: boolean
}

/** Build the boolean matrix (dark = true) with `quietZone` border applied. */
export function qrMatrix(text: string, ecc: Ecc = 'M', quietZone = 2): boolean[][] {
  const qr = qrcodeFactory(0, ecc)
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const size = n + quietZone * 2
  const m: boolean[][] = []
  for (let y = 0; y < size; y++) {
    const row: boolean[] = []
    for (let x = 0; x < size; x++) {
      const mx = x - quietZone
      const my = y - quietZone
      row.push(mx >= 0 && mx < n && my >= 0 && my < n ? qr.isDark(my, mx) : false)
    }
    m.push(row)
  }
  return m
}

/**
 * Render as text, two module rows per line:
 *   both dark '█' · top only '▀' · bottom only '▄' · both light ' '
 *
 * Half blocks halve the height, which matters in a TUI where vertical space
 * is scarce and a tall QR scrolls the pairing code out of view.
 */
export function renderTerminalQr(text: string, opts: TerminalQrOptions = {}): string {
  const { ecc = 'M', quietZone = 2, ansi = true } = opts
  const m = qrMatrix(text, ecc, quietZone)
  const lines: string[] = []
  const paint = (top: boolean, bottom: boolean): string =>
    top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
  for (let y = 0; y < m.length; y += 2) {
    const top = m[y]!
    const bottom = m[y + 1] ?? top.map(() => false)
    lines.push(top.map((_, x) => paint(top[x]!, bottom[x]!)).join(''))
  }
  const body = lines.join('\n')
  if (!ansi) return body
  // black foreground on white background: correct on both terminal themes
  return `\x1b[30;107m${body}\x1b[0m`
}
