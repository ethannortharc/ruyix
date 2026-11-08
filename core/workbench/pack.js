// A domain pack: everything the workbench must know about one domain (a publishing flow, a video-editing flow…). The core
// never names a domain; it reads these fields. A pack is a dsh plugin of its own and joins through the workbench's
// service: ctx.inject(['ruyixWorkbench'], inner => inner.effect(() => inner.ruyixWorkbench.registerPack(pack), '…')).
//
//   id          the pack's key: its workflows are <id>.<workflow>, its settings live in settings.packs.<id>, its API ops
//               are <id>.<op>. 2–31 lowercase letters, digits and dashes, starting with a letter.
//   name        { en, zh } — shown on the Connectors page, in setup and in the Skills page.
//   workflows   { <id>: workflow } — built-in workflows, each { title, description?, noun?, input?, insertFrom?, success?,
//               verdicts?, reviseFrom?, preferenceOptions?, validateInput?(subject), stages[], roles{}, actions{}, report? }:
//                 stages    [{ key, owner ('system' or a role), title?, optional?, final?, tools?, validate?(result, c), run(w) }]
//                           — run(w) returns { ok, note, goto?, stop?, … }; w is the step's context (README)
//                 roles     { <owner>: { agent, fallback?, access: 'read'|'write', text } } — the role's default agent, a person
//                           can pick another in the settings
//                 input     the new-run form: [{ name, type: text|textarea|select|multiselect|checkbox|files, label?, options?,
//                           required?, default? }]; the values arrive in run.subject.fields
//                 insertFrom  the base step after which a person's own steps may go (default: the first step)
//                 reviseFrom  the creation step a task's "ask for changes" resumes (before checking/approval/export)
//                 preferenceOptions  compatible Studio choices: detail, tone, evidence, pacing, captions (empty disables choices)
//                 success   the verdict level that counts as success (default 'done'); verdicts: { level: wording }
//                 validateInput(subject) → '' (fine) or a message / list of messages; default: a title or a text is needed
//   agents      [{ id, name, runtime, model, effort, skills, access, notes }] — default agents the roles name; added to Agent
//               Hub's pool once each (a person's edits and deletions stay)
//   tools       [{ name, description, parameters (JSON Schema), run(c, args) }] — agent tools; the name should start with
//               the pack's id (notes_check); record evidence through c.record, keep to the read/write boundary yourself
//   actions     { <action>: async c => result } — what runs when a person approves a card of that action (c: README); added
//               to every workflow of the pack
//   settings    the pack's defaults, kept in settings.packs.<id>
//   needs(s)    the connections the pack needs, for the Connectors page and the setup check, s = the pack's settings:
//               [{ need, type, connection, optional?, label: { en, zh } }]
//   setup(s)    async → extra steps of the home page's setup: [{ id, order?, required, ready, title, detail, panel? }]
//   text        prompt and wording pieces: header(w, step) → text added to every agent brief of the pack's workflows;
//               stageNames { <key>: { en, zh } } for the Skills page
//   skills      { packs: [{ id, dir, version } | { id, git, ref, path }] — skill packs registered with Agent Hub;
//               uses: [{ ref, stages, what: { en, zh }, member? }] — which steps use which skill }
//   account     { studio, collection, field, settings(account, packSettings) → packSettings } — the account a run writes as
//               (a studio's record: a persona, docs/design/studio.md): the form's `field` (type ref) names one; when the run
//               starts it is read from the studio, kept with the run (run.account) and laid over the pack's settings for
//               that run (its steps' packSettings) — changing the account later leaves the run as it was
//   ops(ctx)    the pack's own API: ({ store, engine, settings(), workbench, failWith }) → { <op>: fn(args) }, served as <id>.<op>
//   beforeFileMutation({ run, kind: 'edit'|'rewind'|'restart', path?, by, store }) — synchronous guard before an edit or restart;
//               throw to refuse, or return a synchronous release function held until the operation finishes (also on error).
//               `path` is the edit's original input; normalize it before comparing paths (as lib/versions.js does).
import { isModelRef } from './lib/models.js'
import { RESERVED } from './lib/workflows.js'

const ID = /^[a-z][a-z0-9-]{1,30}$/
const KEY = /^[a-z][a-z0-9_-]{0,38}$/
const NAME = /^[a-z][a-z0-9_]{1,40}$/
const ACCESS = ['read', 'write']

const bad = (id, message) => { throw new Error(`pack ${id || '?'}: ${message}`) }
const words = (id, v) => {
  const x = typeof v === 'string' ? { en: v, zh: v } : v
  if (!x || typeof x.en !== 'string' || typeof x.zh !== 'string') bad(id, 'name is { en, zh }')
  return { en: x.en, zh: x.zh }
}

