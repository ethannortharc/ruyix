// Makes a Ruyix release: every @ruyix package at one version, built and checked, packed as it would be installed — and,
// with --publish, put in the registry a box upgrades from (ruyix upgrade --version <v>). Releases go out on Ethan's word:
// a minor version for a release (0.1.0 → 0.2.0), a patch for a fix (0.2.1).
//   node tools/release.mjs <version>             a dry run: checks, builds, packs every package into release/<version>/;
//                                                nothing is published, nothing in the checkout changes
//   node tools/release.mjs <version> --publish   also: the versions bumped in the checkout, committed ("Ruyix <version>")
//                                                and tagged v<version>, the packages published, the commit and tag pushed
// The registry: $RUYIX_REGISTRY, by default the private ruyix organisation's npm registry on git.giomni.com. Publishing
// takes a token with package write access in $RUYIX_PUBLISH_TOKEN: it goes into a temporary npmrc, never into the
// checkout, never printed.
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = process.env.RUYIX_REGISTRY || 'https://git.giomni.com/api/packages/ruyix/npm/'
const args = process.argv.slice(2)
const version = args.find(a => !a.startsWith('--'))
const publish = args.includes('--publish')
const die = s => { console.error(`✗ ${s}`); process.exit(1) }
const say = s => console.log(`▸ ${s}`)
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const read = f => JSON.parse(readFileSync(f, 'utf8'))
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const newer = (a, b) => { const x = a.match(SEMVER).slice(1).map(Number), y = b.match(SEMVER).slice(1).map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] }

/** The packages a release is: the workspace's @ruyix packages (not private ones, not the map template). */
export function releasePackages(dir = root) {
  const globs = read(join(dir, 'package.json')).workspaces || []
  const dirs = globs.flatMap(g => (g.endsWith('/*') ? (existsSync(join(dir, g.slice(0, -2))) ? readdirSync(join(dir, g.slice(0, -2))).map(n => join(g.slice(0, -2), n)) : []) : [g]))
  return dirs.filter(d => existsSync(join(dir, d, 'package.json'))).map(d => ({ dir: d, pkg: read(join(dir, d, 'package.json')) }))
    .filter(({ pkg }) => pkg.name?.startsWith('@ruyix/') && !pkg.private)
}

/** A package's manifest as released: this version, and every @ruyix dependency at it (in the checkout they are file:). */
export function releasedManifest(pkg, v) {
  const out = { ...pkg, version: v }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!pkg[field]) continue
    out[field] = Object.fromEntries(Object.entries(pkg[field]).map(([n, spec]) => [n, n.startsWith('@ruyix/') ? v : spec]))
  }
  delete out.devDependencies
  return out
}

/**
 * What a package would ship (npm pack, its "files") but not carry: each relative import, dynamic import or
 * new URL(…, import.meta.url) in a shipped file that points at a file it does not ship. A checkout links the whole
 * folder, so only an install from a release finds these (0.2.1: shell's providers.js, agent-hub's endpoints.js).
 * → ['providers.js (from settings.js)', …]
 */
export function missingFiles(dir) {
  const [info] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  const files = new Set(info.files.map(f => f.path))
  const ships = p => files.has(p) || [...files].some(f => f.startsWith(`${p}/`))
  const out = new Set()
  // what its package.json "exports" names (another package imports those: @ruyix/shell/work, …)
  const targets = e => (typeof e === 'string' ? [e] : e && typeof e === 'object' ? Object.values(e).flatMap(targets) : [])
  for (const t of targets(read(join(dir, 'package.json')).exports)) {
    const target = normalize(t).replace(/\/$/, '')
    if (!target.includes('*') && target !== 'client.js' && !ships(target)) out.add(`${target} (from package.json exports)`) // (client.js: built)
  }
  for (const f of files) {
    if (!/\.(m?js|cjs)$/.test(f) || f === 'client.js' || f.startsWith('vendor/')) continue
    const src = readFileSync(join(dir, f), 'utf8')
    for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]|new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g)) {
      const target = normalize(join(dirname(f), m[1] || m[2])).replace(/\/$/, '')
      if (!target.startsWith('..') && !ships(target)) out.add(`${target} (from ${f})`)
    }
  }
  return [...out]
}

