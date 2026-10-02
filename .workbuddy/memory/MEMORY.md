# dsh-remote-control 项目长期记忆

（细节不在这里：坑位清单见 skill `dsh-mp-ui-dev`；逐轮过程见 `.workbuddy/memory/YYYY-MM-DD.md`）

## 部署与排错

- 线上 `wss://drc.provid.cc`（阿里云 cn-shanghai / ECS `47.100.82.15`）。服务器
  `/opt/dsh-remote-control/server` + systemd `dsh-remote-control.service`（只绑
  `127.0.0.1:8787`）+ nginx `conf.d/drc.conf`（TLS/ws/按 IP 限流）。证书 acme.sh +
  阿里云 DNS-01 自动续期。token 两处**必须一致**：服务器 `/etc/dsh-remote-control.env`(600)
  与 `~/.dsh/profiles/desktop/cordis.patch.yml`。`provid.cc` 有泛解析。
- **排错第一动作**：`cat ~/.dsh/dsh-remote-control/status.json`，看 `carrier`
  （`services`=真内核 / `mock`=假会话）、`relay`、`relayProblem`、
  `kernel.historyFace`（`readSession`=能读历史 / `absent`=不能）。
- 中继日志 `DRC_LOG_LEVEL=debug ./scripts/relay-start.sh`；`/healthz` 可当 readiness 探针。
- 改插件后**必须重启 Harness**（改配置会 HMR，替换 `dist` 不会）。重新部署用
  `./scripts/install-to-profile.sh`，别只 `pnpm -r build`——pnpm 对 `file:` 依赖是硬链接
  拷贝，inode 变了 profile 里还是旧的。

## 构建 / 测试纪律

```sh
env -u NODE_OPTIONS pnpm -r build
env -u NODE_OPTIONS pnpm -r test
node e2e/run.mjs                      # 本地全链路
env -u NODE_OPTIONS pnpm -C e2e test  # mp 字节级 + 协议 + 多配对 + 重启恢复 + run.mjs
pnpm -C e2e test:mp-pages             # 只跑页面逻辑
```

- **必须 `env -u NODE_OPTIONS`**：WorkBuddy 注入的 FS 钩子拦 pnpm 符号链接，报
  `CODEBUDDY_BROKER_DENY`。被 SIGTERM 打断的 pnpm 会在
  `~/Library/pnpm/store/v11/projects/` 留失效链接，删掉。
- **各包测试引 `dist/` 产物**，只 `node --test tests/*.mjs` 会假红。跑 mp 测试前必须先
  `pnpm -r build`，否则 `mp-crypto.test.mjs` 报 `does not provide an export named …`。
- plugin 单跑用 `pnpm -C packages/plugin test`：**根包与 plugin 同名**，
  `--filter dsh-remote-control` 会命中两个。
- `e2e/*.test.mjs` 直接摸 `mp/core/client.js` 私有字段，**改名后必须
  `grep -rn "<旧名>" e2e/`**。滞后断言的表现是"整套 e2e 挂死不退出"（不是一条红）。
- 根 `package.json` 与 `packages/plugin/package.json` **包名相同**；`lib/` 是已删的陈旧
  产物，禁止 import。
- **有并行 agent 在提交**：开工与交付前各 `git log --oneline -3`；别把别人的未提交文件
  一起 commit。同一文件几分钟内可能被改掉，**判断代码对不对之前先看 mtime**。
- 在本机判断"有没有"必须用 `grep -cE`：BSD grep 的 BRE 不认 `\|`，会静默返回 0。

## 打包约束

插件装进 `~/.dsh/profiles/desktop`（外部 pnpm 工程），**不能有 `workspace:*`**。
`@dsh-rc/protocol` 只是 devDependency；`scripts/bundle-protocol.mjs` 在 build 后把
protocol 产物复制到 `dist/protocol/` 并把裸 specifier 改写成相对路径。运行时依赖只有
`ws` / `tweetnacl` / `tweetnacl-util`。**改了 protocol 必须重新 build plugin**。

## 小程序（mp/）硬约束

- `mp/core/`（codec/env/socket/session-store/client/theme）+ `mp/core/vendor/`
  （nacl-fast.js 已打补丁移除 `require('crypto')`，升级 tweetnacl 要重打）
  + `mp/miniprogram_npm/tdesign-miniprogram/`（裁剪版，**永远不要点「构建 npm」**）。
  无 Buffer/CSPRNG/crypto：UTF-8 与 base64 用 vendored js-base64，nonce 用计数器。
- **绝不用 `t-input`**（真机高度塌陷成一条缝，实证）：一律原生 `input` + 显式
  `height`/`line-height`，`clearable` 自绘 `✕`。**绝不用 `t-icon`**（图标字体走 CDN，
  拉不到就是空白方块且无报错）。
- **滚动锚点必须是两个静态 id**（`anchor-a`/`anchor-b`），靠切 `scroll-into-view` 指哪个。
  写成 `<view id="{{toView}}">` 是渲染层竞态 → **静默不滚**，`data.toView` 看着还是对的。
- **"限高 + 内部滚动"只能用 `scroll-view`**：`view` 的 `overflow:auto` 真机不生效。
  限高用 `max-height`；滚动落点只给 live 组，否则回看用户被反复拽回组尾。
- 颜色一律 `var(--td-xxx, 浅色兜底)`，**不硬编码 `#fff`**。
- 改完界面：`pnpm check:mp-ui` → `pnpm mp:shots`（截图+捕获运行时错误）→
  `pnpm mp:probe`（交互探针，见下）  → `/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview --project $PWD/mp
  --qr-format image --qr-output $PWD/.tmp/mp-preview-qr.png`
  （**`cli` 不在 PATH，必须用这个绝对路径**，`--project` 也必须绝对路径）。
  纯 wxml/wxss/json 改动不用跑 mp 测试。
