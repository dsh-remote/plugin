# 小程序设计说明

本文讲**为什么这么做**，不讲"做了什么"——后者读代码即可。这里只留下那些"偏离显而易见的做法、
原因又不在代码里可见"的决定。路径一律相对 `miniprogram/`（下称"小程序根"）。

## 技术选型

- **原生小程序**，不引框架。启动开销与包体积是小程序最贵的东西，一套运行时换不来等价收益。
- UI 组件用 **TDesign**（腾讯开源）。`miniprogram_npm/tdesign-miniprogram/` 里是**按依赖闭包裁剪过的
  预构建产物**（约 1.5 MB，含内嵌 tslib），所以**不需要在开发者工具里构建 npm**。
  升级 TDesign：`npm i tdesign-miniprogram@latest`，再把
  `node_modules/tdesign-miniprogram/miniprogram_dist/` 里用到的目录拷过来
  （保留 `common/ mixins/ transition/ locale/ config-provider/` 与内嵌的 tslib）。
  `node_modules/` 已在 `packOptions.ignore` 里，不会打进包。
- 加密用 **vendored tweetnacl**（`core/vendor/nacl-fast.js`），UTF-8/base64 用 **vendored js-base64**
  （`core/vendor/js-base64.js`）。不自己造轮子。

## 按需注入 / 用时注入

小程序启动耗时的大头有两块：**代码包下载**与**代码注入执行**。下面两项只治后一块，**对包体积零影响**——
所以别拿上传时的体积数字判断"开了没生效"，它永远不变。

**按需注入**（`app.json`）：

```json
{ "lazyCodeLoading": "requiredComponents" }
```

不开的话，主包里**所有** JS 会在启动时合并注入并立刻执行——包括还没访问的页面、当前页根本没声明的
自定义组件。TDesign 那上百个组件 JS 全都要跑一遍，而 sessions 页其实只用得到 3 个。

配套要求（**别破坏**）：`app.json` 不声明全局 `usingComponents`；每页 `usingComponents`
只写这一页真正用到的组件。`scripts/verify-miniprogram.mjs` 会机械地守住这两条。

**用时注入**（`pages/sessions/sessions.json`）：

```json
{ "componentPlaceholder": { "t-empty": "view" } }
```

在开了按需注入的前提下，给组件配占位组件的效果是：**第一次真正渲染它之前不注入**。
`t-empty` 只在「已配对但零会话」时出现，首页常态路径（有会话）下它永不注入。

**为什么只配 `t-empty`**：占位是异步替换的，配在首屏就渲染的控件上（`t-switch`、`t-button`）
只会让控件晚一拍出现，用户看得见抖动。只有 `t-empty` 满足"条件渲染 + 不在首屏主路径 + 非交互控件"。

## 主题：浅色（默认）/ 深色

**默认浅色**，在会话列表页底部可手动切深色。**不跟随系统**——系统是深色时默认仍是浅色；
用户切过之后即使系统变了也保持他选的那个。

### 三份样式表的分工与顺序

```css
/* app.wxss —— 顺序是语义的一部分，不能换 */
@import './miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss';
@import './theme/light.wxss';   /* 浅色（默认），无条件生效 */
@import './theme/dark.wxss';    /* 深色，挂在 .theme-dark 上；必须在 light 之后 */
```

TDesign 把浅色与深色**两套变量都包在 `@media (prefers-color-scheme)` 里**，跟随系统。
本项目要手动切，所以两套都得能脱离 `@media` 独立生效：

| 表 | 选择器 | 何时生效 |
| --- | --- | --- |
| `theme/light.wxss` | `.page,page`（与 TDesign 相同） | **始终**。同时靠"同特异性下源码顺序靠后的胜出"压掉 `_index.wxss` 的深色分支 |
| `theme/dark.wxss` | `.theme-dark,.theme-dark page` | 页面根容器带 `theme-dark` class 时 |

**为什么深色必须挂 class**：两套都写 `page` 就只能靠源码顺序决胜，那是**单向**的——压得住深色、
切不回浅色。挂 class 之后"用不用深色"由根容器的 class 说了算，与系统深色无关。

### 切换时必须一并改的三个地方

`core/theme.js` 的 `toggle()` 三件事都做，缺一件就是"切了但没切干净"：

