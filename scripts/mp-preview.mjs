#!/usr/bin/env node
/**
 * 改完小程序，让手机上立刻能看：在微信开发者工具里跑一次「编译并预览」。
 *
 * 等价于手动点开发者工具（2026-10-05 用户教的步骤）：
 *   1) 顶栏「预览」图标
 *   2) 「自动预览」标签页（默认就选中它）
 *   3) 绿色按钮「编译并预览」——「启动手机端自动预览」保持选中
 * 之后开发者工具里出现二维码，手机微信扫一下就是最新代码。
 *
 * ── 它和 mp-upload.mjs 不是二选一，是前后两步 ──────────────────────
 *   mp-preview（本脚本）  临时二维码，当场扫码当场看。换手机、过了有效期要重扫，
 *                        且扫码的微信号必须在这个小程序的开发者名单里。
 *                        → 适合「我改了一行，你帮我看看对不对」。
 *   mp-upload.mjs        传到后台拿「开发版本」，可在公众平台「选为体验版」，
 *                        体验成员长期可用，不用再碰开发者工具。
 *                        → 适合「这版可以给别人用了」。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   node scripts/mp-preview.mjs
 *
 * ── 前置条件 ──────────────────────────────────────────────────────
 *   1) 微信开发者工具已经打开并登录（账号「林彬」）。
 *      没开的话本脚本会把 IDE 拉起来，但那样通常还要手动登一次。
 *   2) 小程序项目在工具里能正常打开（project.config.json 有效）。
 *
 * ── 踩过的坑（写成注释免得再踩） ────────────────────────────────
 *   --project 必须给**绝对路径**。给相对路径（如 dsh-remote-mp）时，
 *   开发者工具回 code 19「请检查 project.config.json 是否存在及是否有效」——
 *   文件明明就在那儿，是它不解析相对路径。所以下面直接用 path.join(ROOT, ...)。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MP_DIR = path.join(ROOT, 'dsh-remote-mp')

/** 开发者工具的 CLI。也可以 WECHAT_DEVTOOLS_CLI 指定。 */
function resolveCli() {
  const candidates = [
    process.env.WECHAT_DEVTOOLS_CLI,
    '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    path.join(process.env.HOME || '', 'Applications/wechatwebdevtools.app/Contents/MacOS/cli'),
  ].filter(Boolean)
  return candidates.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

const CLI = resolveCli()
if (!CLI) {
  console.error(
    '找不到微信开发者工具的 CLI。装了的话用环境变量指一下：\n' +
      '  WECHAT_DEVTOOLS_CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
  )
  process.exit(2)
}

// project.config.json 要先在。提前查一次，报错比开发者工具的 code 19 好懂。
const cfg = path.join(MP_DIR, 'project.config.json')
if (!fs.existsSync(cfg)) {
  console.error(`找不到 ${cfg}，小程序项目目录不对？`)
  process.exit(2)
}

console.log('→ 编译并预览（开发者工具「自动预览」）')
const r = spawnSync(CLI, ['auto-preview', '--project', MP_DIR], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
const out = ((r.stdout || '') + (r.stderr || '')).trim()
if (r.status !== 0) {
  console.error('✖ 编译并预览失败')
  console.error(out)
  process.exit(r.status || 1)
}
console.log(out)

/**
 * 退出码 0 **不等于**二维码出来了。
 *
 * 这条校验是补上去的：CLI 有几种情况会 0 退出却没有可扫的码（登录态掉了、项目状态不对、
 * 只回了一句提示），而调用方以为"预览好了"就去让用户扫码——用户扫不到任何东西，
 * 于是问题被记在"用户手机"头上。证据按"像二维码"扫：一条 URL、一个图片路径、
 * 或"二维码 / qr"字样；一条都没有就当失败，并把原始输出打出来。
 */
const QR_EVIDENCE = [
  ['URL', /https?:\/\/\S+/i],
  ['图片路径', /\.(png|jpe?g)\b/i],
  ['"二维码"字样', /二维码/],
  ['qr 字样', /\bqr\b/i],
]
const evidence = QR_EVIDENCE.filter(([, pattern]) => pattern.test(out)).map(([label]) => label)
if (evidence.length === 0) {
  console.error('✖ auto-preview 退出 0，但输出里没有任何二维码证据（没 URL、没图片路径、没"二维码"字样）。')
  console.error('  这通常意味着这次"预览"其实没出码（登录态 / 项目状态 / IDE 未就绪），而不是二维码已经生成。')
  console.error(`  原始输出：\n${out || '(空)'}`)
  console.error('  请在开发者工具的「预览 / 自动预览」面板里确认二维码真的出现，再让用户扫。')
  process.exit(1)
}
console.log(`  （二维码证据：${evidence.join(' / ')}）`)

// 版本号只用来在终端里告诉人「预览的是哪一版」，不影响传给工具的调用
try {
  const v = JSON.parse(fs.readFileSync(path.join(MP_DIR, 'package.json'), 'utf8')).version
  console.log('\n✓ 已请求预览（代码取自工作区当前状态，版本号 ' + v + '）。')
  console.log('  到微信开发者工具的「预览 / 自动预览」里扫码。')
  console.log('  二维码是临时的，且扫码的微信号要在开发者名单里；')
  console.log('  要长期分发请改用 node scripts/mp-upload.mjs。')
} catch {
  /* 版本号读不出来不影响预览本身 */
}
