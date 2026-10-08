/**
 * host-id — 主机身份的持久化落点（与 status.json 同目录下的 `host-id` 一个文件）。
 *
 * 为什么非有不可：`config.hostId` 默认是空串，而空的时候旧写法是**每次加载现造一个**
 * `h_<3 字节随机>`。真机取证（HANDOFF §3.4）：同一台机器 5 分钟内出现过三个 hostId
 * （`h_c2073b` → `h_051405` → `h_0919dc`），中继日志每一次都是 `host online … replaced:0`
 * ——换了身份就顶不掉旧那条 socket，旧 socket 只能等宽限/清扫。手机连的那条会话对应的
 * 身份这时候已经换人，中继往"没有钥匙的对端"推帧 → `droppedFrames` 一直涨。
 * 所以这不是"名字不好看"，是丢帧与"手机连不上"的直接来源。
 *
 * 三条要求：
 * 1. **配置仍然是权威**：`hostId` 给了就用给的，既不读文件也不写文件。
 * 2. **0600，且只在没有时创建**。这个目录里同时住着 status.json（可能有仍然有效的配对码
 *    与 PSK），权限纪律与它一致。已存在的值**从不改写**——身份稳定才是这件事的目的。
 * 3. **读不到 / 写不进就退回一次性随机值，绝不抛**。"这一轮身份不稳定"是可接受的退化，
 *    "插件起不来"不是（红线见 index.ts 的 apply()）。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 认下来的身份形状：可读、可 grep、不含路径分隔符。旧写法那种 `h_xxxx` 也在里面。 */
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** 新造一个身份。前缀 `drc-` 是为了在中继日志里一眼认出"这是远程控制的主机"。 */
export function newHostId(): string {
  return `drc-${randomBytes(6).toString('hex')}`
}

/**
 * 定下这一台主机叫什么：配置 > 磁盘上的旧值 > 现造一个并落盘。
 *
 * @param dir — 落点目录（调用方给的是 status.json 所在的那个 `~/.dsh/dsh-remote-control`）。
 * @param configured — `config.hostId`，非空时它说了算。
 * @returns 一个稳定的 hostId；`dir` 不可写时是本次进程内的一次性值。
 */
export function resolveHostId(dir: string, configured: string): string {
  if (configured) return configured
  if (!dir) return newHostId()
  const file = path.join(dir, 'host-id')
  let existing: string | undefined
  try {
    existing = readFileSync(file, 'utf8').trim()
  } catch {
    existing = undefined
  }
  // 已经认得了就**绝不改写**：哪怕这次写盘会失败，留着旧身份也比换身份好。
  if (existing !== undefined && HOST_ID.test(existing)) return existing
  const fresh = newHostId()
  try {
    mkdirSync(dir, { recursive: true })
    // 文件不在时用 'wx' 抢注：两个实例同时首建，只有一个写得进去，
    // 输的那个会落到下面把赢家的身份读回来。文件在但不认（手改坏、半写）才覆盖修好。
    writeFileSync(file, `${fresh}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: existing === undefined ? 'wx' : 'w',
    })
    // mode 只在**创建**时生效，覆盖写不会收紧已有权限——这个目录里同时住着配对凭据，补一次。
    chmodSync(file, 0o600)
    return fresh
  } catch {
    try {
      const raced = readFileSync(file, 'utf8').trim()
      if (HOST_ID.test(raced)) return raced
    } catch {
      /* 读不到就用一次性值：这一轮身份不稳定，但插件照常起 */
    }
    return fresh
  }
}
