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
  ensureSecureDir,
  resetSecureFileWarnings,
  safeFileName,
  secureFileWarnCount,
  warnOnce,
  writeSecure,
} from '../src/platform/secure-file.js'
import { skipUnlessPosix } from './test-platform.js'
import { saveFileAttachments } from '../src/shell/uploads.js'
import { PairStore } from '../src/shell/pair-store.js'
import { writeStoredHostToken } from '../src/shell/claim-token.js'

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

// ⚠️ 这条判据的前提就写在名字里：「**win32 之外**」。在 win32 上 chmod 只切只读位，
//    `writeSecure` **应该** warn —— 断言「0 次 warn」在那里必红。
//    用现成的 `skipUnlessPosix()`：skip 必须带原因，否则 CI 变绿时没人知道它其实没测。
test('win32 之外不 warn（POSIX 上 chmod 是真生效的，不该制造噪音）', skipUnlessPosix(), () => {
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

/**
 * **目录**也走凭据级端口（2026-10-13 第六轮 review 补的一条真缺陷）。
 *
 * ## 那条缺陷
 *
 * 落盘端口把**文件**收成 0600，而三处**敏感目录**都是 `mkdirSync(dir, { recursive: true })`
 * ——不带 `mode` ⇒ 用进程 umask，典型 **0755**：
 * - `~/.dsh/dsh-remote-control/`（会话 id、附件文件名）
 * - 配对密钥簿目录（里面是**每个会话的 PSK**）
 * - 附件目录（用户上传的文件名，本身就说明了内容）
 *
 * 文件内容仍读不到（0600），泄露的是**文件名**；而 umask 宽松时（容器 / 自建服务常见
 * `UMask=0000`）目录会变 0777 ⇒ 别的本地用户能在里面**删/替换**文件。
 *
 * 而 README 的「设计上的三条硬线」第 2 条写着这些**都在**那个 0600 世界里 ⇒ 那句话当时不成立。
 *
 * ## 两条容易写漏的
 *
 * ① `mode` **只在创建那一刻生效**，而 `recursive: true` 遇到已存在的目录直接返回
 *    ⇒ 一条 0755 的**老**目录永远收不紧。必须 `mkdir({mode})` **再** `chmod`（下面第二条判据钉它）。
 * ② win32 上 `chmod` 只切只读位、目录权限语义不存在 ⇒ 那里跳过 chmod，
 *    **不假装生效**（与文件那条 warn 的纪律同源，但目录权限归 ACL 管，不发警告）。
 */
test('POSIX：ensureSecureDir 建出来的目录是 0700', POSIX_ONLY, () => {
  const root = tempDir()
  try {
    const dir = path.join(root, 'nested', 'deeper')
    ensureSecureDir(dir)
    assert.equal(
      statSync(dir).mode & 0o777,
      0o700,
      `目录权限应是 0700，实得 ${(statSync(dir).mode & 0o777).toString(8)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('POSIX：已存在的 0755 老目录会被**收紧**（"mode 只在创建那一刻生效"那个陷阱）', POSIX_ONLY, () => {
  const root = tempDir()
  try {
    const dir = path.join(root, 'legacy')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o755)
    assert.equal(statSync(dir).mode & 0o777, 0o755, '夹具自检：先造成一个 0755 的目录')
    ensureSecureDir(dir)
    assert.equal(
      statSync(dir).mode & 0o777,
      0o700,
      '老目录没收紧 —— 只 mkdir({mode}) 是不够的（已存在的目录不会改权限）',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('POSIX：三个敏感目录的创建点都走了这个端口（父目录 0700，而不只是文件 0600）', POSIX_ONLY, () => {
  // ① 附件目录（README 硬线②点名的"附件目录"）
  const uploadsRoot = tempDir()
  try {
    const saved = saveFileAttachments({
      files: [{ name: 'report.pdf', data: Buffer.from('hello').toString('base64') }],
      dir: uploadsRoot,
      sessionId: 'ses_abc',
    })
    assert.equal(saved.ok, true, `夹具自检：附件应当落盘成功（${saved.ok ? '' : saved.message}）`)
    if (saved.ok) {
      assert.equal(
        statSync(saved.dir).mode & 0o777,
        0o700,
        `附件目录权限应是 0700，实得 ${(statSync(saved.dir).mode & 0o777).toString(8)} —— 别人能列出用户上传的文件名`,
      )
      assert.equal(statSync(saved.saved[0]!.path).mode & 0o777, 0o600, '夹具自检：文件本身仍是 0600')
    }
  } finally {
    rmSync(uploadsRoot, { recursive: true, force: true })
  }

  // ② 配对密钥簿目录（里面是每个会话的 PSK）
  const psRoot = tempDir()
  try {
    const store = new PairStore({ file: path.join(psRoot, 'conversations-h.json'), hostId: 'drc-test' })
    store.save(
      [{ id: 'c_persist_aaaa', psk: 'AgAAAAAAAAAAAAAAAAAAAA==', seqHost: 3, createdAt: 1, lastActivityAt: 2 }],
      1_700_000_000_000,
    )
    assert.equal(
      statSync(psRoot).mode & 0o777,
      0o700,
      `密钥簿目录权限应是 0700，实得 ${(statSync(psRoot).mode & 0o777).toString(8)} —— 别人能列出会话 id`,
    )
  } finally {
    rmSync(psRoot, { recursive: true, force: true })
  }

  // ③ host-token 所在目录（凭据本身）
  const tokenRoot = tempDir()
  try {
    const file = path.join(tokenRoot, 'nested', 'host-token.json')
    assert.equal(
      writeStoredHostToken(file, {
        token: 'a'.repeat(48),
        serverUrl: 'wss://x.invalid',
        source: 'claimed',
        now: 1,
        hostId: 'drc-1',
      }),
      true,
      '夹具自检：令牌应当写成功',
    )
    assert.equal(
      statSync(path.dirname(file)).mode & 0o777,
      0o700,
      `令牌目录权限应是 0700，实得 ${(statSync(path.dirname(file)).mode & 0o777).toString(8)}`,
    )
  } finally {
    rmSync(tokenRoot, { recursive: true, force: true })
  }
})

test('POSIX：属主已收紧过的目录**不许被改动**（0500 只读要仍然是只读）', POSIX_ONLY, () => {
  const root = tempDir()
  try {
    const dir = path.join(root, 'readonly')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o500)
    ensureSecureDir(dir)
    assert.equal(
      statSync(dir).mode & 0o777,
      0o500,
      '插件把运维刻意设的只读目录改成了可写 —— 它不该改一个自己没有设过的权限' +
        '（这条是 pair-store 那条"只读目录要优雅失败"的判据抓出来的）',
    )
  } finally {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})
