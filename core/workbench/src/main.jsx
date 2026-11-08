// The workbench's Web entry: the sidebar's "Workbench" group — the inbox (everything that needs you, in one place: the
// approvals and what waits on you elsewhere, other plugins' tabs, the notifications, and the System tab: what this
// machine needs from you — see inbox.js for the slots other plugins use), the runs (with the metrics), the workflows
// (each on a canvas), the Chat page — and the settings, a tab of the shell's Settings page. The standing conversation
// (chat.jsx) lives in the shell's chat sheet (slot ruyix.chat) across every page; chat-state.js tells the shell how it
// is doing and takes the palette's questions. Badges: what waits for you and what blocks work (the inbox), runs going;
// desktop notifications; the open hook (the home page's tiles, notifications, other plugins, the conversation); and the
// packs' extensions (window.__ruyixWorkbenchExt, see the README).
import { useEffect, useMemo, useState } from 'react'
import { Activity, Bell, BellOff, CalendarClock, CheckCircle2, ClipboardCheck, History, Inbox, Info, MessagesSquare, Plus, Search, Settings, Workflow, X, XCircle } from 'lucide-react'
import css from './styles.css'
// the product's semantic tokens (--ruyix-*), bundled so this plugin looks the same with the shell off
import tokens from '@ruyix/shell/tokens.css'
import { CHAT, FLOW, INBOX, NS, OPEN, RECORDS, SETTINGS_TAB, call, runDoc, exts, local, loadWorkflows, subscribeWb, successOf, useExtVersion, useNow, useSnapshot, useWbStore, useWorkflows } from './data.js'
import { en, zh } from './locale.js'
import { Conversation, boardCss } from './chat.jsx'
import { REFRESH_EVENT, createChatState } from './chat-state.js'
import { ApprovalsView, HandledView, awaiting } from './approvals.jsx'
import { MetricsView } from './metrics.jsx'
import { NewRun } from './newrun.jsx'
import { NeedsView, NoticesView, SystemView, noticesOf, unseen } from './notices.jsx'
import { INBOX_SLOT, NEEDS_SLOT, SYSTEM_SLOT, blocking, entriesOf, groupsOf, needsCount } from './inbox.js'
import { RunView } from './runs.jsx'
import { TASK_SCOPES, TaskBar, TaskRail, inTaskScope, runsByTask, taskActivity } from './tasks.jsx'
import { describe as scheduleWords } from '../lib/schedule.js'
import { SettingsView } from './settings.jsx'
import { ACTIVE, T, WorkflowsCtx, cx, errorText, lastActivity, localizeWorkflows, setPageLang, useT, verdictText } from './ui.jsx'
import { WorkflowsPage } from './workflows.jsx'
import { WORK_CSS, WorkTray } from './work.jsx'
import { startActivity } from './activity.js'
import { RecordsView } from './records.jsx'
import { VIEW as VIEWER, openViewer } from './viewer-window.jsx'
import { keptNames } from './win-names.js'
import { ANSWER, openAnswer } from './answer-window.jsx'
import { DESK_CSS, DESK_WIDGETS, TASKS_WINDOW, openTasksWindow } from './desk.jsx'

export { SETTINGS_TAB }
const GOTO = 'ruyix-workbench:goto' // inside the page: show this view (a panel that is open already takes it)
// the shell's 「任务」 page (docs/design/work-in-one-place.md): a task's runs, the scheduled ones and the new-task form are
// this workbench's parts of it — and where the workbench's own opens of a run, a task, a new one, 记录 go
const TASKS_PANEL = 'ruyix-tasks', PART_SLOT = 'ruyix.tasks.part', TAB_SLOT = 'ruyix.tasks.tab', NEW_SLOT = 'ruyix.tasks.new', SCHEDULED_TAB = 'ruyix-workbench-scheduled', METRICS_TAB = 'ruyix-workbench-metrics'
const VIEW = section => `${NS}.view.${section}` // the view last shown in a section (a view of another section is handed over the same way)
// The sidebar's entries (the shell groups them by `order`: 10–19 is its Workbench group).
const SECTIONS = [
  { id: 'inbox', panel: INBOX, icon: Inbox, order: 11, label: 'nav.inbox' },
  { id: 'runs', panel: NS, icon: Activity, order: 12, label: 'nav.runs' },
  { id: 'workflows', panel: FLOW, icon: Workflow, order: 13, label: 'nav.workflows' },
  { id: 'chat', panel: CHAT, icon: MessagesSquare, order: 14, label: 'nav.chat' }, // the standing conversation, for long reading
  { id: 'records', panel: RECORDS, icon: History, order: 15, label: 'nav.records' }, // all the agents' work, one list (src/records.jsx)
]
// the inbox's own tabs (other plugins' tabs, `inbox:<id>`, go before the notifications)
const TABS = { inbox: ['approvals', 'notices', 'system', 'handled'] }
const sectionOf = kind => (['approvals', 'notices', 'system', 'handled'].includes(kind) || String(kind).startsWith('inbox:') ? 'inbox' : ['runs', 'metrics'].includes(kind) ? 'runs' : kind === 'flow' ? 'workflows' : kind)
const panelOf = kind => SECTIONS.find(s => s.id === sectionOf(kind))?.panel
const tabKey = section => `${NS}.${section}Tab`
const fmt = (text, params = {}) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m))

/** An open request (window event `ruyix-workbench:open` detail) as a view: { kind, id?, tab?, scope? } or null. */
function viewOf(d = {}) {
  const scope = d.scope ? { scope: d.scope } : {}
  if (d.run || d.id) return { kind: 'runs', id: d.run || d.id, tab: d.tab || null, ...(d.file && { file: String(d.file) }), ...scope }
  if (d.task) return { kind: 'runs', id: null, task: String(d.task), ...scope }
  // a new run, its form open (on a workflow, when one is named; filled in, from a card of the conversation: its number)
  if (d.view === 'new') {
    const filled = ['title', 'text', 'note', 'fields', 'card'].some(k => d[k] !== undefined && d[k] !== '')
    return { kind: 'runs', id: null, create: filled ? { workflow: String(d.workflow || ''), title: String(d.title || ''), text: String(d.text || ''), note: String(d.note || ''), fields: d.fields && typeof d.fields === 'object' ? d.fields : {}, card: Number(d.card) || null } : String(d.workflow || '') || true }
  }
  const kind = { approvals: 'approvals', notices: 'notices', system: 'system', handled: 'handled', runs: 'runs', metrics: 'metrics', flow: 'flow', workflows: 'flow', settings: 'settings', chat: 'chat', records: 'records' }[d.view]
  // another plugin's tab of the inbox: `inbox:<its id>`
  if (!kind && String(d.view || '').startsWith('inbox:')) return { kind: String(d.view) }
  return kind ? { kind, ...(kind === 'runs' && { id: null }), ...scope } : null
}

