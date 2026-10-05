# HANDOFF — dsh-remote-control

> 交接给下一位开发 agent。**先读本文，再读代码。**
> 重写于 2026-10-03（上一版内容太长已整体替换；旧文在 git 历史里，`git show d058d8f:HANDOFF.md`
> 能取回，**没有丢**——包括那些一次性取证细节）。

## 0. 一句话状态

**先读 `docs/PRODUCT.md` 再读这一节。** 2026-10-04 那次"参考 anywhere-labs 重新设计"之后，
**为什么长这样**已经有了权威答案：三条承诺（零知识 / 无账号 / 手机免安装）+ 一条判据
（30 秒原则）+ 一份"明确不做"清单。功能取舍的问题去那里查，别在代码注释里找。

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
（**未配对点开直接就是二维码页**；那颗按钮没配上时是 `刷新`、配上了是 `退出配对`——
2026-10-04 删掉了"先按一颗 `生成配对码`"那一屏），下面一行**中继地址**，
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
| 生产宿主插件 | **`1.2.0`（已发 npm，带 provenance）** | `dsh-remote-control/`（单一 bundle：`index.js` + `client.cjs`） | ✅ `~/.dsh/profiles/desktop` 里装的就是 `1.2.0`（`node_modules/dsh-remote-control/package.json` = `1.2.0`），且两半产物与仓内 `dist/bundle/` **逐字节相同**（`index.js` `058289e3b4dc0…`、`client.cjs` `0dfb8fb44518a…`）。⚠️ **字节哈希随构建方式变**（esbuild 会内嵌 cwd 相关的模块路径标签，§4 第 20 条），所以别拿哈希判"新不新"，判据是版本号 + 解出来的文案。**（2026-10-04 更新：`生成配对码` 这个词已经从 bundle 里消失了——未配对点开直接出码；现在认新版的字串是 `未配对` / `已配对` / `退出配对` / `正在生成配对码`。）****要用户重启宿主才在屏幕上生效** |
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
   （全仓 grep `frame dropped` 为空）。四处计数点是 `dsh-remote-server/src/server.ts` 里
   `counters.droppedFrames += 1` 的那四处（写行号会随每次编辑漂走，认这个串就行），
   其中两处注释就写明"它在日志里不留痕，只能靠这个计数被发现"。
   所以：**journalctl 查不到，/healthz 只在当前进程内有值**，想要历史必须自己落计数快照。
   本轮实测：线上 `version:1.0.1`、`droppedFrames:56`（uptime 6294s），空载 30 秒不涨
   （56 → 56），也就是说丢帧集中在**活动窗口**而不是稳态。
   **✅ 2026-10-04 凌晨：那条"自己落快照"已经做进中继**（server `d23944c`）——每
   `DRC_COUNTERS_LOG_MS`（默认 60s）出一条 `msg:"counters"`，字段由**同一个 `health()`** 产出，
   于是 `journalctl -u dsh-remote-control | grep '"msg":"counters"'` 取差值就能回答
   "昨天那段时间丢了多少"。⚠️ **线上还没吃到它**：生产跑的是已发布的 `v1.0.1` 产物，
   这一条要等下一次 Release + scp/重启才在线上有效（部署是改共享状态，等用户点头）。
4. **✅ 已解决（2026-10-04 凌晨，见 §9.11）：宿主身份不再每次加载换一个。**
   原来 `packages/plugin/src/index.ts` 是 `hostId: config.hostId || 'h_' + randomBytes(3)`，
   而 profile 那条 config 里**没有 hostId**（默认 `''`）。实测线上 5 分钟内出现三个 hostId
   （`h_c2073b` → `h_051405` → `h_0919dc`），中继日志每一次都是 `host online … replaced:0`
   （**换了身份所以顶不了号**，旧 socket 只能等宽限/清扫）。
   ~~这与 3 里那些丢帧是同一个形状~~ —— **这句是错的，已在 §9.14 更正**：
   身份漂移是真的、也确实会制造丢帧，但 `droppedFrames` 的**主要来源是"往没有客户端的
   会话广播"**（实测空载 45 秒涨 9，与插件三帧/15 秒逐帧对得上），跟身份无关。
   修法是代码侧的（不是改 profile）：**配置 > 磁盘旧值 > 现造并落盘**，落点
   `~/.dsh/dsh-remote-control/host-id`（0600，已存在绝不改写，老的 `h_xxxx` 读到了继续用）。
   真机复验：两次重启都是 `drc-748e9a9ce167`，`live-e2e` 第 ④ 条现在念得出
   "已配对到 drc-748e9a9ce167"。`status.json` 也新增了 `hostId` 字段。
   ⚠️ 这一条**不解决 3**：`droppedFrames` 的历史仍然只有当前进程内有值。
   中继侧那条"按周期把计数器抄进日志"已经写好（`d23944c`，见 §3.3），但**线上还没吃到**——
   要等下一次 Release + 部署。
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
6. **✅ 审批卡已真机闭环（2026-10-04 凌晨，见 §9.10）**；**✅ 提问卡也已闭环（§9.16）**。
    审批那条以前"没弹"不是策略问题也不是手机问题，是我们登记 `approval/request` 的方式
    （要 `{global:true, prepend:true}`），修法与读数都在 §9.10。
    提问卡以前"没到手机"的根因是**没接上**：这一代 `ctx.userQuestions` 没有
    `registerProvider`（单提供者语义还会剥夺桌面 UI），正确形状是像审批那样参与
    `user-questions/request` 那条 waterfall——§9.16。两条都有本地闭环测试 + 真机读数。
    ⚠️ 别把审批策略改回 `never` 来"排除干扰"——用户已表态，**别再问第二遍**。
7. **✅ `dsh-remote-control@1.2.0` 已发布**（2026-10-03 深夜，pill 收敛 + §9.6 那轮清理 + §9.8 文案都在里面）。
    发布运行 14 步全绿、带 provenance（注册表 curl 复核过），GitHub Release `v1.2.0` 已建。
    pill 的真屏幕复验做了三次（§9.5/§9.6/§9.8）。
    ~~剩下要人做的：重启本机那个 Harness~~ **✅ 宿主已经重启过（2026-10-04 凌晨，§9.10/§9.11）**，
    profile 里跑的就是最新源码那半。**还剩两件事只有人能做**：
    ① 手机上重新扫一次码（这几轮重启与解配把手机踢下线了）；
    ② 点一下那颗 pill，确认面板正文那三行（中继 / 状态 / 版本）在屏幕上是对的——
    这台机器上 Computer Use 点不动（AX 树只交出菜单栏、截图策略 `AX_ONLY` 让坐标点击一律被拒）。
8. **新发现（未修，因为改哪边都要真手机复验）：审批卡会被手机"按会话过滤"静默丢掉。**
   现场：`runtime.ts` 的 `pickConversation(_sessionId)` **不看参数**，随便挑一条有对端的会话发；
   而小程序 `pages/chat/chat.js` 在派发任何帧之前有一句
   `if (p.sessionId && p.sessionId !== this.data.sessionId) return`。
   合起来的后果：**手机停在 A 会话、B 会话发起一次审批**时，卡片带着 `sessionId=B` 发出去、
   被手机当"不是本会话"丢掉，主机那边白等 180 秒再交还桌面——屏幕上没有任何痕迹。
   今晚这条没撞上，只是因为探针发的指令正好落在手机看着的那条会话上。
   两条路可选，**别在没手机可验的时候挑一条写代码**：
   (a) 手机侧给审批/提问卡**破例**（这两类是"要人动手"的，不是"正文流"，跨会话也该弹，
   弹的时候带上是哪条会话）；(b) 主机侧在 `sessionId` 与对端正在看的会话不符时**直接交还桌面**
   （代价：桌面没人时等于自动拒绝）。(a) 更像产品本意，但它改的是 mp 那棵树。
9. **`~/.dsh/profiles/desktop/cordis.patch.yml.bak-*` 有 10 份备份，其中 6 份含 `hostToken`**
   （权限都是 0600，一共约 20K）。清不清、清哪些等用户点头——**这是删用户文件，不动手**。
   要清的话建议一次清全部 `.bak-*`：profile 现在跑的是仓里装的包，这些备份只是历次
   改 patch 时脚本自己留的退路。
10. ~~**待接：把 `ev.permission_resolved` 真的发出去**~~ → **2026-10-04 已接上并发版**：
    `dsh-remote-wire@1.2.0`（带 provenance）里是 `ev.permission_resolved` + `ev.question_resolved` +
    提问的 `expiresAt`；control 已升依赖并在结算点真的发出去了（取证见 §9.16）。
    `ev.run_state` 那一条**仍然照发**——用户手机上装的还是旧版小程序，只认它。
    剩下唯一一步是**重新上传一次小程序**，让精确帧与提问倒计时生效；不做也不影响收卡（粗收单在）。

11. **审批那一次真机点头还欠着**（提问那两个方向都已经自动取证过了，见 §9.16）：
    这台宿主的旧会话里**没有任何执行/写文件工具**——探针发指令后模型回报
    `Error: unknown tool "run_code"`（`bash` / `python` / `write` 同样 unknown），
    于是走不到审批（`approvalAsked=0`；`--session new` 新建的那条也一样，所以不是会话新旧的问题）。
    **对照证据**：`session-842179a6`（12:05）里 `run_code` 是通的（有 `tool/ptc-dispatch`），
    所以这是按会话/按工具面装载的问题，与这一版改动无关。要验就一句：
    用户自己那条正常干活的会话里让 DSH 问一次审批 → 手机先点掉 → 看桌面 composer 那张卡有没有当场消失，
    同时读 `~/.dsh/dsh-remote-control/status.json` 的 `kernel.approvalSignalHandoff`（应为 `fused`）
    与 `kernel.approvalDesktopVoided`（应比点之前 +1）。

12. **`takeOverQuestions` 这个配置键已经不生效，但还留在 `shell/config.ts` 里**：
    删它要同时动 `src/index.ts`，而这两棵树此刻正被并行会话的 pair-store 改动占着
    （不能顺手提交别人在飞的改动）。现在的事实是：carrier 不再读它，
    `describe()` 里 `takeOverQuestionsInert` 与 `questionsFace=registered` 会说真话，
    README 那一行标了删除线。**等那半提交之后删键 + 删它那条 warn + 删它的两条测试。**

13. **control 的 npm 还停在 1.2.0**：main 上压着 `c5935bf`（跨端关弹窗）、`ee1f8e3`（文档）、
    `7f1180b`（提问接进 waterfall）三个未发布提交，其中两个是装到 npm 上就能看见的能力修复。
    CHANGELOG 自己写着"发布时该走主版本号"（配对收敛是破坏性变更）——
    **发一个公开主版本这一步等用户点头**，命令就一条：`package.json` 升 2.0.0 → 打标签 →
    推标签（CI 会 verify+publish，见 §1 与 [[reference-npm-publishing]] 的坑）。

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

21. **`pnpm` 11 的 `minimumReleaseAgeExclude` 只认裸包名，不认 `包名@版本`**（2026-10-04 实测）。
    `pnpm add` 自己往 `pnpm-workspace.yaml` 里写的是 `dsh-remote-wire@1.2.0` 这种精确版本，
    而 `pnpm install --frozen-lockfile` 走的**lockfile 复核**那条路径只按名字匹配，于是照样报
    `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`——表现是"装好了、CI 却要红"，而且报错信息会
    建议你去 `pnpm clean --lockfile`（那是把在飞依赖清掉，别照做）。
    改成裸 `- dsh-remote-wire` 才过。范围说清楚：这只对**本家那一个包名**关掉发布年龄闸门，
    真伪仍由 provenance/OIDC 把关；协议升版**不需要**再回来加行。
