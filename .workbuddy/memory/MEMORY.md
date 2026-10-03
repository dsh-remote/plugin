# dsh-remote-control 项目长期记忆

细节不在这里：mp 界面坑位清单见 skill `dsh-mp-ui-dev`；逐轮过程见 `.workbuddy/memory/YYYY-MM-DD.md`。

## 仓库布局（2026-10-03 起）

小程序已独立成仓 **`dsh-remote-mp/`**（自己的 git 仓，`git status` 在它目录里跑），
自带 `npm run check` = `verify`（只查"能确定对错"的静态项，**样式/交互明确不覆盖**）
+ `theme:check` + `contrast`。
伞仓根 `scripts/` 保留探针与截图（`mp:probe` / `mp:shots` / `check:mp-ui`），已改指向
`dsh-remote-mp/miniprogram`。**页面逻辑测试仍在伞仓** `e2e/mp-chat-blocks.test.mjs`，
用 `require` 跨仓载入 `dsh-remote-mp/miniprogram/pages/chat/chat.js` —— 改 chat 页两处都要动。

协议仓 `dsh-remote-protocol/` 也已独立，走**打标签触发 GitHub Release** 发 npm
（OIDC/Trusted Publishing，不要 token）。plugin 一律以 `"dsh-remote-wire": "^x.y.z"`
消费 npm 版本，**不要改回 `file:` 本地引用**。改版本后必须 `pnpm clean --lockfile` 再
`pnpm install`（`minimumReleaseAge` 会拦刚发布的版本）；pnpm 会自动往
`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 加一条，**那条别手删**。

## 删 mp 代码前必读（2026-10-03 清理教训）

伞仓 e2e 会 `require` mp 的模块并**直接摸它的内部**。「grep 不到引用 = 死代码」在这三类上
会咬人，每一条都栽过：① 被测试当**对拍 oracle** 的导出（`codec.nacl` ——
`protocol.test.mjs` 拿它跟 npm tweetnacl + node:crypto 比哈希）；② 被测试**断言透传**的参数
（`loadHistory` 的 `opts.limit`）；③ **算进 oracle sha256 的注释** ——
`protocol.test.mjs` 比对 `codec.js` 整个文件的哈希，**加一行注释也必须重跑
`node e2e/tools/gen-vectors.mjs`**，重生成后要确认「只有 `_meta` 变了、向量逐字节相同」。
结论：清理时先跑一遍基线，删一条跑一次 e2e，别攒到最后一起验。

TDesign 已按依赖闭包裁到只剩 `button`/`empty`/`switch`（+ common），`miniprogram_npm`
1.5M → 492K。**裁剪后必须亲眼看组件渲染截图**（依赖链最长的 `t-empty`→icon+image），
「编译没报错」证明不了渲染对了。清单与闭包算法见 skill `dsh-mp-ui-dev`。

## 排错第一动作

`cat ~/.dsh/dsh-remote-control/status.json`：`carrier`（`services`=真内核 / `mock`=假会话）、
`relay`、`relayProblem`、`kernel.historyFace`（`readSession`=能读历史 / `absent`=不能）、
`injectedUserMessages`（被丢弃的宿主注入消息计数，有值=该修复在生效）。

线上 `wss://drc.provid.cc`（ECS `47.100.82.15`）。token 两处**必须一致**：
服务器 `/etc/dsh-remote-control.env`(600) 与 `~/.dsh/profiles/desktop/cordis.patch.yml`。
改插件后**必须重启 Harness**（HMR 只重载配置，替换 `dist` 不重载）；
重新部署用 `./scripts/install-to-profile.sh`，不能只 `pnpm -r build`。

status.json 里**三个数语义必须分开**，混了就会得出相反结论：
`pairedClients`（手机台数，去重 clientId）、`conversations`（会话数，重配会涨）、
`pendingPairs`（还没被用掉的配对码）。「解配 → 重配」会开**新会话**，
所以拿会话数回答"几台手机"会得到"解完配对数字反而变大"。
⚠️ 更狠的一条：**会话数按 D3 长存，手机解配也不删**（手机回前台要用同一个 convId 回来），
所以拿它当"有没有手机连着"**恒不清**。2026-10-03 用户报"解配后电脑没反应"，
真根因就是 pill 的 `paired` 读了它（`index.ts` `pillStatus()`），而新加的
`pairedClients` **一个消费者都没有**。**凡是要回答"现在有几台手机/连着没有"，
一律 `clientCount()`**（它是粗判据不是精确在线数，见 `keys.ts` 注释）。
**改 `status.json` 的字段时必须同时问「谁读它」—— 改了账本没人看等于没改。**

## 协议不一定要改：先查服务端有没有现成的路

