# 贡献指南

感谢你愿意花时间贡献。本文覆盖本仓遵循的约定；参与即表示你同意遵守
[行为准则](./CODE_OF_CONDUCT.md)。

## 本仓的基本规则

这是一个**纯内存、单进程**的中继，也是一份**运维契约**。最重要的几条：

1. **中继只允许 import `dsh-remote-wire` 的类型。** 运行时它一个载荷字节都不该碰——
   这是结构性零知识，`tests/bundle.test.mjs` 会断言产物里没有密码学代码。如果你发现自己在
   中继里 `import` 了某个会碰明文的运行时值，方向就错了。
2. **`/healthz` 的字段与日志的 `level` / `msg` 是契约。** 改它们等于改告警规则与 grep。
   新增字段可以，别悄悄删字段或改 `msg`。
3. **不要为了让测试通过而放宽一条保证。** 如果某条不变量看起来不对，提出来——放宽断言
   几乎总是错的修法。
4. **重启语义是刻意的：全内存、不持久化。** PSK 与配对关系落盘只会扩大泄露面。

## 上手

```sh
git clone https://github.com/providcc/dsh-remote-server.git
cd dsh-remote-server
pnpm install
pnpm test
```

要求 Node.js ≥ 20 与 pnpm 11（见 `.nvmrc`）。单测需要先构建（`pnpm test` 已包含 build）。

## 开发流程

- 从 `main` **开分支**；提交保持聚焦，message 写清楚。
- **修 bug 先写测试。** 先加一个能复现问题的失败用例，再修。
- **推送前：** `pnpm typecheck && pnpm test && pnpm format:check`。
- 涉及线上行为的改动（限流、背压、停机、配对路由）请在 PR 里说明**怎么验证的**，
  最好是仓库里能跑的命令或测试。

## 风格

- TypeScript，ESM only，`strict`。
- 格式由 [Prettier](./.prettierrc.json) 强制：不写分号、单引号、2 空格缩进、约 120 列。
  提交前跑 `pnpm format`，或用 `pnpm format:check` 校验。
- 注释解释**为什么**，不是**做了什么**。这里有好几处行为（三个改名变量、`0.0.0` 版本探针、
  静默不生效的旧 env 名）之所以这样，原因不在代码里可见。
- 日志一律走 `src/log.ts`，字段值只允许 `string | number | boolean`。

## 提交与 PR

- 提交标题用清晰的祈使句（`fix: close slow consumers on a sweep instead of on message`）。
- PR 描述里写清：问题是什么、怎么做的、怎么验证的。
- CI 必须全绿：类型检查、Node 20 与 22 上的单测、格式检查、以及从空目录起产物的 `relay-smoke`。

## 报 bug 与提需求

用 issue 模板。任何与安全相关的，按 [SECURITY.md](./SECURITY.md) 走，不要开公开 issue。

## 许可

贡献即表示你同意你的贡献按 [MIT 许可](./LICENSE) 授权。