22. **`kill -TERM` 之后紧跟 `open -a` 会静默不起**（同一条 shell 里连着做更明显）：
    macOS 看到"正在退出"的同名应用就直接把这次 open 吃掉，rc 仍是 0。
    于是后面所有"重启后读数"其实都读的是**旧进程**写的 status.json——
    这一次就差点把"字段没出现"当成"改动没生效"去查代码。
    正确顺序：`kill` → **轮询到 pgrep 空** → `open -a` → **轮询到新 pid 且它的 pid 落进 status.json** → 再读字段。

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
| 发码时机 | **2026-10-03 定的"点开不发码"在 2026-10-04 被用户反转了一半**：现在**未配对点开直接就是二维码页**（中间那一屏与那颗 `生成配对码` 一起删），**已配对点开仍然一次码都不发**。没反转掉的是那条理由——一张码是有寿命的 pending 资源，"看一眼"不该消耗它；反转掉的是它的代价：没配上时面板上根本没有别的东西可看，多点一次只换到一次"原来在这儿"。`ensureFresh` 本身幂等（码还在就还是它），所以"每次点开发一次"不会把 pending 表堆起来 |
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

### 9.12 参考 anywhere-labs 之后：把差异化写成产品定义（2026-10-04 凌晨～清晨）

用户丢来一句"参考 `https://github.com/anywhere-labs`，重新设计一下"。先把参考对象读清楚，
因为它**不是同类里的一个，它就是我们这条赛道上已经跑通的那一个**：

| | Agents Anywhere（1.4k★）+ dsh-desktop（29.8k★） | 我们 |
|---|---|---|
| 宿主侧 | `@agents-anywhere/dsh-bridge-next`，**也是 DSH cordis 插件**，peer `>=0.2.0-rc.1 <0.3.0-0`（**与我们同一代宿主**），且**随 DSH Desktop 打包**，插件页里就叫"远程控制" | 一个插件，装进 profile |
| 客户端 | iOS（App Store）/ Android / Web / 桌面四端 | 微信小程序一个 |
| 能力 | 设备-项目-会话 + 时间线、审批与输入请求、模型/权限/Agent 模式、**发图片与文件**、**文件浏览上传下载**、**远程终端** | 会话列表只读、发文字、看流式、答审批 |
| 前提 | **要账号 + 要服务端**（Cloud 或自托管 Docker，"数据库 schema revision 单独编号"） | 一个自包含单文件 + 一个 systemd 单元，无账号 |
| 数据 | 它自己 README 的原话：「会话、时间线和附件等数据会按所用功能**经过或保存在** Agents Anywhere Server」 | **零知识**：载荷密钥只走配对二维码，中继只见密文（有闸门：`live-e2e` ⑩/⑩b、`run.mjs` 第 16 步） |

四条路（换赛道 / 按它功能表追 / 加一条自托管 Web 端 / 并进它生态）摆给用户挑，
他选了**第一条：把差异化写成产品定义**。定义落在伞仓 **`docs/PRODUCT.md`**（新增，唯一事实源）：
三条承诺（零知识 / 无账号无常驻服务 / 手机免安装）→ 一条判据（**30 秒原则**：
瞥一眼 → 决定一件事 → 走开）→ 四条可判定的规则 → 由规则反推"哪些看着像缺陷的取舍其实是承诺"
（单台配对 = 一把钥匙开一台机器；没有文件浏览器/终端 = 手机上不该做这些事；
模型不能切 = 这一代宿主只给读不给写）→ 五条差距 G1–G5 → **明确不做**清单。

**这一轮从定义里落进代码的是 G3/G4**（control `7e2b7a2`）：
一条挂起的审批/提问正阻塞着远端那台机器上的回合，而这条链在桌面上**唯一的可见点**原来只会说
`已配对`。现在：

- `HostRuntime` 的 `pending` 表加 `kind` / `askedAt`，新增 `waiting` getter（**用 `clock.now()`**，
  于是 FakeClock 能演"已经等了 4 分钟"，那条时长判据才不会永远 0、永远不会红）；
- `GET …/status` 四字段 → **六字段**（`waiting` / `waitingOldestSec`，仍全是非凭据）；
- 抬头优先级钉死：`已断开连接`(红) > **`等 N 件事`**(amber) > `已配对`(绿) > `未配对`(灰)。
  两条排序理由都写在代码注释里：**链都断了说"等几件"没意义**（要修的是连接）；
  **没配上时即使还挂着一条没超时的挂起**（手机中途掉线）抬头也说的是"未配对"——
  那一刻用户能做的第一件事是重新配对，不是去找一台不存在的手机；但**面板那一行仍然要说**，
  因为它回答的是"这台机器上有没有回合被卡住"；
- 面板正文第一行：`待处理 · 2 件 · 最久 4 分 12 秒`（`<60 秒` 只说秒、`>=10 分` 不再带秒——
  这行是扫一眼的，不是秒表）。

**证据**：control **287 pass / 0 fail**（+4），`typecheck` 与 `format:check` 全绿；
`e2e/run.mjs` 现在**在真实挂起态上对账**这条字段——第 13 步（提问卡到达）里
`waiting >= 1`，答案结算之后 `waiting === 0` 且 `waitingOldestSec === 0`
（**一个不会消失的角标比没有角标更坏**，所以清零和计数同等重要），17 步 0 失败；
伞仓 `node --test e2e/*.test.mjs` 125 / 0 失败；真机上重启后实测
`{"relay":"online","paired":0,"serverUrl":"wss://drc.provid.cc","version":"1.2.0","waiting":0,"waitingOldestSec":0}`。
变异验证：把 `pillLabel` 里那条分支删掉，抬头那组判据立刻红（`not ok 60`）。

`scripts/approval-probe.mjs` 加了 `--hold <秒>` / `--port`：卡片到达后**先压住不答**，
这期间逐秒读宿主的 `/status`。为什么需要它：**"挂着一条审批时 waiting 到底是不是 >=1"
这一条只能在真机上对账**，单测验的是函数、`run.mjs` 验的是 mock 内核那条路径。
本轮**没跑它**——`defaultPreset` 已经还原成 `danger-full-access`（那一档 `approval: never`
永远不会问人），要再验一次就得再改一次 profile + 再重启 + 再烧一轮模型，
不值当留给下一次有手机在场时一起做。

**G1/G2/G5 有意没动代码**：三条都要**真手机**才能验（首屏待办化、跨会话的卡不许被
"按会话过滤"那句丢掉、手机上那条"最近一帧多久之前"），而手机现在没配对、也配不上
（扫码要人）。没有验证手段的界面改动不写进树里——这条是用户定的纪律，不是保守。

### 9.13 §9.10 那次修复引入了一个新回归：桌面上 DSH 不弹了（2026-10-04 清晨）

用户一句话点出来："**审批弹窗变成手机弹窗，dsh 不弹窗了，要保留两边的弹窗，插件不改变 dsh 本身的行为。**"

他说得对，而且这条比"手机上能弹"更硬。根因就在 §9.10 那步 `prepend` 的另一半：我们排到
waterfall 最外层之后**在那儿等手机**，而 waterfall 的规矩是"外层不调 `next()`，内层就永远
轮不到"——桌面 UI 那位应答者被我们挡在链子内侧，于是宿主的审批窗整个不出现。
**§9.10 的注释里写了风险（"排到最外层意味着排在 Auto 预置之前"），
却漏掉了更直接的那一半：排到前面之后不调 `next()`，等于吞掉宿主自己的 UI。**

**改成了"两边同时问、谁先给出真实决定谁算"**（control `f291e2c`）：

| 判据 | 为什么必须有 |
|---|---|
| 一进 `participate()` 就 `next()` | 这是"不改变宿主行为"的全部含义。手机答不答、答多快，都不影响桌面那一半 |
| 手机侧 `'decline'`（超时）/`'cancelled'`（被撤回）与链子末端 `'unavailable'` **都不算答案** | 否则"手机没电"会变成"自动拒绝"、"桌面暂时没人"会变成"手机还没点就失败"。两边都收场又都没真答案时由第三条分支兜住，不然后面挂死 |
| 桌面先答时 `controller.abort('desktop')` | 手机那一侧要立刻作废：`pending` 条目删掉、`waiting` 角标归零、防休眠 hold 放掉 |
| 每一路赛跑**带着"是谁答的"回来** | `'rejected'` 这个词手机和桌面都可能给，只比数值就不知道该不该收卡——**第一版就是这么错的**，测试"桌面先答时手机那一侧必须被撤回"把它钉住了 |

**协议侧为"收回手机上那张卡"加了一帧** `ev.permission_resolved {requestId, sessionId?, by?}`
（wire `66e9a63`：zod schema + `PAYLOAD_TYPES` + `permissionResolved()` 构造器 + 自证往返 +
一条取值测试）。为什么必须有：桌面先答之后手机那张卡的倒计时还在走、按钮还能点，
点下去是对着一个已经关闭的请求做写操作。**反方向收不了**——手机先答之后桌面那张要等宿主
自己的 `signal`（这次工具调用的生命周期）结束才消失，插件没有那个句柄；
这是"两边都弹"必须付的代价，写下来是为了下次别去找不存在的解。

**闸门（这一节）**：control **290 pass / 0 fail**（+3）、`typecheck`、`format:check` 全绿；
协议仓 83 / 0 失败。变异验证：把 `participate()` 里那句 `next()` 拿掉，红线那条测试
（"手机先答也必须把链子交给桌面"）立刻红。

**真机复跑（race 那一版，`--hold 8` 顺手把 §9.12 那颗角标也验了）**：

| 时刻 | 读数 |
|---|---|
| 卡片到达、压住不答的 8 秒里 | `GET …/status` 逐秒报 `waiting=1`、`waitingOldestSec` 从 1 涨到 8——抬头那句"等 1 件事"在真机上是**活的** |
| 手机答"允许一次"之后 | `approvalCalls=1`、`approvalLast=answered-by-phone(allowed-once)`、`approvalDecided=allowed-once`、`outbound.permission_request=1` |
| 探针断开之后 | `/status` 回到 `waiting=0 / waitingOldestSec=0`——角标会消失，不会挂成一盏不会走的红灯 |

⚠️ **还差一步没验到**：桌面上那个审批窗**这次是不是真的又弹出来了**。这台机器上 Computer Use
点不动也读不到渲染树（AX 只交出菜单栏、截图策略 `AX_ONLY` 让坐标点击一律被拒），
宿主 UI 侧也没有留给插件可查的痕迹，所以只能靠用户看一眼。
数据面上能证明的只有"`next()` 被调用了"（那条单测 + 变异验证）。

`--hold` 这个开关就是为"必须在挂着的时候读数"的场景加的；顺带再记一次
**`status.json` 按定时器刷，读它一定要轮、要带基线**（探针第一次就报过一句假的 `approvalCalls=0`）。

### 9.14 `droppedFrames` 的主要来源找到了：不是身份漂移，是往空会话广播（2026-10-04 早晨）

§9.13 收尾时顺手看了一眼 `/healthz`：`droppedFrames` 从当天的 56 涨到 **5737**，
而且挂着一条 `conversations:1 / clients:0`。这条值得查，因为它直接决定
"这个指标还能不能用来判断丢帧"。

**对照实验（改之前）**：空载 45 秒里中继 `droppedFrames` **+9**，
同时插件的 `session_changed` / `model` / `keep_awake_state` 各 **+3** = 9 帧。**逐帧对得上**：
手机断开之后，主机仍然每 15 秒往那条空会话广播三帧，中继每一帧计一次丢帧；
而会话默认 7 天 TTL，所以这条路会一直流。

**根因是一个名字**：`hasPeer()` 答的是"**我手里有没有这条通道的密钥**"
（`conversations.has(id)`），而三个调用点（审批、提问、`pickConversation`）和 `broadcast()`
要的都是"**现在有没有人能收**"。两者在手机上线时恰好同真，所以错误一直藏着。
拆成 `has(id)`（密钥，D3 重连必须留着）与 `hasClient(id)`（成员表非空），
`send()` / `broadcast()` 只认后者（control `7a01d09`）。

