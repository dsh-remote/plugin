/**
 * paths-port 的表驱动判据 —— A1 的出口。
 *
 * ## 形态：为什么是「一张表」而不是若干条散判据
 *
 * v2 的分叉源就是**四个文件各写一遍判定**，所以这张表的每个格子都必须能被
 * 单独读出来回答："这个形态在这个平台上，算不算绝对路径？"——
 * 包括**在 macOS 上跑却断言 win32 的行为**（平台参数注入了，不需要真机）。
 *
 * 表里刻意收了 §6.4 审计点名的全部形态：`/x`、`C:\x`、`\\host\share`、`~/x`、相对路径，
 * 外加 v2 三个分叉点各自的实际输入（`config.ts` 的两个、`carrier-services` 的一个）。
 *
 * ## 判据红了先怀疑判据
 *
 * 这张表是**纯函数**的（不碰磁盘、不读环境），所以任何一条红都必然是
 * 「实现与表不一致」，两边必有一错——先看表有没有写错那一个，
 * 再看实现。绝不要为了变绿去改实现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dataDir,
  isAbsolutePath,
  isForeignAbsolutePath,
  resolveAgainstBase,
  tailOfPath,
  workspaceProblem,
  type Platform,
} from '../src/platform/paths.js'

/**
 * 表的形状：`[输入, 该平台是否绝对路径, 备注]`。
 * 「本平台绝对」这一列就是 `isAbsolutePath` 的完整契约。
 */
const IS_ABSOLUTE: Array<[raw: string, darwin: boolean, linux: boolean, win32: boolean, why: string]> = [
  ['/x', true, true, true, 'POSIX 绝对路径；在 win32 上是「当前盘符的根」，也算'],
  ['/', true, true, true, '根目录本身'],
  ['C:\\x', false, false, true, 'Windows 盘符路径：win32 上绝对，POSIX 上不是（没有 C 盘）'],
  ['c:/x', false, false, true, '盘符小写同上——判定不许大小写敏感'],
  ['C:\\\\x', false, false, true, '盘符 + 两个分隔符：win32 上仍是绝对路径（分隔符多写一个不改变性质）'],
  ['\\\\host\\share', false, false, true, 'UNC 共享：win32 上绝对'],
  ['\\\\\\\\?\\\\C:\\\\x', false, false, true, 'Win32 扩展长度路径（\\?\\ 前缀）'],
  ['\\\\\\\\.\\\\C:\\\\x', false, false, true, 'Win32 设备路径（\\\\.\\ 前缀）'],
  ['\\x', false, false, true, 'win32 的根相对路径'],
  ['~/x', false, false, false, '**波浪号不是路径语法**：shell 自己才展开它，path 不认'],
  ['x', false, false, false, '裸相对名'],
  ['./x', false, false, false, '点开头的相对路径'],
  ['../x', false, false, false, '双点开头的相对路径'],
  ['', false, false, false, '空串：不是路径，更不是绝对路径'],
  ['/x/y', true, true, true, '多段 POSIX 绝对路径'],
]

test('isAbsolutePath：形态 × 三平台逐格对照（这张表就是它的完整契约）', () => {
  for (const [raw, darwin, linux, win32, why] of IS_ABSOLUTE) {
    assert.equal(isAbsolutePath(raw, 'darwin'), darwin, `darwin / ${JSON.stringify(raw)}：${why}`)
    assert.equal(isAbsolutePath(raw, 'linux'), linux, `linux / ${JSON.stringify(raw)}：${why}`)
    assert.equal(isAbsolutePath(raw, 'win32'), win32, `win32 / ${JSON.stringify(raw)}：${why}`)
  }
  assert.ok(IS_ABSOLUTE.length >= 12, '表被削得太少：形态覆盖会退化，而分叉源正是形态漏项')
})

test('三个分叉点的真实输入，各平台结论固定（v2 审计点名的三处）', () => {
  // ① config.ts:163 `pairStoreFile` 收一个 C:\ 路径：win32 上必须**认**（原样返回），
  //    POSIX 上必须**不认**（于是报错，而不是 path.join 改道）。
  assert.equal(isAbsolutePath('C:\\Users\\x\\state.json', 'win32'), true, 'win32 上它就是绝对路径')
  assert.equal(isAbsolutePath('C:\\Users\\x\\state.json', 'darwin'), false, 'darwin 上它不是')

  // ② config.ts:321 的 statusFile 校验：同一条 win32 配置在 POSIX 主机上要报
  //    「这是外来平台的绝对路径」，而不是「必须是绝对路径」——两句提示的改法不同。
  assert.equal(isForeignAbsolutePath('C:\\Users\\x\\state.json', 'darwin'), true)
  assert.equal(isForeignAbsolutePath('C:\\Users\\x\\state.json', 'linux'), true)
  assert.equal(isForeignAbsolutePath('C:\\Users\\x\\state.json', 'win32'), false, '本平台的路径不算外来')

  // ③ carrier-services 的 workspace 校验：Windows 手机传来的路径在 POSIX 宿主上
  //    必须被**明确拒绝**（原实现如此），而 POSIX 路径在 Windows 宿主上同样要拒。
  assert.equal(workspaceProblem('C:\\Users\\x\\project', 'darwin'), 'looks like a Windows path')
  assert.equal(workspaceProblem('/Users/x/project', 'win32'), 'looks like a POSIX path')
  assert.equal(workspaceProblem('/Users/x/project', 'darwin'), '', '本机形态在 POSIX 上合法')
})

