// The agents' browser (docs/design/browser.md): one Chromium for the person and every agent — the box's Playwright
// Chromium, with a window of its own (a display session like any app's) and a profile that keeps its logins
// (~/.ruyix/browser), reached by the agents over CDP on 127.0.0.1 only. The agents take turns: a turn is a stretch of use
// (taken at an agent's first action, given back when it is done, or after two idle minutes), the others wait in order.
// The person comes first: input in its window holds the agents until he gives it back (or a minute passes). A hand-off
// leaves the last click (publishing, paying, sending, deleting) to him. An agent works in the tabs it opened; the
// person's stay his unless he hands one over. Every action goes to a history he can read (browser-history.jsonl).
// The agents' tools (browser-mcp.mjs) ask this over a Unix socket that only the box's user can open.
import { createHash, X509Certificate } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const CDP_PORT = 9333
export const IDLE_MS = 120e3, PERSON_MS = 60e3, HISTORY_MAX = 4000

/** The Playwright Chromium the box has (the workbench's live browser's): its executable, or null. */
export function chromiumPath({ env = process.env, cache = env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright') } = {}) {
  if (env.RUYIX_CHROMIUM && existsSync(env.RUYIX_CHROMIUM)) return env.RUYIX_CHROMIUM
  let dirs = []
  try { dirs = readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) } catch { return null }
  // (its folder names the platform — chrome-linux, chrome-linux64, chrome-linux-arm64 (a box on an Apple chip),
  // chrome-mac-arm64… — whatever Playwright calls it: any chrome-* with the executable in it)
  const exes = ['chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
  for (const d of dirs) {
    let subs = []
    try { subs = readdirSync(join(cache, d)).filter(x => x.startsWith('chrome-')).sort() } catch { continue }
    for (const sub of subs) for (const exe of exes) if (existsSync(join(cache, d, sub, exe))) return join(cache, d, sub, exe)
  }
  return null
}

/** Its command line: the profile that keeps logins, CDP on 127.0.0.1, the gateway's CA trusted (as Node's is, in a box). */
export function browserCommand(bin, { profile, port = CDP_PORT, env = process.env } = {}) {
  // (no bars over the page: the testing build's own notice, a "restore pages?" after it was stopped rather than closed)
  return [bin, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--disable-features=Translate,MediaRouter', '--lang=zh-CN', '--start-maximized', '--test-type', '--disable-infobars', '--hide-crash-restore-bubble',
    ...caArgs(env.NODE_EXTRA_CA_CERTS)]
}
function caArgs(file) {
  try {
    const pems = readFileSync(file, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []
    return pems.length ? ['--ignore-certificate-errors-spki-list=' + pems.map(spkiOf).filter(Boolean).join(',')] : []
  } catch { return [] }
}
function spkiOf(pem) { try { return createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64') } catch { return '' } }

const fail = (code, message) => Object.assign(new Error(message), { code })

/**
 * The service. `start()` brings the browser up (a display session, or — outside a box — a plain process); `alive()` asks
 * its CDP whether it answers. `onChange(state)` after each change (the page shows who holds it, the desk lights a
 * hand-off).
 */
export function createBrowser({ home, start, alive, port = CDP_PORT, now = Date.now, idleMs = IDLE_MS, personMs = PERSON_MS, onChange = () => {}, log = () => {} }) {
  mkdirSync(home, { recursive: true })
  const history = join(home, 'browser-history.jsonl')
  let holder = null // { who, title, of, since, last, waiting? }
  const queue = [] // [{ who, title, of, resolve, reject, at }]
  let person = null // { at } while the person holds it
  const tabs = new Map() // target id → who (an agent's own tabs; the person's are in none)
  const workOf = new Map() // who → the work it is for (run:<id>, session:<id>, task:<id>), as its turn said
  const changed = () => { try { onChange(state()) } catch { /* a listener's own trouble */ } }
  const state = () => ({
    endpoint: `http://127.0.0.1:${port}`,
    holder: holder && { who: holder.who, title: holder.title, of: holder.of || null, since: holder.since, waiting: holder.waiting || null },
    queue: queue.map(q => ({ who: q.who, title: q.title, of: q.of || null, since: q.at })),
    person: person ? { since: person.at } : null,
  })
  const pump = () => {
    if (holder || person || !queue.length) return
    const q = queue.shift()
    holder = { who: q.who, title: q.title, of: q.of, since: now(), last: now() }
    q.resolve(state().holder)
    changed()
  }
  const timer = setInterval(() => {
    if (holder && now() - holder.last > idleMs && !holder.waiting) { log(`agent browser: ${holder.who} idle — its turn given back`); holder = null; pump(); changed() }
    if (person && now() - person.at > personMs) { person = null; pump(); changed() }
  }, 5000)
  timer.unref?.()

  const api = {
    state,
    /** The browser up, its CDP answering: → its endpoint. */
    async ensure() {
      if (await alive()) return state().endpoint
      await start()
      for (let i = 0; i < 60; i++) { if (await alive()) return state().endpoint; await new Promise(r => setTimeout(r, 300)) }
      throw fail('browserDown', 'the agents\' browser did not start')
    },
    /**
     * An agent's turn: at once when it holds it (and the person does not), else when the ones before it are done.
     * → the holder; `signal` gives up waiting (code cancelled).
     */
    waitTurn({ who, title = who, of = null, signal } = {}) {
      if (!who) return Promise.reject(fail('noWho', 'a turn is someone\'s'))
      if (of) workOf.set(who, of)
      if (holder?.who === who && !person) { holder.last = now(); if (holder.waiting) { holder.waiting = null; changed() } return Promise.resolve(state().holder) }
      return new Promise((resolve, reject) => {
        const q = { who, title, of, resolve, reject, at: now() }
        // (it held the turn but the person took it: first in line again)
        if (holder?.who === who) { holder = null; queue.unshift(q) } else queue.push(q)
        signal?.addEventListener('abort', () => { const i = queue.indexOf(q); if (i >= 0) { queue.splice(i, 1); changed(); reject(fail('cancelled', 'stopped while waiting for the browser')) } }, { once: true })
        changed()
        pump()
      })
    },
    /** Done with it: the next in line gets it. */
    give(who) {
      if (holder?.who !== who) return false
      holder = null // (its tabs stay its own: its next turn goes on in them)
      pump(); changed()
      return true
    },
    /** The last click is the person's: the holder waits for him (the desk lights it). */
    handoff(who, why) {
      if (holder?.who !== who) throw fail('notYourTurn', 'only the agent using the browser hands it over')
      holder.waiting = String(why || '').slice(0, 300) || 'the last click'
      holder.last = now()
      changed()
      return state().holder
    },
    /** The person is using its window (his input): the agents wait until he gives it back, or a minute passes. */
    personInput() { const was = !!person; person = { at: now() }; if (!was) changed() },
    personDone() { if (!person) return; person = null; pump(); changed() },
    /** Tabs: the ones an agent opened are its; the person may hand it one of his. */
    own(id, who) { tabs.set(String(id), who) },
    handTab(id, who) { tabs.set(String(id), who); changed() },
    ownerOf: id => tabs.get(String(id)) || null,
    /**
     * The browser's tabs, for the desk's open things (Ethan: a tab an agent opened for a piece of work belongs with that
     * work): [{ id, title, url, who, of }] — none when the browser is not up. `fetchFn` reaches its DevTools endpoint.
     */
    async tabsList(fetchFn = globalThis.fetch) {
      if (!(await alive())) return []
      const list = await fetchFn(`${state().endpoint}/json/list`, { signal: AbortSignal.timeout(3000) }).then(r => r.json(), () => [])
      return (Array.isArray(list) ? list : []).filter(t => t?.type === 'page' && t.id && !/^(about:blank|chrome:\/\/newtab)/.test(t.url || ''))
        .map(t => { const who = tabs.get(String(t.id)) || null; return { id: String(t.id), title: String(t.title || '').slice(0, 200), url: String(t.url || '').slice(0, 2000), who, of: (who && workOf.get(who)) || null } })
    },
    /** Bring a tab to the front of the browser's window. */
    async activate(id, fetchFn = globalThis.fetch) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw fail('badTab', 'no such tab')
      const r = await fetchFn(`${state().endpoint}/json/activate/${id}`, { signal: AbortSignal.timeout(3000) })
      if (!r.ok) throw fail('noTab', 'that tab is not open any more')
      return true
    },
    tabsOf: who => [...tabs].filter(([, w]) => w === who).map(([id]) => id),
    /** One action, on record: { who, title, tool, args, url }. */
    record(e) {
      try {
        appendFileSync(history, `${JSON.stringify({ at: new Date(now()).toISOString(), ...e })}\n`)
        if (Math.random() < 0.02) trim()
      } catch { /* the record is best effort */ }
    },
    history(limit = 200) { try { return readFileSync(history, 'utf8').split('\n').filter(Boolean).slice(-limit).map(l => JSON.parse(l)) } catch { return [] } },
    dispose() { clearInterval(timer); for (const q of queue.splice(0)) q.reject(fail('cancelled', 'Ruyix is stopping')) },
  }
  const trim = () => { const lines = readFileSync(history, 'utf8').split('\n').filter(Boolean); if (lines.length > HISTORY_MAX) writeFileSync(history, `${lines.slice(-HISTORY_MAX / 2).join('\n')}\n`) }
  return api
}

/** Where the tools' socket goes: in Ruyix's home, or — a path too long for a socket (about 104 bytes) — a folder of its own (0700) in the temp. */
export function sockPath(home) {
  const own = join(home, 'browser.sock')
  return Buffer.byteLength(own) <= 100 ? own : join(mkdtempSync(join(tmpdir(), 'ruyix-browser-')), 's.sock')
}

/**
 * The tools' way in: a Unix socket (0600) speaking one JSON line each way — { id, op, … } → { id, ok, … } | { id, error, code }.
 * ops: ensure, turn ({ who, title, of } — answered when it is the asker's), give, handoff ({ why }), own ({ tab }), tabs,
 * record ({ tool, args, url }), state. The asker says who it is ({ who }) with each.
 */
export function serveBrowser(browser, sock, { log = () => {} } = {}) {
  try { rmSync(sock, { force: true }) } catch { /* not there */ }
  const peers = new Map()
  const server = createServer(conn => {
    let buf = ''
    const waits = new Set(), people = new Set()
    peers.set(conn, people)
    conn.setEncoding('utf8')
    conn.on('data', c => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let m
        try { m = JSON.parse(line) } catch { continue }
        const reply = v => { if (!conn.destroyed) conn.write(`${JSON.stringify({ id: m.id, ...v })}\n`) }
        const who = String(m.who || '')
        if (who) people.add(who)
        Promise.resolve().then(async () => {
          if (conn.destroyed) throw fail('cancelled', 'the browser tools disconnected')
          switch (m.op) {
            case 'ensure': return { endpoint: await browser.ensure() }
            case 'turn': { const ac = new AbortController(); waits.add(ac); try { return { holder: await browser.waitTurn({ who, title: m.title, of: m.of, signal: ac.signal }) } } finally { waits.delete(ac) } }
            case 'give': return { given: browser.give(who) }
            case 'handoff': return { holder: browser.handoff(who, m.why) }
            case 'own': browser.own(m.tab, who); return {}
            case 'tabs': return { tabs: browser.tabsOf(who) }
            case 'record': browser.record({ who, title: m.title, tool: m.tool, args: m.args, url: m.url }); return {}
            case 'state': return { state: browser.state() }
            default: throw fail('unknownOp', `no op ${m.op}`)
          }
        }).then(v => reply({ ok: true, ...v }), err => reply({ error: err.message, code: err.code || 'failed' }))
      }
    })
    // (an agent's tools gone — its CLI ended: whatever it waited for is given up, a turn it held goes back)
    conn.on('close', () => {
      peers.delete(conn)
      for (const ac of waits) ac.abort()
      for (const who of people) if (![...peers.values()].some(p => p.has(who))) browser.give(who)
    })
    conn.on('error', () => {})
  })
  // (it not listening is the tools' trouble only: never Ruyix's — the error is said, nothing thrown)
  server.on('error', err => log(`apps: the agents' browser's socket ${sock}: ${err.message}`))
  server.listen(sock, () => { try { chmodSync(sock, 0o600) } catch { /* the folder is the box user's already */ } })
  server.unref() // (dsh keeps the process going; a check's does not wait on it)
  return () => { server.close(); try { rmSync(sock, { force: true }) } catch { /* gone */ } }
}