**顺带挖出一个更早的错**：成员表 `clientIds` 原来**只靠"收到过这台手机的 enc 帧"长出来**，
而手机回前台时中继发的那条**不带 `pairingToken` 的重连通知**在本端是直接 `return` 的。
后果：重连之后、手机第一次发东西之前，本端以为"这条会话没人"——
`status.json` 里"有几台手机连着"会短暂报 0，而且**任何**以"有没有活客户端"为准的判断都慢一拍。
（这条如果不先修，上面那个广播闸门就会引入一个真 bug：手机回前台后收不到任何更新。）

**对照实验（改之后，同一幕造出来）**：配对让 runtime 起来 → 断开 → `conv=1 / clients=0`，
62 秒里中继 `droppedFrames` **5878 → 5878 一动不动**；插件本地照旧记
`session_changed_no_peer` +4 —— **"主机想发、当时没人听"是本地事实，
不该变成中继指标里的一次丢帧**，这两个计数分开之后才各自能用。

**所以要更正 §3.3/§3.4 里的一句话**：原来写"这与那些丢帧是同一个形状（身份漂移）"——
身份漂移确实存在（也已经修了），但它**不是 `droppedFrames` 的主要来源**，
往空会话广播才是。以后看这个指标，先确认手上有没有一条 `clients=0` 的会话挂着。

**闸门**：control **290 pass / 0 fail**、`typecheck`、`format:check` 全绿；
两处新判据都做了变异验证（拿掉 `send()`/`broadcast()` 的活客户端闸门 → 两条红；
拿掉重连登记 → 同样两条红）。

**还没做的一条**：中继侧对"只剩主机、没有客户端"的会话**没有任何回收**（7 天 TTL 之内
一直挂在 `conversations` 里）。这一版把"主机白发"止住了，但那条记录本身还在，
`/healthz` 的 `conversations` 仍然会虚高。要不要收（比如"最后一个客户端走光后 N 分钟回收，
N 远小于 7 天"）是**中继的产品决定**，摆着等用户拍——它和 D3"手机回前台不该重新扫码"是有张力的。

### 9.15 跨端关弹窗：任一端答完，其他端那张卡要当场作废（2026-10-04 中午）

用户提的形状是「任意一端点了同意，其他端**识别到 flow 继续**的时候要关掉弹窗」。
两端各欠一半，而且**这两半用的不是同一个机制**——先说清为什么必须分开。

**手机上那一半：`ev.run_state` 就是这套协议里的"卡片作废"信号**（不是我们临场找的）。
`dsh-remote-mp/pages/chat/chat.js` 的 `_onRunState` 原文注释写着
「这条帧是'挂着的审批/提问已经作废'的唯一信号（只有 running/idle 会发）」，
它同时清 `pendingPermission` 与 `pendingQuestion` 并停掉那条本地倒数。
**根因**：内核不会为"审批被别人答掉了"发状态跳变——这一回合自始至终是 `running`，
所以手机上那张卡要等到回合真正结束（或它自己倒计时走完）才消失。
**修法**：`runtime.settle(id, value, voidAs?)` 多一个"这一场是谁收的场"
（`'desktop'` / `'withdrawn'` / `'timeout'`；手机自己点的传 `undefined`），
非手机收场时补一帧 `ev.run_state`。补的是**内核真相**（`kernel.runState(sessionId)`），
读不到才退缓存快照、再退 `idle`——手机上那个"思考中"跟着这帧走，硬发 `running` 会凭空多一个转圈。
提问那条也一起管住了（同一处结算点），并且**超时路径不再各自 `pending.delete`+`resolve`**，
三条收场共用一个结算点，作废与释放挂锁不会再分叉。
选它而不是新帧的**决定性的理由**：手机现在装的这一版小程序就认它——
不用等 wire 发布，也不用让用户重新上传小程序（§3.10 那条精确帧因此降级成"锦上添花"）。

**桌面上那一半：句柄只有一个，`request.signal`。**
读码读到三处才把这条链对上（都在 `app.asar` 里，取证路径记在下面）：

1. `@deepseek-ai/cordis` 的 `EventsService.waterfall`：
   `const next = () => (cbs.shift() ?? inner)(...args)` —— **`next()` 的实参被整个忽略**，
   所以参与者**没法用返回值换掉下游收到的请求对象**；能动的只有那个对象自己的字段。
2. `@deepseek-ai/dsh-user-approval` 的 `ApprovalService.decide`：`const signal = req.signal`
   是在**派发之前**读的，之后没人再读原件——所以我们换掉 `req.signal` 不会影响宿主自己的
   `cancelled` 判定，只影响下游应答者。
3. `@deepseek-ai/dsh-api-gateway`：宿主侧 `startRemoteEvent()` 把 `projected.signal`
   放进 `signals`，它一断就 `cancelRemoteEvent()` → `finishRemoteEvent()` 向**每一个**渲染端
   推 `{type:'cancel', eventId}`；客户端 `pumpEvents()` 收到那句就
   `controller.abort(new Error('Remote event was cancelled by the Host'))`，
   `dispatchWaterfall()` 递给 UI 的 `request.signal` 正是这条 delivery signal 的派生，
   于是 `dsh-client-ui-approval` 的 `PendingApproval.abort()` → `answerApproval` 的
   `finally { remove() }` → **卡片由宿主自己的代码收掉**。
   `projectRemoteEventRequest()` 还顺手确认了两件事：`signal` 必须是 `instanceof AbortSignal`
   （我们给并算后的那条，合法），而 `agent`/`signal` 两个键被排除在 JSON 投影之外
   （所以我们塞进去的 signal 不会被当成"非 JSON 字段"抛）。

**结论**：`participate()` 里把交给下游的那份 signal 换成 `AbortSignal.any([平台的, 我们这条])`，
手机先答时撤销我们这条。语义是**宣告"这次请求结束了"**，不是替桌面决定结果——
结果早就由先答的那一端给出了；而 DSH 自己在多窗口场景本来就是这么做的
（第一个客户端给出结果时 `finishRemoteEvent` 向其余客户端发 cancel），我们只是把同一条规则
延伸到"第二个应答者"。**顺序很要紧**：先抓 `platform = request?.signal` 原件、再接上去，
反过来的话我们自己那一下撤销会顺着并算回到 `controller`，runtime 会把手机刚点掉的应答
当成"被撤回"再作废一遍（这条有测试盯着）。

顺带修掉一个**没有手机时的挂死**：桌面上没人点、链子末端也没有人答时，
`next()` 那条分支原本永远悬着；现在结算点一律 `finish()`，并算信号断掉 → 网关 cancel → 交还。

**取证路径**（下次别重新发明）：宿主代码在
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，
`npx @electron/asar` 不在依赖里，用一个 30 行的 node 脚本读 header（`headerLen = buf.readUInt32LE(12)`，
数据基址 = `16 + headerLen` 再 4 字节对齐，`offset` 是**字符串**、`unpacked:true` 的条目没有 offset）
就够把 `dsh/node_modules/@deepseek-ai/**.js` 抽到 /tmp 再 grep。

**可观测**：`status.json` 的 kernel 块多两个字段——`approvalSignalHandoff`
（`fused` / `ignored` / `failed: <原因>`，严格模式给不可写的 `signal` 赋值会**抛**，
那里必须包 try：一抛会顺着 waterfall 把宿主的这次审批判死）与 `approvalDesktopVoided`
（**只在换成功时**计数）。屏幕上看不见那张卡收没收，就看这个数加没加：
加了而卡还在 → 问题在渲染端；没加 → 我们这一侧没换成功。

**闸门**：control **319 pass / 0 fail**、`typecheck` 绿、`format:check` 绿；
`e2e/run.mjs` 17 步 0 失败。六次变异各自都被抓住，且**只**抓住对应那条：
不换下游 signal / 手机先答时不撤销 / 撤销时连 runtime 那侧一起带倒 → 各 1 红；
结算点不补帧 → 5 红；reason 不区分桌面先答 → 1 红；作废帧硬发 `running` → 1 红。

**还没取证的那一半（要人眼）**：整套机制在**宿主真实的渲染端**是否表现为"桌面那张卡当场消失"，
我这台机器上没法自证——Computer Use 看不到这个 app 的界面（AX 树只给菜单栏，
capture policy 是 AX_ONLY 所以坐标点击直接报错）。所以这一条只能等用户按屏幕：
**手机先答一次 → 看桌面 composer 上那张审批卡有没有当场不见**；
反方向（桌面先答 → 手机卡当场收）这一版是自动的，`/status` 的 `waiting` 归零同时卡片也被作废帧收掉。

### 9.16 提问这条链：它以前根本到不了手机，现在两端同弹（2026-10-04 午后）

用户问"提问卡也有这个问题吗"。查下来的答案比"有"更难看一层：**提问卡从来没有到过手机**。

**根因不是"没关"，是"没接上"。** 我们原来那条路是 `ctx.userQuestions.registerProvider(...)`，
两个问题叠在一起：

1. **这一代宿主没有那个成员**。把 `@deepseek-ai/dsh-user-questions/lib/index.js` 整个扒出来看，
   `provider` 这个词**零命中**，服务成员只有 `ask / askTimed / answer / continued / releaseReply / assertLiveRoot`。
   所以 `takeOverQuestions` 打开也只会得到 `questionsFace = no registerProvider (keys=…)`。
   现网读数当时是 `takeOverQuestions: false / questionsFace: not-taken-over`——**默认关**，
   于是这条链在真机上从来没有第二端。
2. **就算它存在，"注册一个提供者"是单提供者语义**：接管 = 桌面问不了问题，
   而那条正是 §9.13 用户当场划的红线（插件不许改变宿主自己的行为）。config 里那条 warn
   写的就是这件事——所以那个键的存在本身就说明这条路是错的。

**正确形状与审批完全同一条**：宿主自己的 `UserQuestionService.ask()` 末端就是
`ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', {...request, agent}, noAnswerer)`，
而桌面 UI 是网关转发的 `$on("user-questions/request", function(request, next) …)`
（`dsh-client-ui-user-questions/lib/client.js:1927`，`answerQuestion` 里那句
`AbortSignal.any([claimLifetime.signal, request.signal])` 也确认了**同一套撤销句柄**）。
所以 `participate()` 参数化成两条共用一份实现：一进函数就 `next()`、手机并行问、谁先给真答案谁算、
手机先答时撤销交给下游那份 signal。guard 的 `WATERFALL_PARTICIPANTS` 从一条变两条。

**两条 waterfall 唯一的实质差别是"没人答"怎么表达**：审批那条链末端 resolve `'unavailable'`，
提问那条是 `noAnswerer()` **抛** `NO_PROVIDER`。所以提问的最后一条分支必须把原始 rejection
复述回去——把它吞成 `undefined` 就是 §9.10 里那条"每个 turn 都崩"的形状。

**手机端同时挂两张卡是真事，不是理论**：审批与提问共用一条本地倒数
（原来那条只读 `pendingPermission`，所以提问卡即使有 `expiresAt` 也没人替它走数）。
到点停表但不清卡；清卡只由 `ev.permission_resolved` / `ev.question_resolved`（按 `requestId` 收一张）
或 `ev.run_state`（这一会话两张一起收）来做，且这两条精确帧**不动 `running`**——
回合在不在跑归 `ev.run_state` 说，两处各改一半迟早打架。

**真机取证（这一次不用等人点桌面，两条判据都是自动跑出来的）**：
`ask_user_question` 不依赖执行/写文件工具，所以在那台"所有旧会话 `run_code` 都 unknown tool"
的宿主上，它是**唯一还能造出来的第二端**。

