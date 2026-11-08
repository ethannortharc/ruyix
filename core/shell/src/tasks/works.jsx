// The portfolio (docs/design/agent-tasks.md「作品集」; Ethan 2026-10-18): what the agents finally made — not their working
// files — grouped by the task that made it (or by its kind of task: the workflow, the studio, where it came from), each
// group headed by its task (its state; a click: that task in the task center). Each thing as a card with what it is
// (./outputs.jsx) that opens that one thing. By kind, studio and words; archived tasks' only when asked.
import { useMemo, useState } from 'react'
import { ArrowUpRight, GalleryVerticalEnd, Search } from 'lucide-react'
import { useOutputs } from './data.js'
import { OutputCard } from './outputs.jsx'
import { textOf } from './text.js'

const cx = (...c) => c.filter(Boolean).join(' ')
const langOf = locale => (String(locale?.getSnapshot?.().active || 'zh').startsWith('zh') ? 'zh' : 'en')
const KINDS = ['file', 'draft', 'report', 'image', 'video', 'post', 'answer', 'card']
const studios = () => window.__ruyixStudios || []
const openTask = id => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: 'ruyix-tasks', task: id } }))

/** Outputs → groups by task, in the order they come: [{ key, task, outputs }]. */
export function byTask(outputs) {
  const groups = [], at = new Map()
  for (const o of outputs) {
    const key = o.task?.id || `_${o.id}`
    if (!at.has(key)) { at.set(key, groups.length); groups.push({ key, task: o.task || null, outputs: [] }) }
    groups[at.get(key)].outputs.push(o)
  }
  return groups
}
/** Outputs → sections by category, each with its tasks: [{ key, title, groups }]. */
export function byCategory(outputs, other) {
  const sections = [], at = new Map()
  for (const o of outputs) {
    const key = o.category?.key || '_', title = o.category?.title || other
    if (!at.has(key)) { at.set(key, sections.length); sections.push({ key, title, list: [] }) }
    sections[at.get(key)].list.push(o)
  }
  return sections.map(s => ({ key: s.key, title: s.title, groups: byTask(s.list) }))
}

function TaskGroup({ g, W, small = false }) {
  const t = g.task
  return (
    <section className={cx('tk-group', small && 'tk-group-sm')}>
      <header className="tk-group-head">
        {t ? (
          <button type="button" className="tk-group-title" onClick={() => openTask(t.id)} title={W.openTask}>
            <b>{t.title || t.id}</b><ArrowUpRight size={13} aria-hidden="true" />
          </button>
        ) : <b className="tk-group-title">{W.noTask}</b>}
        {t?.state && <span className={`tk-pill tk-st-${t.state}`}>{W.states[t.state] || t.state}</span>}
        <span className="tk-group-n">{W.outputsN(g.outputs.length)}</span>
      </header>
      <div className="tk-grid tk-grid-wall">{g.outputs.map(o => <OutputCard key={o.id} o={o} W={W} />)}</div>
    </section>
  )
}

export function Portfolio({ locale }) {
  const lang = langOf(locale), W = textOf(lang)
  const [kind, setKind] = useState(''), [studio, setStudio] = useState(''), [q, setQ] = useState(''), [archived, setArchived] = useState(false), [group, setGroup] = useState('task')
  const filter = useMemo(() => ({ final: true, archived, lang, ...(kind && { kind }), ...(studio && { studio }), ...(q.trim() && { q: q.trim() }) }), [kind, studio, q, archived, lang])
  const { outputs, more, loadMore, loading, error } = useOutputs(filter)
  const tasks = useMemo(() => byTask(outputs), [outputs])
  const sections = useMemo(() => (group === 'category' ? byCategory(outputs, W.otherCategory) : null), [outputs, group, W])
  return (
    <div className="tk-page">
      <header className="tk-header">
        <span className="tk-glyph tk-glyph-works"><GalleryVerticalEnd size={20} strokeWidth={1.8} /></span>
        <h1>{W.works}</h1>
        <label className="tk-search"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={W.search} aria-label={W.search} /></label>
        {studios().length > 0 && (
          <select className="tk-select" value={studio} onChange={e => setStudio(e.target.value)} aria-label={W.studio}>
            <option value="">{W.anyStudio}</option>
            {studios().map(s => <option key={s.id} value={s.id}>{typeof s.name === 'string' ? s.name : s.name?.[lang] || s.name?.zh || s.id}</option>)}
          </select>
        )}
        <button type="button" role="switch" aria-checked={archived} className={cx('tk-toggle', archived && 'on')} onClick={() => setArchived(a => !a)}><i aria-hidden="true" />{W.withArchived}</button>
        <span className="tk-seg" role="radiogroup" aria-label={W.groupBy}>
          {['task', 'category'].map(g => <button key={g} type="button" role="radio" aria-checked={group === g} className={cx(group === g && 'on')} onClick={() => setGroup(g)}>{W.groupByKind[g]}</button>)}
        </span>
      </header>
      <nav className="tk-tabs" role="tablist" aria-label={W.works}>
        <button type="button" role="tab" aria-selected={!kind} className={cx(!kind && 'on')} onClick={() => setKind('')}>{W.all}</button>
        {KINDS.map(k => <button key={k} type="button" role="tab" aria-selected={kind === k} className={cx(kind === k && 'on')} onClick={() => setKind(k)}>{W.kinds[k]}</button>)}
      </nav>
      <main className="tk-wall">
        {group === 'task' ? tasks.map(g => <TaskGroup key={g.key} g={g} W={W} />) : sections.map(s => (
          <section key={s.key} className="tk-cat">
            <h2 className="tk-cat-title">{s.title}<i>{s.groups.length}</i></h2>
            {s.groups.map(g => <TaskGroup key={g.key} g={g} W={W} small />)}
          </section>
        ))}
        {!outputs.length && <p className="tk-quiet tk-wall-empty">{loading ? W.loading : error ? `${W.failed}${error.message}` : W.none}</p>}
        {more && <button type="button" className="tk-more" onClick={loadMore}>{W.more}</button>}
      </main>
    </div>
  )
}
