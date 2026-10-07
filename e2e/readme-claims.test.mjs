/**
 * readme-claims.test — 伞仓 README 里**能被机械核对**的那些说法。
 *
 * ## 为什么只核对"能机械核对的"
 *
 * README 里既有必须常新的事实（各项数、字段名、路径），也有必须常在的散文
 * （设计取舍、事故由来、拍板记录）。散文靠人读，数字与字段名靠判据。
 *
 * 这条判据的由来是一次真实的漂移：`pnpm gates` 那轮里同时被指出来的还有
 * 「小程序**三道**闸」——`check` 实际是四道（verify + md + theme:check + contrast）；
 * 以及「verify-miniprogram（32 项）」的 32 项其实属于 markdown 渲染闸（verify 是一段
 * 普通断言脚本，不是 node:test）。两句都读起来完全合理，都没人发现，直到有人
 * 真去数了一遍。**事实性说法与实现脱节，是靠"数一遍"发现的，不是靠"看一眼"。**
 *
 * 覆盖：项数由 `scripts/report-gates.mjs` 负责（要真跑一遍才能知道），这里只管
 * 不跑也能核的那几类。
 */
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8')

const README = read('README.md')
const SERVER_DIST = path.join(ROOT, 'dsh-remote-server', 'dist', 'src')
const PLUGIN_SRC = path.join(ROOT, 'dsh-remote-control', 'packages', 'plugin', 'src')

/** 四棵平行仓在场是前提；不在就跳过而不是假装通过（伞仓单独 clone 时无意义）。 */
const haveServerDist = existsSync(path.join(SERVER_DIST, 'server.js'))
const havePluginSrc = existsSync(path.join(PLUGIN_SRC, 'pill', 'routes.ts'))

test('README 与 HOST-SIDE 说的宿主路由条数，与 pill/routes.ts 里注册的四条一致', () => {
  if (!havePluginSrc) return
  const routes = read('dsh-remote-control', 'packages', 'plugin', 'src', 'pill', 'routes.ts')
  const declared = [...routes.matchAll(/export const PAIR_\w+_ROUTE = '([^']+)'/g)].map((m) => m[1])
  assert.equal(
    declared.length,
    4,
    `宿主侧应该是四条同域路由，实际从 routes.ts 里抽出 ${declared.length} 条：${declared.join(', ')}——` +
      '改了这一处，README 与 HOST-SIDE 里「N 条同域路由」的数都要一起改',
  )
  // 两份文档都用 `/pairing/new` 这样的**缩写**（全路径太长，缩写更好读），所以判据按
  // 尾段比；两份都至少要提到每一条，否则"四条"里的某条在说明书上是不存在的。
  const hostSide = read('docs', 'HOST-SIDE.md')
  for (const route of declared) {
    const suffix = route.replace('/plugins/dsh-remote-control', '')
    assert.ok(README.includes(suffix), `README 少了路由 ${suffix}：§「配对与使用」第 1 条是配对入口的唯一说明书`)
    assert.ok(hostSide.includes(suffix), `docs/HOST-SIDE.md 少了路由 ${suffix}：§6「路由的真机取证」是照着 curl 的那一份`)
  }
  // 条数不能少算。这条曾经长期写着"3 条"：`/unpair` 是 2026-10-05 加的，
  // 补进了正文却没补这里的计数（见 HOST-SIDE §6 那条订正注记）。
  //
  // ⚠️ 匹配前必须**先把 `*` 去掉**：文档里那句是 `**4 条**同域路由`，星号夹在数字与
  // 「条」之间，`(\d+)\s*条同域路由` 匹配不到——于是判据只看见了同一文件里另一处
  // 没加粗的写法，把真正要盯的那一句漏掉了（第一版就这么写，变异验证当场抓出来）。
  const plainHostSide = hostSide.replace(/\*/g, '')
  const hostSideCounts = [...plainHostSide.matchAll(/(\d+)\s*条同域路由/g)].map((m) => Number(m[1]))
  assert.ok(
    hostSideCounts.length >= 2,
    `HOST-SIDE 里只抽到 ${hostSideCounts.length} 处「N 条同域路由」：§6 那句才是要盯的，抽不到说明写法变了，同步改判据`,
  )
  for (const count of hostSideCounts) {
    assert.equal(count, declared.length, `HOST-SIDE 说「${count} 条同域路由」，实际注册了 ${declared.length} 条`)
  }
  assert.doesNotMatch(
    plainHostSide,
    /3\s*条同域路由/,
    'HOST-SIDE 又写回「3 条同域路由」了：`/unpair` 是第四条（2026-10-05 加，见 §6 的订正注记）',
  )
  // 写路由必须带那道自定义头 —— 两份文档都把它写成"跨站判据是**同源才发得出的自定义头**
  // 而不是 `Origin`"，所以判据要盯的是那个头确实存在。
  assert.match(routes, /PAIR_MARKER_HEADER\s*=/, 'routes.ts 里没有自定义头常量：那两份文档的核心说法就不成立')
})