```sh
# ① 手机先答 → 桌面那句柄被撤销
node scripts/approval-probe.mjs --session new --prompt '请用 ask_user_question 工具问我一个单选题…'
#   ev.question_request(带 expiresAt) → cmd.answer →
#   questionsCalls=1 questionsLast=answered-by-phone(1 项) handoff=fused desktopVoided=1

# ② 主机收场 → 手机那张卡当场作废
node scripts/approval-probe.mjs --session <同一条> --interrupt-after 6 --prompt '请再用 ask_user_question…'
#   收到 {"t":"ev.question_resolved","requestId":"q_6e5ac9c9","by":"cancelled"} + 一帧 ev.run_state
#   questionsLast=no-answer（链子的 rejection 被原样复述，没吞掉）
```

**这里踩到一个判据自己骗自己的坑，值得记住**：`--interrupt-after` 那一跑，⑦ 那条
"收到作废帧"先返回了一条 `ev.run_state{state:'running'}`——那是**回合刚开始时内核自己发的**，
不是我们补的那一帧。凡是"某端收场"的判据，都不能拿 `run_state` 当证据（它有两种来源），
要么等**精确帧**、要么等 `pending` 归零再读。改完 ⑦ 之后优先看 `resolvedFrames`。

**还留着的两件事**（都不是"忘了"，是有人要点头或有人在飞）：
- `takeOverQuestions` 这个键**已经不生效**（carrier 不再读它，`describe()` 里
  `takeOverQuestionsInert` 会把这点说出来），删键本体要动 `shell/config.ts` 与 `src/index.ts`——
  这两棵树此刻正被并行会话的 pair-store 改动占着，**不能顺手提交别人的在飞改动**，留作单独一轮。
  README 配置表那一行已经标了删除线。
- control 的 npm 版本还停在 **1.2.0**，main 上压着 `c5935bf / ee1f8e3 / 7f1180b` 三个未发布提交
  （其中两个是用户看得见的能力修复）。发不发是"公开一个破坏性主版本"这一步，等用户点头；
  协议那侧的 `dsh-remote-wire@1.2.0` 已经发了并带 provenance（这一轮编译必需，所以先发）。

### 9.17 「先按一颗生成配对码」那一屏删掉了（2026-10-04 傍晚）

用户一句话：**未配对直接进配对二维码页，删掉生成配对码按钮的那个页面**。

这一条是把 §9.x 里 2026-10-03 那次"点开不发码"的取舍**反转一半**，所以把两边各自守什么都写清楚：

| | 2026-10-03 那次 | 2026-10-04 这次 |
|---|---|---|
| 守的东西 | 一张码是有寿命的 pending 资源，"看一眼"不该消耗它 | **同一句**，但只管**已配对**那一侧 |
| 未配对点开 | 连接信息 + 一颗 `生成配对码` | **直接就是二维码页**（自动发一次码） |
| 已配对点开 | 状态 + `退出配对` | 不变：状态 + `退出配对`，**一次码都不发** |
| 那颗按钮 | 三种身份（`生成配对码` / `刷新` / `退出配对`） | **两种**：没配上 `刷新`、配上了 `退出配对` |
| 退完配对 | 停在状态屏等人按 | 就势回二维码页（那一屏此时唯一的内容就是下一张码） |

反转掉的是**代价**不是**理由**：没配上时面板上没有任何别的东西可看，那一次点击换到的是
"原来码在这儿"。而 `POST /pairing/new` 走的是幂等的 `ensureFresh`（码还活着就还是那一张），
所以"每次点开发一次"不会把中继的 pending 表堆起来——这一条是这次反转**能成立**的技术前提。

**顺手补的一个洞**：二维码那一屏原来 `return` 掉正文（中继 / 状态 / 版本 / 待处理）——那是
"未配对先看连接信息、要看码再按一次"的形状留下的。未配对默认就是二维码页之后，藏掉它等于
把"连的哪一台、连没连上、跑的是哪一版、这台机器上有没有回合被卡住"四条事实一起从未配对的
屏幕上删走（伞仓 `docs/PRODUCT.md` §3 第 2 条要它们在场）。现在**三种视图都带那几行**，
`loading` 也带，否则面板会从窄跳宽。

**判据**：`client-bundle.test.ts` 两条新的——「未配对点开直接就是二维码页：发**且只发一次**码」
与「已配对点开一次码都不发」，加一条「退完配对就地回到二维码页、那颗按钮当场翻成 `刷新`」。
四次变异各自只抓自己那条：不自动发码 → 7 红；已配对也发 → 1 红；退完补一次立即轮询（把乐观
翻面盖回去）→ 1 红；二维码屏藏正文 → 4 红。

### 9.18 pair-store 落库 + 审批链真机闭环（2026-10-04 傍晚，接 §9.17）

两件事：一件是收尾，一件是取证。都发生在用户把审批策略改成 `ask`（文件策略 `read-only`）之后。

**① pair-store 终于进 git。** 代码 11:05 起就在工作树里、15:42 部署的 bundle 在跑、
16:00 重启后 `pairStore.restored=1` 且手机免扫码回连——但仓里一直是未跟踪/未提交。
提交前补齐闸门：control `pnpm -C packages/plugin test` **328 pass / 0 fail**、
伞仓 `node --test e2e/*.test.mjs` **135 / 0**、`node e2e/run.mjs` **17 步 0 失败**。两个提交：

- control `c762fcc`（`feat(host)`，9 文件 +940/−70）：`shell/pair-store.ts` 新文件 +
  config/keys/relay/index 四棵树 + `.gitignore` 的 `conversations-*.json` + 三个测试文件。
  **git 与现实从此对齐**（生产进程跑的已经是这份代码）。
- 伞仓 `d72a7d0`（`test(e2e)+docs`，3 文件 +207/−14）：`run.mjs` 的 `pairStoreFile` 入参、
  `restart-resume` 的 (c) 判据翻面（"必须能续用"）+ (d) `'off'` 对照、
  `BOOTSTRAP-ASSESSMENT.md` 补落地记录。`.workbuddy/**` 记忆文件按惯例仍未提交。

**② 审批链真机闭环——答卡的是真手机，不是探针。** 原计划用 `scripts/approval-probe.mjs`
（假手机，会按"只允许一台"把真手机踢下线），实际没必要：`read-only` 下 `git add` 被拒
（`.git/index.lock: Operation not permitted`），按升级路径带 `sandbox_permissions` 重试的
**两次提权审批本身就是真机用例**。宿主 `status.json` 的 kernel 读数：

| 字段 | 值 |
|---|---|
| `approvalCalls` | 0 → **4**（请求真的派发到了插件监听器，`global`+`prepend` 生效） |
| `approvalAsked` | 4 |
| `approvalLast` / `approvalDecided` | 先 **answered-by-phone(allowed-once)**×2，后 **answered-by-desktop(allowed-once)** |
| `approvalSignalHandoff` | **fused**（交给桌面那份 signal 换成功） |
| `approvalDesktopVoided` | **2**（手机先答 → 桌面卡片关闭句柄被按下） |

读法：派发到了 → 手机与桌面同时问 → 先答的那端赢 → 手机先答时桌面那份 signal 被撤销
（网关据此向渲染端推 cancel，桌面卡片由宿主自己收掉）。§9.13 的"两边同时问、谁先答谁算"
与 §9.15 的"换 signal"在真机上第一次同时成立，且**两个方向都验到了**（手机答两次、
桌面答一次）。

如实记一条没说清的：派发次数 vs 提权调用次数。被 `read-only` 直接拒的那次尝试
大概率也进了 waterfall（fail closed），也可能是按文件操作粒度计的——**无法回溯，标为推断**。

**还欠的人眼**：桌面那张审批卡是否真的在屏幕上"弹出来 → 另一端一答就消失"。
`approvalDesktopVoided` 证明请求到了桌面且句柄被按下，但视觉只有用户能确认。

**顺手撞见的现成演示**：答完卡后 `pairedClients` 与中继 `clients` 都归 0（小程序退后台），
而 `conversations=1`、`pairStore.restored=1`——**重新打开小程序就应当免扫码回到同一条会话**。

### 9.19 手机聊天框三连修：XML 不再裸露、title 取 description、结果预览不再乱码（2026-10-04 晚，接 9.18）

用户拿三张真机截图点三件事：① 聊天框里出现原始 tool_call XML；② run_code 看不懂，要结构化；
③ 结果文本里是字面量的反斜杠n与反斜杠引号（markdown 乱码）。三者的根因**都在插件侧的形状映射**，
mp 一行未动（真实形状全部从本机 session log ~/.dsh/sessions/**/session.v4.jsonl.zstd 逐字取证）。

| 截图上的事 | 根因（真机形状） | 修法（control c10f7b3） |
|---|---|---|
| XML 裸露 | assistant/message 的 content 里，工具调用被写进**两个** part：结构化 tool-call part
  （textOf 本来就跳过）+ 一个 text part 的 XML 序列化。旧实现把 text part 原样透出 | 新增
  stripToolCallXml：只剥完整块与尾部未闭合块（开标签后须紧跟 function=——正文里反引号提到
  的标签不受影响，真机上助手解释手机上有原始 XML 时自己写过那个标签）；剥完是空串仍发
  空正文帧（mp 的 _applyText 对空正文不建块，messageId 必须带着） |
| title 看不懂 | tool/call 的 arguments 是 JSON **串**，旧实现整串当 title（run_code 每条 455 字符） |
  新增 argsTitle：优先 description，其次 command/prompt/path…；argsPreview 可解析时美化
  （真换行、缩进） |
| 结果乱码 | tool/result 正文是 data.message.content，一个 **part 数组**；旧实现对非字符串一律
  JSON.stringify，于是手机上每个结果都是 part 数组的壳 + 内部被转义的换行与引号 | previewOf 改走
  readableText：数组取文本 part、对象按 content/text/output/stdout/message/result/error
  递归取人话，非文本 part 跳过，取不到才 stringify |

**闸门**：plugin test **334 pass / 0 fail**（+6 条 carrier-vocabulary 用例，形状全部抄自本机 log）、
typecheck 0、format:check 0；伞仓 e2e **135 / 0**、run.mjs 17 步 0 失败。
**已部署**：build + 替换 profile 扁平目录（18:12），**要用户重启 Harness 才生效**；mp 无需重传
（修复全在插件侧，且历史回放走同一个映射函数，旧会话翻上去也不会再见到 XML）。

**两条判据自己错过一次**（形状比修法值钱）：① 未闭合块用例最初期望剥完不含换行，实际夹具里
块前就有一个换行——剥块不动其他字节，错的是期望值；② 没有字面量反斜杠n最初写成 TS 的单反斜杠
 escape（那是真换行），要两个字面量得写双反斜杠。**判据红时先逐条查是判据错还是实现错。**

### 9.20 手机 markdown 窄排修复：list/table 宽度与缩进（2026-10-04 晚，接 §9.19）

用户真机截图：markdown 的 list 与 table 宽度不对、缩进不对。根因两条，都在 rich-text
的布局（截图复现装置：mp-shots 新增 `chat-md-width` 一张，走 `_applyDelta` 真实路径）：

| 截图上的事 | 根因 | 修法（mp `09b2fd2`） |
|---|---|---|
| bullet 每行只排五六个字 | **p 嵌 p 会 shrink-to-fit**：blockNodes 的 default 分支把
  text token 当容器递归，每个行内 token（文本/加粗/行内码）各自变成一个 p，列表项于是 p 嵌 p |
  blockNodes 增加 `text` 分支：一个 p 包着行内节点 |
| 表格两列都窄 | `tr/td/thead/tbody` 上的 `display:block` 在 rich-text 里同样坍缩 |
  去掉这些 display:block + 表格加 `table-layout:fixed`（td 的 `min-width:120rpx` 保留——
  那是过去"窄列被中文长词撑破"的闸门；3 列以内不影响已验证渲染） |
| 列表缩进不对 | ul/li 标签本身坍缩 | listNode 重写：每条目一个**顶层 p**（满宽），
  嵌套列表**摊平**成同层后续条目、缩进逐层加深 28→56rpx（不嵌套 p——那正是要修的东西） |

