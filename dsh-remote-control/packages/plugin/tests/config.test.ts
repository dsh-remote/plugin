/**
 * config.test — `shell/config.ts`：三级合成、校验、夹取、脱敏。
 *
 * 这一层守的是"装上了但没配好"这类故障（docs/legacy-spec/host-plugin-cordis.md §5.1/§5.2）：
 * GUI 宿主里没人看 stdout，配置写错时插件必须**要么带着次优值跑起来、要么留下能读的原因**，
 * 而不是不加载——"为什么什么都没发生"要有答案（docs/DESIGN.md §7 阶段 C 第 ⑥ 条：
 * 配置校验只拦"真不可用"）。
 *
 * 一个都必须钉死的点：`idleReleaseSec` 非法值绝不能把 NaN 传给 KeepAwake——
 * `NaN * 1000` 会让"空闲自动释放"的判据 `now - lastActiveAt > NaN` 恒为 false，
 * 表现是那台机器一次都睡不着，而且没有任何日志（旧实现 §4.4 那条 300 秒阈值就是这么失效的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, readConfig, redact, validateConfig, type PluginConfig } from '../src/shell/config.js'

/** 一眼假的 token：只用来验证脱敏形状，仓库里不许出现任何真凭据。 */
const FAKE_TOKEN = 'fake-token-not-a-real-secret-0123456789abcdef'
const LONG_ENOUGH = 'fake-fake-fake-fake-fake-0123456789'

function base(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return { ...DEFAULT_CONFIG, hostToken: LONG_ENOUGH, ...overrides }
}

test('优先级是环境变量 > patch 注入 > 默认值：环境变量是运维唯一的兜底入口', () => {
  const config = readConfig(
    { serverUrl: 'wss://from-patch.example', hostLabel: 'patch-label', hostId: 'patch-host' },
    { DRC_SERVER_URL: 'wss://from-env.example', DRC_HOST_LABEL: 'env-label', DRC_HOST_ID: 'env-host' },
  )
  assert.equal(config.serverUrl, 'wss://from-env.example', '环境变量没赢 → 中继地址没法临时切换（旧实现的运维习惯）')
  assert.equal(config.hostLabel, 'env-label', 'hostLabel 环境变量没赢')
  assert.equal(config.hostId, 'env-host', 'hostId 环境变量没赢：手机看到的"是哪台主机"就错了')

  const patchOnly = readConfig({ serverUrl: 'wss://from-patch.example' }, {})
  assert.equal(patchOnly.serverUrl, 'wss://from-patch.example', 'patch 注入必须压过默认值')

  const neither = readConfig(undefined, {})
  assert.equal(neither.serverUrl, DEFAULT_CONFIG.serverUrl, '两者都没有时退回默认值（本机中继是最常见形态）')
  assert.equal(neither.enabled, true, '默认是启用：装了就 expect 能用（§5.2 的降级原则）')
})

test('host token 只从环境变量取；hostTokenEnv 改名后按新名字取', () => {
  const config = readConfig({ hostTokenEnv: 'MY_DRC_TOKEN' }, { MY_DRC_TOKEN: LONG_ENOUGH })
  assert.equal(
    config.hostToken,
    LONG_ENOUGH,
    '按 hostTokenEnv 指向的变量名取值：取不到就得报 error，不能悄悄用空 token 连不上',
  )

  const fromPatch = readConfig({ hostToken: LONG_ENOUGH }, {})
  assert.equal(fromPatch.hostToken, LONG_ENOUGH, 'patch 里直接写 hostToken 也接受（env 缺失时的兜底）')

  const envWins = readConfig({ hostToken: 'fake-patched-patched-patched-0000' }, { DRC_HOST_TOKEN: LONG_ENOUGH })
  assert.equal(envWins.hostToken, LONG_ENOUGH, '环境变量必须压过 patch 里的 hostToken')
})

test('缺 token 是 error 级：整条链路连不上中继，手机看到的是"永远连不上"', () => {
  const problems = validateConfig({ ...DEFAULT_CONFIG, hostToken: '' })
  const errors = problems.filter((problem) => problem.level === 'error')
  assert.ok(errors.length >= 1, '空 token 必须报 error：只有 warn 的话上层启动门不拦，插件会连到中继后被 bad_token 踢')
  assert.equal(errors[0]?.field, 'hostToken', '字段名要报对，否则"为什么什么都没发生"没有答案')
  assert.match(String(errors[0]?.message), /DRC_HOST_TOKEN/, 'message 里要带上该往哪个环境变量里填')
})

