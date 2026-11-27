# dsh-remote-plugin (0.6)

**DSH Remote Control 0.6 —— 主推发布仓。** npm 发布入口：`@dsh-remote/plugin` 与 `dsh-remote-control`（`next` 通道）。

0.6 是自包含单包工程，全部源码在 [`v06/`](v06/)（协议 / 中继 / Harness 插件 / 微信小程序 / H5 构建壳）。
本地开发与判据：`cd v06 && npm ci && npm test && npm run build`。

发布：打 tag `v0.6.x` 触发 Release 工作流（从 `v06/` 构建并 publish 两个包名）。
0.5 线已废弃（2026-11-27），历史在本仓 git 历史与 npm `latest` 通道。
