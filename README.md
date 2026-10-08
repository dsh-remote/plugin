# @dsh-remote/plugin

DSH Remote Control 的**宿主侧插件**：跑在 DeepSeek Harness 进程里，负责配对、中继连接、
会话与命令桥接，并在状态栏挂一颗 pill——**配对的唯一入口**（发码 / 二维码 / 状态 / 解配
四条同域路由）。界面那一半（浏览器面 `client.cjs`）折在同一个包里。

## 安装（装进 DSH profile）

```sh
sh scripts/install-to-profile.sh              # 默认 ~/.dsh/profiles/desktop
DSH_PROFILE=~/.dsh/profiles/tui sh scripts/install-to-profile.sh
```

装的是**两个自包含单文件产物**（`dist/bundle/index.js` + `dist/bundle/client.cjs`），
profile 里不需要 node_modules。装完**必须重启 Harness**（新代码不会被热加载；
浏览器面还要重新加载页面）。

## 开发

```sh
pnpm install
pnpm build        # tsc ×2 + esbuild 打两半
pnpm test
```

## 排错第一入口

```sh
cat ~/.dsh/dsh-remote-control/status.json
```

四个关键字段：`relay`（online / connecting / offline）、`relayProblem`、`carrier`
（services=真内核 / mock=内存替身 / none）、`pill`（路由软探测结果）。
目录名沿用历史 id `dsh-remote-control`，是**有意的稳定标识**（路由前缀、数据目录同理）。

## 红线

- 审批只有参与宿主 waterfall `approval/request` 才能到达手机；没有手机在线时
  `participate()` 调 `next()` **交还桌面**。
- 凭据文件一律 0600；`status.json` 序列化后不得含 hostToken / PSK（有判据锁住）。
- `/drc` 命令与右栏自动弹码已整条删除——配对入口只有那颗 pill。

## 许可

MIT
