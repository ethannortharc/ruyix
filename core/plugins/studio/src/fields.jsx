// A studio's fields, as the pages show and edit them (the types: lib/declare.js): a value in words (a card, a row),
// an input for each type, the materials picker for an image field, and the form for one record — its fields, saving
// (the studio says what is wrong and where), deleting, its earlier versions.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ImagePlus, Plus, Upload, X } from 'lucide-react'
import { canStartRecord } from '../lib/declare.js'
import { history, start, useCollection, useMaterials } from './data.js'
import { say } from './text.js'
import { recordPatch } from './record-patch.js'
import { Dialog, RemoveButton, cx, fromLocalInput, localInput, useNote, whenText } from './ui.jsx'

export const refColl = f => (typeof f?.type === 'string' && f.type.startsWith('ref:') ? f.type.slice(4) : null)
/** The field that names a record: one called title or name, else the first text one. */
export const titleField = coll => coll?.fields?.find(f => f.name === 'title' || f.name === 'name') || coll?.fields?.find(f => f.type === 'text')
export const titleOf = (coll, rec) => { const f = titleField(coll); return String((f && rec?.[f.name]) || rec?.title || rec?.id || '') }
/** The status field a board goes by (`by`, else the first status one). */
export const statusField = (coll, by) => coll?.fields?.find(f => (by ? f.name === by : f.type === 'status'))
const optLabel = (opts, v, lang) => say(opts?.find(o => o.value === v)?.label, lang) || String(v)
const emptyValue = v => v == null || v === '' || (Array.isArray(v) && !v.length)
export const TONES = ['neutral', 'info', 'progress', 'success', 'warning', 'danger']

/** A value in words (a card, a row). `refs`: { collection: [records] } for ref fields; `refTitle(coll, rec)`. */
export function valueText(f, v, lang, W, refs = {}, decl = null) {
  if (emptyValue(v)) return ''
  switch (f.type) {
    case 'bool': return v ? W.yes : W.no
    case 'select': return optLabel(f.options, v, lang)
    case 'status': return optLabel(f.values, v, lang)
    case 'tags': return v.map(x => optLabel(f.options, x, lang)).join(' · ')
    case 'datetime': return whenText(v, lang)
    case 'links': return v.map(l => l.label || l.url).join(' · ')
    case 'file':
    case 'image': return W.picked(Array.isArray(v) ? v.length : 1)
    case 'color': case 'date': case 'number': case 'text': case 'textarea': return String(v)
    default: {
      const rc = refColl(f), r = rc && (refs[rc] || []).find(x => x.id === v)
      return r ? titleOf(decl?.collections?.[rc], r) : ''
    }
  }
}
/** A record's fields as they start: each field's default. */
export const defaultsOf = coll => Object.fromEntries((coll?.fields || []).filter(f => f.default !== undefined).map(f => [f.name, f.default]))

/** An error from the studio (a { code, params }) in words, and the field it is about. */
export function errorOf(err, coll, lang, W) {
  const p = err?.params || {}, f = coll?.fields?.find(x => x.name === p.field), label = f ? say(f.label, lang) || f.name : p.field
  const detail = String(err?.message || '').split(': ').slice(1).join(': ')
  if (err?.code === 'required') return { field: p.field, text: W.required(label) }
  if (err?.code === 'badValue') return { field: p.field, text: W.badValue(label, detail) }
  if (err?.code === 'badRef') return { field: p.field, text: W.badRef(label) }
  return { field: null, text: W.unknown + (err?.message || String(err)) }
}

