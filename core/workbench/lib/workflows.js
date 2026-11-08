// Workflows as data. The built-in workflows (the core's `blank`, a domain pack's) are code: their steps carry the gates
// and evidence rules that make a run trustworthy. A person's workflow is a definition built on one of them (its `base`):
// the base's steps in their order — an optional one may be left out, each agent step may name its agent, fallback and
// skills — and steps of the generic kinds put in between (after the base's `insertFrom` step — the first one if it names
// none — and before its first closing step):
//   agent     one agent of the pool does what its instructions say, with the tools it is given, and hands back a result;
//   model     one call to a model (no tools, no agent): the request, what the earlier steps handed back and its
//             instructions go in, its answer is the step's result — for work whose input is all there (rewrite,
//             summarise, translate), at a fraction of an agent's tokens;
//   script    a command in the run's folder (or the workspace) — written in the step, or an installed script
//             (scripts/<name>/<version>/, its manifest.json naming the entry) — with the variables of the connections it
//             needs (by type and level, bound on each machine — lib/needs.js — or, in an older definition, by id);
//   approval  the run waits for a person: continue, or stop here;
//   person    the person's part (lib/person.js): review (approve, ask for changes — back to the step it names, with the
//             notes — or stop), input (an answer the next steps build on), decide (one of its choices — one may go back
//             to a step; a branch after it reads the choice), do (something done outside, said done), chat (a
//             discussion with an agent of the run — `with` a step's, else the latest's — settled: what was agreed goes
//             to the steps after it; `back` with it, or stop); each waits for the person, a reminder in the inbox once
//             its hours are up;
//   branch    the run takes one of its routes — by a condition (an earlier step passed or failed, what a step handed
//             back, the run's verdict) or as an agent decides — each route steps of the five kinds above (or
//             none), the rest skipped as "not on this path"; then it goes on with the step after the branch — or a route
//             goes back to an earlier step (`back: { to, max }`: a check that finds the work wrong → the step that made it), at
//             most `max` times, then the run stops for a person;
//   parallel  its lanes (2–5) run at the same time — read-only work: checks, reviews (an agent step that only reads, a
//             model step, a script with read connectors) — and the run goes on once every lane is through
//             (the join); a lane that fails fails the block (its "on failure": stop, carry on, or go back).
// What a workflow needs (its agents, its skill packs pinned in `packs`, its connections, its models, its scripts) is
// worked out on each machine before a run starts (lib/needs.js readiness).
// The graph this makes: steps in order, a branch's routes and a parallel block's lanes, and the loops back (a step's
// "on failure, go back to", a route's `back`), each with its count — every loop has a way out.
// Definitions live in <home>/workflows/<id>.json, a draft until a person enables it; a run keeps the definition it
// started with (run.workflowDef), so editing one changes no run in progress.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { header, outputsText, subjectText } from '../workflows/common.js'
import { isModelRef, parseModelRef } from './models.js'
import { LEVELS, NAME, TYPE, keyOf, needsOf, pinsOf } from './needs.js'
import { parseTool } from './toolbox.js'
import { ASKS, WAIT, WAIT_MAX, deadline, personStep, settle } from './person.js'
import { LIMITS as REVIEW_LIMITS, ROUNDS_MAX } from './review.js'
import { outputStep } from './results.js'
import { FLOW_MAX, checkFlow } from './flow/check.js'
import { flowStage } from './flow/stage.js'
import { dirOf } from './subject.js'
import { ALWAYS, both, tail } from './tools.js'

export const KIND = 'ruyix-workflow'
export const GENERIC = ['agent', 'model', 'script', 'approval', 'person', 'output', 'branch', 'parallel', 'flow']
const LANE = ['agent', 'model', 'script', 'approval', 'person', 'output'] // what a branch's route holds
const PAR = ['agent', 'model', 'script'] // what a parallel block's lane holds (read-only work)
const WHEN_IS = ['passed', 'failed', 'skipped']
const CWD = ['run', 'workspace']
const SLUG = /^[a-z][a-z0-9-]{1,39}$/
const AGENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL = /^(?:[a-z0-9][a-z0-9-]{1,40}\/)?[\w.-]{1,64}$/
const SCRIPT = /^([a-z0-9][a-z0-9._-]{0,63})@([0-9A-Za-z][0-9A-Za-z.+-]{0,39})$/
// names a step may not take: the engine's own records (ledger stages)
export const RESERVED = new Set(['approval', 'resume', 'note', 'workflow'])
const str = (v, max) => String(v ?? '').trim().slice(0, max)

/** The base's steps as a definition lists them: which may be left out, which take an agent (and its role's default). */
export function library(base) {
  const role = s => (s.owner !== 'system' ? base.roles?.[s.owner] || null : null)
  return base.stages.map(s => ({ key: s.key, owner: s.owner, optional: !!s.optional, final: !!s.final, agent: role(s)?.kind === 'model' ? null : role(s), model: role(s)?.kind === 'model' ? role(s) : null }))
}
/** Where generic steps may go: after the base's `insertFrom` step (the first one, if it names none), before its first closing step. */
const window = base => {
  const lo = Math.max(0, base.stages.findIndex(s => s.key === base.insertFrom))
  const hi = base.stages.findIndex(s => s.final)
  return { lo, hi: hi < 0 ? base.stages.length : hi }
}

/**
 * Check a definition against its base and what this machine has: → { def (normalized), errors: [{ step?, field?, message }] }.
 * `agents` / `connectors` / `tools`: the ids known here (a missing list skips that check).
 */
