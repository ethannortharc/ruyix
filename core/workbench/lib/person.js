// A person's part of a run: a step that asks the one person the workbench works for. Ruyix is single-person — there is
// no team to review, no one else to escalate to: each ask is a card in that person's inbox, and the run waits at the
// step until it is answered (or stopped).
//   review  the person looks at the run so far: approve (the run goes on), ask for changes (the run goes back to the
//           step the review names, the person's notes in that step's brief), or stop the run;
//   input   the person answers a question; the answer is what the step hands back, and the next steps build on it;
//   decide  the person picks one of the step's choices — a choice may send the run back to an earlier step; a branch
//           after it reads the choice (what the step handed back);
//   do      the person does something outside the workbench and says it is done (with a note, if they like);
//   chat    the person talks it through with an agent of the run — the one of the step before (`with`: another step's)
//           — as long as they like (docs/design/agent-work.md §7); when they say it is settled, the agent writes what was
//           agreed and the steps after this one build on it; or back to an earlier step (`back`) with it, or stop.
// How long a step waits (hours; 0: as long as it takes): past that the person is reminded once — the card says it is
// overdue and the inbox counts it among what waits on them — and the run keeps waiting: what a person decides is never
// decided by the clock.

import { reviewStep } from './review.js'

export const ASKS = ['review', 'input', 'decide', 'do', 'chat']
/** Hours a person step waits before its person is reminded, by what it asks (0: no reminder). */
export const WAIT = { review: 0, decide: 0, input: 24, do: 72, chat: 0 }
export const WAIT_MAX = 720
const ANSWERS = ['continue', 'stop']
// a discussion (a chat step's card, or one its agent asked for: `talk`): settled — it goes on with what was agreed (the
// agent's write-up) —, back to an earlier step with it, or stop
const TALK_ANSWERS = { chat: ['continue', 'back', 'stop'], talk: ['settle', 'retry', 'continue', 'stop'] }
/** How many messages a discussion holds (an ask's questions: 20). */
export const TALK_MAX = 60
/** The kinds of a help card a step asks on its own (lib/human.js): its agent asked, its confidence is low, it is stuck. */
export const ASKED = ['agent', 'low', 'stuck']
const SETTLE_MS = 3000

/**
 * A person's answer on a step's ask card ({ answer: continue | stop, input }), checked: an input step needs the answer
 * itself; a "do" step may carry a note; a step that asked on its own (ASKED) may also be run again (`retry`) with what the
 * person says. Throws (a refusal, not a failed card) when it says nothing.
 */
export function answerOf(p = {}) {
  const answer = p.answer === undefined || p.answer === '' ? 'continue' : p.answer
  const asked = ASKED.includes(p.kind)
  const allowed = p.kind === 'chat' ? TALK_ANSWERS.chat : asked && p.talk ? TALK_ANSWERS.talk : asked ? ['retry', ...ANSWERS] : ANSWERS
  if (!allowed.includes(answer)) throw Object.assign(new Error(`answer with ${allowed.join(', ')}`), { code: 'badAnswer', params: {} })
  if (answer === 'back' && !p.back) throw Object.assign(new Error('this discussion has no step to go back to'), { code: 'badAnswer', params: {} })
  const input = String(p.input ?? '').trim().slice(0, 8000)
  if (answer === 'continue' && p.kind === 'input' && !input) throw Object.assign(new Error('write the answer first'), { code: 'needInput', params: {} })
  if (answer === 'retry' && !input) throw Object.assign(new Error('say what the step should know or try'), { code: 'needInput', params: {} })
  return { answer, input }
}

/** What the person said for a step (a review's notes, an answer for the whole run), as a section of its brief. */
export function guidanceText(run, key) {
  const said = (run?.guidance || []).filter(g => !g.stage || g.stage === key)
  if (!said.length) return ''
  return `## What the person said (build on it)\n${said.map(g => `- ${String(g.text).replace(/\n+/g, ' ')}${g.stage ? '' : ' (for the whole run)'}`).join('\n')}`
}

export const deadline = hours => (hours ? Date.now() + hours * 3600e3 : null)
/**
 * This step's card that still counts: one waiting for the person, or answered and not taken up yet (the run was cut short
 * in between: the answer is still to be heard) — else a new one.
 */
export const cardOf = (w, s, action, spec) => w.store.list('approval')
  .filter(a => a.runId === w.run.id && a.action === action && a.payload?.stage === s.id && a.payload?.by === 'workflow')
  .filter(a => !a.applied && !a.result?.applied && ['pending', 'failed', 'running', 'done', 'rejected'].includes(a.status))
  .at(-1) || w.approval(spec)

