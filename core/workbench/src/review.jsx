// A review (lib/review.js) on its decision card ('workbench.review'): a line of what waits there and a button; the review
// itself opens large, over the page this card is on — the viewer (src/viewer.jsx) with the round's files, the person's
// comments and the agent's answers, the round before to compare with — and at its foot the choices: approve, revise
// with my notes, send it back to a step the person picks, stop. Comments are saved as they are written (reviewSave).
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Loader2, MessageSquareText, Pencil, RotateCcw, X, XCircle } from 'lucide-react'
import { call, decisionEditor, useExtVersion } from './data.js'
import { Viewer, useSaved } from './viewer.jsx'
import { cx, errorText, optionDoes, optionLabel, useT } from './ui.jsx'

/** The review, large: the viewer, and the choices at its foot. */
function ReviewWindow({ a, run, review, setReview, open, busy, onDecide, onClose, packProps, displayBlocked, setDisplayBlocked, displayDirty, setDisplayDirty, fileDirty, setFileDirty, fileSaving, setFileSaving }) {
  const t = useT()
  const ext = useExtVersion()
  const display = useMemo(() => (a.payload?.review?.display ? decisionEditor(a.payload.review.display) : null), [a.payload?.review?.display, ext])
  // (the pack's display calls the pack's own ops)
  const shown = display && { Editor: display.Editor, props: { ...packProps, onBlocked: setDisplayBlocked, onDirty: setDisplayDirty, call: (op, args) => call(String(op).includes('.') ? op : `${display.packId}.${op}`, args) } }
  const saved = useSaved(review.comments || [], async (comments, revision) => { const r = await call('reviewSave', { id: run.id, stage: a.payload.stage, comments, revision }); setReview(r.review); return { comments: r.review.comments, revision: r.review.commentsRevision } }, review.commentsRevision)
  const dirty = useRef(displayDirty || fileDirty)
  dirty.current = displayDirty || fileDirty
  const saving = useRef(fileSaving)
  saving.current = fileSaving
  const close = async () => {
    if (saving.current) return
    try {
      await saved.flush()
      if (saving.current) return
      if (!dirty.current || window.confirm(t('rv.discardEditor'))) onClose()
    } catch { if (!saving.current && window.confirm(t('rv.discardUnsaved'))) onClose() }
  }
  const backTo = a.payload?.review?.backTo || []
  const revise = (a.payload?.options || []).find(o => o.action === 'revise')
  const [back, setBack] = useState(revise?.from || backTo.at(-1)?.key || '')
  const prev = review.rounds?.find(x => x.n === review.round - 1)
  const openN = saved.comments.filter(c => c.status === 'open').length
  const [hold, setHold] = useState(false) // a draft open in the viewer: Escape closes it, not the review
  const blocked = useRef(displayBlocked || fileDirty)
  blocked.current = displayBlocked || fileDirty
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape' && !hold && !e.defaultPrevented) close() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [hold, displayDirty, fileDirty, fileSaving])
  const decide = async (i, extra) => {
    const mayDiscard = ['stop', 'revise'].includes(a.payload?.options?.[i]?.action)
    if (saving.current || (blocked.current && !mayDiscard)) return
    try {
      await saved.flush()
      // The editor can change while comments are being saved over the network.
      if (saving.current || (blocked.current && !mayDiscard)) return
      if (mayDiscard && dirty.current && !window.confirm(t('rv.discardEditor'))) return
      await onDecide(i, extra)
    } catch { /* saved.state keeps the save failure visible */ }
  }
  const stepName = key => backTo.find(b => b.key === key)?.title || key
  return (
    <div className="wb-rv-wrap" onMouseDown={e => { if (e.target === e.currentTarget) close() }} onFocusCapture={e => setHold(e.target.tagName === 'TEXTAREA')} onBlurCapture={() => setHold(false)}>
      <div className="wb-rv" role="dialog" aria-label={a.title}>
        <header className="wb-rv-head">
          <h3>{a.title}</h3>
          <span className="wb-tag">{t('rv.roundOf', { n: review.round, max: review.max })}</span>
          {saved.state && <span className={cx('wb-sub', !['saving', 'saved'].includes(saved.state) && 'wb-c-red')}>{saved.state === 'saving' ? t('rv.saving') : saved.state === 'saved' ? t('rv.saved') : saved.state}</span>}
          <button className="wb-icon-btn" disabled={fileSaving} onClick={close} title={t('rv.close')}><X size={16} /></button>
        </header>
        <Viewer run={run} files={review.files || []} comments={saved.comments} onComments={saved.change} onDirty={setFileDirty} onSaving={setFileSaving} open={open} editable={open}
          compare={prev ? { n: prev.n, from: prev.version, to: review.version } : null} display={shown}
          side={<>
            {review.status === 'revising' && <div className="wb-note wb-t-blue"><Loader2 size={13} className="wb-spin" /> {t('rv.revising', { who: review.agent })}</div>}
            {prev?.summary && <div className="wb-rv-last"><b>{t('rv.lastRound', { n: prev.n, who: prev.by })}</b><p>{prev.summary}</p></div>}
          </>} />
        {open && (
          <footer className="wb-rv-foot">
            {(a.payload?.options || []).map((o, i) => {
              const amend = o.action === 'amend', sendBack = o.action === 'revise'
              const button = (
                <button key={i} className={cx('wb-btn', (amend ? openN > 0 : o.action === 'accept' && !openN) && 'wb-primary', o.action === 'stop' && 'wb-rv-stop')} disabled={busy || fileSaving || review.status !== 'person' || (amend && !openN) || ((displayBlocked || fileDirty) && !['stop', 'revise'].includes(o.action))}
                  title={amend && !openN ? t('rv.needComment') : optionDoes(t, o)} onClick={() => decide(i, sendBack && back ? { from: back } : undefined)}>
                  {o.action === 'accept' ? <CheckCircle2 size={13} /> : amend ? <Pencil size={13} /> : o.action === 'stop' ? <XCircle size={13} /> : <RotateCcw size={13} />}
                  {sendBack ? t('rv.backTo', { step: stepName(back) }) : optionLabel(t, o.label)}{amend && openN > 0 ? ` (${openN})` : ''}
                </button>
              )
              // sent back: to the step picked here (those before the review)
              return sendBack && backTo.length > 1
                ? <span key={i} className="wb-rv-back"><select className="wb-input" value={back} onChange={e => setBack(e.target.value)} aria-label={t('rv.backWhich')}>{backTo.map(b => <option key={b.key} value={b.key}>{b.title}</option>)}</select>{button}</span>
                : button
            })}
          </footer>
        )}
      </div>
    </div>
  )
}

