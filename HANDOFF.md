# HANDOFF — dsh-remote-control

> 交接给下一位开发 agent。**先读本文，再读代码。**
> 重写于 2026-10-03（上一版内容太长已整体替换；旧文在 git 历史里，`git show d058d8f:HANDOFF.md`
> 能取回，**没有丢**——包括那些一次性取证细节）。

## 0. 一句话状态

产品已经开源成 **GitHub 上四个独立仓**（账号 `providcc`，MIT），四仓 CI 全绿。
**npm 上现在有两个包，且都带 provenance**（2026-10-03 深夜口径）：
`dsh-remote-wire@1.0.1`（协议）与 `dsh-remote-control@1.2.0`（宿主插件），
`/-/npm/v1/attestations/<pkg>@<ver>` 实测都能取到 sigstore bundle。
更早的 `wire@1.0.0`、`control@1.0.0/1.1.0` 是拿 token 发的、**永远补不上 attestation**（npm 既定行为，§3 第 1 条）。
**中继不发 npm**：`dsh-remote-server` 这个包名属于第三方（`bondzhu`/`MRZHUH`，一个走 SSH 执行命令的
无关工具），2026-10-03 试过接发布线之后撤回，细节与留下的闸门见 §9.7。

**伞仓已经不再持有源码副本**：`apps/server`、`packages/{protocol,plugin,presentation}`、`mp`
五棵树已删除（提交 `f5a6853`），代码的唯一事实源就是那四个开源仓目录。伞仓只剩下
**不开源的取证与运维资产**：`e2e/`、`scripts/`、`docs/`、`deploy/`。

生产中继跑的是**开源仓已发布的 v1.0.1 产物**：先 `shasum -c SHA256SUMS` 校验再从 Release 下载，
scp 上线后 `/healthz` 报 `version:"1.0.1"`，重启后 5 秒内 `hosts` 回到 1——"能换"是这么证的。
私有那套 2.x 编号作废，以后只有开源的号。

**配对入口只剩状态栏那颗 pill**（2026-10-03）：右栏自动弹码、终端文本码、`/drc pair` 三条旧路先删，
配置键换成 `pill.enabled`；这一轮（§9.9）又把 **`/drc` 命令整条删掉**、**只允许配对一台**
（新设备进来当场踢掉旧的）、并把弹出面板**重做成精简版**——抬头是状态
（`未配对`灰 / `已配对`绿 / `已断开连接`**红**），右上角**只有一颗按钮**且跟着视图走
（未配对=`生成配对码`、已配对=`退出配对`、出图=`刷新`），下面一行**中继地址**，
**没有**本机名 / 状态 / 已配对那几行、没有「再配一台」、也没有「换一张」（码过期不再自动换）；
配上之后面板从二维码翻回状态视图。宿主侧那四条路由多了一条 `POST …/unpair`。
上一版面板已在真屏幕上复验三次（§9.8，`epoch`/`ETag`/`sha256` 三者原子对上、`problems` 为空）；
§9.9/§9.9.1 那一版第一次复验撞上了"新 JS + 旧 CSS"的错位（已修），§9.9.3 又把正文补成三行。
**这几版都已重装并重启到屏幕上**（那颗 pill 在真屏幕上看得见、抬头是绿的 `已配对`，
`GET …/status` 实测回 `{relay,paired,serverUrl,version}` 四个字段），**只剩"面板正文那三行"
还差人在屏幕上点一下那颗 pill**——这台机器上 Computer Use 走不通（AX 树只交出菜单栏，
截图策略 `AX_ONLY` 让坐标点击一律被拒，见 §9.10 末）。
**审批卡这一轮（§9.10）第一次真机闭环**：手机真的收到 `ev.permission_request`、回了"允许一次"、
主机侧 `approvalDecided=allowed-once`。
这一轮**已经发版的是 1.2.0**（§9.8）：control `1.2.0` 带 provenance 发到 npm（发布运行 14 步全绿，
attestation 已用 curl 复核），`~/.dsh/profiles/desktop` 里装的字节与 npm 上那版一致（§0.2）；
**§9.9 这一版跑在 1.2.0 之后的未发布改动上**，工作树里的版本号还没动。同一轮还把四仓的死代码清了一遍（§9.6），
并撤回了一次中继发包（§9.7）。

> ✅ **e2e 已跑绿**（2026-10-04 凌晨复跑，干净工作树）：`node --test e2e/*.test.mjs` =
> **125 pass / 0 fail**，`node e2e/run.mjs` = **17 步 0 失败**，
> `node scripts/validate-qr.mjs` = 28 组 ×2 产物 0 失败。
> 上一轮只做了"把注释与 import 改指开源仓"，**代码里的路径还指着已删的私有树**，本轮补完：
> `mp/` → `dsh-remote-mp/miniprogram/`、`packages/{protocol,plugin}` → 各开源仓产物、
> 协议层分组（`frames`→`wire/`、`keys`→`crypto/`、`ids`→`identity/`）。
> 期间抓到一条**装置级**缺陷（不是产品缺陷）：帧抓取只装了本文件 import 的那份 `ws`，
> 而插件住在独立 workspace、解析到自己那份物理副本，主机侧帧一条都进不来——
> 症状是"中继日志明明 `pair token issued`，e2e 却说主机没发 hello"。详见 §4 第 10 条。

### 0.1 剩下的事（源码副本已删，开源仓为准）

| 待办 | 现状 |
|---|---|
| ~~移植 `packages/plugin` 的在飞改动~~ | ✅ **已移植**（开源 control 仓 `5bd4227`：宿主注入的 `user/message` 不再冒充用户指令 + 留痕计数，3 条新测试，224 项全绿） |
| 移植 mp 的在飞改动 | ✅ 已移植（mp `aac0f60`，verify/theme:check/contrast 三道闸全过）；presentation 已折进主插件（control `a3025a3`，见 §9.1） |
| 开源仓不含设计文档 | ✅ 已执行（control `a6aebc5` 删掉整个 docs/，连带修好 README 与 feature_request.yml 里会 404 的两处引用）。**保留**：server 仓 `docs/SELF-HOSTING.md`、mp 仓 `docs/ARCHITECTURE.md`、四仓根目录的 README/CONTRIBUTING/CODE_OF_CONDUCT/SECURITY/CHANGELOG |
| 删除伞仓五棵私有树 | ✅ **已删**（提交 f5a6853）；同轮把 e2e/scripts 的 22 个文件改指开源仓，残留私有路径引用 0 |
| 重接 `e2e/`、`scripts/` 到开源仓路径 | ✅ **已跑绿**：路径改完（`run.mjs` 的 `PLUGIN_ENTRY`/`MOCK_KERNEL_ENTRY`、6 个 e2e 文件、`validate-qr/check-mp-ui/mp-shots/mp-upload/mp-lazyload-report`），判据见 §0 的绿框。**顺带删掉伞仓 7 个与开源仓重复的脚本**（`bundle-{plugin,presentation,relay}`、`install-to-profile.sh`、`relay-start.sh`、`check-mp-contrast.mjs`、`gen-mp-theme.mjs`）——唯一事实源在各仓自己的 `scripts/` 里，伞仓那 7 份是改名前的旧副本 |
| 伞仓 `.github/workflows/ci.yml` | ✅ **已删**：伞仓没有 remote 所以它永远不会跑，而且内容描述的还是已删的 `apps/server` 布局；CI 的家在四个开源仓（各自 ci.yml + Release 工作流，全绿）。**代价**：伞仓的 e2e 取证套件从此没有自动闸门，跑与不跑靠人（它需要四棵平行仓在场，GitHub 上拿不到） |
| ⚠️ 协作冲突（已结算） | 并行会话（WorkBuddy）在 `e2e/**`、`scripts/**` 的在飞改动**已随本轮提交进伞仓**（用户 2026-10-03 授权"直接在混合工作树上改并提交"）：含新增未跟踪文件 `e2e/mp-pair-recovery.test.mjs`（新建会话链路取证，16 步里第 7 步的作者就是它）。`.workbuddy/**` 的日志改动**没替它提交**，仍留在工作树 |

并行会话的在飞改动**已整份备份**到 `~/.provid/backups/dsh-umbrella-inflight-20261003.patch`（600，
含未跟踪的新测试文件），生产旧产物也在服务器上留了 `relay.mjs.bak-20261003-075757` 可回滚。

### 0.2 其余三棵树的关系（仍要注意"改哪边"）

| | 版本 | 从哪来 | 现状 |
|---|---|---|---|
| 生产中继 | **`1.0.1`** | `dsh-remote-server/`（开源仓已发布产物） | ✅ 线上字节 = Release 产物（sha256 `45526fd5…180c9` 两边实测相同，2026-10-03 复核） |
| 生产宿主插件 | **`1.2.0`（已发 npm，带 provenance）** | `dsh-remote-control/`（单一 bundle：`index.js` + `client.cjs`） | ✅ `~/.dsh/profiles/desktop` 里装的就是 `1.2.0`（`node_modules/dsh-remote-control/package.json` = `1.2.0`），且两半产物与仓内 `dist/bundle/` **逐字节相同**（`index.js` `058289e3b4dc0…`、`client.cjs` `0dfb8fb44518a…`）。⚠️ **字节哈希随构建方式变**（esbuild 会内嵌 cwd 相关的模块路径标签，§4 第 20 条），所以别拿哈希判"新不新"，判据是版本号 + 解出来的文案（`client.cjs` 里 `未配对`/`已配对`/`生成配对码` 都在）。**要用户重启宿主才在屏幕上生效** |
| 协议 / 小程序 | 开源 `dsh-remote-wire@1.0.1` / mp `aac0f60` | 私有树那两份在飞改动已移植并各自跑绿 | ✅ 私有树删除后唯一事实源就是开源仓；消费仓依赖写的是 `^1.0.0`，`1.0.1` 是区间内的补丁版（无代码变更，只为拿 attestation），**别再引用 `packages/*`、`apps/server`、`mp/` 这些伞仓旧路径** |

## 1. 四个开源仓（这是要长期留存的东西）

| 仓 | 内容 | npm 包 | HEAD（本次） | Release | CI |
|---|---|---|---|---|---|
| `dsh-remote-protocol/` | 线协议纯函数库 | **`dsh-remote-wire@1.0.1`**（用户 2026-10-03 定：**不下**，两边都引用它；`1.0.1` 无代码变更，只为第一个带 attestation 的发布） | `6711808` | **`v1.0.1`**（带 provenance） | 绿 |
| `dsh-remote-server/` | 零知识中继（单文件产物） | **不发**：`dsh-remote-server` 这个包名属于第三方（`bondzhu`/`MRZHUH`），试过又撤回，见 §9.7 | `d174787` | **`v1.0.1`**（挂 `dsh-remote-relay.mjs` + `SHA256SUMS`；线上跑的就是这份字节，见 §0） | 绿 |
| `dsh-remote-control/` | 宿主插件（**只剩 `packages/plugin` 一个包**） | **`dsh-remote-control@1.2.0`**（带 provenance） | `eeddb07` | **`v1.2.0`** | 绿 |
| `dsh-remote-mp/` | 微信小程序客户端 | 不发 | `aac0f60` | 无（用户 2026-10-03 定：mp 只是象征性开源，不打 Release） | 绿 |

三条必须知道的规则：

1. **仓名 ≠ 包名**。协议发到 npm 的名字是 `dsh-remote-wire`——`dsh-remote-protocol` 这个名
   在 npm 上已被第三方占用（发布者 `weijf14-gmail`）。指仓库写 `dsh-remote-protocol`，
   指包写 `dsh-remote-wire`。
2. **control 仓只有一个包**（用户 2026-10-03 拍板并已执行，见 §9.1）。
   `packages/presentation`（包名 `dsh-remote-control-presentation`，原来 `private: true`、不发 npm）
   已折进 `packages/plugin`，界面上那一半的产物现在是同一个 bundle 的两半
   （`dist/bundle/index.js` + `dist/bundle/client.cjs`），一起由
   `dsh-remote-control/scripts/install-to-profile.sh` 装进 profile。
   `pnpm -r publish --dry-run` 只会列出 `dsh-remote-control` 一个——这是可复核的判据。
   **别再把它拆回去**，也别往 npm 加第二个包。
   折并的理由（"宿主缺 `webServer` 时只有那一行不激活"）现在由
   `src/pill/start.ts` 的软探测提供，`tests/pill-isolation.test.ts` 逐字段对照钉住。
   ⚠️ **那一半的内容已经换了**：1.1.0 是"右栏自动弹码"，1.2.0 把它与终端文本码
   一起删掉，换成状态栏那颗 pill——**配对入口只剩 pill，`/drc pair` 已不存在**。
   §9.1 里那些 `sidebar.*` / `/pairing?session=` 的取证是**当时**的事实，别当成现状。