export function validate(input, { bases, agents, connectors, scripts, tools = ALWAYS, builtIn = [] }) {
  const errors = []
  const err = (message, extra = {}) => errors.push({ message, ...extra })
  const d = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const id = str(d.id, 40).toLowerCase()
  if (!SLUG.test(id)) err('the id is 2–40 lowercase letters, digits and dashes, starting with a letter', { field: 'id' })
  if (builtIn.includes(id)) err(`"${id}" is a built-in workflow: give yours another id`, { field: 'id' })
  const base = bases[d.base]
  if (!base) err(`the base is one of ${Object.keys(bases).join(', ')}`, { field: 'base' })
  const title = str(d.title, 80) || id
  const steps = Array.isArray(d.steps) ? d.steps : []
  const out = { kind: KIND, version: 1, id, title, description: str(d.description, 2000), base: d.base, steps: [] }
  // the skill packs its steps use, each where it comes from and the commit (or version) it was made with: a machine
  // without it installs that one
  const packs = pickPacks(d.packs)
  if (packs.length) out.packs = packs
  // its agents may leave each other messages (lib/messages.js): every agent step gets the tools and the skill
  if (d.messages !== undefined && typeof d.messages !== 'boolean') err('messages is true or false', { field: 'messages' })
  if (d.messages === true) out.messages = true
  // its agent steps run in resident sessions (Agent Hub's; docs/design/sessions.md §2): a role's next step goes on in the
  // session its last one used — off by default
  if (d.sessions !== undefined && typeof d.sessions !== 'boolean') err('sessions is true or false', { field: 'sessions' })
  if (d.sessions === true) out.sessions = true
  if (!base) return { def: out, errors }

  const keys = base.stages.map(s => s.key)
  const { lo, hi } = window(base)
  const seen = new Set()
  let lastBase = -1 // the base position of the last base step listed
  for (const [i, raw] of steps.entries()) {
    const s = raw && typeof raw === 'object' ? raw : {}
    const use = str(s.use, 40)
    const at = { step: i }
    if (keys.includes(use)) {
      const k = keys.indexOf(use)
      if (seen.has(use)) { err(`${use} is listed twice`, at); continue }
      if (k < lastBase) err(`${use} comes before ${keys[lastBase]} in ${d.base}: base steps keep their order`, at)
      seen.add(use)
      lastBase = Math.max(lastBase, k)
      const stage = base.stages[k], step = { use }
      if (base.roles?.[stage.owner]?.kind === 'model') {
        if (s.model !== undefined && s.model !== '') step.model = pickModel(s.model, at)
      } else if (stage.owner !== 'system') {
        if (s.agent !== undefined && s.agent !== '') step.agent = pickAgent(s.agent, 'agent', at)
        if (s.fallback !== undefined) step.fallback = s.fallback === '' || s.fallback === null ? '' : pickAgent(s.fallback, 'fallback', at)
        if (s.skills !== undefined) step.skills = pickSkills(s.skills, at)
      }
      if (s.human !== undefined) step.human = pickHuman(s.human, at)
      if (s.cli !== undefined) { const cli = pickCli(s.cli, at); if (cli.length) step.cli = cli }
      out.steps.push(step)
      continue
    }
    if (!GENERIC.includes(use)) { err(`"${use}" is not a step of ${d.base} nor one of ${GENERIC.join(', ')}`, at); continue }
    if (use === 'parallel') { out.steps.push(parallel(s, at, i)); continue }
    if (use === 'flow') { out.steps.push(flow(s, at)); continue }
    if (use !== 'branch') { const step = generic(s, at); if (step) out.steps.push(step); continue }
    // a branch: its routes (each a lane of steps), the "otherwise" lane, and how it picks
    const step = { ...named(s, at), use, mode: s.mode === 'agent' ? 'agent' : 'condition' }
    if (step.mode === 'agent') {
      step.agent = pickAgent(s.agent, 'agent', at, true)
      step.fallback = s.fallback ? pickAgent(s.fallback, 'fallback', at) : ''
      step.instructions = str(s.instructions, 4000)
    }
    const routes = Array.isArray(s.routes) ? s.routes : []
    if (!routes.length || routes.length > 5) err('a branch has 1–5 routes besides "otherwise"', { ...at, field: 'routes' })
    step.routes = routes.slice(0, 5).map((raw, k) => {
      const r = raw && typeof raw === 'object' ? raw : {}
      const rid = str(r.id, 40).toLowerCase() || `route-${k + 1}`
      const route = { id: rid, label: str(r.label, 60) || rid }
      if (step.mode === 'condition') route.when = pickWhen(r.when, { ...at, field: `routes.${k}.when` })
      else route.hint = str(r.hint, 600)
      route.steps = lane(r.steps, i, k)
      if (r.back) route.back = pickBack(r.back, { ...at, field: `routes.${k}.back` })
      return route
    })
    if (new Set(step.routes.map(r => r.id)).size < step.routes.length || step.routes.some(r => r.id === 'otherwise')) err('each route of a branch has an id of its own (not "otherwise")', { ...at, field: 'routes' })
    step.otherwise = { label: str(s.otherwise?.label, 60) || 'otherwise', steps: lane(s.otherwise?.steps, i, step.routes.length), ...(s.otherwise?.back && { back: pickBack(s.otherwise.back, { ...at, field: 'otherwise.back' }) }) }
    out.steps.push(step)
  }
  // a generic step sits after the base's insertFrom step and before its closing steps
  out.steps.forEach((s, i) => {
    if (!GENERIC.includes(s.use)) return
    const prev = out.steps.slice(0, i).filter(x => keys.includes(x.use)).map(x => keys.indexOf(x.use)).pop() ?? -1
    const next = out.steps.slice(i + 1).filter(x => keys.includes(x.use)).map(x => keys.indexOf(x.use))[0] ?? keys.length
    if (prev < lo || next > hi) err(`${s.id} must come after ${keys[lo]} and before ${keys[hi] || 'the end'}`, { step: i })
  })
  // every step of the base that cannot be left out is there
  for (const st of base.stages) if (!st.optional && !seen.has(st.key)) err(`${st.key} is a required step of ${d.base}`)
  // what a step refers to comes before it — a loop's target, a condition's step — on the same path (not in another route)
  const flat = []
  out.steps.forEach((s, i) => {
    flat.push({ key: s.id || s.use, s, at: { step: i }, lane: null })
    if (s.use === 'branch') [...s.routes.map(r => r.steps), s.otherwise.steps].forEach((l, k) => l.forEach((x, j) => flat.push({ key: x.id, s: x, at: { step: i, lane: k, index: j }, lane: `${s.id}:${k}` })))
    if (s.use === 'parallel') s.lanes.forEach((l, k) => l.steps.forEach((x, j) => flat.push({ key: x.id, s: x, at: { step: i, lane: k, index: j }, lane: `${s.id}:${k}`, par: true })))
  })
  // what a step can refer to: the main line before it, its own lane, and a parallel block's lanes (all through by its join)
  const reachable = p => flat.slice(0, p).filter(f => f.lane === null || f.par || f.lane === flat[p].lane)
  flat.forEach((f, p) => {
    if (f.s.onFail?.goto && !reachable(p).some(x => x.key === f.s.onFail.goto)) err(`on failure it goes back to "${f.s.onFail.goto}", which is not a step before it`, { ...f.at, field: 'onFail' })
    // a person's way back — changes asked, a choice that goes back — is to a step before it on its path
    for (const to of [f.s.back, ...(f.s.options || []).map(o => o.to)].filter(Boolean)) if (!reachable(p).some(x => x.key === to)) err(`it goes back to "${to}", which is not a step before it`, { ...f.at, field: f.s.back === to ? 'back' : 'options' })
    // a review's reviser: an agent step before it (the base's own agent steps too)
    // a discussion's agent: an agent step before it
    if (typeof f.s.with === 'string' && f.s.use === 'person' && !reachable(p).some(x => x.key === f.s.with && !['person', 'approval', 'output', 'branch', 'parallel', 'script', 'model', 'flow'].includes(x.s.use))) err(`with: "${f.s.with}" is not an agent step before it`, { ...f.at, field: 'with' })
    if (typeof f.s.revisedBy === 'string' && !reachable(p).some(x => x.key === f.s.revisedBy && !['person', 'approval', 'output', 'branch', 'parallel', 'script', 'model', 'flow'].includes(x.s.use))) err(`revisedBy: "${f.s.revisedBy}" is not an agent step before it`, { ...f.at, field: 'revisedBy' })
    // a route that goes back: to a step before the branch, on the main line (another route's or a lane's step is not there)
    if (f.s.use === 'branch') for (const [k, r] of [...f.s.routes, f.s.otherwise].entries()) {
      if (r.back && !reachable(p).some(x => x.lane === null && x.key === r.back.to)) err(`the route "${r.label}" goes back to "${r.back.to}", which is not a step before the branch on the main line`, { ...f.at, field: k < f.s.routes.length ? `routes.${k}.back` : 'otherwise.back' })
    }
    if (f.s.use !== 'branch' || f.s.mode !== 'condition') return
    for (const [k, r] of f.s.routes.entries()) {
      const ref = r.when?.step || r.when?.output
      const hit = ref && reachable(p).find(x => x.key === ref)
      if (ref && !hit) err(`the route "${r.label}" looks at "${ref}", which is not a step before the branch`, { ...f.at, field: `routes.${k}.when` })
      else if (r.when?.output && !['agent', 'model', 'script', 'person', 'flow'].includes(hit.s.use)) err(`the route "${r.label}" reads what "${ref}" handed back: only an agent, model, script, person or script-workflow step of yours hands something back`, { ...f.at, field: `routes.${k}.when` })
      // a failed step stops the run (a base step: on to the closing steps) unless it is one of yours that carries on
      else if (r.when?.is === 'failed' && hit.s.onFail !== 'continue') err(`the route "${r.label}" waits for "${ref}" to fail, but a failure there stops the run: set its "on failure" to carry on`, { ...f.at, field: `routes.${k}.when` })
    }
  })
  // A script that writes through a connection acts on the world: a person's approval comes before it on its path (the main
  // line before it, or earlier in its own route — an approval inside another route is not on its path). A person's
  // review is one: the run goes on past it only once they approve.
  const writes = x => x.use === 'script' && needsOf(x).some(n => n.level === 'write')
  const approvedBefore = (list, approved, where) => list.reduce((ok, x, j) => {
    if (x.use === 'approval' || (x.use === 'person' && x.ask === 'review')) return true
    if (writes(x) && !ok) err(`${x.id} writes through a connection: put an approval step before it, on its path, so a person says yes first`, { ...where(j), field: 'connectors' })
    return ok
  }, approved)
  let approved = false
  out.steps.forEach((s, i) => {
    if (s.use === 'branch') [...s.routes.map(r => r.steps), s.otherwise.steps].forEach((l, k) => approvedBefore(l, approved, j => ({ step: i, lane: k, index: j })))
    else if (s.use === 'parallel') s.lanes.forEach((l, k) => approvedBefore(l.steps, approved, j => ({ step: i, lane: k, index: j })))
    else approved = approvedBefore([s], approved, () => ({ step: i }))
  })
  return { def: out, errors }

  /**
   * A parallel block: its lanes run at once, so they only read — an agent step with read access, a script whose
   * connectors only read — and a lane's failure stops the lane or carries on (going back is the block's own "on
   * failure").
   */
  function parallel(s, at, i) {
    const step = { ...named(s, at), use: 'parallel' }
    const lanes = Array.isArray(s.lanes) ? s.lanes : []
    if (lanes.length < 2 || lanes.length > 5) err('a parallel block has 2–5 lanes', { ...at, field: 'lanes' })
    step.lanes = lanes.slice(0, 5).map((raw, k) => {
      const l = raw && typeof raw === 'object' ? raw : {}
      const lid = str(l.id, 40).toLowerCase() || `lane-${k + 1}`
      const steps = (Array.isArray(l.steps) ? l.steps.slice(0, 12) : []).map((x, j) => {
        const where = { step: i, lane: k, index: j }, u = str(x?.use, 40)
        if (!PAR.includes(u)) { err(`a parallel lane holds agent, model and script steps, not "${u}"`, where); return null }
        const g = generic(x, where)
        if (!g) return null
        if (g.use === 'agent' && g.access !== 'read') err(`${g.id} runs beside other lanes: give it read access (a change happens on the main line)`, { ...where, field: 'access' })
        if (g.use === 'script' && needsOf(g).some(n => n.level !== 'read')) err(`${g.id} runs beside other lanes: its connectors only read (no write)`, { ...where, field: 'connectors' })
        if (g.onFail?.goto) err(`${g.id} is in a parallel lane: it stops or carries on; going back is the block's own "on failure"`, { ...where, field: 'onFail' })
        return g
      }).filter(Boolean)
      if (!steps.length) err(`the lane "${str(l.label, 60) || lid}" has no steps`, { ...at, field: `lanes.${k}` })
      return { id: lid, label: str(l.label, 60) || lid, steps }
    })
    if (new Set(step.lanes.map(l => l.id)).size < step.lanes.length) err('each lane of a parallel block has an id of its own', { ...at, field: 'lanes' })
    step.onFail = pickOnFail(s.onFail, at)
    return step
  }
  /**
   * A script step (lib/flow): its script — checked, never run here — the agents it asks by role (each an agent of the
   * pool, its access; a role the script asks must be one of them), its parameters (a default each; a run may give its
   * own), the installed scripts it runs (as a script step's), its command-line tools and its "on failure".
   */
  function flow(s, at) {
    const step = { ...named(s, at), use: 'flow', source: String(s.source ?? '').slice(0, FLOW_MAX) }
    const c = checkFlow(s.source)
    for (const e of c.errors) err(e, { ...at, field: 'source' })
    step.agents = {}
    for (const [role, a] of Object.entries(s.agents && typeof s.agents === 'object' && !Array.isArray(s.agents) ? s.agents : {}).slice(0, 10)) {
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(role)) { err(`"${role}" is not a role name (lowercase letters, digits and dashes)`, { ...at, field: 'agents' }); continue }
      step.agents[role] = { agent: pickAgent(a?.agent, 'agents', at, true), fallback: a?.fallback ? pickAgent(a.fallback, 'agents', at) : '', access: a?.access === 'write' ? 'write' : 'read', ...(str(a?.instructions, 4000) && { instructions: str(a.instructions, 4000) }) }
    }
    for (const r of c.roles) if (!step.agents[r]) err(`the script asks the agent "${r}": add it to the step's agents`, { ...at, field: 'agents' })
    for (const ref of c.scripts) {
      if (!SCRIPT.test(ref)) err(`"${ref}" is not an installed script (name@version)`, { ...at, field: 'source' })
      else if (scripts && !scripts.includes(ref)) err(`the script ${ref} is not installed here (scripts/${ref.replace('@', '/')})`, { ...at, field: 'source' })
    }
    step.params = {}
    for (const [k, p] of Object.entries(s.params && typeof s.params === 'object' && !Array.isArray(s.params) ? s.params : {}).slice(0, 20)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k)) { err(`"${k}" is not a parameter name`, { ...at, field: 'params' }); continue }
      const d = p?.default
      step.params[k] = { title: str(p?.title, 120), default: ['string', 'number', 'boolean'].includes(typeof d) ? (typeof d === 'string' ? d.slice(0, 2000) : d) : null }
    }
    if (s.cli !== undefined) { const cli = pickCli(s.cli, at); if (cli.length) step.cli = cli }
    step.onFail = pickOnFail(s.onFail, at)
    if (s.human !== undefined) step.human = pickHuman(s.human, at)
    return step
  }
  /** A route's way back: to an earlier step, at most `max` times (then the run stops for a person). */
  function pickBack(v, at) {
    const to = str(v?.to, 40)
    if (!to) err('a route that goes back names the step it goes back to', at)
    return { to, max: Math.min(Math.max(Number(v?.max) || 2, 1), 10) }
  }
  /** A step's id (unique in the workflow, no base step's or the engine's name) and title. */
  function named(s, at) {
    const sid = str(s.id, 40).toLowerCase()
    if (!SLUG.test(sid)) err('a step id is 2–40 lowercase letters, digits and dashes', { ...at, field: 'id' })
    else if (keys.includes(sid) || RESERVED.has(sid) || seen.has(sid)) err(`the step id "${sid}" is taken`, { ...at, field: 'id' })
    seen.add(sid)
    return { id: sid, title: str(s.title, 80) || sid }
  }
  /** An agent, model, script, approval or person step. */
  function generic(s, at) {
    const use = str(s.use, 40)
    if (!LANE.includes(use)) { err(`a route holds agent, model, script, approval, person and output steps, not "${use}"`, at); return null }
    const step = { ...named(s, at), use }
    if (use === 'agent') {
      step.instructions = str(s.instructions, 6000)
      if (!step.instructions) err('an agent step needs instructions: what to do, and what to hand back', { ...at, field: 'instructions' })
      step.agent = pickAgent(s.agent, 'agent', at, true)
      step.fallback = s.fallback ? pickAgent(s.fallback, 'fallback', at) : ''
      step.access = s.access === 'write' ? 'write' : 'read'
      step.skills = pickSkills(s.skills || [], at)
      const listed = Array.isArray(s.tools) ? [...new Set(s.tools.map(String))] : []
      const unknown = listed.filter(n => !tools.includes(n))
      if (unknown.length) err(`unknown tools: ${unknown.join(', ')}`, { ...at, field: 'tools' })
      step.tools = listed.filter(n => tools.includes(n) && !ALWAYS.includes(n))
      // in a workflow with sessions: 'fresh' — this step in a new session (fresh eyes: a check, a review); 'run' (the
      // default) — on in its role's session when it may
      if (s.session !== undefined && !['fresh', 'run'].includes(s.session)) err('session is fresh or run', { ...at, field: 'session' })
      if (s.session === 'fresh') step.session = 'fresh'
      // the agents' browser (one for all agents, where the person is signed in; they take turns): 'shared'; \`login\`: the
      // step needs to be signed in there — without it the step fails plainly rather than going on signed out
      if (s.browser !== undefined && s.browser !== 'shared') err('browser is shared (the agents\' browser)', { ...at, field: 'browser' })
      if (s.browser === 'shared') step.browser = 'shared'
      if (s.login !== undefined && typeof s.login !== 'boolean') err('login is true or false', { ...at, field: 'login' })
      if (s.login === true) { if (s.browser !== 'shared') err('login is for a step with browser: shared', { ...at, field: 'login' }); else step.login = true }
    } else if (use === 'model') {
      step.instructions = str(s.instructions, 6000)
      if (!step.instructions) err('a model step needs instructions: what to make of the request and the earlier steps', { ...at, field: 'instructions' })
      step.model = s.model === undefined || s.model === '' ? '' : pickModel(s.model, at) // '' → the workbench's default model
    } else if (use === 'script') {
      // a command of its own, or an installed script (name@version) with its arguments
      if (s.script) {
        step.script = str(s.script, 110)
        if (!SCRIPT.test(step.script)) err('an installed script is named name@version', { ...at, field: 'script' })
        else if (scripts && !scripts.includes(step.script)) err(`the script ${step.script} is not installed here (scripts/${step.script.replace('@', '/')})`, { ...at, field: 'script' })
        step.args = Array.isArray(s.args) ? s.args.map(a => String(a).slice(0, 500)).slice(0, 20) : []
      } else {
        step.run = str(s.run, 4000)
        if (!step.run) err('a script step needs the command to run (or an installed script)', { ...at, field: 'run' })
      }
      if (s.cwd !== undefined && !CWD.includes(s.cwd)) err(`cwd is ${CWD.join(' or ')}`, { ...at, field: 'cwd' })
      step.cwd = s.cwd === 'workspace' ? 'workspace' : 'run'
      step.timeoutMinutes = Math.min(Math.max(Number(s.timeoutMinutes) || 10, 1), 120)
      // what it connects to: by type and level (each machine binds it to a connection of its own), or, in an older
      // definition, a connection by its id
      if (Array.isArray(s.connectors)) step.connectors = pickNeeds(s.connectors, at)
      else {
        step.connectors = {}
        for (const [cid, level] of Object.entries(s.connectors && typeof s.connectors === 'object' ? s.connectors : {})) {
          if (!LEVELS.includes(level)) { err(`${cid}: the level is read or write`, { ...at, field: 'connectors' }); continue }
          if (connectors && !connectors.includes(cid)) err(`no connector "${cid}" (Connectors page)`, { ...at, field: 'connectors' })
          step.connectors[cid] = level
        }
      }
    } else if (use === 'person') {
      step.ask = ASKS.includes(s.ask) ? s.ask : 'review'
      if (s.ask !== undefined && !ASKS.includes(s.ask)) err(`a person step asks ${ASKS.join(', ')}`, { ...at, field: 'ask' })
      step.text = str(s.text, 2000)
      if (!step.text) err('a person step says what it asks of the person', { ...at, field: 'text' })
      if ((step.ask === 'review' || step.ask === 'chat') && s.back) step.back = str(s.back, 40)
      // a discussion: whose agent the person talks with (none: the latest agent step before it that ran)
      if (step.ask === 'chat' && s.with) step.with = str(s.with, 40)
      // a review's own settings (lib/review.js): what it shows, a note first, who revises, how many rounds, a pack's display
      if (step.ask === 'review') {
        if (s.show !== undefined) {
          const show = (Array.isArray(s.show) ? s.show : [s.show]).map(x => str(x, REVIEW_LIMITS.pattern)).filter(Boolean)
          if (show.length > REVIEW_LIMITS.show || show.some(x => x.startsWith('/') || x.split('/').includes('..'))) err(`show: at most ${REVIEW_LIMITS.show} paths (or patterns with *) inside the run's folder`, { ...at, field: 'show' })
          if (show.length) step.show = show.slice(0, REVIEW_LIMITS.show)
        }
        if (s.gather === true) step.gather = true
        if (s.revisedBy === false) step.revisedBy = false
        else if (s.revisedBy !== undefined && s.revisedBy !== null && s.revisedBy !== '') step.revisedBy = str(s.revisedBy, 40)
        if (s.rounds !== undefined && s.rounds !== null && s.rounds !== '') {
          const n = Math.round(Number(s.rounds))
          if (!Number.isFinite(n) || n < 1 || n > ROUNDS_MAX) err(`rounds: 1–${ROUNDS_MAX}`, { ...at, field: 'rounds' })
          else step.rounds = n
        }
        if (s.display) { step.display = str(s.display, 80); if (!/^[\w-]+\.[\w-]+$/.test(step.display)) err('display: a pack\'s display, <pack>.<name>', { ...at, field: 'display' }) }
      }
      if (step.ask === 'decide') {
        step.options = (Array.isArray(s.options) ? s.options : []).slice(0, 6).map(o => ({ label: str(o?.label, 60), ...(o?.to && { to: str(o.to, 40) }) })).filter(o => o.label)
        if (step.options.length < 2) err('a decision offers two choices or more', { ...at, field: 'options' })
        if (new Set(step.options.map(o => o.label)).size < step.options.length) err('each choice has a label of its own', { ...at, field: 'options' })
      }
      const wait = s.wait === undefined || s.wait === '' || s.wait === null ? WAIT[step.ask] : Math.round(Number(s.wait))
      if (!Number.isFinite(wait) || wait < 0 || wait > WAIT_MAX) err(`a person step waits 0–${WAIT_MAX} hours before the reminder (0: no reminder)`, { ...at, field: 'wait' })
      step.wait = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), WAIT_MAX) : WAIT[step.ask]
    } else if (use === 'output') {
      // 结果: the files that are the run's results (paths or * patterns in the folder; none: what the run changed so far)
      step.text = str(s.text, 2000)
      if (s.show !== undefined) {
        const show = (Array.isArray(s.show) ? s.show : [s.show]).map(x => str(x, REVIEW_LIMITS.pattern)).filter(Boolean)
        if (show.length > REVIEW_LIMITS.show || show.some(x => x.startsWith('/') || x.split('/').includes('..'))) err(`show: at most ${REVIEW_LIMITS.show} paths (or patterns with *) inside the run's folder`, { ...at, field: 'show' })
        if (show.length) step.show = show.slice(0, REVIEW_LIMITS.show)
      }
    } else {
      step.text = str(s.text, 2000)
      if (!step.text) err('an approval step says what the person decides', { ...at, field: 'text' })
    }
    // the command-line tools it uses beyond the image's (lib/toolbox.js): put in place before it runs
    if (['agent', 'script'].includes(use) && s.cli !== undefined) { const cli = pickCli(s.cli, at); if (cli.length) step.cli = cli }
    if (!['approval', 'person', 'output'].includes(use)) step.onFail = pickOnFail(s.onFail, at)
    if (!['approval', 'person', 'output'].includes(use) && s.human !== undefined) step.human = pickHuman(s.human, at)
    return step
  }
  /** Connection needs: [{ type, level, name? }] (name: two of a type in one step), levels read or write. */
  function pickNeeds(v, at) {
    const list = [], keys = new Set()
    for (const n of v.slice(0, 8)) {
      const type = str(n?.type, 31), level = str(n?.level, 8) || 'read', name = str(n?.name, 31)
      if (!TYPE.test(type)) { err('a connection need names its type (http, …)', { ...at, field: 'connectors' }); continue }
      if (!LEVELS.includes(level)) { err(`${type}: the level is read or write`, { ...at, field: 'connectors' }); continue }
      if (name && !NAME.test(name)) { err(`${type}: a name is a short lowercase word`, { ...at, field: 'connectors' }); continue }
      const need = { type, level, ...(name && { name }) }
      if (keys.has(keyOf(need))) { err(`${keyOf(need)} is needed twice: name one of them`, { ...at, field: 'connectors' }); continue }
      keys.add(keyOf(need))
      list.push(need)
    }
    return list
  }
  /** The skill packs a definition carries: { id, git, ref, path, sha } (a git pack), { id, version } (a bundled one), or one pinned per skill ({ id, skills: { name: { version } } }). */
  function pickPacks(v) {
    const list = []
    for (const p of (Array.isArray(v) ? v : []).slice(0, 20)) {
      const pid = str(p?.id, 40)
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(pid)) { err('a pack is named by its id', { field: 'packs' }); continue }
      const skills = p.skills && typeof p.skills === 'object' && !Array.isArray(p.skills) ? Object.fromEntries(Object.entries(p.skills).slice(0, 40).map(([k, x]) => [str(k, 64), { ...(x?.version && { version: str(x.version, 40) }), ...(x?.sha && { sha: str(x.sha, 40) }) }])) : null
      if (p.git) {
        const sha = str(p.sha, 40)
        if (sha && !/^[0-9a-f]{7,40}$/.test(sha)) { err(`${pid}: the commit is a git sha`, { field: 'packs' }); continue }
        list.push({ id: pid, git: str(p.git, 300), ref: str(p.ref, 100) || 'main', path: str(p.path ?? 'skills', 200), ...(sha && { sha }), ...(skills && { skills }) })
      } else list.push({ id: pid, ...(p.version && { version: str(p.version, 40) }), ...(skills && { skills }) })
    }
    return list
  }
  /** A route's steps (at most 12). */
  function lane(v, i, k) {
    const list = Array.isArray(v) ? v.slice(0, 12) : []
    return list.map((x, j) => generic(x && typeof x === 'object' ? x : {}, { step: i, lane: k, index: j })).filter(Boolean)
  }
  /** A route's condition: an earlier step passed / failed / was skipped, what a step handed back contains a text, the run's verdict. */
  function pickWhen(w, at) {
    const v = w && typeof w === 'object' ? w : {}
    if (v.step !== undefined) {
      if (!WHEN_IS.includes(v.is)) err(`a step condition is ${WHEN_IS.join(', ')}`, at)
      return { step: str(v.step, 40), is: WHEN_IS.includes(v.is) ? v.is : 'passed' }
    }
    if (v.output !== undefined) {
      const has = str(v.has, 200)
      if (!has) err('say what the step\'s result should contain', at)
      return { output: str(v.output, 40), has }
    }
    if (v.verdict !== undefined) { const level = str(v.verdict, 40); if (!/^[a-z_]{2,40}$/.test(level)) err('a verdict is a level such as done or failed', at); return { verdict: level } }
    err('a route needs a condition: { step, is } | { output, has } | { verdict }', at)
    return { step: '', is: 'passed' }
  }
  function pickAgent(v, field, at, required) {
    const a = str(v, 40)
    if (!a) { if (required) err(`the ${field} is an agent of the pool`, { ...at, field }); return '' }
    if (!AGENT.test(a)) { err(`"${a}" is not an agent id`, { ...at, field }); return '' }
    if (agents && !agents.includes(a)) err(`no agent "${a}" in the agent pool`, { ...at, field })
    return a
  }
  /** A model: "<connection>:<model>" (a connection there is) or "dsh:<provider>/<model>". */
  function pickModel(v, at) {
    const m = str(v, 240)
    if (!isModelRef(m)) { err(`"${m.slice(0, 60)}" is not a model: "<connection>:<model>" or "dsh:<provider>/<model>"`, { ...at, field: 'model' }); return '' }
    const ref = parseModelRef(m)
    if (ref.source === 'connection' && connectors && !connectors.includes(ref.connection)) err(`no connector "${ref.connection}" (Connectors page) for the model ${m}`, { ...at, field: 'model' })
    return m
  }
  function pickSkills(v, at) {
    const list = Array.isArray(v) ? [...new Set(v.map(String))] : []
    if (list.length > 10 || list.some(x => !SKILL.test(x))) err('up to 10 skills, as pack/skill', { ...at, field: 'skills' })
    return list.filter(x => SKILL.test(x)).slice(0, 10)
  }
  /**
   * When the step asks for a person (lib/human.js): stuck — it failed where the run would stop; below — its confidence is
   * under the bar (1–100); wait — hours until the person is reminded (0: never; none: the default).
   */
  function pickHuman(v, at) {
    const h = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    const num = x => (x === undefined || x === null || x === '' ? null : Number(x))
    const below = num(h.below), wait = num(h.wait)
    if (below !== null && !(Number.isInteger(below) && below >= 1 && below <= 100)) err('ask the person below a confidence of 1–100', { ...at, field: 'human' })
    if (wait !== null && !(Number.isInteger(wait) && wait >= 0 && wait <= 720)) err('remind the person after 0–720 hours', { ...at, field: 'human' })
    return { stuck: !!h.stuck, ...(below !== null && below >= 1 && below <= 100 && { below }), ...(wait !== null && Number.isInteger(wait) && wait >= 0 && wait <= 720 && { wait }) }
  }
  function pickCli(v, at) {
    const list = Array.isArray(v) ? [...new Set(v.map(x => String(x).trim()).filter(Boolean))] : []
    const bad = list.filter(x => !parseTool(x))
    if (list.length > 20 || bad.length) err(`up to 20 command-line tools, each name, name@version or backend:package@version${bad.length ? ` (not one: ${bad.join(', ').slice(0, 200)})` : ''}`, { ...at, field: 'cli' })
    // (a system package's or an engine's version is a person's to install: named without one)
    const system = list.filter(x => { const t = parseTool(x); return t?.version && (t.engine || t.apt) })
    if (system.length) err(`a system package or an engine is named without a version (a person installs it): ${system.join(', ').slice(0, 200)}`, { ...at, field: 'cli' })
    return list.filter(x => parseTool(x)).slice(0, 20)
  }
  function pickOnFail(v, at) {
    if (v === undefined || v === 'stop') return 'stop'
    if (v === 'continue') return 'continue'
    if (v && typeof v === 'object' && v.goto) return { goto: str(v.goto, 40), max: Math.min(Math.max(Number(v.max) || 1, 1), 10) }
    err('on failure: "stop", "continue" or { goto: <an earlier step>, max }', { ...at, field: 'onFail' })
    return 'stop'
  }
}

