// Work in progress, wherever the person is: the runs going now — each a runway of its steps, the agent at work running
// along it, who works on it and how long, or that it waits for them — and what just finished. In the shell's top bar (a
// ring while something is going, amber when the person is waited for; its menu lists them) and as a desktop widget.
// A click opens the run on its process. Drawn in the shell's spaces: its own words and styles (WORK_CSS), the shell's
// colours (--ad-*).
import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, CalendarClock, CheckCircle2, Hand, PauseCircle, XCircle } from 'lucide-react'
import { OPEN, exts, useNow, useWbStore } from './data.js'
import { en, zh } from './locale.js'
import { ACTIVE, dur } from './ui.jsx'
import { blocksOf } from './activity.js'
import { repeats } from './tasks.jsx'

const cx = (...c) => c.filter(Boolean).join(' ')
const fmt = (s, p = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] ?? m))
/** The words in the person's language: a pack's first (its steps' names), then the workbench's. */
const wordsOf = lang => (key, params) => {
  const z = lang === 'zh'
  for (const e of Object.values(exts())) { const v = e?.locale?.[z ? 'zh' : 'en']?.[key]; if (v !== undefined) return fmt(v, params) }
  const v = (z ? zh : en)[key] ?? OWN[z ? 'zh' : 'en'][key]
  return v === undefined ? null : fmt(v, params)
}
const OWN = { zh: { 'wk.finished': '完成', 'wk.next': '接下来' }, en: { 'wk.finished': 'done', 'wk.next': 'Coming up' } }
const stepName = (w, r, key) => w(`stage.${key}`) || r.stages.find(s => s.key === key)?.title || key
const open = (id, tab = 'pipeline') => window.dispatchEvent(new CustomEvent(OPEN, { detail: { run: id, tab } }))

/** The runs as the tray and the widget show them: going (those waiting for the person first), then the last finished. */
function useWork() {
  const [store] = useWbStore()
  const runs = [...store.run.values()].filter(r => !r.archivedAt)
  const cards = [...store.approval.values()].filter(a => ['pending', 'failed'].includes(a.status))
  const waitsOf = r => cards.filter(a => a.runId === r.id && (a.payload?.blocking || a.action === 'help'))
  const going = runs.filter(r => ACTIVE.has(r.status)).map(r => ({ r, waits: r.status === 'waiting' ? waitsOf(r) : [] }))
    .sort((a, b) => (b.waits.length > 0) - (a.waits.length > 0) || b.r.createdAt - a.r.createdAt)
  // a run that just got done crosses the line on its runway for a few seconds (and then is among those just finished)
  const finishing = runs.filter(r => r.status === 'done' && r.endedAt && Date.now() - r.endedAt < 8000)
  const recent = runs.filter(r => !ACTIVE.has(r.status) && r.endedAt && Date.now() - r.endedAt < 864e5 && !finishing.includes(r)).sort((a, b) => b.endedAt - a.endedAt).slice(0, 3)
  // cards of finished runs that still wait (a publish card): the person's too
  const cardsLeft = cards.filter(a => !going.some(g => g.r.id === a.runId) && runs.some(r => r.id === a.runId)).length
  // the scheduled tasks not running now: when each runs next (the soonest first)
  const upcoming = [...(store.task?.values() || [])].filter(t => repeats(t) && t.enabled && !t.archivedAt && t.nextAt && !going.some(g => g.r.taskId === t.id)).sort((a, b) => a.nextAt - b.nextAt)
  return { going, recent, finishing, upcoming, waiting: going.filter(g => g.waits.length).length + cardsLeft, ready: store.ready }
}

