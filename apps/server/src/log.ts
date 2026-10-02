/**
 * log — 一行一条 JSON 的结构化日志。
 *
 * 为什么自写 ~40 行而不是引 pino（实测决定，不是口味）：
 * pino 默认起 `thread-stream` 工作线程（实测进程线程数 11 vs 裸 node 7），
 * 生产依赖闭包 13 个包；而服务器侧已有 systemd-journald 负责收集与轮转
 * （`StandardOutput=journal` + `SyslogIdentifier`）。为一个 500 行的中继
 * 增加常驻线程与 13 个包，换不到任何东西。
 * 取证 `docs/legacy-spec/open-source-options.md` §A.5.2、§C。
 *
 * **零知识是在类型层面兜住的**：字段值只允许 `string | number | boolean`。
 * 想把一个载荷对象、一段会话标题或一条模型输出塞进日志行，编译器就不同意——
 * 这比"记得脱敏"可靠。旧实现收集了 stdout 行却没有任何断言用它们，
 * 本次由 `tests/hardening.test.mjs` 补上：日志里出现业务明文即为失败。
 */
import { type LogLevel, levelWeight } from './config.js'

/** 允许出现在日志行里的值类型。没有 object/array，所以没有"顺手把载荷打出来"这条路。 */
export type LogValue = string | number | boolean

export interface LogFields {
  [key: string]: LogValue | undefined
}

export interface LogRecord {
  ts: string
  level: LogLevel
  msg: string
  [key: string]: LogValue | undefined
}

/** 需要占位的敏感字段一律用它，别把值传进日志调用。 */
export const REDACTED = '<redacted>'

export class Log {
  private readonly threshold: number
  /** 最近若干行，供测试与 `/healthz` 之外的诊断读取（只在内存里，默认留 200 行）。 */
  private readonly tail: LogRecord[] = []

  constructor(
    private readonly level: LogLevel,
    private readonly write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
    private readonly tailSize = 200,
  ) {
    this.threshold = levelWeight(level)
  }

  log(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (levelWeight(level) < this.threshold) return
    const record: LogRecord = { ts: new Date().toISOString(), level, msg }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      record[key] = value
    }
    this.tail.push(record)
    if (this.tail.length > this.tailSize) this.tail.shift()
    this.write(JSON.stringify(record))
  }

  debug(msg: string, fields?: LogFields): void {
    this.log('debug', msg, fields)
  }

  info(msg: string, fields?: LogFields): void {
    this.log('info', msg, fields)
  }

  warn(msg: string, fields?: LogFields): void {
    this.log('warn', msg, fields)
  }

  error(msg: string, fields?: LogFields): void {
    this.log('error', msg, fields)
  }

  /** 已写出的行（含被级别过滤掉的？不含——过滤掉的根本没构造）。测试用 `drain()` 取。 */
  drain(): LogRecord[] {
    return [...this.tail]
  }

  /** 已写出的原始行文本，用于"日志里不许出现业务明文"的断言。 */
  static collectLines(sink: string[]): (line: string) => void {
    return (line) => sink.push(line)
  }
}
