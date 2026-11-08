// Who is at work right now, for whatever draws it (the desktop's lights, the runway widget): one small snapshot in
// window.__ruyixActivity, a 'ruyix:activity' event at each change. From the workbench's own store (one poll for the
// page) and, for the runs going, their newest ledger entries — each one a pulse of the agent whose step it is.
//   window.__ruyixActivity = {
//     agents: [{ id: '<run>:<step>', kind: claude | codex | dsh | model | system | person, name, model?, run, title, step,
//                state: working | waiting, since, pulse?: { at, kind } }],
//     links: [{ from, to, kind: together (steps of one run at once) | handoff (one step to the next) | message, at }],
//     runs: [{ id, taskId, title, status, stages: [{ key, status }], stage, waiting, createdAt,
//              segs: [{ key, title, st: done | run | wait | fail | skip | todo }] (a parallel block one), cur (the one at work) }],
//     upcoming: [{ id, title, nextAt }] (scheduled tasks not running now, the soonest first),
//     finished: [{ id, taskId, title, endedAt, ok }] (runs over in the last few seconds), at }
// A plugin adds links of its own (agents messaging each other) through window.__ruyixActivityLinks (an array of
// { from, to, at }) and a 'ruyix:activity-links' event; they are merged in as `message` links. A run's own agents'
// messages (core/messages, its space: the runMessages op) are `message` links too while new (MESSAGE_MS), and its work
// item's `links` (the collaboration graph, docs/design/agent-work.md §6), with `peers` for the steps not at work now.
// The runs are also the workbench's slice ('runs') of the shell's list of the work going on (window.__ruyixWork,
// @ruyix/shell/work; docs/design/sessions.md §3): the ones going, and the finished ones the person has not looked at.
// Each with its lines (docs/design/agent-work.md §2: what its agents are doing, a line at a time, made by rule) and,
// finished, its outcome (§3: a line of what it came to, its first picture); the list's hooks mark one seen and sum it up.
import { workRegistry } from '@ruyix/shell/work'
import { keepLines, linesOf, sayText, toolText } from '@ruyix/shell/work-lines'

const ACTIVE = new Set(['queued', 'running', 'waiting']) // (ui.jsx's: this file stays free of React, checked in node)
const UNSEEN_DAYS = 14, UNSEEN_MAX = 30
const OPEN = 'ruyix-workbench:open' // (data.js's: the event that opens the workbench on a run)
const VIEW = 'ruyix-workbench:view' // (viewer-window.jsx's: a run's results in the viewer's window)
const fileUrl = (runId, seq) => `api/ruyix-workbench/file?run=${encodeURIComponent(runId)}&seq=${seq}` // (data.js's)

/**
 * A run as an item of the work list: { id: 'run:<id>', kind: 'run', title, agents, state, segs, cur, pulse?, lines?,
 * outcome?, startedAt, endedAt, ok, seen, open }. `agents`: its lights now (this feed's agents); `pulse`: its newest
 * one's; `lines`: theirs (of the agents here only); `outcome` (finished): { text, image (a ledger seq), files }; `wait`
 * (waiting for the person): { kind: chat | decision | review | input | do | help | approval, title } — a chat, the desk
 * shows a chat bubble (docs/design/agent-work.md §7); `studio` (started from a studio's record): run.studio.
 */
