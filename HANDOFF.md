# HANDOFF — dsh-remote-control

> 交接给下一位开发 agent。**先读本文，再读代码。**
> 重写于 2026-10-03（上一版内容太长已整体替换；旧文在 git 历史里，`git show d058d8f:HANDOFF.md`
> 能取回，**没有丢**——包括那些一次性取证细节）。

## 0. 一句话状态

产品已经开源成 **GitHub 上四个独立仓**（账号 `providcc`，MIT），两个 npm 包已发布，四仓 CI 全绿。
**伞仓已经不再持有源码副本**：`apps/server`、`packages/{protocol,plugin,presentation}`、`mp`
五棵树已删除（提交 `f5a6853`），代码的唯一事实源就是那四个开源仓目录。伞仓只剩下
**不开源的取证与运维资产**：`e2e/`、`scripts/`、`docs/`、`deploy/`。

生产中继跑的是**开源仓已发布的 v1.0.1 产物**：先 `shasum -c SHA256SUMS` 校验再从 Release 下载，
scp 上线后 `/healthz` 报 `version:"1.0.1"`，重启后 5 秒内 `hosts` 回到 1（线上宿主插件自动重连
到新中继）——"能换"是这么证的，不是猜的。私有那套 2.x 编号作废，以后只有开源的号。
**本轮（2026-10-03 上午）又往前走了一步**：右栏那一半折进主插件并发出 `dsh-remote-control@1.1.0`，
真宿主装的就是这个版本，`live-e2e --rounds 2` 36 项全过、那条同域路由在真机上取证成功（§9）。
线上"已发布的产物"与"在跑的字节"是同一个（sha256 两侧实测相同）。

> ✅ **e2e 已跑绿**（2026-10-03 本轮）：`node --test e2e/*.test.mjs` = **113 pass / 0 fail**，
> `node e2e/run.mjs` = **17 步 0 失败**，`node scripts/validate-qr.mjs` = 28 组 ×2 产物 0 失败。
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
| 生产宿主插件 | **`1.1.0`** | `dsh-remote-control/`（折并后单一 bundle） | ✅ 已装进 `~/.dsh/profiles/desktop`，退役的 `dsh-remote-control-presentation` 目录与 bundles 条目都已摘掉；live-e2e 真机 36/36 过（见 §9） |
| 协议 / 小程序 | 开源 `dsh-remote-wire@1.0.0` / mp `aac0f60` | 私有树那两份在飞改动已移植并各自跑绿 | ✅ 私有树删除后唯一事实源就是开源仓；**别再引用 `packages/*`、`apps/server`、`mp/` 这些伞仓旧路径** |

## 1. 四个开源仓（这是要长期留存的东西）

| 仓 | 内容 | npm 包 | HEAD（本次） | Release | CI |
|---|---|---|---|---|---|
| `dsh-remote-protocol/` | 线协议纯函数库 | **`dsh-remote-wire@1.0.0`** | `c02f590` | `v1.0.0` | 绿 |
| `dsh-remote-server/` | 零知识中继（单文件产物） | 不发 | `28f76db` | **`v1.0.1`**（挂 `dsh-remote-relay.mjs` + `SHA256SUMS`；线上跑的就是这份字节，见 §0） | 绿 |
| `dsh-remote-control/` | 宿主插件（**只剩 `packages/plugin` 一个包**） | **`dsh-remote-control@1.1.0`** | `c6bdc98` | **`v1.1.0`** | 绿 |
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
   `src/presentation/pill.ts` 的软探测提供，`tests/presentation-isolation.test.ts` 逐字段对照钉住。
   ⚠️ **那一半的内容已经换了**：1.1.0 是"右栏自动弹码"，`[未发布]`（1.2.0）把它与终端文本码
   一起删掉，换成状态栏那颗 pill——**配对入口只剩 pill，`/drc pair` 已不存在**。
   §9.1 里那些 `sidebar.*` / `/pairing?session=` 的取证是**当时**的事实，别当成现状。
