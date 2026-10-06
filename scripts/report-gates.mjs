/**
 * report-gates — 跑一遍全部闸门，把**实测**的项数与 README 的口径对齐。
 *
 * ## 为什么需要这个脚本
 *
 * 这份 README 里有一张「测试 / 覆盖 / 项数」的表。它的第三列在过去半年里漂过好几次
 * （92→106、448→457、255→262、对比度 302→304），每次都是"加了判据忘了改文档"。
 * 原因不复杂：项数只有真跑一遍才知道，而跑一遍要四个仓各自 build + test——
 * 于是没人顺手做，下一个人读到的就是一个**假数字**，而假数字比没有数字更坏
 * （它会让人以为"还有余量"或者"判据变少了"）。
 *
 * 这个脚本把"跑一遍"变成一条命令：
 *
 * ```sh
 * node scripts/report-gates.mjs
 * ```
 *
 * 跑完打印实测值并与 README 的「项数」逐格比对，**对不上就 exit 1**——所以它既是
 * 刷新入口（按表里的数去改 README），也是一道闸。
 *
 * **刻意不把它塞进 `pnpm -r test`**：它自己就要跑那五道闸门，套进去会变成递归。
 * 它的定位是"发版前 / 改完判据后跑一次"，README 的「测试」小节里写明了这一点。
 *
 * ## 这道闸能挡什么、挡不住什么
 *
 * 它比对的是**实测值 vs README**。有人手改 README 改出一个与实测不同的数，它会红
 * （这正是要挡的，也是过去半年漂了四次的那件事）；锚点失效（表格改过写法）它同样会红，
 * 并把失效的锚点打出来——宁可误报一次让人回来对一下，也别静默地不再检查那一格。
 * 它挡不住的是"有人把 README 与实测一起改成另一个数"，那时它证明的是"此刻两者一致"。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 每道闸门：怎么跑、从输出里取哪个数。
 *
 * `tap` 走 node:test 的 TAP 尾部；`contrast` 走脚本自己的汇总行——
 * 那 304 是**组**前景/背景，不是 304 个 test，混进同一列会让人以为多了一堆用例。
 */
const GATES = [
  {
    key: 'wire',
    label: '协议层 dsh-remote-protocol',
    bin: 'pnpm',
    args: ['-C', 'dsh-remote-protocol', 'test'],
    read: tapCount,
  },
  {
    key: 'server',
    label: '中继 dsh-remote-server',
    bin: 'pnpm',
    args: ['-C', 'dsh-remote-server', 'test'],
    read: tapCount,
  },
  {
    key: 'control',
    label: '宿主插件 dsh-remote-control',
    bin: 'pnpm',
    args: ['-C', 'dsh-remote-control', 'test'],
    read: tapCount,
  },
  {
    key: 'e2e',
    label: '伞仓 e2e',
    bin: 'node',
    args: ['--test', ...listTestFiles('e2e')],
    read: tapCount,
  },
  {
    key: 'mp-verify',
    label: '小程序 verify-miniprogram（结构自检）',
    bin: 'npm',
    args: ['--prefix', 'dsh-remote-mp', 'run', 'verify'],
    // 它不是 node:test，是一段带断言的普通脚本（跑完打印"检查了 N 个 JSON…"），
    // 所以这里没有"项数"可取——只认"跑通了"。README 里对应的口径也是文字而不是数字。
    read: () => 'ok',
  },
  {
    key: 'mp-md',
    label: '小程序 markdown 规范（项）',
    bin: 'node',
    args: ['--test', 'dsh-remote-mp/scripts/check-markdown.mjs'],
    read: tapCount,
  },
  {
    key: 'mp-contrast',
    label: '小程序对比度（组）',
    bin: 'npm',
    args: ['--prefix', 'dsh-remote-mp', 'run', 'contrast'],
    read: contrastCount,
  },
]

/**
 * `e2e/*.test.mjs` 的显式列表。
 * `--test` 的位置参数语义在 Node 版本之间变过（node 20 当字面路径），
 * 与其依赖 glob，不如自己列——伞仓 `e2e/package.json` 与 CI 已经是这个做法。
 */
function listTestFiles(dir) {
  const found = readdirSync(resolve(ROOT, dir))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
  if (found.length === 0) throw new Error(`${dir} 下一个 *.test.mjs 都没有——判据自己坏了`)
  return found.map((name) => `${dir}/${name}`)
}

/** 从 node:test 的 TAP 尾部取 `# tests N`。取不到就抛——宁可失败也不要报一个假数字。 */
function tapCount(out) {
  const m = /^# tests ([0-9]+)$/m.exec(out)
  if (!m) throw new Error('输出里没有 "# tests N"（node --test 的 TAP 尾部），判据失效')
  return Number(m[1])
}

function contrastCount(out) {
  const m = /([0-9]+)\s*组/.exec(out)
  if (!m) throw new Error('没从 check-mp-contrast 的输出里读到"多少组"')
  return Number(m[1])
}

