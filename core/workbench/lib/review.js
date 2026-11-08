// A person's review with a loop of its own (docs/design/review-step.md). The step shows what is to be looked at — the
// files it names (`show`), else what the step before it changed — and the person comments on it: on a passage, some
// lines, a field, a part of an image, a moment of a video, or the whole; they may change a file themselves too (a
// version of theirs). Then they choose: approve (the run goes on), revise with my notes (the step's agent changes the
// files now, answers every comment, and the person looks again — one round more), send it back to an earlier step
// (`back`, as before), or stop. Each round starts at a version of its own, so two rounds compare. What was said, chosen
// and answered goes in the ledger: it is between the person and the agent (the agents' messages to each other are not).
// Every `ask: 'review'` person step runs here; a pack calls reviewStep(w, s) as it calls personStep.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { WAIT, cardOf, deadline, settle } from './person.js'
import { dirOf } from './subject.js'
import { relPath } from './versions.js'

export const ROUNDS = 5
export const ROUNDS_MAX = 20
export const LIMITS = { comments: 200, text: 4000, quote: 1000, around: 120, field: 200, show: 20, pattern: 200, files: 60, diff: 20000, reply: 2000 }
const STATUS = ['open', 'done', 'declined']
/** The note an agent writes first when the step asks for it (`gather`): what was done, what to look at. */
export const notePath = key => `review/${key}/note.md`

const coded = (code, message, params = {}) => Object.assign(new Error(message), { code, params })
const text = (v, n) => String(v ?? '').trim().slice(0, n)
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null }

/** A file of the run's folder by its path there (inside it, not through a link, a file) → its full path, or null. */
export function workPath(run, rel) {
  const p = relPath(rel)
  if (!p) return null
  try {
    const root = realpathSync(dirOf(run)), full = join(root, p)
    return realpathSync(full) === full && statSync(full).isFile() ? full : null
  } catch { return null }
}

/** Where a comment points, as the page sends it, checked (null: the whole; anything else malformed throws). */
export function anchorOf(at) {
  if (at == null) return null
  if (typeof at !== 'object' || Array.isArray(at)) throw coded('badComment', 'a comment points at a passage, lines, a field, a box, a time — or nothing')
  if ('quote' in at) {
    const quote = String(at.quote ?? '').slice(0, LIMITS.quote)
    if (!quote.trim()) throw coded('badComment', 'the passage is empty')
    return { quote, prefix: String(at.prefix ?? '').slice(-LIMITS.around), suffix: String(at.suffix ?? '').slice(0, LIMITS.around) }
  }
  if ('lines' in at) {
    const [a, b] = Array.isArray(at.lines) ? at.lines.map(x => num(x, 1, 1e7)) : []
    if (!a || !b || b < a) throw coded('badComment', 'lines: [first, last], counted from 1')
    return { lines: [Math.round(a), Math.round(b)] }
  }
  if ('field' in at) { const f = text(at.field, LIMITS.field); if (!f) throw coded('badComment', 'the field has no name'); return { field: f } }
  if ('box' in at) {
    const b = Array.isArray(at.box) && at.box.length === 4 ? at.box.map(x => num(x, 0, 1)) : []
    if (b.length !== 4 || b.some(x => x === null) || b[0] + b[2] > 1.0001 || b[1] + b[3] > 1.0001) throw coded('badComment', 'box: [x, y, width, height], each 0–1 of the image')
    // (a page of a PDF: its number, from 1)
    const page = at.page == null ? null : num(at.page, 1, 1e5)
    if (at.page != null && !page) throw coded('badComment', 'page: a page number, from 1')
    return { box: b.map(x => Math.round(x * 1e4) / 1e4), ...(page && { page: Math.round(page) }) }
  }
  if ('time' in at) { const s = num(at.time, 0, 1e7); if (s === null) throw coded('badComment', 'time: seconds from the start'); return { time: Math.round(s * 10) / 10 } }
  throw coded('badComment', 'a comment points at a passage, lines, a field, a box, a time — or nothing')
}

