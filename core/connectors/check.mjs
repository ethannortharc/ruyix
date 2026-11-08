// Self-check of the connectors: against a fake service on loopback — the credential header each type sends, the hosts a
// connection may reach, values taken out of what comes back, the write token only for writes, the tests — and the
// store: adopt never overwrites, an import lands, file slots are private files, the audit holds no value.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { rmSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectors, dshCredentials, memoryCredentials } from './lib/service.js'
import { scrubbedEnv } from './lib/run.js'
import { TYPES, pan123Type, xType } from './lib/types.js'
import { en, zh } from './src/locale.js'
import { apply } from './index.js'

const seen = []
const server = createServer((req, res) => {
  seen.push({ url: req.url, method: req.method, headers: req.headers })
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.url === '/api/v4/personal_access_tokens/self') {
    const t = req.headers['private-token']
    return t === 'glpat-read-1234567' ? send(200, { scopes: ['read_api'], expires_at: '2099-01-01' }) : t === 'glpat-write-7654321' ? send(200, { scopes: ['api'], expires_at: '2099-01-01' }) : send(401, {})
  }
  if (req.url === '/api/v4/user') return send(200, { username: 'jane.doe' })
  if (req.url === '/echo') return send(200, { got: req.headers['private-token'] || req.headers.authorization || '' })
  if (req.url === '/upload') { // a multipart upload answered with bytes (an audio file's shape)
    const chunks = []
    req.on('data', c => chunks.push(c)).on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1')
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(`${req.headers['content-type'].split(';')[0]}|${raw.includes('name="file"') && raw.includes('RIFFdata')}`)]))
    })
    return
  }
  if (req.url.startsWith('/v2/server')) return req.headers.authorization === 'ApiKey lab-token-123456' ? send(200, []) : send(401, {})
  send(404, {})
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
// a fake OAuth 2.0 server (X's shape): the token endpoint (code and refresh token), and an API that wants the current access token
const oa = { access: 'acc-0-aaaaaa', refresh: 'ref-0-aaaaaa', n: 0, tokenCalls: [], apiAuth: [], challenge: '', fail: false, busy: false, noRefresh: false, apiDown: false }
const oauthServer = createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.url === '/oauth2/token') {
    const p = Object.fromEntries(new URLSearchParams(raw))
    oa.tokenCalls.push({ headers: req.headers, params: p })
    await new Promise(r => setTimeout(r, 40)) // requests that come together overlap
    if (oa.fail) return send(400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' })
    if (oa.busy) return send(503, { error: 'temporarily_unavailable' })
    if (p.grant_type === 'authorization_code') {
      if (p.code !== 'code-good' || createHash('sha256').update(p.code_verifier).digest('base64url') !== oa.challenge) return send(400, { error: 'invalid_grant', error_description: 'bad code or verifier' })
    } else if (p.grant_type === 'refresh_token') {
      if (p.refresh_token !== oa.refresh) return send(400, { error: 'invalid_grant', error_description: 'refresh token spent' })
    } else return send(400, { error: 'unsupported_grant_type' })
    oa.n++
    oa.access = `acc-${oa.n}-aaaaaa`
    if (!oa.noRefresh) oa.refresh = `ref-${oa.n}-aaaaaa`
    return send(200, { token_type: 'bearer', access_token: oa.access, ...(!oa.noRefresh && { refresh_token: oa.refresh }), expires_in: 7200, scope: 'tweet.read' })
  }
  if (req.url === '/2/users/me') {
    oa.apiAuth.push(req.headers.authorization)
    return !oa.apiDown && req.headers.authorization === `Bearer ${oa.access}` ? send(200, { data: { id: '1', username: 'ethan_x' } }) : send(401, { title: 'Unauthorized' })
  }
  send(404, {})
})
await new Promise(r => oauthServer.listen(0, '127.0.0.1', r))
const ob = `http://127.0.0.1:${oauthServer.address().port}`
const home = mkdtempSync(join(tmpdir(), 'connectors-check-'))
const creds = memoryCredentials()
const fakeBridge = join(home, 'bridge.py') // a type that ships its own program (the command mechanism), here a tiny script
writeFileSync(fakeBridge, 'import json, os, sys\nprint(json.dumps({"args": sys.argv[1:], "url": os.environ.get("FAKE_BASE_URL"), "cookie": os.environ.get("FAKE_COOKIE"), "write": os.environ.get("FAKE_ALLOW_WRITE", ""), "user": os.environ.get("FAKE_USERNAME"), "leak": os.environ.get("SOME_TOKEN", "")}))\n')
process.env.SOME_TOKEN = 'inherited-secret' // a secret in the parent's environment never reaches a command
const c = createConnectors({ home, creds })
await c.save({ id: 'default-x', type: 'x', baseUrl: '  ', fields: { clientId: 'cid' } })
assert.equal(c.get('default-x').baseUrl, 'https://api.x.com/2', 'blank URLs on the missing-need path use the type default')
await c.save({ id: 'default-x', type: 'x', baseUrl: 'https://custom.invalid/api' })
await c.save({ id: 'default-x', type: 'x', name: 'Keep URL' }); assert.equal(c.get('default-x').baseUrl, 'https://custom.invalid/api')
await c.save({ id: 'default-x', type: 'x', baseUrl: '' }); assert.equal(c.get('default-x').baseUrl, 'https://api.x.com/2', 'explicitly blank restores the type default, not a previous host')
await assert.rejects(c.save({id:'empty-http',type:'http',baseUrl:''}),e=>e.code==='needUrl')
await assert.rejects(c.save({id:'invalid-x',type:'x',baseUrl:'/'}),e=>e.code==='badUrl')
await c.remove('default-x')

// Older missing-need saves had blank URLs; built-ins and later registered adapters restore their defaults on load.
{
 const legacyHome=mkdtempSync(join(tmpdir(),'connectors-legacy-url-')),requests=[]
 try{
  writeFileSync(join(legacyHome,'connections.json'),JSON.stringify({version:1,connections:[{id:'legacy-x',type:'x',baseUrl:'',fields:{clientId:'cid'}},{id:'custom-x',type:'x',baseUrl:'https://own.invalid/v1',fields:{clientId:'cid'}},{id:'later',type:'plugin-fixture',baseUrl:'  ',fields:{}}]}))
  const legacy=createConnectors({home:legacyHome,creds:memoryCredentials(),fetch:async url=>{requests.push(String(url));return new Response('{}')}})
  assert.equal(legacy.get('legacy-x').baseUrl,'https://api.x.com/2');assert.equal(legacy.get('custom-x').baseUrl,'https://own.invalid/v1')
  legacy.registerType('plugin-fixture',{label:{en:'Fixture'},fields:[],slots:[],baseUrl:{default:'https://plugin.invalid/api'}})
  assert.equal(legacy.get('later').baseUrl,'https://plugin.invalid/api');await legacy.client('later').request('probe');assert.equal(requests[0],'https://plugin.invalid/api/probe')
  legacy.reload();assert.equal(legacy.get('legacy-x').baseUrl,'https://api.x.com/2');assert.equal(legacy.get('later').baseUrl,'https://plugin.invalid/api')
 }finally{rmSync(legacyHome,{recursive:true,force:true})}
}

// an adapter's type: registered as any plugin's would be
const L = (en, zh) => ({ en, zh })
const fakeType = {
  label: L('Fake', 'Fake'), blurb: L('A site with a session', '有会话的站点'), baseUrl: { required: true, example: 'https://site.example' },
  fields: [{ name: 'username', label: L('User', '用户') }],
  slots: [{ name: 'cookie', label: L('Session', '会话'), level: 'read', required: true, signin: true }],
  headers: cookie => ({ cookie }),
  signin: { ready: (url, cookies) => !/login/.test(url) && cookies.length > 0, keep: cookies => ({ slots: { cookie: cookies.map(k => `${k.name}=${k.value}`).join('; ') }, fields: {} }) },
  command: { cmd: 'python3', args: [fakeBridge], env: {} },
  async test(api) { const r = await api.command(['ping']); return { ok: true, detail: r.user || api.conn.fields.username || '' } },
  env: (conn, s, { write } = {}) => ({ FAKE_BASE_URL: conn.baseUrl, FAKE_COOKIE: s.cookie || '', FAKE_USERNAME: conn.fields.username || '', ...(write && { FAKE_ALLOW_WRITE: '1' }) }),
}
c.registerType('fake', fakeType)
assert.throws(() => c.registerType('fake', { ...fakeType }), err => err.code === 'typeTaken')
assert.throws(() => c.registerType('Bad', fakeType), err => err.code === 'badType')

