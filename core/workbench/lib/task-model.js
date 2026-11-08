// A task: one thing the person wants an agent to do on this OS (docs/design/agent-tasks.md) — from the input (typed,
// spoken, a schedule, a studio's record, another agent) to the output the person accepts. Every exchange in between
// (questions, approvals, reviews, 再改) stays in the same task. Workflow tasks (lib/tasks.js: once or on a schedule, a run
// each time) are tasks; so are a request in the conversation, a piece of work given to a session, a pool job, a studio's
// "write one" — each kept as a task document here, linked to what does the work.
//   state: queued | working | waiting (for the person) | to-confirm (it made or changed something: 好了 or 再改) | done |
//          failed | stopped — archived beside it (out of sight, still on record); deleted: gone
// No React here, no store: what a task is, worked out from its document and its runs (checked in node).

export const STATES = ['queued', 'working', 'waiting', 'to-confirm', 'done', 'failed', 'stopped']
export const SOURCES = ['chat', 'session', 'job', 'run', 'studio', 'schedule']
export const OUTPUT_KINDS = ['file', 'draft', 'post', 'report', 'image', 'video', 'card', 'answer']
export const LINK_KINDS = ['run', 'session', 'job', 'chat', 'studio']
/** Over: nothing more happens unless the person starts it again (archive and delete are for these). */
export const OVER = new Set(['done', 'failed', 'stopped'])
const ACTIVE = new Set(['queued', 'running', 'waiting'])

/** A run's part of its task's state: queued, working, waiting, failed, stopped — or 'made' (done: something to confirm). */
export function runState(r) {
  if (r.status === 'queued') return 'queued'
  if (r.status === 'waiting') return 'waiting'
  if (r.status === 'running') return 'working'
  if (r.status === 'cancelled' || r.status === 'interrupted') return 'stopped'
  if (r.status === 'failed' || r.verdict?.level === 'failed') return 'failed'
  return 'made'
}

/**
 * Where a task stands. One with runs (a workflow's): its latest run's — a run that finished made something (its report,
 * its files): to-confirm until the person says 好了 for it (`confirmedRunId`). One without: the state its source keeps
 * (a request in the conversation, a session's piece of work…); a workflow task with no run yet: queued.
 * `runs`: the task's runs, the latest first.
 */
export function taskState(t, runs = []) {
  if (runs.length) {
    const r = runs[0], s = runState(r)
    if (s !== 'made') return s
    return t.confirmedRunId === r.id ? 'done' : 'to-confirm'
  }
  if (STATES.includes(t.state)) return t.state
  return t.workflow ? 'queued' : 'working'
}

/** A line its source says (what it does now, how it ended): '…' (one language) or { zh, en } → { zh, en, at }, or null. */
export function lineOf(v, at = Date.now()) {
  const cut = x => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const zh = typeof v === 'string' ? cut(v) : v && typeof v === 'object' ? cut(v.zh || v.en) : ''
  const en = typeof v === 'string' ? zh : v && typeof v === 'object' ? cut(v.en || v.zh) : ''
  return zh || en ? { zh, en, at } : null
}
/** That line in the page's language. */
export const lineIn = (l, lang = 'zh') => (l ? (lang === 'en' ? l.en : l.zh) || l.zh || l.en || '' : '')

/** Where a task came from, for one from before sources: a schedule's, a run's (a workflow started once). */
export const sourceOf = t => (SOURCES.includes(t.source) ? t.source : t.schedule?.kind && t.schedule.kind !== 'once' ? 'schedule' : 'run')

/** How far a task's latest run has come: its steps passed of those it has (not skipped), and the one it is on (null:
 * no steps known — a conversation's request, a session's work: those say only what they do now, `step`). */
export function progressOf(runs) {
  const st = (runs[0]?.stages || []).filter(s => s.status !== 'skipped')
  if (!st.length) return null
  const cur = st.find(s => ['running', 'waiting', 'failed'].includes(s.status)) || st.find(s => s.status === 'pending')
  return { done: st.filter(s => s.status === 'passed').length, total: st.length, ...(cur && { step: String(cur.title || cur.key).slice(0, 80) }) }
}

/**
 * A task as the pages and other plugins see it: its document's facts, its state worked out, who works on it, what it is
 * linked to, what it waits on the person for. `runs`: its runs, the latest first; `approvals`: the cards of those runs.
 */
