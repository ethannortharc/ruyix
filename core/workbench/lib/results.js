// A run's results (docs/design/results.md): what it made, opened in the viewer (src/viewer.jsx) — the files its 结果
// steps name (`use: 'output'`), else what it changed in its folder since it began — and what the person says about them:
// comments where they point, kept with the run, and sent with the run going on again from a step the person picks
// (engine.continueRun: that step and those after it run again, the comments in its brief). A 结果 step waits for nobody:
// it names the files as they are when the run gets there, as a preview node does.
import { globMatch, stepsBack, whereText } from './review.js'

export { stepsBack }

const LIMIT = 60
const shown = p => !p.startsWith('review/') // (a review's own notes are not results)

/** The 结果 step (w: its context; s: { id, title, show }): the files it names, now. */
export async function outputStep(w, s) {
  const v = w.versions
  const all = v ? (await v.files('HEAD').catch(() => [])).map(f => f.path) : []
  let files
  if (s.show?.length) files = [...new Set(s.show.flatMap(g => all.filter(p => globMatch(g, p))))]
  else {
    const start = w.run.versions?.start
    files = start && v ? (await v.between(start).catch(() => [])).filter(f => f.status !== 'D').map(f => f.path) : all
  }
  files = files.filter(shown).slice(0, LIMIT)
  const version = (await v?.log().catch(() => []))?.at(-1)?.commit || null
  w.update(r => ({ ...r, outputs: { ...(r.outputs || {}), [s.id]: { files, version, summary: `${files.length} file(s)`, ok: true } } }))
  w.evidence({ actor: 'system', kind: 'gate', title: `${s.title}: ${files.length ? `${files.slice(0, 6).join(', ')}${files.length > 6 ? ` +${files.length - 6}` : ''}` : 'no files'}`.slice(0, 300), input: { files, version }, ok: true })
  return { ok: true, note: files.length ? `${files.length} result file(s)` : 'no result files yet' }
}

/** The run's results: its 结果 steps' files (in their order), else what it changed since it began. → paths */
export async function resultFiles(run, wf, versions) {
  const named = (wf?.stages || []).filter(s => s.generic === 'output').flatMap(s => run.outputs?.[s.key]?.files || [])
  if (named.length) return [...new Set(named)]
  const start = run.versions?.start
  if (!start || !versions?.has(run)) return []
  return (await versions.between(run, start).catch(() => [])).filter(f => f.status !== 'D').map(f => f.path).filter(shown).slice(0, LIMIT)
}

/** Comments as the brief of the step they go to: where each points, what it says. */
export const commentsNote = (title, comments) => [
  `${title}: the person looked at the results and left these comments — deal with each one`,
  ...comments.map(c => `- ${c.file || 'the whole'}${whereText(c)}: ${c.text}`),
].join('\n')