3. **协议是 npm 依赖（`^1.0.0`），不是 git 依赖**。别退回 git 依赖：pnpm 11.7 下 git 包的
   `prepare` 只认含 commit 的精确 `allowBuilds` 键，四种宽松写法全被拒，每次升版都要手改两个消费仓。

**fork 要改的东西**：`dsh-remote-mp/project.config.json` 里的 `appid` 是本项目自用的（仓内 README
第 60-61 行已写明），别人跑自己的必须换成自己的 appid，真机还要在微信后台配 socket 合法域名。

**怎么发一个新版**（`dsh-remote-wire` / `dsh-remote-control`——**只有这两个发包**）：改
`package.json` 版本 → 提交 → 推 main → 打 `v<版本>` 并推标签 → Release 工作流自己跑校验、
发 npm、建 GitHub Release。标签与包版本不一致工作流会主动失败。**中继仓不在这份名单里**：它的
Release 只挂单文件产物 + `SHA256SUMS`，**不发 npm**——`dsh-remote-server` 这个包名属于第三方
（`bondzhu`/`MRZHUH`），2026-10-03 接过一次发布线又撤回，闸门与原因见 §9.7。
**两个发包仓的 Release 工作流末尾多了一步 `Verify provenance landed`**：它发布后去查
attestations 接口，查不到就让工作流红——**工作流绿不等于带 provenance**，这条自检才是判据。
2026-10-03 深夜两个包的 Trusted Publishing 都配好了、两版都带 attestation 发出去（§3 第 1 条）；
这步以后就是常态体检。凭据走 GitHub OIDC，Publish 步骤**刻意显式清空 `NODE_AUTH_TOKEN`**
（不是"不设"：`actions/setup-node` 带 `registry-url` 时会塞一个默认 token 进 `.npmrc`，
pnpm 见了它就会在 OIDC 失败时静默回落成 token 发布）。

## 2. 伞仓里剩下的东西（都不开源，也都不再持有源码副本）

五棵源码树已删除。下面这些是**伞仓独有、开源仓没有**的，别跟着一起删：

| 路径 | 为什么留着 |
|---|---|
| `e2e/` | 全部取证资产：逐字节对拍、本地全链路、生命周期、live-e2e。**开源仓里没有等价物** |
| `scripts/` | `validate-qr.mjs`（改二维码必跑）、`mp-*.mjs` 等 |
| `docs/DESIGN.md`、`docs/DESIGN-REVIEW.md` | 契约表 B1-B9 / F1-F13 / T1-T8、偏离 D1-D9、复核结论。开源仓的 `docs/` 是它们的**换算过名字的历史副本** |
| `docs/HOST-SIDE.md` | **本机宿主侧**手册：profile 安装语义、配置键全表（现在只有 `pill.enabled` 这一族）、`status.json` 字段与本机实测值、pill 那四条路由的 curl 取证配方（含 `epoch`↔`ETag`↔`sha256` 的原子核对与"AX 树不给内容时按像素找那颗 6px 灯"的兜底）、live-e2e 的配对码前置与"改配置要成对还原"。中继侧部署**不在这份里**，权威是 `dsh-remote-server/docs/SELF-HOSTING.md`——伞仓原来那份同名副本（还写着 `apps/server`/`@dsh-rc/*`/`2.0.0`）已删，别再复制回来 |
| `docs/legacy-spec/` | 重写前从旧实现提取的事实档案 |
| `HANDOFF.md`（本文） | 伞仓**没有 remote**，这些提交只在本地 |

同步方法（唯一安全的一种）：`git archive HEAD <path> | tar -x -C <目标>`，取**已提交**快照，
别拿工作区对拷——尤其别把并行会话的在飞改动带进开源仓。

> **两处已知的行号锚烂掉**（同一类病，别新增这种引用）：
> ① `docs/DESIGN.md:239`（伞仓与开源 `dsh-remote-control` 两份都是）
> 用**行号**引用旧交接文 `HANDOFF.md:180-181`，本文重写后那个锚已经指错地方。
> 下次动设计文时把它改成不依赖行号的引用（比如指提交号 `d058d8f` 或指条文名）。
> ② `docs/legacy-spec/relay-and-wireformat.md` 有十几条证据锚写成
> `docs/SELF-HOSTING.md:<行号>`，而那份副本已删除——它们现在指向不存在的文件。
> 档案本身不用改（它就是按当时的实现写的），要读原文用
> `git show b3e1ab2^:docs/SELF-HOSTING.md`（删除前最后一次提交的版本）。
> 下次动 legacy-spec 时把这类锚改成"文件名 + 条文名"，
> **别再新增行号锚**——这类锚点每次重写文档都会烂。

## 3. 待办（按价值排序）

1. **✅ 已解决（2026-10-03 深夜）：两个包都配好了 Trusted Publishing、都带 provenance 发出去了。**
   现口径：`dsh-remote-wire@1.0.1`、`dsh-remote-control@1.2.0` 两版都能从
   `https://registry.npmjs.org/-/npm/v1/attestations/<pkg>@<ver>` 取到 sigstore bundle（curl 实测）；
   control `1.2.0` 的发布运行 14 步全绿（含末尾 `Verify provenance landed`）。
   ⚠️ `wire@1.0.0`、`control@1.0.0/1.1.0` 是拿 token 发的，**已发布出去的版本永远补不上 attestation**
   （npm 既定行为），只能往前发新版——**别在文档里宣称那三个老版本带 provenance。**
   Trusted Publishing 配置命令（两包各一条，中继不在内：它不发 npm，见 §9.7）：
   CLI 要 npm ≥ 11.15（本机 10.9.9，一律 `npx -y npm@12.2.0`），且**需要一次真 TTY 的浏览器 2FA 授权**：
   ```sh
   npm trust github dsh-remote-control --repo providcc/dsh-remote-control --file release.yml --allow-publish
   npm trust github dsh-remote-wire   --repo providcc/dsh-remote-protocol  --file release.yml --allow-publish
   ```
   ⚠️ **协议包必须显式写 `--repo`**：仓名 `dsh-remote-protocol` ≠ 包名 `dsh-remote-wire`，
   不写就会拿 `package.json` 的 `repository.url` 去推——那条指的就是包名对不上的仓。
   GitHub 的 claim 只有 `repository` + `workflow file`（+ 可选 `environment`），
   **没有 tag/分支 pattern 这种东西**（原文里"tag pattern 建议留空"是我说错了）。
   ⚠️ **每个包同时只能有一条 trust 配置**：要改先 `npm trust list <pkg>` 拿 id、
   `npm trust revoke --id <id> <pkg>` 再建新的。
   踩过的两个坑（都别再踩）：
   - **`NODE_AUTH_TOKEN` 在场会静默掩盖 OIDC 失败**。`actions/setup-node` 一旦收到 `registry-url`，
     就把它的 `token` 输入（默认 `github.token`）写进 `NODE_AUTH_TOKEN`、并往 `$NPM_CONFIG_USERCONFIG`
     落一句 `_authToken=${NODE_AUTH_TOKEN}`；pnpm 见了它"先试 OIDC、换票失败就静默回落成 token 发布"，
     表现是**包发出去了、工作流也绿了、attestation 一个没有**（`1.0.0`/`1.1.0` 就这么发的，
     日志里只留一行 `Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE … 404`）。
     两仓 Publish 步骤现在都**显式赋值 `NODE_AUTH_TOKEN: ''`**，把"没有 token 这条路"写死——
     配好 TP 之后 OIDC 是唯一路径，再退回 token 会响亮地失败。
   - **自检窗口给太短会把成功的发布判成红**。协议仓第一版自检只轮询 60s，注册表侧 attestation
     落地比这慢；`1.0.1` **Publish 成功、attestation 也在**，却被自检先判红，
     `Create GitHub Release` 整步没跑。修法：窗口放宽到 200s（`seq 1 40` × `sleep 5`），
     并给 Publish 加幂等检查（版本已在注册表就跳过 publish、继续往下建 Release）。
     那条 Release 已用 `gh release create v1.0.1 --title "v1.0.1" --generate-notes --verify-tag` 补上。
2. **用户应在 npm 站点 revoke 一把旧 token**（`bypass_2fa:false` 那把，曾在对话里贴出来过）。
   它能登录但没有发包权限，仍然是有效凭据。可用的那把在 `~/.provid/env-v3` 的
   `DSH_REMOTE_NPM_TOKEN`（**值绝不写进仓库/文档/测试**），两仓 secret 已经是它。
   本轮用户明确"token 安全问题先不管"，所以这条仍未做——它不是我做完了忘了，是被搁置的。
   **另**：npm 站点顶部横幅（2026-10-03 实测）写着 bypass-2FA token 将在
   2026-08 起限制账号变更、**2027-01 起禁止直接发包**——这把 token 的可用期是有终点的。
   好在发包已改走 OIDC（Trusted Publishing，§3 第 1 条），两仓 Release 不再需要 `NPM_TOKEN`；
   仓库里那个 secret 现在只是历史遗留，撤销与否不影响发布。
3. **`droppedFrames` 查不到历史，因为中继压根不为丢帧写日志**（本轮把这条查清了，推翻了原来的说法）。
   原文写的是"去服务器 `journalctl | grep -c "frame dropped"`"——**那个 msg 串在代码里不存在**
   （全仓 grep `frame dropped` 为空）。四处计数点
   `dsh-remote-server/src/server.ts:341/360/377/387` 都只 `counters.droppedFrames += 1`，
   其中两处注释就写明"它在日志里不留痕，只能靠这个计数被发现"。
   所以：**journalctl 查不到，/healthz 只在当前进程内有值**，想要历史必须自己落计数快照。
   本轮实测：线上 `version:1.0.1`、`droppedFrames:56`（uptime 6294s），空载 30 秒不涨
   （56 → 56），也就是说丢帧集中在**活动窗口**而不是稳态。
4. **✅ 已解决（2026-10-04 凌晨，见 §9.11）：宿主身份不再每次加载换一个。**
   原来 `packages/plugin/src/index.ts` 是 `hostId: config.hostId || 'h_' + randomBytes(3)`，
   而 profile 那条 config 里**没有 hostId**（默认 `''`）。实测线上 5 分钟内出现三个 hostId
   （`h_c2073b` → `h_051405` → `h_0919dc`），中继日志每一次都是 `host online … replaced:0`
   （**换了身份所以顶不了号**，旧 socket 只能等宽限/清扫）——这与 3 里那些丢帧是同一个形状。
   修法是代码侧的（不是改 profile）：**配置 > 磁盘旧值 > 现造并落盘**，落点
   `~/.dsh/dsh-remote-control/host-id`（0600，已存在绝不改写，老的 `h_xxxx` 读到了继续用）。
   真机复验：两次重启都是 `drc-748e9a9ce167`，`live-e2e` 第 ④ 条现在念得出
   "已配对到 drc-748e9a9ce167"。`status.json` 也新增了 `hostId` 字段。
   ⚠️ 这一条**不解决 3**：`droppedFrames` 的历史仍然只有当前进程内有值（中继不为丢帧写日志），
   要历史得自己落计数快照——那是中继侧的活，还没做。
