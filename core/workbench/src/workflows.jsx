// The Workflows page: every workflow as a card (the built-in ones and one's own, with a glance at their steps and how
// their runs went), a new one from a built-in template — and a workflow opened in the editor (wf-editor.jsx). A built-in workflow is code: its steps are fixed and how each runs is the
// person's to set; a workflow of one's own is built on one (lib/workflows.js), with steps, routes and branches of its own.
import { useEffect, useMemo, useRef, useState } from 'react'
import rfCss from '@xyflow/react/dist/style.css'
import { ReactFlowProvider } from '@xyflow/react'
import { AlertTriangle, CheckCircle2, Copy, Download, GitFork, Loader2, MoreHorizontal, Plug, Plus, Power, Search, Sparkles, Trash2, Workflow, X } from 'lucide-react'
import { NS, cacheWorkflows, call, local, successOf } from './data.js'
import { cx, dur, errorText, localizeWorkflows, useT } from './ui.jsx'
import { Editor } from './wf-editor.jsx'
import { copyOf, forkId } from './wf-model.js'

export function WorkflowsPage({ toast, openPanel, runs, onRun }) {
  const t = useT()
  const [raw, setData] = useState(null)
  const data = useMemo(() => localizeWorkflows(t, raw), [t, raw])
  const [error, setError] = useState('')
  // what is shown: the list or a workflow in the editor
  const [view, setView] = useState(() => { const v = local.get(`${NS}.wfView`, null); return v?.at === 'edit' && v.kind !== 'fresh' ? v : { at: 'list' } })
  const dirty = useRef(false)
  const navigation = useRef(0), opening = useRef(0), loading = useRef(0)
  const shownAt = navigation.current
  const load = () => {
    const request = ++loading.current
    return call('workflows').then(d => { if (request === loading.current) { cacheWorkflows(d); setData({ ...d, picks: d.picks || { steps: {}, stages: {} }, skills: d.skills || [], scripts: d.scripts || [] }) } return d }, err => { if (request === loading.current) setError(errorText(t, err)) })
  }
  useEffect(() => { load() }, [])
  const go = (v, force) => {
    if (!force && dirty.current && !window.confirm(t('wfc.discardConfirm'))) return false
    dirty.current = false
    navigation.current++; opening.current++
    v = v.kind === 'mine' ? { ...v, revision: v.revision || data?.mine.find(d => d.id === v.id)?.revision } : v
    setView(v)
    if (v.kind !== 'fresh') local.set(`${NS}.wfView`, v)
    return true
  }
  const toList = () => go({ at: 'list' })
  const open = (kind, id) => go({ at: 'edit', kind, id })
  /** A workflow of one's own from a built-in one (its picks kept); `insert`: the step a built-in workflow's + asked for. */
  const fork = (b, { insert, title, required } = {}) => {
    const id = forkId(b.id, [...data.mine, ...data.builtIn].map(d => d.id))
    const steps = b.library.filter(x => !required || !x.optional).map(x => ({ use: x.key, ...(data.picks.steps[b.id]?.[x.key] || {}) }))
    return go({ at: 'edit', kind: 'fresh', id, def: { id, title: title || t('wf.copyTitle', { title: b.title }), description: '', base: b.id, steps }, insert })
  }
  /** A copy of a workflow of one's own: all of it (its steps, agents, scripts, sign-offs, routes), a new id and title. */
  const duplicate = d => { const def = copyOf(d, data.mine.map(x => x.id), t('wf.copyTitle', { title: d.title })); return go({ at: 'edit', kind: 'fresh', id: def.id, def }) }
  const [creating, setCreating] = useState(false)
  // the Connectors page: a tab of the shell's Settings page where the shell is, else its own panel
  const openConnectors = () => (window.__ruyixSettings ? window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: 'connectors' } })) : openPanel('connectors'))
  // a workflow from another page: its editor, on the panel of its needs (the new-run form's "what is missing"), or as it
  // opens (`panel: null`: a workflow draft the conversation saved)
  useEffect(() => {
    const show = async e => {
      const d = e.detail || {}
      if (!d.workflow || !data) return
      const request = ++opening.current, at = navigation.current
      const mine = x => x.mine.some(m => m.id === d.workflow)
      const now = d.panel === null || !(mine(data) || data.builtIn.some(b => b.id === d.workflow)) ? await load() : data // (saved since the list was read)
      if (now && request === opening.current && at === navigation.current) go({ at: 'edit', kind: mine(now) ? 'mine' : 'builtin', id: d.workflow, revision: now.mine.find(m => m.id === d.workflow)?.revision, ...(d.panel !== null && { panel: d.panel || 'needs' }) })
    }
    window.addEventListener(`${NS}:needs`, show)
    return () => window.removeEventListener(`${NS}:needs`, show)
  }, [data])
  if (!data) return <div className="wf-page"><style>{rfCss}</style>{error ? <div className="wb-note wb-t-red"><AlertTriangle size={13} /> {error}</div> : <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /> {t('loading')}</div>}</div>
  const editing = view.at === 'edit' && (view.kind === 'fresh' || (view.kind === 'mine' ? data.mine.some(d => d.id === view.id) : data.builtIn.some(b => b.id === view.id)))
  return (
    <div className="wf-page wb-flow-page">
      <style>{rfCss}</style>
      {editing
        ? <ReactFlowProvider key={`${view.kind}:${view.id}:${view.revision || ''}:${view.insert ? 'i' : ''}`}>
          <Editor data={data} shown={view} runs={runs} toast={toast} openAgents={() => openPanel('agent-hub')} openConnectors={openConnectors} onBack={toList} onDirty={v => { dirty.current = v }} onRun={onRun}
            onFork={insert => fork(data.builtIn.find(b => b.id === view.id), { insert: insert || undefined })}
            onSaved={async id => { const now = await load(); if (id && view.kind === 'fresh' && navigation.current === shownAt) go({ at: 'edit', kind: 'mine', id, revision: now?.mine.find(d => d.id === id)?.revision }, true) }}
            onRemoved={async () => { await load(); if (navigation.current === shownAt) go({ at: 'list' }, true) }} />
        </ReactFlowProvider>
        : <Home data={data} runs={runs} toast={toast} open={open} fork={fork} duplicate={duplicate} reload={load} onNew={() => setCreating(true)} />}
      {creating && <NewWorkflow data={data} onClose={() => setCreating(false)} onCreate={(b, opts) => { setCreating(false); fork(b, opts) }} />}
    </div>
  )
}

