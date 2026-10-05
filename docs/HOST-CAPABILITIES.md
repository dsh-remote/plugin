# 宿主能力面 —— 我们用了什么、漏了什么

> 2026-10-06 通读 `app.asar` 解出的 `@deepseek-ai/*`（290 个包）后整理。
> 本文只写**有取证**的条目：每条都能指到某个包的 README 或 `typert.host.js`，不是推测。

## 怎么查的（下一位 agent 复核用这个）

```sh
# 1. 解出源码（app.asar 是标准 asar 格式，16 字节头之后是 JSON 目录）
node -e "const b=require('fs').readFileSync('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar');
const h=b.readUInt32LE(12);console.log(JSON.parse(b.slice(16,16+h)).files)" | head

# 2. 能力面的权威来源：每个包的 lib/typert.host.js（机器可读的调用契约）
#    每个包的 README.md 有人话版签名、参数语义、已知限制
# 3. 线上到底挂了什么：~/.dsh/dsh-remote-control/status.json
```

**`typert.host.js` 是最有价值的发现**：它是 `@deepseek-ai/dsh-typert-generator` 从 FaceModel 生成的，
每个服务/方法都带完整参数与返回 schema。以前我们靠猜宿主有什么（`shapeOf` 那些注释都是这么来的），
其实一直有一份可读清单。

## 一、现状：30 个服务 / 140 个方法，我们只用了 7 个

插件实际触碰的 `services.*`：`agents`、`sessionQuery`、`sessions`、`sessionController`、
`agentDefaultModel`、`workspaceRegistry`、`userQuestions`（外加 `on()` waterfall）。

**23 个服务完全没碰。** 下面是其中对我们产品真正有价值的。

## 二、按价值排序的清单

### P0 —— 直接改善手机端体验

#### 1. `tokenMeter`：上下文占用与 token 用量（`dsh-token-meter`）

```ts
const { totalTokens, surfaceTokens, nodes } = ctx.tokenMeter.measure(session)
const price = ctx.tokenMeter.estimateMessage(message)
```

- **纯进程内服务**，不需要 Remote/网关，我们拿得到（`desktop-runtime.json` 里挂了它）。
- **不发模型调用、不加任何模型可见内容**，只是回放会话日志做确定性测量。
- 手机端现在完全不知道「这条会话快满了没有」。长会话跑到后半段，用户在手机上没有任何信号，
  只能等主机侧自己压缩。接上之后可以在顶栏给一个占用条——**而我们刚把步骤组改成默认收起**，
  正文区腾出来的空间正适合放它。
- 顺带：`llm.resolveModelInfo().context` 能拿到模型真实的上下文上限，
  这样占用条才有分母（现在只能拍脑袋）。

#### 2. `workspace/changes` 事件：本轮改了哪些文件（`dsh-client-ui-deliverables` 证实它存在）

- 宿主桌面已经用它渲染「改动文件卡片」了。**事件我们收到了但落在 `default: return []`。**
- 对手机端的价值：远距离干活时最想知道的恰恰是「它动了我哪些文件」。
  这比读 diff 更省事——摘要都是宿主给的。
- 风险：要确认事件的 data 形状（README 只说了「本轮最新一条宣告」），得先取证。

#### 3. `compaction/start` → `compaction/end`：压缩过程可见（`dsh-command-compact`）

- **这段时间手机上是完全静默的**——没有事件、没有 run-state 变化，
  用户看到的是「模型卡住了」。文档明说：注入的空闲上下文会出现在这两个事件之间。
- 接上之后压缩期间可以给一句「正在压缩上下文」，这是**真话**（README 证实它真的会跑）。

#### 4. `llm/retry` / `llm/retry-started`：模型重试（静默失败变可见）

- 现在的表现：模型卡住 → 用户以为死了 → 可能手动去中断。
  而实际上宿主正在重试。
- 接上之后：「正在重试（第 2 次）」比空白屏有用得多。

### P1 —— 补齐现在的已知短板

#### 5. 文件附件：宿主其实有文件上传通路（`dsh-client-file-upload`）

- 现在文件附件只能「落盘 + 把路径写进 prompt 正文」，用户明确要求去掉这种路径。
- 宿主有 `fileUploads.upload`：**存一份 Blob 拿一个不透明 receipt，
  之后的 prompt 引用那个 receipt**。这正是图片那条路（内容块）的文件版。
