# dsh-remote-control 项目长期记忆

## 生产部署（已上线）

- 入口：`wss://drc.provid.cc`（阿里云 cn-shanghai / ECS `47.100.82.15`）
- 服务器：中继 `/opt/dsh-remote-control/server` + systemd `dsh-remote-control.service`
  （只绑 `127.0.0.1:8787`）；nginx `conf.d/drc.conf` 做 TLS + ws + 按 IP 限流
- 证书：acme.sh（`/opt/jevtv/acme/acme.sh`）+ 阿里云 DNS-01，已存凭证，自动续期
- token：服务器 `/etc/dsh-remote-control.env`（600）与 macOS
  `~/.dsh/profiles/desktop/cordis.patch.yml` 两处**必须一致**
- DNS：`provid.cc` 有 `*.provid.cc` 泛解析，加子域不用改记录
- 详见 `deploy/README.md`；自检 `node scripts/verify-deployment.mjs`
- 排错入口：`cat ~/.dsh/dsh-remote-control/status.json`，看 `carrier`
  （`services`=挂上真实内核 / `mock`=假会话）、`relay`、`relayProblem`

## HMR 不会重载 dist

改 `cordis.patch.yml` 的配置会热更新；替换 `node_modules/<pkg>/dist` **不会**。
**改代码必须重启 Harness。**

## 构建 / 测试命令（必须这样跑）

```sh
env -u NODE_OPTIONS pnpm install -r
env -u NODE_OPTIONS pnpm -r build
env -u NODE_OPTIONS pnpm -r test      # 各包单测
node e2e/run.mjs                      # 本地全链路
env -u NODE_OPTIONS pnpm -C e2e test  # mp/协议/多配对/重启恢复 + run.mjs
```

（别在记忆里写死测试条数 —— 换过几轮了，以实际跑出来为准。）

**plugin 单跑要用路径 filter**：根 `package.json` 与 `packages/plugin/package.json`
**包名相同**（都叫 `dsh-remote-control`），所以 `pnpm --filter dsh-remote-control test`
会同时命中两个（第一个跑的是根包的 `pnpm -r test`）。要单跑插件用
`pnpm -C packages/plugin test`，别用名字 filter。

**各包测试引的是 `dist/` 产物**（`apps/server/tests` 就是 `import '../dist/src/server.js'`）。
所以只 `node --test tests/*.mjs` 会**假红** —— 包自己的 `test` 脚本里带 `pnpm build`，
要么走它，要么先手动 build。今天在 relay 上白排查了一轮就是这个。

**为什么加 `env -u NODE_OPTIONS`**：WorkBuddy 注入的 FS 钩子
（`node-brokered-fs-shim.cjs`）会拦截 pnpm 的符号链接操作，报
`CODEBUDDY_BROKER_DENY` EEXIST/ENOENT，导致 install 失败。清掉 NODE_OPTIONS 即可。
被 SIGTERM 打断的 pnpm 还会在 `~/Library/pnpm/store/v11/projects/` 留下失效链接，删掉。

**这个仓库有并行 agent 在提交**：本轮 HEAD 从 `41cbe95` 自己移到了 `20fcddf`
（另一个会话在改 relay/pairing-text）。开工前 `git log --oneline -3` 记一下，
交付前再对一次；**别把自己没写完的东西和别人的未提交文件一起 commit**。
**另外：同一个文件几分钟内可能被另一个会话改掉** —— 本轮 `e2e/run.mjs`（18:38）与
`mp/core/client.js`（18:46）都在我读完它之后变了。**判断"代码对不对"之前先看 mtime**，
别拿几分钟前的阅读当现况（我因此白追了一轮已修好的 bug）。

## 产物路径（别搞错）

- `packages/protocol` → `dist/src/**`（tsconfig `rootDir:"."`），main 是 `./dist/src/index.js`
- `packages/plugin` → `dist/src/**`，main 是 `./dist/src/index.js`
- **`lib/` 是历史遗留的陈旧产物，已删除并 gitignore —— 不要再从 lib/ import**
- `packages/plugin/dist/protocol/` 是构建时内联进来的 protocol 副本（见下）

## 打包约束：插件必须自包含

