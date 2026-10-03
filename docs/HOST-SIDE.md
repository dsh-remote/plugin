# 本机宿主侧（跑 DSH 的那台机器）

**这份只管 host 这一侧**：产物形态、怎么装进 profile、配置键、排错入口、真机取证的配方。

中继侧的部署（环境变量、nginx/wss、systemd/launchd/Docker、优雅停机、容量基线、
**成对回滚的兼容矩阵**、升级与回滚步骤）一律看权威手册
**[`dsh-remote-server/docs/SELF-HOSTING.md`](../dsh-remote-server/docs/SELF-HOSTING.md)**。
以前伞仓这里有一份 845 行的副本，和开源那份已经分叉（它还在讲 `apps/server`、`@dsh-rc/*`、
`version 2.0.0`），2026-10-03 删掉，只留下面这些**在这台机器上实测出来的**内容。

---

## 1. 产物形态：一个 bundle，两半

`dsh-remote-control@1.1.0` 把界面上那一半（原来是独立包 `dsh-remote-control-presentation`）折进了
主插件；`1.2.0`（已发布、带 provenance）先加上状态栏那颗配对 pill，随后把**右栏自动弹码**与
**终端文本码**两条老路整个删掉——配对入口现在只有那颗 pill。一次构建产出两半，
实测尺寸 `index.js 1242 KB / client.cjs 18 KB`：

| 产物 | 跑在哪 | 干什么 |
|---|---|---|
| `dist/bundle/index.js` | DSH 的 Node 侧（cordis fiber） | 配对、中继连接、会话与命令、审批转发、防休眠，**外加**挂 4 条同域路由给那颗 pill（发码 / 图片 / 状态 / 解配） |
| `dist/bundle/client.cjs` | DSH 的浏览器面（`window.__ModuleLoader__`） | 向装载器拿 `react`、软探测 `slots`、往 `conversation.composer.dock` 注册那颗 pill：抬头显示连接状态（2s 轮 `/status`），**点开是精简面板**——一行状态 + 一行中继地址 + 右上角一颗按钮（未配对=`生成配对码`、已配对=`退出配对`），发码要按那颗按钮（`POST /pairing/new`），退出配对按同一颗（`POST /unpair`） |

宿主注入的东西（`cordis`、`@deepseek-ai/*`）刻意**留在 externals**——打进去会造成两份实例。
协议层 `dsh-remote-wire` 是 npm 依赖，esbuild 打包时内联，所以 profile 里不需要 `node_modules`。
`react` **不进 externals 也不内联**：浏览器面是在运行期向装载器要它（模块名走变量，见
`packages/plugin/client/src/pill.ts` 文件头），拿不到只是少一颗 pill，而不是整页 web boot 失败。

**隔离现在由代码提供**：那一半需要 `webServer` 服务，而主插件刻意不写任何 `inject:` 闸门。
`src/pill/start.ts` 只软探测 `webServer`，拿不到就整半不起（一条路由都不挂），
`status.json` 的 `pill` 块会写明为什么。这条隔离有测试钉住：
`packages/plugin/tests/pill-isolation.test.ts` 把"有 webServer / 没有 / `register()` 抛错 /
`pill.enabled:false`"四种形态各跑一遍 `apply()`，要求主链路可观察字段**逐个相等**、
**字段集合逐个相同**，差别只许出现在 `pill` 探针与那一条 `warn:pill` 上；
并且两边都**一个命令都不许注册**（`/drc` 已整条删，见下）。