export function taskView(t, runs = [], { approvals = [] } = {}) {
  const state = taskState(t, runs), last = runs[0] || null, progress = progressOf(runs)
  const agents = []
  for (const a of t.agents || []) if (a?.id && !agents.some(x => x.id === a.id)) agents.push({ id: a.id, runtime: a.runtime || null })
  for (const r of runs.slice(0, 3)) for (const s of r.stages || []) if (s.agent?.id && !agents.some(x => x.id === s.agent.id)) agents.push({ id: s.agent.id, runtime: s.agent.runtime || null })
  const links = [...(t.links || []), ...runs.slice(0, 20).map(r => ({ kind: 'run', id: r.id }))].filter((l, i, all) => all.findIndex(x => x.kind === l.kind && x.id === l.id) === i)
  // what it waits on the person for: the open card of its run (a decision, a question, a discussion…) — or its own
  const card = state === 'waiting' && last ? approvals.find(a => a.runId === last.id && ['pending', 'failed'].includes(a.status)) : null
  const waitingFor = card ? { kind: card.payload?.kind === 'chat' || card.payload?.talk ? 'chat' : card.action, title: card.title || '', open: { event: 'ruyix-workbench:open', detail: { run: last.id, tab: 'approvals' } } }
    : state === 'waiting' && t.waitingFor ? t.waitingFor : null
  // (when it last moved: a workflow's by its runs and the person's word on it — its document is rewritten for other
  // reasons, a next time set, a migration — another's by its document)
  const at = last ? Math.max(t.createdAt || 0, t.confirmedAt || 0, ...(t.log || []).map(e => e.at || 0), ...runs.slice(0, 3).map(r => r.endedAt || r.updatedAt || r.createdAt || 0)) : Math.max(t.updatedAt || 0, t.createdAt || 0)
  return {
    id: t.id, title: t.title, resultVersion: t.resultVersion || 0, source: sourceOf(t), state, archived: archivedOf(t, runs), agents, ...(t.studio && { studio: t.studio }), links,
    ...(t.workflow && { workflow: t.workflow }), ...(t.schedule?.kind && t.schedule.kind !== 'once' && { schedule: t.schedule, nextAt: t.nextAt || null }),
    ...(last && { lastRunId: last.id }), ...(progress && { progress }), runs: runs.length, outputs: (t.outputs || []).length + runs.reduce((n, r) => n + (r.outputCount || 0), 0),
    ...(waitingFor && { waitingFor }), createdAt: t.createdAt || 0, updatedAt: at,
    ...(OVER.has(state) && { endedAt: last?.endedAt || t.endedAt || at }), ...(t.confirmedAt && { confirmedAt: t.confirmedAt }),
    // (its source's lines: what it does now while it goes, how it ended once over or made)
    ...(t.step && !OVER.has(state) && state !== 'to-confirm' && { step: t.step }), ...(t.result && (OVER.has(state) || state === 'to-confirm') && { result: t.result }),
  }
}

/** An output, checked: { kind, title, ref?, thumb?, url?, by? } → the stored one (with id and time), or why not. */
export function checkOutput(o = {}, { id, at = Date.now() } = {}) {
  if (!OUTPUT_KINDS.includes(o.kind)) throw Object.assign(new Error(`an output is one of ${OUTPUT_KINDS.join(', ')}`), { code: 'badOutput' })
  const title = String(o.title || '').trim().slice(0, 200)
  if (!title) throw Object.assign(new Error('an output has a title'), { code: 'badOutput' })
  const local = u => typeof u === 'string' && (u.startsWith('api/') || (u.startsWith('/') && !u.startsWith('//')))
  const web = u => typeof u === 'string' && /^https?:\/\//.test(u)
  return {
    id, kind: o.kind, title, at,
    ...(o.ref && typeof o.ref === 'object' && { ref: JSON.parse(JSON.stringify(o.ref)) }),
    ...(local(o.thumb) && { thumb: o.thumb }), ...(web(o.url) || local(o.url) ? { url: o.url } : {}),
    // (whether it is a final output — the portfolio's — when its source says so; else its task's state decides)
    ...(typeof o.final === 'boolean' && { final: o.final }),
    ...(o.preview && typeof o.preview === 'object' && { preview: previewOf(o.preview, local) }),
    ...(o.by && typeof o.by === 'object' && { by: Object.fromEntries(Object.entries(o.by).filter(([k, v]) => ['run', 'step', 'session', 'job', 'chat'].includes(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 80)])) }),
  }
}

const previewOf = (p, local) => ({
  ...(typeof p.text === 'string' && p.text.trim() && { text: p.text.trim().slice(0, 300) }), ...(local(p.poster) && { poster: p.poster }),
  ...(typeof p.platform === 'string' && { platform: p.platform.slice(0, 40) }),
})

/** Where a run's report is read on its own (GET: its Markdown). */
export const reportUrl = runId => `api/ruyix-workbench/report?run=${encodeURIComponent(runId)}`
/** A run's file by its path in the run's folder (the portfolio's thumbnails and posters). */
export const workUrl = (runId, path) => `api/ruyix-workbench/work?run=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`

/**
 * Whether a task is archived: archived itself, or a one-off whose runs all were (the runs page archives a run, and
 * its task goes with it).
 */
