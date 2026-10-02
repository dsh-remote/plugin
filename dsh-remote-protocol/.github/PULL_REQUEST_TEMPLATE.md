<!--
标题用祈使句，例如：fix: reject unpadded base64 in parsePairingUri
-->

## What & why

<!-- 这个改动解决了什么问题？为什么用这个做法？ -->

## How was it verified?

<!-- 跑了哪些命令、覆盖了哪些用例；如有可复现步骤请贴出来。 -->

## Checklist

- [ ] `pnpm typecheck && pnpm test && pnpm format:check` 全绿
- [ ] 新增/修改行为有对应测试（修 bug 的话，先有一个会失败的用例）
- [ ] 若动到帧格式、密钥派生或 nonce 布局：已同步小程序侧的等价实现，并有对拍测试
- [ ] 没有为了让测试通过而放宽某条不变量
