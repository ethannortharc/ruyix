// The standing conversation's one view: in the shell's chat sheet (a panel along the right edge, open across every
// page — the main way in) and on the Chat page (long reading, search). The record is the workbench's (lib/assistant.js,
// the store's chat table): the newest page first, older ones as the person scrolls up, a jump to an entry found and
// "back to the latest"; while it answers, only what is new. What it came to shows as cards — a run it proposes (the
// person starts it, changes it in the new-run form, or lets it go), a workflow draft (opens in the editor), a run as it
// goes — and what it drew as a board (@ruyix/board). How it is doing for the shell (busy, unread): chat-state.js.
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { AlertTriangle, ArrowDown, Bot, Brain, Check, CheckCircle2, FileText, Undo2, Download, ExternalLink, Languages, LayoutDashboard, ListChecks, Loader2, MessagesSquare, Pencil, Pin, PinOff, Play, Plus, Search, Send, SlidersHorizontal, Sparkles, Square, SquarePen, Trash2, User, Workflow, Wrench, X } from 'lucide-react'
import { Board } from '@ruyix/board'
import { inlineBoard } from '@ruyix/board/inline'
import { CHAT, FLOW, INBOX, NS, OPEN, SETTINGS_TAB, call, loadWorkflows, local, useWbStore, useWorkflows } from './data.js'
import { Cards } from '@ruyix/shell/cards'
import { ITEM_EVENT, REFRESH_EVENT, STATE_EVENT, answerCard } from './chat-state.js'
import { targetFor } from './tr.js'
import { StatusPill, cx, errorText, useT, word } from './ui.jsx'
import { Diff } from './diff.jsx'
export { default as boardCss } from '@ruyix/board/board.css'

const PAGE = 50
const merge = (a, b) => {
  const by = new Map(a.map(i => [i.n, i]))
  for (const i of b) by.set(i.n, i)
  return [...by.values()].sort((x, y) => x.n - y.n)
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString()
const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }))
/** A file the workbench made up (the conversation as Markdown): saved by the browser. */
const download = ({ name, text }) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ── opening the workbench from the conversation: the page through the shell, then the workbench's own open event ──
const PANEL_OF = { approvals: INBOX, notices: INBOX, system: INBOX, runs: NS, metrics: NS, flow: FLOW, settings: SETTINGS_TAB, new: NS, chat: CHAT }
/** Show a view or a run (workbench_show's words; `view: 'new'` the new-run form, filled in). */
export function openWorkbench(detail = {}) {
  const panel = detail.run || detail.id ? NS : PANEL_OF[detail.view]
  if (!panel) return
  fire('ruyix:open', { panel })
  fire(OPEN, detail)
}
const openRun = id => openWorkbench({ run: id })
/** A workflow of the person's in the editor of the Workflows page (open already: it takes the event; else it reads the key). */
const openWorkflow = id => {
  local.set(`${NS}.wfView`, { at: 'edit', kind: 'mine', id })
  openWorkbench({ view: 'flow' })
  fire(`${NS}:needs`, { workflow: id, panel: null })
}

/** The shell's view of how the conversation is doing (chat-state.js), kept current. */
function useLive(live) {
  const [state, setState] = useState(() => live?.snapshot?.() || { busy: false, unread: 0 })
  useEffect(() => {
    const on = e => setState(e.detail || live.snapshot())
    window.addEventListener(STATE_EVENT, on)
    return () => window.removeEventListener(STATE_EVENT, on)
  }, [live])
  return state
}

/**
 * Whether the view is on screen: in the page, not hidden (a closed sheet stays mounted, hidden — the shell marks it
 * aria-hidden and visibility: hidden), the browser tab in front. Read again when the frame around it changes.
 */
function useShown(ref) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const look = () => setShown(el.isConnected && !document.hidden && el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]') && getComputedStyle(el).visibility !== 'hidden')
    look()
    const frame = el.parentElement?.closest('[aria-hidden]')
    const mo = frame && typeof MutationObserver !== 'undefined' ? new MutationObserver(() => { look(); setTimeout(look, 350) }) : null
    mo?.observe(frame, { attributes: true })
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(look) : null
    io?.observe(el)
    document.addEventListener('visibilitychange', look)
    const slow = setInterval(look, 3000) // (a frame that hides it some other way)
    return () => { mo?.disconnect(); io?.disconnect(); document.removeEventListener('visibilitychange', look); clearInterval(slow) }
  }, [])
  return shown
}

/** While the view shows the latest entries on screen, nothing of it counts as unread. */
function useWatching(live, on) {
  useEffect(() => (live && on ? live.watch() : undefined), [live, on])
}

