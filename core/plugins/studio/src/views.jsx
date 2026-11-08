// The blocks a studio's home is made of (its declaration's `home`; docs/design/studio.md): start (say what to make, in a
// line), working (its part of the strip of the work going on), board (a collection by status, dragged between
// columns), list (a collection's rows, or its runs), calendar (a collection by its date or time, a month at a time),
// library (its materials: pictures and files, uploaded or dropped in, opened in the viewer), form (a collection's
// records beside the one being edited), history (the workbench's records, only this studio's). Each reads and writes
// through ./data.js.
import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, FileText, History, Image as ImageIcon, LayoutList, Plus, Rocket, SquareKanban, SquarePen, Upload } from 'lucide-react'
import { WorkStrip } from '@ruyix/shell/strip'
import { canStartRecord } from '../lib/declare.js'
import { start, useCollection, useMaterials } from './data.js'
import { RecordDialog, defaultsOf, refColl, statusField, titleField, titleOf, valueText } from './fields.jsx'
import { say } from './text.js'
import { RemoveButton, cx, useNote, whenText, ymd } from './ui.jsx'

const OPEN_RUN = 'ruyix-workbench:open' // (the workbench's: a run's page)
const say2 = (event, detail) => window.dispatchEvent(new CustomEvent(event, { detail }))
const VIEW = 'ruyix-workbench:view' // (the workbench's viewer window)

/** A block of the home: its heading (an icon, a title, its actions) and what is in it. */
export function Block({ size = 'half', icon: I, title, actions, children, className }) {
  return (
    <section className={cx('st-block', size === 'full' ? 'st-full' : 'st-half', className)}>
      <header className="st-block-head"><h2>{I && <I size={15} strokeWidth={2} aria-hidden="true" />}{title}</h2><div className="st-block-act">{actions}</div></header>
      <div className="st-block-body">{children}</div>
    </section>
  )
}

/** The starts that begin from a record of `coll` (a card's 「写一条」, the editor's 「保存并写一条」). */
export const startsFrom = (decl, coll) => (decl.start || []).filter(s => s.from === coll)
export const startable = canStartRecord

// ── start: say what to make in a line (a new record of its collection, started at once), or more of it in the form, or
//    pick one waiting ──
export function StartBlock({ studio, decl, block, lang, W, refs }) {
  const starts = decl.start || []
  return (
    <Block size={block.size} icon={Rocket} title={block.title ? say(block.title, lang) : starts.map(s => say(s.label, lang)).join(' · ') || W.start} className="st-start">
      {starts.map(s => (s.from ? <StartFrom key={s.id} s={s} studio={studio} decl={decl} lang={lang} W={W} refs={refs} /> : <StartPlain key={s.id} s={s} studio={studio} lang={lang} W={W} />))}
    </Block>
  )
}
function StartPlain({ s, studio, lang, W }) {
  const note = useNote(), [busy, setBusy] = useState(false)
  return <button type="button" className="st-btn st-btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await start(studio, s.id); note(W.started(say(s.label, lang))) } catch (e) { note(W.unknown + e.message, 'error') } setBusy(false) }}>{say(s.label, lang)}</button>
}
function StartFrom({ s, studio, decl, lang, W, refs }) {
  const coll = decl.collections[s.from], api = useCollection(studio, s.from), note = useNote()
  const tf = titleField(coll), [text, setText] = useState(''), [busy, setBusy] = useState(false), [more, setMore] = useState(null)
  const waiting = api.items.filter(r => startable(s, r, coll)).slice(0, 6)
  const go = async e => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return setMore({ preset: {} })
    if (s.showForm) return setMore({ preset: { [tf.name]: t } })
    setBusy(true)
    try {
      const rec = await api.put({ ...defaultsOf(coll), [tf.name]: t })
      await start(studio, s.id, rec.id)
      note(W.started(t)); setText('')
    } catch (err) { note(W.unknown + (err.message || err), 'error') }
    setBusy(false)
  }
  const begin = async rec => { try { await start(studio, s.id, rec.id); note(W.started(titleOf(coll, rec))) } catch (err) { note(W.unknown + err.message, 'error') } }
  return (
    <div className="st-starter">
      <form className="st-compose" onSubmit={go}>
        <SquarePen size={17} aria-hidden="true" />
        <input value={text} onChange={e => setText(e.target.value)} placeholder={W.startNew} aria-label={W.startNew} />
        <button type="button" className="st-btn st-btn-quiet" onClick={() => setMore({ preset: tf && text.trim() ? { [tf.name]: text.trim() } : {} })}>{W.more}</button>
        <button type="submit" className="st-btn st-btn-primary" disabled={busy}>{say(s.label, lang)}</button>
      </form>
      {waiting.length > 0 && (
        <div className="st-waiting">
          <span className="st-quiet">{W.startHint}：</span>
          {waiting.map(r => <button key={r.id} type="button" className="st-chip" onClick={() => begin(r)} title={W.started(titleOf(coll, r))}>{titleOf(coll, r)}<Rocket size={11} /></button>)}
        </div>
      )}
      {more && <RecordDialog studio={studio} decl={decl} collName={s.from} record={null} preset={more.preset} api={api} refs={refs} lang={lang} W={W} startWith={s} onClose={saved => { setMore(null); if (saved) setText('') }} />}
    </div>
  )
}

