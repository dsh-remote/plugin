# 开源选型与互操作实测（重写 v2 用）

> 目的：为「除 `mp/` 外从零重写」定下**可核对**的第三方依赖边界。
> 本文只给事实、判定与实测证据，不给实现方案。
>
> 证据约定：
> - `（实测）` ＝ 2026-10-02 在本机 `/tmp/drc-survey` 真实跑过，脚本与原始输出留在该目录，
>   本文每条结论都附「命令 + 输出摘要」。
> - `（未实测）` ＝ 只读了代码/文档，没有跑。
> - 全程 **未向仓库安装任何依赖、未修改仓库任何现有文件**；对仓库文件只做只读 `require`/`import`。
>   对旧代码未跑 build/test（与零复用重写相悖），只在 §A.3 只读 `import` 了已构建的
>   `packages/plugin/dist/src/qr.js` 与 `dist/src/vendor/qrcode-generator.js` 作为**被测对象**（功能对拍）。
>
> 环境：macOS（arm64）、Node `v22.23.3`、npm `10.9.9`、registry `https://registry.npmjs.org/`。
> 所有 Node/npm 命令均以 `env -u NODE_OPTIONS` 前缀执行（HANDOFF §4 的既有约束）。

---

## A 实测结论

### A.0 依赖准备（也是 §A.4 的第一条证据）

```
$ cd /tmp/drc-survey && env -u NODE_OPTIONS npm init -y
$ env -u NODE_OPTIONS npm install --no-audit --no-fund tweetnacl tweetnacl-util base64-js @stablelib/base64 qrcode zxing-wasm
added 37 packages in 7s
$ env -u NODE_OPTIONS npm ls --depth=0
drc-survey@1.0.0 /private/tmp/drc-survey
├── @stablelib/base64@2.0.1
├── base64-js@1.5.1
├── qrcode@1.5.4
├── tweetnacl-util@0.15.1
├── tweetnacl@1.0.3
└── zxing-wasm@3.1.4
```

被试的「权威实现」是本仓库小程序侧文件（只读）：
`mp/core/vendor/nacl-fast.js`（打补丁的 tweetnacl）、`mp/core/vendor/js-base64.js`（3.9.4）、
`mp/core/codec.js`（线格式的唯一权威）。`mp/core/package.json` 已声明 `"type": "commonjs"`，
因此 Node 可以直接 `require` 小程序的真实代码，**测的就是小程序会跑的那份字节**。

---

### A.1 tweetnacl：官方 npm 包与 vendored 补丁版逐字节一致 —— 结论：**一致**

- 脚本：`/tmp/drc-survey/nacl-interop.cjs`
- 原始输出：`/tmp/drc-survey/nacl-interop.out.json`

```
$ cd /tmp/drc-survey && env -u NODE_OPTIONS node nacl-interop.cjs
```

关键向量（实测）：

| 检查 | 向量数 | 结果 |
|---|---|---|
| `nacl.hash`（SHA-512）official vs vendored | **20**（长度 0/1/2/3/55/56/63/64/65/119/120/127/128/129/255/1024/65536 的随机输入 + 空串/`abc`/真实 KDF 拼接串） | **全部一致** |
| `nacl.hash` official vs `node:crypto` sha512 | 同上 20 | **一致**（`hashAgainstNodeCrypto: "official==node:crypto"`） |
| `nacl.secretbox` 密文逐字节 | **63**（50 组随机 key/nonce + JSON 载荷；13 组长度 0/1/15/16/17/31/32/33/64/100/511/4096/20000） | **全部一致，0 差异** |
| vendored 加密 → official 解密 | **50** | 全部成功 |
| official 加密 → vendored 解密 | **50** | 全部成功 |
| 篡改 1 bit 后两侧都必须拒绝 | **50** | 两侧都返回 `null` |
| KDF：`codec.derivePskKey` vs 官方 tweetnacl+Buffer 重算 | **1** | 一致，32 字节：`c6d8a33c610301b5224cdd54d42d15af6759d760ce81f4b80b1fbb957a6a9878` |
| 线格式全链路（`codec.seal` → 官方 `secretbox.open`；官方加密 → `codec.open`） | **50 × 2 方向** | 全部成功，且 `merged[0..23]` 确实等于传入 nonce |

脚本尾部结论行（实测原文）：

```
VERDICT: ALL INTEROP CHECKS PASS (official tweetnacl is a drop-in for the vendored build)
```

补丁差异的量化（同一脚本 §5，实测）：

```
"vendoredVsUpstream": {
  "identical": false,
  "vendoredLines": 2394,
  "upstreamLines": 2392,
  "vendoredRequireCrypto": 2364,   // 这一行是补丁注释里提到的 require('crypto')，不是真调用
  "upstreamRequireCrypto": 2379    // 上游真的调用 require('crypto')
}
```

即：**补丁只动了尾部 PRNG 探测块**（vendored 改为 `self/globalThis.crypto.getRandomValues`，
探测不到就留 `randombytes` 抛错），`hash` / `secretbox` / `secretbox.open` 的计算路径与上游 1.0.3 完全一致。

> 重写含义：Node 侧直接用 `npm i tweetnacl`（1.0.3）即可与小程序逐字节互操作，**不需要 vendor、
> 不需要重打补丁**。但要注意两件事：
> 1. 官方 `nacl.randomBytes` 在 Node 里可用，小程序侧不可用 —— 因此**协议里任何「随机 nonce」
>    在 mp 侧都不成立**，重写必须继续用显式计数器 nonce（`codec.seal` 强制要求 24 字节入参）。
> 2. `tweetnacl` 已停更：`npm view tweetnacl time` 显示 latest 1.0.3 发布于 **2020-02-10**，
>    `time.modified = 2023-04-12`（仅元数据变动）。逃生阀见 §A.5.4。

---

### A.2 base64：vendored `js-base64` 与 Node `Buffer` 一致；其余库更严格 —— 结论：**用 Buffer**

- 脚本：`/tmp/drc-survey/base64-interop.cjs`
- 原始输出：`/tmp/drc-survey/base64-interop.out.json`

```
$ cd /tmp/drc-survey && env -u NODE_OPTIONS node base64-interop.cjs
```

被试 5 个实现：mp `js-base64@3.9.4`、Node `Buffer`（v22.23.3）、`base64-js@1.5.1`、
`@stablelib/base64@2.0.1`、`tweetnacl-util@0.15.1`。

**编码（决定 Node→mp 方向是否可扫）**：长度 0..132 全部取模 3 的三种填充类，各 1 组随机字节，
共 **133 组 × 5 实现**，与 `Buffer.toString('base64')` 比对：

```
"encode": { "vectors": 133, "mismatchCount": 0, "samples": [],
            "paddingClassesVerified": [ {mod3:0,…,"mpEquals":true},
                                        {mod3:1,"b64":"4g==","mpEquals":true},
                                        {mod3:2,"b64":"ViU=","mpEquals":true} ] }
```

**解码（合法输入）**：101 组，全部实现一致，`mismatchCount: 0`。

**真实线格式往返（负载最大的一测）**：

```
"compat": {
  "nodeEncodes_mpDecodes":  { "vectors": 2000, "throwCount": 0, "mismatchCount": 0 },
  "mpEncodes_nodeDecodes":  { "vectors": 2000, "mismatchCount": 0 },
  "whitespaceWrapped":      { "mpRawDecodeThrows": false, "mpAfterCodecStrip": true,
                              "bufferIgnoresWhitespace": true }
}
```

即 2000 组 `nonce(24)‖box` 形状的字节：**Node 编码 mp 一定能解，mp 编码 Node 一定能解，零失败**。

**URL-safe**：`js-base64` 默认（第二参省略）输出标准带填充（`pCezEIbz+Eb/MMMfdVx2` 这类含 `+` `/`），
与 `Buffer` 一致；显式传 `true` 才切 `-` `_`。注意 **`Buffer.from(s,'base64')` 和 mp 的解码器都
同时接受 URL-safe**（实测 `bufferAcceptsUrlSafe: true`、`mpAcceptsUrlSafeWithoutPadding: true`）。

