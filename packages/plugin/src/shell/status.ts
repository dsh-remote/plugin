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
      writeFileSync(tmp, JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString(), pid: process.pid }, null, 2) + '\n', {
        mode: 0o600,
      })
      renameSync(tmp, this.file)
      this.lastWritten = this.clock.now()
    } catch {
      // 快照写失败绝不能影响主流程；排错入口没了是遗憾，插件崩了是事故。
    }
  }

  /** 打开定时器刷新（调用方负责在每次 tick 里提供最新状态）。 */
  start(refresh: () => Record<string, unknown>): void {
    if (!this.file || this.timer !== undefined) return
    const tick = (): void => {
      refresh()
      this.timer = this.clock.setTimeout(tick, this.refreshMs)
    }
    this.timer = this.clock.setTimeout(tick, this.refreshMs)
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  get path(): string {
    return this.file
  }
}

/** 配对二维码 PNG 的落点（与 status.json 同目录，同样 0600）。 */
export function pairingImagePath(statusFile: string): string {
  if (!statusFile) return ''
  return path.join(path.dirname(statusFile), 'pairing-qr.png')
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
