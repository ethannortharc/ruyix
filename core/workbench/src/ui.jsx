// Small shared pieces: the words (T), class names, durations, status pills, step icons.
import { createContext, useContext, useState } from 'react'
import { Bot, CheckCircle2, Circle, Cog, Copy, FileText, Inbox, Loader2, MinusCircle, XCircle } from 'lucide-react'
import { successOf } from './data.js'

export const T = createContext(key => key)
export const useT = () => useContext(T)
/** The workflows data ({ builtIn, mine, … } of the `workflows` op) for names and success levels. */
export const WorkflowsCtx = createContext(null)
export const useWorkflowData = () => useContext(WorkflowsCtx)
export const cx = (...names) => names.filter(Boolean).join(' ')

/** A server error as words: the locale's `err.<code>` (with the error's params), else its own message. */
export const errorText = (t, err) => {
  const key = err?.code && `err.${err.code}`
  const text = key && t(key, err.params || {})
  return text && text !== key ? text : err?.message || String(err)
}
/** A locale word, or `fallback` when the locale has none. */
export const word = (t, key, fallback) => { const v = t(key); return v === key ? fallback : v }

// the kinds of step a person puts in a workflow (lib/workflows.js) — a base's own steps are not among them
const OWN_STEPS = new Set(['agent', 'model', 'script', 'approval', 'person', 'output', 'branch', 'parallel', 'flow'])
const ownKeys = steps => (Array.isArray(steps) ? steps : []).flatMap(s => [
  ...(OWN_STEPS.has(s?.use) && s.id ? [String(s.id)] : []),
  ...(s?.routes || []).flatMap(r => ownKeys(r?.steps)), ...ownKeys(s?.otherwise?.steps), ...(s?.lanes || []).flatMap(l => ownKeys(l?.steps)),
])
/**
 * The words for one run: a step the person put in its workflow is called by its own title. `stage.<key>` is otherwise
 * looked up across every pack's words — a step of yours keyed `draft` or `review` showed Plume's "Master draft".
 */
export function runT(t, run) {
  const keys = new Set(ownKeys(run?.workflowDef?.steps))
  const own = new Map((run?.stages || []).filter(s => keys.has(s.key) && typeof s.title === 'string' && s.title).map(s => [s.key, s.title]))
  if (!own.size) return t
  return (key, params) => {
    const k = String(key)
    return k.startsWith('stage.') && own.has(k.slice(6)) ? own.get(k.slice(6)) : t(key, params)
  }
}
// the options the engine words itself (a person step's review, a refusal): in the panel's language; any other as it was written
const STD_OPTION = { Approve: 'approve', 'Revise with my notes': 'amend', 'Ask for changes': 'changes', 'Stop the run': 'stop', Rejected: 'rejected' }
/** A decision option's label in words. */
export const optionLabel = (t, label) => (STD_OPTION[label] ? word(t, `opt.${STD_OPTION[label]}`, label) : label)
/** What a decision option does, in words. */
export const optionDoes = (t, o) => (STD_OPTION[o?.label] && o.does ? word(t, `opt.${STD_OPTION[o.label]}.does`, o.does).replace('{step}', o.from ? t(`stage.${o.from}`) : '') : o?.does || '')

/** The workflows data with the built-in workflows' names and descriptions in the panel's words: `workflow.<id>` and
 * `workflow.<id>.desc` in the locale (a pack brings its own in its extension), else what the workflow says itself. */
export const localizeWorkflows = (t, data) => (data ? { ...data, builtIn: data.builtIn.map(b => ({ ...b, title: word(t, `workflow.${b.id}`, b.title), description: word(t, `workflow.${b.id}.desc`, b.description) })) } : data)