3. **协议是 npm 依赖（`^1.0.0`），不是 git 依赖**。别退回 git 依赖：pnpm 11.7 下 git 包的
   `prepare` 只认含 commit 的精确 `allowBuilds` 键，四种宽松写法全被拒，每次升版都要手改两个消费仓。

**fork 要改的东西**：`dsh-remote-mp/project.config.json` 里的 `appid` 是本项目自用的（仓内 README
第 60-61 行已写明），别人跑自己的必须换成自己的 appid，真机还要在微信后台配 socket 合法域名。

**怎么发一个新版**（`dsh-remote-wire` / `dsh-remote-control`）：改 `package.json` 版本 → 提交 →
推 main → 打 `v<版本>` 并推标签 → Release 工作流自己跑校验、发 npm、建 GitHub Release。
标签与包版本不一致工作流会主动失败。中继仓打标签只会产出 Release + 产物附件，不发 npm。
**两个发包仓的 Release 工作流末尾多了一步 `Verify provenance landed`**：npm 侧那条
Trusted Publishing 没配好，发布就会红在那里（而不是"绿但没 attestation"）——见 §3 第 1 条。

## 2. 伞仓里剩下的东西（都不开源，也都不再持有源码副本）

五棵源码树已删除。下面这些是**伞仓独有、开源仓没有**的，别跟着一起删：

| 路径 | 为什么留着 |
|---|---|
| `e2e/` | 全部取证资产：逐字节对拍、本地全链路、生命周期、live-e2e。**开源仓里没有等价物** |
| `scripts/` | `validate-qr.mjs`（改二维码必跑）、`mp-*.mjs` 等 |
| `docs/DESIGN.md`、`docs/DESIGN-REVIEW.md` | 契约表 B1-B9 / F1-F13 / T1-T8、偏离 D1-D9、复核结论。开源仓的 `docs/` 是它们的**换算过名字的历史副本** |
| `docs/HOST-SIDE.md` | **本机宿主侧**手册：profile 安装语义、配置键全表（含 `sidebarQr`）、`status.json` 字段与本机实测值、右栏路由的 curl 取证配方、live-e2e 的配对码前置与"改配置要成对还原"。中继侧部署**不在这份里**，权威是 `dsh-remote-server/docs/SELF-HOSTING.md`——伞仓原来那份同名副本（还写着 `apps/server`/`@dsh-rc/*`/`2.0.0`）已删，别再复制回来 |
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

