/**
 * presenter — "当前配对码" → "右栏可以打开的一张图"。
 *
 * 这一半不产生配对码，也不碰中继：它每隔 `refreshMs` 看一眼主插件 `provide` 的
 * `dshRemoteControl` 服务，把**当前正在显示的那张码**渲染成 PNG 字节，并把
 * 「这一版是哪一版」记成一个 epoch 给路由。客户端只认 epoch 变没变——
 * 于是"用户按了一次 /drc pair"和"配对窗口自动续了半程"这两种换码，走的是同一条路。
 *
 * **落盘不在这里**（2026-10-02 改）：图该落在**哪条会话的工作区**，要等请求来了才知道
 * ——右栏那条路由的 `?session=` 是唯一知道这件事的地方。所以这一半只负责"按当前码渲染出
 * 一份字节"，由路由在回答 `ready` 之前把它写到那个会话的 `<workspace>/.dsh/sidebar-qr.png`；
 * 写不成就不答 `ready`（那条不变量没变：**绝不把指向不存在文件的地址交出去**）。
 * 好处是"没有读数就不渲染、同一版码只渲染一次"，而写盘只发生在真的有人要看的时候
 * ——原来那版定时写给 `~/.dsh/` 的做法，会在用户明确要求"放工作区"之后仍然往 home 里丢文件。
 *
 * **epoch 用码的哈希，不用 token 本身**：路由是浏览器可达的，码里带着一次性 token
 * 与 PSK。哈希足以判断"换没换"，且泄不出任何可用的东西（前缀 16 个十六进制位）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'

/** 路由要回答的东西：有没有可看的码、是哪一版、什么时候过期。 */
export type PairingSnapshot = { state: 'none' } | { state: 'ready'; epoch: string; expiresAt: number }

/** 当前这一版码渲染出来的字节。`epoch` 就是快照里那个。 */
export interface PairingArtifact {
  epoch: string
  buffer: Buffer
}

export interface PresenterDeps {
  now(): number
  render(qr: string): Promise<Buffer>
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
  private artifact: PairingArtifact | null = null
  private rendering = false

  constructor(private readonly deps: PresenterDeps) {}

  snapshot(): PairingSnapshot {
    return this.value
  }

  /**
   * 当前这一版的 PNG 字节；没有可看的码时是 null。
   *
   * **路由必须先拿它落盘成功，再回答 `ready`**——反过来就等于把用户送到一个不存在的
   * 文件上（右栏会弹出一张破图，比不弹更糟）。
   */
  current(): PairingArtifact | null {
    return this.value.state === 'ready' ? this.artifact : null
  }

  /**
   * 看一眼当前的码。
   *
   * 三种结果：
   * - 没有码 / 码已过期 → `none`（右栏不该被一张废码顶开）；
   * - 码没变 → 只更新 `expiresAt`（同一版码的过期时间可能被服务端 TTL 改写）；
   * - 码变了 → 渲染成功后认这一版；渲染抛错就是 `none`（宁可不弹，也不弹一张上一版的图）。
   */
  async observe(pairing: ActivePairing | null | undefined): Promise<void> {
    const qr = typeof pairing?.qr === 'string' && pairing.qr !== '' ? pairing.qr : null
    const expiresAt = toEpochMs(pairing?.expiresAt)
    if (qr === null || expiresAt <= this.deps.now()) {
      this.value = { state: 'none' }
      this.artifact = null
      return
    }
    const epoch = this.deps.digest(qr)
    if (this.artifact?.epoch !== epoch) {
      // 渲染/写盘期间来的下一次 tick 直接跳过：同一版码没必要并发渲染两遍。
      if (this.rendering) return
      this.rendering = true
      try {
        const buffer = await this.deps.render(qr)
        this.artifact = { epoch, buffer }
      } catch (error) {
        // 渲染失败要把上一版的字节丢掉：留着它，下面那行会把**旧图**配上新 epoch 交出去。
        this.artifact = null
        this.deps.log('二维码渲染失败', { message: String((error as Error)?.message ?? error).slice(0, 200) })
      } finally {
        this.rendering = false
      }
    }
    this.value = this.artifact?.epoch === epoch ? { state: 'ready', epoch, expiresAt } : { state: 'none' }
  }
}

/** 生产环境的依赖实现（测试注入假的 render/now）。 */
export function liveDeps(
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void,
): PresenterDeps {
  return {
    now: () => Date.now(),
    render: (qr) => QRCode.toBuffer(qr, { errorCorrectionLevel: 'M', margin: 4, scale: 8, type: 'png' }),
    digest: (qr) => createHash('sha256').update(qr).digest('hex').slice(0, 16),
    log,
  }
}

/**
 * 把二维码 PNG 写到 `file`：0600 + 临时文件改名。
 *
 * 0600：这张图里就是那张一次性配对码（token + PSK），等同于凭据（主插件的
 * `<workspace>/.dsh/pairing-qr.png` 同款待遇）。
 * 改名：右栏的文档预览会在我们写的同时去读它，半写的 PNG 会渲染成一张破图——
 * 与 `shell/status.ts` 的 status.json 同一个理由。
 */
export function writePrivatePng(file: string, data: Buffer): boolean {
  if (!file) return false
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
