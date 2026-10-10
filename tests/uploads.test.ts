import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendFileNote, safeSegment, saveFileAttachments } from '../src/shell/uploads.js'
import { hasPosixModes } from './test-platform.js'

test('safeSegment：路径穿越与隐藏文件都要被挡住', () => {
  assert.equal(safeSegment('../../etc/passwd', 'x'), 'etc_passwd')
  assert.equal(safeSegment('.ssh', 'x'), 'ssh')
  assert.equal(safeSegment('', 'fallback'), 'fallback')
  assert.equal(safeSegment('   ', 'fallback'), 'fallback')
  assert.equal(safeSegment('a'.repeat(200), 'x').length, 96, '超长截断')
})

test('saveFileAttachments：保留扩展名、同名加序号、整批先验后写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-file-'))
  const body = Buffer.from('PDFBYTES')
  const r = saveFileAttachments({
    files: [{ name: 'report.pdf', mediaType: 'pdf', data: body.toString('base64') }],
    dir,
    sessionId: 'ses/1',
  })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.saved.length, 1)
  const one = r.ok && r.saved[0]
  assert.equal(one && one.name, 'report.pdf', '扩展名一个字符都不许动：Agent 认文件靠它')
  assert.equal(one && path.basename(one.path), 'report.pdf')
  assert.equal(one && one.bytes, body.length)
  assert.equal(one && fs.readFileSync(one.path).equals(body), true, '落盘的内容要一个字节都不差')
  // ⚠️ 权限位这一条**单独**判，不整条 skip：这条用例前面还有"文件名/内容/字节数"
  // 好几条与平台无关的断言，整条 skip 会让 win32 上白丢它们。
  // 而 win32 上 chmod 只切只读位，`mode & 0o777 === 0o600` 永远不成立（hasPosixModes）。
  if (hasPosixModes()) {
    assert.equal(one && fs.statSync(one.path).mode & 0o777, 0o600, '附件不该给别人看')
  }

  // 同名再来一份：不许覆盖上一份（用户以为发上去了，其实那份被顶掉了）
  const again = saveFileAttachments({
    files: [{ name: 'report.pdf', mediaType: 'pdf', data: body.toString('base64') }],
    dir,
    sessionId: 'ses/1',
  })
  assert.equal(again.ok, true, '第二份也要落盘成功')
  const second: string = again.ok === true && again.saved[0] ? again.saved[0].path : ''
  assert.equal(path.basename(second), 'report-2.pdf', '序号插在扩展名**前面**')
  const back: string = again.ok === true ? again.dir : ''
  assert.equal(fs.readdirSync(back).length, 2, '两份都要在')
})

test('saveFileAttachments：超预算的批次一个字节都不落盘（整批先验）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-file-'))
  const big = Buffer.alloc(600 * 1024, 1)
  const r = saveFileAttachments({
    files: [
      { name: 'ok.txt', mediaType: 'txt', data: 'aGk=' },
      { name: 'big.zip', mediaType: 'zip', data: big.toString('base64') },
    ],
    dir,
    sessionId: 'ses/1',
    maxBytesPerFile: 512 * 1024,
  })
  assert.equal(r.ok, false, '整批先验：一个不过就整批都不写')
  assert.equal(!r.ok && /600KB/.test(r.message), true, '要说清是哪一个、超了多少')
  assert.equal(fs.existsSync(path.join(dir, 'ses_1')), false, '目录里什么都不该有')
})