/**
 * A definition as the engine runs it: the base's object (its actions, report, success…) with these steps —
 * base stages as they are (an agent step carrying the person's pick), generic ones built here.
 */
export function compose(def, base) {
  const roles = { ...base.roles }
  const pins = pinsOf(def)
  const own = s => {
    if (s.use === 'agent') roles[s.id] = { agent: s.agent, fallback: s.fallback || null, access: s.access, text: s.instructions }
    if (s.use === 'model') roles[s.id] = { kind: 'model', model: s.model || '', text: MODEL_TEXT }
    // a script step's agents, each a role of its own (<step>.<role>): what its s.agent(role, …) asks
    if (s.use === 'flow') for (const [role, a] of Object.entries(s.agents || {})) roles[`${s.id}.${role}`] = { agent: a.agent, fallback: a.fallback || null, access: a.access, text: a.instructions || `The ${role} of the step "${s.title}": do each task it gives you and hand back what it asks.` }
    return genericStage(s, { pins })
  }
  const stages = []
  def.steps.forEach((s, i) => {
    const stage = base.stages.find(x => x.key === s.use)
    if (stage) {
      // (a base step's own tools join those its workflow gives it)
      const st = s.cli?.length ? { ...stage, cli: [...new Set([...(stage.cli || []), ...s.cli])] } : stage
      return stages.push(s.model ? { ...st, pick: { model: s.model, ...(s.human && { human: s.human }) } } : s.agent || s.fallback !== undefined || s.skills || s.human ? { ...st, pick: { agent: s.agent || undefined, fallback: s.fallback, skills: s.skills, ...(s.human && { human: s.human }) } } : st)
    }
    if (s.use === 'parallel') {
      // the block, then its lanes' steps (run by the block, all lanes at once; the walk passes them by)
      stages.push(parallelStage(s))
      s.lanes.forEach((l, k) => l.steps.forEach(x => stages.push({ ...own(x), lane: `${s.id}:${k}`, par: s.id })))
      return
    }
    if (s.use !== 'branch') return stages.push(own(s))
    // a branch, then its routes one after another (the "otherwise" lane last): the last step of a route goes on with
    // the step after the branch (`next`), the otherwise lane runs into it — or, for a route that goes back, a last
    // step of its own that sends the run back (and counts the rounds)
    const join = def.steps[i + 1]?.id || def.steps[i + 1]?.use
    const routes = [...s.routes, { ...s.otherwise, id: 'otherwise' }]
    const lanes = routes.map(r => [...r.steps.map(own), ...(r.back ? [backStage(s, r)] : [])])
    if (s.mode === 'agent') roles[s.id] = { agent: s.agent, fallback: s.fallback || null, access: 'read', text: s.instructions || 'Pick the route this run should take, from what the run found so far.' }
    stages.push(branchStage(s, lanes.map(l => l[0]?.key || join)))
    lanes.forEach((l, k) => l.forEach((x, j) => stages.push({ ...x, lane: `${s.id}:${k}`, ...(j === l.length - 1 && k < lanes.length - 1 && !routes[k].back && { next: join }) })))
  })
  return { ...base, id: def.id, title: def.title, base: def.base, stages, roles, def }
}

