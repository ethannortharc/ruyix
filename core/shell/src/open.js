// The things open on the desk, on the page (docs/design/sessions.md §5): whoever opens one adds it here; the box keeps
// the list (/api/ruyix/open: every page and browser the same, a reload keeps it); how they group is open-model.js.
// Made by whoever asks first (window.__ruyixOpen), like the work list.
//   openRegistry().add({ id, kind, title, names?, icon?, hint?, of?, ofTitle?, reopen: { event, detail } })   opened (or again)
//   (names: { zh, en }, when the opener has its name in both — the page shows it in its language, nameOf in ../open-model.js)
//   (the work's name is kept the first time it is known — ofTitle, or the work list's — so a card keeps it after the work
//   leaves the work list)
//   .rename(id, { title?, names? }) · .use(id) · .fold(id, folded) · .foldGroup(key, folded) · .pin(key, pinned) · .close(id) · .forget(id) · .reopen(id) · .move(id, group | null)
//   .list() · .groups() · .closed() · .open(id): its reopen event sent, and used — a 'ruyix:open-things' event after a change
// An item that is a window on the desk carries `win` (its __ruyixDesk id): the desk tiles those, the rest only reopen.
import { applyOpen, emptyOpen, groupsOf } from '../open-model.js'

export function openRegistry(w = globalThis.window, fetchFn = (...a) => globalThis.fetch(...a)) {
  if (w.__ruyixOpen) return w.__ruyixOpen
  let state = emptyOpen(), pending = [], timer = null, posting = false, retryMs = 1000
  const emit = () => w.dispatchEvent?.(new Event('ruyix:open-things'))
  // (what the box answered, taken only when it is a state: an error page, a proxy's answer, an empty one leave it as it is —
  // the desk draws from it, and a broken one would take the desk down)
  const valid = s => s && Array.isArray(s.items) && Array.isArray(s.closed) && Array.isArray(s.rules)
  const take = s => ({ ...emptyOpen(), ...s })
  const schedule = (ms = 250) => { if (pending.length && !posting) { timer ??= setTimeout(post, ms); timer.unref?.() } }
  const post = async () => {
    timer = null
    if (posting || !pending.length) return
    posting = true
    const ops = pending.splice(0, 100)
    let failed = false
    try {
      const r = await fetchFn('api/ruyix/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const s = await r.json()
      if (!valid(s)) throw new Error('invalid open state')
      if (!pending.length) { state = take(s); emit() }
      retryMs = 1000
    } catch {
      pending = [...ops, ...pending]
      failed = true
    } finally {
      posting = false
      schedule(failed ? retryMs : 250)
      if (failed) retryMs = Math.min(30000, retryMs * 2)
    }
  }
  const change = op => {
    try { state = applyOpen(state, op) } catch (err) { console.warn(`ruyix open: ${err.message}`); return }
    emit()
    pending.push(op)
    schedule()
  }
  /** What the box has (another page's changes): when nothing of this page's is on its way. */
  const load = async () => {
    if (pending.length || posting) return
    const before = state
    try { const r = await fetchFn('api/ruyix/open'); if (r.ok) { const s = await r.json().catch(() => null); if (valid(s) && !pending.length && !posting && state === before && s.rev !== state.rev) { state = take(s); emit(); named() } } } catch { /* next time */ }
  }
  const titleOf = key => (w.__ruyixWork?.get?.() || []).find(x => x.id === key)?.title || null
  // the work list names a work this list holds without a name yet: kept
  const named = () => { for (const k of new Set(state.items.map(x => x.of).filter(Boolean))) if (!state.titles?.[k] && titleOf(k)) change({ op: 'title', key: k, title: titleOf(k) }) }
  w.addEventListener?.('ruyix:work', named)
  const reg = w.__ruyixOpen = {
    add: item => change({ op: 'add', item: item?.of && !item.ofTitle && titleOf(item.of) ? { ...item, ofTitle: titleOf(item.of) } : item }),
    rename: (id, { title, names } = {}) => change({ op: 'rename', id, title, names }),
    use: id => change({ op: 'use', id }),
    fold: (id, folded = true) => change({ op: 'fold', id, folded }),
    foldGroup: (key, folded = true) => change({ op: 'foldGroup', key, folded }),
    pin: (key, pinned = true) => change({ op: 'pin', key, pinned }),
    close: id => change({ op: 'close', id }),
    forget: id => change({ op: 'forget', id }),
    reopen: id => { const it = state.closed.find(x => x.id === id); if (it) { change({ op: 'reopen', id }); w.dispatchEvent?.(new CustomEvent(it.reopen.event, { detail: it.reopen.detail })) } },
    move: (id, group) => change({ op: 'move', id, group: group || null }),
    /** Bring one up: its reopen event, and used. */
    open: id => { const it = state.items.find(x => x.id === id); if (it) { change({ op: 'use', id }); w.dispatchEvent?.(new CustomEvent(it.reopen.event, { detail: it.reopen.detail })) } },
    list: () => state.items,
    closed: () => state.closed,
    groups: () => groupsOf(state, { titleOf }),
    load,
  }
  load()
  return reg
}
