// Settings: the one page for what a person sets here. General (language, appearance), Models (the providers dsh's agents
// and the assistants run on, their keys, dsh's default model), each product's workbench settings (a tab its plugin puts
// in the slot 'ruyix.settings.tab'), Plugins (the release's own and those added) and Platform (the platform's few limits).
// dsh's own Settings and Plugins pages stay hidden; everything here reads and writes the same configuration
// (settings.js on the Host side). Another panel opens a tab with window event 'ruyix-settings:open' { tab }.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { TEXT } from './settings-text.js'
import { HOTKEY_DEFAULT, checkHotkey, hotkeyLabel, hotkeyOf } from '../voice-key.js'
import { Swatches } from './pending.jsx'
import { Info, Boxes, Check, Coins, Compass, Cpu, Fingerprint, Globe, History, KeyRound, ListChecks, Loader2, Mic, Monitor, Palette, Plus, RefreshCw, RotateCcw, SlidersHorizontal, Sparkles, Store, Trash2, TriangleAlert, Wrench } from 'lucide-react'
import { ACCENTS, AGENT_LOOKS, CNY_PER_USD, CORNERS, CURRENCIES, DENSITIES, SCALES, TINTS, TRANSPARENCY, WALLPAPERS, WALLPAPER_GROUPS, WINDOW_MODES } from '../desktop.js'
import { useWorlds } from './desktop/worlds.js'
import { ABOUT_EVENT, aboutLines } from './about.js'
import { ThemeCards, chooseTheme } from './desktop/themes.jsx'
import { paintThumb } from './desktop/wallpaper.js'

export const SETTINGS = 'ruyix-settings'
export const TAB_SLOT = 'ruyix.settings.tab'

export { TEXT }

const cx = (...c) => c.filter(Boolean).join(' ')
async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw Object.assign(new Error(data.params?.message || data.error || `HTTP ${res.status}`), { code: data.error || 'failed' })
  return data
}
const errText = (t, err) => t.err[err?.code] || `${t.err.failed}: ${err?.message || err}`
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/
const SPEECH = /asr|whisper|transcri|speech|sensevoice|paraformer|firered/i
/** Who can use a model endpoint, by its protocol (a pi-ai catalog provider: the protocol at its known address). */
const CATALOG_API = { openai: 'openai-responses', anthropic: 'anthropic-messages', deepseek: 'openai-completions', openrouter: 'openai-completions', groq: 'openai-completions', xai: 'openai-completions', mistral: 'openai-completions' }
const USERS = { 'openai-completions': ['pi', 'voice'], 'openai-responses': ['pi', 'codex'], 'anthropic-messages': ['pi', 'claude'] }
const usersOf = (id, p) => USERS[p.api || CATALOG_API[id]] || []
/** "Make an agent with it": Agent Hub's add form, a pi agent on this endpoint (pi takes every protocol). */
const newAgentOn = (id, p) => {
  const draft = { id: `pi-${id}`.slice(0, 40), name: `pi · ${p.displayName || id}`.slice(0, 60), runtime: 'pi', endpoint: id, model: p.models?.[0]?.id || null }
  window.__agentHubSeed = draft // (Agent Hub's page takes it when it opens; an open one hears the event)
  window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: 'agent-hub' } }))
  window.dispatchEvent(new CustomEvent('agent-hub:show', { detail: { seed: draft } }))
}
const keyEnv = id => `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`
const local = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } } }

function Seg({ value, options, onChange, label }) {
  return (
    <div className="fs-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={cx(value === v && 'fs-on')} onClick={() => value !== v && onChange(v)}>{text}</button>)}
    </div>
  )
}
const Card = ({ icon: I, title, aside, children, className }) => (
  <section className={cx('fs-card', className)}>
    {title && <header className="fs-card-head">{I && <span className="fs-card-icon"><I size={15} /></span>}<h3>{title}</h3>{aside && <span className="fs-grow" />}{aside}</header>}
    {children}
  </section>
)
const Row = ({ label, hint, children }) => <div className="fs-row"><div className="fs-row-label"><span>{label}</span>{hint && <small>{hint}</small>}</div><div className="fs-row-ctl">{children}</div></div>

/** Yuan to the dollar (desktop.json cnyPerUsd): saved on Enter or when it loses focus, if it is a rate it can be. */
function RateField({ value, label, save }) {
  const [v, setV] = useState(String(value))
  useEffect(() => { setV(String(value)) }, [value])
  const commit = () => { const n = Number(v); if (Number.isFinite(n) && n >= 1 && n <= 20 && n !== value) save(Math.round(n * 10000) / 10000); else setV(String(value)) }
  return <span className="fs-num"><input type="number" min="1" max="20" step="0.01" aria-label={label} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} /></span>
}

/** A number setting: saved on Enter or when it loses focus; "Default" when this profile overrides it. */
function NumField({ t, sec, path, scale = 1, unit, min = 0, edit }) {
  const raw = path.reduce((o, k) => o?.[k], sec?.value), mine = path.reduce((o, k) => o?.[k], sec?.user) !== undefined
  const [v, setV] = useState(raw === undefined ? '' : String(raw / scale))
  useEffect(() => { setV(raw === undefined ? '' : String(raw / scale)) }, [raw])
  const commit = () => { const n = Number(v); if (v !== '' && Number.isFinite(n) && n >= min && n * scale !== raw) edit(sec.ns, [{ op: 'set', path, value: Math.round(n * scale) }]) }
  return (
    <span className="fs-num">
      <input type="number" min={min} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} />
      {unit && <span className="fs-dim">{unit}</span>}
      {mine && <button type="button" className="fs-link" title={t.reset} onClick={() => edit(sec.ns, [{ op: 'unset', path }])}><RotateCcw size={12} />{t.reset}</button>}
    </span>
  )
}

/** A key: its state, a field to set a new one (never shown back), and removing it. */
function KeyField({ t, name, set, kept, onDone, setError }) {
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async value => {
    setBusy(true)
    try { await api('api/ruyix/credential', { name, value }); setV(''); onDone(value ? t.saved : t.remove) } catch (err) { setError(errText(t, err)) }
    setBusy(false)
  }
  return (
    <span className="fs-key">
      <span className={cx('fs-chip', set ? 'fs-ok' : 'fs-warn')}>{set ? <Check size={11} /> : <TriangleAlert size={11} />}{set ? t.models.keySet : t.models.keyMissing}</span>
      {set && kept === 'box' && <span className="fs-chip fs-warn" title={t.models.keyInBoxHint}>{t.models.keyInBox}</span>}
      <input type="password" autoComplete="off" spellCheck={false} placeholder={t.models.keyPh} value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && v.trim() && save(v.trim())} />
      <button type="button" className="fs-btn" disabled={busy || !v.trim()} onClick={() => save(v.trim())}>{t.save}</button>
      {set && <button type="button" className="fs-btn fs-quiet" disabled={busy} onClick={() => window.confirm(t.confirmRemove(name)) && save(null)}>{t.remove}</button>}
    </span>
  )
}

