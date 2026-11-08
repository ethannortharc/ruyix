// No real server, registry, install or signal: only isolated profiles and fake process metadata.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyLayout, plugins } from './bin/ruyix-plugin.mjs'
import { identify, ownedProcess, parsePs, readProcess, signalProcess } from './bin/ruyix-process.mjs'
import { createChanges } from './surfaces.js'

const here = dirname(fileURLToPath(import.meta.url)), script = join(here, 'bin/ruyix')
const tmp = mkdtempSync(join(tmpdir(), 'ruyix-cli-check-'))
const q = s => `'${s.replaceAll("'", "'\\''")}'`
try {
  // Imported by a desktop host whose argv[1] is a flag rather than a script path: entry-point checks never throw.
  const modules = ['bin/ruyix-plugin.mjs', 'bin/ruyix-data.mjs', 'bin/ruyix-chat.mjs', 'bin/ruyix-mcp.mjs', '../plugins/apps/browser-mcp.mjs', '../plugins/web/web-mcp.mjs'].map(p => new URL(p, import.meta.url).href)
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv[1] = '--no-sandbox'; for (const url of ${JSON.stringify(modules)}) await import(url)`], { encoding: 'utf8' })
  assert.equal(imported.status, 0, imported.stderr)
  const uid = 123, processOf = (pid, extra = {}) => ({ pid, uid, parent: 1, group: pid, session: pid, start: `${pid}-start`, profile: 'ruyix', dsh: true, ...extra })
  const ps = new Map([[10, processOf(10)], [11, processOf(11, { parent: 10, group: 10, session: 10 })], [20, processOf(20, { profile: 'other' })], [30, processOf(30, { dsh: false })]])
  const read = pid => { const p = ps.get(pid); if (!p) throw new Error('no process'); return p }
  const identity = { product: 'ruyix', profile: 'ruyix', pid: 11 }
  const saved = { pid: 10, start: '10-start' }
  assert.deepEqual(ownedProcess(identity, 'ruyix', saved, read, uid), { pid: 10, start: '10-start', group: true })
  assert.deepEqual(ownedProcess(identity, 'ruyix', { pid: 10 }, read, uid), { pid: 10, start: '10-start', group: true }, 'legacy PID still needs actual profile and ancestry')
  assert.deepEqual(ownedProcess(identity, 'ruyix', null, read, uid), { pid: 11, start: '11-start', group: false }, 'externally started dsh never kills its terminal session')
  assert.throws(() => ownedProcess({ ...identity, product: 'other' }, 'ruyix', saved, read, uid), /another service/)
  assert.throws(() => ownedProcess({ ...identity, profile: 'other' }, 'ruyix', saved, read, uid), /another service/)
  assert.throws(() => ownedProcess(identity, 'ruyix', { ...saved, start: 'old-start' }, read, uid), /stale/)
  assert.throws(() => ownedProcess(identity, 'ruyix', { pid: 20 }, read, uid), /another profile/)
  assert.throws(() => ownedProcess({ ...identity, pid: 30 }, 'ruyix', null, read, uid), /not this profile/)
  assert.throws(() => ownedProcess(identity, 'ruyix', saved, read, 456), /not this profile/)
  ps.set(40, processOf(40))
  assert.throws(() => ownedProcess(identity, 'ruyix', { pid: 40 }, read, uid), /not the server’s parent/)
  const target = ownedProcess(identity, 'ruyix', saved, read, uid), signals = []
  signalProcess(target, 'ruyix', 'SIGTERM', read, (...args) => signals.push(args), uid)
  ps.set(10, processOf(10, { start: 'recycled' }))
  assert.throws(() => signalProcess(target, 'ruyix', 'SIGKILL', read, (...args) => signals.push(args), uid), /identity changed/)
  assert.deepEqual(signals, [[-10, 'SIGTERM']], 'a replaced process is never signaled during escalation')

  // macOS: ps's line (lstart in C's order, or a locale's), the same shape as /proc's reading
  {
    const bin = join(tmp, 'npx-cache/node_modules/@deepseek-ai/dsh/bin'), link = join(tmp, 'npx-cache/node_modules/.bin')
    mkdirSync(bin, { recursive: true }); mkdirSync(link, { recursive: true }); writeFileSync(join(bin, 'dsh.js'), '')
    spawnSync('ln', ['-s', '../@deepseek-ai/dsh/bin/dsh.js', join(link, 'dsh')])
    const c = parsePs(`  812   811   811   501 Tue Oct 13 09:12:01 2026     /opt/homebrew/bin/node ${join(link, 'dsh')} --profile ruyix --no-open --port 3280\n`)
    assert.deepEqual(c, { pid: 812, uid: 501, parent: 811, group: 811, session: 811, start: 'Tue Oct 13 09:12:01 2026', profile: 'ruyix', dsh: true })
    const ca = parsePs('811 1 811 501 Tue 13 Oct 09:12:01 2026 npm exec @deepseek-ai/dsh@0.2.0 --profile ruyix --no-open --port 3280')
    assert.deepEqual([ca.start, ca.profile, ca.dsh, ca.group === ca.pid && ca.session === ca.pid], ['Tue 13 Oct 09:12:01 2026', 'ruyix', true, true], 'en_CA order kept as it is; npm exec\'s title')
    assert.equal(parsePs('811 1 811 501 Tue Oct 13 09:12:01 2026 node /opt/homebrew/bin/npx -y @deepseek-ai/dsh@0.2.0 --profile ruyix --port 3280').dsh, true, 'npx before npm exec renames it')
    assert.deepEqual(parsePs('900 1 900 501 Tue Oct 13 09:12:01 2026 node /srv/other.js --profile ruyix'), { pid: 900, uid: 501, parent: 1, group: 900, session: 900, start: 'Tue Oct 13 09:12:01 2026', profile: 'ruyix', dsh: false }, 'a profile flag is not dsh')
    assert.throws(() => parsePs('not a process line'), /cannot parse/)
    if (process.platform === 'darwin') { // the real ps, on this very process; a process that is gone is ENOENT
      const me = readProcess(process.pid)
      assert.deepEqual([me.pid, me.uid, me.session === me.group], [process.pid, process.getuid(), true])
      assert.throws(() => readProcess(spawnSync('true').pid), { code: 'ENOENT' })
    }
    assert.deepEqual(identify(['npm exec @deepseek-ai/dsh@0.2.0 --profile=ops web']), { profile: 'ops', dsh: true }, 'Linux: npm exec\'s one-string title as before')
  }

  const fixture = name => {
    const root = join(tmp, name), home = join(root, 'home'), ruyix = join(home, '.ruyix'), dsh = join(home, '.dsh'), profile = join(dsh, 'profiles/ruyix')
    const pkg = join(profile, 'node_modules/@ruyix/shell')
    mkdirSync(join(pkg, 'bin'), { recursive: true }); mkdirSync(ruyix, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@ruyix/shell': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }))
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.0.0', ruyix: { dsh: '1.0.0' } }))
    const state = join(root, 'running'), events = join(root, 'events')
    const old = `#!/bin/bash\ncase "$1" in start) touch ${q(state)}; echo old-start >> ${q(events)} ;; setup) exit 0 ;; esac\n`
    writeFileSync(join(pkg, 'bin/ruyix'), old); chmodSync(join(pkg, 'bin/ruyix'), 0o755)
    return { root, home, ruyix, dsh, profile, pkg, state, events, old }
  }
  const run = (f, code, env = {}) => spawnSync('bash', ['-c', `source ${q(script)}\nload_config\n${code}`], {
    env: { ...process.env, HOME: f.home, RUYIX_HOME: f.ruyix, DSH_HOME: f.dsh, RUYIX_REGISTRY: 'https://releases.example/', ...env }, encoding: 'utf8', timeout: 10000,
  })
  const eventText = f => existsSync(f.events) ? readFileSync(f.events, 'utf8') : ''
  {
    const f = fixture('stdin-bootstrap')
    const env = { ...process.env, HOME: f.home, RUYIX_HOME: f.ruyix, DSH_HOME: f.dsh }
    const input = readFileSync(script, 'utf8')
    const version = spawnSync('bash', ['-s', '--', '--version'], { input, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(version.status, 0, version.stdout + version.stderr)
    assert.equal(version.stdout.trim(), '1.0.0', 'stdin bootstrap executes main without BASH_SOURCE')
    const bin = join(f.root, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'node'), '#!/bin/bash\nif [ "$1" = -v ]; then echo v20.0.0; else exit 1; fi\n')
    chmodSync(join(bin, 'node'), 0o755)
    const install = spawnSync('bash', ['-s', '--', 'install'], { input, env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: 'utf8', timeout: 10000 })
    assert.notEqual(install.status, 0)
    assert.match(install.stderr, /Node v20\.0\.0 is too old/, 'stdin install reaches prerequisites without network or real installation')
    assert.doesNotMatch(install.stderr, /unbound variable/)
  }
  {
    const f = fixture('setup-failure')
    const bad = join(f.profile, 'node_modules/@ruyix/bad'), good = join(f.profile, 'node_modules/@ruyix/good')
    mkdirSync(bad); mkdirSync(good)
    writeFileSync(join(bad, 'setup.sh'), '#!/bin/bash\nexit 42\n')
    writeFileSync(join(good, 'setup.sh'), `#!/bin/bash\necho setup-good >> ${q(f.events)}\n`)
    const r = run(f, 'cmd_setup --no-browsers')
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /setup incomplete/)
    assert.match(eventText(f), /setup-good/, 'remaining components are checked after one fails')
  }
  { // setup with no options: an empty array expanded under set -u fails in macOS's bash 3.2 (0.2.2's upgrade did)
    const f = fixture('setup-plain'), good = join(f.profile, 'node_modules/@ruyix/good')
    mkdirSync(good); writeFileSync(join(good, 'setup.sh'), `#!/bin/bash\necho "setup-good $#" >> ${q(f.events)}\n`)
    const r = run(f, 'dsh() { return 0; }; cmd_setup')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(eventText(f), /setup-good 0/, 'each setup.sh runs, given no options')
  }
  {
    const f = fixture('install-setup-failure'), bad = join(f.profile, 'node_modules/@ruyix/bad')
    mkdirSync(bad); writeFileSync(join(bad, 'setup.sh'), '#!/bin/bash\nexit 42\n')
    writeFileSync(join(f.pkg, 'bin/ruyix'), `#!/bin/bash\nexec ${q(script)} "$@"\n`)
    const r = run(f, `write_config() { return 0; }; pnpm() { return 0; }; view() { echo 1.0.0; }; release_dsh() { echo 1.0.0; }; dsh() { return 0; }; cmd_install --no-browsers`)
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /setup incomplete/)
    assert.doesNotMatch(r.stdout, /Done — ruyix start/, 'install must not report success after setup fails')
  }
  for (const [name, busy, force, ok] of [['busy', "printf 'active task\\n'", '', false], ['unknown', 'return 1', '', false], ['forced', "printf 'active task\\n'", '--force', true]]) {
    const f = fixture(`restart-${name}`)
    const r = run(f, `running() { return 0; }; owned_pid() { return 0; }; busy() { ${busy}; }; cmd_stop() { echo stop >> ${q(f.events)}; }; cmd_start() { echo start >> ${q(f.events)}; }; cmd_restart ${force}`)
    assert.equal(r.status === 0, ok, r.stdout + r.stderr)
    assert.equal(eventText(f), ok ? 'stop\nstart\n' : '')
  }
  for (const action of ['cmd_start', 'cmd_stop', 'cmd_restart --force']) {
    const f = fixture(action.replaceAll(' ', '-'))
    const r = run(f, `running() { return 0; }; owned_pid() { return 1; }; ${action}`)
    assert.notEqual(r.status, 0, `${action} must reject foreign services/profiles`)
    assert.equal(eventText(f), '')
  }
  {
    const f = fixture('startup-timeout')
    const r = run(f, `
running() { return 1; }; owned_pid() { return 1; }; setsid() { return 0; }; seq() { echo 1; }; sleep() { return 0; }
node() {
  if [[ "$1" == *ruyix-process.mjs ]]; then
    case "$2" in remember) printf '%s' '{"pid":37,"start":"started"}' > "$5" ;; signal) echo "$5" >> ${q(f.events)} ;; esac
  else command node "$@"; fi
}
cmd_start
`)
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.equal(eventText(f), 'SIGTERM\nSIGKILL\n', 'failed startup cleans its verified process before an upgrade restores the old profile')
  }
  for (const failure of ['install', 'setup', 'start', 'none']) {
    const f = fixture(`upgrade-${failure}`)
    writeFileSync(f.state, '')
    writeFileSync(join(f.profile, 'sentinel'), 'original')
    const replacement = `#!/bin/bash\ncase "$1" in setup) echo new-setup >> ${q(f.events)}; exit ${failure === 'setup' ? 42 : 0} ;; start) echo new-start >> ${q(f.events)}; ${failure === 'start' ? 'exit 42' : `touch ${q(f.state)}`} ;; esac\n`
    const r = run(f, `
running() { [ -f ${q(f.state)} ]; }
require_idle() { return 0; }
cmd_stop() { rm -f ${q(f.state)}; echo stop >> ${q(f.events)}; }
release_dsh() { echo 2.0.0; }
dsh() {
  printf '%s' ${q(JSON.stringify({ version: '2.0.0', ruyix: { dsh: '2.0.0' } }))} > ${q(join(f.pkg, 'package.json'))}
  printf '%s' ${q(replacement)} > ${q(join(f.pkg, 'bin/ruyix'))}
  echo changed > ${q(join(f.profile, 'sentinel'))}
  return ${failure === 'install' ? 42 : 0}
}
cmd_upgrade --version 2.0.0
`)
    assert.equal(r.status === 0, failure === 'none', r.stdout + r.stderr)
    const version = JSON.parse(readFileSync(join(f.pkg, 'package.json'), 'utf8')).version
    assert.equal(version, failure === 'none' ? '2.0.0' : '1.0.0')
    assert.equal(readFileSync(join(f.profile, 'sentinel'), 'utf8').trim(), failure === 'none' ? 'changed' : 'original')
    assert.match(eventText(f), failure === 'none' ? /new-start/ : /old-start/, 'failed upgrade restores and starts the previous profile')
    if (failure !== 'none') assert.equal(readFileSync(join(f.pkg, 'bin/ruyix'), 'utf8'), f.old)
    assert.ok(!readdirSync(join(f.dsh, 'profiles')).some(n => n.startsWith('.ruyix-rollback.')), 'completed rollback cleans its temporary copy')
  }
  {
    // a box: the image's release behind the profile; ruyix upgrade puts one of the home's own over it, --image goes back
    const f = fixture('box'), image = join(f.root, 'opt/ruyix'), ip = join(image, 'dsh-home/profiles/ruyix')
    const ipkg = join(ip, 'node_modules/@ruyix/shell'), env = { RUYIX_IMAGE: image }
    mkdirSync(join(ipkg, 'bin'), { recursive: true })
    // (as the image is built: its plugins linked from its own source, /opt/ruyix/src)
    const imagePkg = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
    imagePkg.dependencies = Object.fromEntries(Object.entries(imagePkg.dependencies || {}).map(([n, v]) => [n, n.startsWith('@ruyix/') ? `link:${image}/src/${n.slice(7)}` : v]))
    writeFileSync(join(ip, 'package.json'), JSON.stringify(imagePkg))
    writeFileSync(join(ipkg, 'package.json'), JSON.stringify({ version: '1.0.0', ruyix: { dsh: '1.0.0' } }))
    writeFileSync(join(ipkg, 'bin/ruyix'), `#!/bin/bash\necho "image-ruyix $1" >> ${q(f.events)}\n`); chmodSync(join(ipkg, 'bin/ruyix'), 0o755)
    rmSync(join(f.profile, 'node_modules'), { recursive: true })
    const linked = () => spawnSync('test', ['-L', join(f.profile, 'node_modules')]).status === 0
    const version = () => JSON.parse(readFileSync(join(f.profile, 'node_modules/@ruyix/shell/package.json'), 'utf8')).version
    let r = run(f, 'image_profile', env)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(linked() && version() === '1.0.0', 'the image\'s release behind the profile')
    assert.match(readFileSync(join(f.profile, 'package.json'), 'utf8'), /"link:/, 'its plugins linked into the image, as a built image has them')
    // a profile linked to a source checkout elsewhere is not upgraded from a registry
    r = run(f, 'our_packages() { echo "@ruyix/shell link:/home/me/ruyix/core/shell"; }; cmd_upgrade --version 2.0.0', env)
    assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /source checkout \(\/home\/me\/ruyix\/core\/shell\)/)
    const home = `#!/bin/bash\necho "home-ruyix $1" >> ${q(f.events)}\n`
    writeFileSync(join(f.ruyix, 'config'), 'RUYIX_REGISTRY=https://releases.example/\n') // stopping reads it again
    writeFileSync(f.state, '')
    r = run(f, `
running() { [ -f ${q(f.state)} ]; }
require_idle() { return 0; }
cmd_stop() { load_config; rm -f ${q(f.state)}; }
release_dsh() { echo 1.0.0; }
release_packages() { echo "@ruyix/shell @ruyix/video"; } # (a plugin new in this release: it comes along)
dsh() { # dsh plugin add: a real install in the profile (the image's link was taken away first)
  echo "dsh $*" >> ${q(f.events)}
  [ ! -L "$PD/node_modules" ] || { echo "still linked" >&2; return 1; }
  mkdir -p "$PD/node_modules/$SHELL_PKG/bin"
  printf '%s' ${q(JSON.stringify({ version: '2.0.0-dev.1', ruyix: { dsh: '1.0.0' } }))} > "$PD/node_modules/$SHELL_PKG/package.json"
  printf '%s' ${q(home)} > "$PD/node_modules/$SHELL_PKG/bin/ruyix"; chmod +x "$PD/node_modules/$SHELL_PKG/bin/ruyix"
}
cmd_upgrade --version 2.0.0-dev.1 --registry http://registry.example/`, env)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!linked() && version() === '2.0.0-dev.1', 'the home\'s own release')
    assert.match(eventText(f), /add @ruyix\/shell@2\.0\.0-dev\.1 @ruyix\/video@2\.0\.0-dev\.1/, 'a plugin new in the release comes along in a box')
    assert.match(readFileSync(join(f.profile, '.npmrc'), 'utf8'), /^@ruyix:registry=http:\/\/registry\.example\/$/m, '--registry outlives the stop')
    assert.match(eventText(f), /home-ruyix setup\nhome-ruyix start/, 'the new release sets itself up and starts')
    assert.equal(JSON.parse(readFileSync(join(ipkg, 'package.json'), 'utf8')).version, '1.0.0', 'the image is never written')
    assert.equal(run(f, 'image_profile', env).status, 0)
    assert.ok(!linked(), 'start keeps the home\'s release while the image\'s is older')
    const st = run(f, 'view() { echo 1.0.0; }; running() { return 1; }; cmd_status', env).stdout
    assert.match(st, /installed in this home over the image's 1\.0\.0/)
    assert.match(st, /ahead of the latest release \(1\.0\.0\)/, 'a dev release is not behind the latest')
    // the image's ruyix hands every command to the home's release
    r = spawnSync('bash', [script, 'status'], { env: { ...process.env, HOME: f.home, RUYIX_HOME: f.ruyix, DSH_HOME: f.dsh, ...env }, encoding: 'utf8', timeout: 10000 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(eventText(f), /home-ruyix status/)
    // back to the image's release
    r = run(f, 'running() { return 1; }; cmd_upgrade --image', env)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(linked() && version() === '1.0.0')
    // a home release older than a newer image gives way to it
    unlinkSync(join(f.profile, 'node_modules')); mkdirSync(join(f.profile, 'node_modules/@ruyix/shell'), { recursive: true })
    writeFileSync(join(f.profile, 'node_modules/@ruyix/shell/package.json'), JSON.stringify({ version: '0.9.0' }))
    r = run(f, 'image_profile', env)
    assert.match(r.stdout + r.stderr, /image's release 1\.0\.0 is newer than this home's 0\.9\.0/)
    assert.ok(linked() && version() === '1.0.0')
  }
  { // a plugin added or removed is resolved afresh: pnpm 11.28 refuses the lockfile another build wrote (stock bash 3.2 too)
    const f = fixture('plugin-lock'), lock = join(f.profile, 'pnpm-lock.yaml')
    for (const [args, gone] of [['plugin --profile ruyix add /tmp/x.tgz', true], ['plugin --profile ruyix remove @ruyix/x', true], ['plugin list', false], ['start --profile ruyix', false]]) {
      writeFileSync(lock, 'lockfileVersion: 9\n')
      const r = run(f, `dsh_cmd() { echo true; }; dsh 1.0.0 ${args}`)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.equal(!existsSync(lock), gone, `${args}: ${gone ? 'the lockfile is dropped' : 'the lockfile stays'}`)
    }
  }
  // added plugins: fetched from their registry, kept only when the sha512 is the one given, installed from that file;  // third-party ones go in a box; a box puts them back after an image change; an upgrade takes a newer checked version
  {
    const reg = join(tmp, 'npm-registry'), bin = join(tmp, 'fake-bin')
    mkdirSync(reg, { recursive: true }); mkdirSync(bin, { recursive: true })
    // a real tarball (package/package.json), named as npm names it; its sha512 is the "review"
    const tarball = (name, version, extra = '') => {
      const src = mkdtempSync(join(tmp, 'pkg-')), file = `${name.slice(1).replace('/', '-')}-${version}.tgz`
      mkdirSync(join(src, 'package')); writeFileSync(join(src, 'package/package.json'), JSON.stringify({ name, version, extra }))
      assert.equal(spawnSync('tar', ['-czf', join(reg, file), '-C', src, 'package']).status, 0)
      return `sha512-${createHash('sha512').update(readFileSync(join(reg, file))).digest('base64')}`
    }
    const acme = tarball('@acme/notes', '1.2.0'), acme13 = tarball('@acme/notes', '1.3.0'), ours = tarball('@ruyix/extra', '0.1.0')
    // npm pack <spec> --<scope>:registry=<url> --pack-destination <dir> --json, from the fake registry
    writeFileSync(join(bin, 'npm'), `#!/bin/bash
spec=$2; dest=; for a in "$@"; do case "$prev" in --pack-destination) dest=$a ;; esac; prev=$a; done
name=\${spec%@*} ver=\${spec##*@}; file=\${name#@}; file=\${file/\\//-}-$ver.tgz
[ -f ${q(reg)}/$file ] || { echo "404 $spec" >&2; exit 1; }
cp ${q(reg)}/$file "$dest/" && printf '[{"filename":"%s"}]' "$file"
`); chmodSync(join(bin, 'npm'), 0o755)
    const PATH = `${bin}:${process.env.PATH}`
    // dsh plugin add/remove: each tarball's package lands in node_modules (what a real install leaves)
    const dshMock = f => `dsh() {
  echo "dsh \${*:2}" >> ${q(f.events)}
  [ "$3" = --profile ] || return 1
  if [ "$5" = remove ]; then rm -rf "$PD/node_modules/$6"; return 0; fi
  [ ! -L "$PD/node_modules" ] || { echo "still linked" >&2; return 1; }
  local a n; for a in "\${@:6}"; do case "$a" in
    *.tgz) n=$(tar -xzOf "$a" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).name'); mkdir -p "$PD/node_modules/$n"; tar -xzOf "$a" package/package.json > "$PD/node_modules/$n/package.json" ;;
    @*) n=\${a%@*}; mkdir -p "$PD/node_modules/$n/bin"; printf '{"version":"%s","ruyix":{"dsh":"1.0.0"}}' "\${a##*@}" > "$PD/node_modules/$n/package.json"; printf '#!/bin/bash\\n' > "$PD/node_modules/$n/bin/ruyix"; chmod +x "$PD/node_modules/$n/bin/ruyix" ;;
  esac; done
}
running() { [ -f ${q(f.state)} ]; }; require_idle() { return 0; }
cmd_stop() { rm -f ${q(f.state)}; echo stop >> ${q(f.events)}; }; cmd_start() { touch ${q(f.state)}; echo start >> ${q(f.events)}; }
`
    const rec = f => JSON.parse(readFileSync(join(f.ruyix, 'plugins.json'), 'utf8')).plugins
    {
      const f = fixture('plugin-host'), env = { PATH }
      writeFileSync(join(f.profile, '.npmrc'), '@ruyix:registry=https://releases.example/\n')
      let r = run(f, `${dshMock(f)} plugin_add @acme/notes@1.2.0 --integrity ${acme} --registry https://npm.acme.example/`, env)
      assert.notEqual(r.status, 0); assert.match(r.stderr, /third-party plugin: install it in a box/)
      assert.ok(!existsSync(join(f.ruyix, 'plugins')), 'nothing fetched')
      r = run(f, `${dshMock(f)} plugin_add @acme/notes@1.2.0 --integrity ${acme13} --registry https://npm.acme.example/ --on-host`, env)
      assert.notEqual(r.status, 0); assert.match(r.stderr, /not the one added/)
      assert.deepEqual(readdirSync(join(f.ruyix, 'plugins/@acme/notes')), [], 'a tarball that is not the one added is not kept')
      assert.equal(eventText(f), '', 'and nothing was installed')
      writeFileSync(f.state, '')
      r = run(f, `${dshMock(f)} plugin_add @ruyix/extra@0.1.0 --integrity ${ours} --id res1`, env)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(eventText(f), /^stop\ndsh plugin --profile ruyix add \S+\/\.ruyix\/plugins\/@ruyix\/extra\/ruyix-extra-0\.1\.0\.tgz\nstart\n$/, 'on a host: only the plugin, from its kept tarball; dsh restarted')
      assert.deepEqual([rec(f)['@ruyix/extra'].version, rec(f)['@ruyix/extra'].id, rec(f)['@ruyix/extra'].registry], ['0.1.0', 'res1', 'https://releases.example/'], 'our own scope\'s registry by default')
      assert.match(run(f, 'cmd_plugin list').stdout, /@ruyix\/extra@0\.1\.0/)
    }
    {
      const f = fixture('plugin-restart-failed'), env = { PATH }
      writeFileSync(f.state, '')
      const failRestart = `${dshMock(f)} cmd_start() { die 'fixture restart failed'; }; `
      let r = run(f, `${failRestart} plugin_add @acme/notes@1.2.0 --integrity ${acme} --registry https://npm.acme.example/ --on-host`, env)
      assert.notEqual(r.status, 0); assert.match(r.stderr, /fixture restart failed/)
      assert.ok(existsSync(join(f.ruyix, 'plugins.json')), 'a committed install is recorded before the failing restart')
      assert.equal(rec(f)['@acme/notes'].version, '1.2.0'); assert.ok(existsSync(join(f.profile, 'node_modules/@acme/notes/package.json')))
      writeFileSync(f.state, '')
      r = run(f, `${failRestart} plugin_remove @acme/notes`, env)
      assert.notEqual(r.status, 0); assert.match(r.stderr, /fixture restart failed/)
      assert.ok(!rec(f)['@acme/notes'], 'a committed removal stays removed even if Ruyix cannot restart')
      assert.ok(!existsSync(join(f.profile, 'node_modules/@acme/notes')))
    }
    {
      // a box: its image's read-only profile gives way to the home's own install of that release, with the plugin
      const f = fixture('plugin-box'), image = join(f.root, 'opt/ruyix'), ip = join(image, 'dsh-home/profiles/ruyix')
      const ipkg = join(ip, 'node_modules/@ruyix/shell'), env = { RUYIX_IMAGE: image, PATH }
      mkdirSync(ipkg, { recursive: true })
      writeFileSync(join(ip, 'package.json'), readFileSync(join(f.profile, 'package.json')))
      writeFileSync(join(ipkg, 'package.json'), JSON.stringify({ version: '1.0.0', ruyix: { dsh: '1.0.0' } }))
      rmSync(join(f.profile, 'node_modules'), { recursive: true })
      const linked = () => spawnSync('test', ['-L', join(f.profile, 'node_modules')]).status === 0
      assert.equal(run(f, 'image_profile', env).status, 0)
      assert.ok(linked())
      let r = run(f, `${dshMock(f)} plugin_add @acme/notes@1.2.0 --integrity ${acme} --registry https://npm.acme.example/`, env)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.ok(!linked(), 'the home installs the image\'s release')
      assert.match(eventText(f), /dsh plugin --profile ruyix add @ruyix\/shell@1\.0\.0 \S+acme-notes-1\.2\.0\.tgz/)
      assert.match(readFileSync(join(f.profile, '.npmrc'), 'utf8'), /^@acme:registry=https:\/\/npm\.acme\.example\/$/m, 'its scope reaches its registry')
      // a newer image: the home's install gives way to it, and the plugin comes back from its kept tarball
      writeFileSync(join(ipkg, 'package.json'), JSON.stringify({ version: '1.1.0', ruyix: { dsh: '1.0.0' } }))
      writeFileSync(f.events, '')
      r = run(f, `${dshMock(f)} image_profile`, env)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(eventText(f), /add @ruyix\/shell@1\.1\.0 \S+acme-notes-1\.2\.0\.tgz/)
      assert.ok(!linked() && existsSync(join(f.profile, 'node_modules/@acme/notes/package.json')), 'the plugin outlives the image change')
      // an upgrade takes the newer checked version its record names
      const all = rec(f); all['@acme/notes'].available = { version: '1.3.0', integrity: acme13 }
      writeFileSync(join(f.ruyix, 'plugins.json'), JSON.stringify({ plugins: all }))
      writeFileSync(f.events, '')
      r = run(f, `${dshMock(f)} release_dsh() { echo 1.0.0; }; release_packages() { echo "@ruyix/shell"; }; cmd_upgrade --version 1.2.0`, env)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(eventText(f), /add @ruyix\/shell@1\.2\.0 \S+acme-notes-1\.3\.0\.tgz/)
      assert.deepEqual([rec(f)['@acme/notes'].version, rec(f)['@acme/notes'].available], ['1.3.0', undefined])
      assert.deepEqual(readdirSync(join(f.ruyix, 'plugins/@acme/notes')), ['acme-notes-1.3.0.tgz'], 'the replaced tarball goes')
      r = run(f, `${dshMock(f)} plugin_remove @acme/notes`, env)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(eventText(f), /dsh plugin --profile ruyix remove @acme\/notes/)
      assert.deepEqual([rec(f), existsSync(join(f.ruyix, 'plugins/@acme/notes'))], [{}, false])
      assert.notEqual(run(f, `${dshMock(f)} plugin_remove @acme/notes`, env).status, 0, 'only a plugin this home added')
    }
  }
  // the layout: a plugin off by default stays out of the profile's bundles until turned on; the always-on ones stay on
  {
    const home = join(tmp, 'lay-home'), pd = join(tmp, 'lay-pd'), mod = n => join(pd, 'node_modules/@ruyix', n)
    for (const [n, ruyix] of [['board', {}], ['video', {}], ['social', { default: 'off' }]]) { mkdirSync(mod(n), { recursive: true }); writeFileSync(join(mod(n), 'package.json'), JSON.stringify({ ruyix })) }
    const deps = Object.fromEntries(['board', 'video', 'social'].map(n => [`@ruyix/${n}`, '1.0.0']))
    writeFileSync(join(pd, 'package.json'), JSON.stringify({ dependencies: deps, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@ruyix/social', '@ruyix/board'], patchReload: 'live' } } }))
    const bundles = () => JSON.parse(readFileSync(join(pd, 'package.json'), 'utf8')).dsh.profile
    assert.equal(applyLayout(home, pd), true)
    assert.deepEqual(bundles(), { bundles: ['@deepseek-ai/dsh-base', '@ruyix/board', '@ruyix/video'], patchReload: 'live' }, 'off by default; on by default joins')
    assert.equal(applyLayout(home, pd), false, 'nothing to change')
    const toggle = (pkg, to) => spawnSync('node', [join(here, 'bin/ruyix-plugin.mjs'), 'toggle', home, pd, pkg, to], { encoding: 'utf8' })
    assert.equal(toggle('social', 'on').status, 0)
    assert.equal(toggle('@ruyix/video', 'off').status, 0)
    assert.match(toggle('board', 'off').stderr, /always on/)
    applyLayout(home, pd)
    assert.deepEqual(bundles().bundles, ['@deepseek-ai/dsh-base', '@ruyix/board', '@ruyix/social'])
    assert.equal(toggle('video', 'default').status, 0)
    assert.deepEqual(plugins(home, pd).map(x => [x.name.split('/')[1], x.on]), [['board', true], ['social', true], ['video', true]])
  }
  // a home from when Ruyix was Aviary, or Agnos, moves over once: the old home (a link to the new one after), its
  // settings, the profile
  for (const was of ['aviary', 'agnos']) {
    const W = was.toUpperCase(), home = join(tmp, `renamed-${was}`), old = join(home, `.${was}`), dsh = join(home, '.dsh')
    mkdirSync(join(old, 'workbench'), { recursive: true }); mkdirSync(join(dsh, `profiles/${was}`), { recursive: true })
    writeFileSync(join(old, 'desktop.json'), '{"wallpaper":"ink"}')
    // (as a box's is written: a comment after a value, a setting commented out)
    const C = was[0].toUpperCase() + was.slice(1)
    writeFileSync(join(old, 'config'), [`# ${C} — read by ${was} (shell syntax).`, `${W}_PROFILE=${was}          # the dsh profile under ~/.dsh/profiles`, `${W}_PORT=3290`,
      `${W}_LOG=${old}/dsh-web.log`, `# ${W}_REGISTRY=https://npm.example/      # the npm registry the @${was} releases come from (${was} install)`, ''].join('\n'))
    writeFileSync(join(dsh, `profiles/${was}/cordis.patch.yml`), '- id: ui-theme\n')
    const move = () => spawnSync('bash', ['-c', `source ${q(script)}\nfrom_old\nload_config\necho "$RUYIX_PROFILE $RUYIX_PORT $RUYIX_LOG"`], {
      env: { ...process.env, HOME: home, RUYIX_HOME: join(home, '.ruyix'), DSH_HOME: dsh }, encoding: 'utf8', timeout: 10000,
    })
    let r = move()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`ruyix 3290 ${join(home, '.ruyix')}/dsh-web.log`), `${was}: the settings under their new names`)
    assert.equal(readFileSync(join(home, '.ruyix/desktop.json'), 'utf8'), '{"wallpaper":"ink"}')
    assert.equal(readFileSync(join(old, 'desktop.json'), 'utf8'), '{"wallpaper":"ink"}', 'the old name still reaches it')
    assert.equal(readFileSync(join(home, '.ruyix/config'), 'utf8'), ['# Ruyix — read by ruyix (shell syntax).', `RUYIX_PROFILE=ruyix          # the dsh profile under ~/.dsh/profiles`, 'RUYIX_PORT=3290',
      `RUYIX_LOG=${home}/.ruyix/dsh-web.log`, '# RUYIX_REGISTRY=https://npm.example/      # the npm registry the @ruyix releases come from (ruyix install)', ''].join('\n'), 'a path elsewhere keeps its words (renamed-…)')
    assert.ok(existsSync(join(dsh, 'profiles/ruyix/cordis.patch.yml')) && !existsSync(join(dsh, `profiles/${was}`)), 'the profile moves')
    r = move()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /is Ruyix's now/, 'once only')
  }
  // the move, harder cases: one cut short is finished; a ~/.ruyix made first (an install, nookbox's import) takes what it
  // lacks and the rest of the old home is kept aside; an old home that is a link elsewhere is followed (the older name
  // left alone); the old install's dsh still running moves nothing; settings written by hand (export, indent, quotes, #)
  {
    const fresh = name => { const home = join(tmp, `mv-${name}`), dsh = join(home, '.dsh'); mkdirSync(dsh, { recursive: true }); return { home, dsh } }
    const move = ({ home, dsh }, pre = '') => spawnSync('bash', ['-c', `source ${q(script)}\n${pre}from_old\nload_config\necho "$RUYIX_PROFILE $RUYIX_PORT"`], {
      env: { ...process.env, HOME: home, RUYIX_HOME: join(home, '.ruyix'), DSH_HOME: dsh }, encoding: 'utf8', timeout: 15000,
    })
    // cut short: the home moved, the settings not yet
    let h = fresh('half')
    mkdirSync(join(h.home, '.ruyix')); writeFileSync(join(h.home, '.ruyix/config'), 'AGNOS_PROFILE=agnos\nAGNOS_PORT=3300\n')
    spawnSync('ln', ['-s', '.ruyix', join(h.home, '.agnos')])
    let r = move(h)
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /ruyix 3300\n$/, 'finished the next time')
    // a ~/.ruyix made first
    h = fresh('first')
    mkdirSync(join(h.home, '.aviary/workbench/ui-runtime'), { recursive: true }); writeFileSync(join(h.home, '.aviary/workbench/workbench.db'), 'runs')
    writeFileSync(join(h.home, '.aviary/workbench/ui-runtime/old'), 'x'); writeFileSync(join(h.home, '.aviary/desktop.json'), '{"wallpaper":"ink"}')
    mkdirSync(join(h.home, '.ruyix/workbench/ui-runtime'), { recursive: true }); writeFileSync(join(h.home, '.ruyix/import.json'), '{}')
    mkdirSync(join(h.dsh, 'profiles/aviary'), { recursive: true }); writeFileSync(join(h.dsh, 'profiles/aviary/cordis.patch.yml'), 'mine')
    mkdirSync(join(h.dsh, 'profiles/ruyix'), { recursive: true })
    r = move(h)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(h.home, '.ruyix/workbench/workbench.db'), 'utf8'), 'runs', 'what it lacked moves in')
    assert.equal(readFileSync(join(h.home, '.ruyix/desktop.json'), 'utf8'), '{"wallpaper":"ink"}')
    assert.ok(existsSync(join(h.home, '.ruyix/import.json')) && !existsSync(join(h.home, '.ruyix/workbench/ui-runtime/old')), 'what it has stays')
    const left = readdirSync(h.home).find(n => n.startsWith('.aviary-left-'))
    assert.ok(left && existsSync(join(h.home, left, 'workbench/ui-runtime/old')), 'the rest kept aside')
    assert.equal(readlinkSync(join(h.home, '.aviary')), '.ruyix')
    assert.equal(readFileSync(join(h.dsh, 'profiles/ruyix/cordis.patch.yml'), 'utf8'), 'mine', 'the patch layer taken')
    assert.ok(existsSync(join(h.dsh, 'profiles/aviary.moved')) && !existsSync(join(h.dsh, 'profiles/aviary')))
    assert.doesNotMatch(move(h).stdout, /is Ruyix's now/, 'once only')
    // a link elsewhere (another disk), and an older home beside it
    h = fresh('link')
    const disk = join(tmp, 'disk-agnos'); mkdirSync(disk); writeFileSync(join(disk, 'desktop.json'), '{"wallpaper":"night"}')
    spawnSync('ln', ['-s', disk, join(h.home, '.agnos')]); mkdirSync(join(h.home, '.aviary')); writeFileSync(join(h.home, '.aviary/desktop.json'), 'STALE')
    r = move(h)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readlinkSync(join(h.home, '.ruyix')), disk); assert.equal(readlinkSync(join(h.home, '.agnos')), '.ruyix')
    assert.equal(readFileSync(join(h.home, '.ruyix/desktop.json'), 'utf8'), '{"wallpaper":"night"}')
    assert.equal(readFileSync(join(h.home, '.aviary/desktop.json'), 'utf8'), 'STALE', 'the older one is left alone')
    // the old dsh still running
    h = fresh('running')
    const bin = join(tmp, 'fake/node_modules/@deepseek-ai/dsh'); mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, 'dsh.js'), 'setTimeout(() => {}, 60000)')
    const { spawn } = await import('node:child_process')
    const old = spawn(process.execPath, [join(bin, 'dsh.js'), '--profile', 'agnos'], { stdio: 'ignore' })
    try {
      mkdirSync(join(h.home, '.agnos')); writeFileSync(join(h.home, '.agnos/desktop.json'), '{}')
      for (let i = 0; i < 50; i++) { try { process.kill(old.pid, 0); break } catch { await new Promise(res => setTimeout(res, 20)) } }
      assert.equal(spawnSync('node', [join(here, 'bin/ruyix-process.mjs'), 'remember', 'agnos', String(old.pid), join(h.home, '.agnos/dsh.pid')]).status, 0)
      r = move(h)
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout + r.stderr, /still runs/)
      assert.ok(!existsSync(join(h.home, '.ruyix')) && existsSync(join(h.home, '.agnos/desktop.json')), 'nothing moved under it')
    } finally { old.kill() }
    await new Promise(res => old.once('exit', res))
    assert.match(move(h).stdout, /is Ruyix's now/, 'moved once it stopped')
    // settings written by hand
    h = fresh('hand')
    mkdirSync(join(h.home, '.aviary'))
    writeFileSync(join(h.home, '.aviary/config'), ['export AVIARY_PROFILE="aviary"   # the profile', '  AVIARY_PORT=3400', `AVIARY_LOG=${h.home}/.aviary/dsh#1.log`, 'OTHER=aviary', ''].join('\n'))
    r = move(h)
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /ruyix 3400\n$/)
    assert.equal(readFileSync(join(h.home, '.ruyix/config'), 'utf8'), ['export RUYIX_PROFILE="ruyix"   # the profile', '  RUYIX_PORT=3400', `RUYIX_LOG=${h.home}/.ruyix/dsh#1.log`, 'OTHER=aviary', ''].join('\n'))
  }
  // ruyix desk: it reads, and proposes — never applies (an agent's shell could run it); a wrong value is said first
  {
    const home = join(tmp, 'desk'); mkdirSync(home, { recursive: true })
    const desk = (...a) => spawnSync('node', [join(here, 'bin/ruyix-desk.mjs'), ...a], { env: { ...process.env, RUYIX_HOME: home }, encoding: 'utf8', timeout: 10000 })
    const changes = createChanges({ home }), applyNext = async () => { const [c] = await changes.pending(); await changes.apply(c.id, { digest: (await changes.get(c.id)).digest }); return c } // as the page does: what the person reviewed
    let r = desk('theme', 'hills', '--summary', '换成远山')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /proposed c[a-z0-9]+: 换成远山\n[^]*desktop\.wallpaper: — → "ink"/)
    assert.ok(!existsSync(join(home, 'desktop.json')), 'proposed, not written')
    assert.equal((await applyNext()).by, 'ruyix desk')
    assert.match(desk().stdout, /^theme: hills \(Far hills · 远山\)\n[^]*wallpaper: "ink"/)
    assert.match(desk('themes').stdout, /^\* hills /m)
    assert.equal(desk('set', 'accent=blue', 'scale=1.1').status, 0); await applyNext()
    assert.match(desk().stdout, /with accent changed\n[^]*scale: 1\.1/)
    for (const bad of [['set', 'accent=gold'], ['set', 'accent'], ['theme', 'nope'], ['widget', 'add', 'clock', 'xl'], ['widget', 'remove', 'note']]) {
      r = desk(...bad)
      assert.equal(r.status, 1, `${bad.join(' ')}: ${r.stdout}`)
    }
    assert.equal((await changes.pending()).length, 0, 'nothing proposed for a wrong one')
    assert.equal(desk('widget', 'add', 'note', 'sm').status, 0); await applyNext()
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'desktop.json'), 'utf8')).widgets.map(w => w.type), ['setup', 'clock', 'calendar', 'note'], 'the default set as a list, and the note')
    assert.equal(desk('widget', 'remove', 'note').status, 0); await applyNext()
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'desktop.json'), 'utf8')).widgets.map(w => w.type), ['setup', 'clock', 'calendar'])
    // taking one back: the shell proposes the reverse (the person applies it); it never undoes the person's undo itself
    assert.equal(desk('undo', '--summary', '便签拿掉').status, 0)
    const back = await applyNext()
    assert.match(back.summary, /便签拿掉/)
    const changesCli = (...a) => spawnSync('node', [join(here, 'bin/ruyix-changes.mjs'), ...a], { env: { ...process.env, RUYIX_HOME: home }, encoding: 'utf8', timeout: 10000 })
    let u = changesCli('undo')
    assert.equal(u.status, 1, u.stdout); assert.match(u.stderr, /is an undo/, 'bringing back what was taken away is the person\'s')
    assert.match(desk('keys').stdout, /^theme: null or default, /)
    assert.equal(desk('nonsense').status, 2)
  }
  // the skill: linked where Claude Code, Codex and the shared folder look, through the profile; a folder made by hand stays
  {
    const f = fixture('skills'), skill = join(f.pkg, 'skills/ruyix-desktop')
    mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, 'SKILL.md'), '---\nname: ruyix-desktop\n---\n')
    mkdirSync(join(f.home, '.codex/skills/ruyix-desktop'), { recursive: true })
    const r = run(f, 'link_skills; link_skills')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(readlinkSync(join(f.home, '.claude/skills/ruyix-desktop')), join(f.profile, 'node_modules/@ruyix/shell/skills/ruyix-desktop'))
    assert.ok(lstatSync(join(f.home, '.agents/skills/ruyix-desktop')).isSymbolicLink())
    assert.ok(!lstatSync(join(f.home, '.codex/skills/ruyix-desktop')).isSymbolicLink(), 'the person\'s own folder of that name')
  }
  console.log('ruyix CLI check: ok')
} finally { rmSync(tmp, { recursive: true, force: true }) }
