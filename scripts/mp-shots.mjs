#!/usr/bin/env node
/**
 * 抓微信开发者工具模拟器的渲染结果，落成 PNG。
 *
 * 为什么需要它：小程序的样式问题（组件没声明、input 高度塌陷、文字被裁）
 * `cli preview` 编译期一律不报错，只有真机/模拟器才看得见。有了这个脚本，
 * 改完界面自己就能看到结果，不必每次都走「让用户扫码 → 用户反馈」。
 *
 * ── 前置：自动化端口不是常开的 ─────────────────────────────────────────
 * 需要 IDE 以自动化模式启动：
 *   /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
 *     --project "$(pwd)/mp" --trust-project --auto-port 9420
 * 端口通不通，一条命令验证（返回 "Upgrade Required" 就是通的）：
 *   curl -s --max-time 3 http://127.0.0.1:9420/json/version
 * 若 IDE 本来开着，先 `cli quit` 再起，否则端口不会监听。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node scripts/mp-shots.mjs                  # 三页 + pair 的三个交互态
 *   node scripts/mp-shots.mjs --pages pair     # 只截指定页（逗号分隔）
 *   node scripts/mp-shots.mjs --out /tmp/shots
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MP_DIR = path.join(ROOT, 'mp')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const PORT = Number(flag('port', process.env.MP_AUTO_PORT || 9420))
const OUT = path.resolve(flag('out', path.join(ROOT, '.tmp', 'mp-shots')))
const ONLY = flag('pages', '').split(',').map((s) => s.trim()).filter(Boolean)

/** 依赖不装在项目里（避免给生产 workspace 加负担），按顺序找 */
function resolveAutomator() {
  const candidates = [
    'miniprogram-automator',
    path.join(ROOT, 'node_modules/miniprogram-automator'),
    path.join(ROOT, 'e2e/node_modules/miniprogram-automator'),
    // 本机全局 workspace 里的副本
    path.join(
      process.env.HOME || '',
      '.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator',
    ),
  ]
  for (const c of candidates) {
    try {
      return require(c)
    } catch {
      /* 继续找下一个 */
    }
  }
  return null
}

