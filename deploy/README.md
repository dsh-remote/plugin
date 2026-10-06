# 部署记录与复用步骤

本目录是**实际生产部署**的配置，不是示例。

## 当前部署（2026-10-02）

| 项 | 值 |
|---|---|
| 公网入口 | `wss://drc.provid.cc` |
| ECS | 阿里云 cn-shanghai / `i-uf62gq3vjcvqzi8f9ozj` / `47.100.82.15` / Alibaba Cloud Linux 4 |
| 中继 | `/opt/dsh-remote-control/server/relay.mjs`（**一个自包含单文件**），systemd 单元 `dsh-remote-control.service` |
| 反向代理 | nginx 1.30，`/etc/nginx/conf.d/drc.conf` |
| 证书 | Let's Encrypt（acme.sh + 阿里云 DNS-01），ECC，自动续期 |
| 绑定 | 中继只监听 `127.0.0.1:8787`，公网只暴露 80/443 |
| 密钥 | `/etc/dsh-remote-control.env`（600），同一份 token 写在 macOS 的 `~/.dsh/profiles/desktop/cordis.patch.yml` |

DNS 用的是既有的 `*.provid.cc` 泛解析，所以**没有新增解析记录**。

**产物形态这一条是这次重写改的**：中继现在部署的是
`pnpm build`（在 `dsh-remote-server/` 仓根）打出来的 `dist/bundle/main.js`
（`ws` 与协议层都内联进去了，`bufferutil`/`utf-8-validate` 是可选原生加速、缺了照常跑）。
于是生产只有"拷一个文件 + 一个 env 文件"，没有 `npm install`，也就没有
"服务器上的依赖树和 CI 不一样"这一类故障。旧文档里的 `scp apps/server/src/main.mjs`
与 `npm install --omit=dev` 都作废了；`ExecStart` 也已改指这个单文件
（旧的 `node src/main.mjs` 指向的是已经不存在的文件）。

## 从零复现

### 1. 服务器准备

```sh
dnf install -y nodejs nginx           # Alibaba Cloud Linux 4 自带 node 22
mkdir -p /opt/dsh-remote-control/server /etc/nginx/ssl
```

### 2. 部署中继

```sh
# 本地先构建产物（在 dsh-remote-server 仓根）
(cd ../dsh-remote-server && pnpm install && pnpm build)

scp ../dsh-remote-server/dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
scp deploy/systemd/*.service        root@HOST:/etc/systemd/system/

# token：两端必须一致
cat > /etc/dsh-remote-control.env <<'EOF'
DRC_HOST_TOKEN=<openssl rand -hex 32 的输出>
DRC_PORT=8787
DRC_PUBLIC_URL=wss://drc.provid.cc
DRC_PAIR_TTL_MS=90000
DRC_LOG_LEVEL=info
# 会话表落盘（1.0.6+，默认关闭即纯内存模式）：配上之后中继重启不再丢配对
# DRC_STATE_FILE=/var/lib/dsh-remote-control/state.json
EOF
chmod 600 /etc/dsh-remote-control.env

systemctl daemon-reload && systemctl enable --now dsh-remote-control
curl -s http://127.0.0.1:8787/healthz      # version 必须是包的 version，不是 0.0.0
```

### 3. DNS 证书（DNS-01，不需要占用 80 端口）

acme.sh 已保存阿里云 DNS 凭证（`~/.acme.sh/account.conf` 里的 `SAVED_Ali_Key/Secret`），
所以换域名只需一条命令：

```sh
/opt/jevtv/acme/acme.sh --issue --dns dns_ali -d drc.provid.cc --server letsencrypt
/opt/jevtv/acme/acme.sh --install-cert -d drc.provid.cc \
  --key-file       /etc/nginx/ssl/drc.provid.cc.key \
  --fullchain-file /etc/nginx/ssl/drc.provid.cc.crt \
  --reloadcmd      "systemctl reload nginx"
```

### 4. nginx

```sh
scp deploy/nginx/drc.conf root@HOST:/etc/nginx/conf.d/drc.conf
ssh root@HOST 'nginx -t && systemctl enable --now nginx'
```

`drc.conf` 里包含**按 IP 限流**（`limit_req` 20r/s、`limit_conn` 8）—— 中继本身
只有全局和单连接配额，看不到真实客户端 IP，所以这一层必须由反代来做。

### 5. 本机插件指向公网

```sh
# ~/.dsh/profiles/desktop/cordis.patch.yml 里
#   serverUrl: wss://drc.provid.cc
#   hostToken: <同一个 token>
./dsh-remote-control/scripts/install-to-profile.sh        # 构建单文件 + 装进 profile + 注册 bundle
# 然后重启 DSH Harness（新代码不会被热加载）
```

安装脚本会**顺手删掉 profile 里旧的 `file:` 依赖**：那条是上一代安装方式留下的，
只要还在，`pnpm install` 就会把插件再物化一份进 profile，于是宿主里同时跑**两个实例**
——两个 hostId、中继里两份会话、手机连到哪个全凭运气（真机排查时被它误导过整整几轮）。

### 6. 验证

```sh
# 本地全链路（真中继进程 + 真 apply() 入口 + 真小程序代码，内核面是 mock）
node e2e/run.mjs

# 真实链路：本机真 Harness + 指定中继（三个真实：真 mp 代码 / 真中继 / 真内核）
DRC_LIVE_RELAY=wss://drc.provid.cc node e2e/live-e2e.mjs
DRC_LIVE_RELAY=wss://drc.provid.cc node e2e/live-e2e.mjs --rounds 3   # 稳定性，每轮一张新码
```

`live-e2e` **拿不到真实配对码就直接失败，绝不退化成 mock 主机**——旧的那个"自建主机"模式
掩盖过一次真故障，所以这条不留后门。配对码来源是插件写在
`~/.dsh/dsh-remote-control/status.json` 的 `pairing`（需要 profile 开 `pairOnStartSec`）。

## 运维

```sh
systemctl status dsh-remote-control
journalctl -u dsh-remote-control -f          # 一行一个 JSON
journalctl -u dsh-remote-control -p warning  # 只看告警（暴力破解、心跳超时、配对配额用尽等）
curl -s https://drc.provid.cc/healthz
tail -f /var/log/nginx/drc.access.log
```

改中继代码后：

```sh
(cd ../dsh-remote-server && pnpm build)
scp ../dsh-remote-server/dist/bundle/main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
ssh root@HOST 'systemctl restart dsh-remote-control'
```

中继默认是纯内存的，未配 `DRC_STATE_FILE` 落盘时重启会丢掉配对关系：客户端拿旧 convId
发帧会撞上 `error{unknown_session}`，手机上就是中文的"会话已失效，请重新配对"。
这条行为有 `e2e/restart-resume.test.mjs` 的 (b) 用例锁住，不是文档里的口头承诺。
生产现在配了 `DRC_STATE_FILE=/var/lib/dsh-remote-control/state.json`（`StateDirectory`
已在 systemd 单元里，`ProtectSystem=strict` 下可写），重启不再丢配对。

## 安全组

```
TCP  22, 80, 443   0.0.0.0/0   Accept
```

8787 **不要**对公网开放 —— 中继只绑 `127.0.0.1`，nginx 在同一台机器上转发。
