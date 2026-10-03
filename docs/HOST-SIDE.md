# 本机宿主侧（跑 DSH 的那台机器）

**这份只管 host 这一侧**：产物形态、怎么装进 profile、配置键、排错入口、真机取证的配方。

中继侧的部署（环境变量、nginx/wss、systemd/launchd/Docker、优雅停机、容量基线、
**成对回滚的兼容矩阵**、升级与回滚步骤）一律看权威手册
**[`dsh-remote-server/docs/SELF-HOSTING.md`](../dsh-remote-server/docs/SELF-HOSTING.md)**。
以前伞仓这里有一份 845 行的副本，和开源那份已经分叉（它还在讲 `apps/server`、`@dsh-rc/*`、
`version 2.0.0`），2026-10-03 删掉，只留下面这些**在这台机器上实测出来的**内容。

---

## 1. 产物形态：一个 bundle，两半

`dsh-remote-control@1.1.0` 起，右栏自动弹码那一半（原来是独立包 `dsh-remote-control-presentation`）
折进了主插件；`[未发布]` 又加上状态栏那颗"点一下配对"的 pill。一次构建产出两半，
实测尺寸 `index.js 1242 KB / client.cjs 18 KB`：

| 产物 | 跑在哪 | 干什么 |
|---|---|---|
| `dist/bundle/index.js` | DSH 的 Node 侧（cordis fiber） | 配对、中继连接、会话与命令、审批转发、防休眠，**外加**界面上的那一半：按节拍看当前配对码、渲染 PNG、挂 4 条同域路由（右栏只读那条 + pill 的发码/图片/状态那三条） |
| `dist/bundle/client.cjs` | DSH 的浏览器面（`window.__ModuleLoader__`） | ① 每 2s 轮右栏那条路由，`state:"ready"` 且 `epoch` 变了就 `ctx.sidebarRight.openResource(address)` 把图推进右栏；② 向装载器拿 `react`、往 `conversation.composer.dock` 注册那颗 pill：抬头显示连接状态，点击 `POST /pairing/new` 并把 `/pairing.png` 弹在同一颗按钮上方 |

宿主注入的东西（`cordis`、`@deepseek-ai/*`）刻意**留在 externals**——打进去会造成两份实例。
协议层 `dsh-remote-wire` 是 npm 依赖，esbuild 打包时内联，所以 profile 里不需要 `node_modules`。
`react` **不进 externals 也不内联**：浏览器面是在运行期向装载器要它（模块名走变量，见
`packages/plugin/client/src/pill.ts` 文件头），拿不到只是少一颗 pill，而不是整页 web boot 失败。

**隔离现在由代码提供**：这一半需要 `webServer` 服务，而主插件刻意不写任何 `inject:` 闸门。
`src/presentation/sidebar.ts` 只软探测 `webServer`，拿不到就整半不起（不挂路由、不起节拍、不写盘），
`status.json` 的 `sidebar` 块会写明为什么。这条隔离有测试钉住：
`packages/plugin/tests/presentation-isolation.test.ts` 把"有 webServer / 没有 / `register()` 抛错"
三种形态各跑一遍 `apply()`，要求主链路可观察字段**逐个相等**、`/drc unpair` 的返回**逐字节相等**
（`/drc pair` 不在这条名单上：它的返回**有意**随那颗 pill 能不能点而变，那条单独钉在"兵分"用例里）。

## 2. 装进 profile

```sh
./dsh-remote-control/scripts/install-to-profile.sh                        # 目标 ~/.dsh/profiles/desktop
DSH_PROFILE=~/.dsh/profiles/tui ./dsh-remote-control/scripts/install-to-profile.sh
```

它会做这些事（每条都是踩过坑之后定下来的）：

1. **只构建产物**（`node scripts/bundle-plugin.mjs`），刻意不跑 tsc——类型检查是 CI 的事，
   不该挡住"把当前代码装进宿主验一把"。协议层随依赖内联，不单独构建。
