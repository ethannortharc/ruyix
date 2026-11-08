// One workflow in the editor: a left-to-right canvas (React Flow) of its steps — each a card with a + for what comes
// next, a + on each connection, a branch's routes and a parallel block's lanes stacked as lanes (the lanes meet at the
// block's join), the loops back drawn over them (drag from a step's top to an earlier step: on failure it goes back there)
// — a node library the + opens (agent steps blank or ready-made, scripts, a person's sign-off, the person's part — a
// review, an answer, a choice, something done outside — branches by a condition or an agent, parallel blocks, a
// left-out step back), the inspector (settings, its runs, what the step does, what it needs here), what the whole
// workflow needs on this machine (readiness: bind a connection, install a skill pack), and a run of this workflow drawn
// as it ran (its own steps, read-only). A
// built-in workflow's steps are fixed: its + makes a workflow of one's own from it and adds the step there. Undo / redo,
// keyboard: Tab (add after the selected step), Delete, Ctrl+Z / Ctrl+Shift+Z, Ctrl+S, Esc. The model lives in wf-model.js.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Background, BaseEdge, ControlButton, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow, getSmoothStepPath, useReactFlow, useStore } from '@xyflow/react'
import {
  AlertTriangle, ArrowLeft, Bot, CheckCircle2, Images, Circle, Clock, Cog, Copy, Download, ExternalLink, FileCode2, FileText, Gavel, GitBranch, GitFork, GitMerge, Hand, History, Info, ListChecks, Loader2, MessageSquareText, MessagesSquare, Split, UserCheck,
  Lock, Map as MapIcon, MinusCircle, Network, Pencil, Plug, Plus, Power, Redo2, RotateCcw, Save, Search, ShieldCheck, Sparkles, SquareTerminal, Terminal, Trash2, Undo2, Wand2, Workflow, Wrench, X, XCircle, Zap,
} from 'lucide-react'
import { call } from './data.js'
import { agentRoles, stepNames } from '../lib/flow/names.js'
import { AgentSelect, ModelPicker, SkillPicker } from './pickers.jsx'
import { SAVED } from './settings.jsx'
import { cx, dur, errorText, modelText, runTitle, stageIcon, useT, verdictText } from './ui.jsx'
import {
  NODE, PERSON_WAIT, PRESETS, addLane, addRoute, backsOf, before as beforeOf, blockItem, blockStep, builtInConfig, builtInItems, canLoop, customized, editList, find, handlesOf, inParallel, insertAt, itemsOf, layout, moveId, removeId, removeLane, removeRoute, routeBack, rulesOf, runItems, stepBefore, stepsOf, updateId, walk,
} from './wf-model.js'

const ALWAYS = ['wb_context', 'evidence_get', 'claim_add', 'decision_needed', 'help_needed', 'discuss_with_person', 'file_save', 'tools_ensure', 'stage_result']
const MIME = 'application/x-ruyix-step'
const PRESET_ICON = { output: Images, agent: Sparkles, check: ShieldCheck, draft: Pencil, summary: FileText, model: Zap, command: SquareTerminal, script: FileCode2, flow: FileCode2, approval: Hand, review: Gavel, input: MessageSquareText, decide: ListChecks, do: UserCheck, chat: MessagesSquare, condition: GitFork, router: Network, parallel: Split, restore: RotateCcw }
const slotKey = s => (s ? `${s.lane ? `${s.lane.branch}:${s.lane.k}` : 'main'}@${s.index}` : '')
const NO_ERRORS = new Map()
const kindOf = it => (it.base ? (it.base.agent ? 'agent' : it.base.model ? 'model' : 'system') : it.step.use === 'branch' ? (it.step.mode === 'agent' ? 'router' : 'branch') : it.step.use)
// a model reference on a card: the model's own name, and where it is called (the connection, or dsh)
const refParts = ref => { const i = String(ref || '').indexOf(':'); return i < 0 ? [ref, ''] : [ref.slice(i + 1).split('/').pop(), ref.slice(0, i)] }
const KIND_ICON = { agent: 'agent', model: 'model', script: 'script', flow: 'flow', approval: 'approval', output: 'output', branch: 'condition', router: 'router', parallel: 'parallel' }
// a person step's icon is its ask's (review, input, decide, do, chat)
const iconOf = (kind, ask) => PRESET_ICON[kind === 'person' ? ask : KIND_ICON[kind]]