function LangToggle({ locale }) {
  const t = useT()
  const active = String(useSnapshot(locale).active || 'en').startsWith('zh') ? 'zh' : 'en'
  return (
    <div className="wb-seg" role="group" aria-label={t('lang')}>
      {[['zh', '中'], ['en', 'EN']].map(([id, label]) => (
        <button key={id} className={cx(active === id && 'wb-on')} title={t(`lang.${id}`)} onClick={() => { if (active !== id) locale.setLocale(id) }}>{label}</button>
      ))}
    </div>
  )
}

function NotifyToggle() {
  const t = useT()
  const [on, setOn] = useState(() => local.get(`${NS}.notify`, false))
  if (typeof Notification === 'undefined') return null
  const denied = Notification.permission === 'denied'
  const toggle = async () => {
    if (!on && Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return
    local.set(`${NS}.notify`, !on); setOn(!on)
  }
  return <button className={cx('wb-icon-btn wb-ghost', on && !denied && 'wb-on')} disabled={denied} onClick={toggle} title={denied ? t('notifyDenied') : on ? t('notifyOn') : t('notifyOff')}>{on && !denied ? <Bell size={16} /> : <BellOff size={16} />}</button>
}

/** Other plugins' entries of an inbox slot, as the slot has them now (each with its stores from window.__ruyixInbox). */
function useInboxEntries(slots, name = INBOX_SLOT) {
  const [, bump] = useState(0)
  useEffect(() => slots?.subscribe?.(name, () => bump(n => n + 1)), [slots, name])
  return entriesOf(slots?.entries?.(name) || [], window.__ruyixInbox || {})
}
/** The rows other plugins put in an inbox slot, kept current → [{ id, label, items }] (those with items). */
function useInboxRows(slots, name) {
  const entries = useInboxEntries(slots, name).filter(o => o.items?.subscribe)
  const [, bump] = useState(0)
  // subscribed after the first render: one more read then catches a store that changed in between
  useEffect(() => { const offs = entries.map(o => o.items.subscribe(() => bump(n => n + 1))); bump(n => n + 1); return () => offs.forEach(off => off?.()) }, [entries.map(o => o.id).join()])
  return groupsOf(entries)
}
/** The sum of some count stores (other plugins' tabs: what is new there), kept current. */
function useSum(stores) {
  const [, bump] = useState(0)
  useEffect(() => { const offs = stores.map(x => x.subscribe?.(() => bump(n => n + 1))); return () => offs.forEach(off => off?.()) }, [stores.length])
  return stores.reduce((n, x) => n + (Number(x.getSnapshot?.()) || 0), 0)
}
const SlotCount = ({ store }) => { const n = useSum([store]); return n > 0 ? <span className="wb-count">{n}</span> : null }

/**
 * A workbench page, or (`embedded`) a part of another's: `mode` 'settings' (the Settings tab), 'part' (a task's runs in
 * the 「任务」 page's detail: `task`, `reload`), 'scheduled' (its 定时 tab), 'metrics' (its 指标 tab), 'new' (its new-task
 * sheet: `preset`, `onClose`).
 */
function WorkbenchPage({ t: words, locale, section, go, openPanel, embedded, slots, renderSlot, mode = 'settings', task: partTask = null, reload = null, preset = null, onClose = null }) {
  const [store, refresh] = useWbStore()
  const [rawWf] = useWorkflows()
  const extVersion = useExtVersion()
  const lang = String(useSnapshot(locale).active || 'en').startsWith('zh') ? 'zh' : 'en'
  setPageLang(lang) // (its dates and durations in its language, not the browser's)
  useEffect(() => { loadWorkflows(true) }, [extVersion]) // packs coming and going change the workflows
  // a step of a person's workflow has a title of its own, shown wherever a step's name is (its hint: none)
  const titles = useMemo(() => {
    const m = new Map()
    for (const b of rawWf?.builtIn || []) for (const s of b.steps || []) if (s.title) m.set(s.key, s.title)
    for (const r of store.run.values()) for (const s of r.stages || []) if (s.title) m.set(s.key, s.title)
    return m
  }, [store.run, rawWf])
  // the packs' words win over the core's; a step with no word of its own shows its title
  const own = useMemo(() => Object.assign({}, ...Object.values(exts()).map(e => e?.locale?.[lang])), [extVersion, lang])
  const t = useMemo(() => (key, params) => {
    if (own[key] !== undefined) return fmt(own[key], params)
    const v = words(key, params)
    if (v !== key || !key.startsWith('stage.')) return v
    const rest = key.slice(6)
    return rest.endsWith('.hint') ? '' : titles.get(rest) || rest
  }, [words, titles, own])
  const wfData = useMemo(() => localizeWorkflows(t, rawWf), [t, rawWf])
  const now = useNow()
  // This panel's view; a view of another section goes there (go: switch panels, the view travels in local storage).
  // A tabbed section opens on the tab last shown — the inbox, when none was, on what waits for you if anything does.
  const [view, setViewState] = useState(() => {
    const saved = local.get(VIEW(section), null)
    if (saved && sectionOf(saved.kind) === section) return saved
    const tab = local.get(tabKey(section), null)
    return { kind: TABS[section] ? (TABS[section].includes(tab) || String(tab || '').startsWith('inbox:') ? tab : section === 'inbox' && !badge.value.approvals && !badge.value.needs && badge.value.unread ? 'notices' : TABS[section][0]) : section === 'workflows' ? 'flow' : section }
  })
  const setView = v => (sectionOf(v.kind) === section ? setViewState(v) : go(v))
  const [filter, setFilterState] = useState(() => local.get(`${NS}.railScope`, 'all'))
  const setFilter = f => { setFilterState(f); local.set(`${NS}.railScope`, f) }
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false) // true, or what the form starts filled with (a card of the conversation)
  const [toasts, setToasts] = useState([])
  const [partRun, setPartRun] = useState(null), [schedPick, setSchedPick] = useState(null) // (the parts: the run, the task picked)
  useEffect(() => { if (!embedded) local.set(VIEW(section), { ...view, create: undefined }) }, [view])
  // a view that asks for a new run: the form opens (on its workflow, filled in), once
  useEffect(() => {
    if (!view.create) return
    const wf = typeof view.create === 'string' ? view.create : view.create.workflow
    if (typeof wf === 'string' && wf) { try { localStorage.setItem('ruyix-workbench.lastWorkflow', wf) } catch { /* private mode */ } }
    setCreating(typeof view.create === 'object' ? view.create : true)
    setViewState(v => ({ ...v, create: undefined }))
  }, [view.create])
  // Opened from elsewhere (the home page, a notification, the conversation): a view to show, a run, a scope.
  useEffect(() => {
    const open = e => {
      const v = e.detail
      if (!v || sectionOf(v.kind) !== section) return
      setViewState(v)
      if (v.scope) setFilterState(v.scope)
    }
    window.addEventListener(GOTO, open)
    return () => window.removeEventListener(GOTO, open)
  }, [section])
  const toast = (kind, title) => {
    const key = Date.now() + Math.random()
    setToasts(all => [...all, { key, kind, title }])
    setTimeout(() => setToasts(all => all.filter(x => x.key !== key)), kind === 'error' ? 9000 : 4500)
  }
  // latest processing first
  const runs = useMemo(() => [...store.run.values()].sort((a, b) => lastActivity(b) - lastActivity(a)), [store.run])
  const approvals = useMemo(() => [...store.approval.values()].sort((a, b) => b.createdAt - a.createdAt), [store.approval])
  const waiting = awaiting(approvals, store.run).length
  const counts = { running: runs.filter(r => ACTIVE.has(r.status) && !r.archivedAt).length, ok: runs.filter(r => !r.archivedAt && r.status === 'done' && r.verdict?.level === successOf(r, wfData)).length }
  // the list is of tasks (lib/tasks.js); a task's page is its newest run's (or the one picked), its task above it
  const byTask = useMemo(() => runsByTask(runs), [runs])
  // (a workflow's tasks: the others — a request in the conversation, a session's piece of work — are the task center's)
  const tasks = useMemo(() => [...store.task.values()].filter(x => x.workflow).sort((a, b) => taskActivity(b, byTask.get(b.id) || []) - taskActivity(a, byTask.get(a.id) || [])), [store.task, byTask])
  const picked = view.kind === 'runs' && view.id ? store.run.get(view.id) : null
  const task = view.kind === 'runs'
    ? (view.task && store.task.get(view.task)) || (picked && store.task.get(picked.taskId)) || (!view.id && !view.task && tasks.find(x => inTaskScope(x, byTask.get(x.id) || [], filter))) || null
    : null
  const run = view.kind === 'runs' ? picked || (task && !view.id ? (byTask.get(task.id) || [])[0] : null) || null : null
  const showRun = id => setView({ kind: 'runs', id })
  const showTask = x => setView({ kind: 'runs', task: x.id, id: (byTask.get(x.id) || [])[0]?.id || null })
  // a workflow's needs on this machine: its editor on the Workflows page, the panel of what it needs open
  const openNeeds = (id, mine) => {
    local.set(`${NS}.wfView`, { at: 'edit', kind: mine ? 'mine' : 'builtin', id, panel: 'needs' })
    window.dispatchEvent(new CustomEvent(`${NS}:needs`, { detail: { workflow: id } }))
    setView({ kind: 'flow' })
  }
  const archive = async (r, on) => {
    try { await call('archiveRun', { id: r.id, archived: on }); refresh(); toast('ok', t(on ? 'run.archivedToast' : 'run.unarchivedToast')) } catch (err) { toast('error', errorText(t, err)) }
  }
  const archiveTask = async (x, on) => {
    try { await call('taskArchive', { id: x.id, archived: on }); refresh(); toast('ok', t(on ? 'task.archivedToast' : 'task.unarchivedToast')) } catch (err) { toast('error', errorText(t, err)) }
  }
  const sec = SECTIONS.find(x => x.id === section)
  // the inbox's notifications, read up to `seen` (this browser); looking at them marks them read once you move on
  const notices = useMemo(() => noticesOf([...store.run.values()], now, [...store.approval.values()]), [store.run, store.approval, Math.floor(now / 60000)])
  const [readAt, setReadAt] = useState(() => local.get(SEEN, 0))
  const readAll = () => { local.set(SEEN, Date.now()); setReadAt(Date.now()); bumpBadge() }
  useEffect(() => { if (view.kind !== 'notices') return; local.set(SEEN, Date.now()); bumpBadge(); return () => setReadAt(local.get(SEEN, 0)) }, [view.kind])
  // the inbox as one place: what waits on you elsewhere (counted with the approvals), other plugins' tabs, the System tab
  const inbox = section === 'inbox' ? slots : null
  const needs = useInboxRows(inbox, NEEDS_SLOT)
  const system = useInboxRows(inbox, SYSTEM_SLOT)
  const extra = useInboxEntries(inbox, INBOX_SLOT)
  const tabCount = { approvals: waiting + needsCount(needs), notices: unseen(notices, readAt), system: blocking(system) }
  const tabs = section === 'inbox' ? ['approvals', ...extra.map(o => `inbox:${o.id}`), 'notices', 'system', 'handled'] : TABS[section]
  const extraOf = k => extra.find(o => `inbox:${o.id}` === k)
  // a plugin's tab not (or not yet) here: the approvals meanwhile
  const kind = String(view.kind).startsWith('inbox:') && !tabs?.includes(view.kind) ? 'approvals' : view.kind
  const styles = <style>{tokens + css + Object.values(exts()).map(e => e?.css || '').join('\n')}</style>

  // a task of the 「任务」 page (a workflow's): its bar — when it runs, its runs — and the run picked, its steps, evidence, report
  const ownTask = mode === 'part' && partTask?.id ? store.task.get(partTask.id) : mode === 'scheduled' ? (schedPick && store.task.get(schedPick)) || tasks.find(x => inTaskScope(x, byTask.get(x.id) || [], 'scheduled')) || null : null
  const ownRuns = ownTask ? byTask.get(ownTask.id) || [] : []
  const ownRun = (partRun && ownRuns.find(r => r.id === partRun)) || ownRuns[0] || null
  const runsOfTask = ownTask && (
    <>
      {/* (a workflow's task: when it runs, run it now, its runs; another's — a request that started runs: its runs) */}
      {ownTask.workflow
        ? <TaskBar key={ownTask.id} task={ownTask} runs={ownRuns} run={ownRun} onPick={setPartRun} now={now} toast={toast} refresh={() => { refresh(); reload?.() }} onArchive={mode === 'scheduled' ? archiveTask : null} />
        : ownRuns.length > 1 && <div className="wb-taskruns" role="tablist" aria-label={t('task.runsOf')}>{ownRuns.slice(0, 30).map(r => <button key={r.id} role="tab" aria-selected={ownRun?.id === r.id} className={cx('wb-taskrun', ownRun?.id === r.id && 'wb-on')} onClick={() => setPartRun(r.id)}><span className="wb-run-dot" />{r.subject?.title || r.template}</button>)}</div>}
      {ownRun
        ? <RunView key={ownRun.id} run={ownRun} approvals={approvals} rev={store.rev} now={now} toast={toast} refresh={() => { refresh(); reload?.() }} chosen={!!partRun} onArchive={archive} />
        : <div className="wb-hero"><CalendarClock size={34} /><p>{t('task.noRunYet')}</p></div>}
    </>
  )
  // a new one made: the 「任务」 page shows it
  const landOn = id => { if (id) window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: TASKS_PANEL, task: String(id) } })) }
  if (embedded) {
    if (mode === 'part' && (!ownTask || (!ownTask.workflow && !ownRuns.length))) return null // (not a workflow's task: not ours)
    return (
      <T.Provider value={t}>
        <WorkflowsCtx.Provider value={wfData}>
          <div className={cx('wb-page wb-embedded', mode !== 'settings' && `wb-in-tasks wb-in-${mode}`)}>
            {styles}
            {mode === 'settings' && <SettingsView toast={toast} />}
            {mode === 'part' && <div className="wb-detail wb-detail-task">{runsOfTask}</div>}
            {mode === 'scheduled' && (
              tasks.some(x => inTaskScope(x, byTask.get(x.id) || [], 'scheduled')) ? (
                <div className="wb-body">
                  <aside className="wb-rail">
                    {store.ready ? <TaskRail tasks={tasks} byTask={byTask} selected={ownTask?.id} onSelect={x => { setSchedPick(x.id); setPartRun(null) }} now={now} filter="scheduled" query="" onArchive={archiveTask} />
                      : <div className="wb-skeleton">{[0, 1, 2].map(i => <span key={i} />)}</div>}
                  </aside>
                  <main className="wb-detail wb-detail-task">{runsOfTask}</main>
                </div>
              ) : store.ready && (
                <div className="wb-hero"><CalendarClock size={34} /><p>{t('sch.none')}</p>
                  <button className="wb-btn wb-primary wb-big" onClick={() => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: TASKS_PANEL, view: 'new' } }))}><Plus size={15} />{t('run.new')}</button></div>
              )
            )}
            {mode === 'metrics' && <div className="wb-tabbed"><MetricsView toast={toast} onRun={id => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: TASKS_PANEL, run: String(id) } }))} /></div>}
            {mode === 'new' && (
              <NewRun inline toast={toast} prefill={preset && Object.keys(preset).length ? preset : null} onClose={() => onClose?.()} onNeeds={(id, mine) => { onClose?.(); openNeeds(id, mine) }}
                onStarted={r => {
                  if (preset?.card) window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail: {} }))
                  onClose?.(); refresh(); landOn(r.taskId); toast('ok', t('run.started', { id: r.id }))
                }}
                onScheduled={x => { onClose?.(); refresh(); landOn(x.id); toast('ok', t('task.scheduled', { when: scheduleWords(x.schedule, t('lang.code') === 'zh' ? 'zh' : 'en') })) }} />
            )}
            <Toasts toasts={toasts} setToasts={setToasts} />
          </div>
        </WorkflowsCtx.Provider>
      </T.Provider>
    )
  }
  return (
    <T.Provider value={t}>
      <WorkflowsCtx.Provider value={wfData}>
        <div className="wb-page">
          {styles}
          <header className="wb-header">
            <div className="wb-brand">
              <span className="wb-brand-glyph"><sec.icon size={18} /></span>
              <div><h1>{t(sec.label)}</h1><span className="wb-sub">{t('title')}</span></div>
            </div>
            <div className="wb-kpis">
              <button className={cx('wb-kpi wb-t-blue', filter === 'active' && view.kind === 'runs' && 'wb-on')} onClick={() => { setView({ kind: 'runs', id: view.id ?? null }); setFilter(filter === 'active' ? 'all' : 'active') }}>
                <Activity size={14} className={counts.running ? 'wb-breathe' : ''} /><b>{counts.running}</b><span>{t('kpi.running')}</span>
              </button>
              <button className={cx('wb-kpi wb-t-amber', view.kind === 'approvals' && 'wb-on')} onClick={() => setView({ kind: 'approvals' })}>
                <ClipboardCheck size={14} /><b>{waiting}</b><span>{t('kpi.approvals')}</span>
              </button>
              <button className={cx('wb-kpi wb-t-green', view.kind === 'metrics' && 'wb-on')} onClick={() => setView({ kind: 'metrics' })} title={t('nav.metrics')}>
                <CheckCircle2 size={14} /><b>{counts.ok}</b><span>{t('kpi.done')}</span>
              </button>
            </div>
            <div className="wb-header-actions">
              <LangToggle locale={locale} />
              <NotifyToggle />
              <button className="wb-btn wb-primary wb-big" onClick={() => setCreating(true)}><Plus size={15} />{t('run.new')}</button>
            </div>
          </header>
          {tabs && (
            <div className="wb-tabbed">
              <div className="wb-tabs wb-settings-tabs" role="tablist">
                {tabs.map(k => (
                  <button key={k} role="tab" aria-selected={kind === k} className={cx('wb-tab', kind === k && 'wb-on')} onClick={() => { local.set(tabKey(section), k); setView({ kind: k }) }}>
                    {extraOf(k) ? <>{extraOf(k).label?.() ?? extraOf(k).id}{extraOf(k).count && <SlotCount store={extraOf(k).count} />}</>
                      : <>{t(`sec.${k}`)}{tabCount[k] > 0 && <span className={cx('wb-count', ['approvals', 'system'].includes(k) && 'wb-count-warn')}>{tabCount[k]}</span>}</>}
                  </button>
                ))}
              </div>
              {kind === 'approvals' && <NeedsView groups={needs} now={now} toast={toast} />}
              {kind === 'approvals' && <ApprovalsView approvals={approvals} runs={store.run} toast={toast} refresh={refresh} onRun={showRun} />}
              {kind === 'notices' && <NoticesView notices={notices} seen={readAt} now={now} onRun={showRun} onReadAll={readAll} />}
              {kind === 'system' && <SystemView groups={system} now={now} toast={toast} />}
              {kind === 'handled' && <HandledView approvals={approvals} runs={store.run} onRun={showRun} />}
              {extraOf(kind) && renderSlot?.(INBOX_SLOT, { onRun: showRun }, { only: extraOf(kind).id })}
            </div>
          )}
          {section === 'records' && <RecordsView toast={toast} />}
          {section === 'workflows' && <WorkflowsPage toast={toast} openPanel={openPanel} runs={store.run} onRun={id => setView({ kind: 'runs', id })} />}
          {section === 'runs' && view.kind === 'metrics' && (
            <div className="wb-tabbed">
              <MetricsView toast={toast} onRun={showRun} />
            </div>
          )}
          {section === 'runs' && view.kind === 'runs' && (
            <div className="wb-body">
              <aside className="wb-rail">
                <div className="wb-rail-tools">
                  <label className="wb-search"><Search size={14} /><input placeholder={t('search')} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQuery('')} /></label>
                  <div className="wb-seg wb-seg-scopes">
                    {TASK_SCOPES.map(f => <button key={f} className={cx(filter === f && 'wb-on')} onClick={() => setFilter(f)} title={t(`filter.${f}.hint`)}>{t(`filter.${f}`)}<span className="wb-count">{tasks.filter(x => inTaskScope(x, byTask.get(x.id) || [], f)).length}</span></button>)}
                  </div>
                </div>
                {store.ready
                  ? <TaskRail tasks={tasks} byTask={byTask} selected={task?.id} onSelect={showTask} now={now} filter={filter} query={query} onArchive={archiveTask} />
                  : <div className="wb-skeleton">{[0, 1, 2].map(i => <span key={i} />)}</div>}
                {store.error && <div className="wb-note wb-t-red">{store.error}</div>}
              </aside>
              <main className={cx('wb-detail', task && 'wb-detail-task')}>
                {task && <TaskBar key={task.id} task={task} runs={byTask.get(task.id) || []} run={run} onPick={showRun} now={now} toast={toast} refresh={refresh} onArchive={archiveTask} />}
                {run
                  ? <RunView key={run.id} run={run} approvals={approvals} rev={store.rev} now={now} toast={toast} refresh={refresh} initialTab={view.tab} initialFile={view.file} chosen={!!(view.id || view.task)} onArchive={archive} />
                  : store.ready && (task
                    ? <div className="wb-hero"><CalendarClock size={34} /><p>{t('task.noRunYet')}</p></div>
                    : <div className="wb-hero"><Workflow size={34} /><p>{tasks.length ? t('run.pick') : t('run.empty')}</p><button className="wb-btn wb-primary wb-big" onClick={() => setCreating(true)}><Plus size={15} />{t('run.new')}</button></div>)}
              </main>
            </div>
          )}
          {creating && <NewRun toast={toast} prefill={typeof creating === 'object' ? creating : null} onClose={() => setCreating(false)} onNeeds={(id, mine) => { setCreating(false); openNeeds(id, mine) }}
            onStarted={r => {
              // a card of the conversation, changed here and started: the card says so too
              if (creating?.card) window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail: {} }))
              setCreating(false); refresh(); setView({ kind: 'runs', id: r.id }); toast('ok', t('run.started', { id: r.id }))
            }}
            onScheduled={x => { setCreating(false); refresh(); setView({ kind: 'runs', task: x.id, id: null }); toast('ok', t('task.scheduled', { when: scheduleWords(x.schedule, t('lang.code') === 'zh' ? 'zh' : 'en') })) }} />}
          <Toasts toasts={toasts} setToasts={setToasts} />
        </div>
      </WorkflowsCtx.Provider>
    </T.Provider>
  )
}

