/**
 * host-context —— 宿主注入面的最小形状与服务名表（v5 R2c 提出，供 index 与 carrier-probe 共用）。
 *
 * ⚠️ `ctx` 是 cordis 的 Proxy：**读不存在的属性名会抛错**而不是返回 undefined
 * （`?.` 挡不住）。所以这张接口把"我们敢碰的面"逐个列出来，其余一律不碰。
 */
export interface HostContext {
  get?<T>(name: string, optional: true): T | undefined
  /**
   * `inject(names, cb)` 的回调参数**不是服务实例，而是已作用域化的上下文**（`c.get(name, true)`
   * 才拿到服务），并且这条回调 fiber 挂在我们这条 fiber 下面——我们的 fiber 一旦失败，
   * 它会连带被 dispose，回调就永远不会触发了（真机取证见 `apply()` 末尾那条纪律）。
   */
  inject?(names: string[], callback: (scoped: HostContext) => void): unknown
  /** 事件注册口；作用域化上下文上才有，对 waterfall 是参与式监听（见 platform/guard.ts）。 */
  on?(name: string, listener: (...args: unknown[]) => void): unknown
  off?(name: string, listener: (...args: unknown[]) => void): unknown
  provide?(name: string, value: unknown): unknown
  /**
   * cordis 唯一的卸载钩子：`ctx.effect(() => disposer)`。
   * **没有 `onDispose` 这个东西**——ctx 是 Proxy，读不存在的属性名是"抛错"而不是
   * 返回 undefined，`?.` 挡不住（真机取证：`cannot get property "onDispose" without inject`
   * 让 apply 整体失败 → fiber FAILED → 六个 inject 子 fiber 全被 dispose → carrier=none）。
   */
  effect?(execute: () => (() => unknown) | void): unknown
}

/** 从宿主注入里认领的服务名（`services > (mock)` 的判据面）。 */
export const SERVICE_NAMES = [
  'sessions',
  'sessionQuery',
  'agents',
  'agentDefaultModel',
  'workspaceRegistry',
  'userQuestions',
  'sessionController',
  // 图片附件的持久存储（2026-10-06 真机事故后接上）。
  // 带图发提示必须经 `attachments.admitPromptContent()` 或 `sessionController.commands.prompt`，
  // 否则内核序列化时读 `block.attachment.attachmentId` 会把整个回合打成
  // `Cannot read properties of undefined (reading 'attachmentId')`。
  'attachments',
]