/** Resume a partial publish without replacing packages already present (and verify their exact tarball). */
export function publishPackages(packed, { version, registry, userconfig, run = spawnSync, report = console.log }) {
  for (const p of packed) {
    const auth = ['--registry', registry, '--userconfig', userconfig]
    const found = run('npm', ['view', `${p.name}@${version}`, 'dist.integrity', '--json', ...auth], { encoding: 'utf8', env: process.env })
    if (found.status === 0) {
      // npm reports an unpublished exact version with E404. Missing integrity on success cannot authorize overwriting it.
      let integrity
      try { integrity = JSON.parse(found.stdout) } catch { /* malformed response is refused below */ }
      if (integrity !== p.integrity) throw new Error(`${p.name}@${version}: registry integrity differs from this release`)
      report(`  already published ${p.name}@${version}`)
      continue
    }
    if (!/\bE404\b/.test(`${found.stdout} ${found.stderr}`)) throw new Error(`${p.name}: registry lookup failed; retry when the registry is available`)
    const result = run('npm', ['publish', p.file, ...auth], { encoding: 'utf8', env: process.env })
    if (result.status !== 0) throw new Error(`${p.name}: publish failed; rerun the same release command to resume`)
    report(`  published ${p.name}@${version}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!version || !SEMVER.test(version)) die('node tools/release.mjs <major.minor.patch> [--publish]')
  const pkgs = releasePackages()
  const current = read(join(root, 'core/shell/package.json')).version
  const resuming = publish && version === current
  if (newer(version, current) <= 0 && version !== current) die(`${version} is not newer than ${current}`)
  if (git('status', '--porcelain', '--', '.')) die('the checkout has uncommitted changes: a release is made from a commit')
  if (publish) {
    if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') die('releases are made from main')
    git('fetch', '-q', 'origin')
    const head = git('rev-parse', 'HEAD'), remote = git('rev-parse', 'origin/main')
    if (resuming) {
      if (!git('tag', '-l', `v${version}`) || git('rev-parse', `v${version}^{commit}`) !== head || git('log', '-1', '--format=%s') !== `Ruyix ${version}` || pkgs.some(p => p.pkg.version !== version)) die('resume requires the tagged release commit and matching package versions')
      if (remote !== head && remote !== git('rev-parse', 'HEAD^')) die('the release is no longer directly on origin/main: reconcile main before resuming')
    } else {
      if (head !== remote) die('main is not the same as origin/main: pull or push first')
      if (git('tag', '-l', `v${version}`)) die(`v${version} exists`)
    }
    if (!process.env.RUYIX_PUBLISH_TOKEN) die('RUYIX_PUBLISH_TOKEN: a token that may write packages to the registry')
  }
  say(`Ruyix ${current} → ${version}: ${pkgs.map(p => p.pkg.name).join(', ')}`)

  const out = join(root, 'release', version)
  let packed = []
  if (resuming) {
    const receipt = read(join(out, 'release.json'))
    if (receipt.version !== version || receipt.registry !== REGISTRY || receipt.commit !== git('rev-parse', '--short', 'HEAD^') || JSON.stringify(receipt.packages.map(p => p.name).sort()) !== JSON.stringify(pkgs.map(p => p.pkg.name).sort())) die('the saved release does not match this commit, registry and packages')
    packed = receipt.packages.map(p => {
      if (typeof p.file !== 'string' || dirname(p.file) !== '.') die('invalid saved release archive')
      const file = join(out, p.file)
      if (`sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}` !== p.integrity) die(`${p.name}: saved archive changed; restore the original release archive`)
      return { ...p, file }
    })
    say('resuming the saved, verified release archives')
  } else {
    // built and checked (the clients are built by the checks)
    say('checks')
    const checks = spawnSync(process.execPath, [join(root, 'tools/check-all.mjs')], { cwd: root, encoding: 'utf8' })
    if (checks.status !== 0) { console.error(String(checks.stdout).split('\n').filter(l => /✗|fail/i.test(l)).slice(0, 20).join('\n')); die('the checks failed') }

    // every package carries what its files import (after the builds: a file a build writes — shell's build.json, the
    // commit it was built from — is only there then, and is what ships)
    const gaps = pkgs.flatMap(({ dir, pkg }) => missingFiles(join(root, dir)).map(m => `${pkg.name}: ${m}`))
    if (gaps.length) die(`files imported but not in a package's "files":\n  ${gaps.join('\n  ')}`)

    // packed as released: each package copied (without node_modules), its manifest at this version, then npm pack
    rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
    const stage = mkdtempSync(join(tmpdir(), 'ruyix-release-'))
    try {
      for (const { dir, pkg } of pkgs) {
        const to = join(stage, dir)
        cpSync(join(root, dir), to, { recursive: true, filter: f => !relative(join(root, dir), f).split('/').includes('node_modules') })
        writeFileSync(join(to, 'package.json'), `${JSON.stringify(releasedManifest(pkg, version), null, 2)}\n`)
        cpSync(join(root, 'LICENSE'), join(to, 'LICENSE')) // (MIT: the notice goes with every copy)
        const [info] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', out], { cwd: to, encoding: 'utf8' }))
        packed.push({ name: pkg.name, file: join(out, info.filename), size: info.size, files: info.entryCount, integrity: info.integrity })
        console.log(`  ${pkg.name}@${version}  ${info.entryCount} files, ${(info.size / 1024).toFixed(0)} KB`)
      }
    } finally { rmSync(stage, { recursive: true, force: true }) }
    // installed as a box would (all of them together, their other dependencies from npm) and each one imported
    say('installed and imported')
    const trial = mkdtempSync(join(tmpdir(), 'ruyix-release-trial-'))
    try {
      writeFileSync(join(trial, 'package.json'), '{"private":true}\n')
      const inst = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps', ...packed.map(p => p.file)], { cwd: trial, encoding: 'utf8' })
      if (inst.status !== 0) die(`the packages do not install together: ${String(inst.stderr).split('\n').filter(Boolean).slice(-3).join(' ')}`)
      for (const p of packed) {
        // (a library of the page's — its entry .jsx, bundled into a client by its build — is not loaded by node)
        const m = read(join(trial, 'node_modules', p.name, 'package.json')), entry = (typeof m.exports === 'object' ? m.exports['.'] : m.exports) || m.main || 'index.js'
        if (!/\.(m?js|cjs)$/.test(String(entry))) continue
        const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(p.name)}).then(() => {}, e => { console.error(String(e && e.message || e).split('\\n')[0]); process.exit(1) })`], { cwd: trial, encoding: 'utf8' })
        if (r.status !== 0) die(`${p.name}@${version} does not load as installed: ${String(r.stderr).trim()}`)
      }
    } finally { rmSync(trial, { recursive: true, force: true }) }
    writeFileSync(join(out, 'release.json'), `${JSON.stringify({ version, commit: git('rev-parse', '--short', 'HEAD'), registry: REGISTRY, packages: packed.map(({ file, ...p }) => ({ ...p, file: relative(out, file) })) }, null, 2)}\n`)
  }
  if (!publish) { say(`dry run: packed into ${relative(root, out)}/ — nothing published (add --publish)`); process.exit(0) }

  // the versions in the checkout, one commit and its tag
  if (!resuming) {
    say(`v${version}`)
    for (const { dir, pkg } of pkgs) writeFileSync(join(root, dir, 'package.json'), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`)
    execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: root, stdio: 'ignore' })
    git('add', '-A', '--', ...pkgs.map(p => join(p.dir, 'package.json')), 'package-lock.json')
    git('commit', '-q', '-m', `Ruyix ${version}`)
    git('tag', '-a', `v${version}`, '-m', `Ruyix ${version}`)
  }

  // published: the token only in a temporary npmrc
  const host = REGISTRY.replace(/^https?:/, '')
  const rc = mkdtempSync(join(tmpdir(), 'ruyix-npmrc-'))
  writeFileSync(join(rc, 'npmrc'), `${host}:_authToken=\${RUYIX_PUBLISH_TOKEN}\n@ruyix:registry=${REGISTRY}\n`, { mode: 0o600 })
  try {
    publishPackages(packed, { version, registry: REGISTRY, userconfig: join(rc, 'npmrc') })
  } finally { rmSync(rc, { recursive: true, force: true }) }
  git('push', '-q', 'origin', 'main', `v${version}`)
  say(`Ruyix ${version} is out (${REGISTRY}): in a box, ruyix upgrade --version ${version}`)
}
