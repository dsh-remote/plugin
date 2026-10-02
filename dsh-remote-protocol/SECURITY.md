# 安全政策

## 报告漏洞

请通过 [GitHub Security Advisories](https://github.com/providcc/dsh-remote-protocol/security/advisories/new)
（**Security → Report a vulnerability**）私下报告疑似漏洞。

安全报告**不要**开公开 issue。我们会在几天内确认，修复发布后会为愿意署名的报告者致谢。

报告时请尽量包含：

- 受影响的版本或提交；
- 最小复现或 PoC；
- 你认为的影响面（机密性 / 完整性 / 可用性）；
- 该问题是否同样影响中继、宿主插件或小程序客户端——三端实现的是同一份协议。

## 范围

本仓只交付**线协议**。它做密码学（密封记录、密钥派生、配对 URI 编码），但不存密钥、不开 socket、
不起定时器。它的正确性是整个系统安全性的必要条件，因此特别在范围内的是：

- 会重复使用同一对 `(key, nonce)` 的密钥派生或 nonce 构造；
- 接受了本应拒绝的形状（或拒绝了合法形状）的解析器；
- 与小程序编解码器不逐字节一致的 base64 / UTF-8 路径；
- 任何让"只应看到类型"的调用方拿到明文字节或密钥的途径。

不在本仓范围：部署加固、TLS 终止、主机 token 处理。那些在 `dsh-remote-server` 与
`dsh-remote-control` 两个仓里。

## 设计姿态

- **载荷级端到端加密。** 中继只看到 `base64(nonce ‖ secretbox)`，不持有任何密钥材料；
  机密性来自协议的依赖图，而不是一句策略承诺。有测试断言中继的构建产物里不含密码学代码。
- **PSK 从不上网。** 它在主机上生成，只经配对二维码交给手机。这是与最初实现差别最大的一处。
- **两把方向密钥。** 双方各自从 `(psk, 方向, convId)` 派生 `c2h` 与 `h2c`。手机用计数器 nonce，
  因为小程序运行时没有 CSPRNG。
- **一次性、短命的配对码。** 6 位、单次使用、TTL 由服务端权威下发。

完整威胁模型与冻结契约表见 `dsh-remote-control` 仓里的
[`docs/DESIGN.md`](https://github.com/providcc/dsh-remote-control/blob/main/docs/DESIGN.md)。

## 支持的版本

协议在野外是 pre-1.0、整体版本化；安全修复只落在最新发布线上。请保持依赖更新。