/** The models an endpoint (or pi-ai's catalog) offers, to pick from; those configured now come checked. */
/** Which of an endpoint's models it keeps (only those are shown and offered): the chosen first, a search when there are many. */
function ModelPicker({ t, models, chosen, setChosen }) {
  const [q, setQ] = useState('')
  const [first] = useState(() => new Set(chosen)) // (the order as it opened: what was chosen first, not moving while one ticks)
  if (!models.length) return <p className="fs-dim">{t.models.noModels}</p>
  const words = q.trim().toLowerCase()
  const shown = models.filter(m => !words || m.id.toLowerCase().includes(words)).sort((a, b) => first.has(b.id) - first.has(a.id))
  return (
    <>
    {models.length > 20 && (
      <div className="fs-pick-bar">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={t.models.findModel(models.length)} spellCheck={false} autoCapitalize="off" />
        <span className="fs-dim">{t.models.chosenN(chosen.size)}</span>
      </div>
    )}
    <div className="fs-picks">
      {shown.slice(0, 300).map(m => (
        <label key={m.id} className={cx('fs-pick', chosen.has(m.id) && 'fs-on')}>
          <input type="checkbox" checked={chosen.has(m.id)} onChange={() => { const n = new Set(chosen); n.has(m.id) ? n.delete(m.id) : n.add(m.id); setChosen(n) }} />
          <span className="fs-mono">{m.id}</span>{m.contextWindow ? <small className="fs-dim">{Math.round(m.contextWindow / 1000)}k</small> : null}
        </label>
      ))}
    </div>
    {shown.length > 300 && <p className="fs-dim">{t.models.moreModels(shown.length - 300)}</p>}
    </>
  )
}
const modelEntry = (m, was) => was || Object.fromEntries(Object.entries({ id: m.id, name: m.name && m.name !== m.id ? m.name : undefined, contextWindow: m.contextWindow, maxTokens: m.maxTokens }).filter(([, x]) => x !== undefined))

function Provider({ t, id, p, keySet, kept, isDefault, edit, note, setError }) {
  const [found, setFound] = useState(null)
  const [chosen, setChosen] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    setBusy(true)
    // (the ones ticked before stay on the list — first — even when the address no longer lists them: saving keeps them)
    try {
      const r = await api('api/ruyix/models', { provider: id }), listed = new Set(r.models.map(m => m.id))
      setFound([...(p.models || []).filter(m => !listed.has(m.id)), ...r.models]); setChosen(new Set((p.models || []).map(m => m.id)))
    } catch (err) { setError(errText(t, err)) }
    setBusy(false)
  }
  const keep = () => {
    if (!chosen.size) return setError(t.err.needModels)
    const was = new Map((p.models || []).map(m => [m.id, m]))
    edit('llm-pi-ai', [{ op: 'set', path: ['providers', id, 'models'], value: found.filter(m => chosen.has(m.id)).map(m => modelEntry(m, was.get(m.id))) }]).then(ok => ok && setFound(null))
  }
  return (
    <div className="fs-provider">
      <div className="fs-provider-head">
        <b>{p.displayName || id}</b>{p.displayName && <span className="fs-mono fs-dim">{id}</span>}
        {p.api && <span className="fs-chip">{t.models.kinds[p.api] || p.api}</span>}
        {isDefault && <span className="fs-chip fs-accent">{t.models.inUse}</span>}
        <span className="fs-grow" />
        <button type="button" className="fs-icon" title={t.remove} aria-label={t.remove} onClick={() => window.confirm(t.confirmRemove(id)) && edit('llm-pi-ai', [{ op: 'unset', path: ['providers', id] }])}><Trash2 size={14} /></button>
      </div>
      <Row label={t.models.endpoint}><span className="fs-mono fs-clip">{p.baseURL || <span className="fs-dim">{t.models.catalog}</span>}</span></Row>
      <Row label={t.models.users} hint={t.models.usersHint}>
        <span className="fs-wrap">
          <span className="fs-chip">{t.models.userNames.dsh}</span>
          {usersOf(id, p).map(u => <span key={u} className="fs-chip">{t.models.userNames[u]}</span>)}
          {usersOf(id, p).includes('pi') && <button type="button" className="fs-link" onClick={() => newAgentOn(id, p)}><Plus size={12} />{t.models.newAgent}</button>}
        </span>
      </Row>
      {p.apiKeyEnv && <Row label={t.models.key}><KeyField t={t} name={p.apiKeyEnv} set={keySet} kept={kept?.[p.apiKeyEnv]} onDone={note} setError={setError} /></Row>}
      <Row label={t.models.models}>
        <span className="fs-wrap">
          {(p.models || []).map(m => <span key={m.id} className="fs-chip fs-mono">{m.id}</span>)}
          {!p.models?.length && <span className="fs-dim">{t.models.catalog}</span>}
          <button type="button" className="fs-link" disabled={busy} onClick={refresh}>{busy ? <Loader2 size={12} className="fs-spin" /> : <ListChecks size={12} />}{t.models.refresh}</button>
        </span>
      </Row>
      {found && (
        <div className="fs-found">
          <span className="fs-dim">{t.models.pick}</span>
          <ModelPicker t={t} models={found} chosen={chosen} setChosen={setChosen} />
          <div className="fs-actions"><button type="button" className="fs-btn fs-primary" onClick={keep}>{t.save}</button><button type="button" className="fs-btn fs-quiet" onClick={() => setFound(null)}>{t.cancel}</button></div>
        </div>
      )}
    </div>
  )
}

