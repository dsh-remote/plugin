# Changelog

## 3.1.5

### 落盘加固：敏感**目录**也走凭据级端口（2026-10-13 第六轮 review）

⚠️ **文档与实现分叉**：README 的「设计上的三条硬线」第 2 条写着凭据落盘一律 0600，
`status.json`、配对密钥簿、宿主身份文件、**附件目录**都走同一个落盘端口。前三项与附件的
**文件**确实走了（`writeSecure` 的五步），**目录本身没走** —— 三处都是
`mkdirSync(dir, { recursive: true })`，不带 `mode` ⇒ 用进程 umask，典型 **0755**：

- 别的本地用户能**列出**这些目录：会话 id、用户上传的文件名（文件名本身就说明了内容）；
- umask 宽松时（容器 / 自建服务常见 `UMask=0000`）目录变 **0777** ⇒ 别的本地用户能在里面
  **删/替换**文件 —— 而 `conversations-<hostId>.json` 里是**每个会话的 PSK**，
  附件路径则被写进 prompt 正文交给 Agent 读。

⇒ `secure-file.ts` 新增 `ensureSecureDir`（`SECURE_DIR_MODE = 0o700`）+ `mkdir({mode})`
**再** `chmod`（`mode` 只在创建那一刻生效，而 `recursive` 遇已存在目录直接返回 ⇒
一条 0755 的老目录永远收不紧）。三处敏感目录改走它：附件目录、配对密钥簿目录、
host-token 所在目录。

⚠️ **只收窄、不改属主已收紧过的目录**（`pair-store.test.ts` 抓到的第一版过度收紧）：
现有判据「目录只读（0500）时 save 必须优雅失败而不是抛」被第一版红了出来——它把运维
刻意设的只读**改回可写**。⇒ 规则收成：**组/他人两位上还有 1 才收**（0755/0777 → 0700），
已经只属主的（0700，含运维设的 0500）**一律不碰**。插件不该改一个自己没有设过的权限。

判据：`tests/secure-file.test.ts` +4 条（建目录 0700 / 老 0755 目录被收紧 /
三个敏感目录的创建点都走端口 / 属主收紧过的目录不许被改动）。**变异验证**：
去掉 chmod ⇒ 「老 0755 目录被收紧」那条立刻红。plugin 676 → **680** 条。

> 四个包一起 bump 到 `3.1.5`。**主体是小程序的审核整改**（见
> `packages/client/CHANGELOG.md` 的 3.1.5 一节），另含 2026-10-12 深度 review 的一批修复。

### 深度 review 补丁（2026-10-12）

- ⚠️ **自愈额度改成"按连续失败"计**（`src/index.ts`）：原来只增不减 ⇒ 一台机器跨天遇到
  第二次 `bad_token`（间隔远超冷却）就会把 5 次用尽、**被永久放弃**，而自愈要应付的
  恰恰是**会反复发生**的事（别人重建机器、令牌表裁剪、中继重部署）。现在一次 `hello-ok`
  就清空窗口。
  同时**拆成两个读数**：`diagnostics.hostToken.heals`（累计，只增不减，给运维看
  "这台被顶过吗"）与 `healFailedInRow`（这一轮连续失败，同时是额度读数）。
- ⚠️ **`hello-ok` 之后摘掉过期的 `hostToken` problem**：那几条 warn 说的是"这台主机
  现在连不上"，而走到 `hello-ok` 就证明令牌此刻能用 —— 不摘的话，用户手工换 token 之后
  一切正常，`status.json` 里却永久挂着一条假警报。
- **去掉一处重复实现**：`runtime.ts` 里有个**没人调用**的 `pendingForSession()`，而
  `cmd.get_pending` 那边内联复制了同一段筛选（注释还写着"必须逐字同判据"——两份实现
  正是它警告的事）。现在两条重放路（`cmd.get_pending` / `replayPending`）共用
  `pendingEntries()`。
- `pill/routes.ts` 的 `pairPageHandler(deps)` 不读 `deps`：**保留参数**（路由表统一工厂
  形状，判据按那个形状调用），但显式 `void deps` 并把理由写在注释里 —— 让"这个工厂
  不碰宿主状态"在代码里看得见。

> ⇒ npm 上仍是 3.1.4；这一版**要不要发**由下一次真发版时统一决定（小程序本身不发 npm）。

## 3.1.4

> 四个包一起 bump 到 `3.1.4`。**主题：把"向后兼容"整条清掉**（用户裁决：没有真实用户）。

