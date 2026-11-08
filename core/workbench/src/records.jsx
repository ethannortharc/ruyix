// 记录 (docs/design/agent-work.md §3): all the agents' work in one list — the workflow runs, the resident sessions, the
// pool's own jobs (the `records` op, lib/records.js) — by day, by task or by agent; searched, narrowed to a kind; each
// row what it was, who did it, how it ended, how long, what it cost, what it made — a click opens its whole story (the
// run's page, the session's conversation, the job). `studio`: only that studio's runs (a studio's 历史 embeds it).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Bot, FileText, Loader2, MessagesSquare, Search, Workflow, X } from 'lucide-react'
import { call } from './data.js'
import { groupRecords } from '../lib/records.js'
import { dateLoc, cx, dur, errorText, useT } from './ui.jsx'
import { money } from '@ruyix/shell/money'

const KINDS = ['run', 'session', 'job']
const KIND_ICON = { run: Workflow, session: MessagesSquare, job: Bot }
const GROUPS = ['day', 'task', 'agent']
const PAGE = 150
const day = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }
const tokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const local = { get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } } }

/** A day's heading: 今天 / 昨天 / 10月16日 周五. */
function dayName(t, ts, now) {
  const d = day(ts), today = day(now)
  if (d === today) return t('rec.today')
  if (d === today - 864e5) return t('rec.yesterday')
  return new Date(ts).toLocaleDateString(t('lang.code') === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric', weekday: 'short', ...(new Date(ts).getFullYear() !== new Date(now).getFullYear() && { year: 'numeric' }) })
}

function Row({ x, now, onOpen }) {
  const t = useT()
  const Icon = KIND_ICON[x.kind] || FileText
  const took = x.startedAt ? (x.endedAt || now) - x.startedAt : null
  return (
    <button type="button" className={cx('wb-rec', `wb-rec-${x.state}`, x.archived && 'wb-rec-archived')} onClick={() => onOpen(x)} title={x.said || x.title}>
      <span className={cx('wb-rec-kind', `wb-rec-k-${x.kind}`)}><Icon size={14} /></span>
      <span className="wb-rec-main">
        <b>{x.title}</b>
        <span className="wb-rec-sub">
          {[x.kind === 'run' ? x.sub : t(`rec.kind.${x.kind}`), x.task && x.task.title !== x.title && x.task.title, x.said].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="wb-rec-agents">
        {x.agents.slice(0, 3).map(a => <span key={a.id} className={cx('wb-rec-agent', `wb-rt-${a.runtime || 'dsh'}`)} title={[a.id, a.model].filter(Boolean).join(' · ')}><i />{a.id}</span>)}
        {x.agents.length > 3 && <span className="wb-rec-more">+{x.agents.length - 3}</span>}
      </span>
      <span className={cx('wb-rec-state', `wb-rec-s-${x.state}`)}>{(x.state === 'working' || x.state === 'waiting') && <i />}{t(`rec.state.${x.state}`)}</span>
      <span className="wb-rec-num" title={t('rec.took')}>{took !== null ? dur(took) : '—'}</span>
      <span className="wb-rec-num" title={t('rec.usage')}>{x.tokens ? tokens(x.tokens) : '—'}{x.cost ? <small> {money(x.cost)}</small> : null}</span>
      <span className="wb-rec-num" title={t(x.kind === 'session' ? 'rec.turns' : x.kind === 'job' ? 'rec.tasks' : 'rec.files')}>
        {x.kind === 'run' ? (x.files ? <span className="wb-rec-files" role="link" title={t('rec.viewResults')} onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('ruyix-workbench:view', { detail: { run: x.id.slice(4) } })) }}><FileText size={11} />{x.files}</span> : '—')
          : x.kind === 'session' ? <span className="wb-rec-files" role="link" title={t('rec.viewFiles')} onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('ruyix-workbench:view', { detail: { session: x.id.slice(8), title: x.title } })) }}><FileText size={11} />{x.turns ? `${x.turns}${t('rec.turnsUnit')}` : t('rec.files')}</span>
          : x.turns ? `${x.turns}${t(x.kind === 'session' ? 'rec.turnsUnit' : 'rec.tasksUnit')}` : '—'}
      </span>
      <span className="wb-rec-time">{new Date(x.at).toLocaleTimeString(dateLoc(), { hour: '2-digit', minute: '2-digit' })}</span>
    </button>
  )
}

