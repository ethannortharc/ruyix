// What grows from the main agent's line while it works (docs/design/desk-answers.md): a stem up from the line's left end
// with what is going on — the last few lines, the newest at the bottom, the older ones fading up — and a node for each
// question at work (queued ones say so); when a question's answer comes, a leaf grows beside the stem: the question, the
// answer (its words, its cards — answered right there); a leaf closed goes into the drawer at the stem's foot (how many
// not seen yet), where each can be opened again, put in front (a window with the whole answer) or wiped (seen). Nothing
// at work and nothing unseen: it all goes back into the line. The list is @ruyix/shell/answers (the conversation fills
// it); what the leaf's buttons do goes back to it, and its reply line asks on that question ('ruyix:chat-ask' { re }). One
// that comes up in a window by itself when answered (front: true), or whose work opened something for the person (opened:
// a made app, a page, a window placed), grows no leaf: what it opened is its answer, and its words wait in the drawer.
// With a window in front of the desk the tree folds to one small line above the main agent's (what is at work, how many
// answers; a new one makes it glow): a click opens it over the windows, a click elsewhere folds it again — it never sits
// on a window's buttons.
// The leaves find their room (Ethan: 「找一些空的地方来放」): each goes where the desk is free above the main agent's line —
// clear of the widgets, the clock, the open things, the stem and each other (./place.js) — the newest beside the stem; one
// with no room left waits in the drawer. A card a leaf holds is the leaf's alone: the main agent's line does not show it
// again (window.__ruyixLeaves { cards: [its entries' n] }, 'ruyix:leaves').
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { Archive, ChevronDown, ChevronUp, CornerDownLeft, Maximize2, Mic, Workflow, X } from 'lucide-react'
import { answersLayout, answersRegistry } from '../answers.js'
import { Cards } from '../cards/cards.jsx'
import { placeBoxes } from './place.js'
import { BAR, DOCK } from './store.js'
import { textOf } from './text.js'

const cx = (...c) => c.filter(Boolean).join(' ')

/** The answers list, as it changes. */
export function useAnswers() {
  const [list, setList] = useState(() => answersRegistry().get())
  useEffect(() => { const on = () => setList(answersRegistry().get()); window.addEventListener('ruyix:answers', on); on(); return () => window.removeEventListener('ruyix:answers', on) }, [])
  return list
}

/** The stem's lines: the newest few of every question at work, oldest first. */
export function stemLines(stem, keep = 5) {
  return stem.flatMap(q => (q.lines || []).map(l => ({ ...l, q: q.id }))).sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-keep)
}

// (its cards: entries as the conversation keeps them — [{ n, cards, answered? }] — or the cards themselves)
const entriesOf = cards => (!Array.isArray(cards) || !cards.length ? [] : Array.isArray(cards[0]?.cards) ? cards : [{ cards }])
/** Whether its answer still asks the person (a choice or a confirm not answered yet). */
const asks = q => entriesOf(q.answer?.cards).some(e => split(e).ask.length > 0)

// how many leaves are out at most, how wide, how short one may get (its words scroll); what they keep clear of: what the
// desk shows a person to read or use (the waiting card above the line, and the stem's own)
const OUT = 3, LEAF_W = 360, LEAF_MIN = 200
const AROUND = '.ad-clock, .ad-groups, .ad-wfree > .ad-w, .ad-widgets > *, .ad-ab-cards, .ad-ab-cardchip, .ad-tr-stem > *'

const LEAVES_EVENT = 'ruyix:leaves'
/** The cards the desk's leaves hold now (their entries' n): the main agent's line leaves those to them. */
export function useLeafCards() {
  return useSyncExternalStore(f => { window.addEventListener(LEAVES_EVENT, f); return () => window.removeEventListener(LEAVES_EVENT, f) }, () => window.__ruyixLeaves?.key || '')
}
function tellLeaves(qs) {
  const cards = qs.flatMap(q => entriesOf(q.answer?.cards).map(e => e.n)).filter(n => n != null)
  const key = cards.join(',')
  if ((window.__ruyixLeaves?.key || '') === key) return
  window.__ruyixLeaves = { key, cards }
  window.dispatchEvent(new Event(LEAVES_EVENT))
}

/** An entry's cards, those still asking the person (a choice, a confirm not answered yet) apart: { ask, rest, answered }
 * (`answered` kept by each one's place in `rest`). */
function split(e) {
  const ask = [], rest = [], answered = {}
  ;(e.cards || []).forEach((c, k) => {
    if ((c?.type === 'choice' || c?.type === 'confirm') && !e.answered?.[k]) return void ask.push(c)
    if (e.answered?.[k]) answered[rest.length] = e.answered[k]
    rest.push(c)
  })
  return { ask, rest, answered }
}