const langOf = locale => (String(locale?.getSnapshot?.().active || 'en').startsWith('zh') ? 'zh' : 'en')
/**
 * The standing conversation where it is shown — `sheet`: the shell's chat sheet (it draws the frame, the title bar and
 * the close button; this fills its box, on its translucent material); otherwise the Chat page. `live`: chat-state.js.
 */
function ChatHost({ t: words, bound, locale, live, sheet = false, onClose, lang: given }) {
  const active = useSnapshot(locale).active
  const lang = given === 'zh' || given === 'en' ? given : String(active || 'en').startsWith('zh') ? 'zh' : 'en'
  const t = typeof words === 'function' ? words : bound
  return (
    <T.Provider value={t}>
      <div className={cx('wb-page', sheet ? 'wb-chat-sheet' : 'wb-chat-host')}>
        <style>{tokens + css + boardCss}</style>
        <Conversation variant={sheet ? 'sheet' : 'page'} lang={lang} live={live} onClose={onClose} />
      </div>
    </T.Provider>
  )
}

function Toasts({ toasts, setToasts }) {
  return (
    <div className="wb-toasts">
      {toasts.map(x => (
        <div key={x.key} className={cx('wb-toast', `wb-toast-${x.kind}`)}>
          {x.kind === 'ok' ? <CheckCircle2 size={15} /> : x.kind === 'warn' ? <Info size={15} /> : <XCircle size={15} />}
          <span>{x.title}</span>
          <button className="wb-icon-btn" onClick={() => setToasts(all => all.filter(y => y.key !== x.key))}><X size={14} /></button>
        </div>
      ))}
    </div>
  )
}