1. **npm provenance 还是没挂上**（本轮 `dsh-remote-control@1.1.0` 再次证实）。发布日志里的原话：
   `[WARN] Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE: Failed token exchange request with body
   message: Unknown error (status code 404)` → 回落到 `NODE_AUTH_TOKEN` 发的，
   于是 `/-/npm/v1/attestations/dsh-remote-control@1.1.0` 仍返回 `{"error":"Not found"}`。
   **别在文档里宣称带 provenance。**
   为什么本轮没顺手修：Trusted Publishing 只能在 **npm 网页 UI** 上配（npm CLI 10.9.9 没有对应命令，
   也没有可信的公开 API 路径），而那需要用户在浏览器里登录 npmjs.com——本轮用户拍板
   「先用现有 NPM_TOKEN 发 1.1.0，TP 留给下一版」。
   **下一次要做的事**（权威口径来自 npm 12 自带的 `npm-trust` 文档，不是网页猜的）：
   CLI 就能配，不必用网页——但要**一次交互式 2FA 授权**。两条实测事实决定了它只能由人做一次：
   - 用户在终端里 `npm login`（npm **10.9.9** 跑的）之后，`npm whoami` / `npm profile get` 都通过，
     账号 `tfa.mode = auth-and-writes`；但 trust 端点**连只读的 `npm trust list` 都返回 `EOTP`**
     并要求打开 `https://www.npmjs.com/auth/cli/<id>`。文档那句"带 bypass 2FA 的 Granular/Automation
     token 不支持 trust"就是这个现象的来源——**10.9.9 写进 `~/.npmrc` 的那把不满足要求**。
   - 所以别把 `trust list` 当确认手段：它自己也卡在授权上，返回 `EOTP` **不等于**"没配上"。
     真正的确认只有两条：要么在**能完成浏览器授权**的那个终端里跑一次 `npm trust list <pkg>`，
     要么直接用发布路径去撞（我们已经撞过了，见下面第 3 点）。
   可行的两条修法：**(a)** `npx -y npm@12.2.0 login`（会写一把 npm 12 认的会话凭据，
   跑之前先备份 `~/.npmrc`，它会被覆盖）之后再 `npx -y npm@12.2.0 trust github …`；
   **(b)** 直接给 trust 带 `--otp=<6位>`（口令码 30s 一换，得现拿现用）。npm 需 ≥ 11.15.0，
   本机是 10.9.9，所以一律走 `npx -y npm@12.2.0`。两包各一条：
   ```sh
   npm trust github dsh-remote-control --repo providcc/dsh-remote-control --file release.yml --allow-publish
   npm trust github dsh-remote-wire   --repo providcc/dsh-remote-protocol  --file release.yml --allow-publish
   ```
   ⚠️ **协议包必须显式写 `--repo`**：仓名是 `dsh-remote-protocol` 而包名是 `dsh-remote-wire`，
   不写就会拿 `package.json` 的 `repository.url` 去推断——那条指的就是包名对不上的仓。
   GitHub 的 claim 只有 `repository` + `workflow file`（+ 可选 `environment`），
   **没有 tag/分支 pattern 这种东西**（原文里"tag pattern 建议留空"是我说错了）。
   **已经做完的两件事**（不需要 npm 侧权限，所以先落了）：
   - 两仓 Release 工作流的 Publish 步骤**删掉了 `NODE_AUTH_TOKEN`**（control `ce8e0bf`、protocol `b11b23c`）。
     token 在场就会掩盖 OIDC 失败；没了它，TP 没配好时发布会**直接红**，而不是发一个没证明的版本。
   - 两仓各加一步 `Verify provenance landed`：发布后最多轮询 60s 查 attestations 接口，
     查不到就红，并把该跑的 `npm trust` 命令原样印在报错里。
     **判据永远是那个接口，不是工作流的绿。**
   - 协议仓版本抬到 `1.0.1`（`13d40df`，**没有代码变更**，唯一目的是当第一个带 provenance 的发布），
     并且**已经用发布路径本身撞过一次，得到决定性结论**：标签 `v1.0.1` 推上去后，Release 运行
     `37101490457` **红在 `Publish to npm`**，日志还是那行 404 ⇒ **npm 侧那条 trust 配置确实不存在**。
     同时 `npm view dsh-remote-wire versions` 仍是 `["1.0.0"]` —— **没有半发布**：Publish 是唯一的
     网络写步骤，它一失败就不会往下建 GitHub Release。这就是删掉 token 换来的行为差异
     （以前是"绿着发出一个没证明的版本"，现在是"响亮地失败、什么也没发"）。
     **标签保留没删**：TP 配好之后不用重打标签，直接
     `gh run rerun 37101490457 --repo providcc/dsh-remote-protocol --failed` 即可。
   - **剩下唯一需要人的一步**：在能完成浏览器 2FA 授权的终端里把两包各配一条
   （命令与凭据要求见上面 (a)/(b)）：
   ```sh
   npx -y npm@12.2.0 trust github dsh-remote-wire    --repo providcc/dsh-remote-protocol --file release.yml --allow-publish
   npx -y npm@12.2.0 trust github dsh-remote-control --repo providcc/dsh-remote-control  --file release.yml --allow-publish
   ```
   命令必须有**真 TTY**（`script -q /dev/null npx …` 这种伪装能拿到授权 URL，但点批准还是要人），
   两条之间有 5 分钟的 2FA 宽限窗口（npm 文档写明），所以连着跑第二条不再问一次。
   ⚠️ **每个包同时只能有一条 trust 配置**，要改先 `npm trust list <pkg>` 拿 id、
   `npm trust revoke --id <id> <pkg>`，再建新的。
   ⚠️ 已发布出去的版本（`wire@1.0.0`、`control@1.0.0/1.1.0`）**永远补不上 attestation**，
   这是 npm 侧的既定行为，别指望"回头再签一次"。
   配好之后**不用重打标签**（`v1.0.1` 还在）：
   `gh run rerun 37101490457 --repo providcc/dsh-remote-protocol --failed`
   → `gh run watch` 看最后一步必须打出 `provenance 已挂上：dsh-remote-wire@1.0.1`，
   再用 `curl -s https://registry.npmjs.org/-/npm/v1/attestations/dsh-remote-wire@1.0.1` 复核。
   control 不必空发一版，等下一次真改动搭同一条链路（自检会替我们确认那时真的挂上了）。
