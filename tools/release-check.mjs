// The release script's pure parts (tools/release.mjs): which packages a release is, and their manifests as released.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { missingFiles, publishPackages, releasedManifest, releasePackages } from './release.mjs'

const names = releasePackages().map(p => p.pkg.name).sort()
assert.deepEqual(names, ['@ruyix/agent-hub', '@ruyix/apps', '@ruyix/board', '@ruyix/box', '@ruyix/connectors', '@ruyix/messages', '@ruyix/newsletter', '@ruyix/plume', '@ruyix/shell', '@ruyix/studio', '@ruyix/video', '@ruyix/web', '@ruyix/workbench', '@ruyix/world'],
  'every @ruyix package of the workspace, not the map template')
const m = releasedManifest({ name: '@ruyix/workbench', version: '0.1.0', dependencies: { '@ruyix/board': 'file:../board', yaml: '^2.0.0' }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' }, devDependencies: { esbuild: '1' } }, '0.2.0')
assert.deepEqual(m, { name: '@ruyix/workbench', version: '0.2.0', dependencies: { '@ruyix/board': '0.2.0', yaml: '^2.0.0' }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } },
  'one version: its own and every @ruyix dependency; the build tools stay behind')
// every package ships the files its own files import (a checkout links whole folders: only a release would notice)
const root = new URL('..', import.meta.url).pathname
for (const { dir, pkg } of releasePackages()) assert.deepEqual(missingFiles(join(root, dir)), [], `${pkg.name}: add these to its package.json "files"`)
// what a box's `ruyix upgrade` brings along (core/shell/bin/ruyix): the plugins its image is built with, as the Dockerfile has them
{
  const built = readFileSync(join(root, 'box/image/Dockerfile'), 'utf8').match(/for p in ([^;]+); do \(cd "\$p" && node build\.mjs\)/)?.[1].trim().split(/\s+/) || []
  const names = built.map(d => JSON.parse(readFileSync(join(root, d, 'package.json'), 'utf8')).name)
  assert.ok(names.length > 5, 'the Dockerfile still builds its plugins in one `for p in …` line')
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'core/shell/package.json'), 'utf8')).ruyix.packages, names,
    'core/shell/package.json ruyix.packages: the plugins box/image/Dockerfile builds, in its order')
}
// A failed second package resumes with only the missing package, and a lookup failure never publishes.
{
  const packages = ['one', 'two'].map(name => ({ name, file: name + '.tgz', integrity: name + '-hash' }))
  const published = new Map(), calls = [], opts = { version: '1.0.0', registry: 'https://registry.invalid/', userconfig: '/unused', report: () => {} }
  let fail = true
  opts.run = (_, a) => {
    if (a[0] === 'view') { const name = a[1].split('@')[0]; return published.has(name) ? { status: 0, stdout: JSON.stringify(published.get(name)) } : { status: 1, stderr: 'E404' } }
    const name = a[1].replace('.tgz', ''); calls.push(name)
    if (name === 'two' && fail) { fail = false; return { status: 1 } }
    published.set(name, name + '-hash'); return { status: 0 }
  }
  assert.throws(() => publishPackages(packages, opts), /rerun/)
  publishPackages(packages, opts)
  assert.deepEqual(calls, ['one', 'two', 'two'])
  assert.throws(() => publishPackages([{ ...packages[0], integrity: 'different' }], opts), /integrity differs/)
  assert.throws(() => publishPackages(packages, { ...opts, run: () => ({ status: 1, stderr: 'ETIMEDOUT' }) }), /lookup failed/)
  let sent = false
  assert.throws(() => publishPackages(packages, { ...opts, run: (_, a) => { if (a[0] === 'publish') sent = true; return { status: 0, stdout: '' } } }), /integrity differs/)
  assert.equal(sent, false, 'an empty success response is not evidence that publishing this version is safe')
}