/** Its words and cards. `hold`: the cards still asking the person are left out (the leaf keeps them in sight below). */
function Answer({ q, a, lang, T, hold = false }) {
  if (q.state === 'failed') return <p className="ad-tr-text ad-tr-bad">{q.error || a?.text || T.failed}</p>
  const origin = { ask: q.id, ...(q.task && { task: q.task }) }
  return (
    <>
      {/* (what only the conversation draws — a workflow it saved, a draft — with what it says of it: opened there) */}
      {(q.elsewhere || []).map((x, i) => (
        <button key={i} type="button" className="ad-tr-else" onClick={() => window.dispatchEvent(new CustomEvent('ruyix:chat', { detail: { open: true } }))}>
          <Workflow size={13} aria-hidden="true" /><span>{T.elsewhere[x.kind] || ''}{x.title}</span><b>{T.inChat}</b>
        </button>
      ))}
      {/* (its words are Markdown: drawn as such, the host's own renderer) */}
      {a?.text && <div className="ad-tr-text ad-tr-md"><MarkdownText text={a.text} labels={T.md} /></div>}
      {/* (an answer to its cards goes to the conversation, saying which question: origin.ask) */}
      {entriesOf(a?.cards).map((e, i) => {
        const { rest, answered } = hold ? split(e) : { rest: e.cards, answered: e.answered || {} }
        return rest.length > 0 && <Cards key={e.n ?? i} cards={rest} answered={answered} lang={lang} compact origin={origin} />
      })}
    </>
  )
}

/** What the answer still asks the person, kept in sight at the leaf's foot however long its words (they scroll above). */
function Asking({ q, lang }) {
  const open = entriesOf(q.answer?.cards).map((e, i) => ({ key: e.n ?? i, ask: split(e).ask })).filter(x => x.ask.length)
  if (q.state === 'failed' || !open.length) return null
  return <div className="ad-tr-asking">{open.map(x => <Cards key={x.key} cards={x.ask} answered={{}} lang={lang} compact origin={{ ask: q.id, ...(q.task && { task: q.task }) }} />)}</div>
}

const IDLE = { phase: 'idle' }
const NO_VOICE = { subscribe: () => () => {}, get: () => IDLE }

/** Ask on: the words land on this question (its leaf, its task, its session) — typed, or said: the microphone with the
 * line empty sends what was heard to it (the heard bubble first, as the main agent's), with words typed it adds to them. */
function Reply({ q, T, voice }) {
  const [text, setText] = useState('')
  const input = useRef(null), mine = useRef(false)
  const v = useSyncExternalStore((voice || NO_VOICE).subscribe, (voice || NO_VOICE).get)
  useEffect(() => { if (v.phase !== 'listening' && v.phase !== 'working') mine.current = false }, [v.phase])
  const ask = (t, via) => window.dispatchEvent(new CustomEvent('ruyix:chat-ask', { detail: { text: t, re: q.id, ...(via && { via }) } }))
  const send = () => { const t = text.trim(); if (!t) return; ask(t); setText('') }
  const talk = () => {
    if (!voice) return
    if (mine.current || v.phase === 'listening') return voice.toggle()
    mine.current = true
    if (text.trim()) { input.current?.focus(); voice.toggle() } else voice.toggle({ to: t => { ask(t, 'voice'); return true } })
  }
  const on = mine.current && (v.phase === 'listening' || v.phase === 'working')
  return (
    <form className="ad-tr-reply" onSubmit={e => { e.preventDefault(); send() }}>
      <input ref={input} value={text} placeholder={on && v.phase === 'listening' ? T.listening : T.reply} aria-label={T.reply} onChange={e => setText(e.target.value)} />
      {voice && (
        <button type="button" className={cx('ad-tr-icon ad-tr-mic', on && 'ad-on')} aria-label={T.talk} title={T.talk} aria-pressed={on}
          onPointerDown={e => e.preventDefault() /* the line keeps the focus: words said go into what is typed */} onClick={talk}><Mic size={14} /></button>
      )}
      {text.trim() && <button type="submit" className="ad-tr-icon" aria-label={T.send} title={T.send}><CornerDownLeft size={14} /></button>}
    </form>
  )
}

function Asked({ q, T, states }) {
  return (
    <span className="ad-tr-asked">
      <span className="ad-tr-q" title={q.question}>{q.question}</span>
      {q.followUp && <small className="ad-tr-follow" title={q.followUp}>{T.followUp}{q.followUp}</small>}
      {q.taskState && states[q.taskState] && q.taskState !== 'done' && <small className={cx('ad-ab-task', `ad-ab-t-${q.taskState}`)}>{states[q.taskState]}</small>}
    </span>
  )
}

