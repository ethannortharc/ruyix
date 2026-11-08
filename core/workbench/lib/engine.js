// The workflow engine. Deterministic: step order, gates, retries and approvals are decided here; agents (Agent Hub
// agents) only do the judgement work inside a step. Every step outcome, tool call and approval lands in the run's
// evidence chain.
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { modelSteps, stepAgent, stepModel, workflowAgents } from './workflow-info.js'
import { expand, sh } from './settings.js'
import { LIMITS, checkFields, checkInput, decodeAttachments, dirOf } from './subject.js'
import { ALWAYS, both, tail } from './tools.js'
import { HELP_ROUNDS, chatBrief, humanOf, needPerson, talkBrief, talkTurn } from './human.js'
import { ASKED, TALK_MAX, answerOf } from './person.js'
import { compose } from './workflows.js'
import { createVersions } from './versions.js'
import { MESSAGE_TOOLS, SKILL_REF as MESSAGES_SKILL, messagesOn } from './messages.js'
/**
 * A step's clock that does not count the time it waited for the shared browser: `limit` ms, then onTimeout() — unless
 * waited() (ms waited so far) grew meanwhile: then it goes on for that much more. → { clear }
 */
export function stepClock(limit, waited, onTimeout, timers = { set: setTimeout, clear: clearTimeout }) {
  let credited = waited(), t = null
  const check = () => {
    const extra = waited() - credited
    if (extra > 500) { credited += extra; t = timers.set(check, extra) } else onTimeout()
  }
  t = timers.set(check, limit)
  return { clear: () => timers.clear(t) }
}
/** A workflow whose agent steps run in resident sessions (Agent Hub's; docs/design/sessions.md §2): `sessions: true`. */
export const sessionsOn = wf => !!(wf?.def?.sessions ?? wf?.sessions)
/**
 * A session's events since `since` folded as Agent Hub folds a task's (agentActivity): the tools at work, the last
 * ones done with their time, what it said last. → { tools, recent, said, saidAt, turnStartedAt }
 */
export function foldActivity(events = [], since = 0) {
  const act = { tools: [], recent: [], said: '', saidAt: null, turnStartedAt: since || null }
  for (const e of events) {
    const at = e.time || e.at || 0
    if (at < since) continue
    const d = e.data || {}
    if (e.type === 'tool/call') {
      let args = {}
      try { args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments || {} } catch { /* not JSON */ }
      const target = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'target', 'name', 'description'].map(k => args?.[k]).find(v => typeof v === 'string' && v.trim()) || ''
      act.tools.push({ callId: d.callId, name: d.name, target: String(target).slice(0, 90), at })
    } else if (e.type === 'tool/result') {
      const id = d.message?.toolCallId ?? d.message?.source?.callId
      const i = act.tools.findIndex(t => t.callId === id)
      if (i < 0) continue
      const [call] = act.tools.splice(i, 1)
      act.recent = [...act.recent, { name: call.name, target: call.target, ms: Math.max(0, at - call.at), ok: !d.message?.isError, at }].slice(-6)
    } else if (e.type === 'assistant/message') {
      const text = (Array.isArray(d.message?.content) ? d.message.content : []).filter(b => b?.type === 'text').map(b => b.text).join(' ').trim()
      if (text) { act.said = text.slice(0, 160); act.saidAt = at }
    } else if (e.type === 'turn/end') act.tools = []
  }
  return act
}
/** How large a session's context may grow (tokens of a turn's prompt) before a step takes a fresh one, by runtime. */
export const SESSION_CONTEXT = { claude: 150000, codex: 120000, pi: 100000 }
import { createBrowsers } from './browser.js'

export const DONE = new Set(['done', 'failed', 'cancelled', 'interrupted'])
// A question the person asks the agent of a step that waits for them is a task under this pseudo-step: it reads the run's record, nothing else.
const ASK_STAGE = 'ask', ASK_TOOLS = ['wb_context', 'evidence_get']
// An agent whose step ran out of time gets one short turn to hand in what it has.
const GRACE_MS = 10 * 60e3
const TIME_UP = 'Time is up for this step. Stop what you are doing and call stage_result now with what you have done and what is still open. Start nothing new.'
const SESSION_REMINDER = 'You ended this step without calling the stage_result tool, so the workbench has no result. The work you did is in your folder and the ledger: do not redo it. Call stage_result now with the outcome.'
const TIME_UP_FRESH = '## Time is up\nThe previous attempt at this step ran out of time. Its work is in your folder and in the ledger (wb_context): do not redo it. Read what was done and call stage_result now — what was done, what is still open. Start nothing new.'
const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
// a card's fields a person's answer cannot change
const FIXED = ['options', 'recommended', 'kind', 'stage', 'blocking', 'by', 'person', 'wait', 'deadline', 'remindedAt', 'rev']
/** The nudge for a resumed CLI session: it already has the task and its history. */
export const RESUME_PROMPT = why => `${why === 'restart' ? 'dsh restarted while you were working on this task' : `Your previous attempt at this task stopped (${why})`}. The workbench tools are available again. Continue the same task from where you stopped: do not redo what is already done; if your last tool call has no result, run it again. Finish with stage_result as the task asks.`
/** What an interrupted attempt had done, for whoever picks the step up (L2): its evidence and its last words. */
export function resumeHandoff({ old, evidence = [], why }) {
  const said = String(old?.act?.said || old?.output || '').trim()
  if (!old && !evidence.length) return ''
  return [
    `## Picking up an interrupted attempt\nThe previous attempt at this step${old ? ` (task ${old.id}, ${old.runtime}${old.model ? ` ${old.model}` : ''})` : ''} ${why === 'restart' ? 'was cut short by a dsh restart' : why ? `ended: ${why}` : 'stopped'}.`,
    evidence.length ? `What it had already done (evidence of this run):\n${evidence.slice(-40).map(e => `- #${e.seq} ${e.kind}${e.ok === false ? ' ✗' : ''} · ${e.title}`).join('\n')}` : '',
    said ? `Its last message:\n${said.slice(-1500)}` : '',
    'Build on this: read the evidence you need (evidence_get), do not redo what is done, re-run a step that has no result.',
  ].filter(Boolean).join('\n\n')
}
const shortId = p => `${p}${randomUUID().slice(0, 7)}`
/** A run's own parameters for its script steps: { [step]: { [name]: text | number | yes/no } } (what a step does not declare is not read). */
/** A studio's record a run starts from: { id, collection, record } (ids of 1–80 word characters, dots, dashes), else null. */
export const studioRef = v => {
  if (!v || typeof v !== 'object') return null
  const ok = x => typeof x === 'string' && /^[\w.-]{1,80}$/.test(x)
  return ok(v.id) && ok(v.collection) && ok(v.record) ? { id: v.id, collection: v.collection, record: v.record } : null
}
const paramsOf = v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out = Object.fromEntries(Object.entries(v).slice(0, 20).filter(([k, p]) => /^[a-z][a-z0-9-]{1,39}$/.test(k) && p && typeof p === 'object' && !Array.isArray(p))
    .map(([k, p]) => [k, Object.fromEntries(Object.entries(p).slice(0, 20).filter(([n, x]) => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(n) && ['string', 'number', 'boolean'].includes(typeof x)).map(([n, x]) => [n, typeof x === 'string' ? x.slice(0, 2000) : x]))]))
  return Object.keys(out).length ? out : null
}

/**
 * workflow(id): a built-in workflow by its id ('blank', '<pack>.<id>'), also one whose pack has left (its runs go on);
 * live(id): only those a new run may start on; custom(id): a person's enabled definition; packOf(workflow): the pack a
 * workflow belongs to; toolNames(workflow): the tools its steps may use (when a step lists none); callTool(context, name,
 * args); skillsAtStart(workflow) → { versions }; stageSkills(workflow, step) → refs. settleMs: how often a blocking
 * decision is looked at; resumeDelayMs: how long after the start interrupted runs are resumed; timeoutMs, graceMs: a step's
 * time and the short turn after it (the settings' agentTimeoutMinutes and ten minutes, unless given — the self-check does).
 * models: lib/models.js's createModels — what a model step calls. prepare(workflow, definition | null): before a run is
 * made, what the workflow needs is got ready here (lib/needs.js) — it throws, saying what is missing, when it cannot be;
 * bindConn(need, workflowId) → { connection }: the connection this machine binds a script step's need to; toolbox
 * (lib/toolbox.js): where a step's command-line tools are put in place (none: every tool counts as there). versions
 * (lib/versions.js): the run folders' versions — one per step (default: a shadow Git repository per run, in the store's home).
 * browsers (lib/browser.js): browsers a step or a card opens that the person watches and takes over on the run's page.
 */