/** One field's input. */
export function FieldInput({ f, value, onChange, lang, W, studio, refs, decl, invalid }) {
  const id = `st-f-${f.name}`, cls = cx('st-in', invalid && 'st-in-bad')
  switch (f.type) {
    case 'text': return <input id={id} className={cls} value={value ?? ''} onChange={e => onChange(e.target.value)} />
    case 'textarea': return <textarea id={id} className={cx(cls, 'st-area')} rows={3} value={value ?? ''} onChange={e => onChange(e.target.value)} />
    case 'number': return <input id={id} className={cls} type="number" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))} />
    case 'bool': return (
      <button id={id} type="button" role="switch" aria-checked={!!value} className={cx('st-switch', value && 'on')} onClick={() => onChange(!value)}>
        <i aria-hidden="true" /><span>{value ? W.yes : W.no}</span>
      </button>
    )
    case 'select': return (
      <select id={id} className={cls} value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">{W.none}</option>
        {f.options.map(o => <option key={o.value} value={o.value}>{say(o.label, lang)}</option>)}
      </select>
    )
    case 'status': return (
      <div id={id} className="st-seg" role="radiogroup">
        {f.values.map(o => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(value === o.value && 'on')} onClick={() => onChange(o.value)}>
            <i className={`st-tone st-tone-${o.tone || 'neutral'}`} aria-hidden="true" />{say(o.label, lang)}
          </button>
        ))}
      </div>
    )
    case 'date': return <input id={id} className={cls} type="date" value={value ?? ''} onChange={e => onChange(e.target.value || null)} />
    case 'datetime': return <input id={id} className={cls} type="datetime-local" value={localInput(value)} onChange={e => onChange(fromLocalInput(e.target.value))} />
    case 'color': return (
      <span className="st-color">
        <input id={id} type="color" value={value || '#000000'} onChange={e => onChange(e.target.value)} />
        <input className={cx(cls, 'st-mono')} value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder="#rrggbb" />
      </span>
    )
    case 'tags': return <Tags f={f} value={value || []} onChange={onChange} lang={lang} W={W} />
    case 'links': return <Links value={value || []} onChange={onChange} W={W} />
    case 'file':
    case 'image': return <ImageField f={f} value={value} onChange={onChange} W={W} studio={studio} />
    default: {
      const rc = refColl(f), list = refs?.[rc] || []
      return (
        <select id={id} className={cls} value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
          <option value="">{W.none}</option>
          {list.map(r => <option key={r.id} value={r.id}>{titleOf(decl?.collections?.[rc], r)}</option>)}
        </select>
      )
    }
  }
}

function Tags({ f, value, onChange, lang, W }) {
  const [text, setText] = useState('')
  const toggle = v => onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v])
  if (f.options) {
    return <div className="st-chips">{f.options.map(o => <button key={o.value} type="button" aria-pressed={value.includes(o.value)} className={cx('st-chip', value.includes(o.value) && 'on')} onClick={() => toggle(o.value)}>{value.includes(o.value) && <Check size={12} />}{say(o.label, lang)}</button>)}</div>
  }
  const add = () => { const t = text.trim(); if (t && !value.includes(t)) onChange([...value, t]); setText('') }
  return (
    <div className="st-chips">
      {value.map(v => <span key={v} className="st-chip on">{v}<button type="button" aria-label="×" onClick={() => toggle(v)}><X size={11} /></button></span>)}
      <input className="st-in st-tag-in" value={text} placeholder={W.addTag} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ',' || e.key === '，') { e.preventDefault(); add() } }} onBlur={add} />
    </div>
  )
}

function Links({ value, onChange, W }) {
  const set = (i, patch) => onChange(value.map((l, k) => (k === i ? { ...l, ...patch } : l)))
  return (
    <div className="st-links">
      {value.map((l, i) => (
        <div key={i} className="st-link-row">
          <input className="st-in st-mono" value={l.url || ''} placeholder={W.linkUrl} onChange={e => set(i, { url: e.target.value })} />
          <input className="st-in" value={l.label || ''} placeholder={W.linkLabel} onChange={e => set(i, { label: e.target.value })} />
          <button type="button" className="st-icon-btn" aria-label="×" onClick={() => onChange(value.filter((_, k) => k !== i))}><X size={13} /></button>
        </div>
      ))}
      <button type="button" className="st-btn st-btn-quiet st-btn-sm" onClick={() => onChange([...value, { url: '' }])}><Plus size={13} />{W.linkAdd}</button>
    </div>
  )
}

/** An image field: the materials picked (their pictures), and picking from the studio's materials (or uploading one). */
function ImageField({ f, value, onChange, W, studio }) {
  const { materials } = useMaterials(studio)
  const [open, setOpen] = useState(false)
  const ids = f.multiple ? value || [] : value ? [value] : []
  const urlOf = id => materials.find(m => m.id === id)?.url
  return (
    <div className="st-imgs">
      {ids.map(id => (
        <span key={id} className={cx('st-img', f.type === 'file' && 'st-file')}>
          {f.type === 'file' ? <span className="st-file-name">{materials.find(m => m.id === id)?.name || id}</span> : urlOf(id) ? <img src={urlOf(id)} alt="" /> : <i />}
          <button type="button" aria-label="×" onClick={() => onChange(f.multiple ? ids.filter(x => x !== id) : null)}><X size={11} /></button>
        </span>
      ))}
      <button type="button" className="st-img-add" onClick={() => setOpen(true)}><ImagePlus size={16} /><span>{W.pick}</span></button>
      {open && <MaterialPicker kind={f.type === 'file' ? null : 'image'} studio={studio} W={W} multiple={!!f.multiple} chosen={ids} onClose={() => setOpen(false)} onPick={list => { onChange(f.multiple ? list : list[0] || null); setOpen(false) }} />}
    </div>
  )
}