⚠️ **命令行这条路上没有东西了**：`/drc` 命令在 2026-10-03 **整条删掉**（更早删的是 `/drc pair`
与 `/drc pair force`）。配对唯一入口是状态栏那颗 pill 的四条路由。所以"路由没挂上"= 这台主机
配不了对，而它必须查得到——见 §5 的 `warn:pill`。

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
| `pill.enabled` | `true` | `DRC_PILL=0/1` | 状态栏那颗 pill = **配对的唯一入口**。关掉它这台主机就没有配对入口，`status.json` 会留一条 `warn:pill` 与 `pill:"disabled"`。这个键**只 warn 不 error**（error 会让主插件整个不启动，等于把界面功能变成配对链路的单点） |
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
- `hostId`：这台主机在中继上的身份。**两次重启之间它不该变**——变了就意味着旧 socket 顶不掉
  （中继日志会打 `host online … replaced:0`），而手机连的那条会话指向"没有钥匙的对端"，
  表现就是丢帧涨与"手机连不上"。落点是同目录那个 `host-id`（0600）；
  `config.hostId` 给了就以配置为准，不给就读/写这个文件（取证 HANDOFF §3.4 与 §9.11）。
- `pill`：**配对入口为什么没起来，只有这里能答**。`{"webServer":"via inject","routes":"registered"}` 是正常态；`webServer:"none"` / `"get threw: …"` / `"object without register()"` / `pill:"disabled"` / `routes:"register threw: …"` 各对应一种坏法。**只要它不是 `routes:"registered"`，`problems` 里就一定有 `warn:pill`；挂上了就一定没有**——这条是每次写快照时现判的，不是启动那一次的结论：`webServer` 由 `ctx.inject` 的回调晚到时，一次性判断会留下"路由已挂上却仍报 warn:pill"的假警报（2026-10-03 真机重启实测到）。命令行兜底已经删了，"配不了对"必须留得下原因。
- `problems`：`level:field` 形态的诊断清单。除配置问题外还包括 `warn:pill`（没有配对入口）与 `warn:pairOnStartSec`（status.json 里带着有效码）。配置那条的原因全文在宿主日志里（`apply` 时逐条 log），**`warn:pill` 的原因只在同一个快照的 `pill` 探针里**——所以那一条要看上面那个字段，别在日志里找。
- 已经删掉的键（`qrImage`/`qrOpen`/`qrAnsi`/`qrStyle`/`sidebarQr`）留在 profile 里**什么效果都没有**，也不会有一条 warn——2026-10-03 曾经为这五把键留过告警表，当天按"删了就不会回来，用到再重写"撤了。看到 `problems` 里没有它们**不是漏报**。
- `outbound`：按载荷类型的出站计数——分清"插件没发"还是"发了但路上丢了"。
- `kernel.*`：`eventTypes` / `unmappedEventTypes`（内核发了但我们没认）、`listenerErrors`、
  `approvalFace` / `questionsFace`（人工交互那两面到底登记上没有），以及审批那**四条读数**：
  `approvalCalls`（监听器真被派发过几次）、`approvalLast`（最后一次走到哪一步）、
  `approvalAsked` / `approvalDecided`（内核自己报的审计：问过几次、最后一次怎么收的场）。
  **`approvalFace=registered` 不等于"能弹卡"**——它只证明挂上去了；派发按作用域过滤、
  又按 waterfall 顺序排队，所以"没弹"有三种形状，靠这四条读数才分得开（取证见 HANDOFF §9.10）。
- `probe`：`applyCount`（同一进程内 `apply` 被调了几次——bundle 被重复挂载能看出来）、`injectChildren`、`fiberStates`。
- `pairing`：只有开了 `pairOnStartSec` 才有（`token`/`psk`/`expiresAt` ISO/`qr`/`ageSec`）。

`hostToken` **永远不出现真值**，只有 `hostTokenShape` 的脱敏形态（前 4 + `…` + 后 2 + 长度），这条有测试锁住。
写文件是 0600 + 临时文件改名原子替换。 **[已验证 2026-10-03：本机快照 `carrier=services`、
`relay=online`、`pill.routes=registered`、`pairing=null`、`problems=[]`]**

（1.1.0 那次同一行写的是 `sidebar.route`：右栏方案删除后那个键叫 `pill.routes`，这条跟着改了——别把它当成现在还是那样。）

## 6. 路由的真机取证（不用打开 UI）

宿主侧一共挂 **3 条**同域路由，全部服务状态栏那颗 pill：`POST /pairing/new`（发码，会改状态）、
`GET /pairing.png`（弹窗里那张图）、`GET /status`（pill 抬头那句连接状态）。
1.1.0 那条右栏用的 `/pairing`（只读、带 `?session=`）已经随右栏方案一起删除——它现在返回 **404**。

