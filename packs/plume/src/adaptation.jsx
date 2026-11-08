import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { dateText, knowledgeStale, knowledgeUsable, openRun } from './knowledge.jsx'
import { tr } from './locale.js'

/** The content check belongs to a particular saved digest; typing never inherits the previous version's pass. */
export function AdaptationReview({ p, run, lang, call, disabled, dirty }) {
  const t = tr(lang), [busy, setBusy] = useState(false), [error, setError] = useState(''), [reviewRun, setReviewRun] = useState(null)
  const live = useRef(true), pending = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const review = p.adaptation, knowledge = p.knowledge
  const usableKnowledge = knowledgeUsable(knowledge)
  const hasReview = !!(review?.digest || review?.checkedAt)
  const passed = !p.frozen && !dirty && review?.current && review?.passed
  const recheck = async () => {
    if (pending.current || disabled || p.frozen) return
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await call('recheckAdaptation', { run: run.id, platform: p.id, expectedDigest: p.digest })
      if (live.current) setReviewRun(result.run)
    } catch (e) { if (live.current) setError(e.message) }
    finally { pending.current = false; if (live.current) setBusy(false) }
  }
  const reviewDetails = <>
    {review?.summary && <p>{review.summary}</p>}
    {!!review?.checks?.length && <ul>{review.checks.map((check, i) => <li key={`${check.dimension}:${i}`}><strong>{t(`dimension.${check.dimension}`)}</strong> · {t(`adaptation.${check.verdict}`)}<span>{check.reason}</span></li>)}</ul>}
    {!!review?.units?.some(unit => unit.verdict === 'unsupported') && <div><strong>{t('adaptation.unsupported')}</strong><ul>{review.units.filter(unit => unit.verdict === 'unsupported').map(unit => <li key={unit.id}>{unit.text}<span>{unit.reason}</span></li>)}</ul></div>}
    {review?.checkedAt && <small>{t('adaptation.checked')} {dateText(review.checkedAt, lang)}</small>}
  </>
  return <section className="pl-adaptation" aria-label={t('adaptation.title')}>
    <h5>{t('adaptation.title')}</h5>
    <p className={passed ? 'pl-ok' : 'pl-adaptation-pending'}>{passed && <CheckCircle2 size={13} />}{t(p.frozen ? 'adaptation.frozen' : dirty ? 'adaptation.dirty' : passed ? 'adaptation.passed' : review?.current ? 'adaptation.changes' : 'adaptation.pending')}</p>
    {!p.frozen && hasReview && (!review.current || dirty) && <p className="pl-adaptation-pending">{t('adaptation.previous')}</p>}
    {p.frozen ? hasReview ? <details className="pl-adaptation-history"><summary>{t('adaptation.history')}</summary>{reviewDetails}</details> : <p>{t('adaptation.noHistory')}</p> : hasReview && reviewDetails}
    {knowledge && <details className="pl-adaptation-knowledge"><summary>{t(usableKnowledge ? 'adaptation.knowledge' : 'adaptation.savedKnowledge')} · {t('knowledge.version')} {knowledge.revision}{!usableKnowledge ? ` · ${t('knowledge.excluded')}` : knowledgeStale(knowledge) ? ` · ${t('knowledge.stale')}` : ''}</summary><p>{usableKnowledge ? knowledge.summary : t('knowledge.unverifiedSnapshot')}</p><small>{t('knowledge.updated')} {dateText(knowledge.researchedAt, lang)}</small></details>}
    {!p.frozen && <div className="pl-form-actions"><button className="wb-btn wb-small" disabled={disabled || busy} onClick={recheck}>{busy ? <Loader2 size={12} className="wb-spin" /> : <RefreshCw size={12} />}{t('adaptation.recheck')}</button></div>}
    {!p.frozen && reviewRun && <p className="pl-adaptation-run">{t('adaptation.started')} <button className="wb-btn wb-small" onClick={() => openRun(reviewRun.id)}>{t('adaptation.open')}</button></p>}
    {!p.frozen && error && <p className="wb-t-red" role="alert">{error}</p>}
  </section>
}
