/**
 * secure-file-port 的判据 —— A2 的出口。
 *
 * ## 覆盖两件事
 *
 * 1. **POSIX 上权限真的收紧**（`mode & 0o777 === 0o600`）。
 * 2. **win32 必须留下一条 warn** —— 这是 A2 判据里最要紧的一条：
 *    v2 的五处 `chmodSync(0o600)` 在 Windows 上**静默失效**（chmod 只切只读位），
 *    而代码与文档都在说"0600 已收紧"。**沉默的失效比没有 chmod 更坏**——
 *    它让人以为凭据文件是安全的。所以出口是"显式 warn 一次"，而不是假装生效。
 *
 * ## 平台相关的用例一律 skip，且**必须带原因**
 *
 * `mode & 0o777 === 0o600` 在 win32 上永远不成立，`chmodSync(dir, 0o500)` 造不出只读目录。
 * 这些用例在 win32 上 skip——但 skip 的 `reason` 要写清**为什么**（V3-PLAN A5：
 * 「win32 的 skip 必须显式且带原因」），否则 CI 变绿时没人知道它其实没测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  chmodEffective,
  resetSecureFileWarnings,
  safeFileName,
  secureFileWarnCount,
  warnOnce,
  writeSecure,
} from '../src/platform/secure-file.js'

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'win32 没有 POSIX 权限位：chmod 只切只读位' : false }
function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'drc-secure-'))
}

test('POSIX：写出来的凭据文件权限确实是 0600', POSIX_ONLY, () => {
  const dir = tempDir()
  try {
    const target = path.join(dir, 'state.json')
    writeSecure(target, '{"a":1}\n')
    assert.equal(statSync(target).mode & 0o777, 0o600, '权限位必须是 0o600：这份文件里可能有 PSK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('覆盖写不会把权限放宽（崩溃残留 / pid 复用那条洞）', POSIX_ONLY, () => {
  const dir = tempDir()
  try {
    const target = path.join(dir, 'state.json')
    // 先手工造一个"上一次同 pid 留下的 0644 残留"——v2 五处里只有 relay 做了 unlink，
    // 其余四处都靠 writeFileSync 的 mode，而 mode 对已存在的文件**不生效**。
    writeFileSync(`${target}.tmp-${process.pid}`, 'old', { mode: 0o644 })
    assert.equal(statSync(`${target}.tmp-${process.pid}`).mode & 0o777, 0o644, '前置条件：残留确实是 0644')

    writeSecure(target, 'new\n')
    assert.equal(
      statSync(target).mode & 0o777,
      0o600,
      '残留的 0644 权限被带过来了：mode 只在创建那一刻生效，必须先清残留 + 显式 chmod',
    )
    assert.equal(readFileSync(target, 'utf8'), 'new\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('原子性：写完之后 tmp 不存在（rename 真的发生了）', () => {
  const dir = tempDir()
  try {
    const target = path.join(dir, 'state.json')
    writeSecure(target, 'body\n')
    const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'tmp 没有被 rename 掉：读者会看到一个半截文件')
    assert.deepEqual(readdirSync(dir), ['state.json'], '目录里只该剩下最终文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('反向判据：内容必须真的落到位（不是只建了个空文件）', () => {
  const dir = tempDir()
  try {
    const target = path.join(dir, 'a.json')
    writeSecure(target, '{"k":"值"}\n')
    assert.equal(readFileSync(target, 'utf8'), '{"k":"值"}\n', '内容必须逐字节落到位')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chmodEffective：POSIX 为真、win32 为假（"权限已收紧"这句话在 Windows 上不该被说出口）', () => {
  assert.equal(chmodEffective('darwin'), true)
  assert.equal(chmodEffective('linux'), true)
  assert.equal(chmodEffective('win32'), false, 'Windows 上 chmod 只切只读位，0o600 没有生效')
})

test('win32：写凭据文件必须留下**一条** warn（A2 判据最要紧的一条）', () => {
  const dir = tempDir()
  try {
    // 直接注入 win32：这样本机（macOS）也能验"注入 win32 时会 warn"这条逻辑，
    // 不必等 CI 上真的 Windows 才第一次知道它没写。
    //
    // 刻意**同步**观测 warn 次数，而不是等 `process.on('warning')`：
    // 那条回调是异步派发的，在里面 assert 的话断言发生在测试结束**之后**，
    // 红了也不会计入 —— 那正是"判据自己骗自己"的形状。
    resetSecureFileWarnings()
    const before = secureFileWarnCount()
    writeSecure(path.join(dir, 'state.json'), 'x\n', { platform: 'win32', fsync: false })
    assert.equal(
      secureFileWarnCount() - before,
      1,
      '注入 win32 时必须留下**恰好一条** warn：否则"0600 已生效"这句话在 Windows 上是假的',
    )
    // 第二次写不再重复 warn（否则每 5 秒的周期补写会刷屏）
    writeSecure(path.join(dir, 'state2.json'), 'y\n', { platform: 'win32', fsync: false })
    assert.equal(secureFileWarnCount() - before, 1, '同类 warn 只发一次')
    resetSecureFileWarnings()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('win32 之外不 warn（POSIX 上 chmod 是真生效的，不该制造噪音）', () => {
  const dir = tempDir()
  try {
    resetSecureFileWarnings()
    const before = secureFileWarnCount()
    writeSecure(path.join(dir, 'state.json'), 'x\n', { fsync: false })
    assert.equal(secureFileWarnCount() - before, 0, 'POSIX 上 chmod 真生效，不许 warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('warnOnce：同一个 key 只发一次（否则每 5 秒刷屏）', () => {
  resetSecureFileWarnings()
  assert.equal(warnOnce('k', 'first'), true, '第一次必须发')
  assert.equal(warnOnce('k', 'second'), false, '第二次必须被吞掉')
  resetSecureFileWarnings()
  assert.equal(warnOnce('k', 'third'), true, '闸清掉之后要能重新观测到首次告警')
  resetSecureFileWarnings()
})

test('safeFileName：Windows 保留名（CON / con.txt / COM1）必须被修掉', () => {
  // ⚠️ 这是 v2 的真洞：附件落盘的 safeSegment 只留 [A-Za-z0-9._-]，
  // 完全没拦保留名 —— 症状是 writeFileSync 抛 EINVAL，**整批附件回滚**。
  for (const reserved of ['CON', 'con', 'CON.txt', 'con.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'com9.pdf', 'LPT1']) {
    const fixed = safeFileName(reserved)
    assert.notEqual(fixed, reserved, `${reserved} 是 Windows 保留名，必须改`)
    assert.ok(
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(fixed),
      `${reserved} → ${fixed} 仍然是保留名（扩展名不解除保留）`,
    )
  }
  // 普通名不许被无谓改写（改了会让用户困惑："我明明传的就是这个名字"）
  for (const ok of ['report.pdf', 'photo-1.png', 'a_b.txt', '数据.csv', 'x']) {
    assert.equal(safeFileName(ok), ok.replace(/[^A-Za-z0-9._-]/g, '-'), `${ok} 的修法要最小`)
  }
  // 非法字符（中文、空格）换掉，但**扩展名位置与扩展名本身要保住**
  assert.equal(safeFileName('我的 文件.png'), '-----.png', '「我的 文件」5 个非法字符各换一个 -，扩展名原样')
})

test('反向判据：把保留名检查去掉，上面那条会立刻红', () => {
  // 证明它在测「规则」而不是碰巧全绿
  const bare = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, '-')
  assert.equal(bare('CON'), 'CON', '没有保留名规则时它原样通过 ⇒ 判据确实抓得住这个洞')
  assert.notEqual(safeFileName('CON'), 'CON')
})