/** The studio's pictures to pick from (and an upload); `multiple`: several. */
export function MaterialPicker({ studio, W, multiple, chosen, onPick, onClose, kind = 'image' }) {
  const { materials, upload } = useMaterials(studio)
  const [pick, setPick] = useState(chosen || []), [busy, setBusy] = useState(false)
  const file = useRef(null), note = useNote()
  const images = materials.filter(m => !kind || m.kind === kind)
  const toggle = id => setPick(p => (multiple ? (p.includes(id) ? p.filter(x => x !== id) : [...p, id]) : [id]))
  const up = async files => {
    setBusy(true)
    try { for (const f of files) { const m = await upload(f); if (m && (!kind || m.kind === kind)) toggle(m.id) } } catch (err) { note(W.unknown + err.message, 'error') }
    setBusy(false)
  }
  return (
    <Dialog title={W.pick} onClose={onClose} wide foot={<>
      <button type="button" className="st-btn st-btn-quiet" disabled={busy} onClick={() => file.current?.click()}><Upload size={14} />{busy ? W.uploading : W.upload}</button>
      <span className="st-grow" />
      <span className="st-quiet">{W.picked(pick.length)}</span>
      <button type="button" className="st-btn st-btn-primary" onClick={() => onPick(pick)}>{W.done}</button>
    </>}>
      <input ref={file} type="file" accept={kind === 'image' ? 'image/*' : undefined} multiple hidden onChange={e => { up([...e.target.files]); e.target.value = '' }} />
      {images.length ? (
        <div className="st-lib-grid st-pick-grid">
          {images.map(m => (
            <button key={m.id} type="button" className={cx('st-tile', pick.includes(m.id) && 'on')} aria-pressed={pick.includes(m.id)} onClick={() => toggle(m.id)}>
              {m.kind === 'image' ? <img src={m.url} alt="" loading="lazy" /> : <span className="st-file-kind">{m.kind}</span>}<span className="st-tile-name">{m.name}</span>{pick.includes(m.id) && <i className="st-tile-check"><Check size={13} /></i>}
            </button>
          ))}
        </div>
      ) : <div className="st-quiet">{W.emptyLibrary}</div>}
    </Dialog>
  )
}

/**
 * One record's form: new (`record` null: the fields' defaults, plus `preset`) or an existing one; in a dialog, or in the
 * page (`inline`: the form block). `api`: the collection's { put, remove, restore }. `startWith`: a start of the studio
 * from this collection — a second button saves and starts it. Saving says what is wrong next to its field.
 */