**判据**：check-markdown 4 处形状随实现更新、意图不变（列表要渲染 / marker 独立成节点 /
缩进用 padding / td 有 min-width）；`npm run check` **32/32**、伞仓 e2e **135/0**、
`run.mjs` 17 步 0 失败。**已上传开发版 1.0.1**（mp-upload），要用户在公众平台
「选为体验版」后重开小程序生效。

**方法论沉淀**：rich-text 的渲染问题，截图复现装置（mp-shots + automator）比读代码猜快——
本轮三条假设（换标签/换 CSS/摊平）全部是先改后截、截完再定。⚠️ mp-shots 连上 IDE 后
第一张 shot 有一次渲染成空状态的偶然（后续复跑全对），**截图前先确认画面非空**。

### 9.21 发布双响：control 2.0.0 上 npm、中继 v1.0.2 上线（2026-10-04 21:12–21:33）

**control 2.0.0**（npm `dsh-remote-control@2.0.0` + provenance + GitHub Release）：
npm 停在 1.2.0，仓里压了 21 个提交（3 个 `!feat`：pill 面板反转 ×2、questions 链接通；
跨端作废、审批双端同弹、免扫码重连、聊天三连修）。流程：CHANGELOG 的 `未发布` 翻版本号
（顺手补了两条漏账：免扫码重连、聊天三连修）→ `c1364ed` → push main → tag `v2.0.0` →
Release 工作流（14 步）自动跑。

⚠️ **假红教训（第三回）**：Publish 绿、npm 上 2.0.0 在、attestation 几分钟后 curl 也在，
但 `Verify provenance landed` 的轮询（200s）在它落地之前放弃 → 这一步红 → 
`Create GitHub Release` 整个没跑。**捞回来的前提是 Publish 幂等**（版本在注册表就跳过）——
`gh run rerun <id> --failed` 只重跑红的那几步，verify 绿、Release 补建（37s）。
已把窗口放到 80×5s=400s（control `6b7f00c`）：注册表侧的落地延迟是它的事，不该由我们判红。

**中继 v1.0.2**（`d23944c` counters 按周期进日志，`6bb8941` + tag + Release 挂单文件产物
`dsh-remote-relay.mjs` + `SHA256SUMS`）：下载后 `shasum -c` 过 → scp → restart → 服务器侧
sha256 与产物逐字节相同（`d43c0d86…`）→ `/healthz` 报 1.0.2。部署前后 hosts:1→(重启)→回 1。
droppedFrames 从此有历史可查（journalctl 差值），不再只有当前进程内有值。

### 9.22 pill 不再把"手机离线"说成"未配对"（2026-10-04 21:33，control `b4b7625`）

用户报：小程序离线的状态下 pill 显示"未配对"，会误解——其实配对着，回前台会重连。
根因是 pair-store 之后的语义漂移：配对按 D3 长存、落盘，而"配没配上"读的是
clientCount（此刻几台手机连着）——手机退后台 socket 一断就翻成未配对，点开头一颗按钮
还会去烧一张不需要的新码。

修法（三态 + 一个字段）：`/status` 新增 `pairings`（会话簿里几条会话 = 配对还在不在），
与 `paired` 分开报；抬头三态 **已配对（绿）/ 手机离线（黄）/ 未配对（灰）**；
离线那一屏多一行"配对还在：小程序回前台会自动重连，不用重新扫码"。
四处"配没配上"的判定（按钮身份、点开发不发码、配好翻不翻面、退出配对的乐观翻面）
改读密钥簿；退出配对时乐观状态**连簿一起清零**——只清零 paired 会掉进新的"手机离线"，
而那一刻真正的事实是"没配上了"。

判据：client-bundle 新增"手机离线"用例（含按钮身份、不放码、解释行三件事）；
pill-routes / pill-isolation / 伞仓 run.mjs 的字段集合判据**六改七**。
plugin 335/0、typecheck/format 过、伞仓 e2e 135/0、run.mjs 17 步。已装进 profile，
**待重启 host**——"手机离线"这一屏要在真屏幕上验一次才算完（its 判据：手机退后台时
抬头变黄字、点开没有二维码、按钮还是"退出配对"）。

### 9.23 chat 贴底跟滚修好 + 「回到最新」换悬浮圆钮（2026-10-04 22:00，mp `b758e79`，已传 1.0.2）

用户报：点位在最新时要自动跟滚（回到最新之后也要），回到最新换个时兴样式。
automator 实测 + 代码走查处两个根因（都与 D3 免扫码无关，是这一页自己的老问题）：

1. **打开会话停在最旧处**：第一页历史也走 `noScroll`，而 `onReady` 之后没有任何东西
   把视口推到底——实测 `scrollTop=0` 而 `atBottom` 说是 true（自相矛盾）。
   第一页带的就是最新内容，改成落底；往前插更早内容仍静默（那是另一套内容锚点机制）。
2. **回到最新之后不跟滚**：`onScroll` 有一段 `deltaY<0` 一刀切，连程序滚动一起毙——
   iOS 上 scroll-into-view 落底有回弹，尾帧 deltaY 是负的，于是用户刚点完「回到最新」，
   下一帧跟随就被关掉、按钮重新浮出、后续 delta 不跟。改成**位置才是判据**，
   deltaY 只当提前量（容差内上拖立即停），且「回到最新」后 600ms 内不认这个提前量。

**样式**：居中灰药丸+圆点+文字 → 右下角品牌色悬浮圆钮 + CSS 箭头（两条 border 转 45°，
不引图标库），180ms 入场动画，落底即隐。截图判据 mp-shots 新增 `chat-jump-fab`。

**判据纪律**：e2e 里旧有一条「历史加载不该动滚动锚点」，理由「首屏本来就停在最新」——
**那个前提被实测证伪**（它把 bug 钉成了意图）。按新意图重写为「第一页落底 + 前插静默」，
另加 3 条：贴底跟滚翻锚点 / 上拖停跟 / 回弹帧不关跟随 + 窗口过期恢复。
mp-chat-blocks 50/0、mp check 32/32、伞仓 e2e 138/0、run.mjs 17 步。
**开发版 1.0.2 已上传，待用户在公众平台选为体验版。**

### 9.24 排队消息 + 图片附件：四层全链路（2026-10-04 22:40，wire 1.3.0 / control a300970 / server 1.0.3 / mp 1.1.0）

用户要的两个新特性，一次做完全链（协议 → 插件 → 中继 → 小程序）：

**1. 排队消息**（mp 侧）。会话在跑时继续打的内容进队列：贴在输入区上方、
可收起（长队列不许把消息区顶掉）、超长文本截断一行、每条可撤；
会话转空闲按序发出（两条之间 800ms 一拍）。

**2. 图片附件**。加号在输入框左侧 → 动作条（这一代只放「图片（从相册选）」，
拍照与文件留白但话说明白）→ chooseMedia(compressed) → compressImage(0.6) → base64 →
随 cmd.send_prompt 发出；输入区上方一条缩略图 Strip，可逐张移除。
- **协议**（wire 1.3.0）：`cmd.send_prompt.images` 可选字段，`imageAttachment`
  （name/mediaType 只收 jpeg/data base64/宽高可选），上限 4 张。**向后兼容**：
  不带的老手机照旧发，带了发到老主机那边 zod strip 掉——不升协议版本。
- **插件**（control a300970）：内核端口只收文本，所以主机把图**落盘**
  （`uploads/<会话>/`，0600，文件名过 safeSegment）再把路径写进正文之后：
  `[图片附件 N 张，已存到本本机]` + 路径清单。整批校验通过才写盘（被拒的批次
  一个字节都不留）；默认**不收**（uploadDir 空 = 拒收），要放开必须在配置里给目录。
- **中继**（server 1.0.3）：`DRC_MAX_MSG_BYTES` 256KB → 1MB。一张 q0.6/1600px 的
  jpeg base64 后常超 256KB，连一张都紧巴；1MB 给到 4 张的余量。零知识规矩不变。

**gzip 调研结论（用户问的）**：**不做，也没用**。载荷是 JSON → nacl.secretbox
（xsalsa20-poly1305 流密码）→ base64，密文熵已最大，gzip 压不动；而图片本身
就是 jpeg（已压缩）。真正的杠杆是 mp 侧的尺寸/质量参数 + 帧上限，这两处都做了。
（除非将来要传 png/纯文本大块，那是另一题。）

**两个真 bug 顺带修掉**：① `_onRunState` 的 commit 用的是进水前快照，
  drain 放在它之前会把刚发出的本地回显整段盖掉——挪到 commit 之后；
② e2e 夹具 setByPath 不认 `blocks[N]` 整块替换（思考计时器的合法形状），
  计时器 tick 落进隔壁用例会报假失败。

判据：mp-chat-blocks 54/0（+4 条，旧 1 条改判：在跑时发送不再直接落块——进队列）；
mp check 32/32（对比度 282 组）；plugin 341/0；伞仓 e2e 142/0、run.mjs 17 步；
wire 138/0。mp-shots 新增 chat-composer 渲染层验收。
**上线顺序已按兼容性排好**：wire 1.3.0 → control a300970（已推 main+装 profile，待重启）
→ server 1.0.3（已上线，healthz=1.0.3）→ mp 1.1.0（已传开发版）。
⚠️ 中继重启是按既有设计会失效手机通道的那一类（relay 的会话表是内存态、由配对claim
创建，resync 只删不建）——手机下次回前台会提示重新扫码，扫一次即可（主机侧不用动）。

### 9.25 配对码两条 TTL 分叉：本地过期、中继还有效时发码回半条码（2026-10-04 23:00，control 536bc83）

用户实测：小程序断开重连后点 pill 的「刷新」，报「配对请求没成功：
发码回答里的码不完整」，而且按一次撞一次。

**根因**：两条 TTL 分叉——中继日志里 pair token issued 的 ttlMs 是 **180000**
（不是我写在 env 里的 90s，那个值没生效；服务端默认就是 180s），插件本地默认 120s。
中继的 pair-ready 会用服务端权威 TTL 改写 **slot** 的过期时刻，而
`currentPairing()` 回的是 `active.pairing` 里那份出码时的旧值（没人更新它）。
于是本地过期之后、中继还有效的整整一段里：`resolveFor` 认这张码（slot 活着）
→ 发码路由回 ready，却拿旧值算 `expiresInMs = max(0, …) = 0` → pill 判「码不完整」。
直到 slot 也过期才重烧一张——中间那一分钟里每次点刷新都撞。

**修法两道**（都在 index.ts）：
1. `currentPairing()` 改读 **slot** 的过期时刻（服务端权威，与 status.json 的
   `describeActivePairing` 同一个口径）；
2. `ensureFreshPairing()` 加运行时兜底：resolveFor 用 clock.now()、路由算 expiresInMs
   用 Date.now()，两个时钟之间有窗口——到点的码不当 fresh，现补一张（中继不在就
   回 null 走 unavailable），而不是回半条码。

**判据**：e2e/pair-ttl.test.mjs（本地 ttl 1s vs 中继默认 180s，越过本地 TTL 后
/pairing/new 必须仍回完整码、且是同一张）。**先在旧 dist 上跑红过**
（实测 state=ready, expiresInMs=0——与用户报的一字不差），rebuild 后绿。
伞仓 143/0、run.mjs 17 步、plugin 341/0。

**同一条报错里的另一半**（pill 在手机离线时闪「未配对」）是今天那个三态修复，
在 main 上但要重启才生效——与这个修复同一个重启窗口（control 536bc83 已装 profile）。

### 9.26 解除配对收进主机卡，「重新配对」删除（2026-10-04 23:15，mp 1.1.1）

用户拍板的一处交互归位：sessions 页底部原来三颗入口
（重新配对 / 解除配对 / 主题切换），现在只剩主题切换。

