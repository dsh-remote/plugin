/**
 * 插件版本号——pill 弹窗里那一行「版本」的唯一来源。
 *
 * 值由 `scripts/bundle-plugin.mjs` 打包时用 esbuild 的 `define` 注入（`__DRC_VERSION__`）。
 * 直接跑源码（`tsc` 出的 `dist/`，单测走的就是这一条）时没人注入，`typeof` 探到 `undefined`，
 * 退回 `'dev'`——于是"跑的是仓里源码"和"跑的是装进 profile 的那个 bundle"在屏幕上是两种字样。
 */
declare const __DRC_VERSION__: string | undefined

export const PLUGIN_VERSION: string = typeof __DRC_VERSION__ === 'string' ? __DRC_VERSION__ : 'dev'
