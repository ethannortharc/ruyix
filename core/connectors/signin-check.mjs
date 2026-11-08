import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
// Self-check of the Connectors page's sign-in browser against a site on loopback, with the http type's sign-in (the
// person says when the session is there; the cookies are kept as the token). Needs Playwright in the workbench's UI
// runtime; skipped without it. `node signin-check.mjs`
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
const RUNTIME = process.env.RUYIX_UI_RUNTIME || join(homedir(), '.ruyix/workbench/ui-runtime')
if (!existsSync(join(RUNTIME, 'node_modules/playwright'))) { console.log('sign-in check: skipped (no Playwright at ' + RUNTIME + ')'); process.exit(0) }
const { createSignin } = await import('./lib/signin.js')
const { TYPES } = await import('./lib/types.js')
// the site's certificate comes from a CA the browser is told about only as Node is (NODE_EXTRA_CA_CERTS), as a box's is
const tls = mkdtempSync(join(tmpdir(), 'signin-tls-')), ssl = (...a) => execFileSync('openssl', a, { cwd: tls, stdio: 'ignore' })
writeFileSync(join(tls, 'ext'), 'subjectAltName=IP:127.0.0.1\n')
ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=signin check CA', '-days', '2')
ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'site.key', '-out', 'site.csr', '-subj', '/CN=127.0.0.1')
ssl('x509', '-req', '-in', 'site.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'site.pem', '-days', '2', '-extfile', 'ext')
process.env.NODE_EXTRA_CA_CERTS = join(tls, 'ca.pem')
const read = f => readFileSync(join(tls, f), 'utf8')
// a site: /login has a form; posting it sets PHPSESSID and lands on /main ("Logged in as <b>jane</b>")
const srv = createServer({ key: read('site.key'), cert: read('site.pem') + read('ca.pem') }, (req, res) => {
  if (req.url === '/' ) { res.writeHead(302, { location: '/login' }); return res.end() }
  if (req.url === '/login' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<form method=post action=/login style="margin:40px"><input id=u name=u autofocus style="width:300px;height:40px"><button id=b style="width:200px;height:40px">Go</button></form>') }
  if (req.url === '/login' && req.method === 'POST') { let b = ''; req.on('data', d => b += d); req.on('end', () => { res.writeHead(302, { 'set-cookie': ['PHPSESSID=s3cret; Path=/', 'OTHER=1; Path=/'], location: '/main' }); res.end() }); return }
  if (req.url === '/main') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p>Logged in as <b>jane.doe</b></p>') }
  res.writeHead(404); res.end()
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const base = `https://127.0.0.1:${srv.address().port}`
let saved = null
const signinTicket={private:'server-owned-ticket'}
const s = createSignin({ runtimeDir: RUNTIME, home: mkdtempSync(join(tmpdir(), 'signin-')), save: async (id, v, ticket) => { assert.equal(ticket,signinTicket); saved = [id, v] }, log: () => {} })
await s.start('web', base, TYPES.http.signin,{ticket:signinTicket})
assert.ok(!JSON.stringify(s.state()).includes('server-owned-ticket'),'private connection ticket never reaches the browser UI')
const wait = async cond => { for (let i = 0; i < 100; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 100)) } throw new Error('timeout') }
await wait(() => s.state().frame && s.state().url.endsWith('/login'))
assert.match(s.state().frame, /^data:image\/jpeg;base64,/)
await s.input({ type: 'click', x: 150, y: 60 })   // the input box
await s.input({ type: 'text', text: 'jane' })
await s.input({ type: 'key', key: 'Enter' })      // submits
await wait(() => s.state().url.endsWith('/main'))
assert.equal(s.state().manual, true)
await new Promise(r => setTimeout(r, 1200))        // nothing tells the session is there: still open until the person says so
assert.equal(s.state().status, 'running')
await s.input({ type: 'done' })
await wait(() => s.state().status === 'done')
assert.deepEqual(saved, ['web', { slots: { token: 'PHPSESSID=s3cret; OTHER=1' }, fields: {} }])
assert.deepEqual(s.state().kept, ['token'])
// The actual plugin endpoint rejects a duplicate before touching the live browser's credential ticket.
{
  const { apply } = await import('./index.js'), { memoryCredentials } = await import('./lib/service.js')
  const creds = memoryCredentials(); let route, service
  apply({ provide: (n, v) => { if (n === 'connectors') service = v }, connection: { fetch: { register: r => { route = r } } }, effect: () => {}, inject: () => {}, on: () => {} }, {}, { home: mkdtempSync(join(tmpdir(), 'signin-admission-native-')), runtimeDir: RUNTIME, creds, vault: null, fetch: async () => new Response('{}') })
  const post = async body => (await route.fetch(new Request('http://fixture.invalid/api/connectors', { method: 'POST', body: JSON.stringify(body) }))).json()
  const until = async test => { for (let i = 0; i < 200; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 100)) } throw Error('native admission fixture timeout') }
  await service.save({ id: 'web', type: 'http', baseUrl: base, fields: { auth: 'cookie' } })
  try {
    assert.equal((await post({ op: 'signinStart', id: 'web', attempt: 'first' })).status, 'running')
    await until(async () => (await post({ op: 'signinState' })).url?.endsWith('/login'))
    assert.equal((await post({ op: 'signinStart', id: 'web', attempt: 'refused' })).code, 'signinBusy')
    await post({ op: 'signinStop', id: 'web', attempt: 'refused' })
    for (const input of [{ type: 'click', x: 150, y: 60 }, { type: 'text', text: 'jane' }, { type: 'key', key: 'Enter' }]) await post({ op: 'signinInput', id: 'web', attempt: 'first', ...input })
    await until(async () => (await post({ op: 'signinState' })).url?.endsWith('/main'))
    await post({ op: 'signinInput', id: 'web', attempt: 'first', type: 'done' })
    await until(async () => (await post({ op: 'signinState' })).status === 'done')
    assert.match((await creds.get('web')).token, /PHPSESSID=s3cret/)
  } finally { await post({ op: 'signinStop', id: 'web', attempt: 'first' }) }
}
srv.close()