**非法输入差异（这是唯一需要写规矩的地方，14 类抽样）**：

| 输入 | mp js-base64 | Node Buffer | base64-js | @stablelib/base64 | tweetnacl-util |
|---|---|---|---|---|---|
| `QQ`（无填充 len%4=2） | `41` | `41` | **抛** | **抛**(incorrect padding) | **抛**(invalid encoding) |
| `QQE`（无填充 len%4=3） | `4101` | `4101` | **抛** | **抛** | **抛** |
| `Q`（len=1） | **抛** | 空 | **抛** | **抛** | **抛** |
| `QQ!!==`（非法字符） | `41` | `41` | **抛** | **抛** | **抛** |
| `QUVB\nQ1RC` / `QUV B Q1RC`（内嵌空白） | 正常解出 | 正常解出 | **抛** | **抛** | **抛** |
| `QUVB==`（多余填充） | `414541` | `414541` | **抛** | `414541` | `414541` |
| `QUVB\u00e9`（字面反斜杠串） | **抛** | `414541bb4d1e`（垃圾） | **抛** | **抛** | **抛** |
| `_-8=`（URL-safe 字符） | `ffef` | `ffef` | `ffef` | **抛** | **抛** |
| `quvb`（小写）/ 空串 | 与其余实现一致 | 同 | 同 | 同 | 同 |

结论（重写必须照做）：

1. **Node 侧统一用 `Buffer.from(x,'base64')` / `.toString('base64')`** —— 它是**与小程序语义最接近**
   的实现（宽松度 12/14 完全相同）。
2. **不要用 `base64-js` / `@stablelib/base64` / `tweetnacl-util.decodeBase64` 解码入站密文**：
   它们对「无填充 / 非法字符 / 内嵌换行」直接抛错，而 mp 与第三方扫码器**会**接受这类串
   （`codec.js:53` 的注释就明确写了「容忍空白字符」）。用严格库当入站校验 = 凭空制造
   「手机能扫、主机报错」的假故障。
3. 反向差异也要防：`Q` 与含字面反斜杠的串 **mp 抛错、Buffer 静默出垃圾**。所以入站必须
   先做**长度与字符合法性检查**再解密（`codec.open` 的 `merged.length < 40 → null` 就是下限），
   不能依赖 `Buffer` 的宽松性来判断「这是合法 base64」。
4. `tweetnacl-util.encodeBase64` 输出与 `Buffer` 逐字节相同（实测 133/133），仅用于**编码**是安全的。

---

### A.3 `qrcode`（node-qrcode 1.5.4）：可行 —— 生成的 PNG 被 zxing-cpp 正确解码，替换 vendored 编码器无障碍

先确认载荷量级（读 `mp/core/codec.js:144-174` 的 URI 文法 + 基线提交
`git show b026d63:packages/protocol/src/crypto.ts` 的 141-149 行构造器），再用同一文法实测生成长度：

| 场景 | URI | 长度 |
|---|---|---|
| 典型（真实线上样本） | `dshr:/p?v=1&s=wss%3A%2F%2Fdrc.provid.cc&n=bins-macbook&psk=…%3D%3D&t=173142` | **98 B** → QR **v6 / 41 模块** |
| 最坏（长域名+长路径+CJK 主机名） | `…&s=wss%3A%2F%2Frelay-team-prod.internal.example-corp.cn%3A8787%2Fdsh-rc-ws-gateway&n=doris-etl-jumpbox-%E7%94%9F…` | **188 B** → QR **v9 / 53 模块** |

- 脚本：`/tmp/drc-survey/qr-interop.mjs`（主）与 `/tmp/drc-survey/qr-extra.mjs`（补充），
  产物 `/tmp/drc-survey/qr-interop.out.json`、`qr-extra.out.json`、`qr-worst.png`、`legacy-qr.png`
- 解码器：`zxing-wasm@3.1.4`（ZXing-C++ 的 WASM 移植，Node 可用）
  ＋ 本机 venv 的**原生 zxing-cpp Python 绑定**交叉验证

```
$ cd /tmp/drc-survey && env -u NODE_OPTIONS node qr-interop.mjs
```

实测结果：

| 检查 | 结果 |
|---|---|
| 98 B 典型 URI：PNG（`margin:4, scale:8`）→ zxing-wasm 解码 | **逐字节一致**，`format=QRCode`，392×392 px，3551 B |
| 188 B 最坏 URI | **一致**，488×488 px，5603 B |
| 长度扫描 40/98/150/200/300/400/600/700/900/1100 B | **全部 ok**（v3…v27），1100 B 仍是 798×798 px，容量余量 ≥5× |
| 纠错级 L/M/Q/H（H 用 `margin:0, scale:3` 极端紧凑） | **4/4 全部解出** |
| 尺寸鲁棒性 `scale∈{2,3,4,8} × margin∈{0,2,4}` 共 12 组 | **12/12 全部解出**；最小的 82×82 px（scale2/margin0）也能扫 |
| 非 ASCII 载荷 `dshr:/p?v=1&n=生产机-01&psk=abc+def==` | **roundTrip: true** —— node-qrcode 默认按 UTF-8 分段（Byte+Numeric 混合，实测 `maskPattern: 2`），不会重现旧 vendored 编码器「charCode 截断成 1 字节」的静默乱码缺陷（见 `packages/plugin/src/qr.ts:29-37` 的补丁说明） |
| 与旧 vendored `qrcode-generator` 的**矩阵**逐位比对 | 版本/模块数相同（v6 / 41×41），**853/1681 个模块不同**（掩码选择不同）；**旧矩阵渲染成图后同样被 zxing-cpp 正确解码** |
| 旧实现 PNG（`dist/src/qr.js` 的 `qrPng`）vs node-qrcode PNG | 392×392 相同；旧 `colour type 0`（灰度）1293 B，新 `colour type 6`（RGBA）3551 B；**两者都解出** |

原生 zxing-cpp（非 WASM）交叉验证（实测）：

```
$ /Users/linbin/.workbuddy/binaries/python/envs/default/bin/python -c '… zxingcpp.read_barcodes …'
/tmp/drc-survey/qr-worst.png   png=(488,488) mode=RGBA found: 1
   format=QR Code ecc=M text=dshr:/p?v=1&s=wss%3A%2F%2Frelay-team-prod…&t=173142
/tmp/drc-survey/legacy-qr.png  png=(392,392) mode=L    found: 1
   format=QR Code ecc=M text=dshr:/p?v=1&s=wss%3A%2F%2Fdrc.provid.cc&n=bins-macbook&psk=…&t=173142
```

> 掩码不同 ≠ 不兼容：**二维码没有任何字节级契约**，契约只在「解出来的文本」上。旧仓库的
> 校验器注释（`scripts/validate-qr.mjs:5-9`）早已得出同一结论（「逐位比对会被合法填充选择差异干扰，
> 所以直接做功能校验」）。因此替换 vendored 编码器是**安全的**。

装进外部 profile 的可行性（这是「依赖必须能随包安装」的关键）：

```
$ mkdir /tmp/drc-survey/probe-qrcode && cd … && env -u NODE_OPTIONS npm install --omit=dev qrcode
added 29 packages in 4s
$ find node_modules -name '*.node' -o -name 'binding.gyp'      # 无输出
$ du -sh node_modules                                          # 2.4M
$ find node_modules -name '*.js' | wc -l                       # 114
```

- **纯 JS，无原生编译**（`*.node`/`binding.gyp` 一个都没有）→ `pnpm add -w file:$PLUGIN` 装进
  `~/.dsh/profiles/desktop` 时不会触发 node-gyp，与现有 `ws`/`tweetnacl` 同级风险。
