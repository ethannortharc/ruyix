// Agent Hub Web entry: registers the panel + sidebar entry and desktop notifications. The panel is three tabs: Agents (the
// pool), Tasks (what needs you, the jobs, a job's view) and Runtimes (the CLIs). Another panel opens a tab with window
// event 'agent-hub:open' { tab: 'agents' | 'tasks' | 'sessions' | 'runtimes' }.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Activity, Bell, BellOff, Bot, CheckCircle2, Info, KeyRound, ListChecks, Loader2, MessagesSquare, Network, PauseCircle, Plus, Search, Sparkles, Wand2, X, XCircle } from 'lucide-react'
import flowCss from '@xyflow/react/dist/style.css'
import css from './styles.css'
// the product's semantic tokens (--ruyix-*), bundled so this plugin looks the same with the shell off
import tokens from '@ruyix/shell/tokens.css'
import { attentionOf, buildHub, call, local, markRead, useHubStore, useNow, useReadMarks, useSnapshot, watchHub } from './data.js'
import { workRegistry } from '@ruyix/shell/work'
import { jobItems, sessionItems } from './work.js'
import { NowCtx } from './flow.jsx'
import { en, zh } from './locale.js'
import { T, cx, describe, useT } from './ui.jsx'
import { AgentsPage, ImportDialog, JobView, NewJob, Overview, Rail } from './views.jsx'
import { SkillsPage } from './skills.jsx'
import { SessionsPage } from './sessions.jsx'
import { RuntimesPage } from './runtimes.jsx'
import { AGENTS_WIDGET } from './desk.jsx'

const PANEL = 'agent-hub'
const SKILLS_PANEL = 'agent-hub-skills'
const NS = 'agent-hub'
const STYLE = flowCss + tokens + css