帧名是冻结的（F1），但**中继里往往已经有那条路**。2026-10-03 查「解配要通知主机」时，
`dsh-remote-server/src/server.ts` 的 `session-leave` **客户端分支早就实现了**
（转 `peer-left` 给主机），缺的只是小程序没发。加协议帧之前先 grep 服务端。

## 构建纪律

`env -u NODE_OPTIONS pnpm -r build` / `-r test`；`node e2e/run.mjs`；`pnpm -C e2e test`。
**`env -u NODE_OPTIONS` 不能省**（WorkBuddy 的 FS 钩子拦 pnpm 符号链接，报 `CODEBUDDY_BROKER_DENY`）。
各包测试引 `dist/`，跑 mp 测试前必须先 build，否则报 `does not provide an export named …`（假红）。
plugin 单跑用 `pnpm -C packages/plugin test`（根包与 plugin **包名相同**，名字 filter 会命中两个）。
**有并行 agent 在提交**：开工与交付前各 `git log --oneline -3`；同一文件几分钟内可能被改，
判断代码对不对之前先看 mtime。

## 反复出现的五个教训

1. **静态断言写完必须反证，反证样例要「构造」最小错误形态** —— 在真实文件上做替换来反证靠不住
   （前置条件常不成立，断言不响会被误判成"断言无效"）。自检里匹配文本前**先剥注释**。
2. **CSS 自定义属性在"声明它的元素上"解析，继承下来的是「计算值」** —— 后代重定义变量**不会**让
   祖先算出的 `color` 重算。深色变量挂在根容器的 class 上，所以 `page { color: var(--td-…) }`
   取到浅色值，近黑字压在深底上（真机踩过：底色/class/页面 data 全对，只有字全黑）。
   **凡是挂了主题 class 的节点，都必须自己声明 `color`。**
3. **判据必须落在渲染层，且要挑对节点** —— 验「底色变深了」推不出「字色变亮了」。
   `mp-probe` 用 `el.style(...)` 读计算样式（不是 `el.property(...)`）；截图只证明长得对、
   页面单测只证明逻辑算得对。**没有回读手段的判据等于没测。**
   ⚠️ **2026-10-03 第三轮踩死过一次**：解配那条判据只读 `status.json` 的 `pairedClients`，
   修完主机侧就收工，用户重启后报"还是没反应" —— 真根因是**界面上那句话读的是另一个字段**
   （`pillStatus().paired` 接的是会话数，而会话按 D3 长存、恒不清）。
   **「账本对了」不等于「界面变了」，两者取的是不同字段，必须各有一条判据。**
   反证时这条尤其有说服力：换回旧字段后新判据红，**旧那条仍全绿**（它天生看不见界面）。
   宿主侧对应的手法是打**真路由**：`host.callPill('/plugins/dsh-remote-control/status')`。
   ⚠️ e2e 的 `until` 与 `untilAsync` 是两个函数 —— 异步 predicate 用 `until` 会把
   Promise 当真值**立刻假绿**；`trail` 是数组，不接受函数。
4. **判据里不许 `setData` 它本该验证的那个开关** —— 那等于自己按住开关再检查它（真踩过：验
   "过程默认显示"的探针自己写了 `showSteps: true`，把开关改回去它仍全绿）。
   **每条新判据要单独反证一次，一个不落**（我曾反证了位置却漏了开关）。
   automator 的 Element **没有 `boundingClientRect`**，只有 `offset()` + `size()`（值是字符串）；
   读不存在的字段 → `undefined` → 比较变 `NaN` → 判据恒红。**判据红时先怀疑判据。**
   automator 另有两处会咬人：Element **没有 `class()` 方法**（读 class 只能用
   `attribute('class')`）；**`style()` 只吃单个属性名**，传数组抛 "name must be a string"。
   派生字段（如步骤组的 `live`/`label`）**不经 `setData` 算得出来** —— `setData` 不走
   `decorateSteps`，写死 `live: true` 是自己按住开关。要造派生状态就调页面自己的入口
   （`_onEvent` / `onSend`），而 **`onSend` 第一道门是 `sessionId`，缺了静默 return**。
   **判据里不许写死绝对像素下限**（我拍的 88px 换机型就假红）—— 改成相对关系
   （"按钮比文字宽出内边距"）。
5. **反证后必须确认「破坏真的生效了」** —— 判据没红**最常见的原因是替换没匹配上**
   （`perl -0pi` 多行替换静默不生效；`grep -c` 一下就知道）。
   **破坏要最小**：只去掉要验的那一样。破坏太狠会让测试**挂死**而不是变红
   （把整行变注释 → 那个 `if` 分支什么都不做 → socket 永不关 → e2e 跑满 5 分钟）。
   多行替换用 Python 显式 `assert old in s`，别赌正则。
   **恢复后核对文件身份**（`head -2` 看文件头），别只看 `cp` 成功 ——
   我手滑把 socket 的备份拷到了 client.js 头上，靠核对头发现。

