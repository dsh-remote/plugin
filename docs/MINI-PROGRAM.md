# 微信小程序客户端

目录：`mp/`，原生小程序。UI 组件用 **TDesign**（腾讯开源，`miniprogram_npm/` 里是
按依赖闭包裁剪过的预构建产物，**无需在开发者工具里构建 npm**）；加密用 vendored
**tweetnacl**，UTF-8/base64 用 vendored **js-base64**——不自己造轮子。

## 用微信开发者工具打开

1. 打开微信开发者工具 → 导入项目 → 目录选 `mp/`。
2. appid：`mp/project.config.json` 里已配置真实 appid。
   真机还需要在微信后台 `开发管理 → 开发设置 → 服务器域名 → socket合法域名`
   加上 `drc.provid.cc`（必须是已备案域名 + 有效证书，且只能用 `wss://`）。
3. 详情 → 本地设置 → 勾选 **「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」**
   （开发期连 `ws://127.0.0.1:8787` 必需）。
4. 真机必须 `wss://`，且域名要在小程序后台的 **socket 合法域名** 白名单里。

> `miniprogram_npm/tdesign-miniprogram` 已按依赖闭包裁剪（约 1.5MB，含 tslib）。
> 升级 TDesign 后需要重新裁剪：`npm i tdesign-miniprogram@latest` 然后把
> `node_modules/tdesign-miniprogram/miniprogram_dist` 里的相关目录拷过来
> （保留 common/mixins/transition/locale/config-provider 与内嵌的 tslib）。
> `node_modules/` 已在 packOptions.ignore 里，不会打进包。

## 目录

```
mp/
  app.js / app.json / app.wxss      全局：持有 DrcClient 单例 + TDesign 主题变量
  project.config.json / package.json
  miniprogram_npm/tdesign-miniprogram/   裁剪版 TDesign（开源 UI 组件库）
  core/
    vendor/
      nacl-fast.js      vendored tweetnacl（已打小程序补丁，见下）
      js-base64.js      vendored js-base64（MIT）：UTF-8 + base64
    codec.js            线格式编解码：KDF/seal/open/计数器 nonce/QR 解析
    env.js              运行环境能力探测 + 一行可复制的环境自检
    socket.js           wx.connectSocket 封装：双路径 + 超时 + 指数退避重连
    session-store.js    wx.setStorageSync 持久化（PSK / 会话 id / nonce 计数器）
    client.js           客户端核心：握手、配对、指令、事件分发（DrcClient）
    package.json        仅用于把该目录标记为 CommonJS（Node 侧测试用）
  pages/
    sessions/  入口页：主机状态 + 防休眠开关 + 会话列表（含已归档徽标）
    pair/      配对：扫码/粘贴二维码 + 6 位配对码 + 高级设置 + 环境自检
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
`mp/core/*` 拉到 Node 里和 `packages/protocol` 逐字节对拍。

## 开发期自测（不用开开发者工具）

```sh
pnpm -r test                          # 含下面几项
node --test e2e/mp-crypto.test.mjs    # 11 项：base64/UTF-8/密钥派生/seal-open/篡改检测
node --test e2e/mp-client.test.mjs    # 8 项：真实 client.js + wx shim 跑完整闭环
node --test e2e/mp-platform.test.mjs  # 3 项：环境探测 + 双路径 socket
```

`e2e/mp-sim.mjs` 提供了一个最小 `wx` shim（storage + `connectSocket` 走 `ws` 包），
所以**小程序客户端代码可以在 Node 里被真实驱动**。改了 `core/client.js` 一定要跑它。

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

`core/env.js` 会先探测能力，`core/socket.js` 按探测结果走两条路：

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

## 真实链路端到端测试

`e2e/live-e2e.mjs` 跑的是**三个真实**：真实的小程序客户端代码（`core/client.js` + wx shim）、
真实的中继（默认 `wss://drc.provid.cc`）、真实的内核（本机 Harness 里的插件）。

与 `scripts/verify-deployment.mjs` 的关键区别：**它绝不退化成 mock 主机** ——
拿不到真实配对码就直接失败。假通过比失败更贵，之前正是"自建主机模式"掩盖了
"配对成功但主机把 peer 丢了"这类真实故障。

```sh
node e2e/live-e2e.mjs                      # 完整闭环（含真实发一条指令）
node e2e/live-e2e.mjs --no-prompt          # 只验证配对/列表/防休眠/零知识
node e2e/live-e2e.mjs --rounds 3           # 连跑 3 轮
node e2e/live-e2e.mjs --session <id>       # 指定会话（可测归档会话自动恢复）
node e2e/live-e2e.mjs --pair <码> --qr '<dshr:…>'   # 手动给码（不依赖自动发布）
```

它会自动避开**已消费**的配对码（码是一次性的，status.json 按定时器刷新而非按消费刷新），
并在失败时打印事件轨迹 —— 这是定位"服务端显示 paired、客户端却没反应"的关键。