function useChat(live) {
  // detached: a page around one entry (focus: { n, at }), the newer ones waiting for "back to the latest"
  const [s, setS] = useState({ items: [], more: false, running: false, model: null, agent: null, tasks: [], ready: false, detached: false, focus: null })
  const [error, setError] = useState(null)
  const [awaiting, setAwaiting] = useState(null) // a message sent, not yet in the record
  const cur = useRef(s)
  cur.current = s
  /** What is new (→ the newest entry's number known now). */
  const newer = async () => {
    const x = cur.current
    if (x.detached) return x.items.at(-1)?.n || 0
    try {
      const last = x.items.at(-1)?.n
      const r = await call('chat', { ...(last ? { after: last } : { limit: PAGE }), cards: x.items.filter(i => ['draft', 'runop', 'workflow', 'action', 'cards'].includes(i.kind)).map(i => i.n) })
      r.items = merge(r.items, r.changed || [])
      const items = merge(x.items, r.items)
      cur.current = { ...cur.current, items }
      setS(y => ({ ...y, items: merge(y.items, r.items), more: y.ready ? y.more : r.more, running: r.running, model: r.model, agent: r.agent || null, pick: r.pick || null, main: r.main || null, tasks: r.tasks || y.tasks, ready: true }))
      setError(null)
      return items.at(-1)?.n || 0
    } catch (err) { setError(err); return x.items.at(-1)?.n || 0 }
  }
  const older = async () => {
    const x = cur.current
    if (!x.more || !x.items.length) return
    try { const r = await call('chat', { before: x.items[0].n, limit: PAGE }); setS(y => ({ ...y, items: merge(r.items, y.items), more: r.more })) } catch (err) { setError(err) }
  }
  /** The page around one entry (a search's find): newer ones wait for "back to the latest". */
  const around = async n => {
    try { const r = await call('chat', { before: n + Math.floor(PAGE / 2), limit: PAGE }); setS(y => ({ ...y, items: r.items, more: r.more, running: r.running, model: r.model, ready: true, detached: true, focus: { n, at: Date.now() } })) } catch (err) { setError(err) }
  }
  const latest = async () => { setS(y => ({ ...y, items: [], detached: false, focus: null, ready: false })); cur.current = { ...cur.current, items: [], detached: false }; return newer() }
  useEffect(() => {
    newer()
    // a message went out from elsewhere (the shell's palette, the other view): read it now; one that did not go out, say so
    const again = e => { if (e.detail?.error) { setError(e.detail.error); setAwaiting(null) } cur.current.detached ? latest() : newer() }
    window.addEventListener(REFRESH_EVENT, again)
    return () => window.removeEventListener(REFRESH_EVENT, again)
  }, [])
  // what is new: quickly while it answers, now and then otherwise (a card taken elsewhere, another tab's message)
  useEffect(() => {
    const working = s.tasks.some(x => ['queued', 'running'].includes(x.status)) // (a background task: its card and its conclusion)
    const t = setInterval(newer, s.running || awaiting ? 1500 : working ? 4000 : 15000)
    return () => clearInterval(t)
  }, [s.running, !!awaiting, s.detached, s.tasks.some(x => ['queued', 'running'].includes(x.status))])
  useEffect(() => {
    if (awaiting && (s.items.some(i => i.kind === 'user' && i.n > awaiting.after) || Date.now() - awaiting.at > 600e3)) setAwaiting(null)
  }, [s.items, awaiting])
  // (`re`: the question it goes on — a card's reply lands on its question, docs/design/desk-answers.md)
  const send = async (text, re = null) => {
    try {
      const after = cur.current.detached ? await latest() : cur.current.items.at(-1)?.n || 0
      setAwaiting({ text, after, at: Date.now() })
      await live.ask(text, undefined, { re })
      return true
    } catch (err) { setError(err); setAwaiting(null); return false }
  }
  const replace = item => setS(y => ({ ...y, items: y.items.map(i => (i.n === item.n ? item : i)) }))
  return { ...s, error, awaiting, newer, older, latest, jump: around, send, replace, setError }
}

/** A run as it goes (the workbench's store): its state and the step it is at. */
function RunState({ id }) {
  const [store] = useWbStore()
  const r = store.run.get(id)
  if (!r) return null
  const step = r.stages?.find(x => x.key === r.stage)
  return <><StatusPill status={r.status} />{r.stage && ['running', 'waiting'].includes(r.status) && <span className="wb-sub">{step?.title || r.stage}</span>}</>
}

/** One answer; the 译 button swaps in its translation (and back). */
export function Answer({ text }) {
  const t = useT()
  const trTo = targetFor(text)
  const [shown, setShown] = useState(null)
  const [busy, setBusy] = useState(false)
  const labels = { code: { copyLabel: t('ev.copy'), copiedLabel: t('ev.copied') }, footnotes: 'Footnotes' }
  const toggle = async () => {
    if (shown) { setShown(null); return }
    setBusy(true)
    try { const r = await call('translate', { texts: [text], lang: trTo }); setShown(r.texts[0]) } catch (err) { setShown(`⚠ ${err.message}`) }
    setBusy(false)
  }
  return (
    <div className="wb-msg-bot">
      <MarkdownText text={shown || text} labels={labels} variant="compact" />
      <button className="wb-tr-btn" onClick={toggle} disabled={busy} title={shown ? t('tr.original') : t('tr.to', { lang: trTo === 'zh' ? '中文' : 'English' })}>
        {busy ? <Loader2 size={11} className="wb-spin" /> : <Languages size={11} />}{shown ? t('tr.original') : trTo === 'zh' ? '译中' : 'EN'}
      </button>
    </div>
  )
}

/** A run of tool calls as one line of chips (the same tool in a row: once, counted). */
/** What the main agent did through a system tool: its line, who, when, and its undo (until undone). */
export function ActionLine({ item, onDone, compact = false, lang = 'en' }) {
  const t = useT()
  const [busy, setBusy] = useState(false), [err, setErr] = useState('')
  const said = x => (x && typeof x === 'object' ? x[lang] || x.en || '' : String(x || ''))
  const undo = async () => {
    setBusy(true); setErr('')
    try { const r = await call('chatUndo', { n: item.n }); onDone?.(r) } catch (e) { setErr(e?.message || String(e)) } finally { setBusy(false) }
  }
  return (
    <div className={cx('wb-chat-event wb-action', item.undone && 'wb-action-undone', compact && 'wb-action-compact')}>
      {item.undoes ? <Undo2 size={12} /> : <Check size={12} />}
      <span className="wb-chat-event-text">{said(item.summary)}{!compact && item.by && item.by !== 'person' && <span className="wb-sub"> · {item.by}</span>}</span>
      {item.undo && !item.undone && <button className="wb-linkbtn" disabled={busy} onClick={undo}><Undo2 size={12} />{t('ch.undo')}</button>}
      {item.undone && <span className="wb-sub">{t('ch.undone')}</span>}
      {err && <span className="wb-t-red wb-sub">{err}</span>}
    </div>
  )
}

function ToolChips({ tools }) {
  const groups = []
  for (const x of tools) {
    const last = groups.at(-1)
    if (last?.name === x.name) last.items.push(x)
    else groups.push({ name: x.name, items: [x] })
  }
  return (
    <div className="wb-tools">
      {groups.map(({ name, items }, i) => (
        <span key={i} className="wb-tool" title={items.map(x => x.target).filter(Boolean).join('\n')}>
          <Wrench size={11} /> {String(name || '').replace(/^workbench_/, '')}{items.length > 1 ? <i>×{items.length}</i> : items[0].target && <i>{items[0].target}</i>}
        </span>
      ))}
    </div>
  )
}