- **解除配对 → 顶部主机卡**。那张卡写的就是"现在连的是哪台主机、通不通"，
  "不要这台了"是它的动作，沉在页面最底部没人找得到。卡内 chip：浅红底 + 红字，
  分割线隔开（破坏性动作但不当主角——这一页的主动作是新建会话，实心红会抢）。
- **重新配对 → 删除**。先解除再扫码就是重新配对，多一颗按钮只多一次误触。
  开机那条扫码路（hero 的「扫描主机二维码」）不动。
  client.js 里三处"请重新配对"的**状态文案**保留：那是会话真死了时的指引，
  不是入口。

判据改判一处：e2e/mp-pairing 的 wxml 护栏原来断言"已配对态也要能重新配对"，
现在断言按用户要求没有这颗入口、解除配对落在 `host-danger` 里。

顺带修掉两处自己的疏漏（都记在这里当教训）：
- 注释里写了「重新配对」四个字，被"页面里不许再有这个词"的护栏抓到——
  删除一个特性时，注释里的旧名字同样要清；
- 上轮 append 出来的重复 `.footer-row` 选择器（合并成一个，justify-content 并进去）。

闸门：mp check 32/32（对比度 284 组）、伞仓 143/0、run.mjs 17 步；
sessions-list 截图走渲染层验收（chip 在卡里、底部只剩主题切换）。
**用户侧**：公众平台选 mp 1.1.1 为体验版（1.1.0 的排队/附件同一次重启 Harness 生效）。

### 9.27 工作区 tag + 目录弱化 + 四级排序（2026-10-04 23:25，mp 1.1.2）

用户要的三件事，全在 sessions 页列表：

1. **工作区 tag**：标题行右侧一颗品牌浅底 chip，放目录最后一段。
   标题过长 chip 不动、标题先省略（flex:1+min-width:0）。
2. **目录弱化**：tag 给短名之后完整路径退成补充信息（20rpx + placeholder）。
3. **排序四级**：工作区 → 状态（运行中在前）→ 最后消息时间（新的在前）→ 名称。
   工作区打头的理由：人心里想的是"那个项目的会话"，先按状态排会把同一个
   项目的会话打散到屏幕两端。空目录排最后；名称兜底防跳位；
   排序用的原始时间戳 `sortAt` 不进 setData（渲染层不需要，两处口径会分叉）。

判据：mp-sessions-list 6 条（+3，旧 1 条改判：归档过滤后剩下的按运行中优先）。
同秒两个会话的 tie-break 用 A/B 结尾的标题——**不赌 collation 对中文的口径**
（实测 Node 无 zh locale 时 localeCompare 走码位序）。

踩到：chip 第一版字色用 `--td-text-color-brand`，深色表里是 brand-8（#4582e6），
压在 `--td-brand-color-light`（深色表里是 brand-1 深底 #1b2f51）上 3.56:1，
对比度体检不过。换成 `--td-brand-color-10`：两个 theme 各自的极值端
（浅底最深 #001a57 / 深底最亮 #96bbf8），两边都过。**品牌色 chip 在深色表里
不能想当然用 brand/on-tint——按对比度实测选端值。**

闸门：mp check 32/32（对比度 286 组）、伞仓 146/0、run.mjs 17 步；
sessions-list 截图验收。**用户侧**：选 mp 1.1.2 为体验版。

### 9.28 P2 收口 + 深色/P2 队列表九连（2026-10-05 01:30）

**发布状态**：wire 1.4.0（ev.todo）、control 2.0.2（待办上屏 + cwd 修复 + pill 文案）、
relay 1.0.4 **已部署生产**（healthz 报 1.0.4；重启断开过手机通道，用户重扫一次即可）、
mp 1.1.3 已上传（等用户在公众平台选为体验版）。19 条 Dependabot 全部 update-branch
转绿后合掉（协议 5 / 控制 6 / 中继 6 / mp 2）——它们的红**全是**分支旧导致
Multiple versions of pnpm specified（工作流里的 version 与 packageManager 打架），
update-branch 带进修好的工作流即绿，不是依赖本身的锅。控制仓 PR 4 有真实冲突，
解法：checkout PR 分支 + merge main + 重生成 lockfile + 推回分支。
TypeScript 7.0.2（Go 版）在四个仓都过了 typecheck。

P2 收口三条：④⑤ relay 空会话回收（30 分钟，最后一个客户端走才起表，
socket close 不起表——护 D3 免扫码）随 1.0.4 上生产；⑥ takeOverQuestions 死键
全清（control 16ff1df，伞仓 run.mjs 的传参残留本轮才清掉）；⑦ 19 条 Dependabot 见上。
⑧ 运维小尾巴仍未动：6 份含 hostToken 的 .bak 在 ~/.dsh/profiles/desktop/（删用户文件，
待用户点头），旧 npm token 与回滚路径按之前拍的板不动。

队列表九连，按提交：

1. **深色 chat 回复色块**（f449272）：steps-card 描边 + reply 用 secondarycontainer；
   markdown 的 codeBg/quoteBg 深色提到 #333/#262626（原 #242424 与卡同色=代码块隐身）。
2. **配对码 TTL 分叉**（536bc83）：发码回答取 service 权威 expiresAt + 本地过期守卫；
   回归先用**旧 dist** 跑红再重建跑绿。
3. **DSH 列表看不到 mp 新建的会话**（d90ddb6）：三重取证——create 不传 cwd 时宿主用
   process.cwd() 兜底，真机 lsof 一看就是 /，会话挂在不属于任何用户项目的目录。
   三级取值：配置 newSessionCwd > 最近一条会话的目录 > 退回旧行为（日志留痕）。
4. **深色 sessions 顶栏变白**（bcbffa6）：wx.setNavigationBarColor 每页实例一次性，
   从 chat 返回时微信用静态白盖回来；chat 页的 onShow 一直在重设所以它正常。
   sessions 的 onShow 补 theme.applyTo 即可（配对首页同一页，一起覆盖）。
5. **微信扫码直达**：调研后**用户说先不改**。结论存档——URL Link 是正解（支持
   env_version=trial、query 装得下整条 URI）；小程序码只能线上版本且 scene 32 字符
   装不下 server+PSK+token。要 appid+secret，一天工作量。
6. **进执行中会话看不到正在执行**（aa333c2）：ev.run_state 只在跳变时发，进入时唯一
   信号是 list_sessions 回执；_onSessions 翻牌时同步开实时组，历史第一页落地后补一次
   （空流不补的守卫在 ensureThinkOpen 里，幂等）。
7. **pill 文案口径**（55f68dd）：未配对改为远程未连接、已配对改为已连接、弹窗状态行改为已就绪；
   qrNote/待处理行去掉间隔号与书名号；二维码页加一行新人引导（drc-guide，短、不带符号，
   正则判据钉住不含括号书名号顿号冒号）。
8. **todo list 上屏**（协议 25c5e38 / 控制 6234ffe / mp b91b0fb）：ev.todo 全量快照帧
   + todo/write 映射（status 三元白名单 / content 不超过 200 / 整份不超过 50，空清单也发）
   + 聊天页顶部待办条（默认收起、点开、点消息区自动收回，排队在底部不打架）。
   渲染层三张真人截图（浅展开/收起+排队/深展开）。
   **v1 边界**：只上实时帧，不进历史回放（要扩 historyItem 联合）。
   wire 1.4.0 发布前控制仓用按协议本地构造帧顶着（注释写明换回时机），发版后已换回。

踩到并修掉的一处颜色问题（老规矩：品牌色在深色表里不能想当然）：
todo-running 用 --td-brand-color 在深色容器上 2.94:1（对比度体检抓的），
改主文字色，品牌色只留给非文字的状态点。

**用户侧还剩三步**：① 重启 Harness（吃 2.0.2：待办、cwd 修复、pill 新文案）；
② 公众平台把 mp 1.1.3 选为体验版；③ 手机重新扫一次码（relay 重启断开过通道）。

### 9.29 overall review + four-repo optimization (2026-10-05 01:55)

After the wrap-up I ran an overall review of the four repos; findings fall into two classes.

**Doc/config drift from code (all fixed)**:

1. the shipped cordis.patch.yml still carried the dead takeOverQuestions key (item 6 removed the schema but not the distributed copy);
2. the control README config table still said takeOverQuestions was not deleted yet and lacked uploadDir / maxImageBytes / newSessionCwd;
3. the relay README said healthz has eight fields; it returns twelve;
4. the relay SELF-HOSTING still said the frame limit is 256 KiB (1 MiB since 1.0.3), had no DRC_CONV_EMPTY_TTL_MS row, said the sweep does four things (five since 1.0.4), and had no empty-dropped log row;
5. the relay CHANGELOG kept the 1.0.2 counters entry in the unreleased section and was missing the 1.0.3 / 1.0.4 entries.

**todo in history replay (closes the v1 gap 9.28 recorded)**: wire 1.5.0 (historyItem widened to three leaf payloads) -> control 2.0.3 (historyWireItem no longer drops todo) -> mp 1.1.4 (_replayPage records the last snapshot of the page, _loadHistory applies it only on the first page, _todoLive lets live frames win). Three rules: the last snapshot in a page is that page-final list; older pages are stale and must not overwrite; a live frame that already arrived wins.

**Chain coverage added**: the mock default history gains a todo/write and run.mjs asserts the first page must carry that snapshot byte-for-byte over the wire -- previously the history-with-todo path was empty in the full chain, and unit tests framing their own payloads cannot catch a shape mismatch between what the plugin emits and the protocol schema.

Gates: protocol 88/0, plugin 346/0, mp check 32/32 + contrast 310, umbrella 160/0 + run.mjs 17 steps.
Released: wire 1.5.0 / control 2.0.3 / mp 1.1.4 (uploaded) -- **no relay code change** (docs only), production still runs 1.0.4.

#### 9.29.1 continuation: a half-open connection found in production -> host-side liveness probe (control 2.0.4)

A real problem found while re-verifying /healthz after the release: the relay restarted at 17:26 and the host reconnected fine (host online), then 28 minutes later the connection went half-open -- the relay has reported hosts:0 with no host since 17:54, while the Harness process still shows that TCP as ESTABLISHED and the plugin status.json says relay: online the whole time; nothing reconnects until process restart. On the phone it looks like paired but unreachable.

Cause: with a half-open socket no FIN/RST ever arrives locally, so close never fires. The relay has its own heartbeat (it pings the host, kills it after 2x60s); the host side of that pair was missing. Fix: the host asks a ping every 20s (an application frame pair the protocol already has; the relay answers unconditionally, no wire change) and terminates when no pong arrives within 10s -- only a forced teardown can coax a close event out of a half-open socket, which then walks the existing reconnect.

Judgment relay-client +3 (349/0). Released: control 2.0.4. The relay needs no change.

#### 9.29.2 用户报"二维码无法配对"——真因是主机反复半开掉线（2026-10-05 上午）

用户报"配对有问题，当前的二维码无法配对"。逐层查下来不是配对链路坏了：

- 中继日志：00:12:51 `host offline` → 00:16:58 `host online` → 00:27:01
  `host offline` → 00:27:52 `host online`。**主机每约 10 分钟半开掉线一次**，
  而 2.0.4 的探针没生效——跑着的还是旧 bundle（pill 状态 version 2.0.0）。
  用户此前的 3 次尝试（00:16:26/31/35）全落在主机离线窗口内，
  中继一律 `invalid_or_expired`。
- 复证：用脚本新签发的码在手机上配对，一次成功（clients 0→1→0、pending 被消耗）。
  所以"配对机制坏了"是错的，真因是**主机不在线**+**码过期无提示**。

改了两处（都是用户点了头的）：

1. **mp 1.1.5**：加号直接进相册，删掉单选项 action sheet「图片（从相册选）」——
   括号文本正是用户点名不要的，且这一代只有图片一种附件，中间那屏只多一次点击；
