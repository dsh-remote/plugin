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
  theme/light.wxss                 浅色变量（默认，生成物）
  theme/dark.wxss                  深色变量（挂在 .theme-dark class 上，生成物）
  miniprogram_npm/tdesign-miniprogram/   裁剪版 TDesign（开源 UI 组件库）
  core/
    vendor/
      nacl-fast.js      vendored tweetnacl（已打小程序补丁，见下）
      js-base64.js      vendored js-base64（MIT）：UTF-8 + base64
    codec.js            线格式编解码：KDF/seal/open/计数器 nonce/QR 解析
    env.js              运行环境能力探测 + 一行可复制的环境自检
    socket.js           wx.connectSocket 封装：双路径 + 超时 + 指数退避重连
    session-store.js    wx.setStorageSync 持久化（PSK / 会话 id / nonce 计数器）
    theme.js            主题：读存储、切 class、改导航栏与回弹区配色
    client.js           客户端核心：握手、配对、指令、事件分发（DrcClient）
    package.json        仅用于把该目录标记为 CommonJS（Node 侧测试用）
  pages/
    sessions/  入口页：未配对时**就地扫码配对**；已配对是主机状态 + 防休眠 + 会话列表
    chat/      对话：文档流 + 流式正文 + 审批卡、提问卡、中断（过程块默认不渲染）
```

**只有两页。** 配对曾经是独立的 `pages/pair/`，后来按「首页直接扫码」删掉了 ——
配对是打开 app 最可能要做的事，多一次跳转就多一次"我到底该去哪"。
扫码/粘贴/6 位配对码/环境自检全部内联在 `sessions` 页：

- **未配对态**只有一个主动作「扫描主机二维码」，扫完即连（不跳页）；
  手动输入（粘贴 / 6 位码）收在「手动输入」折叠区里。
- **已配对态**底部是「重新配对 / 解除配对 / 深浅切换」—— 配对页删掉之后，
  这里是换主机和解除配对的**唯一**入口，不能省。
- 状态切换靠 `data.paired` 走 `wx:if` 分支：连上后 `_onEvent` 收到 `status: online`
  就 `setData({paired: true})`，界面自己换过去，不需要任何导航。

## 主题：浅色（默认）/ 深色

**默认浅色**，在会话列表页底部可手动切到深色。**不跟随系统** —— 系统是深色时默认仍是浅色，
用户切过之后即使系统变了也保持他选的那个。

### 三份样式表的分工与顺序

```css
/* app.wxss —— 顺序是语义的一部分，不能换 */
@import './miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss';
@import './theme/light.wxss';   /* 浅色（默认），无条件生效 */
@import './theme/dark.wxss';    /* 深色，挂在 .theme-dark 上；必须在 light 之后 */
```

TDesign 把浅色和深色**两套变量都包在 `@media (prefers-color-scheme)` 里**，跟随系统。
本项目要手动切，所以两套都得能脱离 `@media` 独立生效：

| 表 | 选择器 | 何时生效 |
|---|---|---|
| `light.wxss` | `.page,page`（与 TDesign 相同） | **始终**。同时靠「同特异性下源码顺序靠后的胜出」压掉 `_index.wxss` 里的深色分支 |
| `dark.wxss` | `.theme-dark,.theme-dark page` | 页面根容器带 `theme-dark` class 时 |

**为什么深色必须挂 class、不能继续用 `page`**：之前"固定浅色"就是靠 import 顺序压掉深色，
但那是**单向**的 —— 压得住深色、切不回浅色。两套都写 `page` 就只能靠源码顺序决胜。
挂 class 之后"用不用深色"由根容器的 class 说了算，与系统深色无关（这才是"用户手动切"）。

### 切换时必须一并改的三个地方

`core/theme.js` 的 `toggle()` 三件事都做，缺一件就是"切了但没切干净"：

1. **页面根容器加 `theme-dark` class** —— 变量挂在这个 class 上，靠继承铺满整页。
   必须挂在**根 view**（`sessions` 的 `.page-pad`、`chat` 的 `.chat-wrap`）上：
   挂在子树深处只能染到那一小片。
2. **导航栏** `wx.setNavigationBarColor` —— 原生组件，不吃 CSS 变量，也不受 `page` 上的
   变量影响。不改的话深色页面上方留一条白顶栏。
3. **下拉回弹区** `wx.setBackgroundColor` —— iOS 往下拉会露出来，深色下是刺眼的白。

另外 `.page-pad` 必须自带 `background` + `min-height: 100%`：`page` 元素自己永远是浅色
（浅色表写在 `.page,page` 上，那是默认态），根容器不铺满、不画底色的话，深色下会从下边缘
透出一条浅色带。

### 生成物

`theme/light.wxss` 与 `theme/dark.wxss` **都是 `node dsh-remote-mp/scripts/gen-mp-theme.mjs` 的生成物，
不要手改**（`pnpm mp:theme`，`--check` 在 CI 里发现"忘了重新生成"）。

脚本会做**变量覆盖对账**：浅色定义过、而深色没有的变量会直接报错退出。已知有两处 ——
`--td-shadow-4` 与 `--td-scrollbar-hover-color` 只在浅色分支里有（136 vs 140），
脚本用 `DARK_ONLY_FIXUPS` 补齐。不补的话深色下会继承到浅色值，表现为"深色里有一块浅色阴影"。

验证手法（改 import 顺序后值得再跑）：把生成物里某个变量临时改成 `#ff0000` 再截图，
页面底色**必须**跟着变红 —— 变了才证明覆盖真的赢过了 `_index.wxss`。改完记得重新生成。