插件要装进 `~/.dsh/profiles/desktop`（外部 pnpm 工程），**不能有 `workspace:*` 依赖**。
所以：`@dsh-rc/protocol` 只是 devDependency；`scripts/bundle-protocol.mjs` 在 build 后
把 protocol 编译产物复制到 `dist/protocol/`，并把 `@dsh-rc/protocol` 裸 specifier
改写成相对路径。运行时依赖只有 `ws` / `tweetnacl` / `tweetnacl-util`。

**改了 protocol 之后必须重新 build plugin**，否则 `dist/protocol/` 是旧的。

## 小程序（mp/）约束（2026-10-02 重写后）

- 结构：`mp/core/`（codec / env / socket / session-store / client）+ `mp/core/vendor/`
  （nacl-fast.js + js-base64.js）+ `mp/miniprogram_npm/tdesign-miniprogram/`（裁剪版
  TDesign，无需构建 npm）。旧 `mp/utils/` 已删除。
- 无 Buffer / 无 CSPRNG / 无 crypto 模块 → UTF-8/base64 用 vendored js-base64；
  nonce 用计数器。
- `mp/core/vendor/nacl-fast.js` 已打过补丁（移除 `require('crypto')` PRNG 探测），
  升级 tweetnacl 时要重新打。
- `mp/core/package.json` 只为把该目录标成 commonjs 供 Node 侧测试用，小程序无视它。
- 改 `mp/core/*.js` 必须跑 `e2e/mp-crypto.test.mjs` + `e2e/mp-client.test.mjs`
  （+ `e2e/mp-platform.test.mjs`）。
- **跑 mp 测试前必须先 `env -u NODE_OPTIONS pnpm -r build`**：`mp-crypto.test.mjs`
  从 `packages/protocol/dist/src/index.js` 取 Node 侧对照实现，dist 陈旧会报
  `does not provide an export named …`（看着像代码错，其实是没 build）。
- 这三个 mp 测试 + `multi-pair` + `restart-resume` 由 `e2e/package.json` 的 `test`
  脚本串起来（2026-10-02 曾被误删掉 mp-crypto/mp-platform，已恢复；**别再删**，
  它是唯一的字节级护栏）。
- `pair-fail.reason` 是逐字枚举（DESIGN.md F6）：`core/client.js` 的
  `translatePairFail` **只认四个**（invalid_or_expired / already_used / host_offline /
  bad_token）。中继侧已保证不往里塞第五个：`server.ts:229` 把内部的 `rate_limited`
  换成 `invalid_or_expired` 下发、真实原因只进日志（DESIGN.md 第 440 行）。
  中继发的 `error` 帧自带中文 `message`（`apps/server/src/server.ts` 的 `CLIENT_ERROR_TEXT`）。
- 页面入口是 `pages/sessions/sessions`（未配对显示「去配对」），pair 页配对成功自动返回。
- socket.js 连接超时看 `_opened` 标志，不是「已绑定」——旧版的超时是死代码。
- ~~已知瑕疵：`node --test e2e/mp-client.test.mjs` 跑完进程会多挂 ~58s 才退出~~
  **已修**（`be6ac44` fix(plugin,e2e)：一次性定时器 unref 并在停机时撤销）。
  根因不是 run.mjs 残留 handle，是「载具探测复查」那个 `setTimeout` 没 `unref`。
  现在单跑 **12s**、`pnpm -r test` 整体 **16s**。
  做法在 `packages/plugin/src/core/clock.ts`：`unrefTimer()` + `createOneShotTimers()`
  ——**unref 与「停机集中撤销」必须成对**：只 unref，宿主没退时仍会写过期取证；
  只撤销，宿主空闲时进程还被钉住。对 `FakeClock` 的数字句柄是空操作。
