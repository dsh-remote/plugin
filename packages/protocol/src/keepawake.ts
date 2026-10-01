/**
 * Cross-platform keep-awake (防休眠) manager for the DSH Remote Control host.
 *
 * Design (mirrors what Claude Code / Qoder desktop & Happy do):
 *  - macOS  : spawn `/usr/bin/caffeinate -i -s -w <pid>` (IOPMAssertion for
 *             idle + system sleep, bound to our lifetime). No sudo needed.
 *  - Linux  : `systemd-inhibit --what=idle:sleep --mode=block` when present.
 *  - Windows: reserved hook — SetThreadExecutionState via PowerShell P/Invoke
 *             (see windowsExecutionStateCommand); disabled by default.
 *
 * Activity-driven policy: `markActive()` while a session is running or a
 * permission/question is pending; the lock auto-releases after `idleReleaseMs`
 * of no activity (default 300s) so the laptop still sleeps when idle.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { platform } from 'node:os'

export interface KeepAwakeOptions {
  /** auto-release after this many idle ms; 0 = never auto-release */
  idleReleaseMs?: number
  /** also keep display awake (default false — screen still sleeps) */
  keepDisplay?: boolean
  onStateChange?: (s: KeepAwakeState) => void
}

export interface KeepAwakeState {
  enabled: boolean
  active: boolean
  platform: NodeJS.Platform
  backend: string
  reason?: string
}

export class KeepAwake {
  private proc: ChildProcess | null = null
  private enabled = false
  private lastActiveAt = 0
  private idleReleaseMs: number
  private keepDisplay: boolean
  private timer: NodeJS.Timeout | null = null
  private opts: KeepAwakeOptions
  private lastFailReason?: string

  constructor(opts: KeepAwakeOptions = {}) {
    this.opts = opts
    this.idleReleaseMs = opts.idleReleaseMs ?? 300_000
    this.keepDisplay = opts.keepDisplay ?? false
  }

  get state(): KeepAwakeState {
    return {
      enabled: this.enabled,
      active: this.proc !== null,
      platform: platform(),
      backend: this.detectBackend(),
      reason: this.lastFailReason,
    }
  }

  detectBackend(): string {
    switch (platform()) {
      case 'darwin':
        return 'caffeinate'
      case 'linux':
        return 'systemd-inhibit'
      case 'win32':
        return 'SetThreadExecutionState (powershell)'
      default:
        return 'unsupported'
    }
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.markActive()
    this.start()
    this.publish()
  }

  disable(reason = 'user'): void {
    if (!this.enabled) return
    this.enabled = false
    this.stop()
    void reason
    this.publish()
  }

  setIdleRelease(ms: number): void {
    this.idleReleaseMs = ms
    this.clearTimer()
    this.armSweep()
  }

  /** Called on session activity (prompt running, tool stream, pending approval). */
  markActive(): void {
    this.lastActiveAt = Date.now()
    if (this.enabled && this.proc === null) this.start()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private armSweep(): void {
    if (this.timer || !this.enabled) return
    this.timer = setInterval(() => {
      if (!this.enabled) return
      if (
        this.idleReleaseMs > 0 &&
        this.proc !== null &&
        Date.now() - this.lastActiveAt > this.idleReleaseMs
      ) {
        this.stop()
        this.publish()
      }
    }, 10_000)
    this.timer.unref?.()
  }

  private publish(): void {
    try {
      this.opts.onStateChange?.(this.state)
    } catch {
      /* ignore listener errors */
    }
  }

  private start(): void {
    if (this.proc) return
    this.lastFailReason = undefined
    const cmd = buildKeepAwakeCommand(platform(), process.pid, this.keepDisplay)
    if (!cmd) {
      this.lastFailReason = 'unsupported platform'
      return
    }
    try {
      const p = spawn(cmd.bin, cmd.args, { stdio: 'ignore' })
      p.on('error', (e) => {
        this.lastFailReason = String((e as Error)?.message ?? e)
        if (this.proc === p) this.proc = null
        this.publish()
      })
      p.on('exit', (code) => {
        if (this.proc === p) {
          this.proc = null
          if (code !== 0 && code !== null) {
            this.lastFailReason = `${cmd.bin} exit ${code}`
          }
          this.publish()
        }
      })
      p.unref?.()
      this.proc = p
      this.armSweep()
      this.publish()
    } catch (e) {
      this.lastFailReason = String(e)
    }
  }

  private stop(): void {
    this.clearTimer()
    const p = this.proc
    this.proc = null
    if (p) {
      try {
        p.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    if (this.enabled) this.disable('shutdown')
  }
}

export interface KeepAwakeCommand {
  bin: string
  args: string[]
}

/** Pure command builder — unit-testable without spawning. */
export function buildKeepAwakeCommand(
  os: NodeJS.Platform,
  ownerPid: number,
  keepDisplay = false,
): KeepAwakeCommand | null {
  switch (os) {
    case 'darwin': {
      // -i: prevent idle sleep, -s: prevent system sleep (AC), -w: tie lifetime to pid
      const args: string[] = []
      if (keepDisplay) args.push('-d', '-i', '-u', 'disk,display')
      else args.push('-i', '-s')
      args.push('-w', String(ownerPid))
      return { bin: '/usr/bin/caffeinate', args }
    }
    case 'linux':
      return {
        bin: 'systemd-inhibit',
        args: [
          '--what=idle:sleep',
          '--who=dsh-remote-control',
          '--why=DSH remote session active',
          '--mode=block',
          'sleep',
          'infinity',
        ],
      }
    case 'win32':
      return windowsExecutionStateCommand(keepDisplay)
    default:
      return null
  }
}

/** Windows reserved hook: ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(1) | ES_DISPLAY_REQUIRED(2) */
export function windowsExecutionStateCommand(keepDisplay: boolean): KeepAwakeCommand {
  const flag = keepDisplay ? '0x80000003' : '0x80000001'
  const cs = [
    'using System;using System.Runtime.InteropServices;',
    'public class DRCExec{',
    '[DllImport("kernel32.dll",SetLastError=true)]',
    'static extern uint SetThreadExecutionState(uint esFlags);',
    `public static void Main(){SetThreadExecutionState(${flag}u);`,
    'System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);}}',
  ].join('')
  return {
    bin: 'powershell',
    args: [
      '-NoProfile',
      '-Command',
      `Add-Type -TypeDefinition '${cs}' -OutputAssembly "$env:TEMP\\drc-execstate.exe" -OutputType LibraryExecutable; & "$env:TEMP\\drc-execstate.exe"`,
    ],
  }
}