// ── the list ──

function Home({ data, runs, toast, open, fork, duplicate, reload, onNew }) {
  const t = useT()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  // how each workflow's runs went
  const stats = useMemo(() => {
    const m = new Map()
    for (const r of runs?.values() || []) {
      const s = m.get(r.template) || { n: 0, done: 0, ok: 0, last: 0 }
      s.n++; s.last = Math.max(s.last, r.createdAt || 0)
      if (['done', 'failed'].includes(r.status)) { s.done++; if (r.status === 'done' && r.verdict?.level === successOf(r, data)) s.ok++ }
      m.set(r.template, s)
    }
    return m
  }, [runs, data])
  const now = Date.now()
  const cards = [
    ...data.mine.map(d => ({ kind: 'mine', id: d.id, title: d.title, desc: d.description || t('wf.basedOn', { base: data.builtIn.find(b => b.id === d.base)?.title || d.base }), status: d.status, revision: d.revision, errors: d.errors.length, steps: d.steps, base: d.base, ready: d.ready })),
    ...data.builtIn.map(b => ({ kind: 'builtin', id: b.id, title: b.title, desc: b.description, status: 'builtin', errors: 0, steps: b.library.map(x => ({ use: x.key, base: x })), base: b.id, ready: b.ready })),
  ].filter(c => (filter === 'all' || (filter === 'builtin' ? c.kind === 'builtin' : filter === 'mine' ? c.kind === 'mine' : c.status === 'draft'))
    && (!q.trim() || `${c.title} ${c.desc} ${c.id}`.toLowerCase().includes(q.trim().toLowerCase())))
  const act = async (op, args) => { try { await call(op, args); await reload() } catch (err) { toast('error', errorText(t, err)) } }
  return (
    <div className="wf-home">
      <header className="wf-home-head">
        <div className="wf-home-title">
          <span className="wf-home-mark"><Workflow size={18} /></span>
          <div><h2>{t('nav.workflows')}</h2><p>{t('wfc.homeHint')}</p></div>
        </div>
        <div className="wf-home-actions">
          <label className="wf-search"><Search size={14} /><input value={q} placeholder={t('wfc.searchWorkflows')} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQ('')} /></label>
          <button className="wb-btn wb-primary" onClick={onNew}><Plus size={14} />{t('wfc.newWorkflow')}</button>
        </div>
      </header>
      <div className="wf-home-body">
        <div className="wf-filters">
          {['all', 'builtin', 'mine', 'draft'].map(f => <button key={f} className={cx('wf-filter', filter === f && 'wf-on')} onClick={() => setFilter(f)}>{t(`wfc.filter.${f}`)}</button>)}
        </div>
        <div className="wf-grid">
          {cards.map(c => {
            const s = stats.get(c.id), Icon = c.kind === 'builtin' ? Workflow : Sparkles
            return (
              <article key={`${c.kind}:${c.id}`} className={cx('wf-card', c.kind === 'mine' && 'wf-card-own')} tabIndex={0} onClick={() => open(c.kind, c.id)} onKeyDown={e => e.key === 'Enter' && open(c.kind, c.id)}>
                <div className="wf-card-top">
                  <span className={cx('wf-card-icon', c.kind === 'mine' && 'wf-own')}><Icon size={17} /></span>
                  <div className="wf-card-name"><b>{c.title}</b>
                    <span><span className={cx('wf-pill', { builtin: 'wf-pill-builtin', enabled: 'wf-pill-on', draft: 'wf-pill-draft' }[c.status])}>{t(`wf.status.${c.status}`)}</span>
                      {c.errors > 0 && <span className="wf-pill wf-pill-new"><AlertTriangle size={10} />{t('wf.problems', { n: c.errors })}</span>}
                      <ReadyPill ready={c.ready} /></span></div>
                  <CardMenu c={c} onCopy={() => (c.kind === 'mine' ? duplicate(data.mine.find(d => d.id === c.id)) : fork(data.builtIn.find(b => b.id === c.base)))}
                    onStatus={st => act('workflowStatus', { id: c.id, status: st, expect: c.revision })} onRemove={() => window.confirm(t('wf.removeConfirm', { title: c.title })) && act('workflowRemove', { id: c.id, expect: c.revision })} />
                </div>
                <p className="wf-card-desc">{c.desc}</p>
                <MiniFlow steps={c.steps} />
                <div className="wf-card-foot">
                  <span>{t('wf.stepsN', { n: countSteps(c.steps) })}</span>
                  {s ? <><span>{t('wfc.runsN', { n: s.n })}</span>{s.done > 0 && <span className={cx(s.ok / s.done >= 0.6 ? 'wb-c-green' : 'wb-c-amber')}>{t('wfc.successRate', { p: Math.round((100 * s.ok) / s.done) })}</span>}<span className="wf-push">{t('ago', { t: dur(now - s.last) })}</span></>
                    : <span className="wf-push wb-dim">{t('wfc.noRunsYet')}</span>}
                </div>
              </article>
            )
          })}
          <button className="wf-card wf-card-new" onClick={onNew}><Plus size={20} /><b>{t('wfc.newWorkflow')}</b><small>{t('wfc.newHint')}</small></button>
        </div>
        <p className="wf-home-foot">{t('wf.assistantHint')}</p>
      </div>
    </div>
  )
}
const countSteps = steps => steps.reduce((n, s) => n + (s.use === 'branch' ? 1 + s.routes.reduce((m, r) => m + (r.steps?.length || 0), 0) + (s.otherwise?.steps?.length || 0) : s.use === 'parallel' ? 1 + s.lanes.reduce((m, l) => m + (l.steps?.length || 0), 0) : 1), 0)