**发码那条要带一个自定义头**（`<P>` 是上面那个端口，每次启动都变，用 `lsof` 现找）：

```sh
lsof -nP -iTCP -sTCP:LISTEN | grep -i DeepSeek      # 实测某次是 127.0.0.1:19387
curl -s -X POST "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing/new" \
  -H "x-drc-pair: 1"                                      # → {"state":"ready","epoch":…,"token":"412002","expiresInMs":…}
curl -s -X POST "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing/new"
# → 403 {"error":"request-not-trusted","guard":"pair-marker-missing"}
curl -s -X POST -H "x-drc-pair: 1" -H "Origin: https://evil.example.com" \
  "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing/new"   # → 403 guard:"origin-not-trusted"
curl -s -X POST -H "x-drc-pair: 1" -H "Origin: dsh-app://app" \
  "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing/new"   # → 200（宿主自己的 scheme 算"自己"）
curl -s "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing/new"        # → 405（只接受 POST）
curl -si "http://127.0.0.1:<P>/plugins/dsh-remote-control/pairing.png" | head -5
# → 200 + Content-Type: image/png + Cache-Control: no-store + ETag: "<epoch>"；没有效码时 204
curl -s "http://127.0.0.1:<P>/plugins/dsh-remote-control/status"
# → {"relay":"online","paired":0,"serverUrl":"wss://drc.provid.cc:443/relay"}
#   三个字段全是非凭据：抬头那句状态与面板里那行中继地址由同一份回答驱动
#   （本机名 2026-10-03 从这条回答里撤了，面板也不再展示它）
curl -s -X POST -H "x-drc-pair: 1" \
  "http://127.0.0.1:<P>/plugins/dsh-remote-control/unpair"       # → {"state":"ok","unpaired":0}
#   `unpaired` 是这次作废掉的配对通道数；0 表示本来就没配上，是幂等成功、不是错误。
#   退出配对与发码同一档守卫（它也改状态）：GET → 405、缺头 → 403、跨站 Origin → 403。
```

⚠️ **这条写路由的跨站判据是那个头，不是 `Origin`**。第一版判据写成"Origin 必须存在且环回"，
在真宿主上直接失效：桌面宿主的转发层会在更外层把 `origin` 头删掉，于是 pill 渲染得好好的、
点下去永远 403（2026-10-03 屏幕上印的就是 `request-not-trusted（origin-missing）`——把守卫名
印进 403 回答里才查得出来）。自定义头则只有同源脚本发得出：跨站要带它必然触发 CORS 预检，
而这条服务既不响应 OPTIONS 也不发 `Access-Control-*`。`Origin` 存在时仍判，但**宿主自己的
自定义 scheme（`dsh-app://app`）与环回 http(s) 都算"自己"**，缺席不再算拒。

`ETag` 里那个 epoch 必须与 `POST /pairing/new` 回的 `epoch` 同一个（都是码文本的
`sha256` 前 16 位，定义只有一处：`pairingEpoch`）。**四条回答里都不该出现 `psk` 或 `dshr:`**——
一条 grep 就能复核：

```sh
for u in status pairing.png pairing/new unpair; do
  m=GET; case "$u" in pairing/new|unpair) m=POST;; esac
  printf '%s ' "$u"
  curl -s -X "$m" -H "x-drc-pair: 1" \
    "http://127.0.0.1:<P>/plugins/dsh-remote-control/$u" | grep -c 'psk\|dshr:'
done   # 四个都必须是 0
```

**那颗 pill 到底出没出现在屏幕上，curl 答不了**——它要的是 `slots` 服务在场 + 装载器给得出
`react` + 那个 dock 槽位认领了我们注册的组件。可行的配方是 `install-to-profile.sh` → 重启宿主 →
**看屏幕**。无障碍树这一条**不可靠**：这台机器上 Electron 经常只把菜单交出来（`getAppState` 回来
247 行全是 `menu bar`，或几千行里 1151 个 `menu bar` 后截断），命中的是渲染进程的 AX 有没有被
AT 客户端叫醒。**兜底是截图 + 按像素定位**（点之前先找到那颗 6px 的状态灯，别照猜的坐标点）：

