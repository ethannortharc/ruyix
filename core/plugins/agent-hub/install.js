// The agent CLIs as packages of this home — installed, updated and removed from Agents → Runtimes, not baked into an
// image: `npm install --prefix ~/.local/share/ruyix-agents/<runtime>`, its command linked into ~/.local/bin (where the
// runtimes are looked up). A command already there that is not ours (a person's own install, Claude Code's native
// installer) is left alone: it shows as installed elsewhere, and replacing it is an explicit choice. On Windows the
// command is a .cmd file that calls npm's (a symlink would need administrator rights).
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WIN, launch } from './platform.js'

export const PACKAGES = {
  claude: { name: 'Claude Code', pkg: '@anthropic-ai/claude-code', bin: 'claude' },
  codex: { name: 'Codex', pkg: '@openai/codex', bin: 'codex' },
  pi: { name: 'pi', pkg: '@earendil-works/pi-coding-agent', bin: 'pi' },
}
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
const execP = (cmd, args, opts) => new Promise((ok, no) => execFile(...launch(cmd, args), { windowsHide: true, ...opts }, (err, stdout, stderr) => (err ? no(Object.assign(err, { stdout, stderr })) : ok({ stdout, stderr }))))

/** The .cmd that stands for a command on Windows: calls the target with every argument. */
const cmdShim = target => `@"${target}" %*\r\n`

/** true when release `a` is newer than `b` (semver order: a pre-release comes before its release). */
export function newer(a, b) {
  const p = v => { const [c, ...r] = String(v || '').split('-'); return [c.split('.').map(Number), r.join('-')] }
  const [[x, xp], [y, yp]] = [p(a), p(b)]
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  if (xp === yp) return false
  if (!xp) return true
  if (!yp) return false
  return xp.localeCompare(yp, 'en', { numeric: true }) > 0
}

/** home: whose ~/.local; run(cmd, args, opts) → { stdout } (rejects on failure); which(bin) → path or null. */
export function createInstaller({ home = homedir(), npm = WIN ? 'npm.cmd' : 'npm', run = execP, which, win = WIN, registry = 'https://registry.npmjs.org/', now = Date.now } = {}) {
  const root = join(home, '.local/share/ruyix-agents'), binDir = join(home, '.local/bin')
  const latests = new Map() // runtime → { version, at }
  const def = rt => PACKAGES[rt] || (() => { throw fail('badRuntime', { runtime: rt }, `no installable runtime "${rt}" (one of ${Object.keys(PACKAGES).join(', ')})`) })()
  const ext = win ? '.cmd' : ''
  const link = rt => join(binDir, def(rt).bin + ext)
  const target = rt => join(root, rt, 'node_modules', '.bin', def(rt).bin + ext)
  const isLink = p => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
  const read = p => { try { return readFileSync(p, 'utf8') } catch { return null } }
  const ours = rt => (win ? read(link(rt)) === cmdShim(target(rt)) : isLink(link(rt)) && resolve(binDir, readlinkSync(link(rt))) === target(rt))
  const versionOf = rt => { try { return JSON.parse(readFileSync(join(root, rt, 'node_modules', def(rt).pkg, 'package.json'), 'utf8')).version } catch { return null } }
  const real = p => { try { return realpathSync(p) } catch { return p } }

  async function latest(rt, { fresh = false } = {}) {
    const hit = latests.get(rt)
    if (!fresh && hit && now() - hit.at < 6 * 3600e3) return hit.version
    // past npm's cache: a registry may answer a cached copy's revalidation with "not modified" while it has a newer one
    const cache = mkdtempSync(join(tmpdir(), 'ruyix-npm-'))
    try {
      const v = String((await run(npm, ['view', def(rt).pkg, 'version', '--registry', registry, '--cache', cache], { timeout: 30000 })).stdout).trim().split('\n').pop()
      if (VERSION.test(v)) latests.set(rt, { version: v, at: now() })
      return VERSION.test(v) ? v : hit?.version || null
    } catch { return hit?.version || null } finally { rmSync(cache, { recursive: true, force: true }) }
  }

  const pending = new Set()
  const withRuntime = async (rt, fn) => {
    if (pending.has(rt)) throw fail('runtimeInstalling', { runtime: rt }, `${def(rt).name} is being installed or removed: try again when it is done`)
    pending.add(rt)
    try { return await fn() } finally { pending.delete(rt) }
  }

  return {
    root,
    latest,
    /** Where a runtime stands: managed here ('ruyix'), installed by something else ('elsewhere'), or not at all (null). */
    async status(rt) {
      const p = def(rt), bin = which(p.bin)
      const managed = ours(rt) ? 'ruyix' : bin ? 'elsewhere' : null
      let version = managed === 'ruyix' ? versionOf(rt) : null
      if (managed === 'elsewhere') version = String((await run(bin, ['--version'], { timeout: 10000 }).catch(e => ({ stdout: e.stdout || '' }))).stdout).match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] || null
      return { runtime: rt, name: p.name, package: p.pkg, managed, version, path: bin ? real(bin) : null }
    },
    /**
     * Install, update or pin `version` (the latest by default). A new copy goes into its own directory and replaces the
     * old one only when it installed: a failure leaves what was there. `replace` takes over a command installed elsewhere.
     */
    async install(rt, { version = 'latest', replace = false } = {}) {
      return withRuntime(rt, async () => {
        const p = def(rt)
        if (version !== 'latest' && !VERSION.test(version)) throw fail('badVersion', { version }, `a version looks like 1.2.3, not "${version}"`)
        if (existsSync(link(rt)) && !ours(rt) && !replace) throw fail('installedElsewhere', { name: p.name, path: real(link(rt)) }, `${p.name} is installed here by something else (${real(link(rt))}): replace it to manage it from here`)
        mkdirSync(root, { recursive: true })
        const next = mkdtempSync(join(root, `${rt}.next-`))
        try {
          await run(npm, ['install', '--prefix', next, `${p.pkg}@${version}`, '--no-audit', '--no-fund', '--registry', registry], { timeout: 15 * 60e3, maxBuffer: 16 << 20 })
          if (!existsSync(join(next, 'node_modules', '.bin', p.bin + ext))) throw fail('noBin', { name: p.name }, `${p.pkg} installed no ${p.bin} command`)
        } catch (err) {
          rmSync(next, { recursive: true, force: true })
          throw err.code && err.params ? err : fail('installFailed', { name: p.name, detail: String(err.stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400) }, `${p.name} did not install: ${String(err.stderr || err.message).trim().split('\n').at(-1)}`)
        }
        const dir = join(root, rt), old = `${dir}.old`
        rmSync(old, { recursive: true, force: true })
        if (existsSync(dir)) renameSync(dir, old)
        renameSync(next, dir)
        rmSync(old, { recursive: true, force: true })
        mkdirSync(binDir, { recursive: true })
        if (existsSync(link(rt)) || isLink(link(rt))) unlinkSync(link(rt))
        if (win) writeFileSync(link(rt), cmdShim(target(rt)))
        else symlinkSync(target(rt), link(rt))
        return this.status(rt)
      })
    },
    /** Remove what this page installed (a command installed elsewhere is not ours to remove). */
    async remove(rt) {
      return withRuntime(rt, async () => {
        if (!ours(rt)) throw fail('notManaged', { name: def(rt).name }, `${def(rt).name} was not installed from here`)
        unlinkSync(link(rt))
        rmSync(join(root, rt), { recursive: true, force: true })
        return this.status(rt)
      })
    },
    dirs: { root, bin: binDir, of: rt => dirname(target(rt)) },
  }
}
