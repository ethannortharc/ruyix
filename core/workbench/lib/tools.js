// The tools agents get inside a run — one definition, two exits: dsh agent tools and the MCP server.
// The core has eight; a domain pack adds its own (pack.tools: { name, description, parameters, run(c, args) }), which
// write their own evidence through c.record. The context `c` of a call: run, store, workflow, stage, def (the step as
// its workflow defines it), actor, signal, services, pack (the pack that owns the tool, else the workflow's),
// packSettings, settings, record(entry), update(change), approval(spec), tools (command-line tools: lib/toolbox.js).
import { HELP_ROUNDS } from './human.js'
import { checkReviewResult } from './review.js'
import { dirOf } from './subject.js'
import { registryName } from './toolbox.js'

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const str = description => ({ type: 'string', description })
export const tail = (text, n = 4000) => (text.length > n ? `…(${text.length - n} earlier chars in the artifact)\n${text.slice(-n)}` : text)
export const both = r => r.stdout + (r.stderr?.trim() ? `\n--- stderr ---\n${r.stderr}` : '')
const FILE_MAX = 25 << 20
/** The largest request body the MCP endpoint takes: file_save's largest file as base64 (4/3), plus the JSON around it. */
export const BODY_MAX = Math.ceil(FILE_MAX * 4 / 3) + (1 << 20)

/** The tools every step's agent has, whatever its step lists: its context, the ledger, a claim, a decision, a call for help, a file, a command-line tool, its result. */
const CLAIM_TYPES = ['finding', 'decision', 'risk', 'source', 'output']
export const ALWAYS = ['wb_context', 'evidence_get', 'claim_add', 'decision_needed', 'help_needed', 'discuss_with_person', 'file_save', 'tools_ensure', 'stage_result']

/** What a step handed back, in one line (a custom step's summary, a script's output, a stage result's summary). */
export const outputLine = (run, key, n = 600) => {
  const o = run.outputs?.[key], res = run.stages.find(s => s.key === key)?.result
  const text = o?.summary ?? (o?.output !== undefined ? `exit ${o.code}: ${o.output}` : o?.route ? `route ${o.route}` : null) ?? (typeof res?.summary === 'string' ? res.summary : res ? JSON.stringify(res) : '')
  return String(text || '').replace(/\s+/g, ' ').slice(0, n)
}

/** A model result is a result only when the step's fields support one: a custom step's { ok, summary }, a branch's route, then the step's own check. */
export function validateStageResult(c, result) {
  const fail = field => { throw new Error(`${c.stage}: invalid stage_result ${field}`) }
  const text = value => typeof value === 'string' && value.trim().length > 0
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('result must be an object')
  // a review's own task (lib/review.js): its agent answering the person's comments, or writing the note for them
  const review = c.run?.reviews?.[c.stage]
  if (review && ['revising', 'gathering'].includes(review.status)) { checkReviewResult(c, review, result); return result }
  // a person's workflow's own steps: an agent step (a script step's agent too) says whether it got there and what it
  // found; a branch names a route
  if (['agent', 'flow'].includes(c.def?.generic)) {
    if (typeof result.ok !== 'boolean') fail('ok must be true or false')
    if (!text(result.summary)) fail('summary is required')
    if (result.findings !== undefined && (!Array.isArray(result.findings) || result.findings.some(f => !text(f)))) fail('findings must be an array of non-empty strings')
    return result
  }
  if (c.def?.generic === 'branch') {
    const routes = [...(c.def.routes || []), 'otherwise']
    if (!routes.includes(result.route)) fail(`route must be one of ${routes.join(', ')}`)
    if (!text(result.reason)) fail('reason is required')
    return result
  }
  // a step of a pack's workflow checks its own fields: validate(result, c) throws a message
  if (typeof c.def?.validate === 'function') {
    try { c.def.validate(result, c) } catch (err) { fail(`(${err?.message || err})`) }
  }
  return result
}

