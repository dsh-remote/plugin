/**
 * SecureFilePort — 凭据类文件的落盘模式，**一处**。
 *
 * ## 为什么要有它
 *
 * v2 有**五处**几乎相同的代码（`shell/{status,pair-store,host-id,uploads}.ts`
 * 与 relay 的 `src/persist.ts`），每一处都是 `{ mode: 0o600 }` + `chmodSync(0o600)`
 * + `renameSync`，而**每一处都带一段自己的注释解释"为什么这两句不能省"**。
 *
 * 五份注释说的是同一件事，这意味着：
 *
 * - 修一处（比如加 fsync）要记得改另外四处，漏掉的后果是**四种不同的故障形状**；
 * - 更糟的是它们**已经漂移了**：relay 那份多了一次 `unlinkSync(tmp)`（防 pid 复用残留），
 *   其余四处没有——而它们的 tmp 名都带 pid，暴露面完全一样。
 *
 * ## 这个端口提供的三件事
 *
 * 1. **`writeSecure`** — 原子写一个 0600 文件：清残留 → tmp → chmod → fsync → rename。
 * 2. **平台权限语义**（`chmodEffective`）— Windows 上 `chmod` **只切只读位**，
 *    `0o600` 静默失效。本端口在 win32 上**显式 warn 一次**，不许假装生效。
 * 3. **Windows 保留名**（`safeFileName`）— 附件落盘用；`CON` / `PRN` / `con.txt`
 *    在 Windows 上是设备，`writeFileSync` 抛 EINVAL，**整批附件回滚**。
 *
 * ## ⚠️ win32 的权限现实：这里只能"如实说"，不能"修好"
 *
 * Node 的 `chmod` 在 Windows 上只映射到只读属性，**没有 POSIX 权限位**。
 * 要真正的 ACL 得用原生调用，而本项目至今**零原生依赖**（见 V3-PLAN §8.4 的同一条理由）。
 * 所以这里的出口是：**显式 warn 一次**，让运维知道"这台机器上没有 0600 这回事，
 * 请改用 NTFS ACL 或换 POSIX 平台"——而不是静默地把 `mode: 0o600` 当成已生效。
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Platform } from './paths.js'
import { currentPlatform } from './paths.js'

/** 凭据文件的权限位。POSIX 上是"仅属主可读写"。 */
const SECURE_MODE = 0o600

/**
 * **敏感目录**的权限位（2026-10-13 补）：仅属主可读写**并可列出**。
 *
 * 文件是 0600 就够了，目录还差一条"别人不能列"——目录里躺着的文件名本身
 * 就是信息（会话 id、用户上传的文件名）。见 {@link ensureSecureDir}。
 */
const SECURE_DIR_MODE = 0o700

/** 一次性的平台告警闸：同一进程里同类告警只发一次（否则每 5 秒刷屏）。 */
const warned = new Set<string>()
let warnCount = 0

/**
 * 已发出的 warn 条数（单调递增）。
 *
 * 存在的理由不是"给测试数着玩"：周期补写每 60 秒跑一次，而一条被吞掉的 warn 在
 * 日志里**看起来与没有告警完全一样**。留一个可读的计数，排错时能回答
 * "这台机器上到底有没有触发过权限告警"。
 *
 * 做成函数而不是 `export let`：ESM 的 live binding 在转译到 CJS 后读不到最新值，
 * 判据会读到 `undefined` 然后比较出 `NaN` —— 那正是「读不存在的字段 → 恒红」的坑。
 */
export function secureFileWarnCount(): number {
  return warnCount
}

/** 记一条 warn（同一 key 只记一次）。返回是否真的记了——判据要能断言"只 warn 一次"。 */
export function warnOnce(key: string, message: string): boolean {
  if (warned.has(key)) return false
  warned.add(key)
  warnCount += 1
  process.emitWarning(message, 'SecureFilePort')
  return true
}

/** 清掉告警闸（判据用：每条用例都要能重新观测到首次告警）。 */
export function resetSecureFileWarnings(): void {
  warned.clear()
}

/**
 * 这个平台上，`chmod(path, 0o600)` 是不是真的把权限收成 0600。
 *
 * - POSIX：是。`mode` 也真的生效。
 * - Windows：**否**。`chmod` 只切只读位，`0o600` 的"属主可读写"语义不存在。
 *
 * 这条判断存在的意义是：**让"权限已收紧"这句话在 Windows 上不被说出口**。
 */
export function chmodEffective(platform: Platform = currentPlatform()): boolean {
  return platform !== 'win32'
}

