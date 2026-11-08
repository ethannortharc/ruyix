// The desk's widgets: what sits on the wallpaper beside the windows. Built-in ones (the setup while it is open, a clock, a
// calendar, notes, a question for the assistant), each plugin's overview section (`overview:<section>`), and widgets a
// plugin adds: it puts { type: '<plugin>:<name>', name: { zh, en }, sizes: ['sm', 'md'], render, default?, order? } in
// window.__ruyixWidgetDefs and fires 'ruyix:widget' (render gets { size, lang, preview }). desktop.json's `widgets`
// says which, in what order and size (null: the default set). A plugin's widget with `default` (its size) is in the
// default set, at the top in `order`; on a desk of the person's own it is put there once as it comes (`widgetsOffered`
// remembers it, so one taken off stays off). Each can be dragged anywhere on the desk and resized by its
// corner (kept as its `at`; dropped back on the column at the right, it goes back into it there); the edit mode removes
// them and adds them from a gallery. Their glass follows the wallpaper (light or dark), not the page's theme: they sit on it.
import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Check, Minus, Plus, Send } from 'lucide-react'
import { MAX_WIDGETS, WIDGET_SIZES } from '../../desktop.js'
import { BAR, DOCK } from './store.js'
import { textOf } from './text.js'

const cx = (...c) => c.filter(Boolean).join(' ')
const text = (x, lang) => (x ? x[lang] || x.en || '' : '')
const newId = () => Math.random().toString(36).slice(2, 10)

// ── a widget's place on the desk (desktop.json `at`: x from the left or the right edge, whichever it is nearer) ──
const SNAP = 8, MIN_W = 120, MIN_H = 90, NARROW = 200
const snap = v => Math.round(v / SNAP) * SNAP
/** A press on what is the widget's own (a button, a field, a link, its grip): not the start of a move. */
const ownPart = el => !!el?.closest?.('button, a, input, textarea, select, label, [contenteditable="true"], [role="slider"]')
/** A placed widget's box on a desk `vw` wide. */
export const boxOf = (at, vw) => ({ x: at.ax === 'r' ? vw - at.x - at.w : at.x, y: at.y, w: at.w, h: at.h ?? null })
/** A box on the desk → its `at`: x from the nearer edge, so it keeps to that side as the desk changes. */
export const atOf = (b, vw) => {
  const right = b.x + b.w / 2 > vw / 2
  return { x: Math.round(right ? vw - b.x - b.w : b.x), y: Math.round(b.y), w: Math.round(b.w), ...(b.h != null && { h: Math.round(b.h) }), ax: right ? 'r' : 'l' }
}
/** Kept on the desk: under the top bar, above the dock, inside its sides (a desk smaller than when it was put there). */
export const keepIn = (b, vw, vh) => ({ ...b, x: Math.min(Math.max(b.x, 8), Math.max(8, vw - b.w - 8)), y: Math.min(Math.max(b.y, BAR + 6), Math.max(BAR + 6, vh - DOCK - 48)) })
/** One widget's body failing (a plugin's) leaves the others drawn. */
class Contained extends Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

/** The widgets plugins added (window.__ruyixWidgetDefs, and the event as each comes). */
function usePluginWidgets() {
  const [defs, setDefs] = useState(() => window.__ruyixWidgetDefs || [])
  useEffect(() => {
    const on = () => setDefs([...(window.__ruyixWidgetDefs || [])])
    window.addEventListener('ruyix:widget', on)
    on()
    return () => window.removeEventListener('ruyix:widget', on)
  }, [])
  return defs
}

/** What the setup and overview widgets show: read when the desk shows, every half minute and when the page comes back. */
function useDeskData(visible) {
  const [setup, setSetup] = useState(null), [sections, setSections] = useState([])
  useEffect(() => {
    if (!visible) return
    const read = () => {
      if (document.hidden) return
      fetch('api/ruyix/setup').then(r => r.json()).then(s => setSetup(Array.isArray(s?.steps) ? s.steps : null), () => {})
      fetch('api/ruyix/overview').then(r => r.json()).then(o => setSections(Array.isArray(o?.sections) ? o.sections : []), () => {})
    }
    read()
    const id = setInterval(read, 30e3)
    window.addEventListener('focus', read)
    return () => { clearInterval(id); window.removeEventListener('focus', read) }
  }, [visible])
  return { setup, sections }
}

