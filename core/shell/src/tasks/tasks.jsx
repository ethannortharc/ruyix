// 「任务」 (docs/design/agent-tasks.md「任务中心和作品集」, and work-in-one-place.md: one page for the day's work, Ethan
// 2026-10-19): every task an agent did or does — a conversation's request, a session's piece of work, a pool task, a
// workflow's run, a studio's — by its state (at work, waiting for you, to confirm, done, did not work, archived), found
// by words, source, studio and agent, the days apart. One chosen: how it went (its timeline: the messages, steps,
// approvals, agents' messages), what it made, what it used, and what can be done with it — 好了 / 再改 when it waits for
// that, archive, delete. Other plugins put their parts in (./data.js: PART_SLOT in a task, TAB_SLOT a tab of their own,
// NEW_SLOT the 新建任务 form). And the portfolio's tile for what a task made (./works.jsx uses it too).
import { useEffect, useMemo, useState } from 'react'
import { ArrowRightLeft, Archive, ArchiveRestore, Check, CircleDot, ListChecks, MessageSquare, Package, Plus, Search, Send, ShieldCheck, StickyNote, Workflow, X } from 'lucide-react'
import { NEW_SLOT, PART_SLOT, TAB_SLOT, act, taskOfRun, useLanding, useTask, useTaskList } from './data.js'
import { textOf } from './text.js'
import { OutputCard } from './outputs.jsx'
import { AT_WORK, progressOf, stepsLine } from '../progress.js'

const cx = (...c) => c.filter(Boolean).join(' ')
const langOf = locale => (String(locale?.getSnapshot?.().active || 'zh').startsWith('zh') ? 'zh' : 'en')
const TABS = { all: {}, waiting: { state: 'waiting' }, 'to-confirm': { state: 'to-confirm' }, active: { state: ['queued', 'working'] }, done: { state: 'done' }, ended: { state: ['failed', 'stopped'] }, archived: { archived: 'only' } }
const countOf = (tab, c) => (tab === 'all' ? null : tab === 'active' ? (c.queued || 0) + (c.working || 0) : tab === 'ended' ? (c.failed || 0) + (c.stopped || 0) : c[tab] || 0)
const ENDED = new Set(['done', 'failed', 'stopped'])
const studios = () => window.__ruyixStudios || []
const studioName = (id, lang) => { const s = studios().find(x => x.id === (typeof id === 'string' ? id : id?.id)); return s ? (typeof s.name === 'string' ? s.name : s.name?.[lang] || s.name?.zh || s.id) : '' }
const send = (open) => { if (open?.event) window.dispatchEvent(new CustomEvent(open.event, { detail: open.detail })) }
const STEP_ICON = { message: MessageSquare, step: Workflow, approval: ShieldCheck, 'agent-message': ArrowRightLeft, state: CircleDot, output: Package, note: StickyNote }
const labelOf = o => (typeof o?.label === 'function' ? o.label() : o?.label)
const dayKey = ms => { const d = new Date(ms || 0); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }

/** How far a task at work has come (../progress.js): a bar under its row. */
function Track({ t }) {
  const p = progressOf(t)
  return <span className={`tk-track tk-tone-${p.tone}`} aria-hidden="true"><i style={p.pct == null ? undefined : { width: `${p.pct}%` }} /></span>
}

/** A slot's entries (each with an id), kept as the plugins come and go. */
function useEntries(slots, name) {
  const [, bump] = useState(0)
  useEffect(() => slots?.subscribe?.(name, () => bump(n => n + 1)), [slots])
  return (slots?.entries?.(name) || []).map(e => e.options || {}).filter(o => o.id).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
}