test('token 短于 24 字符只是 warn：能跑，但强度不够', () => {
  const problems = validateConfig(base({ hostToken: 'fake-short' }))
  const warns = problems.filter((problem) => problem.level === 'warn')
  assert.equal(
    problems.some((problem) => problem.level === 'error'),
    false,
    '短 token 不该拦启动：那是用户的部署决定',
  )
  assert.ok(
    warns.some((problem) => problem.field === 'hostToken'),
    '要有这条 warn，否则弱 token 会一路带到线上',
  )
})

test('非回环地址走明文 ws:// 必须 warn；回环与 wss:// 不 warn', () => {
  const publicPlain = validateConfig(base({ serverUrl: 'ws://drc.example.com' }))
  assert.ok(
    publicPlain.some((problem) => problem.level === 'warn' && problem.field === 'serverUrl'),
    '明文 ws:// 出公网时配对码与密文在链路上可见：这条 warn 是唯一提醒',
  )

  for (const url of ['ws://127.0.0.1:8787', 'ws://localhost:8787', 'ws://[::1]:8787', 'wss://drc.example.com']) {
    const problems = validateConfig(base({ serverUrl: url }))
    assert.equal(
      problems.some((problem) => problem.field === 'serverUrl'),
      false,
      `${url} 被误报了：本机开发（127.0.0.1/localhost/::1）与 wss:// 都该安静通过`,
    )
  }
})

test('serverUrl 根本不是 ws/wss 时是 error：连不上任何东西的插件不该假装在跑', () => {
  for (const url of ['http://127.0.0.1:8787', 'drc.example.com', '']) {
    const problems = validateConfig(base({ serverUrl: url }))
    const errors = problems.filter((problem) => problem.level === 'error' && problem.field === 'serverUrl')
    assert.ok(errors.length >= 1, `${JSON.stringify(url)} 没被判为 error：小程序侧 T8 只接受 ws/wss，配错了要立刻说`)
  }
})

test('idleReleaseSec 非法值一律夹回 300：NaN 传给 KeepAwake 会让那台机器永不睡觉且毫无日志', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, -300]) {
    const config = base({ keepAwake: { enabled: true, idleReleaseSec: bad, keepDisplay: false } })
    const problems = validateConfig(config)
    assert.ok(
      problems.some((problem) => problem.level === 'warn' && problem.field === 'keepAwake.idleReleaseSec'),
      `idleReleaseSec=${String(bad)} 没有 warn：用户以为自己配了值`,
    )
    assert.equal(config.keepAwake.idleReleaseSec, 300, `idleReleaseSec=${String(bad)} 没被夹回 300`)
    assert.equal(
      Number.isFinite(config.keepAwake.idleReleaseSec * 1000),
      true,
      '换算成毫秒后必须是有限数：KeepAwake 的判据是 now-lastActiveAt > idleReleaseMs',
    )
  }

  // 0 是合法值（"保持到被显式关闭"），不许被夹走。
  const zero = base({ keepAwake: { enabled: true, idleReleaseSec: 0, keepDisplay: false } })
  assert.equal(
    validateConfig(zero).some((problem) => problem.field === 'keepAwake.idleReleaseSec'),
    false,
    '0 被当成非法值：手机上的"永不自动释放"选项就没了',
  )
  assert.equal(zero.keepAwake.idleReleaseSec, 0, '0 必须原样保留')
})

test('pairTtlMs 非正数夹回 120000：0 会让刚发布的配对码立刻过期，手机永远扫不上', () => {
  const config = base({ pairTtlMs: 0 })
  const problems = validateConfig(config)
  assert.ok(
    problems.some((problem) => problem.field === 'pairTtlMs' && problem.level === 'warn'),
    'pairTtlMs=0 必须 warn',
  )
  assert.equal(config.pairTtlMs, 120_000, '必须夹回默认值：本地过期时间是 peer-joined 取 PSK 的前提')

  const negative = base({ pairTtlMs: -1 })
  validateConfig(negative)
  assert.equal(negative.pairTtlMs, 120_000, '负值同样要夹')
})

test('pairOnStartSec>0 必须 warn：它会把仍然有效的配对码与 PSK 写进 status.json', () => {
  const problems = validateConfig(base({ pairOnStartSec: 60 }))
  const warn = problems.find((problem) => problem.field === 'pairOnStartSec')
  assert.ok(warn !== undefined, '这条验证辅助开关默认关（0），开起来必须有提醒：0600 文件里躺着可用的 PSK')
  assert.equal(warn?.level, 'warn')
  assert.match(String(warn?.message), /PSK/, '提醒内容要说清泄露的是什么')

  const off = validateConfig(base({ pairOnStartSec: 0 }))
  assert.equal(
    off.some((problem) => problem.field === 'pairOnStartSec'),
    false,
    '默认关的时候不该刷屏',
  )
})

