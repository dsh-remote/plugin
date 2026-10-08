/**
 * 文件附件落盘（2026-10-05 加）。
 *
 * **图片不走这里**（2026-10-05 用户：正文里不要再出现路径）：图片作为宿主原生的
 * 内容块 {type:image, data, mimeType} 直接进消息，正文保持干净。落盘 + 路径那套
 * 只留给**文件** —— 宿主没有文件的内联块，Agent 要读它就得有个文件路径。
 *
 * 三条纪律：
 * 1. **文件名收敛**：手机传来的名字是不可信输入（../../x 这种要能挡住）。
 *    会话 id 同样处理 —— 它要当目录名。
 * 2. **整批先验后写**：被拒的批次一个字节都不留在磁盘上（早先边验边写，前两张
 *    落完了第三张被拒，用户看到的是最难查的半截状态）。
 * 3. **写不进去就整条 prompt 失败**，不是「丢了文件照发」：用户的意图包含这些
 *    文件，静悄悄少发几个比明确失败更难查。
 */
import fs from 'node:fs'
import path from 'node:path'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, MAX_FILE_ATTACHMENTS } from 'dsh-remote-wire/limits'

/** 本仓沿用的旧名 = 协议层的 `MAX_ATTACHMENT_TOTAL_BYTES`（见下面那段注释）。 */
const MAX_ATTACH_TOTAL_BYTES = MAX_ATTACHMENT_TOTAL_BYTES

/** 一条落盘成功的文件（2026-10-05 加）。 */
export interface SavedFile {
  /** 收敛后的文件名（落盘用的那个，扩展名保留）。 */
  name: string
  /** 绝对路径 —— prompt 正文里给 Agent 的就是它。 */
  path: string
  bytes: number
  /** 类型标签（来自手机的扩展名；可能为空）。 */
  mediaType?: string
}

export interface SaveFilesOk {
  ok: true
  saved: SavedFile[]
  /** 落盘目录（排错用；不含文件名）。 */
  dir: string
}

export interface SaveFilesFail {
  ok: false
  /** 给人看的一句话（会原样回到手机上）。 */
  message: string
}

export type SaveFilesResult = SaveFilesOk | SaveFilesFail

/**
 * 一批文件附件的**总字节预算**，与 mp 侧 `chat.js` 的 `MAX_ATTACH_TOTAL_BYTES` 同值同口径
 * （按 base64 解出来的原始字节算）。
 *
 * 为什么主机侧也必须有这一道：单文件 512KB 挡不住"4 × 512KB"——schema 允许 `files.max(4)`，
 * 最坏一批是 2MB 原文 ≈ 2.7MB base64 进一帧，而中继的 `maxPayload` 是 1MB：
 * 整帧被掐、socket 1009 断开，用户看到的是"发个附件就掉线"。mp 侧有这道闸，
 * 但它是**客户端**；一条旧版/被改过的小程序照样能把超限批次送上来，所以主机侧按
 * 同一把尺子再量一遍（口径差一点都会出现"手机说发出去了、主机回失败"的分叉）。
 *
 * **转出协议层的 `MAX_ATTACHMENT_TOTAL_BYTES`**（2026-10-07）：这个数此前在本仓被抄了
 * 四遍（这里、`config.ts` 两处、`runtime.ts` 一处），改一处不会让另外三处变红，
 * 而症状是"手机按 512KB 算、主机按 256KB 算"这类只有真机才看得见的分叉。
 * 现在唯一定义点在 wire 的 `limits.ts`；本仓的导出保留是为了不破坏既有 import。
 *
 * ⚠️ 别写成 `export { MAX_ATTACHMENT_TOTAL_BYTES as MAX_ATTACH_TOTAL_BYTES } from '...'`
 * 那一行**不会**在本地产生一个叫 `MAX_ATTACH_TOTAL_BYTES` 的绑定（`from` 形式只在
 * 导出侧改名），于是下面 `saveFileAttachments` 里的同名引用会是"未定义"。
 * 正确形状是上面 import 一次 + 一句本地 `const` 别名 + 这里纯转出。
 */
export { MAX_ATTACH_TOTAL_BYTES }

/**
 * 文件名/目录名收敛：只留 [A-Za-z0-9._-]，其余折成 _；空串与超长都有兜底。
 * **点号开头的名字直接丢掉点**——.ssh 这种隐藏路径不该由一条手机消息造出来。
 */
export function safeSegment(raw: string, fallback: string, maxLen = 96): string {
  const cleaned = String(raw || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    // 开头与结尾的点/下划线/连字符**整段**丢掉：`../../etc/passwd` 折完是
    // `.._.._etc_passwd`，只去掉开头的点会剩一格下划线，里头还留着 `..`。
    .replace(/^[._-]+/, '')
    .slice(0, maxLen)
    .replace(/[._-]+$/, '')
  return cleaned === '' ? fallback : cleaned
}

/** base64 → Buffer。非法字符会被 Buffer 静默忽略，所以先按字符集拒一遍。 */
function decodeBase64(data: string): Buffer | null {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) return null
  const buf = Buffer.from(data, 'base64')
  return buf.length > 0 ? buf : null
}

/**
 * 文件附件的正文增补。与 同一条理由（正文在后、空正文可用），
 * 多带一个类型标签：Agent 认文件靠扩展名，而落盘名可能被收敛过，
 * 把手机上那个原始类型并排列出来更稳。
 */
