# 微信小程序客户端

目录：`mp/`，原生小程序（无框架、无构建步骤、无 npm 依赖）。

## 用微信开发者工具打开

1. 打开微信开发者工具 → 导入项目 → 目录选 `mp/`。
2. appid：默认 `touristappid`（游客模式，仅供调试）。真机预览/上架前改成你自己的。
3. 详情 → 本地设置 → 勾选 **「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」**
   （开发期连 `ws://127.0.0.1:8787` 必需）。
4. 真机必须 `wss://`，且域名要在小程序后台的 **socket 合法域名** 白名单里。

## 目录

```
mp/
  app.js / app.json / app.wxss      全局：持有 DrcClient 单例
  project.config.json
  utils/
    nacl-fast.js      移植的 tweetnacl（已打补丁，见下）
    drc-crypto.js     base64/UTF-8/KDF/seal/open/计数器 nonce/QR 解析
    store.js          wx.setStorageSync 持久化（PSK / 会话 id / nonce 计数器）
    ws.js             wx.connectSocket 封装 + 指数退避重连
    drc.js            客户端核心：握手、配对、指令、事件分发
    package.json      仅用于把该目录标记为 CommonJS（Node 侧测试用）
  pages/
    index/     配对：扫码 + 6 位配对码
    sessions/  会话列表 + 防休眠开关
    chat/      对话：流式输出、审批卡、提问卡、中断
```

## 握手流程（与 e2e 完全一致）

```
hello{role:'client'}  →  hello-ok
pair-begin-client{token}  →  paired{hostId, sessionId}
kC2H = derivePskKey(psk,'c2h',sessionId)   // 小程序 → 主机
kH2C = derivePskKey(psk,'h2c',sessionId)   // 主机 → 小程序
之后所有业务数据都是 { t:'enc', sessionId, seq, ciphertext }
```

## 为什么 `nacl-fast.js` 被改过

上游 tweetnacl 末尾会探测 `require('crypto')` 来初始化 PRNG。小程序里 `require`
存在但没有 `crypto` 模块，这行会在**加载时**直接抛错、整个文件挂掉。

所以我们把 PRNG 初始化改成了只认全局 CSPRNG（`self.crypto` / `globalThis.crypto`），
**并且不提供 `Math.random()` 兜底**：

- 客户端永远用不到 `randomBytes`：nonce 是计数器，密钥来自配对 PSK；
- 如果哪天误用了，宁可抛错，也不要悄悄用弱随机。

别的文件改动请同步跑 `pnpm -r test`，`e2e/mp-crypto.test.mjs` 会把
`mp/utils/*` 拉到 Node 里和 `packages/protocol` 逐字节对拍。

## 开发期自测（不用开开发者工具）

```sh
pnpm -r test                        # 含下面两项
node --test e2e/mp-crypto.test.mjs  # 10 项：base64/UTF-8/密钥派生/seal-open/篡改检测
node --test e2e/mp-client.test.mjs  # 8 项：真实 drc.js + wx shim 跑完整闭环
```

`e2e/mp-sim.mjs` 提供了一个最小 `wx` shim（storage + `connectSocket` 走 `ws` 包），
所以**小程序客户端代码可以在 Node 里被真实驱动**。改了 `utils/drc.js` 一定要跑它。

## 常见故障

| 现象 | 原因 |
|---|---|
| 一直「连接中」 | 服务地址不对 / 中继没起 / 真机用了 `ws://` |
| `配对失败：配对码无效或已过期` | 超过 TTL（默认 120s），让主机重新 `drc pair` |
| `配对失败：配对码已被使用` | 一次配对码只能用一次，重新生成一个 |
| `配对失败：主机不在线` | host 插件没连上中继，检查 `DRC_HOST_TOKEN` 与日志 |
| `收到无法解密的数据` | PSK 不对（换了配对但客户端还留着旧 PSK）——解除配对重扫 |
| 会话列表一直为空 | host 的 `carrier=mock`（内核桥接没挂上），或真的没有会话 |
| 真机连不上 | 域名白名单 + 必须 `wss://` |

### `wx.connectSocket is not a function`

客户端要的是 **WebSocket**，不是 HTTP。某些运行环境（尤其第三方预览容器）
压根不提供 `connectSocket`，这时任何配对尝试都会以一句 TypeError 告终，
用户既不知道缺什么也不知道怎么办。

`utils/platform.js` 会先探测能力，`utils/ws.js` 按探测结果走两条路：

1. **SocketTask**（基础库 1.7.0+）：`connectSocket()` 返回带 `onOpen/onMessage` 的任务对象；
2. **旧式全局回调**：`onSocketOpen/onSocketMessage/...`（全局监听器只绑一次，避免叠加）。

两条路都没有时，**如实上报「环境缺能力」并停止重连**，配对页显示一行可复制的
环境自检（含 `global.connectSocket` 之类的事实）。把那一行复制出来就能定位。

这类容器里远程控制在原理上无法工作——需要换成微信开发者工具，
或用自己的 AppID 真机调试（并把 `wss://` 域名加进小程序后台的 socket 合法域名）。

## 配对二维码

主机端 `/drc pair` 会在终端直接渲染可扫的二维码（半块字符 + 黑底白字 ANSI），
**默认内嵌 6 位配对码**（`&t=`），所以扫码即连，不用再手输。
想生成不带码的裸载荷：`/drc pair --no-token`。

编码器是 vendored 的 `qrcode-generator` 1.4.4（MIT），因为插件装进外部 profile 时
必须自包含；校验不靠肉眼——`scripts/validate-qr.mjs` 用 zxing-cpp **真实解码**
渲染结果（28 组含 CJK 与公网 URL）。手写过一版，被这个校验器抓出系统性差异后放弃。

## 还没做

- 图片/文件附件（`cmd.send_prompt.attachments` 协议里有字段，UI 没做）
- 多主机切换（现在是单配对，重新配对会覆盖）
- 消息历史持久化（小程序只保留本次会话的内存流）
- 无 WebSocket 的容器下没有替代传输（协议是 WS-only，不打算再造一套）
