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