2. **目标必须是真目录**：`$PROFILE/node_modules/dsh-remote-control` 若是软链就直接报错退出。
3. **整目录先删后建**再拷 `index.js` / `client.cjs` / `cordis.patch.yml` 并生成带
   `dsh.bundle.patch` 与 `dsh.client` 的 `package.json`——漏了 `dsh.bundle.patch`，
   文件都在、`bundles` 列表里也有名字，但插件根本不会被加载（踩过）。
4. **改写 profile 自己的 `package.json`**（每次先留 `package.json.bak-drc-<unix秒>`，因为里面带着
   `hostToken`）：把 `dsh-remote-control` 幂等地放进 `dsh.profile.bundles`，
   **删掉残留的 `"dsh-remote-control": "file:…"` 依赖**，并把退役的
   `dsh-remote-control-presentation` 从列表与 `node_modules` 一起摘掉。
5. 打印下一步提示（必须重启 Harness）。

**为什么那条 `file:` 依赖必须删**（本机排查里最贵的一课）：只要它还在，`pnpm install` 就会把整个
工作区包**再物化一份**进 profile，于是宿主里同时跑两个插件实例——两个 `hostId`、中继里两份会话、
手机连到哪个全凭运气，而 `status.json` 的计数来自另一个实例，表现就是"改了代码没生效"且
"数字怎么都对不上"。

## 3. 改完代码必须重启

HMR 只热更 `cordis.patch.yml` 里的配置，**不会重新 `import` dist**；浏览器面同理，要重新加载页面才会重拉 `client.cjs`。

```sh
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 8; open -a "DeepSeek Harness"
```

## 4. 配置（profile 的 `cordis.patch.yml` 里那条 `dsh-remote-control`）

优先级：**环境变量 > patch 注入的 config > 默认值**。键名一律沿用旧名——这些键写在用户机器的
patch 里，改名等于让线上配置静默失效。

| 键 | 默认 | 环境变量覆盖 | 说明 |
|---|---|---|---|
| `enabled` | `true` | — | 关掉就什么都不做 |
| `serverUrl` | `ws://127.0.0.1:8787` | `DRC_SERVER_URL` | 公网填 `wss://…`；非 `ws(s)://` 开头 = **error 级**、不启动 runtime；非回环走明文 `ws://` 会 warn |
| `hostToken` | `''` | 由 `hostTokenEnv` 指定名 | 空 = error 级；短于 24 字符 = warn。本机做法是**直接写进 profile 的 patch**——GUI 方式启动的宿主拿不到你的 shell env |
| `hostTokenEnv` | `DRC_HOST_TOKEN` | — | token 取值来源的**变量名**；**同名 env 存在时会覆盖 patch 里的 `hostToken`** |
| `hostId` | `''` | `DRC_HOST_ID` | 见下面那条实测 |
| `hostLabel` | `dsh-host` | `DRC_HOST_LABEL` | 日志与 `hello` 里的显示名 |
| `pairTtlMs` | `120000` | — | 只是**向中继申请**的值；服务端 `pair-ready.ttlMs` 才是准的 |
| `pairOnStartSec` | `0`（关） | `DRC_PAIR_ON_START_SEC` | >0 时启动即发一张码并把 QR 写进 `status.json`。**开了就把"仍然有效的配对码 + PSK"放进 0600 文件**，配置校验专门 warn；`Infinity`/负数/非有限值一律折回 0 |
| `qrImage` / `qrOpen` / `qrAnsi` / `qrStyle` | `true` / `false` / `false` / `half` | `DRC_QR_IMAGE` / `DRC_QR_OPEN` / `DRC_QR_ANSI` / `DRC_QR_STYLE` | 图片是**主路径**：DSH 命令卡按 `line-height:1.6` 渲染等宽输出，行间留白把半块文本码横切成条，实测 zxing 在 ≥1.15 行距就解不出来。写图 ≠ 替你打开查看器（`qrOpen` 默认关）；`qrStyle` 只在关掉 `qrImage` 时当退路 |
| `sidebarQr.enabled` / `.imageFile` / `.refreshMs` | `true` / `~/.dsh/sidebar-qr.png` / `2000` | `DRC_SIDEBAR_QR=0/1` | 界面上那一半（右栏自动弹码 **+ 状态栏那颗 pill**，两条都由这一开关管）。`imageFile` 只是**兜底**位：正常情况下图落在当前会话工作区 `<workspace>/.dsh/sidebar-qr.png`。这两键**只 warn 不 error**（error 会让主插件整个不启动，等于把可选功能变成配对链路的单点） |
| `keepAwake.enabled` / `.idleReleaseSec` / `.keepDisplay` | `true` / `300` / `false` | — | 只在"会话运行中 / 有审批或提问挂起"时持锁 |
| `unarchiveOnPrompt` | `true` | — | 对归档会话下发指令时自动恢复 |
| `takeOverQuestions` | `false` | `DRC_TAKE_OVER_QUESTIONS=1` | 会剥夺桌面 UI 的提问能力（`ctx.userQuestions` 只允许一个活跃 provider），所以默认关 |
| `approvalTimeoutSec` | `180` | — | 审批卡超时 |
| `listingRefreshSec` | `15` | — | 会话列表刷新周期 |
| `carrierGraceMs` | `5000` | — | 强 carrier 未到多久后落弱 carrier |
| `conversationIdleTtlSec` | `86400` | — | 配对通道空闲剪枝（0/非法值**不表示永不剪枝**，会夹回默认） |
| `statusFile` | `~/.dsh/dsh-remote-control/status.json` | — | 置空关闭状态快照（GUI 宿主里 stdout 没人看，这是唯一排错入口） |
| `mockBridge` | `false` | `DRC_MOCK_BRIDGE=1` | 强制内存替身内核，**别用在真机上** |

