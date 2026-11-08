// The Ruyix workbench: runs workflows as evidence-backed pipelines. One plugin; the domains plug in as packs.
// - engine (lib/engine.js) drives a workflow step by step (the core's `blank`, a pack's, a person's own on one of them);
// - Agent Hub (the `agentHub` service) supplies the agents: one headless job per run, one task per step;
// - the same tools reach dsh agents (registered on the run's child agents) and Claude Code / Codex agents
//   (lib/mcp-server.mjs → a Unix-socket endpoint here, one token per step);
// - store (lib/store.js): runs, approvals and the hash-chained evidence ledger, the standing conversation's record;
// - the standing conversation (lib/assistant.js): one kept thread with the person, on dsh or a pool agent (the shell's
//   chat sheet and the Chat page read and send through the `chat*` ops);
// - what a workflow needs (lib/needs.js): readiness before a run starts, this machine's bindings, pinned skill packs;
// - the AI work done here (lib/aiwork.js): Agent Hub's tasks, the runs' steps and the model calls the workbench makes
//   itself (ai-calls.jsonl) — the service's and the shell part's aiWork;
// - packs (pack.js) join through the `ruyixWorkbench` service: registerPack(pack) → off().
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiWork, callLog } from './lib/aiwork.js'
import { askScope, setupAssistant } from './lib/assistant.js'
import { DONE, createEngine } from './lib/engine.js'
import { jobRecord, recordsOf, resultWords, runRecord, sessionRecord } from './lib/records.js'
import { changedFiles } from './lib/folder.js'
import { renderFile } from './lib/versions.js'
import { createTasks } from './lib/tasks.js'
import { createUsageHours } from './lib/usage-hours.js'
import { createBrowsers } from './lib/browser.js'
import { fileResponse, homeEntry } from './lib/file.js'
import { HOME, defaultsOf, loadSettings, saveSettings, settingsFile, sh } from './lib/settings.js'
import { toolsPost } from './lib/mcp-client.mjs'
import { openConversations } from './lib/conversations.js'
import { openStore, sha256 } from './lib/store.js'
import { SKILL_PACK as MESSAGES_SKILLS, createRunMessages, messagesOn } from './lib/messages.js'
import { mergeComments, revisionStep, revisionSteps, workPath } from './lib/review.js'
import { commentsNote, resultFiles } from './lib/results.js'
import { pageOf } from './lib/pages.js'
import { BODY_MAX, TOOLS, callTool, toolDefs } from './lib/tools.js'
import { LANGS, createTranslator } from './lib/translate.js'
import { createModels, parseModelRef } from './lib/models.js'
import { GENERIC, compose, createScripts, createStore as createWorkflowStore, flatSteps, library, outline, validate as validateWorkflow } from './lib/workflows.js'
import { allSteps, bindingsFile, createBindings, missingText, needsOf, packIdsOf, pinsOf, readiness, skillRefsOf } from './lib/needs.js'
import { createToolbox } from './lib/toolbox.js'
import { checkFlow } from './lib/flow/check.js'
import { guests, runFlow, stepsOf } from './lib/flow/runtime.js'
import { agentUses, modelSteps, skillUses, stepAgents, workflowInfo } from './lib/workflow-info.js'
import { mimeOf } from './lib/subject.js'
import { definePack } from './pack.js'
import blank from './workflows/blank.js'
import task, { agents as taskAgents } from './workflows/task.js'
import { actions as commonActions, renderReport } from './workflows/common.js'

export { definePack }
export const inject = ['connection', 'agents', 'sessionController', 'sessionProjections', 'llm']
const HERE = fileURLToPath(new URL('.', import.meta.url))
const MCP_SCRIPT = join(HERE, 'lib', 'mcp-server.mjs')
const WB_SKILLS = join(HERE, 'skills')
const WB_VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
const MCP_NAME = 'ruyix-workbench'
const PANEL = 'ruyix-workbench'
const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/** Success rate, time and cost per workflow. `successOf(run)`: the verdict level that counts as success for that run. */
export function metrics(store, successOf = () => 'done') {
  const runs = store.list('run')
  const cost = new Map()
  for (const r of runs) {
    let tokens = 0, usd = 0, tasks = 0
    for (const e of store.evidence(r.id)) {
      if (e.kind === 'agent') { tasks++; tokens += e.input?.tokens || 0; usd += e.input?.cost || 0 }
      // a model step's call: its input and output tokens, its cost when the service reports one
      if (e.kind === 'model') { tasks++; tokens += (e.input?.tokens?.input || 0) + (e.input?.tokens?.output || 0); usd += e.input?.cost || 0 }
    }
    cost.set(r.id, { tokens, usd, tasks })
  }
  const group = list => {
    const done = list.filter(r => ['done', 'failed'].includes(r.status) && r.endedAt)
    const verdicts = {}
    for (const r of done) verdicts[r.verdict?.level || r.status] = (verdicts[r.verdict?.level || r.status] || 0) + 1
    const avg = (xs, f) => (xs.length ? xs.reduce((n, x) => n + f(x), 0) / xs.length : null)
    return {
      runs: list.length, finished: done.length, verdicts,
      successRate: done.length ? done.filter(r => r.status === 'done' && r.verdict?.level === successOf(r)).length / done.length : null,
      avgMinutes: avg(done, r => (r.endedAt - r.createdAt) / 60000), avgTokens: avg(done, r => cost.get(r.id).tokens), avgCost: avg(done, r => cost.get(r.id).usd),
    }
  }
  const byTemplate = Object.fromEntries([...new Set(runs.map(r => r.template))].map(t => [t, group(runs.filter(r => r.template === t))]))
  return {
    all: group(runs), byTemplate,
    recent: runs.slice(0, 30).map(r => ({ id: r.id, template: r.template, title: r.subject?.title || '', status: r.status, verdict: r.verdict?.level || null, minutes: r.endedAt ? (r.endedAt - r.createdAt) / 60000 : null, ...cost.get(r.id) })),
  }
}
const textResult = { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value.text }] }
// The loopback body: chunks are joined as bytes before decoding (a multi-byte character may straddle two chunks). The cap is
// file_save's largest file as base64 plus the JSON around it; past it the rest is read and thrown away, so the answer (413)
// reaches a client that is still writing.
/** The errors that say a thing is not there (the API answers them 404). */
const GONE = new Set(['noTask', 'noRun', 'noCard', 'noFile', 'noEvidence'])
const readBody = (req, max = BODY_MAX) => new Promise((resolve, reject) => {
  const parts = []
  let size = 0
  req.on('data', d => { size += d.length; if (size <= max) parts.push(d) })
  req.on('end', () => (size > max ? reject(Object.assign(new Error(`the request is over ${max >> 20} MB`), { status: 413 })) : resolve(Buffer.concat(parts).toString('utf8'))))
  req.on('error', reject)
})
const failWith = (code, params, message) => Object.assign(new Error(message), { code, params })

/**
 * The workbench on a dsh ctx. `home` (default ~/.ruyix/workbench), `store`, `exec` (the command runner), `engineOptions`
 * (settleMs, resumeDelayMs), `toolbox` (default: the home's command-line tools; none: every tool counts as there) are for check.mjs. → the handle the self-check uses: { engine, ops, service, registerPack, server, settings, store, conv }.
 */