/** A new provider: a pi-ai one by name (its key only), or an endpoint of a protocol; its models fetched, then picked. */
function AddProvider({ t, providers, edit, note, setError, preset = null, speech = false, onDone = null }) {
  // (preset: the voice card's — opened at once, filled in for a local speech server like omlx; speech: its speech models picked first)
  const [open, setOpen] = useState(!!preset)
  const [f, setF] = useState({ id: '', kind: 'openai-completions', baseURL: '', key: '', ...preset })
  const [found, setFound] = useState(null)
  const [chosen, setChosen] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const set = patch => { setF({ ...f, ...patch }); setFound(null) }
  const catalog = f.kind === 'catalog'
  const check = () => {
    if (!ID.test(f.id)) return t.err.badId
    if (providers[f.id]) return t.err.exists
    if (!catalog && !/^https?:\/\/\S+$/.test(f.baseURL.trim())) return t.err.needEndpoint
    return ''
  }
  const fetchModels = async () => {
    const bad = check()
    if (bad) return setError(bad)
    setBusy(true)
    try {
      const r = await api('api/ruyix/models', catalog ? { provider: f.id, apiKey: f.key.trim() || undefined } : { baseURL: f.baseURL.trim(), api: f.kind, apiKey: f.key.trim() || undefined })
      const spoken = speech ? r.models.filter(m => SPEECH.test(m.id)) : []
      setFound(r.models); setChosen(new Set((spoken.length ? spoken : r.models.slice(0, 12)).map(m => m.id)))
    } catch (err) { setError(errText(t, err)) }
    setBusy(false)
  }
  const add = async () => {
    if (!chosen.size) return setError(t.err.needModels)
    const env = keyEnv(f.id)
    const value = { apiKeyEnv: env, ...(!catalog && { api: f.kind, baseURL: f.baseURL.trim() }), models: found.filter(m => chosen.has(m.id)).map(m => modelEntry(m)) }
    setBusy(true)
    // the provider first: the key route takes only a key some provider names
    try {
      if (await edit('llm-pi-ai', [{ op: 'set', path: ['providers', f.id], value }])) {
        if (f.key.trim()) await api('api/ruyix/credential', { name: env, value: f.key.trim() })
        note(t.saved); setOpen(false); setF({ id: '', kind: 'openai-completions', baseURL: '', key: '' }); setFound(null)
        onDone?.(f.id)
      }
    } catch (err) { setError(errText(t, err)) }
    finally { setBusy(false) }
  }
  if (!open) return <button type="button" className="fs-add" onClick={() => setOpen(true)}><Plus size={15} />{t.models.add}</button>
  return (
    <div className="fs-provider fs-new">
      <div className="fs-form">
        <label className="fs-field"><span>{t.models.id}</span><input className="fs-mono" value={f.id} onChange={e => set({ id: e.target.value.trim().toLowerCase() })} placeholder="my-gateway" spellCheck={false} list="fs-catalog" /><small>{t.models.idHint}</small></label>
        <label className="fs-field"><span>{t.models.kind}</span>
          <select value={f.kind} onChange={e => set({ kind: e.target.value })}>{Object.entries(t.models.kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          {catalog && <small>{t.models.catalogHint}</small>}
        </label>
        {!catalog && <label className="fs-field fs-wide"><span>{t.models.endpoint}</span><input className="fs-mono" value={f.baseURL} onChange={e => set({ baseURL: e.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} /></label>}
        <label className="fs-field fs-wide"><span>{t.models.key}</span><input type="password" autoComplete="off" value={f.key} onChange={e => set({ key: e.target.value })} /><small>{t.models.keyNever}</small></label>
      </div>
      <datalist id="fs-catalog">{['openai', 'anthropic', 'google', 'openrouter', 'deepseek', 'groq', 'xai', 'mistral'].map(x => <option key={x} value={x} />)}</datalist>
      {found && <ModelPicker t={t} models={found} chosen={chosen} setChosen={setChosen} />}
      <div className="fs-actions">
        {found ? <button type="button" className="fs-btn fs-primary" disabled={busy} onClick={add}>{t.models.addGo}</button>
          : <button type="button" className="fs-btn fs-primary" disabled={busy || !f.id} onClick={fetchModels}>{busy ? <Loader2 size={13} className="fs-spin" /> : <RefreshCw size={13} />}{t.models.fetch}</button>}
        <button type="button" className="fs-btn fs-quiet" onClick={() => { setOpen(false); setFound(null); onDone?.(null) }}>{t.cancel}</button>
      </div>
    </div>
  )
}

function Models({ t, data, edit, note, setError, openPanel }) {
  const sec = ns => data.sections.find(s => s.ns === ns)
  const providers = sec('llm-pi-ai')?.value?.providers || {}, dflt = sec('agent-default-model')?.value || {}
  const choices = Object.entries(providers).flatMap(([id, p]) => (p.models || []).map(m => `${id}/${m.id}`))
  const current = dflt.provider && dflt.model ? `${dflt.provider}/${dflt.model}` : ''
  return (
    <>
      <p className="fs-lead">{t.models.lead.split(t.models.runtimes)[0]}<button type="button" className="fs-inline-link" onClick={() => openPanel('agent-hub')}>{t.models.runtimes}</button>{t.models.lead.split(t.models.runtimes)[1]}</p>
      <Card icon={Cpu} title={t.models.default}>
        <Row label={t.models.default} hint={t.models.defaultHint}>
          <select value={current} onChange={e => { const [provider, ...rest] = e.target.value.split('/'); edit('agent-default-model', [{ op: 'set', path: ['provider'], value: provider }, { op: 'set', path: ['model'], value: rest.join('/') }]) }}>
            {!choices.includes(current) && <option value={current}>{current || '—'}</option>}
            {choices.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Row>
      </Card>
      <Card icon={KeyRound} title={t.models.providers}>
        {!Object.keys(providers).length && <p className="fs-dim">{t.models.none}</p>}
        {Object.entries(providers).map(([id, p]) => <Provider key={id} t={t} id={id} p={p} keySet={!!data.keys[p.apiKeyEnv]} kept={data.kept} isDefault={dflt.provider === id} edit={edit} note={note} setError={setError} />)}
        <AddProvider t={t} providers={providers} edit={edit} note={note} setError={setError} />
      </Card>
    </>
  )
}

/** Who this workbench is — its name and colour in the browser tab and the sidebar, to tell several apart. Blank: its
 * workspace's name (or what it is for), a colour of the palette. */
function Identity({ t, lang, setError, note }) {
  const [l, setL] = useState(null), [name, setName] = useState(''), [setup, setSetup] = useState(null)
  // the home page leaves the sidebar once the required setup is done: it opens from here
  useEffect(() => { api('api/ruyix/setup').then(s => { const req = (s.steps || []).filter(x => x.required); setSetup({ all: req.length, left: req.filter(x => !x.ready).length }) }, () => {}) }, [])
  useEffect(() => { api('api/ruyix/layout').then(x => { setL(x); setName(x.identity?.own?.name || '') }, err => setError(errText(t, err))) }, [])
  // what was given here (own), not what shows: a blank name or colour stays the default
  const save = color => api('api/ruyix/layout', { identity: { name: name.trim(), color: color ?? l.identity?.own?.color ?? '' } })
    .then(x => { setL(x); note(t.saved); window.dispatchEvent(new CustomEvent('ruyix:layout')) }, err => setError(errText(t, err)))
  if (!l?.identity) return null
  const fallback = l.workspace || l.presets?.find(p => p.id === l.preset)?.title?.[lang] || l.preset
  return (
    <Card icon={Fingerprint} title={t.general.ident}>
      <Row label={t.general.identName} hint={t.general.identNameHint}>
        <span className="fs-key">
          <input value={name} maxLength={40} placeholder={fallback} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
          <button type="button" className="fs-btn" disabled={name.trim() === (l.identity.own?.name || '')} onClick={() => save()}>{t.save}</button>
        </span>
      </Row>
      <Row label={t.general.start} hint={!setup ? t.loading : setup.left ? t.general.startLeft(setup.left) : t.general.startDone(setup.all)}>
        <button type="button" className="fs-btn" onClick={() => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: 'ruyix-start' } }))}>{t.general.startOpen}</button>
      </Row>
      <Row label={t.general.identColor} hint={t.general.identSub(l.identity.sub)}>
        <span className="fs-swatches" role="radiogroup" aria-label={t.general.identColor}>
          {(l.palette || []).map(c => <button key={c} type="button" role="radio" aria-checked={l.identity.color === c} aria-label={c} className={cx('fs-swatch', l.identity.color === c && 'fs-on')} style={{ background: c }} onClick={() => save(c)} />)}
          {l.identity.own?.color && <button type="button" className="fs-btn fs-quiet" onClick={() => save('')}>{t.reset}</button>}
        </span>
      </Row>
    </Card>
  )
}

function General({ t, data, edit, locale, lang }) {
  const theme = data.sections.find(s => s.ns === 'ui-theme')
  return (
    <Card icon={SlidersHorizontal} title={t.general.look}>
      <Row label={t.general.language}><Seg label={t.general.language} value={lang} options={[['zh', '中文'], ['en', 'English']]} onChange={v => locale.setLocale(v)} /></Row>
      {theme && <Row label={t.general.theme}><Seg label={t.general.theme} value={theme.value?.preference || 'system'} options={['system', 'light', 'dark'].map(v => [v, t.general.themes[v]])} onChange={v => edit('ui-theme', [{ op: 'set', path: ['preference'], value: v }])} /></Row>}
      {theme && <Row label={t.general.fontSize}><Seg label={t.general.fontSize} value={theme.value?.fontSize || 14} options={[12, 13, 14, 15, 16].map(n => [n, String(n)])} onChange={v => edit('ui-theme', [{ op: 'set', path: ['fontSize'], value: v }])} /></Row>}
    </Card>
  )
}

/** desktop.json, saved at once, as two cards: the desktop (desktop or the classic sidebar, the wallpaper, motion) and the
 * system style (the interface's size, density, corners, accent, glass — docs/design/system-style.md), with a preview. */
/** The system style at a glance: what its dials change, drawn with the same classes as everywhere else. */
function StylePreview({ g }) {
  const [v, setV] = useState('a')
  return (
    <div className="fs-preview" aria-hidden="true">
      <div className="fs-preview-card">
        <b>{g.pv.title}</b>
        <span>{g.pv.text}</span>
        <input className="fs-preview-input" readOnly value={g.pv.field} tabIndex={-1} />
        <div className="fs-preview-row">
          <button type="button" className="fs-btn fs-primary" tabIndex={-1}>{g.pv.primary}</button>
          <button type="button" className="fs-btn" tabIndex={-1}>{g.pv.secondary}</button>
          <div className="fs-seg">{['a', 'b'].map(x => <button key={x} type="button" tabIndex={-1} className={cx(v === x && 'fs-on')} onClick={() => setV(x)}>{g.pv.seg[x]}</button>)}</div>
        </div>
      </div>
    </div>
  )
}

/** This system's versions (src/about.js's lines), and the window with them. */
function About({ t, lang }) {
  const [v, setV] = useState(null)
  useEffect(() => { fetch('api/ruyix/version').then(r => r.json()).then(setV, () => {}) }, [])
  return (
    <Card icon={Info} title={t.general.about} aside={<button type="button" className="fs-btn fs-quiet" onClick={() => window.dispatchEvent(new Event(ABOUT_EVENT))}>{t.general.aboutOpen}</button>}>
      {aboutLines(v, { commit: __RUYIX_COMMIT__, built: __RUYIX_BUILT__, lang }).map(([k, val]) => <Row key={k} label={k}><span className="fs-mono">{val}</span></Row>)}
    </Card>
  )
}
/** What each interactive desk is, in a line (a desk's own `blurb` comes first). */
const WORLD_BLURBS = {
  atlas: { zh: '纸上的古地图：每个页面是一座岛，任务在海上走', en: 'An old paper map: every page an island, tasks sailing between them' },
  sky: { zh: '星图：智能体是星，任务是星轨，消息是流星', en: 'A star map: agents are stars, tasks their orbits, messages meteors' },
  future: { zh: '未来的城市：从上往下看一座光的城', en: 'A future city of light, seen from above' },
}
function Desktop({ t, lang, setError, note }) {
  const worlds = useWorlds()
  const [d, setD] = useState(null), [file, setFile] = useState(''), [copied, setCopied] = useState(false)
  const walls = useRef(null)
  useEffect(() => { api('api/ruyix/layout').then(x => { setD(x.desktop || null); setFile(x.desktopFile || '') }, err => setError(errText(t, err))) }, [])
  // the file changed some other way (by hand, an agent's change applied, another browser): the card follows
  useEffect(() => { const on = e => e.detail?.desktop && setD(e.detail.desktop); window.addEventListener('ruyix:layout-changed', on); return () => window.removeEventListener('ruyix:layout-changed', on) }, [])
  useEffect(() => { walls.current?.querySelectorAll('canvas[data-w]').forEach(c => paintThumb(c, c.dataset.w)) }, [!!d, d?.mode]) // (the wallpapers show for the desktop only)
  const save = patch => api('api/ruyix/layout', { desktop: patch })
    .then(x => { setD(x.desktop); note(t.saved); window.dispatchEvent(new CustomEvent('ruyix:layout')) }, err => setError(errText(t, err)))
  if (!d) return null
  const g = t.general
  const Switch = ({ on, label, onChange }) => <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx('fs-switch', on && 'fs-on')} onClick={() => onChange(!on)} />
  return (
    <>
    <Card icon={Monitor} title={g.desk}>
      <Row label={g.mode} hint={g.modeHint}><Seg label={g.mode} value={d.mode} options={['desktop', 'classic', ...(worlds.length ? ['world'] : [])].map(v => [v, g.modes[v]])} onChange={v => save({ mode: v })} /></Row>
      {/* how windows take their place, on the desk and on a map (Ethan: 「窗口打开的时候，希望能排好，不要互相覆盖」) */}
      {d.mode !== 'classic' && <Row label={g.windows} hint={g.windowsHint}><Seg label={g.windows} value={d.windows || 'auto'} options={WINDOW_MODES.map(v => [v, g.windowModes[v]])} onChange={v => save({ windows: v })} /></Row>}
      {/* (interactive: the maps there are, each a card — a pick goes in; the desktop's own settings only for the desktop) */}
      {d.mode === 'world' && worlds.length > 0 && <Row label={g.world} hint={g.worldHint}>
        <div className="fs-worlds" role="radiogroup" aria-label={g.world}>
          {worlds.map(w => {
            const on = (worlds.some(x => x.id === d.world) ? d.world : worlds[0].id) === w.id
            return (
              <button key={w.id} type="button" role="radio" aria-checked={on} className={cx('fs-world', on && 'fs-on', `fs-world-${w.tone === 'light' ? 'light' : 'dark'}`)} onClick={() => save({ mode: 'world', world: w.id })}>
                <b>{w.name?.[lang] || w.name?.en || w.id}</b>
                <small>{w.blurb?.[lang] || WORLD_BLURBS[w.id]?.[lang] || ''}</small>
              </button>
            )
          })}
        </div>
      </Row>}
      {d.mode === 'desktop' && <>
      <Row label={g.deskTheme} hint={g.deskThemeHint}><ThemeCards lang={lang} T={{ ...g, theme: g.deskTheme }} desktop={d} onPick={id => chooseTheme(id, save, null)} /></Row>
      <Row label={g.wallpaper}>
        <div className="fs-walls" ref={walls} role="radiogroup" aria-label={g.wallpaper}>
          {WALLPAPER_GROUPS.map(gr => [
            <div key={gr} className="fs-wall-group">{g.wallGroups[gr]}</div>,
            ...WALLPAPERS.filter(w => w.group === gr).map(w => (
              <button key={w.id} type="button" role="radio" aria-checked={d.wallpaper === w.id} className={cx('fs-wall', d.wallpaper === w.id && 'fs-on')} onClick={() => save({ wallpaper: w.id })}>
                {w.c.length ? <canvas data-w={w.id} style={{ background: `linear-gradient(160deg, ${w.c[1]}, ${w.c[0]})` }} /> : <span className="fs-wall-plain" />}
                <span>{w[lang]}{w.live && <small>{g.live}</small>}</span>
              </button>
            )),
          ])}
        </div>
      </Row>
      <Row label={g.motion} hint={g.motionHint}><Switch on={d.motion} label={g.motion} onChange={v => save({ motion: v })} /></Row>
      <Row label={g.agents} hint={g.agentsHint}><Seg label={g.agents} value={d.agents || 'icon'} options={AGENT_LOOKS.map(v => [v, g.agentLooks[v]])} onChange={v => save({ agents: v })} /></Row>
      </>}
    </Card>
    <Card icon={Palette} title={g.style}>
      <Row label={g.size} hint={g.sizeHint}><Seg label={g.size} value={d.scale} options={SCALES.map(v => [v, v === 'auto' ? g.sizeAuto : `${Math.round(v * 100)}%`])} onChange={v => save({ scale: v })} /></Row>
      <Row label={g.density} hint={g.densityHint}><Seg label={g.density} value={d.density} options={Object.keys(DENSITIES).map(v => [v, g.densities[v]])} onChange={v => save({ density: v })} /></Row>
      <Row label={g.corners} hint={g.cornersHint}><Seg label={g.corners} value={d.corners} options={Object.keys(CORNERS).map(v => [v, g.cornerNames[v]])} onChange={v => save({ corners: v })} /></Row>
      <Row label={g.accent} hint={g.accentHint}>
        <span className="fs-swatches" role="radiogroup" aria-label={g.accent}>
          {ACCENTS.map(a => <button key={a.id} type="button" role="radio" aria-checked={d.accent === a.id} aria-label={a[lang]} title={a[lang]} className={cx('fs-swatch', d.accent === a.id && 'fs-on')} style={{ background: `light-dark(${a.light}, ${a.dark})` }} onClick={() => save({ accent: a.id })} />)}
        </span>
      </Row>
      <Row label={g.tint} hint={g.tintHint}><Seg label={g.tint} value={d.tint} options={Object.keys(TINTS).map(v => [v, g.tints[v]])} onChange={v => save({ tint: v })} /></Row>
      <Row label={g.glass} hint={g.glassHint}><Switch on={d.glass} label={g.glass} onChange={v => save({ glass: v })} /></Row>
      {d.glass && <Row label={g.transparency} hint={g.transparencyHint}><Seg label={g.transparency} value={d.transparency || 'light'} options={Object.keys(TRANSPARENCY).map(v => [v, g.transparencies[v]])} onChange={v => save({ transparency: v })} /></Row>}
      <Row label={g.preview} hint={g.previewHint}><StylePreview g={g} /></Row>
      {file && <Row label={g.file} hint={g.fileHint}>
        <span className="fs-key"><span className="fs-mono">{file}</span>
          <button type="button" className="fs-btn" onClick={() => navigator.clipboard?.writeText(file).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})}>{copied ? g.copied : g.copy}</button></span>
      </Row>}
    </Card>
    <Card icon={Coins} title={g.money}>
      <Row label={g.currency} hint={g.currencyHint}><Seg label={g.currency} value={d.currency || 'usd'} options={CURRENCIES.map(v => [v, g.currencies[v]])} onChange={v => save({ currency: v })} /></Row>
      {d.currency === 'cny' && <Row label={g.rate} hint={g.rateHint}><RateField value={d.cnyPerUsd || CNY_PER_USD} label={g.rate} save={v => save({ cnyPerUsd: v })} /></Row>}
    </Card>
    </>
  )
}

