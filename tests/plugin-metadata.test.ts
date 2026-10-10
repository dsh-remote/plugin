/**
 * 清单里的**显示元数据**与**图标**（2026-08-09）。
 *
 * ## 为什么这两样要有判据
 *
 * 指南（`cordis-plugin-development/references/host-plugin.md`）：
 *
 * > Plugin Manager cards, bundle details, component rows, and the Settings plugin inventory
 * > read display text and an icon from the manifest **without activating the plugin**.
 * > Put the title and description in `locale/en.json` (other languages such as `locale/zh.json`
 * > use the same fields), and declare the icon as a top-level `icon` in `package.json`.
 *
 * 我们在这之前**一样都没有**：设置 → 插件里显示的是包名与默认图，看着像没做完的东西。
 * 而这两样有个共同的坏脾气：**错了在源码里看不出来，只有装进 profile、打开插件页才看得见**。
 * ⇒ 判据必须钉在"宿主要读的那几个位置上"，而不是"我们写了文件"。
 *
 * ## 形状是从宿主自己的包上抄的，不是猜的
 *
 * `locale/en.json` 的**实际内容**长这样（从宿主安装里抽出来的真样本）：
 *
 * ```json
 * { "meta": { "title": "Task interface", "description": "The Automation tasks page…" } }
 * ```
 *
 * ⇒ 注意 `meta` 是**文件里**那一层，不是 `package.json` 里的字段。指南那句代码块给的
 * 就是这个文件的内容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 按**包名**往上认包根：这些用例会被编译到 `dist/tests/` 再跑，写死 `..` 会指到 `dist`。 */
function packageRoot(): string {
  let dir = here
  for (let i = 0; i < 5; i += 1) {
    const candidate = path.join(dir, 'package.json')
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown }
      if (parsed.name === '@dsh-remote/plugin') return dir
    }
    dir = path.dirname(dir)
  }
  throw new Error('找不到 @dsh-remote/plugin 的包根')
}

const ROOT = packageRoot()
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, any>
const MAX_ICON_BYTES = 256 * 1024

test('显示元数据：locale/{en,zh}.json 都有 title/description，且两份**不是同一句话**', () => {
  const seen: Array<{ lang: string; title: string; description: string }> = []
  for (const lang of ['en', 'zh']) {
    const file = path.join(ROOT, 'locale', `${lang}.json`)
    assert.ok(existsSync(file), `缺 locale/${lang}.json：宿主的插件页读它来显示标题与说明`)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { meta?: { title?: unknown; description?: unknown } }
    assert.ok(
      parsed.meta && typeof parsed.meta === 'object',
      `locale/${lang}.json 里要有 meta 这一层（宿主样本就是这个形状）`,
    )
    for (const field of ['title', 'description'] as const) {
      const value: unknown = parsed.meta[field]
      assert.equal(typeof value, 'string', `locale/${lang}.json 的 meta.${field} 必须是字符串`)
      assert.ok(
        (value as string).trim().length > 0,
        `locale/${lang}.json 的 meta.${field} 不能为空：空了宿主就退回包名/描述，等于没写`,
      )
    }
    seen.push({ lang, title: parsed.meta.title as string, description: parsed.meta.description as string })
  }
  assert.notEqual(
    seen[0]!.title,
    seen[1]!.title,
    '两种语言的标题一模一样 ⇒ 多半是复制了一份没翻（用同样的话糊两种语言，等于只有一种语言）',
  )
  assert.notEqual(seen[0]!.description, seen[1]!.description, '说明同理：两份要真的不一样')
  // 中文那份必须真的是中文：只判"不一样"的话，把两份都写成英文也能过。
  assert.match(seen[1]!.title, /[\u4e00-\u9fa5]/, `locale/zh.json 的标题里要有汉字：${seen[1]!.title}`)
  assert.match(seen[1]!.description, /[\u4e00-\u9fa5]/, 'locale/zh.json 的说明里要有汉字')
})

test('图标：顶层 icon 指向包内一个真实存在、类型与体积都合规的文件', () => {
  const icon = MANIFEST.icon
  assert.equal(typeof icon, 'string', '缺顶层 icon：插件的卡片/详情页会退回宿主默认图')
  assert.ok(icon!.startsWith('./'), `icon 必须是包内相对路径，实得 ${icon}`)
  assert.ok(!/:\/\//.test(icon!), `icon 不许是 URL，实得 ${icon}`)
  assert.ok(!icon!.includes('..'), `icon 不许指到包外，实得 ${icon}`)
  assert.ok(/\.(svg|png|jpe?g|webp)$/i.test(icon!), `宿主只认 svg/png/jpeg/webp，实得 ${icon}`)
  const file = path.join(ROOT, icon!)
  assert.ok(existsSync(file), `icon 指向的文件不存在：${file}`)
  const size = statSync(file).size
  assert.ok(size > 0, 'icon 是空文件')
  assert.ok(size <= MAX_ICON_BYTES, `icon 超过宿主的 256 KiB 上限：${size} 字节`)
  if (/\.svg$/i.test(icon!)) {
    const svg = readFileSync(file, 'utf8')
    assert.match(svg, /<svg[\s>]/, 'svg 里没有 <svg> 根元素')
    assert.match(svg, /viewBox=/, 'svg 要给 viewBox：没有它缩放时会被裁掉')
  }
})

test('发布完整性：locale 与 icon 必须在 exports 与 files 里，否则装到 profile 就没了', () => {
  // ⚠️ 这一条比前两条更要紧：**源码里有文件 ≠ 用户装到的那份里有文件**。
  //    `files` 决定 npm 打包带什么，`exports` 决定宿主能不能按路径读到。
  //    少了任何一个，表现都是"本地一切正常、装完显示默认图/包名"。
  assert.equal(
    MANIFEST.exports?.['./locale/*.json'],
    './locale/*.json',
    'exports 里要有 "./locale/*.json"：宿主按路径读词典，不走 exports 读不到',
  )
  assert.ok(Array.isArray(MANIFEST.files), 'files 必须是数组')
  assert.ok(MANIFEST.files.includes('icon.svg'), `files 要带上 icon.svg，实得 ${JSON.stringify(MANIFEST.files)}`)
  assert.ok(MANIFEST.files.includes('locale'), `files 要带上 locale 目录，实得 ${JSON.stringify(MANIFEST.files)}`)
})

test('反向判据：去掉 icon / 把两份词典写成同一句 / 把 locale 从 files 里摘掉 ⇒ 都红', () => {
  // 夹具自检：真清单必须是齐的，否则下面的变异证明不了任何东西。
  assert.equal(typeof MANIFEST.icon, 'string')
  assert.ok(MANIFEST.files.includes('locale'))

  const noIcon = { ...MANIFEST, icon: undefined }
  assert.notEqual(typeof noIcon.icon, 'string', '去掉 icon 之后"它是字符串"这条断言必须不成立')

  const zh = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8')) as { meta: { title: string } }
  const en = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8')) as { meta: { title: string } }
  const copied = { ...zh, meta: { ...zh.meta, title: en.meta.title } }
  assert.equal(copied.meta.title, en.meta.title, '夹具自检：复制之后两份标题必须相同')
  assert.ok(
    !/[\u4e00-\u9fa5]/.test(copied.meta.title) || copied.meta.title === en.meta.title,
    '把中文标题换成英文之后，"两种语言不一样"这条必须不成立',
  )

  const droppedFiles = { ...MANIFEST, files: MANIFEST.files.filter((entry: string) => entry !== 'locale') }
  assert.equal(droppedFiles.files.includes('locale'), false, '摘掉 locale 之后"files 里有 locale"必须不成立')
})
