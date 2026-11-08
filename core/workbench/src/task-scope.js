// Which tasks a list shows (the Runs page's scopes: going, scheduled, all, put away) — no React here: checked in node.
const ACTIVE = new Set(['queued', 'running', 'waiting']) // (ui.jsx's)
export const TASK_SCOPES = ['active', 'scheduled', 'all', 'archived']
export const repeats = t => !!t?.schedule && t.schedule.kind !== 'once'
/** The task's runs, newest first (from the store's runs). */
export const runsByTask = runs => {
  const m = new Map()
  for (const r of runs) { if (!r.taskId) continue; if (!m.has(r.taskId)) m.set(r.taskId, []); m.get(r.taskId).push(r) }
  for (const list of m.values()) list.sort((a, b) => b.createdAt - a.createdAt)
  return m
}
/**
 * Whether a task is put away: archived itself — or, done once, its run(s) archived (archiving a once-only task's run on
 * its page puts the task away with it; a repeating task is put away only as a task: its next runs still come).
 */
export const archivedTask = (t, runs) => !!t.archivedAt || (!repeats(t) && runs.length > 0 && runs.every(r => r.archivedAt))
export const inTaskScope = (t, runs, scope) => (scope === 'archived' ? archivedTask(t, runs)
  : archivedTask(t, runs) ? false
    : scope === 'active' ? runs.some(r => ACTIVE.has(r.status))
      : scope === 'scheduled' ? repeats(t) : true)