5. **Dependabot 已逐个审过，判定写在 §9.2**（四仓共 19 个开放 PR）。
   一句话结论：红色的多数是**分支基线陈旧**（旧 `ci.yml` 里 pnpm 还写 `version:`、node20 直绑工具链），
   不是依赖不兼容；唯一真实的不兼容是 **typescript 7**：协议仓的 `tsc` 不再自动纳入 `@types/node`
   （`Cannot find name 'TextEncoder'` 一类），加一行 `"types": ["node"]` 就修好，且对 TS 5.9 中性。
   **本轮没有合任何一个**（用户只要证据清单）。
   **2026-10-04 凌晨复看（只读，没动任何 PR）**：还是 19 个开放。协议仓那 5 个的 CI 在
   **5~6 秒就红**，`gh run view --log-failed` 的原文是
   `…version pnpm@11.7.0 in the package.json with the key "packageManager" / Remove one of these
   versions to avoid version mismatch errors like ERR_PNPM_BAD_PM_VERSION`
   ——**死在装依赖之前**，所以"typescript 7 不兼容"这一条现在**没法从 CI 上读到**（它只在本地验过）。
   顺带一条坑：`gh pr list --json mergeable` 会返回 `UNKNOWN`（GitHub 是惰性算的），
   第一次查报"3 个不可合"，隔几秒再查同一批全是 `MERGEABLE`——**别拿一次 `UNKNOWN` 当冲突证据**。
   要让这些 PR 变绿，动作是"把 PR 分支更新到最新 base"（`gh pr update-branch`），
   那是改别人看得见的状态，**等用户点头再做**。
   **✅ 那条"唯一真实的不兼容"已经修掉了（协议仓 `7625747`，2026-10-04 凌晨）**：
   `tsconfig.json` 加 `"types": ["node"]`。数字是实测的——本仓 main 在
   `npx -y -p typescript@7.0.2 tsc --project tsconfig.json --noEmit` 下报 **40 个错**
   （`Cannot find name 'node:crypto'` / `'TextEncoder'` / `'Buffer'` / `'URLSearchParams'`，
   另有几条 `possibly 'null'` 是这些类型缺失的下游），加完这一行 **0 个错**，
   而仓里自己的 TypeScript 5.9 行为不变（`pnpm typecheck` + 82 项测试照旧绿、`format:check` 绿）。
   ⚠️ 复现这条要用 `npx -y **-p** typescript@7.0.2 tsc …`：写成 `npx typescript@7.0.2 tsc …`
   会把那个 `tsc` 当成**源文件**传给默认 bin，于是得到一句毫不相干的
   `TS5042: Option 'project' cannot be mixed with source files`——我第一遍就被它骗过。
6. **✅ 审批卡已真机闭环（2026-10-04 凌晨，见 §9.10）**；**还欠一条：提问卡**。
    审批那条以前"没弹"不是策略问题也不是手机问题，是我们登记 `approval/request` 的方式
    （要 `{global:true, prepend:true}`），修法与读数都在 §9.10。
    提问卡仍未取证的原因是**宿主版本**：这一代 `ctx.userQuestions` 不带 `registerProvider`，
    而且 `takeOverQuestions` 默认关（开了会剥夺桌面 UI 的提问能力）。两条都有本地闭环测试。
    ⚠️ 别把审批策略改回 `never` 来"排除干扰"——用户已表态，**别再问第二遍**。
7. **✅ `dsh-remote-control@1.2.0` 已发布**（2026-10-03 深夜，pill 收敛 + §9.6 那轮清理 + §9.8 文案都在里面）。
    发布运行 14 步全绿、带 provenance（注册表 curl 复核过），GitHub Release `v1.2.0` 已建。
    pill 的真屏幕复验做了三次（§9.5/§9.6/§9.8）。
    **剩下要人做的**：重启本机那个 Harness（DeepSeek Harness.app），profile 里装的 `1.2.0` 字节
    才会在屏幕上生效——**动手前问一句**（那是用户正在用的应用）。

## 4. 环境坑（每条都是踩过的，新版）

1. **`env -u NODE_OPTIONS` 必须带**。Qoder CLI 会往子 shell 注入 `NODE_OPTIONS=--require .../cjs-js-proxy-registry.js`，
   Node 22 的 ESM loader 解析不了，任何要解析依赖的 pnpm 调用都会挂。
2. **pnpm 11.7 要求 Node ≥ 22.13**（它 `import 'node:sqlite'`）。CI 矩阵里 `node: '20'` 那条
   **从来没绿过**：job 在 `actions/setup-node` 的 `cache: pnpm` 步骤就死了，还把 Dependabot PR 一起带红。
   已修的形态：**装/查/打包固定走 22，只把 `node --test` 跑在矩阵版本上**——`engines` 声明
   `>=20` 这条杠不许为了绿而删。三仓同一个形状。
3. **`node --test` 的位置参数语义在版本间变过**：node 20 当**字面路径**（glob 直接 `Could not find`），
   node 22 才当 glob；`node --test <目录>` 在 22 上又变成"把这目录当模块 require"。
   三仓统一 **`find ... -print0 | xargs -0 node --test`**，并**先断言文件数非零**——
   否则命名一改就"跑 0 个测试然后绿"，那是最坏的一种通过。
4. **`pnpm/action-setup` 里不能再写 `version:`**（与 `packageManager` 冲突 → `ERR_PNPM_BAD_PM_VERSION`）。
5. **`format:check` 覆盖 workflow 的 yml 与 markdown 表格**。改完 README/表格要先 `prettier --write`。
   验证用**干净环境**（`git archive HEAD | tar -x` 到伞仓之外），否则 pnpm 会向上走到伞仓的
   `pnpm-workspace.yaml`，跑的不是 CI 那套。
6. **`git push` 的通道**：这台机器 `github.com:443` 被墙（`api.github.com` 正常），本机默认可用的
   SSH key 属于**已封禁**账号 `linbin66`。方案：每仓一把 write deploy key
   （`~/.ssh/id_ed25519_providcc{,_server,_control,_mp}`），remote 走 `git@ssh.github.com:443`，
   各仓 `core.sshCommand` 指定 `-i`。**一把 deploy key 只能挂一个仓**（挂第二个报 `key is already in use`）。
7. **测试引的是 `dist/` 产物**，必须走包自己的 `test` 脚本（它先 build）；直接 `node --test`
   会在 dist 陈旧时给你**假红**。
8. **profile 里的 `node_modules/dsh-remote-control` 必须是真目录**，且 `package.json` 里不能留 `file:` 依赖
   ——那会让宿主里同时跑**两个插件实例**（两个 hostId、两份会话），`status.json` 的计数来自另一个实例，
   排查会一直被误导。改代码后必须**重启 Harness**；浏览器面还要**重新加载页面**。
9. **同一工作树有第二个 agent 在跑**（`fullAccess`）。截至本文写下时它在飞的改动：
   `mp/**`、`e2e/**`（含新文件 `e2e/mp-pair-recovery.test.mjs`）、`packages/plugin/{src,tests}/platform/carrier*`、
   `scripts/mp-*.mjs`、`.workbuddy/**`。**别替它提交**，也别跑全量 build 打断它。
   —— 2026-10-03 本轮：该会话已无进程（最后写入 08:21），用户授权后 e2e/scripts 的在飞改动**已替它提交**，
   只剩 `.workbuddy/**` 仍在工作树里没动。
10. **进程里现在有两份物理的 `ws`，观察缝必须都装**。私有树时期 e2e 与插件同属一个 pnpm workspace，
    `ws` 去重成同一个文件，`WebSocket.prototype` 打一次补丁两侧都看得见。开源改造后插件住在
    `dsh-remote-control/`（独立 workspace、独立 store），它 `import 'ws'` 拿到的是
    `dsh-remote-control/node_modules/.pnpm/ws@8.22.0/…`——**与 e2e 那份是两个不同的类对象**。
    于是 `e2e/run.mjs` 的帧抓取对主机侧完全失明：`tap.frames` 是空的，报出来的却像产品缺陷
    （"主机没发 hello""等不到 pair-ready"），而中继日志里 `pair token issued` 明明在跳。
    现在的装法是**按被测产物实际解析到的位置取副本**（`createRequire(PLUGIN_ENTRY)('ws')`），
    装不上就抛——少装一份等于把主机侧断言全变成"看不到帧"，那是最坏的一种通过。
    **同类坑还在**：`qrcode`/`tweetnacl` 也是两份副本，将来谁想用 prototype 补丁观察它们，得同样按位置取。
11. **shell 里的 `node -e "…"` 是一整段双引号字符串：JS 里出现英文双引号会把脚本提前截断，而退出码仍是 0**。
    `install-to-profile.sh` 的注册步骤真实踩过：我在 JS 注释里写了一条 `"bundle 在列表里但目录已删"`，
    shell 在第一个内层 `"` 就收了尾，剩下的 JS 变成 node 的位置参数被丢弃——脚本照常打 ✅、照常写备份，
    **退役条目却一条都没摘**（`ls` 才看见旧 bundle 还在）。现在那段改成不带引号的 heredoc
    （`<<NODEJS`；`$PROFILE` 这类变量仍会在传进去之前展开）。
    这条的教训形状比修法更值钱：**"脚本跑完 + exit 0"不等于"它要做的事发生了"**，
    判据必须落在被改的对象上——本轮的变异验证是把退役条目与目录**回插**再跑，看它是否真删。
12. **别在 `git push` 前面临时加 `GIT_SSH_COMMAND`——它会盖掉已经配好的 `core.sshCommand`，
    于是 ssh 递出 agent 里那把个人号 `linbin66` 的钥匙，GitHub 回 `ERROR: Your account is suspended`。**
    这条报的是"递错钥匙"，不是 providcc 被停：`ssh -T -p 443 git@ssh.github.com` 会回 `Hi linbin66!`，
    而 `gh api user` 仍正常返回 `providcc`（两套凭据互不相干）。四仓的 `core.sshCommand` 里已经
    按仓钉好 `-i ~/.ssh/id_ed25519_providcc_<仓> -o IdentitiesOnly=yes -p 443`，**直接 `git push` 就行**；
    真要手工指定也只写 `GIT_SSH_COMMAND` 的完整版（带 `-i` 与 `IdentitiesOnly`）。
    伞仓没有 remote，永远不需要推。
13. **桌面宿主的转发层会把 `origin` 头删掉**（2026-10-03 真机量出来的：pill 发码那条请求进来时
    `origin` 是空的，而文档 origin 明明是 `dsh-app://app`）。后果分两种，都得记住：
    ① **只读路由**能活，是因为它的判据本来就允许 Origin 缺席；② **会改状态的路由**如果照抄
    "Origin 必须存在"，在真机上永远 403，而表现是"按钮渲染得好好的、点下去没反应"。
    跨站判据因此换成"只有同源脚本发得出的自定义头"（`x-drc-pair`，见 `pair-actions.ts` 文件头）：
    跨站要带它必然触发 CORS 预检，而这条服务不响应 OPTIONS、也不发 `Access-Control-*`。
    **推论**：给宿主加任何写路由，都别拿 `Origin` 当唯一凭据；并且**403 回答里要写清是哪一道拒的**，
    否则这类问题在浏览器面里根本查不到（宿主 stdout 不落盘，`~/Library/Logs/DeepSeek Harness/` 只有 crash 日志）。
14. **`perl -pi -e "s/A/B/"` 的模式里带未转义的 `|` 会把整个文件毁掉**——它匹配到空串，于是给
    **每一行**都前缀上替换文本。本轮真毁过一次 `README.md`，靠"改动已提交"用 `git checkout --` 拉回。
    改文档一律用编辑工具，非要批量就跑一次 `wc -l` + `head -3` 看有没有被前缀。

15. **`pnpm build` 不清 `dist/`，于是删掉的测试还会继续"通过"**。`test` 脚本跑的是
    `node --test "dist/tests/*.test.js"`，而 tsc 只覆盖不删除——2026-10-03 删掉右栏与文本码那两条路时
    连带删了 6 个测试文件，`pnpm test` 仍报 **337 全绿**，其中 **72 项跑的是已经不存在的源码编出来的
    旧 JS**。逐文件数一遍 `^test(` 与 TAP 的 `ok` 条数对不上才暴露。
    已修：`build` 现在先跑 `pnpm clean`。**推论**：报测试数之前先确认产物目录是干净的，
    删过文件的仓库里"绿"和"绿的是当前代码"是两件事。

