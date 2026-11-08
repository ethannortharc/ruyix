// The tasks and what they made, as the task center and the portfolio read them (docs/design/agent-tasks.md; the
// workbench's ops on api/ruyix-workbench, workspace-ce's): every page reads through these. A change anywhere comes as the
// window event 'ruyix:tasks'; the pages read again then, when the window comes back, and slowly on their own.
//   useTaskList({ state, source, studio, q, archived }) → { tasks, counts, more, loadMore, loading, error, reload }
//   useTask(id, lang) → { task, timeline (worded in the page's language), outputs, loading, error, reload }
//   useOutputs({ kind, studio, q }) → { outputs, more, loadMore, loading, error, reload }
//   act.confirm(id) · act.revise(id, text) · act.archive(id, archived) · act.remove(id)
// A page asked to land somewhere — 'ruyix:open' { panel: 'ruyix-tasks', task | run | tab | view: 'new' (and the new task's
// fields) } (a task card, a note, an old page's link) — gets it from useLanding(), kept until it is read (the page may be
// made by that very open).
// 「任务」 is one page for the day's work (docs/design/work-in-one-place.md): other plugins put their parts in through the
// slots it hosts — PART_SLOT (list; { task, lang, reload }: drawn in a task's detail, nothing when the task is not
// theirs — a workflow run's steps, evidence and report), TAB_SLOT (list; { id, order, label, count? }: a tab of its own after
// 归档 — 定时; count(counts) → the number on it, from the list's counts), NEW_SLOT (single; { onClose, lang, preset }: the 新建任务 form, in a sheet over the page). Every entry
// has an id: each is drawn alone.
import { useCallback, useEffect, useRef, useState } from 'react'

export const TASKS = 'ruyix-tasks', WORKS = 'ruyix-works', CHANGED = 'ruyix:tasks'
export const PART_SLOT = 'ruyix.tasks.part', TAB_SLOT = 'ruyix.tasks.tab', NEW_SLOT = 'ruyix.tasks.new'
const PAGE = 40, SLOW_MS = 20000