- **认领必须带 `hostId`，且盘上那枚必须写 `hostId`**：`host-token.json` 的 `hostId`
  从可选变**必需**（缺了整份不可用，不再有"老文件照旧用"那条退路）；
  `readStoredHostToken(file, serverUrl, hostId, log)` 的身份判定从"两边都说得清才比"
  改成"不等就作废"。
- **host 身份只认自己产出的形状**：`host-id` 文件里除了 `drc-<12hex>` 之外一律换掉
  （旧写法 `h_xxxx` 不再沿用）。
- **能力位相关的接线删除**：`hello` 不再报 `capabilities`，`ev.host_info` 不再带 `caps`；
  `core/capabilities.ts` 只留"这一代内核能不能收图片"的探测（那是内核面的事实，不是版本兼容）。
- **重连重发 `ev.host_info` 的理由重写**：它现在只承载限额；不再有 `hostCaps` /
  `supportsResume()` 这套簿记。
- **打包脚本去掉上一代装法的擦屁股代码**：`pack-to-profile.mjs` 删 `LEGACY_DIR` 与
  "清掉旧直拷目录"，`install-to-profile.mjs` 不再替用户删旧的 `file:` 依赖。
- 判据：`claim-token` 的"老文件照样能用"翻成"缺 `hostId` 即不可用"；`host-id` 的
  "旧身份继续用"翻成"非本代形状一律换掉"；删掉"内核没有 `readHistory` 时不许报
  `resume`"那条（能力位没了）。

## 3.1.3

> 四个包一起 bump 到 `3.1.3`。**主题：认领时要表明身份**（配合中继侧
> 「按 hostId 一机一枚」的模型修正，起因是 2026-10-11 那次被别的机器顶下线的事故）。

- **认领请求带上 `{hostId}`**：中继据此把这枚令牌**绑到这一台**，于是别的机器认领时
  **顶不掉我们**。⚠️ 当时中继对不带 `hostId` 的认领还会落到"未绑定槽位"，
  而那条路在同一天晚间的后续改动里**已删除**（中继现在一律回 400 `host_id_required`；
  用户裁决「不需要兼容老客户端」）。
- **落盘记下 `hostId`**，并在"文件里的身份不是本机"时**当它不存在**（重新认领）。
  起因：`host-id` 文件被删/换了数据目录之后，盘上那枚属于**上一个身份**，
  拿它去连只会一直 `bad_token`，而插件有 token 就不再认领 ⇒ **永久连不上**且盘上文件看着正常。
  ⚠️ 当时为"老文件没有 `hostId` 字段"留了一条"照旧用"的退路，那条**已在 2026-10-11 晚间删除**：
  现在缺 `hostId` 的文件**整份不可用**（没有老用户，留着它只会让一个说不清归属的文件继续生效）。
- 中继回显的 `hostId` 与本机不同时留一条日志（不因此丢令牌：鉴权由中继按它记的槽位判定）。

判据 +3（`tests/claim-token.test.ts`）：请求体真的带了 hostId（且不知道身份时**不许**凭空编一个）/
落盘记下 hostId 且身份不符时作废 / 回显不符时留痕。
（"老文件照样能用"那一条判据后来**反向**了：缺 `hostId` 的文件现在整份不可用。）

## 3.1.2

> 四个包一起 bump 到 `3.1.2`。**这一版的主题是「插件装完就能用」**：
> 默认走官方中继、没有口令时启动自动认领并落盘，自部署与自定义收进设置页的进阶一栏。

- 🔴 **默认 `serverUrl` 改成 `wss://drc.provid.cc`**（原来是 `ws://127.0.0.1:8787`）。
  旧默认值只对"正好在本机跑着中继"的人成立，对下载插件的绝大多数人来说，
  它的真实含义是"配完也不通"（用户原话：下载下来发现不能用，直接就卸载了）。
  ⚠️ 随包分发的 `cordis.patch.yml` 里**刻意不再写** `serverUrl`：默认值只有一处事实源，
  两处各写一份必然漂移（那份 patch 是注入层，优先级高于默认值）。
- 🔴 **没有 host token 时，启动自动向中继认领一枚**（`POST <中继>/api/claim-token`），
  落进 `host-token.json`（0600，走 `platform/secure-file.ts` 那一条路，与 `status.json` 同目录），
  下次启动直接读盘。三条纪律都写进了判据：
  - 落盘**只走 `SecureFilePort`**（0600 + 原子写 + fsync），不新开写文件的路；
  - **形状定长校验**（48 位小写十六进制）：中继侧 `tokenMatches` 是定长比较，
    长度变了不会报错、只会让已装机的主机**静默**连不上 ⇒ 形状不对一律当失败、不落盘；
  - **认领失败不阻断启动**：载具与配对入口照常起来，只留一条 `warn:hostToken`
    与 `diagnostics.hostToken.*`（来源 / 认领结果 / 失败原因 / HTTP 状态码 / 文件名）。
    ⚠️ 盘上那枚记着"向哪台中继领的"：`serverUrl` 不同就不认它（拿旧凭据去连新中继，
    要么被拒，要么把上一台的服务器的凭据送给一台陌生的服务器）。