// ── working: the studio's part of the strip ──
const studioOf = w => (typeof w.studio === 'string' ? w.studio : w.studio?.id) || null
export function WorkingBlock({ studio, block, lang, W }) {
  const filter = useMemo(() => w => studioOf(w) === studio, [studio])
  return (
    <Block size={block.size} icon={null} title={block.title ? say(block.title, lang) : W.working} className="st-working">
      <WorkStrip lang={lang} variant="page" lanes={4} notes={3} filter={filter} empty={<div className="st-quiet">{W.workingNone}</div>} />
    </Block>
  )
}

// ── board: a collection by its status, a column each; a card dragged to another column takes that status ──
export function BoardBlock({ studio, decl, block, lang, W, refs }) {
  const coll = decl.collections[block.collection], sf = statusField(coll, block.by)
  const api = useCollection(studio, block.collection), note = useNote(), { materials } = useMaterials(studio)
  const [edit, setEdit] = useState(null), [over, setOver] = useState(null)
  const starts = startsFrom(decl, block.collection)
  if (!sf) return <ListBlock studio={studio} decl={decl} block={block} lang={lang} W={W} refs={refs} />
  const move = async (id, value) => {
    const rec = api.items.find(r => r.id === id)
    if (!rec || rec[sf.name] === value) return
    try { await api.put({ id: rec.id, [sf.name]: value }) } catch (e) { note(W.unknown + e.message, 'error') }
  }
  return (
    <Block size={block.size} icon={SquareKanban} title={block.title ? say(block.title, lang) : say(coll.title, lang)}
      actions={<button type="button" className="st-btn st-btn-quiet st-btn-sm" onClick={() => setEdit({ record: null })}><Plus size={13} />{W.new}</button>}>
      <div className="st-board" style={{ '--st-cols': sf.values.length }}>
        {sf.values.map(v => {
          const cards = api.items.filter(r => (r[sf.name] ?? sf.default) === v.value)
          return (
            <div key={v.value} className={cx('st-col', over === v.value && 'st-col-over')}
              onDragOver={e => { if (e.dataTransfer.types.includes('text/x-st-record')) { e.preventDefault(); setOver(v.value) } }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null) }}
              onDrop={e => { e.preventDefault(); setOver(null); move(e.dataTransfer.getData('text/x-st-record'), v.value) }}>
              <div className="st-col-head"><i className={`st-tone st-tone-${v.tone || 'neutral'}`} aria-hidden="true" />{say(v.label, lang)}<span className="st-count">{cards.length}</span></div>
              {cards.length ? cards.map(r => (
                <Card key={r.id} rec={r} coll={coll} decl={decl} lang={lang} W={W} refs={refs} studio={studio} materials={materials} onOpen={() => setEdit({ record: r })}
                  start={starts.find(s => startable(s, r, coll))} note={note} />
              )) : <div className="st-col-empty">{W.emptyColumn}</div>}
            </div>
          )
        })}
      </div>
      {api.loading && !api.items.length && <div className="st-quiet">{W.loading}</div>}
      {edit && <RecordDialog studio={studio} decl={decl} collName={block.collection} record={edit.record} api={api} refs={refs} lang={lang} W={W} startWith={edit.record ? starts.find(s => startable(s, edit.record, coll)) : starts[0]} onClose={() => setEdit(null)} />}
    </Block>
  )
}
function Card({ rec, coll, decl, lang, W, refs, studio, materials, onOpen, start: s, note }) {
  const notes = coll.fields.find(f => f.type === 'textarea'), meta = coll.fields.filter(f => ['ref', 'tags', 'datetime', 'date', 'select'].includes(refColl(f) ? 'ref' : f.type) && rec[f.name] != null)
  const img = coll.fields.find(f => f.type === 'image'), imgs = img ? [].concat(rec[img.name] || []) : []
  const thumb = imgs.length ? materials.find(m => m.id === imgs[0])?.url : null
  return (
    <div className="st-card" draggable onDragStart={e => { e.dataTransfer.setData('text/x-st-record', rec.id); e.dataTransfer.effectAllowed = 'move' }}>
      <button type="button" className="st-card-main" onClick={onOpen}>
        {thumb && <img className="st-card-img" src={thumb} alt="" loading="lazy" />}
        <b>{titleOf(coll, rec)}</b>
        {notes && rec[notes.name] && <span className="st-card-notes">{rec[notes.name]}</span>}
        {meta.length > 0 && <span className="st-card-meta">{meta.slice(0, 3).map(f => <i key={f.name}>{valueText(f, rec[f.name], lang, W, refs, decl)}</i>)}</span>}
      </button>
      {s && <button type="button" className="st-card-go" onClick={async () => { try { await start(studio, s.id, rec.id); note(W.started(titleOf(coll, rec))) } catch (e) { note(W.unknown + e.message, 'error') } }}><Rocket size={12} />{say(s.label, lang)}</button>}
    </div>
  )
}