16. **把 `inject` 闸门清空，等于把 `apply()` 的时机提前**（2026-10-03 同一轮里两侧各栽一次）：
    宿主侧 `webServer` 与浏览器侧 `slots` 都是 `ctx.inject` 的回调**晚到**才给的服务。
    ①宿主侧 `warn:pill` 原来在 apply 里一次性 push，成为"路由已 `registered` 却仍报配对入口不可用"
    的永久假警报 → 改成每次写快照现判（`state()` 里），并给假 ctx 加 `lateWeb`/`flushInject` 演晚到。
    ②浏览器侧 `mountPill` 原来只软探一次就返回，删掉右栏时把 `inject: ['sidebarRight']` 改成 `[]`，
    那颗 pill 在真机上**整颗不出现**。**这条我第一次没修对**：只加"软探测 + `ctx.inject(['slots'])`
    晚到补挂"之后 262→263 项单测全绿，屏幕上仍然什么都没有——因为真正决定时机的是模块那句
    `inject` 声明。按宿主自带模板 `templates/decoration/client.js`（`inject: ['slots']` +
    `ctx.slots.inject(...)`）改完，pill 才回到屏幕上，点下去出 QR + 6 位码 + 倒计时，
    `epoch`/`ETag`/`sha256` 三者原子核对上（`ff5d01936e40437d` / `057482`）。
    **推论两条**：软探测要配"晚到补挂"，但**别指望它能替代闸门**——要"服务到位之后再激活"就声明它；
    而只有一个**同步返回服务的假 ctx** 的 fixture 抓不到这类 bug（"绿"和"绿的是当前代码"是两件事，
    见第 15 条；这里还要再加一条："绿"和"绿的是屏幕上的东西"也是两件事）。
    现在两侧假 ctx 都能演晚到：`pill-isolation.test.ts` 的 `lateWeb`/`flushInject`，
    `client-bundle.test.ts` 的 `lateSlots`/`flushInject` + `ctx.slots` 那个 getter。

18. **`api.npmjs.org/dependents` 已经退役，对小包一律 404——那不是"没人依赖"。**
    2026-10-03 我据此说过 `dsh-remote-wire` "0 反向依赖"，被用户当场质疑后查注册表才发现：
    已发布的 `dsh-remote-control@1.0.0/1.1.0` 的 manifest 里明明白白写着
    `"dsh-remote-wire": "^1.0.0"`。**判断"有没有人依赖一个包"的可用镜头只有两个**：
    `curl -s https://registry.npmjs.org/<自己的包>/<版本>` 读它的 `dependencies` 字段，
    以及"谁 import 这个符号"的全仓 grep。`https://api.npmjs.org/downloads/...` 同样会返回
    `package not found`（对零下载的新包），**空结果先问是用什么 lens 得到的**。
19. **`files` 白名单写一个不存在的路径，npm 不报错，只是静默不打包。**
    同一轮里我把 `"SELF-HOSTING.md"` 写进 `files`，而它实际在 `docs/` 下——`npm pack` 退出码 0，
    清单里就是没有它。发现方式是 `npm pack --dry-run` 的逐行清单（**别用 `tail`，前几行会被切掉**）。
    判据两条：`npm pack --dry-run` 输出里逐项都在，以及测试里对 `pkg.files` 每一项跑一次
    `existsSync`。同理 `bin` 指的文件必须真的在 `files` 里，否则装出来是个空壳。

17. **删"防御性代码"之前，先问另一侧实现怎么处理同一个输入**（2026-10-03 晚删错一次）。
    协议仓 `normalizePairingToken(raw: string)` 开头的 `String(raw ?? '')` 看着像"替违反类型的
    调用方兜底"——类型是 `string`，`?? ''` 永远走不到。删掉之后伞仓 `e2e/protocol.test.mjs` 的
    "fixtures：配对码归一化两侧相同"**立刻红**：那条 fixture 故意把 `null` 映射成 `undefined` 喂进来，
    要的就是两侧同返回 `''`；而小程序侧 `codec.js` 写的是 `String(text || '')`，函数文档也明写着
    "任何不合法输入返回 null"。**它不是防御，它是对拍契约的一条腿。**
    判据：单仓内部"类型上不可能"的兜底可以删；**只要这个名字同时出现在另一份实现（小程序 JS、
    线上产物、对拍 fixture）里，就先当成契约**，要动就两侧一起动。同类需要先看证据再删的三处：
    中继 `bucketAt()` 越界抛、`noteBackpressure` 的 `bufferedAmount ?? 0`、`run.mjs` 的
    `importBuildArtifact` 重试（防的是本机并行会话清 `dist/`）。
20. **产物的 sha256 不是"代码变没变"的判据——同一个 commit 换一次构建就可能换哈希。**
    esbuild 会把依赖的模块路径标签内嵌进 bundle，于是"在 `packages/plugin` 里 build"与
    "从伞仓根跑 `install-to-profile.sh`"出来的两份 `bundle/*.js` **内容语义相同、字节不同**。
    2026-10-03 深夜就栽在这上面：屏幕上验过的那版 `client.cjs` 是 `9328b1e5…`，
    发布时 `prepare` 重新构建、装进 profile 的是 `0dfb8fb4…`，两边**其实是同一份源码**。
    **判据换成**：版本号（`node_modules/<pkg>/package.json` 的 `version`）+ 解出来的文案
    （挑一个只有新版才有的中文串，注意 esbuild 把非 ASCII 转成 `\uXXXX`，要 `String.fromCharCode`
    解码后再 grep）。`shasum` 只能用来判"同一台机器、同一条命令产出的两份是不是同一份文件"。

## 5. 命令速查

```sh
# 开源四仓（每仓各跑各的，都在自己的 pnpm-workspace.yaml 里）
cd dsh-remote-server  && env -u NODE_OPTIONS pnpm install --frozen-lockfile && env -u NODE_OPTIONS pnpm test
cd dsh-remote-control && env -u NODE_OPTIONS pnpm install --frozen-lockfile && env -u NODE_OPTIONS pnpm test
cd dsh-remote-protocol && env -u NODE_OPTIONS pnpm test

# 发布（改 package.json 版本 → 提交 → 推 main → 打标签）
git -C dsh-remote-control tag -a v1.0.1 -m '...' && git -C dsh-remote-control push origin v1.0.1
gh run watch --repo providcc/dsh-remote-control          # 看 Release 工作流
curl -s https://registry.npmjs.org/dsh-remote-wire | head -c 200


# 生产与伞仓资产（取证/运维，伞仓已不含源码树）
curl -s https://drc.provid.cc/healthz                    # 线上真相（现在=开源仓已发布产物 version 1.0.1）
cat ~/.dsh/dsh-remote-control/status.json                 # 插件侧真相
env -u NODE_OPTIONS node e2e/run.mjs                      # 本地全链路
env -u NODE_OPTIONS pnpm -r test                          # 伞仓闸门 = e2e 全部 *.test.mjs + run.mjs
env -u NODE_OPTIONS npm --prefix dsh-remote-mp run check   # 小程序三道闸（verify/theme/contrast）
env -u NODE_OPTIONS node scripts/validate-qr.mjs          # 动过二维码必跑（28 组 ×2 产物：PNG 与裸矩阵）
gh pr list --repo providcc/dsh-remote-server --state open # Dependabot 积压
```

## 9. 本轮已定与剩余（2026-10-03 深夜收口）

**已做完并有证据的：**

| 事 | 证据 |
|---|---|
| 中继版本尾巴收掉：发 `v1.0.1`，并把**已发布的产物**部署上线 | Release v1.0.1 带 `dsh-remote-relay.mjs` + `SHA256SUMS`；`shasum -c` OK 后才 scp；线上 `/healthz` 报 `version:"1.0.1"`、`hosts:1`（重启后主机自动重连成功） |
| 插件的"假事实"bug 移植进开源仓 | control `5bd4227`，224 项全绿，CI success |
| mp 的在飞改动移植进开源仓 | mp `aac0f60`：`npm run check` 三道闸全过（verify / theme:check / contrast 242 组达标），私有标识符扫描为空 |
| **e2e 跑绿**（§0 那条警告已消） | 伞仓 `cb5297f`：`pnpm -r test` = 112 pass / 0 fail + 全链路 16 步 0 失败；`validate-qr` 28 组 ×3 产物 0 失败。顺带抓到并修掉"帧抓取只装了一份 `ws`"那条装置级缺陷（§4 第 10 条）。
      **这行是当时的数**：文本码删除后 validate-qr 变成 ×2 产物，全链路 17 步、e2e 单测 113（现值见 §0） |
| **presentation 折进主插件，control 仓只剩 `packages/plugin`** | control `a3025a3`（`feat!`，版本 `1.1.0`）：`pnpm typecheck && pnpm -r test` = **280 pass / 0 fail**，`format:check` 过；隔离由 `src/presentation/sidebar.ts` 软探测 + `tests/presentation-isolation.test.ts` 逐字段对照提供（没有 webServer / 正常 / `register()` 抛错三种形态都覆盖）；`install-to-profile.sh` 改成一个 bundle 并退役旧条目；CI 产物校验点名 `client.cjs` |

**同一轮做完并有真机证据的（2026-10-03 上午）：**

| 事 | 证据 |
|---|---|
| `dsh-remote-control@1.1.0` 发出去了 | 标签 `v1.1.0` → Release 工作流 success → `npm view dsh-remote-control versions` = `[1.0.0, 1.1.0]`；`npm pack` 解包核对：tarball 只有 `dist/bundle/{index.js,client.cjs}` + `cordis.patch.yml` + `LICENSE`，232 KB；**provenance 没挂上**（§3 第 1 条附日志原文；这一版永远是裸的，provenance 从 `1.2.0` 起才有） |
| 1.1.0 装进真宿主 profile | `sh dsh-remote-control/scripts/install-to-profile.sh` → `node_modules/dsh-remote-control/package.json` 里 `version:"1.1.0"`、`dsh.client.platform:"web"`、`exports` 含 `./client`；退役条目连目录一起摘掉（**这条做过变异验证**：回插后再跑，脚本把它删掉） |
| **live-e2e 真机全绿** | `node e2e/live-e2e.mjs --rounds 2` → **合计 36 项检查，通过 36，失败 0**（真中继 `wss://drc.provid.cc` + 真内核 `carrier=services`）：配对→会话列表 14 条→发指令回合跑完（`done:true`、正文非空）→防休眠 `backend=caffeinate`→零知识（上行 3 帧 enc、经中继无明文）→解配 `needs-pair` |
| **右栏那条路由在真宿主上取证**（⚠️ 该方案已在同日 `[未发布]` 里删除，这行是当时的取证） | `GET http://127.0.0.1:19387/plugins/dsh-remote-control/pairing?session=<真会话>` → `{"state":"ready","epoch":"575e1d4172857484",address:"dsh-resource://file/session/…//Users/linbin/dsh-remote-control/.dsh/sidebar-qr.png",expiresAt:…}`；zxing 解出落盘 PNG（392×392，0600）→ **解出文本的 sha256 前 16 位 == 路由给的 epoch**，且与 `status.pairing.qr` 逐字节一致；负面四条也实测：非环回 `Host` → 403、跨站 `Origin` → 403、缺 `session` → 400、**旧包路径 `/plugins/dsh-remote-control-presentation/pairing` → 404** |
| 线上中继"发布的就是在跑的" | Release `v1.0.1` 下载 + `shasum -a 256 -c SHA256SUMS` OK；与服务器 `/opt/dsh-remote-control/server/relay.mjs` 的 `sha256sum` **完全相同**（`45526fd5…180c9`）→ 本轮中继侧无需重部（control 的改动不碰中继产物） |
| 临时改的配置已还原 | 为让 live-e2e 能自动取真码，临时在 profile 的 patch 里加了 `pairOnStartSec: 120`；**跑完立刻删掉并重启宿主**，现在 `grep -c pairOnStartSec cordis.patch.yml` = 0、`status.json` 的 `pairing:null`、`problems:[]` |

### 9.2 Dependabot 审计结论（19 个开放 PR，本轮只出证据、一个都没合）

审法：不看 dependabot 分支的红绿（那些分支的 `ci.yml` 是旧的，混杂了工作流问题），而是
**取各仓当前 main 的快照**（`git archive main`）到 `/tmp`，只改 `package.json` 里那一行依赖，
重装 lockfile 后跑仓里现在的闸门。这样"依赖不兼容"与"分支陈旧"才分得开。

