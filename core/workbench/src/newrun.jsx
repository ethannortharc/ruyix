// The new-run form: pick a workflow (the core's blank, a pack's, one of the person's own that is enabled), then the
// request — a title, a text, attachments — and the fields that workflow's `input` declares. The server checks everything
// before it stores anything; what it refuses (`badInput`) is shown next to the field it is about. Whether the workflow
// is ready on this machine (what it needs: lib/needs.js) is shown before it starts: one that is not cannot start.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download, ExternalLink, Loader2, Paperclip, Play, Sparkles, Workflow, X } from 'lucide-react'
import { call } from './data.js'
import { bytes, cx, errorText, useT, useWorkflowData } from './ui.jsx'
import { WorkflowMap } from './wfmap.jsx'
import { RepeatChoices, WhenFields, formOf, scheduleOf } from './tasks.jsx'

/** A studio's records to pick one from (a `ref` field: an account of Plume 工作室…); none to pick — no studio here: nothing. */
function useRefOptions(ref) {
  const [options, setOptions] = useState(null)
  useEffect(() => {
    if (!ref) return
    let off = false
    call('refOptions', { studio: ref.studio, collection: ref.collection }).then(r => off || setOptions(r.options || []), () => off || setOptions([]))
    return () => { off = true }
  }, [ref?.studio, ref?.collection])
  return options
}
/** The row of a `ref` field: only when its studio has records to offer. */
function RefRow({ f, value, onChange, label, errs }) {
  const options = useRefOptions(f.ref)
  if (!options?.length) return null
  return (
    <div className={cx('wb-newfield', errs.length && 'wb-has-error')}>
      <label className="wb-label">{label}{f.required && <i className="wb-req"> *</i>}</label>
      <select className="wb-input" value={value ?? ''} onChange={e => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {errs.map((m, i) => <p key={i} className="wb-field-error">{m}</p>)}
    </div>
  )
}

const MAX_FILES = 20, MAX_BYTES = 25 << 20
const optionOf = o => (o && typeof o === 'object' ? { value: String(o.value), label: o.label ?? String(o.value) } : { value: String(o), label: String(o) })
const readFile = file => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve({ name: file.name, mime: file.type || undefined, size: file.size, base64: String(r.result).slice(String(r.result).indexOf(',') + 1) })
  r.onerror = () => reject(r.error)
  r.readAsDataURL(file)
})
const initialOf = f => (f.type === 'checkbox' ? f.default === true : f.type === 'multiselect' ? (Array.isArray(f.default) ? f.default : []) : f.default ?? '')

/** A file picker: the chosen files as chips, each removable. `files` are the ones of this picker. */
function Attach({ files, onAdd, onRemove, disabled }) {
  const t = useT()
  const input = useRef(null)
  return (
    <div className="wb-attach">
      <input ref={input} type="file" multiple hidden onChange={e => { onAdd([...e.target.files]); e.target.value = '' }} />
      <button type="button" className="wb-btn wb-small" disabled={disabled} onClick={() => input.current?.click()}><Paperclip size={13} />{t('new.addFiles')}</button>
      {files.map((f, i) => <span key={`${f.name}${i}`} className="wf-chip-on"><Paperclip size={11} />{f.name}<small>{bytes(f.size)}</small><button type="button" aria-label={t('wfc.removeSkill')} onClick={() => onRemove(f)}><X size={11} /></button></span>)}
    </div>
  )
}