// ── list: a collection's rows (a click edits one), or its runs (a click opens the run) ──
export function ListBlock({ studio, decl, block, lang, W, refs }) {
  const coll = decl.collections[block.collection], api = useCollection(studio, block.collection)
  const [edit, setEdit] = useState(null)
  const title = block.title ? say(block.title, lang) : say(coll.title, lang)
  if (coll.runs) {
    return (
      <Block size={block.size} icon={LayoutList} title={title}>
        {api.items.length ? (
          <ul className="st-rows">
            {api.items.map(r => (
              <li key={r.id} className="st-row-with">
                {/* the row: what came of it, in the viewer window; beside it, the run's own page */}
                <button type="button" className="st-row" onClick={() => say2(VIEW, { run: r.id })}>
                  <span className={cx('st-run-st', `st-run-${r.status === 'done' && r.ok === false ? 'failed' : r.status}`)}>{W.run[r.status === 'done' && r.ok === false ? 'failed' : r.status] || r.status}</span>
                  <span className="st-row-main"><b>{r.title}</b>{r.outcome?.text && <small>{r.outcome.text}</small>}</span>
                  <span className="st-row-when">{whenText(r.endedAt || r.createdAt, lang)}</span>
                </button>
                <button type="button" className="st-row-go st-link" onClick={() => say2(OPEN_RUN, { run: r.id, tab: 'results' })}>{W.runPage}</button>
              </li>
            ))}
          </ul>
        ) : <div className="st-quiet">{api.loading ? W.loading : W.empty}</div>}
      </Block>
    )
  }
  // the columns beside the title: the short kinds of field (a status, a choice, a time, a number, a yes or no, tags, a ref)
  const SHORT = ['status', 'select', 'datetime', 'date', 'number', 'bool', 'tags']
  const tf = titleField(coll), cols = coll.fields.filter(f => f !== tf && (refColl(f) || SHORT.includes(f.type))).slice(0, 3)
  return (
    <Block size={block.size} icon={LayoutList} title={title} actions={<button type="button" className="st-btn st-btn-quiet st-btn-sm" onClick={() => setEdit({ record: null })}><Plus size={13} />{W.new}</button>}>
      {api.items.length ? (
        <ul className="st-rows">
          {api.items.map(r => (
            <li key={r.id}>
              <button type="button" className="st-row" onClick={() => setEdit({ record: r })}>
                <span className="st-row-main"><b>{titleOf(coll, r)}</b></span>
                {cols.map(f => <span key={f.name} className="st-row-cell">{valueText(f, r[f.name], lang, W, refs, decl)}</span>)}
              </button>
            </li>
          ))}
        </ul>
      ) : <div className="st-quiet">{api.loading ? W.loading : W.empty}</div>}
      {edit && <RecordDialog studio={studio} decl={decl} collName={block.collection} record={edit.record} api={api} refs={refs} lang={lang} W={W} startWith={startsFrom(decl, block.collection)[0] || null} onClose={() => setEdit(null)} />}
    </Block>
  )
}

