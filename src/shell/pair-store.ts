/**
 * pair-store — 配对通道密钥簿的落盘（`~/.dsh/dsh-remote-control/conversations-<hostId>.json`）。
 *
 * ## 为什么必须有它
 *
 * 没有它时，主机每重启一次就丢掉全部配对通道的密钥，于是手机必须重新扫码 ——
 * 这让"dsh 自举迭代"（改代码 → 重装 → 重启）每次都要人回到机器前。
 * 修法是让密钥簿跨进程存活：`(psk, convId)` 能重新派生出两把方向密钥（B5），
 * 而手机侧的 `installId` 与 `convId` 本来就持久化在 wx storage 里（`core/session-store.js`），
 * 所以**手机侧一个字都不用改**，只要主机还能算出同一份密钥。
 *
 * ## 为什么这不扩大攻击面
 *
 * 落点这个目录里**今天就已经躺着 PSK 了**：`status.json` 在 `pairOnStartSec > 0` 时
 * 会写出仍然有效的配对码与 PSK（`index.ts` 的 `describeActivePairing` 真的返回 `psk`），
 * `host-id` 也是这里的持久凭据。落盘做的事是「把每次重启换一把」变成「长期持有一把」——
 * 同一份材料，只是生命周期变了。真正的信任边界（中继不可信）由**密钥从不上网**保证
 * （`frames.ts` 的 D1），本文件完全在主机本地，不改变那一条。
 *
 * ## 三条纪律（与 `shell/host-id.ts` 逐字同形，抄错一处就是权限或竞态事故）
 *
 * 1. **0600，且每次都 chmod**：文件里是全部历史会话的 PSK，与 status.json 同一目录。
 * 2. **临时文件 + rename**：半写的 JSON 被读到会被当成"没有会话"，于是主机把还在有效期内的
 *    配对全清掉 —— 症状与"落盘没生效"完全一样，极难区分。宁可先写全再改名。
 * 3. **读不到 / 写不进 / 形状不认识，一律降级成"没有会话"，绝不抛**。插件起不来比丢配对更糟
 *    （`index.ts` 的红线：apply() 不许向外抛）。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'

/** 一条可持久化的会话记录。**刻意不含 `clientIds`**：成员表是"此刻谁连着"的瞬时态，
 *  进程重启后那一刻一定是空的（没人连着主机）。落盘它会让主机一启动就以为"有人在听"，
 *  于是往每条会话广播 —— 而手机端还没重连，那些帧全被中继计成丢帧
 *  （正是 `relay.ts` 的 `broadcast` 里那个 `hasClient` 闸门当初要防的事）。
 *  手机回来后它发的第一帧会通过 `onEncrypted` 把 clientId 重新登记进来。 */
export const storedConversationSchema = z.object({
  id: z.string().min(1),
  /** 配对 PSK（base64）。两把方向密钥在恢复时由它现派生，不落盘。 */
  psk: z.string().min(1),
  /** host→client 方向的本地序号。中继会重新编号，客户端从不读它（F13），
   *  但保留它能让恢复后的编号不跳号，便于对拍排查。 */
  seqHost: z.number().int().nonnegative(),
  createdAt: z.number().finite().nonnegative(),
  lastActivityAt: z.number().finite().nonnegative(),
})
export type StoredConversation = z.infer<typeof storedConversationSchema>

const storeSchema = z.object({
  version: z.literal(1),
  /** 这个文件属于哪台主机：换了主机身份就不该认（凭据不该跨身份复用）。 */
  hostId: z.string().min(1),
  savedAt: z.number().finite().nonnegative(),
  conversations: z.array(storedConversationSchema),
})

/** 文件名里允许出现的字符；其余一律替换。**hostId 由配置给，不经 host-id.ts 那道正则，
 *  所以做文件名之前必须自己收窄** —— 否则一个含 `/` 的 hostId 就能把文件写到目录外面去。 */
function safeSegment(hostId: string): string {
  const cleaned = hostId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)
  // 收窄后可能撞名（`a/b` 与 `a_b`），补一段 hostId 的哈希让文件名唯一。
  const tag = createHash('sha256').update(hostId).digest('hex').slice(0, 8)
  return `${cleaned || 'host'}-${tag}`
}

/** 落点：`status.json` 同目录，文件名带上 hostId 片段（见 {@link safeSegment} 的理由）。 */
export function defaultPairStoreFile(statusFile: string, hostId: string): string {
  if (!statusFile) return ''
  return path.join(path.dirname(statusFile), `conversations-${safeSegment(hostId)}.json`)
}

