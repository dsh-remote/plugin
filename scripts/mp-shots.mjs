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
 *   node scripts/mp-shots.mjs                  # 三页的各个交互态
 *   node scripts/mp-shots.mjs --pages sessions # 只截指定页（逗号分隔）
 *   node scripts/mp-shots.mjs --out /tmp/shots
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 微信开发者工具的 `--project` 要的是**项目根**（放着 project.config.json 的那一层），
// 开源改造后就是独立仓 `dsh-remote-mp/`，小程序代码在它下面的 `miniprogram/`。
const MP_DIR = path.join(ROOT, 'dsh-remote-mp')

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
        // 数据按新排序规则摆好（工作区 → 运行中优先 → 时间新的在前），
        // workspaceTag 就是页面会算出来的那个短名
        sessions: [
          {
            id: 's-1',
            title: '重做小程序对话页信息流',
            workspace: '/Users/linbin/dsh-remote-control',
            workspaceTag: 'dsh-remote-control',
            badgeText: '运行中',
            badgeTheme: 'primary',
            running: true,
            updatedAt: '16:04',
          },
          {
            id: 's-4',
            title: '给配对码 TTL 分叉补回归',
            workspace: '/Users/linbin/dsh-remote-control',
            workspaceTag: 'dsh-remote-control',
            badgeText: '待审批',
            badgeTheme: 'warning',
            running: false,
            updatedAt: '昨天 22:41',
          },
          {
            id: 's-2',
            title: '排查 t-input 真机塌陷',
            workspace: '/Users/linbin/dsh-remote-mp',
            workspaceTag: 'dsh-remote-mp',
            badgeText: '空闲',
            badgeTheme: 'default',
            running: false,
            updatedAt: '昨天 22:41',
          },
          {
            id: 's-3',
            title: '更新 HANDOFF 测试计数',
            workspace: '/Users/linbin/dsh-remote-mp',
            workspaceTag: 'dsh-remote-mp',
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
      // 未配对态（首页）。**这是配对的唯一入口**了 —— 配对页已删，
      // 所以这张图等于"新用户打开 app 看到的第一屏"，必须真的看。
      name: 'sessions-unpaired',
      url: '/pages/sessions/sessions',
      data: { paired: false },
    },
    {
      // 手动输入展开态：折叠区里的原生 input 高度最容易在真机上塌成一条缝，
      // 这张就是专门盯那三个框的。
      name: 'sessions-manual',
      url: '/pages/sessions/sessions',
      data: {
        paired: false,
        manualOpen: true,
        hasPsk: true,
        token: '042391',
        pasteText: 'dshr:/p?eyJ2IjoxLCJzZXJ2ZXIiOiJ3c3M6Ly9kcmMucHJvdmlkLmNjIn0',
      },
    },
    {
      // 正在连接：按钮转圈 + 文案变化。用户最容易在这时候以为卡死了。
      name: 'sessions-connecting',
      url: '/pages/sessions/sessions',
      data: { paired: false, busy: true },
    },
    {
      name: 'dark-unpaired',
      url: '/pages/sessions/sessions',
      theme: 'dark',
      data: { paired: false, manualOpen: true, hasPsk: true, token: '042391' },
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
        showSteps: true, // 这张专门验过程卡的深色配色，要显式打开
        running: true,
        barText: '已连接',
        barTheme: 'success',
        turn: 1,
        // 模型名在顶栏里，也要看一眼深色下的样子：文字走 --td-text-color-placeholder，
        // 比状态文字还弱一档 —— 弱到看不清就失去信息量，这一档要亲眼确认。
        // 对比度检查只能证明「达标」，看不出「挤在一起」这类布局问题。
        modelName: 'deepseek-chat',
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
    {
      // **空正文帧不许留下空白块** —— 用户真机截图里那三个空白窄条就是它。
      //
      // 为什么这一张要**走真实路径**而不是 setData 摆状态：缺陷在 `_applyText`
      // 那个"text 为空也建块"的判断上。摆一个空 text 块进去，wxml 一定会把它画出来
      //（那只能证明 wxml 忠实渲染，不能证明这条路径不再产生它）。
      // 这里直接调页面自己的方法：先摆一个有字的正文块（作为对照），
      // 再喂两条 `delta:'' + done:true` 的助手帧（宿主里reasoning-only 的
      // assistant/message 就是这个形状），最后再喂一条带字的，验证它照常建块。
      name: 'chat-empty-frame',
      url: '/pages/chat/chat',
      data: {
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '23:20' },
          { key: 'u1', kind: 'user', text: '继续', confirmed: true },
          { key: 'm0', kind: 'text', text: '（下面这条是宿主只有 reasoning、没有正文的消息）', done: true },
        ],
      },
      // 每一步是 [方法名, ...参数]；'flush' 是这一页自己的批处理落块入口。
      calls: [
        ['_applyDelta', 'm-empty-1', '', true, 'assistant'],
        ['_applyDelta', 'm-empty-2', '', true, 'assistant'],
        ['_applyDelta', 'm-empty-3', '', true, 'assistant'],
        ['flush'],
        // 关键：空帧之后**带字的**帧必须照常出现，否则这个修复是"把内容也丢了"。
        ['_applyDelta', 'm-real', '已经改好了，重新跑一遍测试全绿。', true, 'assistant'],
        ['flush'],
      ],
    },
  ],
  chat: [
    { name: 'chat', url: '/pages/chat/chat' },
    {
      // 排队 + 附件 + 加号（2026-10-04 两个新特性的同一屏）：
      // 队列贴在输入区上方（超长文本截断一行、可收起、可删），
      // 附件是缩略图条，加号在输入框左边。
      name: 'chat-composer',
      url: '/pages/chat/chat',
      data: {
        running: true,
        barText: '已连接',
        barTheme: 'success',
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '22:40' },
          { key: 'u1', kind: 'user', text: '把排队和图片附件做出来', confirmed: true },
          { key: 'm1', kind: 'text', text: '好，两件一起做。', done: true },
        ],
        // 缩略图用 1x1 png 的 data URI（mp 仓里没有图片资产；
        // 这一张只看排版：缩略图在位、大小、移除角标）
        attachments: [{ name: 'img-2.jpg', path: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', data: 'QUJD', width: 1600, height: 1200 }],
        queue: [
          { key: 'q1', text: '一条排队中的消息——这句话故意说得很长很长，用来验证超长文本会被截断成一行而不是把输入区顶开', images: [] },
          { key: 'q2', text: '第二条排队，带一张图', images: [{ name: 'img-1.jpg', path: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', width: 1600, height: 1200 }] },
        ],
        queueOpen: true,
      },
    },
    {
      // 用户 2026-10-04 真机截图：markdown 的 list 与 table 宽度不对、缩进不对。
      // 走真实路径（_applyDelta 到 _applyText 到 _withMd 到 markdown.render），
      // 不 setData 摆 nodes——摆进去只能证明 wxml 忠实，证不了这条链排对了。
      name: 'chat-md-width',
      url: '/pages/chat/chat',
      data: {
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '18:20' },
          { key: 'u1', kind: 'user', text: '验证修复', confirmed: true },
        ],
      },
      calls: [
        ['_applyDelta', 'm-md', ['**① 宿主确实跑的是修好的代码**', '', '- 部署产物与仓内构建产物 **sha256 逐字节相同**（`f77e969d…`）', '- 宿主进程 **18:20:30** 加载（晚于 18:12 的部署）——`applyCount` 为证，不是“文件换了但进程没换”',
    '- 外层条目\n- 内层条目（应当缩进更深、也是满宽）', '', '**② 用刚部署的映射跑本会话最新真实事件（140 条）**', '', '| 检查项 | 结果 |', '|---|---|', '| assistant 正文里的 XML 块 | 17 条 delta 中 **0 条**（提到 function= 这个词，不是块） |', '| tool 步骤标题 | 16 条调用里 **0 条** JSON 标题——全是人话 |', '| 结果预览 | 首行就是真实输出（EXIT=1、TEST=0） |'].join('\n'), true, 'assistant'],
        ['flush'],
      ],
    },
    {
      // 「回到最新」那颗钮（2026-10-04 用户要求换时兴样式）：右下角品牌色悬浮圆钮 +
      // CSS 箭头，不占一行、不挡正文，贴底即隐。判据落在渲染层：这一张要能看出
      // 它是**圆的、在右下角、品牌色实心、里头一个向下箭头**。
      name: 'chat-jump-fab',
      url: '/pages/chat/chat',
      data: {
        barText: '已连接',
        barTheme: 'success',
        // atBottom=false 才浮出（与真实一致：用户往上回看过才需要它）
        atBottom: false,
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '22:00' },
          { key: 'u1', kind: 'user', text: '把滚动改好', confirmed: true },
          { key: 'm1', kind: 'text', text: '已经改好了，贴底会跟随、回到最新之后也会。', done: true },
        ],
      },
    },
    {
      // 运行中的默认态：过程**要显示**（收起时一行摘要、展开看细节），
      // 「思考中…」在输入区上方那条，顶栏只留连接状态。
      // 这张是用户实际会看到的那一屏 —— 后面那些带更多字段的场景是"排版对照"，
      // 不能拿它们当默认验收。
      name: 'chat-plain',
      url: '/pages/chat/chat',
      data: {
        running: true,
        barText: '已连接',
        barTheme: 'success',
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '22:10' },
          { key: 'u1', kind: 'user', text: '把两个测试失败查清楚', confirmed: true },
          {
            // 塞一个 steps 块：默认态下它**必须被渲染**（要能在这张图上
            // 确认"有『正在执行 3 个步骤』这一行，且过程窗口在里面"）
            key: 'x1',
            kind: 'steps',
            closed: false,
            open: true,
            live: true,
            tools: 3,
            label: '正在执行 3 个步骤',
            items: [
              { key: 'k1', type: 'think', msText: '1.2s', done: true },
              {
                key: 't1',
                type: 'tool',
                phase: 'completed',
                tool: 'Bash',
                title: 'pnpm -C e2e test',
                result: '2 项失败',
                preview: '2 项失败',
                open: false,
              },
            ],
          },
          { key: 'm1', kind: 'text', text: '两条都指向同一个原因，改掉就行。', done: false },
        ],
      },
    },
    {
      // 全收起的长会话：顶栏的「展开过程」按钮要出现，过程只占一行。
      // 少了这一步，"过程显示出来了"就等于"过程永远撑满整屏"——
      // 长会话里没人想翻十几屏的过程。
      name: 'chat-folded',
      url: '/pages/chat/chat',
      data: {
        showSteps: true,
        running: true,
        barText: '已连接',
        barTheme: 'success',
        turn: 3,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '22:02' },
          { key: 'u1', kind: 'user', text: '先看 git status', confirmed: true },
          {
            key: 'x1',
            kind: 'steps',
            closed: true,
            open: false,
            live: false,
            tools: 2,
            label: '已完成 2 个步骤',
            items: [],
          },
          { key: 'm1', kind: 'text', text: '工作区有两个改动，还没提交。', done: true },
          { key: 'r2', kind: 'turn', label: '第 2 轮', time: '22:05' },
          { key: 'u2', kind: 'user', text: '那就跑一遍测试', confirmed: true },
          {
            key: 'x2',
            kind: 'steps',
            closed: true,
            open: false,
            live: false,
            tools: 1,
            label: '已完成 1 个步骤',
            items: [],
          },
          { key: 'm2', kind: 'text', text: '两项失败，都指向同一个 mock 数据。', done: true },
          { key: 'r3', kind: 'turn', label: '第 3 轮', time: '22:10' },
          { key: 'u3', kind: 'user', text: '把两个测试失败查清楚', confirmed: true },
          {
            key: 'x3',
            kind: 'steps',
            closed: false,
            open: false,
            live: true,
            tools: 3,
            label: '正在执行 3 个步骤',
            items: [],
          },
        ],
      },
    },
    {
      // 运行中的一轮，且步骤组**很长**（6 步工具）。
      // 这是专门用来验「过程窗口限高」的：展开后不该把下面的正文顶出屏幕 ——
      // 截图里正文必须还露在窗口下面，否则限高就没生效。
      // 展示字段（label/tools/live/tailId）要自己写 —— 走 setData 摆状态时不会经过
      // _commit，页面里那层派生逻辑跑不到。
      name: 'chat-live',
      url: '/pages/chat/chat',
      data: {
        showSteps: true, // 这张要看到过程块，所以显式打开
        running: true,
        barText: '已连接',
        barTheme: 'success',
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
                result: 'M dsh-remote-mp/miniprogram/pages/chat/chat.js',
                preview: 'M dsh-remote-mp/miniprogram/pages/chat/chat.js',
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
                result: 'dsh-remote-mp/miniprogram/core/client.js:404 / 412',
                preview: 'dsh-remote-mp/miniprogram/core/client.js:404 / 412',
                open: false,
              },
              { key: 'k5', type: 'think', msText: '1.7s', done: true },
              {
                key: 't5',
                type: 'tool',
                phase: 'completed',
                tool: 'Edit',
                title: 'dsh-remote-mp/miniprogram/core/client.js',
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
        showSteps: true, // 这张要看到过程块，所以显式打开
        running: false,
        barText: '已连接',
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
        showSteps: true, // 这张要看到过程块，所以显式打开
        running: false,
        barText: '已连接',
        barTheme: 'success',
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
          { key: 'm1', kind: 'text', text: '要跑 rm -rf dsh-remote-control/packages/plugin/dist，这一步需要你确认。', done: true },
        ],
        pendingPermission: {
          requestId: 'p1',
          action: 'Bash',
          resource: 'rm -rf dsh-remote-control/packages/plugin/dist',
          reason: '删除构建产物以便重新构建，会丢失未提交的 dist 改动',
          options: [
            { id: 'approve', label: '允许' },
            { id: 'reject', label: '拒绝' },
          ],
          // 倒计时：主机 180 秒无操作会自动拒绝，卡片上必须看得见时间在走。
          // 刻意给一个**小**数字（而不是 179），这样「剩余 20 秒内转警示色」那条
          // 分支也能在这张截图里被看到 —— 否则那个样式永远只有代码没有证据。
          remainSec: 14,
        },
      },
    },
    {
      // 模型：顶栏里「已连接」右边的一段小字。
      // 主机内核只有 currentSelection（modelFace = no-list+no-set），换不了 ——
      // 所以这一张要确认的是它**弱到不像能点**，而不是一个胶囊加尖括号。
      // 刻意给一个超长的模型名，顺便看 ellipsis 有没有把右侧按钮挤走。
      name: 'chat-model',
      url: '/pages/chat/chat',
      data: {
        running: false,
        barText: '已连接',
        barTheme: 'success',
        turn: 1,
        modelName: 'deepseek-chat-long-model-name',
        blocks: [
          { key: 'u1', kind: 'user', text: '看下这个仓库完成度', confirmed: true },
          { key: 'm1', kind: 'text', text: '当前仓库主体是伞仓，四个子项目各自独立成仓。', done: true },
        ],
      },
    },
    {
      // 「只有 think」的组：一行「思考中 4.0s」，没有下拉箭头、没有卡片、
      // 没有第二条重复的状态行。这三条是截图才能确认的 —— 节点数探针能查，
      // 但"看起来是不是仍然像可点"得用眼睛。
      name: 'chat-plain-think',
      url: '/pages/chat/chat',
      data: {
        showSteps: true,
        running: true,
        barText: '已连接',
        barTheme: 'success',
        turn: 1,
        blocks: [
          { key: 'r1', kind: 'turn', label: '第 1 轮', time: '22:41' },
          { key: 'u1', kind: 'user', text: '1', confirmed: true },
          {
            key: 'x1',
            kind: 'steps',
            closed: false,
            // open 故意给 true：卡片那一支靠 !item.plain 挡住，
            // 如果这个条件写错，这张图上就会多出一个空壳卡片。
            open: true,
            live: true,
            plain: 1,
            tools: 0,
            label: '思考中 4.0s',
            items: [{ key: 'k1', type: 'think', msText: '4.0s', startedAt: 0, done: false }],
          },
        ],
      },
    },
    {
      // 历史：打开一条会话时读主机上已有的内容。顶部那一行是「历史读取的四种状态」之一
      // ——**还有更早**时可点。这三种态必须长得不一样：把"读不到"渲染成"这个会话没内容"
      // 是在给用户一个假事实，而截图是唯一能确认它们真的不一样的办法。
      name: 'chat-history',
      url: '/pages/chat/chat',
      data: {
        showSteps: true, // 这张要看到过程块，所以显式打开
        running: false,
        barText: '已连接',
        barTheme: 'success',
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
        barText: '已连接',
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
        barText: '已连接',
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
        // 走页面**自己的方法**（而不是 setData 摆状态）：只有这样验的才是那条真实路径。
        // 摆状态只能证明 wxml 忠实渲染，证明不了"这条路径不再产生那个坏块"。
        if (shot.calls) {
          const page = await miniProgram.currentPage()
          for (const [method, ...args] of shot.calls) {
            if (method === 'flush') {
              page.callMethod('_flushDelta')
              continue
            }
            await page.callMethod(method, ...args)
          }
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