// ── calendar: a month; each record on the day of its date or time (`at`), dragged to another day keeps its hour ──
export function CalendarBlock({ studio, decl, block, lang, W, refs }) {
  const coll = decl.collections[block.collection], api = useCollection(studio, block.collection), note = useNote()
  const at = coll.fields.find(f => (block.at ? f.name === block.at : f.type === 'datetime' || f.type === 'date'))
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const [edit, setEdit] = useState(null), [over, setOver] = useState(null)
  const dayOf = r => { const v = r[at?.name]; if (v == null) return null; return at.type === 'date' ? v : ymd(new Date(v)) }
  const byDay = useMemo(() => { const m = {}; for (const r of api.items) { const d = dayOf(r); if (d) (m[d] ||= []).push(r) } return m }, [api.items, at])
  if (!at) return null
  // the weeks shown: from the Monday on or before the 1st to the Sunday on or after the last day
  const first = new Date(month), lead = (first.getDay() + 6) % 7, days = []
  for (let d = new Date(first.getFullYear(), first.getMonth(), 1 - lead); days.length < 42; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(d)
  while (days.length > 35 && days.slice(-7).every(d => d.getMonth() !== month.getMonth())) days.splice(-7)
  const today = ymd(new Date())
  const valueFor = (day, old) => {
    if (at.type === 'date') return day
    const [y, m, d] = day.split('-').map(Number), base = old ? new Date(old) : null
    return new Date(y, m - 1, d, base ? base.getHours() : 10, base ? base.getMinutes() : 0).getTime()
  }
  const move = async (id, day) => {
    const r = api.items.find(x => x.id === id)
    if (!r || dayOf(r) === day) return
    try { await api.put({ id: r.id, [at.name]: valueFor(day, r[at.name]) }) } catch (e) { note(W.unknown + e.message, 'error') }
  }
  const unset = api.items.filter(r => r[at.name] == null).length
  return (
    <Block size={block.size} icon={CalendarDays} title={block.title ? say(block.title, lang) : W.calendar} actions={<>
      <button type="button" className="st-icon-btn" aria-label={W.prev} onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}><ChevronLeft size={15} /></button>
      <span className="st-month">{W.month(month.getFullYear(), month.getMonth() + 1)}</span>
      <button type="button" className="st-icon-btn" aria-label={W.next} onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}><ChevronRight size={15} /></button>
      <button type="button" className="st-btn st-btn-quiet st-btn-sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)) }}>{W.today}</button>
    </>}>
      <div className="st-cal" role="grid">
        {W.weekdays.map(w => <div key={w} className="st-cal-wd" role="columnheader">{w}</div>)}
        {days.map(d => {
          const key = ymd(d), list = byDay[key] || []
          return (
            <div key={key} role="gridcell" className={cx('st-cal-day', d.getMonth() !== month.getMonth() && 'st-cal-out', key === today && 'st-cal-today', over === key && 'st-cal-over')}
              onDragOver={e => { if (e.dataTransfer.types.includes('text/x-st-record')) { e.preventDefault(); setOver(key) } }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null) }}
              onDrop={e => { e.preventDefault(); setOver(null); move(e.dataTransfer.getData('text/x-st-record'), key) }}
              onDoubleClick={e => { if (e.target === e.currentTarget) setEdit({ record: null, preset: { [at.name]: valueFor(key) } }) }}>
              <span className="st-cal-n">{d.getDate()}</span>
              {list.map(r => (
                <button key={r.id} type="button" className="st-cal-item" draggable onDragStart={e => { e.dataTransfer.setData('text/x-st-record', r.id); e.dataTransfer.effectAllowed = 'move' }} onClick={() => setEdit({ record: r })} title={titleOf(coll, r)}>
                  {at.type === 'datetime' && <small>{new Date(r[at.name]).toTimeString().slice(0, 5)}</small>}{titleOf(coll, r)}
                </button>
              ))}
            </div>
          )
        })}
      </div>
      {unset > 0 && <div className="st-quiet st-cal-unset">{W.noTime}：{unset}</div>}
      {edit && <RecordDialog studio={studio} decl={decl} collName={block.collection} record={edit.record} preset={edit.preset} api={api} refs={refs} lang={lang} W={W} startWith={startsFrom(decl, block.collection)[0] || null} onClose={() => setEdit(null)} />}
    </Block>
  )
}