function run(bin, args) {
  const res = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    // env -u NODE_OPTIONS 是必须的（伞仓 README「快速开始」与 HANDOFF §2）：
    // 外壳注入的 --require CJS 代理会让 Node 22 的 ESM loader 解析失败。
    env: { ...process.env, NODE_OPTIONS: '' },
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (res.status !== 0) {
    /**
     * 失败时先打**哪一条判据红了**，再打尾部。
     *
     * 原来只写 `out.slice(-4000)`——而 node --test 的尾部是**通过的**那部分
     * （`# tests 297 / # pass 296 / # fail 1`），真正那条 `not ok` 早被截掉了。
     * 于是这个工具在它最该有用的场合（判据红了）只给出一堆无关的通过记录。
     * 本轮实测：连撞三次才靠人工翻日志找到原因。
     */
    const failures = [...out.matchAll(/^\s*not ok .*$/gm)].map((m) => m[0].trim())
    if (failures.length > 0) {
      process.stderr.write(`\n❌ 红了 ${failures.length} 条：\n`)
      for (const line of failures) process.stderr.write(`   ${line}\n`)
      // 每条红判据之后的几行里有断言消息与 expected/actual，一起带出来。
      for (const block of out.split(/^\s*not ok /m).slice(1)) {
        const detail = block.split(/\n(?=\s*(?:ok |not ok ))/)[0] ?? ''
        process.stderr.write(`${detail.split('\n').slice(0, 14).map((l) => '   ' + l).join('\n')}\n`)
      }
    }
    process.stderr.write(`\n—— 完整输出尾部 ——\n${out.slice(-1500)}\n`)
    throw new Error(`${bin} ${args.join(' ')} 退出码 ${res.status}`)
  }
  return out
}

const measured = new Map()
for (const gate of GATES) {
  process.stderr.write(`跑 ${gate.label} …\n`)
  measured.set(gate.key, gate.read(run(gate.bin, gate.args)))
}

/**
 * README「项数」格的定位。
 *
 * 这里是**人工映射**而不是纯正则扫全文：README 的格子里混着 "132（1 skip）" 这种
 * 带注写法，也混着没有数字的「全过」，正则一改措辞就会误伤。锚点取该行开头一段
 * 稳定文字，取**这一行里锚点之后的第一个整数**——也就是那一格的项数。
 * 映射表本身就是判据的一部分：README 改了写法而这里没跟上，`--check` 会红并说清原因。
 */
const README_CELLS = [
  { key: 'wire', anchor: '| 帧与载荷 schema、crypto、配对 URI、三平台防休眠命令' },
  { key: 'server', anchor: '**分发决策闸门**（' },
  { key: 'control', anchor: '**`状态` 按 relay 取值翻译**' },
  { key: 'e2e', anchor: '| 握手/F8/F7/F3/审批闭环/提问闭环/多码并存' },
  // verify-miniprogram 那一格没有数字（它不是 node:test），所以只断言"跑通了"，
  // 对应 README 口径里的「结构自检」那一档。
  { key: 'mp-verify', expect: 'ok', anchor: '结构自检（' },
  { key: 'mp-md', anchor: 'markdown 规范（' },
  { key: 'mp-contrast', anchor: '、对比度（' },
]

/** 锚点所在行里、锚点之后出现的第一个整数。 */
function readmeNumber(text, anchor) {
  const at = text.indexOf(anchor)
  if (at < 0) throw new Error(`README 里找不到锚点：${anchor.slice(0, 32)}…（表格改过写法？）`)
  const line = text.slice(at, text.indexOf('\n', at))
  const m = /[0-9][0-9_ ,]*/.exec(line.slice(anchor.length))
  return m ? Number(m[0].replace(/[ ,_]/g, '')) : null
}

const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8')
process.stdout.write('\n| 闸门 | 实测 | README 写的 | 一致？ |\n|---|---|---|---|\n')

let drifted = 0
const unreadable = []
for (const cell of README_CELLS) {
  const gate = GATES.find((g) => g.key === cell.key)
  const actual = measured.get(cell.key)
  let claimed = null
  try {
    claimed = cell.expect === 'ok' ? 'ok' : readmeNumber(readme, cell.anchor)
  } catch (error) {
    unreadable.push(`${cell.key}: ${error.message}`)
  }
  const ok = claimed === actual
  if (!ok) drifted += 1
  process.stdout.write(`| ${gate.label} | ${actual} | ${claimed ?? '（读不到）'} | ${ok ? '✅' : '❌'} |\n`)
}

if (drifted > 0) {
  process.stderr.write(`\n❌ ${drifted} 处对不上。\n`)
  for (const line of unreadable) process.stderr.write(`   锚点失效：${line}\n`)
  process.stderr.write(
    '   修 README 里的数字（快速开始那一节的行尾注释里也有一份同样的数，记得一起改），别改这个脚本。\n',
  )
  process.exit(1)
}
process.stdout.write('\n✅ README 的项数与实测一致。\n')