export interface PairStoreOptions {
  file: string
  hostId: string
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

/**
 * 密钥簿的读写面。
 *
 * **不缓存**：每次 `load` 都真读盘，每次 `save` 都真写盘。缓存会引入两个很坏的状态
 * （"改了内存没落盘"、"换了进程读到上一进程的内存"），而这里的读写量是
 * 一次配对 + 每 3 秒最多一次 —— 缓存换不来任何东西。
 */
export class PairStore {
  /** 上一次成功写盘的时刻，供 status.json 回答"这份落盘是什么时候的"。 */
  private savedAt = 0
  /** 上次 save 之后发生过任何变化（含只改了 lastActivityAt）。 */
  private dirty = false

  constructor(private readonly options: PairStoreOptions) {}

  get file(): string {
    return this.options.file
  }

  get lastSavedAt(): number {
    return this.savedAt
  }

  /** 有没有待落盘的变更。status 的 3 秒 tick 用它决定是否真写盘。 */
  get hasPendingChanges(): boolean {
    return this.dirty
  }

  /** 只标脏，不写盘。高频变动（每次广播都动 `seqHost`）走这条。 */
  markDirty(): void {
    this.dirty = true
  }

  /**
   * 读回本机的会话记录。
   *
   * 三种"读不出来"都归到**空簿 + 一条日志**，绝不抛（红线：插件起不来比丢配对更糟）：
   * 文件不存在（第一次跑）、JSON 坏了（半写/被手改）、形状不认识（版本升级）。
   * `hostId` 不匹配也算读不出来：那份文件属于另一台主机。
   */
  load(): StoredConversation[] {
    const { file, hostId, log } = this.options
    if (!file) return []
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      // 读不到的第一名原因是"还没写过"，所以这条不记 warn —— 否则每次启动都刷一条假警报。
      return []
    }
    const parsed = storeSchema.safeParse(safeJsonParse(raw))
    if (!parsed.success) {
      log?.('pair-store unreadable, starting with an empty book', {
        reason: parsed.error.issues[0]?.message?.slice(0, 80) ?? 'shape mismatch',
      })
      return []
    }
    if (parsed.data.hostId !== hostId) {
      // 不是错误：同一台机器上换一个 hostId 重启是正常操作（配置改了一行）。
      log?.('pair-store belongs to another host, starting with an empty book', {
        fileHostId: parsed.data.hostId.slice(0, 24),
      })
      return []
    }
    this.savedAt = parsed.data.savedAt
    return parsed.data.conversations
  }

  /**
   * 写盘。**结构性的变化（新建/作废会话）必须立刻调这个**；
   * 只改了 `lastActivityAt`/`seqHost` 的场合走 {@link markDirty}，由 3 秒 tick 批量落。
   *
   * 失败只记日志：写不进盘（目录只读、磁盘满）时，本次运行仍能正常收发，
   * 只是下次重启要重新扫码 —— 那是可接受的退化，让插件崩掉不是。
   */
  save(conversations: readonly StoredConversation[], now: number): boolean {
    const { file, hostId, log } = this.options
    if (!file) return false
    const body = JSON.stringify({ version: 1, hostId, savedAt: now, conversations }) + '\n'
    const tmp = `${file}.tmp-${process.pid}`
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
      // mode 只在**创建**时生效，覆盖写不会收紧已有权限 —— 这个目录里同时住着配对凭据，补一次。
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
      this.savedAt = now
      this.dirty = false
      return true
    } catch (error) {
      /**
       * **失败之后必须保持脏**（2026-10-06）。
       *
       * 结构性变化（新配对建立的 PSK、会话作废）走的是"立刻 save"这条路；写盘失败时
       * 若把 dirty 复位成 false，`status` 的 3 秒 tick 看到 `hasPendingChanges=false`
       * 就**再也不会重试** —— 新配对的 PSK 静默不落盘，用户下一次重启面对的是
       * "明明配过还要重新扫码"。保持脏，下一个 tick 会再试一次。
       */
      this.dirty = true
      log?.('pair-store save failed (pairing will need a rescan after the next restart)', {
        message: String((error as Error)?.message ?? error).slice(0, 120),
      })
      // 临时文件留着会变成下一次成功路径上的垃圾：先写出来、后 rename 失败的场景下，
      // 它的内容是**上一次**的簿，读它比读不到更糟。删掉，读不到才是安全侧。
      try {
        unlinkSync(tmp)
      } catch {
        /* 本来就没有 */
      }
      return false
    }
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
