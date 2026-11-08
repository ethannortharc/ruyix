// The run page's 留言 tab (lib/messages.js): what the run's agents said to each other while they worked — who to whom,
// what it answers, the files it names — oldest first. Beside the ledger, not in it: the person reads here, and speaks
// to the run the usual way (a review, an answer, a note when going on).
import { useEffect, useState } from 'react'
import { ArrowRight, ChevronDown, ChevronRight, FileText, Loader2, MessagesSquare, Reply } from 'lucide-react'
import { call } from './data.js'
import { useT, when } from './ui.jsx'

/** The run's messages: { on, messages, members } — fetched again every 3 s while `live`. null until the first answer. */
export function useRunMessages(runId, live) {
  const [state, setState] = useState(null)
  useEffect(() => {
    let off = false, timer = null
    const load = () => call('runMessages', { id: runId })
      .then(r => { if (!off) setState(r) }, () => {})
      .finally(() => { if (!off && live) timer = setTimeout(load, 3000) })
    load()
    return () => { off = true; clearTimeout(timer) }
  }, [runId, live])
  return state
}

export function MessagesTab({ data, onFiles }) {
  const t = useT()
  if (!data) return <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div>
  if (!data.messages.length) return <div className="wb-empty-small">{t(data.on ? 'msg.none' : 'msg.off')}</div>
  const byId = new Map(data.messages.map(m => [m.id, m]))
  return (
    <div className="wb-msgs">
      <p className="wb-sub">{t('msg.about', { n: data.members.length })}</p>
      <ol className="wb-msg-list">
        {data.messages.map(m => {
          const re = m.replyTo ? byId.get(m.replyTo) : null
          return (
            <li key={m.id} className="wb-msg">
              <div className="wb-msg-head">
                <b>{m.from}</b><ArrowRight size={11} /><span>{m.to || t('msg.everyone')}</span>
                {m.topic !== 'general' && <span className="wb-tag">{m.topic}</span>}
                <span className="wb-dim wb-msg-when">#{m.id} · {when(m.at)}</span>
              </div>
              {re && <div className="wb-msg-re"><Reply size={11} /><span><b>{re.from}</b> {re.text.slice(0, 140)}{re.text.length > 140 ? '…' : ''}</span></div>}
              <div className="wb-msg-text">{m.text}</div>
              {m.files.length > 0 && (
                <div className="wb-msg-files">
                  {m.files.map(f => <button key={f} className="wb-linkbtn" onClick={() => onFiles?.({ path: f })}><FileText size={11} /> {f}</button>)}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** In the 过程 page's side: the same messages, closed until the person opens it (they rarely need to; they can). */
export function MessagesPanel({ data, onFiles }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!data || (!data.on && !data.messages.length)) return null
  return (
    <section className="wb-card wb-msg-panel">
      <button className="wb-msg-toggle" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<MessagesSquare size={14} />{t('msg.panel')}<span className="wb-count">{data.messages.length}</span>
      </button>
      {open && <MessagesTab data={data} onFiles={onFiles} />}
    </section>
  )
}