| bump | 实测（main 快照 + 只换这一个依赖） | 判定 |
|---|---|---|
| typescript 5.9.3 → **7.0.2** | 协议仓：`tsc -p` 报 `TS2591 Cannot find name 'node:buffer'`、`TS2304 Cannot find name 'TextEncoder'/'TextDecoder'`（`@types/node` 不再被自动纳入）；**加 `"types": ["node"]` 后 TS7 与 TS5.9 都绿**（两个版本各跑一遍，所以这条改动是版本中性的）。中继仓：typecheck PASS + 78 项（1 skip）PASS。插件仓：PASS + **280 全绿** | **先给三仓 tsconfig 补 `"types": ["node"]` 再合**；不补就合 = 协议仓 CI 必红。这是本轮唯一的**真**不兼容 |
| @types/node 22.20.4 → **26.6.3** | 协议 82 全绿 / 中继 78（1 skip）全绿 / 插件 280 全绿 | 可合（红的那些是分支工作流陈旧） |
| esbuild 0.27.7 → **0.28.2** | 中继：PASS，含 `bundle-relay` 与 Node 20 空目录起单文件产物的 smoke。插件：PASS，bundle 断言都在 build 里 | 可合 |
| actions/checkout 4→7、actions/setup-node 4→7、pnpm/action-setup 4→6 | 纯 CI 版本跳。红的原因实测到位：control#3 的失败日志是 `Dependencies lock file is not found`（分支从"加 pnpm-lock.yaml"之前切出），node20 作业是 `This version of pnpm requires at least Node.js v22.13` + `No such built-in module: node:sqlite`（旧 `ci.yml` 把 matrix 版本直绑到工具链）。mp 那两个、以及各仓刚被 dependabot 更新过分支的那几个已经全绿 | **rebase 到 main 即可**，不是依赖问题 |

### 9.3 还欠着的

1. ~~Trusted Publishing~~ **✅ 2026-10-03 深夜已解决**（§3 第 1 条，两包都配好并发出了带 provenance 的版本）。
2. **`hostId` 那条配置**（§3 第 4 条）：一行 patch 就能让宿主身份稳定，但那是改用户线上配置，等他点头。
3. **审批卡 / 提问卡的真机取证**（§3 第 6 条）：原因仍是本机 `approval/policy: never` 与这一代宿主没有
   `registerProvider`，**别再问第二遍**；两条都有本地闭环测试。
4. **`dsh-remote-mp` 不打 Release**（用户 2026-10-03 定："只是象征性的开源"），原来的"要不要打 v1.0.0"这条待办作废。

### 9.4 「点一下配对」落地（2026-10-03，当时 control 仓还是 `[未发布]`，现已随 `1.2.0` 发布）

用户两条拍板：`/drc pair` **去掉**，改成点状态栏那颗 pill；二维码**放在弹出窗里**；
但"仅 pill 不可用时才把 `pair` 注册回来"这个兵分要保留。做成了：

| 事 | 证据 |
|---|---|
| 宿主侧多三条路由 | control `packages/plugin/src/presentation/pair-actions.ts`：`POST /pairing/new`（幂等；跨站判据是同源才发得出的 `x-drc-pair` 头，**不是** `Origin`）、`GET /pairing.png`（现渲染、`no-store` + `ETag`）、`GET /status`（当时的字段是 `relay`/`paired`/`hasCode`，`hasCode` 已在 §9.8 换成 `hostLabel`/`serverUrl`）。测试 **319 pass / 0 fail**：`presentation-pair-actions.test.ts` 22 条（含"回答里不许出现 `psk`/完整 URI"这条红线、注销一条抛错仍摘掉其余）、`presentation-isolation.test.ts` 的"兵分/接线/只挂上右栏那条"三条、`presentation-client-bundle.test.ts` 那 13 条 pill 用例 |
| `/drc pair` 降成兜底 | 判据是 `sidebar.available`（右栏那条 + pill 三条**全挂上**才算）。挂不上时 hint 自动把 `pair` 加回来；挂上了 `pair` 只指路、**不顺手发第二张**（那会绕开幂等）。`/drc pair force` 是"路由在、pill 因为宿主给不出 `react`/没有 `slots` 而没出现"时不能堵死的退路，走的仍是幂等入口 |
| 新功能不许砸老功能 | pill 那三条单独一个 `try`（`sidebar.ts`）；浏览器面拿 `react` 走**运行期**（`client/src/pill.ts` 文件头第 2 条），`inject` 仍只声明 `sidebarRight` |

变异验证一共做过九刀，每一刀都被对应的测试或 build 断言拦下：放松 Origin 判据 / `available` 忽略
actions / 删掉 `pair` 的 pill 分支 / 把 200+`unavailable` 当成功 / `inside()` 全判"在外面" /
倒计时到点不再发码 / 源码里改用静态 `require("react")` / **删掉 `x-drc-pair` 那道判据** /
**把"Origin 必须存在"加回来**（后两刀各被 2 条与 5 条测试接住，第二刀那 5 条里就包括真机形状那条）。
⚠️ 之前还踩了一记空刀：用 `if (false)` 让分支失效会被 tsc 先拦下，于是**产物没变而测试
"照绿"**——变异必须改成能编译的形状，否则测的是上一个产物（同类坑见 §4）。

**pill 已在真屏幕上验过（2026-10-03 下午，本机 profile + 生产中继）：**

`install-to-profile.sh` → 重启宿主 → 无障碍树里那颗 pill 就在输入框那一排（排在 provider-usage
右边），抬头随 `/status` 变；点开是 `dialog dsh-remote-control 配对` + `image …/pairing.png?e=<epoch>`
+ 6 位码 + "1 分 59 秒后过期" + "换一张"，Escape 收得掉。**原子核对**：dialog 图片 URL 的 `?e=`、
`pairing.png` 回的 `ETag`、解码落盘 PNG 得到的文本的 `sha256` 前 16 位三者相同（实测
`eaa212225608605a`，QR 里的 `t=` 与屏幕上那 6 位一致）。同一次点击之后右栏也照常开出了
`sidebar-qr.png`。守卫侧也实测：无 `x-drc-pair` → 403 `pair-marker-missing`、跨站 Origin → 403
`origin-not-trusted`、GET 打写路由 → 405、非环回 Host → 403、连点两次 epoch/token 不变。

⚠️ **这一轮真机验出来一个纯本地测试抓不到的缺陷**：第一版把写路由的跨站判据写成"Origin 必须
存在且环回"，而桌面宿主的转发层会**删掉 `origin` 头**——于是 pill 渲染得好好的、点下去永远 403。
把"是哪一道守卫拒的"印进 403 回答（再让 pill 把它显示出来）才查得出来；这条判据现在的形状与
它为什么不能是 `Origin`，都写在 `pair-actions.ts` 文件头与 `docs/HOST-SIDE.md` §6.1。

### 9.5 收敛成"只有 pill"（2026-10-03，control 1.2.0，现已发布）

用户拍板："清理掉之前的 sidebar 方案和 ansi 方案，只保留这个 pill"。三问三答定了边界：
`/drc pair` **全删**（配对只有 pill）、配置键**改名成 `pill`**（旧键不静默失效）、
`PairingWindow` 那条"屏幕上永远有一张码"的自动续码**保留**。

| 删掉的东西 | 连带 |
|---|---|
| 右栏自动弹码 | `src/presentation/{address,presenter,route,sidebar}.ts` 四个模块（守卫与 `pairingEpoch` 搬进 `pill-routes.ts`）、只读路由 `GET /pairing`、浏览器面 `sidebarRight` 轮询、`<workspace>/.dsh/sidebar-qr.png` 落盘、`config.sidebarQr.*`、`status.json` 的 `sidebar` 探针，以及**为算那个落点而开的内核口**：`provide('dshRemoteControl').sessionWorkspace` + `kernel.sessionWorkspace` + 诊断字段 `kernel.workspaceFace`（pill 的图是路由当场渲染的，不写磁盘，所以这条路上一个调用方都不剩） |
| 终端文本码 | `platform/qr.ts` 的 `renderTerminalQr` 与 `ascii`/`block`/`half` + ANSI、`config` 的 `qrImage`/`qrOpen`/`qrAnsi`/`qrStyle` 与四个 `DRC_QR_*`、`pairing-text.ts` 整个模块、`validate-qr.mjs` 的第三条产物 |
| 命令行配对入口 | `/drc pair` 与 `pair force`（`/drc` 只剩 `status`/`unpair`）、`pairingImagePath` 与 CLI 那张 PNG |

**删掉兜底之后补的那道锁**：配对入口不可用（没 `webServer` / 路由挂不上 / `pill.enabled:false`）
现在必须在 `status.json` 里留 `warn:pill` + `pill` 探针——否则表现是"这台主机配不了对，
而没有任何地方说为什么"。`tests/pill-isolation.test.ts` 五种形态各钉一条。
**这条 warn 是每次写快照时现判的，不是在 `apply()` 里 push 一次的**：真机重启后抓到过
`pill.routes="registered"` 与 `problems=["warn:pill"]` 并存——`webServer` 是 `ctx.inject`
的回调晚到的，apply 那一刻它还不在，一次性判断就把启动快照冻成了永久告警。
钉它的是"webServer 晚到"那条用例（变异验证：把判据改回 apply 时的快照，只有那条红）。

**浏览器那一半也栽了个跟"看不见"有关的坑**（详见 §4 第 16 条）：`inject: []` 让 `apply()` 跑在
槽位服务之前，那颗 pill 整颗不出现，而单测全绿。最终按宿主自带模板改成 `inject: ['slots']`
（软探测与晚到回调留作退路），并在真屏幕上复核：`● 点一下配对` → 点下去出 QR + `057482` +
倒计时 + "换一张" → 抬头变 `● 配对中` → Escape 收掉；同一轮里 `POST /pairing/new` 复点回同一张、
`pairing.png` 的 `ETag` 与 `status.json` 那张 `qr` 的 `sha256` 前 16 位都是 `ff5d01936e40437d`，
解出的 URI 尾号 `t=057482`；`status.json` 是 `pill.routes="registered"` **且 `problems=[]`**。

**这一轮新抓到的一个真缺陷**（是新写的对照测试抓的，不是老测试）：三条路由依次 `register`，
第二条抛错时第一条**没被回滚**，于是它永久留在宿主上、`stop()` 再也拿不到注销函数——
表现会是"重载一次之后那颗 pill 再也不出现"。修法在 `registerPillRoutes` 里，
判据是 `pill-routes.test.ts` 的"第二条挂不上时第一条必须被回滚掉"。

**e2e 补上了此前那条空白**（§9.4 说过"e2e 没覆盖那三条新路由"）：`e2e/run.mjs` 现在给假
`webServer`，在**真中继在线**时点那三条——发码、幂等复点同一张、PNG 的 `ETag` 与主机维护的
那张码的 URI 哈希同一个口径。此前单测里的发码分支永远是"中继不可达"，那条路从没走过。
闸门：control **261 项全绿**、e2e **17 步 0 失败**、`node --test e2e/*.test.mjs` 113 全绿、
`validate-qr` 28 组 ×2 产物 0 失败、**真屏幕复验通过**（上面那段）。

**还欠着的（当时）：**

1. ~~没发版~~ **✅ 2026-10-03 深夜已发 `1.2.0`**（Trusted Publishing 先配好，再抬版本打标签；
   发布带 provenance、14 步全绿）。当时"先配 TP 再发"这条拍板已执行。
2. ~~本机 profile 跑的是未发布的 HEAD 产物~~ **✅ 已转正**：重装后 profile 里就是 npm 上那版
   `1.2.0`（§0.2）。⚠️ 别再引用这里说的旧哈希或 `/tmp` 备份——**字节哈希随构建方式变（§4 第 20 条）**，
   判据是版本号；`/tmp/drc-profile-backup/…1.1.0` **/tmp 重启就没了**，要回滚改用
   `npm pack dsh-remote-control@1.1.0`。回滚要再重启一次宿主才算数。

### 9.6 全仓删死代码（2026-10-03 晚，四仓 + 伞仓）

