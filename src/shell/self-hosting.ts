/**
 * self-hosting — 从 `serverUrl` 这一条配置里读出**自部署排错要用的三件事**。
 *
 * ## 为什么值得单独一个文件
 *
 * 阶段 E 拍板"配置点在 DSH 侧"之后（`docs/V3-PLAN.md` §7 阶段 E），"自建中继"
 * 这件事**从功能变成了一个要说清的事实**：地址填错时手机只会说"连不上"，
 * 而微信那四道闸（域名白名单 / 备案 / 证书 / appid）一条都不在插件的控制范围内。
 * 插件能说的只有它**自己看得见**的三件事，而它们恰好覆盖了最常见的两种填错：
 *
 * 1. **明文 `ws://`**：小程序侧只允许 `wss://`，填成 `ws://` 的症状是"扫码后一直转圈"。
 * 2. **回环地址**：`127.0.0.1` / `localhost` 在手机上指的是**手机自己**，
 *    它是自部署者最常犯的第二个错（"我在电脑上能连上啊"）。
 *
 * ⚠️ 这个函数**不许发起任何连接**：它是对一行配置的纯解析，跑在任何网络动作之前，
 * 所以它坏不掉链路（status 快照的整体纪律，见 `shell/status.ts` 文件头）。
 */

/** 从地址里读出来的自部署事实。字段名是 status.json 里的键，doctor 按它们读。 */
export interface SelfHostingFacts {
  /** `wss`（有 TLS）/ `ws`（明文）/ `unknown`（压根不是 ws 协议）。 */
  scheme: 'wss' | 'ws' | 'unknown'
  /** 少一层转换：`scheme === 'wss'`。微信小程序侧**只接受**这一种。 */
  tls: boolean
  /** 主机名是回环地址（127.0.0.1 / localhost / ::1）——手机上它指的是手机自己。 */
  loopback: boolean
  /** 地址里没写端口（`:443` 省略或压根没有）⇒ 走该协议的默认端口。 */
  defaultPort: boolean
  /**
   * 主机名（不含端口与路径）。
   * ⚠️ 这**不是**凭据：中继地址本来就在二维码的 `s=` 参数里明文给手机。
   * 但它会进 status.json，而那个文件里有 PSK —— 所以 doctor 的输出按需脱敏（见 `scripts/host-doctor.mjs`）。
   */
  host: string
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/**
 * 解析一条 `serverUrl`。
 *
 * ⚠️ **解析失败不抛**：status 快照是排错第一入口，而配置早就由 `shell/config.ts`
 * 校验过并给出 `error:serverUrl` 了——这里再抛一次只会把"写状态"变成崩溃源。
 * 返回 `scheme:'unknown'` 让 doctor 有话说，而不是让整个快照消失。
 */
export function describeSelfHosting(serverUrl: string): SelfHostingFacts {
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    return { scheme: 'unknown', tls: false, loopback: false, defaultPort: false, host: '' }
  }
  const scheme = parsed.protocol === 'wss:' ? 'wss' : parsed.protocol === 'ws:' ? 'ws' : 'unknown'
  // URL 解析不出来端口时 `port` 是空串；显式写了 `:443` 也会被 URL 归一成空串（wss 默认端口）。
  return {
    scheme,
    tls: scheme === 'wss',
    loopback: LOOPBACK.has(parsed.hostname.toLowerCase()),
    defaultPort: parsed.port === '',
    host: parsed.hostname,
  }
}
