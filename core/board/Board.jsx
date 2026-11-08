// A dashboard drawn from its datasets' snapshots — the one renderer of Ruyix's boards (a Boards page, a board drawn in a
// conversation). It reads nothing itself: the host hands it the description, the specs and the snapshots, and
// gets back only actions by name (onAction(op, args)) — which it maps and checks. Styles: board.css, themed through
// --board-* properties (each falls back to Ruyix's --ruyix-* tokens). Every widget says plainly which of the five it is in:
// loading, error, no permission, empty, stale — and still shows the last good rows when the newest run failed.
import { useMemo, useState } from 'react'
import { ACTIONS, datasetOf, derive, refOf, shapeRows, stateOf } from './schema.js'

const TEXT = {
  zh: {
    loading: '等待首次数据…', error: '读取失败', denied: '你没有查看这份数据的权限', unset: '未授权：这份数据还没有设置由谁来读取', empty: '没有数据', stale: '数据已过期 · {age}前',
    failed: '最近一次读取失败（{status}），显示的是 {age}前 的数据', updated: '{age}前更新', custom: '这个组件需要更新的渲染器', other: '其余 {n} 组，共 {total}',
    more: '共 {n} 条，显示前 {shown} 条', capped: '只读取了前 {limit} 条：实际更多', none: '—', s: '{n} 秒', m: '{n} 分钟', h: '{n} 小时', d: '{n} 天',
    status: { failed: '失败', partial: '部分', too_large: '数据过大' },
  },
  en: {
    loading: 'Waiting for the first data…', error: 'Could not read', denied: 'You have no access to this data', unset: 'Not set up: nothing reads this data yet', empty: 'No data', stale: 'Stale · {age} ago',
    failed: 'The latest read failed ({status}); showing data from {age} ago', updated: 'Updated {age} ago', custom: 'This widget needs a newer renderer', other: '{n} more groups, {total} in all',
    more: '{n} rows; showing the first {shown}', capped: 'Only the first {limit} were read: there are more', none: '—', s: '{n}s', m: '{n}m', h: '{n}h', d: '{n}d',
    status: { failed: 'failed', partial: 'partial', too_large: 'too large' },
  },
}
const fill = (s, p = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => p[k] ?? '')
const ageOf = (ms, T) => { const s = Math.max(1, Math.round(ms / 1e3)); return s < 60 ? fill(T.s, { n: s }) : s < 3600 ? fill(T.m, { n: Math.round(s / 60) }) : s < 86400 ? fill(T.h, { n: Math.round(s / 3600) }) : fill(T.d, { n: Math.round(s / 86400) }) }
const pick = (v, lang) => (v && typeof v === 'object' ? v[lang] ?? v.en : v)

/** A cell as its field's type says: a time as local date-time, a link opens, a bool ✓, nothing as —. */
function Cell({ type, value, T }) {
  if (value == null || value === '') return <span className="bd-dim">{T.none}</span>
  if (type === 'url') return /^https?:\/\//i.test(String(value)) ? <a href={value} target="_blank" rel="noreferrer">{String(value).replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}</a> : String(value)
  if (type === 'time') { const t = typeof value === 'number' ? value : Date.parse(value); if (!Number.isFinite(t) || Number.isNaN(new Date(t).getTime())) return String(value); return <time dateTime={new Date(t).toISOString()} title={new Date(t).toLocaleString()}>{new Date(t).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> }
  if (type === 'bool') return value ? '✓' : '✗'
  if (type === 'number') return <span className="bd-num">{value}</span>
  return String(value)
}

/** The arguments of an action for this row: "$row.<field>" takes the row's. */
const argsFor = (a, row) => Object.fromEntries(Object.entries(a.args || {}).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('$row.') ? row[v.slice(5)] : v]))