// a view's name in the person's words
const VIEW_WORD = { approvals: 'sec.approvals', notices: 'sec.notices', system: 'sec.system', runs: 'nav.runs', metrics: 'nav.metrics', flow: 'nav.workflows', settings: 'tab.settings' }
/** What workbench_show pointed at: a link (the sheet also opened it when it was said). */
function ShowLink({ args }) {
  const t = useT()
  if (!args.run && !args.view) return null
  const label = args.run ? `${t('ch.openRun', { run: args.run })}${args.tab ? ` · ${t(`tab.${args.tab}`)}` : ''}` : t('ch.openView', { view: word(t, VIEW_WORD[args.view] || '', args.view) })
  return <button className="wb-chat-show" onClick={() => openWorkbench(args.run ? { run: args.run, ...(args.tab && { tab: args.tab }) } : { view: args.view })}><LayoutDashboard size={12} />{label}</button>
}

/** Whatever a drawn board throws while it renders stays with it. */
class Contained extends Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? null : this.props.children }
}
/** A board the conversation drew (workbench_ui): its data in hand, drawn by the one renderer. One that does not check is not drawn (the assistant was told why). */
export function GenUI({ args, lang = 'en' }) {
  const b = useMemo(() => { try { return inlineBoard(args) } catch { return { errors: [{}] } } }, [args])
  if (b.errors.length) return null
  return (
    <Contained>
      <div className="wb-genui">
        {typeof args?.title === 'string' && args.title && <h4>{args.title.slice(0, 200)}</h4>}
        <Board spec={b.spec} datasets={b.datasets} snapshots={b.snapshots} history={b.history} lang={lang} tabs={false} />
      </div>
    </Contained>
  )
}

/** A run the conversation came to: what it would be, and the person's choice — then the run as it goes. */
function RunCard({ item, onDone }) {
  const t = useT()
  const a = item.args || {}
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [wf] = useWorkflows()
  const name = word(t, `workflow.${a.workflow}`, wf?.builtIn?.find(b => b.id === a.workflow)?.title || wf?.mine?.find(d => d.id === a.workflow)?.title || a.workflow)
  const done = item.outcome
  const start = async () => {
    setBusy('start'); setError('')
    try {
      const r = await call('chatDraftStart', { n: item.n })
      const { run } = r
      onDone(r)
      openRun(run.id)
    } catch (err) { setError(errorText(t, err)) }
    setBusy('')
  }
  const letGo = async () => {
    setBusy('dismiss'); setError('')
    try { onDone(await call('chatDraftDone', { n: item.n, status: 'dismissed' })) } catch (err) { setError(errorText(t, err)) }
    setBusy('')
  }
  // "change it": the new-run form, filled in — a run started there settles this card too (main.jsx)
  const edit = () => openWorkbench({ view: 'new', workflow: a.workflow, title: a.title || '', text: a.text || '', fields: a.fields || {}, note: a.note || '', card: item.n })
  return (
    <div className={cx('wb-draft', done && 'wb-draft-done')}>
      <div className="wb-draft-head">
        <span className="wb-draft-icon"><Play size={13} /></span>
        <b>{a.title || t('ch.card.untitled')}</b>
      </div>
      <div className="wb-draft-meta"><span>{name}</span>{Object.entries(a.fields || {}).slice(0, 6).map(([k, v]) => <span key={k}>{k}: {Array.isArray(v) ? v.join(', ') : String(v)}</span>)}</div>
      {a.text && <p className="wb-draft-summary">{a.text}</p>}
      {error && <div className="wb-note wb-t-red">{error}</div>}
      {done ? (
        <div className="wb-draft-state">
          {done.status === 'started'
            ? <><CheckCircle2 size={13} />{t('ch.card.started', { run: done.run })}<RunState id={done.run} /><button className="wb-linkbtn" onClick={() => openRun(done.run)}><ExternalLink size={12} />{t('ch.card.open')}</button></>
            : done.status === 'scheduled' ? t('ch.card.scheduled') : t('ch.card.letGo')}
        </div>
      ) : (
        <div className="wb-draft-actions">
          <button className="wb-btn wb-primary" disabled={!!busy} onClick={start}>{busy === 'start' ? <Loader2 size={13} className="wb-spin" /> : <Play size={13} />}{t('ch.card.start')}</button>
          <button className="wb-btn" disabled={!!busy} onClick={edit}><Pencil size={13} />{t('ch.card.edit')}</button>
          <button className="wb-btn wb-quiet" disabled={!!busy} onClick={letGo}><X size={13} />{t('ch.card.dismiss')}</button>
        </div>
      )}
    </div>
  )
}

/**
 * A change to a run the assistant proposed — back to before a step, a file's change, on from a step: what it would do
 * (the files that change back, the difference), and the person's choice. Applied here, by them; never by the assistant.
 */