2. **control 2.0.5**：配对码剩余寿命常显在码上方（`X 分 Y 秒后过期`，最后 30 秒
   转重），倒计时在说这件事时 note 闭嘴；中继不在线时**一个发码请求都不打**，
   那一屏改成"主机还没连上中继 现在发不出配对码"+右上角刷新；面板开着时中继
   掉线，死的二维码在 2 秒节拍内当场换成这一屏。

判据：client-bundle +2（离线不发码 / 开着面板掉线当场换屏），plugin 351/0；
mp check 32/32 + 310；伞仓 160/0 + run.mjs 17 步。

**最要紧的一条**：要让 2.0.4/2.0.5 生效，用户必须重启 Harness——现在是旧 bundle
在跑，探针不在，主机还会继续每 10 分钟半开一次。这已当面告知。

#### 9.29.3 图片"读不出来"——`chooseMedia` 的字段名错了一个字母（2026-10-05 上午）

用户报"选图片都是提示这张图读不出来"，并质疑"为什么要读图片，压缩传过去才对"。

根因一句话：`wx.chooseMedia` 回来的是 **`tempFilePath`**，代码读的是 `f.path`——
那个字段从来不存在。于是 compressImage 的 src 是 undefined、失败回调里读的还是
同一个 undefined、readFile 再失败，每张图都走"读不出来"。**e2e 的假 wx 也照着
错代码写成 `path`**，所以 32 项单测一路绿——分叉的假实现比没有假实现更糟。

关于"为什么要读"：整条载荷是 JSON（之后还要 seal 成密文帧），二进制在 JSON 里
只有 base64 一条路，协议里的 imageAttachment 就是这么定的；主机那头也没有手机
上这个文件。所以流程只能是**压缩 → 读成 base64 → 上线**，读这一步省不掉，
能省掉的是"读错文件"。

mp 1.1.6（已上传）：

- 读 `f.tempFilePath`（压缩与失败回调都用它）；
- 假 wx 改得忠于真 API：给 `tempFilePath`，且 compressImage / readFile 在路径
  为空时**照真的那样失败**——那个错别字再也藏不住；
- 判据钉死字段名：compressImage 收到的 src 必须正是选中的文件。
  把源码改回 `f.path` 验证过，两条判据立刻红；
- **字节预算**：压完之后单张 300KB、一条消息合计 600KB，超了明说并跳过。
  理由是中继 `DRC_MAX_MSG_BYTES` 1MB 是硬帧上限——超了不是发不出去，
  是整条帧被掐、socket 1009 断开，用户看到的是莫名掉线。Android 上
  compressImage 的 quality 被系统忽略（见 IMAGE_QUALITY 注释），所以这道闸
  在 Android 上更容易触发，触发时说清楚，别让人以为选图坏了。

闸门：mp check 32/32 + 310 对比度、伞仓 160/0 + run.mjs 17 步。

#### 9.29.4 待办条与排队卡片重设计（2026-10-05 上午，用户："太丑了"）

两块的病根是同一个：**四种信息挤在一行、重量几乎相同**，且都摊在一条光秃的灰带上，
和这一页其余部分的视觉语言（轮次头、品牌气泡、卡片）完全不通。

**待办条**改成四层，从重到轻：

1. 分段进度格（一条一格：完成=实心、进行中=半格、待办=空心，超过 8 条出 7 格 +
   一个"还有更多"）。第一版格子是 18×8，截图里根本读不出"格子"只看见一条虚线，
   放大到 26×12 才对；
2. "在进行哪条"——正文级，主文字色 + medium；
3. 计数（待办 1/2）——次要、等宽数字；
4. 展开/收起 + 三角——最轻。

**排队**：条目从光溜横排改成**浮在灰带上的卡片**；品牌色序号圆点删了（它和右侧
"自己发的"实心品牌气泡撞色，而这只是次序不是消息）；删除按钮从字符 × 改成两根
斜杠画的 ×（字符 × 在真机上是一粒脏东西：基线、字号、颜色全跟着正文走，按下
去也没有反馈）。两块右侧统一成"文字 + 三角"同一种语言。

截图验过浅色与深色两套；对比度 308 组全过、mp check 32/32、伞仓 141 项 + 17 步。
注意：本次没加载任何 skill——当前技能目录里没有 UI/视觉设计相关的技能，
全部按本仓自己的设计纪律（td token、无字体图标、一行一事、渲染层截图验收）做。

#### 9.29.5 排队以 dsh 为准 + 图片链三连修（2026-10-05 下午，用户连报三条）

用户一次报了三件事："图片无法添加，提示未识别，为什么要识别，压缩发过去就行了"；
"图片不用显示出来，在加号上提示一下有几个附件就行了，目前内容比较多有点挤"；
"排队消息要以 dsh 为准……而不是各自维护，目前手机提交多个消息排队后，
第一条被消费后所有的排队消息都清空了"。

**1. 排队以 dsh 为准（根因：两个队列）**

取证：`agent.followup(message)` 的平台注释就是"Queue an ordinary follow-up turn
and wake the driver"——**队列本来就在主机那一侧**（docs/legacy-spec/
host-plugin-cordis.md §表第 6 行）。而手机原来在会话在跑时把消息扣在本地
`data.queue`，等空闲才发：两个队列。主机消化掉第一条之后，手机那份既不知道
也不跟着动——用户看到的就是"第一条被消费后我排的队全没了"。

改成：会话在跑也照样发；输入区上方那条从"手机自己的队列"变成**视图**——
回执说"收下了"才进来（`pending`），宿主回传这条消息时才出去（那一刻 dsh 真的
开始跑它）。主机没收下的那几条留在表上、带主机原话的原因、空闲时重发
（这条路以前是静默的：消息看着发出去了，其实哪儿都没到）。客户端新增
`sendPromptReceipt`（与 `newSession` 同一套 waiter 机制）。

**2. 图片三连修**

- 第一次报"读不出来"：`wx.chooseMedia` 给的是 `tempFilePath`，代码读 `f.path`——
  那个字段从来不存在。e2e 假 wx 照着错代码写，所以单测一路绿（1.1.6 已修）。
- 第二次报"无法添加"：1.1.6 我加的**单张 300KB 闸**把每张手机照片都挡在门外。
  而且 Android 上 `compressImage` 的 quality 被系统忽略，"压缩"在那边是假的。
  现在多一步**画布把长边钉死在 1600**（两个平台都算数，出来通常 100～350KB），
  另加 `downloadFile` 兜底读 `http://tmp/` 那种路径；闸放宽到单张 512KB /
  一条消息 512KB——这个数是从中继 1MB 硬帧上限倒推的（base64 胀 4/3 + 密文封装，
  超过约 540KB 就过不去，超了不是发不出去而是 socket 1009 莫名掉线）。
- "为什么要识别"：没有任何图片内容识别。存在的只有两件事：协议层
  `mediaType: 'image/jpeg'` 字面量，与主机侧的 JPEG 魔数检查（防止垃圾字节落盘）。
  画布重编码出来就是真 JPEG，这两道都不挡路。

**3. 图片不显示**

缩略图全删：输入区附件条、排队条目、会话里的用户回显，三处都改成"图片 N 张"一行字；
加号右上角一颗角报数。对比度白名单同步登记 `.user-images`（气泡里的白字）。

闸门：mp check 32/32 + 322 组、伞仓 145 项 + run.mjs 17 步。

#### 9.29.6 产品定位：离线是常态，不是故障（2026-10-05 下午用户拍板）

用户给定产品定位："临时远离电脑时的手机替代"，并据此要求"手机离线不要黄色，
不要给用户提供焦虑"。

按这个定位回头看，有两处 UI 在把常态画成故障：

1. **sessions 页连接态**：`error`（配对失败 / 会话失效）映射到 `danger`——红。
   红在这件产品里的语义是"你的东西坏了"，而这里要说的只是"现在没连上，
   点一下就能恢复"。降成中性灰 `default`，文案从"异常"改成"离线中"：
   **说状态，不评判状态**。
2. **会话卡上的"待审批 / 待回答"**：原来用 warning（黄/橙），是全页唯一的警示色。
   但那个状态的语义是"该你了"，不是"出错了"——改成品牌色。这一代整页
   没有 warning 了。

chat 页顶栏那颗点同理（`connTheme` 的 error 也曾经是红）。

**没动的**：环境缺能力那张红卡（`.warn`）保持红色——那一条是真的"这小程序用不了"，
                                                                     与连接态不是一回事。

判据：一条结构判据钉住 state → theme 的映射里不出现 warning / danger（含 chat 顶栏），
老判据"断开时说未连接而不是空闲"的颜色断言同步更新为 default。

闸门：mp check 32/32 + 322 组、伞仓 146 项 + run.mjs 17 步。

#### 9.29.7 屏幕上那张配对码不许是花掉的那张（2026-10-05 下午，control 2.0.6）

用户一次连报三条，三个表象：

> 手机离线太久后，就连不上了，然后 dsh 操作退出配对后，新的二维码也连不上，
> 要等下次刷新的二维码才能用，手机解除配对之后 dsh 又不同步状态了（之前修过一次）。

**根因：配对码是一次性的，而屏幕上那张从来没有人把它在该花掉的时候换掉。**

配对码的一次性由中继保证：`state.claim()` 里 `pending.used = true`，重放只拿到
`already_used`。而主机的 `active.pairing`——status.json 里那张、状态栏二维码那张、
`/pairing/new` 发的那张——原来只由 `markConsumed` 与 `wrappedPublish` 两处维护，
缺的就是"这一张现在不能用了"这件事本身：

- `unpairAll()` 只 `voidConversation`，**不动码**。于是退出配对后 pill 上还是刚走的
  那部手机花掉的那一张，手机扫上去中继回 `already_used`；
- `pairOnStartSec` 默认 **0**（自动发码关着，真机默认配置），所以 `PairingWindow.tick()`
  第一行就 return，没有任何东西去换它 —— 只能干等 TTL（线上中继 180 秒）走完。
  用户说的"要等下次刷新的二维码才能用"就是这个等待。

复发出来的取证（真中继 + 真插件 + 真小程序客户端）：

- 旧行为：退出配对后 `status.json.pairing` 恒为 null（花掉的码被勾掉后没有东西补位），
  要 3 秒节拍上的窗口补发才恢复，而默认配置下窗口根本不动；
- 修后：退出配对这一步自己就补一张，`untilAsync` 第一轮就拿到 `{qr, token}`，
  新手机一次扫通。把改动换回旧行为，判据当场红。

**修法**（control `index.ts`）：加一本"花名账" `spentTokens`，
`currentPairing()` / `describeActivePairing()` 见账上有的码一律当没有；
`onPeerJoined` 消费一张就记一笔；`unpairAll()` 把当前那张记账后**当场补发一张**
（`wrappedPublish()`，同时让窗口认领，不至于同一台主机挂两张有效码）。

**另外两个表象在取证里各自归位**：

- "手机离线太久连不上"：D3 续用路径（`clientGone` 不动成员表、空会话只由显式
  `session-leave` 打点）实测没问题，回来仍是同一条 convId 直接 online。它是上面那个
  二维码 bug 的下游——用户回来扫到的是死码，于是重扫。
- "手机解除配对后 dsh 又不同步状态"：pill 的 `paired` 读 `clientCount` 这条路是对的，
  实测手机 `unpair()` 之后 200ms 内 `paired` 就归零。这条没有复发，新增判据把它钉住。

判据：伞仓新增 `e2e/pairing-refresh.test.mjs` 三条（真链路）。已验证换回旧行为会红。
`bootHost` 增加 `pairOnStartSec` 入参（默认 0，与真机一致）——不提供这个开关，
配对窗口这一族用例根本没法写。

闸门：plugin 351/0、typecheck/format/build 全过；伞仓 168 项 + run.mjs 17 步。


## 9.29.8 文件附件（control 2.0.7 / wire 1.6.0 / mp 1.1.10）

