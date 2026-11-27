# DSH Remote Control 0.6.0 验收契约

需求来自旧仓 b2066af 的产品定义与协议，以及工作区 0.5.6 / 0.5.11 / 0.5.14 的修订。以用户能观察到的行为为判据。旧版源码和源码正则断言仅用于定位场景。固定密文向量是迁移的测试数据。

| ID | 可观察行为 | 旧版出处 | 0.6 用例 |
| --- | --- | --- | --- |
| W1 | 协议号为 1，端点按固定方向派生密钥，固定输入 产生相同密封记录。损坏或错方向的记录无法解密 | [协议字节规范](../../packages/protocol/SPEC.md#7-密码学层l2)，旧 wire vectors | wire |
| W2 | 控制帧按角色和形状接收，密文仅转发，摘要只有时间、布尔和整数 | [安全模型](../../docs/SECURITY.md)，relay-summary-audit | wire、relay、journey |
| P1 | 实际微信扫码直接认领，最近使用带回的旧参数不触发连接。手机只核对双方确认码。临时失败可重扫，已用或过期的码本进程直接拦截 | [客户端变更](../../packages/client/CHANGELOG.md)，mp-pairing | client、journey |
| P2 | 码一次性且由中继定时；手机和电脑各显示 6 位 SAS。只有手机确认显示的那张授权，才启用对应密钥。不同授权迟到、拒绝或弹窗重复回调均不能换掉已展示的授权 | [现行手机配对](../../packages/client/core/pair.js)，mp-page-pairing | wire、client、journey |
| P3 | 同机重配和换手机按通道权限处理。普通掉线能续，主动解配后旧通道不可再用 | [插件变更](../../packages/plugin/CHANGELOG.md)，mp-same-phone-repair | relay、journey |
| R1 | 主机按 hostId 认领。满表保护当次新令牌；正常认证更新最近使用；闲置到期按配置裁剪；全局令牌独立 | [中继变更](../../packages/relay/CHANGELOG.md)，host-token-table | relay |
| R2 | 自领令牌被拒后，最多 5 次快速尝试，每次冷却 60 秒。额度耗尽后等 10 分钟再开一轮，握手成功清空预算。显式令牌被拒时报告原因 | [插件变更](../../packages/plugin/CHANGELOG.md)，heal-slow-retry | host |
| R3 | 加密路由落到正确成员。普通下线显式提示，配对继续存在，重连先按中继序号补帧，超窗显式 gap；重启后可恢复成员、令牌和摘要 | [离线连续性](../../docs/REVIEW-offline-continuity.md)，restart-resume、wire-resume-replay | relay、journey |
| H1 | 手机列会话，按活动时间排序，创建时把用户选的完整目录原样送到主机。归档是显式命令，并显示主机的拒绝信息 | [产品定义](../../docs/PRODUCT.md)，mp-sessions-list、carrier-services | client、journey |
| H2 | 发指令、带附件、流式答复、中断。相同 cmdId 重试不可二次执行，客户端按实际主机能力限制附件和字数 | [v3 基线](../../docs/V3-PLAN.md#13-功能面v2-已有v3-必须继续有)，frame-budget、mp-client | wire、journey |
| H3 | 宿主挂起审批、提问。手机在线后可补拉；两端谁先答都能收卡，手机离线不能误报任务停止 | [产品定义](../../docs/PRODUCT.md#3-由承诺推出的一条设计判据30-秒原则)，mp-host-offline | journey、host |
| H4 | 历史可以向前翻页，断线补差量用主机自己的序号。窗口不够时重读最近一页 | [协议续传](../../packages/protocol/SPEC.md#107-断线补差量since-游标)，wire-resume-delta | wire、journey |
| U1 | 列表显示待处理、项目分卡、本地置顶、离线快照。按完整路径分组，空闲行无状态徽标，选项目无重复的最近项目项 | [客户端变更](../../packages/client/CHANGELOG.md)，mp-sessions-list、mp-last-known | client、journey |
| U2 | 聊天加载故障按可见状态呈现。Markdown 加载失败时页面可以注册，正文降级为纯文本，正常环境保留富文本 | [0.5.13](../../packages/client/CHANGELOG.md)，mp-markdown-fallback | client |
| O1 | 可运行单文件中继，宿主诊断不带令牌、配对码或正文。微信构建、宿主包、开发测试能独立运行 | [发布与验收](../../docs/RELEASE.md)，bundle、host-config-docs | distribution |
| O2 | 真实微信小程序码由自托管中继签发。自部署可配置连接地址。微信通知按模板配置开关 | [自托管](../../packages/relay/docs/SELF-HOSTING.md)，mpcode、notify | distribution、发布验收 |
| O3 | 深浅两色、无主机可看演示、客服与赞赏依附微信原生能力。宿主按任务状态持有或释放防休眠锁 | [交接](../../HANDOFF.md)，mp-theme、mp-review-safety、sleep | client、host、发布验收 |

## 测试方式

- 先把输入、动作、预期输出落成可失败的用例，再写对应实现。
- 用例从网络、宿主端口、存储或页面事件观察结果。需要固定时间或随机数据时由装置提供，期望值独立于业务常量。
- 令牌慢速档同时验调用位置和恢复成功。宿主和手机的端到端测试用回环中继与可控 Harness 端口。微信 IDE、真实 DSH 和跨版本升级还需要各自环境验证。