### 护栏

- `e2e/mp-theme.test.mjs`（`pnpm -C e2e test:mp-theme`）：默认浅色、双向可切、跨启动保留、
  不认识的值归浅色、切了要同时改导航栏与回弹区、老基础库缺 API 不炸、存不下要如实报。
- `scripts/check-mp-ui.mjs` 的第 ⑥ 项：import 顺序、生成物选择器、**每页根容器都有
  `{{themeClass}}`**、每页 `onLoad` 都调 `theme.applyTo(this)`、默认值为 `light`。
  这些都是"接错一环就整页失效"且**全静默**的地方（深色没生效时页面照样渲染，
  只露着浅色，小屏上很容易看漏）。

## 代码注入优化（按需注入 / 用时注入）

小程序启动时的耗时大头有两块：**代码包下载**和**代码注入执行**。下面这两个配置
只治后一块，**对包体积零影响** —— 所以别拿 `pnpm mp:upload` 的体积数字判断
"开了没生效"，它永远不变。要看得用 `pnpm mp:lazyload`。

**按需注入**（`app.json`）：

```json
{ "lazyCodeLoading": "requiredComponents" }
```

不开的话，主包里**所有** JS 会在启动时合并注入并立刻执行 —— 包括还没访问的
页面、当前页根本没声明的自定义组件。本项目原本 TDesign 那 112 个组件 JS
（132 KB）全都要跑一遍，而 sessions 页其实只用得到 6 个。

配套要求（已经满足，别破坏）：`app.json` 不声明全局 `usingComponents`；
每页 `usingComponents` 只写这一页真正用到的组件。

**用时注入**（`pages/sessions/sessions.json`）：

```json
{ "componentPlaceholder": { "t-empty": "view" } }
```

在开了按需注入的前提下，给组件配占位组件的效果是：**第一次真正渲染它之前不注入**。
`t-empty` 只在「已配对但零会话」时出现，首页常态路径（有会话）下它永不注入；
真要显示时先渲染成占位的内置 `view`，注入完成后自动替换回组件。

**为什么只配 `t-empty`**：占位是异步替换的，配在首屏就渲染的控件上（`t-switch`、
`t-button`）只会让控件晚一拍出现，用户看得见抖动。目前只有 `t-empty` 满足
"条件渲染 + 不在首屏主路径 + 非交互控件" 这三个条件。

生效后的注入面（`pnpm mp:lazyload`）：

| | 注入 JS |
|---|---|
| 关闭按需注入 | 281.2 KB / 123 个 |
| 开启后进入 sessions | 116.1 KB（首屏 111.9 KB） |
| 开启后进入 chat | 132.4 KB |

**改完必须验证**：官方明确要求"修改配置后务必确认小程序表现正常"。
`pnpm mp:shots` 现在会顺带捕获运行时 `exception` 和 `console.error`
（占位组件替换失败、组件未声明这类错误截图看不出来），有错就以非零码退出。
`scripts/mp-shots.mjs` 里的 `sessions-empty-early` 用例就是专门盯占位替换的。