function RunOpCard({ item, onDone }) {
  const t = useT()
  const a = item.args || {}
  const [{ run: runs }] = useWbStore()
  const run = runs.get(a.run)
  const [peek, setPeek] = useState(null) // rewind: { files } — edit: { diff, blob, added, removed }
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const done = item.outcome
  const step = k => (k ? word(t, `stage.${k}`, run?.stages?.find(s => s.key === k)?.title || k) : '')
  useEffect(() => {
    if (done || !run) return
    if (a.op === 'rewind') call('rewindPreview', { id: a.run, from: a.step }).then(setPeek, err => setError(errorText(t, err)))
    if (a.op === 'edit' && !a.cut) call('editPreview', { id: a.run, path: a.path, content: a.content || '' }).then(setPeek, err => setError(errorText(t, err)))
  }, [item.n, !!run, !!done])
  const apply = async () => {
    setBusy('apply'); setError('')
    try {
      onDone(await call('chatRunOpApply', { n: item.n, expect: peek && { tree: peek.tree, target: peek.target }, blob: peek?.blob ?? null }))
      openRun(a.run)
    } catch (err) { setError(errorText(t, err)) }
    setBusy('')
  }
  const letGo = async () => {
    setBusy('dismiss'); setError('')
    try { onDone(await call('chatRunOpDone', { n: item.n, status: 'dismissed' })) } catch (err) { setError(errorText(t, err)) }
    setBusy('')
  }
  const title = a.op === 'rewind' ? t('ch.op.rewind', { step: step(a.step) }) : a.op === 'continue' ? t('ch.op.continue', { step: step(a.step) }) : t('ch.op.edit', { path: a.path })
  const Icon = a.op === 'rewind' ? Undo2 : a.op === 'continue' ? Play : FileText
  return (
    <div className={cx('wb-draft', done && 'wb-draft-done')}>
      <div className="wb-draft-head"><span className="wb-draft-icon"><Icon size={13} /></span><b>{title}</b></div>
      <div className="wb-draft-meta">
        <span>{t('ch.op.run', { title: run?.subject?.title || a.run })}</span>
        {a.op === 'edit' && a.then && <span>{t('ch.op.then', { step: step(a.then) })}</span>}
        {run && !done && ['queued', 'running', 'waiting'].includes(run.status) && a.op !== 'edit' && <span className="wb-c-amber">{t('ver.stopsFirst')}</span>}
      </div>
      {a.why && <p className="wb-draft-summary">{a.why}</p>}
      {a.op === 'continue' && a.note && <p className="wb-draft-summary"><b>{t('ver.note')}</b> {a.note}</p>}
      {!done && a.op === 'rewind' && peek && (peek.files.length
        ? <ul className="wb-ver-files wb-ver-files-scroll">{peek.files.map(f => <li key={f.path}><span className={cx('wb-ver-act', `wb-ver-act-${f.action}`)}>{t(`ver.a.${f.action}`)}</span><span className="wb-mono">{f.path}</span></li>)}</ul>
        : <p className="wb-sub">{t('ver.rewindNoFiles')}</p>)}
      {!done && a.op === 'rewind' && peek?.kept?.length > 0 && <div className="wb-note wb-t-amber">{t('ver.keptAside', { n: peek.kept.length })} <span className="wb-mono">{peek.kept.slice(0, 6).join(', ')}{peek.kept.length > 6 ? ' …' : ''}</span></div>}
      {!done && a.op === 'edit' && (a.cut ? <div className="wb-note wb-t-red">{t('ch.op.cut')}</div> : peek && <div className="wb-runop-diff"><Diff text={peek.diff} label={a.path} /></div>)}
      {!run && !done && <div className="wb-note wb-t-muted">{t('err.noRun', { id: a.run })}</div>}
      {error && <div className="wb-note wb-t-red">{error}</div>}
      {done ? (
        <div className="wb-draft-state">{['applied', 'partial'].includes(done.status) ? <><CheckCircle2 size={13} />{t(done.status === 'partial' ? 'ch.op.partial' : 'ch.op.applied')}<button className="wb-linkbtn" onClick={() => openRun(a.run)}><ExternalLink size={12} />{t('ch.card.open')}</button></> : t('ch.card.letGo')}</div>
      ) : (
        <div className="wb-draft-actions">
          <button className="wb-btn wb-primary" disabled={!!busy || !run || a.cut || (a.op !== 'continue' && !peek)} onClick={apply}>{busy === 'apply' ? <Loader2 size={13} className="wb-spin" /> : <Icon size={13} />}{t('ch.op.apply')}</button>
          {run && <button className="wb-btn" disabled={!!busy} onClick={() => openRun(a.run)}><ExternalLink size={13} />{t('ch.card.open')}</button>}
          <button className="wb-btn wb-quiet" disabled={!!busy} onClick={letGo}><X size={13} />{t('ch.card.dismiss')}</button>
        </div>
      )}
    </div>
  )
}