/** Every step of a definition, a branch's routes and a parallel block's lanes included. */
export const flatSteps = def => (def?.steps || []).flatMap(s => (s.use === 'branch' ? [s, ...s.routes.flatMap(r => r.steps), ...s.otherwise.steps] : s.use === 'parallel' ? [s, ...s.lanes.flatMap(l => l.steps)] : [s]))

/** Does a route's condition hold for the run as it is now? */
export function holds(when, run) {
  if (!when) return false
  if (when.step) return (run.stages || []).find(x => x.key === when.step)?.status === when.is
  if (when.output) return JSON.stringify(run.outputs?.[when.output] || {}).toLowerCase().includes(String(when.has).toLowerCase())
  if (when.verdict) return run.verdict?.level === when.verdict
  return false
}

/** A branch: picks a route (its condition, or its agent) and jumps to the route's first step; the others are skipped. */
function branchStage(s, firsts) {
  return {
    key: s.id, owner: s.mode === 'agent' ? s.id : 'system', title: s.title, generic: 'branch', tools: [], routes: s.routes.map(r => r.id),
    async run(w) {
      let k = -1, why = ''
      if (s.mode === 'condition') {
        k = s.routes.findIndex(r => holds(r.when, w.run))
      } else {
        const brief = [
          header(w, s.id),
          `## Choose the route: ${s.title}\n${s.instructions || 'Pick the route this run should take, from what the run found so far.'}`,
          `Routes:\n${s.routes.map(r => `- "${r.id}": ${r.label}${r.hint ? ` — ${r.hint}` : ''}`).join('\n')}\n- "otherwise": ${s.otherwise.label} — when none of the routes fits`,
          'Then call stage_result with {"route": "<the id of one route, or otherwise>", "reason": "one or two sentences, citing evidence (#n)"}.',
        ].join('\n\n')
        const { result } = await w.agent(s.id, brief, { title: s.title })
        // stage_result has checked the route: one of the routes or "otherwise" — anything else is no choice at all
        const route = String(result?.route || '')
        if (route !== 'otherwise' && !s.routes.some(r => r.id === route)) return { ok: false, verdict: 'failed', stop: true, note: `${s.id}: the agent picked no route of this branch ("${route.slice(0, 40)}")` }
        k = s.routes.findIndex(r => r.id === route)
        why = String(result?.reason || '').replace(/\s+/g, ' ').slice(0, 300)
      }
      if (k < 0) k = s.routes.length
      const label = k < s.routes.length ? s.routes[k].label : s.otherwise.label
      w.update(r => ({ ...r, outputs: { ...(r.outputs || {}), [s.id]: { route: k < s.routes.length ? s.routes[k].id : 'otherwise', reason: why, ok: true } } }))
      return { ok: true, jump: firsts[k], note: `→ ${label}${why ? `: ${why}` : ''}`.slice(0, 600) }
    },
  }
}