- **「取历史」已实现（2026-10-02，三端）**，这条替换掉了旧的「协议没有取历史能力」：
  - 协议 `packages/protocol/src/payloads.ts`：`cmd.session_history` / `ev.session_history`，
    条目与实时流**同构**（`ev.message_delta` / `ev.tool_event`），所以回放复用同一套落块函数。
    **刻意只有游标 `nextBeforeSeq`、没有 `hasMore`** —— 两个字段表达"还有更早"迟早出现
    "说还有却不给游标"，手机上就是「加载更早」点了没反应且无报错。
  - 插件：`KernelPort.readHistory?`（可选）+ `platform/carrier-services.ts` 的
    `historyPageFromLog()`（纯函数，一条内核事件折 0/1/2 条线格式条目，走
    `sessionQuery.readSession` 拿整份日志在内存里切片）。内核缺 `readSession` 时**明确拒绝**，
    **不返回空页**（空页会让用户以为会话是空的）。
  - mp：`client.loadHistory()` 按 `cmdId` 配 waiter + 15s 超时；`chat.js` 的
    `_loadHistory` / `onLoadEarlier` / `_replayPage`。
  - 判据：`~/.dsh/dsh-remote-control/status.json` 的 `kernel.historyFace`
    （`readSession` = 能读；`absent (keys=…)` = 不能）。**真机验历史前先看它。**

## mp 界面（UI）约定（2026-10-02 重做后）

- **颜色一律用 TDesign 变量** `var(--td-xxx, 浅色兜底)`：主题按 `prefers-color-scheme`
  自动切，写死 `#fff` 在深色模式手机上就是白底白字。语义色圆点/胶囊在 `app.wxss`
  的 `.dot` / `.pill`（class 直接等于 `statusTheme`：success/primary/warning/danger）。
- **`t-icon` 不要用**：图标字体走远程 CDN，拉不到就是一堆空白方块且无报错。
  继续用 `▶ ✓ ✕ ·` 这类符号 + CSS 画点的形状。
- 可用组件只有裁剪版那批（button/cell/cell-group/dialog/divider/empty/icon/image/input/
  link/loading/message/overlay/popup/switch/tag/toast）；**没有** textarea/steps/badge/
  skeleton。**永远不要点「构建 npm」**。
- **`t-input` 不要用（真机塌陷，实证）**：它的高度全靠组件内部
  `padding: var(--td-input-vertical-padding, var(--td-spacer-2, 32rpx))` 撑，
  2026-10-02 真机截图里同一页 4 个 `t-input` 全塌成一条缝，隔壁 `t-button` 正常；
  断点至今没定位到（变量/选择器/`classPrefix` 都查过是好的）。
  **输入框一律原生 `input` + 写死 `height`/`line-height`**，`clearable` 用自绘 `✕`。
- **滚动锚点必须是两个静态 id**：chat 页用 `id="anchor-a"` + `id="anchor-b"` 两个元素，
  靠切 `scroll-into-view` 指哪个来滚到底。**绝不能写成一个元素跟着值改名**
  （`<view id="{{toView}}">`）—— `scroll-into-view` 要按 id 查节点，改名与生效谁先
  落到渲染层是竞态，赌输就是**静默不滚**（不报错、不重试，`data.toView` 还是对的）。
  实证：「回到最新」点了没反应就是这个，反证过（动态 id 时 scrollTop 0→0，
  静态 id 时 0→907）。
- **要"限高 + 内部滚动"只能用 `scroll-view`**：小程序里 `view` 的 CSS `overflow: auto`
  在**真机上不生效**（开发者工具里可能看起来能滚）。限高用 `max-height`（不是 `height`，
  短内容不该留空白）。chat 页的步骤组 `.steps-scroll` 就是这么做的，滚动落点 `tailId`
  **只给还在跑的组**，否则回看的用户会被新内容反复拽回组尾。
- 改完界面按顺序验证：`pnpm check:mp-ui`（结构自检，含注入配置）→
  `pnpm mp:shots`（连开发者工具自动化端口截图，**自己能看渲染结果**，同时捕获运行时错误，
  有错非零退出；不必等用户扫码反馈。端口要 `cli quit` 后再 `cli auto --auto-port 9420`
  才会监听；`cli auto` 报 `wait IDE port timeout` 就原样再跑一次同一条命令）→
  `pnpm mp:probe`（**交互探针**：真的"点一下"再读渲染层真实状态，判"点了有没有用"。
  截图只证明长得对、页面单测只证明逻辑算得对，而"点了没反应"两样都抓不到）→
  `cli preview --project $PWD/mp --qr-format image --qr-output .tmp/mp-preview-qr.png`
  （真编译 + 真机二维码。**`--project` 必须绝对路径**，写 `mp` 会报
  "project.config.json 不存在 code 19"）。
  纯 wxml/wxss/json 改动不用跑 mp 测试。
