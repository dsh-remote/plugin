/**
 * status.test — `shell/status.ts`：status.json（GUI 宿主里唯一的排错入口）。
 *
 * 需求来源：docs/DESIGN.md §7 阶段 C 第 ⑦ 条（"status.json 字段与 0600 原子写"）与
 * docs/legacy-spec/host-plugin-cordis.md §5.3（旧实现靠 `carrier` 与 `relay`+`relayProblem`
 * 两组字段区分了两类完全不同的故障）。
 *
 * 三条要守的东西：
 * 1. **0600 + 临时文件改名**——文件里可能出现"仍然有效的配对码 + PSK"（pairOnStartSec），
 *    半写状态被读到会误判，权限松了就是凭据泄露（M19/N19）。
 * 2. **绝不含 token 真值**——只允许 `redact()` 之后的形态出现。
 * 3. **写失败不许影响主流程**——排错入口没了是遗憾，插件崩了是事故。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StatusFile } from '../src/shell/status.js'
import { DEFAULT_SYSTEM_CLOCK, FakeClock } from '../src/core/clock.js'
import { redact } from '../src/shell/config.js'

/** 一眼假的 token：仓库里不许出现任何真凭据，这条只验形状。 */
const FAKE_TOKEN = 'fake-token-not-a-real-secret-0123456789abcdef'

function tempDir(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-status-'))
  const file = path.join(dir, 'status.json')
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const modeOf = (file: string): string => (statSync(file).mode & 0o777).toString(8)

test('快照以 0600 落盘：里面可能出现仍然有效的配对码与 PSK', () => {
  const { file, cleanup } = tempDir()
  try {
    new StatusFile(file, DEFAULT_SYSTEM_CLOCK).write({ carrier: 'services', relay: 'online', conversations: 1 })
    assert.equal(modeOf(file), '600', `实际权限 ${modeOf(file)}：同机其它用户能读走配对码，等于配对被偷`)
    assert.equal(existsTmp(file), false, '写完必须把临时文件改名走，不许留下 .tmp-*')
  } finally {
    cleanup()
  }
})

test('原子替换：内容永远是一份完整 JSON，读的人不会看到半写的快照', () => {
  const { dir, file, cleanup } = tempDir()
  try {
    const status = new StatusFile(file, DEFAULT_SYSTEM_CLOCK)
    status.write({ carrier: 'services', relay: 'online', conversations: 1 })
    status.write({ carrier: 'services', relay: 'offline', conversations: 0, relayProblem: '连接关闭 1006' })
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text) as Record<string, unknown>
    assert.equal(parsed.relay, 'offline', '第二次写没覆盖掉第一次的：外部脚本会读到已经消失的故障')
    assert.equal(text.endsWith('\n'), true, '末尾留一个换行：tail/cat 与 diff 都不会打出无主字符')
    assert.equal(
      readdirSync(dir).filter((name) => name.includes('.tmp-')).length,
      0,
      '目录里残留了临时文件：说明 rename 之前崩过或改名没做',
    )
    assert.equal(
      typeof parsed.updatedAt,
      'string',
      'updatedAt 必须在：这是"快照多旧"的唯一判据（外部脚本靠年龄<25s 接受配对码）',
    )
    assert.equal(
      Number.isNaN(Date.parse(String(parsed.updatedAt))),
      false,
      'updatedAt 必须是 Date.parse 认得出的字符串',
    )
    assert.equal(typeof parsed.pid, 'number', 'pid 要在：区分两个宿主进程抢同一个 status.json 时靠它')
  } finally {
    cleanup()
  }
})

test('快照里不得出现 token 真值：只能出现 redact() 之后的形态', () => {
  const { file, cleanup } = tempDir()
  try {
    // 复刻 index.ts 的 state() 形状：hostToken 恒为 undefined，真值只以脱敏形态出现。
    new StatusFile(file, DEFAULT_SYSTEM_CLOCK).write({
      carrier: 'services',
      serverUrl: 'wss://drc.example.com',
      hostToken: undefined,
      hostTokenShape: redact(FAKE_TOKEN),
      token: undefined,
      psk: undefined,
    })
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text) as Record<string, unknown>
    assert.equal(parsed.hostToken, undefined, 'status.json 里带着 hostToken 真值：这个文件是被设计成"随时贴进工单"的')
    assert.equal(text.includes(FAKE_TOKEN), false, '整条 token 出现在文件里')
    assert.equal(text.includes('not-a-real-secret'), false, 'token 的中段出现在文件里')
    assert.equal(typeof parsed.hostTokenShape, 'string', '脱敏形态必须留着：排错时要靠长度判断是不是拿错了变量')
    assert.equal(String(parsed.hostTokenShape).length < FAKE_TOKEN.length, true, '脱敏后的字符串必须明显短于原值')
  } finally {
    cleanup()
  }
})

