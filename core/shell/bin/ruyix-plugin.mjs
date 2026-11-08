// ruyix plugin's bookkeeping: the plugins this home added (~/.ruyix/plugins.json) and their tarballs, kept in
// ~/.ruyix/plugins/<package>/ — each fetched from its npm registry and kept only when its bytes have the sha512 given
// when it was added. A plugin installs from that file, so what runs is what was checked, and a box puts it back after an
// image change without asking the registry again. An entry's `available` (a newer checked version) is what ruyix
// upgrade takes.
//   node ruyix-plugin.mjs <command> <ruyix home> ...   (bin/ruyix runs it)
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from '../lock.js'

export const PACKAGE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] }
export const sha512 = file => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`

export function record(home) {
  const file = join(home, 'plugins.json'), dir = join(home, 'plugins')
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')).plugins || {} } catch { return {} } }
  const write = plugins => {
    mkdirSync(home, { recursive: true })
    writeFileSync(`${file}.next`, `${JSON.stringify({ plugins }, null, 2)}\n`)
    renameSync(`${file}.next`, file)
  }
  const path = (pkg, e) => join(dir, pkg, e.file)
  return {
    read, write, path,
    /** pkg@version from its registry, kept only when its sha512 is the reviewed one; the file's name under its folder. */
    fetch(pkg, version, integrity, registry, cwd) {
      const to = join(dir, pkg)
      mkdirSync(to, { recursive: true })
      // the scope's own registry setting outranks --registry: name the scope's
      let out
      try {
        out = JSON.parse(execFileSync('npm', ['pack', `${pkg}@${version}`, `--${pkg.split('/')[0]}:registry=${registry}`, '--pack-destination', to, '--json'],
          { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0]
      } catch (err) { throw new Error(`npm could not fetch ${pkg}@${version} from ${registry}: ${String(err.stderr || err.message).trim().split('\n').filter(l => /error/i.test(l) && !/complete log/.test(l))[0] || 'no answer'}`) }
      const got = join(to, out.filename)
      if (sha512(got) !== integrity) {
        rmSync(got, { force: true })
        throw new Error(`${pkg}@${version} from ${registry} is not the one added: its sha512 differs from the record`)
      }
      return out.filename
    },
    set(pkg, entry) {
      const all = read(), was = all[pkg]
      const keep = was?.available && newer(was.available.version, entry.version) > 0 ? { available: was.available } : {}
      all[pkg] = { ...entry, ...keep, at: Date.now() }
      write(all)
      // the version it replaced is not needed any more
      if (was?.file && was.file !== entry.file) rmSync(path(pkg, was), { force: true })
    },
    del(pkg) {
      const all = read(); delete all[pkg]; write(all)
      rmSync(join(dir, pkg), { recursive: true, force: true })
      try { rmdirSync(join(dir, pkg.split('/')[0])) } catch { /* the scope's other plugins */ }
    },
  }
}

// What this Ruyix loads (~/.ruyix/layout.json): its preset, and each plugin turned on or off. A plugin is on unless its
// package says "ruyix": { "default": "off" } (an app a box rarely needs) or the layout says otherwise; the base — the
// shell, the connections, the workbench, Agent Hub, the boards, the box and the App Center — is always on.
export const CORE = ['shell', 'connectors', 'workbench', 'agent-hub', 'board', 'box', 'apps'].map(n => `@ruyix/${n}`)
export const readLayout = home => { try { return JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) || {} } catch { return {} } }
/** Change the layout (a promise): one writer at a time of it — a change applied in Ruyix's page, `ruyix changes`, this (lock.js). */
export function writeLayout(home, change) {
  return withLock(home, () => {
    const file = join(home, 'layout.json'), tmp = `${file}.${process.pid}.next`
    // a file that does not parse is not overwritten with what little a change knows
    if (existsSync(file)) { try { JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error(`${file} is not valid JSON: fix or remove it`) } }
    const next = change(readLayout(home))
    mkdirSync(home, { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flush: true })
    renameSync(tmp, file)
  })
}
const meta = (pd, pkg) => { try { return JSON.parse(readFileSync(join(pd, 'node_modules', pkg, 'package.json'), 'utf8')) } catch { return null } }
/** Each plugin the profile has: on or off, and why. */
export function plugins(home, pd) {
  let deps = {}
  try { deps = JSON.parse(readFileSync(join(pd, 'package.json'), 'utf8')).dependencies || {} } catch { /* not a profile */ }
  const set = readLayout(home).plugins || {}
  // dsh's own packages are dsh's
  return Object.keys(deps).filter(n => !n.startsWith('@deepseek-ai/')).sort().map(name => {
    const core = CORE.includes(name), byDefault = meta(pd, name)?.ruyix?.default !== 'off'
    return { name, core, default: byDefault, on: core || (typeof set[name] === 'boolean' ? set[name] : byDefault) }
  })
}
/** The profile's bundles as the layout says (dsh's own stay as they are); true when that changed them. */
export function applyLayout(home, pd) {
  const file = join(pd, 'package.json'), p = JSON.parse(readFileSync(file, 'utf8')), all = plugins(home, pd)
  if (!Array.isArray(p.dsh?.profile?.bundles)) return false // not a profile dsh made: nothing to filter
  const ours = new Set(all.map(x => x.name)), was = p.dsh.profile.bundles
  const bundles = [...was.filter(b => !ours.has(b) || all.find(x => x.name === b).on), ...all.filter(x => x.on && !was.includes(x.name)).map(x => x.name)]
  if (bundles.join() === was.join()) return false
  p.dsh = { ...p.dsh, profile: { ...p.dsh?.profile, bundles } }
  writeFileSync(`${file}.next`, `${JSON.stringify(p, null, 2)}\n`)
  renameSync(`${file}.next`, file)
  return true
}

/** The version of pkg a profile has installed, or ''. */
const installed = (pd, pkg) => { try { return JSON.parse(readFileSync(join(pd, 'node_modules', pkg, 'package.json'), 'utf8')).version } catch { return '' } }

async function main([cmd, home, ...args]) {
  const rec = record(home)
  switch (cmd) {
    case 'fetch': { // <pkg> <version> <integrity> <registry> <cwd>: prints the verified tarball's path
      const [pkg, version, integrity, registry, cwd] = args
      console.log(rec.path(pkg, { file: rec.fetch(pkg, version, integrity, registry, cwd) }))
      break
    }
    case 'set': { // <pkg> <version> <integrity> <registry> <tarball path> [registry id]
      const [pkg, version, integrity, registry, path, id] = args
      rec.set(pkg, { version, integrity, registry, file: path.split('/').at(-1), ...(id && { id }) })
      break
    }
    case 'del': rec.del(args[0]); break
    case 'has': process.exit(rec.read()[args[0]] ? 0 : 1)
    case 'files': for (const [pkg, e] of Object.entries(rec.read())) if (existsSync(rec.path(pkg, e))) console.log(rec.path(pkg, e)); break
    case 'registries': for (const [pkg, e] of Object.entries(rec.read())) console.log(`${pkg.split('/')[0]} ${e.registry}`); break
    case 'list':
      for (const [pkg, e] of Object.entries(rec.read())) console.log(`${pkg}@${e.version}${e.available ? `  (${e.available.version} available: ruyix upgrade)` : ''}`)
      break
    case 'upgrade': { // <cwd>: each plugin's tarball for an upgrade — a newer reviewed one when it is there and checks out
      for (const [pkg, e] of Object.entries(rec.read())) {
        let file = e.file
        if (e.available && newer(e.available.version, e.version) > 0) {
          try { file = rec.fetch(pkg, e.available.version, e.available.integrity, e.available.registry || e.registry, args[0]) } catch (err) { console.error(`  ! ${err.message.split('\n')[0]}: ${pkg} stays at ${e.version}`) }
        }
        if (existsSync(rec.path(pkg, { file }))) console.log(rec.path(pkg, { file }))
      }
      break
    }
    case 'settle': { // <profile dir>: after an install, an entry whose newer version is what the profile has now moves to it
      for (const [pkg, e] of Object.entries(rec.read())) {
        const a = e.available
        if (a && installed(args[0], pkg) === a.version) {
          const file = `${pkg.slice(1).replace('/', '-')}-${a.version}.tgz`
          rec.set(pkg, { version: a.version, integrity: a.integrity, registry: a.registry || e.registry, file, ...(e.id && { id: e.id }) })
        }
      }
      break
    }
    case 'installed': process.exit(installed(args[0], args[1]) === args[2] ? 0 : 1)
    // under the lock: a commit a crash cut short (the layout moved aside) is undone before the layout is read
    case 'apply': if (await withLock(home, () => applyLayout(home, args[0]))) console.log(plugins(home, args[0]).filter(x => !x.core).map(x => `${x.on ? '+' : '-'}${x.name.split('/')[1]}`).join(' ')); break
    case 'toggle': { // <profile dir> <pkg> on|off|default
      const [pd, pkg, to] = args, p = plugins(home, pd).find(x => x.name === pkg || x.name.split('/')[1] === pkg || x.name === `@ruyix/${pkg}`)
      if (!p) throw new Error(`${pkg} is not installed in this profile (ruyix plugin list)`)
      if (p.core) throw new Error(`${p.name} is always on`)
      await writeLayout(home, l => { const plugins = { ...l.plugins }; if (to === 'default') delete plugins[p.name]; else plugins[p.name] = to === 'on'; return { ...l, plugins } })
      console.log(p.name)
      break
    }
    case 'state': for (const x of plugins(home, args[0])) console.log(`${x.on ? 'on ' : 'off'} ${x.name}${x.core ? '  (always)' : x.on !== x.default ? '  (changed)' : ''}`); break
    default: throw new Error(`ruyix-plugin.mjs: unknown command ${cmd}`)
  }
}

let mainUrl = ''
try { if (process.argv[1]) mainUrl = pathToFileURL(realpathSync(process.argv[1])).href } catch { /* a host's argv[1] need not be a file */ }
if (import.meta.url === mainUrl) main(process.argv.slice(2)).catch(err => { console.error(`✗ ${err.message.split('\n')[0]}`); process.exit(1) })
