# Changelog

## 0.5.3 —— 挂起 1 分钟还没人管，就发一条微信提醒

审批/提问挂起时，手机**可能不在**（用户去干别的了）—— 而这恰恰是最需要他的时刻：
桌面那一半只能干等（不设期限），用户回到电脑前才发现"刚才有个审批没答"。

### 做了什么

- 审批与提问**创建时**各挂一个 **60 秒**的提醒定时器（`NOTIFY_DELAY_MS`）。
- 到点检查五步：卡还在吗 → 手机在线吗 → 收集同会话里未通知的卡 →
  全部标记 `notified` → 发一帧 `notify-approval`。
- `settle()` 同时清掉提醒定时器（与结算定时器**两回事**，都要清）。

### 四条纪律

1. **按声明开**：中继没声明 `notify.v1` ⇒ **连定时器都不挂**（老中继会回
   `unknown_frame`，发了就是给两端刷错误）。
2. **在线不发**（v1）：手机此刻在线的话，它本来就能看到卡。
3. **一张卡一条**：标记 `notified`；同会话的审批+提问**聚合成一条**。
4. **不重试、不补发**：主机重启后 pending 本身已丢，不会恢复提醒。

提醒帧只含**元数据**（哪张卡 / 什么时候挂起 / 审批还是提问）——
**一个字的内容都没有**，模板正文由中继按固定文案填。

判据：`tests/interactions-notify.test.ts`（8 条）。

## 0.5.2 —— 换码节奏放慢 + 码龄可见

### 屏幕上的码不再每 90 秒变一次脸

换码线从「剩余不足半程」（线上 TTL 180s ⇒ 每 90 秒换一张）改成「**剩余不足 30 秒**」
（`core/pairing-window.ts` 的 `ROTATE_MARGIN_MS`；TTL 很短时仍封顶半程，防换码风暴）。

换码**不会作废旧码**（中继的 pending 表里它一直活到自己的 TTL），所以早换只剩下副作用：
二维码在用户正要扫的时候变脸、`pair token issued` 刷屏（实测一晚 409 条）。
改完之后屏幕上的码稳定约 150 秒，而换码那一刻仍有 30 秒余量——认领是一个来回，秒级。

### `/status` 新增码龄 / 剩余寿命

`pairing: { ageSec, expiresInSec } | null`（`core/pair-issuance.ts` 的 `info()`）。
**只有两个数字**：宿主 UI 可以显示"这张码 45 秒前生成、还有 135 秒"，而不必让用户扫了
才知道失效。凭据（token/psk）**一个字都不许**过这条每 2 秒被轮询的只读接口——
带凭据的那份仍在 0600 的 `status.json`。

判据：`tests/pairing-window.test.ts` 改 2 条 + 新 1 条（180s 的码在 95 秒时不许换）、
`tests/pair-issuance.test.ts` +1（`info()` 只吐两个数字、花掉即 null）、
`tests/pill-routes.test.ts` 的 `/status` 白名单（九个 → 十个非凭据字段）。

## 0.5.1 —— 三包深审收口（行为零变化）

- `helloOkFor*` 缺省补 `PROTOCOL_VERSION`（schema 必填；构造器不许造出"对侧静默丢帧"的形状）；
- 协议注释与现状对齐（版本上报默认方向、`FRAME_TYPES` 计数）；
- `kernel-events.ts` / `index.ts` 两处注释编辑残迹清掉；
- 中继侧那条死开关（`reportSoftwareVersion`）在 relay 包删掉，插件侧同步注释。

## 3.2.14 —— 与 3.2.13 逐字节相同（版本对齐）

`src/` 无任何改动。3.2.14 的实质改动在 relay（`/code` 拒渲染死码 + 主机宽限改挂起），
plugin 只随号对齐，方便「四包同号」的核对口径。

## 3.2.13 —— 配对码"谁都不补"的三处修复（真机 2026-10-23 上午）

### 手机端解配 ⇒ 主机自动补一张新码

用户报："手机端退出配对，主机端不会自动刷码" —— pill 停在「未连接」+ 一颗「刷新」，
面板里再也不会出现二维码。

根因两层：① 屏幕那张码在配对成功那一刻就被中继 `claim` 烧掉（`markConsumed` 清空
窗口 `active`），而自动发码 `pairOnStartSec` 默认 **0** ⇒ `pairingWindow.tick()` 第一行
`if (pairSec <= 0 && active === null) return false` 直接早退，**谁都不会补**；
② `peer-left{unpaired:true}` 只走到 `onConversationGone`（清确认码），传输层没有
"这次是用户主动解的"这个出口。

修复：`RelayClient` 新增 `onClientUnpaired`（与"掉线"的 `onClientLeft` 严格分开），
`index.ts` 接上 `ensureFreshPairing()` —— 中继不在线时记一笔 `pairingCodeOwed`，
`online` 之后自动补上。主机自己那颗「退出配对」（`unpairAll`）一直会补，两端语义这才对称。

### 码被消费 ⇒ 立刻补发

`onPeerJoined` 的消费分支原来只清旧码（注释承诺"当场换一张新的"只做了前半），
补发指望 `tick()`，而 `tick()` 在默认配置下早退 ⇒ 屏幕上挂着烧掉的码，
重扫必 `already_used`。现在消费即 `wrappedPublish()`。

### 过期倒计时：pill 与配置页统一

- **pill**：倒计时归零原来只画一句「配对码已过期 点右上角刷新重新生成」
  （2026-10-05 的产品裁决），现场是"码直接没掉、要手动点刷新" ⇒ 改为**过期就地补一张**，
  与配置页同一口径。
- **配置页**：倒计时改成**墙钟重算**（原来每拍减 1000，后台冻结一拍就漂 —— 显示还有时间、
  码其实已死），归零时**先停表再补码**（原来下一拍又 `<= 0`，每秒发一张）。

### pill 面板：解配后就地换回二维码页

`settlePanel()` 原来只在"二维码页"那一支跟着状态走；「已配对点开只给状态」那一屏在
配对簿归零后照旧画状态 ⇒ 用户只能自己点「刷新」。现在 `view.kind === 'info'` 且
`pairings === 0` 时就地切回二维码页（判据用 `pairings` 不是 `paired`：手机退后台是
"手机离线"，不该拿二维码盖住）。

## 3.2.12 —— P1-3 主机侧半步：run 输出不受「没有活客户端」闸

### `RUN_OUTPUT` 分流

内核事件管道（delta / inbox / tool / run-state / todo / retry / compaction，
含 DeltaWindow flush）**无条件上线**——断线期的输出由中继环接住、手机重连
`hello.resume` 补投；周期/状态帧（session_changed / model / keep_awake_state /
host_info，含 15 秒周期推）照旧被闸（5737 的噪声修复不许原样回来）。

判据三层：transport 分流 / runtime 调用点选择（防 RUN_OUTPUT 漂到周期推上）/
真插件全链 30 帧断线补齐。**至此 mvjctc63 型"转圈后内容跳变"的机制面闭环。**

### 其他

- 「始终允许」记忆表（`sessionAllowed`）有界化：256 条 LRU + 命中刷新队尾
  （原来只在 `stop()` 清 ⇒ 进程级累积）。刻意**不按会话列表裁剪**（列表是
  LISTING_LIMIT 截断的，旧会话掉出前 100 会被误清——`rememberModel` 同款判例）。
