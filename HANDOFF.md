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

> ⚠️ **接手第一件事：把 e2e 跑绿。** 这轮只做了"把引用改指开源仓"（22 个文件），
> **没有做"跑绿"**。协议层的分组重构（`frames`→`wire/`、`keys`→`crypto/`、`ids`→`identity/`）、
> 插件产物位置、mp 的目录层级都变了，而且这批文件正被并行会话同时编辑（见 §4 第 9 条）。
> **在 `node e2e/run.mjs` 与 `node --test e2e/*.test.mjs` 重新跑绿之前，任何 e2e 结论都别引用。**

### 0.1 还没合完的部分（下一步就按这个清单做）

| 待办 | 现状 |
|---|---|
| ~~移植 `packages/plugin` 的在飞改动~~ | ✅ **已移植**（开源 control 仓 `5bd4227`：宿主注入的 `user/message` 不再冒充用户指令 + 留痕计数，3 条新测试，224 项全绿） |
| 移植 `mp/` 与 `packages/presentation` 的在飞改动 | presentation 与开源仓只差结构（import 名），未见未提交改动；**mp/ 那份还没搬**（app.wxss / core/client.js / chat / sessions / theme，并行会话在飞） |
| 删除伞仓五棵私有树 | ✅ **已删**（提交 f5a6853）；同轮把 e2e/scripts 的 22 个文件改指开源仓，残留私有路径引用 0 |
| 重接 `e2e/`、`scripts/` 到开源仓路径 | 已改的文件：`e2e/{run.mjs,restart-resume.test.mjs,mp-crypto.test.mjs,protocol.test.mjs,mp-client.test.mjs,multi-pair.test.mjs,package.json}`、`scripts/{bundle-plugin.mjs,bundle-presentation.mjs,bundle-relay.mjs,relay-start.sh,validate-qr.mjs,install-to-profile.sh,mp-shots.mjs,check-mp-ui.mjs,mp-probe.mjs}`。包名与目录结构都变了（`@dsh-rc/protocol/*` → `dsh-remote-wire`；协议层从扁平改成 `crypto/`、`identity/` 等分组） | **但没跑绿**——这是接手第一件事，见 §0 的警告框
| ⚠️ 协作冲突 | `e2e/run.mjs`、`e2e/package.json`、`e2e/mp-*.test.mjs` **正被并行会话编辑**。改这批文件前先确认它停了，否则两边互相覆盖 |

并行会话的在飞改动**已整份备份**到 `~/.provid/backups/dsh-umbrella-inflight-20261003.patch`（600，
含未跟踪的新测试文件），生产旧产物也在服务器上留了 `relay.mjs.bak-20261003-075757` 可回滚。

### 0.2 其余三棵树的关系（仍要注意"改哪边"）

| | 版本 | 从哪来 | 现状 |
|---|---|---|---|
| 生产中继 | **`1.0.0`** | `dsh-remote-server/`（开源仓） | ✅ 已合并成一条线 |
| 宿主插件 / 协议 | 开源 `1.0.0` | 开源拷贝**不是**私有树的快照：它同时做了重构（包名 `@dsh-rc/protocol/*` → `dsh-remote-wire`、协议层目录分组）。私有树最后提交都在 2026-10-02，其上的未提交改动已把插件那个假事实 bug 移植进开源仓（`5bd4227`）；**mp/ 那份在飞改动仍未移植** | 见 §0.1 |

## 1. 四个开源仓（这是要长期留存的东西）

| 仓 | 内容 | npm 包 | HEAD（本次） | Release | CI |
|---|---|---|---|---|---|
| `dsh-remote-protocol/` | 线协议纯函数库 | **`dsh-remote-wire@1.0.0`** | `c02f590` | `v1.0.0` | 绿 |
| `dsh-remote-server/` | 零知识中继（单文件产物） | 不发 | `d421206` | `v1.0.0`（**挂 `dsh-remote-relay.mjs` + `SHA256SUMS`**） | 绿 |
| `dsh-remote-control/` | 宿主插件 monorepo | **`dsh-remote-control@1.0.0`** | `f4734ac` | `v1.0.0` | 绿 |
| `dsh-remote-mp/` | 微信小程序客户端 | 不发 | `734c59f` | 无 | 绿 |

