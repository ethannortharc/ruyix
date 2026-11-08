// What the workbench opens, in the shell's list of open things (@ruyix/shell/open; docs/design/sessions.md §5): a run's
// page, a result file in the viewer, a live browser — each one of its run's (`of`), so the desk keeps a run's things
// together. Each comes back the way it was opened (its `reopen`: the workbench's open event).
import { openRegistry } from '@ruyix/shell/open'

const OPEN = 'ruyix-workbench:open' // (data.js's)
const reg = () => { try { return openRegistry() } catch { return null } }
// (an id takes letters, digits and : . / - — a file's own name may not: its path goes in as a short hash)
export const hashOf = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0 } return h.toString(36) }
const titleOf = run => run.subject?.title || run.template || run.id

/** A run's page shown (`tab`: the one it is on). */
export function openedRun(run, tab) {
  reg()?.add({ id: `run:${run.id}`, kind: 'run', title: titleOf(run), of: `run:${run.id}`, ofTitle: titleOf(run), reopen: { event: OPEN, detail: { run: run.id, ...(tab && { tab }) } } })
}
/** A file of a run's results looked at in the viewer: back on the results tab, on that file. */
export function openedFile(run, path) {
  const cut = path.lastIndexOf('/')
  reg()?.add({ id: `file:${run.id}:${hashOf(path)}`, kind: 'file', title: path.slice(cut + 1), hint: cut > 0 ? path.slice(0, cut) : titleOf(run), of: `run:${run.id}`, ofTitle: titleOf(run),
    reopen: { event: OPEN, detail: { run: run.id, tab: 'results', file: path } } })
}
/** A run's live browser on a page (`runId`: null when it is a card's, not a run's): its site as the hint. */
export function openedWeb(session, runId, { title, url, runTitle } = {}) {
  let host = ''
  try { host = new URL(url).host } catch { /* not a page yet */ }
  reg()?.add({ id: `web:${session}`, kind: 'web', title: title || host || session, ...(host && { hint: host }), ...(runId && { of: `run:${runId}`, ...(runTitle && { ofTitle: runTitle }) }),
    reopen: { event: OPEN, detail: runId ? { run: runId, tab: 'pipeline' } : { view: 'approvals' } } })
}
export const closedWeb = session => reg()?.close(`web:${session}`)