- `qrcode` 的直接依赖只有 `dijkstrajs / pngjs / yargs`；**但运行时并不需要 yargs**：
  实测 `node_modules/qrcode/lib/server.js` 的 `require` 列表为
  `[./can-promise, ./core/qrcode, ./renderer/png, ./renderer/utf8, ./renderer/terminal, ./renderer/svg, ./browser]`，
  不含 yargs（yargs 只服务 `bin/qrcode` CLI）。代价是 npm 仍会把 yargs 的 **27 个传递包**装下来
  （`qrcode` 闭包 = 29 个包 / 2.4 MB）。
- 终端渲染要**自己写 15 行**：`QRCode.create(text)` 暴露原始矩阵（实测 `modules:41`、
  `qr.modules.data[y*size+x].value`），旧的 `ascii`（`##`/`..`）兜底样式可以继续做；
  node-qrcode 自带 `type:'terminal'` 输出的是 ANSI + 半角块（实测 23 行，
  样例行 `\x1b[47m\x1b[30m ▄▄▄▄▄▄▄     ▄▄▄ ▄▄ ▄ ▄ ▄ ▄▄`），正是 `qr.ts:44-51` 判定「最脆弱」的那类。

**未实测**（诚实标注）：真机 iOS/Android 相机 + 微信 `wx.scanCode` 对 node-qrcode 输出的实拍扫描；
把带 `qrcode` 依赖的插件真的装进 `~/.dsh/profiles/desktop` 并让线上 Harness 加载。
两者风险都很低（前者由「12/12 尺寸 × 4 纠错级全解出 + CJK 载荷通过」支撑；后者由「纯 JS + 已有 ws 先例」支撑），
但重写后必须在 §A.3 的两条上各补一次真跑。

---

### A.4 本机 npm 源连通性 —— 结论：**正常**

全部命令都带 `env -u NODE_OPTIONS`；**没有出现需要回退的情况**（因此该前缀在本机是否为必需，本文不下结论）。

| 命令 | 结果 |
|---|---|
| `npm install tweetnacl tweetnacl-util base64-js @stablelib/base64 qrcode zxing-wasm` | `added 37 packages in 7s` |
| `npm install @stablelib/base64 qrcode zxing-wasm`（重跑） | `up to date in 1s` |
| `npm install zod valibot pino` | `added 16 packages in 5s` |
| `npm install --omit=dev qrcode`（干净目录） | `added 29 packages in 4s` |
| `npm install --omit=dev zod pino qrcode tweetnacl tweetnacl-util ws`（干净目录） | `added 47 packages in 6s`，46 个包 / 13 MB，无 `.node` |
| `npm view` 20 个候选包 | 全部解析成功，**唯一 404：`uWebSockets.js`（npm 上确实不存在，见 §C）** |

网络侧唯一失败发生在 **GitHub git 协议**（不是 npm）：

```
$ timeout 240 git clone --depth 1 https://github.com/slopus/happy happy
Cloning into 'happy'...
error: RPC failed; curl 28 Recv failure: Operation timed out
fatal: expected flush after ref listing
```

改用 `https://codeload.github.com/slopus/happy/zip/refs/heads/main` **成功**（126,671,256 B，exit 0）。
→ 重写期取 GitHub 材料优先走 codeload tarball；`git clone` 在本机对大仓不稳。
另：`~/Downloads/ds-harness-remote-main.zip`（7,056,085 B）在前台 `cp`/`unzip` 时**两次超时被转入后台**
（疑与该目录的同步/权限解析有关），后台执行最终 exit 0 并成功解压。教训：大文件搬运要留足超时。

---

### A.5 附加实测（§C 的判定依据）

脚本：`/tmp/drc-survey/bench.mjs`（输出 `bench.out.json`）、`/tmp/drc-survey/crypto-alternatives.mjs`。

**A.5.1 帧校验：zod 4.6.5 / valibot 1.5.0 / 手写 type guard**（200,000 次「JSON.parse + 校验」，
被试帧是 `{t:'enc',sessionId,seq,ciphertext}` 与 `{t:'hello',role,protocol,clientId,clientMeta}`
的 discriminated union，实测原文）：

```
"zod (parse + validate)":                    { "iterations": 200000, "ms": 90,  "opsPerSec": 2218171, "parsed": 200000 }
"valibot (parse + validate)":                { "iterations": 200000, "ms": 151, "opsPerSec": 1320602, "parsed": 200000 }
"hand-written type guard (parse + validate)":{ "iterations": 200000, "ms": 69,  "opsPerSec": 2887826, "parsed": 200000 }
```

对照中继自己的上限 `MAX_FRAMES_PER_SEC = 500`（`apps/server/src/main.mjs:46`）：zod 的 220 万/秒
**超出需求 ~4400 倍** → 性能不是选型因素，**可维护性才是**；手写只快 1.3 倍却要维护两份契约。

**A.5.2 日志：pino 10.3.1 vs 自写 NDJSON**（50,000 行同一结构化记录，实测）：

```
"logPino":                        { "lines": 50000, "ms": 51 }        // 目标 /dev/null
"logJsonStringifyWriteSync":      { "lines": 50000, "ms": 114, "fileBytes": 4600000 }
"logConsoleWithStringify":        { "lines": 50000, "ms": 11 }         // ⚠ console.log 被替换成 no-op，只量了 stringify
```

→ 「pino 比手写快」在本机不成立（51 ms vs 114 ms 是**异步丢弃 vs 同步落盘**的差别，不可比）。
**真实 tty 下的 `console.log` 性能：未实测**。
但 pino 的**结构性代价**量到了 —— 它默认起 `thread-stream` 工作线程：

```
pino 进程线程数 (ps -M) = 11
裸 node 进程线程数       = 7
```

以及生产依赖闭包：**pino = 13 个包**（`@pinojs/redact, atomic-sleep, on-exit-leak-free,
pino-abstract-transport, pino-std-serializers, process-warning, quick-format-unescaped,
real-require, safe-stable-stringify, sonic-boom, thread-stream`）。对一个已有 systemd-journald
兜底收集/轮转的 500 行中继，这是**净增常驻线程**。

**A.5.3 依赖闭包与体积（干净目录 `--omit=dev` 实测）**：

```
zod            闭包 1 个包，0 运行时依赖（磁盘 8.0M，多入口产物）
ws             闭包 1 个包，0 运行时依赖
tweetnacl      闭包 1 个包，0 运行时依赖
tweetnacl-util 闭包 1 个包，0 运行时依赖
pino           闭包 13 个包
qrcode         闭包 29 个包（yargs 传递 27）
全部一起（zod pino qrcode tweetnacl tweetnacl-util ws）：47 packages，46 个 node_modules 条目，13 MB，0 个 .node
```

**A.5.4 维护性逃生阀：@noble/ciphers 2.4.0 / @noble/hashes 2.4.0 与本仓库 vendored 逐字节等价**
（60 组随机向量，实测原文）：

```
"sha512":    { "pass": true, "vectors": 60, "diffs": [] }
"secretbox": { "pass": true, "vectors": 60, "diffs": [],
               "note": "xsalsa20poly1305 ciphertext layout vs tweetnacl secretbox" }
"nodeCryptoHasXsalsa": []
```

三条结论：
1. `node:crypto` **没有** XSalsa20-Poly1305（`crypto.getCiphers()` 过滤 salsa 后为空数组）→
   线格式**必须**走纯 JS 实现（tweetnacl 或 noble），不能靠原生。
2. 若 `tweetnacl`（2020 停更）将来成为负债，`@noble/ciphers/salsa` 的 `xsalsa20poly1305`
   与 `@noble/hashes` 的 `sha512` **可直接替换**（60 组密文逐字节相同，且 noble 密文能解密
   vendored nacl 的输出）。栈已定 tweetnacl，本文只把这条当**风险对冲记录**。
3. **不引入 `libsodium-wrappers`**（0.8.4）：它是 WASM，体积/加载路径都重于纯 JS，而我们要的只有 2 个原语。
   **不引入 `nacl`（0.1.3）**：陈旧、与 tweetnacl 无兼容性证据。

