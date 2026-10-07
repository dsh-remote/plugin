/**
 * host-config-docs.test — `docs/HOST-SIDE.md` 的配置键表与 `shell/config.ts` 逐项对齐。
 *
 * ## 为什么这条必须机械核对
 *
 * 插件的配置是"**写了不报错、不告警、不生效**"的那一类：读不认识的键不会失败，
 * 只是静默用默认值。于是配置表里一个**已经不存在的键**，和一个**忘记写进表的键**，
 * 后果完全一样——运维照着文档配了半天，什么都没发生。
 *
 * 这份文档自己就写了这种事故（§2.1「三个变量改名了（迁移风险）」：写了旧名字
 * 不报错、不告警、不生效，静默按新默认值跑）。本轮真去数了一遍，发现两类：
 *
 * - 表里有 `takeOverQuestions` / `DRC_TAKE_OVER_QUESTIONS`，而**代码里根本没有这个键**
 *   （`guard.ts` 明确记着"这一代宿主上 `userQuestions.registerProvider` 不存在"）。
 *   照着它设 `DRC_TAKE_OVER_QUESTIONS=1` 的人会得到一个静默无效的配置。
 * - 代码里有 5 个键**表里一个都没有**：`pairStoreFile`（PSK 落在哪、权限多少）、
 *   `uploadDir` / `maxFileBytes`（附件落哪、单文件多大）、`restoredIdleTtlSec`、
 *   `newSessionCwd`——后两个直接决定"新建会话落在哪个分组"。
 *
 * 插件仓自己看不到伞仓的 docs/，所以这条判据只能落在伞仓（它同时看得见两棵仓）。
 * 与 `dsh-remote-server/tests/docs.test.mjs` 是同一条思路，只是分在两个仓里各守一半。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_SRC = path.join(ROOT, 'dsh-remote-control', 'packages', 'plugin', 'src', 'shell', 'config.ts')
const DOC = path.join(ROOT, 'docs', 'HOST-SIDE.md')

const haveConfig = existsSync(CONFIG_SRC)

/** 配置键表里的第一列：`| \`key\` | …`。嵌套键（`pill.enabled`）按第一段收。 */
function documentedKeys(doc) {
  const keys = new Set()
  for (const match of doc.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9.]*)`/gm)) {
    keys.add(match[1].split('.')[0])
  }
  return keys
}

/**
 * 配置接口里真正声明的键。
 *
 * **只取 `PluginConfig` 那一段**：`config.ts` 里还有 `ConfigProblem`（`field`/`message`/
 * `min`/`fallback`）之类的辅助接口，全文件扫会把它们当成配置键。
 * 嵌套对象（`pill: { enabled }`、`keepAwake: { … }`）也算键——文档里以
 * `pill.enabled` / `keepAwake.enabled` 的形式出现，第一段就是 `pill` / `keepAwake`。
 */
function declaredKeys(source) {
  const body = /export interface PluginConfig \{([\s\S]*?)\n\}/.exec(source)?.[1]
  assert.ok(body, 'config.ts 里找不到 PluginConfig 接口：抽法或结构变了')
  const keys = new Set()
  for (const match of body.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*): (?:string|number|boolean|\{)/gm)) {
    keys.add(match[1])
  }
  return keys
}

test('配置表里的每个键，代码里真的存在（照着一个不存在的键配置 = 静默无效）', () => {
  if (!haveConfig) return
  const declared = declaredKeys(readFileSync(CONFIG_SRC, 'utf8'))
  assert.ok(declared.size >= 15, `只从 config.ts 抽出 ${declared.size} 个键：抽法或结构变了`)

  const documented = documentedKeys(readFileSync(DOC, 'utf8'))
  assert.ok(documented.size >= 10, `只从 HOST-SIDE.md 抽出 ${documented.size} 个配置键：抽法或表格写法变了`)

  const ghosts = [...documented].filter((key) => !declared.has(key)).sort()
  assert.deepEqual(
    ghosts,
    [],
    `HOST-SIDE.md 的配置表里有这些键，而 config.ts 里**不存在**：${ghosts.join(', ')}。` +
      '插件读不认识的键不会失败，只是静默用默认值——照着文档配的人会得到一个' +
      '静默无效的配置。2026-10-06 实测就抓到过一个（takeOverQuestions / DRC_TAKE_OVER_QUESTIONS）',
  )
})

test('配置接口里的每个键都在 HOST-SIDE.md 的表里出现过（运维不知道它能调 = 等于没有）', () => {
  if (!haveConfig) return
  const declared = declaredKeys(readFileSync(CONFIG_SRC, 'utf8'))
  const doc = readFileSync(DOC, 'utf8')

  // **只扫配置表那几行**（以 `|` 开头），理由与下面那条 DRC_* 判据完全一样：
  // 正文里提到一个键名是在讲历史或讲踩过的坑，那不是"这个键现在还能调"。
  //
  // 原来这里扫全文，于是两件事同时发生（2026-10-07 修）：
  // ① 判据比它自己声称的**弱** —— `enabled` / `maxFileBytes` 在正文散文里
  //    出现过就放过，于是"表格里删掉了这一行"它照样绿；
  // ② 它把说明当成了配置 —— 我自己写的订正注记里如实列过一个已删掉的键名，
  //    足以把这条判据弄红（与 DRC_* 那条踩过的坑一模一样）。
  const table = doc
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .join('\n')
  assert.ok(table.length > 500, `配置表只抽到 ${table.length} 字符：表格写法变了，同步改判据`)
  const missing = [...declared].filter((key) => !table.includes(key)).sort()
  assert.deepEqual(
    missing,
    [],
    `config.ts 里这些键在 HOST-SIDE.md 的**配置表**里一次都没出现：${missing.join(', ')}。` +
      '其中 pairStoreFile / uploadDir / maxFileBytes 决定"密钥与附件落在哪"，' +
      'newSessionCwd 决定"新建会话落在哪个分组"——运维找不到就等于没有这个开关。' +
      '（判据只扫表格行：正文里提到键名是在讲历史，不是在讲"现在还能调"）',
  )
})

test('配置接口里出现的每个 DRC_* 环境变量，表里点名了它（拼错 env 名同样静默无效）', () => {
  if (!haveConfig) return
  const source = readFileSync(CONFIG_SRC, 'utf8')
  const doc = readFileSync(DOC, 'utf8')
  // 只取**真正被读取**的那些：`fromEnv('DRC_X')` / `env.DRC_X`。
  const read_ = new Set(
    [...source.matchAll(/fromEnv\('(DRC_[A-Z0-9_]+)'\)|env\.(DRC_[A-Z0-9_]+)/g)].map((m) => m[1] ?? m[2]),
  )
  // DRC_HOST_TOKEN 由 hostTokenEnv 这一行间接读，config.ts 里只出现变量名不出现 fromEnv。
  read_.add('DRC_HOST_TOKEN')
  assert.ok(read_.size >= 7, `只从 config.ts 抽出 ${read_.size} 个环境变量：抽法或结构变了`)

  const missing = [...read_].filter((name) => !doc.includes(name)).sort()
  assert.deepEqual(missing, [], `config.ts 读这些环境变量，HOST-SIDE.md 里没点名：${missing.join(', ')}`)
})

test('文档里点名的每个 DRC_* 环境变量，代码里真的会读（拼错的 env 名静默走默认值）', () => {
  if (!haveConfig) return
  const source = readFileSync(CONFIG_SRC, 'utf8')
  const doc = readFileSync(DOC, 'utf8')
  const read_ = new Set(
    [...source.matchAll(/fromEnv\('(DRC_[A-Z0-9_]+)'\)|env\.(DRC_[A-Z0-9_]+)/g)].map((m) => m[1] ?? m[2]),
  )
  read_.add('DRC_HOST_TOKEN')

  // **只扫配置表那几行**（以 `|` 开头）：正文里提到一个变量名是在讲历史或讲踩过的坑，
  // 那不是"这个变量现在还生效"。第一版扫全文，于是我自己写的订正注记（里面如实写了
  // `DRC_TAKE_OVER_QUESTIONS` 这个已被删掉的键）把判据弄红了——判据把说明当成了配置。
  const table = doc
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .join('\n')
  const ghosts = [...new Set([...table.matchAll(/DRC_[A-Z0-9_]+/g)].map((m) => m[0]))]
    .filter((name) => !read_.has(name))
    .sort()
  assert.deepEqual(
    ghosts,
    [],
    `HOST-SIDE.md 的**配置表**里点名了这些环境变量，而 config.ts **不读**它们：${ghosts.join(', ')}。` +
      '设了不报错、不告警、不生效——2026-10-06 实测就抓到过一个（DRC_TAKE_OVER_QUESTIONS）',
  )
})