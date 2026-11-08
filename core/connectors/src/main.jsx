// The Connectors page: every service the workbench reaches, as cards — where it is, whether it works (tested here),
// which credentials it holds (never shown: set or not, the last four characters), who uses it — with adding, editing,
// signing in (a browser where dsh runs, shown here) and the record of recent calls.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowLeft, AtSign, Check, CheckCircle2, Container, ExternalLink, Eye, EyeOff, FileKey, GitMerge, Globe,
  HardDrive, KeyRound, Loader2, LogIn, Pencil, Plug, Plus, QrCode, RefreshCw, Save, Trash2, X, XCircle,
} from 'lucide-react'
import css from './styles.css'
// the product's semantic tokens (--ruyix-*), bundled so this plugin looks the same with the shell off
import tokens from '@ruyix/shell/tokens.css'
import { en, zh } from './locale.js'

const PANEL = 'connectors'
const NS = 'connectors'
const ICONS = { gitlab: GitMerge, k8s: Container, http: Globe, x: AtSign, pan123: HardDrive, baidupan: HardDrive }
const cx = (...n) => n.filter(Boolean).join(' ')
async function call(op, args) {
  const res = await fetch('api/connectors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...args }) })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok || data.error) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code, params: data.params })
  return data
}
const errText = (t, err) => {
  const key = err?.code && `err.${err.code}`
  const text = key && t(key, err.params || {})
  return text && text !== key ? text : err?.message || String(err)
}
let lang = 'zh'
const L = v => (v && typeof v === 'object' ? v[lang] || v.en : v || '')
const when = ts => (ts ? new Date(ts).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const stateOf = c => (!c.status ? 'untested' : c.status.unset ? 'unset' : c.status.ok ? 'ok' : 'failed')
// a card to show when the page opens (the inbox's System tab links one): kept until the page has its list
let focusId = null

function StatusPill({ t, c, testing }) {
  const s = testing ? 'testing' : stateOf(c)
  const Icon = { ok: CheckCircle2, failed: XCircle, unset: KeyRound, untested: Plug, testing: Loader2 }[s]
  return <span className={cx('cn-pill', `cn-${s}`)} title={c.status?.detail || ''}><Icon size={12} className={testing ? 'cn-spin' : ''} />{t(`state.${s}`)}</span>
}

// A sign-in in a browser where dsh runs (a host, a box), shown here: its screen comes up a few times a second; clicks, the
// wheel and keys go down; a paste is typed (a password). It closes itself once the site's session is kept.
const CONTROL_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])
function SigninDialog({ t, id, onClose, onDone }) {
  const [st, setSt] = useState({ status: 'starting' })
  const [frame, setFrame] = useState('')
  const [error, setError] = useState('')
  const owner = useRef(null)
  const seq = useRef(-1), img = useRef(null), pad = useRef(null)
  useEffect(() => {
    let alive = true, timer = null
    const mine = { id, attempt: Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-') }
    owner.current = mine
    seq.current = -1
    const poll = async () => {
      try {
        const r = await call('signinState', { ...mine, since: seq.current })
        if (!alive) return
        if (r.frame) { setFrame(r.frame); seq.current = r.seq }
        setSt(r)
        if (r.status === 'done') { onDone(r.kept || []); return }
        if (r.status !== 'running' && r.status !== 'starting') return
      } catch (err) { if (alive) setError(errText(t, err)) }
      if (alive) timer = setTimeout(poll, 350)
    }
    call('signinStart', mine).then(() => { if (alive) { pad.current?.focus(); poll() } else call('signinStop', mine).catch(() => {}) }, err => alive && setError(errText(t, err)))
    return () => { alive = false; clearTimeout(timer); if (owner.current === mine) { owner.current = null; queue.current.length = 0 } call('signinStop', mine).catch(() => {}) }
  }, [id])
  // one input at a time, in order; keys typed while one is on its way go together in the next (a remote page over a
  // slow link stays usable), and each answer brings the frame that shows it
  const queue = useRef([]), sending = useRef(false)
  const send = input => {
    const q = queue.current, last = q[q.length - 1]
    if (input.type === 'text' && last?.type === 'text' && last.attempt === owner.current?.attempt) last.text += input.text
    else q.push({ ...input, ...owner.current })
    if (sending.current) return
    sending.current = true
    ;(async () => {
      while (q.length) {
        const input = q.shift()
        try {
          const r = await call('signinInput', input)
          if (input.attempt !== owner.current?.attempt) continue
          if (r?.frame && r.seq > seq.current) { setFrame(r.frame); seq.current = r.seq }
        } catch (err) { if (input.attempt === owner.current?.attempt) setError(errText(t, err)) }
      }
      sending.current = false
    })()
  }
  const at = e => {
    const r = img.current.getBoundingClientRect(), v = st.view || { width: 1100, height: 720 }
    return { x: Math.round((e.clientX - r.left) * v.width / r.width), y: Math.round((e.clientY - r.top) * v.height / r.height) }
  }
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return // the browser's own shortcuts (and paste) stay
    if (e.key.length === 1) { e.preventDefault(); send({ type: 'text', text: e.key }) } else if (CONTROL_KEYS.has(e.key)) { e.preventDefault(); send({ type: 'key', key: e.key }) }
  }
  const running = st.status === 'running'
  return (
    <div className="cn-modal-wrap" onClick={onClose}>
      <div className="cn-modal cn-signin" onClick={e => e.stopPropagation()}>
        <div className="cn-modal-head">
          <h3><LogIn size={15} /> {t('si.title', { id })}</h3>
          {st.manual && <button className="cn-btn cn-small cn-primary" disabled={!running} onClick={() => send({ type: 'done' })}><Check size={12} />{t('si.confirm')}</button>}
          <button className="cn-icon-btn" title={t('si.back')} disabled={!running} onClick={() => send({ type: 'back' })}><ArrowLeft size={15} /></button>
          <button className="cn-icon-btn" title={t('close')} onClick={onClose}><X size={15} /></button>
        </div>
        <div className="cn-signin-url cn-mono">{st.url || '…'}</div>
        {error && <div className="cn-alert"><AlertTriangle size={13} /> {error}</div>}
        {st.status === 'timeout' && <div className="cn-alert cn-warn"><AlertTriangle size={13} /> {t('si.timeout')}</div>}
        {st.status === 'failed' && <div className="cn-alert"><XCircle size={13} /> {st.error || t('si.failed')}</div>}
        <div ref={pad} className={cx('cn-signin-screen', running && 'cn-live')} tabIndex={0} onKeyDown={onKey}
          onPaste={e => { const text = e.clipboardData.getData('text'); if (text) { e.preventDefault(); send({ type: 'text', text }) } }}>
          {frame ? <img ref={img} src={frame} alt="" draggable={false}
            onClick={e => { pad.current?.focus(); send({ type: 'click', ...at(e) }) }}
            onWheel={e => send({ type: 'wheel', ...at(e), dy: e.deltaY })} />
            : <div className="cn-signin-wait"><Loader2 size={18} className="cn-spin" /> {t('si.starting')}</div>}
        </div>
        <p className="cn-sub">{t('si.hint')}</p>
      </div>
    </div>
  )
}