try {
  // a connection: fields only; the id is a slug; the type stays
  await assert.rejects(c.save({ id: 'Bad Id', type: 'gitlab', baseUrl: base }), /lowercase/)
  await assert.rejects(c.save({ id: 'gl', type: 'gitlab' }), /needs its address/)
  await c.save({ id: 'gl', type: 'gitlab', name: 'Test GitLab', baseUrl: `${base}/` })
  await assert.rejects(c.save({ id: 'gl', type: 'http', baseUrl: base }), /remove it/)
  assert.equal(c.get('gl').baseUrl, base, 'the trailing slash is dropped')

  // reads go out with the read token, writes with the write token, and a write without one is refused
  await c.setSlot('gl', 'read', 'glpat-read-1234567')
  const gl = c.client('gl', { by: 'check' })
  const r1 = await gl.request('/echo')
  assert.equal(seen.at(-1).headers['private-token'], 'glpat-read-1234567')
  assert.equal((await r1.json()).got, '«secret»', 'a credential coming back is taken out')
  await assert.rejects(gl.request('/echo', { method: 'POST', level: 'write' }), err => err.code === 'noWrite')
  await c.setSlot('gl', 'write', 'glpat-write-7654321')
  await gl.request('/echo', { method: 'POST', level: 'write', body: {} })
  assert.equal(seen.at(-1).headers['private-token'], 'glpat-write-7654321')
  // a form goes as multipart (not JSON), and bytes come back as they are
  const form = new FormData()
  form.set('file', new Blob([Buffer.from('RIFFdata')], { type: 'audio/wav' }), 'a.wav')
  form.set('model', 'm')
  const up = await gl.request('/upload', { method: 'POST', body: form })
  const got = await up.bytes()
  assert.deepEqual([...got.subarray(0, 4)], [0, 1, 2, 255], 'the bytes as sent')
  assert.equal(got.subarray(4).toString(), 'multipart/form-data|true', 'the form went as multipart')
  // only the connection's hosts
  await assert.rejects(gl.request('https://evil.example/x'), err => err.code === 'badHost')
  // the test: scopes, expiry, user
  const st = await c.test('gl')
  assert.ok(st.ok && /@jane\.doe/.test(st.detail) && /api/.test(st.detail), st.detail)
  await c.setSlot('gl', 'write', 'glpat-read-1234567') // a read_api token where the write token goes
  assert.match((await c.test('gl')).detail, /needs the "api" scope/)
  await c.setSlot('gl', 'write', 'glpat-write-7654321')

  // the list shows whether each credential is set and its last four characters — never the value
  const listed = (await c.list()).find(x => x.id === 'gl')
  assert.ok(!JSON.stringify(listed).includes('glpat-read-1234567'))
  assert.deepEqual(listed.slots.map(s => [s.name, s.set, s.tail]), [['read', true, '4567'], ['write', true, '4321']])

  // an http API with its own header ("ApiKey <token>") and its test path
  await c.save({ id: 'lab-api', type: 'http', baseUrl: `${base}/v2`, fields: { auth: 'header', header: 'authorization', template: 'ApiKey {token}', testPath: 'server?limit=1' } })
  await c.setSlot('lab-api', 'token', 'lab-token-123456')
  await c.setSlot('lab-api', 'user', 'labuser')
  assert.ok((await c.test('lab-api')).ok)
  assert.equal(seen.at(-1).url, '/v2/server?limit=1', 'a relative path goes under the address')
  assert.equal((await c.list()).find(x => x.id === 'lab-api').slots.find(s => s.name === 'user').value, 'labuser', 'a plain slot (a user name) is shown')
  // basic auth from user + password
  await c.save({ id: 'jenkins', type: 'http', baseUrl: base, fields: { auth: 'basic' } })
  await c.setSlot('jenkins', 'user', 'jd')
  await c.setSlot('jenkins', 'password', 'pw-123456')
  await c.client('jenkins').request('/echo')
  assert.equal(seen.at(-1).headers.authorization, `Basic ${Buffer.from('jd:pw-123456').toString('base64')}`)

  // values: one line (a file slot keeps its lines); a kubeconfig names the cluster and is kept as a private file
  await assert.rejects(c.setSlot('gl', 'read', 'a\nb'), err => err.code === 'oneLine')
  await c.save({ id: 'lab-k8s', type: 'k8s', fields: { namespace: 'apps' } })
  await c.setSlot('lab-k8s', 'kubeconfig', 'apiVersion: v1\nclusters:\n- cluster:\n    server: https://10.0.0.1:6443\n  name: lab\n')
  assert.equal(c.get('lab-k8s').baseUrl, 'https://10.0.0.1:6443')
  const kc = await c.file('lab-k8s', 'kubeconfig')
  if (process.platform !== 'win32') assert.equal(statSync(kc).mode & 0o777, 0o600) // Windows has no such bits (the profile's ACL keeps it the user's)
  assert.match(readFileSync(kc, 'utf8'), /server: https:\/\/10\.0\.0\.1:6443/)
  assert.equal((await c.env('lab-k8s')).KUBECONFIG, kc)

  // an adapter's command: the session goes to the program in its variables, writing only when asked; inherited secrets never do
  await c.save({ id: 'site', type: 'fake', baseUrl: 'https://site.example' })
  await assert.rejects(c.command('site', ['ping']), err => err.code === 'notSet')
  await assert.rejects(c.command('gl', ['x']), err => err.code === 'noCommand')
  await c.setSlot('site', 'cookie', 'PHPSESSID=abc123456')
  await c.setFields('site', { username: 'jane.doe', unknown: 'x' })
  const ping = await c.command('site', ['issue', 1900001])
  assert.deepEqual([ping.args, ping.url, ping.cookie, ping.write, ping.user, ping.leak], [['issue', '1900001'], 'https://site.example', 'PHPSESSID=abc123456', '', 'jane.doe', ''])
  assert.equal((await c.command('site', ['note', 1], { write: true })).write, '1')
  assert.equal((await c.test('site')).ok, true, 'the adapter\'s test runs its command')
  assert.ok(!('unknown' in c.get('site').fields), 'only the type\'s fields are kept')
  {
    // its adapter gone (the plugin off): the connection still lists, marked, and nothing else breaks
    const noAdapter = createConnectors({ home, creds })
    const unloaded = (await noAdapter.list()).find(x => x.id === 'site')
    assert.deepEqual([unloaded.unknownType, unloaded.status.ok, (await noAdapter.list()).some(x => x.id === 'gl' && !x.unknownType)], [true, false, true])
    assert.ok(!(await noAdapter.exportData()).connections.some(x => x.id === 'site'), 'its credentials are its adapter\'s to say: not exported')
  }
  // the browser sign-in of an http connection (auth "cookie"): the page to open, the cookies kept as the token, confirmed by the person
  {
    await c.save({ id: 'web', type: 'http', baseUrl: 'https://www.example.com', fields: { auth: 'cookie', signinUrl: 'https://www.example.com/login' } })
    const found = c.signinOf('web')
    assert.equal(found.url, 'https://www.example.com/login')
    assert.equal(found.site.manual, true)
    assert.equal(found.site.ready('https://www.example.com/home', [{ name: 'a' }], 'https://www.example.com'), false, 'nothing tells a session is there: the person says so')
    assert.deepEqual(found.site.keep([{ name: 'a', value: '1' }, { name: 'sid', value: '2' }]), { slots: { token: 'a=1; sid=2' }, fields: {} })
    assert.equal(c.get('web').signin, 'token')
    await c.save({ id: 'web2', type: 'http', baseUrl: 'https://www.example.com' })
    assert.equal(c.signinOf('web2'), null, 'only with authentication "cookie"')
    assert.equal(c.signinOf('gl'), null)
    await c.setSlot('web', 'token', 'a=1; sid=2345678')
    const shown = (await c.list()).find(x => x.id === 'web')
    assert.deepEqual([shown.signin, shown.slots.find(s => s.name === 'token').tail], ['token', undefined], 'a session shows no tail')
    const exported = (await c.exportData()).secrets.find(x => x.name === 'CONN_WEB__TOKEN')
    assert.equal(exported.kind, 'cookie', 'a session goes to a box as a cookie')
    await c.remove('web'); await c.remove('web2')
  }

  // adopt: made when missing, empty credentials filled — never what a person set
  assert.deepEqual(await c.adopt({ id: 'gl', type: 'gitlab', baseUrl: base }, { read: 'glpat-other-0000000', write: '' }), { created: false, filled: [] })
  assert.equal(seen.length && (await creds.get('gl')).read, 'glpat-read-1234567')
  assert.deepEqual(await c.adopt({ id: 'api', type: 'http', baseUrl: base }, { token: 'api-token-123456' }), { created: true, filled: ['token'] })

  // who needs what
  const off = c.require('Product', () => [
    { need: 'gitlab', type: 'gitlab', connection: 'gl', label: { en: 'GitLab' } },
    { need: 'tracker', type: 'fake', connection: 'nope' },
    { need: 'errors', type: 'fake', connection: 'api' },
  ])
  assert.deepEqual(c.needs().map(n => n.state), ['untested', 'missing', 'wrongType'], 'a credential changed: not tested since')
  await c.test('gl')
  assert.equal(c.needs()[0].state, 'ok')
  assert.equal((await c.list()).find(x => x.id === 'gl').usedBy[0].owner, 'Product')
  // what needs a person (the inbox's System tab): the needs no connection meets; a used one that fails is broken now
  assert.deepEqual(c.attention().filter(x => x.kind !== 'failed' || x.id === 'gl').map(x => [x.kind, x.tone]), [['missing', 'now'], ['wrongType', 'now']])
  const glStatus = c.status('gl')
  Object.assign(glStatus, { ok: false, detail: '401 Unauthorized' })
  assert.deepEqual(c.attention().find(x => x.id === 'gl' && x.kind === 'failed')?.usedBy, [{ owner: 'Product', label: { en: 'GitLab' } }])
  Object.assign(glStatus, { ok: true, expiresIn: 2 })
  assert.deepEqual(c.attention().filter(x => x.id === 'gl').map(x => [x.kind, x.tone, x.days]), [['expiring', 'soon', 2]], 'a token running out within three days')
  off()
  assert.equal(c.needs().length, 0)

  // an import left for the next start: connections and values, then the file is gone
  writeFileSync(join(home, 'import.json'), JSON.stringify({ connections: [{ id: 'imp', type: 'http', baseUrl: base }], values: { imp: { token: 'tok_123456' } } }))
  assert.deepEqual(await c.takeImport(), [{ id: 'imp', ok: true }])
  assert.ok(!existsSync(join(home, 'import.json')))
  assert.equal((await creds.get('imp')).token, 'tok_123456')

  // A transient credential write failure keeps only the failed connection staged for the next attempt.
  {
    const pendingHome = mkdtempSync(join(tmpdir(), 'connectors-import-')), ownCreds = memoryCredentials()
    let failOnce = true
    const ownSet = ownCreds.set
    ownCreds.set = async (id, ...args) => { if (id === 'retry' && failOnce) { failOnce = false; throw new Error('temporary vault failure') } return ownSet(id, ...args) }
    const imported = createConnectors({ home: pendingHome, creds: ownCreds })
    const file = join(pendingHome, 'import.json')
    writeFileSync(file, JSON.stringify({ connections: [{ id: 'good', type: 'http', baseUrl: base }, { id: 'retry', type: 'http', baseUrl: base }], values: { good: { token: 'good-secret' }, retry: { token: 'retry-secret' } } }))
    const report = await imported.takeImport()
    assert.deepEqual(report.map(r => r.ok), [true, false])
    const active = join(pendingHome, 'import.active.json')
    assert.deepEqual(JSON.parse(readFileSync(active)).connections.map(c => c.id), ['retry'])
    assert.equal(statSync(active).mode & 0o777, 0o600)
    const restarted = createConnectors({ home: pendingHome, creds: ownCreds })
    assert.deepEqual(await restarted.takeImport(), [{ id: 'retry', ok: true }]); assert.ok(!existsSync(file) && !existsSync(active))
    assert.equal((await ownCreds.get('retry')).token, 'retry-secret')
  }
  // removing a connection drops its credentials and its files
  await c.remove('lab-k8s')
  assert.ok(!existsSync(kc))
  assert.deepEqual(await creds.get('lab-k8s'), {})

  // the audit: what was called, never a value
  const audit = readFileSync(join(home, 'audit.jsonl'), 'utf8')
  assert.ok(audit.includes('"path":"/echo"') && audit.includes('"by":"check"'))
  for (const v of ['glpat-read-1234567', 'glpat-write-7654321', 'lab-token-123456', 'PHPSESSID=abc123456', 'pw-123456']) assert.ok(!audit.includes(v), `audit holds ${v}`)
  assert.ok(c.audit('gl', 5).length > 0)

  // a command's environment: the inherited secrets dropped
  assert.deepEqual(Object.keys(scrubbedEnv({ PATH: '/bin', GITLAB_TOKEN: 'x', MY_API_KEY: 'y', DSH_HOME: 'z', HOME: '/h' })).sort(), ['HOME', 'PATH'])

  // over dsh's credential store: one record per connection; a reference slot (a dsh credential name)
  const records = new Map(), refs = new Map()
  const dsh = dshCredentials({
    readRecord: async k => records.get(k), modifyRecord: async (k, fn) => { const next = await fn(records.get(k)); if (next) records.set(k, next) },
    deleteRecord: async k => { records.delete(k) }, resolve: async r => (refs.has(r) ? { value: refs.get(r) } : undefined), set: async (r, v) => { refs.set(r, v) }, unset: async r => { refs.delete(r) },
  })
  await dsh.set('gl', 'read', 'a1'); await dsh.set('gl', 'write', 'b2')
  assert.deepEqual(records.get('connectors/gl'), { kind: 'grant', payload: { slots: { read: 'a1', write: 'b2' } } })
  await dsh.clear('gl', 'read')
  assert.deepEqual(await dsh.get('gl'), { write: 'b2' })
  await dsh.clear('gl', 'write')
  assert.ok(!records.has('connectors/gl'), 'an empty record goes')
  {
    // a slot that is a reference stays a dsh credential the model provider (or anything else) reads by name
    const rc = createConnectors({ home: mkdtempSync(join(tmpdir(), 'connectors-ref-')), creds: dsh, types: { keyed: { label: L('Keyed', 'Keyed'), blurb: L('', ''), baseUrl: { required: false, default: 'https://api.example.com' }, fields: [], slots: [{ name: 'key', label: L('API key', 'API key'), level: 'read', required: true, ref: 'EXAMPLE_API_KEY' }] } } })
    await rc.save({ id: 'keyed', type: 'keyed' })
    await rc.setSlot('keyed', 'key', 'ref-key-123456')
    assert.equal(refs.get('EXAMPLE_API_KEY'), 'ref-key-123456', 'the key stays the reference dsh reads')
  }

  // the plugin: the service, the page's ops, the setup step
  let provided = null, route = null
  apply({ provide: (n, v) => { if (n === 'connectors') provided = v }, connection: { fetch: { register: r => { route = r } } }, effect: () => {}, inject: () => {}, on: () => {} }, {}, { home, creds })
  assert.ok(provided?.client && route?.path === '/api/connectors')
  const post = async body => (await route.fetch(new Request('http://x/api/connectors', { method: 'POST', body: JSON.stringify(body) }))).json()
  assert.ok((await post({ op: 'list' })).connections.some(x => x.id === 'gl'))
  assert.equal((await post({ op: 'setSlot', id: 'gl', slot: 'read', value: ' ' })).code, 'emptyValue')
  provided.require('Product', () => [{ need: 'gitlab', type: 'gitlab', connection: 'missing-one', label: { en: 'GitLab', zh: 'GitLab' } }])
  const [step] = provided.setup()
  assert.equal(step.ready, false)
  assert.match(step.detail.en, /GitLab \(not added\)/)

  // in a nookbox box: a header or cookie value goes to the host's vault and the box keeps the placeholder; a file, a
  // user name, a basic-auth password stay; an imported placeholder is not sent again; a cleared one goes from the vault
  {
    const put = [], gone = []
    const fakeVault = { put: async (name, b) => { put.push({ name, ...b }); return { placeholder: `glpat-NKB${'a'.repeat(32)}`, hosts: b.hosts } }, remove: async name => { gone.push(name) } }
    const bx = createConnectors({ home: mkdtempSync(join(tmpdir(), 'connectors-box-')), creds: memoryCredentials(), vault: fakeVault })
    await bx.save({ id: 'gl', type: 'gitlab', baseUrl: 'https://gitlab.example.com' })
    await bx.setSlot('gl', 'read', 'glpat-real-0123456')
    assert.deepEqual(put[0], { name: 'CONN_GL__READ', value: 'glpat-real-0123456', hosts: ['gitlab.example.com'], body: false })
    const glSlot = (await bx.list())[0].slots.find(x => x.name === 'read')
    assert.deepEqual([glSlot.set, glSlot.vault, glSlot.tail], [true, true, undefined], 'shown as in the vault, no tail')
    assert.equal((await bx.env('gl')).GITLAB_TOKEN, `glpat-NKB${'a'.repeat(32)}`, 'a command gets the placeholder')
    await bx.setSlot('gl', 'write', `glpat-NKB${'b'.repeat(32)}`)
    assert.equal(put.length, 1, 'a placeholder (from an import) is kept as it is')
    await bx.save({ id: 'lab', type: 'k8s', fields: { namespace: 'x' } })
    await bx.setSlot('lab', 'kubeconfig', 'apiVersion: v1\nclusters: []\n')
    await bx.save({ id: 'api', type: 'http', baseUrl: 'https://api.example.com', fields: { auth: 'basic' } })
    await bx.setSlot('api', 'user', 'jane'); await bx.setSlot('api', 'password', 'hunter22-long')
    assert.equal(put.length, 1, 'files, user names and basic-auth passwords stay in the box')
    await bx.clearSlot('gl', 'read')
    assert.deepEqual(gone, ['CONN_GL__READ'])
    assert.ok(bx.inBox && !c.inBox)
  }

  // X: OAuth 2.0 (authorization code + PKCE) against the fake server; the same type with its endpoints pointed there
  {
    let clock = Date.now()
    const xhome = mkdtempSync(join(tmpdir(), 'connectors-x-'))
    const xcreds = memoryCredentials()
    const xc = createConnectors({ home: xhome, creds: xcreds, now: () => clock })
    xc.registerType('xfake', xType({ authorize: `${ob}/authorize`, token: `${ob}/oauth2/token`, api: `${ob}/2` }))
    assert.ok(xc.type('x'), 'the built-in type')
    assert.equal(TYPES.x.baseUrl.default, 'https://api.x.com/2')
    assert.deepEqual(TYPES.x.hosts, ['api.x.com'])
    await assert.rejects(xc.save({ id: 'xx', type: 'xfake' }), err => err.code === 'needField' && err.params.field === 'clientId')
    await xc.save({ id: 'xx', type: 'xfake', fields: { clientId: 'client-id-1' } })
    assert.equal(xc.get('xx').baseUrl, `${ob}/2`, 'the address defaults to the type\'s')
    assert.equal(xc.get('xx').fields.redirectUri, 'http://127.0.0.1:4310/api/oauth/x/callback')
    assert.equal(xc.get('xx').signin, 'access', 'the card shows the sign-in on the access token')
    assert.deepEqual(xc.types().find(t => t.id === 'xfake').signin, { slot: 'access', manual: false, label: { en: 'Connect X', zh: '连接 X' } })
    assert.deepEqual(xc.types().find(t => t.id === 'xfake').slots.filter(s => s.auto).map(s => s.name), ['access', 'refresh', 'expiresAt'])
    await xc.setSlot('xx', 'clientSecret', 'secret-abcdef')

    // begin: the authorize address with its parameters; the challenge is S256 of the verifier it keeps
    const xtype = xType()
    const direct = xtype.signin.begin({ fields: { clientId: 'client-id-1', redirectUri: 'http://127.0.0.1:4310/api/oauth/x/callback' } }, { clientSecret: 'secret-abcdef' })
    const dq = new URL(direct.url).searchParams
    assert.equal(direct.url.split('?')[0], 'https://x.com/i/oauth2/authorize')
    assert.equal(dq.get('code_challenge'), createHash('sha256').update(direct.state.verifier).digest('base64url'))
    assert.deepEqual([dq.get('code_challenge_method'), dq.get('state') === direct.state.state, dq.get('response_type'), dq.get('client_id')], ['S256', true, 'code', 'client-id-1'])
    assert.equal(dq.get('scope'), 'tweet.read tweet.write users.read media.write offline.access')
    assert.ok(!direct.url.includes(direct.state.verifier) && !direct.url.includes('secret-abcdef'), 'the verifier and the secret are not in the address')
    const begun = await xc.beginSignin('xx')
    const bq = new URL(begun.url).searchParams
    assert.equal(begun.url.split('?')[0], `${ob}/authorize`)
    assert.equal(begun.intercept, 'http://127.0.0.1:4310/api/oauth/x/callback')
    assert.equal(bq.get('redirect_uri'), begun.intercept)
    assert.ok(!('state' in begun) && !JSON.stringify(begun).includes('secret-abcdef'), 'the private state stays in the service')
    oa.challenge = bq.get('code_challenge')

    // keep: the code for tokens (the verifier checks against the challenge), through the returned ready / keep
    const cb = (q, to = begun.intercept) => `${to}?${new URLSearchParams(q)}`
    assert.equal(begun.site.ready(begun.url, [], begun.base, { callbackUrl: '' }), false)
    assert.equal(begun.site.ready(begun.url, [], begun.base, { callbackUrl: cb({ code: 'code-good' }) }), true)
    await assert.rejects(begun.site.keep([], '', { callbackUrl: cb({ code: 'code-good', state: 'someone-elses' }) }), /state differs/)
    await assert.rejects(begun.site.keep([], '', { callbackUrl: cb({ error: 'access_denied', state: bq.get('state') }) }), /did not authorize: access_denied/)
    await assert.rejects(begun.site.keep([], '', { callbackUrl: cb({ state: bq.get('state') }) }), /no authorization code/)
    assert.equal(oa.tokenCalls.length, 0, 'none of those reached the token endpoint')
    const bad = await begun.site.keep([], '', { callbackUrl: cb({ code: 'code-bad', state: bq.get('state') }) }).catch(err => err)
    assert.match(bad.message, /refused the code — HTTP 400: invalid_grant \(bad code or verifier\)/)
    assert.ok(!bad.message.includes('secret-abcdef') && !bad.message.includes('code-bad'), 'the error holds neither the secret nor the code')
    const kept = await begun.site.keep([], '', { callbackUrl: cb({ code: 'code-good', state: bq.get('state') }) })
    assert.deepEqual(Object.keys(kept.slots), ['access', 'refresh', 'expiresAt'])
    assert.deepEqual([kept.slots.access, kept.slots.refresh], ['acc-1-aaaaaa', 'ref-1-aaaaaa'])
    const exchange = oa.tokenCalls.at(-1)
    assert.equal(exchange.headers.authorization, `Basic ${Buffer.from('client-id-1:secret-abcdef').toString('base64')}`, 'a client secret means Basic authentication')
    assert.deepEqual([exchange.params.grant_type, exchange.params.client_id, exchange.params.redirect_uri], ['authorization_code', 'client-id-1', begun.intercept])
    // a public client (no secret): only its id
    await xc.clearSlot('xx', 'clientSecret')
    const pub = await xc.beginSignin('xx')
    oa.challenge = new URL(pub.url).searchParams.get('code_challenge')
    await pub.site.keep([], '', { callbackUrl: cb({ code: 'code-good', state: new URL(pub.url).searchParams.get('state') }) })
    assert.equal(oa.tokenCalls.at(-1).headers.authorization, undefined)
    assert.equal(oa.tokenCalls.at(-1).params.client_id, 'client-id-1')
    // what the sign-in kept goes into the slots (how the page's save does), and the connection works
    clock = Date.now()
    oa.n = 1; oa.access = 'acc-1-aaaaaa'; oa.refresh = 'ref-1-aaaaaa' // the first exchange's tokens are the live ones
    for (const [name, v] of Object.entries(kept.slots)) await xc.setSlot('xx', name, v)
    const st1 = await xc.test('xx')
    assert.deepEqual([st1.ok, st1.detail], [true, '@ethan_x'])

    // a live token is used as it is
    oa.tokenCalls.length = 0
    const callX = () => xc.client('xx', { by: 'check' }).request('/users/me')
    assert.equal((await callX()).status, 200)
    assert.equal(oa.tokenCalls.length, 0)
    assert.equal(oa.apiAuth.at(-1), 'Bearer acc-1-aaaaaa')
    // expired (within a minute of the end counts): refreshed once, the new tokens written back, the test status kept
    clock += 7200e3 - 30e3
    assert.equal((await callX()).status, 200)
    assert.equal(oa.tokenCalls.length, 1)
    assert.deepEqual([oa.tokenCalls[0].params.grant_type, oa.tokenCalls[0].params.refresh_token, oa.tokenCalls[0].params.client_id], ['refresh_token', 'ref-1-aaaaaa', 'client-id-1'])
    assert.equal(oa.apiAuth.at(-1), 'Bearer acc-2-aaaaaa')
    const listedX = (await xc.list()).find(x => x.id === 'xx')
    assert.equal(listedX.status?.ok, true, 'a refresh does not clear what the last test said')
    assert.equal(listedX.slots.find(s => s.name === 'expiresAt').value, String(clock + 7200e3))
    assert.equal((await callX()).status, 200)
    assert.equal(oa.tokenCalls.length, 1, 'the new token is live: no second refresh')
    // requests that come together refresh once and all carry the new token
    clock += 7200e3
    oa.tokenCalls.length = 0; oa.apiAuth.length = 0
    const together = await Promise.all([1, 2, 3, 4, 5].map(callX))
    assert.deepEqual(together.map(r => r.status), [200, 200, 200, 200, 200])
    assert.equal(oa.tokenCalls.length, 1, 'refreshed once')
    assert.deepEqual([...new Set(oa.apiAuth)], ['Bearer acc-3-aaaaaa'])
    // a refresh token the site does not send again stays
    clock += 7200e3
    oa.noRefresh = true
    assert.equal((await callX()).status, 200)
    oa.noRefresh = false
    assert.equal((await xcreds.get('xx')).refresh, 'ref-3-aaaaaa', 'the old refresh token stays')
    assert.equal((await xc.env('xx', { write: true })).X_ACCESS_TOKEN, 'acc-4-aaaaaa', 'a command that writes gets the live token')
    assert.equal((await xc.env('xx')).X_ACCESS_TOKEN, undefined, 'a read-only command none')
    assert.equal((await xc.env('xx')).X_API_URL, `${ob}/2`)
    // the site is down for a moment: try later, not reconnect — the authorization stands
    oa.busy = true
    clock += 7200e3
    const busy = await callX().catch(err => err)
    assert.equal(busy.code, 'refreshLater')
    assert.match(busy.message, /could not be renewed just now/)
    oa.busy = false
    // the site refuses the refresh token: reconnect, naming the connection, no value in the message
    oa.fail = true
    clock += 7200e3
    const lost = await callX().catch(err => err)
    assert.equal(lost.code, 'reconnect')
    assert.equal(lost.params.id, 'xx')
    assert.match(lost.message, /xx: the X authorization has ended \(HTTP 400: invalid_request/)
    for (const v of ['acc-4-aaaaaa', 'ref-3-aaaaaa', 'client-id-1']) assert.ok(!lost.message.includes(v), `the message holds ${v}`)
    assert.match((await xc.test('xx')).detail, /authorization has ended/, 'the test says so too')
    oa.fail = false
    assert.equal((await callX()).status, 200, 'the refresh token was not lost: the next try works')
    // no refresh token at all
    await xc.clearSlot('xx', 'refresh')
    clock += 7200e3
    await assert.rejects(callX(), err => err.code === 'reconnect' && /no refresh token/.test(err.message))
    // the API itself saying 401: the test points to reconnecting
    oa.apiDown = true
    await xc.setSlot('xx', 'refresh', oa.refresh)
    clock = Date.now()
    await xc.setSlot('xx', 'expiresAt', String(clock + 3600e3))
    assert.match((await xc.test('xx')).detail, /HTTP 401 .*reconnect X/)
    oa.apiDown = false
    // the audit: every refresh, never a value
    const xaudit = readFileSync(join(xhome, 'audit.jsonl'), 'utf8')
    const refreshes = xaudit.trim().split('\n').map(l => JSON.parse(l)).filter(e => e.method === 'REFRESH')
    assert.equal(refreshes.length, 8)
    assert.ok(refreshes.every(e => e.id === 'xx' && e.level === 'write' && (e.path === '/oauth2/token' || e.failed)))
    assert.equal(refreshes.filter(e => e.failed).length, 4, 'the site busy, a refused refresh (the request, the test), a missing refresh token')
    assert.ok(refreshes.some(e => e.failed && e.status === 400))
    assert.ok(refreshes.some(e => e.failed && e.status === 503))
    for (const v of ['acc-', 'ref-', 'secret-abcdef', 'client-id-1', 'code-good']) assert.ok(!xaudit.includes(v), `the audit holds ${v}`)
    // nothing a token holds reaches the page's data
    const shownX = JSON.stringify(await xc.list())
    for (const v of ['acc-', 'ref-', 'secret-abcdef']) assert.ok(!shownX.includes(v), `the list holds ${v}`)
    assert.ok((await xc.list())[0].slots.filter(s => ['access', 'refresh'].includes(s.name)).every(s => s.set && s.tail === undefined), 'no tail on tokens that only a sign-in makes')

    // in a box: the OAuth slots stay in the box (a refresh needs the real values); the other types still go to the vault
    {
      const put = []
      const bxx = createConnectors({ home: mkdtempSync(join(tmpdir(), 'connectors-xbox-')), creds: memoryCredentials(), vault: { put: async (n, b) => { put.push(n); return { placeholder: `NKB${'c'.repeat(32)}` } }, remove: async () => {} } })
      bxx.registerType('xfake', xType({ token: `${ob}/oauth2/token`, api: `${ob}/2` }))
      await bxx.save({ id: 'xx', type: 'xfake', fields: { clientId: 'client-id-1' } })
      for (const [name, v] of [['clientSecret', 'secret-abcdef'], ['access', oa.access], ['refresh', oa.refresh], ['expiresAt', String(Date.now() + 3600e3)]]) await bxx.setSlot('xx', name, v)
      assert.deepEqual(put, [], 'none of X\'s slots goes to the vault')
      assert.equal((await bxx.env('xx', { write: true })).X_ACCESS_TOKEN, oa.access, 'the real token, not a placeholder')
      assert.equal((await bxx.client('xx').request('/users/me')).status, 200)
      assert.ok(!(await bxx.exportData()).secrets.length, 'no OAuth token goes in a configuration file')
      await bxx.save({ id: 'g', type: 'gitlab', baseUrl: 'https://gitlab.example.com' })
      await bxx.setSlot('g', 'read', 'glpat-real-0123456')
      assert.deepEqual(put, ['CONN_G__READ'])
    }
    // a sign-in of a type with no `begin` (an http cookie one) opens its own page, catches nothing
    await xc.save({ id: 'web', type: 'http', baseUrl: 'https://www.example.com', fields: { auth: 'cookie', signinUrl: 'https://www.example.com/login' } })
    const plain = await xc.beginSignin('web')
    assert.deepEqual([plain.url, plain.base, plain.intercept, plain.site.manual], ['https://www.example.com/login', 'https://www.example.com', '', true])
    await assert.rejects(xc.beginSignin('gl-none'), err => err.code === 'noConnection')
    await xc.remove('xx')
  }

  // ── a share target: 123 云盘 (client credentials buy the token; files go up in presigned slices; a link comes back) ──
  {
    const pan = { calls: [], put: [], tokens: 0, folders: [{ fileId: 7, filename: 'Ruyix', type: 1, parentFileId: 0 }], nextId: 100 }
    const panServer = createServer(async (req, res) => {
      const chunks = []
      for await (const ch of req) chunks.push(ch)
      const raw = Buffer.concat(chunks), url = new URL(req.url, 'http://x')
      const send = (data, code = 0) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code, message: code ? 'nope' : 'ok', data })) }
      if (url.pathname.startsWith('/put/')) { pan.put.push({ path: url.pathname, bytes: raw.length, auth: req.headers.authorization || null }); res.writeHead(200); return res.end() }
      pan.calls.push({ method: req.method, path: url.pathname, platform: req.headers.platform, auth: req.headers.authorization, body: raw.length ? JSON.parse(raw) : null, query: Object.fromEntries(url.searchParams) })
      if (url.pathname === '/api/v1/access_token') { const b = JSON.parse(raw); if (b.clientSecret !== 'pan-secret-123456') return send(null, 401); pan.tokens++; return send({ accessToken: `pan-token-${pan.tokens}xyz`, expiredAt: new Date(Date.now() + 864e5).toISOString() }) }
      if (req.headers.authorization !== `Bearer pan-token-${pan.tokens}xyz` || req.headers.platform !== 'open_platform') return send(null, 401)
      if (url.pathname === '/api/v1/user/info') return send({ uid: 1814435971, nickname: '测试' })
      if (url.pathname === '/api/v2/file/list') return send({ lastFileId: -1, fileList: pan.folders.filter(f => String(f.parentFileId) === url.searchParams.get('parentFileId')) })
      if (url.pathname === '/upload/v1/file/mkdir') { const b = JSON.parse(raw); const id = pan.nextId++; pan.folders.push({ fileId: id, filename: b.name, type: 1, parentFileId: b.parentID }); return send({ dirID: id }) }
      if (url.pathname === '/upload/v1/file/create') { const b = JSON.parse(raw); return b.etag === 'reuse'.padEnd(32, '0') ? send({ reuse: true, fileID: 1 }) : send({ reuse: false, preuploadID: `pre-${b.filename}`, sliceSize: 4 }) }
      if (url.pathname === '/upload/v1/file/get_upload_url') { const b = JSON.parse(raw); return send({ presignedURL: `${panBase}/put/${encodeURIComponent(b.preuploadID)}/${b.sliceNo}` }) }
      if (url.pathname === '/upload/v1/file/upload_complete') return send({ async: true, completed: false, fileID: 0 })
      if (url.pathname === '/upload/v1/file/upload_async_result') return send({ completed: true, fileID: pan.nextId++ })
      if (url.pathname === '/api/v1/share/create') return send({ shareID: 9, shareKey: 'abcd-1234' })
      send(null, 404)
    })
    await new Promise(r => panServer.listen(0, '127.0.0.1', r))
    const panBase = `http://127.0.0.1:${panServer.address().port}`
    const pc = createConnectors({ home: mkdtempSync(join(tmpdir(), 'connectors-pan-')), creds: memoryCredentials(), types: { ...TYPES, pan123: pan123Type(panBase) } })
    await pc.save({ id: 'pan', type: 'pan123', fields: { clientId: 'cid-1' } })
    assert.equal(pc.get('pan').share, true, 'a share target'); assert.equal(c.get('gl').share, false)
    await assert.rejects(pc.share('pan', [{ path: '/nope' }]), err => err.code === 'reconnect' && /credentials are not set/.test(err.message), 'no secret: no token')
    await pc.setSlot('pan', 'clientSecret', 'pan-secret-123456')
    const dir = mkdtempSync(join(tmpdir(), 'connectors-pan-files-'))
    writeFileSync(join(dir, 'a.mp4'), 'ten bytes!'); writeFileSync(join(dir, 'b.jpg'), 'img')
    const notes = []
    const r = await pc.share('pan', [{ path: join(dir, 'a.mp4'), name: '推广片:高光.mp4' }, { path: join(dir, 'b.jpg') }], { folder: '寒流预警 2026-10-12', expireDays: 30, password: 'ab12', by: 'r1:share', note: x => notes.push(x) })
    assert.equal(r.url, 'https://1814435971.share.123pan.cn/123pan/abcd-1234'); assert.equal(r.password, 'ab12'); assert.equal(r.expireDays, 30)
    assert.deepEqual(r.files.map(f => [f.name, f.size]), [['推广片 高光.mp4', 10], ['b.jpg', 3]], 'names made safe for the drive')
    assert.equal(pan.tokens, 1, 'one token for the whole share')
    assert.ok(pan.calls.filter(x => x.path !== '/api/v1/access_token').every(x => x.platform === 'open_platform' && x.auth === 'Bearer pan-token-1xyz'))
    assert.deepEqual(pan.put.map(p => p.bytes), [4, 4, 2, 3], 'the file in the slices the drive asked for')
    assert.ok(pan.put.every(p => p.auth === null), 'the presigned upload carries no credential')
    const mk = pan.calls.find(x => x.path === '/upload/v1/file/mkdir')
    assert.equal(mk.body.parentID, 7)
    assert.match(mk.body.name, /^寒流预警 2026-10-12-[0-9a-f-]{36}$/)
    const share = pan.calls.find(x => x.path === '/api/v1/share/create')
    assert.deepEqual(share.body, { shareName: '寒流预警 2026-10-12', shareExpire: 30, fileIDList: String(mk && pan.folders.at(-1).fileId), sharePwd: 'ab12' })
    assert.ok(pan.calls.some(x => x.path === '/upload/v1/file/upload_async_result'), 'an async completion is waited for')
    assert.deepEqual(notes, ['上传 推广片 高光.mp4', '上传 b.jpg'])
    const audit = pc.audit('pan', 100)
    assert.ok(audit.some(a => a.method === 'REFRESH' && !a.failed) && audit.some(a => a.method === 'PUT' && /upload, 4 bytes/.test(a.path)), 'the token and the uploads are audited')
    assert.ok(!JSON.stringify(audit).includes('pan-token') && !JSON.stringify(audit).includes('pan-secret'), 'no value in the audit')
    const tested = await pc.test('pan'); assert.deepEqual([tested.ok, tested.detail], [true, '测试 · uid 1814435971'])
    await assert.rejects(c.share('gl', [{ path: join(dir, 'a.mp4') }]), err => err.code === 'noShare')
    await pc.share('pan', [{ path: join(dir, 'b.jpg') }], { folder: '寒流预警 2026-10-12' })
    const sharedFolders = pan.calls.filter(x => x.path === '/api/v1/share/create').map(x => x.body.fileIDList)
    assert.equal(new Set(sharedFolders).size, 2, 'a repeated share never includes the previous folder')
    panServer.close()
  }

  // the page's words: the same keys in both languages
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
} finally {
  server.close()
  oauthServer.close()
}
console.log('connectors check: ok')

