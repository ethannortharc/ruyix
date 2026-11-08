// The desk's widgets of the work (Ethan 2026-10-19, from the Aviary prototype's 运行 window and 今天): 任务 — the tasks
// at work, each with how far it has come (@ruyix/shell/progress); dragged larger it shows more, and the button in its
// corner opens a small window of them (moved, sized, minimised like any window; the 任务 page stays the whole page).
// 今天 — how many tasks moved today, what they used and cost (@ruyix/shell/money), the last twelve hours' tokens (the
// `today` op). Both read while the page shows and when the tasks change ('ruyix:tasks'); in the widget gallery
// (`preview`) they show sample rows and fetch nothing.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, ListChecks, Maximize2 } from 'lucide-react'
import { currency, money } from '@ruyix/shell/money'
import { progressOf, stepsLine } from '@ruyix/shell/progress'
import { call } from './data.js'
import { en, zh } from './locale.js'
import { namesOf } from './win-names.js'

/** The event that opens (or brings back) the 任务 window. */
export const TASKS_WINDOW = 'ruyix-workbench:tasks-window'
const TASKS_PANEL = 'ruyix-tasks'
const AT_WORK_STATES = ['queued', 'working', 'waiting', 'to-confirm']
const VIEWS = { active: { state: AT_WORK_STATES }, waiting: { state: ['waiting', 'to-confirm'] }, all: {} }

const cx = (...c) => c.filter(Boolean).join(' ')
const fmt = (s, p = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] ?? m))
const wordsOf = lang => (key, params) => fmt((lang === 'zh' ? zh : en)[key] ?? key, params)
const midnight = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
const go = detail => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: TASKS_PANEL, ...detail } }))
const kfmt = n => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n || 0))

/** Read `fetcher()` now, every `every` ms while the page shows, on focus, and when the tasks change. */
function usePoll(fetcher, deps, { every = 8000, off = false } = {}) {
  const [v, setV] = useState(null)
  useEffect(() => {
    if (off) return
    let live = true
    const read = () => { if (!document.hidden) fetcher().then(x => { if (live) setV(x) }, () => {}) }
    read()
    const id = setInterval(read, every)
    window.addEventListener('focus', read); window.addEventListener('ruyix:tasks', read)
    return () => { live = false; clearInterval(id); window.removeEventListener('focus', read); window.removeEventListener('ruyix:tasks', read) }
  }, deps)
  return v
}

// ── 任务 ──

const SAMPLE = [
  { id: 's1', title: '寒流预警：钩子版 v4', source: 'run', state: 'working', progress: { done: 2, total: 5, step: '渲染' } },
  { id: 's2', title: '整理今天的邮件，挑出要回的', source: 'chat', state: 'working', step: '读第 12 封' },
  { id: 's3', title: '选片分享 · 3 条成片 → 123 云盘', source: 'run', state: 'waiting', progress: { done: 2, total: 5 }, waitingFor: { title: '批准上传' } },
]
const STATE_WORD = { queued: 'dw.st.queued', working: 'dw.st.working', waiting: 'dw.st.waiting', 'to-confirm': 'dw.st.confirm', done: 'dw.st.done', failed: 'dw.st.failed', stopped: 'dw.st.stopped' }

/** One task's state word and bar: the percent when its steps are known, else what state it is in. */
function stateOf(t, w) {
  const p = progressOf(t)
  return { ...p, word: p.tone === 'live' && p.pct > 0 ? `${p.pct}%` : w(STATE_WORD[t.state] || 'dw.st.working') }
}
/** The line under a task's title: where it came from, then where it is (its steps, what it waits for, what it does). */
function lineOf(t, w, lang) {
  const where = t.waitingFor?.title ? w('dw.waitsFor', { what: t.waitingFor.title }) : stepsLine(t, lang) || t.step || t.result || ''
  return [w(`dw.src.${t.source}`), where].filter(Boolean).join(' · ')
}
const Track = ({ p }) => <span className={cx('ad-w-track', `ad-${p.tone}`)} aria-hidden="true"><i style={p.pct == null ? undefined : { width: `${p.pct}%` }} /></span>

/** The tasks of a view (active, waiting, all), at most `n`, and the counts of each state. */
function useTasks(view, n, lang, preview) {
  return usePoll(() => call('taskList', { ...VIEWS[view], limit: n, lang }), [view, n, lang], { off: preview })
}