/** Sign in by scanning a code (OAuth device code): the code and its picture, asked again until the person agrees. */
function DeviceDialog({ t, id, onClose, onDone }) {
  const [code, setCode] = useState(null)
  const [state, setState] = useState('starting')
  const [error, setError] = useState('')
  const [left, setLeft] = useState(0)
  const [round, setRound] = useState(0)
  useEffect(() => {
    let alive = true, timer = null
    setCode(null); setState('starting'); setError('')
    const poll = interval => {
      timer = setTimeout(async () => {
        try {
          const r = await call('devicePoll', { id })
          if (!alive) return
          if (r.state === 'pending') return poll(r.interval || interval)
          if (r.state === 'done') return onDone(r.test)
          setState(['stale', 'none'].includes(r.state) ? 'expired' : r.state); if (r.detail) setError(r.detail)
        } catch (err) { if (alive) { setState('failed'); setError(errText(t, err)) } }
      }, Math.max(5, interval) * 1000)
    }
    call('deviceStart', { id }).then(c => { if (!alive) return; if (c.state === 'stale') { setState('expired'); return } setCode(c); setState('waiting'); setLeft(c.expiresIn); poll(c.interval) }, err => { if (alive) { setState('failed'); setError(errText(t, err)) } })
    return () => { alive = false; clearTimeout(timer) }
  }, [id, round])
  useEffect(() => { if (state !== 'waiting') return undefined; const k = setInterval(() => setLeft(x => Math.max(0, x - 1)), 1000); return () => clearInterval(k) }, [state])
  return (
    <div className="cn-modal-wrap" onClick={onClose}>
      <div className="cn-modal cn-device" onClick={e => e.stopPropagation()}>
        <div className="cn-modal-head"><h3><QrCode size={15} /> {t('dv.title', { id })}</h3><button className="cn-icon-btn" onClick={onClose}><X size={14} /></button></div>
        {state === 'starting' && <p className="cn-sub"><Loader2 size={13} className="cn-spin" /> {t('dv.starting')}</p>}
        {code && state === 'waiting' && <>
          {code.qr ? <img className="cn-qr" src={code.qr} alt="" /> : null}
          <p className="cn-sub">{t(code.qr ? 'dv.scan' : 'dv.type')}</p>
          <div className="cn-device-code cn-mono">{code.userCode}</div>
          {code.verifyUrl && <a className="cn-link" href={code.verifyUrl} target="_blank" rel="noreferrer">{code.verifyUrl} <ExternalLink size={11} /></a>}
          <p className="cn-sub"><Loader2 size={12} className="cn-spin" /> {t('dv.waiting', { s: left })}</p>
        </>}
        {(state === 'expired' || state === 'failed') && <>
          <p className="cn-alert cn-warn"><AlertTriangle size={13} /> {state === 'expired' ? t('dv.expired') : t('dv.failed', { why: error })}</p>
          <button className="cn-btn cn-primary" onClick={() => setRound(round + 1)}><RefreshCw size={12} />{t('dv.again')}</button>
        </>}
      </div>
    </div>
  )
}

