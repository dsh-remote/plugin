/**
 * main — 中继进程入口。
 *
 * 启动纪律（旧实现用线上运行换来的，逐条保留）：
 * - 没有 `DRC_HOST_TOKEN` 就**拒绝启动**（CI 里专门有一条断言这条）；短于 24 字符只告警。
 * - 只绑 `127.0.0.1`：TLS 由反代终止，中继没理由出现在局域网里。
 * - `SIGTERM`/`SIGINT` → 停止接受新连接 → 向所有对端发 `1001` → 等在途结束 → **exit 0**；
 *   5 秒兜底强退。测试断言 exit 码与对端收到的关闭码。
 * - `uncaughtException` 记账后 exit 1，把重启交给 systemd（`Restart=always`）——
 *   无值守进程里"活着但坏了"比"死了被拉起来"更糟。
 */
import { readFileSync } from 'node:fs'
import { loadConfig, type ConfigProblem } from './config.js'
import { Log } from './log.js'
import { createRelay } from './server.js'

/** 打包时由 `scripts/bundle-relay.mjs` 以 esbuild define 注入；未打包时这个标识符不存在。 */
declare const __DRC_VERSION__: string | undefined

function readVersion(): string {
  // 顺序很重要：**先读编译期注入的值**。生产部署就是 scp 一个 `main.js`，
  // 文件旁边没有 package.json，两条相对路径探针都会落空，`/healthz` 的 version
  // 会变成 `0.0.0`——而运维正是靠这个字段判断线上跑的是哪一版。
  if (typeof __DRC_VERSION__ === 'string' && __DRC_VERSION__) return __DRC_VERSION__
  // 开发态（tsc 产物 dist/src/）往上两层才是包目录，还能按文件读。
  for (const candidate of ['../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8')) as { version?: string }
      if (typeof pkg.version === 'string') return pkg.version
    } catch {
      /* 试下一个位置 */
    }
  }
  return '0.0.0'
}

function reportProblems(problems: ConfigProblem[]): boolean {
  let fatal = false
  for (const problem of problems) {
    if (problem.level === 'error') fatal = true
    process.stderr.write(`[drc-relay] ${problem.level}: ${problem.message}\n`)
  }
  return fatal
}

async function main(): Promise<void> {
  const { config, problems } = loadConfig(process.env, readVersion())
  if (reportProblems(problems)) {
    process.exit(1)
  }
  const relay = createRelay(config)
  const { port, bind } = await relay.startListening()
  relay.log.info('relay listening', { port, bind, publicUrl: config.publicUrl, version: config.version })

  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    relay.log.info('shutting down', { signal })
    const guard = setTimeout(() => {
      relay.log.warn('shutdown timed out, forcing exit')
      process.exit(0)
    }, 5000)
    guard.unref()
    void relay.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('uncaughtException', (error) => {
    relay.log.error('uncaught exception', { message: String(error?.message ?? error) })
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    relay.log.error('unhandled rejection', { message: String((reason as Error)?.message ?? reason) })
    process.exit(1)
  })
}

void main().catch((error: unknown) => {
  process.stderr.write(`[drc-relay] fatal: ${String((error as Error)?.stack ?? error)}\n`)
  process.exit(1)
})
