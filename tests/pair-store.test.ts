/**
 * pair-store.test — `shell/pair-store.ts`：配对通道密钥簿的落盘。
 *
 * 这个文件里躺着**全部历史会话的 PSK**，而它存在的唯一目的是让主机重启后不必重新扫码。
 * 因此要钉住的判据分两类：
 *
 * 1. **可用**：写得进、读得回、格式对。读不出来时必须**降级成空簿而不是抛**——
 *    `index.ts` 的红线是 apply() 不许向外抛，插件起不来比丢配对更糟。
 * 2. **不扩大攻击面**：0600、原子写（不留半写文件）、文件名收窄到目录内、跨主机身份不认。
 *
 * 注意这里**不测**"重连后手机能不能续上"——那是链路层的事，见
 * `relay-client.test.ts` 与 e2e 的 `restart-resume.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PairStore, defaultPairStoreFile, type StoredConversation } from '../src/shell/pair-store.js'
import { resolvePairStoreFile, DEFAULT_CONFIG } from '../src/shell/config.js'

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-pairstore-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const modeOf = (file: string): string => (statSync(file).mode & 0o777).toString(8)

const SAMPLE: StoredConversation = {
  id: 'c_persist_aaaa',
  psk: 'AgAAAAAAAAAAAAAAAAAAAA==',
  seqHost: 3,
  createdAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_060_000,
}

test('save → load 原样读回：这就是免扫码重连的全部持久化面', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'conversations.json')
    const store = new PairStore({ file, hostId: 'drc-test' })
    assert.deepEqual(store.load(), [], '夹具自检：文件还不存在时必须是空簿而不是抛')

    assert.equal(store.save([SAMPLE], 1_700_000_999_000), true, '写盘失败了：配对后主机一重启就要重新扫码')
    assert.deepEqual(store.load(), [SAMPLE], '读回来的记录与写进去的不一致：至少有一项没被持久化')
  } finally {
    cleanup()
  }
})

test('写出来的文件是 0600：里面是全部历史会话的 PSK，与 status.json 同一目录', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'conversations.json')
    new PairStore({ file, hostId: 'drc-test' }).save([SAMPLE], 1)
    assert.equal(modeOf(file), '600', `权限是 ${modeOf(file)}：这个目录里同时住着仍然有效的配对码与 PSK`)
  } finally {
    cleanup()
  }
})

test('重复写同一个文件不会把权限放松：mode 只在创建时生效，必须每次补 chmod', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'conversations.json')
    const store = new PairStore({ file, hostId: 'drc-test' })
    store.save([SAMPLE], 1)
    // 模拟"有人把这文件复制成 0644"（备份恢复、rsync、或者用户手欠）。
    chmodSync(file, 0o644)
    store.save([SAMPLE], 2)
    assert.equal(modeOf(file), '600', `权限被留在 ${modeOf(file)}：覆盖写不会收紧已有权限，这个文件得每次补 chmod`)
  } finally {
    cleanup()
  }
})

test('原子写：临时文件被 rename 掉，目录里不留残骸', () => {
  const { dir, cleanup } = tempDir()
  try {
    const store = new PairStore({ file: path.join(dir, 'conversations.json'), hostId: 'drc-test' })
    store.save([SAMPLE], 1)
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [], `目录里留下了 ${JSON.stringify(leftovers)}：临时文件没被 rename 走`)
  } finally {
    cleanup()
  }
})

test('目录不存在时自己建：GUI 宿主首次启动时那个目录可能还没有', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'nested', 'deep', 'conversations.json')
    assert.equal(new PairStore({ file, hostId: 'drc-test' }).save([SAMPLE], 1), true, '建目录失败就放弃了')
    assert.equal(new PairStore({ file, hostId: 'drc-test' }).load().length, 1, '建完之后读不回来')
  } finally {
    cleanup()
  }
})

test('写不进（目录是只读文件）时 save 返回 false 而不抛：插件起不来比丢配对更糟', () => {
  const { dir, cleanup } = tempDir()
  try {
    const locked = path.join(dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    const store = new PairStore({ file: path.join(locked, 'conversations.json'), hostId: 'drc-test' })
    assert.equal(store.save([SAMPLE], 1), false, '写不进却报告成功：status.json 会显示一个从没落过盘的路径')
  } finally {
    chmodSync(path.join(dir, 'locked'), 0o700)
    cleanup()
  }
})

test('JSON 坏了 / 形状不认识 / 版本不对：三种都降级成空簿并留日志', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'conversations.json')
    const cases: Array<[string, string]> = [
      ['半写', '{"version":1,"hostId":"drc-test","conversations":[{"id":"c_a","psk"'],
      ['不是 JSON', 'conversations: none'],
      ['版本不对', JSON.stringify({ version: 99, hostId: 'drc-test', savedAt: 1, conversations: [] })],
      ['缺字段', JSON.stringify({ version: 1, hostId: 'drc-test', savedAt: 1, conversations: [{ id: 'c_a' }] })],
    ]
    for (const [label, body] of cases) {
      writeFileSync(file, body, { mode: 0o600 })
      const logs: string[] = []
      const records = new PairStore({ file, hostId: 'drc-test', log: (m) => logs.push(m) }).load()
      assert.deepEqual(records, [], `${label} 这一档读出了 ${JSON.stringify(records)}：半份记录会造出解不开的会话`)
      assert.ok(
        logs.some((line) => line.includes('pair-store')),
        `${label} 这一档没有留下任何记录：读不出来与"落盘没生效"在 status.json 里长得一模一样，必须能分开`,
      )
    }
  } finally {
    cleanup()
  }
})

test('hostId 不匹配时不当成自己的簿：凭据不该跨身份复用', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'conversations.json')
    new PairStore({ file, hostId: 'drc-machine-a' }).save([SAMPLE], 1)
    const other = new PairStore({ file, hostId: 'drc-machine-b', log: () => {} }).load()
    assert.deepEqual(other, [], '换了一台主机身份却把上一台的会话捡了起来')
    assert.deepEqual(
      new PairStore({ file, hostId: 'drc-machine-a' }).load(),
      [SAMPLE],
      '夹具自检：同一身份仍要读得回来',
    )
  } finally {
    cleanup()
  }
})

test('markDirty 只标脏不写盘：高频变动（每次广播动 seqHost）不能变成每十几秒一次写盘', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'conversations.json')
    const store = new PairStore({ file, hostId: 'drc-test' })
    store.save([SAMPLE], 1)
    assert.equal(store.hasPendingChanges, false, '刚写完还是脏的：status 的 3 秒 tick 会变成无条件写盘的心跳')

    store.markDirty()
    assert.equal(store.hasPendingChanges, true, '标了脏却没被记下：那几秒的 seqHost/lastActivityAt 就随进程没了')
    assert.equal(
      JSON.parse(readFileSync(file, 'utf8')).savedAt,
      1,
      'markDirty 竟然写了盘：插件在 GUI 宿主里可能连开好几天，这会变成一次十几秒一次的心跳写盘',
    )
    store.save([SAMPLE], 2)
    assert.equal(store.hasPendingChanges, false, 'save 之后仍然是脏的：下一轮 tick 会白写一次')
  } finally {
    cleanup()
  }
})

test('默认路径跟着 status.json 走，且文件名带 hostId 片段', () => {
  const file = defaultPairStoreFile('/tmp/x/status.json', 'drc-abc123')
  assert.equal(path.dirname(file), '/tmp/x', '没跟 status.json 同目录：换目录后旧那份文件成了孤儿密钥')
  assert.match(path.basename(file), /^conversations-drc-abc123-[0-9a-f]{8}\.json$/, `实际是 ${path.basename(file)}`)
})

test('hostId 里的路径分隔符不许把文件写到目录外面去', () => {
  // hostId 由配置给，不经 host-id.ts 那道正则——这里就是那道防线要生效的地方。
  const escaped = defaultPairStoreFile('/tmp/x/status.json', '../../etc/evil')
  assert.equal(path.dirname(escaped), '/tmp/x', `落点跑到 ${escaped} 的目录去了：一个含 "/" 的 hostId 就能写到任意路径`)
})

test('收窄后的名字仍要为不同 hostId 分开：a/b 与 a_b 不能共用一份文件', () => {
  const one = defaultPairStoreFile('/tmp/x/status.json', 'a/b')
  const two = defaultPairStoreFile('/tmp/x/status.json', 'a_b')
  assert.notEqual(one, two, '两个不同的 hostId 撞到同一个文件名：其中一台会把另一台的会话簿覆盖掉')
})

test('resolvePairStoreFile：默认自动、off 关掉、相对路径按 statusFile 目录解析', () => {
  const base = { ...DEFAULT_CONFIG, statusFile: '/tmp/x/status.json' }
  assert.equal(
    resolvePairStoreFile(base, 'drc-a'),
    defaultPairStoreFile('/tmp/x/status.json', 'drc-a'),
    '默认必须是"跟着 status.json 走"：用户只配了 statusFile 就能得到免扫码重连',
  )
  assert.equal(resolvePairStoreFile({ ...base, pairStoreFile: 'off' }, 'drc-a'), '', 'off 没有关掉落盘')
  assert.equal(
    resolvePairStoreFile({ ...base, pairStoreFile: 'sub/x.json' }, 'drc-a'),
    '/tmp/x/sub/x.json',
    '相对路径没有按 statusFile 目录解析',
  )
  assert.equal(
    resolvePairStoreFile({ ...base, pairStoreFile: '/var/lib/drc/keys.json' }, 'drc-a'),
    '/var/lib/drc/keys.json',
    '绝对路径被改道了：那是用户明确指定的位置',
  )
})

test('落盘文件不进版本库：它带 PSK，而测试用的工作目录可能就在仓库里', () => {
  // 真机上落点在 ~/.dsh 下（不进任何仓库）；这条守的是"测试与脚本别把它提交进去"。
  // 四级：dist/tests → dist → packages/plugin → packages → **仓库根**。
  // 用 `import.meta.url` 而不是 `__dirname`：本包是 ESM，`__dirname` 在这里根本不存在。
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
  const ignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
  assert.match(
    ignore,
    /conversations-\*/,
    '.gitignore 没有覆盖 conversations-*.json：这份文件含全部会话的 PSK，被提交出去等于把整台主机的历史密文密钥公开',
  )
})