export function TasksWidget({ size, lang, preview }) {
  const w = wordsOf(lang)
  const [view, setView] = useState('active')
  // (dragged taller, it shows more: as many rows as fit)
  const box = useRef(null), [rows, setRows] = useState(3)
  useLayoutEffect(() => {
    const el = box.current?.closest('.ad-w')
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { const h = el.style.height ? el.getBoundingClientRect().height : 0; setRows(h ? Math.max(3, Math.min(12, Math.floor((h - 96) / 48))) : 3) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const got = useTasks(view, rows, lang, preview)
  const list = preview ? SAMPLE : got?.tasks || [], c = preview ? { working: 2, waiting: 1 } : got?.counts || {}
  const working = (c.queued || 0) + (c.working || 0), waiting = (c.waiting || 0) + (c['to-confirm'] || 0)
  const expand = <button type="button" className="ad-w-ex" title={w('dw.expand')} aria-label={w('dw.expand')} onClick={() => !preview && openTasksWindow({ lang })}><Maximize2 size={13} /></button>
  if (size === 'sm') {
    return (
      <div ref={box}>
        <div className="ad-w-cap"><span>{w('dw.tasks')}</span>{expand}</div>
        <div className="ad-w-figs"><div><b>{working}</b><span>{w('dw.atWork')}</span></div><div><b className={waiting ? 'ad-wait' : undefined}>{waiting}</b><span>{w('dw.waiting')}</span></div></div>
        <div className="ad-dw-thin">{list.filter(t => AT_WORK_STATES.includes(t.state)).slice(0, 3).map(t => <Track key={t.id} p={progressOf(t)} />)}</div>
      </div>
    )
  }
  return (
    <div ref={box}>
      <div className="ad-w-cap"><span>{w('dw.tasks')}</span>
        <span className="ad-w-capr">
          <span className="ad-w-seg" role="group" aria-label={w('dw.tasks')}>
            {['active', 'all'].map(v => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{w(`dw.view.${v}`)}</button>)}
          </span>
          {expand}
        </span>
      </div>
      {!list.length && got && <p className="ad-w-p ad-w-quiet">{w(view === 'active' ? 'dw.noneActive' : 'dw.none')}</p>}
      {list.map(t => {
        const s = stateOf(t, w)
        return (
          <button key={t.id} type="button" className="ad-w-row" onClick={() => !preview && go({ task: t.id })}>
            <b>{t.title || t.id}</b><em className={`ad-${s.tone}`}>{s.word}</em>
            <small>{lineOf(t, w, lang)}</small>
            <Track p={s} />
          </button>
        )
      })}
      <div className="ad-w-foot"><span>{w('dw.sum', { a: working, b: waiting })}</span><button type="button" onClick={() => !preview && go({})}>{w('dw.page')}<ArrowUpRight size={12} /></button></div>
    </div>
  )
}

// the 任务 window: the same list, larger, with the waiting ones on a tab of their own
const WIN_CSS = `
.wb-tw { height: 100%; display: flex; flex-direction: column; color: var(--ruyix-text); font-family: var(--ruyix-font); }
.wb-tw-head { display: flex; align-items: center; gap: 10px; padding: 6px 18px 10px; }
.wb-tw-head h3 { margin: 0; font-size: var(--ruyix-text-lg); font-weight: var(--ruyix-weight-semibold); }
.wb-tw-head .wb-tw-sub { color: var(--ruyix-text-dim); font-size: var(--ruyix-text-xs); }
.wb-tw-head .wb-tw-grow { flex: 1; }
.wb-tw-seg { display: inline-flex; padding: 2px; border-radius: var(--ruyix-radius-sm); background: var(--ruyix-surface-sunk); }
.wb-tw-seg button { padding: 2px 10px; border-radius: var(--ruyix-radius-xs); font-size: var(--ruyix-text-xs); color: var(--ruyix-text-muted); background: none; border: 0; cursor: pointer; }
.wb-tw-seg button[aria-pressed="true"] { background: var(--ruyix-surface); color: var(--ruyix-text); box-shadow: 0 1px 2px rgb(0 0 0 / .12); }
.wb-tw-link { display: inline-flex; align-items: center; gap: 3px; font-size: var(--ruyix-text-xs); color: var(--ruyix-accent); background: none; border: 0; cursor: pointer; }
.wb-tw-list { flex: 1; overflow: auto; padding: 0 10px 10px; }
.wb-tw-row { display: grid; grid-template-columns: minmax(0, 1fr) 130px 64px; gap: 2px 16px; align-items: center; width: 100%; padding: 10px 8px; border: 0; border-radius: var(--ruyix-radius-sm); background: none; color: inherit; text-align: left; cursor: pointer; }
.wb-tw-row + .wb-tw-row { border-top: 1px solid var(--ruyix-line); }
.wb-tw-row:hover { background: var(--ruyix-hover); }
.wb-tw-row b { grid-column: 1; min-width: 0; font-size: var(--ruyix-text-sm); font-weight: var(--ruyix-weight-medium); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-tw-row small { grid-column: 1; min-width: 0; font-size: var(--ruyix-text-xs); color: var(--ruyix-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-tw-row .wb-tw-bar { grid-column: 2; grid-row: 1 / span 2; position: relative; height: 3px; border-radius: var(--ruyix-radius-pill); background: var(--ruyix-line); overflow: hidden; }
.wb-tw-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--ruyix-text-dim); transition: width .6s ease; }
.wb-tw-bar.ad-live > i { background: var(--ruyix-accent); } .wb-tw-bar.ad-wait > i { background: var(--ruyix-warning); } .wb-tw-bar.ad-bad > i { background: var(--ruyix-danger); }
.wb-tw-bar.ad-flow > i { position: absolute; top: 0; width: 34%; background: linear-gradient(90deg, transparent, var(--ruyix-accent), transparent); animation: wb-tw-flow 1.8s ease-in-out infinite alternate; }
@keyframes wb-tw-flow { from { left: -12%; } to { left: 78%; } }
.wb-tw-row em { grid-column: 3; grid-row: 1 / span 2; text-align: right; font-style: normal; font-size: var(--ruyix-text-xs); color: var(--ruyix-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.wb-tw-row em.ad-live { color: var(--ruyix-accent); } .wb-tw-row em.ad-wait { color: var(--ruyix-warning); } .wb-tw-row em.ad-bad { color: var(--ruyix-danger); }
.wb-tw-empty { padding: 28px 18px; color: var(--ruyix-text-dim); font-size: var(--ruyix-text-sm); }
@media (prefers-reduced-motion: reduce) { .wb-tw-bar.ad-flow > i { animation: none; left: 33%; } }
`
function TasksWindow({ lang }) {
  const w = wordsOf(lang)
  const [view, setView] = useState('active')
  const got = useTasks(view, 40, lang, false)
  const list = got?.tasks || [], c = got?.counts || {}
  const working = (c.queued || 0) + (c.working || 0), waiting = (c.waiting || 0) + (c['to-confirm'] || 0)
  return (
    <div className="wb-tw">
      <style>{WIN_CSS}</style>
      <div className="wb-tw-head">
        <h3>{w('dw.tasks')}</h3><span className="wb-tw-sub">{w('dw.sum', { a: working, b: waiting })}</span><span className="wb-tw-grow" />
        <span className="wb-tw-seg" role="group" aria-label={w('dw.tasks')}>
          {Object.keys(VIEWS).map(v => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{w(`dw.view.${v}`)}</button>)}
        </span>
        <button type="button" className="wb-tw-link" onClick={() => go({})}><ArrowUpRight size={12} />{w('dw.page')}</button>
      </div>
      <div className="wb-tw-list">
        {got && !list.length && <p className="wb-tw-empty">{w(view === 'all' ? 'dw.none' : view === 'waiting' ? 'dw.noneWaiting' : 'dw.noneActive')}</p>}
        {list.map(t => {
          const s = stateOf(t, w)
          return (
            <button key={t.id} type="button" className="wb-tw-row" onClick={() => go({ task: t.id })}>
              <b>{t.title || t.id}</b><small>{lineOf(t, w, lang)}</small>
              <span className={cx('wb-tw-bar', `ad-${s.tone}`)} aria-hidden="true"><i style={s.pct == null ? undefined : { width: `${s.pct}%` }} /></span>
              <em className={`ad-${s.tone}`}>{s.word}</em>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Open the 任务 window on the desk (the shell's window.__ruyixDesk); without a desk, the 任务 page. */
export function openTasksWindow({ lang = 'zh', desk = globalThis.window?.__ruyixDesk } = {}) {
  if (!desk?.open) return go({})
  const w = wordsOf(lang)
  desk.open({
    // (in the desk's language: the page can change it while the window is open)
    id: 'ruyix-tasks-window', title: w('dw.tasks'), names: namesOf('dw.tasks'), icon: ListChecks, Content: ({ lang: now }) => <TasksWindow lang={now || lang} />, props: {}, size: { w: 600, h: 420 },
    reopen: { event: TASKS_WINDOW, detail: {} }, kind: 'page', hint: w('dw.tasks'),
  })
}

// ── 今天 ──

const SAMPLE_TODAY = { tasks: 6, tokens: 1.2e6, cost: 3.42, hours: [27, 25, 26, 20, 21, 14, 16, 9, 12, 6, 10, 4].map((y, i) => ({ at: i, tokens: (30 - y) * 1e4 })) }

/** The last hours' tokens as a line, the hour now a dot. */
function Spark({ hours, label }) {
  const max = Math.max(1, ...hours.map(h => h.tokens)), n = hours.length
  const pts = hours.map((h, i) => [n > 1 ? (220 * i) / (n - 1) : 110, 28 - (26 * h.tokens) / max])
  const end = pts[pts.length - 1] || [220, 28]
  return (
    <svg className="ad-w-spark" viewBox="0 0 220 30" preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={`M${pts.map(p => p.map(v => v.toFixed(1)).join(' ')).join('L')}`} />
      <circle cx={end[0]} cy={end[1]} r="2.4" />
    </svg>
  )
}

export function TodayWidget({ size, lang, preview }) {
  const w = wordsOf(lang)
  const got = usePoll(() => call('today', { since: midnight(), hours: 12 }), [], { every: 60e3, off: preview })
  const d = preview ? SAMPLE_TODAY : got
  if (!d) return <div className="ad-w-cap"><span>{w('dw.today')}</span></div>
  const cost = d.cost == null ? '—' : d.cost > 0 ? money(d.cost) : currency().code === 'cny' ? '¥0' : '$0'
  const now = new Date()
  if (size === 'sm') {
    return (
      <>
        <div className="ad-w-cap"><span>{w('dw.today')}</span></div>
        <div className="ad-w-figs"><div><b>{kfmt(d.tokens)}</b><span>tokens</span></div></div>
        <div className="ad-w-kv"><span>{w('dw.cost')}</span><b>{cost}</b></div>
        <div className="ad-w-kv"><span>{w('dw.tasksToday')}</span><b>{d.tasks}</b></div>
      </>
    )
  }
  return (
    <>
      <div className="ad-w-cap"><span>{w('dw.today')}</span><small>{w('dw.until', { t: `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}` })}</small></div>
      <div className="ad-w-figs">
        <div><b>{d.tasks}</b><span>{w('dw.tasksToday')}</span></div>
        <div><b>{cost}</b><span>{w('dw.cost')}</span></div>
        <div><b>{kfmt(d.tokens)}</b><span>tokens</span></div>
      </div>
      <Spark hours={d.hours || []} label={w('dw.curve')} />
      <div className="ad-w-foot"><span>{w('dw.curve')}</span><button type="button" onClick={() => !preview && go({ tab: 'ruyix-workbench-metrics' })}>{w('dw.metrics')}<ArrowUpRight size={12} /></button></div>
    </>
  )
}

/** The two widgets as the desk takes them (window.__ruyixWidgetDefs; the shell's widgets.jsx). */
export const DESK_WIDGETS = [
  { type: 'workbench:tasks', name: { zh: '任务', en: 'Tasks' }, sizes: ['sm', 'md'], default: 'md', order: 10, render: TasksWidget },
  { type: 'workbench:today', name: { zh: '今天', en: 'Today' }, sizes: ['sm', 'md'], default: 'md', order: 30, render: TodayWidget },
]

/** The few styles of its own the widgets need beside the desk's shared ones. */
export const DESK_CSS = `.ad-dw-thin { display: grid; gap: 6px; margin-top: 12px; }`