function Bars({ groups, total, T }) {
  const shown = groups.slice(0, 12), rest = groups.slice(12), max = Math.max(1, ...shown.map(g => g.count))
  return (
    <div className="bd-bars">
      {shown.map(g => (
        <div key={String(g.key)} className="bd-bar" title={`${g.key ?? T.none}: ${g.count}`}>
          <span className="bd-bar-label">{g.key ?? T.none}</span>
          <span className="bd-bar-track"><i style={{ width: `${(g.count / max) * 100}%` }} /></span>
          <span className="bd-num">{g.count}</span>
        </div>
      ))}
      {rest.length > 0 && <div className="bd-dim">{fill(T.other, { n: rest.length, total: rest.reduce((s, g) => s + g.count, 0) })}</div>}
      {!shown.length && total === 0 && <div className="bd-dim">{T.empty}</div>}
    </div>
  )
}

function Rows({ rows, total, capped, w, fields, labels = {}, lang, T, onAction, hostActions }) {
  // the spec's actions, then the host's own on every row (Ruyix's "ask the assistant": the row as it is) — told apart by
  // where they came from, not by a flag a spec could carry
  const host = Array.isArray(hostActions) ? hostActions : []
  const cols = w.columns || Object.keys(fields).slice(0, 5), acts = [...(w.actions || []).filter(a => ACTIONS[a.op] && !host.some(h => h.op === a.op)), ...host]
  return (
    <div className="bd-table-wrap">
      <table className="bd-table">
        <thead><tr>{cols.map(c => <th key={c}>{pick(labels[c], lang) || c}</th>)}{acts.length > 0 && <th />}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i}>
              {cols.map(c => <td key={c} className={fields[c] === 'string' ? 'bd-wide' : undefined}><Cell type={fields[c]} value={r[c]} T={T} /></td>)}
              {acts.length > 0 && <td className="bd-acts">{acts.map(a => <button key={a.op} className="bd-act" onClick={() => onAction?.(a.op, host.includes(a) ? { row: r, widget: pick(w.title, lang) || w.id } : argsFor(a, r))}>{pick(a.label, lang) || pick(ACTIONS[a.op]?.label, lang)}</button>)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {total > rows.length && <div className="bd-dim">{fill(T.more, { n: `${total}${capped ? '+' : ''}`, shown: rows.length })}</div>}
    </div>
  )
}

function Trend({ points }) {
  const vals = points.map(p => p.value).filter(v => typeof v === 'number')
  if (vals.length < 2) return <b className="bd-big">{vals[0] ?? '—'}</b>
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1, W = 240, H = 56
  const d = points.filter(p => typeof p.value === 'number').map((p, i, a) => `${i ? 'L' : 'M'}${((i / (a.length - 1)) * W).toFixed(1)},${(H - 4 - ((p.value - lo) / span) * (H - 8)).toFixed(1)}`).join(' ')
  return (
    <div className="bd-trend">
      <b className="bd-big">{vals.at(-1)}</b>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${lo} – ${hi}`}><path d={d} /></svg>
    </div>
  )
}

function Widget({ w, b, datasets, snapshots, history, denied, unset, lang, T, now, onAction, hostActions }) {
  const title = pick(w.title, lang)
  if (w.view === 'note') return <section className={`bd-card bd-${w.size || 'm'}`}>{title && <h4>{title}</h4>}<p className="bd-note">{pick(w.text, lang)}</p></section>
  if (w.view === 'custom') return <section className={`bd-card bd-${w.size || 'm'}`}>{title && <h4>{title}</h4>}<div className="bd-state">{T.custom}</div></section>
  const name = refOf(b.datasets?.[w.data] || '').name, spec = datasetOf(name, datasets), snap = snapshots?.[name]
  const st = stateOf(snap, spec, { now, denied: denied.has(name), unset: unset.has(name) })
  const rows = snap?.ok?.rows ? (spec?.fields ? shapeRows(snap.ok.rows, spec).rows : snap.ok.rows) : []
  const out = ['ok', 'stale', 'empty'].includes(st.state) ? derive(rows, w, { history: history?.[name], now }) : null
  // the read stopped at the dataset's limit: what it counts is a floor, said as one ("500+")
  const limit = Number(spec?.params?.limit), capped = limit > 0 && rows.length >= limit
  const age = st.at ? ageOf(now - st.at, T) : ''
  let body
  if (st.state === 'loading') body = <div className="bd-state bd-loading"><i /><i /><i /></div>
  else if (st.state === 'denied' || st.state === 'unset') body = <div className="bd-state">{T[st.state]}</div>
  else if (st.state === 'error') body = <div className="bd-state bd-bad">{T.error}{st.failed?.error && <code>{st.failed.error}</code>}</div>
  else if (w.view === 'count') body = <b className="bd-big" title={capped ? fill(T.capped, { limit }) : undefined}>{out.value}{capped && '+'}</b>
  else if (w.view === 'breakdown' || w.view === 'people') body = <Bars groups={out.groups} total={out.total} T={T} />
  else if (w.view === 'trend') body = <Trend points={out.points} />
  else if (!out.rows.length) body = <div className="bd-state">{T.empty}</div>
  else body = <Rows rows={out.rows} total={out.total} capped={capped} w={w} fields={spec?.fields || {}} labels={spec?.labels} lang={lang} T={T} onAction={onAction} hostActions={hostActions} />
  return (
    <section className={`bd-card bd-${w.size || (['list', 'table', 'runs'].includes(w.view) ? 'l' : 's')} bd-is-${st.state}`} aria-busy={st.state === 'loading'}>
      <header>
        <h4>{title || [pick(spec?.title, lang) || name, w.by && (pick(spec?.labels?.[w.by], lang) || w.by)].filter(Boolean).join(' · ')}</h4>
        {st.state === 'stale' && <span className="bd-tag bd-warn">{fill(T.stale, { age })}</span>}
        {st.state !== 'stale' && age && <span className="bd-dim" title={new Date(st.at).toLocaleString()}>{fill(T.updated, { age })}</span>}
      </header>
      {st.failed && st.state !== 'error' && <div className="bd-tag bd-warn" title={st.failed.error}>{fill(T.failed, { status: T.status[st.failed.status] || st.failed.status, age })}</div>}
      {body}
    </section>
  )
}

/**
 * <Board spec={dashboard} datasets={{ name: spec }} snapshots={{ name: snapshot }} history={{ name: [{ at, count, … }] }}
 *        denied={dataset names} unset={dataset names} lang="zh"|"en" page={id} onPage={id => …} tabs={false}
 *        onAction={(op, args) => …} hostActions={[{ op, label: { zh, en } }]} />
 * A core dataset's rows come as a snapshot too ({ ok: { rows, count, at } }) — the host reads its own record. denied:
 * the viewer may not see it; unset: nothing reads it (not granted, no node). tabs={false}: the host shows the pages.
 * hostActions: the host's own on every table row, after the spec's (no spec names them: a page that does not offer
 * them shows none) — onAction(op, { row, widget }).
 */
export function Board({ spec, datasets = {}, snapshots = {}, history = {}, denied, unset, lang = 'en', page, onPage, onAction, hostActions, tabs = true, now = Date.now() }) {
  const T = TEXT[lang] || TEXT.en
  const [own, setOwn] = useState(null)
  const pages = spec?.pages || []
  const current = pages.find(p => p.id === (page ?? own)) || pages[0]
  const go = id => (onPage ? onPage(id) : setOwn(id))
  const deny = useMemo(() => new Set(denied || []), [denied]), off = useMemo(() => new Set(unset || []), [unset])
  if (!current) return null
  return (
    <div className="bd-board">
      {tabs && pages.length > 1 && (
        <nav className="bd-pages" role="tablist">
          {pages.map(p => <button key={p.id} role="tab" aria-selected={p.id === current.id} className={p.id === current.id ? 'on' : ''} onClick={() => go(p.id)}>{pick(p.title, lang)}</button>)}
        </nav>
      )}
      <div className="bd-grid">
        {(current.widgets || []).map(w => <Widget key={w.id} w={w} b={spec} datasets={datasets} snapshots={snapshots} history={history} denied={deny} unset={off} lang={lang} T={T} now={now} onAction={onAction} hostActions={hostActions} />)}
      </div>
    </div>
  )
}

export { TEXT as BOARD_TEXT }
