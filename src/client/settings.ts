/**
 * 设置页里的「远程控制」分区（2026-08-09 新增）。
 *
 * ## 为什么要有这一页
 *
 * pairing 的入口原来是那颗 pill，而它挂在 `conversation.composer.dock` 上——宿主那条渲染
 * 条件是 `sessionId !== void 0`（`app.asar` 原文：`variant === "composer" && input !==
 * void 0 && sessionId !== void 0 ? renderSlot("conversation.composer.dock", {}) : null`）。
 * ⇒ **新会话那一屏不渲染这个槽位**，从零开始的人（web profile 尤其明显：打开浏览器、
 * 一个会话都没有）找不到任何出码入口。
 *
 * `settings.section` 是 root 作用域：**不需要会话**，两端（桌面 App 与 web profile）都渲染它
 * （2026-10-09 运行时实拉两端的模块核对过）。所以这一页是配对入口的正门；pill 仍在，
 * 它是"正在会话里、顺手要配对"的那条近路。
 *
 * ## 形状上的三条决定，都有据
 *
 * 1. **内容全部走 `pill.ts` 已经导出的那几个函数**（`panelViewFor` 判成败、`pillLabel`
 *    出抬头那句、`relayRow`/`versionRow`/`waitingRow` 出三行、`secondsText` 出倒计时）。
 *    这里**一行决策逻辑都不重写**：同一件事在两个地方各判一次，迟早会在一个地方改、
 *    另一个地方不改（本仓 F2 那条纪律就是从这类事故里长出来的）。
 * 2. **React 只给一个挂载点**（`<div ref>`），DOM 命令式地建——与 pill 同一套做法，
 *    这样"码过期要换一张""退出配对之后要重画"这种时序都能写成可测的分支。
 * 3. **任何一步抛出都只留一行日志**，绝不把异常抛进宿主：宿主的槽位渲染器遇到抛出的组件
 *    会把这一条**整块清空**（`slot entry crashed in '<slot>'`），那比少一页难查得多。
 *
 * ## 2026-10-09 的重排（用户："排版还是比较乱……大空间放小内容"）
 *
 * 两件事一起修：
 *
 * 1. **那段 CSS 从来就没生效过。** `pill.ts` 的 `.drc-sec*` 整段把 `hostVar(...)`
 *    写成了**字面文本**（少一对美元花括号），浏览器一条声明都不认——卡片没有边框、
 *    没有底色、没有圆角，标题与按钮全无色。结构与类名都对，屏幕上是一列裸文本。
 *    ⇒ 换成插值，并补一条判据（`e2e/design-tokens.test.mjs`）钉死这个形状。
 * 2. **一列改成两栏。** 原来每一块都占满 720px 而内容只有 200px 宽。现在左栏是
 *    "这台主机"、右栏是"手机端"，四张卡片各有标题；右栏多了**静态的小程序码**
 *    （`MINIPROGRAM_ROUTE`）与一段「怎么用」的说明。
 */
import {
  ensureStyle,
  MINIPROGRAM_ROUTE,
  NEW_ROUTE,
  STATUS_ROUTE,
  UNPAIR_ROUTE,
  panelViewFor,
  pairingCount,
  pillLabel,
  relayRow,
  relayStateRow,
  secondsText,
  versionRow,
  waitingRow,
  warnSection,
  type CreateElement,
  type PanelView,
  type PillDeps,
} from './pill.js'

/** 槽位名：root 作用域，设置页左侧导航的一项 + 右侧分区（两端都渲染）。 */
export const SETTINGS_SLOT = 'settings.section'
/** 条目 id 必须唯一：宿主按它做 `only: active` 的路由与导航高亮。 */
export const SETTINGS_ID = 'dsh-remote-control'
/** 排在宿主自带分区之后。数字本身不重要，重要的是**稳定**：变一次用户就找不到它了。 */
export const SETTINGS_ORDER = 30
/**
 * 导航上那一行字。
 *
 * ⚠️ 宿主自己的分区走 `label: () => ctx.locale.bind(ns)('nav')`（见
 * `dsh-client-ui-agent-preset` 的注册原文）。我们这一半是**纯 JS、没有 locale 命名空间**
 * （`ctx.locale.register` 要同时给 zh/en 两份词典，属于另一件事），所以这里先给字面量，
 * 由 `e2e/plugin-settings-section` 钉住"它非空且不是英文键名"。
 */
