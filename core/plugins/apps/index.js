// Host half of the App Center: Linux software for the box this Ruyix runs in. The catalog (lib/catalog.js), what is
// installed (dpkg-query, no root needed), installing through nookbox (lib/install.js: one apt run at a time, a job the
// page polls), graphical apps on virtual displays of their own (lib/display.js) and the WebSocket that carries a
// display to the browser (lib/ws.js, at /ruyix-apps/vnc?s=<session>, behind dsh's own sign-in); terminals drawn in
// the page (lib/term.js: a pseudo-terminal running tmux or zellij, at /ruyix-apps/term?app=<id>, behind the sign-in too).
// POST /api/ruyix-apps { op }: catalog, state, install, uninstall, launch, stop, sessions, end.
import { CATALOG, CATEGORIES, GUI_SUPPORT, entry } from './lib/catalog.js'
import { createDisplays, onPath } from './lib/display.js'
import { coded, createInstaller, installedOf } from './lib/install.js'
import { MSG, SESSION_NAME, TERM_PATH, WINDOW_INDEX, createTerms, lookOf, parseMessage, parseSize } from './lib/term.js'
import { bridge, handshake, personInputIn, refuse, wsConnection } from './lib/ws.js'
import { CDP_PORT, browserCommand, chromiumPath, createBrowser, serveBrowser, sockPath } from './lib/browser.js'
import { createWindows, folderOf } from './lib/xwin.js'
import { createMade, madeTools } from './lib/made.js'
import { createPieces } from './lib/pieces.js'
import { spawn as nodeSpawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'

export const inject = ['connection']
export const VNC_PATH = '/ruyix-apps/vnc'
export { TERM_PATH }
const BOX_TTL = 60e3

/**
 * The upgrade route's handler: dsh's sign-in first (`admit`), then the session (its id in ?s=), then the WebSocket
 * handshake and the bridge to the session's VNC port. The open bridges are kept in `open` (closed when the plugin goes).
 */
export function vncUpgrade({ displays, admit, open = new Set(), pingMs, onInput = null }) {
  return async (req, socket, head) => {
    const a = await admit(req)
    // (anything but an admission refuses: a shape this code does not know is no sign-in)
    if (!a || typeof a !== 'object' || 'rejection' in a) { refuse(socket, a?.rejection || 403, 'Refused'); return }
    const id = new URL(req.url || '/', 'http://x').searchParams.get('s') || ''
    const s = displays.get(id)
    if (!s || s.state !== 'running') { refuse(socket, 404, 'Not Found'); return }
    const h = handshake(req)
    if (!h.response) { refuse(socket, h.status, h.reason, h.headers); return }
    socket.write(h.response)
    let off = () => {}, ws = null
    ws = bridge(socket, head, { port: s.port, pingMs, onEnd: () => { open.delete(ws); off() }, onInput: onInput && (msg => onInput(s, msg)) })
    if (ws.closed) return // (the first bytes were already a close)
    open.add(ws)
    // the session ending (the app quit, or stopped from the page) closes its display's connections at once
    off = s.onEnd(() => ws.close(1000, 'the app has closed'))
  }
}

/**
 * The terminal's upgrade route: dsh's sign-in first, then the app (?app=, a `term` app whose multiplexer is here), the
 * size (?cols=&rows=) and the look (?tone=&bg=&fg=&muted=&line=&accent=, the page's colours), then the WebSocket and a
 * terminal tied to it (lib/term.js). Keys the page sent while the terminal was starting are passed on once it runs.
 */
export function termUpgrade({ terms, admit, open = new Set(), pingMs }) {
  return async (req, socket, head) => {
    const a = await admit(req)
    // (a shell behind it: anything but an admission refuses)
    if (!a || typeof a !== 'object' || 'rejection' in a) { refuse(socket, a?.rejection || 403, 'Refused'); return }
    const q = new URL(req.url || '/', 'http://x').searchParams
    const app = entry(q.get('app') || '')
    if (!app || app.kind !== 'term' || !terms.available(app)) { refuse(socket, 404, 'Not Found'); return }
    const h = handshake(req)
    if (!h.response) { refuse(socket, h.status, h.reason, h.headers); return }
    socket.write(h.response)
    let view = null
    const early = []
    const take = m => {
      if (m.kind === MSG.DATA) view.keys(m.body)
      else if (m.kind === MSG.CONTROL) { const s = parseSize(m.body); if (s) view.size(s.cols, s.rows) }
    }
    const ws = wsConnection(socket, head, {
      pingMs,
      onMessage: msg => { const m = parseMessage(msg); if (m) (view ? take(m) : early.push(m)) },
      onClose: () => { open.delete(ws); view?.close() },
    })
    if (ws.closed) return
    open.add(ws)
    try {
      // (a session other than its own and a window of it: an agent session's mirror, a session the person made)
      const at = { ...(q.get('session') && { session: q.get('session') }), ...(q.get('window') && { window: q.get('window') }) }
      view = await terms.open(app, ws, { ...(parseSize(`${q.get('cols')} ${q.get('rows')}`) || {}), look: lookOf(Object.fromEntries(q)), ...at })
    } catch (err) {
      ws.close(1011, `the terminal did not start: ${String(err?.message || err).slice(0, 80)}`)
      return
    }
    if (ws.closed) { view.close(); return }
    for (const m of early.splice(0)) take(m)
  }
}

export function apply(ctx, _config, { env = process.env, displays: given, terms: givenTerms, windows: givenWindows, execFile, installTimeoutMs } = {}) {
  const log = text => ctx.logger?.info?.(text)
  const base = () => env.NOOKBOX_API || ''
  const ruyixHome = env.RUYIX_HOME || join(homedir(), '.ruyix')
  // the fonts there are, read again (-f: a cache whose directory times did not move is otherwise trusted): the home's fontconfig cache outlives the image (a new image's fonts, or those an
  // install brought, are otherwise not seen and an app falls back to another font) — at start and after each install
  const fonts = () => { if (base() && onPath('fc-cache', env)) (execFile || nodeExecFile)('fc-cache', ['-f'], { timeout: 120000 }, () => {}) }
  // an install the person asked for in the conversation: a piece of that request, its end said there (lib/pieces.js)
  let wbTasks = null
  const pieces = createPieces({ tasks: () => wbTasks, log, home: ruyixHome })
  ctx.inject?.(['ruyixWorkbench'], inner => { wbTasks = inner.ruyixWorkbench?.tasks || null; pieces.recover(); inner.effect(() => () => { wbTasks = null }, 'apps: the person\'s tasks') })
  ctx.effect?.(() => () => pieces.dispose(), 'apps: pending install tasks')
  const installer = createInstaller({ base, timeoutMs: installTimeoutMs, log, onChange: job => { if (job?.state === 'done') fonts(); pieces.end(job) } })
  fonts()
  const displays = given || createDisplays({ env, log })
  // ── the agents' browser (lib/browser.js): a display session like any app's in a box; outside one (a Mac), headless ──
  const BROWSER = entry('agent-browser')
  const browserApp = () => { const bin = chromiumPath({ env }); return bin && { ...BROWSER, command: browserCommand(bin, { profile: join(ruyixHome, 'browser'), env }) } }
  const playwrightFrom = [env.RUYIX_UI_RUNTIME, join(ruyixHome, 'workbench', 'ui-runtime')].find(d => d && existsSync(join(d, 'node_modules', 'playwright')))
  let headless = null
  const browser = createBrowser({
    home: ruyixHome, log,
    alive: async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(800) })).ok } catch { return false } },
    start: async () => {
      const app = browserApp()
      if (!app) throw coded('noChromium', 'the box has no Chromium for the agents\' browser (Playwright\'s)')
      if (onPath('Xvnc', env) && onPath('matchbox-window-manager', env)) return displays.launch(app, { pixels: 1, zoom: 1, tone: 'light' })
      if (!headless || headless.exitCode !== null) headless = nodeSpawn(app.command[0], ['--headless=new', ...app.command.slice(1), 'about:blank'], { stdio: 'ignore', detached: false })
    },
    onChange: () => { for (const f of browserSubs) { try { f() } catch { /* a listener's own */ } } },
  })
  const browserSubs = new Set()
  let unserve = () => {}, sock = null
  try { mkdirSync(ruyixHome, { recursive: true }); sock = sockPath(ruyixHome); unserve = serveBrowser(browser, sock, { log }) } catch (err) { log(`apps: the agents' browser's socket: ${err.message}`) }
  ctx.effect?.(() => () => { unserve(); browser.dispose(); headless?.kill() }, 'apps: the agents\' browser')
  /**
   * The agents' browser for other plugins (Agent Hub's agents, the workbench's steps): its tools as an MCP server for a CLI
   * agent (null: no Chromium or no Playwright here), and the service itself (ensure, waitTurn, give, handoff, state…).
   */
  const browserService = {
    ...browser,
    available: () => !!(browserApp() && playwrightFrom),
    /** { who, title, of, dirs } → { name, command, args, env } for the agent's CLI, or null */
    mcp: ({ who, title = who, of = null, dirs = [] } = {}) => (sock && browserApp() && playwrightFrom ? {
      name: 'ruyix-browser', command: process.execPath, args: [fileURLToPath(new URL('./browser-mcp.mjs', import.meta.url))],
      env: { RUYIX_BROWSER_SOCK: sock, RUYIX_BROWSER_WHO: String(who), RUYIX_BROWSER_TITLE: String(title).slice(0, 120), ...(of && { RUYIX_BROWSER_OF: String(of) }), RUYIX_BROWSER_DIRS: dirs.filter(Boolean).join(':'), RUYIX_PLAYWRIGHT_FROM: playwrightFrom },
    } : null),
    subscribe: f => { browserSubs.add(f); return () => browserSubs.delete(f) },
  }
  ctx.provide?.('ruyixBrowser', browserService)
  const terms = givenTerms || createTerms({ env, log, ...(execFile && { execFile }) })
  const windows = givenWindows || createWindows({ env })
  // the person's own apps, made by agents (lib/made.js)
  const made = createMade({ home: ruyixHome })
  const TERMS = CATALOG.filter(a => a.kind === 'term')

  // the box's window: its name (for the host commands) and whether its spec lets it install (self_install), asked once a minute
  let box = { at: 0, v: null }
  const boxNow = async () => {
    if (!base()) return null
    if (Date.now() - box.at < BOX_TTL && box.v) return box.v
    const j = await installer.boxInfo()
    box = { at: Date.now(), v: j && { name: j.box?.name || '', selfInstall: j.box?.spec?.self_install === true } }
    return box.v
  }

  const ALL = [...new Set([...CATALOG.flatMap(a => a.packages), ...GUI_SUPPORT])]
  const state = async () => {
    const [pk, b, term] = await Promise.all([installedOf(ALL, { ...(execFile && { execFile }) }), boxNow(), terms.state(TERMS)])
    const has = n => !!pk?.[n]
    // the display's programs: by dpkg on Debian, by PATH otherwise (a machine that has them some other way)
    const supportMissing = pk ? GUI_SUPPORT.filter(n => !has(n)) : ['Xvnc', 'matchbox-window-manager'].filter(c => !onPath(c, env))
    const jobs = installer.jobs()
    return {
      inBox: !!base(),
      box: b?.name || null,
      // known only in a box whose window answered; null: not known (the install says so if it is refused)
      canInstall: base() ? (b ? b.selfInstall : null) : false,
      dpkg: !!pk,
      // (a terminal: its multiplexer on PATH — from a package, the image, or the machine some other way)
      installed: Object.fromEntries(CATALOG.map(a => [a.id, a.kind === 'term' ? terms.available(a) : a.id === 'agent-browser' ? !!browserApp() : !!pk && a.packages.every(has)])),
      browser: browser.state(),
      support: { ready: supportMissing.length === 0, missing: supportMissing },
      jobs,
      installing: jobs.find(j => j.state === 'running') || null,
      sessions: displays.list(),
      // a terminal's session (tmux's or zellij's `main`): whether it is there, with whatever runs in it
      terms: term,
    }
  }

  const ops = {
    catalog: () => ({ apps: CATALOG, categories: CATEGORIES, support: GUI_SUPPORT }),
    state,
    /** { appId } | { support: true } (the display's packages) | { packages: [...] } (any Debian package by name) */
    install({ appId, support, packages }) {
      if (appId !== undefined) {
        const a = entry(String(appId))
        if (!a) throw coded('noApp', `no app ${appId} in the catalog`, { app: String(appId).slice(0, 60) })
        return { job: installer.add(a.packages, { appId: a.id }) }
      }
      if (support) return { job: installer.add(GUI_SUPPORT, { appId: 'support' }) }
      return { job: installer.add(packages) }
    },
    /**
     * { appId } — an app of the catalog taken out of the box again (nookbox removes what it installed, with the
     * dependencies only it needed; the person's files stay). Its packages another installed app still uses stay, and so
     * do the display's; never what the image carries (an app with no packages of its own). Its windows close first.
     */
    async uninstall({ appId }) {
      const a = entry(String(appId ?? ''))
      if (!a) throw coded('noApp', `no app ${appId} in the catalog`, { app: String(appId ?? '').slice(0, 60) })
      if (!a.packages.length || a.image) throw coded('fromImage', `${a.id} comes with the Ruyix image: it cannot be uninstalled`, { app: a.id })
      const s = await state()
      if (!s.installed[a.id]) throw coded('notInstalled', `${a.id} is not installed`, { app: a.id })
      const others = CATALOG.filter(x => x.id !== a.id && s.installed[x.id]).flatMap(x => x.packages)
      const packages = removable(a, others)
      if (!packages.length) throw coded('shared', `${a.id}'s packages are all used by other apps`, { app: a.id })
      for (const x of displays.list().filter(x => x.appId === a.id)) displays.stop(x.id)
      if (a.kind === 'term') await terms.end(a).catch(() => {})
      return { job: installer.add(packages, { appId: a.id, remove: true }) }
    },
    /** { appId, pixels?, zoom?, tone?, accent? } — how to draw it (lib/display.js drawing()): the page's screen, interface size, tone and accent */
    async launch({ appId, pixels, zoom, tone, accent }) {
      const a = entry(String(appId ?? ''))
      if (!a) throw coded('noApp', `no app ${appId} in the catalog`, { app: String(appId ?? '').slice(0, 60) })
      if (a.kind === 'term') throw coded('isTerm', `${a.id} opens in the page: its WebSocket is ${TERM_PATH}`)
      if (a.kind !== 'gui') throw coded('notGui', `${a.id} is a command-line tool: use it from a terminal or an agent`)
      if (!onPath('Xvnc', env) || !onPath('matchbox-window-manager', env)) throw coded('noDisplayServer', 'the virtual display is not installed (tigervnc-standalone-server, matchbox-window-manager)', { packages: GUI_SUPPORT.join(' ') })
      if (a.id === 'agent-browser') {
        const app = browserApp()
        if (!app) throw coded('notInstalled', 'the agents\' browser needs the box\'s Playwright Chromium', { app: a.id })
        return { session: await displays.launch(app, { pixels, zoom, tone, accent }) }
      }
      const pk = await installedOf(a.packages, { ...(execFile && { execFile }) })
      if (pk && !a.packages.every(n => pk[n])) throw coded('notInstalled', `${a.id} is not installed`, { app: a.id })
      return { session: await displays.launch(a, { pixels, zoom, tone, accent }) }
    },
    stop: ({ id }) => ({ stopped: displays.stop(String(id ?? '')) }),
    // the agents' browser: who has it, who waits; the person gives it back; what was done in it
    browserState: () => ({ browser: browser.state() }),
    /** Whether each terminal's session is running (light: no package look-up) — the desk keeps a closed one in the background. */
    terms: async () => ({ terms: await terms.state(TERMS) }),
    /** Every terminal session there is (tmux on Ruyix's server, zellij), each with its windows / tabs: the desk's open things. */
    termSessions: async () => ({ sessions: await terms.sessions(TERMS) }),
    /** The person's own apps (made by agents): [{ id, name, icon, summary, version, updatedAt }]; one with its page. */
    madeList: () => ({ apps: made.list() }),
    madeGet: ({ id, version }) => made.get(String(id || ''), { version }),
    /** The folders the file managers have open, one per window: [{ appId, session, win, folder }] — the desk's open things. */
    async fileWindows() {
      const out = []
      for (const s of displays.list().filter(x => x.state === 'running' && entry(x.appId)?.files)) {
        for (const w of await windows.list(s.display)) if (folderOf(w.name)) out.push({ appId: s.appId, session: s.id, win: w.id, folder: folderOf(w.name) })
      }
      return { windows: out }
    },
    /** One of those windows to the front of its app's display. */
    async fileWindowFocus({ session, win }) {
      const s = displays.get(String(session || ''))
      if (!s || !entry(s.appId)?.files) throw coded('noWindow', 'that window is not open any more')
      return { ok: await windows.activate(s.display, Number(win)) }
    },
    browserPersonDone: () => { browser.personDone(); return { browser: browser.state() } },
    /** The browser's tabs (who opened each, for what work) and bringing one to the front — the desk's open things. */
    browserTabs: async () => ({ tabs: await browser.tabsList() }),
    browserFocus: async ({ tab }) => ({ ok: await browser.activate(String(tab || '')) }),
    browserHistory: ({ limit } = {}) => ({ history: browser.history(Math.min(1000, Number(limit) || 200)) }),
    sessions: () => ({ sessions: displays.list() }),
    /** { appId } — a terminal's session ends, with everything running in it (its open windows say so) */
    async end({ appId }) {
      const a = entry(String(appId ?? ''))
      if (!a || a.kind !== 'term') throw coded('noApp', `no terminal ${appId} in the catalog`, { app: String(appId ?? '').slice(0, 60) })
      try { await terms.end(a) } catch (err) { throw coded('endFailed', `${a.id}: ${String(err?.stderr || err?.message || err).trim().slice(0, 200)}`, { app: a.id }) }
      return { ended: a.id }
    },
  }
  ctx.connection.fetch.register({
    path: '/api/ruyix-apps',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const { op, ...args } = await request.json()
        if (!Object.hasOwn(ops, op)) return Response.json({ error: 'unknownOp', params: { message: `unknown op ${op}` } }, { status: 400 })
        return Response.json(await ops[op](args))
      } catch (err) {
        return Response.json({ error: err?.code || 'failed', params: { ...err?.params, message: String(err?.message || err).slice(0, 500) } }, { status: err?.code ? 400 : 500 })
      }
    },
  })

  // the display's WebSocket on dsh's own web server (behind its sign-in)
  const open = new Set()
  ctx.inject?.(['connection', 'webServer'], web => {
    // (the person's input in the agents' browser's window: the agents wait for him)
    const handler = vncUpgrade({ displays, admit: req => web.connection.admit(req), open, onInput: (s, msg) => { if (s.appId === 'agent-browser' && personInputIn(msg)) browser.personInput() } })
    web.effect(() => web.webServer.registerUpgrade({ path: VNC_PATH, handler }), 'apps: vnc websocket')
    const term = termUpgrade({ terms, admit: req => web.connection.admit(req), open })
    web.effect(() => web.webServer.registerUpgrade({ path: TERM_PATH, handler: term }), 'apps: terminal websocket')
  })
  // the plugin going (dsh stopping, a reload): its apps and their displays go with it — nothing left holding a display.
  // A terminal's view closes; its session (tmux's, zellij's) stays: it is the person's, and opening again comes back to it.
  ctx.effect?.(() => () => { for (const ws of open) ws.close(1001, 'Ruyix is stopping'); displays.stopAll(); terms.stopAll() }, 'apps: sessions')

  // the main agent's tools (the shell's system tools: docs/design/main-agent.md): what is here, installing, opening a window
  ctx.inject?.(['ruyixShell'], inner => {
    const sh = inner.ruyixShell
    if (!sh?.systemTools) return
    for (const tool of [...systemTools({ ops, state, page: (event, detail) => sh.pageAction(event, detail), made, pieces }), ...madeTools({ made, page: (event, detail) => sh.pageAction(event, detail) })]) inner.effect(() => sh.systemTools.register(tool), `apps: tool ${tool.name}`)
    // found by what they do (the shell's find): installed or not — one not installed says it would be installed first
    if (sh.finders) inner.effect(() => sh.finders.register(appFinder({ state, made })), 'apps: found by what they do')
  })
  // one of Ruyix's parts: a restart would cut an install short; the home page's tiles
  ctx.inject?.(['ruyixShell'], inner => inner.effect(() => inner.ruyixShell?.part?.({
    id: 'apps', name: { en: 'App Center', zh: '应用中心' }, panel: 'ruyix-apps', order: 41, optional: true,
    busy: () => installer.busy(),
    overview: async () => {
      const s = await state().catch(() => null)
      if (!s?.dpkg) return []
      const n = Object.values(s.installed).filter(Boolean).length
      const open = { panel: 'ruyix-apps' }
      return [{ id: 'apps', order: 41, title: { en: 'Apps', zh: '应用' }, tiles: [
        { id: 'installed', value: n, tone: 'neutral', label: { en: 'Apps installed', zh: '已安装的应用' }, open },
        { id: 'running', value: s.sessions.length, tone: s.sessions.length ? 'accent' : 'neutral', label: { en: 'Apps open', zh: '正在运行的应用' }, open },
        ...(s.installing ? [{ id: 'installing', value: s.jobs.filter(j => j.state === 'queued' || j.state === 'running').length, tone: 'warning', label: { en: 'Installing', zh: '正在安装' }, open }] : []),
      ] }]
    },
  }), 'apps: ruyix part'))
}

