// What a workflow needs, and how this machine meets it. A workflow names, step by step, the agent each agent step uses (and
// a fallback), the skills it gives them (each skill pack pinned: its source and commit, or a bundled pack's version), the
// connections a script step works with (by type and level — never a connection or a credential), the models its model
// steps call, and the installed scripts it runs (a script step's agents, by role, and its scripts too). This machine binds each connection need to one of its connections (a
// default per type, a workflow's own override, else the only one of the type) and installs what it can install itself
// (a pinned skill pack). The definition stays portable: on another machine what is missing is installed, or said.
// Readiness is worked out before a run starts; a run that is not ready does not start, and says what is missing.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { scriptRefs } from './flow/names.js'
import { parseModelRef } from './models.js'

export const LEVELS = ['read', 'write']
export const TYPE = /^[a-z][a-z0-9-]{1,30}$/
export const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/
/** What stops a run here (hard); what installs itself (fetch); what gives way and still runs (soft). */
export const HARD = ['missing', 'unbound']
export const SOFT = ['noFallback', 'warn']

/**
 * A step's connector needs → [{ key, type?, id?, name?, level }]: the definition's list ({ type, level, name? }: bound on
 * each machine), or the older map { connectionId: level } (that connection itself).
 */
export function needsOf(s) {
  const c = s?.connectors
  if (Array.isArray(c)) return c.map(n => ({ ...n, key: keyOf(n) }))
  return Object.entries(c && typeof c === 'object' ? c : {}).map(([id, level]) => ({ id, level, key: `id:${id}` }))
}
/** A need's binding key: its type (and name, when a step needs two of a type); a connection named by id: `id:<id>`. */
export const keyOf = n => (n.id ? `id:${n.id}` : n.name ? `${n.type}:${n.name}` : n.type)

/** This machine's bindings: a connection per need key — a default for every workflow, or one workflow's own. */
export function createBindings(file) {
  let data = { types: {}, workflows: {} }
  try { data = { types: {}, workflows: {}, ...JSON.parse(readFileSync(file, 'utf8')) } } catch { /* none yet */ }
  const save = () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2)); renameSync(`${file}.tmp`, file) }
  return {
    get: () => structuredClone(data),
    /** key → connection (null: unbound); `workflow`: that workflow's own (else the default). */
    set({ key, connection, workflow }) {
      const at = workflow ? (data.workflows[workflow] ||= {}) : data.types
      if (connection) at[key] = String(connection)
      else delete at[key]
      if (workflow && !Object.keys(data.workflows[workflow]).length) delete data.workflows[workflow]
      save()
      return structuredClone(data)
    },
    /**
     * The connection a need uses here: its own (one named by id), the workflow's binding, the default for its key, else
     * the only connection of its type. → { connection, how } (connection null: unbound; how: own | workflow | default |
     * only | choose (several of the type, none picked) | none (none of the type)).
     */
    resolve(need, workflow, connections) {
      const exists = id => connections.some(c => c.id === id)
      if (need.id) return { connection: exists(need.id) ? need.id : null, how: 'own' }
      const own = data.workflows[workflow]?.[need.key || keyOf(need)]
      if (own && exists(own)) return { connection: own, how: 'workflow' }
      const def = data.types[need.key || keyOf(need)]
      if (def && exists(def)) return { connection: def, how: 'default' }
      const ofType = connections.filter(c => c.type === need.type)
      return ofType.length === 1 ? { connection: ofType[0].id, how: 'only' } : { connection: null, how: ofType.length ? 'choose' : 'none' }
    },
  }
}

/** Every step of a definition, a branch's routes and a parallel block's lanes included. */
export const allSteps = def => (def?.steps || []).flatMap(s => (s.use === 'branch' ? [s, ...(s.routes || []).flatMap(r => r.steps || []), ...(s.otherwise?.steps || [])] : s.use === 'parallel' ? [s, ...(s.lanes || []).flatMap(l => l.steps || [])] : [s]))

/**
 * What a definition needs here, step by step, and how each stands. ctx: { agents: [id], skills: async (refs, pins) →
 * [{ ref, status: ok | fetch | missing, error? }], connections: [{ id, type, name }], bindings, scripts: [name@version],
 * base: { [step]: { agent, fallback } | { kind: 'model', model } } (a base step's own agent or model: its role's default),
 * models: the workbench's default model, extra: { [step]: [items] } (needs the workflow carries besides its steps'),
 * tools: async (list) → [{ ref, status: ok | fetch | missing, how? }] (lib/toolbox.js check), used: { stepId: [tool] }
 * (what its runs' agents asked for beyond the step's list: suggested) }.
 * → { steps: [{ id, title, use, items: [{ kind: agent | skill | connector | model | script | tool, ref, status, … }] }],
 *     missing (hard: the run does not start), installable (fetch), soft, ready }
 */