function NotifyToggle() {
  const t = useT()
  const supported = typeof Notification !== 'undefined'
  const [on, setOn] = useState(() => local.get('agentHub.notify', false))
  if (!supported) return null
  const denied = Notification.permission === 'denied'
  const toggle = async () => {
    if (!on && Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return
    local.set('agentHub.notify', !on); setOn(!on)
  }
  return (
    <button className={cx('ah-icon-btn ah-ghost-btn', on && !denied && 'ah-on')} disabled={denied} onClick={toggle} title={denied ? t('notifyDenied') : on ? t('notifyOn') : t('notifyOff')}>
      {on && !denied ? <Bell size={16} /> : <BellOff size={16} />}
    </button>
  )
}

// dsh's own language switch (shared with Settings → Language and stored on the Host), one click away — at Ruyix's sidebar
// foot where its shell is (window.__ruyixSettings)
function LangToggle({ locale }) {
  const t = useT()
  const active = String(useSnapshot(locale).active || 'en').startsWith('zh') ? 'zh' : 'en'
  if (window.__ruyixSettings) return null
  return (
    <div className="ah-seg ah-lang" role="group" aria-label={t('lang')}>
      {[['zh', '中'], ['en', 'EN']].map(([id, label]) => (
        <button key={id} className={cx(active === id && 'ah-on')} title={t(`lang.${id}`)} onClick={() => { local.set('agentHub.lang', id); if (active !== id) locale.setLocale(id) }}>{label}</button>
      ))}
    </div>
  )
}

function Kpi({ icon: Icon, label, value, tone, active, onClick }) {
  return (
    <button className={cx('ah-kpi', `ah-tone-${tone}`, active && 'ah-on')} onClick={onClick}>
      <span className="ah-kpi-icon"><Icon size={14} className={tone === 'running' && value ? 'ah-breathe' : ''} /></span>
      <motion.b key={value} initial={{ y: -6, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>{value}</motion.b>
      <span>{label}</span>
    </button>
  )
}

function HubPage({ t, sessions, status, workspaces, locale, open, archive }) {
  const list = useSnapshot(sessions)
  const statusMap = useSnapshot(status)
  const ws = useSnapshot(workspaces)
  const [store, refresh] = useHubStore()
  const hub = useMemo(() => buildHub(store, statusMap, ws, list), [store, statusMap, ws, list])
  const now = useNow()
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  // the tab, and what the Tasks tab shows (a job, a new job, the overview); an older stored "agents"/"runtimes" is a tab
  const [tab, setTabState] = useState(() => { const old = local.get('agentHub.selected', null)?.kind; return local.get('agentHub.tab', ['agents', 'runtimes'].includes(old) ? old : 'agents') })
  const setTab = next => { setTabState(next); local.set('agentHub.tab', next) }
  const [seed, setSeed] = useState(null) // a draft agent from the runtimes page (an endpoint's "make an agent with it")
  const [selected, setSelected] = useState(() => (k => (['agents', 'runtimes'].includes(k) ? null : local.get('agentHub.selected', null)))(local.get('agentHub.selected', null)?.kind))
  const [read, setRead] = useState(() => new Set(local.get('agentHub.read', [])))
  const [importing, setImporting] = useState(false)
  const [meta, setMeta] = useState({ models: [], skills: [], clis: {}, uses: [] })
  const [toasts, setToasts] = useState([])
  const searchRef = useRef(null)

  // Skills from every workspace's .claude/.dsh folders too, so project skills show up in the editor.
  const wsPaths = ws.items.map(w => w.path).join('\n')
  const loadMeta = () => call('models', { cwds: wsPaths ? wsPaths.split('\n') : [] }).then(setMeta, () => {})
  // the runtimes the pool uses that are not installed or not signed in: one click to Agents → Runtimes
  const [logins, setLogins] = useState([])
  const loadLogins = () => call('logins').then(r => setLogins(r.runtimes.filter(x => !x.ready)), () => {})
  useEffect(() => { loadLogins(); window.addEventListener('focus', loadLogins); return () => window.removeEventListener('focus', loadLogins) }, [])
  useEffect(() => { loadMeta() }, [wsPaths])
  useEffect(() => { if (selected?.kind !== 'new') local.set('agentHub.selected', selected) }, [selected])
  useEffect(() => {
    // (`seed`: a draft agent to open in the add form — Settings → 模型's "make an agent with it"; one asked before this page
    // was open waits in window.__agentHubSeed)
    const take = d => { if (d && typeof d === 'object') { setSeed(d); setTab('agents'); loadMeta() } }
    take(window.__agentHubSeed); delete window.__agentHubSeed
    const on = e => { if (['agents', 'tasks', 'sessions', 'runtimes'].includes(e.detail?.tab)) setTab(e.detail.tab); if (e.detail?.select) setSelected(e.detail.select); if (e.detail?.seed) { take(e.detail.seed); delete window.__agentHubSeed } }
    window.addEventListener('agent-hub:show', on)
    return () => window.removeEventListener('agent-hub:show', on)
  }, [])
  useEffect(() => {
    const onKey = e => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toast = (kind, title, body, extra) => {
    const key = Date.now() + Math.random()
    setToasts(all => [...all, { key, kind, title, body, ...extra }])
    if (kind !== 'pending') setTimeout(() => setToasts(all => all.filter(x => x.key !== key)), kind === 'error' ? 9000 : 5000)
    return change => setToasts(all => all.map(x => (x.key === key ? { ...x, ...change } : x)))
  }
  const attention = attentionOf(hub, read)
  const counts = {
    running: hub.jobs.filter(j => j.doc.status === 'running').length,
    waiting: attention.length, // the same "needs you" as the filter's count
    agents: hub.agents.length,
  }
  const job = selected?.kind === 'job' ? hub.jobs.find(x => x.id === selected.id) : null

  // Viewing a job marks its Lead and failed runs read; keep the set bounded.
  useEffect(() => {
    if (!job) return
    const keys = [job.lead.readKey, ...job.tasks.filter(x => x.status === 'failed').map(x => x.readKey)].filter(k => !read.has(k))
    if (!keys.length) return
    const next = new Set([...read, ...keys])
    setRead(next)
    markRead([...next])
  }, [job])
  // Only when nothing is chosen: a fresh job may not have synced yet (the overview until one runs).
  useEffect(() => {
    if (!store.ready || selected) return
    const pick = hub.jobs.find(x => x.doc.status === 'running')
    if (pick) setSelected({ kind: 'job', id: pick.id })
  }, [store.ready, hub, selected])
  const newJob = () => { setTab('tasks'); setSelected({ kind: 'new' }) }
  const toTasks = f => { setTab('tasks'); setFilter(f) }
  const working = [...store.sessions.values()].filter(d => !d.removedAt && d.state === 'working').length
  const TABS = [['agents', Bot, counts.agents], ['tasks', ListChecks, attention.length], ['sessions', MessagesSquare, working], ['runtimes', Sparkles, logins.length]]

  return (
    <T.Provider value={t}>
      <NowCtx.Provider value={now}>
        <div className="ah-page">
          <style>{STYLE}</style>
          <header className="ah-header">
            <div className="ah-brand">
              <span className="ah-brand-glyph"><Network size={18} /></span>
              <div><h1>{t('title')}</h1><span className="ah-sub">{t('subtitle')}</span></div>
            </div>
            <div className="ah-kpis">
              <Kpi icon={Activity} label={t('kpi.running')} value={counts.running} tone="running" active={tab === 'tasks' && filter === 'running'} onClick={() => toTasks(tab === 'tasks' && filter === 'running' ? 'all' : 'running')} />
              <Kpi icon={PauseCircle} label={t('kpi.waiting')} value={counts.waiting} tone="waiting" active={tab === 'tasks' && filter === 'attention'} onClick={() => toTasks(tab === 'tasks' && filter === 'attention' ? 'all' : 'attention')} />
              <Kpi icon={Bot} label={t('kpi.agents')} value={counts.agents} tone="team" active={tab === 'agents'} onClick={() => setTab('agents')} />
            </div>
            <div className="ah-header-actions">
              <LangToggle locale={locale} />
              <NotifyToggle />
              <button className="ah-btn ah-primary ah-big" onClick={newJob}><Plus size={15} />{t('job.new')}</button>
            </div>
          </header>
          <div className="ah-tabs" role="tablist">
            {TABS.map(([id, Icon, n]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={cx('ah-tab', tab === id && 'ah-on')} onClick={() => setTab(id)}>
                <Icon size={14} />{t(`tab.${id}`)}
                {n > 0 && <span className={cx('ah-tab-count', id === 'tasks' && 'ah-tone-waiting', id === 'runtimes' && 'ah-tone-waiting', id === 'sessions' && 'ah-tone-running')} title={id === 'runtimes' ? t('rts.banner', { n }) : undefined}>{id === 'runtimes' ? <KeyRound size={10} /> : null}{n}</span>}
              </button>
            ))}
          </div>
          {tab === 'agents' && (
            <main className="ah-detail ah-detail-wide">
              <AgentsPage hub={hub} env={meta} logins={logins} toast={msg => toast('ok', msg, '')} refresh={() => { refresh(); loadMeta() }} onImport={() => setImporting(true)} onRuntimes={() => setTab('runtimes')} seed={seed} onSeedTaken={() => setSeed(null)} />
            </main>
          )}
          {tab === 'sessions' && <SessionsPage store={store} agents={hub.agents} now={now} toast={msg => toast('ok', msg, '')} refresh={refresh} />}
          {tab === 'runtimes' && (
            <main className="ah-detail ah-detail-wide">
              <RuntimesPage toast={msg => toast('ok', msg, '')} onChanged={() => { loadLogins(); loadMeta() }} />
            </main>
          )}
          {tab === 'tasks' && (
          <div className="ah-body">
            <aside className="ah-rail">
              <div className="ah-rail-tools">
                <label className="ah-search"><Search size={14} />
                  <input ref={searchRef} placeholder={t('search')} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQuery('')} />
                </label>
                <div className="ah-seg">
                  {['all', 'attention', 'running'].map(f => (
                    <button key={f} className={cx(filter === f && 'ah-on')} onClick={() => setFilter(f)}>
                      {t(`filter.${f}`)}{f === 'attention' && attention.length > 0 && <span className="ah-pill">{attention.length}</span>}
                    </button>
                  ))}
                </div>
              </div>
              {store.ready
                ? <Rail hub={hub} attention={filter === 'running' ? [] : attention} selected={selected} onSelect={setSelected} now={now} filter={filter} query={query} onNewJob={newJob} />
                : <div className="ah-skeleton">{[0, 1, 2, 3].map(i => <span key={i} />)}</div>}
            </aside>
            <main className="ah-detail">
              <AnimatePresence mode="wait">
                {job
                  ? <JobView key={job.id} job={job} agents={hub.agents} selectedMember={selected.member || null} open={open} refresh={refresh}
                    setSelectedMember={member => setSelected({ kind: 'job', id: job.id, member })}
                    archive={async id => { await archive(id); setSelected(null) }} />
                  : selected?.kind === 'new'
                    ? <NewJob key="new" workspaces={ws} lead={hub.agents.find(a => a.id === hub.defaultAgent)} onCancel={() => setSelected(null)}
                      onStarted={j => { refresh(); setSelected({ kind: 'job', id: j.id }) }} />
                    : store.ready && <Overview key="overview" onNewJob={newJob} onAgents={() => setTab('agents')} />}
              </AnimatePresence>
            </main>
          </div>
          )}
          <div className="ah-toasts">
            <AnimatePresence>
              {toasts.map(l => (
                <motion.div key={l.key} className={cx('ah-toast', `ah-toast-${l.kind}`)} layout initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 40 }}>
                  {l.kind === 'pending' ? <Loader2 size={15} className="ah-spin" /> : l.kind === 'ok' ? <CheckCircle2 size={15} /> : l.kind === 'warn' ? <Info size={15} /> : <XCircle size={15} />}
                  <div className="ah-toast-text"><b>{l.title}</b>{l.body && <span>{l.body}</span>}</div>
                  {l.kind !== 'pending' && <button className="ah-icon-btn" onClick={() => setToasts(all => all.filter(x => x.key !== l.key))}><X size={14} /></button>}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          <AnimatePresence>
            {importing && <ImportDialog key="import" onClose={() => setImporting(false)} onImported={r => {
              setImporting(false)
              refresh()
              setTab('agents')
              if (r.warnings.length) toast('warn', t('agent.importedWarn'), r.warnings.join(', '))
              else toast('ok', t('agent.imported', { ids: r.agents.join(', ') }), '')
            }} />}
          </AnimatePresence>
        </div>
      </NowCtx.Provider>
    </T.Provider>
  )
}

// What needs you, as rows of the workbench's inbox (the slot 'ruyix.inbox.needs': it lists them above its approvals and
// counts them); the sidebar icon keeps them current. A row opens the job on the Tasks tab, as the rail would.
const needs = { items: [], t: k => k, listeners: new Set(), getSnapshot: () => needs.items, subscribe: fn => { needs.listeners.add(fn); return () => needs.listeners.delete(fn) } }
const TONE = { error: 'red', waiting: 'amber', done: 'blue' }
function setNeeds(attention) {
  const t = needs.t, now = Date.now()
  const items = attention.map(a => {
    const d = describe(t, a.agent, now)
    return { key: a.key, icon: a.lead ? 'agent' : 'failed', kind: a.lead ? d.label : t('phase.failed'), title: a.title, since: a.agent.act?.lastEnd?.at || a.agent.endedAt || a.agent.updatedAt || 0,
      tone: a.lead ? TONE[d.tone] || 'amber' : 'red', open: () => window.dispatchEvent(new CustomEvent('agent-hub:open', { detail: { tab: 'tasks', select: { kind: 'job', id: a.jobId, member: a.pick } } })) }
  })
  if (items.map(i => `${i.key}|${i.kind}`).join() === needs.items.map(i => `${i.key}|${i.kind}`).join()) return
  needs.items = items
  for (const fn of needs.listeners) fn()
}

// What this machine needs from a person, as rows of the workbench's System tab (the slot 'ruyix.inbox.system'): a CLI the
// agents run on that is not signed in or not installed, a skill pack that could not be fetched. Looked at on load and
// every 5 minutes (a CLI's own status check is a process each), and again after a row's action.
const rowStore = () => {
  const s = { items: [], listeners: new Set(), getSnapshot: () => s.items, subscribe: fn => { s.listeners.add(fn); return () => s.listeners.delete(fn) } }
  s.set = items => { if (JSON.stringify(items) === JSON.stringify(s.items)) return; s.items = items; for (const fn of s.listeners) fn() } // (actions' run() are not compared)
  return s
}
const runtimeRows = rowStore(), packRows = rowStore()
async function lookAtSystem(t) {
  const [rts, sk] = await Promise.all([call('runtimes').catch(() => null), call('skillPacks', { cwds: [] }).catch(() => null)])
  const again = () => lookAtSystem(t)
  const runtimes = () => window.dispatchEvent(new CustomEvent('agent-hub:open', { detail: { tab: 'runtimes' } }))
  // (a runtime whose agents all take their model from an endpoint needs no sign-in of its own: no row; pi has no sign-in
  // at all — it needs a model: a model endpoint with its key, in Settings → 模型)
  const models = () => window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: 'models' } }))
  if (rts) runtimeRows.set(rts.runtimes.filter(r => r.agents?.length && (r.status === 'missing' || (r.status === 'unauthenticated' && !r.viaEndpoint))).map(r => {
    const pi = r.runtime === 'pi' && r.status !== 'missing'
    return {
      key: `runtime:${r.runtime}`, tone: 'warning', title: t(r.status === 'missing' ? 'rt.missing' : pi ? 'sys.piNoModel' : 'sys.rtLogin', { name: t(`rt.${r.runtime}`) }),
      detail: t(r.status === 'missing' ? 'sys.rtInstallHint' : pi ? 'sys.piNoModelHint' : 'sys.rtLoginHint'), affects: r.agents,
      actions: [{ label: t(r.status === 'missing' ? 'sys.rtInstall' : pi ? 'sys.piSetModel' : 'sys.rtSignIn'), primary: true, run: pi ? models : runtimes }],
    }
  }))
  // a git pack never fetched, its fetch failed (one that has a version keeps working when an update fails)
  if (sk) packRows.set(sk.packs.filter(p => p.kind === 'git' && !p.sha && p.error).map(p => ({
    key: `pack:${p.id}`, tone: 'warning', title: t('sys.packFailed', { id: p.id }), detail: p.error, since: p.errorAt || undefined,
    affects: [...new Set((p.usedBy || []).map(u => u.by))],
    actions: [
      { label: t('sys.retry'), primary: true, run: () => call('skillPackUpdate', { id: p.id }).finally(again) },
      // the pack's card: the Skills page
      { label: t('sys.packOpen'), run: () => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: SKILLS_PANEL } })) },
    ],
  })))
}