// A late OAuth refresh cannot restore a removed secret or replace a newer account.
for (const change of ['remove','readd','signin','clear','edit']) {
  const home = mkdtempSync(join(tmpdir(),'ruyix-refresh-generation-')), creds = memoryCredentials()
  let release, external = 0
  const reply = body => new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}})
  const service = createConnectors({home,creds,types:{test:xType({token:'https://oauth.invalid/token',api:'https://oauth.invalid/2'})},fetch:async url=>{
    if(new URL(url).pathname==='/token') return new Promise(r=>{release=()=>r(reply({access_token:'account-A2',refresh_token:'refresh-A2',expires_in:3600}))})
    external++;return reply({data:{id:'fixture'}})
  }})
  const definition={id:'test',type:'test',fields:{clientId:'fixture'}}
  try {
    await service.save(definition)
    for(const [slot,value] of Object.entries({access:'account-A1',refresh:'refresh-A1',expiresAt:'0'}))await service.setSlot('test',slot,value)
    const pending=service.client('test').request('/users/me').then(v=>v,e=>e)
    while(!release)await new Promise(r=>setTimeout(r,0))
    if(change==='remove'||change==='readd'){await service.remove('test');if(change==='readd')await service.save(definition)}
    else if(change==='signin'){await service.setSlot('test','access','account-B1');await service.setSlot('test','expiresAt',String(Date.now()+3600e3))}
    else if(change==='clear')await service.clearSlot('test','access')
    else await service.save({...definition,name:'changed elsewhere'})
    release();assert.equal((await pending).code,'changedMeanwhile',change);assert.equal(external,0,'a stale refresh must not send an external request')
    const values=await creds.get('test')
    if(change==='remove'||change==='readd'||change==='clear')assert.ok(!values.access,change)
    else assert.equal(values.access,change==='signin'?'account-B1':'account-A1',change)
    assert.notEqual(values.refresh,'refresh-A2',change)
  } finally { const {rmSync}=await import('node:fs');rmSync(home,{recursive:true,force:true}) }
}

