/**
 * host-id.test — `shell/host-id.ts`：主机身份要**跨重启稳定**。
 *
 * 需求来源：HANDOFF §3.4 的真机取证——`config.hostId` 空时旧写法每次加载现造一个
 * `h_<3字节>`，5 分钟内出现三个身份，中继每次都报 `replaced:0`（顶不掉旧 socket），
 * 手机连的会话因此指向"没有钥匙的对端"，`droppedFrames` 一直涨。
 * 所以这里守的不是"名字好不好看"，是**同一个人在同一台机器上不许换身份**。
 *
 * 四条要钉住的判据：配置优先、落盘 0600、已存在的值绝不改写、任何 IO 失败都退回一次性值而不抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { newHostId, resolveHostId } from '../src/shell/host-id.js'

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-hostid-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const modeOf = (file: string): string => (statSync(file).mode & 0o777).toString(8)
const fileOf = (dir: string): string => path.join(dir, 'host-id')

test('配置给了 hostId 就用配置的：既不读文件也不写文件（配置是权威）', () => {
  const { dir, cleanup } = tempDir()
  try {
    assert.equal(resolveHostId(dir, 'drc-bins-macbook'), 'drc-bins-macbook')
    assert.equal(statExists(fileOf(dir)), false, '配置已经定了身份，还落盘就是凭空多写一个文件')
  } finally {
    cleanup()
  }
})

test('第一次加载造一个 drc-<hex> 并以 0600 落盘', () => {
  const { dir, cleanup } = tempDir()
  try {
    const id = resolveHostId(dir, '')
    assert.match(id, /^drc-[0-9a-f]{12}$/, `实际是 ${id}：前缀与形状要能在中继日志里一眼认出来`)
    assert.equal(readFileSync(fileOf(dir), 'utf8').trim(), id, '落盘的值必须就是返回的值')
    assert.equal(modeOf(fileOf(dir)), '600', `实际权限 ${modeOf(fileOf(dir))}：这个目录里同时住着配对凭据`)
  } finally {
    cleanup()
  }
})

/**
 * 这一条就是整件事的目的。旧写法在这里会返回**另一个**值——真机上那三个 hostId
 * 就是这么来的，而每一次换身份都会让中继上那条旧 socket 变成"顶不掉的幽灵"。
 */
test('第二次加载（=重启）必须拿回同一个身份，且磁盘上那个文件一个字都不许被改写', () => {
  const { dir, cleanup } = tempDir()
  try {
    const first = resolveHostId(dir, '')
    const bytesBefore = readFileSync(fileOf(dir))
    for (let round = 0; round < 3; round++) {
      assert.equal(resolveHostId(dir, ''), first, `第 ${round + 2} 次加载换了身份：中继会顶不掉旧 socket`)
    }
    assert.equal(readFileSync(fileOf(dir)).equals(bytesBefore), true, '已存在的身份被改写了')
  } finally {
    cleanup()
  }
})

test('升级前那种旧身份（h_xxxx）读到了就继续用，不许借机换号', () => {
  const { dir, cleanup } = tempDir()
  try {
    writeFileSync(fileOf(dir), 'h_c2073b\n', { mode: 0o600 })
    assert.equal(resolveHostId(dir, ''), 'h_c2073b', '老用户已经以这个身份配过对，换号等于把他踢下线')
  } finally {
    cleanup()
  }
})

test('文件里是不认的形状（被人手改坏 / 半写）→ 现造一个并修好，不抛', () => {
  const { dir, cleanup } = tempDir()
  try {
    for (const junk of ['', '   ', '../../etc/passwd', 'x'.repeat(200), '有中文的身份']) {
      writeFileSync(fileOf(dir), junk, { mode: 0o600 })
      const id = resolveHostId(dir, '')
      assert.match(id, /^drc-[0-9a-f]{12}$/, `不认的形状 ${JSON.stringify(junk.slice(0, 16))} 没被换掉`)
      assert.equal(readFileSync(fileOf(dir)).toString().trim(), id, '修好的值要落回去，否则下次还是坏的')
    }
  } finally {
    cleanup()
  }
})

test('目录不可写时退回一次性身份：这一轮不稳定，但插件必须照常起', () => {
  const { dir, cleanup } = tempDir()
  try {
    const locked = path.join(dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    try {
      const id = resolveHostId(locked, '')
      assert.match(id, /^drc-[0-9a-f]{12}$/, `写不进去时也要给一个能用的身份，实际是 ${id}`)
      assert.equal(statExists(path.join(locked, 'host-id')), false)
    } finally {
      chmodSync(locked, 0o700)
    }
  } finally {
    cleanup()
  }
})

test('statusFile 被关掉（空串）时调用方传空目录：不去猜 CWD，直接一次性身份', () => {
  assert.match(resolveHostId('', ''), /^drc-[0-9a-f]{12}$/)
})

test('两个实例抢同一目录：只有一个身份胜出，后写的那个读到谁的就用谁的', () => {
  const { dir, cleanup } = tempDir()
  try {
    const winner = resolveHostId(dir, '')
    // 第二个实例的 'wx' 会失败（文件已在），它必须回头读那个文件而不是抛
    assert.equal(resolveHostId(dir, ''), winner, '并发下第二个实例改写了身份：两台"同一台主机"会互相顶号')
  } finally {
    cleanup()
  }
})

test('newHostId 每次都不一样（它只负责"造"，稳不稳是 resolveHostId 的事）', () => {
  assert.notEqual(newHostId(), newHostId())
})

function statExists(file: string): boolean {
  try {
    statSync(file)
    return true
  } catch {
    return false
  }
}
