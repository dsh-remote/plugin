# 贡献指南

感谢你愿意花时间贡献。本文覆盖本仓遵循的约定；参与即表示你同意遵守
[行为准则](./CODE_OF_CONDUCT.md)。

## 本包的基本规则

这是一个**纯函数**库，也是一份**冻结的线协议契约**。最重要的两条：

1. **没有 I/O，没有定时器，不做平台执行。** 防休眠只暴露"该跑哪条命令"；真正去跑是调用方的事。
   如果你需要一个副作用，它属于别的包。
2. **字节级兼容不可谈判。** 小程序里有一份同格式的独立实现。任何对编码、密钥派生或 nonce 布局的
   改动都必须在那边同步实现，并有对拍测试覆盖。拿不准就先开 issue。

## 上手

```sh
git clone https://github.com/providcc/dsh-remote-protocol.git
cd dsh-remote-protocol
pnpm install
pnpm test
```

要求 Node.js ≥ 20 与 pnpm 11（见 `.nvmrc`）。

## 开发流程

- 从 `main` **开分支**；提交保持聚焦，message 写清楚。
- **修 bug 先写测试。** 先加一个能复现问题的失败用例，再修。没有"去掉就该红"的测试的修复是不完整的。
- **推送前类型检查 + 跑测试：** `pnpm typecheck && pnpm test`。
- **不要为了让测试通过而放宽一条保证。** 如果某条契约看起来不对，提出来——放宽断言几乎总是错的修法。

## 风格

- TypeScript，仅 ESM，`strict` 加 `noUncheckedIndexedAccess`。
- 格式由 [Prettier](./.prettierrc.json) 强制：不写分号、单引号、2 空格缩进、约 120 列。
  提交前跑 `pnpm format`，或用 `pnpm format:check` 校验。
- 注释解释**为什么**，不是**做了什么**——尤其当某个决定偏离了显而易见的做法。这里有好几处契约
  之所以被字节冻结，原因并不在代码里可见。

## 提交与 PR

- 提交标题用清晰的祈使句（`fix: reject unpadded base64 in parsePairingUri`）。
- PR 描述里写清：问题是什么、怎么做的、怎么验证的。
- CI 必须全绿：类型检查、Node 22 上的单测、格式检查。

## 报 bug 与提需求

用 issue 模板。任何与安全相关的，按 [SECURITY.md](./SECURITY.md) 走，不要开公开 issue。

## 许可

贡献即表示你同意你的贡献按 [MIT 许可](./LICENSE) 授权。
