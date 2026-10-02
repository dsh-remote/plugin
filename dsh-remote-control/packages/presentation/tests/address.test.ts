/**
 * address.test — 会话作用域文件地址的形状。
 *
 * 这一层的每条断言都对着**真机取证**：地址形状错一个字，右栏那个页型就拒绝打开
 * （`sidebarRight: tab type "text" refuses "..."`），而屏幕上只会看到"什么都没发生"。
 * 具体形状来自 `@deepseek-ai/dsh-util-workspace-path` 的 `fileAddressFor` /
 * `parseFileAddress` 语义（绝对路径在会话作用域里保留前导斜杠 → 地址里出现双斜杠），
 * 以及真机上把 `~/.dsh/pairing-qr.png` 成功渲染出来的那次实验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUsableSessionId, sessionFileAddress } from '../src/address.js'

test('工作区外绝对路径：前导斜杠必须保留（地址里出现双斜杠）', () => {
  assert.equal(
    sessionFileAddress('sess-1', '/Users/x/.dsh/pairing-qr.png'),
    'dsh-resource://file/session/sess-1//Users/x/.dsh/pairing-qr.png',
  )
})

test('相对路径不带多余斜杠', () => {
  assert.equal(sessionFileAddress('sess-1', '.dsh/pairing.png'), 'dsh-resource://file/session/sess-1/.dsh/pairing.png')
})

test('空格与 unicode 逐段转义，斜杠不被吃掉', () => {
  assert.equal(
    sessionFileAddress('sess 1', '/Users/x/我的 项目/a.png'),
    'dsh-resource://file/session/sess%201//Users/x/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE/a.png',
  )
})

test('反斜杠按 POSIX 归一（Windows 路径也要能编）', () => {
  assert.equal(sessionFileAddress('s1', 'C:\\Users\\x\\a.png'), 'dsh-resource://file/session/s1/C:/Users/x/a.png')
})

test('盘符里的冒号留成字面量（照宿主 encodeSegment 的口径）', () => {
  assert.ok(sessionFileAddress('s1', 'C:/a.png').includes('/C:/a.png'))
  assert.ok(!sessionFileAddress('s1', 'C:/a.png').includes('%3A'))
})

test('会话 id 里的冒号同样留字面量', () => {
  assert.equal(sessionFileAddress('a:b', 'x'), 'dsh-resource://file/session/a:b/x')
})

test('会话 id 在边界上收窄：放行真实字符集，拒绝路径穿越与超长', () => {
  for (const ok of ['sess-1', 'a.b:c_d', 'E9F0', 'x'.repeat(200)]) assert.equal(isUsableSessionId(ok), true, ok)
  for (const bad of ['', 'a/b', 'a b', '../x', 'x'.repeat(201), 42, null, undefined, {}]) {
    assert.equal(isUsableSessionId(bad), false, String(bad))
  }
})
