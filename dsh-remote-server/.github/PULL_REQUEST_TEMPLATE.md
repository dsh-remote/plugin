<!--
标题用祈使句，例如：fix: close slow consumers on a sweep instead of on message
-->

## What & why

<!-- 这个改动解决了什么问题？为什么用这个做法？ -->

## How was it verified?

<!-- 跑了哪些命令、覆盖了哪些用例；涉及线上行为的改动（限流、背压、停机、配对路由）请特别说明。 -->

## Checklist

- [ ] `pnpm typecheck && pnpm test && pnpm format:check` 全绿
- [ ] 新增/修改行为有对应测试（修 bug 的话，先有一个会失败的用例）
- [ ] 没有在中继里 `import` 任何会碰明文的运行时值（结构性零知识）
- [ ] 没有改动 `/healthz` 的既有字段或日志的 `level` / `msg`（改它们是改运维契约）
- [ ] 没有为了让测试通过而放宽某条不变量
