/**
 * iso — 把一个毫秒时刻写成 ISO 字符串，**越界时不抛**。
 *
 * ## 为什么需要它
 *
 * `new Date(n).toISOString()` 在 `|n| > 8.64e15` 时抛 `RangeError`（Date 的
 * 合法范围上限是 ±8.64e15 ms ≈ 公元 275760 年）。而这个调用在本项目里出现在
 * **构造 status.json 快照**的过程中，`shell/status.ts` 的写盘外面包着一个
 * 空 catch（"状态入口不许成为崩溃源"，那条纪律本身是对的）——
 * 于是**一帧数据里的一个越界时刻，会让整个 status.json 从此永久停更**，
 * 而 GUI 宿主里那是唯一的排错入口（`carrier` / `relay` / `problems` 全部冻在
 * 启动那一版，且没有任何日志说这件事）。
 *
 * 实测触发路径：中继回一条 `pair-ready{ttlMs: 1e17}`（协议层那条约束是
 * 2026-10-07 才补的，而**更老的中继仍在跑**）→ 端点算 `createdAt + ttlMs`
 * → 写进 status 快照时 `toISOString` 抛 → 每 3 秒的快照全丢。
 *
 * ## 口径：越界 ⇒ `undefined`，不是"回一个假的"
 *
 * 回一个假时刻（epoch、夹到上限）会让用户看到一个**看起来正常但错的**过期时间，
 * 而"没有这个字段"在界面上的表现是"不显示时间角标"——一个诚实的缺席。
 * 这与 wire 层 `isoOrUndefined` 的取舍是同一条（见 `payloads.ts`）。
 */

/** Date 的合法范围上限（毫秒）。超过它 `toISOString` 抛 RangeError。 */
const MAX_TIME_MS = 8.64e15

/**
 * 毫秒 → ISO 字符串；不是有限数或越界时给 `undefined`。
 *
 * 注意 `NaN` / `Infinity` 也在这里被挡掉：`JSON.stringify(NaN)` 是 `null`
 * （悄悄变成一个空字段），而 `new Date(NaN).toISOString()` 直接抛。
 */
export function isoOrUndefined(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  if (Math.abs(ms) > MAX_TIME_MS) return undefined
  return new Date(ms).toISOString()
}