export interface WriteSecureOptions {
  encoding?: BufferEncoding
  /** 抢注：文件已存在就抛（`host-id.ts` 的两个实例抢身份那条路要它）。 */
  flag?: 'w' | 'wx'
  /** fsync 内容与父目录（默认都开；测试可关掉提速）。 */
  fsync?: boolean
  platform?: Platform
}

/**
 * 原子写一个凭据文件：清残留 → tmp → chmod → fsync → rename。
 *
 * ## 每一步都不能省的原因（五处旧注释的合并版）
 *
 * 1. **tmp 与目标同目录** — rename 只在同文件系统内原子。跨目录的 tmp 会退化成
 *    "复制 + 删除"，中途断电就是一个半截文件。
 * 2. **先删同 pid 的残留** — tmp 名带 pid，而 `mode` **只在创建那一刻生效**。
 *    pid 被复用时 `writeFileSync` 会写到上一位留下的 0644 上（沿用它的权限），
 *    rename 之后最终文件也就是 0644。v2 只有 relay 做了这一步，其余四处都暴露在同一个洞里。
 * 3. **显式 `chmod 0600`** — 同上，覆盖写不会收紧已有权限。
 * 4. **fsync 之后再 rename** — rename 只对两种读者成立：并发的另一个进程，
 *    以及**进程**崩溃。它管不到**掉电**：没有 fsync，rename 可能已落进目录，
 *    而 tmp 的内容还在 page cache 里，回电后得到一个**长度正确、内容全零或半截**的文件
 *    ——所有配对作废、所有手机回电脑前重扫。而"落盘"这个特性存在的唯一理由恰恰是消灭这个症状。
 * 5. **fsync 父目录** — rename 本身也要落盘，否则掉电后可能"文件在、名字不在"。
 *    Windows 上目录不能这样打开，**静默跳过**（它只是加固，不是正确性）。
 */
export function writeSecure(target: string, body: string | Uint8Array, options: WriteSecureOptions = {}): void {
  const { encoding = 'utf8', flag = 'w', fsync = true, platform = currentPlatform() } = options
  const tmp = `${target}.tmp-${process.pid}`
  try {
    writeSecureInner(target, body, tmp, { encoding, flag, fsync, platform })
  } catch (error) {
    // 失败路径清 tmp：写出来、rename 之前失败时，tmp 里躺着**上一次**的内容。
    // 留着它有两个害处：① 下一次成功路径上的垃圾；② 更要紧的是——读它比读不到更糟
    // （那份内容是旧的，而调用方以为它是新的）。**读不到才是安全侧。**
    //
    // v2 里这条逻辑被抄在 `pair-store.ts` 的 catch 里（它得自己拼 tmp 名才能删），
    // 于是只保护了五处写盘里的一处。收敛到端口之后，**每一处**都自动获得这条保护。
    try {
      unlinkSync(tmp)
    } catch {
      /* 本来就没有 */
    }
    throw error
  }
}

