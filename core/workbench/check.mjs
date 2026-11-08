// The workbench's own check: the core names no domain, and a pack works through the interface alone — an end-to-end
// run on a fake Agent Hub and a temporary home: intake → an agent step → an approval step → an approved action → report,
// then cancel, failure and go-back, resume, branch, parallel, a person's workflow on `blank`, attachments, forms.
// No network, no real dsh.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'ruyix-workbench-check-'))
process.env.RUYIX_WORKBENCH_HOME = join(tmp, 'home')
const { createWorkbench, definePack } = await import('./index.js')
const { foldActivity } = await import('./lib/engine.js')
const { openStore } = await import('./lib/store.js')
const { toolsPost } = await import('./lib/mcp-client.mjs')
const { intake, report, header, subjectText, claimsText } = await import('./workflows/common.js')

// ── no domain in the core: not in the code, the pages, the skill, the README ──
const here = fileURLToPath(new URL('.', import.meta.url))
const walk = d => readdirSync(join(here, d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(join(d, e.name))) : [join(d, e.name)]))
const files = [...['index.js', 'pack.js', 'build.mjs', 'package.json', 'cordis.patch.yml', 'README.md'], ...['lib', 'workflows', 'skills', 'src', 'client', 'locale'].filter(d => existsSync(join(here, d))).flatMap(walk)].filter(f => existsSync(join(here, f)))
const DOMAIN = /social|xhs|tweet|小红书|weibo|mantis|sentry|gitlab|worktree|kubectl|docker|clickup|rework|nightly|triage|\blab\b|\bMR\b|bug ?fix|pull request/i
// (the command-line tools a step names are data about tools, not a domain: lib/toolbox.js lists them — a Docker engine, a
// gitlab backend of mise — and the lines that explain them say mise, engine or backend)
const TOOLING = /\bmise\b|\bengine\b|\bbackend\b|引擎/i
const leaks = files.flatMap(f => readFileSync(join(here, f), 'utf8').split('\n').map((l, i) => [f, i + 1, l]).filter(([g, , l]) => DOMAIN.test(l) && g.replace(/\\/g, '/') !== 'lib/toolbox.js' && !TOOLING.test(l)))
assert.deepEqual(leaks.map(([f, n, l]) => `${f}:${n} ${l.trim().slice(0, 100)}`), [], 'domain words belong in a pack, not the core')

// ── the conversations' record, on its own (lib/conversations.js) ──
await import('./conversations-check.mjs')

// ── a fake dsh: services, routes, listeners ──
const listeners = {}, routes = {}, disposers = [], provided = {}, warns = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
// A script step's folder as bash prints it, compared in one form: real, long (Windows may say RUNNER~1), and on Windows
// with forward slashes and one case (Git Bash's pwd -W gives C:/…)
const WIN = process.platform === 'win32'
const PWD = WIN ? 'pwd -W' : 'pwd -P'
const samePath = p => { const r = realpathSync.native(p); return WIN ? r.replace(/\\/g, '/').toLowerCase() : r }
// on a timeout, where the run being checked stands (its steps, their notes) — a CI log has nothing else to go on
const where = () => { try { const r = main && wb.engine.get(main); return r ? `\n  run ${r.id} ${r.status}: ${r.stages.map(s => `${s.key}=${s.status}${s.note ? ` (${String(s.note).slice(0, 300)})` : ''}`).join(', ')}` : '' } catch { return '' } }
const until = async (what, fn, ms = 8000) => {
  const t = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}${where()}`)
    await sleep(15)
  }
}

// ── the fake Agent Hub: agents are little scripts that use the tools the way agents would ──
const tasks = new Map(), members = {}
// the agents' browser (the apps plugin's service), as a workflow step sees it: there or not, its state to subscribe to
// the studios (@ruyix/studio; docs/design/studio.md): records by studio/collection/id, the runs that ended
const fakeStudio = { records: {}, ended: [], get: async (s, c, id) => fakeStudio.records[`${s}/${c}/${id}`] || null, list: (s, c) => Object.entries(fakeStudio.records).filter(([k]) => k.startsWith(`${s}/${c}/`)).map(([k, v]) => ({ id: k.split('/')[2], ...v })), onRunEnd: run => { fakeStudio.ended.push(run.id) } }
const sharedBrowserSvc = { on: false, fns: new Set(), available: () => sharedBrowserSvc.on, subscribe: fn => { sharedBrowserSvc.fns.add(fn); return () => sharedBrowserSvc.fns.delete(fn) }, emit: st => { for (const f of sharedBrowserSvc.fns) f(st) } }
let taskN = 0
const hub = {
  agentsList: new Map(),
  ensured: [],
  ensureAgents: defs => { hub.ensured.push(...defs.map(d => d.id)); for (const d of defs) if (!hub.agentsList.has(d.id)) hub.agentsList.set(d.id, d) },
  agents: () => [...hub.agentsList.values()],
  agent: id => hub.agentsList.get(id) || null,
  defaultAgent: () => hub.agentsList.get('scribe') || null,
  defaultModel: () => 'fake/model',
  // the main agent (any runtime; none: the conversation runs on the dsh model) and its small jobs' model
  mainId: null,
  mainAgent: () => hub.agentsList.get(hub.mainId) || null,
  mainModel: () => '',
  mainChosen: () => !!hub.mainId,
  setMain: async ({ agent }) => { hub.mainId = agent },
  registered: [], uses: {},
  registerSkillPack: p => { hub.registered.push(p.id); return () => { hub.registered = hub.registered.filter(x => x !== p.id) } },
  registerAgentUses: fn => { hub.uses.agents = fn; return () => {} },
  registerSkillUses: fn => { hub.uses.skills = fn; return () => {} },
  skillPackVersion: id => `v-${id}`,
  skills: async () => [{ ref: 'notes/style', name: 'style', description: 'house style', pack: 'notes' }, { ref: 'mine', name: 'mine', pack: null }],
  jobs: new Map(), started: [],
  startJob: async ({ headless, cwd, title, agents }) => {
    assert.equal(headless, true)
    assert.ok(cwd && existsSync(cwd), 'a run\'s job works in the run\'s folder, which exists when the job starts')
    assert.ok(agents.every(id => hub.agentsList.has(id)), 'a run names the pool agents it will use, checked before it starts')
    hub.started.push({ agents, cwd, title })
    const j = { id: `j${hub.jobs.size + 1}`, leadId: `lead-${hub.jobs.size + 1}`, status: 'running', cwd, title }
    hub.jobs.set(j.id, j)
    return j
  },
  job: id => hub.jobs.get(id),
  assign(jobId, { agent, fallback, role: member, instructions, access, task, title }, extra) {
    assert.equal(extra.by, 'workbench')
    assert.ok(hub.agentsList.has(agent) && (!fallback || hub.agentsList.has(fallback)) && instructions && ['read', 'write'].includes(access), `${member}: an agent of the pool, its role text and access`)
    const t = { id: `t${++taskN}`, jobId, member, agent, title, task, status: 'running', runtime: 'dsh', givenSkills: extra.skills || [], web: !!extra.web, mcp: extra.mcp, pins: extra.pins, env: extra.env }
    t.done = new Promise(r => { t.finish = r })
    tasks.set(t.id, t)
    setTimeout(async () => {
      try { t.output = await members[agent]({ task, mcp: extra.mcp, job: hub.jobs.get(jobId), t, member }); t.status = t.status === 'cancelled' ? 'cancelled' : 'done' } catch (err) { t.status = 'failed'; t.error = err.stack }
      t.finish(t)
    }, 5)
    return { ...t }
  },
  whenTaskDone: id => tasks.get(id).done,
  task: id => { const t = tasks.get(id); return t?.sessionId ? t : undefined },
  cancelTask: id => { tasks.get(id).status = 'cancelled' },
  finishJob: id => { hub.jobs.get(id).status = 'done' },
  stopJob: id => { hub.jobs.get(id).status = 'cancelled' },
}
// an agent over the MCP bridge: what Claude Code or Codex would do through lib/mcp-server.mjs
const bridge = mcp => {
  const post = (path, body) => toolsPost(mcp.env.RUYIXWB_URL, mcp.env.RUYIXWB_TOKEN, path, body)
  return { tools: async () => (await post('/tools', {})).tools, call: async (name, args) => (await post('/call', { name, args })).text }
}
// the real MCP server over stdio, as Claude Code or Codex would start it
const stdio = async mcp => {
  const { spawn } = await import('node:child_process')
  const child = spawn(mcp.command, mcp.args, { env: { ...process.env, ...mcp.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map(), lines = []
  let buf = ''
  child.stdout.on('data', d => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); lines.push(m) }
  })
  let n = 0
  const rpc = (method, params) => new Promise(res => { const id = ++n; waiting.set(id, res); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) })
  return {
    rpc, close: () => child.kill(),
    notify: method => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    call: async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).result; if (r.isError) throw new Error(r.content[0].text); return r.content[0].text },
  }
}
// a dsh agent: a child of the run's Lead gets the tools through agent/created
const dshAgent = (job, t) => {
  const tools = new Map()
  t.sessionId = `s-${t.id}`
  const agent = { id: t.sessionId, session: { header: { parentSession: job.leadId, origin: 'subagent', id: t.sessionId } }, ctx: { tools: { register: d => { tools.set(d.name, d); return () => tools.delete(d.name) } } } }
  for (const fn of listeners['agent/created']) fn({ agent })
  return { call: async (name, args) => (await tools.get(name).execute(args, { signal: new AbortController().signal })).text, done: () => listeners['agent/disposed'].forEach(fn => fn({ agent })), tools }
}
// agents the person has in the pool already (the skill's example names them)
for (const id of ['sonnet', 'opus']) hub.agentsList.set(id, { id, name: id, runtime: 'claude' })
const seqOf = text => Number(/#(\d+)/.exec(text)[1])

// ── the fake connectors plugin ──
const connNeeds = new Map()
const conns = {
  // (a second workbench of the same owner — the self-check makes a few — takes its place until it leaves)
  require: (owner, fn) => { const prev = connNeeds.get(owner); connNeeds.set(owner, fn); return () => { if (connNeeds.get(owner) !== fn) return; if (prev) connNeeds.set(owner, prev); else connNeeds.delete(owner) } },
  needs: () => [...connNeeds].flatMap(([owner, fn]) => fn().map(n => ({ owner, ...n, state: n.connection === 'blog-api' ? 'ok' : 'missing' }))),
  list: async () => [{ id: 'blog-api', type: 'http', name: 'Blog API' }],
  envCalls: [],
  env: async (id, opts) => { conns.envCalls.push([id, opts]); return { BLOG_TOKEN: 'tok-secret-123456' } },
}
const shellParts = []
const llmCalls = []
const fakeLlm = {
  async *stream(o) {
    llmCalls.push(o)
    const text = o.messages[0].content[0].text
    // the conversation's summary: nothing to say unless the check gives it words (fakeLlm.reply)
    if (/condense a stretch/.test(o.system)) { yield { type: 'text-delta', index: 0, text: fakeLlm.reply ?? '{"summary": "", "memories": []}' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const lang = /Chinese/.test(o.system) ? 'ZH' : 'EN'
    yield { type: 'text-delta', index: 0, text: text.startsWith('Translate every string') ? JSON.stringify(JSON.parse(text.slice(text.indexOf('\n') + 1)).map(x => `${lang}:${x}`)) : `${lang}:${text.replace(/^Translate:\n\n/, '')}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const asTools = new Map(), prompts = [], fakeAgents = new Map()
const fakeSc = {
  modelCatalog: async () => ({ groups: [{ id: 'fake', name: 'Fake', models: [{ id: 'model', name: 'Model' }] }] }),
  create: async ({ cwd }) => { const id = `as-${fakeAgents.size + 1}`; assert.ok(existsSync(cwd)); fakeAgents.set(id, { id, session: {}, status: 'idle', ctx: { tools: { register: t => { asTools.set(t.name, t); return () => {} }, view: () => ({ restrictableNames: new Set(['write', 'bash']) }), restrict: () => () => {} } } }); return { sessionId: id } },
  rename: async () => {}, selectModel: async () => {}, cancel: () => {},
  prompt: async p => { prompts.push(p) },
  resolveAgent: async id => (fakeAgents.has(id) ? { agent: fakeAgents.get(id) } : { error: new Error(`no session ${id}`) }),
}
// the shell's system tools (its system.js), as the main agent's conversation finds them: a check puts tools in sysTools
const sysTools = new Map()
// (the tools the workbench registers on the shell kept apart — per name, the latest instance's: the checks call them;
// what they ask of the page, kept)
const ownTools = new Map(), pageActs = []
const ownFinders = new Map()
const fakeShell = { part: p => { shellParts.push(p); return () => {} }, finders: { register: f => { ownFinders.set(f.kind, [...(ownFinders.get(f.kind) || []), f]); return () => ownFinders.set(f.kind, (ownFinders.get(f.kind) || []).filter(x => x !== f)) } }, pageAction: (event, detail) => pageActs.push([event, detail]), systemTools: { register: t => { ownTools.set(t.name, [...(ownTools.get(t.name) || []), t]); return () => ownTools.set(t.name, (ownTools.get(t.name) || []).filter(x => x !== t)) }, list: ({ undo = false } = {}) => [...sysTools.values()].filter(t => undo || t.effect !== 'undo'), get: n => sysTools.get(n) || null } }
const makeCtx = (sink = provided, own = disposers, table = routes) => ({
  logger: { warn: m => warns.push(String(m)), info: () => {} },
  provide: (name, value) => { sink[name] = value },
  inject: (deps, cb) => {
    const all = { agentHub: hub, connectors: conns, ruyixShell: fakeShell, ruyixBrowser: sharedBrowserSvc, ruyixStudio: fakeStudio }
    const inner = { ...Object.fromEntries(deps.map(d => [d, all[d]])), effect: fn => own.push(fn()) }
    cb(inner)
  },
  sessionController: fakeSc,
  // a session's projections: what the check put on it (session.chat: the conversation's fold)
  sessionProjections: { register: () => () => {}, snapshot: session => ({ values: { ruyixWorkbenchChat: session?.chat || { on: false, items: [] } } }) },
  llm: fakeLlm,
  agents: { list: () => [...fakeAgents.values()], get: id => fakeAgents.get(id) },
  effect: fn => own.push(fn()),
  on: (name, fn) => { (listeners[name] ||= []).push(fn) },
  connection: { fetch: { register: r => { table[r.path] = r } } },
})

// ── a pack: a note, written by an agent, signed off by a person, published by an approved action ──
const published = []
const writeStage = {
  key: 'draft', owner: 'writer', title: 'Draft', web: true,
  validate: (result) => { if (typeof result.text !== 'string' || !result.text) throw new Error('text is required') },
  async run(w) {
    const { result } = await w.agent('writer', [header(w, 'draft'), subjectText(w), '## Your task: write the note, save it with file_save, then call stage_result({ text, file })'].join('\n\n'), { title: 'Draft', skills: ['notes/house-style'] })
    w.update({ draft: result })
    return { ok: true, note: `drafted ${result.text.length} chars` }
  },
}
const signOff = {
  key: 'sign-off', owner: 'system', title: 'Sign-off',
  async run(w) {
    w.approval({ action: 'decision', title: 'Is the draft fine to queue?', payload: { why: 'A person reads the note first', options: [{ label: 'Yes, queue it', does: 'queues the publish card', action: 'accept' }, { label: 'Write it again', does: 'goes back to the draft', action: 'revise', from: 'draft' }], recommended: 0, blocking: true, stage: 'sign-off', by: 'workflow' } })
    return { ok: true, note: 'asked' }
  },
}
const queuePublish = {
  key: 'queue', owner: 'system', title: 'Queue the publish card',
  async run(w) {
    const d = w.run.draft
    w.approval({ action: 'fake_publish', title: `Publish "${w.run.subject.title}" to ${w.run.subject.fields.channel}`, payload: { text: d.text, channel: w.run.subject.fields.channel } })
    return { ok: true, note: 'card queued' }
  },
}
const notes = {
  id: 'notes', name: { en: 'Notes', zh: '笔记' },
  agents: [{ id: 'scribe', name: 'Scribe', runtime: 'dsh', model: 'fake/model' }, { id: 'dshy', name: 'Dshy', runtime: 'dsh', model: 'fake/model' }],
  settings: { greeting: 'hello', limits: { chars: 500 } },
  needs: s => [{ need: 'blog', type: 'http', connection: s.greeting === 'hello' ? 'blog-api' : 'none', label: { en: 'Blog API', zh: '博客 API' } }],
  setup: async s => [{ id: 'notes-extra', order: 24, required: false, ready: true, title: { en: 'Notes: extra', zh: '笔记：额外' }, detail: { en: s.greeting, zh: s.greeting } }],
  text: { header: () => 'House rules: keep it short.', stageNames: { draft: { en: 'Draft', zh: '起草' } } },
  skills: { packs: [{ id: 'notes', dir: '/packs/notes', version: '1' }], uses: [{ ref: 'notes/style', stages: ['draft'], member: true, what: { en: 'house style', zh: '文风' } }] },
  tools: [{
    name: 'notes_count', description: 'Count the words of an evidence entry', parameters: { type: 'object', properties: { seq: { type: 'number' } }, required: ['seq'], additionalProperties: false },
    run(c, { seq }) {
      assert.equal(c.pack.id, 'notes', 'a pack tool sees its pack as c.pack')
      assert.equal(c.packSettings.greeting, 'hello', '… and its settings')
      const n = c.store.evidenceAt(c.run.id, seq).output.split(/\s+/).length
      const e = c.record({ kind: 'count', title: `words of #${seq}: ${n}`, input: { seq }, output: String(n), ok: true })
      return `${n} words (evidence #${e.seq})`
    },
  }],
  actions: {
    async fake_publish(c) {
      assert.equal(c.pack.id, 'notes')
      assert.equal(c.packSettings.greeting, 'hello')
      published.push(c.approval.payload)
      const e = c.evidence({ kind: 'http', title: `POST /posts → ${c.approval.payload.channel}`, input: { channel: c.approval.payload.channel }, output: c.approval.payload.text, ok: true })
      c.update(r => ({ ...r, published: { url: 'https://blog.example/p/1', evidence: e.seq } }))
      return { url: 'https://blog.example/p/1' }
    },
    async fake_fail() { throw new Error('the blog is down') },
    async fake_where(c) { return { snapshot: c.packSettings.limits.chars, now: c.currentPackSettings().limits.chars, all: c.currentSettings().packs.notes.limits.chars } },
  },
  ops: ({ store, settings }) => ({ preview: ({ text }) => ({ html: `<p>${text}</p>`, runs: store.list('run').length, greeting: settings().greeting }) }),
  workflows: {
    publish: {
      title: 'Publish a note', description: 'Write a note, sign it off, queue the publish card', noun: 'note', success: 'published', verdicts: { published: 'Published' }, insertFrom: 'draft',
      input: [
        { name: 'channel', type: 'select', label: 'Channel', options: ['blog', { value: 'mail', label: 'Mail' }], required: true },
        { name: 'tags', type: 'multiselect', options: ['a', 'b', 'c'] },
        { name: 'tone', type: 'text', default: 'plain' },
        { name: 'notify', type: 'checkbox' },
        { name: 'photos', type: 'files' },
      ],
      validateInput: s => (/FORBIDDEN/.test(s.text) ? 'the text is forbidden' : ''),
      stages: [intake, writeStage, signOff, queuePublish, report],
      roles: { writer: { agent: 'scribe', fallback: 'dshy', access: 'write', text: 'Writes the note.' } },
    },
  },
}

// ── start ──
let clock = Date.now() // the conversation's clock
const wb = createWorkbench(makeCtx(), { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 }, now: () => clock })
const { engine, ops, service } = wb
const home = process.env.RUYIX_WORKBENCH_HOME
const off = provided.ruyixWorkbench.registerPack(notes)
assert.equal(provided.ruyixWorkbench, service)
assert.deepEqual(hub.ensured, ['sonnet', 'codex', 'scribe', 'dshy'], 'the task workflow\'s agents and a pack\'s join the pool')
assert.ok(hub.registered.includes('notes') && hub.registered.includes('workbench'), 'its skill pack and the workbench\'s own are registered with Agent Hub')
assert.ok(connNeeds.has('Notes'), 'its needs go to the connectors plugin')
const op = async (name, args = {}) => {
  const res = await routes['/api/ruyix-workbench'].fetch(new Request('http://x/api/ruyix-workbench', { method: 'POST', body: JSON.stringify({ op: name, ...args }) }))
  const body = await res.json()
  if (!res.ok) throw Object.assign(new Error(body.error), { code: body.code, status: res.status })
  return body
}
const b64 = s => Buffer.from(s).toString('base64')
const finished = id => until(`run ${id} to end`, () => { const r = engine.get(id); return ['done', 'failed', 'cancelled'].includes(r.status) && !engine.active(id) && r })
// A terminal run can precede its automatic report. Read persisted artifacts only; never trigger the report fallback.
const automaticReport = async (id, verdict) => {
  const result = await until(`run ${id} to write its ${verdict} report`, () => {
    const run = engine.get(id)
    if (!run.report || !run.reportSha256) return null
    const markdown = wb.store.readArtifact(run.report)
    return markdown.includes(`**Verdict: ${verdict}**`) && { run, markdown }
  })
  assert.equal(createHash('sha256').update(result.markdown).digest('hex'), result.run.reportSha256, 'the automatic report matches its recorded hash')
  return result
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

// ── the pack, over the API ──
{
  const { packs } = await op('packs')
  assert.deepEqual(packs.map(p => p.id), ['notes'])
  assert.deepEqual(packs[0].name, { en: 'Notes', zh: '笔记' })
  assert.equal(packs[0].workflows[0].id, 'notes.publish')
  assert.equal(packs[0].workflows[0].input.find(f => f.name === 'channel').required, true, 'the form fields come with the workflow')
  assert.deepEqual(packs[0].actions.sort(), ['fake_fail', 'fake_publish', 'fake_where'], 'the pack\'s actions')
  const wfs = (await op('workflows')).builtIn.map(w => w.id).sort()
  assert.deepEqual(wfs, ['blank', 'notes.publish', 'task'])
  assert.equal((await op('workflows')).builtIn.find(w => w.id === 'notes.publish').insertFrom, 'draft')
  assert.deepEqual((await op('notes.preview', { text: 'hi' })), { html: '<p>hi</p>', runs: 0, greeting: 'hello' }, 'a pack\'s ops are served as <id>.<op>')
  await assert.rejects(op('notes.nothing'), /unknown op/)
  await assert.rejects(op('nothing'), /unknown op/)
  await assert.rejects(op('constructor'), /unknown op/)
}

// ── the end-to-end run ──
let main
members.scribe = async ({ task, mcp, member }) => {
  assert.equal(member, 'writer')
  assert.match(task, /House rules: keep it short\./, 'the pack adds to the brief')
  assert.match(task, /the run so far|wb_context/)
  assert.match(task, /# Quarterly note/)
  assert.match(task, /channel: blog/i, 'the form fields reach the agent')
  assert.match(task, /cover\.png/, 'and the attachments')
  const a = bridge(mcp)
  const names = (await a.tools()).map(t => t.name).sort()
  assert.deepEqual(names, ['claim_add', 'decision_needed', 'discuss_with_person', 'evidence_get', 'file_save', 'help_needed', 'notes_count', 'stage_result', 'tools_ensure', 'wb_context'], 'a pack step may use the core tools and its pack\'s')
  const ctxText = await a.call('wb_context', {})
  assert.match(ctxText, /Quarterly note/)
  assert.match(ctxText, /cover\.png/)
  assert.match(ctxText, /Your folder: .*[\\/]work/)
  const saved = await a.call('file_save', { name: 'note.md', content: '# Quarterly note\n\nSix words are in this note.', title: 'draft 1' })
  const seq = seqOf(saved)
  assert.match(await a.call('notes_count', { seq }), /words/)
  await a.call('file_save', { name: 'cover-2.png', content: png.toString('base64'), encoding: 'base64', mime: 'image/png' })
  await assert.rejects(a.call('file_save', { name: 'x', content: '' }), /empty/)
  assert.match(await a.call('claim_add', { type: 'output', text: 'the note is drafted', evidence: [seq] }), /Recorded claim C1/)
  await assert.rejects(a.call('claim_add', { type: 'output', text: 'x', evidence: [99] }), /no evidence #99/)
  await assert.rejects(a.call('claim_add', { type: 'fix', text: 'x', evidence: [seq] }), /type is one of finding, decision, risk, source, output/)
  await assert.rejects(a.call('stage_result', { result: { text: '' } }), /invalid stage_result/, 'a pack step checks its own result')
  return a.call('stage_result', { result: { text: '# Quarterly note\n\nSix words are in this note.', file: seq } })
}
{
  const bad = await op('startRun', { workflow: 'notes.publish', title: 'x', fields: { channel: 'fax' } }).catch(e => e)
  assert.match(bad.message, /Channel: fax is not one of blog, mail/)
  const run = (await op('startRun', {
    workflow: 'notes.publish', title: 'Quarterly note', text: 'Write the quarterly note.', note: 'be brief', tags: ['q'],
    fields: { channel: 'blog', tags: ['a', 'b'] },
    attachments: [{ name: 'cover.png', base64: png.toString('base64'), field: 'photos' }, { name: 'brief.txt', base64: b64('the brief') }],
  })).run
  main = run.id
  assert.equal(run.template, 'notes.publish')
  assert.deepEqual(Object.keys(run.subject).sort(), ['attachments', 'fields', 'text', 'title'])
  assert.deepEqual(run.subject.fields, { channel: 'blog', tags: ['a', 'b'], tone: 'plain' }, 'a field with a default gets it')
  assert.equal(run.dir, join(home, 'runs', run.id, 'work'))
  assert.ok(statSync(run.dir).isDirectory(), 'the run\'s folder exists when startRun returns')
  assert.deepEqual(run.subject.attachments.map(a => [a.name, a.mime, a.size, !!a.sha256, !!a.artifact]), [['cover.png', 'image/png', png.length, true, true], ['brief.txt', 'text/plain', 9, true, true]])
  assert.equal(readFileSync(run.subject.attachments[1].path, 'utf8'), 'the brief', 'the agents read copies of the attachments in the folder')
  assert.equal(run.subject.attachments[1].path, join(run.dir, 'attachments', 'brief.txt'))
  assert.ok(!('bug' in run) && !('mr' in run) && !('env' in run) && !('worktree' in run))

  // the run waits at the sign-off for the person
  const waiting = await until('the sign-off', () => { const r = engine.get(main); return r.status === 'waiting' && r })
  assert.equal(waiting.waiting, 'decision')
  assert.equal(waiting.stage, 'sign-off')
  assert.equal(hub.started.at(-1).cwd, run.dir, 'Agent Hub works in the run\'s folder')
  assert.deepEqual(hub.started.at(-1).agents.sort(), ['dshy', 'scribe'], 'the role\'s agent and its fallback are checked up front')
  const card = store().list('approval').find(a => a.runId === main && a.action === 'decision')
  assert.ok(card && card.status === 'pending')
  // the draft is in the ledger (file_save), with its artifact
  const ledger = store().evidence(main)
  const files = ledger.filter(e => e.kind === 'file')
  assert.deepEqual(files.map(e => e.title), ['attachment: cover.png', 'attachment: brief.txt', 'draft 1', 'file: cover-2.png'], 'attachments and saved files are in the ledger')
  assert.ok(files.every(e => e.artifact && e.sha256))
  assert.equal(store().readArtifact(files[2].artifact), '# Quarterly note\n\nSix words are in this note.')
  assert.ok(files[3].artifact.endsWith('.png') && store().readArtifact(files[3].artifact, null).equals(png), 'binary content is kept as it came')
  assert.ok(ledger.some(e => e.kind === 'count' && e.stage === 'draft' && e.actor === 'writer'), 'a pack tool\'s evidence lands in its step')
  assert.equal(engine.get(main).subject.attachments[0].evidence, 2, 'the intake put the attachments in the ledger and numbered them')
  assert.deepEqual(engine.get(main).claims.map(c => [c.id, c.type, c.stage]), [['C1', 'output', 'draft']])
  assert.ok(store().verify(main).ok)

  // the person: look at the first option; approving a decision card applies it at the end of the step
  const approved = (await op('approve', { id: card.id, payload: { choice: 0 } })).approval
  assert.equal(approved.status, 'done')
  const done = await finished(main)
  assert.equal(done.status, 'done')
  assert.equal(done.verdict.level, 'published', 'the workflow\'s success level is the verdict when nothing says otherwise')
  assert.deepEqual(done.stages.map(s => [s.key, s.status]), [['intake', 'passed'], ['draft', 'passed'], ['sign-off', 'passed'], ['queue', 'passed'], ['report', 'passed']])
  assert.equal(done.decisions[0].label, 'Yes, queue it')
  assert.equal(hub.jobs.get(done.jobId).status, 'done', 'the Agent Hub job ends with the run')

  // the publish card waits; the person edits the text and approves: the action runs
  const pub = store().list('approval').find(a => a.runId === main && a.action === 'fake_publish')
  // the step said web, and the run's own skill went with the task
  const drafted = [...tasks.values()].find(t => t.title === 'Draft')
  assert.ok(drafted.web, 'a step that searches the web asks Agent Hub for it')
  assert.ok(drafted.givenSkills.includes('notes/house-style'), 'a skill chosen for this task reaches it')
  assert.equal(pub.status, 'pending')
  assert.equal(published.length, 0, 'nothing leaves before the person approves')
  const res = (await op('approve', { id: pub.id, payload: { text: 'Edited by the person' } })).approval
  assert.equal(res.status, 'done')
  assert.deepEqual(res.result, { url: 'https://blog.example/p/1' })
  assert.deepEqual(published, [{ text: 'Edited by the person', channel: 'blog' }], 'the action got the person\'s edit')
  await assert.rejects(op('approve', { id: pub.id }), /already done/)
  const after = engine.get(main)
  assert.equal(after.published.url, 'https://blog.example/p/1')
  const ledger2 = store().evidence(main)
  assert.ok(ledger2.some(e => e.kind === 'approval' && e.title.startsWith('approved: Publish')), 'the approval is in the ledger')
  const http = ledger2.find(e => e.kind === 'http')
  assert.equal(http.stage, 'approval')
  assert.equal(http.output, 'Edited by the person')
  const v = await op('verify', { id: main })
  assert.ok(v.ok && v.count === ledger2.length, 'the ledger verifies')

  store().put('run', { ...engine.get(main), report: null, reportSha256: null })
  const { markdown, sha256: reportSha } = await op('report', { id: main })
  assert.ok(reportSha && reportSha === engine.get(main).reportSha256, 'a missing report is generated asynchronously and returns its new hash')
  for (const part of ['# Quarterly note', '**Verdict: Published**', '## Request', '## Fields', 'Channel: blog', '## Attachments', 'cover.png', '## Steps', '| draft | writer | passed', '## Output', 'Six words are in this note', '## Files', 'draft 1', '## Claims', '**C1** [output] the note is drafted', '## Decisions', 'Yes, queue it', '## Approvals', 'Publish "Quarterly note" to blog: **done**', '## Evidence ledger', 'POST /posts → blog', 'chain verified ✓']) {
    assert.ok(markdown.includes(part), `the report has: ${part}\n${markdown}`)
  }
  assert.equal(markdown.includes('BROKEN'), false)
  const tamper = store().evidence(main).find(e => e.artifact && e.kind === 'file')
  const file = join(home, 'runs', tamper.artifact)
  const was = readFileSync(file)
  writeFileSync(file, 'changed')
  assert.deepEqual((await op('verify', { id: main })).reason, 'artifact changed', 'a changed artifact breaks the chain')
  writeFileSync(file, was)
  assert.ok((await op('verify', { id: main })).ok)

  // the artifacts as the panel reads them
  const art = seq => op('artifact', { id: main, seq })
  assert.equal((await art(files[2].seq)).content, '# Quarterly note\n\nSix words are in this note.')
  assert.match((await art(files[3].seq)).image, /^data:image\/png;base64,/)
  assert.match((await art(files[0].seq)).image, /^data:image\/png;base64,/)
  assert.equal((await art(files[1].seq)).content, 'the brief')
  await assert.rejects(art(999), /no evidence/)

  // the artifact file, streamed: the type from its name, Range for scrubbing, and only what the ledger names
  const get = (query, headers = {}) => routes['/api/ruyix-workbench/file'].fetch(new Request(`http://x/api/ruyix-workbench/file?${query}`, { headers }))
  const text = '# Quarterly note\n\nSix words are in this note.', n = text.length, mine = `run=${main}&seq=${files[2].seq}`
  const whole = await get(mine)
  assert.equal(whole.status, 200)
  assert.match(whole.headers.get('content-type'), /^text\/markdown/)
  assert.equal(whole.headers.get('accept-ranges'), 'bytes')
  assert.equal(whole.headers.get('content-length'), String(n))
  assert.equal(await whole.text(), text)
  assert.equal((await get(`run=${main}&seq=${files[3].seq}`)).headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await (await get(`run=${main}&seq=${files[0].seq}`)).arrayBuffer()), png, 'a binary file comes back byte for byte')
  const part = await get(mine, { range: 'bytes=2-9' })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 2-9/${n}`)
  assert.equal(part.headers.get('content-length'), '8')
  assert.equal(await part.text(), text.slice(2, 10))
  const tail = await get(mine, { range: 'bytes=-5' })
  assert.equal(tail.headers.get('content-range'), `bytes ${n - 5}-${n - 1}/${n}`)
  assert.equal(await tail.text(), 'note.')
  const open = await get(mine, { range: `bytes=${n - 3}-` })
  assert.equal(open.status, 206)
  assert.equal(await open.text(), text.slice(-3))
  assert.equal((await get(mine, { range: `bytes=${n - 3}-9999` })).headers.get('content-range'), `bytes ${n - 3}-${n - 1}/${n}`, 'an end past the size is cut to it')
  const unsat = await get(mine, { range: `bytes=${n + 5}-${n + 20}` })
  assert.equal(unsat.status, 416)
  assert.equal(unsat.headers.get('content-range'), `bytes */${n}`)
  assert.equal((await get(mine, { range: 'lines=1-2' })).status, 200, 'a Range it does not know is ignored')
  assert.match((await get(`${mine}&download=1`)).headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/)
  assert.match(whole.headers.get('content-security-policy'), /^sandbox/, 'opened on its own, a file runs nothing')
  // refused: no run, no entry, an entry without a file, bad numbers, a path the ledger was made to name outside the runs folder
  const nothing = ledger.find(e => !e.artifact)
  assert.ok(nothing)
  for (const [query, status] of [[`run=nope&seq=1`, 404], [`run=${main}&seq=999`, 404], [`run=${main}&seq=${nothing.seq}`, 404], [`run=${main}&seq=0`, 400], [`run=${main}&seq=x`, 400], [`seq=1`, 400], [`run=${main}`, 400]]) {
    assert.equal((await get(query)).status, status, query)
  }
  // (in a run made for it: an entry with a broken path would fail the ledger check of a real one)
  writeFileSync(join(home, 'runs', 'outside.txt'), 'secret')
  const decoy = store().put('run', { id: 'rdecoy', template: 'blank', status: 'done', stages: [], subject: {}, createdAt: Date.now() }).id
  for (const artifact of [`${decoy}/../outside.txt`, `../outside.txt`, join(home, 'runs', 'outside.txt'), `${main}/${files[2].artifact.split('/').pop()}`]) {
    const sneaky = store().addEvidence(decoy, { kind: 'file', title: 'sneaky', artifact })
    const res = await get(`run=${decoy}&seq=${sneaky.seq}`)
    assert.equal(res.status, 404, artifact)
    assert.ok(!(await res.text()).includes('secret'))
  }
}
function store() { return wb.store }

// ── dsh agents get the tools registered on their session, and a step's own tool list is enforced ──
{
  members.dshy = async ({ job, t }) => {
    const a = dshAgent(job, t)
    assert.deepEqual([...a.tools.keys()].sort(), ['claim_add', 'decision_needed', 'discuss_with_person', 'evidence_get', 'file_save', 'help_needed', 'notes_count', 'stage_result', 'tools_ensure', 'wb_context'], 'a dsh agent of a run gets the core tools and its pack\'s')
    await a.call('file_save', { name: 'a.txt', content: 'from dsh' })
    const out = await a.call('stage_result', { result: { ok: true, summary: 'dsh did it', findings: ['one'] } })
    a.done()
    return out
  }
  const def = {
    id: 'dsh-flow', title: 'Via dsh', base: 'blank',
    steps: [{ use: 'intake' }, { id: 'work', use: 'agent', title: 'Work', agent: 'dshy', access: 'write', instructions: 'Do the work.', tools: ['notes_count'] }, { use: 'report' }],
  }
  const saved = await op('workflowSave', { definition: def, enable: true })
  assert.deepEqual(saved.errors, [])
  await assert.rejects(op('workflowSave', { definition: { ...def, title: 'Clash' }, create: true }), e => e.code === 'workflowExists')
  assert.equal(JSON.parse(readFileSync(join(home, 'workflows', 'dsh-flow.json'))).title, def.title)
  const historical = { ...def, id: 'history-check' }
  await op('workflowSave', { definition: historical, create: true, enable: true })
  await op('workflowSave', { definition: { ...historical, title: 'Assistant draft' }, by: 'assistant' })
  await op('workflowRemove', { id: historical.id })
  const copies = readdirSync(join(home, 'workflows', '.history')).filter(f => f.startsWith('history-check-')).map(f => JSON.parse(readFileSync(join(home, 'workflows', '.history', f))))
  assert.deepEqual(copies.map(x => [x.title, x.status]).sort(), [['Assistant draft', 'draft'], [historical.title, 'enabled']].sort())
  // The assistant's newer draft cannot be overwritten, enabled or removed by a stale editor.
  const guarded = { ...def, id: 'revision-check' }
  const v1 = (await op('workflowSave', { definition: guarded, create: true, enable: true })).workflow
  const v2 = (await op('workflowSave', { definition: { ...guarded, title: 'New assistant draft' }, by: 'assistant' })).workflow
  assert.notEqual(v1.revision, v2.revision)
  assert.equal((await op('workflows')).mine.find(x => x.id === guarded.id).revision, v2.revision)
  await assert.rejects(op('workflowSave', { definition: { ...guarded, title: 'Stale edit' }, expect: v1.revision }), e => e.code === 'workflowChanged')
  await assert.rejects(op('workflowStatus', { id: guarded.id, status: 'enabled', expect: v1.revision }), e => e.code === 'workflowChanged')
  await assert.rejects(op('workflowRemove', { id: guarded.id, expect: v1.revision }), e => e.code === 'workflowChanged')
  assert.equal(JSON.parse(readFileSync(join(home, 'workflows', guarded.id + '.json'))).title, 'New assistant draft')
  const v3 = (await op('workflowSave', { definition: { ...guarded, title: 'Reviewed new version' }, expect: v2.revision })).workflow
  await op('workflowRemove', { id: guarded.id, expect: v3.revision })
  const r = (await op('startRun', { workflow: 'dsh-flow', title: 'via dsh' })).run
  const end = await finished(r.id)
  assert.equal(end.status, 'done')
  assert.equal(end.outputs.work.summary, 'dsh did it')
  assert.equal(end.verdict.level, 'done', 'blank\'s success level is done')
  assert.ok(wb.store.evidence(r.id).some(e => e.kind === 'file' && e.title === 'file: a.txt'))
}
{
  // a tool the step does not list is refused (the pack's tool is listed here, the other agent steps have the core six only;
  // this step reads only, so it has no tools_ensure either: it would run code on the machine)
  members.dshy = async ({ mcp }) => {
    const a = bridge(mcp)
    assert.deepEqual((await a.tools()).map(t => t.name).sort(), ['claim_add', 'decision_needed', 'discuss_with_person', 'evidence_get', 'file_save', 'help_needed', 'stage_result', 'wb_context'])
    await assert.rejects(a.call('tools_ensure', { tool: 'shellcheck' }), /not a tool of the step/)
    await assert.rejects(a.call('notes_count', { seq: 1 }), /not a tool of the step/)
    await assert.rejects(a.call('nothing', {}), /not a tool|unknown tool/)
    return a.call('stage_result', { result: { ok: true, summary: 'core only' } })
  }
  await op('workflowSave', { definition: { id: 'core-only', title: 'Core only', base: 'blank', steps: [{ use: 'intake' }, { id: 'work', use: 'agent', title: 'Work', agent: 'dshy', instructions: 'Do it.' }, { use: 'report' }] }, enable: true })
  const end = await finished((await op('startRun', { workflow: 'core-only', text: 'go' })).run.id)
  assert.equal(end.status, 'done')
  // outside a live step the bridge answers nothing
  await assert.rejects(bridge({ env: { RUYIXWB_URL: `unix:${wb.server.address()}`, RUYIXWB_TOKEN: 'nope' } }).tools(), /not a live workbench run/)
}

// ── agents that message each other (lib/messages.js): the tools and the skill only where the workflow lets them, each
// agent under the name its step gives it, beside the ledger (no evidence) and beside the folder (no version) ──
{
  const said = []
  let rid2 = null
  members.dshy = async ({ mcp, task, t }) => {
    const a = bridge(mcp), names = (await a.tools()).map(x => x.name)
    assert.ok(['messages_post', 'messages_read', 'messages_wait'].every(n => names.includes(n)), 'every agent step of the workflow has the three tools')
    assert.ok(t.givenSkills.includes('messages/agent-messages'), 'and the skill that says how')
    said.push(await a.call('messages_read', {}))
    if (task.includes('Draft it.')) {
      said.push(await a.call('messages_post', { text: 'draft.md is done; section 2 is a guess', files: [join(engine.get(rid2).dir, 'draft.md')] })) // (its folder's full path: kept as a path in the folder)
      return a.call('stage_result', { result: { ok: true, summary: 'drafted' } })
    }
    said.push(await a.call('messages_post', { text: 'I keep section 2 out', to: 'draft', reply_to: 1 }))
    return a.call('stage_result', { result: { ok: true, summary: 'checked' } })
  }
  assert.ok(hub.registered.includes('messages'), 'the workbench registers the skill pack')
  const talk = { id: 'talks', title: 'Talks', base: 'blank', messages: true, steps: [{ use: 'intake' },
    { id: 'draft', use: 'agent', title: 'Draft', agent: 'dshy', access: 'write', instructions: 'Draft it.' },
    { id: 'check', use: 'agent', title: 'Check', agent: 'dshy', instructions: 'Check it.', tools: ['notes_count'] }, { use: 'report' }] }
  assert.deepEqual((await op('workflowSave', { definition: talk, enable: true })).errors, [])
  const r = (await op('startRun', { workflow: 'talks', title: 'Talking' })).run
  rid2 = r.id
  const end = await finished(r.id)
  assert.equal(end.status, 'done')
  assert.match(said[0], /^Nothing new for draft\. No one else has used this space yet\.$/)
  assert.equal(said[1], 'Posted #1 as draft to everyone.')
  assert.match(said[2], /^You are check\. 1 new message\(s\):\n#1 \d\d:\d\d draft → everyone: draft\.md is done; section 2 is a guess\n {3}files: draft\.md$/)
  assert.equal(said[3], 'Posted #2 as check to draft.')
  const m = await op('runMessages', { id: r.id })
  assert.equal(m.on, true)
  assert.deepEqual(m.messages.map(x => [x.from, x.to, x.replyTo]), [['draft', null, null], ['check', 'draft', 1]])
  assert.deepEqual(m.members.map(x => x.name).sort(), ['check', 'draft'])
  assert.ok(!JSON.stringify(wb.store.evidence(r.id)).includes('section 2 is a guess'), 'a message is no evidence')
  assert.ok(existsSync(join(wb.store.dir, 'runs', r.id, 'messages.db')) && !existsSync(join(r.dir, 'messages.db')), 'the space is beside the run\'s folder')
  // a workflow that does not let them: no tools (checked above: core-only), no space, nothing to show
  const quiet = engine.list?.().find?.(x => x.workflowDef?.id === 'core-only') || wb.store.list('run').find(x => x.workflowDef?.id === 'core-only')
  assert.deepEqual(await op('runMessages', { id: quiet.id }), { on: false, messages: [], members: [] })
  assert.ok(!existsSync(join(wb.store.dir, 'runs', quiet.id, 'messages.db')))
  // the definition says it plainly or not at all
  assert.match(JSON.stringify((await op('workflowSave', { definition: { ...talk, id: 'talks-bad', messages: 'yes' } })).errors), /messages is true or false/)
}

// ── a workflow whose steps run in resident sessions (Agent Hub's; docs/design/sessions.md §2a): the same agent's next
// step goes on in its session (its MCP token kept, pointed at the new step); a reminder in the same session; a step
// that may do less, or one marked fresh, in a new one; a session that will not open: the step as a task; at the end
// the processes close ──
{
  hub.agentsList.set('cly', { id: 'cly', runtime: 'claude', model: 'claude-x' })
  const sessions = new Map(), asked = [], seenTokens = []
  let sn = 0, broken = false
  hub.sessionInfo = id => { const x = sessions.get(id); return x ? { id, state: x.busy ? 'working' : 'idle', runtime: 'claude', model: 'claude-x', context: x.context, error: null } : null }
  hub.openSession = async spec => {
    if (broken) throw Object.assign(new Error('claude is not installed'), { code: 'cliNotInstalled' })
    assert.ok(spec.cwd && spec.instructions && spec.mcp?.env?.RUYIXWB_TOKEN && spec.of?.run, 'a session for a step: the run\'s folder, the role\'s text, the tools, which step')
    if (spec.reuse) {
      const x = sessions.get(spec.reuse)
      if (x.access !== spec.access) throw Object.assign(new Error('access differs'), { code: 'sessionMismatch', params: { differs: ['access'] } })
      Object.assign(x, { mcp: spec.mcp, of: spec.of })
      return { id: x.id, reused: true }
    }
    const x = { id: `s${++sn}`, agent: spec.agent, access: spec.access, mcp: spec.mcp, of: spec.of, context: 1000 }
    sessions.set(x.id, x)
    return { id: x.id, reused: false }
  }
  hub.askSession = async (id, text, { of, signal }) => {
    const x = sessions.get(id)
    assert.ok(signal instanceof AbortSignal, 'a turn the run can stop (and the engine\'s own clock: waits for the shared browser do not count)')
    x.busy = true; asked.push([id, of.step, text.startsWith('You ended this step') ? 'reminder' : 'brief'])
    try { return { output: await members.cly({ task: text, mcp: x.mcp, step: of.step }), tokens: 12, cost: 0.01 } } finally { x.busy = false }
  }
  hub.closeSession = id => { sessions.get(id).closed = true }
  let forgot = true
  members.cly = async ({ mcp, task, step }) => {
    const a = bridge(mcp); seenTokens.push([step, mcp.env.RUYIXWB_TOKEN])
    if (task.includes('Polish it.') && forgot) { forgot = false; return 'polished (forgot the result)' }
    return a.call('stage_result', { result: { ok: true, summary: `${step || 'done'} done` } })
  }
  const def = { id: 'sess', title: 'In sessions', base: 'blank', sessions: true, steps: [{ use: 'intake' },
    { id: 'draft', use: 'agent', title: 'Draft', agent: 'cly', access: 'write', instructions: 'Draft it.' },
    { id: 'polish', use: 'agent', title: 'Polish', agent: 'cly', access: 'write', instructions: 'Polish it.' },
    { id: 'check', use: 'agent', title: 'Check', agent: 'cly', access: 'read', instructions: 'Check it.' },
    { id: 'again', use: 'agent', title: 'Again', agent: 'cly', access: 'write', session: 'fresh', instructions: 'Again.' }, { use: 'report' }] }
  assert.deepEqual((await op('workflowSave', { definition: def, enable: true })).errors, [])
  const r = (await op('startRun', { workflow: 'sess', title: 'Sessions' })).run
  const end = await finished(r.id)
  assert.equal(end.status, 'done', JSON.stringify(wb.store.evidence(r.id).filter(e => e.ok === false).map(e => e.title)))
  assert.deepEqual(end.sessions.map(x => [x.id, x.steps]), [['s1', ['draft', 'polish']], ['s2', ['check']], ['s3', ['again']]],
    'polish goes on in draft\'s session; the read-only check and the fresh step each in a new one')
  assert.deepEqual(['draft', 'polish', 'check', 'again'].map(k => end.stages.find(x => x.key === k).session), ['s1', 's1', 's2', 's3'])
  assert.deepEqual(asked.filter(x => x[1] === 'polish').map(x => [x[0], x[2]]), [['s1', 'brief'], ['s1', 'reminder']], 'no result: one reminder, in the same session')
  const tok = k => seenTokens.find(x => x[0] === k)[1]
  assert.equal(tok('draft'), tok('polish'), 'the session keeps its tools: the same token, pointed at the next step')
  assert.notEqual(tok('draft'), tok('check'))
  assert.ok([...sessions.values()].every(x => x.closed), 'the run is over: its sessions\' processes close')
  assert.ok(wb.store.evidence(r.id).some(e => e.kind === 'agent' && e.input?.session === 's1' && e.stage === 'polish'), 'the ledger says which session did it')
  // Two parallel lanes can both see the same idle predecessor before either async open finishes.
  const priorOpen = hub.openSession, opening = []
  let releaseReuse
  const reuseGate = new Promise(r => { releaseReuse = r })
  hub.openSession = async spec => {
    if (['left', 'right'].includes(spec.of?.step)) { opening.push(spec); if (spec.reuse) await reuseGate }
    return priorOpen(spec)
  }
  const lane = id => ({ id, steps: [{ id, use: 'agent', title: id, agent: 'cly', access: 'read', instructions: `Do ${id}.` }] })
  const parallelDef = { ...def, id: 'session-parallel', steps: [{ use: 'intake' }, { id: 'seed', use: 'agent', title: 'Seed', agent: 'cly', access: 'read', instructions: 'Seed.' }, { id: 'fork', use: 'parallel', title: 'Together', lanes: [lane('left'), lane('right')] }, { use: 'report' }] }
  assert.deepEqual((await op('workflowSave', { definition: parallelDef, enable: true })).errors, [])
  const parallelRun = (await op('startRun', { workflow: parallelDef.id, title: 'Parallel sessions' })).run
  await until('both parallel session opens', () => opening.length === 2)
  releaseReuse()
  assert.equal(opening.filter(x => x.reuse).length, 1, 'an idle session is reserved before an asynchronous MCP probe/open')
  const parallelEnd = await finished(parallelRun.id)
  assert.equal(parallelEnd.status, 'done')
  assert.notEqual(parallelEnd.stages.find(x => x.key === 'left').session, parallelEnd.stages.find(x => x.key === 'right').session, 'parallel lanes own separate sessions and tool tokens')
  assert.deepEqual(['left', 'right'].map(k => parallelEnd.stages.find(x => x.key === k).result.summary), ['left done', 'right done'])
  hub.openSession = priorOpen
  // a session that will not open: the step runs as a task after all, and the ledger says why
  broken = true
  const r2 = (await op('startRun', { workflow: 'sess', title: 'No sessions here' })).run
  const end2 = await finished(r2.id)
  assert.equal(end2.status, 'done')
  assert.ok(wb.store.evidence(r2.id).some(e => e.kind === 'gate' && /could not run in a session \(cliNotInstalled/.test(e.title)))
  assert.ok(end2.stages.find(x => x.key === 'draft').tasks?.length, 'as a task')
  broken = false
  // a discussion after a step (docs/design/agent-work.md §7): the person talks with that step's agent in its own session
  // (it knows what it did); settled, it writes what was agreed in the same session
  const said = []
  members.cly = async ({ mcp, task, step }) => {
    if (task.startsWith('[Ruyix · a discussion with the person]')) { said.push(['turn', step]); return `In my session: ${/They say:\n\n([^\n]*)/.exec(task)[1]}` }
    if (task.startsWith('[Ruyix · the discussion about')) { said.push(['agreed', step]); assert.match(task, /settled, and adds: No subtitle\./); return 'Agreed in the session: the short title.' }
    return bridge(mcp).call('stage_result', { result: { ok: true, summary: `${step || 'done'} done` } })
  }
  const talkDef = { id: 'sess-talk', title: 'Talk in a session', base: 'blank', sessions: true, steps: [{ use: 'intake' },
    { id: 'draft', use: 'agent', title: 'Draft', agent: 'cly', access: 'write', instructions: 'Draft it.' },
    { id: 'talk', use: 'person', ask: 'chat', title: 'Talk the draft over', text: 'Settle the title together.' }, { use: 'report' }] }
  assert.deepEqual((await op('workflowSave', { definition: talkDef, enable: true })).errors, [])
  const rt = (await op('startRun', { workflow: 'sess-talk', title: 'Talk' })).run
  const chatCard = await until('the discussion', () => wb.store.list('approval').find(a => a.runId === rt.id && a.payload?.kind === 'chat' && a.status === 'pending'))
  assert.equal(chatCard.payload.with, 'draft', 'with the agent of the step before')
  await op('askHelp', { id: chatCard.id, text: 'Short or long title?' })
  assert.equal(await until('its reply', () => wb.store.get('approval', chatCard.id).chat?.[0]?.answer), 'In my session: Short or long title?')
  const sid = engine.get(rt.id).stages.find(x => x.key === 'draft').session
  assert.ok(asked.some(x => x[0] === sid && x[1] === 'talk'), 'in the draft\'s own session')
  await op('approve', { id: chatCard.id, payload: { answer: 'continue', input: 'No subtitle.' } })
  const et = await finished(rt.id)
  assert.equal(et.status, 'done', JSON.stringify(et.stages.map(x => [x.key, x.status, x.note])))
  assert.equal(et.outputs.talk.settled, 'Agreed in the session: the short title.')
  assert.deepEqual(said, [['turn', 'talk'], ['agreed', 'talk']])
  assert.ok(et.guidance.some(g => !g.stage && /the short title/.test(g.text)), 'what was agreed is said to every step after it')
  // the definition says it plainly
  assert.match(JSON.stringify((await op('workflowSave', { definition: { ...def, id: 'sess-bad', sessions: 'yes' } })).errors), /sessions is true or false/)
  assert.match(JSON.stringify((await op('workflowSave', { definition: { ...def, id: 'sess-bad2', steps: def.steps.map(x => (x.id === 'again' ? { ...x, session: 'new' } : x)) } })).errors), /session is fresh or run/)
  for (const k of ['sessionInfo', 'openSession', 'askSession', 'closeSession']) delete hub[k]
  hub.agentsList.delete('cly'); delete members.cly
}

// ── a step in the agents' browser (browser: 'shared'; docs/design/browser.md): the task gets it (which run, its folder),
// the person's hand-off becomes the step's blocking decision and the run waits on it; a step that needs a login fails
// plainly without the browser, one that does not goes on without it ──
{
  const { stepClock } = await import('./lib/engine.js')
  // the step's clock: the time waited (for the browser's turn) is added once it is known; nothing waited: just the limit
  const fired = [], timers = { set: (f, ms) => { fired.push(ms); return setTimeout(f, 1) }, clear: clearTimeout }
  let w = 0
  await new Promise(r => { stepClock(100, () => w, r, timers); w = 3000 })
  assert.deepEqual(fired, [100, 3000], 'waited 3 s for its turn: 3 s more')
  fired.length = 0; w = 0
  await new Promise(r => stepClock(100, () => w, r, timers))
  assert.deepEqual(fired, [100])
  sharedBrowserSvc.on = true
  const given = []
  const keep = hub.assign
  hub.assign = (jobId, spec, extra) => { const t = keep(jobId, spec, extra); Object.assign(tasks.get(t.id), { ofRun: extra.of, browser: extra.browser, dirs: extra.dirs }); return t }
  members.dshy = async ({ mcp, t }) => {
    const task = tasks.get(t.id)
    given.push(task)
    // the agent hands the last click to the person: the browser says so (its holder, waiting)
    sharedBrowserSvc.emit({ holder: { who: `task:${t.id}`, of: task.ofRun, since: 1, waiting: 'handoff', why: 'the publish button is yours' }, queue: [] })
    return bridge(mcp).call('stage_result', { result: { ok: true, summary: 'filled the form' } })
  }
  const def = { id: 'web-form', title: 'A form', base: 'blank', steps: [{ use: 'intake' },
    { id: 'fill', use: 'agent', title: 'Fill the form', agent: 'dshy', access: 'write', browser: 'shared', login: true, instructions: 'Fill it.' }, { use: 'report' }] }
  assert.deepEqual((await op('workflowSave', { definition: def, enable: true })).errors, [])
  const r = (await op('startRun', { workflow: 'web-form', title: 'Form' })).run
  const card = await until('the hand-off card', () => wb.store.list('approval').find(a => a.runId === r.id && a.payload?.browser === 'shared' && a.status === 'pending'))
  assert.equal(given[0].browser, true); assert.equal(given[0].ofRun, `run:${r.id}`); assert.deepEqual(given[0].dirs, [engine.get(r.id).dir], 'the agents\' browser: the task gets it, for this run, its folder for files')
  assert.equal(card.payload.stage, 'fill'); assert.equal(card.payload.blocking, true)
  assert.match(card.payload.why, /the publish button is yours/)
  await until('the run waiting for the person', () => engine.get(r.id).status === 'waiting')
  await op('approve', { id: card.id, payload: { choice: 0 } })
  assert.equal((await finished(r.id)).status, 'done', 'the person did it: the run goes on')
  // no browser here: a step that needs to be signed in fails plainly; one that does not, goes on without it
  sharedBrowserSvc.on = false
  const r2 = (await op('startRun', { workflow: 'web-form', title: 'No browser' })).run
  assert.equal((await finished(r2.id)).status, 'failed')
  assert.match(JSON.stringify(engine.get(r2.id)), /needs the agents' browser/)
  assert.deepEqual((await op('workflowSave', { definition: { ...def, id: 'web-form2', steps: def.steps.map(x => (x.id === 'fill' ? { ...x, login: undefined } : x)) }, enable: true })).errors, [])
  members.dshy = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { ok: true, summary: 'done without it' } })
  const r3 = (await op('startRun', { workflow: 'web-form2', title: 'Without' })).run
  assert.equal((await finished(r3.id)).status, 'done')
  assert.ok(wb.store.evidence(r3.id).some(e => /the agents' browser is not here/.test(e.title)))
  // the definition says it plainly
  assert.match(JSON.stringify((await op('workflowSave', { definition: { ...def, id: 'wf-bad', steps: def.steps.map(x => (x.id === 'fill' ? { ...x, browser: 'mine' } : x)) } })).errors), /browser is shared/)
  assert.match(JSON.stringify((await op('workflowSave', { definition: { ...def, id: 'wf-bad2', steps: def.steps.map(x => (x.id === 'fill' ? { ...x, browser: undefined } : x)) } })).errors), /login is for a step with browser: shared/)
  hub.assign = keep
}

// ── a review with a loop of its own (lib/review.js): the person's comments where they point and their own change go to
// the agent that made the work, which revises in the step and answers each one; round after round, then approved ──
{
  const briefs = []
  members.dshy = async ({ mcp, task }) => {
    // (a CLI agent writes in the run's folder itself)
    const a = bridge(mcp), put = text => writeFileSync(join(engine.get(rid).dir, 'draft.md'), text)
    if (task.includes('Write it.')) {
      put('# Title\n\nThe first paragraph is long.\n\nSecond.\n')
      return a.call('stage_result', { result: { ok: true, summary: 'wrote draft.md' } })
    }
    briefs.push(task)
    const draft = readFileSync(join(engine.get(rid).dir, 'draft.md'), 'utf8')
    if (briefs.length === 1) {
      // every comment is answered, and only those it was given — else the same task is told so
      await assert.rejects(a.call('stage_result', { result: { summary: 'x', replies: [{ id: 'c1', status: 'done', reply: 'shortened' }] } }), /none yet for c2/)
      await assert.rejects(a.call('stage_result', { result: { summary: 'x', replies: [{ id: 'c1', status: 'done', reply: 'a' }, { id: 'c2', status: 'done', reply: 'b' }, { id: 'c9', status: 'done', reply: 'c' }] } }), /c9 is not a comment you were given/)
      put(draft.replace('The first paragraph is long.', 'Short.'))
      return a.call('stage_result', { result: { summary: 'shortened the first paragraph', replies: [{ id: 'c1', status: 'done', reply: 'shortened it' }, { id: 'c2', status: 'declined', reply: 'the title stays: it is the brand' }] } })
    }
    put(draft.replace('# Title', '# A better title') + '\nThe end.\n')
    return a.call('stage_result', { result: { summary: 'renamed the title, added an ending', replies: [{ id: 'c2', status: 'done', reply: 'renamed it' }, { id: 'c3', status: 'done', reply: 'added one' }] } })
  }
  const def = { id: 'reviewed', title: 'Reviewed', base: 'blank', steps: [{ use: 'intake' },
    { id: 'write', use: 'agent', title: 'Write', agent: 'dshy', access: 'write', instructions: 'Write it.' },
    { id: 'look', use: 'person', ask: 'review', title: 'Look', text: 'Look at the draft.', show: ['draft.md'], back: 'write', rounds: 2 },
    { id: 'after', use: 'script', title: 'After', run: 'true' }, { use: 'report' }] }
  assert.deepEqual((await op('workflowSave', { definition: def, enable: true })).errors, [])
  assert.match(JSON.stringify((await op('workflowSave', { definition: { ...def, id: 'reviewed-bad', steps: def.steps.map(x => (x.id === 'look' ? { ...x, revisedBy: 'after', rounds: 99 } : x)) } })).errors), /revisedBy: "after" is not an agent step before it.*rounds: 1–20|rounds: 1–20.*revisedBy/)
  const rid = (await op('startRun', { workflow: 'reviewed', title: 'A draft' })).run.id
  const card = n => until(`the review card, round ${n}`, () => wb.store.list('approval').find(x => x.runId === rid && x.title === (n > 1 ? `Look · round ${n}` : 'Look') && x.status === 'pending'))
  const actions = c => c.payload.options.map(o => o.action)

  // round 1: what it shows, who revises; comments on a passage and on a line, a change of the person's own
  let c = await card(1)
  assert.equal(c.payload.editor, 'workbench.review')
  assert.deepEqual(actions(c), ['accept', 'amend', 'revise', 'stop'])
  let { review } = await op('reviewOf', { id: rid, stage: 'look' })
  assert.deepEqual([review.round, review.files, review.agent, review.max, review.status], [1, ['draft.md'], 'write', 2, 'person'])
  await assert.rejects(op('reviewSave', { id: rid, stage: 'look', comments: [{ id: 'c1', file: 'other.md', text: 'x' }] }), /not one of the files under review/)
  await assert.rejects(op('reviewSave', { id: rid, stage: 'look', comments: [{ id: 'c1', file: 'draft.md', at: { box: [0.5, 0.5, 0.9, 0.1] }, text: 'x' }] }), /box/)
  const oldReviewRevision = review.commentsRevision
  review = (await op('reviewSave', { id: rid, stage: 'look', revision: oldReviewRevision, comments: [
    { id: 'c1', file: 'draft.md', at: { quote: 'The first paragraph is long.', prefix: 'Title\n\n', suffix: '\n\nSecond' }, text: 'Make it short.' },
    { id: 'c2', file: 'draft.md', at: { lines: [1, 1] }, text: 'A better title?' }] })).review
  await assert.rejects(op('reviewSave', { id: rid, stage: 'look', revision: oldReviewRevision, comments: [{ id: 'c1', text: 'Overwrite' }] }), e => e.code === 'commentsChanged')
  assert.deepEqual((await op('reviewOf', { id: rid, stage: 'look' })).review.comments, review.comments)
  assert.deepEqual(review.comments.map(x => [x.id, x.status, x.round]), [['c1', 'open', 1], ['c2', 'open', 1]])
  const work = await op('fileAt', { id: rid, commit: 'WORK', path: 'draft.md' })
  await op('editFile', { id: rid, path: 'draft.md', content: work.text.replace('Second.', 'Second, as I want it.'), blob: work.blob })
  await op('approve', { id: c.id, payload: { choice: 1 } })

  // round 2: the agent was given each comment where it points and the person's change; it answered every one
  c = await card(2)
  assert.match(briefs[0], /- \[c1\] draft\.md — on the passage "The first paragraph is long\." \(after "…Title ", before " Second…"\): Make it short\./)
  assert.match(briefs[0], /- \[c2\] draft\.md — line 1: A better title\?/)
  assert.match(briefs[0], /What the person changed themselves \(keep it; do not undo it\)\n```diff\n[\s\S]*\+Second, as I want it\./)
  review = (await op('reviewOf', { id: rid, stage: 'look' })).review
  assert.deepEqual(review.comments.map(x => [x.id, x.status, x.reply]), [['c1', 'done', 'shortened it'], ['c2', 'declined', 'the title stays: it is the brand']])
  assert.equal(review.rounds[0].summary, 'shortened the first paragraph')
  assert.equal(review.rounds[1].version, review.version)
  assert.match(readFileSync(join(engine.get(rid).dir, 'draft.md'), 'utf8'), /Short\.\n\nSecond, as I want it\./, 'the agent kept the person\'s change')
  // an answered comment keeps its words (the person may only open it again); a new one on the whole
  review = (await op('reviewSave', { id: rid, stage: 'look', comments: [
    { id: 'c1', file: 'draft.md', text: 'changed words', status: 'done' }, { id: 'c2', status: 'open' }, { id: 'c3', text: 'It needs an ending.' }] })).review
  assert.deepEqual(review.comments.map(x => [x.id, x.status, x.text]), [['c1', 'done', 'Make it short.'], ['c2', 'open', 'A better title?'], ['c3', 'open', 'It needs an ending.']])
  assert.equal(review.comments[1].reopenedIn, 2)
  await op('approve', { id: c.id, payload: { choice: 1 } })

  // round 3: two revisions were all it allows — approve, send back or stop; approved, the run goes on
  c = await card(3)
  assert.match(briefs[1], /- \[c2\] draft\.md — line 1: A better title\?\n {2}\(you answered this before: "the title stays: it is the brand" — the person opened it again\)/)
  assert.match(briefs[1], /- \[c3\] the whole: It needs an ending\./)
  assert.ok(!briefs[1].includes('[c1]'), 'what is done is not sent again')
  assert.deepEqual(actions(c), ['accept', 'revise', 'stop'])
  await op('approve', { id: c.id, payload: { choice: 0 } })
  const end = await finished(rid)
  assert.equal(end.status, 'done')
  assert.equal(end.stages.find(x => x.key === 'after').status, 'passed')
  assert.deepEqual(end.outputs.look, { verdict: 'approve', rounds: 3, comments: 3, ok: true })
  assert.equal(end.reviews.look.status, 'done')
  await assert.rejects(op('reviewSave', { id: rid, stage: 'look', comments: [] }), /not waiting for you now/)
  // each round's version, and the ledger has what was said and answered
  const marks = (await op('versions', { id: rid })).commits.map(x => x.mark).filter(m => m?.kind === 'review')
  assert.deepEqual(marks.map(m => [m.step, m.round]), [['look', 1], ['look', 2]])
  const said = wb.store.evidence(rid).filter(e => e.stage === 'look' && e.kind === 'gate').map(e => e.title)
  assert.ok(said.some(x => /^Look, round 1: Revise with my notes — 2 comment\(s\)$/.test(x)) && said.some(x => /^Look, round 2: write — renamed the title/.test(x)) && said.some(x => /^Look, round 3: Approve$/.test(x)), said.join(' | '))
  // the media route: images, video, audio, PDF of the run's folder only — nothing a browser runs, nothing outside it
  writeFileSync(join(end.dir, 'clip.mp4'), Buffer.alloc(64, 1)); writeFileSync(join(end.dir, 'page.html'), '<script>x</script>')
  const route = routes['/api/ruyix-workbench/work']
  const at = async q => route.fetch(new Request(`http://dsh.test/api/ruyix-workbench/work?${new URLSearchParams(q)}`, { headers: { range: 'bytes=0-9' } }))
  assert.equal((await at({ run: rid, path: 'clip.mp4' })).status, 206)
  assert.equal((await at({ run: rid, path: 'page.html' })).status, 415)
  assert.equal((await at({ run: rid, path: '../work/clip.mp4' })).status, 404)
  assert.equal((await at({ run: 'nope', path: 'clip.mp4' })).status, 404)
}

// ── a run's results (lib/results.js): a 结果 step names them, the person comments, the run goes on again from a step
// they pick with those comments in its brief; a web page's own files put in (lib/pages.js); a review sends work back to
// a step picked on its page ──
{
  const briefs = []
  let rid3 = null
  const dir = () => engine.get(rid3).dir
  members.dshy = async ({ mcp, task }) => {
    briefs.push(task)
    mkdirSync(join(dir(), 'site'), { recursive: true })
    writeFileSync(join(dir(), 'report.md'), `# Report ${briefs.length}\n\nIt went well.\n`)
    writeFileSync(join(dir(), 'site', 'index.html'), '<html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script><script src="https://cdn.example/x.js"></script></head><body><img src="logo.png"><div style="background:url(bg.png)"></div><img src="../../escape.png"></body></html>')
    writeFileSync(join(dir(), 'site', 'style.css'), 'body { background: url("bg.png") }')
    writeFileSync(join(dir(), 'site', 'app.js'), 'document.title = "ok"')
    writeFileSync(join(dir(), 'site', 'logo.png'), png)
    writeFileSync(join(dir(), 'site', 'bg.png'), png)
    writeFileSync(join(dir(), 'notes.txt'), 'scratch')
    return bridge(mcp).call('stage_result', { result: { ok: true, summary: `made ${briefs.length}` } })
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const def = { id: 'with-results', title: 'With results', base: 'blank', steps: [{ use: 'intake' },
    { id: 'make', use: 'agent', title: 'Make', agent: 'dshy', access: 'write', instructions: 'Make the report.' },
    { id: 'shown', use: 'output', title: 'The report', show: ['report.md', 'site/index.html'] },
    { use: 'report' }] }
  assert.deepEqual((await op('workflowSave', { definition: def, enable: true })).errors, [])
  assert.match(JSON.stringify((await op('workflowSave', { definition: { ...def, id: 'with-results-bad', steps: def.steps.map(x => (x.id === 'shown' ? { ...x, show: ['/etc/passwd'] } : x)) } })).errors), /show: at most/)
  rid3 = (await op('startRun', { workflow: 'with-results', title: 'Results' })).run.id
  let end = await finished(rid3)
  assert.equal(end.status, 'done')
  assert.deepEqual(end.outputs.shown.files, ['report.md', 'site/index.html'], 'the 结果 step names its files, in its order, and waits for nobody')
  let res = await op('resultsOf', { id: rid3 })
  assert.deepEqual([res.files, res.declared, res.steps.map(x => x.key), res.comments], [['report.md', 'site/index.html'], true, ['make'], []])
  assert.equal(res.defaultFrom, 'make')
  // the page with its own files put in; what is outside the folder or on the network left as it was
  const page = await op('pageOf', { id: rid3, path: 'site/index.html' })
  assert.match(page.html, /<link rel="stylesheet" href="data:text\/css;base64,/)
  assert.match(page.html, /<script src="data:text\/javascript;base64,/)
  assert.match(page.html, /<img src="data:image\/png;base64,/)
  assert.match(page.html, /url\("data:image\/png;base64,/)
  assert.ok(Buffer.from(page.html.match(/href="data:text\/css;base64,([^"]+)"/)[1], 'base64').toString().includes('url("data:image/png;base64,'), 'a stylesheet\'s own url() too')
  assert.deepEqual(page.left, ['../../escape.png'], 'out of the folder: left as it was (a public URL loads by itself, it is not counted)')
  assert.ok(page.html.includes('src="https://cdn.example/x.js"'))
  assert.deepEqual(page.inlined.sort(), ['site/app.js', 'site/bg.png', 'site/bg.png', 'site/logo.png', 'site/style.css'])
  await assert.rejects(op('pageOf', { id: rid3, path: '../x.html' }), /not in the run's folder/)
  // comments on the results, a PDF page's box among them; then on again from a step, with them
  const oldResultsRevision = res.revision
  res = { comments: (await op('resultsSave', { id: rid3, revision: oldResultsRevision, comments: [
    { id: 'c1', file: 'report.md', at: { quote: 'It went well.', prefix: '', suffix: '' }, text: 'Say what went well.' },
    { id: 'c2', file: 'site/index.html', at: null, text: 'The logo is too small.' },
    { id: 'c3', file: null, at: { box: [0.1, 0.1, 0.5, 0.2], page: 2 }, text: 'Page 2 header.' }] })).comments }
  await assert.rejects(op('resultsSave', { id: rid3, revision: oldResultsRevision, comments: [] }), e => e.code === 'commentsChanged')
  assert.deepEqual((await op('resultsOf', { id: rid3 })).comments, res.comments)
  assert.deepEqual(res.comments.map(c => [c.id, c.status]), [['c1', 'open'], ['c2', 'open'], ['c3', 'open']])
  await assert.rejects(op('resultsSave', { id: rid3, comments: [{ id: 'c1', file: 'notes.txt', text: 'x' }] }), /not one of the files under review/)
  await assert.rejects(op('resultsRestart', { id: rid3, from: 'intake' }), /cannot go on from "intake"/)
  await op('resultsRestart', { id: rid3 })
  end = await finished(rid3)
  assert.equal(end.status, 'done')
  assert.match(briefs.at(-1), /the person looked at the results and left these comments[\s\S]*- report\.md — on the passage "It went well\."[^\n]*: Say what went well\.[\s\S]*- site\/index\.html: The logo is too small\.[\s\S]*- the whole — page 2, the part 10%–60% from the left, 10%–30% from the top: Page 2 header\./)
  res = await op('resultsOf', { id: rid3 })
  assert.deepEqual(res.comments.map(c => [c.id, c.status, c.sentTo]), [['c1', 'sent', 'make'], ['c2', 'sent', 'make'], ['c3', 'sent', 'make']])
  assert.deepEqual(res.restarts.map(r => [r.n, r.from, r.comments.length]), [[1, 'make', 3]])
  {
    const beforeResults=wb.engine.get(rid3).results, originalContinue=wb.engine.continueRun
    const first=await op('resultsSave',{id:rid3,revision:res.revision,comments:[...res.comments,{id:'c4',file:'report.md',at:null,text:'original feedback'}]})
    let release, deliveredNote
    wb.engine.continueRun=async (_id,options)=>{deliveredNote=options.note;await new Promise(r=>{release=r});return {run:wb.engine.get(rid3)}}
    try{
      const restarting=op('resultsRestart',{id:rid3,from:'make'})
      await until('restart admitted',()=>release)
      await op('resultsSave',{id:rid3,revision:first.revision,comments:first.comments.map(c=>c.id==='c4'?{...c,text:'edited during restart'}:c)})
      release();await restarting
      const after=await op('resultsOf',{id:rid3})
      assert.equal(after.comments.find(c=>c.id==='c4').status,'open','new words were not delivered and remain editable')
      assert.ok(deliveredNote.includes('original feedback')&&!deliveredNote.includes('edited during restart'))
      assert.equal(after.restarts.at(-1).delivered.find(c=>c.id==='c4').text,'original feedback')
      const overlong=await op('resultsSave',{id:rid3,revision:after.revision,comments:after.comments.map(c=>c.id==='c4'?{...c,text:'x'.repeat(4000)}:c)})
      await assert.rejects(op('resultsRestart',{id:rid3,from:'make'}),e=>e.code==='commentsTooLong')
      assert.equal((await op('resultsOf',{id:rid3})).comments.find(c=>c.id==='c4').status,'open','oversize feedback is never falsely marked delivered')
    }finally{release?.();wb.engine.continueRun=originalContinue;wb.store.put('run',{...wb.engine.get(rid3),results:beforeResults})}
  }
  // a run without 结果 steps: what it changed since it began
  await op('workflowSave', { definition: { ...def, id: 'without-results', steps: def.steps.filter(x => x.id !== 'shown') }, enable: true })
  rid3 = (await op('startRun', { workflow: 'without-results', title: 'No 结果 step' })).run.id
  await finished(rid3)
  res = await op('resultsOf', { id: rid3 })
  assert.deepEqual([res.files.sort(), res.declared], [['notes.txt', 'report.md', 'site/app.js', 'site/bg.png', 'site/index.html', 'site/logo.png', 'site/style.css'], false])
  // the stream: any file as a download, only media to show; pdf.js for the viewer
  const at = async q => routes['/api/ruyix-workbench/work'].fetch(new Request(`http://x/api/ruyix-workbench/work?${new URLSearchParams(q)}`))
  assert.equal((await at({ run: rid3, path: 'notes.txt' })).status, 415)
  const dl = await at({ run: rid3, path: 'notes.txt', download: '1' })
  assert.deepEqual([dl.status, dl.headers.get('content-disposition').startsWith('attachment')], [200, true])
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const r = await routes[`/api/ruyix-workbench/pdfjs/${f}`].fetch(new Request(`http://x/api/ruyix-workbench/pdfjs/${f}`))
    assert.ok(r.status === 200 && r.headers.get('content-type').startsWith('text/javascript') && (await r.text()).length > 100000, f)
  }
}
{
  // a review sends the work back to the step picked on its page (of those before it), else to the one it names
  const ran = []
  members.dshy = async ({ mcp, task }) => { ran.push(task.includes('First.') ? 'first' : 'second'); writeFileSync(join(engine.get(rid4).dir, 'out.md'), `v${ran.length}`); return bridge(mcp).call('stage_result', { result: { ok: true, summary: 'ok' } }) }
  let rid4 = null
  await op('workflowSave', { definition: { id: 'picked-back', title: 'Picked back', base: 'blank', steps: [{ use: 'intake' },
    { id: 'first', use: 'agent', title: 'First', agent: 'dshy', access: 'write', instructions: 'First.' },
    { id: 'second', use: 'agent', title: 'Second', agent: 'dshy', access: 'write', instructions: 'Second.' },
    { id: 'look', use: 'person', ask: 'review', title: 'Look', text: 'Look.', show: ['out.md'], back: 'second' }, { use: 'report' }] }, enable: true })
  rid4 = (await op('startRun', { workflow: 'picked-back', title: 'Picked' })).run.id
  const card = await until('the review card', () => wb.store.list('approval').find(x => x.runId === rid4 && x.title === 'Look' && x.status === 'pending'))
  assert.deepEqual(card.payload.review.backTo.map(b => b.key), ['first', 'second'])
  assert.equal(card.payload.options.find(o => o.action === 'revise').from, 'second')
  await op('reviewSave', { id: rid4, stage: 'look', comments: [{ id: 'c1', text: 'Start over.' }] })
  await op('approve', { id: card.id, payload: { choice: card.payload.options.findIndex(o => o.action === 'revise'), from: 'first' } })
  const again = await until('the review again', () => wb.store.list('approval').find(x => x.runId === rid4 && x.title === 'Look' && x.status === 'pending' && x.id !== card.id))
  assert.deepEqual(ran, ['first', 'second', 'first', 'second'], 'back to the step picked, not the one it names')
  assert.ok(engine.get(rid4).guidance.some(g => g.stage === 'first' && /Start over\./.test(g.text)))
  await op('approve', { id: again.id, payload: { choice: 0 } })
  assert.equal((await finished(rid4)).status, 'done')
}

// ── the task workflow: one agent does a request, in the person's folder or the run's own; done / partial / blocked ──
{
  assert.ok((await op('workflows')).builtIn.some(w => w.id === 'task' && w.input.some(f => f.name === 'folder')), 'a built-in like blank, with an optional folder')
  const folder = mkdtempSync(join(tmp, 'task-folder-')), briefs = []
  const outcomes = [
    { outcome: 'done', summary: 'Wrote the notes.', done: ['wrote notes.md'], files: ['notes.md'] },
    { outcome: 'partial', summary: 'Half of it.', done: ['wrote a'], left: ['write b: no time'] },
    { outcome: 'blocked', summary: 'No access.', left: ['needs the staging password'] },
    { outcome: 'blocked', summary: 'Still no access.', left: ['needs the staging password'] },
    { outcome: 'done', summary: 'Got in with the password.', done: ['logged in'] },
    { summary: 'says nothing clear' },
  ]
  members.sonnet = async ({ mcp, task }) => { briefs.push(task); return bridge(mcp).call('stage_result', { result: outcomes[briefs.length - 1] }) }
  const run = async (fields = {}, title = 'Write notes') => finished((await op('startRun', { workflow: 'task', title, text: 'Write the notes.', fields })).run.id)
  // done, in the folder the person named
  const a = await run({ folder })
  assert.equal(a.folder, folder)
  assert.equal(hub.started.at(-1).cwd, folder, 'the agents work in that folder')
  assert.ok(briefs[0].includes(`Your working folder is ${folder}`) && /## Your task: do what the request asks/.test(briefs[0]))
  assert.deepEqual([a.status, a.verdict.level, a.outcome.status, a.outcome.files], ['done', 'completed', 'done', ['notes.md']])
  const md = (await op('report', { id: a.id })).markdown
  assert.match(md, /Verdict: Task completed[\s\S]*## Outcome\n\n\*\*done\*\* — Wrote the notes\.[\s\S]*### Done\n- wrote notes\.md[\s\S]*### Files\n- `notes\.md`/)
  // partly done: a verdict of its own, the run is done all the same
  const b = await run()
  assert.equal(b.folder, undefined)
  assert.equal(hub.started.at(-1).cwd, b.dir, 'no folder named: the run\'s own')
  assert.deepEqual([b.status, b.verdict.level], ['done', 'partial'])
  assert.match((await op('report', { id: b.id })).markdown, /Verdict: Task partly done[\s\S]*### Left\n- write b: no time/)
  // blocked: the person is asked for what it needs — go on as it is, and the run ends saying what is missing
  const askOf = async id => until('the person is asked', () => wb.store.list('approval').find(x => x.runId === id && x.action === 'help' && x.status === 'pending'))
  const c0 = (await op('startRun', { workflow: 'task', title: 'Blocked', text: 'Get in.' })).run
  const stuck = await askOf(c0.id)
  assert.deepEqual([stuck.payload.kind, stuck.payload.stage, stuck.title], ['stuck', 'work', 'work: needs the staging password'])
  assert.deepEqual([engine.get(c0.id).status, engine.get(c0.id).waiting], ['waiting', 'person'])
  await op('approve', { id: stuck.id, payload: { answer: 'continue' } })
  const c = await finished(c0.id)
  assert.deepEqual([c.status, c.verdict.level, c.verdict.reason], ['done', 'need_info', 'needs the staging password'])
  assert.match((await op('report', { id: c.id })).markdown, /Verdict: Needs more information[\s\S]*### Left\n- needs the staging password/)
  // …or told what it lacked: the step goes again with the words in its brief
  const e0 = (await op('startRun', { workflow: 'task', title: 'Blocked again', text: 'Get in.' })).run
  const stuck2 = await askOf(e0.id)
  await assert.rejects(op('approve', { id: stuck2.id, payload: { answer: 'retry' } }), /say what the step should know/)
  await op('approve', { id: stuck2.id, payload: { answer: 'retry', input: 'the password is in the vault under staging' } })
  const e = await finished(e0.id)
  assert.match(briefs.at(-1), /## What the person said \(build on it\)\n- the password is in the vault under staging/)
  assert.deepEqual([e.verdict.level, e.outcome.status, e.helps.map(h => [h.stage, h.kind, h.answer])], ['completed', 'done', [['work', 'stuck', 'retry']]])
  // a result that says nothing clear is partial, not completed
  assert.equal((await run()).verdict.level, 'partial')
  // a folder that is not one, or not a full path, is refused before a run is made
  const runs = (await op('sync', { since: 0 })).docs.filter(d => d.kind === 'run').length
  await assert.rejects(op('startRun', { workflow: 'task', title: 'x', fields: { folder: join(folder, 'nowhere') } }), /is not a folder here/)
  await assert.rejects(op('startRun', { workflow: 'task', title: 'x', fields: { folder: 'relative/dir' } }), /give its full path/)
  assert.equal((await op('sync', { since: 0 })).docs.filter(d => d.kind === 'run').length, runs)
  // a workflow of one's own built on it keeps the folder
  await op('workflowSave', { definition: { id: 'task-mine', title: 'Task mine', base: 'task', steps: [{ use: 'intake' }, { use: 'work' }, { use: 'report' }] }, enable: true })
  members.sonnet = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { outcome: 'done', summary: 'ok' } })
  const d = await finished((await op('startRun', { workflow: 'task-mine', title: 'Mine', fields: { folder } })).run.id)
  assert.deepEqual([d.folder, d.verdict.level], [folder, 'completed'])
}

// ── a step asks the person on its own: help_needed, a low confidence, stuck; the run waits, a reminder never answers ──
{
  const { overdue } = await import('./src/inbox.js')
  await op('workflowSave', { definition: { id: 'asks', title: 'Asks', base: 'blank', steps: [{ use: 'intake' }, { id: 'look', use: 'agent', title: 'Look', agent: 'dshy', instructions: 'Look into it.', human: { below: 70, wait: 1 } }, { use: 'report' }] }, enable: true })
  const asked = []
  // (an agent's help_needed makes its card at once; the step's end takes it up — its round and reminder — a moment later)
  const cardOf = (id, n) => until('the person is asked', () => { const c = wb.store.list('approval').filter(x => x.runId === id && x.action === 'help').sort((p, q) => p.createdAt - q.createdAt)[n]; return c?.status === 'pending' && c.payload?.deadline !== undefined && c })
  members.dshy = async ({ mcp, task }) => {
    const a = bridge(mcp)
    // the person's question about the waiting step: its agent has the record to read and nothing else
    if (/^# A question about the step "look"/.test(task)) {
      assert.deepEqual((await a.tools()).map(t => t.name).sort(), ['evidence_get', 'wb_context'])
      assert.match(task, /Which key\?[\s\S]*## The question\nWhat did you try first\?/)
      asked.push('question')
      return 'It tried the probe file first (#2).'
    }
    asked.push('attempt')
    const n = asked.filter(x => x === 'attempt').length
    if (n === 1) {
      const saved = await a.call('file_save', { name: 'probe.txt', content: 'x' })
      const seq = /evidence #(\d+)/.exec(saved)[1]
      await assert.rejects(a.call('help_needed', { question: 'Which key?', tried: 'looked around' }), /cite the evidence of what you tried as #n/)
      await assert.rejects(a.call('help_needed', { question: '', tried: `#${seq}` }), /say what you need/)
      assert.match(await a.call('help_needed', { question: 'Which key?', tried: `probe.txt #${seq}`, would_help: 'the key name' }), /^Asked \(\w+\)\. Finish this step/)
      return a.call('stage_result', { result: { ok: true, summary: 'could not tell which key', confidence: 90 } })
    }
    if (n === 2) {
      assert.match(task, /## What the person said \(build on it\)\n- use the staging key/)
      return a.call('stage_result', { result: { ok: true, summary: 'a guess with the staging key', confidence: 40 } })
    }
    return a.call('stage_result', { result: { ok: true, summary: 'sure now', confidence: 95 } })
  }
  const r0 = (await op('startRun', { workflow: 'asks', title: 'Which key', text: 'Find the key.' })).run
  // its agent asked: the run waits at the step, the step counts as running, the card says what was tried
  await until('the run waits', () => engine.get(r0.id).waiting === 'person')
  const c1 = wb.store.get('approval', (await cardOf(r0.id, 0)).id)
  assert.deepEqual([c1.payload.kind, c1.payload.stage, c1.payload.round, c1.payload.by, c1.title], ['agent', 'look', 1, 'workflow', 'Which key?'])
  assert.match(c1.payload.why, /^probe\.txt #\d+\n\nWould help: the key name$/)
  assert.deepEqual([engine.get(r0.id).status, engine.get(r0.id).waiting, engine.get(r0.id).waitingFor], ['waiting', 'person', c1.id])
  assert.deepEqual(engine.get(r0.id).stages.find(s => s.key === 'look').status, 'running', 'a restart picks the step up at its wait')
  assert.equal(wb.store.get('approval', c1.id).payload.wait, 1)
  // the person asks the step's agent while it waits
  await assert.rejects(op('askHelp', { id: c1.id, text: '  ' }), /write the question first/)
  await op('askHelp', { id: c1.id, text: 'What did you try first?' })
  const asked1 = await until('the answer', () => wb.store.get('approval', c1.id).chat?.[0]?.answer)
  assert.equal(asked1, 'It tried the probe file first (#2).')
  assert.deepEqual(engine.get(r0.id).stages.find(s => s.key === 'look').asking, c1.id)
  // nobody answers in time: a reminder — the run keeps waiting, nothing is decided on the clock
  assert.equal(overdue(wb.store.get('approval', c1.id)), false)
  wb.store.put('approval', { ...wb.store.get('approval', c1.id), payload: { ...wb.store.get('approval', c1.id).payload, deadline: Date.now() - 1 } })
  await until('the reminder', () => wb.store.get('approval', c1.id).payload.remindedAt)
  assert.equal(overdue(wb.store.get('approval', c1.id)), true)
  assert.ok(wb.store.evidence(r0.id).some(e => /no answer within 1 h: the person is reminded, the run keeps waiting/.test(e.title)))
  await sleep(120)
  assert.deepEqual([engine.get(r0.id).status, wb.store.get('approval', c1.id).status], ['waiting', 'pending'], 'still waiting after the reminder')
  // the answer: run it again with what the person knows
  await assert.rejects(op('approve', { id: c1.id, payload: { answer: 'retry' } }), /say what the step should know/)
  await op('approve', { id: c1.id, payload: { answer: 'retry', input: 'use the staging key' } })
  // the second attempt is under the step's bar (40 < 70): asked again, as low
  const c2 = await cardOf(r0.id, 1)
  assert.deepEqual([c2.payload.kind, c2.payload.score, c2.payload.bar, c2.payload.round], ['low', 40, 70, 2])
  assert.equal(c2.title, 'look: 40/100 is under the bar of 70')
  await op('approve', { id: c2.id, payload: { answer: 'continue' } }) // "it is fine as it is": the outcome stands
  const end = await finished(r0.id)
  assert.deepEqual([end.status, end.verdict.level], ['done', 'done'])
  assert.deepEqual(end.helps.map(h => [h.stage, h.kind, h.answer, h.input]), [['look', 'agent', 'retry', 'use the staging key'], ['look', 'low', 'continue', '']])
  assert.deepEqual(end.stages.find(s => s.key === 'look').asking, null)
  assert.equal(end.stages.find(s => s.key === 'look').status, 'passed')
  assert.equal(end.outputs.look.confidence, 40)
  assert.equal(asked.filter(x => x === 'question').length, 1)
  assert.ok(wb.store.evidence(r0.id).some(e => /^the person is asked \(its agent asked\): Which key\?/.test(e.title)))

  // a step asks at most three times: the fourth help_needed is refused, the step goes on without a person
  asked.length = 0
  let tries = 0
  members.dshy = async ({ mcp }) => {
    const a = bridge(mcp)
    tries++
    if (tries <= 3) {
      await a.call('help_needed', { question: `Round ${tries}?`, tried: 'see #1' })
      return a.call('stage_result', { result: { ok: true, summary: 'waiting', confidence: 80 } })
    }
    await assert.rejects(a.call('help_needed', { question: 'Round 4?', tried: 'see #1' }), /asked 3 times already/)
    return a.call('stage_result', { result: { ok: true, summary: 'did what it could', confidence: 80 } })
  }
  const r1 = (await op('startRun', { workflow: 'asks', title: 'Rounds', text: 'x' })).run
  for (const n of [0, 1, 2]) {
    const card = await cardOf(r1.id, n)
    assert.equal(card.payload.round, n + 1)
    await op('approve', { id: card.id, payload: { answer: 'retry', input: `try ${n + 1}` } })
  }
  const end1 = await finished(r1.id)
  assert.deepEqual([tries, end1.status, end1.helps.length, wb.store.list('approval').filter(x => x.runId === r1.id && x.action === 'help').length], [4, 'done', 3, 3])

  // stuck, and the person stops it: the run ends there, with their words
  await op('workflowSave', { definition: { id: 'stucks', title: 'Stucks', base: 'blank', steps: [{ use: 'intake' }, { id: 'look', use: 'agent', title: 'Look', agent: 'dshy', instructions: 'Look into it.', human: { stuck: true } }, { id: 'after', use: 'script', title: 'After', run: 'true' }, { use: 'report' }] }, enable: true })
  members.dshy = ({ mcp }) => bridge(mcp).call('stage_result', { result: { ok: false, summary: 'no access to the host' } })
  const r2 = (await op('startRun', { workflow: 'stucks', title: 'Stuck', text: 'x' })).run
  const c3 = await cardOf(r2.id, 0)
  assert.deepEqual([c3.payload.kind, c3.title], ['stuck', 'look: no access to the host'])
  await op('approve', { id: c3.id, payload: { answer: 'stop', input: 'enough for today' } })
  const end2 = await finished(r2.id)
  assert.deepEqual([end2.status, end2.verdict.level, end2.verdict.stopped], ['failed', 'failed', 'look'])
  assert.equal(end2.stages.find(s => s.key === 'look').note, 'stopped by the person: enough for today')
  assert.equal(end2.stages.find(s => s.key === 'after').status, 'skipped', 'nothing after the step ran')
  // rejecting the card is stopping, too; a stuck step with no person asked (stuck: false) just fails
  const r3 = (await op('startRun', { workflow: 'stucks', title: 'Stuck 2', text: 'x' })).run
  await op('reject', { id: (await cardOf(r3.id, 0)).id, reason: 'no' })
  assert.equal((await finished(r3.id)).verdict.stopped, 'look')
  // a card the run left open when it ended is closed with it
  const r4 = (await op('startRun', { workflow: 'stucks', title: 'Stuck 3', text: 'x' })).run
  const c5 = await cardOf(r4.id, 0)
  engine.stopRun(r4.id)
  assert.equal((await finished(r4.id)).status, 'cancelled')
  assert.deepEqual([wb.store.get('approval', c5.id).status, wb.store.get('approval', c5.id).reason], ['rejected', 'the run ended (cancelled)'])
}

// An answer before the asking agent ends must be consumed, including stop and reject.
{
  await op('workflowSave', { definition: { id: 'early-answers', title: 'Early answers', base: 'blank', steps: [
    { use: 'intake' }, { id: 'work', use: 'agent', agent: 'dshy', instructions: 'EARLY_HELP_PROBE' },
    { id: 'later', use: 'agent', agent: 'dshy', instructions: 'EARLY_LATER_PROBE' }, { use: 'report' },
  ] }, enable: true })
  for (const mode of ['stop', 'reject', 'retry']) {
    let release, asked, attempts = 0, later = 0
    const held = new Promise(r => { release = r }), ready = new Promise(r => { asked = r })
    members.dshy = async ({ mcp, task }) => {
      const a = bridge(mcp)
      if (task.includes('EARLY_LATER_PROBE')) { later++; return a.call('stage_result', { result: { ok: true, summary: 'later' } }) }
      attempts++
      if (attempts === 1) {
        const f = await a.call('file_save', { name: 'early-probe.txt', content: 'looked' }), seq = /evidence #([0-9]+)/.exec(f)[1]
        await a.call('help_needed', { question: `Early ${mode}?`, tried: `probe #${seq}` })
        await a.call('help_needed', { question: 'A detail added', tried: `probe #${seq}` })
        asked(); await held
        const ignored = await a.call('help_needed', { question: 'Do not replace their answer', tried: `probe #${seq}` })
        assert.match(ignored, /already answered/)
      } else assert.match(task, /early guidance kept/, 'the early reply is in the retried step brief')
      return a.call('stage_result', { result: { ok: true, summary: 'step finished' } })
    }
    const r = (await op('startRun', { workflow: 'early-answers', title: mode })).run
    await ready
    const card = wb.store.list('approval').find(a => a.runId === r.id && a.action === 'help')
    assert.equal(card.payload.rev, 1)
    await assert.rejects(op('approve', { id: card.id, payload: { rev: 0, answer: 'stop' } }), { code: 'changedMeanwhile' })
    await assert.rejects(op('reject', { id: card.id, rev: 0, reason: 'old question' }), { code: 'changedMeanwhile' })
    if (mode === 'reject') await op('reject', { id: card.id, rev: 1, reason: 'early rejection' })
    else await op('approve', { id: card.id, payload: { rev: 1, answer: mode, ...(mode === 'retry' && { input: 'early guidance kept' }) } })
    release()
    const done = await finished(r.id)
    assert.equal(done.helps[0].answer, mode === 'reject' ? 'stop' : mode)
    assert.equal(wb.store.get('approval', card.id).applied, true)
    if (mode === 'retry') { assert.equal(attempts, 2); assert.equal(later, 1) }
    else { assert.equal(later, 0); assert.match(done.stages.find(s => s.key === 'work').note, /stopped by the person/) }
  }
}

// ── a discussion (docs/design/agent-work.md §7): a chat step talks with an agent of the run from its record; settled, what
// was agreed goes to the steps after it; or back to a step with it; an agent asks to talk (discuss_with_person) ──
{
  const talks = [], agreedTasks = []
  let digs = 0, askTalk = false
  members.dshy = async ({ mcp, task }) => {
    const a = bridge(mcp)
    if (/^# A discussion with the person/.test(task)) {
      assert.deepEqual((await a.tools()).map(t => t.name).sort(), ['evidence_get', 'wb_context'], 'from the record only: it changes nothing')
      if (/## Your task\nThe person says it is settled/.test(task)) { talks.push('agreed'); agreedTasks.push(task); assert.match(task, /## Said so far\n\*\*The person:\*\* \S/); return 'Agreed: angle A, three points.' }
      const q = /## The person says\n([^\n]*)/.exec(task)[1]
      talks.push(q)
      return `About "${q}": angle A fits the findings (#1).`
    }
    digs++
    if (askTalk && digs === 1) {
      await assert.rejects(a.call('discuss_with_person', { topic: '' }), /say what to talk through/)
      assert.match(await a.call('discuss_with_person', { topic: 'Which way to take it?', why: 'Two readings of #1.' }), /^Asked to talk it through \(\w+\)\. Finish this step/)
      return a.call('stage_result', { result: { ok: true, summary: 'two ways open', confidence: 90 } })
    }
    if (digs === 2) assert.match(task, /## What the person said \(build on it\)\n- [\s\S]*Agreed: angle A/, 'the step again knows what was agreed')
    return a.call('stage_result', { result: { ok: true, summary: `dug (${digs})`, confidence: 90 } })
  }
  const def = { id: 'talked', title: 'Talked', base: 'blank', steps: [{ use: 'intake' },
    { id: 'dig', use: 'agent', title: 'Dig', agent: 'dshy', access: 'read', instructions: 'Find out.' },
    { id: 'talk', use: 'person', ask: 'chat', title: 'Talk the findings over', text: 'Agree on the angle before the conclusion.', back: 'dig' },
    { id: 'after', use: 'script', title: 'After', run: 'echo after' }, { use: 'report' }] }
  assert.deepEqual((await op('workflowSave', { definition: def, enable: true })).errors, [])
  const talkCard = (id, n = 0) => until('the discussion', () => wb.store.list('approval').filter(a => a.runId === id && a.payload?.kind === 'chat').sort((p, q) => p.createdAt - q.createdAt)[n]?.status === 'pending' && wb.store.list('approval').filter(a => a.runId === id && a.payload?.kind === 'chat').sort((p, q) => p.createdAt - q.createdAt)[n])
  const r = (await op('startRun', { workflow: 'talked', title: 'Findings', text: 'Look into it.' })).run
  const c = await talkCard(r.id)
  assert.deepEqual([c.payload.with, c.payload.back, c.payload.wait, c.payload.blocking], ['dig', 'dig', 0, true], 'with the agent of the step before; no reminder: it waits as long as it takes')
  assert.equal(engine.get(r.id).status, 'waiting')
  await op('askHelp', { id: c.id, text: 'Which angle?' })
  assert.equal(await until('its reply', () => wb.store.get('approval', c.id).chat?.[0]?.answer), 'About "Which angle?": angle A fits the findings (#1).')
  await assert.rejects(op('approve', { id: c.id, payload: { answer: 'retry' } }), /answer with continue, back, stop/)
  await op('approve', { id: c.id, payload: { answer: 'continue', input: 'Keep it short.' } })
  const end = await finished(r.id)
  assert.equal(end.status, 'done', JSON.stringify(end.stages.map(x => [x.key, x.status, x.note])))
  assert.deepEqual(end.outputs.talk, { settled: 'Agreed: angle A, three points.', note: 'Keep it short.', talked: 1, with: 'dig', ok: true })
  assert.equal(wb.store.get('approval', c.id).settled, end.outputs.talk.settled, 'the card keeps what was agreed')
  assert.ok(end.guidance.some(g => !g.stage && /Agreed: angle A[\s\S]*Keep it short/.test(g.text)), 'every step after it is told')
  assert.ok(wb.store.evidence(r.id).some(e => /Talk the findings over: 1 message with the person — settled/.test(e.title)))
  assert.deepEqual(talks, ['Which angle?', 'agreed'])
  assert.match(agreedTasks[0], /## The person adds \(decided\)\nKeep it short\./, 'what the person adds goes into the write-up')

  // back to the step with what was agreed: it runs again knowing it; a discussion with nothing said settles as it is
  talks.length = 0; digs = 0
  const r2 = (await op('startRun', { workflow: 'talked', title: 'Findings again', text: 'Look into it.' })).run
  const c2 = await talkCard(r2.id)
  await op('askHelp', { id: c2.id, text: 'Is B better?' })
  await until('its reply', () => wb.store.get('approval', c2.id).chat?.[0]?.answer)
  await op('approve', { id: c2.id, payload: { answer: 'back' } })
  const c3 = await talkCard(r2.id, 1)
  assert.equal(engine.get(r2.id).stages.find(x => x.key === 'dig').status, 'passed', 'dug again')
  await op('approve', { id: c3.id, payload: { answer: 'continue' } })
  const end2 = await finished(r2.id)
  assert.equal(end2.status, 'done')
  assert.equal(digs, 2)
  assert.equal(end2.stages.find(x => x.key === 'talk').note, 'nothing to add')

  // its agent asks to talk: the step ends, the person talks it over with it, settled → the step again with what was agreed
  talks.length = 0; digs = 0; askTalk = true
  const r3 = (await op('startRun', { workflow: 'talked', title: 'Ask to talk', text: 'Look into it.' })).run
  const t1 = await until('the talk', () => { const x = wb.store.list('approval').find(a => a.runId === r3.id && a.payload?.talk); return x?.status === 'pending' && x.payload.deadline !== undefined && x })
  assert.deepEqual([t1.payload.kind, t1.payload.with, t1.title], ['agent', 'dig', 'Which way to take it?'])
  await op('askHelp', { id: t1.id, text: 'Which angle?' })
  await until('its reply', () => wb.store.get('approval', t1.id).chat?.[0]?.answer)
  await op('approve', { id: t1.id, payload: { answer: 'settle' } })
  const c4 = await talkCard(r3.id)
  await op('approve', { id: c4.id, payload: { answer: 'continue' } })
  const end3 = await finished(r3.id)
  assert.equal(end3.status, 'done')
  assert.deepEqual(end3.helps.map(h => [h.stage, h.answer]), [['dig', 'retry']], 'settled: the step ran again')
  assert.match(end3.helps[0].input, /^Agreed: angle A/)
  assert.equal(wb.store.get('approval', t1.id).settled, 'Agreed: angle A, three points.', 'the applied talk card keeps its agreed write-up')
  assert.equal(wb.store.get('approval', t1.id).applied, true)
  askTalk = false

  // what a discussion step may say
  const v = steps => op('workflowValidate', { definition: { id: 'talk-check', title: 'T', base: 'blank', steps: [{ use: 'intake' }, ...steps, { use: 'report' }] } }).then(x => x.errors.map(e => e.message).join(' | '))
  assert.match(await v([{ id: 'tt', use: 'person', ask: 'chat', title: 'T', text: 'x', with: 'later' }, { id: 'later', use: 'agent', title: 'L', agent: 'dshy', instructions: 'x' }]), /with: "later" is not an agent step before it/)
  assert.match(await v([{ id: 'ss', use: 'script', title: 'S', run: 'true' }, { id: 'tt', use: 'person', ask: 'chat', title: 'T', text: 'x', with: 'ss' }]), /with: "ss" is not an agent step before it/)
  assert.equal(await v([{ id: 'dd', use: 'agent', title: 'D', agent: 'dshy', instructions: 'x' }, { id: 'tt', use: 'person', ask: 'chat', title: 'T', text: 'x', with: 'dd', back: 'dd' }]), '')
}


// ── every task (docs/design/agent-tasks.md): a workflow's task is to-confirm once its run made something, 好了 makes it
// done, 再改 runs it on from its last step with the words; other sources keep their own state through the service;
// the portfolio is every task's outputs; deleting one that is over takes its runs, their cards, ledger and folder ──
{
  const svc = provided.ruyixWorkbench.tasks
  let briefs = []
  members.dshy = async ({ mcp, task }) => { briefs.push(task); const a = bridge(mcp); await a.call('file_save', { name: 'draft.md', content: '# Draft' }); return a.call('stage_result', { result: { ok: true, summary: 'drafted' } }) }
  assert.deepEqual((await op('workflowSave', { definition: { id: 'tasked', title: 'Tasked', base: 'blank', steps: [{ use: 'intake' }, { id: 'write', use: 'agent', title: 'Write', agent: 'dshy', access: 'write', instructions: 'Write it.' }, { use: 'report' }] }, enable: true })).errors, [])
  const r = await finished((await op('startRun', { workflow: 'tasked', title: 'A post' })).run.id)
  const one = (await op('taskList', {})).tasks.find(x => x.id === r.taskId)
  assert.deepEqual([one.source, one.state, one.workflow, one.lastRunId], ['run', 'to-confirm', 'tasked', r.id], 'it made something: waiting for 好了')
  assert.ok(one.outputs >= 2, 'its file and its report')
  assert.ok(one.agents.some(a => a.id === 'dshy'))
  const got = await op('taskGet', { id: one.id })
  assert.ok(got.timeline.some(e => e.kind === 'step' && e.text === 'Write：做完了'), 'what happened in it, said in the page\'s language')
  assert.equal((await op('taskGet', { run: r.id })).task.id, one.id, 'found by its run (an old link to a run lands on its task)')
  // what it used (its runs: their time, their agents' tokens); who did the tasks, to pick one; a span of time
  assert.ok(one.usage && one.usage.ms >= 0 && Number.isFinite(one.usage.tokens), 'its usage: { tokens, cost, ms }')
  const byWho = await op('taskList', {})
  assert.ok(byWho.agents.some(a => a.id === 'dshy' && a.n >= 1 && a.name), 'the agents who did them, with their names')
  assert.ok((await op('taskList', { agent: 'dshy' })).tasks.every(x => x.agents.some(a => a.id === 'dshy')))
  assert.ok((await op('taskList', { from: one.updatedAt, to: one.updatedAt + 1 })).tasks.some(x => x.id === one.id), 'a span of time: from (in) to (out)')
  assert.ok(!(await op('taskList', { to: one.updatedAt })).tasks.some(x => x.id === one.id))
  await assert.rejects(op('taskGet', { run: 'rnope' }), /no task/)
  assert.ok((await op('taskGet', { id: one.id, lang: 'en' })).timeline.some(e => e.text === 'Write: done'))
  assert.ok(!got.timeline.some(e => /exit 0|passed/.test(e.text)), 'no exit codes for a step that worked')
  assert.deepEqual(got.outputs.map(o => o.kind).sort(), ['draft', 'report'])
  assert.deepEqual(got.outputs.find(o => o.kind === 'draft').open, { event: 'ruyix-workbench:view', detail: { run: r.id } })
  // 再改: on again from its last step, told what to change; then to-confirm again; 好了: done
  await assert.rejects(op('taskRevise', { id: one.id, text: ' ' }), /say what to change/)
  briefs = []
  await op('taskRevise', { id: one.id, text: 'Shorter, please' })
  await until('it went on', () => briefs.length && !engine.active(r.id) && engine.get(r.id).status === 'done')
  assert.match(briefs[0], /asks for changes \(再改\): Shorter, please/)
  assert.equal((await op('taskGet', { id: one.id })).task.state, 'to-confirm')
  assert.equal((await op('taskConfirm', { id: one.id })).task.state, 'done')
  await assert.rejects(op('taskConfirm', { id: one.id }), /the task is done/)
  assert.ok((await op('taskGet', { id: one.id })).timeline.some(e => e.text === '再改：Shorter, please'))

  // another source's task, through the service: its state, its outputs, its links; 再改 reaches the source
  const revised = []
  const off = svc.registerSource('session', { revise: (t, text) => { revised.push([t.id, text]) }, timeline: t => [{ at: 1, kind: 'message', who: { kind: 'person' }, text: 'write me a haiku' }] })
  const k = svc.create({ source: 'session', title: 'A haiku', agents: [{ id: 'cly', runtime: 'claude' }], links: [{ kind: 'session', id: 's9' }] })
  assert.deepEqual([k.source, k.state, k.links], ['session', 'working', [{ kind: 'session', id: 's9' }]])
  assert.throws(() => svc.create({ source: 'run', title: 'x' }), /source is chat, session, job or studio/)
  assert.equal(svc.find({ kind: 'session', id: 's9' }).id, k.id)
  const o = svc.addOutput(k.id, { kind: 'file', title: 'haiku.md', ref: { session: 's9', path: 'haiku.md' }, by: { session: 's9' } })
  assert.equal(o.id, `${k.id}:o1`)
  assert.throws(() => svc.addOutput(k.id, { kind: 'poem', title: 'x' }), /an output is one of/)
  assert.equal(svc.update(k.id, { state: 'to-confirm' }).state, 'to-confirm')
  await op('taskRevise', { id: k.id, text: 'Autumn, not spring' })
  assert.deepEqual(revised, [[k.id, 'Autumn, not spring']]); assert.equal(svc.get(k.id).state, 'working')
  svc.update(k.id, { state: 'to-confirm' })
  assert.equal((await svc.revise(k.id, 'Shorter')).state, 'working', 'the service\'s 再改 (the main agent\'s task tools)')
  assert.deepEqual(revised.at(-1), [k.id, 'Shorter'])
  svc.update(k.id, { state: 'to-confirm' })
  assert.equal((await op('taskConfirm', { id: k.id })).task.state, 'done')
  assert.equal(svc.archive(k.id).archived, true); assert.equal(svc.archive(k.id, false).archived, false)
  assert.ok((await op('taskGet', { id: k.id })).timeline.some(e => e.text === 'write me a haiku'), 'its source tells its story')
  // the portfolio: every task's outputs, the latest first; filtered
  const port = await op('outputList', {})
  assert.ok(port.outputs.some(x => x.id === o.id && x.task.id === k.id && x.open.event === 'ruyix-workbench:view' && x.open.detail.session === 's9'))
  assert.ok(port.outputs.some(x => x.task.id === one.id && x.kind === 'report'))
  assert.ok(port.outputs.every((x, i) => i === 0 || port.outputs[i - 1].at >= x.at))
  assert.deepEqual((await op('outputList', { kind: 'report', task: one.id })).outputs.map(x => x.kind), ['report'])
  // the portfolio holds the final outputs: a run's result files (what its 结果 tab shows: here what it changed in its
  // folder), each opening on its own, with a thumbnail, a poster or the first lines; not the ledger's files on the way;
  // its report only when it made no result files; what it published; grouped by its workflow; archived ones left out
  {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    let fold = null
    members.dshy = async ({ mcp }) => {
      const a = bridge(mcp)
      await a.call('file_save', { name: 'notes.md', content: 'working notes' })
      writeFileSync(join(fold, 'article.md'), '---\ntitle: x\n---\n# 为什么\n\n每个人都需要一个 agent OS。')
      writeFileSync(join(fold, 'cover.png'), png)
      writeFileSync(join(fold, 'clip.mp4'), 'not really a video')
      writeFileSync(join(fold, 'clip.png'), png)
      return a.call('stage_result', { result: { ok: true, summary: 'made them' } })
    }
    assert.deepEqual((await op('workflowSave', { definition: { id: 'made-things', title: '做东西', base: 'blank', steps: [{ use: 'intake' }, { id: 'make', use: 'agent', title: 'Make', agent: 'dshy', access: 'write', instructions: 'Make.' }, { use: 'report' }] }, enable: true })).errors, [])
    const started = (await op('startRun', { workflow: 'made-things', title: 'Agent OS' })).run
    fold = engine.get(started.id).dir
    const mr = await finished(started.id)
    assert.equal(mr.status, 'done')
    const mine = x => x.task.id === mr.taskId
    let got = (await op('outputList', {})).outputs.filter(mine)
    assert.deepEqual(got.map(x => [x.kind, x.title]).sort(), [['file', 'article.md'], ['image', 'clip.png'], ['image', 'cover.png'], ['video', 'clip.mp4']], 'its result files: not the working notes, not the report')
    const art = got.find(x => x.title === 'article.md')
    assert.deepEqual(art.open, { event: 'ruyix-workbench:view', detail: { run: mr.id, file: 'article.md' } }, 'opens on its own')
    assert.equal(art.preview.text, '# 为什么\n\n每个人都需要一个 agent OS。', 'its first lines (no front matter)')
    assert.equal(got.find(x => x.title === 'cover.png').thumb, `api/ruyix-workbench/work?run=${mr.id}&path=cover.png`)
    assert.equal(got.find(x => x.kind === 'video').preview.poster, `api/ruyix-workbench/work?run=${mr.id}&path=clip.png`, 'a picture of the same name: its poster')
    assert.deepEqual([art.final, art.task.state, art.category], [true, 'to-confirm', { key: 'wf:made-things', title: '做东西' }])
    // everything, each saying whether it is final; the report alone in the viewer, read from its own link
    const every = (await op('outputList', { final: false })).outputs.filter(mine)
    assert.deepEqual(every.filter(x => !x.final).map(x => x.kind).sort(), ['file', 'report'], 'the working notes and the report: not final')
    const rep = every.find(x => x.kind === 'report')
    assert.deepEqual(rep.open, { event: 'ruyix-workbench:view', detail: { files: [{ url: `api/ruyix-workbench/report?run=${mr.id}`, name: 'Agent OS.md', kind: 'markdown' }], title: 'Agent OS' } })
    const md = await routes['/api/ruyix-workbench/report'].fetch(new Request(`http://x/api/ruyix-workbench/report?run=${mr.id}`))
    assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8'); assert.match(await md.text(), /Agent OS/)
    assert.equal((await routes['/api/ruyix-workbench/report'].fetch(new Request('http://x/api/ruyix-workbench/report?run=nope'))).status, 404)
    // the task's own page: the same outputs, each saying whether it is final
    assert.deepEqual((await op('taskGet', { id: mr.taskId })).outputs.filter(x => x.final).length, 4)
    // what it published (a pack's `run.posted`): a post by its link; one with no link opens its task
    wb.store.put('run', { ...engine.get(mr.id), posted: [{ platform: 'x', url: 'https://x.com/i/status/1', at: Date.now() }, { platform: 'xhs', at: Date.now() }] })
    got = (await op('outputList', { kind: 'post' })).outputs.filter(mine)
    assert.deepEqual(got.map(x => [x.preview.platform, x.open.event]).sort(), [['x', 'ruyix:open-url'], ['xhs', 'ruyix-tasks:open']])
    // a run whose product is its report (it made no files): the report is final
    members.dshy = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { ok: true, summary: 'nothing to save' } })
    const brief = await finished((await op('startRun', { workflow: 'made-things', title: 'A brief' })).run.id)
    assert.deepEqual((await op('outputList', {})).outputs.filter(x => x.task.id === brief.taskId).map(x => x.kind), ['report'])
    // another source's output: final once its task is done or waiting for 好了 (or as it says); archived ones left out
    const s2 = svc.create({ source: 'session', title: 'A note' })
    svc.addOutput(s2.id, { kind: 'file', title: 'note.md', ref: { session: 's2', path: 'note.md' }, preview: { text: 'the note' } })
    svc.addOutput(s2.id, { kind: 'file', title: 'scratch.md', ref: { session: 's2', path: 'scratch.md' }, final: false })
    assert.ok(!(await op('outputList', {})).outputs.some(x => x.task.id === s2.id), 'working: not yet')
    svc.update(s2.id, { state: 'to-confirm' })
    got = (await op('outputList', {})).outputs.filter(x => x.task.id === s2.id)
    assert.deepEqual(got.map(x => [x.title, x.preview?.text, x.category.key]), [['note.md', 'the note', 'src:session']])
    assert.equal((await op('outputList', { lang: 'zh' })).outputs.find(x => x.task.id === s2.id).category.title, '会话')
    await op('taskConfirm', { id: s2.id })
    await op('taskArchive', { id: s2.id })
    assert.ok(!(await op('outputList', {})).outputs.some(x => x.task.id === s2.id), 'archived: left out')
    assert.ok((await op('outputList', { archived: true })).outputs.some(x => x.task.id === s2.id))
    assert.ok((await op('outputList', { archived: 'only' })).outputs.every(x => x.task.id === s2.id || (wb.store.get('task', x.task.id)?.archivedAt)))
    // a run archived on the runs page: its one-off task goes with it (out of the lists and the portfolio); the task
    // brought back brings its run back
    await op('archiveRun', { id: mr.id })
    assert.equal((await op('taskGet', { id: mr.taskId })).task.archived, true)
    assert.ok(!(await op('taskList', {})).tasks.some(x => x.id === mr.taskId))
    assert.ok(!(await op('outputList', {})).outputs.some(mine), 'its works leave the portfolio')
    await op('taskArchive', { id: mr.taskId, archived: false })
    assert.deepEqual([engine.get(mr.id).archivedAt, (await op('taskGet', { id: mr.taskId })).task.archived], [null, false])
    assert.ok((await op('outputList', {})).outputs.some(mine))
  }
  // the list: by state and source, counted
  const lst = await op('taskList', { source: 'session' })
  assert.deepEqual(lst.tasks.map(x => x.id), [k.id]); assert.ok(lst.counts.done >= 2)
  // delete: only when over; the run, its cards, its ledger and its folder go; every page's sync hears of it
  const doing = svc.create({ source: 'job', title: 'busy' })
  await assert.rejects(op('taskDelete', { id: doing.id }), /the task is working: stop it first/)
  const rev = wb.store.revision()
  const dir = engine.get(r.id).dir
  assert.deepEqual(await op('taskDelete', { id: one.id }), { deleted: true })
  assert.equal(engine.get(r.id), undefined); assert.equal(wb.store.evidence(r.id).length, 0); assert.equal(existsSync(dir), false)
  assert.equal((await op('taskList', {})).tasks.some(x => x.id === one.id), false)
  const marks = (await op('sync', { since: rev })).docs.filter(d => d.deletedAt).map(d => `${d.kind}:${d.id}`)
  assert.ok(marks.includes(`run:${r.id}`) && marks.includes(`task:${one.id}`), 'the pages learn it is gone')
  await op('taskDelete', { id: k.id })
  off()
}

// ── a session's files in the viewer (docs/design/agent-work.md §4): what it made or changed in its folder since it began,
// the latest first; read and streamed from inside that folder only (not through a link, not past it) ──
{
  const { utimesSync, symlinkSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmp, 'sess-')), began = Date.now() - 60e3
  const put = (rel, text, at) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); if (at) utimesSync(join(dir, rel), at / 1000, at / 1000) }
  put('old.md', 'before', began - 3600e3)
  put('notes/draft.md', '# Draft\nhello', began + 1000)
  put('cover.png', Buffer.from('89504e470d0a1a0a', 'hex'), began + 2000)
  put('node_modules/x/index.js', 'dep', began + 3000)
  put('.cache/y', 'hidden', began + 3000)
  writeFileSync(join(tmp, 'secret.txt'), 'outside')
  symlinkSync(join(tmp, 'secret.txt'), join(dir, 'link.txt'))
  hub.sessions = () => [{ id: 'sf', title: 'Write it', agent: 'cly', runtime: 'claude', cwd: dir, createdAt: began, lastAt: Date.now(), state: 'idle' }]
  const got = await op('sessionFiles', { id: 'sf' })
  assert.deepEqual(got.files, ['cover.png', 'notes/draft.md'], 'made or changed since it began, the latest first; not dependencies, hidden folders, links or older files')
  assert.deepEqual(got.session, { id: 'sf', title: 'Write it', cwd: dir })
  assert.equal((await op('sessionFileAt', { id: 'sf', path: 'notes/draft.md' })).text, '# Draft\nhello')
  await assert.rejects(op('sessionFileAt', { id: 'sf', path: '../secret.txt' }), /not in the session's folder/)
  await assert.rejects(op('sessionFileAt', { id: 'sf', path: 'link.txt' }), /not in the session's folder/, 'not through a link')
  await assert.rejects(op('sessionFiles', { id: 'nope' }), /no session nope/)
  const sfile = q => routes['/api/ruyix-workbench/sfile'].fetch(new Request(`http://x/api/ruyix-workbench/sfile?${new URLSearchParams(q)}`))
  assert.equal((await sfile({ session: 'sf', path: 'cover.png' })).status, 200)
  assert.equal((await sfile({ session: 'sf', path: 'notes/draft.md' })).status, 415, 'streamed: pictures, video, sound, PDF only')
  assert.equal((await sfile({ session: 'sf', path: 'notes/draft.md', download: '1' })).status, 200, 'any file to save')
  assert.equal((await sfile({ session: 'sf', path: 'link.txt', download: '1' })).status, 404)
  assert.equal((await sfile({ session: 'nope', path: 'cover.png' })).status, 404)
  delete hub.sessions
}

// ── 记录 (docs/design/agent-work.md §3; lib/records.js): the runs, the resident sessions not a run's, the pool's own jobs —
// one list, newest first; searched, by kind, a studio's runs; in pages; grouped by day, task, agent ──
{
  const { groupRecords } = await import('./lib/records.js')
  const T0 = Date.now()
  hub.sessions = () => [
    { id: 'sa', title: 'Explore the logs', agent: 'cly', runtime: 'claude', model: 'claude-x', cwd: '/w', state: 'idle', turns: 3, tokens: 900, cost: 0.02, said: 'Found the leak.', createdAt: T0 - 5000, lastAt: T0 + 50 },
    { id: 'sb', title: 'A run step', agent: 'cly', runtime: 'claude', by: 'workbench', of: { run: 'r1', step: 'x' }, state: 'idle', createdAt: T0, lastAt: T0 },
    { id: 'sc', title: 'Gone', agent: 'cly', runtime: 'claude', removedAt: T0, createdAt: T0, lastAt: T0 },
  ]
  hub.tasks = () => [{ id: 'tq', jobId: 'jq', agent: 'opus', runtime: 'claude', model: 'opus-x', status: 'done', tokens: 300, cost: 0.1, createdAt: T0 - 300 }]
  const jobBefore = hub.job
  hub.job = id => (id === 'jq' ? { id: 'jq', title: 'Tidy the docs', status: 'done', createdAt: T0 - 400, endedAt: T0 + 40, cwd: '/w' } : jobBefore(id))
  const all = await op('records', { limit: 500 })
  const ids = all.items.map(x => x.id)
  assert.ok(ids.includes('session:sa') && ids.includes('job:jq'), 'a session of its own and a job of the pool\'s own are records')
  assert.ok(!ids.includes('session:sb') && !ids.includes('session:sc'), 'a run step\'s session is the run\'s; a removed one is gone')
  assert.ok(all.items.filter(x => x.kind === 'run').length > 5, 'the runs')
  assert.ok(all.items.every((x, i) => i === 0 || all.items[i - 1].at >= x.at), 'newest first')
  const sa = all.items.find(x => x.id === 'session:sa')
  assert.deepEqual([sa.state, sa.turns, sa.tokens, sa.said, sa.open.event], ['done', 3, 900, 'Found the leak.', 'agent-hub:open'])
  const jq = all.items.find(x => x.id === 'job:jq')
  assert.deepEqual([jq.agents.map(a => a.id), jq.tokens, jq.cost, jq.turns], [['opus'], 300, 0.1, 1])
  const done = all.items.find(x => x.kind === 'run' && x.state === 'done' && x.files > 0)
  assert.ok(done, 'a run that saved files counts them')
  assert.equal(done.open.detail.run, done.id.slice(4))
  assert.ok(all.items.every(x => !x.archived), 'put-away runs only when asked')
  // searched (every word), one kind, the next page
  assert.deepEqual((await op('records', { q: 'leak' })).items.map(x => x.id), ['session:sa'])
  assert.deepEqual((await op('records', { q: 'tidy docs' })).items.map(x => x.id), ['job:jq'])
  assert.ok((await op('records', { kinds: ['session'] })).items.every(x => x.kind === 'session'))
  const p1 = await op('records', { kinds: ['run'], limit: 3 }), p2 = await op('records', { kinds: ['run'], limit: 3, before: p1.items.at(-1).at })
  assert.equal(p1.more, true); assert.equal(p2.items.length, 3)
  assert.ok(p2.items.every(x => x.at < p1.items.at(-1).at && !p1.items.some(y => y.id === x.id)), 'the next page: earlier ones')
  // a studio's runs only (its 历史)
  const some = store().list('run')[0]
  store().put('run', { ...some, studio: { id: 'plume', collection: 'ideas', record: 'i1' } })
  assert.deepEqual((await op('records', { studio: 'plume' })).items.map(x => x.id), [`run:${some.id}`])
  // grouped: by day, by task (a run's task, else its workflow; the others by kind), by agent (one record under each)
  const words = { kind: k => `K:${k}`, noAgent: 'none' }
  const sample = [
    { id: 'run:1', kind: 'run', sub: 'Publish', task: { id: 't1', title: 'Weekly post' }, agents: [{ id: 'a', runtime: 'claude' }, { id: 'b', runtime: 'codex' }], at: T0 },
    { id: 'run:2', kind: 'run', sub: 'Publish', task: null, agents: [], at: T0 - 864e5 * 2 },
    { id: 'session:s', kind: 'session', agents: [{ id: 'a', runtime: 'claude' }], at: T0 - 10 },
  ]
  assert.deepEqual(groupRecords(sample, 'task', words).map(g => [g.title, g.items.length]), [['Weekly post', 1], ['Publish', 1], ['K:session', 1]])
  assert.deepEqual(groupRecords(sample, 'agent', words).map(g => [g.title, g.items.map(x => x.id).join('+')]), [['a', 'run:1+session:s'], ['b', 'run:1'], ['none', 'run:2']])
  assert.equal(groupRecords(sample, 'day', words).length, 2)
  delete hub.sessions; delete hub.tasks; hub.job = jobBefore
}


{
  // the real MCP server over stdio, the way Claude Code and Codex start it
  members.dshy = async ({ mcp }) => {
    assert.equal(mcp.name, 'ruyix-workbench')
    const m = await stdio(mcp)
    const init = (await m.rpc('initialize', { protocolVersion: '2025-06-18' })).result
    assert.deepEqual([init.serverInfo.name, init.protocolVersion], ['ruyix-workbench', '2025-06-18'])
    m.notify('notifications/initialized')
    const listed = (await m.rpc('tools/list', {})).result.tools
    assert.deepEqual(listed.map(t => t.name).sort(), ['claim_add', 'decision_needed', 'discuss_with_person', 'evidence_get', 'file_save', 'help_needed', 'stage_result', 'wb_context'])
    assert.ok(listed.every(t => t.description && t.inputSchema.type === 'object'))
    assert.match(await m.call('file_save', { name: 'via-mcp.txt', content: 'hello' }), /Saved via-mcp\.txt \(5 bytes\) as evidence #\d+/)
    await assert.rejects(m.call('notes_count', { seq: 1 }), /not a tool of the step/)
    assert.equal((await m.rpc('bogus', {})).error.code, -32601)
    assert.equal((await m.rpc('ping', {})).result && true, true)
    const out = await m.call('stage_result', { result: { ok: true, summary: 'over stdio' } })
    m.close()
    return out
  }
  const end = await finished((await op('startRun', { workflow: 'core-only', text: 'again, over stdio' })).run.id)
  assert.equal(end.outputs.work.summary, 'over stdio')
  assert.ok(wb.store.evidence(end.id).some(e => e.title === 'file: via-mcp.txt'))
}

// ── the form and the request ──
{
  const start = args => op('startRun', { workflow: 'notes.publish', ...args })
  const msg = async args => (await start(args).then(() => ({ message: 'started' }), e => e)).message
  assert.match(await msg({}), /give a title or a text|Channel: required/)
  assert.match(await msg({ title: 'x' }), /Channel: required/)
  assert.match(await msg({ title: 'x', fields: { channel: 'blog', nope: 1 } }), /unknown field "nope"/)
  assert.match(await msg({ title: 'x', fields: { channel: 'blog', tags: ['z'] } }), /z is not one of a, b, c/)
  assert.match(await msg({ title: 'x', fields: { channel: 'blog', tags: 'a' } }), /a list of choices/)
  assert.match(await msg({ title: 'x', fields: { channel: 'blog', notify: 'yes' } }), /yes or no/)
  assert.match(await msg({ title: 'x', fields: { channel: 'blog', tone: 4 } }), /text/)
  assert.match(await msg({ title: 'x', fields: { channel: 'blog' }, attachments: [{ name: 'a.txt', base64: '!!!' }] }), /must be base64/)
  assert.match(await msg({ title: 'x', fields: { channel: 'blog' }, attachments: [{ base64: 'YQ==' }] }), /needs a file name/)
  assert.match(await msg({ text: 'FORBIDDEN stuff', fields: { channel: 'blog' } }), /the text is forbidden/, 'the workflow checks the request itself')
  assert.match(await msg({ workflow: 'notes.nothing', title: 'x' }), /unknown workflow/)
  await assert.rejects(op('startRun', { workflow: 'nothing.at-all', title: 'x' }), /unknown workflow/)
  // blank: a title or a text is enough; nothing else
  members.scribe = async () => 'unused'
  const blankRun = (await op('startRun', { workflow: 'blank', text: 'just a text' })).run
  assert.equal((await finished(blankRun.id)).status, 'done')
  const twins = (await op('startRun', { workflow: 'blank', title: 'twins', attachments: [{ name: 'a.txt', base64: b64('one') }, { name: 'a.txt', base64: b64('two') }, { name: '2-a.txt', base64: b64('three') }, { name: 'A.TXT', base64: b64('four') }] })).run
  assert.deepEqual(twins.subject.attachments.map(x => readFileSync(x.path, 'utf8')), ['one', 'two', 'three', 'four'], 'duplicate, generated and case-insensitive names all keep their own copy')
  assert.equal(new Set(twins.subject.attachments.map(x => x.artifact)).size, 4)
  assert.ok((await finished(twins.id)) && wb.store.verify(twins.id).ok)
  await assert.rejects(op('startRun', { workflow: 'blank' }), /give a title or a text/)
  await assert.rejects(op('startRun', { workflow: 'blank', title: 'x', fields: { a: 1 } }), /unknown field "a"/)
  assert.equal(Object.keys(engine.get(blankRun.id).outputs || {}).length, 0)
  assert.equal(store().list('run').filter(r => ['queued'].includes(r.status)).length, 0, 'a refused request makes no run')
}

// ── a session's events as the desk's activity (foldActivity: what a step in a session is doing now) ──
{
  const ev = (type, time, data) => ({ type, time, data })
  const act = foldActivity([
    ev('tool/call', 5, { callId: 'old', name: 'Read', arguments: '{"file_path":"/x/before.md"}' }),
    ev('tool/call', 20, { callId: 'a', name: 'Read', arguments: '{"file_path":"/x/draft.md"}' }),
    ev('assistant/message', 25, { message: { content: [{ type: 'text', text: 'Reading it.' }] } }),
    ev('tool/result', 30, { message: { toolCallId: 'a', isError: false } }),
    ev('tool/call', 40, { callId: 'b', name: 'Bash', arguments: '{"command":"npm test"}' }),
  ], 10)
  assert.deepEqual(act.recent, [{ name: 'Read', target: '/x/draft.md', ms: 10, ok: true, at: 30 }], 'from the step\'s start; done with its time')
  assert.deepEqual(act.tools.map(t => [t.name, t.target]), [['Bash', 'npm test']], 'at work now')
  assert.deepEqual([act.said, act.saidAt], ['Reading it.', 25])
  assert.deepEqual(foldActivity([ev('tool/call', 20, { callId: 'a', name: 'X', arguments: '{}' }), ev('turn/end', 30, {})]).tools, [], 'a turn over: nothing at work')
}

// ── cancel ──
{
  let release
  members.scribe = ({ mcp }) => new Promise(res => { release = () => res('late'); mcp.cancelled = res })
  const r = (await op('startRun', { workflow: 'notes.publish', title: 'to cancel', fields: { channel: 'blog' } })).run
  await until('the agent', () => tasks.size && [...tasks.values()].at(-1).member === 'writer' && engine.get(r.id).stages.find(s => s.key === 'draft').tasks?.length)
  assert.ok(shellParts.find(p => p.id === 'workbench').busy().some(l => l.includes(r.id)), 'a run going is what a restart would cut short')
  // what its agent is doing now, for the desk's lines (docs/design/agent-work.md §2): its pool task's activity
  Object.assign([...tasks.values()].at(-1), { sessionId: 'sx', act: { phase: 'tool', tools: [{ callId: 'c2', name: 'Edit', target: 'draft.md', at: 30 }], recent: [{ name: 'Read', target: 'draft.md', ok: true, ms: 4, at: 20 }], said: 'On it.', saidAt: 25, turnStartedAt: 10, toolCount: 2 } })
  const seen = await op('run', { id: r.id, after: 0, live: true })
  assert.deepEqual(Object.keys(seen.live), ['draft'], 'the steps at work')
  assert.deepEqual(seen.live.draft.act.recent.map(x => x.name), ['Read']); assert.equal(seen.live.draft.act.saidAt, 25)
  assert.equal((await op('run', { id: r.id, after: 0 })).live, undefined, 'only when asked')
  // Hold only this run's automatic report verification past its terminal status.
  const verify = wb.store.verifyAsync
  let allowReport, reportEntered = false
  const reportGate = new Promise(resolve => { allowReport = resolve })
  wb.store.verifyAsync = async (id, options) => {
    if (id === r.id) { reportEntered = true; await reportGate }
    return verify(id, options)
  }
  try {
    assert.equal((await op('stopRun', { id: r.id })).run.id, r.id)
    const end = await finished(r.id)
    assert.equal(end.status, 'cancelled')
    assert.equal(hub.jobs.get(end.jobId).status, 'cancelled')
    assert.equal([...tasks.values()].at(-1).status, 'cancelled', 'the agent\'s task is cancelled')
    await until('the automatic report to reach verification', () => reportEntered)
    assert.ok(!end.report, 'the run ends before the delayed automatic report is persisted')
    let reportReady = false
    const pendingReport = automaticReport(r.id, 'Cancelled').then(result => { reportReady = true; return result })
    await sleep(30) // let the waiter poll while verification is deliberately held
    assert.equal(reportReady, false, 'report assertions wait independently of finished()')
    allowReport()
    const reported = await pendingReport
    assert.match(reported.markdown, /Verdict: Cancelled/)
  } finally { allowReport(); wb.store.verifyAsync = verify }
  release?.() // the member may not have been started before the stop (a slow machine)
  await assert.rejects(op('resumeRun', { id: 'nope' }), /no run/)
  await op('archiveRun', { id: r.id })
  assert.ok(engine.get(r.id).archivedAt)
  await op('archiveRun', { id: r.id, archived: false })
  assert.equal(engine.get(r.id).archivedAt, null)
  // looked at: kept with the run (in the box, not the browser); once is enough; a run going is not marked
  assert.deepEqual((await op('markSeen', { ids: [r.id, 'nope'] })).seen, [r.id])
  const at = engine.get(r.id).seenAt
  assert.ok(at > 0)
  assert.deepEqual((await op('markSeen', { ids: [r.id] })).seen, [], 'already seen')
  assert.equal(engine.get(r.id).seenAt, at)
  // the desk's done note (docs/design/agent-work.md §3): what it came to, its first picture; finished runs only
  const oc = (await op('runOutcomes', { ids: [r.id, 'nope'] })).outcomes
  assert.deepEqual(Object.keys(oc), [r.id]); assert.equal(oc[r.id].image, null); assert.equal(typeof oc[r.id].text, 'string')
  // an opened lane's summary: the main model's, in the page's language; asked again only when the run moved on
  assert.deepEqual(await op('runSummary', { id: r.id }), { text: '' }, 'no main model here: none')
  hub.mainModel = () => 'fake/model'
  const n0 = llmCalls.length
  const sum = await op('runSummary', { id: r.id, lang: 'zh' })
  assert.match(sum.text, /^ZH:Run: to cancel/); assert.match(llmCalls.at(-1).system, /Chinese/)
  assert.deepEqual(await op('runSummary', { id: r.id, lang: 'zh' }), sum); assert.equal(llmCalls.length, n0 + 1, 'the same: kept')
  await op('runSummary', { id: r.id, lang: 'en' }); assert.equal(llmCalls.length, n0 + 2, 'another language: asked')
  for (const model of ['fake/model:7b', 'dsh:fake/model:free']) {
    hub.mainModel = () => model
    const tagged = await op('runSummary', { id: r.id, lang: model })
    assert.ok(tagged.text, 'provider model tags are not connection prefixes')
    assert.equal(llmCalls.at(-1).model, model.replace(/^dsh:/, '').split('/').slice(1).join('/'))
  }
  hub.mainModel = () => ''
  // no dsh model here, the main agent is Claude Code: that agent itself, one turn with no tools
  const turns = []
  hub.mainAgent = () => ({ id: 'scribe', runtime: 'claude' })
  hub.chatTurn = async args => { turns.push(args); return { output: 'It was stopped before its draft.' } }
  r.updatedAt = Date.now(); store().put('run', { ...engine.get(r.id), updatedAt: Date.now() + 1 })
  assert.deepEqual(await op('runSummary', { id: r.id, lang: 'zh' }), { text: 'It was stopped before its draft.' })
  assert.equal(turns[0].agent, 'scribe'); assert.match(turns[0].instructions, /Use no tools/); assert.match(turns[0].prompt, /^Run: to cancel/)
  delete hub.chatTurn; hub.mainAgent = () => hub.agentsList.get(hub.mainId) || null
}

// ── a person's workflows: failure and go-back, resume, branch, parallel, scripts ──
const save = def => op('workflowSave', { definition: def, enable: true })
const sc2 = id => ({ id, use: 'script', title: id, run: 'true' })
{
  // a script step that fails once sends the run back to the step before it, once
  const def = {
    id: 'retry', title: 'Retry once', base: 'blank',
    steps: [{ use: 'intake' },
      { id: 'make', use: 'script', title: 'Make', run: 'echo x >> made.txt' },
      { id: 'check', use: 'script', title: 'Check', run: 'test "$(wc -l < made.txt)" -ge 2', onFail: { goto: 'make', max: 1 } },
      { use: 'report' }],
  }
  const s = await save(def)
  assert.deepEqual(s.errors, [])
  assert.equal(s.workflow.status, 'enabled')
  const r = await finished((await op('startRun', { workflow: 'retry', title: 'retry' })).run.id)
  assert.equal(r.status, 'done', JSON.stringify(r.stages))
  assert.equal(r.stages.find(s => s.key === 'make').attempt, 2, 'the step before the failing one ran again')
  assert.equal(r.stages.find(s => s.key === 'check').attempt, 2)
  assert.equal(r.loops.check, 1)
  assert.equal(readFileSync(join(r.dir, 'made.txt'), 'utf8'), 'x\nx\n', 'a script step runs in the run\'s folder')
  assert.ok(wb.store.evidence(r.id).some(e => e.kind === 'command' && e.code === 1), 'the failed check is in the ledger')
  assert.ok(wb.store.verify(r.id).ok)
  // failing past max stops the run
  await save({ ...def, id: 'retry-fail', steps: def.steps.map(x => (x.id === 'check' ? { ...x, run: 'false' } : x)) })
  const f = await finished((await op('startRun', { workflow: 'retry-fail', title: 'never' })).run.id)
  assert.equal(f.status, 'failed')
  assert.equal(f.verdict.level, 'failed')
  assert.equal(f.verdict.stopped, 'check')
  assert.deepEqual(f.stages.map(s => s.status), ['passed', 'passed', 'failed', 'skipped'], 'nothing after a stop runs')
  await automaticReport(f.id, 'Failed')
}
{
  // resume: a failed run continues from the failed step once the cause is gone
  await save({ id: 'needs-flag', title: 'Needs a flag', base: 'blank', steps: [{ use: 'intake' }, { id: 'first', use: 'script', title: 'First', run: 'echo once >> first.log' }, { id: 'gate', use: 'script', title: 'Gate', run: 'test -f flag' }, { use: 'report' }] })
  const r = await finished((await op('startRun', { workflow: 'needs-flag', title: 'flag' })).run.id)
  assert.equal(r.status, 'failed')
  writeFileSync(join(r.dir, 'flag'), '') // the cause is gone
  assert.equal((await op('resumeRun', { id: r.id })).from, 'gate', 'it continues from the first step that did not pass')
  const again = await until('the resumed run to end', async () => { const x = engine.get(r.id); return x.status === 'done' && !engine.active(r.id) && x })
  assert.equal(again.status, 'done')
  assert.deepEqual(again.stages.map(s => s.status), ['passed', 'passed', 'passed', 'passed'])
  assert.equal(readFileSync(join(r.dir, 'first.log'), 'utf8'), 'once\n', 'a step that passed is not run again')
  assert.ok(again.resumedAt)
  await assert.rejects(op('resumeRun', { id: r.id }), /a done run cannot be resumed/)
  // a finished run can be re-run from a step the person re-judged
  engine.resumeRun(r.id, { from: 'gate' })
  assert.equal((await until('the rerun', async () => { const x = engine.get(r.id); return x.status === 'done' && !engine.active(r.id) && x })).stages[2].attempt, 3)
}
{
  // branch by condition: the route that holds is taken, the others are skipped
  const def = {
    id: 'router', title: 'Router', base: 'blank',
    steps: [{ use: 'intake' },
      { id: 'probe', use: 'script', title: 'Probe', run: 'echo big' },
      { id: 'pick', use: 'branch', title: 'Pick', mode: 'condition',
        routes: [
          { id: 'small', label: 'Small', when: { output: 'probe', has: 'small' }, steps: [{ id: 'quick', use: 'script', title: 'Quick', run: 'echo quick' }] },
          { id: 'large', label: 'Large', when: { output: 'probe', has: 'big' }, steps: [{ id: 'slow', use: 'script', title: 'Slow', run: 'echo slow' }, { id: 'slower', use: 'script', title: 'Slower', run: 'echo slower' }] },
        ],
        otherwise: { label: 'Neither', steps: [{ id: 'none', use: 'script', title: 'None', run: 'echo none' }] } },
      { id: 'after', use: 'script', title: 'After', run: 'echo after' },
      { use: 'report' }],
  }
  const s = await save(def)
  assert.deepEqual(s.errors, [])
  const r = await finished((await op('startRun', { workflow: 'router', title: 'route' })).run.id)
  assert.equal(r.status, 'done')
  const st = Object.fromEntries(r.stages.map(x => [x.key, x.status]))
  assert.deepEqual(st, { intake: 'passed', probe: 'passed', pick: 'passed', quick: 'skipped', slow: 'passed', slower: 'passed', none: 'skipped', after: 'passed', report: 'passed' })
  assert.equal(r.stages.find(x => x.key === 'quick').note, 'not on this path')
  assert.equal(r.outputs.pick.route, 'large')
  assert.ok(!r.outputs.quick && !r.outputs.none)
}
{
  // parallel: two read-only lanes at the same time, then the join
  let running = 0, peak = 0
  members.scribe = async ({ mcp, member }) => {
    running++; peak = Math.max(peak, running)
    await sleep(120)
    const out = await bridge(mcp).call('stage_result', { result: { ok: true, summary: `${member} done` } })
    running--
    return out
  }
  const def = {
    id: 'both', title: 'Both', base: 'blank',
    steps: [{ use: 'intake' },
      { id: 'fan', use: 'parallel', title: 'Fan out', lanes: [
        { id: 'a', label: 'A', steps: [{ id: 'read-a', use: 'agent', title: 'Read A', agent: 'scribe', access: 'read', instructions: 'Read A.' }] },
        { id: 'b', label: 'B', steps: [{ id: 'read-b', use: 'agent', title: 'Read B', agent: 'scribe', access: 'read', instructions: 'Read B.' }, { id: 'echo-b', use: 'script', title: 'Echo B', run: 'echo b' }] },
      ] },
      { use: 'report' }],
  }
  assert.deepEqual((await save(def)).errors, [])
  const r = await finished((await op('startRun', { workflow: 'both', title: 'par' })).run.id)
  assert.equal(r.status, 'done', JSON.stringify(r.stages))
  assert.equal(peak, 2, 'the lanes ran at the same time')
  assert.deepEqual(r.stages.map(s => [s.key, s.status]), [['intake', 'passed'], ['fan', 'passed'], ['read-a', 'passed'], ['read-b', 'passed'], ['echo-b', 'passed'], ['report', 'passed']])
  assert.deepEqual(r.outputs.fan.lanes, { a: true, b: true })
  assert.equal(r.outputs['read-b'].summary, 'writer done'.replace('writer', 'read-b'), 'each lane\'s tool calls land in its own step')
  // A finished run remains editable even when its workflow is no longer installed.
  wb.store.put('run', { ...r, template: 'no-longer-installed', workflowDef: null })
  try { await op('editFile', { id: r.id, path: 'old-note.md', content: 'kept after uninstall', blob: null }) } finally { wb.store.put('run', r) }
  // a writing agent in a lane is refused
  const bad = await op('workflowValidate', { definition: { ...def, id: 'both2', steps: def.steps.map(x => (x.id === 'fan' ? { ...x, lanes: x.lanes.map(l => ({ ...l, steps: l.steps.map(y => (y.use === 'agent' ? { ...y, access: 'write' } : y)) })) } : x)) } })
  assert.ok(bad.errors.some(e => /read access/.test(e.message)))

  // One lane asking the person does not make another lane's running step safe to edit beside.
  const guarded = structuredClone(def)
  guarded.id = 'busy-lanes'
  guarded.steps[1].lanes[0].steps[0].human = { below: 70 }
  await save(guarded)
  let release
  const gate = new Promise(resolve => { release = resolve })
  members.scribe = async ({ mcp, member }) => {
    if (member === 'read-b') await gate
    return bridge(mcp).call('stage_result', { result: { ok: true, summary: member, confidence: member === 'read-a' ? 10 : 100 } })
  }
  const busy = (await op('startRun', { workflow: guarded.id, title: 'editing beside lanes' })).run
  try {
    await until('one lane waits and another works', () => { const r = engine.get(busy.id); return r.status === 'waiting' && r.stages.find(s => s.key === 'read-b').status === 'running' })
    await assert.rejects(op('editFile', { id: busy.id, path: 'note.md', content: 'person edit', blob: null }), e => e.code === 'runBusy')
    release()
    await until('the other lane finishes', () => engine.get(busy.id).stages.find(s => s.key === 'echo-b').status === 'passed')
    await op('editFile', { id: busy.id, path: 'note.md', content: 'person edit', blob: null })
  } finally { release(); await op('stopRun', { id: busy.id }); await finished(busy.id) }
}
{
  // a script step reaches a connection through the connectors plugin; its values never reach the ledger
  // (one that writes comes after a person's approval on its path: that is checked when the workflow is saved)
  const noOk = await op('workflowValidate', { definition: { id: 'with-api', title: 'With API', base: 'blank', steps: [{ use: 'intake' }, { id: 'call', use: 'script', title: 'Call', run: 'echo "token is $BLOG_TOKEN"', connectors: { 'blog-api': 'write' } }, { use: 'report' }] } })
  assert.match(noOk.errors.map(e => e.message).join(), /call writes through a connection: put an approval step before it/)
  await save({ id: 'with-api', title: 'With API', base: 'blank', steps: [{ use: 'intake' }, { id: 'go', use: 'approval', title: 'Write to the blog?', text: 'The script posts to the blog.' }, { id: 'call', use: 'script', title: 'Call', run: 'echo "token is $BLOG_TOKEN"', connectors: { 'blog-api': 'write' } }, { use: 'report' }] })
  const started = (await op('startRun', { workflow: 'with-api', title: 'api' })).run
  const go = await until('the approval step', () => wb.store.list('approval').find(a => a.runId === started.id && a.status === 'pending'))
  assert.equal(conns.envCalls.filter(c => c[1].by === `${started.id}:call`).length, 0, 'nothing reached the connection before the person said yes')
  await op('approve', { id: go.id, payload: { choice: 0 } })
  const r = await finished(started.id)
  assert.equal(r.status, 'done')
  assert.deepEqual(conns.envCalls.at(-1)[1], { write: true, by: `${r.id}:call` })
  const cmd = wb.store.evidence(r.id).find(e => e.kind === 'command')
  assert.equal(cmd.output.trim(), 'token is «secret»')
  assert.ok(!readFileSync(join(home, 'runs', cmd.artifact), 'utf8').includes('tok-secret'))
  // workspace: the folder from the settings
  const ws = join(tmp, 'ws'); mkdirSync(ws)
  await op('saveSettings', { settings: { workspace: ws } })
  await save({ id: 'in-ws', title: 'In the workspace', base: 'blank', steps: [{ use: 'intake' }, { id: 'here', use: 'script', title: 'Here', run: `${PWD} > where.txt`, cwd: 'workspace' }, { use: 'report' }] })
  await finished((await op('startRun', { workflow: 'in-ws', title: 'ws' })).run.id)
  assert.equal(samePath(readFileSync(join(ws, 'where.txt'), 'utf8').trim()), samePath(ws), 'cwd "workspace" is the settings\' workspace')
  await op('saveSettings', { settings: { workspace: '' } })
  const r2 = await finished((await op('startRun', { workflow: 'in-ws', title: 'ws2' })).run.id)
  assert.ok(existsSync(join(r2.dir, 'where.txt')), 'without one it is the run\'s own folder')
}
{
  // workflows of a person's: validation, windows, the disabled/draft rule
  const v = def => op('workflowValidate', { definition: def }).then(r => r.errors.map(e => e.message))
  const base = { id: 'mine', title: 'Mine', base: 'blank' }
  assert.deepEqual(await v({ ...base, steps: [{ use: 'intake' }, { use: 'report' }] }), [])
  assert.match((await v({ ...base, steps: [{ id: 'early', use: 'script', title: 'E', run: 'true' }, { use: 'intake' }, { use: 'report' }] })).join(), /must come after intake/, 'a step of one\'s own comes after the first step')
  assert.match((await v({ ...base, steps: [{ use: 'intake' }, { use: 'report' }, { id: 'late', use: 'script', title: 'L', run: 'true' }] })).join(), /before the end|before/, '… and before the closing step')
  assert.match((await v({ ...base, steps: [{ use: 'intake' }] })).join(), /report is a required step/)
  assert.match((await v({ ...base, id: 'blank', steps: [{ use: 'intake' }, { use: 'report' }] })).join(), /built-in/)
  assert.match((await v({ ...base, steps: [{ use: 'intake' }, { id: 'ss', use: 'script', title: 'S', run: 'true', cwd: 'worktree' }, { use: 'report' }] })).join(), /cwd is run or workspace/)
  assert.match((await v({ ...base, steps: [{ use: 'intake' }, { id: 'ss', use: 'script', title: 'S', run: 'true', connectors: { 'blog-api': 'lab' } }, { use: 'report' }] })).join(), /read or write/)
  assert.match((await v({ ...base, steps: [{ use: 'intake' }, { id: 'ss', use: 'agent', title: 'S', agent: 'nobody', instructions: 'x' }, { use: 'report' }] })).join(), /no agent "nobody"/)
  assert.match((await v({ ...base, steps: [{ use: 'intake' }, { id: 'ss', use: 'agent', title: 'S', agent: 'scribe', instructions: 'x', tools: ['bash'] }, { use: 'report' }] })).join(), /unknown tools: bash/)
  assert.deepEqual(await v({ ...base, steps: [{ use: 'intake' }, { id: 'ss', use: 'agent', title: 'S', agent: 'scribe', instructions: 'x', tools: ['notes_count'] }, { use: 'report' }] }), [], 'a pack\'s tool can be given to a step of one\'s own')
  // on a pack's workflow: insertFrom is draft, so steps may go after the draft only
  const pb = { id: 'on-pack', title: 'On pack', base: 'notes.publish' }
  const pack = [{ use: 'intake' }, { use: 'draft' }, { use: 'sign-off' }, { use: 'queue' }, { use: 'report' }]
  assert.deepEqual(await v({ ...pb, steps: pack }), [])
  assert.match((await v({ ...pb, steps: [{ use: 'intake' }, { id: 'before', use: 'script', title: 'B', run: 'true' }, ...pack.slice(1)] })).join(), /must come after draft/)
  assert.deepEqual(await v({ ...pb, steps: [...pack.slice(0, 2), { id: 'extra', use: 'script', title: 'X', run: 'true' }, ...pack.slice(2)] }), [])
  assert.match((await v({ ...pb, steps: [{ use: 'intake' }, { use: 'sign-off' }, { use: 'queue' }, { use: 'report' }] })).join(), /draft is a required step/)
  // the approval step's other option stops the run
  await save({ id: 'ask-first', title: 'Ask first', base: 'blank', steps: [{ use: 'intake' }, { id: 'ok', use: 'approval', title: 'OK to go?', text: 'Shall we?' }, sc2('after-ok'), { use: 'report' }] })
  const ask = (await op('startRun', { workflow: 'ask-first', title: 'ask' })).run
  const card0 = await until('the question', () => wb.store.list('approval').find(a => a.runId === ask.id && a.status === 'pending'))
  assert.deepEqual(card0.payload.options.map(o => o.action), ['accept', 'stop'])
  await op('approve', { id: card0.id, payload: { choice: 1 } })
  const stopped = await finished(ask.id)
  assert.equal(stopped.status, 'failed')
  assert.match(stopped.verdict.reason, /OK to go\?: stopped by the person/)
  assert.equal(stopped.stages.find(s => s.key === 'after-ok').status, 'skipped')
  // a draft is not a workflow a run may start on; an enabled one is
  const saved = await op('workflowSave', { definition: { ...base, id: 'later', steps: [{ use: 'intake' }, { use: 'report' }] } })
  assert.equal(saved.workflow.status, 'draft')
  await assert.rejects(op('startRun', { workflow: 'later', title: 'x' }), /unknown workflow/)
  await op('workflowStatus', { id: 'later', status: 'enabled' })
  assert.equal((await finished((await op('startRun', { workflow: 'later', title: 'x' })).run.id)).status, 'done')
  // saved by the assistant: always a draft; its files are in <home>/workflows
  assert.equal((await op('workflowSave', { definition: { ...base, id: 'later', steps: [{ use: 'intake' }, { use: 'report' }] }, by: 'assistant' })).workflow.status, 'draft')
  assert.ok(existsSync(join(home, 'workflows', 'later.json')))
  const listed = (await op('workflows')).mine.find(w => w.id === 'later')
  assert.deepEqual(listed.errors, [])
  await op('workflowRemove', { id: 'later' })
  assert.ok(!existsSync(join(home, 'workflows', 'later.json')))
  // a run on a person's workflow on a pack's workflow: the pack's tools, actions and form carry through
  await save({ id: 'pack-plus', title: 'Pack plus', base: 'notes.publish', steps: [...pack.slice(0, 2), { id: 'extra', use: 'approval', title: 'Extra look', text: 'Look again?' }, ...pack.slice(2)] })
  members.scribe = ({ mcp }) => bridge(mcp).call('stage_result', { result: { text: 'plus draft' } })
  const r = (await op('startRun', { workflow: 'pack-plus', title: 'plus', fields: { channel: 'mail' } })).run
  const w1 = await until('the extra approval', () => { const x = engine.get(r.id); return x.status === 'waiting' && x.stage === 'sign-off' ? x : x.stage === 'extra' && x.status === 'waiting' ? x : null })
  assert.equal(w1.stage, 'extra', 'the person\'s own approval step comes after the draft')
  const first = wb.store.list('approval').find(a => a.runId === r.id && a.status === 'pending')
  assert.equal(first.title, 'Extra look')
  await op('approve', { id: first.id, payload: { choice: 0 } })
  const w2 = await until('the sign-off', () => { const x = engine.get(r.id); return x.status === 'waiting' && x.stage === 'sign-off' && x })
  await op('approve', { id: wb.store.list('approval').find(a => a.runId === r.id && a.status === 'pending').id, payload: { choice: 0 } })
  const end = await finished(r.id)
  assert.equal(end.verdict.level, 'published', 'the base\'s success level carries over')
  await op('approve', { id: wb.store.list('approval').find(a => a.runId === r.id && a.action === 'fake_publish').id })
  assert.equal(published.at(-1).channel, 'mail', 'the pack\'s action runs from a person\'s workflow on it')
  void w2
}

// ── a model step: one call to a model, its answer the step's result ──
{
  await save({ id: 'summarise', title: 'Summarise', base: 'blank', steps: [{ use: 'intake' },
    { id: 'sum', use: 'model', title: 'Summarise', model: 'dsh:fake/model', instructions: 'Summarise the request in one line.' },
    { id: 'route', use: 'branch', title: 'Route', routes: [{ id: 'yes', label: 'Yes', when: { output: 'sum', has: 'urgent' }, steps: [sc2('mark')] }], otherwise: { label: 'no', steps: [] } },
    { use: 'report' }] })
  const calls = llmCalls.length
  const r = await finished((await op('startRun', { workflow: 'summarise', title: 'Urgent: the roof', text: 'It leaks.' })).run.id)
  assert.equal(r.status, 'done', JSON.stringify(r.stages))
  assert.equal(llmCalls.length, calls + 1, 'one call')
  assert.equal(llmCalls.at(-1).provider, 'fake')
  assert.match(llmCalls.at(-1).system, /one step of a workflow run/)
  assert.match(r.outputs.sum.summary, /^EN:[\s\S]*# Urgent: the roof[\s\S]*It leaks\.[\s\S]*Your task: Summarise\nSummarise the request in one line\./)
  assert.equal(r.stages.find(s => s.key === 'mark').status, 'passed', 'a condition reads what the model step handed back')
  const e = wb.store.evidence(r.id).find(x => x.kind === 'model')
  assert.equal(e.actor, 'sum')
  assert.equal(e.input.model, 'dsh:fake/model')
  assert.equal(e.input.calls, 1)
  assert.equal(e.ok, true)
  assert.match(wb.store.readArtifact(e.artifact), /## System[\s\S]*## Question[\s\S]*## Answer 1/, 'the whole exchange is in the ledger')
  assert.ok(!r.jobId, 'no agent, no Agent Hub job')
  assert.ok(wb.store.verify(r.id).ok)
  // no model chosen (the step names none, the workbench has no default): the run does not start
  await save({ id: 'no-model', title: 'No model', base: 'blank', steps: [{ use: 'intake' }, { id: 'sum', use: 'model', title: 'Sum', instructions: 'x' }, { use: 'report' }] })
  await assert.rejects(op('startRun', { workflow: 'no-model', title: 'x' }), /sum: no model is chosen/)
  // … with a default it does
  await op('saveSettings', { settings: { model: 'dsh:fake/model' } })
  assert.equal((await finished((await op('startRun', { workflow: 'no-model', title: 'x' })).run.id)).status, 'done')
  await op('saveSettings', { settings: { model: '' } })
}

// ── a decision that sends the run back; a rejected blocking decision stops it ──
{
  let drafts = 0
  members.scribe = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { text: `draft ${++drafts}` } })
  const r = (await op('startRun', { workflow: 'notes.publish', title: 'again', fields: { channel: 'blog' } })).run
  await until('the first sign-off', () => engine.get(r.id).status === 'waiting')
  const c1 = wb.store.list('approval').find(a => a.runId === r.id && a.status === 'pending')
  await op('approve', { id: c1.id, payload: { choice: 1 } }) // "Write it again" → back to the draft
  await until('the second sign-off', () => engine.get(r.id).status === 'waiting' && wb.store.list('approval').filter(a => a.runId === r.id && a.status === 'pending').length === 1)
  assert.equal(drafts, 2, 'the draft ran again')
  assert.equal(engine.get(r.id).stages.find(s => s.key === 'draft').attempt, 2)
  assert.equal(engine.get(r.id).stages.find(s => s.key === 'draft').history.length, 1, 'what the first draft did is kept in its history')
  const c2 = wb.store.list('approval').find(a => a.runId === r.id && a.status === 'pending')
  await op('reject', { id: c2.id, reason: 'not good enough' })
  const end = await finished(r.id)
  assert.equal(end.status, 'failed')
  assert.match(end.verdict.reason, /rejected by the person — not good enough/)
  assert.equal(wb.store.list('approval').filter(a => a.runId === r.id && a.action === 'fake_publish').length, 0, 'no publish card after a rejected sign-off')
  const rejectedReport = await automaticReport(r.id, 'Failed')
  assert.match(rejectedReport.markdown, /rejected by the person — not good enough/, 'the report reflects the refusal, not the earlier send-back')
  await assert.rejects(op('reject', { id: c2.id }), /already rejected/)
  await assert.rejects(op('approve', { id: 'nope' }), /no approval/)
  // an action that fails leaves its card failed, retryable
  const card = engine.addApproval(r.id, { action: 'fake_fail', title: 'Break', payload: {} })
  const failed = (await op('approve', { id: card.id })).approval
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /the blog is down/)
  assert.equal((await op('approve', { id: card.id })).approval.status, 'failed', 'a failed card can be approved again')
  const unknown = engine.addApproval(r.id, { action: 'no_such_action', title: 'Nothing', payload: {} })
  await assert.rejects(op('approve', { id: unknown.id }), /no action "no_such_action"/)
}

// ── a failing agent step, the fallback is the hub's; an agent that never hands a result back fails the step ──
{
  members.scribe = async () => 'finished but no stage_result'
  const r = await finished((await op('startRun', { workflow: 'notes.publish', title: 'silent', fields: { channel: 'blog' } })).run.id)
  assert.equal(r.status, 'failed')
  assert.match(r.stages.find(s => s.key === 'draft').note, /did not hand back a stage result/)
  assert.equal(tasks.get(r.stages.find(s => s.key === 'draft').tasks.at(-1)) && r.stages.find(s => s.key === 'draft').tasks.length, 2, 'one reminder, then the step fails')
}

// ── settings, models, the AI helpers ──
{
  const s = await op('settings')
  assert.equal(s.settings.agentTimeoutMinutes, 60)
  assert.deepEqual(s.settings.packs, { notes: { greeting: 'hello', limits: { chars: 500 } } }, 'a pack\'s defaults sit under settings.packs.<id>')
  assert.deepEqual(s.ai, { agent: 'scribe', model: 'fake/model' })
  assert.ok(s.agents.some(a => a.id === 'dshy'))
  assert.ok(s.optionalStages.every(x => typeof x === 'string'))
  assert.deepEqual(s.stepAgents.find(w => w.id === 'notes.publish').steps.map(x => [x.key, x.agent, x.fallback]), [['draft', 'scribe', 'dshy']])
  assert.ok(s.workflows['notes.publish'].stages.find(x => x.key === 'draft').skills.some(k => k.ref === 'notes/style'), 'the pack\'s skill uses show on its step')
  assert.deepEqual(s.connections, [{ id: 'blog-api', type: 'http', name: 'Blog API', ok: null }])
  const changed = await op('saveSettings', { settings: { agentTimeoutMinutes: 61 }, revision: s.revision })
  assert.notEqual(changed.revision, s.revision)
  await assert.rejects(op('saveSettings', { settings: s.settings, revision: s.revision }), e => e.code === 'settingsChanged', 'a stale page cannot replace a newer saved configuration')
  assert.equal((await op('settings')).settings.agentTimeoutMinutes, 61)
  await op('saveSettings', { settings: s.settings, revision: changed.revision })
  await assert.rejects(op('saveSettings', { settings: { packs: { notes: { greeting: 4 } } } }), /packs\.notes\.greeting must be a string/)
  await assert.rejects(op('saveSettings', { settings: { packs: { notes: { nope: 1 } } } }), /unknown setting packs\.notes\.nope/)
  await assert.rejects(op('saveSettings', { settings: { env: 'x' } }), /unknown setting env/)
  await assert.rejects(op('saveSettings', { settings: { steps: { 'notes.publish': { sign: { agent: 'dshy' } } } } }), /has no agent step "sign"/)
  await assert.rejects(op('saveSettings', { settings: { steps: { 'notes.publish': { draft: { agent: 'ghost' } } } } }), /no agent "ghost"/)
  await op('saveSettings', { settings: { agentTimeoutMinutes: 30, packs: { notes: { greeting: 'hello', limits: { chars: 100 } } }, steps: { 'notes.publish': { draft: { agent: 'dshy', fallback: '' } } } } })
  const saved = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
  assert.deepEqual(saved, { agentTimeoutMinutes: 30, steps: { 'notes.publish': { draft: { agent: 'dshy', fallback: '' } } }, packs: { notes: { limits: { chars: 100 } } } }, 'only what differs from the defaults is saved')
  members.dshy = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { text: 'by dshy' } })
  const r = (await op('startRun', { workflow: 'notes.publish', title: 'picked', fields: { channel: 'blog' } })).run
  await until('the draft', () => engine.get(r.id).draft)
  assert.equal(engine.get(r.id).draft.text, 'by dshy', 'a step takes the agent the settings pick over the role\'s default')
  assert.equal(engine.get(r.id).config.agentTimeoutMinutes, 30, 'a run keeps the settings it started with')
  await op('saveSettings', { settings: { agentTimeoutMinutes: 45 } })
  assert.equal(engine.get(r.id).config.agentTimeoutMinutes, 30)
  await op('saveSettings', { settings: { steps: {} } }) // back to the role's agent
  await op('stopRun', { id: r.id })
  await finished(r.id)
  assert.deepEqual((await op('models')).models, [{ id: 'fake/model', label: 'Fake / Model' }])
  assert.deepEqual((await op('translate', { texts: ['hello', ''], lang: 'zh' })).texts, ['ZH:hello', ''])
  assert.match(llmCalls.at(-1).system, /Chinese/)
  assert.match((await op('translateReport', { id: main, lang: 'en' })).markdown, /EN:/)
  await assert.rejects(op('translate', { texts: ['x'], lang: 'fr' }), /unsupported language/)
}

// ── the metrics, the home page, the shell ──
{
  const m = await op('metrics')
  assert.ok(m.all.runs > 10 && m.all.finished > 5)
  assert.equal(m.byTemplate['notes.publish'].verdicts.published, 1, 'the verdicts are the workflow\'s own words')
  assert.ok(m.byTemplate['notes.publish'].successRate > 0)
  assert.ok(m.byTemplate.blank.successRate === 1)
  assert.ok(m.recent.every(r => 'id' in r && 'title' in r))
  const part = shellParts.find(p => p.id === 'workbench')
  assert.equal(part.panel, 'ruyix-workbench')
  assert.deepEqual(part.name, { en: 'Workbench', zh: '工作台' })
  const o = part.overview()
  assert.deepEqual(o[0].tiles.map(t => t.id), ['approvals', 'running', 'success'])
  assert.equal(o[0].tiles[0].open.event, 'ruyix-workbench:open')
  assert.ok(o[0].tiles[0].value >= 1, 'a card waiting counts')
  const steps = await part.setup()
  assert.deepEqual(steps.map(s => s.id), ['workbench-agents', 'workbench-notes-connections', 'notes-extra'])
  assert.equal(steps[0].ready, true)
  assert.equal(steps[1].ready, true, 'a connection that works is ready')
  assert.equal((await service.setup()).length, 3)
  assert.deepEqual(part.busy(), [])
  // the service the other plugins use
  assert.equal(service.run(main).id, main)
  assert.equal(service.runs().length, store().list('run').length)
  assert.ok((await service.report(main)).includes('# Quarterly note'))
  assert.equal(service.approvals(main).length, 2)
  assert.equal(service.packSettings('notes').greeting, 'hello')
  assert.deepEqual(service.workflows().map(w => w.id).sort(), ['blank', 'notes.publish', 'task'])
  assert.ok(service.evidence(main, 3).every(e => e.seq > 3))
  assert.ok(service.readArtifact(wb.store.evidence(main).find(e => e.artifact).artifact).length)
  assert.equal(typeof service.revision(), 'number')
  service.note(main, { kind: 'gate', title: 'noted from outside', ok: true })
  assert.ok(wb.store.evidence(main).some(e => e.title === 'noted from outside' && e.stage === 'note'))
  assert.ok(wb.store.verify(main).ok)
  const sync = await op('sync', { since: 0 })
  assert.ok(sync.docs.some(d => d.kind === 'run') && sync.docs.some(d => d.kind === 'approval'))
  assert.ok(!sync.docs.find(d => d.id === main).stages.some(s => s.result && s.result !== true), 'the panel\'s sync leaves each step\'s result to be read on demand')
  const rr = await op('run', { id: main })
  assert.equal(rr.run.id, main)
  assert.equal(rr.active, false)
  assert.equal((await op('run', { id: main, after: 5 })).evidence[0].seq, 6)
  await assert.rejects(op('run', { id: 'nope' }), /no run/)
}

// ── the standing conversation: one thread on record, its tools, its cards, a session a day, a new topic, search ──
{
  const { ROLL, seedOf, langOfText } = await import('./lib/assistant.js')
  // the language a message is in, by its words (the panel's — the fallback — only when they do not say)
  assert.deepEqual(['今天是星期几？', 'what is running?', '打开YouTube', '用 ffmpeg 把 video.mp4 转成 gif', '帮我看下这个 error: cannot find module', 'install it on my mac', 'ok', '2', ''].map(t => langOfText(t, 'x')),
    ['zh', 'en', 'zh', 'zh', 'zh', 'en', 'x', 'x', 'x'])
  assert.deepEqual((await op('chat')).items, [], 'nothing on record yet')
  await assert.rejects(op('chatSend', { text: '  ' }), e => e.code === 'emptyMessage')
  const sent = await op('chatSend', { text: 'what is running?', lang: 'zh', tz: 'Asia/Shanghai' })
  const p1 = prompts.at(-1), s1 = fakeAgents.get(p1.sessionId)
  assert.equal(sent.sessionId, p1.sessionId)
  assert.match(p1.content[0].text, /^\[ruyix-workbench assistant\]\n[\s\S]*one standing conversation[\s\S]*notes\.publish[\s\S]*---\n\[Workbench language: English[^\n]*\n\[Now: \d{4}-\d\d-\d\d \d\d:\d\d, \w+, Asia\/Shanghai \(UTC\+08:00\)\]\nwhat is running\?$/, 'briefed, then the question in the language it is written in (not the Chinese panel\'s), at the person\'s time')
  assert.ok(!/The conversation so far/.test(p1.content[0].text), 'nothing before it to tell')
  assert.match(p1.content[0].text, /## Your skill: working this Ruyix \(ruyix-system\)\n# Working Ruyix as its main agent[\s\S]*## Sessions or a workflow/, 'dsh\'s main agent: the skill in its brief')
  const t = name => asTools.get(name)
  assert.deepEqual([...asTools.keys()].sort(), ['workbench_background_task', 'workbench_chat_history', 'workbench_evidence', 'workbench_memory_save', 'workbench_memory_search', 'workbench_metrics', 'workbench_report', 'workbench_resume_run', 'workbench_run', 'workbench_run_continue', 'workbench_run_draft', 'workbench_run_edit', 'workbench_run_file', 'workbench_run_rewind', 'workbench_run_versions', 'workbench_runs', 'workbench_setup', 'workbench_show', 'workbench_start_run', 'workbench_stop_run', 'workbench_task_run_now', 'workbench_task_schedule', 'workbench_task_update', 'workbench_tasks', 'workbench_ui', 'workbench_workflow_library', 'workbench_workflow_save', 'workbench_workflow_try', 'workbench_workflow_validate', 'workbench_workflows'])
  // a task it schedules without a time zone: the person's (their message said it), not the machine's
  await t('workbench_task_schedule').execute({ workflow: 'blank', title: 'Daily at nine', text: 'x', schedule: { kind: 'daily', at: '09:00' } }, {})
  const nine = store().list('task').find(x => x.title === 'Daily at nine')
  assert.equal(nine.tz, 'Asia/Shanghai')
  await op('taskArchive', { id: nine.id })
  // what the session says is copied into the record as it comes, once, with when it was said (the session's events folded)
  const { applyChat, draftArgs } = await import('./lib/assistant.js')
  const ui = { title: 'Runs by status', data: { runs: { fields: { id: 'string', status: 'enum' }, rows: [{ id: 'r1', status: 'done' }, { id: 'r2', status: 'failed' }] } }, widgets: [{ view: 'breakdown', data: 'runs', by: 'status' }] }
  const call = (name, args, seq) => ({ type: 'tool/call', seq, time: 2500 + seq, data: { name, arguments: JSON.stringify(args) } })
  const folded = [
    { type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: p1.content[0].text }] } },
    call('workbench_runs', { status: 'active' }, 2), call('workbench_runs', { status: 'failed' }, 3),
    { type: 'assistant/message', time: 2000, data: { message: { content: [{ type: 'text', text: 'Two runs; one failed.' }] } } },
    call('workbench_ui', ui, 4),
    call('workbench_run_draft', { workflow: 'blank', title: 'Look into the failure', text: 'r2 failed at its report', fields: { a: 1, b: { no: 1 }, c: ['x', 2] } }, 5),
    call('workbench_workflow_save', { definition: { id: 'research-note', title: 'Research note', base: 'blank', steps: [{}, {}, {}] } }, 6),
    call('workbench_show', { view: 'runs', run: 'r2', tab: 'nonsense' }, 7),
    call('ruyix_change_propose', { summary: 'Move Chat to the top', edits: [] }, 8),
    call('workbench_run_rewind', { id: 'r2', step: 'outline', why: 'the outline went the wrong way' }, 81),
    call('workbench_run_edit', { id: 'r2', path: 'notes.md', content: 'x'.repeat(200_001), then: 'review' }, 82),
    { type: 'turn/end', time: 3000, data: { reason: { kind: 'error', error: { message: 'the model is gone' } } } },
  ].reduce(applyChat, { on: false, items: [] })
  assert.deepEqual(folded.items.map(i => i.kind), ['user', 'tool', 'tool', 'text', 'genui', 'draft', 'workflow', 'ui', 'change', 'runop', 'runop', 'error'])
  assert.equal(folded.total, 12)
  // a change to a run the assistant proposed: a card (the person applies it); a change too long to arrive whole is marked
  assert.deepEqual(folded.items[9].args, { op: 'rewind', run: 'r2', step: 'outline', why: 'the outline went the wrong way' })
  assert.deepEqual({ ...folded.items[10].args, content: folded.items[10].args.content.length }, { op: 'edit', run: 'r2', path: 'notes.md', then: 'review', content: 200_000, cut: true })
  assert.equal(folded.items[0].text, 'what is running?', 'the question only: the brief and the language line cut')
  assert.deepEqual(folded.items[5].args, { workflow: 'blank', title: 'Look into the failure', text: 'r2 failed at its report', fields: { a: 1, c: ['x'] } }, 'a card\'s arguments as a page can show them')
  assert.deepEqual(folded.items[6].args, { id: 'research-note', title: 'Research note', steps: 3 })
  assert.deepEqual(folded.items[7].args, { view: 'runs', run: 'r2' }, 'an unknown tab is left out')
  assert.deepEqual(folded.items[8].args, { summary: 'Move Chat to the top' })
  assert.deepEqual(draftArgs('{not json'), { workflow: 'blank' })
  assert.equal([{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'not ours' }] } } }].reduce(applyChat, { on: false, items: [] }).items.length, 0, 'only a session MARK opened')
  assert.equal(applyChat(folded, call('workbench_ui', { widgets: [], pad: 'x'.repeat(200_000) }, 9)).items.length, folded.items.length, 'a board too large to keep is not kept')
  s1.session.chat = folded
  const page = await op('chat')
  assert.deepEqual(page.items.map(i => [i.kind, i.at]), folded.items.map(i => [i.kind, i.at]))
  assert.equal(page.running, false)
  assert.deepEqual((await op('chat', { after: page.items.at(-1).n })).items, [], 'once')
  const card = page.items.find(i => i.kind === 'draft')
  // the tools over the workbench
  const text = async (name, args) => (await t(name).execute(args)).text
  assert.match(await text('workbench_runs', { status: 'failed' }), /silent|again/)
  assert.match(await text('workbench_run', { id: main }), /Quarterly note[\s\S]*## Steps[\s\S]*Publish "Quarterly note"/)
  assert.match(await text('workbench_report', { id: main }), /Evidence ledger/)
  assert.match(await text('workbench_evidence', { run: main, seq: 3 }), /#3 file/)
  assert.match(await text('workbench_metrics', {}), /all: \d+\/\d+ finished/)
  assert.match(await text('workbench_workflows', {}), /notes\.publish \(Publish a note\) — fields: channel\*:select/)
  assert.match(await text('workbench_workflow_library', { base: 'notes.publish' }), /your steps go after draft[\s\S]*- draft — agent step: role writer, default agent scribe, fallback dshy[\s\S]*# Generic step kinds: agent, model, script, approval, person, output, branch, parallel[\s\S]*notes_count/)
  assert.match(await text('workbench_workflow_library', { base: 'blank' }), /# The workflow-create skill/)
  await assert.rejects(t('workbench_workflow_library').execute({ base: 'nope' }), /no built-in workflow/)
  assert.match(await text('workbench_workflow_validate', { definition: { id: 'x1', title: 'X', base: 'blank', steps: [{ use: 'intake' }] } }), /report is a required step/)
  assert.match(await text('workbench_setup', {}), /Workbench: agents: ready/)
  assert.match(await text('workbench_show', { view: 'runs', run: main, tab: 'report' }), /Showing runs/)
  assert.match(await text('workbench_run_draft', { workflow: 'blank', title: 'x' }), /Card shown: "x" \(blank\)[\s\S]*do not start it yourself/)
  assert.match(await text('workbench_run_draft', { workflow: 'nope', title: 'x' }), /"nope" is not a workflow a run can start on \(blank, task, notes\.publish/)
  // a board drawn in the chat: drawn when it checks; one that does not, the assistant is told why (and it is not drawn)
  assert.equal(await text('workbench_ui', ui), 'Drawn in the chat.')
  assert.match(await text('workbench_ui', { widgets: [{ view: 'pie' }] }), /^Not drawn — fix and call again:\n- widgets\.0\.view: view: one of count/)
  assert.match(await text('workbench_ui', { data: { runs: { fields: { id: 'string' }, rows: [] } }, widgets: [{ view: 'trend', data: 'runs' }] }), /a trend needs its rows' time/)
  // the skill's own example is a valid workflow
  const skill = readFileSync(join(here, 'skills/workflow-create/SKILL.md'), 'utf8')
  const example = JSON.parse(skill.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.match(await text('workbench_workflow_validate', { definition: example }), /Valid: 5 steps/, 'the example in the skill checks out')
  assert.match(await text('workbench_workflow_save', { definition: example }), /Saved "research-note" as a draft\. Its card in the conversation opens it in the editor/)
  assert.equal(JSON.parse(readFileSync(join(home, 'workflows', 'research-note.json'), 'utf8')).status, 'draft')
  const listedWorkflow = (await op('workflows')).mine.find(d => d.id === example.id)
  assert.match(await text('workbench_workflows', {}), new RegExp(listedWorkflow.revision))
  await text('workbench_workflow_save', { definition: { ...example, title: 'Version two', messages: true, sessions: true }, expect: listedWorkflow.revision })
  const workflowListing = await text('workbench_workflows', {})
  assert.match(workflowListing, /"messages":true/); assert.match(workflowListing, /"sessions":true/)
  await assert.rejects(t('workbench_workflow_save').execute({ definition: example, expect: listedWorkflow.revision }), e => e.code === 'workflowChanged')
  const newestWorkflow = (await op('workflows')).mine.find(d => d.id === example.id)
  await text('workbench_workflow_save', { definition: example, expect: newestWorkflow.revision })
  // a run the assistant started (the person said so): on record after what was said, its state followed there
  const started = await text('workbench_start_run', { workflow: 'blank', title: 'from the assistant' })
  assert.match(started, /Started r/)
  await assert.rejects(t('workbench_start_run').execute({ workflow: 'notes.publish', title: 'x' }), /Channel: required/, 'the assistant is held to the same form')
  const rid = /Started (r\w+)/.exec(started)[1]
  const ran = (await op('chat')).items.at(-1)
  assert.deepEqual([ran.kind, ran.args], ['run', { run: rid, workflow: 'blank', title: 'from the assistant' }])
  assert.deepEqual(engine.get(rid).tags, ['chat'])
  await finished(rid)
  assert.match(await text('workbench_stop_run', { id: rid }), /done/)
  // tasks: the run it started hangs off the conversation's task (docs/design/agent-tasks.md); a scheduled one only when
  // the person says so (checked as a run is)
  const asked = (await op('chat')).task
  assert.equal(engine.get(rid).taskId, asked.id)
  assert.equal((await op('taskGet', { id: asked.id })).task.source, 'chat')
  assert.match(await text('workbench_tasks', { query: asked.title }), new RegExp(`${asked.id} \\| ${asked.title.replace(/[?]/g, '\\?')} \\| chat \\| once \\| 1 run\\(s\\), last ${rid}`))
  await assert.rejects(t('workbench_task_schedule').execute({ workflow: 'notes.publish', title: 'x', schedule: { kind: 'daily', at: '08:00' } }), /Channel: required/, 'checked when made, not when due')
  await assert.rejects(t('workbench_task_schedule').execute({ workflow: 'blank', title: 'x', schedule: { kind: 'daily', at: '8 am' } }), /time like 08:00/)
  const made = await text('workbench_task_schedule', { workflow: 'blank', title: 'Morning brief', text: 'what changed overnight', schedule: { kind: 'daily', at: '08:00', days: [1, 2, 3, 4, 5] }, tz: 'Asia/Shanghai' })
  const tid = /Made (t\w+)/.exec(made)[1]
  assert.match(made, /Morning brief \| blank \| weekdays at 08:00 \(Asia\/Shanghai\), next \d{4}-\d\d-\d\d \d\d:\d\d UTC \| 0 run\(s\)/)
  assert.match(await text('workbench_task_update', { id: tid, enabled: false }), /paused/)
  assert.match(await text('workbench_tasks', { scheduled: true }), new RegExp(`${tid} \\| Morning brief`))
  const now1 = await text('workbench_task_run_now', { id: tid })
  const tr = /Started (r\w+), a run of/.exec(now1)[1]
  assert.equal(engine.get(tr).taskId, tid)
  await finished(tr)
  assert.equal((await op('taskArchive', { id: tid })).task.nextAt, null)
  assert.match(await text('workbench_resume_run', { id: main }).catch(e => e.message), /cannot be resumed/)
  // a card: the person starts it (the page starts the run, then says so) — or lets it go; only a card is one
  const [firstStart, sameStart] = await Promise.all([op('chatDraftStart', { n: card.n, request: { workflow: 'blank', title: card.args.title, text: card.args.text } }), op('chatDraftStart', { n: card.n, request: { workflow: 'blank', title: card.args.title, text: card.args.text } })])
  const fromCard = firstStart.run, took = firstStart.item
  assert.equal(sameStart.run.id, fromCard.id, 'two mounted views start one run for one card')
  assert.deepEqual([took.kind, took.outcome.status, took.outcome.run, took.at], ['draft', 'started', fromCard.id, card.at])
  await assert.rejects(op('chatDraftStart', { n: card.n }), e => e.code === 'cardDone')
  await assert.rejects(op('chatDraftDone', { n: page.items[0].n }), e => e.code === 'noCard')
  await assert.rejects(op('chatDraftDone', { n: card.n, status: 'started', run: 'r-nope' }), e => e.code === 'cardDone')
  await assert.rejects(op('chatDraftDone', { n: card.n, status: 'maybe' }), e => e.code === 'cardDone')
  // a change to a run proposed as a card: applied on the page (it says what it did) or let go — on record either way
  const [rewindCard, editCard] = page.items.filter(i => i.kind === 'runop')
  const applied = (await op('chatRunOpDone', { n: rewindCard.n, status: 'applied', result: { from: 'outline', secret: { no: 1 } } })).item
  assert.deepEqual([applied.outcome.status, applied.outcome.result], ['applied', { from: 'outline' }])
  await assert.rejects(op('chatRunOpDone', { n: rewindCard.n, status: 'applied', result: {} }), e => e.code === 'cardDone')
  assert.equal((await op('chatRunOpDone', { n: editCard.n, status: 'dismissed' })).item.outcome.status, 'dismissed')
  await assert.rejects(op('chatRunOpDone', { n: card.n }), e => e.code === 'noCard', 'only a run-change card')
  await assert.rejects(op('chatRunOpDone', { n: rewindCard.n, status: 'maybe' }), e => e.code === 'cardDone')
  await finished(fromCard.id)
  // the next message goes on in the same session (no brief again)
  await op('chatSend', { text: 'and then?', lang: 'en' })
  assert.equal(prompts.at(-1).sessionId, s1.id)
  assert.match(prompts.at(-1).content[0].text, /^\[Workbench language: English — reply in it unless the user asks for another language\]\n\[Now: [^\n]*Asia\/Shanghai[^\n]*\]\nand then\?$/)
  // what the person sees of it: their words only (the language and the clock lines are for the agent)
  assert.equal(applyChat({ on: true, items: [], total: 0 }, { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: prompts.at(-1).content[0].text }] } }).items[0].text, 'and then?')
  s1.session.chat = [{ type: 'user/message', time: 4000, data: { content: [{ type: 'text', text: 'and then?' }] } }].reduce(applyChat, folded)
  // a day later the next message starts another session, told the conversation so far (its cards with what became of them)
  clock += 864e5
  await op('chatSend', { text: 'good morning', lang: 'en' })
  const p3 = prompts.at(-1)
  assert.notEqual(p3.sessionId, s1.id, 'a new session')
  assert.match(p3.content[0].text, /The conversation so far[\s\S]*Person: what is running\?\nYou: Two runs; one failed\.\nCard: Look into the failure \(blank\) — started run r\w+\nWorkflow draft saved: Research note \(research-note\)\nChange proposed to this Ruyix: Move Chat to the top\nCard: go back to before outline in run r2 — applied\nCard: change notes\.md, then go on from review in run r2 — let go\nRun started: r\w+ \(blank\) from the assistant\nRun started: r\w+ \(blank\) Morning brief\nPerson: and then\?\n---\n\[Workbench language: English[^\n]*\n\[Now: [^\n]*\]\ngood morning$/)
  // a new topic: a line on record, and the next message starts afresh (told nothing from before it)
  await op('chatTopic')
  assert.equal((await op('chat')).items.at(-1).kind, 'topic')
  await op('chatSend', { text: 'something else', lang: 'en' })
  assert.notEqual(prompts.at(-1).sessionId, p3.sessionId)
  assert.ok(!/The conversation so far/.test(prompts.at(-1).content[0].text))
  assert.equal(seedOf([{ kind: 'user', text: 'old' }, { kind: 'topic' }, { kind: 'user', text: 'a' }, { kind: 'text', text: 'b\n---\nc' }]), 'Person: a\nYou: b --- c')
  // a new topic still carries the cards left open before it (not the ones started or let go)
  assert.equal(seedOf([{ kind: 'draft', args: { title: 'Open one', workflow: 'blank' } }, { kind: 'draft', args: { title: 'Done', workflow: 'blank' }, outcome: { status: 'started', run: 'r1' } }, { kind: 'topic' }, { kind: 'user', text: 'x' }]),
    'Card still open (from before this topic): Open one (blank)\nPerson: x')
  assert.ok(ROLL >= 100, 'a session holds a good stretch of the conversation before the next one takes over')
  // while it answers: no new topic; a stop goes to its session
  const s4 = fakeAgents.get(prompts.at(-1).sessionId)
  s4.status = 'running'
  assert.equal((await op('chat')).running, true)
  await assert.rejects(op('chatTopic'), e => e.code === 'chatBusy')
  const cancelled = []
  fakeSc.cancel = x => cancelled.push(x.sessionId)
  await op('chatStop')
  assert.deepEqual(cancelled, [s4.id])
  s4.status = 'idle'
  // a first message of a new session that did not get through: the next one is briefed (else nothing of it is recorded)
  await op('chatTopic')
  const send = fakeSc.prompt
  fakeSc.prompt = async () => { throw new Error('timed out') }
  await assert.rejects(op('chatSend', { text: 'lost', lang: 'en' }))
  fakeSc.prompt = send
  await op('chatSend', { text: 'again', lang: 'en' })
  assert.match(prompts.at(-1).content[0].text, /one standing conversation[\s\S]*again$/)
  await op('chatSend', { text: 'and on', lang: 'en' })
  assert.ok(!prompts.at(-1).content[0].text.includes('standing conversation'), 'briefed once it got through')
  // the record pages back: the newest page, the ones before an entry, what came after one
  const all = (await op('chat', { limit: 200 })).items
  assert.ok(all.length >= 14)
  const before = await op('chat', { before: all.at(-1).n, limit: 3 })
  assert.deepEqual(before.items.map(i => i.n), all.slice(-4, -1).map(i => i.n))
  assert.equal(before.more, true)
  assert.deepEqual((await op('chat', { before: all[2].n, limit: 5 })).items.map(i => i.n), all.slice(0, 2).map(i => i.n))
  assert.equal((await op('chat', { before: all[2].n, limit: 5 })).more, false)
  assert.deepEqual((await op('chat', { after: all.at(-3).n })).items.map(i => i.n), all.slice(-2).map(i => i.n))
  assert.deepEqual((await op('chat', { limit: 2 })).items.map(i => i.n), all.slice(-2).map(i => i.n))
  // search: the record's words (a message, a card's title or request, a workflow, a change), not its own names; newest first
  assert.deepEqual((await op('chatSearch', { q: 'running?' })).items.map(i => i.kind), ['user'])
  assert.deepEqual((await op('chatSearch', { q: 'failure' })).items.map(i => i.kind), ['draft'], 'a card by its title')
  assert.deepEqual((await op('chatSearch', { q: 'at its report' })).items.map(i => i.kind), ['draft'], '… and its request')
  assert.deepEqual((await op('chatSearch', { q: 'research-note' })).items.map(i => i.kind), ['workflow'])
  assert.deepEqual((await op('chatSearch', { q: 'Chat to the top' })).items.map(i => i.kind), ['change'])
  assert.deepEqual((await op('chatSearch', { q: 'draft' })).items, [], 'the record\'s own names are not words')
  assert.deepEqual((await op('chatSearch', { q: '100%_' })).items, [], 'LIKE\'s own signs are plain characters')
  assert.deepEqual((await op('chatSearch', { q: ' ' })).items, [])
  const both = (await op('chatSearch', { q: 'the' })).items
  assert.ok(both.length >= 3 && both.every((i, k) => !k || i.n < both[k - 1].n), 'newest first')
  // the history tool: what the assistant no longer remembers, by number or by words
  assert.match(await text('workbench_chat_history', { query: 'running?' }), /^\d+ \| \d{4}-\d\d-\d\dT\d\d:\d\d \| person \| what is running\?$/)
  assert.match(await text('workbench_chat_history', { before: card.n + 1, limit: 3 }), /\| you \| Two runs; one failed\.\n\d+ \| [^|]+\| card \| Look into the failure \(blank\) — started run r/)
  // what the conversations keep: the assistant keeps a fact and finds it (never a credential); the person adds, changes, pins and lets go
  assert.match(await text('workbench_memory_save', { text: 'Prefers answers in short bullet lists', kind: 'preference' }), /^Kept as #1\.$/)
  assert.equal(await text('workbench_memory_save', { text: 'prefers  answers in short bullet lists' }), 'Kept already.')
  await assert.rejects(t('workbench_memory_save').execute({ text: 'the password for the blog is hunter2' }), /looks like a credential/)
  await assert.rejects(t('workbench_memory_save').execute({ text: 'Authorization: Bearer abcdefghijkl' }), /looks like a credential/)
  assert.equal(await text('workbench_memory_search', { query: 'bullet' }), '#1 (preference) Prefers answers in short bullet lists')
  assert.equal(await text('workbench_memory_search', { query: 'nothing like it' }), '(nothing kept)')
  assert.equal((await op('memories')).items[0].uses, 1, 'a search that found it counts as a use')
  const added = (await op('memorySave', { text: 'Reports go to the blog channel first', kind: 'decision', pinned: true })).item
  assert.deepEqual([added.by, added.kind, added.pinned], ['person', 'decision', 1])
  assert.deepEqual((await op('memories')).items.map(m => m.id), [added.id, 1], 'pinned first')
  assert.deepEqual((await op('memories', { q: 'blog channel' })).items.map(m => m.id), [added.id], 'found by words')
  assert.equal((await op('memorySave', { id: 1, text: 'Prefers short bullet lists', kind: 'preference', pinned: true })).item.text, 'Prefers short bullet lists', 'changed')
  assert.equal((await op('memorySave', { id: 1, pinned: false })).item.pinned, 0)
  assert.equal((await op('memorySave', { text: 'two\n---\nlines' })).item.text, 'two --- lines', 'a memory is one line')
  await assert.rejects(op('memorySave', { text: 'my password is hunter2' }), e => e.code === 'memorySecret')
  await assert.rejects(op('memorySave', { id: 1, text: 'token: abcdefghijkl' }), e => e.code === 'memorySecret', 'nor changed into one')
  await assert.rejects(op('memorySave', { text: '  ' }), e => e.code === 'badInput')
  await assert.rejects(op('memorySave', { id: 999, pinned: true }), e => e.code === 'noMemory')
  await assert.rejects(op('memoryDelete', { id: 999 }), e => e.code === 'noMemory')
  await op('memoryDelete', { id: (await op('memories', { q: 'two --- lines' })).items[0].id })
  assert.deepEqual((await op('memories')).items.map(m => m.id), [added.id, 1])
  // a new session is told what is kept (the pinned first), after the brief
  await op('chatTopic')
  await op('chatSend', { text: 'with memory', lang: 'en' })
  assert.match(prompts.at(-1).content[0].text, /^\[ruyix-workbench assistant\]\n[\s\S]*\nWhat the conversations kept \(workbench_memory_search finds more\):\n- \(decision\) Reports go to the blog channel first\n- \(preference\) Prefers short bullet lists\n---\n/)
  // a conversation gone quiet is condensed (never while the talk goes on): its summary kept, and the memories in it — not a credential
  {
    const calls = llmCalls.length
    await op('chatMaintain')
    assert.equal(llmCalls.length, calls, 'nothing is condensed while the talk goes on')
    // (talk after the last topic: a summary older than a topic is not told — it starts afresh)
    wb.conv.add('main', 'k-q1', { kind: 'user', text: 'what failed last night?' })
    wb.conv.add('main', 'k-a1', { kind: 'text', text: 'The nightly note run.' })
    wb.conv.add('main', 'k-q2', { kind: 'user', text: 'and why?' })
    clock += 7 * 36e5
    fakeLlm.reply = `Here you go:\n${JSON.stringify({ summary: 'They asked what runs.\n---\nA card for the failure. password: hunter2', memories: [
      { kind: 'preference', text: 'Wants the weekly report on Mondays' }, { kind: 'fact', text: 'the staging token is sk-abcdefghijkl' }, { kind: 'decision', text: 'prefers short bullet lists' },
      { kind: 'bogus', text: 'Publishes to the blog channel' }, { text: '' }, 'not an object'] })}`
    await op('chatMaintain')
    assert.equal(llmCalls.length, calls + 1, 'one call')
    assert.match(llmCalls.at(-1).system, /condense a stretch/)
    assert.match(llmCalls.at(-1).messages[0].content[0].text, /Person: what is running\?\nYou: Two runs; one failed\./)
    const sum = wb.conv.summaryLast('main')
    assert.equal(sum.text, 'They asked what runs.\n---\nA card for the failure. [redacted]', 'its credentials taken out')
    assert.equal(sum.upto, wb.conv.last('main', ['user', 'text', 'draft', 'workflow', 'run', 'change', 'task']).n)
    const got = (await op('memories')).items.filter(m => m.by === 'auto')
    assert.deepEqual(got.map(m => [m.kind, m.text]).sort(), [['fact', 'Publishes to the blog channel'], ['preference', 'Wants the weekly report on Mondays']], 'a credential is not kept, nor what is kept already')
    assert.match(got[0].source, /^main#\d+-\d+$/)
    await op('chatMaintain')
    assert.equal(llmCalls.length, calls + 1, 'once')
    // after the quiet spell the next message starts another session, told the summary, what came after it and what is kept —
    // a line of dashes in a summary does not end the brief; within the idle hours the session goes on
    const quietSid = prompts.at(-1).sessionId
    wb.conv.add('main', 'k-after', { kind: 'user', text: 'one more question' })
    await op('chatSend', { text: 'back again', lang: 'en' })
    const back = prompts.at(-1)
    assert.notEqual(back.sessionId, quietSid, 'a new session after seven quiet hours')
    assert.match(back.content[0].text, /\nThe conversation so far[^\n]*\nSummary of what came before \(workbench_chat_history has it whole\):\nThey asked what runs\.\n— — —\nA card for the failure\. \[redacted\]\n\nSince then:\nPerson: one more question\n---\n\[Workbench language: English[^\n]*\n\[Now: [^\n]*\]\nback again$/)
    assert.match(back.content[0].text, /What the conversations kept[^\n]*\n- \(decision\) Reports go to the blog channel first\n/)
    clock += 5 * 36e5
    await op('chatSend', { text: 'five hours later', lang: 'en' })
    assert.equal(prompts.at(-1).sessionId, back.sessionId, 'five hours is within the six')
    assert.ok(!prompts.at(-1).content[0].text.includes('standing conversation'))
    await op('saveSettings', { settings: { chat: { idleHours: 1, keepDays: 90, maxTasks: 3 } } })
    clock += 2 * 36e5
    await op('chatSend', { text: 'two hours later', lang: 'en' })
    assert.notEqual(prompts.at(-1).sessionId, back.sessionId, 'the idle hours are the person\'s setting')
    await op('saveSettings', { settings: { chat: { idleHours: 6, keepDays: 90, maxTasks: 3 } } })
    await sleep(30)
    // a new topic condenses what came before it (not waited for)
    wb.conv.add('main', 'u1', { kind: 'user', text: 'one more thing' })
    wb.conv.add('main', 'u2', { kind: 'user', text: 'and another' })
    fakeLlm.reply = 'They talked about runs.' // (a model that answers in plain words: those are the summary)
    await op('chatTopic')
    await until('the summary made at the topic', () => wb.conv.summaryLast('main').text === 'They talked about runs.')
    assert.equal(llmCalls.length, calls + 2)
    await op('chatSend', { text: 'after the topic', lang: 'en' }) // (a session for what follows)
    fakeLlm.reply = undefined
  }
  // the model the conversation runs on: kept for its next sessions
  await assert.rejects(op('setChatModel', { model: 'nope' }), e => e.code === 'badInput')
  await op('setChatModel', { model: 'fake/model' })
  assert.equal((await op('chat')).model, 'fake/model')
}
// ── the conversation on a pool agent (Claude Code, Codex): its turns on record, its CLI session going on, its tools over the bridge ──
{
  hub.agentsList.set('pi-x', { id: 'pi-x', runtime: 'pi' })
  const offered = (await op('chatAgents')).agents
  assert.ok(offered.some(a => a.id === 'opus') && offered.some(a => a.id === 'pi-x') && offered.every(a => ['claude', 'codex', 'pi'].includes(a.runtime)), 'pi takes the tools too (its built-in MCP): offered')
  assert.ok(!offered.some(a => a.id === 'scribe'), 'a dsh agent is the conversation\'s own model, not a pool agent to switch to')
  await assert.rejects(op('setChatAgent', { agent: 'nobody' }), e => e.code === 'noChatAgent')
  // the outgoing dsh session's last words go on record first; the agent it changes to is told the conversation so far
  fakeAgents.get(prompts.at(-1).sessionId).session.chat = { on: true, total: 1, items: [{ kind: 'user', text: 'and on', at: 5000 }] }
  await op('setChatAgent', { agent: 'opus' })
  assert.equal((await op('chat')).agent, 'opus')
  assert.deepEqual((await op('chat')).pick, { agent: 'opus' }, 'picked for this conversation')
  const turns = []
  hub.chatTurn = async x => {
    const a = bridge(x.mcp)
    const listed = (await a.tools()).map(d => d.name)
    const drawn = await a.call('workbench_ui', { widgets: [{ view: 'note', text: 'x' }] })
    turns.push({ ...x, listed, drawn })
    x.onEvent({ type: 'tool/call', data: { name: 'mcp__ruyix-workbench__workbench_run_draft', arguments: JSON.stringify({ workflow: 'blank', title: 'Via the CLI' }) } })
    x.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A card for it.' }] } } })
    return { sessionId: `cli-${turns.length}` }
  }
  const settle = async () => { for (let i = 0; i < 200 && (await op('chat')).running; i++) await sleep(10) }
  await op('chatSend', { text: 'look into it', lang: 'en' })
  await settle()
  const [t1] = turns
  assert.equal(t1.agent, 'opus')
  assert.equal(t1.resume, null, 'a first turn: a new CLI session')
  assert.match(t1.instructions, /one standing conversation[\s\S]*What the conversations kept[^\n]*\n- \(decision\) Reports go to the blog channel first\n(- [^\n]*\n)*\nThe conversation so far[^\n]*\nPerson: and on\n$/)
  assert.ok(!t1.instructions.startsWith('[ruyix-workbench') && !t1.instructions.endsWith('---\n'), 'the brief as instructions (no chat framing)')
  assert.match(t1.instructions, /## Your skill: working this Ruyix \(ruyix-system\)\n# Working Ruyix as its main agent[\s\S]*ui_card/, 'the main agent\'s skill (how to work the whole system) in a CLI agent\'s brief too: a CLI loads a skill only when it judges a request matches')
  assert.equal(t1.skills, undefined, '(not also given as a skill: the same text twice)')
  assert.match(t1.prompt, /^\[Workbench language: English[^\n]*\n\[Now: [^\n]*, Asia\/Shanghai \(UTC\+08:00\)\]\nlook into it$/, 'the person\'s zone, kept from an earlier message')
  assert.ok(['workbench_run_draft', 'workbench_ui', 'workbench_chat_history', 'workbench_runs'].every(n => t1.listed.includes(n)), 'the conversation\'s tools over MCP')
  assert.equal(t1.drawn, 'Drawn in the chat.')
  const got = (await op('chat')).items.slice(-3)
  assert.deepEqual(got.map(i => i.kind), ['user', 'draft', 'text'])
  assert.deepEqual([got[1].args.title, got[1].agent], ['Via the CLI', 'opus'], 'its card as a card (the MCP name read)')
  // the turn's token is gone with it
  await assert.rejects(bridge(t1.mcp).tools(), /not a live workbench run/)
  // its task (docs/design/agent-tasks.md): the request, waiting on the person — a card for them to start; the strip's line
  const c1 = await op('chat')
  assert.deepEqual([c1.task.state, c1.task.waitingFor?.kind], ['waiting', 'card'])
  assert.deepEqual([c1.line.kind, c1.line.text], ['said', 'A card for it.'])
  // the next turn goes on in its CLI session, told the same conversation so far — and in the same task (a follow-up)
  await op('chatSend', { text: 'and?', lang: 'en' })
  await settle()
  assert.equal((await op('chat')).task.id, c1.task.id, 'a follow-up on it stays in its task')
  assert.equal(turns[1].resume, 'cli-1')
  assert.equal(turns[1].instructions, t1.instructions)
  // a turn that failed on its session lets it go: the next starts afresh
  const keep = hub.chatTurn
  hub.chatTurn = async () => ({ sessionId: null, error: 'session not found' })
  await op('chatSend', { text: 'third', lang: 'en' })
  await settle()
  assert.equal((await op('chat')).items.at(-1).text, 'session not found')
  hub.chatTurn = keep
  await op('chatSend', { text: 'fourth', lang: 'en' })
  await settle()
  assert.equal(turns.at(-1).resume, null)
  // a quiet spell on a pool agent too: its next turn is a new CLI session, told the summary
  wb.conv.summaryAdd('main', wb.conv.last('main').n, 'Looked into the failing run.', clock)
  await op('chatSend', { text: 'right after', lang: 'en' })
  await settle()
  assert.equal(turns.at(-1).resume, 'cli-' + (turns.length - 1), 'within the idle hours its CLI session goes on')
  // opus the main agent too: after a quiet spell (another conversation: the pick let go) the main agent answers — opus again, in a new CLI session
  hub.mainId = 'opus'
  clock += 7 * 36e5
  await op('chatSend', { text: 'after a quiet spell', lang: 'en' })
  await settle()
  assert.equal(turns.at(-1).resume, null)
  assert.match(turns.at(-1).instructions, /\nThe conversation so far[^\n]*\nSummary of what came before[^\n]*\nLooked into the failing run\./)
  // a working folder that cannot be made (the workspace is a file): the turn ends with the error on record, it does not stay "answering"
  {
    const file = join(tmp, 'workspace-is-a-file')
    writeFileSync(file, 'x')
    await op('saveSettings', { settings: { workspace: file } })
    const calls = turns.length
    await op('chatSend', { text: 'in a bad folder', lang: 'en' })
    await settle()
    const bad = await op('chat')
    assert.equal(bad.running, false, 'not stuck at "still answering"')
    assert.deepEqual([bad.items.at(-2).text, bad.items.at(-1).kind], ['in a bad folder', 'error'])
    assert.match(bad.items.at(-1).text, /^the working folder .*workspace-is-a-file cannot be made: /)
    assert.equal(turns.length, calls, 'no turn was started')
    await op('saveSettings', { settings: { workspace: '' } })
    await op('chatSend', { text: 'fixed', lang: 'en' }) // (not refused as busy)
    await settle()
    assert.equal(turns.length, calls + 1)
  }
  assert.equal((await op('chat')).pick, null, 'the quiet spell let the pick go')
  // a pick is for one conversation: a new topic lets it go
  await op('setChatAgent', { agent: 'pi-x' })
  assert.deepEqual((await op('chat')).pick, { agent: 'pi-x' })
  await op('chatTopic')
  assert.equal((await op('chat')).pick, null)
  // the main agent back on dsh: the conversation follows it (no pick)
  hub.mainId = null
  await op('setChatAgent', { agent: null })
  assert.equal((await op('chat')).agent, null)
  assert.equal((await op('chat')).main, null)
  hub.agentsList.delete('pi-x')
  delete hub.chatTurn
}



// ── the main agent's system tools: offered in the conversation (not the undo ones); what a direct one did is on record with its way back ──
{
  const did = []
  const sch = { type: 'object', properties: {}, additionalProperties: true }
  sysTools.set('desk_get', { name: 'desk_get', effect: 'read', description: 'the desktop', parameters: sch, run: async () => ({ text: 'theme: night' }) })
  sysTools.set('desk_set', { name: 'desk_set', effect: 'direct', title: { zh: '改桌面', en: 'Change the desktop' }, description: 'change it', parameters: sch,
    run: async (a, { by }) => { did.push(['set', a, by]); return { text: 'Done.', summary: { zh: '主题：极光', en: 'Theme: Aurora' }, undo: { tool: 'desk_undo', args: { id: 'c1' } } } } })
  sysTools.set('apps_install', { name: 'apps_install', effect: 'direct', description: 'install', parameters: sch, run: async a => { did.push(['install', a]); return { text: 'Installing.', summary: { zh: '开始安装：GIMP', en: 'Installing: GIMP' } } } })
  sysTools.set('desk_undo', { name: 'desk_undo', effect: 'undo', description: 'undo', parameters: sch, run: async a => { did.push(['undo', a]); return { text: 'Undone.', summary: { zh: '撤销了桌面改动', en: 'Undone' } } } })
  hub.agentsList.set('opus', hub.agentsList.get('opus') || { id: 'opus', runtime: 'claude', name: 'Opus' })
  hub.mainId = 'opus'
  const seen = []
  hub.chatTurn = async x => {
    const a = bridge(x.mcp)
    seen.push((await a.tools()).map(d => d.name))
    seen.push(await a.call('desk_get', {}), await a.call('desk_set', { theme: 'aurora' }), await a.call('apps_install', { app: 'gimp' }))
    return { sessionId: 'cli-sys' }
  }
  await op('chatSend', { text: 'make it aurora and install gimp', lang: 'en', via: 'voice' })
  for (let i = 0; i < 200 && (await op('chat')).running; i++) await sleep(10)
  assert.ok(seen[0].includes('desk_set') && seen[0].includes('apps_install') && seen[0].includes('desk_get'), 'the system tools over the bridge')
  assert.ok(!seen[0].includes('desk_undo'), 'an undo tool is offered to no agent')
  assert.deepEqual(seen.slice(1), ['theme: night', 'Done.', 'Installing.'])
  assert.match(did[0][2], /\(the main agent, as the person asked\)$/)
  const acts = await op('chatActions')
  assert.deepEqual(acts.items.map(i => [i.tool, i.summary.en, !!i.undo]), [['apps_install', 'Installing: GIMP', false], ['desk_set', 'Theme: Aurora', true]], 'newest first; a read is not an action')
  assert.deepEqual(acts.heard.text, 'make it aurora and install gimp', 'what it heard last (voice)')
  assert.equal(acts.main.id, 'opus')
  await assert.rejects(op('chatUndo', { n: acts.items[0].n }), e => e.code === 'noUndo')
  const [undone, duplicate] = await Promise.all([1, 2].map(() => op('chatUndo', { n: acts.items[1].n })))
  assert.deepEqual(duplicate, undone, 'concurrent undo requests share the one completed action')
  assert.ok(undone.item.undone)
  assert.deepEqual(did.at(-1), ['undo', { id: 'c1' }])
  assert.equal((await op('chatActions')).items[0].summary.en, 'Undone', 'the undo is on record too')
  await op('chatUndo', { n: acts.items[1].n })
  assert.equal(did.filter(d => d[0] === 'undo').length, 1, 'undone once')
  // several questions at once (docs/design/desk-answers.md): one asked while another is answered goes at once, in a
  // session of its own (told the conversation so far); three at most, the fourth waits its turn; a follow-up of one
  // waits for its own turn, then goes on in its session, on its task and its leaf; each its own task, its own entries
  {
    const waiting = new Map(), seen = []
    hub.chatTurn = async x => {
      const q = x.prompt.split('\n').at(-1)
      seen.push({ q, resume: x.resume, during: provided.ruyixWorkbench.tasks.current() })
      await new Promise(r => waiting.set(q, r))
      // (the third says something while it works, then takes a step: its leaf keeps only what it said after)
      if (q === 'third') {
        x.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Looking it up first.' }] } } })
        x.onEvent({ type: 'tool/call', data: { name: 'mcp__ruyix-workbench__workbench_runs', arguments: '{}' } })
        x.onEvent({ type: 'tool/call', data: { name: 'mcp__ruyix-workbench__workbench_workflow_save', arguments: JSON.stringify({ definition: { id: 'third-flow', title: 'Third flow', base: 'blank', steps: [{}] } }) } })
      }
      x.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `About ${q}.` }] } } })
      return { sessionId: `sess:${q}` }
    }
    const done = async q => { for (let i = 0; i < 200 && !waiting.has(q); i++) await sleep(5); waiting.get(q)(); waiting.delete(q) }
    const r1 = await op('chatSend', { text: 'first, a long one', lang: 'en' })
    const r2 = await op('chatSend', { text: 'second, while it answers', lang: 'en' })
    const r3 = await op('chatSend', { text: 'third', lang: 'en' })
    const r4 = await op('chatSend', { text: 'fourth', lang: 'en' })
    for (let i = 0; i < 200 && seen.length < 3; i++) await sleep(5)
    assert.deepEqual(seen.map(x => x.q), ['first, a long one', 'second, while it answers', 'third'], 'three at once')
    assert.equal(r4.queued, 1, 'the fourth waits its turn')
    assert.deepEqual([seen[1].resume, seen[2].resume], [null, null], 'beside the conversation\'s own session: sessions of their own')
    let c = await op('chat')
    assert.equal(c.running, true)
    const four = [r1, r2, r3, r4].map(r => c.asks.find(x => x.id === r.ask))
    assert.deepEqual(four.map(x => [x.question, x.state, x.open, x.seen]), [['first, a long one', 'working', 'leaf', false], ['second, while it answers', 'working', 'leaf', false], ['third', 'working', 'leaf', false], ['fourth', 'queued', 'leaf', false]])
    assert.equal(new Set(four.map(x => x.task)).size, 4, 'each its own task')
    assert.deepEqual(seen.map(x => x.during), four.slice(0, 3).map(x => x.task), 'what a turn starts belongs to its own question\'s task')
    assert.deepEqual(c.line, { kind: 'doing', text: '3 questions going', at: c.line.at }, 'the strip: how many go')
    assert.deepEqual(four[0].lines.map(l => l.kind), ['ask'])
    // a follow-up of the second while it works: after it, in its session
    const f = await op('chatSend', { text: 'and more on that', lang: 'en', re: r2.ask })
    assert.equal(f.ask, r2.ask, 'the same question (its leaf)')
    await done('second, while it answers')
    for (let i = 0; i < 200 && seen.length < 4; i++) await sleep(5)
    assert.equal(seen[3].q, 'fourth', 'a turn free: the next waiting one goes')
    await done('first, a long one')
    for (let i = 0; i < 200 && seen.length < 5; i++) await sleep(5)
    assert.deepEqual([seen[4].q, seen[4].resume], ['and more on that', 'sess:second, while it answers'], 'the follow-up after its own turn, in its session')
    assert.equal((await op('taskGet', { id: four[1].task })).task.state, 'working', 'queued follow-up is still work until its own turn ends')
    for (const q of ['third', 'fourth', 'and more on that']) await done(q)
    for (let i = 0; i < 200 && (await op('chat')).running; i++) await sleep(10)
    c = await op('chat')
    const second = c.asks.find(x => x.id === r2.ask)
    assert.deepEqual([second.state, second.followUp, second.answer.text], ['answered', 'and more on that', 'About and more on that.'], 'its leaf: the latest exchange')
    assert.deepEqual(second.lines.map(l => l.kind), ['ask', 'say', 'ask', 'say'])
    assert.equal((await op('chatAsk', { id: r2.ask })).ask.answer.text, 'About second, while it answers.\n\nAbout and more on that.', 'in front: every exchange')
    assert.equal(c.asks.find(x => x.id === r1.ask).taskState, 'done', 'a plain answer: its task done')
    const third = c.asks.find(x => x.id === r3.ask)
    assert.deepEqual([third.answer.text, third.lines.map(l => l.kind)], ['About third.', ['ask', 'say', 'tool', 'say']], 'its leaf: what it said after its last step (the stem had the rest)')
    assert.deepEqual(third.elsewhere, [{ kind: 'workflow', title: 'Third flow' }], 'the workflow it saved: named on its leaf (the conversation draws it)')
    assert.equal((await op('chatAsk', { id: r3.ask })).ask.answer.text, 'Looking it up first.\n\nAbout third.', 'in front: all it said')
    // the desk's hooks: into the drawer, seen (擦掉: off the desk, on record still), called off
    assert.equal((await op('chatAskOpen', { id: r1.ask, open: 'drawer' })).open, 'drawer')
    assert.equal((await op('chat')).asks.find(x => x.id === r1.ask).open, 'drawer')
    await op('chatAskSeen', { id: r3.ask })
    assert.ok(!(await op('chat')).asks.some(x => x.id === r3.ask), 'seen: off the desk')
    assert.ok((await op('chat', { limit: 200 })).items.some(i => i.kind === 'user' && i.text === 'third'), '(on record still)')
    await assert.rejects(op('chatAskOpen', { id: r1.ask, open: 'window' }), /leaf or drawer/)
    await assert.rejects(op('chatAskSeen', { id: 'ask:nope' }), /no such question/)
    // called off: one going stops (the others go on); one waiting is not asked
    for (const q of ['g1', 'g2', 'g3', 'g4']) await op('chatSend', { text: q, lang: 'en' })
    const g = (await op('chat')).asks.slice(-4)
    assert.deepEqual(g.map(x => x.state), ['working', 'working', 'working', 'queued'])
    assert.equal((await op('chatAskStop', { id: g[3].id })).state, 'failed')
    hub.chatTurn = async x => ({ sessionId: 'x', error: x.signal.aborted ? 'cancelled' : null })
    for (const q of ['g1', 'g2', 'g3']) await done(q)
    for (let i = 0; i < 200 && (await op('chat')).running; i++) await sleep(10)
    assert.deepEqual((await op('chat')).asks.slice(-4).map(x => [x.state, x.error || null]), [['answered', null], ['answered', null], ['answered', null], ['failed', 'stopped']])
    // the answer in front as the setting says (or as asked): it comes up once, then stays where it is
    await op('saveSettings', { settings: { ...(await op('settings')).settings, chat: { ...(await op('settings')).settings.chat, answerOpen: 'window' } } })
    hub.chatTurn = async () => ({ sessionId: 'w' })
    const w = await op('chatSend', { text: 'show me the weather', lang: 'en' })
    for (let i = 0; i < 200 && (await op('chat')).running; i++) await sleep(10)
    assert.equal((await op('chat')).asks.find(x => x.id === w.ask).front, true)
    await op('chatAskOpen', { id: w.ask, fronted: true })
    assert.deepEqual([(await op('chat')).asks.find(x => x.id === w.ask).front, (await op('chat')).asks.find(x => x.id === w.ask).open], [undefined, 'drawer'], 'it came up in a window: no leaf too — in the drawer')
    await op('saveSettings', { settings: { ...(await op('settings')).settings, chat: { ...(await op('settings')).settings.chat, answerOpen: 'leaf' } } })
    await assert.rejects(op('saveSettings', { settings: { ...(await op('settings')).settings, chat: { ...(await op('settings')).settings.chat, answerOpen: 'popup' } } }), /answerOpen is leaf, drawer or window/)
  }
  // what it did is in what a new session is told (the work record goes on with the conversation)
  assert.match((await import('./lib/assistant.js')).seedOf((await op('chat', { limit: 200 })).items), /Done with a system tool \(desk_set\): Theme: Aurora — undone since/)
  sysTools.clear(); hub.mainId = null; delete hub.chatTurn
  await op('setChatAgent', { agent: null })
}

// ── a home from before: the conversation in workbench.db's chat table is the main thread of conversations.db, numbers and all ──
{
  const { DatabaseSync } = await import('node:sqlite')
  const dir = join(tmp, 'home-legacy')
  openStore(dir).close()
  const old = new DatabaseSync(join(dir, 'workbench.db'))
  old.exec('CREATE TABLE chat (n INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, data TEXT NOT NULL)')
  const put = old.prepare('INSERT INTO chat (n, key, at, data) VALUES (?, ?, ?, ?)')
  put.run(1, 'as-9:0', 1000, JSON.stringify({ kind: 'user', text: 'an old question', sid: 'as-9' }))
  put.run(2, 'as-9:1', 1001, JSON.stringify({ kind: 'text', text: 'an old answer', sid: 'as-9' }))
  put.run(3, 'as-9:2', 1002, JSON.stringify({ kind: 'draft', seq: 3, args: { workflow: 'blank', title: 'An old card' }, outcome: { status: 'dismissed', at: 1003 }, sid: 'as-9' }))
  old.close()
  const sink = {}, own = []
  const wbl = createWorkbench(makeCtx(sink, own, {}), { toolbox: null, home: dir, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  const page = await wbl.ops.chat({})
  assert.deepEqual(page.items.map(i => [i.n, i.kind, i.text ?? i.args.title, i.at]), [[1, 'user', 'an old question', 1000], [2, 'text', 'an old answer', 1001], [3, 'draft', 'An old card', 1002]], 'what was there is there, with its numbers and times')
  assert.equal(page.items[2].outcome.status, 'dismissed', '… and what became of a card')
  assert.deepEqual((await wbl.ops.chatSearch({ q: 'old answer' })).items.map(i => i.n), [2], 'searched at once')
  wbl.conv.add('main', 'as-9:3', { kind: 'text', text: 'new' })
  assert.equal(wbl.conv.byKey('as-9:3').n, 4, 'new entries go on after the last number')
  // the kept days: once a day (and at the start), the entries past them keep their words and lose the rest
  wbl.conv.add('main', 'old-tool', { kind: 'tool', name: 'workbench_runs', target: '' }, 1)
  assert.deepEqual((await wbl.ops.chatMaintain()).swept, { tools: 1, boards: 0 })
  assert.deepEqual((await wbl.ops.chatMaintain()).swept, null, 'not again within the day')
  assert.equal(wbl.conv.byKey('old-tool'), undefined)
  assert.equal(wbl.conv.byKey('as-9:0').text, 'an old question', 'what was said stays')
  for (const d of own.splice(0)) d?.()
  // the next start finds it moved: nothing made twice
  const own2 = []
  const wbl2 = createWorkbench(makeCtx({}, own2, {}), { toolbox: null, home: dir, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  assert.deepEqual((await wbl2.ops.chat({})).items.map(i => i.n), [1, 2, 3, 4])
  for (const d of own2.splice(0)) d?.()
}

// ── background tasks: a longer read-only job on a pool agent while the talk goes on — a card, its conclusion back, a few at a time ──
{
  const { applyChat, seedOf } = await import('./lib/assistant.js')
  const turns = []
  hub.chatTurn = async x => {
    const a = bridge(x.mcp)
    const entry = { ...x, listed: (await a.tools()).map(d => d.name), calls: [], n: turns.length + 1 }
    turns.push(entry)
    x.onEvent({ type: 'tool/call', data: { name: 'mcp__ruyix-workbench__workbench_runs', arguments: '{}' } })
    await new Promise(res => { entry.release = res; x.signal.addEventListener('abort', () => res()) }) // (until the check lets it go, or it is stopped)
    entry.calls.push(await a.call('workbench_runs', {}).catch(e => `refused: ${e.message}`))
    if (x.signal.aborted) return { sessionId: null, error: 'cancelled' }
    if (entry.fail) return { sessionId: null, error: entry.fail }
    x.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `Found: ${x.prompt.replace(/^(\[[^\n]*\n)+/, '').slice(0, 23)}` }] } } })
    return { sessionId: `task-${entry.n}` }
  }
  const spawn = (title, task) => asTools.get('workbench_background_task').execute({ title, task })
  const tasks = async () => (await op('chat', { limit: 1 })).tasks
  await op('chatSend', { text: 'start some work', lang: 'zh' }) // (the language the tasks answer in; a session to speak in)
  const first = (await spawn('First look', 'First: what failed lately?')).text
  assert.match(first, /^Started in the background as task-[\w-]+ \("First look"\)\. Its conclusion comes back/)
  await spawn('Second look', 'Second: how long do runs take?')
  await spawn('Third look', 'Third: which workflows are used?')
  assert.match((await spawn('Fourth look', 'Fourth: anything odd?')).text, /\("Fourth look"\), queued: 3 tasks are running/, 'at most three at once')
  await until('three tasks at work', () => turns.length === 3)
  await sleep(40)
  assert.equal(turns.length, 3, 'the fourth waits')
  assert.deepEqual((await tasks()).map(t => [t.title, t.status]), [['Fourth look', 'queued'], ['Third look', 'running'], ['Second look', 'running'], ['First look', 'running']], 'newest first')
  // a card in the conversation for each, in order
  const cards = (await op('chat', { limit: 50 })).items.filter(i => i.kind === 'task')
  assert.deepEqual(cards.map(c => [c.title, c.status, !!c.ended]), [['First look', 'running', false], ['Second look', 'running', false], ['Third look', 'running', false], ['Fourth look', 'queued', false]])
  // the task: a pool agent (Claude Code), read only — its tools read; it is told what it is and what is kept, and the task alone
  assert.equal(turns[0].agent, 'sonnet')
  assert.deepEqual(turns[0].listed.sort(), ['workbench_chat_history', 'workbench_evidence', 'workbench_memory_search', 'workbench_metrics', 'workbench_report', 'workbench_run', 'workbench_runs', 'workbench_setup', 'workbench_tasks', 'workbench_workflows'], 'what reads — it starts, stops, writes and draws nothing, and starts no task')
  assert.match(turns[0].instructions, /^You are a background task of the Ruyix Workbench assistant[\s\S]*never change files[\s\S]*What the conversations kept:\n- \(decision\) Reports go to the blog channel first/)
  assert.match(turns[0].prompt, /^\[Workbench language: English[^\n]*\n\[Now: [^\n]*\]\nFirst: what failed lately\?$/, 'in the language the person last wrote in (English words on a Chinese panel)')
  assert.ok(!turns[0].resume, 'a turn of its own')
  await assert.rejects(bridge(turns[0].mcp).call('workbench_start_run', { workflow: 'blank' }), /no tool workbench_start_run/)
  // its steps are its own thread's, not the conversation's
  const first1 = (await tasks()).find(t => t.title === 'First look')
  assert.ok(wb.conv.all(first1.id).some(i => i.kind === 'tool' && i.name === 'workbench_runs'))
  assert.ok(!(await op('chat', { limit: 200 })).items.some(i => i.kind === 'tool' && i.agent === 'sonnet'))
  // the first one ends: its conclusion is back in the conversation as a card, the card that waited starts, the assistant hears it
  turns[0].release()
  await until('the conclusion', async () => (await op('chat', { limit: 50 })).items.some(i => i.kind === 'task' && i.ended))
  await until('the waiting one starts', () => turns.length === 4)
  const ended = (await op('chat', { limit: 50 })).items.filter(i => i.kind === 'task')
  assert.deepEqual(ended.map(c => [c.title, c.status, !!c.ended]), [['First look', 'done', false], ['Second look', 'running', false], ['Third look', 'running', false], ['Fourth look', 'running', false], ['First look', 'done', true]], 'its card says it is over; the conclusion comes last')
  assert.equal(ended.at(-1).result, 'Found: First: what failed late')
  assert.equal(turns[3].agent, 'sonnet')
  assert.deepEqual((await op('chatSearch', { q: 'what failed late' })).items.map(i => i.kind), ['task'], 'found by its conclusion')
  assert.match(seedOf([{ kind: 'topic' }, ...ended]), /Background task started: Second look\n.*Background task done: First look — Found: First: what failed late$/s)
  // the next message tells the assistant (once), outside the question as the record keeps it
  const said = prompts.length
  await op('chatSend', { text: 'how is it going?', lang: 'en' })
  const told = prompts.at(-1).content[0].text
  assert.equal(prompts.length, said + 1)
  assert.match(told, /^\[Workbench language: English[^\n]*\n\[Now: [^\n]*\]\n\[Since your last turn: Background task "First look" \(task-[\w-]+\) finished: Found: First: what failed late\]\nhow is it going\?$/)
  assert.equal(applyChat({ on: true, items: [] }, { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: told }] } }).items[0].text, 'how is it going?', 'the record keeps the question only')
  await op('chatSend', { text: 'and now?', lang: 'en' })
  assert.ok(!prompts.at(-1).content[0].text.includes('Since your last turn'), 'told once')
  // a task called off: a running one stops (its turn ends); one that waits is never started
  await spawn('Fifth look', 'Fifth: ...')
  const fifth = (await tasks()).find(t => t.title === 'Fifth look')
  assert.equal(fifth.status, 'queued', 'three running (second, third, fourth)')
  assert.equal((await op('taskStop', { id: fifth.id })).task.status, 'cancelled')
  const second = (await tasks()).find(t => t.title === 'Second look')
  await op('taskStop', { id: second.id })
  await until('the stopped task', async () => (await tasks()).find(t => t.id === second.id).status === 'cancelled')
  await assert.rejects(op('taskStop', { id: 'nope' }), e => e.code === 'noTask')
  assert.equal(turns.length, 4, 'a task that waited and was called off never ran')
  // a task that fails says why; its place goes to the next; the other two finish
  turns[2].fail = 'the agent crashed'
  turns[2].release()
  await until('the failed task', async () => (await tasks()).find(t => t.title === 'Third look').status === 'failed')
  assert.equal((await tasks()).find(t => t.title === 'Third look').result, 'the agent crashed')
  turns[3].release()
  await until('the fourth', async () => (await tasks()).find(t => t.title === 'Fourth look').status === 'done')
  const log = (await op('chat', { limit: 200 })).items.filter(i => i.kind === 'task' && i.ended).map(i => [i.title, i.status])
  assert.deepEqual(log, [['First look', 'done'], ['Fifth look', 'cancelled'], ['Second look', 'cancelled'], ['Third look', 'failed'], ['Fourth look', 'done']])
  assert.match(wb.conv.get(wb.conv.byKey(`task:${second.id}`).n).status, /cancelled/, 'the card where it started says so too')
  // a task's own tools: a refused call (it may read, not act)
  assert.ok(turns[3].calls.every(c => /Run|run|No runs|\|/.test(c)), turns[3].calls[0])
  // nothing to run it on: the assistant is told so
  const pool = ['sonnet', 'opus', 'codex'].map(id => [id, hub.agentsList.get(id)])
  for (const [id] of pool) hub.agentsList.delete(id)
  assert.match((await spawn('Nowhere', 'x')).text, /^No Claude Code or Codex agent in the pool can take a background task/)
  assert.match((await asTools.get('workbench_background_task').execute({ title: '', task: '' })).text, /needs a title and the task/)
  for (const [id, a] of pool) hub.agentsList.set(id, a)
  assert.equal(wb.conv.threads({ kind: 'task' }).length, 5, 'and nothing was made')
  // the conversation on a pool agent: a task runs on that one
  hub.agentsList.set('codex-x', { id: 'codex-x', runtime: 'codex' })
  await op('setChatAgent', { agent: 'codex-x' })
  await spawn('On codex', 'Codex: look')
  await until('its turn', () => turns.length === 5)
  assert.equal(turns[4].agent, 'codex-x')
  turns[4].release()
  await until('it ends', async () => (await tasks()).find(t => t.title === 'On codex').status === 'done')
  await op('setChatAgent', { agent: null })
  hub.agentsList.delete('codex-x')
  delete hub.chatTurn
}

// ── a task a restart cut short is over; the next start finds it so ──
{
  const { openConversations } = await import('./lib/conversations.js')
  const dir = join(tmp, 'home-restart')
  const c0 = openConversations(join(dir, 'conversations.db'))
  c0.threadMake({ id: 'main', kind: 'main', title: 'Chat' })
  c0.threadMake({ id: 'task-x', kind: 'task', parent: 'main', title: 'Left running', status: 'running', agent: 'sonnet', lane: { task: 'x' } })
  c0.threadMake({ id: 'task-y', kind: 'task', parent: 'main', title: 'Left waiting', status: 'queued', agent: 'sonnet', lane: { task: 'y' } })
  c0.add('main', 'task:task-x', { kind: 'task', task: 'task-x', title: 'Left running', status: 'running' })
  c0.close()
  const own = []
  const wbr = createWorkbench(makeCtx({}, own, {}), { toolbox: null, home: dir, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  assert.deepEqual((await wbr.ops.chat({})).tasks.map(t => [t.id, t.status]).sort(), [['task-x', 'failed'], ['task-y', 'failed']], 'the queued one began (no Agent Hub turn here: it failed, saying so), the running one was cut short')
  const items = (await wbr.ops.chat({})).items
  assert.deepEqual(items.filter(i => i.ended).map(i => [i.task, i.status]).sort(), [['task-x', 'failed'], ['task-y', 'failed']])
  assert.equal(items.find(i => i.task === 'task-x' && i.ended).result, 'Cut short: Ruyix restarted while it was running.')
  for (const d of own.splice(0)) d?.()
}

// ── the conversation's requests as tasks (docs/design/agent-tasks.md): a plain answer completes its task; one that changed
// something waits for 好了; a choice card waits for the person's answer, which is kept on the card; 再改 takes it up again ──
{
  let plan = 'text'
  const keepTurn = hub.chatTurn
  hub.chatTurn = async x => {
    if (plan === 'text') x.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'It is 18:22 in Shanghai.' }] } } })
    if (plan === 'choice') x.onEvent({ type: 'tool/call', data: { name: 'mcp__ruyix-workbench__ui_card', arguments: JSON.stringify({ cards: [{ type: 'choice', question: 'Which name?', options: [{ label: '小周' }, { label: '大周' }] }] }) } })
    if (plan === 'confirm') x.onEvent({ type: 'tool/call', data: { name: 'mcp__ruyix-workbench__ui_card', arguments: JSON.stringify({ cards: [{ type: 'confirm', text: 'Here it is.' }] }) } })
    if (plan === 'bad') x.onEvent({ type: 'tool/call', data: { name: 'ui_card', arguments: JSON.stringify({ cards: [{ type: 'nope' }] }) } })
    return { sessionId: 'cli-t' }
  }
  const quiet = async () => { for (let i = 0; i < 200 && (await op('chat')).running; i++) await sleep(10) }
  await op('chatTopic', {})
  await op('setChatAgent', { agent: 'opus' }) // (a new topic is the main agent's again: this one on a CLI agent)
  assert.equal((await op('chat')).agent, 'opus')
  await op('chatSend', { text: 'what time is it?', lang: 'en' })
  await quiet()
  let c = await op('chat')
  assert.deepEqual([c.task.title, c.task.state], ['what time is it?', 'done'], 'a plain answer: done on its own')
  const qa = c.task.id
  assert.equal((await op('taskGet', { id: qa })).task.source, 'chat')
  assert.ok((await op('taskGet', { id: qa })).timeline.some(e => e.kind === 'message' && /18:22 in Shanghai/.test(e.text)), 'its story: the conversation')
  // a choice: the card in the record, the task waiting on the person, the strip's line says what for
  plan = 'choice'
  await op('chatSend', { text: 'name the new account', lang: 'en' })
  await quiet()
  c = await op('chat')
  assert.notEqual(c.task.id, qa, 'the last one was over: a new task')
  const card = c.items.find(i => i.kind === 'cards')
  assert.deepEqual(card.cards, [{ type: 'choice', question: 'Which name?', options: [{ label: '小周' }, { label: '大周' }] }])
  assert.deepEqual([c.task.state, c.task.waitingFor.kind, c.task.waitingFor.title], ['waiting', 'choice', 'Which name?'])
  assert.deepEqual([c.line.kind, c.line.text], ['waiting', 'Which name?'])
  await assert.rejects(op('chatCardAnswer', { n: card.n, answer: { type: 'confirm', value: 'ok' } }), /this card is a choice/)
  await assert.rejects(op('chatCardAnswer', { n: card.n, index: 3, answer: { type: 'choice', values: ['x'] } }), /no such card/)
  const picked = await op('chatCardAnswer', { n: card.n, index: 0, answer: { type: 'choice', values: ['小周'] } })
  assert.deepEqual([picked.item.answered[0].values, picked.handled], [['小周'], false], 'kept on the card (a reload does not offer it again); the page sends the reply')
  assert.equal((await op('chat')).task.state, 'working', 'its reply follows: the task goes on')
  assert.equal((await op('chat')).line.kind !== 'waiting', true, 'no longer waiting on the person')
  plan = 'text'
  await op('chatSend', { text: '小周', lang: 'en', re: picked.re }) // (the page sends the pick on its question)
  await quiet()
  assert.equal((await op('chat')).task.id, c.task.id, 'the reply is in the same task')
  assert.equal((await op('chat')).task.state, 'done', 'answered, nothing made: done')
  // a confirm: 好了 is the person's word on the task, no message; 再改 takes it up again
  plan = 'confirm'
  await op('chatSend', { text: 'write the haiku', lang: 'en' })
  await quiet()
  let cc = await op('chat'); const conf = cc.items.findLast(i => i.kind === 'cards')
  assert.deepEqual([cc.task.state, cc.task.waitingFor.kind, cc.task.waitingFor.title], ['waiting', 'confirm', 'Here it is.'])
  const said = (await op('chat')).items.length
  const ok = await op('chatCardAnswer', { n: conf.n, answer: { type: 'confirm', value: 'ok' } })
  assert.equal(ok.handled, true)
  assert.equal((await op('taskGet', { id: cc.task.id })).task.state, 'done')
  assert.ok((await op('taskGet', { id: cc.task.id, lang: 'zh' })).timeline.some(e => e.who.kind === 'person' && e.text === '好了'), 'the person\'s answer in its story')
  assert.equal((await op('chat')).items.length, said, 'no message for it')
  const originalCard = wb.conv.get(conf.n), originalTask = wb.store.get('task', cc.task.id)
  wb.conv.set(conf.n, { ...originalCard, cards: [{ ...originalCard.cards[0], task: cc.task.id, run: 'earlier-version' }], answered: undefined })
  try {
    await assert.rejects(op('chatCardAnswer', { n: conf.n, answer: { type: 'confirm', value: 'ok' } }), { code: 'changedMeanwhile' })
    assert.equal(wb.conv.get(conf.n).answered, undefined, 'a stale card is not consumed')
    wb.conv.set(conf.n, { ...originalCard, cards: [{ ...originalCard.cards[0], resultVersion: 'older-result' }], answered: undefined })
    await assert.rejects(op('chatCardAnswer', { n: conf.n, answer: { type: 'confirm', value: 'ok' } }), { code: 'changedMeanwhile' })
    assert.equal(wb.conv.get(conf.n).answered, undefined, 'a different result of the same run is not accepted')
    wb.conv.set(conf.n, { ...originalCard, cards: [originalCard.cards[0], { type: 'choice', question: 'Which account?', options: [{ label: 'A' }, { label: 'B' }] }], answered: undefined })
    const deferredAcceptance = await op('chatCardAnswer', { n: conf.n, answer: { type: 'confirm', value: 'ok' } })
    assert.equal(deferredAcceptance.handled, false, 'an acceptance blocked by another card is forwarded as a message, not silently dropped')
    assert.equal(deferredAcceptance.item.answered[0].value, 'ok')
  } finally { wb.conv.set(conf.n, originalCard); wb.store.put('task', originalTask) }

  plan = 'confirm'
  await op('chatSend', { text: 'another one', lang: 'en' })
  await quiet()
  cc = await op('chat'); const conf2 = cc.items.findLast(i => i.kind === 'cards')
  await assert.rejects(op('chatCardAnswer', { n: conf2.n, answer: { type: 'confirm', value: 'revise', text: ' ' } }), /say what to change/)
  plan = 'text'
  assert.equal((await op('chatCardAnswer', { n: conf2.n, answer: { type: 'confirm', value: 'revise', text: 'about the sea' } })).handled, true)
  await quiet()
  assert.ok((await op('chat')).items.some(i => i.kind === 'user' && i.text === '再改：about the sea'), '再改: back in the conversation')
  assert.equal((await op('chat')).task.id, cc.task.id, 'in the same task')
  // a card that does not check is not drawn
  plan = 'bad'
  await op('chatSend', { text: 'a broken card', lang: 'en' })
  await quiet()
  const after = (await op('chat')).items, from = after.findLastIndex(i => i.kind === 'user' && i.text === 'a broken card')
  assert.ok(from >= 0 && !after.slice(from).some(i => i.kind === 'cards'), 'nothing drawn')
  // what the main agent starts in a turn belongs to its task (the service's current(), while the turn runs): a session's
  // files as the task's outputs make it wait for 好了, not done
  let during = null
  plan = 'text'
  hub.chatTurn = async () => { during = provided.ruyixWorkbench.tasks.current(); return { sessionId: 'cli-t' } }
  await op('chatTopic', {})
  await op('setChatAgent', { agent: 'opus' })
  assert.equal(provided.ruyixWorkbench.tasks.current(), null, 'between turns: none')
  await op('chatSend', { text: 'open a session and write hello.md', lang: 'en' })
  await quiet()
  const own = (await op('chat')).task
  assert.equal(during, own.id, 'during its turn: the conversation\'s task')
  assert.equal(own.state, 'done', '(nothing made yet)')
  provided.ruyixWorkbench.tasks.link(own.id, { kind: 'session', id: 's-hello' })
  provided.ruyixWorkbench.tasks.addOutput(own.id, { kind: 'file', title: 'hello.md', ref: { session: 's-hello', path: 'hello.md' } })
  provided.ruyixWorkbench.tasks.update(own.id, { state: 'to-confirm' })
  hub.chatTurn = async () => ({ sessionId: 'cli-t' })
  await op('chatSend', { text: 'and?', lang: 'en' })
  await quiet()
  assert.deepEqual([(await op('chat')).task.id, (await op('chat')).task.state], [own.id, 'to-confirm'], 'its session made a file: still waiting for 好了 after the next turn')
  await op('chatTopic', {})
  await op('setChatAgent', { agent: 'opus' })
  // something changed (an action on record, its undo kept): to-confirm; 再改 goes on in the same task
  hub.chatTurn = async () => { wb.conv.add('main', `act:test:${Date.now()}`, { kind: 'action', tool: 'desk_set', summary: 'Theme: ink', undo: { tool: 'desk_set', args: {} } }); return { sessionId: 'cli-t' } }
  await op('chatSend', { text: 'make the desk ink', lang: 'en' })
  await quiet()
  const made = (await op('chat')).task
  assert.equal(made.state, 'to-confirm', 'it changed something (an action on record): waits for 好了')
  hub.chatTurn = async () => ({ sessionId: 'cli-t' })
  await op('taskRevise', { id: made.id, text: 'darker' })
  await quiet()
  assert.ok((await op('chat')).items.some(i => i.kind === 'user' && i.text === '再改：darker'), '再改 in the conversation, in its task')
  assert.equal((await op('chat')).task.id, made.id)
  assert.equal((await op('taskConfirm', { id: made.id })).task.state, 'done')
  hub.chatTurn = keepTurn
}

// ── what only shows makes nothing (opening a page, a window, an app: its task is done, not waiting for 好了); a sentence
// of its own after a choice it waits on is a question of its own, an option or a word or two answers it ──
{
  await op('chatTopic', {})
  await op('setChatAgent', { agent: 'opus' })
  const quiet = async () => { for (let i = 0; i < 200 && (await op('chat')).running; i++) await sleep(10) }
  let turn = null
  hub.chatTurn = async x => { await turn?.(x); return { sessionId: 'cli-s' } }
  // (it says `shows`, as the shell's own does)
  sysTools.set('open_page', { name: 'open_page', title: { zh: '打开页面', en: 'Open a page' }, description: 'Open a page.', parameters: { type: 'object' }, effect: 'direct', shows: true, run: async () => ({ text: 'Opened.', summary: { zh: '打开了任务中心', en: 'Opened Tasks' } }) })
  turn = async x => { await bridge(x.mcp).call('open_page', {}) }
  const shown = await op('chatSend', { text: 'open the task center', lang: 'en' })
  await quiet()
  // (the action as the system tools record it, on its question)
  const act = (await op('chat')).items.findLast(i => i.kind === 'action')
  assert.deepEqual([act.tool, act.shows, `ask:${act.ask}`], ['open_page', true, shown.ask])
  assert.equal((await op('chat')).asks.find(x => x.id === shown.ask).taskState, 'done', 'it only showed something: done')
  assert.equal((await op('chat')).asks.find(x => x.id === shown.ask).opened, 'open_page', 'it opened something: the desk grows no leaf over it')
  // its task deleted (or archived): off the desk
  await op('taskDelete', { id: (await op('chat')).asks.find(x => x.id === shown.ask).task })
  assert.ok(!(await op('chat')).asks.some(x => x.id === shown.ask), 'its task gone: off the desk')
  sysTools.delete('open_page')
  // a choice it waits on, then a sentence of its own: a question of its own
  turn = x => x.onEvent({ type: 'tool/call', data: { name: 'ui_card', arguments: JSON.stringify({ cards: [{ type: 'choice', question: 'Which app?', options: [{ label: 'Pomodoro' }, { label: 'Timer' }] }] }) } })
  const made = await op('chatSend', { text: 'make me a pomodoro app', lang: 'en' })
  await quiet()
  assert.equal((await op('chat')).asks.find(x => x.id === made.ask).taskState, 'waiting')
  // (a sentence in Chinese, no spaces in it: a question of its own — the box's case)
  const zhOther = await op('chatSend', { text: '我想把一段视频剪短一点，用哪个？（测试）', lang: 'zh' })
  assert.notEqual(zhOther.ask, made.ask, 'a Chinese sentence of its own: a new question')
  await quiet()
  turn = x => x.onEvent({ type: 'tool/call', data: { name: 'ui_card', arguments: JSON.stringify({ cards: [{ type: 'choice', question: 'Which app?', options: [{ label: 'Pomodoro' }, { label: 'Timer' }] }] }) } })
  const made2 = await op('chatSend', { text: 'make me another app', lang: 'en' })
  await quiet()
  turn = null
  assert.equal((await op('chatSend', { text: '第二个', lang: 'zh' })).ask, made2.ask, 'a word or two of Chinese: answers it')
  await quiet()
  turn = x => x.onEvent({ type: 'tool/call', data: { name: 'ui_card', arguments: JSON.stringify({ cards: [{ type: 'choice', question: 'Which app?', options: [{ label: 'Pomodoro' }, { label: 'Timer' }] }] }) } })
  const made3 = await op('chatSend', { text: 'one more app', lang: 'en' })
  await quiet()
  turn = null
  const other = await op('chatSend', { text: 'I want to cut a video shorter, which tool do I use?', lang: 'en' })
  assert.notEqual(other.ask, made3.ask, 'a sentence of its own: a new question')
  await quiet()
  const pick = await op('chatSend', { text: 'Pomodoro, please', lang: 'en' })
  assert.notEqual(pick.ask, made.ask, '(the latest question is the video one: not waiting on a choice)')
  await quiet()
  // straight after the choice: one of its options, or a word or two, answers it
  turn = x => x.onEvent({ type: 'tool/call', data: { name: 'ui_card', arguments: JSON.stringify({ cards: [{ type: 'choice', question: 'Which colour?', options: [{ label: 'Tomato red' }, { label: 'Leaf green' }] }] }) } })
  const colour = await op('chatSend', { text: 'pick a colour for it', lang: 'en' })
  await quiet()
  turn = null
  assert.equal((await op('chatSend', { text: 'I would like Tomato red for it', lang: 'en' })).ask, colour.ask, 'an option of it: answers it')
  await quiet()
  hub.chatTurn = async x => { x.onEvent({ type: 'tool/call', data: { name: 'ui_card', arguments: JSON.stringify({ cards: [{ type: 'choice', question: 'Which size?', options: [{ label: 'Small' }, { label: 'Large' }] }] }) } }); return { sessionId: 'cli-s' } }
  const size = await op('chatSend', { text: 'and what size should it be?', lang: 'en' })
  await quiet()
  hub.chatTurn = async () => ({ sessionId: 'cli-s' })
  assert.equal((await op('chatSend', { text: 'the big one', lang: 'en' })).ask, size.ask, 'a word or two: answers it')
  await quiet()
  await op('chatTopic', {})
}

// ── work that goes on past its turn (docs/design/work-in-one-place.md): its source says what it does — the turn leaves
// its task working, a live card of it on the question; when it ends, a line on the question in the person's language (the
// strip says it, the next turn hears it), a 好了 card when it made something; a pick on a choice card goes out with what
// it answers ──
{
  const svc = provided.ruyixWorkbench.tasks
  const quiet = async () => { for (let i = 0; i < 200 && (await op('chat')).running; i++) await sleep(10) }
  const after = () => new Promise(r => setImmediate(r))
  await op('chatTopic', {})
  await op('setChatAgent', { agent: 'opus' })
  const prompts = []
  let plan = 'choice', held = null
  hub.chatTurn = async x => {
    prompts.push(x.prompt)
    if (plan === 'choice') x.onEvent({ type: 'tool/call', data: { name: 'ui_card', arguments: JSON.stringify({ cards: [{ type: 'choice', question: '要我现在把 FFmpeg 装上吗？', options: [{ label: '装 FFmpeg' }, { label: '先不装' }] }] }) } })
    // (as App Center's install does: the task now, what it does — and later, how it ended)
    if (plan === 'install') { held = svc.current(); svc.update(held, { state: 'working', step: { zh: '正在安装 FFmpeg', en: 'Installing FFmpeg' } }); x.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在装了，要几分钟。' }] } } }) }
    if (plan === 'text') x.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的。' }] } } })
    return { sessionId: 'cli-i', tokens: 1200, cost: 0.02 }
  }
  const asked = await op('chatSend', { text: '我想把一段视频剪短一点（测试）', lang: 'zh' })
  await quiet()
  const card = (await op('chat')).items.findLast(i => i.kind === 'cards')
  const picked = await op('chatCardAnswer', { n: card.n, answer: { type: 'choice', values: ['装 FFmpeg'] } })
  plan = 'install'
  await op('chatSend', { text: '装 FFmpeg', lang: 'zh', re: picked.re })
  await quiet()
  assert.match(prompts.at(-1), /\[Their pick on your choice card "要我现在把 FFmpeg 装上吗？"\]\n装 FFmpeg$/, 'the pick goes out with what it answers')
  let c = await op('chat')
  assert.equal(c.items.findLast(i => i.kind === 'user').lang, 'zh', 'the message keeps its language')
  assert.equal(svc.get(held).state, 'working', 'its source said it goes on: the turn left it working')
  assert.deepEqual([svc.get(held).usage.tokens, svc.get(held).usage.cost], [2400, 0.04], 'what its turns used (the choice\'s and the install\'s), on its task')
  const live = c.items.findLast(i => i.kind === 'cards')
  assert.deepEqual([live.cards, `ask:${live.ask}`], [[{ type: 'task', id: held, title: svc.get(held).title, state: 'working', step: '正在安装 FFmpeg' }], asked.ask])
  assert.equal((await op('taskGet', { id: held, lang: 'en' })).task.step, 'Installing FFmpeg', 'in the page\'s language')
  // it ends later: a line on its question
  svc.update(held, { state: 'done', result: { zh: 'FFmpeg 装好了。', en: 'FFmpeg is installed.' } })
  await after()
  c = await op('chat')
  const end = c.items.findLast(i => i.kind === 'text')
  assert.deepEqual([end.text, `ask:${end.ask}`, end.moved], ['FFmpeg 装好了。', asked.ask, { task: held, state: 'done' }])
  assert.deepEqual([c.line.kind, c.line.text], ['said', 'FFmpeg 装好了。'], 'the strip says it')
  const q = c.asks.find(x => x.id === asked.ask)
  assert.ok(q && !q.seen && /FFmpeg 装好了。/.test(q.answer.text), 'its question is on the desk again, the line in its answer')
  const got = await op('taskGet', { id: held, lang: 'zh' })
  assert.deepEqual([got.task.state, got.task.result, got.task.step], ['done', 'FFmpeg 装好了。', undefined])
  assert.ok(got.timeline.some(e => e.text === 'FFmpeg 装好了。'), 'and in its story')
  // said once
  const n = (await op('chat')).items.length
  svc.update(held, { state: 'done', result: 'FFmpeg 装好了。' }); await after()
  assert.equal((await op('chat')).items.length, n, 'the same again: nothing more')
  plan = 'text'
  await op('chatSend', { text: '现在几点？（测试）', lang: 'zh' })
  await quiet()
  assert.match(prompts.at(-1), /\[Since your last turn: [^\]\n]*FFmpeg 装好了。/, 'the main agent hears it with the next message')
  // what the next turn hears: not the news of a task archived (or deleted) since
  plan = 'install'
  await op('chatSend', { text: '（测试）装一下 fd', lang: 'zh' })
  await quiet()
  const fdTask = held
  svc.update(fdTask, { state: 'done', result: 'fd 装好了。' }); await after()
  svc.archive(fdTask)
  plan = 'text'
  await op('chatSend', { text: '（测试）几点了', lang: 'zh' })
  await quiet()
  assert.ok(!/fd 装好了/.test(prompts.at(-1)), 'an archived task\'s news is not told')
  // made something after its turn: a 好了 card with the line; the person's 好了 says nothing more
  plan = 'install'
  await op('chatSend', { text: '帮我写一份周报（测试）', lang: 'zh' })
  await quiet()
  const made = held
  svc.update(made, { state: 'to-confirm', result: '周报写好了。' }); await after()
  c = await op('chat')
  const ok = c.items.findLast(i => i.kind === 'cards')
  assert.deepEqual(ok.cards, [{ type: 'confirm', task: made, title: svc.get(made).title, text: '周报写好了。', run: '', resultVersion: String(svc.get(made).resultVersion || 0) }])
  await op('chatCardAnswer', { n: ok.n, answer: { type: 'confirm', value: 'ok' } }); await after()
  assert.equal(svc.get(made).state, 'done')
  assert.equal((await op('chat')).items.length, c.items.length, 'its 好了 is the person\'s: nothing said')
  // over before its turn was (an install of seconds): its line right after the answer, as a slow one's comes later
  plan = 'fast'
  const keepTurn = hub.chatTurn
  hub.chatTurn = async x => {
    prompts.push(x.prompt)
    const id = svc.current()
    svc.update(id, { state: 'working', step: '正在安装 ripgrep' })
    x.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '开始装了，装好会告诉你。' }] } } })
    svc.update(id, { state: 'done', result: { zh: 'ripgrep 装好了。', en: 'ripgrep is installed.' } })
    return { sessionId: 'cli-i' }
  }
  const fast = await op('chatSend', { text: '装一下 ripgrep（测试）', lang: 'zh' })
  await quiet(); await after()
  c = await op('chat')
  const said = c.items.filter(i => `ask:${i.ask}` === fast.ask && i.kind === 'text').map(i => i.text)
  assert.deepEqual(said, ['开始装了，装好会告诉你。', 'ripgrep 装好了。'], 'the line after the answer, once')
  assert.deepEqual([c.line.text, c.items.filter(i => `ask:${i.ask}` === fast.ask && i.kind === 'cards').length], ['ripgrep 装好了。', 0], 'the strip says it; no live card for what is over')
  // settled 待确认 as its turn ended (it made something), its source's word on how it ended later: told too — in the
  // question's language (a model's English reply on a Chinese question: our own line)
  hub.chatTurn = async x => {
    prompts.push(x.prompt)
    svc.addOutput(svc.current(), { kind: 'file', title: 'hello.md' })
    x.onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '会话开了，写好后告诉你。' }] } } })
    return { sessionId: 'cli-i' }
  }
  const late = await op('chatSend', { text: '开一个会话写 hello.md（测试）', lang: 'zh' })
  await quiet()
  const lateTask = (await op('chat')).asks.find(x => x.id === late.ask).task
  assert.equal(svc.get(lateTask).state, 'to-confirm')
  const keepInfo = hub.sessionInfo
  hub.sessionInfo = id => (id === 's-hello2' ? { id, title: '写 hello.md' } : keepInfo?.(id))
  svc.link(lateTask, { kind: 'session', id: 's-hello2' })
  svc.update(lateTask, { state: 'to-confirm', result: 'Created `hello.md`. It says hello.' }); await after()
  c = await op('chat')
  const lateLine = c.items.findLast(i => `ask:${i.ask}` === late.ask && i.kind === 'text')
  assert.deepEqual([lateLine.moved, lateLine.text], [{ task: lateTask, state: 'to-confirm' }, '「写 hello.md」做好了，你看看：好了，或者说要改什么。'], 'its state the same, its word new: told, in Chinese, by the name of the piece')
  assert.deepEqual(['type', 'title'].map(k => c.items.findLast(i => `ask:${i.ask}` === late.ask && i.kind === 'cards')?.cards[0][k]), ['confirm', '写 hello.md'])
  const nLate = c.items.length
  svc.update(lateTask, { state: 'to-confirm', result: 'Created `hello.md`. It says hello.' }); await after()
  assert.equal((await op('chat')).items.length, nLate, 'the same word again: nothing more')
  hub.sessionInfo = keepInfo
  // its task deleted: its entries are gone from what a fresh session is told, its cards drawn as gone
  await op('taskArchive', { id: lateTask }); await op('taskDelete', { id: lateTask })
  const afterGone = await op('chat'), goneItems = afterGone.items.filter(i => `ask:${i.ask}` === late.ask)
  assert.ok(goneItems.length && goneItems.every(i => i.gone), 'its entries: gone')
  // and the main agent's strip no longer waits on it: the newest live line, no card of it
  assert.ok(!/hello\.md/.test(afterGone.line?.text || '') && afterGone.line?.kind !== 'waiting', `the strip lets it go: ${JSON.stringify(afterGone.line)}`)
  assert.ok(!(afterGone.cards || []).some(x => x.ask === late.ask), 'no card of it on the strip')
  hub.chatTurn = keepTurn
  plan = 'text'
  // and the main agent's own session, which remembers it, hears that it is gone
  await after()
  await op('chatSend', { text: '（测试）还有别的吗', lang: 'zh' })
  await quiet()
  assert.match(prompts.at(-1), /deleted the task of "开一个会话写 hello\.md（测试）": let it go/)
  // a Chinese question on an English panel is answered in Chinese; a word that does not say goes on in it
  await op('chatSend', { text: '（测试）今天是星期几？', lang: 'en' })
  await quiet()
  assert.match(prompts.at(-1), /^\[Workbench language: Chinese/, 'the language they wrote in, not the panel\'s')
  await op('chatSend', { text: 'ok', lang: 'en' })
  await quiet()
  assert.match(prompts.at(-1), /^\[Workbench language: Chinese/, '"ok": the language before')
  // a new message on it: its source's old lines go, the turn decides again
  plan = 'text'
  await op('chatSend', { text: '再改一下（测试）', lang: 'zh', re: `ask:${ok.ask}` })
  await quiet()
  assert.deepEqual([svc.get(made).state, svc.get(made).result], ['done', undefined])
  await op('chatTopic', {})
}

// ── the workbench's system tools (docs/design/agent-control.md): open_file opens a file or a folder in the person's
// viewer window (a run's, a session's, one of the home folder — inside it, nothing hidden); workflow_enable asks the
// person to enable a draft workflow with a card only they click ──
{
  const open = ownTools.get('open_file').at(-1), enable = ownTools.get('workflow_enable').at(-1)
  assert.deepEqual([open.effect, enable.effect], ['direct', 'read'])
  const rid = wb.store.list('run').find(r => r.status === 'done').id
  let r = await open.run({ run: rid, file: 'report.md' })
  assert.deepEqual(pageActs.at(-1), ['ruyix-workbench:view', { run: rid, file: 'report.md' }])
  assert.deepEqual(r.summary, { zh: '打开了 report.md', en: 'Opened report.md' })
  await open.run({ session: 's7', file: 'a/b.md' })
  assert.deepEqual(pageActs.at(-1), ['ruyix-workbench:view', { session: 's7', file: 'a/b.md' }])
  await assert.rejects(open.run({ run: 'rnope' }), /no run rnope/)
  await assert.rejects(open.run({}), /give path, run \+ file, or session \+ file/)
  // the home folder: a file, a folder's files (not the hidden ones); a hidden one or one outside does not open
  const { homeEntry } = await import('./lib/file.js')
  const h = join(tmp, 'person-home'); mkdirSync(join(h, 'notes'), { recursive: true }); mkdirSync(join(h, '.ssh'), { recursive: true })
  writeFileSync(join(h, 'notes', 'plan.md'), '# Plan'); writeFileSync(join(h, 'notes', 'b.png'), 'x'); writeFileSync(join(h, 'notes', '.secret'), 'x'); writeFileSync(join(h, '.ssh', 'id'), 'key')
  assert.deepEqual(homeEntry('~/notes/plan.md', h), { full: realpathSync(join(h, 'notes', 'plan.md')), rel: join('notes', 'plan.md'), dir: false })
  assert.equal(homeEntry('notes', h).dir, true)
  assert.throws(() => homeEntry('~/.ssh/id', h), /hidden/)
  assert.throws(() => homeEntry('/etc/passwd', h), /only what is in the home folder/)
  assert.throws(() => homeEntry('~/nope.md', h), /no such file/)
  const { homedir } = await import('node:os')
  const real = join(homedir(), `ruyix-check-${process.pid}`)
  mkdirSync(real, { recursive: true }); writeFileSync(join(real, 'x.md'), '# Hello'); writeFileSync(join(real, '.y'), 'no')
  try {
    mkdirSync(join(real, 'sub', 'deeper'), { recursive: true }); writeFileSync(join(real, 'sub', 'deeper', 'z.txt'), 'z'); mkdirSync(join(real, 'only-folders', 'empty'), { recursive: true })
    await open.run({ path: `~/ruyix-check-${process.pid}` })
    assert.deepEqual(pageActs.at(-1)[1].files.map(x => x.name), ['x.md', join('sub', 'deeper', 'z.txt')], 'a folder: its files, then its folders\' (nothing hidden)')
    assert.equal(pageActs.at(-1)[1].files[0].url, `api/ruyix-workbench/hfile?path=${encodeURIComponent(join(`ruyix-check-${process.pid}`, 'x.md'))}`)
    const acts = pageActs.length
    assert.match((await open.run({ path: `~/ruyix-check-${process.pid}/only-folders` })).text, /no files to show, only folders with nothing in them to show: empty/)
    assert.equal(pageActs.length, acts, '(nothing opened for it)')
    const got = await routes['/api/ruyix-workbench/hfile'].fetch(new Request(`http://x/${pageActs.at(-1)[1].files[0].url}`))
    assert.equal(await got.text(), '# Hello')
    assert.equal((await routes['/api/ruyix-workbench/hfile'].fetch(new Request(`http://x/api/ruyix-workbench/hfile?path=${encodeURIComponent(join(`ruyix-check-${process.pid}`, '.y'))}`))).status, 403)
    assert.equal((await routes['/api/ruyix-workbench/hfile'].fetch(new Request('http://x/api/ruyix-workbench/hfile?path=%2Fetc%2Fpasswd'))).status, 403)
  } finally { rmSync(real, { recursive: true, force: true }) }
  // workflow_enable: a card in the conversation; the task waits for the person; their click enables it
  assert.deepEqual((await op('workflowSave', { definition: { id: 'to-enable', title: 'To enable', base: 'blank', steps: [{ use: 'intake' }, { use: 'report' }] } })).workflow.status, 'draft')
  await assert.rejects(enable.run({ id: 'nope' }), /no workflow nope/)
  r = await enable.run({ id: 'to-enable' })
  assert.match(r.text, /asks the person to enable To enable[\s\S]*not yet/)
  const card = (await op('chat')).items.findLast(i => i.kind === 'workflow')
  assert.deepEqual(card.args, { id: 'to-enable', title: 'To enable', steps: 2, enable: true })
  const on = await op('chatWorkflowEnable', { n: card.n })
  assert.deepEqual([on.item.outcome, on.workflow.status], ['enabled', 'enabled'])
  assert.equal((await enable.run({ id: 'to-enable' })).text, 'To enable is enabled already.')
  // the system's one search: what the workbench has — workflows (a draft says to enable it first), runs, works
  const wfHits = await ownFinders.get('workflow').at(-1).find('')
  assert.ok(wfHits.some(h => h.id === 'workflow:blank' && /workbench_start_run \{ workflow: "blank"/.test(h.how)))
  assert.ok(wfHits.some(h => h.id === 'workflow:to-enable' && h.hint === '我的工作流'), 'enabled now')
  await op('workflowSave', { definition: { id: 'a-draft', title: 'A draft', base: 'blank', steps: [{ use: 'intake' }, { use: 'report' }] } })
  assert.match((await ownFinders.get('workflow').at(-1).find('')).find(h => h.id === 'workflow:a-draft').how, /^workflow_enable \{ id: "a-draft" \} first/)
  const runHits = await ownFinders.get('run').at(-1).find('')
  assert.ok(runHits.length && runHits.every(h => /^workbench_run \{ id: "r/.test(h.how) && h.hint && h.at))
  const works = await ownFinders.get('output').at(-1).find('')
  assert.ok(works.length && works.every(h => /^(open_file|workbench_report|task_look|its link)/.test(h.how)))
  assert.ok(works.some(h => /^open_file \{ run: "r\w+", file: "/.test(h.how)), 'a result file: open_file on it')
}

// ── packs come and go ──
{
  // a second pack: a tool name that is taken is refused, with nothing half-registered
  assert.throws(() => provided.ruyixWorkbench.registerPack({ id: 'other', name: 'Other', tools: [{ name: 'notes_count', description: 'd', parameters: { type: 'object' }, run: () => '' }] }), /already taken by Notes/)
  assert.throws(() => provided.ruyixWorkbench.registerPack({ id: 'other', name: 'Other', tools: [{ name: 'wb_context', description: 'd', parameters: { type: 'object' }, run: () => '' }] }), /already taken by the core/)
  assert.throws(() => definePack({ id: 'Bad Id', name: 'x' }), /id is 2–31/)
  const once = definePack({ id: 'twice', name: 'x' })
  assert.equal(definePack(once).id, 'twice', 'a checked pack can go through definePack again (registerPack does it)')
  assert.throws(() => definePack({ id: 'broken', name: 'x', workflows: { w: { title: 'W', stages: [{ key: 'a', owner: 'ghost', run() {} }] } } }), /role "ghost" is not in roles/)
  assert.throws(() => definePack({ id: 'broken', name: 'x', workflows: { w: { title: 'W', stages: [{ key: 'a.b', owner: 'system', run() {} }] } } }), /step key/)
  assert.deepEqual((await op('packs')).packs.map(p => p.id), ['notes'])
  // another pack alongside: its own workflows, its tools, its settings, its ops
  const other = provided.ruyixWorkbench.registerPack({
    id: 'other', name: { en: 'Other', zh: '其他' }, settings: { n: 1 },
    tools: [{ name: 'other_tool', description: 'x', parameters: { type: 'object' }, run: c => `other ${c.pack.id} ${c.packSettings.n}` }],
    workflows: { one: { title: 'One', stages: [intake, { key: 'think', owner: 'thinker', run: async w => { const { result } = await w.agent('thinker', 'think', {}); return { ok: result.ok, note: result.summary } } }, report], roles: { thinker: { agent: 'scribe', text: 'Thinks.' } } } },
    ops: () => ({ hello: () => ({ hi: true }) }),
  })
  assert.deepEqual((await op('packs')).packs.map(p => p.id).sort(), ['notes', 'other'])
  assert.deepEqual((await op('other.hello')), { hi: true })
  members.scribe = async ({ mcp }) => {
    const a = bridge(mcp)
    assert.deepEqual((await a.tools()).map(t => t.name).sort(), ['claim_add', 'decision_needed', 'discuss_with_person', 'evidence_get', 'file_save', 'help_needed', 'other_tool', 'stage_result', 'wb_context'], 'a step sees its own pack\'s tools, not another\'s')
    assert.equal(await a.call('other_tool', {}), 'other other 1')
    await assert.rejects(a.call('notes_count', { seq: 1 }), /not a tool of the step/)
    return a.call('stage_result', { result: { ok: true, summary: 'thought' } })
  }
  const r = await finished((await op('startRun', { workflow: 'other.one', title: 'think' })).run.id)
  assert.equal(r.status, 'done')
  assert.equal(r.verdict.level, 'done')
  // a run from a studio's record, written as one of its accounts (docs/design/studio.md): the link is kept on the run;
  // the account is read when the run starts, kept with it, and laid over the pack's settings for that run only; the
  // studio hears when the run ends; a record's runs are a query
  assert.throws(() => definePack({ id: 'bad-acct', name: 'x', account: { studio: 's' } }), /account is \{ studio, collection, field, settings/)
  const acct = provided.ruyixWorkbench.registerPack({
    id: 'acct', name: 'Acct', settings: { voice: 'plain', keep: 1 },
    account: { studio: 'ws', collection: 'accounts', field: 'account', settings: (a, s) => ({ ...s, voice: a.voice }) },
    workflows: { w: { title: 'W', input: [{ name: 'account', type: 'ref', ref: { studio: 'ws', collection: 'accounts' } }], stages: [intake, { key: 'say', owner: 'system', run: async w => ({ ok: true, note: `voice ${w.packSettings.voice} keep ${w.packSettings.keep}` }) }, report] } },
  })
  fakeStudio.records['ws/accounts/a1'] = { name: 'Lively', voice: 'lively' }
  assert.deepEqual(await op('refOptions', { studio: 'ws', collection: 'accounts' }), { options: [{ value: 'a1', label: 'Lively' }] }, 'the form offers the studio\'s records')
  const ra = await finished((await op('startRun', { workflow: 'acct.w', title: 'as Lively', fields: { account: 'a1' }, studio: { id: 'ws', collection: 'ideas', record: 'i1' } })).run.id)
  assert.equal(ra.status, 'done')
  assert.equal(ra.stages.find(s => s.key === 'say').note, 'voice lively keep 1', 'the account over the pack\'s settings, for this run')
  assert.deepEqual(ra.account, { id: 'a1', name: 'Lively', voice: 'lively' }, 'kept with the run')
  assert.deepEqual(ra.studio, { id: 'ws', collection: 'ideas', record: 'i1' })
  assert.equal((await op('settings')).settings.packs?.acct?.voice ?? 'plain', 'plain', 'the person\'s settings stay as they were')
  await until('the studio hears', () => fakeStudio.ended.includes(ra.id))
  fakeStudio.records['ws/accounts/a1'].voice = 'changed later'
  assert.equal(engine.get(ra.id).config.packs.acct.voice, 'lively', 'changing the account later leaves the run as it was')
  const rb = await finished((await op('startRun', { workflow: 'acct.w', title: 'no account', studio: { id: 'ws', collection: 'ideas', record: '../x' } })).run.id)
  assert.equal(rb.stages.find(s => s.key === 'say').note, 'voice plain keep 1', 'no account: the pack\'s settings')
  assert.equal(rb.studio, undefined, 'a malformed link is not kept')
  await assert.rejects(op('startRun', { workflow: 'acct.w', title: 'x', fields: { account: 'nope' } }), /no account "nope" in the ws studio/)
  const of = await op('runsOf', { studio: 'ws', record: 'i1' })
  assert.deepEqual(of.runs.map(x => [x.id, x.status, x.account?.name]), [[ra.id, 'done', 'Lively']], 'a record\'s runs: the ones that name it')
  assert.ok(of.runs[0].outcome && typeof of.runs[0].outcome.text === 'string')
  assert.equal(provided.ruyixWorkbench.runsOf({ studio: 'ws' }).runs.length, 1, 'the service has it too')
  await assert.rejects(op('runsOf', {}), /say which studio/)
  acct()
  // a second pack with the same id replaces the first: its workflows are the new ones
  const again = provided.ruyixWorkbench.registerPack({ id: 'other', name: 'Other again', workflows: { two: { title: 'Two', stages: [intake, report] } } })
  assert.deepEqual((await op('workflows')).builtIn.map(w => w.id).filter(id => id.startsWith('other')), ['other.two'])
  assert.equal(hub.agentsList.has('other-agent'), false)
  await assert.rejects(op('startRun', { workflow: 'other.one', title: 'x' }), /unknown workflow/)
  assert.equal((await finished((await op('startRun', { workflow: 'other.two', title: 'x' })).run.id)).status, 'done')
  other() // the old one's off() does nothing: the new one is the pack now
  assert.equal((await op('packs')).packs.length, 2)
  // off: no new runs on its workflows, the runs it has stay and can be read — and be resumed
  const gone = engine.get(r.id)
  again()
  assert.deepEqual((await op('packs')).packs.map(p => p.id), ['notes'])
  await assert.rejects(op('startRun', { workflow: 'other.two', title: 'x' }), /unknown workflow/)
  assert.equal(engine.get(r.id).id, gone.id)
  assert.equal((await op('report', { id: r.id })).markdown.includes('think'), true)
  members.scribe = ({ mcp }) => bridge(mcp).call('stage_result', { result: { ok: true, summary: 'thought again' } })
  assert.ok(engine.resumeRun(r.id, { from: 'think' }), 'a run of a workflow that left can still be resumed')
  await finished(r.id)
  await assert.rejects(op('other.hello'), /unknown op/)
}
{
  // the pack of a run that is going when it leaves: the run goes on
  let release
  members.scribe = ({ mcp }) => new Promise(res => { release = async () => res(await bridge(mcp).call('stage_result', { result: { text: 'late draft' } })) })
  const r = (await op('startRun', { workflow: 'notes.publish', title: 'leaving', fields: { channel: 'blog' } })).run
  await until('the agent', () => release)
  off()
  assert.deepEqual((await op('workflows')).builtIn.map(w => w.id), ['blank', 'task'])
  assert.equal(hub.registered.includes('notes'), false, 'its skill pack is taken back from Agent Hub')
  assert.deepEqual([...connNeeds.keys()], ['Workbench workflows'], 'and its needs from the connectors plugin (the person\'s own workflows\' needs stay)')
  await assert.rejects(op('startRun', { workflow: 'notes.publish', title: 'x', fields: { channel: 'blog' } }), /unknown workflow/)
  await release()
  await until('the sign-off', () => engine.get(r.id).status === 'waiting')
  const card = wb.store.list('approval').find(a => a.runId === r.id && a.status === 'pending')
  await op('approve', { id: card.id, payload: { choice: 0 } })
  const end = await finished(r.id)
  assert.equal(end.status, 'done', 'the run goes on without its pack being registered')
  const pub = wb.store.list('approval').find(a => a.runId === r.id && a.action === 'fake_publish')
  assert.equal((await op('approve', { id: pub.id })).approval.status, 'done', 'its card can still be approved')
  // and it comes back: the same id registers again
  provided.ruyixWorkbench.registerPack(notes)
  assert.ok((await op('workflows')).builtIn.some(w => w.id === 'notes.publish'))
}

// ── time is up: one short turn to hand in what is done ──
{
  const sink = {}, own = []
  const wbt = createWorkbench(makeCtx(sink, own, {}), { toolbox: null, home: join(tmp, 'home-time'), engineOptions: { settleMs: 20, resumeDelayMs: 1e9, timeoutMs: 400, graceMs: 3000 } })
  sink.ruyixWorkbench.registerPack(notes)
  const seen = []
  members.scribe = async ({ mcp, task }) => {
    seen.push(task)
    const a = bridge(mcp)
    if (seen.length === 1) { await a.call('file_save', { name: 'half.md', content: 'half a draft' }); return new Promise(() => {}) }
    return a.call('stage_result', { result: { text: 'what was done' } })
  }
  const r = await wbt.engine.startRun({ workflow: 'notes.publish', title: 'slow', fields: { channel: 'blog' } })
  await until('the sign-off', () => wbt.engine.get(r.id).status === 'waiting', 10000)
  assert.equal(seen.length, 2)
  assert.match(seen[1], /## Time is up\nThe previous attempt at this step ran out of time/, 'the second turn is told so')
  assert.equal(tasks.get(wbt.engine.get(r.id).stages.find(s => s.key === 'draft').tasks[0]).status, 'cancelled', 'the first task was cancelled')
  assert.ok(wbt.store.evidence(r.id).some(e => e.kind === 'gate' && /minutes are up — one short turn to hand in what is done/.test(e.title)))
  assert.equal(wbt.engine.get(r.id).draft.text, 'what was done')
  assert.equal(wbt.engine.get(r.id).stages.find(s => s.key === 'draft').status, 'passed')
  wbt.engine.stopRun(r.id)
  await sleep(50)
  for (const d of own.splice(0)) d?.()
}

// ── the tools do not answer: the step stops saying why, no agent is started without them ──
{
  const sink = {}, own = []
  const wbp = createWorkbench(makeCtx(sink, own, {}), { toolbox: null, home: join(tmp, 'home-probe'), engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  sink.ruyixWorkbench.registerPack(notes)
  let asked = 0
  members.scribe = async () => { asked++; return 'never' }
  await sleep(50) // (it is listening)
  await new Promise(ok => wbp.server.close(ok))
  const r = await wbp.engine.startRun({ workflow: 'notes.publish', title: 'no tools', fields: { channel: 'blog' } })
  await until('the step stopped', () => wbp.engine.get(r.id).stages.some(s => s.status === 'failed'))
  assert.equal(asked, 0, 'no agent ran')
  assert.match(wbp.engine.get(r.id).stages.find(s => s.status === 'failed').note, /the workbench's tools do not answer at unix:.*the agent would have none/)
  wbp.engine.stopRun(r.id)
  await sleep(50)
  for (const d of own.splice(0)) d?.()
}

// ── review fixes ──
const agentStep = (id, extra = {}) => ({ id, use: 'agent', title: id, agent: 'scribe', access: 'read', instructions: `Do ${id}.`, ...extra })
{
  // M2: the loopback endpoint takes a body as bytes (a CJK text over 64 KB is not cut in the middle of a character), takes the
  // largest file_save there is, and answers an oversized one with 413 — the request is read to its end, nothing hangs
  await save({ id: 'big-body', title: 'Big body', base: 'blank', steps: [{ use: 'intake' }, agentStep('send'), { use: 'report' }] })
  let seen
  members.scribe = async ({ mcp }) => {
    const a = bridge(mcp)
    const cjk = '中文内容测试'.repeat(40000) // 240k characters, 720 KB
    const e1 = seqOf(await a.call('file_save', { name: 'cjk.md', content: cjk }))
    const stored = readFileSync(join(home, 'runs', wb.store.evidenceAt(engine.get(seen).id, e1).artifact), 'utf8')
    assert.equal(stored === cjk, true, 'every character arrived, none broken at a chunk boundary')
    const big = Buffer.alloc(24 << 20, 7) // the largest file there is: 24 MB as base64 is over 32 MB of body
    assert.match(await a.call('file_save', { name: 'big.bin', content: big.toString('base64'), encoding: 'base64' }), /Saved big\.bin \(25165824 bytes\)/)
    const t0 = Date.now()
    await assert.rejects(a.call('file_save', { name: 'huge.bin', content: 'A'.repeat(40 << 20) }), /the request is over \d+ MB/)
    assert.ok(Date.now() - t0 < 20000, 'the answer came; the request was not left hanging')
    assert.match(await a.call('wb_context', {}), /Run /, 'the same token still works after a 413')
    return a.call('stage_result', { result: { ok: true, summary: 'sent' } })
  }
  seen = (await op('startRun', { workflow: 'big-body', title: 'big' })).run.id
  assert.equal((await finished(seen)).status, 'done')
}
{
  // L1: a step's token goes when the step is over — its agent cannot write to the step after it, or to the run after it
  await save({ id: 'two-steps', title: 'Two steps', base: 'blank', steps: [{ use: 'intake' }, agentStep('one'), agentStep('two'), { use: 'report' }] })
  let first = null, afterRun = null
  members.scribe = async ({ mcp, member }) => {
    const a = bridge(mcp)
    if (member === 'one') {
      first = a
      return a.call('stage_result', { result: { ok: true, summary: 'one' } })
    }
    await assert.rejects(first.call('stage_result', { result: { ok: true, summary: 'one, rewritten later' } }), /not a live workbench run/)
    await assert.rejects(first.call('file_save', { name: 'late.md', content: 'x' }), /not a live workbench run/)
    afterRun = first
    return a.call('stage_result', { result: { ok: true, summary: 'two' } })
  }
  const r = await finished((await op('startRun', { workflow: 'two-steps', title: 'tokens' })).run.id)
  assert.equal(r.status, 'done')
  assert.equal(r.outputs.one.summary, 'one', 'the first step\'s result is as its agent left it')
  assert.ok(!wb.store.evidence(r.id).some(e => e.title === 'file: late.md'))
  await assert.rejects(afterRun.call('wb_context', {}), /not a live workbench run/)
  // a resumed step gets a token of its own: it works again
  await save({ id: 'one-step', title: 'One step', base: 'blank', steps: [{ use: 'intake' }, agentStep('only'), { use: 'report' }] })
  let tries = 0
  members.scribe = async ({ mcp }) => (++tries === 1 ? Promise.reject(new Error('boom')) : bridge(mcp).call('stage_result', { result: { ok: true, summary: 'second time' } }))
  const f = await finished((await op('startRun', { workflow: 'one-step', title: 'again' })).run.id)
  assert.equal(f.status, 'failed')
  await op('resumeRun', { id: f.id })
  assert.equal((await until('the resumed run', () => { const x = engine.get(f.id); return x.status === 'done' && !engine.active(f.id) && x })).outputs.only.summary, 'second time')
}
{
  // M3: a decision asked in a parallel lane that sends the work back is not a lane's failure: the block goes back as a whole
  const lanes = (extra = {}) => ({
    id: 'lanes', title: 'Lanes', base: 'blank',
    steps: [{ use: 'intake' }, agentStep('collect'),
      { id: 'fan', use: 'parallel', title: 'Fan', lanes: [
        { id: 'a', label: 'A', steps: [agentStep('read-a')] },
        { id: 'b', label: 'B', steps: [agentStep('read-b')] },
      ], ...extra },
      { use: 'report' }],
  })
  const answerAll = (runId, choice, stop = () => false) => (async () => { // the person: answers every question of the run with `choice`
    const done = new Set()
    while (!stop()) {
      for (const a of wb.store.list('approval')) if (a.runId === runId && a.action === 'decision' && a.status === 'pending' && !done.has(a.id)) { done.add(a.id); await op('approve', { id: a.id, payload: { choice } }) }
      await sleep(15)
    }
  })()
  const asking = (when, from) => async ({ mcp, member }) => {
    const a = bridge(mcp)
    if (member === 'read-a' && when()) await a.call('decision_needed', { question: 'Collect again?', why: 'evidence #1', blocking: true, options: [{ label: 'Again', does: 'redo', action: 'revise', from }, { label: 'Fine', does: 'go on', action: 'accept' }] })
    return a.call('stage_result', { result: { ok: true, summary: `${member} done` } })
  }
  // back to a step before the block: that step and the whole block run again
  await save(lanes())
  let asked = 0
  members.scribe = asking(() => ++asked === 1, 'collect')
  let r = (await op('startRun', { workflow: 'lanes', title: 'before the block' })).run
  await answerAll(r.id, 0, () => !['queued', 'running', 'waiting'].includes(engine.get(r.id).status))
  r = await finished(r.id)
  assert.equal(r.status, 'done', JSON.stringify(r.stages.map(s => [s.key, s.status, s.note])))
  assert.deepEqual(r.stages.map(s => [s.key, s.attempt]), [['intake', 1], ['collect', 2], ['fan', 2], ['read-a', 2], ['read-b', 2], ['report', 1]], 'collect and the block ran twice')
  assert.equal(r.loops['fan~decision'], 1, 'the trip back is counted')
  assert.ok(r.stages.find(s => s.key === 'read-a').history.length === 1, 'what the first round did is kept in the step\'s history')
  assert.ok(wb.store.evidence(r.id).some(e => e.kind === 'gate' && /fan: failed → back to collect/.test(e.title) || /a decision in a lane sent it back → back to collect/.test(e.output || '')))
  // back to a step of the lane itself (or of another lane): the block starts again
  asked = 0
  members.scribe = asking(() => ++asked === 1, 'read-a')
  r = (await op('startRun', { workflow: 'lanes', title: 'inside the block' })).run
  await answerAll(r.id, 0, () => !['queued', 'running', 'waiting'].includes(engine.get(r.id).status))
  r = await finished(r.id)
  assert.equal(r.status, 'done')
  assert.deepEqual(r.stages.map(s => [s.key, s.attempt]), [['intake', 1], ['collect', 1], ['fan', 2], ['read-a', 2], ['read-b', 2], ['report', 1]], 'collect once; every lane of the block twice')
  // a decision that always sends it back is allowed a few trips (5), then the run stops for a person
  members.scribe = asking(() => true, 'collect')
  r = (await op('startRun', { workflow: 'lanes', title: 'never satisfied' })).run
  await answerAll(r.id, 0, () => !['queued', 'running', 'waiting'].includes(engine.get(r.id).status))
  r = await finished(r.id)
  assert.equal(r.status, 'failed')
  assert.equal(r.verdict.stopped, 'fan')
  assert.match(r.verdict.reason, /sent back 5 times by decisions in its lanes — a person decides/)
  assert.equal(r.loops['fan~decision'], 5)
  // "continue" on the same question is just that
  members.scribe = asking(() => true, 'collect')
  r = (await op('startRun', { workflow: 'lanes', title: 'fine as it is' })).run
  await answerAll(r.id, 1, () => !['queued', 'running', 'waiting'].includes(engine.get(r.id).status))
  r = await finished(r.id)
  assert.deepEqual([r.status, r.stages.find(s => s.key === 'collect').attempt], ['done', 1])
}
{
  // M4: what the engine and the packs make themselves is in runs/<id>/out, next to the agents' folder (runs/<id>/work), not in it
  const r = await finished((await op('startRun', { workflow: 'big-body', title: 'out folder' })).run.id)
  assert.equal(r.dir, join(home, 'runs', r.id, 'work'))
  assert.equal(r.outDir, join(home, 'runs', r.id, 'out'))
  assert.ok(existsSync(r.outDir) && statSync(r.outDir).isDirectory(), 'the engine makes it')
  assert.ok(!r.outDir.startsWith(`${r.dir}/`) && !r.dir.startsWith(`${r.outDir}/`), 'neither holds the other')
  await save({ id: 'out-script', title: 'Out', base: 'blank', steps: [{ use: 'intake' }, { id: 'probe', use: 'script', title: 'Probe', run: PWD }, { use: 'report' }] })
  const o = await finished((await op('startRun', { workflow: 'out-script', title: 'cwd' })).run.id)
  assert.equal(samePath(wb.store.evidence(o.id).find(e => e.kind === 'command').output.trim()), samePath(o.dir), 'a script runs in the agents\' folder, not in out/')
  // the report written by the closing step shows that step as passed and the run as done, not "running"
  const rep = (await op('report', { id: o.id })).markdown
  assert.match(rep, new RegExp(`Run \`${o.id}\` · Out · done · started`), 'the run, as it settles')
  assert.match(rep, /\| report \| system \| passed \|/)
  assert.ok(!/running/.test(rep), 'nothing in it is still "running"')
  assert.match(rep, /\| #1 \| intake \|/, 'evidence numbers are plain #n for the panel to link')
}
{
  // L5: a new card for an action the run has an open card for replaces it; questions (decisions) stay many
  members.scribe = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { text: 'x' } })
  const r = (await op('startRun', { workflow: 'notes.publish', title: 'cards', fields: { channel: 'blog' } })).run
  await until('the sign-off', () => wb.store.list('approval').find(a => a.runId === r.id && a.action === 'decision' && a.status === 'pending'))
  const mk = text => engine.addApproval(r.id, { action: 'fake_publish', title: 'Publish', payload: { text, channel: 'blog' } })
  const c1 = mk('one'), again = mk('one'), c2 = mk('two')
  assert.equal(again.id, c1.id, 'the same card asked again is the same card')
  assert.notEqual(c2.id, c1.id)
  assert.equal(wb.store.get('approval', c1.id).status, 'superseded')
  assert.equal(wb.store.get('approval', c1.id).supersededBy, c2.id)
  await assert.rejects(op('approve', { id: c1.id }), /already superseded/)
  assert.equal(wb.store.list('approval').filter(a => a.runId === r.id && a.action === 'decision' && a.status === 'pending').length, 1, 'the question is still open')
  assert.ok(wb.store.evidence(r.id).some(e => e.kind === 'gate' && /superseded by a newer card: Publish/.test(e.title)))
  wb.store.put('approval', { ...c2, status: 'failed', error: 'fixture refusal' })
  const c3 = mk('two')
  assert.equal(wb.store.get('approval', c2.id).status, 'superseded', 'failed retry cards are replaced too')
  await assert.rejects(op('approve', { id: c2.id }), /already superseded/)
  const sent = (await op('approve', { id: c3.id })).approval
  assert.equal(sent.status, 'done')
  assert.equal(published.at(-1).text, 'two')
  engine.stopRun(r.id)
  await finished(r.id)
}
{
  // M6: an action that reaches outside reads the settings as they are now; `settings` / `packSettings` stay the run's snapshot
  members.scribe = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { text: 'x' } })
  const r = (await op('startRun', { workflow: 'notes.publish', title: 'settings later', fields: { channel: 'blog' } })).run
  await until('the sign-off', () => wb.store.list('approval').find(a => a.runId === r.id && a.action === 'decision' && a.status === 'pending'))
  const before = (await op('settings')).settings
  await op('saveSettings', { settings: { ...before, packs: { ...before.packs, notes: { ...before.packs.notes, greeting: 'hello', limits: { chars: 123 } } } } })
  const card = engine.addApproval(r.id, { action: 'fake_where', title: 'Where', payload: {} })
  const res = (await op('approve', { id: card.id })).approval
  assert.equal(res.status, 'done', res.error)
  const then = engine.get(r.id).config.packs.notes.limits.chars
  assert.notEqual(then, 123)
  assert.deepEqual(res.result, { snapshot: then, now: 123, all: 123 }, 'the run\'s own settings are as they were; the action\'s are as they are now')
  await op('saveSettings', { settings: before })
  engine.stopRun(r.id)
  await finished(r.id)
}

// ── person steps: a review, an answer, a choice, something done outside — each waits for the one person ──
{
  const pending = id => wb.store.list('approval').find(a => a.runId === id && ['pending', 'failed'].includes(a.status))
  const waitCard = (id, n = 1) => until(`card ${n} of ${id}`, () => { const all = wb.store.list('approval').filter(a => a.runId === id && a.payload?.by === 'workflow'); return all.length >= n && pending(id) })
  // a review: approve, or ask for changes — back to the step it names, the person's notes in that step's brief
  const briefs = []
  members.scribe = async ({ mcp, task }) => { briefs.push(task); return bridge(mcp).call('stage_result', { result: { ok: true, summary: `made ${briefs.length}` } }) }
  const review = {
    id: 'reviewed', title: 'Reviewed', base: 'blank',
    steps: [{ use: 'intake' },
      { id: 'make', use: 'agent', title: 'Make', agent: 'scribe', access: 'write', instructions: 'Make the thing.' },
      { id: 'look', use: 'person', ask: 'review', title: 'Look at it', text: 'Is the thing right?', back: 'make' },
      { id: 'send', use: 'script', title: 'Send', run: 'echo sent', connectors: { 'blog-api': 'write' } },
      { use: 'report' }],
  }
  const s = await save(review)
  assert.deepEqual(s.errors, [], 'a review before a writing script is the person\'s yes on its path')
  const r = (await op('startRun', { workflow: 'reviewed', title: 'review me' })).run
  const c1 = await waitCard(r.id)
  assert.equal(c1.action, 'decision')
  assert.equal(c1.payload.person, 'review')
  // (and, the step before being an agent's, "revise with my notes": lib/review.js, checked above)
  assert.deepEqual(c1.payload.options.map(o => [o.label, o.action, o.from || null]), [['Approve', 'accept', null], ['Revise with my notes', 'amend', null], ['Ask for changes', 'revise', 'make'], ['Stop the run', 'stop', null]])
  assert.equal(c1.payload.deadline, null, 'a review waits as long as it takes: no reminder')
  assert.equal(engine.get(r.id).status, 'waiting')
  assert.equal(engine.get(r.id).waitingFor, c1.id)
  // the card's own fields are not the person's to change
  await op('approve', { id: c1.id, payload: { choice: 2, comment: 'make it bigger', options: [{ label: 'x', action: 'accept' }] } })
  const c2 = await waitCard(r.id, 2)
  assert.notEqual(c2.id, c1.id, 'back at the review: a new card')
  assert.equal(wb.store.get('approval', c1.id).payload.options.length, 4)
  assert.equal(engine.get(r.id).stages.find(x => x.key === 'make').attempt, 2, 'changes asked: the step it names ran again')
  assert.match(briefs.at(-1), /## What the person said[\s\S]*make it bigger/, 'with the person\'s notes in its brief')
  assert.ok(!/make it bigger/.test(briefs[0]))
  assert.equal(conns.envCalls.filter(c => c[1].by === `${r.id}:send`).length, 0, 'nothing written before the person approved')
  await op('approve', { id: c2.id, payload: { choice: 0 } })
  const done = await finished(r.id)
  assert.equal(done.status, 'done', JSON.stringify(done.stages))
  assert.deepEqual(done.outputs.look, { verdict: 'approve', rounds: 1, comments: 0, ok: true }, 'back at the review after the changes: a new review (the first kept in past)')
  assert.equal(done.reviews.look.past[0].comments[0].text, 'make it bigger')
  assert.deepEqual(done.decisions.map(d => d.label), ['Ask for changes', 'Approve'])
  assert.equal(done.decisions[0].notes, 'make it bigger')
  assert.ok(conns.envCalls.some(c => c[1].by === `${r.id}:send`), 'the writing script ran after the yes')
  assert.ok(wb.store.verify(r.id).ok)

  // an input: the answer is what the step hands back, a branch after it reads it; an empty answer is refused
  const input = {
    id: 'asked', title: 'Asked', base: 'blank',
    steps: [{ use: 'intake' },
      { id: 'colour', use: 'person', ask: 'input', title: 'Which colour?', text: 'Which colour should it be?' },
      { id: 'by', use: 'branch', title: 'By colour', routes: [{ id: 'red', label: 'Red', when: { output: 'colour', has: 'red' }, steps: [sc2('paint-red')] }], otherwise: { label: 'Other', steps: [sc2('paint-other')] } },
      { use: 'report' }],
  }
  assert.deepEqual((await save(input)).errors, [], 'a branch reads what a person step handed back')
  const r2 = (await op('startRun', { workflow: 'asked', title: 'colour' })).run
  const ask = await waitCard(r2.id)
  assert.equal(ask.action, 'help')
  assert.equal(ask.payload.kind, 'input')
  assert.equal(ask.payload.wait, 24)
  assert.ok(ask.payload.deadline > Date.now() + 23 * 3600e3, 'an input reminds its person after 24 h')
  await assert.rejects(op('approve', { id: ask.id, payload: { input: '  ' } }), /write the answer first/)
  assert.equal(wb.store.get('approval', ask.id).status, 'pending', 'an empty answer is refused, the card stays as it was')
  await op('approve', { id: ask.id, payload: { input: 'red, please' } })
  const d2 = await finished(r2.id)
  assert.equal(d2.status, 'done', JSON.stringify(d2.stages))
  assert.equal(d2.outputs.colour.answer, 'red, please')
  assert.equal(d2.stages.find(x => x.key === 'paint-red').status, 'passed')
  assert.equal(d2.stages.find(x => x.key === 'paint-other').status, 'skipped')
  assert.ok(d2.guidance.some(g => !g.stage && /red, please/.test(g.text)), 'the answer is said to the steps after it')

  // a decision: one of its choices; one that names a step sends the run back there
  const decide = {
    id: 'decided', title: 'Decided', base: 'blank',
    steps: [{ use: 'intake' }, { id: 'prep', use: 'script', title: 'Prep', run: 'echo p >> prep.txt' },
      { id: 'choose', use: 'person', ask: 'decide', title: 'Ship it?', text: 'Ship, or prepare again?', options: [{ label: 'Prepare again', to: 'prep' }, { label: 'Ship' }] },
      { use: 'report' }],
  }
  assert.deepEqual((await save(decide)).errors, [])
  const r3 = (await op('startRun', { workflow: 'decided', title: 'decide' })).run
  const q1 = await waitCard(r3.id)
  assert.deepEqual(q1.payload.options.map(o => [o.label, o.action, o.from || null]), [['Prepare again', 'revise', 'prep'], ['Ship', 'accept', null], ['Stop the run', 'stop', null]])
  await op('approve', { id: q1.id, payload: { choice: 0 } })
  const q2 = await waitCard(r3.id, 2)
  await op('approve', { id: q2.id, payload: { choice: 1 } })
  const d3 = await finished(r3.id)
  assert.equal(d3.status, 'done')
  assert.equal(readFileSync(join(d3.dir, 'prep.txt'), 'utf8'), 'p\np\n', 'the choice that goes back ran the step again')
  assert.deepEqual(d3.outputs.choose, { choice: 'Ship', ok: true })

  // something done outside: past its hours the person is reminded (once), the run keeps waiting; said done, it goes on
  const doIt = { id: 'done-outside', title: 'Done outside', base: 'blank', steps: [{ use: 'intake' }, { id: 'call', use: 'person', ask: 'do', title: 'Call the plumber', text: 'Call the plumber and say when they come.', wait: 2 }, { use: 'report' }] }
  assert.deepEqual((await save(doIt)).errors, [])
  const r4 = (await op('startRun', { workflow: 'done-outside', title: 'plumber' })).run
  const job = await waitCard(r4.id)
  assert.equal(job.payload.kind, 'do')
  assert.equal(job.payload.wait, 2)
  wb.store.put('approval', { ...job, payload: { ...job.payload, deadline: Date.now() - 1000 } }) // two hours later
  await until('the reminder', () => wb.store.get('approval', job.id).payload.remindedAt)
  await sleep(80)
  assert.equal(wb.store.evidence(r4.id).filter(e => /no answer within 2 h — the person is reminded/.test(e.title)).length, 1, 'reminded once')
  assert.equal(engine.get(r4.id).status, 'waiting', 'the clock decides nothing: the run keeps waiting')
  await op('approve', { id: job.id, payload: { input: 'Tuesday' } })
  const d4 = await finished(r4.id)
  assert.equal(d4.status, 'done')
  assert.match(d4.stages.find(x => x.key === 'call').note, /Tuesday/)
  // … or stopped: rejecting the ask stops the run there
  const r5 = (await op('startRun', { workflow: 'done-outside', title: 'plumber 2' })).run
  const job5 = await waitCard(r5.id)
  await op('reject', { id: job5.id, reason: 'no plumber' })
  const d5 = await finished(r5.id)
  assert.equal(d5.status, 'failed')
  assert.match(d5.verdict.reason, /stopped by the person — no plumber/)
  // a run stopped while it waits: its ask is closed (nobody needs to answer it any more)
  const r6 = (await op('startRun', { workflow: 'done-outside', title: 'plumber 3' })).run
  const job6 = await waitCard(r6.id)
  await op('stopRun', { id: r6.id })
  await finished(r6.id)
  assert.equal(wb.store.get('approval', job6.id).status, 'rejected')
  assert.match(wb.store.get('approval', job6.id).reason, /the run ended \(cancelled\)/)

  // what a person step may be
  const v = def => op('workflowValidate', { definition: { id: 'p-check', title: 'P', base: 'blank', steps: [{ use: 'intake' }, ...def, { use: 'report' }] } }).then(x => x.errors.map(e => e.message).join(' | '))
  assert.match(await v([{ id: 'p', use: 'person', ask: 'decide', title: 'P', text: 'x', options: [{ label: 'only' }] }]), /two choices or more/)
  assert.match(await v([{ id: 'p', use: 'person', ask: 'review', title: 'P', text: 'x', back: 'later' }, sc2('later')]), /goes back to "later", which is not a step before it/)
  assert.match(await v([{ id: 'p', use: 'person', ask: 'ask-the-team', title: 'P', text: 'x' }]), /a person step asks review, input, decide, do/)
  assert.match(await v([{ id: 'p', use: 'person', ask: 'input', title: 'P', text: '' }]), /says what it asks of the person/)
  assert.match(await v([{ id: 'p', use: 'person', ask: 'do', title: 'P', text: 'x', wait: 9999 }]), /waits 0–720 hours/)
  assert.match(await v([{ id: 'f', use: 'parallel', title: 'F', lanes: [{ id: 'a', steps: [{ id: 'p', use: 'person', ask: 'input', title: 'P', text: 'x' }] }, { id: 'b', steps: [sc2('b1')] }] }]), /a parallel lane holds agent, model and script steps, not "person"/)
  assert.match(await v([{ id: 'ok', use: 'person', ask: 'input', title: 'P', text: 'x' }, { ...sc2('w'), connectors: { 'blog-api': 'write' } }]), /w writes through a connection: put an approval step before it/, 'an input is no yes to writing')
}

// ── what a workflow needs, and readiness: a run that is not ready does not start ──
{
  // a script step's connection by type: this machine binds it (the only http connection here)
  const typed = { id: 'typed', title: 'Typed', base: 'blank', steps: [{ use: 'intake' }, { id: 'call', use: 'script', title: 'Call', run: 'echo "t=$BLOG_TOKEN"', connectors: [{ type: 'http', level: 'read' }] }, { use: 'report' }] }
  assert.deepEqual((await save(typed)).errors, [])
  const rd = await op('workflowReadiness', { id: 'typed' })
  assert.deepEqual(rd.steps.map(x => [x.id, x.items.map(i => [i.kind, i.ref, i.status, i.connection, i.how])]), [['call', [['connector', 'http', 'ok', 'blog-api', 'only']]]])
  assert.equal(rd.missing, 0)
  const r = await finished((await op('startRun', { workflow: 'typed', title: 'typed' })).run.id)
  assert.equal(r.status, 'done')
  assert.deepEqual(conns.envCalls.at(-1), ['blog-api', { write: false, by: `${r.id}:call` }], 'the step got the connection bound here')
  assert.equal(wb.store.evidence(r.id).find(e => e.kind === 'command').output.trim(), 't=«secret»')
  assert.ok(conns.needs().some(n => n.owner === 'Workbench workflows' && n.type === 'http' && n.connection === 'blog-api'), 'the Connectors page sees what the workflow uses')
  // a type this machine has no connection of: not ready — the run does not start, and says what is missing
  await save({ ...typed, id: 'typed-ftp', steps: typed.steps.map(x => (x.id === 'call' ? { ...x, connectors: [{ type: 'ftp', level: 'read' }] } : x)) })
  const nr = await op('workflowReadiness', { id: 'typed-ftp' })
  assert.equal(nr.missing, 1)
  assert.equal(nr.steps[0].items[0].status, 'unbound')
  assert.equal(nr.steps[0].items[0].how, 'none')
  await assert.rejects(op('startRun', { workflow: 'typed-ftp', title: 'x' }), err => err.code === 'workflowNotReady' && /not ready here — missing: connector ftp \(read\) at call/.test(err.message))
  assert.ok(conns.needs().some(n => n.owner === 'Workbench workflows' && n.type === 'ftp' && n.state === 'missing'), 'and the System tab hears of the need no connection meets')
  assert.equal((await op('workflows')).mine.find(d => d.id === 'typed-ftp').ready.missing, 1, 'the Workflows page shows it')
  // two of a type: the person binds one — for every workflow, or for one workflow
  const list = conns.list
  conns.list = async () => [...await list(), { id: 'other-api', type: 'http', name: 'Other API' }]
  assert.equal((await op('workflowReadiness', { id: 'typed' })).steps[0].items[0].how, 'choose')
  await assert.rejects(op('startRun', { workflow: 'typed', title: 'x' }), /not ready here/)
  await assert.rejects(op('bindingSet', { key: 'http', connection: 'nope' }), /no connection nope here/)
  await op('bindingSet', { key: 'http', connection: 'other-api' })
  assert.deepEqual((await op('workflowReadiness', { id: 'typed' })).steps[0].items[0].connection, 'other-api')
  await op('bindingSet', { key: 'http', connection: 'blog-api', workflow: 'typed' })
  const own = (await op('workflowReadiness', { id: 'typed' })).steps[0].items[0]
  assert.deepEqual([own.connection, own.how], ['blog-api', 'workflow'])
  assert.deepEqual((await op('bindings')).bindings, { types: { http: 'other-api' }, workflows: { typed: { http: 'blog-api' } } })
  assert.ok(existsSync(join(home, 'bindings.json')), 'the bindings are this machine\'s, kept with the workbench')
  const rb = await finished((await op('startRun', { workflow: 'typed', title: 'bound' })).run.id)
  assert.equal(conns.envCalls.at(-1)[0], 'blog-api', 'the workflow\'s own binding')
  assert.equal(rb.status, 'done')
  conns.list = list
  await op('bindingSet', { key: 'http', connection: null })
  await op('bindingSet', { key: 'http', connection: null, workflow: 'typed' })

  // an agent the workflow names that left the pool: not ready
  hub.agentsList.set('temp', { id: 'temp', name: 'temp', runtime: 'dsh' })
  members.temp = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { ok: true, summary: 'ok' } })
  await save({ id: 'with-temp', title: 'With temp', base: 'blank', steps: [{ use: 'intake' }, { id: 'go', use: 'agent', title: 'Go', agent: 'temp', fallback: 'opus', instructions: 'Go.' }, { use: 'report' }] })
  assert.deepEqual((await op('workflowReadiness', { id: 'with-temp' })).steps[0].items.map(i => [i.ref, i.status]), [['temp', 'ok'], ['opus', 'ok']])
  hub.agentsList.delete('temp')
  const gone = await op('workflowReadiness', { id: 'with-temp' })
  assert.deepEqual(gone.steps[0].items.map(i => [i.ref, i.status]), [['temp', 'missing'], ['opus', 'ok']])
  await assert.rejects(op('startRun', { workflow: 'with-temp', title: 'x' }), /missing: agent temp at go/)

  // skill packs: pinned when the workflow is saved; one this machine can install is installed before the run (at its pin)
  let installed = false
  const ensured = []
  hub.skillPins = (ids, refs) => ids.map(id => ({ id, version: '1.0', ...(id === 'per' && { skills: Object.fromEntries(refs.filter(x => x.startsWith('per/')).map(x => [x.slice(4), { version: '2.1' }])) }) }))
  hub.skillCheck = async refs => refs.map(ref => ({ ref, status: ref.startsWith('later/') ? (installed ? 'ok' : 'fetch') : ref.startsWith('gone/') ? 'missing' : 'ok' }))
  hub.skillEnsure = async pins => { ensured.push(pins); if (pins.later) installed = true; return { fetched: pins.later ? ['later'] : [], failed: [] } }
  const skilled = { id: 'skilled', title: 'Skilled', base: 'blank', steps: [{ use: 'intake' }, { id: 'go', use: 'agent', title: 'Go', agent: 'scribe', instructions: 'Go.', skills: ['later/x', 'per/y'] }, { use: 'report' }] }
  const saved = (await save(skilled)).workflow
  assert.deepEqual(saved.packs, [{ id: 'later', version: '1.0' }, { id: 'per', version: '1.0', skills: { y: { version: '2.1' } } }], 'the packs its steps use are pinned with it')
  const pre = await op('workflowReadiness', { id: 'skilled' })
  assert.deepEqual([pre.installable, pre.missing, pre.ready], [1, 0, false])
  assert.equal(pre.steps[0].items.find(i => i.ref === 'per/y').pin, '2.1', 'a skill pinned on its own shows its own version')
  members.scribe = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { ok: true, summary: 'skilled' } })
  const rs = await finished((await op('startRun', { workflow: 'skilled', title: 'skills' })).run.id)
  assert.equal(rs.status, 'done', JSON.stringify(rs.stages))
  assert.deepEqual(Object.keys(ensured.at(-1)), ['later', 'per'], 'what it needed was installed first, at its pins')
  assert.deepEqual(tasks.get(rs.stages.find(x => x.key === 'go').tasks[0]).pins, { later: { id: 'later', version: '1.0' }, per: { id: 'per', version: '1.0', skills: { y: { version: '2.1' } } } }, 'the agent\'s task takes the skills at those pins')
  await save({ ...skilled, id: 'unskilled', packs: [], steps: skilled.steps.map(x => (x.id === 'go' ? { ...x, skills: ['gone/z'] } : x)) })
  await assert.rejects(op('startRun', { workflow: 'unskilled', title: 'x' }), /missing: skill gone\/z at go/)
  // saved again (the editor sends no pins): the pins it carries stay, even when this machine has moved on
  const pins = hub.skillPins
  hub.skillPins = (ids, refs) => pins(ids, refs).map(p => ({ ...p, version: '2.0' }))
  assert.deepEqual((await save(skilled)).workflow.packs.map(p => p.version), ['1.0', '1.0'], 'a re-save keeps its pins')
  assert.deepEqual((await save({ ...skilled, steps: skilled.steps.map(x => (x.id === 'go' ? { ...x, skills: [...x.skills, 'new/z'] } : x)) })).workflow.packs.map(p => `${p.id}@${p.version}`), ['later@1.0', 'per@1.0', 'new@2.0'], 'a pack it did not use yet is pinned as this machine has it')
  await save(skilled)
  hub.skillPins = pins
  const en = await op('workflowEnsure', { id: 'skilled' })
  assert.deepEqual([en.failed, en.readiness.ready], [[], true])
  delete hub.skillPins; delete hub.skillCheck; delete hub.skillEnsure

  // a definition being edited: its installed script that is not here, its model's connection that is not here
  const draft = await op('workflowReadiness', { definition: { id: 'drafty', base: 'blank', steps: [{ use: 'intake' }, { id: 'tool', use: 'script', title: 'Tool', script: 'nothere@1' }, { id: 'sum', use: 'model', title: 'Sum', instructions: 'x', model: 'nowhere:gpt' }, { use: 'report' }] } })
  assert.deepEqual(draft.steps.map(x => x.items.map(i => [i.kind, i.ref, i.status])), [[['script', 'nothere@1', 'missing']], [['model', 'nowhere:gpt', 'missing']]])
  assert.match(draft.what, /script nothere@1 at tool; model nowhere:gpt at sum/)
  // a built-in workflow: its agent steps as this machine picks them, its pack's connections (shown, never what stops a start)
  const bi = await op('workflowReadiness', { id: 'notes.publish' })
  assert.deepEqual(bi.steps.find(x => x.id === 'draft').items.map(i => [i.kind, i.ref, i.status]), [['agent', 'scribe', 'ok'], ['agent', 'dshy', 'ok']])
  const packRow = bi.steps.find(x => x.id === 'pack:notes')
  assert.ok(packRow && packRow.items.every(i => i.pack && i.kind === 'connector'), 'the pack\'s own connections are listed')
  assert.equal(bi.missing, 0, 'a pack connection that is not set warns, it does not stop a start')
  assert.ok((await op('workflows')).builtIn.every(b => b.ready && typeof b.ready.missing === 'number'))
}

// ── the AI work done here: Agent Hub's tasks, the runs' steps, the model calls the workbench makes itself ──
{
  const r = await finished((await op('startRun', { workflow: 'summarise', title: 'count me', text: 'once' })).run.id)
  await op('translate', { texts: ['count this too'], lang: 'zh' })
  const lines = readFileSync(join(home, 'ai-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const mine = lines.find(l => l.by === `${r.id}:sum`)
  assert.ok(mine, 'a model step\'s call is in the log, with its run and step')
  assert.deepEqual([mine.kind, mine.model, mine.ok], ['model', 'dsh:fake/model', true])
  assert.ok(lines.some(l => l.kind === 'translate' && l.ok), 'a translation is in the log')
  const w = await op('aiWork', { hours: 2 })
  assert.equal(w.available.hub, false, 'without Agent Hub\'s task list: the steps from the ledger')
  const row = w.tasks.find(x => x.source === 'helper' && x.run_id === r.id)
  assert.deepEqual([row.kind, row.step, row.workflow], ['model', 'sum', 'summarise'], 'a model step\'s call names its run and step')
  assert.ok(w.helper_kinds.some(k => k.kind === 'translate') && w.helper_kinds.some(k => k.kind === 'model'))
  assert.ok(w.by_source.workflow.calls > 0, 'agent steps of the runs, from their ledgers')
  // Agent Hub's tasks, when it lists them: each step's task named by its run and step
  const agentRun = engine.get([...wb.store.list('run')].find(x => x.template === 'skilled').id)
  const taskId = agentRun.stages.find(x => x.key === 'go').tasks[0]
  hub.tasks = since => [{ id: taskId, jobId: agentRun.jobId, agent: 'scribe', status: 'done', startedAt: Date.now() - 2000, endedAt: Date.now() - 1000, tokens: 42 }, { id: 'tx', jobId: 'chat-job', agent: 'opus', status: 'failed', error: 'boom', startedAt: Date.now() - 900, endedAt: Date.now() - 800, createdAt: Date.now() - 900 }].filter(t => t.endedAt >= since)
  const h = service.aiWork({ hours: 1 })
  assert.equal(h.available.hub, true)
  assert.deepEqual(['workflow', 'skilled', 'go'], ((x => [x.source, x.workflow, x.step])(h.tasks.find(x => x.id === taskId))))
  assert.equal(h.tasks.find(x => x.id === 'tx').source, 'job', 'a chat\'s job')
  assert.equal(h.by_agent.find(a => a.agent === 'scribe').tokens, 42)
  // the box plugin finds it through the shell's parts
  const part = shellParts.find(p => p.workbench?.aiWork) // (this workbench's: the first made here)
  assert.ok(part && part.id === 'workbench', 'the shell part carries workbench.aiWork')
  assert.equal(part.workbench.aiWork({ hours: 1 }).totals.agent_tasks, 2)
  delete hub.tasks
}

// ── a restart: runs that were going come back interrupted, and resume ──
{
  let phase = 'before'
  const seen = []
  members.scribe = async ({ mcp, task }) => {
    seen.push(task)
    const a = bridge(mcp)
    if (phase === 'before' && /hangs/.test(task)) { await a.call('file_save', { name: 'part.md', content: 'half' }); return new Promise(() => {}) }
    return a.call('stage_result', { result: { text: 'before the restart' } })
  }
  const r = (await op('startRun', { workflow: 'notes.publish', title: 'restart', fields: { channel: 'blog' } })).run
  await until('the sign-off', () => engine.get(r.id).status === 'waiting')
  const h = (await op('startRun', { workflow: 'notes.publish', title: 'hangs', fields: { channel: 'blog' } })).run
  await until('the half draft', () => wb.store.evidence(h.id).some(e => e.title === 'file: part.md'))
  // dsh goes down: the engine, the server and the store close; the run is interrupted
  for (const d of disposers.splice(0)) d?.()
  const store2 = openStore(home)
  const was = store2.get('run', r.id)
  assert.equal(was.status, 'interrupted', 'a run cut short by the shutdown is interrupted, not cancelled')
  assert.equal(was.interruptedBy, 'restart')
  store2.close()
  // the next start
  phase = 'after'
  const ctx2 = makeCtx()
  const wb2 = createWorkbench(ctx2, { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  provided.ruyixWorkbench.registerPack(notes)
  const back = wb2.engine.get(r.id)
  assert.equal(back.status, 'interrupted')
  assert.equal(back.stages.find(s => s.key === 'sign-off').status, 'running', 'the step it was in')
  wb2.engine.resumeRun(r.id)
  const card = await until('the sign-off again', () => wb2.store.list('approval').find(a => a.runId === r.id && a.status === 'pending' && a.action === 'decision'))
  assert.ok(card)
  assert.equal(wb2.store.list('approval').filter(a => a.runId === r.id && a.action === 'decision').length, 1, 'the question that was open is not asked twice')
  assert.ok(wb2.store.verify(r.id).ok)
  assert.equal(wb2.store.evidence(r.id).filter(e => e.kind === 'file').length, 0)
  assert.equal(back.stages.find(s => s.key === 'draft').status, 'passed', 'a step that passed is not run again')
  // the agent step that was going: the next attempt is told what the first had done
  const cut = wb2.engine.get(h.id)
  assert.equal(cut.status, 'interrupted')
  assert.equal(cut.stages.find(s => s.key === 'draft').resume.why, 'restart')
  wb2.engine.resumeRun(h.id)
  await until('the second attempt', () => wb2.engine.get(h.id).status === 'waiting')
  assert.match(seen.at(-1), /## Picking up an interrupted attempt[\s\S]*What it had already done[\s\S]*file · file: part\.md/)
  assert.ok(wb2.store.evidence(h.id).some(e => e.kind === 'gate' && /continued with a handoff of the interrupted attempt \(L2\)/.test(e.title)))
  assert.equal(wb2.engine.get(h.id).draft.text, 'before the restart')
  assert.ok(wb2.store.verify(h.id).ok)
  wb2.engine.dispose()
  for (const d of disposers.splice(0)) d?.()
}

// ── review fixes, going on ──
{
  // L2: a decision answered while the run is cut short by a restart is not lost: it is heard when the run is resumed
  members.scribe = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { text: 'a draft' } })
  const wb1 = createWorkbench(makeCtx(), { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  provided.ruyixWorkbench.registerPack(notes)
  const r = (await op('startRun', { workflow: 'notes.publish', title: 'answer during a restart', fields: { channel: 'blog' } })).run
  const card = await until('the sign-off', () => wb1.store.list('approval').find(a => a.runId === r.id && a.action === 'decision' && a.status === 'pending'))
  for (const d of disposers.splice(0)) d?.() // dsh goes down
  const ctx3 = makeCtx()
  const wb3 = createWorkbench(ctx3, { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  provided.ruyixWorkbench.registerPack(notes)
  assert.equal(wb3.engine.get(r.id).status, 'interrupted')
  const answered = (await op('approve', { id: card.id, payload: { choice: 1 } })).approval // "Write it again"
  assert.equal(answered.status, 'done')
  assert.equal(answered.result.applied, false, 'not applied, and not marked as heard: the run is not going')
  assert.equal(wb3.engine.get(r.id).decisions, undefined, 'nothing was recorded as decided yet')
  wb3.engine.resumeRun(r.id)
  await until('the draft again', () => wb3.engine.get(r.id).stages.find(s => s.key === 'draft').attempt === 2)
  const next = await until('the sign-off after the new draft', () => wb3.store.list('approval').find(a => a.runId === r.id && a.action === 'decision' && a.status === 'pending'))
  assert.notEqual(next.id, card.id)
  const cards = wb3.store.list('approval').filter(a => a.runId === r.id && a.action === 'decision')
  assert.equal(cards.length, 2, 'the answered card was found again when the step asked: one question, not asked twice')
  assert.deepEqual(wb3.engine.get(r.id).decisions.map(d => d.label), ['Write it again'], 'the answer was applied by the step that asked')
  assert.equal(wb3.store.get('approval', card.id).result.applied, true)
  wb3.engine.stopRun(r.id)
  await until('stopped', () => wb3.engine.get(r.id).status === 'cancelled' && !wb3.engine.active(r.id))
  wb3.engine.dispose()
  for (const d of disposers.splice(0)) d?.()
}

{
  // Explicitly redoing work retires the prior intent; plain resume above preserves it. Exercise each engine entry point
  // and both outcomes of an approval action that finishes after the restart has already replaced its card.
  const { actions } = await import('./workflows/common.js')
  const delayed = new Map()
  let draftGate = null
  members.scribe = async ({ mcp }) => { if (draftGate) await draftGate; return bridge(mcp).call('stage_result', { result: { text: 'a fresh draft' } }) }
  const pack = { ...notes, actions: { ...notes.actions, async decision(c) { if (delayed.has(c.approval.id)) await delayed.get(c.approval.id); return actions.decision(c) } } }
  const cases = [
    ['resume', 'accept'], ['goOn', 'revise'], ['continue', 'pending'], ['rewind', 'rejected'],
    ['goOn', 'failed'], ['resume', 'late success'], ['resume', 'late failure'],
  ]
  const before = createWorkbench(makeCtx(), { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  provided.ruyixWorkbench.registerPack(pack)
  const runs = []
  for (const [route, answer] of cases) {
    const r = (await op('startRun', { workflow: 'notes.publish', title: `new intent ${route} ${answer}`, fields: { channel: 'blog' } })).run
    const card = await until('old draft to await sign-off', () => before.engine.get(r.id).status === 'waiting' && before.store.list('approval').find(a => a.runId === r.id && a.action === 'decision' && a.status === 'pending'))
    runs.push({ id: r.id, route, answer, card })
  }
  for (const d of disposers.splice(0)) d?.()
  const after = createWorkbench(makeCtx(), { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  provided.ruyixWorkbench.registerPack(pack)
  for (const { id, route, answer, card } of runs) {
    assert.equal(after.engine.get(id).status, 'interrupted')
    let settleAction, releaseDraft, approval
    if (answer.startsWith('late')) {
      delayed.set(card.id, new Promise((resolve, reject) => { settleAction = answer === 'late success' ? resolve : () => reject(new Error('late decision action failed')) }))
      approval = after.engine.approve(card.id, { choice: 0 })
      assert.equal(after.store.get('approval', card.id).status, 'running')
      draftGate = new Promise(resolve => { releaseDraft = resolve })
    } else if (answer === 'rejected') after.engine.reject(card.id, 'old rejection')
    else if (answer !== 'pending') await after.engine.approve(card.id, { choice: answer === 'accept' ? 0 : answer === 'revise' ? 1 : 99 })
    // Scope: earlier steps, already consumed cards, other actions and other runs must remain untouched.
    const earlier = after.engine.addApproval(id, { action: 'decision', title: 'Earlier intent', payload: { stage: 'intake', options: [{ label: 'Keep', action: 'accept' }] } })
    const consumed = after.store.put('approval', { ...card, id: `${card.id}-consumed`, status: 'done', applied: true, result: { option: { action: 'accept' }, applied: true } })
    const help = after.engine.addApproval(id, { action: 'help', title: 'Separate question', payload: { stage: 'sign-off' } })
    const other = runs.find(x => x.id !== id && after.engine.get(x.id).status === 'interrupted')
    const otherCard = other && after.store.get('approval', other.card.id)
    assert.throws(() => after.engine.resumeRun(id, { from: 'missing' }), /no step/)
    assert.notEqual(after.store.get('approval', card.id).status, 'superseded', 'invalid requests do not retire intent')
    if (route === 'resume') after.engine.resumeRun(id, { from: 'draft' })
    else if (route === 'goOn') after.engine.goOn(id, 'draft')
    else if (route === 'continue') await after.engine.continueRun(id, { from: 'draft', note: 'New instructions replace the old answer' })
    else await after.engine.rewindRun(id, { from: 'draft' })
    if (settleAction) {
      settleAction()
      const late = await approval
      assert.equal(late.status, 'superseded', 'a late action cannot resurrect a retired card')
      releaseDraft()
      draftGate = null
    }
    const fresh = await until('new sign-off without consuming the old answer', () => after.store.list('approval').find(a => a.runId === id && a.id !== card.id && a.action === 'decision' && a.payload?.stage === 'sign-off' && a.status === 'pending'))
    const retired = after.store.get('approval', card.id)
    assert.deepEqual([retired.status, retired.applied, retired.supersededByRestart], ['superseded', true, 'draft'], `${route}: ${answer}`)
    if (retired.result) assert.equal(retired.result.applied, true)
    assert.equal(after.store.evidence(id).filter(e => e.input?.approval === card.id && /superseded by restarting/.test(e.title)).length, 1, 'retirement is recorded once')
    assert.deepEqual(after.store.get('approval', earlier.id), earlier)
    assert.deepEqual(after.store.get('approval', consumed.id), consumed)
    assert.deepEqual(after.store.get('approval', help.id), help)
    if (otherCard) assert.deepEqual(after.store.get('approval', otherCard.id), otherCard)
    assert.equal(after.engine.get(id).decisions, undefined, 'the old intent did not decide anything about the new draft')
    assert.equal(after.store.list('approval').some(a => a.runId === id && a.action === 'fake_publish'), false, 'a new draft cannot reach the output action without its own decision')
    assert.equal(after.store.get('approval', fresh.id).status, 'pending')
    assert.ok(after.store.verify(id).ok)
    after.engine.stopRun(id)
    await until('new attempt stopped', () => after.engine.get(id).status === 'cancelled' && !after.engine.active(id))
  }
  for (const d of disposers.splice(0)) d?.()
}

{
  // a step that waits for the person when dsh goes down waits again for the same card after the restart: it is not run again
  let tries = 0
  const wb1 = createWorkbench(makeCtx(), { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  members.dshy = ({ mcp }) => { tries++; return bridge(mcp).call('stage_result', { result: { ok: false, summary: 'no access to the host' } }) }
  const r = (await op('startRun', { workflow: 'stucks', title: 'Stuck over a restart', text: 'x' })).run
  const card = await until('the person is asked', () => wb1.store.list('approval').find(a => a.runId === r.id && a.action === 'help' && a.status === 'pending'))
  await until('the run waits', () => wb1.engine.get(r.id).waiting === 'person')
  for (const d of disposers.splice(0)) d?.() // dsh goes down
  const wbn = createWorkbench(makeCtx(), { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  assert.equal(wbn.engine.get(r.id).status, 'interrupted')
  assert.equal(wbn.store.get('approval', card.id).status, 'pending', 'the card outlives the restart')
  wbn.engine.resumeRun(r.id)
  await until('it waits again', () => wbn.engine.get(r.id).waiting === 'person' && wbn.engine.get(r.id).status === 'waiting')
  assert.equal(tries, 1, 'the step was not run again')
  assert.deepEqual([wbn.engine.get(r.id).waitingFor, wbn.engine.get(r.id).stages.find(s => s.key === 'look').status], [card.id, 'running'])
  assert.equal(wbn.store.list('approval').filter(a => a.runId === r.id && a.action === 'help').length, 1, 'the same card, not a new one')
  await op('approve', { id: card.id, payload: { answer: 'stop', input: 'after the restart' } })
  const end = await until('the run ends', () => ['done', 'failed', 'cancelled'].includes(wbn.engine.get(r.id).status) && !wbn.engine.active(r.id) && wbn.engine.get(r.id))
  assert.deepEqual([end.status, end.verdict.stopped, tries], ['failed', 'look', 1])
  assert.equal(end.stages.find(s => s.key === 'look').note, 'stopped by the person: after the restart')
  wbn.engine.dispose()
  for (const d of disposers.splice(0)) d?.()
}

// ── script steps (lib/flow): a step's JavaScript drives agents, commands and people through steps kept on the run ──
{
  const wbf = createWorkbench(makeCtx(), { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  const end = id => until(`run ${id} to end`, () => { const r = wbf.engine.get(id); return ['done', 'failed', 'cancelled'].includes(r.status) && !wbf.engine.active(id) && r })
  const cards = (id, action) => wbf.store.list('approval').filter(x => x.runId === id && x.action === action).sort((p, q) => p.createdAt - q.createdAt)
  const pending = (id, action, n) => until('the person is asked', () => { const c = cards(id, action)[n]; return c?.status === 'pending' && c })
  const briefs = []
  members.scribe = async ({ task, mcp }) => {
    briefs.push(task)
    return bridge(mcp).call('stage_result', { result: { ok: true, summary: `plan ${briefs.length}`, findings: [] } })
  }
  const source = [
    "const plan = await wf.step('plan', s => s.agent('coder', 'Plan the work.'))",
    "await wf.step('build', s => s.sh('echo built >> built.txt && test -f go'))",
    "const who = await wf.step('who', s => s.ask('Which colour?'))",
    "const pick = await wf.step('pick', s => s.ask('Ship it?', { options: ['Ship', 'Wait'] }))",
    "await wf.step('note', s => s.evidence('result', { plan: plan.summary, who: who.input, pick: pick.choice }))",
    "return { summary: 'done: ' + who.input + ' / ' + pick.choice + ' / ' + wf.params.tries + ' / ' + wf.input.request.title }",
  ].join('\n')
  const drive = (extra = {}) => ({ id: 'drive', use: 'flow', title: 'Drive', source, agents: { coder: { agent: 'scribe', access: 'read' } }, params: { tries: { title: 'Tries', default: 3 } }, ...extra })
  assert.deepEqual((await save({ id: 'driven', title: 'Driven', base: 'blank', steps: [{ use: 'intake' }, drive(), { use: 'report' }] })).errors, [])

  // a step that fails ends the script, and the run (its "on failure"); the steps before it are kept on the run
  const r1 = (await op('startRun', { workflow: 'driven', title: 'Colours', text: 'x', params: { drive: { tries: 5 }, other: { tries: 9 } } })).run
  assert.deepEqual(r1.params, { drive: { tries: 5 }, other: { tries: 9 } }, 'the run keeps the parameters it was given')
  const f1 = await end(r1.id)
  assert.equal(f1.status, 'failed', JSON.stringify(f1.stages))
  assert.match(f1.stages.find(s => s.key === 'drive').note, /step build#1 failed: exit 1/)
  assert.deepEqual(wbf.engine.get(r1.id).stages.find(s => s.key === 'drive').flow.steps.map(x => [x.title, x.status]), [['plan', 'passed'], ['build', 'failed']])
  assert.ok(hub.started.some(j => j.agents.includes('scribe') && /Colours/.test(j.title)), 'the agent a script asks is checked before the run starts')
  assert.match(briefs[0], /Your task\nPlan the work\./)
  assert.equal(briefs.length, 1)

  // the cause is gone: the run goes on from the first step not done — the agent is not asked again
  writeFileSync(join(f1.dir, 'go'), '')
  wbf.engine.resumeRun(r1.id)
  const askWho = await pending(r1.id, 'help', 0)
  assert.deepEqual([askWho.payload.kind, askWho.title, briefs.length], ['input', 'Which colour?', 1], 'the planning step answered from the record')
  assert.deepEqual(wbf.engine.get(r1.id).stages.find(s => s.key === 'drive').flow.steps.map(x => [x.title, x.status, x.replays]), [['plan', 'passed', 1], ['build', 'passed', 0], ['who', 'running', 0]])
  assert.equal(wbf.engine.get(r1.id).status, 'waiting')
  await assert.rejects(op('approve', { id: askWho.id, payload: { answer: 'continue' } }), /write the answer first/)
  await op('approve', { id: askWho.id, payload: { answer: 'continue', input: 'blue' } })
  const askPick = await pending(r1.id, 'decision', 0)
  assert.deepEqual([askPick.payload.options.map(o => o.label), askPick.payload.blocking, askPick.payload.stage], [['Ship', 'Wait', 'Stop the run'], true, 'drive'])
  await op('approve', { id: askPick.id, payload: { choice: 0 } })
  const done1 = await end(r1.id)
  assert.equal(done1.status, 'done', JSON.stringify(done1.stages))
  assert.equal(done1.outputs.drive.summary, 'done: blue / Ship / 5 / Colours', 'the answers, the run\'s parameter and the request reach the script')
  assert.deepEqual([readFileSync(join(done1.dir, 'built.txt'), 'utf8'), briefs.length, done1.flows.drive.status], ['built\nbuilt\n', 1, 'done'], 'the interrupted step ran again, the done one did not')
  assert.ok(wbf.store.evidence(r1.id).some(e => e.kind === 'note' && e.actor === 'workflow' && /result/.test(e.title)))
  assert.ok(wbf.store.evidence(r1.id).some(e => e.kind === 'command' && /Drive · build#1: echo built/.test(e.title)))
  assert.match(await wbf.service.report(r1.id), /\| drive \| system \| passed/)
  assert.deepEqual(done1.guidance.map(g => [g.from, g.text]), [['drive', 'Drive: blue']], 'what the person typed is heard by the later steps')
  assert.ok(wbf.store.verify(r1.id).ok)
  // run again by choice from the step: its kept steps start over
  wbf.engine.resumeRun(r1.id, { from: 'drive' })
  assert.equal(wbf.engine.get(r1.id).flows?.drive, undefined, 'a step run again by choice drops its journal')
  wbf.engine.stopRun(r1.id)
  await end(r1.id)

  // a person's stop in a card ends the script at once: no step after it
  const r2 = (await op('startRun', { workflow: 'driven', title: 'Stopped', text: 'x' })).run
  await until('the build step failed', () => wbf.engine.get(r2.id).status === 'failed')
  writeFileSync(join(wbf.engine.get(r2.id).dir, 'go'), '')
  wbf.engine.resumeRun(r2.id)
  await op('approve', { id: (await pending(r2.id, 'help', 0)).id, payload: { answer: 'stop', input: 'not today' } })
  const s2 = await end(r2.id)
  assert.deepEqual([s2.status, s2.verdict.level, /a person stopped the run/.test(s2.stages.find(s => s.key === 'drive').note), s2.flows.drive.steps['pick#1']], ['failed', 'failed', true, undefined])

  // an agent's blocking decision inside a script: the script waits for the person before its next step
  members.scribe = async ({ mcp }) => {
    const a = bridge(mcp)
    await a.call('decision_needed', { question: 'Keep going?', why: 'only you know (#1)', options: [{ label: 'Keep going', does: 'on', action: 'accept' }, { label: 'Redo', does: 'again', action: 'revise', from: 'intake' }], blocking: true })
    return a.call('stage_result', { result: { ok: true, summary: 'asked', findings: [] } })
  }
  const waitSrc = "await wf.step('think', s => s.agent('coder', 'Decide.'))\nawait wf.step('after', s => s.sh('echo after > after.txt'))\nreturn 'ok'"
  await save({ id: 'driven-wait', title: 'Driven, waits', base: 'blank', steps: [{ use: 'intake' }, drive({ id: 'think', source: waitSrc, params: {} }), { use: 'report' }] })
  const r3 = (await op('startRun', { workflow: 'driven-wait', title: 'Waits', text: 'x' })).run
  const d3 = await until('the decision is asked', () => cards(r3.id, 'decision').find(c => c.status === 'pending'))
  await sleep(150)
  assert.deepEqual([wbf.engine.get(r3.id).status, existsSync(join(wbf.engine.get(r3.id).dir, 'after.txt'))], ['waiting', false], 'the next step waits for the answer')
  await op('approve', { id: d3.id, payload: { choice: 0 } })
  const e3 = await end(r3.id)
  assert.deepEqual([e3.status, existsSync(join(e3.dir, 'after.txt'))], ['done', true])
  // …and a decision that sends the run back ends the script there (no step after it), the run goes back to the step named
  const r4 = (await op('startRun', { workflow: 'driven-wait', title: 'Back', text: 'x' })).run
  const d4 = await until('the decision is asked', () => cards(r4.id, 'decision').find(c => c.status === 'pending'))
  members.scribe = async ({ mcp }) => bridge(mcp).call('stage_result', { result: { ok: true, summary: 'second time', findings: [] } })
  await op('approve', { id: d4.id, payload: { choice: 1 } })
  const e4 = await end(r4.id)
  assert.equal(e4.status, 'done', JSON.stringify(e4.stages))
  assert.deepEqual([e4.stages.find(s => s.key === 'intake').attempt, e4.stages.find(s => s.key === 'think').attempt], [2, 2], 'back to intake: the script step ran again from the top')
  assert.ok(e4.decisions.some(d => d.label === 'Redo'))

  // readiness: the agent a script asks and the scripts it runs are needs of the step
  const ready = await op('workflowReadiness', { id: 'driven' })
  assert.deepEqual(ready.steps.find(s => s.id === 'drive').items.map(i => `${i.kind}:${i.ref}:${i.status}`), ['agent:scribe:ok'])
  // what the assistant tries before it saves: nothing is asked or run, the answers can be given
  const tried = await wbf.ops.workflowTry({ source, params: { tries: 2 }, answers: { plan: { ok: false, summary: 'no' }, build: { code: 1, stdout: '', stderr: 'broken' } } })
  assert.deepEqual([tried.ok, /step build#1 failed: exit 1: broken/.test(tried.broke), tried.steps.map(x => [x.title, x.status])], [false, true, [['plan', 'passed'], ['build', 'failed']]])
  const ran = await wbf.ops.workflowTry({ source: "const a = await wf.step('a', s => s.ask('Which?', { options: ['X', 'Y'] }))\nreturn { picked: a.choice, tries: wf.params.tries }", params: { tries: 2 } })
  assert.deepEqual([ran.ok, ran.value, (await wbf.ops.workflowTry({ source: 'return 1' })).errors.length], [true, { picked: 'X', tries: 2 }, 1])
  wbf.engine.dispose()
  for (const d of disposers.splice(0)) d?.()
}

// ── a script step whose script spins after an await is stopped when it has been silent past the agent timeout (here 700 ms) ──
{
  const wbs = createWorkbench(makeCtx(), { toolbox: null, engineOptions: { settleMs: 20, resumeDelayMs: 1e9, timeoutMs: 700 } })
  const end = id => until(`run ${id} to end`, () => { const r = wbs.engine.get(id); return ['done', 'failed', 'cancelled'].includes(r.status) && !wbs.engine.active(id) && r }, 15000)
  assert.deepEqual((await save({ id: 'spinner', title: 'Spinner', base: 'blank', steps: [{ use: 'intake' }, { id: 'spin', use: 'flow', title: 'Spin', source: "await wf.step('first', s => s.now())\nawait wf.now()\nfor (;;) {}" }, { use: 'report' }] })).errors, [])
  const t0 = Date.now()
  const r = await end((await op('startRun', { workflow: 'spinner', title: 'spin' })).run.id)
  assert.equal(r.status, 'failed', JSON.stringify(r.stages))
  assert.match(r.stages.find(s => s.key === 'spin').note, /^the script('s thread did not answer for| asked for nothing for) \d+ seconds? .*loop that never ends/)
  assert.ok(Date.now() - t0 < 12000, 'stopped by the host, not left spinning')
  assert.equal(wbs.engine.get(r.id).flows.spin.status, 'failed')
  wbs.engine.dispose()
  for (const d of disposers.splice(0)) d?.()
}

// ── a step's command-line tools (lib/toolbox.js): put in place before it runs; one only a person can install stops it,
// saying how; an agent can ask for one (tools_ensure); the readiness and the report tell ──
{
  const asked = []
  const how = { kind: 'unknown', bin: 'gone', text: 'Not a tool mise installs: install it with this machine\'s package manager so `which gone` finds it.', cmd: 'brew install gone' }
  // (what the real toolbox gives a step's processes once something is installed: its directory first on the PATH, and nothing in dsh's own)
  let toolsEnv = {}
  const toolbox = {
    ready: Promise.resolve(), refresh: async () => [], activation: () => 'export PATH=/t/bin:"$PATH"', env: () => toolsEnv,
    // (what a run would do: `gone` is tried and cannot be had, `later` is installed, `nope` only a person can)
    check: async list => list.map(ref => (ref === 'nope' ? { ref, status: 'missing', how: { ...how, bin: 'nope', cmd: 'brew install nope' } } : ['gone', 'later'].includes(ref) ? { ref, status: 'fetch' } : { ref, status: 'ok' })),
    need: async want => { asked.push(want); return want === 'gone' ? { want, bin: want, status: 'missing', how } : ['later', 'shellcheck'].includes(want) ? { want, bin: want, status: 'installed', version: '0.11.0', path: `/t/bin/${want}` } : { want, bin: want, status: 'ok', path: `/usr/bin/${want}` } },
  }
  const wbc = createWorkbench(makeCtx(), { toolbox, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
  const end = id => until(`run ${id} to end`, () => { const r = wbc.engine.get(id); return ['done', 'failed', 'cancelled'].includes(r.status) && !wbc.engine.active(id) && r })
  const run = (workflow, title = workflow) => op('startRun', { workflow, title }).then(x => end(x.run.id))
  const lint = (extra = {}) => ({ id: 'lint', use: 'script', title: 'Lint', run: 'echo ran > lint.out', cli: ['jq', 'gone'], ...extra })

  // a tool that cannot be had stops the step, whose script does not run; the ledger and the report say how a person does it
  assert.deepEqual((await save({ id: 'tooled', title: 'Tooled', base: 'blank', steps: [{ use: 'intake' }, lint(), { use: 'report' }] })).errors, [])
  const r1 = await run('tooled')
  assert.deepEqual([r1.status, asked], ['failed', ['jq', 'gone']])
  assert.match(r1.stages.find(s => s.key === 'lint').note, /^missing tools: gone is not installed — Not a tool mise installs: .*\(`brew install gone`\)/)
  assert.equal(existsSync(join(r1.dir, 'lint.out')), false, 'the script did not run')
  assert.deepEqual(r1.tools.map(t => [t.name, t.stage, t.status, t.by, t.how?.cmd]), [['gone', 'lint', 'missing', 'step', 'brew install gone']])
  const tl = wbc.store.evidence(r1.id).find(e => e.kind === 'tool')
  assert.deepEqual([tl.stage, tl.ok, /^tool gone: missing/.test(tl.title), tl.output.endsWith('brew install gone')], ['lint', false, true, true])
  assert.match(await wbc.service.report(r1.id), /## Command-line tools\n- ✗ `gone` missing \(lint\) — Not a tool mise installs.*`brew install gone`/)
  // its "on failure" decides what comes next, as for any failed step
  await save({ id: 'tooled-go', title: 'Tooled, goes on', base: 'blank', steps: [{ use: 'intake' }, lint({ onFail: 'continue' }), { id: 'after', use: 'script', title: 'After', run: 'echo after > after.out' }, { use: 'report' }] })
  const r2 = await run('tooled-go')
  assert.deepEqual([r2.status, r2.stages.find(s => s.key === 'lint').status, existsSync(join(r2.dir, 'after.out'))], ['done', 'failed', true])

  // tools put in place before the step; its login shell gets them first on the PATH again; the report says what was installed.
  // They are in the environment of the step's own commands only: dsh's own PATH stays as it was, so what was installed never shadows
  // a command dsh runs itself (a stand-in `git` here)
  const was = [process.env.RUYIX_TOOLS_PATH, process.env.PATH]
  const toolBin = join(tmp, 'tool-bin')
  mkdirSync(toolBin, { recursive: true })
  writeFileSync(join(toolBin, 'git'), '#!/bin/sh\necho shadowed\n', { mode: 0o755 })
  toolsEnv = { PATH: `${toolBin}:${process.env.PATH}`, RUYIX_TOOLS_PATH: toolBin }
  try {
    await save({ id: 'tooled-ok', title: 'Tooled ok', base: 'blank', steps: [{ use: 'intake' }, lint({ run: 'echo "$PATH" > path.out; git --version > git.out; echo "$RUYIX_TOOLS_PATH" > tools.out', cli: ['jq', 'later'] }), { use: 'report' }] })
    const r3 = await run('tooled-ok')
    assert.equal(r3.status, 'done', JSON.stringify(r3.stages))
    assert.ok(readFileSync(join(r3.dir, 'path.out'), 'utf8').startsWith(`${toolsEnv.PATH}:`), 'the PATH its commands were started with comes first, after the login profile')
    assert.deepEqual([readFileSync(join(r3.dir, 'git.out'), 'utf8'), readFileSync(join(r3.dir, 'tools.out'), 'utf8')], ['shadowed\n', `${toolBin}\n`], 'the step finds what was installed')
    assert.deepEqual([process.env.RUYIX_TOOLS_PATH, process.env.PATH], was, 'dsh\'s own PATH and environment are what they were')
    assert.notEqual(execFileSync('git', ['--version']).toString().trim(), 'shadowed', 'a command dsh runs itself does not find it')
    assert.deepEqual(r3.tools.map(t => [t.name, t.status, t.version]), [['later', 'installed', '0.11.0']], 'one that was there already is not noted')
    assert.match(await wbc.service.report(r3.id), /- ✓ `later` 0\.11\.0 installed for lint\n/)
    assert.deepEqual((await op('workflowEnsure', { id: 'tooled-ok' })).fetched, ['later'], 'the editor installs what a run would')
    assert.deepEqual((await op('workflowEnsure', { id: 'tooled' })).failed.map(f => f.id), ['gone'])
  } finally { [process.env.RUYIX_TOOLS_PATH, process.env.PATH] = was; if (was[0] === undefined) delete process.env.RUYIX_TOOLS_PATH }

  // readiness: here / installed on the first run (fetch) / only a person (missing, with how: the run does not start)
  const ready = await op('workflowReadiness', { id: 'tooled' })
  assert.deepEqual(ready.steps.find(s => s.id === 'lint').items.map(i => `${i.kind}:${i.ref}:${i.status}`), ['tool:jq:ok', 'tool:gone:fetch'])
  await save({ id: 'tooled-hard', title: 'Tooled hard', base: 'blank', steps: [{ use: 'intake' }, lint({ cli: ['nope'] }), { use: 'report' }] })
  const hard = await op('workflowReadiness', { id: 'tooled-hard' })
  assert.deepEqual([hard.missing, hard.steps.find(s => s.id === 'lint').items[0].how.cmd], [1, 'brew install nope'])
  await assert.rejects(op('startRun', { workflow: 'tooled-hard', title: 'x' }), /not ready here — missing: tool nope at lint/)

  // an agent asks for a tool mid-run (tools_ensure): installed, or not available with how; the step's own list is in its brief.
  // Only an agent that may change files has it, and only for a registry name: never an explicit backend (npm:, pipx:, github: …)
  const briefs = []
  members.sonnet = async ({ task, mcp }) => {
    briefs.push(task)
    const a = bridge(mcp)
    assert.ok((await a.tools()).some(t => t.name === 'tools_ensure'), 'a step that may write has it')
    assert.match(await a.call('tools_ensure', { tool: 'shellcheck' }), /^shellcheck: installed 0\.11\.0 — \/t\/bin\/shellcheck\..*\nexport PATH=\/t\/bin:"\$PATH"$/s)
    assert.match(await a.call('tools_ensure', { tool: 'gone' }), /^gone is not available here\. Not a tool mise installs.* A person runs: brew install gone\n/)
    assert.match(await a.call('tools_ensure', { tool: 'jq' }), /^jq: already here — \/usr\/bin\/jq/)
    const asked0 = asked.length
    for (const bad of ['npm:left-pad', 'pipx:bandit', 'github:o/r', 'ubi:o/r', 'cargo:x', 'go:x', 'aqua:o/r', 'http:example.com/x', 'o/r', 'a;b']) {
      await assert.rejects(a.call('tools_ensure', { tool: bad }), /not a name from mise's registry/, bad)
    }
    assert.equal(asked.length, asked0, 'an explicit backend never reaches the toolbox')
    return a.call('stage_result', { result: { ok: true, summary: 'checked' } })
  }
  await save({ id: 'tooled-agent', title: 'Tooled agent', base: 'blank', steps: [{ use: 'intake' }, agentStep('look', { cli: ['shellcheck'], agent: 'sonnet', access: 'write' }), { use: 'report' }] })
  toolsEnv = { PATH: `${toolBin}:${process.env.PATH}`, RUYIX_TOOLS_PATH: toolBin }
  const r4 = await run('tooled-agent')
  assert.equal(r4.status, 'done', JSON.stringify(r4.stages))
  assert.match(briefs[0], /Command-line tools put in place for this step: shellcheck\. Another one you need: tools_ensure/)
  assert.deepEqual(r4.tools.map(t => [t.name, t.status, t.by]).sort(), [['gone', 'missing', 'agent'], ['jq', 'ok', 'agent'], ['shellcheck', 'installed', 'agent']])
  assert.deepEqual([...tasks.values()].filter(t => t.agent === 'sonnet').at(-1).env, toolsEnv, 'a CLI agent starts with the tools\' directory in its own environment')
  // a read-only step's agent has no tools_ensure, and a call is refused; a dsh agent (it has no environment of its own) is given no env
  members.sonnet = async ({ mcp }) => {
    const a = bridge(mcp)
    assert.ok(!(await a.tools()).some(t => t.name === 'tools_ensure'), 'a read-only reviewer is not given it')
    await assert.rejects(a.call('tools_ensure', { tool: 'shellcheck' }), /not a tool of the step/)
    return a.call('stage_result', { result: { ok: true, summary: 'read only' } })
  }
  const askedBefore = asked.length
  await save({ id: 'tooled-peek', title: 'Tooled peek', base: 'blank', steps: [{ use: 'intake' }, agentStep('peek', { agent: 'sonnet', access: 'read' }), { use: 'report' }] })
  assert.equal((await run('tooled-peek')).status, 'done')
  assert.equal(asked.length, askedBefore, 'nothing was asked of the toolbox')
  members.scribe = ({ mcp }) => bridge(mcp).call('stage_result', { result: { ok: true, summary: 'in process' } })
  await save({ id: 'tooled-dsh', title: 'Tooled dsh', base: 'blank', steps: [{ use: 'intake' }, agentStep('inproc', { access: 'write' }), { use: 'report' }] })
  assert.equal((await run('tooled-dsh')).status, 'done')
  assert.equal([...tasks.values()].filter(t => t.agent === 'scribe').at(-1).env, undefined)
  toolsEnv = {}
  // …and the editor is offered the ones the step does not list yet
  const sug = (await op('workflowReadiness', { id: 'tooled-agent' })).steps.find(s => s.id === 'look').items
  assert.deepEqual(sug.filter(i => i.kind === 'tool').map(i => `${i.ref}:${i.status}`), ['shellcheck:ok', 'gone:suggested', 'jq:suggested'])
  assert.ok(wbc.store.verify(r4.id).ok)
  wbc.engine.dispose()
  for (const d of disposers.splice(0)) d?.()
}

// the tools' bridge on a Unix socket (a TCP port listen(0) is given in a microVM may refuse connections)
{
  const { createServer: mk } = await import('node:http')
  const dir = mkdtempSync(join(tmpdir(), 'ruyixwb-check-')), sock = join(dir, 'tools.sock')
  const srv = mk((req, res) => { let b = ''; req.on('data', c => { b += c }).on('end', () => {
    res.writeHead(req.headers.authorization === 'Bearer T' ? 200 : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.headers.authorization !== 'Bearer T' ? { error: 'bad token' } : req.url === '/tools' ? { tools: [{ name: 'evidence_add', description: 'd', parameters: {} }] } : { text: `called ${JSON.parse(b).name}` }))
  }) })
  await new Promise(ok => srv.listen(sock, ok))
  try {
    assert.equal((await toolsPost(`unix:${sock}`, 'T', '/tools', {})).tools[0].name, 'evidence_add')
    await assert.rejects(toolsPost(`unix:${sock}`, 'X', '/tools', {}), /bad token/)
    await assert.rejects(toolsPost(`unix:${join(dir, 'none.sock')}`, 'T', '/tools', {}), /ENOENT|ECONNREFUSED/)
    // a call as long as it takes (timeout 0): past the 5 s an HTTP agent's keep-alive would allow
    const slow = mk((req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"text":"done"}') }, 5500)), slowSock = join(dir, 'slow.sock')
    await new Promise(ok => slow.listen(slowSock, ok))
    try { assert.equal((await toolsPost(`unix:${slowSock}`, 'T', '/call', {}, { timeout: 0 })).text, 'done') } finally { slow.close() }
    // the agent's MCP server, as Claude Code / Codex start it: tools/list and a call through the socket
    const stdio2 = await stdio({ command: process.execPath, args: [join(here, 'lib', 'mcp-server.mjs')], env: { RUYIXWB_URL: `unix:${sock}`, RUYIXWB_TOKEN: 'T', RUYIXWB_NAME: 'wb' } })
    try {
      assert.equal((await stdio2.rpc('tools/list')).result.tools[0].name, 'evidence_add')
      assert.equal(await stdio2.call('evidence_add', {}), 'called evidence_add')
    } finally { stdio2.close() }
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }) }
}



// Revising one chat task never captures an unrelated request while dsh admits the revision prompt.
{
  const effects = [], routes = {}, localHub = { ...hub, mainAgent: () => null, mainChosen: () => false, defaultAgent: () => null }
  let block = false, release
  const ctx = makeCtx({}, effects, {})
  const revisionCtx = { ...ctx, provide() {}, on() {},
    effect: fn => effects.push(fn()),
    inject: (deps, cb) => cb({ ...Object.fromEntries(deps.map(d => [d, { agentHub: localHub, connectors: conns, ruyixShell: fakeShell, ruyixBrowser: sharedBrowserSvc, ruyixStudio: fakeStudio }[d]])), effect: fn => effects.push(fn()) }),
    connection: { fetch: { register: r => { routes[r.path] = r } } },
    sessionController: { ...fakeSc, prompt: async () => { if (block) { block = false; await new Promise(r => { release = r }) } } },
  }
  const child = createWorkbench(revisionCtx, { home: mkdtempSync(join(tmpdir(), 'ruyix-revise-owner-')), toolbox: null, now: () => clock })
  try {
    const initial = await child.ops.chatSend({ text: 'Write a draft article', lang: 'en' })
    const original = (await child.ops.chat({})).asks.find(a => a.id === initial.ask), id = original.task
    child.service.tasks.update(id, { state: 'to-confirm' })
    block = true
    const revision = child.ops.taskRevise({ id, text: 'make it shorter' })
    await until('revision prompt is awaiting admission', () => release)
    const unrelated = child.ops.chatSend({ text: 'What is the weather tomorrow?', via: 'voice', lang: 'en' })
    const results = Promise.all([revision, unrelated]); release(); const [, answer] = await results
    const asks = (await child.ops.chat({})).asks, other = asks.find(a => a.id === answer.ask)
    assert.notEqual(other.task, id, 'an independent surface request makes its own task')
    assert.match(asks.find(a => a.id === initial.ask).followUp, /make it shorter/, 'the requested revision is not overwritten')
  } finally { release?.(); for (const effect of effects.reverse()) if (typeof effect === 'function') await effect() }
}

// what the engine logged is what the steps above made fail on purpose
assert.ok(warns.length && warns.every(w => /did not hand back a stage result|exit 1|bash|the workbench's tools do not answer|only's task \S+ failed: Error: boom|needs the agents' browser/.test(w)), warns.join('\n'))
rmSync(tmp, { recursive: true, force: true })
console.log('workbench check: ok')
