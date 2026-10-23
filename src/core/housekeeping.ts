/**
 * housekeeping —— 周期性的**剪枝 + 补码 + 批量落盘**（v5 R2b 从 `index.ts` 抽出）。
 *
 * 三件事各自都有"不做就会慢慢坏"的理由：
 * - `pairingWindow.tick()`：过期/换代的码要补（不然屏幕上是死码）；
 * - `pruneConversations` + `slots.prune()`：密钥簿与码簿要剪（不然排障读数虚高）；
 * - `pairStore.save()`：seqHost/lastActivity 的变动只标脏，按节拍批量落盘
 *   （挂在结构性变更上等于每 15 秒写一次盘；而这个插件在 GUI 宿主里可能连开好几天）。
 *
 * ⚠️ **行为零变化**：判据一片未动照样全绿。
 */
import type { Clock } from '../ports/index.js'

export interface HousekeepingDeps {
  clock: Clock
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  tickPairingWindow(): void
  pruneConversations(): void
  pruneSlots(): void
  /** 有脏改动才落盘（没脏不写：这条节拍不许变成无条件写盘的心跳）。 */
  saveIfDirty(): void
  /** 没有 status.json 时自己起节拍的间隔。 */
  refreshMs: number
}

export interface Housekeeping {
  tick(): void
  /** `statusFile` 不存在时自起节拍；存在时由 status.start 驱动，这里什么都不做。 */
  startSelfTimer(hasStatusFile: boolean, onStop: (stop: () => void) => void): void
}

export function createHousekeeping(deps: HousekeepingDeps): Housekeeping {
  const { clock, log } = deps
  function tick(): void {
    deps.tickPairingWindow()
    deps.pruneConversations()
    deps.saveIfDirty()
    // 配对码簿也要剪枝：一张码是一次性的，用掉/过期之后那行 slot 只是留在 Map 里，
    // 害得 `status.json` 的 `pendingPairs` 只增不减（实测能涨到 5 以上），而那个数字
    // 是排障时判断「中继那边攒了多少待配对条目」的唯一依据。
    deps.pruneSlots()
  }

  function startSelfTimer(hasStatusFile: boolean, onStop: (stop: () => void) => void): void {
    if (hasStatusFile) return
    /**
     * **快照关掉时自己起一节拍**。刻意不塞进 `StatusFile`：那一类只管"把状态写到盘上"，
     * 让它顺带驱动剪枝与补码，就等于让"写不写排错文件"决定了"密钥簿剪不剪"。
     */
    let timer: unknown
    const tickSelf = (): void => {
      // 先续期再干活：tick 里任何一处抛出都不该让这条节拍断掉
      // （断了就等于回到"再也不会剪枝"的那个状态，而且没有任何日志）。
      timer = clock.setTimeout(tickSelf, deps.refreshMs)
      try {
        tick()
      } catch (error) {
        log('housekeeping tick failed', { message: String((error as Error)?.message ?? error).slice(0, 160) })
      }
    }
    timer = clock.setTimeout(tickSelf, deps.refreshMs)
    onStop(() => {
      if (timer !== undefined) clock.clearTimeout(timer as Parameters<typeof clock.clearTimeout>[0])
    })
  }

  return { tick, startSelfTimer }
}
