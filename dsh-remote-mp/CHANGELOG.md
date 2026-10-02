# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

- 界面与交互仍在改造，目录与接口可能调整。

## [1.0.0] - 2026-10-03

### 新增

- DSH Remote Control 微信小程序客户端的首次公开发布（原生小程序，两页）。
- 首页内联配对：扫码 / 粘贴 / 6 位码三路入口，扫完即连，不跳页。
- 与主机的握手与配对；载荷级端到端加密（vendored tweetnacl + js-base64）。
- 会话列表与对话页：文档流（轮次 / 指令 / 步骤组 / 正文 / 系统提示），流式输出、审批卡、提问卡、中断。
- 打开会话时从主机读取历史（分页游标、与实时流同一套落块）。
- 浅色/深色主题，可手动切换且跨启动保留；配色按 WCAG 对比度校验（不跟随系统）。
- 按需注入 / 用时注入：显著削减启动时注入的组件 JS。
- 无 WebSocket 能力的运行环境下如实上报并给出可复制的环境自检。

[未发布]: https://github.com/providcc/dsh-remote-mp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/providcc/dsh-remote-mp/releases/tag/v1.0.0
