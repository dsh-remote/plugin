# DSH Remote Control 0.6

在微信里连接 DeepSeek Harness。查看会话和运行进度、发指令、处理宿主审批或提问。控制面经过中继，端到端加密的正文和附件由手机与宿主读取。

0.6.1 修复手机发送指令被宿主拒绝的问题，缩小 Harness 底栏入口，并为小程序增加中文工具名称、可展开的明细和更紧凑的键盘布局。工具参数与输出预览由 0.6.1 宿主插件提供。

0.6.2 修复运行中的会话在小程序里落不进项目分组的问题（宿主读取会话列表时未解开 live 行的 header，工作区路径丢失）。Harness 底栏「远程控制」弹窗改用宿主原生配色令牌，深浅主题一致；点击入口即可开合，点弹窗以外区域自动收起，关闭键移到右上角。

需要 AI 助手帮忙升级插件时，发给它 [0.6 插件升级指南](README.for-ai.md)。里面有 profile 与包名的识别方法、安装命令、重启后的验收项和回退步骤。

## 本地运行

    npm ci
    npm test
    npm run build

需要 Node.js 20 或更高版本。构建产物都在 dist/ 下。

| 产物 | 入口 |
| --- | --- |
| 协议 | dist/protocol，可独立打包的帧校验和加密模块 |
| 中继 | dist/relay/main.cjs，自包含 Node.js 程序 |
| DSH 插件 | dist/plugin，含 Cordis 配置和宿主界面 |
| 微信小程序 | dist/miniprogram，用微信开发者工具导入 |

在开发者工具中编译时，通过 DRC_MP_APPID 传入自己的 AppID。使用本工作区已有的开发身份时，可以从旧项目的 project.config.json 读取 AppID。小程序里的「连接设置」可以填写中继地址，也可以通过构建变量 DRC_SERVER_URL 预填。

    DRC_MP_APPID=<你的微信小程序AppID> npm run build
    npm pack ./dist/plugin

把插件 tarball 作为依赖安装到要使用的 Harness profile，在 dsh.profile.bundles 中登记 @dsh-remote/plugin，并重启 Harness。打开「设置 → 远程控制」生成小程序码。插件默认连接 wss://drc.provid.cc/v06，自托管时可在设置中更改。手机从微信扫一扫或小程序里的「扫码连接」扫描。电脑和手机各显示一串六位核对码，逐位一致后在手机上确认。

0.6 使用自己的本地状态目录 ~/.dsh/dsh-remote-control-v06，以及新的小程序存储键。首次体验请重新配对。

### 演示

「先看演示」提供小程序本地体验。还可以运行 npm run demo，在自动化测试中把终端输出的 scene 注入模拟器扫码回调。默认本地中继为 ws://127.0.0.1:8788。构建模拟器专用包时设置 DRC_MP_LOCAL=1。连接正式中继时使用 wss://。

## 自托管

    DRC_BIND=127.0.0.1 DRC_PORT=8788 DRC_STATE_FILE=/path/to/relay.json DRC_HOST_TOKEN=<主机管理令牌> node dist/relay/main.cjs

中继支持 /healthz、/api/claim-token、/code 和 WebSocket。可在反代上使用 /v06 路径。反代负责 TLS 和 WebSocket Upgrade。如果反代与进程同机，可设置 DRC_TRUST_LOCAL_PROXY=1，并由反代用实际客户端地址覆写 X-Real-IP。此时认领限频按该地址计算。

- DRC_MP_APPID、DRC_MP_SECRET 供中继签发小程序码。DRC_MP_ENV 选择 release、trial 或 develop。
- DRC_MP_APPROVAL_TEMPLATE_ID 配置一次性订阅提醒。留空时产品入口隐藏。
- DRC_MAX_HOST_TOKENS 默认 5000。DRC_HOST_TOKEN_TTL_MS 默认 30 天，按闲置时间在签发时回收。
- DRC_CLAIM_MIN_INTERVAL_MS 默认 4000 毫秒。中继持久化路由、令牌与状态摘要，加密补帧缓冲留在进程内。

构建容器镜像用 docker build -f deploy/Dockerfile -t dsh-remote-relay:0.6.0 .，运行时挂载 /state，并由反代提供公网 TLS。宿主连接问题先查看本机状态目录内的 status.json 和中继的 /healthz。

[需求和用例追踪](docs/requirements.md) · [界面设计](docs/interface.md) · [验证记录](docs/verification.md)

## 审核期间的分发

/v05 保留旧版服务。0.6 插件通过 npm 的 next 标签分发，默认安装继续使用 0.5。deploy/compose.yaml 运行独立的 /v06 中继，回环端口为 8789。deploy/nginx-v06.inc 配置现有 TLS 站点到 /v06 的路由。两套中继共用 AppID 时，0.6 通过微信稳定版凭据接口签码，和 0.5 的凭据独立。小程序审核构建使用 DRC_SERVER_URL=wss://drc.provid.cc/v06。体验期间中继的 DRC_MP_ENV 设为 trial，微信发布正式版后切换为 release。
