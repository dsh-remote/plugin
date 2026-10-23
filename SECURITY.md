# Security Policy

## 报告漏洞

用本仓 GitHub 的私密渠道：**Security → Report a vulnerability**（`/security/advisories/new`）。
不要在公开 issue 里贴可利用细节。

## 本仓的范围

- 负责：配对与密钥簿落盘（0600）、中继客户端、审批 / 提问的桥接、
  **七条**同域路由的同源判据（改状态的**三条**要带自定义头：发码 / 解配 / 写配置 / 放行；
  其余只读档仍要求 Host 环回）、`status.json` 的凭据卫生。
  ⚠️ 3.2 起 `/pairing.png` 只发**中继签发的小程序码**（JPEG，`no-store`）：码里只有 6 位配对码，
  没有任何密钥；密钥由主机在用户比对两端数字后加密送回。原来那张"包内静态入口码"
  （`/miniprogram.jpg`）已随旧二维码一起删除。
  `GET|POST /config`（2026-10-11 加）读回生效配置与来源、写自部署地址 / 口令：
  GET 只给脱敏形态（绝不回 token 真值），POST 与发码同属写路由。
- 不负责：中继侧限流与路由（见 relay 包）；协议字节格式（见 protocol 包）。

## 设计边界

- 审批只有参与宿主 waterfall `approval/request` 才能到达手机——这是一条机制，
  不是 UI 约定（`approval/asked|decided` 是审计事件，不能应答）。
- 状态快照序列化后不得包含 `hostToken` / PSK（有判据）；落盘文件一律 0600。
- 配对的唯一入口是状态栏 pill；`/drc` 命令与右栏自动弹码已整条删除。