/* ── 2026-10-06 缺陷修复：结构性 save 失败之后不许把脏标记复位 ───────────── */

test('save 失败之后必须仍然算脏：新配对的 PSK 不许静默不落盘且永不重试', () => {
  const { dir, cleanup } = tempDir()
  try {
    // 目录名先被一个普通文件占着：mkdirSync(dirname) 必失败（ENOTDIR）。
    const blocker = path.join(dir, 'blocked')
    writeFileSync(blocker, 'not a directory')
    const file = path.join(blocker, 'conversations.json')
    const store = new PairStore({ file, hostId: 'h_test' })
    assert.equal(store.save([SAMPLE], 1), false, '夹具自检：写盘必须失败')
    assert.equal(
      store.hasPendingChanges,
      true,
      '失败之后 dirty 被复位成 false：status 的 3 秒 tick 看到"没脏"就再也不重试，新配对的 PSK 静默不落盘',
    )

    // 路径恢复可写之后，下一次 save 必须能成功、并把脏标记清掉。
    rmSync(blocker)
    assert.equal(store.save([SAMPLE], 2), true, '路径恢复之后仍然写不进去')
    assert.equal(store.hasPendingChanges, false, '成功之后还不清脏：每个 tick 都会白写一次盘')
  } finally {
    cleanup()
  }
})