## chat 页：文档流，不是气泡流

五种块：`turn` 轮次分隔 / `user` 你的指令 / `steps` 步骤组 / `text` 回复正文 / `note` 系统提示。

### 过程默认不显示（`SHOW_STEPS = false`）

**手机上要看的是结论，不是过程。** 所以 `steps` 块默认**不渲染**，顶栏用一行
「思考中…」表达"它还在动"。

**数据照样落块。** 这两件事必须分开：

| | 决定什么 | 在哪 |
|---|---|---|
| 「记不记」 | 数据层：步骤组、参数/结果帧、按 callId 去重 | `_applyTool` / `_decorate` |
| 「显不显示」 | 渲染层：wxml 的 `showSteps` + 顶栏按钮 | `chat.js` 的 `SHOW_STEPS` |

删掉落块逻辑会连带坏掉三件事：① 审批要知道主机正在调什么；② 收尾帧要靠 `callId`
找到原来那条并更新它（找不到就退化成新开一组，一次调用出现两行）；③ 历史回放靠
`callId` 对齐，错了正文会插到错误位置。

要临时看过程：把 `SHOW_STEPS` 改回 `true`，wxml、顶栏按钮、截图与探针会一起回来。
下面这些规则在开关打开时仍然全部成立，所以继续有人守。

### 步骤组（`showSteps` 打开时的行为）

一轮里模型「想 → 调工具 → 再想 → 再调」的过程被聚成**一条**，
界面上就是「已完成 3 个步骤」一行，点开才看得到每条细节。不聚合的话，一轮调 6 次工具
就是 12 个块，用户要翻 6 屏才读到那句结论。

- 组内条目按时间序排，两种：`think`（只有阶段与耗时）和 `tool`（可展开看参数与完整结果）。
- **实时新开的组默认展开，历史回放的默认收起**（`_stepsPush(blocks, item, forceOpen)`）。
  收起时只有一行"正在执行 1 个步骤"，用户会以为**根本没有工具列表** —— 而那正是他此刻
  最想看的东西。历史那一侧必须反过来：一屏全是过程就没法读正文了。`allowThink` 这个
  既有的"实时 or 历史"开关正好复用成 `forceOpen`，不再多引一个参数。
- **过程窗口限高 + 组内自己滚**：`.steps-scroll` 是 `max-height: 44vh` 的 `scroll-view`，
  `scroll-into-view` 指向组尾那一条（`id="s{{it.key}}"`）。展开一个跑了 6 步的组不该把
  正文顶出屏幕 —— 这一页的主体是正文，过程不该赢。
  两个细节：① `tailId` **只给还在跑的组**，跑完的组不给，否则用户回看老组时每来一条
  新内容就被拽回组尾；② 必须用 `scroll-view`，小程序里 `view` 的 CSS `overflow: auto`
  在**真机上不生效**（开发者工具里可能"看起来能滚"），写成 CSS 滚动等于真机根本不动。
- **组的开合**（`onToggleSteps`）与**某一步的开合**（`onToggleTool`）是两个层级；顶栏的
  「展开过程」是全局开关，管的是历史组与一键全开全关，不改变"实时组默认展开"这条。
- **封口**：一旦有正文 / 轮次 / 指令出现，这一组就 `closed`，之后新的工具调用必须另起一组
  （`_sealSteps`）。漏了这条会把新调用插进上一段已经读完的过程里 —— 有测试锁着。
- 组的展示字段（`label` / `tools` / `live`）在 `_commit` 里由 `decorateSteps()` 统一派生，
  渲染层只管取，不在 wxml 里现算。**「还在跑」只看组内有没有未完成的条目**，不看全局
  `running`，否则前面那些早已封口的老组也会跟着显示"正在执行"。
- 空块流时**不补**「思考中」：那一轮还没开始，状态由顶栏表达，凭空冒出一条反而落单。

### ⚠️ 隐藏一块渲染分支只能用独立 `wx:if`

wxml 的规则是：`wx:elif` 条件为假会**落到后面的 `wx:else`**，而不是什么都不渲染。
所以「用 `wx:elif` 加条件把某一支关掉」的结果是：那一支被末尾的 else 接手 ——
隐藏过程块时每个步骤组都变成一个**空的提示条**，过程没显示，反而多出一排空行。

