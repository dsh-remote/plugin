/**
 * sleep-posix — `SleepPort` 的系统工具实现（macOS `caffeinate` / Linux `systemd-inhibit`）。
 *
 * 为什么用外部命令而不是自研或引 npm 库：第三方睡眠抑制库本质也是 spawn 这两个工具，
 * 而直接 spawn 换来的是"锁的生命周期可以由 pid 绑定来表达"。
 *
 * 三处必须留住的细节（都出自取证 docs/legacy-spec/relay-and-wireformat.md §6）：
 * - macOS 带 `-w <pid>`：**断言寿命绑到宿主进程**，宿主崩了锁随之消失，
 *   不会留下一台永远不睡机的机器；整套方案不需要 sudo。
 * - 子进程 `stdio:'ignore'` + `unref()`：插件跑在 GUI 宿主进程里，
 *   不 unref 会吊住事件循环，不 ignore 会让 caffeinate 的输出污染宿主 stdout。
 * - 失败原因（spawn error 或 exit code）要能被上层拿到，最终进
 *   `ev.keep_awake_state.reason`，手机上看得到"为什么没锁上"。
 *
 * Windows 不实现（本版明确不做，见 docs/DESIGN.md §7.2）：只有一个从未在真机验证过的
 * 内联 powershell 构造器，等于把验证不了的代码写进仓库。这里返回 unsupported，
 * 手机端与 status.json 都会如实显示。
 */
import { spawn } from 'node:child_process'
import { buildSleepCommand, detectBackend, isSleepSupported } from 'dsh-remote-wire'
import type { SleepPort } from '../ports/index.js'

export class SystemSleepBackend implements SleepPort {
  private child: ReturnType<typeof spawn> | undefined
  private lastError: string | undefined
  /** 平台名是构造时定下的，不与接口方法 `platform()` 同名。 */
  private readonly osName: string

  constructor(platform: string = process.platform) {
    this.osName = platform
  }

  backend(): string {
    return detectBackend(this.osName)
  }

  platform(): string {
    return this.osName
  }

  isActive(): boolean {
    return this.child !== undefined
  }

  start(ownerPid: number, keepDisplay: boolean): { ok: boolean; message?: string } {
    if (!isSleepSupported(this.osName)) {
      const message = `${this.osName} 没有受支持的防休眠后端`
      this.lastError = message
      return { ok: false, message }
    }
    if (this.child) return { ok: true }
    const command = buildSleepCommand(this.osName, ownerPid, keepDisplay)
    if (!command) {
      const message = '防休眠命令构造失败'
      this.lastError = message
      return { ok: false, message }
    }
    try {
      const child = spawn(command.command, command.args, { stdio: 'ignore' })
      child.on('error', (error) => {
        this.lastError = String(error?.message ?? error)
        // 与 exit 同一个守卫：spawn 失败是**异步**报的，旧 child 的错误若把**新** child
        // 的句柄清成 undefined，`stop()` 就再也杀不掉那个仍在跑的 caffeinate——
        // 断言的寿命绑在宿主 pid 上（`-w <pid>`）也救不了这一次，因为句柄已经丢了。
        if (this.child === child) this.child = undefined
      })
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) this.lastError = `${command.command} 退出码 ${code}`
        if (this.child === child) this.child = undefined
      })
      child.unref()
      this.child = child
      this.lastError = undefined
      return { ok: true }
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      this.lastError = message
      return { ok: false, message }
    }
  }

  stop(): void {
    const child = this.child
    this.child = undefined
    if (!child) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已经退了 */
    }
  }

  get error(): string | undefined {
    return this.lastError
  }
}