for(const mutation of ['slot','clear','readd']){
  const home=mkdtempSync(join(tmpdir(),'ruyix-status-epoch-')),creds=memoryCredentials();let release
  const c=createConnectors({home,creds,types:{slow:{...TYPES.http,slots:[{name:'token',label:{en:'Token',zh:'密钥'},required:true}],test:()=>new Promise(r=>{release=r})}}})
  const def={id:'slow',type:'slow',baseUrl:'https://fixture.invalid'}
  try{
    await c.save(def);await c.setSlot('slow','token','old-value')
    const pending=c.test('slow');while(!release)await new Promise(r=>setTimeout(r,0))
    if(mutation==='slot')await c.setSlot('slow','token','new-value')
    else if(mutation==='clear')await c.clearSlot('slow','token')
    else{await c.remove('slow');await c.save(def);await c.setSlot('slow','token','new-value')}
    release({ok:false,detail:'old result'});await pending;assert.equal(c.status('slow'),null,mutation)
  }finally{const{rmSync}=await import('node:fs');rmSync(home,{recursive:true,force:true})}
}

for(const mutation of ['host','readd','credential','fields','next-signin']){
  const home=mkdtempSync(join(tmpdir(),'ruyix-browser-ticket-')),creds=memoryCredentials(),c=createConnectors({home,creds})
  const def={id:'web',type:'http',baseUrl:'https://a.example',fields:{auth:'cookie'}}
  try{
    await c.save(def);const begun=await c.beginSignin('web')
    if(mutation==='host')await c.save({...def,baseUrl:'https://b.example'})
    else if(mutation==='readd'){await c.remove('web');await c.save({...def,baseUrl:'https://b.example'})}
    else if(mutation==='credential')await c.setSlot('web','token','newer-credential')
    else if(mutation==='fields')await c.setFields('web',{auth:'cookie'})
    else await c.beginSignin('web')
    await assert.rejects(c.keepSignin('web',begun.ticket,{slots:{token:'sid=obsolete'}}),e=>e.code==='changedMeanwhile',mutation)
    assert.equal((await creds.get('web')).token,mutation==='credential'?'newer-credential':undefined)
    const current=await c.beginSignin('web');await c.keepSignin('web',current.ticket,{slots:{token:'sid=current'}})
    assert.equal((await creds.get('web')).token,'sid=current')
    await assert.rejects(c.keepSignin('web',current.ticket,{slots:{token:'sid=twice'}}),e=>e.code==='changedMeanwhile','a ticket commits once')
  }finally{const{rmSync}=await import('node:fs');rmSync(home,{recursive:true,force:true})}
}
{
  const home=mkdtempSync(join(tmpdir(),'ruyix-browser-commit-')),creds=memoryCredentials(),c=createConnectors({home,creds})
  const def={id:'web',type:'http',baseUrl:'https://a.example',fields:{auth:'cookie'}};let release
  try{
    await c.save(def);const begun=await c.beginSignin('web'),set=creds.set
    creds.set=async(id,key,value)=>{await new Promise(r=>{release=r});return set(id,key,value)}
    const committing=c.keepSignin('web',begun.ticket,{slots:{token:'sid=current'}})
    while(!release)await new Promise(r=>setTimeout(r,0))
    let removed=false;const removing=c.remove('web').then(()=>{removed=true})
    await new Promise(r=>setTimeout(r,0));assert.equal(removed,false,'a removal cannot interleave a sign-in credential commit')
    release();await committing;await removing;assert.deepEqual(await creds.get('web'),{})
  }finally{const{rmSync}=await import('node:fs');rmSync(home,{recursive:true,force:true})}
}

