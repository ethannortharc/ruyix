// The command-line tools a run's steps use. The image carries the common ones only; a step names the rest (`cli`: name,
// name@version or backend:package@version) and the run puts each in place when it needs it: mise installs it in this
// home (~/.local/share/ruyix-tools: no root, kept across restarts and newer images), mise itself fetched the first time
// (a pinned release, its SHA-256 checked against the one written here). What mise cannot install — a Docker engine, a
// system library — is said with how a person puts it in place (in a sandbox: `nookbox install` on the host). Every result
// says where it stands: ok (here already), installed, missing (with how). Linux and macOS: mise's releases are for those.
// What was installed never goes on the dsh process's own PATH or environment (every later command of dsh itself, `git`
// among them, would find it): `env()` gives it for the processes of a step only — its commands and its agent.
import { createHash } from 'node:crypto'
import { accessSync, appendFileSync, constants, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { sh } from './settings.js'

export const MISE_VERSION = '2026.9.18'
// the release's SHA-256s (its SHASUMS256.txt): a download is checked against these, never against what it says itself
const MISE_SHA256 = {
  'linux-x64': '4312f8fd72a8d6a869cd2aca7444929e2a0ef6f45d2c6f2866a1eacc5bdc2e84',
  'linux-arm64': '4a06b8cc295390e606b9103a29a3b49a1efba75092b05c8aca56b8367f636b37',
  'macos-arm64': 'b3539de1a9823505269481b71d09a9cf86e141c63ebfc6101b3cf561766a83e8',
  'macos-x64': 'e1fd0d0a7c93428cc4eaf61a0bdb26f0a50d4401283458c1182d3dcc6fb9b234',
}
// mise's backends a run may install from: prebuilt releases and language package managers. asdf / vfox plugins run
// their own scripts (and often compile) — a tool only they offer is installed by a person.
const BACKENDS = ['core', 'aqua', 'github', 'gitlab', 'ubi', 'pipx', 'npm']
// what mise's registry does not say: a tool by another name, and what only a person installs — an engine (a daemon with root), a system package (apt / Homebrew name)
export const CATALOG = {
  bandit: { spec: 'pipx:bandit' },
  gofmt: { spec: 'go', bin: 'gofmt' },
  rg: { spec: 'ripgrep', bin: 'rg' },
  docker: { engine: true },
  podman: { engine: true },
  psql: { apt: 'postgresql-client', brew: 'libpq' },
  'redis-cli': { apt: 'redis-tools', brew: 'redis' },
  make: { apt: 'make', brew: 'make' },
  gcc: { apt: 'build-essential', brew: 'gcc' },
  'g++': { apt: 'build-essential', brew: 'gcc' },
}
// a step's tool: name[@version], or backend:package[@version]
const TOOL = /^(?:([a-z]+):)?([@A-Za-z0-9][\w@./+-]{0,99}?)(?:@([0-9A-Za-z][\w.+-]{0,39}))?$/
// the shell and what every machine running Ruyix has: never looked for, never installed
const BASE = new Set(['bash', 'sh', 'env', 'git', 'node', 'npm', 'npx', 'python3', 'tar', 'curl'])

/** A step's tool, read: { want, name, spec?, version?, bin, engine?, apt?, brew? } — null when it is not a tool's name. */
export function parseTool(want) {
  const m = TOOL.exec(String(want || '').trim())
  if (!m) return null
  const [, backend, pkg, version] = m
  if (backend && !BACKENDS.includes(backend)) return null
  const c = backend ? {} : CATALOG[pkg] || {}
  const name = backend ? `${backend}:${pkg}` : pkg
  return { want: String(want).trim(), name, spec: backend ? name : c.spec || null, version: version || c.version || null, bin: c.bin || pkg.split('/').pop().replace(/^@/, ''),
    ...(backend && { explicit: true }), ...(c.engine && { engine: true }), ...(c.apt && { apt: c.apt, brew: c.brew || pkg }) }
}
/**
 * Is this what an agent may ask for by itself — a short name from mise's registry (`shellcheck`, `jq@1.7.1`), never an
 * explicit backend (`npm:x`, `pipx:x`, `github:o/r`, `ubi:`, `cargo:`, `go:`, `aqua:`, `http:` …: those run code from
 * anywhere). A step's own `cli` list, written by a person in the workflow, may name them.
 */
export const registryName = want => /^[a-z0-9][\w.+-]{0,63}(?:@[0-9A-Za-z][\w.+-]{0,39})?$/.test(String(want || '').trim())
/** The tools a definition's steps name (lib/needs.js walks the steps). */
export const toolsOf = steps => [...new Set(steps.flatMap(s => s.cli || []))]

/**
 * On this PATH: the first executable `bin`, or null — in its absolute directories only (a relative one, `.` or
 * node_modules/.bin, means another directory to every command started elsewhere).
 */
export function which(bin, path = process.env.PATH || '') {
  for (const dir of path.split(delimiter).filter(d => isAbsolute(d))) {
    try { accessSync(join(dir, bin), constants.X_OK); return join(dir, bin) } catch { /* not here */ }
  }
  return null
}

/**
 * How a person puts a tool in place that the run could not: { text, cmd? } (English; the command to copy). `box`: the
 * sandbox this runs in (its name), else this machine; `os`: process.platform.
 */
export function howTo(t, { box = null, os = process.platform, error = '' } = {}) {
  const bin = t.bin
  if (t.engine && t.version) return { kind: 'pinSystem', bin, text: `An engine's version is installed by a person, not by a run: name ${bin} without a version.` }
  if (t.engine) {
    return box
      ? { kind: 'engineBox', bin, text: `This box has no ${bin} engine: it would need root, which a box never has. Run this step on a machine that has ${bin}.` }
      : os === 'darwin' ? { kind: 'engineMac', bin, text: `Install Docker Desktop (or another engine) and start it, so \`${bin} info\` works.`, cmd: 'brew install --cask docker' }
        : { kind: 'engineLinux', bin, text: `Install the ${bin} engine and let this user run it, so \`${bin} info\` works without sudo.`, cmd: 'sudo apt-get install -y docker.io && sudo usermod -aG docker $USER' }
  }
  if (t.apt && t.version) return { kind: 'pinSystem', bin, text: `A system package's version is installed by a person, not by a run: name ${bin} without a version, or install that version so \`which ${bin}\` finds it.` }
  if (t.apt) {
    return box ? { kind: 'aptBox', bin, text: 'A system package: install it into the box from the host. It is kept when the box is rebuilt.', cmd: `nookbox install ${box} ${t.apt}` }
      : os === 'darwin' ? { kind: 'aptMac', bin, text: 'A system package.', cmd: `brew install ${t.brew}` } : { kind: 'aptLinux', bin, text: 'A system package.', cmd: `sudo apt-get install -y ${t.apt}` }
  }
  if (error) return { kind: 'miseFailed', bin, error, text: `mise could not install it: ${error}${box ? ' (the box\'s egress policy must let it reach github.com and the tool\'s download site)' : ''}. Or install it yourself so \`which ${bin}\` finds it.` }
  return box ? { kind: 'unknownBox', bin, text: 'Not a tool mise installs. If it is a Debian package, install it into the box from the host.', cmd: `nookbox install ${box} ${bin}` }
    : { kind: 'unknown', bin, text: `Not a tool mise installs: install it with this machine's package manager so \`which ${bin}\` finds it.` }
}

/**
 * A tool's own version in what its --version says: the first version number (v1.64.8, 0.10.0, 15.4, jq-1.7.1), never one
 * glued to a word (go1.25.0) or inside another (12.2.0-14+deb12u1 is 12.2.0); a prerelease kept (1.2.3-rc.1).
 */
export function versionIn(text) {
  const m = String(text || '').slice(0, 4000).match(/(?:^|[\s(:,=]|(?<=[A-Za-z])-)v?(\d+(?:\.\d+)*)(-[A-Za-z][0-9A-Za-z.]*)?(?:[-+~][0-9A-Za-z.+~]*)?(?=$|[\s),;:(])/m)
  return m ? m[1] + (m[2] || '') : null
}
// (a prerelease: a dash suffix, go's 1.25rc1, python's 6.0a1 / 6.0.dev1)
const pre = v => /-|(?:rc|beta|alpha|a|b)\d*$|\.?dev\d*$/.test(v)
/** Does the version in use fit the one asked for (1 and 1.64 fit 1.64.8; 1.6 does not; a stable request no prerelease)? */
export const fits = (version, want) => {
  if (!version || !want) return false
  const v = String(version).replace(/^v(?=\d)/, ''), w = String(want).replace(/^v(?=\d)/, '')
  return v === w || (v.startsWith(`${w}.`) && pre(v) <= pre(w))
}

const sha256 = file => new Promise((resolve, reject) => {
  const h = createHash('sha256')
  createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
})

// one home's fetch of mise, its install queue and its failures, whichever toolbox asks (two workbenches in one dsh share the
// home's): root → { fetching, chain, failed, bins, vars } (bins and vars: what mise selected, for `env()`)
const SHARED = new Map()
const HOME_ROOT = join(homedir(), '.local', 'share', 'ruyix-tools')
// a login shell's profile puts the home's bin first again (~/.local/bin: an older copy of a tool may sit there): the line
// it ends with puts back what mise put in place — only in what Ruyix starts, which carries RUYIX_TOOLS_PATH (a person's own
// terminals do not)
const HOOK = '# ruyix: the command-line tools Ruyix put in place, first on the PATH of what Ruyix starts (RUYIX_TOOLS_PATH)\n[ -n "$RUYIX_TOOLS_PATH" ] && export PATH="$RUYIX_TOOLS_PATH:$PATH"\n'
/** The line at the end of the home's shell profiles that keeps RUYIX_TOOLS_PATH first (once; profiles that exist). */
export function hookProfiles(home) {
  for (const f of ['.profile', '.bash_profile', '.bashrc', '.zprofile', '.zshrc']) {
    const p = join(home, f)
    try {
      if (!existsSync(p)) continue
      const text = readFileSync(p, 'utf8')
      if (!text.includes('RUYIX_TOOLS_PATH')) appendFileSync(p, `${text.endsWith('\n') || !text ? '' : '\n'}\n${HOOK}`)
    } catch { /* a profile it cannot write: its order stands */ }
  }
}

/**
 * This machine's tools. `root`: where mise and what it installs live (the home's ruyix-tools); `run`: a command runner
 * (lib/settings.js sh); `box`: the sandbox's name in a sandbox; `shellHome`: whose profiles get the RUYIX_TOOLS_PATH line (the default
 * home's toolbox only). → { need, check, refresh, misePath, root }
 *
 * One version of a tool is in use on a machine at a time — mise's selection, the one the PATH finds. A step that names
 * a version (tool@1.2) installs it and selects it; two steps running at the same time that name different versions of
 * one tool are not supported (the later selection is what both find).
 */
export function createToolbox({ root = HOME_ROOT, shellHome = root === HOME_ROOT ? homedir() : null, run = sh, box = process.env.NOOKBOX_NAME || null, platform = process.platform, arch = process.arch, fetchMise } = {}) {
  const key = `${platform === 'darwin' ? 'macos' : 'linux'}-${arch === 'arm64' ? 'arm64' : 'x64'}`
  const miseBin = join(root, `mise-${MISE_VERSION}`, 'mise', 'bin', 'mise')
  // mise's own dirs, apart from any mise of the person's (their configuration, their tools)
  const env = {
    MISE_DATA_DIR: join(root, 'data'), MISE_CONFIG_DIR: join(root, 'config'), MISE_CACHE_DIR: join(root, 'cache'), MISE_STATE_DIR: join(root, 'state'),
    MISE_GLOBAL_CONFIG_FILE: join(root, 'config', 'config.toml'), MISE_YES: '1', MISE_COLOR: '0', NO_COLOR: '1',
    MISE_CEILING_PATHS: root, // (a .tool-versions or mise.toml in the home above it is the person's, not read here)
  }
  // (mise finds what it installed before — uv for a pipx tool, node for an npm one — on the PATH it is given, not on this process's)
  const mise = (args, timeout = 600000) => run(miseBin, args, { cwd: root, env: { ...env, PATH: searchPath() }, timeout }) // (cwd: no project's mise.toml read)
  const short = r => `${r.stderr || ''}\n${r.stdout || ''}`.trim().split('\n').filter(l => !/WARN|^\s*$/.test(l)).slice(-2).join(' ').slice(0, 300) || `exit ${r.code}`
  const mine = p => p === root || p.startsWith(`${root}/`) // (a directory of the toolbox's own)
  const st = SHARED.get(root) || (SHARED.set(root, { fetching: null, chain: Promise.resolve(), failed: new Map(), bins: [], vars: {} }), SHARED.get(root))

  /** mise here: the pinned release, fetched and checked once. → its path (throws why it cannot be had). */
  const ensureMise = () => {
    if (existsSync(miseBin)) return Promise.resolve(miseBin)
    return (st.fetching ||= (async () => {
      const want = MISE_SHA256[key]
      if (!['linux', 'darwin'].includes(platform) || !want) throw new Error(`mise installs tools on Linux and macOS only (${platform} ${arch})`)
      mkdirSync(root, { recursive: true })
      const tmp = mkdtempSync(join(root, '.fetch-'))
      try {
        const file = join(tmp, 'mise.tar.gz')
        const url = `https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-${key}.tar.gz`
        const got = fetchMise ? await fetchMise(url, file) : await run('curl', ['-fsSL', '--retry', '2', '-o', file, url], { timeout: 600000 })
        if (got.code) throw new Error(`could not download mise ${MISE_VERSION}: ${short(got)}`)
        const sum = await sha256(file)
        if (sum !== want) throw new Error(`mise ${MISE_VERSION} download has SHA-256 ${sum.slice(0, 16)}…, not the release's ${want.slice(0, 16)}…`)
        const x = await run('tar', ['-xzf', file, '-C', tmp], { timeout: 300000 })
        if (x.code || !existsSync(join(tmp, 'mise', 'bin', 'mise'))) throw new Error(`could not unpack mise: ${short(x)}`)
        mkdirSync(join(root, `mise-${MISE_VERSION}`), { recursive: true })
        // (another process of this home may have put its own checked copy there first: that one is as good)
        try { renameSync(join(tmp, 'mise'), join(root, `mise-${MISE_VERSION}`, 'mise')) } catch (err) { if (!existsSync(miseBin)) throw err }
        return miseBin
      } finally { rmSync(tmp, { recursive: true, force: true }) }
    })().finally(() => { st.fetching = null }))
  }

  /** The PATH of what a step starts: mise's directories first, then this process's own (without any directory of the toolbox's). */
  const searchPath = () => [...new Set(st.bins)].concat((process.env.PATH || '').split(delimiter).filter(p => p && !mine(p))).join(delimiter)
  /**
   * What mise selected: its tools' directories, and the variables they need beside the PATH (go's GOROOT, rust's
   * RUSTUP_TOOLCHAIN) — kept here for `env()`. This process's own PATH and environment are never touched.
   */
  let hooked = false
  const refreshNow = async () => {
    if (!existsSync(miseBin) || !existsSync(env.MISE_GLOBAL_CONFIG_FILE)) return []
    // (both read first, both applied or neither: a PATH without the variables its tools need is no selection)
    const r = await mise(['bin-paths'], 60000), e = await mise(['env', '-J'], 60000)
    let vars = null
    try { vars = e.code ? null : JSON.parse(e.stdout) } catch { /* unreadable */ }
    if (r.code || !vars || typeof vars !== 'object' || Array.isArray(vars)) return null // (the PATH and environment as they were)
    const bins = r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
    st.bins = bins
    st.vars = Object.fromEntries(Object.entries(vars).filter(([k]) => k !== 'PATH' && /^[A-Z_][A-Z0-9_]*$/.test(k)).map(([k, v]) => [k, String(v)]))
    if (shellHome && !hooked && bins.length) { hooked = true; hookProfiles(shellHome) }
    return bins
  }

  /** The tool as mise has it selected in this home: { version, requested } — or null. */
  const installed = async spec => {
    // (asked for the one tool: the whole list keys core:go as go)
    const r = await mise(['ls', '--global', '--json', spec], 60000)
    if (r.code) return null
    try { const list = JSON.parse(r.stdout), x = (Array.isArray(list) ? list : list?.[spec] || []).find(v => v.installed); return x ? { version: x.version, requested: x.requested_version } : null } catch { return null }
  }
  /** The backend mise's registry gives a short name, among those a run may use — null when none. */
  const specOf = async t => {
    if (t.spec?.includes(':')) return t.spec
    const r = await mise(['registry', t.spec || t.name], 60000)
    if (r.code) return null
    return r.stdout.trim().split(/\s+/).find(b => BACKENDS.includes(b.split(':')[0])) || null
  }
  /** That version's executable (its own name's, else the first its package has: npm:typescript → tsc) — null when mise lacks it. */
  const exeOf = async (t, spec, want) => {
    const r = await mise(['bin-paths', '--json', `${spec}@${want}`], 60000)
    let list = []
    try { list = r.code ? [] : JSON.parse(r.stdout) } catch { /* none */ }
    return (list.find(x => x.name === t.bin) || list[0])?.path || null
  }
  const real = p => { try { return realpathSync(p) } catch { return p } }
  /** An engine there and answering this user (docker info / podman info): { ok, error? }. */
  const engineUp = async bin => {
    const r = await run(bin, ['info'], { timeout: 15000 })
    return r.code ? { ok: false, error: `${bin} info: ${short(r)}` } : { ok: true }
  }
  /** Every command a version of a package puts on the PATH. */
  const commandsOf = async (spec, want) => {
    const r = await mise(['bin-paths', '--json', `${spec}@${want}`], 60000)
    try { return r.code ? [] : JSON.parse(r.stdout).map(x => x.name).filter(Boolean) } catch { return [] }
  }

  // installs one at a time (mise writes one configuration); a tool that could not be had is not tried again for ten minutes
  const failed = st.failed
  const one = async t => {
    // (an explicit package's command is a guess — aqua:mvdan/sh runs as shfmt: mise says which, never the PATH)
    const here = t.explicit ? null : which(t.bin, searchPath())
    // an engine: there and answering (docker info), else a person sets it up
    if (t.engine) { const e = here && !t.version && await engineUp(t.bin); return e?.ok ? { status: 'ok', path: here } : { status: 'missing', ...(e?.error && { error: e.error }), how: howTo(t, { box, os: platform }) } }
    // on the PATH already — the image's, the machine's, or one mise put there — is enough unless a version is asked
    if (here && !t.version) return { status: 'ok', path: here }
    // a system package: here, or a person installs it (their version to choose: said so)
    if (t.apt) return here && !t.version ? { status: 'ok', path: here } : { status: 'missing', how: howTo(t, { box, os: platform }) }
    const last = failed.get(t.want)
    if (last && Date.now() - last.at < 600000) return last.res
    let spec = null
    const fail = error => { const res = { status: 'missing', ...(error && { error }), how: howTo(t, { box, os: platform, error }) }; failed.set(t.want, { at: Date.now(), res, spec }); return res }
    try { await ensureMise() } catch (err) { return fail(err.message) }
    spec = await specOf(t)
    if (!spec) return fail(t.version ? `a version of ${t.bin} is put in place by mise, which does not know it` : '')
    // the version asked for becomes the one selected (a tool asked for without one keeps the version selected)
    const have = await installed(spec), want = t.version || (have ? have.requested : 'latest')
    // (the selected version when it fits the request — @0 with 0.10.0 selected and 0.11.0 installed is 0.10.0)
    const inUse = have && (have.requested === want || fits(have.version, want)), target = inUse ? have.version : want
    const did = !(await exeOf(t, spec, target))
    if (did || !inUse) {
      // a tool installed through pip's world needs uv first (mise's pipx backend uses it)
      if (spec.startsWith('pipx:') && !which('uv', searchPath())) { const uv = await one(parseTool('uv')); if (uv.status === 'missing') return fail(`uv (for ${spec}): ${uv.error || 'missing'}`) }
      const r = await mise(['use', '-g', `${spec}@${want}`])
      if (r.code) return fail(short(r))
    }
    if (!(await refreshNow())) return fail('mise could not say what is selected (its bin-paths or env)')
    const at = await exeOf(t, spec, target)
    if (!at) return fail(`mise has ${spec}@${want} but it gives no executable`)
    // the PATH must find that very executable (a refresh that failed leaves another one first)
    const onPath = which(basename(at), searchPath())
    if (!onPath || real(onPath) !== real(at)) return fail(`the PATH finds ${onPath || `no ${basename(at)}`}, not mise's ${spec}@${want}`)
    // (any earlier failure of a command this put in place — this one, another version of it, one it brings: gofmt with go —
    // is past now)
    const names = new Set([t.bin, ...(await commandsOf(spec, target))])
    // (one that failed before its package was known — mise itself could not be had then — is tried again too: mise works now)
    for (const [k, f] of [...failed]) if (!f.spec || f.spec === spec || names.has(parseTool(k)?.bin)) failed.delete(k)
    const now = await installed(spec)
    return { status: did ? 'installed' : 'ok', path: at, version: now && (now.requested === want || fits(now.version, want)) ? now.version : want, spec }
  }
  const queued = fn => { const p = st.chain.then(fn); st.chain = p.catch(() => {}); return p }

  return {
    misePath: miseBin, root,
    /** A shell line bringing a shell started before to what mise selected now: its directories first, its variables. */
    activation() {
      const q = v => `'${String(v).replace(/'/g, "'\\''")}'`
      const dirs = st.bins.join(delimiter)
      return [...(dirs ? [`export PATH=${q(dirs)}:"$PATH"`, `export RUYIX_TOOLS_PATH=${q(dirs)}`] : []), ...Object.entries(st.vars).map(([k, v]) => `export ${k}=${q(v)}`)].join('; ')
    },
    /**
     * The environment of the processes of a step (its commands, its agent), on top of this process's own: mise's
     * directories first on the PATH, RUYIX_TOOLS_PATH (a login shell's profile puts them first again: hookProfiles), and the
     * variables its tools need. Empty until mise has put something in place. This process's own environment stays as it is.
     */
    env() {
      return st.bins.length ? { PATH: searchPath(), RUYIX_TOOLS_PATH: st.bins.join(delimiter), ...st.vars } : {}
    },
    /** What mise selected, read into `env()` — in turn with the installs. */
    refresh: () => queued(refreshNow),
    /** Put a tool in place (its name as a step writes it). → { want, bin, status: ok | installed | missing, path?, version?, error?, how? } */
    need(want, { by = 'step' } = {}) {
      const t = parseTool(want)
      // what an agent asks for by itself is a registry short name; the explicit backends are for a person's workflow (its cli list)
      if (by === 'agent' && !registryName(want)) return Promise.resolve({ want: String(want), bin: String(want), status: 'missing', error: 'refused: an agent may name only a tool of mise\'s registry (shellcheck, jq@1.7.1), not a backend or a source', how: { text: 'A person puts a tool from a backend or a source in the step\'s command-line tools (cli) of the workflow.' } })
      if (!t) return Promise.resolve({ want: String(want), bin: String(want), status: 'missing', error: 'not a tool name', how: { text: 'A tool is written name, name@version or backend:package@version.' } })
      if (BASE.has(t.bin) && !t.version && !t.explicit) return Promise.resolve({ want: t.want, bin: t.bin, status: which(t.bin, searchPath()) ? 'ok' : 'missing', path: which(t.bin, searchPath()), ...(!which(t.bin, searchPath()) && { how: howTo({ ...t, apt: t.bin, brew: t.bin }, { box, os: platform }) }) })
      return queued(() => one(t)).then(res => ({ want: t.want, bin: t.bin, ...res }))
    },
    /**
     * Where each tool stands here, without installing anything: ok (here, at the version asked for if one is), fetch (a
     * run installs it), missing (only a person can: with how). → [{ ref, status, how?, error? }]
     */
    async check(list) {
      const out = []
      for (const want of list) {
        const t = parseTool(want)
        if (!t) { out.push({ ref: String(want), status: 'missing', error: 'not a tool name' }); continue }
        const here = t.explicit ? null : which(t.bin, searchPath())
        if (t.engine) { const e = here && !t.version && await engineUp(t.bin); out.push(e?.ok ? { ref: t.want, status: 'ok' } : { ref: t.want, status: 'missing', ...(e?.error && { error: e.error }), how: howTo(t, { box, os: platform }) }); continue }
        if (here && !t.version) { out.push({ ref: t.want, status: 'ok' }); continue }
        if (t.engine || t.apt) { out.push(here && !t.version ? { ref: t.want, status: 'ok' } : { ref: t.want, status: 'missing', how: howTo(t, { box, os: platform }) }); continue }
        const last = failed.get(t.want)
        if (last && Date.now() - last.at < 600000) { out.push({ ref: t.want, status: 'missing', ...(last.res.error && { error: last.res.error }), how: last.res.how }); continue }
        // asked of mise once it is here (before, a run tries): a name it does not know, or one it has at that version
        if (existsSync(miseBin)) {
          const spec = await specOf(t)
          if (!spec) { out.push({ ref: t.want, status: 'missing', how: howTo(t, { box, os: platform }) }); continue }
          const have = await installed(spec), want = t.version || (have ? have.requested : 'latest')
          if (await exeOf(t, spec, have && (have.requested === want || fits(have.version, want)) ? have.version : want)) { out.push({ ref: t.want, status: 'ok' }); continue }
        }
        out.push({ ref: t.want, status: 'fetch' })
      }
      return out
    },
  }
}
