/**
 * wire-handshake-compat — 握手面改造（`wire@2.0.16`）的三端兼容**论证与钉住**。
 *
 * ## 这份判据为什么存在
 *
 * HANDOFF §0.10.18 遗留清单 **待办 C** 写的是："协议 2.0.16 的握手面改造**仍未评审**
 * —— 已发 npm 却没人逐条读过"。**待办 B** 写的是："三端兼容没在真链路验过"。
 *
 * 两者其实是**同一件事**：那份改造动的是 `hello` / `hello-ok`，也就是**握手面**。
 * 而握手面的兼容性有一个特别危险的性质——**它坏掉时不报错**：
 * `hello` 解析失败表现为"连上了、界面正常、什么都不发生"，
 * 或者更糟：中继按 `t` 路由，一个它不认识的**字段**会让它把整条帧判成 `bad_frame`
 * 直接关掉连接，而用户看到的是"手机突然掉线了"。
 *
 * 所以"490 + 163 条全绿"**证明不了**这件事：那两条数验的是"加性"，
 * 验的是"不破坏已有行为"，**不是**"新字段不会让老对端拒收"。
 * 两者必须分开说（§0.10.18 的 B 条原话："两件事别混"）。
 *
 * ## 这份判据做了什么
 *
 * 把"加性"这个论断**变成可执行的判据**，而不是留在注释里。四条：
 *
 * 1. **新 schema 收老 hello**（不带 `capabilities`）—— 加性的必要条件；
 * 2. **老 schema 收新 hello** —— 这是**真正危险**的那一侧，用 zod 默认
 *    `.object()` 复刻 2.0.14 的形状逐字段验证；
 * 3. **`.strict()` 会被拒** —— 反向判据：钉住"我们**依赖** zod 的 strip 语义"这件事，
 *    将来谁把 schema 改成 `.strict()`，这里立刻红（那时新字段会拒掉老对端）；
 * 4. **能力 id 不进帧路由** —— 中继按 `t` 路由，所以 `capabilities` 的值
 *    无论注册表怎么变都不影响路由（这一条是第 2 条成立的前提）。
 *
 * ## 它**不**证明什么（这一段与判据本身同等重要）
 *
 * - 它**不**跑真链路：真链路那一份是 `e2e/run.mjs`（17 步）与 `live-e2e.mjs`，
 *   后者会动用户自己那台手机的配对，默认不解配、只在显式 `--unpair` 时才做。
 * - 它**不**证明真机上"三端都 2.0.16"的配对流程（那要真人扫码）。
 * - 它**不**替代评审：`spec.md` 附录 D 的九条 GAP 仍要人读，
 *   本判据只钉住其中**可机械判定的那一条**（加性）。
 *
 * 取**真实发布物**（`dist/`），不是源码：中继与插件装的是 npm 上的包，
 * 而 `dist` 与 `src` 不同步时测的是另一个东西（"变异要能编译，否则测的是上一个产物"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const require = createRequire(path.join(ROOT, 'dsh-remote-protocol', 'probe.js'))

// 真实**产物**（协议层已 build；`gates` 里的产物新鲜度闸门保证它不旧于 src）
const wire = require(path.join(ROOT, 'dsh-remote-protocol', 'dist', 'src', 'index.js'))
const { z } = require(path.join(ROOT, 'dsh-remote-protocol', 'node_modules', 'zod'))

/**
 * `hello@2.0.14` 的 schema，**逐字段照抄**旧版形状（不带 `capabilities`）。
 *
 * 为什么手抄而不是从某处 import：npm 上旧版本已经不可安装（版本号不可重用，
 * `dsh-remote-wire@2.0.14` 仍在 npm 上但那台机器的 lockfile 可能已换），
 * 而"老对端"这个角色在今天的仓库里已经**没有代码**了 ——
 * 手抄是唯一能让"老对端"持续存在的方式，也才让这条判据有牙齿
 * （旧实现一改，这份拷贝会提醒你重新核）。
 */
const helloAt214 = z.object({
  t: z.literal('hello'),
  role: z.enum(['host', 'client']),
  protocol: z.number().int().positive().optional(),
  token: z.string().min(1).max(512).optional(),
  hostId: z.string().min(1).optional(),
  label: z.string().max(128).optional(),
  clientId: z.string().min(1).max(128).optional(),
  clientMeta: z.record(z.unknown()).optional(),
})

