// The work going on, for whatever draws it (docs/design/sessions.md §3): each producer publishes its own slice — the
// workbench 'runs', Agent Hub 'tasks' and 'sessions' — and every desk reads one list, in one order, so each takes its
// first N the same way. No producer reads another's data; whichever loads first makes the list (window.__ruyixWork).
//   workRegistry().set(source, items, { seen?, summarize? })   a producer's whole slice, again at each change (the same one
//                                       twice is no change); its hooks: seen(ids) — looked at (the desk's 擦掉), summarize(id) →
//                                       Promise<string> — the main model's account of it so far (a lane opened)
//   workRegistry().get()                every slice's items, the most pressing first; a 'ruyix:work' event after a change
//   workRegistry().seen(id) · .summarize(id)   through the item's own producer (the desk need not know which); summarize
//                                       resolves null when its producer has none
// An item (agent-work.md §2–3): { id: 'run:<id>' | 'task:<id>' | 'session:<id>', kind: run | task | session | browser, title,
//   agents: [{ id, kind: claude | codex | pi | dsh | system | person, state, step }],
//   state: queued | working | waiting | failed | done | stopped, segs: [{ title, st: done | run | wait | fail | skip | todo }],
//   cur, pulse?: { at, kind }, startedAt, endedAt, ok, seen, open?: { event, detail } (what opening it is: an event to send),
//   lines?: [{ at, agent, text, kind: tool | say | wait }] (each agent's last few, the newest last),
//   outcome?: { ok, text, thumb?, open? } (when done) }

/** How pressing: waiting for the person, at work, gone wrong, done and not looked at, the rest. */
export function rankOf(w) {
  if (w.state === 'waiting') return 0
  if (w.state === 'working') return 1
  if (w.state === 'failed' && !w.seen) return 2
  if (w.state === 'done' && !w.seen) return 3
  return 4
}
const when = w => w.endedAt || w.lastAt || w.startedAt || 0
/** The most pressing first; within a rank, the latest first. */
export const sortWork = list => [...list].sort((a, b) => rankOf(a) - rankOf(b) || when(b) - when(a))

export function workRegistry(w = globalThis.window) {
  if (w.__ruyixWork) return w.__ruyixWork
  const slices = new Map(), keys = new Map(), hooks = new Map()
  let merged = []
  const sourceOf = id => [...slices].find(([, list]) => list.some(x => x.id === id))?.[0]
  w.__ruyixWork = {
    set(source, items, { seen, summarize } = {}) {
      hooks.set(source, { seen, summarize })
      const list = Array.isArray(items) ? items.filter(x => x && x.id) : []
      const key = JSON.stringify(list)
      if (keys.get(source) === key) return
      keys.set(source, key); slices.set(source, list)
      merged = sortWork([...slices.values()].flat())
      w.dispatchEvent?.(new Event('ruyix:work'))
    },
    get: () => merged,
    sources: () => [...slices.keys()],
    /** Looked at (the desk's 擦掉, 看结果): its producer records it. → whether one took it */
    seen(id) { const h = hooks.get(sourceOf(id)); if (!h?.seen) return false; try { h.seen([id]) } catch { /* the producer's own */ } return true },
    /** The main model's account of it so far: → Promise<string | null> (null: its producer has none). */
    summarize(id) { const h = hooks.get(sourceOf(id)); return h?.summarize ? Promise.resolve().then(() => h.summarize(id)) : Promise.resolve(null) },
  }
  return w.__ruyixWork
}
