// The task workflow: work with no domain behind it — a request (a title and what is wanted) → an agent does it with what
// it has (its own tools in the folder it works in, its skills, the connections its steps bind) → the report, with the
// outcome. A built-in like `blank`; one's own workflows build on it with the library's steps (agents, scripts, approvals,
// people, branches, parallel blocks).
// The folder: the one the person names (a host folder: the code to work on), else the run's own.
import { actions, header, intake, renderReport, report, subjectText } from './common.js'

const text = (v, n = 600) => String(v ?? '').trim().slice(0, n)
const list = (v, n = 20) => (Array.isArray(v) ? v : []).slice(0, n)
const OUTCOMES = ['done', 'partial', 'blocked']

/** The agents the worker role names: added to Agent Hub's pool once each (a person's edits and deletions stay). */
export const agents = [
  { id: 'sonnet', name: 'Claude Sonnet', runtime: 'claude', model: 'claude-sonnet-5-5', effort: 'xhigh', notes: 'Everyday work: doing a task, checking, writing' },
  { id: 'codex', name: 'Codex', runtime: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', access: 'full', notes: 'Deep reasoning, and the fallback of a task. Full access: its read-only sandbox blocks the workbench MCP tools' },
]

/** The worker's stage_result → r.outcome (the report's). */
export function outcomeOf(res) {
  return {
    status: OUTCOMES.includes(res?.outcome) ? res.outcome : 'partial',
    summary: text(res?.summary, 6000),
    done: list(res?.done).map(x => text(x, 400)).filter(Boolean),
    left: list(res?.left).map(x => text(x, 400)).filter(Boolean),
    files: list(res?.files, 50).map(x => text(x, 300)).filter(Boolean),
  }
}

const work = {
  key: 'work', owner: 'worker', title: 'Do the task', human: { stuck: true }, // stuck where the run would stop: the person is asked
  async run(w) {
    const { result: res } = await w.agent('worker', [
      header(w, 'work'),
      subjectText(w),
      `## Your task: do what the request asks
1. Work out what is wanted and what "done" means; if the request is unclear in a way only the person can settle, ask with decision_needed or help_needed.
2. Do it, step by step, in your working directory. Check your own result the way a careful colleague would.
3. Say what is done, what is left and why.

Then call stage_result with:
{"summary": "Markdown: what was done in one sentence, then bullets",
 "outcome": "done" | "partial" | "blocked",
 "done": ["…"], "left": ["what is still open, and why"], "files": ["files made or changed, relative to the working directory"]}`,
    ].join('\n\n'), { title: 'Do the task' })
    const outcome = outcomeOf(res)
    w.update({ outcome })
    // blocked: the person is asked — the run ends saying what it needs from them
    if (outcome.status === 'blocked') return { ok: false, verdict: 'need_info', note: outcome.left[0] || 'blocked' }
    return { ok: true, note: `${outcome.status} · ${outcome.done.length} done${outcome.left.length ? ` · ${outcome.left.length} left` : ''}` }
  },
}

/** The outcome in the report, before the evidence: what was done, what is left, the files. */
function taskReport(args) {
  const md = renderReport(args), o = args.run.outcome
  if (!o) return md
  const part = [
    '## Outcome', '', `**${o.status}** — ${o.summary || '(no summary)'}`,
    ...(o.done.length ? ['', '### Done', ...o.done.map(x => `- ${x}`)] : []),
    ...(o.left.length ? ['', '### Left', ...o.left.map(x => `- ${x}`)] : []),
    ...(o.files.length ? ['', '### Files', ...o.files.map(x => `- \`${x}\``)] : []),
    '',
  ].join('\n')
  const at = md.indexOf('\n## ')
  return at < 0 ? `${md}\n${part}` : `${md.slice(0, at)}\n${part}${md.slice(at)}`
}

export default {
  id: 'task',
  title: 'Task',
  description: 'One agent does a request in a folder, and says what is done and what is left.',
  noun: 'task',
  success: 'completed',
  // the form's field that names the folder to work in (optional; a host folder: the code to work on)
  folder: 'folder',
  input: [{ name: 'folder', type: 'text', label: 'Folder (optional)' }],
  // (partly done — or a result that says nothing clear — is not completed: read from the outcome the run keeps, when the
  // report is made — a retry that finished, a report resumed after a restart, say what is so)
  levelOf: r => (r.outcome?.status === 'partial' ? 'partial' : null),
  roles: { worker: { agent: 'sonnet', fallback: 'codex', access: 'write', text: 'Does a task: works out what is wanted, does it in its working directory with its own tools, skills and connections, checks its result, and says what is done and what is left.' } },
  stages: [intake, work, report],
  actions,
  report: taskReport,
}
