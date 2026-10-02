/**
 * sleep — 防休眠的**命令构造器**（纯函数）。
 *
 * 只负责"该执行什么"，不负责执行——spawn、生命周期、空闲释放都在插件侧的
 * `SleepPort` 实现里。这个切分是为了让三平台的参数能被单测覆盖到，
 * 而单测不需要真的把机器的睡眠策略改掉。
 *
 * 为什么 macOS 用 `caffeinate -i -s -w <pid>`：
 * `-i` 阻止空闲休眠，`-s` 阻止接电源时的系统休眠，而 `-w <pid>` 把断言的寿命
 * **绑到宿主进程**——宿主崩了断言随之消失，不会留下一台永远不睡机的机器。
 * 整套方案不需要 sudo。
 *
 * 为什么 Linux 用 `systemd-inhibit --mode=block`：默认的 `delay` 只是推迟，
 * 策略仍可让机器睡；`block` 才是硬阻塞，符合"远程会话正在进行"的语义。
 * `--what=idle:sleep` 同时抑制"空闲触发挂起"与"挂起本身"两件事。
 * 末尾的 `sleep infinity` 是该工具的惯用法——锁持有到被 hold 的命令退出。
 *
 * Windows：旧实现只有一个从未在真机验证过的 `SetThreadExecutionState` powershell 构造器，
 * 且默认关闭（取证 HANDOFF.md §6、README 防休眠表标「预留」）。本版**不移植**它——
 * 为一个验证不了的平台保留一段内联 powershell 只是把不可信代码写进仓库。
 * Windows 上 `buildSleepCommand` 返回 `null`，backend 报 `'unsupported'`，
 * 手机与状态文件都会如实显示这一点。
 */

/** 支持到的平台集合（其余平台返回 null，调用方据此报 unsupported）。 */
export type SleepPlatform = 'darwin' | 'linux'

/** 一条待执行的命令。 */
export interface SleepCommand {
  command: string
  args: string[]
}

/** 供状态上报使用的后端名。 */
export type SleepBackend = 'caffeinate' | 'systemd-inhibit' | 'unsupported'

/** 把平台映射到后端名（`ev.keep_awake_state.backend` 会直接显示在手机上）。 */
export function detectBackend(platform: string): SleepBackend {
  if (platform === 'darwin') return 'caffeinate'
  if (platform === 'linux') return 'systemd-inhibit'
  return 'unsupported'
}

/** 这条平台线是否可用。 */
export function isSleepSupported(platform: string): platform is SleepPlatform {
  return detectBackend(platform) !== 'unsupported'
}

/**
 * 构造持锁命令。
 *
 * @param platform `node:os.platform()` 的值
 * @param ownerPid 断言绑定的宿主 pid（macOS 用 `-w`，进程死了锁就消失）
 * @param keepDisplay 是否连屏幕也保持点亮（默认关：手机在远处看着没意义，
 *                    但接着电源的桌面用户可能希望屏幕不黑）
 */
export function buildSleepCommand(platform: string, ownerPid: number, keepDisplay = false): SleepCommand | null {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    throw new Error(`宿主 pid 必须是正整数，收到 ${String(ownerPid)}`)
  }
  switch (platform as SleepPlatform) {
    case 'darwin':
      return {
        command: '/usr/bin/caffeinate',
        args: keepDisplay
          ? ['-d', '-i', '-u', 'disk,display', '-w', String(ownerPid)]
          : ['-i', '-s', '-w', String(ownerPid)],
      }
    case 'linux':
      return {
        command: 'systemd-inhibit',
        args: [
          '--what=idle:sleep',
          '--who=dsh-remote-control',
          '--why=DSH remote session active',
          '--mode=block',
          'sleep',
          'infinity',
        ],
      }
    default:
      return null
  }
}