/** How often decisions in a parallel block's lanes may send the block back (a person decides after that). */
export const LANE_BACK_MAX = 5
/**
 * A parallel block: every lane at once (w.lanes runs each lane's steps in turn, as the walk would), then the join — all
 * lanes through. A lane that fails fails the block, and the block's "on failure" decides. A decision asked in a lane that
 * sends the work back is not a failure: the block goes back as a whole — to the step before it that the decision names,
 * or, when it names a step of the block (any lane), to the start of the block, so every lane runs again. Each trip back
 * counts (loops["<block>~decision"]); past LANE_BACK_MAX the run stops for a person.
 */
function parallelStage(s) {
  return {
    key: s.id, owner: 'system', title: s.title, generic: 'parallel', lanes: s.lanes.map(l => l.steps.map(x => x.id)),
    async run(w) {
      const done = await Promise.all(s.lanes.map(l => w.lanes(l.steps.map(x => x.id))))
      const backs = done.map(d => d.back).filter(Boolean)
      if (backs.length) {
        const order = w.workflow.stages.map(x => x.key), own = new Set(s.lanes.flatMap(l => l.steps.map(x => x.id)))
        const first = backs.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0], to = own.has(first) ? s.id : first
        const key = `${s.id}~decision`, n = w.run.loops?.[key] || 0
        if (n >= LANE_BACK_MAX) return { ok: false, verdict: 'failed', stop: true, note: `${s.title}: sent back ${LANE_BACK_MAX} times by decisions in its lanes — a person decides` }
        w.update(r => ({ ...r, loops: { ...(r.loops || {}), [key]: n + 1 } }))
        return { ok: false, goto: to, note: `${s.title}: a decision in a lane sent it back → back to ${to} (${n + 1} of ${LANE_BACK_MAX})` }
      }
      const bad = done.map((d, k) => (d.ok ? null : `${s.lanes[k].label}: ${d.note}`)).filter(Boolean)
      w.update(r => ({ ...r, outputs: { ...(r.outputs || {}), [s.id]: { lanes: Object.fromEntries(s.lanes.map((l, k) => [l.id, done[k].ok])), ok: !bad.length } } }))
      return bad.length ? failed(w, s, bad.join('; ')) : { ok: true, note: `${s.lanes.length} lanes through` }
    },
  }
}
/** A route that goes back: to an earlier step, counting the rounds; past its count the run stops for a person. */
function backStage(branch, route) {
  const key = `${branch.id}~${route.id}`
  return {
    key, owner: 'system', title: `back to ${route.back.to}`, generic: 'back', back: route.back.to,
    async run(w) {
      const n = w.run.loops?.[key] || 0
      if (n >= route.back.max) return { ok: false, verdict: 'failed', stop: true, note: `${route.label}: still so after ${route.back.max} round(s) — a person decides` }
      w.update(r => ({ ...r, loops: { ...(r.loops || {}), [key]: n + 1 } }))
      return { ok: true, back: route.back.to, note: `${route.label} → back to ${route.back.to} (${n + 1} of ${route.back.max})` }
    },
  }
}

