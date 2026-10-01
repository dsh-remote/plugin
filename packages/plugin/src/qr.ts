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
import { deflateSync } from 'node:zlib'
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

/**
 * Rendering style, because TUIs differ wildly in what they can print:
 *
 * - `ascii` (default) — `##` per dark module, `..` per light one. No Unicode,
 *   no ANSI, and the light modules are a real glyph so a renderer that
 *   collapses runs of spaces (markdown-ish TUI panes) cannot destroy the
 *   alignment. This is the only style guaranteed to survive every host.
 * - `block` — `██` / two spaces. Nicer looking, but needs a monospace font with
 *   block glyphs and a renderer that preserves multiple spaces.
 * - `half` — Unicode half blocks (two module rows per line). Most compact, and
 *   the most fragile: missing glyphs or a proportional font turn it into noise.
 */
export type QrStyle = 'ascii' | 'block' | 'half'

export interface TerminalQrOptions {
  /** Error-correction level. M is a good default for screen-to-phone scans. */
  ecc?: Ecc
  /** Quiet-zone width in modules. The spec asks for 4; 2 usually scans fine. */
  quietZone?: number
  /** See QrStyle. Default 'ascii'. */
  style?: QrStyle
  /** Wrap the output in ANSI black-on-white. Default false — if the host does
   *  not interpret ANSI the escape sequences print literally as garbage. */
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
 * Render as text.
 *
 * A terminal cell is about twice as tall as it is wide, so every module is
 * drawn TWO characters wide to keep the symbol square — otherwise it comes out
 * stretched and phones struggle to lock on.
 */
export function renderTerminalQr(text: string, opts: TerminalQrOptions = {}): string {
  const { ecc = 'M', quietZone = 2, style = 'ascii', ansi = false } = opts
  const m = qrMatrix(text, ecc, quietZone)

  let body: string
  if (style === 'half') {
    // two module rows per line — compact, but the most fragile
    const lines: string[] = []
    const paint = (top: boolean, bottom: boolean): string =>
      top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    for (let y = 0; y < m.length; y += 2) {
      const top = m[y]!
      const bottom = m[y + 1] ?? top.map(() => false)
      lines.push(top.map((_, x) => paint(top[x]!, bottom[x]!)).join(''))
    }
    body = lines.join('\n')
  } else {
    // light modules get a real glyph with `ascii`, so collapsing whitespace
    // in the host renderer cannot shift the grid
    const dark = style === 'ascii' ? '##' : '██'
    const light = style === 'ascii' ? '..' : '  '
    body = m.map((row) => row.map((v) => (v ? dark : light)).join('')).join('\n')
  }

  if (!ansi) return body
  // black foreground on white background: correct on both terminal themes
  return `\x1b[30;107m${body}\x1b[0m`
}

// ── PNG output ─────────────────────────────────────────────────────
//
// The slash-command API only settles `{ kind, text }` — there is no image or
// attachment result type — so a command cannot hand an image to the TUI. But
// the plugin runs on the host machine, so it can write a PNG and open it,
// which beats any text rendering: a real image always scans.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

export interface QrPngOptions {
  ecc?: Ecc
  /** Quiet zone in modules. Images have room for the specified 4. */
  quietZone?: number
  /** Pixels per module. */
  scale?: number
}

/**
 * Encode a QR symbol as a grayscale PNG (8-bit, colour type 0).
 *
 * Written by hand because the plugin must stay dependency-free when installed
 * into an external profile — a grayscale 8-bit PNG is just zlib + CRC32.
 */
export function qrPng(text: string, opts: QrPngOptions = {}): Buffer {
  const { ecc = 'M', quietZone = 4, scale = 8 } = opts
  const m = qrMatrix(text, ecc, quietZone)
  const modules = m.length
  const size = modules * scale

  // one raw scanline per row: filter byte 0 + grayscale pixels
  const raw = Buffer.alloc((size + 1) * size)
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    const row = m[Math.floor(y / scale)]!
    for (let x = 0; x < size; x++) {
      raw[o++] = row[Math.floor(x / scale)] ? 0 : 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: grayscale
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
