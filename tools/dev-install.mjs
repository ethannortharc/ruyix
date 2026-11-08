// Installs Ruyix from this checkout into a dsh profile — on Windows, macOS and Linux, with nothing but Node
// (tools/dev-install.sh is the same for a Unix shell). Re-runnable.
//   node tools/dev-install.mjs [--profile ruyix] [--no-browsers] [--no-checks]
// 1. what this machine needs (Node 22.5+, npm, pnpm, git), 2. npm install, every package
// built and checked, 3. the dsh profile with the plugins linked, 4. Playwright and Chromium (cards, sign-ins), 5. how to
// start it. dsh is found in this order: $DSH_CLI, the DeepSeek Harness app's CLI, `npx @deepseek-ai/dsh@<the tested one>`.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const args = process.argv.slice(2)
const PROFILE = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'ruyix'
const BROWSERS = !args.includes('--no-browsers'), CHECKS = !args.includes('--no-checks')
const DSH_VERSION = JSON.parse(readFileSync(join(root, 'core/shell/package.json'), 'utf8')).ruyix.dsh
const PLUGINS = ['core/connectors', 'core/plugins/agent-hub', 'core/plugins/apps', 'core/workbench', 'core/plugins/studio', 'core/plugins/web', 'packs/plume', 'packs/video', 'packs/newsletter', 'core/plugins/world', 'core/shell']
const todo = []
const say = s => console.log(`\n▸ ${s}`)
const ok = s => console.log(`  ✓ ${s}`)
const warn = s => { console.log(`  ! ${s}`); todo.push(s) }
const die = s => { console.error(`✗ ${s}`); process.exit(1) }
/** A command, its output; on Windows through the shell (npm, npx, pnpm are .cmd files). */
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', shell: WIN, stdio: opts.inherit ? 'inherit' : 'pipe', cwd: opts.cwd || root, env: { ...process.env, ...opts.env } })
const has = (cmd, flag = '--version') => run(cmd, [flag]).status === 0

// dsh: $DSH_CLI, the app's own CLI, else npx with the version the shell names
const APP_DSH = WIN
  ? [join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), join(process.env.ProgramFiles || 'C:\\Program Files', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')]
  : ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh']
const appDsh = APP_DSH.find(p => p && existsSync(p))
// npx from the home folder: this checkout's .npmrc (legacy-peer-deps, for the plugins' own installs) would leave out
// the peer packages dsh needs
// quiet: its output only when it fails (making a profile prints the whole config)
const dsh = (argv, { quiet = false } = {}) => {
  const o = { inherit: !quiet }
  const r = process.env.DSH_CLI ? run(process.env.DSH_CLI, argv, o) : appDsh ? run(appDsh, argv, o)
    : run(WIN ? 'npx.cmd' : 'npx', ['-y', `@deepseek-ai/dsh@${DSH_VERSION}`, ...argv], { ...o, cwd: homedir(), env: { npm_config_legacy_peer_deps: 'false' } })
  if (quiet && r.status !== 0) console.error(`${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-30).join('\n'))
  return r
}
const dshText = process.env.DSH_CLI || (appDsh ? `"${appDsh}"` : `npx -y @deepseek-ai/dsh@${DSH_VERSION}`)

say('This machine')
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 5)) die(`Node ${process.versions.node} is too old: 22.5 or newer`)
ok(`Node ${process.versions.node}`)
for (const c of ['npm', 'git']) if (!has(c)) die(`${c} is missing`)
if (!has('pnpm')) {
  run('npm', ['install', '-g', 'pnpm@11', '--no-audit', '--no-fund', '--loglevel=error'])
  if (!has('pnpm')) die('pnpm is missing: npm install -g pnpm@11')
}
ok('npm, pnpm, git')
if (!has('codex') && !has('claude')) warn('no agent CLI yet: install Codex (npm i -g @openai/codex; codex login) or Claude Code — or from Agents → Runtimes')

say('Build and check')
if (run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { inherit: true }).status !== 0) die('npm install failed')
if (CHECKS) { if (run(process.execPath, [join('tools', 'check-all.mjs')], { inherit: true }).status !== 0) die('a self-check failed (above): nothing was linked') }
else for (const p of PLUGINS) if (run(process.execPath, ['build.mjs'], { cwd: join(root, p) }).status !== 0) die(`${p}: build failed`)

say(`The dsh profile "${PROFILE}"`)
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// an install from when Ruyix was Aviary or Agnos: its home and profile move over first, before anything here makes a new one
if (!WIN && run('bash', [join(root, 'core/shell/bin/ruyix'), 'migrate'], { inherit: true }).status !== 0) warn('the older install (~/.aviary or ~/.agnos) did not move over: ruyix migrate to retry')
if (!existsSync(join(DSH_HOME, 'profiles', PROFILE)) && dsh(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], { quiet: true }).status !== 0) die(`dsh could not make the profile ${PROFILE}`)
const links = PLUGINS.map(p => `link:${join(root, p).replace(/\\/g, '/')}`)
if (dsh(['plugin', '--profile', PROFILE, 'add', ...links], { quiet: true }).status !== 0) die('dsh could not add the plugins')
ok(PLUGINS.join(', '))

say('Runtime')
const ui = process.env.RUYIX_UI_RUNTIME || join(process.env.RUYIX_WORKBENCH_HOME || join(homedir(), '.ruyix/workbench'), 'ui-runtime')
mkdirSync(ui, { recursive: true })
if (!existsSync(join(ui, 'package.json'))) writeFileSync(join(ui, 'package.json'), JSON.stringify({ name: 'ruyix-ui-runtime', private: true, type: 'module', dependencies: { playwright: '^1.63.0' } }, null, 1))
if (run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ui }).status === 0) ok('Playwright (cards, browser sign-ins)')
else warn(`Playwright did not install in ${ui}`)
if (BROWSERS) {
  if (run(WIN ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'], { cwd: ui }).status === 0) ok('Chromium')
  else warn(`Chromium did not install: npx playwright install chromium (in ${ui})`)
}

say('Done')
console.log(`  Start Ruyix:  ${dshText} --profile ${PROFILE} --no-open --host 127.0.0.1 --port 3280`)
console.log('  It prints a sign-in link (http://127.0.0.1:3280/?token=…); open it in a browser.')
if (todo.length) console.log(`\nStill to do:\n${todo.map(t => `  - ${t}`).join('\n')}`)
