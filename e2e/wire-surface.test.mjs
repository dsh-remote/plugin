/**
 * wire-surface.test — 小程序引用的 `ev.*` / `cmd.*` 与协议层**逐字一致**。
 *
 * ## 为什么这条值得单独一个文件
 *
 * 小程序侧的分发是一条 if/else 链（`client.js` 把每帧原样 emit 出去，页面按 `t` 自己判），
 * 链的末尾**没有任何 else**。于是"引用了一个协议里不存在的类型名"与"引用了一个协议里
 * 改了名的类型"的表现完全一样：**什么都不发生，连一行日志都没有**。
 *
 * 这类失配在两端都是静默的，而且没有编译器会说话：
 * - mp 引用 `ev.run_stata` → 那一帧无人认领，界面上"运行中…"永远不结束；
 * - mp 从不引用某个新增的 `ev.*` → 主机发了它，手机界面上什么都没有。
 *
 * 两个方向都是"多写一行、少一行"的代价，所以做成判据而不是靠人记得两清单对得上。
 *
 * 取字面量而不是 `import`：mp 是 CommonJS 且不能引协议包（它要打进小程序包），
 * 协议层是 ESM + zod（也进不了小程序）。两边只能对**文本里的字面量**，
 * 这恰好也是运行时真正决定分支的那个字符串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MP_DIR = path.join(ROOT, 'dsh-remote-mp', 'miniprogram')
const PROTOCOL = path.join(ROOT, 'dsh-remote-protocol', 'src', 'wire', 'payloads.ts')

/** 小程序自研目录；`miniprogram_npm` 是 TDesign 产物，不参与（它不可能引用我们的载荷）。 */
function mpSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'miniprogram_npm') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) mpSources(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const TYPES = /'(ev\.[a-z_]+|cmd\.[a-z_]+)'/g

/** 按仓内相对路径读一个文件。 */
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8')

/**
 * 取协议层**已构建**的预算常量。
 *
 * 为什么读 dist 而不是从源码正则里抽一个字面量：这条判据的全部意义是
 * 「那个数只有一个来源」，而用 `/\.max\((\d+)\)/` 把它再抄一遍恰恰是回到老路。
 * 协议层在 2.0.16 起把附件上限提成了 `limits.ts` 的常量，源码里**不再有那个数字**——
 * 判据若继续抽字面量，它测的会是一个已经不存在的东西。
 * dist 由 `e2e/run.mjs` 的新鲜度闸门保证不比 src 旧，所以读到的就是消费方真正用到的那份。
 */
async function importWireLimits() {
  const entry = path.join(ROOT, 'dsh-remote-protocol', 'dist', 'src', 'wire', 'limits.js')
  assert.ok(existsSync(entry), `找不到 ${entry}：先在 dsh-remote-protocol 跑一次 pnpm build`)
  return import(url.pathToFileURL(entry).href)
}

test('小程序引用的每个载荷类型，协议层都真的定义了（否则它落在链尾，什么都不发生）', () => {
  assert.ok(existsSync(MP_DIR), `找不到 ${MP_DIR}：e2e 需要四棵平行仓在场`)
  assert.ok(existsSync(PROTOCOL), `找不到 ${PROTOCOL}`)

  const known = new Set([...readFileSync(PROTOCOL, 'utf8').matchAll(TYPES)].map((m) => m[1]))
  assert.ok(known.size >= 20, `协议层只抽出 ${known.size} 个类型字面量：抽法或结构变了`)

  const sources = mpSources(MP_DIR)
  assert.ok(sources.length >= 5, `小程序自研 JS 只扫到 ${sources.length} 个`)
  const cited = new Map()
  for (const file of sources) {
    for (const m of readFileSync(file, 'utf8').matchAll(TYPES)) {
      if (!cited.has(m[1])) cited.set(m[1], [])
      cited.get(m[1]).push(path.relative(ROOT, file))
    }
  }
  assert.ok(cited.size >= 20, `小程序只引用了 ${cited.size} 个载荷类型：抽法或结构变了`)

  const unknown = [...cited.keys()].filter((t) => !known.has(t)).sort()
  assert.deepEqual(
    unknown,
    [],
    `小程序引用了协议层不存在的载荷类型：${unknown.join(', ')}。` +
      '分发是一条没有 else 的 if 链（client.js 原样 emit、页面按 t 自判），' +
      '这类失配的表现是"什么都不发生"，连一行日志都不会有',
  )
})

test('协议层的每个载荷类型都被小程序引用过（新增 ev.* 却忘了写渲染分支 = 界面上永远不出现）', () => {
  const known = new Set([...readFileSync(PROTOCOL, 'utf8').matchAll(TYPES)].map((m) => m[1]))
  const cited = new Set()
  for (const file of mpSources(MP_DIR)) {
    for (const m of readFileSync(file, 'utf8').matchAll(TYPES)) cited.add(m[1])
  }
  const unused = [...known].filter((t) => !cited.has(t)).sort()
  assert.deepEqual(
    unused,
    [],
    `协议层定义了这些类型，小程序却从不引用：${unused.join(', ')}。` +
      '主机发了它们，手机端没有任何分支认领——主机侧看起来一切正常',
  )
})
test('附件条数上限在三处是同一个数（协议层 / 小程序 / 主机），不是各写一个 4', async () => {
  // mp 的 `sendPrompt` 注释写着"两类的条数上限都是 4（协议层同一个数）"，
  // 而那个"同一个数"在三个仓里各写了一遍：协议层两个上限、小程序 `MAX_ATTACH`
  // 加两处 `slice(0, N)`、主机侧 `maxCount ?? N`。
  // 几个 N 之间没有任何东西连着——改一处不会有编译错误、不会有测试变红，
  // 而症状是"带了 5 个，第 5 个静默消失"或者主机侧拒收。
  //
  // 协议层自 2.0.16 起不再内联那个数字，改为引用 `wire/limits.ts` 的常量，
  // 所以这条判据现在守两件事：
  //   ① 协议层**引用了常量**（否则"那个数"又有了第二个定义点）；
  //   ② 小程序与主机侧的字面量**等于那个常量的值**（它们引不了这个包，只能比对）。
  const payloads = read('dsh-remote-protocol', 'src', 'wire', 'payloads.ts')
  const chat = read('dsh-remote-mp', 'miniprogram', 'pages', 'chat', 'chat.js')
  const client = read('dsh-remote-mp', 'miniprogram', 'core', 'client.js')
  const uploads = read('dsh-remote-control', 'packages', 'plugin', 'src', 'shell', 'uploads.ts')

  const { MAX_IMAGE_ATTACHMENTS, MAX_FILE_ATTACHMENTS } = await importWireLimits()
  assert.ok(
    /images:\s*z\.array\(imageAttachment\)\.max\(MAX_IMAGE_ATTACHMENTS\)/.test(payloads) &&
      /files:\s*z\.array\(fileAttachment\)\.max\(MAX_FILE_ATTACHMENTS\)/.test(payloads),
    '协议层的附件上限必须引用 wire/limits.ts 的常量，而不是内联一个数字：内联的那个数与小程序/主机侧没有任何东西连着',
  )
  assert.equal(
    MAX_IMAGE_ATTACHMENTS,
    MAX_FILE_ATTACHMENTS,
    `协议层自己就不一致：images ${MAX_IMAGE_ATTACHMENTS} / files ${MAX_FILE_ATTACHMENTS}。` +
      '两类附件在 mp 侧走同一个 MAX_ATTACH，上限必须相同',
  )
  const protocolMax = MAX_IMAGE_ATTACHMENTS

  const mpMax = /var MAX_ATTACH = (\d+)/.exec(chat)
  assert.ok(mpMax, 'chat.js 里找不到 MAX_ATTACH')
  const slices = [...client.matchAll(/\.slice\(0, (\d+)\)\.map\(/g)].map((m) => Number(m[1]))
  assert.ok(slices.length >= 2, `client.js 里只抽到 ${slices.length} 处 slice(0, N)：images/files 两处应当都在`)
  for (const n of slices) {
    assert.equal(n, protocolMax, `小程序的 slice(0, ${n}) 与协议层 max(${protocolMax}) 不一致`)
  }
  assert.equal(Number(mpMax[1]), protocolMax, '小程序的 MAX_ATTACH 与协议层不一致')

  const hostMax = /const maxCount = options\.maxCount \?\? (\d+)/.exec(uploads)
  assert.ok(hostMax, 'uploads.ts 里找不到 maxCount 的默认值')
  assert.equal(
    Number(hostMax[1]),
    protocolMax,
    `主机侧的 maxCount 默认 ${hostMax[1]} 与协议层 ${protocolMax} 不一致：超出的那几条会被静默拒收`,
  )
})