if (process.platform !== 'win32') {
  // Exercise the real CLI against a temporary git remote and fake npm. No registry or publishing service is contacted.
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ruyix-release-resume-'))), repo = join(temp, 'repo space-中文'), remote = join(temp, 'remote.git'), bin = join(temp, 'bin')
  const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
  try {
    mkdirSync(repo); mkdirSync(bin)
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    write(join(repo, 'package.json'), JSON.stringify({ private: true, workspaces: ['core/shell', 'core/board'] }))
    for (const name of ['shell', 'board']) write(join(repo, `core/${name}/package.json`), JSON.stringify({ name: `@ruyix/${name}`, version: '0.1.0', exports: './view.jsx', ruyix: { dsh: 'test' } }))
    write(join(repo, 'package-lock.json'), '{}')
    write(join(repo, 'LICENSE'), 'MIT License (fixture)\n') // (every package gets it)
    cpSync(join(root, 'tools/release.mjs'), join(repo, 'tools/release.mjs'), { recursive: true })
    write(join(repo, 'tools/check-all.mjs'), 'console.log("fixture checks: ok")')
    write(join(repo, '.gitignore'), 'release/\nnode_modules/\n.env\n.env.*\n')
    write(join(bin, 'npm'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const a = process.argv.slice(2), file = process.env.FAKE_REGISTRY, state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { published: {}, failed: false, calls: [] }
const save = () => fs.writeFileSync(file, JSON.stringify(state))
if (a[0] === 'view') {
  if (state.published[a[1]]) console.log(JSON.stringify(state.published[a[1]]))
  else { console.error('E404'); process.exit(1) }
} else if (a[0] === 'publish') {
  const file = a[1], name = path.basename(file).includes('shell') ? '@ruyix/shell' : '@ruyix/board'
  state.calls.push(name)
  if (name.endsWith('board') && !state.failed) { state.failed = true; save(); process.exit(1) }
  state.published[name + '@0.2.0'] = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64'); save()
} else if (a[0] === 'pack') {
  const pkg = JSON.parse(fs.readFileSync('package.json')), filename = pkg.name.replace('@', '').replace('/', '-') + '-' + pkg.version + '.tgz', bytes = Buffer.from(pkg.name + pkg.version)
  if (a.includes('--pack-destination')) fs.writeFileSync(path.join(a[a.indexOf('--pack-destination') + 1], filename), bytes)
  console.log(JSON.stringify([{ filename, size: bytes.length, entryCount: 1, files: [{ path: 'view.jsx' }], integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') }]))
} else if (a[0] === 'install' && !a.includes('--package-lock-only')) {
  for (const name of ['shell', 'board']) { const dir = path.join('node_modules', '@ruyix', name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ exports: './view.jsx' })) }
}
`)
    chmodSync(join(bin, 'npm'), 0o755)
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid')
    git('add', '.'); git('commit', '-qm', 'base'); git('init', '--bare', '-q', remote); git('remote', 'add', 'origin', remote); git('push', '-q', '-u', 'origin', 'main')
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_REGISTRY: join(temp, 'registry.json'), RUYIX_PUBLISH_TOKEN: 'local-fixture-only', RUYIX_REGISTRY: 'https://registry.invalid/' }
    const run = () => spawnSync(process.execPath, [join(repo, 'tools/release.mjs'), '0.2.0', '--publish'], { cwd: repo, env, encoding: 'utf8' })
    const first = run(); assert.notEqual(first.status, 0); assert.match(first.stderr, /rerun the same release/)
    const release = git('rev-parse', 'HEAD')
    const second = run(); assert.equal(second.status, 0, second.stderr)
    assert.deepEqual(JSON.parse(readFileSync(env.FAKE_REGISTRY)).calls, ['@ruyix/shell', '@ruyix/board', '@ruyix/board'])
    assert.equal(git('rev-parse', 'HEAD'), release, 'resume neither recommits nor retags')
    assert.equal(git('rev-parse', 'origin/main'), release)
    assert.match(git('ls-remote', '--tags', 'origin', 'v0.2.0'), /refs\/tags\/v0.2.0/)
    // Build the context through the actual script, including tracked and untracked secret files.
    cpSync(join(root, 'box/image/build.sh'), join(repo, 'box/image/build.sh'), { recursive: true })
    write(join(repo, 'box/image/Dockerfile'), '# fixture')
    write(join(repo, 'core/shell/.env'), 'fixture-secret'); git('add', '-f', 'core/shell/.env')
    write(join(repo, 'tools/.env.production'), 'fixture-secret')
    write(join(repo, 'packs/keep.txt'), 'ordinary input')
    write(join(bin, 'engine'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path')
if (process.argv[2] === 'build') {
 const src = path.join(process.argv.at(-1), 'src')
 if (fs.existsSync(path.join(src, 'core/shell/.env')) || fs.existsSync(path.join(src, 'tools/.env.production')) || !fs.existsSync(path.join(src, 'packs/keep.txt'))) process.exit(1)
}
`)
    chmodSync(join(bin, 'engine'), 0o755)
    const image = spawnSync('bash', [join(repo, 'box/image/build.sh'), '--engine', join(bin, 'engine')], { cwd: repo, env, encoding: 'utf8' })
    assert.equal(image.status, 0, image.stderr)
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
console.log('ruyix release check: ok')
