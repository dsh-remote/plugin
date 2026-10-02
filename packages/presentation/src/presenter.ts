/**
 * presenter — "当前配对码" → "右栏可以打开的一张图"。
 *
 * 这一半不产生配对码，也不碰中继：它每隔 `refreshMs` 看一眼主插件 `provide` 的
 * `dshRemoteControl` 服务，把**当前正在显示的那张码**渲染成 PNG 落到磁盘，并把
 * 「这一版是哪一版」记成一个 epoch 给路由。客户端只认 epoch 变没变——
 * 于是"用户按了一次 /drc pair"和"配对窗口自动续了半程"这两种换码，走的是同一条路。
 *
 * 不做成"客户端每次来都要现渲染"：路由是 GET，渲染是几毫秒的 CPU + 一次写盘，
 * 但把写盘塞进请求处理会让"没有读数时也写"和"并发请求重复写"两件事同时发生。
 * 节拍放在宿主侧，路由只回答一个已经算好的快照。
 *
 * **epoch 用码的哈希，不用 token 本身**：路由是浏览器可达的，码里带着一次性 token
 * 与 PSK。哈希足以判断"换没换"，且泄不出任何可用的东西（前缀 16 个十六进制位）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'

/** 路由要回答的东西：有没有可看的码、是哪一版、什么时候过期。 */
export type PairingSnapshot = { state: 'none' } | { state: 'ready'; epoch: string; expiresAt: number }

export interface PresenterDeps {
  /** 二维码 PNG 的落盘路径。 */
  imageFile: string
  now(): number
  render(qr: string): Promise<Buffer>
  write(file: string, data: Buffer): boolean
  digest(qr: string): string
  log(message: string, fields?: Record<string, string | number | boolean | undefined>): void
}

/** 主插件 `dshRemoteControl.state.pairing` 里我们关心的两个字段（其余不读，也不依赖）。 */
export interface ActivePairing {
  qr?: unknown
  expiresAt?: unknown
}

/**
 * 过期时间既可能是毫秒数，也可能是 ISO 字符串——**两种都得认**。
 *
 * `provide('dshRemoteControl')` 暴露出来的那一版是 `describeActivePairing()` 序列化后的
 * 形状，它的 `expiresAt` 是 `new Date(slot.expiresAt).toISOString()`（真机取证，见
 * packages/plugin/src/index.ts）。只认 `typeof === 'number'` 的话，每一版码都会被判成
 * "已过期"，路由永远答 `none`，右栏永远不弹——而单测里手写的毫秒 fixture 一路全绿。
 * 认不出的值（`'soon'` / `{}` / `NaN`）折成 0，也就是 none：这里不猜。
 */
function toEpochMs(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

export class PairingPresenter {
  private value: PairingSnapshot = { state: 'none' }
  private renderedEpoch: string | null = null
  private rendering = false

  constructor(private readonly deps: PresenterDeps) {}

  snapshot(): PairingSnapshot {
    return this.value
  }

  /**
   * 看一眼当前的码。
   *
   * 三种结果：
   * - 没有码 / 码已过期 → `none`（右栏不该被一张废码顶开）；
   * - 码没变 → 只更新 `expiresAt`（同一版码的过期时间可能被服务端 TTL 改写）；
   * - 码变了 → 渲染落盘**成功之后**才认这一版；落盘失败就是 `none`，
   *   绝不把一个指向不存在文件的地址交给客户端。
   */
  async observe(pairing: ActivePairing | null | undefined): Promise<void> {
    const qr = typeof pairing?.qr === 'string' && pairing.qr !== '' ? pairing.qr : null
    const expiresAt = toEpochMs(pairing?.expiresAt)
    if (qr === null || expiresAt <= this.deps.now()) {
      this.value = { state: 'none' }
      return
    }
    const epoch = this.deps.digest(qr)
    if (this.renderedEpoch !== epoch) {
      // 渲染/写盘期间来的下一次 tick 直接跳过：同一版码没必要并发渲染两遍。
      if (this.rendering) return
      this.rendering = true
      try {
        const buffer = await this.deps.render(qr)
        if (this.deps.write(this.deps.imageFile, buffer)) {
          this.renderedEpoch = epoch
        } else {
          this.deps.log('二维码落盘失败', { file: this.deps.imageFile })
        }
      } catch (error) {
        this.deps.log('二维码渲染失败', { message: String((error as Error)?.message ?? error).slice(0, 200) })
      } finally {
        this.rendering = false
      }
    }
    this.value = this.renderedEpoch === epoch ? { state: 'ready', epoch, expiresAt } : { state: 'none' }
  }
}

/** 生产环境的依赖实现（测试注入假的 render/write/now）。 */
export function liveDeps(
  imageFile: string,
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void,
): PresenterDeps {
  return {
    imageFile,
    now: () => Date.now(),
    render: (qr) => QRCode.toBuffer(qr, { errorCorrectionLevel: 'M', margin: 4, scale: 8, type: 'png' }),
    write: (file, data) => {
      try {
        mkdirSync(path.dirname(file), { recursive: true })
        // 0600：这张图里就是那张一次性配对码（token + PSK），等同于凭据。
        // 主插件的 pairing-qr.png 同款待遇。
        writeFileSync(file, data, { mode: 0o600 })
        return true
      } catch {
        return false
      }
    },
    digest: (qr) => createHash('sha256').update(qr).digest('hex').slice(0, 16),
    log,
  }
}
