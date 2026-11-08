// How the standing conversation is doing, for the shell (its top bar shows a working dot and an unread mark) and for the
// views (the shell's chat sheet, the Chat page), with no React here so the check can run it:
// - the questions on the desk (docs/design/desk-answers.md): the ones going and the answers not seen yet, published to
//   the shell's answers list (@ruyix/shell/answers: the stem, the leaves, the drawer) with its hooks — seen (擦掉), close
//   (into the drawer), front (the whole answer in a window: `onFront`); an answer that is to come up in front does, once;
//   voice 「打开给我看」 alone puts the newest answer in front, said after a question it brings that one's up when it comes;
// - window.__ruyixChat = { busy, unread, task?, line?, cards? } and the window event 'ruyix:chat-state' whenever it changes:
//   the conversation's task now { id, title, state, waitingFor? }, the line the main agent's strip shows { kind: heard |
//   doing | said | waiting, text, at }, and the cards still waiting for the person [{ kind: 'cards', n, cards, answered? }];
// - a card answered anywhere without its own onAnswer (the window event 'ruyix:card-answer', @ruyix/shell/cards-spec):
//   one of the conversation's (origin { n }) is kept on its entry, and said as the person's message unless it was the
//   person's word on a task (好了 / 再改); another confirm with a task is that task's 好了 / 再改; anything else is a message;
// - the shell's palette asks with 'ruyix:chat-ask' { text }: sent as a new message (the shell opens the sheet itself);
// - a view sends through `ask` too, and says what it shows (`watch`, `seen`), so what is on screen is not unread.
// One light poll of the record's newest entries: quickly while it answers, now and then otherwise.

import { answersRegistry } from '@ruyix/shell/answers'
import { ANSWER_EVENT, answerText } from '@ruyix/shell/cards-spec'

export const STATE_EVENT = 'ruyix:chat-state'
export const ASK_EVENT = 'ruyix:chat-ask'
/** The shell opens (or toggles) its chat sheet on this window event: { open?: boolean }. */
export const OPEN_SHEET = 'ruyix:chat'
/** To the views: read what is new now (a message went out from elsewhere); `detail.error`: it did not go out. */
export const REFRESH_EVENT = 'ruyix-workbench:chat-refresh'
/** To the views: an entry changed elsewhere (a card answered on a leaf): `detail` is the entry as it is now. */
export const ITEM_EVENT = 'ruyix-workbench:chat-item'
/** What the assistant says or makes counts as unread; what the person said does not. */
export const SAID = new Set(['text', 'genui', 'draft', 'runop', 'workflow', 'run', 'change', 'task', 'error'])
const PAGE = 200

/** The answer as the op takes it (the renderer's carries its card too). */
const answerOf = a => ({ type: a.type, ...(a.values && { values: a.values }), ...(a.value && { value: a.value }), ...(a.text && { text: a.text }) })
/**
 * A card of the conversation's record answered: kept on its entry; a reply its task does not take itself (a choice, or a
 * confirm with no task to say it on) goes out as the person's message through `send`. → { item, handled }
 */
export async function answerCard({ call, item, answer, index, lang = 'zh', send }) {
  let k = Number.isInteger(index) ? index : item.cards.indexOf(answer.card)
  if (k < 0) k = item.cards.findIndex(c => JSON.stringify(c) === JSON.stringify(answer.card))
  const r = await call('chatCardAnswer', { n: item.n, index: Math.max(k, 0), answer: answerOf(answer) })
  if (!r.handled) await send(answerText(answer, lang), r.re) // (on its question: the reply lands on its leaf)
  return r
}

/**
 * `call(op, args)`: the workbench API; `win`: the window (events, the global); `lang()`: the person's language for a
 * message; `store`: { get, set } kept in the browser (what was read, up to which entry), under `key`.
 */
/** Voice (or typed) 「打开给我看」: alone, the newest answer in front; after a question, that question's answer when it comes. */
const SHOW_ONLY = /^(请)?(把(它|答案|刚才的?|这个))?(打开给我看|打开看看|放到前台|拿到前面|给我看看|显示出来|open it|show me|show it)[。.!！]?$/i
const SHOW_AFTER = /[，,。.\s]*(然后|并且?|and)?\s*(打开给我看|放到前台|直接打开给我看|show me|open it)[。.!！]?$/i

