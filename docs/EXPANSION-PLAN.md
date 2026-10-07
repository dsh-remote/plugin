# 扩展示划：多 profile / 三平台 / 自建中继

> **这份文档是什么**：2026-10-07 一轮取证 + 计划的结果记录。
> **不是什么**：不是待办清单，也不是现状描述——凡是"现在是这样"的部分都带 `file:line`；
> 凡是"打算这样做"的部分都写在 §7，且**一条都还没实现**。
>
> 写它的理由只有一条：这轮调研的结论里有三条**反直觉**的（见 §3、§5、§6），
> 而反直觉的结论如果只留在对话里，下一个人会重新踩一遍。

---

## 1. 已拍板的三条前提（2026-10-07）

1. **多个 DSH = 多个受控端，互相不进行任何关联。** 各自的身份、各自的配对通道、
   各自的落盘状态，彼此不共享、不感知、不互为备份。
2. **小程序是客户端，一次只连接一个受控端。** 换受控端 = 重新配对。
3. **TUI 没有 pill**，配对出口要另找（§5 整节是这件事的调研）。

第 1 条直接推出一个硬约束：**多个实例必须状态隔离**，否则它们会互相顶掉——
理由见 §4.3，这不是设计洁癖，是中继的既有行为。

---

## 2. 结论速查

| 问题 | 结论 | 依据 |
|---|---|---|
| web profile 能装吗 | ✅ 能，bundle 栈与 desktop 相同 | §4.1 |
| tui profile 能装吗 | ⚠️ 能加载，但缺 2/8 必需服务 + 没有 HTTP 面 | §4.2 |
| web 和 desktop 能做成一套吗 | ✅ **配置与 bundle 列表能，目录/进程/身份/状态不能** | §3 |
| 终端能打 ASCII 二维码吗 | ✅ **能，行高 1.0 实测可解**；❌ 但 TUI 的投递面只有一行 | §5 |
| DSH 命令卡为什么扫不出来 | 因为它 `line-height:1.6`，与 ASCII 二维码本身无关 | §5.2 |
| 中继能跑在 Windows 上吗 | ✅ 核心几乎可移植，4 处要改 | §6.1 |
| 自建中继缺什么 | 服务端已可配；**小程序里没有任何地方能填中继地址** | §6.2 |

---

## 3. web 与 desktop 能不能做成一套

**逐层判定，不要笼统回答。**

### 3.1 不能合并的（宿主硬约束）

| 事实 | 位置 |
|---|---|
| Electron 把 profile 名硬编码成 `desktop` | `app.asar!/dsh/lib/main.js:70` |
| GUI 端口硬编码 `19387` | `app.asar!/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:231-235` |
| CLI **明确拒绝** `--profile desktop` | `@deepseek-ai/dsh/lib/bin.js:35-37`（`rejectElectronProfile`） |

⇒ 永远是两个目录、两个进程。按前提 1，它们就是**两个独立受控端**。
**这一层不统一，也不该统一。**

### 3.2 能真正做成一份的：配置 ⭐

宿主自带一个**全 profile 共享的补丁层**：`~/.dsh/cordis.patch.yml`。

- rc.6 CLI：`lib/profile-boot-DG5t9aNs.js:94`（`homePatchPath`）、`:151`（`...composed.homePatches`
  在启动层序里）、`:168`（加载）、`:271`（**热监听**）
- rc.2 桌面：同一个 `homePatchPath()`，函数注释原文——
  *"applied **over every profile's own layer**"*

层序（后者覆盖前者）：

```
bundle 补丁（按 dsh.profile.bundles 顺序）
  → profile 自己的 cordis.patch.yml
    → ~/.dsh/cordis.patch.yml          ← 共享层
      → --patch 覆盖层
```

⇒ 把 `dsh-remote-control` 那一行（`serverUrl` / `hostTokenEnv` / `hostLabel`）
从 desktop 的 patch **挪到 home patch**，desktop 与 web（以及 tui/headless）同时吃到。
**一份文件，改一处全生效，改完热加载不用重启。**

备选是 `~/.dsh/.env`（两代都 `loadEnvFile`，`dsh-app-boot/lib/index.js:613`），
插件已经在读 `DRC_SERVER_URL` / `DRC_HOST_TOKEN` / `DRC_HOST_LABEL`。

### 3.3 只能"生成时统一"的：bundle 列表

`dsh.profile.bundles` 在**每个 profile 自己的 package.json** 里，
**没有继承、没有 home 层**（`dsh-app-boot/lib/index.js:546`）。
web 想有 session-archive / provider-usage / archify 那些第三方，
得让安装器往两个 package.json 写同一份列表。