/** On the decision card: { a, run, open, busy, choice, option, onPayload, onBlocked, onDecide, call }. */
export function ReviewEditor(props) {
  const { a, run, open, option, onBlocked, onDecide } = props
  const t = useT()
  const [review, setReview] = useState(null)
  const [error, setError] = useState('')
  const [shown, setShown] = useState(false)
  const [displayBlocked, setDisplayBlocked] = useState(false)
  const [displayDirty, setDisplayDirty] = useState(false)
  const [fileDirty, setFileDirty] = useState(false)
  const [fileSaving, setFileSaving] = useState(false)
  useEffect(() => { if (!shown) { setDisplayBlocked(false); setDisplayDirty(false); setFileDirty(false); setFileSaving(false) } }, [shown])
  const here = useRef(null)
  useEffect(() => {
    let off = false
    call('reviewOf', { id: run.id, stage: a.payload.stage }).then(r => off || setReview(r.review), err => off || setError(errorText(t, err)))
    return () => { off = true }
  }, [run.id, a.id, a.status])
  const openN = (review?.comments || []).filter(c => c.status === 'open').length
  // the card's own picker: "revise with my notes" needs a comment first
  useEffect(() => { onBlocked?.(fileSaving || (option?.action === 'amend' && !openN) || ((displayBlocked || fileDirty) && !['stop', 'revise'].includes(option?.action))) }, [option?.action, openN, displayBlocked, fileDirty, fileSaving])
  if (error) return <div className="wb-note wb-t-red">{error}</div>
  if (!review) return <Loader2 size={14} className="wb-spin" />
  const answered = review.comments.filter(c => c.sentIn && c.status !== 'open').length
  return (
    <div className="wb-rv-card" ref={here}>
      <span className="wb-sub">{t('rv.cardLine', { n: review.round, files: (review.files || []).length, open: openN, answered })}</span>
      <button className={cx('wb-btn wb-small', open && 'wb-primary')} onClick={() => setShown(true)}><MessageSquareText size={12} />{t(open ? 'rv.open' : 'rv.look')}</button>
      {/* (over the page this card is on — its window, like the page's other dialogs) */}
      {shown && createPortal(<ReviewWindow {...props} review={review} setReview={setReview} packProps={props} displayBlocked={displayBlocked} setDisplayBlocked={setDisplayBlocked} displayDirty={displayDirty} setDisplayDirty={setDisplayDirty} fileDirty={fileDirty} setFileDirty={setFileDirty} fileSaving={fileSaving} setFileSaving={setFileSaving} onDecide={(i, extra) => { setShown(false); onDecide?.(i, extra) }} onClose={() => setShown(false)} />,
        here.current?.closest('.wb-page') || document.body)}
    </div>
  )
}
