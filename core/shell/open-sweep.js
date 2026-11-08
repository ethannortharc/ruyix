// Things on the desk for work that is over (docs/design/agent-tasks.md; Ethan 2026-10-18: archived tasks still had their
// groups on the desk): an open thing of a run, a session or a task — its `of`, or itself (`run:<id>`) — is put away
// (closed: in the list of closed things, to bring back) when that work is gone or archived, or — over, and the thing not
// used for a while — when it is just left there. Work going on is never touched; nor what the person put in a group of
// their own or pinned. The workbench and Agent Hub say what each work is now; without them nothing is closed.
const ACTIVE = new Set(['queued', 'running', 'waiting'])
export const IDLE_MS = 12 * 3600e3

/** `work`: { run(id), task(id), session(id) } → null (gone) | { over, archived }, or undefined when it cannot be told. → the ids to close */
export function sweepOpen(state, work, now = Date.now(), idleMs = IDLE_MS) {
  const out = []
  const pinned = new Set(state.pins || [])
  for (const x of state.items) {
    if (x.group || x.bg) continue // (where the person put it; a terminal in the background: its own rule)
    const key = x.of || (/^(run|session|task):/.test(x.id) ? x.id.split(':').slice(0, 2).join(':') : null)
    if (!key || pinned.has(key)) continue
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    const ask = work[kind]
    if (!ask) continue
    let w
    try { w = ask(id) } catch { continue }
    if (w === undefined) continue // (cannot be told now: left as it is)
    if (w === null || w.archived || (w.over && now - (x.usedAt || 0) > idleMs)) out.push(x.id)
  }
  return out
}

/** What a workbench run, a task, an Agent Hub session is now, for sweepOpen (undefined: its owner is not here). */
export function workOf({ workbench = () => null, hub = () => null }) {
  return {
    run: id => {
      const wb = workbench()
      if (!wb?.run) return undefined
      const r = wb.run(id)
      if (!r) return null
      const t = r.taskId && wb.tasks?.get ? wb.tasks.get(r.taskId) : null
      return { over: !ACTIVE.has(r.status), archived: !!(r.archivedAt || t?.archived) }
    },
    task: id => {
      const t = workbench()?.tasks?.get
      if (!t) return undefined
      const v = t(id)
      return v ? { over: ['done', 'failed', 'stopped'].includes(v.state), archived: !!v.archived } : null
    },
    session: id => {
      const list = hub()?.sessions?.()
      if (!list) return undefined
      const d = list.find(s => s.id === id)
      return !d || d.removedAt ? null : { over: d.state !== 'working', archived: false }
    },
  }
}
