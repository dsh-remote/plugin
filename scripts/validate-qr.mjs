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
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
// 重写之后 qr 编码器住在 platform/ 下（只有它认识渲染细节，core 不认），
// 而且全部改成异步：node-qrcode 的 API 是 promise 形的。
const qrModule = path.join(root, 'dsh-remote-control', 'packages', 'plugin', 'dist', 'src', 'platform', 'qr.js')

if (!existsSync(qrModule)) {
  console.error(`✖ 先构建：找不到 ${qrModule}（cd dsh-remote-control/packages/plugin && env -u NODE_OPTIONS pnpm build）`)
  process.exit(2)
}

const PY = '/Users/linbin/.workbuddy/binaries/python/envs/default/bin/python'
if (!existsSync(PY)) {
  console.error(`✖ 找不到校验用的 venv：${PY}\n  创建：python3 -m venv <path> && <path>/bin/pip install zxing-cpp pillow segno`)
  process.exit(2)
}

const { qrMatrix, qrPng } = await import(pathToFileURL(qrModule).href)

const PAYLOADS = [
  'dshr:/p?v=1&s=wss%3A%2F%2Frelay.example.invalid&n=demo-host&psk=ZmFrZS1wc2srZmFrZQ%2BZmFrZQ%3D%3D&t=424242',
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

const request = []
for (const { text, ecc } of cases) {
  // 两条产物都要过：
  //   1) 图片 PNG —— 配对二维码唯一的出口（状态栏那颗 pill 的 `GET /pairing.png`）；
  //   2) 裸矩阵 —— 控制对照：证明解码失败时该怪渲染层，不是编码器。
  // 曾经这里还有第三条"半块文本字形"（`renderTerminalQr` 的字符→模块映射）。文本码整个删了：
  // DSH 命令卡把等宽输出按 `line-height:1.6` 渲染，行间留白将半块码横切成条，
  // 实测 zxing ≥1.15 行距即失败，而宿主固定 1.6 —— "文本码能扫"在唯一宿主上从来不成立。
  const rendered = await qrMatrix(text, ecc, 2)
  request.push({
    text,
    ecc,
    matrix: rendered.map((row) => row.map((v) => (v ? 1 : 0))),
    png: (await qrPng(text, { ecc, scale: 8 })).toString('base64'),
  })
}

const py = `
import json, sys, base64, io
from PIL import Image
import zxingcpp


def raster(m, scale=8, border=4):
    h, w = len(m), len(m[0])
    img = Image.new("L", (w * scale + border * 2, h * scale + border * 2), 255)
    px = img.load()
    for y in range(h):
        for x in range(w):
            if m[y][x]:
                for dy in range(scale):
                    for dx in range(scale):
                        px[border + x * scale + dx, border + y * scale + dy] = 0
    return img

req = json.load(sys.stdin)
out = []
for c in req["cases"]:
    rec = {"png": False, "matrix": False, "ok": True}
    try:
        img = Image.open(io.BytesIO(base64.b64decode(c["png"])))
        res = zxingcpp.read_barcode(img)
        rec["png"] = bool(res is not None and res.text == c["text"])

        res = zxingcpp.read_barcode(raster(c["matrix"]))
        rec["matrix"] = bool(res is not None and res.text == c["text"])
    except Exception as e:
        rec["ok"] = False
        rec["error"] = str(e)
    out.append(rec)
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

const KINDS = [
  ['png', '图片 PNG（配对唯一的出口）'],
  ['matrix', '裸矩阵'],
]

let checked = 0
let failed = 0
for (let i = 0; i < request.length; i++) {
  const { text, ecc } = request[i]
  const r = decoded[i]
  checked++
  if (!r.ok) {
    failed++
    console.error(`✖ 解码器异常：${JSON.stringify(text.slice(0, 24))} ecc=${ecc}: ${r.error}`)
    continue
  }
  for (const [key, label] of KINDS) {
    if (!r[key]) {
      failed++
      console.error(`✖ ${label} 解不出或不符：${JSON.stringify(text.slice(0, 24))} ecc=${ecc}`)
    }
  }
}

console.log('')
console.log(`真实解码校验（zxing-cpp）：${checked} 组用例 × ${KINDS.length} 种产物，${failed} 项失败`)
if (failed > 0) {
  console.error('✖ 校验失败')
  process.exit(1)
}
console.log(`✅ ${KINDS.map(([, label]) => label).join('、')}两条路径都扫得出来且内容逐字节一致`)