/** `prefill`: what the form starts with ({ workflow, title, text, note, fields }: a run card of the conversation, to change). */
export function NewRun({ onClose, onStarted, onScheduled, toast, onNeeds, prefill = null, inline = false }) {
  const t = useT()
  const data = useWorkflowData()
  const [packs, setPacks] = useState([])
  useEffect(() => { call('packs').then(r => setPacks(r.packs), () => {}) }, [])
  // what a run may start on: the core's and the packs' built-in workflows, the person's own that are enabled
  const choices = useMemo(() => [
    ...(data?.builtIn || []).map(b => ({ ...b, group: b.pack || '' })),
    ...(data?.mine || []).filter(d => d.status === 'enabled').map(d => ({ id: d.id, title: d.title, description: d.description, input: data.builtIn.find(b => b.id === d.base)?.input || [], group: 'mine' })),
  ], [data])
  const [workflow, setWorkflow] = useState(() => prefill?.workflow || localStorage.getItem('ruyix-workbench.lastWorkflow') || '')
  const chosen = choices.find(c => c.id === workflow) || choices.find(c => c.id === 'blank') || choices[0]
  const input = chosen?.input || []
  const [title, setTitle] = useState(prefill?.title || '')
  const [text, setText] = useState(prefill?.text || '')
  const [note, setNote] = useState(prefill?.note || '')
  const [values, setValues] = useState({})
  const [files, setFiles] = useState([]) // { name, mime, size, base64, field? }
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState([]) // what the server refused, one text each
  // when it runs: now, once — or again and again (a scheduled task: lib/tasks.js)
  const [when, setWhen] = useState(() => ({ ...formOf(null), catchUp: true, carry: true, runNow: false }))
  const repeat = when.mode !== 'once'
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!repeat) return; const i = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(i) }, [repeat])
  // the workflow's defaults — or, on the workflow a card named, the card's fields
  useEffect(() => { setValues(Object.fromEntries(input.map(f => [f.name, chosen?.id === prefill?.workflow && prefill?.fields?.[f.name] !== undefined ? prefill.fields[f.name] : initialOf(f)]))); setProblems([]) }, [chosen?.id])
  // how the chosen workflow stands here: what is missing stops it; what installs itself is installed when it starts
  const [ready, setReady] = useState(null)
  useEffect(() => {
    setReady(null)
    if (!chosen?.id) return
    let live = true
    call('workflowReadiness', { id: chosen.id }).then(r => live && setReady(r), () => {})
    return () => { live = false }
  }, [chosen?.id])
  useEffect(() => { const k = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [])
  const fileFields = input.filter(f => f.type === 'files')
  const set = (name, v) => setValues(x => ({ ...x, [name]: v }))
  const add = async (list, field) => {
    const taken = files.length
    if (taken + list.length > MAX_FILES) return setProblems([t('new.tooMany', { n: MAX_FILES })])
    const big = list.find(f => f.size > MAX_BYTES)
    if (big) return setProblems([t('new.tooBig', { name: big.name, n: MAX_BYTES >> 20 })])
    try { const read = await Promise.all(list.map(readFile)); setFiles(x => [...x, ...read.map(f => ({ ...f, ...(field && { field }) }))]); setProblems([]) } catch (err) { setProblems([err.message]) }
  }
  const labelOf = f => f.label || f.name
  // the server's messages ("<label>: <what is wrong>"), by the field they name; the rest go on top
  const byField = useMemo(() => {
    const m = new Map(), rest = []
    for (const p of problems) {
      const f = input.find(x => p.startsWith(`${labelOf(x)}: `))
      if (f) m.set(f.name, [...(m.get(f.name) || []), p.slice(labelOf(f).length + 2)])
      else rest.push(p)
    }
    return { m, rest }
  }, [problems, chosen?.id])
  const start = async () => {
    setBusy(true); setProblems([])
    try {
      const fields = Object.fromEntries(input.filter(f => f.type !== 'files').map(f => [f.name, values[f.name]]))
      if (repeat) {
        const request = { workflow: chosen.id, title, text, note: note || undefined, fields, schedule: scheduleOf(when), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, catchUp: when.catchUp, carry: when.carry, runNow: when.runNow }
        const r = await call(prefill?.card ? 'chatDraftStart' : 'taskCreate', prefill?.card ? { n: prefill.card, request } : request)
        try { localStorage.setItem('ruyix-workbench.lastWorkflow', chosen.id) } catch { /* private window */ }
        if (r.run) onStarted(r.run)
        else onScheduled?.(r.task)
        setBusy(false)
        return
      }
      const request = { workflow: chosen.id, title, text, note: note || undefined, fields, attachments: files.map(({ name, mime, base64, field }) => ({ name, mime, base64, ...(field && { field }) })) }
      const { run } = await call(prefill?.card ? 'chatDraftStart' : 'startRun', prefill?.card ? { n: prefill.card, request } : request)
      try { localStorage.setItem('ruyix-workbench.lastWorkflow', chosen.id) } catch { /* private window */ }
      onStarted(run)
    } catch (err) {
      if (err.code === 'badInput' && err.params?.errors) setProblems(String(err.params.errors).split('; ').filter(Boolean))
      else if (err.code === 'workflowNotReady') setReady(r => ({ ...(r || { steps: [] }), missing: err.params?.n || 1, what: err.params?.what || err.message }))
      else toast('error', errorText(t, err))
    }
    setBusy(false)
  }
  const rank = g => (g === '' ? 0 : g === 'mine' ? 2 : 1)
  const groups = [...new Set(choices.map(c => c.group))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const groupName = g => (g === '' ? t('new.core') : g === 'mine' ? t('new.mine') : packs.find(p => p.id === g)?.name?.[t('lang.code')] || packs.find(p => p.id === g)?.name?.en || g)
  const field = f => {
    const errs = byField.m.get(f.name) || [], v = values[f.name]
    if (f.type === 'ref') return <RefRow key={f.name} f={f} value={v} onChange={x => set(f.name, x)} label={labelOf(f)} errs={errs} />
    return (
      <div key={f.name} className={cx('wb-newfield', errs.length && 'wb-has-error')}>
        <label className="wb-label">{labelOf(f)}{f.required && <i className="wb-req"> *</i>}</label>
        {f.type === 'text' && <input className="wb-input" value={v ?? ''} onChange={e => set(f.name, e.target.value)} />}
        {f.type === 'textarea' && <textarea className="wb-input" rows={4} value={v ?? ''} onChange={e => set(f.name, e.target.value)} />}
        {f.type === 'select' && (
          <select className="wb-input" value={v ?? ''} onChange={e => set(f.name, e.target.value)}>
            <option value="">—</option>
            {(f.options || []).map(optionOf).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {f.type === 'multiselect' && (
          <div className="wb-chips">{(f.options || []).map(optionOf).map(o => (
            <button key={o.value} type="button" className={cx('wb-chip', v?.includes(o.value) && 'wb-on')} onClick={() => set(f.name, v?.includes(o.value) ? v.filter(x => x !== o.value) : [...(v || []), o.value])}>{o.label}</button>
          ))}</div>
        )}
        {f.type === 'checkbox' && <label className="wb-check"><input type="checkbox" checked={!!v} onChange={e => set(f.name, e.target.checked)} />{t(v ? 'yes' : 'no')}</label>}
        {f.type === 'files' && <Attach files={files.filter(x => x.field === f.name)} onAdd={list => add(list, f.name)} onRemove={x => setFiles(l => l.filter(y => y !== x))} disabled={busy} />}
        {errs.map((m, i) => <p key={i} className="wb-field-error">{m}</p>)}
      </div>
    )
  }
  // (`inline`: in another's sheet — the 「任务」 page's, its own title and close — not a dialog of its own)
  const form = (
      <>
        {!data ? <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /> {t('loading')}</div> : (
          <>
            {groups.map(g => (
              <div key={g || 'core'}>
                {groups.length > 1 && <div className="wb-label">{groupName(g)}</div>}
                <div className="wb-modes wb-modes-3">
                  {choices.filter(c => c.group === g).map(c => {
                    const Icon = g === 'mine' ? Sparkles : Workflow
                    return <button key={c.id} type="button" className={cx('wb-mode', chosen?.id === c.id && 'wb-on')} onClick={() => setWorkflow(c.id)}><b><Icon size={14} />{c.title}</b><span>{c.description}</span></button>
                  })}
                </div>
              </div>
            ))}
            {/* how the chosen workflow does its work: its steps, who does each, where it waits for the person */}
            {chosen && <WorkflowMap wf={(data?.builtIn || []).find(b => b.id === chosen.id) || null} />}
            {ready?.missing > 0 && <div className="wb-note wb-t-red wb-note-stack"><span><AlertTriangle size={13} /> {t('wfn.preflight', { n: ready.missing })}</span><span className="wb-sub">{ready.what}</span>
              {onNeeds && <button type="button" className="wb-linkbtn" onClick={() => onNeeds(chosen.id, chosen.group === 'mine')}>{t('wfn.goFix')}<ExternalLink size={11} /></button>}</div>}
            {!ready?.missing && ready?.installable > 0 && <div className="wb-note wb-t-amber"><Download size={13} /> {t('wfn.willInstall', { n: ready.installable })}</div>}
            {byField.rest.length > 0 && <div className="wb-note wb-t-red wb-note-stack">{byField.rest.map((m, i) => <span key={i}>{m}</span>)}</div>}
            <label className="wb-label">{t('run.title')}</label>
            <input className="wb-input" autoFocus value={title} placeholder={t('run.titlePh')} onChange={e => setTitle(e.target.value)} />
            <label className="wb-label">{t('run.text')}</label>
            <textarea className="wb-input" rows={5} value={text} placeholder={t('run.textPh')} onChange={e => setText(e.target.value)} />
            {!fileFields.length && !repeat && (
              <>
                <label className="wb-label">{t('run.attachments')}</label>
                <Attach files={files.filter(x => !x.field)} onAdd={list => add(list)} onRemove={x => setFiles(l => l.filter(y => y !== x))} disabled={busy} />
              </>
            )}
            {input.map(field)}
            <label className="wb-label">{t('run.note')}</label>
            <textarea className="wb-input" rows={2} placeholder={t('run.notePh')} value={note} onChange={e => setNote(e.target.value)} />
            <label className="wb-label">{t('sch.when')}</label>
            <WhenFields form={when} setForm={setWhen} now={now} />
            {repeat && <RepeatChoices form={when} setForm={setWhen} runNow />}
            {repeat && files.length > 0 && <div className="wb-note wb-t-amber">{t('sch.noAttach')}</div>}
            <div className="wb-actions wb-end">
              <button className="wb-btn" onClick={onClose}>{t('run.cancel')}</button>
              <button className="wb-btn wb-primary" disabled={busy || !chosen || ready?.missing > 0} title={ready?.missing ? ready.what : undefined} onClick={start}>{busy ? <Loader2 size={13} className="wb-spin" /> : <Play size={13} />}{t(repeat ? 'sch.create' : 'run.start')}</button>
            </div>
          </>
        )}
      </>
  )
  if (inline) return <div className="wb-newrun wb-newrun-inline">{form}</div>
  return (
    <div className="wb-modal-wrap" onClick={onClose}>
      <div className="wb-modal wb-newrun" role="dialog" aria-modal="true" aria-label={t('run.new')} onClick={e => e.stopPropagation()}>
        <div className="wb-drawer-head"><h3>{t('run.new')}</h3><button className="wb-icon-btn" onClick={onClose}><X size={16} /></button></div>
        {form}
      </div>
    </div>
  )
}
