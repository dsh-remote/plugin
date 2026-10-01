/**
 * Inline @dsh-rc/protocol into the plugin's build output.
 *
 * Why: the plugin is installed into a DSH profile with
 *   `pnpm add -w file:/path/to/packages/plugin`
 * and pnpm cannot resolve a `workspace:*` dependency outside this monorepo —
 * it fails with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. So the protocol package is
 * a devDependency (build time only, resolved through the workspace link) and
 * its compiled JS is copied next to the plugin's output, with the bare
 * specifier rewritten to a relative one.
 *
 * Result: `packages/plugin/dist` is self-contained — runtime deps are only
 * ws / tweetnacl / tweetnacl-util, all from the registry.
 */
import { cpSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const PROTOCOL_DIST = join(ROOT, 'packages/protocol/dist/src')
const PLUGIN_DIST = join(ROOT, 'packages/plugin/dist')
const TARGET = join(PLUGIN_DIST, 'protocol')
const SPECIFIER = '@dsh-rc/protocol'

if (!statSync(PROTOCOL_DIST, { throwIfNoEntry: false })) {
  console.error('[bundle-protocol] missing', PROTOCOL_DIST, '— run `pnpm -r build` first')
  process.exit(1)
}

rmSync(TARGET, { recursive: true, force: true })
cpSync(PROTOCOL_DIST, TARGET, { recursive: true })

const ENTRY = join(TARGET, 'index.js')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.js') || name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

let rewritten = 0
for (const file of walk(PLUGIN_DIST)) {
  if (file.startsWith(TARGET)) continue // don't rewrite the copy itself
  const src = readFileSync(file, 'utf8')
  if (!src.includes(SPECIFIER)) continue
  // POSIX-style relative path from this file to dist/protocol/index.js
  let rel = posix.relative(posix.dirname(file.split(/\/|\\/).join('/')), ENTRY.split(/\/|\\/).join('/'))
  if (!rel.startsWith('.')) rel = './' + rel
  const next = src.replace(
    /(['"])@dsh-rc\/protocol\1/g,
    (_m, q) => `${q}${rel}${q}`,
  )
  if (next !== src) {
    writeFileSync(file, next)
    rewritten++
  }
}

console.log(`[bundle-protocol] inlined @dsh-rc/protocol -> dist/protocol (${rewritten} file(s) rewritten)`)