/**
 * Until the card is answered — done or rejected — or the run is stopped (→ null). Meanwhile the run says it waits for the
 * person; past the card's deadline the person is reminded once (the card carries remindedAt; the ledger says so).
 */
export async function settle(w, id, waiting, { onChat } = {}) {
  let held = false
  const free = () => held && w.update({ status: 'running', waiting: null, waitingFor: null })
  for (;;) {
    if (w.signal?.aborted) return null
    const a = w.store.get('approval', id)
    if (!a || ['done', 'rejected'].includes(a.status)) { free(); return a }
    // a discussion: the person's message gets its answer, one at a time (the card stays open meanwhile)
    const q = onChat && (a.chat || []).find(x => !x.answer && !x.error)
    if (q) { if (!held) { held = true; w.update({ status: 'waiting', waiting, waitingFor: id }) } await onChat(a, q); continue }
    if (a.payload?.deadline && Date.now() > a.payload.deadline && !a.payload.remindedAt) {
      w.store.put('approval', { ...a, payload: { ...a.payload, remindedAt: Date.now() } })
      w.evidence({ actor: 'system', kind: 'gate', title: `${a.title}: no answer within ${a.payload.wait} h — the person is reminded, the run keeps waiting`.slice(0, 300), input: { approval: id }, ok: true })
    }
    if (!held) { held = true; w.update({ status: 'waiting', waiting, waitingFor: id }) }
    await w.sleep(w.settleMs || SETTLE_MS)
  }
}

/**
 * A person step, as the engine runs it (w: the step's context). → the step's outcome: { ok, note } — or { goto } (changes
 * asked, a choice that goes back), or a stop.
 */
