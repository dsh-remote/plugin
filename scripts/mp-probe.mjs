#!/usr/bin/env node
/**
 * mp-probe — 对**渲染层行为**做交互验证。
 *
 * 为什么需要它：`mp-shots` 只能证明"长得对"，`mp-chat-blocks` 只能证明"逻辑算得对"，
 * 而「点一下到底有没有用」这两者都证明不了 —— 它发生在渲染层：
 *
 *   - `scroll-into-view` 找不到目标节点时**不报错、不重试**，只是不滚。
 *     chat 页的锚点曾写成 `<view id="{{toView}}">`（同一个元素跟着 toView 改名），
 *     要赌"元素改名"与"scroll-into-view 生效"谁先落到渲染层上 —— 赌输了就是
 *     「回到最新」点了没反应。这个 bug 截图和单测都抓不到，只有真的点一下才看得见。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node scripts/mp-probe.mjs                 跑全部探针
 *   node scripts/mp-probe.mjs --case jump     只跑「回到最新」
 *
 * ── 前置：自动化端口不是常开的 ────────────────────────────────────────
 *   /Applications/wechatwebdevtools.app/Contents/MacOS/cli quit
 *   /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
 *     --project "$(pwd)/mp" --trust-project --auto-port 9420
 *
 * 退出码：任一条判据不成立 → 非零。
 */
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function flag(name, fallback) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

const PORT = Number(flag('port', process.env.MP_AUTO_PORT || 9420))
const ONLY = String(flag('case', '')).trim()

function resolveAutomator() {
  const candidates = [
    'miniprogram-automator',
    path.join(ROOT, 'node_modules/miniprogram-automator'),
    path.join(ROOT, 'e2e/node_modules/miniprogram-automator'),
    path.join(
      process.env.HOME || '',
      '.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator',
    ),
  ]
  for (const c of candidates) {
    try {
      return require(c)
    } catch {
      /* 继续找下一个 */
    }
  }
  return null
}

/** 端口开着的话，HTTP 请求会被要求 Upgrade 到 WebSocket（426） */
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: 2500 },
      (res) => {
        res.resume()
        resolve(res.statusCode === 426 || res.statusCode === 101 || res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** 一屏装不下的长内容 —— 有距离可滚，才谈得上"滚没滚到" */
function longBlocks(rounds) {
  const out = []
  for (let i = 1; i <= rounds; i++) {
    out.push({ key: 'r' + i, kind: 'turn', label: `第 ${i} 轮`, time: '14:00' })
    out.push({
      key: 'm' + i,
      kind: 'text',
      text: `第 ${i} 轮回复正文。这一行是为了把内容撑过一屏，好让"回到最新"有距离可滚。`,
      done: true,
    })
  }
  return out
}

const CASES = {
  /**
   * 「回到最新」：滚到底部的浮标点下去，scroll-view 的 scrollTop 必须真的变。
   * 这是**唯一**能证明这个按钮可用的判据 —— 它读的是 scroll-view 自己的位置，
   * 不是页面 data 里那个"我以为我滚了"的 toView。
   */
  jump: async (page) => {
    await page.setData({ blocks: longBlocks(14), atBottom: false })
    await page.waitFor(900)

    const el = await page.$('.scroll')
    const height = await el.scrollHeight()

    // 先滚到底、再回顶：制造"用户往上回看过"的真实处境
    await el.scrollTo(0, 999999)
    await page.waitFor(800)
    const bottom = await el.property('scrollTop')
    await el.scrollTo(0, 0)
    await page.waitFor(800)
    const before = await el.property('scrollTop')

    await page.callMethod('onJumpLatest')
    await page.waitFor(1500)
    const after = await el.property('scrollTop')
    const data = await page.data()

    const viewport = (await el.size()).height
    const reachedBottom = after + viewport >= height - 30
    const checks = [
      [bottom > 100, `内容要够长（手动滚到底 = ${bottom}，内容高 ${Math.round(height)}）`],
      [before === 0, `要先回到顶部（scrollTop = ${before}）`],
      [after > before, `点完之后 scrollTop 必须变大（${before} → ${after}）`],
      [reachedBottom, `必须真的到底（${after} + 视口 ${Math.round(viewport)} ≥ ${Math.round(height)} - 30）`],
      [data.atBottom === true, 'atBottom 要跟着变 true'],
    ]
    return checks
  },
}

async function main() {
  const automator = resolveAutomator()
  if (!automator) {
    console.error(
      '没找到 miniprogram-automator。装一份再跑：\n' +
        '  npm i miniprogram-automator --prefix ~/.workbuddy/binaries/node/workspace',
    )
    process.exit(1)
  }
  if (!(await probePort(PORT))) {
    console.error(
      `自动化端口 ${PORT} 没开。先让 IDE 以自动化模式启动：\n` +
        '  /Applications/wechatwebdevtools.app/Contents/MacOS/cli quit\n' +
        `  /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project "${ROOT}/mp" --trust-project --auto-port ${PORT}`,
    )
    process.exit(1)
  }

  const names = ONLY ? [ONLY] : Object.keys(CASES)
  for (const n of names) {
    if (!CASES[n]) {
      console.error(`没有这个探针：${n}（可选：${Object.keys(CASES).join(' / ')}）`)
      process.exit(1)
    }
  }

  const miniProgram = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${PORT}` })
  miniProgram.on('exception', (err) => console.error('页面异常:', err.message))
  let failed = 0
  let total = 0
  try {
    for (const name of names) {
      await miniProgram.reLaunch(`/pages/chat/chat?id=probe-${name}`)
      const page = await miniProgram.currentPage()
      await page.waitFor(500)
      const checks = await CASES[name](page)
      total += checks.length
      const bad = checks.filter(([ok]) => !ok)
      failed += bad.length
      console.log(`${bad.length ? '✗' : '✓'} ${name}  ${checks.length - bad.length}/${checks.length}`)
      for (const [ok, label] of checks) console.log(`   ${ok ? '·' : '✗'} ${label}`)
    }
  } finally {
    await miniProgram.disconnect()
  }
  console.log(`\n探针 ${names.length} 组，判据 ${total - failed}/${total} 成立`)
  process.exit(failed ? 1 : 0)
}

await main()
