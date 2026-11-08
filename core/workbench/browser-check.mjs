// A run's browsers (lib/browser.js) in a real headless Chromium, on a local page: opened with a site's cookies, its
// frames, the person's click and typing, a moment into the ledger, closed; HTML made into a PNG. Skipped where the UI
// runtime (Playwright) is not installed. No network.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cookiesFor, createBrowsers } from './lib/browser.js'

assert.deepEqual(cookiesFor([{ name: 'a', value: '1', domain: '.x.com', path: '/', expires: -1, sameSite: 'Lax', extra: 1 }, { name: 'b', value: '2' }, { nope: 1 }], 'https://x.com/a'),
  [{ name: 'a', value: '1', path: '/', domain: '.x.com', sameSite: 'Lax' }, { name: 'b', value: '2', path: '/', url: 'https://x.com/a' }], 'what a context takes, nothing else')

const runtime = [process.env.RUYIX_UI_RUNTIME, join(homedir(), '.ruyix/workbench/ui-runtime'), join(homedir(), '.aviary/workbench/ui-runtime')].find(d => d && existsSync(join(d, 'node_modules', 'playwright')))
if (!runtime) console.log('browser check: skipped — no Playwright here')
else {
  const server = createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    s.end(`<!doctype html><meta charset="utf-8"><body style="margin:0"><input id="t" style="position:absolute;left:10px;top:10px;width:300px;height:30px"><p id="c">${q.headers.cookie || 'no cookie'}</p><a id="l" href="/next" style="position:absolute;left:10px;top:80px">next</a></body>`)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/form`
  const kept = []
  const b = createBrowsers({ runtimeDir: runtime, record: (run, e) => { kept.push({ run, ...e }); return { seq: kept.length } } })
  try {
    const { id, page, session } = await b.open({ run: 'r1', stage: 'approval', title: 'test', url, cookies: [{ name: 'sid', value: 'abc', domain: '127.0.0.1', path: '/' }] })
    assert.equal(await page.innerText('#c'), 'sid=abc', 'the site sees the session it was handed')
    const st = b.state(id)
    assert.equal(st.status, 'open')
    assert.match(st.frame, /^data:image\/jpeg;base64,/)
    assert.equal(b.state(id, { since: st.seq }).frame, undefined, 'no frame the page has already')
    // the person clicks the field and types; then follows the link
    await b.input(id, { type: 'click', x: 50, y: 25 })
    const after = await b.input(id, { type: 'text', text: '你好 hi' })
    assert.ok(after.seq > st.seq && after.frame)
    assert.equal(await page.inputValue('#t'), '你好 hi')
    await b.input(id, { type: 'key', key: 'Enter' })
    await assert.rejects(b.input(id, { type: 'key', key: 'F12' }), { code: 'badInput' }, 'only the keys a page needs')
    await b.input(id, { type: 'click', x: 20, y: 88 })
    await page.waitForURL(/\/next$/)
    b.step(id, 'filling in')
    assert.equal(b.state(id).step, 'filling in')
    session.done = { text: 'done' }
    assert.deepEqual(b.state(id).done, { text: 'done' })
    // a moment kept: a PNG in the run's ledger
    await b.shot(id, 'the form, filled')
    assert.equal(kept[0].run, 'r1')
    assert.ok(Buffer.isBuffer(kept[0].full) && kept[0].full.subarray(1, 4).toString() === 'PNG')
    assert.deepEqual(b.list('r1').map(x => x.id), [id])
    await b.close(id, 'done here')
    assert.equal(b.state(id).status, 'closed')
    await assert.rejects(b.input(id, { type: 'click', x: 1, y: 1 }), { code: 'noBrowser' })
    // three at a time
    const three = await Promise.all([1, 2, 3].map(() => b.open({ run: 'r2', url })))
    await assert.rejects(b.open({ run: 'r2', url }), { code: 'browserBusy' })
    for (const x of three) await b.close(x.id)
    // HTML into a PNG of the size asked
    const png = await b.render({ html: '<div style="width:100%;height:100%;background:#d4380d">卡片</div>', width: 120, height: 160, scale: 2 })
    assert.equal(png.readUInt32BE(16), 240)
    assert.equal(png.readUInt32BE(20), 320)
    console.log('browser check: ok')
  } finally { await b.dispose(); server.close() }
}

// The launch can finish after the run closes: late handles are disposed and cannot revive it.
{
  let ready, closed=0
  const launched=new Promise(r=>{ready=r}), fake={close:async()=>{closed++},newContext:async()=>assert.fail('closed while launching')}
  const b=createBrowsers({load:()=>({chromium:{launch:()=>launched}})})
  const pending=b.open({run:'closed-run'});const refused=assert.rejects(pending,{code:'noBrowser'})
  await b.closeRun('closed-run');ready(fake);await refused
  assert.equal(closed,1);assert.equal(b.list('closed-run')[0].status,'closed');await b.dispose()
}
// Reservations count toward the limit even before Chromium starts.
{
  let ready
  const launched=new Promise(r=>{ready=r}), b=createBrowsers({load:()=>({chromium:{launch:()=>launched}})})
  const opened=[1,2,3].map(i=>b.open({run:'pending'+i}));const settled=Promise.allSettled(opened)
  await assert.rejects(b.open({run:'fourth'}),{code:'browserBusy'})
  await b.dispose();ready({close:async()=>{},newContext:async()=>assert.fail('already closed')});assert.ok((await settled).every(r=>r.status==='rejected'))
}

// No idle close while a different render still owns a page, including overlapping completions.
{
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
  const timers = new Map(), shots = [], started = []
  let now = 0, n = 0, closed = 0
  globalThis.setTimeout = (fn, delay) => { const id = ++n; timers.set(id, { fn, at: now + delay }); return id }
  globalThis.clearTimeout = id => timers.delete(id)
  const advance = ms => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn() } }
  const b = createBrowsers({ load: () => ({ chromium: { launch: async () => ({ close: async () => { closed++ }, newPage: async () => ({
    setContent: async () => {}, evaluate: async () => {}, close: async () => {},
    screenshot: () => new Promise(resolve => { shots.push(() => resolve(Buffer.from('png'))); started.shift()?.() }),
  }) }) } }) })
  const ready = () => new Promise(r => started.push(r))
  try {
    let waiting = ready(); const a = b.render({ html: 'a' }); await waiting
    waiting = ready(); const other = b.render({ html: 'b' }); await waiting
    shots.shift()(); await a; assert.equal(timers.size, 0, 'a still-busy renderer is never idle')
    shots.shift()(); await other; assert.equal(timers.size, 1)
    advance(119000)
    waiting = ready(); const c = b.render({ html: 'c' }); await waiting
    advance(2000); await Promise.resolve(); assert.equal(closed, 0)
    shots.shift()(); await c
    advance(120000); await Promise.resolve(); assert.equal(closed, 1)
  } finally { await b.dispose(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear }
}