- `isoOrUndefined` 与 protocol 规范版合并（plugin 版一行转调，行为逐字节相同）。

## 3.2.11

版本号随四包同步。本包**无代码改动**（本轮只改小程序端，主机侧行为不变）。

## 3.2.10 —— 修「始终允许」点了等于没点（而且之后再也不弹）

真机（2026-10-22，用户报）：手机审批卡点「始终允许」→ 桌面那张卡照旧等人，
这次工具调用**一直不落地**；同时之后同类审批**连弹都不弹**，全部静默挂住。

两个症状是同一个根因的两头，根因在 `platform/carrier-services.ts` 的 `participate()`：

- 手机的答案白名单只认 `'allowed-once'` / `'rejected'`，v3 新增的
  **`'allowed-session'`（「始终允许」）掉进了 `answered: false` 那一支** ⇒ 手机这一票被丢掉，
  `Promise.race` 只能继续等桌面（桌面那张卡永远不会自己被撤）。
- 而 `runtime.settleApproval()` **已经**把 `(sessionId, 工具名)` 写进了 `sessionAllowed`
  ⇒ 下一次同类请求在挂卡之前就命中记忆、**一帧都不发**。
- 于是"允许"这一半丢了、"别再问"那一半生效了：**越点越不弹，工具全卡住**。

修法两处：

1. `'allowed-session'` 进白名单 —— 它是手机的**答案**，不是"没答"。
2. 交回平台的返回值翻成 `allowed-once`：`'allowed-session'` 是我们自己的词汇，
   平台（`@deepseek-ai/dsh-user-approval` 的 `ApprovalOutcome`）不认识它，交给它等于"这次没结论"。
   "同一会话同类操作别再问"仍由 `runtime.sessionAllowed` 承担（`ports/index.ts` 的契约原文）。
   `face.last` 仍印 `allowed-session`，doctor 靠它分清"允许一次"与"这一档已记住"。

判据：`tests/carrier-services.test.ts` 的「「始终允许」是手机的答案」（桌面那一半**永不作答**，
用 50ms 哨兵防判据自己挂死）。修前实测返回 `HUNG`（正是用户看到的"没反应"），修后 `allowed-once`。

## 3.2.9 —— 修「扫码配对全挂」+ 设置页输入框焦点 + 提问卡可收起/跳过

### 🔴 严重：扫码配对全挂（当天引入、当天修）

`core/client.js` 的 `_sendHello` 里加了
`if (version.REPORT_VERSION) hello.softwareVersion = version.APP_VERSION`，
**但那个文件里从没 require 过 `./version`** ⇒ `version` 是未定义标识符
⇒ 建连时抛 `ReferenceError` ⇒ `hello` 帧发不出去 ⇒ 中继不认这条连接
⇒ **扫码走到「认领成功」之后就断在那里**（用户报："开发版小程序内部扫配对码不能用了"）。

⚠️ 它**不只影响开发版**：所有版本都会挂（开发版只是当时在用的那个）。
⚠️ 只有 `e2e/mp-client.test.mjs`（真 client × 真中继 × 真插件）能抓到 ——
它报的是 `Test hook "before" ... ReferenceError`，25 条测试 `pass 0 / fail 0`。

修：补 `var version = require('./version.js')`。
判据：新增**源码级**一条（`mp-version.test.mjs`）—— 读了 `version.*` 就必须真的 require，
把这个"只有真跑才炸"的错误挡在最快的一层。

### 设置页（插件的，不是宿主本体的）输入框焦点一直丢

`paint()` 每 2 秒被状态轮询调一次，原本做的是 `box.replaceChildren(...)` ——
**整棵子树换掉**。「进阶」那张卡（含两个 `<input>`）虽然只建一次，
却被塞进**每次重建**的 `grid` 里 ⇒ 每 2 秒被摘出 DOM 再插回 ⇒ **焦点每 2 秒丢一次**。

修：常驻骨架 —— 把"每次都变的"与"带输入框的"分成两棵树：

```
box            ← 常驻，永不换
 ├ topHost     ← 常驻容器，内部每次重画（抬头 + 状态条）
 └ grid        ← 常驻（data-two 仍管两列）
    ├ leftCol  ← 常驻容器，内部每次重画（配对卡）
    └ rightCol ← 常驻容器，装「进阶」卡，永不重画
```

视觉不变：原来"两卡等高"靠 grid 的 `align-items: stretch`，拆列容器后由
`.drc-sec-col` 的 flex 接管（判据同步更新）。

判据：读**祖先链的对象身份** + 新增 `FakeElement.moves`（每个节点被摘出过几次）。
⚠️ 只比 `parent` 不够：`replaceChildren` 之后又 `appendChild` 回**同一个**父节点时，
前后 `parent` 一模一样，可中间那一下照样失焦。

### 提问卡：可收起、可跳过

用户报："提问框没办法跳过或者关掉"。两条出口分开：

- **收起**（`panelFolded`）：收成一条细条「已收起 · 主机仍在等你答复 / 展开」——
  主机那边照样在等，随时放回；
- **跳过**：`onSkipQuestion` ⇒ `client.interrupt()`（`cmd.interrupt` →
  主机 `agent.cancel({kind:'user'}, {keepInbox:true})`）⇒ **真让主机中止这一轮**。

两者都在**同一行底部**：**左「跳过」· 右「收起 / 展开」**（用户裁决）。
收起与展开**位置完全相同**（站定右下角），用户不用在两种形态之间重新找那颗按钮；
这一行在收起分支**之外**，所以收起之后照样能展开、能跳过。

⚠️ **跳过绝不许实现成"发一个空答案"**：`cmd.answer` 的 `answers` 是 `min(1)`，
而"一条里一个都没选"的答案会被主机**当成真答案**交回提问服务
（那条链只判"有没有值"）⇒ 用户以为跳过了，其实答了一个空。
判据钉住 `onSkipQuestion` 必须调 `.interrupt(`、不许出现 `.answer(`。

### 提问卡输入框打不了字（同一天早些时候）

它挂的是 **`bindfocus="onInputFocus"`** —— 那是 **composer 的**聚焦钩子，
而 composer 写着 `focus="{{inputFocus}}"` ⇒ 提问卡一被聚焦，composer 就抢走焦点。
修：独立状态 `panelInputFocus` + 自己的 `onPanelInputFocus/onPanelInputBlur`，
并在提问卡出现时收掉 composer 的焦点。

### 首页：给插件包名 + 文案

- 未配对页新增一行 **DSH插件：@dsh-remote/plugin**（从微信搜索来的用户不知道要装什么），
  位置在「扫一扫电脑上的码」**之前**；
- `hero-desc` 压短之后补回"跟进"（审核判据要求首屏出现"查看/跟进/同步"这一族动词）。

### 版本上报（默认关，零知识不变）

`hello` 帧新增可选 `softwareVersion`：

- 两端（主机 / 小程序）都支持，**默认不带这个键**（不是空串）⇒ 帧逐字节不变；
- 只有 `DRC_REPORT_VERSION=1` 的部署才带（小程序在上传时注入）；
- 中继侧 `reportSoftwareVersion` 默认 **false**（开源版不记对端版本）。

判据：协议层钉"不给参数 ⇒ 帧里没这个键"；relay 钉"默认关、只认 1/true"。