export async function personStep(w, s) {
  // a review has a loop of its own: comments where they point, the agent revising, round after round (lib/review.js)
  if (s.ask === 'review') return reviewStep(w, { ...s, ...(s.editor && !s.display && { display: s.editor }) })
  const keep = out => w.update(r => ({ ...r, outputs: { ...(r.outputs || {}), [s.id]: { ...out, ok: true } } }))
  const said = (text, stage) => w.update(r => ({ ...r, guidance: [...(r.guidance || []), { ...(stage && { stage }), text: String(text).slice(0, 4000), from: s.id, at: Date.now() }] }))
  const taken = a => w.store.put('approval', { ...a, applied: true, ...(a.result && { result: { ...a.result, applied: true } }) })
  const stopped = note => ({ ok: false, stop: true, verdict: 'failed', note: `${s.title}: ${note}` })
  const wait = { wait: s.wait ?? WAIT[s.ask], deadline: deadline(s.wait ?? WAIT[s.ask]) }

  if (s.ask === 'chat') return chatStep(w, s, { keep, said, taken, stopped, wait })
  if (s.ask === 'input' || s.ask === 'do') {
    const card = cardOf(w, s, 'help', { action: 'help', title: s.title, payload: { kind: s.ask, why: s.text, stage: s.id, blocking: true, by: 'workflow', ...wait } })
    const a = await settle(w, card.id, 'person')
    if (!a) return { ok: false, note: 'stopped' }
    taken(a)
    const ans = a.status === 'rejected' ? { answer: 'stop', input: a.reason || '' } : a.result || {}
    if (ans.answer === 'stop') return stopped(`stopped by the person${ans.input ? ` — ${String(ans.input).slice(0, 300)}` : ''}`)
    keep({ answer: ans.input || '', done: true })
    if (ans.input) said(`${s.title}: ${ans.input}`)
    return { ok: true, note: String(ans.input || (s.ask === 'do' ? 'done' : '')).replace(/\s+/g, ' ').slice(0, 300) || 'answered' }
  }

  // review and decide: a choice on a decision card
  const options = s.ask === 'decide'
    ? s.options.map(o => ({ label: o.label, action: o.to ? 'revise' : 'accept', ...(o.to && { from: o.to }) }))
    : [{ label: 'Approve', action: 'accept', does: 'the run goes on' }, ...(s.back ? [{ label: 'Ask for changes', action: 'revise', from: s.back, does: `back to ${s.back}, with your notes` }] : [])]
  // (s.editor: a pack's editor on the card — '<pack>.<name>' — where the person changes what is decided on before choosing)
  const card = cardOf(w, s, 'decision', { action: 'decision', title: s.title, payload: { why: s.text, options: [...options, { label: 'Stop the run', action: 'stop', does: 'nothing after this step runs' }], recommended: null, blocking: true, stage: s.id, by: 'workflow', person: s.ask, ...(s.editor && { editor: s.editor }), ...wait } })
  const a = await settle(w, card.id, 'decision')
  if (!a) return { ok: false, note: 'stopped' }
  taken(a) // the step takes its own answer (the engine's look at the step's decisions afterwards leaves it be)
  const o = a.status === 'done' ? a.result?.option : null
  const notes = String(a.payload?.comment || '').trim()
  if (o) w.update(r => ({ ...r, decisions: [...(r.decisions || []), { id: a.id, question: a.title, label: o.label, does: o.does || '', action: o.action, from: o.from || null, ...(notes && { notes }), at: Date.now() }] }))
  if (!o || o.action === 'stop') return stopped(a.status === 'rejected' ? `rejected by the person${a.reason ? ` — ${String(a.reason).slice(0, 300)}` : ''}` : 'stopped by the person')
  keep(s.ask === 'review' ? { verdict: o.from ? 'changes' : 'approve', ...(notes && { notes }) } : { choice: o.label, ...(notes && { notes }) })
  if (o.from) {
    // the notes go to the step the work goes back to (its brief says what the person asked for)
    said(`${s.title} → ${o.label}${notes ? `: ${notes}` : ''}`, o.from)
    return { ok: false, goto: o.from, note: `${o.label} — back to ${o.from}${notes ? `: ${notes.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` }
  }
  return { ok: true, note: `${o.label}${notes ? `: ${notes.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` }
}

/**
 * A discussion step: the agent it talks with is the one of `with`, else of the latest agent step before it that ran. Each
 * of the person's messages is answered (w.talk: in that agent's session when it still has one, else from the record);
 * settled, the agent writes what was agreed — this step's result, and what every step after it is told.
 */
async function chatStep(w, s, { keep, said, taken, stopped, wait }) {
  const r = w.run, at = r.stages.findIndex(x => x.key === s.id)
  const before = r.stages.slice(0, at < 0 ? r.stages.length : at).reverse()
  const withKey = s.with || before.find(x => x.agent || x.session || x.tasks?.length)?.key || null
  const card = cardOf(w, s, 'help', { action: 'help', title: s.title, payload: { kind: 'chat', why: s.text, stage: s.id, with: withKey, blocking: true, by: 'workflow', ...(s.back && { back: s.back }), ...wait } })
  const reply = async (a, q) => {
    let fields
    try { fields = { answer: (await w.talk(a.id, q.q)) || '(no answer)' } } catch (err) { if (w.signal?.aborted) return; fields = { error: String(err?.message || err).slice(0, 500) } }
    const cur = w.store.get('approval', a.id)
    w.store.put('approval', { ...cur, chat: (cur.chat || []).map(x => (x.n === q.n ? { ...x, ...fields, answeredAt: Date.now() } : x)) })
  }
  const a = await settle(w, card.id, 'person', { onChat: reply })
  if (!a) return { ok: false, note: 'stopped' }
  taken(a)
  const ans = a.status === 'rejected' ? { answer: 'stop', input: a.reason || '' } : a.result || {}
  if (ans.answer === 'stop') return stopped(`stopped by the person${ans.input ? ` — ${String(ans.input).slice(0, 300)}` : ''}`)
  const talked = (a.chat || []).filter(x => x.answer).length
  // what was agreed, in the agent's words (nothing said: only what the person added)
  let agreed = ''
  if (talked) { try { agreed = String(await w.talk(a.id, ans.input || null, { last: true }) || '').trim() } catch { /* their words below */ } }
  const settled = agreed.slice(0, 6000), note = String(ans.input || '').trim()
  // (what the steps after it are told: what was agreed, and the person's own line)
  const told = [settled, note && `${settled ? 'The person adds: ' : ''}${note}`].filter(Boolean).join('\n\n')
  w.store.put('approval', { ...w.store.get('approval', a.id), settled })
  w.evidence({ actor: 'system', kind: 'gate', title: `${s.title}: ${talked} message${talked === 1 ? '' : 's'} with the person — ${ans.answer === 'back' ? `back to ${s.back}` : 'settled'}`.slice(0, 300), input: { approval: a.id, with: withKey }, output: told, ok: true })
  keep({ settled, ...(note && { note }), talked, ...(withKey && { with: withKey }) })
  if (ans.answer === 'back') {
    if (told) said(`${s.title}: ${told}`, s.back)
    return { ok: false, goto: s.back, note: `back to ${s.back}${told ? `: ${told.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` }
  }
  if (told) said(`${s.title}: ${told}`)
  return { ok: true, note: told.replace(/\s+/g, ' ').slice(0, 300) || 'nothing to add' }
}
