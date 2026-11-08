// Every package's build and self-checks, then the client check — the same on Windows, Linux and macOS (the CI runs it on
// all three). A check that only makes sense on a Unix (the bash `ruyix` command) is skipped on Windows, and says so.
// Usage: node tools/check-all.mjs [--no-build] [--only <package dir>…]
// React for the client checks comes from dsh's profiles (~/.dsh/profiles/node_modules) or RUYIX_REACT_DIR.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const PACKAGES = {
  'core/connectors': ['check.mjs'],
  'core/plugins/agent-hub': ['check.mjs', 'sessions-check.mjs', 'task-feed-check.mjs'],
  'core/workbench': ['check.mjs', 'config-check.mjs', 'store-check.mjs', 'flow-check.mjs', 'versions-check.mjs', 'browser-check.mjs', 'schedule-check.mjs', 'activity-check.mjs', 'tasks-check.mjs', 'viewer-check.mjs', 'results-ui-check.mjs'],
  'packs/plume': ['check.mjs', 'research-check.mjs', 'knowledge-check.mjs', 'adaptation-check.mjs', 'ui-check.mjs', 'platform-ui-check.mjs'],
  'packs/video': ['check.mjs', 'engine-check.mjs', 'ui-check.mjs'],
  'packs/newsletter': ['check.mjs', 'engine-check.mjs'],
  'core/board': ['check.mjs'],
  'core/messages': ['check.mjs'],
  'core/plugins/box': ['check.mjs'],
  'core/plugins/apps': ['check.mjs', 'browser-check.mjs'],
  'core/plugins/world': ['check.mjs'],
  'core/plugins/studio': ['check.mjs', 'feedback-check.mjs', 'feedback-ui-check.mjs', 'file-check.mjs'],
  'core/plugins/web': ['check.mjs'],
  'core/shell': ['check.mjs', 'async-check.mjs', 'config-check.mjs', 'data-check.mjs', 'cli-check.mjs', 'system-check.mjs', 'cards-check.mjs', 'open-sweep-check.mjs', 'answers-check.mjs', 'system-serve-check.mjs', 'find-check.mjs'],
  tools: ['release-check.mjs'],
}
// bin/ruyix is a bash program (Linux, macOS, a nookbox box); on Windows Ruyix starts with dsh itself (tools/dev-install.mjs).
// ruyix data moves a home into a nookbox box, and nookbox runs on macOS and Linux.
const UNIX_ONLY = new Set(['core/shell/cli-check.mjs', 'core/shell/data-check.mjs', 'core/shell/system-serve-check.mjs'])
const args = process.argv.slice(2)
const noBuild = args.includes('--no-build')
const only = args.includes('--only') ? args.slice(args.indexOf('--only') + 1) : null
const node = (cwd, file) => spawnSync(process.execPath, [file], { cwd, stdio: 'pipe', encoding: 'utf8', timeout: 20 * 60000, env: process.env })
const results = []
for (const [dir, checks] of Object.entries(PACKAGES)) {
  if (only && !only.includes(dir)) continue
  const cwd = join(root, dir)
  if (!noBuild && existsSync(join(cwd, 'build.mjs'))) {
    const b = node(cwd, 'build.mjs')
    results.push({ name: `${dir}/build.mjs`, ok: b.status === 0, out: `${b.stdout}${b.stderr}` })
  }
  for (const c of checks) {
    const name = `${dir}/${c}`
    if (WIN && UNIX_ONLY.has(name)) { results.push({ name, ok: true, skipped: 'not on Windows' }); continue }
    const started = Date.now(), r = node(cwd, c)
    results.push({ name, ok: r.status === 0, ms: Date.now() - started, out: `${r.stdout}${r.stderr}` })
  }
}
if (!only) { const r = node(root, join('tools', 'client-check.mjs')); results.push({ name: 'tools/client-check.mjs', ok: r.status === 0, out: `${r.stdout}${r.stderr}` }) }
for (const r of results) {
  const last = String(r.out || '').trim().split('\n').filter(Boolean).at(-1) || ''
  console.log(`${r.ok ? (r.skipped ? '–' : '✓') : '✗'} ${r.name}${r.skipped ? ` (${r.skipped})` : r.ms ? ` ${Math.round(r.ms / 1000)}s` : ''}${r.ok ? '' : `\n${String(r.out).trim().split('\n').slice(-40).map(l => `    ${l}`).join('\n')}`}${r.ok && !r.skipped && last ? ` — ${last.slice(0, 100)}` : ''}`)
}
const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} failed` : '\nall checks: ok')
process.exit(failed.length ? 1 : 0)
