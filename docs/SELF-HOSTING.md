# 自建中继服务部署指南

`apps/server` 是一个零依赖构建的 Node 服务（只需要 `ws`），单进程、纯内存。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DRC_HOST_TOKEN` | ✅ | — | host 出站认证令牌。用 `openssl rand -hex 24` 生成；短于 24 字符会告警 |
| `DRC_PORT` | | `8787` | 监听端口 |
| `DRC_PUBLIC_URL` | | `ws://127.0.0.1:<port>` | `/api/info` 返回的对外地址 |
| `DRC_PAIR_TTL_MS` | | `120000` | 配对码有效期（毫秒）。公网建议调到 60s |
| `DRC_LOG_LEVEL` | | `info` | `debug` / `info` / `warn` / `error` / `silent`。日志是一行一个 JSON |
| `DRC_MAX_MSG_BYTES` | | `262144` | 单帧上限，超过直接断开（ws 1009） |
| `DRC_MAX_CONNS` | | `200` | 并发连接上限，超出返回 1013 |
| `DRC_MAX_FRAMES_PER_SEC` | | `500` | 单连接每秒帧数配额，超出报 `rate_limited` |
| `DRC_MAX_AUTH_ATTEMPTS` | | `5` | 单连接允许的 host 认证失败次数，超出断开（4001） |
| `DRC_MAX_PAIR_ATTEMPTS` | | `5` | 单连接允许的配对码错误次数，超出断开（4008） |
| `DRC_MAX_PAIR_ATTEMPTS_PER_SEC` | | `20` | 全局配对尝试配额，防止分布式暴力枚举 |
| `DRC_MAX_PENDING_PAIRS` | | `1000` | 待配对表上限，防止无界增长 |
| `DRC_PAIR_STATUS` | | 关闭 | 设为 `1` 才启用 `/api/pair-status`（默认关闭，见下） |

没有 `DRC_HOST_TOKEN` 服务会拒绝启动。

### 关于 `/api/pair-status`

**默认关闭。** 它是一个无需认证、直接回答「配对码 N 是否有效」的接口，
等于给了一个扫 6 位码空间的现成 oracle。小程序客户端并不用它（配对走
`pair-begin-client`），所以默认关闭；确需调试时设 `DRC_PAIR_STATUS=1`。

## 直接跑

```sh
cd apps/server
DRC_HOST_TOKEN=$(openssl rand -hex 24) DRC_PORT=8787 node src/main.mjs
```

验证：

```sh
curl http://127.0.0.1:8787/healthz
# {"ok":true,"version":"0.1.0","hosts":0,"clients":0,"conversations":0}
curl http://127.0.0.1:8787/api/info
# {"publicUrl":"ws://127.0.0.1:8787","protocol":1}
```

## HTTPS / WSS 反代

### Caddy（最省事）

```caddyfile
drc.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 自动签发证书，并把 WebSocket 升级透明转发。客户端用
`wss://drc.example.com`。

### nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name drc.example.com;

    ssl_certificate     /etc/letsencrypt/live/drc.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/drc.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $host;
        proxy_set_header X-Forwarded-For $remote_addr;

        # 长连接：别让代理把空闲 ws 掐了
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }
}
```

然后设置 `DRC_PUBLIC_URL=wss://drc.example.com`。

## 常驻

### systemd（Linux）

`/etc/systemd/system/dsh-remote-control.service`：

```ini
[Unit]
Description=DSH Remote Control relay
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/dsh-remote-control/apps/server
Environment=DRC_PORT=8787
Environment=DRC_PUBLIC_URL=wss://drc.example.com
EnvironmentFile=/etc/dsh-remote-control.env   # DRC_HOST_TOKEN=...
ExecStart=/usr/bin/node src/main.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-remote-control
journalctl -u dsh-remote-control -f
```

### launchd（macOS）

`~/Library/LaunchAgents/com.dsh.remote-control.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.remote-control</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/dsh-remote-control/apps/server/src/main.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DRC_PORT</key><string>8787</string>
    <key>DRC_PUBLIC_URL</key><string>wss://drc.example.com</string>
    <key>DRC_HOST_TOKEN</key><string>REPLACE_ME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/dsh-rc-relay.log</string>
  <key>StandardErrorPath</key><string>/tmp/dsh-rc-relay.err</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.dsh.remote-control.plist
```

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY apps/server /app
RUN npm i ws
ENV DRC_PORT=8787
EXPOSE 8787
CMD ["node", "src/main.mjs"]
```

```sh
docker build -t dsh-rc-relay .
docker run -d --name drc -p 8787:8787 \
  -e DRC_HOST_TOKEN=$(openssl rand -hex 24) \
  -e DRC_PUBLIC_URL=wss://drc.example.com \
  dsh-rc-relay
```

## 防火墙与暴露面

- 只需要放行 **一个端口**（默认 8787）。
- 服务同时在这个端口上提供 HTTP（`/healthz`、`/api/info`；`/api/pair-status`
  默认关闭）
  和 WebSocket（path `/`）。把 `/healthz` 暴露给公网是安全的（只返回计数）。
- **不要**把 8787 明文暴露到公网而不挂 TLS——小程序真机不允许 `ws://`。

## 优雅停机

收到 `SIGTERM` / `SIGINT` 后服务会：

1. 停止接受新连接（新连接直接 1013）；
2. 给所有已连接 socket 发 `1001 server_shutdown`；
3. 关闭 HTTP 监听后 **以 0 退出**（超时 5 秒强退）。

这对 systemd / launchd / Docker 的滚动重启是必要的 —— 客户端会立刻收到
关闭帧并重连，而不是等到 TCP 超时。`/healthz` 在停机期间会返回
`shuttingDown: true`，可以拿来做 readiness 探针。

## 日志

一行一个 JSON，便于接入任何日志管道：

```json
{"ts":"2026-10-01T03:24:15.307Z","level":"warn","msg":"host auth failed","attemptsLeft":2,"hostId":"-"}
{"ts":"2026-10-01T03:24:15.412Z","level":"info","msg":"paired","sessionId":"c_9f3c","hostId":"h1","clientId":"wx-1"}
```

建议关注的告警：

| msg | 含义 |
|---|---|
| `host auth failed` | 有客户端拿错 token 在试 |
| `closing socket: too many failed auth attempts` | 疑似 token 暴力破解 |
| `closing socket: too many failed pair attempts` | 疑似配对码暴力破解 |
| `pair claim throttled` | 全局配对配额打满 |
| `host unresponsive, terminating` | 主机心跳超时 |
| `uncaughtException` | 服务异常，进程会退出 1 交给 supervisor 重启 |

## 运维说明

- **无状态、纯内存**：重启后所有配对关系、会话路由丢失。客户端会收到
  `unknown_session` 并提示重新配对，host 会自动重连。这是有意的（缩小泄露面）。
- **心跳**：服务每 5 秒 ping 客户端和 host，两次无 pong 即断开。
- **配对码清理**：每 5 秒清一遍过期或已使用的配对码。
- **host 重连**：同一个 `hostId` 重连会顶掉旧连接，已存在的会话会重新挂到新 socket。
- **host 掉线**：该 host 的会话会被清理（不会留下孤儿会话），客户端收到 `peer-left`。
- **反代层还要做的**：按 IP 限流（中继只做全局 + 单连接配额）、TLS 终止。