test('加性①：新 schema 收老 hello（不带 capabilities）—— 老端点必须照常连上', () => {
  // 这一侧风险低，但它是"加性"这个词的一半：新版本不能因为自己多了个字段
  // 就把"不报 capabilities 的老对端"判成非法。
  const r = wire.endpointFrame.safeParse({ t: 'hello', role: 'client', protocol: 1, clientId: 'abc' })
  assert.ok(r.success, `新 schema 拒了老 hello：${JSON.stringify(r.error?.issues)}`)
  assert.equal(
    r.data.capabilities,
    undefined,
    '缺省必须按"只支持基线"处理，而不是塞一个空数组或拒绝 —— 后两者会让老对端看起来"没有能力"',
  )
})

test('加性②：老 schema（2.0.14）收新 hello —— 这才是真正危险的那一侧', () => {
  const newHello = { t: 'hello', role: 'host', protocol: 1, capabilities: ['drc.host.info'], token: 't' }
  const r = helloAt214.safeParse(newHello)
  assert.ok(
    r.success,
    '**老中继的 schema 拒了带 capabilities 的 hello** ⇒ 新版主机连不上老中继，' +
      `而表现是"连上了、什么都不发生"。issues：${JSON.stringify(r.error?.issues)}`,
  )
  // strip 而非保留：老对端不该因为这条帧"学会了"一个新字段
  assert.equal(
    r.data.capabilities,
    undefined,
    '老 schema 会把 capabilities strip 掉（这是对的）——若它被保留，说明这份拷贝与真老版不一致',
  )
})

test('反向：我们依赖的正是 zod 的 strip 语义（改成 .strict() 会拒老对端）', () => {
  // 这条把"我们**依赖** zod 默认 .object() 的 strip 行为"变成显式契约。
  // 将来谁把 schema 收紧成 .strict()，新字段就会拒掉老对端 —— 那时这里会红，
  // 而那时**已经发出去的包收不回来**（npm 版本号不可重用）。
  const r = helloAt214.strict().safeParse({ t: 'hello', role: 'host', protocol: 1, capabilities: ['drc.host.info'] })
  assert.equal(
    r.success,
    false,
    '`.strict()` 竟然通过了？说明这份"老 schema 拷贝"已经不是 zod 默认语义，' +
      '上面两条验的是别的东西 —— 先修这份拷贝，再谈结论。',
  )
})

test('加性③：能力 id 不进帧路由（中继按 t 路由，所以值怎么变都不影响分流）', () => {
  // 这是上面②成立的前提：如果能力值参与路由，扩展注册表就可能改变分流的形状。
  //
  // ⚠️ 入参是**已解析的对象**，不是 JSON 字符串（`classifyEndpointFrameText` 才收字符串）。
  //    传错入参的话 `classifyEndpointFrame` 会走 `not_object` 那条早退 → 判 `ok:false`
  //    → 判据红，而红的原因与"加性"毫无关系 —— 判据因为**装置错误**而红是最坏的一种，
  //    它会让人去改对的东西。（这一版第一版就是这么错的，故留此注记。）
  const caps = wire.CAPABILITY_IDS
  assert.ok(Array.isArray(caps) && caps.length > 0, '能力注册表不该是空的')

  const r = wire.classifyEndpointFrame({ t: 'hello', role: 'client', protocol: 1, capabilities: ['drc.host.info'] })
  assert.equal(
    r.ok,
    true,
    '带 capabilities 的 hello 被中继判成 bad_frame —— 那么"扩展注册表"就会变成' +
      `"改一次注册表可能拒掉一条合法握手"，加性承诺当场不成立。reason=${r.reason}`,
  )
  assert.equal(r.frame?.t, 'hello', '分类结果应当仍是 hello（不是被改道）')
})

test('加性④：注册表里没有的能力 id 也照收（扩展注册表不会拒掉对端新报的能力）', () => {
  // 这条与③是同一族，但方向相反：**对端报了一个我们还不认识的能力**，该怎么办？
  // 正确答案是收下并忽略（`filterCapabilities` 是给"要向对方要什么"用的，
  // 不是入站闸门）。若这里拒了，那么每加一个能力 id 都是一次破坏性变更 ——
  // 而"先发能力、后接线"正是这份改造的既定路线。
  const unknown = 'drc.capability-from-the-future'
  assert.equal(
    wire.isKnownCapability(unknown),
    false,
    '装置问题：这个 id 应该在注册表之外，否则这条测的不是"未知能力"',
  )
  const viaSchema = wire.helloFrame.safeParse({ t: 'hello', role: 'client', capabilities: [unknown] })
  assert.ok(viaSchema.success, `helloFrame 拒了一个未知能力 id：${JSON.stringify(viaSchema.error?.issues)}`)

  const viaClassify = wire.classifyEndpointFrame({ t: 'hello', role: 'client', capabilities: [unknown] })
  assert.equal(viaClassify.ok, true, `中继分流拒了一个未知能力 id：reason=${viaClassify.reason}`)

  // 收敛侧同样不许拒：`filterCapabilities` 的作用是"去掉我们不认识的"，
  // 而不是"去掉对方报的"——后者会把协商变成单边裁剪。
  assert.deepEqual(
    wire.filterCapabilities([unknown]),
    [],
    'filterCapabilities 应把未知能力滤掉（这才是它的用途），而不是原样返回',
  )
  assert.deepEqual(
    wire.sharedCapabilities(['drc.v1'], [unknown]),
    [],
    '交集为空是正确结果：双方没有共同能力，不该硬凑一个',
  )
})