export async function op(name, args = {}) {
  const res = await fetch('api/ruyix-workbench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: name, ...args }) })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok || data?.error) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { code: data?.code })
  return data
}
export const act = {
  confirm: (id, run, expect) => op('taskConfirm', { id, run, ...(expect !== undefined && { expect }) }),
  revise: (id, text, run, expect) => op('taskRevise', { id, text, run, ...(expect !== undefined && { expect }) }),
  archive: (id, archived = true) => op('taskArchive', { id, archived }),
  remove: id => op('taskDelete', { id }),
}

/** Read again on a change, when the window comes back, and every so often while shown. */
function useFresh(reload) {
  useEffect(() => {
    const on = () => { if (!document.hidden) reload() }
    window.addEventListener(CHANGED, on); window.addEventListener('focus', on)
    const t = setInterval(on, SLOW_MS)
    return () => { window.removeEventListener(CHANGED, on); window.removeEventListener('focus', on); clearInterval(t) }
  }, [reload])
}

/** A paged list: the first page again on each reload (what was loaded beyond it is kept while the filter is the same). */
function usePaged(name, args, key, pick) {
  const [st, set] = useState({ list: [], more: false, extra: null, loading: true, error: null })
  const want = JSON.stringify(args), shown = useRef(want), request = useRef(0)
  shown.current = want
  const reload = useCallback(async () => {
    const asked = want, seq = ++request.current
    try {
      const r = await op(name, { ...JSON.parse(asked), limit: PAGE })
      if (shown.current !== asked || seq !== request.current) return
      set(s => {
        // keep the pages loaded beyond the first (the same filter): the first page replaced, the rest after it
        const first = pick(r), ids = new Set(first.map(x => x.id))
        const rest = s.list.length > first.length && s.filter === asked ? s.list.slice(first.length).filter(x => !ids.has(x.id)) : []
        return { list: [...first, ...rest], more: !!r.more || (rest.length > 0 && s.more), extra: r, loading: false, error: null, filter: asked }
      })
    } catch (error) { if (shown.current === asked && seq === request.current) set(s => ({ ...s, loading: false, error })) }
  }, [want])
  useEffect(() => { shown.current = want; set({ list: [], more: false, extra: null, loading: true, error: null, filter: want }); reload() }, [want])
  useFresh(reload)
  const loadMore = async () => {
    const asked = want, seq = request.current
    const last = st.list.at(-1)
    if (!last) return
    try {
      const r = await op(name, { ...JSON.parse(asked), limit: PAGE, before: { at: last[key], id: last.id } })
      if (shown.current !== asked || seq !== request.current) return
      set(s => ({ ...s, list: [...s.list, ...pick(r).filter(x => !s.list.some(y => y.id === x.id))], more: !!r.more }))
    } catch (error) { if (shown.current === asked && seq === request.current) set(s => ({ ...s, error })) }
  }
  return { ...st, reload, loadMore }
}

export function useTaskList(filter) {
  const p = usePaged('taskList', filter, 'updatedAt', r => r.tasks || [])
  return { tasks: p.list, counts: p.extra?.counts || {}, agents: p.extra?.agents || [], more: p.more, loadMore: p.loadMore, loading: p.loading, error: p.error, reload: p.reload }
}
export function useOutputs(filter) {
  const p = usePaged('outputList', filter, 'at', r => r.outputs || [])
  return { outputs: p.list, more: p.more, loadMore: p.loadMore, loading: p.loading, error: p.error, reload: p.reload }
}

export function useTask(id, lang = 'zh') {
  const [st, set] = useState({ task: null, timeline: [], outputs: [], loading: !!id, error: null })
  const want = JSON.stringify([id, lang]), shown = useRef(want), request = useRef(0)
  shown.current = want
  const reload = useCallback(async () => {
    if (!id) return
    const seq = ++request.current
    try {
      const r = await op('taskGet', { id, lang })
      if (shown.current === want && seq === request.current) set({ task: r.task, timeline: r.timeline || [], outputs: r.outputs || [], loading: false, error: null })
    } catch (error) { if (shown.current === want && seq === request.current) set(s => ({ ...s, loading: false, error })) }
  }, [id, lang])
  useEffect(() => { set({ task: null, timeline: [], outputs: [], loading: !!id, error: null }); reload() }, [id, lang])
  useFresh(reload)
  return { ...st, reload }
}

// ── landing ──
let landing = null
const LAND = 'ruyix-tasks:land'
const WHERE = ['task', 'run', 'tab', 'view']
/** Catch the opens that say where on the page (the shell's apply, for the page's life). */
export function catchLanding() {
  const on = e => {
    const d = e.detail || {}
    if (d.panel !== TASKS || !WHERE.some(k => d[k])) return
    landing = { ...d }
    window.dispatchEvent(new CustomEvent(LAND))
  }
  // (what the workbench sends for a thing made with nothing else to open: its task, here)
  const task = e => { if (e.detail?.task) window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: TASKS, task: String(e.detail.task) } })) }
  window.addEventListener('ruyix:open', on)
  window.addEventListener('ruyix-tasks:open', task)
  return () => { window.removeEventListener('ruyix:open', on); window.removeEventListener('ruyix-tasks:open', task) }
}
/** Where the page is asked to go ({ task?, run?, tab?, view?, … } as opened), read once. */
export function useLanding(onLand) {
  useEffect(() => {
    const take = () => { if (landing) { const d = landing; landing = null; onLand(d) } }
    take()
    window.addEventListener(LAND, take)
    return () => window.removeEventListener(LAND, take)
  }, [])
}
/** The task a workflow's run belongs to (an old link to the run lands there); null when none. */
export const taskOfRun = run => op('taskGet', { run: String(run) }).then(r => r.task?.id || null, () => null)
