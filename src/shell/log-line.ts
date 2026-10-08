/**
 * log-line — 插件日志里"一个字符串值最多多长"。
 *
 * ## 为什么单独一个文件
 *
 * 中继侧早就有同一条纪律（`dsh-remote-server/src/log.ts` 的 `clampText` +
 * `MAX_LOG_VALUE_CHARS`），理由写在它自己文件头：**一条 409 KB 的日志行和一条 40 字节的
 * 日志行，占的是同一个采集管道的配额**。而错误消息是最容易被忽略的入口——它由内核/网络栈
 * 拼出来，长度不由我们决定（插件侧三处 `message:` 当时一个都没截）。
 *
 * 2026-10-06 把同样的纪律补到插件侧。**单独一个文件而不是写在 `index.ts` 里**，是因为
 * `index.ts` 的 `log` 是 `apply()` 内部的一个闭包：外面拿不到，于是"截断到底生效没有"
 * 只能靠"跑一遍看有没有长行"来验——而启动路径上根本没有长行，那样的判据是**恒绿**的
 * （第一版就栽在这儿：把截断整个去掉，判据依然全绿）。
 *
 * 把它导出成纯函数之后，判据可以直接喂一条 10 万字符的串进去。
 */

/** 日志里单个字符串值（含 `msg`）的最长字符数。与中继侧取同一个值。 */
export const MAX_LOG_VALUE_CHARS = 256

/**
 * 超长就截断并加 `…`。
 *
 * 刻意**不去替脱敏负责**：`tokenHandle()` 那条纪律仍然是调用方的事，截断只治长度。
 */
export function clampLogText(value: string): string {
  return value.length <= MAX_LOG_VALUE_CHARS ? value : `${value.slice(0, MAX_LOG_VALUE_CHARS)}…`
}

/**
 * 把一批字段收成一行可 `JSON.stringify` 的记录，逐个值过截断。
 *
 * `undefined` 的字段**直接丢掉**而不是序列化成 `null`——`JSON.stringify` 本来就会丢，
 * 而丢在这里能让"这个字段没给"与"这个字段是空串"在代码里就分得开。
 */
export function buildLogRecord(
  message: string,
  fields: Record<string, string | number | boolean | undefined>,
  now: string,
): Record<string, string | number | boolean> {
  const record: Record<string, string | number | boolean> = {
    ts: now,
    level: 'info',
    msg: clampLogText(`dsh-remote-control ${message}`),
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    record[key] = typeof value === 'string' ? clampLogText(value) : value
  }
  return record
}