export async function readiness(def, ctx) {
  const pins = pinsOf(def)
  const steps = []
  for (const s of allSteps(def)) {
    const items = []
    // its agent (a base step's: its own, or the person's pick) and the fallback: the agent must be in the pool; a
    // fallback that is not is only a warning (the step runs without one)
    const base = ctx.base?.[s.use] || {}
    const want = base.kind === 'model' ? '' : s.agent || base.agent || ''
    const fallback = s.fallback !== undefined ? s.fallback : base.fallback || ''
    if (want && (s.use === 'agent' || (s.use === 'branch' && s.mode === 'agent') || base.agent)) {
      items.push({ kind: 'agent', ref: want, status: ctx.agents.includes(want) ? 'ok' : 'missing' })
      if (fallback) items.push({ kind: 'agent', ref: fallback, fallback: true, status: ctx.agents.includes(fallback) ? 'ok' : 'noFallback' })
    }
    // its skills, at the pins the definition carries (fetch: the pack's source is known, it is installed before the run)
    if (s.skills?.length) for (const r of await ctx.skills(s.skills, pins)) items.push({ kind: 'skill', ref: r.ref, pin: pinText(pins[String(r.ref).split('/')[0]], r.ref), status: r.status, ...(r.error && { error: r.error }) })
    // the model it calls: a connection there is (dsh's models are dsh's to have)
    if (s.use === 'model' || base.kind === 'model') items.push(modelItem(s.model || (s.use === 'model' ? ctx.model : base.model) || '', ctx.connections))
    // its connections, bound here
    for (const n of needsOf(s)) {
      const b = ctx.bindings.resolve(n, def.id, ctx.connections)
      items.push({ kind: 'connector', ref: n.key, type: n.type || ctx.connections.find(c => c.id === n.id)?.type || '', name: n.name || '', level: n.level, connection: b.connection, how: b.how,
        status: b.connection ? 'ok' : n.id ? 'missing' : 'unbound' })
    }
    if (s.script) items.push({ kind: 'script', ref: s.script, status: ctx.scripts.includes(s.script) ? 'ok' : 'missing' })
    // a script step (lib/flow): the agent of each role its script asks (as an agent step's), the installed scripts it runs
    if (s.use === 'flow') {
      const seen = new Set()
      for (const [role, a] of Object.entries(s.agents || {})) {
        if (!a?.agent) continue
        if (!seen.has(a.agent)) { seen.add(a.agent); items.push({ kind: 'agent', ref: a.agent, role, status: ctx.agents.includes(a.agent) ? 'ok' : 'missing' }) }
        if (a.fallback && !seen.has(`${a.fallback}~`)) { seen.add(`${a.fallback}~`); items.push({ kind: 'agent', ref: a.fallback, role, fallback: true, status: ctx.agents.includes(a.fallback) ? 'ok' : 'noFallback' }) }
      }
      for (const ref of scriptRefs(s.source)) if (!items.some(i => i.kind === 'script' && i.ref === ref)) items.push({ kind: 'script', ref, status: ctx.scripts.includes(ref) ? 'ok' : 'missing' })
    }
    // its command-line tools: here, installed on the first run (fetch), or only a person can install them (missing, how);
    // one its runs' agents had to ask for is suggested for its list
    if (s.cli?.length && ctx.tools) for (const r of await ctx.tools(s.cli)) items.push({ kind: 'tool', ref: r.ref, status: r.status, ...(r.how && { how: r.how }), ...(r.error && { error: r.error }) })
    // (its own entry only: a step may be called constructor)
    const used = ctx.used && Object.hasOwn(ctx.used, s.id || s.use) ? ctx.used[s.id || s.use] : []
    for (const ref of (Array.isArray(used) ? used : []).filter(x => !(s.cli || []).includes(x))) items.push({ kind: 'tool', ref, status: 'suggested' })
    for (const x of ctx.extra?.[s.id || s.use] || []) items.push(x)
    if (items.length) steps.push({ id: s.id || s.use, title: s.title || '', use: s.use, items })
  }
  for (const [id, xs] of Object.entries(ctx.extra || {})) if (xs.length && !steps.some(x => x.id === id)) steps.push({ id, title: '', use: id, items: xs })
  const all = steps.flatMap(s => s.items), count = (...st) => all.filter(i => st.includes(i.status)).length
  return { steps, missing: count(...HARD), installable: count('fetch'), soft: count(...SOFT), ready: !count(...HARD, 'fetch') }
}
/** A model step's model as a need: a connection's model needs that connection here; none chosen is missing. */
function modelItem(model, connections) {
  if (!model) return { kind: 'model', ref: '', status: 'missing' }
  let ref
  try { ref = parseModelRef(model) } catch { return { kind: 'model', ref: model, status: 'missing' } }
  if (ref.source !== 'connection') return { kind: 'model', ref: model, status: 'ok' }
  return { kind: 'model', ref: model, connection: ref.connection, status: connections.some(c => c.id === ref.connection) ? 'ok' : 'missing' }
}
const pinText = (pin, ref) => (pin?.skills?.[String(ref).split('/')[1]]?.version || pin?.sha || pin?.version || '')

/** What is missing here, in words: "agent x, script y@1, …" (the first few). */
export const missingText = r => {
  const hard = r.steps.flatMap(s => s.items.filter(i => HARD.includes(i.status) || i.status === 'fetch').map(i => `${i.kind} ${i.ref || '(none chosen)'}${i.kind === 'connector' && i.level ? ` (${i.level})` : ''} at ${s.id}`))
  return hard.slice(0, 6).join('; ') + (hard.length > 6 ? `; and ${hard.length - 6} more` : '')
}

/** A definition's packs as pins: pack → { sha, git, ref, path } | { version } | { skills: { name: { version } } }. */
export const pinsOf = def => Object.fromEntries((def?.packs || []).map(p => [p.id, p]))
/** The packs a definition's steps use (pack/skill → pack): what its `packs` pin. */
export const packIdsOf = def => [...new Set(allSteps(def).flatMap(s => s.skills || []).map(r => (String(r).includes('/') ? String(r).split('/')[0] : null)).filter(Boolean))]
/** The skills a definition's steps name (pack/skill or a bare name): what a pack that pins per skill pins. */
export const skillRefsOf = def => [...new Set(allSteps(def).flatMap(s => s.skills || []).map(String))]
/** The file a machine keeps its bindings in. */
export const bindingsFile = home => join(home, 'bindings.json')
