/**
 * test-platform — 测试装置的平台化辅助（A5）。
 *
 * ## 为什么要有它
 *
 * v2 的测试装置里有**四类**平台假设散在 8 个文件里（V3-PLAN §6.6 点名的那四类）：
 *
 * | 类别 | v2 的样子 | 在 Windows 上 |
 * |---|---|---|
 * | 权限断言 | `statSync(f).mode & 0o777 === 0o600` | 永远不成立（`chmod` 只切只读位）⇒ **恒红** |
 * | 只读目录前置 | `chmodSync(dir, 0o500)` | 造不出来 ⇒ 用例**前提不成立**却仍显示通过（假绿） |
 * | URL 取路径 | `new URL(…, import.meta.url).pathname` | 路径含空格/中文时是 URL 编码 ⇒ 产物找不到 |
 * | 夹具路径 | 写死 `/Users/x/…` | 与本机无关，但换用户名就失效 |
 *
 * 前两类最危险的不是红，是**假绿**：用例的"前提"造不出来时，测试照样报 pass，
 * 而它其实什么都没测。
 *
 * ## 两条纪律
 *
 * 1. **skip 必须带原因**（V3-PLAN A5：win32 的 skip 必须显式且带原因）。
 *    否则 CI 变绿时没人知道它其实没测——而"看起来测过"比"明摆着没测"更坏。
 * 2. **平台相关的逻辑要能注入**：判据在 macOS 上就能验 win32 的行为，
 *    不必等 CI 上真的 Windows 才第一次知道它没写（这与 `platform/paths.ts` 同一个思路）。
 *
 * ## 用法
 *
 * ```ts
 * import { POSIX_ONLY, tmpPath } from './test-platform.js'
 *
 * test('POSIX 上权限真的收紧', POSIX_ONLY, () => { … })
 * test('回落到平台无关的形态', () => { … })
 * ```
 */

/** 平台标识。与 `process.platform` 同形，但可注入。 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type TestPlatform = 'darwin' | 'linux' | 'win32'

export function currentPlatform(): TestPlatform {
  return process.platform as TestPlatform
}

/** 这个平台上「POSIX 权限位」这套语义成立吗？ */
export function hasPosixModes(platform: TestPlatform = currentPlatform()): boolean {
  return platform !== 'win32'
}

/**
 * 给 node:test 的 `skip` 选项：**只在 win32 上跳过，且原因写进测试输出**。
 *
 * 形态是 `{ skip: <false | 原因字符串> }`——node:test 接受 false（不跳）与字符串（跳并说明原因）。
 */
export function skipUnlessPosix(platform: TestPlatform = currentPlatform()): { skip: false | string } {
  return {
    skip: hasPosixModes(platform) ? false : 'win32 没有 POSIX 权限位：chmod 只切只读位，0o600 类断言不成立',
  }
}

/**
 * **实测**这台机器能不能造出"写不进去的目录"。
 *
 * ⚠️ 为什么必须是实测而不是问平台（2026-10-08 在 Linux 容器里抓到的）：
 * `hasPosixModes()` 只回答"有没有权限位"，而**权限位不等于拦得住写**——
 * Linux 上以 **root** 跑时（CI 的容器、很多开发机的 docker），
 * `chmod 0500` 的目录照样写得进去。于是"目录不可写 ⇒ 退回一次性身份"那条用例
 * 的**前提不成立**：它本该验"写失败时怎么办"，实际验的是"写得进去时怎么办"，
 * 而断言仍会红——红的原因还指不到真地方。
 *
 * 探针只做一次（模块级缓存）：造临时目录 → chmod 0500 → 试着写一个文件。
 */
let canMakeDirUnwritable: boolean | undefined
export function canBlockDirWrites(): boolean {
  if (canMakeDirUnwritable !== undefined) return canMakeDirUnwritable
  const dir = mkdtempSync(join(tmpdir(), 'drc-rocheck-'))
  const locked = join(dir, 'locked')
  try {
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    canMakeDirUnwritable = false
    try {
      writeFileSync(join(locked, 'probe'), 'x')
    } catch {
      canMakeDirUnwritable = true
    }
  } finally {
    try {
      chmodSync(locked, 0o700)
    } catch {
      /* 探针失败不该影响结论 */
    }
    rmSync(dir, { recursive: true, force: true })
  }
  return canMakeDirUnwritable
}

/** 造只读目录的用例在"这台机器造不出来"时要跳（原因要能指到是哪一种造不出来）。 */
export function skipIfCannotChmodDir(platform: TestPlatform = currentPlatform()): { skip: false | string } {
  if (!hasPosixModes(platform)) {
    return { skip: 'win32 的 chmod 不支持只读目录（0o500）：这个用例的前置条件造不出来，跳过而不是假装通过' }
  }
  if (!canBlockDirWrites()) {
    return {
      skip:
        '这台机器上 chmod 0500 拦不住写（Linux 以 root 运行时就是这样）：' +
        '"目录不可写"这个前提不成立，跳过而不是让断言红在一个指不到真地方的错误上',
    }
  }
  return { skip: false }
}

/**
 * 一条与平台无关的临时路径。
 *
 * v2 的夹具写死 `/Users/x/…`：在别的用户名下失效，而在 Windows 上它只是个
 * 不存在的字符串。这里给的是**平台自己的形状**——断言里比较的是"basename 是不是
 * 期望值"，所以路径必须长得像本机的。
 */
export function platformPath(...segments: string[]): string {
  const sep = currentPlatform() === 'win32' ? '\\' : '/'
  const root = currentPlatform() === 'win32' ? 'C:\\Users\\tester' : '/Users/tester'
  return [root, ...segments].join(sep)
}

/** 文件名里不允许的字符（Windows 禁止 `: * ? " < > |`）。 */
export function illegalFileNameChars(): RegExp {
  return currentPlatform() === 'win32' ? /[:*?"<>|]/ : /^$/
}
