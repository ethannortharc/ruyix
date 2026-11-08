// The Ruyix shell's Host side: the two versions the sidebar's foot shows — ours (this package's version) and the dsh
// that runs it —, what a restart would cut short (for `ruyix upgrade`), the Get started page's steps, what an agent may
// propose to change in this Ruyix (surfaces.js), and the sign-in page a browser that is not signed in gets.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLayout, writeLayout } from './bin/ruyix-plugin.mjs'
import { pickLang, signinPage } from './signin.js'
import { createConfigImporter, exportConfig, readSecrets, secretsText } from './bin/ruyix-config.mjs'
import { registerSettings } from './settings.js'
import { createChanges, surfaceTools } from './surfaces.js'
import { withLock } from './lock.js'
import { createVoice } from './voice.js'
import { createPageActions, createSystemTools, shellTools } from './system.js'
import { createNotes } from './notes.js'
import { createOpen, openTools } from './open.js'
import { sweepOpen, workOf } from './open-sweep.js'
import { cardsTool } from './cards-tool.js'
import { actionTools, createActionLog, createCallers, serveSystem, systemSockPath } from './system-serve.js'
import { createFinders, createUsage, findParts } from './find.js'
import { appManifest, touchIcon } from './app.js'

/** The running dsh's version: the @deepseek-ai/dsh package whose bin started this process ('' when not found). */
export function dshVersion(entry = process.argv[1]) {
  try {
    for (let d = dirname(realpathSync(entry)); d !== dirname(d); d = dirname(d)) {
      const f = join(d, 'package.json')
      if (!existsSync(f)) continue
      const p = JSON.parse(readFileSync(f, 'utf8'))
      if (p.name === '@deepseek-ai/dsh') return String(p.version || '')
    }
  } catch { /* not started from dsh's bin (a test) */ }
  return ''
}

export const inject = ['connection']

// The parts of this workbench: each plugin registers itself (ruyixShell.part, below) with what the shell asks of it —
// busy() (what a restart would cut short), setup() (the Get started page's steps), overview() (the home page's tiles),
// imported() (a configuration was just imported) — and what it brings (caps: { apps, workflows }; workspace(): the
// folder it works in). The shell names none of them: { id, name: { en, zh }, panel, order, optional?, busy?, setup?,
// overview?, imported?, caps?, workspace? }.

// (an open thing's kind in the words the person would use: 「终端」 finds the terminals)
const KIND_WORDS = { page: '页面 page', window: '窗口 window', app: '应用 app', term: '终端 terminal shell', web: '浏览器 网页 browser tab', file: '文件 文件夹 file folder', session: '会话 session', run: '运行 run' }