这是"一套"里**唯一需要写代码的部分**，而 `install-to-profile.sh` 本来就在写这个列表。

### 3.4 必须分开的：身份与状态

| 项 | 为什么不能共用 |
|---|---|
| `hostId` | 同 hostId 重连会被中继以 **4000 `replaced_by_newer_socket`** 顶掉旧 socket |
| `status.json` / 密钥簿 / `uploads/` | 两个写者抢同一份文件 |

**配置共享、状态隔离**——这就是 §7 里 P0 与 P1 的切分。

### 3.5 一个必须知道的坑

patch 是**整行替换 `config`，不做深合并**
（`@deepseek-ai/cordis-plugin-include/lib/index.js:100-103`，`target[key] = value`）。

在 home patch 里写 `- id: dsh-remote-control` 会**整行覆盖** profile 里的同名行——
只想改一个键，就得把该行拥有的每个键都重述一遍。
`~/.dsh/profiles/tui/cordis.patch.yml` 头部那句警告就是这个意思，
而 desktop 那份 patch 里有 `keepAwake` / `pill` 两个嵌套对象，正是这条坑的现成例子。

---

## 4. profile 体系取证

### 4.1 四个 profile 的实际 bundle 栈

| profile | `dsh.profile.bundles` |
|---|---|
| **desktop** | base + web-app + auto-review + schedule-bundle + session-archive + sandbox-extra-roots + provider-usage + archify-dsh + **dsh-remote-control** + agent-team-profile |
| **web** | base + web-app |
| **tui** | base + `dsh-cc-tui@0.4.1` |
| **headless** | base + headless |

⇒ **web 与 desktop 的基础栈完全相同**，desktop 只是多叠了第三方。
web profile 目录里甚至连 `node_modules` 都没有（靠 `~/.dsh/profiles/node_modules`
那个扁平软链兜底目录）。

### 4.2 服务可用性：哪些 profile 缺什么

插件需要 8 个 cordis 服务。**6 个来自 `dsh-base`（所有 profile 都有）**，
2 个是 **`dsh-web-app` 独占**：

| 服务 | 提供者 | desktop | web | tui | headless |
|---|---|:-:|:-:|:-:|:-:|
| `sessions` / `sessionQuery` / `agents` / `agentDefaultModel` / `userQuestions` / `attachments` | `dsh-base` 各行 | ✅ | ✅ | ✅ | ✅ |
| `workspaceRegistry` | `@deepseek-ai/dsh-workspace`（`dsh-web-app/cordis.patch.yml:73-74`） | ✅ | ✅ | ❌ | ❌ |
| `webServer` | `@deepseek-ai/dsh-host-webserver`（`dsh-web-app/cordis.patch.yml:115-116`） | ✅ | ✅ | ❌ | ❌ |

（`grep -nE "dsh-workspace|dsh-host-webserver" dsh-base/cordis.patch.yml` → 无匹配，已实测。）

⇒ **tui 装上插件会加载，但降级运行**；`webServer` 缺失还直接导致
`status.json` 里那条 `warn:pill`（配对入口为零，见 §5）。

### 4.3 实例隔离为什么是硬约束（不是设计洁癖）

落盘默认值全部派生自**同一个全局目录** `~/.dsh/dsh-remote-control/`：

| 东西 | 位置 |
|---|---|
| `status.json` | `shell/config.ts:127` |
| `host-id` | `shell/host-id.ts`（与 status.json 同目录） |
| 配对密钥簿 | `resolvePairStoreFile()`（`shell/config.ts:157-164`，默认取 statusFile 同目录） |
| 附件落盘 | `resolveUploadDir()`（`shell/config.ts:171-182`） |

两个实例同时跑 ⇒ 同一个 `hostId` ⇒ 中继把先来的那条 socket 以 **4000** 顶掉，
而 `status.json` 与密钥簿变成两个写者。
这与 `install-to-profile.sh` 头部注释里记的"两个插件实例同时挂在中继上"是同一条故障。

---

## 5. TUI 的配对出口：终端 ASCII 二维码调研

这是本轮最花时间的一条，结论有三条且**第一条反直觉**。

### 5.1 结论：行高不是卡点

**真实终端的行高恒为 1.0**（字符填满自己的格子，行与行紧贴），
而 ASCII 二维码在行高 1.0 下**实测可解**。

历史上那条"文本码扫不出来"的结论（提交 `704fd21`，2026-10-02 真机实测）
描述的是 **DSH 命令卡这个 HTML 渲染器**（`line-height:1.6`），
**不是 ASCII 二维码本身**。

### 5.2 实测数据