function Leaf({ q, T, lang, states, voice, at, keep }) {
  const reg = answersRegistry()
  // (placed: where ./place.js found room; not yet, or no room: out of sight, still measured — the drawer has it)
  const style = at ? { left: at.x, top: at.y, width: at.w, maxHeight: at.h } : { left: -10000, top: 0, width: LEAF_W, visibility: 'hidden' }
  return (
    <article ref={keep} className={cx('ad-tr-leaf ad-mat', q.state === 'failed' && 'ad-tr-failed', at?.near && 'ad-tr-near')} style={style} aria-hidden={at ? undefined : true}>
      <header className="ad-tr-leaf-head">
        <Asked q={q} T={T} states={states} />
        <span className="ad-tr-acts">
          <button type="button" className="ad-tr-icon" title={T.front} aria-label={T.front} onClick={() => reg.front(q.id)}><Maximize2 size={13} /></button>
          <button type="button" className="ad-tr-icon" title={T.close} aria-label={T.close} onClick={() => reg.close(q.id)}><Archive size={13} /></button>
          <button type="button" className="ad-tr-icon" title={T.wipe} aria-label={T.wipe} onClick={() => reg.seen(q.id)}><X size={14} /></button>
        </span>
      </header>
      <div className="ad-tr-body"><Answer q={q} a={q.answer} lang={lang} T={T} hold /></div>
      <Asking q={q} lang={lang} />
      <Reply q={q} T={T} voice={voice} />
    </article>
  )
}

