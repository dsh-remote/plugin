# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

## [1.0.0] - 2026-10-03

### 新增

- 零知识 WebSocket 中继的首次公开发布（单进程、纯内存、运行时只依赖 `ws`）。
- 主机认证与会话路由；配对码的签发、路由与一次性消费。
- 分层限流：单连接帧速率、全局配对配额、单连接认证/配对失败上限、并发连接上限、待配对表上限。
- 背压闸门：慢消费者缓冲区持续超限即 1008 断开；客户端与主机窗口按角色区分。
- 心跳判活（WS 层 ping/pong）、主机宽限期、会话空闲回收。
- 优雅停机：新连接 1013、已连接对端收 1001，退出码 0。
- 运维契约：`/healthz` 八字段与 `/api/info`；一行一个 JSON 的 NDJSON 日志。
- **自包含单文件产物**（esbuild），部署退化为"拷一个文件 + 一个 env 文件"。
- 结构性零知识的机械防线：产物级断言构建产物里不含密码学代码。

[未发布]: https://github.com/providcc/dsh-remote-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/providcc/dsh-remote-server/releases/tag/v1.0.0