- ⚠️ **但那个包叫 `client-` 前缀**：它是浏览器端能力，走认证过的 Web Remote，
  我们的中继链路够不到。**这一条我没验证能通**，只是指出方向——
  接入前必须先确认 mp 侧能不能拿到那条通路，否则又是白做。

#### 6. `session.modelCatalog` / `llm.discoverModels`：模型下拉现在是死的

- `status.json` 里 `modelFace: no-list+no-set via=currentSelection` ——
  **我们只能读到当前模型，列不出候选、也切不了**，所以 mp 那个下拉是置灰的。
- 宿主有 `llm.discoverModels` / `listProviders` / `listConfigurableProviders`。
  如果其中任何一个在真实 runtime 上可用，mp 就能显示「这个会话支持哪些模型」
  甚至直接切换——这是 §1.1 那一串问题（模型按会话）的自然延续。
- 这条**收益大但不确定**，因为 `agentDefaultModel` 那一面确实只有 `currentSelection`。

#### 7. `workspaceFiles.*`：手机上直接看文件（5 个方法）

```ts
stat(path) → { absolutePath, version, bytes? }
read(path, { offset?, limit? }) → 按行分页，永不返回整个文件
readBytes(path, { range?, baseFile? }) → 整文件或有界字节窗口
list(path) → 一个目录的直接子项
changes(path) → 单个文件或目录直接子项的变更流
```

- 宿主自己用它做「网页端预览文件」。**我们没有这个能力，手机上什么都看不了。**
- 产品定位是「临时远离电脑时的手机替代」——想确认某个文件的内容，
  现在必须回到电脑前翻。接上之后会话页加一个轻量文件抽屉，价值很高。
- ⚠️ `read` 永不返回整个文件、`readBytes` 有 `maxBytes` 上限——**这是设计好的闸门**，
  接的时候别想着绕。

### P2 —— 看起来诱人但现在够不到（先记着，别急着做）

#### 8. 语音输入（`dsh-experimental-api-speech-to-text`）

手机替代电脑，语音输入的想象力最大——但 `speech` 是**认证 Web Remote**，
小程序的中继链路拿不到。包名里的 `experimental` 也说明它随时会变。
**结论：这条要等有一条能走的通路再说，现在做不了。**

#### 9. 后台任务 / 终端 / 子代理的可见性

`job.list`、`terminal.*`、`subagents.*` 都在，但它们是**电脑上的东西**：
手机能看不能动，看了也用不上（你在外面没法去敲终端）。
只有一种情况值得做：任务跑了很久，手机上想确认「还在跑吗」——
而这个 `run-state` 已经覆盖了。

#### 10. `settings.*` / `credentials.*`：远程改主机配置

技术上能做，但**安全边界完全不同**：现在的模型是「手机是电脑的遥控器」，
不是「手机是电脑的管理台」。要做的话必须单独设计授权，别顺手就接。

## 三、其余没碰的服务（存档，避免重复调研）

`account.*`（登录/余额，与本项目无关）、`pluginManager.*`（插件管理，危险面）、
`agentPresets.*`（预设，需要 `dsh-agent-preset-registry` 且部署里不一定有）、
`goals.*`（目标，与 todo 功能重叠但语义不同，值得单独看）、
`sessionFeedback.*`（反馈）、`productAnalytics.*`（遥测，**明确不该接**）、
`schedule.*`（定时，宿主自带的调度）、`commands.*`（斜杠命令）、
`dynamicCordisRunner.*`（插件动态加载，危险面）。

## 四、下一步

1. **先做 `tokenMeter`**（P0-1）：纯进程内、无副作用、收益直接，且能顺带解决
   「模型上限是多少」这个我们现在答不出来的问题。
2. 取证三个事件形状：`workspace/changes`、`compaction/*`、`llm/retry`。
   `status.json` 已经证明它们真的在发（unmappedEventTypes 里），
   形状要从真机 session log 里取，不能照 README 猜。
3. `llm.discoverModels` 单独验一次——如果它在真实 runtime 上可用，
   mp 的模型下拉就从「永远置灰」变成真的能用。
4. 文件附件那条（`fileUploads`）**先别动**：它是 client- 前缀的能力，
   在确认 mp 侧有通路之前动手就是白做。

## 五、给自己的两条纪律

- **取证优先于推测**。本文每条都标了出处；下一位别把「看起来能用」写成结论。
- **状态.json 是判据**。新增任何宿主依赖之前，先在 `describe()` 里把它记进去，
  真机上没有它就说不出「是宿主没这个能力，还是我们没调对」。