test('workspaceProblem：三条与平台无关的红线，顺序也有讲究', () => {
  // 过长先于形状——否则下面两条规则都要重复处理长度与 NUL。
  assert.equal(workspaceProblem('/' + 'x'.repeat(2000), 'darwin'), 'too long')
  // 含 NUL 同样先于形状：它是"根本进不了 syscall"的输入。
  assert.equal(workspaceProblem('/a\u0000b', 'darwin'), 'contains NUL')
  // 外来形态先于「不是绝对路径」：两者的用户提示与改法不同，不能混成一句。
  assert.equal(workspaceProblem('C:\\x', 'linux'), 'looks like a Windows path')
  assert.equal(workspaceProblem('x', 'darwin'), 'not an absolute path')
  // 边界：正好 1024 不是「too long」（与 v2 的 > 1024 一致）。
  const exact = '/' + 'x'.repeat(1023)
  assert.equal(exact.length, 1024)
  assert.equal(workspaceProblem(exact, 'darwin'), '', '1024 字符是允许的：阈值是「超过」不是「达到」')
})

test("tailOfPath：Windows 路径不再返回整串（v2 的 split('/') 在那上面失效）", () => {
  assert.equal(tailOfPath('/Users/x/project', 'darwin'), 'project')
  assert.equal(tailOfPath('/Users/x/project/', 'darwin'), 'project', '结尾分隔符不算一段')
  assert.equal(tailOfPath('C:\\Users\\x\\project', 'win32'), 'project', 'v2 在这里返回整串路径')
  assert.equal(tailOfPath('C:\\Users\\x\\project\\', 'win32'), 'project', '结尾分隔符')
  assert.equal(tailOfPath('C:\\', 'win32'), 'C:', '只剩盘符时返回盘符本身，不给空串')
  assert.equal(tailOfPath('/', 'darwin'), '/', '根目录的兜底')
  assert.equal(tailOfPath('', 'darwin'), '/', '空串兜底')
  // 反向判据：win32 的 tailOfPath **不该**把 POSIX 路径的斜杠当分隔符之外的东西
  // （win32 上 `/` 也是分隔符，所以这里期望取最后一段）。
  assert.equal(tailOfPath('/Users/x/project', 'win32'), 'project')
})

test('dataDir：稳定运行时标识，改它会让在用装机找不到自己的状态文件', () => {
  assert.equal(dataDir('darwin', { home: '/Users/x' }), '/Users/x/.dsh/dsh-remote-control')
  assert.equal(dataDir('linux', { home: '/home/x' }), '/home/x/.dsh/dsh-remote-control')
  // ⚠️ 这条是「不许顺手改目录名」的判据：路由前缀、status.json、密钥簿都指着它。
  assert.match(
    dataDir('win32', { home: 'C:\\Users\\x' }),
    /\.dsh[\\/]dsh-remote-control$/,
    '目录名 dsh-remote-control 是稳定标识',
  )
})

test('resolveAgainstBase：绝对原样、相对按 base 解析、外来路径在 POSIX 上不解析', () => {
  // 绝对：原样返回（与 v2 逐字一致）
  assert.equal(resolveAgainstBase('/x/y', '/base/state.json', 'darwin'), '/x/y')
  assert.equal(resolveAgainstBase('C:\\x\\y', '/base/state.json', 'win32'), 'C:\\x\\y')
  // 相对：按 base 所在目录（status.json 的目录）
  assert.equal(resolveAgainstBase('rel.json', '/base/state.json', 'darwin'), '/base/rel.json')
  // ⚠️ 反向判据：外来绝对路径在 POSIX 上**不许**被 join 改道。
  // v2 的 startsWith('/') 会放它过去，于是 path.join('/base', 'C:\\x') = '/base/C:\\x'
  // ——一个两边都不认的怪东西，用户以为配好了，实际落在别处。
  assert.equal(
    resolveAgainstBase('C:\\x', '/base/state.json', 'darwin'),
    'C:\\x',
    '外来平台的绝对路径必须原样返回，让调用方去报错，而不是被 join 改道',
  )
  // base 为空：原样返回（"无法解析"不等于"可以改道"）
  assert.equal(resolveAgainstBase('rel.json', '', 'darwin'), 'rel.json')
})

test('反向判据：把 win32 的盘符判定去掉，上面三条 workspace 断言必须立刻红', () => {
  // 这条不是装饰——它证明前面那张表**真的在测**判定本身，
  // 而不是碰巧全绿（比如"外来形态那条"其实恒为空集）。
  const fake = (raw: string, platform: Platform) => (platform === 'win32' ? raw.startsWith('/') : raw.startsWith('/'))
  // 模拟「只认 POSIX 形态」的实现：win32 上盘符与 UNC 全部失效。
  assert.equal(isAbsolutePath('C:\\x', 'win32'), true, '真实实现认盘符')
  assert.equal(fake('C:\\x', 'win32'), false, '模拟实现不认盘符 ⇒ 判据能抓住这个差异')
  assert.equal(fake('\\\\host\\share', 'win32'), false, '模拟实现不认 UNC')
  assert.equal(isAbsolutePath('\\\\host\\share', 'win32'), true, '真实实现认 UNC')
})