// (dates and durations in the page's language — the browser's may be another one: the page says it as it draws)
let pageLang = 'zh'
export const setPageLang = l => { pageLang = l === 'en' ? 'en' : 'zh' }
/** The page's locale for dates. */
export const dateLoc = () => (pageLang === 'en' ? 'en' : 'zh-CN')
export const dur = ms => {
  const s = Math.max(0, Math.floor(ms / 1000)), zh = pageLang === 'zh'
  if (s < 60) return zh ? `${s} 秒` : `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return zh ? `${m} 分 ${s % 60} 秒` : `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h >= 48) return zh ? `${Math.floor(h / 24)} 天` : `${Math.floor(h / 24)}d`
  return zh ? `${h} 小时 ${m % 60} 分` : `${h}h ${String(m % 60).padStart(2, '0')}m`
}
export const when = ts => new Date(ts).toLocaleString(dateLoc(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export const bytes = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

export const ACTIVE = new Set(['queued', 'running', 'waiting'])
export const TONE = { queued: 'muted', running: 'blue', waiting: 'amber', done: 'green', failed: 'red', cancelled: 'muted', interrupted: 'amber' }
/** The colour of a verdict: the workflow's success level is green, failed red, cancelled grey, any other word amber. */
export const verdictTone = (run, data) => {
  const level = run.verdict?.level
  return !level ? TONE[run.status] : level === 'failed' ? 'red' : level === 'cancelled' ? 'muted' : level === successOf(run, data) ? 'green' : 'amber'
}
/** A verdict level in words: the locale's, else the level itself. */
export const verdictText = (t, level) => word(t, `verdict.${level}`, String(level).replace(/_/g, ' '))

export const STAGE_ICON = { intake: Inbox, report: FileText }
export const stageIcon = (key, agent) => STAGE_ICON[key] || (agent ? Bot : Cog)
export const SST_ICON = { pending: Circle, running: Loader2, passed: CheckCircle2, failed: XCircle, skipped: MinusCircle }
export const modelText = m => (m ? [m.runtime === 'claude' ? 'Claude' : m.runtime === 'codex' ? 'Codex' : '', (m.model || m.runtime || '').split('/').pop().replace(/^claude-/, '')].filter(Boolean).join(' ') : '')

export function Pill({ tone, children, spin }) {
  return <span className={cx('wb-pill', `wb-t-${tone}`)}>{spin && <Loader2 size={11} className="wb-spin" />}{children}</span>
}
export const StatusPill = ({ status }) => { const t = useT(); return <Pill tone={TONE[status]} spin={status === 'running'}>{t(`status.${status}`)}</Pill> }
export const VerdictPill = ({ run }) => {
  const t = useT(), data = useWorkflowData()
  return run.verdict?.level ? <Pill tone={verdictTone(run, data)}>{verdictText(t, run.verdict.level)}</Pill> : null
}

export function Copyable({ text, label }) {
  const t = useT()
  const [done, setDone] = useState(false)
  return (
    <button className="wb-btn wb-small" onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      <Copy size={13} />{done ? t('ev.copied') : label || t('ev.copy')}
    </button>
  )
}

/** The name of the workflow a run started on: the person's own (the definition the run kept), else the built-in one's. */
export const workflowName = (run, data) => run.workflowDef?.title || data?.builtIn?.find(b => b.id === run.template)?.title || run.template
/** A run's title: what the request called it, else its workflow's name. */
export const runTitle = (run, data) => run.subject?.title || workflowName(run, data) || run.id
/** When a run last did something: its start, end, resume and its steps' last start or end. */
export const lastActivity = r => Math.max(r.createdAt || 0, r.endedAt || 0, r.resumedAt || 0, ...(r.stages || []).map(s => s.endedAt || s.startedAt || 0))

// ── files ──
const KIND = [['image', /^image\//], ['video', /^video\//], ['audio', /^audio\//], ['text', /^(text\/|application\/(json|xml))/]]
const EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  vtt: 'text/vtt', srt: 'application/x-subrip', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  md: 'text/markdown', txt: 'text/plain', log: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', html: 'text/html', pdf: 'application/pdf' }
export const mimeOfName = name => EXT[String(name).split('.').pop().toLowerCase()] || ''
/** How a file is shown: image | video | audio | markdown | text | file. */
export function fileKind(name, mime) {
  const m = mime && mime !== 'application/octet-stream' ? mime : mimeOfName(name)
  if (m === 'text/markdown') return 'markdown'
  if (m === 'text/html') return 'file' // a page is saved, not shown here
  return KIND.find(([, re]) => re.test(m))?.[0] || 'file'
}