// ── library: the studio's materials; dropped in or uploaded; a click opens it in the viewer window ──
export function LibraryBlock({ studio, block, lang, W }) {
  const { materials, upload, remove, loading } = useMaterials(studio), note = useNote()
  const [busy, setBusy] = useState(false), [over, setOver] = useState(false), file = useRef(null)
  const up = async files => {
    if (!files.length) return
    setBusy(true)
    let n = 0
    for (const f of files) { try { await upload(f); n++ } catch (e) { note(W.unknown + `${f.name}: ${e.message}`, 'error') } }
    setBusy(false)
    if (n) note(W.uploaded(n))
  }
  const view = i => {
    const files = materials.map(m => ({ url: m.url, name: m.name, kind: m.kind }))
    // the viewer window takes plain files (the workbench says so on window.__ruyixViews); else a tab of its own
    if (window.__ruyixViews?.files) window.dispatchEvent(new CustomEvent(VIEW, { detail: { files, file: i, title: say(block.title, lang) || W.library } }))
    else window.open(materials[i].url, '_blank', 'noopener')
  }
  return (
    <Block size={block.size} icon={ImageIcon} title={block.title ? say(block.title, lang) : W.library} className={cx('st-library', over && 'st-drop-over')}
      actions={<button type="button" className="st-btn st-btn-quiet st-btn-sm" disabled={busy} onClick={() => file.current?.click()}><Upload size={13} />{busy ? W.uploading : W.upload}</button>}>
      <div className="st-drop" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true) } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false) }}
        onDrop={e => { e.preventDefault(); setOver(false); up([...e.dataTransfer.files]) }}>
        <input ref={file} type="file" multiple hidden onChange={e => { up([...e.target.files]); e.target.value = '' }} />
        {materials.length ? (
          <div className="st-lib-grid">
            {materials.map((m, i) => (
              <div key={m.id} className="st-tile">
                <button type="button" className="st-tile-open" onClick={() => view(i)} title={m.name}>
                  {m.kind === 'image' ? <img src={m.url} alt="" loading="lazy" /> : <span className="st-tile-doc"><FileText size={22} strokeWidth={1.6} /><em>{m.name.split('.').pop()}</em></span>}
                  <span className="st-tile-name">{m.name}</span>
                </button>
                <span className="st-tile-x"><RemoveButton W={W} small onRemove={() => remove(m.id).catch(e => note(W.unknown + e.message, 'error'))} /></span>
              </div>
            ))}
          </div>
        ) : <div className="st-quiet st-lib-empty">{loading ? W.loading : W.emptyLibrary}</div>}
        {over && <div className="st-drop-hint">{W.dropHere}</div>}
      </div>
    </Block>
  )
}