export function appendFileNote(text: string, saved: ReadonlyArray<SavedFile>): string {
  if (saved.length === 0) return text
  const lines = saved.map((f, i) => (f.mediaType ? `${i + 1}. ${f.path}（${f.mediaType}）` : `${i + 1}. ${f.path}`))
  const note = `\n\n[文件附件 ${saved.length} 个，已存到本机]\n${lines.join('\n')}`
  const head = String(text || '')
  return head === '' ? note.replace(/^\n\n/, '') : head + note
}

/**
 * 把一批文件附件写进 <dir>/<safeSessionId>/。
 *
 * 与图片那套的三处差别，都是文件本身逼出来的：
 * 1. **不校内容魔数**。图片那边有 JPEG 文件头这一道，文件类型太多了，硬凑一份
 *    魔数表只会给出"看起来校验过"的假保证。真正的闸在 mp 侧两道 + 这里的大小上限。
 * 2. **不改扩展名**。图片统一强写成 .jpg（画布重编码出来的就是 jpeg），文件改了
 *    扩展名 Agent 就不认它了。收敛仍走 `safeSegment`——手机传来的名字是不可信输入。
 * 3. **同名不覆盖**（与图片同一条理由）：加序号而不是失败。
 *
 * 整批先验后写：被拒的批次一个字节都不留在磁盘上。
 */
export function saveFileAttachments(options: {
  files: ReadonlyArray<{ name: string; mediaType?: string; data: string }>
  dir: string
  sessionId: string
  maxCount?: number
  maxBytesPerFile?: number
  /** 整批的原始字节上限；默认与 mp 侧同值（见 {@link MAX_ATTACH_TOTAL_BYTES}）。 */
  maxTotalBytes?: number
}): SaveFilesResult {
  const maxCount = options.maxCount ?? MAX_FILE_ATTACHMENTS
  const maxBytes = options.maxBytesPerFile ?? MAX_ATTACHMENT_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ATTACH_TOTAL_BYTES
  const files = options.files || []
  if (files.length === 0) return { ok: true, saved: [], dir: options.dir }
  if (files.length > maxCount) {
    return { ok: false, message: `一次最多带 ${maxCount} 个文件，收到 ${files.length} 个` }
  }

  const decoded: Array<{ file: (typeof files)[number]; buf: Buffer }> = []
  let totalBytes = 0
  for (const [i, one] of files.entries()) {
    const buf = decodeBase64(one.data)
    if (!buf) return { ok: false, message: `第 ${i + 1} 个文件的解码失败（不是合法 base64）` }
    if (buf.length > maxBytes) {
      return {
        ok: false,
        message: `第 ${i + 1} 个文件有 ${Math.round(buf.length / 1024)}KB，超过单个上限 ${Math.round(maxBytes / 1024)}KB`,
      }
    }
    totalBytes += buf.length
    if (totalBytes > maxTotalBytes) {
      return {
        ok: false,
        message: `这一批附件合计 ${Math.round(totalBytes / 1024)}KB，超过整批上限 ${Math.round(
          maxTotalBytes / 1024,
        )}KB（第 ${i + 1} 个文件让它超了，请少带几个）`,
      }
    }
    decoded.push({ file: one, buf })
  }

  const sessionDir = path.join(options.dir, safeSegment(options.sessionId, 'session'))
  const written: SavedFile[] = []
  try {
    fs.mkdirSync(sessionDir, { recursive: true })
    for (const [i, one] of decoded.entries()) {
      // 空名字兜底成按序号的通用名：手机那头可能给一个只有扩展名的文件，
      // 收敛之后就什么都不剩了。
      const fallback = `file-${i + 1}`
      const base = safeSegment(one.file.name, fallback, 96) || fallback
      let name = base
      let n = 1
      while (fs.existsSync(path.join(sessionDir, name))) {
        // 序号插在扩展名之前（a.pdf → a-2.pdf），插在末尾会变成 a.pdf-2，Agent 认不出。
        const dot = base.lastIndexOf('.')
        name = dot > 0 ? `${base.slice(0, dot)}-${++n}${base.slice(dot)}` : `${base}-${++n}`
      }
      const file = path.join(sessionDir, name)
      fs.writeFileSync(file, one.buf, { mode: 0o600 })
      written.push({ name, path: file, bytes: one.buf.length, mediaType: one.file.mediaType })
    }
  } catch (error) {
    /**
     * **IO 失败也要把这一批收干净**（2026-10-07 审计）。
     *
     * 文件头第 2 条纪律写的是"被拒的批次一个字节都不留在磁盘上"，而原来那句话
     * 只覆盖了**校验**失败：先验后写保证的是"不会写一半才发现不合格"，可
     * `writeFileSync` 自己是会在循环中途抛的（ENOSPC / EACCES / EMFILE）——
     * 于是 1~3 个文件已经落盘，第 4 个抛了，`catch` 直接返回失败，
     * 而 `runtime` 如实告诉手机"整条 prompt 失败、什么都没发"。
     *
     * 症状比"多几个文件"难查：用户看到的是失败，重试一次文件名就变成
     * `report-2.pdf`、`report-3.pdf`……一直涨，而目录里的那些副本没有任何人认领。
     */
    for (const file of written) {
      try {
        fs.rmSync(file.path, { force: true })
      } catch {
        /* 收不回来就留着：宁可留一个孤儿文件，也不要在这里再抛一次把错误信息顶掉 */
      }
    }
    return {
      ok: false,
      message: `文件落盘失败：${String((error as Error)?.message ?? error).slice(0, 160)}`,
    }
  }
  return { ok: true, saved: written, dir: sessionDir }
}