/** A background task: a card while it runs (it can be called off here), the conclusion when it ends. */
function TaskCard({ item, tasks, onChange }) {
  const t = useT()
  const status = item.ended ? item.status : tasks?.find(x => x.id === item.task)?.status || item.status
  const open = ['queued', 'running'].includes(status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stop = async () => {
    setBusy(true); setError('')
    try { await call('taskStop', { id: item.task }); onChange() } catch (err) { setError(errorText(t, err)) }
    setBusy(false)
  }
  const labels = { code: { copyLabel: t('ev.copy'), copiedLabel: t('ev.copied') }, footnotes: 'Footnotes' }
  return (
    <div className={cx('wb-draft', 'wb-task', !open && 'wb-draft-done')}>
      <div className="wb-draft-head">
        <span className="wb-draft-icon">{open ? <Loader2 size={13} className="wb-spin" /> : <ListChecks size={13} />}</span>
        <b>{item.title}</b><StatusPill status={status} />
      </div>
      <div className="wb-draft-meta"><span className="wb-tag">{t('ch.task.tag')}</span>{!item.ended && <span>{t(open ? 'ch.task.hint' : 'ch.task.over')}</span>}</div>
      {item.ended && item.result && <div className="wb-task-result"><MarkdownText text={item.result} labels={labels} variant="compact" /></div>}
      {error && <div className="wb-note wb-t-red">{error}</div>}
      {!item.ended && open && <div className="wb-draft-actions"><button className="wb-btn wb-quiet" disabled={busy} onClick={stop}><Square size={13} />{t('ch.task.stop')}</button></div>}
    </div>
  )
}

/** A workflow the assistant saved as a draft: how it stands now, and its editor (where the person enables it). */
function WorkflowCard({ item, onDone }) {
  const t = useT()
  const a = item.args || {}
  const [wf] = useWorkflows()
  const [busy, setBusy] = useState(false), [err, setErr] = useState(null)
  useEffect(() => { loadWorkflows(true) }, []) // (saved just now: the shared list may not have it yet)
  const mine = wf?.mine?.find(d => d.id === a.id)
  // (a card asking the person to enable it — workflow_enable: only their click does)
  const enable = () => { setBusy(true); call('chatWorkflowEnable', { n: item.n }).then(r => { setErr(null); onDone?.(r); loadWorkflows(true) }, setErr).finally(() => setBusy(false)) }
  return (
    <div className="wb-draft wb-draft-done">
      <div className="wb-draft-head">
        <span className="wb-draft-icon"><Workflow size={13} /></span>
        <b>{mine?.title || a.title || a.id}</b>
      </div>
      <div className="wb-draft-meta">
        <span>{t('ch.wf.title')}</span><span className="wb-mono">{a.id}</span>{a.steps > 0 && <span>{t('ch.wf.steps', { n: a.steps })}</span>}
        {wf && <span className={cx(mine?.status === 'enabled' && 'wb-c-green')}>{mine ? t(mine.status === 'enabled' ? 'ch.wf.enabled' : 'ch.wf.draft') : t('ch.wf.gone')}</span>}
      </div>
      {mine && <div className="wb-draft-actions">
        {a.enable && !item.outcome && mine.status !== 'enabled' && <button className="wb-btn wb-primary" disabled={busy} onClick={enable}><Check size={13} />{t('ch.wf.enable')}</button>}
        <button className="wb-btn" onClick={() => openWorkflow(a.id)}><Workflow size={13} />{t('ch.wf.open')}</button>
      </div>}
      {err && <div className="wb-note wb-t-red"><AlertTriangle size={13} /> {errorText(t, err)}</div>}
    </div>
  )
}

/** The words a found entry shows: a message, a card's title and request, a workflow, a change. */
/**
 * Cards the assistant answered with (its ui_card, @ruyix/shell/cards): a choice's pick goes out as the person's reply; 好了 /
 * 再改 is their word on the task — kept on the entry either way, so a reload does not ask again.
 */
export function ChatCards({ item, lang, onDone, send }) {
  const t = useT()
  const [err, setErr] = useState(null)
  const onAnswer = a => answerCard({ call, item, answer: a, lang, send }).then(r => { setErr(null); onDone(r) }, setErr)
  // (its task was deleted: nothing to answer any more)
  if (item.gone) return <div className="wb-chat-cards wb-chat-gone"><span className="wb-sub">{[item.cards.map(c => c.title || c.question || c.text || '').filter(Boolean).join(' · '), t('ch.taskGone')].filter(Boolean).join(' — ')}</span></div>
  return (
    <div className="wb-chat-cards">
      {/* (keyed by its answers: one given elsewhere — a leaf of the desk — is drawn as given) */}
      <Cards key={JSON.stringify(item.answered || {})} cards={item.cards} lang={lang} onAnswer={onAnswer} answered={item.answered || {}} />
      {err && <div className="wb-note wb-t-red"><AlertTriangle size={13} /> {errorText(t, err)}</div>}
    </div>
  )
}

const wordsOf = i => (i.kind === 'draft' ? [i.args?.title, i.args?.text].filter(Boolean).join(' · ') : i.kind === 'runop' ? [i.args?.run, i.args?.step, i.args?.path, i.args?.note, i.args?.why].filter(Boolean).join(' · ') : i.kind === 'task' ? [i.title, i.result].filter(Boolean).join(' · ') : i.kind === 'workflow' ? `${i.args?.title || ''} (${i.args?.id || ''})`
  : i.kind === 'run' ? `${i.args?.run || ''} ${i.args?.title || ''}` : i.kind === 'change' ? i.args?.summary : i.kind === 'cards' ? (i.cards || []).map(c => c.question || c.text || c.title || c.name || '').join(' · ') : i.text) || ''
/** The part of `text` around `q`, the match marked. */
function Snippet({ text, q }) {
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return <span>{text.slice(0, 120)}</span>
  const from = Math.max(0, at - 40), to = Math.min(text.length, at + q.length + 70)
  return <span>{from > 0 && '…'}{text.slice(from, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length, to)}{to < text.length && '…'}</span>
}

/** Search the record: entries that mention words (newest first); one opens the page at it. */
function ChatSearch({ onJump, lang, autoFocus = false, onClose }) {
  const t = useT()
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)
  const [error, setError] = useState('')
  const box = useRef(null)
  useEffect(() => {
    const text = q.trim()
    if (!text) { setFound(null); return }
    let alive = true
    const timer = setTimeout(() => call('chatSearch', { q: text, limit: 40 }).then(r => { if (alive) { setFound(r.items); setError('') } }, err => alive && setError(errorText(t, err))), 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [q])
  useEffect(() => {
    if (!found) return
    const away = e => { if (!box.current?.contains(e.target)) setFound(null) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [!!found])
  const go = i => { onJump(i.n); setFound(null) }
  const when = at => new Date(at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const Icon = { user: User, text: Bot, draft: Play, runop: Undo2, workflow: Workflow, run: Play, change: SlidersHorizontal, task: ListChecks }
  const clear = () => { setQ(''); setFound(null); onClose?.() }
  return (
    <div className="wb-chat-search" ref={box}>
      <Search size={14} />
      <input autoFocus={autoFocus} value={q} placeholder={t('ch.search')} aria-label={t('ch.search')} onChange={e => setQ(e.target.value)} onFocus={() => q.trim() && call('chatSearch', { q: q.trim(), limit: 40 }).then(r => setFound(r.items), () => {})}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); clear() } if (e.key === 'Enter' && !e.nativeEvent.isComposing && found?.[0]) go(found[0]) }} />
      {(q || onClose) && <button className="wb-icon-btn" aria-label={t('close')} onClick={clear}><X size={13} /></button>}
      {(found || error) && (
        <div className="wb-chat-found" role="listbox" aria-label={t('ch.search')}>
          {error ? <div className="wb-note wb-t-red">{error}</div>
            : !found.length ? <div className="wb-sub wb-chat-found-none">{t('ch.noResults')}</div>
              : <>
                <div className="wb-sub wb-chat-found-head">{t('ch.results', { n: found.length })}</div>
                {found.map(i => { const I = Icon[i.kind] || Sparkles; return (
                  <button key={i.n} role="option" aria-selected={false} className="wb-chat-hit" onClick={() => go(i)}>
                    <I size={13} /><span className="wb-chat-hit-text"><Snippet text={wordsOf(i)} q={q.trim()} /></span><span className="wb-sub">{when(i.at)}</span>
                  </button>) })}
              </>}
        </div>
      )}
    </div>
  )
}

const RUNTIME_NAMES = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', dsh: 'dsh' }
/**
 * Who answers this conversation: the main agent (Settings → General, or the agent pool), or — for this conversation
 * only — a dsh model or a Claude Code / Codex / pi agent of the pool ("agent:<id>"); the next conversation is the main agent's again.
 */
function AgentPick({ chat, disabled }) {
  const t = useT()
  const [models, setModels] = useState([])
  const [agents, setAgents] = useState([])
  useEffect(() => { call('models').then(r => setModels(r.models), () => {}); call('chatAgents').then(r => setAgents(r.agents), () => {}) }, [])
  const choose = async v => {
    try {
      if (!v) await call('setChatAgent', { agent: null })
      else if (v.startsWith('agent:')) await call('setChatAgent', { agent: v.slice(6) })
      else await call('setChatModel', { model: v })
      chat.newer()
    } catch (err) { chat.setError(err) }
  }
  if (!models.length && !agents.length) return null
  const p = chat.pick, m = chat.main
  const mainLabel = m ? t('ch.mainAgent', { name: m.name, runtime: RUNTIME_NAMES[m.runtime] || m.runtime }) : t('set.dshDefault')
  return (
    <select className={`wb-input wb-model${p ? ' wb-model-picked' : ''}`} value={p ? (p.agent ? `agent:${p.agent}` : p.model) : ''} disabled={disabled}
      title={p ? t('ch.pickedHint') : t('ch.agentHint')} aria-label={t('ch.agent')} onChange={e => choose(e.target.value)}>
      <option value="">{p ? t('ch.backToMain', { label: mainLabel }) : mainLabel}</option>
      <optgroup label={t('ch.dshModels')}>{models.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>
      {agents.length > 0 && <optgroup label={t('ch.cliAgents')}>{agents.map(a => <option key={a.id} value={`agent:${a.id}`}>{a.name} · {RUNTIME_NAMES[a.runtime] || a.runtime}{a.model ? ` · ${a.model}` : ''}</option>)}</optgroup>}
    </select>
  )
}

/** What the conversations kept: found by words, added by hand, changed, pinned (told first), let go. */
function MemoryDrawer({ onClose }) {
  const t = useT()
  const [q, setQ] = useState('')
  const [items, setItems] = useState(null)
  const [text, setText] = useState('')
  const [kind, setKind] = useState('fact')
  const [editing, setEditing] = useState(null) // { id, text }
  const [error, setError] = useState('')
  const load = () => call('memories', { q: q.trim() }).then(r => { setItems(r.items); setError('') }, err => setError(errorText(t, err)))
  useEffect(() => { const timer = setTimeout(load, 200); return () => clearTimeout(timer) }, [q])
  const act = p => p.then(load, err => setError(errorText(t, err)))
  const add = () => { if (text.trim()) act(call('memorySave', { text: text.trim(), kind }).then(() => setText(''))) }
  const save = () => { const e = editing; setEditing(null); if (e?.text.trim()) act(call('memorySave', { id: e.id, text: e.text.trim() })) }
  return (
    <div className="wb-drawer-wrap" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }} onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
      <div className="wb-drawer wb-mem" role="dialog" aria-label={t('mem.title')}>
        <div className="wb-drawer-head"><Brain size={16} /><h3>{t('mem.title')}</h3>
          <button className="wb-icon-btn" aria-label={t('close')} onClick={onClose}><X size={16} /></button></div>
        <div className="wb-drawer-body">
          <p className="wb-sub">{t('mem.hint')}</p>
          <div className="wb-mem-add">
            <input className="wb-input" value={text} placeholder={t('mem.placeholder')} aria-label={t('mem.placeholder')} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add() }} />
            <select className="wb-input" value={kind} aria-label={t('mem.kind')} onChange={e => setKind(e.target.value)}>{['preference', 'fact', 'decision'].map(k => <option key={k} value={k}>{t(`mem.kind.${k}`)}</option>)}</select>
            <button className="wb-btn wb-primary" disabled={!text.trim()} onClick={add}><Plus size={13} />{t('mem.add')}</button>
          </div>
          <div className="wb-chat-search wb-mem-search"><Search size={14} /><input value={q} placeholder={t('mem.search')} aria-label={t('mem.search')} onChange={e => setQ(e.target.value)} /></div>
          {error && <div className="wb-note wb-t-red">{error}</div>}
          {items && !items.length && <div className="wb-sub wb-mem-none">{t(q.trim() ? 'ch.noResults' : 'mem.none')}</div>}
          <ul className="wb-mem-list">
            {items?.map(m => (
              <li key={m.id} className={cx(m.pinned && 'wb-mem-pinned')}>
                <span className="wb-tag">{t(`mem.kind.${m.kind}`)}</span>
                {editing?.id === m.id
                  ? <input className="wb-input" autoFocus value={editing.text} aria-label={t('mem.edit')} onChange={e => setEditing({ id: m.id, text: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) save(); if (e.key === 'Escape') { e.stopPropagation(); setEditing(null) } }} onBlur={save} />
                  : <span className="wb-mem-text">{m.text}</span>}
                <button className="wb-icon-btn" title={t('mem.edit')} aria-label={t('mem.edit')} onMouseDown={e => e.preventDefault()} onClick={() => (editing?.id === m.id ? save() : setEditing({ id: m.id, text: m.text }))}><Pencil size={14} /></button>
                <button className="wb-icon-btn" title={t(m.pinned ? 'mem.unpin' : 'mem.pin')} aria-label={t(m.pinned ? 'mem.unpin' : 'mem.pin')} onClick={() => act(call('memorySave', { id: m.id, pinned: !m.pinned }))}>{m.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
                <button className="wb-icon-btn" title={t('mem.delete')} aria-label={t('mem.delete')} onClick={() => act(call('memoryDelete', { id: m.id }))}><Trash2 size={14} /></button>
                <span className="wb-sub">{t(`mem.by.${m.by}`)} · {new Date(m.created).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

/**
 * The conversation. `variant`: 'sheet' (the shell's chat sheet: fills its box, transparent, its own scroll, the input at
 * the bottom; a workbench_show said now opens that page) or 'page' (the Chat page: a header with the search). `live`:
 * chat-state.js's instance; `onClose`: Esc in the sheet.
 */
export function Conversation({ variant = 'sheet', lang = 'en', live, onClose }) {
  const t = useT()
  const sheet = variant === 'sheet'
  const chat = useChat(live)
  const sending = useRef(false)
  const shared = useLive(live)
  const busy = chat.running || !!chat.awaiting || shared.busy
  const [draft, setDraft] = useState('')
  const [searching, setSearching] = useState(!sheet)
  const [memory, setMemory] = useState(false)
  const root = useRef(null), log = useRef(null), top = useRef(null), input = useRef(null)
  const height = useRef(0), stick = useRef(true), firstN = useRef(null), focused = useRef(null)
  const mark = chat.focus?.n ?? null // the entry the page was opened at
  const onScreen = useShown(root)
  useWatching(live, onScreen && !chat.detached)
  // what is on screen is read
  useEffect(() => { if (onScreen && !chat.detached && chat.items.length) live?.seen(chat.items.at(-1).n) }, [chat.items, chat.detached, onScreen])
  // the open sheet: a workbench_show said now (not one of the record's older ones, nor one said while it was closed) opens that page
  const shownTop = useRef(null), caughtUp = useRef(false)
  useEffect(() => {
    if (!sheet || !chat.ready || chat.detached) return
    const last = chat.items.at(-1)?.n ?? 0
    if (shownTop.current !== null && onScreen && caughtUp.current) for (const i of chat.items) if (i.kind === 'ui' && i.n > shownTop.current) openWorkbench(i.args?.run ? { run: i.args.run, ...(i.args.tab && { tab: i.args.tab }) } : { view: i.args?.view })
    shownTop.current = Math.max(shownTop.current ?? 0, last)
  }, [chat.items, chat.ready, chat.detached])
  // opened: what was said while it was closed is read first (shown as links, not opened)
  useEffect(() => {
    caughtUp.current = false
    if (!sheet || !onScreen) return
    let alive = true
    chat.newer().then(n => { if (alive) { shownTop.current = Math.max(shownTop.current ?? 0, n); caughtUp.current = true } })
    return () => { alive = false }
  }, [onScreen])
  // the sheet opened: the input takes the keys (a closed sheet stays mounted: it does not take them)
  useEffect(() => { if (sheet && onScreen) input.current?.focus({ preventScroll: true }) }, [onScreen])
  // stay at the bottom as it grows (unless the person scrolled up); keep the place when older entries come in above
  useLayoutEffect(() => {
    const el = log.current
    if (!el) return
    const first = chat.items[0]?.n ?? null
    const at = chat.focus && focused.current !== chat.focus.at ? el.querySelector(`[data-n="${chat.focus.n}"]`) : null
    if (at) { at.scrollIntoView({ block: 'center' }); focused.current = chat.focus.at; stick.current = false }
    else if (height.current && firstN.current !== null && first !== null && first < firstN.current) el.scrollTop += el.scrollHeight - height.current // older ones came in above
    else if (stick.current) el.scrollTop = el.scrollHeight
    height.current = el.scrollHeight
    firstN.current = first
  }, [chat.items, chat.awaiting, busy, chat.focus])
  useEffect(() => {
    const el = top.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) chat.older() })
    io.observe(el)
    return () => io.disconnect()
  }, [chat.more, chat.items[0]?.n])
  // what grows after it is drawn (a board, a card reading its workflow, an answer's Markdown) keeps the bottom in view
  useEffect(() => {
    const el = log.current, col = el?.firstElementChild
    if (!col || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; height.current = el.scrollHeight })
    ro.observe(col)
    return () => ro.disconnect()
  }, [])
  // an entry changed elsewhere (a card answered on a leaf of the desk): as it is now
  useEffect(() => {
    const on = e => { if (e.detail?.n) chat.replace(e.detail) }
    window.addEventListener(ITEM_EVENT, on)
    return () => window.removeEventListener(ITEM_EVENT, on)
  }, [])
  // a message from elsewhere (the shell's palette): its answer is followed at the bottom
  useEffect(() => {
    const on = () => { stick.current = true }
    window.addEventListener(REFRESH_EVENT, on)
    return () => window.removeEventListener(REFRESH_EVENT, on)
  }, [])
  const onScroll = () => { const el = log.current; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
  const send = text => { const q = text.trim(); if (!q || sending.current || (busy && !chat.running)) return; sending.current = true; stick.current = true; return chat.send(q).then(ok => { if (ok) setDraft(d => d.trim() === q ? '' : d) }).finally(() => { sending.current = false }) }
  const stop = () => call('chatStop').then(() => { chat.newer(); live?.poll() }, err => chat.setError(err))
  const topic = async () => { try { await call('chatTopic'); stick.current = true; await chat.newer() } catch (err) { chat.setError(err) } }
  const jump = n => { stick.current = false; chat.jump(n) }

  // rows: a day's line where the day changes, a run of tool calls as one line of chips
  const rows = []
  let prev = null
  // (several questions at once: what answers a message reads right after it — `to`, docs/design/desk-answers.md)
  const at = i => (i.kind === 'user' ? i.n : i.to ?? i.n)
  for (const i of [...chat.items].sort((x, y) => at(x) - at(y) || x.n - y.n)) {
    if (i.at && (!prev || !sameDay(prev.at, i.at))) rows.push({ kind: 'day', at: i.at, key: `d${i.n}` })
    if (i.kind === 'tool' && rows.at(-1)?.kind === 'tools') rows.at(-1).tools.push(i)
    else rows.push(i.kind === 'tool' ? { kind: 'tools', tools: [i], key: `t${i.n}` } : { ...i, key: i.n })
    prev = i
  }
  const loc = lang === 'zh' ? 'zh-CN' : 'en'
  const dayText = at => (sameDay(at, Date.now()) ? t('ch.today') : sameDay(at, Date.now() - 864e5) ? t('ch.yesterday') : new Date(at).toLocaleDateString(loc, { month: 'long', day: 'numeric', weekday: 'short' }))
  const time = at => (at ? new Date(at).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }) : '')
  const row = r => {
    const mine = r.n !== undefined && r.n === mark
    const wrap = node => <div key={r.key} data-n={r.n} className={cx(mine && 'wb-chat-mark')}>{node}</div>
    switch (r.kind) {
      case 'day': return <div key={r.key} className="wb-chat-day"><span>{dayText(r.at)}</span></div>
      case 'topic': return wrap(<div className="wb-chat-topic"><span><SquarePen size={11} />{t('ch.topic')} · {time(r.at)}</span></div>)
      case 'user': return wrap(<div className="wb-msg-user" title={time(r.at)}><div>{r.text}</div></div>)
      case 'text': return wrap(<Answer text={r.text} />)
      case 'error': return wrap(<div className="wb-note wb-t-red"><AlertTriangle size={13} /> {r.text}</div>)
      case 'ui': return wrap(<ShowLink args={r.args || {}} />)
      case 'genui': return wrap(<GenUI args={r.args} lang={lang} />)
      case 'cards': return wrap(<ChatCards item={r} lang={lang} onDone={x => chat.replace(x.item)} send={(q, re) => { stick.current = true; return chat.send(q, re) }} />)
      case 'tools': return <ToolChips key={r.key} tools={r.tools} />
      case 'action': return wrap(<ActionLine item={r} lang={lang} onDone={x => chat.replace(x.item)} />)
      case 'draft': return wrap(<RunCard item={r} onDone={x => chat.replace(x.item)} />)
      case 'runop': return wrap(<RunOpCard item={r} onDone={x => chat.replace(x.item)} />)
      case 'workflow': return wrap(<WorkflowCard item={r} onDone={x => chat.replace(x.item)} />)
      case 'task': return wrap(<TaskCard item={r} tasks={chat.tasks} onChange={() => chat.newer()} />)
      case 'run': return wrap(
        <div className="wb-chat-event"><Play size={12} /><span>{t('ch.run.started')}: {r.args?.title || r.args?.run}</span><RunState id={r.args?.run} />
          <button className="wb-linkbtn" onClick={() => openRun(r.args?.run)}><ExternalLink size={12} />{r.args?.run}</button><span className="wb-sub">{time(r.at)}</span></div>)
      case 'change': return wrap(
        // the shell shows it as a card at the bottom of every page; only the person applies it (there, or Settings → Changes)
        <div className="wb-chat-event"><SlidersHorizontal size={12} /><span className="wb-chat-event-text">{t('ch.change', { summary: r.args?.summary || '' })}<br /><span className="wb-sub">{t('ch.changeHint')}</span></span>
          {window.__ruyixSettings && <button className="wb-linkbtn" onClick={() => fire('ruyix-settings:open', { tab: 'changes' })}><ExternalLink size={12} />{t('ch.changeOpen')}</button>}</div>)
      default: return null
    }
  }

  const head = sheet ? (
    <div className="wb-chat-tools">
      {searching ? <ChatSearch onJump={jump} lang={lang} autoFocus onClose={() => setSearching(false)} />
        : <>
          <button className="wb-icon-btn" title={t('ch.search')} aria-label={t('ch.search')} onClick={() => setSearching(true)}><Search size={15} /></button>
          <AgentPick chat={chat} disabled={busy} />
          <span className="wb-push" />
          <button className="wb-icon-btn" title={t('mem.hint')} aria-label={t('mem.title')} onClick={() => setMemory(true)}><Brain size={15} /></button>
          <button className="wb-icon-btn" disabled={busy || !chat.items.length} title={t('ch.newTopicHint')} aria-label={t('ch.newTopic')} onClick={topic}><SquarePen size={15} /></button>
          <button className="wb-icon-btn" title={t('ch.openPage')} aria-label={t('ch.openPage')} onClick={() => openWorkbench({ view: 'chat' })}><ExternalLink size={15} /></button>
        </>}
    </div>
  ) : (
    <header className="wb-header">
      <div className="wb-brand">
        <span className="wb-brand-glyph"><MessagesSquare size={18} /></span>
        <div><h1>{t('nav.chat')}</h1><span className="wb-sub">{t('ch.sub')}</span></div>
      </div>
      <ChatSearch onJump={jump} lang={lang} />
      <div className="wb-header-actions">
        <AgentPick chat={chat} disabled={busy} />
        <button className="wb-btn" title={t('mem.hint')} onClick={() => setMemory(true)}><Brain size={14} />{t('mem.title')}</button>
        <button className="wb-btn" disabled={!chat.items.length} title={t('ch.exportHint')} onClick={() => call('chatExport').then(download, err => chat.setError(err))}><Download size={14} />{t('ch.export')}</button>
        <button className="wb-btn" disabled={busy || !chat.items.length} title={t('ch.newTopicHint')} onClick={topic}><SquarePen size={14} />{t('ch.newTopic')}</button>
      </div>
    </header>
  )
  return (
    <div ref={root} className={cx('wb-chat', sheet ? 'wb-chat-in-sheet' : 'wb-chat-in-page')} onKeyDown={e => { if (sheet && e.key === 'Escape' && !e.defaultPrevented) onClose?.() }}>
      {head}
      <div className="wb-chat-scroll" ref={log} onScroll={onScroll} role="log" aria-live="polite">
        <div className="wb-chat-col">
          {chat.more ? <div ref={top} className="wb-sub wb-chat-older"><Loader2 size={13} className="wb-spin" />{t('ch.older')}</div>
            : chat.items.length > 0 && <div className="wb-sub wb-chat-older">{t('ch.start')}</div>}
          {chat.ready && !chat.items.length && !chat.awaiting && (
            <div className="wb-chat-intro">
              <Sparkles size={22} />
              <p>{t('ch.intro')}</p>
              <div className="wb-suggest">{['ch.s1', 'ch.s2', 'ch.s3', 'ch.s4'].map(k => <button key={k} className="wb-btn" disabled={busy} onClick={() => send(t(k))}>{t(k)}</button>)}</div>
            </div>
          )}
          {rows.map(row)}
          {chat.awaiting && !chat.items.some(i => i.kind === 'user' && i.n > chat.awaiting.after) && <div className="wb-msg-user wb-pending"><div>{chat.awaiting.text}</div></div>}
          {busy && <div className="wb-sub"><Loader2 size={13} className="wb-spin" /> {t('ch.thinking')}</div>}
          {chat.error && <div className="wb-note wb-t-red"><AlertTriangle size={13} /> {errorText(t, chat.error)}</div>}
        </div>
      </div>
      {memory && <MemoryDrawer onClose={() => setMemory(false)} />}
      {chat.detached && <button className="wb-btn wb-chat-latest" onClick={() => { stick.current = true; chat.latest() }}><ArrowDown size={13} />{t('ch.latest')}</button>}
      <div className="wb-chat-foot">
        <div className="wb-chat-col wb-chat-input">
          <textarea ref={input} className="wb-input" rows={2} value={draft} placeholder={t('ch.placeholder')} aria-label={t('ch.placeholder')} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft) } }} />
          {chat.running
            ? <button className="wb-btn" onClick={stop}><Square size={13} />{t('ch.stop')}</button>
            : <button className="wb-btn wb-primary" disabled={!draft.trim() || busy} onClick={() => send(draft)} aria-label={t('ch.send')} title={t('ch.send')}><Send size={14} /></button>}
        </div>
      </div>
    </div>
  )
}
