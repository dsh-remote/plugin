/**
 * 配对授权（2026-10-21）：把「手机申请 → 人比对 6 位数字 → 主机放行」这三步做成纯状态机。
 *
 * 为什么单拎出来：这条路的**安全全押在"人看见了数字"**上。把它揉进 socket 回调里，
 * 判据就只能靠端到端起两台机器，而这恰好是最容易写成"看起来通过了"的一类。
 *
 * 三条不变量：
 * 1. **一次只挂一条申请**：新申请顶掉旧的（否则用户确认的那张和屏幕上显示的那张可能不是同一张）。
 * 2. **放行是一次性的**：`approve()` 取走即焚；重复调用返回 null。
 * 3. **过期即作废**：超过 TTL 的申请不许再被放行（配对码本来就有时限）。
 */
import { deriveSharedKey, newPairingKeyPair, sasCode, toBase64, wrapPsk } from '@dsh-remote/protocol'

export interface PairApprovalDeps {
  /** 取当前这张码对应的 psk（主机本地，从不外发）。 */
  pskFor(token: string): string | null
  now?: () => number
  /** 申请的有效期。默认 90 秒：够用户看清数字，又不至于挂着一张过期的申请。 */
  ttlMs?: number
}

export interface PendingApproval {
  pairingToken: string
  /** 屏幕上显示的 6 位数字。 */
  sas: string
  /** 还剩多少秒（供 UI 显示，0 表示已过期）。 */
  remainSec: number
}

export interface GrantedPsk {
  pairingToken: string
  sessionId: string
  hostPub: string
  nonce: string
  wrappedPsk: string
}

export interface PairApproval {
  /** 手机申请（携带一次性公钥）。返回要显示给用户的 6 位数字；token 不匹配返回 null。 */
  offer(pairingToken: string, clientPub: string, sessionId: string): PendingApproval | null
  /** 当前挂着的申请（UI 轮询用）。过期会自动清掉并返回 undefined。 */
  current(): PendingApproval | undefined
  /** 用户点了"数字一致，允许"。返回要回给手机的密文；没有可放行的申请时 null。 */
  approve(): GrantedPsk | null
  /** 用户拒绝 / 换了一张码。 */
  clear(): void
  /**
   * **最近一次放行**的那 6 位数字（2026-10-21 晚）。
   *
   * ## 为什么自动放行之后还需要它
   *
   * 3.2 晚起主机改成**自动放行**（确认只留在手机端），而放行是"取走即焚"的
   * ⇒ `current()` 立刻变 undefined ⇒ **主机界面再也显示不出那 6 位数字**。
   *
   * 而那串数字是**用户唯一能对照的东西**：手机上弹窗里有一串，主机屏幕上也要有一串，
   * 两处一致才说明中间没人换公钥。⇒ 放行之后仍要**留一会儿**给用户对照。
   *
   * ## 为什么只留一小会儿
   *
   * 它是**给人看的对照物**，不是凭据（真正的凭据在密文里）⇒ 过期就自动消失，
   * 不必等下一轮配对。所以 TTL 取**放行窗口的同一长度**（默认 90 秒），
   * 用户从容比完即可。
   */
  lastGranted(): PendingApproval | undefined
}

export function createPairApproval(deps: PairApprovalDeps): PairApproval {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? 90_000
  let pending:
    | { token: string; shared: Uint8Array; hostPub: string; sessionId: string; sas: string; expiresAt: number }
    | undefined
  /**
   * 最近一次放行的对照物（2026-10-21 晚）。放行是"取走即焚"，但那 6 位数字
   * 还要留给用户对照一会儿 —— 见 `lastGranted()` 的注释。
   */
  let lastGrantedEntry: { token: string; sas: string; expiresAt: number } | undefined

  const expired = (entry: { expiresAt: number }): boolean => entry.expiresAt <= now()

  return {
    offer(pairingToken: string, clientPub: string, sessionId: string): PendingApproval | null {
      if (deps.pskFor(pairingToken) === null) return null
      let peerPublicKey: Uint8Array
      try {
        peerPublicKey = Uint8Array.from(Buffer.from(clientPub, 'base64'))
      } catch {
        return null
      }
      if (peerPublicKey.length !== 32) return null
      // 每次申请都换一枚主机临时密钥：同一张码被申请两次也不会复用共享密钥。
      const host = newPairingKeyPair()
      const shared = deriveSharedKey(host.secretKey, peerPublicKey)
      const sas = sasCode(shared)
      pending = {
        token: pairingToken,
        shared,
        hostPub: toBase64(host.publicKey),
        sessionId,
        sas,
        expiresAt: now() + ttlMs,
      }
      // 私钥用完即弃：approve 时只需要 shared。
      return { pairingToken, sas, remainSec: Math.ceil(ttlMs / 1000) }
    },

    current(): PendingApproval | undefined {
      if (pending === undefined) return undefined
      if (expired(pending)) {
        pending = undefined
        return undefined
      }
      return {
        pairingToken: pending.token,
        sas: pending.sas,
        remainSec: Math.max(0, Math.ceil((pending.expiresAt - now()) / 1000)),
      }
    },

    approve(): GrantedPsk | null {
      if (pending === undefined || expired(pending)) {
        pending = undefined
        return null
      }
      const pskText = deps.pskFor(pending.token)
      if (pskText === null) {
        pending = undefined
        return null
      }
      const { nonce, wrappedPsk } = wrapPsk(pending.shared, Uint8Array.from(Buffer.from(pskText, 'base64')))
      const result: GrantedPsk = {
        pairingToken: pending.token,
        // 中继按它转发（见 pairGrantFrame）。
        sessionId: pending.sessionId,
        // 手机要用它算共享密钥：**必须**带出去（少了它，手机侧 unwrap 永远解不开）。
        hostPub: pending.hostPub,
        nonce,
        wrappedPsk,
      }
      // 留下那 6 位数字给用户对照（自动放行之后 `current()` 就没了，见 `lastGranted()`）。
      lastGrantedEntry = { token: pending.token, sas: pending.sas, expiresAt: now() + ttlMs }
      pending = undefined
      return result
    },

    lastGranted(): PendingApproval | undefined {
      if (lastGrantedEntry === undefined) return undefined
      if (expired(lastGrantedEntry)) {
        lastGrantedEntry = undefined
        return undefined
      }
      return {
        pairingToken: lastGrantedEntry.token,
        sas: lastGrantedEntry.sas,
        remainSec: Math.max(0, Math.ceil((lastGrantedEntry.expiresAt - now()) / 1000)),
      }
    },

    clear(): void {
      pending = undefined
      /**
       * 连带清掉"最近放行"那串数字（2026-10-21 晚）。
       *
       * `clear()` 的语义是"用户拒绝 / 换了一张码 / 这条路不要了" ⇒
       * 屏幕上还挂着一串"刚才放行过的确认码"就是**过期信息**：
       * 它会让用户以为"刚才是这一串"，而实际上那条路已经作废了。
       *
       * ⚠️ 它不是凭据（真凭据在密文里），但"该消失的东西留着"本身就是一种不一致
       * —— 界面上的每一样东西都该对应当前状态。
       */
      lastGrantedEntry = undefined
    },
  }
}