- **配置多出第四层**（`默认值 < 设置页写下的 < patch 注入 < 环境变量`）：设置页写下的自定义项
  落在 `user-config.json`（0600），**压在 patch 之下**——手写 patch 的人仍然说了算。
- **设置页多出「进阶：自部署 / 自定义」那一栏**（`GET|POST /plugins/dsh-remote-control/config`）：
  读当前中继地址与口令**来源**（只有脱敏形态，绝不给真值）、写自部署地址 / 自己的一枚口令、
  清除口令、恢复默认。三条行为判据：**只提交改动过的那一项**（口令框留空不许被当成"清空"）、
  保存失败要把宿主给的理由印出来（不许显示"已保存"）、状态轮询每两秒重画整页但
  **输入内容不许被抹掉**。
- 同类清理：`cordis.patch.yml` 里删掉 `approvalTimeoutSec: 180`（该键 2026-10-11 已删，
  留着只被静默忽略，而 README 又写着"没有这个键"）。

⚠️ 装机后**要重启 Harness** 才生效（换文件不热加载）；设置页那一栏改完也**重启才生效**
（中继地址与 token 是建连接时读一次的），回答里带 `restartRequired: true`。

✅ **中继已先部署**：`/api/claim-token` 随 `@dsh-remote/relay@3.1.2` 上了 ECS
（`https://drc.provid.cc/healthz` version=3.1.2；`GET /api/claim-token` → 405、
`POST` → 200 + 48 位 token、紧接着再 `POST` → 429）。顺序**必须先中继后插件**，
否则新装的插件认领会拿到 404 → 落到"没有 token" → 插件照常起来但连不上中继
（`diagnostics.hostToken.claim = failed` / `claimReason = http`）。

### 两条**仓级**修复（不进 npm 包，但同一版一起发）

- 🔴 **`release.yml` 里那一步写了两个 `run:`** —— GitHub 对重复 YAML 键是**整份拒绝**
  （`startup_failure`、0 秒、无 job、页面只写一句 `workflow file issue`）。
  于是 3.1.0 之后**三个包的自动发布全部停摆**，而症状看着像"Trusted Publishing 没配上"。
  修法：合成一个 `run: |`；判据见伞仓 `e2e/ci-gates.test.mjs` ⑨（+ ⑨b 反向）。
- **`scripts/pack-to-profile.mjs` 认不出 `DSH_PROFILE=desktop`** —— 那个环境变量
  **可能是路径、也可能是名字**（DSH 宿主自己就把名字放进环境里），当成路径会直接
  `profile not found: desktop`、装机一步都走不了。现在按
  `DSH_PROFILE_DIR` → 路径 → `~/.dsh/profiles/<名字>` 的顺序解析。

## 3.1.1

> 四个包（`protocol` / `relay` / `plugin` / `client`）一起 bump 到 `3.1.1`。
> **这一版是真修复**：审批卡、提问卡、待办三处都改成**只跟随宿主，不自己加逻辑**。

- 🔴 **审批/提问卡不再有主机侧期限**。原来 180/300 秒的上限**是插件自己加的**
  （宿主入参 `onApprovalRequest` / `onQuestionRequest` 本就不含期限字段），
  而它造成过真实故障：页面退后台 → 事件退订 → 卡帧到了 client 没到界面 →
  用户回到页面时主机早已判超时，于是"手机上点不动"。
  **现在跟随宿主的 `timeoutMs`：给了就跟随，没给就不设**（协议里 `expiresAt` 本就是可选的）。
- 🔴 **待办只转发内核发来的清单**。原来在轮次开始时若"上一轮显示过清单"就合成一帧空帧，
  而它的前提"内核不会为『这一轮没有待办』发帧"**是错的**（内核确实会发，同一条用例里就喂过
  `todos: []`）⇒ 那会造成双重清空。随它一起删掉的还有 `todoShown` 那套记账。
- 配置项 `approvalTimeoutSec` 随之删除（留着就是死配置）。
- 判据新增：形状（9 条，源码层面）与行为（1 条，两方向 × 两类卡）各一层，六处变异全部验证。