test('statusFile 为空只 warn 并关闭状态快照：GUI 宿主里那是唯一的排错入口', () => {
  const problems = validateConfig(base({ statusFile: '' }))
  assert.ok(
    problems.some((problem) => problem.field === 'statusFile' && problem.level === 'warn'),
    '为空要提醒：否则"为什么什么都没发生"没有答案',
  )
  assert.equal(
    problems.some((problem) => problem.level === 'error'),
    false,
    '为空是合法选择（关掉功能），不该拦启动',
  )
})

test('takeOverQuestions 必须 warn：它会剥夺桌面 UI 的提问能力', () => {
  const problems = validateConfig(base({ takeOverQuestions: true }))
  assert.ok(
    problems.some((problem) => problem.field === 'takeOverQuestions' && problem.level === 'warn'),
    '接管提问是不可逆的能力转移，必须提醒',
  )
  assert.equal(
    validateConfig(base({ takeOverQuestions: false })).some((problem) => problem.field === 'takeOverQuestions'),
    false,
    '默认关时不该出现这条',
  )
})

test('redact() 不许泄露 token：短 token 全打星，长 token 只留前 4 后 2 与长度', () => {
  const short = redact('tiny')
  assert.equal(short, '****', '长度 <=8 的凭据必须整体打星：留任何片段都等于把整条给出去')
  assert.equal(short.includes('tiny'), false, '短 token 里出现了明文片段')

  const long = redact(FAKE_TOKEN)
  assert.equal(long, `fake…ef(${FAKE_TOKEN.length})`, `脱敏形状不对：收到 ${long}（约定是 前4+…+后2+长度）`)
  assert.equal(long.includes(FAKE_TOKEN), false, '整条 token 原样出现 = status.json 里躺着凭据')
  assert.equal(long.includes('not-a-real-secret'), false, '中段必须被抹掉')
  assert.ok(long.endsWith(`(${FAKE_TOKEN.length})`), '长度要带出来：排错时靠它判断是不是拿错了变量')

  // 长度 8 与 9 的分界：9 个字符只允许留前 4 与后 2。
  assert.equal(redact('fakefake9'), 'fake…e9(9)', '边界值 9 个字符只允许留前 4 与后 2')
  assert.equal(redact('fakefake9').includes('efak'), false, '中段一个字符都不许多留')
  assert.equal(redact('fakefake'), '****', '边界值 8 个字符必须全打星')
})

test('qrStyle 非法值不猜、保留上层值：把非法样式悄悄换成别的样式，等于运维写了没生效还不知道', () => {
  assert.equal(readConfig(undefined, { DRC_QR_STYLE: 'block' }).qrStyle, 'block', '合法值要透过去')
  assert.equal(readConfig(undefined, { DRC_QR_STYLE: 'half' }).qrStyle, 'half', 'half 是默认的紧凑样式')
  assert.equal(readConfig(undefined, {}).qrStyle, 'half', '什么都没设时是 half（文本二维码是主路径）')
  for (const garbage of ['svg', 'ASCII', 'unicode', 'svg,png']) {
    const config = readConfig({ qrStyle: 'block' }, { DRC_QR_STYLE: garbage })
    assert.equal(
      config.qrStyle,
      'block',
      `DRC_QR_STYLE=${JSON.stringify(garbage)} 非法时必须保留上层值，而不是换成一个没人写过的样式`,
    )
  }
  // 非法值要有人说话：静默保留上层值 = 运维以为改了但其实没改。
  const injected = base({ qrStyle: 'svg' as unknown as 'ascii' })
  assert.ok(
    validateConfig(injected).some((problem) => problem.field === 'qrStyle'),
    '非法 qrStyle 必须 warn',
  )
  assert.equal(injected.qrStyle, 'half', 'warn 之后夹回默认样式，渲染层才不会拿到不认识的样式')
})

test('布尔型环境变量只认显式的 1/0：拼错的值不许把功能打开或关掉', () => {
  assert.equal(readConfig(undefined, { DRC_MOCK_BRIDGE: '1' }).mockBridge, true, 'DRC_MOCK_BRIDGE=1 必须打开内存替身')
  assert.equal(
    readConfig({ mockBridge: true }, { DRC_MOCK_BRIDGE: '0' }).mockBridge,
    true,
    '文档约定的开关是 =1，0 只表示"没打开"，不许把 patch 里的设置反掉',
  )
  assert.equal(readConfig({ qrImage: true }, { DRC_QR_IMAGE: '0' }).qrImage, false, 'DRC_QR_IMAGE=0 必须关掉 PNG 落盘')
  assert.equal(readConfig({ qrOpen: true }, { DRC_QR_OPEN: '0' }).qrOpen, false, 'DRC_QR_OPEN=0 必须关掉"自动打开"')
  assert.equal(
    readConfig({ takeOverQuestions: true }, { DRC_TAKE_OVER_QUESTIONS: '1' }).takeOverQuestions,
    true,
    '接管开关按显式 1 走',
  )
})

