// The work going on, as live activities (docs/design/agent-work.md §2–3): one lane for each thing at work — a run, a
// session, a pool task — that says at a glance that it is alive and what state it is in. Its colour is its state (at
// work the accent, waiting amber, trouble red), with its mark (the step ring), title, step and the time it has been at
// it, ticking each second so a quiet spell never looks stuck. Under it one line per agent: the newest brightest and
// biggest, a shimmer sweeping it while that agent is at it; the one before floats up, shrinks and fades. A tool call in
// mono, what an agent says in the body face, a failed one red; each agent its colour (./agents.js). Waiting for the
// person: amber and still, one line saying what to do, one click to it. A click on a lane opens it: who talks to whom
// in it (./collab.jsx, from its `links` and `peers`), the main model's summary so far (the registry's summarize), its
// recent lines, a way in. Done, a lane becomes a note: made it or not,
// the outcome in a line, a thumbnail; 「看结果」 and 「擦掉」 (seen: the registry's seen hook). Lines and outcomes are the
// producers' (`lines`, `outcome` on each work item); without them a lane says its state and step.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ExternalLink, MessageCircle, X } from 'lucide-react'
import { workRegistry } from '../work.js'
import { agentColor } from './agents.js'
import { CollabGraph } from './collab.jsx'
import { WorkMark, openWork, useWork } from './workmark.jsx'
import { textOf } from './text.js'

const cx = (...c) => c.filter(Boolean).join(' ')
const LIVE = new Set(['queued', 'working', 'waiting'])
const mins = (a, b) => Math.max(0, Math.round((b - a) / 60000))
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The lanes and the notes of a work list: lanes at work (most pressing first), notes done or gone wrong and not seen. */
export function laneOf(list) {
  const lanes = list.filter(w => LIVE.has(w.state))
  const notes = list.filter(w => ['done', 'failed', 'stopped'].includes(w.state) && !w.seen)
  return { lanes, notes }
}
/**
 * A lane's lines by agent: [{ agent: { id, kind, name }, lines: [newest last] }] — every agent of the item, then any
 * a line names that the item does not list; at most `keep` lines each. No lines at all: the state says it.
 */
export function linesByAgent(item, keep = 2) {
  const agents = [...(item.agents || [])]
  for (const l of item.lines || []) if (l.agent && !agents.some(a => a.id === l.agent)) agents.push({ id: l.agent, kind: 'model' })
  const rows = agents.map(a => ({ agent: a, lines: (item.lines || []).filter(l => l.agent === a.id).sort((x, y) => x.at - y.at).slice(-keep) }))
  const loose = (item.lines || []).filter(l => !l.agent)
  if (loose.length) rows.push({ agent: { id: '', kind: 'system' }, lines: loose.sort((x, y) => x.at - y.at).slice(-keep) })
  return rows.filter(r => r.lines.length || (item.agents || []).includes(r.agent))
}
/** What a lane says with no lines of its own: its state and step. */
function stateLine(item, T) {
  const segs = item.segs || [], cur = Number.isInteger(item.cur) && item.cur >= 0 ? item.cur : segs.findIndex(s => s.st === 'run' || s.st === 'wait')
  const step = segs[cur]?.title || ''
  return item.state === 'waiting' ? T.waitFor(step || item.title) : item.state === 'queued' ? T.queued : step ? T.doing(step) : T.working
}

/** How long it has been at it, ticking each second (minutes and seconds; past an hour h:mm:ss) — only this redraws. */
function Elapsed({ since, T }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0')
  return <span className="ad-ly-time">{h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : T.elapsed(m, ss)}</span>
}