---

## B 开源参考提炼

### B.1 `github.com/slopus/happy`（原始需求点名参考）

材料来源：codeload zip `happy-main.zip`（126 MB，main 分支快照，日期戳 2026-09-28），
已解压到 `/tmp/drc-survey/happyx/happy-main/`。实读：`README.md`、`PRIVACY.md`、`docs/{README,
encryption, protocol, happy-wire, backend-architecture, realtime-sync-and-rpc, session-protocol,
multi-process, user-identity}.md`，以及源码 `packages/happy-cli/src/api/{encryption,auth}.ts`、
`packages/happy-app/sources/encryption/deriveKey.ts`、`packages/happy-app/sources/app/**` 路由树、
`packages/happy-server/package.json`。`git clone` 失败原因见 §A.4。

工作区组成（实测 `unzip -Z1` + `package.json`）：`happy-cli`（包装 Claude Code/Codex 的宿主端）、
`happy-app`（Expo：web + iOS + Android）、`happy-server`（Fastify + Socket.IO + Prisma/Postgres + S3 + Redis）、
`happy-wire`（**共享 wire schema 包**）、`happy-agent`、`happy-desktop`(独立仓)、`happy-server-self-host`。

#### B.1.1 端到端加密方案

| 维度 | happy 的做法（证据） | 与本项目的关系 |
|---|---|---|
| 数据面原语 | **两套并存**：`legacy` = `tweetnacl.secretbox`，布局 `nonce(24)‖ct+tag`，随机 nonce；`dataKey` = **AES-256-GCM**，布局 `version(1)‖nonce(12)‖ct‖tag(16)`（`docs/encryption.md:66-105`、`happy-cli/src/api/encryption.ts:86-160`） | `legacy` 与我们**完全同源**（同一 tweetnacl secretbox、同 24B nonce 前缀）；`dataKey` 是 mp 无法支持的形态 |
| 密钥派生 | **HMAC-SHA512 KeyTree**（BIP32 式）：`root = HMAC(usage+' Master Seed', seed)`，`child = HMAC(chainCode, 0x00‖index)`，`deriveKey(master, usage, path[])`（`happy-app/sources/encryption/deriveKey.ts`）；blob key 再按 `('Happy Blobs', [path])` 派生 | 比我们的「一次 SHA-512 截断」**域名分离更好**；但 mp 的 `derivePskKey` 输入与算法**已冻结** → 会话密钥处不能采纳 |
| 每对象密钥 | 每个 session/machine/artifact 一个 **DEK**，DEK 本身用 `nacl.box` + **临时密钥对**封装成 `ephPub(32)‖nonce(24)‖ct`，再加版本字节，作为 `dataEncryptionKey` 存服务端（`docs/encryption.md:107-155`） | 这是「换手机/多设备复用同一会话」的机制；mp 的配对模型（PSK 在 QR 里 + 按方向派生）**无法承载** → 不能采纳 |
| 身份与鉴权 | 设备持 **NaCl 签名密钥对**；`POST /v1/auth {challenge, publicKey, signature}`，服务端 **upsert Account by publicKey**，签发 `HANDY_MASTER_SECRET` 下的 JWT；**不存密码**（`docs/backend-architecture.md:143-173`、`happy-cli/src/api/auth.ts:20-37`） | 我们服务端只有 host token + PSK，无账号体系；采纳需 mp 支持注册/登录 → **不能采纳** |
| **前向安全** | **没有**。全部文档 grep `forward.?secre|ratchet|rekey|rotat` → **0 命中**；长期密钥直接加密每条消息 | 与本项目同档；**不构成「优于」** |
| 密码敏捷性 | 密文首字节 `version`（当前 0），非 0 直接拒解密（`encryption.ts:decryptWithDataKey`） | mp 侧线格式**没有版本字节位置**（`base64(nonce24‖box)`）→ 不能采纳到线外层；可以放进**解密后的 JSON** 里（加字段是允许的） |

#### B.1.2 中继服务端职责（零知识程度 / 路由）

- **零知识**：metadata、agentState、daemonState、message content、artifacts、KV 全部是**客户端加密后的
  opaque 字符串/blob** 落库，服务端不解释（`docs/backend-architecture.md:341-378`）。
  服务端唯一**自己加解密**的是第三方 token（GitHub OAuth、OpenAI/Anthropic/Gemini），用
  `HANDY_MASTER_SECRET` 派 KeyTree 做**静态加密**，那部分**不是 E2E**。
- 路由：Socket.IO 三档连接作用域 `user-scoped / session-scoped / machine-scoped`，
  房间 `user:<id>`、`user:<id>:session:<sid>`、`user:<id>:machine:<mid>`、RPC 房间 `rpc:<uid>:<method>`
  （`docs/realtime-sync-and-rpc.md:29-40`）。
- **持久 vs 瞬时二分**：可恢复的状态变更是带 `seq` 的 `update` 事件（落库），
  presence/usage 是**不持久**的 `ephemeral` 事件（`docs/protocol.md:52-68`）。
- **单调 seq**：`Account.seq` 是**每用户**单调计数（`allocateUserSeq`），客户端「按 seq 顺序应用即一致」；
  session/artifact 各有自己的 `seq`（`docs/protocol.md:16`、`backend-architecture.md:215-222`）。
- **乐观并发**：所有版本化字段写操作带 `expectedVersion`，冲突返回 `{result:'version-mismatch', version, <当前值>}`
  —— 把当前值一并回给客户端（`docs/protocol.md:127-161`）。
- 事务与投递：`inTx()`（serializable + `P2034` 自动重试）+ **`afterTx()` 才 emit socket 更新**
  （提交后才广播，`backend-architecture.md:308-330`）。
- presence 与写库解耦：`session-alive`/`machine-alive` 在内存 debounce（ActivityCache）→ **批量**落库 →
  10 分钟超时循环标 inactive 并发 ephemeral offline（`backend-architecture.md:224-255`）。
- 多副本：`@socket.io/redis-streams-adapter`，**Redis Stream `MAXLEN ~ 50000` 自动裁剪**；
  `connectionStateRecovery` **被注释掉**（"先与单副本行为对齐"），断线客户端一律走
  `apiSocket.onReconnected` **全量 REST 重取**（`docs/multi-process.md:14-33, 111-123`）。
- 观测：`/health`（含 DB 连通）+ Prometheus `/metrics`（HTTP 计数/直方图、WS 事件计数与连接 gauge）。
- 服务端栈（`packages/happy-server/package.json`）：`fastify` + `@fastify/bearer-auth/cors/static` +
  `fastify-type-provider-zod` + **`zod`** + **`pino` + `pino-pretty`** + `prisma/pglite` + `ioredis` +
  `jsonwebtoken` + `minio` + `prom-client` + `privacy-kit`。**没有**原生加密，全靠 `tweetnacl`。

#### B.1.3 多设备 / 多会话

- 层级：`Account(publicKey) → Machine(=一台电脑，带 daemonState) → Session(=一个 agent 会话)`；
  设备各自有 identity key，撤销 device credential + membership 即关闭活动连接。
- 跨设备共享内容靠 `AccessKey`（按 `sessionId × machineId` 的一把 **box 封装密钥**，服务端只见 opaque 串）
  与 `dataEncryptionKey` —— 即「服务端当密钥邮差，明文只在对端解出」。
- 客户端分三类长连接持有者：`ApiSessionClient`（session-scoped）、`ApiMachineClient`（machine-scoped）、
  app 的 `apiSocket`（user-scoped）；RPC handler **重连后自动重注册**（`realtime-sync-and-rpc.md:22-27`）。
- **RPC 语义**（`multi-process.md:36-83`，工程上最扎实的一段）：
  `fetchRoomSockets`（500 ms 超时，失败当「没人」）→ 找不到目标时 **10 s 等重连宽限**（200 ms 轮询）→
  命中多 socket 时 warn 并取第一个 → `emitWithAck` **30 s 超时**，同时 **race 一个 1 s 周期的 presence poll**，
  目标掉线立刻 `RPC target disconnected`（不等满 30 s）→ `finally` 停掉 poll。