export function createEngine({ store, settings, hub, mcp, sharedBrowser = () => null, models = null, workflow, live = workflow, custom = () => null, packOf = () => null, toolNames = () => [], callTool, scripts = null, exec = sh, logger, services = {}, skillsAtStart = async () => ({}), stageSkills = () => [], prepare = async () => {}, bindConn = async () => ({ connection: null }), toolbox = null, versions = createVersions({ root: store.dir, logger }), browsers = null, onRunStart = () => {}, onRunResume = () => {}, onRunEnd = () => {}, settleMs = 3000, resumeDelayMs = 15000, timeoutMs, graceMs = GRACE_MS }) {
  const restarting = new Set() // a person's rewind/continue owns the run until it has restarted
  const active = new Map() // run id → { controller, members: step → the agent working on it (a parallel block: several) }
  const editing = new Set() // real folder → a person's edit, including the files derived from it
  const tokens = new Map() // MCP token → { runId, stage }: each step's agent gets its own, so its tools act on its step
  const leadRuns = new Map() // headless Lead session → run id (its dsh agents get the tools)

  const get = id => store.get('run', id)
  const update = (id, change) => {
    const r = get(id)
    return store.put('run', typeof change === 'function' ? change(r) : { ...r, ...change })
  }
  // A render/review can change files without editFile or finishing its current step. Every write checkpoint
  // invalidates previously seen feedback, including files too large for Git and runs with versions disabled.
  // This counter is deliberately conservative: even an unchanged/failed snapshot may have unversioned edits.
  const fileVersions = versions
  versions = { ...fileVersions, ...Object.fromEntries(['snapshot', 'edit', 'rewind'].filter(key => typeof fileVersions[key] === 'function').map(key => [key, async (run, ...args) => {
    try { return await fileVersions[key](run, ...args) }
    finally {
      if (get(run.id)) update(run.id, r => ({ ...r, contentRevision: (Number.isSafeInteger(r.contentRevision) ? r.contentRevision : 0) + 1 }))
    }
  }])) }
  /** What the engine and the packs make themselves (cards, renders, exports' sources): runs/<id>/out, next to the agents' folder (`dir`, runs/<id>/work), never inside it. */
  const outDirOf = r => {
    const dir = r.outDir || join(dirname(r.dir), 'out')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const settingsForRun = id => {
    const r = get(id)
    if (!r) throw fail('noRun', { id }, `no run ${id}`)
    return r.config || update(id, { config: structuredClone(settings()) }).config
  }
  const patchStage = (id, key, patch) => update(id, r => ({ ...r, stages: r.stages.map(s => (s.key === key ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s)) }))
  /** One ledger entry. `full` (text or bytes) is stored as an artifact the entry names by path and hash; `name` keeps a file's own name in it. */
  const record = (runId, entry) => {
    const { full, ext = '.txt', name, ...rest } = entry
    const art = full !== undefined && full !== null ? store.artifact(runId, name ? `${rest.kind}-${randomUUID().slice(0, 6)}-${name}` : `${rest.kind}-${Date.now().toString(36)}${randomUUID().slice(0, 4)}${ext}`, Buffer.isBuffer(full) ? full : String(full)) : {}
    return store.addEvidence(runId, { ...rest, ...art })
  }
  const recordCommand = (runId, stage, title, r, input) =>
    record(runId, { stage, kind: 'command', title: `${title} → exit ${r.code}`, input, output: tail(both(r)), code: r.code, ok: r.code === 0, full: both(r) })

  // a run's workflow: a built-in one by its id, a person's from the definition the run started with (on its base)
  const baseOf = id => workflow(id)
  const wfOf = r => {
    if (!r) return undefined
    if (r.workflowDef) { const base = baseOf(r.workflowDef.base); return base && compose(r.workflowDef, base) }
    return workflow(r.template)
  }
  const workflowOf = runId => {
    const wf = wfOf(get(runId))
    if (!wf) throw fail('noWorkflow', { id: get(runId)?.template }, `the workflow ${get(runId)?.template} is not available (its pack is not loaded)`)
    return wf
  }
  const toolContext = (runId, { actor, stage, signal } = {}) => {
    const run = get(runId), wf = wfOf(run), pack = packOf(wf)
    const st = stage ?? run.stage
    const config = settingsForRun(runId)
    return {
      run, store, workflow: wf, stage: st, actor: actor ?? active.get(runId)?.members?.get(st) ?? 'agent', signal, services, settings: config, pack, packSettings: pack && config.packs?.[pack.id],
      def: wf?.stages.find(s => s.key === st) || null, // the step as the workflow defines it (what its result must hold)
      record: entry => record(runId, { stage: st, actor: actor ?? active.get(runId)?.members?.get(st) ?? 'agent', ...entry }),
      update: change => update(runId, change),
      approval: spec => createApproval(runId, spec),
      tools: toolsOf(runId, st),
    }
  }

  /** A run's browser (lib/browser.js) for a step or a card: opened for this run, its moments kept in the ledger. */
  const browserFor = (runId, stage) => ({
    open: opts => { if (!browsers) throw fail('noBrowser', {}, 'no browser here'); return browsers.open({ ...opts, run: runId, stage }) },
    /** HTML as a PNG (a card, a cover): { html, width, height, scale? } → Buffer. */
    render: opts => { if (!browsers) throw fail('noBrowser', {}, 'no browser here'); return browsers.render(opts) },
    step: (id, text) => browsers?.step(id, text),
    shot: (id, title) => browsers?.shot(id, title),
    close: (id, why) => browsers?.close(id, why),
    /**
     * The agents' shared browser for a card's action (docs/design/browser.md): signed in where the person signed in; one
     * at a time (waitTurn / give), the last click handed to the person (handoff). → { ensure, waitTurn, give, handoff, own,
     * connect(endpoint) → Playwright's browser } or null (not here, or not up to it: the action does what it did before)
     */
    shared: () => {
      const svc = sharedBrowser()
      if (!svc?.available?.() || !browsers?.attach) return null
      return { ensure: () => svc.ensure(), waitTurn: o => svc.waitTurn(o), give: who => svc.give(who), handoff: (who, why) => svc.handoff(who, why), own: (id, who) => svc.own?.(id, who), connect: endpoint => browsers.attach(endpoint) }
    },
  })

  // ── command-line tools (lib/toolbox.js): put in place when a step needs them, or said missing with how a person puts
  // them in place — on the run (run.tools: its report says them) and in the ledger ──
  /** The tools' start-up refresh done (or none to wait for) → true; stopped meanwhile → false. */
  const toolsReady = signal => (!toolbox?.ready ? Promise.resolve(!signal.aborted)
    : Promise.race([toolbox.ready.catch(() => {}).then(() => !signal.aborted), new Promise(resolve => (signal.aborted ? resolve(false) : signal.addEventListener('abort', () => resolve(false), { once: true })))]))
  /**
   * What the processes of a step get beyond dsh's own environment: the directories and variables of the tools put in place
   * (the toolbox's env()). Never merged into dsh's own PATH — what an agent installed must not shadow dsh's own commands.
   */
  const toolEnv = () => toolbox?.env?.() || {}
  /**
   * Whether a step's agent may install a tool: only when every agent working in the step may change files (write or full).
   * A read-only reviewer — one a prompt injection could steer — gets no tools_ensure. step → task → access.
   */
  const stageAccess = new Map()
  const mayInstall = (runId, stage) => { const m = stageAccess.get(`${runId}\0${stage}`); return !!m?.size && [...m.values()].every(a => ['write', 'full'].includes(a)) }
  const toolsOf = (runId, stage) => ({
    /** → toolbox.need's result; `by`: the step's own list, or an agent's ask. */
    async need(want, { by = 'step' } = {}) {
      // (a stop ends the wait — the step's own tools, an agent's — the shared install goes on by itself)
      const signal = active.get(runId)?.controller?.signal
      const stopped = signal && new Promise((_, no) => { const end = () => no(new Error('cancelled')); if (signal.aborted) end(); else signal.addEventListener('abort', end, { once: true }) })
      const res = toolbox ? await (stopped ? Promise.race([toolbox.need(want, { by }), stopped]) : toolbox.need(want, { by })) : { want, bin: want, status: 'ok' }
      if (res.status === 'ok' && by !== 'agent') return res
      const t = { name: res.want, bin: res.bin, stage, by, status: res.status, at: Date.now(), ...(res.version && { version: res.version }), ...(res.error && { error: String(res.error).slice(0, 300) }), ...(res.how && { how: res.how }) }
      update(runId, r => ({ ...r, tools: [...(r.tools || []).filter(x => !(x.name === t.name && x.stage === stage)), t].slice(-60) }))
      if (res.status !== 'ok') {
        record(runId, { stage, actor: 'system', kind: 'tool', title: `tool ${res.want}: ${res.status === 'installed' ? `installed ${res.version || ''} (mise)` : `missing — ${res.error || res.how?.text || ''}`}`.slice(0, 300),
          input: { tool: res.want, by }, output: res.how ? `${res.how.text}${res.how.cmd ? `\n${res.how.cmd}` : ''}` : res.path || '', ok: res.status === 'installed' })
      }
      return res
    },
    /**
     * A login shell's first line: what mise installed first on its PATH again (a login shell's profile puts the home's own
     * bin directories first, where an older copy of a tool may sit). Empty until mise has put something in place.
     */
    shell: () => { const e = toolEnv(); return e.RUYIX_TOOLS_PATH ? `export PATH='${String(e.PATH || '').replace(/'/g, "'\\''")}':"$PATH"\n` : '' },
    /** A shell line that brings a shell opened before up to what mise selected now (its PATH and variables). */
    activation: () => toolbox?.activation?.() || '',
    /** What a person reads when a tool is not here: "<tool> is not installed — <how>". */
    missingNote: (want, res) => `${want} is not installed${res?.how ? ` — ${res.how.text}${res.how.cmd ? ` (\`${res.how.cmd}\`)` : ''}` : ''}`,
  })

  // ── Agent Hub: one headless job per run; each step's task goes to the agent the step names ──
  const needHub = () => hub() ?? (() => { throw fail('noHub', {}, 'the agents plugin (Agent Hub) is not running — enable it') })()
  const ensureJob = async runId => {
    const h = needHub()
    const r = get(runId)
    const current = r.jobId && h.job(r.jobId)
    if (current?.status === 'running') return current
    const wf = workflowOf(runId)
    const subject = r.subject?.title || wf.title
    // the agents this workflow's steps use (and their fallbacks) are checked here, before anything starts
    const j = await h.startJob({
      headless: true, cwd: dirOf(r), title: `${subject} · ${r.id}`, agents: workflowAgents(wf, settingsForRun(runId)),
      goal: `ruyix-workbench ${r.template} run ${r.id}: ${subject}. The workbench engine assigns each step's task.`,
    })
    leadRuns.set(j.leadId, runId)
    update(runId, { jobId: j.id, leadId: j.leadId })
    return j
  }
  // (`keep`: a resident session's token — it keeps the one its process started with, pointed at the step it works on now)
  const mcpFor = async (runId, stage, keep = null) => {
    let token = keep || [...tokens].find(([, t]) => t.runId === runId && t.stage === stage)?.[0]
    if (keep || !token) tokens.set(token = token || randomUUID(), { runId, stage })
    // under the DeepSeek Harness app process.execPath is Electron: it runs the bridge as Node only with ELECTRON_RUN_AS_NODE
    const node = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
    const url = await mcp.url()
    // the tools answer the way the agent's MCP server asks them (else the stage stops here, saying why — never an agent
    // left with no tools, its stage ending without a result)
    if (mcp.probe) await mcp.probe(token).catch(err => { throw new Error(`the workbench's tools do not answer at ${url} (${err.message}): the agent would have none`) })
    return { name: mcp.name, command: process.execPath, args: [mcp.script], env: { ...node, RUYIXWB_URL: url, RUYIXWB_TOKEN: token, RUYIXWB_NAME: mcp.name } }
  }
  /** A step's agent has no business with the run once the step is over (passed, failed, skipped, cancelled): its token goes. */
  const revokeTokens = (runId, stage) => { for (const [token, t] of tokens) if (t.runId === runId && t.stage === stage) tokens.delete(token) }
  const sleep = (ms, signal) => new Promise(res => {
    const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); res() } // no listener left behind per nap
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
  const untilAborted = signal => new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('cancelled'))
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  })
  /** One task for a step, for the agent its role has there; it must hand back a stage_result (one reminder, then the step fails). */
  // opts.skills: skills for this task beyond the step's (a run's own choice, e.g. a style); opts.web (or the step's `web`):
  // the task may search the web; opts.pins: the skill packs at the commits (versions) the workflow carries; opts.step: the
  // step whose agent it is (a question about a step: its agent, under the pseudo-step `ask`); opts.access: narrower than the role's;
  // opts.signal: a stop of its own besides the run's (a script step's: a person stopped it, its script ended) — the task is cancelled
  // ── the shared browser (Ruyix's agents' browser, the apps plugin's; docs/design/browser.md): a step that uses it
  // (`browser: 'shared'`) takes turns with every other agent — the time it waits for its turn is not its own; when its
  // agent hands the last step to the person (publish, pay, send…), the run asks the person, on a card, and waits ──
  const browserWaits = new Map() // run → { total, since }
  const handed = new Set()
  let browserOff = null
  const waitedFor = runId => { const w = browserWaits.get(runId); return w ? w.total + (w.since ? Date.now() - w.since : 0) : 0 }
  const onBrowser = st => {
    const now = Date.now(), queued = new Set((st?.queue || []).map(q => String(q.of || '')).filter(o => o.startsWith('run:')).map(o => o.slice(4)))
    for (const id of queued) { const w = browserWaits.get(id) || { total: 0, since: null }; if (w.since === null) w.since = now; browserWaits.set(id, w) }
    for (const [id, w] of browserWaits) if (!queued.has(id) && w.since !== null) { w.total += now - w.since; w.since = null }
    // a hand-off by one of our steps' agents: a blocking decision of that step (asked once per hand-off)
    const h = st?.holder
    if (!h?.waiting || !String(h.of || '').startsWith('run:')) return
    const runId = String(h.of).slice(4), r = get(runId)
    if (!r || !active.has(runId) || handed.has(`${h.who}:${h.since}`)) return
    handed.add(`${h.who}:${h.since}`)
    const id = String(h.who || '').replace(/^(task|session):/, '')
    const stage = r.stages.find(s => s.status === 'running' && ((s.tasks || []).includes(id) || s.session === id))?.key || r.stage
    const why = String(h.why || h.waiting || 'the last step is yours').slice(0, 600)
    createApproval(runId, { action: 'decision', title: `${r.stages.find(s => s.key === stage)?.title || stage}: in the agents' browser, your turn`,
      payload: { why: `The agent stopped before a step that is yours to take (${why}). Do it in the agents' browser, then go on here.`, options: [{ label: 'Done — go on', action: 'continue', does: 'the run goes on from here' }, { label: 'Stop the run', action: 'stop', does: 'nothing after this step runs' }], recommended: null, blocking: true, stage, by: 'workflow', browser: 'shared' } })
    record(runId, { stage, actor: 'system', kind: 'gate', title: `${stage}: handed to the person in the agents' browser — ${why}`, ok: true })
  }
  const watchBrowser = () => { if (!browserOff) { const svc = sharedBrowser(); if (svc?.subscribe) browserOff = svc.subscribe(onBrowser) || (() => {}) } }
  /** Whether a step may have the shared browser here: { shared } — or it throws when it needs one logged in and there is none. */
  const sharedFor = (runId, stage, wf) => {
    const def = wf.stages.find(s => s.key === stage)
    if (def?.browser !== 'shared') return { shared: false }
    const svc = sharedBrowser()
    if (svc?.available?.()) { watchBrowser(); return { shared: true } }
    if (def.login) throw fail('noSharedBrowser', { stage }, `${stage} needs the agents' browser (where you are signed in), which is not here: App Center → 智能体浏览器`)
    record(runId, { stage, actor: 'system', kind: 'gate', title: `${stage}: the agents' browser is not here — the step goes on without it`, ok: false })
    return { shared: false }
  }

  // ── a step in a resident session (a workflow with `sessions: true`) ──
  const sessionTokens = new Map() // session → the token its process started with
  const sessionClaims = new Set() // reserved before any await; held through a step's reminder turn
  /**
   * The session a step may go on in (§2a): one this run opened for the same agent of the pool — and the same role, for a
   * pack's named roles (a person's workflow: each agent step is its own role, so any of them) — idle, its context under
   * the cap, that did only steps before this one: not this step or a later one (a rewind, a send-back — what it knows
   * would mislead). A step marked `session: 'fresh'` takes a new one; one that may do less (a read-only check after a
   * writing step) gets a new one from Agent Hub (its spec differs). → session id or null
   */
  const sessionFor = (runId, stage, member, agent) => {
    const h = needHub(), r = get(runId), wf = workflowOf(runId)
    if (wf.stages.find(s => s.key === stage)?.session === 'fresh') return null
    const order = r.stages.map(s => s.key), here = order.indexOf(stage)
    const ownRole = m => order.includes(m) // (a step that is its own role)
    for (const s of [...(r.sessions || [])].reverse()) {
      if (sessionClaims.has(s.id)) continue
      const sameRole = s.member === member || (ownRole(s.member) && ownRole(member))
      if (!sameRole || s.agent !== agent || s.steps.some(k => order.indexOf(k) >= here)) continue
      const info = h.sessionInfo?.(s.id)
      if (info && info.state === 'idle' && !info.error && (info.context || 0) <= (SESSION_CONTEXT[info.runtime] || 100000)) return s.id
    }
    return null
  }
  /** One turn of a step in a session (going on in one, or a new one): → { id, reused, out, info } */
  const inSession = async (runId, stage, member, who, task, { title, skills, pins, env, access, stop, limit, web, browser, claims }) => {
    const h = needHub(), r = get(runId), wf = workflowOf(runId)
    const reuse = sessionFor(runId, stage, member, who.agent)
    if (reuse) { sessionClaims.add(reuse); claims.add(reuse) }
    const mcp = await mcpFor(runId, stage, reuse ? sessionTokens.get(reuse) : null)
    if (stop.aborted) throw new Error('cancelled')
    const spec = { agent: who.agent, access, cwd: dirOf(r), instructions: who.text, ...(skills.length && { skills }), ...(pins && { pins }), ...(env && { env }), ...(web && { web: true }), ...(browser && { browser: true }), mcp, title: `${r.subject?.title || wf.title} · ${member}`, of: { run: runId, step: stage } }
    let opened
    try { opened = await h.openSession({ ...spec, ...(reuse && { reuse }) }) } catch (err) {
      if (!reuse || err.code !== 'sessionMismatch') throw err
      // it cannot go on there (it may do more, or another model): a new session, with a token of its own — the old
      // session's goes until that one is used again
      tokens.delete(mcp.env.RUYIXWB_TOKEN)
      spec.mcp = await mcpFor(runId, stage, randomUUID())
      opened = await h.openSession(spec)
    }
    sessionClaims.add(opened.id); claims.add(opened.id)
    sessionTokens.set(opened.id, spec.mcp.env.RUYIXWB_TOKEN)
    const list = [...(get(runId).sessions || [])], i = list.findIndex(x => x.id === opened.id)
    if (i < 0) list.push({ id: opened.id, member, agent: who.agent, steps: [stage] })
    else list[i] = { ...list[i], steps: [...new Set([...list[i].steps, stage])] }
    update(runId, { sessions: list })
    patchStage(runId, stage, { session: opened.id })
    record(runId, { stage, actor: 'system', kind: 'gate', title: `${member}: ${title} in session ${opened.id}${opened.reused ? ' (going on: it did ' + list.find(x => x.id === opened.id).steps.filter(k => k !== stage).join(', ') + ')' : ' (new)'}`, ok: true })
    // the step's time (not the time it waited for the shared browser): when it is up, one short turn in the session to hand in
    const ctl = new AbortController()
    let up = false, out
    const clock = stepClock(limit, () => waitedFor(runId), () => { up = true; ctl.abort() })
    try { out = await h.askSession(opened.id, task, { signal: AbortSignal.any([stop, ctl.signal]), of: { run: runId, step: stage } }) } catch (err) {
      if (!up || stop.aborted) throw err
      record(runId, { stage, actor: 'system', kind: 'gate', title: `${member}: the step's time is up — one short turn to hand in what is done (its session)`, ok: false })
      out = await h.askSession(opened.id, TIME_UP, { signal: stop, timeoutMs: graceMs, of: { run: runId, step: stage } })
    } finally { clock.clear() }
    return { id: opened.id, reused: !!opened.reused, out, info: h.sessionInfo?.(opened.id) || {} }
  }
  /** The run is over: the processes of the sessions it opened end (the sessions stay, to be read). */
  const closeSessions = runId => {
    const h = hub()
    for (const s of get(runId)?.sessions || []) { try { h?.closeSession?.(s.id) } catch { /* already closed */ } sessionTokens.delete(s.id) }
  }

  const askTasks = new Map() // task id → run (several waiting steps may answer questions concurrently; all use ASK_TOOLS)
  const askAgent = async (runId, stage, member, brief, { title = stage, needResult = true, skills: extraSkills = [], web, pins, step, access, signal, token } = {}) => {
    const h = needHub()
    const a = active.get(runId)
    const stop = signal ? AbortSignal.any([a.controller.signal, signal]) : a.controller.signal
    const wf = workflowOf(runId)
    const who = stepAgent(wf, step || stage, settingsForRun(runId), member)
    if (!who) throw fail('noRole', { role: member }, `the ${wf.id} workflow has no role "${member}"`)
    let task = brief
    // Picking up an interrupted (or failed) attempt of this step: once, on the first task of the step.
    const rs = get(runId).stages.find(s => s.key === stage)?.resume
    let resume = null
    if (rs) {
      patchStage(runId, stage, { resume: null })
      const old = rs.taskId ? h.task?.(rs.taskId) : null
      const done = store.evidence(runId).filter(e => e.stage === stage && rs.startedAt && e.at >= rs.startedAt && e.kind !== 'gate')
      const handoff = resumeHandoff({ old, evidence: done, why: rs.why })
      if (handoff) task = `${brief}\n\n${handoff}`
      resume = { level: old?.sessionId && old.member === member && ['claude', 'codex'].includes(old.runtime) ? 3 : handoff ? 2 : 1, extra: old ? { taskId: old.id, ...(old.sessionId && { sessionId: old.sessionId, runtime: old.runtime, prompt: RESUME_PROMPT(rs.why) }) } : null }
    }
    // a workflow whose steps run in resident sessions: this one in a session — on any trouble, as a task after all
    // (a fallback agent, a resume, the time's-up turn: the task path knows them)
    const inProc = id => id && h.agent?.(id)?.runtime === 'dsh'
    const { shared } = stage === ASK_STAGE ? { shared: false } : sharedFor(runId, stage, wf)
    if (sessionsOn(wf) && h.openSession && stage !== ASK_STAGE && !resume && !inProc(who.agent)) {
      const minutes = settingsForRun(runId).agentTimeoutMinutes
      const skills = [...new Set([...stageSkills(wf, step || stage), ...who.skills, ...extraSkills, ...(messagesOn(wf) ? [MESSAGES_SKILL] : [])])]
      const online = web ?? !!wf.stages.find(s => s.key === stage)?.web
      const tools = toolEnv(), acc = access || who.access
      const accessKey = `${runId}\0${stage}`, mark = `session:${stage}:${Date.now()}`, claims = new Set()
      if (!stageAccess.has(accessKey)) stageAccess.set(accessKey, new Map())
      stageAccess.get(accessKey).set(mark, acc)
      a.members.set(stage, member)
      try {
        patchStage(runId, stage, { result: null })
        const s = await inSession(runId, stage, member, who, task, { title, skills, pins, env: tools.PATH ? tools : null, access: acc, stop, limit: timeoutMs ?? minutes * 60000, web: online, browser: shared, claims })
        const what = `${s.info.runtime || ''}${s.info.model ? ` ${s.info.model}` : ''}`.trim()
        patchStage(runId, stage, { agent: { role: member, id: who.agent, runtime: s.info.runtime || null, model: s.info.model || null, at: Date.now() } })
        const log = (o, label) => record(runId, {
          stage, actor: member, kind: 'agent', title: `${member} (${who.agent}${what ? `: ${what}` : ''}): ${label} — done in session ${s.id}`,
          input: { session: s.id, agent: who.agent, runtime: s.info.runtime || null, model: s.info.model || null, tokens: o.tokens ?? null, cost: o.cost ?? null },
          output: tail(o.output || ''), ok: true, full: o.output || '(no report)',
        })
        log(s.out, title)
        let result = get(runId).stages.find(x => x.key === stage)?.result
        if (!result && needResult) {
          // it ended without stage_result: one reminder, in the same session (it still has the work in mind)
          const again = await h.askSession(s.id, SESSION_REMINDER, { signal: stop, timeoutMs: Math.min(graceMs, timeoutMs ?? minutes * 60000), of: { run: runId, step: stage } })
          log(again, `${title} (reminded to call stage_result)`)
          result = get(runId).stages.find(x => x.key === stage)?.result
        }
        if (result || !needResult) return { task: { status: 'done', output: s.out.output || '', agent: who.agent, runtime: s.info.runtime, model: s.info.model, session: s.id }, result, report: s.out.output || '' }
        throw new Error(`${member} did not hand back a stage result in session ${s.id}`)
      } catch (err) {
        if (stop.aborted) throw err
        record(runId, { stage, actor: 'system', kind: 'gate', title: `${member}: the step could not run in a session (${err.code || ''}${err.code ? ': ' : ''}${String(err.message).slice(0, 200)}) — as a task instead`, ok: false })
      } finally {
        for (const id of claims) sessionClaims.delete(id)
        { const m = stageAccess.get(accessKey); m?.delete(mark); if (m && !m.size) stageAccess.delete(accessKey) }
        a.members.delete(stage)
      }
    }
    let grace = null // the step's time ran out once: one short turn to hand in what is done
    for (let attempt = 0; attempt < 2; attempt++) {
      const job = await ensureJob(runId)
      const mcp = await mcpFor(runId, stage, token)
      // stopped while those were awaited: no task for a run that is over
      if (stop.aborted) throw new Error('cancelled')
      a.members.set(stage, member)
      patchStage(runId, stage, { result: null })
      const again = grace ? grace.extra : attempt === 0 && resume?.extra
      // (a workflow whose agents message each other: every one of them is told how — lib/messages.js)
      const skills = [...new Set([...stageSkills(wf, step || stage), ...who.skills, ...extraSkills, ...(messagesOn(wf) && stage !== ASK_STAGE ? [MESSAGES_SKILL] : [])])]
      const online = web ?? !!wf.stages.find(s => s.key === stage)?.web
      // the tools put in place go into the environment of the agent's own processes (a CLI agent; dsh's in-process agent has
      // no environment of its own: it runs the activation line tools_ensure gives it)
      const tools = toolEnv(), inProcess = [who.agent, who.fallback].some(id => id && h.agent?.(id)?.runtime === 'dsh')
      const t = h.assign(job.id, { agent: who.agent, fallback: who.fallback, role: member, instructions: who.text, access: access || who.access, task, title },
        { by: 'workbench', mcp, ...(skills.length && { skills }), ...(online && { web: true }), ...(again && { resume: again }), ...(pins && { pins }), ...(tools.PATH && !inProcess && { env: tools }), ...(shared && { browser: true, of: `run:${runId}`, dirs: [dirOf(get(runId))] }) })
      // what the task may do, which decides whether its agent has tools_ensure (the pool agent's own access wins in the hub)
      const accessKey = `${runId}\0${stage}`
      if (!stageAccess.has(accessKey)) stageAccess.set(accessKey, new Map())
      stageAccess.get(accessKey).set(t.id, t.access || access || who.access)
      // who works on it now (the page shows it while the step runs; the ledger says it when the task is over)
      const pool = h.agent?.(t.agent || who.agent)
      patchStage(runId, stage, s => ({ tasks: [...(s.tasks || []), t.id], ...(stage !== ASK_STAGE && { agent: { role: member, id: t.agent || who.agent, runtime: t.runtime || pool?.runtime || null, model: t.model || pool?.model || null, at: Date.now() } }) }))
      if (stage === ASK_STAGE) askTasks.set(t.id, runId)
      let done, timer, timedOut = false
      const minutes = settingsForRun(runId).agentTimeoutMinutes, full = timeoutMs ?? minutes * 60000
      const limit = grace ? Math.min(graceMs, full) : full
      try {
        done = await Promise.race([
          h.whenTaskDone(t.id), untilAborted(stop),
          new Promise((_, reject) => { timer = stepClock(limit, () => waitedFor(runId), () => { timedOut = true; reject(new Error(`${member} did not finish within ${minutes} minutes`)) }) }),
        ])
      } catch (err) {
        try { h.cancelTask(t.id) } catch { /* already over */ }
        // (a script step's own stop — a parallel branch failed, its script ended — while the run goes on: the cancelled
        // agent may still be at work in the folder; what comes next waits until it has gone, Agent Hub's kill grace and some)
        if (signal?.aborted && !a.controller.signal.aborted) await Promise.race([Promise.resolve(h.whenTaskDone(t.id)).catch(() => {}), new Promise(r => setTimeout(r, 15000))])
        if (timedOut && !grace && needResult && !stop.aborted) {
          // Time is up, the work may well be done: one short turn to hand it in — in the agent's own session when its
          // CLI keeps one, else from the folder and the ledger.
          await Promise.race([h.whenTaskDone(t.id), sleep(Math.min(30000, limit), stop)]).catch(() => {})
          const old = h.task?.(t.id)
          grace = { extra: old?.sessionId && ['claude', 'codex'].includes(old.runtime) ? { taskId: old.id, sessionId: old.sessionId, runtime: old.runtime, prompt: TIME_UP } : null }
          task = `${brief}\n\n${TIME_UP_FRESH}`
          record(runId, { stage, actor: 'system', kind: 'gate', title: `${member}: the step's ${minutes} minutes are up — one short turn to hand in what is done${grace.extra ? ' (its own session)' : ''}`, ok: false })
          attempt--
          continue
        }
        throw err
      } finally {
        timer?.clear?.()
        { const m = stageAccess.get(accessKey); m?.delete(t.id); if (m && !m.size) stageAccess.delete(accessKey) }
        a.members.delete(stage)
        if (stage === ASK_STAGE) askTasks.delete(t.id)
      }
      record(runId, {
        stage, actor: member, kind: 'agent', title: `${member} (${done.agent ? `${done.agent}: ` : ''}${done.runtime}${done.model ? ` ${done.model}` : ''}): ${title} — ${done.status}`,
        input: { task: t.id, job: job.id, agent: done.agent ?? null, runtime: done.runtime, model: done.model ?? null, tokens: done.tokens ?? null, cost: done.cost ?? null },
        output: tail(done.output || done.error || ''), ok: done.status === 'done', full: done.output || done.error || '(no report)',
      })
      if (attempt === 0 && resume) {
        const how = done.resumedVia === 'session' ? `resumed ${member}'s own ${done.runtime} session (L3)`
          : done.resumeFallback ? `${member}'s session could not be resumed (${String(done.resumeFallback.error).slice(0, 160)}) — continued with a handoff (L2)`
            : resume.level >= 2 ? `continued with a handoff of the interrupted attempt (L2)` : 'restarted the step from scratch (L1)'
        record(runId, { stage, actor: 'system', kind: 'gate', title: `${stage}: ${how}`, ok: true })
      }
      // Agent Hub moved the task to the step's fallback agent (the provider refused it or could not serve it): say so.
      if (done.fallbackOf) record(runId, { stage, actor: 'system', kind: 'gate', title: `${member}: ${done.fallbackOf.agent || done.fallbackOf.runtime}${done.fallbackOf.model ? ` (${done.fallbackOf.model})` : ''} failed — rerun on the fallback ${done.agent || done.runtime}${done.model ? ` (${done.model})` : ''}`, output: done.fallbackOf.error, ok: false })
      if (done.status !== 'done') throw new Error(`${member}'s task ${t.id} ${done.status}: ${done.error || 'no report'}`)
      const result = get(runId).stages.find(s => s.key === stage)?.result
      if (result || !needResult) return { task: done, result, report: done.output || '' }
      if (grace) throw new Error(`${member} did not hand back a stage result within the step's ${settingsForRun(runId).agentTimeoutMinutes} minutes`)
      task = `${brief}\n\n## Reminder\nYour previous attempt (task ${t.id}) ended without calling the stage_result tool, so the workbench has no result. ` +
        `Its report was:\n${tail(done.output || '(empty)', 3000)}\n\nWork already recorded as evidence does not need to be repeated (see wb_context). Finish the task and call stage_result.`
    }
    throw new Error(`${member} did not hand back a stage result`)
  }

  /**
   * One model call for a step — a role of the workflow that is a model (`kind: 'model'`), or a model step of one's own:
   * the role's text and `system` as the system prompt, `user` as the question; given a `schema`, the answer is an object
   * that fits it (asked again when it does not). The ledger gets the whole exchange, the tokens and the cost.
   * → { text, data, usage, model }; throws when no usable answer came.
   */
  const askModel = async (runId, stage, member, { system = '', user, schema, title = stage, temperature, maxTokens } = {}) => {
    const wf = workflowOf(runId)
    const who = stepModel(wf, stage, settingsForRun(runId), member)
    if (!who) throw fail('noRole', { role: member }, `the ${wf.id} workflow has no model role "${member}"`)
    if (!who.model) throw fail('noModel', { role: member }, `${member}: no model is chosen for this step (workbench settings)`)
    if (!models) throw fail('noModels', {}, 'model calls are not available here')
    const signal = active.get(runId)?.controller.signal
    const sys = [who.text, system].filter(Boolean).join('\n\n')
    const started = Date.now()
    let r = null, error = null
    try {
      r = await models.call({ model: who.model, system: sys, user, schema, temperature, maxTokens, signal, by: `${runId}:${stage}` })
    } catch (err) { error = err }
    if (signal?.aborted) throw new Error('cancelled')
    const usage = r?.usage || error?.usage || null, tries = r?.tries || error?.tries || []
    const exchange = [
      `# ${title}`, `Model: ${who.model}`, sys && `## System\n${sys}`, `## Question\n${user}`,
      schema && `## The answer's schema\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``,
      ...tries.map((t, i) => `## Answer ${i + 1}${t.problems.length ? ' (not accepted)' : ''}\n${t.text || '(empty)'}${t.problems.length ? `\n\nWhat was wrong:\n${t.problems.map(p => `- ${p}`).join('\n')}` : ''}`),
      error && `## Error\n${error.message}`,
    ].filter(Boolean).join('\n\n')
    record(runId, {
      stage, actor: member, kind: 'model', title: `${member} (${who.model}): ${title} — ${error ? 'failed' : 'done'}`,
      input: { model: who.model, calls: usage?.calls ?? 0, tokens: usage ? { input: usage.input, output: usage.output } : null, cost: usage?.cost || null, ms: Date.now() - started },
      output: tail(error ? error.message : r.text), ok: !error, full: exchange, ext: '.md',
    })
    if (error) throw error
    return { text: r.text, data: r.data, usage: r.usage, model: who.model }
  }

  // ── reports and approvals ──
  // `closing`: the key of the final step, which writes the report from inside itself — the report shows that step as passed
  // and the run as it is about to settle (failed when its verdict says so, else done), not as "running"
  const reportWrites = new Map(), reportController = new AbortController()
  const writeReport = (runId, closing = null) => {
    const signal = reportController.signal
    const requested = signal.aborted ? null : get(runId), phase = requested?.stages.find(s => s.key === closing)
    const work = (reportWrites.get(runId) || Promise.resolve()).catch(() => {}).then(async () => {
      signal.throwIfAborted()
      if (!get(runId)) throw fail('noRun', { id: runId }, `no run ${runId}`)
      let evidence = store.evidence(runId), chain
      for (;;) {
        chain = await store.verifyAsync(runId, { evidence, signal })
        signal.throwIfAborted()
        const latest = store.evidence(runId)
        if (JSON.stringify(latest) === JSON.stringify(evidence)) break
        evidence = latest // a step or approval appended evidence while the artifacts were being read
      }
      const now = get(runId)
      if (!now) throw fail('noRun', { id: runId }, `no run ${runId}`)
      const current = now.stages.find(s => s.key === closing)
      const finishing = closing && now.status === 'running' && now.stage === closing && now.resumedAt === requested?.resumedAt && current?.startedAt === phase?.startedAt && current?.attempt === phase?.attempt
      const r = finishing
        ? { ...now, status: now.verdict?.level === 'failed' ? 'failed' : 'done', stages: now.stages.map(s => (s.key === closing && s.status === 'running' ? { ...s, status: 'passed', endedAt: s.endedAt || Date.now() } : s)) }
        : now
      const wf = workflowOf(runId)
      const md = wf.report({ run: r, workflow: wf, evidence, chain, approvals: store.list('approval').filter(a => a.runId === runId) })
      const art = store.artifact(runId, 'report.md', md)
      update(runId, { report: art.artifact, reportSha256: art.sha256 })
      return md
    })
    reportWrites.set(runId, work)
    const clear = () => { if (reportWrites.get(runId) === work) reportWrites.delete(runId) }
    work.then(clear, clear)
    return work
  }
  /**
   * A card for the run. The same question asked again while it is still open (a step that runs again after a resume) is the
   * same card — a decision answered while the run was cut short and not applied yet too: its answer is still to be heard.
   */
  const createApproval = (runId, spec) => {
    const open = a => a.status === 'pending' || (a.action === 'decision' && a.status === 'done' && a.result?.option && !a.result.applied)
    const asked = a => JSON.stringify(a.action === 'decision' ? { ...a.payload, choice: undefined } : a.payload) // an answered card carries the choice
    const same = store.list('approval').find(a => a.runId === runId && open(a) && a.action === spec.action && a.title === spec.title && asked(a) === asked(spec))
    if (same) return same
    // a new card for an action this run already has a card open for (a step that ran again with other content) takes its
    // place: the old one cannot be approved any more. (Questions — decisions, a person step's asks — are many per run by nature.)
    const old = ['decision', 'help'].includes(spec.action) ? [] : store.list('approval').filter(a => a.runId === runId && ['pending', 'failed'].includes(a.status) && a.action === spec.action)
    const card = store.put('approval', { id: shortId('a'), runId, status: 'pending', createdAt: Date.now(), ...spec })
    for (const a of old) {
      store.put('approval', { ...a, status: 'superseded', supersededBy: card.id, decidedAt: Date.now() })
      record(runId, { stage: 'approval', actor: 'system', kind: 'gate', title: `superseded by a newer card: ${a.title}`, input: { approval: a.id, by: card.id }, ok: true })
    }
    return card
  }

  // ── the step loop ──
  const stageContext = (runId, def, signal) => {
    const wf = workflowOf(runId), pack = packOf(wf), config = settingsForRun(runId)
    return {
      get run() { return get(runId) },
      workflow: wf, services, pack, packSettings: pack && config.packs?.[pack.id], settings: config, signal, stage: def.key, store,
      toolNames: toolNames(wf), mcpName: mcp.name,
      /** The folder script steps with cwd "workspace" run in: the setting's, else the run's own. */
      get workspace() { return expand(config.workspace) || dirOf(get(runId)) },
      /** The folder for what the engine or the pack makes itself — not the agents' (`run.dir`): they may leave links there. */
      get outDir() { return outDirOf(get(runId)) },
      update: change => update(runId, change),
      result: () => get(runId).stages.find(s => s.key === def.key).result,
      evidence: entry => record(runId, { stage: def.key, ...entry }),
      command: (title, r, input) => recordCommand(runId, def.key, title, r, input),
      agent: (role, brief, opts) => askAgent(runId, def.key, role, brief, opts),
      /** A discussion's reply (or, `last`, what was agreed): talk(card, question, { last }) → its words. */
      talk: (cardId, question, opts) => talk(runId, def.key, cardId, question, opts),
      /** One model call (no tools) by a model role: { system?, user, schema?, title? } → { text, data, usage, model }. */
      model: (role, opts) => askModel(runId, def.key, role, opts),
      /** Run a command (never rejects: { code, stdout, stderr }); cancelled with the run. */
      exec: (cmd, args, opts) => { const tools = toolEnv(); return exec(cmd, args, { signal, ...opts, ...(tools.PATH && { env: { ...tools, ...opts?.env } }) }) },
      /** An installed script (name@version) → { ref, dir, entry, description } or null. */
      script: ref => scripts?.get(ref) ?? null,
      approval: spec => createApproval(runId, spec),
      writeReport: () => writeReport(runId, def.final ? def.key : null),
      sleep: ms => sleep(ms, signal),
      lanes: keys => runLane(runId, keys), // a parallel block's lane: its steps, as the walk runs them
      /** The connection this machine binds a step's connection need to (lib/needs.js) → { connection, how }. */
      bindConn: need => bindConn(need, get(runId).workflowDef?.id || get(runId).template),
      settleMs, // how often a step that waits for a person looks at its card
      tools: toolsOf(runId, def.key), // a command-line tool put in place when the step needs it (lib/toolbox.js)
      browser: browserFor(runId, def.key), // a browser the person can watch and take over (lib/browser.js)
      /** The run folder's versions (lib/versions.js) — for a step that keeps versions of its own (a review's rounds). */
      versions: {
        log: () => versions.log(get(runId)),
        files: (commit = 'HEAD') => versions.files(get(runId), commit),
        changes: commit => versions.changes(get(runId), commit),
        between: (from, to) => versions.between(get(runId), from, to),
        diff: (from, to, path) => versions.diff(get(runId), from, to, path || null),
        snapshot: (subject, mark) => versions.snapshot(get(runId), subject, mark),
      },
      /** How long an agent may work on a step (the settings' agentTimeoutMinutes): a script step's script may sit idle no longer than this. */
      get agentTimeoutMs() { return timeoutMs ?? settingsForRun(runId).agentTimeoutMinutes * 60000 },
    }
  }

  /**
   * One step, start to end: its work, the decisions asked in it (a blocking one holds it until the person chooses), its
   * status and its gate entry. → { out, status } — null when the run was stopped.
   */
  const runStep = async (runId, def, controller) => {
    // (what mise selected restored on the PATH and in the environment first — the workbench's start refreshes it — so no
    // step, nor the agents it starts, runs with what was there before; a stop meanwhile stops it)
    if (!(await toolsReady(controller.signal))) return null
    // the folder as the step finds it: a version of its own when it changed since the last one (a person, a tool outside the
    // steps). A parallel block's lane makes none: lanes write the folder at once — the block's own step versions what they did.
    const lane = !!def.par
    const before = lane ? null : await versions.snapshot(get(runId), `Before ${def.key}: changes outside the steps`, { kind: 'outside', before: def.key })
    if (controller.signal.aborted) return null
    patchStage(runId, def.key, s => ({ status: 'running', startedAt: Date.now(), endedAt: null, note: '', attempt: (s.attempt || 0) + 1, round: get(runId).round || 0, version: before ? { base: before.commit } : null }))
    // what the step changed in the folder, as one version (a step that was stopped too: its files are not lost to the next)
    const versionAfter = async status => {
      if (lane) return null
      const s = get(runId).stages.find(x => x.key === def.key)
      const v = await versions.snapshot(get(runId), `${def.key}: ${status}`, { kind: 'step', step: def.key, status, round: s?.round || 0, attempt: s?.attempt || 1 })
      if (!v) return null
      // (the run as the page syncs it names a step's first files; the rest are counted — versionChanges has them all)
      const more = (v.more || 0) + Math.max(0, v.files.length - 60)
      const version = { base: before?.commit || null, commit: v.commit, made: v.made, files: v.files.slice(0, 60), ...(more && { more }), ...(v.big?.length && { big: v.big.slice(0, 20) }), ...(v.nested?.length && { nested: v.nested.slice(0, 20) }) }
      patchStage(runId, def.key, { version })
      return version
    }
    let out
    try {
      // its command-line tools first: what cannot be put in place stops the step, saying how a person installs it
      const tools = toolsOf(runId, def.key), missing = []
      for (const want of def.cli || []) {
        const res = await tools.need(want) // (a stop while it installs throws: caught below, the step does not start)
        if (controller.signal.aborted) return null
        if (res.status === 'missing') missing.push(tools.missingNote(want, res))
      }
      if (controller.signal.aborted) return null
      const note = `missing tools: ${missing.join('; ')}`.slice(0, 1500)
      // (a step of one's own fails the way its "on failure" says: carry on, go back, stop)
      out = missing.length ? (def.fail ? def.fail(stageContext(runId, def, controller.signal), note) : { ok: false, verdict: 'failed', note })
        : (await def.run(stageContext(runId, def, controller.signal))) || { ok: true }
    } catch (err) {
      revokeTokens(runId, def.key)
      if (controller.signal.aborted) { await versionAfter('stopped').catch(() => {}); return null }
      logger?.warn?.(`ruyix-workbench: ${runId} ${def.key}: ${err?.stack || err}`)
      out = { ok: false, verdict: 'failed', note: err?.message || String(err) }
    }
    revokeTokens(runId, def.key)
    if (controller.signal.aborted) { await versionAfter('stopped').catch(() => {}); return null }
    // what the step did, as a version — before it waits on the decisions asked in it: what a person edits meanwhile is
    // theirs, not the step's
    const version = await versionAfter(out.skip ? 'skipped' : out.ok === false || out.goto ? 'failed' : 'passed')
    // decisions asked in this step: a blocking one holds the run here until the person chooses; a choice to
    // revise or check sends the run back to that step (this one or an earlier one), the choice as its input
    const back = await settleDecisions(runId, def.key, controller.signal)
    if (controller.signal.aborted) return null
    if (back?.stop) out = { ok: false, verdict: 'failed', stop: true, note: back.note }
    else if (back && !out.stop) out = { ...out, ok: false, goto: back.goto, note: back.note, decision: true }
    const status = out.skip ? 'skipped' : out.ok === false || out.goto ? 'failed' : 'passed'
    patchStage(runId, def.key, { status, endedAt: Date.now(), note: out.note || '' })
    record(runId, { stage: def.key, kind: 'gate', title: `${def.key}: ${status}${out.goto || out.back ? ` → back to ${out.goto || out.back}` : ''}`, output: out.note || '', ok: status !== 'failed', ...(version && { input: { version: version.commit, files: version.files.length + (version.more || 0) } }) })
    return { out, status }
  }
  /**
   * A parallel block's lane: its steps in turn (another lane's at the same time). → { ok } — or { ok: false, note } when a
   * step failed (one that carries on does not stop the lane), or the run was stopped; { ok: false, back, note } when a
   * decision asked in a lane sent the work back to `back` (the block decides what that means, see parallelStage).
   */
  const runLane = async (runId, keys) => {
    const controller = active.get(runId)?.controller, wf = workflowOf(runId)
    for (const key of keys) {
      const def = wf.stages.find(s => s.key === key)
      if (!def || !get(runId).stages.some(s => s.key === key)) continue
      let done = null
      for (;;) {
        done = waiting(runId, key) || await runStep(runId, def, controller)
        if (!done) return { ok: false, note: 'stopped' }
        const helped = await askPerson(runId, def, done, controller)
        if (!helped) return { ok: false, note: 'stopped' }
        if (helped.retry) { rerun(runId, [key]); done = null; continue }
        if (helped.done) done = helped.done
        break
      }
      if (done.out.decision && done.out.goto) return { ok: false, back: done.out.goto, note: String(done.out.note || '') }
      if (done.status === 'failed' && !done.out.carryOn) return { ok: false, note: `${key}: ${String(done.out.note || 'failed').slice(0, 300)}` }
    }
    return { ok: true }
  }
  /** Steps sent back to run again: each pending, what it did kept in its history — its result and its output count no more. */
  const rerun = (runId, keys) => update(runId, r => {
    const set = new Set(keys), outputs = { ...(r.outputs || {}) }
    for (const k of set) delete outputs[k]
    return {
      ...r, outputs, round: (r.round || 0) + 1,
      stages: r.stages.map(s => (!set.has(s.key) ? s : {
        ...s, status: 'pending', result: null, version: null,
        ...(s.attempt && s.status !== 'pending' && { history: [...(s.history || []), { round: s.round || 0, attempt: s.attempt, status: s.status === 'running' ? 'stopped' : s.status, note: s.note || '', startedAt: s.startedAt || null, endedAt: s.endedAt || null, result: s.result ?? null, ...(s.version && { version: s.version }) }].slice(-10) }),
      })),
    }
  })

  /** A person's question about a step that waits for them: its agent answers from the run's record. → false: the run stopped */
  const answerQuestion = async (runId, def, ask, q, controller) => {
    const put = fields => { const cur = store.get('approval', ask.id); store.put('approval', { ...cur, chat: (cur.chat || []).map(x => (x.n === q.n ? { ...x, ...fields, answeredAt: Date.now() } : x)) }) }
    const token = randomUUID()
    const wf = workflowOf(runId), agentic = k => wf.roles?.[k] && wf.roles[k].kind !== 'model'
    const role = agentic(def.owner) ? def.owner : Object.keys(wf.roles || {}).find(agentic)
    try {
      if (!role) throw new Error('this workflow has no agent to ask')
      const brief = chatBrief({ run: get(runId), key: def.key, ask, chat: (ask.chat || []).filter(x => x.answer), question: q.q, evidence: store.evidence(runId).filter(e => e.stage === def.key) })
      const { report } = await askAgent(runId, ASK_STAGE, role, brief, { title: `Question on ${def.key}`, needResult: false, step: def.key, access: 'read', token })
      put({ answer: String(report || '').trim().slice(0, 20000) || '(no answer)' })
    } catch (err) {
      if (controller.signal.aborted) return false
      put({ error: String(err?.message || err).slice(0, 500) })
    } finally { tokens.delete(token) }
    return true
  }
  /**
   * A discussion with the person (docs/design/agent-work.md §7: a chat step's card, or one a step's agent asked for): the
   * agent of the step it is about (`with`) replies to `question` — in its own session when the workflow keeps them and it
   * is still there (it knows what it did), else a read-only task from the run's record. `last`: the person said it is
   * settled — it writes what was agreed instead. → its words
   */
  const talk = async (runId, stepKey, cardId, question, { last = false } = {}) => {
    const card = store.get('approval', cardId), r = get(runId), wf = workflowOf(runId), h = hub()
    const withKey = card?.payload?.with || card?.payload?.stage || stepKey
    const st = r.stages.find(s => s.key === withKey)
    const chat = (card?.chat || []).filter(x => x.answer)
    const signal = active.get(runId)?.controller.signal
    if (st?.session && h?.askSession && h.sessionInfo?.(st.session)) {
      try {
        const out = await h.askSession(st.session, talkTurn({ card, question, last }), { signal, of: { run: runId, step: stepKey } })
        if (!out?.error && String(out?.output || '').trim()) return String(out.output).trim().slice(0, 20000)
      } catch { if (signal?.aborted) throw new Error('cancelled') /* else: from the record */ }
    }
    const agentic = k => wf.roles?.[k] && wf.roles[k].kind !== 'model'
    const owner = wf.stages.find(s => s.key === withKey)?.owner
    const role = agentic(owner) ? owner : Object.keys(wf.roles || {}).find(agentic)
    if (!role) throw new Error('this workflow has no agent to talk with')
    const token = randomUUID()
    const brief = talkBrief({ run: r, key: withKey, card, chat, question, last, evidence: store.evidence(runId).filter(e => e.stage === withKey) })
    try {
      const { report } = await askAgent(runId, ASK_STAGE, role, brief, { title: `${last ? 'What was agreed' : 'Talk'} on ${stepKey}`, needResult: false, step: withKey, access: 'read', token })
      return String(report || '').trim().slice(0, 20000)
    } finally { tokens.delete(token) }
  }
  /** The person's message in a discussion a step's agent asked for: the reply on the card. → false: the run stopped */
  const answerTalk = async (runId, key, card, q, controller) => {
    let fields
    try { fields = { answer: (await talk(runId, key, card.id, q.q)) || '(no answer)' } } catch (err) { if (controller.signal.aborted) return false; fields = { error: String(err?.message || err).slice(0, 500) } }
    const cur = store.get('approval', card.id)
    store.put('approval', { ...cur, chat: (cur.chat || []).map(x => (x.n === q.n ? { ...x, ...fields, answeredAt: Date.now() } : x)) })
    return true
  }
  /** A step that was waiting for the person when the run stopped: its outcome as it stood, to ask again — else null. */
  const waiting = (runId, key) => {
    const s = get(runId).stages.find(x => x.key === key)
    const card = s?.asking && store.get('approval', s.asking)
    if (!card || card.applied || !['pending', 'failed', 'running', 'done', 'rejected'].includes(card.status)) return null
    const failed = s.askOut?.ok === false
    patchStage(runId, key, { status: 'running', resume: null })
    return { out: s.askOut || { ok: true }, status: failed ? 'failed' : 'passed' }
  }
  /**
   * After a step: does it need the person (lib/human.js)? Then the run waits at it for their answer — retry (the step again,
   * with what they said in its brief), continue (the step's outcome stands), stop (here, nothing after it). → {} go on as it
   * is, { retry }, { done } the outcome as the person decided, null the run was stopped while waiting.
   */
  const askPerson = async (runId, def, done, controller) => {
    const key = def.key
    const helps = () => store.list('approval').filter(a => a.runId === runId && a.action === 'help' && a.payload?.stage === key && ASKED.includes(a.payload?.kind))
    const open = () => helps().filter(a => ['pending', 'failed'].includes(a.status))
    const available = helps().filter(a => ['pending', 'failed', 'running'].includes(a.status) || (['done', 'rejected'].includes(a.status) && !a.applied))
    const held = available.at(-1)
    const early = held && ['done', 'rejected'].includes(held.status)
    const human = humanOf(def)
    const rounds = (get(runId).helps || []).filter(h => h.stage === key).length
    const need = early ? { kind: held.payload.kind, question: held.title, why: held.payload.why || '', score: held.payload.score, bar: held.payload.bar } : needPerson({ run: get(runId), key, status: done.status, out: done.out, human, asked: available.filter(a => a.payload?.kind === 'agent').at(-1), rounds })
    if (!need) {
      for (const a of open()) store.put('approval', { ...a, status: 'rejected', reason: rounds >= HELP_ROUNDS ? `this step asked ${HELP_ROUNDS} times already` : 'no longer needed: the step got through', decidedAt: Date.now(), applied: true })
      return {}
    }
    const a = held || createApproval(runId, { action: 'help', title: need.question.slice(0, 300), payload: { kind: need.kind, why: need.why, stage: key, score: need.score ?? null, bar: need.bar ?? null, round: rounds + 1, blocking: true, by: 'workflow' } })
    for (const x of open()) if (x.id !== a.id) store.put('approval', { ...x, status: 'rejected', reason: 'asked again', decidedAt: Date.now(), applied: true })
    // when the person is reminded, set once (a restart keeps it): the run waits for their answer however long that takes
    if (a.payload?.deadline === undefined) store.put('approval', { ...store.get('approval', a.id), payload: { ...a.payload, round: a.payload.round ?? rounds + 1, wait: human.wait, deadline: human.wait ? Date.now() + human.wait * 3600e3 : null } })
    if (!get(runId).stages.find(s => s.key === key)?.asking) {
      record(runId, { stage: key, actor: 'system', kind: 'gate', title: `the person is asked (${need.kind === 'agent' ? 'its agent asked' : need.kind === 'low' ? `${need.score} under ${need.bar}` : 'stuck'}): ${need.question}`.slice(0, 300), input: { approval: a.id, kind: need.kind, round: rounds + 1 }, output: need.why, ok: true })
      // (the step counts as running while it waits: a restart picks it up here, not after it)
      patchStage(runId, key, { asking: a.id, askOut: { ok: done.out.ok !== false, verdict: done.out.verdict || null, note: done.out.note || '', stop: !!done.out.stop }, status: 'running' })
    }
    update(runId, { status: 'waiting', waiting: 'person', waitingFor: a.id })
    for (;;) {
      if (controller.signal.aborted) return null
      const cur = store.get('approval', a.id)
      if (['done', 'rejected'].includes(cur?.status)) break
      // nobody answered in time: a reminder (the inbox counts it) — never an answer on its own: what a person decides stays theirs
      if (cur.payload?.deadline && Date.now() > cur.payload.deadline && !cur.payload.remindedAt) {
        store.put('approval', { ...cur, payload: { ...cur.payload, remindedAt: Date.now() } })
        record(runId, { stage: key, actor: 'system', kind: 'gate', title: `no answer within ${cur.payload.wait} h: the person is reminded, the run keeps waiting`, input: { approval: a.id }, ok: true })
        continue
      }
      // a question for the step's agent meanwhile: it answers from the record, one at a time
      const q = (cur.chat || []).find(x => !x.answer && !x.error)
      if (q && cur.payload?.talk) { if (!(await answerTalk(runId, key, cur, q, controller))) return null; continue }
      if (q) { if (!(await answerQuestion(runId, def, cur, q, controller))) return null; continue }
      await sleep(settleMs, controller.signal)
    }
    const x = store.get('approval', a.id)
    let ans = x.status === 'rejected' ? { answer: 'stop', input: x.reason || '' } : x.result
    // a discussion its agent asked for, settled: the step runs again with what was agreed (in its agent's words)
    if (ans?.answer === 'settle') {
      let agreed = ''
      if ((x.chat || []).some(m => m.answer)) { try { agreed = await talk(runId, key, x.id, ans.input || null, { last: true }) } catch { if (controller.signal.aborted) return null } }
      const input = [agreed, ans.input && `${agreed ? 'The person adds: ' : ''}${ans.input}`].filter(Boolean).join('\n\n').slice(0, 6000) || 'The person talked it through and says go on.'
      store.put('approval', { ...store.get('approval', x.id), settled: agreed.slice(0, 6000) })
      ans = { answer: 'retry', input }
    }
    const applied = store.get('approval', x.id)
    store.put('approval', { ...applied, applied: true, result: { ...(applied.result || {}), applied: true } })
    patchStage(runId, key, { asking: null, askOut: null })
    // (another lane of a parallel block still waiting for its person: the run still waits, for that one)
    const other = get(runId).stages.find(s => s.key !== key && s.asking && ['pending', 'failed'].includes(store.get('approval', s.asking)?.status))
    update(runId, r => ({
      ...r, status: other ? 'waiting' : 'running', waiting: other ? 'person' : null, waitingFor: other ? other.asking : null,
      // what the person answered where, and what the step is told
      helps: [...(r.helps || []), { id: a.id, stage: key, kind: need.kind, question: a.title, answer: ans.answer, input: ans.input || '', score: need.score ?? null, bar: need.bar ?? null, askedAt: a.createdAt, answeredAt: Date.now() }],
      ...(ans.answer === 'retry' && { guidance: [...(r.guidance || []), { stage: key, text: ans.input, at: Date.now(), help: a.id }] }),
    }))
    if (ans.answer === 'retry') return { retry: true }
    if (ans.answer === 'stop') {
      const note = `stopped by the person${ans.input ? `: ${ans.input}` : ''}`.slice(0, 600)
      patchStage(runId, key, { status: 'failed', note })
      return { done: { status: 'failed', out: { ok: false, verdict: done.status === 'failed' && done.out.verdict ? done.out.verdict : 'failed', stop: true, note } } }
    }
    // continue: the step's outcome stands — one that failed goes the way it would have without the person (an honest exit
    // to the closing steps, or the stop); "it is fine" is said with a retry, and the step judges again
    patchStage(runId, key, { status: done.status })
    return {}
  }

  const drive = async (runId, from = 0) => {
    const controller = new AbortController()
    active.set(runId, { controller, members: new Map() })
    update(runId, { status: 'running', error: null, endedAt: null, waiting: null })
    const wf = workflowOf(runId)
    const index = key => wf.stages.findIndex(s => s.key === key)
    const final = wf.stages.findIndex(s => s.final)
    // a step not run (yet): skipped — one that ran (a parallel block's lanes) keeps how it went
    const skip = (k, note) => patchStage(runId, wf.stages[k].key, s => (s.status === 'pending' ? { status: 'skipped', ...(note && { note }) } : {}))
    let i = from
    let crashed = null
    try {
      while (i < wf.stages.length && !controller.signal.aborted) {
        const def = wf.stages[i]
        if (def.par) { i++; continue } // a parallel block's lane step: the block runs it
        const mine = get(runId).stages.find(s => s.key === def.key)
        if (!mine) { i++; continue } // the step came after this run started
        if (def.optional && settingsForRun(runId).stages?.[def.key] === false) { patchStage(runId, def.key, { status: 'skipped', note: 'turned off in the workbench settings' }); i++; continue }
        update(runId, { stage: def.key })
        // (a step that was waiting for the person when the run stopped — a restart: it waits again, it does not run again)
        let done = waiting(runId, def.key) || await runStep(runId, def, controller)
        if (!done) break
        // where the step needs the person (its agent asked, its confidence is under its bar, it is stuck): the run waits for the answer
        const helped = await askPerson(runId, def, done, controller)
        if (!helped) break
        if (helped.retry) { rerun(runId, [def.key, ...wf.stages.filter(x => x.par === def.key).map(x => x.key)]); continue }
        if (helped.done) done = helped.done
        const { out, status } = done
        // a step of the person's that may fail: it stays failed (a route can wait for that), the run goes on
        if (status === 'failed' && out.carryOn && !out.goto) { i++; continue }
        // sent back (a route that goes back, a decision, an on-failure rule): that step and the ones after it run again
        if (out.goto || out.back) {
          const at = index(out.goto || out.back)
          // this one too: what it did goes to its history; a parallel block's lane steps run again with their block
          const span = wf.stages.slice(at, i + 1).map(x => x.key)
          rerun(runId, [...span, ...wf.stages.filter(x => x.par && span.includes(x.par)).map(x => x.key)])
          i = at
          continue
        }
        if (status === 'failed') {
          update(runId, r => ({ ...r, verdict: { ...(r.verdict || {}), level: out.verdict || 'failed', reason: out.note || '', ...(out.stop && { stopped: def.key }) } }))
          // A stop: nothing after this step runs — no write-up, no approval cards.
          if (out.stop) {
            for (let k = i + 1; k < wf.stages.length; k++) skip(k, `stopped at ${def.key}`)
            break
          }
          if (def.final || final < 0) break
          for (let k = i + 1; k < final; k++) skip(k)
          i = final
          continue
        }
        // a branch took a route, or a route ended: on to that step, the steps between skipped (not on this path)
        const ahead = out.jump ? index(out.jump) : def.next ? index(def.next) : -1
        if (ahead > i + 1) {
          for (let k = i + 1; k < ahead; k++) skip(k, 'not on this path')
          i = ahead
          continue
        }
        i++
      }
    } catch (err) {
      crashed = err
    } finally {
      if (shuttingDown) return interruptByShutdown(runId)
      const cancelled = controller.signal.aborted
      active.delete(runId)
      for (const [token, t] of tokens) if (t.runId === runId) tokens.delete(token)
      const r = get(runId)
      if (r.leadId) leadRuns.delete(r.leadId)
      try {
        const h = hub()
        if (h && r.jobId) cancelled ? h.stopJob(r.jobId) : h.finishJob(r.jobId, { report: r.verdict ? `Verdict: ${r.verdict.level}` : '' })
      } catch { /* the job is already over */ }
      const status = cancelled ? 'cancelled' : crashed || r.verdict?.level === 'failed' ? 'failed' : 'done'
      if (cancelled) browsers?.closeRun(runId).catch(() => {})
      // a person step's card still open when the run ends: nobody needs to answer it any more (a resumed run asks again)
      for (const a of store.list('approval').filter(x => x.runId === runId && x.payload?.by === 'workflow' && x.payload?.stage && (x.action === 'help' || x.payload?.person) && ['pending', 'failed'].includes(x.status))) {
        store.put('approval', { ...a, status: 'rejected', reason: `the run ended (${status})`, decidedAt: Date.now(), applied: true })
      }
      // the two verdict levels the engine itself knows: a stop is cancelled, a crash is failed (a step may have said more before)
      const verdict = cancelled ? { ...r.verdict, level: 'cancelled' } : crashed && !r.verdict?.level ? { ...r.verdict, level: 'failed', reason: crashed.message } : r.verdict
      update(runId, { status, verdict, stage: null, waiting: null, endedAt: Date.now(), error: crashed?.message || r.error || null })
      closeSessions(runId)
      // (whoever keeps something about it: a studio's record moves on — docs/design/studio.md)
      try { onRunEnd(get(runId)) } catch (err) { logger?.warn?.(`ruyix-workbench: ${runId}: after its end: ${err?.message || err}`) }
      if (cancelled || crashed || r.verdict?.stopped) { try { await writeReport(runId) } catch { /* best effort */ } }
    }
  }

  /** Wait for the run's open blocking decisions; apply the chosen ones not applied yet. → { goto, note } or null. */
  const settleDecisions = async (runId, stageKey, signal) => {
    const mine = () => store.list('approval').filter(a => a.runId === runId && a.action === 'decision' && a.payload?.stage === stageKey)
    let waited = false
    for (;;) {
      const open = mine().filter(a => !a.applied && !a.result?.applied && a.payload?.blocking && ['pending', 'failed', 'running'].includes(a.status))
      if (!open.length || signal.aborted) break
      if (!waited) { waited = true; update(runId, { status: 'waiting', waiting: 'decision', waitingFor: open[0].id }) }
      await sleep(settleMs, signal)
    }
    if (waited && !signal.aborted) update(runId, { status: 'running', waiting: null, waitingFor: null })
    // a blocking decision the person rejected: the run stops there — rejecting is not choosing to go on
    const refused = mine().find(a => a.payload?.blocking && a.status === 'rejected' && !a.applied)
    if (refused) {
      store.put('approval', { ...refused, applied: true })
      update(runId, x => ({ ...x, decisions: [...(x.decisions || []), { id: refused.id, question: refused.title, label: 'Rejected', does: 'the run stops here', action: 'stop', at: Date.now() }] }))
      return { stop: true, note: `${refused.title}: rejected by the person${refused.reason ? ` — ${String(refused.reason).slice(0, 300)}` : ''}` }
    }
    const wf = workflowOf(runId), here = wf.stages.findIndex(s => s.key === stageKey)
    let goto = null
    const notes = []
    for (const a of mine().filter(x => x.status === 'done' && !x.applied && x.result?.option && !x.result.applied)) {
      const o = a.result.option
      store.put('approval', { ...a, applied: true, result: { ...a.result, applied: true } })
      update(runId, x => ({ ...x, decisions: [...(x.decisions || []), { id: a.id, question: a.title, label: o.label, does: o.does, action: o.action, from: o.from || null, at: Date.now() }] }))
      if (o.action === 'accept') continue
      if (o.action === 'stop') return { stop: true, note: `${a.title}: stopped by the person` }
      notes.push(`decision "${a.title}" → ${o.label}`)
      const at = wf.stages.findIndex(s => s.key === o.from)
      if (at >= 0 && at <= here && (goto === null || at < wf.stages.findIndex(s => s.key === goto))) goto = o.from
    }
    return goto ? { goto, note: `${notes.join('; ')} — back to ${goto}`.slice(0, 600) } : null
  }

  // dsh going down mid-run (plugin dispose): interrupted, not cancelled — the next start resumes it; the Agent Hub job
  // is left as it is
  let shuttingDown = false
  const interruptByShutdown = runId => {
    active.delete(runId)
    try {
      update(runId, r => ({
        ...r, status: 'interrupted', interruptedBy: 'restart', interruptedAt: Date.now(), waiting: null, endedAt: Date.now(),
        error: 'dsh restarted during this run — it resumes on its own, or resume it from the interrupted step',
        stages: r.stages.map(s => (s.status === 'running' ? { ...s, resume: { taskId: (s.tasks || []).at(-1) || null, startedAt: s.startedAt || null, why: 'restart' } } : s)),
      }))
    } catch { /* the store is already closed: the next start marks it from its running state */ }
  }

  for (const r of store.list('run')) {
    if (!DONE.has(r.status)) {
      store.put('run', {
        ...r, status: 'interrupted', interruptedBy: 'restart', interruptedAt: Date.now(), waiting: null, error: 'dsh restarted during this run — it resumes on its own, or resume it from the interrupted step', endedAt: Date.now(),
        stages: r.stages.map(s => (s.status === 'running' ? { ...s, resume: { taskId: (s.tasks || []).at(-1) || null, startedAt: s.startedAt || null, why: 'restart' } } : s)),
      })
    }
  }
  for (const a of store.list('approval')) if (a.status === 'running') store.put('approval', { ...a, status: 'failed', error: 'interrupted by a dsh restart' })

  // Runs a restart cut short resume on their own once Agent Hub is up (L1; the steps themselves pick up via
  // resumeHandoff / the agent's session). Recent ones only, at most autoResume.maxPerRun times each.
  let autoTimer = null
  const autoResume = (tries = 0) => {
    const s = settings().autoResume
    if (!s?.enabled) return
    if (!hub()) { if (tries < 30) autoTimer = setTimeout(() => autoResume(tries + 1), 10000); return }
    const due = store.list('run').filter(r => r.status === 'interrupted' && r.interruptedBy === 'restart' && Date.now() - (r.interruptedAt || 0) < s.maxAgeHours * 3600e3 && (r.autoResumes || 0) < s.maxPerRun)
    let editPending = false
    for (const r of due.sort((a, b) => a.createdAt - b.createdAt)) {
      if (editing.has(folderKey(r))) { editPending = true; continue }
      try {
        engine.resumeRun(r.id)
        update(r.id, { autoResumes: (r.autoResumes || 0) + 1 })
        record(r.id, { stage: 'resume', actor: 'system', kind: 'gate', title: `dsh restarted — resumed automatically (${(r.autoResumes || 0) + 1} of ${s.maxPerRun})`, ok: true })
      } catch (err) { logger?.warn?.(`ruyix-workbench: auto-resume ${r.id}: ${err?.message || err}`) }
    }
    if (editPending) autoTimer = setTimeout(autoResume, 500)
  }
  autoTimer = setTimeout(autoResume, resumeDelayMs)

  /** A run going (a step, a wait for the person): stopped, and its end awaited — its last step's version made. */
  const stopAndWait = async id => {
    const r = get(id)
    if (!r) throw fail('noRun', { id }, `no run ${id}`)
    if (!active.has(id)) return
    // the agents at work: a CLI agent goes on writing for a moment after it is told to stop — what comes next (going back,
    // a step again) waits until each task is over, as long as Agent Hub's kill grace and some
    const working = r.stages.filter(s => s.status === 'running').map(s => (s.tasks || []).at(-1)).filter(Boolean)
    active.get(id)?.controller.abort()
    for (let t = Date.now(); active.has(id); await sleep(50)) if (Date.now() - t > 60000) throw fail('stillRunning', {}, 'the run did not stop within a minute')
    const h = hub()
    if (h && working.length) await Promise.race([Promise.all(working.map(t => Promise.resolve(h.whenTaskDone?.(t)).catch(() => {}))), sleep(20000)])
  }
  const folderKey = run => { const p = dirOf(run); try { return realpathSync(p) } catch { return p } }
  const notEditing = run => { if (run && editing.has(folderKey(run))) throw fail('runBusy', {}, 'files are still being saved: wait for the edit to finish') }
  /** Another run going in the same folder (a folder a person named twice): going back or editing would pull it from under that one. */
  const folderBusy = id => {
    notEditing(get(id))
    const mine = folderKey(get(id))
    const other = [...active.keys()].find(k => k !== id && get(k) && folderKey(get(k)) === mine)
    if (other) throw fail('folderBusy', { run: other }, `run ${other} is working in the same folder: wait for it, or stop it`)
  }
  // Acquire the pack's guard before yielding: approved output must not change while a publication uses it.
  const beforeFileMutation = (run, change) => {
    const wf = wfOf(run), pack = wf && packOf(wf)
    const release = pack?.beforeFileMutation?.({ run, ...change, store })
    if (release != null && typeof release !== 'function') throw new Error(`pack ${pack.id}: beforeFileMutation must synchronously return a release function or nothing`)
    return release
  }

  // Public synchronous restarts acquire the same guard as edits/rewinds before touching any run state.
  // The private resume/goOn functions are also used inside the already-guarded asynchronous paths.
  const restart = (id, by, run) => {
    if (restarting.has(id)) throw fail('runBusy', {}, 'this run is already being restarted')
    restarting.add(id)
    let release
    try {
      const current = get(id)
      if (!current) throw fail('noRun', { id }, `no run ${id}`)
      folderBusy(id)
      release = beforeFileMutation(current, { kind: 'restart', by })
      return run()
    } finally {
      try { release?.() } finally { restarting.delete(id) }
    }
  }

  // Choosing a fresh attempt replaces pending intent for the steps being redone. A plain resume still hears it.
  const retireDecisions = (id, keys, from) => {
    const stages = new Set(keys)
    for (const a of store.list('approval')) {
      if (a.runId !== id || a.action !== 'decision' || !stages.has(a.payload?.stage) || a.applied || a.result?.applied || a.status === 'superseded') continue
      store.put('approval', { ...a, status: 'superseded', applied: true, supersededAt: Date.now(), supersededByRestart: from, ...(a.result && { result: { ...a.result, applied: true } }) })
      record(id, { stage: 'approval', actor: 'system', kind: 'gate', title: `superseded by restarting from ${from}: ${a.title}`, input: { approval: a.id, stage: a.payload?.stage, from, status: a.status }, ok: true })
    }
  }

  const resume = (id, { from: key, withNewSteps = false } = {}) => {
    let r = get(id)
    if (!r) throw fail('noRun', { id }, `no run ${id}`)
    notEditing(r)
    if (!['interrupted', 'failed', 'cancelled'].includes(r.status) && !(key && r.status === 'done')) throw fail('notResumable', { status: r.status }, `a ${r.status} run cannot be resumed`)
    const wf = workflowOf(id)
    if (withNewSteps && key && wf.stages.some(s => s.key === key)) {
      const own = new Map(r.stages.map(s => [s.key, s])), at = wf.stages.findIndex(s => s.key === key)
      if (wf.stages.some(s => !own.has(s.key))) {
        const stages = wf.stages.map((s, k) => own.get(s.key) || { key: s.key, owner: s.owner, status: k < at ? 'skipped' : 'pending', attempt: 0, ...(s.title && { title: s.title }), ...(k < at && { note: 'added to the workflow after this run started' }) })
        r = update(id, { stages: [...stages, ...r.stages.filter(s => !wf.stages.some(x => x.key === s.key))] })
      }
    }
    // By key: the workflow may have gained a step since the run started (its stages list is the older one).
    let fromKey = key || (r.stages.find(s => s.status !== 'passed' && s.status !== 'skipped') || r.stages[0]).key
    // a step in a parallel block's lane: the block runs again (its lanes run at once)
    const lane = wf.stages.find(s => s.key === fromKey)?.par
    if (lane) fromKey = lane
    const from = r.stages.findIndex(s => s.key === fromKey)
    if (from < 0 || wf.stages.findIndex(s => s.key === fromKey) < 0) throw fail('noStage', { stage: fromKey }, `${r.template} has no step ${fromKey}`)
    if (key) {
      const keys = r.stages.slice(from).map(s => s.key)
      retireDecisions(id, [...keys, ...wf.stages.filter(s => s.par && keys.includes(s.par)).map(s => s.key)], fromKey)
    }
    const last = s => s.resume || ((s.tasks || []).length ? { taskId: s.tasks.at(-1), startedAt: s.startedAt || null, why: s.status === 'failed' ? `failed: ${String(s.note || '').slice(0, 300)}` : 'stopped' } : null)
    const stages = r.stages.map((s, k) => (k > from ? { ...s, status: 'pending' } : k === from ? { ...s, status: 'pending', resume: key ? undefined : last(s) } : s))
    // a step run again by choice (from a key) starts over: a script step's journal of the steps reset goes with them
    const flows = key && r.flows ? Object.fromEntries(Object.entries(r.flows).filter(([k]) => { const i = r.stages.findIndex(s => s.key === k); return i >= 0 && i < from })) : r.flows
    update(id, { stages, verdict: null, resumedAt: Date.now(), ...(flows !== r.flows && { flows }) })
    try { onRunResume(get(id)) } catch (err) { logger?.warn?.(`ruyix-workbench: ${id}: after resuming: ${err?.message || err}`) }
    drive(id, wf.stages.findIndex(s => s.key === fromKey)).catch(err => logger?.warn?.(`ruyix-workbench: ${id}: ${err?.stack || err}`))
    return { run: get(id), from: fromKey }
  }

  const goOn = (id, key, { why } = {}) => {
    notEditing(get(id))
    const r = get(id), at = r.stages.findIndex(s => s.key === key), wf = workflowOf(id)
    if (!['done', 'interrupted', 'failed', 'cancelled'].includes(r.status)) throw fail('notResumable', { status: r.status }, `a ${r.status} run cannot go on from a step`)
    if (at < 0) throw fail('noStage', { stage: key }, `${r.template} has no step ${key}`)
    const keys = r.stages.slice(at).map(s => s.key)
    rerun(id, [...keys, ...wf.stages.filter(x => x.par && keys.includes(x.par)).map(x => x.key)])
    return { ...resume(id, { from: key }), why }
  }

  const engine = {
    get,
    settingsForRun,
    /** A run's workflow (undefined: its pack is not loaded). */
    workflowFor: r => wfOf(r),
    active: id => active.has(id) || restarting.has(id) || !!get(id) && editing.has(folderKey(get(id))),
    /**
     * What the agents of a run's steps at work are doing now, for the desk's lines (docs/design/agent-work.md §2): each
     * step's agent activity — its pool task's (Agent Hub's agentActivity) or, in a session, folded from the session's
     * events since the step began. → { [step]: { agent, act: { tools, recent, said, saidAt, turnStartedAt } } }
     */
    live(runId) {
      const r = get(runId), h = hub(), out = {}
      if (!r || !h) return out
      for (const s of r.stages || []) {
        if (s.status !== 'running') continue
        let act = null
        if (s.session && h.readSession) { try { act = foldActivity(h.readSession(s.session, { limit: 80 }).events, s.startedAt || 0) } catch { /* gone */ } }
        if (!act && s.tasks?.length) act = h.task?.(s.tasks.at(-1))?.act || null
        if (act) out[s.key] = { agent: s.agent?.id || null, act: { tools: act.tools || [], recent: act.recent || [], said: act.said || '', saidAt: act.saidAt || null, turnStartedAt: act.turnStartedAt || null } }
      }
      return out
    },
    leadRun: sessionId => leadRuns.get(sessionId),
    runForToken: token => tokens.get(token)?.runId,
    /** The step a token's agent works on (each step's agent has its own token). */
    stageForToken: token => tokens.get(token)?.stage,
    /** The step a dsh agent works on: the running step whose task is its session (else the run's current step). */
    stageOfSession(runId, sessionId) {
      const r = get(runId), h = hub()
      if ([...askTasks].some(([id, run]) => run === runId && h?.task?.(id)?.sessionId === sessionId)) return ASK_STAGE
      return r?.stages.find(s => s.status === 'running' && (s.tasks || []).some(t => h?.task?.(t)?.sessionId === sessionId))?.key || r?.stage
    },
    /** A tool call of an agent working on `stage` (its token's, its session's; else the run's current step). */
    tool: (runId, name, args, signal, stage) => {
      if (!active.has(runId)) throw new Error('this workbench run is not active any more')
      const st = stage || get(runId).stage
      const allowed = engine.toolsFor(runId, st)
      if (allowed && !allowed.includes(name)) throw new Error(`${name} is not a tool of the step ${st}`)
      return callTool(toolContext(runId, { signal, stage: st }), name, args)
    },
    /** Every tool a run's agents may be given: the workflow's and its pack's, and those its steps list. */
    toolsOfRun(runId) {
      const wf = wfOf(get(runId))
      return wf ? [...new Set([...toolNames(wf), ...wf.stages.flatMap(s => s.tools || [])])].filter(n => messagesOn(wf) || !MESSAGE_TOOLS.includes(n)) : []
    },
    /** The tools a step allows: the ones its workflow lists (a person's agent step), else the core's and its pack's. */
    toolsFor(runId, stage) {
      if (stage === ASK_STAGE) return ASK_TOOLS
      const r = get(runId), wf = wfOf(r), def = wf?.stages.find(s => s.key === (stage || r.stage)), talk = messagesOn(wf)
      // (tools_ensure runs code on this machine: only for a step whose agent may change files; the messages' tools only
      // where the workflow lets its agents talk — then every agent step has them, whatever it lists)
      return [...new Set(def?.tools ? [...ALWAYS, ...def.tools, ...(talk ? MESSAGE_TOOLS : [])] : wf ? toolNames(wf) : [])]
        .filter(n => (n !== 'tools_ensure' || mayInstall(runId, stage || r.stage)) && (talk || !MESSAGE_TOOLS.includes(n)))
    },

    /**
     * Start a run of `workflow` (a built-in's id, '<pack>.<id>' or 'blank', or a person's enabled workflow) about a request:
     * title and/or text, attachments [{ name, base64, mime?, field? }], the workflow's form fields. → the run.
     */
    async startRun({ workflow: template, title, text, attachments, fields, note, tags, params, taskId, previous, seed, why, studio } = {}) {
      const { id, wf, def, files, subject, named, asked } = await engine.checkRequest({ workflow: template, title, text, attachments, fields })
      needHub()
      // started from a studio's record (docs/design/studio.md): which — the run is where that link is kept
      const studioService = services.studio?.()
      const pack = packOf(wf), baseWorkflow = def?.base || id
      const owner = pack?.account?.studio || pack?.id
      const studioId = studio && !studio.collection && !studio.record
        ? studioService?.workflowStudio?.(baseWorkflow, studio.id, { explicit: true })
        : !studio && owner ? studioService?.workflowStudio?.(baseWorkflow, owner) : null
      const from = studioRef(studio) || (studioId ? { id: studioId } : null)
      // the model steps that will run name a model this machine can reach
      const config = structuredClone(settings())
      // a pack's account (a studio's record — a persona): read from the studio now, kept with the run and laid over the
      // pack's settings for it; changing the account later leaves this run as it was
      const acc = pack?.account, accountId = acc && subject.fields?.[acc.field]
      let account = null
      if (accountId) {
        const svc = services.studio?.()
        account = svc ? await svc.get(acc.studio, acc.collection, String(accountId)) : null
        if (!account) throw fail('noAccount', { id: accountId }, `no account "${accountId}" in the ${acc.studio} studio`)
        config.packs = { ...(config.packs || {}), [pack.id]: acc.settings(account, config.packs?.[pack.id] || {}) }
      }
      // Freeze learned defaults for this studio/persona. Later ratings never change an in-flight run.
      const studioPreferences = from && studioService?.preferences?.(from.id, { profile: account?.id || null, workflow: wf })
      for (const m of modelSteps(wf, config)) {
        if (!m.model) throw fail('noModel', { step: m.step }, `${m.step}: no model is chosen for this step (workbench settings)`)
        let ref
        try { ref = models?.parse(m.model) } catch (err) { throw fail('badModel', { step: m.step }, `${m.step}: ${err.message}`) }
        if (ref?.source === 'connection') {
          const known = await services.connectors?.()?.list?.()
          if (known && !known.some(c => c.id === ref.connection)) throw fail('noConnection', { id: ref.connection }, `${m.step}: no connection "${ref.connection}" (Connectors page) for the model ${m.model}`)
        }
      }
      // what it needs, here (lib/needs.js): installed now when this machine can (a pinned skill pack); what is still
      // missing — an agent, a connection, a script — refuses the run, saying what it is
      await prepare(wf, def)
      const pinned = await skillsAtStart(wf)
      if (named) notEditing({ folder: resolve(asked) })
      const runId = shortId('r')
      const dir = join(store.dir, 'runs', runId, 'work')
      mkdirSync(join(dir, 'attachments'), { recursive: true })
      const outDir = join(dirname(dir), 'out')
      mkdirSync(outDir, { recursive: true })
      // the attachments are kept as artifacts (the ledger names them by path and hash); the agents read copies in the run's folder
      const taken = new Set()
      subject.attachments = files.map((f, k) => {
        const art = store.artifact(runId, `a${k + 1}-${f.name}`, f.bytes)
        let name = f.name
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${n}-${f.name}`
        taken.add(name.toLowerCase())
        const copy = join(dir, 'attachments', name)
        writeFileSync(copy, f.bytes)
        return { name: f.name, ...art, size: f.size, mime: f.mime, path: copy, ...(f.field && { field: f.field }) }
      })
      // the task's last run's files (lib/tasks.js carry): in the folder before its first version
      let carried = null
      if (seed) { try { carried = seed(dir) } catch (err) { logger?.warn?.(`ruyix-workbench: ${runId}: the last run's files: ${err?.message || err}`) } }
      const r = store.put('run', {
        id: runId, template: id, subject, dir, outDir, ...(named && { folder: resolve(asked) }), ...(paramsOf(params) && { params: paramsOf(params) }), config, status: 'queued', note: note ? String(note).slice(0, 2000) : undefined,
        ...(from && { studio: from }), ...(studioPreferences && { studioPreferences: structuredClone(studioPreferences) }), ...(account && { account: { id: String(accountId), ...account } }),
        tags: Array.isArray(tags) ? tags.map(String).slice(0, 5) : [],
        stages: wf.stages.map(s => ({ key: s.key, owner: s.owner, status: 'pending', attempt: 0, ...(s.title && { title: s.title }) })), ...(def && { workflowDef: def }),
        claims: [], createdAt: Date.now(), ...(pinned.versions && Object.keys(pinned.versions).length && { skills: pinned.versions }),
        // the task it is a run of (a one-off of its own when it names none: lib/tasks.js noteRun), what started it
        taskId: taskId ? String(taskId) : `t${runId.slice(1)}`, ...(why === 'schedule' && { startedBy: 'schedule' }),
        ...(previous?.id && { previous: { id: String(previous.id), at: previous.at || null, ...(previous.schedule && { schedule: String(previous.schedule) }), ...(Number.isInteger(carried) && { files: carried }), ...(previous.inFolder && { inFolder: true }) } }),
      })
      try { onRunStart(r) } catch (err) { logger?.warn?.(`ruyix-workbench: ${runId}: its task: ${err?.message || err}`) }
      // the folder as the run found it: its first version (queued before any step's, which waits its turn)
      versions.snapshot(r, 'Start', { kind: 'start' }).then(v => v && update(r.id, x => ({ ...x, versions: { start: v.commit } })), () => {})
      drive(r.id).catch(err => logger?.warn?.(`ruyix-workbench: ${r.id}: ${err?.stack || err}`))
      return r
    },
    /**
     * A request as a run of `workflow` would take it (its form, its fields, its folder, its attachments), checked without
     * starting anything — a task checks its request when it is made, not when it is due. → what startRun builds on
     */
    async checkRequest({ workflow: template, title, text, attachments, fields } = {}) {
      const id = String(template || '').trim()
      const def = live(id) ? null : custom(id)
      const wf = def ? (live(def.base) && compose(def, live(def.base))) : live(id)
      if (!wf) throw fail('badWorkflow', { workflow: id }, `unknown workflow ${id || '(none)'}`)
      const form = checkInput(wf.input)
      if (form.length) throw fail('badInput', { errors: form.join('; ') }, `the workflow ${wf.id} has a bad form: ${form.join('; ')}`)
      const { files, errors } = decodeAttachments(attachments)
      const { fields: values, errors: fieldErrors } = checkFields(wf.input || [], fields, files)
      // a workflow that works in a folder the person names (wf.folder: the form field that holds it): a host folder, the code
      // to work on — else in the run's own
      const named = wf.folder ? String(values[wf.folder] ?? '').trim() : ''
      const asked = named.replace(/^~(?=\/|$)/, homedir())
      if (named && (!isAbsolute(asked) || !statSync(asked, { throwIfNoEntry: false })?.isDirectory())) throw fail('noFolder', { path: named }, `${named} is not a folder here (give its full path)`)
      if (named) {
        const real = p => { try { return realpathSync(p) } catch { return resolve(p) } }
        const f = real(asked), home = real(store.dir)
        if (home === f || home.startsWith(f + sep)) throw fail('noFolder', { path: named }, `${named} holds the workbench's own data (${store.dir}): name a folder inside it, not around it`)
      }
      const subject = { title: String(title ?? '').trim().slice(0, LIMITS.title), text: String(text ?? '').trim().slice(0, LIMITS.text), attachments: [], fields: values }
      const problems = [...errors, ...fieldErrors]
      if (!problems.length) {
        const bad = wf.validateInput ? await wf.validateInput({ ...subject, attachments: files.map(({ bytes: _b, ...a }) => a) }) : (!subject.title && !subject.text ? 'give a title or a text' : '')
        if (bad) problems.push(...(Array.isArray(bad) ? bad : [bad]).map(String))
      }
      if (problems.length) throw fail('badInput', { errors: problems.join('; ') }, problems.join('; '))
      return { id, wf, def, files, subject, named, asked }
    },
    stopRun(id) {
      const r = get(id)
      if (!r) throw fail('noRun', { id }, `no run ${id}`)
      active.get(id)?.controller.abort()
      return get(id)
    },
    /**
     * Continue a stopped run from its first unfinished step — or, with `from`, a finished one from that step (a person
     * re-judged an earlier step). `withNewSteps`: the steps the workflow gained since the run started are added to it
     * first (those before `from` as skipped), so the run goes through them too — else such a step is passed over.
     */
    resumeRun(id, options) {
      return restart(id, options?.by || 'person', () => resume(id, options))
    },

    // ── versions (lib/versions.js): each step's, going back to one, a person's edit, going on from a step ──
    versions,
    /** The run's versions, oldest first, each with what it is: { on, off, commits: [{ commit, at, parent, subject, mark }] }. */
    async versionsOf(id) {
      const r = get(id)
      if (!r) throw fail('noRun', { id }, `no run ${id}`)
      return { on: versions.has(r), off: versions.off(r), commits: await versions.log(r) }
    },
    /** The version a step started from (a lane of a parallel block: its block's) → { key, commit } or throws. */
    stepBase(id, key) {
      const r = get(id), wf = workflowOf(id)
      const k = wf.stages.find(s => s.key === key)?.par || key
      const s = r.stages.find(x => x.key === k)
      if (!s) throw fail('noStage', { stage: key }, `${r.template} has no step ${key}`)
      const base = s.version?.base || [...(s.history || [])].reverse().find(h => h.version?.base)?.version.base
      if (!base) throw fail('noVersion', { stage: k }, versions.has(r) ? `the step ${k} has not run yet: there is no version from before it` : 'this run has no versions (it began before them, or they are off)')
      return { key: k, commit: base }
    },
    /** What going back to before a step would do to the folder (changes nothing): { from, tree, target, files: [{ path, action }], kept }. */
    async rewindPreview(id, { from }) {
      const { key, commit } = engine.stepBase(id, from)
      return { from: key, ...(await versions.preview(get(id), commit)) }
    },
    /**
     * Back to before a step: the run stopped first when it is going, the folder as that step found it (a version of its own:
     * every later one stays), then the run goes on from that step — it and the ones after it run again.
     */
    async rewindRun(id, { from, by = 'person', expect }) {
      if (restarting.has(id)) throw fail('runBusy', {}, 'this run is already being restarted')
      restarting.add(id)
      let release
      try {
        const { key, commit } = engine.stepBase(id, from)
        // what the person saw in the preview is what is done: the target it showed, the folder as it was then (`tree`)
        if (expect?.target && expect.target !== commit) throw fail('changedMeanwhile', { path: '' }, `the step ${key} ran again since you looked: look again`)
        folderBusy(id)
        release = beforeFileMutation(get(id), { kind: 'rewind', by })
        await stopAndWait(id)
        await browsers?.closeRun(id)
        const v = await versions.rewind(get(id), commit, `Back to before ${key}`, { kind: 'rewind', step: key, to: commit, by }, { expect: expect?.tree })
        // what the person changed by hand after that point is undone with it: the steps are not told of it any more (what
        // they changed before it is still in the folder, and still said)
        const before = []
        for (const g of (get(id).guidance || []).filter(x => x.edit && x.version)) if (await versions.isAncestor(get(id), g.version, commit)) before.push(g)
        update(id, x => ({ ...x, guidance: (x.guidance || []).filter(g => !g.edit || before.some(b => b.at === g.at && b.edit === g.edit)) }))
        record(id, { stage: key, actor: by === 'person' ? 'user' : by, kind: 'version', title: `back to before ${key}: the folder as that step found it (${v.files.length + (v.more || 0)} file(s) changed back${v.kept.length ? `, ${v.kept.length} without a version moved aside` : ''})`,
          input: { version: v.commit, to: commit, files: v.files.slice(0, 50).map(f => `${f.status} ${f.path}`), ...(v.kept.length && { kept: v.kept.slice(0, 50), keptIn: v.keptDir }) }, ok: true })
        return { ...goOn(id, key, { why: 'rewind' }), kept: v.kept, keptDir: v.keptDir }
      } finally {
        try { release?.() } finally { restarting.delete(id) }
      }
    },
    /** From a step on, the folder as it is (a person changed a result, or wants a step done again with a note): it and the steps after it run again. */
    async continueRun(id, { from, note = '', by = 'person' }) {
      if (restarting.has(id)) throw fail('runBusy', {}, 'this run is already being restarted')
      restarting.add(id)
      let release
      try {
        const r = get(id)
        if (!r) throw fail('noRun', { id }, `no run ${id}`)
        const wf = workflowOf(id), key = wf.stages.find(s => s.key === from)?.par || from
        if (!r.stages.some(s => s.key === key)) throw fail('noStage', { stage: from }, `${r.template} has no step ${from}`)
        folderBusy(id)
        release = beforeFileMutation(r, { kind: 'restart', by })
        await stopAndWait(id)
        await browsers?.closeRun(id)
        const text = String(note || '').trim().slice(0, 4000)
        if (text) update(id, x => ({ ...x, guidance: [...(x.guidance || []), { stage: key, text, at: Date.now(), by }] }))
        record(id, { stage: key, actor: by === 'person' ? 'user' : by, kind: 'version', title: `go on from ${key}${text ? `: ${text.slice(0, 200)}` : ''}`, input: { note: text || null }, ok: true })
        return goOn(id, key, { why: 'continue' })
      } finally {
        try { release?.() } finally { restarting.delete(id) }
      }
    },
    /** A step and the ones after it run again (each one's last attempt kept in its history); the run goes on from it. */
    goOn(id, key, options) {
      return restart(id, options?.by || 'person', () => goOn(id, key, options))
    },
    /**
     * A person changes a file of the run's folder (a step's result): written and kept as a version of its own. Not while a
     * step works in the folder — a run waiting for the person, or over, is fine. `blob`: the copy they changed (null: a new file).
     * The steps that run after it are told (their brief), so the change is built on, not undone.
     */
    async editFile(id, { path, content, blob, by = 'person' }, after) {
      const r = get(id)
      if (!r) throw fail('noRun', { id }, `no run ${id}`)
      if (restarting.has(id)) throw fail('runBusy', {}, 'this run is already being restarted')
      const lanesBusy = active.has(id) && (wfOf(r)?.stages || []).some(d => d.par && r.stages.some(s => s.key === d.key && s.status === 'running' && !s.asking))
      if (active.has(id) && (r.status !== 'waiting' || lanesBusy)) throw fail('runBusy', {}, 'a step is working in this folder: wait until it waits for you or is over, or stop it')
      folderBusy(id)
      const key = folderKey(r)
      const release = beforeFileMutation(r, { kind: 'edit', path, by })
      editing.add(key)
      try {
        const v = await versions.edit(r, path, content, { blob, by })
        if (!v) throw fail('noVersions', {}, versions.off(r) || 'this run has no versions')
        if (v.made) {
          const p = v.path
          record(id, { stage: 'note', actor: by === 'person' ? 'user' : by, kind: 'version', title: `${by === 'person' ? 'the person' : by} changed ${p}`, input: { version: v.commit, path: p }, ok: true })
          update(id, x => ({ ...x, edits: [...(x.edits || []), { path: p, version: v.commit, by, at: Date.now() }].slice(-50), guidance: [...(x.guidance || []).filter(g => g.edit !== p), { text: `The person changed ${p} by hand (version ${v.commit.slice(0, 8)}): keep their change, build on it.`, at: Date.now(), edit: p, version: v.commit }] }))
        }
        if (after) await after(v) // internal pack hook: derived files and their version belong to the same edit
        return v
      } finally { editing.delete(key); release?.() }
    },

    /** A card for a run (a workflow's action, or a pack's op, makes one). */
    addApproval: (runId, spec) => createApproval(runId, spec),
    /** A question for the agent of the step an ask card waits at: it answers from the run's record while the run waits. */
    askHelp(id, text) {
      const a = store.get('approval', String(id))
      const talking = a?.payload?.kind === 'chat' || !!a?.payload?.talk
      if (!a || a.action !== 'help' || !(ASKED.includes(a.payload?.kind) || talking)) throw fail('noApproval', { id }, `no ask ${id}`)
      if (!['pending', 'failed'].includes(a.status)) throw fail('approvalDone', { status: a.status }, `this ask is already ${a.status}`)
      const q = String(text ?? '').trim().slice(0, talking ? 8000 : 2000)
      if (!q) throw fail('needInput', {}, 'write the question first')
      const chat = a.chat || []
      if (talking && chat.length >= TALK_MAX) throw fail('talkTooLong', { n: TALK_MAX }, `${TALK_MAX} messages: settle it, or stop the step`)
      if (!talking && chat.length >= 20) throw fail('tooMany', {}, 'twenty questions are enough: answer, or stop the step')
      return store.put('approval', { ...a, chat: [...chat, { n: chat.length + 1, q, at: Date.now() }] })
    },
    async approve(id, payload) {
      const a = store.get('approval', id)
      if (!a) throw fail('noApproval', { id }, `no approval ${id}`)
      if (!['pending', 'failed'].includes(a.status)) throw fail('approvalDone', { status: a.status }, `this approval is already ${a.status}`)
      if (a.action === 'help' && (payload?.rev ?? 0) !== (a.payload?.rev || 0)) throw fail('changedMeanwhile', {}, 'the question changed: clear the old answer, read it again, then answer')
      const r = get(a.runId)
      notEditing(r)
      if (restarting.has(a.runId)) throw fail('runBusy', {}, 'this run is already being restarted')
      const wf = workflowOf(a.runId)
      const act = wf.actions?.[a.action]
      if (typeof act !== 'function') throw fail('noAction', { action: a.action }, `the workflow ${wf.id} has no action "${a.action}"`)
      // what the card is (its options, its step, whose ask, its wait) stays as it was made: a person fills in its fields only
      const merged = payload && typeof payload === 'object' ? { ...a.payload, ...payload, ...Object.fromEntries(FIXED.filter(k => a.payload && k in a.payload).map(k => [k, a.payload[k]])) } : a.payload
      if (a.action === 'help') answerOf(merged) // an answer that says nothing is refused here, not failed on the card
      const next = store.put('approval', { ...a, payload: merged, status: 'running', decidedAt: Date.now(), error: null })
      record(a.runId, { stage: 'approval', actor: 'user', kind: 'approval', title: `approved: ${a.title}`, input: { approval: id, action: a.action, payload: next.payload }, ok: true })
      const pack = packOf(wf), config = settingsForRun(r.id)
      try {
        const result = await act({
          approval: next, run: r, store, settings: config, services, workflow: wf, pack, packSettings: pack && config.packs?.[pack.id],
          // the settings as they are now (`settings` / `packSettings` are the run's snapshot from its start): an action that
          // reaches outside reads these — the person may have changed an account or a folder since the run began
          currentSettings: () => settings(),
          currentPackSettings: () => (pack ? settings().packs?.[pack.id] ?? {} : {}),
          exec, script: ref => scripts?.get(ref) ?? null,
          get outDir() { return outDirOf(get(a.runId)) },
          command: (title, res, input) => recordCommand(a.runId, 'approval', title, res, input),
          evidence: entry => record(a.runId, { stage: 'approval', ...entry }),
          approvals: () => store.list('approval').filter(x => x.runId === a.runId),
          addApproval: spec => createApproval(a.runId, spec),
          browser: browserFor(a.runId, 'approval'),
          update: change => update(a.runId, change),
        })
        // from the card as it is now: an action may have rewritten its own payload (a one-shot choice it used up)
        const current = store.get('approval', id) || next
        if (current.status !== 'superseded') store.put('approval', { ...current, status: 'done', result, doneAt: Date.now() })
      } catch (err) {
        const current = store.get('approval', id) || next
        if (current.status !== 'superseded') store.put('approval', { ...current, status: 'failed', error: err?.message || String(err) })
        record(a.runId, { stage: 'approval', kind: 'gate', title: `failed: ${a.title}`, output: err?.message || String(err), ok: false })
      }
      try { await writeReport(a.runId) } catch { /* report regenerates next time */ }
      return store.get('approval', id)
    },
    reject(id, reason, rev) {
      const a = store.get('approval', id)
      if (!a) throw fail('noApproval', { id }, `no approval ${id}`)
      if (!['pending', 'failed'].includes(a.status)) throw fail('approvalDone', { status: a.status }, `this approval is already ${a.status}`)
      if (a.action === 'help' && (rev ?? 0) !== (a.payload?.rev || 0)) throw fail('changedMeanwhile', {}, 'the question changed: read it again before rejecting')
      record(a.runId, { stage: 'approval', actor: 'user', kind: 'approval', title: `rejected: ${a.title}`, input: { approval: id, reason: reason || '' }, ok: false })
      return store.put('approval', { ...a, status: 'rejected', reason: String(reason || ''), decidedAt: Date.now() })
    },

    /** Something outside the steps happened to a run: the change and its ledger entry. */
    annotate(id, change, entry, { quiet = false } = {}) {
      if (!get(id)) throw fail('noRun', { id }, `no run ${id}`)
      if (change) update(id, change)
      const e = entry ? record(id, { stage: 'note', actor: 'system', ...entry }) : null
      // quiet: a bookkeeping change — the report (which re-hashes the whole ledger) stays as it is
      if (!quiet) void writeReport(id).catch(() => {}) // preserve the synchronous evidence-return contract
      return e
    },
    writeReport,
    browsers,
    dispose() {
      shuttingDown = true
      reportController.abort()
      clearTimeout(autoTimer)
      browsers?.dispose().catch(() => {})
      // written now: the store closes right after this, before the runs' own clean-up gets a turn
      for (const [runId, { controller }] of [...active]) {
        interruptByShutdown(runId)
        controller.abort()
      }
    },
  }
  return engine
}
