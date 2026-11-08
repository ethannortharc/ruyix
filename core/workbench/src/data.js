// Data layer: delta-sync of the Host store (runs, approvals), per-run evidence, the workflow registry (names, success
// levels) and the packs' extensions (window.__ruyixWorkbenchExt).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

/** The panel's namespace: its locale words, browser keys and API. */
export const NS = 'ruyix-workbench'
export const INBOX = 'ruyix-workbench-inbox'
export const FLOW = 'ruyix-workbench-flow'
/** The Chat page (the standing conversation, for long reading and search; the shell's chat sheet is the way in). */
export const CHAT = 'ruyix-workbench-chat'
export const RECORDS = 'ruyix-workbench-records' // 记录: all the agents' work in one list (src/records.jsx)
/** The workbench's settings: a tab of the shell's Settings page. */
export const SETTINGS_TAB = 'ruyix-workbench-settings'
export const API = 'api/ruyix-workbench'
/** The event that opens the workbench on a view, a run or a tab (the home page, notifications, other plugins send it). */
export const OPEN = 'ruyix-workbench:open'
/** The event a pack's client sends after it put (or changed) its extension in window.__ruyixWorkbenchExt. */
export const EXT_EVENT = 'ruyix-workbench-ext'

export async function call(op, args) {
  const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...args }) })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok || data.error) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code, params: data.params })
  return data
}
/** A run's artifact as a file the browser streams (<img>, <video>, <audio>; Range works). */
export const fileUrl = (runId, seq, download = false) => `${API}/file?run=${encodeURIComponent(runId)}&seq=${seq}${download ? '&download=1' : ''}`

export const local = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ } },
}

export function useSnapshot(source) {
  const [[subscribe, read]] = useState(() => [fn => source.subscribe(fn), () => source.getSnapshot()])
  return useSyncExternalStore(subscribe, read)
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}

const KINDS = ['run', 'approval', 'task']
/**
 * Full snapshot once, then only documents whose rev moved — one poll for the whole page: the panel's store and the
 * sidebar badge (which also reads each delta for its notifications) share it, at the fastest pace any of them asks.
 */
const wb = { state: { ...Object.fromEntries(KINDS.map(k => [k, new Map()])), rev: 0, ready: false, error: '' }, rev: 0, subs: new Map(), timer: null, busy: false }
const wbTick = async () => {
  clearTimeout(wb.timer); wb.timer = null
  if (!wb.subs.size || wb.busy) return
  wb.busy = true
  let delta = null
  try {
    const r = await call('sync', { since: wb.rev })
    const first = !wb.rev
    // Evidence appends move `rev` without a document change: views keyed on it refetch their ledger.
    if (first || r.rev !== wb.rev || r.reset) {
      const s = wb.state, fresh = first || r.reset
      const next = Object.fromEntries(KINDS.map(k => [k, r.docs.length || fresh ? new Map(fresh ? [] : s[k]) : s[k]]))
      // (a deleted one comes as a mark: it leaves the page's store; the subscribers hear it in `removed`)
      for (const d of r.docs) { if (d.deletedAt) next[d.kind]?.delete(d.id); else next[d.kind]?.set(d.id, d) }
      wb.state = { ...next, rev: r.rev, ready: true, error: '' }
      delta = { docs: r.docs.filter(d => !d.deletedAt), removed: r.docs.filter(d => d.deletedAt).map(d => ({ kind: d.kind, id: d.id })), first }
    }
    wb.rev = r.rev
  } catch (err) {
    wb.state = { ...wb.state, error: err.message }
    delta = { docs: [], first: false }
  } finally { wb.busy = false }
  if (delta) for (const fn of wb.subs.keys()) fn(delta)
  // a delta poll of a few hundred bytes; a push stream if it ever shows in profiles
  if (wb.subs.size) { const every = Math.min(...wb.subs.values()); wb.timer = setTimeout(wbTick, document.hidden ? Math.max(5000, every) : every) }
}
/** `fn({ docs, first })` on every change; a late subscriber first hears what is there already (as `first`). */
export function subscribeWb(fn, every) {
  wb.subs.set(fn, every)
  if (wb.state.ready) queueMicrotask(() => wb.subs.has(fn) && fn({ docs: KINDS.flatMap(k => [...wb.state[k].values()]), first: true }))
  if (!wb.busy) wbTick() // a faster view joined (or the first): poll now and at its pace
  return () => { wb.subs.delete(fn); if (!wb.subs.size) { clearTimeout(wb.timer); wb.timer = null } }
}
/** A run as the page's store has it (null: not here, or not yet). */
export const runDoc = id => wb.state.run.get(id) || null
export function useWbStore() {
  const state = useSyncExternalStore(useCallback(fn => subscribeWb(fn, 1500), []), () => wb.state)
  return [state, wbTick]
}

