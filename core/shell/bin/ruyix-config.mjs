// One configuration for Ruyix, on the host or in a nookbox box:
//   ruyix config export [--out ruyix-config.json] [--secrets ruyix-secrets.env]
//   ruyix config import <ruyix-config.json> [--secrets ruyix-secrets.env]
// ruyix-config.json (version 2) is shareable: the workspaces (where, and the git repositories to clone), each plugin's
// settings, the workspaces' plain .env values, Agent Hub's agents and skill packs, and the connections (the
// connectors plugin's) with the credentials each holds — as nookbox secrets, never a value.
// ruyix-secrets.env (NAME=value, 0600) holds the values and stays on the machine. The "secrets" list is also what nookbox
// reads (nookbox up --config … --secrets …): there the values go to the host's vault and the box holds placeholders
// under the same names, which the import inside the box gives the connections.
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const KIND = 'ruyix-config'
const tilde = (p, home) => (typeof p === 'string' && p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p)
const expand = (p, home) => (typeof p === 'string' && p.startsWith('~/') ? join(home, p.slice(2)) : p)
// Ruyix's own state: a configuration's checkout or file never lands there, nor above it (its settings go through the
// filtered merges only, so a profile cannot turn on what is the owner's to turn on)
const STATE = ['.ruyix', '.dsh']
/** A path as the kernel takes it: its longest existing prefix realpath'd (symlinks and .. in their order), then the rest —
 *  plain names only. → the real path, or null when it cannot be told */
export function realOf(p, depth = 0) {
  if (depth > 20) return null
  const parts = String(p).split('/')
  for (let n = parts.length; n > 0; n--) {
    let real
    try { real = realpathSync.native(parts.slice(0, n).join('/') || '/') } catch { continue }
    const rest = parts.slice(n).filter(Boolean)
    if (rest.some(x => x === '.' || x === '..')) return null
    // where the rest begins, a symlink to nowhere yet: what it points at, then the rest after it
    const first = rest.length && join(real, rest[0])
    let link = null
    try { link = first && lstatSync(first).isSymbolicLink() && readlinkSync(first) } catch { /* not there */ }
    if (link) return link.split('/').includes('..') ? null : realOf(join(resolve(real, link), ...rest.slice(1)), depth + 1)
    return join(real, ...rest)
  }
  return null
}
/** Where a configuration may put a checkout or a file: its real path, or null — inside Ruyix's state, above it, or unclear. */
export function safeDest(p, home) {
  const real = realOf(p)
  if (!real || real === '/') return null // the root is above everything
  const h = realOf(home) || home
  // a state directory whose place cannot be told: nothing goes anywhere (its lexical path may not be where it lives)
  const hit = STATE.some(d => { const s = realOf(join(h, d)); return !s || real === s || real.startsWith(`${s}/`) || s.startsWith(`${real}/`) })
  return hit ? null : real
}
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return undefined } }
function writeFile(f, text, mode = 0o644) {
  mkdirSync(dirname(f), { recursive: true })
  // a fresh name, created only if nothing is there (no symlink planted at a guessable name redirects the write)
  const tmp = `${f}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, text, { mode, flag: 'wx' })
  renameSync(tmp, f)
  chmodSync(f, mode)
}
const writeJson = (f, v) => writeFile(f, `${JSON.stringify(v, null, 2)}\n`)

// ── dotenv, the way the plugins and the workspace helpers read it ──
export function readDotenv(text) {
  const out = {}
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}
const envLine = (k, v) => (/[\s#'"]/.test(v) ? (v.includes('"') ? `${k}='${v}'` : `${k}="${v}"`) : `${k}=${v}`)
/** Set keys in a dotenv file, keeping every other line (the first definition replaced, later ones dropped). */
export function setEnvKeys(file, values) {
  let lines = []
  try { lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n') } catch { /* a new file */ }
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`)
    const at = lines.findIndex(l => re.test(l))
    if (at < 0) lines.push(envLine(k, v))
    else lines = lines.filter((l, i) => i === at || !re.test(l)).map((l, i) => (i === at ? envLine(k, v) : l))
  }
  writeFile(file, `${lines.filter((l, i) => l || i < lines.length - 1).join('\n')}\n`, 0o600)
}