/** What uninstalling an app takes out: its own packages, but none another installed app (`others`: their packages)
 * still uses, and none of the display's. */
export const removable = (app, others = []) => app.packages.filter(p => !others.includes(p) && !GUI_SUPPORT.includes(p))

/** An app of the catalog by its id or its name (either language, case and spaces aside). */
export const appBy = word => {
  const w = String(word || '').trim().toLowerCase().replace(/\s+/g, '')
  return entry(w) || CATALOG.find(a => [a.name.zh, a.name.en].some(n => n.toLowerCase().replace(/\s+/g, '') === w)) || null
}
const said = (zh, en) => ({ zh, en })
const toolSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

/**
 * The App Center's system tools: apps_list (read); apps_install (direct, an app of the catalog only — picked by hand;
 * undo: apps_uninstall. A Debian package by any other name is the person's to install, App Center → Install by name: a
 * page or a report an agent read could otherwise ask it for anything — Ethan, 2026-10-17); apps_uninstall (direct, an
 * app of the catalog the box installed — never the image's own; undo: apps_install; the person's files stay);
 * apps_open (direct; undo: apps_close).
 */
/** The App Center's apps for the shell's find: what each does (its summary, its category, its programs), how to use it. */
export function appFinder({ state, made = null }) {
  return {
    kind: 'app',
    title: said('应用', 'Apps'),
    async find() {
      const s = await state().catch(() => ({ installed: {} }))
      // (the person's own too: made for them)
      const own = (made?.list() || []).map(a => ({ id: `made:${a.id}`, title: a.name, hint: `${a.summary}（我做的）`, text: '我做的 小应用 my app', at: a.updatedAt, how: `apps_open { app: "made:${a.id}" } · app_edit { id: "${a.id}", html }` }))
      return [...own, ...CATALOG.map(a => ({
        id: a.id, title: `${a.name.zh} · ${a.name.en}`, hint: s.installed?.[a.id] ? a.summary.zh : `${a.summary.zh}（还没装）`,
        text: `${a.summary.en} ${a.category} ${a.kind === 'term' ? '终端 terminal shell 命令行' : a.kind === 'cli' ? '命令行 command line' : ''} ${(a.packages || []).join(' ')} ${(a.command || [])[0] || ''}`,
        how: s.installed?.[a.id] ? (a.kind === 'cli' ? `a command-line tool: run ${(a.packages || [a.id])[0]} in a session or a terminal` : `apps_open { app: "${a.id}" }`) : `apps_install { app: "${a.id}" }, then apps_open`,
      }))]
    },
  }
}

