# Changelog

## 3.0.0（开发中）

- v3：四端合并进 `dsh-remote-v3` 单仓开发；包名由 `dsh-remote-control` 迁到 **`@dsh-remote/plugin`**，
  仓库改到 [`dsh-remote/dsh-remote-plugin`](https://github.com/dsh-remote/dsh-remote-plugin)。
  运行时标识 `dsh-remote-control` **保持不变**（路由前缀、数据目录、profile 安装名）——那是有意的稳定标识。
- **PathsPort**（`src/platform/paths.ts`）：绝对路径判定 / 数据目录派生 / 工作区形状判定收成一处。
  修 v2 三处分叉——`config.ts` 两条 `startsWith('/')` 在 Windows 上把 `C:\` 路径**静默改道**；
  校验把正确的 `C:\` 配置报成「必须是绝对路径」；`carrier-services` 只收 POSIX 形态。
  判定带 `platform` 参数 ⇒ **在 macOS 上就能验 win32 行为**（15 形态 × 3 平台表驱动）。
- **SecureFilePort**（`src/platform/secure-file.ts`）：5 处 0600 落盘收敛为一处；补上 v2 只在 relay
  做了的「清同 pid 残留」；win32 上 `chmod` 只切只读位 ⇒ **显式 warn 一次**而不是假装生效；
  `safeFileName` 补 Windows 保留名（`CON` / `con.txt`）——此前会让**整批附件回滚**。
- **审批「本次会话内始终允许」**（§9.1）：查表放在挂 waterfall **之前**（放在之后就只是记账），
  键取「会话 + 类别」，随 `stop()` 清空。直接服务 30 秒原则。
- **浏览器半** `client/src` → `src/client`（消除第二个源码根），两个编译面各自自包含。
- **配对地址只有一处事实源**：二维码 `s=` 逐字等于 `serverUrl`（判据），小程序侧没有手填入口；
  死文案「请先扫码或**填写**中继服务地址」清零。
- **设计语义映射**（`docs/DESIGN-TOKENS.md`）：pill 的 7 个 fallback 色值从 CSS 里 18 处字面量
  收成一处（顺带修掉一个没人报的不一致：`label-secondary` 原来有两个兜底值）。
- 脚本去 shell 化：`install-to-profile.sh` → `.mjs`（`lastIndexOf('/')` 在 Windows 上得 -1，
  会把备份写到当前目录，而那文件带 hostToken）。
- 判据 524 → 562。

2.0.21 及更早的完整历史见旧仓 [`providcc/dsh-remote-control`](https://github.com/providcc/dsh-remote-control) 的 CHANGELOG。