/** One run's evidence, appended as it grows. */
export function useEvidence(runId, rev) {
  const [state, setState] = useState({ id: runId, list: [] })
  useEffect(() => {
    let alive = true
    const after = state.id === runId ? state.list.at(-1)?.seq ?? 0 : 0
    call('run', { id: runId, after }).then(r => {
      if (alive) setState(s => ({ id: runId, list: s.id === runId && after ? [...s.list, ...r.evidence] : r.evidence }))
    }, () => {})
    return () => { alive = false }
  }, [runId, rev])
  return state.id === runId ? state.list : []
}

/** A run with each step's full result (sync leaves them out), read again when the run changes. */
export function useFullRun(run) {
  const [full, setFull] = useState(null)
  useEffect(() => {
    let alive = true
    call('run', { id: run.id }).then(r => alive && setFull(r.run), () => {})
    return () => { alive = false }
  }, [run.id, run.updatedAt])
  return full && full.id === run.id ? full : run
}

// ── the workflows the workbench knows (names, success levels, forms): read from the `workflows` op, shared ──
const wf = { data: null, loading: null, subs: new Set() }
export function loadWorkflows(force = false) {
  if (wf.data && !force) return Promise.resolve(wf.data)
  wf.loading ||= call('workflows').then(d => { wf.data = d; for (const fn of wf.subs) fn(); return d }, () => wf.data).finally(() => { wf.loading = null })
  return wf.loading
}
/** Keep a fresh `workflows` answer (the Workflows page read one) for everyone who shows names. */
export const cacheWorkflows = d => { wf.data = d; for (const fn of wf.subs) fn() }
const wfSnapshot = () => wf.data
/** The `workflows` op's answer ({ builtIn, mine, skills, … }), null until it arrived; reload() reads it again. */
export function useWorkflows() {
  const data = useSyncExternalStore(useCallback(fn => { wf.subs.add(fn); return () => wf.subs.delete(fn) }, []), wfSnapshot)
  useEffect(() => { if (!wf.data) loadWorkflows() }, [])
  return [data, () => loadWorkflows(true)]
}
/** The workflow a run started on: the definition it kept (a person's, on a base), else the built-in one by its id. */
export const baseId = run => run?.workflowDef?.base ?? run?.template
/** The verdict level that counts as success for a run. */
export const successOf = (run, data) => data?.builtIn?.find(b => b.id === baseId(run))?.success || 'done'

// ── packs' extensions ──
/** window.__ruyixWorkbenchExt as { packId: ext }. */
export const exts = () => window.__ruyixWorkbenchExt || {}
/** Re-renders when a pack registers or changes its extension. */
export function useExtVersion() {
  const [n, setN] = useState(0)
  useEffect(() => { const on = () => setN(x => x + 1); window.addEventListener(EXT_EVENT, on); return () => window.removeEventListener(EXT_EVENT, on) }, [])
  return n
}
/** The pack a run belongs to: the part of its workflow's id before the dot ('notes.publish'), null for the core's own. */
export const packOfRun = run => { const id = String(baseId(run) || ''); return id.includes('.') ? id.slice(0, id.indexOf('.')) : null }
/** The extension that reviews an action: the run's own pack first, then any pack that has the action. → { packId, ext } | null */
export function approvalExt(action, run) {
  const all = exts(), mine = packOfRun(run)
  for (const id of [mine, ...Object.keys(all)]) {
    const ext = id && all[id]?.approvals?.[action]
    if (ext) return { packId: id, ext }
  }
  return null
}
/**
 * The editor a decision card asks for (payload.editor: '<pack>.<name>'): what the person reviews and may change before
 * choosing, from window.__ruyixWorkbenchExt[pack].decisionEditors[name]. → { packId, Editor } | null
 */
export function decisionEditor(name) {
  const [packId, key] = String(name || '').split('.')
  const Editor = packId && key ? exts()[packId]?.decisionEditors?.[key] : null
  return Editor ? { packId, Editor } : null
}