export function systemTools({ ops, state, page, made = null, pieces = null }) {
  return [
    {
      name: 'apps_list',
      title: said('看应用中心', 'The App Center'),
      effect: 'read',
      description: 'The App Center\'s apps: id, name, kind (gui: a window over VNC; term: a terminal drawn in the page; cli: a command-line tool), installed or not, open or not; installs under way; whether this box may install.',
      parameters: toolSchema({}),
      async run() {
        const s = await state()
        const open = new Set([...s.sessions.map(x => x.appId), ...Object.entries(s.terms || {}).filter(([, v]) => v.running).map(([k]) => k)])
        return { text: [
          `In a box: ${s.inBox}; may install: ${s.canInstall === null ? 'unknown' : s.canInstall}`,
          ...CATALOG.map(a => `- ${a.id} | ${a.name.en} · ${a.name.zh} | ${a.kind} | ${s.installed[a.id] ? 'installed' : 'not installed'}${open.has(a.id) ? ' | open' : ''}`),
          ...(s.jobs.length ? ['Installs:', ...s.jobs.slice(-6).map(j => `- ${j.packages.join(' ')}: ${j.state}${j.error ? ` (${j.error})` : ''}`)] : []),
        ].join('\n') }
      },
    },
    {
      name: 'apps_install',
      title: said('安装软件', 'Install software'),
      effect: 'direct',
      description: 'Install an app of the App Center\'s catalog (app: its id or name, from apps_list) into this box — only when the person asked. It takes minutes: it starts here and goes on; apps_list says when it is done. Undo: uninstall it (apps_uninstall). Software outside the catalog (a Debian package by name) is the person\'s to install: tell them the package name and where — App Center → Install by name.',
      parameters: toolSchema({ app: { type: 'string' } }, ['app']),
      async run({ app }) {
        const a = appBy(app)
        if (!a) throw new Error(`no app "${app}" in the App Center's catalog (apps_list). A Debian package by name is the person's to install: App Center → Install by name`)
        if (!a.packages.length) throw new Error(`${a.name.en} comes with the Ruyix image: nothing to install`)
        const task = pieces?.now() // (the request this is for: read before anything waits)
        if ((await state()).installed?.[a.id]) return { text: `${a.name.en} is already installed.`, summary: said(`已安装：${a.name.zh}`, `Already installed: ${a.name.en}`) }
        const { job } = ops.install({ appId: a.id })
        pieces?.start(task, job, a)
        return { text: `Installing ${a.name.en} (${a.packages.join(' ')}): ${job.state}. It takes a few minutes${task ? '; the person is told here when it is done or if it fails (it stays part of this request) — do not say it is done, and do not ask them to check' : ''}.`, summary: said(`开始安装：${a.name.zh}`, `Installing: ${a.name.en}`), undo: { tool: 'apps_uninstall', args: { app: a.id } } }
      },
    },
    {
      name: 'apps_uninstall',
      title: said('卸载软件', 'Uninstall software'),
      effect: 'direct',
      description: 'Uninstall an app of the App Center\'s catalog (app: its id or name, from apps_list) from this box — only when the person asked. Only apps the box installed (not the image\'s own); the dependencies only it needed go too, packages another installed app uses stay; the person\'s files are kept; its open windows close. It takes a minute: apps_list says when it is gone. Undo: install it again.',
      parameters: toolSchema({ app: { type: 'string' } }, ['app']),
      async run({ app }) {
        const a = appBy(app)
        if (!a) throw new Error(`no app "${app}" in the App Center's catalog (apps_list)`)
        const task = pieces?.now()
        const { job } = await ops.uninstall({ appId: a.id })
        pieces?.start(task, job, a, true)
        return { text: `Uninstalling ${a.name.en} (${job.packages.join(' ')}): ${job.state}.`, summary: said(`开始卸载：${a.name.zh}`, `Uninstalling: ${a.name.en}`), undo: { tool: 'apps_install', args: { app: a.id } } }
      },
    },
    {
      name: 'apps_open',
      title: said('打开应用', 'Open an app'),
      effect: 'direct',
      shows: true, // (it only shows something: a request that did only this is answered, not waiting for 好了)
      description: 'Open an installed app with a window (a graphical app, or a terminal) on the person\'s desktop — only when the person asked. app: its id or name (apps_list), or made:<id> for one of the person\'s own (made_list). Closing it again is its undo.',
      parameters: toolSchema({ app: { type: 'string' } }, ['app']),
      async run({ app }) {
        const mine = /^made:(.+)$/.exec(String(app || ''))
        if (mine && made) {
          const m = made.get(mine[1]).app
          page('ruyix-apps:made', { id: m.id })
          return { text: `${m.name} opens on the person's desktop.`, summary: said(`打开了：${m.name}`, `Opened: ${m.name}`), undo: { tool: 'apps_close', args: { app: `made:${m.id}` } } }
        }
        const a = appBy(app)
        if (!a) throw new Error(`no app "${app}" in the App Center (apps_list)`)
        if (a.kind === 'cli') throw new Error(`${a.name.en} is a command-line tool: it has no window`)
        if (!(await state()).installed[a.id]) throw new Error(`${a.name.en} is not installed: apps_install first`)
        page('ruyix-apps:open', { appId: a.id })
        return { text: `${a.name.en} opens on the person's desktop within a few seconds (their page asks for it).`, summary: said(`打开了：${a.name.zh}`, `Opened: ${a.name.en}`), undo: { tool: 'apps_close', args: { app: a.id } } }
      },
    },
    {
      name: 'terminal_open',
      title: said('开终端', 'Open a terminal'),
      effect: 'direct',
      shows: true, // (it only shows something: a request that did only this is answered, not waiting for 好了)
      description: 'Open a terminal window on the person\'s desk — the box\'s command line (tmux; app "zellij" for Zellij) — or one attached to a session that is there (a session of the person\'s own, or an agent session\'s window in ruyix-agents: open_list shows them as terminal rows), at one of its windows. Only when the person asked.',
      parameters: toolSchema({ app: { type: 'string', enum: ['terminal', 'zellij'] }, session: { type: 'string' }, window: { type: 'integer', minimum: 0 } }),
      async run({ app = 'terminal', session, window } = {}) {
        const a = appBy(app)
        if (!a || a.kind !== 'term') throw new Error(`"${app}" is no terminal: terminal or zellij`)
        if (!(await state()).installed[a.id]) throw new Error(`${a.name.en} is not installed: apps_install first`)
        if (session && (!SESSION_NAME.test(session) || (window != null && !WINDOW_INDEX.test(String(window))))) throw new Error('no such session (open_list shows the terminal sessions)')
        if (session && session !== 'main') page('ruyix-apps:term-at', { appId: a.id, session, ...(window != null && { window }), title: `${a.mux === 'zellij' ? 'Zellij' : 'tmux'}：${session}${window != null ? ` · ${window}` : ''}` })
        else page('ruyix-apps:open', { appId: a.id })
        const what = session && session !== 'main' ? `${a.name.zh} · ${session}` : a.name.zh
        return { text: `A terminal opens on the person's desk${session ? ` at the session ${session}` : ''}.`, summary: said(`开了终端：${what}`, `Opened a terminal: ${what}`) }
      },
    },
    {
      name: 'apps_close',
      title: said('关掉应用窗口', 'Close an app\'s window'),
      effect: 'undo',
      description: 'Close an app\'s window on the person\'s desktop (a terminal\'s session stays).',
      parameters: toolSchema({ app: { type: 'string' } }, ['app']),
      async run({ app }) {
        const mine = /^made:(.+)$/.exec(String(app || ''))
        if (mine) { page('ruyix-apps:made-close', { id: mine[1] }); return { text: `${mine[1]}'s window closes.`, summary: said(`关掉了：${mine[1]}`, `Closed: ${mine[1]}`) } }
        const a = appBy(app)
        if (!a) throw new Error(`no app "${app}"`)
        page('ruyix-apps:close', { appId: a.id })
        return { text: `${a.name.en}'s window closes.`, summary: said(`关掉了：${a.name.zh}`, `Closed: ${a.name.en}`) }
      },
    },
  ]
}

