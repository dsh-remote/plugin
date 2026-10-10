/**
 * 宿主侧读**用户可见文案表**（V3-PLAN §7 阶段 F2）。
 *
 * ## 这张表是什么、不是什么
 *
 * 事实源是 [`copy/zh-cn.json`](../../copy/zh-cn.json)（纯 JSON，两个消费方共用一份）：
 * 宿主插件直接 import 它，微信小程序那份由 `packages/client/scripts/gen-mp-copy.mjs`
 * 从**同一个文件**生成（小程序没有构建步骤，生成 + `--check` 是与设计 token
 * `gen-mp-theme.mjs` 同一套形状的既有做法）。
 *
 * ⚠️ **它不是设计 token。** §9.13 的拍板是「文案可以共享**字面**，设计 token 不行」——
 * 两端的设计 token 名一致而**值故意不同**（pill 用宿主的 `--dsw-alias-*`，小程序用 TDesign 的
 * `--td-*`），而同一句中文在两端必须**逐字相同**，否则用户会以为那是两件事。
 * 所以这两类东西**分表放**，不许互相搬。
 *
 * ## 为什么事实源放在宿主这边
 *
 * 计划原文是「文案表统一（宿主侧中文与 mp 侧共用一份）」——宿主是这份字面的主人
 * （`runtime.ts` 的审批按钮、`pill.ts` 的状态抬头都由它说出口），小程序是消费者。
 * 反过来放会让"谁改文案"这个问题没有答案。
 *
 * ## 为什么它能住在插件包里而不越界
 *
 * 这不是"把小程序的东西塞进宿主"，而是**协议语义的中文表述**：审批选项 id（F10）、
 * `pair-fail` 的四个 reason（F6）、配对/连接状态都是 `DESIGN.md` 冻结的语义，
 * 两端只是各自把它说成中文。
 */
import zh from '../../copy/zh-cn.json' with { type: 'json' }

/** 一个状态词条的形状。`ends` 是"哪几端真的会把它说出口"，判据按它核对。 */
export interface CopyEntry {
  /** 给用户看的那句话。`{{n}}` 是唯一的占位符。 */
  zh: string
  /** `host` / `client` / `both`。 */
  ends: 'host' | 'client' | 'both'
}

/** 状态词条表。键是语义 id，不是界面位置。 */
export const STATUS_ZH = zh.status as Record<string, CopyEntry>

/** 审批三键（`id` 是行为分支条件，F10 冻结；`label` 才是文案）。 */
export const APPROVAL_OPTIONS = zh.approval.options as ReadonlyArray<{ id: string; label: string }>

/** 「始终允许」的边界说明。按钮上只有四个字，边界必须另有承载（§9.1）。 */
export const APPROVAL_SCOPE_HINT = zh.approval.scopeHint

/** `pair-fail` 四个 reason 的中文说法（F6）。 */
export const PAIR_FAIL_ZH = zh.pairFail as Record<string, string>

/**
 * 取一个状态词条。
 *
 * **未知 id 返回 `undefined` 而不是兜底串**：返回一个"看起来对"的兜底，
 * 会把"这个 id 没进文案表"这件事藏起来，而那正是本文件要暴露的错误。
 * 界面层自己决定拿不到时怎么办（宿主 pill 有品牌名兜底，小程序有"未连接"兜底）。
 */
export function statusText(id: string): string | undefined {
  return STATUS_ZH[id]?.zh
}

/** `等 {{n}} 件事` —— 唯一一个带占位符的词条。 */
export function waitingText(count: number): string {
  const template = STATUS_ZH.waiting?.zh ?? '等 {{n}} 件事'
  return template.replace('{{n}}', String(count))
}

/** 配对失败原因的中文说法；未知 reason 返回 `undefined`（不编造第四种说法）。 */
export function pairFailText(reason: string): string | undefined {
  return PAIR_FAIL_ZH[reason]
}
