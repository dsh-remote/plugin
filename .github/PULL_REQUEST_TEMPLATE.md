<!--
标题用祈使句，例如：fix: keep the QR PNG out of the home directory
-->

## What & why

<!-- 这个改动解决了什么问题？为什么用这个做法？ -->

## How was it verified?

<!-- 跑了哪些命令、覆盖了哪些用例；改到真机行为的话，把重启 Harness / 重载页面的结果贴出来。 -->

## Checklist

- [ ] `pnpm typecheck && pnpm test && pnpm format:check` 全绿
- [ ] 新增/修改行为有对应测试（修 bug 的话，先有一个会失败的用例）
- [ ] diff 里**没有**真实凭据（host token / PSK / 配对码），日志与 status 输出均经脱敏
- [ ] 若改了配置键或安装脚本：已在**本机 profile** 装一遍并重启 Harness 验证
- [ ] 没有为了让测试通过而放宽某条不变量