export function Editor({ data, shown, runs, toast, openAgents, openConnectors, onBack, onDirty, onFork, onSaved, onRemoved, onRun }) {
  const t = useT()
  const saving = useRef(false)
  const builtIn = shown.kind === 'builtin'
  const fresh = shown.kind === 'fresh'
  const start = builtIn ? null : fresh ? shown.def : data.mine.find(d => d.id === shown.id)
  const wf = data.builtIn.find(b => b.id === (builtIn ? shown.id : start.base))
  const lib = wf.library
  const revision = useRef(fresh ? undefined : start?.revision)
  const rules = useMemo(() => rulesOf(lib, wf.insertFrom), [lib, wf.insertFrom])
  const initial = () => {
    let list = builtIn ? builtInItems(wf, data.picks) : itemsOf(start, lib)
    // made from a built-in workflow by its +: the step that + asked for, where it asked
    if (shown.insert) list = insertAt(list, shown.insert.slot, blockItem(shown.insert.step))
    return list
  }
  const [items, setItemsRaw] = useState(initial)
  const [head, setHeadRaw] = useState(() => (start ? { id: start.id, title: start.title, description: start.description || '', messages: !!start.messages, sessions: !!start.sessions } : null))
  const setHead = next => { if (!saving.current) setHeadRaw(next) }
  const [errors, setErrors] = useState(start?.errors || [])
  const [sel, setSel] = useState(null)
  const [panel, setPanel] = useState(() => (shown.panel === 'needs' ? 'needs' : null)) // 'workflow' — the workflow's own settings (or a built-in one's notes); 'needs' — what it needs here
  const [mode, setMode] = useState('edit') // edit | runs
  const [picked, setPicked] = useState(null) // the run laid over the canvas
  const [busy, setBusy] = useState('')
  // undo / redo: what the steps were (field edits to one step within a second count as one)
  const hist = useRef({ past: [], future: [], at: 0, key: '' })
  const setItems = (next, key = '') => {
    if (saving.current) return
    const h = hist.current, now = Date.now()
    if (!(key && h.key === key && now - h.at < 1000)) { h.past.push(items); if (h.past.length > 80) h.past.shift() }
    h.future = []; h.at = now; h.key = key
    setItemsRaw(next)
  }
  const undo = () => { const h = hist.current; if (saving.current || !h.past.length) return; h.future.push(items); setItemsRaw(h.past.pop()); h.key = '' }
  const redo = () => { const h = hist.current; if (saving.current || !h.future.length) return; h.past.push(items); setItemsRaw(h.future.pop()); h.key = '' }
  useEffect(() => { if (shown.insert) setSel(walk(items).find(x => x.it.step === shown.insert.step)?.it.uid || null) }, [])

  // (the skill packs it carries pinned stay with it: lib/needs.js)
  const value = () => { if (builtIn) return builtInConfig(items); const { messages, sessions, ...h } = head; return { ...h, ...(messages && { messages: true }), ...(sessions && { sessions: true }), base: start.base, steps: stepsOf(items), ...(start.packs?.length && { packs: start.packs }) } }
  const now = JSON.stringify(value())
  const [saved, setSaved] = useState(() => (fresh ? null : JSON.stringify(builtIn ? builtInConfig(builtInItems(wf, data.picks)) : { id: start.id, title: start.title, description: start.description || '', ...(start.messages && { messages: true }), ...(start.sessions && { sessions: true }), base: start.base, steps: stepsOf(itemsOf(start, lib)), ...(start.packs?.length && { packs: start.packs }) })))
  const dirty = now !== saved
  const idTaken = fresh && [...data.mine, ...data.builtIn].some(d => d.id === head.id)
  useEffect(() => { onDirty(dirty) }, [dirty])
  useEffect(() => {
    if (builtIn) return
    let live = true
    const timer = setTimeout(() => call('workflowValidate', { definition: JSON.parse(now) }).then(r => { if (live) setErrors(r.errors) }, () => {}), 300)
    return () => { live = false; clearTimeout(timer) }
  }, [now])
  // what it needs, and how each stands here (lib/needs.js): checked as it changes, again after a bind or an install
  const [ready, setReady] = useState(null)
  const [readyTick, setReadyTick] = useState(0)
  const readyArgs = () => (builtIn ? { id: wf.id } : { definition: JSON.parse(now) })
  const readinessRequest = useRef(0)
  useEffect(() => {
    const request = ++readinessRequest.current
    const timer = setTimeout(() => call('workflowReadiness', readyArgs()).then(r => { if (request === readinessRequest.current) setReady(r) }, () => {}), 400)
    return () => { if (request === readinessRequest.current) readinessRequest.current++; clearTimeout(timer) }
  }, [now, readyTick])
  const needsOf = useMemo(() => new Map((ready?.steps || []).map(x => [x.id, x.items])), [ready])
  const bind = async (key, connection, only) => {
    try { await call('bindingSet', { key, connection, workflow: only ? (builtIn ? wf.id : head?.id) : null }); setReadyTick(n => n + 1) } catch (err) { toast('error', errorText(t, err)) }
  }
  const ensure = async () => {
    const request = ++readinessRequest.current
    setBusy('ensure')
    try {
      const r = await call('workflowEnsure', readyArgs())
      if (request === readinessRequest.current) setReady(r.readiness)
      if (r.failed.length) toast('error', r.failed.map(f => t('wfn.ensureFailed', { id: f.id, error: f.error })).join('\n'))
      else toast('ok', t('wfn.ensured', { n: r.fetched.length }))
    } catch (err) { toast('error', errorText(t, err)) }
    setBusy('')
  }
  // a command-line tool its runs' agents had to ask for, added to the step's own list (a workflow of one's own only)
  const addTool = builtIn ? null : (stepId, tool) => {
    const at = walk(items).find(x => (x.it.base ? x.it.base.key : x.it.step.id) === stepId)
    if (at) setItems(updateId(items, at.it.uid, it => ({ ...it, step: { ...it.step, cli: [...new Set([...(it.step.cli || []), tool])] } })))
  }
  const needsCtl = { connections: ready?.connections || data.connectors, bind, ensure, busy: busy === 'ensure', openConnectors, addTool }
  // a check's step (or its place in a route) → the item it is about
  const errorsOf = useMemo(() => {
    const m = new Map(), main = items.filter(it => !it.base || it.included)
    for (const e of errors) {
      if (e.step === undefined) continue
      const top = main[e.step]
      const it = e.lane !== undefined ? top?.lanes?.[e.lane]?.items[e.index] : top
      if (it) m.set(it.uid, [...(m.get(it.uid) || []), e])
    }
    return m
  }, [errors, items])

  // ── edits ──
  const taken = () => new Set([...lib.map(b => b.key), ...walk(items).map(x => x.it.step.id).filter(Boolean)])
  // another step's settings, by its id (a branch's condition asks the step it looks at to carry on when it fails)
  const patchStep = (stepId, patch) => { const at = walk(items).find(x => !x.it.base && x.it.step.id === stepId); if (at) setItems(updateId(items, at.it.uid, it => ({ ...it, step: { ...it.step, ...patch } }))) }
  const make = (preset, slot) => blockStep(preset, {
    taken: taken(), title: preset.script ? preset.script.split('@')[0] : t(`wfp.${preset.key}.title`), instructions: preset.use === 'agent' && preset.key !== 'agent' ? t(`wfp.${preset.key}.instructions`) : '',
    agent: data.defaultAgent || data.agents[0]?.id || '',
    when: { step: stepBefore(items, slot) || lib[0]?.key || '', is: 'passed' },
  })
  const add = (slot, preset) => {
    if (preset.restore) { setItems(updateId(items, preset.restore, it => ({ ...it, included: true }))); setSel(preset.restore); return }
    const step = make(preset, slot)
    // a parallel block's lane runs beside the others: an agent there only reads
    if (inParallel(items, slot.lane) && step.use === 'agent') step.access = 'read'
    if (builtIn) return onFork({ slot, step })
    const it = blockItem(step)
    setItems(insertAt(items, slot, it))
    setSel(it.uid); setPanel(null)
  }
  const change = (id, patch) => setItems(updateId(items, id, it => ({ ...it, step: { ...it.step, ...patch } })), `step:${id}`)
  const toggle = id => setItems(updateId(items, id, it => ({ ...it, included: !it.included })))
  const remove = id => {
    const at = find(items, id)
    if (!at || builtIn) return
    if (at.it.base) { if (at.it.base.optional) { setItems(updateId(items, id, it => ({ ...it, included: false }))); setSel(null) } return }
    setItems(removeId(items, id)); setSel(s => (s === id ? null : s))
  }
  const move = (id, slot) => setItems(moveId(items, id, slot))
  const routeAdd = id => {
    const it = find(items, id).it, n = it.step.routes.length + 1
    let rid = `route-${n}`; for (let k = n; it.step.routes.some(r => r.id === rid); k++) rid = `route-${k + 1}`
    const at = find(items, id)
    setItems(addRoute(items, id, it.step.mode === 'agent' ? { id: rid, label: String.fromCharCode(64 + n), hint: '' } : { id: rid, label: String.fromCharCode(64 + n), when: { step: stepBefore(items, { lane: at.lane, index: at.index }) || lib[0]?.key || '', is: 'passed' } }))
  }
  const routeRemove = (id, k) => setItems(removeRoute(items, id, k))
  const routeChange = (id, k, patch) => setItems(updateId(items, id, it => ({ ...it, step: { ...it.step, routes: it.step.routes.map((r, j) => (j === k ? { ...r, ...patch } : r)) } })), `route:${id}:${k}`)
  const laneAdd = id => {
    const it = find(items, id).it
    let n = it.step.lanes.length + 1, lid = `lane-${n}`
    while (it.step.lanes.some(l => l.id === lid)) lid = `lane-${++n}`
    setItems(addLane(items, id, { id: lid, label: String.fromCharCode(64 + it.step.lanes.length + 1) }))
  }
  const laneChange = (id, k, patch) => setItems(updateId(items, id, it => ({ ...it, step: { ...it.step, lanes: it.step.lanes.map((l, j) => (j === k ? { ...l, ...patch } : l)) } })), `lane:${id}:${k}`)
  // a loop dragged on the canvas: the step, on failure, goes back to the step it was dragged to
  const loop = (from, to) => {
    if (builtIn || !canLoop(items, from, to)) return
    const target = find(items, to).it, key = target.base ? target.base.key : target.step.id, was = find(items, from).it.step.onFail
    setItems(updateId(items, from, it => ({ ...it, step: { ...it.step, onFail: { goto: key, max: typeof was === 'object' ? was.max : 2 } } })))
    setSel(from)
  }

  const save = async enable => {
    if (busy || idTaken || saving.current) return
    saving.current = true
    setBusy(enable ? 'enable' : 'save')
    try {
      if (builtIn) {
        const { steps, stages } = builtInConfig(items)
        const all = { ...data.picks.steps, [wf.id]: steps }
        if (!Object.keys(steps).length) delete all[wf.id]
        await call('saveSettings', { settings: { steps: all, stages: { ...data.picks.stages, ...stages } }, revision: data.settingsRevision })
        window.dispatchEvent(new Event(SAVED))
        await onSaved()
        setSaved(now); toast('ok', t('wfc.saved'))
      } else {
        const r = await call('workflowSave', { definition: JSON.parse(now), enable, create: fresh, expect: revision.current })
        revision.current = r.workflow.revision
        setErrors(r.errors); setSaved(now)
        toast('ok', t(r.workflow.status === 'enabled' ? 'wf.savedEnabled' : 'wf.savedDraft'))
        await onSaved(r.workflow.id)
      }
    } catch (err) { toast('error', errorText(t, err)) }
    finally { saving.current = false; setBusy('') }
  }
  const setStatus = async status => {
    try { const r = await call('workflowStatus', { id: start.id, status, expect: revision.current }); revision.current = r.workflow.revision; toast('ok', t(status === 'enabled' ? 'wf.savedEnabled' : 'wf.savedDraft')); onSaved(start.id) } catch (err) { toast('error', errorText(t, err)) }
  }
  const removeWorkflow = async () => {
    if (!window.confirm(t('wf.removeConfirm', { title: start.title }))) return
    try { await call('workflowRemove', { id: start.id, expect: revision.current }); onDirty(false); onRemoved() } catch (err) { toast('error', errorText(t, err)) }
  }

  // the runs of this workflow, newest first
  const wfId = builtIn ? wf.id : start.id
  const mineRuns = useMemo(() => [...(runs?.values() || [])].filter(r => r.template === wfId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40), [runs, wfId])
  const run = mode === 'runs' ? mineRuns.find(r => r.id === picked) || mineRuns[0] || null : null
  // each step over those runs: how often it went through, its usual time (the edit view's nodes show it)
  const ranStats = useMemo(() => stepStats(mineRuns), [mineRuns])
  // a run is drawn as it ran — its own steps (the definition it started with), not the draft — and cannot be edited there
  const runWf = run ? data.builtIn.find(b => b.id === (run.workflowDef?.base || run.template)) || wf : wf
  const ranItems = useMemo(() => (run ? runItems(run, runWf.library) : null), [run?.id, run?.workflowDef, runWf])
  const backs = useMemo(() => backsOf(runWf.steps), [runWf])
  const shownItems = ranItems || items

  // keyboard
  const canvasApi = useRef(null)
  useEffect(() => {
    const key = e => {
      if (saving.current) return
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty || fresh) save(false); return }
      if (typing) return
      if (run) { if (e.key === 'Escape') { setSel(null); setPanel(null) } return } // a run's view: nothing to edit
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() } else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo() } else if (e.key === 'Tab' && sel) { e.preventDefault(); canvasApi.current?.addAfter(sel) } else if (e.key === 'Escape') { canvasApi.current?.close(); setSel(null); setPanel(null) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const status = builtIn ? 'builtin' : fresh ? 'fresh' : start.status
  const chosen = sel ? find(shownItems, sel) : null
  const main = items.filter(it => !it.base || it.included)
  const agentCount = walk(items).filter(x => (x.it.base ? x.it.base.agent && x.it.included : ['agent'].includes(x.it.step.use) || (x.it.step.use === 'branch' && x.it.step.mode === 'agent'))).length
  return (
    <div className="wf-editor" inert={busy === 'save' || busy === 'enable' ? 'inert' : undefined}>
      <header className="wf-bar">
        <button className="wf-back" disabled={!!busy} onClick={onBack} title={t('wfc.backList')}><ArrowLeft size={15} /></button>
        <span className={cx('wf-bar-icon', !builtIn && 'wf-own')}>{builtIn ? <Workflow size={16} /> : <Sparkles size={16} />}</span>
        <div className="wf-bar-text">
          {builtIn ? <h3>{wf.title}</h3> : <input className="wf-title-input" value={head.title} placeholder={head.id} aria-label={t('wf.title')} onChange={e => setHead({ ...head, title: e.target.value })} />}
          <span className="wb-sub">
            <span className={cx('wf-pill', { builtin: 'wf-pill-builtin', fresh: 'wf-pill-new', enabled: 'wf-pill-on', draft: 'wf-pill-draft' }[status])}>{status === 'fresh' ? t('wfc.unsaved') : t(`wf.status.${status}`)}</span>
            {!builtIn && <span>{t('wf.basedOn', { base: wf.title })}</span>}
            <span>{t('wfc.steps', { n: walk(main).length, a: agentCount })}</span>
            {dirty && !fresh && <span className="wf-dirty">{t('wfc.unsavedChanges')}</span>}
          </span>
        </div>
        <div className="wf-seg wf-modes" role="tablist">
          <button role="tab" aria-selected={mode === 'edit'} className={cx(mode === 'edit' && 'wf-on')} onClick={() => { setMode('edit'); setSel(null) }}><Pencil size={13} />{t('wfc.mode.edit')}</button>
          <button role="tab" aria-selected={mode === 'runs'} className={cx(mode === 'runs' && 'wf-on')} onClick={() => { setMode('runs'); setPanel(null); setSel(null) }}><History size={13} />{t('wfc.mode.runs')}{mineRuns.length > 0 && <i>{mineRuns.length}</i>}</button>
        </div>
        <div className="wf-bar-actions">
          {!builtIn && (errors.length
            ? <button className="wf-check wf-check-bad" onClick={() => { setSel(null); setPanel('workflow') }} title={errors.map(e => e.message).join('\n')}><AlertTriangle size={13} />{t('wf.problems', { n: errors.length })}</button>
            : <span className="wf-check wf-check-ok"><CheckCircle2 size={13} />{t('wfc.valid')}</span>)}
          {/* what it needs on this machine: missing (a run will not start), to install, or ready */}
          {ready && !run && <button className={cx('wf-check', ready.missing ? 'wf-check-bad' : ready.installable ? 'wf-check-warn' : 'wf-check-ok')} title={ready.what || t('wfn.panelHint')} onClick={() => { setSel(null); setPanel(panel === 'needs' ? null : 'needs') }}>
            {ready.missing ? <><Plug size={13} />{t('wfn.missing', { n: ready.missing })}</> : ready.installable ? <><Download size={13} />{t('wfn.installable', { n: ready.installable })}</> : <><CheckCircle2 size={13} />{t('wfn.ready')}</>}
          </button>}
          <button className="wb-icon-btn" disabled={!hist.current.past.length} onClick={undo} title={`${t('wfc.undo')} (Ctrl+Z)`}><Undo2 size={15} /></button>
          <button className="wb-icon-btn" disabled={!hist.current.future.length} onClick={redo} title={`${t('wfc.redo')} (Ctrl+Shift+Z)`}><Redo2 size={15} /></button>
          <button className={cx('wb-icon-btn', panel === 'workflow' && !chosen && 'wb-on')} title={t('wfc.details')} onClick={() => { setSel(null); setPanel(panel === 'workflow' ? null : 'workflow') }}><Info size={15} /></button>
          {builtIn
            ? <>
              <button className="wb-btn wb-small" onClick={() => onFork(null)} title={t('wfc.copyHint')}><Copy size={12} />{t('wf.copy')}</button>
              <button className="wb-btn wb-small wb-primary" disabled={!dirty || !!busy} onClick={() => save(false)}>{busy ? <Loader2 size={12} className="wb-spin" /> : <Save size={12} />}{t('wfc.save')}</button>
            </>
            : <>
              <button className="wb-btn wb-small" disabled={!!busy || idTaken || (!dirty && !fresh)} onClick={() => save(false)}>{busy === 'save' ? <Loader2 size={12} className="wb-spin" /> : <Save size={12} />}{status === 'enabled' ? t('wfc.save') : t('wf.saveDraft')}</button>
              {status !== 'enabled' && <button className="wb-btn wb-small wb-primary" disabled={!!busy || idTaken || errors.length > 0} onClick={() => save(true)}>{busy === 'enable' ? <Loader2 size={12} className="wb-spin" /> : <Power size={12} />}{t('wf.saveEnable')}</button>}
            </>}
        </div>
      </header>
      <div className={cx('wf-body', (chosen || panel) && 'wf-has-panel', mode === 'runs' && 'wf-runs-mode')}>
        <Canvas apiRef={canvasApi} items={shownItems} backs={backs} builtIn={builtIn} rules={rules} sel={sel} setSel={id => { setSel(id); if (id) setPanel(null) }} errorsOf={run ? NO_ERRORS : errorsOf} data={data}
          run={run} stats={run ? null : ranStats} onAdd={add} onMove={move} onRemove={remove} onLoop={loop} />
        {mode === 'runs' && <RunsPanel runs={mineRuns} run={run} onPick={setPicked} onOpen={onRun} />}
        {(chosen || panel) && (
          <aside className="wf-inspector" key={sel || panel}>
            {chosen
              ? <StepInspector at={chosen} items={shownItems} builtIn={builtIn} data={data} rules={rules} wf={runWf} errors={run ? [] : errorsOf.get(chosen.it.uid) || []} runs={mineRuns} run={run}
                needs={run ? [] : needsOf.get(chosen.it.base ? chosen.it.base.key : chosen.it.step.id) || []} needsCtl={needsCtl}
                onChange={patch => change(chosen.it.uid, patch)} onToggle={() => toggle(chosen.it.uid)} onRemove={() => remove(chosen.it.uid)} onClose={() => setSel(null)} openAgents={openAgents}
                onAddAfter={() => canvasApi.current?.addAfter(chosen.it.uid)} onRoute={{ add: () => routeAdd(chosen.it.uid), remove: k => routeRemove(chosen.it.uid, k), change: (k, patch) => routeChange(chosen.it.uid, k, patch), patchStep }}
                onLane={{ add: () => laneAdd(chosen.it.uid), remove: k => setItems(removeLane(items, chosen.it.uid, k)), change: (k, patch) => laneChange(chosen.it.uid, k, patch) }} />
              : panel === 'needs' ? <ReadinessPanel ready={ready} ctl={needsCtl} onPick={id => { const at = walk(items).find(x => (x.it.base ? x.it.base.key : x.it.step.id) === id); if (at) setSel(at.it.uid) }} onClose={() => setPanel(null)} />
              : <WorkflowInspector wf={wf} builtIn={builtIn} fresh={fresh} head={head} setHead={setHead} status={status} errors={idTaken ? [{ message: t('err.workflowExists', { id: head.id }) }, ...errors] : errors} onCopy={() => onFork(null)} onStatus={setStatus} onRemove={removeWorkflow} dirty={dirty} onClose={() => setPanel(null)} />}
          </aside>
        )}
      </div>
    </div>
  )
}

// ── the canvas ──

/** Per step key, over a workflow's runs: { n } times it went through and the median time it took (ms). Pure. */
export function stepStats(runs) {
  const by = new Map()
  for (const r of runs || []) for (const st of r.stages || []) {
    if (st.status !== 'passed' || !st.startedAt || !st.endedAt) continue
    const x = by.get(st.key) || []
    x.push(st.endedAt - st.startedAt); by.set(st.key, x)
  }
  return new Map([...by].map(([k, ms]) => { ms.sort((a, b) => a - b); return [k, { n: ms.length, ms: ms[Math.floor(ms.length / 2)] }] }))
}