// `now`: the conversation's clock (a session lasts while the talk goes on: the check moves it on)
export function createWorkbench(ctx, { home = HOME, store = openStore(home), conv = openConversations(join(home, 'conversations.db')), exec = sh, engineOptions = {}, now = Date.now, toolbox = createToolbox(), browsers: givenBrowsers = null } = {}) {
  const FILE = settingsFile(home)
  mkdirSync(home, { recursive: true })
  const packs = new Map() // id → pack (definePack'd)
  const retiredPacks = new Map() // packs that left: their runs go on with them
  const packOps = new Map() // pack id → { op: fn }
  let service = null
  // the core's own workflows (no pack behind them)
  const CORE = { blank, task }
  const core = () => Object.fromEntries(Object.entries(CORE).map(([id, wf]) => [id, { ...wf, actions: { ...commonActions } }]))
  let live = core() // the workflows a new run may start on, by their global id
  const retired = new Map() // workflows whose pack left: runs that have them go on, no new ones
  let toolTable = []
  let hub = null, conns = null
  // the agents' messages of each run whose workflow lets them talk (lib/messages.js): not the ledger, beside the run's folder
  const messages = createRunMessages(store.dir)

  // ── the packs: their workflows, tools, needs and agents ──
  const list = () => [...packs.values()]
  const packOf = wf => (wf?.pack ? packs.get(wf.pack) ?? retiredPacks.get(wf.pack) ?? null : null)
  const normalize = (p, key, wf) => ({ ...wf, id: `${p.id}.${key}`, localId: key, pack: p.id, noun: wf.noun || 'task', success: wf.success || 'done', roles: wf.roles || {}, report: wf.report || renderReport, actions: { ...commonActions, ...wf.actions, ...p.actions } })
  const rebuild = () => {
    const next = { ...core() }
    for (const p of packs.values()) for (const [key, wf] of Object.entries(p.workflows)) next[`${p.id}.${key}`] = normalize(p, key, wf)
    for (const [id, wf] of Object.entries(live)) if (!next[id]) retired.set(id, wf)
    for (const id of Object.keys(next)) retired.delete(id)
    live = next
    // a pack that came back (or never left) is not retired any more
    for (const id of packs.keys()) retiredPacks.delete(id)
    const own = [...TOOLS, ...messages.tools].map(t => ({ ...t, pack: null })), seen = new Set(own.map(t => t.name))
    const theirs = list().flatMap(p => p.tools.map(t => ({ ...t, pack: p })))
    for (const t of theirs) seen.add(t.name)
    // tools of a pack that left stay for the runs that are using them
    const left = [...retiredPacks.values()].flatMap(p => p.tools.filter(t => !seen.has(t.name)).map(t => ({ ...t, pack: p })))
    toolTable = [...own, ...theirs, ...left]
  }
  const workflowAny = id => live[id] ?? retired.get(id)
  const successOf = r => workflowAny(r.workflowDef?.base ?? r.template)?.success || 'done'
  const toolNames = wf => toolTable.filter(t => !t.pack || t.pack.id === wf.pack).map(t => t.name)
  const packSettings = id => settings().packs?.[id] || {}

  /** What the Agent Hub side holds for each pack (agents, skill packs): added when both are there, taken back when either leaves. */
  const hubOffs = new Map(), connOffs = new Map()
  const hubFor = p => {
    if (!hub) return
    const offs = hubOffs.get(p.id) || []
    hubOffs.set(p.id, offs)
    try {
      if (p.agents.length) hub.ensureAgents?.(p.agents)
      for (const sp of p.skills.packs) offs.push(hub.registerSkillPack?.({ ...sp, by: p.name.en }))
    } catch (err) { ctx.logger?.warn?.(`ruyix-workbench: pack ${p.id} in Agent Hub: ${err?.message || err}`) }
  }
  const connFor = p => {
    if (!conns) return
    const offs = connOffs.get(p.id) || []
    connOffs.set(p.id, offs)
    offs.push(conns.require(p.name.en, () => [...(p.needs(packSettings(p.id)) || []), ...modelNeeds(p)]))
  }
  /** The connections the pack's model steps call (the model each uses now): needs of the pack too. */
  const modelNeeds = p => {
    const s = ownSettings(), seen = new Set()
    return Object.keys(p.workflows).flatMap(k => (live[`${p.id}.${k}`] ? modelSteps(live[`${p.id}.${k}`], s) : [])).flatMap(m => {
      let ref
      try { ref = parseModelRef(m.model) } catch { return [] }
      if (ref.source !== 'connection' || seen.has(ref.connection)) return []
      seen.add(ref.connection)
      return [{ need: `model:${ref.connection}`, type: 'http', connection: ref.connection, label: { en: `Model calls (${ref.model})`, zh: `模型调用（${ref.model}）` } }]
    })
  }
  const dropFor = (map, id) => { for (const off of map.get(id) || []) off?.(); map.delete(id) }

  /**
   * A pack joins (→ off()): its workflows are <id>.<workflow>, its tools join the agents', its actions run on approval,
   * its settings live in settings.packs.<id>. A pack with the same id replaces the one before; off() takes it out
   * (its workflows start no new runs; the runs it has go on). Throws when a tool name is taken.
   */
  function registerPack(input) {
    const p = definePack(input)
    for (const t of p.tools) {
      const owner = TOOLS.some(x => x.name === t.name) ? 'the core' : list().find(x => x.id !== p.id && x.tools.some(y => y.name === t.name))?.name.en
      if (owner) throw new Error(`pack ${p.id}: the tool ${t.name} is already taken by ${owner}`)
    }
    const before = packs.get(p.id)
    if (before) { dropFor(hubOffs, p.id); dropFor(connOffs, p.id); packOps.delete(p.id) }
    packs.set(p.id, p)
    retiredPacks.delete(p.id)
    rebuild()
    hubFor(p)
    connFor(p)
    if (p.ops) packOps.set(p.id, p.ops({ store, engine, settings: () => packSettings(p.id), workbench: service, studio: () => studios, failWith }) || {})
    ctx.logger?.info?.(`ruyix-workbench: pack ${p.id} (${Object.keys(p.workflows).length} workflows, ${p.tools.length} tools)`)
    return () => {
      if (packs.get(p.id) !== p) return
      dropFor(hubOffs, p.id)
      dropFor(connOffs, p.id)
      packOps.delete(p.id)
      packs.delete(p.id)
      retiredPacks.set(p.id, p)
      rebuild()
    }
  }

  // ── settings: the core's and each pack's block; the AI helpers run on Agent Hub's default agent ──
  const ownSettings = () => loadSettings(FILE, list())
  const settingsRevision = s => sha256(JSON.stringify(s))
  const commentsRevision = value => sha256(JSON.stringify(value))
  const workflowView = def => ({ ...def, revision: sha256(JSON.stringify(def)) })
  const reviewView = review => ({ ...review, commentsRevision: commentsRevision([review.round, review.version, review.comments || []]) })
  const resultsRevision = r => commentsRevision([r.results || {}, r.versions || null])
  const aiModel = () => hub?.defaultModel?.() || ''
  const settings = () => {
    const s = ownSettings(), model = aiModel()
    return { ...s, assistantModel: model, translateModel: model }
  }

  // The connectors plugin: every service a pack reaches is a connection there.
  ctx.inject(['connectors'], inner => {
    conns = inner.connectors
    for (const p of list()) connFor(p)
    // the person's enabled workflows: what their steps connect to, as this machine binds it
    const offWf = conns.require('Workbench workflows', () => workflowNeeds())
    queueMicrotask(() => connections().catch(() => {})) // (the bindings are set up below this point)
    inner.effect(() => () => { for (const id of [...connOffs.keys()]) dropFor(connOffs, id); offWf?.(); conns = null }, 'ruyix-workbench: connectors')
  })
  // dsh's PTC runtime: a script step's script runs confined in its process — a read-only sandbox without the home or the
  // environment, an empty folder its root. Without it (or where its sandbox cannot be set up): a worker thread.
  let ptc = null, flowRoot = null
  ctx.inject(['ptcRuntime'], inner => {
    ptc = inner.ptcRuntime
    inner.effect(() => () => { ptc = null }, 'ruyix-workbench: PTC runtime')
  })
  const flowGuest = () => {
    if (!ptc) return { guest: guests.worker() }
    flowRoot ||= mkdtempSync(join(tmpdir(), 'ruyixwb-flow-'))
    return { guest: guests.ptc(ptc, { mode: 'read-only', workspaceRoot: flowRoot }), fallback: guests.worker() }
  }
  // the agents' browser (the apps plugin's): a workflow step with browser: 'shared' takes turns in it
  let sharedBrowser = null
  ctx.inject?.(['ruyixBrowser'], inner => { sharedBrowser = inner.ruyixBrowser; inner.effect(() => () => { sharedBrowser = null }, 'workbench: the agents\' browser') })
  // the studios (docs/design/studio.md; @ruyix/studio): a run starts from one of their records, writes as one of their
  // accounts, and tells them when it ends
  let studios = null
  ctx.inject?.(['ruyixStudio'], inner => { studios = inner.ruyixStudio; inner.effect(() => () => { studios = null }, 'workbench: the studios') })
  ctx.inject(['agentHub'], inner => {
    hub = inner.agentHub
    hub.ensureAgents?.(taskAgents)
    for (const p of list()) hubFor(p)
    const off = []
    // which agent each step uses (shown with each agent; an agent in use is not deleted) and what each skill is used for
    const entries = () => [...Object.values(live)].concat(enabledMine()).map(workflow => ({ workflow, pack: packOf(workflow) }))
    off.push(hub.registerAgentUses?.(() => agentUses(entries(), ownSettings())))
    off.push(hub.registerSkillUses?.(() => skillUses(entries(), ownSettings(), list())))
    // the workbench's own skills (workflow-create: how the assistant writes a workflow)
    off.push(hub.registerSkillPack?.({ id: 'workbench', title: 'Workbench (this package)', dir: WB_SKILLS, version: WB_VERSION, by: 'Workbench' }))
    // how agents message each other (given to every agent step of a workflow that lets them: lib/messages.js)
    off.push(hub.registerSkillPack?.({ ...MESSAGES_SKILLS, version: WB_VERSION, by: 'Workbench' }))
    inner.effect(() => () => { for (const d of off) d?.(); for (const id of [...hubOffs.keys()]) dropFor(hubOffs, id); hub = null }, 'ruyix-workbench: agent hub')
  })

  // The AI work done here (lib/aiwork.js): Agent Hub's tasks, this workbench's runs, and the model calls it makes itself
  // (its model steps, translations, a pack's own calls), which lib/llm.js and lib/models.js report into a log of their own.
  const aiLog = callLog(join(home, 'ai-calls.jsonl'))
  aiLog.prune()
  const onCall = c => aiLog.add(c)
  const aiWorkOf = ({ hours = 24 } = {}) => {
    const until = Date.now(), since = until - Math.min(Math.max(Number(hours) || 24, 1), 24 * 90) * 3600e3
    const success = Object.fromEntries([...retired, ...Object.entries(live)].map(([id, wf]) => [id, wf.success || 'done']))
    return aiWork({ tasks: hub?.tasks?.(since) ?? null, agentName: id => hub?.agent?.(id)?.name, runs: store.list('run'), evidenceOf: id => store.evidence(id), success, calls: aiLog.read(), since, until })
  }
  const translator = createTranslator({ llm: () => ctx.llm, model: () => settings().translateModel, cache: store.translations, onCall })
  let catalog = null
  const models = async () => {
    if (!catalog || Date.now() - catalog.at > 300e3) {
      const c = await ctx.sessionController.modelCatalog()
      catalog = { at: Date.now(), models: c.groups.flatMap(g => g.models.map(m => ({ id: `${g.id}/${m.id}`, label: `${g.name} / ${m.name}` }))) }
    }
    return catalog.models
  }
  // a person's workflows (lib/workflows.js): built on a built-in one, drafts until enabled
  const mine = createWorkflowStore(home)
  // installed scripts a script step may name (name@version: fixed checks)
  const scripts = createScripts(home)
  const enabledMine = () => mine.list().filter(d => d.status === 'enabled' && live[d.base]).map(d => compose(d, live[d.base]))

  // ── what a workflow needs, and how this machine meets it (lib/needs.js) ──
  // a script step's connections are needs (type, level) this machine binds to its connections: a workflow's own, the
  // default per type, else the only one of the type
  const bindings = createBindings(bindingsFile(home))
  let connCache = []
  const connections = async () => (connCache = conns ? (await conns.list()).map(c => ({ id: c.id, type: c.type, name: c.name })) : [])
  /** The person's enabled workflows: what their steps connect to, as bound here (the Connectors page: used by; the inbox's System tab: one not met). */
  const workflowNeeds = () => mine.list().filter(d => d.status === 'enabled').flatMap(d => flatSteps(d).flatMap(st => needsOf(st).map(n => {
    const c = bindings.resolve(n, d.id, connCache).connection
    return { need: `wf-${d.id}-${st.id}-${n.key}`.slice(0, 80), type: n.type || connCache.find(x => x.id === n.id)?.type || '', ...(c && { connection: c }),
      label: { en: `Workflow ${d.title}: ${st.title} (${n.key}, ${n.level})`, zh: `工作流 ${d.title}：${st.title}（${n.key}，${n.level}）` } }
  })))
  /** A workflow by its id (a person's, or a built-in one as this machine runs it: its steps with the person's picks), or a definition being edited. */
  const defOf = (id, definition) => {
    if (definition && typeof definition === 'object') return definition
    const d = mine.get(String(id))
    if (d) return d
    const wf = workflowAny(String(id))
    if (!wf) throw failWith('noWorkflow', { id }, `no workflow ${id}`)
    const s = ownSettings(), picks = s.steps?.[wf.id] || {}
    return { id: wf.id, title: wf.title, base: wf.id, steps: wf.stages.filter(st => !(st.optional && s.stages?.[st.key] === false)).map(st => ({ use: st.key, ...(picks[st.key] || {}) })) }
  }
  /** What readiness checks a definition against here: the pool, the skills, the connections, the scripts, the base's own agents and models, the pack's connections. */
  const needsCtx = async def => {
    const base = workflowAny(def.base) || workflowAny(def.id), s = ownSettings()
    const roleOf = st => (st.owner !== 'system' ? base.roles?.[st.owner] || null : null)
    const pack = base ? packOf(base) : null
    // the pack's own connections (its actions need them later): shown, never what stops a run from starting
    const packNeeds = pack && conns ? conns.needs().filter(n => n.owner === pack.name.en && !n.optional).map(n => ({ kind: 'connector', pack: true, ref: n.need, type: n.type, label: n.label || null, connection: n.connection || null, state: n.state, status: ['ok', 'untested'].includes(n.state) ? 'ok' : 'warn' })) : []
    return {
      agents: hub?.agents ? hub.agents().map(a => a.id) : [],
      // an Agent Hub that cannot say how a skill stands: not checked (the run takes what it has)
      skills: async (refs, pins) => (hub?.skillCheck ? hub.skillCheck(refs, pins) : refs.map(ref => ({ ref, status: 'unchecked' }))),
      connections: await connections(), bindings, scripts: scripts.list(), model: s.model || '',
      base: base ? Object.fromEntries(base.stages.filter(st => roleOf(st)).map(st => [st.key, roleOf(st).kind === 'model' ? { kind: 'model', model: roleOf(st).model || s.model || '' } : { agent: roleOf(st).agent || '', fallback: roleOf(st).fallback || '' }])) : {},
      extra: packNeeds.length ? { [`pack:${pack.id}`]: packNeeds } : {},
      tools: list => (toolbox ? toolbox.check(list) : list.map(ref => ({ ref, status: 'ok' }))),
      // the tools its runs' agents asked for (tools_ensure), by step: what its list could name
      used: store.list('run').filter(r => (r.workflowDef?.id || r.template) === def.id && r.tools?.length).flatMap(r => r.tools.filter(t => t.by === 'agent'))
        .reduce((m, t) => { m[t.stage] = [...new Set([...(m[t.stage] || []), t.name])]; return m }, Object.create(null)), // (no prototype: a step may be called constructor)
    }
  }
  const readinessOf = async def => readiness(def, await needsCtx(def))
  /** How a workflow stands here, in numbers (its card, the new-run form). */
  const readySummary = async def => { try { const r = await readinessOf(def); return { missing: r.missing, installable: r.installable, soft: r.soft, what: r.missing || r.installable ? missingText(r) : '' } } catch { return null } }
  /** A definition with the packs its steps use: those it carries kept (their commits), the others as this machine has them. */
  const withPacks = d => {
    if (!d || typeof d !== 'object' || !hub?.skillPins) return d
    const ids = packIdsOf(d), refs = skillRefsOf(d), have = new Set((d.packs || []).map(p => p.id))
    const packs = [...(d.packs || []).filter(p => ids.includes(p.id)), ...hub.skillPins(ids.filter(id => !have.has(id)), refs)]
      // a pack pinned per skill: a skill a step names since it was pinned gets its pin now, the pinned ones keep theirs
      .map(p => (p.skills ? { ...p, skills: { ...hub.skillPins([p.id], refs)[0]?.skills, ...p.skills } } : p))
    return { ...d, packs }
  }
  /** Before a run is made: install what this machine can (pinned skill packs), then refuse it when something is still missing. */
  const prepare = async (wf, def) => {
    const d = def || defOf(wf.id)
    const pins = pinsOf(d)
    if (hub?.skillEnsure && Object.keys(pins).length) await hub.skillEnsure(pins).catch(err => ctx.logger?.warn?.(`ruyix-workbench: ${d.id} skill packs: ${err?.message || err}`))
    const r = await readinessOf(d)
    // (a command-line tool not here yet is put in place by the step that needs it — engine runStep — not by the start)
    const later = r.steps.flatMap(x => x.items).filter(i => i.kind === 'tool' && i.status === 'fetch').length
    if (r.missing || r.installable - later) {
      const what = missingText(r)
      throw failWith('workflowNotReady', { id: d.id, n: r.missing + r.installable - later, what }, `${d.title || d.id} is not ready here — missing: ${what} (Workflows → the workflow → what it needs)`)
    }
  }
  /** What a definition is checked against here: the bases, the pool's agents, the connectors, the tools. */
  const wfContext = async () => ({
    bases: live, builtIn: Object.keys(live), tools: toolTable.map(t => t.name),
    agents: hub?.agents ? hub.agents().map(a => a.id) : undefined,
    connectors: conns ? (await conns.list()).map(c => c.id) : undefined,
    scripts: scripts.list(),
  })

  // MCP bridge endpoint: loopback only, and every request must carry a live step's token — or a conversation turn's
  // (the standing conversation on a Claude Code / Codex agent: its tools, the same as its dsh sessions have)
  const chatTokens = new Map() // token → 'chat' (the conversation's tools) or 'task' (a background task's: what reads)
  const chatAsks = new Map() // token → the question its turn answers (several turns at once: a tool call is its question's)
  const chatMcp = async (scope = 'chat', ask = null) => {
    const token = randomUUID()
    chatTokens.set(token, scope)
    if (ask) chatAsks.set(token, ask)
    await listening
    // under the DeepSeek Harness app process.execPath is Electron: it runs the bridge as Node only with ELECTRON_RUN_AS_NODE
    const node = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
    return { mcp: { name: MCP_NAME, command: process.execPath, args: [MCP_SCRIPT], env: { ...node, RUYIXWB_URL: toolsUrl, RUYIXWB_TOKEN: token, RUYIXWB_NAME: MCP_NAME } }, done: () => { chatTokens.delete(token); chatAsks.delete(token) } }
  }
  const server = createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
    const runId = engine.runForToken(token), stage = engine.stageForToken(token) // each step's agent has its own token
    const chat = !runId && chatTokens.has(token)
    if (req.method !== 'POST' || (!runId && !chat)) return reply(401, { error: 'not a live workbench run' })
    try {
      const { name, args } = JSON.parse((await readBody(req)) || '{}')
      if (chat) {
        const list = all.chatTools(chatTokens.get(token))
        if (req.url === '/tools') return reply(200, { tools: list.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) })
        const t = req.url === '/call' && list.find(x => x.name === name)
        if (!t) return reply(404, { error: `no tool ${name}` })
        const r = await askScope.run(chatAsks.get(token) || null, () => t.execute(args || {}, {}))
        return reply(200, { text: typeof r?.text === 'string' ? r.text : JSON.stringify(r ?? '') })
      }
      // the tools of the agent's step (a workflow's agent step lists its own)
      if (req.url === '/tools') { const allowed = engine.toolsFor(runId, stage); return reply(200, { tools: toolDefs(toolTable).filter(t => allowed.includes(t.name)) }) }
      if (req.url === '/call') return reply(200, { text: await engine.tool(runId, name, args, undefined, stage) })
      reply(404, { error: 'unknown path' })
    } catch (err) {
      reply(err?.status === 413 ? 413 : 400, { error: err?.message || String(err) })
    }
  })
  // on a Unix socket of its own (a folder only this user reads): a TCP port listen(0) is given in a microVM box (libkrun's
  // TSI) may refuse connections — the agents then got no tools; a socket is this machine's alone
  // (a socket path is 104 bytes at most on macOS: a long temp folder gives way to /tmp)
  const sockBase = process.platform !== 'win32' && Buffer.byteLength(tmpdir()) > 70 ? '/tmp' : tmpdir()
  const sockDir = mkdtempSync(join(sockBase, 'ruyixwb-')), toolsUrl = `unix:${join(sockDir, 'tools.sock')}`
  const listening = new Promise((resolve, reject) => { server.once('error', reject); server.listen(toolsUrl.slice(5), resolve) })

  // one model call, no tools: dsh's model service, or a connection that speaks the OpenAI chat API (a model step's, a pack's)
  const modelCalls = createModels({ llm: () => ctx.llm, connectors: () => conns, onCall })
  // the command-line tools runs use beyond the image's (lib/toolbox.js): what mise installed before goes on the PATH now
  // (kept: every step awaits it before it starts — engine runStep)
  if (toolbox) toolbox.ready = toolbox.refresh().then(ok => { if (!ok) ctx.logger?.warn?.('ruyix-workbench: tools: mise could not say what is selected; the PATH stays as it was') }, err => ctx.logger?.warn?.(`ruyix-workbench: tools: ${err?.message || err}`))
  // browsers a step or a card opens that the person watches and takes over (lib/browser.js): Playwright of the UI runtime
  const browsers = givenBrowsers || createBrowsers({ runtimeDir: join(home, 'ui-runtime'), logger: ctx.logger, record: (runId, entry) => engine.annotate(runId, null, entry, { quiet: true }) })
  let tasks = null // (lib/tasks.js, made once the engine is: it starts the tasks' runs)
  const engine = createEngine({
    store, settings, hub: () => hub, sharedBrowser: () => sharedBrowser, toolbox, logger: ctx.logger, exec, scripts, models: modelCalls, browsers,
    workflow: workflowAny, live: id => live[id], packOf, toolNames,
    callTool: (c, name, args) => callTool(toolTable, c, name, args),
    skillsAtStart: async wf => {
      const p = packOf(wf)
      return { versions: p && hub?.skillPackVersion ? Object.fromEntries(p.skills.packs.map(x => [x.id, hub.skillPackVersion(x.id) || null])) : {} }
    },
    stageSkills: (wf, key) => (packOf(wf)?.skills.uses || []).filter(u => u.member && u.stages.includes(key)).map(u => u.ref),
    // a person's enabled workflow, by its id (a run keeps the definition it started with)
    custom: id => { const d = mine.get(id); return d?.status === 'enabled' && live[d.base] && !validateWorkflow(d, { bases: live, builtIn: Object.keys(live), tools: toolTable.map(t => t.name) }).errors.length ? d : null },
    services: { connectors: () => conns, hub: () => hub, ops: () => all, flowGuest, studio: () => studios },
    prepare,
    bindConn: async (need, workflowId) => bindings.resolve(need, workflowId, await connections()),
    // (probe: the tools answered through the very way the agent's MCP server asks — else the stage stops with why)
    mcp: { name: MCP_NAME, script: MCP_SCRIPT, url: async () => { await listening; return toolsUrl }, probe: token => toolsPost(toolsUrl, token, '/tools', {}) },
    // every run is a run of a task (lib/tasks.js): one started without one gets a one-off task of its own
    onRunStart: run => tasks?.noteRun(run),
    // Resuming the same run does not count as a new task run.
    onRunResume: run => studios?.onRunResume?.(run),
    // a run started from a studio's record: the studio moves the record on (在写 → 已发)
    onRunEnd: run => { tasks?.runEnded(run); if (run?.studio) Promise.resolve(studios?.onRunEnd?.(run)).catch(err => ctx.logger?.warn?.(`ruyix-workbench: ${run.id}: its studio: ${err?.message || err}`)) },
    ...engineOptions,
  })
  // tasks: once or on a schedule; runs from before tasks get their one-off task once
  tasks = createTasks({
    store, engine, logger: ctx.logger,
    // 再改 returns to the workflow's creator, before any checks and human approval of the new version.
    reviseRun: async (r, text) => {
      const step = revisionStep(r, engine.workflowFor(r))
      if (!step) throw failWith('cannotRevise', {}, 'this run has no step to go on again from')
      return engine.continueRun(r.id, { from: step.key, note: `The person looked at what this run made and asks for changes (再改): ${text}` })
    },
    // a deleted task's runs: their documents, cards, ledger and folder (the run's own: a folder the person named stays)
    removeRun: async r => {
      if (engine.active(r.id)) throw failWith('taskBusy', {}, 'a run of it is still going: stop it first')
      for (const a of store.list('approval').filter(x => x.runId === r.id)) store.remove('approval', a.id)
      messages.close(r.id)
      store.remove('run', r.id)
      store.purgeRun(r.id)
    },
    // the portfolio (docs/design/agent-tasks.md): a run's final files are its results, as its 结果 tab has them; a text
    // one shows its first lines; a group is named by its workflow's title
    resultsOf: r => resultFiles(r, engine.workflowFor(r), engine.versions),
    previewOf: (r, path) => {
      if (!/\.(md|markdown|txt|text|csv|json|ya?ml|html?)$/i.test(path)) return null
      const full = workPath(r, path)
      if (!full) return null
      const fd = openSync(full, 'r'), buf = Buffer.alloc(2048)
      try { const n = readSync(fd, buf, 0, buf.length, 0); return buf.subarray(0, n).toString('utf8').replace(/\uFFFD+$/, '').replace(/^---\n[\s\S]*?\n---\n/, '').trim().slice(0, 300) || null } finally { closeSync(fd) }
    },
    workflowTitle: (id, lang, run) => { const t = (run && engine.workflowFor(run)?.title) || live[id]?.title; return typeof t === 'string' ? t : t?.[lang] || t?.zh || t?.en || null },
  })
  tasks.adopt()
  // what the tasks used, by the hour (lib/usage-hours.js; the desk's 「今天」): read every five minutes
  const usageHours = createUsageHours({ store, read: () => tasks.usageNow(), now })
  ctx.effect(() => { const id = setInterval(() => { try { usageHours.sample() } catch (err) { ctx.logger?.warn?.(`ruyix-workbench: usage by the hour: ${err?.message || err}`) } }, 5 * 60e3); id.unref?.(); return () => clearInterval(id) }, 'ruyix-workbench: usage by the hour')
  ctx.effect(() => () => { tasks.dispose(); engine.dispose(); server.close(); messages.close(); store.close(); conv.close(); rmSync(sockDir, { recursive: true, force: true }) }, 'ruyix-workbench: engine')

  // dsh agents of a run are children of its headless Lead: give them the workbench tools before their first turn.
  const equipped = new Map()
  const equip = agent => {
    const runId = engine.leadRun(agent.session?.header?.parentSession)
    if (!runId || equipped.has(agent)) return
    const names = engine.toolsOfRun(runId)
    equipped.set(agent, toolDefs(toolTable.filter(t => names.includes(t.name))).map(def => agent.ctx.tools.register({
      ...def,
      output: textResult,
      // its step: the running one whose task is this agent's session (steps of a parallel block run at once)
      execute: async (args, x) => ({ text: await engine.tool(runId, def.name, args, x.signal, engine.stageOfSession(runId, agent.session?.header?.id || agent.id)) }),
    })))
  }
  const unequip = agent => { for (const dispose of equipped.get(agent) || []) dispose?.(); equipped.delete(agent) }
  ctx.on('agent/created', ({ agent }) => equip(agent))
  ctx.on('agent/disposed', ({ agent }) => unequip(agent))
  ctx.effect(() => () => { for (const agent of [...equipped.keys()]) unequip(agent) }, 'ruyix-workbench: agent tools')

  const infoOf = wf => ({
    id: wf.id, title: wf.title, description: wf.description || '', pack: wf.pack || null, noun: wf.noun || 'task', success: wf.success || 'done',
    input: wf.input || [], insertFrom: wf.insertFrom || null,
  })
  const runOf = id => { const r = engine.get(String(id)); if (!r) throw failWith('noRun', { id }, `no run ${id}`); return r }
  const summaries = new Map() // run → { key (where it stood), text }: its summary for the desk
  // a resident session (Agent Hub's) whose folder the viewer shows — as a run-like { dir } for the folder's helpers
  const sessionOf = id => { const d = (hub?.sessions?.() || []).find(x => x.id === String(id) && !x.removedAt); if (!d?.cwd) throw failWith('noSession', { id }, `no session ${id}`); return d }
  // a run's tokens, cost and files from its ledger (the records' columns), kept while the run stays the same
  const costs = new Map()
  const runCost = r => {
    const kept = costs.get(r.id)
    if (kept && kept.at === (r.updatedAt || 0)) return kept.v
    let tokens = 0, usd = 0, files = 0
    const asked = new Set((r.subject?.attachments || []).map(a => a.evidence))
    for (const e of store.evidence(r.id)) {
      if (e.kind === 'agent') { tokens += e.input?.tokens || 0; usd += e.input?.cost || 0 }
      if (e.kind === 'model') { tokens += (e.input?.tokens?.input || 0) + (e.input?.tokens?.output || 0); usd += e.input?.cost || 0 }
      if (e.kind === 'file' && e.artifact && !asked.has(e.seq)) files++
    }
    const v = { tokens, usd: Math.round(usd * 1e6) / 1e6, files }
    costs.set(r.id, { at: r.updatedAt || 0, v })
    return v
  }
  const ops = {
    // These are the document maps consumed by src/data.js; pack-internal state has its own scoped API.
    sync: ({ since }) => store.since(since, { kinds: ['run', 'approval', 'task'] }),
    run({ id, after, live }) {
      const run = engine.get(String(id))
      if (!run) throw failWith('noRun', { id }, `no run ${id}`)
      // the panel already has the run doc from sync and asks for evidence after a seq: no need to send the run again;
      // `live`: what its agents at work are doing now (the desk's lines)
      return { ...(after === undefined && { run }), evidence: store.evidence(run.id, after), active: engine.active(run.id), ...(live && { live: engine.live(run.id) }) }
    },
    /** Start a run: { workflow, title?, text?, attachments?: [{ name, base64, mime?, field? }], fields?, note?, tags? } → { run }. */
    startRun: async ({ workflow, title, text, attachments, fields, note, tags, params, studio, taskId }) => ({ run: await engine.startRun({ workflow, title, text, attachments, fields, note, tags, params, studio, ...(taskId && tasks.get(String(taskId)) && { taskId: String(taskId) }) }) }),
    /**
     * A batch: several runs started one after another (each checked as startRun checks it; one that cannot start does
     * not stop the others). { runs: [{ workflow, title?, text?, fields?, note?, tags? }] (at most 50) } → { runs: [{ run } | { error, code }] }
     */
    async startRuns({ runs }) {
      if (!Array.isArray(runs) || !runs.length || runs.length > 50) throw failWith('badInput', { errors: 'runs: 1–50' }, 'runs is a list of 1–50 runs to start')
      const out = []
      for (const r of runs) {
        try { out.push({ run: await engine.startRun({ workflow: r?.workflow, title: r?.title, text: r?.text, fields: r?.fields, note: r?.note, tags: r?.tags, params: r?.params }) }) } catch (err) { out.push({ error: err?.message || String(err), code: err?.code || null }) }
      }
      return { runs: out }
    },
    metrics: () => metrics(store, successOf),
    stopRun: ({ id }) => ({ run: engine.stopRun(String(id)) }),
    /**
     * The person has looked at these finished runs (their page shown, or "seen" on a desk's done place): kept with the
     * run, in the box — the same in every browser. A run going is not marked (it is not done yet). → { seen: [ids] }
     */
    markSeen({ ids = [] }) {
      const seen = []
      for (const id of (Array.isArray(ids) ? ids : [ids]).map(String).slice(0, 200)) {
        const r = engine.get(id)
        if (!r || !DONE.has(r.status) || r.seenAt) continue
        store.put('run', { ...r, seenAt: Date.now() }); seen.push(id)
      }
      return { seen }
    },
    /**
     * What a run has done so far, in two or three sentences of the main model (docs/design/agent-work.md §2: the desk's
     * strip, opened): from its steps, their results and its newest ledger entries. Asked again only when the run moved
     * on. { id, lang: zh | en } → { text } (empty: no main model here)
     */
    async runSummary({ id, lang = 'en' }) {
      const r = runOf(id), ev = store.evidence(r.id)
      const key = `${lang}:${r.status}:${r.stage || ''}:${ev.at(-1)?.seq ?? 0}`
      const kept = summaries.get(r.id)
      if (kept?.key === key) return { text: kept.text }
      const result = v => (v == null || v === true ? '' : String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 300))
      const user = [
        `Run: ${r.subject?.title || r.template} (workflow ${r.template}), ${r.status}${r.waiting ? `, waiting for the ${r.waiting}` : ''}.`,
        r.subject?.text && `What it was asked: ${String(r.subject.text).slice(0, 600)}`,
        'Its steps:', ...r.stages.map(s => `- ${typeof s.title === 'string' ? s.title : s.key}: ${s.status}${s.agent?.id ? ` (${s.agent.id})` : ''}${result(r.outputs?.[s.key] ?? s.result) ? ` — ${result(r.outputs?.[s.key] ?? s.result)}` : ''}`),
        r.verdict?.level && `Verdict: ${r.verdict.level}${r.verdict.reason ? ` — ${String(r.verdict.reason).slice(0, 300)}` : ''}`,
        'Its newest record entries:', ...ev.slice(-30).map(e => `- ${e.stage || ''} ${e.kind}${e.ok === false ? ' (failed)' : ''}: ${String(e.title || '').slice(0, 160)}`),
      ].filter(Boolean).join('\n')
      const system = `Say in two or three short sentences what this workflow run has done so far and where it stands now (what it is doing, what it waits for, what it came to). Write in ${lang === 'zh' ? 'Chinese' : 'English'}, plain words for the person who started it; no ids, no tool names, no lists.`
      // the main model (a dsh model); none here — the main agent is Claude Code, Codex or pi — that agent itself, one turn
      const main = hub?.mainModel?.(), agent = hub?.mainAgent?.()
      let out = null
      if (typeof main === 'string' && main.indexOf('/') > 0) out = await modelCalls.call({ model: /^[a-z][a-z0-9-]{0,40}:/.test(main) ? main : `dsh:${main}`, kind: 'run-summary', by: `${r.id}:summary`, maxTokens: 400, retries: 0, signal: AbortSignal.timeout(60000), system, user })
      else if (agent && agent.runtime !== 'dsh' && hub.chatTurn) {
        const turn = await hub.chatTurn({ agent: agent.id, cwd: r.folder || r.dir || homedir(), instructions: `${system}\nUse no tools: everything you need is in the message.`, prompt: user, signal: AbortSignal.timeout(120000) })
        out = { text: turn?.error ? '' : turn?.output || '' }
      } else return { text: '' }
      const text = String(out?.text || '').trim().slice(0, 600)
      summaries.set(r.id, { key, text })
      if (summaries.size > 200) summaries.delete(summaries.keys().next().value)
      return { text }
    },
    /**
     * What finished runs came to, for the desk's done notes (docs/design/agent-work.md §3): a line (its verdict's reason,
     * else its last step's result) and its first picture among what it made (a ledger entry's seq: the file route serves
     * it). { ids } (at most 50) → { outcomes: { [id]: { text, image: seq | null, files } } }
     */
    runOutcomes({ ids = [] }) {
      const outcomes = {}
      for (const id of (Array.isArray(ids) ? ids : [ids]).map(String).slice(0, 50)) {
        const r = engine.get(id)
        if (!r || !DONE.has(r.status)) continue
        const asked = new Set((r.subject?.attachments || []).map(a => a.evidence))
        const files = store.evidence(r.id).filter(e => e.kind === 'file' && e.artifact && !asked.has(e.seq))
        const image = files.find(e => /^image\//.test(e.input?.mime || '') || /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(e.input?.name || e.artifact))
        const last = [...r.stages].reverse().map(s => resultWords(r.outputs?.[s.key] ?? s.result)).find(Boolean) || ''
        outcomes[id] = { text: String(r.verdict?.reason || last || r.error || '').replace(/\s+/g, ' ').trim().slice(0, 300), image: image?.seq ?? null, files: files.length }
      }
      return { outcomes }
    },
    /**
     * 记录 (docs/design/agent-work.md §3; lib/records.js): the runs, and from Agent Hub its resident sessions (not a
     * run's) and its own jobs, as one list, newest first. { q?, kinds?, studio?, archived?, before?, limit? } → { items, more }
     */
    records(args = {}) {
      const all = store.list('run').map(r => runRecord(r, { cost: runCost(r), taskTitle: id => store.get('task', id)?.title || '', workflowTitle: id => (typeof workflowAny(id)?.title === 'string' ? workflowAny(id).title : '') }))
      for (const d of hub?.sessions?.() || []) if (!d.removedAt && !d.of?.run && d.by !== 'workbench') all.push(sessionRecord(d))
      const byJob = new Map()
      for (const t of hub?.tasks?.(0) || []) { if (!byJob.has(t.jobId)) byJob.set(t.jobId, []); byJob.get(t.jobId).push(t) }
      for (const [jobId, ts] of byJob) { const j = hub?.job?.(jobId); if (j && !j.headless) all.push(jobRecord(j, ts)) }
      const kinds = Array.isArray(args.kinds) && args.kinds.length ? args.kinds.map(String) : undefined
      return recordsOf(all, { q: String(args.q || '').slice(0, 200), kinds, studio: args.studio ? String(args.studio) : null, archived: !!args.archived, before: args.before || null, limit: args.limit })
    },
    /**
     * A resident session's work for the viewer (docs/design/agent-work.md §4): the files of its folder it made or changed
     * since it began, the latest first. { id } → { session: { id, title, cwd }, files: [paths] }
     */
    sessionFiles({ id }) {
      const d = sessionOf(id)
      return { session: { id: d.id, title: d.title || d.agent, cwd: d.cwd }, files: changedFiles(d.cwd, (d.createdAt || 0) - 1000).map(f => f.path) }
    },
    /** A file of a session's folder as the viewer shows it ({ id, path } → { text | image | binary, size }). */
    sessionFileAt({ id, path }) {
      const d = sessionOf(id), full = workPath({ dir: d.cwd }, path)
      if (!full) throw failWith('noFile', { path }, `${path} is not in the session's folder`)
      return renderFile(String(path), statSync(full).size, () => readFileSync(full))
    },
    /** A web page of a session's folder, its files put in (as a run's: lib/pages.js). */
    sessionPageOf: ({ id, path }) => { const d = sessionOf(id); return pageOf({ id: d.id, dir: d.cwd }, path) },
    /**
     * The runs started from a studio's records (docs/design/studio.md: a record's runs, the 成品 list): { studio, collection?,
     * record?, workflow?, archived? } → { runs: [{ id, title, workflow, status, verdict, studio, account, createdAt, endedAt,
     * outcome: { text, image, files } (finished) }] }, the latest first. The run is where the link is kept.
     */
    runsOf({ studio, collection, record, workflow, archived = false } = {}) {
      if (!studio) throw failWith('badInput', { errors: 'studio' }, 'say which studio')
      const runs = store.list('run').filter(r => r.studio?.id === String(studio) && (!collection || r.studio.collection === String(collection)) && (!record || r.studio.record === String(record))
        && (!workflow || r.template === String(workflow) || r.workflowDef?.base === String(workflow)) && (archived || !r.archivedAt)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 500)
      const done = runs.filter(r => DONE.has(r.status)).map(r => r.id)
      const outcomes = done.length ? ops.runOutcomes({ ids: done.slice(0, 50) }).outcomes : {}
      return {
        runs: runs.map(r => ({
          id: r.id, title: r.subject?.title || r.template, workflow: r.template, status: r.status, verdict: r.verdict?.level || null, studio: r.studio,
          ...(r.account && { account: { id: r.account.id, name: r.account.name || r.account.id } }), createdAt: r.createdAt, endedAt: r.endedAt || null,
          ...(outcomes[r.id] && { outcome: outcomes[r.id] }),
        })),
      }
    },
    /** The records a form's `ref` field offers (a studio's collection, by name): { studio, collection } → { options: [{ value, label }] } (no studio here: none). */
    async refOptions({ studio, collection }) {
      if (!studios?.list || !studio || !collection) return { options: [] }
      const list = await Promise.resolve().then(() => studios.list(String(studio), String(collection))).catch(() => [])
      return { options: (Array.isArray(list) ? list : []).slice(0, 200).map(x => ({ value: String(x.id), label: String(x.name || x.title || x.id).slice(0, 80) })) }
    },
    /** Dismiss a finished run (tests, superseded runs): out of the default lists and the approval inbox; reversible. */
    archiveRun({ id, archived = true }) {
      const r = engine.get(String(id))
      if (!r) throw failWith('noRun', { id }, `no run ${id}`)
      if (archived && !DONE.has(r.status)) throw failWith('archiveActive', {}, 'stop the run before archiving it')
      if (archived) engine.browsers?.closeRun(r.id).catch(() => {})
      return { run: store.put('run', { ...r, archivedAt: archived ? Date.now() : null }) }
    },
    /**
     * A task (lib/tasks.js): { title?, workflow, text?, fields?, note?, tags?, attachments? (once only), schedule? ({ kind:
     * once | daily | every | cron, … }; once by default: it runs now), tz?, catchUp?, carry?, runNow? } → { task, run? }
     */
    taskCreate: args => tasks.create({ ...args, by: 'person' }),
    /** Change a task: { id, title?, text?, fields?, note?, schedule?, tz?, enabled?, catchUp?, carry? } → { task } */
    taskUpdate: args => ({ task: tasks.update(args) }),
    /** One run of the task now (not while one is going). → { run } */
    taskRunNow: async ({ id }) => ({ run: await tasks.runNow({ id }) }),
    /** Archive a task or bring it back: { id, archived } → { task } */
    taskArchive: ({ id, archived = true }) => ({ task: tasks.archive({ id, archived }) }),
    // ── every task (docs/design/agent-tasks.md; lib/tasks.js, lib/task-model.js): the task center, the portfolio ──
    /** { state?, source?, agent?, studio?, q?, archived? (true: too, 'only'), before?, limit? } → { tasks, more, counts } */
    taskList: args => { const r = tasks.list(args || {}); return { ...r, agents: r.agents.map(a => ({ ...a, name: hub?.agent?.(a.id)?.name || a.id })) } },
    /**
     * The desk's 「今天」: { since (the person's midnight, ms), hours (the curve's, 12) } → { tasks: how many moved since,
     * tokens, cost (dollars; null: none priced), hours: [{ at, tokens, cost }] } (lib/usage-hours.js)
     */
    today: ({ since, hours = 12 } = {}) => {
      const from = Number(since) > 0 ? Number(since) : now() - 864e5
      usageHours.fresh(60e3)
      const moved = tasks.list({ from, archived: true, limit: 500 })
      return { tasks: moved.tasks.length, ...usageHours.since(from, hours) }
    },
    /** { id } → { task, timeline, outputs } */
    taskGet: ({ id, run, lang }) => tasks.view({ id: id ? String(id) : null, run: run ? String(run) : null, lang: lang === 'en' ? 'en' : 'zh' }),
    /** 好了: the person takes what it made. → { task } */
    taskConfirm: ({ id, run, expect }) => ({ task: tasks.confirm({ id: String(id), run, expect }) }),
    /** 再改: { id, text } → { task } */
    taskRevise: async ({ id, text, run, expect }) => ({ task: await tasks.revise({ id: String(id), text, run, expect }) }),
    /** Delete one that is over (its runs and their folders too). → { deleted } */
    taskDelete: ({ id }) => tasks.remove({ id: String(id) }),
    /** The portfolio: { kind?, source?, studio?, task?, q?, before?, limit? } → { outputs, more } */
    outputList: args => tasks.outputs({ ...(args || {}), lang: args?.lang === 'en' ? 'en' : 'zh' }),
    /** Continue a stopped run from its first unfinished step; `from`: a step key (a finished run too, when a person re-judged that step). → { run, from } */
    resumeRun: ({ id, from }) => engine.resumeRun(String(id), { from: from || undefined }),
    // ── a run's versions (lib/versions.js): one per step; going back, a person's edit, going on from a step ──
    /** { on, off, commits: [{ commit, at, parent, subject, mark: { kind, step?, status?, … } }] }, oldest first. */
    versions: ({ id }) => engine.versionsOf(String(id)),
    /** What one version changed: { files: [{ status, path, from?, added, removed }] }. */
    versionChanges: async ({ id, commit }) => ({ files: await engine.versions.changes(runOf(id), commit) }),
    /** The files a version holds (HEAD: the latest): { files: [{ path, size }] }. */
    versionFiles: async ({ id, commit = 'HEAD' }) => ({ files: await engine.versions.files(runOf(id), commit) }),
    /** One file's versions, newest first: { history: [{ commit, at, subject, mark, status, path }] }. */
    fileHistory: async ({ id, path }) => ({ history: await engine.versions.history(runOf(id), path) }),
    /**
     * What a run's agents said to each other (lib/messages.js): { on: whether its workflow lets them, messages (oldest
     * first; before: older than that number, after: newer — the desk's graph asks for the new ones), members }.
     */
    runMessages: ({ id, before, after, limit }) => {
      const r = runOf(id)
      return { on: messagesOn(engine.workflowFor(r)), ...messages.log(r.id, { before: before ?? null, after: after ?? null, limit }) }
    },
    // ── a review (lib/review.js): its rounds and comments; the person's comments saved as they write them ──
    /** { review: { round, max, status, files, comments, rounds, agent, step, … }, card: the step's latest decision card } */
    reviewOf: ({ id, stage }) => {
      const r = runOf(id), review = r.reviews?.[stage]
      if (!review) throw failWith('noReview', { stage }, `${stage} has no review in this run`)
      // (the card waiting now, else the newest: the list is not in the order they were made)
      const cards = store.list('approval').filter(a => a.runId === r.id && a.action === 'decision' && a.payload?.stage === stage).sort((a, b) => a.createdAt - b.createdAt)
      return { review: reviewView(review), card: cards.find(a => a.status === 'pending') || cards.at(-1) || null }
    },
    /** The person's comments as the page has them now (all of this review's): those the agent answered keep their words. → { review } */
    reviewSave: ({ id, stage, comments, revision }) => {
      const r = runOf(id), review = r.reviews?.[stage]
      if (!review || review.status !== 'person') throw failWith('reviewClosed', { stage }, 'this review is not waiting for you now')
      if (revision !== undefined && revision !== reviewView(review).commentsRevision) throw failWith('commentsChanged', {}, 'comments changed in another page: copy your unsaved text, then reopen this view')
      const next = mergeComments(review.comments || [], comments, { files: review.files || [], round: review.round })
      const now = engine.get(r.id) // (read again just before the write: the step may have moved on)
      if (now.reviews?.[stage]?.status !== 'person' || now.reviews[stage].round !== review.round) throw failWith('reviewClosed', { stage }, 'this review is not waiting for you now')
      const saved = store.put('run', { ...now, reviews: { ...now.reviews, [stage]: { ...now.reviews[stage], comments: next } } })
      return { review: reviewView(saved.reviews[stage]) }
    },
    // ── a run's results (lib/results.js): the files, the person's comments on them, going on again with them ──
    /** { files, comments, steps (where comments can be acted on), defaultFrom, restarts, declared } */
    resultsOf: async ({ id }) => {
      const r = runOf(id), wf = engine.workflowFor(r)
      return { files: await resultFiles(r, wf, engine.versions), comments: r.results?.comments || [], revision: resultsRevision(r), steps: revisionSteps(r, wf), defaultFrom: revisionStep(r, wf)?.key || null, restarts: r.results?.restarts || [], declared: !!wf?.stages.some(s => s.generic === 'output') }
    },
    /** The person's comments on the results as the page has them (those sent along keep their words). → { comments } */
    resultsSave: async ({ id, comments, revision }) => {
      const r = runOf(id), files = await resultFiles(r, engine.workflowFor(r), engine.versions)
      const now = engine.get(r.id), kept = now.results?.comments || []
      if (revision !== undefined && revision !== resultsRevision(now)) throw failWith('commentsChanged', {}, 'comments changed in another page: copy your unsaved text, then reopen this view')
      const next = mergeComments(kept, comments, { files, round: (now.results?.restarts?.length || 0) + 1 })
      const saved = store.put('run', { ...now, results: { ...(now.results || {}), comments: next } })
      return { comments: saved.results.comments, revision: resultsRevision(saved) }
    },
    /** The run goes on again from a step, its open comments in that step's brief (engine.continueRun). */
    resultsRestart: async ({ id, from }) => {
      const r = runOf(id), wf = engine.workflowFor(r), steps = revisionSteps(r, wf)
      const step = steps.find(x => x.key === (from ?? revisionStep(r, wf)?.key))
      if (!step) throw failWith('noStage', { stage: from }, `the run cannot go on from "${from}" (${steps.map(x => x.key).join(', ') || 'no step'})`)
      const open = (r.results?.comments || []).filter(c => c.status === 'open')
      const fingerprint = c => JSON.stringify([c.file ?? null, c.at ?? null, c.text])
      const sent = new Map(open.map(c => [c.id, fingerprint(c)]))
      const note = open.length ? commentsNote(wf.title || 'Results', open) : ''
      if (note.length > 4000) throw failWith('commentsTooLong', { max: 4000 }, 'these comments are too long for one restart: shorten or split them and try again')
      const out = await engine.continueRun(r.id, { from: step.key, note })
      const now = engine.get(r.id), n = (now.results?.restarts?.length || 0) + 1, ids = new Set(open.map(c => c.id))
      store.put('run', { ...now, results: { comments: (now.results?.comments || []).map(c => (c.status === 'open' && sent.get(c.id) === fingerprint(c) ? { ...c, status: 'sent', sentIn: n, sentTo: step.key } : c)),
        restarts: [...(now.results?.restarts || []), { n, from: step.key, at: Date.now(), comments: [...ids], delivered: open }] } })
      return out
    },
    /** An HTML file of the folder, its own files put in, for the viewer's frame (lib/pages.js). → { html, inlined, left } */
    pageOf: ({ id, path }) => pageOf(runOf(id), path),
    /** A file at a version: { blob, size, text | image | binary }. */
    fileAt: ({ id, commit = 'HEAD', path }) => engine.versions.show(runOf(id), commit, path),
    /** The difference between two versions (one file, or all); no `from`: what `to` changed. → { diff } */
    fileDiff: async ({ id, from, to, path }) => ({ diff: await engine.versions.diff(runOf(id), from || null, to, path || null) }),
    /**
     * What going back to before a step would do (changes nothing): { from, tree, target, files: [{ path, action: remove |
     * restore | revert }], kept: [what has no version and is in the way: moved aside, not lost] }.
     */
    rewindPreview: ({ id, from }) => engine.rewindPreview(String(id), { from: String(from || '') }),
    /** Back to before a step, and on from it (a run going is stopped first); `expect`: { tree, target } of the preview the person saw. → { run, from, kept, keptDir } */
    rewindRun: ({ id, from, expect }) => engine.rewindRun(String(id), { from: String(from || ''), expect: expect && typeof expect === 'object' ? { tree: String(expect.tree || ''), target: String(expect.target || '') } : undefined }),
    /** On from a step with the folder as it is, optionally a note for that step. → { run, from } */
    continueRun: ({ id, from, note }) => engine.continueRun(String(id), { from: String(from || ''), note }),
    // ── a run's browsers (lib/browser.js): the person watches and takes over what a step or a card opened ──
    /** A run's browsers: { browsers: [{ id, stage, title, status, url, step, note, openedAt, endedAt, done }] }. */
    browsers: ({ id }) => ({ browsers: engine.browsers?.list(String(id)) || [] }),
    /** One browser as it is: its frame (a JPEG data URL) only when newer than `since`. */
    browserState: ({ session, since }) => engine.browsers.state(String(session), { since: Number(since ?? -1) }),
    /** The person's click ({ type: click, x, y }), scroll (wheel, dy), key, text, back or reload → the state with the new frame. */
    browserInput: ({ session, ...ev }) => engine.browsers.input(String(session), ev),
    browserClose: ({ session }) => engine.browsers.close(String(session), 'closed on the run\'s page'),
    /** What writing `content` to a file of the run's folder would change: { diff, blob, added, removed } (a card shows it before the person applies it). */
    editPreview: ({ id, path, content }) => engine.versions.diffTo(runOf(id), path, String(content ?? '')),
    /** A person's change to a file of the run's folder: { path, content (text) | { base64 }, blob (the copy changed; null: a new file) } → the version. */
    editFile: ({ id, path, content, blob }) => engine.editFile(String(id), { path, content, blob }),
    approve: async ({ id, payload }) => ({ approval: await engine.approve(String(id), payload) }),
    /** The person asks the agent of the step an ask card waits at (the card's chat): it answers from the run's record. */
    askHelp: ({ id, text }) => ({ approval: engine.askHelp(id, text) }),
    reject: ({ id, reason, rev }) => ({ approval: engine.reject(String(id), reason, rev) }),
    verify: ({ id }) => store.verifyAsync(String(id)),
    async report({ id }) {
      const run = engine.get(String(id))
      if (!run) throw failWith('noRun', { id }, `no run ${id}`)
      const markdown = run.report ? store.readArtifact(run.report) : await engine.writeReport(run.id)
      return { markdown, sha256: engine.get(run.id)?.reportSha256 }
    },
    artifact({ id, seq }) {
      const e = store.evidenceAt(String(id), seq)
      if (!e || e.seq !== Number(seq)) throw failWith('noEvidence', { seq }, `no evidence #${seq}`)
      if (!e.artifact) return { evidence: e, content: e.output }
      const bytes = store.readArtifact(e.artifact, null)
      const image = IMAGE[e.artifact.split('.').pop().toLowerCase()]
      if (image) return { evidence: e, content: '', image: `data:${image};base64,${bytes.toString('base64')}` }
      if (bytes.subarray(0, 8000).includes(0)) return { evidence: e, content: `(binary file, ${bytes.length} bytes${e.artifact ? `, ${mimeOf(e.artifact)}` : ''})`, binary: true }
      const full = bytes.toString('utf8')
      return { evidence: e, content: full.length > 400000 ? `${full.slice(0, 400000)}\n…(truncated)` : full }
    },
    // the person's settings as saved (not filled in at run time), each workflow's steps with the agent they use, the pool's
    // agents to pick from, and the steps that can be turned off
    settings: async () => {
      const s = ownSettings()
      const flows = Object.values(live)
      return { settings: s, revision: settingsRevision(s), defaults: defaultsOf(list()), file: FILE, hub: !!hub, packs: list().map(p => ({ id: p.id, name: p.name })),
        // the model the assistant and the AI helpers run on: Agent Hub's default agent
        ai: { agent: hub?.defaultAgent?.()?.id || null, model: aiModel() },
        agents: (hub?.agents?.() || []).map(a => ({ id: a.id, name: a.name, runtime: a.runtime, model: a.model, effort: a.effort })),
        stepAgents: stepAgents(flows, s), workflows: Object.fromEntries(flows.map(wf => [wf.id, workflowInfo(wf, s, hub, packOf(wf)?.skills.uses || [])])),
        optionalStages: [...new Set(flows.flatMap(wf => wf.stages.filter(x => x.optional).map(x => x.key)))],
        // the connections to pick from — names and kinds, never a credential
        connections: conns ? (await conns.list()).map(c => ({ id: c.id, type: c.type, name: c.name, ok: c.status?.ok ?? null })) : null,
        // the models dsh has, for a model step (dsh:<provider>/<model>)
        models: await models().catch(() => []) }
    },
    async saveSettings({ settings: value, revision }) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be an object')
      const current = ownSettings()
      if (revision !== undefined && revision !== settingsRevision(current)) throw failWith('settingsChanged', {}, 'settings changed since this page loaded: reload before saving')
      // (models are not settings: the AI helpers run on Agent Hub's default agent)
      const { translateModel: _tm, assistantModel: _am, ...given } = value
      value = { ...current, ...given }
      for (const [wf, picks] of Object.entries(value?.steps && typeof value.steps === 'object' ? value.steps : {})) {
        for (const [key, pick] of Object.entries(picks && typeof picks === 'object' ? picks : {})) {
          const stage = workflowAny(wf)?.stages.find(x => x.key === key && x.owner !== 'system')
          if (!stage) throw failWith('badStep', { workflow: wf, step: key }, `${wf} has no agent step "${key}"`)
          const isModel = workflowAny(wf).roles?.[stage.owner]?.kind === 'model'
          if (isModel ? Object.keys(pick || {}).some(f => f !== 'model') : pick?.model !== undefined) throw failWith('badPick', { workflow: wf, step: key }, `${wf}: ${key} is ${isModel ? 'a model step: it takes a model' : 'an agent step: it takes an agent, a fallback and skills'}`)
          for (const id of [pick?.agent, pick?.fallback].filter(x => x && typeof x === 'string')) if (hub?.agent && !hub.agent(id)) throw failWith('noAgent', { id }, `no agent "${id}" in the agent pool`)
        }
      }
      const saved = saveSettings(value, FILE, list())
      return { settings: saved, revision: settingsRevision(saved) }
    },
    models: async () => ({ models: await models() }),
    /** The packs there are: id, name, their workflows (with their form fields) and the actions they run on approval. */
    packs: () => ({ packs: list().map(p => ({ id: p.id, name: p.name, workflows: Object.keys(p.workflows).map(k => infoOf(live[`${p.id}.${k}`])), actions: Object.keys(p.actions) })) }),

    // ── workflows: the built-in ones (code) and the person's (definitions: drafts until enabled) ──
    /** Every workflow, what its steps are, and what a definition can use here (agents, connectors, tools). */
    async workflows() {
      const c = await wfContext()
      const builtIn = Object.values(live), own = mine.list()
      // how each stands here (what it needs: lib/needs.js)
      const [readyB, readyM] = await Promise.all([Promise.all(builtIn.map(wf => readySummary(defOf(wf.id)))), Promise.all(own.map(d => readySummary(d)))])
      const s = ownSettings()
      return {
        builtIn: builtIn.map((wf, k) => ({ ...infoOf(wf), steps: outline(wf), library: library(wf), ready: readyB[k] })),
        mine: own.map((d, k) => ({ ...workflowView(d), errors: validateWorkflow(d, c).errors, ready: readyM[k] })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        generic: GENERIC, agents: hub?.agents ? hub.agents().map(a => ({ id: a.id, name: a.name, runtime: a.runtime, model: a.model })) : [], defaultAgent: hub?.defaultAgent?.()?.id || null,
        connectors: conns ? (await conns.list()).map(x => ({ id: x.id, type: x.type, name: x.name, share: !!x.share, drive: !!x.drive })) : [],
        // the connection types this machine knows (a script step's needs are by type)
        connectorTypes: conns?.types ? [...new Set(conns.types().map(x => x.id))] : [],
        tools: toolDefs(toolTable).map(t => ({ name: t.name, description: t.description })),
        // the skills a step can be given (the packs' only: a run never takes this machine's or the workspace's)
        skills: hub?.skills ? (await hub.skills().catch(() => [])).filter(s => s.pack).map(s => ({ ref: s.ref, description: s.description || '' })) : [],
        scripts: scripts.list().map(ref => ({ ref, description: scripts.get(ref)?.description || '' })),
        // what a model step can name: dsh's models (as dsh:<provider>/<model>) and the workbench's default model
        models: await models().catch(() => []), defaultModel: s.model || '',
        // the built-in workflows' configuration: each agent step's picks, the optional steps on or off
        picks: { steps: s.steps || {}, stages: s.stages || {} }, settingsRevision: settingsRevision(s),
      }
    },
    /**
     * A script step's script tried without doing anything (the assistant's check before it saves one): in a worker, every
     * agent, command and person a stand-in — what steps it goes through with those, or where it breaks. answers: { [step
     * name]: what that step's agent / command / person hands back instead }. → { ok, value?, broke? (where it broke), errors?, steps }
     */
    async workflowTry({ source, params = {}, answers = {} }) {
      const c = checkFlow(source)
      if (c.errors.length) return { ok: false, errors: c.errors, steps: [] }
      // (a step by its name, in a branch of wf.parallel too: p1.0/check#2 → check)
      const given = (key, fallback) => { const name = String(key).split('/').pop().split('#')[0]; return Object.hasOwn(answers || {}, name) ? answers[name] : fallback }
      // what a command or a person hands back behaves as it would in a run: a failing command throws (unless allowFail), a stop stops
      const ran = (r, opts) => { if (r && typeof r === 'object' && Number(r.code) && !opts?.allowFail) throw new Error(`exit ${r.code}: ${String(r.stderr || r.stdout || '').slice(-300)}`); return r }
      const actions = {
        agent: ({ role }, { key }) => given(key, { ok: true, summary: `(a try: ${role} was not asked)`, findings: [] }),
        sh: ({ command, opts }, { key }) => ran(given(key, { code: 0, stdout: `(a try: \`${String(command).slice(0, 80)}\` did not run)`, stderr: '' }), opts),
        script: ({ ref, opts }, { key }) => ran(given(key, { code: 0, stdout: `(a try: ${ref} did not run)`, stderr: '' }), opts),
        evidence: () => null,
        ask: ({ opts }, { key }) => {
          const a = given(key, { answer: 'continue', input: '(a try: nobody was asked)', choice: opts?.options?.[0]?.label ?? opts?.options?.[0] ?? null, by: null })
          if (a?.answer === 'stop' || a?.choice === 'Stop the run') throw Object.assign(new Error('stopped by the person'), { code: 'stopped' })
          return a
        },
      }
      let kept = null
      const out = await runFlow({ guest: guests.worker(), name: 'try', source, params: params && typeof params === 'object' ? params : {}, input: { run: { id: 'try', template: 'try' }, request: { title: '', text: '', fields: {} }, outputs: {} },
        journal: { load: () => null, save: j => { kept = j } }, actions, signal: AbortSignal.timeout(30000) })
      return { ok: out.ok, ...(out.ok ? { value: out.value } : { broke: out.error }), steps: stepsOf(kept || out.journal) }
    },
    /** Check a definition: → { definition (as it would be saved), errors }. */
    workflowValidate: async ({ definition }) => { const r = validateWorkflow(definition, await wfContext()); return { definition: r.def, errors: r.errors } },
    /**
     * What a workflow needs and how each stands here: a person's (`id`, or a `definition` being edited) or a built-in one
     * (its steps as this machine picks them). → readiness (lib/needs.js) + the connections a need can be bound to.
     */
    async workflowReadiness({ id, definition }) {
      const def = defOf(id, definition)
      const r = await readinessOf(def)
      return { ...r, what: r.missing || r.installable ? missingText(r) : '', connections: connCache }
    },
    /** Install what a workflow needs that this machine can install itself (its skill packs at their pins). → what failed, and how it stands now. */
    async workflowEnsure({ id, definition }) {
      const def = withPacks(defOf(id, definition))
      const pins = pinsOf(def)
      const got = hub?.skillEnsure && Object.keys(pins).length ? await hub.skillEnsure(pins) : { fetched: [], failed: [] }
      // its steps' command-line tools, installed now (what only a person can install stays in the readiness, with how)
      const fetched = [...(got.fetched || [])], failed = [...(got.failed || [])]
      for (const want of [...new Set(allSteps(def).flatMap(s => s.cli || []))]) {
        const r = toolbox ? await toolbox.need(want) : { status: 'ok' }
        if (r.status === 'installed') fetched.push(r.want)
        if (r.status === 'missing') failed.push({ id: r.want, error: r.error || r.how?.text || 'missing' })
      }
      return { fetched, failed, readiness: await ops.workflowReadiness({ definition: def }) }
    },
    /** This machine's bindings (a connection per need: the default, a workflow's own) and its connections. */
    bindings: async () => ({ bindings: bindings.get(), connections: await connections() }),
    /** Bind a need (`key`: its type, or type:name) to a connection here (none: unbound); `workflow`: that workflow's own. */
    async bindingSet({ key, connection, workflow }) {
      if (!key || typeof key !== 'string') throw failWith('badInput', { errors: 'key' }, 'say which need to bind (its type, or type:name)')
      if (connection && !(await connections()).some(c => c.id === connection)) throw failWith('noConnection', { id: connection }, `no connection ${connection} here`)
      return { bindings: bindings.set({ key: String(key).slice(0, 64), connection: connection || null, workflow: workflow ? String(workflow).slice(0, 40) : null }) }
    },
    /** The AI work done here over the last `hours`: Agent Hub's tasks, the runs' steps, the workbench's own model calls (lib/aiwork.js). */
    aiWork: ({ hours } = {}) => aiWorkOf({ hours }),
    /** Save a definition. `by: 'assistant'`: always a draft; a person's save keeps an enabled workflow enabled when it is still valid, and `enable` turns it on (only a valid one). */
    async workflowSave({ definition, enable, create = false, expect, by = 'person', origin = null }) {
      // the skill packs its steps use, pinned as this machine has them — kept as they were for a pack it already pins (a
      // definition that comes without its pins keeps the ones it was saved with)
      const before = definition && typeof definition === 'object' && !Array.isArray(definition.packs) ? mine.get(String(definition.id || '')) : null
      const { def, errors } = validateWorkflow(withPacks(before?.packs ? { ...definition, packs: before.packs } : definition), await wfContext())
      if (!def.id || errors.some(e => e.field === 'id' || e.field === 'base')) throw failWith('workflowInvalid', { errors: errors.map(e => e.message).join('; ') }, errors.map(e => e.message).join('; '))
      if (enable && errors.length) throw failWith('workflowInvalid', { errors: errors.map(e => e.message).join('; ') }, `fix these first: ${errors.map(e => e.message).join('; ')}`)
      const prev = mine.get(def.id)
      if (create && (prev || live[def.id])) throw failWith('workflowExists', { id: def.id }, `workflow ${def.id} exists already: choose another id`)
      if (expect !== undefined && expect !== (prev ? workflowView(prev).revision : null)) throw failWith('workflowChanged', {}, 'workflow changed elsewhere: keep your draft, then reopen it')
      if (prev) mine.keep(prev)
      const status = by === 'assistant' ? 'draft' : enable || (prev?.status === 'enabled' && !errors.length) ? 'enabled' : 'draft'
      const from = origin || prev?.origin
      return { workflow: workflowView(mine.put({ ...def, status, createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now(), by, ...(from && { origin: from }) })), errors }
    },
    async workflowStatus({ id, status, expect }) {
      const d = mine.get(String(id))
      if (!d) throw failWith('noWorkflow', { id }, `no workflow ${id}`)
      if (expect !== undefined && expect !== workflowView(d).revision) throw failWith('workflowChanged', {}, 'workflow changed elsewhere: reopen it before changing its status')
      if (status === 'enabled') {
        const { errors } = validateWorkflow(d, await wfContext())
        if (errors.length) throw failWith('workflowInvalid', { errors: errors.map(e => e.message).join('; ') }, `fix these first: ${errors.map(e => e.message).join('; ')}`)
      }
      if (JSON.stringify(mine.get(String(id))) !== JSON.stringify(d)) throw failWith('workflowChanged', {}, 'workflow changed: reload before changing its status')
      mine.keep(d)
      return { workflow: workflowView(mine.put({ ...d, status: status === 'enabled' ? 'enabled' : 'draft', updatedAt: Date.now() })) }
    },
    /** Remove a person's workflow (runs that used it keep their own copy of it). */
    workflowRemove({ id, expect }) {
      const previous = mine.get(String(id))
      if (!previous) throw failWith('noWorkflow', { id }, `no workflow ${id}`)
      if (expect !== undefined && expect !== workflowView(previous).revision) throw failWith('workflowChanged', {}, 'workflow changed elsewhere: reopen it before removing it')
      mine.keep(previous)
      mine.remove(String(id))
      return {}
    },

    /** AI translation (zh / en) with the default agent's model; cached per text. */
    async translate({ texts, lang }) {
      const items = (Array.isArray(texts) ? texts : []).map(t => String(t ?? ''))
      if (items.length > 300 || items.reduce((n, t) => n + t.length, 0) > 120000) throw new Error('too much text to translate at once')
      if (!LANGS[lang]) throw new Error(`unsupported language "${lang}"`)
      return { texts: await translator.translate(items, lang, AbortSignal.timeout(300000)), model: settings().translateModel }
    },
    async translateReport({ id, lang }) {
      const { markdown } = await ops.report({ id })
      return { markdown: await translator.markdown(markdown, lang, AbortSignal.timeout(600000)), model: settings().translateModel }
    },
  }

  // the home page's setup steps: the agents, each pack's connections, then what the packs add
  const setup = async () => {
    const steps = []
    const agents = hub?.agents?.() || []
    steps.push({
      id: 'workbench-agents', order: 20, required: true, ready: !!hub && agents.length > 0, panel: 'agent-hub',
      title: { en: 'Workbench: agents', zh: '工作台：智能体' },
      detail: !hub ? { en: 'Agent Hub is not running: enable the Agents plugin', zh: 'Agent Hub 没有运行：请启用「智能体」插件' }
        : !agents.length ? { en: 'No agent in the pool yet: add one on the Agents page', zh: '智能体池里还没有智能体：到「智能体」页添加' }
          : { en: `${agents.length} agent(s) in the pool`, zh: `智能体池里有 ${agents.length} 个智能体` },
    })
    for (const p of list()) {
      const mineNeeds = conns ? conns.needs().filter(n => n.owner === p.name.en) : []
      const broken = n => !['ok', 'untested'].includes(n.state)
      const missing = mineNeeds.filter(n => !n.optional && broken(n))
      if (mineNeeds.length) {
        const names = (ns, l) => ns.slice(0, 4).map(n => n.label?.[l] || n.need).join(l === 'zh' ? '、' : ', ') + (ns.length > 4 ? (l === 'zh' ? '……' : ', …') : '')
        steps.push({
          id: `workbench-${p.id}-connections`, order: 22, required: true, ready: !missing.length, panel: 'connectors',
          title: { en: `${p.name.en}: connections`, zh: `${p.name.zh}：连接` },
          detail: missing.length ? { en: `${missing.length} to fill in: ${names(missing, 'en')}`, zh: `还有 ${missing.length} 项要填：${names(missing, 'zh')}` } : { en: 'All set', zh: '都已就绪' },
        })
      }
      try { steps.push(...(await p.setup?.(packSettings(p.id)) || []).map(s => ({ order: 25, ...s }))) } catch (err) {
        ctx.logger?.warn?.(`ruyix-workbench: ${p.id} setup: ${err?.message || err}`)
        steps.push({ id: `workbench-${p.id}-setup-error`, order: 25, required: false, ready: false, title: { en: `${p.name.en}: setup check`, zh: `${p.name.zh}：设置检查` }, detail: { en: 'Could not check setup', zh: '暂时无法检查设置' } })
      }
    }
    return steps.sort((a, b) => a.order - b.order)
  }
  // the home page's tiles: what needs the person now, and how the runs do lately
  const overview = () => {
    const runs = store.list('run').filter(r => !r.archivedAt), byId = new Map(runs.map(r => [r.id, r]))
    const waiting = store.list('approval').filter(a => ['pending', 'failed'].includes(a.status) && byId.has(a.runId)).length
    const running = runs.filter(r => ['queued', 'running', 'waiting'].includes(r.status)).length
    const recent = runs.filter(r => ['done', 'failed'].includes(r.status) && r.endedAt).sort((a, b) => b.endedAt - a.endedAt).slice(0, 20)
    const rate = recent.length ? Math.round(100 * recent.filter(r => r.status === 'done' && r.verdict?.level === successOf(r)).length / recent.length) : null
    const open = (view, extra) => ({ event: `${PANEL}:open`, detail: { view, ...extra } })
    return [
      { id: 'workbench-now', order: 10, title: { en: 'Now', zh: '当前' }, tiles: [
        { id: 'approvals', value: waiting, tone: waiting ? 'warning' : 'neutral', label: { en: 'Waiting for your approval', zh: '等你批准' }, open: open('approvals') },
        { id: 'running', value: running, tone: running ? 'accent' : 'neutral', label: { en: 'Runs going', zh: '进行中的运行' }, open: open('runs', { scope: 'active' }) },
        { id: 'success', value: rate === null ? '—' : `${rate}%`, tone: 'success', label: { en: 'Recent success (last 20)', zh: '最近成功率（最近 20 次）' }, open: open('metrics') },
      ] },
    ]
  }
  const busy = () => [
    ...store.list('run').filter(r => ['running', 'queued'].includes(r.status)).map(r => `run ${r.id} (${r.template}): ${r.status}`),
    ...store.list('approval').filter(a => a.status === 'running').map(a => `approval ${a.id} (${a.action}, run ${a.runId})`),
  ]

  const assistant = setupAssistant(ctx, { engine, store, conv, ops, settings, home, workbench: { setup }, workflowNames: () => Object.keys(live), hub: () => hub, chatMcp, now, onCall, tasks, mineWorkflow: id => mine.get(String(id)) || null })
  const all = { ...ops, ...assistant }
  // the shell asks: what is at work, what setup lacks, the home page's tiles
  // (workbench.aiWork: the AI work done here — the box plugin finds it as parts().find(p => p.workbench?.aiWork))
  ctx.inject?.(['ruyixShell'], inner => inner.effect(() => inner.ruyixShell?.part?.({
    id: 'workbench', name: { en: 'Workbench', zh: '工作台' }, panel: PANEL, order: 20, busy, setup, overview, workbench: { aiWork: a => aiWorkOf(a) },
  }), 'ruyix-workbench: ruyix part'))
  // what the workbench has, for the system's one search (docs/design/agent-control.md; the shell's finders): the
  // workflows (the built-in ones and the person's), the runs, the portfolio's works — each saying how to act on it
  ctx.inject?.(['ruyixShell'], inner => {
    const f = inner.ruyixShell?.finders
    if (!f?.register) return
    for (const finder of workbenchFinders()) inner.effect(() => f.register(finder), `ruyix-workbench: finder ${finder.kind}`)
  })
  function workbenchFinders() {
    const said = (zh, en) => ({ zh, en }), word = t => (typeof t === 'string' ? t : t?.zh || t?.en || '')
    const STATE = { queued: '排着', running: '在做', waiting: '等你', done: '做完了', failed: '没做成', cancelled: '停了', interrupted: '停了（中断）' }
    const KIND = { file: '文件', draft: '稿子', image: '图片', video: '视频', report: '报告', post: '帖子', answer: '回答', card: '卡片' }
    const q = s => JSON.stringify(String(s))
    const howOpen = o => (o.ref?.run && o.ref.path ? `open_file { run: ${q(o.ref.run)}, file: ${q(o.ref.path)} }`
      : o.ref?.session && o.ref.path ? `open_file { session: ${q(o.ref.session)}, file: ${q(o.ref.path)} }`
        : o.ref?.run && o.ref.report ? `workbench_report { id: ${q(o.ref.run)} }`
          : o.url ? `its link (the person opens it): ${o.url}` : `task_look { id: ${q(o.task.id)} }`)
    return [{
      kind: 'workflow', title: said('工作流', 'Workflows'),
      find: () => [
        ...Object.values(live).map(wf => ({ id: `workflow:${wf.id}`, title: word(wf.title) || wf.id, hint: wf.pack ? `工作流 · ${wf.pack}` : '工作流', text: `${wf.description || ''} ${wf.id} workflow 工作流`, how: `workbench_start_run { workflow: ${q(wf.id)}, title, text } (workbench_workflows says what it asks for)` })),
        ...mine.list().map(d => ({ id: `workflow:${d.id}`, title: d.title || d.id, hint: d.status === 'enabled' ? '我的工作流' : '我的工作流 · 草稿', text: `${d.description || ''} ${d.id} workflow 工作流`, at: d.updatedAt,
          how: d.status === 'enabled' ? `workbench_start_run { workflow: ${q(d.id)}, title, text }` : `workflow_enable { id: ${q(d.id)} } first (a draft: the person enables it), then workbench_start_run` })),
      ],
    }, {
      kind: 'run', title: said('运行', 'Runs'),
      find: () => store.list('run').filter(r => !r.archivedAt).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)).slice(0, 300).map(r => ({
        id: `run:${r.id}`, title: r.subject?.title || r.template, hint: `${STATE[r.status] || r.status} · ${word(engine.workflowFor(r)?.title) || r.template}`,
        text: `${String(r.subject?.text || '').slice(0, 300)} ${r.id} 运行 run`, at: r.updatedAt || r.createdAt, how: `workbench_run { id: ${q(r.id)} }`,
      })),
    }, {
      kind: 'output', title: said('作品', 'Works'),
      find: async () => (await tasks.outputs({ limit: 300 })).outputs.map(o => ({
        id: `output:${o.id}`, title: o.title, hint: `${KIND[o.kind] || o.kind} · ${o.task.title}`, text: `${o.preview?.text || ''} ${o.category?.title || ''} 作品 产出 output`, at: o.at, how: howOpen(o),
      })),
    }]
  }
  // For other plugins: join with a pack, start and follow runs, read their reports.
  service = {
    registerPack,
    packs: () => list(),
    startRun: args => engine.startRun(args),
    /** The runs of a studio's records ({ studio, collection?, record? }; the `runsOf` op). */
    runsOf: args => ops.runsOf(args),
    startRuns: runs => ops.startRuns({ runs }),
    run: id => engine.get(String(id)),
    workflowOf: run => engine.workflowFor(run),
    runs: () => store.list('run'),
    /**
     * Every task (docs/design/agent-tasks.md) for other plugins — Agent Hub's sessions and jobs, the studios: create({ source,
     * title, agents?, studio?, links?, state? }), update(id, { state?, title?, agents?, waitingFor?, step?, result? } — step: what
     * it does now, result: how it ended, '…' or { zh, en }; a task whose source says them goes on past the conversation's
     * turn, and a conversation's is told there when it ends), addOutput(id, { kind,
     * title, ref?, thumb?, url?, by? }), link(id, { kind, id }), find({ kind, id }), get(id), registerSource(source, { revise,
     * stop?, remove?, timeline(task, lang 'zh' | 'en')? }), onChange(fn), and the task center's own: list, view, confirm, revise(id, text),
     * archive(id, archived = true), outputs; current(): the conversation's task while a turn of it runs (what the main agent
     * starts in that turn hangs off it), else null
     */
    tasks: {
      create: spec => tasks.make(spec), update: (id, patch) => tasks.change(id, patch), addOutput: (id, o) => tasks.addOutput(id, o), link: (id, l) => tasks.link(id, l),
      find: q => tasks.find(q), get: id => (tasks.get(id) ? tasks.viewOne(tasks.get(id)) : null), registerSource: (source, h) => tasks.registerSource(source, h), onChange: fn => tasks.onChange(fn),
      list: args => tasks.list(args), view: (id, lang) => tasks.view({ id, lang }), confirm: (id, run, expect) => tasks.confirm({ id, run, expect }), revise: (id, text, run, expect) => tasks.revise({ id, text, run, expect }),
      archive: (id, archived = true) => tasks.viewOne(tasks.archive({ id, archived })), outputs: args => tasks.outputs(args),
      current: () => assistant.chatTaskNow().id,
    },
    /** A pack may schedule an explicitly requested workflow through the normal task scheduler. */
    scheduleTask: spec => tasks.create({ ...spec, by: 'person' }),
    stopRun: id => engine.stopRun(String(id)),
    resumeRun: (id, opts) => engine.resumeRun(String(id), opts),
    report: async id => (await ops.report({ id })).markdown,
    approvals: runId => store.list('approval').filter(a => a.runId === runId),
    settings: () => settings(),
    packSettings: id => packSettings(String(id)),
    revision: () => store.revision(),
    evidence: (runId, after = 0) => store.evidence(String(runId), after),
    readArtifact: rel => store.readArtifact(rel, null),
    workflows: () => Object.values(live).map(infoOf),
    note: (id, entry) => engine.annotate(String(id), null, entry),
    /** One model call for a pack's own op ({ model: '<connection>:<model>' | 'dsh:<provider>/<model>', system, user, schema?, … }; see lib/models.js). */
    callModel: args => modelCalls.call({ kind: 'pack', ...args }),
    /** The AI work done here over the last `hours` (lib/aiwork.js). */
    aiWork: a => aiWorkOf(a),
    /** What a workflow needs and how it stands here (lib/needs.js). */
    readiness: (id, definition) => ops.workflowReadiness({ id, definition }),
    /** HTML as a PNG ({ html, width, height, scale? } → Buffer) and a run's live browsers (lib/browser.js), for a pack's own ops. */
    render: opts => browsers.render(opts),
    browsers: () => browsers,
    /** The connectors service (a pack's ops reach a connection: list a drive, start a transfer), when its plugin is on. */
    connectors: () => conns,
    busy, overview, setup,
  }
  ctx.provide('ruyixWorkbench', service)
  ctx.connection.fetch.register({
    path: '/api/ruyix-workbench',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const { op, ...args } = await request.json()
        const [packId, packOp] = String(op).includes('.') ? [String(op).slice(0, String(op).indexOf('.')), String(op).slice(String(op).indexOf('.') + 1)] : []
        const fn = packId ? (Object.hasOwn(packOps.get(packId) || {}, packOp) ? packOps.get(packId)[packOp] : null) : Object.hasOwn(all, op) ? all[op] : null
        if (typeof fn !== 'function') return Response.json({ error: `unknown op ${op}` }, { status: 400 })
        return Response.json(await fn(args))
      } catch (err) {
        // (a thing that is not there: 404 — an old link to a run, a task deleted meanwhile; the rest: 500)
        return Response.json({ error: err?.message || String(err), code: err?.code, params: err?.params }, { status: GONE.has(err?.code) ? 404 : 500 })
      }
    },
  })
  // A run's artifact as a stream, for <img>, <video>, <audio> (the `artifact` op inlines images only): the file a ledger entry
  // names, nothing else; Range for scrubbing. GET ?run=<id>&seq=<n>[&download=1]
  ctx.connection.fetch.register({
    path: '/api/ruyix-workbench/file',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch(request) {
      const q = new URL(request.url, 'http://ruyix.invalid').searchParams
      const id = q.get('run') || '', seq = Number(q.get('seq'))
      if (!id || !Number.isInteger(seq) || seq < 1) return Response.json({ error: 'give run and seq', code: 'badInput' }, { status: 400 })
      const e = engine.get(id) && store.evidenceAt(id, seq)
      const path = e?.seq === seq && e.artifact?.startsWith(`${id}/`) ? store.artifactPath(id, e.artifact) : null
      if (!path) return Response.json({ error: `no file at #${seq}`, code: 'noEvidence', params: { seq } }, { status: 404 })
      return fileResponse(path, { name: e.input?.name || basename(e.artifact), range: request.headers.get('range'), download: q.get('download') === '1' })
    },
  })
  // A file of a run's folder as a stream, for the viewer's <img>, <video>, <audio>, PDF (a big one is not inlined): those
  // kinds only — nothing a browser would run — or, download=1, any file to save; inside the folder, never through a
  // link; Range for scrubbing. GET ?run=<id>&path=<path in the folder>[&download=1]
  ctx.connection.fetch.register({
    path: '/api/ruyix-workbench/work',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch(request) {
      const q = new URL(request.url, 'http://ruyix.invalid').searchParams
      const r = engine.get(q.get('run') || ''), path = r && workPath(r, q.get('path') || '')
      if (!path) return Response.json({ error: 'no such file in the run\'s folder', code: 'noFile' }, { status: 404 })
      // (any file to save — download=1: an attachment, never shown)
      const download = q.get('download') === '1'
      if (!download && !/^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/|application\/pdf$)/.test(mimeOf(path))) return Response.json({ error: 'only images, video, audio and PDF are shown this way', code: 'badType' }, { status: 415 })
      return fileResponse(path, { name: basename(path), range: request.headers.get('range'), download })
    },
  })
  // A run's report on its own (the portfolio opens it alone in the viewer): its Markdown. GET ?run=<id>
  ctx.connection.fetch.register({
    path: '/api/ruyix-workbench/report',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const id = new URL(request.url, 'http://ruyix.invalid').searchParams.get('run') || ''
      if (!engine.get(id)) return Response.json({ error: 'no such run', code: 'noRun' }, { status: 404 })
      return new Response((await ops.report({ id })).markdown || '', { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } })
    },
  })
  // A file of the home folder for the person's viewer (open_file): inside it, nothing hidden (lib/file.js homeEntry);
  // shown as fileResponse shows anything — a type a browser would run comes as plain text. GET ?path=<in the home folder>
  ctx.connection.fetch.register({
    path: '/api/ruyix-workbench/hfile',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch(request) {
      const q = new URL(request.url, 'http://ruyix.invalid').searchParams
      let f = null
      try { f = homeEntry(q.get('path') || '') } catch (err) { return Response.json({ error: err.message, code: err.code }, { status: err.code === 'noFile' ? 404 : 403 }) }
      if (f.dir) return Response.json({ error: 'a folder: open its files', code: 'isFolder' }, { status: 400 })
      return fileResponse(f.full, { name: basename(f.full), range: request.headers.get('range'), download: q.get('download') === '1' })
    },
  })
  // A file of a resident session's folder as a stream, the same way (docs/design/agent-work.md §4: the viewer shows what a
  // session made). GET ?session=<id>&path=<path in its folder>[&download=1]
  ctx.connection.fetch.register({
    path: '/api/ruyix-workbench/sfile',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch(request) {
      const q = new URL(request.url, 'http://ruyix.invalid').searchParams
      let path = null
      try { path = workPath({ dir: sessionOf(q.get('session') || '').cwd }, q.get('path') || '') } catch { /* no such session */ }
      if (!path) return Response.json({ error: 'no such file in the session\'s folder', code: 'noFile' }, { status: 404 })
      const download = q.get('download') === '1'
      if (!download && !/^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/|application\/pdf$)/.test(mimeOf(path))) return Response.json({ error: 'only images, video, audio and PDF are shown this way', code: 'badType' }, { status: 415 })
      return fileResponse(path, { name: basename(path), range: request.headers.get('range'), download })
    },
  })
  // pdf.js for the viewer (vendor/pdfjs): the module and its worker, loaded when a PDF is first shown
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    ctx.connection.fetch.register({
      path: `/api/ruyix-workbench/pdfjs/${name}`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => new Response(readFileSync(join(HERE, 'vendor', 'pdfjs', name)), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } }),
    })
  }
  rebuild()
  return { engine, ops: all, service, registerPack, server, settings, store, conv, packOps }
}

// apply must not return a value — cordis would treat it as an effect.
export function apply(ctx, _config, options) {
  createWorkbench(ctx, options)
}