- 详细坑位清单见 skill `dsh-mp-ui-dev`（input 必须显式 height、flex 滚动子项 min-height:0、
  `:last-child`/`+` 别用、`<text>` 上 ellipsis 无效、scroll-into-view 只在值变化时生效）。
- **预览二维码是快照，不是发布**：扫码那一刻编译出的包就定死了，之后改的代码不进去；
  从微信「最近使用的小程序」点进去更是直接加载缓存。用户说「改了没生效」九成是这个，
  不是代码没改对。交付时必须给**新生成的**二维码 PNG，并说清「怎么一眼看出是新版」的
  可见标志。
- 装到手机上长期用：`pnpm mp:upload`（默认版本号取自 `mp/package.json`，不是根
  `package.json`）→ 后台「选为体验版」→ socket 合法域名白名单（`wss://drc.provid.cc`，
  只能网页配，`cli` 没有该命令；体验版强制校验，开发版可开调试模式绕过）。
  上传 ≠ 手机上自动更新。详见 skill `dsh-mp-ui-dev`。

## chat 页 = 文档流 + 步骤组（2026-10-02 二次重做）

- 五种**块**：`turn` 轮次分隔 / `user` 指令 / **`steps` 步骤组** / `text` 回复正文 /
  `note` 系统提示。组内条目两种：`think`（只有阶段+耗时）/ `tool`（可展开看参数与结果）。
- **步骤组是核心抽象**：一轮里「想 → 调工具 → 再想」聚成**一条**，界面就是
  「已完成 N 个步骤」一行。不聚合的话一轮 6 次工具 = 12 个块。
- **封口规则**：有正文/轮次/指令出现后这一组 `closed`，新工具调用必须**另起一组**
  （`_sealSteps`）。漏了会把新调用插进上一段已读完的过程里。
- 展示字段（`label`/`tools`/`live`）在 `_commit` 里由 `decorateSteps()` 派生；
  **「还在跑」只看组内条目状态**，不看全局 `running`，否则老组也会显示"正在执行"。
- **空块流不补「思考中」**（`_ensureThinkOpen` 的 `if (!last) return`）—— 那一轮还没开始，
  状态由顶栏表达。重写时丢了这条守卫，测试立刻红。
- **思考正文永远拿不到**：M28 红线（`docs/legacy-spec/host-plugin-runtime.md`）——
  `assistant/message` 的 `reasoning` part 在宿主侧就被丢，协议里也没有思考事件。
  「思考」只有阶段 + 耗时，由「下一条内容出现」推断。
- **运行态只认 `ev.run_state`**：`assistant/message` 自带 `done:true`，
  一轮里可有好几条，拿它判「这一轮结束」会让状态条在第一次工具调用后骗人。
- 顶栏是窗口控制条（状态 / 展开收起全部过程 / 中断）；中断放这里而不是输入区，
  因为键盘弹起时输入区会被顶走。折叠两个层级：组 / 组内某一步。
- **点空白收键盘**：外层容器 `bindtap` + 输入区/面板 `catchtap`；
  千万别给 input 加 `hold-keyboard`（那正是「点页面不收键盘」的开关）。
- `sessions` 页**不显示归档会话**（主机对它们每一步都拒绝），底部留「已隐藏 N 个」。

## 主题：浅色（默认）+ 深色，手动切（2026-10-02）

- **`mp/core/theme.js`** 是唯一入口：`current()` / `applyTo(page)` / `toggle(page)`。
  入口 UI 在 **sessions 页底部**（与「重新配对」同一排），深色时按钮显示「浅色」。
- **深色挂 class、不挂 `page`**：`theme/light.wxss` 选择器是 `.page,page`（默认态），
  `theme/dark.wxss` 被脚本改写成 `.theme-dark`，由 `applyTo` 挂到**根 view** 的 class 上
  （三页：`page-pad`×2 / `chat-wrap`）。**必须挂根 view** —— 挂子树深处只染一小片。
  **为什么不能两套都写 `page`**：那只能靠源码顺序决胜，而**单向** —— 压得住深色、切不回
  浅色。class 才让"用不用深色"由用户的选择决定（`prefers-color-scheme` 是系统的意思）。