export function workOfRun(r, agents = [], pulse = null, lines = [], outcome = null, lang = 'en', wait = null, links = []) {
  const verdictFailed = r.verdict?.level === 'failed'
  const state = r.status === 'queued' ? 'queued' : r.status === 'waiting' ? 'waiting' : r.status === 'running' ? (agents.some(a => a.state === 'waiting') ? 'waiting' : 'working')
    : r.status === 'done' ? (verdictFailed ? 'failed' : 'done') : r.status === 'cancelled' || r.status === 'interrupted' ? 'stopped' : 'failed'
  const { segs, cur } = segsOf(r)
  const tab = state === 'waiting' ? 'approvals' : ACTIVE.has(r.status) ? 'pipeline' : 'overview'
  return {
    id: `run:${r.id}`, kind: 'run', title: r.subject?.title || r.template,
    agents: agents.map(a => ({ id: a.id, kind: a.kind === 'model' ? 'dsh' : a.kind, state: a.state, step: a.step })),
    state, segs: segs.map(s => ({ title: s.title || s.key, st: s.st })), cur,
    ...(pulse && { pulse: { at: pulse.at, kind: pulse.kind } }),
    ...(lines.length && agents.length && { lines: lines.filter(l => agents.some(a => a.id === l.agent)) }),
    ...(!ACTIVE.has(r.status) && { outcome: outcomeOf(r, state, outcome, lang) }),
    ...(wait && state === 'waiting' && { wait }),
    // started from a studio's record (docs/design/studio.md): the desk says which studio, the studio shows it as its own
    ...(r.studio && { studio: r.studio }),
    ...(links.length && { links, peers: peersOfRun(r, agents, links) }),
    startedAt: r.createdAt || null, endedAt: r.endedAt || null, ok: r.status === 'done' && !verdictFailed, seen: !!r.seenAt,
    open: { event: OPEN, detail: { run: r.id, tab } },
  }
}
/** The ends of a run's message links that are not its agents at work now: its other steps, named by their titles. */
function peersOfRun(r, agents, links) {
  const ids = [...new Set(links.flatMap(l => [l.from, l.to]))].filter(id => !agents.some(a => a.id === id))
  return ids.map(id => { const key = id.slice(r.id.length + 1), s = r.stages.find(x => x.key === key); return { id, kind: s?.owner === 'system' ? 'system' : 'model', name: (typeof s?.title === 'string' && s.title) || key } })
}
/** A step's agent from the name it posts under (lib/messages.js posterOf: `role@step`, or the step). */
const stepOfPoster = name => String(name).slice(String(name).lastIndexOf('@') + 1)
/**
 * A run's messages (its space's, oldest first) as links between its steps' agents: { from, to, at, text }. One to
 * everyone: a link to each of its agents at work (`atWork`: their ids) but the sender.
 */
export function messageLinks(runId, messages, atWork = []) {
  const out = []
  for (const m of messages) {
    const from = `${runId}:${stepOfPoster(m.from)}`, text = sayText(m.text || '', 60)
    const to = m.to ? [`${runId}:${stepOfPoster(m.to)}`] : atWork.filter(id => id !== from)
    for (const t of to) if (t !== from) out.push({ from, to: t, at: m.at, text })
  }
  return out
}
const MESSAGES_KEPT = 40, MESSAGE_MS = 60000 // a run's links kept for its graph; how long a message is new (the maps')
const HANDOFF_MS = 5000, PULSE_KEEP = 12000, FINISHED_MS = 9000
const DONE_WORDS = { zh: { done: '做完了', failed: '没做成', stopped: '停下了' }, en: { done: 'Done', failed: 'Did not work out', stopped: 'Stopped' } }
/** A finished run's note (docs/design/agent-work.md §3): { ok, text, thumb?, open } — the line it came to, its picture. */
export function outcomeOf(r, state, o, lang = 'en') {
  const words = DONE_WORDS[lang] || DONE_WORDS.en
  const ok = state === 'done'
  return {
    ok, text: sayText(o?.text || '', 120) || words[state] || words.done,
    ...(o?.image != null && { thumb: fileUrl(r.id, o.image) }),
    // what it made: in the viewer's own window (src/viewer-window.jsx); nothing made: its page
    open: o?.files ? { event: VIEW, detail: { run: r.id } } : { event: OPEN, detail: { run: r.id, tab: 'overview' } },
  }
}
/**
 * A run's lines from what its ledger says (the steps the system runs itself: their commands, model calls) — the agents'
 * own come from their activity (linesOf).
 */
export function ledgerLines(runId, evidence, lang = 'en') {
  const out = []
  for (const e of evidence) {
    if (!e.stage || (e.kind !== 'command' && e.kind !== 'model')) continue
    const text = e.kind === 'command' ? toolText({ name: 'bash', target: String(e.title || '').replace(/ → exit -?\d+$/, '') || (lang === 'zh' ? '一条命令' : 'a command'), ok: e.ok }, lang) : (lang === 'zh' ? '问了模型' : 'asked the model') + (e.ok === false ? (lang === 'zh' ? '（没成）' : ' (failed)') : '')
    out.push({ at: e.at || Date.now(), agent: `${runId}:${e.stage}`, text, kind: 'tool', ...(e.ok === false && { ok: false }) })
  }
  return out
}

/**
 * A run's parallel blocks (from the definition it started with): block key → its lanes' step keys. The block and its
 * lanes are all stages of the run; the lanes are the ones at work, the block is where they meet.
 */
export function blocksOf(r) {
  const out = new Map()
  for (const s of r.workflowDef?.steps || []) if (s.use === 'parallel') out.set(s.id, (s.lanes || []).map(l => (l.steps || []).map(x => x.id)))
  return out
}

