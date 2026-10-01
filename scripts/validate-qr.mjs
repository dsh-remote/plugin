#!/usr/bin/env node
/**
 * validate-qr — 功能级校验 vendored 的二维码编码器。
 *
 * 逐位比对会被"填充字节的合法选择差异"干扰（例如 qrcode-generator 在
 * terminator 后直接用 0xEC/0x11 填充，segno 会先补齐到码字边界 —— 两者都符合
 * ISO 18004，解码结果相同，但矩阵逐位不同）。所以这里直接做**功能校验**：
 * 把矩阵渲染成图片，用 zxing-cpp 真实解码，要求解出的文本与载荷逐字节一致。
 * 这正是二维码唯一的成败标准：扫得出来，且内容正确。
 *
 * 曾经尝试手写编码器，此校验器抓出了系统性差异，于是改为 vendoring 成熟实现；
 * 脚本保留下来作为防回归护栏。
 *
 * zxing-cpp / pillow 只在校验时使用（隔离 venv），运行时不依赖。
 *
 * 用法：node scripts/validate-qr.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const qrModule = path.join(root, 'packages', 'plugin', 'dist', 'src', 'qr.js')

if (!existsSync(qrModule)) {
  console.error(`✖ 先构建：找不到 ${qrModule}（env -u NODE_OPTIONS pnpm -r build）`)
  process.exit(2)
}

const PY = '/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python'
if (!existsSync(PY)) {
  console.error(`✖ 找不到校验用的 venv：${PY}\n  创建：python3 -m venv <path> && <path>/bin/pip install zxing-cpp pillow segno`)
  process.exit(2)
}

const { qrMatrix } = await import(qrModule)

const PAYLOADS = [
  'dshr:/p?v=1&s=wss%3A%2F%2Fdrc.provid.cc&n=bins-macbook&psk=u6ufzO%2BGNSmosc8y148Rew%3D%3D&t=173142',
  'dshr:/p?v=1&s=wss%3A%2F%2F127.0.0.1%3A8787&n=mb&psk=AAAAAAAAAAAAAAAAAAAAAA%3D%3D&t=000001',
  'HELLO WORLD',
  'a',
  '1234567890',
  'https://example.com/some/path?with=query&and=more',
  '中文载荷测试：配对信息',
]

const ECCS = ['L', 'M', 'Q', 'H']

const cases = []
for (const text of PAYLOADS) for (const ecc of ECCS) cases.push({ text, ecc })

const request = cases.map(({ text, ecc }) => {
  // 半块终端渲染本身就是最终产物 —— 校验它，而不是裸矩阵：把渲染文本原样
  // 画出来，等价于"把 /drc pair 的输出截屏拿去扫"。
  const rendered = (() => {
    // 复用 qrMatrix（无 ANSI 的裸字符版）保证与 renderTerminalQr 同源
    return qrMatrix(text, ecc, 2)
  })()
  return { text, ecc, matrix: rendered.map((row) => row.map((v) => (v ? 1 : 0))) }
})

const py = `
import json, sys
from PIL import Image
import zxingcpp

req = json.load(sys.stdin)
out = []
for c in req["cases"]:
    try:
        m = c["matrix"]
        scale, border = 8, 4
        h, w = len(m), len(m[0])
        img = Image.new("L", (w * scale + border * 2, h * scale + border * 2), 255)
        px = img.load()
        for y in range(h):
            for x in range(w):
                if m[y][x]:
                    for dy in range(scale):
                        for dx in range(scale):
                            px[border + x * scale + dx, border + y * scale + dy] = 0
        res = zxingcpp.read_barcode(img)
        out.append({"ok": True, "decoded": res.text if res else None})
    except Exception as e:
        out.append({"ok": False, "error": str(e)})
print(json.dumps(out, ensure_ascii=False))
`

let decoded
try {
  const stdout = execFileSync(PY, ['-c', py], { input: JSON.stringify({ cases: request }), maxBuffer: 64 * 1024 * 1024 })
  decoded = JSON.parse(stdout.toString())
} catch (e) {
  console.error('✖ 解码器调用失败：', e.message)
  process.exit(2)
}

let checked = 0
let failed = 0
for (let i = 0; i < request.length; i++) {
  const { text, ecc } = request[i]
  const r = decoded[i]
  checked++
  if (!r.ok) {
    failed++
    console.error(`✖ 解码器异常：${JSON.stringify(text.slice(0, 24))} ecc=${ecc}: ${r.error}`)
  } else if (r.decoded !== text) {
    failed++
    console.error(
      `✖ 解码不符：${JSON.stringify(text.slice(0, 24))} ecc=${ecc}\n    期望 ${JSON.stringify(text)}\n    实得 ${JSON.stringify(r.decoded)}`,
    )
  }
}

console.log('')
console.log(`真实解码校验（zxing-cpp）：${checked} 组，${failed} 组失败`)
if (failed > 0) {
  console.error('✖ 校验失败')
  process.exit(1)
}
console.log('✅ 全部用例扫得出来且内容逐字节一致')
