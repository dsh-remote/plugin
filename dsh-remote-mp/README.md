# dsh-remote-mp

[![CI](https://github.com/providcc/dsh-remote-mp/actions/workflows/ci.yml/badge.svg)](https://github.com/providcc/dsh-remote-mp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**DSH Remote Control** 的客户端——原生微信小程序。扫码配对一台正在跑 DeepSeek Harness 的桌面主机，
然后在手机上**发指令、看流式输出、回答审批**。载荷级端到端加密：中继看不到任何明文。

> **状态：前端仍在改造中。** 本仓当前是小程序源码的一份**快照**（自开发仓 `mp/` 抽取）。
> 界面与交互还在迭代，目录与接口可能随改造调整；功能链路本身（配对、指令、流式、审批）是通的。

三半在各自仓库：本仓（客户端）、[`dsh-remote-control`](https://github.com/providcc/dsh-remote-control)（宿主插件）、
[`dsh-remote-server`](https://github.com/providcc/dsh-remote-server)（零知识中继）；
三者共用 [`dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol)（线协议）。

```
┌──────────────────┐  wss + host token   ┌────────────────┐  wss + 配对码   ┌────────────────┐
│  DSH 桌面主机      │ ─────────────────▶ │  relay server  │ ◀────────────── │ 微信小程序客户端  │
│  (host plugin)   │   只见密文与 6 位码   │                │                 │  (本仓)         │
└──────────────────┘                     └────────────────┘                 └────────────────┘
```

## 目录

```
dsh-remote-mp/
├── project.config.json        微信开发者工具的项目配置（miniprogramRoot 指向 miniprogram/）
├── package.json               TDesign 依赖 + 自检脚本（**不打进小程序包**）
├── miniprogram/               小程序源码 = 开发者工具里的"小程序根"
│   ├── app.js / app.json / app.wxss    全局：DrcClient 单例 + TDesign 主题变量
│   ├── sitemap.json
│   ├── theme/                 light.wxss / dark.wxss（生成物，勿手改）
│   ├── core/
│   │   ├── vendor/            vendored tweetnacl（已打小程序补丁）与 js-base64
│   │   ├── codec.js           线格式编解码：KDF / seal / open / 计数器 nonce / QR 解析
│   │   ├── env.js             运行环境能力探测
│   │   ├── socket.js          wx.connectSocket 封装：双路径 + 超时 + 指数退避重连
│   │   ├── session-store.js   本地持久化（PSK / 会话 id / nonce 计数器）
│   │   ├── theme.js           主题切换（class + 导航栏 + 回弹区）
│   │   └── client.js          DrcClient：握手、配对、指令、事件分发
│   ├── pages/
│   │   ├── sessions/          入口页：未配对时就地扫码配对；已配对是主机状态 + 会话列表
│   │   └── chat/              对话：文档流 + 流式正文 + 审批卡 / 提问卡 / 中断
│   └── miniprogram_npm/       按依赖闭包裁剪过的 TDesign 预构建产物（**无需在工具里构建 npm**）
├── docs/ARCHITECTURE.md       设计说明：主题、块流、历史加载、握手、配色
└── scripts/                   Node 侧静态与生成脚本（都不需要微信开发者工具）
    ├── verify-miniprogram.mjs      路径 / JSON / 组件引用 / 语法自检
    ├── gen-mp-theme.mjs            生成 theme/*.wxss（`--check` 做同步比对）
    └── check-mp-contrast.mjs       算真实前景/背景对比度，按 WCAG 判阈值
```

**只有两页。** 配对曾经是独立的 `pages/pair/`，后来按「首页直接扫码」删掉了——配对是打开 app
最可能做的事，多一次跳转就多一次"我到底该去哪"。扫码/粘贴/6 位码/环境自检全部内联在 `sessions` 页。

设计取舍（为什么这么切、踩过哪些坑）见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 用微信开发者工具打开

1. 微信开发者工具 → **导入项目** → 目录选**本仓根目录**（`project.config.json` 所在处）。
2. **appid**：`project.config.json` 里的 `appid` 是本项目自用的；
   要跑自己的，改成你的 appid。真机还需要在微信后台的
   `开发管理 → 开发设置 → 服务器域名 → socket合法域名` 里加上你的中继域名
   （必须是已备案域名 + 有效证书，且只能用 `wss://`）。
3. **详情 → 本地设置** → 勾选「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」
   （开发期连 `ws://127.0.0.1:8787` 必需）。
4. 主机侧先在 DSH 里执行 `/drc pair`，手机上扫码即连。

`miniprogram_npm/tdesign-miniprogram` 是按依赖闭包裁剪过的预构建产物，**不要**在工具里点"构建 npm"。
升级 TDesign 的做法见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 开发期自检

小程序代码可以在 Node 里被真实驱动，也可以只做静态自检。本仓带三条**不需要开发者工具**的检查：

```sh
npm run check          # = verify + theme:check + contrast，CI 跑的就是它

node scripts/verify-miniprogram.mjs   # JSON / 页面四件套 / 组件引用 / 自研 JS 语法 / 按需注入前提
node scripts/gen-mp-theme.mjs --check # theme/*.wxss 是否还与 TDesign 同步（生成物，勿手改）
node scripts/check-mp-contrast.mjs    # 两套变量表展开后的前景/背景对比度是否全部达标（WCAG）
```

改主题/改配色时：`npm run theme` 重新生成，`npm run contrast` 看对比度是否仍达标。
**改任何颜色前先跑对比度**——TDesign 的深色值在手机小屏上有多处不达标，靠看截图看不出来。

真正的编译与真机行为只有微信开发者工具能验。**端到端测试、真机交互探针与截图脚本留在开发仓**
（它们需要中继、宿主插件与 `e2e/` 的运行环境），不在本仓重复一套。

## 安全

客户端只持有：配对时从二维码拿到的 **PSK**、由此派生的会话密钥，以及本机的存储。
它**不持有**中继的 host token。凭据不进日志、不上报。

报告漏洞的流程见 [`SECURITY.md`](./SECURITY.md)。**请不要为安全报告开公开 issue。**

## 许可

[MIT](./LICENSE) © providcc