function writeSecureInner(
  target: string,
  body: string | Uint8Array,
  tmp: string,
  options: Required<Omit<WriteSecureOptions, 'platform'>> & { platform: Platform },
): void {
  const { encoding, flag, fsync, platform } = options

  // 第 2 条：清掉同 pid 的残留。ENOENT 正是我们要的。
  try {
    unlinkSync(tmp)
  } catch {
    /* 没有残留 */
  }

  // 'wx' = 独占创建：两个实例同时写同一个 tmp 时只有一个成功（另一个去报 ENOENT 那条路）。
  const createFlag = flag === 'wx' ? 'wx' : 'w'
  if (typeof body === 'string') writeFileSync(tmp, body, { encoding, mode: SECURE_MODE, flag: createFlag })
  else writeFileSync(tmp, body, { mode: SECURE_MODE, flag: createFlag })

  // 第 3 条
  chmodSync(tmp, SECURE_MODE)
  if (!chmodEffective(platform)) {
    // ⚠️ 不许静默：调用方以为"0600 已生效"，实际这台机器上没有权限位这回事。
    warnOnce(
      'chmod-noop',
      `SecureFilePort：当前平台（${platform}）上 chmod 只切只读位，0o600 **没有生效**。` +
        '请改用 NTFS ACL 或把凭据放到 POSIX 平台上（这批文件里可能有 PSK 与 hostToken）。',
    )
  }

  // 第 4 条：内容先落盘，再 rename。
  if (fsync) {
    try {
      const fd = openSync(tmp, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      /* 部分文件系统不支持对文件 fsync；rename 的原子性仍成立 */
    }
  }

  renameSync(tmp, target)

  // 第 5 条
  if (fsync) {
    try {
      const fd = openSync(path.dirname(target), 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      // Windows 上目录不能这样 fsync —— 静默跳过（加固，不是正确性）
    }
  }
}

/**
 * **敏感目录**的创建与收紧（2026-10-13 第六轮 review 补）。
 *
 * ## 为什么文件加固了而目录没有
 *
 * 落盘端口把**文件**收成 0600（`writeSecure` 的五步：临时名 → 显式 chmod → fsync → rename → fsync 父目录），
 * 而三处**目录**都是 `mkdirSync(dir, { recursive: true })` —— 不带 `mode` ⇒ 用进程 umask，
 * 典型是 **0755**。后果：
 *
 * - 别的本地用户能**列出**这些目录：`~/.dsh/dsh-remote-control/`（会话 id、附件文件名）、
 *   配对密钥簿目录（会话 id）、附件目录（用户上传的文件名，往往本身就说明了内容）。
 *   文件**内容**仍读不到（0600），泄露的是**名字**。
 * - umask 宽松时（systemd 默认 `UMask=0022`，但容器与自建服务常见 `0000`）目录会变成 **0777**：
 *   别的本地用户能在里面**删/替换**文件。而 `conversations-<hostId>.json` 里是**每个会话的
 *   PSK**，附件路径则被写进 prompt 正文交给 Agent 读 ⇒ 那是"换内容"的路径，不只是"看得见"。
 *
 * ## 与文档的关系（这正是它算缺陷而不算"顺手加固"的原因）
 *
 * README 的「设计上的三条硬线」第 2 条写着：凭据落盘一律 0600，`status.json`、配对密钥簿、
 * 宿主身份文件、**附件目录**都走同一个落盘端口。前三项与附件的**文件**确实走了，
 * **目录本身没走** ⇒ 那句话当时是不成立的。
 *
 * ## 为什么必须显式 `chmod`（而不是只给 `mode`）
 *
 * 与 `writeSecure` 第 2/3 条同一条理由：`mode` **只在创建那一刻生效**，而 `recursive: true`
 * 遇到**已存在**的目录会直接返回 ⇒ 一条 0755 的老目录永远收不紧。所以两步都要：
 * `mkdir({ mode })` + `chmodSync`。
 *
 * win32 上 `chmod` 只切只读位、目录权限语义不存在（见文件头），因此那里**跳过 chmod**，
 * 不假装生效、也不为此发警告（目录权限在 NTFS 上由 ACL 决定，不是本端口该管的事）。
 */
export function ensureSecureDir(dir: string, platform: Platform = currentPlatform()): void {
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE })
  if (!chmodEffective(platform)) return
  /**
   * ⚠️ **只收窄，不改属主已经收紧过的目录**（2026-10-13，`pair-store.test.ts` 抓到的）。
   *
   * 判据里有一条"目录是只读（0500）时 save 必须优雅失败而不是抛"，而第一版这里
   * 无条件 `chmod 0700` ⇒ 把运维刻意设的只读**改回可写** ⇒ 那条判据红了，
   * 而它红得有道理：**插件不该改一个自己没有设过的权限**（共享目录、按组授权的部署都会被它破坏）。
   *
   * ⇒ 规则收成：**组/他人两位上还有 1 才收**（0755 / 0777 → 0700），
   *   已经只属主的（0700、以及运维设的 0500）**一律不碰**。
   */
  let mode: number
  try {
    mode = statSync(dir).mode & 0o777
  } catch {
    return // 刚建出来又读不到？读不到就交给真正写它的那次报错，不在这里猜
  }
  if ((mode & 0o077) === 0) return
  try {
    chmodSync(dir, SECURE_DIR_MODE)
  } catch (error) {
    // 收不紧就照实说，但不抛：加固失败不该让整个插件起不来（那比目录宽一点更糟）。
    warnOnce(
      'secure-dir-mode',
      `SecureFilePort：目录 ${dir} 收不紧到 0700（${String((error as Error)?.message ?? error).slice(0, 80)}）。` +
        '它仍然只有属主能写文件，但**别的本地用户能列出里面的文件名**。',
    )
  }
}

/**
 * Windows 的保留设备名。`con.txt` 与 `CON` **同样**是保留的（扩展名不解除保留），
 * 而 v2 的 `safeSegment` 只留 `[A-Za-z0-9._-]`，完全没拦这一类 ——
 * 症状是 `writeFileSync` 抛 EINVAL，**整批附件回滚**（用户传了 3 张图，一张叫 CON 就全没了）。
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * 把一段文件名修成在三个平台上都能安全创建的样子。
 *
 * 规则：保留名加前缀 `file-`（不是加下划线——那仍然保留）；其余非法字符换成 `-`；
 * 扩展名原样保留（`con.txt` → `file-con.txt`）。
 */
export function safeFileName(name: string): string {
  if (WIN_RESERVED.test(name)) return `file-${name}`
  return name.replace(/[^A-Za-z0-9._-]/g, '-')
}