/**
 * The comments as the page sends them, merged into those kept (`kept`), for round `round`. A comment the agent has not
 * seen yet (no round sent) is the person's to change or drop; one it has answered keeps its words and its answer — the
 * person may only open it again (status open: it goes to the agent once more). → the comments to keep
 */
export function mergeComments(kept, sent, { files, round }) {
  if (!Array.isArray(sent)) throw coded('badComment', 'comments: a list')
  if (sent.length > LIMITS.comments) throw coded('badComment', `at most ${LIMITS.comments} comments in one review`)
  const old = new Map(kept.map(c => [c.id, c]))
  const out = [], seen = new Set()
  for (const c of sent) {
    const id = String(c?.id ?? '')
    if (!/^c\d{1,6}$/.test(id) || seen.has(id)) throw coded('badComment', `a comment's id is c<number>, once (${JSON.stringify(id.slice(0, 20))})`)
    seen.add(id)
    const was = old.get(id)
    if (was?.sentIn) {
      // answered (or sent) already: only its status may change, and only back to open
      const status = c.status === 'open' ? 'open' : was.status
      out.push({ ...was, status, ...(status === 'open' && was.status !== 'open' && { reopenedIn: round }) })
      continue
    }
    const words = text(c.text, LIMITS.text)
    if (!words) throw coded('badComment', 'a comment says something')
    const file = c.file == null || c.file === '' ? null : String(c.file)
    if (file && !files.includes(file)) throw coded('badComment', `${file} is not one of the files under review`)
    out.push({ id, file, at: anchorOf(c.at), text: words, status: 'open', by: 'person', round: was?.round ?? round, made: was?.made ?? Date.now() })
  }
  // what the agent was given stays, whether or not the page still lists it
  for (const c of kept) if (c.sentIn && !seen.has(c.id)) out.push(c)
  return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
}

