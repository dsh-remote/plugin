# 容器部署（Docker / Compose）

生产实例现在跑的就是这一份。形态与裸机（systemd）**同形**：同一个单文件产物、同一套
`DRC_*` 环境变量、同一个 `/healthz`。变的只有"谁负责把它拉起来"。

```sh
# 1. 配置（Compose 自动读本目录的 .env）
cat > deploy/docker/.env <<EOF
DRC_HOST_TOKEN=$(openssl rand -hex 32)     # 与主机插件那份逐字一致
DRC_PUBLIC_URL=wss://drc.provid.cc
DRC_DATA_DIR=/var/lib/dsh-remote-control
DRC_IMAGE_TAG=2.0.15
EOF
chmod 600 deploy/docker/.env

# 2. 状态目录：属主必须是镜像里的非 root 用户 uid 10001
mkdir -p /var/lib/dsh-remote-control && chown 10001:10001 /var/lib/dsh-remote-control

# 3. 起
docker compose -f deploy/docker/compose.yaml up -d --build
```

## 为什么「nginx 一行都不用改」

端口只发布到**宿主机回环**（`127.0.0.1:8787:8787`），所以宿主机上的
`/etc/nginx/conf.d/drc.conf`（`proxy_pass http://127.0.0.1:8787`）原样继续工作，TLS 仍由
nginx 终止。切容器化不动证书、不动反代，只换进程托管方式。

三个必须自己记住的点：

| 项 | 值 | 不这么做会怎样 |
| --- | --- | --- |
| `DRC_BIND` | 镜像里已经是 `0.0.0.0`，compose 里显式写死 | 容器内绑 `127.0.0.1` → `-p` 发布成功但**外面连不上** |
| 端口发布 | `127.0.0.1:8787:8787` | 绑 `0.0.0.0:8787:8787` → 8787 直接暴露公网，绕过 nginx 的按 IP 限流 |
| `/data` 属主 | `10001:10001` | 状态写不进去。2.x 起启动时会直接记一条 `state file is not writable` 的 **error**；1.x 时代只能等第一条 `state file write failed` 的 warn |

## 运维

```sh
docker compose -f deploy/docker/compose.yaml ps         # STATUS 列会显示 healthy
docker compose -f deploy/docker/compose.yaml logs -f relay
docker compose -f deploy/docker/compose.yaml restart    # 优雅停机 → 最多 15s
curl -s http://127.0.0.1:8787/healthz                   # version 必须是包的 version
```

日志是 **docker logs** 而不是 journald，过滤方式因此变了一点：

```sh
docker compose … logs relay | grep '"level":"warn"'     # 按 JSON 里的 level 过滤
docker compose … logs relay | jq 'select(.msg=="counters")'
```

> 别用 `docker logs … | grep ERROR`：中继写到 stdout 的 JSON 不带级别前缀，
> 按 "ERROR" 过滤很可能一条都出不来。按 JSON 里的 `level` 过滤。

`docker logs` 有**条数上限**（每个容器默认保留若干 MB），所以 compose 里配了
json-file 轮转（`max-size: 10m` / `max-file: 5`）。要长期留存就装一个日志驱动转发出去，
别依赖 `docker logs`。

## 升级与回滚

```sh
# 升级：构建 → 重启 → 看版本号变了没有
docker compose -f deploy/docker/compose.yaml up -d --build
curl -s http://127.0.0.1:8787/healthz | grep -o '"version":"[^"]*"'

# 回滚：把标签切回去再 up（镜像还在本地）
docker tag dsh-remote-relay:2.0.14 dsh-remote-relay:2.0.15
docker compose -f deploy/docker/compose.yaml up -d
```

**回滚必须成对**（中继产物 + 主机插件产物）：两代握手帧名不兼容，只回滚一边会
"永远配不上对"或"静默不上线"。见 `../SELF-HOSTING.md` §10.2 的对照表。

## 拉不到 Docker Hub 怎么办

生产那台机器 `registry-1.docker.io` 超时（而 npm registry 通）。三条路，按推荐顺序：