用户拍板："把没用的、防御性的、怕删了后面会用到的全部删除，只留有用的；mp 不用动"。
判据先立一条：**注释里带日期与真机取证的守卫不是"防御性"，那是修过的 bug**，不删。
三个 Explore 派工各审一仓（协议 / 中继 / 伞仓 harness），**报告我逐条自己复核过才动手**——
结果有两条是错的：协议仓 `pairFail`/`pairReady`/`peerLeft`/`makeError` 被报成"只导入不调用"，
实际是 `import { makeError as makeErrorFrame }` 这种别名调用，grep 裸名会漏；中继那条
`peerJoinedNotice` 才是真的只有一行导入。

| 仓 | 删掉的 | 提交 |
|---|---|---|
| control | `apiProxy` 那条明确不接的载体（两块探测 + `apiProxyOf()`）、`writePrivateFile`、`StatusFile.refreshing`/`.path`（注释说"测试读它"其实零调用方）、`HISTORY_LIMIT_DEFAULT` 等 7 个零消费者导出、`redactSecret`/`redact` 双名、**退役配置键的 warn 表**（用户拍板删）、`tsc --noUnusedLocals` 报出的全部未用导入与局部 | `0f8098a` |
| protocol | 9 个零调用导出（含 `frames.ts` 里那份与 `outbound.makeError` 重复的 `makeErrorFrame`）、`pair-begin` 的可选 `hostLabel`、`pairFail` 联合里线上枚举根本不认的 `rate_limited`、`isoOrUndefined` 的死三元 | `05523e3` |
| server | `Budget.peek`、`Violations.exhausted`、日志的内存 `tail`/`drain`/`collectLines`、`isLiveClient`、`ClientEntry.meta`（写一份只有测试读的内存状态）、`WS_OPEN`/`Sock` 转发出口、没接线的 `SHUTDOWN_FORCE_MS`、hello 末尾那条在防自家 schema 的 `sendError(bad_role)`、版本探针的第二个路径、`start:bundle`/`start:tsc` | `66febd0` |
| 伞仓 | `scripts/read-session-log.mjs`（整文件，没人跑）、`run.mjs` 的 `readStatus`/`statusFile`/`service`/`MP_DIR` 转出口、`bootHost` 两个从不传的入参、`shutdown` 的 `signal`、`mp-sim` 多 require 的三个模块、`live-e2e` 的 `DRC_LIVE_DEBUG` 整块与两条打点；**并把 `restart-resume` 里那份丢了三项检查的 `assertSessionShapeIsFine` 副本换成 `run.mjs` 的真断言**（那是静默降档，不是简化） | 本轮 |

**删错了一处，被闸门当场抓住**：我把协议仓 `normalizePairingToken`/`parsePairingUri` 开头的
`String(x ?? '')` 判成"替违反类型的调用方兜底"删了，伞仓 113 项里那条字节对拍立刻红
（fixture 故意喂 `undefined`，要的是两侧同返回 `''`；小程序侧写的正是 `String(text || '')`）。
已原样恢复并单独提交 `beff2e6`，教训写进 §4 第 17 条。

**三处判过之后决定不删**，理由要留档：中继 `bucketAt()` 索引越界就抛（注释写明"退回临时 Set
等于悄悄丢桶"）；`noteBackpressure` 的 `bufferedAmount ?? 0`（假 socket 没这个字段，缺了它把
`undefined` 喂进限速判断）；`run.mjs` 的 `importBuildArtifact` 4×2s 重试（它防的是**本机真实存在**
的并行会话清 `dist/`，不是想象出来的竞态）。另外用户拍板**保留** `validate-qr` 的"裸矩阵"那条腿
——它是插件 `qrMatrix` 的唯一外部消费者，删了编码器几何回归就只能靠 PNG 间接发现。

闸门（清理后全绿）：protocol **80**、server **79（1 skip）**、control **262**、伞仓 e2e **17 步 0 失败**、
`node --test e2e/*.test.mjs` **113**、`validate-qr` 28 ×2、四仓 `format:check` 与 `noUnusedLocals`/`noUnusedParameters` 干净。

**同轮补的一个界面细节**（control `a0be454`）：宿主 dock 挤不下时会给每一项自己截断
（「6 轮 …」「1.6M to…」），而那颗 pill 是 flex 项、默认能缩到「中文最小内容宽度 = 一个字」，
于是「已连 1 台」竖着排成四行（用户截图）。修法是 `.drc-pill` 写死 `flex: 0 1 auto` +
`white-space: nowrap`、`.drc-label` 给 `min-width: 0` + `text-overflow: ellipsis`，全文留在
`title`/`aria-label` 上。**这类"CSS 写在模板字符串里"的判据只能断言注入样式的那两条规则**
（假 DOM 不排版），而模板字符串里**不能出现反引号**——第一版注释就因为它把 CSS 断了行。

### 9.7 中继试发 npm 又撤回（2026-10-03 深夜，server `78622e2` → `d174787`）

用户先要"wire 下掉、server 也发 npm"。两件事都**没照原样执行**，各有各的原因：

1. **wire 不能下**：17 处 import（中继 5、宿主插件 12）在用它，1390 行源码必须有归宿；
   而且**已发布的 `dsh-remote-control@1.0.0/1.1.0` 的 manifest 里写着 `dsh-remote-wire: ^1.0.0`**，
   真下掉会让那两个版本 `npm install` 直接 404。用户拍板"不能删除，两边都引用"→ 不动。
   ⚠️ 我一度拿 `api.npmjs.org/dependents` 的 404 当"没人依赖"的证据——**那个接口已退役、
   对小包一律 404**，读它等于没读。真正的证据在注册表 manifest 里（见 §4 第 18 条）。
2. **server 发不出去**：`dsh-remote-server` 这个包名在 npm 上属于 `bondzhu` /
   `MRZHUH/dsh-remote-server`（0.1.1，2026-08-17 发，"在 DSH 会话里 @ 服务器走 SSH 执行命令、
   两级审批"——**跟我们毫无关系，但同名**）。发布前查名是免费的，发布后才撞就是 403。
   用户拍板"先不发"。

**撤回时最要紧的一条不是回滚代码，是回滚文档**：那几分钟里 README 与 `SELF-HOSTING.md` 已经写上了
`npm i -g dsh-remote-server` + `drc-relay`——**照做的人装到的是别人的一个能执行命令的工具**。
现在两处都改成"本仓不发 npm，别照抄那条命令"，并且有一条闸门测试钉住半发状态：
`private` 必须为 `true`、`bin`/`files` 不许回来、`release.yml` 里不许出现 `npm|pnpm publish|pack`
与 `id-token: write`（变异验证：去掉 `private` 立刻红）。

**撤回之后仍然留下的两条修正**（与发不发 npm 无关，是产物事实）：

- `dependencies` 清空、`ws` 移到 `devDependencies`：产物早就把 `ws`/`zod`/`dsh-remote-wire`
  内联了（`bundle-relay` 的日志会列出内联了哪几个包），列在运行时依赖里就是让源码消费者白拉一棵树。
- 产物第一行加 `#!/usr/bin/env node`：于是 `install -m 755 relay.mjs && ./relay.mjs` 成立。

**顺带学到的一条**（已写进 §4 第 19 条）：`files` 白名单里写一个不存在的路径，npm **不报错，
只是静默不打包**——我把 `SELF-HOSTING.md` 写在根目录（实际在 `docs/` 下），是 `npm pack --dry-run`
的清单暴露的。以后动发布形状，判据是"pack 清单里逐项都在"，不是"pnpm pack 退出码 0"。

以后真要发中继包，先定名字：2026-10-03 实测 `dsh-remote-relay`、`drc-relay`、`dsh-rc-relay`
都空着（`dsh-relay` 已被占），改动要同步 `release.yml`、上面那条闸门与两份文档。

### 9.8 抬头改成"未配对/已配对"、点开改成连接信息（2026-10-03 深夜，已随 control `1.2.0` 发布）

用户两句话：`点一下配对`/`配对中` → **未配对**（灯是灰的）、`已连 N 台` → **已配对**、
**点进去是连接信息**；外加一句"图片是不是可以不用在工作区了"。

**做了什么**：

| 面 | 改动 |
|---|---|
| 抬头那句 | `pillLabel` 只剩五种说法：`远程未启动` / `远程未连接` / `连接中` / `未配对` / `已配对`。台数**不写进抬头**（那排宽度是宿主给的，中文会被逐字断行，见 §9.6 那条截图坑），"有码还没人扫"也不再单列——绿只能表示真配上了一台 |
| 面板 | 顶部多四行**连接信息**（本机名 / 中继 `host:port` / 状态 / 配了几台），任何一态都在场。中继地址只留 `host:port`：240px 的弹窗装不下带 scheme 和 path 的整条 URI |
| 发码时机 | **点开不发码**。原来"点 pill = 发码"，因为那颗 pill 唯一用途就是配对；现在抬头是状态，点它的第一预期变成"看一眼连得怎么样"，而一张码是有寿命的资源——把"看一眼"接到 `ensureFresh` 上等于每次点开都可能向中继申请一张新的挂在 pending 表里。发码改成面板里那颗 **生成配对码**（已配上时叫 **再配一台**） |
| `/status` 路由 | 字段从 `{relay, paired, hasCode}` 变成 `{relay, paired, hostLabel, serverUrl}`。`hasCode` 删掉是因为**没人读它了**（抬头不再区分有码没码）；新加的两个是**非凭据**（这两条本来就印在手机上看到的那张码里、也在 `status.json` 里），红线不变：没有 `psk`、没有 6 位码、没有 `dshr:` 片段 |

**"图片放系统 temp 目录"这条的前提不成立**：代码里**没有任何一条路把 QR 写到磁盘**——
`pairing.png` 那条路由是有人要图的时候现渲染、现回字节（`no-store` + `ETag`），
`src/` 与 `client/` 全量 grep 无落盘点。工作区里那几张 `.dsh/*.png` 与 `~/.dsh/dsh-remote-control/*.png`
是**右栏方案的历史残渣**（那个方案按节拍往会话工作区写文件），本轮删掉 5 份；
`~/.dsh/dsh-remote-control/status.json` 留着，它是排错入口不是图。
所以"改放 temp 目录"= 给一条不存在的路换目的地。

**顺带抓到一条脚本级缺陷**：`install-to-profile.sh` 那段 heredoc 的定界符**刻意不加引号**
（要让 `$PROFILE` 展开），于是注释里那对反引号被 shell 当成命令替换执行——
每次安装都喷一句 `syntax error near unexpected token 'newline'`，而退出码还是 0、
bundles 列表照样打出来。改成「」。**推论**：写进未加引号 heredoc 的注释里不许出现反引号，
这条与 §4 里"python heredoc 里嵌套英文引号会死"是同一类坑。

**取证**（真屏幕，`index.js` `b362fec0…` / `client.cjs` `9328b1e5…`，配方见 `docs/HOST-SIDE.md` §6）：
`● 未配对` → 点开 `dialog dsh-remote-control 连接信息` 四行 + `生成配对码`，**这一刻 `status.json` 里没有码**；
再按才出 QR + `570461` + `扫码配对 · 1 分 58 秒后过期`，`?e=` / `ETag` / `sha256(qr)` 前 16 位三者相同
（`34f0592ef489f470`）。闸门：control `pnpm -r test` **265 pass / 0 fail**、`typecheck` 过、
`format:check` 过、伞仓 `node e2e/run.mjs` **17 步 0 失败**。
**收尾**：这一版随 control `1.2.0` 发到 npm（带 provenance，发布运行 14 步全绿），
`~/.dsh/profiles/desktop` 重装到 `1.2.0`（装出来是 `index.js` `058289e3…` / `client.cjs` `0dfb8fb4…`，
与仓内 `dist/bundle/` 逐字节相同）——**屏幕上的哈希 `b362fec0…`/`9328b1e5…` 是当时那次构建的产物，
换一次构建就变**（esbuild 内嵌 cwd 相关的模块路径标签，§4 第 20 条）：别拿字节哈希判"代码变了没"，
判据是版本号 + 解出来（非 ASCII 会转成 `\uXXXX`）的文案。

### 9.9 单台配对 + 退出配对 + 面板重做 + `/drc` 整条删（2026-10-03 深夜，本轮）