**`hostId` 那条是实测行为，不是抄文档**：留空时插件每次加载随机生成 `h_<6 hex>`
（`packages/plugin/src/index.ts` 里 `config.hostId || 'h_' + randomBytes(3)`）。同一进程内稳定，
所以 socket 抖动重连能挂回原会话；但**跨重启/跨加载就换身份**。本机 2026-10-03 的实测：
5 分钟内在中继日志里出现三个 hostId（`h_c2073b` 10:05:04 → `h_051405` 10:05:29 →
`h_0919dc` 10:09:40），每一次都是 `host online … replaced:0`——换了身份就顶不了号，
旧 socket 只能等宽限/清扫。这与 `/healthz` 那些 `droppedFrames` 是同一个形状
（中继往"没有钥匙的对端"推就计数，且**不写日志**）。
想跨重启认出同一台主机（日志对齐、`/healthz` 计数、多台主机共存）就**显式配一个固定值**，
例如 `hostId: drc-bins-macbook`。 **[未实测：改完之后跨重启 `replaced` 是否变 1]**

## 5. 排错第一入口：`status.json`

```sh
cat ~/.dsh/dsh-remote-control/status.json
```

值得看的字段：

- `carrier`：`services`=真内核 / `mock`=内存替身 / `probing`=还没探到 / `none`=没起来（`reason` 会写 `disabled` 或 `invalid-config`）。
- `relay` + `relayProblem`：`online`/`connecting`/`offline`，runtime 还没起来时是 `idle`（**"没启动"与"断了"是两件事**，pill 抬头那句也照这个口径说）。**长时间停在 `connecting` 且不报错**是一种特定的病：版本不匹配（见开源手册的成对回滚那节），不是网络问题。
- `conversations` / `pendingPairs`：配对通道数与待配码数。空闲 TTL 之后会自己掉下去（实测两张码在约 120s 后归零）。
- `sidebar`：**界面上那一半为什么没起，只有这里能答**。`{"webServer":"via inject","route":"registered","actions":"registered"}` 是正常态；`webServer:"none"` / `"get threw: …"` / `"object without register()"` / `sidebar:"disabled"` / `route:"register threw: …"` 各对应一种坏法。`actions` 是 pill 那三条路由（发码/图片/状态）的注册结果——**它和 `route` 分开**：`route=registered` 而 `actions` 写了 `register threw` 时右栏照样弹、只是点不了配对，此时主插件会把 `/drc pair` 自动注册回来当兜底（判据是 `sidebar.available`，要求三条都挂上）。
- `outbound`：按载荷类型的出站计数——分清"插件没发"还是"发了但路上丢了"。
- `kernel.*`：`eventTypes` / `unmappedEventTypes`（内核发了但我们没认）、`listenerErrors`、`approvalFace` / `questionsFace`（人工交互那两面到底登记上没有）。
- `probe`：`applyCount`（同一进程内 `apply` 被调了几次——bundle 被重复挂载能看出来）、`injectChildren`、`fiberStates`。
- `problems`：`level:field` 形态的配置诊断清单。
- `pairing`：只有开了 `pairOnStartSec` 才有（`token`/`psk`/`expiresAt` ISO/`qr`/`ageSec`）。

