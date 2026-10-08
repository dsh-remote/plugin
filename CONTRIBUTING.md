# 贡献指南

感谢你愿意花时间贡献。本文覆盖本仓遵循的约定；参与即表示你同意遵守
[行为准则](./CODE_OF_CONDUCT.md)。

## 本仓的基本规则

本仓**只有一个包**：`packages/plugin` 发 npm（`dsh-remote-control`），一次构建产出两半产物
（宿主侧 `dist/bundle/index.js` + 浏览器面 `dist/bundle/client.cjs`），两半都随
`scripts/install-to-profile.sh` 装进 profile。界面上那一半原来是**第二个 cordis 条目**，
2026-10-03 折进插件包并删除（隔离改由 `src/pill/start.ts` 的软探测提供）。最重要的几条：

1. **凭据绝不落盘、绝不入日志。** `hostToken` 只从环境变量读；任何打印路径都要过 `redactSecret`。
   提交前自查一遍你的 diff 里没有真实 token / PSK / 配对码。
2. **改代码必须重启 Harness 才能生效。** HMR 只热更 `cordis.patch.yml` 的配置，不重新 import 产物。
   这不是风格问题，是验证方法问题——"改了没效果"十有八九是忘了重启。
3. **配置键名继承旧名。** 这些键写在用户的 profile 里，改名等于让线上配置静默失效。要加新键可以，
   改旧键名不行。
4. **插件对内核面软探测，不写 inject 闸门。** 闸门会让"某代宿主缺某个服务"时整行静默不加载，
   比带着次优配置跑起来更难排查。

## 上手

```sh
git clone https://github.com/providcc/dsh-remote-control.git
cd dsh-remote-control
pnpm install
pnpm test
```

要求 Node.js ≥ 20 与 pnpm 11（见 `.nvmrc`）。协议层 `dsh-remote-wire` 以 npm 依赖引入，
并且是**精确钉**（`packages/plugin/package.json` 里写的是当前版本号，例如
`"dsh-remote-wire": "2.0.14"`，**不是** `^`——caret 会解析到更高的旧版本，那就不是这一次
的发版了）。

> ⚠️ 这里原来把这个版本号**手抄**成 `1.0.0-rc.1`，而真实值已经走到 2.0.x：
> 一个跟着别人读的人会把 `^` 当成"只是写法偏好"，而真正的原因是 caret 会解析到
> **私有期编号 1.9.0**。**以 `packages/plugin/package.json` 为准**，别信这一段里的例子。

**协议升版 = 一次跨四仓的发布**（2026-10-06 订正：原文把这句指给 README「前置条件」，
那里并没有这一节）：先在 `dsh-remote-protocol` 发版，再把
`packages/plugin/package.json` 的 pin 改成那个**精确**版本号，重跑
`pnpm install` 并提交新的 `pnpm-lock.yaml`，最后 `pnpm typecheck && pnpm test`。
漏掉第二步的话 `pnpm install --frozen-lockfile` 会直接红；漏掉重新 install 的话，
类型与运行时拿到的是**旧**协议（比如 `cmd.new_session.workspace` 读出来永远是
undefined，而 `parseCmdPayload` 又会把它 strip 掉——症状是"代码写了、行为没变"）。

## 开发流程

- 从 `main` **开分支**；提交保持聚焦，message 写清楚。
- **修 bug 先写测试。** 先加一个能复现问题的失败用例，再修。没有"去掉就该红"的测试的修复是不完整的。
- **推送前跑全绿：** `pnpm typecheck && pnpm test && pnpm format:check`。
- **不要为了让测试通过而放宽一条保证。** 如果某条契约看起来不对，提出来——放宽断言几乎总是错的修法。
- 想在本机验证效果：`sh scripts/install-to-profile.sh`，然后**重启 Harness**。改到浏览器面还要
  **重新加载页面**。

## 风格

- TypeScript，仅 ESM，`strict` 加 `noUncheckedIndexedAccess`。
- 格式由 [Prettier](./.prettierrc.json) 强制：不写分号、单引号、2 空格缩进、约 120 列。
- 注释解释**为什么**，不是**做了什么**——尤其当某个决定偏离了显而易见的做法。这里有好几处约束
  之所以长成现在这样，原因并不在代码里可见（例如二维码为什么默认出 PNG 而不是文本码）。

## 提交与 PR

- 提交标题用清晰的祈使句（`fix: keep the QR PNG out of the home directory`）。
- PR 描述里写清：问题是什么、怎么做的、怎么验证的。
- CI 必须全绿：类型检查、Node 22 上的单测、格式检查。

## 报 bug 与提需求

用 issue 模板。任何与安全相关的，按 [SECURITY.md](./SECURITY.md) 走，不要开公开 issue。

## 许可

贡献即表示你同意你的贡献按 [MIT 许可](./LICENSE) 授权。
