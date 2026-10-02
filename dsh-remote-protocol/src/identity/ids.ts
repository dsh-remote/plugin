/**
 * ids — 各类标识符。
 *
 * 只有"要长期参与路由或密钥派生"的 id 用 CSPRNG；一次性的 `cmdId` 用 UUID 即可。
 * 注意 `clientId`（安装 id）是**小程序侧**生成的弱随机串，非秘密，
 * 本模块不参与它的生成（取证 legacy-spec/mp-client-contract.md §3.6）。
 */
import { randomBytes, randomUUID } from 'node:crypto'

/** 配对通道 id 的前缀。小程序把它当 convId 持久化并参与密钥派生，前缀不能改。 */
export const CONVERSATION_ID_PREFIX = 'c_'

/** `c_` + 12 位 hex（48 bit）。它是路由凭证，不是密钥。 */
export function newConversationId(): string {
  return CONVERSATION_ID_PREFIX + randomBytes(6).toString('hex')
}

/** host 身份 id；缺省由中继分配，8 位 hex 够人读也够短。 */
export function newHostId(): string {
  return randomBytes(4).toString('hex')
}

/** 命令关联 id。回执靠它对答，必须原样回传。 */
export function newCmdId(): string {
  return randomUUID()
}

/** 是否像一个配对通道 id（用于入站帧的粗筛，不做安全判断）。 */
export function looksLikeConversationId(value: string): boolean {
  return value.startsWith(CONVERSATION_ID_PREFIX) && /^[0-9a-f]{12}$/.test(value.slice(CONVERSATION_ID_PREFIX.length))
}