/** A run's steps as the stretches of its way (a parallel block one, its lanes inside it) and the one at work. */
export function segsOf(r) {
  const blocks = blocksOf(r), inLane = new Set([...blocks.values()].flat(2))
  const one = s => (s.status === 'running' ? (r.status === 'waiting' && (s.asking || s.key === r.stage) ? 'wait' : 'run') : s.status === 'passed' ? 'done' : s.status === 'failed' ? 'fail' : s.status === 'skipped' ? 'skip' : 'todo')
  const segs = r.stages.filter(s => !inLane.has(s.key)).map(s => {
    if (!blocks.has(s.key)) return { key: s.key, ...(typeof s.title === 'string' && { title: s.title }), st: one(s) }
    const lanes = blocks.get(s.key).flat().map(k => r.stages.find(x => x.key === k)).filter(Boolean).map(one)
    const st = lanes.includes('wait') ? 'wait' : lanes.includes('run') ? 'run' : lanes.includes('fail') ? 'fail' : one(s)
    return { key: s.key, ...(typeof s.title === 'string' && { title: s.title }), st }
  })
  const cur = segs.findIndex(x => x.st === 'run' || x.st === 'wait' || x.key === r.stage)
  return { segs, cur }
}

/** Start feeding it: call (the workbench API), subscribe (data.js subscribeWb), lang() (zh | en, the lines'). → stop() */
export function startActivity({ call, subscribe, lang = () => 'en' }) {
  const runs = new Map(), tasks = new Map(), seqs = new Map(), pulses = new Map(), handoffs = []
  const approvals = new Map(), ledger = new Map(), live = new Map(), outcomes = new Map() // a run's: ledger lines, its agents' activity, outcome
  const said = new Map() // a run's agents' words so far (their activity has only the last): they scroll up like the tools
  const talk = new Map() // a run's agents' messages: { on, last (the newest number seen), links }
  let asking = false
  const at = new Map() // run → the step it was at (a change is a handoff)
  let fetching = false, again = false, stopped = false
  const agentOf = (r, s) => {
    const waits = r.status === 'waiting' && (s.asking || r.stage === s.key)
    const kind = waits ? 'person' : s.owner === 'system' ? 'system' : s.agent?.runtime === 'claude' ? 'claude' : s.agent?.runtime === 'codex' ? 'codex' : s.agent?.runtime ? 'dsh' : 'model'
    return {
      id: `${r.id}:${s.key}`, kind, name: s.agent?.id || (s.owner !== 'system' ? s.owner : ''), ...(s.agent?.model && { model: s.agent.model }),
      run: r.id, title: r.subject?.title || r.template, step: s.key, stepTitle: typeof s.title === 'string' ? s.title : '', state: waits ? 'waiting' : 'working', since: s.startedAt || r.createdAt,
      ...(pulses.get(`${r.id}:${s.key}`) && { pulse: pulses.get(`${r.id}:${s.key}`) }),
    }
  }
  const publish = () => {
    const now = Date.now()
    const going = [...runs.values()].filter(r => ACTIVE.has(r.status) && !r.archivedAt).sort((a, b) => a.createdAt - b.createdAt)
    const agents = going.flatMap(r => {
      const blocks = blocksOf(r)
      const mine = r.stages.filter(s => s.status === 'running' && !blocks.has(s.key)).map(s => agentOf(r, s))
      // waiting on the person's decisions after a step is done (no step at work): the person's light, at that step
      if (r.status === 'waiting' && !mine.some(a => a.state === 'waiting')) {
        const s = r.stages.find(x => x.key === r.stage) || r.stages.findLast(x => x.status === 'passed')
        if (s) mine.push({ ...agentOf({ ...r, stage: s.key }, s), kind: 'person', state: 'waiting' })
      }
      return mine
    })
    const links = []
    for (const r of going) {
      const mine = agents.filter(a => a.run === r.id)
      for (let i = 1; i < mine.length; i++) links.push({ from: mine[i - 1].id, to: mine[i].id, kind: 'together', at: now })
    }
    for (let i = handoffs.length - 1; i >= 0; i--) if (now - handoffs[i].at > HANDOFF_MS) handoffs.splice(i, 1)
    for (const [k, p] of pulses) if (now - p.at > PULSE_KEEP) pulses.delete(k)
    const extra = Array.isArray(window.__ruyixActivityLinks) ? window.__ruyixActivityLinks.filter(l => l && l.from && l.to) : []
    const fresh = going.flatMap(r => (talk.get(r.id)?.links || []).filter(l => now - l.at < MESSAGE_MS))
    window.__ruyixActivity = {
      agents, links: [...links, ...handoffs, ...[...fresh, ...extra].map(l => ({ kind: 'message', ...l }))],
      runs: going.map(r => ({ id: r.id, taskId: r.taskId || null, title: r.subject?.title || r.template, status: r.status, stage: r.stage, waiting: r.waiting || null, createdAt: r.createdAt, stages: r.stages.map(s => ({ key: s.key, status: s.status, ...(typeof s.title === 'string' && { title: s.title }) })), ...segsOf(r) })),
      upcoming: [...tasks.values()].filter(t => t.schedule?.kind && t.schedule.kind !== 'once' && t.enabled && !t.archivedAt && t.nextAt && !going.some(r => r.taskId === t.id)).sort((a, b) => a.nextAt - b.nextAt).slice(0, 8).map(t => ({ id: t.id, title: t.title, nextAt: t.nextAt })),
      finished: [...runs.values()].filter(r => !ACTIVE.has(r.status) && r.endedAt && now - r.endedAt < FINISHED_MS && !r.archivedAt).map(r => ({ id: r.id, taskId: r.taskId || null, title: r.subject?.title || r.template, endedAt: r.endedAt, ok: r.status === 'done' && r.verdict?.level !== 'failed' })),
      at: now,
    }
    window.dispatchEvent(new Event('ruyix:activity'))
    // the work list's runs: the ones going, then the finished ones not looked at yet (the latest few, the last two weeks)
    const unseen = [...runs.values()].filter(r => !ACTIVE.has(r.status) && !r.seenAt && !r.archivedAt && r.endedAt && now - r.endedAt < UNSEEN_DAYS * 864e5)
      .sort((a, b) => b.endedAt - a.endedAt).slice(0, UNSEEN_MAX)
    const pulseOf = r => [...pulses.entries()].filter(([k]) => k.startsWith(`${r.id}:`)).map(([, p]) => p).sort((a, b) => b.at - a.at)[0] || null
    const L = lang() === 'zh' ? 'zh' : 'en'
    const linesOfRun = (r, mine) => {
      if (!ACTIVE.has(r.status)) return []
      const acts = Object.entries(live.get(r.id) || {}).flatMap(([step, x]) => linesOf(x.act, `${r.id}:${step}`, L))
      // waiting for the person: their light's line says for what
      const waits = mine.filter(a => a.state === 'waiting').map(a => {
        const card = approvals.get(r.stages.find(s => s.key === a.step)?.asking) || approvals.get(r.waitingFor)
        const what = sayText(card?.title || '', 60)
        return { at: card?.createdAt || r.updatedAt || now, agent: a.id, kind: 'wait', text: L === 'zh' ? `等你${what ? `：${what}` : ''}` : `Waiting for you${what ? `: ${what}` : ''}` }
      })
      return keepLines([...(ledger.get(r.id) || []), ...(said.get(r.id) || []), ...acts, ...waits])
    }
    // what the finished ones came to: asked once each
    const want = unseen.filter(r => !outcomes.has(r.id)).map(r => r.id)
    if (want.length && !asking) {
      asking = true
      call('runOutcomes', { ids: want }).then(({ outcomes: got = {} }) => { for (const id of want) outcomes.set(id, got[id] || null); asking = false; publish() })
        .catch(() => { for (const id of want) outcomes.set(id, null); asking = false })
    }
    // what it waits for the person on: a discussion, a decision, an answer…
    const waitOf = r => {
      const card = approvals.get(r.waitingFor) || approvals.get(r.stages.find(s => s.asking)?.asking)
      if (!card) return null
      const kind = card.payload?.kind === 'chat' || card.payload?.talk ? 'chat' : card.action === 'decision' ? (card.payload?.person || 'decision') : card.action === 'help' ? (['input', 'do'].includes(card.payload?.kind) ? card.payload.kind : 'help') : 'approval'
      return { kind, title: card.title || '' }
    }
    workRegistry(window).set('runs', [...going, ...unseen].map(r => {
      const mine = agents.filter(a => a.run === r.id)
      return workOfRun(r, mine, pulseOf(r), linesOfRun(r, mine), outcomes.get(r.id) || null, L, r.status === 'waiting' ? waitOf(r) : null, talk.get(r.id)?.links || [])
    }), {
      seen: ids => call('markSeen', { ids: ids.filter(id => /^run:/.test(id)).map(id => id.slice(4)) }),
      summarize: id => call('runSummary', { id: String(id).replace(/^run:/, ''), lang: L }).then(x => x?.text || ''),
    })
  }
  /** The newest entries of the runs going: each a pulse of its step's agent (a tool call, a command, a model call…). */
  const fetchNew = async () => {
    if (stopped || document.hidden) return
    if (fetching) { again = true; return } // (a change while a look is under way: one more look after it)
    fetching = true
    for (const r of [...runs.values()].filter(x => ACTIVE.has(x.status))) {
      try {
        const after = seqs.get(r.id)
        const { evidence = [], live: acts = {} } = await call('run', { id: r.id, after: after ?? 0, live: true })
        live.set(r.id, acts)
        const words = said.get(r.id) || []
        for (const [step, x] of Object.entries(acts)) {
          const text = sayText(x.act?.said), at = x.act?.saidAt
          if (text && at && !words.some(w => w.at === at && w.agent === `${r.id}:${step}`)) words.push({ at, agent: `${r.id}:${step}`, text, kind: 'say' })
        }
        said.set(r.id, keepLines(words))
        if (evidence.length) {
          seqs.set(r.id, evidence.at(-1).seq)
          ledger.set(r.id, keepLines([...(ledger.get(r.id) || []), ...ledgerLines(r.id, evidence.slice(-40), lang() === 'zh' ? 'zh' : 'en')]))
        }
        // its agents' messages, the new ones (a workflow that does not let them talk: not asked again)
        const t = talk.get(r.id) || { on: true, last: 0, links: [] }
        if (t.on) {
          const got = await call('runMessages', { id: r.id, after: t.last, limit: 100 }).catch(() => ({}))
          const msgs = got.messages || []
          if (got.on === false) t.on = false
          if (msgs.length) {
            t.last = msgs.at(-1).id
            const atWork = r.stages.filter(s => s.status === 'running').map(s => `${r.id}:${s.key}`)
            t.links = [...t.links, ...messageLinks(r.id, msgs, atWork)].slice(-MESSAGES_KEPT)
          }
          talk.set(r.id, t)
        }
        // (the first look only learns where the ledger stands: old entries are not pulses)
        if (after === undefined) { seqs.set(r.id, evidence.at(-1)?.seq ?? 0); continue }
        for (const e of evidence) if (e.stage && e.kind !== 'gate') pulses.set(`${r.id}:${e.stage}`, { at: e.at || Date.now(), kind: e.kind, ok: e.ok !== false })
      } catch { /* this run's next look tries again; the others go on */ }
    }
    fetching = false
    publish()
    if (again) { again = false; fetchNew() }
  }
  const off = subscribe(({ docs, removed = [] }) => {
    // (deleted: gone from the desk too)
    for (const x of removed) {
      if (x.kind === 'run') { runs.delete(x.id); live.delete(x.id); ledger.delete(x.id); said.delete(x.id); outcomes.delete(x.id) }
      if (x.kind === 'task') tasks.delete(x.id)
      if (x.kind === 'approval') approvals.delete(x.id)
    }
    for (const d of docs) {
      if (d.kind === 'task') { tasks.set(d.id, d); continue }
      if (d.kind === 'approval') { approvals.set(d.id, d); continue }
      if (d.kind !== 'run') continue
      const was = at.get(d.id), now = d.stages?.find(s => s.status === 'running')?.key || null
      if (was && now && was !== now) handoffs.push({ from: `${d.id}:${was}`, to: `${d.id}:${now}`, kind: 'handoff', at: Date.now() })
      at.set(d.id, now)
      if (!ACTIVE.has(d.status)) { live.delete(d.id); ledger.delete(d.id); said.delete(d.id) } // (its messages kept: a finished one's graph)
      runs.set(d.id, d)
    }
    publish()
    fetchNew()
  }, 2000)
  // the ledger moves the store's revision without a document changing: a light poll of the runs going, every few seconds
  const tick = setInterval(() => { if ([...runs.values()].some(r => ACTIVE.has(r.status))) fetchNew(); else publish() }, 3000)
  const linksChanged = () => publish()
  window.addEventListener('ruyix:activity-links', linksChanged)
  return () => { stopped = true; off(); clearInterval(tick); window.removeEventListener('ruyix:activity-links', linksChanged); delete window.__ruyixActivity; workRegistry(window).set('runs', []); window.dispatchEvent(new Event('ruyix:activity')) }
}
