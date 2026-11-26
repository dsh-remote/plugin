# DSH Remote Control 0.6 插件升级指南（供 AI 助手执行）

给助手的请求示例

> 按这份指南把我正在用的 DeepSeek Harness 远程控制插件升级到 0.6.0。使用现有 profile 和包名，重启对应的 Harness，验证中继已连接，并告诉我怎么在微信上重新配对。

## 1. 确认升级目标

- 根据实际运行方式定位 Harness profile。浏览器通常用 `web`，桌面 App 通常用 `desktop`。如果启动参数指定了其他 profile，以启动参数为准。两个端都要升级时，各自执行安装和重启。
- 在目标 profile 的 `package.json` 中查看 `dependencies` 和 `dsh.profile.bundles`，再读取对应 `node_modules/<包名>/package.json` 的 `version`。以已有的 `@dsh-remote/plugin` 或 `dsh-remote-control` 为准。两个名字都是发布入口，同一 profile 使用其中一个。记下当前实际版本，供回退使用。发现两个入口同时启用时，先确认 Harness 正在使用哪个。
- 官方 0.6 插件连接 `wss://drc.provid.cc/v06`。审核期间，微信正式版仍通过 `/v05` 服务 0.5 用户。要体验 0.6 扫码，需要对应的小程序开发版或体验版，并重新配对。依赖正式版小程序的用户可以等 0.6 正式发布后再升级。

## 2. 安装并核对版本

以下命令以网页端的 scoped 包为例。桌面端将 `profile` 改为 `desktop`，已有无 scope 包的 profile 将 `package` 改为 `dsh-remote-control`。若 `dsh` 未加入 `PATH`，使用 Harness 安装自带的 CLI 路径。

```sh
profile=web
package=@dsh-remote/plugin
version=0.6.0
npm view "$package" dist-tags --json
npm view "$package@$version" version
dsh plugin --profile "$profile" add --save-exact "$package@$version"
```

审核期间，无版本安装通常解析到 `latest` 上的 0.5。用户要求跟随试用通道时，可先通过 `npm view "$package@next" version` 取得当前试用版，再安装查到的精确版本。

重新读取目标 profile 的 `node_modules/<包名>/package.json`，确认实际版本为指定版本。若版本不符，检查安装输出和 `~/.dsh/profiles/<profile>/.plugin-manager/logs/operation-*/pnpm.log`。如果 `minimumReleaseAge` 阻止安装，遵循 profile 的发布年龄策略，等限制到期后重试。已有可信本地 tarball 且用户允许用它时，可以用同一条 `dsh plugin --profile <profile> add` 命令安装绝对路径，再核对版本。

## 3. 重启、连通、扫码

1. 完全退出并重启目标 Harness 进程。网页端再刷新浏览器页面，重新加载插件界面。
2. 在「设置 → 远程控制」确认已连接。官方中继的健康检查为 `curl -fsS https://drc.provid.cc/v06/healthz`，返回 `version` 应为 `0.6.0`。插件默认状态文件是 `~/.dsh/dsh-remote-control-v06/status.json`，应有新的写入时间，且 `version` 为 `0.6.0`、`relay` 为 `online`、`serverUrl` 为目标中继。状态目录可被 `stateDir` 或 `DRC_STATE_DIR` 覆盖。
3. 如未连接，核对实际中继地址。其优先级是 Harness 插件配置里的 `serverUrl`、0.6 设置页保存的地址、宿主进程环境 `DRC_SERVER_URL`、官方默认地址。自建中继用用户指定的地址。插件在官方中继正常自动认领令牌，旧环境留下的 `DRC_HOST_TOKEN` 和手填令牌也应纳入排查。汇报时只摘取版本、连接状态和错误信息，凭据与配对材料留在本机。
4. 在宿主设置页生成小程序码，用户用对应版本的微信小程序扫描，逐位比对手机与宿主显示的六位核对码，在手机上确认。配对成功后，在手机打开一条会话，确认能同步列表并收到回复。助手无法操作手机时，将这一步交给用户，并在结果里注明手机端待确认。

## 4. 回退

使用先前记下的版本运行 `dsh plugin --profile "$profile" add --save-exact "$package@$previous_version"`，完全重启对应的 Harness，网页端再刷新页面。恢复原有的中继配置，核对重新安装的版本和连接状态。0.5 与 0.6 使用独立的本地状态目录，保留两个目录可让各自的配对继续使用。回退后用 0.5 小程序验收。