1. **页面根容器加 `theme-dark` class**——变量挂在这个 class 上，靠继承铺满整页。必须挂在**根 view**
   （`sessions` 的 `.page-pad`、`chat` 的 `.chat-wrap`）上，挂在子树深处只能染到那一小片。
2. **导航栏** `wx.setNavigationBarColor`——原生组件，不吃 CSS 变量。不改编则深色页面上方留一条白顶栏。
3. **下拉回弹区** `wx.setBackgroundColor`——iOS 往下拉会露出来，深色下是刺眼的白。

另外 `.page-pad` 必须自带 `background` + `min-height: 100%`：`page` 元素自己永远是浅色，
根容器不铺满、不画底色的话，深色下会从下边缘透出一条浅色带。

### 生成物

`theme/light.wxss` 与 `theme/dark.wxss` 是本仓 `scripts/gen-mp-theme.mjs` 的**生成物，不要手改**
（`npm run theme` 重新生成，`npm run theme:check` 在 CI 里发现"忘了重新生成"）。
脚本会做**变量覆盖对账**：浅色定义过而深色没有的变量会直接报错退出（已知 `--td-shadow-4`
与 `--td-scrollbar-hover-color` 只在浅色分支有，脚本用 `DARK_ONLY_FIXUPS` 补齐；不补的话深色下
会继承到浅色值，表现为"深色里有一块浅色阴影"）。

验证手法（改 import 顺序后值得再跑）：把生成物里某个变量临时改成 `#ff0000` 再截图，
页面底色**必须**跟着变红——变了才证明覆盖真的赢过了 `_index.wxss`。改完记得重新生成。

## chat 页：文档流，不是气泡流

五种块：`turn` 轮次分隔 / `user` 你的指令 / `steps` 步骤组 / `text` 回复正文 / `note` 系统提示。

### 过程默认不显示（`SHOW_STEPS = false`）

**手机上要看的是结论，不是过程。** 所以 `steps` 块默认**不渲染**，顶栏用一行「思考中…」表达"它还在动"。

**数据照样落块。** 这两件事必须分开：

| | 决定什么 | 在哪 |
| --- | --- | --- |
| 「记不记」 | 数据层：步骤组、参数/结果帧、按 callId 去重 | `_applyTool` / `_decorate` |
| 「显不显示」 | 渲染层：wxml 的 `showSteps` + 顶栏按钮 | `chat.js` 的 `SHOW_STEPS` |

删掉落块逻辑会连带坏掉三件事：① 审批要知道主机正在调什么；② 收尾帧要靠 `callId` 找到原来那条并
更新它（找不到就退化成新开一组，一次调用出现两行）；③ 历史回放靠 `callId` 对齐，错了正文会插到错误位置。

### 步骤组（`showSteps` 打开时）

一轮里模型「想 → 调工具 → 再想 → 再调」的过程被聚成**一条**，界面上就是「已完成 3 个步骤」一行。
不聚合的话，一轮调 6 次工具就是 12 个块，用户要翻 6 屏才读到那句结论。

- 组内条目按时间序排，两种：`think`（只有阶段与耗时）与 `tool`（可展开看参数与完整结果）。
- **实时新开的组默认展开，历史回放的默认收起**。收起时只有一行"正在执行 1 个步骤"，用户会以为
  **根本没有工具列表**——而那正是他此刻最想看的。历史那一侧必须反过来：一屏全是过程就没法读正文了。
- **过程窗口限高 + 组内自己滚**：`.steps-scroll` 是 `max-height: 44vh` 的 `scroll-view`，
  `scroll-into-view` 指向组尾那一条。展开一个跑了 6 步的组不该把正文顶出屏幕——这一页的主体是正文。
  两个细节：① `tailId` **只给还在跑的组**，否则用户回看老组时每来一条新内容就被拽回组尾；
  ② 必须用 `scroll-view`——小程序里 `view` 的 CSS `overflow: auto` 在**真机上不生效**
  （开发者工具里可能"看起来能滚"），写成 CSS 滚动等于真机根本不动。
- **封口**：一旦有正文 / 轮次 / 指令出现，这一组就 `closed`，之后新的工具调用必须另起一组。
- 组的展示字段（`label` / `tools` / `live`）统一派生，渲染层只管取，不在 wxml 里现算。
  **「还在跑」只看组内有没有未完成的条目**，不看全局 `running`，否则早已封口的老组也会跟着显示"正在执行"。