/**
 * A generic step's failure: stop the run, carry on, or go back (at most `max` times). Carrying on keeps the step failed
 * (a route that waits for its failure takes it); only the run goes on.
 */
const failed = (w, s, note) => {
  if (s.onFail === 'continue') return { ok: false, carryOn: true, note: `failed, carried on: ${note}`.slice(0, 600) }
  if (s.onFail?.goto) {
    const n = w.run.loops?.[s.id] || 0
    if (n < s.onFail.max) {
      w.update(r => ({ ...r, loops: { ...(r.loops || {}), [s.id]: n + 1 } }))
      return { ok: false, goto: s.onFail.goto, note: `${note} — back to ${s.onFail.goto} (${n + 1} of ${s.onFail.max})`.slice(0, 600) }
    }
    return { ok: false, verdict: 'failed', stop: true, note: `${note} — still failing after ${s.onFail.max} round(s)`.slice(0, 600) }
  }
  return { ok: false, verdict: 'failed', stop: true, note: String(note).slice(0, 600) }
}

/** A model step's system prompt: one step of a run, its answer the step's result. */
const MODEL_TEXT = 'You do one step of a workflow run. The question gives the request, what the earlier steps handed back, and your task. Do the task with what is there — nothing is to be looked up — and answer with its result alone, in Markdown, ready to use: no preamble, no questions back. Never invent facts the request and the earlier steps do not give.'

