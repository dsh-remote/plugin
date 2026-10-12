# Security Policy

## 报告漏洞

用本仓 GitHub 的私密渠道：**Security → Report a vulnerability**（`/security/advisories/new`）。
不要在公开 issue 里贴可利用细节。

## 本仓的范围

- 负责：配对与密钥簿落盘（0600）、中继客户端、审批 / 提问的桥接、
  **七条**同域路由的同源判据（改状态的**三条**要带自定义头：发码 / 解配 / 写配置；
  其余四条只读档仍要求 Host 环回）、
  `status.json` 的凭据卫生。
  ⚠️ 第六条 `/miniprogram.jpg` 发的是**包内静态图**（谁拿到都只能打开官方小程序，
  它不是凭据、也不是任何配对信息）；带 PSK 的是 `/pairing.png` 那一条，`no-store`。
  第七条 `GET|POST /config`（2026-10-11 加）读回生效配置与来源、写自部署地址 / 口令：
  GET 只给脱敏形态（绝不回 token 真值），POST 属于上面那三条写路由之一。
- 不负责：中继侧限流与路由（见 relay 包）；协议字节格式（见 protocol 包）。

## 设计边界

- 审批只有参与宿主 waterfall `approval/request` 才能到达手机——这是一条机制，
  不是 UI 约定（`approval/asked|decided` 是审计事件，不能应答）。
- 状态快照序列化后不得包含 `hostToken` / PSK（有判据）；落盘文件一律 0600。
- 配对的唯一入口是状态栏 pill；`/drc` 命令与右栏自动弹码已整条删除。