export function RecordDialog({ studio, decl, collName, record, preset, api, refs, lang, W, onClose, startWith = null, inline = false }) {
  const coll = decl.collections[collName], note = useNote()
  const fresh = () => (record ? { ...record } : { ...defaultsOf(coll), ...(preset || {}) })
  const [draft, setDraft] = useState(fresh)
  const canStart = startWith && canStartRecord(startWith, draft, coll)
  const before = useRef(record), editing = useRef(draft)
  editing.current = draft
  useEffect(() => {
    if (!inline) return
    if (before.current?.id === record?.id && Object.keys(recordPatch(coll, editing.current, before.current)).some(k => k !== 'id')) return
    before.current = record
    setDraft(fresh()); setErr(null); setVersions(null)
  }, [record?.id, record?.rev])
  const [err, setErr] = useState(null), [busy, setBusy] = useState(false), [versions, setVersions] = useState(null)
  const set = (name, v) => { setDraft(d => ({ ...d, [name]: v })); if (err?.field === name) setErr(null) }
  const collTitle = say(coll.title, lang)
  const clean = () => recordPatch(coll, draft, before.current)
  const save = async andStart => {
    if (andStart && !canStart) return
    setBusy(true); setErr(null)
    try {
      const saved = await api.put(clean())
      before.current = saved
      setDraft(d => ({ ...saved, ...recordPatch(coll, d, draft) }))
      if (andStart) {
        await start(studio, startWith.id, saved.id)
        note(W.started(titleOf(coll, saved)))
      } else note(W.saved)
      onClose(saved)
    } catch (e) { setErr(errorOf(e, coll, lang, W)) }
    setBusy(false)
  }
  const remove = async () => {
    try {
      await api.remove(record.id)
      note(W.removed, 'ok', { label: W.undo, run: () => api.restore(record.id).catch(e => note(W.unknown + e.message, 'error')) })
      onClose(null)
    } catch (e) { setErr(errorOf(e, coll, lang, W)) }
  }
  const showVersions = async () => {
    if (versions) return setVersions(null)
    try { setVersions(await history(studio, collName, record.id)) } catch (e) { setErr(errorOf(e, coll, lang, W)) }
  }
  const foot = (<>
      {record && <RemoveButton W={W} onRemove={remove} />}
      {record && <button type="button" className={cx('st-btn', 'st-btn-quiet', versions && 'on')} onClick={showVersions}>{W.versions}</button>}
      <span className="st-grow" />
      <button type="button" className="st-btn" onClick={() => onClose()}>{W.cancel}</button>
      <button type="button" className={cx('st-btn', canStart ? '' : 'st-btn-primary')} disabled={busy} onClick={() => save(false)}>{busy ? W.saving : W.save}</button>
      {canStart && <button type="button" className="st-btn st-btn-primary" disabled={busy} onClick={() => save(true)}>{W.startAndSave(say(startWith.label, lang))}</button>}
    </>)
  const body = (<>
      {err && !err.field && <div className="st-err">{err.text}</div>}
      <div className="st-form">
        {coll.fields.map(f => (
          <label key={f.name} className={cx('st-field', `st-field-${f.type.startsWith('ref:') ? 'ref' : f.type}`)} htmlFor={`st-f-${f.name}`}>
            <span className="st-label">{say(f.label, lang) || f.name}{f.required && <b aria-hidden="true">*</b>}</span>
            <FieldInput f={f} value={draft[f.name]} onChange={v => set(f.name, v)} lang={lang} W={W} studio={studio} refs={refs} decl={decl} invalid={err?.field === f.name} />
            {f.hint && <span className="st-hint">{say(f.hint, lang)}</span>}
            {err?.field === f.name && <span className="st-err-line">{err.text}</span>}
          </label>
        ))}
      </div>
      {versions && <Versions versions={versions} W={W} lang={lang} onUse={data => { setDraft({ ...data, id: record.id }); setVersions(null) }} />}
    </>)
  if (inline) return <div className="st-editor"><div className="st-editor-body">{body}</div><div className="st-dlg-foot">{foot}</div></div>
  return <Dialog title={record ? W.editOf(collTitle) : W.newOf(collTitle)} onClose={() => onClose()} foot={foot}>{body}</Dialog>
}

function Versions({ versions, W, lang, onUse }) {
  const list = useMemo(() => [...versions].sort((a, b) => (b.rev ?? b.at) - (a.rev ?? a.at)), [versions])
  if (!list.length) return <div className="st-quiet">{W.noVersions}</div>
  return (
    <ol className="st-versions">
      {list.map((v, i) => (
        <li key={`${v.rev}:${i}`}>
          <span>{W.versionAt(whenText(v.at, lang), v.by)}</span>
          {v.data && <button type="button" className="st-link" onClick={() => onUse(v.data)}>{W.useVersion}</button>}
        </li>
      ))}
    </ol>
  )
}

/** The records of every collection that some field points to, by collection (each loaded once, kept current). */
export function useRefs(decl) {
  const [refs, setRefs] = useState({})
  const colls = useMemo(() => [...new Set(Object.values(decl?.collections || {}).flatMap(c => (c.fields || []).map(refColl).filter(Boolean)))], [decl])
  return { refs, colls, setRef: (c, items) => setRefs(r => (r[c] === items ? r : { ...r, [c]: items })) }
}
/** Loads one collection for useRefs (a component, so the hooks stay the same however many there are). */
export function RefLoader({ studio, coll, onItems }) {
  const { items } = useCollection(studio, coll)
  useEffect(() => { onItems(coll, items) }, [items])
  return null
}