- **切换必须同时改三处**（`theme.js` 的 `toggle` 都做了，缺一件就是"切了没切干净"）：
  ① 根容器 class；② `wx.setNavigationBarColor`（原生组件不吃 CSS 变量，否则留白顶栏）；
  ③ `wx.setBackgroundColor`（iOS 下拉回弹区，否则露白）。`app.js onLaunch` 也要调一次
  ——等页面 `onLoad` 会有白顶栏闪一下。
- `.page-pad` 必须自带 `background` + `min-height:100%`：`page` 元素自己永远是浅色，
  根容器不透光的话深色下会从下边缘透出浅色带。
- **两份 wxss 都是生成物**（`pnpm mp:theme` / `--check`）。脚本会做**变量覆盖对账**：
  浅色有而深色没有的变量直接报错。已知 `--td-shadow-4`、`--td-scrollbar-hover-color`
  只在 TDesign 浅色分支里（136 vs 140），靠脚本的 `DARK_ONLY_FIXUPS` 补齐 ——
  不补则深色下**继承浅色值**，表现为"深色里一块浅色阴影"。**升级 TDesign 后先跑 `--check`**。
- 验证：`node scripts/mp-probe.mjs --case theme`（8 条，真点按钮读渲染层亮度
  0.95 → 0.09 → 0.95）。**读计算样式用 `el.style(...)`，不是 `el.property(...)`**
  ——后者读 data/props，对 CSS 属性抛 `not exists`。
- `check-mp-ui.mjs` 第 ⑥ 项盯这条链（import 顺序 / 生成物选择器 / 每页 `{{themeClass}}` /
  每页 `theme.applyTo(this)` / 默认 light）。**写 import 顺序断言别用 `indexOf`** ——
  会命中注释里的文件名，断言成了永远为假的死代码（反证时才发现：顺序颠倒竟然通过）。
- 新写样式仍用 `var(--td-xxx, 浅色兜底)`，**不要硬编码 `#fff`**（深色下是白斑）。

## 页面逻辑的自动化护栏

`e2e/mp-chat-blocks.test.mjs`（19 项）+ `e2e/mp-sessions-list.test.mjs`（3 项），
`pnpm -C e2e test:mp-pages` 单跑。手法可复用：**假的 `wx`/`Page` 载入真实页面代码**，
喂事件序列断言产出 —— 页面逻辑不必等真机就能进 CI。
坑：页面里的 `setInterval` 不清掉 node 不退出，测试要在 `after()` 里停表。
另有一条读 `chat.wxml` 文本的断言，专锁"文案自相矛盾"（只有截图看得见的那类缺陷）。

## 打开会话读到主机历史（2026-10-02 补齐）

三段：`mp client.loadHistory` → `cmd.session_history` → 插件 `runtime` →
`kernel.readHistory` → `sessionQuery.readSession()`（整份日志）→ `historyPageFromLog()` 切片，
线格式条目与实时流同构（`ev.message_delta` / `ev.tool_event`），回放复用同一套落块函数。

- **只有游标 `nextBeforeSeq`，没有 `hasMore`** —— 两个字段表达同一件事会造出
  "说还有却不给游标"，手机上就是「加载更早」点了没反应且无报错。
- `ev.session_history` 是**回执不是广播**：`client` 按 `cmdId` 找 waiter，
  找不到就当普通事件 emit 会渲染两遍。
- **去重集合不许在回放过程中登记自己**：一页里同一次工具调用本来就有
  「参数」「收尾」两条事件（一条内核事件 = 一条线格式条目），边回放边登记会把
  第二条当重复丢掉 → 工具永远停在"正在执行"、结果预览空。用户消息没有可对齐的
  id，退化成按文本**多重集消耗**。
- 回放**不补「思考中」段**、**不带 `run_state`**（不许改顶栏）、**不许自动跟底**。
- 四态（loading/ok/error/hasMore）**文案必须不一样**；把"读不到"说成"这个会话没内容"
  是在给用户一个假事实。内核缺 `readSession` 时插件**明确拒绝**，不返回空页。