const RUNTIMES = { dsh: 'dsh', claude: 'Claude Code', codex: 'Codex', pi: 'pi' }
/**
 * The main agent (Agent Hub's): who answers what the person asks — the chat, ⌘K, voice — and works the system for them;
 * any agent of the pool. The main model: Ruyix's own small jobs (titles, summaries, memories, tidying spoken text);
 * it follows the main agent unless set apart. Without Agent Hub: nothing to show.
 */
function MainAgent({ t, setError, note, openPanel }) {
  const [m, setM] = useState(null)
  const load = () => api('api/agent-hub', { op: 'mainGet', choices: true }).then(setM, () => setM(false))
  useEffect(() => { load() }, [])
  const save = patch => api('api/agent-hub', { op: 'mainSet', ...patch }).then(() => { note(t.saved); return load() }, err => setError(errText(t, err)))
  if (!m) return null
  const g = t.general, byId = id => m.agents.find(a => a.id === id)
  const label = a => `${a.name} · ${RUNTIMES[a.runtime] || a.runtime}${a.model ? ` · ${a.model}` : ''}`
  const def = byId(m.defaultAgent), now = byId(m.resolved.agent)
  const groups = Object.keys(RUNTIMES).map(r => [r, m.agents.filter(a => a.runtime === r)]).filter(([, list]) => list.length)
  return (
    <Card icon={Sparkles} title={g.main}>
      <Row label={g.mainAgent} hint={g.mainAgentHint}>
        <select value={m.agent || ''} onChange={e => save({ agent: e.target.value || null })}>
          <option value="">{def ? g.mainAsDefault(label(def)) : g.mainNone}</option>
          {groups.map(([r, list]) => <optgroup key={r} label={RUNTIMES[r]}>{list.map(a => <option key={a.id} value={a.id}>{label(a)}</option>)}</optgroup>)}
        </select>
      </Row>
      <Row label={g.mainModel} hint={now && now.runtime !== 'dsh' && !m.model ? g.mainModelCli(RUNTIMES[now.runtime]) : g.mainModelHint}>
        <select value={m.model || ''} onChange={e => save({ model: e.target.value || null })}>
          <option value="">{g.mainFollow(m.resolved.model || g.mainDshDefault)}</option>
          {m.models.map(x => <option key={x} value={x}>{x}</option>)}
        </select>
      </Row>
      <Row label="">
        <button type="button" className="fs-btn" onClick={() => openPanel('agent-hub')}>{g.mainManage}</button>
      </Row>
    </Card>
  )
}