2. **用户应在 npm 站点 revoke 一把旧 token**（`bypass_2fa:false` 那把，曾在对话里贴出来过）。
   它能登录但没有发包权限，仍然是有效凭据。可用的那把在 `~/.provid/env-v3` 的
   `DSH_REMOTE_NPM_TOKEN`（**值绝不写进仓库/文档/测试**），两仓 secret 已经是它。
   本轮用户明确"token 安全问题先不管"，所以这条仍未做——它不是我做完了忘了，是被搁置的。
   **另**：npm 站点顶部横幅（2026-10-03 实测）写着 bypass-2FA token 将在
   2026-08 起限制账号变更、**2027-01 起禁止直接发包**——这把 token 的可用期是有终点的，
   Trusted Publishing 不是可选项而是必经路。
3. **`droppedFrames` 查不到历史，因为中继压根不为丢帧写日志**（本轮把这条查清了，推翻了原来的说法）。
   原文写的是"去服务器 `journalctl | grep -c "frame dropped"`"——**那个 msg 串在代码里不存在**
   （全仓 grep `frame dropped` 为空）。四处计数点
   `dsh-remote-server/src/server.ts:341/360/377/387` 都只 `counters.droppedFrames += 1`，
   其中两处注释就写明"它在日志里不留痕，只能靠这个计数被发现"。
   所以：**journalctl 查不到，/healthz 只在当前进程内有值**，想要历史必须自己落计数快照。
   本轮实测：线上 `version:1.0.1`、`droppedFrames:56`（uptime 6294s），空载 30 秒不涨
   （56 → 56），也就是说丢帧集中在**活动窗口**而不是稳态。
4. **新发现（值得拍板）：生产宿主没配 `hostId`，每加载一次就换一个身份。**
   `packages/plugin/src/index.ts:244` 是 `hostId: config.hostId || 'h_' + randomBytes(3)`，
   而 profile 的 `dsh-remote-control` 那条 config 里**没有 hostId**（默认 `''`）。
   实测线上 5 分钟内出现三个 hostId：`h_c2073b`(10:05:04) → `h_051405`(10:05:29) →
   `h_0919dc`(10:09:40)，中继日志里每一次都是 `host online … replaced:0`
   （**换了身份所以顶不了号**，旧 socket 只能等宽限/清扫）。
   这与 3 里那些丢帧是同一个形状：手机连的会话对应的宿主身份已经换人了，
   中继往"没有钥匙的对端"推 → 计数 +1。
   **一条修复就是给 profile 的 patch 写死 `hostId: drc-bins-macbook`**（配置改动，不是代码改动；
   要不要改由用户拍板，改了以后宿主重启/重载都能顶号而不是新建身份）。
5. **Dependabot 已逐个审过，判定写在 §9.2**（四仓共 19 个开放 PR）。
   一句话结论：红色的多数是**分支基线陈旧**（旧 `ci.yml` 里 pnpm 还写 `version:`、node20 直绑工具链），
   不是依赖不兼容；唯一真实的不兼容是 **typescript 7**：协议仓的 `tsc` 不再自动纳入 `@types/node`
   （`Cannot find name 'TextEncoder'` 一类），加一行 `"types": ["node"]` 就修好，且对 TS 5.9 中性。
   **本轮没有合任何一个**（用户只要证据清单）。
