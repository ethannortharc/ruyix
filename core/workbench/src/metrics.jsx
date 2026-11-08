// Metrics: how the runs go — success rate, time and cost, overall and per workflow, and the latest runs.
import { useEffect, useState } from 'react'
import { BarChart3, RotateCcw, Workflow } from 'lucide-react'
import { call } from './data.js'
import { useT, useWorkflowData, verdictText, word } from './ui.jsx'
import { money } from '@ruyix/shell/money'

const pct = x => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`)
const num = (x, d = 0) => (x === null || x === undefined ? '—' : x.toFixed(d))

function Group({ title, g, icon: Icon }) {
  const t = useT()
  return (
    <section className="wb-card wb-metric">
      <h3>{Icon && <Icon size={14} />}{title}</h3>
      <div className="wb-metric-grid">
        <div><b>{pct(g.successRate)}</b><span>{t('m.success')}</span></div>
        <div><b>{g.finished}/{g.runs}</b><span>{t('m.finished')}</span></div>
        <div><b>{num(g.avgMinutes)}</b><span>{t('m.minutes')}</span></div>
        <div><b>{g.avgTokens ? `${Math.round(g.avgTokens / 1000)}k` : '—'}</b><span>{t('m.tokens')}</span></div>
        <div><b>{g.avgCost ? money(g.avgCost) : '—'}</b><span>{t('m.cost')}</span></div>
      </div>
      {Object.keys(g.verdicts).length > 0 && <div className="wb-chips">{Object.entries(g.verdicts).map(([v, n]) => <span key={v} className="wb-tag">{word(t, `verdict.${v}`, word(t, `status.${v}`, v))} · {n}</span>)}</div>}
    </section>
  )
}

export function MetricsView({ toast, onRun }) {
  const t = useT()
  const data = useWorkflowData()
  const [m, setM] = useState(null)
  const load = () => call('metrics').then(setM, err => toast('error', err.message))
  useEffect(() => { load() }, [])
  if (!m) return <div className="wb-empty-small">{t('loading')}</div>
  const nameOf = id => data?.builtIn?.find(b => b.id === id)?.title || data?.mine?.find(d => d.id === id)?.title || id
  return (
    <div className="wb-view wb-pad">
      <h2 className="wb-h">{t('nav.metrics')} <button className="wb-icon-btn" onClick={load}><RotateCcw size={14} /></button></h2>
      <div className="wb-metric-row">
        <Group title={t('m.all')} g={m.all} icon={BarChart3} />
        {Object.entries(m.byTemplate).map(([k, g]) => <Group key={k} title={nameOf(k)} g={g} icon={Workflow} />)}
      </div>
      <section className="wb-card">
        <h3>{t('m.recent')}</h3>
        <table className="wb-table">
          <thead><tr><th /><th>{t('m.subject')}</th><th>{t('m.workflow')}</th><th>{t('m.verdict')}</th><th>{t('m.minutes')}</th><th>{t('m.tasks')}</th><th>{t('m.tokens')}</th></tr></thead>
          <tbody>
            {m.recent.map(r => (
              <tr key={r.id}>
                <td><button className="wb-linkbtn" onClick={() => onRun(r.id)}>{r.id}</button></td>
                <td>{String(r.title || '').slice(0, 60)}</td>
                <td className="wb-dim">{nameOf(r.template)}</td>
                <td>{r.verdict ? verdictText(t, r.verdict) : t(`status.${r.status}`)}</td>
                <td>{num(r.minutes)}</td>
                <td>{r.tasks}</td>
                <td>{r.tokens ? `${Math.round(r.tokens / 1000)}k` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