function SlotRow({ t, c, def, label, state, reload, toast, onSignin, onDevice }) {
  const signin = def.signin || c.signin === def.name // the type's sign-in keeps this credential
  const [edit, setEdit] = useState(null)
  const [plain, setPlain] = useState(false)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try { await call('setSlot', { id: c.id, slot: def.name, value: edit }); toast('ok', t('slot.saved', { slot: L(def.label) })); setEdit(null); reload() } catch (err) { toast('error', errText(t, err)) }
    setBusy(false)
  }
  const clear = async () => {
    if (!window.confirm(t('slot.clearConfirm', { id: c.id, slot: L(def.label) }))) return
    try { await call('clearSlot', { id: c.id, slot: def.name }); reload() } catch (err) { toast('error', errText(t, err)) }
  }
  const shown = !state?.set ? t('slot.unset') : state.vault ? t('slot.vault') : def.auto ? t('slot.set') : def.plain ? state.value : def.file ? t('slot.file') : `${t('slot.set')}${state.tail ? ` ··${state.tail}` : ''}`
  return (
    <div className={cx('cn-slot', !state?.set && def.required && 'cn-need')}>
      <div className="cn-slot-name">
        {def.file ? <FileKey size={13} /> : <KeyRound size={13} />}
        <span title={L(def.hint)}>{L(def.label)}</span>
        <i className={`cn-level cn-l-${def.level}`}>{t(`slot.level.${def.level}`)}</i>
        {!def.required && !state?.set && <small>{t('slot.optional')}</small>}
      </div>
      {edit == null ? (
        <div className="cn-slot-val">
          <span className={cx('cn-mono', !state?.set && 'cn-dim')}>{shown}</span>
          {signin && <button className="cn-btn cn-small cn-primary" onClick={onSignin}><LogIn size={12} />{label ? L(label) : t('slot.signin')}</button>}
          {def.device && <button className="cn-btn cn-small cn-primary" onClick={onDevice}><QrCode size={12} />{t(state?.set ? 'dv.redo' : 'dv.button')}</button>}
          {!def.signin && !def.auto && <button className="cn-btn cn-small" onClick={() => { setEdit(''); setPlain(!!def.plain) }}><Pencil size={12} />{t(state?.set ? 'slot.replace' : 'slot.fill')}</button>}
          {state?.set && <button className="cn-icon-btn" title={t('slot.clear')} onClick={clear}><Trash2 size={13} /></button>}
        </div>
      ) : (
        <div className="cn-slot-edit">
          {def.file
            ? <textarea className="cn-input cn-mono" rows={6} spellCheck={false} autoFocus placeholder={t('slot.pasteFile')} value={edit} onChange={e => setEdit(e.target.value)} />
            : <input className="cn-input cn-mono" type={plain ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} autoFocus placeholder={t('slot.paste')} value={edit}
              onChange={e => setEdit(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && edit.trim()) save(); if (e.key === 'Escape') setEdit(null) }} />}
          {!def.file && !def.plain && <button className={cx('cn-icon-btn', plain && 'cn-on')} title={t(plain ? 'slot.hide' : 'slot.show')} onClick={() => setPlain(!plain)}>{plain ? <EyeOff size={14} /> : <Eye size={14} />}</button>}
          <button className="cn-btn cn-small cn-primary" disabled={busy || !edit.trim()} onClick={save}>{busy ? <Loader2 size={12} className="cn-spin" /> : <Save size={12} />}{t('ed.save')}</button>
          <button className="cn-icon-btn" title={t('cancel')} onClick={() => setEdit(null)}><X size={14} /></button>
        </div>
      )}
      {def.hint && edit != null && <small className="cn-slot-hint">{L(def.hint)}</small>}
    </div>
  )
}