三条必须知道的规则：

1. **仓名 ≠ 包名**。协议发到 npm 的名字是 `dsh-remote-wire`——`dsh-remote-protocol` 这个名
   在 npm 上已被第三方占用（发布者 `weijf14-gmail`）。指仓库写 `dsh-remote-protocol`，
   指包写 `dsh-remote-wire`。
2. **`dsh-remote-control-presentation` 刻意不发 npm**（用户 2026-10-03 拍板）。
   `packages/presentation` 是 `private: true`，随 `scripts/install-to-profile.sh` 以 bundle 装进
   profile。`pnpm -r publish --dry-run` 只会列出插件包一个——这是可复核的判据。
3. **协议是 npm 依赖（`^1.0.0`），不是 git 依赖**。别退回 git 依赖：pnpm 11.7 下 git 包的
   `prepare` 只认含 commit 的精确 `allowBuilds` 键，四种宽松写法全被拒，每次升版都要手改两个消费仓。

**fork 要改的东西**：`dsh-remote-mp/project.config.json` 里的 `appid` 是本项目自用的（仓内 README
第 60-61 行已写明），别人跑自己的必须换成自己的 appid，真机还要在微信后台配 socket 合法域名。

**怎么发一个新版**（`dsh-remote-wire` / `dsh-remote-control`）：改 `package.json` 版本 → 提交 →
推 main → 打 `v<版本>` 并推标签 → Release 工作流自己跑校验、发 npm、建 GitHub Release。
标签与包版本不一致工作流会主动失败。中继仓打标签只会产出 Release + 产物附件，不发 npm。

## 2. 伞仓里剩下的东西（都不开源，也都不再持有源码副本）

五棵源码树已删除。下面这些是**伞仓独有、开源仓没有**的，别跟着一起删：

| 路径 | 为什么留着 |
|---|---|
| `e2e/` | 全部取证资产：逐字节对拍、本地全链路、生命周期、live-e2e。**开源仓里没有等价物** |
| `scripts/` | `validate-qr.mjs`（改二维码必跑）、`read-session-log.mjs`、`mp-*.mjs` 等 |
| `docs/DESIGN.md`、`docs/DESIGN-REVIEW.md` | 契约表 B1-B9 / F1-F13 / T1-T8、偏离 D1-D9、复核结论。开源仓的 `docs/` 是它们的**换算过名字的历史副本** |
| `docs/legacy-spec/` | 重写前从旧实现提取的事实档案 |
| `HANDOFF.md`（本文） | 伞仓**没有 remote**，这些提交只在本地 |

同步方法（唯一安全的一种）：`git archive HEAD <path> | tar -x -C <目标>`，取**已提交**快照，
别拿工作区对拷——尤其别把并行会话的在飞改动带进开源仓。

> **一处已知副作用**：`docs/DESIGN.md:239`（伞仓与开源 `dsh-remote-control` 两份都是）
> 用**行号**引用旧交接文 `HANDOFF.md:180-181`。本文整体重写后那个行锚已经指错地方。
> 下次动设计文时把它改成不依赖行号的引用（比如指提交号 `d058d8f` 或指条文名），
> 别再新增行号锚——这类锚点每次重写文档都会烂。

## 3. 待办（按价值排序）

1. **npm provenance 其实没挂上**。两个包都有 `publishConfig.provenance: true` + `id-token: write`，
   但 pnpm 的 OIDC 换票返回 404（`ERR_PNPM_AUTH_TOKEN_EXCHANGE`）后回落到 `NODE_AUTH_TOKEN`，
   于是 `/-/npm/v1/attestations/<pkg>@1.0.0` 是 404。**别在文档里宣称带 provenance。**
   要补：去 npm 站点给这两个包配 Trusted Publishing（包已存在，够条件了），再把发布步骤改成 OIDC。
2. **用户应在 npm 站点 revoke 一把旧 token**（`bypass_2fa:false` 那把，曾在对话里贴出来过）。
   它能登录但没有发包权限，仍然是有效凭据。可用的那把在 `~/.provid/env-v3` 的
   `DSH_REMOTE_NPM_TOKEN`（**值绝不写进仓库/文档/测试**），两仓 secret 已经是它。
