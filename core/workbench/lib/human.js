// Where a step asks the person without being a person step (lib/person.js): not a fixed sign-off — a step asks only when it
// needs one. Its agent says so (help_needed: it cannot go on without what only a person has), its result is under the
// step's bar (the confidence it handed back), or it is stuck (it failed where the run would stop). The run waits at that
// step for the answer: what the person knows (the step runs again with it), go on as it is (its outcome stands), or stop
// here. A step asks at most HELP_ROUNDS times in a run; past that it goes on as it would have without a person. Nobody
// answering is not an answer: past the step's wait the person is reminded once and the run keeps waiting — what a person
// decides is never decided by the clock. While it waits, the person may ask the step's agent about it (chatBrief): it
// answers from the run's record and changes nothing.
import { guidanceText } from './person.js'

export const HELP_ROUNDS = 3
export const WAIT_HOURS = 24

/**
 * When a step asks for a person: { stuck, below, wait } — the definition's (a person's workflow: the step's `human`), else
 * the step's default (a built-in step that knows it needs a person when it is stuck). stuck: it failed where the run would
 * stop; below: its confidence (0–100, handed back with its result) is under this bar; wait: hours until the person is
 * reminded (0: never).
 */
export function humanOf(stage) {
  const def = stage?.pick?.human || stage?.human || {}
  const below = def.below, wait = def.wait
  return { stuck: def.stuck ?? false, below: Number.isInteger(below) && below > 0 ? below : null, wait: Number.isInteger(wait) && wait >= 0 ? wait : WAIT_HOURS }
}

/** How sure a step's result is (0–100), or null: the confidence an agent step handed back with its result. */
export function scoreOf(run, key) {
  const own = run.outputs?.[key]?.confidence
  return typeof own === 'number' ? Math.round(own) : null
}

/**
 * Should the step that just ended ask a person? → { kind: 'agent' | 'low' | 'stuck', question, why, score?, bar? } or null.
 * `asked`: a help its agent asked for in this step, still open; `rounds`: how many times this step asked already.
 */
export function needPerson({ run, key, status, out, human, asked, rounds }) {
  if (rounds >= HELP_ROUNDS) return null
  if (asked) return { kind: 'agent', question: asked.title, why: asked.payload?.why || '' }
  if (status === 'failed' && human.stuck && !out.carryOn && !out.goto && !out.back) {
    return { kind: 'stuck', question: `${key}: ${String(out.note || out.verdict || 'it did not get through').slice(0, 280)}`, why: `The step ended ${out.verdict || 'failed'}${out.stop ? ' and the run would stop here' : ''}. What does it need to get through — information, access, a hint?` }
  }
  if (status === 'passed' && human.below) {
    const score = scoreOf(run, key)
    if (score !== null && score < human.below) return { kind: 'low', score, bar: human.below, question: `${key}: ${score}/100 is under the bar of ${human.below}`, why: 'The step got through, but not with enough certainty to build on: look at its result and say what it misses, or let it go on.' }
  }
  return null
}

/**
 * The brief of the step's agent when the person asks it about an ask (a fresh agent, given the step's record): read only —
 * the run is paused; it answers from the record and says what the record does not show.
 */
export function chatBrief({ run, key, ask, chat = [], question, evidence = [] }) {
  const s = run.stages.find(x => x.key === key)
  return [
    `# A question about the step "${key}" of run ${run.id}`,
    'The step asked for the person and the run waits at it for their answer. Before answering, the person asks you — the agent for this step — a question about it.',
    `## The ask\n${ask.title}${ask.payload?.why ? `\n\n${ask.payload.why}` : ''}`,
    `## How the step ended\n${s?.status || '?'}${s?.note ? ` — ${String(s.note).replace(/\n+/g, ' ').slice(0, 600)}` : ''}${s?.result ? `\nIts result: ${JSON.stringify(s.result).slice(0, 4000)}` : ''}`,
    evidence.length ? `## The step's evidence\n${evidence.slice(-40).map(e => `- #${e.seq} ${e.kind}${e.ok === false ? ' ✗' : ''} · ${e.title}`).join('\n')}` : '',
    guidanceText(run, key),
    chat.length ? `## Asked and answered so far\n${chat.map(q => `**The person:** ${q.q}\n\n${q.answer}`).join('\n\n')}` : '',
    `## The question\n${question}`,
    "## Your task\nAnswer from the run's record: read it with wb_context and evidence_get. Change nothing: the run is paused. Cite evidence as #n, and say plainly what the record does not show. Reply with the answer only, in Markdown, in the language of the question.",
  ].filter(Boolean).join('\n\n')
}

/**
 * A discussion's turn for an agent in its own session (docs/design/agent-work.md §7): it knows the step it did; the
 * person's message, or (`last`) the ask to write what was agreed.
 */
export function talkTurn({ card, question, last = false }) {
  const what = `${card?.title || ''}${card?.payload?.why ? ` — ${String(card.payload.why).replace(/\s+/g, ' ').slice(0, 600)}` : ''}`
  if (last) return `[Ruyix · the discussion about "${what}" is settled]\nThe person says it is settled${question ? `, and adds: ${question}` : ''}. Write what was agreed — the decisions${question ? ' (what they add is decided)' : ''}, what to change and how, what is still open — as a short brief for the steps that come next, in the person's language. Only that, no greeting.`
  return `[Ruyix · a discussion with the person]\nThe run is paused at "${what}". The person talks it through with you before it goes on. They say:\n\n${question}\n\nReply to them directly, in their language: answer, explain, propose. Do not change files now — what you agree on is handed to the steps that come next.`
}

/** The brief of an agent that takes part in a discussion from the run's record (no session of its own to go on). */
export function talkBrief({ run, key, card, chat = [], question, last = false, evidence = [] }) {
  const s = run.stages.find(x => x.key === key)
  return [
    `# A discussion with the person about run ${run.id}`,
    `The run is paused for the person to talk something through with you — the agent of the step "${key}" — before it goes on.`,
    `## What to talk about\n${card?.title || ''}${card?.payload?.why ? `\n\n${card.payload.why}` : ''}`,
    s ? `## The step "${key}"\n${s.status || '?'}${s.note ? ` — ${String(s.note).replace(/\n+/g, ' ').slice(0, 600)}` : ''}${s.result ? `\nIts result: ${JSON.stringify(s.result).slice(0, 4000)}` : ''}` : '',
    evidence.length ? `## The step's evidence\n${evidence.slice(-40).map(e => `- #${e.seq} ${e.kind}${e.ok === false ? ' ✗' : ''} · ${e.title}`).join('\n')}` : '',
    guidanceText(run, key),
    chat.length ? `## Said so far\n${chat.map(q => `**The person:** ${q.q}\n\n**You:** ${q.answer}`).join('\n\n')}` : '',
    last ? `${question ? `## The person adds (decided)\n${question}\n\n` : ''}## Your task\nThe person says it is settled. Write what was agreed — the decisions, what to change and how, what is still open — as a short brief for the steps that come next, in the person's language. Only that, in Markdown.`
      : `## The person says\n${question}\n\n## Your task\nReply to them directly: answer, explain, propose. Read the run's record with wb_context and evidence_get where it helps, and cite it as #n. Change nothing: the run is paused. Reply in Markdown, in the language they write in.`,
  ].filter(Boolean).join('\n\n')
}
