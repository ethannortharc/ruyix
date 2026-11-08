// Starts Ruyix the way a person does after tools/dev-install.mjs and checks it answers: dsh with the profile, its sign-in
// link, the cookie that link gives, and Ruyix's own route behind it (the plugins loaded on the server). Then stops it.
// The same on Windows, macOS and Linux (the CI runs it after the install).
//   node tools/smoke.mjs [--profile ruyix] [--port 3190]
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const args = process.argv.slice(2)
const opt = (name, value) => (args.includes(name) ? args[args.indexOf(name) + 1] : value)
const PROFILE = opt('--profile', 'ruyix'), PORT = Number(opt('--port', '3190'))
const DSH_VERSION = JSON.parse(readFileSync(join(root, 'core/shell/package.json'), 'utf8')).ruyix.dsh
const APP_DSH = WIN ? [] : ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh']
const appDsh = APP_DSH.find(p => existsSync(p))
const [cmd, pre] = process.env.DSH_CLI ? [process.env.DSH_CLI, []] : appDsh ? [appDsh, []] : [WIN ? 'npx.cmd' : 'npx', ['-y', `@deepseek-ai/dsh@${DSH_VERSION}`]]

// npx from the home folder, without this checkout's .npmrc (see dev-install.mjs)
const child = spawn(cmd, [...pre, '--profile', PROFILE, '--no-open', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: homedir(), env: { ...process.env, npm_config_legacy_peer_deps: 'false' }, shell: WIN, stdio: ['ignore', 'pipe', 'pipe'], detached: !WIN, windowsHide: true })
let out = ''
const stop = () => {
  if (WIN) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  else try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
}
const fail = msg => { console.error(`✗ ${msg}\n--- dsh said ---\n${out.slice(-3000)}`); stop(); process.exit(1) }
const link = await new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), 5 * 60000)
  const seen = d => {
    out += d
    const m = new RegExp(`http://127\\.0\\.0\\.1:${PORT}/\\?token=[A-Za-z0-9_-]+`).exec(out)
    if (m) { clearTimeout(timer); resolve(m[0]) }
  }
  child.stdout.on('data', seen); child.stderr.on('data', seen)
  child.on('exit', code => { clearTimeout(timer); resolve(null); if (code) out += `\n(exited ${code})` })
})
if (!link) fail('dsh printed no sign-in link')
console.log(`✓ dsh is up on port ${PORT}`)
try {
  const r = await fetch(link, { redirect: 'manual' })
  const cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ')
  if (!cookie) fail(`the sign-in link gave no cookie (${r.status})`)
  console.log('✓ the sign-in link signs in')
  const id = await fetch(`http://127.0.0.1:${PORT}/api/ruyix/identity`, { headers: { cookie } })
  const body = id.ok ? await id.json() : null
  if (body?.product !== 'ruyix') fail(`Ruyix's route did not answer (${id.status}): the plugins did not load`)
  console.log(`✓ Ruyix answers (profile ${body.profile})`)
  const page = await fetch(`http://127.0.0.1:${PORT}/`, { headers: { cookie } })
  if (!page.ok) fail(`the page did not load (${page.status})`)
  console.log('✓ the page loads')
} catch (err) { fail(err.message) }
stop()
console.log('smoke: ok')
process.exit(0)