```sh
# 截图存盘之后：把那一排裁出来看，并找出绿色状态灯的 x（tone=on 才是 #52c41a 那颗）
PY=/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python
"$PY" -c "from PIL import Image;im=Image.open('/tmp/drc.png').convert('RGB');im.crop((0,int(im.height*.72),im.width,im.height)).save('/tmp/drc-bottom.png')"
"$PY" -c "
from PIL import Image
im = Image.open('/tmp/drc.png').convert('RGB'); w, h = im.size; px = im.load()
pts = [(x, y) for y in range(int(h * .85), h) for x in range(w)
       if (lambda r, g, b: g > 150 and r < 140 and b < 120 and g - r > 50 and g - b > 50)(*px[x, y])]
xs = sorted({p[0] for p in pts})
runs, start, prev = [], xs[0], xs[0]
for v in xs[1:]:
    if v - prev > 6: runs.append((start, prev)); start = v
    prev = v
runs.append((start, prev))
ys = [p[1] for p in pts]
print('绿点 x 区间：', runs, '— 最右那个才是我们的 pill，左边那颗是 provider-usage 的')
print('y 区间：', min(ys), max(ys), '— 点它的文字（再往右 30~40px），别点那颗 6px 的灯')"
```

AX 树正常时应该看到这一排（**按元素点**，坐标点容易打歪）：

```text
212 pop up button Description: 未配对, Help: dsh-remote-control：未配对     ← 那颗 pill
213 dialog dsh-remote-control 配对
214   text 未配对 / 中继 127.0.0.1:8787 / 状态 已连接 / 版本 1.2.0   ← 抬头那句状态 + 正文那三行
215   button 生成配对码                        ← 右上角那颗；已配对时它改叫「退出配对」
216   image Description: 配对二维码, URL: dsh-app://app/plugins/dsh-remote-control/pairing.png?e=<epoch>
217   text 扫码配对 · 1 分 59 秒后过期
```

按下去 **215** 那颗之后 216/217 才出现（没按之前面板里只有 213/214/215）。
面板刻意精简：正文就**中继 / 状态 / 版本**三行（各自拿不到值时那一行不占地方），
**没有**本机名 / 台数那几行，**没有**「再配一台」，**没有**「换一张」。
那颗按钮**跟着当前视图走**：未配对=`生成配对码`、已配对=`退出配对`（按下去就是 `POST …/unpair`）、
正在出图=`刷新`。码过期**不再自动补**，就地写一句"已过期"、重发靠再按那颗 `刷新`；
手机上刚扫完码，面板**当场从二维码翻回状态视图**（那一张码已经没用了）。

抬头那句的颜色由 `data-tone` 决定，四种状态四种颜色：灰（`远程未启动` / `未配对`）、
黄（`连接中`）、绿（`已配对`）、**红（`已断开连接`）**——断链是故障，不能跟"还没轮到配"共用灰。

**[已验证 2026-10-03 下午，本机 `~/.dsh/profiles/desktop` + 生产中继 `wss://drc.provid.cc`]**
pill 出现在输入框那一排（排在 provider-usage 那颗用量 pill 右边）、抬头随 `/status` 变、
点开弹出 QR + 6 位码 + 倒计时、Escape 收得掉；而且**原子核对过了**：dialog 里那个图片 URL 的
`?e=`、`pairing.png` 回的 `ETag`、以及解码那张 PNG 得到的文本的 `sha256` 前 16 位三者相同
（实测 `eaa212225608605a`，解出的 `t=` 与屏幕上印的 6 位码一致）。