// Renewal of the old account is automatic maintenance, not a replacement of an in-flight browser sign-in.
{
  const home=mkdtempSync(join(tmpdir(),'ruyix-browser-refresh-')),creds=memoryCredentials()
  const c=createConnectors({home,creds,types:{x:xType({token:'https://fake.invalid/token',api:'https://fake.invalid/2'})},fetch:async url=>new Response(JSON.stringify(new URL(url).pathname==='/token'?{access_token:'renewed-A',refresh_token:'refresh-A',expires_in:3600}:{data:{id:'A'}}),{headers:{'content-type':'application/json'}})})
  try{
    await c.save({id:'x',type:'x',fields:{clientId:'fixture'}})
    for(const [name,value]of Object.entries({access:'old-A',refresh:'refresh-A',expiresAt:'0'}))await c.setSlot('x',name,value)
    const begun=await c.beginSignin('x');await c.client('x').request('/users/me')
    await c.keepSignin('x',begun.ticket,{slots:{access:'new-B',refresh:'refresh-B',expiresAt:String(Date.now()+3600e3)}})
    assert.equal((await creds.get('x')).access,'new-B')
  }finally{const{rmSync}=await import('node:fs');rmSync(home,{recursive:true,force:true})}
}

// A separate SSO entry address never changes the API's cookie scope.
{
  const home=mkdtempSync(join(tmpdir(),'ruyix-cookie-target-')),creds=memoryCredentials();let delivered
  const c=createConnectors({home,creds,fetch:async(url,opts)=>{delivered={url:String(url),cookie:opts.headers.cookie};return new Response('{}')}})
  try{
    await c.save({id:'web',type:'http',baseUrl:'https://api.example/api',fields:{auth:'cookie',signinUrl:'https://sso.example/login'}})
    const begun=await c.beginSignin('web')
    assert.equal(begun.base,'https://api.example/api');assert.equal(begun.url,'https://sso.example/login')
    const cookies=new URL(begun.base).hostname==='api.example'?[{name:'SID',value:'API_ONLY'}]:[{name:'SSO',value:'SSO_ONLY'}]
    await c.keepSignin('web',begun.ticket,await begun.site.keep(cookies,''))
    await c.client('web').request('/probe');assert.equal(delivered.cookie,'SID=API_ONLY')
  }finally{const{rmSync}=await import('node:fs');rmSync(home,{recursive:true,force:true})}
}

