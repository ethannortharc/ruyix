// The agents' browser (lib/browser.js, browser-mcp.mjs) with a real Chromium: two agents' tools (MCP over stdio) on one
// browser — a page opened, read, filled, a step on; the publish button left to the person (refused, handed over); the
// second agent waits its turn; the person's input holds the agents; an upload only from the working folder; one's tabs
// not the other's. Skipped where there is no Playwright Chromium. Run: node browser-check.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserCommand, chromiumPath, createBrowser, serveBrowser } from './lib/browser.js'

const runtime = [process.env.RUYIX_UI_RUNTIME, join(homedir(), '.ruyix/workbench/ui-runtime'), join(homedir(), '.aviary/workbench/ui-runtime')].find(d => d && existsSync(join(d, 'node_modules', 'playwright')))
const bin = chromiumPath()
if (!runtime || !bin) { console.log(`apps browser check: skipped — no ${runtime ? 'Playwright Chromium' : 'Playwright'} here`); process.exit(0) }

const tmp = mkdtempSync(join(tmpdir(), 'ruyix-browser-'))
const port = 9300 + Math.floor(Math.random() * 300)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// a site: a form whose next step is harmless and whose last is publishing; a file chooser
const site = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (req.url.startsWith('/next')) return res.end('<title>第二步</title><h1>第二步</h1><button onclick="document.title=\'已发布\'">发布</button>')
  res.end('<title>写一条</title><form action="/next"><input name="t" placeholder="标题"><button type="button" onclick="location.href=\'/next\'">下一步</button></form><input type="file" id="f">')
}).listen(0)
await new Promise(r => site.once('listening', r))
const url = `http://127.0.0.1:${site.address().port}/`

// the service: the browser started as a plain headless process here (in a box: a display session)
let proc = null
const alive = async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })).ok } catch { return false } }
const changes = []
const browser = createBrowser({ home: tmp, port, alive, idleMs: 60000, personMs: 1500, onChange: s => changes.push(s),
  start: async () => { const [cmd, ...args] = browserCommand(bin, { profile: join(tmp, 'profile'), port }); proc = spawn(cmd, ['--headless=new', ...args, 'about:blank'], { stdio: 'ignore' }) } })
const sock = join(tmp, 'b.sock')
const stopServing = serveBrowser(browser, sock)

// an agent: its tools as its CLI runs them
const work = join(tmp, 'work'); (await import('node:fs')).mkdirSync(work)
writeFileSync(join(work, 'card.png'), 'png')
writeFileSync(join(tmp, 'secret.txt'), 'no')
function agent(who) {
  const p = spawn(process.execPath, [fileURLToPath(new URL('./browser-mcp.mjs', import.meta.url))], { env: { ...process.env, RUYIX_BROWSER_SOCK: sock, RUYIX_BROWSER_WHO: who, RUYIX_BROWSER_TITLE: who, RUYIX_BROWSER_OF: who, RUYIX_BROWSER_DIRS: work, RUYIX_PLAYWRIGHT_FROM: runtime }, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = '', n = 0
  const waits = new Map()
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); waits.delete(m.id) } })
  const rpc = (method, params) => new Promise(r => { const id = ++n; waits.set(id, r); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) })
  return {
    rpc,
    call: async (name, args = {}) => { const m = await rpc('tools/call', { name, arguments: args }); const c = m.result.content[0]; return { text: c.text, image: c.data, error: !!m.result.isError } },
    end: () => p.stdin.end(),
  }
}

try {
  const a = agent('session:a'), b = agent('session:b')
  assert.equal((await a.rpc('initialize', {})).result.serverInfo.name, 'ruyix-browser')
  assert.deepEqual((await a.rpc('tools/list', {})).result.tools.map(t => t.name).slice(0, 4), ['browser_open', 'browser_look', 'browser_click', 'browser_type'])

  // one agent: open, read, fill, a step on
  assert.match((await a.call('browser_open', { url })).text, /写一条/)
  // the desk's open things: every tab, who opened it and for what work; one brought to the front
  const listed = await browser.tabsList()
  const mine = listed.find(t => t.who === 'session:a')
  assert.deepEqual([mine?.title, mine?.of, mine?.url.startsWith(url)], ['写一条', 'session:a', true], 'its tab: its title, its work')
  assert.ok(!listed.some(t => /^about:blank/.test(t.url)), 'blank tabs left out')
  assert.equal(await browser.activate(mine.id), true)
  await assert.rejects(browser.activate('../json/close/x'), e => e.code === 'badTab')
  const look = (await a.call('browser_look')).text
  const ref = name => new RegExp(`\\[(e\\d+)\\] [^\\n]*"${name}"`).exec(look)?.[1]
  assert.ok(ref('标题') && ref('下一步'), look)
  assert.match((await a.call('browser_type', { ref: ref('标题'), text: '今天的简报' })).text, /Filled/)
  assert.match((await a.call('browser_click', { ref: ref('下一步') })).text, /第二步/)
  assert.equal(browser.state().holder.who, 'session:a')

  // the last click is the person's: refused by name, handed over (the desk shows it waiting)
  const look2 = (await a.call('browser_look')).text
  const publish = /\[(e\d+)\] [^\n]*"发布"/.exec(look2)[1]
  assert.match((await a.call('browser_click', { ref: publish })).text, /the person's to press/)
  assert.match((await a.call('browser_handoff', { why: '点「发布」：标题填好了' })).text, /Handed over/)
  assert.equal(browser.state().holder.waiting, '点「发布」：标题填好了')

  // the other agent waits its turn; its tabs are its own
  let bOpened = false
  const bOpen = b.call('browser_open', { url: `${url}next` }).then(r => { bOpened = true; return r })
  await sleep(800)
  assert.equal(bOpened, false, 'waiting while the first holds it')
  assert.deepEqual(browser.state().queue.map(q => q.who), ['session:b'])
  await a.call('browser_done')
  assert.match((await bOpen).text, /第二步/)
  assert.match((await b.call('browser_tabs')).text, /^\* \S+ \| 第二步/, 'only its own tab')
  await b.call('browser_done')
  assert.match((await a.call('browser_tabs')).text, /第二步/, 'its next turn: its tabs are still its own')
  await a.call('browser_done')

  // the person comes first: his input holds the agents, a minute (here 1.5 s) without it gives it back
  browser.personInput()
  const t0 = Date.now()
  await b.call('browser_look')
  assert.ok(Date.now() - t0 > 1000, 'the agent waited for the person')

  // uploads only from the working folder
  await b.call('browser_open', { url })
  const look3 = (await b.call('browser_look')).text
  const file = /\[(e\d+)\] input\/file/.exec(look3)[1]
  assert.match((await b.call('browser_upload', { ref: file, path: join(tmp, 'secret.txt') })).text, /not in your working folder/)
  assert.match((await b.call('browser_upload', { ref: file, path: join(work, 'card.png') })).text, /Gave/)
  assert.ok((await b.call('browser_screenshot')).image.length > 1000, 'a picture')

  // on record
  assert.deepEqual([...new Set(browser.history().map(h => h.who))], ['session:a', 'session:b'])
  assert.ok(browser.history().some(h => h.tool === 'browser_type' && h.args.text === '今天的简报'))
  a.end(); b.end()
} finally {
  stopServing(); browser.dispose(); proc?.kill(); site.close()
  await sleep(300)
  rmSync(tmp, { recursive: true, force: true })
}
console.log('apps browser check: ok')