- **三层验证缺一不可**：截图只证明"长得对"，页面单测只证明"逻辑算得对"，
  只有 `mp-probe`（`scripts/mp-probe.mjs`，`callMethod` 真触发后读**渲染层**状态）
  能抓"点了没反应"。读计算样式用 `el.style(...)`，不是 `el.property(...)`。
- **预览码是编译那一刻的快照**，从"最近使用"进更是加载缓存。用户说"改了没生效"
  九成是这个。交付必须给**新生成**的二维码 PNG。
- 长期装到手机：`pnpm mp:upload`（版本号取自 `mp/package.json`）→ 体验版 →
  socket 合法域名白名单（只能网页配）。上传 ≠ 手机自动更新。
- `app.json` 的 `lazyCodeLoading: requiredComponents` 必须留着，但**别声明全局
  `usingComponents`**（会把收益抵消）。`componentPlaceholder` 只给非首屏、条件渲染、
  非交互控件用。这两个配置**不改包体积**，验证注入面用 `pnpm mp:lazyload`。

## 主题：浅色默认 + 深色手动切

- `mp/core/theme.js` 是唯一入口，切换入口在 **sessions 页底部**。
- **深色挂 class 不挂 `page`**（`theme/dark.wxss` 选择器改写成 `.theme-dark`，由
  `applyTo` 挂到根 view：两页 `page-pad`、chat 页 `chat-wrap`）。两套都写 `page` 只能
  靠源码顺序决胜，而那是**单向**的——压得住深色、切不回浅色。
- **切换必改三处**：根容器 class + `wx.setNavigationBarColor`（原生组件不吃 CSS 变量）
  + `wx.setBackgroundColor`（iOS 回弹区）。`app.js onLaunch` 也要调，否则白顶栏闪一下。
  `.page-pad` 需自带 `background` + `min-height:100%`，否则下边缘透出浅色带。
- 两份 wxss 是**生成物**（`pnpm mp:theme` / `--check`）；脚本会对账变量覆盖，
  `DARK_ONLY_FIXUPS` 补 TDesign 浅色分支独有的几个（否则深色下继承浅色阴影）。
  **升级 TDesign 后先跑 `--check`**。
- 写 import 顺序断言**别用 `indexOf`**——会命中注释里的文件名，变成永远为假的死代码。

## chat 页信息流 + 命令回执

- 五种块：`turn` / `user` / **`steps` 步骤组** / `text` / `note`。
  步骤组是核心抽象（一轮里"想→调工具→再想"聚成一条）。有正文后该组 `closed`，
  新工具调用必须**另起一组**（`_sealSteps`），否则插进已读完的过程里。
- **实时新开的组默认展开、历史回放默认收起**（否则用户以为根本没有工具列表）。
- 展示字段在 `_commit` 里由 `decorateSteps()` 派生；「还在跑」**只看组内条目状态**。
  空块流**不补「思考中」**（`_ensureThinkOpen` 的 `if (!last) return`）。
- **思考正文永远拿不到**（M28 红线：宿主侧就丢 `reasoning` part）——只有阶段+耗时。
  运行态**只认 `ev.run_state`**（`assistant/message` 自带 `done:true`，一轮可有多条）。
- 折叠后必须重新锚定（`_afterFold` → `_scrollToBottom`，**只在贴底时做**）：折叠让高度
  剧烈缩小（实测 4532→1876），真机不每次重新量，视口停在旧高度上就是一段空白。
- 中断放顶栏（键盘弹起会顶走输入区）。点空白收键盘：外层 `bindtap` + 输入区
  `catchtap`；**千万别给 input 加 `hold-keyboard`**（那正是"不收键盘"的开关）。
- sessions 页不显示归档会话（主机对它们每一步都拒绝），底部留「已隐藏 N 个」。

## 协议 / 客户端约定

- `cmd.new_session`（三端贯通，`client.newSession()`）与 `cmd.session_history`。
- **所有命令回执统一走 `_cmdWaiters` 表，按 `cmdId` 结算**（幂等 + 超时 + 断线）。
  `ev.session_history` 是**回执不是广播**：找不到 waiter 就当普通事件 emit 会渲染两遍。
  **结算点只有一个**，收帧处顺手 `delete` 或先换表再回调都会让 promise 永不 settle
  （真踩过：15s 超时也走 `done()`，一起被吃掉）。锁它的用例在 `mp-client.test.mjs`。
- 历史条目与实时流**同构**（`ev.message_delta`/`ev.tool_event`），回放复用同一套落块函数。
  **只有游标 `nextBeforeSeq`、没有 `hasMore`**——两个字段表达同一件事迟早造出
  "说还有却不给游标"（手机上就是点了没反应且无报错）。
- **去重集合不许在回放过程中登记自己**：一次工具调用本来就有「参数」「收尾」两条事件，
  边回放边登记会把第二条当重复丢掉 → 工具永远停在"正在执行"。用户消息无 id，退化成
  按文本**多重集消耗**。回放不补思考段、不带 `run_state`、不自动跟底。
- 插件缺 `readSession` 时**明确拒绝、不返回空页**（空页会让用户以为会话是空的）。
  四态（loading/ok/error/hasMore）**文案必须不一样**。
- 一次性定时器**unref 与"停机集中撤销"必须成对**（`core/clock.ts`）：只 unref，宿主没退
  时仍写过期取证；只撤销，宿主空闲时进程被钉住。

## 尚未验证

唯一空档是**真机上的审批/提问卡**：本机所有 preset 都是 `danger-full-access` +
`approval/policy: never`，永不弹审批（环境问题，非代码问题）。代码路径有单测与
mock e2e 覆盖，carrier 已实测为 `services`。
