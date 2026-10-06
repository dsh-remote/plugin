/**
 * deploy-sync.test — 伞仓 `deploy/` 与中继仓 `deploy/` 的**逐字节一致**判据。
 *
 * ## 为什么这两个目录要有两份
 *
 * 中继仓（开源、可被别人独立部署）需要一份 `deploy/`；伞仓的 `deploy/` 是**生产实例**
 * 的取用入口——照伞仓那份 scp 就得到线上跑着的那台机。这两份现在是同一份内容，
 * 而"HANDOFF §0.1 踩过的那个坑"（`ProtectSystem=strict` 少了 `StateDirectory`，
 * 照旧那份部署会让状态文件每 5 秒 EROFS 一次，而配对**表面看着完全正常**）
 * 正是两份各改各的会招致的后果。
 *
 * ## 为什么必须有判据
 *
 * 因为它们是纯文本配置文件，没有任何构建步骤让它们保持一致，也没有 CI 会碰伞仓
 * （伞仓没有 remote，`e2e/` 需要四棵平行仓在场，GitHub 上拿不到）。也就是说：
 * 改了一份忘了另一份，**没有任何东西会响**，直到某次照着旧的那份上线为止。
 *
 * 这条判据是纯文本比对，没有运行时依赖，也不需要真服务器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UMBRELLA = join(ROOT, 'deploy')
const SERVER = join(ROOT, 'dsh-remote-server', 'deploy')

/** 逐字节比对的清单。nginx 与 systemd 两份都必须对齐。 */
const FILES = ['nginx/drc.conf', 'systemd/dsh-remote-control.service']

test('四棵平行仓在场（这条判据的前提）', () => {
  // 不在就**跳过**而不是假装通过：伞仓单独 clone 时这条判据无意义，红掉只会让人以为
  // 部署文件分叉了。`pnpm -r test` 只在四仓在场时才会跑到这里。
  assert.ok(existsSync(SERVER), `找不到 ${SERVER}：e2e 需要四棵平行仓（伞仓 README「快速开始」）`)
})

for (const rel of FILES) {
  test(`deploy/${rel} 与中继仓的那份逐字节一致`, () => {
    if (!existsSync(SERVER)) return
    const mine = join(UMBRELLA, rel)
    const theirs = join(SERVER, rel)
    assert.ok(existsSync(mine), `伞仓缺 deploy/${rel}`)
    assert.ok(existsSync(theirs), `中继仓缺 deploy/${rel}`)
    const a = readFileSync(mine, 'utf8')
    const b = readFileSync(theirs, 'utf8')
    assert.equal(
      a,
      b,
      `deploy/${rel} 两份分叉了。` +
        '改完一份必须把另一份一起改（HANDOFF §0.1：少一个 StateDirectory 就是' +
        '"功能看着正常、其实永远没落盘"，而且 systemd 的报错在 journal 里、' +
        'systemctl status 上看不出来）。',
    )
  })
}

test('两份 systemd 单元都带 StateDirectory（EROFS 那次的直接教训）', () => {
  if (!existsSync(SERVER)) return
  for (const base of [UMBRELLA, SERVER]) {
    const unit = readFileSync(join(base, 'systemd/dsh-remote-control.service'), 'utf8')
    assert.match(
      unit,
      /^StateDirectory=dsh-remote-control$/m,
      `${base}/systemd 单元缺 StateDirectory：ProtectSystem=strict 会让 DRC_STATE_FILE 每 5 秒 EROFS 一次（` +
        '配对表面正常、其实从不落盘；换台机器部署照这份做就会重演 §0.1）',
    )
    // 反过来也不能用 ReadWritePaths=/var/lib 顶替：那会把整个 /var/lib 放开。
    assert.doesNotMatch(
      unit,
      /^ReadWritePaths=\/var\/lib/m,
      `${base}/systemd 单元用 ReadWritePaths=/var/lib 顶替了 StateDirectory：范围大得多`,
    )
  }
})

test('ExecStart 指向单文件产物，不是已删除的 src/main.mjs（docs/DESIGN-REVIEW R4）', () => {
  if (!existsSync(SERVER)) return
  for (const base of [UMBRELLA, SERVER]) {
    const unit = readFileSync(join(base, 'systemd/dsh-remote-control.service'), 'utf8')
    // 只看 ExecStart 那一行：单元**注释**里本来就该留着 "the old unit ran src/main.mjs"
    // 这句迁移说明，全文匹配会把那段正确的注释判成故障。
    const execStart = /^ExecStart=.*$/m.exec(unit)?.[0] ?? ''
    assert.ok(execStart, `${base} 的单元没有 ExecStart`)
    assert.match(execStart, /relay\.mjs$/, `${base} 的 ExecStart 必须指向 dist/bundle/main.js 那一份单文件`)
    assert.doesNotMatch(execStart, /src\/main\.mjs/, `${base} 的 ExecStart 指向了早已不存在的 src/main.mjs`)
    // dist/src/main.js 是"没打单文件"的形态：它要靠 devDependencies 解析协议层，
    // 生产 `--omit=dev` 下必炸，所以也不能是它。
    assert.doesNotMatch(execStart, /dist\/src\/main\.js/, `${base} 的 ExecStart 指向了需要 devDependencies 的未打包产物`)
  }
})

test('nginx 反代保留三个反代头（真机取证与限流都依赖它们）', () => {
  if (!existsSync(SERVER)) return
  const conf = readFileSync(join(UMBRELLA, 'nginx/drc.conf'), 'utf8')
  for (const header of ['Upgrade', 'Connection', 'Host']) {
    assert.match(
      conf,
      new RegExp(`proxy_set_header\\s+${header}\\s`),
      `nginx 少了 proxy_set_header ${header}：WebSocket 升级会失败或后端拿不到真实 host`,
    )
  }
  // 长连接不能被反代掐断：60s 默认值会在一条安静的长会话中间把 socket 关掉。
  assert.match(conf, /proxy_read_timeout\s+3600s/, 'proxy_read_timeout 必须是 3600s，否则安静的长会话会被反代掐断')
})

test('deploy/ 下没有多出来的文件（两份目录只该各维护那几个）', () => {
  if (!existsSync(SERVER)) return
  for (const base of [UMBRELLA, SERVER]) {
    const found = []
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(join(dir, entry.name), rel)
        else found.push(rel)
      }
    }
    walk(base, '')
    const extra = found.filter((rel) => !FILES.includes(rel) && rel !== 'README.md').sort()
    assert.deepEqual(
      extra,
      [],
      `${base} 下多出 ${extra.join(', ')}：deploy-sync 这条判据的清单要一起更新，否则它就漏检了`,
    )
  }
})