/**
 * peer-reconnect — 对端（微信小程序）重连参数的**镜像**。
 *
 * 为什么这里会有一份"抄来的数字"：中继的客户端慢消费者窗口必须**严格大于**
 * 对端自己"连一次带退避的完整周期"。这条不变量的唯一事实源在小程序仓的
 * `mp/core/socket.js` 里，而中继是独立仓——独立仓里拿不到那份源码。
 *
 * 于是分工是：
 * - **小程序仓**（`dsh-remote-mp`）拥有这些值，改动它们时会同时改这份镜像；
 * - **本仓的测试**优先读 `DRC_MP_SOCKET`（或合仓里的 `../../mp/core/socket.js`）指到的源码，
 *   读得到就以源码为准，并在 `limits.test.mjs` 里断言镜像与源码仍然一致；
 * - 源码不在（独立仓的 CI）时退回这份镜像，测试名里会显式标明。
 *
 * 取值出处：`mp/core/socket.js` —— `RECONNECT_MIN_MS` / `RECONNECT_MAX_MS` /
 * `CONNECT_TIMEOUT_MS`，以及退避抖动 `Math.floor(Math.random() * 500)`。
 */
export const PEER_SOURCE = 'dsh-remote-mp:mp/core/socket.js'

export const PEER_RECONNECT = {
  connectTimeoutMs: 12000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 30000,
  reconnectJitterMs: 500,
}

/** 对端"被踢 → 重连成功"的一整个周期上界（毫秒）。 */
export const PEER_CYCLE_MS =
  PEER_RECONNECT.connectTimeoutMs + PEER_RECONNECT.reconnectMaxMs + PEER_RECONNECT.reconnectJitterMs