用户 2026-10-05："文件附件也支持一下"（图片那条 1.1.7/1.1.9 已经做完，这条补文件）。
与图片共用同一条路：**存成文件 + 把路径写进 prompt 正文**。内核端口 sendPrompt
只收文本，这是宿主侧既有契约，改它要动内核适配器——不是这一代的事。

协议层（wire 1.6.0，向后兼容不升版本）：`cmdSendPrompt` 加 `files: z.array(fileAttachment)
.max(4).optional()`。与 `images` 的**三处差别**都写在头注里：没有 mediaType 白名单、
没有内容魔数校验、**不改扩展名**。第三差别是文件本身逼出来的——图片统一强写 .jpg
（画布重编码出来的就是 jpeg），文件改了扩展名 Agent 就不认它了。

主机层：`shell/uploads.ts` 加 `saveFileAttachments` / `appendFileNote`。
- 整批先验后写：被拒的批次一个字节都不留在磁盘上。
- 文件名走 `safeSegment`（手机传来的名字是不可信输入），同名加序号且序号插在扩展名
  **前面**（a.pdf → a-2.pdf；插末尾会变成 a.pdf-2，Agent 认不出）。
- `mode: 0o600`：附件不该给别人看。
- `maxFileBytes` 默认 512KB，与图片同一个数。

mp 层（1.1.10）：加号旁边多一个常驻小按钮「文件」。**不加进加号的二级菜单**——
那个菜单 1.1.5 刚按用户要求删掉（"加号直接进相册"），再加回来是翻烧饼；而一个
常驻的小按钮比藏起来的菜单好找。做成文字而不是图标：这一页的纪律是不引图标库
（真机缺字形），而「文件」两个字比任何自绘图标都清楚。
回显文案跟着从「已选 N 张」改成「已选 N 项」——现在可能是图也可能是文件。

**预算诚实**：中继单帧 1MB 是硬上限，超了不是"发不出去"而是整帧被掐、socket 1009
断开（用户看到的是莫名掉线）。文件没有压缩这一步（压完就打不开了），所以 512KB
就是一条消息能带走多少个文件的上界。超了明说该减哪一个，不静默丢。

踩过的坑：
1. `_readAsBase64` 原来把收口硬编码成 `_acceptImage`。加文件时它照样走那条路，
   于是拿到 SavedImage 的形状。改成按 `meta.kind` 分流——两类附件共用同一套
   读文件/落盘真机兜底（`http://tmp/` 那条路文件也用得上），但收口不同。
2. 假 wx 的 `chooseMedia` 曾写成 `path` 而不是 `tempFilePath`（1.1.6 的坑），这次
   重写夹具时照真 API 对齐了四个字段，并把图片那一链的四个能力都补全。

判据：protocol `send_prompt 的 files` 一条（含"图 + 文件同一条消息"）；plugin
`saveFileAttachments`/`appendFileNote` 三条（扩展名保留、超预算整批不落盘、
空正文可用）；伞仓 mp-chat-blocks 六条（文件落一条 / 与图片同发两个字段 /
超预算被挡下说清减哪个 / wxml 有文件入口与角标）。

闸门：protocol 89/0；plugin 355/0 + typecheck/format/build；mp 32/32；伞仓 150 项。

**仍需用户在网页里做的两步**（mp-upload 已经提示过）：
1) 公众平台 → 开发管理 → 开发设置 → 服务器域名 → socket 合法域名加 `wss://drc.provid.cc`
2) 版本管理 → 开发版本 → 选中 1.1.10 →「选为体验版」
另外 Harness 运行时的 bundle 还是 control 2.0.0，**要重启 Harness** 才会加载 2.0.7。



## 9.29.9 长按复制聊天信息（mp 1.1.11）

用户 2026-10-05："chat中的聊天信息要可以复制，steps不用"。

做法：在**两种气泡**上绑 bindlongpress，落到 wx.setClipboardData，
成功弹一个中性色 toast「已复制」。

三处决定（都写在代码注释里）：
1. 只给 user / text 两种块。步骤组故意不给 —— 用户明说 steps 不用，
   而且步骤组的价值在"它调了什么工具"，脱离会话复制出去没有意义。
2. 复制 item.text 原文。界面上回复那条是渲染后的 markdown，但复制的仍是
   模型产出的原文：用户要的是"这一条的内容"，不是一个被我猜过怎么排版的新版本。
3. 空文本不动作。只有附件的消息（item.text 为空）长按不会有反应，
   而不是把空串塞进剪贴板 —— 那会覆盖掉用户原本复制的东西。

绑在哪个节点上：回复气泡绑在最外层 .reply，不绑里面的 rich-text / text。
那有两支（mdBodies 有 / 没有），各绑一遍就是同一个动作两个地方管。

踩到的坑（值得记住）：
**`0 + String.fromCharCode(10)` 是 "0\n"（两个字符），不是换行。**
判据里想避开裸转义写成 0 + String.fromCharCode(10)，
结果 split 从没切开过，find 拿到整份 wxml，
于是"步骤组不许绑复制"这条断言在完整文件上判断 —— 必然红。
表现是判据失败但 debug 脚本同一个语义却过，非常难定位。
修法：直接 .split(String.fromCharCode(10))，别加 0 +。

顺带修掉：之前并行跑批把同一条判据 append 了两遍（该文件的 append 类改动
没有守卫），这次连重复的那份一起删了。

判据：伞仓 mp-chat-blocks 四条（用户消息原样进剪贴板 / 助手回复同样能复制 /
空文本不碰剪贴板 / wxml 只绑两处且步骤组不绑）。

闸门：mp 32/32；伞仓 156 项（150 → 156）；截图 13 张全过。



## 9.29.10 文件入口收回加号（mp 1.1.12）

用户 2026-10-05："文件要放在加号里面，弹出选图片还是文件"。

这条**改掉了 1.1.5 的决定**（"加号直接进相册、去掉 action sheet"）。
不是翻烧饼：当时删菜单是因为只有图片一种，多一次点击纯属浪费；
现在有图片和文件两种，**选哪个是用户的决定，不是我能替他定的**。

做法：加号弹**原生 wx.showActionSheet**（itemList: ['图片', '文件']），
选哪项走哪条老链。不自建面板的理由：两行代码、平台一致、
不用新样式也不引图标（这一页一个图标组件都没有）。

连带清理：
- 删掉 composer-file 那个常驻小按钮（wxml + wxss 的 .composer-file*）。
- onAttachFile 改名 _pickFiles，图片那半拆成 _pickImages；
  都不再由 wxml 绑，入口统一是加号里那一项。
- env.js 登记 showActionSheet（与 compressImage 同一种写法）。

满了怎么办：**不弹选择**，直接 toast 说满。
理由：满了还让人选一次图/文件是浪费一次点击，但满这件事必须说清，
不然用户会以为加号坏了。

踩到的坑（两个，都不在功能本身）：
1. **mp 的 package.json 版本号从 1.1.9 起就没动过** —— 之前的 bump 脚本
   无条件 print 成功信息，但 replace 从没匹配上。上传用的是 --version 参数，
   所以三个版本都发出去了，只有源里的字段是旧的。这次用正则抓字段，
   不猜旧值。已改成 1.1.12。
2. **假 wx 的 __drcSheetTap 跨用例泄漏**：上一条用例选了"文件"，
   下一条点加号也会进文件链，两条都莫名失败。修在 makePage() 里归零 ——
   这种"用户这次点了第几项"的状态必须在每条用例开头重置。

判据：伞仓 mp-chat-blocks 新增四条（选择就两项且图片在前 / 加号->文件落成
file 附件 / 加号->图片落成 image / 满了不弹选择）+ 改写原有的 wxml 判据
（从"旁边那个小按钮管文件"改成"加号一个入口管两样、不许有第二个按钮"）。

闸门：mp 32/32；伞仓 160 项（156 到 160）；截图 15 张全过，
chat-composer 已人工看过：+ / 输入指令... / 发送，输入框不挤了。



## 9.29.11 Queue two-way sync + real delete (wire 1.7.0 / control / mp 1.1.13)

User 2026-10-05: queued messages were not two-way synced, and mp must support delete.

-- Why the architecture had to change ------------------------------------
Old behaviour: cmd.send_prompt forwarded straight to agent.followup(), leaving no
trace on the host. So queueing was only an optimistic list on the phone - it never
knew what the host forwarded, how many were left, or which had failed to go out.
That is exactly the missing two-way sync.

And followup() returns no handle, nor does the host expose any inbox removal
(evidence this round: only followup / steer / cancel exist). Once a message is out,
it can never be recalled.

Conclusion: only messages still held by the host can be deleted. The host must own
the queue: enqueue on arrival, hold while the turn runs, forward when idle.

-- Protocol (wire 1.7.0) --------------------------------------------------
- cmd.send_prompt gains optional queueId (the phone mints it: host-side minting
  would need an extra mapping, and the phone already uses it as list key). Old
  phones omit it and keep the old behaviour, with no delete path.
- New cmd.drop_queued { queueId }.
- New ev.queue { sessionId, items[] }: full snapshot, pushed on every change.
  Item states: held (host holds it, deletable) / sent (forwarded, not deletable) /
  failed (never went out, deletable, carries message).

-- Host (shell/queue.ts + runtime) --------------------------------------
- PromptQueue: enqueue dedupes by queueId; takeHeld takes only un-forwarded;
  retireSent runs when run-state turns idle (retire those now in the message flow).
- cmd.send_prompt now enqueues and replies with data.queued instead of forwarding.
- cmd.drop_queued: only held can be dropped; sent replies ok:false saying it is
  already running; failed is dropped as a bonus. Never a fake success.
- drainQueue fires on run-state idle, forwarding the batch in order.

-- Phone (chat.js / wxml / client.js) -----------------------------------
- pending becomes a mirror of the host snapshot: _onQueue replaces wholesale, no
  local add/remove. Local mutation creates ghosts the host never had.
- Delete button only for state !== sent: held asks the host, failed deletes locally,
  sent gets no button at all (a dead button is worse than none).
- client.dropQueued() is its own method: delete failure differs from send failure
  (the former may mean already running), so they must be worded separately.
- Attachment-only rows now say Attachments N (counting both images and files).

-- Three traps hit (none in the feature itself) --------------------------
1. 0 + String.fromCharCode(10) is the two-character string 0-newline. A judgement
   written that way never split, so find returned the whole file and the assertion
   always failed - while a standalone debug of the same logic passed. The two sides
   differed by an entire file, making it very hard to locate. Drop the 0 +.
2. drainQueue is void-ed, so a kernel exception became an unhandled rejection and
   that item stayed sent forever: the phone showed running while nothing happened,
   with no path to recover. Added try/catch + markFailed and released busy (else
   the whole table locks after an exception). Judgement 283 was rewritten to the
   new contract: enqueueing always yields a receipt, failure lands on ev.queue
   attached to that specific item.
3. drainQueue must not retireSent: doing it there makes sent invisible for even a
   frame, so a just-sent message vanishes. Retirement belongs to run-state idle.

-- Still open (awaiting your call) --------------------------------------
- wire 1.7.0 is NOT on npm: npm whoami returns 401, the token expired. Protocol
  source, tag and judgements are all in (92/92); control temporarily points at the
  local protocol repo via file:. Once the token is renewed: npm publish, then set
  plugin package.json back to ^1.7.0, pnpm install, rerun all control gates, ship
  2.0.7.
- The queue bar has no position-in-host-queue: the agent inbox is a black box.
  The UI therefore says Awaiting host, N messages and never invents a position.

Judgements: protocol 3 (send_prompt queueId / cmd.drop_queued / ev.queue snapshot);
control runtime 283 rewritten + 355/355; umbrella mp-chat-blocks 7 (snapshot replaces
wholesale, cross-session ignore, delete behaviour per state, wxml button condition).

Gates: protocol 92/92; plugin 355/355 + typecheck/format/build; mp 32/32; umbrella
167. 15 screenshots pass; chat-todo-queue reviewed by eye: the held row has an x,
the sent row has none.