### 判据纪律（当天两次踩到）

1. **扫源码的判据必须先剥注释**：我在 hero 上方写了句"避开审核词表
   （远程控制 / 控制电脑…）"，而那条判据扫的是含注释的原文 ⇒ 误红。
   注释会被编译掉、审核员一个字看不到。
2. **"快判据全绿"不代表"小程序还能连上"**：改了 `core/*.js` 必须跑
   `e2e/mp-client.test.mjs`（真跑 client 的那条）。

## 3.2.8 —— 新用户装不到新版：`dependencies` 里那 5 个包全是多余的

### 现象（2026-10-22 14:0x 实测）

新用户装 `@dsh-remote/plugin@latest`（pnpm 11 + npmmirror）⇒ **装到 3.1.11**，
落后六个版本 ⇒ **3.1.x 插件 + 3.2.x 小程序 = 根本配不成**
（线上已有一台真实主机在反复重试：4 分钟内配对 4 次、失败 2 次 `already_used`）。

### 根因（两层叠加）

1. **pnpm v11 的 `minimumReleaseAge` 默认 1440 分钟（24h）** ⇒ 只装发布满 24h 的版本。
   ⚠️ 它是**内建默认**：`pnpm config get` 查不到、`.npmrc` 里写 `minimum-release-age=0`
   **也无效**（实测仍是 3.1.11）⇒ **换 registry 源也没用**（它是 pnpm 层的行为，与源无关）。
2. **本包 `dependencies` 里那 5 个包全是多余的** ⇒ 于是形成死结：
   - plugin 3.2.x 的 `dependencies` 要求 `@dsh-remote/protocol`；
   - protocol 的最新版也发布于 24h 内 ⇒ 不可用；
   - pnpm 一路回退，直到找到**一对都够老**的组合 ⇒ **plugin 3.1.11 + protocol 3.1.12**。

### 修法：`dependencies` 清空（全部移进 `devDependencies`）

- **运行时零依赖是真的**：`main` 指向 `dist/bundle/index.js`，
  `files` 只含 `dist/bundle` ⇒ npm 包里**只有 bundle**；
  而 bundle 已**内联 162 个非本包模块**（protocol / ws / zod / tweetnacl / qrcode 全在内），
  外部 `require()` 只剩 Node 内置与 `ws` 的两个**可选**原生加速器
  （`bufferutil` / `utf-8-validate`，缺失时 ws 自动回退 JS ⇒ **行为无变化**）。
- 打包脚本 `external` 只留 `cordis` / `@deepseek-ai/*` / 那两个可选加速器
  ⇒ **不依赖 `dependencies` 字段** ⇒ 移走不影响打包。
- 仓里 relay 的 `dependencies` 本来就是 `{}` ⇒ 这才是本仓的惯例，
  plugin 那 5 个是**历史遗留**（3.2 之前 protocol 没被内联时的残留）。

### 效果

- 新用户不再被 protocol 的 24h 拖累 ⇒ 装到**最后一个发布满 24h 的 plugin**，
  而它**内联着自己那一版的 protocol** ⇒ **版本自洽、可用**。
- ⚠️ **plugin 自身的 24h 限制仍在**（pnpm 策略，改不了）⇒ 最新版要**发布满 24h** 才装得到。
  ⇒ **发版节奏要 aware**：重要版本发布后约一天才会到达用户。
  ⇒ 想要"立刻到达"，只能走**自定义 registry**（宿主「添加插件」里有那个选项）。

## 3.2.7 —— 配对文案纠错 + provenance 判据收紧

### 产品代码

- 主机侧配对确认文案：原来写「在手机上按停止」，可手机上只有「数字一致 / 不一致」
  ⇒ 改成「在手机上选不一致」（pill 与设置页两处）。
- 只改文案，不改配对流程：3.2.5 起主机端没有放行按钮，确认只留在手机端。

### 判据

- `client-bundle.test.ts` 同时钉住 pill 与设置页的那句话（两处不许分叉）。
- 发布工作流的 provenance 判据收紧：`grep -Eq` 容忍压缩/展开两种 JSON，
  并要求至少一条 attestation（空数组不算）；`e2e/npm-publish-tp.test.mjs`
  用样例真跑这条正则。

## 3.2.6 —— review 补修：解配时那串确认码也消失（两条解配路都清）

### 产品代码

- `pairApproval.clear()` 连带清掉"最近放行"那串确认码；
- **解配有两条路**，原来只清了一条 ⇒ 另一半漏：
  · 主机端点「退出配对」（`unpairAll()`）；
  · **手机端解配**（中继发 `peer-left{unpaired:true}` → `voidConversation`
  → `onConversationGone`）。
  ⇒ 两处都清。它不是凭据（真凭据在密文里、90 秒后自动消失），但「该消失的东西留着」
  本身就是一种不一致 —— 界面上的每一样东西都该对应当前状态。

### 判据

- 单元测试 ×2：刚放行时它在 / 过时自动消失 / clear 后消失；
- e2e ×1：手机端解配后主机的 `lastPairApproval` 必须变 null（真路径那条）。

### ⚠️ 顺带修掉一个**装置**的 bug（它让三个 e2e 文件红着）

等 `pair-grant` 的**基线**取晚了：原来放行是**手动**的（`POST /pair/approve`），
基线取在放行**之前**是对的；改成**自动放行**后 grant 可能在认领那一刻就到了
⇒ 基线取晚 ⇒ **跳过本轮那一条** ⇒ 等"下一条"永远等不到。

症状极像"配对没成"，而现场其实**配对已经成功了**（主机那侧带着本轮的 token 与 SAS）。
⇒ 基线挪到 `connect()` / `onPair()` **之前**，并加一条判据钉住这个位置。

⚠️ 这个 bug 是被 `wire-resume-delta` / `restart-resume` / `pairing-refresh`
逮到的 —— 它们在 `e2e/run.mjs`（全链路）**之外** ⇒ **全链路绿着而它们红着**。
⇒ `node e2e/run.mjs` 只是其中一条链，"它绿"不等于"全部绿"。

# Changelog

### review 补修（2026-10-22 凌晨）

review 找出两处**同一类**疏漏：`lastGranted()` 那串确认码在「解配」时没被清。

- `pairApproval.clear()` 没清它；
- 而**解配有两条路**：主机端点「退出配对」（`unpairAll()`）与**手机端解配**
  （中继发 `peer-left{unpaired:true}` → `voidConversation` → `onConversationGone`）。
  只清一条 ⇒ 另一半漏。

⇒ 两处都清（`unpairAll()` + `onConversationGone`），并加判据：
单元测试钉 `clear()` 的语义，e2e 钉**手机端解配**那条真路径
（`e2e/run.mjs` 第 18 步：手机 unpair 后主机的 `lastPairApproval` 必须变 null）。

⚠️ 它不是凭据（真凭据在密文里，90 秒后自动消失），但「该消失的东西留着」本身就是
一种不一致 —— 界面上的每一样东西都该对应当前状态。

## 3.2.5 —— 配对确认只留一边（手机端）+ 首页文案精简 + 版本提示条移到正确的位置

### 配对：主机改成**自动放行**，确认只留在手机端

用户裁决（2026-10-21 晚）：「小程序和主机端都要点确认有点繁琐，只保留一边可以吗」
⇒ **只保留手机端**。