// The sidebar badges — the inbox: approvals waiting (amber), else notifications not read yet (blue); the runs: runs
// going (blue) — shared with the desktop notifications; one light poll while dsh is open.
const SEEN = `${NS}.noticesSeen` // notifications read up to (a time, per browser)
const badge = { value: { approvals: 0, needs: 0, running: 0, unread: 0 }, runs: [], approvals: [], listeners: new Set(), getSnapshot: () => badge.value, subscribe: fn => { badge.listeners.add(fn); return () => badge.listeners.delete(fn) } }
const setBadge = next => {
  if (Object.keys(next).every(k => next[k] === badge.value[k])) return
  const before = badge.value
  badge.value = next
  for (const fn of badge.listeners) fn()
  // the counts the shell shows where these pages' own icons are not drawn (the interactive desk's places)
  if (before.approvals + before.needs !== next.approvals + next.needs || before.running !== next.running) window.dispatchEvent(new Event('ruyix:nav'))
}
/** Count the unread notifications again (when the page marks them read). */
const bumpBadge = () => setBadge({ ...badge.value, unread: unseen(noticesOf(badge.runs, Date.now(), badge.approvals), local.get(SEEN, 0)) })
const dot = (n, color, edge) => n > 0 && <span style={{
  position: 'absolute', [edge]: -5, right: -7, minWidth: 14, height: 14, padding: '0 3px', boxSizing: 'border-box', borderRadius: 7, fontSize: 9, lineHeight: '14px',
  textAlign: 'center', fontWeight: 600, color: 'var(--dsw-alias-label-primary-foreground)', background: color,
}}>{n > 99 ? '99+' : n}</span>
/**
 * A section's sidebar icon; the inbox and the runs carry their counts. The inbox's: what waits for you — approvals, what
 * waits on you elsewhere, what blocks work here (the System tab's danger and warning rows) — amber; else what is new
 * (notifications not read, other plugins' tabs) — blue.
 */
