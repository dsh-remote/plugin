import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendFileNote, safeSegment, saveFileAttachments } from '../src/shell/uploads.js'

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
  assert.equal(one && fs.statSync(one.path).mode & 0o777, 0o600, '附件不该给别人看')

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
  // 所以这里直接换掉 `fs.writeFileSync`：让**第 2 次**调用抛 —— 正是那个形状。
  // （`uploads.ts` 走的是 `fs.writeFileSync(...)` 的属性访问，所以替换默认导出上的成员有效。）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-uploads-io-'))
  const realWrite = fs.writeFileSync
  let calls = 0
  try {
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      return (realWrite as (...a: Parameters<typeof fs.writeFileSync>) => void)(...args)
    }) as typeof fs.writeFileSync

    const result = saveFileAttachments({
      files: [
        { name: 'first.txt', data: Buffer.alloc(16, 0x41).toString('base64') },
        { name: 'second.txt', data: Buffer.alloc(16, 0x42).toString('base64') },
        { name: 'third.txt', data: Buffer.alloc(16, 0x43).toString('base64') },
      ],
      dir,
      sessionId: 'ses_io',
    })

    assert.equal(result.ok, false, '前提：这一批应当整体失败（磁盘写不下去）')
    assert.match(String((result as { message?: string }).message ?? ''), /ENOSPC|落盘失败/, '失败理由要原样带回去')

    const sessionDir = path.join(dir, 'ses_io')
    const leftovers = existsSync(sessionDir) ? readdirSync(sessionDir) : []
    assert.deepEqual(
      leftovers,
      [],
      `这一批被拒了，磁盘上却留下了 ${JSON.stringify(leftovers)}：用户看到的是"发送失败"，` +
        '重试一次文件名就变成 first-2.txt、first-3.txt……一直涨，而那些副本没有任何人认领',
    )
  } finally {
    fs.writeFileSync = realWrite
    rmSync(dir, { recursive: true, force: true })
  }
})