export function RecordsView({ toast, onRun, studio = null, now: given }) {
  const t = useT()
  const [q, setQ] = useState('')
  const [by, setBy] = useState(() => (GROUPS.includes(local.get('ruyix-workbench.recBy', 'day')) ? local.get('ruyix-workbench.recBy', 'day') : 'day'))
  const [kind, setKind] = useState(studio ? 'run' : 'all')
  const [archived, setArchived] = useState(false)
  const [data, setData] = useState({ items: [], more: false, ready: false })
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(Date.now())
  const ask = useRef(0), shown = useRef(''), loaded = useRef(null)
  const filter = JSON.stringify([q, kind, archived, studio])
  shown.current = filter
  useEffect(() => { local.set('ruyix-workbench.recBy', by) }, [by])
  // the list, again when what is asked changes (the words after a pause) and every half minute while it is shown
  useEffect(() => {
    const n = ++ask.current
    if (loaded.current !== filter) { loaded.current = filter; setData({ items: [], more: false, ready: false }); setBusy(false) }
    const go = () => call('records', { q, kinds: kind === 'all' ? KINDS : [kind], archived, limit: PAGE, ...(studio && { studio }) })
      .then(r => { if (n === ask.current && shown.current === filter) { setData({ items: r.items || [], more: !!r.more, ready: true }); setNow(Date.now()) } })
      .catch(err => { if (n === ask.current && shown.current === filter) { setData(d => ({ ...d, ready: true })); toast?.('error', errorText(t, err)) } })
    const timer = setTimeout(go, q ? 250 : 0)
    return () => clearTimeout(timer)
  }, [q, kind, archived, studio, tick])
  useEffect(() => { const i = setInterval(() => { if (!document.hidden) setTick(x => x + 1) }, 30000); return () => clearInterval(i) }, [])
  const more = async () => {
    const n = ask.current
    setBusy(true)
    try {
      const r = await call('records', { q, kinds: kind === 'all' ? KINDS : [kind], archived, limit: PAGE, before: data.items.at(-1) && { at: data.items.at(-1).at, id: data.items.at(-1).id }, ...(studio && { studio }) })
      if (n !== ask.current || shown.current !== filter) return
      setData(d => ({ items: [...d.items, ...(r.items || []).filter(x => !d.items.some(y => y.id === x.id))], more: !!r.more, ready: true }))
    } catch (err) { if (n === ask.current && shown.current === filter) toast?.('error', errorText(t, err)) }
    if (n === ask.current && shown.current === filter) setBusy(false)
  }
  const words = { kind: k => t(`rec.kinds.${k}`), noAgent: t('rec.noAgent') }
  const groups = useMemo(() => groupRecords(data.items, by, words), [data.items, by, t])
  const open = x => {
    if (x.kind === 'run' && onRun) return onRun(x.id.slice(4))
    window.dispatchEvent(new CustomEvent(x.open.event, { detail: x.open.detail }))
  }
  const total = data.items.reduce((s, x) => ({ tokens: s.tokens + x.tokens, cost: s.cost + x.cost }), { tokens: 0, cost: 0 })
  return (
    <div className="wb-view wb-pad wb-records">
      <div className="wb-rec-tools">
        <label className="wb-search wb-rec-search"><Search size={14} /><input placeholder={t('rec.search')} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQ('')} />{q && <button className="wb-icon-btn" aria-label={t('rec.clear')} onClick={() => setQ('')}><X size={12} /></button>}</label>
        {!studio && <div className="wb-seg" role="tablist" aria-label={t('rec.kindLabel')}>
          {['all', ...KINDS].map(k => <button key={k} role="tab" aria-selected={kind === k} className={cx(kind === k && 'wb-on')} onClick={() => setKind(k)}>{t(`rec.kinds.${k}`)}</button>)}
        </div>}
        <div className="wb-seg" role="tablist" aria-label={t('rec.byLabel')}>
          {GROUPS.map(g => <button key={g} role="tab" aria-selected={by === g} className={cx(by === g && 'wb-on')} onClick={() => setBy(g)}>{t(`rec.by.${g}`)}</button>)}
        </div>
        <label className="wb-check wb-rec-arch"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /><Archive size={12} />{t('rec.archived')}</label>
      </div>
      {data.ready && data.items.length > 0 && <p className="wb-sub wb-rec-total">{t('rec.total', { n: data.items.length + (data.more ? '+' : '') })}{total.tokens ? ` · ${tokens(total.tokens)} tokens` : ''}{total.cost ? ` · ${money(total.cost)}` : ''}</p>}
      {!data.ready && <div className="wb-skeleton">{[0, 1, 2, 3].map(i => <span key={i} />)}</div>}
      {data.ready && !data.items.length && <div className="wb-empty wb-rec-empty"><FileText size={22} /><p>{t(q ? 'rec.noneFound' : 'rec.none')}</p></div>}
      {groups.map(g => (
        <section key={g.key} className="wb-rec-group">
          <h3 className="wb-rec-head">
            {by === 'agent' && <span className={cx('wb-rec-agent', `wb-rt-${g.runtime || 'dsh'}`)}><i /></span>}
            <span>{g.day ? dayName(t, g.day, now) : g.title}</span><span className="wb-count">{g.items.length}</span>
          </h3>
          <div className="wb-rec-list">{g.items.map(x => <Row key={`${g.key}:${x.id}`} x={x} now={now} onOpen={open} />)}</div>
        </section>
      ))}
      {data.more && <button className="wb-btn wb-rec-moreBtn" disabled={busy} onClick={more}>{busy ? <Loader2 size={13} className="wb-spin" /> : null}{t('rec.loadMore')}</button>}
    </div>
  )
}
