# HANDOFF — dsh-remote-control

> 交接给下一位 agent。先读 docs/PRODUCT.md，再读本文。
> 历史细节不在这里：各仓 git log 为准；旧版 HANDOFF 在伞仓 git 历史里。

## 0. 当前状态（2026-10-05）

| 仓 | 版本 | 状态 |
|---|---|---|
| dsh-remote-protocol/（包名 dsh-remote-wire） | 1.8.0 | 1.7.0 / 1.8.0 未发 npm，见 §1.3 |
| dsh-remote-control/（单包） | 2.0.9 | 未发 npm；临时 file: 指本地协议仓 |
| dsh-remote-server/ | 1.0.4 | 生产在跑（/healthz version:1.0.4, hosts:1）；不发 npm（包名被第三方占） |
| dsh-remote-mp/ | 1.1.21 | 体验版已发布 |

三条不许再错：

1. 仓名 ≠ 包名：仓库 dsh-remote-protocol，npm 包 dsh-remote-wire。
2. 协议是 npm 依赖，不是 git/file 依赖——现在的 file: 是临时态，发版后换回去。
3. 判据是版本号 + 文案，不是字节哈希：esbuild 内嵌模块路径标签，同源码换次构建哈希就变。

线上真相：中继 wss://drc.provid.cc；本机 hostId=drc-748e9a9ce167（落盘 host-id，0600）；status.json 按定时器刷，读它要轮询、要带基线。

闸门（干净工作树）：control 370/370、伞仓 175/175 + run.mjs 17 步、mp check 32/32 + 对比度全过。

## 1. 待办（按顺序做）

### 1.1 模型串台修复（在飞，未闭环）

用户 2026-10-05 实测：本会话 space-bunny-free，顶栏却显示别的会话的 muse-spark。根因：模型是按会话的，ev.model 却当全局发。

wire 已改（sessionId 必填，未提交）；control 的 request/header 已映射（未提交），但 broadcastModel 还是全局广播、没传 sessionId——要改成按会话发（模型从 request/header 来），否则编译过不了；mp 的 _onModel 还没按 sessionId 过滤（chat.js 那段模型是全局的注释一起改）。做完→提交→全闸门→随 §1.3 发版走。

### 1.2 排队消息功能移除（用户 2026-10-05 拍板）

结论：排队没有意义。inbox 没有删除入口是物理限制，留着队列只会两端不一致。

新策略：执行中不允许提交消息；发送按钮在执行中变为中断按钮；chat 页右上角的中断按钮取消。范围：send_prompt 的 queueId、cmd.drop_queued、ev.queue、cmd.get_queue、主机 PromptQueue/drainQueue/inbox 入表、手机排队条与拉取/删除链、伞仓队列判据，全部删除。附件（图片/文件）链不动，中继 1MB 帧上限不动。

### 1.3 发版（新 token 已就位，最后做）

用户已提供新 token（值不落文档，写入 ~/.npmrc 0600 即可）。顺序：做完 §1.1 §1.2 再发。步骤：发 wire → control 依赖换回 ^1.8.0 → 发 control。这四个号从未上过 npm，号段可复用；本地 tag 若已打需重打。Release 工作流自带 Verify provenance landed。

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