#### B.1.4 事件流与背压

- 会话事件流：统一「扁平事件流」，**9 个事件类型**（`text/service/tool-call-start/tool-call-end/file/turn-start/turn-end/start/stop`），
  信封固定 `{id: cuid2, time, role, turn?, subagent?, ev}`；`turn` 由 `turn-start` 建立、后续全部携带；
  `subagent` 可嵌套；**agent 消息缺 `turn` 直接忽略**（`docs/session-protocol.md:36-69, 227-236`）。
  文件走 **upload-first + `ref` 引用**，图像带 `width/height/thumbhash` 以便即时占位排版。
- **背压：happy 的文档里没有。** `docs/*.md` + `happy-server/sources` grep
  `rate.?limit|slow.?consum|backpressure|bufferedAmount` → 除「Paid Voice 限流」文档标题外 **0 命中**。
  它能间接缓解压力的只有：presence 批量落库、seq + 断线全量重取、Redis stream 的 `MAXLEN` 裁剪。
  → 就「下行拥塞」而言，happy **不如**本仓库该达到的水平；参考点见 §B.2。
- 命名稳定性纪律：`protocol.md:10-22` 明确「小表面 > 完备」「`t`/`sid`/`seq` 短键名且长期稳定」
  「持久 vs 瞬时分离」「向后兼容优先于破坏性变更」「不做满 REST，只有 GET/POST(+少量 DELETE)」
  「新能力优先塞进已有加密载荷，而不是新增路由」。

#### B.1.5 移动端 UI 信息架构

路由树（实测 `happy-app/sources/app/(app)/`）：
`index`（会话列表）·`session/[id]`·`new/`（新建）·`machine/[id]`·`user/[id]`·`artifacts/{index,[id],new,edit/[id]}`·
`inbox/`·`terminal/{index,connect}`·`settings/{account,agents,appearance,language,usage,voice/*,connect/*}`·
`server.tsx`（**切换/自托管服务端**是独立一屏）·`troubleshoot.tsx`（**独立诊断屏**）·
`onboarding/`·`restore/`·`dev/`·`changelog/`。
配合 `docs/chat-list-acceptance.md`（列表验收口径）、`docs/chat-list-scrolling.md`（滚动/虚拟化，
含 FlashList 在 web 反转的补丁）、`docs/permission-resolution.md`（权限模式状态机 app↔CLI 对齐）。

#### B.1.6 判定：哪些优于本仓库现有设计 / 哪些因小程序冻结不能采纳

**A 组 —— 优于现有设计，且**不触碰** mp 契约，重写应采纳（纯服务端/主机侧行为）**：**

| # | happy 做法 | 优于本仓库现状之处 | 采纳形态 |
|---|---|---|---|
| A1 | **共享 wire schema 包**（`happy-wire`：只放 types + zod schema + 小 helper，禁止业务逻辑，独立发布版本） | 旧版是 `packages/protocol/src/index.ts` 一个文件 254 行同时装帧与 payload（`git show b026d63:packages/protocol/src/index.ts \| wc -l` → 254），且手写 mjs 服务端与 TS 端存在**双写**风险（`apps/server/src/main.mjs` 完全不用 TS） | 重写把「wire 契约」拆成唯一事实源，服务端只做转发与限流；**这也是 §C 里 zod 能一票通过的核心理由**。⚠ 实测注：本仓工作树在本文撰写期间已被并行重写推进，`packages/protocol/src/` 现为 `bytes/ids/keys/pairing/record/schema`（549 行）——**这条判断已被采纳**，本行保留作为采纳依据的记录 |
| A2 | **持久 `update(seq)` vs 瞬时 `ephemeral` 二分** | 现在 `peer-joined/peer-left/session-list` 与 `enc/enc-batch` 混在同一平面上，presence 变更也参与持久语义 | 中继侧：不持久化任何 presence，掉线用 ephemeral 通知 + 10 分钟级 inactive |
| A3 | **每会话单调 seq + 断线全量重取**（明确不开 `connectionStateRecovery`，先与简单行为对齐） | mp 侧 `seq: ++this.seq` 已有发送计数，但**没有**「重连后主机重投/客户端重取」的规范语义 | 主机插件重连后主动重推会话列表 + 触发一次 delta 重建；中继保持无状态转发（**这与 mp 的 `_resume` 语义兼容**，mp `client.js:80,181,282` 已保存 `{psk,convId,nonceCounter}`） |
| A4 | **`expectedVersion` 乐观并发 + 冲突回传当前值** | 本仓库元数据类更新（会话标题/状态）无版本位，后写覆盖前写 | 只加在**新帧**上（加字段允许）；mp 不读该字段也不受影响 |
| A5 | **RPC 的「10 s 等重连宽限 + 1 s presence poll 提前失败」**（`multi-process.md:36-83`） | 本仓库配对/挂时曾有「多配对码用错 PSK」类故障（git log `6e33017`），缺的是**目标不存在时的确定性失败路径** | 主机侧命令路由与配对 claim 采用同一条：找不到目标 → 宽限轮询 → 明确错误码，绝不静默排队 |
| A6 | **`afterTx`：提交后才广播** | 本仓库中继无事务，但**插件**里「状态变更→上行通知」的时序没有规范点，易出现「先广播后落盘，客户端读到幽灵」 | 主机适配器统一在状态落地后再 emit |
| A7 | **presence 内存 debounce + 批量写 + 超时循环** | 本仓库 `session-list`/running 状态每帧上行，写放大未量化 | 主机侧对 `session-alive` 类心跳做去抖（**不改帧格式，只改频率**） |
| A8 | **`/health` + Prometheus `/metrics` 双端口分离** | 本仓库已有 `/healthz`（线上实测 `hosts:1 pendingPairs:2`），但无指标 | 至少在 `/healthz` 里补「活跃连接/丢弃帧数/慢消费者次数」，为 §B.2 的背压决策留数据；不引入 `prom-client`（多 1 依赖 + 1 端口，违红线） |
| A9 | **UI：诊断/`troubleshoot` 与「切换服务端」各占独立屏** | mp 侧 `pair.js` 已有诊断入口（`mp/pages/pair/pair.js:151-163`）**且不可改** | 结论：这条**不能**在 mp 上加屏；但可以照搬到**主机侧 CLI/`status.json`**，把「为什么连不上」变成主机侧一等公民 |
| A10 | **协议文档纪律**（`protocol.md:10-22, 22-28`：短键名稳定、持久 vs 瞬时、加能力优先塞进已有加密载荷） | 与本仓库重写目标直接对口 | 写进新 `docs/`，作为「新增字段的合法性判据」 |

**B 组 —— 更好但**因小程序不能改而放弃**：**