**为什么主机那一次点击可以不省**：它**不增加任何安全性** —— 它只是把"用户已经看过
手机上的数字"这件事说了一遍；而真正的比对必须在**持有手机**的那一端做
（中继换掉公钥时两端算出的数字不同 ⇒ 手机上弹窗里那个数字与主机屏幕上的不一致
⇒ 用户点"不一致"即可中止）。

⇒ 主机在 `onPairRequest` 里**自动放行**（把 psk 加密送回手机），
主机界面**仍然显示那 6 位数字**供用户对照，但**不再有「数字一致，允许」按钮**。
`POST /pair/approve` 那条路由**留着**（自动放行没赶上时是唯一的兜底，
e2e 装置与排错也走它），但**浏览器端不再调用它**。

**新能力**：`pairApproval.lastGranted()` —— 放行是"取走即焚"，`current()` 立刻变 null
⇒ 主机界面就再也显示不出那串数字。而它是**用户唯一能对照的东西**
⇒ 放行之后仍要留 90 秒给用户对照（`status.lastPairApproval`）。

### 修：放行入口挂在**用不上的分支**里（真机死锁）

2026-10-21 23:00 的真机现场：中继日志里 `paired` **每次都成功**，主机 `pairApproval`
也确实挂上了申请（token 006867 / sas 325175），可用户点了半天**找不到那个按钮**。

根因：放行入口只画在 `view.kind === 'qr'` 那一支里，而面板进不进那一支看的是
`pairingNow() > 0`（**密钥簿里还有几条会话**）—— 主机密钥簿里只要留着**任何一条**会话
（哪怕那台手机早就不在了），面板就进 `info` 态 ⇒ **按钮不渲染** ⇒ 用户无从放行
⇒ 主机永远不回 `pair-grant` ⇒ 手机永远卡在"正在连接…" ⇒ 而主机那边显示
"已配对，不用再扫码"，**看起来一切正常**。

⇒ **放行入口属于"有申请"这件事，不属于"哪一屏"。** 现在每一屏都画它。

### 修：首页的插件版本提示条挂在**用不上的分支**里

同一类错误，第二处：那 6 位提示条（"电脑上的插件太旧，请升级"）原来挂在
**主机卡**那一块，而主机卡在 `wx:if="{{paired}}"` 里面 ⇒ **插件太旧的用户恰恰
还没配对**（配不上才要提示升级）⇒ 那条提示只在**用不上的场景**里出现。

⇒ 提到**页面最上面**（两个分支之外）：已配对（主机太旧、该升级）与未配对
（正是配不上的那一刻）两种画面都要看得见它。

### 精简首页文案

- `hero-desc`：「把电脑上跑着的任务带到手机上：进度、待办、要你确认的事。」
  → 「把电脑上跑着的事，带到手机上看。」
  （原文与下面 `hero-note` 的"进度、待办"**重复了一遍** —— 两句话都在列举"同步什么"，
  而首页只需要说清**这是什么**。）
- 按钮下那句：「也可以直接用微信扫一扫；扫不出来就输 6 位配对码。」
  → 「微信扫一扫也能进。」
  （后半句是**下面那个折叠入口**干的事，按钮下面再说一遍等于把折叠区又讲了一遍。）

### 判据

- 新增 `e2e/mp-page-pairing.test.mjs`（真中继 + 真主机 + **真页面** + 真 client）：
  走**页面**那条收尾路（`pairPhone()` 走的是 `client.confirmPairGrant()` 捷径，
  **绕开了页面**，所以真机多出来的那段重连从没被覆盖过）。
- 新增「位置」判据：提示条必须在两个分支之外（读 wxml 结构，**先剥注释**）。
- 新增「死锁回归」判据：`pairings: 1` 且有 `pairApproval` 时那 6 位数字必须显示。
- 判据本身也修了：按 `wx:if="{{paired}}"` 切分 wxml 的那几条**必须先剥注释** ——
  注释里也写着同样的字样，不剥就是按注释切分（切片只剩 900 字符，假红）。

## 3.2.4

`hostInfoPayload()` 现在带上 `pluginVersion: PLUGIN_VERSION`（规范 §13.2）。

手机靠它在首页判断"电脑上的插件够不够新"：3.2 换掉了整条配对协议，
**3.1.x 的插件配不上 3.2.x 的小程序而两端都不报错**；pnpm 的 `minimumReleaseAge`
还会静默把插件降级到最后一个"够老"的版本 —— 不报这一格，手机就只能对用户沉默。

⚠️ 它**不走 `hostMeta` 注入**：那是平台信息（注入是为了让单测能钉住 `state.sleep`
的推导），而版本是**本包自己的事实**，报别人的版本等于骗手机。

判据钉在 `tests/runtime.test.ts` 的「ev.host_info」那条里（必须等于 `PLUGIN_VERSION`）。

## 3.2.3

版本号随四包同步。**运行时代码无改动**（3.2.1 那次修复已生效）。

`scripts/pack-to-profile.mjs`：装机时顺手把 pnpm 的 `minimumReleaseAge` 豁免写进 profile
的 `pnpm-workspace.yaml`（三个分支都实测过：幂等 / 文件不存在 / 有键无裸包名）。

- pnpm v11 起 `minimumReleaseAge` **默认 1440 分钟**：只装「发布满 24 小时」的版本。
  它是**内建默认值** —— 配置里查不到、`pnpm config get` 返回 undefined，极难想到。
- 后果：宿主 plugin-manager 每次操作都把插件装成最后一个"够老"的版本。
  2026-10-21 实测 3.1.8 发布 31.6h（满足）、3.1.9 起全在 8h 内（被静默跳过）
  ⇒ 用户「不管装什么版本都会回到 3.1.8」，命令行只有一行 `+ … 3.1.8` 看不出降级。
- 豁免**按包名生效、覆盖该包所有版本** ⇒ 写裸包名一条就够，不必每发一版手工加一条。
  之前攒下的 `@…@3.1.6` / `@…@3.1.7` 就是手工加的遗留。

⚠️ scripts/ 不在 package.json 的 `files` 里 ⇒ 已发布的 3.2.3 产物不受影响，无需重发。

## 3.2.2

版本号随四包同步。插件无代码改动（3.2.1 那次修复已随 3.2.1 生效）。

## 3.2.1

### 清理：主机手里不再有"码的文本"

- `LivePairing` 去掉 `qr`；`pairingEpoch(token)` 改成 `sha256('dsh-rc/mp-code:' + token)` 的前 16 位。
  发码回答里的 `epoch` 与 `pairing.png` 的 `ETag` 仍然同一个口径，只是不再依赖一段已经被删掉的 URI。
- `index.ts` 不再 `buildPairingUri`（`status.json` 的 `pairing` 也随之不再出现 `qr` 字段 ——
  那本来是一条带 PSK 的字符串）。
- 删 `shell/mp-code.ts` 的 `kindFor()`：它回答"屏幕上该放小程序码还是旧码"，而旧码没了，
  只剩一个恒真分支。日志文案同步改成"这一格会空着（503）"，不再是"回落到旧码"。

### 修复：配完对之后，主机自报的限额永远到不了手机（3.2.0 引入）

