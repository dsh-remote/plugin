/**
 * 配对授权状态机（2026-10-21）。守三条不变量 + 一条"密钥真的能解出来"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSharedKey, newPairingKeyPair, sasCode, unwrapPsk } from '@dsh-remote/protocol'
import { createPairApproval } from '../src/shell/pair-approval.js'

/** 32 字节 psk 的 base64（真实 psk 就是这个长度）。 */
const PSK = Buffer.alloc(32, 7).toString('base64')

test('申请 → 显示 6 位 → 放行 → 手机能解出 psk', () => {
  const phone = newPairingKeyPair()
  let clock = 1_000
  const approval = createPairApproval({ pskFor: (t) => (t === '042915' ? PSK : null), now: () => clock })
  const offered = approval.offer('042915', Buffer.from(phone.publicKey).toString('base64'), 'c_abc')
  assert.ok(offered, '合法申请必须被接住')
  assert.match(offered!.sas, /^\d{6}$/)

  const granted = approval.approve()
  assert.ok(granted, '用户确认后必须放行')
  const shared = deriveSharedKey(phone.secretKey, Buffer.from(granted!.hostPub, 'base64'))
  assert.equal(sasCode(shared), offered!.sas, '手机算出的数字必须与主机显示的一致')
  const psk = unwrapPsk(shared, granted!.nonce, granted!.wrappedPsk)
  assert.ok(psk, '手机必须能解出 psk')
  assert.deepEqual([...psk!], [...Buffer.from(PSK, 'base64')])
})

test('放行是一次性的：第二次返回 null', () => {
  const phone = newPairingKeyPair()
  const approval = createPairApproval({ pskFor: () => PSK })
  approval.offer('111111', Buffer.from(phone.publicKey).toString('base64'), 'c_abc')
  assert.ok(approval.approve())
  assert.equal(approval.approve(), null)
})

test('过期即作废（TTL 到了，approve 与 current 都不认）', () => {
  const phone = newPairingKeyPair()
  let clock = 0
  const approval = createPairApproval({ pskFor: () => PSK, now: () => clock, ttlMs: 1_000 })
  approval.offer('111111', Buffer.from(phone.publicKey).toString('base64'), 'c_abc')
  clock = 1_001
  assert.equal(approval.current(), undefined)
  assert.equal(approval.approve(), null)
})

test('token 不认识 / 公钥长度不对 ⇒ 不接受', () => {
  const approval = createPairApproval({ pskFor: () => null })
  assert.equal(approval.offer('999999', Buffer.alloc(32, 1).toString('base64'), 'c_abc'), null)
  const ok = createPairApproval({ pskFor: () => PSK })
  assert.equal(ok.offer('111111', Buffer.alloc(16, 1).toString('base64'), 'c_abc'), null, '16 字节不是合法 X25519 公钥')
})

test('放行之后那 6 位数字还要留着给用户对照，但过时会自己消失', () => {
  /**
   * 2026-10-21 晚：主机改成**自动放行**之后，放行是"取走即焚"⇒ `current()` 立刻变
   * undefined ⇒ 主机界面就再也显示不出那串数字。而它是**用户唯一能对照的东西**
   * （手机上弹窗一串、主机屏幕上一串，两处一致才说明中间没人换公钥）。
   *
   * ⇒ 放行之后仍要留一会儿；它是**给人看的对照物**，不是凭据（真凭据在密文里）
   * ⇒ 过期就自动消失。
   */
  const phone = newPairingKeyPair()
  let clock = 1_000
  const approval = createPairApproval({ pskFor: () => PSK, now: () => clock })
  const offered = approval.offer('111111', Buffer.from(phone.publicKey).toString('base64'), 'c_abc')
  assert.ok(offered)
  assert.ok(approval.approve(), '放行')
  assert.equal(approval.current(), undefined, '放行后当前申请就没了（取走即焚）')
  const last = approval.lastGranted()
  assert.ok(last, '但那 6 位数字要留着给用户对照')
  assert.equal(last!.sas, offered!.sas, '留着的必须是同一串（否则用户对的是另一串）')
  // 过时 ⇒ 自动消失（不必等下一轮配对）。
  clock += 90_001
  assert.equal(approval.lastGranted(), undefined, '过时的对照物要自己消失')
})

test('解配 / 拒绝（clear）后：那串数字也一起消失（界面上的东西都要对应当前状态）', () => {
  const phone = newPairingKeyPair()
  const approval = createPairApproval({ pskFor: () => PSK })
  approval.offer('111111', Buffer.from(phone.publicKey).toString('base64'), 'c_abc')
  approval.approve()
  assert.ok(approval.lastGranted(), '刚放行时它在')
  approval.clear()
  assert.equal(approval.lastGranted(), undefined, '解配后它就是过期信息了，不该还挂着')
})