| # | happy 做法 | 为什么不能采纳 |
|---|---|---|
| B1 | `dataKey` 变体：AES-256-GCM + `version(1)‖nonce(12)‖ct‖tag(16)` | mp `codec.js:84-115` 的 `seal/open` 只认 `base64(nonce24‖secretbox)`，无版本位、无 GCM |
| B2 | 每对象 DEK + `nacl.box` 临时密钥封装 + 服务端当「密钥邮差」（`dataEncryptionKey`/`AccessKey`） | mp 的 `derivePskKey(psk, dir, convId)` 输入与算法冻结；引入 DEK 需要 mp 改密钥存储与派生 |
| B3 | HMAC-SHA512 KeyTree（usage + path 域名分离） | 同上：会话密钥派生必须是 `SHA-512('dsh-rc/v1'␟dir␟convId␟psk)[0..32]`。⚠ 注：我们自己的 `noncePrefix` 已是独立命名空间（`codec.js:23,123-125`），域名分离这一条**部分已具备** |
| B4 | 账号体系（签名公钥即身份 + challenge 换 JWT） | mp 无注册/登录 UI 与存储（`session-store.js` 只存 psk/convId/installId），改不了 |
| B5 | Socket.IO 传输（自带 ack/重连/房间/polling 回退） | mp 用 `wx.connectSocket` + 裸 JSON 帧（`socket.js` 267 行），Socket.IO 协议不可用 |
| B6 | 9 事件扁平会话协议 + `file`/`ref` upload-first + thumbhash | mp 页面按**现有** payload 名渲染（`client.js:209-248` 的 `case` 白名单）；新增 payload 类型 mp 不会显示 → 只能加**字段**，不能加**它不认识的事件类型** |
| B7 | Push 通知 / WebRTC 语音 / 社交 feed / S3 附件 | 微信小程序订阅消息 + 无原生 SDK；且都会新增常驻组件（红线） |
| B8 | Prisma + Postgres + Redis + MinIO 服务端栈 | 中继必须是**零持久、单进程、零外部服务**（现在线上就是一个 node 进程 + nginx） |
| B9 | `pino` + `fastify-type-provider-zod` | 见 §A.5.2 实测（+4 线程、13 包闭包）与 §C 判定 |

---

### B.2 `~/Downloads/ds-harness-remote-main.zip`

**存在性**：实测 `/Users/linbin/Downloads/ds-harness-remote-main.zip` = **7,056,085 字节**，
`mtime 1790787225`（前台复制/解压两次超时，后台执行 exit 0）。
解压到 `/tmp/drc-survey/dshr/ds-harness-remote-main/`（12 MB，2623 条目级别的项目树）。

**它是什么**：`liguobao/ds-harness-remote` v**0.4.27**（已发布到 npm，有 dshfind 插件页徽章、
`https://dsh.r2049.cn/app` 在线实例、Android releases）。与本项目**同题**：DSH 内核插件（Host）+
中继 Server + 多端 Client（`apps/{browser,android,vscode}`）+ WebRTC 直连。文档中英双语，
协议文档自认「规范性唯一来源」，并带 `fixtures/` conformance 数据。工作区：
`packages/{protocol,crypto,client-core,plugin,webrtc}` + `apps/{server,browser,android,vscode}`。

**它的加密方案（与本项目根本分歧，仅记录不复用）**：固定
`Noise_IK_25519_ChaChaPoly_SHA256`，用**在维护的 Noise 实现** `@lukeburns/clatterjs` + `@noble/*`；
prologue 绑定 `DSH-REMOTE`+版本+`connectionId`+两端 `deviceId`；**服务端 membership 与本地
identity pinning 双层授权**（已知 deviceId 换公钥 → 拒绝而非静默接受）；每连接传输密钥、断连即销毁；
明确写出「**长期连接 rekey 与独立密码安全审查仍在路线图**」→ **它也不宣称前向安全**。
→ 这条路 mp 走不了（mp 是 PSK-in-QR + secretbox），**不采纳**，只采纳它的**纪律**：
`fixtures/crypto/v1/noise-ik.json` 这种「**跨实现 golden vector 文件**」的做法值得照搬到我们的
`seal/open` 上（见 C-采纳清单第 1 条）。

**明确优于本仓库现状、且可采纳的设计（数字都是它文档里的规范值，实测摘录）**：

| # | dshr 设计 | 本仓库现状（实测） | 采纳判定 |
|---|---|---|---|
| 1 | **发送侧背压**：加密发送串行化，队列 **8 MiB / 256 消息**；中继等待 WebSocket `bufferedAmount` 回落到 **512 KiB**，最多等 **10 s**，超时**关闭通道**；client stream 队列 **4 MiB / 256 帧**，超限终止流并要求恢复（`docs/protocol.md:979-980`）；慢消费者触发 `SLOW_CONSUMER` 断开（`docs/server.md:244`） | 中继有帧大小/连接数/每秒帧数预算（`main.mjs:44-50, 168-203`），**但 `bufferedAmount` 全仓库 0 处引用**（`grep -rn bufferedAmount apps/server/src packages/plugin/src e2e` → 空）→ **下行拥塞时静默堆积在 OS/WS 缓冲区** | **采纳**（纯服务端/主机侧行为，不碰线格式，也不新增进程） |
| 2 | **限额作为协议常量公开**：WS 单消息 ≤ **256 KiB**、待消费队列 ≤ 1 MiB/256 消息、60 s 无 RPC 活动回收 handle（`protocol.md:1004`）、Noise 单条 transport ≤ 65535 B、>48 KiB 走**认证通道内有序分片**、重组上限 4 MiB、同连接并发重组 ≤ 8 | 有 `DRC_MAX_MSG_BYTES=256KiB` 环境变量（默认值恰好相同），无分片/重组语义（靠 `enc-batch`） | **采纳为文档化常量表**（数值可由我们自己定，但「公开成规范 + 有错误码」这件事要照做） |
| 3 | **零知识但元数据诚实**：一张「Server 能看到 / 不能看到」表（`end-to-end-encryption.md:94-104`），明确「E2EE 不隐藏谁在何时通信、时长、近似流量」 | `docs/SECURITY.md` 有零知识叙述，元数据泄露面不如它直白 | **采纳**（写进新 SECURITY） |
| 4 | **入站解析 fail closed**：拒绝无效 UTF-8/JSON、拒绝 `NaN/Infinity/-0/稀疏数组`、**未识别的必需 enum 值直接拒绝**、不把原始 parser 错误抛给用户（`protocol.md:75-88`） | mp 侧 `codec.open` 任何失败返回 `null`（不抛）—— 端上已具备；服务端/插件侧的 `JSON.parse` 纪律未成文 | **采纳** |
| 5 | **conformance fixtures + 跨实现 golden vector**（`fixtures/`、`noise-ik.json`、`examples/mock-host`） | 有 `e2e/live-e2e.mjs` 真实链路（很强），但**没有**「冻结线格式的 golden vector 文件」 | **采纳**：重写后把 §A.1 的固定向量落成一个 JSON，任何新实现（含未来的 web/desktop 端）必须过它 |
| 6 | **capability + 版本协商**、升级文档单列（`docs/upgrade-0.1.7.md`、`docs/compatibility.md`） | `hello.protocol` 字段在，协商语义未成文 | **采纳**（帧名与 mp 已冻结，协商只能**加**不能改） |
| 7 | **协议文档的「文档地位」条款**：「任何与本文不一致的示例代码都视为未完成实现，**不得反向修改协议语义**」（`protocol.md:14-16`） | 本仓库文档与代码的权威关系没有明文 | **采纳**（重写最容易翻车的正是这条） |

**不采纳**（记录取舍）：Noise IK / X25519 设备身份与 pinning（mp 冻结在 PSK）、WebRTC + TURN
（`werift`，新增常驻组件且小程序无 WebRTC）、多账号 + 设备注册体系、`@deepseek-ai/schemastery`
（DSH 官方 schema 库，用于插件配置 —— **仅记录：宿主自带，配置校验可考虑不引第三方**）、
`zod`+`ws`+`qrcode`+`werift` 的既有依赖选择（**恰好印证本项目的 `qrcode` 选型不是孤例**：
`packages/plugin` 运行时依赖就是 `@deepseek-ai/schemastery, qrcode, werift, zod, ws`）。

---

## C 逐项依赖选型表

