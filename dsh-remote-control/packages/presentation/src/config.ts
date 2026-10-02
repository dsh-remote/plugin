/**
 * config — presentation 包自己的那一行配置。
 *
 * 为什么是**独立的包、独立的配置行**：这一半要做的事（起一个同域路由 + 往磁盘落图）
 * 需要 `webServer` 服务，而主插件刻意不写任何 `inject:` 闸门（它的 cordis.patch.yml 注释
 * 说明了理由：写闸门会让"某一代宿主缺某个服务"时整行不激活）。把路由挂进主插件，就等于
 * 为了一个可选功能给主插件加依赖闸门。分成两行之后，宿主没有 `webServer` 时这一行自己
 * 不激活，主插件的配对/中继链路一行代码都不受影响。
 *
 * 也因此：**这一半不需要主插件的任何配置**。它只认当前配对码（通过主插件 `provide` 的
 * `dshRemoteControl` 服务读），输出路径自成一格——两行配置各自独立，谁改谁生效，
 * 不需要跨行同步。
 */
import { homedir } from 'node:os'
import path from 'node:path'

export interface PresentationConfig {
  /** 关掉就只留"什么都不做"这一种行为（路由不会注册）。 */
  enabled: boolean
  /**
   * 二维码 PNG 的**兜底**落盘路径：正常情况下图落在当前会话的工作区
   * （`<workspace>/.dsh/sidebar-qr.png`，2026-10-02 用户拍板：放工作区，不放 home），
   * 只有"会话 → 工作区"解析不出来时才用这里（默认 `~/.dsh/sidebar-qr.png`）。
   */
  imageFile: string
  /** 宿主侧刷新节拍：多久看一眼"当前配对码是不是换了"。 */
  refreshMs: number
}

export const DEFAULT_PRESENTATION_CONFIG: PresentationConfig = {
  enabled: true,
  imageFile: path.join(homedir(), '.dsh', 'sidebar-qr.png'),
  refreshMs: 2000,
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(200, Math.floor(parsed))
}

export function readConfig(injected: Partial<PresentationConfig> = {}): PresentationConfig {
  return {
    enabled: injected.enabled ?? DEFAULT_PRESENTATION_CONFIG.enabled,
    imageFile:
      typeof injected.imageFile === 'string' && injected.imageFile !== ''
        ? injected.imageFile
        : DEFAULT_PRESENTATION_CONFIG.imageFile,
    refreshMs: positiveInt(injected.refreshMs, DEFAULT_PRESENTATION_CONFIG.refreshMs),
  }
}

/** 配置体检：只出问题清单，绝不在读配置时抛（主插件的同款纪律）。 */
export function validateConfig(
  config: PresentationConfig,
): { level: 'warn' | 'error'; field: string; message: string }[] {
  const problems: { level: 'warn' | 'error'; field: string; message: string }[] = []
  if (config.imageFile === '') {
    problems.push({ level: 'error', field: 'imageFile', message: '为空就无处落二维码，右栏预览无法工作' })
  } else if (!path.isAbsolute(config.imageFile)) {
    problems.push({
      level: 'warn',
      field: 'imageFile',
      message: `不是绝对路径（${config.imageFile}），工作区解析不出来时会被解析到进程工作目录下`,
    })
  }
  return problems
}
