// The main agent above the dock (docs/design/agent-tasks.md「桌面」): one line as it goes — what it heard, what it is
// doing, what it waits for — and, a click on it, the conversation opening upward over the desk (the workbench draws the
// conversation: the slot 'ruyix.chat'; its cards are @ruyix/shell/cards). The task the conversation is on comes with it:
// when it waits for the person to accept what was made, 好了 and 再改 are right on the line. What it did through the
// system tools (a theme, a widget, a studio's record…) comes too, each with its undo while it can be undone: the newest
// on the line for a moment after it is done, the last few in the opened panel (the workbench's chatActions / chatUndo).
// The line comes from the conversation's state (window.__ruyixChat: busy, unread, task, line), those actions and the
// voice; with nothing to say it invites. A card the conversation still waits on (a choice, 好了 / 再改: `cards`) shows
// just above the line while it is folded, to answer there (the conversation takes the answer: no onAnswer here) — unless
// a leaf of the desk holds it (./tree.jsx: the answer it came with): then the leaf is where it is answered, once.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Check, ChevronDown, ChevronUp, Mic, Sparkles, Undo2, X } from 'lucide-react'
import { textOf } from './text.js'
import { Cards } from '../cards/cards.jsx'
import { useLeafCards } from './tree.jsx'

const cx = (...c) => c.filter(Boolean).join(' ')
const CHAT_SLOT = 'ruyix.chat'
const call = (op, args) => fetch('api/ruyix-workbench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...args }) })
  .then(r => r.json()).then(j => { if (j?.error) throw new Error(j.error); return j })

const STATE_EVENT = 'ruyix:chat-state', FRESH_MS = 20000
const said = (x, lang) => (x && typeof x === 'object' ? x[lang] || x.en || x.zh || '' : String(x || ''))

/** What the main agent did through the system tools, newest first, and what it last heard (the workbench's chatActions):
 * read now and then — quickly while it works — and whenever the conversation's state changes. */
function useActions() {
  const [v, setV] = useState(null)
  useEffect(() => {
    let gone = false, timer = null
    const ask = () => {
      clearTimeout(timer)
      call('chatActions', { limit: 5 }).then(x => { if (!gone) setV(x) }, () => {}).finally(() => {
        if (!gone) timer = setTimeout(ask, document.hidden ? 15000 : window.__ruyixChat?.busy ? 1500 : 5000)
      })
    }
    ask()
    window.addEventListener(STATE_EVENT, ask)
    return () => { gone = true; clearTimeout(timer); window.removeEventListener(STATE_EVENT, ask) }
  }, [])
  return [v, () => call('chatActions', { limit: 5 }).then(setV, () => {})]
}

/** What the line says now: { kind: heard | doing | said | did | waiting | idle, text, undo? (the action's n) }. */
export function lineOf(chat, v, T, acts = null, lang = 'zh', now = Date.now()) {
  const task = chat?.task
  if (v?.phase === 'listening') return { kind: 'heard', text: T.listening }
  if (v?.phase === 'working') return { kind: 'heard', text: T.transcribing }
  if (task?.state === 'to-confirm') return { kind: 'waiting', text: T.toConfirm(task.title) }
  if (task?.state === 'waiting') return { kind: 'waiting', text: T.waitFor(chat.line?.kind === 'waiting' && chat.line.text ? chat.line.text : task.title) }
  // just heard, just done (for a moment: the panel keeps them)
  if (acts?.heard?.text && now - acts.heard.at < FRESH_MS) return { kind: 'heard', text: `“${acts.heard.text}”` }
  const last = acts?.items?.[0]
  if (last && !last.undone && now - last.at < FRESH_MS) return { kind: 'did', text: said(last.summary, lang), undo: last.undo ? last.n : null }
  if (chat?.line?.text) return { kind: chat.line.kind || 'said', text: chat.line.text }
  if (chat?.busy) return { kind: 'doing', text: task?.title ? T.doing(task.title) : T.working }
  if (chat?.unread) return { kind: 'said', text: T.unread(chat.unread) }
  return { kind: 'idle', text: T.idle }
}

export function AgentBar({ lang, chat, voice, open, setOpen, renderSlot, has, covered = false }) {
  const T = textOf(lang).agentbar
  const v = useSyncExternalStore(voice.subscribe, voice.get)
  const [acts, refresh] = useActions()
  const say = lineOf(chat, v, T, acts, lang), task = chat?.task
  const [undoing, setUndoing] = useState(null)
  const undo = async n => { setUndoing(n); setErr(''); try { await call('chatUndo', { n }) } catch (e) { setErr(`${T.undoFailed}：${e.message}`) } setUndoing(null); refresh() }
  const when = at => new Date(at).toLocaleTimeString(lang === 'en' ? 'en' : 'zh-CN', { hour: '2-digit', minute: '2-digit' })
  const [revise, setRevise] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState('')
  const confirm = async () => { setBusy(true); setErr(''); try { await call('taskConfirm', { id: task.id, run: task.lastRunId || '', expect: task.resultVersion || 0 }) } catch (e) { setErr(e.message) } setBusy(false) }
  const sendRevise = async e => {
    e.preventDefault()
    if (!revise?.trim()) return
    setBusy(true); setErr('')
    try { await call('taskRevise', { id: task.id, text: revise.trim(), run: task.lastRunId || '', expect: task.resultVersion || 0 }); setRevise(null) } catch (x) { setErr(x.message) }
    setBusy(false)
  }
  const waitingOk = task?.state === 'to-confirm' && task.id
  // the newest card the conversation waits on, above the folded line (put aside: until a newer one comes)
  const pending = (chat?.cards || []).filter(x => x?.cards?.length).at(-1), [aside, setAside] = useState(null)
  const inLeaf = useLeafCards().split(',').includes(String(pending?.n))
  const showCards = !open && pending && aside !== pending.n && !inLeaf
  // (a window in front of the desk: the card folds to one amber line, right of the tree's — a click opens it over the
  // windows, a click elsewhere folds it again: it never sits on a window's buttons)
  const [peek, setPeek] = useState(false)
  useEffect(() => { if (!covered) setPeek(false) }, [covered])
  useEffect(() => {
    if (!peek) return
    const away = e => { if (!e.target.closest?.('.ad-agentbar')) setPeek(false) }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [peek])
  const asked = pending?.cards?.find(c => c?.question || c?.title)
  return (
    <div className={cx('ad-agentbar', open && 'ad-ab-open', `ad-ab-${say.kind}`, chat?.busy && 'ad-ab-busy')}>
      {open && (
        <section className="ad-ab-panel ad-mat" role="dialog" aria-label={T.title}>
          <header className="ad-ab-head">
            <Sparkles size={15} strokeWidth={1.8} aria-hidden="true" /><b>{T.title}</b>{acts?.main?.name && <span className="ad-ab-who">· {acts.main.name}</span>}
            {task?.title && <span className={cx('ad-ab-task', `ad-ab-t-${task.state}`)}>{T.states[task.state] || task.state} · {task.title}</span>}
            <span className="ad-ab-grow" />
            <button type="button" className="ad-tbtn" aria-label={T.close} title={T.close} onClick={() => setOpen(false)}><X size={15} /></button>
          </header>
          {acts?.items?.length > 0 && (
            <ul className="ad-ab-acts" aria-label={T.recent}>
              {acts.items.slice(0, 5).map(i => (
                <li key={i.n} className={i.undone ? 'ad-ab-undone' : ''}>
                  {i.undoes ? <Undo2 size={12} /> : <Check size={12} />}
                  <span title={said(i.summary, lang)}>{said(i.summary, lang)}</span>
                  {i.at && <time>{when(i.at)}</time>}
                  {i.undo && !i.undone && <button type="button" className="ad-ab-undo" disabled={undoing === i.n} onClick={() => undo(i.n)}><Undo2 size={11} />{T.undo}</button>}
                </li>
              ))}
            </ul>
          )}
          <div className="ad-ab-body">{has ? renderSlot(CHAT_SLOT, { onClose: () => setOpen(false), lang }) : <p className="ad-sheet-empty">{T.none}</p>}</div>
        </section>
      )}
      {showCards && covered && !peek && (
        <button type="button" className="ad-ab-cardchip ad-mat" aria-expanded={false} title={T.waitingCards} onClick={() => setPeek(true)}>
          <i aria-hidden="true" /><span>{T.waitingCards}{asked ? ` · ${asked.question || asked.title}` : ''}</span>
        </button>
      )}
      {showCards && (!covered || peek) && (
        <section className={cx('ad-ab-cards ad-mat', peek && 'ad-ab-peek')} aria-label={T.waitingCards}>
          <Cards cards={pending.cards} answered={pending.answered || {}} origin={{ n: pending.n }} lang={lang} compact />
          <button type="button" className="ad-ab-aside" onClick={() => setAside(pending.n)}>{T.later}</button>
        </section>
      )}
      <div className="ad-ab-line ad-mat">
        {revise !== null ? (
          <form className="ad-ab-revise" onSubmit={sendRevise}>
            <input autoFocus value={revise} onChange={e => setRevise(e.target.value)} placeholder={T.revisePh} aria-label={T.revisePh} onKeyDown={e => { if (e.key === 'Escape') setRevise(null) }} />
            <button type="submit" className="ad-ab-btn ad-ab-pri" disabled={busy || !revise.trim()}>{T.send}</button>
            <button type="button" className="ad-ab-icon" aria-label={T.cancel} onClick={() => setRevise(null)}><X size={14} /></button>
          </form>
        ) : (
          <>
            <button type="button" className="ad-ab-main" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? T.close : T.open}>
              <i className="ad-ab-dot" aria-hidden="true" />
              {say.kind !== 'idle' && <span className="ad-ab-kind">{T.kinds[say.kind]}</span>}
              <span className="ad-ab-text">{err || say.text}</span>
            </button>
            {say.undo != null && <button type="button" className="ad-ab-btn" disabled={undoing === say.undo} onClick={() => undo(say.undo)}><Undo2 size={13} />{T.undo}</button>}
            {waitingOk && (
              <>
                <button type="button" className="ad-ab-btn ad-ab-pri" disabled={busy} onClick={confirm}><Check size={13} />{T.ok}</button>
                <button type="button" className="ad-ab-btn" disabled={busy} onClick={() => setRevise('')}>{T.revise}</button>
              </>
            )}
            <button type="button" className={cx('ad-ab-icon', v.phase === 'listening' && 'ad-on')} aria-label={T.talk} title={T.talk}
              onPointerDown={e => e.preventDefault()} onClick={() => voice.toggle()}><Mic size={15} strokeWidth={1.8} /></button>
            <button type="button" className="ad-ab-icon" aria-label={open ? T.close : T.open} title={open ? T.close : T.open} onClick={() => setOpen(!open)}>
              {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