| 事项 | 库 / 工具（版本） | 用不用 | 用途 | 为什么用它而不是自研 | 风险 |
|---|---|---|---|---|---|
| 会话密钥 + seal/open | **`tweetnacl@1.0.3`**（+ `tweetnacl-util@0.15.1` 仅编码） | **用** | 与 mp 逐字节一致的 SHA-512 KDF 与 secretbox | §A.1 实测 20+63+50+50 组全一致；`node:crypto` **没有** XSalsa20-Poly1305（§A.5.4 实测空列表），只能纯 JS | 2020 停更（latest 1.0.3 / modified 2023-04-12）；逃生阀 `@noble/ciphers@2.4.0`+`@noble/hashes@2.4.0` 已实测 **60 组密文逐字节等价** |
| base64 / UTF-8 | **Node 内置 `Buffer`** | **用内置**（不装库） | 入站/出站编解码 | §A.2：与 mp `js-base64` 语义最接近（133 组编码 0 差异、2000+2000 组往返 0 失败、宽松度 12/14 相同） | 必须自己补「入站合法性检查」（§A.2 结论 3）；`base64-js@1.5.1`、`@stablelib/base64@2.0.1`、`tweetnacl-util.decodeBase64` **不用** —— 实测对无填充/空白/非法字符**抛错**，比 mp 严格，会造出「手机能扫、主机报错」的假故障 |
| WebSocket 服务端 | **`ws@8.22.0`** | **用** | 中继与插件的客户端/服务端 | 0 运行时依赖（实测闭包 1 包、151 KB unpacked）；栈已定 | `bufferutil`/`utf-8-validate` 是 devDependencies，未装时性能略降但可用（实测 `npm view ws dependencies` 为空） |
| WebSocket 服务端（替代） | `uWebSockets.js` | **不用** | — | 实测 **`npm view uWebSockets.js` → 404**：npm 上根本不存在，只能从 GitHub tarball 装 + 原生编译 → 装进外部 profile 时最脆；npm 上的 `uws@200.0.0` 是**另一个包**（易误装） | — |
| WebSocket over HTTP 框架 | `@fastify/websocket@11.3.1` | **不用** | — | 实测依赖 `ws + duplexify + fastify-plugin`，还要 `fastify@5` 本体；中继只要一个 WS upgrade + 一个 `/healthz`，用 `node:http` 就够 | 引入 1 个 HTTP 框架 = 违「减少常驻组件与依赖数量」 |
| 帧 schema 校验 | **`zod@4.6.5`** | **用** | 控制面帧 + 解密后 payload 的**单一契约**（wire 包唯一事实源，happy-wire 模式） | §A.5.1 实测 **2.2M ops/s**，是中继 500 帧/秒上限的 ~4400 倍 → 性能无需顾虑；**闭包仅 1 个包、0 运行时依赖**（实测）；同仓 dshr、happy-server 都用 zod，跨端类型可由 schema 推导 | 磁盘 8.0 MB（多入口产物，实际加载远小于此）；zod v3→v4 API 有破坏性变更，锁 `^4.6` 并在 CI 里跑一次契约测试 |
| 帧 schema 校验（替代） | `valibot@1.5.0` | **不用** | — | 实测 1.3M ops/s（比 zod 慢 1.7×），生态与文档成熟度不及 zod，且**没有**换来体积优势 | — |
| 帧 schema 校验（替代） | 手写 type guard | **不用**（除一处） | 仅热路径 `enc/enc-batch` 的「长度 + 字符合法性」预检（§A.2 结论 3）可手写 | 手写 2.9M ops/s 只比 zod 快 1.3 倍，却要维护两份契约、丢类型推导 —— **不划算** | 唯一例外：`base64` 字符合法性 Buffer 无原生校验，写 ~10 行 |
| 结构化日志 | **自写 ~20 行 NDJSON → stdout** | **不用 pino** | 中继与插件日志 | 实测 pino **51 ms/50k vs 自写同步落盘 114 ms/50k，且 pino 默认多开线程：11 vs 7**（`ps -M` 实测），闭包 **13 个包**；systemd 已做收集/轮转（`deploy/systemd/…service` 里 `StandardOutput=journal`） | 没有 transport 生态（文件轮转/HTTP sink 都得自己加）→ **这正是我们要的**：不加常驻组件。真实 tty 下 `console.log` 的性能**未实测**（§A.5.2 那条把 `console.log` 换成 no-op，只量了 stringify） |
| 限流 | **手写令牌桶（~40 行）** | **不用库** | 每秒帧预算、auth/pair 尝试预算（旧实现已有等价语义：`makeBudget`，`main.mjs:95-100, 189-203`） | `rate-limiter-flexible@11.2.1` 虽 0 依赖 / 230 KB，但为**分布式 + 多存储后端**设计；我们是单进程中继，内存计数即正确 | 若将来多副本中继（本文不建议）再引入 |
| 限流（不适用） | `express-rate-limit@8.7.0` | **不用** | — | 绑 Express；我们无 Express | — |
| 进程守护 | **systemd**（`deploy/systemd/dsh-remote-control.service`，**保留**） | **用系统工具** | `Restart=always`、`RestartSec=3`、`TimeoutStopSec=15`、`MemoryMax=512M`、`ProtectSystem=strict` 等 | 已是线上事实（实测 `https://drc.provid.cc/healthz` → `{"ok":true,"uptimeSec":41411,"hosts":1,"pendingPairs":2}`） | macOS 开发机没有 systemd（本机实测中继不在 8787 监听）→ 开发期用前台 node + `caffeinate -i` 包裹 |
| 防休眠 | **`/usr/bin/caffeinate`（macOS）/ `systemd-inhibit`（Linux）** | **用系统工具**，不装 npm 库 | 会话运行/待审批期间抑制 idle+system sleep，空闲 300 s 自动释放 | 本机实测 `caffeinate` 在 `/usr/bin/caffeinate`；`systemd-inhibit` **本机不存在**（macOS，符合预期）。第三方 npm 睡眠抑制库本质也是 spawn 这俩 | 子进程生命周期要绑 `-w <pid>`，否则插件退出后断言泄漏（旧实现已如此设计，代码重写、思路沿用） |
| 二维码（PNG/矩阵） | **`qrcode@1.5.4`（node-qrcode）** | **用** | 主机端配对二维码：PNG 落盘 + 原始矩阵 | §A.3 实测：98/188 B 真实 URI 全解出、4 档纠错全解出、12 组尺寸全解出、CJK 载荷 round-trip 正确、**纯 JS 无原生**、运行时不 require yargs；同仓 dshr 的插件也用 `qrcode` | 传递闭包 **29 包 / 2.4 MB**（yargs 占 27）→ 若体积敏感可用 **`qrcode-generator@2.0.4`（0 依赖）**，但那正是旧 vendored 的 npm 上游（含 UTF-8 截断默认坑）；**不用** `qrcode-terminal@0.12.0`（0 依赖、96 KB，但渲染样式固定，拿不到矩阵，做不到旧 `ascii` 兜底样式） |
| 二维码解码器（**仅 devDependency**） | **`zxing-wasm@3.1.4`** | **用（不进运行时）** | 重写后的 QR 回归：生成→解码→断言逐字节一致 | §A.3 用它 + 原生 zxing-cpp Python 绑定**双重**验证；npm 上有 `miniprogram` 入口说明跨运行时 | 依赖 wasm 加载；CI 里需 Node ≥20。也可继续用仓库现有 venv `zxingcpp`（本机实测 `import zxingcpp` 可用） |
| 测试框架 | **`node:test` + `node --test`（内置）** | **用内置** | 单测/e2e 分层照旧 | 已是仓库现行做法（83 项单测口径见 `docs/legacy-spec/testing-and-tooling.md`）；零依赖 | 不用 vitest/jest（新增 dev 依赖与配置，收益对本项目有限） |
| 密码学替代 | `@noble/ciphers@2.4.0` / `@noble/hashes@2.4.0` | **暂时不用**（记录为逃生阀） | — | 实测 60 组逐字节等价（§A.5.4） | 引入即「两套实现同仓」风险 → 只允许**替换**，不允许共存 |
| 其他明确排除 | `libsodium-wrappers@0.8.4`、`nacl@0.1.3`、`werift`（WebRTC）、`prisma`/`postgres`/`redis`/`minio`、`prom-client`、`privacy-kit`、`jsonwebtoken` | **不用** | — | 与「零持久单进程中继 + 架构必须精简」直接冲突；WebRTC 小程序侧不可用 | — |

---

## D 必须自研的部分及原因

