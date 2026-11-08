// The desk's 「智能体」 widget (Ethan 2026-10-19, from the Aviary prototype): every agent of the pool on a line — what it
// does now (a session's turn, a pool task it leads, a workflow's step: window.__ruyixActivity), or, idle, what it did
// last and when. Each in its kind's colour (@ruyix/shell/agent-colors, as on the strip of the work going on); those at
// work first. A click opens what it is at: the session, the pool task, the run; idle, the agents page. In the widget
// gallery (`preview`) it shows sample agents and reads nothing.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { agentColor } from '@ruyix/shell/agent-colors'
import { useHubStore } from './data.js'
import { en, zh } from './locale.js'

const fmt = (s, p = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] ?? m))
const wordsOf = lang => (key, params) => fmt((lang === 'zh' ? zh : en)[key] ?? key, params)
const INITIALS = { claude: 'CL', codex: 'CX', dsh: 'DS', pi: 'PI' }
const initials = a => INITIALS[a.runtime] || String(a.name || a.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '··'
const hm = at => { const d = new Date(at); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` }
const send = (event, detail) => window.dispatchEvent(new CustomEvent(event, { detail }))

/** The workflow steps at work now, by pool agent (the workbench's activity: window.__ruyixActivity, 'ruyix:activity'). */
function useRunSteps() {
  const read = () => (window.__ruyixActivity?.agents || []).filter(a => a.name && a.run)
  const [v, setV] = useState(read)
  useEffect(() => { const on = () => setV(read()); window.addEventListener('ruyix:activity', on); on(); return () => window.removeEventListener('ruyix:activity', on) }, [])
  return v
}

/** Each agent of the pool: { agent, doing: { what, step, open } | null, last: { what, at, open } | null }, at work first. */
function linesOf(s, steps) {
  const sessions = [...s.sessions.values()], jobs = [...s.jobs.values()]
  return [...s.agents.values()].filter(a => !a.deleted).map(a => {
    const ses = sessions.filter(x => x.agent === a.id), job = jobs.filter(x => x.leadAgent === a.id)
    const busy = ses.find(x => x.state === 'working'), lead = job.find(x => x.status === 'running'), step = steps.find(x => x.name === a.id)
    const doing = step ? { what: step.title, step: step.stepTitle || step.step, waiting: step.state === 'waiting', open: () => send('ruyix:open', { panel: 'ruyix-tasks', run: step.run }) }
      : busy ? { what: busy.title, step: busy.now?.tool || '', open: () => send('agent-hub:open', { tab: 'sessions', session: busy.id }) }
        : lead ? { what: lead.title, step: '', open: () => send('agent-hub:open', { tab: 'tasks', select: { kind: 'job', id: lead.id } }) } : null
    const lastSes = ses.filter(x => x.lastAt).sort((x, y) => y.lastAt - x.lastAt)[0], lastJob = job.filter(x => x.endedAt).sort((x, y) => y.endedAt - x.endedAt)[0]
    const last = (lastSes?.lastAt || 0) >= (lastJob?.endedAt || 0)
      ? lastSes && { what: lastSes.title, at: lastSes.lastAt, open: () => send('agent-hub:open', { tab: 'sessions', session: lastSes.id }) }
      : { what: lastJob.title, at: lastJob.endedAt, open: () => send('agent-hub:open', { tab: 'tasks', select: { kind: 'job', id: lastJob.id } }) }
    return { agent: a, doing, last: last || null }
  }).sort((x, y) => (!!y.doing - !!x.doing) || ((y.last?.at || 0) - (x.last?.at || 0)))
}

const SAMPLE = [
  { agent: { id: 's1', name: 'codex', runtime: 'codex' }, doing: { what: '寒流预警 v4', step: '渲染' } },
  { agent: { id: 's2', name: 'claude', runtime: 'claude' }, doing: { what: '整理今天的邮件', step: '' } },
  { agent: { id: 's3', name: 'dsh', runtime: 'dsh' }, doing: null, last: { what: '今天是星期几？', at: new Date().setHours(14, 5, 0, 0) } },
]

function Lines({ lines, lang, preview, rows }) {
  const w = wordsOf(lang)
  const busy = lines.filter(l => l.doing).length
  return (
    <>
      <div className="ad-w-cap"><span>{w('dw.agents')}</span>{lines.length > 0 && <small>{w('dw.atWork', { a: busy, n: lines.length })}</small>}</div>
      {!lines.length && <p className="ad-w-p ad-w-quiet">{w('dw.noAgents')}</p>}
      {lines.slice(0, rows).map(({ agent: a, doing, last }) => {
        const color = agentColor(a.runtime === 'dsh' ? 'dsh' : a.runtime)
        const line = doing ? [w(doing.waiting ? 'dw.waits' : 'dw.doing'), doing.what, doing.step].filter(Boolean).join(' · ')
          : last ? w('dw.idleLast', { t: hm(last.at), what: last.what || '' }) : w('dw.idle')
        const open = doing?.open || last?.open || (() => send('agent-hub:open', { tab: 'agents' }))
        return (
          <button key={a.id} type="button" className="ad-w-ag" onClick={() => !preview && open()}>
            <span className="ad-w-av" style={doing ? { color } : undefined}>{initials(a)}<i style={doing ? { background: color } : undefined} /></span>
            <span className="ad-w-who"><b>{a.name || a.id}</b><span>{line}</span></span>
          </button>
        )
      })}
    </>
  )
}

function Live({ lang, rows }) {
  const [s] = useHubStore(4000)
  const steps = useRunSteps()
  if (!s.ready) return <div className="ad-w-cap"><span>{wordsOf(lang)('dw.agents')}</span></div>
  return <Lines lines={linesOf(s, steps)} lang={lang} rows={rows} />
}

export function AgentsWidget({ size, lang, preview }) {
  // (dragged taller, it shows more of the pool)
  const box = useRef(null), [rows, setRows] = useState(size === 'sm' ? 2 : 4)
  useLayoutEffect(() => {
    const el = box.current?.closest('.ad-w')
    if (!el || typeof ResizeObserver === 'undefined') return
    const base = size === 'sm' ? 2 : 4
    const ro = new ResizeObserver(() => { const h = el.style.height ? el.getBoundingClientRect().height : 0; setRows(h ? Math.max(base, Math.min(12, Math.floor((h - 48) / 38))) : base) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [size])
  return <div ref={box}>{preview ? <Lines lines={SAMPLE} lang={lang} preview rows={rows} /> : <Live lang={lang} rows={rows} />}</div>
}

/** The widget as the desk takes it (window.__ruyixWidgetDefs; the shell's widgets.jsx). */
export const AGENTS_WIDGET = { type: 'agent-hub:agents', name: { zh: '智能体', en: 'Agents' }, sizes: ['sm', 'md'], default: 'md', order: 20, render: AgentsWidget }