function ConnCard({ t, c, type, reload, toast, onEdit, onSignin, onDevice, onActivity }) {
  const [testing, setTesting] = useState(false)
  const Icon = ICONS[c.type] || Plug
  const test = async () => {
    setTesting(true)
    try { await call('test', { id: c.id }) } catch (err) { toast('error', errText(t, err)) }
    setTesting(false)
    reload()
  }
  const remove = async () => {
    if (!window.confirm(t('removeConfirm', { id: c.id }))) return
    try { await call('remove', { id: c.id }); toast('ok', t('removed', { id: c.id })); reload() } catch (err) { toast('error', errText(t, err)) }
  }
  const exp = c.status?.expiresIn
  return (
    <article id={`cn-${c.id}`} className={cx('cn-card', `cn-s-${stateOf(c)}`)}>
      <header className="cn-card-head">
        <span className={`cn-type-icon cn-t-${c.type}`}><Icon size={17} /></span>
        <div className="cn-card-title">
          <h3>{c.name}</h3>
          <span className="cn-mono">{c.id} · {L(type?.label)}</span>
        </div>
        <StatusPill t={t} c={c} testing={testing} />
      </header>
      {c.baseUrl && <a className="cn-url" href={c.baseUrl} target="_blank" rel="noreferrer"><Globe size={12} /><span>{c.baseUrl}</span><ExternalLink size={11} /></a>}
      {c.status && !c.status.ok && !testing && <div className="cn-card-note cn-bad">{c.status.detail}</div>}
      {c.status?.ok && c.status.detail && !testing && <div className="cn-card-note">{c.status.detail}</div>}
      {exp != null && exp < 14 && <div className="cn-card-note cn-warn"><AlertTriangle size={12} /> {exp < 0 ? t('expired') : t('expires', { n: exp })}</div>}
      <div className="cn-slots">
        {(type?.slots || []).map(def => <SlotRow key={def.name} t={t} c={c} def={def} label={type?.signin?.label} state={c.slots.find(s => s.name === def.name)} reload={reload} toast={toast} onSignin={() => onSignin(c.id)} onDevice={() => onDevice(c.id)} />)}
      </div>
      <div className="cn-meta">
        <span className="cn-meta-k">{t('usedBy')}</span>
        {c.usedBy.length ? c.usedBy.map(u => <span key={`${u.owner}-${L(u.label)}`} className="cn-chip">{u.owner}{u.label ? ` · ${L(u.label)}` : ''}</span>) : <span className="cn-dim">{t('unused')}</span>}
      </div>
      {c.hosts.length > 1 && <div className="cn-meta"><span className="cn-meta-k">{t('hosts')}</span>{c.hosts.map(h => <span key={h} className="cn-chip cn-mono">{h}</span>)}</div>}
      <footer className="cn-card-foot">
        <button className="cn-btn cn-small" disabled={testing} onClick={test}>{testing ? <Loader2 size={12} className="cn-spin" /> : <Plug size={12} />}{t('test')}</button>
        <button className="cn-btn cn-small" onClick={() => onActivity(c.id)}><Activity size={12} />{t('activity')}</button>
        {c.howTo && <a className="cn-btn cn-small" href={c.howTo} target="_blank" rel="noreferrer"><ExternalLink size={12} />{t('howTo')}</a>}
        <span className="cn-grow" />
        {c.status?.at && <small className="cn-dim">{t('testedAt', { at: when(c.status.at) })}</small>}
        <button className="cn-icon-btn" title={t('edit')} onClick={() => onEdit(c)}><Pencil size={13} /></button>
        <button className="cn-icon-btn" title={t('remove')} onClick={remove}><Trash2 size={13} /></button>
      </footer>
    </article>
  )
}

