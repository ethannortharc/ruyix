// A question's answer in front (docs/design/desk-answers.md「放到前台」): a window of the desk with the question, every
// exchange of it — what was asked, the words and the cards that answered (the cards answerable here) — and a line to
// ask more on it (its follow-up lands on the same question, its task and its leaf). Opened by the desk's answers list
// (front), by voice 「打开给我看」, or on its own when the answer is to come up in front; the window event
// `ruyix-workbench:answer` { id } opens it again.
import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, MessageSquareText, Send } from 'lucide-react'
import css from './styles.css'
import tokens from '@ruyix/shell/tokens.css'
import { ASK_EVENT, STATE_EVENT } from './chat-state.js'
import { Answer, ChatCards } from './chat.jsx'
import { NS, call } from './data.js'
import { T, errorText, useT } from './ui.jsx'
import { namesOf } from './win-names.js'

export const ANSWER = `${NS}:answer`

function AnswerWindow({ id, lang }) {
  const t = useT()
  const [got, setGot] = useState(null)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState('')
  const load = () => call('chatAsk', { id, lang }).then(r => { setGot(r); setError(null) }, setError)
  useEffect(() => {
    load()
    // (while it is answered: again now and then; at once when the conversation moves)
    const on = () => load()
    window.addEventListener(STATE_EVENT, on)
    const timer = setInterval(load, 3000)
    return () => { window.removeEventListener(STATE_EVENT, on); clearInterval(timer) }
  }, [id, lang])
  const ask = e => {
    e.preventDefault()
    const q = draft.trim()
    if (!q) return
    setDraft('')
    window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { text: q, re: id } }))
    setTimeout(load, 600)
  }
  if (error) return <div className="wb-note wb-t-red"><AlertTriangle size={13} /> {errorText(t, error)}</div>
  if (!got) return <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div>
  const going = ['queued', 'working'].includes(got.ask.state)
  return (
    <div className="wb-aw">
      <div className="wb-aw-log">
        {got.items.map(i => (i.kind === 'user' ? <div key={i.n} className="wb-msg-user"><div>{i.text}</div></div>
          : i.kind === 'text' ? <Answer key={i.n} text={i.text} />
            : i.kind === 'cards' ? <ChatCards key={i.n} item={i} lang={lang} onDone={() => load()} send={(q, re) => window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { text: q, re: re || id } }))} />
              : i.kind === 'error' ? <div key={i.n} className="wb-note wb-t-red"><AlertTriangle size={13} /> {i.text}</div> : null))}
        {going && <div className="wb-sub wb-aw-going"><Loader2 size={13} className="wb-spin" />{t(got.ask.state === 'queued' ? 'aw.queued' : 'aw.working')}</div>}
      </div>
      <form className="wb-aw-ask" onSubmit={ask}>
        <input className="wb-input" value={draft} onChange={e => setDraft(e.target.value)} placeholder={t('aw.more')} aria-label={t('aw.more')} />
        <button type="submit" className="wb-btn wb-primary" disabled={!draft.trim()} aria-label={t('aw.send')}><Send size={14} /></button>
      </form>
    </div>
  )
}

/** Open a question's answer in front (`desk`: the shell's window.__ruyixDesk). → false when there is no desk to open it on. */
export function openAnswer(id, { desk = globalThis.window?.__ruyixDesk, t, lang = 'zh', title = '' } = {}) {
  if (!desk?.open || !id) return false
  // (in the desk's language: the page can change it while the window is open)
  const Content = ({ lang: now }) => (
    <T.Provider value={t}>
      <div className="wb-page wb-embedded wb-vw"><style>{tokens + css}</style><AnswerWindow id={id} lang={now || lang} /></div>
    </T.Provider>
  )
  desk.open({
    id: `answer:${id}`, title: title || t('aw.title'), ...(!title && { names: namesOf('aw.title') }), icon: MessageSquareText, Content, props: {}, size: { w: 760, h: 720 },
    reopen: { event: ANSWER, detail: { id, ...(title && { title }) } }, kind: 'page', hint: t('aw.title'),
  })
  return true
}