test('DRC_PAIR_ON_START_SEC 的非有限值也必须折成 0：`Number(v) || 0` 会放过 Infinity', () => {
  // Infinity 是**真值**，所以"用 || 兜底"的写法根本拦不住它；而 patch 里写
  // `pairOnStartSec: .inf` 走的是注入路径，同样必须被折掉。
  // 语义后果：这张带着 PSK 的配对码"永久有效"，正好是这条配置想避免的事。
  for (const bad of ['Infinity', '+Infinity', '1e999', '-5', '-0.5']) {
    assert.equal(
      readConfig({ pairOnStartSec: 60 }, { DRC_PAIR_ON_START_SEC: bad }).pairOnStartSec,
      0,
      `DRC_PAIR_ON_START_SEC=${bad} 漏进了配置`,
    )
  }
  for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -1]) {
    const config = base({ pairOnStartSec: bad })
    const problems = validateConfig(config)
    assert.equal(config.pairOnStartSec, 0, `注入值 ${String(bad)} 没被 validateConfig 折回 0`)
    assert.ok(
      problems.some((problem) => problem.field === 'pairOnStartSec'),
      `折回 0 却不留痕（${JSON.stringify(problems.map((problem) => problem.field))}）`,
    )
  }
})

test('DRC_PAIR_ON_START_SEC 的非数字值折成 0（关）：绝不能折成 NaN 让发布循环卡住', () => {
  assert.equal(readConfig(undefined, { DRC_PAIR_ON_START_SEC: '120' }).pairOnStartSec, 120, '数字值要生效')
  assert.equal(
    readConfig(undefined, { DRC_PAIR_ON_START_SEC: '1e69' }).pairOnStartSec,
    1e69,
    '合法但荒谬的数字照样通过：只拦 NaN，不拦量级（这条是有意的宽松）',
  )
  for (const bad of ['abc', '0', 'nan', 'true', '12sec']) {
    assert.equal(
      readConfig({ pairOnStartSec: 60 }, { DRC_PAIR_ON_START_SEC: bad }).pairOnStartSec,
      0,
      `DRC_PAIR_ON_START_SEC=${JSON.stringify(bad)} 必须落到 0=关，而不是保留上层的值`,
    )
  }
  assert.equal(
    Number.isNaN(readConfig(undefined, { DRC_PAIR_ON_START_SEC: 'abc' }).pairOnStartSec),
    false,
    'NaN 漏进配置：`pairOnStartSec > 0` 判据会变成 undefined 分支',
  )
  // 空串等于"没有这个环境变量"：不许把 patch 里的值反掉，也不许折成 0。
  assert.equal(
    readConfig({ pairOnStartSec: 60 }, { DRC_PAIR_ON_START_SEC: '' }).pairOnStartSec,
    60,
    '空串被当成 0 会静默关掉自动发码',
  )
  assert.equal(
    readConfig({ qrStyle: 'block' }, { DRC_QR_STYLE: '' }).qrStyle,
    'block',
    '空串同样不该覆盖 patch 里的样式',
  )
})

test('keepAwake 是深合并：patch 只给一个子字段时其余子字段保留默认值', () => {
  // patch YAML 是无类型的：用户真的会只写一个子键，这里按现实形状注入。
  const config = readConfig({ keepAwake: { keepDisplay: true } } as unknown as Partial<PluginConfig>, {})
  assert.equal(config.keepAwake.keepDisplay, true, '子字段没合进去：用户只想开屏幕常锁，结果整个开关被默认值覆盖')
  assert.equal(config.keepAwake.enabled, true, 'keepAwake.enabled 必须保留默认 true：浅合并会把它变成 undefined')
  assert.equal(
    config.keepAwake.idleReleaseSec,
    DEFAULT_CONFIG.keepAwake.idleReleaseSec,
    'idleReleaseSec 同样要保留默认 300',
  )
})

