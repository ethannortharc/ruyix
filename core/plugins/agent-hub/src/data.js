// Data layer: the Host's SQLite mirror (delta-synced) joined with the browser-only facts
// dsh keeps in memory — pending approvals/questions, unread completions, archive state.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

export async function call(op, args) {
  // Browser-relative like the host's own routes, so a mount prefix keeps working.
  const res = await fetch('api/agent-hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, ...args }),
  })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok || data.error) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code, params: data.params })
  return data
}

export const local = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ } },
}

export function useSnapshot(source) {
  // Bound once: sources are class instances; a stable subscribe avoids resubscribing per render.
  const [[subscribe, read]] = useState(() => [fn => source.subscribe(fn), () => source.getSnapshot()])
  return useSyncExternalStore(subscribe, read)
}

export function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * Delta-sync the Host store: full snapshot once, then only session rows and documents whose rev moved. One poll for
 * the whole page (panel and sidebar icon share it), at the fastest pace any open view asks for.
 */
const hub = { state: { rows: new Map(), agents: new Map(), configs: new Map(), jobs: new Map(), tasks: new Map(), sessions: new Map(), ready: false, error: '' }, rev: 0, subs: new Map(), timer: null, busy: false }
const hubEmit = () => { for (const fn of hub.subs.keys()) fn() }
const hubTick = async () => {
  clearTimeout(hub.timer); hub.timer = null
  if (!hub.subs.size || hub.busy) return
  hub.busy = true
  try {
    const r = await call('sync', { since: hub.rev })
    if (!hub.rev || r.rows.length || r.docs.length) {
      const s = hub.state, first = !hub.rev
      const next = { rows: new Map(first ? [] : s.rows), agents: new Map(first ? [] : s.agents), configs: new Map(first ? [] : s.configs), jobs: new Map(first ? [] : s.jobs), tasks: new Map(first ? [] : s.tasks), sessions: new Map(first ? [] : s.sessions) }
      for (const row of r.rows) next.rows.set(row.id, row)
      for (const doc of r.docs) next[`${doc.kind}s`]?.set(doc.id, doc)
      hub.state = { ...next, ready: true, error: '' }
      hubEmit()
    }
    hub.rev = r.rev
  } catch (err) {
    hub.state = { ...hub.state, error: err.message }
    hubEmit()
  } finally { hub.busy = false }
  // ponytail: a delta poll (a few hundred bytes); switch to a push stream if it ever shows up in profiles
  if (hub.subs.size) { const every = Math.min(...hub.subs.values()); hub.timer = setTimeout(hubTick, document.hidden ? Math.max(5000, every) : every) }
}
export function useHubStore(every = 1000) {
  const state = useSyncExternalStore(useCallback(fn => {
    hub.subs.set(fn, every)
    if (!hub.busy) hubTick() // a faster view joined (or the first): poll now and at its pace
    return () => { hub.subs.delete(fn); if (!hub.subs.size) { clearTimeout(hub.timer); hub.timer = null } }
  }, [every]), () => hub.state)
  return [state, hubTick]
}

/** The synced documents outside React (the work list's slices): fn(state) at each change; → its end. */
export function watchHub(fn, every = 5000) {
  const sub = () => fn(hub.state)
  hub.subs.set(sub, every)
  if (!hub.busy) hubTick()
  return () => { hub.subs.delete(sub); if (!hub.subs.size) { clearTimeout(hub.timer); hub.timer = null } }
}

/** The panel's read marks (localStorage), re-read when the panel changes them rather than on a clock. */
const READ_EVENT = 'agent-hub:read'
export const markRead = keys => { local.set('agentHub.read', keys.slice(-500)); window.dispatchEvent(new Event(READ_EVENT)) }
export function useReadMarks() {
  const [marks, setMarks] = useState(() => new Set(local.get('agentHub.read', [])))
  useEffect(() => {
    const again = () => setMarks(new Set(local.get('agentHub.read', [])))
    window.addEventListener(READ_EVENT, again); window.addEventListener('storage', again)
    return () => { window.removeEventListener(READ_EVENT, again); window.removeEventListener('storage', again) }
  }, [])
  return marks
}

/** What needs you: a job's Lead waiting (or done / errored, unread) and failed member runs not yet seen. The panel lists these; the sidebar badge counts them. */
export const attentionOf = (hub, read) => hub.jobs.flatMap(j => [
  // a Lead waiting for you stays until you answer (opening the job is not an answer); done / error until seen
  ...(j.lead.state === 'waiting' || (['error', 'done'].includes(j.lead.state) && !read.has(j.lead.readKey))
    ? [{ key: j.lead.readKey, jobId: j.id, pick: j.lead.id, title: j.title, agent: j.lead, avatar: 'lead', lead: true }] : []),
  ...j.tasks.filter(x => x.status === 'failed' && !read.has(x.readKey))
    .map(x => ({ key: x.readKey, jobId: j.id, pick: `task:${x.id}`, title: `${x.member} · ${x.title}`, agent: x, avatar: x.member })),
])

const ORDER = { waiting: 0, error: 1, running: 2, queued: 2, done: 3, idle: 4 }
const DONE = new Set(['done', 'failed', 'cancelled'])
const base = path => String(path || '').split(/[\\/]/).filter(Boolean).pop() || ''
const sum = values => values.reduce((a, b) => a + (b || 0), 0)

/** A task in the shape the status atoms read (state / running / act / updatedAt). */
export const taskState = task => ({ queued: 'queued', running: 'running', done: 'done', failed: 'error', cancelled: 'idle' })[task.status] || 'idle'