- **根因**：`index.ts` 在 `onPeerJoined` 里推 `ev.host_info` 与挂起的卡，而 3.2 的 psk 是
  `pair-grant` 里送回来的 —— 用户还要比对一次 6 位数字才装进手机。`peer-joined` 早于
  `pair-grant`，那一刻发出去的密文手机上 `kH2C` 还是 `null`，`client.js` 的 `_onEncrypted`
  开头就 `return false`：**静默丢，连"解密失败"都不记**（所以两端都没有任何日志）。
- **后果**：扫码配完对之后 `hostLimits` 一直是 `null`，页面按"未知 ⇒ 照上界"放行选图，
  而真主机（web profile 那台内核）其实一张都收不下；挂起的审批/提问卡同样不出现。
- **修法**：交付点统一挪到 `onClientRejoined`，它的语义从"手机回来了"扩成
  **"这台手机的密钥面可以用来推东西了"** —— 触发点由 `transport/relay.ts` 新增的
  `awaitingKeys` 给出（配对登记 → 第一帧解得开的东西到达）。`sendHostInfo` 仍然排在
  `replayPending` 之前，帧顺序纪律不变。
- **判据**：`e2e/mp-client.test.mjs` 的 12j（修前红、修后绿）与 `e2e/pairing-refresh.test.mjs`。
  plugin 679。

### 判据

- 删 `tests/pairing-uri-source.test.ts`（整文件测的就是那条 URI 的 URL 源，功能已不存在）。
- `/status` 那条用例的名字从"九个字段…pairCode"改成"八个"（字段早就删了，名字一直没改）。
- ETag 那条断言跟着改成 `pairingEpoch(pairing.token)`。
- plugin 679。

## 3.2.0

### 破坏性：只剩小程序码这一种码（2026-10-21 用户裁决「不做兼容，只保留最优解」）

删掉的东西（都不是"藏起来"，是**删干净**）：

- **本机渲染 `dshr:` 二维码**那一整套：`src/platform/qr.ts`（含 vendored 编码器）、
  `src/pill/miniprogram.ts`、`GET /miniprogram.jpg`（设置页右栏那张静态入口码）、
  `GET /pair`（不依赖会话的配对页）。
- `PillStatus.pairCode` 与 `status.json` 的 `pill.miniprogramCode`：屏幕上只有一种码了，
  这两个读数没有"另一种可能"要表达。
- 根目录那个真实解码校验脚本（它解码的东西已经不存在了）。

现在 `GET /pairing.png` **只出一种码**：中继签发的小程序码（JPEG）。取不到就回 **503
`mp_code_unavailable`**，**不回落**成另一张码 —— 回落意味着屏幕上出现一张"用户以为能扫、
其实不是同一件事"的图，那正是 3.1.x 两次现场投诉的形状。

设置页恒为两张卡：左「配对这台主机」（码 + 6 位数字 + 待放行时的「数字一致，允许」）、
右「进阶」，两栏各半、底边对齐。

plugin 685。

## 3.1.12

### 已配对 / 手机离线时不再摆回入口码（2026-10-21 用户报）

上一版按"不是 mp 就摆"的规则走，于是**屏幕上根本没有码**的那两种状态下
（配对卡写着"已配对，不用再扫码"），`pairCode` 只能是 `unknown` ⇒ 入口卡又被摆了出来，
版面看着和改动前一模一样。

⇒ 只认**正面证据**：`pairCode === 'legacy'` 才建那张卡。顺带把"网格里只剩主卡"
收成一列（`data-single="1"`）—— 否则主卡被挤在左半边、右边留一个 224px 的空洞。

plugin 707。

## 3.1.11

### 设置页收成两栏：右栏的入口卡整张去掉、数字小一档、进阶上移（2026-10-21 用户截图标注）

三条都是用户在同一张截图上点的：

1. **「这个不要」** —— `pairCode=mp` 时右栏那张「手机端」卡**整张不建**（上一版只去掉了
   图、留了一行字，仍然占着一栏）。一张小程序码本身就是入口，不需要第二块内容解释它。
2. **「小点，不用这么大」** —— 6 位码 `16px`（原 20px）、字距 2px（原 4px）。它是
   "手输那条路"的备选，不是主角。
3. **「移到右上，与码并列，等高」** —— 右栏空出来之后，「进阶」那张表单挪进网格右列，
   `data-two="1"` 让两栏各占一半并 `align-items: stretch`（底边对齐）。回落成旧码时
   右列仍是入口码，它照旧独占一行。

plugin 707。

### 设置页只出一张码：配对卡已是小程序码时不再摆第二张（2026-10-21 用户报）

现场：上一版让配对卡里那张**变成小程序码**之后，右边那张静态入口码就成了
"长得一样的第二张"——用户当场问"怎么还是双码、我该扫哪个"。

改法：`/status` 增 `pairCode: 'mp' | 'legacy' | 'unknown'`（只读缓存、不发请求，
图片那条路由先被请求过就有结论）。`mp` ⇒ 设置页**不建那张 `<img>`**，只留一句
"在微信里搜「黑鲸远控」"；`legacy` / `unknown` ⇒ 照旧摆出来（自部署中继签不出
小程序码时，它是唯一的装机指引）。plugin 707。

### 修：`startPill` 把取码口吞了，真机一直出旧码（2026-10-21）

现场：3.1.9 装上、healthz 报 3.1.9、路由全挂上、`status.json` 全绿，而
`GET /pairing.png` 返回的仍是本机渲的 `dshr:` 旧码 —— **扫出来的不是小程序码**。

根因：`index.ts` 把 `mpCodeFor` 传进了 `startPill`，而 `startPill` 逐个字段重建
路由入参时没有转发它 ⇒ 路由侧 `typeof deps.mpCodeFor === 'undefined'` ⇒ 永远走
回落分支。零报错、零日志。

判据改成走**行为**（`pill-isolation`）：把一条假取码口塞进 `startPill`，再真打
`/pairing.png`，断言 `Content-Type: image/jpeg` 且取码口被调用过。做过反向验证——
去掉那行转发，这条当场红。plugin 706。

## 3.1.9

### 双码合一：默认出小程序码，密钥由主机加密送回手机（2026-10-21）

**用户现场**：原来微信扫的是宿主自己渲的 `dshr:` 码，**密钥就印在码里**；想要"微信
扫一下直接进小程序并完成配对"，就必须让码里只有配对码——而个人主体小程序用不了
"扫普通链接二维码打开小程序"，`scene` 又只有 32 字符（装不下 44 字符的密钥）。

**新路线（docs/PAIRING-ONE-CODE.md 的乙′）**：码里只有 6 位配对码 → 手机生成一次性
X25519 密钥对 → 认领帧带 `clientPub` → 中继转 `pair-request` 给主机 → **主机屏幕上出现
6 位确认码** → 用户点「数字一致，允许」→ 主机用 `wrapPsk` 把密钥加密送回手机
（`pair-grant`）→ 手机 `unwrapPsk` 拿到密钥。中继全程零知识。

改动：

- `src/shell/mp-code.ts`（新）：向中继 `GET /code?token=` 要这一枚码的小程序码。
  成败看 JPEG 魔数；失败按原因负缓存 60 秒——自部署中继没配小程序是**常态**，
  没有负缓存就是"每开一次弹窗打一次外网"。