### ⚠️ 隐藏一块渲染分支只能用独立 `wx:if`

wxml 的规则是：`wx:elif` 条件为假会**落到后面的 `wx:else`**，而不是什么都不渲染。
所以「用 `wx:elif` 加条件把某一支关掉」的结果是：那一支被末尾的 else 接手——隐藏过程块时每个步骤组
都变成一个**空的提示条**，过程没显示，反而多出一排空行。

正确写法：被条件关掉的那一支用**独立的 `wx:if`**，并且末尾的 `note` 分支要写明
`wx:if="{{item.kind === 'note'}}"`，不要留裸 `wx:else` 接住所有没匹配上的块。

## 打开会话时读到主机上的历史

点进一条会话，**主机上已有的内容会被读进来**（不是只有本地内存里从这一刻起的事件）。链路三段：

```
mp:     client.loadHistory(sessionId, {beforeSeq?})   →  cmd.session_history
        ↑ 按 cmdId 配一个 waiter（不是广播：只有发起的那次请求会收到回执）
plugin: runtime.handleCommand → kernel.readHistory(sessionId, {beforeSeq, limit:40})
        ↑ 拿**整份**日志，切片在内存里做；内核事件 → 线格式条目（按 seq 升序）
mp:     chat._replayPage() → 走**与实时流同一套**落块函数
```

几个刻意的选择，每条都对应一种"历史看起来怪"的缺陷：

- **一页里的条目与实时流同构**（`ev.message_delta` / `ev.tool_event`），所以回放复用
  `_applyText` / `_applyTool`，不写第二套渲染规则。两份实现分叉的表现是"实时看着对、历史看着怪"。
- **只有游标，没有 `hasMore`**：`nextBeforeSeq` 在 = 还有更早的一页。用两个字段表达同一件事会造出
  "说还有、却没给游标"这种自相矛盾的载荷，表现是「加载更早」点了没反应且没有任何报错。
- **游标由主机给**：一条内核事件可能折成 0/1/2 条线格式条目，小程序既不知道折叠规则也不该知道，
  按条数自己推算迟早会跳过或重发一段。
- **回放不带 `ev.run_state`**：运行态是"此刻"的事，回放历史不该去改顶栏。
- **回放不补「思考中」段**：历史里每一步都已经结束了，往回插一条还在走秒的思考段，
  屏幕上会出现一排永远走不完的秒数。
- **去重要分清两种重复**：同一页里同一次工具调用本来就有「参数」「收尾」两条事件、同一条消息也可能
  有多条 delta。去重只该针对**实时已经渲染过、历史里又来一遍**。文本/工具按 id 对齐；
  用户消息没有可对齐的 id（本地回显是即时造的块），退化成按文本**多重集消耗**。
- **结算点只有一个**：`loadHistory` 里的 `done()` 既是"收到回帧"的出口、也是"超时"的出口，
  靠 `if (!self._historyWaiters[cmdId]) return` 做幂等。因此**谁都不许抢先把登记删掉**——
  否则这道守卫永远命中：promise 既不 resolve 也不 reject，**连 15s 超时那条路也一起被吃掉**，
  表现就是「正在读取主机上的历史…」一直转。这个 bug 真发生过一次，且两头的测试都看不见它。
- **往前插内容不许自动跟底**：用锚点把用户刚读到的那一块滚回视口，否则页面会原地跳动。
- **滚动锚点必须是两个静态 id**（`anchor-a` + `anchor-b`，靠翻转 `scroll-into-view` 在两者之间指）。
  曾经写成 `<view id="{{toView}}">`——同一个元素跟着 `toView` 改名。那要赌"元素改名"与
  "`scroll-into-view` 生效"谁先落到渲染层上，赌输了 scroll-view 就查不到目标节点、**静默不滚**。

界面上「历史读取」有四种状态，必须长得不一样：`loading` / `ok`（还有更早时给一个可点的「加载更早」）/
`error`（可点重试）/ 空。**把"读不到"渲染成"这个会话没内容"是在给用户一个假事实**。
主机那一代内核没有 `readSession` 时，插件**明确拒绝**（"主机这一代不支持读取历史"），不返回空页。

## 握手流程