// a path pattern: * any name, ** any path (followed by a slash: none too), ? one character; else the path itself
export function globMatch(pattern, path) {
  const p = String(pattern)
  let re = ''
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*' && p[i + 1] === '*') { if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i++ } }
    else if (p[i] === '*') re += '[^/]*'
    else if (p[i] === '?') re += '[^/]'
    else re += p[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(path)
}

/**
 * Who changes the files in a round: the step's `revisedBy` (the step whose agent it is, or a role), else the nearest
 * agent step before it; false or null: nobody (the review offers no "revise with my notes"). → { role, step } | null
 */
export function reviserOf(stages, s) {
  if (s.revisedBy === false || s.revisedBy === null) return null
  const agentStep = x => x && x.owner && x.owner !== 'system' && !['model', 'branch', 'parallel', 'back'].includes(x.generic)
  if (typeof s.revisedBy === 'string' && s.revisedBy) {
    const st = stages.find(x => x.key === s.revisedBy && agentStep(x)) || stages.find(x => x.owner === s.revisedBy && agentStep(x))
    return st ? { role: st.owner, step: st.key } : null
  }
  const i = stages.findIndex(x => x.key === s.id)
  for (let j = (i < 0 ? stages.length : i) - 1; j >= 0; j--) if (agentStep(stages[j])) return { role: stages[j].owner, step: stages[j].key }
  return null
}

export const whereText = c => where(c, clock)
/**
 * The steps work can go back to (a run going on again from one, a review sending its comments back): those that make
 * something — not the request, the report, a person's or a 结果 step, a branch, a parallel block's lanes. `before`:
 * only those before this step. → [{ key, title }]
 */
export function stepsBack(run, wf, { before = null } = {}) {
  const stages = wf?.stages || []
  const at = before ? (run.stages || []).findIndex(s => s.key === before) : -1
  return (run.stages || []).slice(0, at < 0 ? undefined : at).map(s => stages.find(x => x.key === s.key)).filter(Boolean)
    .filter(x => !['intake', 'report'].includes(x.key) && !x.lane && !['person', 'approval', 'output', 'branch', 'parallel', 'back'].includes(x.generic) && !x.person)
    .map(x => ({ key: x.key, title: x.title || x.key }))
}

/** A task's requested revision returns to creation, rather than a deterministic export or read-only audit. */
export function revisionStep(run, wf) {
  const back = stepsBack(run, wf)
  if (wf?.reviseFrom) return back.find(s => s.key === wf.reviseFrom) || null
  return back.filter(s => {
    const def = wf.stages.find(x => x.key === s.key)
    return def.owner !== 'system' && wf.roles?.[def.owner]?.access === 'write'
  }).at(-1) || back.at(-1) || null
}

/** Results comments need a step that can act on them. An explicit revision contract excludes read-only checks and
 * deterministic system steps, except the declared entry (which may dispatch creation itself). Continue/rewind keep
 * using stepsBack and retain their full replay choices. Workflows without the contract keep their existing choices. */
export function revisionSteps(run, wf) {
  const back = stepsBack(run, wf)
  if (!wf?.reviseFrom) return back
  return back.filter(s => {
    const def = wf.stages.find(x => x.key === s.key)
    return s.key === wf.reviseFrom || (def.owner !== 'system' && wf.roles?.[def.owner]?.access === 'write')
  })
}

const where = (c, fmt) => {
  const a = c.at
  if (!a) return ''
  if (a.quote) return ` — on the passage "${a.quote.replace(/\s+/g, ' ')}"${a.prefix || a.suffix ? ` (${[a.prefix && `after "…${a.prefix.replace(/\s+/g, ' ')}"`, a.suffix && `before "${a.suffix.replace(/\s+/g, ' ')}…"`].filter(Boolean).join(', ')})` : ''}`
  if (a.lines) return a.lines[0] === a.lines[1] ? ` — line ${a.lines[0]}` : ` — lines ${a.lines[0]}–${a.lines[1]}`
  if (a.field) return ` — the field "${a.field}"`
  if (a.box) { const [x, y, w, h] = a.box.map(v => Math.round(v * 100)); return ` — ${a.page ? `page ${a.page}, the part` : 'the part of the image'} ${x}%–${x + w}% from the left, ${y}%–${y + h}% from the top` }
  if (a.time !== undefined) return ` — at ${fmt(a.time)}`
  return ''
}
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${s % 1 ? `.${Math.round((s % 1) * 10)}` : ''}`

/** The task for the agent that changes the files: every open comment where it points, and what the person changed themselves. */
export function reviseBrief({ s, review, open, diff }) {
  const list = open.map(c => {
    const before = c.reply ? `\n  (you answered this before: "${c.reply.replace(/\s+/g, ' ').slice(0, 300)}" — the person opened it again)` : ''
    return `- [${c.id}] ${c.file || 'the whole'}${where(c, clock)}: ${c.text}${before}`
  }).join('\n')
  const changed = diff.trim()
    ? `## What the person changed themselves (keep it; do not undo it)\n\`\`\`diff\n${diff.length > LIMITS.diff ? `${diff.slice(0, LIMITS.diff)}\n… (cut: ${diff.length - LIMITS.diff} more characters — see the files)` : diff}\n\`\`\``
    : ''
  return [
    `## The person reviewed this and left comments (round ${review.round})`,
    `The review "${s.title}"${s.text ? `: ${s.text}` : ''}`,
    `Files under review: ${(review.files || []).join(', ') || '(none listed)'}`,
    'Change the files in your folder so that each comment below is dealt with. Change only what the comments ask for, keep the files where they are, and do not undo what the person changed themselves.',
    `## The comments\n${list || '(none — only the person\'s own changes below: make the rest of the work agree with them)'}`,
    changed,
    `## When you are done\nCall stage_result once, with:\n{ "summary": "what you changed, in a few lines", "replies": [{ "id": "${open[0]?.id || 'c1'}", "status": "done" or "declined", "reply": "what you did, or why you did not" }, …] }\nOne reply for every comment above${open.length ? ` (${open.map(c => c.id).join(', ')})` : ''}. "declined" is fine when a comment should not be followed — say why; the person decides.`,
  ].filter(Boolean).join('\n\n')
}

