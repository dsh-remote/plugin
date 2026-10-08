/**
 * next-version 的判据 —— `scripts/next-version.mjs` 的纯函数部分。
 *
 * 为什么值得测：这一段决定**发出去的号对不对**，而错了的代价是「latest 退回去」
 * 或「npm 拒绝发布」——两者都要到发版那一刻才现形，而那时已经改不回去了。
 *
 * 这里**不联网**：判据的输入是"哪些版本被占用了"，测试里直接给。
 * 真连 npm 的那条路径由 `node scripts/next-version.mjs --check` 在发版前跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatVersion,
  isGreater,
  isPackageNotFound,
  nextVersion,
  parsePublishedVersions,
  parseVersion,
  versionProblems,
} from '../scripts/next-version.mjs'

test('预发布排在同版本的正式版之前（semver：1.0.0-rc.1 < 1.0.0）', () => {
  assert.equal(isGreater('1.0.0', '1.0.0-rc.1'), true, '切 latest 到正式版不是"倒退"')
  assert.equal(isGreater('1.0.0-rc.1', '1.0.0'), false)
  assert.equal(isGreater('1.0.0-rc.2', '1.0.0-rc.1'), true)
  assert.equal(isGreater('1.0.0', '1.0.0'), false, '相同版本不算更大')
})

test('按 semver 比大小，不按字符串（否则 1.0.10 会小于 1.0.9）', () => {
  assert.equal(isGreater('1.0.10', '1.0.9'), true, '字符串比较会把 1.0.10 排在 1.0.9 前面')
  assert.equal(isGreater('2.0.0', '1.99.99'), true)
  assert.equal(isGreater('1.2.0', '1.10.0'), false)
})

test('形状不对的版本号要当场报出来，不许默默当 0', () => {
  for (const bad of ['', '1.0', 'v1.0.0', '1.0.0.0', 'abc', '1.0.0-']) {
    assert.throws(() => parseVersion(bad), /版本号形状不对/, `\`${bad}\` 不该被放过`)
  }
  assert.equal(formatVersion(parseVersion('2.0.14')), '2.0.14')
  assert.equal(formatVersion(parseVersion('1.0.0-rc.1')), '1.0.0-rc.1')
})

test('建议号必须**大于**所有已发布版本 —— 2.0.8 那个坑（2026-10-07 实际卡过一次）', () => {
  // control 当年从 2.0.7 直接跳到 2.0.9，所以 **2.0.8 是空的**。
  // 但发 2.0.8 等于版本号倒退：2.0.13 已经出去了，latest 会退回去，
  // 而 `^2.0.0` 的消费方按 semver 比大小，**拿不到** 2.0.8。
  // ⚠️ 刻意**打乱顺序**：第一版的用例给的是升序，于是"取最后一个当最大"这种写法
  // 照样通过——那正是这道闸的判据（必须真的比出最大，而不是相信输入有序）。
  // npm 一般给升序，但**依赖输入有序**就是本条要防的病。
  const wire = ['1.9.0', '1.0.0', '1.0.1', '1.0.0-rc.1', '1.1.0']
  const ctrl = ['2.0.13', '1.2.0', '2.0.9', '1.0.0-rc.1', '2.0.0', '1.0.0', '2.0.7', '1.1.0']
  assert.equal(nextVersion([wire, ctrl]), '2.0.14', '必须跳过"空着但更小"的 2.0.8')
})

test('建议号还要在**两个包上**都空着（一个包占了就换另一个）', () => {
  const wire = ['1.0.0']
  const ctrl = ['1.0.0', '1.0.1']
  assert.equal(nextVersion([wire, ctrl]), '1.0.2')
})

test('--major：跳到下一个大版本，而不是在小版本里找', () => {
  const wire = ['1.9.0']
  const ctrl = ['2.0.13']
  assert.equal(nextVersion([wire, ctrl]), '2.0.14')
  assert.equal(nextVersion([wire, ctrl], { bumpMajor: true }), '3.0.1', '跳大版本时 patch 从 1 起')
})

test('两个包都空 → 从 0.0.1 起给得出号（别在空输入上崩）', () => {
  assert.equal(nextVersion([[], []]), '0.0.1')
})

// ── 换 scope 时暴露的一类崩法（2026-10-08）──────────────────────────
//
// `npm view <不存在的包> versions --json` 会 **exit 1** + stderr 打
// `npm error code E404`。而"这个包还没有任何版本"是**合法状态**——
// 典型场景正是把一个包搬到新 scope 之后、第一次发布之前。
//
// 原来的 `publishedVersions` 直接 `execFileSync`，于是那个窗口里整个版本闸
// **崩掉**（抛栈）而不是报红。这两个纯函数是对那段逻辑的机械化，
// 所以判据落在它们身上：真去打 npm 会让单测依赖网络。

test('isPackageNotFound：只认 E404，别的失败照旧抛（吞过头会让闸门在最需要时放行）', () => {
  // 真实的 npm 错误形状（2026-10-08 实测 `npm view @dsh-remote/core versions` 的 e.stderr）
  const real404 = {
    status: 1,
    stderr: "npm error code E404 | npm error 404 Not Found - GET https://registry.npmjs.org/@dsh-remote%2fcore - Not found",
  }
  assert.equal(isPackageNotFound(real404), true, '实测形状必须被认出来')

  // 反向判据：这几类**不许**被当成"没发布过"——
  // 它们是"npm 真的坏了"，而那时静默当作空集正好是最危险的放行。
  assert.equal(
    isPackageNotFound({ status: 1, stderr: 'npm error code EAI_AGAIN | getaddrinfo ENOTFOUND registry.npmjs.org' }),
    false,
    '网络不通不是"包不存在"：当成空集会让闸门以为这个号空着，而它可能已被占',
  )
  assert.equal(isPackageNotFound({ status: 1, stderr: 'npm error code E401 | Unable to authenticate' }), false, '鉴权失败同上')
  assert.equal(isPackageNotFound({ status: 1, stderr: '' }), false, '空 stderr 什么也证明不了')
  assert.equal(isPackageNotFound({ status: 0, stderr: 'npm error code E404' }), false, '退出码 0 不是失败')
  assert.equal(isPackageNotFound(undefined), false, '别在 null/undefined 上炸')
  assert.equal(isPackageNotFound(new Error('boom')), false, '普通 Error 没有 status/stderr')
})

test('parsePublishedVersions：单个版本号也要包成数组（npm 在只有一个版本时不返回数组）', () => {
  assert.deepEqual(parsePublishedVersions('["1.0.0","1.0.1"]'), ['1.0.0', '1.0.1'])
  assert.deepEqual(parsePublishedVersions('"1.0.0"'), ['1.0.0'], '只有一个版本时 npm 给的是字符串')
  assert.deepEqual(parsePublishedVersions(''), [], '空 stdout = 没有版本，不是抛')
  assert.deepEqual(parsePublishedVersions('npm warn something'), [], '不是 JSON 也不许抛')
  assert.deepEqual(parsePublishedVersions('null'), [], 'null 不是版本')
})

test('versionProblems：`taken` 为空（从没发过的包）不许让它崩，也不许报"倒退"', () => {
  // 换 scope 时会撞到的第二处崩法：`taken.reduce((a,b)=>…, taken[0])`
  // 在空数组上得到 `undefined`，而 `isGreater(version, undefined)` 会去
  // `parseVersion(undefined)` 并抛 —— 症状是闸门**崩掉**（抛栈），
  // 而不是"新包当然比空集大"这个显然的结论。崩掉比报红更难查：
  // 会让人以为是脚本坏了，而不是"这个包还没发"。
  assert.deepEqual(
    versionProblems('@dsh-remote/core', '2.0.21', []),
    [],
    '从没发过的包：任何版本都合法，且不许崩',
  )

  // 而一有历史，两条判据就都要生效 —— 反向判据：
  // 只写"空数组不崩"，把整个函数写成 `return []` 也能过。
  const taken = ['2.0.20', '2.0.21']
  // ⚠️ 这里**是两条不是一条**：2.0.21 既"被占过"，又"不大于最大版本"。
  // 第一版判据写的是 1，红在了这句上——而实现是对的（见下面那条
  // 「不许互相短路」的判据）。与 memory 里那条同族：
  // **判据红了先怀疑判据**。
  assert.equal(
    versionProblems('@dsh-remote/core', '2.0.21', taken).length,
    2,
    '号被占过 + 不大于最大版本，两条都要报',
  )
  assert.match(versionProblems('@dsh-remote/core', '2.0.21', taken)[0], /已经发布过/)
  assert.equal(
    versionProblems('@dsh-remote/core', '2.0.19', taken).length,
    1,
    '号没被占但比最大版本小 ⇒ 报"倒退"（2.0.8 那个坑的正解）',
  )
  assert.match(versionProblems('@dsh-remote/core', '2.0.19', taken)[0], /不大于/)
  assert.equal(
    versionProblems('@dsh-remote/core', '2.0.22', taken).length,
    0,
    '比最大版本大的新号必须放行',
  )
})

test('versionProblems：号既被占过又更小，两条都要报（不许互相短路）', () => {
  // 这一条守的是"两件事各判各的"：旧实现写成 `if (!taken.includes(v)) continue`，
  // 于是"号被占"会**短路掉**"倒退"那条 —— 而 2.0.8 正是栽在这里
  //（它在 control 上是空的号，但小于已发布的 2.0.13）。
  const probs = versionProblems('x', '1.0.0', ['1.0.0', '2.0.0'])
  assert.equal(probs.length, 2, `两条判据都必须报，实得 ${JSON.stringify(probs)}`)
})