- `GET /pairing.png` **默认给小程序码**（JPEG），拿不到才回落到本机渲的旧码（PNG）；
  `?kind=legacy` 强行要旧码。Content-Type 按实际给的那一档写（写死 png 浏览器解不开）。
- `POST /pair/approve`（新，第八条同域路由）：用户确认后放行，回 `pair-grant`。
- 设置页与 pill 同步：有人在等放行时显示 6 位确认码 + 「数字一致，允许」；
  旧码折进「旧版扫码 / 手动输入」，不再是默认那一张。

判据 705（新增 `tests/mp-code.test.ts` 6 条 + 图片路由三条 + 设置页三条）。

## 3.1.8

版本号随四包同步（本包无代码改动）。

## 3.1.7

### 桌面版跨源：补 CORS 与预检，配对不再「请求失败」（2026-10-20）

0.2.1 桌面页面在 `dsh-app://` 上，而路由在宿主 HTTP origin 上 ⇒ **每个请求都是跨源**。
带 `x-drc-pair` 的 POST 会先发 `OPTIONS` 预检，而路由没有预检分支（回 405）⇒ `fetch` 直接
reject，界面显示「配对请求没成功：读不到主机状态（请求失败）」。

修法：`registerPillRoutes` 给**每一条**路由套一层 CORS——`OPTIONS` 就地回 204 + 允许头，
其余请求回声 `Access-Control-Allow-Origin`（**只对"像这台宿主自己"的 Origin**：环回 http(s)
与 `dsh-app:` 白名单，与 `rejectedBy` 同一套判据；写路由仍要 `x-drc-pair`）。

另加 `POST /client-report`（客户端半自报，写到 `~/.dsh/dsh-remote-control/client-report.json`）：
客户端半在宿主里没有任何可观测出口，这条把"apply 看到了什么"变成读数。
判据 685（路由 7→8 的条数与清单断言已同步）。

## 3.1.6

### DSH 0.2.1-rc.2 适配：客户端半不再赌服务名 + 走宿主 HTTP origin（2026-10-20）

用户现场：升级到 DSH 0.2.1-rc.2 后**插件让 DSH 启动不起来**；清理掉插件后设置页能渲染，
但所有宿主调用都是 `HTTP 0`（「发不出配对码」「这一版宿主没有 /config 路由」）。

**根因有两条，都在浏览器那一半：**

1. **启动崩溃**：0.2.1 的 web boot 会对**任何 pending 条目**抛
   `web boot: N entry/entries did not activate`。这一半原来声明了 `inject: ['slots']`
   （模块级）与 `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-conversation"]`（清单级）
   —— 两条都是"服务/包晚到就整页起不来"的赌注。现在**两条都撤掉**：
   `apply()` 立即激活，槽位靠 `mountPill` 的软探测 + `ctx.inject` 晚到回调补挂
   （2026-10-03 那次真机事故之后就写好的退路）。代价是可能先留一行 warn，值得——
   少一颗 pill 只是少一个入口，起不来是整台机器打不开。

2. **HTTP 0**：0.2.1 桌面版的页面挂在自定义 scheme `dsh-app://` 上，而插件路由仍在宿主
   自己的 HTTP origin 上（`/plugins/dsh-remote-control/*`）。相对路径的 `fetch` 解析成
   `dsh-app://plugins/...` ⇒ 请求根本没出门（status 0）。修法照官方前端的口径：
   `window.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI`，见新增的
   `src/client/host-url.ts`；web 形态没有那个全局 ⇒ 退回相对路径（同源，不变）。
   二维码 `<img src>` 同一条路。

判据：`tests/client-bundle.test.ts` 翻转两条旧断言（原钉"必须有 inject"），新增
桌面/ web 两种 origin 的 URL 判据；plugin 共 **686** 条。

## 3.1.5

### 落盘加固：敏感**目录**也走凭据级端口（2026-10-13 第六轮 review）

⚠️ **文档与实现分叉**：README 的「设计上的三条硬线」第 2 条写着凭据落盘一律 0600，
`status.json`、配对密钥簿、宿主身份文件、**附件目录**都走同一个落盘端口。前三项与附件的
**文件**确实走了（`writeSecure` 的五步），**目录本身没走** —— 三处都是
`mkdirSync(dir, { recursive: true })`，不带 `mode` ⇒ 用进程 umask，典型 **0755**：

- 别的本地用户能**列出**这些目录：会话 id、用户上传的文件名（文件名本身就说明了内容）；
- umask 宽松时（容器 / 自建服务常见 `UMask=0000`）目录变 **0777** ⇒ 别的本地用户能在里面
  **删/替换**文件 —— 而 `conversations-<hostId>.json` 里是**每个会话的 PSK**，
  附件路径则被写进 prompt 正文交给 Agent 读。

⇒ `secure-file.ts` 新增 `ensureSecureDir`（`SECURE_DIR_MODE = 0o700`）+ `mkdir({mode})`
**再** `chmod`（`mode` 只在创建那一刻生效，而 `recursive` 遇已存在目录直接返回 ⇒
一条 0755 的老目录永远收不紧）。三处敏感目录改走它：附件目录、配对密钥簿目录、
host-token 所在目录。

⚠️ **只收窄、不改属主已收紧过的目录**（`pair-store.test.ts` 抓到的第一版过度收紧）：
现有判据「目录只读（0500）时 save 必须优雅失败而不是抛」被第一版红了出来——它把运维
刻意设的只读**改回可写**。⇒ 规则收成：**组/他人两位上还有 1 才收**（0755/0777 → 0700），
已经只属主的（0700，含运维设的 0500）**一律不碰**。插件不该改一个自己没有设过的权限。

判据：`tests/secure-file.test.ts` +4 条（建目录 0700 / 老 0755 目录被收紧 /
三个敏感目录的创建点都走端口 / 属主收紧过的目录不许被改动）。**变异验证**：
去掉 chmod ⇒ 「老 0755 目录被收紧」那条立刻红。plugin 676 → **680** 条。

> 四个包一起 bump 到 `3.1.5`。**主体是小程序的审核整改**（见
> `packages/client/CHANGELOG.md` 的 3.1.5 一节），另含 2026-10-12 深度 review 的一批修复。

### 深度 review 补丁（2026-10-12）

- ⚠️ **自愈额度改成"按连续失败"计**（`src/index.ts`）：原来只增不减 ⇒ 一台机器跨天遇到
  第二次 `bad_token`（间隔远超冷却）就会把 5 次用尽、**被永久放弃**，而自愈要应付的
  恰恰是**会反复发生**的事（别人重建机器、令牌表裁剪、中继重部署）。现在一次 `hello-ok`
  就清空窗口。
  同时**拆成两个读数**：`diagnostics.hostToken.heals`（累计，只增不减，给运维看
  "这台被顶过吗"）与 `healFailedInRow`（这一轮连续失败，同时是额度读数）。
- ⚠️ **`hello-ok` 之后摘掉过期的 `hostToken` problem**：那几条 warn 说的是"这台主机
  现在连不上"，而走到 `hello-ok` 就证明令牌此刻能用 —— 不摘的话，用户手工换 token 之后
  一切正常，`status.json` 里却永久挂着一条假警报。