// The badge counts exactly what the panel's "needs you" list shows (not every dsh session with an unread result:
// those belong to the session list, and the panel had nothing to show for them).
function HubIcon({ size, status, sessions, workspaces }) {
  const statusMap = useSnapshot(status)
  const list = useSnapshot(sessions)
  const ws = useSnapshot(workspaces)
  const [store] = useHubStore(5000) // the panel's poll when it is open, else its own every 5 s
  const read = useReadMarks()
  const attention = useMemo(() => attentionOf(buildHub(store, statusMap, ws, list), read), [store, statusMap, ws, list, read])
  const count = attention.length
  useEffect(() => setNeeds(attention), [attention])
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <Network size={size || 16} strokeWidth={1.6} />
      {count > 0 && <span className="ah-icon-badge" style={{
        position: 'absolute', top: -5, right: -7, minWidth: 14, height: 14, padding: '0 3px', boxSizing: 'border-box', borderRadius: 7,
        fontSize: 9, lineHeight: '14px', textAlign: 'center', fontWeight: 600,
        color: 'var(--dsw-alias-label-primary-foreground)', background: 'var(--ruyix-warning)',
      }}>{count > 99 ? '99+' : count}</span>}
    </span>
  )
}

export const inject = ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'uiSession', 'layout']

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-hub: dictionaries')
  // the desk's 「智能体」 widget (src/desk.jsx): who in the pool does what now, or did last
  ctx.effect(() => {
    window.__ruyixWidgetDefs = [...(window.__ruyixWidgetDefs || []).filter(d => d.type !== AGENTS_WIDGET.type), AGENTS_WIDGET]
    window.dispatchEvent(new Event('ruyix:widget'))
    return () => { window.__ruyixWidgetDefs = (window.__ruyixWidgetDefs || []).filter(d => d !== AGENTS_WIDGET); window.dispatchEvent(new Event('ruyix:widget')) }
  }, 'agent-hub: the desk widget')
  // dsh stores the language on the Host only for loopback browsers; over Tailscale the choice
  // would reset on every reload, so this browser also remembers it.
  const lang = local.get('agentHub.lang', null)
  if (lang && !String(ctx.locale.getSnapshot().active).startsWith(lang)) {
    try { ctx.locale.setLocale(lang) } catch { /* that language is not loaded */ }
  }
  const t = ctx.locale.bind(NS)
  needs.t = t
  // the work going on, for the desks (the shell's work list): this hub's sessions and its own jobs
  // (lines in the page's language, as every lane says them: work-lines; seen and summarize through this hub's ops)
  const lineLang = () => (String(ctx.locale.getSnapshot().active || '').startsWith('zh') ? 'zh' : 'en')
  const summarize = id => call('summarize', { id }).then(r => r.text || null)
  ctx.effect(() => watchHub(s => {
    if (!s.ready) return
    const w = workRegistry()
    w.set('sessions', sessionItems(s.sessions, lineLang()), { seen: ids => ids.forEach(id => call('sessionSeen', { id: id.slice('session:'.length) }).catch(() => {})), summarize })
    w.set('tasks', jobItems(s.jobs, s.tasks, Date.now(), lineLang()), { seen: ids => ids.forEach(id => call('jobSeen', { id: id.slice('task:'.length) }).catch(() => {})), summarize })
  }), 'agent-hub: work for the desks')
  const open = agent => ctx.uiWorkspace.openSession(agent.id)
  ctx.slots.inject('ruyix.inbox.needs', () => ctx.slots.register({ name: 'ruyix.inbox.needs', id: 'agents', order: 40, label: () => t('sec.attention.inbox') }, () => null))
  ctx.effect(() => { (window.__ruyixInbox ||= {}).agents = { items: needs }; return () => { delete window.__ruyixInbox.agents } }, 'agent-hub: inbox rows') // a slot entry keeps only id, order, label
  for (const [id, order, label, items] of [['agent-hub-runtimes', 30, 'tab.runtimes', runtimeRows], ['agent-hub-packs', 40, 'sk.packs', packRows]]) {
    ctx.slots.inject('ruyix.inbox.system', () => ctx.slots.register({ name: 'ruyix.inbox.system', id, order, label: () => t(label) }, () => null))
    ctx.effect(() => { (window.__ruyixInbox ||= {})[id] = { items }; return () => { delete window.__ruyixInbox[id] } }, `agent-hub: system rows ${id}`)
  }
  ctx.effect(() => { lookAtSystem(t); const timer = setInterval(() => lookAtSystem(t), 5 * 60e3); return () => clearInterval(timer) }, 'agent-hub: system look')
  const langNow = () => String(ctx.locale.getSnapshot().active || '').slice(0, 2)
  let shown = langNow() // (the locale also changes when a plugin registers its words: only a new language looks again)
  ctx.effect(() => ctx.locale.subscribe(() => { if (langNow() !== shown) { shown = langNow(); lookAtSystem(t) } }), 'agent-hub: system rows in the new language')

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL,
    locale: NS,
    inject: () => ({
      sessions: ctx.sessions.list, status: ctx.uiSession.sessionStatus, workspaces: ctx.workspaces.list, locale: ctx.locale, open,
      archive: id => ctx.workspaces.archiveSession(id),
    }),
  }, HubPage))
  // Skills: the skill packs the agents and the workflows' steps draw on (Admin group)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SKILLS_PANEL,
    locale: NS,
    inject: () => ({ workspaces: ctx.workspaces.list, style: STYLE }),
  }, SkillsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: SKILLS_PANEL,
    order: 41, // with the shell: under Admin, beside the workbench's settings
    locale: NS,
    label: () => t('sk.panel'),
  }, ({ size }) => <Wand2 size={size || 16} strokeWidth={1.6} />))
  // another panel opens a tab here: the tab is remembered (the page reads it when it mounts) and the panel selected
  ctx.effect(() => {
    const open = e => {
      local.set('agentHub.tab', e.detail?.tab || 'agents')
      if (e.detail?.select) local.set('agentHub.selected', e.detail.select) // read when the page mounts
      if (e.detail?.session) local.set('agentHub.session', String(e.detail.session)) // (the 会话 page's: a desk's mark)
      try { ctx.layout?.selectPanel(PANEL) } catch { /* layout not ready */ }
      window.dispatchEvent(new CustomEvent('agent-hub:show', { detail: e.detail || {} }))
    }
    window.addEventListener('agent-hub:open', open)
    return () => window.removeEventListener('agent-hub:open', open)
  }, 'agent-hub: open requests')
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL,
    order: 30,
    locale: NS,
    label: () => t('panel'),
    inject: () => ({ status: ctx.uiSession.sessionStatus, sessions: ctx.sessions.list, workspaces: ctx.workspaces.list }),
  }, HubIcon))

  // Desktop notifications run from the plugin, so they fire with the panel closed.
  ctx.effect(() => {
    const source = ctx.uiSession.sessionStatus
    let previous = null
    const check = () => {
      const snapshot = source.getSnapshot()
      if (previous && local.get('agentHub.notify', false) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        for (const [id, s] of snapshot) {
          const before = previous.get(id)
          if (!before) continue
          const viewing = !document.hidden && (ctx.sessions.retainInfo(id).getSnapshot().retainedBy.mainView ?? 0) > 0
          const waitingNow = !!s.pendingInteraction && !before.waiting
          const finishedNow = before.running && !s.running && !s.pendingInteraction
          if (viewing || (!waitingNow && !finishedNow)) continue
          const title = ctx.sessions.list.getSnapshot().byId[id]?.displayTitle || id.slice(0, 8)
          const note = new Notification(t(waitingNow ? 'notify.waiting' : 'notify.done', { title }), {
            body: waitingNow && s.pendingInteraction.toolName ? s.pendingInteraction.toolName : '',
            tag: `agent-hub:${id}`,
          })
          note.onclick = () => { window.focus(); ctx.uiWorkspace.openSession(id); note.close() }
        }
      }
      previous = new Map([...snapshot].map(([id, s]) => [id, { running: !!s.running, waiting: !!s.pendingInteraction }]))
    }
    check()
    return source.subscribe(check)
  }, 'agent-hub: notifications')
}