test('README 列出的 /healthz 落盘五字段，与中继真的 health() 键集一致', () => {
  if (!haveServerDist) return
  const fields = ['persistence', 'stateRestored', 'stateSavedAtSec', 'stateWrites', 'stateWriteFailures']
  for (const field of fields) {
    assert.ok(README.includes(`\`${field}\``), `README 少了 healthz 字段 ${field}`)
  }
  const source = read('dsh-remote-server', 'src', 'server.ts')
  for (const field of fields) {
    assert.ok(
      source.includes(field),
      `/healthz 里其实没有 ${field}：README 的运维口径（"换完机器先看 stateWriteFailures，不是 0 就是没在写"）会指着一个不存在的字段`,
    )
  }
})

test('README 里写的 mp 闸门与 mp 的 check 脚本逐项一致（"三道"曾经是错的）', () => {
  const pkg = JSON.parse(read('dsh-remote-mp', 'package.json'))
  // `check` 串起来的每一段都必须是一个存在的 script，且每一个 script 都要被 check 覆盖：
  // 只查前者会漏掉"加了新闸但没接进 check"，后者才是那次漂移的方向。
  const chain = pkg.scripts.check.split('&&').map((part) => part.trim().replace(/^npm run /, ''))
  const covered = new Set(chain)
  for (const name of chain) {
    assert.ok(pkg.scripts[name], `check 里提到的 ${name} 在 package.json 里不存在`)
  }
  for (const [name] of Object.entries(pkg.scripts)) {
    if (['check', 'theme', 'format', 'format:check', 'prepare'].includes(name)) continue
    assert.ok(covered.has(name), `mp 加了 script \`${name}\` 却没接进 \`check\`：CI 只跑 check，新闸等于不存在`)
  }
  // 不去数「N 道闸」那个词（写阿拉伯数字还是中文数字都算过），而是**要求每一道闸都被
  // README 点名**（脚本名或它做的事）。数错条数只是症状，症状真正的问题是"照着 README
  // 不知道自己漏跑了哪一道"。历史上那句「三道闸」就是这么错的。
  const MENTIONS = {
    verify: ['verify-miniprogram', '结构自检'],
    md: ['markdown 渲染', 'markdown'],
    'theme:check': ['theme:check', '主题'],
    contrast: ['contrast', '对比度'],
  }
  for (const name of chain) {
    const hints = MENTIONS[name] ?? [name]
    assert.ok(
      hints.some((hint) => README.includes(hint)),
      `README 没说清 mp 的 \`${name}\` 这一道闸（${hints.join(' / ')} 都没出现）：` +
        '照着 README 跑的人会以为它不在 check 里',
    )
  }
})

