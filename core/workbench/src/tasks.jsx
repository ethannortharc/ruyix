// Tasks (lib/tasks.js): the list on the left — each task once or on a schedule, its last run, when it runs next — and,
// above a run's page, its task: when it runs, what happened at its last times (skipped, missed, could not start), its
// runs one after another, and the ways to steer it (run now, pause, change the time, archive). And the "when to run"
// fields the new-task form and the time dialog share.
import { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, CalendarClock, Clock, Loader2, LifeBuoy, Pause, Play, Repeat, Scale, X } from 'lucide-react'
import { checkSchedule, describe, nextAt } from '../lib/schedule.js'
import { call } from './data.js'
import { dateLoc, ACTIVE, TONE, cx, dur, errorText, lastActivity, useT, useWorkflowData, verdictText, verdictTone, when, workflowName } from './ui.jsx'

import { TASK_SCOPES, archivedTask, inTaskScope, repeats, runsByTask } from './task-scope.js'
// (a re-export alone binds nothing here: what this file uses itself is imported)
export { TASK_SCOPES, archivedTask, inTaskScope, repeats, runsByTask }
const myTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone
export const taskActivity = (t, runs) => Math.max(t.createdAt || 0, t.updatedAt && repeats(t) ? t.updatedAt : 0, ...runs.map(lastActivity))