正确写法：被条件关掉的那一支用**独立的 `wx:if`**，并且末尾的 `note` 分支要写明
`wx:if="{{item.kind === 'note'}}"`，不要留裸 `wx:else` 接住所有没匹配上的块。

`pnpm check:mp-ui` 第 ⑧ 项盯这个组合（带逻辑运算的 `wx:elif` + 兜底 `wx:else`）。
注意**不能**误报正当写法：多分支互斥链（`loading`/`error`/`hasMore`/`ok`，末尾无 else）
与二元 else（`think`/`tool`、`pasteText`/粘贴）都是对的。判据写第一版时误报了三处，
反证时才发现。

「思考」的时长是**推断**出来的 —— 它从出现到下一条内容之间的间隔。协议里没有"思考开始了"
这种事件，「思考」正文更是按 M28 红线根本不出站（见上）。

`e2e/mp-chat-blocks.test.mjs`（22 项）锁着这些时序，改块流一定要跑。

## 打开会话时读到主机上的历史

点进一条会话，**主机上已有的内容会被读进来**（不是只有本地内存里从这一刻起的事件）。
链路是三段：

```
mp: client.loadHistory(sessionId, {beforeSeq?})   →  cmd.session_history
     ↑ 按 cmdId 配一个 waiter（不是广播：只有发起的那一次请求会收到回执）
plugin: runtime.handleCommand → kernel.readHistory(sessionId, {beforeSeq, limit:40})
     ↑ sessionQuery.readSession() 拿**整份**日志，切片在内存里做
     ↑ historyPageFromLog()：内核事件 → 线格式条目（按 seq 升序）
mp: chat._replayPage() → 走**与实时流同一套**落块函数
```

几个刻意的选择，每一条都对应一种"历史看起来怪"的缺陷：

- **一页里条目的 `t` 与实时流同构**（`ev.message_delta` / `ev.tool_event`），
  所以回放复用的是 `_applyText` / `_applyTool`，不写第二套渲染规则。
  两份实现分叉的表现是"实时看着对、历史看着怪"，靠肉眼很难发现。
- **只有游标，没有 `hasMore`**：`nextBeforeSeq` 在 = 还有更早的一页，不在 = 到底了。
  用两个字段表达同一件事就会造出"说还有、却没给游标"这种自相矛盾的载荷，
  而它的表现是——手机上「加载更早」点了没反应，且没有任何报错。一个字段没有这个状态。
- **游标由主机给**：一条内核事件可能折成 0/1/2 条线格式条目（`assistant/message`
  常常只有 `reasoning`，正文是空的 → 折成 0 条），小程序既不知道折叠规则也不该知道，
  按条数自己推算迟早会跳过或重发一段。
- **回放不带 `ev.run_state`**：运行态是"此刻"的事，回放历史不该去改顶栏。
- **回放不补「思考中」段**：历史里每一步都已经结束了，往回插一条还在走秒的思考段，
  屏幕上会出现一排永远走不完的秒数。落块函数多一个 `allowThink` 开关就是为这件事。
- **去重要分清两种重复**：同一页里同一次工具调用本来就有「参数」「收尾」两条事件、
  同一条消息也可能有多条 delta，把它们当成重复丢掉的表现是"工具永远停在正在执行、
  结果预览是空的"。去重只该针对**实时已经渲染过、历史里又来一遍**。
  文本/工具按 id 对齐（协议保证两条路径算出的 `messageId` 逐字相同），
  用户消息没有可对齐的 id（本地回显是即时造的块），退化成按文本**多重集消耗**——
  判相等会把更早那一页里重复的那句「继续」也一起吞掉。
- **结算点只有一个**：`loadHistory` 里的 `done()` 既是"收到回帧"的出口、也是"超时"的出口，
  它靠 `if (!self._historyWaiters[cmdId]) return` 做幂等。因此**谁都不许抢先把登记删掉**——
  收帧那边顺手 `delete` 一下，或者断线结算时"先把表换成空的、再挨个回调"，都会让这道守卫
  永远命中：promise 既不 resolve 也不 reject，**连 15s 超时那条路也一起被吃掉**，
  并且没有任何报错。表现就是「正在读取主机上的历史…」一直转、或「加载更早」点了没反应。
  这个 bug 真发生过一次，而且两头的测试都看不见它（页面测试用的是桩 client，
  闭环测试当时一条历史用例都没有）—— 现在由 `e2e/mp-client.test.mjs` 第 11/12 条按住。
