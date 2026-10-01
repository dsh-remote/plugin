# 部署记录与复用步骤

本目录是**实际生产部署**的配置，不是示例。

## 当前部署（2026-10-01）

| 项 | 值 |
|---|---|
| 公网入口 | `wss://drc.provid.cc` |
| ECS | 阿里云 cn-shanghai / `i-uf62gq3vjcvqzi8f9ozj` / `47.100.82.15` / Alibaba Cloud Linux 4 |
| 中继 | `/opt/dsh-remote-control/server`，systemd 单元 `dsh-remote-control.service` |
| 反向代理 | nginx 1.30，`/etc/nginx/conf.d/drc.conf` |
| 证书 | Let's Encrypt（acme.sh + 阿里云 DNS-01），ECC，自动续期 |
| 绑定 | 中继只监听 `127.0.0.1:8787`，公网只暴露 80/443 |
| 密钥 | `/etc/dsh-remote-control.env`（600），同一份 token 写在 macOS 的 `~/.dsh/profiles/desktop/cordis.patch.yml` |

DNS 用的是既有的 `*.provid.cc` 泛解析，所以**没有新增解析记录**。

## 从零复现

### 1. 服务器准备

```sh
dnf install -y nodejs npm nginx          # Alibaba Cloud Linux 4 自带 node 22
mkdir -p /opt/dsh-remote-control/server/src /etc/nginx/ssl
```

### 2. 部署中继

```sh
scp apps/server/src/main.mjs   root@HOST:/opt/dsh-remote-control/server/src/
scp apps/server/package.json   root@HOST:/opt/dsh-remote-control/server/
scp deploy/systemd/*.service   root@HOST:/etc/systemd/system/
ssh root@HOST 'cd /opt/dsh-remote-control/server && npm install --omit=dev'

# token：两端必须一致
cat > /etc/dsh-remote-control.env <<'EOF'
DRC_HOST_TOKEN=<openssl rand -hex 32 的输出>
DRC_PORT=8787
DRC_PUBLIC_URL=wss://drc.provid.cc
DRC_PAIR_TTL_MS=90000
DRC_LOG_LEVEL=info
EOF
chmod 600 /etc/dsh-remote-control.env

systemctl daemon-reload && systemctl enable --now dsh-remote-control
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
./scripts/install-to-profile.sh        # 构建 + 重装 + 注册 bundle
# 然后重启 DSH Harness
```

### 6. 验证

```sh
node scripts/verify-deployment.mjs                        # 自建主机，跑完整闭环
node scripts/verify-deployment.mjs --pair 123456 --qr 'dshr:/p?…'   # 连正在运行的主机
```

## 运维

```sh
systemctl status dsh-remote-control
journalctl -u dsh-remote-control -f          # 一行一个 JSON
journalctl -u dsh-remote-control -p warning  # 只看告警（暴力破解、心跳超时等）
curl -s https://drc.provid.cc/healthz
tail -f /var/log/nginx/drc.access.log
```

改中继代码后：`scp apps/server/src/main.mjs ... && systemctl restart dsh-remote-control`。
中继是纯内存的，重启会丢掉配对关系（客户端会提示重新配对），这是有意为之。

## 安全组

```
TCP  22, 80, 443   0.0.0.0/0   Accept
```

8787 **不要**对公网开放 —— 中继只绑 `127.0.0.1`，nginx 在同一台机器上转发。