1. **配 daemon 级镜像加速**（一劳永逸，`FROM` 不用改）—— **生产走的就是这条**：

   ```json
   // /etc/docker/daemon.json
   { "registry-mirrors": ["https://6faa0280329c285d57dd15ba1333bdeb.d.1ms.run"] }
   ```
   ```sh
   systemctl daemon-reload && systemctl restart docker
   ```

   > ⚠️ **`daemon.json` 要合并，不能覆盖。** 那台机器上原本已经有三条现网配置
   > （`log-driver` + `log-opts`、`live-restore: true`、`default-address-pools`）。
   > 写坏它会让 **docker 起不来**，而它是那台机器上所有容器的地基。
   > 判据：`tests/docker.test.mjs` 里有「compose 不许覆盖 daemon 级设置」那条。
   >
   > 配完**必须核对 digest**，不能只看「拉下来了」：加速站是第三方，
   > 拉到的内容是不是官方的，靠 `RepoDigests` 说话。
   > ```sh
   > docker image inspect node:22-alpine --format '{{index .RepoDigests 0}}'
   > # node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
   > ```
   > 与直连 Docker Hub 拉到的是**同一个 digest**，才是可信的（2026-10-07 实测）。
   >
   > **加速地址会变**：它是按账号发的，换账号/换机器就是另一个串。
   > 上面那个是 2026-10-07 生产实测可用的那一个；失效时按本文另一条路走。
   ```

2. **本地打标签**：从可达的镜像站拉一份再改名，docker build 就不解析远端了。

   ```sh
   docker pull <mirror>/library/node:22-alpine
   docker tag <mirror>/library/node:22-alpine node:22-alpine
   ```

3. **离线搬运**（生产那次就是这么发的）：在能上网的机器上构建并导出，拷过去导入。

   ```sh
   docker build -f deploy/docker/Dockerfile -t dsh-remote-relay:2.0.15 .
   docker save dsh-remote-relay:2.0.15 | gzip > relay-2.0.15.tar.gz
   scp relay-2.0.15.tar.gz root@HOST:/opt/dsh-remote-control/
   ssh root@HOST 'gunzip -c /opt/dsh-remote-control/relay-2.0.15.tar.gz | docker load'
   ssh root@HOST 'cd /opt/dsh-remote-control/dsh-remote-server && docker compose -f deploy/docker/compose.yaml up -d'
   ```

   > 目标机架构要和构建机一致（或构建时加 `--platform`）。arm64 机器上构建出来的
   > 镜像在 x86_64 上起不来，而这类错误在 `docker compose up` 之前不会报。

## 镜像里没有什么

- **没有 node_modules、没有 npm install**：运行阶段只有 node 与那一个产物文件。
- **没有 curl/wget**：健康检查用 node 自己发请求。
- **没有 bash**：基础镜像是 alpine（用的是 busybox 的 `/bin/sh`，HEALTHCHECK 的 shell
  形式用它）。
- **没有状态文件**：`/data` 是挂进来的卷，且镜像**故意不设 `DRC_STATE_FILE`**——
  落盘路径属于部署形态，与卷由 compose 并排配在一起。

## 与 systemd 并存

`deploy/systemd/dsh-remote-control.service` 仍然保留并可用，两条路共用同一个产物。
**别同时开**（同一个端口只能有一个进程在听）。切回 systemd：

```sh
docker compose -f deploy/docker/compose.yaml down
chown -R root:root /var/lib/dsh-remote-control   # 单元以 root 跑
systemctl enable --now dsh-remote-control
```

### ⚠️ 从 systemd 切过来时，属主要在**停服务之后**改

2026-10-07 第一次切容器时踩了，这个坑值得单独写一节，因为它**静默丢数据**。

`daemon.json` / compose 都不管属主，容器以 uid 10001 跑，于是切换那一步要
`chown -R 10001:10001 /var/lib/dsh-remote-control`。**但那必须放在 `systemctl stop` 之后**：

单元里有 `StateDirectory=dsh-remote-control`，而 systemd 会在**每次停止/启动时**
按单元的 `User=` 把那个目录的属主**改回去**。顺序反了就是：

```
chown 10001  →  systemctl stop（把属主改回 root）
             →  起容器（uid 10001 读一个 root 拥有的 600 文件）
             →  EACCES → state file unreadable, starting empty
             →  30 秒后第一次落盘，把空状态写回去
```

最后那步是**不可逆**的：原来的配对记录被空状态覆盖，`conversations: 0`，
用户必须重新扫码。实测这次就是这样丢了一条会话。

正确顺序：

```sh
systemctl stop dsh-remote-control        # 先停，StateDirectory 就不再改属主
chown -R 10001:10001 /var/lib/dsh-remote-control
chmod 700 /var/lib/dsh-remote-control
docker compose -f deploy/docker/compose.yaml up -d
```

**判据**：切完必看这三样，`stateRestored` 那个最要紧 ——
`stateRestored:0` 而 `conversations:0` 就是"读不到旧状态、被当成空启动"，
此时 `/healthz` 仍然是 `ok:true`，配对表面也正常，只有一处能看出来。

```sh
curl -s 127.0.0.1:8787/healthz | grep -o '"stateRestored":[0-9]*'
docker logs dsh-remote-relay-relay-1 2>&1 | grep -i unreadable   # 必须没有
```

> `read_only: true` + `cap_drop: ALL` 下，容器**写不进** `/data` 时只会在
> `/healthz` 的 `stateWriteFailures` 上体现，而配对表面完全正常 ——
> 与 §0.1 记的那个老坑是同一族，容器只是给它多了一个成因（忘了挂卷 / 属主不对）。
