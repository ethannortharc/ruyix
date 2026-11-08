// Self-check of ruyix config export/import (version 2): a home with every kind of setting and connection goes out as a
// file and its values, comes back into an empty home (the host) and into a box (values from the environment's
// placeholders, files nookbox placed). The app here is made up ("notes"): what an app keeps where comes from its package
// ("ruyix": { "config": … }), passed in as `products`.
import assert from 'node:assert/strict'
import { chmodSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { cloneRepo, createConfigImporter, exportConfig, httpsOf, importConfig, readSecrets, secretsText, setDshCredential } from './bin/ruyix-config.mjs'
import { createConnectors, memoryCredentials } from '@ruyix/connectors/lib/service.js'

const root = mkdtempSync(join(tmpdir(), 'ruyix-config-check-'))
const w = (f, text) => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text) }
const products = { notes: { settingsKey: 'notes', settingsFile: '.ruyix/notes/settings.json', workspace: '~/projects/notes', envFile: '.env', repoSetting: 'site', repoDefault: 'site' } }
const a = join(root, 'a')
// ── a configured home: the app's workspace (plain values, and credentials the connections replaced), its settings,
// Agent Hub, and the connections (the connectors plugin, credentials in memory) ──
const ws = join(a, 'projects/notes')
mkdirSync(join(ws, 'site'), { recursive: true })
for (const [dir, url] of [[ws, 'https://git.example/me/notes.git'], [join(ws, 'site'), 'git@code.example:me/site.git']]) {
  execFileSync('git', ['init', '-q', dir]); execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url])
}
w(join(ws, '.env'), 'SITE_URL=https://site.example/\nLANG_DEFAULT=zh\nGITLAB_TOKEN=glpat-old\nODD_SECRET=s\n')
w(join(a, '.ruyix/notes/settings.json'), JSON.stringify({ site: 'site', perPage: 20, folder: join(a, 'projects/notes/out') }))
w(join(a, '.ruyix/config'), 'RUYIX_PROFILE=ruyix\nRUYIX_PORT=3280          # the port\nRUYIX_TRUSTED_HOST=\n')
{
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  mkdirSync(join(a, '.ruyix/agent-hub'), { recursive: true })
  const db = new DatabaseSync(join(a, '.ruyix/agent-hub/hub.db'))
  db.exec('CREATE TABLE docs (kind TEXT, id TEXT, team_id TEXT, data TEXT, rev INTEGER, updated_at INTEGER)')
  const put = db.prepare('INSERT INTO docs VALUES (?, ?, NULL, ?, 1, 0)')
  put.run('agent', 'opus', JSON.stringify({ id: 'opus', name: 'Claude Opus', runtime: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', access: null, skills: [], notes: '', endpoint: 'gw', browser: false, createdAt: 1 }))
  put.run('agent', 'deepseek', JSON.stringify({ id: 'deepseek', runtime: 'dsh', model: 'deepseek/deepseek-v4', skills: [], createdAt: 2 }))
  put.run('agent', 'gone', JSON.stringify({ id: 'gone', runtime: 'dsh', deleted: true, createdAt: 3 }))
  put.run('config', 'hub', JSON.stringify({ id: 'hub', defaultAgent: 'deepseek', migrated: 1 }))
  db.close()
}
const KUBE = 'apiVersion: v1\nclusters:\n- cluster:\n    server: https://10.0.0.32:6443\n  name: home\nusers: [{name: x, user: {token: sa-token}}]\n'
const connsA = createConnectors({ home: join(a, '.ruyix/connectors'), creds: memoryCredentials() })
await connsA.save({ id: 'forge', type: 'gitlab', baseUrl: 'https://code.example' })
await connsA.setSlot('forge', 'read', 'glpat-read'); await connsA.setSlot('forge', 'write', 'glpat-write')
await connsA.save({ id: 'cluster', type: 'k8s', fields: { namespace: 'apps' } })
await connsA.setSlot('cluster', 'kubeconfig', KUBE)
await connsA.save({ id: 'api', type: 'http', baseUrl: 'https://api.example/v2', hosts: ['files.example'], fields: { auth: 'header', template: 'ApiKey {token}' } })
await connsA.setSlot('api', 'token', 'api-token'); await connsA.setSlot('api', 'password', 'api-pass')

// ── out ──
const { config, secrets, skipped } = await exportConfig({ home: a, connectors: connsA, values: true, products })
assert.deepEqual([config.kind, config.version], ['ruyix-config', 2])
assert.deepEqual(config.workspaces.notes, { path: '~/projects/notes', repo: 'https://git.example/me/notes.git', repos: [{ path: 'site', repo: 'git@code.example:me/site.git' }] })
assert.deepEqual(config.env.notes, { SITE_URL: 'https://site.example/', LANG_DEFAULT: 'zh' }, 'the workspace\'s plain values travel')
assert.deepEqual(skipped, ['notes: GITLAB_TOKEN', 'notes: ODD_SECRET'], 'its credentials do not: they are connections')
assert.equal(config.settings.notes.folder, '~/projects/notes/out', 'a path in the home goes as ~/…')
assert.deepEqual(config.connections.map(c => c.id), ['forge', 'cluster', 'api'])
const byName = Object.fromEntries(config.secrets.map(s => [s.name, s]))
assert.deepEqual(Object.keys(byName), ['CONN_FORGE__READ', 'CONN_FORGE__WRITE', 'CONN_CLUSTER__KUBECONFIG', 'CONN_API__TOKEN', 'CONN_API__PASSWORD'], 'one secret per credential set, nothing guessed')
assert.deepEqual([byName.CONN_FORGE__WRITE.kind, byName.CONN_FORGE__READ.kind, byName.CONN_FORGE__READ.hosts], ['gitlab', 'http', ['code.example']], 'git authenticates with the write token; hosts are the connection\'s')
assert.deepEqual([byName.CONN_API__TOKEN.hosts, byName.CONN_API__PASSWORD.body], [['api.example', 'files.example'], true])
assert.deepEqual(byName.CONN_CLUSTER__KUBECONFIG, { name: 'CONN_CLUSTER__KUBECONFIG', kind: 'file', use: [{ to: 'connection', id: 'cluster', slot: 'kubeconfig', path: '~/.ruyix/connectors/import/cluster.kubeconfig' }] })
assert.deepEqual([config.agents.kind, config.agents.defaultAgent, config.agents.agents.map(x => x.id)], ['dsh-agents', 'deepseek', ['opus', 'deepseek']], 'the agent pool and its default agent')
assert.deepEqual([config.agents.agents[0].endpoint, config.agents.agents[0].browser], ['gw', false], 'endpoint routing and a disabled browser survive config export')
assert.equal(config.ruyix.port, 3280)
assert.ok(!JSON.stringify(config).match(/glpat-|api-token|api-pass|sa-token/), 'no value in the file')
assert.deepEqual([secrets.CONN_FORGE__READ, secrets.CONN_CLUSTER__KUBECONFIG], ['glpat-read', KUBE])
const values = readSecrets(secretsText(secrets))
assert.equal(values.CONN_API__PASSWORD, 'api-pass', 'values survive the secrets file')
assert.match(values.CONN_CLUSTER__KUBECONFIG, /^base64:/, 'a file\'s lines survive it too')
// ruyix not running: the connections file alone, no credentials list
const offline = await exportConfig({ home: a, products })
assert.deepEqual([offline.config.connections.length, offline.config.secrets.length], [3, 0])

// ── into an empty home (the host): clone, settings, plain values; the connections wait for the connectors plugin ──
const b = join(root, 'b'), clones = []
const report = await importConfig(config, values, { home: b, env: {}, products, clone: (url, dir) => { clones.push([url, dir]); mkdirSync(join(dir, '.git'), { recursive: true }); return true } })
assert.deepEqual(JSON.parse(readFileSync(join(b, '.ruyix/agent-hub/import/pool.agents.json'), 'utf8')).agents[0].endpoint, 'gw')
assert.equal(JSON.parse(readFileSync(join(b, '.ruyix/agent-hub/import/pool.agents.json'), 'utf8')).agents[0].browser, false)
assert.deepEqual(clones.map(([u, d]) => [u, d.replace(realpathSync(b), '~')]), [['https://git.example/me/notes.git', '~/projects/notes'], ['git@code.example:me/site.git', '~/projects/notes/site']])
assert.equal(readFileSync(join(b, 'projects/notes/.env'), 'utf8'), 'SITE_URL=https://site.example/\nLANG_DEFAULT=zh\n', 'only plain values land in the .env')
assert.equal(JSON.parse(readFileSync(join(b, '.ruyix/notes/settings.json'), 'utf8')).perPage, 20, 'the app\'s settings')
assert.equal(statSync(join(b, '.ruyix/connectors/import.json')).mode & 0o777, 0o600)
// a checkout or a file of a configuration never lands in Ruyix's own state (directly, through a symlink, or by ..)
{
  const t = mkdtempSync(join(tmpdir(), 'ruyix-config-state-')), cloned = []
  mkdirSync(join(t, '.ruyix'), { recursive: true })
  symlinkSync(join(t, '.ruyix'), join(t, 'innocent'))
  const r = await importConfig({ kind: 'ruyix-config', version: 2, workspaces: { a: { path: '~/.ruyix', repo: 'https://x/a.git' }, b: { path: '~/innocent', repo: 'https://x/b.git' }, c: { path: '~/work/../.ruyix/sub', repo: 'https://x/c.git' } } },
    {}, { home: t, env: {}, products, clone: (url, dir) => { cloned.push(dir); return true } })
  assert.deepEqual(cloned, [], 'no checkout into Ruyix\'s state')
  assert.equal(r.filter(x => !x.ok && /Ruyix's own state/.test(x.text)).length, 3)
  // nor above it (the home itself), nor where a state directory really is (a symlink elsewhere), nor by a path the kernel
  // reads differently from its string (/proc/self/cwd/..)
  const u = mkdtempSync(join(tmpdir(), 'ruyix-config-state2-')), elsewhere = mkdtempSync(join(tmpdir(), 'ruyix-config-moved-')), seen = []
  symlinkSync(elsewhere, join(u, '.ruyix'))
  const cwd = process.cwd()
  process.chdir(u)
  const r2 = await importConfig({ kind: 'ruyix-config', version: 2, workspaces: { home: { path: '~/.', repo: 'https://x/h.git' }, moved: { path: '~/.ruyix', repo: 'https://x/m.git' }, proc: { path: `/proc/self/cwd/../${basename(u)}/.ruyix/sub`, repo: 'https://x/p.git' } } },
    {}, { home: u, env: {}, products, clone: (url, dir) => { seen.push(dir); return true } })
  process.chdir(cwd)
  assert.deepEqual(seen, [])
  assert.equal(r2.filter(x => !x.ok && /Ruyix's own state/.test(x.text)).length, 3)
  // a state directory that is a symlink to nowhere yet is still that state, where it would be; the root is above it all
  const v = mkdtempSync(join(tmpdir(), 'ruyix-config-state3-')), away = join(mkdtempSync(join(tmpdir(), 'ruyix-config-away-')), 'state')
  symlinkSync(away, join(v, '.ruyix'))
  const seen3 = []
  const r3 = await importConfig({ kind: 'ruyix-config', version: 2, workspaces: { a: { path: away, repo: 'https://x/a.git' }, root: { path: '/', repo: 'https://x/r.git' } } }, {}, { home: v, env: {}, products, clone: (url, dir) => { seen3.push(dir); return true } })
  assert.deepEqual(seen3, [])
  assert.equal(r3.filter(x => !x.ok && /Ruyix's own state/.test(x.text)).length, 2)
  // a plain workspace still checks out where it says
  const ok = []
  await importConfig({ kind: 'ruyix-config', version: 2, workspaces: { p: { path: '~/projects/w', repo: 'https://x/p.git' } } }, {}, { home: u, env: {}, products, clone: (url, dir) => { ok.push(dir); return true } })
  assert.deepEqual(ok, [join(realpathSync(u), 'projects/w')])
}
assert.deepEqual(readdirSync(join(b, '.ruyix/agent-hub/import')), ['pool.agents.json'], 'the agents wait for Agent Hub')
assert.ok(report.every(r => r.ok), JSON.stringify(report))
const credsB = memoryCredentials(), connsB = createConnectors({ home: join(b, '.ruyix/connectors'), creds: credsB })
assert.ok((await connsB.takeImport()).every(r => r.ok))
assert.deepEqual(await credsB.get('forge'), { read: 'glpat-read', write: 'glpat-write' })
assert.equal((await credsB.get('cluster')).kubeconfig, KUBE)
assert.equal(connsB.get('api').fields.template, 'ApiKey {token}')

// ── into a box: no secrets file; the environment holds the box's placeholders, nookbox placed the file ──
const c = join(root, 'c')
const env = { NOOKBOX_API: 'http://nookbox.internal', ...Object.fromEntries(Object.keys(secrets).filter(k => !/KUBECONFIG/.test(k)).map(k => [k, `NKB${k}`])) }
w(join(c, '.ruyix/connectors/import/cluster.kubeconfig'), KUBE)
const boxReport = await importConfig(config, {}, { home: c, env, products, clone: (url, dir) => { mkdirSync(join(dir, '.git'), { recursive: true }); return true } })
assert.ok(boxReport.every(r => r.ok), JSON.stringify(boxReport))
const staged = JSON.parse(readFileSync(join(c, '.ruyix/connectors/import.json'), 'utf8'))
assert.deepEqual(staged.values.forge, { read: 'NKBCONN_FORGE__READ', write: 'NKBCONN_FORGE__WRITE' }, 'the box gets placeholders only')
assert.equal(staged.values.cluster.kubeconfig, KUBE, 'the file nookbox placed is taken in…')
assert.ok(!existsSync(join(c, '.ruyix/connectors/import/cluster.kubeconfig')), '… and removed')
if (process.platform !== 'win32') {
  const h = join(root, 'linked-home'), state = join(root, 'linked-state')
  mkdirSync(h)
  w(join(state, 'connectors/import/cluster.kubeconfig'), KUBE)
  symlinkSync(state, join(h, '.ruyix'), 'dir')
  await importConfig({ kind: 'ruyix-config', version: 2, connections: config.connections, secrets: [byName.CONN_CLUSTER__KUBECONFIG] }, {}, { home: h, env: {}, products: {} })
  assert.equal(JSON.parse(readFileSync(join(state, 'connectors/import.json'), 'utf8')).values.cluster.kubeconfig, KUBE, 'a migrated, linked Ruyix home keeps its staged credentials')
  assert.ok(!existsSync(join(state, 'connectors/import/cluster.kubeconfig')))
}

// A shared config cannot take (or delete) an arbitrary file, even through an import-directory link.
{
  const h = join(root, 'untrusted'), key = join(h, '.ssh/id_ed25519')
  w(key, 'private key')
  const cfg = path => ({ kind: 'ruyix-config', version: 2, connections: [{ id: 'c', type: 'http' }], secrets: [{ name: 'X', use: [{ to: 'connection', id: 'c', slot: 's', path }] }] })
  const check = async path => {
    await importConfig(cfg(path), {}, { home: h, env: {}, products })
    assert.equal(readFileSync(key, 'utf8'), 'private key')
    assert.deepEqual(JSON.parse(readFileSync(join(h, '.ruyix/connectors/import.json'), 'utf8')).values, {})
  }
  await check('~/.ssh/id_ed25519')
  mkdirSync(join(h, '.ruyix/connectors/import'), { recursive: true })
  if (process.platform !== 'win32') {
    symlinkSync(key, join(h, '.ruyix/connectors/import/c.s'))
    await check('~/.ruyix/connectors/import/c.s')
  }
}

// A shared configuration's keys cannot reach Object.prototype or name paths.
{
  const h = join(root, 'prototype-home'), before = Object.getOwnPropertyDescriptors(Object.prototype)
  const uses = ['__proto__', 'constructor', '../outside'].map(id => ({ to: 'connection', id, slot: 'ruyixReviewProbe' }))
  uses.push({ to: 'connection', id: 'ok', slot: '__proto__' }, { to: 'connection', id: 'ok', slot: 'read' })
  const report = await importConfig({ kind: 'ruyix-config', version: 2, connections: [{ id: 'ok', type: 'http' }], secrets: [{ name: 'X', use: uses }] }, { X: 'value' }, { home: h, env: {}, products: {} })
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before)
  assert.deepEqual(JSON.parse(readFileSync(join(h, '.ruyix/connectors/import.json'), 'utf8')).values, { ok: { read: 'value' } })
  assert.equal(report.filter(r => !r.ok).length, 4)
}

// only version 2 files
await assert.rejects(importConfig({ kind: 'ruyix-config', version: 1, secrets: [] }, {}, { home: join(root, 'd'), env: {}, products }), /version 1: this Ruyix reads version 2/)

// helpers
assert.equal(httpsOf('git@code.example:me/site.git'), 'https://code.example/me/site.git')
assert.equal(httpsOf('ssh://git@git.example:32222/me/notes.git'), 'https://git.example/me/notes.git')
const cred = join(root, 'cred.yaml')
w(cred, 'version: 1\nrecords:\n  x: 1\n')
setDshCredential(cred, 'K', 'v1'); setDshCredential(cred, 'K', 'v2')
assert.equal((readFileSync(cred, 'utf8').match(/K: /g) || []).length, 1); assert.match(readFileSync(cred, 'utf8'), /^ {2}K: v2$/m)
assert.ok(!existsSync(join(root, 'b/.ruyix/config')), 'import leaves ruyix\'s own settings to ruyix install')
{
  // a folder already there (an .env written before the clone could run): the repository goes into it, the .env stays
  const src = join(root, 'src'), dir = join(root, 'into')
  execFileSync('git', ['init', '-q', src]); writeFileSync(join(src, 'README'), 'hi\n')
  w(join(src, 'nested/file'), 'repository file\n'); w(join(src, 'doc space/记录.md'), 'unicode path\n')
  execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']); execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'])
  w(join(dir, '.env'), 'A=1\n')
  assert.equal(await cloneRepo(src, dir, false), true)
  assert.equal(readFileSync(join(dir, 'README'), 'utf8'), 'hi\n'); assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'A=1\n')
  assert.equal(await cloneRepo(join(root, 'nowhere'), join(root, 'x2'), false), false, 'a failed clone says so')
  const kept = join(root, 'kept'); w(join(kept, 'README'), 'MY LOCAL WORK\n')
  assert.equal(await cloneRepo(src, kept, false), true)
  assert.equal(readFileSync(join(kept, 'README'), 'utf8'), 'MY LOCAL WORK\n', 'import never replaces a local tracked-name file')
  assert.equal(readFileSync(join(kept,'nested/file'),'utf8'),'repository file\n');assert.equal(readFileSync(join(kept,'doc space/记录.md'),'utf8'),'unicode path\n')
  if(process.platform!=='win32'){
    const conflict=join(root,'conflict'),outside=join(root,'outside');mkdirSync(conflict);mkdirSync(outside);symlinkSync(outside,join(conflict,'nested'))
    assert.equal(await cloneRepo(src,conflict,false),false,'a pre-existing parent symlink is refused')
    assert.equal(existsSync(join(outside,'file')),false,'checkout never follows a local parent link')
    assert.equal(existsSync(join(conflict,'.git')),false,'failed checkout leaves no half-attached repository')
    rmSync(join(conflict,'nested'));mkdirSync(join(conflict,'nested'));assert.equal(await cloneRepo(src,conflict,false),true,'retry after fixing the local conflict fills the remaining files')
    assert.equal(readFileSync(join(conflict,'nested/file'),'utf8'),'repository file\n')
  }
  const empty=join(root,'empty-src');execFileSync('git',['init','-q',empty]);assert.equal(await cloneRepo(empty,join(root,'empty-dest'),false),true,'an empty repository is still cloneable')
  const head=execFileSync('git',['-C',src,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
  execFileSync('git',['-C',src,'update-index','--add','--cacheinfo',`160000,${head},vendor/sub`]);execFileSync('git',['-C',src,'-c','user.name=t','-c','user.email=t@t','commit','-qm','gitlink'])
  assert.equal(await cloneRepo(src,join(root,'with-submodule'),false),true,'an uninitialized submodule does not make a clone fail')
}
console.log('ruyix config check: ok')

// Runtime config export follows the launcher's config home, environment defaults, and config-file precedence.
{
  const {fromRunningRuyix}=await import('./bin/ruyix-config.mjs'),home=mkdtempSync(join(tmpdir(),'ruyix-running-config-')),configHome=join(home,'custom'),keys=['RUYIX_HOME','RUYIX_PORT','RUYIX_LOG'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]])),originalFetch=globalThis.fetch
  mkdirSync(configHome);writeFileSync(join(configHome,'dsh-web.log'),'launch token=local-test-token\n')
  process.env.RUYIX_HOME=configHome;delete process.env.RUYIX_PORT;delete process.env.RUYIX_LOG
  const seen=[]
  globalThis.fetch=async url=>{seen.push(String(url));return String(url).includes('/api/')?{ok:true,json:async()=>({config:{version:2}})}:{headers:{getSetCookie:()=>['session=local; HttpOnly']}}}
  try{
    await fromRunningRuyix(false,{home});assert.match(seen[0],/:3280\//)
    process.env.RUYIX_PORT='4321';await fromRunningRuyix(false,{home});assert.match(seen[2],/:4321\//)
    writeFileSync(join(configHome,'config'),'RUYIX_PORT=5432\n');await fromRunningRuyix(false,{home});assert.match(seen[4],/:5432\//)
  }finally{globalThis.fetch=originalFetch;for(const k of keys){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k]}rmSync(home,{recursive:true,force:true})}
}

// A refused workspace cannot be written through the later .env import path, including through an .env symlink.
{
 const home=mkdtempSync(join(tmpdir(),'ruyix-env-boundary-')),state=join(home,'.dsh/profiles/ruyix'),workspace=join(home,'work')
 mkdirSync(state,{recursive:true});mkdirSync(workspace);writeFileSync(join(state,'.env'),'KEEP=1\n')
 const products={notes:{workspace:'~/work',envFile:'.env'}},config={kind:'ruyix-config',version:2,workspaces:{notes:{path:'~/.dsh/profiles/ruyix'}},env:{notes:{IMPORTED:'yes'}}}
 try{
   let report=await importConfig(config,{},{home,env:{},products});assert.ok(report.some(r=>!r.ok&&r.text.includes('.env')));assert.equal(readFileSync(join(state,'.env'),'utf8'),'KEEP=1\n')
   symlinkSync(join(state,'.env'),join(workspace,'.env'));report=await importConfig({...config,workspaces:{notes:{path:'~/work'}}},{},{home,env:{},products});assert.ok(report.some(r=>!r.ok&&r.text.includes('.env')));assert.equal(readFileSync(join(state,'.env'),'utf8'),'KEEP=1\n')
 }finally{rmSync(home,{recursive:true,force:true})}
}

// Export and import honor the same custom hub home as the running Agent Hub.
{
  const hubHome = join(root, 'custom-hub'), destination = join(root, 'custom-destination')
  mkdirSync(hubHome, { recursive: true })
  const { copyFileSync } = await import('node:fs')
  copyFileSync(join(a, '.ruyix/agent-hub/hub.db'), join(hubHome, 'hub.db'))
  writeFileSync(join(hubHome, 'skill-packs.json'), JSON.stringify({ git: { custom: { id: 'custom', git: 'https://example.test/skills', ref: 'main', path: 'skills', sha: null } }, policy: { local: true } }))
  const exported = await exportConfig({ home: a, env: { DSH_AGENT_HUB_HOME: hubHome }, products: {} })
  assert.deepEqual(exported.config.agents.agents.map(a => a.id), ['opus', 'deepseek'])
  assert.equal(exported.config.agents.defaultAgent, 'deepseek')
  assert.equal(exported.config.settings['agent-hub'].skillPacks.policy.local, true)
  await importConfig(exported.config, {}, { home: join(root, 'other-home'), env: { DSH_AGENT_HUB_HOME: destination }, products: {} })
  assert.deepEqual(JSON.parse(readFileSync(join(destination, 'import/pool.agents.json'), 'utf8')), JSON.parse(JSON.stringify(exported.config.agents)))
  assert.deepEqual(JSON.parse(readFileSync(join(destination, 'import/skill-packs.json'), 'utf8')), exported.config.settings['agent-hub'].skillPacks)
}

// A live import owns staging before writes, including the consumers' startup imports.
{
  const home = mkdtempSync(join(tmpdir(), 'ruyix-live-import-')), creds = memoryCredentials(), connections = createConnectors({ home: join(home, '.ruyix/connectors'), creds })
  const staged = join(home, '.ruyix/connectors/import.json'); let release, first = true, writes = 0
  const part = { imported: async () => { if (first) { first = false; await new Promise(r => { release = r }) } } }
  const apply = createConfigImporter({ parts: () => [part], connectors: () => connections, apply: (config, secrets) => { writes++; return importConfig(config, secrets, { home, env: {}, products: {} }) } })
  const config = id => ({ kind: 'ruyix-config', version: 2, connections: [{ id, type: 'http', baseUrl: `https://${id}.invalid` }], secrets: [{ name: 'TOKEN', kind: 'http', use: [{ to: 'connection', id, slot: 'token' }] }] })
  try {
    const a = apply(config('a'), { TOKEN: 'TOKEN_A' })
    while (!release) await new Promise(r => setTimeout(r, 0))
    await assert.rejects(apply(config('b'), { TOKEN: 'TOKEN_B' }), e => e.code === 'importBusy')
    assert.equal(writes, 1); assert.equal(JSON.parse(readFileSync(staged, 'utf8')).connections[0].id, 'a')
    release(); await a; await apply(config('b'), { TOKEN: 'TOKEN_B' })
    assert.equal(connections.has('a'), true); assert.equal(connections.has('b'), true)
    assert.equal((await creds.get('b')).token, 'TOKEN_B'); assert.equal(writes, 2)
    const set = creds.set; let finish
    creds.set = async (id, key, value) => { if (id === 'startup') await new Promise(r => { finish = r }); return set(id, key, value) }
    writeFileSync(staged, JSON.stringify({ connections: [{ id: 'startup', type: 'http', baseUrl: 'https://startup.invalid' }], values: { startup: { token: 'TOKEN_STARTUP' } } }))
    const startup = connections.takeImport(); while (!finish) await new Promise(r => setTimeout(r, 0))
    assert.equal(connections.importing(), true); assert.equal(connections.takeImport(), startup, 'one consumer owns the staged file')
    await assert.rejects(apply(config('c'), { TOKEN: 'TOKEN_C' }), e => e.code === 'importBusy'); assert.equal(writes, 2, 'startup consumer blocks staging writes too')
    writeFileSync(staged, JSON.stringify({ connections: [{ id: 'later', type: 'http', baseUrl: 'https://later.invalid' }], values: { later: { token: 'TOKEN_LATER' } } }))
    finish(); await startup; assert.equal(connections.importing(), false)
    assert.equal(JSON.parse(readFileSync(staged, 'utf8')).connections[0].id, 'later', 'a CLI import staged during consumption is kept for the next start')
    await connections.takeImport(); assert.equal(connections.has('later'), true); assert.equal((await creds.get('later')).token, 'TOKEN_LATER')
    const agentStartup = createConfigImporter({ parts: () => [{ importing: () => true }], apply: () => assert.fail('must not write during an agent import') })
    await assert.rejects(agentStartup({}), e => e.code === 'importBusy')
    let failed = true
    const retry = createConfigImporter({ apply: () => { if (failed) { failed = false; throw Error('fixture refusal') } return [] } })
    await assert.rejects(retry({}), /fixture refusal/); assert.deepEqual(await retry({}), [], 'failed imports release admission')
    const hooks = createConfigImporter({ apply: () => [], parts: () => [{ id: 'broken', imported: () => { throw Error('hook failed') } }, { imported: () => [{ ok: false, text: 'received refusal' }, { unrelated: true }] }] })
    assert.deepEqual(await hooks({}), [{ ok: false, text: 'broken import: hook failed' }, { ok: false, text: 'received refusal' }])
  } finally { release?.(); rmSync(home, { recursive: true, force: true }) }
}

// A slow real Git child must not block live HTTP, session or schedule timers.
if(process.platform!=='win32'){
 const home=mkdtempSync(join(tmpdir(),'ruyix-import-loop-')),bin=join(home,'bin'),before=process.env.PATH
 mkdirSync(bin);writeFileSync(join(bin,'git'),'#!/bin/sh\nsleep 0.2\nexit 1\n');chmodSync(join(bin,'git'),0o755);process.env.PATH=bin+':'+before
 let fired=false;const timer=setTimeout(()=>{fired=true},0)
 try{const apply=createConfigImporter({apply:(c,s)=>importConfig(c,s,{home,env:{},products:{}})});const report=await apply({kind:'ruyix-config',version:2,workspaces:{fixture:{path:'~/work',repo:'https://unused.invalid/r.git'}}});assert.equal(fired,true,'timers run while Git is pending');assert.equal(report[0].ok,false)}finally{clearTimeout(timer);process.env.PATH=before;rmSync(home,{recursive:true,force:true})}
}
