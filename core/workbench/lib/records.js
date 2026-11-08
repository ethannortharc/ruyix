// 记录 (docs/design/agent-work.md §3): every piece of the agents' work in one list — the workflow runs, the resident
// sessions (the ones not a run's step), the pool's own jobs — newest first, each said the same way: what it was, who did
// it, when and how long, what it cost, what came of it, and how to open its whole story.
//   item: { id: 'run:<id>' | 'session:<id>' | 'job:<id>', kind: run | session | job, title, sub, task: { id, title } | null,
//           agents: [{ id, runtime, model }], startedAt, endedAt (null: going), at (its latest moment), state: working |
//           waiting | done | failed | stopped, ok, archived, tokens, cost, files, turns, said, studio, open: { event, detail } }

import { pageOf } from './page.js'

const ACTIVE = new Set(['queued', 'running', 'waiting'])
const oneLine = (v, n = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
/** What a step handed back, as words (its summary, what a discussion settled, a text, an answer, a note), or '' — a run's line. */
export const resultWords = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? [v.summary, v.settled, v.text, v.answer, v.note].find(x => typeof x === 'string' && x.trim()) || '' : '')

/** A run as a record. `cost`: its { tokens, usd, files } from the ledger (counted by the caller, kept while it is the same). */
export function runRecord(r, { cost = {}, taskTitle = () => '', workflowTitle = () => '' } = {}) {
  const failed = r.verdict?.level === 'failed'
  const state = ACTIVE.has(r.status) ? (r.status === 'waiting' ? 'waiting' : 'working') : r.status === 'done' ? (failed ? 'failed' : 'done') : r.status === 'failed' ? 'failed' : 'stopped'
  const agents = []
  for (const s of r.stages || []) if (s.agent?.id && !agents.some(a => a.id === s.agent.id)) agents.push({ id: s.agent.id, runtime: s.agent.runtime || null, model: s.agent.model || null })
  const last = [...(r.stages || [])].reverse().map(s => resultWords(r.outputs?.[s.key] ?? s.result)).find(Boolean) || ''
  return {
    id: `run:${r.id}`, kind: 'run', title: r.subject?.title || r.template, sub: (typeof r.workflowDef?.title === 'string' && r.workflowDef.title) || workflowTitle(r.template) || r.template,
    task: r.taskId ? { id: r.taskId, title: taskTitle(r.taskId) || '' } : null, agents,
    startedAt: r.createdAt || null, endedAt: ACTIVE.has(r.status) ? null : r.endedAt || null, at: r.endedAt || r.updatedAt || r.createdAt || 0,
    state, ok: state === 'done', archived: !!r.archivedAt, tokens: cost.tokens || 0, cost: cost.usd || 0, files: cost.files || 0,
    said: oneLine(r.verdict?.reason || last || r.error || ''), ...(r.studio && { studio: r.studio }),
    open: { event: 'ruyix-workbench:open', detail: { run: r.id } },
  }
}

/** A resident session as a record (its turns so far; going while a turn is at work). */
export function sessionRecord(d) {
  const state = d.state === 'working' ? 'working' : d.error ? 'failed' : 'done'
  return {
    id: `session:${d.id}`, kind: 'session', title: d.title || d.agent, sub: d.cwd || '', task: null,
    agents: [{ id: d.agent, runtime: d.runtime || null, model: d.model || null }],
    startedAt: d.createdAt || null, endedAt: state === 'working' ? null : d.lastAt || null, at: d.lastAt || d.createdAt || 0,
    state, ok: state === 'done', archived: false, tokens: d.tokens || 0, cost: d.cost || 0, files: 0, turns: d.turns || 0,
    said: oneLine(d.error || d.said || ''), open: { event: 'agent-hub:open', detail: { tab: 'sessions', session: d.id } },
  }
}

/** One of the pool's own jobs (a Lead's, not a run's) as a record: its tasks' agents, tokens and cost. */
export function jobRecord(j, tasks = []) {
  const state = j.status === 'running' ? 'working' : j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : 'stopped'
  const agents = []
  for (const t of tasks) if (t.agent && !agents.some(a => a.id === t.agent)) agents.push({ id: t.agent, runtime: t.runtime || null, model: t.model || null })
  return {
    id: `job:${j.id}`, kind: 'job', title: j.title || j.id, sub: j.cwd || '', task: null, agents,
    startedAt: j.createdAt || null, endedAt: state === 'working' ? null : j.endedAt || null, at: j.endedAt || j.updatedAt || j.createdAt || 0,
    state, ok: state === 'done', archived: !!j.archivedAt, tokens: tasks.reduce((n, t) => n + (t.tokens || 0), 0),
    cost: Math.round(tasks.reduce((n, t) => n + (t.cost || 0), 0) * 1e6) / 1e6, files: 0, turns: tasks.length,
    said: oneLine(j.report || j.error || ''), open: { event: 'agent-hub:open', detail: { tab: 'tasks', select: { kind: 'job', id: j.id } } },
  }
}

/**
 * The list: every record that fits — `kinds` (run, session, job), `q` (words in its title, workflow, agents, task, line),
 * `studio` (only the runs of that studio), `archived` (put-away runs too) — newest first, `limit` of them before
 * `before` ({at,id}, or a legacy time: the next page). → { items, more }
 */
export function recordsOf(all, { q = '', kinds = ['run', 'session', 'job'], studio = null, archived = false, before = null, limit = 150 } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean)
  const text = x => `${x.title} ${x.sub} ${x.task?.title || ''} ${x.agents.map(a => `${a.id} ${a.model || ''}`).join(' ')} ${x.said}`.toLowerCase()
  const fit = all
    .filter(x => kinds.includes(x.kind))
    .filter(x => !studio || x.studio?.id === studio)
    .filter(x => archived || !x.archived)
    .filter(x => !words.length || words.every(w => text(x).includes(w)))
  const { page, more, cursor } = pageOf(fit, { before, limit })
  return { items: page, more, cursor }
}

/** The start of a moment's day (this machine's clock). */
export const dayOf = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }

/** The records in groups: by the day they were last at, the task (or what they are), or each agent that took part. */
export function groupRecords(items, by, words) {
  const groups = new Map()
  const put = (key, title, x, extra = {}) => { if (!groups.has(key)) groups.set(key, { key, title, items: [], ...extra }); groups.get(key).items.push(x) }
  for (const x of items) {
    if (by === 'task') {
      if (x.kind === 'run') x.task ? put(`task:${x.task.id}`, x.task.title || x.title, x) : put(`wf:${x.sub}`, x.sub, x)
      else put(`kind:${x.kind}`, words.kind(x.kind), x)
    } else if (by === 'agent') {
      if (!x.agents.length) put('agent:-', words.noAgent, x)
      for (const a of x.agents) put(`agent:${a.id}`, a.id, x, { runtime: a.runtime })
    } else put(`day:${dayOf(x.at)}`, null, x, { day: x.at })
  }
  return [...groups.values()]
}