// Legacy file-secret migration and removal share one owner: a removed connection cannot regain credentials.
{
  const home=mkdtempSync(join(tmpdir(),'ruyix-file-owner-')),creds=memoryCredentials(),active=new Set();let release
  const vault={policy:async()=>({trust:{'cluster.example':'ca'},passthrough:[]}),put:async name=>{await new Promise(r=>{release=r});active.add(name);return{placeholder:'glpat-NKB'+'a'.repeat(32)}},remove:async name=>{active.delete(name)}}
  const c=createConnectors({home,creds,vault})
  try{
    await c.save({id:'k',type:'k8s',fields:{namespace:'default'}})
    await creds.set('k','kubeconfig','clusters:\n- cluster:\n    server: https://cluster.example\nusers:\n- user:\n    token: eyJlocal.fake\n')
    const materializing=c.file('k','kubeconfig');while(!release)await new Promise(r=>setTimeout(r,0))
    let removed=false;const removing=c.remove('k').then(()=>{removed=true})
    await new Promise(r=>setTimeout(r,0));assert.equal(removed,false,'remove waits for the admitted migration')
    release();await materializing;await removing
    assert.equal(c.has('k'),false);assert.deepEqual(await creds.get('k'),{});assert.equal(active.size,0,'no late vault credential survives removal')
  }finally{const{rmSync}=await import('node:fs');rmSync(home,{recursive:true,force:true})}
}

