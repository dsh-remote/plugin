/**
 * 配对二维码的 `s=` 与主机自己连的地址必须**逐字相同** —— E1 的跨端判据。
 *
 * ## 为什么这件事值得一条判据
 *
 * 手机侧的 `server` **只有**一个来源：扫码解析出来的 `s=`（`sessions.js` 的
 * `server: parsed.server`）。而地址的配置点在**主机侧**的 `serverUrl`。
 * 于是"两处会不会分叉"是个真问题：
 *
 * - 若二维码用 A、主机连 B ⇒ 手机连一个没人监听的地址，表现为「扫码后一直转圈」，
 *   而主机侧 `/status` 显示 `relay: online` —— **两边都"正常"，只有用户看得出不对**；
 * - 若二维码对、主机连错 ⇒ 反过来，配对能成但命令发不出去。
 *
 * 两条路都是**静默**的，所以它必须有判据。
 *
 * ## 这条判据测的是"唯一事实源"
 *
 * 它断言：二维码里的地址**就是** `config.serverUrl` 本身（不是某个变体）。
 * 任何"为了好看再拼一次"的实现（加尾斜杠、转 https、换端口）都会在这里红。
 *
 * ⚠️ 签名按 `packages/protocol/src/identity/pairing.ts` 的真形状写：
 * `buildPairingUri({server, psk, hostLabel?, token?})`、`parsePairingUri` **可返回 null**、
 * `PairingInfo` 里**没有 hostId**（主机身份不进二维码——PSK 就是身份）。我第一版按记忆
 * 写了 `serverUrl` 参数与 `hostId` 字段，编译期三条错——「照记忆抄签名」又栽了一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPairingUri, parsePairingUri } from '@dsh-remote/protocol'
import { DEFAULT_CONFIG, resolvePairStoreFile } from '../src/shell/config.js'

/** 走一遍"主机发码 → 手机解析"，返回手机看到的那份。 */
function whatThePhoneSees(serverUrl: string): NonNullable<ReturnType<typeof parsePairingUri>> {
  const uri = buildPairingUri({ server: serverUrl, psk: 'p'.repeat(44), hostLabel: 'my-host' })
  const parsed = parsePairingUri(uri)
  assert.ok(parsed, `生成的 URI 竟然解析不出来：${uri}`)
  return parsed
}

test('二维码里的 s= 就是 config.serverUrl 本身（逐字，不做任何变形）', () => {
  for (const serverUrl of [
    'ws://127.0.0.1:8787',
    'wss://drc.provid.cc/relay',
    'wss://relay.example.com:8443/relay',
    'ws://[::1]:8787',
  ]) {
    assert.equal(
      whatThePhoneSees(serverUrl).server,
      serverUrl,
      `serverUrl=${serverUrl} ⇒ 二维码里必须是**同一个字符串**。` +
        '变形（加尾斜杠、换协议、换端口）会让手机连到一个主机没在连的地方',
    )
  }
})

test('PSK 与主机展示名原样进去（地址取自配置，其它字段各归各）', () => {
  // 防的是"为了让 s= 对上而重写整条 URI"那种改法：那样会顺手动到 psk。
  const psk = 'p'.repeat(44)
  const parsed = parsePairingUri(buildPairingUri({ server: 'wss://relay.example.com/relay', psk, hostLabel: 'my-host' }))
  assert.ok(parsed)
  assert.equal(parsed.psk, psk, 'PSK 必须原样进去：二维码是密钥唯一的传输路径')
  assert.equal(parsed.hostLabel, 'my-host', '展示名也要原样（它会显示在手机顶部）')
})

test('6 位码进 t= 而不是 s=（两个值的职责不能互换）', () => {
  const parsed = parsePairingUri(
    buildPairingUri({ server: 'wss://x.example.com', psk: 'p'.repeat(44), token: '042915' }),
  )
  assert.ok(parsed)
  assert.equal(parsed.token, '042915', '配对码归 token')
  assert.equal(parsed.server, 'wss://x.example.com', '地址归 server：把它塞进 t= 的话手机会连不上')
})

test('小程序侧没有手填中继地址的入口（配置点唯一 ⇒ 界面上不该有第二处）', () => {
  // E1 的**另一半**：mp 侧能填地址的话，"谁覆盖谁"立刻成为真问题
  // （V3-PLAN 阶段 E 拍板的理由 3）。所以要机械地守住，而不只是写在文档里。
  const here = path.dirname(fileURLToPath(import.meta.url))
  // ⚠️ 这里用 `process.cwd()` 推而不是 `__dirname` 的相对层数：判据跑的是 **dist/tests/**
//   里的编译产物（plugin 的 test 脚本先 build 再 node --test dist/tests/），
//   所以"从源文件数几层 `..`"在产物里会错一层——我为此连栽两次（ENOENT 看着像
//   "实现坏了"，其实是我把源文件的相对路径搬到了产物里）。
//   `pnpm -C packages/plugin test` 的 cwd 就是包根，这一条不含任何猜测。
const pagesRoot = path.join(process.cwd(), '..', 'client', 'pages')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(wxml|js|json)$/.test(entry.name)) files.push(full)
    }
  }
  walk(pagesRoot)
  assert.ok(files.length > 0, `没扫到小程序页面文件：${pagesRoot} 不对？`)

  const offenders: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (/中继服务地址|中继地址|serverUrl/.test(text) && /bindinput|<input/.test(text)) {
      offenders.push(`${path.relative(process.cwd(), file)}（有输入框且提到地址）`)
    }
    if (/填写.{0,8}中继/.test(text)) offenders.push(`${path.relative(process.cwd(), file)}（文案提到"填写中继"）`)
  }
  assert.deepEqual(
    offenders,
    [],
    `小程序侧出现了手填中继地址的第二处入口：${offenders.join('、')}。配置点唯一在 DSH 侧（serverUrl），mp 只从二维码取`,
  )
})

test('resolvePairStoreFile 与二维码路径互不影响（两条路径不共享可变状态）', () => {
  // 防的是"为了修一个而动到另一个"：serverUrl 换了不该影响密钥簿落点。
  const a = { ...DEFAULT_CONFIG, serverUrl: 'ws://127.0.0.1:8787', pairStoreFile: '/tmp/psk-a.json' }
  const b = { ...DEFAULT_CONFIG, serverUrl: 'wss://drc.example.com', pairStoreFile: '/tmp/psk-a.json' }
  assert.equal(
    resolvePairStoreFile(a, 'h_1'),
    resolvePairStoreFile(b, 'h_1'),
    '同一个 pairStoreFile 在两个 serverUrl 下必须解析到同一处：地址与密钥是两件事',
  )
})