## 打包约束

插件装进外部 pnpm 工程 `~/.dsh/profiles/desktop`，**不能有 `workspace:*`**。
`@dsh-rc/protocol` 只是 devDependency，`scripts/bundle-protocol.mjs` 在 build 后内联进
`dist/protocol/`。**改了 protocol 必须重新 build plugin**，否则内联的是旧的。

## 设计与协议上不可省的约定

- mp：`dsh-remote-mp/miniprogram/core/` + `vendor/`（nacl-fast 已打补丁）；
  `miniprogram_npm/tdesign-miniprogram/` 是裁剪版，**永远不要点「构建 npm」**；无 Buffer/CSPRNG。
  **绝不用 `t-input`（真机塌陷）、`t-icon`（CDN 拉不到）**；滚动锚点必须两个静态 id；
  限高内部滚动只能用 `scroll-view`。
- 主题：`core/theme.js` 是唯一入口，切换必改三处（根容器 class + `setNavigationBarColor`
  + `setBackgroundColor`）。两份 wxss 是**生成物**。一个颜色变量别同时当前景和背景
  （`--td-brand-color-on-tint` 就是为拆这个而存在）。改配色先跑 `check:mp-ui`。
- chat：**「记不记」是数据层，「显不显示」是渲染层，必须分开** —— 隐藏过程只关 wxml 渲染，
  绝不删落块逻辑（审批、回执收尾、历史回放都依赖）。
  隐藏一个分支只能用**独立 `wx:if`**，带条件的 `wx:elif` 会落到末尾 `wx:else`。
  运行态只认 `ev.run_state`；思考正文永远拿不到（M28 红线）。
  **顶栏那一行的语义是「当前处于什么状态」**：连接状态（颜色有语义、不可点，排障唯一线索）
  → 弱化的模型名 → 中断。**模型名必须弱化**：无底色/无边框/无 hover，
  胶囊 + 手势这套语言等于说"这里能点"，而内核 `modelFace = no-list+no-set` 换不了。
  **没有独立的运行条**（`runText` / `.runbar` / `.jump-up` 已删）：运行态由最新那条
  live 步骤组的标签承担，正文空时落点是顶栏的中断按钮。
  **顶栏没有「展开过程」**（`expanded`/`foldable`/`onToggleAll`/`.bar-btn` 全删）：
  折叠只有组标题一行这一个入口 —— 全局一键全收会顺手把正在跑的那组也收起来。
  **纯思考组（`plain`，组内只有 think、一个工具都没调）不是可展开的东西**：
  无箭头/无 hover/不绑手势/卡片 `wx:if="{{item.open && !item.plain}}"`，
  耗时并进标题成一行「思考中 4.0s」。**长得能点却展开不出内容，比一个纯标签更像坏了。**
  think 条目数据层照落（审批要知道主机在干什么）；还在跑的那条**没有 `ms`**，
  耗时要现算 `Date.now() - startedAt`，否则标题会停在 0 直到收尾才跳一下。
- 审批：真实通道是 waterfall `approval/request`，**只有参与它才能到达手机**
  （`approval/asked|decided` 是审计事件，不能应答）。guard 里
  `WATERFALL_PARTICIPANTS = ['approval/request']` 是显式极窄名单。
  没有手机在线时 `participate()` 调 `next()` 交还桌面 UI。
  **`status.json` 的 `kernel.approvalFace` 停在 `not-attached` = `attachInteractionSink`
  从未被调用**，先查 profile 里的包是不是旧副本（`install-to-profile.sh`）、
  Harness 重启了没有，别急着改代码。
- 协议：所有回执统一走 `_cmdWaiters` 按 `cmdId` 结算，**结算点只有一个**。
  `ev.session_history` 是回执不是广播。**只有游标 `nextBeforeSeq`、没有 `hasMore`**。
  回放时**去重集合不许登记自己**。插件缺 `readSession` 时**明确拒绝、不返回空页**。
- 事件语义：**事件类型相同 ≠ 语义相同**。宿主把注入内容也写成 `user/message`，
  判据只能是 `source.kind`（实测 14 种，只有 `user` 是真人）。
- 一次性定时器 **unref 与"停机集中撤销"必须成对**（`core/clock.ts`）。

## 尚未验证

真机上的审批/提问卡：本机 preset 都是 `approval/policy: never`，永不弹审批（环境问题，
非代码问题）。代码路径有单测与 mock e2e 覆盖。
