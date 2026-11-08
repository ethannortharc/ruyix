// Shared visual atoms: avatars with live status rings, the one-line working status,
// metrics, the tool timeline and the message composer.
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import {
  Bot, Brain, CheckCircle2, Circle, FilePen, FilePlus, FileText, Globe, HelpCircle, Hourglass, ListChecks,
  ListTodo, Loader2, MessageSquare, Moon, PauseCircle, Search, Send, ShieldAlert, Sigma, Sparkles, Square, Terminal,
  UserPlus, XCircle, Ban, AlertTriangle, Eye, PenLine, ShieldOff, Network, Code2, Boxes,
} from 'lucide-react'
import { call } from './data.js'

export const T = createContext(key => key)
export const useT = () => useContext(T)

export const cx = (...names) => names.filter(Boolean).join(' ')
// Host errors carry `code` + `params`; show the dictionary entry when this language has one, else the English message.
const coded = (t, code, params, fallback) => {
  const key = code && `err.${code}`
  const text = key && t(key, params || {})
  return text && text !== key ? text : fallback
}
export const errorText = (t, err) => coded(t, err?.code, err?.params, err?.message || String(err))
/** The error stored on a task or job document, in the panel's language. */
export const docError = (t, doc) => coded(t, doc?.errorCode, doc?.errorParams, doc?.error)
export const dur = ms => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}
export const ago = (t, ms) => {
  const s = Math.max(0, ms / 1000)
  const [n, unit] = s < 60 ? [s, 's'] : s < 3600 ? [s / 60, 'm'] : s < 86400 ? [s / 3600, 'h'] : [s / 86400, 'd']
  return t('ago', { d: `${Math.floor(n)}${t(`unit.${unit}`)}` })
}
export const kfmt = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n))

const TOOLS = [
  [/^(read|view|cat)/, 'read', FileText], [/^(edit|str_replace|apply_patch|multi_?edit)/, 'edit', FilePen],
  [/^write/, 'write', FilePlus], [/^(bash|shell|pwsh|exec|run)/, 'bash', Terminal], [/^(glob|grep|search|find|ls|web_search)/, 'search', Search],
  [/^web/, 'web', Globe], [/^(spawn_teammate|create_team)/, 'spawn', UserPlus], [/^send_message/, 'message', MessageSquare],
  [/^(team_|assign_task|cancel_task)/, 'task', ListChecks], [/^wait_/, 'wait', Hourglass], [/^todo/, 'todo', ListTodo],
  [/^ask_user/, 'ask', HelpCircle], [/^(subagent|spawn)/, 'agent', Bot],
]
export const toolInfo = (t, name) => {
  const hit = TOOLS.find(([re]) => re.test(String(name).toLowerCase()))
  return hit ? { verb: t(`tool.${hit[1]}`), Icon: hit[2] } : { verb: name, Icon: Sparkles }
}

export function Avatar({ name, state = 'idle', size = 32, lead }) {
  return (
    <span className={cx('ah-avatar', `ah-ring-${state}`)} style={{ width: size, height: size, fontSize: size * 0.4 }} title={name}>
      <span className="ah-avatar-face">{lead ? '★' : String(name).replace(/^[^a-z0-9]*/i, '').charAt(0).toUpperCase() || '·'}</span>
    </span>
  )
}

const STATE_ICON = { running: Loader2, starting: Loader2, queued: Hourglass, waiting: PauseCircle, done: CheckCircle2, error: XCircle, idle: Moon }
export function StateBadge({ state }) {
  const t = useT()
  const Icon = STATE_ICON[state] || Circle
  return <span className={cx('ah-badge', `ah-tone-${state}`)}><Icon size={12} className={state === 'running' || state === 'starting' ? 'ah-spin' : ''} />{t(`state.${state}`)}</span>
}

/** What the agent is doing right now, in one line. */
export function describe(t, agent, now) {
  const act = agent.act
  const p = agent.pending
  if (p) {
    const label = p.kind === 'approval' ? t('phase.approval') : p.kind === 'plan-review' ? t('phase.review') : t('phase.question')
    return { tone: 'waiting', Icon: p.kind === 'approval' ? ShieldAlert : PauseCircle, label, target: p.toolName || '' }
  }
  if (agent.state === 'starting') return { tone: 'running', Icon: Loader2, spin: true, label: t('state.starting') }
  if (agent.state === 'queued') return { tone: 'idle', Icon: Hourglass, label: t('state.queued'), target: agent.queued > 1 ? t('queued', { n: agent.queued }) : '' }
  if (agent.running) {
    const tool = act?.tools?.at(-1)
    if (tool) {
      const { verb, Icon } = toolInfo(t, tool.name)
      return { tone: 'running', Icon, label: verb, target: tool.target, mono: true, since: tool.at }
    }
    return { tone: 'running', Icon: Brain, pulse: true, label: act?.step ? `${t('phase.thinking')} · ${t('phase.step', { step: act.step })}` : t('phase.thinking'), since: act?.turnStartedAt }
  }
  const end = act?.lastEnd
  if (end) {
    const when = ago(t, now - end.at)
    if (end.kind === 'error') return { tone: 'error', Icon: XCircle, label: t('phase.failed'), target: end.error || when }
    if (end.kind === 'aborted' || end.kind === 'interrupted') return { tone: 'idle', Icon: Square, label: t('phase.stopped'), target: when }
    if (end.kind === 'blocked') return { tone: 'waiting', Icon: Ban, label: t('phase.blocked'), target: when }
    if (end.kind === 'max-tokens') return { tone: 'waiting', Icon: AlertTriangle, label: t('phase.maxTokens'), target: when }
    return { tone: agent.unread ? 'done' : 'idle', Icon: CheckCircle2, label: t('state.done'), target: when }
  }
  return { tone: 'idle', Icon: Moon, label: t('phase.lastActive'), target: agent.updatedAt ? ago(t, now - agent.updatedAt) : '' }
}

