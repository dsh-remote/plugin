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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
  const parsed = parsePairingUri(
    buildPairingUri({ server: 'wss://relay.example.com/relay', psk, hostLabel: 'my-host' }),
  )
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

/**
 * 剥掉注释，只留代码。
 *
 * ⚠️ 为什么必须剥：**这条判据被注释绊倒过两次**。
 *   `sessions.wxml` 里有一段写给下个读者的说明：「⚠️ 它**不是**中继地址的配置入口
 *   —— 那个在 DSH 主机侧」，而同一个文件里本来就有合法的配对码 `<input>`。
 *   不剥注释 ⇒「注释里提到地址」+「正文里有 input」⇒ 判据红在一个完全合规的文件上。
 *   （`settings` 页那条判据是同一个坑：注释里反复写"不出现 server"，2026-10-08。）
 *   **注释是写给人的，不是给机器判的 —— 判据要看代码，不看注释。**
 *
 * `//` 那条用 `(^|[^:])` 挡住 `wss://` 之类的协议头里的双斜杠，否则会把 URL 后半
 * 整行吃掉，反而漏掉真正的违规。
 */
function stripComments(text: string, ext: string): string {
  if (ext === '.wxml') return text.replace(/<!--[\s\S]*?-->/g, '')
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 一段**已剥注释**的源码里有没有「手填中继地址」的入口。抽出来是为了让反向判据能喂样本。 */
function hasManualRelayEntry(code: string): boolean {
  if (/中继服务地址|中继地址|serverUrl/.test(code) && /bindinput|<input/.test(code)) return true
  if (/填写.{0,8}中继/.test(code)) return true
  return false
}

test('小程序侧没有手填中继地址的入口（配置点唯一 ⇒ 界面上不该有第二处）', (t) => {
  // E1 的**另一半**：mp 侧能填地址的话，"谁覆盖谁"立刻成为真问题
  // （V3-PLAN 阶段 E 拍板的理由 3）。所以要机械地守住，而不只是写在文档里。
  //
  // ⚠️ 这里用 `process.cwd()` 推而不是 `__dirname` 的相对层数：判据跑的是 **dist/tests/**
  //   里的编译产物（plugin 的 test 脚本先 build 再 node --test dist/tests/），
  //   所以"从源文件数几层 `..`"在产物里会错一层——我为此连栽两次（ENOENT 看着像
  //   "实现坏了"，其实是我把源文件的相对路径搬到了产物里）。
  //   `pnpm -C packages/plugin test` 的 cwd 就是包根，这一条不含任何猜测。
  const pagesRoot = path.join(process.cwd(), '..', 'client', 'pages')
  /**
   * ## ⚠️ 拆仓之后这一条在**独立仓里跑不了**，所以显式 skip（2026-10-10）
   *
   * 它要读的是**小程序仓**的源码（`../client/pages`），而 `dsh-remote/plugin`
   * 拆出去之后旁边没有 `client`。跨端不变量**只能由同时看得见两边的仓来验** ——
   * 那就是伞仓 `dsh-remote-v3`，`pnpm gates` 跑的正是这里这一条。
   *
   * 为什么不"静默跳过就算了"：`t.skip` 会把原因打出来，独立仓的 CI 上写着
   * "由伞仓覆盖"，读的人知道这条判据**存在且有人在跑**。
   * 反过来，留一条必然红的判据更坏 —— 它会训练人"这个仓本来就红"，然后
   * 把**真的**红一起无视掉。这正是本仓反复记录的那个形状。
   */
  if (!existsSync(pagesRoot)) {
    t.skip('独立仓里没有 ../client/pages：这条跨端判据由伞仓 dsh-remote-v3 的 pnpm gates 执行')
    return
  }
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
    const code = stripComments(readFileSync(file, 'utf8'), path.extname(file))
    if (hasManualRelayEntry(code)) offenders.push(`${path.relative(process.cwd(), file)}（有输入框且提到地址）`)
  }
  assert.deepEqual(
    offenders,
    [],
    `小程序侧出现了手填中继地址的第二处入口：${offenders.join('、')}。配置点唯一在 DSH 侧（serverUrl），mp 只从二维码取`,
  )
})

test('反向：上面那条不是恒绿 —— 真给它一个地址输入框就必须红，且它看代码不看注释', () => {
  // 反证喂的是**样本字符串**而不是往 ../client/pages 里塞临时违规文件：
  // 真判据扫的是实际目录，造一个再忘了删，就是把红线自己抹掉。
  assert.equal(
    hasManualRelayEntry('<input bindinput="onServerInput" placeholder="请输入中继服务地址" />'),
    true,
    '真出现"地址输入框"必须红 —— 否则上面那条是恒绿的摆设，等价于没有判据',
  )
  assert.equal(
    hasManualRelayEntry('onLoad: function () { var serverUrl = e.detail.value }'),
    false,
    'js 里只有 serverUrl 变量、没有输入绑定 ⇒ 不该红（判据盯的是"入口"，不是"提到"）',
  )

  // sessions.wxml 的真实形状：注释解释"这里不是地址入口"，正文只有配对码输入框
  const okWithComment =
    '<!-- ⚠️ 它**不是**中继地址的配置入口 —— 那个在 DSH 主机侧 -->\n<input bindinput="onTokenInput" />'
  assert.equal(
    hasManualRelayEntry(stripComments(okWithComment, '.wxml')),
    false,
    '注释里提到"中继地址"、正文只有配对码输入框 ⇒ 不该判违规（判据看代码，不看注释）',
  )
  // 这一条防的是"剥注释那步根本没生效"：同一个样本不剥注释时**是**违规的。
  // 没有它，`stripComments` 写成空函数也能让上面那条绿。
  assert.equal(
    hasManualRelayEntry(okWithComment),
    true,
    '同一个样本不剥注释时是违规的 ⇒ 证明上面的 false 真的来自剥注释这一步，而不是判据太松',
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