⚠️ 装机后**要重启 Harness** 才生效（换文件不热加载）。

⚠️ 重启后这样确认加载上了 —— **看顶层 `kernel` 这个键在不在**（不是看 `diagnostics` 的组数）：

```sh
python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.dsh/dsh-remote-control/status.json')));print('kernel 键数:', len(d.get('kernel') or {}))"
```

期望 `kernel 键数: 38` 左右、`kernel.attachmentFace = "commands.prompt"`。
⚠️ 我一度把这条判据说成"`diagnostics` 从 7 组变 8 组并多出 `kernel`" —— **那是错的**：
`kernel` 是**顶层键**，`diagnostics` 本来就是 7 组，两者都不随版本变。

## 3.1.0

> 四个包（`protocol` / `relay` / `plugin` / `client`）一起 bump 到 `3.1.0`。

**本包无功能改动** —— 3.0.8 那批修复（离线挂账 / 重连补推 / 工作区登记）就是当前行为。

- **发布链路换成 npm Trusted Publishing（OIDC）**：新增 `.github/workflows/release.yml`，
  打 `v*` tag 即发。没有 `NPM_TOKEN`、没有长期凭据 —— GitHub 签一个 OIDC token，npm 核对
  「这次运行确实是本仓、本工作流」之后发一个短时发布 token。
  `publishConfig.provenance` 随之打开 ⇒ **从这一版起 npm 上有供应链溯源**（v3.0.x 各版都没有）。
- **修 `repository` / `homepage` / `bugs`**：一直指向 `dsh-remote/dsh-remote-<包名>`（**不存在**），
  实际仓名是 `dsh-remote/<包名>` ⇒ npm 包页的仓库链接此前是 404。

## 3.0.0

> 3.0.1 ~ 3.0.8 是 v3 上线前后的迭代版本（都已发到 npm），逐版记录在伞仓
> [`docs/RELEASE.md`](https://github.com/linbin/dsh-remote-v3) 的「已发布记录」。
> 这一节只保留 3.0.0 当时的内容。

- v3：四端合并进 `dsh-remote-v3` 单仓开发；包名由 `dsh-remote-control` 迁到 **`@dsh-remote/plugin`**，
  仓库改到 [`dsh-remote/dsh-remote-plugin`](https://github.com/dsh-remote/dsh-remote-plugin)。
  运行时标识 `dsh-remote-control` **保持不变**（路由前缀、数据目录、profile 安装名）——那是有意的稳定标识。
- **PathsPort**（`src/platform/paths.ts`）：绝对路径判定 / 数据目录派生 / 工作区形状判定收成一处。
  修 v2 三处分叉——`config.ts` 两条 `startsWith('/')` 在 Windows 上把 `C:\` 路径**静默改道**；
  校验把正确的 `C:\` 配置报成「必须是绝对路径」；`carrier-services` 只收 POSIX 形态。
  判定带 `platform` 参数 ⇒ **在 macOS 上就能验 win32 行为**（15 形态 × 3 平台表驱动）。
- **SecureFilePort**（`src/platform/secure-file.ts`）：5 处 0600 落盘收敛为一处；补上 v2 只在 relay
  做了的「清同 pid 残留」；win32 上 `chmod` 只切只读位 ⇒ **显式 warn 一次**而不是假装生效；
  `safeFileName` 补 Windows 保留名（`CON` / `con.txt`）——此前会让**整批附件回滚**。
- **审批「本次会话内始终允许」**（§9.1）：查表放在挂 waterfall **之前**（放在之后就只是记账），
  键取「会话 + 类别」，随 `stop()` 清空。直接服务 30 秒原则。
- **浏览器半** `client/src` → `src/client`（消除第二个源码根），两个编译面各自自包含。
- **配对地址只有一处事实源**：二维码 `s=` 逐字等于 `serverUrl`（判据），小程序侧没有手填入口；
  死文案「请先扫码或**填写**中继服务地址」清零。
- **设计语义映射**（`docs/DESIGN-TOKENS.md`）：pill 的 7 个 fallback 色值从 CSS 里 18 处字面量
  收成一处（顺带修掉一个没人报的不一致：`label-secondary` 原来有两个兜底值）。
- 脚本去 shell 化：`install-to-profile.sh` → `.mjs`（`lastIndexOf('/')` 在 Windows 上得 -1，
  会把备份写到当前目录，而那文件带 hostToken）。
- 判据 524 → 562。

2.0.21 及更早的完整历史见旧仓 [`providcc/dsh-remote-control`](https://github.com/providcc/dsh-remote-control) 的 CHANGELOG。