/**
 * Voice input (voice.js): which speech model turns speech into text — of a model endpoint (Settings → 模型, the one list
 * of where models come from; one can be added right here, filled in for omlx), or a connection set before — and in
 * which language.
 */
function Voice({ t, data, edit, setError, note }) {
  const [c, setC] = useState(null), [adding, setAdding] = useState(false)
  const load = () => api('api/ruyix/voice/config').then(setC, err => setError(errText(t, err)))
  useEffect(() => { load() }, [])
  // (the desk's voice input takes the new key at once: ruyix:voice-config)
  const save = patch => api('api/ruyix/voice/config', patch).then(x => { setC(x); note(t.saved); window.dispatchEvent(new CustomEvent('ruyix:voice-config', { detail: x })) }, err => setError(errText(t, err)))
  if (!c) return null
  const g = t.general, keyOf = x => `${x.kind}:${x.id}`
  const setKey = c.set.provider ? `provider:${c.set.provider}` : c.set.connection ? `connection:${c.set.connection}` : ''
  const usingKey = c.using ? (c.using.provider ? `provider:${c.using.provider}` : `connection:${c.using.connection}`) : ''
  const atKey = setKey || usingKey, at = c.choices.find(x => keyOf(x) === atKey)
  const models = [...new Set([...(at?.models || []), ...(c.set.model ? [c.set.model] : [])])]
  const pick = k => { const x = c.choices.find(y => keyOf(y) === k); if (x) save({ [x.kind]: x.id, model: x.models[0] || '', language: c.set.language }) }
  const eps = c.choices.filter(x => x.kind === 'provider'), conns = c.choices.filter(x => x.kind === 'connection')
  const label = x => `${x.name} (${x.models.length ? g.voiceModels(x.models.length) : g.voiceNoModels})`
  const providers = data?.sections?.find(x => x.ns === 'llm-pi-ai')?.value?.providers || {}
  return (
    <Card icon={Mic} title={g.voice}>
      <Row label={g.voiceNow} hint={g.voiceKeys}>
        {c.using ? <span className="fs-mono">{c.using.provider || c.using.connection} · {c.using.model}</span> : <span className="fs-dim">{g.voiceNone}</span>}
      </Row>
      <Row label={g.voiceSource} hint={g.voiceSourceHint}>
        <span className="fs-key">
          {c.choices.length > 0 && (
            <select value={atKey} onChange={e => pick(e.target.value)}>
              {!atKey && <option value="">—</option>}
              {eps.length > 0 && <optgroup label={g.voiceGroupEp}>{eps.map(x => <option key={keyOf(x)} value={keyOf(x)}>{label(x)}</option>)}</optgroup>}
              {conns.length > 0 && <optgroup label={g.voiceGroupConn}>{conns.map(x => <option key={keyOf(x)} value={keyOf(x)}>{label(x)}</option>)}</optgroup>}
            </select>
          )}
          {!adding && edit && <button type="button" className="fs-btn" onClick={() => setAdding(true)}><Plus size={13} />{g.voiceAddEp}</button>}
        </span>
      </Row>
      {adding && (
        <div className="fs-voice-add">
          <p className="fs-dim">{g.voiceAddHint}</p>
          <AddProvider t={t} providers={providers} edit={edit} note={note} setError={setError} speech preset={{ id: 'omlx', kind: 'openai-completions', baseURL: 'http://192.168.64.1:8000/v1' }}
            onDone={id => { setAdding(false); if (id) api('api/ruyix/voice/config').then(x => { setC(x); const m = x.choices.find(y => y.kind === 'provider' && y.id === id); if (m?.models.length) save({ provider: id, model: m.models[0], language: c.set.language }) }, () => {}) }} />
        </div>
      )}
      {at && (
        <Row label={g.voiceModel}>
          <select value={c.set.model || c.using?.model || ''} disabled={!models.length} onChange={e => save({ [at.kind]: at.id, model: e.target.value, language: c.set.language })}>
            {!models.length && <option value="">—</option>}
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </Row>
      )}
      <VoiceKey t={t} hotkey={c.hotkey} save={save} />
      <Row label={g.voiceLang}>
        <select value={c.set.language || 'auto'} onChange={e => save({ ...(c.set.provider && { provider: c.set.provider }), ...(c.set.connection && { connection: c.set.connection }), ...(c.set.model && { model: c.set.model }), language: e.target.value })}>
          {c.languages.map(l => <option key={l} value={l}>{g.voiceLangs[l] || l}</option>)}
        </select>
      </Row>
    </Card>
  )
}

