// The Baidu Netdisk connection against a fake platform on loopback: signing in by a code (pending, then agreed), the
// token in the query string (never audited, never in what is shown), its renewal, listing, a folder's files at any depth,
// an upload in 4 MB slices (only those the drive asks for), a download through the redirect to an address without the
// credential (a file already there kept), and a share link — refused (not an enterprise developer: the files are up,
// the place is said) and granted.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectors, memoryCredentials } from './lib/service.js'
import { TYPES, baidupanType } from './lib/types.js'
import { localPath } from './lib/drive.js'

const md5 = b => createHash('md5').update(b).digest('hex')
const bd = { calls: [], polls: 0, token: 'bd-access-111111', refresh: 'bd-refresh-222222', slices: [], made: [], canShare: false, files: new Map(), uas: [] }
const BIG = Buffer.alloc(4 * 1024 * 1024 + 10, 7) // two slices
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const ch of req) chunks.push(ch)
  const raw = Buffer.concat(chunks), url = new URL(req.url, 'http://x'), q = Object.fromEntries(url.searchParams)
  const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  const form = async () => (raw.length ? new Response(raw, { headers: { 'content-type': req.headers['content-type'] || '' } }).formData() : new FormData())
  bd.calls.push({ method: req.method, path: url.pathname, query: q })
  if (url.pathname === '/qr.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('PNG')) }
  if (url.pathname === '/oauth/2.0/device/code') return q.client_id === 'ak-1' && q.scope === 'basic,netdisk' ? send({ device_code: 'dev-1', user_code: 'ABCD1234', verification_url: 'https://openapi.baidu.com/device', qrcode_url: `${base}/qr.png`, expires_in: 300, interval: 5 }) : send({ error: 'invalid_client' }, 400)
  if (url.pathname === '/oauth/2.0/token') {
    if (q.client_secret !== 'sk-secret-123456') return send({ error: 'invalid_client' }, 401)
    if (q.grant_type === 'device_token') return ++bd.polls < 2 ? send({ error: 'authorization_pending' }, 400) : send({ access_token: bd.token, refresh_token: bd.refresh, expires_in: 2592000 })
    if (q.grant_type === 'refresh_token' && q.refresh_token === bd.refresh) { bd.token = 'bd-access-333333'; bd.refresh = 'bd-refresh-444444'; return send({ access_token: bd.token, refresh_token: bd.refresh, expires_in: 2592000 }) }
    return send({ error: 'invalid_grant' }, 400)
  }
  // the bytes behind a download link: no credential here
  if (url.pathname.startsWith('/cdn/')) { bd.uas.push({ ua: req.headers['user-agent'], token: q.access_token || null }); res.writeHead(200); return res.end(bd.files.get(url.pathname.slice(5))) }
  if (q.access_token !== bd.token) return send({ errno: -6, errmsg: 'access token invalid' })
  if (url.pathname === '/file/dl') { bd.uas.push({ ua: req.headers['user-agent'], token: q.access_token }); res.writeHead(302, { location: `/cdn/${q.fid}` }); return res.end() }
  if (url.pathname === '/rest/2.0/xpan/nas') return send({ errno: 0, netdisk_name: '测试网盘', vip_type: 1 })
  if (url.pathname === '/rest/2.0/xpan/file' && q.method === 'list') return send({ errno: 0, list: q.dir === '/' ? [{ fs_id: 11, path: '/a.mp4', server_filename: 'a.mp4', size: 3, isdir: 0 }, { fs_id: 10, path: '/剧', server_filename: '剧', size: 0, isdir: 1 }] : q.dir === '/apps/RuyixApp' ? [{ fs_id: 700, path: '/apps/RuyixApp/寒流', server_filename: '寒流', isdir: 1 }] : [] })
  if (url.pathname === '/rest/2.0/xpan/multimedia' && q.method === 'listall') return send({ errno: 0, has_more: 0, cursor: 2, list: [{ fs_id: 21, path: '/剧/寒流/第1集.mp4', server_filename: '第1集.mp4', size: 5, isdir: 0 }, { fs_id: 20, path: '/剧/寒流/花絮', isdir: 1 }, { fs_id: 22, path: '/剧/寒流/花絮/第2集.mp4', server_filename: '第2集.mp4', size: 4, isdir: 0 }] })
  if (url.pathname === '/rest/2.0/xpan/multimedia' && q.method === 'filemetas') return send({ errno: 0, list: JSON.parse(q.fsids).map(id => ({ fs_id: id, filename: id === 21 ? '第1集.mp4' : '第2集.mp4', size: id === 21 ? 5 : 4, dlink: `${base}/file/dl?fid=f${id}` })) })
  if (url.pathname === '/rest/2.0/xpan/file' && q.method === 'create') {
    const b = Object.fromEntries(new URLSearchParams(raw.toString()))
    if (b.isdir === '1') return bd.made.includes(b.path) ? send({ errno: -8 }) : (bd.made.push(b.path), send({ errno: 0, fs_id: 700, path: b.path }))
    return send({ errno: 0, fs_id: 9000 + bd.slices.length, path: b.path, size: Number(b.size), blocks: b.block_list })
  }
  if (url.pathname === '/rest/2.0/xpan/file' && q.method === 'precreate') {
    const b = Object.fromEntries(new URLSearchParams(raw.toString()))
    bd.pre = b
    return send({ errno: 0, uploadid: `up-${b.size}`, return_type: 1, block_list: JSON.parse(b.block_list).length > 1 ? [0, 1] : [] })
  }
  if (url.pathname === '/rest/2.0/pcs/superfile2') { const f = (await form()).get('file'); const bytes = Buffer.from(await f.arrayBuffer()); bd.slices.push({ path: q.path, part: Number(q.partseq), size: bytes.length, uploadid: q.uploadid }); return send({ md5: md5(bytes), request_id: 1 }) }
  if (url.pathname === '/apaas/1.0/share/set') {
    const f = await form()
    bd.share = { fsids: JSON.parse(f.get('fsid_list')), period: f.get('period'), pwd: f.get('pwd'), appid: q.appid, product: q.product }
    return bd.canShare ? send({ errno: 0, data: { link: 'https://pan.baidu.com/s/1abcd', short_url: '1abcd', pwd: f.get('pwd'), period: 7 } }) : send({ errno: 2, show_msg: '没有分享权限' })
  }
  send({ errno: 2 }, 404)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

try {
  const creds = memoryCredentials()
  const c = createConnectors({ home: mkdtempSync(join(tmpdir(), 'connectors-bd-')), creds, types: { ...TYPES, baidupan: baidupanType({ pan: base, pcs: base, oauth: base }) } })
  await c.save({ id: 'bd', type: 'baidupan', fields: { appKey: 'ak-1', appName: 'RuyixApp', appId: '123' } })
  const got = c.get('bd')
  assert.deepEqual([got.drive, got.share, got.device], [true, true, true])
  assert.ok(c.types().find(t => t.id === 'baidupan').slots.find(s => s.name === 'access').device, 'the page knows which credential a code gives')
  assert.equal((await c.test('bd')).ok, false, 'not signed in yet')
  await c.setSlot('bd', 'secretKey', 'sk-secret-123456')
  // sign in by a code: pending, then agreed
  const code = await c.deviceStart('bd')
  assert.deepEqual([code.userCode, code.verifyUrl, code.interval], ['ABCD1234', 'https://openapi.baidu.com/device', 5]); assert.ok(code.qr.startsWith('data:image/png;base64,'), 'the picture as data')
  assert.ok(!JSON.stringify(code).includes('dev-1'), 'the device code stays in the service')
  assert.equal((await c.devicePoll('bd')).state, 'pending')
  const done = await c.devicePoll('bd')
  assert.equal(done.state, 'done'); assert.deepEqual([done.test.ok, done.test.detail], [true, '测试网盘 · 会员'])
  assert.equal((await creds.get('bd')).access, 'bd-access-111111'); assert.equal((await c.devicePoll('bd')).state, 'none', 'nothing under way any more')
  // listing: the token in the query string, not in what comes back
  const top = await c.driveList('bd', '/')
  assert.deepEqual(top.items.map(x => [x.name, x.dir]), [['剧', true], ['a.mp4', false]], 'folders first')
  const files = await c.driveFiles('bd', '/剧/寒流')
  assert.deepEqual(files.map(f => [f.rel, f.size]), [['第1集.mp4', 5], ['花絮/第2集.mp4', 4]], 'every file at any depth, with its place in the folder')
  // download: through the redirect to the bytes, which get no credential; a file already there (same size) is kept
  bd.files.set('f21', Buffer.from('12345')); bd.files.set('f22', Buffer.from('abcd'))
  const into = mkdtempSync(join(tmpdir(), 'connectors-bd-dl-'))
  const notes = []
  const dl = await c.driveDownload('bd', files, into, { by: 'r1:fetch', note: x => notes.push(x) })
  assert.deepEqual(dl.map(x => [x.name, x.size, !!x.kept]), [['第1集.mp4', 5, false], ['第2集.mp4', 4, false]])
  assert.equal(readFileSync(join(into, '花絮', '第2集.mp4'), 'utf8'), 'abcd', 'its place in the folder kept')
  assert.ok(bd.uas.every(u => u.ua === 'pan.baidu.com'), 'the platform\'s user agent'); assert.ok(bd.uas.filter((_, i) => i % 2).every(u => u.token === null), 'the bytes\' address gets no token')
  assert.deepEqual(notes, ['下载 第1集.mp4', '下载 花絮/第2集.mp4'])
  const again = await c.driveDownload('bd', files.slice(0, 1), into)
  assert.equal(again[0].kept, true, 'the same size there: kept')
  assert.equal(localPath(into, '../../etc/passwd'), join(into, 'etc', 'passwd'), 'nothing climbs out of the folder')
  // the token runs out: renewed with the refresh token (GET), the new one used
  await creds.set('bd', 'expiresAt', '1')
  await c.driveList('bd', '/')
  assert.equal((await creds.get('bd')).access, 'bd-access-333333'); assert.equal((await creds.get('bd')).refresh, 'bd-refresh-444444')
  // upload: into the app's folder, in 4 MB slices
  const dir = mkdtempSync(join(tmpdir(), 'connectors-bd-up-'))
  writeFileSync(join(dir, 'big.mp4'), BIG); writeFileSync(join(dir, 'small.jpg'), 'img')
  const up = await c.driveUpload('bd', [{ path: join(dir, 'big.mp4'), name: '推广片:高光.mp4' }, { path: join(dir, 'small.jpg') }], '寒流')
  assert.equal(up.dir.path, '/apps/RuyixApp/寒流'); assert.deepEqual(up.files.map(f => [f.name, f.size]), [['推广片 高光.mp4', BIG.length], ['small.jpg', 3]])
  assert.deepEqual(bd.slices.map(s => [s.part, s.size]), [[0, 4 * 1024 * 1024], [1, 10], [0, 3]], 'the slices the drive asked for (a small file: one)')
  assert.ok(bd.slices.every(s => s.uploadid.startsWith('up-')))
  // share: refused (not an enterprise developer) — the files are up, where they are is said
  const sh = await c.share('bd', [{ path: join(dir, 'small.jpg') }], { folder: '寒流', expireDays: 7, password: 'AB12' })
  assert.equal(sh.manual, true); assert.equal(sh.url, ''); assert.match(sh.place, /^我的应用数据\/RuyixApp\/寒流-[0-9a-f-]{36}$/); assert.match(sh.why, /没有分享权限|errno 2/)
  assert.ok(/^[0-9a-z]{4}$/.test(bd.share.pwd), 'a code Baidu takes (4 lower-case letters or digits)'); assert.deepEqual([bd.share.fsids, bd.share.appid, bd.share.product], [['700'], '123', 'netdisk'], 'this share has its own newly-created folder')
  bd.canShare = true
  const firstShareFolder = bd.made.at(-1)
  const sh2 = await c.share('bd', [{ path: join(dir, 'small.jpg') }], { folder: '寒流', expireDays: 30, password: 'ab12' })
  assert.notEqual(bd.made.at(-1), firstShareFolder, 'the next share uses a separate folder')
  assert.deepEqual([sh2.url, sh2.password, sh2.expireDays, !!sh2.manual], ['https://pan.baidu.com/s/1abcd', 'ab12', 30, false])
  // nothing secret in the audit or in what was shown
  const audit = JSON.stringify(c.audit('bd', 200))
  for (const v of ['bd-access-111111', 'bd-access-333333', 'bd-refresh-222222', 'sk-secret-123456', 'dev-1']) assert.ok(!audit.includes(v), `audit holds ${v}`)
  assert.ok(c.audit('bd', 200).some(a => a.method === 'GET' && /\(download\)/.test(a.path)) && c.audit('bd', 200).some(a => a.method === 'DEVICE'))
  const res = await c.client('bd').request('/rest/2.0/xpan/nas?method=uinfo')
  assert.ok(!res.url.includes('access_token'), 'the address shown has no token')
  await assert.rejects(c.driveList('nope', '/'), () => true)
  assert.ok(!existsSync(join(into, '第1集.mp4.part')))
  void statSync
} finally { server.close() }
console.log('baidu check: ok')

for(const oldResult of ['expired','success']){
  const { rmSync }=await import('node:fs')
  const home=mkdtempSync(join(tmpdir(),'ruyix-device-generation-')),creds=memoryCredentials()
  let starts=0,releaseOld,approved=false,slowStart=false,releaseStart,holdOther,releaseOther
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})
  const code=n=>reply({device_code:`dev-${n}`,user_code:`USER-${n}`,verification_url:'https://device.invalid/',expires_in:300,interval:5})
  const seen=[]
  const c=createConnectors({home,creds,types:{...TYPES,baidupan:baidupanType({pan:'https://device.invalid',pcs:'https://device.invalid',oauth:'https://device.invalid'})},fetch:async url=>{
    const u=new URL(url),q=u.searchParams
    if(u.pathname==='/oauth/2.0/device/code'){const n=++starts;if(slowStart){slowStart=false;return new Promise(r=>{releaseStart=()=>r(code(n))})}return code(n)}
    if(u.pathname==='/oauth/2.0/token'){
      const device=q.get('code');seen.push(device)
      if(device===holdOther)return new Promise(r=>{releaseOther=()=>r(reply({access_token:'obsolete-after-edit',refresh_token:'old-refresh',expires_in:300}))})
      if(device==='dev-1')return new Promise(r=>{releaseOld=()=>r(oldResult==='success'?reply({access_token:'obsolete-token',refresh_token:'old-refresh',expires_in:300}):reply({error:'expired_token'},400))})
      return approved?reply({access_token:'latest-token',refresh_token:'new-refresh',expires_in:300}):reply({error:'authorization_pending'},400)
    }
    return reply({errno:0,netdisk_name:'local fixture'})
  }})
  try{
    await c.save({id:'bd',type:'baidupan',fields:{appKey:'key',appName:'App',appId:'123'}});await c.setSlot('bd','secretKey','local-secret')
    await c.deviceStart('bd');const old=c.devicePoll('bd')
    while(!releaseOld)await new Promise(r=>setTimeout(r,0))
    assert.equal((await c.deviceStart('bd')).userCode,'USER-2');releaseOld();assert.equal((await old).state,'stale')
    assert.ok(!(await creds.get('bd')).access,'an obsolete success cannot write credentials')
    assert.equal((await c.devicePoll('bd')).state,'pending');assert.equal(seen.at(-1),'dev-2')
    approved=true;assert.equal((await c.devicePoll('bd')).state,'done');assert.equal((await creds.get('bd')).access,'latest-token')
    // A slower earlier code request cannot replace the newer request's result either.
    approved=false;slowStart=true;const earlier=c.deviceStart('bd')
    while(!releaseStart)await new Promise(r=>setTimeout(r,0))
    assert.equal((await c.deviceStart('bd')).userCode,'USER-4');releaseStart();assert.equal((await earlier).state,'stale')
    assert.equal((await c.devicePoll('bd')).state,'pending');assert.equal(seen.at(-1),'dev-4')
    // Starting a new generation waits for an already-owned credential commit to finish all slots.
    const originalSet=creds.set
    let releaseCommit
    creds.set=async(id,slot,value)=>{if(slot==='access'&&value==='latest-token')await new Promise(r=>{releaseCommit=r});return originalSet(id,slot,value)}
    approved=true;const committing=c.devicePoll('bd')
    while(!releaseCommit)await new Promise(r=>setTimeout(r,0))
    const next=c.deviceStart('bd')
    await new Promise(r=>setTimeout(r,0));assert.equal(starts,4,'a new generation cannot interleave the old token slots')
    releaseCommit();await committing;creds.set=originalSet
    assert.equal((await next).userCode,'USER-5')
    holdOther='dev-5';releaseOther=null;const duringEdit=c.devicePoll('bd')
    while(!releaseOther)await new Promise(r=>setTimeout(r,0))
    await c.save({id:'bd',type:'baidupan',fields:{appKey:'key',appName:'Changed',appId:'123'}})
    releaseOther();assert.equal((await duringEdit).state,'stale');assert.equal((await creds.get('bd')).access,'latest-token')
    await c.deviceStart('bd');holdOther='dev-6';releaseOther=null;const duringRemoval=c.devicePoll('bd')
    while(!releaseOther)await new Promise(r=>setTimeout(r,0))
    await c.remove('bd');releaseOther();assert.equal((await duringRemoval).state,'stale');assert.ok(!(await creds.get('bd')).access,'a removed connection never regains tokens from a late poll')
    await c.save({id:'bd',type:'baidupan',fields:{appKey:'key',appName:'App',appId:'123'}});await c.setSlot('bd','secretKey','local-secret');await c.setSlot('bd','access','existing-token')
    await c.deviceStart('bd');holdOther='dev-7';releaseOther=null;const duringClear=c.devicePoll('bd')
    while(!releaseOther)await new Promise(r=>setTimeout(r,0))
    await c.clearSlot('bd','access');releaseOther();assert.equal((await duringClear).state,'stale');assert.ok(!(await creds.get('bd')).access,'clearing a credential cannot be undone by a late device response')


  }finally{rmSync(home,{recursive:true,force:true})}
}