// ── a run as a runway: its steps are stretches of track, a runner carries the agent at work ──
const KIND_COLOR = { claude: '#ff9f6b', codex: '#5ec8ff', dsh: '#a493ff', model: '#a493ff', system: '#9fb0c2', person: '#f5b335' }
const kindOf = (s, waits) => (waits ? 'person' : !s || s.owner === 'system' ? 'system' : s.agent?.runtime === 'claude' ? 'claude' : s.agent?.runtime === 'codex' ? 'codex' : s.agent?.runtime ? 'dsh' : 'model')
/** An agent's kind as a small icon (the same shapes as the desk's lights). */
function KindIcon({ kind }) {
  const p = { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (kind === 'claude') return <svg {...p}><path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M5.6 18.4l3.5-3.5M14.9 9.1l3.5-3.5" /></svg>
  if (kind === 'codex') return <svg {...p}><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /></svg>
  if (kind === 'person') return <Hand size={11} />
  if (kind === 'system') return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>
  return <svg {...p}><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" /><ellipse cx="12" cy="12" rx="9" ry="4" /></svg>
}
/** The pulses of the agents at work (window.__ruyixActivity): `<run>:<step>` → when it last did something. */
function usePulses() {
  const [p, setP] = useState(() => new Map())
  useEffect(() => {
    const on = () => setP(new Map((window.__ruyixActivity?.agents || []).filter(a => a.pulse?.at).map(a => [a.id, a.pulse.at])))
    window.addEventListener('ruyix:activity', on); on()
    return () => window.removeEventListener('ruyix:activity', on)
  }, [])
  return p
}
/** A parallel block's lane as one status: at work while one of its steps is, failed, done when all are, else to come. */
const laneOf = (r, keys) => {
  const ss = keys.map(k => r.stages.find(s => s.key === k)).filter(Boolean)
  return ss.some(s => s.status === 'running') ? 'run' : ss.some(s => s.status === 'failed') ? 'fail' : ss.length && ss.every(s => ['passed', 'skipped'].includes(s.status)) ? 'done' : 'todo'
}
const segOf = (r, s) => (s.status === 'running' ? (r.status === 'waiting' && (s.asking || s.key === r.stage) ? 'wait' : 'run') : s.status === 'passed' ? 'done' : s.status === 'failed' ? 'fail' : s.status === 'skipped' ? 'skip' : 'todo')

/**
 * One run's runway: a stretch of track per step (done, at work, waiting for the person, failed, skipped, to come); the
 * runner — the agent at work, its icon — moves on while the step works (easing towards the end of its stretch: it never
 * claims the step is done), sparks at each thing it does, stops amber when the person is waited for; a run just over
 * crosses the line.
 */
function Lane({ g, w, now, compact, pulses }) {
  const { r, waits, finishing } = g
  // a parallel block is one stretch, its lanes side by side in it (their steps are not stretches of their own)
  const blocks = blocksOf(r), inLane = new Set([...blocks.values()].flat(2))
  const top = r.stages.filter(x => !inLane.has(x.key))
  const n = top.length || 1
  const i = finishing ? n - 1 : Math.max(0, top.findIndex(x => x.key === r.stage || x.status === 'running'))
  const s = blocks.has(top[i]?.key) ? r.stages.find(x => blocks.get(top[i].key).flat().includes(x.key) && x.status === 'running') || top[i] : top[i]
  const waiting = waits.length > 0
  const label = top[i] && blocks.has(top[i].key) ? stepName(w, r, top[i].key) : s ? stepName(w, r, s.key) : ''
  const elapsed = s?.startedAt ? now - s.startedAt : 0
  const part = finishing ? 1 : waiting ? 0.5 : Math.min(0.9, 1 - Math.exp(-elapsed / 90000)) * 0.9 + 0.05
  const at = ((i + part) / n) * 100
  const kind = finishing ? 'done' : kindOf(s, waiting)
  const pulse = s && pulses.get(`${r.id}:${s.key}`)
  const who = s?.agent?.id || (s?.owner && s.owner !== 'system' ? s.owner : '')
  return (
    <button type="button" className={cx('wk-lane', waiting && 'wk-lane-wait', finishing && 'wk-lane-done')} onClick={() => open(r.id, waiting ? 'approvals' : finishing ? 'overview' : 'pipeline')}>
      <span className="wk-row-top"><b>{r.subject?.title || r.template}</b><span className="wk-time">{finishing ? w('wk.finished') : dur(now - r.createdAt)}</span></span>
      <span className="wk-track" style={{ '--wk-c': KIND_COLOR[kind] || '#30a46c' }}>
        {top.map(x => blocks.has(x.key)
          ? <i key={x.key} className="wk-seg wk-seg-block" title={stepName(w, r, x.key)}>{blocks.get(x.key).map((keys, k) => <b key={k} className={cx('wk-seg-lane', `wk-seg-${finishing ? 'done' : laneOf(r, keys)}`)} />)}</i>
          : <i key={x.key} className={cx('wk-seg', `wk-seg-${finishing ? 'done' : segOf(r, x)}`)} title={stepName(w, r, x.key)} />)}
        <span className={cx('wk-runner', waiting && 'wk-runner-wait', finishing && 'wk-runner-done')} style={{ left: `${at}%` }}>
          {finishing ? <CheckCircle2 size={11} /> : <KindIcon kind={kind} />}
          {pulse && now - pulse < 1500 && <i key={pulse} className="wk-spark" />}
        </span>
        {finishing && <span className="wk-finish" />}
      </span>
      {!finishing && (
        <span className="wk-row-now">
          {waiting
            ? <><Hand size={11} />{w('wk.waits', { what: waits[0].title }) || waits[0].title}</>
            : s ? <><span className="wk-pulse" />{label}{!compact && who && <em> · {who}</em>}{s.startedAt && <em> · {dur(elapsed)}</em>}</> : w(`status.${r.status}`)}
        </span>
      )}
    </button>
  )
}

/** A scheduled task not running now: when it runs next, a line that fills as the time comes. */
function Next({ t, now }) {
  const from = Math.min(t.lastAt || t.createdAt || now, now), span = Math.max(1, t.nextAt - from)
  const k = Math.min(1, Math.max(0, (now - from) / span))
  return (
    <button type="button" className="wk-next" onClick={() => window.dispatchEvent(new CustomEvent(OPEN, { detail: { task: t.id } }))}>
      <span className="wk-row-top"><b><CalendarClock size={12} />{t.title}</b><span className="wk-time">{dur(Math.max(0, t.nextAt - now))}</span></span>
      <span className="wk-next-bar"><i style={{ width: `${k * 100}%` }} /></span>
    </button>
  )
}

export function WorkList({ lang, compact = false, limit = 6 }) {
  const w = wordsOf(lang)
  const now = useNow(1000)
  const pulses = usePulses()
  const { going, recent, finishing, upcoming, ready } = useWork()
  if (!ready) return <p className="wk-quiet">…</p>
  const lanes = [...finishing.map(r => ({ r, waits: [], finishing: true })), ...going]
  return (
    <div className="wk-list">
      {lanes.slice(0, limit).map(g => <Lane key={g.r.id} g={g} w={w} now={now} compact={compact} pulses={pulses} />)}
      {!lanes.length && !upcoming.length && <p className="wk-quiet">{w('wk.idle')}</p>}
      {upcoming.length > 0 && (!compact || !lanes.length) && (
        <>
          {lanes.length > 0 && <div className="wk-cap">{w('wk.next')}</div>}
          {upcoming.slice(0, compact ? 1 : 3).map(t => <Next key={t.id} t={t} now={now} />)}
        </>
      )}
      {!compact && recent.length > 0 && (
        <>
          <div className="wk-cap">{w('wk.recent')}</div>
          {recent.map(r => {
            const ok = r.status === 'done' && r.verdict?.level !== 'failed', cut = r.status === 'interrupted'
            return (
              <button key={r.id} type="button" className="wk-done" onClick={() => open(r.id, cut ? 'pipeline' : 'overview')} title={w(`status.${r.status}`) || r.status}>
                {ok ? <CheckCircle2 size={12} className="wk-ok" /> : cut ? <PauseCircle size={12} className="wk-cut" /> : <XCircle size={12} className="wk-bad" />}
                <span>{r.subject?.title || r.template}</span><em>{w('ago', { t: dur(now - r.endedAt) })}</em>
              </button>
            )
          })}
        </>
      )}
    </div>
  )
}

/** The tray's indicator: a ring and a count while runs go, amber when something waits for the person; its menu, the list. */
export function WorkTray({ lang }) {
  const w = wordsOf(lang)
  const { going, waiting } = useWork()
  const [shown, setShown] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!shown) return
    const off = e => { if (!box.current?.contains(e.target)) setShown(false) }, gone = () => setShown(false)
    window.addEventListener('pointerdown', off, true)
    window.addEventListener(OPEN, gone)
    return () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener(OPEN, gone) }
  }, [shown])
  if (!going.length && !waiting) return null
  return (
    <span ref={box} className="wk-tray">
      <button type="button" className={cx('ad-bar-ind', 'wk-ind', waiting && 'wk-ind-wait')} aria-expanded={shown} title={w('wk.title')} onClick={() => setShown(v => !v)}>
        {going.length > 0 && <span className="ad-ring" />}
        {waiting > 0 ? <><Hand size={13} />{waiting}</> : going.length}
      </button>
      {shown && (
        <div className="ad-menu wk-menu" role="menu">
          <div className="wk-menu-head"><b>{w('wk.title')}</b><span>{w('wk.sum', { n: going.length, m: waiting })}</span></div>
          <WorkList lang={lang} />
          <button type="button" className="ad-mi" onClick={() => { setShown(false); window.dispatchEvent(new CustomEvent(OPEN, { detail: { view: 'runs', scope: 'active' } })) }}><ArrowUpRight size={14} />{w('wk.all')}</button>
        </div>
      )}
    </span>
  )
}