- **往前插内容不许自动跟底**：用锚点把用户刚读到的那一块滚回视口，否则页面会原地跳动。
- **滚动锚点必须是两个静态 id**（`id="anchor-a"` + `id="anchor-b"`，靠翻转
  `scroll-into-view` 在两者之间指，两个都在内容末尾所以指哪个都是"到底"）。
  曾经写成 `<view id="{{toView}}">` —— 同一个元素跟着 `toView` 改名。那要赌"元素改名"与
  "`scroll-into-view` 生效"谁先落到渲染层上，赌输了 scroll-view 就查不到目标节点、
  **静默不滚**（不报错、不重试），表现就是「回到最新」点了没反应。
  这个 bug 截图看不见、页面单测也看不见（它读 `data.toView`，逻辑层完全正确，
  反证时 `toView` 照样变成 `anchor-b`），**只有真的点一下并读 scroll-view 自己的
  `scrollTop` 才发现** —— `pnpm mp:probe` 就是为这件事写的。

界面上「历史读取」有四种状态，必须长得不一样：`loading`（转圈）/ `ok`（外加一句
"以上是主机上已有的历史"；还有更早时给一个可点的「加载更早的内容」）/ `error`
（可点重试）。**把"读不到"渲染成"这个会话没内容"是在给用户一个假事实** —— 他会以为
主机上真的没有东西，转而去查别的方向。空状态那两句话就是按这个分岔写的：
只有 `historyState === 'ok'` 才说"这个会话还没有内容"。

主机那一代内核没有 `readSession` 时，插件**明确拒绝**（"主机这一代不支持读取历史"），
不返回空页 —— 同上，空页会让用户以为会话是空的。

