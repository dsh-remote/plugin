/**
 * config — 中继的环境变量。
 *
 * 默认值全部继承自旧实现的**实测配置**（语义继承，不是抄代码；对照表见
 * `docs/legacy-spec/relay-and-wireformat.md` §5.3）。这几条不是口味问题：
 *
 * - `MAX_MSG_BYTES` 低于 256 KiB 会把大 delta 硬切断（ws 以 1009 关连接），
 *   表现是"流式输出说到一半就重连"；
 * - `PAIR_TTL_MS` 是配对码的服务端权威寿命，主机必须按 `pair-ready.ttlMs` 改写本地过期
 *   ——这是旧实现的第一起线上事故；
 * - `PAIR_STATUS_ENABLED` 默认关：开等于给 6 位码空间装了个免认证的判定 oracle。
 *
 * 新增的两条服务于跨断连续用（D3/D6），默认值保守：
 * - `CONV_IDLE_TTL_MS` 会话在无活动多久后回收（默认 7 天）；
 * - `HOST_GRACE_MS` 主机 socket 断开后多久才通知客户端"主机已离开"（默认 120 秒）。
 *   没有这个宽限期，一次网络抖动就会让手机丢掉配对、必须回到电脑前重新扫码。
 *
 * 慢消费者窗口的一对（`SLOW_CONSUMER_HOST_MS` / `SLOW_CONSUMER_CLIENT_MS`）默认值来自
 * `limits.ts` 的常量，两者**默认不同**是刻意的：客户端窗口是由对端（小程序）自己的
 * 重连周期推导出来的不变量，不是性能偏好。把它调到 42.5s 以下就等于把那台
 * "被踢→秒回→再被踢"的 ~11s 循环发动机装回去（DESIGN-REVIEW 第 11 条，
 * `tests/limits.test.mjs` 直接读 mp 源码的常量来锁这条）。可调只是为了测试能缩短等待。
 */

import { CLIENT_SLOW_CONSUMER_MS, HOST_SLOW_CONSUMER_MS } from './limits.js'

export interface RelayConfig {
  hostToken: string
  port: number
  bind: string
  publicUrl: string
  pairTtlMs: number
  maxMessageBytes: number
  maxConnections: number
  maxFramesPerSec: number
  maxHostAuthAttempts: number
  maxPairAttemptsPerConn: number
  pairGlobalBudgetPerSec: number
  maxPendingPairs: number
  conversationIdleTtlMs: number
  hostGraceMs: number
  /** 清扫与保活周期。调小它可以让"宽限期到期"这类事件更快被观察到（测试需要）。 */
  sweepMs: number
  maxBufferedBytes: number
  /** 慢消费者（发送缓冲持续超限）的判定窗口，按角色分：见 limits.ts 的推导。 */
  slowConsumerHostMs: number
  slowConsumerClientMs: number
  logLevel: LogLevel
  pairStatusEnabled: boolean
  version: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LOG_LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }
export const levelWeight = (level: LogLevel): number => LOG_LEVELS[level]

function integer(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} 必须是正整数，收到 ${JSON.stringify(raw)}`)
  }
  return n
}

/**
 * 端口是唯一的例外：**0 合法**，含义是"让系统分配一个空闲端口"。
 * 测试与容器发布端口都靠它，所以不能用上面那条 `> 0` 的规则一刀切。
 */
function portNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65_535) {
    throw new Error(`${name} 必须是 0-65535 的整数，收到 ${JSON.stringify(raw)}`)
  }
  return n
}

export interface ConfigProblem {
  level: 'error' | 'warn'
  message: string
}

/**
 * 解析环境。返回配置与问题清单——**不**在这里 `process.exit`，
 * 好让调用方（含测试）能决定怎么落地这些诊断。
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  version: string,
): { config: RelayConfig; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = []
  const hostToken = env.DRC_HOST_TOKEN ?? ''
  if (!hostToken) {
    problems.push({
      level: 'error',
      message: 'DRC_HOST_TOKEN is required (long random string, e.g. `openssl rand -hex 24`)',
    })
  } else if (hostToken.length < 24) {
    problems.push({ level: 'warn', message: 'DRC_HOST_TOKEN is shorter than 24 chars — use `openssl rand -hex 24`' })
  }

  const level = (env.DRC_LOG_LEVEL ?? 'info') as LogLevel
  if (!(level in LOG_LEVELS)) {
    problems.push({ level: 'error', message: `DRC_LOG_LEVEL 不认识的取值：${JSON.stringify(env.DRC_LOG_LEVEL)}` })
  }

  const config: RelayConfig = {
    hostToken,
    port: portNumber(env.DRC_PORT, 8787, 'DRC_PORT'),
    // 默认只绑回环：TLS 由反代终止，中继没理由出现在局域网里。
    // 只有自己就是边缘（容器直接发布端口）时才设 DRC_BIND=0.0.0.0。
    bind: env.DRC_BIND || '127.0.0.1',
    publicUrl: env.DRC_PUBLIC_URL ?? '',
    pairTtlMs: integer(env.DRC_PAIR_TTL_MS, 120_000, 'DRC_PAIR_TTL_MS'),
    maxMessageBytes: integer(env.DRC_MAX_MSG_BYTES, 256 * 1024, 'DRC_MAX_MSG_BYTES'),
    maxConnections: integer(env.DRC_MAX_CONNS, 200, 'DRC_MAX_CONNS'),
    maxFramesPerSec: integer(env.DRC_MAX_FRAMES_PER_SEC, 500, 'DRC_MAX_FRAMES_PER_SEC'),
    maxHostAuthAttempts: integer(env.DRC_HOST_AUTH_MAX_ATTEMPTS, 5, 'DRC_HOST_AUTH_MAX_ATTEMPTS'),
    maxPairAttemptsPerConn: integer(env.DRC_PAIR_ATTEMPTS_PER_CONN, 5, 'DRC_PAIR_ATTEMPTS_PER_CONN'),
    pairGlobalBudgetPerSec: integer(env.DRC_PAIR_GLOBAL_PER_SEC, 20, 'DRC_PAIR_GLOBAL_PER_SEC'),
    maxPendingPairs: integer(env.DRC_MAX_PENDING_PAIRS, 1000, 'DRC_MAX_PENDING_PAIRS'),
    conversationIdleTtlMs: integer(env.DRC_CONV_IDLE_TTL_MS, 7 * 24 * 3600 * 1000, 'DRC_CONV_IDLE_TTL_MS'),
    hostGraceMs: integer(env.DRC_HOST_GRACE_MS, 120_000, 'DRC_HOST_GRACE_MS'),
    sweepMs: integer(env.DRC_SWEEP_MS, 5_000, 'DRC_SWEEP_MS'),
    maxBufferedBytes: integer(env.DRC_MAX_BUFFERED_BYTES, 1024 * 1024, 'DRC_MAX_BUFFERED_BYTES'),
    slowConsumerHostMs: integer(env.DRC_SLOW_CONSUMER_HOST_MS, HOST_SLOW_CONSUMER_MS, 'DRC_SLOW_CONSUMER_HOST_MS'),
    slowConsumerClientMs: integer(
      env.DRC_SLOW_CONSUMER_CLIENT_MS,
      CLIENT_SLOW_CONSUMER_MS,
      'DRC_SLOW_CONSUMER_CLIENT_MS',
    ),
    logLevel: level,
    pairStatusEnabled: env.DRC_PAIR_STATUS === '1' || env.DRC_PAIR_STATUS === 'true',
    version,
  }
  return { config, problems }
}