```
hello{role:'client'}  →  hello-ok
pair-begin-client{token}  →  paired{hostId, sessionId}
kC2H = derivePskKey(psk,'c2h',sessionId)   // 小程序 → 主机
kH2C = derivePskKey(psk,'h2c',sessionId)   // 主机 → 小程序
之后所有业务数据都是 { t:'enc', sessionId, seq, ciphertext }
```

字节级契约由 [`dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol) 冻结。

## 为什么 `nacl-fast.js` 被改过

上游 tweetnacl 末尾会探测 `require('crypto')` 来初始化 PRNG。小程序里 `require` 存在但没有
`crypto` 模块，这行会在**加载时**直接抛错、整个文件挂掉。

所以把 PRNG 初始化改成只认全局 CSPRNG（`self.crypto` / `globalThis.crypto`），**并且不提供
`Math.random()` 兜底**：

- 客户端永远用不到 `randomBytes`：nonce 是计数器，密钥来自配对 PSK；
- 如果哪天误用了，宁可抛错，也不要悄悄用弱随机。

## 配色：先算对比度，别靠看截图

**TDesign 的深色值不能直接拿来用**——它是给大屏 Web 调的，手机屏字号更小、底色更深，
几个变量真机上明显偏暗。实测 238 组前景/背景里 **45 组不达标**，`placeholder` 压卡片底只有 3.16:1。

`scripts/check-mp-contrast.mjs`（`npm run contrast`）会展开两套变量表、算真实的前景/背景、
按 WCAG 判阈值（正文 4.5，大字与图形 3），调整后的值与实测前后对比写在
`scripts/gen-mp-theme.mjs` 的 `DARK_READABILITY` / `LIGHT_READABILITY` 两张表里。
**改任何颜色前先跑它**。

**一个颜色变量不要同时当前景和背景用。** `--td-brand-color` 就同时扛两个互斥角色：当**底色**
（用户气泡、`t-button--primary`）要够暗才压得住白字；当**字色**要够亮——这两条**数学上无解**
（需亮度 ≤0.163 与 ≥0.304）。所以另有 `--td-brand-color-on-tint` 专管"压在品牌浅底上的字色"。
**做法：先算出两个角色各自的可行区间，无解就拆变量，别找折中值。**

## 环境兼容：`wx.connectSocket is not a function`

某些运行环境（尤其第三方预览容器）压根不提供 `connectSocket`，这时任何配对尝试都会以一句
TypeError 告终，用户既不知道缺什么也不知道怎么办。

`core/env.js` 会先探测能力，`core/socket.js` 按探测结果走两条路：

1. **SocketTask**（基础库 1.7.0+）：`connectSocket()` 返回带 `onOpen/onMessage` 的任务对象；
2. **旧式全局回调**：`onSocketOpen/onSocketMessage/...`（全局监听器只绑一次，避免叠加）。

两条路都没有时，**如实上报「环境缺能力」并停止重连**，配对页显示一行可复制的环境自检。
这类容器里远程控制在原理上无法工作——需要换成微信开发者工具，或用自己的 AppID 真机调试。

## 常见故障

| 现象 | 原因 |
| --- | --- |
| 一直「连接中」 | 服务地址不对 / 中继没起 / 真机用了 `ws://` |
| `配对失败：配对码无效或已过期` | 超过 TTL（默认 120s），让主机重新 `/drc pair` |
| `配对失败：配对码已被使用` | 一次配对码只能用一次，重新生成一个 |
| `配对失败：主机不在线` | host 插件没连上中继，检查它的 `DRC_HOST_TOKEN` 与日志 |
| `收到无法解密的数据` | PSK 不对（换了配对但客户端还留着旧 PSK）——解除配对重扫 |
| 会话列表一直为空 | host 的 `carrier=mock`（内核桥接没挂上），或真的没有会话 |
| 真机连不上 | 域名白名单 + 必须 `wss://` |

## 还没做

- 图片/文件附件（`cmd.send_prompt.attachments` 协议里有字段，UI 没做）
- 多主机切换（现在是单配对，重新配对会覆盖）
- 消息历史的**本地**持久化：小程序自己的存储里不留消息，每次打开会话都从主机读一页。
  离线看历史、或主机上那条会话被删掉之后回看，都还做不到
- 无 WebSocket 的容器下没有替代传输（协议是 WS-only，不打算再造一套）