export const SETTINGS_LABEL = '远程控制'

/** 发码/退出配对这两条写路由的 CSRF 判据（宿主侧 `routes.ts` 同一个头）。 */
const MARKER: Record<string, string> = { 'x-drc-pair': '1' }

interface LooseAnswer {
  [key: string]: unknown
}

/** 直接借用那两个函数的入参类型：它们的形状就是"宿主会回什么"的唯一真源。 */
type NewAnswerShape = Parameters<typeof panelViewFor>[0]
type StatusShape = Parameters<typeof pillLabel>[0]

/**
 * 在 `root` 里建出这一页，返回卸载函数。
 *
 * 版式是**抬头 + 两栏卡片**：左栏是这台主机（配对卡 + 连接读数），右栏是手机端
 * （静态的小程序码 + 「怎么用」那一段文档）。窄屏由 CSS 折成一列。
 * 与 pill 面板同一套类名与配色变量，所以外观随宿主主题走，不会自己长成另一个样子。
 * 详细的形状与"两张码各自是什么"见下面 `paint` 的注释。
 */
export function buildSettingsSection(root: Element, deps: PillDeps): () => void {
  const doc = root.ownerDocument
  // 自己注入样式：没有会话时 pill 不会挂上，没有人替我们插这张表（见 `ensureStyle` 的注释）。
  ensureStyle(doc)
  const box = doc.createElement('div')
  box.className = 'drc-sec'
  root.appendChild(box)

  let disposed = false
  let statusTimer: ReturnType<typeof setInterval> | undefined
  let countTimer: ReturnType<typeof setInterval> | undefined
  let status: StatusShape | undefined
  let view: PanelView = { kind: 'loading' }
  let expiresInMs = 0
  /**
   * 倒计时那一行的引用。**存引用而不是 `querySelector` 找回来**：每次重画都是新节点，
   * 查回来的可能已经不在树上了；而假 DOM 夹具（`FakeElement`）也没有 `querySelector`。
   * 与 `pill.ts` 的 `countNode` 同一个理由。
   */
  let countNode: HTMLElement | undefined
  /** 已经发过码没有：决定动作那一排给"刷新"还是"退出配对"。 */
  let paired = false

  const fail = (message: string, error?: unknown): void => {
    warnSection(message, error)
    deps.warn?.(message)
  }

  const text = (tag: string, className: string, content?: string): HTMLElement => {
    const node = doc.createElement(tag)
    node.className = className
    if (content !== undefined) node.textContent = content
    return node
  }

  /** 每条请求的超时信号；老环境拿不到就不带，不让这里抛出去。 */
  const signal = (): AbortSignal | undefined => {
    try {
      const timeouts = (globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignal } }).AbortSignal
      return typeof timeouts?.timeout === 'function' ? timeouts.timeout(8000) : undefined
    } catch {
      return undefined
    }
  }

  const call = async (
    input: string,
    init: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; body: LooseAnswer }> => {
    try {
      const response = (await deps.fetchImpl(input, { ...init, signal: signal() })) as
        { ok?: boolean; status?: number; json?: () => Promise<unknown> } | undefined
      const statusCode = typeof response?.status === 'number' ? response.status : 0
      let body: LooseAnswer = {}
      try {
        const parsed = await response?.json?.()
        if (parsed && typeof parsed === 'object') body = parsed as LooseAnswer
      } catch {
        /* 没有 body 也是合法回答（204）：交给 panelViewFor 判 */
      }
      return { ok: response?.ok === true, status: statusCode, body }
    } catch (error) {
      fail('请求失败', error)
      return { ok: false, status: 0, body: {} }
    }
  }

  /** 取状态：只读，用于抬头那句与三行事实。 */
  const loadStatus = async (): Promise<void> => {
    if (disposed) return
    const answer = await call(`${STATUS_ROUTE}?t=${Date.now()}`, { method: 'GET' })
    if (disposed) return
    if (answer.ok && answer.body && typeof answer.body === 'object') {
      status = answer.body as StatusShape
      paired = pairingCount(status) > 0
      paint()
    }
  }

  /** 发一张码（幂等：宿主侧"已有就直接给现有的"）。 */
  const mint = async (): Promise<void> => {
    if (disposed) return
    view = { kind: 'loading' }
    paint()
    const answer = await call(NEW_ROUTE, { method: 'POST', headers: MARKER })
    if (disposed) return
    view = panelViewFor(answer.body as NewAnswerShape, answer.status)
    expiresInMs = view.kind === 'qr' ? view.expiresInMs : 0
    paint()
    startCountdown()
  }

  /** 退出配对：作废全部配对通道，然后回到"未配对 + 一张新码"。 */
  const unpair = async (): Promise<void> => {
    if (disposed) return
    const answer = await call(UNPAIR_ROUTE, { method: 'POST', headers: MARKER })
    if (disposed) return
    if (!answer.ok) {
      view = { kind: 'failed', detail: `HTTP ${answer.status}` }
      paint()
      return
    }
    paired = false
    await loadStatus()
    if (!disposed) await mint()
  }

  const startCountdown = (): void => {
    if (countTimer !== undefined) clearInterval(countTimer)
    if (view.kind !== 'qr' || expiresInMs <= 0) {
      countTimer = undefined
      return
    }
    countTimer = setInterval(() => {
      expiresInMs -= 1000
      if (expiresInMs <= 0) {
        expiresInMs = 0
        // 过期就自己换一张：留在废码上比没有码更糟（用户会一直扫一张不作数的图）。
        void mint()
        return
      }
      if (countNode) {
        countNode.textContent = `${secondsText(expiresInMs)}后过期`
        if (expiresInMs <= 30_000) countNode.setAttribute('data-kind', 'urgent')
      }
    }, 1000)
  }

  /**
   * 一张卡片：标题 + 任意内容。四张卡的边框/底色/圆角/内边距全走同一套类。
   *
   * `trailing` 放进**标题行右端**（2026-10-09 用户定的：动作放卡片右上角比放底部好看）。
   * ⚠️ 标题行是 `.drc-sec-headrow` 而不是标题自己：动作与标题必须同一行，
   * 而 `.drc-sec-actions` 的 `margin-left:auto` 靠的是 flex 行上下文。
   * 传了 `trailing` 的那张卡标题会带这个类——判据（`client-bundle.test.ts`）按 className
   * 精确匹配，所以**不要**再给标题叠加第二个类名。
   */
  const card = (heading: string, trailing?: HTMLElement): HTMLElement => {
    const node = doc.createElement('section')
    node.className = 'drc-sec-card'
    const title = text('h3', 'drc-sec-heading', heading)
    if (!trailing) {
      node.appendChild(title)
      return node
    }
    // ⚠️ 标题与动作必须**同在一个 flex 行**里（.drc-sec-headrow），动作才能靠
    // margin-left:auto 贴到右端。第一版把 `.drc-sec-headrow` 直接当标题的类名用，
    // 于是 flex 行挂在 h3 自己身上、动作成了它的兄弟 —— 那一行根本没形成，
    // 动作仍旧掉到卡片底部。判据见 client-bundle.test.ts「动作在卡片右上角」那条。
    const row = doc.createElement('div')
    row.className = 'drc-sec-headrow'
    row.appendChild(title)
    trailing.className = 'drc-sec-actions'
    row.appendChild(trailing)
    node.appendChild(row)
    return node
  }

  /** 按钮：`kind: 'primary'` 是填色的主动作，其余是次级。 */
  const button = (label: string, onClick: () => void, kind?: 'primary'): HTMLElement => {
    const node = doc.createElement('button')
    node.type = 'button'
    node.className = 'drc-sec-btn'
    if (kind) node.setAttribute('data-kind', kind)
    node.textContent = label
    node.addEventListener('click', onClick)
    return node
  }

  /**
   * 整块重画。只在"状态真的变了"的时候调用，倒计时那一拍只改一行文本。
   *
   * ## 版式（2026-10-09 重排）
   *
   * 抬头一行（标题 + 一句它在讲什么），下面是**两栏卡片**：
   *
   * ```
   * ┌ 配对这台主机 ─────┐ ┌ 手机端 ───────────┐
   * │ 状态灯 + 结论      │ │ 小程序码（静态）    │
   * │ 配对二维码（限时）  │ │ 黑鲸远控 · 微信小程序│
   * │ 6 位码 + 倒计时    │ └───────────────────┘
   * │ 引导句            │ ┌ 怎么用 ───────────┐
   * │ [换一张][退出配对] │ │ 手机端 / 再连一次   │
   * └──────────────────┘ │ 安全 / 连不上      │
   * ┌ 连接 ────────────┐ └───────────────────┘
   * │ 中继状态 …        │
   * └──────────────────┘
   * ```
   *
   * 左栏是"这台主机"（要动手的那件事 + 它的读数），右栏是"手机端"（去哪儿装客户端 +
   * 怎么用）。窄屏由 CSS 自己折成一列——判据见 `client-bundle.test.ts` 的「排版」那一组。
   *
   * ⚠️ 两张码同时出现，是这一版最容易出错的地方：左边的**配对二维码**每次配对现生成、
   * 带 PSK、过几分钟就作废；右边的**小程序码**是静态的客户端入口图，长期有效。
   * 所以两张卡各有各的标题，尺寸也差一档（200px / 148px）——不能让用户拿小程序码
   * 去配这台主机，那是"扫了没反应且没有任何提示"。
   */
  const paint = (): void => {
    if (disposed) return
    const children: unknown[] = []
    countNode = undefined

    // ── 抬头：标题 + 一句"这一页是干什么的" ──────────────────────────
    const header = doc.createElement('div')
    header.className = 'drc-sec-header'
    header.appendChild(text('h2', 'drc-sec-title', SETTINGS_LABEL))
    header.appendChild(
      text('p', 'drc-sec-sub', '用微信小程序远程操作这台主机上的 DSH 会话：发指令、看流式输出、审批工具调用。'),
    )
    children.push(header)

    /**
     * ── 状态条：一整行回答「现在连上没有」 ──────────────────────────
     *
     * 2026-10-09 用户判定旧版"排版很大问题"之后重排的关键一条：
     * **"连上没有"这件事原来藏在配对卡里的一行小字**，而那一行小字
     * 与二维码、6 位码、说明文字挤在同一张卡里，第一眼根本读不到。
     *
     * ⇒ 把它提到整栏最上面，左边一颗灯 + 结论，右边一行元信息。
     * 元信息（中继 / 版本 / 待处理）也在这里读完 —— 它们原来各占**一整张卡**，
     * 两张加起来 510px，占整栏高度的 63%（实测 802px 里的 510px）。
     */
    const statusBar = doc.createElement('div')
    statusBar.className = 'drc-sec-status'
    const barHead = doc.createElement('div')
    barHead.className = 'drc-sec-statushead'
    const dot = doc.createElement('span')
    dot.className = 'drc-dot'
    dot.setAttribute('data-tone', pillLabel(status).tone)
    dot.setAttribute('aria-hidden', 'true')
    barHead.appendChild(dot)
    barHead.appendChild(text('strong', 'drc-sec-statustext', pillLabel(status).text))
    barHead.appendChild(text('span', 'drc-sec-statushint', relayStateRow(status)))
    statusBar.appendChild(barHead)
    children.push(statusBar)

    const grid = doc.createElement('div')
    grid.className = 'drc-sec-grid'

    // ── 第一张卡：配对（这一页的主动作） ────────────────────────────
    //
    // 动作**先建好再传给 card()**：它落在标题行右端，而不是卡片底部。
    const actions = doc.createElement('div')
    actions.appendChild(button(view.kind === 'qr' ? '换一张' : '生成配对码', () => void mint(), 'primary'))
    if (paired) actions.appendChild(button('退出配对', () => void unpair()))
    /**
     * 主卡：**这一页唯一的大块**。二维码能给到多大取决于这一张有多宽，
     * 所以它不再和「手机端」那张图并排挤成两列 353px（实测那张次卡里只有一张图 + 两行字，
     * 却被迫和主卡等高到 468px —— 就是用户说的"大空间放小内容"）。
     */
    const pair = card('配对这台主机', actions)
    pair.setAttribute('data-role', 'pair')

    if (view.kind === 'loading') {
      pair.appendChild(text('p', 'drc-sec-state', '正在生成配对码…'))
    } else if (view.kind === 'qr') {
      const image = doc.createElement('img')
      image.className = 'drc-qr'
      image.setAttribute('alt', '配对二维码')
      image.src = view.imageSrc
      pair.appendChild(image)

      /**
       * 6 位码与它上面那行小字分两个节点：判据钉的是 `drc-code` 的 `textContent`
       * **恰好是那 6 位**（`client-bundle.test.ts`），说明文字混进去会让"手输这条路"
       * 变得没法机械核对。
       */
      const code = doc.createElement('div')
      code.className = 'drc-sec-code'
      code.appendChild(text('span', 'drc-sec-code-label', '或在小程序里手输这 6 位码'))
      code.appendChild(text('p', 'drc-code', view.token))
      pair.appendChild(code)

      countNode = text('p', 'drc-count', `${secondsText(expiresInMs)}后过期`)
      if (expiresInMs <= 30_000) countNode.setAttribute('data-kind', 'urgent')
      pair.appendChild(countNode)

      pair.appendChild(
        text('p', 'drc-sec-guide', '用微信扫这张码。扫一次以后这台主机就在小程序的列表里，之后自动连上。'),
      )
    } else if (view.kind === 'unavailable') {
      pair.appendChild(text('p', 'drc-sec-state', view.reason))
    } else if (view.kind === 'failed') {
      const node = text('p', 'drc-sec-state', `发不出配对码：${view.detail}`)
      node.setAttribute('data-kind', 'failed')
      pair.appendChild(node)
    } else {
      /**
       * 已配对：**不出二维码**（配对已经发生过，再摆一张只会让人以为还要扫），
       * 但也不该拿一大块空白说一句话 —— 一行字 + 主机标识就够，
       * 高度交给下面那张「手机端」卡去消化。
       */
      const done = doc.createElement('p')
      done.className = 'drc-sec-state drc-sec-done'
      done.appendChild(text('span', '', '已配对，不用再扫码。'))
      pair.appendChild(done)
    }

    grid.appendChild(pair)

    // ── 第二张卡：小程序码（静态、长期有效的那一张）────────────────────
    //
    // ⚠️ **它必须紧跟在配对卡后面**（2026-10-09 真屏幕截图之后调的）：网格按 DOM 顺序
    // 逐行排，所以"两张有图的卡并排、下面两张纯文字的卡并排"要求的就是这个顺序。
    // 排错了的形状是"配对码旁边配一张读数表"，视觉重量完全不在一个层级上。
    const mp = card('手机端')
    mp.setAttribute('data-role', 'mp')
    mp.setAttribute('data-layout', 'figure')
    const mpImage = doc.createElement('img')
    mpImage.className = 'drc-mp'
    mpImage.setAttribute('alt', '黑鲸远控小程序码')
    mpImage.src = MINIPROGRAM_ROUTE
    /**
     * 图取不到就把整张卡摘掉。`miniprogram.jpg` 是包内静态资源，正常装机一定有；
     * 真的没有（老版产物、被裁过的安装）时，屏幕上留一张破图比少一张卡难看得多，
     * 而这一栏也不是必需的——左边那张配对码才是这一页的全部意义。
     * ⚠️ 用闭包抓住这张卡的节点，而不是事件里 `closest()`：本仓的假 DOM 夹具只有
     * 十几个成员，`closest` 不在其中，写了就得连夹具一起改。
     */
    mpImage.addEventListener('error', () => {
      if (!disposed) mp.remove()
    })
    mp.appendChild(mpImage)
    mp.appendChild(text('p', 'drc-sec-caption', '黑鲸远控 · 微信小程序'))
    mp.appendChild(
      text('p', 'drc-sec-note', '扫码打开小程序，或在微信里搜「黑鲸远控」。打开即用，不用装 App，也不用注册账号。'),
    )
    grid.appendChild(mp)

    // ⚠️ **原来那张「连接」卡整张删掉了**（2026-10-09 重排）。
    // 那四行读数（中继状态 / 中继地址 / 主机版本 / 待处理）现在进了**状态条那一行**，
    // 它们是"知道就行"的信息，不该各占一整张卡 —— 实测那两张纯文字卡
    // （连接 + 怎么用）加起来 510px，占整栏 802px 的 63%。
    //
    // 「待处理」仍然**必须留在这一行**：一张挂起的审批卡住远端一条正在跑的回合
    // （docs/PRODUCT.md §3），那是这一页唯一一条"看完要做点什么"的读数。
    const meta = doc.createElement('div')
    meta.className = 'drc-sec-meta'
    for (const [key, value] of [
      ['中继', relayRow(status)],
      ['版本', versionRow(status)],
      ['待处理', waitingRow(status)],
    ] as const) {
      if (!value) continue
      const item = doc.createElement('span')
      item.className = 'drc-sec-meta-item'
      item.appendChild(text('span', 'drc-sec-meta-key', key))
      item.appendChild(text('span', 'drc-sec-meta-value', value))
      meta.appendChild(item)
    }

    children.push(grid)
    // ⚠️ 这里原来有一段「── 第四张卡：怎么用 ──」的注释，列着四条说明文案，
    // 而**它描述的结构在这一轮重排里已经不存在了**（下一段就是页脚）。
    // 留着它 = 下一位读代码会以为页面上还有那四条说明 —— 而实际上「环境自检」
    // 「不用再扫」这两条**页面上一个都不存在**（它们在别的文档里，不在这一栏）。

    // ── 页脚：三步一行 + 元信息 ────────────────────────────────────
    //
    // 「怎么用」原来是一张 255px 的卡、四条 2×2 的说明。它们是这个页面的**第三等**内容
    // （第一等是配对码，第二等是连没连上），压成一行之后整页才装得下不必滚。
    const footer = doc.createElement('div')
    footer.className = 'drc-sec-footer'
    const steps = doc.createElement('ol')
    steps.className = 'drc-sec-steps'
    // 句子按"一行三步"的宽度裁过；原来那版是照整行写的，每条要占四五行。
    for (const step of ['扫上面的码', '在手机上下指令', '审批工具调用']) {
      const li = doc.createElement('li')
      li.className = 'drc-sec-step'
      li.appendChild(text('span', '', step))
      steps.appendChild(li)
    }
    footer.appendChild(steps)
    // 两条**排错时会用到的**事实留在这里（比正文低一等，但删不得）：
    // 「扫不出怎么办」与「退出配对会作废钥匙」都是用户真的会遇到的。
    footer.appendChild(
      text(
        'p',
        'drc-sec-footnote',
        '扫不出就在小程序「手动输入」里填那 6 位码 · 端到端加密，中继只见密文 · 「退出配对」会作废手机上那把钥匙',
      ),
    )
    if (meta.children.length > 0) footer.appendChild(meta)
    children.push(footer)

    box.replaceChildren(...(children as Node[]))
  }

  paint()
  void loadStatus()
  void mint()
  /**
   * 状态每 2 秒回来一次：这是"手机上刚扫完，电脑这一页马上就变"的那条路。
   * 与 pill 同一个节拍——用户在设置页停留时也应当看到别人扫码的结果。
   */
  statusTimer = setInterval(() => void loadStatus(), 2000)

  return () => {
    disposed = true
    if (statusTimer !== undefined) clearInterval(statusTimer)
    if (countTimer !== undefined) clearInterval(countTimer)
    statusTimer = undefined
    countTimer = undefined
    try {
      box.remove()
    } catch {
      /* 宿主已经把它摘掉了 */
    }
  }
}

