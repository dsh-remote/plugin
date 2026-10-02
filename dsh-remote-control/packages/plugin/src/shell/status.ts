/**
 * status — 运行状态快照（`~/.dsh/dsh-remote-control/status.json`）。
 *
 * 为什么非有不可：宿主是 GUI 应用，stdout 没人看，插件"没反应"时用户与开发者
 * 都没有入口。旧实现把它做成排错第一入口，靠两个字段区分了两类完全不同的故障——
 * `carrier`（`services` 真内核 / `mock` 内存替身 / `none` 配置不合法）
 * 与 `relay` + `relayProblem`（连不上中继还是内核没接上）。
 * 取证 docs/legacy-spec/host-plugin-cordis.md §5.3。
 *
 * 三条实现要求：
 * 1. **0600 + 临时文件改名**。文件里可能出现"仍然有效的配对码 + PSK"（pairOnStartSec），
 *    半写状态被读到也会让人误判。
 * 2. **绝不含 token**（测试断言 `hostToken` 这个键不存在，只能出现脱敏形态）。
 * 3. **按定时器刷新，不按消费刷新**。这条不是偷懒：它决定了外部脚本只能接受
 *    "年龄 < 25s 且本轮未用过"的配对码（取证 HANDOFF.md §4.5 第 3 条）。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Clock, StatusSink } from '../ports/index.js'

type StatusValue = unknown

export class StatusFile implements StatusSink {
  private timer: unknown
  private lastWritten = 0

  constructor(
    private readonly file: string,
    private readonly clock: Clock,
    private readonly refreshMs = 3000,
  ) {}

  write(snapshot: Record<string, unknown>): void {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}`
      // mode 在文件已存在时不生效，所以再 chmod 一次。
      writeFileSync(
        tmp,
        JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString(), pid: process.pid }, null, 2) + '\n',
        {
          mode: 0o600,
        },
      )
      renameSync(tmp, this.file)
      this.lastWritten = this.clock.now()
    } catch {
      // 快照写失败绝不能影响主流程；排错入口没了是遗憾，插件崩了是事故。
    }
  }

  /**
   * 打开定时器刷新（调用方提供的是**纯构造器**：只负责返回当下最新的状态）。
   *
   * 写盘这件事归本类，不归调用方：第一版这里只 `refresh()` 把返回值丢掉了，
   * 于是 status.json 永远停在启动那一版——而 live-e2e 与外部脚本取配对码读的就是
   * 这个文件（取证 docs/legacy-spec/host-plugin-cordis.md §5.3 的"年龄 < 25s"判据）。
   * 更糟的是 `carrier`/`relay` 再也不更新，GUI 宿主里唯一的排错入口变成了死数据。
   */
  start(refresh: () => Record<string, unknown>): void {
    if (!this.file || this.timer !== undefined) return
    const tick = (): void => {
      // 先续期再写：写盘内部已经吞异常，但构造器是调用方的代码，
      // 它抛了也不该让刷新节拍断掉——节拍一断就等于回到"停在启动那一版"。
      this.timer = this.clock.setTimeout(tick, this.refreshMs)
      try {
        this.write(refresh())
      } catch {
        /* 同上：状态入口不许成为崩溃源 */
      }
    }
    this.timer = this.clock.setTimeout(tick, this.refreshMs)
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** 此刻是否在按节拍刷新（测试与 status 自身的 `refreshing` 字段读它）。 */
  get refreshing(): boolean {
    return this.timer !== undefined
  }

  get path(): string {
    return this.file
  }
}

/**
 * 配对二维码 PNG 的落点（0600）：**当前会话的工作区**下的 `.dsh/pairing-qr.png`。
 *
 * 2026-10-02 用户拍板改的落点（原话「要保存到工作区的 .dsh 不是 home 下的 .dsh」）：
 * 二维码属于"这次配对属于哪个项目"这件事，跟着会话的工作区走比跟着 home 走更符合直觉，
 * 也不会在用户机器上多出一个与项目无关的固定文件。
 *
 * `workspaceDir` 解析不出来时退回 `~/.dsh/pairing-qr.png`（配置目录根部）——**不是**退回
 * 与 status.json 同目录：PNG 是给用户/扫码器看的东西，不该埋进 `~/.dsh/dsh-remote-control/`
 * 这个实现目录里。
 *
 * statusFile 只当开关用——空串表示这一行没配过，此时返回空串，调用方据此退回文本码
 * （空串路径绝不能去 `path.join`，否则 PNG 会写到进程 CWD）。
 */
export function pairingImagePath(statusFile: string, workspaceDir?: string): string {
  if (!statusFile) return ''
  if (workspaceDir) return path.join(workspaceDir, '.dsh', 'pairing-qr.png')
  return path.join(homedir(), '.dsh', 'pairing-qr.png')
}

export function writePrivateFile(file: string, data: Buffer | string): boolean {
  if (!file) return false
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, data, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}
