#!/usr/bin/env node
/**
 * 上传小程序，拿一个能在后台长期分发的版本。
 *
 * 为什么需要它：`cli preview` 出的二维码是**临时**的，而且每个扫码的人
 * 都得先被加进这个小程序的开发者名单 —— 换台手机、过了有效期就要重扫。
 * 上传一次得到的「开发版本」可以在微信公众平台「选为体验版」，体验成员
 * 长期可用，不用再碰开发者工具。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node scripts/mp-upload.mjs                       # 版本号取自 mp/package.json
 *   node scripts/mp-upload.mjs --version 0.3.0 --desc "修 xxx"
 *   node scripts/mp-upload.mjs --dry                 # 只跑真编译，不真上传
 *
 * 同一个版本号重复上传是**覆盖**，不会报错也不产生第二条记录。
 *
 * ── 上传之后还差两步，脚本替不了 ──────────────────────────────────────
 *   1) 微信公众平台 → 开发管理 → 开发设置 → 服务器域名
 *      把中继域名加进 **socket 合法域名**（例如 wss://drc.provid.cc）。
 *      体验版**强制**校验这一项；开发版可以在手机上「打开调试模式」临时绕过。
 *   2) 版本管理 → 开发版本 → 选中刚上传的这条 → 「选为体验版」
 *      再在「成员管理 → 体验成员」里把要用的微信号加进去。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MP_DIR = path.join(ROOT, 'mp')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes('--' + name)
const DRY = has('dry')

if (has('help') || argv.includes('-h')) {
  console.log(
    `用法：node scripts/mp-upload.mjs [--version x.y.z] [--desc "…"] [--dry]

  不带参数       版本号取自 mp/package.json，描述取自 mp/ 最近一条提交
  --version      指定版本号。同号重复上传是覆盖，不新增记录
  --desc         指定版本描述
  --dry          只跑真编译，不真的上传

注意：这是 CLI 脚本，**直接运行**才会走上面的分支；
把它 import 进来（例如 node -e "import('./scripts/mp-upload.mjs')"）
等于不带参数直接跑，会真的上传。`,
  )
  process.exit(0)
}

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

/**
 * 描述默认取**最近一次动到 mp/ 的提交**，而不是仓库最近一条 ——
 * 这是多 agent 协作的仓库，HEAD 很可能是后端或文档的提交，
 * 拿去当小程序版本描述会驴唇不对马嘴。
 */
function defaultDesc() {
  const r = spawnSync('git', ['log', '-1', '--format=%s', '--', 'mp/'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const subject = (r.stdout || '').trim()
  return subject || `小程序更新 ${new Date().toISOString().slice(0, 10)}`
}

/**
 * 默认版本号跟**小程序自己**的 package.json 走（它跟 server / protocol /
 * plugin 一样是 workspace 的统一版本），不要跟根 package.json —— 根那个是
 * monorepo 的历史遗留，长期停在 0.1.0，跟实际发出去的版本对不上。
 */
function defaultVersion() {
  const candidates = [path.join(MP_DIR, 'package.json'), path.join(ROOT, 'package.json')]
  for (const p of candidates) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version
      if (v) return v
    } catch {
      /* 换下一个 */
    }
  }
  return '0.0.0'
}

/** 把「证书/密钥校验」这类大段警告之外的体积表抽出来，别的都太吵 */
function summarize(stdout) {
  const lines = stdout.split('\n')
  const kept = lines.filter(
    (l) =>
      /size|TOTAL|KB|MB|AppID|上传|预览|编译|error|错误|Error|fail|失败/i.test(l) &&
      !/punycode|trace-deprecation/i.test(l),
  )
  return (kept.length ? kept : lines.slice(-12)).join('\n').trim()
}

function run(args, label) {
  console.log(`→ ${label}`)
  const r = spawnSync(CLI, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.status !== 0) {
    console.error(`✗ ${label} 失败（exit ${r.status}）\n${summarize(out)}`)
    process.exit(r.status || 1)
  }
  console.log(summarize(out))
  return out
}

const CLI = resolveCli()
if (!CLI) {
  console.error(
    '找不到微信开发者工具的 CLI。装了的话用环境变量指一下：\n' +
      '  WECHAT_DEVTOOLS_CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
  )
  process.exit(2)
}

const VERSION_ARG = flag('version', '')
const VERSION = VERSION_ARG || defaultVersion()
const VERSION_FROM = VERSION_ARG ? '' : '（取自 mp/package.json）'
const DESC = flag('desc', defaultDesc())

if (DRY) {
  console.log(`版本号 ${VERSION}${VERSION_FROM} — ${DESC}`)
  run(['preview', '--project', MP_DIR, '--lang', 'zh'], '真编译（dry，不上传）')
  console.log('\n--dry：没有上传。去掉 --dry 才会真的传到后台。')
} else {
  run(
    ['upload', '--project', MP_DIR, '--version', VERSION, '--desc', DESC, '--lang', 'zh'],
    `上传 ${VERSION}${VERSION_FROM} — ${DESC}`,
  )
  console.log(
    `
✓ 已上传为开发版本 ${VERSION}

接下来到微信公众平台（这两步只能在网页里做）：
  1) 开发管理 → 开发设置 → 服务器域名 → socket 合法域名
     加上中继域名（如 wss://drc.provid.cc）。体验版强制校验，没配连不上。
  2) 版本管理 → 开发版本 → 选中 ${VERSION} → 「选为体验版」
     再在「成员管理 → 体验成员」里加入要用的微信号。
`.trim(),
  )
}
