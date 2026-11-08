// The run page's 结果 tab (lib/results.js): what the run made, in the viewer — the files its 结果 steps name, else what
// it changed since it began — with the person's comments kept on the run, and the run going on again from a step they
// pick, those comments in that step's brief. Each time it went on again is listed, with the comments it took along.
import { useEffect, useRef, useState } from 'react'
import { Loader2, Play, RotateCcw } from 'lucide-react'
import { call } from './data.js'
import { Viewer, useSaved } from './viewer.jsx'
import { ACTIVE, cx, errorText, useT, when } from './ui.jsx'

/** The run's results: { files, comments, steps, defaultFrom, restarts, declared } — again when the run changes. */
export function useResults(run) {
  const [data, setData] = useState(null)
  const request = useRef(0), current = useRef(run.id)
  current.current = run.id
  const load = () => {
    const seq = ++request.current, id = run.id
    return call('resultsOf', { id }).then(value => { if (seq === request.current && current.current === id) setData({ id, value }) }, () => { if (seq === request.current && current.current === id) setData(d => d?.id === id ? d : { id, value: { files: [], comments: [], steps: [], restarts: [], declared: false } }) })
  }
  useEffect(() => { load() }, [run.id, run.updatedAt, run.status])
  return [data?.id === run.id ? data.value : null, load]
}

export function ResultsTab({ run, data, reload, toast, initialFile, track = true }) {
  const t = useT()
  if (!data) return <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div>
  if (!data.files.length) return <div className="wb-empty-small">{t(ACTIVE.has(run.status) ? 'res.noneYet' : 'res.none')}</div>
  return <Results key={run.id} run={run} data={data} reload={reload} toast={toast} initialFile={initialFile} track={track} />
}

function Results({ run, data, reload, toast, initialFile, track }) {
  const t = useT()
  const saved = useSaved(data.comments, (comments, revision) => call('resultsSave', { id: run.id, comments, revision }), data.revision)
  useEffect(() => { saved.reset(data.comments, data.revision) }, [data.comments, data.revision])
  const defaultFrom = data.defaultFrom ?? data.steps.at(-1)?.key ?? ''
  const [selected, setFrom] = useState(defaultFrom)
  const from = data.steps.some(s => s.key === selected) ? selected : defaultFrom
  const [busy, setBusy] = useState(false)
  const openN = saved.comments.filter(c => c.status === 'open').length
  const stepName = key => data.steps.find(s => s.key === key)?.title || key
  const restart = async () => {
    if (!window.confirm(t(openN ? 'res.restartConfirm' : 'res.restartConfirmBare', { step: stepName(from), n: openN }))) return
    setBusy(true)
    try { await saved.flush(); await call('resultsRestart', { id: run.id, from }); toast?.('ok', t('res.restarted', { step: stepName(from) })); reload() } catch (err) { toast?.('error', errorText(t, err)) }
    setBusy(false)
  }
  return (
    <div className="wb-res">
      <Viewer run={run} files={data.files} initialPath={initialFile} track={track} comments={saved.comments} onComments={saved.change} open editable={!ACTIVE.has(run.status)} sentTo={stepName} className="wb-res-viewer"
        side={<>
          <p className="wb-sub wb-res-about">{t(data.declared ? 'res.aboutDeclared' : 'res.about')}</p>
          {saved.state && <span className={cx('wb-sub', !['saving', 'saved'].includes(saved.state) && 'wb-c-red')}>{saved.state === 'saving' ? t('rv.saving') : saved.state === 'saved' ? t('rv.saved') : saved.state}</span>}
          {data.steps.length > 0 && (
            <div className="wb-res-restart">
              <span>{t('res.goOn')}</span>
              <select className="wb-input" value={from} onChange={e => setFrom(e.target.value)} aria-label={t('res.goOnFrom')}>{data.steps.map(s => <option key={s.key} value={s.key}>{s.title}</option>)}</select>
              <button className={cx('wb-btn wb-small', openN > 0 && 'wb-primary')} disabled={busy || !from} onClick={restart}>{busy ? <Loader2 size={12} className="wb-spin" /> : <Play size={12} />}{t(openN ? 'res.restartWith' : 'res.restart', { n: openN })}</button>
            </div>
          )}
          {data.restarts.length > 0 && (
            <ul className="wb-res-history">
              {data.restarts.slice().reverse().map(r => <li key={r.n} className="wb-sub"><RotateCcw size={11} /> {t('res.wentOn', { step: stepName(r.from), n: r.comments.length, when: when(r.at) })}</li>)}
            </ul>
          )}
        </>} />
    </div>
  )
}
