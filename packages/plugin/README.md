# dsh-remote-control（Host 插件）

跑在 DSH 进程内的 cordis bundle。负责：连接中继、把远程指令桥接到 DSH 内核、
把内核事件推给已配对客户端、以及**防休眠**。

## 安装

```sh
cd ~/.dsh/profiles/desktop
pnpm add -w file:/Users/linbin/dsh-remote-control/packages/plugin
```

然后在 `~/.dsh/profiles/desktop/package.json` 里把 bundle 登记进去：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-remote-control"]
    }
  }
}
```

**重启 Harness 生效**（新增 package 不走 HMR）。

> `cordis.patch.yml` 里条目的 `inject` 列表按 profile 实际提供的服务面填写。
> desktop profile 若没有 `commands` 服务，条目不会激活——此时把 `inject` 改成
> `[]`（`apply()` 内部对所有内核面都是软探测，缺哪个就用 mock 桥接降级）。

## 卸载

```sh
cd ~/.dsh/profiles/desktop
pnpm remove -w dsh-remote-control
# 并从 dsh.profile.bundles 里删掉该条目，重启 Harness
```

## 配置

优先级：**环境变量 > patch 里的 config > 默认值**。

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | — | `true` | 关掉则插件完全不启动 |
| `serverUrl` | `DRC_SERVER_URL` | `ws://127.0.0.1:8787` | 中继地址，公网用 `wss://` |
| `hostToken` / `hostTokenEnv` | `DRC_HOST_TOKEN` | `''` | 与中继共享的令牌；留空则插件只打印警告并保持空闲 |
| `hostLabel` | `DRC_HOST_LABEL` | `dsh-host` | 配对方上显示的名字 |
| `keepAwake.enabled` | — | `true` | 防休眠总开关 |
| `keepAwake.idleReleaseSec` | — | `300` | 空闲多久自动放锁（0 = 一直持有） |
| `keepAwake.keepDisplay` | — | `false` | 是否连屏幕也保持不睡 |
| `mockBridge` | — | `false` | 强制用内存 mock 桥接（调试用） |

最小可用配置：

```sh
export DRC_SERVER_URL=wss://drc.example.com
export DRC_HOST_TOKEN=$(openssl rand -hex 24)
```

`hostToken` 留空时插件**不会**启动 runtime，只在日志里警告一句 —— 这样即使没配
也不会拖慢 Harness 启动。

## 使用

TUI 里（`commands` 服务可用时注册了 `drc` 命令）：

```
drc           # 打印状态：relay / hostId / 客户端数 / keepAwake / 会话数
drc pair      # 生成配对码（默认 120s）
drc pair 300  # 自定义有效期
```

`drc pair` 输出 6 位配对码和二维码文本（`dshr:/p?…`），用小程序扫码 + 输码完成配对。

## 内核挂接

插件**不会**把内核能力变成启动硬依赖。启动顺序：

1. 尝试 `ctx.inject(['typertGateway'])`（rc.1+ / 0.2.x）；
2. 失败则尝试 `ctx.inject(['apiProxy'])`（legacy）；
3. 两个都没有：只在 `mockBridge: true` 时用内存 mock 启动。

启动时日志会打 `carrier=dsh` 或 `carrier=mock`。**看到 `mock` 说明内核没挂上**，
此时会话列表是假的。

⚠️ 真实内核挂接尚未在真机 DSH 上完整验证。已知本机 rc.6 的 `typertGateway`
只有 `invoke({namespace,method,args})`，没有流式事件订阅（`$events` 在 0.1.7+/0.2 才有）；
审批/提问在本机可能走 `apiProxy` 路径。

## 防休眠

只在「会话运行中 / 有审批或提问挂起」时持锁，空闲 `idleReleaseSec` 后自动释放，
本地空闲机器照常睡眠。客户端可以远程开关（`cmd.keep_awake`）。

平台实现见 `packages/protocol/src/keepawake.ts`：macOS `caffeinate -i -s -w <pid>`、
Linux `systemd-inhibit`、Windows 预留。

## 提供给其他插件

`ctx.provide('dshRemoteControl', { state, createPairing, stop })` —— 在支持
`provide` 的代际上可用。

## 开发

```sh
pnpm -r build && pnpm -r test
node e2e/run.mjs          # 真实中继 + HostRuntime(mock bridge) + 模拟小程序
```

读码顺序：`relay-client.ts` → `host-runtime.ts` → `bridge.ts` →
`adapter-dsh.ts`（真实内核）/ `adapter-mock.ts`（测试）→ `index.ts`。
