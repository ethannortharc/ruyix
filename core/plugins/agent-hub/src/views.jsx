// Panel views: the Tasks tab's rail (what needs you, the jobs), the job view (workflow / board / roles / report, with
// Lead, role and task panels), a new job, the Agents tab (the default agent, a row per agent and its detail, add /
// edit / share) and the import dialog.
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import {
  Archive, Ban, Bot, ChevronRight, Clock, Columns3, Copy, Download, ExternalLink, FileText, FileUp, FolderGit2, Inbox, KeyRound,
  ListChecks, ListPlus, MessageSquare, MoreHorizontal, Pencil, Plus, Rocket, Save, Search, Send, Sparkles, Square, Star, Trash2, Upload, Users, Wand2, Workflow, X,
} from 'lucide-react'
import { call, local } from './data.js'
import { NowCtx, TeamFlow, taskTone } from './flow.jsx'
import { AccessBadge, Avatar, Composer, Metrics, RuntimeBadge, StateBadge, StatusLine, Timeline, ago, cx, docError, dur, errorText, kfmt, useT } from './ui.jsx'

const spring = { type: 'spring', stiffness: 420, damping: 34 }
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const RUNTIMES = ['dsh', 'claude', 'codex', 'pi']
const EFFORTS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'], pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }
const blankAgent = () => ({ id: '', name: '', runtime: 'claude', model: null, effort: null, access: null, skills: [], notes: '' })
const fade = { initial: { opacity: 0, height: 0 }, animate: { opacity: 1, height: 'auto' }, exit: { opacity: 0, height: 0 } }
const L = (t, v) => (v && typeof v === 'object' ? v[t('sk.lang')] || v.en : v || '')

// ── rail ──────────────────────────────────────────────────────────────────
function RailItem({ selected, onClick, children, tone, className }) {
  return (
    <motion.button layout="position" className={cx('ah-rail-item', `ah-tone-${tone}`, selected && 'ah-on', className)} onClick={onClick}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={spring}>
      {selected && <motion.span layoutId="ah-rail-pill" className="ah-rail-pill" transition={spring} />}
      {children}
    </motion.button>
  )
}

export function Rail({ hub, attention, selected, onSelect, now, filter, query, onNewJob }) {
  const t = useT()
  const q = query.trim().toLowerCase()
  const has = (...values) => !q || values.some(v => v && String(v).toLowerCase().includes(q))
  const jobs = hub.jobs.filter(j => (filter !== 'running' || j.doc.status === 'running') && has(j.title, j.goal, ...j.tasks.map(x => x.member)))
  const att = attention.filter(a => has(a.title))
  const is = (kind, id) => selected?.kind === kind && (id === undefined || selected.id === id)
  return (
    <LayoutGroup>
      <div className="ah-rail-scroll">
        {att.length > 0 && (
          <div className="ah-rail-section">
            <div className="ah-rail-head"><Inbox size={13} />{t('sec.attention')}<span className="ah-count">{att.length}</span></div>
            <AnimatePresence initial={false}>
              {att.map(a => (
                <RailItem key={a.key} tone={a.agent.state} selected={false} onClick={() => onSelect({ kind: 'job', id: a.jobId, member: a.pick })}>
                  <Avatar name={a.avatar} state={a.agent.state} size={28} lead={a.lead} />
                  <span className="ah-rail-body"><span className="ah-rail-title">{a.title}</span><StatusLine agent={a.agent} now={now} /></span>
                </RailItem>
              ))}
            </AnimatePresence>
          </div>
        )}
        <div className="ah-rail-section">
          <div className="ah-rail-head"><ListChecks size={13} />{t('sec.jobs')}<span className="ah-count">{jobs.length}</span>
            <span className="ah-rail-head-actions">
              <button className="ah-icon-btn ah-mini" title={t('job.new')} onClick={onNewJob}><Plus size={14} /></button>
            </span>
          </div>
          <AnimatePresence initial={false}>
            {jobs.map(j => (
              <RailItem key={j.id} className="ah-rail-job" tone={j.state} selected={is('job', j.id)} onClick={() => onSelect({ kind: 'job', id: j.id })}>
                <span className={cx('ah-dot', j.state === 'running' && 'ah-breathe')} />
                <span className="ah-rail-body">
                  <span className="ah-rail-title">{j.title}</span>
                  <span className="ah-rail-meta">{j.live ? t('job.live', { n: j.live }) : t(`job.${j.doc.status}`)}<span>·</span>{t('tasks.progress', { done: j.done, total: j.tasks.length })}
                    <span>·</span>{ago(t, now - j.doc.createdAt)}</span>
                </span>
              </RailItem>
            ))}
          </AnimatePresence>
          {!jobs.length && <div className="ah-empty-small">{q ? t('emptyFilter') : t('emptyJobs')}</div>}
        </div>
      </div>
    </LayoutGroup>
  )
}

// ── job side panels ───────────────────────────────────────────────────────
function LeadPanel({ job, open, refresh }) {
  const t = useT()
  const now = useContext(NowCtx)
  const lead = job.lead
  return (
    <div className="ah-agent-panel ah-compact">
      <div className="ah-agent-hero">
        <Avatar name="lead" state={lead.state} size={40} lead />
        <div className="ah-hero-title"><h2>{t('lead')}</h2><span className="ah-sub">{lead.ws}{lead.model && <> · <span className="ah-mono">{lead.model}</span></>}</span></div>
        <StateBadge state={lead.state} />
      </div>
      <StatusLine agent={lead} now={now} big />
      <Metrics agent={lead} />
      <div className="ah-panel-label"><Clock size={12} />{t('details')}</div>
      <Timeline agent={lead} now={now} />
      <Composer agent={lead} placeholder={t('leadHint')} onSent={refresh} />
      <div className="ah-actions"><button className="ah-btn" onClick={() => open(lead)}><ExternalLink size={13} />{t('open')}</button></div>
    </div>
  )
}