test('能力注册表与 hello 的字段名逐字一致（拼错一个就是"声明了但发不出去"）', () => {
  // `capabilities` 这个键名在 frames.ts / outbound.ts / SPEC.md 三处各写一遍。
  // 拼错的后果很安静：中继照旧 strip，而主机以为自己报了能力。
  const frame = wire.helloFrame.safeParse({ t: 'hello', role: 'host', protocol: 1, capabilities: ['drc.v1'] })
  assert.ok(frame.success && frame.data.capabilities?.length === 1, 'helloFrame 不接受 capabilities —— 键名对不上')

  const host = wire.helloForHost({ token: 't', protocol: 1, capabilities: ['drc.v1'] })
  const text = JSON.stringify(host)
  assert.match(text, /"capabilities":\["drc\.v1"\]/, `helloForHost 没把能力放进帧里：${text}`)
  // ⚠️ `endpointFrame` 是**zod schema**，入参是对象；`parseEndpointFrame` 才收字符串。
  //    传字符串的话 safeParse 会判 false —— 而红的原因与本条要验的东西无关，
  //    是"判据因装置错误而红"，那是最坏的一种（会让人去改对的东西）。
  assert.equal(
    wire.endpointFrame.safeParse(host).success,
    true,
    'helloForHost 产出的帧**过不了自己的 schema** —— 构造器与 schema 脱节了',
  )
  // `parseEndpointFrame` 收**未知值**、返回 `EndpointFrame | null`（不是 `{ok}`）。
  // 线上中继走的就是这条路径，所以"构造器的产物能被它解析"才是真结论。
  assert.notEqual(
    wire.parseEndpointFrame(host),
    null,
    'helloForHost 产出的帧经 parseEndpointFrame 解析成 null —— 线上走的就是这条路径',
  )
  // `parseEndpointFrameText` 才收字符串，且返回带 `ok` 的判别联合
  const viaText = wire.classifyEndpointFrameText(text)
  assert.equal(viaText.ok, true, `分类器判这条帧不合法：reason=${viaText.reason}`)
  // 缺省即"不发这个字段"：老对端不该因为多一个键而多一段解析
  assert.equal(
    JSON.stringify(wire.helloForHost({ token: 't' })).includes('capabilities'),
    false,
    '不带 capabilities 时构造器仍然把它写进了帧 —— 注释承诺的是"缺省不发"',
  )
})

test('MIN_SUPPORTED_PROTOCOL 不高于 PROTOCOL_VERSION（否则自己和自己都谈不拢）', () => {
  // 这条曾经是个真风险：`negotiateProtocol` 用 `min` 判 `peer < min`，
  // 而 `MIN > own` 会让**每一个**对端都判成 too_new —— 即"刚发布的版本谁也连不上"。
  assert.ok(
    wire.MIN_SUPPORTED_PROTOCOL <= wire.PROTOCOL_VERSION,
    `MIN_SUPPORTED_PROTOCOL(${wire.MIN_SUPPORTED_PROTOCOL}) > PROTOCOL_VERSION(${wire.PROTOCOL_VERSION})：` +
      '任何对端都会被判成 too_new，包括同版本的自己。',
  )
  // 与 min=own 的现行策略一致：加性演进下老版本一律放行
  const v = wire.negotiateProtocol(1)
  assert.equal(v.ok, true, `协议 1 的对端必须放行（加性演进），实际：${JSON.stringify(v)}`)
  assert.equal(wire.negotiateProtocol(undefined).ok, true, '不报 protocol 的老对端按 1 处理，必须放行')
  assert.equal(wire.negotiateProtocol(999).ok, false, '比自己新的对端要能拒绝并说清原因')
  assert.match(
    wire.negotiateProtocol(999).message ?? '',
    /版本/,
    '拒绝时必须说清"是版本问题"（规范 §5.2 V4），不许报成形状非法',
  )
})