// Import, export and environment assembly take one coherent connection/credential snapshot.
for (const mode of ['adopt', 'export', 'env', 'cookies', 'command']) {
  const home = mkdtempSync(join(tmpdir(), 'ruyix-credential-snapshot-')), creds = memoryCredentials()
  const type = { ...TYPES.http, command: { cmd: 'fixture', args: [] }, cookies: (c, v) => [{ url: c.baseUrl, value: v.token }] }
  let release, ran
  const c = createConnectors({ home, creds, types: { snapshot: type }, run: async (cmd, args, opts) => { ran = opts.env; return { code: 0, stdout: '{}', stderr: '' } } })
  const def = { id: 'web', type: 'snapshot', baseUrl: 'https://a.example', fields: { auth: 'bearer' } }
  try {
    await c.save(def)
    if (mode !== 'adopt') await c.setSlot('web', 'token', 'OLD_A_TOKEN')
    const get = creds.get
    creds.get = async id => {
      if (release) return get(id)
      if (mode === 'env' || mode === 'cookies') { await new Promise(r => { release = r }); return get(id) }
      const v = await get(id); await new Promise(r => { release = r }); return v
    }
    const pending = mode === 'adopt' ? c.adopt(def, { token: 'IMPORTED_TOKEN' }) : mode === 'export' ? c.exportData({ values: true }) : mode === 'cookies' ? c.browserCookies('web') : mode === 'command' ? c.command('web', []) : c.env('web')
    while (!release) await new Promise(r => setTimeout(r, 0))
    let changed = false
    const changing = (async () => {
      if (mode !== 'adopt') await c.save({ ...def, baseUrl: 'https://b.example' })
      await c.setSlot('web', 'token', 'PERSON_B_TOKEN'); changed = true
    })()
    await new Promise(r => setTimeout(r, 0)); assert.equal(changed, false, `${mode}: the admitted snapshot owns its inputs`)
    release(); const result = await pending; await changing
    assert.equal((await get('web')).token, 'PERSON_B_TOKEN', `${mode}: later user credential wins`)
    if (mode === 'export') {
      assert.equal(result.connections[0].baseUrl, 'https://a.example')
      assert.equal(result.values.CONN_WEB__TOKEN, 'OLD_A_TOKEN')
      assert.deepEqual(result.secrets[0].hosts, ['a.example'])
    } else if (mode === 'env' || mode === 'command') assert.deepEqual(mode === 'env' ? result : ran, { API_URL: 'https://a.example', API_TOKEN: 'OLD_A_TOKEN' })
    else if (mode === 'cookies') assert.deepEqual(result, [{ url: 'https://a.example', value: 'OLD_A_TOKEN' }])
  } finally { const { rmSync } = await import('node:fs'); rmSync(home, { recursive: true, force: true }) }
}