用户一句话定边界："配对策略变一下，只允许配对一台，pill 弹出框支持退出配对，`/drc` 命令直接去掉，
必须要显示的状态加入到 pill 弹出框，本机、状态、已配对 去掉，再配一台去掉，生成配对码/退出配对，
都放在右上角；换一张二维码按钮和能力也去掉，重新设计这个弹出页面，精炼一些。"

按这句话执行的六件事：

| 面 | 改动 | 判据 |
|---|---|---|
| **只允许一台** | `onPeerJoined` 里，新设备进来时把**除它以外**的所有会话 `voidConversation`（中继先 `conversations.open` 新通道再回调主机，所以这里要作废的是"其它"）。旧手机下一帧撞上 `unknown_session` → 需重新配对 | `index.ts` 那条注释；`ConversationBook.ids()` 返回新数组，遍历中作废是安全的 |
| **退出配对路由** | 新增 `POST /plugins/dsh-remote-control/unpair`，与发码那条**同一档守卫**（`x-drc-pair` 头；它也改状态）；返回 `{state:'ok', unpaired:n}`，`n=0` 是幂等成功不是错误 | `pill-routes.test.ts` 新增一节（成功 / `unpaired:0` / GET→405 / 缺头→403 / 跨站与 `null` Origin→403 / 非环回 Host→403 / `dsh-app://app`→200 / 抛错→500） |
| **`/drc` 整条删** | 命令注册那一路**全部拔掉**（`LooseContext.commands`、`CommandResult`、`commandDefinition` 与三次注册尝试），`command-result.test.ts` 删文件 | isolation 测试与 `e2e/run.mjs` 各钉一条"**一个命令都不许注册**" |
| **主机名/状态/已配对 三行删** | `/status` 字段从 `{relay,paired,hostLabel,serverUrl}` 收成 `{relay,paired,serverUrl}`；`PillStatus` 里 `hostLabel` 撤掉（配置键 `hostLabel` 保留，它只管手机显示名） | 三处测试的字段集合断言 + status 路由"多一个字段就要重审"那条 |
| **面板重做** | 抬头一行（状态 + 右上角那颗按钮：未配对=`生成配对码`、已配对=`退出配对`）+ 一行**中继地址**；QR 视图 = 图 + 6 位码 + 过期提示。**删掉** `RELAY_TEXT`/`infoRows`/"换一张"那颗按钮 | `client-bundle.test.ts`：`drc-head-label`/`drc-info`(键='中继') 在、本机/状态/已配对/再配一台/换一张**一个字都不许出现**、按钮文案随 `paired` 换、按下打 `POST /unpair` |
| **换一张能力也去** | 倒计时到点**不再自动补码**：`expiresInMs<=0` 时清掉 interval、只重绘一句"配对码已过期…"，要再发得重新按那颗按钮 | `client-bundle.test.ts`："码过期后不再自动补一张"（请求计数停在 1） |

**面板还剩什么、为什么**：用户点名删的是"本机、状态、已配对"三行与"再配一台"。
**中继地址**不在删除名单里，且是排错第一眼要看的东西（手机连不上时先看主机连的是哪个中继），
所以留成一行——如果这一步也想删，删的是 `relayBlock()` 那一行与 `/status` 的 `serverUrl` 字段。

**闸门（本轮，源码改动后）**：control `pnpm -r test` **265 pass / 0 fail**、`pnpm -r typecheck` 过、
`format:check`（源码，CI 在 build 前跑那次）过、`node --check e2e/run.mjs` 过。
伞仓 `e2e/*.test.mjs` 与 `node e2e/run.mjs` **本轮未跑**——同工作树有并行会话在飞（它改
`packages/plugin` 的载体面与 `e2e/run.mjs`），跑全量 e2e 会互相打断；要跑得等它停手、工作树干净。

**还欠着的**：① 重装 `~/.dsh/profiles/desktop` 并重启宿主，在真屏幕上复验新面板（抬头 / 右上角那颗
按钮随配对态换字 / 退出配对真的掉线 / 码过期不再自动换）；② 全量 e2e 与 `e2e/run.mjs` 在干净工作树上补跑。

#### 9.9.1 第一次真机复验：撞上"新 JS + 旧 CSS"，并补四条用户点单（2026-10-03 深夜）

用户拿真屏幕截图回来，一句话点出四件事：**① 界面错乱；② 二维码页那颗按钮该是「刷新」不是「生成配对码」；
③ 配对状态要配色、断链要用红的「已断开连接」；④ 已配对之后该显示状态，不是还挂着二维码。**

**① 的根因不在布局代码，在样式表版本**（这条最值钱）：截图里的形状（按钮掉到第二行居中、中继那两段竖排、
段落间距偏大）**只有旧 CSS 能摆出来** —— 上一版 `.drc-actions` 写着 `justify-content: center; margin-top: 8px`、
旧 `.drc-info` 是列方向、`drc-hint` 在旧表里根本没有（吃 `p` 的默认外边距）。而 JS 明明是新的
（新文案 `点右上角…`、新 `qrNote` 都在）。对上的结论是 `ensureStyle` 的老毛病：

```ts
if (doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return   // ← 只看"插过没有"
```

宿主换这一半时**文档未必重载**（HMR 换模块、`<head>` 里那份 `<style>` 原样留着），于是新 DOM 配旧样式。
修法是**按内容对齐**：内容不一致就当场 `textContent = CSS`。判据 `client-bundle.test.ts` 新增
"样式表按内容对齐"（预置一份旧 `<style>`，要求它被换掉、且**不许插第二份**）。
⚠️ 顺带又踩了一次同一条老坑：给 CSS 注释加了一句带**反引号**的 `space-between`，模板字符串当场断行、
`tsc` 报 `TS1005`（与 §9.6 那条"CSS 写在模板字符串里不能出现反引号"是同一件事）。

**②③④ 的改法**（都在 `client/src/pill.ts`）：

| 点单 | 改法 | 判据 |
|---|---|---|
| 二维码页那颗按钮 | 右上角那颗**跟着当前视图走**：`qr`/`loading` → `刷新`（同一条幂等发码路由，码还在就还是它），其余按配对态给 `生成配对码` / `退出配对` | `client-bundle.test.ts` 两条：出图时按钮文案 `刷新`；过期后仍是 `刷新` |
| 状态配色 + 断链红 | `pillLabel` 的 tone 从三档加到四档，`offline` → `{text:'已断开连接', tone:'error'}`；`.drc-dot[data-tone="error"]` 与 `.drc-head-label[data-tone="error"]` 都是红 | 原"远程未连接/off"那条改判成"已断开连接/error" |
| 已配对后回状态视图 | `pollStatus` 里：`lastStatus` 更新后若 `view.kind==='qr'` 且 `paired>0`，就地 `view={kind:'info'}` + 清倒计时 + 重画 | 新增一条：切 `paired` 后翻面、`drc-qr` 消失、按钮变 `退出配对`、**发码请求数仍是 1**（翻面只重画） |

另外把面板里那句 `点右上角「生成配对码」，用手机扫码完成配对` 整段删了（`.drc-hint` 连 CSS 一起）——
抬头那颗按钮自己就说明了，多一行只是让这个 240px 的弹窗更挤；中继那一行改成 `space-between`（键左值右）。

**闸门（本轮）**：control `pnpm -C packages/plugin test` **267 pass / 0 fail**、`typecheck` 过、
`format:check` 只剩并行会话那份 `src/platform/carrier-services.ts`（不是我的改动）。

#### 9.9.2 收尾提交（2026-10-03 深夜）

两个仓都已落成提交，工作树干净（除下面那两条"不处理"的）：

- control `ccf695a`（`feat(pill)!`）：面板收成一颗按钮 + 退出配对路由；`/drc` 整条删。14 文件 `+644/−583`。
- 伞仓 `066181b`（`docs(pill)`）：HANDOFF / README / HOST-SIDE / MINI-PROGRAM / SECURITY 五份文档
  + `e2e/run.mjs`。提交前 `e2e/run.mjs` 过了 `node --check`。

两者都叠在并行会话刚提交的 `1d36e33`（control，`feat(plugin): 审批下发 expiresAt…`）与
`f7280b4`（伞仓，`test(chat): 探针与截图…`）之上。

`~/.dsh/profiles/desktop` 已用新源码重装并核对字节：`index.js` `9ed00a0a…` / `client.cjs` `b7bee07c…`；
把 bundle 里非 ASCII 解出来是 `刷新`×2、`已断开连接`×1、`退出配对`×2、`生成配对码`×2、`drc-hint` **0**
——⚠️ esbuild 把这些写成**大写** `\uXXXX`（`\u5237\u65B0`），按小写那套 grep 会假报 0。

**没处理的两条（只记事实，不动手）**：

1. `format:check` **只剩**并行会话那份 `src/platform/carrier-services.ts`——它随 `1d36e33` 提交进来，
   不是这一轮碰的（`prettier` 想去掉的只是空行与两处换行）。CI 若在 build 前跑 `format:check`，
   control 仓 main 会因这一条变红；要不要顺手 `prettier --write` 由用户定。
2. `~/.dsh/profiles/desktop/cordis.patch.yml.bak-*` 有 10 个备份，其中 **6 个含 `hostToken`**（权限 0600）。
   清不清、清哪些等用户点头。

**还欠着的（2026-10-04 凌晨结算，见 §9.10）**：

1. **重启宿主、真屏幕复验**——✅ 已重启多次，新 bundle 在屏幕上；那颗 pill 实测可见
   （绿色 `已配对`），`GET …/status` 回四个字段。**只剩面板正文那三行**要用户点一下（§9.10 末）；
2. **伞仓全量 e2e** 在干净工作树上补跑——✅ **全绿**：
   `node --test e2e/*.test.mjs` = **125 通过 / 0 失败**（上一版记的 113 是并行会话补测之前的数），
   `node e2e/run.mjs` = **17 步 0 失败**，`node scripts/validate-qr.mjs` = 28 组 ×2 产物 0 失败。

#### 9.9.3 面板正文补成中继 / 状态 / 版本三行（2026-10-03 深夜，用户当天第二次点单）

用户看到真屏幕（§9.9.1 那版）："弹窗现在状态只剩 中继 一个了，有点单薄，再加两个有必要显示的状态，
组合 3 个。" 三个候选摆给他挑（中继+本机+版本 / 中继+本机+已配对 / 中继+状态+版本），他选了**第三条**。

| 面 | 改动 | 判据 |
|---|---|---|
| **第三行数据** | `GET …/status` 加 `version`——**非凭据**（本机装的这一版号）；`PillStatus` 加 `version` | `pill-routes.test.ts` 字段集合四条 + `pill-isolation.test.ts` 的 `/status` 断言 |
| **版本从哪来** | 新增 `src/version.ts`：`typeof __DRC_VERSION__ === 'string' ? __DRC_VERSION__ : 'dev'`；`bundle-plugin.mjs` 读 `package.json` 的 version 注入 `define` | 构建后 `dist/bundle/index.js` 里是 `var PLUGIN_VERSION = true ? "1.2.0" : "dev"`、`__DRC_VERSION__` 残留 0；源码直跑那条由 isolation 测试钉成 `'dev'` |
| **正文三行** | `relayRow` / 新增 `relayStateRow`（online=已连接、connecting=连接中、offline=已断开、idle=未启动、其余=空串）/ 新增 `versionRow`；`relayBlock` 换成 `infoRows()`，**每一行拿不到值就不建那一行** | `client-bundle.test.ts`：三条新断言（三行的键值对与次序 / 老版路由没给 version 时那一行消失 / `状态` 按 relay 翻译）；`FakeElement` 加了 `findAll` |
| **样式** | `.drc-info + .drc-info { margin-top: 2px; padding-top: 0; border-top: 0 }`——只有第一行画那条分隔线 | 同上那两条渲染断言 |

**闸门**：control `pnpm -C packages/plugin test` **269 pass / 0 fail**、`typecheck` 过、
`format:check` 仍只剩并行会话那份 `carrier-services.ts`。提交为 control `ab36a15`（`feat(pill)`），
伞仓文档与 `e2e/run.mjs` 随本次提交一起走（`e2e/run.mjs` 的 `/status` 字段集合也加了 `version`）。
重装已做（`index.js` `0695d8c9…` / `client.cjs` `13b78528…`，host bundle 里 `PLUGIN_VERSION` 那行实测是
`true ? "1.2.0" : "dev"`）；仍**没重启**，屏幕上还没看见这三行。

