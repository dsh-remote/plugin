/**
 * 插件路由的**绝对地址**解析（2026-10-20 补，DSH 0.2.1-rc.2）。
 *
 * ## 为什么不能再用相对路径
 *
 * 0.2.1 的桌面版把页面挂在**自定义 scheme** `dsh-app://` 上（Electron
 * `--standard-schemes=dsh-app`），而插件路由仍在宿主自己的 HTTP 监听上
 * （`http://127.0.0.1:<port>/plugins/dsh-remote-control/*`）。
 * 在 `dsh-app://` 页面里 `fetch('/plugins/...')` 解析成 `dsh-app://plugins/...`，
 * 那个 scheme 只服务静态外壳 ⇒ 请求**根本没出去**，浏览器给的 status 是 `0`
 * （用户看到的「HTTP 0」）。web 形态同源，相对路径本来就能用。
 *
 * ## 宿主给的出口
 *
 * 0.2.1 的桌面静态页会注入
 *
 *     window.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: <宿主 HTTP origin> }
 *
 * 官方前端自己的写法就是 `__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI`。
 * 这里照抄那个口径，并且**任何一步取不到都退回相对路径**：
 * 退回相对路径在 web 上完全正确，在桌面最坏也只是维持今天的行为（不乱抛）。
 *
 * ⚠️ 本函数在**模块求值期之外**被调用，且绝不允许抛——这一半抛一次就是整页起不来。
 */
export function resolveHostUrl(path: string): string {
  try {
    const transport = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: unknown } }).__DSH_TRANSPORT__
    const claimed = transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl.trim() : ''
    const base =
      claimed !== ''
        ? claimed
        : typeof document !== 'undefined' && typeof document.baseURI === 'string'
          ? document.baseURI
          : ''
    if (base === '') return path
    /**
     * 只取 origin 再拼路径 —— **刻意不用 `new URL()`**：
     * 测试的 vm 沙箱不给 `URL`（只有浏览器有），而这一半的判据必须在那个沙箱里跑。
     * 路由都是绝对路径，所以"origin + 路径"与 `new URL(path, base)` 等价。
     */
    const origin = /^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/]*/.exec(base)?.[0] ?? ''
    return origin === '' ? path : origin + path
  } catch {
    return path
  }
}
