<!--
标题用祈使句，例如：fix: keep the scroll anchor on two static ids
-->

## What & why

<!-- 这个改动解决了什么问题？为什么用这个做法？ -->

## How was it verified?

<!-- 跑了 npm run verify 吗？在微信开发者工具里怎么验的（截图/现象）？ -->

## Checklist

- [ ] `npm run verify` 全绿
- [ ] **在微信开发者工具里看过效果**（编译不报错 ≠ 界面对；本仓多处失效是静默的）
- [ ] 截图/日志里**没有**真实配对 payload 或 PSK（贴出的一律是 `fake-…`）
- [ ] 未手改 `miniprogram/theme/*.wxss`（生成物）与 `miniprogram_npm/`（第三方产物）
- [ ] 未破坏按需注入的前提（`app.json` 无全局 `usingComponents`）