3. **生产中继曾经报 `droppedFrames: 456`**（同窗口 `slowConsumers:0`、`rejectedPairs:7`、`hosts:1`）。
   这个字段是"中继收下却没送出去"的可见面，456 不是零。
   **但我这次重新部署把它清零了**——它是"自本次启动以来"的累计值，进程一换就归零，
   所以**别再指望 /healthz 还能告诉你这个数**。要查历史得去服务器：
   `journalctl -u dsh-remote-control --since "2026-10-02" | grep -c "frame dropped"`
   （确切 msg 串以 `src/server.ts` 为准）。**原因本来就没取证，现在现场也没了**——
   记着这条已经不可复原，别写成"待查 /healthz"。

4. **Dependabot 的 PR 还红着**（actions 4→7、typescript 5.9→7.0、@types/node 22→26）。
   多半是那些分支的 `ci.yml` 还是旧的（见 §4 第 2 条），需要 rebase 才会带走。
   **大版本没审过，别顺手合。**
5. `dsh-remote-mp` 要不要也打 `v1.0.0`（它没有 Release 流程，纯粹是"要不要有个版本页"）。
6. **真机取证还欠两条**：审批卡与提问卡。原因都是**本机部署配置/宿主版本**而非代码——
    审批策略全量是 `never`（用户已表态先不改，**别再问第二遍**），
    这一代宿主的 `ctx.userQuestions` 不带 `registerProvider`。两条都有本地闭环测试。

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


# 生产与私有树（伞仓）
curl -s https://drc.provid.cc/healthz                    # 线上真相（现在=开源仓产物 version 1.0.0）
cat ~/.dsh/dsh-remote-control/status.json                 # 插件侧真相
env -u NODE_OPTIONS node e2e/run.mjs                      # 本地全链路
env -u NODE_OPTIONS node scripts/validate-qr.mjs          # 动过二维码必跑
gh pr list --repo providcc/dsh-remote-server --state open # Dependabot 积压
```

## 9. 本轮已定与剩余（2026-10-03 深夜收口）

**已做完并有证据的：**

| 事 | 证据 |
|---|---|
| 中继版本尾巴收掉：发 `v1.0.1`，并把**已发布的产物**部署上线 | Release v1.0.1 带 `dsh-remote-relay.mjs` + `SHA256SUMS`；`shasum -c` OK 后才 scp；线上 `/healthz` 报 `version:"1.0.1"`、`hosts:1`（重启后主机自动重连成功） |
| 插件的"假事实"bug 移植进开源仓 | control `5bd4227`，224 项全绿，CI success |
| mp 的在飞改动移植进开源仓 | mp `aac0f60`：`npm run check` 三道闸全过（verify / theme:check / contrast 242 组达标），私有标识符扫描为空 |

**已拍板但还没做的两件事：**

1. **presentation 折进主插件，开源 control 仓只留 `packages/plugin` 一个包**（用户拍板）。
   要把 `packages/presentation` 的三块搬进插件：二维码落盘（presenter）、同域只读路由
   （`/plugins/<id>/pairing`，防环回 + 防跨作用域那两条判据要一起搬）、浏览器面 `client.cjs`
   （轮询 + `sidebarRight.openResource`）。**搬之前必须知道拆开的原因**：主插件刻意不写
   inject 闸门，而这条功能需要 `webServer` 服务——原来拆成两包是为了"宿主缺 webServer 时
   只有这一行不激活，配对/中继一行都不受影响"。折成一个包之后这个隔离必须由代码自己提供：
   **对 `webServer` 软探测，拿不到就只禁用路由与右栏，不许连累注册与转发**，并且要有测试
   锁住"缺 webServer 时配对链路照常"。`install-to-profile.sh`（伞仓私有脚本）随之只装一个
   bundle，`dsh.client` 那两个字段的注册形状要跟着改。npm 上这属于功能新增 → `1.1.0`。
2. ~~伞仓瘦身~~ ✅ 已做完（`f5a6853`）。**剩下的唯一尾巴是把 e2e 跑绿**，见 §0。