export function genericStage(s, { pins } = {}) {
  const base = { key: s.id, owner: ['agent', 'model'].includes(s.use) ? s.id : 'system', title: s.title, generic: s.use, ...(s.human && { human: s.human }), ...(s.cli?.length && { cli: s.cli }), ...(s.use === 'agent' && { tools: s.tools, pick: { skills: s.skills }, ...(s.session && { session: s.session }), ...(s.browser && { browser: s.browser }), ...(s.login && { login: true }) }),
    // (a script step's agents: the tools every agent has, nothing more)
    ...(s.use === 'flow' && { tools: [] }),
    // (a failure before it ran — a tool it needs not to be had: engine runStep — goes the way its "on failure" says)
    fail: (w, note) => failed(w, s, note) }
  if (s.use === 'model') {
    return {
      ...base,
      async run(w) {
        const user = [subjectText(w), outputsText(w), `## Your task: ${s.title}\n${s.instructions}`].filter(Boolean).join('\n\n')
        let text
        try {
          ({ text } = await w.model(s.id, { user, title: s.title }))
        } catch (err) {
          if (w.signal?.aborted) throw err
          return failed(w, s, err.message)
        }
        w.update(r => ({ ...r, outputs: { ...(r.outputs || {}), [s.id]: { summary: text.slice(0, 20000), ok: true } } }))
        return { ok: true, note: text.replace(/\s+/g, ' ').slice(0, 300) }
      },
    }
  }
  if (s.use === 'agent') {
    return {
      ...base,
      async run(w) {
        const brief = [
          header(w, s.id),
          `## Your task: ${s.title}\n${s.instructions}`,
          s.tools?.length ? `Tools for this step: ${[...ALWAYS, ...s.tools].join(', ')}.` : `Tools for this step: ${ALWAYS.join(', ')}.`,
          // its command-line tools, put in place before it started (engine runStep); another one: tools_ensure
          s.cli?.length ? `Command-line tools put in place for this step: ${s.cli.join(', ')}. Another one you need: tools_ensure if this step may change files (never sudo or an installer of your own).` : 'A command-line tool you need that is not here: tools_ensure if this step may change files (never sudo or an installer of your own).',
          'Then call stage_result with {"ok": true | false (false: the task could not be done or found a problem that should stop the run), "summary": "the outcome in Markdown, citing evidence (#n)", "findings": ["…"], "confidence": 0–100 (how sure you are the result is right — honest: a low one asks the person to look)}.',
        ].join('\n\n')
        const { result, report } = await w.agent(s.id, brief, { title: s.title, ...(pins && Object.keys(pins).length && { pins }) })
        w.update(r => ({ ...r, outputs: { ...(r.outputs || {}), [s.id]: { summary: String(result?.summary || report || '').slice(0, 20000), findings: Array.isArray(result?.findings) ? result.findings.slice(0, 30).map(String) : [], ok: result?.ok !== false, ...(typeof result?.confidence === 'number' && { confidence: Math.max(0, Math.min(100, Math.round(result.confidence))) }) } } }))
        const note = String(result?.summary || '').replace(/\s+/g, ' ').slice(0, 300)
        // stage_result has checked ok is a boolean: no result, or anything else, is not a success
        return result?.ok === true ? { ok: true, note } : failed(w, s, note || (result?.ok === false ? 'the agent reported a failure' : 'the agent handed back no result'))
      },
    }
  }
  if (s.use === 'script') {
    return {
      ...base,
      async run(w) {
        const vars = {}
        // each connection it needs, as this machine binds it (one named by id: that one)
        for (const n of needsOf(s)) {
          if (!w.services.connectors?.()) return failed(w, s, `the connectors plugin is not loaded: ${n.key} cannot be reached`)
          const id = n.id || (await w.bindConn?.(n))?.connection
          if (!id) return failed(w, s, `no connection here for ${n.key} (${n.level}): bind one under Workflows → this workflow → what it needs`)
          Object.assign(vars, await w.services.connectors().env(id, { write: n.level === 'write', by: `${w.run.id}:${s.id}` }))
        }
        const cwd = s.cwd === 'workspace' ? w.workspace : dirOf(w.run)
        // an installed script: its entry, by its kind, with the step's arguments; SCRIPT_DIR is its folder
        const installed = s.script ? w.script(s.script) : null
        if (s.script && !installed) return failed(w, s, `the script ${s.script} is not installed here`)
        const cmd = installed ? [runner(installed.entry), quote(installed.entry), ...(s.args || []).map(quote)].filter(Boolean).join(' ') : s.run
        if (installed) vars.SCRIPT_DIR = installed.dir
        const shell = bash()
        if (!shell) return failed(w, s, 'a script step runs in bash, and this Windows machine has none: install Git for Windows (git-scm.com), or set RUYIX_BASH to a bash.exe')
        // Git Bash's login profile goes to $HOME unless told to stay where it was started
        if (WIN) vars.CHERE_INVOKING = '1'
        // (its tools first on the PATH again after the login shell's profile: lib/toolbox.js)
        const r = await w.exec(shell, ['-lc', `${w.tools?.shell?.() || ''}${cmd}`], { cwd, env: vars, timeout: s.timeoutMinutes * 60000 })
        // what the connectors gave never reaches the ledger — nor the usual disguises of it (see secretsOf)
        const secret = secretsOf(vars)
        const clean = text => secret.reduce((t, v) => t.split(v).join('«secret»'), String(text || ''))
        const shown = { ...r, stdout: clean(r.stdout), stderr: clean(r.stderr) }
        w.command(`${s.title}: ${(s.script || s.run).split('\n')[0].slice(0, 120)}`, shown, { cwd, connectors: Array.isArray(s.connectors) ? needsOf(s).map(n => `${n.key}:${n.level}`) : s.connectors, ...(s.script && { script: s.script, args: s.args }) })
        w.update(x => ({ ...x, outputs: { ...(x.outputs || {}), [s.id]: { code: r.code, output: tail(both(shown), 4000), ok: r.code === 0 } } }))
        return r.code === 0 ? { ok: true, note: `exit 0` } : failed(w, s, `exit ${r.code}: ${tail(both(shown), 300).replace(/\s+/g, ' ')}`)
      },
    }
  }
  if (s.use === 'person') return { ...base, person: s.ask, run: w => personStep(w, s) }
  if (s.use === 'output') return { ...base, run: w => outputStep(w, s) }
  if (s.use === 'flow') return flowStage(s, base, { failed, settle, deadline, quote, runner, bash, win: WIN, always: ALWAYS })
  return {
    ...base,
    async run(w) {
      // the run waits here (a blocking decision) until the person continues or stops it
      w.approval({
        action: 'decision', title: s.title,
        payload: { why: s.text, options: [{ label: 'Continue', does: 'the run goes on with its next step', action: 'accept' }, { label: 'Stop the run', does: 'nothing after this step runs', action: 'stop' }], recommended: null, blocking: true, stage: s.id, by: 'workflow' },
      })
      return { ok: true, note: s.text.slice(0, 300) }
    },
  }
}