test('README 说的本地全链路步数，与 e2e/run.mjs 里真实的步骤条数一致', () => {
  const run = read('e2e', 'run.mjs')
  const steps = (run.match(/^\s+await run\(/gm) ?? []).length
  assert.ok(steps >= 10, `run.mjs 里只数到 ${steps} 个 await run(...)：判据的抽法或结构变了`)
  const claim = /本地全链路[^0-9]{0,12}(\d+)\s*步/.exec(README)
  assert.ok(claim, 'README 里找不到「本地全链路 N 步」那句；它变了写法就同步改判据')
  assert.equal(Number(claim[1]), steps, `README 说 ${claim[1]} 步，run.mjs 里实际 ${steps} 步`)
})

test('README 的四仓落位表里，每个目录都真的在', () => {
  for (const dir of [
    'dsh-remote-protocol',
    'dsh-remote-server',
    'dsh-remote-control',
    'dsh-remote-mp',
    'e2e',
    'scripts',
    'deploy',
    'docs',
  ]) {
    assert.ok(existsSync(path.join(ROOT, dir)), `README 的「组成」表里列了 ${dir}/，但盘上没有`)
  }
})

test('README 的「文档」小节里，每条相对链接都指向真实文件', () => {
  // 伞仓没有 CI、没人点链接，所以"链接指向已删文件"会一直躺着直到有人真的点它。
  const section = /\n## 文档\n([\s\S]*?)\n## /.exec(README)?.[1] ?? ''
  assert.ok(section, 'README 里找不到「## 文档」小节')
  const links = [...section.matchAll(/\]\(([^)#]+?)\)/g)].map((m) => m[1])
  assert.ok(links.length >= 6, `只从「文档」小节抽出 ${links.length} 条链接，判据自己没抽到东西`)
  for (const link of links) {
    if (/^https?:/.test(link)) continue
    assert.ok(existsSync(path.join(ROOT, link)), `README 的「文档」小节指向了不存在的文件：${link}`)
  }
})

test('本轮改动最多的几份文档：Markdown 表格没有残缺行（改表格时最容易漏的一处）', () => {
  // 伞仓 README 的「组成」与「测试」两张表是纯手写的，表格改坏（列数对不上）不会
  // 报任何错，只会渲染成一团。HANDOFF / HOST-SIDE / SECURITY 同理——它们是这一轮
  // 改动最多的三份，而伞仓没有 CI，坏掉的表格会一直躺着。
  for (const doc of ['README.md', 'HANDOFF.md', 'docs/HOST-SIDE.md', 'docs/SECURITY.md']) {
    const lines = read(doc).split('\n')
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trimStart().startsWith('```')) inFence = !inFence
      if (inFence || !line.startsWith('|')) continue
      const sep = lines[i + 1] ?? ''
      // 找这一块表格的第一行（分隔行）作为列数基准
      if (!/^\|[\s:|-]+\|?\s*$/.test(sep)) continue
      const columns = sep.split('|').length
      assert.equal(
        line.split('|').length,
        columns,
        `${doc} 第 ${i + 1} 行的表格列数与表头对不上（${line.split('|').length - 2} 列 vs ${columns - 2} 列）：${line.slice(0, 60)}`,
      )
    }
  }
})

test('docs/SECURITY.md 引用的每一份**代码**都真的存在（伞仓没有 CI，引用坏了没人会发现）', () => {
  // 这份文档明说"每条论断后面都跟着引用，请把它当成可核对的引用而不是修辞"。
  // 2026-10-06 核对时 41 个引用里有 13 个指向已删或已改名的文件
  // （协议层的 src/frames.ts 搬进了 src/wire/、mp 的 pages/pair/ 整页已删），
  // 而**没有任何一层会报这个错**：伞仓没有 CI，docs/ 也不在任何闸门的射程内。
  //
  // 只查 `dsh-remote-*/`、`e2e/`、`scripts/` 这三类**代码**引用：`docs/` 那几处是
  // "伞仓那份已删除"之类的历史陈述（说的就是一个不存在的文件，那正是它要说的），
  // 把它们也当成待查路径会把判据变成永远红着的假闸。
  const security = read('docs', 'SECURITY.md')
  // `git show <commit>:<path>` 指的就是那个提交里的文件，一个字都不能动也不该查。
  const scannable = security.replace(/git show [0-9a-f]+:[A-Za-z0-9_./-]+/g, '')
  const cited = new Set(
    [...scannable.matchAll(/`((?:dsh-remote-|e2e\/|scripts\/)[A-Za-z0-9_.\/-]*)`/g)].map((m) => m[1]),
  )
  assert.ok(cited.size >= 25, `只从 SECURITY.md 抽出 ${cited.size} 个代码路径引用：判据自己没抽到东西`)

  const missing = [...cited].filter((rel) => !existsSync(path.join(ROOT, rel))).sort()
  assert.deepEqual(missing, [], `SECURITY.md 引用了不存在的文件：${missing.join(', ')}`)
})

test('docs/SECURITY.md 正文里没有已删目录的旧路径残留（历史取证那一类除外）', () => {
  const security = read('docs', 'SECURITY.md')
  const lines = security.split('\n')
  // 两类行必须排除，否则判据不是"能守住"而是"永远红着"：
  //  ① `git show <commit>:<path>` —— 那个路径就该是历史路径；
  //  ② 文档头那段**路径对照表** —— 它的职责就是把旧名字逐字列出来。
  // 那段对照表以"→ `dsh-remote-…`"收尾，逐字列出旧名字；用字符串判定而不是正则——
  // 正则字面量里写路径必然要转义 `/` 与反引号，而这类判据转义一次就容易漏一处。
  const isMappingNote = (line) => line.includes('→ `dsh-remote-')
  const body = lines.filter((line) => !line.includes('git show ') && !isMappingNote(line)).join('\n')
  for (const [label, pattern] of [
    ['apps/server/', /(?:^|[^/\w-])apps\/server\//],
    ['packages/protocol/', /(?:^|[^/\w-])packages\/protocol\//],
    ['packages/plugin/', /(?:^|[^/\w-])packages\/plugin\//],
    ['mp/core/', /(?:^|[^/\w-])mp\/core\//],
  ]) {
    assert.doesNotMatch(
      body,
      pattern,
      `SECURITY.md 正文里还留着旧目录 ${label}：四个仓已经拆成平行的顶层目录（README「组成」表是权威），` +
        '读者照着它找不到文件——而这份文档的价值就是那些引用可核对',
    )
  }
})

test('PRODUCT.md 不再把已实现的东西列为"明确不做"或"待办"（G1–G6 已全部落地）', () => {
  // 这份文档回答的是"我们凭什么还存在"，所以它一旦开始说谎（把做了的事写成不做），
  // 后面每一个取舍判断都建立在错的前提上。本轮核出两处：
  //   §4「会话列表只读、不能新建/删除」——新建会话 2026-10-05 就做了；
  //   §6「明确不做：…图片消息」——mp 早就能发图（chooseMedia + cmd.send_prompt.images）；
  //   §5 的 G1–G6 六条待办——逐条去代码里核，**六条全部已实现**，却还写着"现在还不符合"。
  const doc = read('docs', 'PRODUCT.md')

  // ① §4/§6 的"不做"清单里不许把已实现的说法留在**生效**状态。
  //
  // 判据用"提到即必须划掉"而不是"匹配某一句原话"：第一版写成匹配
  // `**会话列表只读、不能新建/删除**` 与 `- 文件浏览、远程终端、图片消息`，
  // 结果自己把那张表拆成两行之后判据就再也匹配不上了——把"不能新建会话"和
  // "图片消息"改回生效状态都测不出来（两次变异验证当场发现）。
  // 不变式与措辞无关：只要提到，就必须是 `~~…~~` 划掉的那一版。
  for (const [label, needle] of [
    ['不能新建会话', '不能新建会话'],
    ['图片消息列为不做', '图片消息'],
  ]) {
    for (const line of doc.split('\n')) {
      const at = line.indexOf(needle)
      if (at < 0) continue
      // 这一行必须整体落在某个 `~~…~~` 区间里（即被划掉 = 已收回的旧说法）。
      const before = line.slice(0, at)
      const struck = (before.match(/~~/g) ?? []).length % 2 === 1
      // 只认"划掉"这一种收回方式。**刻意不给"行里有'已做'就放过"这个逃生口**——
      // 它立刻变成漏洞：把表格那行改回 `| **不能新建会话** | "交互缺失" |` 而行尾
      // 恰好接着 "**2026-10-05 已做**（…）"，判据就当它合格了（变异验证当场发现）。
      assert.ok(
        struck,
        `PRODUCT.md 里「${label}」以**生效**措辞出现（${line.trim().slice(0, 70)}）：` +
          '它已经实现了，收回旧说法必须划掉（~~…~~），否则读的人会以为它不做',
      )
    }
  }

  // ② §5 的待办表必须已经被换成"已做完 + 真正还剩的"，而不是那张 G1–G6 原表。
  assert.match(
    doc,
    /^### 5\.1 已做完（原 G1–G6）/m,
    'PRODUCT.md §5 没有改写成"已做完/还剩什么"：那份 G1–G6 原表已被逐条核对为全部实现',
  )
  for (const item of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
    assert.match(doc, new RegExp(`^\\| ${item} \\|`, 'm'), `§5.1 里少了 ${item} 的落地记录`)
  }
  assert.match(doc, /^### 5\.2 真正还剩的/m, 'PRODUCT.md §5 缺"真正还剩的"那一节')

  // ③ §3 的五条判据编号仍要连续——§5 的表按编号引用它们，编号一散就引用不上了。
  const rules = [...doc.matchAll(/^(\d)\. \*\*/gm)].map((m) => m[1])
  for (const n of ['1', '2', '3', '4', '5']) {
    assert.ok(rules.includes(n), `PRODUCT.md §3 少了第 ${n} 条判据（§5 的表按编号引用它）`)
  }
})

test('scripts/ 与 e2e/ 下每个脚本都能被 node --check 解析（没人跑的工具最容易悄悄坏掉）', () => {
  // 伞仓的开发工具一行判据都没有：上界修得再好，脚本本身坏掉要等到有人真的需要它
  // 那天才发现——而那时候它多半是用来救火的。
  //
  // `--check` 不执行、也不需要任何依赖，代价接近零，能挡住"括号没合上 / 漏个分号"
  // 这一整类。**刻意不检查运行期行为**：这些脚本要开发者工具、要真机、要微信后台，
  // 伞仓没有那些条件，假装能验只会写出恒绿的判据（§0.10.7 记的那条教训）。
  const dirs = ['scripts', 'e2e']
  let checked = 0
  for (const dir of dirs) {
    const full = path.join(ROOT, dir)
    if (!existsSync(full)) continue
    for (const name of readdirSync(full)) {
      if (!name.endsWith('.mjs')) continue
      if (dir === 'e2e' && !name.endsWith('.test.mjs') && !['run.mjs', 'mp-sim.mjs', 'live-e2e.mjs'].includes(name)) {
        continue
      }
      const file = path.join(full, name)
      const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      assert.equal(
        res.status,
        0,
        `${dir}/${name} 解析失败：${String(res.stderr || res.stdout).slice(0, 200)}。\n` +
          '它不会自己坏——是有人在它上面改了什么，而没有任何东西会告诉他。',
      )
      checked += 1
    }
  }
  assert.ok(checked >= 10, `只检查了 ${checked} 个脚本：目录结构或命名变了？`)
})

test('README 里提到的每个 scripts/*.mjs 都真的存在', () => {
  // 提取放宽成"README 里任何位置出现的 `scripts/<name>.mjs`"：README 的写法有三种
  // （表格里 `node scripts/x.mjs`、散文里裸文件名 `x.mjs`、以及 `scripts/x.mjs`），
  // 锚在反引号上的话只能抽到其中一种。第一版就是这么写的，抽出 0 个还以为是自己写错了。
  const mentioned = new Set(
    [...README.matchAll(/scripts\/([A-Za-z0-9_.-]+\.mjs)/g)].map((m) => `scripts/${m[1]}`),
  )
  assert.ok(mentioned.size >= 2, `只从 README 抽出 ${mentioned.size} 个脚本引用：抽法或写法变了`)
  const missing = [...mentioned].filter((rel) => !existsSync(path.join(ROOT, rel))).sort()
  assert.deepEqual(missing, [], `README 提到这些脚本，但盘上没有：${missing.join(', ')}`)
})

test('docs/ 下每一份文档都被 README 的「文档」小节链接到（孤儿文档会静默烂掉）', () => {
  // 伞仓没有 CI，而"没人找得到"是文档腐烂最常见的原因：仓库里躺着两份没人链接的文档
  // （BOOTSTRAP-ASSESSMENT 与 HOST-CAPABILITIES），它们一旦过期就没有任何人会发现。
  // 判据：新加一份 docs/*.md 必须同时在 README 里给它一个位置。
  const docsDir = path.join(ROOT, 'docs')
  const files = readdirSync(docsDir).filter((name) => name.endsWith('.md')).sort()
  assert.ok(files.length >= 7, `docs/ 下只扫到 ${files.length} 份文档：目录结构变了？`)

  const section = /\n## 文档\n([\s\S]*?)\n## /.exec(README)?.[1] ?? ''
  assert.ok(section, 'README 里找不到「## 文档」小节')
  const orphans = files.filter((name) => !section.includes(`docs/${name}`))
  assert.deepEqual(
    orphans,
    [],
    `docs/ 下这些文档没有出现在 README 的「文档」小节里：${orphans.join(', ')}。` +
      '没人找得到的文档会静默烂掉——要么给它一个位置，要么移进 docs/legacy-spec/',
  )
})
