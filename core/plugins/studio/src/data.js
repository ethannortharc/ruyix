// The studios' data for the pages (docs/design/studio.md): every view reads and writes through these, never the API by
// hand. One poll for the whole page (each studio's revision, every few seconds while something is shown and the page
// is in front) tells the hooks what moved; a change made here is seen at once. A change from elsewhere (another tab,
// the main agent's tools, a run's end) comes with the next look. Each change is also a window event, 'ruyix:studio'
// ({ detail: { studio, collection | null } }), for whatever else shows a studio (the strip's chip, the maps).
//   useStudios() → [{ id, name, icon }]          useStudio(id) → { studio (the declaration), loading, error }
//   useCollection(studio, coll) → { items, put(record), remove(id), restore(id), loading, error, reload }
//   useMaterials(studio) → { materials: [{ id, kind, name, url, size, at }], upload(file), remove(id), loading, error }
//   start(studio, startId, recordId, fields?) → the run          history(studio, coll, id) → earlier versions
import { useCallback, useEffect, useRef, useState } from 'react'

export const EVENT = 'ruyix:studio'
const POLL_MS = 3000

export async function call(op, args = {}) {
  const res = await fetch('api/ruyix-studio', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...args }) })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok || data.error) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code, params: data.params })
  return data
}
const said = (studio, collection = null) => window.dispatchEvent(new CustomEvent(EVENT, { detail: { studio, collection } }))

// ── the one poll: each studio's revision; one that moved is said (to the hooks and to the page) ──
const poll = { users: 0, timer: null, revs: null }
async function look() {
  clearTimeout(poll.timer)
  poll.timer = null
  if (!poll.users) return
  if (!document.hidden) {
    try {
      const { revs } = await call('revs')
      if (poll.revs) for (const [id, r] of Object.entries(revs)) if (poll.revs[id] !== r) said(id)
      if (poll.revs && Object.keys(revs).join() !== Object.keys(poll.revs).join()) said(null)
      poll.revs = revs
    } catch { /* the next look tries again */ }
  }
  if (poll.users) poll.timer = setTimeout(look, POLL_MS)
}
function usePoll() {
  useEffect(() => {
    if (!poll.users++) look()
    return () => { if (!--poll.users) { clearTimeout(poll.timer); poll.timer = null; poll.revs = null } }
  }, [])
}
/** Reload when this studio (and collection, if given) is said to have moved. */
function useMoved(studio, collection, reload) {
  useEffect(() => {
    const on = e => { const d = e.detail || {}; if (d.studio === null || (d.studio === studio && (!d.collection || !collection || d.collection === collection))) reload() }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [studio, collection, reload])
}
/** Something read: { value, loading, error, reload } — loaded on mount and when `deps` change. */
function useLoad(load, deps) {
  const [st, set] = useState({ value: null, loading: true, error: null })
  const want = JSON.stringify(deps), shown = useRef(want), request = useRef(0)
  shown.current = want
  const reload = useCallback(async () => {
    const asked = want, seq = ++request.current
    try {
      const value = await load()
      if (shown.current === asked && seq === request.current) set({ value, loading: false, error: null })
    } catch (error) { if (shown.current === asked && seq === request.current) set(s => ({ ...s, loading: false, error })) }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { set(s => ({ ...s, loading: true })); reload(); return () => { ++request.current } }, [reload])
  return { ...st, reload }
}

export function useStudios() {
  usePoll()
  const { value, reload } = useLoad(() => call('studios').then(r => r.studios), [])
  useMoved(null, null, reload) // (a studio added or gone: said with studio null)
  return value || []
}

export function useStudio(id) {
  // (a declaration changes only when its pack registers again: said with studio null)
  const { value, loading, error, reload } = useLoad(() => call('studio', { id }).then(r => r.studio), [id])
  useMoved(null, null, reload)
  return { studio: value, loading, error, reload }
}

export function useCollection(studio, collection) {
  usePoll()
  const { value, loading, error, reload } = useLoad(() => call('items', { studio, collection }).then(r => r.items), [studio, collection])
  useMoved(studio, collection, reload)
  const after = r => { said(studio, collection); return r }
  return {
    items: value || [], loading, error, reload,
    put: record => call('put', { studio, collection, record }).then(r => after(r.item)),
    remove: id => call('remove', { studio, collection, id }).then(r => after(r.removed)),
    restore: id => call('restore', { studio, collection, id }).then(r => after(r.item)),
  }
}

const base64 = file => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
  r.onerror = () => reject(r.error)
  r.readAsDataURL(file)
})
export function useMaterials(studio) {
  usePoll()
  const { value, loading, error, reload } = useLoad(() => call('materials', { studio }).then(r => r.materials), [studio])
  useMoved(studio, null, reload)
  return {
    materials: value || [], loading, error, reload,
    upload: async file => { const { material } = await call('upload', { studio, name: file.name, data: await base64(file) }); said(studio); return material },
    remove: id => call('removeMaterial', { studio, id }).then(r => { said(studio); return r.removed }),
  }
}

/** Start the studio's workflow (its start `startId`) from a record; the record's status moves as the start says. → the run */
export async function start(studio, startId, recordId = null, fields = undefined) {
  const { run } = await call('start', { studio, start: startId, record: recordId, ...(fields && { fields }) })
  said(studio)
  return run
}
export const history = (studio, collection, id) => call('history', { studio, collection, id }).then(r => r.history)

export function useFeedback(studio, run) {
  usePoll()
  const { value, loading, error, reload } = useLoad(() => call('feedback', { studio, run }), [studio, run])
  useMoved(studio, null, reload)
  // Running stages change without changing the studio's records. Keep the review targets current too.
  useEffect(() => {
    if (!run) return
    const timer = setInterval(() => { if (!document.hidden) reload() }, 5000)
    return () => clearInterval(timer)
  }, [run, reload])
  const mutate = async (op, args) => { const out = await call(op, { studio, ...args }); said(studio); return out }
  return { value: loading || (value?.run || '') !== (run || '') ? null : value, loading, error, reload,
    rate: input => mutate('rate', input), remove: id => mutate('removeFeedback', { id }),
    learning: enabled => mutate('learning', { enabled }) }
}