export function TaskCenter({ locale, slots, renderSlot }) {
  const lang = langOf(locale), W = textOf(lang)
  const [tab, setTab] = useState('all'), [q, setQ] = useState(''), [source, setSource] = useState(''), [studio, setStudio] = useState(''), [agent, setAgent] = useState(''), [pick, setPick] = useState(null)
  const [making, setMaking] = useState(null), [note, setNote] = useState('') // the new task's sheet (its preset), a word for the page
  const tabs = useEntries(slots, TAB_SLOT), parts = useEntries(slots, PART_SLOT), canNew = useEntries(slots, NEW_SLOT).length > 0
  const own = tabs.find(t => t.id === tab) // a plugin's tab: its own page under the tabs
  // (in the page's language: what each is doing now and how it ended are worded in it)
  const filter = useMemo(() => ({ ...TABS[tab], ...(tab !== 'archived' && { archived: false }), ...(q.trim() && { q: q.trim() }), ...(source && { source }), ...(studio && { studio }), ...(agent && { agent }), lang }), [tab, q, source, studio, agent, lang])
  const list = useTaskList(filter)
  // asked to land somewhere (a task card, a note, an old page's link): show it, whatever the tab
  useLanding(async d => {
    if (d.view === 'new') { const { panel, view, ...preset } = d; setMaking(preset); return }
    if (d.tab) setTab(String(d.tab))
    if (d.task) { if (!d.tab) setTab(t => (TABS[t] ? t : 'all')); setPick(String(d.task)) }
    else if (d.run) { const id = await taskOfRun(d.run); if (id) { setTab('all'); setPick(id) } else setNote(W.noRun) }
  })
  useEffect(() => { if (!pick && list.tasks.length) setPick(list.tasks[0].id) }, [list.tasks.length && list.tasks[0].id])
  useEffect(() => { if (!note) return; const h = setTimeout(() => setNote(''), 4000); return () => clearTimeout(h) }, [note])
  // the days apart, newest first (the list comes by when each was last changed)
  const rows = []
  for (const t of list.tasks) {
    const k = dayKey(t.updatedAt)
    if (rows.at(-1)?.day !== k) rows.push({ day: k, at: t.updatedAt, tasks: [] })
    rows.at(-1).tasks.push(t)
  }
  return (
    <div className="tk-page">
      <header className="tk-header">
        <span className="tk-glyph"><ListChecks size={20} strokeWidth={1.8} /></span>
        <h1>{W.tasks}</h1>
        <label className="tk-search"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={W.search} aria-label={W.search} /></label>
        <select className="tk-select" value={source} onChange={e => setSource(e.target.value)} aria-label={W.source}>
          <option value="">{W.anySource}</option>{Object.entries(W.sources).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {studios().length > 0 && (
          <select className="tk-select" value={studio} onChange={e => setStudio(e.target.value)} aria-label={W.studio}>
            <option value="">{W.anyStudio}</option>{studios().map(s => <option key={s.id} value={s.id}>{studioName(s.id, lang)}</option>)}
          </select>
        )}
        {(list.agents.length > 0 || agent) && (
          <select className="tk-select" value={agent} onChange={e => setAgent(e.target.value)} aria-label={W.agent}>
            <option value="">{W.anyAgent}</option>{list.agents.map(a => <option key={a.id} value={a.id}>{a.name || a.id}{a.n ? ` · ${a.n}` : ''}</option>)}
          </select>
        )}
        {canNew && <button type="button" className="tk-btn tk-pri" onClick={() => setMaking({})}><Plus size={15} />{W.newTask}</button>}
      </header>
      <nav className="tk-tabs" role="tablist" aria-label={W.tasks}>
        {Object.keys(TABS).map(k => {
          const n = countOf(k, list.counts)
          return <button key={k} type="button" role="tab" aria-selected={tab === k} className={cx(tab === k && 'on', `tk-tab-${k}`, n > 0 && 'tk-has')} onClick={() => setTab(k)}>{k === 'all' ? W.all : W.tabs[k]}{n > 0 && <i>{n}</i>}</button>
        })}
        {tabs.length > 0 && <span className="tk-tabs-gap" aria-hidden="true" />}
        {tabs.map(t => {
          let n = 0
          try { n = Number(t.count?.(list.counts)) || 0 } catch { /* the plugin's own */ }
          return <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cx(tab === t.id && 'on', n > 0 && 'tk-has')} onClick={() => setTab(t.id)}>{labelOf(t) || t.id}{n > 0 && <i>{n}</i>}</button>
        })}
      </nav>
      {note && <div className="tk-pagenote" role="status">{note}</div>}
      {own ? <div className="tk-own">{renderSlot(TAB_SLOT, { lang }, { only: own.id })}</div> : (
        <div className="tk-body">
          <div className="tk-list" role="listbox" aria-label={W.tasks}>
            {rows.map(g => (
              <section key={g.day} className="tk-day" role="group" aria-label={W.day(g.at)}>
                <h4 className="tk-day-name">{W.day(g.at)}</h4>
                {g.tasks.map(t => (
                  <button key={t.id} type="button" role="option" aria-selected={pick === t.id} className={cx('tk-row', pick === t.id && 'on')} onClick={() => setPick(t.id)}>
                    <i className={`tk-dot tk-st-${t.state}`} aria-hidden="true" />
                    <span className="tk-row-main">
                      <b>{t.title || t.id}</b>
                      <span className="tk-row-meta">{[W.sources[t.source] || t.source, t.studio && studioName(t.studio, lang), W.ago(t.endedAt || t.updatedAt), W.used(t.usage)].filter(Boolean).join(' · ')}</span>
                      {AT_WORK.has(t.state) && <Track t={t} />}
                      {t.waitingFor?.title ? <span className="tk-row-wait">{W.waitingFor}：{t.waitingFor.title}</span>
                        : (ENDED.has(t.state) ? t.result : [stepsLine(t, lang), t.step].filter(Boolean).join(' · ')) && <span className="tk-row-say">{ENDED.has(t.state) ? t.result : [stepsLine(t, lang), t.step].filter(Boolean).join(' · ')}</span>}
                    </span>
                    {t.outputs > 0 && <span className="tk-count" title={W.outputsN(t.outputs)}>{t.outputs}</span>}
                  </button>
                ))}
              </section>
            ))}
            {!list.tasks.length && <p className="tk-quiet">{list.loading ? W.loading : list.error ? `${W.failed}${list.error.message}` : W.none}</p>}
            {list.more && <button type="button" className="tk-more" onClick={list.loadMore}>{W.more}</button>}
          </div>
          <section className="tk-detail">{pick ? <TaskDetail key={pick} id={pick} W={W} lang={lang} parts={parts} renderSlot={renderSlot} onGone={() => setPick(null)} /> : <p className="tk-quiet tk-pick">{W.pick}</p>}</section>
        </div>
      )}
      {making && canNew && (
        <div className="tk-sheet-back" onPointerDown={e => { if (e.target === e.currentTarget) setMaking(null) }}>
          <section className="tk-sheet" role="dialog" aria-label={W.newTask}>
            <header><h2>{W.newTask}</h2><button type="button" className="tk-btn tk-quietbtn" onClick={() => setMaking(null)} aria-label={W.close} title={W.close}><X size={15} /></button></header>
            <div className="tk-sheet-body">{renderSlot(NEW_SLOT, { lang, preset: making, onClose: () => setMaking(null) })}</div>
          </section>
        </div>
      )}
    </div>
  )
}