function useNow(every) {
  const [d, setD] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setD(new Date()), every); return () => clearInterval(id) }, [every])
  return d
}

// ── the built-in widgets ──

function SetupW({ data, T, openPage }) {
  const req = (data.setup || []).filter(s => s.required), done = req.filter(s => s.ready).length
  if (!req.length || done >= req.length) return null
  return (
    <>
      <div className="ad-w-cap"><span>{T.setup}</span><span>{done}/{req.length}</span></div>
      <div className="ad-w-meter"><i style={{ width: `${(100 * done) / req.length}%` }} /></div>
      <p className="ad-w-p">{T.setupLeft(req.length - done)}</p>
      <button type="button" className="ad-btn ad-pri" onClick={() => openPage('ruyix-start')}>{T.continueSetup}<ArrowUpRight size={13} /></button>
    </>
  )
}

function OverviewW({ section, lang, go }) {
  if (!section) return null
  return (
    <>
      <div className="ad-w-cap"><span>{text(section.title, lang)}</span>{section.more && <button type="button" onClick={() => go(section.more.open)}>{text(section.more.label, lang)}</button>}</div>
      <div className="ad-w-tiles">
        {section.tiles.map(x => (
          <button key={x.id} type="button" className={cx('ad-w-tile', `ad-tone-${x.tone || 'neutral'}`)} disabled={!x.open} onClick={() => go(x.open)}>
            <b>{x.value}</b><span>{text(x.label, lang)}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/** A clock face: twelve marks, the hands, the seconds in the accent. */
function Face({ d }) {
  const s = d.getSeconds(), m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60
  const hand = (deg, len, w, cls) => <line className={cls} x1="50" y1="50" x2={50 + len * Math.sin((deg * Math.PI) / 180)} y2={50 - len * Math.cos((deg * Math.PI) / 180)} strokeWidth={w} strokeLinecap="round" />
  return (
    <svg className="ad-face" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="ad-face-dial" cx="50" cy="50" r="47" />
      {Array.from({ length: 12 }, (_, i) => <line key={i} className="ad-face-mark" x1="50" y1={i % 3 ? 8 : 6} x2="50" y2={i % 3 ? 12 : 14} strokeWidth={i % 3 ? 1.6 : 2.6} strokeLinecap="round" transform={`rotate(${i * 30} 50 50)`} />)}
      {hand(h * 30, 25, 4.2, 'ad-face-h')}
      {hand(m * 6, 35, 3, 'ad-face-h')}
      {hand(s * 6, 37, 1.3, 'ad-face-s')}
      <circle className="ad-face-pin" cx="50" cy="50" r="2.6" />
    </svg>
  )
}
function ClockW({ size, lang, T }) {
  const d = useNow(1000)
  if (size === 'sm') return <div className="ad-clockw-sm"><Face d={d} /><span>{T.weekdayShort(d)} {d.getDate()}</span></div>
  return (
    <div className="ad-clockw">
      <Face d={d} />
      <div><b>{T.hm(d)}</b><span>{T.date(d)}</span></div>
    </div>
  )
}

/** This month: the days in weeks (Monday first in Chinese, Sunday in English), today marked. */
function CalendarW({ size, lang, T }) {
  const d = useNow(60e3)
  const y = d.getFullYear(), mo = d.getMonth(), first = (new Date(y, mo, 1).getDay() + (lang === 'zh' ? 6 : 0)) % 7, days = new Date(y, mo + 1, 0).getDate()
  const cells = [...Array(first).fill(0), ...Array.from({ length: days }, (_, i) => i + 1)]
  const grid = (
    <div className="ad-cal-grid">
      {T.weekHead.map((w, i) => <i key={`h${i}`}>{w}</i>)}
      {cells.map((n, i) => <span key={i} className={cx(n === d.getDate() && 'ad-today', !n && 'ad-blank')}>{n || ''}</span>)}
    </div>
  )
  if (size === 'sm') return <div className="ad-cal ad-cal-sm"><div className="ad-cal-month">{T.month(d)}</div>{grid}</div>
  return (
    <div className="ad-cal ad-cal-md">
      <div className="ad-cal-day"><span>{T.weekdayLong(d)}</span><b>{d.getDate()}</b><small>{T.month(d)}</small></div>
      {grid}
    </div>
  )
}

// the notes' text, read once for the desk and saved as typed (a moment after the last key)
let notesCache = null
const loadNotes = () => (notesCache ||= fetch('api/ruyix/notes').then(r => r.json()).then(j => j.notes || {}, () => ({})))
function NoteW({ id, T, preview }) {
  const [v, setV] = useState(''), [ready, setReady] = useState(preview), [error, setError] = useState(false)
  const timer = useRef(0), dirty = useRef(null), sending = useRef(false), reading = useRef(0)
  const refresh = () => { const seq = ++reading.current; notesCache = null; return loadNotes().then(n => { if (seq !== reading.current) return; if (dirty.current === null) setV(n[id] || ''); setReady(true) }) }
  useEffect(() => { if (!preview) refresh() }, [id])
  // Keep typing while an agent's note arrives; the pending save wins and its response becomes the displayed text.
  useEffect(() => {
    const on = e => { if (!preview && e.detail?.id === id) refresh() }
    window.addEventListener('ruyix:notes', on)
    return () => window.removeEventListener('ruyix:notes', on)
  }, [id])
  const save = async () => {
    timer.current = 0
    if (sending.current || dirty.current === null) return
    sending.current = true
    const pending = dirty.current
    try {
      const res = await fetch('api/ruyix/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, text: pending.text }) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const n = (await res.json()).notes
      if (!n || typeof n !== 'object') throw new Error('invalid notes')
      ++reading.current
      notesCache = Promise.resolve(n)
      if (dirty.current === pending) { dirty.current = null; setV(n[id] || '') }
      setError(false)
    } catch { setError(true) }
    finally {
      sending.current = false
      if (dirty.current !== null && !timer.current) timer.current = setTimeout(save, 1500)
    }
  }
  const change = e => {
    const text = e.target.value
    ++reading.current
    setV(text); dirty.current = { text }
    clearTimeout(timer.current)
    timer.current = setTimeout(save, 600)
  }
  return <textarea className="ad-note-text" value={preview ? T.notePreview : v} onChange={change} maxLength={8000} title={error ? T.noteUnsaved : undefined} aria-invalid={error || undefined} placeholder={T.notePlaceholder} disabled={!ready || preview} aria-label={T.names.note} spellCheck={false} />
}

function AskW({ T, ask, preview }) {
  const [v, setV] = useState('')
  const send = () => { const t = v.trim(); if (!t || preview) return; setV(''); ask(t) }
  return (
    <form className="ad-ask" onSubmit={e => { e.preventDefault(); send() }}>
      <div className="ad-w-cap"><span>{T.names.ask}</span></div>
      <div className="ad-ask-row">
        <input value={v} onChange={e => setV(e.target.value)} placeholder={T.askPlaceholder} aria-label={T.names.ask} disabled={preview} />
        <button type="submit" className="ad-ask-go" aria-label={T.send} disabled={!v.trim()}><Send size={14} /></button>
      </div>
    </form>
  )
}

const BUILTIN = {
  setup: { sizes: ['md'], once: true },
  clock: { sizes: ['sm', 'md'], once: true },
  calendar: { sizes: ['sm', 'md'], once: true },
  note: { sizes: ['sm', 'md'] },
  ask: { sizes: ['md'], once: true },
}

/** The plugins' widgets that ask to be on the desk (`default`: their size), in their `order`. */
const arriving = defs => defs.filter(d => WIDGET_SIZES.includes(d.default)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
const idOf = type => `d${String(type).replace(/[^a-z0-9]/g, '').slice(-11)}`
/** The set shown until the person changes it: the setup, the plugins' widgets that ask to be there, a clock and a
 * calendar side by side, every overview. */
const defaultSet = (sections, defs) => [
  { id: 'dsetup', type: 'setup', size: 'md' },
  ...arriving(defs).map(d => ({ id: idOf(d.type), type: d.type, size: d.default })),
  { id: 'dclock', type: 'clock', size: 'sm' }, { id: 'dcal', type: 'calendar', size: 'sm' },
  ...sections.map(s => ({ id: `d${String(s.id).replace(/[^a-z0-9]/g, '').slice(0, 10)}`, type: `overview:${s.id}`, size: 'md' })),
]

/**
 * The widgets on the desk and their edit mode. `desktop.widgets` (null: the default set); `edit`, `setEdit`; `save(list)`
 * writes desktop.json; `go`, `openPage`, `ask` (a question to the assistant).
 */
export function Widgets({ lang, desktop, visible, edit, setEdit, save, offer = null, go, openPage, ask, top = null, z = 1, vw = 1440, vh = 900 }) {
  const T = textOf(lang), W = { ...T, ...T.widgets }
  const data = useDeskData(visible || edit)
  const defs = usePluginWidgets()
  const saved = desktop.widgets
  const list = useMemo(() => saved || defaultSet(data.sections, defs), [saved, data.sections, defs])
  // a plugin's widget that asks to be on the desk, come to a desk of the person's own: put at the top of the column once
  // (a few seconds after the plugins stop arriving, all of them in one write); one already there is remembered as offered
  const sent = useRef(new Set())
  useEffect(() => {
    if (!saved || !offer) return
    const offered = new Set([...(desktop.widgetsOffered || []), ...sent.current])
    const due = arriving(defs).filter(d => !offered.has(d.type))
    if (!due.length) return
    const id = setTimeout(async () => {
      const come = due.filter(d => !saved.some(w => w.type === d.type)).map(d => ({ id: newId(), type: d.type, size: d.default }))
      const result = await offer([...come, ...saved].slice(0, MAX_WIDGETS), [...offered, ...due.map(d => d.type)])
      if (result) for (const d of due) sent.current.add(d.type)
    }, 3000)
    return () => clearTimeout(id)
  }, [saved, defs, desktop.widgetsOffered])
  const [move, setMove] = useState(null) // the one being moved or resized: { id, mode, box, col (into the column before this id; '' at its end) }
  const shown = list
  const colRef = useRef(null)

  // what a type is: its name, sizes and body (null: nothing to show now — a finished setup, a plugin not loaded)
  const kind = type => {
    if (BUILTIN[type]) return { ...BUILTIN[type], name: W.names[type] }
    if (type.startsWith('overview:')) { const sec = data.sections.find(s => `overview:${s.id}` === type); return { sizes: ['md'], once: true, name: sec ? text(sec.title, lang) : type.slice(9), section: sec } }
    const def = defs.find(x => x.type === type)
    return def ? { sizes: def.sizes?.length ? def.sizes : ['md'], once: def.once !== false, name: text(def.name, lang), def } : null
  }
  const body = (w, preview = false) => {
    const k = kind(w.type)
    if (!k) return null
    const props = { id: w.id, size: w.size, lang, T: W, go, openPage, ask, preview, data }
    switch (w.type) {
      case 'setup': return <SetupW {...props} />
      case 'clock': return <ClockW {...props} />
      case 'calendar': return <CalendarW {...props} />
      case 'note': return <NoteW {...props} />
      case 'ask': return <AskW {...props} />
      default:
        if (k.section) return <OverviewW section={k.section} lang={lang} go={go} />
        if (k.def) { const R = k.def.render; return <R size={w.size} lang={lang} preview={preview} /> }
        return null
    }
  }
  const put = next => save(next.map(({ id, type, size, at }) => ({ id, type, size, ...(at && { at }) })))
  const remove = id => put(list.filter(w => w.id !== id))
  const resize = (id, size) => put(list.map(w => (w.id === id ? { ...w, size } : w)))
  const add = (type, size) => { if (list.length < MAX_WIDGETS) put([{ id: newId(), type, size }, ...list]) }

  // moving one (a press anywhere but its own buttons and fields, then a few pixels) or resizing it (its corner): it
  // follows the pointer; let go, it is kept where it is (snapped, inside the desk) — or, let go over the column, back in
  // the column before the widget under the pointer
  const begin = (e, w, mode) => {
    if (e.button !== 0 || (mode === 'move' && ownPart(e.target))) return
    e.preventDefault() // (no text selection starting under the pointer)
    const el = e.currentTarget.closest('.ad-w'), r = el.getBoundingClientRect()
    const box0 = { x: r.left / z, y: r.top / z, w: r.width / z, h: r.height / z }, sx = e.clientX, sy = e.clientY
    let started = false, last = null
    const over = ev => {
      const col = colRef.current
      if (mode !== 'move' || !col) return null
      const cr = col.getBoundingClientRect()
      if (ev.clientX < cr.left || ev.clientX > cr.right || ev.clientY < cr.top || ev.clientY > cr.bottom + 40) return null
      const els = [...col.querySelectorAll('[data-wid]')].filter(x => x.dataset.wid !== w.id)
      const at = els.find(x => { const b = x.getBoundingClientRect(); return ev.clientY < b.bottom && (ev.clientY < b.top || ev.clientX < b.right) })
      return at ? at.dataset.wid : ''
    }
    const onMove = ev => {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z
      if (!started && Math.hypot(dx, dy) < 5) return
      if (!started) { started = true; document.documentElement.setAttribute('data-ruyix-moving', '') }
      ev.preventDefault()
      const box = mode === 'move'
        ? { ...box0, x: box0.x + dx, y: box0.y + dy, h: w.at ? w.at.h ?? null : null }
        : { ...box0, w: Math.max(MIN_W, box0.w + dx), h: Math.max(MIN_H, box0.h + dy) }
      last = { box, col: over(ev) }
      setMove({ id: w.id, mode, ...last })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp)
      document.documentElement.removeAttribute('data-ruyix-moving')
      setMove(null)
      if (!started || !last) return
      if (last.col !== null) {
        const rest = list.filter(x => x.id !== w.id), i = last.col ? rest.findIndex(x => x.id === last.col) : -1
        rest.splice(i < 0 ? rest.length : i, 0, { id: w.id, type: w.type, size: w.size })
        return put(rest)
      }
      const b = keepIn({ x: snap(last.box.x), y: snap(last.box.y), w: snap(last.box.w), h: last.box.h == null ? null : snap(last.box.h) }, vw, vh)
      put(list.map(x => (x.id === w.id ? { ...x, size: b.w < NARROW ? 'sm' : 'md', at: atOf(b, vw) } : x)))
    }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp)
  }

  const card = (w, style = null) => {
    const k = kind(w.type), b = body(w), moving = (move && move.id === w.id)
    if (!b && !edit) return null
    return (
      <section key={w.id} data-wid={w.id} style={style} onPointerDown={e => begin(e, w, 'move')}
        className={cx('ad-w', `ad-w-${w.size}`, `ad-wt-${w.type.replace(/[^a-z0-9]/g, '-')}`, style && 'ad-w-free', style?.height && 'ad-w-tall', moving && (style ? 'ad-w-moving' : 'ad-w-left'))}>
        <Contained fallback={<p className="ad-w-p">{W.failed}</p>}>{b || <p className="ad-w-p ad-w-quiet">{k ? W.nothingNow(k.name) : W.gone}</p>}</Contained>
        {edit && (
          <>
            <button type="button" className="ad-w-remove" aria-label={W.remove(k?.name || w.type)} title={W.remove(k?.name || w.type)} onClick={() => remove(w.id)}><Minus size={12} strokeWidth={3} /></button>
            {k && k.sizes.length > 1 && (
              <div className="ad-w-sizes" role="radiogroup" aria-label={W.size}>
                {k.sizes.map(z => <button key={z} type="button" role="radio" aria-checked={w.size === z} className={cx(w.size === z && 'ad-on')} onClick={() => resize(w.id, z)}>{W.sizes[z]}</button>)}
              </div>
            )}
          </>
        )}
        <span className="ad-w-grip" aria-hidden="true" onPointerDown={e => { e.stopPropagation(); begin(e, w, 'size') }} />
      </section>
    )
  }
  // in the column: those without a place (the one being moved stays there, faded, until it is let go)
  const items = shown.filter(w => !w.at).map(w => card(w))
  // on the desk: those with a place, and the one being moved or resized where the pointer has it
  const placed = shown.filter(w => w.at || (move && move.id === w.id)).map(w => {
    const b = (move && move.id === w.id) ? move.box : keepIn(boxOf(w.at, vw), vw, vh)
    return card(w, { left: b.x, top: b.y, width: b.w, ...(b.h != null && { height: b.h }) })
  })

  // the gallery: every kind not on the desk yet (notes as many as wanted), each in the sizes it has
  const known = [
    ...Object.keys(BUILTIN), ...data.sections.map(s => `overview:${s.id}`), ...defs.map(x => x.type),
  ].filter((t, i, all) => all.indexOf(t) === i).map(t => ({ type: t, ...kind(t) })).filter(k => k.name)
  const kinds = known.filter(k => !(k.once && list.some(w => w.type === k.type)))
  // every kind there is, told to the host when it changes: the main agent adds a widget by its exact type (desk_get)
  const told = JSON.stringify(known.map(k => ({ type: k.type, name: typeof k.name === 'object' ? k.name : String(k.name || ''), sizes: k.sizes || [] })))
  useEffect(() => {
    fetch('api/ruyix/surfaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"widgets":${told}}` }).catch(() => {})
  }, [told])

  return (
    <>
      <div ref={colRef} className={cx('ad-widgets', edit && 'ad-wedit', move?.col != null && 'ad-wdrop')}>
        {edit && <div className="ad-wbar"><b>{W.title}</b><button type="button" className="ad-btn ad-pri" onClick={() => setEdit(false)}><Check size={13} />{W.done}</button></div>}
        {/* what goes above the widgets (the strip of the work going on: ./strip.jsx) */}
        {!edit && top}
        <div className="ad-wgrid">{items}</div>
        {!edit && <button type="button" className="ad-wedit-btn" onClick={() => setEdit(true)}>{W.edit}</button>}
      </div>
      <div className="ad-wfree">{placed}</div>
      {edit && (
        <aside className="ad-gallery" aria-label={W.gallery}>
          <div className="ad-gallery-head"><b>{W.gallery}</b><span>{W.galleryHint}</span></div>
          {!kinds.length && <p className="ad-w-p ad-w-quiet">{W.allOn}</p>}
          {kinds.map(k => (
            <div key={k.type} className="ad-gal-item">
              <div className="ad-gal-top"><b>{k.name}</b>
                <span className="ad-gal-add">{k.sizes.map(z => <button key={z} type="button" className="ad-btn" onClick={() => add(k.type, z)} disabled={list.length >= MAX_WIDGETS}><Plus size={12} />{W.sizes[z]}</button>)}</span>
              </div>
              <div className={cx('ad-gal-pv', `ad-gal-pv-${k.sizes[0]}`)} aria-hidden="true">
                <section className={cx('ad-w', `ad-w-${k.sizes[k.sizes.length - 1]}`)}><Contained fallback={null}>{body({ id: 'preview', type: k.type, size: k.sizes[k.sizes.length - 1] }, true)}</Contained></section>
              </div>
            </div>
          ))}
        </aside>
      )}
    </>
  )
}