export const archivedOf = (t, runs = []) => !!t.archivedAt || ((!t.schedule || t.schedule.kind === 'once') && runs.length > 0 && runs.every(r => r.archivedAt))

/**
 * How an output opens on its own: a file in the viewer window at that file (a video plays, a picture shows), a report
 * alone in the viewer, a post by its link, anything else its task.
 */
export function openOf(o, taskId) {
  if (o.ref?.run && o.ref.report) return { event: 'ruyix-workbench:view', detail: { files: [{ url: reportUrl(o.ref.run), name: `${String(o.title || 'report').replace(/[\\/]/g, '-').slice(0, 100)}.md`, kind: 'markdown' }], title: o.title || '' } }
  if (o.ref?.run && (o.ref.seq || o.ref.path)) return { event: 'ruyix-workbench:view', detail: { run: o.ref.run, ...(o.ref.path && { file: o.ref.path }) } }
  if (o.ref?.session) return { event: 'ruyix-workbench:view', detail: { session: o.ref.session, ...(o.ref.path && { file: o.ref.path }) } }
  if (o.url && /^https?:\/\//.test(o.url)) return { event: 'ruyix:open-url', detail: { url: o.url } }
  return { event: 'ruyix-tasks:open', detail: { task: taskId } }
}

const KIND_OF = [[/\.(png|jpe?g|gif|webp|avif|svg)$/i, 'image'], [/\.(mp4|mov|webm|m4v)$/i, 'video'], [/draft|稿/i, 'draft']]
/** What kind of output a file is, by its name. */
export const kindOfName = name => KIND_OF.find(([re]) => re.test(name))?.[1] || 'file'
const baseName = p => String(p).split('/').pop()
const stem = p => baseName(p).replace(/\.[^.]+$/, '')

/**
 * A run's outputs, as a task's. Final ones (the portfolio's), once the run ended done: its result files — `results`, the
 * same as its 结果 tab (its 结果 steps' files, else what it changed in its folder) — each opened on its own; its report
 * only when it made no result files (a run whose product is the report); what it published (`run.posted`, a pack's).
 * Not final: the ledger's files of the steps on the way (not the request's attachments). `results`: null while not
 * known yet (the ledger's files then, none of them final); `preview(path)`: a text file's first lines, or null.
 */
export function runOutputs(run, evidence = [], { results = null, preview = () => null } = {}) {
  const asked = new Set((run.subject?.attachments || []).map(a => a.evidence))
  const ok = run.status === 'done' && run.verdict?.level !== 'failed'
  const at = run.endedAt || run.updatedAt || run.createdAt
  const paths = results || [], named = new Set(paths.map(baseName))
  const out = []
  for (const p of paths) {
    const kind = kindOfName(baseName(p))
    const poster = kind === 'video' && paths.find(x => x !== p && kindOfName(baseName(x)) === 'image' && stem(x) === stem(p))
    const text = kind === 'image' || kind === 'video' ? null : preview(p)
    out.push({ id: `${run.id}:${p}`, kind, title: baseName(p), ref: { run: run.id, path: p }, at, final: ok,
      ...(kind === 'image' && { thumb: workUrl(run.id, p) }), ...((text || poster) && { preview: { ...(text && { text }), ...(poster && { poster: workUrl(run.id, poster) }) } }),
      by: { run: run.id } })
  }
  for (const e of evidence) {
    if (e.kind !== 'file' || !e.artifact || asked.has(e.seq)) continue
    const name = e.input?.name || e.artifact.split('/').pop()
    if (named.has(name)) continue // (the same file as a result: that one)
    const image = kindOfName(name) === 'image' || /^image\//.test(e.input?.mime || '')
    out.push({ id: `${run.id}#${e.seq}`, kind: image ? 'image' : kindOfName(name) === 'draft' ? 'draft' : 'file', title: name, ref: { run: run.id, seq: e.seq }, at: e.at || at, final: false,
      ...(image && { thumb: `api/ruyix-workbench/file?run=${encodeURIComponent(run.id)}&seq=${e.seq}` }), by: { run: run.id, ...(e.stage && { step: e.stage }) } })
  }
  if (run.report && !ACTIVE.has(run.status)) out.push({ id: `${run.id}#report`, kind: 'report', title: run.subject?.title || run.template, ref: { run: run.id, report: true }, at, final: ok && !paths.length, by: { run: run.id } })
  for (const [i, p] of (Array.isArray(run.posted) ? run.posted : []).entries()) {
    const url = typeof p?.url === 'string' && /^https?:\/\//.test(p.url) ? p.url : null
    out.push({ id: `${run.id}#post${i}`, kind: 'post', title: String(p?.title || run.subject?.title || run.template).slice(0, 200), ...(url && { url }), at: p?.at || at, final: true,
      preview: { platform: String(p?.platform || '').slice(0, 40) }, by: { run: run.id } })
  }
  return out
}