export const WORK_CSS = `
.wk-tray { position: relative; display: inline-flex; }
.wk-ind { font-size: 12px; font-weight: 600; color: var(--ad-text); }
.wk-ind-wait { color: light-dark(#a15c00, #ffc56b); background: color-mix(in srgb, #f5a524 18%, transparent); }
.wk-ind-wait:hover { background: color-mix(in srgb, #f5a524 28%, transparent); }
.wk-menu { right: 0; left: auto; width: 340px; max-width: min(340px, calc(var(--ad-vw, 100vw) - 16px)); position: absolute; top: calc(100% + 6px); }
.wk-menu-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 6px 10px 8px; }
.wk-menu-head span { font-size: 12px; color: var(--ad-text-3); }
.wk-list { display: flex; flex-direction: column; gap: 2px; }
.wk-row-top { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
.wk-row-top b { font-size: 13px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk-time { flex: none; font-size: 11px; color: var(--ad-text-3); font-variant-numeric: tabular-nums; }
.wk-lane { display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 8px 10px 9px; border: 0; border-radius: var(--ruyix-radius); background: none; color: var(--ad-text); text-align: left; cursor: pointer; font: inherit; }
.wk-lane:hover { background: var(--ad-fill-2); }
.wk-lane-wait { background: color-mix(in srgb, #f5a524 12%, transparent); }
.wk-track { position: relative; display: flex; gap: 3px; height: 8px; margin: 4px 0 2px; }
.wk-seg { position: relative; flex: 1 1 0; border-radius: var(--ruyix-radius-pill); corner-shape: round; background: var(--ad-hair-2, rgba(128,128,128,.28)); overflow: hidden; }
.wk-seg-block { display: flex; flex-direction: column; gap: 1px; background: none; overflow: visible; }
.wk-seg-lane { position: relative; flex: 1 1 0; border-radius: var(--ruyix-radius-pill); corner-shape: round; background: var(--ad-hair-2, rgba(128,128,128,.28)); overflow: hidden; }
.wk-seg-done { background: color-mix(in srgb, #30a46c 75%, transparent); }
.wk-seg-fail { background: #e5484d; } .wk-seg-skip { opacity: .35; }
.wk-seg-run { background: color-mix(in srgb, var(--wk-c) 35%, var(--ad-hair-2, rgba(128,128,128,.28))); }
.wk-seg-run::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--wk-c) 85%, white 15%), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: wk-flow 1.6s linear infinite; }
.wk-seg-wait { background: color-mix(in srgb, #f5a524 70%, transparent); animation: wk-breathe 1.8s ease-in-out infinite; }
@keyframes wk-flow { from { background-position: -50% 0; } to { background-position: 150% 0; } }
@keyframes wk-breathe { 50% { opacity: .5; } }
.wk-runner { position: absolute; top: 50%; width: 20px; height: 20px; margin-left: -10px; margin-top: -10px; border-radius: 50%; corner-shape: round; display: grid; place-items: center; color: #fff; z-index: 1;
  background: color-mix(in srgb, var(--wk-c) 70%, #11131a); box-shadow: 0 0 0 1.5px var(--wk-c), 0 0 14px var(--wk-c); transition: left 1s linear; }
.wk-runner-wait { --wk-c: #f5a524; animation: wk-wait 1.6s ease-in-out infinite; }
@keyframes wk-wait { 50% { box-shadow: 0 0 0 2px var(--wk-c), 0 0 22px var(--wk-c); } }
.wk-runner-done { --wk-c: #30a46c; }
.wk-spark { position: absolute; inset: -4px; border-radius: 50%; corner-shape: round; border: 2px solid var(--wk-c); animation: wk-spark .9s ease-out forwards; pointer-events: none; }
@keyframes wk-spark { from { transform: scale(.7); opacity: 1; } to { transform: scale(2.2); opacity: 0; } }
.wk-finish { position: absolute; inset: -3px -2px; border-radius: var(--ruyix-radius-sm); background: linear-gradient(90deg, transparent, rgba(255,255,255,.65), transparent); background-size: 40% 100%; background-repeat: no-repeat; animation: wk-sweep 1.4s ease-out 2; pointer-events: none; }
@keyframes wk-sweep { from { background-position: -40% 0; } to { background-position: 140% 0; } }
.wk-row-now { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ad-text-2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wk-row-now em { font-style: normal; color: var(--ad-text-3); }
.wk-lane-wait .wk-row-now { color: light-dark(#a15c00, #ffc56b); font-weight: 600; }
.wk-pulse { width: 6px; height: 6px; border-radius: 50%; corner-shape: round; flex: none; background: var(--ruyix-accent); box-shadow: 0 0 0 0 color-mix(in srgb, var(--ruyix-accent) 60%, transparent); animation: wk-ping 1.6s ease-out infinite; }
@keyframes wk-ping { 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.wk-next { display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 7px 10px 8px; border: 0; border-radius: var(--ruyix-radius); background: none; color: var(--ad-text); text-align: left; cursor: pointer; font: inherit; }
.wk-next:hover { background: var(--ad-fill-2); }
.wk-next b { display: inline-flex; align-items: center; gap: 5px; }
.wk-next b svg { flex: none; color: var(--ruyix-accent); }
.wk-next-bar { position: relative; height: 3px; border-radius: var(--ruyix-radius-pill); corner-shape: round; background: var(--ad-hair-2, rgba(128,128,128,.28)); overflow: hidden; }
.wk-next-bar i { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: linear-gradient(90deg, color-mix(in srgb, var(--ruyix-accent) 40%, transparent), var(--ruyix-accent)); }
.ad-w .wk-next { padding-left: 0; padding-right: 0; }
.ad-w .wk-next:hover { background: none; }
.wk-cap { padding: 8px 10px 2px; font-size: 11px; color: var(--ad-text-3); }
.wk-done { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 10px; border: 0; border-radius: var(--ruyix-radius-xs); background: none; color: var(--ad-text-2); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.wk-done:hover { background: var(--ad-fill-2); }
.wk-done span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk-done em { font-style: normal; color: var(--ad-text-3); font-size: 11px; }
.wk-ok { color: #30a46c; flex: none; } .wk-bad { color: #e5484d; flex: none; } .wk-cut { color: #f5a524; flex: none; }
.wk-quiet { margin: 4px 10px; font-size: 12px; color: var(--ad-text-3); }
.ad-w .wk-lane, .ad-w .wk-done { padding-left: 0; padding-right: 0; }
.ad-w .wk-lane:hover, .ad-w .wk-done:hover { background: none; }
.ad-w .wk-lane-wait { background: none; }
.ad-w .wk-quiet { margin: 4px 0; }
.wk-cap-wait { display: inline-flex; align-items: center; gap: 3px; color: light-dark(#a15c00, #ffc56b); font-weight: 600; }
@media (prefers-reduced-motion: reduce) { .wk-seg-run::after, .wk-seg-wait, .wk-runner-wait, .wk-spark, .wk-finish, .wk-pulse { animation: none; } .wk-runner { transition: none; } }
`