/** A workflow at a glance: a dot per step (the system's, an agent's, one's own), a fork for a branch or a parallel block. */
function MiniFlow({ steps }) {
  const kind = s => (s.base ? (s.base.agent || s.base.model ? 'agent' : 'system') : ['branch', 'parallel'].includes(s.use) ? 'branch' : ['agent', 'model', 'script', 'approval', 'person'].includes(s.use) ? 'own' : 'base')
  return <div className="wf-mini" aria-hidden>{steps.slice(0, 30).map((s, i) => <i key={i} className={`wf-mi wf-mi-${kind(s)}`} />)}{steps.length > 30 && <span>+{steps.length - 30}</span>}</div>
}

/** How a workflow stands on this machine (what it needs): missing (a run will not start), to install, or ready. */
export function ReadyPill({ ready }) {
  const t = useT()
  if (!ready) return null
  if (ready.missing) return <span className="wf-pill wf-pill-new" title={ready.what}><Plug size={10} />{t('wfn.missing', { n: ready.missing })}</span>
  if (ready.installable) return <span className="wf-pill wf-pill-draft" title={ready.what}><Download size={10} />{t('wfn.installable', { n: ready.installable })}</span>
  return <span className="wf-pill wf-pill-on" title={t('wfn.readyHint')}><CheckCircle2 size={10} />{t('wfn.ready')}</span>
}