/** Voice input's key (voice-key.js): how it reads, held or pressed, a new one taken by pressing it. */
function VoiceKey({ t, hotkey, save }) {
  const g = t.general
  const [catching, setCatching] = useState(false), [why, setWhy] = useState('')
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
  useEffect(() => {
    if (!catching) return
    window.__ruyixVoiceKeyCatching = true // (the desk's voice input stands aside meanwhile)
    let mod = null // a modifier key pressed alone: it is the key when it is let go with nothing else pressed
    const down = e => {
      e.preventDefault(); e.stopPropagation()
      if (e.code === 'Escape') return setCatching(false)
      const h = hotkeyOf(e, hotkey.mode)
      if (/^(Alt|Control|Meta|Shift)(Left|Right)$/.test(e.code)) { mod = h; return }
      mod = null
      const c = checkHotkey(h)
      if (!c.ok) return setWhy(g.voiceKeyPlain)
      setWhy(''); setCatching(false); save({ hotkey: c.hotkey })
    }
    const up = e => { if (mod && e.code === mod.code) { e.preventDefault(); setWhy(''); setCatching(false); save({ hotkey: mod }) } }
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true)
    return () => { window.__ruyixVoiceKeyCatching = false; window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true) }
  }, [catching])
  const isDefault = hotkey.code === HOTKEY_DEFAULT.code && !hotkey.mods.length && hotkey.mode === HOTKEY_DEFAULT.mode
  return (
    <>
      <Row label={g.voiceKey} hint={g.voiceKeyHint}>
        <span className="fs-key">
          {catching ? <span className="fs-chip fs-accent" role="status">{g.voiceKeyPress}</span> : <span className="fs-chip fs-mono">{hotkeyLabel(hotkey, { lang: t === TEXT.zh ? 'zh' : 'en', mac })}</span>}
          {!catching && <button type="button" className="fs-btn" onClick={() => { setWhy(''); setCatching(true) }}>{g.voiceKeyChange}</button>}
          {catching && <button type="button" className="fs-btn fs-quiet" onClick={() => setCatching(false)}>{t.cancel}</button>}
          {!catching && !isDefault && <button type="button" className="fs-link" onClick={() => save({ hotkey: null })}>{g.voiceKeyReset}</button>}
        </span>
        {why && <span className="fs-dim fs-warn-text">{why}</span>}
      </Row>
      <Row label={g.voiceKeyMode}>
        <Seg label={g.voiceKeyMode} value={hotkey.mode} options={[['hold', g.voiceKeyModes.hold], ['toggle', g.voiceKeyModes.toggle]]} onChange={mode => save({ hotkey: { ...hotkey, mode } })} />
      </Row>
    </>
  )
}

/** What this Ruyix is for (its layout's preset) and the plugins it loads: each on or off (ruyix writes it and restarts dsh
 * once nothing is at work). Adding, upgrading and removing one is `ruyix plugin`'s. */
