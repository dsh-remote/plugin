# HANDOFF — dsh-remote-control

> 交接给下一位 agent。先读 docs/PRODUCT.md，再读本文。
> 历史细节不在这里：各仓 git log 为准；旧版 HANDOFF 在伞仓 git 历史里。

## 0. 当前状态（2026-10-05）

| 仓 | 版本 | 状态 |
|---|---|---|
| dsh-remote-protocol/（包名 dsh-remote-wire） | 1.8.0 | 已发 npm（2026-10-05，Release 工作流带 provenance） |
| dsh-remote-control/（单包） | 2.0.9 | 已发 npm（2026-10-05） |
| dsh-remote-server/ | 1.0.4 | 生产在跑（/healthz 1.0.4, hosts:1）；不发 npm（包名被第三方占）；本轮改动待部署，见 §1.1 |
| dsh-remote-mp/ | 1.1.21 | 体验版已发布 |

三条不许再错：

1. 仓名 ≠ 包名：仓库 dsh-remote-protocol，npm 包 dsh-remote-wire。
2. 协议是 npm 依赖（^1.8.0），不是 git/file 依赖；1.8.0 已发，两个消费仓都已换回去。
3. 判据是版本号 + 文案，不是字节哈希：esbuild 内嵌模块路径标签，同源码换次构建哈希就变。

线上真相：中继 wss://drc.provid.cc；本机 hostId=drc-748e9a9ce167（落盘 host-id，0600）；status.json 按定时器刷，读它要轮询、要带基线。

闸门（干净工作树）：wire 90/90、server 84/84、control 366/366、伞仓 186/186、mp 32/32 + 对比度全过；四个仓 format:check 全绿。

## 1. 待办（按顺序做）

§1.1 模型串台、§1.2 取消排队、§1.3 发版已于 2026-10-05 全部完成。下面是之后要做的。

### 1.1 服务器部署（未做，线上还是 1.0.4）

peer-left 的 unpaired 标记**在中继侧**，主机与协议都已生效，但线上 1.0.4 还没带上它。
不部署的话 mp 解配后 dsh 仍然显示「手机离线」（旧中继不发这个字段，主机按 D3 留着会话）。
部署后要复验：mp 解除配对 → pill 从「手机离线」变「未配对」；手机切后台再回来**不许**要求重新扫码。

### 1.2 把插件装进 Harness 并真机复验

`~/.dsh/profiles/desktop/node_modules/dsh-remote-control` 里还是 2.0.8 的手工副本。
本轮四个改动（模型按会话、提问卡能弹、取消排队、解配作废会话）**都还没上过真机**。
装完要重启 Harness + 重载页面，然后逐条复验。e2e 只验逻辑层，真机才知道排版与时序。

### 1.3 自动滚动重构 + FAB 换位（用户 2026-10-05 提，未动）

- 滚动：**默认永远跟底**，只在确实不能跟的场景特殊判定（别再靠一堆启发式互相猜）。
  现在「不跟手、很多场景卡住」正是那堆启发式打架的结果。
- FAB：现在右下角、偏大、颜色太抢，挡住很多操作。换个位置、缩小、降调。
  定位是「临时远离电脑时的手机替代」：离线是常态不是故障，不许红/黄报警色。

## 2. 环境坑（还有效的）

- 所有 pnpm/node 命令带 env -u NODE_OPTIONS（子 shell 注入的 loader 会搞挂 ESM 解析）。
- 装/查/打包走 Node 22（pnpm 11 要 22.13+）；pnpm/action-setup 不写 version；本家包在 minimumReleaseAgeExclude 写裸名。
- node --test 统一 find 加 xargs，先断言文件数非零；跑的是 dist，先 build（build 先 clean）。
- 每仓一把 write deploy key，core.sshCommand 已钉好，直接 git push，别加 GIT_SSH_COMMAND。
- profile 里 node_modules/dsh-remote-control 必须是真目录、无 file 依赖；改代码后重启 Harness + 重载页面。
- 插件与 e2e 是两份物理 ws，按被测产物解析位置取副本，装不上就抛。
- 探针 scripts/approval-probe.mjs 加 session 参数；取码走 POST /pairing/new + GET /pairing.png + zxing 解（不改 profile、不重启；umask 077，用完删）。
- 读宿主实现直接 grep 打 app.asar；status.json 按定时器刷，读数要轮询加基线。
- 判据红了先查判据再查实现；变异验证要改成能编译的形状，否则测的是上一个产物。

## 3. 命令速查

```sh
env -u NODE_OPTIONS pnpm -C dsh-remote-control test   # 本仓闸门（含 build）
env -u NODE_OPTIONS node e2e/run.mjs                  # 本地全链路 17 步
curl -s https://drc.provid.cc/healthz                 # 线上真相
cat ~/.dsh/dsh-remote-control/status.json             # 插件侧真相（轮询+基线）
node scripts/mp-preview.mjs                           # 改完 mp 先让用户扫码看
node scripts/mp-shots.mjs --pages sessions            # 截图验收
```