// ── what the products keep where: each product plugin's package.json says, "ruyix": { "config": { <product>: { settingsKey
// (its key in ruyix-config.json), settingsFile (in the home), workspace (where it is unless its settings say), envFile (in
// the workspace), repoSetting / repoDefault (a checkout inside it) } } } — the plugins next to this one: an install's
// @ruyix folder, or a checkout's core/ and core/plugins/ ──
const HERE = dirname(fileURLToPath(import.meta.url))
export function productsIn(roots = [join(HERE, '../..'), join(HERE, '../../plugins')]) {
  const out = {}
  for (const root of roots.filter(r => existsSync(r))) for (const d of readdirSync(root)) Object.assign(out, readJson(join(root, d, 'package.json'))?.ruyix?.config)
  return out
}
// a workspace .env line that looks like a credential is not carried: credentials are connections' (Connectors page)
const SECRETISH = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE)/i
const git = (args, cwd) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }

/**
 * The configuration of this home: { config, secrets, skipped } — secrets: name → value (only with `values`); skipped:
 * workspace .env credentials not carried. `connectors` is the connectors service (in dsh); without it the connections
 * file alone (no credentials list: that needs the running dsh).
 */
export async function exportConfig({ home = homedir(), env = process.env, connectors = null, values = false, products = productsIn() } = {}) {
  const hubHome = env.DSH_AGENT_HUB_HOME || join(home, '.ruyix/agent-hub')
  const config = { kind: KIND, version: 2, workspaces: {}, settings: {}, env: {}, connections: [], secrets: [] }
  const skipped = []
  const conn = connectors ? await connectors.exportData({ values }) : { connections: readJson(join(home, '.ruyix/connectors/connections.json'))?.connections?.map(({ createdAt, updatedAt, ...c }) => c) || [], secrets: [] }
  config.connections = conn.connections
  config.secrets = conn.secrets

  for (const [product, p] of Object.entries(products)) {
    const settings = readJson(join(home, p.settingsFile))
    if (settings) config.settings[p.settingsKey] = JSON.parse(JSON.stringify(settings, (k, v) => (typeof v === 'string' ? tilde(v, home) : v)))
    const ws = expand(settings?.workspace || p.workspace, home)
    if (!existsSync(ws)) continue
    const repos = []
    const inner = p.repoSetting && (settings?.[p.repoSetting] || p.repoDefault)
    if (inner && existsSync(join(ws, inner, '.git'))) repos.push({ path: inner, repo: git(['remote', 'get-url', 'origin'], join(ws, inner)) })
    config.workspaces[product] = { path: tilde(ws, home), repo: git(['remote', 'get-url', 'origin'], ws), ...(repos.length && { repos }) }
    // the workspace's plain values travel (its own scripts read them); its credentials are connections now
    const env = readDotenv(existsSync(join(ws, p.envFile)) ? readFileSync(join(ws, p.envFile), 'utf8') : '')
    for (const [key, value] of Object.entries(env)) {
      if (SECRETISH.test(key)) skipped.push(`${product}: ${key}`)
      else (config.env[product] ??= {})[key] = value
    }
  }

  // Agent Hub's skill packs and agents
  const packs = readJson(join(hubHome, 'skill-packs.json'))
  if (packs) config.settings['agent-hub'] = { skillPacks: packs }
  const agents = exportAgents(join(hubHome, 'hub.db'))
  if (agents) config.agents = agents
  const ruyixConf = readDotenv(existsSync(join(home, '.ruyix/config')) ? readFileSync(join(home, '.ruyix/config'), 'utf8').replace(/\s+#.*$/gm, '') : '')
  if (ruyixConf.RUYIX_PORT) config.ruyix = { port: Number(ruyixConf.RUYIX_PORT), trustedHost: ruyixConf.RUYIX_TRUSTED_HOST || '', url: ruyixConf.RUYIX_URL || '' }
  return { config, secrets: conn.values || {}, skipped }
}

/** Agent Hub's agent pool and default agent, in its shareable format (an agents file); none: null. */
function exportAgents(db) {
  if (!existsSync(db)) return null
  let rows = []
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const h = new DatabaseSync(db, { readOnly: true })
    rows = h.prepare("SELECT kind, data FROM docs WHERE kind IN ('agent', 'config')").all().map(r => ({ kind: r.kind, ...JSON.parse(r.data) }))
    h.close()
  } catch { return null }
  const agents = rows.filter(r => r.kind === 'agent' && !r.deleted).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  if (!agents.length) return null
  return { kind: 'dsh-agents', version: 1, defaultAgent: rows.find(r => r.kind === 'config' && r.id === 'hub')?.defaultAgent || null,
    agents: agents.map(({ id, name, runtime, model, effort, access, skills, notes, endpoint, browser }) => ({ id, name, runtime, model, effort, access: access || null, skills: skills || [], notes: notes || '', ...(endpoint && { endpoint }), ...(browser === false && { browser: false }) })) }
}

/** Parse ruyix-secrets.env: NAME=value; a file's content as base64:… */
export const readSecrets = text => readDotenv(text)
export function secretsText(secrets) {
  // a value of several lines (a kubeconfig, a key file) goes as base64:… — one line, as nookbox reads it too
  const line = ([k, v]) => envLine(k, /[\r\n]/.test(v) ? `base64:${Buffer.from(v).toString('base64')}` : v)
  return `# Ruyix credentials — the values for ruyix-config.json's "secrets". Keep this file private (0600).\n${Object.entries(secrets).map(line).join('\n')}\n`
}

/** A live configuration import owns staging through all plugin consumers, before any file is changed. */
export function createConfigImporter({ parts = () => [], connectors = () => null, apply = importConfig } = {}) {
  let active = false
  return async (config, secrets = {}) => {
    const c = connectors(), list = [...parts()]
    if (active || c?.importing?.() || list.some(p => p.importing?.())) throw Object.assign(new Error('a configuration import is already running; wait for it to finish, then try again'), { code: 'importBusy' })
    active = true
    try {
      const report = await apply(config, secrets)
      for (const p of list) {
        try {
          const rows = await p.imported?.()
          if (Array.isArray(rows)) report.push(...rows.filter(r => typeof r?.ok === 'boolean' && typeof r.text === 'string'))
        } catch (err) { report.push({ ok: false, text: `${p.id || 'plugin'} import: ${err?.message || err}` }) }
      }
      for (const r of await c?.takeImport?.() || []) report.push({ ok: r.ok, text: r.ok ? `connection ${r.id}` : `connection ${r.id}: ${r.error}` })
      return report
    } finally { active = false }
  }
}

/**
 * Apply a configuration to this home; values from `secrets`, else from the environment (a box's placeholders) or the
 * file nookbox placed. The connections and their values are left for the connectors plugin, which takes them in at its
 * next start (or at once, when dsh imports: its caller then asks it to).
 */
export async function importConfig(config, secrets = {}, { home = homedir(), dshHome = join(home, '.dsh'), env = process.env, inBox = !!env.NOOKBOX_API, clone = cloneRepo, products = productsIn() } = {}) {
  const hubHome = env.DSH_AGENT_HUB_HOME || join(home, '.ruyix/agent-hub')
  if (config?.kind !== KIND) throw new Error(`not a ${KIND} file`)
  if (config.version !== 2) throw new Error(`${KIND} version ${config.version ?? '?'}: this Ruyix reads version 2`)
  const report = []
  const say = (ok, text) => report.push({ ok, text })
  // workspaces first: the .env files live in them
  for (const [product, w] of Object.entries(config.workspaces || {})) {
    const ws = safeDest(expand(w.path, home), home)
    if (!ws) { say(false, `${product} workspace ${w.path}: refused — Ruyix's own state, above it, or a path that cannot be told`); continue }
    if (!existsSync(join(ws, '.git')) && w.repo) say(await clone(w.repo, ws, inBox), `${product} workspace ${w.path}`)
    for (const r of w.repos || []) {
      const dir = safeDest(join(ws, r.path), home)
      if (!dir) { say(false, `${product} repository ${r.path}: refused — Ruyix's own state, above it, or a path that cannot be told`); continue }
      if (existsSync(join(ws, '.git')) && !existsSync(join(dir, '.git')) && r.repo) say(await clone(r.repo, dir, inBox), `${product} repository ${r.path}`)
    }
  }
  // settings: each plugin's file, the imported keys over what is there
  const merge = (file, value, base = home) => { const f = join(base, file); writeJson(f, { ...(readJson(f) || {}), ...value }); say(true, `settings ${file}`) }
  for (const p of Object.values(products)) if (config.settings?.[p.settingsKey]) merge(p.settingsFile, config.settings[p.settingsKey])
  if (config.settings?.['agent-hub']?.skillPacks) {
    writeJson(join(hubHome, 'import/skill-packs.json'), config.settings['agent-hub'].skillPacks)
    say(true, 'Agent Hub skill packs staged (taken in when dsh starts)')
  }
  const wsOf = product => expand(config.workspaces?.[product]?.path || products[product]?.workspace, home)
  // plain .env values
  for (const [product, values] of Object.entries(config.env || {})) {
    if (!products[product]) continue
    const ws = safeDest(wsOf(product), home)
    const file = ws && safeDest(join(ws, products[product].envFile), home)
    if (!file) { say(false, `${product} .env: refused — Ruyix's own state, above it, or a path that cannot be told`); continue }
    setEnvKeys(file, values)
    say(true, `${product} .env: ${Object.keys(values).length} settings`)
  }
  importConnections(config, secrets, { home, env, inBox, say })
  // the agent pool: Agent Hub takes it in when it starts (an import while dsh runs: now, through the running ruyix)
  const dir = join(hubHome, 'import')
  if (config.agents?.agents?.length) { writeJson(join(dir, 'pool.agents.json'), config.agents); say(true, `${config.agents.agents.length} Agent Hub agents (taken in when dsh starts)`) }
  if (!inBox && config.ruyix && !existsSync(join(home, '.ruyix/config'))) say(true, `ruyix: port ${config.ruyix.port} (ruyix install writes ~/.ruyix/config)`)
  return report
}

/** Version 2: the connections, each slot's value by its secret name (or the box's placeholder, or the file nookbox placed). */
function importConnections(config, secrets, { home, env, inBox, say }) {
  const values = Object.create(null), missing = []
  for (const s of config.secrets || []) {
    for (const u of (s.use || []).filter(x => x.to === 'connection')) {
      const key = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x)
      if (!key(u.id) || !key(u.slot)) { say(false, `invalid connection credential: ${u.id}.${u.slot}`); continue }
      let v = secrets[s.name] ?? env[s.name]
      const importDir = join(home, '.ruyix/connectors/import')
      const expected = join(importDir, `${u.id}.${u.slot}`)
      const candidate = u.path && expand(u.path, home)
      // Only nookbox's staged file, never a configuration-chosen user file or a link to one.
      const placed = candidate && resolve(candidate) === expected && dirname(expected) === importDir
        && lstatSync(expected, { throwIfNoEntry: false })?.isFile()
        && realOf(expected) === join(realOf(join(home, '.ruyix')) || join(home, '.ruyix'), 'connectors/import', `${u.id}.${u.slot}`) ? expected : null
      if (!v && placed && existsSync(placed)) { v = readFileSync(placed, 'utf8'); rmSync(placed, { force: true }) }
      if (typeof v === 'string' && v.startsWith('base64:')) v = Buffer.from(v.slice(7), 'base64').toString('utf8')
      if (v) (values[u.id] ??= Object.create(null))[u.slot] = v
      else if (s.kind !== 'cookie') missing.push(s.name) // a session is signed in to (Connectors page), not imported
    }
  }
  if (config.connections?.length) {
    writeFile(join(home, '.ruyix/connectors/import.json'), `${JSON.stringify({ connections: config.connections, values })}\n`, 0o600)
    say(true, `${config.connections.length} connections, ${Object.values(values).reduce((n, x) => n + Object.keys(x).length, 0)} credentials${inBox ? ' (the box\'s placeholders)' : ''} — the connectors plugin takes them in`)
  }
  if (missing.length) say(false, `no value for ${missing.join(', ')} — add it to the secrets file${inBox ? ' on the host (nookbox up … --secrets)' : ''}, or fill it in on the Connectors page`)
}

