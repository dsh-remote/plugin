#!/usr/bin/env node
/**
 * Read a DSH session log.
 *
 * The log is an append-only `session.v4.jsonl.zstd` written as MANY zstd
 * frames. A single-shot `zstdDecompressSync` (or a streaming pipe) stops at
 * the first frame and hands back only the session header — which reads as
 * "this session is empty" and sends you chasing the wrong bug. Frames are
 * split on the magic number and decoded one by one instead.
 *
 * Usage:
 *   node scripts/read-session-log.mjs <sessionId> [--tail 20] [--types]
 *   node scripts/read-session-log.mjs --file /path/to/session.v4.jsonl.zstd
 *
 * Finds the log under ~/.dsh/sessions/<workspace-slug>/<sessionId>/.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

function findLog(sessionId) {
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  if (!fs.existsSync(root)) return null
  for (const dir of fs.readdirSync(root)) {
    const candidate = path.join(root, dir, sessionId, 'session.v4.jsonl.zstd')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function decodeAll(file) {
  const buf = fs.readFileSync(file)
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    // 0x28 0xB5 0x2F 0xFD — zstd frame magic
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i)
  }
  offs.push(buf.length)
  const chunks = []
  let frames = 0
  for (let k = 0; k < offs.length - 1; k++) {
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1])))
      frames++
    } catch {
      /* a trailing partial frame is normal while the session is open */
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* tolerate a torn tail line */
    }
  }
  return { events, frames, bytes: text.length }
}

const file = flag('file') || (argv[0] && !argv[0].startsWith('--') ? findLog(argv[0]) : null)
if (!file) {
  console.error('usage: node scripts/read-session-log.mjs <sessionId> [--tail N] [--types]')
  process.exit(2)
}

const { events, frames, bytes } = decodeAll(file)
const tailCount = Number(flag('tail', events.length))

if (argv.includes('--types')) {
  const counts = new Map()
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
  for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(String(n).padStart(6), type)
  }
  console.log('─'.repeat(40))
}

console.log(`# ${file}`)
console.log(`# frames=${frames} events=${events.length} bytes=${bytes}`)
for (const e of events.slice(-tailCount)) {
  const data = e.data === undefined ? '' : JSON.stringify(e.data)
  console.log(`${String(e.seq ?? '?').padStart(5)}  ${e.type}  ${data.slice(0, 220)}`)
}