- **去掉一处重复实现**：`runtime.ts` 里有个**没人调用**的 `pendingForSession()`，而
  `cmd.get_pending` 那边内联复制了同一段筛选（注释还写着"必须逐字同判据"——两份实现
  正是它警告的事）。现在两条重放路（`cmd.get_pending` / `replayPending`）共用
  `pendingEntries()`。
- `pill/routes.ts` 的 `pairPageHandler(deps)` 不读 `deps`：**保留参数**（路由表统一工厂
  形状，判据按那个形状调用），但显式 `void deps` 并把理由写在注释里 —— 让"这个工厂
  不碰宿主状态"在代码里看得见。

> ⇒ npm 上仍是 3.1.4；这一版**要不要发**由下一次真发版时统一决定（小程序本身不发 npm）。

## 3.1.4

> 四个包一起 bump 到 `3.1.4`。**主题：把"向后兼容"整条清掉**（用户裁决：没有真实用户）。

- **认领必须带 `hostId`，且盘上那枚必须写 `hostId`**：`host-token.json` 的 `hostId`
  从可选变**必需**（缺了整份不可用，不再有"老文件照旧用"那条退路）；
  `readStoredHostToken(file, serverUrl, hostId, log)` 的身份判定从"两边都说得清才比"
  改成"不等就作废"。
- **host 身份只认自己产出的形状**：`host-id` 文件里除了 `drc-<12hex>` 之外一律换掉
  （旧写法 `h_xxxx` 不再沿用）。
- **能力位相关的接线删除**：`hello` 不再报 `capabilities`，`ev.host_info` 不再带 `caps`；
  `core/capabilities.ts` 只留"这一代内核能不能收图片"的探测（那是内核面的事实，不是版本兼容）。
- **重连重发 `ev.host_info` 的理由重写**：它现在只承载限额；不再有 `hostCaps` /
  `supportsResume()` 这套簿记。
- **打包脚本去掉上一代装法的擦屁股代码**：`pack-to-profile.mjs` 删 `LEGACY_DIR` 与
  "清掉旧直拷目录"，`install-to-profile.mjs` 不再替用户删旧的 `file:` 依赖。
- 判据：`claim-token` 的"老文件照样能用"翻成"缺 `hostId` 即不可用"；`host-id` 的
  "旧身份继续用"翻成"非本代形状一律换掉"；删掉"内核没有 `readHistory` 时不许报
  `resume`"那条（能力位没了）。

## 3.1.3

> 四个包一起 bump 到 `3.1.3`。**主题：认领时要表明身份**（配合中继侧
> 「按 hostId 一机一枚」的模型修正，起因是 2026-10-11 那次被别的机器顶下线的事故）。

- **认领请求带上 `{hostId}`**：中继据此把这枚令牌**绑到这一台**，于是别的机器认领时
  **顶不掉我们**。⚠️ 当时中继对不带 `hostId` 的认领还会落到"未绑定槽位"，
  而那条路在同一天晚间的后续改动里**已删除**（中继现在一律回 400 `host_id_required`；
  用户裁决「不需要兼容老客户端」）。
- **落盘记下 `hostId`**，并在"文件里的身份不是本机"时**当它不存在**（重新认领）。
  起因：`host-id` 文件被删/换了数据目录之后，盘上那枚属于**上一个身份**，
  拿它去连只会一直 `bad_token`，而插件有 token 就不再认领 ⇒ **永久连不上**且盘上文件看着正常。
  ⚠️ 当时为"老文件没有 `hostId` 字段"留了一条"照旧用"的退路，那条**已在 2026-10-11 晚间删除**：
  现在缺 `hostId` 的文件**整份不可用**（没有老用户，留着它只会让一个说不清归属的文件继续生效）。
- 中继回显的 `hostId` 与本机不同时留一条日志（不因此丢令牌：鉴权由中继按它记的槽位判定）。

判据 +3（`tests/claim-token.test.ts`）：请求体真的带了 hostId（且不知道身份时**不许**凭空编一个）/
落盘记下 hostId 且身份不符时作废 / 回显不符时留痕。
（"老文件照样能用"那一条判据后来**反向**了：缺 `hostId` 的文件现在整份不可用。）

## 3.1.2

> 四个包一起 bump 到 `3.1.2`。**这一版的主题是「插件装完就能用」**：
> 默认走官方中继、没有口令时启动自动认领并落盘，自部署与自定义收进设置页的进阶一栏。

- 🔴 **默认 `serverUrl` 改成 `wss://drc.provid.cc`**（原来是 `ws://127.0.0.1:8787`）。
  旧默认值只对"正好在本机跑着中继"的人成立，对下载插件的绝大多数人来说，
  它的真实含义是"配完也不通"（用户原话：下载下来发现不能用，直接就卸载了）。
  ⚠️ 随包分发的 `cordis.patch.yml` 里**刻意不再写** `serverUrl`：默认值只有一处事实源，
  两处各写一份必然漂移（那份 patch 是注入层，优先级高于默认值）。
- 🔴 **没有 host token 时，启动自动向中继认领一枚**（`POST <中继>/api/claim-token`），
  落进 `host-token.json`（0600，走 `platform/secure-file.ts` 那一条路，与 `status.json` 同目录），
  下次启动直接读盘。三条纪律都写进了判据：
  - 落盘**只走 `SecureFilePort`**（0600 + 原子写 + fsync），不新开写文件的路；
  - **形状定长校验**（48 位小写十六进制）：中继侧 `tokenMatches` 是定长比较，
    长度变了不会报错、只会让已装机的主机**静默**连不上 ⇒ 形状不对一律当失败、不落盘；
  - **认领失败不阻断启动**：载具与配对入口照常起来，只留一条 `warn:hostToken`
    与 `diagnostics.hostToken.*`（来源 / 认领结果 / 失败原因 / HTTP 状态码 / 文件名）。
    ⚠️ 盘上那枚记着"向哪台中继领的"：`serverUrl` 不同就不认它（拿旧凭据去连新中继，
    要么被拒，要么把上一台的服务器的凭据送给一台陌生的服务器）。
- **配置多出第四层**（`默认值 < 设置页写下的 < patch 注入 < 环境变量`）：设置页写下的自定义项
  落在 `user-config.json`（0600），**压在 patch 之下**——手写 patch 的人仍然说了算。
- **设置页多出「进阶：自部署 / 自定义」那一栏**（`GET|POST /plugins/dsh-remote-control/config`）：
  读当前中继地址与口令**来源**（只有脱敏形态，绝不给真值）、写自部署地址 / 自己的一枚口令、
  清除口令、恢复默认。三条行为判据：**只提交改动过的那一项**（口令框留空不许被当成"清空"）、
  保存失败要把宿主给的理由印出来（不许显示"已保存"）、状态轮询每两秒重画整页但
  **输入内容不许被抹掉**。
- 同类清理：`cordis.patch.yml` 里删掉 `approvalTimeoutSec: 180`（该键 2026-10-11 已删，
  留着只被静默忽略，而 README 又写着"没有这个键"）。

⚠️ 装机后**要重启 Harness** 才生效（换文件不热加载）；设置页那一栏改完也**重启才生效**
（中继地址与 token 是建连接时读一次的），回答里带 `restartRequired: true`。