// A double click: the second start finds the first one's place taken (the browser takes a moment to come up), and no second
// browser is left behind. A stop while the browser is starting ends it without keeping it.
{
  const t = createSignin({ runtimeDir: RUNTIME, home: mkdtempSync(join(tmpdir(), 'signin-twice-')), save: async () => {}, log: () => {} })
  const both = await Promise.allSettled([t.start('a', 'http://127.0.0.1:9/', TYPES.http.signin, { attempt: 'first' }), t.start('b', 'http://127.0.0.1:9/', TYPES.http.signin)])
  assert.deepEqual(both.map(r => r.status), ['fulfilled', 'rejected'])
  assert.equal(both[1].reason.code, 'signinBusy')
  assert.equal(t.state().key, 'a', 'the first one is the sign-in')
  await t.stop({ id: 'b', attempt: 'refused' })
  assert.equal(t.state().status, 'running', 'closing the refused dialog leaves the first sign-in running')
  await assert.rejects(t.input({ id: 'b', attempt: 'refused', type: 'text', text: 'wrong' }), { code: 'noSignin' })
  await t.stop()
  assert.equal(t.state().status, 'cancelled')
  await t.start('a', 'http://127.0.0.1:9/', TYPES.http.signin, { attempt: 'next' })
  await t.stop({ id: 'a', attempt: 'first' })
  assert.equal(t.state().status, 'running', 'an old dialog of the same connection cannot stop the next attempt')
  assert.equal(t.state({ id: 'a', attempt: 'first' }).status, 'idle')
  await t.stop({ id: 'a', attempt: 'next' })
  const late = createSignin({ runtimeDir: RUNTIME, home: mkdtempSync(join(tmpdir(), 'signin-stop-')), save: async () => {}, log: () => {} })
  const starting = late.start('c', 'http://127.0.0.1:9/', TYPES.http.signin)
  assert.equal(late.state().status, 'starting')
  await late.stop()
  assert.deepEqual((await starting).status, 'cancelled')
  assert.equal(late.state().status, 'cancelled')
  await assert.doesNotReject(late.start('d', 'http://127.0.0.1:9/', TYPES.http.signin), 'a new sign-in can start at once')
  await late.stop()
}

// OAuth: the browser is sent to the site's authorize page, the redirect to the callback address is caught (never requested),
// the code goes to the type's `keep`. A fake authorize page and token endpoint on loopback; the callback address is one
// nothing listens on.
{
  const { createConnectors, memoryCredentials } = await import('./lib/service.js')
  const { xType } = await import('./lib/types.js')
  const hits = { callback: 0, tokens: [] }
  let deny = false
  const oauth = (await import('node:http')).createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/authorize') {
      const back = new URL(u.searchParams.get('redirect_uri'))
      if (deny) back.searchParams.set('error', 'access_denied'); else back.searchParams.set('code', 'code-good')
      back.searchParams.set('state', u.searchParams.get('state'))
      res.writeHead(302, { location: back.href }); return res.end()
    }
    if (u.pathname === '/oauth2/token') {
      let raw = ''
      for await (const c of req) raw += c
      hits.tokens.push(Object.fromEntries(new URLSearchParams(raw)))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ access_token: 'acc-browser-111', refresh_token: 'ref-browser-111', expires_in: 7200 }))
    }
    if (u.pathname.startsWith('/api/oauth/x/callback')) hits.callback++ // must not happen
    res.writeHead(404); res.end()
  })
  await new Promise(r => oauth.listen(0, '127.0.0.1', r))
  const ob = `http://127.0.0.1:${oauth.address().port}`
  const xc = createConnectors({ home: mkdtempSync(join(tmpdir(), 'signin-x-')), creds: memoryCredentials() })
  xc.registerType('xfake', xType({ authorize: `${ob}/authorize`, token: `${ob}/oauth2/token`, api: `${ob}/2` }))
  // the callback address is on the oauth server itself here, so a request that was not caught would show as a hit
  await xc.save({ id: 'xx', type: 'xfake', fields: { clientId: 'client-id-1', redirectUri: `${ob}/api/oauth/x/callback` } })
  let kept = null
  const x = createSignin({ runtimeDir: RUNTIME, home: mkdtempSync(join(tmpdir(), 'signin-x-home-')), save: async (id, v) => { kept = [id, v] }, log: () => {} })
  const run = async () => {
    const begun = await xc.beginSignin('xx')
    await x.start('xx', begun.base, begun.site, { url: begun.url, intercept: begun.intercept })
    await wait(() => ['done', 'failed'].includes(x.state().status))
    return x.state()
  }
  const done = await run()
  assert.equal(done.status, 'done')
  assert.deepEqual(done.kept, ['access', 'refresh', 'expiresAt'])
  assert.equal(kept[0], 'xx')
  assert.deepEqual([kept[1].slots.access, kept[1].slots.refresh], ['acc-browser-111', 'ref-browser-111'])
  assert.equal(hits.callback, 0, 'the redirect to the callback address was answered by the browser setup, not requested')
  assert.equal(hits.tokens.length, 1)
  assert.equal(hits.tokens[0].grant_type, 'authorization_code')
  assert.ok(!done.url.includes('code='), 'the panel is not shown the code')
  assert.ok(!JSON.stringify(done).includes('acc-browser-111'), 'nor a token')
  // the site (or the person) says no: the sign-in fails, with the reason
  deny = true; kept = null
  const denied = await run()
  assert.equal(denied.status, 'failed')
  assert.match(denied.error, /access_denied/)
  assert.equal(kept, null)
  assert.equal(hits.tokens.length, 1, 'no code, no exchange')
  oauth.close()
}
console.log('sign-in check: ok')

