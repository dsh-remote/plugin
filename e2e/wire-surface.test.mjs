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

/**
 * 抽一次载荷类型字面量，**顺带自检抽法还活着**（2026-10-07 补）。
 *
 * ## 为什么必须自检
 *
 * `TYPES` 只认**单引号**。而如果协议层某天改成双引号或反引号字面量，
 * 抽出来的就是**空集** —— 于是两条方向相反的判据会**同时恒绿**：
 * 「小程序引用的都在协议层」（`known` 空 ⇒ `unknown` 必为空）与
 * 「协议层的都被引用过」（`known` 空 ⇒ `unused` 也必为空）。
 *
 * 第一条判据本来有一个 `known.size >= 20` 的兜底，第二条**没有**——
 * 两条的强度不对称，而弱的那条正是会静默放行的那条。
 * 现在两条都走这个助手。
 *
 * 另一个方向的失效同样要挡：判据的价值在于"运行时决定分支的那个字符串"，
 * 而反引号形式（散文里写 `` `cmd.subscribe` ``）本来就不该被算作引用，
 * 所以这里**不**扩正则 —— 扩了会把注释里的字面名也算成"引用过"，
 * 那正好毁掉第二条判据要防的事（新增 ev.* 却忘了写渲染分支）。
 */
function extractTypes(label, text) {
  const found = new Set([...text.matchAll(TYPES)].map((m) => m[1]))
  assert.ok(
    found.size >= 20,
    `${label} 只抽出 ${found.size} 个类型字面量（门槛 20）：抽法或结构变了。` +
      '此时下面两条方向相反的判据会**同时恒绿**（空集 ⊆ 任何集合），所以这一条必须先过',
  )
  return found
}

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

  const known = extractTypes('协议层', readFileSync(PROTOCOL, 'utf8'))

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
  // ⚠️ 这一条原来**没有**自检，而它是两条里弱的那条：`known` 抽空时
  // `unused` 必为空 ⇒ 恒绿。现在两条共用 extractTypes。
  const known = extractTypes('协议层', readFileSync(PROTOCOL, 'utf8'))
  const cited = new Set()
  for (const file of mpSources(MP_DIR)) {
    for (const m of readFileSync(file, 'utf8').matchAll(TYPES)) cited.add(m[1])
  }
  assert.ok(cited.size >= 20, `小程序只引用了 ${cited.size} 个载荷类型：抽法或结构变了`)
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

  // 主机侧自 2026-10-17 起也**引用常量**了（`uploads.ts` 从 `dsh-remote-wire/limits`
  // import `MAX_FILE_ATTACHMENTS`），所以这里从"比对字面量"改成"两条都接受"：
  //   ① 引用常量 —— 最好的形态，那个数在这条路上**没有第二个定义点**；
  //   ② 仍是字面量 —— 只在它**恰好等于**协议层的值时接受（小程序引不了这个包，
  //      它必须走这一条）。
  //
  // ⚠️ 判据放松的代价必须说清：① 这条路上一改协议常量主机侧自动跟着变，
  // 而② 那种形态需要人肉同步。**所以 ② 单独留一条 warn 级判据**（下面），
  // 别让"这条闸允许字面量"变成"没人再管主机侧那个数字了"。
  const usesConstant = /maxCount = options\.maxCount \?\? MAX_FILE_ATTACHMENTS/.test(uploads)
  if (!usesConstant) {
    const hostMax = /const maxCount = options\.maxCount \?\? (\d+)/.exec(uploads)
    assert.ok(
      hostMax,
      'uploads.ts 里既没引用 MAX_FILE_ATTACHMENTS，也找不到 maxCount 的字面量默认值：' +
        '主机侧的附件条数上限必须来自 wire/limits.ts 的常量（与协议层同源），不能各写一个数',
    )
    assert.equal(
      Number(hostMax[1]),
      protocolMax,
      `主机侧的 maxCount 默认 ${hostMax[1]} 与协议层 ${protocolMax} 不一致：超出的那几条会被静默拒收`,
    )
  }
})