四种状态都有截图留档（`pnpm mp:shots --pages chat` 里的 `chat-history*`）：
`chat-history` 是"读到了且还有更早"，`chat-history-error` / `chat-history-empty` /
`chat-history-loading` 各占一张。这三种说法**长得不一样**是可以用眼睛验的，
而这件事只有截图能验。

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
node --test e2e/mp-client.test.mjs    # 13 项：真实 client.js + wx shim 跑完整闭环（含取历史的结算语义）
node --test e2e/mp-platform.test.mjs  # 3 项：环境探测 + 双路径 socket
node --test e2e/mp-chat-blocks.test.mjs   # 25 项：chat 页块流时序 + 历史回放 + 过程默认不显示
node --test e2e/mp-sessions-list.test.mjs # 3 项：会话列表的归档过滤与空态
node --test e2e/mp-pairing.test.mjs       # 18 项：首页内联的配对（扫码即连、失败可重试、解除配对）
node --test e2e/mp-theme.test.mjs         # 9 项：浅/深主题（默认、双向、跨启动、导航栏、存不下）
pnpm check:mp-ui                      # 组件/类名声明 + 主题接线 + 配对入口在位 + 分支链兜底 else + 配色对比度
pnpm mp:theme --check                 # 两份变量表是否还与 TDesign 同步（含深浅覆盖对账）
pnpm mp:lazyload                      # 按需注入前后各注入多少 JS（不需要开发者工具）
```

## 配色：先算对比度，别靠看截图

**TDesign 的深色值不能直接拿来用** —— 它是给大屏 Web 调的，手机屏字号更小、
底色更深，几个变量真机上明显偏暗。2026-10-02 实测：238 组前景/背景里 **45 组
不达标**，`placeholder` 压卡片底只有 3.16:1，晚上看会话的时间戳与路径基本靠猜。

`check:mp-ui` 里的 `dsh-remote-mp/scripts/check-mp-contrast.mjs` 会展开两套变量表、算真实的前景/背景、
按 WCAG 判阈值（正文 4.5，大字与图形 3）。**改任何颜色前先跑它**，
调整后的值与实测前后对比写在 `dsh-remote-mp/scripts/gen-mp-theme.mjs` 的
`DARK_READABILITY` / `LIGHT_READABILITY` 两张表里。

**一个颜色变量不要同时当前景和背景用。** `--td-brand-color` 就同时扛两个互斥角色：
当**底色**（用户气泡、`t-button--primary`）要够暗才压得住白字；当**字色**
（`.pill.primary` 压 `--td-brand-color-1` 浅底）要够亮 —— 这两条**数学上无解**
（需亮度 ≤0.163 与 ≥0.304）。所以另有 `--td-brand-color-on-tint` 专管
"压在品牌浅底上的字色"，浅色下同值所以观感不变，9 处字色改用它。

**做法：先算出两个角色各自的可行区间，无解就拆变量，别找折中值。**

生成期还有两个护栏（都在 `dsh-remote-mp/scripts/gen-mp-theme.mjs`）：
`checkCssSanity` 验拼出的 CSS 合法 —— **一段非法声明会让整条规则作废**，
同规则里其他修正跟着静默失效；`checkReadabilityOrder` 验灰阶序，判据用
**对比度递减**而不是亮度（深色白字越往后越暗、浅色黑字越往后越**亮**，方向相反）。

`pnpm mp:probe` 有四组：`jump`（回到最新真的滚了）、`plain`（过程默认不渲染，
且没掉进 note 分支变成空提示条）、`fold`（**显式 `showSteps: true`** 后折叠仍不留空白）、
`theme`。`fold` 必须显式打开过程 —— 默认不渲染时它数到的卡片恒为 0，
判据会一直红，而红的原因不是折叠坏了，是"根本没有过程可折"。

`check:mp-ui` 第 ⑦ 项盯住**配对入口不许消失**：首页必须有 `wx.scanCode`、
必须有元素 `bindtap` 到它、必须有 `bindtap="onUnpair"`、必须有 `wx:if="{{paired}}"`
的两态分支。配对页删掉后这些能力全靠内联，丢一条不会编译报错、也不会让测试变红 ——
只会在真机上变成"装好了却没有任何办法连上"。三条断言都做过反证。

**需要开发者工具**（人工触发，不进 CI）的那两个：

```sh
pnpm mp:shots                         # 截模拟器渲染（改完界面自己看得见结果）
pnpm mp:probe                         # 交互探针：点一下到底有没有用（读 scrollTop、算出的底色等真实状态）
```

`mp:probe` 补的是另外两者都覆盖不到的一层：`mp:shots` 只证明"长得对"，
`mp-chat-blocks` 只证明"逻辑算得对"，而「点了没反应」发生在渲染层 ——
`scroll-into-view` 找不到目标节点时不报错、不重试，只是不滚。
改滚动、交互或**主题**之后跑它（`--case jump|fold|theme` 可单跑）。

`e2e/mp-sim.mjs` 提供了一个最小 `wx` shim（storage + `connectSocket` 走 `ws` 包），
所以**小程序客户端代码可以在 Node 里被真实驱动**。改了 `core/client.js` 一定要跑它。

## 常见故障

| 现象 | 原因 |
|---|---|
| 一直「连接中」 | 服务地址不对 / 中继没起 / 真机用了 `ws://` |
| `配对失败：配对码无效或已过期` | 超过 TTL（默认 120s），回主机**点一下状态栏那颗 pill** 重新生成 |
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

主机端**点状态栏那颗 `dsh-remote-control`**，再按面板右上角那颗「生成配对码」，当场生成一张一次性码，
二维码与 6 位数字一起出现在按钮下方（**内嵌 6 位配对码** `&t=`，所以扫码即连；扫不出来时面板上
同时印着那 6 位数字可以手输）。**命令行没有配对入口**：`/drc` 命令在 2026-10-03 **整条删掉**
（连同更早删掉的 `/drc pair` 与终端文本码）——文本码在 DSH 命令卡按 `line-height:1.6` 渲染时会被
行间留白横切成条，实测 zxing ≥1.15 行距就解不出来。

编码器是 vendored 的 `qrcode-generator` 1.4.4（MIT），因为插件装进外部 profile 时
必须自包含；校验不靠肉眼——`scripts/validate-qr.mjs` 用 zxing-cpp **真实解码**
渲染结果（28 组含 CJK 与公网 URL）。手写过一版，被这个校验器抓出系统性差异后放弃。

## 还没做

- 图片/文件附件（`cmd.send_prompt.attachments` 协议里有字段，UI 没做）
- 多主机切换（**只允许配对一台**：新设备配上时主机当场踢掉旧的那条通道，旧手机下一帧就提示重新配对）
- 消息历史的**本地**持久化：小程序自己的存储里不留消息，每次打开会话都从主机读一页。
  离线看历史、或主机上那条会话被删掉之后回看，都还做不到
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