const noteBrief = (s, key, files) => [
  `## Before the person reviews: a note for them ("${s.title}")`,
  `Write ${notePath(key)} in your folder (Markdown, short): what the steps so far did, which files to look at and in what order (${files.join(', ') || 'the files you made'}), what you are unsure of, and what you want the person to decide. Write it for a person who did not watch the work.`,
  `Then call stage_result once with { "summary": "one line" }.`,
].join('\n\n')

/**
 * The result of a review's own task, checked (lib/tools.js validateStageResult sends it here while the step's review is
 * revising or gathering): a reply for every comment the agent was given; the note written.
 */
export function checkReviewResult(c, review, result) {
  const fail = why => { throw new Error(`${c.stage}: invalid stage_result (${why})`) }
  if (!text(result.summary, 4000)) fail('summary: what you changed, in a few lines')
  if (review.status === 'gathering') {
    const f = c.run && join(dirOf(c.run), notePath(c.stage))
    if (!f || !existsSync(f) || !readFileSync(f, 'utf8').trim()) fail(`write ${notePath(c.stage)} first`)
    return
  }
  const given = review.revising?.comments || []
  if (!Array.isArray(result.replies)) fail(`replies: one for each comment (${given.join(', ')})`)
  const by = new Map()
  for (const r of result.replies) {
    const id = String(r?.id ?? '')
    if (!given.includes(id)) fail(`replies: ${id || '(no id)'} is not a comment you were given (${given.join(', ')})`)
    if (!STATUS.slice(1).includes(r.status)) fail(`replies: ${id}'s status is done or declined`)
    if (!text(r.reply, LIMITS.reply)) fail(`replies: ${id} says what you did, or why not`)
    by.set(id, r)
  }
  const missing = given.filter(id => !by.has(id))
  if (missing.length) fail(`replies: none yet for ${missing.join(', ')}`)
}

/** The files a round shows: the step's `show` patterns over the version's files, else what the step before it changed; the note first. */
async function shownFiles(w, s) {
  const v = w.versions
  if (!v) return []
  const all = (await v.files('HEAD').catch(() => [])).map(f => f.path)
  let paths = []
  if (s.show?.length) paths = [...new Set(s.show.flatMap(g => all.filter(p => globMatch(g, p))))] // in the order the step names them
  else {
    const stages = w.run.stages || [], i = stages.findIndex(x => x.key === s.id)
    for (let j = i - 1; j >= 0 && !paths.length; j--) {
      const commit = stages[j].version?.commit
      if (commit && stages[j].version?.base !== commit) paths = (await v.changes(commit).catch(() => [])).filter(f => f.status !== 'D').map(f => f.path)
    }
  }
  const note = notePath(s.id)
  return [...(all.includes(note) ? [note] : []), ...paths.filter(p => p !== note && !p.startsWith(`review/${s.id}/`))].slice(0, LIMITS.files)
}