**[已验证 2026-10-03 傍晚，删掉右栏与文本码之后的那一版产物（`client.cjs` `d961dcc5…`）]**
同一套判据再过一次：屏幕上是 `● 点一下配对` → 点下去弹出 QR + `057482` + "1 分 28 秒后过期" +
"换一张"，抬头变 `● 配对中`；同一轮里 `POST /pairing/new` 复点回**同一张**
（`{"state":"ready","epoch":"ff5d01936e40437d","token":"057482"}`）、`pairing.png` 的
`ETag: "ff5d01936e40437d"`、`status.json` 里那张 `qr` 的 `sha256` 前 16 位也是它，路由回的 PNG
解出来 `…&t=057482`。`status.json` 这轮是 `pill={"webServer":"via inject","routes":"registered"}`
**且 `problems=[]`**——上一版这里同时写着 `routes:"registered"` 和 `warn:pill`，那是启动快照的假警报。

**[已验证 2026-10-03 深夜，抬头改成"未配对/已配对"、点开改成连接信息那一版（当时构建 `index.js` `b362fec0…` / `client.cjs` `9328b1e5…`；发布时同一源码重建出 `058289e3…`/`0dfb8fb4…`，**哈希随构建方式变**，别拿它判新旧）]**
这一轮改的是**文案与点开后的内容**，所以判据也跟着换：
`● 未配对`（灰灯，`/status` 回的 `paired:0`）→ 点一下弹 `dialog dsh-remote-control 连接信息`，
里面四行 `本机 bins-macbook / 中继 drc.provid.cc / 状态 已连接 / 已配对 0 台` 加一颗
**生成配对码**；**这一刻 `/status.json` 里没有码**（点开不发码这条就是这么证的）。
再按那颗按钮才出 QR + `570461` + `扫码配对 · 1 分 58 秒后过期` + `换一张`，
原子核对仍然过：dialog 里图片 URL 的 `?e=34f0592ef489f470` == `pairing.png` 的
`ETag: "34f0592ef489f470"` == `sha256(status.json 里那张 qr)` 前 16 位，且 `status.json` 的
`pairing.token` 就是屏幕上那 6 位。Escape 收得掉。
`GET /status` 这轮起回的是 `{relay, paired, hostLabel, serverUrl}` 四个非凭据字段
（`hasCode` 删了：抬头不再区分"有码/没码"，而"看一眼"也不该去消耗 pending 表）。

⚠️ **这一轮真正踩到的坑在浏览器那一半，而它不在 `status.json` 里**：`status.json` 的 `pill`
只答"宿主侧那四条路由挂没挂"，屏幕上有没有那颗按钮是另一半的事。把 client 模块的 `inject`
从 `['sidebarRight']` 改成 `[]`（想让 `slots` 走软探测）之后，`apply()` 跑到了槽位服务之前，
**pill 整颗不出现，而 262 项单测全绿**——假上下文只给同步的 `ctx.get`，演不出"服务还没到"。
按宿主自带模板 `templates/decoration/client.js` 写成 `inject: ['slots']` + `ctx.slots.inject(...)`
才回到屏幕上；软探测与 `ctx.inject(['slots'], …)` 的晚到回调留作退路。
**推论**：这一半坏了只能看 DevTools 里 `[dsh-remote-control pill]` 开头那几行；
而任何"改激活时机"的改动，都必须以**看一眼屏幕**收尾，不能只信测试数。

**[待复验 2026-10-03 深夜 v2，单台配对 + 退出配对 + 面板重做 + 配色那一版]**
这一轮把面板又收了一层：抬头是状态、**右上角只有一颗按钮**（未配对=`生成配对码`、已配对=`退出配对`、
出图=`刷新`），正文**中继 / 状态 / 版本**三行（先收成"只有中继"、用户嫌单薄又补了两条）；
本机名与台数不上屏，`再配一台`、`换一张` 全删，
码过期**不再自动换**；断链那句是**红**的 `已断开连接`；配上之后面板从二维码翻回状态视图。
复验配方（重装宿主后照上面那套走）：点开是 `dialog dsh-remote-control 配对` + 抬头一句 + **三行正文** +
一颗按钮；未配对时按它出 QR + 6 位码 + `扫码配对 · …`，**等过 2 分钟再看**——码还在原地、只多一句"已过期"
（右上角那颗此时叫 `刷新`）；配上手机后抬头变 `已配对`、那颗按钮改叫 `退出配对`、**二维码那一块消失**，
按它 → 手机掉到 `needs-pair`。
`GET /status` 这版起回 `{relay, paired, serverUrl, version}` 四个字段（`hostLabel` 撤了、`version` 是新加的）。