test('主机侧的附件上限必须**引用** wire/limits.ts，而不是自己写一个数（不再允许字面量）', async () => {
  // 上一条判据为了兼容小程序那种"引不了这个包"的形态，允许主机侧留字面量。
  // 这一条把那条口子**只对主机侧**关上：它引得了这个包（它就在依赖图里），
  // 所以留字面量只有一个理由——懒得改，而那正是四个数字漂移的起因。
  const { MAX_FILE_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES } = await importWireLimits()
  const uploads = read('dsh-remote-control', 'packages', 'plugin', 'src', 'shell', 'uploads.ts')
  const config = read('dsh-remote-control', 'packages', 'plugin', 'src', 'shell', 'config.ts')
  const runtime = read('dsh-remote-control', 'packages', 'plugin', 'src', 'core', 'runtime.ts')

  // ① 三处默认值的**来源**必须是常量名。
  assert.match(
    uploads,
    /maxCount = options\.maxCount \?\? MAX_FILE_ATTACHMENTS/,
    `主机侧的文件条数上限必须引用 MAX_FILE_ATTACHMENTS（=${MAX_FILE_ATTACHMENTS}）`,
  )
  assert.match(
    uploads,
    /maxBytes = options\.maxBytesPerFile \?\? MAX_ATTACHMENT_BYTES/,
    `主机侧的单文件上限必须引用 MAX_ATTACHMENT_BYTES（=${MAX_ATTACHMENT_BYTES}）`,
  )
  assert.match(
    config,
    /maxFileBytes: MAX_ATTACHMENT_BYTES/,
    'config.ts 的 maxFileBytes 默认值必须引用 MAX_ATTACHMENT_BYTES',
  )
  assert.match(runtime, /maxFileBytes: MAX_ATTACHMENT_BYTES/, 'runtime.ts 的 maxFileBytes 默认值同上')

  // ② 反向判据：这三个文件里**不许再出现**附件上限的字面量。
  // 只查 `512 * 1024` 这个形状——它就是历史上那四处漂移的共同写法。
  for (const [name, text] of [
    ['uploads.ts', uploads],
    ['config.ts', config],
    ['runtime.ts', runtime],
  ]) {
    assert.ok(
      !/512 \* 1024/.test(text),
      `${name} 里还有 512 * 1024 字面量：它必须引用 wire/limits.ts 的 MAX_ATTACHMENT_BYTES` +
        `（=${MAX_ATTACHMENT_BYTES}）或 MAX_ATTACHMENT_TOTAL_BYTES（=${MAX_ATTACHMENT_TOTAL_BYTES}）`,
    )
  }
  // ③ 反向判据：别把"转出"写成"又抄一遍"。uploads.ts 保留
  // `MAX_ATTACH_TOTAL_BYTES` 这个名字是为了不破坏既有 import，
  // 它必须是**转出**协议层而不是自己定义。
  assert.ok(
    !/^export const MAX_ATTACH_TOTAL_BYTES = /m.test(uploads),
    'uploads.ts 的 MAX_ATTACH_TOTAL_BYTES 必须是从 wire/limits 的**转出**，不是自己的定义',
  )
  // ⚠️ 判据必须认**正确**的那两种形状。`export { A as B } from 'wire/limits'`
  // 看着最像"转出"，但它**不在本地产生 B 的绑定** —— 于是本文件里
  // `saveFileAttachments` 用的 `MAX_ATTACH_TOTAL_BYTES` 会是未定义（编译期红）。
  // 真正能用的两种：本地 const 别名 + 纯转出，或直接 import 时 `as` 改名。
  // 这条判据的作用是"哪天有人把上面那行改回 from 形式，闸门立刻报出来"——
  // 那种改动的症状是编译报错，而它在**别的**文件里，与改动点不同处。
  const hasLocalAlias = /const MAX_ATTACH_TOTAL_BYTES = MAX_ATTACHMENT_TOTAL_BYTES/.test(uploads)
  const hasImportAlias = /MAX_ATTACHMENT_TOTAL_BYTES as MAX_ATTACH_TOTAL_BYTES/.test(uploads)
  assert.ok(
    hasLocalAlias || hasImportAlias,
    'uploads.ts 必须有一个**本地可见**的 MAX_ATTACH_TOTAL_BYTES 绑定：' +
      '`export { A as B } from ...` 只改导出侧的名字，本地用 B 会是未定义',
  )
  assert.match(uploads, /export \{ MAX_ATTACH_TOTAL_BYTES \}|export const MAX_ATTACH_TOTAL_BYTES/, '对外仍要导出这个名字（config.ts / runtime.ts 从这里 import）')
})