function CardMenu({ c, onCopy, onStatus, onRemove }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const stop = e => e.stopPropagation()
  return (
    <span className="wf-card-menu" onClick={stop} onKeyDown={stop}>
      <button className="wb-icon-btn" aria-label={t('wfc.more')} onClick={() => setOpen(!open)}><MoreHorizontal size={15} /></button>
      {open && <>
        <div className="wf-scrim" onClick={() => setOpen(false)} />
        <div className="wf-menu" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); onCopy() }}><Copy size={13} /><span><b>{t(c.kind === 'builtin' ? 'wf.copy' : 'wfc.duplicate')}</b></span></button>
          {c.kind === 'mine' && <button role="menuitem" disabled={c.status !== 'enabled' && c.errors > 0} onClick={() => { setOpen(false); onStatus(c.status === 'enabled' ? 'draft' : 'enabled') }}><Power size={13} /><span><b>{t(c.status === 'enabled' ? 'wf.disable' : 'wf.enable')}</b></span></button>}
          {c.kind === 'mine' && <button role="menuitem" className="wf-menu-danger" onClick={() => { setOpen(false); onRemove() }}><Trash2 size={13} /><span><b>{t('wf.remove')}</b></span></button>}
        </div>
      </>}
    </span>
  )
}

/** A new workflow: which built-in one it starts from, its name, all of its steps or only the required ones. */
function NewWorkflow({ data, onClose, onCreate }) {
  const t = useT()
  const [base, setBase] = useState(data.builtIn[0]?.id)
  const [title, setTitle] = useState('')
  const [required, setRequired] = useState(false)
  const b = data.builtIn.find(x => x.id === base)
  useEffect(() => { const k = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [])
  const create = () => onCreate(b, { title: title.trim() || undefined, required })
  return (
    <div className="wf-modal-scrim" onClick={onClose}>
      <div className="wf-modal" role="dialog" aria-label={t('wfc.newWorkflow')} onClick={e => e.stopPropagation()}>
        <div className="wf-modal-head"><h3>{t('wfc.newWorkflow')}</h3><button className="wb-icon-btn wf-push" onClick={onClose} aria-label={t('close')}><X size={15} /></button></div>
        <p className="wb-sub wb-block">{t('wfc.newIntro')}</p>
        <div className="wf-templates">
          {data.builtIn.map(x => { const Icon = Workflow; return (
            <button key={x.id} className={cx('wf-template', base === x.id && 'wf-on')} onClick={() => setBase(x.id)}>
              <span className="wf-card-icon"><Icon size={16} /></span>
              <span><b>{x.title}</b><small>{x.description}</small><small className="wb-dim">{t('wf.stepsN', { n: x.library.length })} · {t('wfc.optionalN', { n: x.library.filter(s => s.optional).length })}</small></span>
            </button>
          ) })}
        </div>
        <label className="wf-field"><span>{t('wf.title')}</span><input className="wb-input" autoFocus value={title} placeholder={t('wf.copyTitle', { title: b.title })} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} /></label>
        <label className="wf-check-row"><input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} /><span><b>{t('wfc.onlyRequired')}</b><small>{t('wfc.onlyRequiredHint')}</small></span></label>
        <div className="wf-modal-foot">
          <span className="wb-sub"><GitFork size={12} />{t('wfc.newFoot')}</span>
          <button className="wb-btn wf-push" onClick={onClose}>{t('cancel')}</button>
          <button className="wb-btn wb-primary" onClick={create}><Plus size={13} />{t('wfc.create')}</button>
        </div>
      </div>
    </div>
  )
}
