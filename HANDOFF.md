# HANDOFF — dsh-remote-control

> 交接给下一位开发 agent。**先读本文，再读代码。**
> 重写于 2026-10-03（上一版内容太长已整体替换；旧文在 git 历史里，`git show d058d8f:HANDOFF.md`
> 能取回，**没有丢**——包括那些一次性取证细节）。

## 0. 一句话状态

产品已经开源成 **GitHub 上四个独立仓**（账号 `providcc`，MIT），两个 npm 包已发布，四仓 CI 全绿。
生产入口 `wss://drc.provid.cc` 在跑，真机链路通。**伞仓（本目录）不是交付物**，它是私有工作区：
线上部署、e2e 取证、小程序端未提交的改动、设计史都只在这里。

**最容易搞错的一件事：有两条版本线，它们不是同一个东西。**

| | 版本 | 从哪来 | 现状 |
|---|---|---|---|
| 生产中继 | **`2.0.0`** | 伞仓 `apps/server/`（私有树） | `curl -s https://drc.provid.cc/healthz` 实测 `version:"2.0.0"`，`uptimeSec`≈42 400 |
| 开源仓发布 | **`1.0.0`** | `dsh-remote-server/` | tag `v1.0.0` + GitHub Release |

两边**已经实测漂移**：`apps/server/src/server.ts` 与 `dsh-remote-server/src/server.ts` **内容不同**
（开源那份有 C1 心跳分桶 + C2 遍历改造，私有那份没有）。
`packages/plugin/src/**` 与 `dsh-remote-control/packages/plugin/src/**` 目前逐文件相同（刚比对过）。

→ **改开源仓不等于改线上；改线上不等于改开源仓。** 先想清楚要动哪一边。

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

## 2. 伞仓里剩下的、不能删的东西

| 路径 | 为什么不能删 |
|---|---|
| `apps/server/` | **线上跑的就是这份**（version 2.0.0）。开源那份是清理过的拷贝，两者会漂 |
| `packages/protocol/`、`packages/plugin/` | 私有开发树；插件是线上宿主实际加载的源码 |
| `mp/` | 小程序端源码 + **并行会话正在改的未提交改动** |
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

## 3. 待办（按价值排序，前四条都不需要重新调研）

1. **C3 全局帧/字节预算**——但**先给压测装置加"带流量模式"**（走完 pair-begin/claim 再打 `enc`）。
   现在的数据量不出来：C0 测的是**空载**连接，一条业务帧都没走，而 C3 担心的正是
   `JSON.parse` + zod 在集体突发下打满 2 vCPU。**阈值不能从空载数推**，这是清单本身的缺口。
   处置原则已定：中继不能丢 `enc`，所以超预算判给**触发它的那条连接**（1008 + 计数进 `/healthz`）。
2. **npm provenance 其实没挂上**。两个包都有 `publishConfig.provenance: true` + `id-token: write`，
   但 pnpm 的 OIDC 换票返回 404（`ERR_PNPM_AUTH_TOKEN_EXCHANGE`）后回落到 `NODE_AUTH_TOKEN`，
   于是 `/-/npm/v1/attestations/<pkg>@1.0.0` 是 404。**别在文档里宣称带 provenance。**
   要补：去 npm 站点给这两个包配 Trusted Publishing（包已存在，够条件了），再把发布步骤改成 OIDC。
3. **用户应在 npm 站点 revoke 一把旧 token**（`bypass_2fa:false` 那把，曾在对话里贴出来过）。
   它能登录但没有发包权限，仍然是有效凭据。可用的那把在 `~/.provid/env-v3` 的
   `DSH_REMOTE_NPM_TOKEN`（**值绝不写进仓库/文档/测试**），两仓 secret 已经是它。
4. **生产中继 `droppedFrames` 现在是 456**（`/healthz` 实测，同窗口 `slowConsumers:0`、
   `rejectedPairs:7`、`hosts:1`、`clients:0`）。这个字段就是"中继收下却没送出去"的可见面，
   456 不是零——**下一次接手先查这个数怎么涨的**（原因未取证，别照抄任何解释）。
5. **C4 掉线类日志按秒聚合**（`Log.throttledCount`）。量级已测出：稳态日志 0 B/s，但
   10k 建连风暴在 0.7 s 内写了 **10 000 行 / 1.3 MB**——所以它治的是**重启风暴**。
   **C6**（`/healthz` 加 `peers`/`rssBytes`/`sweepMaxMs`/`pingBacklog`）价值在可观测性，不是容量。
6. **C5 会话表快照：红线等用户拍**。`docs/DESIGN.md:239` 写死"新增持久化：**0**"
   （伞仓那份与开源 `dsh-remote-control/docs/DESIGN.md` 同一行，两份都有）。
   D1 之后表里没有 `psk`，前半条理由已经不成立；但"谁和谁配过对"这层**元数据**落盘仍然成立。
   且它会牵出两个必须先决定的事：systemd 要配 `ReadWritePaths=`；
   `e2e/restart-resume.test.mjs` 在伞仓而不在开源仓——**e2e 归属哪个仓**。
7. **C7 用户明确先不做**（改到一半已 `git restore`，`dsh-remote-server` 工作树干净）。别当待办捡起来。
   原计划是 `listen({backlog:4096})` + upgrade raw socket `setNoDelay(true)`；sysctl 那半归用户。
8. **Dependabot 的 PR 还红着**（actions 4→7、typescript 5.9→7.0、@types/node 22→26）。
   多半是那些分支的 `ci.yml` 还是旧的（见 §4 第 2 条），需要 rebase 才会带走。
   **大版本没审过，别顺手合。**
9. `dsh-remote-mp` 要不要也打 `v1.0.0`（它没有 Release 流程，纯粹是"要不要有个版本页"）。
10. **真机取证还欠两条**：审批卡与提问卡。原因都是**本机部署配置/宿主版本**而非代码——
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

# 压测装置（C0 的成果；带流量模式还没做，见 §3.1）
cd dsh-remote-server && env -u NODE_OPTIONS pnpm build && node scripts/loadtest-conns.mjs --n=10000 --seconds=30

# 生产与私有树（伞仓）
curl -s https://drc.provid.cc/healthz                    # 线上真相（version 2.0.0）
cat ~/.dsh/dsh-remote-control/status.json                 # 插件侧真相
env -u NODE_OPTIONS node e2e/run.mjs                      # 本地全链路
env -u NODE_OPTIONS node scripts/validate-qr.mjs          # 动过二维码必跑
gh pr list --repo providcc/dsh-remote-server --state open # Dependabot 积压
```