export const TOOLS = [
  {
    name: 'wb_context',
    description: 'The run you are working in: the request (title, text, fields, attachments), your folder, the steps and their state, what the steps handed back so far, claims, and the evidence ledger index.',
    parameters: schema({ evidence_from: { type: 'number', description: 'List evidence from this number on (default: all, newest 60)' } }),
    run(c, { evidence_from: from }) {
      const r = c.run, s = r.subject || {}
      const ev = c.store.evidence(r.id, Math.max(0, (from || 1) - 1)).slice(-60)
      const fields = Object.entries(s.fields || {}).filter(([, v]) => v !== '' && v !== undefined)
      return [
        `Run ${r.id} · ${c.workflow?.title || r.template} · step ${r.stage || '-'}`,
        `Your folder: ${dirOf(r) || '(none)'}`,
        `Request${s.evidence ? ` (evidence #${s.evidence})` : ''}: ${s.title || '(no title)'}${s.text ? `\n${s.text.length > 4000 ? `${s.text.slice(0, 4000)}\n…(the rest is evidence #${s.evidence || '?'})` : s.text}` : ''}`,
        fields.length ? `Fields:\n${fields.map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')}` : '',
        s.attachments?.length ? `Attachments:\n${s.attachments.map(a => `- ${a.name} (${a.mime || '?'}, ${a.size} bytes)${a.evidence ? ` evidence #${a.evidence}` : ''}`).join('\n')}` : '',
        `Steps:\n${r.stages.map(x => `- ${x.key} [${x.status}${x.attempt > 1 ? ` ×${x.attempt}` : ''}] ${x.owner}${x.note ? `: ${x.note.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`).join('\n')}`,
        r.stages.some(x => outputLine(r, x.key)) ? `What the steps handed back:\n${r.stages.filter(x => outputLine(r, x.key)).map(x => `- ${x.key}: ${outputLine(r, x.key)}`).join('\n')}` : '',
        r.claims?.length ? `Claims:\n${r.claims.map(x => `- ${x.id} [${x.type}] ${x.text} (evidence ${x.evidence.map(n => `#${n}`).join(', ')})`).join('\n')}` : '',
        `Evidence:\n${ev.map(e => `#${e.seq} ${e.kind}${e.ok === false ? ' ✗' : ''} · ${e.actor} · ${e.title}`).join('\n') || '(none)'}`,
      ].filter(Boolean).join('\n\n')
    },
  },
  {
    name: 'evidence_get',
    description: 'Read one evidence entry in full (input, output, and its complete artifact, truncated at 20k chars).',
    parameters: schema({ seq: { type: 'number', description: 'Evidence number' } }, ['seq']),
    run(c, { seq }) {
      const e = c.store.evidenceAt(c.run.id, seq)
      if (!e) throw new Error(`no evidence #${seq} in this run`)
      const full = e.artifact ? c.store.readArtifact(e.artifact) : e.output
      return `#${e.seq} ${e.kind} · ${e.actor} · ${e.title}\ninput: ${JSON.stringify(e.input)}\ncode: ${e.code}\n\n${full.length > 20000 ? `${full.slice(0, 20000)}\n…(truncated)` : full}`
    },
  },
  {
    name: 'claim_add',
    description: 'Record a conclusion. It must cite evidence numbers from this run (claims without evidence never reach the report).',
    parameters: schema({
      type: { type: 'string', enum: CLAIM_TYPES, description: 'finding: something you established; decision: a choice made and why; risk: what may go wrong; source: where a fact comes from; output: something this run produced' },
      text: str('The claim, specific (values, names, conditions)'),
      evidence: { type: 'array', items: { type: 'number' }, description: 'Evidence numbers that support it' },
    }, ['type', 'text', 'evidence']),
    run(c, { type, text, evidence }) {
      if (!CLAIM_TYPES.includes(type)) throw new Error(`type is one of ${CLAIM_TYPES.join(', ')}`)
      if (!String(text || '').trim()) throw new Error('say what the claim is')
      const known = new Set(c.store.evidence(c.run.id).map(e => e.seq))
      const refs = [...new Set((evidence || []).map(Number))]
      const missing = refs.filter(n => !known.has(n))
      if (!refs.length || missing.length) throw new Error(missing.length ? `no evidence ${missing.map(n => `#${n}`).join(', ')} in this run` : 'cite at least one evidence number')
      let id
      c.update(r => {
        id = `C${(r.claims?.length || 0) + 1}`
        return { ...r, claims: [...(r.claims || []), { id, type, text, evidence: refs, actor: c.actor, stage: c.stage, at: Date.now() }] }
      })
      return `Recorded claim ${id}.`
    },
  },
  {
    name: 'decision_needed',
    description: 'Ask the person a decision only they can make — a choice the evidence cannot settle. Not for a check you can run yourself: run it. Give 2–4 options, each with what it does; mark the one you recommend. blocking=true stops the run at the end of this step until they choose (use it when the next steps depend on the answer).',
    parameters: schema({
      question: str('The decision, one sentence'),
      why: str('Why a person must decide: what the evidence cannot settle, citing evidence numbers'),
      options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: {
        label: str('The option, a few words'),
        does: str('What happens with it: what changes, who is affected'),
        action: { type: 'string', enum: ['accept', 'revise', 'check'], description: 'accept: keep the run as it is; revise: redo from a step with this choice as input; check: verify something first' },
        from: str('revise / check: the key of the step to redo (this step or an earlier one of this workflow)'),
      }, required: ['label', 'does', 'action'] } },
      recommended: { type: 'number', description: 'Index (from 0) of the option you recommend' },
      blocking: { type: 'boolean', description: 'true: the run waits for the answer before its next step' },
    }, ['question', 'why', 'options']),
    run(c, { question, why, options, recommended, blocking }) {
      const opts = (Array.isArray(options) ? options : []).slice(0, 4).map(o => ({ label: String(o?.label || '').slice(0, 120), does: String(o?.does || '').slice(0, 600), action: ['accept', 'revise', 'check'].includes(o?.action) ? o.action : 'accept', ...(o?.from && { from: String(o.from) }) }))
      if (!String(question || '').trim() || opts.length < 2 || opts.some(o => !o.label)) throw new Error('a decision needs a question and 2–4 labelled options')
      const keys = (c.workflow?.stages || []).map(s => s.key)
      for (const o of opts) {
        if (o.action !== 'accept' && !o.from) throw new Error('a revise or check option names the step to redo (from)')
        if (o.from && !keys.includes(o.from)) throw new Error(`"${o.from}" is not a step of this workflow (steps: ${keys.join(', ')})`)
      }
      const rec = Number.isInteger(recommended) && recommended >= 0 && recommended < opts.length ? recommended : null
      const a = c.approval({ action: 'decision', title: String(question).trim().slice(0, 300), payload: { why: String(why || '').slice(0, 2000), options: opts, recommended: rec, blocking: !!blocking, stage: c.stage, by: c.actor } })
      c.record({ kind: 'gate', title: `decision asked${blocking ? ' (the run waits)' : ''}: ${String(question).slice(0, 200)}`, input: { approval: a.id, options: opts.map(o => o.label), recommended: rec }, output: String(why || ''), ok: true })
      return blocking ? `Asked (${a.id}). Finish this step as well as you can; the run waits for the answer before its next step, and the choice comes back to the run.` : `Asked (${a.id}); carry on — the person answers in their own time.`
    },
  },
  {
    name: 'help_needed',
    description: 'Ask the person for what only a person can give, when this step is stuck without it: access you do not have, data you cannot reach, a fact the request leaves out, evidence that contradicts itself. Not for a check you can run yourself, and not for a choice between options (decision_needed). Say what you tried (evidence numbers) and what would help. The run waits after this step; it runs again with their answer. At most 3 times in a step.',
    parameters: schema({
      question: str('What you need, one sentence'),
      tried: str('What you tried and what it showed, citing evidence numbers'),
      would_help: str('What kind of answer gets you through: a hint, access, data, a fact'),
    }, ['question', 'tried']),
    run(c, { question, tried, would_help: help }) {
      const q = String(question || '').trim()
      if (!q) throw new Error('say what you need')
      const asked = (c.run.helps || []).filter(h => h.stage === c.stage).length
      if (asked >= HELP_ROUNDS) throw new Error(`this step has asked ${HELP_ROUNDS} times already: finish it as well as you can and say in its result what is missing`)
      // the person reads what was tried before answering: the step's own evidence, cited (ask only after driving it as far as it goes)
      const own = c.store.evidence(c.run.id).filter(e => e.stage === c.stage && e.kind !== 'gate')
      if (own.length && !/#\d+/.test(String(tried || ''))) throw new Error(`in "tried", cite the evidence of what you tried as #n (this step's: ${own.slice(-6).map(e => `#${e.seq}`).join(', ')}): the person reads it before answering`)
      const why = [String(tried || '').trim(), help && `Would help: ${String(help).trim()}`].filter(Boolean).join('\n\n').slice(0, 4000)
      // one open ask per step: a second one adds to it
      const open = c.store.list('approval').find(a => a.runId === c.run.id && a.action === 'help' && a.payload?.stage === c.stage && a.payload?.kind === 'agent' && (a.status === 'pending' || (['running', 'done', 'rejected'].includes(a.status) && !a.applied)))
      if (open && open.status !== 'pending') return `The person already answered (${open.id}). Finish this step now so their answer can be applied; do not ask again in this turn.`
      const a = open ? c.store.put('approval', { ...open, title: `${open.title} · ${q}`.slice(0, 300), payload: { ...open.payload, rev: (open.payload.rev || 0) + 1, why: `${open.payload.why}\n\n${why}`.slice(0, 8000) } })
        : c.approval({ action: 'help', title: q.slice(0, 300), payload: { kind: 'agent', why, stage: c.stage, blocking: true, by: 'workflow' } })
      c.record({ kind: 'gate', title: `the person is asked: ${q.slice(0, 200)}`, input: { approval: a.id }, output: why, ok: true })
      return `Asked (${a.id}). Finish this step as well as you can and hand in your result; the run waits for the answer and this step runs again with it.`
    },
  },
  {
    name: 'discuss_with_person',
    description: 'Talk something through with the person before going on, when a conversation settles it better than one question or a set of options: a direction to work out with them, a draft to shape together, findings to agree on before the conclusion. Say what to discuss and what is open (evidence numbers). This step then ends: the person talks it over with you, and when they say it is settled this step runs again with what was agreed. Not for a single missing fact (help_needed) or a choice between set options (decision_needed). Counts as one of the 3 asks of a step.',
    parameters: schema({
      topic: str('What to talk through, one sentence'),
      why: str('What is open and why it needs the person, citing evidence numbers'),
    }, ['topic']),
    run(c, { topic, why }) {
      const t = String(topic || '').trim()
      if (!t) throw new Error('say what to talk through')
      const asked = (c.run.helps || []).filter(h => h.stage === c.stage).length
      if (asked >= HELP_ROUNDS) throw new Error(`this step has asked ${HELP_ROUNDS} times already: finish it as well as you can and say in its result what is still open`)
      const text = String(why || '').trim().slice(0, 4000)
      // one open ask per step: a discussion asked again adds its topic to the one open
      const open = c.store.list('approval').find(a => a.runId === c.run.id && a.action === 'help' && a.payload?.stage === c.stage && a.payload?.kind === 'agent' && (a.status === 'pending' || (['running', 'done', 'rejected'].includes(a.status) && !a.applied)))
      if (open && open.status !== 'pending') return `The person already answered (${open.id}). Finish this step now so their answer can be applied; do not ask again in this turn.`
      const a = open ? c.store.put('approval', { ...open, title: `${open.title} · ${t}`.slice(0, 300), payload: { ...open.payload, rev: (open.payload.rev || 0) + 1, talk: true, with: c.stage, why: [open.payload.why, text].filter(Boolean).join('\n\n').slice(0, 8000) } })
        : c.approval({ action: 'help', title: t.slice(0, 300), payload: { kind: 'agent', talk: true, with: c.stage, why: text, stage: c.stage, blocking: true, by: 'workflow' } })
      c.record({ kind: 'gate', title: `the person is asked to talk it through: ${t.slice(0, 200)}`, input: { approval: a.id }, output: text, ok: true })
      return `Asked to talk it through (${a.id}). Finish this step as well as you can and hand in your result; the run waits while the person talks it over with you, and this step runs again with what was agreed.`
    },
  },
  {
    name: 'file_save',
    description: 'Keep a piece of work in the run: a draft, a final text, an image, a data file. It is stored as an artifact and put in the evidence ledger, so it has an evidence number you can cite and the report lists it. Text goes in as is; binary content as base64.',
    parameters: schema({
      name: str('File name with extension, e.g. draft-1.md or cover.png (no folders)'),
      content: str('The content: the text itself, or base64 when encoding is "base64"'),
      encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'utf8 (default) or base64' },
      title: str('One line saying what it is (shown in the ledger)'),
      mime: str('Media type, e.g. text/markdown or image/png (optional)'),
    }, ['name', 'content']),
    run(c, { name, content, encoding = 'utf8', title, mime }) {
      const file = String(name || '').split(/[\\/]/).pop().trim()
      if (!file || file.startsWith('.')) throw new Error('give a file name (with an extension, no folders)')
      if (!['utf8', 'base64'].includes(encoding)) throw new Error('encoding is utf8 or base64')
      if (typeof content !== 'string') throw new Error('content must be a string')
      if (encoding === 'base64' && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(content)) throw new Error('content is not valid base64')
      const bytes = Buffer.from(content, encoding)
      if (!bytes.length) throw new Error('the content is empty')
      if (bytes.length > FILE_MAX) throw new Error(`the file is over ${FILE_MAX >> 20} MB`)
      const textual = encoding === 'utf8'
      const e = c.record({
        kind: 'file', title: String(title || `file: ${file}`).slice(0, 200), input: { name: file, bytes: bytes.length, ...(mime && { mime: String(mime).slice(0, 100) }) },
        output: textual ? tail(content, 3000) : `(binary, ${bytes.length} bytes)`, ok: true, full: bytes, name: file,
      })
      return `Saved ${file} (${bytes.length} bytes) as evidence #${e.seq}. Cite it as #${e.seq}.`
    },
  },
  {
    name: 'tools_ensure',
    description: 'Get a command-line tool your commands need that is not on this machine: its name from mise\'s registry, or name@version (shellcheck, jq@1.7.1, golangci-lint@1.64). It installs it with mise in the home (no root) — use this, never sudo or an installer of your own. Only a tool of the registry: a package from npm, pipx, GitHub or any other source is put in the workflow by a person. A tool it cannot install (a Docker engine, a system library) comes back with how a person installs it. Only a step that may change files has it.',
    parameters: schema({ tool: str('e.g. shellcheck, ruff, jq@1.7.1, golangci-lint@1.64') }, ['tool']),
    async run(c, { tool }) {
      if (!c.tools) throw new Error('command-line tools are not available here')
      const want = String(tool || '').trim()
      if (!registryName(want)) throw new Error(`"${want.slice(0, 80)}" is not a name from mise's registry: ask for a plain tool name (shellcheck, jq@1.7.1). A package from a backend or a source (npm:, pipx:, github:, …) is put in the workflow's command-line tools by a person — say in your result what could not be checked for want of it.`)
      const res = await c.tools.need(want, { by: 'agent' })
      if (res.status === 'missing') return `${res.want} is not available here${res.error ? ` (${res.error})` : ''}. ${res.how?.text || ''}${res.how?.cmd ? ` A person runs: ${res.how.cmd}` : ''}\nCarry on without it where you can, and say in your result what could not be checked for want of it.`
      const line = c.tools.activation?.() || `export PATH='${res.path.slice(0, res.path.lastIndexOf('/')).replace(/'/g, "'\\''")}':"$PATH"`
      return `${res.want}: ${res.status === 'installed' ? `installed${res.version ? ` ${res.version}` : ''}` : 'already here'} — ${res.path}. Your own shell does not have it yet (a process started before keeps the PATH it had): run this first in it —\n${line}`
    },
  },
  {
    name: 'stage_result',
    description: 'Hand your structured result for the current step to the workbench (the task tells you the fields). Call it once, at the end.',
    parameters: schema({ result: { type: 'object', description: 'The fields your task asked for' } }, ['result']),
    run(c, { result }) {
      validateStageResult(c, result)
      c.update(r => ({ ...r, stages: r.stages.map(s => (s.key === c.stage ? { ...s, result, resultBy: c.actor } : s)) }))
      return `Step ${c.stage}: result recorded. Now reply with a short report and finish.`
    },
  },
]

/** The tools as agents see them (name, description, parameters): `list` is core tools and the packs'. */
export const toolDefs = list => list.map(({ name, description, parameters, pack }) => ({
  name, parameters, description: typeof description === 'function' ? description(pack || { name: 'the pack' }) : description,
}))
/** Run one tool of `list`; a pack's tool sees its own pack as c.pack. */
export async function callTool(list, c, name, args) {
  const tool = list.find(t => t.name === name)
  if (!tool) throw new Error(`unknown tool ${name}`)
  return String(await tool.run(tool.pack ? { ...c, pack: tool.pack, packSettings: c.settings?.packs?.[tool.pack.id] } : c, args || {}))
}