/** A job's lanes — one per role its tasks were given — with what each is doing now and did last. */
export function membersOf(defs, tasks) {
  return defs.map(def => {
    const mine = tasks.filter(x => x.member === def.name)
    const current = mine.find(x => x.status === 'running')
    const queued = mine.filter(x => x.status === 'queued').length
    const last = current || mine.filter(x => DONE.has(x.status)).at(-1)
    return {
      id: `m:${def.name}`, name: def.name, title: def.name, def, current, last, queued, tasks: mine,
      state: current ? 'running' : queued ? 'queued' : last?.status === 'failed' ? 'error' : last?.status === 'done' ? 'done' : 'idle',
      running: !!current, pending: null, unread: false, act: last?.act,
      done: mine.filter(x => x.status === 'done').length,
      tokens: sum(mine.map(x => x.tokens)), cost: sum(mine.map(x => x.cost)),
      model: current?.model || last?.model || def.model || '',
      updatedAt: Math.max(0, ...mine.map(x => x.updatedAt || 0)),
    }
  })
}

/** A lane as its latest task describes it: the role text, the agent and what it ran on, the fallback. */
const laneOf = (name, tasks, agents) => {
  const last = tasks.filter(x => x.member === name).at(-1)
  const agent = agents.get(last?.agent)
  return { name, role: last?.role || '', agent: last?.agent || '', runtime: last?.runtime || agent?.runtime || 'dsh', model: last?.model || agent?.model || null, effort: last?.effort || null,
    access: last?.access || 'write', skills: agent?.skills || [], fallback: last?.fallback ? agents.get(last.fallback) || { id: last.fallback } : null }
}

/** The pool (with each agent's work across jobs) and every job: its Lead's live session joined with its tasks. */
export function buildHub({ rows, agents, configs, jobs, tasks }, status, workspaces, list) {
  const archived = new Set(workspaces.archivedSessionIds || [])
  const wsTitle = cwd => workspaces.items.find(w => w.path === cwd)?.title || base(cwd)
  const leadOf = (id, j) => {
    const row = rows.get(id) || { id, data: {}, running: false, updatedAt: 0, cwd: j.cwd }
    const data = row.data
    const s = status.get(id)
    const act = data.agentActivity
    const running = !!(s?.running ?? row.running)
    const pending = s?.pendingInteraction || null
    const usage = data.tokenUsage
    const pressure = data.contextPressure
    const used = pressure && (pressure.projectedTokens ?? pressure.pressureTokens)
    return {
      id, lead: true, title: data.title || list.byId[id]?.displayTitle || j.title, cwd: row.cwd || j.cwd, ws: wsTitle(row.cwd || j.cwd),
      updatedAt: row.updatedAt, running, pending, unread: !!s?.completionUnread,
      state: pending ? 'waiting' : running ? 'running' : act?.lastEnd?.kind === 'error' ? 'error' : s?.completionUnread ? 'done' : 'idle',
      act, stats: data.sessionStats,
      tokens: usage ? usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens : 0,
      ctxPct: used && pressure.contextWindow ? Math.min(100, Math.round(used / pressure.contextWindow * 100)) : null,
      model: data.modelSelection?.lastUsed?.model || data.modelSelection?.next?.model || '',
      queued: data.inbox ? data.inbox['next-turn'].length + data.inbox['next-step'].length : 0,
      readKey: `${id}:${act?.lastEnd?.at ?? row.updatedAt ?? 0}`,
    }
  }
  const pool = new Map([...agents.values()].filter(a => !a.deleted).map(a => [a.id, a]))
  const tasksByJob = new Map()
  for (const task of tasks.values()) {
    const decorated = { ...task, state: taskState(task), running: task.status === 'running', pending: null, readKey: `task:${task.id}:${task.endedAt || 0}` }
    ;(tasksByJob.get(task.jobId) || tasksByJob.set(task.jobId, []).get(task.jobId)).push(decorated)
  }
  const out = []
  for (const j of jobs.values()) {
    if (archived.has(j.leadId)) continue
    const all = (tasksByJob.get(j.id) || []).sort((a, b) => a.createdAt - b.createdAt)
    const lead = leadOf(j.leadId, j)
    const members = membersOf([...new Set(all.map(x => x.member))].map(name => laneOf(name, all, pool)), all)
    const state = lead.state === 'waiting' ? 'waiting' : j.status === 'running' ? 'running' : j.status === 'failed' ? 'error' : j.status === 'done' ? 'done' : 'idle'
    out.push({
      id: j.id, doc: j, goal: j.goal, title: j.title, lead, members, tasks: all, report: j.report, error: j.error,
      done: all.filter(x => x.status === 'done').length, live: members.filter(m => m.running).length, state,
      updatedAt: Math.max(j.updatedAt || 0, lead.updatedAt || 0, ...all.map(x => x.updatedAt || 0)),
      readKey: `job:${j.id}:${j.endedAt || 0}`,
    })
  }
  const allTasks = [...tasks.values()]
  return {
    agents: [...pool.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(a => {
      const mine = allTasks.filter(x => x.agent === a.id)
      return { ...a, running: mine.filter(x => x.status === 'running').length, done: mine.filter(x => x.status === 'done').length, failed: mine.filter(x => x.status === 'failed').length, tokens: sum(mine.map(x => x.tokens)), cost: sum(mine.map(x => x.cost)) }
    }),
    defaultAgent: configs.get('hub')?.defaultAgent || null,
    mainAgent: configs.get('hub')?.mainAgent || null,
    mainModel: configs.get('hub')?.mainModel || null,
    jobs: out.sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || b.doc.createdAt - a.doc.createdAt),
  }
}