function SectionIcon({ size, s, t, slots }) {
  const { approvals, running, unread } = useSnapshot(badge)
  const inbox = s.id === 'inbox' ? slots : null
  const theirs = useSum(useInboxEntries(inbox, INBOX_SLOT).map(o => o.count).filter(Boolean))
  const needs = needsCount(useInboxRows(inbox, NEEDS_SLOT)) + blocking(useInboxRows(inbox, SYSTEM_SLOT))
  useEffect(() => { if (s.id === 'inbox' && badge.value.needs !== needs) setBadge({ ...badge.value, needs }) }, [needs])
  const [n, key, color] = s.id === 'runs' ? [running, 'side.running', 'var(--ruyix-accent)']
    : s.id === 'inbox' ? (approvals + needs ? [approvals + needs, 'side.approvals', 'var(--ruyix-warning)'] : [unread + theirs, 'side.unread', 'var(--ruyix-accent)']) : [0]
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} title={n ? t(key, { n }) : undefined}>
      <s.icon size={size || 16} strokeWidth={1.6} />
      {dot(n, color, 'top')}
    </span>
  )
}

export const inject = ['slots', 'locale', 'layout', 'uiWorkspace', 'uiSession']

/**
 * A view of a run, a task, a new one, 记录 — on the shell's 「任务」 page when it has one (window.__ruyixTasks): there a
 * task's runs are this workbench's part. → whether it went there
 */