6. **真机取证还欠两条**：审批卡与提问卡。原因都是**本机部署配置/宿主版本**而非代码——
    审批策略全量是 `never`（用户已表态先不改，**别再问第二遍**），
    这一代宿主的 `ctx.userQuestions` 不带 `registerProvider`。两条都有本地闭环测试。
7. **「点一下配对」那颗 pill 要在真屏幕上验一次，然后才谈发版**（细节与做法见 §9.4）。
    顺序是有意的：先配好 §3 第 1 条的 Trusted Publishing，再发 `1.2.0`——
    用 token 发就又是一版"没有 attestation 且永远补不上"的包。
    ⚠️ 验 pill 要重启用户本机那个 DeepSeek Harness（它是用户正在用的应用），**动手前问一句**。

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
    现在两侧假 ctx 都能演晚到：`presentation-isolation.test.ts` 的 `lateWeb`/`flushInject`，
    `presentation-client-bundle.test.ts` 的 `lateSlots`/`flushInject` + `ctx.slots` 那个 getter。

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
env -u NODE_OPTIONS node scripts/validate-qr.mjs          # 动过二维码必跑（28 组 ×3 产物）
gh pr list --repo providcc/dsh-remote-server --state open # Dependabot 积压
```

## 9. 本轮已定与剩余（2026-10-03 深夜收口）

**已做完并有证据的：**

| 事 | 证据 |
|---|---|
| 中继版本尾巴收掉：发 `v1.0.1`，并把**已发布的产物**部署上线 | Release v1.0.1 带 `dsh-remote-relay.mjs` + `SHA256SUMS`；`shasum -c` OK 后才 scp；线上 `/healthz` 报 `version:"1.0.1"`、`hosts:1`（重启后主机自动重连成功） |
| 插件的"假事实"bug 移植进开源仓 | control `5bd4227`，224 项全绿，CI success |
| mp 的在飞改动移植进开源仓 | mp `aac0f60`：`npm run check` 三道闸全过（verify / theme:check / contrast 242 组达标），私有标识符扫描为空 |
| **e2e 跑绿**（§0 那条警告已消） | 伞仓 `cb5297f`：`pnpm -r test` = 112 pass / 0 fail + 全链路 16 步 0 失败；`validate-qr` 28 组 ×3 产物 0 失败。顺带抓到并修掉"帧抓取只装了一份 `ws`"那条装置级缺陷（§4 第 10 条） |
| **presentation 折进主插件，control 仓只剩 `packages/plugin`** | control `a3025a3`（`feat!`，版本 `1.1.0`）：`pnpm typecheck && pnpm -r test` = **280 pass / 0 fail**，`format:check` 过；隔离由 `src/presentation/sidebar.ts` 软探测 + `tests/presentation-isolation.test.ts` 逐字段对照提供（没有 webServer / 正常 / `register()` 抛错三种形态都覆盖）；`install-to-profile.sh` 改成一个 bundle 并退役旧条目；CI 产物校验点名 `client.cjs` |

**同一轮做完并有真机证据的（2026-10-03 上午）：**

| 事 | 证据 |
|---|---|
| `dsh-remote-control@1.1.0` 发出去了 | 标签 `v1.1.0` → Release 工作流 success → `npm view dsh-remote-control versions` = `[1.0.0, 1.1.0]`；`npm pack` 解包核对：tarball 只有 `dist/bundle/{index.js,client.cjs}` + `cordis.patch.yml` + `LICENSE`，232 KB；**provenance 没挂上**（§3 第 1 条附日志原文） |
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

1. **Trusted Publishing**（§3 第 1 条）：卡在"要用户在浏览器登录 npmjs.com"这一步，本轮按拍板留到下一版。
2. **`hostId` 那条配置**（§3 第 4 条）：一行 patch 就能让宿主身份稳定，但那是改用户线上配置，等他点头。
3. **审批卡 / 提问卡的真机取证**（§3 第 6 条）：原因仍是本机 `approval/policy: never` 与这一代宿主没有
   `registerProvider`，**别再问第二遍**；两条都有本地闭环测试。
4. **`dsh-remote-mp` 不打 Release**（用户 2026-10-03 定："只是象征性的开源"），原来的"要不要打 v1.0.0"这条待办作废。

### 9.4 「点一下配对」落地（2026-10-03，control 仓 `[未发布]`）

用户两条拍板：`/drc pair` **去掉**，改成点状态栏那颗 pill；二维码**放在弹出窗里**；
但"仅 pill 不可用时才把 `pair` 注册回来"这个兵分要保留。做成了：

| 事 | 证据 |
|---|---|
| 宿主侧多三条路由 | control `packages/plugin/src/presentation/pair-actions.ts`：`POST /pairing/new`（幂等；跨站判据是同源才发得出的 `x-drc-pair` 头，**不是** `Origin`）、`GET /pairing.png`（现渲染、`no-store` + `ETag`）、`GET /status`（`relay`/`paired`/`hasCode`）。测试 **319 pass / 0 fail**：`presentation-pair-actions.test.ts` 22 条（含"回答里不许出现 `psk`/完整 URI"这条红线、注销一条抛错仍摘掉其余）、`presentation-isolation.test.ts` 的"兵分/接线/只挂上右栏那条"三条、`presentation-client-bundle.test.ts` 那 13 条 pill 用例 |
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

### 9.5 收敛成"只有 pill"（2026-10-03，control `[未发布]` = 1.2.0）

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
而没有任何地方说为什么"。`tests/presentation-isolation.test.ts` 五种形态各钉一条。
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
判据是 `presentation-pill-routes.test.ts` 的"第二条挂不上时第一条必须被回滚掉"。

**e2e 补上了此前那条空白**（§9.4 说过"e2e 没覆盖那三条新路由"）：`e2e/run.mjs` 现在给假
`webServer`，在**真中继在线**时点那三条——发码、幂等复点同一张、PNG 的 `ETag` 与主机维护的
那张码的 URI 哈希同一个口径。此前单测里的发码分支永远是"中继不可达"，那条路从没走过。
闸门：control **261 项全绿**、e2e **17 步 0 失败**、`node --test e2e/*.test.mjs` 113 全绿、
`validate-qr` 28 组 ×2 产物 0 失败、**真屏幕复验通过**（上面那段）。

**还欠着的：**

1. **没发版**。`[未发布]` 那节在 CHANGELOG 里，版本仍是 `1.1.0`。发 `1.2.0` 是 npm 上不可逆的动作，
   而且 §3 第 1 条的 Trusted Publishing 还没配——用户 2026-10-03 已拍板"先配 TP 再发"。
2. **本机 profile 跑的是未发布的 HEAD 产物**，不是 npm 上的 1.1.0（§9.4 那轮装进去的字节
   已经被 §9.5 这轮的删除改掉，所以别再引用旧哈希——要现值就 `shasum -a 256` 比
   `~/.dsh/profiles/desktop/node_modules/dsh-remote-control/{index.js,client.cjs}` 与
   `packages/plugin/dist/bundle/`）。要么发版把它转正，要么还原成 1.1.0：
   `/tmp/drc-profile-backup/dsh-remote-control-1.1.0`（**/tmp 重启就没**，届时改用
   `npm pack dsh-remote-control@1.1.0` 解出来的产物覆盖回去），两条路都要再重启一次宿主才算数。

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

闸门（清理后全绿）：protocol **80**、server **78（1 skip）**、control **262**、伞仓 e2e **17 步 0 失败**、
`node --test e2e/*.test.mjs` **113**、`validate-qr` 28 ×2、四仓 `format:check` 与 `noUnusedLocals`/`noUnusedParameters` 干净。
