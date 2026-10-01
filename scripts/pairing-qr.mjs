#!/usr/bin/env node
/**
 * pairing-qr — 把当前有效的配对码画成 PNG 并打开。
 *
 * 真机调试时最顺手的路径是：手机上的小程序用扫码（wx.scanCode 在真机上有）
 * 去扫电脑屏幕上的二维码。所以这里直接产出一张图片，而不是在终端里画字符。
 *
 * 配对码来自插件写进 status.json 的 `pairing`（需要 profile 里开了
 * pairOnStartSec），也可以用 --qr 直接指定一段 dshr:/p?… 内容。
 *
 * 用法：
 *   node scripts/pairing-qr.mjs              # 读 status.json，写图并打开
 *   node scripts/pairing-qr.mjs --no-open    # 只写图
 *   node scripts/pairing-qr.mjs --qr 'dshr:/p?…'
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const qrModule = path.join(root, 'packages', 'plugin', 'dist', 'src', 'qr.js')
if (!existsSync(qrModule)) {
  console.error(`✖ 先构建：找不到 ${qrModule}（env -u NODE_OPTIONS pnpm -r build）`)
  process.exit(2)
}
const { qrPng } = await import(qrModule)

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(`--${name}`)

const STATUS = join(homedir(), '.dsh', 'dsh-remote-control', 'status.json')
let qr = arg('qr')
let token = ''
let leftSec = null

if (!qr) {
  if (!existsSync(STATUS)) {
    console.error(`✖ 找不到 ${STATUS}（插件没在发布配对码？检查 pairOnStartSec）`)
    process.exit(2)
  }
  const d = JSON.parse(await (await import('node:fs/promises')).readFile(STATUS, 'utf8'))
  const p = d.pairing
  if (!p?.qr) {
    console.error('✖ status.json 里没有 pairing —— 用 /drc pair 取一个，或用 --qr 指定')
    process.exit(2)
  }
  qr = p.qr
  token = p.token ?? ''
  leftSec = p.expiresAt
    ? Math.round((Date.parse(p.expiresAt) - Date.now()) / 1000)
    : null
}

const out = arg('out') ?? join(dirname(STATUS), 'pairing-qr.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, qrPng(qr, { scale: 10 }), { mode: 0o600 })

console.log(`配对码 ${token || '(见二维码)'}${leftSec !== null ? `  · 剩余约 ${leftSec}s` : ''}`)
console.log(`图片：${out}`)

if (!has('no-open')) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(opener, [out], { stdio: 'ignore', detached: true }).unref()
    console.log('已用默认应用打开 —— 用手机上的小程序扫码即可')
  } catch {
    console.log('（无法自动打开，请手动打开上面的路径）')
  }
}