用仓里自己的编码器（`packages/plugin/dist/src/platform/qr.js`）+ 真 `zxingcpp` 解码
+ 终端栅格化模拟 + 变异验证（把 `▀▄` 对调 → 确实解码失败，证明测量本身可信）。

**行高扫描**（cell 8×16、暗色主题）：

| 行高 | 结果 |
|---|---|
| **1.00（真实终端）** | ✅ 解码成功，逐字节一致 |
| 1.02 – 1.09 | ✅ 临界容忍度（随字号 2–19px 不等） |
| 1.10 | ❌ |
| 1.15 | ❌ ← 与历史真机实测一致 |
| 1.60（DSH 命令卡） | ❌ |

**另外三个常见担心，量下来都不是瓶颈：**

| 变量 | 实测 |
|---|---|
| 字号 | 模块 6×6 ~ 16×16 屏幕像素 **全部可解** |
| 拍摄距离 | 模块缩到 **2×2 像素仍可解** |
| 极性 | 黑底浅码（反色）与白底黑码 **都能解** |

**渲染器侧的独立佐证**（对 `dsh-cc-tui@0.4.1` 做 headless 渲染，走真实 ink 内核）：

- 核心渲染器 `lib/types/ink/output.js:400-417` 每行 `offsetY++`，
  **整个 ink 里没有 line-height 这个概念**；
- 25 行码进 → **25 行连续出**，间距精确 1.0，缩进精确 2 列；
- 换行列 = `terminalColumns − x`（`lib/types/ink/render-node-to-output.js:470`），
  **不是固定的 60/80**；
- `stringWidth('█▀▄')` 实测 = 1（EAW 模糊宽度按窄处理，
  `lib/types/ink/stringWidth.js:14-16, 197`）；
- 零字符净化（文本节点、切片、格子写入全程逐字）；
- inline 模式无高度上限（headless 实测 `scrollHeight == innerHeight`，25 行全在）；
- **最强的一条：这个 TUI 启动时就在渲染半块像素画**——
  DEEPSEEK 字标（`lib/types/components/bigfont.js:4-12`，每行独立 `<Text>` 放在无间隙 Box 里）
  和一只 25×40 的动画像素鲸（`lib/types/components/Whale.js:18-58`）。
  **那比 25×49 的二维码更难。**

⇒ **渲染器完全合格。** 行高这条卡点不存在。

### 5.3 真正的卡点：投递面只有一行

`/drc` 命令的返回值**不会变成转录行**，它走 `notify`：

```
dsh-commands  types.d.ts:16-24     CommandResult = {kind:'success', text?}
→ channel.js:1284                   return execution?.result.text ?? ''
→ screens/Chat.js:645-652          channel.notify(text)
→ channel.js:1056-1071             toast，timeoutMs ?? 4000
→ components/PromptInput.js:739    <Box position="absolute" height={1} overflow="hidden">
                                     <Text dimColor wrap="truncate">
```

headless 渲染这个盒子喂 25 行码：**只出现一行，而且是二维码的最后一行**
（`justifyContent:"flex-end"` 底对齐），被横向截断、变暗，4 秒后消失。

这比行高硬得多：**行高是渲染属性，1.0 我们改不了也不需要改；
投递面只有一行，是我们能选的。**

转录区里唯一能渲染多行的是 `local-output` 行
（`components/MessageList.js:276-277`，多行、无截断、间距 1.0），
但它只能由 TUI 内部的 `channel.pushLocal()` 产生（`channel.js:1290-1300`），
**插件够不着**；且它带 `dimColor`，对比度下降对扫码是风险。

`!` 开头的本地 bash 也不行：`channel.js:1582-1586` 只推一行，
且 `preview()`（`channel.js:34-37`）做 `text.replace(/\s+/g,' ')` —— **换行全被压平**。

### 5.4 尺寸：真实屏幕条件下已验证

80 列 + 2 列缩进 + "55% 降采样 + 离焦 + 高斯噪声"的相机条件：

| 配置 | prod-98B | selfhost-110B（自建中继域名更长） |
|---|---|---|
| M-q4 | 51列×**25行** ❌ 超一行 | 55列×**27行** ❌ |
| M-q3 | 49列×**24行** ✅ 刚好 | 53列×26行 ❌ |
| **L-q2** | 43列×21行 ✅ | 47列×23行 ✅ |
| L-q1 | 41列×20行 ✅ | 45列×22行 ✅ |

**全部解码成功且逐字节一致。**
建议默认 **ECC L + 静默区 2**——两种载荷都进得去 24 行，
且给自建中继的长域名留了余量。

### 5.5 唯一的真实风险（已量化，未在真终端验过）

