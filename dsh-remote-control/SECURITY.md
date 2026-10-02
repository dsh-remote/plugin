# 安全政策

## 报告漏洞

请通过 [GitHub Security Advisories](https://github.com/providcc/dsh-remote-control/security/advisories/new)
（**Security → Report a vulnerability**）私下报告疑似漏洞。

安全报告**不要**开公开 issue。我们会在几天内确认，修复发布后会为愿意署名的报告者致谢。

报告时请尽量包含：

- 受影响的版本或提交；
- 最小复现或 PoC；
- 你认为的影响面（机密性 / 完整性 / 可用性）；
- 该问题是否同样影响中继、协议库或小程序客户端——本仓与它们实现的是同一条链路。

## 范围

本仓交付**宿主侧插件**：配对、中继连接、会话与命令、审批转发、防休眠，以及把配对二维码落盘、
让右栏自动弹码的 presentation 半侧。特别在范围内的是：

- 让中继、网络或本机其它进程拿到**明文载荷**或**密钥材料**（PSK / 会话密钥 / `DRC_HOST_TOKEN`）的途径；
- 凭据泄漏进日志、`status.json`、进程参数或产物文件；
- 让未配对的对端冒充已配对对端、绕过配对码一次性/短命约束的路径；
- 把本机能力（`node:child_process`、文件写入、内核服务）暴露给远端而**没有**用户可见的授权动作。

不在本仓范围：中继自身的加固与限流（见 [`dsh-remote-server`](https://github.com/providcc/dsh-remote-server)）、
线协议的字节级契约（见 [`dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol)）、
小程序运行时。**TLS 终止**由部署方的反向代理负责，中继自身不终止 TLS。

## 设计姿态

- **载荷级端到端加密。** 中继只看到 `base64(nonce ‖ secretbox)`，不持有任何密钥材料。密钥在主机上
  生成，只经配对二维码交给手机，从不上网。
- **凭据只从环境变量读。** `hostToken` 由 `hostTokenEnv` 指向的环境变量提供，不写进 patch 文件——
  配置文件比环境变量更容易被顺手提交或贴进工单。
- **脱敏是默认。** 日志与 `status.json` 里的密钥一律经 `redactSecret` 折叠成
  `abcd…yz(42)` 形态；报告问题时请沿用它，**不要**贴出真实值。
- **最小权限的面。** 主插件刻意**不写 inject 闸门**，对每个内核面软探测；需要 `webServer` 才能工作的
  二维码半侧被拆成单独一行，某代宿主缺该服务时受影响面最小。

完整的威胁模型、信任边界与每条论断的证据等级见 [`docs/SECURITY.md`](./docs/SECURITY.md)。

## 支持的版本

本仓整体版本化，安全修复只落在最新发布线上。请保持依赖更新。