/** A time on the task's own clock (its time zone: what "08:00" means to it), when that is not the browser's. */
const whenIn = (ts, tz) => (!tz || tz === myTz() ? when(ts) : new Date(ts).toLocaleString(dateLoc(), { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
/** When it runs next, said: 10月18日 08:00 · 还有 20h 05m. */
const nextText = (t, tr, now) => (t.nextAt ? `${tr('task.next', { when: whenIn(t.nextAt, t.tz) })} · ${tr('task.in', { t: dur(t.nextAt - now) })}` : '')

// ── the list ────────────────────────────────────────────────────────────────
export function TaskRail({ tasks, byTask, selected, onSelect, now, filter, query, onArchive }) {
  const t = useT()
  const data = useWorkflowData()
  const lang = t('lang.code') === 'zh' ? 'zh' : 'en'
  const q = query.trim().toLowerCase()
  const list = tasks.filter(x => inTaskScope(x, byTask.get(x.id) || [], filter) && (!q || `${x.title} ${x.id} ${x.request?.text || ''} ${x.workflow}`.toLowerCase().includes(q)))
  if (!tasks.length) return <div className="wb-empty-small">{t('run.empty')}</div>
  if (!list.length) return <div className="wb-empty-small">{t(filter === 'archived' ? 'run.noArchived' : filter === 'active' ? 'run.noActive' : 'run.noMatch')}</div>
  return (
    <div className="wb-runs">
      {list.map(x => {
        const runs = byTask.get(x.id) || [], last = runs[0], live = last && ACTIVE.has(last.status)
        const stage = live && last.stages.find(s => s.key === last.stage)
        const tone = live ? TONE[last.status] : last ? verdictTone(last, data) : 'muted'
        return (
          <div key={x.id} role="button" tabIndex={0} className={cx('wb-run-item', selected === x.id && 'wb-on', live && 'wb-run-live', `wb-t-${tone}`)}
            onClick={() => onSelect(x)} onKeyDown={e => e.key === 'Enter' && onSelect(x)}>
            <span className="wb-run-dot" />
            <span className="wb-run-main">
              <span className="wb-run-title">{repeats(x) && <CalendarClock size={12} className="wb-task-icon" />}{x.title}</span>
              <span className="wb-run-meta">
                {live
                  ? <>{last.waiting === 'decision' ? <Scale size={11} /> : last.waiting === 'person' ? <LifeBuoy size={11} /> : <Loader2 size={11} className="wb-spin" />}{stage ? t(`stage.${stage.key}`) : t(`status.${last.status}`)} · {dur(now - last.createdAt)}</>
                  : repeats(x)
                    ? <>{describe(x.schedule, lang)} · {x.enabled ? (x.nextAt ? t('task.in', { t: dur(x.nextAt - now) }) : t('sch.never')) : t('task.paused')}</>
                    : last ? <>{last.verdict?.level ? verdictText(t, last.verdict.level) : t(`status.${last.status}`)} · {t('ago', { t: dur(now - (last.endedAt || last.updatedAt)) })}</> : t('task.noRuns')}
                {runs.length > 1 && <span className="wb-task-count" title={t('task.runs', { n: runs.length })}><Repeat size={10} />{runs.length}</span>}
                <span className="wb-tag">{last ? workflowName(last, data) : x.workflow}</span>
              </span>
            </span>
            {!live && onArchive && (
              <button className="wb-icon-btn wb-run-archive" title={t(x.archivedAt ? 'task.unarchive' : 'task.archive')} onClick={e => { e.stopPropagation(); onArchive(x, !x.archivedAt) }}>
                {x.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── a task, above its run ───────────────────────────────────────────────────
export function TaskBar({ task, runs, run, onPick, now, toast, refresh, onArchive }) {
  const t = useT()
  const lang = t('lang.code') === 'zh' ? 'zh' : 'en'
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState(false)
  const going = runs.some(r => ACTIVE.has(r.status))
  const act = async (name, op, args, done) => {
    setBusy(name)
    try { const r = await call(op, { id: task.id, ...args }); refresh(); done?.(r) } catch (err) { toast('error', errorText(t, err)) }
    setBusy('')
  }
  const said = task.error ? t('task.error', { when: when(task.error.at), msg: task.error.message })
    : task.skipped ? t(`task.skipped.${task.skipped.why}`, { when: when(task.skipped.at) }) : ''
  return (
    <section className={cx('wb-taskbar', repeats(task) && 'wb-taskbar-repeat')}>
      <div className="wb-taskbar-top">
        <span className="wb-taskbar-icon">{repeats(task) ? <CalendarClock size={16} /> : <Play size={14} />}</span>
        <span className="wb-taskbar-main">
          <b>{task.title}</b>
          <span className="wb-sub">
            {task.archivedAt
              ? <>{repeats(task) ? describe(task.schedule, lang) : t('task.once')} · {t('filter.archived')}</>
              : repeats(task)
              ? <>{describe(task.schedule, lang)}{task.enabled ? (task.nextAt ? ` · ${nextText(task, t, now)}` : ` · ${t('sch.never')}`) : ` · ${t('task.paused')}`}{task.tz && task.tz !== myTz() && ` · ${t('sch.tz', { tz: task.tz })}`}</>
              : t('task.once')}
            {runs.length > 0 && ` · ${t(runs.length === 1 ? 'task.runsOne' : 'task.runs', { n: runs.length })}`}
          </span>
        </span>
        <span className="wb-taskbar-actions">
          {!task.archivedAt && <button className="wb-btn" disabled={going || !!busy} title={going ? t('err.taskBusy') : undefined} onClick={() => act('run', 'taskRunNow', {}, r => { onPick(r.run.id); toast('ok', t('task.started', { title: task.title })) })}>{busy === 'run' ? <Loader2 size={13} className="wb-spin" /> : <Play size={13} />}{t(runs.length ? (repeats(task) ? 'task.runNow' : 'task.again') : 'task.runNow')}</button>}
          {repeats(task) && !task.archivedAt && <button className="wb-btn" disabled={!!busy} onClick={() => act('pause', 'taskUpdate', { enabled: !task.enabled })}>{task.enabled ? <Pause size={13} /> : <Play size={13} />}{t(task.enabled ? 'task.pause' : 'task.resume')}</button>}
          {!task.archivedAt && <button className="wb-btn" disabled={!!busy} onClick={() => setEditing(true)}><Clock size={13} />{t(repeats(task) ? 'task.editWhen' : 'task.makeRepeat')}</button>}
          {!going && onArchive && <button className="wb-icon-btn" title={t(task.archivedAt ? 'task.unarchive' : 'task.archiveHint')} onClick={() => onArchive(task, !task.archivedAt)}>{task.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button>}
        </span>
      </div>
      {said && <div className={cx('wb-note', task.error ? 'wb-t-red' : 'wb-t-amber')}>{said}</div>}
      {(runs.length > 1 || repeats(task)) && runs.length > 0 && (
        <div className="wb-taskruns" role="tablist" aria-label={t('task.runsOf')}>
          {runs.slice(0, 30).map(r => (
            <button key={r.id} role="tab" aria-selected={run?.id === r.id} className={cx('wb-taskrun', run?.id === r.id && 'wb-on', ACTIVE.has(r.status) && 'wb-run-live', `wb-t-${ACTIVE.has(r.status) ? TONE[r.status] : r.verdict?.level === 'failed' || r.status === 'failed' ? 'red' : r.status === 'done' ? 'green' : 'muted'}`)}
              title={`${r.id}${r.startedBy === 'schedule' ? ` · ${t('task.bySchedule')}` : ''}`} onClick={() => onPick(r.id)}>
              <span className="wb-run-dot" />{when(r.createdAt)}{r.startedBy === 'schedule' && <CalendarClock size={10} />}
            </button>
          ))}
        </div>
      )}
      {editing && <WhenDialog task={task} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); toast('ok', t('task.saved')) }} toast={toast} />}
    </section>
  )
}

// ── when to run ─────────────────────────────────────────────────────────────
const DAYS = { zh: ['日', '一', '二', '三', '四', '五', '六'], en: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] }
export const MODES = ['once', 'daily', 'weekdays', 'weekly', 'every', 'cron']
/** A schedule → the fields' state; the fields → a schedule. */
export const formOf = s => {
  if (!s || s.kind === 'once') return { mode: 'once', at: '08:00', days: [1], hours: 6, expr: '0 8 * * *' }
  const base = { at: s.at || '08:00', days: s.days || [1], hours: s.minutes ? s.minutes / 60 : 6, expr: s.expr || '0 8 * * *', ...(s.from !== undefined && { from: s.from }) }
  if (s.kind === 'daily') return { ...base, mode: !s.days ? 'daily' : s.days.join() === '1,2,3,4,5' ? 'weekdays' : 'weekly' }
  return { ...base, mode: s.kind === 'every' ? 'every' : 'cron' }
}
export const scheduleOf = f => (f.mode === 'once' ? { kind: 'once' } : f.mode === 'daily' ? { kind: 'daily', at: f.at } : f.mode === 'weekdays' ? { kind: 'daily', at: f.at, days: [1, 2, 3, 4, 5] }
  : f.mode === 'weekly' ? { kind: 'daily', at: f.at, days: f.days } : f.mode === 'every' ? { kind: 'every', minutes: Math.round(Number(f.hours) * 60), ...(f.from !== undefined && { from: f.from }) } : { kind: 'cron', expr: f.expr })

/** The "when to run" fields: how often, at what time, which days — and what it means: next 10月18日 08:00. */
export function WhenFields({ form, setForm, now, withOnce = true }) {
  const t = useT()
  const lang = t('lang.code') === 'zh' ? 'zh' : 'en'
  const set = patch => setForm(f => ({ ...f, ...patch }))
  const s = scheduleOf(form)
  const { schedule, errors } = checkSchedule(s)
  const next = !errors.length && schedule.kind !== 'once' ? nextAt(schedule, now, { tz: myTz() }) : null
  return (
    <div className="wb-when">
      <div className="wb-seg wb-when-modes">
        {MODES.filter(m => withOnce || m !== 'once').map(m => <button key={m} type="button" className={cx(form.mode === m && 'wb-on')} onClick={() => set({ mode: m })}>{t(`sch.${m}`)}</button>)}
      </div>
      {['daily', 'weekdays', 'weekly'].includes(form.mode) && (
        <div className="wb-when-row">
          <label className="wb-label">{t('sch.at')}</label>
          <input className="wb-input wb-when-time" type="time" value={form.at} onChange={e => set({ at: e.target.value })} />
          {form.mode === 'weekly' && (
            <span className="wb-when-days" role="group" aria-label={t('sch.days')}>
              {[1, 2, 3, 4, 5, 6, 0].map(d => <button key={d} type="button" className={cx('wb-chip', form.days.includes(d) && 'wb-on')} onClick={() => set({ days: form.days.includes(d) ? form.days.filter(x => x !== d) : [...form.days, d] })}>{DAYS[lang][d]}</button>)}
            </span>
          )}
        </div>
      )}
      {form.mode === 'every' && (
        <div className="wb-when-row"><label className="wb-label">{t('sch.hours')}</label><input className="wb-input wb-when-num" type="number" min="0.25" max="168" step="any" value={form.hours} onChange={e => set({ hours: e.target.value })} /></div>
      )}
      {form.mode === 'cron' && (
        <div className="wb-when-row"><label className="wb-label">{t('sch.expr')}</label><input className="wb-input wb-when-cron" value={form.expr} spellCheck={false} onChange={e => set({ expr: e.target.value })} /></div>
      )}
      {form.mode !== 'once' && (errors.length
        ? <p className="wb-field-error">{errors.join('; ')}</p>
        : <p className="wb-when-says"><CalendarClock size={12} />{describe(schedule, lang)} · {next ? `${t('sch.next', { when: when(next) })} · ${t('task.in', { t: dur(next - now) })}` : t('sch.never')}</p>)}
    </div>
  )
}

/** The two choices a repeating task has: catch up once when missed, hand each run the last one's results. */
export function RepeatChoices({ form, setForm, runNow = null }) {
  const t = useT()
  const set = patch => setForm(f => ({ ...f, ...patch }))
  return (
    <div className="wb-when-opts">
      <label className="wb-check" title={t('sch.catchUpHint')}><input type="checkbox" checked={form.catchUp} onChange={e => set({ catchUp: e.target.checked })} />{t('sch.catchUp')}<span className="wb-sub">{t('sch.catchUpHint')}</span></label>
      <label className="wb-check" title={t('sch.carryHint')}><input type="checkbox" checked={form.carry} onChange={e => set({ carry: e.target.checked })} />{t('sch.carry')}<span className="wb-sub">{t('sch.carryHint')}</span></label>
      {runNow !== null && <label className="wb-check"><input type="checkbox" checked={form.runNow} onChange={e => set({ runNow: e.target.checked })} />{t('sch.runNow')}</label>}
    </div>
  )
}

/** Change when a task runs (a one-off one: make it repeat). */
function WhenDialog({ task, onClose, onSaved, toast }) {
  const t = useT()
  const [form, setForm] = useState(() => ({ ...formOf(repeats(task) ? task.schedule : { kind: 'daily', at: '08:00' }), catchUp: task.catchUp ?? true, carry: task.carry ?? true }))
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(i) }, [])
  useEffect(() => { const k = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [])
  const save = async () => {
    setBusy(true)
    try { await call('taskUpdate', { id: task.id, schedule: scheduleOf(form), tz: myTz(), catchUp: form.catchUp, carry: form.carry, ...(form.mode !== 'once' && !repeats(task) && { enabled: true }) }); onSaved() } catch (err) { toast('error', errorText(t, err)) }
    setBusy(false)
  }
  const ok = useMemo(() => !checkSchedule(scheduleOf(form)).errors.length, [form])
  return (
    <div className="wb-modal-wrap" onClick={onClose}>
      <div className="wb-modal wb-when-dialog" role="dialog" aria-modal="true" aria-label={t('task.whenTitle')} onClick={e => e.stopPropagation()}>
        <div className="wb-drawer-head"><h3>{t('task.whenTitle')} · {task.title}</h3><button className="wb-icon-btn" onClick={onClose}><X size={16} /></button></div>
        <WhenFields form={form} setForm={setForm} now={now} withOnce={repeats(task)} />
        {form.mode !== 'once' && <RepeatChoices form={form} setForm={setForm} />}
        <div className="wb-actions wb-end">
          <button className="wb-btn" onClick={onClose}>{t('run.cancel')}</button>
          <button className="wb-btn wb-primary" disabled={busy || !ok} onClick={save}>{busy ? <Loader2 size={13} className="wb-spin" /> : <CalendarClock size={13} />}{t('sch.save')}</button>
        </div>
      </div>
    </div>
  )
}