**终端把 EAW「模糊宽度」当宽**（部分 CJK 定制配置会开）。

- TUI 侧实测 `stringWidth(▀▄█) = 1`（`ambiguousAsWide:false`）；
- 但**终端侧未实测**。模拟结果：

```
正常(模糊=窄): 净图可解 相机可解
模糊=宽:        失败 ❌     ← ▀▄█ 占 2 格、空格仍 1 格 → 码横向撕裂
```

兜底是纯 ASCII 样式（`##` / `..`，2 字符/模块），无歧义但宽度翻倍
（41 模块 × 2 = 82 列 > 80），需要 ≥90 列终端。
macOS Terminal.app / iTerm2 / Windows Terminal 默认都是"窄"，CJK 定制配置才开——
**但这条必须在真终端上验一次，不能靠推断。**

### 5.6 两条可行的绕法

| 方案 | 要不要 patch 第三方 | 说明 |
|---|---|---|
| **A. 模型在围栏代码块里吐码** | ❌ 不用 | assistant 行 → `Markdown.js` 的 `gap={1}` 只作用在**块元素之间**，单个代码块内部仍是 1.0；highlight.js 的 `plaintext` 逐字节保留半块字符（已实测） |
| **B. patch `Chat.js:645-652`** | ⚠️ 要 | 改走 `channel.pushLocal('/', qrLines)` → `local-output` 行。第三方 bundle，升级即失效 |

### 5.7 这一节的收尾判断

**ASCII 方案的限制是"投递面"，不是物理不可行。** 这句话必须写进文档：
后者会让人把一个实测有 2%–9% 余量的方案永久否掉。

---

## 6. 其余两条能力线的取证

### 6.1 三平台（windows / linux / macos）

**中继核心几乎可移植**：`src/` 里没有硬编码 `/var/lib`、`/tmp`、`/etc`、`/opt`，
没有 `child_process`、没有 `fcntl`、没有 unix socket、没有 `node:os`。

真正的阻塞只有四处：

| # | 位置 | 问题 |
|---|---|---|
| 1 | `dsh-remote-server/src/persist.ts:253-254` | `mode: 0o600` + `chmodSync` 在 Windows 上是空操作，凭据文件的权限保证**静默失效** |
| 2 | `dsh-remote-server/src/main.ts:68-69` | SIGTERM 在 Windows 没有投递路径，服务管理器停止 = 硬杀，没有 drain、没有状态落盘 |
| 3 | 4 个测试文件 | `spawn('sh')`、`mode & 0o777` 断言、SIGTERM exit-code 断言在 Windows 必挂 |
| 4 | `hardening.test.mjs:18`、`bundle.test.mjs:21,119` | 仍在用 `new URL().pathname`（同仓 `scripts.test.mjs:79-86` 反而断言脚本不许这么写——修得不一致） |

插件侧另有三处写死 POSIX：

| # | 位置 | 问题 |
|---|---|---|
| 5 | `shell/config.ts:161,179` | `configured.startsWith('/')` 判绝对路径 → `C:\...` 与 UNC 全部误判成相对路径 |
| 6 | `platform/carrier-services.ts:681-689` | `badWorkspace()` 显式拒绝 `C:\...`（注释里写着"Windows 明确不实现"） |
| 7 | `dsh-remote-protocol/src/platform/sleep.ts:20-38` | 防休眠只支持 `darwin\|linux`，win32 返回 `unsupported`——**这是刻意的**（DESIGN §7.2，旧 PowerShell 构造器从未真机验证） |

DSH 自身在 Windows 上是**部分可用**的：`dsh-base/cordis.patch.yml` 里有 5 处
`process.platform === 'win32'` 的行级闸，`dsh-cc-tui` 再加 2 处，
还有 `dsh-win32-process` / `dsh-sandbox-windows-acl` 两个专门的包。
但 **DSH 没有任何 sleep/power 助手**（全仓 grep `powerSaveBlocker` / `SetThreadExecutionState` /
`caffeinate` / `systemd-inhibit` 均 0 命中）——插件自己那套是唯一的。

### 6.2 自建中继

**服务端已经可配**：27 个 `DRC_*` 环境变量（`src/config.ts:153-249` 全部读在一处），
无配置文件、无 CLI 参数。Dockerfile / Caddy / launchd 在 `docs/SELF-HOSTING.md`
里都有配方，但**全部标着 [未实测]**，CI 也只有 `ubuntu-latest`。

