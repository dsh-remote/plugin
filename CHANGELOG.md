# Changelog

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
