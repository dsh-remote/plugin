# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

## [1.0.0] - 2026-10-03

### 新增

- DSH Remote Control 宿主侧插件的首次公开发布（`dsh-remote-control`、`dsh-remote-control-presentation`）。
- 与零知识中继的配对与长连接；主机认证与自动重连。
- 会话发现、指令下发、流式输出回传；审批（提问）转发到手机并可回答。
- 防休眠策略：有会话时保持唤醒，空闲后自动释放（`caffeinate` / `systemd-inhibit`）。
- 配对二维码渲染：默认出 **PNG**（文本码在 DSH 命令卡的行高下扫不出来），可落到会话工作区 `.dsh`。
- `dsh-remote-control-presentation`：把当前配对码落盘并暴露一条同域只读路由，浏览器面轮询它并
  **自动推开右栏**——不需要用户手动打开侧边栏，也不静默切换工作区。
- 状态快照 `status.json`（0600）作为 GUI 宿主的排错入口，密钥字段一律脱敏。
- 对宿主内核面的软探测：不写 inject 闸门，缺服务时受影响面最小。
- 自包含单文件产物（esbuild），安装只需拷文件 + 注册 bundle，profile 里不需要 `node_modules`。

[未发布]: https://github.com/providcc/dsh-remote-control/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/providcc/dsh-remote-control/releases/tag/v1.0.0