/** Version 1 (before connections): each credential into its workspace .env or dsh, as it was; the products move them at their next start. */
/** A key in dsh's credentials file (version 1, refs: KEY: value). */
export function setDshCredential(file, key, value) {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : 'version: 1\n'
  const re = new RegExp(`^(\\s+)${key}:.*$`, 'm')
  if (re.test(text)) text = text.replace(re, `$1${key}: ${value}`)
  else if (/^refs:\s*\{\}\s*$/m.test(text)) text = text.replace(/^refs:\s*\{\}\s*$/m, `refs:\n  ${key}: ${value}`)
  else if (/^refs:\s*$/m.test(text)) text = text.replace(/^refs:\s*$/m, `refs:\n  ${key}: ${value}`)
  else text = `${text.replace(/\n?$/, '\n')}refs:\n  ${key}: ${value}\n`
  writeFile(file, text, 0o600)
}

/** git clone; in a box over https (the gateway adds the GitLab credential), an ssh remote rewritten. */
export function httpsOf(url) {
  const scp = url.match(/^[\w.-]+@([\w.-]+):(.+)$/)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  const ssh = url.match(/^ssh:\/\/[^@]+@([\w.-]+)(?::\d+)?\/(.+)$/)
  return ssh ? `https://${ssh[1]}/${ssh[2]}` : url
}
export async function cloneRepo(url, dir, inBox) {
  const src = inBox ? httpsOf(url) : url
  const git = (args, input) => new Promise((ok, no) => {
    let inputError = null
    const child = execFile('git', args, { encoding: 'buffer', timeout: 1200000, maxBuffer: 16 << 20 }, (err, stdout) => err || inputError ? no(err || inputError) : ok(stdout))
    child.stdin.on('error', err => { inputError = err })
    child.stdin.end(input)
  })
  try {
    mkdirSync(dirname(dir), { recursive: true })
    // Fetch privately, then fill only absent paths: local work is never replaced, even at a tracked name.
    const tmp = mkdtempSync(join(dirname(dir), '.ruyix-clone-'))
    try {
      await git(['clone', '--quiet', '--no-checkout', '--', src, tmp])
      mkdirSync(dir, { recursive: true })
      if (lstatSync(join(dir, '.git'), { throwIfNoEntry: false })) return false
      const work = ['--git-dir', join(tmp, '.git'), '--work-tree', dir]
      await git([...work, 'reset', '--quiet']) // index only; never reset the work tree
      const missing = await git([...work, 'ls-files', '--deleted', '-z'])
      if (missing.length) await git([...work, 'checkout-index', '--stdin', '-z'], missing) // no --force
      if (lstatSync(join(dir, '.git'), { throwIfNoEntry: false })) return false
      renameSync(join(tmp, '.git'), join(dir, '.git')) // attach only after a successful checkout, so failures remain retryable
      return true
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  } catch { return false }
}

/**
 * The export of the running ruyix (its connectors plugin knows which credentials are set, and holds their values): the
 * launch token in dsh's log buys a session cookie, as the browser's first visit does. null when ruyix is not running.
 */
export async function fromRunningRuyix(values, { home = homedir() } = {}) {
  const configHome = expand(process.env.RUYIX_HOME || '~/.ruyix', home)
  const conf = readDotenv(existsSync(join(configHome, 'config')) ? readFileSync(join(configHome, 'config'), 'utf8').replace(/\s+#.*$/gm, '') : '')
  const port = conf.RUYIX_PORT || process.env.RUYIX_PORT || '3280'
  const log = expand((conf.RUYIX_LOG || process.env.RUYIX_LOG || join(configHome, 'dsh-web.log')).replace(/^\$RUYIX_HOME\//, `${configHome}/`).replace(/^\$HOME\//, '~/'), home)
  const token = (existsSync(log) ? readFileSync(log, 'utf8') : '').match(/token=[A-Za-z0-9_-]+/g)?.at(-1)
  if (!token) return null
  try {
    const first = await fetch(`http://127.0.0.1:${port}/?${token}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const cookie = first.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const res = await fetch(`http://127.0.0.1:${port}/api/ruyix/config${values ? '?values=1' : ''}`, { headers: { cookie }, signal: AbortSignal.timeout(30000) })
    if (!res.ok) return null
    const d = await res.json()
    return { config: d.config, secrets: d.secrets ? readSecrets(d.secrets) : {}, skipped: d.skipped || [] }
  } catch { return null }
}

// ── the command line ──
async function main(argv) {
  const [op, ...rest] = argv
  const opt = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
  if (op === 'export') {
    const out = opt('--out') || 'ruyix-config.json', sf = opt('--secrets')
    const running = await fromRunningRuyix(!!sf)
    if (sf && !running) { console.error('  ! the values are the connections\', held by the running ruyix: start it (ruyix start) and export again'); return 1 }
    const { config, secrets, skipped } = running || await exportConfig()
    writeFile(out, `${JSON.stringify(config, null, 2)}\n`)
    console.log(`  ✓ ${out}: ${Object.keys(config.workspaces).length} workspaces, ${config.connections.length} connections, ${config.agents?.agents.length || 0} agents, ${config.secrets.length} credentials (names only)`)
    if (!running) console.log('  · ruyix is not running: the connections are in, the list of their credentials is not (start ruyix for the full file)')
    if (sf) { writeFile(sf, secretsText(secrets), 0o600); console.log(`  ✓ ${sf}: the values (0600; keep it off git and chat)`) } else console.log('  · values not written: add --secrets ruyix-secrets.env to export them too')
    if (skipped.length) console.log(`  · not carried (credentials belong in connections): ${skipped.join(', ')}`)
    return 0
  }
  if (op === 'import') {
    const file = rest.find(a => !a.startsWith('--') && a !== opt('--secrets'))
    if (!file) { console.error('usage: ruyix config import <ruyix-config.json> [--secrets ruyix-secrets.env]'); return 2 }
    const config = JSON.parse(readFileSync(file, 'utf8'))
    const sf = opt('--secrets')
    const report = await importConfig(config, sf ? readSecrets(readFileSync(sf, 'utf8')) : {})
    for (const r of report) console.log(`  ${r.ok ? '✓' : '!'} ${r.text}`)
    return report.some(r => !r.ok) ? 1 : 0
  }
  console.error('usage: ruyix config export [--out ruyix-config.json] [--secrets ruyix-secrets.env]\n       ruyix config import <ruyix-config.json> [--secrets ruyix-secrets.env]')
  return 2
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(await main(process.argv.slice(2)))