⚠️ **这一版第一次真机复验就撞上一个"新 JS + 旧 CSS"的错位**（用户截图：右上角那颗按钮掉到第二行居中、
中继那一行竖排）。根因不在布局本身——`ensureStyle` 原来只要 `<head>` 里有一份
`style[data-plugin-css]` 就直接返回，而宿主换新版这一半时**文档未必重载**，于是新代码按新结构建 DOM、
上一版的样式表还在生效（旧的 `.drc-actions{justify-content:center}`、旧的行方向都在管事）。
修法是**按内容对齐**：内容不一致就当场换掉。**推论**：这类"注入型"代码，判据不能是"插过没有"，
必须是"插进去的是不是这一版"；而真机上"布局怪"要先怀疑样式表版本，再怀疑布局代码。

**epoch 与图要一起验，而且要原子地验**。落盘文件已经没有了（右栏方案删了），所以图直接从路由取、
在同一个脚本里解码并比对——解码用装了 zxing-cpp 的那个 venv：

```sh
P=$(lsof -nP -iTCP -sTCP:LISTEN | grep -i DeepSeek | grep -o '127.0.0.1:[0-9]*' | head -1 | cut -d: -f2)
E=$(curl -s -X POST -H "x-drc-pair: 1" "http://127.0.0.1:$P/plugins/dsh-remote-control/pairing/new" \
    | sed -n 's/.*"epoch":"\([0-9a-f]*\)".*/\1/p')
curl -s -o /tmp/drc-check.png "http://127.0.0.1:$P/plugins/dsh-remote-control/pairing.png"
/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python - "$E" <<'PY'
import hashlib, sys, zxingcpp
from PIL import Image
text = zxingcpp.read_barcodes(Image.open('/tmp/drc-check.png'))[0].text
computed = hashlib.sha256(text.encode()).hexdigest()[:16]
print('回答里的 epoch =', sys.argv[1])
print('解出文本的哈希 =', computed)
print('一致 =', sys.argv[1] == computed, '| URI 里的 6 位码 =', text.split('t=')[-1])
PY
```

⚠️ **别把"curl 一次"和"解码一次"分成两轮跑**：配对码每 120s 轮换，中间隔一分钟就会得出
"epoch 对不上"的**假警报**（本机犯过一次，改成同一轮里先 curl 再解码才对上）。上面那段就是
一次取 epoch、一次取图、在同一个进程里比完。

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

# (b) 点状态栏那颗 pill 拿码（命令行 /drc 已在 2026-10-03 整条删除），再把码喂进去
env -u NODE_OPTIONS node e2e/live-e2e.mjs --pair <6位码> --qr 'dshr:/p?…'
```

⚠️ 方案 (b) 里完整 URI **只能从 pill 之外的地方拿**：那四条路由的回答里刻意不含 `psk`，
所以要么开 (a) 从 `status.json` 读，要么在本机 `curl` 发码后从主机内部对——
`status.json` 的 `pairing.qr` 在 `pairOnStartSec>0` 时才有这一项。

**改配置要成对还原**：开着 `pairOnStartSec` 就等于把仍然有效的配对码 + PSK 留在 0600 文件里，
它默认关正是这个原因。 **[已验证 2026-10-03：方案 (a) 跑通 `--rounds 2` = 36 项检查 36 项通过，
随后删掉该行并重启，`pairing=null`、`problems=[]`]**

## 8. 发布前该跑的取证（伞仓侧，全是真命令）

```sh
env -u NODE_OPTIONS pnpm -r test                          # e2e 全部 *.test.mjs（113）+ 本地全链路 17 步
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