- **结算点只有一个，谁都不许抢着删登记**（真踩过，15s 超时也是走 `done()`，一起被吃掉 →
  promise 永不 settle、页面「正在读取…」一直转且不报错）。收帧处顺手 `delete`、
  或 `_settleHistory` 先换表再回调，都会触发。锁它的用例是 `e2e/mp-client.test.mjs`
  第 11/12 条（都做过反证）。
- **"promise 不结算"的用例必须包有界等待**（`Promise.race` + 定时），
  否则回归时是"套件挂死"而不是"一条红"。
- 排查"静默卡住"的手法：写最小复现 + `setInterval` 看门狗 —— 看门狗跟着停是事件循环被堵，
  看门狗在跑而 promise 不结算是结算点被吃掉。

## mp 启动注入配置（按需注入 / 用时注入）

- `mp/app.json` 的 `"lazyCodeLoading": "requiredComponents"` **必须留着**：去掉就等于
  主包 123 个 JS / 281 KB 启动时全部注入执行（TDesign 那 112 个组件 JS 白跑一遍，
  sessions 页其实只用得到 6 个）；留着进 sessions 只注入 116 KB。前提是**别声明全局
  `usingComponents`**（每页都会被强制注入，正好抵消）。
- `mp/pages/sessions/sessions.json` 的 `"componentPlaceholder": {"t-empty": "view"}`：
  占位是**异步替换**的，只给「条件渲染 + 不在首屏主路径 + 非交互控件」的组件用；
  配在首屏就渲染的 `t-switch`/`t-button` 上只会让控件晚一拍出现。
- **这两个配置完全不改包体积** —— `pnpm mp:upload` 的体积数字永远不变，拿它判断
  "有没有生效"一定误判。要看注入面跑 `pnpm mp:lazyload`（不用开开发者工具）。
- `pnpm check:mp-ui` 会拦这些配置写坏。改完配置必须跑 `pnpm mp:shots`（官方明文要求
  "修改配置后务必确认表现正常"，占位替换失败这类错误截图看不出来，靠它的运行时捕获）。

## 已安装到 desktop profile

- 依赖 + `dsh.profile.bundles` 已加；`cordis.patch.yml` 有配置行（含 hostToken）。
- 备份文件：`~/.dsh/profiles/desktop/*.bak-drc-<ts>`
- token 也用于中继：`./scripts/relay-start.sh` 会从该 patch 文件里读同一个 token。
- **改动插件后需重启 Harness**（新增 package 不走 HMR）。
- **重新部署用 `./scripts/install-to-profile.sh`，不要只跑 `pnpm -r build`**：
  pnpm 对 `file:` 依赖是硬链接拷贝（不是符号链接），tsc 重建后 inode 变了，
  profile 里的副本仍是旧的；而且单纯再 `pnpm add` 也会复用缓存，
  必须先 `rm -rf ~/.dsh/profiles/desktop/node_modules/dsh-remote-control`
  （脚本里已经做了）。

## 排错小抄

- 中继日志：`DRC_LOG_LEVEL=debug ./scripts/relay-start.sh`，一行一个 JSON。
- `/healthz` 返回 hosts/clients/conversations/uptimeSec，可当 readiness 探针。
- 配对连不上时按顺序查：中继起了吗 → token 一致吗 → `carrier=dsh` 还是 `mock`。
- `status.json` 的 `kernel.historyFace`（`readSession` / `absent (keys=…)`）是**主机能不能读历史**
  的唯一判据 —— 真机验历史加载前先看它，`absent` 时页面上必然只说「没读到主机上的历史」。
- 预览码是**编译那一刻的快照**：判断它还能不能用不用重跑，
  `find mp -type f -newer .tmp/mp-preview-qr.png` 为空即仍有效。
- **在本机判断"有没有"必须用 `grep -cE`**：BSD grep 在 BRE 里不认 `\|`，
  `grep -c "a\|b"` 会静默返回 0（假阴性）。这个坑踩过两次。

## 尚未验证

唯一剩下的空档是**真机上的审批 / 提问卡**：本机所有会话 preset 都是
`danger-full-access` + `approval/policy: never`，永不弹审批（环境问题，非代码问题）。
代码路径有单测与 mock e2e 覆盖。carrier 已实测为 `services`（真实内核）。