test('校验不许改动合法配置：夹取只发生在非法值上', () => {
  const config = base({ keepAwake: { enabled: true, idleReleaseSec: 45, keepDisplay: true }, pairTtlMs: 30_000 })
  const copy = JSON.parse(JSON.stringify(config)) as PluginConfig
  validateConfig(config)
  assert.deepEqual(config.keepAwake, copy.keepAwake, '合法值被改写了：用户配的 45 秒没了')
  assert.equal(config.pairTtlMs, 30_000, '合法的 pairTtlMs 不许被动')
  assert.equal(config.hostToken, copy.hostToken, '校验永远不许改 token（也永远不许把它写进任何返回值）')
})

test('一份典型配置在合法输入下不该有任何 error：否则插件会静默不加载', () => {
  const config = readConfig(
    {
      serverUrl: 'wss://drc.example.com',
      hostLabel: '我的主机',
      keepAwake: { enabled: true, idleReleaseSec: 600, keepDisplay: false },
    },
    { DRC_HOST_TOKEN: FAKE_TOKEN },
  )
  const problems = validateConfig(config)
  assert.equal(
    problems.filter((problem) => problem.level === 'error').length,
    0,
    `合法配置报了 error：${JSON.stringify(problems.filter((p) => p.level === 'error'))}`,
  )
  assert.equal(config.hostToken, FAKE_TOKEN, 'token 必须真的从环境变量读到')
})

/**
 * 配对二维码的呈现默认值是一条拍板，2026-10-02 翻转：
 * 真机取证发现 DSH 命令卡按 `line-height:1.6` 渲染等宽输出，行间留白把半块二维码
 * 横切成条（zxing ≥1.15 行距即失败），文本码在唯一宿主上扫不出来——于是默认产物改成图片。
 * **仍然不许把用户赶到 DSH 外面去"看预览"**：`qrOpen` 保持关（写图 ≠ 替用户开查看器）。
 * 这条断言存在的意义是：哪天有人把 `qrOpen` 默认打开、或把关掉的文本默认改回来，测试会拦住他。
 */
test('二维码默认出图片（qrImage 开）、但不自动打开（qrOpen 关）；qrAnsi 关、样式 half', () => {
  assert.equal(DEFAULT_CONFIG.qrImage, true, '文本码在 DSH 命令卡里扫不出来（行高把它切条），默认必须出图片')
  assert.equal(DEFAULT_CONFIG.qrOpen, false, '默认调用系统打开图片：配对动作被搬到了宿主外面')
  assert.equal(DEFAULT_CONFIG.qrAnsi, false, '默认套 ANSI：宿主按纯文本渲染时会把转义序列打成乱码')
  assert.equal(DEFAULT_CONFIG.qrStyle, 'half', '默认文本样式仍是半块（供关了图片时当退路）')
})

test('qr* 三个开关的环境变量只认 1/0/true/false，其余值退回上层值（不猜）', () => {
  assert.equal(
    readConfig(undefined, { DRC_QR_IMAGE: '1' }).qrImage,
    true,
    'DRC_QR_IMAGE=1 要能把图片打开（默认已是开，这里要幂等）',
  )
  assert.equal(readConfig({ qrImage: true }, { DRC_QR_IMAGE: '0' }).qrImage, false, '=0 要能关掉 patch 里开的值')
  assert.equal(
    readConfig({ qrAnsi: true }, { DRC_QR_ANSI: 'yes' }).qrAnsi,
    true,
    '无法识别的值必须退回上层值，而不是静默变成关',
  )
  assert.equal(
    readConfig({ qrStyle: 'block' }, { DRC_QR_STYLE: 'fancy' }).qrStyle,
    'block',
    '非法样式在 readConfig 阶段不猜',
  )
  const injected = base({ qrStyle: 'fancy' as unknown as 'ascii' })
  const problems = validateConfig(injected)
  assert.equal(injected.qrStyle, 'half', '非法 qrStyle 要在 validateConfig 里夹回并留痕')
  assert.ok(
    problems.some((problem) => problem.field === 'qrStyle'),
    '夹回必须 warn',
  )
})

test('qrOpen 而 qrImage 关着是无效组合：要 warn（关了图片就没有文件可开）', () => {
  const problems = validateConfig(base({ qrImage: false, qrOpen: true }))
  const warn = problems.find((problem) => problem.field === 'qrOpen')
  assert.ok(
    warn && warn.level === 'warn',
    `这个组合什么都没打开，却没人告诉运维：${JSON.stringify(problems.map((problem) => problem.field))}`,
  )
  assert.equal(
    validateConfig(base({ qrImage: true, qrOpen: true })).some((problem) => problem.field === 'qrOpen'),
    false,
    '两个都开是合法组合，不该刷屏',
  )
})