function Plugins({ t, lang, setError }) {
  const [p, setP] = useState(null), [lay, setLay] = useState(null), [moving, setMoving] = useState(null)
  useEffect(() => {
    api('api/ruyix/plugins').then(setP, err => setError(errText(t, err)))
    api('api/ruyix/layout').then(setLay, () => setLay({ presets: [] }))
  }, [])
  const pick = preset => api('api/ruyix/layout', { preset }).then(l => { setLay(l); window.dispatchEvent(new CustomEvent('ruyix:layout')) }, err => setError(errText(t, err)))
  const toggle = (x, on) => {
    setMoving(x.name)
    api('api/ruyix/plugins', { action: on === x.default ? 'default' : on ? 'enable' : 'disable', name: x.name }).then(() => {
      // dsh restarts and the page reconnects; still here after a while: ruyix refused (something at work) — shown as it is
      setTimeout(() => { setMoving(null); api('api/ruyix/plugins').then(setP, () => {}) }, 25000)
    }, err => { setMoving(null); setError(errText(t, err)) })
  }
  const title = id => { const x = lay?.presets?.find(y => y.id === id); return x?.title?.[lang] || x?.title?.en || id }
  const Switch = ({ x }) => x.core ? <span className="fs-chip">{t.plugins.always}</span>
    : <label className="fs-switch" title={x.on ? t.plugins.turnOff : t.plugins.turnOn}><input type="checkbox" aria-label={x.name} checked={!!x.on} disabled={!!moving} onChange={e => toggle(x, e.target.checked)} /><span /></label>
  const State = ({ x }) => (
    <>
      {x.on === false && (x.default === false ? <span className="fs-chip" title={t.plugins.offByDefaultHint}>{t.plugins.offByDefault}</span> : <span className="fs-chip">{t.plugins.off}</span>)}
      <span className="fs-grow" />
      <Switch x={x} />
    </>
  )
  return (
    <>
      <p className="fs-lead">{t.plugins.lead}</p>
      {moving && <div className="fs-note" role="status"><Loader2 size={13} className="fs-spin" />{t.plugins.restarting(moving)}</div>}
      <Card icon={Compass} title={t.plugins.use}>
        {!lay ? <p className="fs-dim">{t.loading}</p>
          : lay.presets?.length ? <Row label={t.plugins.useLabel} hint={t.plugins.useHint}><Seg label={t.plugins.useLabel} value={lay.preset} options={lay.presets.map(x => [x.id, title(x.id)])} onChange={pick} /></Row>
              : <p className="fs-dim">{t.plugins.noPresets}</p>}
      </Card>
      <Card icon={Store} title={t.plugins.added}>
        {!p ? <p className="fs-dim">{t.loading}</p> : !p.added.length ? <p className="fs-dim">{t.plugins.noneAdded}</p> : p.added.map(x => (
          <div key={x.name} className="fs-plugin">
            <span className="fs-mono">{x.name}</span><span className="fs-chip fs-mono">{x.version}</span>
            {x.thirdParty && <span className="fs-chip fs-warn">{t.plugins.thirdParty}</span>}
            {x.available && <span className="fs-chip fs-accent">{t.plugins.available(x.available)}</span>}
            <State x={x} />
          </div>
        ))}
      </Card>
      <Card icon={Boxes} title={t.plugins.builtin}>
        {p?.release?.version && (
          <div className="fs-plugin fs-release">
            <b>{t.plugins.release(p.release.version)}</b><span className="fs-chip">{t.plugins.from[p.release.from] || p.release.from}</span>
          </div>
        )}
        {(p?.builtin || []).map(x => (
          <div key={x.name} className="fs-plugin">
            <span className="fs-mono">{x.name}</span><span className="fs-chip fs-mono">{x.version || '—'}</span>{x.linked && <span className="fs-chip">{t.plugins.linked}</span>}
            <State x={x} />
          </div>
        ))}
      </Card>
    </>
  )
}

function Advanced({ t, data, edit, note, setError }) {
  const sec = ns => data.sections.find(s => s.ns === ns)
  const shell = sec('bash-sandbox') || sec('pwsh-sandbox'), loop = sec('agent-loop'), sub = sec('subagent'), pick = sec('subagent-model-selection-settings'), web = sec('web-search-deepseek')
  const a = t.advanced, f = (s, path, extra) => <NumField t={t} sec={s} path={path} edit={edit} {...extra} />
  return (
    <>
      <p className="fs-lead">{a.lead}</p>
      <div className="fs-grid">
        {shell && <Card icon={Wrench} title={a.shell}>
          <Row label={a.timeout}>{f(shell, ['timeoutMs'], { scale: 1000, unit: a.units.s, min: 1 })}</Row>
          <Row label={a.maxTimeout}>{f(shell, ['maxTimeoutMs'], { scale: 1000, unit: a.units.s, min: 1 })}</Row>
          <Row label={a.output}>{f(shell, ['maxOutputBytes'], { scale: 1000, unit: a.units.kb, min: 1 })}</Row>
        </Card>}
        {loop && <Card icon={RefreshCw} title={a.loop}><Row label={a.parallel}>{f(loop, ['maxParallelToolCalls'], { min: 1 })}</Row></Card>}
        {sub && <Card icon={Boxes} title={a.sub}>
          <Row label={a.depth}>{f(sub, ['maxDepth'])}</Row>
          <Row label={a.active}>{f(sub, ['maxActiveSubagents'], { min: 1 })}</Row>
          {pick && <Row label={a.pickModel}><label className="fs-switch"><input type="checkbox" checked={!!pick.value?.enabled} onChange={e => edit(pick.ns, [{ op: 'set', path: ['enabled'], value: e.target.checked }])} /><span /></label></Row>}
        </Card>}
        {web && <Card icon={Globe} title={a.web}>
          <Row label={a.uses}>{f(web, ['maxUses'], { min: 1 })}</Row>
          <Row label={a.webKey}><KeyField t={t} name={web.value?.apiKeyEnv || 'DEEPSEEK_API_KEY'} set={!!data.keys[web.value?.apiKeyEnv || 'DEEPSEEK_API_KEY']} kept={data.kept?.[web.value?.apiKeyEnv || 'DEEPSEEK_API_KEY']} onDone={note} setError={setError} /></Row>
        </Card>}
      </div>
    </>
  )
}