export function apply(ctx) {
  const dsh = dshVersion()
  // ours read per request: a release bumps package.json and the foot shows it without a dsh restart
  const ruyix = () => JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  // which build this is (build.mjs writes it beside client.js): { commit, built } — none for a shell never built here
  const build = () => { try { const b = JSON.parse(readFileSync(new URL('./build.json', import.meta.url), 'utf8')); return { commit: String(b.commit || ''), built: String(b.built || '') } } catch { return {} } }
  // in a nookbox box: the nookbox it runs on (its window's root says it since 0.5.7; '' before) — null on a host
  let box = { at: 0, v: null }
  const boxVersion = async () => {
    const api = process.env.NOOKBOX_API
    if (!api) return null
    if (Date.now() - box.at < 300e3) return box.v
    const v = await fetch(new URL('/v1', api), { signal: AbortSignal.timeout(3000) }).then(r => r.json()).then(j => String(j.nookbox || ''), () => '')
    box = { at: Date.now(), v }
    return v
  }
  ctx.connection.fetch.register({ path: '/api/ruyix/version', methods: ['GET'], requestBody: 'buffered', fetch: async () => Response.json({ ruyix: ruyix(), ...build(), dsh, box: await boxVersion(), boxName: process.env.NOOKBOX_API ? process.env.NOOKBOX_NAME || null : null }) })
  const profileArg = process.argv.find(a => a.startsWith('--profile='))
  const profile = profileArg?.slice('--profile='.length) || (process.argv.includes('--profile') ? process.argv[process.argv.indexOf('--profile') + 1] : '') || 'default'
  // Ruyix as an app (app.js): what "Install" / "Add to Dock" reads
  ctx.connection.fetch.register({ path: '/api/ruyix/app.webmanifest', methods: ['GET'], requestBody: 'buffered', fetch: () => new Response(JSON.stringify(appManifest()), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'max-age=3600' } }) })
  ctx.connection.fetch.register({ path: '/api/ruyix/apple-touch-icon.png', methods: ['GET'], requestBody: 'buffered', fetch: () => new Response(touchIcon(), { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } }) })
  ctx.connection.fetch.register({ path: '/api/ruyix/identity', methods: ['GET'], requestBody: 'buffered', fetch: () => Response.json({ product: 'ruyix', profile, pid: process.pid }) })
  // the one Settings page: models, keys, the platform's few settings, plugins (settings.js)
  registerSettings(ctx, { profile })

  // What this Ruyix is for — its layout's preset (~/.ruyix/layout.json; none: `default`). A part, a setup step, an
  // overview section or a sidebar entry that names presets (`for: ['…']`) shows only there. The presets come from the
  // parts that bring them (ruyixShell.preset); none yet.
  const ruyixHome = process.env.RUYIX_HOME || join(homedir(), '.ruyix')
  // a path as a person reads it: under the home as ~/…
  const shown = p => (p.startsWith(homedir() + '/') ? `~${p.slice(homedir().length)}` : p)
  const PRESET = /^[a-z][a-z0-9-]{0,31}$/
  const PALETTE = ['#0d9488', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#ca8a04', '#64748b'], COLOR = /^#[0-9a-f]{6}$/i
  const presets = new Map()
  const layout = () => {
    const own = readLayout(ruyixHome)
    const preset = PRESET.test(own.preset || '') && presets.has(own.preset) ? own.preset : 'default'
    return { preset, by: 'home', workspace: null, dashboards: presets.get(preset)?.dashboards || [], presets: [...presets.values()] }
  }
  // Who this Ruyix is, to tell several apart (browser tabs, the sidebar): a name (one given here; none: the page says
  // what it is for), the box it runs in (else the machine), a colour (given, else one of the palette
  // by the name). The box's name is asked once (its window, $NOOKBOX_API/v1/box).
  let boxName
  const boxNameOf = async () => {
    if (boxName !== undefined || !process.env.NOOKBOX_API) return boxName ?? null
    const v = await fetch(`${process.env.NOOKBOX_API.replace(/\/$/, '')}/v1/box`, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).then(j => j?.box?.name || null, () => undefined)
    if (v !== undefined) boxName = v
    return v ?? null
  }
  const identity = async l => {
    const own = readLayout(ruyixHome).identity || {}, sub = (await boxNameOf()) || hostname(), name = own.name || l.workspace || null
    const key = `${name || l.preset}|${sub}`, hash = [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
    return { name, sub, color: COLOR.test(own.color || '') ? own.color : PALETTE[hash % PALETTE.length], own: { name: own.name || '', color: own.color || '' } }
  }
  // What an agent may change in this Ruyix (surfaces.js): the sidebar's entries as the page last listed them (it says so:
  // POST /api/ruyix/surfaces), the journal of changes, the tools on every agent — which propose; the person applies.
  const entriesFile = join(ruyixHome, 'nav-entries.json')
  let navEntries = (() => { try { return JSON.parse(readFileSync(entriesFile, 'utf8')) } catch { return [] } })()
  const changes = createChanges({ home: ruyixHome, entries: () => navEntries })
  // (what the person uses most: counted from what the tools did, for find's order)
  const usage = createUsage({ file: join(ruyixHome, 'usage.json') })
  const systemTools = createSystemTools({ onUse: (name, args) => usage.note(name, args) }), pageActions = createPageActions()
  // the widgets the page last said it knows (desk_get's list), kept for a start without a page open
  const kindsFile = join(ruyixHome, 'widget-kinds.json')
  let widgetKinds = (() => { try { return JSON.parse(readFileSync(kindsFile, 'utf8')) } catch { return [] } })()
  // Settings' tabs as the page last said ([{ id, label }]: its own and the products'), with the pages (navEntries): what an
  // agent can open (ruyix:open { panel }, ruyix-settings:open { tab })
  const tabsFile = join(ruyixHome, 'settings-tabs.json')
  let settingsTabs = (() => { try { return JSON.parse(readFileSync(tabsFile, 'utf8')) } catch { return [] } })()
  // a commit another process left half done (it crashed): finished within seconds, before the boards or a page read it
  const settleTimer = setInterval(() => { changes.settle().catch(err => console.error(`ruyix: changes: ${err.message}`)) }, 2000)
  settleTimer.unref?.()
  ctx.effect?.(() => () => clearInterval(settleTimer), 'ruyix: changes settle')
  ctx.connection.fetch.register({
    path: '/api/ruyix/surfaces',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      // what the page polls: its card, and what a system tool asked of it (?after: the last action it took)
      if (request.method === 'GET') return Response.json({ v: await changes.version(), pending: await changes.pending(), actions: pageActions.since(new URL(request.url).searchParams.get('after')), lastAction: pageActions.last, boot: pageActions.boot })
      const { entries, widgets, tabs } = await request.json().catch(() => ({}))
      // the widgets the page knows (its gallery: built-in, overviews, plugins'): what the main agent's desk_get offers
      if (widgets !== undefined && entries === undefined) {
        const good = Array.isArray(widgets) && widgets.length <= 80 && widgets.every(w => /^[\w.:-]{1,80}$/.test(String(w?.type)) && JSON.stringify(w).length <= 400)
        if (!good) return Response.json({ error: 'badWidgets' }, { status: 400 })
        const next = widgets.map(w => ({ type: w.type, name: typeof w.name === 'object' && w.name ? { zh: String(w.name.zh || '').slice(0, 60), en: String(w.name.en || '').slice(0, 60) } : String(w.name || '').slice(0, 60), sizes: Array.isArray(w.sizes) ? w.sizes.filter(x => ['sm', 'md'].includes(x)) : [] }))
        if (JSON.stringify(next) !== JSON.stringify(widgetKinds)) {
          widgetKinds = next
          try { writeFileSync(`${kindsFile}.tmp`, JSON.stringify(next)); renameSync(`${kindsFile}.tmp`, kindsFile) } catch { /* kept in memory */ }
        }
        return Response.json({ ok: true })
      }
      const ok = Array.isArray(entries) && entries.length <= 100 && entries.every(e => /^[\w.:-]{1,80}$/.test(String(e?.id)) && typeof e.label === 'string' && e.label.length <= 80 && typeof e.group === 'string' && e.group.length <= 40)
      if (!ok) return Response.json({ error: 'badEntries' }, { status: 400 })
      const next = entries.map(e => ({ id: e.id, label: e.label, group: e.group, ...(e.hidden && { hidden: true }) }))
      if (JSON.stringify(next) !== JSON.stringify(navEntries)) {
        navEntries = next
        try { writeFileSync(`${entriesFile}.tmp`, JSON.stringify(next)); renameSync(`${entriesFile}.tmp`, entriesFile) } catch { /* kept in memory */ }
      }
      // (Settings' tabs come with them; a page that does not say them leaves the last ones)
      const tabsOk = Array.isArray(tabs) && tabs.length <= 40 && tabs.every(t => /^[\w.:-]{1,80}$/.test(String(t?.id)) && typeof t.label === 'string' && t.label.length <= 80)
      if (tabsOk) {
        const nextTabs = tabs.map(t => ({ id: t.id, label: t.label }))
        if (JSON.stringify(nextTabs) !== JSON.stringify(settingsTabs)) {
          settingsTabs = nextTabs
          try { writeFileSync(`${tabsFile}.tmp`, JSON.stringify(nextTabs)); renameSync(`${tabsFile}.tmp`, tabsFile) } catch { /* kept in memory */ }
        }
      }
      return Response.json({ ok: true })
    },
  })
  ctx.connection.fetch.register({
    path: '/api/ruyix/changes',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => { try {
      // the list and the page's poll carry no diffs; one change is asked for whole (?id=)
      if (request.method === 'GET') { const id = new URL(request.url, 'http://x').searchParams.get('id'); return Response.json(id ? await changes.get(id) : { changes: await changes.list(), version: await changes.version() }) }
      // the person's own buttons (the page's card, Settings → Changes): their click is the yes
      const { op, id, digest } = await request.json().catch(() => ({})), by = 'the person (ruyix page)'
      if (op === 'apply') return Response.json(await changes.apply(id, { by, digest })) // what they saw (its digest), or nothing
      if (op === 'undo') return Response.json(await changes.undo(id, { by }))
      if (op === 'restore') return Response.json(await changes.restore(id, { by }))
      if (op === 'discard') return Response.json(await changes.discard(id))
      return Response.json({ error: 'badOp' }, { status: 400 })
    } catch (err) { return Response.json({ error: err.code || 'failed', params: { message: String(err?.message || err).slice(0, 500) } }, { status: err.code ? 409 : 500 }) } },
  })
  // Ruyix's own skill pack (skills/: ruyix-desktop, how an agent changes how this desktop looks) on Agent Hub's Skills
  // page, for the pool's agents to be given; in a box `ruyix start` also links it where the agents with a shell look
  ctx.inject?.(['agentHub'], inner => inner.effect(() => inner.agentHub.registerSkillPack?.({ id: 'ruyix', title: 'Ruyix (the shell)',
    dir: fileURLToPath(new URL('./skills', import.meta.url)), version: JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version, by: 'Ruyix' }), 'ruyix: skills'))
  ctx.inject?.(['agents'], inner => {
    const tools = surfaceTools({ changes, entries: () => navEntries, home: ruyixHome }), equipped = new Map()
    const equip = agent => { if (!equipped.has(agent)) { const off = tools.map(t => agent.ctx.tools.register(t)); equipped.set(agent, () => off.forEach(d => d?.())) } }
    for (const agent of inner.agents?.list?.() || []) equip(agent)
    inner.on?.('agent/created', ({ agent }) => equip(agent))
    inner.on?.('agent/disposed', ({ agent }) => { equipped.get(agent)?.(); equipped.delete(agent) })
    inner.effect(() => () => { for (const d of equipped.values()) d(); equipped.clear() }, 'ruyix: surface tools')
  })

  const forHere = () => { const at = layout().preset; return Object.assign(x => !Array.isArray(x?.for) || x.for.includes(at), { at }) }
  // a step required only for some presets (`requiredFor: ['dev']`) is optional elsewhere: a DevOps ruyix needs no tracker
  const requiredHere = at => x => (Array.isArray(x?.requiredFor) && !x.requiredFor.includes(at) ? { ...x, required: false } : x)
  ctx.connection.fetch.register({
    path: '/api/ruyix/layout',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => { try {
      // one coherent read under the lock (no commit of another process seen half way): the box's name asked before it
      if (request.method === 'GET') { await boxNameOf(); return Response.json(await withLock(ruyixHome, async () => { const l = layout(); return { ...l, identity: await identity(l), palette: PALETTE, ...changes.pageNow(), desktopFile: shown(join(ruyixHome, 'desktop.json')) } })) }
      const { preset, identity: id, desktop, widgetsBase } = await request.json().catch(() => ({}))
      // the desktop (desktop.js): the keys the person chose in Settings, written at once (an agent's go through a change)
      if (desktop !== undefined) {
        try { return Response.json({ desktop: await changes.setDesktop(desktop, widgetsBase) }) } catch (err) {
          if (err.code === 'badDesktop' || err.code === 'stale') return Response.json({ error: err.code, params: { message: err.message.slice(0, 300) } }, { status: 400 })
          throw err
        }
      }
      // the name and colour this Ruyix shows (blank: the default)
      if (id && typeof id === 'object') {
        const name = String(id.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40), color = String(id.color ?? '')
        if (color && !COLOR.test(color)) return Response.json({ error: 'badColor' }, { status: 400 })
        await writeLayout(ruyixHome, l => ({ ...l, identity: { ...(name && { name }), ...(color && { color }) } }))
        const l = layout()
        return Response.json({ ...l, identity: await identity(l), palette: PALETTE })
      }
      if (!PRESET.test(String(preset || '')) || !presets.has(preset)) return Response.json({ error: 'badPreset' }, { status: 400 })
      await writeLayout(ruyixHome, l => ({ ...l, preset }))
      const l = layout()
      return Response.json({ ...l, identity: await identity(l), palette: PALETTE })
    } catch (err) { return Response.json({ error: 'failed', params: { message: String(err?.message || err).slice(0, 300) } }, { status: 500 }) } },
  })

  const parts = new Map()
  /** A plugin joins (→ how it leaves); a part with the same id replaces the one before. */
  const part = p => {
    if (!p?.id) throw new Error('a ruyix part needs an id')
    parts.set(p.id, p)
    return () => { if (parts.get(p.id) === p) parts.delete(p.id) }
  }
  // the platform's connections: the configuration's export and import read and write them
  let connectors = null
  ctx.inject(['connectors'], inner => {
    connectors = inner.connectors
    inner.effect(() => () => { connectors = null }, 'ruyix: connectors')
  })
  // voice input (voice.js): the page's recording → a speech-to-text endpoint through a connection → the words
  // voice input's speech model: of a model endpoint (dsh's providers, their keys in dsh's credential store), or a connection set before
  let dshSettings = null, dshCredentials = null
  ctx.inject(['settings'], inner => { dshSettings = inner.settings; inner.effect(() => () => { dshSettings = null }, 'ruyix: settings for voice') })
  ctx.inject(['credentials'], inner => { dshCredentials = inner.credentials; inner.effect(() => () => { dshCredentials = null }, 'ruyix: credentials for voice') })
  const dshProviders = () => { try { return dshSettings?.describe?.({ redactSecrets: true })?.find(s => s.ns === 'llm-pi-ai')?.value?.providers || {} } catch { return {} } }
  const voice = createVoice({ home: ruyixHome, connectors: () => connectors, providers: dshProviders, credentials: () => dshCredentials })
  // the main agent's system tools (system.js): the shell's own here, any plugin's through ruyixShell.systemTools
  for (const tool of shellTools({ home: ruyixHome, changes, voice, widgetKinds: () => widgetKinds, pages: () => navEntries, settingsTabs: () => settingsTabs, page: (event, detail) => pageActions.add(event, detail), notes: () => notes })) systemTools.register(tool)
  const voiceAnswer = err => Response.json({ error: err.code || 'failed', params: { message: String(err?.message || err).slice(0, 300) } }, { status: err.status || 500 })
  ctx.connection.fetch.register({
    path: '/api/ruyix/voice',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      try { return Response.json(await voice.transcribe(new Uint8Array(await request.arrayBuffer()))) } catch (err) { return voiceAnswer(err) }
    },
  })
  ctx.connection.fetch.register({
    path: '/api/ruyix/voice/config',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      try { return Response.json(request.method === 'GET' ? await voice.config() : await voice.save(await request.json().catch(() => ({})))) } catch (err) { return voiceAnswer(err) }
    },
  })

  // the desk's notes (notes.js): GET all, POST { id, text }
  const notes = createNotes({ home: ruyixHome })
  ctx.connection.fetch.register({
    path: '/api/ruyix/notes',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      try { return Response.json(request.method === 'GET' ? notes.all() : notes.save(await request.json().catch(() => ({})))) } catch (err) { return voiceAnswer(err) }
    },
  })

  // the things open on the desk (open.js, open-model.js): GET the state, POST { ops }
  const open = createOpen({ home: ruyixHome })
  // things of work that is over put away (open-sweep.js): at start, every few minutes, and when a task changes
  {
    let wb = null, hub = null
    const work = workOf({ workbench: () => wb, hub: () => hub })
    const sweep = () => { try { const ids = sweepOpen(open.state(), work); if (ids.length) open.apply({ ops: ids.map(id => ({ op: 'close', id })) }) } catch (err) { ctx.logger?.warn?.(`ruyix: putting away what is over: ${err.message}`) } }
    ctx.inject?.(['ruyixWorkbench'], inner => { wb = inner.ruyixWorkbench; const off = wb?.tasks?.onChange?.(() => setTimeout(sweep, 500)); inner.effect(() => () => { off?.(); wb = null }, 'ruyix: tasks for the open things') })
    ctx.inject?.(['agentHub'], inner => { hub = inner.agentHub; inner.effect(() => () => { hub = null }, 'ruyix: sessions for the open things') })
    ctx.effect(() => { const first = setTimeout(sweep, 30000), timer = setInterval(sweep, 10 * 60e3); return () => { clearTimeout(first); clearInterval(timer) } }, 'ruyix: putting away what is over')
  }
  for (const tool of openTools({ open, page: (event, detail) => pageActions.add(event, detail) })) systemTools.register(tool)
  // an answer shown as cards (cards-tool.js; the conversation draws them): the weather, a link to open, a choice to click
  systemTools.register(cardsTool())
  // the whole Ruyix as one MCP server for every agent (docs/design/agent-control.md): the system tools over a socket of
  // this user's; what agents did with them on record (actions_list / action_undo)
  const callers = createCallers(), actions = createActionLog({ home: ruyixHome })
  for (const tool of actionTools({ tools: systemTools, actions })) systemTools.register(tool)
  let systemSock = null
  ctx.effect(() => {
    try { mkdirSync(ruyixHome, { recursive: true }); systemSock = systemSockPath(ruyixHome) } catch (err) { ctx.logger?.warn?.(`ruyix: no socket for the system tools: ${err.message}`); return () => {} }
    const stop = serveSystem({ tools: systemTools, callers, actions, sock: systemSock, log: m => ctx.logger?.warn?.(m) })
    return () => { stop(); systemSock = null }
  }, 'ruyix: the system tools for every agent')
  const systemMcpBin = fileURLToPath(new URL('./bin/ruyix-mcp.mjs', import.meta.url))
  // finding things by what they are for (find.js): what can be done, and what there is — each plugin adds its kinds
  const finders = createFinders({ boost: id => usage.boost(id) })
  {
    const { abilities, tool } = findParts({ finders, tools: systemTools })
    finders.register(abilities)
    systemTools.register(tool)
    finders.register({
      kind: 'open', title: { zh: '打开着的', en: 'Open now' },
      find: () => open.state().items.map(x => ({ id: x.id, title: x.title, hint: x.hint && !/^https?:/.test(x.hint) ? `${x.kind} · ${x.hint}` : x.kind, text: `${x.hint || ''} ${KIND_WORDS[x.kind] || ''}`, at: x.usedAt, how: `open_focus { id: "${x.id}" }` })),
    })
    // the pages and Settings' tabs, as the page last said them
    finders.register({
      kind: 'page', title: { zh: '页面和设置', en: 'Pages and settings' },
      find: () => [
        ...navEntries.map(p => ({ id: p.id, title: p.label, hint: p.group || 'page', text: `${p.id} 页面 page`, how: `open_page { page: "${p.id}" }` })),
        ...settingsTabs.map(t => ({ id: `settings:${t.id}`, title: `设置 · ${t.label}`, hint: 'Settings', text: `${t.id} 设置 settings`, how: `open_settings { tab: "${t.id}" }` })),
      ],
    })    // the desk's widgets there are (as the page last said them: built-in, overviews, plugins'), on the desk already or not
    finders.register({
      kind: 'widget', title: { zh: '小组件', en: 'Widgets' },
      find: () => {
        let on = []
        try { on = (JSON.parse(readFileSync(join(ruyixHome, 'desktop.json'), 'utf8')).widgets || []).map(w => w.type) } catch { /* the default set */ }
        return widgetKinds.map(k => {
          const zh = typeof k.name === 'string' ? k.name : k.name?.zh || k.type, en = typeof k.name === 'string' ? k.name : k.name?.en || k.type
          const here = on.includes(k.type)
          return { id: k.type, title: zh, hint: `${en} · ${here ? '已在桌面上' : '小组件'}`, text: `${k.type} 小组件 widget 桌面`, how: here ? `on the desk already (desk_set { widget_remove: "${k.type}" } takes it off)` : `desk_set { widget_add: { type: "${k.type}" } }` }
        })
      },
    })
  }
  ctx.connection.fetch.register({
    path: '/api/ruyix/open',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      try { return Response.json(request.method === 'GET' ? open.state() : open.apply(await request.json().catch(() => ({})))) } catch (err) { return voiceAnswer(err) }
    },
  })

  // `ruyix upgrade` asks before it stops dsh: an empty list means nothing is at work.
  ctx.connection.fetch.register({
    path: '/api/ruyix/busy',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Response.json({ busy: [...parts.values()].flatMap(p => p.busy?.() || []) }),
  })

  // The home page's setup: the plugins' steps — each { id, order, required, ready, title: {en, zh}, detail: {en, zh},
  // panel? | open? } (open as the overview's) — in order.
  /** Every setup step, in order (the home page). */
  const setupSteps = async () => {
      const here = forHere()
      const theirs = await Promise.all([...parts.values()].filter(here).map(async p => {
        try { return (await p.setup?.() || []).filter(here).map(requiredHere(here.at)) } catch {
          // an optional part that cannot answer does not hold the setup up
          return [{ id: `${p.id}-setup-error`, order: p.order ?? 90, required: !p.optional, ready: false, panel: p.panel,
            title: { en: `${p.name?.en || p.id}: setup check`, zh: `${p.name?.zh || p.id}：设置检查` },
            detail: { en: 'Could not check setup. Open its settings, confirm the configuration, then check again.', zh: '暂时无法检查设置。打开对应设置页确认配置，再点击重新检查。' } }]
        }
      }))
      return theirs.flat().sort((a, b) => a.order - b.order)
  }
  ctx.connection.fetch.register({
    path: '/api/ruyix/setup',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json({ ruyix: ruyix(), dsh, steps: await setupSteps() }),
  })
  ctx.provide('ruyixShell', {
    part,
    /** What the main agent may do here (system.js): register(tool) → removal, list(), get(name). */
    systemTools,
    /**
     * The system tools as an MCP server for an agent Agent Hub starts — { who, title, of } (its name and its work, for
     * the record) → { name, command, args, env } (the token rides env: never a command line), or null without the socket.
     */
    systemMcp: ({ who, title, of = null } = {}) => (systemSock ? { name: 'ruyix', command: process.execPath, args: [systemMcpBin], env: { RUYIX_SYS_SOCK: systemSock, RUYIX_SYS_TOKEN: callers.mint({ who, title, of }) } } : null),
    /** Finding things by what they are for (find.js): register({ kind, title, find(query) → hits }) → removal. */
    finders,
    /** Ask the page the person looks at to dispatch a window event (e.g. open an app's window). → its id */
    pageAction: (event, detail) => pageActions.add(event, detail),
    /** The parts there are now. */
    parts: () => [...parts.values()],
    /** A layout preset a part brings: { id, name: { en, zh }, dashboards? } (→ how it leaves). */
    preset: p => {
      if (!PRESET.test(String(p?.id || '')) || p.id === 'default') throw new Error('a preset needs an id other than default')
      presets.set(p.id, p)
      return () => { if (presets.get(p.id) === p) presets.delete(p.id) }
    },
    setup: setupSteps,
    /** What this Ruyix is for: { preset, by: 'home', workspace: null, dashboards, presets }. */
    layout,
    importConfig: (config, secrets = {}) => importNow(config, secrets),
    /** The personal boards (surfaces.js), read together and never half written. */
    personalBoards: () => changes.boards(),
    exportConfig: async () => (await exportConfig({ connectors })).config,
  })
  // The home page's overview: each plugin's sections of tiles —
  // { id, order, title: {en, zh}, sub?, more?: { label, open }, tiles: [{ id, value, label: {en, zh}, tone?, open? }] }, where
  // open is { panel } or { event, detail } (a window event its page answers). A plugin that fails is left out.
  ctx.connection.fetch.register({
    path: '/api/ruyix/overview',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const here = forHere(), theirs = await Promise.all([...parts.values()].filter(here).map(p => Promise.resolve(p.overview?.()).catch(() => null)))
      return Response.json({ sections: theirs.flat().filter(Boolean).filter(here).sort((a, b) => a.order - b.order) })
    },
  })
  // One configuration file (ruyix config export / import) from the home page. The file never carries a value; the values
  // file only when asked for. In a nookbox box the values are the box's placeholders — the real ones are on the host,
  // set with nookbox up --config … --secrets … — so there are none to export.
  const inBox = !!process.env.NOOKBOX_API
  /** Apply a configuration now: the files, then Agent Hub's agents and the connections (not at the next start). */
  const importNow = createConfigImporter({ parts: () => parts.values(), connectors: () => connectors })

  ctx.connection.fetch.register({
    path: '/api/ruyix/config',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        if (request.method === 'GET') {
          const values = new URL(request.url, 'http://ruyix.invalid').searchParams.get('values') === '1' && !inBox
          const { config, secrets, skipped } = await exportConfig({ connectors, values })
          return Response.json({ config, inBox, skipped, ...(values && { secrets: secretsText(secrets) }) })
        }
        const { config, secrets } = await request.json()
        return Response.json({ report: await importNow(typeof config === 'string' ? JSON.parse(config) : config, secrets ? readSecrets(String(secrets)) : {}) })
      } catch (err) {
        return Response.json({ error: err?.message || String(err) }, { status: 400 })
      }
    },
  })

  // A browser that is not signed in: the sign-in page instead of dsh's line of plain text. dsh leaves no seat for it,
  // so this replaces the one method that writes that answer (its browser auth's writeUnauthorized) while the shell runs.
  // ponytail: reaches into dsh's connection internals; a dsh that renames them simply shows its own text again.
  ctx.effect(() => {
    const auth = ctx.connection.browserAuth
    if (typeof auth?.writeUnauthorized !== 'function') return
    const original = auth.writeUnauthorized
    const writer = (req, res) => {
      const url = new URL(req.url ?? '/', 'http://ruyix.invalid')
      res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' })
      res.end(req.method === 'HEAD' ? undefined : signinPage({ lang: pickLang(url, req.headers['accept-language']), failed: url.searchParams.has('token') }))
    }
    auth.writeUnauthorized = writer
    return () => { if (auth.writeUnauthorized === writer) auth.writeUnauthorized = original }
  }, 'ruyix: sign-in page')
}