| 部分 | 为什么不能靠库 |
|---|---|
| **线格式 `seal/open` + KDF + 计数器 nonce**（`base64(nonce24‖secretbox)`、`SHA-512('dsh-rc/v1'␟dir␟convId␟psk)[0..32]`、`noncePrefix(16)+be64(counter)`） | mp 侧**已冻结**，任何库都不会给出这个精确形态；tweetnacl 只给原语。**必须自己写 ~80 行**，并用 §A.1 的向量 + golden vector 文件钉死 |
| **配对 URI 的构造/解析**（含「`+` 先当空格解，若解出的 psk 含空格则重试」这条兼容规则，`codec.js:161-174`） | 是本项目私有文法 + 一条经验性容错，没有标准库；且必须与 mp 的解析**行为逐条一致**（旧 `e2e/mp-crypto.test.mjs` 就是测它） |
| **中继路由状态机**（host 注册/token 鉴权、pendingPair 一次性 claim、conversation 双向 opaque 转发、`peer-joined/left`、优雅停机 drain） | 语义是「PSK 零知识 + 不落库 + 单进程」；happy 的 Socket.IO/Prisma 栈、dshr 的账号+membership 栈都对不上，硬套等于把架构复杂度买回来 |
| **下行背压与慢消费者处置**（§B.2 第 1 条：队列上限、`bufferedAmount` 回落阈值 + 超时 + 断开） | 库不会替我们决定阈值；`ws` 只给 `bufferedAmount` 原语。**~40 行**，但必须先定规范值 |
| **Harness 会话事件 → mp payload 适配器**（delta 窗口化、工具瀑布、审批/提问回传、归档/detached 状态、黑名单） | 完全绑定 DSH 内核私有事件形态；cordis 插件宿主里没有任何现成库覆盖 |
| **终端 QR 渲染（ascii/block/half 三档）** | node-qrcode 给矩阵与 PNG，但旧实现证明了「宿主 TUI 会吞空格/缺字形」→ 呈现层 15 行必须自己写（编码器**不再**自己写：`qr.ts:5-9` 明确记载手写编码器已被实测否决） |
| **NDJSON 日志（级别 + 采样 + 脱敏）** | 见 §C 的 pino 实测；~20 行，且换来 0 新依赖、0 新线程 |
| **令牌桶限流** | ~40 行；库（rate-limiter-flexible）为分布式设计，单进程用不上 |
| **mp 行为对拍 harness**（把 `mp/core/*.js` 当黑盒 `require` 进 Node，用真实 wx shim 跑） | mp **不能改一行**，也拿不到微信运行时；这是唯一能证明「没把契约写歪」的手段，属于本项目独有资产 |

---

## E 精简性检查

**E.1 常驻进程 / 线程（重写后）**

| 组件 | 进程 | 说明 |
|---|---|---|
| 中继 | **1 个 node 进程**（systemd `Restart=always`） | 不变；零持久化、无 DB/Redis/子进程 |
| host 插件 | **0 个额外进程** | 跑在 DSH 内核进程内（cordis bundle） |
| 防休眠 | **0 常驻**：仅在会话 active 期间 `caffeinate -i -s -w <pid>`（macOS，实测存在）/ `systemd-inhibit`（Linux），空闲 300 s 后自动退出 | 由系统工具承担，不自研 daemon |
| TLS | 0（nginx 终结，`deploy/nginx/drc.conf` **保留**） | 不变 |
| 日志 | 0（stdout → journald） | **不引 pino**，因此**不新增线程**（实测 pino 默认 11 线程 vs 裸 node 7） |
| 合计 | **1 个常驻 node 进程 + 1 个 nginx（既有）** | **相对旧实现：常驻组件 0 增加** |

线上运行态对照（实测，非文档转述）：`GET https://drc.provid.cc/healthz` →
`{"ok":true,"version":"0.1.0","uptimeSec":41411,"hosts":1,"clients":0,"conversations":0,"pendingPairs":2,"shuttingDown":false}`。
本机 `lsof -iTCP:8787 -sTCP:LISTEN` 为空（中继在远端跑，本地无残留进程）。

**E.2 新增运行时依赖清单（相对旧实现的净增）**

| 包 | 版本 | 运行时闭包包数 | 磁盘（实测） | 是否净增 |
|---|---|---|---|---|
| `ws` | 8.22.0 | **1**（0 依赖） | 196 KB | 否（旧版已用） |
| `tweetnacl` | 1.0.3 | **1**（0 依赖） | — | 否 |
| `tweetnacl-util` | 0.15.1 | **1**（0 依赖） | — | 否（也可去掉：`encodeBase64` 与 `Buffer.toString('base64')` 实测 133/133 一致，用它反而多一层约定 —— **建议删除**） |
| **`qrcode`** | 1.5.4 | **29**（`dijkstrajs`+`pngjs`+`yargs` 及其 26 个传递包） | 2.4 MB（114 个 .js，**0 原生**） | **是（唯一净增）** |
| **`zod`** | 4.6.5 | **1**（0 依赖） | 8.0 MB 磁盘 / 实际加载极小 | **是（建议加）** |
| `pino` | 10.3.1 | 13 | 1.2 MB | **否（明确不加）** |
| dev-only：`zxing-wasm` 3.1.4（QR 解码回归）、`@noble/ciphers`/`@noble/hashes` 2.4.0（可选逃生阀验证） | — | 0（不进运行时） | — | 否 |

**一起安装的全集实测**：`npm install --omit=dev zod pino qrcode tweetnacl tweetnacl-util ws` →
`added 47 packages in 6s`、46 个 `node_modules` 条目、**13 MB**、**0 个 `.node`**。
把 `pino` 换成自写 NDJSON 后，运行时闭包 ≈ **32 个包**（`ws 1 + tweetnacl 1 + zod 1 + qrcode 29 − 1 自身重叠`），
且**无原生编译**——这正是 `scripts/install-to-profile.sh` 走 `pnpm add -w file:$PLUGIN`
（`file:` 依赖被 pnpm 以硬链接/复制方式装入 profile）时**必须成立**的前提。

**E.3 精简性红线自检（逐条）**

1. **常驻组件不增加**：中继仍 1 进程；插件仍在 DSH 进程内；防休眠用系统工具且非常驻。✔
2. **新增运行时依赖 = 2 个直接依赖**（`qrcode`、`zod`），`tweetnacl-util` 建议**净减 1**。✔
3. **无 DB / 无 Redis / 无队列 / 无 HTTP 框架 / 无 WebRTC / 无监控后端**。✔
4. **pino 被拒**的唯一理由就是实测到的「+4 线程 / 13 包」；这条判定是**数据驱动**的，不是口味。✔
5. **唯一遗留风险**：`qrcode` 的 yargs 传递树（27 包）。缓解路径已实测存在：需要更瘦时换
   `qrcode-generator@2.0.4`（0 依赖），但必须自带 UTF-8 `stringToBytes` 与功能级解码回归
   （§A.3 已备好脚本）。**默认仍用 `qrcode`**，因为它对非 ASCII 载荷默认正确、且是同题成熟项目（dshr 插件）的同一选择。

**E.4 未实测项（重写后必须补的 4 次真跑）**

1. 真机（iOS + Android + 微信 `wx.scanCode`）对 node-qrcode 输出的实拍扫描（§A.3）。
2. 把带 `qrcode`/`zod` 依赖的插件**真的**装进 `~/.dsh/profiles/desktop` 并被线上 Harness 加载（§A.3）。
3. 真实 tty 下 `console.log` 与自写 `fs.writeSync` 的吞吐对比（§A.5.2，本文那条测量把 `console.log` 换成了 no-op，**不可用于结论**）。
4. `bufferedAmount` 背压阈值（512 KiB / 10 s 是否适合本项目 256 KiB 帧上限）在**真实大输出会话**下的表现
    —— §B.2 的数字来自 dshr 规范，属**参考值**，不是我们的实测值。