### 9.10 审批卡修好：`approval/request` 那条 waterfall 要 `global` **且** `prepend`（2026-10-04 凌晨）

用户拿手机截图回来一句话："弹窗还是有问题，先解决"。截图里主机侧的 agent 明说
"现在审批策略是 `ask`，所以我把这次重试发出去，**让你看到审批弹窗**"，而手机上那条步骤停在
"正在执行"、**一张卡都没有**。这一轮从"没弹"查到"闭环"，中间走错了一次，两步都值得记。

**第一现场（改代码之前先取的数）**：`status.json` 里 `approvalFace=registered`、
`eventTypes` 有 `approval/asked`、`problems` 是空的，而 `outbound` 里**连
`permission_request_no_peer` 都没有**——那个计数在发送之前就 +1，所以"没有计数"=
"根本没走到发送"。协议层（`ev.permission_request` / `cmd.resolve_permission` 都在
`dsh-remote-protocol`）与手机层（`chat.js` 的 `_onPermission` + `chat.wxml` 那张
`需要审批` 卡，初始提交就有）都不是断点。

**根因在登记方式，不在读请求的那几行**。宿主派发用的是
`ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, next)`
（桌面 asar 里 `ApprovalService.decide`，取证方式见下面那条"读平台实现"），而 cordis 的
`dispatch()` 判据是 `hook.global || !filter || filter.call(thisArg, hook.ctx)`，
`scopeTarget` 的 filter 只放行"未打标签的上下文"与"派发键的**祖先**作用域"
（原文注释：'A tag BELOW the dispatch key stays excluded — events flow up the chain, never down'）。
插件那条 fiber 与 agent 作用域是**兄弟**——于是登记成功、`registered` 报得理直气壮，
监听器一次都不会被调用。第一版改成 `{ global: true }`（`EventOptions` 的原文：
'Receive the event regardless of context filter checks'）。

**第一版不够，而这是真机告诉我的**：装上去复测，`approvalCalls` 仍然是 0。
于是加了两条读数 `approvalAsked` / `approvalDecided`（内核自己报的审计面），再量一次拿到
**`approvalAsked=1`、`approvalDecided=not-seen`、`approvalCalls=0`** ——
"请求确实派发了、还卡着没结论、但我们没被调用"，这三件事同时成立只剩一种解释：
**waterfall 是"外层不 `next()` 内层永远轮不到"，而 `dispatch()` 返回数组的第一个就是外层**
（`register()` 用 `unshift` 实现 `prepend`），桌面 UI 的应答者登记得更早，它一拿到请求就去等
真人点按钮且不 `next()`。补上 `prepend: true` 之后一次跑通完整闭环。

**"没人答"与"别人抢先答了"在现场长得一模一样**——这一轮如果不是先加了 `approvalDecided`，
第二版就会往"还是被过滤了"那个方向去查。所以四条新读数（`approvalCalls` / `approvalLast` /
`approvalAsked` / `approvalDecided`）不是装饰，它们是这条链上唯一能分叉的判据。

**最终真机读数**（`scripts/approval-probe.mjs` 那一轮，主机侧 + 手机侧一起对账）：

| 侧 | 读数 |
|---|---|
| 主机 | `approvalCalls=1`、`approvalLast=answered-by-phone(allowed-once)`、`approvalDecided=allowed-once`、`outbound.permission_request=1` |
| 手机（探针收到的原帧） | `{action:'write', reason:'escalate sandbox to workspace-write: …', options:[{approve,允许一次},{reject,拒绝}], expiresAt:…}` |

**⚠️ 代价，写在 `APPROVAL_SUBSCRIBE_OPTIONS` 的注释里**：`prepend` 排到最外层，意味着也排在
Auto 预置的自动审阅之前（那条也是 `prepend` 登记的）。本机 profile 里只有
read-only / workspace-write / danger-full-access 三个预置，**没有 Auto，所以没有安全闸门被跳过**；
哪天接上 Auto，这一行要重新审（正确做法大概是"先让自动审阅跑完再轮到手机"）。

**新增资产 `scripts/approval-probe.mjs`**（伞仓，不开源）：配一张真码、**保持配对不动**、
可选地自己发一条会撞沙箱的指令，然后把收到的 `ev.permission_request` 原样打出来、回一个决定、
最后对着基线核 `approvalCalls` 有没有涨。为什么需要它：`e2e/run.mjs` 打的是 mock 内核，
测不到 cordis 那条 waterfall 的**派发**；`live-e2e.mjs` 挑会话且跑完就解配，等不到一张卡。
用法（`pairOnStartSec` 那条见下面"临时改过什么"）：

```sh
curl -sS -X POST -H "x-drc-pair: 1" http://127.0.0.1:<port>/plugins/dsh-remote-control/pairing/new
node scripts/approval-probe.mjs --session <有工具的会话 id> \
  --prompt '用 run_code 工具调用 tools.write，把内容 ok 写到文件 approval-live.txt。如果被沙箱拒绝，请按错误信息里给的升级路径用 sandbox_permissions 重试同一次写入。'
node scripts/approval-probe.mjs --session list        # 只看会话列表（哪条有工具）
```

三个坑都是真机踩出来的：① **探针自己读 `status.json` 会读早**（那文件按定时器刷），
第一次就因此报过一句假的 `approvalCalls=0`，现在是"带基线地轮 15s"；
② **会话必须真有工具**——`live-e2e` 默认挑第一条 idle，那几条是 API 建的空壳会话，
模型会回一句"本会话根本没有给我提供任何写文件的工具"然后什么都不触发；
③ **`--prompt` 里别写"你必须提权"**，那种命令式口吻会被模型当成不合理请求直接拒绝
（连着两轮 914/740 字的"我做不到"就是这么来的），要写成一句自然的小任务。

**读平台实现的方式**（这一轮最有效的一招，比猜快十倍）：宿主是打包过的 Electron，
`grep -a` 直接打在 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 上就能拿到
源码文本；`node -e` 把整块读进来按 `indexOf` 定位、切上下文打印，比 `grep -o` 好用。
CLI 那一代（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`）
带 `.d.ts`，`dsh-user-approval/lib/types/index.d.ts` 就是这道 seam 的权威签名
（`ctx.approval` 只有 `setPolicy` / `request` / `overrideOf`，**没有注册应答者的 API**——
应答只能靠参与 `approval/request` 这条 waterfall）。

**临时改过什么、还原的证据**：为了让审批真的被问出来，改过 profile 两处
——`pairOnStartSec: 120`（否则 `status.json` 里没有 `pairing.qr`，探针拿不到 PSK）与
`permissionPresets.defaultPreset: danger-full-access → read-only`（默认档是 `approval: never`，
永远不问人）。改之前整份备份到 `/tmp/cordis.patch.yml.orig-drc-approval`，跑完 `cp` 回去，
`diff` 输出为空 = **逐字节还原**，并重启宿主让 `pairing` 回到 `null`（实测 `pairing: null`、
`problems: []`）。⚠️ 留着 `pairOnStartSec` 等于把"仍然有效的配对码 + PSK"长期写在 0600 的
status.json 里，这是它默认关着的原因。

**顺带**：`format:check` 现在**全绿**了——`carrier-services.ts`（并行会话那份）与
`src/transport/relay.ts`（随 `4e2528c` 进来的长签名）一起 `prettier --write` 掉了。
§9.9.2 里"没处理的两条"的第 1 条到此结掉（第 2 条那 6 个含 `hostToken` 的备份仍未动，等用户点头）。

**闸门（这一轮）**：control `pnpm -C packages/plugin test` **273 pass / 0 fail**（上一版 269）、
`pnpm typecheck` 过、`pnpm format:check` 全绿。提交：control `ab81650`（`global`）→
`1ed6b91`（`asked`/`decided` 读数）→ `1b0df97`（`prepend`）→ `a33c94b`（CHANGELOG）；
伞仓随本次提交走探针与这两节文档。

**这一轮还欠的**：① 手机被这几轮重启与解配踢掉了，**要用户重新扫一次码**才能在自己手机上看那张卡；
② pill 面板正文那三行（§9.9.3）还没在屏幕上看过——这台机器上 Computer Use 走不通
（AX 树只交出菜单栏，截图策略是 `AX_ONLY` 所以坐标点击一律被拒），只能靠用户点一下那颗 pill；
③ 提问卡仍未取证（`questionsFace=not-taken-over`，且这一代宿主的 `ctx.userQuestions`
没有 `registerProvider`）。

### 9.11 主机身份持久化 + 一条不改配置的取码路子（2026-10-04 凌晨，接 §9.10）

§3.4 那条"每加载一次换一个身份"的账结掉了，走的是**代码**而不是 profile：
`config.hostId` 为空时按 **磁盘旧值 > 现造并落盘** 定身份，落点是 status.json 旁边的
`host-id`（0600、已存在的值绝不改写、升级前那种 `h_xxxx` 读到了继续用、IO 失败退回一次性值
且绝不抛）。为什么不选"给 profile 写死一个 hostId"：那只是把这一台机器的症状压下去，
下一个用户/下一台机器照样漂，而且配置里多一个必填项。

真机复验（连着重启两次）：`status.json` 的 `hostId` 两次都是 `drc-748e9a9ce167`，
`~/.dsh/dsh-remote-control/host-id` 实测 `-rw-------`；`node e2e/live-e2e.mjs` 18 项全绿，
第 ④ 条现在念得出 **"已配对到 drc-748e9a9ce167"**——以前这一行每次是一个新的 `h_xxxxxx`。
九条新测试里三条是"把'读回旧身份'那行删掉就红"（已按变异验证跑过：`not ok 3/4/8`）。

**最值钱的一条是取配对码的第三种办法**（以前只有两条：改 `pairOnStartSec` 再重启，或者让人扫码）：

```sh
curl -sS -X POST -H "x-drc-pair: 1" http://127.0.0.1:<port>/plugins/dsh-remote-control/pairing/new
curl -sS -o /tmp/pair.png http://127.0.0.1:<port>/plugins/dsh-remote-control/pairing.png
# 用装了 zxing-cpp + pillow 的那个 venv 把图解回 URI
.../envs/default/bin/python -c "import zxingcpp,sys;from PIL import Image;sys.stdout.write(zxingcpp.read_barcodes(Image.open('/tmp/pair.png'))[0].text)"
```

`pairing.png` 里就是那张完整 URI（含 PSK），所以**这条路不用改 profile、不用重启、
也不会在 status.json 里留下带凭据的 `pairing` 块**。三条纪律：`umask 077` 落临时文件、
用完 `rm`、绝不把 URI 打进日志或文档。⚠️ 解出来是 `dshr:/p?…`（**两个**斜杠），
按三段斜杠写正则会假报"形状不对"——我第一遍就这么差点误判。

**闸门（这一节）**：control `pnpm -C packages/plugin test` **282 pass / 0 fail**（§9.10 那轮 273）、
`typecheck` 过、`format:check` 全绿；伞仓在 **hostId 那次改动之后重跑**（改的是插件入口，
之前那一次绿不算数）：`node --test e2e/*.test.mjs` **125 / 0 失败**、
`node e2e/run.mjs` **17 步 0 失败**；`node scripts/validate-qr.mjs` 28 组 ×2 产物 0 失败、
`node e2e/live-e2e.mjs` **18 项全过**。提交：control `f0e9308`（`feat(host-id)`），
伞仓随本次提交走这一节与 §3.4 的结算。

**当时跳过、后来又做掉的一条**：§3.5 里"给协议仓 tsconfig 加 `"types": ["node"]` 解 TS7"
——这一节写的时候 `dsh-remote-protocol` 还是并行会话当晚在写的树（HEAD 是它的
`182b462 feat(wire): 加 ev.model… 升 1.1.0`），一行 tsconfig 撞上去就是互相覆盖，所以先没动。
后来确认四仓工作树都干净、并行会话停手了才做掉：**协议仓 `7625747`，TS7 从 40 个错到 0**，
细节与复现命令的坑记在 §3.5 第 5 条。