function TaskDetail({ id, W, lang, parts = [], renderSlot, onGone }) {
  const { task, timeline, outputs, loading, error, reload } = useTask(id, lang)
  const [revise, setRevise] = useState(null), [armed, setArmed] = useState(false), [busy, setBusy] = useState(false), [note, setNote] = useState('')
  useEffect(() => { if (!armed) return; const h = setTimeout(() => setArmed(false), 3500); return () => clearTimeout(h) }, [armed])
  if (!task) return <p className="tk-quiet">{loading ? W.loading : error ? `${W.failed}${error.message}` : W.none}</p>
  const run = async (f, said) => { setBusy(true); setNote(''); try { await f(); if (said) setNote(said); await reload(); return true } catch (e) { setNote(`${W.failed}${e.message}`); return false } finally { setBusy(false) } }
  const ended = ENDED.has(task.state)
  return (
    <div className="tk-task">
      <header className="tk-task-head">
        <div className="tk-task-title"><h2>{task.title || task.id}</h2><span className={`tk-pill tk-st-${task.state}`}>{W.states[task.state] || task.state}</span>{task.archived && <span className="tk-pill">{W.tabs.archived}</span>}</div>
        <div className="tk-task-meta">
          {[W.sources[task.source] || task.source, task.studio && studioName(task.studio, lang), `${W.started} ${W.ago(task.createdAt)}`, task.endedAt ? `${W.ended} ${W.ago(task.endedAt)}` : `${W.updated} ${W.ago(task.updatedAt)}`,
            task.agents?.length ? `${W.agents}：${task.agents.map(a => a.name || a.runtime || a.id).join('、')}` : '', task.usage && W.used(task.usage) && `${W.usage}：${W.used(task.usage)}`].filter(Boolean).join(' · ')}
        </div>
        <div className="tk-actions">
          {task.state === 'to-confirm' && revise === null && <>
            <button type="button" className="tk-btn tk-pri" disabled={busy} onClick={() => run(() => act.confirm(task.id, task.lastRunId || '', task.resultVersion || 0), W.done)}><Check size={14} />{W.ok}</button>
            <button type="button" className="tk-btn" disabled={busy} onClick={() => setRevise('')}>{W.revise}</button>
          </>}
          {revise !== null && (
            <form className="tk-revise" onSubmit={e => { e.preventDefault(); if (revise.trim()) run(() => act.revise(task.id, revise.trim(), task.lastRunId || '', task.resultVersion || 0), W.revised).then(ok => { if (ok) setRevise(null) }) }}>
              <input autoFocus value={revise} onChange={e => setRevise(e.target.value)} placeholder={W.revisePh} aria-label={W.revisePh} />
              <button type="submit" className="tk-btn tk-pri" disabled={busy || !revise.trim()}><Send size={13} />{W.send}</button>
              <button type="button" className="tk-btn" onClick={() => setRevise(null)}>{W.cancel}</button>
            </form>
          )}
          <span className="tk-grow" />
          {(ended || task.archived) && <button type="button" className="tk-btn tk-quietbtn" disabled={busy} onClick={() => run(() => act.archive(task.id, !task.archived))}>{task.archived ? <><ArchiveRestore size={14} />{W.unarchive}</> : <><Archive size={14} />{W.archive}</>}</button>}
          {ended && <button type="button" className={cx('tk-btn', 'tk-quietbtn', armed && 'tk-danger')} disabled={busy} onClick={() => (armed ? run(async () => { await act.remove(task.id); onGone() }, W.removed) : setArmed(true))}>{armed ? W.removeAgain : W.remove}</button>}
        </div>
        {note && <div className="tk-note">{note}</div>}
      </header>
      {task.waitingFor && (
        <div className="tk-wait"><span><b>{W.waitingFor}</b>{task.waitingFor.title}</span>{task.waitingFor.open && <button type="button" className="tk-btn tk-warn" onClick={() => send(task.waitingFor.open)}>{W.goThere}</button>}</div>
      )}
      {parts.map(p => <div key={p.id} className="tk-part">{renderSlot?.(PART_SLOT, { task, lang, reload }, { only: p.id })}</div>)}
      <section className="tk-sec">
        <h3>{W.outputs}{outputs.length > 0 && <i>{outputs.length}</i>}</h3>
        {outputs.length ? <div className="tk-grid">{outputs.map(o => <OutputCard key={o.id} o={o} W={W} />)}</div> : <p className="tk-quiet">{W.noOutputs}</p>}
      </section>
      <section className="tk-sec">
        <h3>{W.timeline}</h3>
        {timeline.length ? (
          <ol className="tk-timeline">
            {timeline.map((e, i) => {
              const I = STEP_ICON[e.kind] || CircleDot
              const Row = e.open?.event ? 'button' : 'div'
              return (
                <li key={i} className={`tk-ev tk-ev-${e.kind}`}>
                  <span className="tk-ev-icon"><I size={13} strokeWidth={1.8} /></span>
                  <Row {...(e.open?.event && { type: 'button', onClick: () => send(e.open) })} className={cx('tk-ev-main', e.open?.event && 'tk-ev-go')}>
                    <span className="tk-ev-who">{e.who?.name || W.who[e.who?.kind] || ''}<time>{W.ago(e.at)}</time></span>
                    <span className="tk-ev-text">{e.text}</span>
                  </Row>
                </li>
              )
            })}
          </ol>
        ) : <p className="tk-quiet">{W.noTimeline}</p>}
      </section>
    </div>
  )
}
