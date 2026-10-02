# 安全政策

## 报告漏洞

请通过 [GitHub Security Advisories](https://github.com/providcc/dsh-remote-mp/security/advisories/new)
（**Security → Report a vulnerability**）私下报告疑似漏洞。

安全报告**不要**开公开 issue。我们会在几天内确认，修复发布后会为愿意署名的报告者致谢。

报告时请尽量包含：

- 受影响的版本或提交；
- 最小复现或 PoC；
- 你认为的影响面（机密性 / 完整性 / 可用性）；
- 该问题是否同样影响宿主插件、中继或协议库——本仓与它们实现的是同一条链路。

## 范围

本仓交付**微信小程序客户端**。特别在范围内的是：

- 让配对码、PSK 或派生密钥泄漏到日志、存储以外的位置或屏幕截图的途径；
- 让未配对的对端冒充已配对主机、或让伪造的主机响应被当真（例如不做密钥确认就展示"已配对"）；
- 解密失败被静默当作"没有数据"处理（那会让用户基于假事实排查）；
- 把明文载荷交给中继的任何路径。

不在本仓范围：中继自身的加固与限流
（见 [`dsh-remote-server`](https://github.com/providcc/dsh-remote-server)）、
线协议的字节级契约（见 [`dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol)）、
宿主插件（见 [`dsh-remote-control`](https://github.com/providcc/dsh-remote-control)）。

## 设计姿态

- **载荷级端到端加密。** 客户端只会发出 `base64(nonce ‖ secretbox)`；明文与密钥从不离开设备。
- **只持有该持有的。** 客户端持有配对二维码里的 PSK 与派生密钥，**不持有**中继的 host token。
- **如实上报失败。** "解密失败""环境缺能力""读不到历史"都必须是可见的独立状态，
  不允许折成"空数据"——那等于给用户一个假事实。
- **不提供弱随机兜底。** vendored tweetnacl 的 PRNG 只认全局 CSPRNG；误用 `randomBytes` 时
  宁可抛错也不悄悄降级（nonce 用计数器，正常路径不依赖随机）。

完整的威胁模型与信任边界见宿主插件仓的
[`docs/SECURITY.md`](https://github.com/providcc/dsh-remote-control/blob/main/docs/SECURITY.md)。

## 支持的版本

本仓整体版本化，安全修复只落在最新发布线上。请保持依赖更新。