test('saveFileAttachments：文件数超过 4 个也不行（协议层同一个数）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-file-'))
  const r = saveFileAttachments({
    files: Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.txt`,
      data: 'aGk=',
    })),
    dir,
    sessionId: 's',
  })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && /一次最多带 4 个/.test(r.message), true)
})

test('appendFileNote：正文在后补路径与类型；空正文时（只发文件）也能用', () => {
  const saved = [{ name: 'a.pdf', path: '/tmp/u/a.pdf', bytes: 10, mediaType: 'pdf' }]
  assert.equal(appendFileNote('看这份', saved), '看这份\n\n[文件附件 1 个，已存到本机]\n1. /tmp/u/a.pdf（pdf）')
  assert.equal(appendFileNote('', saved), '[文件附件 1 个，已存到本机]\n1. /tmp/u/a.pdf（pdf）')
  assert.equal(appendFileNote('不带文件', []), '不带文件', '没有附件时正文原样返回')
  // 手机给不出类型时不编一个：折成不带括号的纯路径
  assert.equal(
    appendFileNote('', [{ name: 'a', path: '/tmp/u/a', bytes: 1 }]),
    '[文件附件 1 个，已存到本机]\n1. /tmp/u/a',
  )
})

test('整批附件总量也要卡：单文件 512KB × 4 会撞穿中继的 1MB 单帧上限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-total-'))
  const chunk = Buffer.alloc(200 * 1024, 7) // 200KB
  const one = { name: 'a.bin', data: chunk.toString('base64') }
  const r = saveFileAttachments({ files: [one, one, one], dir, sessionId: 'ses/1' })
  assert.equal(r.ok, false, '3×200KB = 600KB 原文（≈800KB base64）没有被整批闸挡住：这一帧会撞穿中继上限')
  assert.match(r.ok === false ? r.message : '', /整批上限/, '拒绝理由要能读懂（回给手机的就是这句话）')
  assert.equal(
    fs.existsSync(path.join(dir, 'ses')) && fs.readdirSync(path.join(dir, 'ses')).length > 0,
    false,
    '整批先验后写：被拒的批次一个字节都不许留在磁盘上',
  )

  // 与 mp 同口径：单文件 200KB、总量 400KB 的一批必须放行（mp 侧就是按原始字节算的）。
  const ok = saveFileAttachments({ files: [one, one], dir, sessionId: 'ses/2' })
  assert.equal(ok.ok, true, `2×200KB 被误拒：与 mp 的 MAX_ATTACH_TOTAL_BYTES 口径不一致（${JSON.stringify(ok)}）`)
})

test('写到一半失败：已经落盘的那几个必须收回来，不许留一批没人认领的孤儿文件', () => {
  // 文件头第 2 条纪律是"被拒的批次一个字节都不留在磁盘上"，而原来那句话只管**校验**：
  // `writeFileSync` 自己会在循环中途抛（ENOSPC / EACCES / EMFILE），第 2 个文件已经
  // 落盘、第 3 个抛了，`catch` 返回失败、手机如实显示"整条 prompt 失败、什么都没发"。
  // 于是用户重试一次文件名就变成 report-2.pdf、report-3.pdf……一直涨。
  //
  // 生产里的触发条件（磁盘满 / 目录只读 / 文件数超限）没法在 CI 里复现，
  // 所以这里换一种等价的注入：**把 sessionDir 换成指向一个"不是目录"的东西**，
  // 于是第 2 次落盘必然抛 ENOTDIR——正是"写到一半失败"那个形状。
  //
  // ⚠️ v2 的注入手法是替换 `fs.writeFileSync`（默认导出上的成员）。A2 把附件落盘
  // 收进 `platform/secure-file.ts` 之后，实现用的是**具名导入** `writeFileSync`，
  // 不再走 `fs.` 属性访问——所以那种注入悄悄打不中了（判据红在"前提：这一批应当整体失败"）。
  // **判据要测的东西没变**（整批回滚），变的只是让它失败的手段。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-uploads-io-'))
  try {
    // 先让第 1 个文件真落盘，再把「第 2 个」的目标变成不可写的形状：
    // 用同名不同形的路径（给 sessionDir 挂一个已存在的**文件**，mkdirSync 就会 EEXIST/ENOTDIR）。
    const blocker = path.join(dir, 'blocked')
    fs.writeFileSync(blocker, 'not a directory')
    const result = saveFileAttachments({
      files: [
        { name: 'first.txt', data: Buffer.alloc(16, 0x41).toString('base64') },
        { name: 'second.txt', data: Buffer.alloc(16, 0x42).toString('base64') },
      ],
      // sessionId 里带路径分隔符会被 safeSegment 收敛掉，所以直接让 dir 指向那个文件
      dir: blocker,
      sessionId: 'ses_io',
    })

    assert.equal(result.ok, false, '前提：这一批应当整体失败（落盘目录不可用）')
    assert.match(
      String((result as { message?: string }).message ?? ''),
      /ENOTDIR|EEXIST|落盘失败/,
      '失败理由要原样带回去',
    )

    // 那个"目录"位置仍然只有那一个普通文件，没有多出任何附件
    assert.ok(statSync(blocker).isFile(), '不可写的目录位置不该变成别的东西')
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'not a directory', '占位文件本身没被改写')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('整批先验后写：被校验拒掉的批次一个字节都不落盘', () => {
  // 前面那条测的是"写到一半"，这条测"**根本没开始写**"——两条是不同的失效点。
  //
  // 拒绝条件必须从实现里读出来，不要猜：这个实现的先验查的是
  // 「非法 base64 / 单文件超限 / 整批超限 / 条数超限」——**没有扩展名白名单**
  //（第一版这里写的是"exe 应当被拒"，红在"前提"上：它压根不按扩展名拒）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-uploads-pre-'))
  try {
    const big = Buffer.alloc(64 * 1024, 0x41).toString('base64')
    const result = saveFileAttachments({
      files: [
        { name: 'ok.txt', data: Buffer.alloc(8, 0x41).toString('base64') },
        { name: 'huge.bin', data: big },
      ],
      dir,
      sessionId: 'ses_pre',
      maxBytesPerFile: 1024, // 第 2 个文件 64KB > 1KB ⇒ 先验就该拒
    })
    assert.equal(result.ok, false, '第 2 个文件超限，整批应当被拒')
    assert.match(String((result as { message?: string }).message ?? ''), /超过单个上限/, '理由要指向单文件上限')

    const sessionDir = path.join(dir, 'ses_pre')
    const leftovers = existsSync(sessionDir) ? readdirSync(sessionDir) : []
    assert.deepEqual(leftovers, [], '先验后写：ok.txt 也不该落盘（它排第 1，但整批是一起的）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非法 base64 也是先验拒（同样一个字节都不落盘）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-uploads-b64-'))
  try {
    const result = saveFileAttachments({
      files: [
        { name: 'ok.txt', data: Buffer.alloc(8, 0x41).toString('base64') },
        { name: 'broken.txt', data: '这不是 base64!!!' },
      ],
      dir,
      sessionId: 'ses_b64',
    })
    assert.equal(result.ok, false, '第 2 个解码失败，整批应当被拒')
    assert.match(String((result as { message?: string }).message ?? ''), /解码失败/, '理由要指向解码')
    const sessionDir = path.join(dir, 'ses_b64')
    assert.deepEqual(existsSync(sessionDir) ? readdirSync(sessionDir) : [], [], '一个字节都不许落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
