# 安全模型

## 一句话

**中继服务器是不可信的。** 它只负责把密文从 A 搬到 B，看不到任何指令内容、
会话标题、审批详情或模型输出。

## 信任边界

| 角色 | 持有什么 | 不持有什么 |
|---|---|---|
| Host 插件（跑在你的机器上） | PSK、会话密钥、`DRC_HOST_TOKEN`、DSH 内核访问权 | — |
| 中继服务器 | `DRC_HOST_TOKEN`（只用于验证 host 身份）、配对码 → 会话 id 的路由表 | **任何载荷密钥**；看不到明文 |
| 小程序客户端 | PSK（配对时从二维码拿）、会话密钥 | `DRC_HOST_TOKEN` |

载荷一律是 `base64( nonce(24) ‖ nacl.secretbox(utf8(JSON), nonce, key) )`。
服务器看到的帧长这样：

```json
{ "t": "enc", "sessionId": "c_9f3c1a", "seq": 12, "ciphertext": "2Yb7…" }
```

控制面（`hello` / `auth` / `pair-begin` / `paired` / `peer-joined` 等）是明文的，
但里面**没有任何业务内容**。`e2e/run.mjs` 最后一步就是审计这件事：把所有服务器
侧观察到的帧翻一遍，断言里面不出现 `cmd.send_prompt`、不出现指令正文。

## 配对流程

```
Host                            Relay                         小程序
 │ createPairing()                                              
 │   生成 16B PSK + 6 位配对码                                    
 │── pair-begin{token, psk} ──▶  登记 (token → hostId, psk, TTL)  
 │   显示二维码 dshr:/p?s=…&psk=…                                
 │                                                      扫码 ──┐
 │                                                             │ 得到 server + psk
 │                                ◀── hello{role:client} ──────┘
 │                                ──▶ hello-ok
 │                                ◀── pair-begin-client{token} ──
 │                                ──▶ paired{hostId, sessionId}
 │◀── peer-joined{sessionId} ─────                              │
 │                                                             │
 │  双方各自派生：kC2H = KDF(psk,'c2h',sessionId)                │
 │               kH2C = KDF(psk,'h2c',sessionId)   ─────────────┘
 │                                                              
 │◀════════════ enc 帧（密文，服务器只转发）════════════════════▶│
```

安全属性：

1. **PSK 每次配对都轮换**，只通过你眼前的二维码传递，不走网络。
2. **配对码（6 位）单次使用**：服务器用完即标 `used`，重放会得到
   `pair-fail: already_used`。默认 TTL 120 秒（`DRC_PAIR_TTL_MS`）。
3. **双因子**：二维码给密钥，6 位码给授权。只截获二维码（比如截图外泄）
   并不能完成配对，还得在 TTL 内猜中 6 位码。
4. **方向分离**：`c2h` 和 `h2c` 是两个不同的密钥，重放攻击无法跨方向。
5. **前向安全**：⚠️ **没有**。PSK 派生的长期会话密钥在单次配对会话内复用。
   会话密钥绑定 `convId`，每次配对 `convId` 都变，所以实际影响范围是一次配对，
   不是永久历史。若要严格前向安全需换成 X25519 握手（见下）。

## 为什么小程序用 PSK 而不是 X25519

原因很实在：

- 微信小程序环境**没有可靠的安全随机源**（`crypto.getRandomValues` 不可用），
  而 X25519 密钥生成必须有 CSPRNG；
- 小程序里没有成熟、体积可接受的纯 JS x25519 实现，tweetnacl 的
  `box.keyPair()` 依赖 `randombytes`，我们已把它**主动禁用**（见
  `mp/utils/nacl-fast.js` 末尾的补丁注释）——宁可让 PRNG 调用抛错，
  也不要悄悄退化成 `Math.random()`。

PSK 方案在这里是安全的，因为：

- PSK 是 16 字节真随机（由 **Node 侧**的 CSPRNG 生成）；
- 它只在配对窗口出现，单次有效；
- wire 格式与 Node 侧完全一致，且用 `e2e/mp-crypto.test.mjs` 逐字节对拍。

**nonce 怎么办？** 小程序侧用计数器 nonce：
`nonce = KDF(psk, convId, installId)[0..16] ‖ counter(8B big-endian)`。
密钥本身已经绑定了 (PSK, 会话, 方向)，计数器单调递增并持久化，
所以 (key, nonce) 不会重复。存储被清空时 `installId` 也会变，前缀随之改变。

## 6 位配对码的暴力枚举（已知风险与缓解）

配对码空间只有 10⁶，如果中继完全不限流，理论上可被枚举。服务内置了四层缓解：

1. **单连接尝试上限**：同一个 socket 连续输错 `DRC_MAX_PAIR_ATTEMPTS`（默认 5）次
   配对码即被断开（close 4008）。想继续试必须重新建连。
2. **全局配额**：`DRC_MAX_PAIR_ATTEMPTS_PER_SEC`（默认 20/s）限制整体尝试速率。
3. **TTL**：配对码默认 120 秒过期，公网建议调到 60 秒（`DRC_PAIR_TTL_MS`）。

   综合起来，一次配对窗口内能被猜的次数约 20 × 60 = 1200 次，命中概率 ~0.12%。
4. **`/api/pair-status` 默认关闭**：否则它就是一个无需认证的“这个码对不对”查询接口。

**仍需你在反代层做的**：按 IP 做连接速率与请求速率限制（中继只有全局和单连接配额，
看不到真实客户端 IP 除非你透传）。这是把概率再压一两个数量级的关键一环。

如果你需要更强的保证，把配对码加长即可（改 `relay-client.ts` 与小程序
`normalizePairingToken` 的 6 位正则、以及服务端 `pair-begin` 的校验）——
wire 协议本身不绑定位数。

## 传输层：TLS 是部署方的责任

中继自己不终止 TLS。公网部署时请在前面挂反向代理（nginx / Caddy / Cloudflare），
terminate TLS 后把 `wss://` 转到本机 `ws://`：

```
小程序 ──wss/TLS──▶ nginx ──ws(明文, 仅本机)──▶ relay:8787
```

即使这一段是明文，传输的也已经是端到端密文了。但 TLS 仍然必要：

- 防止中间人篡改控制面（例如把 `paired` 的 `sessionId` 换掉，造成 DoS）；
- 防止流量分析之外的元数据被动泄露（谁在什么时候连了多久）。

小程序真机**强制要求** `wss://`，且域名需在后台 socket 合法域名白名单里。

## 密钥存放在哪

- Host 侧：PSK 只在内存里（`pendingPair`），进程重启即失效；`DRC_HOST_TOKEN`
  建议放环境变量而不是写进配置文件。
- 小程序侧：PSK、会话 id、nonce 计数器存在 `wx.setStorageSync`（应用沙箱内）。
  **丢失它只是需要重新配对**，不会有历史泄露。

## 已知的取舍

| 项 | 现状 | 影响 |
|---|---|---|
| 前向安全 | 无（PSK 派生） | 一次配对内的密文若被留存且 PSK 泄露，可被解开 |
| 服务器持久化 | 无（纯内存） | 重启即丢配对关系，反而缩小了泄露面 |
| 客户端认证 | 只有配对码 | 配对后的客户端没有额外凭据；若会话被劫持（理论上需要密钥）无法区分 |
| 重放 | 单次配对码 + 计数 nonce | 服务器不记录已见 nonce，但因密钥每配对轮换，重放到别的会话无效 |

## 报告安全问题

请直接开 issue 或联系维护者，不要公开披露。