/**
 * Everything of what the connectors gave a script that must not reach the ledger: the values themselves; the contents of a
 * file a variable names (a kubeconfig, a key) and the secret-looking values in it (token:, …-data:, key:), since a script
 * may print the file or a line of it; base64 and URL-encoded forms; and a user:password pair as it goes into a Basic
 * authorization header (the pair, its base64, the header). Longest first, so a form that holds another is cut whole.
 */
export function secretsOf(vars) {
  const found = new Set()
  const add = v => { if (typeof v === 'string' && v.trim().length >= 6) found.add(v.trim()) }
  const forms = v => { add(v); add(Buffer.from(v).toString('base64')); const u = encodeURIComponent(v); if (u !== v) add(u) }
  const values = Object.entries(vars).filter(([, v]) => typeof v === 'string' && v)
  for (const [, v] of values) {
    if (v.length >= 6) forms(v) // (a short value is no secret worth cutting out of every text)
    try { // a variable that is the path of a file: its contents
      const file = statSync(v)
      if (file.isFile() && file.size <= 1 << 20) {
        const text = readFileSync(v, 'utf8')
        forms(text.trim())
        for (const line of text.split('\n')) {
          const m = /^\s*(?:-\s*)?[\w.-]*(?:token|key|secret|password|data|certificate)[\w.-]*\s*:\s*(\S{12,})\s*$/i.exec(line)
          if (m) forms(m[1].replace(/^["']|["']$/g, ''))
        }
      }
    } catch { /* not a file */ }
  }
  // pairs: PREFIX_USER[NAME] with PREFIX_PASSWORD / PREFIX_PASS
  for (const [name, user] of values) {
    const m = /^(.*)_USER(?:NAME)?$/.exec(name)
    const password = m && (vars[`${m[1]}_PASSWORD`] ?? vars[`${m[1]}_PASS`])
    if (typeof password !== 'string' || !password) continue
    const b64 = Buffer.from(`${user}:${password}`).toString('base64')
    add(`${user}:${password}`); add(b64); add(`Basic ${b64}`)
  }
  return [...found].sort((a, b) => b.length - a.length)
}

const quote = v => `'${String(v).replace(/'/g, `'\\''`)}'`
const WIN = process.platform === 'win32'
const runner = entry => (/\.py$/.test(entry) ? (WIN ? 'python' : 'python3') : /\.m?js$/.test(entry) ? 'node' : /\.sh$/.test(entry) ? 'bash' : '')
/**
 * The bash a script step runs in: `bash`; on Windows Git for Windows' (RUYIX_BASH, else where its installer puts it) —
 * not WSL's bash.exe, which runs in another file system — or null when there is none.
 */
export function bash(env = process.env, win = WIN) {
  if (!win) return 'bash'
  const found = [env.RUYIX_BASH, ...[env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean).map(d => join(d, 'Git', 'bin', 'bash.exe')), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')]
  return found.find(p => p && existsSync(p)) || null
}

/**
 * Installed scripts (fixed checks, copied in by hand): <home>/scripts/<name>/<version>/ with a
 * manifest.json { name, version, entry, description? } — the entry a file in that folder (.sh / .py / .js, or an
 * executable). → list() ['name@version'], get('name@version') { ref, dir, entry (its path), description }.
 */
export function createScripts(home) {
  const root = join(home, 'scripts')
  const get = ref => {
    const m = SCRIPT.exec(String(ref || ''))
    if (!m) return null
    const dir = join(root, m[1], m[2])
    try {
      const man = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
      const entry = join(dir, String(man.entry || ''))
      if (!man.entry || /(^|[\\/])\.\.([\\/]|$)/.test(String(man.entry)) || !existsSync(entry)) return null
      return { ref: `${m[1]}@${m[2]}`, dir, entry, description: String(man.description || '').slice(0, 300) }
    } catch { return null }
  }
  const list = () => (existsSync(root) ? readdirSync(root).flatMap(n => { try { return readdirSync(join(root, n)).map(v => `${n}@${v}`) } catch { return [] } }).filter(r => get(r)) : [])
  return { root, get, list }
}

/** The person's workflows on disk: drafts and enabled ones, each file one definition. */
export function createStore(home) {
  const dir = join(home, 'workflows')
  const file = id => join(dir, `${id}.json`)
  const read = f => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
  return {
    list: () => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => read(join(dir, f))).filter(d => d?.kind === KIND && SLUG.test(d.id || '')) : []),
    get: id => (SLUG.test(String(id || '')) ? read(file(id)) : null),
    put(def) {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file(def.id)}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(def, null, 2)}\n`)
      renameSync(tmp, file(def.id))
      return def
    },
    remove: id => { if (SLUG.test(String(id || ''))) rmSync(file(id), { force: true }) },
    /** A copy of a definition about to be replaced (workflows/.history/<id>-<time>.json): it can be brought back. */
    keep(def) {
      mkdirSync(join(dir, '.history'), { recursive: true })
      writeFileSync(join(dir, '.history', `${def.id}-${Date.now()}-${randomUUID()}.json`), `${JSON.stringify(def, null, 2)}\n`)
    },
  }
}

/**
 * A workflow's steps as the panel and the assistant show them (built-in or a person's) — `back`: where the step sends
 * the work when it does not pass (the built-in workflow's `back`, a step of one's own its "on failure, go back to").
 */
export const outline = wf => {
  const own = new Map([...flatSteps(wf.def).filter(s => s.onFail?.goto).map(s => [s.id, s.onFail.goto]), ...flatSteps(wf.def).filter(s => s.use === 'person' && s.back).map(s => [s.id, s.back])])
  return wf.stages.map(s => {
    const back = wf.back?.[s.key] || own.get(s.key) || s.back // a route's own way back (its back stage) too
    return { key: s.key, title: s.title || null, owner: s.owner, generic: s.generic || null, ...(s.person && { person: s.person }), ...(s.sends && { sends: true }), ...(s.web && { web: true }), optional: !!s.optional, final: !!s.final, tools: s.tools || null, ...(s.lane && { lane: s.lane }), ...(s.next && { next: s.next }), ...(s.par && { par: s.par }), ...(back && { back }) }
  })
}

