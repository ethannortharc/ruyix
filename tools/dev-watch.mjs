// Development: rebuilds the browser bundles while you edit, so a page refresh shows the change — on this machine's dsh
// (tools/dev-install.sh) or a box running this checkout (ruyix dev). `npm run dev` at the repo root; Ctrl-C stops.
// Server-side changes need dsh to restart: ruyix restart, or ruyix dev --watch in a box.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundles = [...readdirSync(join(root, 'core')).map(d => `core/${d}`), ...readdirSync(join(root, 'core/plugins')).map(d => `core/plugins/${d}`), ...readdirSync(join(root, 'packs')).map(d => `packs/${d}`)]
  .filter(d => existsSync(join(root, d, 'build.mjs')))
const build = dir => new Promise(done => spawn(process.execPath, ['build.mjs', '--dev'], { cwd: join(root, dir), stdio: ['ignore', 'pipe', 'inherit'] })
  .on('exit', code => done(code === 0 ? null : dir)))
// ponytail: every bundle rebuilds on any client change (a few seconds); map sources to bundles if that gets slow
let busy = false, again = false, timer = null
async function rebuild(why) {
  if (busy) { again = true; return }
  busy = true
  const t = Date.now(), failed = (await Promise.all(bundles.map(build))).filter(Boolean)
  console.log(`${new Date().toTimeString().slice(0, 8)} ${why}: ${bundles.length - failed.length}/${bundles.length} bundles in ${Date.now() - t} ms${failed.length ? ` — failed: ${failed.join(', ')}` : ''}`)
  busy = false
  if (again) { again = false; rebuild('more changes') }
}
export const client = f => {
  const path = String(f).replace(/\\/g, '/')
  return /\.(jsx?|mjs|css)$/.test(path) && /(^|\/)(src|client)\//.test(path) && !/node_modules|(^|\/)client\.js$/.test(path)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const dir of ['core', 'packs']) watch(join(root, dir), { recursive: true }, (_, f) => {
    if (!f || !client(f)) return
    clearTimeout(timer)
    timer = setTimeout(() => rebuild(f), 150)
  })
  await rebuild('start')
  console.log('watching core/ and packs/ — refresh the page after a rebuild')
}