✅ **中继已先部署**：`/api/claim-token` 随 `@dsh-remote/relay@3.1.2` 上了 ECS
（`https://drc.provid.cc/healthz` version=3.1.2；`GET /api/claim-token` → 405、
`POST` → 200 + 48 位 token、紧接着再 `POST` → 429）。顺序**必须先中继后插件**，
否则新装的插件认领会拿到 404 → 落到"没有 token" → 插件照常起来但连不上中继
（`diagnostics.hostToken.claim = failed` / `claimReason = http`）。

### 两条**仓级**修复（不进 npm 包，但同一版一起发）

- 🔴 **`release.yml` 里那一步写了两个 `run:`** —— GitHub 对重复 YAML 键是**整份拒绝**
  （`startup_failure`、0 秒、无 job、页面只写一句 `workflow file issue`）。
  于是 3.1.0 之后**三个包的自动发布全部停摆**，而症状看着像"Trusted Publishing 没配上"。
  修法：合成一个 `run: |`；判据见伞仓 `e2e/ci-gates.test.mjs` ⑨（+ ⑨b 反向）。
- **`scripts/pack-to-profile.mjs` 认不出 `DSH_PROFILE=desktop`** —— 那个环境变量
  **可能是路径、也可能是名字**（DSH 宿主自己就把名字放进环境里），当成路径会直接
  `profile not found: desktop`、装机一步都走不了。现在按
  `DSH_PROFILE_DIR` → 路径 → `~/.dsh/profiles/<名字>` 的顺序解析。

## 3.1.1

> 四个包（`protocol` / `relay` / `plugin` / `client`）一起 bump 到 `3.1.1`。
> **这一版是真修复**：审批卡、提问卡、待办三处都改成**只跟随宿主，不自己加逻辑**。

- 🔴 **审批/提问卡不再有主机侧期限**。原来 180/300 秒的上限**是插件自己加的**
  （宿主入参 `onApprovalRequest` / `onQuestionRequest` 本就不含期限字段），
  而它造成过真实故障：页面退后台 → 事件退订 → 卡帧到了 client 没到界面 →
  用户回到页面时主机早已判超时，于是"手机上点不动"。
  **现在跟随宿主的 `timeoutMs`：给了就跟随，没给就不设**（协议里 `expiresAt` 本就是可选的）。
- 🔴 **待办只转发内核发来的清单**。原来在轮次开始时若"上一轮显示过清单"就合成一帧空帧，
  而它的前提"内核不会为『这一轮没有待办』发帧"**是错的**（内核确实会发，同一条用例里就喂过
  `todos: []`）⇒ 那会造成双重清空。随它一起删掉的还有 `todoShown` 那套记账。
- 配置项 `approvalTimeoutSec` 随之删除（留着就是死配置）。
- 判据新增：形状（9 条，源码层面）与行为（1 条，两方向 × 两类卡）各一层，六处变异全部验证。

⚠️ 装机后**要重启 Harness** 才生效（换文件不热加载）。

⚠️ 重启后这样确认加载上了 —— **看顶层 `kernel` 这个键在不在**（不是看 `diagnostics` 的组数）：

```sh
python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.dsh/dsh-remote-control/status.json')));print('kernel 键数:', len(d.get('kernel') or {}))"
```

期望 `kernel 键数: 38` 左右、`kernel.attachmentFace = "commands.prompt"`。
⚠️ 我一度把这条判据说成"`diagnostics` 从 7 组变 8 组并多出 `kernel`" —— **那是错的**：
`kernel` 是**顶层键**，`diagnostics` 本来就是 7 组，两者都不随版本变。

## 3.1.0

> 四个包（`protocol` / `relay` / `plugin` / `client`）一起 bump 到 `3.1.0`。

**本包无功能改动** —— 3.0.8 那批修复（离线挂账 / 重连补推 / 工作区登记）就是当前行为。

- **发布链路换成 npm Trusted Publishing（OIDC）**：新增 `.github/workflows/release.yml`，
  打 `v*` tag 即发。没有 `NPM_TOKEN`、没有长期凭据 —— GitHub 签一个 OIDC token，npm 核对
  「这次运行确实是本仓、本工作流」之后发一个短时发布 token。
  `publishConfig.provenance` 随之打开 ⇒ **从这一版起 npm 上有供应链溯源**（v3.0.x 各版都没有）。
- **修 `repository` / `homepage` / `bugs`**：一直指向 `dsh-remote/dsh-remote-<包名>`（**不存在**），
  实际仓名是 `dsh-remote/<包名>` ⇒ npm 包页的仓库链接此前是 404。

## 3.0.0

> 3.0.1 ~ 3.0.8 是 v3 上线前后的迭代版本（都已发到 npm），逐版记录在伞仓
> [`docs/RELEASE.md`](https://github.com/linbin/dsh-remote-v3) 的「已发布记录」。
> 这一节只保留 3.0.0 当时的内容。

- v3：四端合并进 `dsh-remote-v3` 单仓开发；包名由 `dsh-remote-control` 迁到 **`@dsh-remote/plugin`**，
  仓库改到 [`dsh-remote/dsh-remote-plugin`](https://github.com/dsh-remote/dsh-remote-plugin)。
  运行时标识 `dsh-remote-control` **保持不变**（路由前缀、数据目录、profile 安装名）——那是有意的稳定标识。
- **PathsPort**（`src/platform/paths.ts`）：绝对路径判定 / 数据目录派生 / 工作区形状判定收成一处。
  修 v2 三处分叉——`config.ts` 两条 `startsWith('/')` 在 Windows 上把 `C:\` 路径**静默改道**；
  校验把正确的 `C:\` 配置报成「必须是绝对路径」；`carrier-services` 只收 POSIX 形态。
  判定带 `platform` 参数 ⇒ **在 macOS 上就能验 win32 行为**（15 形态 × 3 平台表驱动）。
- **SecureFilePort**（`src/platform/secure-file.ts`）：5 处 0600 落盘收敛为一处；补上 v2 只在 relay
  做了的「清同 pid 残留」；win32 上 `chmod` 只切只读位 ⇒ **显式 warn 一次**而不是假装生效；
  `safeFileName` 补 Windows 保留名（`CON` / `con.txt`）——此前会让**整批附件回滚**。
- **审批「本次会话内始终允许」**（§9.1）：查表放在挂 waterfall **之前**（放在之后就只是记账），
  键取「会话 + 类别」，随 `stop()` 清空。直接服务 30 秒原则。
- **浏览器半** `client/src` → `src/client`（消除第二个源码根），两个编译面各自自包含。
- **配对地址只有一处事实源**：二维码 `s=` 逐字等于 `serverUrl`（判据），小程序侧没有手填入口；
  死文案「请先扫码或**填写**中继服务地址」清零。
- **设计语义映射**（`docs/DESIGN-TOKENS.md`）：pill 的 7 个 fallback 色值从 CSS 里 18 处字面量
  收成一处（顺带修掉一个没人报的不一致：`label-secondary` 原来有两个兜底值）。
- 脚本去 shell 化：`install-to-profile.sh` → `.mjs`（`lastIndexOf('/')` 在 Windows 上得 -1，
  会把备份写到当前目录，而那文件带 hostToken）。
- 判据 524 → 562。

2.0.21 及更早的完整历史见 npm 版本页（旧仓已于 2026-10-20 删除，发布物仍在）：
[`dsh-remote-control` 的历史版本](https://www.npmjs.com/package/dsh-remote-control?activeTab=versions)。