test('statusFile 为空字符串就是关闭整个功能：不建文件、不装定时器、绝不抛', () => {
  const { dir, cleanup } = tempDir()
  try {
    const clock = new FakeClock()
    const status = new StatusFile('', clock, 1_000)
    assert.doesNotThrow(
      () => status.write({ carrier: 'services' }),
      '关闭状态下 write 抛了出去 → 主流程被一个可选项带崩',
    )
    let refreshed = 0
    assert.doesNotThrow(() =>
      status.start(() => {
        refreshed += 1
        return {}
      }),
    )
    assert.equal(clock.pending, 0, '关闭状态下不许装刷新定时器')
    return void clock.advance(10_000).then(() => {
      assert.equal(refreshed, 0, '关闭状态下定时器还在刷新快照')
      assert.equal(readdirSync(dir).length, 0, '关闭状态下仍然往目录里写了东西')
    })
  } finally {
    // 断言在 promise 里，cleanup 必须等它落定
    void cleanup
  }
})

test('写失败（目录不可写）不许影响主流程：排错入口没了是遗憾，插件崩了是事故', () => {
  const { dir, cleanup } = tempDir()
  try {
    const readonly = path.join(dir, 'locked')
    mkdirSync(readonly, { mode: 0o500 })
    const status = new StatusFile(path.join(readonly, 'nested', 'status.json'), DEFAULT_SYSTEM_CLOCK)
    assert.doesNotThrow(
      () => status.write({ carrier: 'services' }),
      `目录不可写时把异常抛了出去（chmod=${modeOf(readonly)}）`,
    )
    assert.equal(existsTmp(path.join(readonly, 'status.json')), false, '失败后不许留下半成品')

    // 另一种失败形状：父路径是个普通文件，mkdirSync 直接 ENOTDIR。
    const notADir = path.join(dir, 'afile')
    writeFileSync(notADir, 'x')
    assert.doesNotThrow(
      () => new StatusFile(path.join(notADir, 'status.json'), DEFAULT_SYSTEM_CLOCK).write({ carrier: 'mock' }),
      'ENOTDIR 抛了出去',
    )
  } finally {
    chmodSync(path.join(dir, 'locked'), 0o700)
    cleanup()
  }
})

test('定时刷新的节拍、自我续期与"真的落盘"：status.json 是外部脚本取配对码的唯一入口', async () => {
  const { file, cleanup } = tempDir()
  try {
    const clock = new FakeClock()
    const status = new StatusFile(file, clock, 3_000)
    let built = 0
    // 调用方给的必须是**纯构造器**：只返回状态，写盘由 StatusFile 负责。
    // 第一版写成"tick 里调 refresh() 把返回值丢掉"，于是文件永远停在启动那一版，
    // 而 live-e2e 判配对码是否新鲜读的就是这个文件（取证 §5.3 的"年龄 < 25s"）。
    status.start(() => {
      built += 1
      return { carrier: 'services', conversations: built }
    })
    assert.equal(built, 0, 'start() 只装定时器，不该同步抢跑一次')

    await clock.advance(3_000)
    assert.ok(built >= 1, `等了 3 秒一次都没刷新（built=${built}）：status.json 会永远停在启动那一版`)
    await clock.advance(9_000)
    assert.ok(built >= 4, `12 秒里只刷新了 ${built} 次：定时器没有自我续期`)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(parsed.conversations, built, '刷新写进去的必须是最新一次构建的快照')
    assert.equal(
      typeof parsed.updatedAt,
      'string',
      '每一版都要带 updatedAt：外部脚本靠"年龄 < 25s"决定能不能用这张码（§5.3）',
    )

    // 再走一拍：文件内容必须跟着变（只看 built 会放过"构造器跑了但没写盘"这个 bug）。
    await clock.advance(3_000)
    const again = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(
      again.conversations,
      built,
      `文件停在 ${String(parsed.conversations)}，构造器已经跑到 ${built}：tick 没有落盘`,
    )

    status.stop()
    const pendingAfterStop = clock.pending
    await clock.advance(30_000)
    assert.equal(
      pendingAfterStop,
      0,
      `stop() 之后还剩 ${pendingAfterStop} 个定时器：宿主是用户的内核进程，插件不能让它赖着不退`,
    )
    assert.equal(built >= 5, true, '夹具自检：停机前刷新次数要有下界')
  } finally {
    cleanup()
  }
})