function Canvas({ apiRef, items, backs, builtIn, rules, sel, setSel, errorsOf, data, run, stats, onAdd, onMove, onRemove, onLoop }) {
  const t = useT()
  const rf = useReactFlow()
  const wrap = useRef(null)
  const [picker, setPicker] = useState(null) // { slot, x, y }
  const [hot, setHot] = useState(null) // the slot a drag is over
  const [drag, setDrag] = useState(null) // { id, pos }
  const [mini, setMini] = useState(false)
  // how many steps a row of a phase holds before it goes on below (from the window's width, once)
  const [cols] = useState(() => Math.max(3, Math.min(7, Math.round((window.innerWidth - 430) / 250))))
  const fixed = builtIn || !!run // a built-in workflow's steps, or a run as it ran: nothing moves or goes
  const L = useMemo(() => layout(items, { backs, cols, hidden: builtIn && !run ? () => false : undefined }), [items, backs, builtIn, run, cols])
  const byId = useMemo(() => new Map(data.agents.map(a => [a.id, a])), [data.agents])
  const can = slot => rules.canAt(items, slot)
  const open = (slot, ev) => {
    const r = wrap.current.getBoundingClientRect(), b = ev?.currentTarget?.getBoundingClientRect?.()
    setPicker({ slot, x: (b ? b.right : r.left + r.width / 2) - r.left + 8, y: (b ? b.top : r.top + 80) - r.top, w: r.width, h: r.height })
  }
  const nodeById = useMemo(() => new Map(L.nodes.map(nd => [nd.id, nd])), [L])
  // the API the editor uses: add after a step (Tab, the inspector), close the library (Esc)
  apiRef.current = {
    addAfter: id => {
      if (run) return
      const s = L.slots.find(x => x.node === id)
      const slot = s && can(s.slot) ? s.slot : L.slots.filter(x => can(x.slot)).at(-1)?.slot
      if (!slot) return
      const nd = nodeById.get(s && can(s.slot) ? id : L.slots.find(x => x.slot === slot).node)
      const vp = rf.flowToScreenPosition({ x: nd.x + NODE.w + 20, y: nd.y })
      const r = wrap.current.getBoundingClientRect()
      setPicker({ slot, x: vp.x - r.left + 8, y: vp.y - r.top, w: r.width, h: r.height })
    },
    close: () => setPicker(null),
  }
  const describe = it => {
    const s = it.step
    if (it.base) {
      const title = t(`stage.${it.base.key}`)
      if (it.base.model) { const [name, via] = refParts(s.model || it.base.model.model); return { title, sub: name || t('wfc.defaultModel'), model: via, mono: !!name, custom: customized(s) } }
      if (!it.base.agent) return { title, sub: t('pf.system') }
      const id = s.agent || it.base.agent.agent, a = byId.get(id)
      return { title, sub: a?.name || id, model: a ? modelText(a) : t('wfc.notInPool'), custom: customized(s), skills: s.skills?.length || 0 }
    }
    const title = s.title || s.id
    if (s.use === 'agent') { const a = byId.get(s.agent); return { title, sub: a?.name || s.agent || t('wfc.noAgent'), model: a && modelText(a), skills: s.skills?.length || 0, tools: s.tools?.length || 0 } }
    if (s.use === 'model') { const [name, via] = refParts(s.model); return { title, sub: name || t('wfc.defaultModel'), model: via, mono: !!name } }
    if (s.use === 'script') return { title, sub: s.script || s.run?.split('\n')[0] || t('wfc.noCommand'), mono: !!(s.script || s.run), connectors: Array.isArray(s.connectors) ? s.connectors.length : Object.keys(s.connectors || {}).length }
    if (s.use === 'flow') return { title, sub: t('wfc.flow.sub', { n: stepNames(s.source).length, roles: Object.keys(s.agents || {}).join(', ') || '—' }) }
    if (s.use === 'approval') return { title, sub: s.text || t('wfc.noQuestion') }
    if (s.use === 'output') return { title, sub: s.show?.length ? s.show.join(', ') : t('wfc.output.all'), mono: !!s.show?.length }
    if (s.use === 'person') return { title, sub: s.text || t('wfc.noAsk'), ask: s.ask, wait: s.wait || 0 }
    if (s.use === 'parallel') return { title, sub: t('wfc.parallel.sub', { n: s.lanes.length }), lanes: s.lanes.length }
    if (s.mode === 'agent') { const a = byId.get(s.agent); return { title, sub: t('wfc.router.sub', { agent: a?.name || s.agent || '—' }), routes: s.routes.length + 1 } }
    return { title, sub: t('wfc.branch.sub', { n: s.routes.length + 1 }), routes: s.routes.length + 1 }
  }
  const stageOf = it => run?.stages?.find(x => x.key === (it.base ? it.base.key : it.step.id))
  // the loops back: all drawn (the step picked brings its own forward), each step marked with where it goes back to
  const loops = L.edges.filter(e => e.loop)
  const nameOf = id => { const nd = L.nodes.find(x => x.id === id); return nd?.it ? (nd.it.base ? t(`stage.${nd.it.base.key}`) : nd.it.step.title || nd.it.step.id) : '' }
  const top = L.phases[0]?.y0 ?? 0, bottom = L.phases.at(-1)?.y1 ?? NODE.h
  const nodes0 = [
    ...L.labels.map(lb => {
      const s = lb.branch.step, par = s.use === 'parallel'
      return { id: `lb-${lb.id}`, type: 'lane', position: { x: lb.x, y: lb.y - 30 }, draggable: false, selectable: false, deletable: false, zIndex: 3,
        data: { text: par ? s.lanes[lb.k]?.label || '' : lb.k < s.routes.length ? s.routes[lb.k].label : s.otherwise?.label || '', other: !par && lb.k === s.routes.length, par, back: !!routeBack(lb.branch, lb.k), onClick: () => setSel(lb.branch.uid) } }
    }),
    // a parallel block's join: every lane through, then on (its status in a run: the block's)
    ...L.nodes.filter(nd => nd.join).map(nd => ({ id: nd.id, type: 'join', position: { x: nd.x, y: nd.y }, draggable: false, selectable: false, deletable: false, zIndex: 2, width: NODE.w, height: NODE.h,
      data: { n: nd.join.lanes.length, run: run ? stageOf(nd.join)?.status || 'none' : null, onClick: () => setSel(nd.join.uid) } })),
    ...L.nodes.filter(nd => nd.placeholder).map(nd => ({ id: nd.id, type: 'slot', position: { x: nd.x, y: nd.y }, draggable: false, selectable: false, deletable: false, zIndex: 2, width: NODE.w, height: NODE.h,
      data: { add: !run && !builtIn ? ev => open({ lane: nd.lane, index: 0 }, ev) : null } })),
    ...L.nodes.filter(nd => !nd.placeholder && !nd.join).map(nd => {
      const it = nd.it, st = stageOf(it), slot = L.slots.find(x => x.node === nd.id)?.slot
      return {
        id: nd.id, type: 'step', position: drag?.id === nd.id ? drag.pos : { x: nd.x, y: nd.y }, selected: sel === nd.id,
        draggable: !fixed && !it.base, deletable: !fixed && (!it.base || it.base.optional), zIndex: drag?.id === nd.id ? 20 : 2, width: NODE.w, height: NODE.h,
        data: { ...describe(it), kind: kindOf(it), key: it.base?.key, own: !it.base, phase: nd.phase, n: nd.n, off: it.base && !it.included, bad: errorsOf.has(nd.id), lifted: drag?.id === nd.id,
          loopTo: loops.filter(e => e.from === nd.id).map(e => nameOf(e.to))[0] || '', loopsIn: loops.filter(e => e.to === nd.id && e.from !== nd.id).length,
          run: run ? (st ? { status: st.status, ms: st.endedAt && st.startedAt ? st.endedAt - st.startedAt : null, attempt: st.attempt } : { status: 'none' }) : null,
          ran: stats?.get(it.base ? it.base.key : it.step.id) || null,
          add: !run && slot && can(slot) && !it.lanes ? ev => open(slot, ev) : null },
      }
    }),
  ]
  // where each node's handles are, said up front: an edge needs both ends' handles, and React Flow measures them only in a
  // page it can lay out — a background tab, a hidden window or a zero-size box left the canvas with steps and no lines
  const nodes = nodes0.map(n => (n.width ? { ...n, handles: handlesOf(n.width, n.height) } : n))
  const arrow = c => ({ type: MarkerType.ArrowClosed, color: c, width: 13, height: 13 })
  const edges = L.edges.map(e => {
    if (e.loop) return { id: e.id, source: e.from, target: e.to, sourceHandle: 'ts', targetHandle: 'tt', type: 'loop', selectable: false, focusable: false, zIndex: 1, markerEnd: arrow(e.loop === 'base' ? 'var(--wb-red)' : 'var(--ruyix-accent-alt)'),
      data: { own: e.loop !== 'base', route: e.loop === 'route', max: e.max, on: !!sel && (e.from === sel || e.to === sel || e.id.startsWith(`loop-${sel}-`)) } }
    const passed = run && [e.from, e.to].every(id => { const nd = nodeById.get(id); return nd?.it && ['passed', 'running'].includes(stageOf(nd.it)?.status) })
    return { id: e.id, source: e.from, target: e.to, sourceHandle: e.cross ? 'bs' : 'r', targetHandle: e.cross ? 'tt' : 'l', type: 'flow', selectable: false, focusable: false, zIndex: 1, markerEnd: arrow(passed ? 'var(--ruyix-success)' : 'var(--wb-fl-edge)'),
      data: { slot: e.slot, can: !run && e.slot && can(e.slot), hot: hot && slotKey(hot) === slotKey(e.slot), passed, route: e.route !== undefined, onPlus: ev => open(e.slot, ev) } }
  })

  // drags: a step of one's own onto a + (moves it); a block from the library onto one (adds it)
  const points = useMemo(() => [
    ...L.slots.map(s => ({ slot: s.slot, x: s.x, y: s.y })),
    ...L.edges.filter(e => e.slot && !e.loop).map(e => { const a = nodeById.get(e.from), b = nodeById.get(e.to); return e.cross ? { slot: e.slot, x: (a.x + b.x + NODE.w) / 2, y: (a.y + NODE.h + b.y) / 2 } : { slot: e.slot, x: (a.x + NODE.w + b.x) / 2, y: (a.y + b.y) / 2 + NODE.h / 2 } }),
    ...L.nodes.filter(nd => nd.placeholder).map(nd => ({ slot: { lane: nd.lane, index: 0 }, x: nd.x + NODE.w / 2, y: nd.y + NODE.h / 2 })),
  ].filter(p => can(p.slot)), [L, items])
  const nearest = (p, id) => {
    const at = id ? find(items, id) : null
    let best = null, dist = 130
    for (const q of points) {
      // a step stays on its line: a branch on the main line; not next to itself
      if (at?.it.lanes && q.slot.lane) continue
      if (at && slotKey(q.slot) === slotKey({ lane: at.lane, index: at.index }) || at && slotKey(q.slot) === slotKey({ lane: at.lane, index: at.index + 1 })) continue
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < dist) { dist = d; best = q.slot }
    }
    return best
  }
  const centre = node => ({ x: node.position.x + NODE.w / 2, y: node.position.y + NODE.h / 2 })
  const flowPoint = e => rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })

  // the first view: readable (a long workflow starts at its beginning, the phases and the minimap reach the rest)
  const first = () => {
    const box = wrap.current?.getBoundingClientRect()
    if (!box || !L.nodes.length) return
    // all of it when it is readable so; else as wide as the panel, from the top (the rest a scroll away)
    const fitAll = Math.min((box.width - 48) / L.width, (box.height - 120) / (bottom - top))
    const z = fitAll >= 0.74 ? Math.min(1, fitAll) : Math.max(0.74, Math.min(1, (box.width - 48) / L.width))
    const x = L.width * z <= box.width - 48 ? (box.width - L.width * z) / 2 : 24
    const y = (bottom - top) * z <= box.height - 120 ? 66 + (box.height - 120 - (bottom - top) * z) / 2 - top * z : 66 - top * z
    rf.setViewport({ x, y, zoom: z })
    follow(0)
  }
  // a step added or picked off screen (or under the inspector): the view goes to it
  const follow = (duration = 320) => {
    const nd = sel && nodeById.get(sel), box = wrap.current?.getBoundingClientRect()
    if (!nd || !box) return
    const p = rf.flowToScreenPosition({ x: nd.x, y: nd.y }), q = rf.flowToScreenPosition({ x: nd.x + NODE.w, y: nd.y + NODE.h })
    if (p.x < box.left + 20 || q.x > box.right - 380 || p.y < box.top + 60 || q.y > box.bottom - 20) rf.setCenter(nd.x + NODE.w / 2 + 170 / rf.getZoom(), nd.y + NODE.h / 2, { zoom: rf.getZoom(), duration })
  }
  useEffect(() => { follow() }, [sel, L])
  return (
    <div ref={wrap} className={cx('wf-canvas', !fixed && 'wf-editable', hot && 'wf-dropping', run && 'wf-overlay')}
      onDragOver={e => { if (fixed || !e.dataTransfer.types.includes(MIME)) return; e.preventDefault(); setHot(nearest(flowPoint(e))) }}
      onDrop={e => { const k = e.dataTransfer.getData(MIME); if (!k || fixed) return; e.preventDefault(); const slot = nearest(flowPoint(e)); setHot(null); const preset = PRESETS.find(p => p.key === k); if (slot && preset) onAdd(slot, preset) }}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onInit={() => requestAnimationFrame(first)} fitViewOptions={FIT} minZoom={0.2} maxZoom={1.5}
        nodesConnectable={!fixed} elementsSelectable panOnScroll zoomOnPinch edgesFocusable={false} proOptions={{ hideAttribution: true }}
        isValidConnection={c => c.sourceHandle === 'ts' && c.targetHandle === 'tt' && canLoop(items, c.source, c.target)} onConnect={c => onLoop(c.source, c.target)}
        connectionLineStyle={{ stroke: 'var(--ruyix-accent-alt)', strokeDasharray: '5 4', strokeWidth: 1.6 }}
        deleteKeyCode={fixed ? null : ['Delete', 'Backspace']} onNodesDelete={ns => { if (!fixed) ns.forEach(x => onRemove(x.id)) }}
        onNodeClick={(_, n) => { if (n.type === 'step') { setSel(n.id); setPicker(null) } else if (n.type === 'join') { n.data.onClick(); setPicker(null) } }} onPaneClick={() => { setSel(null); setPicker(null) }}
        onNodesChange={changes => { if (!fixed) for (const c of changes) if (c.type === 'position' && c.position) setDrag({ id: c.id, pos: c.position }) }}
        onNodeDragStart={(_, n) => { setSel(n.id); setPicker(null) }}
        onNodeDrag={(_, n) => setHot(nearest(centre(n), n.id))}
        onNodeDragStop={(_, n) => { const slot = nearest(centre(n), n.id); setDrag(null); setHot(null); if (slot && !fixed) onMove(n.id, slot) }}>
        <Background gap={22} size={1.1} color="var(--wb-fl-dot)" />
        <Controls showInteractive={false} position="bottom-left">
          <ControlButton onClick={() => setMini(!mini)} title={t('wfc.minimap')} aria-label={t('wfc.minimap')}><MapIcon size={12} /></ControlButton>
        </Controls>
        {mini && <MiniMap position="bottom-right" pannable zoomable nodeColor={n => (n.type === 'step' ? 'var(--ruyix-accent)' : 'transparent')} nodeStrokeWidth={0} maskColor="color-mix(in srgb, var(--ruyix-canvas) 70%, transparent)" />}
        <Panel position="top-left" className="wf-note">
          {builtIn ? <><Lock size={12} /><span>{t('wfc.fixedFork')}</span></> : run ? <><Lock size={12} /><span>{t('wfc.runView')}</span></> : <><Plus size={12} /><span>{t('wfc.addHint')}</span><span className="wf-note-sep" /><RotateCcw size={12} /><span>{t('wfc.loopDrag')}</span></>}
        </Panel>
      </ReactFlow>
      {picker && <BlockPicker at={picker} builtIn={builtIn} lane={!!picker.slot.lane} par={inParallel(items, picker.slot.lane)} data={data} restorable={rules.restorable(items, picker.slot)} onClose={() => setPicker(null)}
        onPick={preset => { const slot = picker.slot; setPicker(null); onAdd(slot, preset) }} />}
    </div>
  )
}
const FIT = { padding: { top: '84px', bottom: '64px', left: '40px', right: '40px' }, maxZoom: 1 }

