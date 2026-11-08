// How far a task has come, drawn the same everywhere (the 任务 page's rows, the desk's 任务 widget and window): a
// workflow by its steps (done of all), a piece of work with no known end as a light that moves (alive, never a made-up
// percent stuck short of the end), waiting for the person amber where it stopped, not made red, done grey and full.
// A task carries `progress: { done, total, step? }` when its steps are known (the workbench's taskList). Exported as
// @ruyix/shell/progress.

/** The states a task is still at. */
export const AT_WORK = new Set(['queued', 'working', 'waiting', 'to-confirm'])

/** A task → { tone: 'live' | 'flow' | 'wait' | 'bad' | 'done', pct (0–100, or null: no known end) }. */
export function progressOf(t) {
  const p = t?.progress, pct = p?.total > 0 ? Math.round(100 * Math.min(1, Math.max(0, (p.done || 0) / p.total))) : null
  switch (t?.state) {
    case 'waiting': case 'to-confirm': return { tone: 'wait', pct: pct ?? 100 }
    case 'failed': case 'stopped': return { tone: 'bad', pct: pct ?? 100 }
    case 'done': return { tone: 'done', pct: 100 }
    case 'queued': return { tone: 'live', pct: 0 }
    default: return pct == null ? { tone: 'flow', pct: null } : { tone: 'live', pct: Math.max(3, pct) }
  }
}

/** Where a task with known steps is, in a few words: 第 3 步，共 5 步「渲染」 / Step 3 of 5: Render ('' when not known). */
export function stepsLine(t, lang) {
  const p = t?.progress
  if (!(p?.total > 0)) return ''
  const n = Math.min(p.total, (p.done || 0) + (t.state === 'done' ? 0 : 1))
  return lang === 'zh' ? `第 ${n} 步，共 ${p.total} 步${p.step ? `「${p.step}」` : ''}` : `Step ${n} of ${p.total}${p.step ? `: ${p.step}` : ''}`
}