interface SettingsHost {
  effect?(execute: (() => unknown) | void): unknown
  /** 模块 `inject: ['slots']` 声明之后这一格直接可读（宿主自带模板就是这个写法）。 */
  slots?: unknown
  get?(name: string, strict?: boolean): unknown
  /** 这一代宿主没把 slots 当服务给时的退路：等 `inject(['slots'], cb)` 回调。 */
  inject?(names: string[], callback: (...args: unknown[]) => void): unknown
}

/** 认得出 slots 服务吗（与 `pill.ts` 同一个判据，这里再看一遍是为了不导出内部工具）。 */
interface SlotRegistry {
  inject(name: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

function isSlots(value: unknown): value is SlotRegistry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.inject === 'function' && typeof record.register === 'function'
}

function pickSlots(source: unknown): SlotRegistry | undefined {
  if (isSlots(source)) return source
  const gettable = source as { get?: (name: string, strict?: boolean) => unknown } | null | undefined
  if (gettable && typeof gettable.get === 'function') {
    try {
      const got = gettable.get('slots', true)
      if (isSlots(got)) return got
    } catch {
      /* 这个候选没有该服务 */
    }
  }
  return undefined
}

/**
 * 把这一页注册进 `settings.section`。
 *
 * 与 `mountPill` 同一套：`slots.inject(槽位名, 回调)` 等到**槽位声明**再注册
 * （这正是它存在的理由——宿主可能晚声明；直接 `register` 一个未声明的槽位会抛）。
 * 返回 false = "到这一刻还没挂上"，调用方只关心它不外抛。
 */
export function mountSettingsSection(ctx: SettingsHost, createElement: CreateElement | undefined): boolean {
  if (!createElement) {
    // 拿不到 react 就连挂载点都没有。pill 那边也是这条：少一页，不是整页起不来。
    warnSection('装载器给不出 react：设置里的那一页不会出现')
    return false
  }
  let mounted = false
  const mount = (slots: SlotRegistry): void => {
    if (mounted) return
    /** `ref` 回调必须身份稳定，否则宿主每次重渲染都会先 `ref(null)` 再 `ref(node)`。 */
    let cleanup: (() => void) | undefined
    const attach = (node: unknown): void => {
      const element = node as Element | null
      if (element && typeof element.appendChild === 'function' && element.ownerDocument) {
        if (cleanup) return
        cleanup = buildSettingsSection(element, {
          fetchImpl: (input, init) => globalThis.fetch(input, init as RequestInit | undefined),
          warn: (message) => warnSection(message),
        })
      } else if (cleanup) {
        cleanup()
        cleanup = undefined
      }
    }
    const component = (): unknown => createElement('div', { ref: attach })
    mounted = true
    try {
      slots.inject(SETTINGS_SLOT, () => {
        try {
          slots.register(
            {
              name: SETTINGS_SLOT,
              id: SETTINGS_ID,
              order: SETTINGS_ORDER,
              label: () => SETTINGS_LABEL,
            },
            component,
          )
        } catch (error) {
          warnSection('设置分区注册失败（这一页不出现）', error)
        }
      })
    } catch (error) {
      mounted = false
      warnSection('设置分区注入失败（这一页不出现）', error)
      return
    }
    try {
      ctx.effect?.(() => () => {
        if (cleanup) {
          cleanup()
          cleanup = undefined
        }
      })
    } catch {
      /* 没有 effect 口就不登记卸载：宿主整页卸载会带走这一页 */
    }
  }
  /**
   * 两条路都要有，形状照 `mountPill`（真机取证过的那一份）：
   *
   * ⚠️ 2026-08-09 这一条是**判据逼出来的**：夹具里 `lateSlots` 那个形状
   * （apply 时拿不到 slots，注入回调之后才有）下，只写"早"这一条会让设置分区
   * **整块不出现**——而宿主那边的常态恰恰就是"apply 早于服务到位"。
   * 少了晚到这条退路，屏幕上就是"设置里没有这一页"，日志里什么都没有。
   */
  let early: SlotRegistry | undefined
  try {
    early = pickSlots(ctx.slots) ?? pickSlots(ctx.get?.('slots', true))
  } catch {
    /* 这一代宿主没这个服务名，或读它就是抛 */
  }
  if (early) mount(early)

  try {
    ctx.inject?.(['slots'], ((...args: unknown[]) => {
      for (const candidate of [...args, ctx]) {
        const found = pickSlots(candidate)
        if (found) {
          mount(found)
          return
        }
      }
    }) as never)
  } catch (error) {
    warnSection('ctx.inject 口不可用：slots 再晚到也没人补挂', error)
  }
  if (!mounted) {
    warnSection('apply 时没探到 slots（已挂注入回调等它晚到）；设置里一直没有这一页就是这代宿主没这个服务')
  }
  return mounted
}
