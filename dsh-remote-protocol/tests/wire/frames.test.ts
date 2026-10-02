/**
 * 控制面帧的校验边界。
 *
 * 中继是这套系统里唯一"被不可信输入直接打"的进程（任何能连上 443 的 socket 都能发帧），
 * 所以这里的**拒绝**分支比接受分支更重要：每一类畸形形状都要有一条测试，
 * 否则实现里漏掉一种形状就是线上一条没被覆盖的攻击面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTOCOL_VERSION,
  base64Text,
  encBatchFrame,
  errorFrame,
  helloFrame,
  isEncFrame,
  makeEncBatchFrame,
  makeEncFrame,
  makeErrorFrame,
  pairBeginFrame,
  pairReadyFrame,
  parseEndpointFrame,
  parseEndpointFrameText,
  parseRelayFrame,
  parseRelayFrameText,
  peerJoinedFrame,
} from '../../src/wire/frames.js'

const CIPHER = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

test('小程序实际会发的三种帧都通过（F2 的形状，一个字段都不能要求它多给）', () => {
  assert.deepEqual(
    parseEndpointFrame({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      clientId: 'mdwx0abc-9k2j1h',
      clientMeta: { platform: 'wechat-mp', label: '微信小程序' },
    })?.t,
    'hello',
  )
  assert.ok(parseEndpointFrame({ t: 'pair-begin-client', pairingToken: '123456' }))
  assert.ok(parseEndpointFrame({ t: 'enc', sessionId: 'c_a1b2c3d4e5f6', seq: 1, clientId: 'x', ciphertext: CIPHER }))
  // clientId 与 seq 都是可选的（旧 e2e 就不带 clientId）。
  assert.ok(parseEndpointFrame({ t: 'enc', sessionId: 'c_a1b2c3d4e5f6', ciphertext: CIPHER }))
})

test('hello：role 只认 host/client；token 只有 host 会带；未知 role 被拒', () => {
  assert.ok(parseEndpointFrame({ t: 'hello', role: 'host', token: 't'.repeat(64), hostId: 'ab12cd34' }))
  assert.equal(parseEndpointFrame({ t: 'hello', role: 'mp', clientId: 'x' }), null)
  assert.equal(parseEndpointFrame({ t: 'hello' }), null)
  assert.equal(helloFrame.safeParse({ t: 'hello', role: 'client', clientId: '' }).success, false, '空 clientId 无意义')
  assert.equal(helloFrame.safeParse({ t: 'hello', role: 'client', clientId: 'x'.repeat(200) }).success, false)
})

test('pair-begin 不再携带 psk（D1 的执行点）', () => {
  const ok = parseEndpointFrame({ t: 'pair-begin', pairingToken: '246810', hostLabel: 'bins' })
  assert.ok(ok)
  assert.equal('psk' in ok, false, 'spec 里不存在 psk 字段，带进来也会被剥掉')
  // 也就是说：即便旧主机发 psk，新中继也不会把它存进任何状态——类型上就没有地方放。
  const withPsk = pairBeginFrame.safeParse({ t: 'pair-begin', pairingToken: '246810', psk: CIPHER })
  assert.equal(withPsk.success, true)
  assert.equal('psk' in (withPsk.data as Record<string, unknown>), false)
})

test('配对码必须是 6 位数字；TTL 必须是正整数', () => {
  for (const bad of ['12345', '1234567', 'abcdef', '12345a', '']) {
    assert.equal(pairBeginFrame.safeParse({ t: 'pair-begin', pairingToken: bad }).success, false, bad)
    assert.equal(parseEndpointFrame({ t: 'pair-begin-client', pairingToken: bad }), null, `客户端认领帧必须拒：${bad}`)
  }
  assert.equal(pairReadyFrame.safeParse({ t: 'pair-ready', pairingToken: '123456', ttlMs: 0 }).success, false)
  assert.equal(pairReadyFrame.safeParse({ t: 'pair-ready', pairingToken: '123456', ttlMs: -1 }).success, false)
  assert.equal(pairReadyFrame.safeParse({ t: 'pair-ready', pairingToken: '123456', ttlMs: 1.5 }).success, false)
  assert.equal(pairReadyFrame.safeParse({ t: 'pair-ready', pairingToken: '123456', ttlMs: 180_000 }).success, true)
})

test('ciphertext 分两层把关：形状层只要求非空字符串，字符集层要求标准 base64', () => {
  // 为什么分两层：如果 base64 校验混在 schema 里，中继就没法区分
  // "帧的形状不对（unknown_frame）"与"密文不是合法 base64（bad_frame）"，
  // 而这两个错误码对排错的价值完全不同。
  const base = { t: 'enc', sessionId: 'c_a1b2c3d4e5f6' }
  assert.ok(parseEndpointFrame({ ...base, ciphertext: CIPHER }))
  for (const bad of ['', 'a', '!!!!', 'AAECAwQFBgcICQoLDA0ODw==\n', 'AA AC', 'AAAA-BBB_CCC=', '====']) {
    assert.equal(base64Text.safeParse(bad).success, false, `字符集层必须拒绝这个 ciphertext：${JSON.stringify(bad)}`)
  }
  assert.equal(base64Text.safeParse(CIPHER).success, true)
  // 形状层仍然守得住：缺字段、超长、非字符串。
  assert.equal(parseEndpointFrame({ ...base, ciphertext: '' }), null)
  assert.equal(parseEndpointFrame(base), null)
  assert.equal(parseEndpointFrame({ ...base, ciphertext: 42 }), null)
  assert.equal(parseEndpointFrame({ ...base, ciphertext: 'A'.repeat(600 * 1024) }), null)
})

test('seq 只当元数据：非负整数可以任意起点，负数与小拒', () => {
  assert.ok(parseEndpointFrame({ t: 'enc', sessionId: 'c_x1', seq: 0, ciphertext: CIPHER }))
  assert.ok(parseEndpointFrame({ t: 'enc', sessionId: 'c_x1', seq: 1_000_000, ciphertext: CIPHER }))
  assert.equal(parseEndpointFrame({ t: 'enc', sessionId: 'c_x1', seq: -1, ciphertext: CIPHER }), null)
  assert.equal(parseEndpointFrame({ t: 'enc', sessionId: 'c_x1', seq: 1.5, ciphertext: CIPHER }), null)
})

test('enc-batch 的通道 id 只在外层，items 至少一项且每项自带密文（F12）', () => {
  assert.ok(
    parseEndpointFrame(makeEncBatchFrame('c_a1b2c3d4e5f6', [{ ciphertext: CIPHER }, { ciphertext: CIPHER, seq: 2 }])),
  )
  assert.equal(encBatchFrame.safeParse({ t: 'enc-batch', sessionId: 'c_x', items: [] }).success, false)
  assert.equal(encBatchFrame.safeParse({ t: 'enc-batch', sessionId: 'c_x', items: [{ nope: 1 }] }).success, false)
  assert.equal(
    encBatchFrame.safeParse({ t: 'enc-batch', items: [{ ciphertext: CIPHER }] }).success,
    false,
    '缺 sessionId 的批量帧小程序无法解，必须拒',
  )
})

test('中继来帧：paired 必须带 sessionId，peer-joined 可以带 pairingToken，error 的 code 是封闭枚举', () => {
  assert.ok(parseRelayFrame({ t: 'paired', sessionId: 'c_a1b2c3d4e5f6', hostId: 'h1' }))
  assert.equal(parseRelayFrame({ t: 'paired', hostId: 'h1' }), null)
  assert.ok(parseRelayFrame({ t: 'peer-joined', sessionId: 'c_1', clientId: 'c1', pairingToken: '123456' }))
  assert.equal(parseRelayFrame({ t: 'peer-joined', sessionId: 'c_1', pairingToken: '12' }), null)
  assert.ok(parseRelayFrame(makeErrorFrame('unknown_session', '会话不存在')))
  assert.equal(errorFrame.safeParse({ t: 'error', code: 'wat' }).success, false)
  assert.equal(errorFrame.safeParse({ t: 'error' }).success, false)
  assert.equal(peerJoinedFrame.safeParse({ t: 'peer-joined', sessionId: 'c_1', clientId: '' }).success, false)
})

test('pair-fail 的 reason 只能是小程序有中文映射的那四个（F6）', () => {
  for (const reason of ['invalid_or_expired', 'already_used', 'host_offline', 'bad_token']) {
    assert.equal(parseRelayFrame({ t: 'pair-fail', reason })?.t, 'pair-fail')
  }
  assert.equal(parseRelayFrame({ t: 'pair-fail', reason: 'expired' }), null)
  // `rate_limited` 是**服务端内部**原因：小程序的 translatePairFail 没有这个键，
  // 发出去就是一条英文字面量弹给用户。中继要限速就记日志，线上写 invalid_or_expired。
  assert.equal(parseRelayFrame({ t: 'pair-fail', reason: 'rate_limited' }), null, 'rate_limited 又回到线上了')
})

test('文本解析：非法 JSON、数组、标量、缺 t 全部返回 null 而不抛', () => {
  for (const raw of ['', 'null', '[]', '42', '"hi"', '{', '{"t":}', '{"nope":1}']) {
    assert.equal(parseRelayFrameText(raw), null, raw)
    assert.equal(parseEndpointFrameText(raw), null, raw)
  }
})

test('未知帧名不会被静默接受（中继据此回 unknown_frame）', () => {
  assert.equal(parseEndpointFrame({ t: 'heartbeat', seq: 1 }), null)
  assert.equal(parseRelayFrame({ t: 'keepalive' }), null)
})

test('构造器产出的形状立即可被对侧解析（自证往返）', () => {
  const enc = makeEncFrame('c_a1b2c3d4e5f6', CIPHER, { seq: 3, clientId: 'inst-1' })
  assert.deepEqual(parseRelayFrame(enc), enc)
  assert.deepEqual(parseEndpointFrame(enc), enc)
  assert.deepEqual(makeErrorFrame('bad_frame'), { t: 'error', code: 'bad_frame' })
})

test('isEncFrame 只认两条数据面帧（转发热路径的分诊判据）', () => {
  assert.equal(isEncFrame({ t: 'enc' }), true)
  assert.equal(isEncFrame({ t: 'enc-batch' }), true)
  for (const t of ['hello', 'paired', 'error', 'pong', 'enc ']) assert.equal(isEncFrame({ t }), false)
})

test('resync：主机声明它仍持有密钥的会话（复核 R1 的协议入口）', () => {
  assert.ok(parseEndpointFrame({ t: 'resync', sessionIds: [] }), '空清单是合法且有意义的一条')
  assert.ok(parseEndpointFrame({ t: 'resync', sessionIds: ['c_a1b2c3d4e5f6', 'c_000000000000'] }))
  assert.equal(parseEndpointFrame({ t: 'resync' }), null, '缺 sessionIds 无法表达"我还有这些"')
  assert.equal(parseEndpointFrame({ t: 'resync', sessionIds: 'c_a1b2c3d4e5f6' }), null)
  assert.equal(parseEndpointFrame({ t: 'resync', sessionIds: [''] }), null, '空串 id 没有意义')
})

test('错误消息长度有界（一条失控的 message 不该占满内存）', () => {
  assert.equal(errorFrame.safeParse({ t: 'error', code: 'internal', message: 'x'.repeat(600) }).success, false)
})