function Drawer({ list, T, lang }) {
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(null)
  const reg = answersRegistry()
  if (!list.length) return null
  return (
    <div className={cx('ad-tr-drawer', open && 'ad-tr-drawer-open')}>
      {open && (
        <div className="ad-tr-drawer-list ad-mat" role="dialog" aria-label={T.drawer}>
          <header><b>{T.drawer}</b><button type="button" className="ad-tr-icon" aria-label={T.close} onClick={() => setOpen(false)}><X size={14} /></button></header>
          <ul>
            {list.map(q => (
              <li key={q.id} className={cx(expanded === q.id && 'on')}>
                <button type="button" className="ad-tr-di" onClick={() => setExpanded(e => (e === q.id ? null : q.id))} aria-expanded={expanded === q.id}>
                  <span className="ad-tr-q">{q.question}</span>
                  {expanded === q.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                {expanded === q.id
                  ? <div className="ad-tr-body"><Answer q={q} a={q.answer} lang={lang} T={T} /></div>
                  : (q.error || q.answer?.text) && <p className="ad-tr-peek">{q.error || q.answer.text}</p>}
                <span className="ad-tr-acts">
                  <button type="button" className="ad-tr-mini" onClick={() => reg.front(q.id)}><Maximize2 size={12} />{T.front}</button>
                  <button type="button" className="ad-tr-mini" onClick={() => reg.seen(q.id)}><X size={12} />{T.wipe}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" className="ad-tr-pile ad-mat" aria-expanded={open} title={T.drawer} onClick={() => setOpen(o => !o)}>
        <span className="ad-tr-sheets" aria-hidden="true"><i /><i /><i /></span>
        <b>{list.length}</b>
      </button>
    </div>
  )
}

/** The tree, above the main agent's line (hidden while the conversation is opened from it; folded while `covered`: a
 * window is in front of the desk). `z`: the interface's zoom; `vw` × `vh`: the desk in its pixels. */
export function AnswerTree({ lang, hidden = false, covered = false, voice = null, z = 1, vw = window.innerWidth, vh = window.innerHeight }) {
  const T = textOf(lang).tree, states = textOf(lang).agentbar.states, list = useAnswers()
  const { stem, leaves: all, drawer: closed } = useMemo(() => answersLayout(list), [list])
  const leaves = all.filter(q => !q.front && !q.opened), drawer = [...all.filter(q => !q.front && q.opened), ...closed]
  const out = leaves.slice(0, OUT)
  const lines = useMemo(() => stemLines(stem), [stem])
  const [peek, setPeek] = useState(false)
  useEffect(() => { if (!covered) setPeek(false) }, [covered])
  useEffect(() => {
    if (!peek) return
    const away = e => { if (!e.target.closest?.('.ad-tree')) setPeek(false) }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [peek])

  // ── where each leaf goes: measured as it would be whole, placed in the room the desk has (id → { x, y, w, h, near } | null) ──
  const [spots, setSpots] = useState({})
  const els = useRef(new Map()), stemEl = useRef(null)
  const shown = !hidden && !(covered && !peek)
  const place = useRef(null)
  place.current = () => {
    if (!shown || !out.length) return
    const box = el => { const b = el.getBoundingClientRect(); return { l: b.left / z, t: b.top / z, r: b.right / z, b: b.bottom / z } }
    const line = document.querySelector('.ad-ab-line')
    const area = { l: 12, t: BAR + 8, r: vw - 12, b: (line ? box(line).t : vh - DOCK) - 10 }
    const obstacles = [...document.querySelectorAll(AROUND)].map(box).filter(o => o.r - o.l > 1 && o.b - o.t > 1)
    const anchor = { x: (stemEl.current ? box(stemEl.current).r : area.l) + 14 + LEAF_W / 2, y: area.b }
    const boxes = out.map(q => {
      const el = els.current.get(q.id)
      if (!el) return { w: LEAF_W, h: 320, minH: LEAF_MIN }
      const was = el.style.maxHeight
      el.style.maxHeight = 'none' // (whole: what it would take)
      const h = el.getBoundingClientRect().height / z
      el.style.maxHeight = was
      return { w: LEAF_W, h: Math.ceil(h), minH: LEAF_MIN }
    })
    const at = placeBoxes({ area, obstacles, boxes, anchor })
    const next = Object.fromEntries(out.map((q, i) => [q.id, at[i] && { ...at[i], near: stem.length > 0 && at[i].x === Math.round(anchor.x - LEAF_W / 2) && at[i].y + at[i].h === area.b }]))
    setSpots(was => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
  }
  // (again at every change of the tree, and now and then: a widget moved, the waiting card came or went, the desk resized)
  useLayoutEffect(() => { place.current() })
  useEffect(() => {
    if (!shown) return
    const again = () => place.current()
    const t = setInterval(again, 700)
    window.addEventListener('resize', again)
    return () => { clearInterval(t); window.removeEventListener('resize', again) }
  }, [shown])
  const placed = out.filter(q => spots[q.id]), roomless = out.filter(q => spots[q.id] === null)
  // (the cards these leaves hold: the main agent's line does not show them again — folded, the fold stands for them)
  useEffect(() => { tellLeaves(hidden ? [] : shown ? placed : out) })
  useEffect(() => () => tellLeaves([]), [])

  if (hidden || (!stem.length && !leaves.length && !drawer.length)) return null
  if (covered && !peek) {
    const n = leaves.length + drawer.length, waits = out.find(asks)
    return (
      <div className="ad-tree ad-tree-folded" aria-label={T.title}>
        {/* (keyed by the newest answer: a new one plays the glow again) */}
        <button key={leaves[0]?.id || 'none'} type="button" className={cx('ad-tr-fold ad-mat', leaves.length > 0 && 'ad-tr-fresh', !stem.length && waits && 'ad-tr-waits')} onClick={() => setPeek(true)} title={T.show} aria-expanded={false}>
          {(stem.length > 0 || waits) && <i className={cx('ad-tr-bud', stem.length > 0 && 'ad-tr-working')} aria-hidden="true" />}
          <span className="ad-tr-q">{stem.length ? T.working(stem.length) : waits ? `${T.waits} · ${waits.question}` : leaves[0]?.question || T.drawer}</span>
          {n > 0 && <b>{n}</b>}
        </button>
      </div>
    )
  }
  return (
    <div className={cx('ad-tree', covered && 'ad-tree-peek')} aria-label={T.title}>
      <div ref={stemEl} className="ad-tr-stem">
        {stem.length > 0 && <i className="ad-tr-trunk" aria-hidden="true" />}
        {stem.slice().reverse().map(q => (
          <div key={q.id} className={cx('ad-tr-node', `ad-tr-${q.state}`)} title={q.question}>
            <i className="ad-tr-bud" aria-hidden="true" />
            <span className="ad-tr-q">{q.question}</span>
            {q.state === 'queued' && <span className="ad-tr-queued">{T.queued}</span>}
          </div>
        ))}
        {lines.length > 0 && (
          <div className="ad-tr-lines" aria-live="polite">
            {lines.map((l, i) => <span key={`${l.q}:${l.at}:${i}`} className={cx('ad-tr-line', `ad-tr-k-${l.kind || 'say'}`, i < lines.length - 1 && 'ad-tr-old')} style={{ '--age': lines.length - 1 - i }}>{l.text}</span>)}
          </div>
        )}
        {/* (the drawer: the closed ones, the leaves beyond the three out, and those the desk had no room for) */}
        <Drawer list={[...roomless, ...leaves.slice(OUT), ...drawer]} T={T} lang={lang} />
      </div>
      {out.map(q => (
        <Leaf key={q.id} q={q} T={T} lang={lang} states={states} voice={voice} at={spots[q.id]}
          keep={el => { if (el) els.current.set(q.id, el); else els.current.delete(q.id) }} />
      ))}
    </div>
  )
}