export function createChatState({ call, win, lang = () => 'en', store, key, quietMs = 15000, busyMs = 1500, now = Date.now, onFront = null }) {
  let last = null // the newest entry known (null: not read yet)
  let seen = store.get(key, null) // read up to this entry (null: never — what is there now counts as read)
  let fresh = [] // the numbers of what the assistant said after `seen`
  let running = false, working = false, sending = 0, watching = 0, timer = null, stopped = true, polling = null // (working: a background task is going)
  // a message went out and the session has not taken it up yet (dsh queues it): busy until it runs or answers, a while at most
  let expecting = 0
  let shown = { busy: false, unread: 0 }, shownKey = 'false|0|'
  let task = null, line = null, cards = [] // (from the record: the shell's strip shows them)
  let questions = [] // the questions on the desk, as the chat op gives them
  const fronted = new Set() // the ones put in front on their own already (once each)

  const publish = () => {
    if (expecting && now() > expecting) expecting = 0
    const next = { busy: running || working || sending > 0 || expecting > 0, unread: watching ? 0 : fresh.length, ...(task && { task }), ...(line && { line }), ...(cards.length && { cards }) }
    win.__ruyixChat = next
    const key = `${next.busy}|${next.unread}|${task || line || cards.length ? JSON.stringify([task, line, cards]) : ''}`
    if (key === shownKey) return
    shown = next; shownKey = key
    const Event = win.CustomEvent || CustomEvent
    win.dispatchEvent(new Event(STATE_EVENT, { detail: { ...next } }))
  }
  const markSeen = n => {
    if (!Number.isFinite(n) || (seen !== null && n <= seen)) return
    seen = n
    store.set(key, n)
    fresh = fresh.filter(x => x > n)
  }
  const took = r => { task = r.task || null; line = r.line || null; cards = Array.isArray(r.cards) ? r.cards : []; if (Array.isArray(r.asks)) { questions = r.asks; publishAnswers() } }
  // ── the questions on the desk: the shell's answers list, through these hooks ──
  const say = err => win.dispatchEvent(new (win.CustomEvent || CustomEvent)(REFRESH_EVENT, { detail: { error: err } }))
  function front(id) {
    if (!questions.some(x => x.id === id)) return false
    onFront?.(id)
    call('chatAskOpen', { id, fronted: true }).catch(() => {})
    return true
  }
  const hooks = {
    seen: ids => {
      const gone = new Set([].concat(ids))
      for (const id of gone) call('chatAskSeen', { id }).catch(say)
      questions = questions.filter(x => !gone.has(x.id))
      publishAnswers()
    },
    close: id => { call('chatAskOpen', { id, open: 'drawer' }).catch(say); questions = questions.map(x => (x.id === id ? { ...x, open: 'drawer' } : x)); publishAnswers() },
    front: id => front(id),
  }
  function publishAnswers() {
    try { answersRegistry(win).set('chat', questions, hooks) } catch { /* no desk list here */ }
    // (one that is to come up in front: once, when its answer is there)
    for (const x of questions) if (x.front && x.state === 'answered' && !fronted.has(x.id)) { fronted.add(x.id); front(x.id) }
  }
  const schedule = () => {
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(poll, running || sending || expecting ? busyMs : working ? Math.max(busyMs, 4000) : quietMs)
  }
  /** What came since the last look: whether it is answering, and what it said. */
  async function poll() {
    if (polling) return polling
    polling = (async () => {
      try {
        if (seen === null) { // a first visit: what is there already counts as read
          const r = await call('chat', { limit: 1 })
          running = !!r.running; took(r)
          working = !!r.tasks?.some(x => ['queued', 'running'].includes(x.status))
          markSeen(r.items.at(-1)?.n ?? 0)
          last = seen
        } else {
          for (let page = 0; page < 20; page++) {
            const r = await call('chat', { after: last ?? seen, limit: PAGE })
            running = !!r.running; took(r)
            working = !!r.tasks?.some(x => ['queued', 'running'].includes(x.status))
            for (const i of r.items) { if (SAID.has(i.kind) && i.n > seen) fresh.push(i.n); if (SAID.has(i.kind)) expecting = 0; last = Math.max(last ?? 0, i.n) }
            if (running) expecting = 0 // it took the message up: `running` says the rest
            if (r.items.length < PAGE) break
          }
          if (watching && last !== null) markSeen(last)
        }
      } catch { /* not reachable now: the next poll tries again */ }
      polling = null
      publish()
      schedule()
    })()
    return polling
  }
  /** A message to the conversation (the palette's, a view's, voice's — `via: 'voice'`): busy until the record says it answered. */
  async function ask(text, via, { re = null, front: inFront = false } = {}) {
    let q = String(text || '').trim()
    if (!q) return false
    // 「打开给我看」: alone, the newest answer comes up in front (nothing asked); after a question, its answer will
    if (SHOW_ONLY.test(q)) {
      const newest = [...questions].filter(x => x.state === 'answered').sort((x, y) => (y.answeredAt || 0) - (x.answeredAt || 0))[0]
      if (newest && front(newest.id)) return true
    } else if (SHOW_AFTER.test(q) && q.replace(SHOW_AFTER, '').trim()) { q = q.replace(SHOW_AFTER, '').trim(); inFront = true }
    sending++
    publish()
    try {
      // (the person's time zone with each message: what their "明天早上" means — the box keeps UTC)
      await call('chatSend', { text: q.slice(0, 8000), lang: lang(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(via === 'voice' && { via }), ...(re && { re }), ...(inFront && { front: true }) })
      expecting = now() + 60000
      win.dispatchEvent(new (win.CustomEvent || CustomEvent)(REFRESH_EVENT, { detail: {} }))
      return true
    } catch (err) {
      win.dispatchEvent(new (win.CustomEvent || CustomEvent)(REFRESH_EVENT, { detail: { error: err } }))
      throw err
    } finally {
      sending--
      if (polling) await polling // (one that began before the message went out does not count)
      await poll() // is it answering now? (the next polls come quickly while it is)
    }
  }
  const onAsk = e => { const d = e?.detail || {}; ask(d.text, d.via, { re: d.re || null, front: d.front === true }).catch(() => { /* told to the views */ }) }
  /** A card answered where it has no onAnswer of its own (the strip's, a page's). */
  async function answer(a, origin) {
    if (!a?.type) return null
    // (a leaf's card: origin { ask } — the cards entry of that question's answer it is in)
    const leaf = origin?.ask && questions.find(x => x.id === origin.ask)
    const inLeaf = leaf && (leaf.answer?.cards || []).find(e => e.cards.includes(a.card)) || (leaf?.answer?.cards || []).find(e => e.cards.some(c => JSON.stringify(c) === JSON.stringify(a.card)))
    const item = inLeaf ? { kind: 'cards', n: inLeaf.n, cards: inLeaf.cards, answered: inLeaf.answered } : origin && cards.find(i => i.n === Number(origin.n))
    try {
      if (item) {
        const r = await answerCard({ call, item, answer: a, index: Number.isInteger(origin.index) ? origin.index : undefined, lang: lang(), send: (q, to) => ask(q, undefined, { re: to || leaf?.id || null }) })
        if (r?.item) win.dispatchEvent(new (win.CustomEvent || CustomEvent)(ITEM_EVENT, { detail: r.item }))
        cards = cards.map(i => (i.n === r.item.n ? { ...i, answered: r.item.answered } : i)).filter(i => i.cards.some((c, k) => (c.type === 'choice' || c.type === 'confirm') && !i.answered?.[k]))
        return r
      }
      if (a.type === 'confirm' && a.task) return a.value === 'ok' ? await call('taskConfirm', { id: a.task, ...(a.run !== undefined && { run: a.run }), ...(a.expect !== undefined && { expect: a.expect }) }) : await call('taskRevise', { id: a.task, text: a.text || '', ...(a.run !== undefined && { run: a.run }), ...(a.expect !== undefined && { expect: a.expect }) })
      return await ask(answerText(a, lang()))
    } catch (err) {
      win.dispatchEvent(new (win.CustomEvent || CustomEvent)(REFRESH_EVENT, { detail: { error: err } }))
      return null
    } finally { publish(); poll() }
  }
  const onAnswer = e => { answer(e?.detail?.answer, e?.detail?.origin) }
  return {
    /** Start listening and polling → stop(). */
    start() {
      stopped = false
      win.__ruyixChat = { ...shown }
      win.addEventListener(ASK_EVENT, onAsk); win.addEventListener(ANSWER_EVENT, onAnswer)
      poll()
      return () => { stopped = true; clearTimeout(timer); win.removeEventListener(ASK_EVENT, onAsk); win.removeEventListener(ANSWER_EVENT, onAnswer) }
    },
    ask,
    /** A question's whole answer in front (its window): → whether there was one */
    front,
    /** A card answered (as the window event says it): → what came of it */
    answer,
    /** Look again now (a view sent something, or stopped it). */
    poll,
    /** A view shows the latest entries on screen → unwatch(): while one does, nothing is unread. */
    watch() {
      watching++
      if (last !== null) markSeen(last)
      publish()
      let done = false
      return () => { if (!done) { done = true; watching--; publish() } }
    },
    /** A view showed the record up to entry `n`. */
    seen(n) { markSeen(Number(n)); publish() },
    /** { busy, unread } as the shell sees it. */
    snapshot: () => ({ ...shown }),
  }
}