function Line({ line, old, live }) {
  // a line that moved within its column (the one above it gone, a new one under it) glides from where it was
  const el = useRef(null), top = useRef(null)
  useLayoutEffect(() => {
    const e = el.current
    if (!e) return
    const y = e.offsetTop - e.parentElement.offsetTop
    if (top.current != null && top.current !== y && !reduced()) e.animate([{ transform: `translateY(${top.current - y}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.2, .8, .2, 1)' })
    top.current = y
  })
  return (
    <span ref={el} className={cx('ad-ly-line', `ad-ly-${line.kind || 'say'}`, old && 'ad-ly-old', live && !old && 'ad-ly-live', line.ok === false && 'ad-ly-bad')} title={line.text}>
      {line.text}
    </span>
  )
}

/** One lane: its head (mark, title, step, time) and its agents' lines; open: the summary, every recent line, a way in. */
/** The studios' names by id (window.__ruyixStudios, kept by the studio plugin; 'ruyix:studio' when they change). */
function useStudioNames(lang) {
  const read = () => Object.fromEntries((window.__ruyixStudios || []).map(s => [s.id, typeof s.name === 'string' ? s.name : s.name?.[lang] || s.name?.zh || s.name?.en || s.id]))
  const [names, setNames] = useState(read)
  useEffect(() => { const on = () => setNames(read()); window.addEventListener('ruyix:studio', on); return () => window.removeEventListener('ruyix:studio', on) }, [lang])
  return names
}
const studioOf = item => (typeof item.studio === 'string' ? item.studio : item.studio?.id) || null

function Lane({ item, T, lang, open, onToggle, chip }) {
  const segs = item.segs || [], cur = Number.isInteger(item.cur) && item.cur >= 0 ? item.cur : segs.findIndex(s => s.st === 'run' || s.st === 'wait')
  const rows = linesByAgent(item)
  const [summary, setSummary] = useState({ id: null, text: '', busy: false })
  useEffect(() => {
    if (!open || summary.id === item.id) return
    const reg = workRegistry()
    if (typeof reg.summarize !== 'function') return setSummary({ id: item.id, text: '', busy: false })
    setSummary({ id: item.id, text: '', busy: true })
    Promise.resolve(reg.summarize(item.id)).then(t => setSummary({ id: item.id, text: typeof t === 'string' ? t : '', busy: false }), () => setSummary({ id: item.id, text: '', busy: false }))
  }, [open, item.id])
  // the shimmer: on what is being done right now — a line marked live (the tool it is in), else the lane's newest line
  // (with no lines, its one state line); only while at work
  const lines = item.lines || [], working = item.state === 'working'
  const newest = lines.reduce((m, l) => Math.max(m, l.at || 0), 0), anyLive = lines.some(l => l.live)
  const isLive = l => working && l.kind !== 'wait' && l.ok !== false && (anyLive ? !!l.live : l.at === newest)
  // trouble: its newest line failed
  const trouble = working && lines.length > 0 && lines.reduce((a, b) => ((b.at || 0) >= (a.at || 0) ? b : a)).ok === false
  // waiting for the person: what to do, in one line (the newest wait line, else what it waits on, else the step); a
  // discussion (wait.kind 'chat') with a chat bubble and 「去讨论」
  const chat = item.state === 'waiting' && item.wait?.kind === 'chat'
  const waitText = item.wait?.title ? (chat ? T.chatFor(item.wait.title) : T.waitFor(item.wait.title)) : stateLine(item, T)
  const wait = item.state === 'waiting' && ([...lines].filter(l => l.kind === 'wait').sort((a, b) => a.at - b.at).pop() || { text: waitText, kind: 'wait' })
  const waiter = wait && (item.agents || []).find(a => a.id === wait.agent)
  const step = segs.length > 1 && cur >= 0 ? `${cur + 1}/${segs.length}` : ''
  return (
    <div className={cx('ad-ly-lane', `ad-ly-is-${item.state}`, trouble && 'ad-ly-trouble', open && 'ad-ly-open')}>
      <button type="button" className="ad-ly-head" onClick={onToggle} aria-expanded={open}>
        <WorkMark item={item} size={22} />
        <span className="ad-ly-title">{chip && <i className="ad-ly-studio">{chip}</i>}{item.title || T.kinds[item.kind] || item.id}</span>
        <span className="ad-ly-meta">{step}{step && item.startedAt ? ' · ' : ''}{item.startedAt ? <Elapsed since={item.startedAt} T={T} /> : null}</span>
        <ChevronDown size={13} className="ad-ly-chev" aria-hidden="true" />
      </button>
      <div className="ad-ly-rows">
        {wait ? (
          <div className="ad-ly-row ad-ly-waitrow" style={{ '--ad-ly-c': agentColor(waiter?.kind) }}>
            {chat && <MessageCircle size={14} strokeWidth={2.2} className="ad-ly-chat" aria-hidden="true" />}
            {waiter && <b className="ad-ly-who">{waiter.name || T.agentKinds[waiter.kind] || waiter.kind}</b>}
            <span className="ad-ly-lines"><span className="ad-ly-line ad-ly-wait" title={wait.text}>{wait.text}</span></span>
            <button type="button" className="ad-ly-act" onClick={() => openWork(item)}>{chat ? T.goChat : T.goDo}</button>
          </div>
        ) : rows.length ? rows.map(r => (
          <div key={r.agent.id || 'loose'} className="ad-ly-row" style={{ '--ad-ly-c': agentColor(r.agent.kind) }}>
            <b className="ad-ly-who">{r.agent.name || T.agentKinds[r.agent.kind] || r.agent.kind}</b>
            <span className="ad-ly-lines">
              {r.lines.length ? r.lines.map((l, i) => <Line key={`${l.at}:${l.text}`} line={l} old={i < r.lines.length - 1} live={isLive(l)} />)
                : <Line line={{ text: r.agent.step ? T.doing(r.agent.step) : stateLine(item, T), kind: 'say' }} live={working && !newest && r === rows[0]} />}
            </span>
          </div>
        )) : (
          <div className="ad-ly-row"><span className="ad-ly-lines"><Line line={{ text: stateLine(item, T), kind: 'say' }} live={working} /></span></div>
        )}
      </div>
      {open && (
        <div className="ad-ly-more">
          {(item.links || []).length > 0 && <CollabGraph agents={[...(item.agents || []), ...(item.peers || [])]} links={item.links} lang={lang} />}
          {summary.busy ? <p className="ad-ly-sum ad-ly-busy">{T.summarizing}</p> : summary.text ? <p className="ad-ly-sum">{summary.text}</p> : null}
          {(item.lines || []).length > 0 && (
            <ol className="ad-ly-all">
              {[...item.lines].sort((a, b) => a.at - b.at).slice(-12).map((l, i) => {
                const a = (item.agents || []).find(x => x.id === l.agent)
                return <li key={i} className={cx(`ad-ly-${l.kind || 'say'}`, l.ok === false && 'ad-ly-bad')} style={{ '--ad-ly-c': agentColor(a?.kind) }}><b>{a?.name || T.agentKinds[a?.kind] || ''}</b>{l.text}</li>
              })}
            </ol>
          )}
          {item.open?.event && <button type="button" className="ad-ly-go" onClick={() => openWork(item)}><ExternalLink size={12} />{T.openIt}</button>}
        </div>
      )}
    </div>
  )
}

/** A note: a thing done (or gone wrong, or stopped) and not seen yet — the outcome in a line, a thumbnail, look or wipe. */
function Note({ item, T, now, onWipe }) {
  const o = item.outcome || {}, ok = o.ok ?? (item.state === 'done' && item.ok !== false)
  const look = () => { if (o.open?.event) window.dispatchEvent(new CustomEvent(o.open.event, { detail: o.open.detail })); else openWork(item) }
  return (
    <div className={cx('ad-dn-w', ok ? 'ad-dn-ok' : 'ad-dn-bad')}>
      {o.thumb && <img className="ad-dn-thumb" src={o.thumb} alt="" loading="lazy" />}
      <div className="ad-dn-text">
        <b><i className="ad-dn-dot" aria-hidden="true" />{item.title || T.kinds[item.kind] || item.id}</b>
        <span>{o.text || (ok ? T.doneOk : item.state === 'stopped' ? T.stopped : T.doneBad)}</span>
        <small>{item.endedAt ? T.ago(mins(item.endedAt, now)) : ''}</small>
      </div>
      <div className="ad-dn-act">
        <button type="button" onClick={look} title={T.look}><Check size={12} />{T.look}</button>
        <button type="button" onClick={() => onWipe(item)} title={T.wipeHint} aria-label={T.wipe}><X size={12} /></button>
      </div>
    </div>
  )
}

/**
 * The strip: the lanes at work (at most `lanes`; the rest folded into "N more"), the notes under them (at most `notes`).
 * `variant`: 'desk' (the widgets column's top), 'map' (under the map's cards), 'page' (in a page: a studio's 在做, with
 * `filter` — the look of the page, no studio chip). Each lane of a studio's work names the studio. `empty`: what shows
 * when there is nothing (else nothing). Exported as @ruyix/shell/strip.
 */
export function WorkStrip({ lang, lanes: maxLanes = 3, notes: maxNotes = 3, variant = 'desk', filter = null, empty = null }) {
  const T = textOf(lang).strip, every = useWork(), now = useMinute(), studios = useStudioNames(lang)
  const list = useMemo(() => (filter ? every.filter(filter) : every), [every, filter])
  const { lanes, notes } = useMemo(() => laneOf(list), [list])
  const [open, setOpen] = useState(null), [all, setAll] = useState(false), [allNotes, setAllNotes] = useState(false)
  // wiped here before the producer's answer comes back (and when one has no seen hook: until a reload)
  const [wiped, setWiped] = useState(() => new Set())
  const shownNotes = notes.filter(n => !wiped.has(n.id))
  if (!lanes.length && !shownNotes.length) return empty
  const wipe = item => {
    setWiped(w => new Set([...w, item.id]))
    try { workRegistry().seen?.(item.id) } catch { /* the note stays gone here */ }
  }
  const ls = all ? lanes : lanes.slice(0, maxLanes), ns = allNotes ? shownNotes : shownNotes.slice(0, maxNotes)
  return (
    <section className={cx('ad-strip', `ad-strip-${variant}`)} aria-label={T.title}>
      {lanes.length > 0 && <h3 className="ad-strip-h">{T.title}</h3>}
      {ls.map(w => <Lane key={w.id} item={w} T={T} lang={lang} chip={variant !== 'page' && studios[studioOf(w)]} open={open === w.id} onToggle={() => setOpen(o => (o === w.id ? null : w.id))} />)}
      {lanes.length > maxLanes && <button type="button" className="ad-strip-more" onClick={() => setAll(a => !a)}>{all ? T.fewer : T.more(lanes.length - maxLanes)}</button>}
      {ns.length > 0 && <h3 className="ad-strip-h">{T.done}</h3>}
      {ns.map(w => <Note key={w.id} item={w} T={T} now={now} onWipe={wipe} />)}
      {shownNotes.length > maxNotes && <button type="button" className="ad-strip-more" onClick={() => setAllNotes(a => !a)}>{allNotes ? T.fewer : T.moreNotes(shownNotes.length - maxNotes)}</button>}
    </section>
  )
}

/** The strip folded to a light (the top bar's, while a window fills the desk; the map's while one fills it): the most
 * pressing lane's mark and how many; pointing at it shows the strip. */
export function StripDot({ lang, className }) {
  const T = textOf(lang).strip, list = useWork()
  const { lanes, notes } = useMemo(() => laneOf(list), [list])
  // pointing at it shows the strip; a click pins it open (a touch has no pointing), a click elsewhere puts it away
  const [hover, setHover] = useState(false), [pinned, setPinned] = useState(false), box = useRef(null)
  useEffect(() => {
    if (!pinned) return
    const away = e => { if (!box.current?.contains(e.target)) setPinned(false) }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [pinned])
  if (!lanes.length && !notes.length) return null
  const first = lanes[0] || notes[0], show = hover || pinned
  return (
    <span className={cx('ad-strip-dot', className)} ref={box} onPointerEnter={e => e.pointerType === 'mouse' && setHover(true)} onPointerLeave={() => setHover(false)}>
      <button type="button" className="ad-bar-btn" aria-label={T.title} aria-expanded={show} onClick={() => setPinned(p => !p)}>
        <WorkMark item={first} size={18} />{lanes.length + notes.length > 1 && <i className="ad-strip-n">{lanes.length + notes.length}</i>}
      </button>
      {show && <div className="ad-strip-pop ad-mat"><WorkStrip lang={lang} /></div>}
    </span>
  )
}

/** The time, a minute at a time (the lanes' "for 6 minutes"). */
function useMinute() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t) }, [])
  return now
}