function checkWorkflow(pack, key, wf) {
  const at = `${pack}.${key}`
  if (!KEY.test(key)) bad(pack, `the workflow id "${key}" is lowercase letters, digits, - and _`)
  if (!wf || typeof wf !== 'object') bad(pack, `${at}: a workflow is an object`)
  if (typeof wf.title !== 'string' || !wf.title.trim()) bad(pack, `${at}: title is required`)
  if (!Array.isArray(wf.stages) || !wf.stages.length) bad(pack, `${at}: stages is a list of steps`)
  const keys = new Set()
  for (const s of wf.stages) {
    if (!s || !KEY.test(s.key || '')) bad(pack, `${at}: a step key is lowercase letters, digits, - and _ (got "${s?.key}")`)
    if (RESERVED.has(s.key)) bad(pack, `${at}: "${s.key}" is the engine's own name, not a step`)
    if (keys.has(s.key)) bad(pack, `${at}: the step ${s.key} appears twice`)
    keys.add(s.key)
    if (typeof s.run !== 'function') bad(pack, `${at}.${s.key}: run(w) is required`)
    if (!s.owner) bad(pack, `${at}.${s.key}: owner is 'system' or a role`)
    if (s.owner !== 'system' && !wf.roles?.[s.owner]) bad(pack, `${at}.${s.key}: the role "${s.owner}" is not in roles`)
  }
  for (const [role, def] of Object.entries(wf.roles || {})) {
    // a model role: one call to a model, named "<connection>:<model>" or "dsh:<provider>/<model>" (lib/models.js)
    if (def?.kind === 'model') {
      if (def.model && !isModelRef(def.model)) bad(pack, `${at}: the role ${role}: "${def.model}" is not a model ("<connection>:<model>" or "dsh:<provider>/<model>")`)
      continue
    }
    if (def?.kind !== undefined) bad(pack, `${at}: the role ${role}: kind is "model" or none (an agent)`)
    if (!def?.agent || typeof def.agent !== 'string') bad(pack, `${at}: the role ${role} names a default agent`)
    if (def.access !== undefined && !ACCESS.includes(def.access)) bad(pack, `${at}: the role ${role}: access is read or write`)
  }
  if (wf.insertFrom !== undefined && !keys.has(wf.insertFrom)) bad(pack, `${at}: insertFrom "${wf.insertFrom}" is not one of its steps`)
  if (wf.reviseFrom !== undefined && !keys.has(wf.reviseFrom)) bad(pack, `${at}: reviseFrom "${wf.reviseFrom}" is not one of its steps`)
  if (wf.preferenceOptions !== undefined && (!Array.isArray(wf.preferenceOptions) || new Set(wf.preferenceOptions).size !== wf.preferenceOptions.length || wf.preferenceOptions.some(k => !['detail', 'tone', 'evidence', 'pacing', 'captions'].includes(k)))) bad(pack, `${at}: preferenceOptions is a unique list of detail, tone, evidence, pacing, captions`)
  if (wf.validateInput !== undefined && typeof wf.validateInput !== 'function') bad(pack, `${at}: validateInput is a function`)
  if (wf.success !== undefined && typeof wf.success !== 'string') bad(pack, `${at}: success is a verdict level`)
}

export function definePack(p) {
  const id = p?.id
  if (!ID.test(id || '')) bad(id, 'id is 2–31 lowercase letters, digits and dashes, starting with a letter')
  const name = words(id, p.name)
  const workflows = p.workflows || {}
  for (const [key, wf] of Object.entries(workflows)) checkWorkflow(id, key, wf)
  const tools = p.tools || []
  const seen = new Set()
  for (const t of tools) {
    if (!NAME.test(t?.name || '')) bad(id, `a tool name is lowercase letters, digits and _ (got "${t?.name}")`)
    if (seen.has(t.name)) bad(id, `the tool ${t.name} appears twice`)
    seen.add(t.name)
    if (!t.description || !t.parameters || typeof t.run !== 'function') bad(id, `the tool ${t.name} needs description, parameters and run(c, args)`)
  }
  const actions = p.actions || {}
  for (const [k, fn] of Object.entries(actions)) if (typeof fn !== 'function') bad(id, `the action ${k} is a function`)
  for (const a of p.agents || []) if (!a?.id || !a.runtime) bad(id, 'an agent needs an id and a runtime')
  for (const k of ['needs', 'setup', 'ops', 'beforeFileMutation']) if (p[k] != null && typeof p[k] !== 'function') bad(id, `${k} is a function`)
  if (p.beforeFileMutation?.constructor?.name === 'AsyncFunction') bad(id, 'beforeFileMutation is synchronous')
  if (p.account != null && !(['studio', 'collection', 'field'].every(k => typeof p.account[k] === 'string' && p.account[k]) && typeof p.account.settings === 'function')) bad(id, 'account is { studio, collection, field, settings(account, packSettings) }')
  return {
    needs: () => [], setup: null, ops: null, beforeFileMutation: null,
    ...p,
    id, name, workflows, tools, actions, agents: p.agents || [], settings: p.settings || {},
    text: { ...p.text },
    skills: { packs: [], uses: [], ...p.skills },
  }
}