// Cancelling a browser launch retains the profile owner until that browser has fully closed.
{
  const { createSignin } = await import('./lib/signin.js'), { createRequire } = await import('node:module')
  const { mkdirSync, rmSync } = await import('node:fs')
  const home = mkdtempSync(join(tmpdir(), 'ruyix-signin-launch-')), runtime = join(home, 'runtime'), module = join(runtime, 'node_modules/playwright')
  mkdirSync(module, { recursive: true }); writeFileSync(join(runtime, 'package.json'), '{}')
  writeFileSync(join(module, 'index.js'), `
    const control = exports.control = { launches: [], active: false, closes: 0 }
    exports.chromium = { launchPersistentContext: async () => {
      if (control.active) throw Error('profile in use')
      control.active = true
      await new Promise(r => control.launches.push(r))
      const page = { on() {}, goto: async () => {}, screenshot: async () => Buffer.from('jpeg'), url: () => 'https://fixture.invalid', isClosed: () => false }
      return { pages: () => [page], cookies: async () => [], close: async () => {
        if (++control.closes === 1) await new Promise(r => { control.closeFirst = r })
        control.active = false
      } }
    } }
  `)
  const control = createRequire(join(runtime, 'package.json'))('playwright').control
  const signin = createSignin({ runtimeDir: runtime, home: join(home, 'profiles'), save: async () => {}, forget: true })
  const tick = () => new Promise(r => setTimeout(r, 0))
  try {
    const first = signin.start('web', 'https://fixture.invalid', { ready: () => false }, { attempt: 'first' })
    const stopping = signin.stop({ id: 'web', attempt: 'first' })
    const next = signin.start('web', 'https://fixture.invalid', { ready: () => false }, { attempt: 'next' })
    await tick(); assert.equal(control.launches.length, 1, 'the next launch waits for the cancelled launch')
    control.launches[0](); while (!control.closeFirst) await tick()
    assert.equal(control.launches.length, 1, 'the next launch also waits for profile closure')
    control.closeFirst(); await stopping; assert.equal((await first).status, 'cancelled')
    while (control.launches.length < 2) await tick()
    control.launches[1](); assert.equal((await next).status, 'running')
    await signin.stop({ id: 'web', attempt: 'next' }); assert.equal(control.active, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
}

// Sanitized drive paths may collide; a later item must never reuse or overwrite the first item's bytes.
{
  const { DRIVES } = await import('./lib/drive.js'), { rmSync } = await import('node:fs')
  const home = mkdtempSync(join(tmpdir(), 'ruyix-drive-collision-')); let bytes = 0
  const client = { request: async path => path.includes('filemetas')
    ? { ok: true, json: async () => ({ list: [{ fs_id: 1, dlink: 'https://fixture.invalid/1', size: 3, filename: 'one' }, { fs_id: 2, dlink: 'https://fixture.invalid/2', size: 3, filename: 'two' }] }) }
    : { ok: true, status: 200, stream: () => { bytes++; return new Blob(['AAA']).stream() } } }
  try {
    await assert.rejects(DRIVES.baidupan.download(client, [{ id: 1, rel: 'a  b.txt' }, { id: 2, rel: 'a b.txt' }], home), e => e.code === 'driveFailed' && e.message.includes('冲突'))
    assert.equal(bytes, 1); assert.equal(readFileSync(join(home, 'a b.txt'), 'utf8'), 'AAA')
  } finally { rmSync(home, { recursive: true, force: true }) }
}

// The public sign-in operation reserves the browser before creating or replacing a connection ticket.
{
  const { mkdirSync, rmSync } = await import('node:fs'), { createRequire } = await import('node:module')
  const root = mkdtempSync(join(tmpdir(), 'ruyix-signin-admission-')), runtime = join(root, 'runtime'), module = join(runtime, 'node_modules/playwright')
  mkdirSync(module, { recursive: true }); writeFileSync(join(runtime, 'package.json'), '{}')
  writeFileSync(join(module, 'index.js'), `
    const control = exports.control = { launches: 0, pause: false, release: null }
    exports.chromium = { launchPersistentContext: async () => {
      control.launches++
      if (control.pause) await new Promise(r => { control.release = r })
      let closed = false, url = 'https://fixture.invalid/login'
      const page = { on() {}, goto: async u => { url = u }, screenshot: async () => Buffer.from('jpeg'), content: async () => '', url: () => url, isClosed: () => closed }
      return { pages: () => [page], cookies: async () => [{ name: 'SID', value: 'kept' }], close: async () => { closed = true } }
    } }
  `)
  const control = createRequire(join(runtime, 'package.json'))('playwright').control
  const until = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)) } throw Error('sign-in fixture timed out') }
  try {
    for (const phase of ['prepare', 'launch', 'running']) {
      const creds = memoryCredentials(); let service, route, release, prepares = 0
      apply({ provide: (n, v) => { if (n === 'connectors') service = v }, connection: { fetch: { register: r => { route = r } } }, effect: () => {}, inject: () => {}, on: () => {} }, {}, { home: join(root, phase), runtimeDir: runtime, creds, vault: null, fetch: async () => new Response('{}') })
      const post = async body => (await route.fetch(new Request('http://fixture.invalid/api/connectors', { method: 'POST', body: JSON.stringify(body) }))).json()
      await service.save({ id: 'web', type: 'http', baseUrl: 'https://fixture.invalid', fields: { auth: 'cookie' } })
      const begin = service.beginSignin
      service.beginSignin = async id => { prepares++; const begun = await begin(id); if (phase === 'prepare') await new Promise(r => { release = r }); return begun }
      control.pause = phase === 'launch'; control.release = null
      const first = post({ op: 'signinStart', id: 'web', attempt: 'first' })
      if (phase === 'prepare') { await until(() => release); assert.equal((await post({ op: 'signinState' })).status, 'starting') }
      else if (phase === 'launch') await until(() => control.release)
      else assert.equal((await first).status, 'running')
      const refused = await post({ op: 'signinStart', id: 'web', attempt: 'refused' })
      assert.equal(refused.code, 'signinBusy'); assert.equal(prepares, 1, `${phase}: refused calls never initialize another credential ticket`)
      if (release) release(); if (control.release) control.release(); control.pause = false
      assert.equal((await first).status, 'running')
      await post({ op: 'signinStop', id: 'web', attempt: 'refused' })
      assert.equal((await post({ op: 'signinState' })).status, 'running', 'refused dialog cleanup preserves the admitted browser')
      await post({ op: 'signinInput', id: 'web', attempt: 'first', type: 'done' })
      await until(async () => (await post({ op: 'signinState' })).status === 'done')
      assert.equal((await creds.get('web')).token, 'SID=kept', `${phase}: the original sign-in keeps its credential`)
      await post({ op: 'signinStop', id: 'web', attempt: 'first' })
    }
    // A cancellation during preparation is owned too: it never launches a browser after the dialog was closed.
    const { createSignin } = await import('./lib/signin.js'); let release
    const signin = createSignin({ runtimeDir: runtime, home: join(root, 'cancelled'), save: async () => {} }), before = control.launches
    const pending = signin.start('web', null, null, { attempt: 'cancelled', prepare: async () => { await new Promise(r => { release = r }); return { site: { ready: () => false }, base: 'https://fixture.invalid' } } })
    await until(() => release); const stopping = signin.stop({ id: 'web', attempt: 'cancelled' }); release()
    await stopping; assert.equal((await pending).status, 'cancelled'); assert.equal(control.launches, before)
    assert.equal((await signin.start('web', 'https://fixture.invalid', { ready: () => false })).status, 'running'); await signin.stop()
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// the read ops for boards, and a kubeconfig's token in a box's vault
await import('./reads-check.mjs')

// Baidu Netdisk against a fake platform
await import('./baidu-check.mjs')

// the sign-in browser (skipped where Playwright is not installed)
await import('./signin-check.mjs')