`hostToken` **永远不出现真值**，只有 `hostTokenShape` 的脱敏形态（前 4 + `…` + 后 2 + 长度），这条有测试锁住。
写文件是 0600 + 临时文件改名原子替换。 **[已验证 2026-10-03：本机快照 `carrier=services`、
`relay=online`、`sidebar.route=registered`、`pairing=null`、`problems=[]`]**

## 6. 路由的真机取证（不用打开 UI）

宿主侧一共挂 4 条同域路由：`/pairing`（右栏那条，只读）、`/pairing/new`（发码，会改状态）、
`/pairing.png`（弹窗里那张图）、`/status`（pill 抬头那句连接状态）。这一节先给 `/pairing` 的配方，
pill 那三条在 6.1。

```sh
# 端口每次启动都变，先找它
lsof -nP -iTCP -sTCP:LISTEN | grep -i DeepSeek      # 实测某次是 127.0.0.1:19387
S=<会话 id（从 live-e2e 打印的会话列表里拿，形如 session-ed5b6f26-…）>
curl -s "http://127.0.0.1:<port>/plugins/dsh-remote-control/pairing?session=$S"
```

正面（实测）：`{"state":"ready","epoch":"575e1d4172857484","address":"dsh-resource://file/session/<S>//Users/…/.dsh/sidebar-qr.png","expiresAt":…}`。
负面四条（也实测）：非环回 `Host` → **403**、跨站 `Origin` → **403**、缺 `session` → **400**、
旧包路径 `/plugins/dsh-remote-control-presentation/pairing` → **404**。

### 6.1 状态栏那颗 pill 用的三条

同一条 webServer、同一套守卫，所以也能不打开 UI 就取证（`<P>` 是上面那个端口）：

```sh
curl -s -X POST "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing/new" \
  -H "Origin: http://127.0.0.1:<P>"                       # → {"state":"ready","epoch":…,"token":"482913","expiresInMs":…}
curl -s -X POST "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing/new"
# → 403：**会改状态的路由 Origin 缺席也拒**，不沿用只读那条"没带就当同源"的推断
curl -s "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing/new"        # → 405（只接受 POST）
curl -si "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing.png" | head -5
# → 200 + Content-Type: image/png + Cache-Control: no-store + ETag: "<epoch>"；没有效码时 204
curl -s "http://127.0.0.1:<P>/plugins/dsh-remote-control/status"              # → {"relay":"online","paired":0,"hasCode":true}
```

`ETag` 里那个 epoch 必须与 `POST /pairing/new` 回的 `epoch` 同一个（都是码文本的
`sha256` 前 16 位，定义只有一处：`pairingEpoch`）。**三条回答里都不该出现 `psk` 或 `dshr:`**——
一条 grep 就能复核：

```sh
for u in status pairing.png pairing/new; do
  printf '%s ' "$u"
  curl -s -X "$([ "$u" = pairing/new ] && echo POST || echo GET)" -H "Origin: http://127.0.0.1:<P>" \
    "http://127.0.0.1:<P>/plugins/dsh-remote-control/$u" | grep -c 'psk\|dshr:'
done   # 三个都必须是 0
```