function AssignBox({ job, agents, lane, onDone, autoFocus }) {
  const t = useT()
  const [who, setWho] = useState(lane?.def.agent || agents[0]?.id || '')
  const [role, setRole] = useState(lane?.name || '')
  const [access, setAccess] = useState(lane?.def.access === 'read' ? 'read' : 'write')
  const [task, setTask] = useState('')
  const [after, setAfter] = useState([])
  const upstream = job.tasks.filter(x => x.status !== 'failed' && x.status !== 'cancelled')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef(null)
  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }) }, [autoFocus])
  const submit = async () => {
    if (!task.trim() || busy) return
    setBusy(true); setError('')
    try { await call('assign', { jobId: job.id, agent: who, role: role.trim() || undefined, access, task, after }); setTask(''); setAfter([]); onDone?.() } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return (
    <div className="ah-assign">
      <div className="ah-chips">
        {agents.map(a => (
          <button key={a.id} className={cx('ah-chip-btn', who === a.id && 'ah-on')} title={[a.runtime, a.model].filter(Boolean).join(' · ')} onClick={() => setWho(a.id)}>
            <Avatar name={a.id} size={16} />{a.name || a.id}
          </button>
        ))}
        {!agents.length && <span className="ah-sub">{t('pool.empty')}</span>}
      </div>
      <div className="ah-assign-opts">
        <input className="ah-input ah-mono" value={role} placeholder={t('assign.rolePh')} onChange={e => setRole(e.target.value)} />
        <Seg value={access} options={['read', 'write']} label={a => t(`access.${a}`)} onChange={setAccess} />
      </div>
      <div className="ah-composer">
        <textarea ref={ref} rows={2} value={task} disabled={busy} placeholder={t('assign.ph', { name: role.trim() || who })}
          onChange={e => setTask(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() } }} />
        <button className="ah-icon-btn ah-primary-btn" disabled={busy || !task.trim() || !who} onClick={submit} aria-label={t('assign.go')}><Send size={15} /></button>
      </div>
      {upstream.length > 0 && (
        <div className="ah-chips ah-after-chips"><span className="ah-sub">{t('assign.after')}</span>
          {upstream.map(x => (
            <button key={x.id} className={cx('ah-chip-btn', after.includes(x.id) && 'ah-on')} title={x.title}
              onClick={() => setAfter(after.includes(x.id) ? after.filter(id => id !== x.id) : [...after, x.id])}>{x.id} · {x.member}</button>
          ))}
        </div>
      )}
      <span className="ah-sub">{t('assign.hint')}</span>
      {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
    </div>
  )
}

function MemberPanel({ job, m, agents, onPick, refresh }) {
  const t = useT()
  const now = useContext(NowCtx)
  return (
    <div className="ah-agent-panel ah-compact">
      <div className="ah-agent-hero">
        <Avatar name={m.name} state={m.state} size={40} />
        <div className="ah-hero-title"><h2>{m.name}</h2><span className="ah-sub" title={m.def.role}>{m.def.role || t('lane.noRole')}</span></div>
        <StateBadge state={m.state} />
      </div>
      <div className="ah-node-badges">
        {m.def.agent && <span className="ah-chip"><Bot size={11} />{m.def.agent}</span>}
        <RuntimeBadge runtime={m.def.runtime} model={m.model} effort={m.def.effort} /><AccessBadge access={m.def.access} />{m.def.fallback && <FallbackBadge fb={m.def.fallback} />}
        {m.def.skills.map(s => <span key={s} className="ah-chip"><Wand2 size={11} />{s}</span>)}
      </div>
      <StatusLine agent={m} now={now} big />
      <Metrics agent={{ ...m, model: '' }} />
      {m.act && <><div className="ah-panel-label"><Clock size={12} />{m.current ? t('member.now') : t('member.last')}</div><Timeline agent={m} now={now} /></>}
      <div className="ah-panel-label"><ListPlus size={12} />{t('member.tasks', { n: m.tasks.length })}</div>
      <div className="ah-task-list">
        {[...m.tasks].reverse().map(x => (
          <button key={x.id} className={cx('ah-task-row', `ah-tone-${taskTone(x)}`)} onClick={() => onPick(`task:${x.id}`)}>
            <span className="ah-dot" /><span className="ah-task-id">{x.id}</span><span className="ah-task-row-title">{x.title}</span>
            <span className="ah-sub">{x.startedAt ? dur((x.endedAt || now) - x.startedAt) : t(`task.${x.status}`)}</span><ChevronRight size={13} />
          </button>
        ))}
        {!m.tasks.length && <div className="ah-empty-small">{t('member.noTasks')}</div>}
      </div>
      <AssignBox job={job} agents={agents} lane={m} onDone={refresh} />
    </div>
  )
}