/** Changes: every change to this Ruyix's surfaces (../surfaces.js) — an agent's or the person's — to apply, undo or go back to. */
function Changes({ t, lang, setError, note }) {
  const c = t.changes
  const [list, setList] = useState(null), [busy, setBusy] = useState(''), [open, setOpen] = useState({})
  // a row's diff is fetched when it is opened (the list carries none)
  const show = id => api(`api/ruyix/changes?id=${encodeURIComponent(id)}`).then(d => setOpen(o => ({ ...o, [id]: d })), err => setError(errText(t, err)))
  const asked = useState({ n: 0 })[0] // a newer read wins: an older answer that comes late is dropped
  const listRef = useState({ ok: false, busy: false })[0]
  const load = () => {
    const n = ++asked.n
    listRef.busy = true
    return api('api/ruyix/changes').then(d => { if (n === asked.n) { setList(d.changes); listRef.ok = true } }, err => { if (n === asked.n) { setError(errText(t, err)); listRef.ok = false } })
      .finally(() => { if (n === asked.n) listRef.busy = false })
  }
  useEffect(() => {
    load()
    const said = open => { window.__ruyixChangesList = open; window.dispatchEvent(new CustomEvent('ruyix:changes-list')) } // the page's card steps aside
    // a load that failed is tried again with the next poll (the version may not move)
    const again = () => { if (!listRef.ok && !listRef.busy) load() } // only after a failure, never over one still on its way
    window.addEventListener('ruyix:surfaces', load); window.addEventListener('ruyix:pending', again); said(true)
    return () => { window.removeEventListener('ruyix:surfaces', load); window.removeEventListener('ruyix:pending', again); said(false) }
  }, [])
  const act = async (op, id, digest) => {
    if (op === 'restore' && !window.confirm(c.confirmRestore)) return
    setBusy(`${op}:${id}`)
    // the page shows it at once (the theme, the sidebar): the shell reads the layout again
    try { await api('api/ruyix/changes', { op, id, ...(digest && { digest }) }); note(c.done[op]); window.dispatchEvent(new CustomEvent('ruyix:layout')) } catch (err) { setError(errText(t, err)) }
    setBusy(''); load()
  }
  const when = at => new Date(at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const Btn = ({ op, id, primary, children }) => (
    <button type="button" className={cx('fs-btn', primary && 'fs-primary')} disabled={!!busy} onClick={() => act(op, id, op === 'apply' ? open[id]?.digest : undefined)}>{busy === `${op}:${id}` && <Loader2 size={13} className="fs-spin" />}{children}</button>
  )
  return (
    <Card icon={History} title={c.title}>
      <p className="fs-lead">{c.lead}</p>
      {!list ? <p className="fs-dim">{t.loading}</p> : !list.length ? <p className="fs-dim">{c.none}</p> : list.map(x => (
        <div key={x.id} className="fs-change">
          <div className="fs-change-head">
            <b>{x.summary}</b>
            <span className={cx('fs-chip', x.state === 'applied' && 'fs-ok', x.state === 'proposed' && 'fs-accent')}>{c.state[x.state] || x.state}</span>
            <span className="fs-grow" />
            <span className="fs-dim">{when(x.undoneAt || x.appliedAt || x.at)}</span>
          </div>
          {open[x.id] ? <><Swatches colours={open[x.id].colours} />{open[x.id].diff.length > 0 && <pre className="fs-diff">{open[x.id].diff.join('\n')}</pre>}</>
            : <button type="button" className="fs-link" onClick={() => show(x.id)}>{c.see(x.files.length)}</button>}
          {x.state === 'proposed' && <div className="fs-actions">{open[x.id] && <Btn op="apply" id={x.id} primary>{c.apply}</Btn>}<Btn op="discard" id={x.id}>{c.discard}</Btn></div>}
          {x.state === 'applied' && <div className="fs-actions"><Btn op="undo" id={x.id}>{c.undo}</Btn><Btn op="restore" id={x.id}>{c.restore}</Btn></div>}
        </div>
      ))}
    </Card>
  )
}

export function SettingsPage({ locale, slots, renderSlot, layout }) {
  const active = useSyncExternalStore(fn => locale.subscribe(fn), () => locale.getSnapshot().active)
  const lang = String(active || 'en').startsWith('zh') ? 'zh' : 'en', t = TEXT[lang]
  // the products' tabs, as their plugins come and go
  const [, bump] = useState(0)
  useEffect(() => slots.subscribe(TAB_SLOT, () => bump(n => n + 1)), [])
  const products = slots.entries(TAB_SLOT).map(e => ({ id: e.options?.id, order: e.options?.order ?? 50, label: typeof e.options?.label === 'function' ? e.options.label() : e.options?.label })).filter(x => x.id).sort((a, b) => a.order - b.order)
  const tabs = [['general', t.tab.general], ['models', t.tab.models], ...products.map(p => [p.id, p.label]), ['plugins', t.tab.plugins], ['changes', t.tab.changes], ['advanced', t.tab.advanced]]
  const [tab, setTab] = useState(() => local.get('ruyix.settings.tab', 'general'))
  const shown = tabs.some(([id]) => id === tab) ? tab : 'general'
  const go = id => { setTab(id); local.set('ruyix.settings.tab', id) }
  useEffect(() => { const on = e => e.detail?.tab && go(e.detail.tab); window.addEventListener('ruyix-settings:show', on); return () => window.removeEventListener('ruyix-settings:show', on) }, [])

  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = () => api('api/ruyix/settings').then(d => { setData(d); setError('') }, err => setError(errText(t, err)))
  useEffect(() => { load() }, [])
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(''), 2400); return () => clearTimeout(id) }, [notice])
  const note = text => { setNotice(text); load() }
  /** One section's path edits, against the revision shown (a stale page is refused and shown again); true when saved. */
  const edit = async (ns, ops) => {
    try { await api('api/ruyix/settings', { ns, ops, revision: data.sections.find(s => s.ns === ns)?.revision }); note(t.saved); return true } catch (err) { setError(errText(t, err)); load(); return false }
  }
  const openPanel = id => { try { layout.selectPanel(id) } catch { /* that plugin is off */ } }
  const product = products.find(p => p.id === shown)
  return (
    <div className="fs-page">
      <header className="fs-head">
        <div><h1>{t.title}</h1><p>{t.sub}</p></div>
        <span className="fs-grow" />
        {notice && <span className="fs-notice" role="status"><Check size={13} />{notice}</span>}
      </header>
      <nav className="fs-tabs" role="tablist">
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={shown === id} className={cx('fs-tab', shown === id && 'fs-on')} onClick={() => go(id)}>{label}</button>)}
      </nav>
      {error && <div className="fs-error" role="alert"><TriangleAlert size={14} /><span>{error}</span><button type="button" className="fs-link" onClick={() => setError('')}>×</button></div>}
      <div className="fs-body">
        {product ? <div className="fs-product">{renderSlot(TAB_SLOT, {}, { only: product.id })}</div>
          : shown === 'plugins' ? <Plugins t={t} lang={lang} setError={setError} />
            : shown === 'changes' ? <Changes t={t} lang={lang} setError={setError} note={setNotice} />
            : !data ? <p className="fs-dim">{t.loading}</p>
              : shown === 'models' ? <Models t={t} data={data} edit={edit} note={note} setError={setError} openPanel={openPanel} />
                : shown === 'advanced' ? <Advanced t={t} data={data} edit={edit} note={note} setError={setError} />
                  : <><MainAgent t={t} setError={setError} note={setNotice} openPanel={openPanel} /><Voice t={t} data={data} edit={edit} setError={setError} note={setNotice} /><General t={t} data={data} edit={edit} locale={locale} lang={lang} /><Desktop t={t} lang={lang} setError={setError} note={setNotice} /><Identity t={t} lang={lang} setError={setError} note={setNotice} /><About t={t} lang={lang} /></>}
      </div>
    </div>
  )
}