/** The step (w: its context; s: its settings — id, title, text, show, gather, revisedBy, back, rounds, display, wait). */
export async function reviewStep(w, s) {
  const key = s.id
  const get = () => w.run.reviews?.[key]
  const put = change => w.update(r => {
    const cur = r.reviews?.[key] || {}
    return { ...r, reviews: { ...(r.reviews || {}), [key]: { ...cur, ...(typeof change === 'function' ? change(cur) : change) } } }
  })
  const head = async () => (await w.versions?.log().catch(() => []))?.at(-1)?.commit || null
  const snapshot = async (subject, round) => (await w.versions?.snapshot(subject, { kind: 'review', step: key, round }).catch(() => null))?.commit || await head()
  const who = reviserOf(w.workflow?.stages || [], s)
  const max = Math.min(Math.max(Number(s.rounds) || ROUNDS, 1), ROUNDS_MAX)
  const wait = { wait: s.wait ?? WAIT.review, deadline: deadline(s.wait ?? WAIT.review) }
  const taken = a => w.store.put('approval', { ...a, applied: true, ...(a.result && { result: { ...a.result, applied: true } }) })
  const stopped = note => ({ ok: false, stop: true, verdict: 'failed', note: `${s.title}: ${note}` })
  const said = (words, stage) => w.update(r => ({ ...r, guidance: [...(r.guidance || []), { ...(stage && { stage }), text: String(words).slice(0, 4000), from: key, at: Date.now() }] }))

  // a new review — the first time, or the work came back here after it was sent back (the earlier ones are kept in `past`)
  if (!get()?.round || get().status === 'done') {
    const v = await head(), was = get()
    put({ round: 1, version: v, rounds: [{ n: 1, version: v, at: Date.now() }], comments: [], status: 'person', agent: who?.role || null, step: who?.step || null, max, revising: null,
      ...(was?.round && { past: [...(was.past || []), { rounds: was.rounds, comments: was.comments, at: Date.now() }].slice(-10) }) })
    if (s.gather && who) {
      put({ status: 'gathering' })
      const files = await shownFiles(w, s)
      await w.agent(who.role, noteBrief(s, key, files), { step: who.step, title: `${s.title}: note` })
      const commit = await snapshot(`${s.title}: the note for the review`, 1)
      put(r => ({ status: 'person', version: commit, rounds: r.rounds.map(x => (x.n === 1 ? { ...x, version: commit } : x)) }))
    }
  }
  if (get().status === 'gathering') put({ status: 'person' }) // (cut short while it wrote the note: the review goes on without waiting for it)

  for (;;) {
    put({ files: await shownFiles(w, s), max, agent: who?.role || null, step: who?.step || null })
    if (get().status === 'revising') {
      await revise()
      continue
    }
    const st = get()
    const amend = !!who && st.round <= max
    // sent back with the comments: to the step the person picks on the page, of those before it (`back`, else the
    // reviser's step, else the nearest one, picked to begin with)
    const backTo = stepsBack(w.run, w.workflow, { before: key })
    const back = [s.back, who?.step, backTo.at(-1)?.key].find(k => k && backTo.some(b => b.key === k)) || null
    const options = [
      { label: 'Approve', action: 'accept', does: 'the run goes on' },
      ...(amend ? [{ label: 'Revise with my notes', action: 'amend', does: `${who.role} changes it now, answers each comment, and you look again` }] : []),
      ...(back ? [{ label: 'Ask for changes', action: 'revise', from: back, does: `back to ${back}, with your notes` }] : []),
      { label: 'Stop the run', action: 'stop', does: 'nothing after this step runs' },
    ]
    const card = cardOf(w, s, 'decision', {
      action: 'decision', title: st.round > 1 ? `${s.title} · round ${st.round}` : s.title,
      payload: { why: s.text, options, recommended: null, blocking: true, stage: key, by: 'workflow', person: 'review', editor: 'workbench.review', review: { round: st.round, max, backTo, ...(s.display && { display: s.display }) }, ...wait },
    })
    const a = await settle(w, card.id, 'decision')
    if (!a) return { ok: false, note: 'stopped' }
    taken(a)
    const picked = a.status === 'done' ? a.result?.option : null
    // (the step the page sent it back to, when it is one of those it offered)
    const o = picked?.action === 'revise' && backTo.some(b => b.key === a.payload?.from) ? { ...picked, from: a.payload.from, does: `back to ${a.payload.from}, with your notes` } : picked
    // what was typed in the card's own box is a comment on the whole
    const typed = String(a.payload?.comment || '').trim()
    if (typed) put(r => ({ comments: [...r.comments, { id: `c${Math.max(0, ...r.comments.map(c => Number(c.id.slice(1)))) + 1}`, file: null, at: null, text: typed.slice(0, LIMITS.text), status: 'open', by: 'person', round: r.round, made: Date.now() }] }))
    const now = get(), open = now.comments.filter(c => c.status === 'open')
    if (o) w.update(r => ({ ...r, decisions: [...(r.decisions || []), { id: a.id, question: a.title, label: o.label, does: o.does || '', action: o.action, from: o.from || null, ...(open.length && { notes: open.map(c => c.text).join(' · ').slice(0, 600) }), at: Date.now() }] }))
    put(r => ({ rounds: r.rounds.map(x => (x.n === r.round ? { ...x, choice: o?.action || 'stop', open: open.length } : x)) }))
    w.evidence({ actor: 'user', kind: 'gate', title: `${s.title}, round ${now.round}: ${o ? o.label : 'stopped'}${open.length ? ` — ${open.length} comment(s)` : ''}`.slice(0, 300),
      input: { round: now.round, choice: o?.action || 'stop', comments: open.map(c => ({ id: c.id, file: c.file, at: c.at, text: c.text })) }, ok: true })
    if (!o || o.action === 'stop') { put({ status: 'done' }); return stopped(a.status === 'rejected' ? `rejected by the person${a.reason ? ` — ${String(a.reason).slice(0, 300)}` : ''}` : 'stopped by the person') }
    if (o.action === 'amend') {
      put({ status: 'revising' })
      continue
    }
    put({ status: 'done' })
    w.update(r => ({ ...r, outputs: { ...(r.outputs || {}), [key]: { verdict: o.from ? 'changes' : 'approve', rounds: now.round, comments: now.comments.length, ok: true } } }))
    if (o.from) {
      // the comments go to the step the work goes back to (its brief says what the person asked for)
      said(`${s.title} → ${o.label}${open.length ? `:\n${open.map(c => `- ${c.file || 'the whole'}${where(c, clock)}: ${c.text}`).join('\n')}` : ''}`, o.from)
      return { ok: false, goto: o.from, note: `${o.label} — back to ${o.from}${open.length ? ` with ${open.length} comment(s)` : ''}` }
    }
    return { ok: true, note: `${o.label}${now.round > 1 ? ` after ${now.round} rounds` : ''}${now.comments.length ? `, ${now.comments.length} comment(s)` : ''}` }
  }

  // one round of the agent's: it changes the files and answers every open comment; the next round starts at its version
  async function revise() {
    const st = get(), open = st.comments.filter(c => c.status === 'open')
    const diff = st.version ? await w.versions.diff(st.version, await head()).catch(() => '') : ''
    if (!open.length && !diff.trim()) {
      // nothing to change: no comment open, no change of the person's — the review asks again
      put({ status: 'person', revising: null })
      w.evidence({ actor: 'system', kind: 'gate', title: `${s.title}, round ${st.round}: nothing to revise (no open comment, no change) — asked again`, input: { round: st.round }, ok: true })
      return
    }
    put({ revising: { comments: open.map(c => c.id), at: Date.now() } })
    w.evidence({ actor: 'system', kind: 'gate', title: `${s.title}, round ${st.round}: ${open.length} comment(s)${diff.trim() ? ' and the person\'s own changes' : ''} to ${who.role}`.slice(0, 300), input: { round: st.round, comments: open.map(c => c.id) }, ok: true })
    const { result } = await w.agent(who.role, reviseBrief({ s, review: st, open, diff }), { step: who.step, title: `${s.title}: round ${st.round}` })
    const commit = await snapshot(`${s.title}: round ${st.round} — ${who.role} changed it`, st.round)
    const replies = new Map((result?.replies || []).map(r => [String(r.id), r]))
    put(r => ({
      comments: r.comments.map(c => (replies.has(c.id) && c.status === 'open' ? { ...c, status: replies.get(c.id).status, reply: text(replies.get(c.id).reply, LIMITS.reply), repliedIn: r.round, sentIn: r.round } : c)),
      rounds: [...r.rounds.map(x => (x.n === r.round ? { ...x, summary: text(result?.summary, 2000), by: who.role, after: commit } : x)), { n: r.round + 1, version: commit, at: Date.now() }],
      round: r.round + 1, version: commit, status: 'person', revising: null,
    }))
    w.evidence({ actor: who.role, kind: 'gate', title: `${s.title}, round ${st.round}: ${who.role} — ${text(result?.summary, 200)}`.slice(0, 300),
      input: { round: st.round, version: commit }, output: [...replies.values()].map(r => `[${r.id}] ${r.status}: ${r.reply}`).join('\n').slice(0, 4000), ok: true })
  }
}