// ── form: a collection's records down the left, the one chosen edited beside them (`single`: just the one) ──
export function FormBlock({ studio, decl, block, lang, W, refs }) {
  const coll = decl.collections[block.collection], api = useCollection(studio, block.collection)
  const [pick, setPick] = useState(null) // a record's id, 'new', or null
  const single = !!coll.single, list = api.items
  useEffect(() => { if (pick === null && list.length && !single) setPick(list[0].id) }, [list.length])
  const rec = single ? list[0] || null : pick === 'new' ? null : list.find(r => r.id === pick) || null
  const editing = single || pick === 'new' || !!rec
  return (
    <Block size={block.size} icon={SquarePen} title={block.title ? say(block.title, lang) : say(coll.title, lang)}
      actions={!single && <button type="button" className="st-btn st-btn-quiet st-btn-sm" onClick={() => setPick('new')}><Plus size={13} />{W.new}</button>}>
      <div className={cx('st-formview', single && 'st-formview-single')}>
        {!single && (
          <ul className="st-formlist" role="listbox" aria-label={say(coll.title, lang)}>
            {list.map(r => (
              <li key={r.id}><button type="button" role="option" aria-selected={pick === r.id} className={cx(pick === r.id && 'on')} onClick={() => setPick(r.id)}>
                {coll.fields.find(f => f.type === 'color') && <i className="st-swatch" style={{ background: r[coll.fields.find(f => f.type === 'color').name] || 'transparent' }} />}
                <span>{titleOf(coll, r)}</span>
              </button></li>
            ))}
            {pick === 'new' && <li><button type="button" className="on" aria-selected="true">{W.newOf(say(coll.title, lang))}</button></li>}
          </ul>
        )}
        {editing ? (
          <RecordDialog inline key={rec?.id || 'new'} studio={studio} decl={decl} collName={block.collection} record={rec} api={api} refs={refs} lang={lang} W={W}
            onClose={saved => setPick(saved ? saved.id : single ? null : list[0]?.id || null)} />
        ) : <div className="st-quiet st-form-empty">{api.loading ? W.loading : list.length ? W.emptyForm : W.emptyFormNone}</div>}
      </div>
    </Block>
  )
}

// ── history: the workbench's records, this studio's only (the workbench hands its view over on window.__ruyixViews) ──
export function HistoryBlock({ studio, block, lang, W }) {
  const [View, setView] = useState(() => window.__ruyixViews?.records || null)
  useEffect(() => { const on = () => setView(() => window.__ruyixViews?.records || null); window.addEventListener('ruyix:views', on); return () => window.removeEventListener('ruyix:views', on) }, [])
  return (
    <Block size={block.size} icon={History} title={block.title ? say(block.title, lang) : W.history} className="st-history">
      {View ? <View studio={studio} lang={lang} /> : <div className="st-quiet">{W.historyWait}</div>}
    </Block>
  )
}