function StepNode({ data, selected }) {
  const t = useT()
  const Icon = data.kind === 'model' ? Zap : data.key ? stageIcon(data.key, data.kind === 'agent') : iconOf(data.kind, data.ask) || Cog
  const RunIcon = { passed: CheckCircle2, failed: XCircle, skipped: MinusCircle, running: Loader2, pending: Circle, none: Circle }[data.run?.status]
  return (
    <div className={cx('wf-node', `wf-k-${data.kind}`, data.own && 'wf-own', selected && 'wf-on', data.off && 'wf-off', data.bad && 'wf-bad', data.lifted && 'wf-lifted', data.run && `wf-run wf-run-${data.run.status}`)}>
      <Handle id="l" type="target" position={Position.Left} />
      <Handle id="tt" type="target" position={Position.Top} />
      <Handle id="r" type="source" position={Position.Right} />
      <Handle id="ts" type="source" position={Position.Top} />
      <Handle id="bs" type="source" position={Position.Bottom} />
      <span className="wf-node-icon"><Icon size={16} /></span>
      <div className="wf-node-main">
        <div className="wf-node-top">
          <b title={data.title}>{data.title}</b>
          {data.bad && <AlertTriangle size={12} className="wf-node-warn" />}
          {data.custom && <span className="wf-node-dot" title={t('wfc.customizedStep')} />}
        </div>
        <div className="wf-node-sub">
          <span className={cx('wf-node-name', data.mono && 'wb-mono')}>{data.sub}</span>
          {data.model && <em>{data.model}</em>}
        </div>
        <div className="wf-node-foot">
          {data.n !== null && <span className="wf-node-n">#{data.n}</span>}
          {data.off && <i className="wf-node-off">{t('wfc.skipped')}</i>}
          {data.skills > 0 && <i title={t('wfc.skills')}><Wand2 size={10} />{data.skills}</i>}
          {data.tools > 0 && <i title={t('wf.tools')}><Wrench size={10} />{data.tools}</i>}
          {data.connectors > 0 && <i title={t('wf.connectors')}><Plug size={10} />{data.connectors}</i>}
          {data.routes > 0 && <i title={t('wfc.routes')}><GitBranch size={10} />{data.routes}</i>}
          {data.lanes > 0 && <i title={t('wfc.lanes')}><Split size={10} />{data.lanes}</i>}
          {data.wait > 0 && <i title={t('wfc.person.waitShort', { h: data.wait })}><Clock size={10} />{data.wait}h</i>}
          {data.loopTo && <i className="wf-node-loop" title={t('wfc.loopTo', { step: data.loopTo })}><RotateCcw size={10} />{data.loopTo}</i>}
          {data.loopsIn > 0 && <i className="wf-node-loop" title={t('wfc.loopsIn', { n: data.loopsIn })}><RotateCcw size={10} />×{data.loopsIn}</i>}
          {!data.run && data.ran && <span className="wf-node-ran" title={t('wfc.ranHint')}>{t('wfc.ran', { n: data.ran.n, d: dur(data.ran.ms) })}</span>}
          {data.run && data.run.status !== 'none' && <span className="wf-node-run">{RunIcon && <RunIcon size={11} className={data.run.status === 'running' ? 'wb-spin' : ''} />}{data.run.ms ? dur(data.run.ms) : t(`sst.${data.run.status}`) !== `sst.${data.run.status}` ? t(`sst.${data.run.status}`) : data.run.status}</span>}
        </div>
      </div>
      {data.add && <button className="wf-add-next nodrag" title={t('wfc.addNext')} aria-label={t('wfc.addNext')} onClick={e => { e.stopPropagation(); data.add(e) }}><Plus size={13} strokeWidth={2.4} /></button>}
    </div>
  )
}
function LaneNode({ data }) {
  const t = useT()
  return (
    <button className={cx('wf-lane', data.other && 'wf-lane-else', data.par && 'wf-lane-par')} onClick={data.onClick}>
      {data.par ? t('wfc.parShort') : data.other ? t('wfc.otherwiseShort') : t('wfc.ifShort')}{data.text && <b>{data.text}</b>}{data.back && <RotateCcw size={10} aria-label={t('wfc.then.back')} />}
    </button>
  )
}
/** A parallel block's join: the run goes on once every lane is through. */
function JoinNode({ data }) {
  const t = useT()
  return (
    <div className={cx('wf-join', data.run && `wf-run-${data.run}`)} onClick={data.onClick} title={t('wfc.joinHint')}>
      <Handle id="l" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="r" type="source" position={Position.Right} isConnectable={false} />
      <Handle id="tt" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="bs" type="source" position={Position.Bottom} isConnectable={false} />
      <GitMerge size={15} /><span><b>{t('wfc.join')}</b><small>{t('wfc.joinN', { n: data.n })}</small></span>
    </div>
  )
}
/** A connection: its + (where a step may go), lit while a drag is over it; green on a run's path. */
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }) {
  const t = useT()
  const [path, x, y] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 16 })
  const keep = useStore(st => Math.min(2.2, Math.max(1, 1 / st.transform[2])))
  // a route's connection: the + near the lane's start (its label sits there too)
  const px = data.route ? targetX - 34 : x, py = data.route ? targetY : y
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cx('wf-edge', data.hot && 'wf-edge-hot', data.passed && 'wf-edge-passed')} />
      {data.can && (
        <EdgeLabelRenderer>
          <div className={cx('wf-plus nodrag nopan', data.hot && 'wf-hot')} style={{ transform: `translate(-50%, -50%) translate(${px}px, ${py}px) scale(${keep})` }}>
            <button className="wf-plus-btn" title={t('wf.addStep')} aria-label={t('wf.addStep')} onClick={e => { e.stopPropagation(); data.onPlus(e) }}><Plus size={11} strokeWidth={2.6} /></button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
/** A loop back: an arc over the steps, to the step the work goes back to (a step round itself: a small loop over it). */
function LoopEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }) {
  const h = Math.min(120, 40 + Math.abs(sourceX - targetX) * 0.1), apex = Math.min(sourceY, targetY) - h
  const path = Math.abs(sourceX - targetX) < 1 && Math.abs(sourceY - targetY) < 1
    ? `M ${sourceX - 14} ${sourceY} C ${sourceX - 34} ${sourceY - 44}, ${sourceX + 34} ${sourceY - 44}, ${sourceX + 14} ${sourceY}`
    : `M ${sourceX} ${sourceY} C ${sourceX} ${apex}, ${targetX} ${apex}, ${targetX} ${targetY}`
  const t = useT()
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cx('wf-loop', data?.own && 'wf-loop-own', data?.route && 'wf-loop-route', data?.on && 'wf-loop-on')} />
      {/* a route's way back says how many rounds it takes before a person decides */}
      {data?.max && <EdgeLabelRenderer><div className="wf-loop-max" style={{ transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${apex + 8}px)` }}>{t('wfc.backMaxShort', { n: data.max })}</div></EdgeLabelRenderer>}
    </>
  )
}
/** An empty route: where its first step goes (straight on until then). */
function SlotNode({ data }) {
  const t = useT()
  return (
    <div className={cx('wf-slot', data.add && 'wf-slot-on')} onClick={e => data.add?.(e)}>
      <Handle id="l" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="r" type="source" position={Position.Right} isConnectable={false} />
      <Handle id="ts" type="source" position={Position.Top} isConnectable={false} />{/* an empty route that goes back: its loop starts here */}
      {data.add ? <><Plus size={14} />{t('wfc.fillRoute')}</> : t('wfc.straightOn')}
    </div>
  )
}
const NODE_TYPES = { step: StepNode, lane: LaneNode, slot: SlotNode, join: JoinNode }
const EDGE_TYPES = { flow: FlowEdge, loop: LoopEdge }

// ── the node library (what a + offers) ──

function BlockPicker({ at, builtIn, lane, par, data, restorable, onClose, onPick }) {
  const t = useT()
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const ref = useRef(null)
  const groups = [
    ['agent', PRESETS.filter(p => p.group === 'agent')],
    ['model', PRESETS.filter(p => p.group === 'model')],
    ['script', [PRESETS.find(p => p.key === 'command'), ...(lane ? [] : [PRESETS.find(p => p.key === 'flow')]), ...(data.scripts || []).map(s => ({ key: `script:${s.ref}`, use: 'script', group: 'script', script: s.ref, icon: 'script', desc: s.description }))]],
    // a parallel block's lane: work that only reads, beside the other lanes (no sign-off, no branch)
    ...(par ? [] : [['human', PRESETS.filter(p => p.group === 'human')]]),
    ...(lane ? [] : [['flow', PRESETS.filter(p => p.group === 'flow')]]),
    ...(restorable.length ? [['restore', restorable.map(it => ({ key: `restore:${it.uid}`, restore: it.uid, icon: 'restore', title: t('wfc.restore', { step: t(`stage.${it.base.key}`) }), desc: t(`set.stageHint.${it.base.key}`) !== `set.stageHint.${it.base.key}` ? t(`set.stageHint.${it.base.key}`) : '' }))]] : []),
  ]
  const label = p => p.title || (p.script ? p.script : t(`wfp.${p.key}.title`))
  const desc = p => p.desc ?? t(`wfp.${p.key}.desc`)
  const needle = q.trim().toLowerCase()
  const shown = groups.map(([g, list]) => [g, list.filter(p => !needle || `${label(p)} ${desc(p)}`.toLowerCase().includes(needle))]).filter(([, list]) => list.length)
  const flat = shown.flatMap(([, list]) => list)
  useEffect(() => { setHi(0) }, [q])
  useEffect(() => {
    const out = e => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    setTimeout(() => window.addEventListener('pointerdown', out))
    return () => window.removeEventListener('pointerdown', out)
  }, [])
  const key = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(flat.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)) }
    else if (e.key === 'Enter' && flat[hi]) { e.preventDefault(); onPick(flat[hi]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }
  // keep it inside the canvas
  const style = { left: Math.max(8, Math.min(at.x, at.w - 336)), top: Math.max(8, Math.min(at.y - 20, at.h - 470)) }
  let n = -1
  return (
    <div ref={ref} className="wf-picker" style={style} role="dialog" aria-label={t('wfc.library')}>
      <label className="wf-picker-search"><Search size={14} /><input autoFocus value={q} placeholder={t('wfc.searchBlocks')} onChange={e => setQ(e.target.value)} onKeyDown={key} /><kbd>Esc</kbd></label>
      {builtIn && <div className="wf-picker-fork"><GitFork size={13} /><span>{t('wfc.forkNote')}</span></div>}
      <div className="wf-picker-list">
        {shown.map(([g, list]) => (
          <div key={g} className="wf-picker-group">
            <div className="wf-picker-h">{t(`wfc.group.${g}`)}</div>
            {list.map(p => {
              n++
              const Icon = PRESET_ICON[p.icon || p.key] || Sparkles, mine = n
              return (
                <button key={p.key} className={cx('wf-picker-item', `wf-pk-${p.group || 'restore'}`, hi === mine && 'wf-on')} onMouseEnter={() => setHi(mine)} onClick={() => onPick(p)}
                  draggable={!builtIn && !p.restore && !p.script} onDragStart={e => { e.dataTransfer.setData(MIME, p.key); e.dataTransfer.effectAllowed = 'copy' }}>
                  <span className="wf-picker-icon"><Icon size={15} /></span>
                  <span className="wf-picker-text"><b>{label(p)}</b>{desc(p) && <small>{desc(p)}</small>}</span>
                </button>
              )
            })}
          </div>
        ))}
        {!flat.length && <p className="wf-picker-empty">{t('wfc.noBlocks')}</p>}
      </div>
      <div className="wf-picker-foot"><span><kbd>↑</kbd><kbd>↓</kbd> {t('wfc.kbdMove')}</span><span><kbd>Enter</kbd> {t('wfc.kbdPick')}</span><span><kbd>Tab</kbd> {t('wfc.kbdTab')}</span></div>
    </div>
  )
}

// ── the runs of this workflow ──

function RunsPanel({ runs, run, onPick, onOpen }) {
  const t = useT()
  const now = Date.now()
  return (
    <aside className="wf-runs">
      <div className="wf-runs-h"><History size={13} />{t('wfc.runsOf')}<span className="wb-sub">{runs.length}</span></div>
      {!runs.length ? <p className="wf-runs-empty">{t('wfc.noRuns')}</p> : <p className="wf-runs-note"><Lock size={11} />{t('wfc.runView')}</p>}
      <div className="wf-runs-list">
        {runs.map(r => (
          <button key={r.id} className={cx('wf-run-row', run?.id === r.id && 'wf-on')} onClick={() => onPick(r.id)}>
            <span className={cx('wf-run-dot', `wf-rd-${r.status}`)} />
            <span className="wf-run-text"><b>{runTitle(r)}</b><small>{r.verdict?.level ? verdictText(t, r.verdict.level) : t(`status.${r.status}`)} · {t('ago', { t: dur(now - (r.endedAt || r.createdAt)) })}</small></span>
          </button>
        ))}
      </div>
      {run && <button className="wb-btn wb-small wf-runs-open" onClick={() => onOpen(run.id)}><ExternalLink size={12} />{t('wfc.openRun')}</button>}
    </aside>
  )
}

// ── the inspector ──

/** A step's command-line tools beyond the image's, one a line (lib/toolbox.js): put in place before it runs. */
function CliInput({ value, onChange }) {
  const t = useT()
  const [text, setText] = useState((value || []).join('\n'))
  useEffect(() => { if ((value || []).join('\n') !== text.split('\n').map(x => x.trim()).filter(Boolean).join('\n')) setText((value || []).join('\n')) }, [value])
  return (
    <Field label={t('wfc.cli')} hint={t('wfc.cliHint')} wide>
      <textarea className="wb-input wb-mono" rows={Math.min(Math.max((value || []).length + 1, 2), 8)} value={text} placeholder={'golangci-lint@1\nshellcheck\npipx:bandit'}
        onChange={e => { setText(e.target.value); const list = [...new Set(e.target.value.split('\n').map(x => x.trim()).filter(Boolean))]; onChange(list.length ? list : undefined) }} />
    </Field>
  )
}

/**
 * A script step (lib/flow): its script — each wf.step kept, so a run that stops goes on from the first one not done — the
 * agents it asks by role (an agent of the pool each, with its access), its parameters (their defaults; a run may give its
 * own) and its command-line tools.
 */
function FlowSettings({ s, data, onChange, openAgents }) {
  const t = useT()
  const agents = s.agents || {}, params = s.params || {}
  const asked = agentRoles(s.source), steps = stepNames(s.source)
  const roles = [...new Set([...Object.keys(agents), ...asked])]
  const setAgent = (role, patch) => onChange({ agents: { ...agents, [role]: { agent: '', fallback: '', access: 'read', ...agents[role], ...patch } } })
  const dropAgent = role => { const { [role]: _drop, ...rest } = agents; onChange({ agents: rest }) }
  const [role, setRole] = useState('')
  const [param, setParam] = useState('')
  return <>
    <Field label={t('wfc.flow.source')} hint={t('wfc.flow.sourceHint')} wide>
      <textarea className="wb-input wb-mono wf-flow-code" rows={16} spellCheck={false} value={s.source || ''} onChange={e => onChange({ source: e.target.value })} />
    </Field>
    <div className="wb-sub">{steps.length ? t('wfc.flow.steps', { list: steps.join(' → ') }) : t('wfc.flow.noSteps')}</div>
    <div className="wf-sec-h">{t('wfc.flow.agents')}<button className="wb-linkbtn wf-push" onClick={openAgents}>{t('wfc.manageAgents')}<ExternalLink size={10} /></button></div>
    {roles.map(r => (
      <div key={r} className="wf-flow-role">
        <span className="wb-mono">{r}</span>
        {!agents[r] ? <button className="wb-btn wb-small" onClick={() => setAgent(r, {})}><Plus size={12} />{t('wfc.flow.addRole')}</button> : <>
          <AgentSelect value={agents[r].agent} agents={data.agents} onChange={v => setAgent(r, { agent: v })} />
          <select className="wb-input" value={agents[r].access} onChange={e => setAgent(r, { access: e.target.value })}><option value="read">{t('wf.access.read')}</option><option value="write">{t('wf.access.write')}</option></select>
          {!asked.includes(r) && <button className="wb-icon-btn" onClick={() => dropAgent(r)} aria-label={t('wf.remove')}><Trash2 size={12} /></button>}
        </>}
      </div>
    ))}
    <div className="wf-flow-role">
      <input className="wb-input wb-mono" value={role} placeholder={t('wfc.flow.rolePh')} onChange={e => setRole(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
      <button className="wb-btn wb-small" disabled={!role || agents[role]} onClick={() => { setAgent(role, {}); setRole('') }}><Plus size={12} />{t('wfc.flow.addRole')}</button>
    </div>
    <div className="wf-sec-h">{t('wfc.flow.params')}</div>
    {Object.entries(params).map(([k, p]) => (
      <div key={k} className="wf-flow-role">
        <span className="wb-mono">{k}</span>
        <input className="wb-input" value={p.title || ''} placeholder={t('wfc.flow.paramTitle')} onChange={e => onChange({ params: { ...params, [k]: { ...p, title: e.target.value } } })} />
        <input className="wb-input wb-mono" value={p.default ?? ''} placeholder={t('wfc.flow.paramDefault')} onChange={e => onChange({ params: { ...params, [k]: { ...p, default: e.target.value } } })} />
        <button className="wb-icon-btn" onClick={() => { const { [k]: _drop, ...rest } = params; onChange({ params: rest }) }} aria-label={t('wf.remove')}><Trash2 size={12} /></button>
      </div>
    ))}
    <div className="wf-flow-role">
      <input className="wb-input wb-mono" value={param} placeholder={t('wfc.flow.paramPh')} onChange={e => setParam(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} />
      <button className="wb-btn wb-small" disabled={!param || params[param]} onClick={() => { onChange({ params: { ...params, [param]: { title: '', default: '' } } }); setParam('') }}><Plus size={12} />{t('wfc.flow.addParam')}</button>
    </div>
    <CliInput value={s.cli} onChange={cli => onChange({ cli })} />
  </>
}

/** The arguments, one row each: a row holds one argument, its spaces and quotes included (never split again). */
function ArgsInput({ value, onChange }) {
  const t = useT()
  return (
    <div className="wf-args">
      {value.map((a, i) => (
        <div key={i} className="wf-arg">
          <input className="wb-input wb-mono" value={a} aria-label={t('wfc.argN', { n: i + 1 })} onChange={e => onChange(editList(value, i, e.target.value))} />
          <button className="wb-icon-btn" aria-label={t('wfc.removeArg')} title={t('wfc.removeArg')} onClick={() => onChange(editList(value, i))}><X size={13} /></button>
        </div>
      ))}
      {value.length < 20 && <button className="wb-btn wb-small" onClick={() => onChange(editList(value, value.length, ''))}><Plus size={12} />{t('wfc.addArg')}</button>}
    </div>
  )
}
const Field = ({ label, hint, wide, children }) => <label className={cx('wf-field', wide && 'wf-wide')}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
const Switch = ({ on, onChange, label, hint }) => (
  <label className="wf-switch-row"><span className={cx('wf-switch', on && 'wf-on')}><input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} /><i /></span><span><b>{label}</b>{hint && <small>{hint}</small>}</span></label>
)

// In the runs view (`run`) a step is read, not edited: what it did in that run, and what the step is (its settings are
// the draft's, edited in the edit view).
function StepInspector({ at, items, builtIn, data, rules, wf, errors, runs, run, needs = [], needsCtl, onChange, onToggle, onRemove, onClose, openAgents, onAddAfter, onRoute, onLane }) {
  const t = useT()
  const it = at.it, s = it.step, b = it.base
  const [tab, setTab] = useState(run ? 'runs' : 'settings')
  // what the step is, its gate and its evidence: the words of the workflow's pack (or the core's) for that step
  const tx = part => { if (!b) return ''; const k = `pf.${b.key}.${part}`, v = t(k); return v === k ? '' : v }
  const kind = kindOf(it)
  const Icon = kind === 'model' ? Zap : b ? stageIcon(b.key, !!b.agent) : iconOf(kind, s.ask) || Cog
  // the steps before this one on its path (a condition's step, what a step handed back — a parallel block's lanes too)
  const before = beforeOf(items, at).map(x => ({ ...x, title: x.title || t(`stage.${x.key}`) }))
  const backTo = before.filter(x => !x.inLane) // where a step (or a route) can go back to
  const laneStep = inParallel(items, at.lane) // beside other lanes: it only reads, and stops or carries on
  const onFail = typeof s.onFail === 'object' ? 'goto' : s.onFail || 'stop'
  const canAfter = !builtIn && !it.lanes
  return (
    <div className="wf-insp">
      <div className="wf-insp-head">
        <span className={cx('wf-insp-icon', `wf-k-${kind}`, !b && 'wf-own')}><Icon size={16} /></span>
        <div className="wf-insp-title">
          {b || run ? <h4>{b ? t(`stage.${b.key}`) : s.title || s.id}</h4> : <input className="wf-title-input wf-small" value={s.title} onChange={e => onChange({ title: e.target.value })} aria-label={t('wf.stepTitle')} />}
          <span className="wb-sub wb-mono">{b ? b.key : s.id} · {t(kind === 'person' ? `wfp.${s.ask}.title` : `wfc.kind.${kind}`)}</span>
        </div>
        <button className="wb-icon-btn wf-push" onClick={onClose} aria-label={t('close')}><X size={15} /></button>
      </div>
      <div className="wf-tabs" role="tablist">
        {[...(run ? [] : ['settings']), 'runs', ...(b ? ['about'] : [])].map(k => <button key={k} role="tab" aria-selected={tab === k} className={cx(tab === k && 'wf-on')} onClick={() => setTab(k)}>{t(`wfc.tab.${k}`)}</button>)}
      </div>
      {errors.length > 0 && <div className="wb-note wb-t-amber"><AlertTriangle size={13} /><span>{errors.map(e => e.message).join(' · ')}</span></div>}
      {tab === 'about' && b && <>
        {tx('what') && <p className="wf-insp-what">{tx('what')}</p>}
        {(tx('gate') || tx('evidence')) && <dl className="wf-facts">
          {tx('gate') && <><dt><ShieldCheck size={12} />{t('pf.col.gate')}</dt><dd>{tx('gate')}</dd></>}
          {tx('evidence') && <><dt><FileText size={12} />{t('pf.col.evidence')}</dt><dd>{tx('evidence')}</dd></>}
        </dl>}
        {b.agent?.text && <p className="wf-role"><b className="wb-mono">{b.owner}</b> · {b.agent.text}</p>}
      </>}
      {tab === 'runs' && <StepRuns k={b ? b.key : s.id} runs={runs} run={run} />}
      {tab === 'settings' && !run && <>
        {needs.length > 0 && <NeedsSection items={needs} ctl={needsCtl} step={b ? b.key : s.id} />}
        {b && <>
          {tx('what') && <p className="wf-insp-what wf-clamp">{tx('what')}</p>}
          {b.optional
            ? (builtIn
              ? <Switch on={it.included} onChange={onToggle} label={t('wfc.run')} hint={[t(`set.stageHint.${b.key}`) !== `set.stageHint.${b.key}` ? t(`set.stageHint.${b.key}`) : '', t('wfc.optionalAll')].filter(Boolean).join(' ')} />
              : <button className="wb-btn wb-small" onClick={onRemove}><MinusCircle size={12} />{t('wfc.leaveOut')}</button>)
            : <div className="wf-req"><Lock size={11} />{t('wf.requiredHint')}</div>}
          {b.model && it.included && <section className="wf-sec">
            <div className="wf-sec-h">{t('wfc.who')}</div>
            <Field label={t('set.stepModel')} hint={t('wfc.modelHint')}><ModelPicker value={s.model} def={b.model.model} models={data.models} connections={data.connectors} onChange={v => onChange({ model: v || undefined })} /></Field>
          </section>}
          {b.agent && it.included && <section className="wf-sec">
            <div className="wf-sec-h">{t('wfc.who')}<button className="wb-linkbtn wf-push" onClick={openAgents}>{t('wfc.manageAgents')}<ExternalLink size={10} /></button></div>
            <Field label={t('set.stepAgent')}><AgentSelect value={s.agent} agents={data.agents} def={b.agent.agent} onChange={v => onChange({ agent: v || undefined })} /></Field>
            <Field label={t('set.stepFallback')}><AgentSelect value={s.fallback === '' ? '-' : s.fallback} agents={data.agents} def={b.agent.fallback} none onChange={v => onChange({ fallback: v === '-' ? '' : v || undefined })} /></Field>
            <Field label={t('wfc.skills')} hint={t('wfc.skillsHint')}><SkillPicker value={s.skills} skills={data.skills} onChange={v => onChange({ skills: v.length ? v : undefined })} /></Field>
            {!builtIn && <CliInput value={s.cli} onChange={cli => onChange({ cli })} />}
          </section>}
        </>}
        {!b && s.use === 'branch' && <BranchSettings s={s} it={it} data={data} wf={wf} before={before} backTo={backTo} onChange={onChange} onRoute={onRoute} openAgents={openAgents} />}
        {!b && s.use === 'parallel' && <ParallelSettings s={s} it={it} backTo={backTo} onChange={onChange} onLane={onLane} />}
        {!b && !['branch', 'parallel'].includes(s.use) && <section className="wf-sec">
          {laneStep && <div className="wf-tip"><Split size={13} /><span>{t('wfc.laneStepHint')}</span></div>}
          <Field label={t('wf.id')}><input className="wb-input wb-mono" value={s.id} onChange={e => onChange({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></Field>
          {s.use === 'agent' && <>
            <Field label={t('wf.instructions')} wide><textarea className="wb-input" rows={6} value={s.instructions} placeholder={t('wf.instructionsPh')} onChange={e => onChange({ instructions: e.target.value })} /></Field>
            <div className="wf-sec-h">{t('wfc.who')}<button className="wb-linkbtn wf-push" onClick={openAgents}>{t('wfc.manageAgents')}<ExternalLink size={10} /></button></div>
            <Field label={t('set.stepAgent')}><AgentSelect value={s.agent} agents={data.agents} onChange={v => onChange({ agent: v })} /></Field>
            <Field label={t('set.stepFallback')}><AgentSelect value={s.fallback || '-'} agents={data.agents} none onChange={v => onChange({ fallback: v === '-' ? '' : v })} /></Field>
            <Field label={t('wf.access')}><select className="wb-input" value={s.access} disabled={laneStep && s.access === 'read'} onChange={e => onChange({ access: e.target.value })}><option value="read">{t('wf.access.read')}</option><option value="write">{t('wf.access.write')}</option></select></Field>
            <Field label={t('wfc.skills')} hint={t('wfc.skillsHint')}><SkillPicker value={s.skills || []} skills={data.skills} onChange={v => onChange({ skills: v })} /></Field>
            <div className="wf-field wf-wide"><span>{t('wf.tools')}</span>
              <div className="wf-chips">{data.tools.filter(x => !ALWAYS.includes(x.name)).map(x => (
                <button key={x.name} type="button" title={x.description} className={cx('wf-toggle', s.tools?.includes(x.name) && 'wf-on')} onClick={() => onChange({ tools: s.tools?.includes(x.name) ? s.tools.filter(n => n !== x.name) : [...(s.tools || []), x.name] })}>{x.name}</button>
              ))}</div>
              <small>{t('wf.toolsHint')}</small></div>
            <CliInput value={s.cli} onChange={cli => onChange({ cli })} />
          </>}
          {s.use === 'model' && <>
            <Field label={t('wf.instructions')} wide><textarea className="wb-input" rows={6} value={s.instructions} placeholder={t('wf.modelInstructionsPh')} onChange={e => onChange({ instructions: e.target.value })} /></Field>
            <Field label={t('set.stepModel')} hint={t('wfc.modelHint')}><ModelPicker value={s.model} def={data.defaultModel || ''} models={data.models} connections={data.connectors} onChange={v => onChange({ model: v })} /></Field>
          </>}
          {s.use === 'script' && <>
            {(data.scripts?.length > 0 || s.script) && <Field label={t('wfc.useScript')}>
              <select className="wb-input" value={s.script || ''} onChange={e => onChange(e.target.value ? { script: e.target.value, args: s.args || [] } : { script: undefined, run: s.run || '' })}>
                <option value="">{t('wfc.ownCommand')}</option>
                {s.script && !data.scripts?.some(x => x.ref === s.script) && <option value={s.script}>{s.script}</option>}
                {(data.scripts || []).map(x => <option key={x.ref} value={x.ref}>{x.ref}{x.description ? ` — ${x.description}` : ''}</option>)}
              </select></Field>}
            {s.script
              ? <Field label={t('wfc.args')} hint={t('wfc.argsHint')}><ArgsInput value={s.args || []} onChange={args => onChange({ args })} /></Field>
              : <Field label={t('wf.command')} wide><textarea className="wb-input wb-mono" rows={4} value={s.run || ''} placeholder="make lint" onChange={e => onChange({ run: e.target.value })} /></Field>}
            <Field label={t('wf.cwd')}><select className="wb-input" value={s.cwd} onChange={e => onChange({ cwd: e.target.value })}><option value="run">{t('wf.cwd.run')}</option><option value="workspace">{t('wf.cwd.workspace')}</option></select></Field>
            <Field label={t('wf.timeout')}><input className="wb-input" type="number" min={1} max={120} value={s.timeoutMinutes} onChange={e => onChange({ timeoutMinutes: Number(e.target.value) })} /></Field>
            <NeedsEditor s={s} levels={laneStep ? ['read'] : ['read', 'write']} data={data} onChange={onChange} />
            <CliInput value={s.cli} onChange={cli => onChange({ cli })} />
          </>}
          {s.use === 'flow' && <FlowSettings s={s} data={data} onChange={onChange} openAgents={openAgents} />}
          {s.use === 'person' && <PersonSettings s={s} backTo={backTo} onChange={onChange} />}
          {s.use === 'output' && <OutputSettings s={s} onChange={onChange} />}
          {s.use === 'approval' && <Field label={t('wf.question')} wide><textarea className="wb-input" rows={3} value={s.text} placeholder={t('wf.questionPh')} onChange={e => onChange({ text: e.target.value })} /></Field>}
          {!['approval', 'person', 'output'].includes(s.use) && <>
            <Field label={t('wf.onFail')}>
              <select className="wb-input" value={onFail} onChange={e => onChange({ onFail: e.target.value === 'goto' ? { goto: backTo.at(-1)?.id, max: 1 } : e.target.value })}>
                {(laneStep ? ['stop', 'continue'] : ['stop', 'continue', 'goto']).map(k => <option key={k} value={k} disabled={k === 'goto' && !backTo.length}>{t(`wf.onFail.${k}`)}</option>)}
              </select></Field>
            {onFail === 'goto' && <>
              <Field label={t('wfc.gotoStep')}><select className="wb-input" value={s.onFail.goto} onChange={e => onChange({ onFail: { ...s.onFail, goto: e.target.value } })}>
                {!backTo.some(x => x.id === s.onFail.goto) && <option value={s.onFail.goto}>{s.onFail.goto}</option>}
                {backTo.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select></Field>
              <Field label={t('wf.gotoMax')}><input className="wb-input" type="number" min={1} max={10} value={s.onFail.max} onChange={e => onChange({ onFail: { ...s.onFail, max: Number(e.target.value) } })} /></Field>
            </>}
          </>}
        </section>}
        <div className="wf-insp-foot">
          {canAfter && <button className="wb-btn wb-small" onClick={onAddAfter}><Plus size={12} />{t('wfc.addNext')}<kbd>Tab</kbd></button>}
          {!b && !builtIn && <button className="wb-btn wb-small wb-danger wf-push" onClick={onRemove}><Trash2 size={12} />{t('wf.removeStep')}</button>}
        </div>
      </>}
    </div>
  )
}

// ── what a step needs here (lib/needs.js) ──
const HARD = ['missing', 'unbound']
const NEED_ICON = { agent: Bot, skill: Wand2, connector: Plug, script: FileCode2, model: Zap, tool: Terminal }
/**
 * A script step's connections: by type and level (each machine binds them to a connection of its own) — or, in an older
 * step, connections named by id (kept as they are until removed).
 */
export function NeedsEditor({ s, levels, data, onChange }) {
  const t = useT()
  const byId = !Array.isArray(s.connectors) && Object.keys(s.connectors || {}).length > 0
  if (byId) return (
    <div className="wf-field wf-wide"><span>{t('wf.connectors')}</span>
      <div className="wf-chips">
        {Object.entries(s.connectors).map(([id, level]) => (
          <span key={id} className="wf-chip-on"><Plug size={11} />{id}
            <select value={level} onChange={e => onChange({ connectors: { ...s.connectors, [id]: e.target.value } })}>{levels.map(l => <option key={l} value={l}>{t(`wf.level.${l}`)}</option>)}</select>
            <button aria-label={t('wf.remove')} onClick={() => { const c = { ...s.connectors }; delete c[id]; onChange({ connectors: Object.keys(c).length ? c : [] }) }}><X size={11} /></button></span>
        ))}
        <select className="wb-input wf-add" value="" onChange={e => e.target.value && onChange({ connectors: { ...s.connectors, [e.target.value]: levels[0] } })}>
          <option value="">{t('wf.addConnector')}</option>
          {data.connectors.filter(c => !(c.id in s.connectors)).map(c => <option key={c.id} value={c.id}>{c.id} · {c.type}</option>)}
        </select>
      </div>
      <small>{t('wfn.byIdHint')}</small></div>
  )
  const list = Array.isArray(s.connectors) ? s.connectors : []
  const set = next => onChange({ connectors: next.map(({ type, level, name }) => ({ type, level, ...(name && { name }) })) })
  const types = [...new Set([...data.connectors.map(c => c.type), ...(data.connectorTypes || [])])].filter(Boolean).sort()
  const add = type => {
    // a second need of a type gets a name of its own (two of a type in one step)
    const name = list.some(n => n.type === type) ? `${type.slice(0, 20)}-${list.filter(n => n.type === type).length + 1}` : ''
    set([...list, { type, level: levels[0], ...(name && { name }) }])
  }
  return (
    <div className="wf-field wf-wide"><span>{t('wf.connectors')}</span>
      <div className="wf-chips">
        {list.map((n, i) => (
          <span key={`${n.type}:${n.name || ''}`} className="wf-chip-on"><Plug size={11} />{n.type}{n.name ? `:${n.name}` : ''}
            <select value={levels.includes(n.level) ? n.level : levels[0]} onChange={e => set(list.map((x, j) => (j === i ? { ...x, level: e.target.value } : x)))}>{levels.map(l => <option key={l} value={l}>{t(`wf.level.${l}`)}</option>)}</select>
            <button aria-label={t('wf.remove')} onClick={() => set(list.filter((_, j) => j !== i))}><X size={11} /></button></span>
        ))}
        {list.length < 8 && <select className="wb-input wf-add" value="" onChange={e => e.target.value && add(e.target.value)}>
          <option value="">{t('wfn.addNeed')}</option>
          {types.map(x => <option key={x} value={x}>{x}</option>)}
        </select>}
      </div>
      <small>{t('wfn.needsHint')}</small></div>
  )
}
/** How a person puts a tool in place that a run cannot (lib/toolbox.js howTo): said, and the command to copy. */
function ToolHow({ how, error }) {
  const t = useT()
  if (!how) return error ? <small className="wb-sub">{error}</small> : null
  const said = how.kind ? t(`tool.how.${how.kind}`, { bin: how.bin || '', error: error || how.error || '' }) : how.text
  return (
    <div className="wf-tool-how">
      <small className="wb-sub">{said === `tool.how.${how.kind}` ? how.text : said}</small>
      {how.cmd && <code className="wb-mono wf-tool-cmd" title={t('tool.copy')} onClick={() => navigator.clipboard?.writeText(how.cmd).catch(() => {})}>{how.cmd}<Copy size={11} /></code>}
    </div>
  )
}
/** One need and how it stands here; a connection need's binding chosen in place. */
function NeedRow({ item: i, ctl, step }) {
  const t = useT()
  const [only, setOnly] = useState(i.how === 'workflow')
  const Icon = NEED_ICON[i.kind] || Plug
  const ofType = (ctl.connections || []).filter(c => c.type === i.type)
  const label = i.kind === 'connector' ? (i.pack ? (i.label?.[t('lang.code')] || i.label?.en || i.ref) : `${i.type || i.ref}${i.name ? `:${i.name}` : ''} · ${t(`wf.level.${i.level}`)}`) : i.ref || t('wfn.noModel')
  const tone = HARD.includes(i.status) ? 'bad' : ['fetch', 'noFallback', 'warn', 'suggested'].includes(i.status) ? 'warn' : 'ok'
  const bindable = i.kind === 'connector' && !i.pack && !String(i.ref).startsWith('id:')
  return (
    <div className={cx('wf-need', `wf-need-${tone}`)}>
      <Icon size={13} className="wf-need-icon" />
      <div className="wf-need-main">
        <div className="wf-need-top"><b className={cx(i.kind !== 'agent' && !i.pack && 'wb-mono')}>{label}</b>{i.fallback && <small>{t('wfn.fallback')}</small>}{i.pin && <small className="wb-mono">@{String(i.pin).slice(0, 10)}</small>}
          <span className="wf-need-st">{t(`wfn.st.${i.pack ? (i.status === 'ok' ? 'ok' : `pack.${i.state}`) : i.status}`, { type: i.type })}</span></div>
        {bindable && (ofType.length
          ? <div className="wf-need-bind">
            <select className="wb-input" value={i.connection || ''} onChange={e => ctl.bind(i.ref, e.target.value || null, only)}>
              {!i.connection && <option value="">{t('wfn.bind')}</option>}
              {ofType.map(c => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
            </select>
            {i.connection && <small>{t(`wfn.how.${i.how}`)}</small>}
            <label className="wf-need-only"><input type="checkbox" checked={only} onChange={e => { setOnly(e.target.checked); if (i.connection) ctl.bind(i.ref, i.connection, e.target.checked) }} />{t('wfn.onlyThis')}</label>
          </div>
          : <button className="wb-linkbtn" onClick={ctl.openConnectors}>{t('wfn.noConnOfType', { type: i.type })}<ExternalLink size={10} /></button>)}
        {(i.pack && i.status !== 'ok') && <button className="wb-linkbtn" onClick={ctl.openConnectors}>{t('wfn.packHint')}<ExternalLink size={10} /></button>}
        {i.kind === 'tool' && i.status === 'missing' ? <ToolHow how={i.how} error={i.error} /> : i.error && <small className="wb-sub">{i.error}</small>}
        {i.status === 'suggested' && <div className="wf-need-bind"><small className="wb-sub">{t('wfn.suggestedHint')}</small>{ctl.addTool && <button className="wb-btn wb-small" onClick={() => ctl.addTool(step, i.ref)}><Plus size={12} />{t('wfn.addTool')}</button>}</div>}
      </div>
    </div>
  )
}
/** A step's needs, in its inspector. */
export function NeedsSection({ items, ctl, step }) {
  const t = useT()
  const fetch = items.some(i => i.status === 'fetch')
  return (
    <section className="wf-sec wf-needs-sec">
      <div className="wf-sec-h">{t('wfn.title')}{fetch && <button className="wb-btn wb-small wf-push" disabled={ctl.busy} onClick={ctl.ensure}>{ctl.busy ? <Loader2 size={12} className="wb-spin" /> : <Download size={12} />}{t('wfn.ensure')}</button>}</div>
      {items.map(i => <NeedRow key={`${i.kind}:${i.ref}:${i.fallback ? 'f' : ''}`} item={i} ctl={ctl} step={step} />)}
    </section>
  )
}
/** The whole workflow's needs here: each step's, what is missing, one click to install what can be installed. */
export function ReadinessPanel({ ready, ctl, onPick, onClose }) {
  const t = useT()
  return (
    <div className="wf-insp">
      <div className="wf-insp-head"><span className="wf-insp-icon wf-k-script"><Plug size={16} /></span>
        <div className="wf-insp-title"><h4>{t('wfn.panelTitle')}</h4><span className="wb-sub">{!ready ? t('loading') : ready.missing ? t('wfn.missing', { n: ready.missing }) : ready.installable ? t('wfn.installable', { n: ready.installable }) : t('wfn.ready')}</span></div>
        <button className="wb-icon-btn wf-push" onClick={onClose} aria-label={t('close')}><X size={15} /></button></div>
      <p className="wf-insp-what">{t('wfn.panelHint')}</p>
      {ready?.installable > 0 && <button className="wb-btn wb-small wb-primary" disabled={ctl.busy} onClick={ctl.ensure}>{ctl.busy ? <Loader2 size={12} className="wb-spin" /> : <Download size={12} />}{t('wfn.ensure')}</button>}
      {!ready ? <div className="wb-skeleton"><span /><span /></div> : ready.steps.map(st => (
        <section key={st.id} className="wf-sec">
          {st.id.startsWith('pack:')
            ? <div className="wf-sec-h">{t('wfn.packTitle')}</div>
            : <button className="wf-sec-h wf-need-step" onClick={() => onPick(st.id)}>{st.title || t(`stage.${st.id}`)}<span className="wb-sub wb-mono">{st.id}</span></button>}
          {st.items.map(i => <NeedRow key={`${i.kind}:${i.ref}:${i.fallback ? 'f' : ''}`} item={i} ctl={ctl} step={st.id} />)}
        </section>
      ))}
      {ready && !ready.steps.length && <p className="wb-sub">{t('wfn.nothing')}</p>}
    </div>
  )
}

/**
 * A person step's settings: what it asks of the person; a review's way back when they ask for changes; a decision's
 * choices (each may go back to a step); how long it waits before the person is reminded.
 */
export function PersonSettings({ s, backTo, onChange }) {
  const t = useT()
  const back = (value, set, none) => (
    <select className="wb-input" value={value || ''} onChange={e => set(e.target.value || undefined)}>
      <option value="">{t(none)}</option>
      {value && !backTo.some(x => x.id === value) && <option value={value}>{value}</option>}
      {backTo.map(x => <option key={x.id} value={x.id}>{t('wfc.person.backTo', { step: x.title })}</option>)}
    </select>
  )
  const opts = s.options || []
  return <>
    <div className="wf-field"><span>{t('wfc.person.ask')}</span>
      <div className="wf-seg wf-seg-full">
        {['review', 'input', 'decide', 'do', 'chat'].map(k => <button key={k} className={cx(s.ask === k && 'wf-on')} onClick={() => onChange({ ask: k, wait: PERSON_WAIT[k], ...(k === 'decide' && !opts.length && { options: [{ label: '' }, { label: '' }] }), ...(k !== 'review' && k !== 'chat' && { back: undefined }), ...(k !== 'chat' && { with: undefined }), ...(k !== 'decide' && { options: undefined }) })}>{(() => { const I = PRESET_ICON[k]; return <I size={12} /> })()}{t(`wfp.${k}.title`)}</button>)}
      </div>
      <small>{t(`wfp.${s.ask}.desc`)}</small></div>
    <Field label={t('wfc.person.text')} wide><textarea className="wb-input" rows={3} value={s.text || ''} placeholder={t(`wfc.person.${s.ask}.ph`)} onChange={e => onChange({ text: e.target.value })} /></Field>
    {s.ask === 'review' && <Field label={t('wfc.person.changes')} hint={t('wfc.person.changesHint')}>{back(s.back, v => onChange({ back: v }), 'wfc.person.noBack')}</Field>}
    {s.ask === 'chat' && <Field label={t('wfc.person.with')} hint={t('wfc.person.withHint')}>
      <select className="wb-input" value={s.with || ''} onChange={e => onChange({ with: e.target.value || undefined })}>
        <option value="">{t('wfc.person.withLatest')}</option>
        {s.with && !backTo.some(x => x.id === s.with) && <option value={s.with}>{s.with}</option>}
        {backTo.filter(x => x.use === 'agent' || (x.use === 'base' && !['intake', 'report'].includes(x.key))).map(x => <option key={x.id} value={x.id}>{x.title}</option>)}
      </select></Field>}
    {s.ask === 'chat' && <Field label={t('wfc.person.chatBack')} hint={t('wfc.person.chatBackHint')}>{back(s.back, v => onChange({ back: v }), 'wfc.person.chatNoBack')}</Field>}
    {s.ask === 'review' && <ReviewSettings s={s} agents={backTo.filter(x => x.use === 'agent' || (x.use === 'base' && !['intake', 'report'].includes(x.key)))} onChange={onChange} />}
    {s.ask === 'decide' && <div className="wf-field wf-wide"><span>{t('wfc.person.options')}</span>
      {opts.map((o, i) => (
        <div key={i} className="wf-arg">
          <input className="wb-input" value={o.label} aria-label={t('wfc.person.option')} placeholder={t('wfc.person.option')} onChange={e => onChange({ options: editList(opts, i, { ...o, label: e.target.value }) })} />
          {back(o.to, to => onChange({ options: editList(opts, i, { label: o.label, ...(to && { to }) }) }), 'wfc.person.goOn')}
          <button className="wb-icon-btn" disabled={opts.length <= 2} aria-label={t('wf.remove')} onClick={() => onChange({ options: editList(opts, i) })}><X size={12} /></button>
        </div>
      ))}
      {opts.length < 6 && <button type="button" className="wb-linkbtn" onClick={() => onChange({ options: editList(opts, opts.length, { label: '' }) })}><Plus size={11} />{t('wfc.person.addOption')}</button>}
      <small>{t('wfc.person.optionsHint')}</small></div>}
    <Field label={t('wfc.person.wait')} hint={t('wfc.person.waitHint')}><input className="wb-input" type="number" min={0} max={720} value={s.wait ?? PERSON_WAIT[s.ask]} onChange={e => onChange({ wait: Math.max(0, Math.min(720, Math.round(Number(e.target.value)) || 0)) })} /></Field>
  </>
}

/** A 结果 step's: the files that are the run's results (lib/results.js), a line about them. */
function OutputSettings({ s, onChange }) {
  const t = useT()
  const [show, setShow] = useState((s.show || []).join(', '))
  useEffect(() => { setShow((s.show || []).join(', ')) }, [s.id])
  const list = v => v.split(',').map(x => x.trim()).filter(Boolean)
  return <>
    <Field label={t('wfc.output.show')} hint={t('wfc.output.showHint')} wide>
      <input className="wb-input wb-mono" value={show} placeholder="report.pdf, site/index.html, out/*.mp4" onChange={e => setShow(e.target.value)} onBlur={() => onChange({ show: list(show).length ? list(show) : undefined })} />
    </Field>
    <Field label={t('wfc.output.text')} wide><input className="wb-input" value={s.text || ''} placeholder={t('wfc.output.textPh')} onChange={e => onChange({ text: e.target.value })} /></Field>
    <p className="wb-sub">{t('wfc.output.about')}</p>
  </>
}

/** A review's own settings (lib/review.js): what it shows, who revises with the person's comments, how many rounds, a note first. */
function ReviewSettings({ s, agents, onChange }) {
  const t = useT()
  const [show, setShow] = useState((s.show || []).join(', '))
  useEffect(() => { setShow((s.show || []).join(', ')) }, [s.id])
  const list = v => v.split(',').map(x => x.trim()).filter(Boolean)
  return <>
    <Field label={t('wfc.rv.show')} hint={t('wfc.rv.showHint')} wide>
      <input className="wb-input wb-mono" value={show} placeholder="draft.md, posts/*.json" onChange={e => setShow(e.target.value)} onBlur={() => onChange({ show: list(show).length ? list(show) : undefined })} />
    </Field>
    <Field label={t('wfc.rv.by')} hint={t('wfc.rv.byHint')}>
      <select className="wb-input" value={s.revisedBy === false ? '-' : s.revisedBy || ''} onChange={e => onChange({ revisedBy: e.target.value === '-' ? false : e.target.value || undefined })}>
        <option value="">{t('wfc.rv.byAuto')}</option>
        {agents.map(x => <option key={x.id} value={x.id}>{t('wfc.rv.byStep', { step: x.title })}</option>)}
        <option value="-">{t('wfc.rv.byNone')}</option>
      </select>
    </Field>
    <Field label={t('wfc.rv.rounds')} hint={t('wfc.rv.roundsHint')}><input className="wb-input" type="number" min={1} max={20} value={s.rounds ?? 5} onChange={e => onChange({ rounds: Math.max(1, Math.min(20, Math.round(Number(e.target.value)) || 5)) })} /></Field>
    <label className="wb-check"><input type="checkbox" checked={!!s.gather} onChange={e => onChange({ gather: e.target.checked || undefined })} />{t('wfc.rv.gather')}</label>
  </>
}

/** A branch: how it picks (a condition per route, or its agent), its routes, "otherwise". */
/** After a route's steps: on to the step after the branch, or back to an earlier one (at most `max` rounds, then a person). */
function RouteThen({ back, backTo, set }) {
  const t = useT()
  return (
    <div className="wf-then">
      <span className="wb-sub">{t('wfc.then')}</span>
      <select className="wb-input" value={back ? 'back' : 'continue'} onChange={e => set(e.target.value === 'back' ? { to: backTo.at(-1)?.id || '', max: 2 } : undefined)}>
        <option value="continue">{t('wfc.then.continue')}</option>
        <option value="back" disabled={!backTo.length}>{t('wfc.then.back')}</option>
      </select>
      {back && <>
        <select className="wb-input" value={back.to} onChange={e => set({ ...back, to: e.target.value })}>
          {!backTo.some(x => x.id === back.to) && <option value={back.to}>{back.to || '—'}</option>}
          {backTo.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}
        </select>
        <label className="wf-then-max"><input className="wb-input" type="number" min={1} max={10} value={back.max} onChange={e => set({ ...back, max: Number(e.target.value) })} /><span>{t('wfc.backMax')}</span></label>
      </>}
    </div>
  )
}
function BranchSettings({ s, it, data, wf, before, backTo, onChange, onRoute, openAgents }) {
  const t = useT()
  const outputs = before.filter(x => ['agent', 'model', 'script', 'person', 'flow'].includes(x.use))
  const whenKind = w => (w?.output !== undefined ? 'output' : w?.verdict !== undefined ? 'verdict' : 'step')
  const setKind = (k, kind) => onRoute.change(k, { when: kind === 'step' ? { step: before.at(-1)?.id || '', is: 'passed' } : kind === 'output' ? { output: outputs.at(-1)?.id || '', has: '' } : { verdict: 'failed' } })
  return (
    <section className="wf-sec">
      <Field label={t('wf.id')}><input className="wb-input wb-mono" value={s.id} onChange={e => onChange({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></Field>
      <div className="wf-field"><span>{t('wfc.branchBy')}</span>
        <div className="wf-seg wf-seg-full">
          {['condition', 'agent'].map(m => <button key={m} className={cx(s.mode === m && 'wf-on')} onClick={() => onChange(m === 'agent'
            ? { mode: 'agent', agent: s.agent || data.defaultAgent || data.agents[0]?.id || '', routes: s.routes.map(({ when: _w, ...r }) => ({ ...r, hint: r.hint || '' })) }
            : { mode: 'condition', routes: s.routes.map(({ hint: _h, ...r }) => ({ ...r, when: r.when || { step: before.at(-1)?.id || '', is: 'passed' } })) })}>{m === 'agent' ? <Network size={12} /> : <GitFork size={12} />}{t(`wfc.branchBy.${m}`)}</button>)}
        </div>
        <small>{t(`wfc.branchBy.${s.mode}.hint`)}</small></div>
      {s.mode === 'agent' && <>
        <div className="wf-sec-h">{t('wfc.who')}<button className="wb-linkbtn wf-push" onClick={openAgents}>{t('wfc.manageAgents')}<ExternalLink size={10} /></button></div>
        <Field label={t('set.stepAgent')}><AgentSelect value={s.agent} agents={data.agents} onChange={v => onChange({ agent: v })} /></Field>
        <Field label={t('set.stepFallback')}><AgentSelect value={s.fallback || '-'} agents={data.agents} none onChange={v => onChange({ fallback: v === '-' ? '' : v })} /></Field>
        <Field label={t('wfc.routerHow')} wide><textarea className="wb-input" rows={3} value={s.instructions || ''} placeholder={t('wfc.routerHowPh')} onChange={e => onChange({ instructions: e.target.value })} /></Field>
      </>}
      <div className="wf-sec-h">{t('wfc.routes')}</div>
      {s.routes.map((r, k) => (
        <div key={k} className="wf-route">
          <div className="wf-route-head">
            <span className="wf-route-tag">{t('wfc.ifShort')}</span>
            <input className="wb-input" value={r.label} onChange={e => onRoute.change(k, { label: e.target.value })} aria-label={t('wfc.routeName')} />
            <span className="wb-sub">{t('wfc.stepsN', { n: it.lanes[k].items.length })}</span>
            {s.routes.length > 1 && <button className="wb-icon-btn" onClick={() => onRoute.remove(k)} aria-label={t('wfc.removeRoute')}><Trash2 size={13} /></button>}
          </div>
          {s.mode === 'condition'
            ? <div className="wf-when">
              <select className="wb-input" value={whenKind(r.when)} onChange={e => setKind(k, e.target.value)}>
                {['step', 'output', 'verdict'].map(x => <option key={x} value={x} disabled={x === 'output' && !outputs.length}>{t(`wfc.when.${x}`)}</option>)}
              </select>
              {whenKind(r.when) === 'step' && <>
                <select className="wb-input" value={r.when.step} onChange={e => onRoute.change(k, { when: { ...r.when, step: e.target.value } })}>{before.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
                <select className="wb-input" value={r.when.is} onChange={e => onRoute.change(k, { when: { ...r.when, is: e.target.value } })}>{['passed', 'failed', 'skipped'].map(x => <option key={x} value={x}>{t(`wfc.is.${x}`)}</option>)}</select>
                {/* "failed" only happens to a step of yours that carries on */}
                {r.when.is === 'failed' && (() => { const x = before.find(y => y.id === r.when.step); if (!x || x.onFail === 'continue') return null
                  return <div className="wf-when-note">{x.use === 'base' ? t('wfc.failStopsBase') : <>{t('wfc.failStops')}<button className="wb-linkbtn" onClick={() => onRoute.patchStep(x.id, { onFail: 'continue' })}>{t('wfc.failCarryOn')}</button></>}</div> })()}
              </>}
              {whenKind(r.when) === 'output' && <>
                <select className="wb-input" value={r.when.output} onChange={e => onRoute.change(k, { when: { ...r.when, output: e.target.value } })}>{outputs.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
                <input className="wb-input" value={r.when.has} placeholder={t('wfc.hasPh')} onChange={e => onRoute.change(k, { when: { ...r.when, has: e.target.value } })} />
              </>}
              {whenKind(r.when) === 'verdict' && <><input className="wb-input" list="wf-verdicts" value={r.when.verdict} onChange={e => onRoute.change(k, { when: { verdict: e.target.value.toLowerCase().replace(/[^a-z_]/g, '') } })} /><datalist id="wf-verdicts">{[...new Set(['done', 'failed', wf.success])].map(x => <option key={x} value={x}>{verdictText(t, x)}</option>)}</datalist></>}
            </div>
            : <textarea className="wb-input" rows={2} value={r.hint || ''} placeholder={t('wfc.hintPh')} onChange={e => onRoute.change(k, { hint: e.target.value })} />}
          <RouteThen back={r.back} backTo={backTo} set={back => onRoute.change(k, { back })} />
        </div>
      ))}
      {s.routes.length < 5 && <button className="wb-btn wb-small" onClick={onRoute.add}><Plus size={12} />{t('wfc.addRoute')}</button>}
      <div className="wf-route wf-route-else">
        <div className="wf-route-head"><span className="wf-route-tag">{t('wfc.otherwiseShort')}</span>
          <input className="wb-input" value={s.otherwise?.label || ''} placeholder={t('wfc.otherwise')} onChange={e => onChange({ otherwise: { ...s.otherwise, label: e.target.value } })} />
          <span className="wb-sub">{t('wfc.stepsN', { n: it.lanes.at(-1).items.length })}</span></div>
        <small className="wb-sub">{t('wfc.otherwiseHint')}</small>
        <RouteThen back={s.otherwise?.back} backTo={backTo} set={back => onChange({ otherwise: { ...s.otherwise, back } })} />
      </div>
    </section>
  )
}

/** A parallel block: its lanes (2–5, run at the same time, read-only work), and what happens when a lane fails. */
function ParallelSettings({ s, it, backTo, onChange, onLane }) {
  const t = useT()
  const onFail = typeof s.onFail === 'object' ? 'goto' : s.onFail || 'stop'
  return (
    <section className="wf-sec">
      <Field label={t('wf.id')}><input className="wb-input wb-mono" value={s.id} onChange={e => onChange({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></Field>
      <div className="wf-tip"><Split size={13} /><span>{t('wfc.parallelHint')}</span></div>
      <div className="wf-sec-h">{t('wfc.lanes')}</div>
      {s.lanes.map((l, k) => (
        <div key={k} className="wf-route wf-route-par">
          <div className="wf-route-head">
            <span className="wf-route-tag">{t('wfc.parShort')}</span>
            <input className="wb-input" value={l.label} onChange={e => onLane.change(k, { label: e.target.value })} aria-label={t('wfc.laneName')} />
            <span className="wb-sub">{t('wfc.stepsN', { n: it.lanes[k]?.items.length || 0 })}</span>
            {s.lanes.length > 2 && <button className="wb-icon-btn" onClick={() => onLane.remove(k)} aria-label={t('wfc.removeLane')}><Trash2 size={13} /></button>}
          </div>
        </div>
      ))}
      {s.lanes.length < 5 && <button className="wb-btn wb-small" onClick={onLane.add}><Plus size={12} />{t('wfc.addLane')}</button>}
      <div className="wf-sec-h"><GitMerge size={12} />{t('wfc.join')}</div>
      <small className="wb-sub">{t('wfc.joinHint')}</small>
      <Field label={t('wfc.laneFails')}>
        <select className="wb-input" value={onFail} onChange={e => onChange({ onFail: e.target.value === 'goto' ? { goto: backTo.at(-1)?.id, max: 1 } : e.target.value })}>
          {['stop', 'continue', 'goto'].map(k => <option key={k} value={k} disabled={k === 'goto' && !backTo.length}>{t(`wf.onFail.${k}`)}</option>)}
        </select></Field>
      {onFail === 'goto' && <>
        <Field label={t('wfc.gotoStep')}><select className="wb-input" value={s.onFail.goto} onChange={e => onChange({ onFail: { ...s.onFail, goto: e.target.value } })}>
          {!backTo.some(x => x.id === s.onFail.goto) && <option value={s.onFail.goto}>{s.onFail.goto}</option>}
          {backTo.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}
        </select></Field>
        <Field label={t('wf.gotoMax')}><input className="wb-input" type="number" min={1} max={10} value={s.onFail.max} onChange={e => onChange({ onFail: { ...s.onFail, max: Number(e.target.value) } })} /></Field>
      </>}
    </section>
  )
}

/** A step's last outcomes in this workflow's runs (or, in the runs view, in the run laid over the canvas) — its earlier rounds too. */
function StepRuns({ k, runs, run }) {
  const t = useT()
  const now = Date.now()
  const rows = (run ? [run] : runs.slice(0, 10)).map(r => ({ r, st: r.stages?.find(x => x.key === k) })).filter(x => x.st)
  if (!rows.length) return <p className="wf-insp-what wb-dim">{t('wfc.noStepRuns')}</p>
  return (
    <div className="wf-step-runs">
      {rows.map(({ r, st }) => (
        <div key={r.id} className={cx('wf-step-run', `wf-sr-${st.status}`)}>
          <span className="wf-run-dot" />
          <div><b>{runTitle(r)}</b> · {t(`sst.${st.status}`) !== `sst.${st.status}` ? t(`sst.${st.status}`) : st.status}{st.attempt > 1 ? ` · ${t('wfc.attempts', { n: st.attempt })}` : ''}{st.endedAt && st.startedAt ? ` · ${dur(st.endedAt - st.startedAt)}` : ''}
            <small>{t('ago', { t: dur(now - (st.endedAt || r.createdAt)) })}</small>
            {st.note && <p>{String(st.note).slice(0, 400)}</p>}
            {/* sent back and run again: each earlier round as it went (its result no longer counts) */}
            {st.history?.length > 0 && <ol className="wf-rounds">{st.history.map((h, i) => (
              <li key={i} className={`wf-sr-${h.status}`}><span className="wf-run-dot" />{t('wfc.round', { n: (h.round || 0) + 1 })} · {t(`sst.${h.status}`) !== `sst.${h.status}` ? t(`sst.${h.status}`) : h.status}{h.endedAt && h.startedAt ? ` · ${dur(h.endedAt - h.startedAt)}` : ''}{h.note && <small>{String(h.note).slice(0, 200)}</small>}</li>
            ))}</ol>}</div>
        </div>
      ))}
    </div>
  )
}

function WorkflowInspector({ wf, builtIn, fresh, head, setHead, status, errors, onCopy, onStatus, onRemove, dirty, onClose }) {
  const t = useT()
  const close = <button className="wb-icon-btn wf-push" onClick={onClose} aria-label={t('close')}><X size={15} /></button>
  if (builtIn) return (
    <div className="wf-insp">
      <div className="wf-insp-head"><span className="wf-insp-icon wf-k-agent"><Workflow size={16} /></span><div className="wf-insp-title"><h4>{wf.title}</h4><span className="wb-sub">{t('wf.status.builtin')}</span></div>{close}</div>
      <p className="wf-insp-what">{wf.description}</p>
      <div className="wf-tip"><Lock size={13} /><span>{t('wfc.fixed')}</span></div>
      <div className="wf-tip"><GitFork size={13} /><span>{t('wfc.copyHint')}</span></div>
      <button className="wb-btn wb-small" onClick={onCopy}><Copy size={12} />{t('wf.copy')}</button>
    </div>
  )
  return (
    <div className="wf-insp">
      <div className="wf-insp-head"><span className="wf-insp-icon wf-own wf-k-agent"><Sparkles size={16} /></span><div className="wf-insp-title"><h4>{t('wfc.workflow')}</h4><span className="wb-sub">{t('wf.basedOn', { base: wf.title })}</span></div>{close}</div>
      <section className="wf-sec">
        <Field label={t('wf.title')}><input className="wb-input" value={head.title} onChange={e => setHead({ ...head, title: e.target.value })} /></Field>
        <Field label={t('wf.id')} hint={fresh ? t('wfc.idHint') : ''}><input className="wb-input wb-mono" disabled={!fresh} value={head.id} onChange={e => setHead({ ...head, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></Field>
        <Field label={t('wf.description')} wide><textarea className="wb-input" rows={3} value={head.description} onChange={e => setHead({ ...head, description: e.target.value })} /></Field>
        <label className="wb-check"><input type="checkbox" checked={!!head.messages} onChange={e => setHead({ ...head, messages: e.target.checked })} />{t('wf.messages')}</label>
        <p className="wb-sub">{t('wf.messagesHint')}</p>
      </section>
      {errors.length > 0
        ? <div className="wb-note wb-t-amber wf-errors"><AlertTriangle size={13} /><ul>{errors.map((e, k) => <li key={k}>{e.step !== undefined ? `${t('wf.stepN', { n: e.step + 1 })}: ` : ''}{e.message}</li>)}</ul></div>
        : <div className="wb-note wb-t-green"><CheckCircle2 size={13} /> {t('wf.valid')}</div>}
      <p className="wb-sub wb-block">{t('wf.hint')}</p>
      {!fresh && <div className="wb-actions">
        {status === 'enabled'
          ? <button className="wb-btn wb-small" onClick={() => onStatus('draft')}><Power size={12} />{t('wf.disable')}</button>
          : <button className="wb-btn wb-small" disabled={errors.length > 0 || dirty} title={dirty ? t('wfc.saveFirst') : undefined} onClick={() => onStatus('enabled')}><Power size={12} />{t('wf.enable')}</button>}
        <button className="wb-btn wb-small wb-danger" onClick={onRemove}><Trash2 size={12} />{t('wf.remove')}</button>
      </div>}
    </div>
  )
}