/** 端口开着的话，HTTP 请求会被要求 Upgrade 到 WebSocket（426） */
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: 2500 },
      (res) => {
        res.resume()
        resolve(res.statusCode === 426 || res.statusCode === 101 || res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** 一页可能有多个状态要留档（默认态 / 展开态 / 有输入态） */
const SHOTS = {
  sessions: [
    { name: 'sessions', url: '/pages/sessions/sessions' },
    {
      // 已配对 + 零会话：t-empty 走的是「用时注入」，首个渲染帧是占位组件。
      // 拍早一点，确认占位阶段布局不崩（empty 在主包内，注入是毫秒级，真机几乎看不见）。
      name: 'sessions-empty-early',
      url: '/pages/sessions/sessions',
      wait: 120,
      data: {
        paired: true,
        sessions: [],
        hostLabel: 'Linbin 的 MacBook',
        statusLabel: '在线',
        statusTheme: 'success',
        statusText: '已连接到主机',
        keepAwakeOn: true,
        keepAwakeText: '当前持锁中 · caffeinate',
      },
    },
    {
      // 同一状态，等注入完成：占位必须被替换回真正的 t-empty
      name: 'sessions-empty',
      url: '/pages/sessions/sessions',
      wait: 1600,
      data: {
        paired: true,
        sessions: [],
        hostLabel: 'Linbin 的 MacBook',
        statusLabel: '在线',
        statusTheme: 'success',
        statusText: '已连接到主机',
        keepAwakeOn: true,
        keepAwakeText: '当前持锁中 · caffeinate',
      },
    },
    {
      // 已配对 + 有会话：验证归档被过滤后底部那句说明还在
      name: 'sessions-list',
      url: '/pages/sessions/sessions',
      data: {
        paired: true,
        hiddenArchived: 2,
        hiddenText: '已隐藏 2 个归档会话',
        hostLabel: 'Linbin 的 MacBook',
        statusLabel: '在线',
        statusTheme: 'success',
        statusText: '已连接到主机',
        keepAwakeOn: true,
        keepAwakeText: '当前持锁中 · caffeinate',
        sessions: [
          {
            id: 's-1',
            title: '重做小程序对话页信息流',
            workspace: '/Users/linbin/dsh-remote-control',
            badgeText: '运行中',
            badgeTheme: 'primary',
            running: true,
            updatedAt: '16:04',
          },
          {
            id: 's-2',
            title: '排查 t-input 真机塌陷',
            workspace: '/Users/linbin/dsh-remote-control',
            badgeText: '待审批',
            badgeTheme: 'warning',
            running: false,
            updatedAt: '昨天 22:41',
          },
          {
            id: 's-3',
            title: '更新 HANDOFF 测试计数',
            workspace: '/Users/linbin/dsh-remote-control',
            badgeText: '空闲',
            badgeTheme: 'default',
            running: false,
            updatedAt: '09-28',
          },
        ],
      },
    },
  ],
  /**
   * 深色主题。单独成一组而不是给每个场景加 dark 变体：深色要验的是**整套变量
   * 有没有铺满**，三页各来一张就够（同页的浅/深对比可以自己去比）。
   *
   * `theme` 走的是真实路径：写 storage → reLaunch → onLoad 里 theme.applyTo 读出来
   * → 根容器挂 class。直接 setData 塞 themeClass 会绕过整条链，恰好漏掉"存储读不到"
   * 这类真会发生的故障。
   */
  dark: [
    {
      name: 'dark-sessions',
      url: '/pages/sessions/sessions',
      theme: 'dark',
      data: {
        paired: true,
        hiddenArchived: 2,
        hiddenText: '已隐藏 2 个归档会话',
        hostLabel: 'Linbin 的 MacBook',
        statusLabel: '在线',
        statusTheme: 'success',
        statusText: '已连接到主机',
        keepAwakeOn: true,
        keepAwakeText: '当前持锁中 · caffeinate',
        sessions: [
          {
            id: 's-1',
            title: '重做小程序对话页信息流',
            workspace: '/Users/linbin/dsh-remote-control',
            badgeText: '运行中',
            badgeTheme: 'primary',
            running: true,
            updatedAt: '16:04',
          },
          {
            id: 's-2',
            title: '排查 t-input 真机塌陷',
            workspace: '/Users/linbin/dsh-remote-control',
            badgeText: '待审批',
            badgeTheme: 'warning',
            running: false,
            updatedAt: '昨天 22:41',
          },
          {
            id: 's-3',
            title: '更新 HANDOFF 测试计数',
            workspace: '/Users/linbin/dsh-remote-control',
            badgeText: '空闲',
            badgeTheme: 'default',
            running: false,
            updatedAt: '09-28',
          },
        ],
      },
    },
    {
      name: 'dark-pair',
      url: '/pages/pair/pair',
      theme: 'dark',
      data: { server: 'wss://drc.provid.cc', hostLabel: 'Linbin 的 MacBook' },
    },
    {
      // 深色下的 chat 页**有内容**：用户气泡、助手正文、展开的过程组、输入区四处
      // 是最容易露出浅色块的地方（气泡底色、卡片底色、过程卡描边各是一套变量）。
      // 空态那张（dark-chat）只验到底色铺满，验不了这些。
      name: 'dark-chat',
      url: '/pages/chat/chat',
      theme: 'dark',
      data: {
        title: '重做小程序对话页信息流',
        running: true,
        barText: '主机运行中',
        barTheme: 'primary',
        foldable: 1,
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '21:20' },
          { key: 'u1', kind: 'user', text: '把两个测试失败查清楚', confirmed: true },
          {
            key: 'x1',
            kind: 'steps',
            closed: false,
            open: true,
            live: true,
            tools: 3,
            label: '正在执行 3 个步骤',
            tailId: 'sk3',
            items: [
              { key: 'k1', type: 'think', msText: '1.2s', done: true },
              {
                key: 't1',
                type: 'tool',
                phase: 'completed',
                tool: 'Bash',
                title: 'pnpm -C e2e test',
                args: '{"command":"pnpm -C e2e test"}',
                result: '2 项失败',
                preview: '2 项失败',
                open: false,
              },
              {
                key: 't2',
                type: 'tool',
                phase: 'running',
                tool: 'Read',
                title: 'e2e/mp-client.test.mjs',
                result: '',
                preview: '',
                open: false,
              },
            ],
          },
          {
            key: 'm1',
            kind: 'text',
            text: '两条都指向同一个原因：断言在断言之后又清了一次表，回执到不了。改掉就行。',
            done: true,
          },
          { key: 'n1', kind: 'note', text: '已批准一次工具调用' },
        ],
      },
    },
    {
      // 浅色基准（同一类内容），用来一眼比出哪些地方没跟着变
      name: 'light-chat-baseline',
      url: '/pages/chat/chat',
      theme: 'light',
      data: { title: '重做小程序对话页信息流' },
    },
  ],
  pair: [
    { name: 'pair', url: '/pages/pair/pair' },
    {
      name: 'pair-adv',
      url: '/pages/pair/pair',
      data: {
        showAdvanced: true,
        pasteText: 'dshr:/p?eyJ2IjoxLCJzZXJ2ZXIiOiJ3c3M6Ly9kcmMucHJvdmlkLmNjIn0',
      },
    },
    { name: 'pair-code', url: '/pages/pair/pair', data: { token: '042391' } },
    {
      // 已配对态：本地很难真连上主机，用 data 直接摆出渲染分支（与真实路径同一套 wxml）
      name: 'pair-online',
      url: '/pages/pair/pair',
      data: {
        online: true,
        status: 'online',
        statusLabel: '已配对',
        statusTheme: 'success',
        statusText: '已连接到主机，可以下发指令',
        hostLabel: 'Linbin 的 MacBook',
        hasPsk: true,
      },
    },
  ],
  chat: [
    { name: 'chat', url: '/pages/chat/chat' },
    {
      // 运行中的一轮，且步骤组**很长**（6 步工具）。
      // 这是专门用来验「过程窗口限高」的：展开后不该把下面的正文顶出屏幕 ——
      // 截图里正文必须还露在窗口下面，否则限高就没生效。
      // 展示字段（label/tools/live/tailId）要自己写 —— 走 setData 摆状态时不会经过
      // _commit，页面里那层派生逻辑跑不到。
      name: 'chat-live',
      url: '/pages/chat/chat',
      data: {
        running: true,
        barText: '主机运行中',
        barTheme: 'primary',
        foldable: 1,
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '15:02' },
          { key: 'u1', kind: 'user', text: '把 mp-client 那两项失败查清楚', confirmed: true },
          {
            key: 'x1',
            kind: 'steps',
            closed: false,
            open: true, // 实时新组默认展开 —— 收起的一行会让人以为没有工具列表
            live: true,
            tools: 6,
            label: '正在执行 6 个步骤',
            tailId: 'sk7', // 组内自动滚到这一条（setData 摆状态时得手写）
            items: [
              { key: 'k1', type: 'think', msText: '1.2s', done: true },
              {
                key: 't1',
                type: 'tool',
                phase: 'completed',
                tool: 'Bash',
                title: 'git status --short',
                args: '{"command":"git status --short"}',
                result: 'M mp/pages/chat/chat.js',
                preview: 'M mp/pages/chat/chat.js',
                open: false,
              },
              { key: 'k2', type: 'think', msText: '0.8s', done: true },
              {
                key: 't2',
                type: 'tool',
                phase: 'completed',
                tool: 'Read',
                title: 'e2e/mp-client.test.mjs',
                result: '13 项，其中 2 项失败',
                preview: '13 项，其中 2 项失败',
                open: false,
              },
              { key: 'k3', type: 'think', msText: '2.1s', done: true },
              {
                key: 't3',
                type: 'tool',
                phase: 'completed',
                tool: 'Bash',
                title: 'node --test e2e/mp-client.test.mjs',
                args: '{"command":"node --test e2e/mp-client.test.mjs"}',
                result: 'e2e/mp-client.test.mjs — 2 项失败',
                preview: 'e2e/mp-client.test.mjs — 2 项失败',
                open: false,
              },
              { key: 'k4', type: 'think', msText: '3.4s', done: true },
              {
                key: 't4',
                type: 'tool',
                phase: 'completed',
                tool: 'Grep',
                title: 'settleHistory',
                result: 'mp/core/client.js:404 / 412',
                preview: 'mp/core/client.js:404 / 412',
                open: false,
              },
              { key: 'k5', type: 'think', msText: '1.7s', done: true },
              {
                key: 't5',
                type: 'tool',
                phase: 'completed',
                tool: 'Edit',
                title: 'mp/core/client.js',
                result: '已更新 1 个文件',
                preview: '已更新 1 个文件',
                open: false,
              },
              { key: 'k6', type: 'think', msText: '0.9s', done: true },
              {
                key: 't6',
                type: 'tool',
                phase: 'started',
                tool: 'Bash',
                title: 'pnpm -C e2e test',
                args: '{"command":"pnpm -C e2e test"}',
                preview: '',
                open: false,
              },
              { key: 'k7', type: 'think', msText: '', done: false },
            ],
          },
          {
            key: 'm1',
            kind: 'text',
            text: '工作区有 2 处未提交改动，都在 mp 端。mp-client 那两项失败我定位到结算点了，正在重跑。',
            done: false,
          },
        ],
      },
    },
    {
      // 浮标态：用户往上回看过 → 「回到最新」浮在输入区上方。
      // 它**点下去真的会滚**这件事由 e2e/mp-chat-blocks.test.mjs 的锚点结构断言守着
      // （两个静态 id，不许再写成 id="{{toView}}"）；截图只管它长得对不对。
      name: 'chat-jump',
      url: '/pages/chat/chat',
      data: {
        running: false,
        barText: '空闲',
        barTheme: 'success',
        atBottom: false,
        historyState: 'ok',
        hasMore: true,
        turn: 2,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '14:37' },
          { key: 'u1', kind: 'user', text: '数一下各套测试的用例数', confirmed: true },
          {
            key: 'x1',
            kind: 'steps',
            closed: true,
            open: false,
            live: false,
            tools: 2,
            label: '已完成 2 个步骤',
            tailId: '',
            items: [
              { key: 'k1', type: 'think', msText: '3.2s', done: true },
              {
                key: 't1',
                type: 'tool',
                phase: 'completed',
                tool: 'Bash',
                title: 'grep -c "^test(" e2e/*.test.mjs',
                result: 'mp-crypto:11 mp-client:11',
                preview: 'mp-crypto:11 mp-client:11',
                open: false,
              },
            ],
          },
          {
            key: 'm1',
            kind: 'text',
            text: '数完了，已经写进 HANDOFF。',
            done: true,
          },
        ],
      },
    },
    {
      // 步骤组展开、其中一步再展开：这就是「窗口管理」的样子
      name: 'chat-steps',
      url: '/pages/chat/chat',
      data: {
        running: false,
        barText: '空闲',
        barTheme: 'success',
        foldable: 1,
        expanded: true,
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '14:37' },
          { key: 'u1', kind: 'user', text: '把 HANDOFF 里的测试计数更新一下', confirmed: true },
          {
            key: 'x1',
            kind: 'steps',
            closed: true,
            open: true,
            live: false,
            tools: 2,
            label: '已完成 2 个步骤',
            items: [
              { key: 'k1', type: 'think', msText: '3.2s', done: true },
              {
                key: 't1',
                type: 'tool',
                phase: 'completed',
                tool: 'Bash',
                title: 'grep -c "^test(" e2e/*.test.mjs',
                args: '{"command":"grep -c \\"^test(\\" e2e/*.test.mjs"}',
                result: 'mp-crypto.test.mjs:11\nmp-client.test.mjs:11\nmp-platform.test.mjs:3',
                preview: 'mp-crypto.test.mjs:11 mp-client.test.mjs:11 mp-platform.test.mjs:3',
                open: true,
              },
              {
                key: 't2',
                type: 'tool',
                phase: 'completed',
                tool: 'Read',
                title: 'HANDOFF.md',
                result: '…mp-crypto 11、mp-client 11、mp-platform 3…',
                preview: '…mp-crypto 11、mp-client 11、mp-platform 3…',
                open: false,
              },
            ],
          },
          {
            key: 'm1',
            kind: 'text',
            text: '数完了：mp-crypto 11、mp-client 11、mp-platform 3，已经把 HANDOFF 里的旧数字改掉。',
            done: true,
          },
          { key: 'n1', kind: 'note', text: '…已省略较早的 12 个片段（仅保留最近 400 个）' },
        ],
      },
    },
    {
      // 审批面板：白主题下也要看一遍（它和输入区一起压在页面底部）
      name: 'chat-approve',
      url: '/pages/chat/chat',
      data: {
        running: false,
        barText: '待审批',
        barTheme: 'warning',
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '16:20' },
          { key: 'u1', kind: 'user', text: '把构建产物清掉重来一遍', confirmed: true },
          { key: 'm1', kind: 'text', text: '要跑 rm -rf packages/plugin/dist，这一步需要你确认。', done: true },
        ],
        pendingPermission: {
          requestId: 'p1',
          action: 'Bash',
          resource: 'rm -rf packages/plugin/dist',
          reason: '删除构建产物以便重新构建，会丢失未提交的 dist 改动',
          options: [
            { id: 'approve', label: '允许' },
            { id: 'reject', label: '拒绝' },
          ],
        },
      },
    },
    {
      // 历史：打开一条会话时读主机上已有的内容。顶部那一行是「历史读取的四种状态」之一
      // ——**还有更早**时可点。这三种态必须长得不一样：把"读不到"渲染成"这个会话没内容"
      // 是在给用户一个假事实，而截图是唯一能确认它们真的不一样的办法。
      name: 'chat-history',
      url: '/pages/chat/chat',
      data: {
        running: false,
        barText: '空闲',
        barTheme: 'success',
        foldable: 1,
        turn: 2,
        historyState: 'ok',
        hasMore: true,
        historyLoadingMore: false,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '' },
          { key: 'u1', kind: 'user', text: '这个项目现在完成度怎么样？', confirmed: true },
          { key: 'm1', kind: 'text', text: '我先看一下目录和测试的规模。', done: true },
          {
            key: 'x1',
            kind: 'steps',
            closed: true,
            open: false,
            live: false,
            tools: 2,
            label: '已完成 2 个步骤',
            items: [
              {
                key: 't1',
                type: 'tool',
                phase: 'completed',
                tool: 'Bash',
                title: 'ls -la',
                args: '{"command":"ls -la"}',
                result: 'total 88\ndrwxr-xr-x  apps\n…',
                preview: 'total 88 drwxr-xr-x apps …',
                open: false,
              },
              {
                key: 't2',
                type: 'tool',
                phase: 'completed',
                tool: 'Bash',
                title: 'pnpm -r test',
                args: '{"command":"pnpm -r test"}',
                result: '# pass 281\n# fail 0',
                preview: '# pass 281 # fail 0',
                open: false,
              },
            ],
          },
          {
            key: 'm2',
            kind: 'text',
            text: '协议、插件、小程序三端都在跑，测试全绿；小程序这版刚补齐了「打开会话就能读到主机上已有历史」。',
            done: true,
          },
          { key: 'r2', kind: 'turn', label: '第 2 轮', time: '' },
          { key: 'u2', kind: 'user', text: '再跑一遍测试', confirmed: true },
          { key: 'm3', kind: 'text', text: '测试全过。', done: true },
        ],
      },
    },
    {
      // 读不到（超时 / 主机那一代没有 readHistory）：给一个可点的出口，且**不说**"没内容"
      name: 'chat-history-error',
      url: '/pages/chat/chat',
      wait: 900,
      data: {
        running: false,
        barText: '空闲',
        barTheme: 'success',
        historyState: 'error',
        blocks: [],
      },
    },
    {
      // 确实读到了、而且里面什么都没有 —— 只有这一种才配说这句话
      name: 'chat-history-empty',
      url: '/pages/chat/chat',
      data: {
        running: false,
        barText: '空闲',
        barTheme: 'success',
        historyState: 'ok',
        blocks: [],
      },
    },
    {
      // 正在读第一页：转圈那一格
      name: 'chat-history-loading',
      url: '/pages/chat/chat',
      wait: 900,
      data: {
        running: false,
        barText: '连接中',
        barTheme: 'primary',
        historyState: 'loading',
        blocks: [],
      },
    },
  ],
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const automator = resolveAutomator()
  if (!automator) {
    console.error(
      '没找到 miniprogram-automator。装一份再跑：\n' +
        '  npm i miniprogram-automator --prefix ~/.workbuddy/binaries/node/workspace',
    )
    process.exit(2)
  }

  if (!(await probePort(PORT))) {
    console.error(
      `自动化端口 ${PORT} 没在监听。按顺序做：\n` +
        '  1) /Applications/wechatwebdevtools.app/Contents/MacOS/cli quit\n' +
        `  2) .../cli auto --project ${MP_DIR} --trust-project --auto-port ${PORT}\n` +
        `  3) curl -s --max-time 3 http://127.0.0.1:${PORT}/json/version   # 期望 Upgrade Required`,
    )
    process.exit(2)
  }

  fs.mkdirSync(OUT, { recursive: true })
  const miniProgram = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${PORT}` })
  console.log(`已连接 ws://127.0.0.1:${PORT}`)

  // 屏幕截图看不出运行时报错。开了按需注入 / 用时注入之后，
  // 「占位组件替换失败」「组件未声明」这类错误正是靠这个抓出来的。
  const errors = []
  miniProgram.on('exception', (err) => {
    errors.push(`[exception] ${(err && (err.message || err.stack)) || String(err)}`)
  })
  miniProgram.on('console', (msg) => {
    if (msg && msg.type === 'error') {
      errors.push(`[console.error] ${(msg.args || []).map(String).join(' ')}`)
    }
  })

  const names = ONLY.length ? ONLY : Object.keys(SHOTS)
  let ok = 0

  for (const key of names) {
    const shots = SHOTS[key]
    if (!shots) {
      console.error(`跳过未知页面: ${key}（可选: ${Object.keys(SHOTS).join(', ')}）`)
      continue
    }
    for (const shot of shots) {
      try {
        // 主题要在 reLaunch **之前**写好：onLoad 里 theme.applyTo 会从 storage 读，
        // 写晚了这一轮就是浅色的（截图看起来"深色没生效"，其实是自己写晚了）。
        if (shot.theme) {
          miniProgram.evaluate(
            (t) => wx.setStorageSync('drc.theme.v1', t),
            shot.theme,
          )
        }
        await miniProgram.reLaunch(shot.url)
        await sleep(1500)
        if (shot.data) {
          // 直接改页面 data：省掉点击步骤，渲染路径与真实一致
          const page = await miniProgram.currentPage()
          await page.setData(shot.data)
          // wait：setData 到截图之间的等待。默认 700ms 够渲染完；
          // 想抓「占位组件还没被替换」的那一帧就调小（用时注入验证用）。
          await sleep(shot.wait || 700)
        }
        const file = path.join(OUT, `${shot.name}.png`)
        await miniProgram.screenshot({ path: file })
        console.log(`✓ ${shot.name}  ${file}  (${fs.statSync(file).size} B)`)
        ok += 1
      } catch (err) {
        console.error(`✗ ${shot.name}: ${err && err.message}`)
      }
    }
  }

  await miniProgram.disconnect()
  console.log(`完成 ${ok} 张，输出目录 ${OUT}`)
  if (errors.length) {
    console.error(`\n捕获到 ${errors.length} 条运行时错误：`)
    for (const e of [...new Set(errors)]) console.error(`  ${e}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