// Remote plain HTTP has getRandomValues, but no randomUUID. Execute the dialog's real ownership expression there.
{
  const {createRequire}=await import('node:module'),{createServer: httpServer}=await import('node:http')
  const {chromium}=createRequire(join(RUNTIME,'package.json'))('playwright')
  const local=httpServer((_q,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<title>Origin check</title>')})
  await new Promise(r=>local.listen(0,'127.0.0.1',r));let browser
  try {
    browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-proxy-server','--host-resolver-rules=MAP ruyix.test 127.0.0.1']})
    const page=await browser.newPage();await page.goto(`http://ruyix.test:${local.address().port}`)
    const expression=readFileSync(new URL('./src/main.jsx',import.meta.url),'utf8').match(/const mine = (\{ id, attempt:.*\})/)[1]
    const result=await page.evaluate(expression=>{const make=new Function('id','return '+expression);return{secure:isSecureContext,uuid:typeof crypto.randomUUID,attempts:[make('a').attempt,make('a').attempt]}},expression)
    assert.equal(result.secure,false);assert.equal(result.uuid,'undefined');assert.ok(result.attempts.every(x=>/^[0-9a-f]+(?:-[0-9a-f]+){3}$/.test(x)));assert.notEqual(...result.attempts)
  }finally{await browser?.close();local.close()}
}

// A native browser may visit both origins, but only API-scoped cookies become the connection's credential.
{
  const {createServer:makeHttp}=await import('node:http'),{createConnectors,memoryCredentials}=await import('./lib/service.js')
  const {rmSync}=await import('node:fs');let port,delivered=''
  const server=makeHttp((req,res)=>{
    const path=req.url.split('?')[0]
    if(path==='/login'){res.writeHead(302,{'set-cookie':'SSO=SSO_ONLY; Path=/; HttpOnly',location:`http://localhost:${port}/init`});return res.end()}
    if(path==='/init'){res.writeHead(302,{'set-cookie':'API=API_ONLY; Path=/; HttpOnly',location:`http://127.0.0.1:${port}/done`});return res.end()}
    if(path==='/api/probe')delivered=req.headers.cookie||''
    res.writeHead(200,{'content-type':path==='/api/probe'?'application/json':'text/html'});res.end(path==='/api/probe'?'{}':'<p>Signed in</p>')
  })
  await new Promise(r=>server.listen(0,r));port=server.address().port
  const home=mkdtempSync(join(tmpdir(),'signin-cookie-target-')),c=createConnectors({home,creds:memoryCredentials()})
  const s=createSignin({runtimeDir:RUNTIME,home:join(home,'browser'),save:(id,kept,ticket)=>c.keepSignin(id,ticket,kept)})
  try{
    await c.save({id:'web',type:'http',baseUrl:`http://localhost:${port}/api`,fields:{auth:'cookie',signinUrl:`http://127.0.0.1:${port}/login`}})
    const begun=await c.beginSignin('web');await s.start('web',begun.base,begun.site,{url:begun.url,ticket:begun.ticket})
    await wait(()=>s.state().url.endsWith('/done'));await s.input({type:'done'});await wait(()=>s.state().status!=='running')
    assert.equal(s.state().status,'done',s.state().error)
    await c.client('web').request('probe')
    assert.equal(delivered,'API=API_ONLY','host-only SSO cookies must never reach the target API')
  }finally{await s.stop();server.closeAllConnections?.();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true})}
  console.log('native browser cookie-target check: ok')
}