function Editor({ t, types, start, onClose, onSaved }) {
  const editing = !!start?.existing
  const [typeId, setTypeId] = useState(start?.type || '')
  const type = types.find(x => x.id === typeId)
  const [form, setForm] = useState(() => ({ id: start?.id || '', name: start?.name || '', baseUrl: start?.baseUrl || type?.baseUrl?.default || '', hosts: (start?.ownHosts || []).join(', '), fields: { ...Object.fromEntries((type?.fields || []).map(f => [f.name, f.default ?? ''])), ...(start?.fields || {}) } }))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setField = (k, v) => setForm(f => ({ ...f, fields: { ...f.fields, [k]: v } }))
  const pick = id => {
    const ty = types.find(x => x.id === id)
    setTypeId(id)
    setForm(f => ({ ...f, id: f.id || id, baseUrl: f.baseUrl || ty.baseUrl?.default || '', fields: Object.fromEntries(ty.fields.map(x => [x.name, f.fields[x.name] ?? x.default ?? ''])) }))
  }
  const save = async () => {
    setBusy(true); setError('')
    try {
      const out = await call('save', { connection: { id: form.id.trim(), type: typeId, name: form.name.trim() || undefined, baseUrl: form.baseUrl.trim(), hosts: form.hosts.split(/[\s,]+/).filter(Boolean), fields: form.fields } })
      onSaved(out.id)
    } catch (err) { setError(errText(t, err)) }
    setBusy(false)
  }
  const shows = f => !f.when || Object.entries(f.when).every(([k, v]) => (form.fields[k] ?? '') === v)
  return (
    <div className="cn-modal-wrap" onClick={onClose}>
      <div className="cn-modal cn-editor" onClick={e => e.stopPropagation()}>
        <div className="cn-modal-head">
          <h3>{editing ? <Pencil size={15} /> : <Plus size={15} />} {editing ? t('ed.editTitle', { id: start.id }) : t('ed.newTitle')}</h3>
          <button className="cn-icon-btn" title={t('close')} onClick={onClose}><X size={15} /></button>
        </div>
        {!type ? (
          <>
            <p className="cn-sub">{t('ed.pickType')}</p>
            <div className="cn-type-grid">
              {types.map(ty => { const Icon = ICONS[ty.id] || Plug; return (
                <button key={ty.id} className="cn-type-card" onClick={() => pick(ty.id)}>
                  <span className={`cn-type-icon cn-t-${ty.id}`}><Icon size={17} /></span>
                  <b>{L(ty.label)}</b><small>{L(ty.blurb)}</small>
                </button>
              ) })}
            </div>
          </>
        ) : (
          <div className="cn-form">
            <div className="cn-form-type">
              <span className={`cn-type-icon cn-t-${type.id}`}>{(() => { const Icon = ICONS[type.id] || Plug; return <Icon size={17} /> })()}</span>
              <div><b>{L(type.label)}</b><small>{L(type.blurb)}</small></div>
              {!editing && <button className="cn-btn cn-small" onClick={() => setTypeId('')}><ArrowLeft size={12} />{t('ed.back')}</button>}
            </div>
            <label><span>{t('ed.id')}</span><input className="cn-input cn-mono" disabled={editing} value={form.id} onChange={e => set('id', e.target.value.toLowerCase())} /><small>{t('ed.idHint')}</small></label>
            <label><span>{t('ed.name')}</span><input className="cn-input" value={form.name} placeholder={form.id} onChange={e => set('name', e.target.value)} /></label>
            {type.baseUrl?.from === 'kubeconfig'
              ? <label><span>{t('ed.url')}</span><input className="cn-input cn-mono" disabled value={form.baseUrl || t('ed.urlFromKubeconfig')} /></label>
              : <label><span>{t('ed.url')}</span><input className="cn-input cn-mono" value={form.baseUrl} placeholder={type.baseUrl?.example || type.baseUrl?.default || ''} onChange={e => set('baseUrl', e.target.value)} /></label>}
            {type.fields.filter(shows).map(f => (
              <label key={f.name}><span>{L(f.label)}</span>
                {f.options
                  ? <select className="cn-input" value={form.fields[f.name] ?? ''} onChange={e => setField(f.name, e.target.value)}>{f.options.map(o => <option key={o} value={o}>{o}</option>)}</select>
                  : <input className="cn-input cn-mono" value={form.fields[f.name] ?? ''} onChange={e => setField(f.name, e.target.value)} />}
                {f.hint && <small>{L(f.hint)}</small>}
              </label>
            ))}
            <label><span>{t('ed.hosts')}</span><input className="cn-input cn-mono" value={form.hosts} onChange={e => set('hosts', e.target.value)} /><small>{t('ed.hostsHint')}</small></label>
            {error && <div className="cn-alert"><AlertTriangle size={13} /> {error}</div>}
            {!editing && <p className="cn-sub">{t('ed.next')}</p>}
            <div className="cn-form-foot">
              <button className="cn-btn" onClick={onClose}>{t('cancel')}</button>
              <button className="cn-btn cn-primary" disabled={busy || !form.id.trim()} onClick={save}>{busy ? <Loader2 size={13} className="cn-spin" /> : <Save size={13} />}{t('ed.save')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ActivityDialog({ t, id, onClose }) {
  const [rows, setRows] = useState(null)
  useEffect(() => { call('audit', { id, limit: 200 }).then(r => setRows(r.entries), () => setRows([])) }, [id])
  return (
    <div className="cn-modal-wrap" onClick={onClose}>
      <div className="cn-modal cn-activity" onClick={e => e.stopPropagation()}>
        <div className="cn-modal-head">
          <h3><Activity size={15} /> {t('act.title', { id })}</h3>
          <button className="cn-icon-btn" title={t('close')} onClick={onClose}><X size={15} /></button>
        </div>
        <p className="cn-sub">{t('act.note')}</p>
        {!rows ? <div className="cn-sub"><Loader2 size={14} className="cn-spin" /> {t('loading')}</div> : !rows.length ? <div className="cn-empty">{t('act.empty')}</div> : (
          <div className="cn-table-wrap">
            <table className="cn-table">
              <thead><tr><th>{t('act.when')}</th><th>{t('act.level')}</th><th>{t('act.request')}</th><th>{t('act.status')}</th><th>{t('act.by')}</th></tr></thead>
              <tbody>{rows.map((r, i) => (
                <tr key={i}>
                  <td className="cn-nowrap">{when(r.at)}</td>
                  <td><i className={`cn-level cn-l-${r.level}`}>{t(`slot.level.${r.level}`)}</i></td>
                  <td className="cn-mono">{r.method} {r.path}{r.ms != null ? <small className="cn-dim"> · {r.ms} ms</small> : null}</td>
                  <td className={cx('cn-mono', r.status >= 400 && 'cn-bad')}>{r.status ?? ''}</td>
                  <td className="cn-mono cn-dim">{r.by || ''}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function ConnectorsPage({ t, locale, embedded = false }) {
  lang = String(locale?.getSnapshot?.().active || 'zh').startsWith('zh') ? 'zh' : 'en'
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null)
  const [signin, setSignin] = useState(null)
  const [device, setDevice] = useState(null)
  const [activity, setActivity] = useState(null)
  const [filter, setFilter] = useState('')
  const [notes, setNotes] = useState([])
  const toast = useCallback((kind, text) => {
    const id = Math.random()
    setNotes(n => [...n, { id, kind, text }])
    setTimeout(() => setNotes(n => n.filter(x => x.id !== id)), 4200)
  }, [])
  const load = useCallback(async () => {
    try { setData(await call('list')); setError('') } catch (err) { setError(errText(t, err)) }
  }, [t])
  useEffect(() => { load() }, [load])
  const testAll = async () => {
    setBusy(true)
    try { await call('testAll') } catch (err) { setError(errText(t, err)) }
    setBusy(false)
    load()
  }
  // a card asked for (the inbox): every type shown, the card in view and lit for a moment
  const [asked, setAsked] = useState(0)
  useEffect(() => { const on = () => setAsked(n => n + 1); window.addEventListener('connectors:focus', on); return () => window.removeEventListener('connectors:focus', on) }, [])
  useEffect(() => {
    if (!focusId || !data) return
    const id = focusId
    focusId = null
    setFilter('')
    requestAnimationFrame(() => { const el = document.getElementById(`cn-${id}`); if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('cn-flash'); setTimeout(() => el.classList.remove('cn-flash'), 1800) })
  }, [data, asked])
  const types = data?.types || []
  const list = useMemo(() => (data?.connections || []).filter(c => !filter || c.type === filter), [data, filter])
  const counts = useMemo(() => {
    const all = data?.connections || []
    return { ok: all.filter(c => stateOf(c) === 'ok').length, bad: all.filter(c => ['failed', 'unset'].includes(stateOf(c))).length, untested: all.filter(c => stateOf(c) === 'untested').length, total: all.length }
  }, [data])
  const missing = (data?.needs || []).filter(n => ['missing', 'wrongType'].includes(n.state))
  const presentTypes = [...new Set((data?.connections || []).map(c => c.type))]
  return (
    <div className={cx('cn-page', embedded && 'cn-embedded')}>
      <style>{tokens + css}</style>
      {/* a Settings tab (embedded): the Settings page has the title; the actions lead the tab */}
      <header className={embedded ? 'cn-bar' : 'cn-header'}>
        {embedded ? <span className="cn-sub cn-grow">{t('subtitle')}</span> : <>
          <span className="cn-glyph"><Plug size={18} /></span>
          <div className="cn-head-text"><h1>{t('title')}</h1><span className="cn-sub">{t('subtitle')}</span></div>
          <span className="cn-grow" />
        </>}
        <button className="cn-btn" disabled={busy} onClick={testAll}>{busy ? <Loader2 size={14} className="cn-spin" /> : <RefreshCw size={14} />}{t('testAll')}</button>
        <button className="cn-btn cn-primary" onClick={() => setEditing({})}><Plus size={14} />{t('add')}</button>
      </header>
      <main className="cn-main">
        <div className="cn-inner">
          {error && <div className="cn-alert"><AlertTriangle size={14} /> {error}</div>}
          {data?.inBox && <div className="cn-alert cn-info"><Container size={14} /> {t('boxNote')}</div>}
          {!data ? <div className="cn-sub"><Loader2 size={14} className="cn-spin" /> {t('loading')}</div> : (
            <>
              <section className="cn-summary">
                <div className="cn-tile cn-ok"><Check size={15} /><b>{counts.ok}</b><span>{t('sum.ok')}</span></div>
                <div className={cx('cn-tile', counts.bad ? 'cn-bad' : '')}><AlertTriangle size={15} /><b>{counts.bad}</b><span>{t('sum.attention')}</span></div>
                <div className="cn-tile"><Plug size={15} /><b>{counts.untested}</b><span>{t('sum.untested')}</span></div>
                <span className="cn-grow" />
                {presentTypes.length > 1 && (
                  <div className="cn-filters">
                    <button className={cx('cn-filter', !filter && 'cn-on')} onClick={() => setFilter('')}>{t('type.any')} · {counts.total}</button>
                    {presentTypes.map(id => <button key={id} className={cx('cn-filter', filter === id && 'cn-on')} onClick={() => setFilter(filter === id ? '' : id)}>{L(types.find(x => x.id === id)?.label)}</button>)}
                  </div>
                )}
              </section>
              {missing.length > 0 && (
                <section className="cn-needs">
                  <h2><AlertTriangle size={14} /> {t('need.title')}</h2>
                  {missing.map(n => (
                    <div key={`${n.owner}-${n.need}`} className="cn-need-row">
                      <span>{t('need.line', { owner: n.owner, label: L(n.label) || L(types.find(x => x.id === n.type)?.label), state: t(`need.${n.state}`, { id: n.connection || '?', type: L(types.find(x => x.id === n.type)?.label) }) })}</span>
                      {n.state === 'missing' && <button className="cn-btn cn-small cn-primary" onClick={() => setEditing({ type: n.type, id: n.connection || '' })}><Plus size={12} />{t('need.add')}</button>}
                    </div>
                  ))}
                </section>
              )}
              {!data.connections.length ? <div className="cn-empty">{t('empty')}</div> : (
                <section className="cn-grid">
                  {list.map(c => <ConnCard key={c.id} t={t} c={c} type={types.find(x => x.id === c.type)} reload={load} toast={toast}
                    onEdit={x => setEditing({ ...x, existing: true })} onSignin={setSignin} onDevice={setDevice} onActivity={setActivity} />)}
                </section>
              )}
            </>
          )}
        </div>
      </main>
      {editing && <Editor t={t} types={types} start={editing} onClose={() => setEditing(null)} onSaved={id => { setEditing(null); toast('ok', t('ed.saved', { id })); load() }} />}
      {signin && <SigninDialog t={t} id={signin} onClose={() => { setSignin(null); load() }} onDone={kept => { setSignin(null); toast('ok', t('si.done', { kept: kept.join(', ') })); load() }} />}
      {device && <DeviceDialog t={t} id={device} onClose={() => { setDevice(null); load() }} onDone={test => { setDevice(null); toast(test?.ok === false ? 'error' : 'ok', test?.ok === false ? t('dv.doneBad', { detail: test.detail || '' }) : t('dv.done', { detail: test?.detail || '' })); load() }} />}
      {activity && <ActivityDialog t={t} id={activity} onClose={() => setActivity(null)} />}
      <div className="cn-toasts">{notes.map(n => <div key={n.id} className={cx('cn-toast', `cn-${n.kind}`)}>{n.kind === 'ok' ? <Check size={13} /> : <AlertTriangle size={13} />}{n.text}</div>)}</div>
    </div>
  )
}

export const inject = ['slots', 'locale', 'layout']
/**
 * What needs a person here, for the inbox's System tab: from the last tests (hourly, and each change), read every two
 * minutes while someone looks. Rows: { key, tone: danger (broken for what uses it) | warning (breaks within three days)
 * | info, title, detail?, affects?, since?, actions: [{ label, primary?, run() }] }.
 */
function systemRows(t, locale, open) {
  let raw = null, rows = [], timer = null, busy = false
  const subs = new Set(), emit = () => subs.forEach(f => f())
  const TONE = { now: 'danger', soon: 'warning', later: 'info' }
  const shape = () => {
    if (!raw) return
    lang = String(locale.getSnapshot?.().active || 'zh').startsWith('zh') ? 'zh' : 'en'
    const typeOf = id => L(raw.types[id]) || id
    rows = raw.items.map(x => {
      const who = (x.usedBy || []).map(u => L(u.label) || u.owner)
      const go = { label: t(x.kind === 'expiring' ? 'sys.replace' : ['unset', 'failed'].includes(x.kind) && x.signin ? 'sys.signin' : x.kind === 'unset' ? 'sys.fill' : ['missing', 'wrongType'].includes(x.kind) ? 'sys.add' : 'sys.open'), primary: true, run: () => open(x.id) }
      const test = { label: t('sys.retest'), run: () => call('test', { id: x.id }).then(load) }
      return {
        key: x.key, tone: TONE[x.tone] || 'info',
        title: t(`sys.${x.kind}`, { name: x.name || x.id || '', type: typeOf(x.type), days: Math.max(0, x.days ?? 0), who: L(x.label) || x.owner || '' }),
        detail: x.kind === 'failed' ? x.detail : x.kind === 'unset' ? (x.signin ? t('sys.signinHint') : x.detail) : '',
        affects: who, since: x.at || null, actions: x.kind === 'failed' ? [test, go] : [go],
      }
    })
    emit()
  }
  async function load() {
    if (busy) return
    busy = true
    try { raw = await call('attention'); shape() } catch { /* the next read */ } finally { busy = false }
  }
  return {
    subscribe(f) {
      subs.add(f)
      if (subs.size === 1) { load(); timer = setInterval(load, 120e3) }
      const off = locale.subscribe?.(shape)
      return () => { subs.delete(f); off?.(); if (!subs.size) clearInterval(timer) }
    },
    getSnapshot: () => rows,
    refresh: load,
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'connectors: dictionaries')
  const t = ctx.locale.bind(NS)
  // a card of the page, from elsewhere: the Settings tab where the shell is (ruyix:open), else this page
  const open = id => {
    focusId = id || null
    window.dispatchEvent(new CustomEvent('connectors:focus'))
    if (window.__ruyixSettings) window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: PANEL } }))
    else try { ctx.layout.selectPanel(PANEL) } catch { /* layout not ready */ }
  }
  const rows = systemRows(t, ctx.locale, open)
  ctx.slots.inject('ruyix.inbox.system', () => ctx.slots.register({ name: 'ruyix.inbox.system', id: PANEL, order: 10, label: () => t('panel') }, () => null))
  ctx.effect(() => { (window.__ruyixInbox ||= {})[PANEL] = { items: rows }; return () => { delete window.__ruyixInbox[PANEL] } }, 'connectors: inbox rows') // a slot entry keeps only id, order, label
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS, inject: () => ({ t, locale: ctx.locale }) }, ConnectorsPage))
  // with the shell: a tab of its one Settings page — the connections are this machine's accounts and credentials, a
  // setting — and, by the same id, out of the sidebar; without the shell: the page of its own below
  ctx.slots.inject('ruyix.settings.tab', () => ctx.slots.register({ name: 'ruyix.settings.tab', id: PANEL, order: 20, locale: NS, label: () => t('panel'), inject: () => ({ t, locale: ctx.locale }) },
    props => <ConnectorsPage {...props} embedded />))
  // without it: in System
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 43, locale: NS, label: () => t('panel') }, ({ size }) => <Plug size={size || 16} strokeWidth={1.6} />))
}