function TaskPanel({ job, task, onPick, refresh }) {
  const t = useT()
  const now = useContext(NowCtx)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const owner = job.members.find(m => m.name === task.member)
  // sync carries the first 2000 characters of a long brief or report: the whole text when the task is open
  const [full, setFull] = useState(null)
  useEffect(() => {
    setFull(null); setError(null)
    if (task.taskCut || task.outputCut) call('task', { id: task.id }).then(r => setFull(r.task), () => {})
  }, [task.id, task.taskCut, task.outputCut, task.status])
  const brief = full?.task ?? task.task, output = full?.output ?? task.output
  const cancel = async () => {
    setBusy(true)
    try { await call('cancelTask', { id: task.id }); refresh() } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return (
    <div className="ah-agent-panel ah-compact">
      <div className="ah-agent-hero">
        <span className={cx('ah-task-badge', `ah-tone-${taskTone(task)}`)}>{task.id}</span>
        <div className="ah-hero-title"><h2 title={task.title}>{task.title}</h2>
          <span className="ah-sub">{t(task.by === 'lead' ? 'task.byLead' : 'task.byUser')}{task.startedAt && <> · {dur((task.endedAt || now) - task.startedAt)}</>}</span></div>
        <span className={cx('ah-badge', `ah-tone-${taskTone(task)}`)}>{t(`task.${task.status}`)}</span>
      </div>
      <div className="ah-node-badges">
        {owner && <button className="ah-chip-btn" onClick={() => onPick(owner.id)}><Avatar name={task.member} state={owner.state} size={16} />{task.member}<ChevronRight size={12} /></button>}
        {task.agent && <span className="ah-chip"><Bot size={11} />{task.agent}</span>}
        <RuntimeBadge runtime={task.runtime} model={task.model} effort={task.effort} /><AccessBadge access={task.access} />
        {task.fallbackOf && <span className="ah-fb-used" title={task.fallbackOf.error}>{t('fb.used', { from: task.fallbackOf.agent || task.fallbackOf.runtime, to: task.agent || task.runtime })}</span>}
      </div>
      {task.after?.length > 0 && (
        <div className="ah-chips"><span className="ah-sub">{task.status === 'queued' ? t('task.waitingFor') : t('task.after')}</span>
          {task.after.map(id => {
            const dep = job.tasks.find(x => x.id === id)
            return <button key={id} className={cx('ah-chip-btn', dep && `ah-tone-${taskTone(dep)}`)} onClick={() => onPick(`task:${id}`)}>{id}{dep && ` · ${dep.member}`}<ChevronRight size={12} /></button>
          })}
        </div>
      )}
      {task.running && <StatusLine agent={task} now={now} big />}
      <Metrics agent={{ ...task, model: '', ctxPct: null }} />
      <details className="ah-brief"><summary><FileText size={12} />{t('task.brief')}</summary><div className="ah-quote">{brief}</div></details>
      {task.act && <><div className="ah-panel-label"><Clock size={12} />{t('details')}</div><Timeline agent={task} now={now} /></>}
      {task.missingSkills?.length > 0 && <div className="ah-note ah-tone-waiting">{t('task.missingSkills', { names: task.missingSkills.join(', ') })}</div>}
      {task.error && task.errorCode !== 'cancelled' && <div className={cx('ah-note', task.status === 'cancelled' ? 'ah-tone-waiting' : 'ah-tone-error')}>{docError(t, task)}</div>}
      {output && <><div className="ah-panel-label"><Sparkles size={12} />{t('task.report')}</div><div className="ah-report">{output.trim()}</div></>}
      {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
      {(task.status === 'running' || task.status === 'queued') && (
        <div className="ah-actions"><button className="ah-btn ah-danger" disabled={busy} onClick={cancel}><Ban size={13} />{t('task.cancel')}</button></div>
      )}
    </div>
  )
}

// ── job view ──────────────────────────────────────────────────────────────
function Ring({ pct, tone }) {
  const r = 17, c = 2 * Math.PI * r
  return (
    <svg className={cx('ah-ring', `ah-tone-${tone}`)} width="44" height="44" viewBox="0 0 44 44" aria-hidden>
      <circle cx="22" cy="22" r={r} className="ah-ring-track" />
      <motion.circle cx="22" cy="22" r={r} className="ah-ring-value" strokeDasharray={c} animate={{ strokeDashoffset: c * (1 - pct / 100) }} transition={{ duration: 0.8 }} />
      <text x="22" y="26" textAnchor="middle">{pct}%</text>
    </svg>
  )
}

const COLS = [['queued', ['queued']], ['running', ['running']], ['done', ['done']], ['failed', ['failed', 'cancelled']]]
function Board({ job, onPick }) {
  const t = useT()
  const now = useContext(NowCtx)
  if (!job.tasks.length) return <div className="ah-empty-small">{t('noTasks')}</div>
  return (
    <LayoutGroup>
      <div className="ah-board">
        {COLS.map(([col, statuses]) => {
          const tasks = job.tasks.filter(x => statuses.includes(x.status))
          return (
            <div key={col} className={cx('ah-col', `ah-col-${col}`)}>
              <div className="ah-col-head"><span className="ah-dot" />{t(`col.${col}`)}<span className="ah-count">{tasks.length}</span></div>
              <AnimatePresence>
                {tasks.map(x => (
                  <motion.button layout layoutId={`task-${job.id}-${x.id}`} key={x.id} className={cx('ah-task', `ah-tone-${taskTone(x)}`)} title={String(x.task || '').slice(0, 300)} transition={spring} onClick={() => onPick(`task:${x.id}`)}>
                    <div className="ah-task-top"><span className="ah-task-id">{x.id}</span>
                      <span className="ah-owner"><Avatar name={x.member} size={16} />{x.member}</span>
                    </div>
                    <div className="ah-task-subject">{x.title}</div>
                    {x.running ? <StatusLine agent={x} now={now} />
                      : <div className="ah-task-meta">{x.status === 'queued' && x.after?.length ? t('task.waitingShort', { ids: x.after.join(', ') }) : ''}{x.startedAt ? dur((x.endedAt || now) - x.startedAt) : ''}{x.tokens ? ` · ${t('tokens', { n: kfmt(x.tokens) })}` : ''}{(x.status === 'failed' || x.status === 'cancelled') && x.error && x.errorCode !== 'cancelled' ? ` · ${docError(t, x)}` : ''}</div>}
                  </motion.button>
                ))}
              </AnimatePresence>
            </div>
          )
        })}
      </div>
    </LayoutGroup>
  )
}

function MemberCards({ lead, members, onPick }) {
  const now = useContext(NowCtx)
  const t = useT()
  return (
    <div className="ah-member-grid">
      {lead && (
        <motion.button layout className={cx('ah-member-card', `ah-tone-${lead.state}`)} onClick={() => onPick?.(lead.id)} whileHover={{ y: -2 }}>
          <div className="ah-member-head"><Avatar name="lead" state={lead.state} size={30} lead /><b>{t('lead')}</b><StateBadge state={lead.state} /></div>
          <StatusLine agent={lead} now={now} />
          <Metrics agent={lead} />
        </motion.button>
      )}
      {members.map(m => (
        <motion.button layout key={m.id} className={cx('ah-member-card', `ah-tone-${m.state}`)} onClick={() => onPick?.(m.id)} whileHover={{ y: -2 }}>
          <div className="ah-member-head"><Avatar name={m.name} state={m.state} size={30} /><b>{m.name}</b><StateBadge state={m.state} /></div>
          <div className="ah-node-badges"><RuntimeBadge runtime={m.def.runtime} model={m.model} effort={m.def.effort} /><AccessBadge access={m.def.access} />{m.def.fallback && <FallbackBadge fb={m.def.fallback} />}</div>
          <div className="ah-member-role" title={m.def.role}>{m.def.role || (m.def.agent && t('lane.agent', { id: m.def.agent }))}</div>
          <StatusLine agent={m} now={now} />
          <div className="ah-metrics"><span className="ah-metric">{t('member.done', { n: m.done, total: m.tasks.length })}</span>
            {m.tokens > 0 && <span className="ah-metric">{t('tokens', { n: kfmt(m.tokens) })}</span>}
            {m.cost > 0 && <span className="ah-metric">${m.cost.toFixed(3)}</span>}</div>
        </motion.button>
      ))}
    </div>
  )
}

export function JobView({ job, agents, selectedMember, setSelectedMember, open, refresh, archive }) {
  const t = useT()
  const now = useContext(NowCtx)
  const [tab, setTab] = useState(() => (job.doc.status !== 'running' && job.report ? 'report' : local.get('agentHub.jobTab', 'flow')))
  const [mode, setMode] = useState(null)
  const [note, setNote] = useState('')
  useEffect(() => { if (tab !== 'report') local.set('agentHub.jobTab', tab) }, [tab])
  const pct = job.tasks.length ? Math.round(job.done / job.tasks.length * 100) : 0
  const picked = useMemo(() => {
    if (!selectedMember) return null
    if (selectedMember === job.lead.id) return { lead: true }
    if (selectedMember.startsWith('task:')) {
      const task = job.tasks.find(x => `task:${x.id}` === selectedMember)
      return task && { task }
    }
    const member = job.members.find(m => m.id === selectedMember)
    return member && { member }
  }, [selectedMember, job])
  const running = job.doc.status === 'running'
  const stop = () => call('stopJob', { id: job.id }).then(refresh, err => setNote(err))
  const tabs = [['flow', Workflow], ['board', Columns3], ['members', Users], ...(job.report || job.error ? [['report', FileText]] : [])]
  return (
    <motion.div key={job.id} className="ah-detail-card ah-team-view" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <div className="ah-team-head">
        <Ring pct={pct} tone={job.state} />
        <div className="ah-hero-title">
          <span className="ah-crumb">{job.doc.headless ? t('job.byService') : t('job.leadAgent', { id: job.doc.leadAgent || t('pool.defaultNone') })}</span>
          <h2 title={job.goal}>{job.title}</h2>
          <span className="ah-sub"><span className={cx('ah-badge', `ah-tone-${job.state}`)}>{t(`job.${job.doc.status}`)}</span>
            <FolderGit2 size={12} /> {job.lead.ws} · {ago(t, now - job.doc.createdAt)} · {t('tasks.progress', { done: job.done, total: job.tasks.length })}</span>
        </div>
        <div className="ah-actions">
          <button className={cx('ah-btn', mode === 'assign' && 'ah-on')} onClick={() => setMode(mode === 'assign' ? null : 'assign')}><ListPlus size={13} />{t('assign.title')}</button>
          <button className={cx('ah-btn', mode === 'msg' && 'ah-on')} onClick={() => setMode(mode === 'msg' ? null : 'msg')}><MessageSquare size={13} />{t('messageLead')}</button>
          {running
            ? <button className="ah-btn ah-danger" onClick={stop}><Square size={13} />{t('job.stop')}</button>
            : <button className="ah-btn" onClick={() => archive(job.lead.id).catch(err => setNote(err))}><Archive size={13} />{t('archive')}</button>}
          <button className="ah-btn ah-primary" onClick={() => open(job.lead)}><ExternalLink size={13} />{t('open')}</button>
        </div>
      </div>
      {note && <div className="ah-note ah-tone-error">{errorText(t, note)}</div>}
      <AnimatePresence>
        {mode === 'assign' && <motion.div key="assign" {...fade}><AssignBox job={job} agents={agents} autoFocus onDone={() => { setMode(null); refresh() }} /></motion.div>}
        {mode === 'msg' && <motion.div key="msg" {...fade}><Composer agent={job.lead} autoFocus placeholder={t('leadHint')} onSent={refresh} /></motion.div>}
      </AnimatePresence>
      <div className="ah-tabs">
        {tabs.map(([key, Icon]) => (
          <button key={key} className={cx(tab === key && 'ah-on')} onClick={() => setTab(key)}>
            {tab === key && <motion.span layoutId={`ah-tab-${job.id}`} className="ah-tab-pill" transition={spring} />}
            <Icon size={14} />{t(`view.${key}`)}
          </button>
        ))}
      </div>
      <div className="ah-team-body">
        {/* with a panel open the board and the member cards make room for it (the flow canvas pans under it) */}
        <div className={cx('ah-team-main', picked && tab !== 'flow' && 'ah-side-open')}>
          {tab === 'flow' && <div className="ah-flow-wrap"><TeamFlow team={job} selected={selectedMember} onSelect={setSelectedMember} /></div>}
          {tab === 'board' && <Board job={job} onPick={setSelectedMember} />}
          {tab === 'members' && <MemberCards lead={job.lead} members={job.members} onPick={setSelectedMember} />}
          {tab === 'report' && (
            <div className="ah-job-report">
              {job.error && <div className="ah-note ah-tone-error">{docError(t, job.doc)}</div>}
              {job.report ? <div className="ah-report ah-report-big">{job.report}</div> : !job.error && <div className="ah-empty-small">{t('job.noReport')}</div>}
            </div>
          )}
        </div>
        <AnimatePresence>
          {picked && (
            <motion.aside key={selectedMember} className="ah-side" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }} transition={spring}>
              <button className="ah-icon-btn ah-side-close" onClick={() => setSelectedMember(null)} aria-label={t('close')}><X size={15} /></button>
              {picked.lead && <LeadPanel job={job} open={open} refresh={refresh} />}
              {picked.member && <MemberPanel job={job} m={picked.member} agents={agents} onPick={setSelectedMember} refresh={refresh} />}
              {picked.task && <TaskPanel job={job} task={picked.task} onPick={setSelectedMember} refresh={refresh} />}
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

function WorkspaceSelect({ value, workspaces, onChange, empty }) {
  const t = useT()
  const [custom, setCustom] = useState(() => !!value && !workspaces.items.some(w => w.path === value))
  if (custom) return <input className="ah-input" placeholder={t('launch.path')} value={value || ''} onChange={e => onChange(e.target.value || null)} />
  return (
    <select className="ah-input" value={value || ''} onChange={e => (e.target.value === '\0' ? (setCustom(true), onChange(null)) : onChange(e.target.value || null))}>
      <option value="">{empty}</option>
      {workspaces.items.map(w => <option key={w.workspaceId} value={w.path}>{w.title} — {w.path}</option>)}
      <option value={'\0'}>{t('launch.otherPath')}</option>
    </select>
  )
}

/** A new job: a fresh Lead (the default agent) plans it and assigns pool agents. */
export function NewJob({ workspaces, lead, onStarted, onCancel }) {
  const t = useT()
  const [goal, setGoal] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  const ready = goal.trim() && (cwd || '').trim()
  const start = async () => {
    if (!ready || busy) return
    setBusy(true); setError('')
    try { onStarted((await call('startJob', { goal, cwd })).job) } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return (
    <motion.div className="ah-detail-card ah-team-view" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <div className="ah-team-head">
        <span className="ah-hero-glyph ah-small"><Rocket size={18} /></span>
        <div className="ah-hero-title"><h2>{t('job.new')}</h2><span className="ah-sub">{t('job.newHint', { lead: lead?.name || lead?.id || t('pool.defaultNone') })}</span></div>
      </div>
      <div className="ah-members-editor">
        <label className="ah-field"><span>{t('job.goal')}</span>
          <textarea ref={ref} className="ah-input ah-goal" rows={5} value={goal} placeholder={t('job.goalPh')}
            onChange={e => setGoal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start() }} />
        </label>
        <div className="ah-field-row">
          <label className="ah-field"><span>{t('launch.workspace')}</span>
            <WorkspaceSelect value={cwd} workspaces={workspaces} onChange={v => setCwd(v || '')} empty={t('job.pickWorkspace')} />
          </label>
          <div className="ah-actions"><span className="ah-sub">Ctrl/⌘ + Enter</span>
            {onCancel && <button className="ah-btn" onClick={onCancel}>{t('cancel')}</button>}
            <button className="ah-btn ah-primary ah-big" disabled={!ready || busy} onClick={start}><Rocket size={15} />{busy ? t('launch.going') : t('job.start')}</button></div>
        </div>
        <span className="ah-sub">{t('job.startHint')}</span>
        {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
      </div>
      <div className="ah-tpl-help">
        <Sparkles size={14} />
        <div><b>{t('job.chatTitle')}</b><span>{t('job.chatHint')}</span><code>{'start_agent_job({ task: "…" })'}</code></div>
      </div>
    </motion.div>
  )
}

const download = (filename, data) => {
  // A detached anchor: nothing is inserted into the host page.
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ── the agent pool: a row per agent (what it runs on, whether it can run, how much it is used), its detail beside ──
const usesOf = (uses, id) => uses.filter(u => u.agent === id)
/** Where an agent is used, as the steps of each workflow: "Bug fix › Triage (fallback)" → { Bug fix: [Triage, …] }. */
function byWorkflow(t, list) {
  const out = new Map()
  for (const u of list) {
    const label = L(t, u.where), cut = label.indexOf(' › ')
    const [wf, step] = cut > 0 ? [label.slice(0, cut), label.slice(cut + 3)] : ['', label]
    const key = `${u.by}\u0000${wf}`
    if (!out.has(key)) out.set(key, { by: u.by, wf, steps: [] })
    out.get(key).steps.push({ step, fallback: /\(fallback\)|（备用）/.test(step) })
  }
  return [...out.values()]
}

function AgentRow({ a, uses, isDefault, isMain, needsLogin, selected, onOpen }) {
  const t = useT()
  const n = usesOf(uses, a.id).length
  return (
    <button className={cx('ah-agent-row', selected && 'ah-on')} onClick={onOpen} aria-current={selected || undefined}>
      <Avatar name={a.id} state={a.running ? 'running' : 'idle'} size={32} />
      <span className="ah-agent-row-main">
        <span className="ah-agent-row-name"><b>{a.name || a.id}</b>{a.name && a.name !== a.id && <span className="ah-mono ah-sub">{a.id}</span>}
          {isMain && <span className="ah-badge ah-tone-running" title={t('pool.mainHint')}><Sparkles size={11} />{t('agent.isMain')}</span>}
          {isDefault && <span className="ah-badge ah-tone-done" title={t('pool.defaultHint')}><Star size={11} />{t('agent.isDefault')}</span>}</span>
        <span className="ah-agent-row-meta"><RuntimeBadge runtime={a.runtime} model={a.endpoint ? `${a.endpoint}/${a.model}` : a.model} effort={a.effort} />
          {a.running > 0 ? <span className="ah-state-chip ah-tone-running"><span className="ah-live-dot ah-on" />{t('pool.running', { n: a.running })}</span>
            : needsLogin ? <span className="ah-state-chip ah-tone-waiting"><KeyRound size={11} />{t('pool.needsLogin')}</span>
              : <span className="ah-state-chip ah-tone-done"><span className="ah-dot" />{t('pool.ready')}</span>}</span>
      </span>
      <span className="ah-agent-row-use">{n ? t('pool.usedIn', { n }) : <span className="ah-sub">{t('pool.unused')}</span>}</span>
      <span className="ah-agent-row-stats ah-sub">{a.done + a.failed > 0 && t('pool.stats', { done: a.done, failed: a.failed })}</span>
      <ChevronRight size={15} className="ah-agent-row-go" />
    </button>
  )
}

function AgentDetail({ a, agents, uses, isDefault, isMain, needsLogin, onEdit, onDelete, onRuntimes, onMain }) {
  const t = useT()
  const groups = byWorkflow(t, usesOf(uses, a.id))
  const fb = a.fallback && (agents.find(x => x.id === a.fallback) || { id: a.fallback })
  return (
    <motion.div key={a.id} className="ah-agent-detail" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={spring}>
      <div className="ah-agent-detail-head">
        <Avatar name={a.id} state={a.running ? 'running' : 'idle'} size={42} />
        <div className="ah-agent-names"><h3>{a.name || a.id}</h3>{a.name && a.name !== a.id && <span className="ah-mono ah-sub">{a.id}</span>}</div>
        {isMain && <span className="ah-badge ah-tone-running" title={t('pool.mainHint')}><Sparkles size={11} />{t('agent.isMain')}</span>}
        {isDefault && <span className="ah-badge ah-tone-done" title={t('pool.defaultHint')}><Star size={11} />{t('agent.isDefault')}</span>}
        <span className="ah-grow" />
        {!isMain && onMain && <button className="ah-btn" title={t('pool.mainHint')} onClick={onMain}><Sparkles size={13} />{t('agent.makeMain')}</button>}
        <button className="ah-btn" onClick={onEdit}><Pencil size={13} />{t('agent.edit')}</button>
        <button className="ah-icon-btn" title={t('agent.delete')} aria-label={t('agent.delete')} onClick={onDelete}><Trash2 size={14} /></button>
      </div>
      <div className="ah-node-badges">
        <RuntimeBadge runtime={a.runtime} model={a.endpoint ? `${a.endpoint}/${a.model}` : a.model} effort={a.effort} />
        {a.access && <AccessBadge access={a.access} />}
        {fb && <FallbackBadge fb={fb} />}
      </div>
      {needsLogin && <button className="ah-note ah-tone-waiting ah-note-link" onClick={onRuntimes}><KeyRound size={13} />{t('pool.needsLoginHint')}<ChevronRight size={13} /></button>}
      {a.notes && <p className="ah-agent-notes">{a.notes}</p>}
      <section className="ah-agent-sec">
        <h4>{t('pool.skills')}</h4>
        {a.skills.length ? <div className="ah-wrap">{a.skills.map(s => <span key={s} className="ah-chip"><Wand2 size={11} />{s}</span>)}</div> : <span className="ah-sub">{t('pool.noSkills')}</span>}
      </section>
      <section className="ah-agent-sec">
        <h4>{t('pool.usedBy')}</h4>
        {!groups.length && <span className="ah-sub">{t('pool.unused')}</span>}
        {groups.map(g => (
          <div key={`${g.by}/${g.wf}`} className="ah-agent-use-row">
            <span className="ah-agent-use-wf"><b>{g.wf || g.by}</b>{g.wf && <span className="ah-sub">{g.by}</span>}</span>
            <span className="ah-wrap">{g.steps.map((s, i) => <span key={i} className={cx('ah-chip', s.fallback && 'ah-dim')}>{s.step}</span>)}</span>
          </div>
        ))}
      </section>
      <section className="ah-agent-sec">
        <h4>{t('pool.work')}</h4>
        <div className="ah-metrics">
          {a.running > 0 && <span className="ah-metric ah-tone-running">{t('pool.running', { n: a.running })}</span>}
          {a.done + a.failed > 0 ? <span className="ah-metric">{t('pool.stats', { done: a.done, failed: a.failed })}</span> : !a.running && <span className="ah-sub">{t('pool.noWork')}</span>}
          {a.tokens > 0 && <span className="ah-metric">{t('tokens', { n: kfmt(a.tokens) })}</span>}
          {a.cost > 0 && <span className="ah-metric">${a.cost.toFixed(a.cost < 1 ? 3 : 2)}</span>}
        </div>
      </section>
    </motion.div>
  )
}

/** The rarer pool actions — import, export, the share code — behind one button. */
function MoreMenu({ items }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return
    const off = e => { if (!box.current?.contains(e.target)) setOpen(false) }
    const esc = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', off); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <span className="ah-more" ref={box}>
      <button className="ah-icon-btn ah-ghost-btn" aria-haspopup="menu" aria-expanded={open} title={t('pool.more')} aria-label={t('pool.more')} onClick={() => setOpen(o => !o)}><MoreHorizontal size={16} /></button>
      {open && (
        <div className="ah-more-menu" role="menu">
          {items.map(([Icon, label, fn]) => <button key={label} role="menuitem" onClick={() => { setOpen(false); fn() }}><Icon size={14} />{label}</button>)}
        </div>
      )}
    </span>
  )
}

export function AgentsPage({ hub, env, logins = [], toast, refresh, onImport, onRuntimes, seed, onSeedTaken }) {
  const t = useT()
  const [editing, setEditing] = useState(null) // null | { agent } (a blank one: adding)
  // a draft from elsewhere (an endpoint's "make an agent with it"): the add form, filled in
  useEffect(() => { if (seed) { setEditing({ agent: { ...blankAgent(), ...seed } }); onSeedTaken?.() } }, [seed])
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [pick, setPick] = useState(() => local.get('agentHub.agent', null))
  useEffect(() => { local.set('agentHub.agent', pick) }, [pick])
  const uses = env.uses || []
  const dshAgents = hub.agents.filter(a => a.runtime === 'dsh')
  // (an agent on a model endpoint needs no sign-in of its runtime's own)
  const needsLogin = a => !a.endpoint && logins.some(l => l.runtime === a.runtime)
  const q = query.trim().toLowerCase()
  const rows = hub.agents.filter(a => !q || [a.id, a.name, a.model, a.runtime, a.notes].some(v => v && String(v).toLowerCase().includes(q)))
  const shown = hub.agents.find(a => a.id === pick) || rows[0]
  const setDefault = async id => { setError(''); try { await call('setDefaultAgent', { id: id || null }); refresh(); toast(t('pool.defaultSaved')) } catch (err) { setError(err) } }
  // the main agent (any runtime): Ruyix hands it what the person asks — also chosen in Settings → General
  const mainNow = hub.mainAgent && hub.agents.some(a => a.id === hub.mainAgent) ? hub.mainAgent : hub.defaultAgent
  const setMain = async id => { setError(''); try { await call('mainSet', { agent: id }); refresh(); toast(t('pool.mainSaved')) } catch (err) { setError(err) } }
  const remove = async a => {
    if (!window.confirm(t('agent.deleteConfirm', { id: a.id }))) return
    setError('')
    try { await call('deleteAgent', { id: a.id }); refresh(); toast(t('agent.deleted')) } catch (err) { setError(err) }
  }
  const exportFile = async () => { try { download('agents.agents.json', (await call('exportAgents')).file) } catch (err) { setError(err) } }
  const copyCode = async () => {
    let code
    try { ({ code } = await call('exportAgents')) } catch (err) { setError(err); return }
    try { await navigator.clipboard.writeText(code); toast(t('pool.copied')) } catch { setError(code) }
  }
  return (
    <motion.div className="ah-pool" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <div className="ah-pool-tools">
        <label className="ah-search"><Search size={14} /><input placeholder={t('pool.search')} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQuery('')} /></label>
        <span className="ah-grow" />
        <button className="ah-btn ah-primary" onClick={() => setEditing({ agent: blankAgent() })}><Plus size={13} />{t('agent.new')}</button>
        <MoreMenu items={[[Upload, t('pool.import'), onImport], [Download, t('pool.export'), exportFile], [Copy, t('pool.copyCode'), copyCode]]} />
      </div>
      <div className="ah-default-agent">
        <Star size={15} />
        <div className="ah-default-text"><b>{t('pool.default')}</b><span className="ah-sub">{t('pool.defaultHint')}</span></div>
        <select className="ah-input" value={hub.defaultAgent || ''} onChange={e => setDefault(e.target.value)}>
          <option value="">{t('pool.defaultNone')}</option>
          {dshAgents.map(a => <option key={a.id} value={a.id}>{a.name || a.id} — {a.model || t('model.cliDefault')}</option>)}
        </select>
      </div>
      {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
      <div className="ah-pool-body">
        <div className="ah-agent-list" role="list">
          {rows.map(a => <AgentRow key={a.id} a={a} uses={uses} isDefault={a.id === hub.defaultAgent} isMain={a.id === mainNow} needsLogin={needsLogin(a)} selected={!editing && shown?.id === a.id} onOpen={() => { setEditing(null); setPick(a.id) }} />)}
          {!hub.agents.length && <div className="ah-empty-small">{t('pool.empty')}</div>}
          {hub.agents.length > 0 && !rows.length && <div className="ah-empty-small">{t('emptyFilter')}</div>}
        </div>
        <div className="ah-agent-side">
          <AnimatePresence mode="wait">
            {editing
              ? <motion.div key={`edit-${editing.agent.id || 'new'}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <AgentForm agent={editing.agent} env={env} onRuntimes={onRuntimes} onCancel={() => setEditing(null)} onSaved={a => { setEditing(null); if (a?.id) setPick(a.id); refresh(); toast(t('agent.saved')) }} />
              </motion.div>
              : shown && <AgentDetail key={shown.id} a={shown} agents={hub.agents} uses={uses} isDefault={shown.id === hub.defaultAgent} isMain={shown.id === mainNow} onMain={() => setMain(shown.id)} needsLogin={needsLogin(shown)}
                onEdit={() => setEditing({ agent: shown })} onDelete={() => remove(shown)} onRuntimes={onRuntimes} />}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}

// ── the agent form: its parts ──────────────────────────────────────────────
function ModelSelect({ value, models, onChange, placeholder }) {
  const t = useT()
  const known = !value || models.some(m => `${m.provider}/${m.model}` === value)
  return (
    <select className={cx('ah-input ah-model-select', !known && 'ah-invalid')} value={value || ''} onChange={e => onChange(e.target.value || null)} title={known ? '' : t('model.unknown')}>
      <option value="">{placeholder || t('model.inherit')}</option>
      {!known && <option value={value}>⚠ {value}</option>}
      {models.map(m => <option key={`${m.provider}/${m.model}`} value={`${m.provider}/${m.model}`}>{m.label}</option>)}
    </select>
  )
}

const CLI_MODELS = { claude: ['sonnet', 'opus', 'haiku'] }
function ModelField({ member, env, onChange }) {
  const t = useT()
  if (member.runtime === 'dsh') return <ModelSelect value={member.model} models={env.models} onChange={onChange} />
  // on a model endpoint: one of its models (the ones it listed; another can be written)
  const ep = member.endpoint && (env.endpoints || []).find(e => e.id === member.endpoint)
  if (ep) {
    return (
      <>
        <input className="ah-input ah-mono ah-model-select" list={`ah-ep-${ep.id}`} value={member.model || ''} placeholder={t('model.ofEndpoint', { name: ep.name })} onChange={e => onChange(e.target.value.trim() || null)} />
        <datalist id={`ah-ep-${ep.id}`}>{ep.models.map(m => <option key={m} value={m} />)}</datalist>
      </>
    )
  }
  const suggestions = member.runtime === 'codex' ? [env.clis.codexModel].filter(Boolean) : CLI_MODELS[member.runtime] || []
  const id = `ah-models-${member.runtime}`
  return (
    <>
      <input className="ah-input ah-mono ah-model-select" list={id} value={member.model || ''} onChange={e => onChange(e.target.value.trim() || null)}
        placeholder={member.runtime === 'codex' && env.clis.codexModel ? t('model.cliDefaultNamed', { name: env.clis.codexModel }) : t('model.cliDefault')} />
      <datalist id={id}>{suggestions.map(s => <option key={s} value={s} />)}</datalist>
    </>
  )
}

function Seg({ value, options, onChange, label, disabled = () => false }) {
  return (
    <div className="ah-seg ah-seg-small">
      {options.map(o => (
        <button key={o} type="button" className={cx(value === o && 'ah-on')} disabled={disabled(o)} title={disabled(o) ? label(o, true) : ''} onClick={() => onChange(o)}>{label(o)}</button>
      ))}
    </div>
  )
}

function SkillPicker({ value, skills, onChange }) {
  const t = useT()
  // a skill is named by its ref: "pack/skill" for a versioned pack (portable), the bare name for the workspace's or this machine's
  const byRef = ref => skills.find(s => s.ref === ref) || skills.find(s => s.name === ref && !ref.includes('/'))
  const left = skills.filter(s => !value.includes(s.ref))
  const groups = [...new Set(left.map(s => s.pack || s.kind))]
  return (
    <div className="ah-skills">
      {value.map(ref => {
        const hit = byRef(ref)
        return (
          <span key={ref} className={cx('ah-chip', !hit && 'ah-tone-waiting', hit?.kind === 'local' && 'ah-tone-muted')}
            title={hit ? `${hit.description || hit.name}${hit.version ? ` · ${hit.version}` : ''}${hit.kind === 'local' ? `\n${t('skill.localHint')}` : ''}` : t('skill.missing')}>
            <Wand2 size={11} />{ref}<button className="ah-chip-x" onClick={() => onChange(value.filter(v => v !== ref))} aria-label={t('remove')}>×</button>
          </span>
        )
      })}
      {left.length > 0 && value.length < 10 && (
        <select className="ah-input ah-skill-add" value="" onChange={e => e.target.value && onChange([...value, e.target.value])}>
          <option value="">{t('skill.add')}</option>
          {groups.map(g => (
            <optgroup key={g} label={g === 'workspace' ? t('skill.group.workspace') : g === 'local' ? t('skill.group.local') : t('skill.group.pack', { pack: g })}>
              {left.filter(s => (s.pack || s.kind) === g).map(s => <option key={s.ref} value={s.ref} title={s.description}>{s.name}{s.description ? ` — ${s.description.slice(0, 60)}` : ''}</option>)}
            </optgroup>
          ))}
        </select>
      )}
      {!skills.length && !value.length && <span className="ah-sub">{t('skill.none')}</span>}
    </div>
  )
}

/** An agent: its id (fixed once added), name, what runs (runtime, model, effort), always-full access, skills, notes. */
function AgentForm({ agent, env, onSaved, onCancel, onRuntimes }) {
  const t = useT()
  const fresh = !agent.createdAt
  const [draft, setDraft] = useState(agent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = patch => setDraft(d => ({ ...d, ...patch }))
  const rtLabel = (rt, off) => (off ? t('rt.missing', { name: t(`rt.${rt}`) }) : t(`rt.${rt}`))
  // Without a working Codex sandbox, read/write cannot be enforced: a Codex agent runs with full access.
  const codexLocked = env.clis.codex && env.clis.codexSandbox === false
  const invalid = !NAME.test(draft.id) || draft.id === 'lead' ? t('agent.badId') : draft.endpoint && !draft.model ? t('agent.endpointModel') : ''
  // where its model comes from: the runtime's own sign-in, or a model endpoint whose protocol it takes
  const sources = (env.endpoints || []).filter(e => (env.apis?.[draft.runtime] || []).includes(e.api))
  const save = async () => {
    setBusy(true); setError('')
    try {
      const { id, name, runtime, model, endpoint, effort, access, skills, notes, browser } = draft
      onSaved((await call('saveAgent', { ...(fresh ? {} : { prev: agent.id, expect: agent.revision || 0 }), id, name, runtime, model, endpoint: endpoint || null, effort, access, skills, notes, browser: browser !== false })).agent)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return (
    <div className="ah-members-editor ah-agent-form">
      <div className="ah-field-row">
        <label className="ah-field ah-field-narrow"><span>{t('agent.id')}</span>
          <input className="ah-input ah-mono" disabled={!fresh} value={draft.id} placeholder="opus" onChange={e => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></label>
        <label className="ah-field"><span>{t('agent.name')}</span><input className="ah-input" value={draft.name || ''} placeholder={draft.id} onChange={e => set({ name: e.target.value })} /></label>
      </div>
      {fresh && <span className="ah-sub">{t('agent.idHint')}</span>}
      <div className="ah-mcard-opts ah-agent-opts">
        <label><span>{t('roster.runtime')}</span>
          <Seg value={draft.runtime} options={RUNTIMES} label={rtLabel} disabled={rt => rt !== 'dsh' && !env.clis[rt] && draft.runtime !== rt}
            onChange={runtime => runtime !== draft.runtime && set({ runtime, model: null, effort: null, endpoint: null, ...(runtime === 'codex' && codexLocked ? { access: 'full' } : {}) })} /></label>
        {/* where its model comes from: always asked of a CLI runtime — none to pick yet says where to add one */}
        {draft.runtime !== 'dsh' && (
          <label><span>{t('roster.source')}</span>
            <select className="ah-input ah-model-select" value={draft.endpoint || ''} onChange={e => set({ endpoint: e.target.value || null, model: null })}>
              <option value="">{t(`source.own.${draft.runtime}`)}</option>
              {draft.endpoint && !sources.some(e => e.id === draft.endpoint) && <option value={draft.endpoint}>⚠ {draft.endpoint}</option>}
              {sources.map(e => <option key={e.id} value={e.id}>{e.name} · {t(`ep.api.${e.api}`)}</option>)}
            </select>
            <span className="ah-sub ah-source-hint">{sources.length ? '' : t(`source.none.${draft.runtime}`)}<button type="button" className="ah-linkbtn" onClick={() => window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: 'models' } }))}>{t('source.manage')}</button></span></label>
        )}
        <label><span>{t('roster.model')}</span><ModelField member={draft} env={env} onChange={model => set({ model })} /></label>
        {EFFORTS[draft.runtime] && (
          <label><span>{t('roster.effort')}</span>
            <select className="ah-input ah-effort-select" value={draft.effort || ''} onChange={e => set({ effort: e.target.value || null })}>
              <option value="">{t('effort.default')}</option>
              {EFFORTS[draft.runtime].map(level => <option key={level} value={level}>{level}</option>)}
            </select></label>
        )}
        <label className="ah-check ah-agent-full"><input type="checkbox" checked={draft.access === 'full'} onChange={e => set({ access: e.target.checked ? 'full' : null })} />
          <span><b>{t('agent.fullAccess')}</b><span className="ah-sub">{t('agent.fullAccessHint')}</span></span></label>
        {draft.runtime !== 'dsh' && (
          <label className="ah-check ah-agent-full"><input type="checkbox" checked={draft.browser !== false} onChange={e => set({ browser: e.target.checked })} />
            <span><b>{t('agent.browser')}</b><span className="ah-sub">{t('agent.browserHint')}</span></span></label>
        )}
        <label className="ah-mcard-skills"><span>{t('roster.skills')}</span><SkillPicker value={draft.skills} skills={env.skills} onChange={skills => set({ skills })} /></label>
      </div>
      <label className="ah-field"><span>{t('agent.notes')}</span>
        <textarea className="ah-input" rows={2} value={draft.notes || ''} placeholder={t('agent.notesPh')} onChange={e => set({ notes: e.target.value })} /></label>
      {draft.runtime !== 'dsh' && !env.clis[draft.runtime] && <div className="ah-note ah-tone-waiting">{rtLabel(draft.runtime, true)}</div>}
      {draft.runtime === 'codex' && draft.access !== 'full' && codexLocked && <div className="ah-note ah-tone-error">{t('rt.codexSandbox')}</div>}
      {draft.access === 'full' && <div className="ah-note ah-tone-waiting">{t('access.full.hint')}</div>}
      {(invalid || error) && <div className={cx('ah-note', error ? 'ah-tone-error' : 'ah-tone-waiting')}>{error ? errorText(t, error) : invalid}</div>}
      <div className="ah-actions">
        <button className="ah-btn" onClick={onCancel}>{t('cancel')}</button>
        <button className="ah-btn ah-primary" disabled={busy || !!invalid} onClick={save}><Save size={13} />{fresh ? t('agent.create') : t('agent.save')}</button>
      </div>
    </div>
  )
}

function FallbackBadge({ fb }) {
  const t = useT()
  return <span className="ah-fb-badge" title={t('fb.hint')}>{t('fb.badge', { id: fb.name || fb.id })}</span>
}

export function ImportDialog({ onClose, onImported }) {
  const t = useT()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true); setError('')
    try { onImported(await call('importAgents', { text })) } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return (
    <motion.div className="ah-modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <motion.div className="ah-modal ah-modal-small" role="dialog" aria-modal="true" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={spring}>
        <div className="ah-modal-head">
          <div className="ah-hero-glyph ah-small"><Upload size={18} /></div>
          <div><h2>{t('agent.importTitle')}</h2><span className="ah-sub">{t('agent.importHint')}</span></div>
          <button className="ah-icon-btn" onClick={onClose} aria-label={t('close')}><X size={16} /></button>
        </div>
        <textarea className="ah-input ah-mono ah-import" rows={7} autoFocus value={text} placeholder={'dsh-agents:eyJraW5kIjoi…  /  { "kind": "dsh-agents", … }'} onChange={e => setText(e.target.value)} />
        <label className="ah-btn ah-file-btn"><FileUp size={13} />{t('agent.pickFile')}
          <input type="file" accept=".json,application/json" onChange={async e => { const f = e.target.files?.[0]; if (f) setText(await f.text()) }} />
        </label>
        {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
        <div className="ah-modal-foot">
          <button className="ah-btn" onClick={onClose}>{t('cancel')}</button>
          <button className="ah-btn ah-primary ah-big" disabled={busy || !text.trim()} onClick={submit}><Upload size={15} />{t('agent.importGo')}</button>
        </div>
      </motion.div>
    </motion.div>
  )
}

export function Overview({ onNewJob, onAgents }) {
  const t = useT()
  return (
    <motion.div className="ah-overview" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="ah-hero-glyph"><Bot size={26} /></div>
      <h2>{t('pickHint')}</h2>
      <div className="ah-actions">
        <button className="ah-btn ah-big" onClick={onAgents}><Users size={15} />{t('sec.agents')}</button>
        <button className="ah-btn ah-primary ah-big" onClick={onNewJob}><Plus size={15} />{t('job.new')}</button>
      </div>
    </motion.div>
  )
}