export function StatusLine({ agent, now, big }) {
  const t = useT()
  const d = describe(t, agent, now)
  return (
    <div className={cx('ah-status', `ah-tone-${d.tone}`, big && 'ah-status-big')}>
      <d.Icon size={big ? 18 : 14} className={cx('ah-status-icon', d.spin && 'ah-spin', d.pulse && 'ah-breathe')} />
      <span className="ah-status-label">{d.label}</span>
      {d.target && <span className={cx('ah-status-target', d.mono && 'ah-mono')}>{d.target}</span>}
      {d.since && <span className="ah-status-timer">{dur(now - d.since)}</span>}
    </div>
  )
}

const RUNTIME = { dsh: ['dsh', Network], claude: ['Claude Code', Code2], codex: ['Codex', Boxes], pi: ['pi', Sigma] }
export function RuntimeBadge({ runtime, model, effort }) {
  const [label, Icon] = RUNTIME[runtime] || RUNTIME.dsh
  const detail = [model, effort && `@${effort}`].filter(Boolean).join(' ')
  return <span className={cx('ah-rt', `ah-rt-${runtime}`)} title={detail}><Icon size={11} />{label}{detail && <span className="ah-rt-model ah-mono">{detail}</span>}</span>
}
const ACCESS_ICON = { read: Eye, write: PenLine, full: ShieldOff }
export function AccessBadge({ access }) {
  const t = useT()
  const Icon = ACCESS_ICON[access] || Eye
  return <span className={cx('ah-acc', `ah-acc-${access}`)} title={t(`access.${access}.hint`)}><Icon size={11} />{t(`access.${access}`)}</span>
}

export function Metrics({ agent }) {
  const t = useT()
  const s = agent.stats
  return (
    <div className="ah-metrics">
      {s?.turns > 0 && <span className="ah-metric">{t('turns', { turns: s.turns, steps: s.steps })}</span>}
      {agent.tokens > 0 && <span className="ah-metric">{t('tokens', { n: kfmt(agent.tokens) })}</span>}
      {agent.ctxPct !== null && (
        <span className="ah-metric"><span className="ah-meter"><span style={{ width: `${agent.ctxPct}%` }} /></span>{t('ctx', { n: agent.ctxPct })}</span>
      )}
      {agent.cost > 0 && <span className="ah-metric">${agent.cost.toFixed(agent.cost < 1 ? 3 : 2)}</span>}
      {agent.queued > 0 && <span className="ah-metric ah-tone-waiting">{t('queued', { n: agent.queued })}</span>}
      {agent.model && <span className="ah-metric ah-mono">{agent.model}</span>}
    </div>
  )
}

export function Timeline({ agent, now }) {
  const t = useT()
  const act = agent.act
  if (!act || (!act.recent.length && !act.tools.length && !act.said)) return <div className="ah-empty-small">{t('noActivity')}</div>
  const rows = [
    ...act.recent.map((r, i) => ({ key: `r${i}`, ok: r.ok, name: r.name, target: r.target, time: dur(r.ms) })),
    ...(agent.running ? act.tools : []).map(c => ({ key: c.callId, live: true, name: c.name, target: c.target, time: dur(now - c.at) })),
  ]
  return (
    <div className="ah-timeline">
      {rows.map((r, i) => {
        const { verb, Icon } = toolInfo(t, r.name)
        return (
          <motion.div key={r.key} className={cx('ah-tl-row', r.live ? 'ah-tone-running' : r.ok ? 'ah-tone-done' : 'ah-tone-error')}
            initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}>
            <span className="ah-tl-dot"><Icon size={12} /></span>
            <span className="ah-tl-verb">{verb}</span>
            <span className="ah-tl-target ah-mono">{r.target}</span>
            <span className="ah-tl-time">{r.live ? <Loader2 size={11} className="ah-spin" /> : r.ok ? null : <XCircle size={11} />} {r.time}</span>
          </motion.div>
        )
      })}
      {act.said && <div className="ah-said"><Sparkles size={12} /> {act.said}</div>}
    </div>
  )
}

export function Composer({ agent, placeholder, onSent, autoFocus }) {
  const t = useT()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const ref = useRef(null)
  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }) }, [autoFocus])
  const send = async () => {
    if (!value.trim() || busy) return
    setBusy(true); setNote('')
    try {
      const { delivery } = await call('message', { sessionId: agent.id, parentSessionId: agent.parentId, text: value })
      setValue(''); setNote(t(`sent.${delivery}`)); onSent?.()
    } catch (err) {
      setNote(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ah-composer">
      <textarea ref={ref} rows={2} value={value} disabled={busy} placeholder={placeholder || t('replyHint')}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
      <button className="ah-icon-btn ah-primary-btn" disabled={busy || !value.trim()} onClick={send} aria-label={t('send')}>
        {busy ? <Loader2 size={15} className="ah-spin" /> : <Send size={15} />}
      </button>
      {note && <div className="ah-composer-note">{errorText(t, note)}</div>}
    </div>
  )
}