**真正的产品级阻塞在小程序**：中继地址**只能从配对二维码来**
（`miniprogram/core/codec.js:200-227` 解析 `s=` 参数），
而 `pages/sessions/sessions.wxml` 里**没有任何输入框能填它**——
`data.server` 有校验（`sessions.js:604-606`）却无 UI 可写，
`client.js:150` 还留着一句指向不存在界面的文案「请先扫码或填写中继服务地址」。

微信侧四道闸：appid、socket 合法域名、备案域名、有效证书（体验版/正式版无法绕过）。

---

## 7. 计划（**一条都还没实现**）

| 阶段 | 内容 | 判据落点 |
|---|---|---|
| **P0** | 实例隔离：`stateDir` 按实例派生 status/密钥簿/host-id/uploads；`instance` 由安装脚本按已知 profile 路径写进该 profile 的 patch，`DRC_INSTANCE` 可覆盖 | control 仓；两个假实例同时 `apply()` 的逐字段对照 |
| **P1** | web profile：安装器 `--all` 写各 profile 的 bundles（同一份）；共享配置迁到 `~/.dsh/cordis.patch.yml` | control 仓；**安装脚本目前零判据，要补** |
| **P2** | tui profile：① `status.json` 增 `profileCaps` 如实上报缺什么 ② 重建 `/drc`（`commands` 服务在 base 里，TUI 会并进斜杠菜单 `channel.js:278`）③ 配对出口 PNG 落盘 + 系统 opener，ASCII 走 §5.6 方案 A | control 仓；无 webServer 时一条 HTTP 路由都不许注册、凭据不进日志 |
| **P3** | 三平台：路径判定改 `path.isAbsolute`；`badWorkspace` 平台感知；chmod 在 win32 显式降级为一条 warn；防休眠 win32 如实上报且默认关；安装/启动脚本跨平台；中继 win32 信号与测试的平台 skip；四仓 CI 加 OS 矩阵 | 四仓；新增路径判定的表驱动判据 |
| **P4** | 自建中继：小程序加"自建中继"入口并清掉死文案；Docker/Caddy/Windows 配方**实测化**；端到端清单 | mp 仓五道闸 + server 仓 `docs.test.mjs` + `deploy-sync.test.mjs` |
| **P5** | 收口：`pnpm gates` 刷新 README 项数（不做会红）、HANDOFF 记账、四仓 CHANGELOG、版本号 | 伞仓 |

---

## 8. 诚实的边界

1. **相机条件是合成模型**（降采样 + 离焦 + 高斯噪声），不是真机。
   方向有真机佐证——历史那条"行高 1.0 真机可解、1.6 真机不可解"是用户实测的；
   本轮是把边界量化。
2. **§5.5 那条（终端模糊宽度）必须在真终端验一次**。
3. **§3.2 的 home 补丁层**在 rc.6 与 rc.2 都存在（已分别核实），
   但**两代宿主行为是否完全一致未做交叉验证**——GUI 用的 rc.2 与 PATH 上的 rc.6
   存在版本差（bundle 解析是 installation-anchor 优先，跨代混用有风险）。
4. **子代理的部分结论未由我逐条复核**（TUI 的 headless 渲染测量、small program 与中继仓的细项）。
   文中已标 `file:line`，需要时可直接复核。
5. 本轮**没有审**图片附件那条链（HANDOFF §0.10.10 指名下一个读历史的人先审它）。

---

## 9. 复现方式

```sh
# 终端二维码栅格化实验（本轮 §5.2 / §5.4 / §5.5 的全部数据）
cd .tmp/qrterm
env -u NODE_OPTIONS node gen.mjs     # 用仓里自己的编码器出矩阵 + 半块文本
env -u NODE_OPTIONS node gen2.mjs    # 静默区/纠错等级变体
/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python decode.py    # 行高扫描
/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python decode2.py   # 容忍度 + 变异验证
/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python decode3.py   # 容忍度曲线
/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python decode4.py   # 静默区 × 相机
/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python decode5.py   # 模糊宽度风险 + 真实屏幕条件
```

`.tmp/` 是 gitignore 的。这些脚本**应该固化成 `scripts/validate-qr.mjs` 的一条判据**——
历史上正是因为缺了"半块文本 → 终端栅格化 → 解码"这条路径，
"文本码"才被误判成物理不可行（§5.7）。

---

## 10. 相关文档

- 现状与配置：[`HOST-SIDE.md`](HOST-SIDE.md)（配置键表、`status.json` 排障、pill 四条路由）
- 排错第一入口：[`HANDOFF.md`](../HANDOFF.md)
- 宿主能力面：[`HOST-CAPABILITIES.md`](HOST-CAPABILITIES.md)
- 中继自建手册：`dsh-remote-server/docs/SELF-HOSTING.md`