⚠️ **这三条 curl 只证明路由在、守卫对、凭据没出去**，不证明那颗 pill 真的出现在屏幕上——
后者要的是 `slots` 服务在场 + 装载器给得出 `react` + 那个 dock 槽位认领了我们注册的组件，
这三件事只能在 UI 上看（`client.cjs` 里每一条降级都会 `console.warn` 一句，DevTools 里能查到）。

**地址与图要一起验，而且要原子地验**：`epoch` 是码文本的 `sha256` 前 16 位，落盘 PNG 是那条地址指向的文件。
解码用装了 zxing-cpp 的那个 venv：

```sh
PY=/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python
"$PY" -c "import zxingcpp;from PIL import Image;print(zxingcpp.read_barcodes(Image.open('<地址解出来的路径>'))[0].text)"
```

⚠️ **别把"curl 一次"和"解码一次"分开取样本**：配对码每 120s 轮换，中间隔一分钟就会得出
"epoch 对不上"的**假警报**（本机犯过一次，改成同一轮里先 curl 再解码才对上）。

## 7. 真机取证要配对码：`pairOnStartSec` 的用法与还原

`e2e/live-e2e.mjs` 的"三个真实"里，配对码只从真宿主来：它读 `status.json` 的 `pairing`，
并且只接受 **`ageSec ≤ 25` 且本轮没用过**的码；拿不到就失败，**绝不退化成 mock 主机**
（旧 `verify-deployment` 那个"自建主机"模式掩盖过一次真故障）。

所以跑它之前有两条路：

```sh
# (a) 临时打开自动发码（改 profile patch，跑完必须还原）
#     在 cordis.patch.yml 的 dsh-remote-control.config 下加一行：pairOnStartSec: 120
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 8; open -a "DeepSeek Harness"
env -u NODE_OPTIONS node e2e/live-e2e.mjs --rounds 2
# 还原：删掉那行，再重启一次；确认 status.json 的 pairing 回到 null、problems 里没有 warn:pairOnStartSec

# (b) 人工在 DSH 里打 /drc pair，然后把码喂进去
env -u NODE_OPTIONS node e2e/live-e2e.mjs --pair <6位码> --qr 'dshr:/p?…'
```

**改配置要成对还原**：开着 `pairOnStartSec` 就等于把仍然有效的配对码 + PSK 留在 0600 文件里，
它默认关正是这个原因。 **[已验证 2026-10-03：方案 (a) 跑通 `--rounds 2` = 36 项检查 36 项通过，
随后删掉该行并重启，`pairing=null`、`problems=[]`]**

## 8. 发布前该跑的取证（伞仓侧，全是真命令）

```sh
env -u NODE_OPTIONS pnpm -r test                          # e2e 全部 *.test.mjs（112）+ 本地全链路 16 步
env -u NODE_OPTIONS node e2e/live-e2e.mjs --rounds 3       # 真链路（需第 7 节那个前置）
env -u NODE_OPTIONS node scripts/validate-qr.mjs           # 动过二维码必跑：28 组 ×3 产物真实解码
env -u NODE_OPTIONS npm --prefix dsh-remote-mp run check    # 小程序三道闸（verify/theme/contrast）
```

四棵源码仓各自的闸门在它们自己仓里跑（`dsh-remote-protocol` 82、`dsh-remote-server` 78 含 1 skip、
`dsh-remote-control` 280、mp 三道闸），见 [`HANDOFF.md`](../HANDOFF.md) §5。
CI 在四个开源仓各自的工作流里；**伞仓没有 CI**（没有 remote，且 e2e 需要四棵平行仓在场）。

## 9. host 侧升级 / 回滚

升级 host：跑第 2 节那条命令 + 重启 Harness，然后看 `status.json` 的 `relay` 回到 `online`。
**中继与 host 必须成对回滚**（两侧握手在两代之间帧名与 `psk` 字段都动过，兼容矩阵在
[`dsh-remote-server/docs/SELF-HOSTING.md`](../dsh-remote-server/docs/SELF-HOSTING.md) 的成对回滚那节）；
小程序侧冻结，回滚不涉及它发版。