test('start() 重复调用不许叠出第二份定时器（刷新频率翻倍会把文件写坏）', async () => {
  const { file, cleanup } = tempDir()
  try {
    const clock = new FakeClock()
    const status = new StatusFile(file, clock, 1_000)
    let built = 0
    const refresh = (): Record<string, unknown> => {
      built += 1
      return { n: built }
    }
    status.start(refresh)
    status.start(refresh)
    status.start(refresh)
    assert.equal(clock.pending, 1, `装了 ${clock.pending} 个定时器：重复 start() 必须幂等`)
    await clock.advance(1_000)
    assert.equal(built, 1, `一次 tick 刷新了 ${built} 次`)
    status.stop()
  } finally {
    cleanup()
  }
})

test('嵌套字段（pairing / keepAwake / kernel）必须原样落地：那是区分两类故障的判据', () => {
  const { file, cleanup } = tempDir()
  try {
    new StatusFile(file, DEFAULT_SYSTEM_CLOCK).write({
      carrier: 'services',
      relay: 'online',
      pairing: { token: '123456', expiresAt: '2026-10-02T08:00:00.000Z', ageSec: 12 },
      keepAwake: { enabled: true, active: false, platform: 'darwin', backend: 'caffeinate' },
      kernel: { listingSource: 'attached only', hiddenSubagents: 1 },
      problems: ['warn:pairOnStartSec'],
      nothingHere: null,
    })
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
    assert.equal(parsed.pairing.token, '123456', 'pairing 结构丢了：CLI/e2e 就没法取码（status.json 是唯一的广播介质）')
    assert.equal(parsed.keepAwake.active, false, 'keepAwake.active 必须如实：它表示"此刻是否正在阻止休眠"')
    assert.equal(
      parsed.kernel.hiddenSubagents,
      1,
      'kernel.describe() 的诊断要能进快照："适配器静默返回 []"与"真的没有会话"必须可区分（M27）',
    )
    assert.deepEqual(parsed.problems, ['warn:pairOnStartSec'], '配置问题列表要在，否则"为什么什么都没发生"没有答案')
    assert.equal('nothingHere' in parsed, true, 'null 字段必须保留（undefined 会被 JSON 丢掉，这是调用方的选择）')
  } finally {
    cleanup()
  }
})

/** 目标路径的临时兄弟文件是否存在（用于"失败后不许留半成品"）。 */
function existsTmp(file: string): boolean {
  try {
    return statSync(`${file}.tmp-${process.pid}`).isFile()
  } catch {
    return false
  }
}

test('写盘前要再 chmod 一次：tmp 残留/pid 复用不许让新快照沿用旧权限', () => {
  // 现场：tmp 名里只有 pid，上一次同 pid 的进程留下的残留（或 pid 被复用后的旧文件）
  // 可能带着更宽的权限，而 writeFileSync 的 mode 只在**创建**时生效——直接改名就把宽权限
  // 带给了正式文件，而 status.json 里可能有仍然有效的配对码 + PSK（pairOnStartSec）。
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-status-mode-'))
  const file = path.join(dir, 'status.json')
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, '{"stale":true}', { mode: 0o644 })
  chmodSync(tmp, 0o644)
  try {
    const status = new StatusFile(file, DEFAULT_SYSTEM_CLOCK)
    status.write({ carrier: 'services' })
    assert.equal(
      statSync(file).mode & 0o777,
      0o600,
      `status.json 的权限是 ${(statSync(file).mode & 0o777).toString(8)}：里面可能有 PSK`,
    )
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).carrier, 'services', '夹具自检：内容确实被新快照覆盖了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