function toTasks(view) {
  if (!window.__ruyixSettings) return false // (the shell is here — its Settings page says so — and its 「任务」 page with it)
  const c = view.create
  const d = c ? { view: 'new', ...(typeof c === 'object' ? c : typeof c === 'string' && c ? { workflow: c } : {}) }
    : view.kind === 'records' ? { tab: 'all' } : view.kind === 'metrics' ? { tab: METRICS_TAB }
    : view.kind === 'runs' && view.id ? { run: String(view.id) }
    : view.kind === 'runs' && view.task ? { task: String(view.task) }
    : view.kind === 'runs' ? { tab: view.scope === 'scheduled' ? SCHEDULED_TAB : view.scope === 'active' ? 'active' : 'all' }
    : null
  if (!d) return false
  window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: TASKS_PANEL, ...d } }))
  return true
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ruyix-workbench: dictionaries')
  const t = ctx.locale.bind(NS)
  // Another section's view: it travels in local storage (and, to a page that is open, as an event) and its panel opens.
  const go = view => {
    if (toTasks(view)) return
    local.set(VIEW(sectionOf(view.kind)), view)
    if (view.scope) local.set(`${NS}.railScope`, view.scope) // a panel not open yet starts on it
    // with the shell, the settings are a tab of its one Settings page
    if (view.kind === 'settings') {
      if (window.__ruyixSettings) return window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: SETTINGS_TAB } }))
      return
    }
    try { ctx.layout.selectPanel(panelOf(view.kind)) } catch { /* layout not ready */ }
    window.dispatchEvent(new CustomEvent(GOTO, { detail: view }))
  }
  const openPanel = id => { try { ctx.layout.selectPanel(id) } catch { /* that plugin is off */ } }
  const injected = () => ({ locale: ctx.locale, openSession: id => ctx.uiWorkspace.openSession(id), status: ctx.uiSession.sessionStatus, go, openPanel, slots: ctx.slots })
  // the standing conversation's state for the shell (window.__ruyixChat, 'ruyix:chat-state') and the palette's questions
  // ('ruyix:chat-ask'): one per page, whether or not the sheet is open
  // a question's whole answer in front (src/answer-window.jsx; docs/design/desk-answers.md): from the desk's answers list,
  // voice 「打开给我看」, an answer that is to come up in front — no desk here: the chat sheet
  const showAnswer = (id, title = '') => {
    const item = (window.__ruyixAnswers?.get?.() || []).find(x => x.id === id)
    if (!openAnswer(id, { t, lang: langOf(ctx.locale), title: title || item?.question || '' })) window.dispatchEvent(new CustomEvent('ruyix:chat', { detail: { open: true } }))
  }
  const live = createChatState({ call, win: window, lang: () => langOf(ctx.locale), store: local, key: `${NS}.chatSeen`, onFront: id => showAnswer(id) })
  ctx.effect(() => {
    const on = e => { if (e.detail?.id) showAnswer(String(e.detail.id), e.detail.title ? String(e.detail.title) : '') }
    window.addEventListener(ANSWER, on)
    return () => window.removeEventListener(ANSWER, on)
  }, 'ruyix-workbench: answers in front')
  ctx.effect(() => live.start(), 'ruyix-workbench: the conversation\'s state')
  const chatProps = () => ({ ...injected(), live, bound: t })
  // the inbox holds other plugins' parts: their tabs, what waits on the person elsewhere, what this machine needs (inbox.js)
  const INBOX_CHILDREN = { [INBOX_SLOT]: { kind: 'list', scope: 'root' }, [NEEDS_SLOT]: { kind: 'list', scope: 'root' }, [SYSTEM_SLOT]: { kind: 'list', scope: 'root' } }
  ctx.slots.inject('main', function* () {
    for (const s of SECTIONS) {
      yield s.id === 'chat'
        ? ctx.slots.register({ name: 'main', key: s.panel, locale: NS, inject: chatProps }, props => <ChatHost {...props} />)
        : ctx.slots.register({ name: 'main', key: s.panel, locale: NS, inject: injected, ...(s.id === 'inbox' && { children: INBOX_CHILDREN }) }, props => <WorkbenchPage {...props} section={s.id} />)
    }
  })
  // the shell's chat sheet (its one slot ruyix.chat, on its desktop): the conversation across every page
  ctx.slots.inject('ruyix.chat', () => ctx.slots.register({ name: 'ruyix.chat', locale: NS, inject: chatProps },
    ({ onClose, lang, ...props }) => <ChatHost {...props} sheet onClose={onClose} lang={lang} />))
  ctx.slots.inject('sidebar.panellist', function* () {
    for (const s of SECTIONS) yield ctx.slots.register({ name: 'sidebar.panellist', id: s.panel, order: s.order, locale: NS, label: () => t(s.label) }, props => <SectionIcon {...props} s={s} t={t} slots={ctx.slots} />)
  })
  // the 「任务」 page's parts (the shell's; docs/design/work-in-one-place.md): a workflow's task's runs in its detail, the
  // scheduled ones as its 定时 tab, the new-task form in its sheet
  ctx.slots.inject(PART_SLOT, () => ctx.slots.register({ name: PART_SLOT, id: 'ruyix-workbench-runs', order: 20, locale: NS, inject: injected },
    ({ task, reload, ...props }) => <WorkbenchPage {...props} section="runs" embedded mode="part" task={task} reload={reload} />))
  ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, id: SCHEDULED_TAB, order: 20, locale: NS, label: () => t('filter.scheduled'), count: c => c?.scheduled || 0, inject: injected },
    props => <WorkbenchPage {...props} section="runs" embedded mode="scheduled" />))
  ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, id: METRICS_TAB, order: 30, locale: NS, label: () => t('nav.metrics'), inject: injected },
    props => <WorkbenchPage {...props} section="runs" embedded mode="metrics" />))
  ctx.slots.inject(NEW_SLOT, () => ctx.slots.register({ name: NEW_SLOT, id: 'ruyix-workbench-new', locale: NS, inject: injected },
    ({ preset, onClose, ...props }) => <WorkbenchPage {...props} section="runs" embedded mode="new" preset={preset} onClose={onClose} />))
  // 运行 and 记录 are folded into the 「任务」 page (the shell's nav.js): they leave the sidebar, the dock and the pages an
  // agent opens; an open of one lands there (记录: on 全部). The inbox stays a page of its own (Ethan 2026-10-19).
  ctx.effect(() => {
    const nav = (window.__ruyixNav ||= {})
    nav[NS] = { ...nav[NS], into: TASKS_PANEL }
    nav[RECORDS] = { ...nav[RECORDS], into: TASKS_PANEL, land: { tab: 'all' } }
    window.dispatchEvent(new CustomEvent('ruyix:nav'))
    return () => { delete nav[NS]?.into; delete nav[RECORDS]?.into; delete nav[RECORDS]?.land; window.dispatchEvent(new CustomEvent('ruyix:nav')) }
  }, 'ruyix-workbench: 运行 and 记录 folded into 「任务」')
  // the settings as a tab of the shell's Settings page (slot ruyix.settings.tab; the tab's id is not a sidebar entry)
  ctx.slots.inject('ruyix.settings.tab', () => ctx.slots.register({ name: 'ruyix.settings.tab', id: SETTINGS_TAB, order: 30, locale: NS, label: () => t('tab.settings'), inject: injected },
    props => <WorkbenchPage {...props} section="settings" embedded />))

  // Other plugins (and the home page's tiles) open the workbench: dispatchEvent(new CustomEvent('ruyix-workbench:open',
  // { detail: { view, scope?, run?, tab? } })) — views: approvals, notices, system, inbox:<a plugin's tab>, runs, flow,
  // settings, metrics; `run` (or
  // `id`) opens that run on `tab` (overview, pipeline, evidence, report, approvals).
  ctx.effect(() => {
    const open = e => { const v = viewOf(e.detail); if (v) go(v) }
    window.addEventListener(OPEN, open)
    // who is here, for the home page: this workbench's inbox
    const here = (window.__ruyixWorkbenches ||= {})
    here[NS] = { event: OPEN, inbox: INBOX }
    return () => { window.removeEventListener(OPEN, open); delete here[NS] }
  }, 'ruyix-workbench: open hook')

  // a run's results in the viewer's own window (src/viewer-window.jsx): `ruyix-workbench:view` { run, file? } — no desk
  // here: the run page's 结果 tab; or a session's files, { session, file?, title? }
  ctx.effect(() => {
    const view = e => {
      const d = e.detail || {}
      if (Array.isArray(d.files)) { openViewer({ files: d.files, file: Number.isInteger(d.file) ? d.file : 0 }, { t, title: d.title ? String(d.title) : '' }); return }
      if (d.session) { openViewer({ session: String(d.session), file: d.file ? String(d.file) : null }, { t, title: d.title ? String(d.title) : '' }); return }
      if (!d.run) return
      const r = runDoc(String(d.run))
      if (!openViewer({ run: String(d.run), file: d.file ? String(d.file) : null }, { t, title: r?.subject?.title || r?.template || '' })) window.dispatchEvent(new CustomEvent(OPEN, { detail: { run: d.run, tab: 'results', ...(d.file && { file: d.file }) } }))
    }
    window.addEventListener(VIEWER, view)
    return () => window.removeEventListener(VIEWER, view)
  }, 'ruyix-workbench: the viewer window')
  // a window's row on the desk kept from before it had both names (src/win-names.js): named again in both, so the desk says
  // it in the page's language (the apps' rows: core/plugins/apps) — only its name, not where it is; once each on this page
  ctx.effect(() => {
    const done = new Set()
    const name = () => {
      const reg = window.__ruyixOpen
      for (const it of reg?.list?.() || []) if (!it.names && !done.has(it.id)) { const names = keptNames(it.id, it.title); if (names) { done.add(it.id); reg.rename?.(it.id, { names }) } }
    }
    window.addEventListener('ruyix:open-things', name)
    name()
    return () => window.removeEventListener('ruyix:open-things', name)
  }, 'ruyix-workbench: its windows named in both languages')
  // 记录 on another plugin's page (a studio's 历史, docs/design/studio.md): window.__ruyixViews.records({ studio, lang }) —
  // the list, only that studio's runs when it names one, in the workbench's words and styles; 'ruyix:views' when it is there
  ctx.effect(() => {
    const Records = ({ studio }) => <T.Provider value={t}><div className="wb-page wb-embedded wb-rec-embed"><style>{tokens + css}</style><RecordsView studio={studio || null} /></div></T.Provider>
    // (and `files`: the viewer's window takes plain files by their links — ruyix-workbench:view { files })
    window.__ruyixViews = { ...(window.__ruyixViews || {}), records: Records, files: true }
    window.dispatchEvent(new Event('ruyix:views'))
    return () => {
      if (window.__ruyixViews?.records !== Records) return
      const { records: _gone, files: _too, ...rest } = window.__ruyixViews
      window.__ruyixViews = rest
      window.dispatchEvent(new Event('ruyix:views'))
    }
  }, 'ruyix-workbench: 记录 for other pages')
  // every task (docs/design/agent-tasks.md): a window event 'ruyix:tasks' { ids } when one changes — its document, a run of
  // it, one deleted — so the task center and the portfolio read again
  ctx.effect(() => subscribeWb(({ docs, removed = [], first }) => {
    if (first) return
    const ids = new Set([...docs.filter(d => d.kind === 'task').map(d => d.id), ...docs.filter(d => d.kind === 'run' && d.taskId).map(d => d.taskId), ...removed.filter(x => x.kind === 'task').map(x => x.id)])
    if (ids.size) window.dispatchEvent(new CustomEvent('ruyix:tasks', { detail: { ids: [...ids] } }))
  }, 3000), 'ruyix-workbench: tasks changed')
  // who is at work right now (src/activity.js): what the desktop's lights and the runway widget draw
  ctx.effect(() => startActivity({ call, subscribe: subscribeWb, lang: () => langOf(ctx.locale) }), 'ruyix-workbench: activity')
  // work in progress wherever the person is (src/work.jsx): the shell's tray, in the shell's styles (the desk's own strip,
  // the shell's, shows each piece of work: its widget `workbench:work` is gone — a desk that still lists it shows nothing there)
  ctx.effect(() => {
    window.__ruyixTray = [...(window.__ruyixTray || []).filter(x => x.id !== NS), { id: NS, order: 10, render: WorkTray }]
    // (its widgets are gone: `workbench:work` for the desk's strip, `workbench:main` for the shell's main-agent strip above
    // the dock — a desk that still lists one shows nothing there)
    // the desk's widgets of the work (src/desk.jsx): 任务, which opens a small window of the tasks, and 今天
    const mine = new Set(DESK_WIDGETS.map(d => d.type))
    window.__ruyixWidgetDefs = [...(window.__ruyixWidgetDefs || []).filter(x => x.type !== 'workbench:work' && x.type !== 'workbench:main' && !mine.has(x.type)), ...DESK_WIDGETS]
    const style = Object.assign(document.createElement('style'), { id: `${NS}-work`, textContent: WORK_CSS + DESK_CSS })
    const reopen = () => openTasksWindow({ lang: langOf(ctx.locale) })
    window.addEventListener(TASKS_WINDOW, reopen)
    document.head.appendChild(style)
    window.dispatchEvent(new Event('ruyix:tray')); window.dispatchEvent(new Event('ruyix:widget'))
    return () => {
      window.__ruyixTray = (window.__ruyixTray || []).filter(x => x.id !== NS)
      window.__ruyixWidgetDefs = (window.__ruyixWidgetDefs || []).filter(x => x.type !== 'workbench:work' && x.type !== 'workbench:main' && !mine.has(x.type))
      window.removeEventListener(TASKS_WINDOW, reopen)
      style.remove()
      window.dispatchEvent(new Event('ruyix:tray')); window.dispatchEvent(new Event('ruyix:widget'))
    }
  }, 'ruyix-workbench: work in progress')

  if (!local.get(SEEN, 0)) local.set(SEEN, Date.now()) // the first visit: what happened before counts as read
  ctx.effect(() => {
    const seen = new Map() // kind:id → status, for approvals and runs
    const remindedOf = new Map() // approval → the reminder already told
    const runOf = new Map(), runs = new Map(), apps = new Map() // approval → run; run docs (to leave an archived run's cards out); approval docs (reminders)
    const notify = (title, tag, id) => {
      if (!local.get(`${NS}.notify`, false) || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      const note = new Notification(title, { tag: `${NS}:${tag}` })
      note.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent(OPEN, { detail: { run: id } })); note.close() }
    }
    // the page's one workbench poll (shared with the panel): every 8 s while only the badge listens
    const onDelta = ({ docs, first, removed = [] }) => {
      try {
        for (const x of removed) { seen.delete(`${x.kind}:${x.id}`); if (x.kind === 'run') runs.delete(x.id); if (x.kind === 'approval') { apps.delete(x.id); runOf.delete(x.id); remindedOf.delete(x.id) } }
        for (const d of docs) if (d.kind === 'run') runs.set(d.id, d); else if (d.kind === 'approval') apps.set(d.id, d)
        for (const d of docs) {
          const before = seen.get(`${d.kind}:${d.id}`)
          seen.set(`${d.kind}:${d.id}`, d.status)
          if (d.kind === 'approval') runOf.set(d.id, d.runId)
          if (first || before === d.status) continue
          if (d.kind === 'approval' && d.status === 'pending') notify(t('notify.approval', { title: d.title }), d.id, d.runId)
          if (d.kind === 'run' && ACTIVE.has(before) && !ACTIVE.has(d.status)) notify(t('notify.done', { title: d.subject?.title || d.id, verdict: d.verdict?.level ? verdictText(t, d.verdict.level) : t(`status.${d.status}`) }), d.id, d.id)
        }
        const approvals = [...seen.entries()].filter(([key, st]) => key.startsWith('approval:') && (st === 'pending' || st === 'failed') && !runs.get(runOf.get(key.slice(9)))?.archivedAt).length
        const running = [...runs.values()].filter(x => ACTIVE.has(x.status) && !x.archivedAt).length
        // a person step's card that waited past its hours: its reminder, once
        for (const d of docs) {
          if (d.kind !== 'approval' || !d.payload?.remindedAt || remindedOf.get(d.id) === d.payload.remindedAt) continue
          if (!first && ['pending', 'failed'].includes(d.status)) notify(t('notify.remind', { title: d.title }), `${d.id}:remind`, d.runId)
          remindedOf.set(d.id, d.payload.remindedAt)
        }
        badge.runs = [...runs.values()]
        badge.approvals = [...apps.values()]
        setBadge({ ...badge.value, approvals, running, unread: unseen(noticesOf(badge.runs, Date.now(), badge.approvals), local.get(SEEN, 0)) })
      } catch { /* a malformed document: the next delta tries again */ }
    }
    // the counts for places that draw their own picture of these pages (window.__ruyixNav[id].count; the dock shows
    // SectionIcon's own dots): what waits for you, the runs going
    const nav = (window.__ruyixNav ||= {})
    nav[INBOX] = { ...nav[INBOX], count: () => badge.value.approvals + badge.value.needs }
    nav[NS] = { ...nav[NS], count: () => badge.value.running }
    window.dispatchEvent(new Event('ruyix:nav'))
    const off = subscribeWb(onDelta, 8000)
    return () => { off?.(); delete nav[INBOX]?.count; delete nav[NS]?.count; window.dispatchEvent(new Event('ruyix:nav')) }
  }, 'ruyix-workbench: badge and notifications')
}
