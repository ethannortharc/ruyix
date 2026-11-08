// The pool's work as the person's tasks (docs/design/agent-tasks.md): a resident session the person or the main agent
// started, and a job a Lead runs, are each one task of the workbench's (its `tasks` service) — kept in step from here.
// A session: at work → working; a turn over that changed files → to-confirm (the files are its outputs); a turn that only
// answered → done; a turn that failed → failed; its next message makes it working again. A job: running → working;
// over with its report → to-confirm (the report its output); failed → failed; stopped → stopped. Only changes are said
// (a task the person confirmed stays confirmed until the session works again). A run's sessions are its run's task. A
// session the main agent started for a request of the conversation (`of.task`) is that request's work: it joins the
// conversation's task (its files are that task's outputs, its work makes it 在做, a turn that changed files to-confirm),
// and the conversation says when it is done — never a task of its own.
// 再改 reaches the session as the person's message, or starts a follow-up job; stopping stops it; deleting a task
// removes its session (a job's record stays: the pool's history).
import { firstSentence, lineOf } from './session-text.js'

const RECENT_MS = 10 * 60e3 // a session quiet longer than this before its task was made: its past not judged again
/** The tools that change files (a turn with one of them made something to look at). */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write', 'edit', 'write_file', 'edit_file', 'create_file', 'str_replace_editor'])
const fileOf = a => { let o = a; if (typeof o === 'string') { try { o = JSON.parse(o) } catch { return null } } return o?.file_path || o?.path || o?.notebook_path || null }

// a tool call in the words every page uses (the shell's work-lines: 改了 login.jsx); without the shell, its name
let wording = null
const toolWords = async () => (wording ??= import('@ruyix/shell/work-lines').then(m => m.toolText, () => ({ name, target }) => `${name}${target ? ` ${target}` : ''}`))
const TURN = { zh: { done: n => (n ? `这一轮做完了（用了 ${n} 个工具）` : '这一轮做完了'), failed: why => `没做成：${why}` }, en: { done: n => `turn done (${n} tool calls)`, failed: why => `failed: ${why}` } }

/** A session's work as the task center's timeline (its last few hundred events), in the page's language: who said what, its tools, its turns. */
export async function sessionTimeline(sessions, id, lang = 'zh') {
  const d = sessions.get?.(id)
  if (!d) return []
  const L = lang === 'en' ? 'en' : 'zh', T = TURN[L], toolText = await toolWords()
  const { events = [] } = sessions.read(id, { after: Math.max(0, (d.seq || 0) - 400), limit: 400 }) || {}
  const agent = { kind: 'agent', id: d.agent, name: d.agent }
  const out = []
  for (const e of events) {
    const x = e.data || {}
    if (e.type === 'user/message') out.push({ at: e.time, kind: 'message', who: x.from === 'main' ? { kind: 'agent', id: 'main', name: L === 'zh' ? '主智能体' : 'main agent' } : x.from?.startsWith?.('run') ? { kind: 'system' } : { kind: 'person' }, text: firstSentence(x.text, 200) || x.text })
    else if (e.type === 'turn/end') out.push({ at: e.time, kind: 'state', who: agent, text: x.ok === false ? T.failed(firstSentence(x.error, 120)) : T.done(x.tools || 0) })
    else { const l = lineOf(e); if (l) out.push({ at: l.at, kind: l.kind === 'tool' ? 'step' : 'message', who: agent, text: l.kind === 'tool' ? toolText({ name: l.tool, target: l.arg }, L) : l.said }) }
  }
  return out.filter(e => e.at && e.text)
}

/**
 * `tasks`: the workbench's service (create, update, addOutput, find, registerSource); `sessions` (sessions.js);
 * `store` (the jobs); `followUp(job, text)` → a new job going on from it; `stopJob(id)`. → { tick() (one look, also on a
 * timer), dispose() }
 */
export function createTaskFeed({ tasks, sessions, store, followUp, stopJob, every = 3000, log = () => {} }) {
  const kept = new Map() // 'session:<id>' | 'job:<id>' → { task, turns, state, seq, files }
  // what a session is doing now and what it came to, for the task's live card (docs/design/work-in-one-place.md): its
  // latest tool line (改了 login.jsx — in both languages) and the first sentence of its last reply
  let words = null
  toolWords().then(f => { words = f }, () => {})
  const stepOf = l => { const t = { name: l.tool, target: l.arg }; return words ? { zh: words(t, 'zh'), en: words(t, 'en') } : `${l.tool}${l.arg ? ` ${l.arg}` : ''}` }
  // the events since the last look: the step, the reply — said only when they change
  const follow = (k, e) => {
    const l = lineOf(e)
    if (l?.kind === 'tool') k.step = stepOf(l)
    else if (l?.kind === 'say' && e.type === 'assistant/message') k.said = l.said
  }
  const stepNow = k => { const key = JSON.stringify(k.step || null); if (!k.step || key === k.stepSaid) return {}; k.stepSaid = key; return { step: k.step } }
  const resultOf = k => (k.said ? { result: firstSentence(k.said, 80) } : {})
  // its task: the one it has (after a restart: found by its link — its past not said again), or a new one made now
  const taskOf = (kind, id, make, recent = true) => {
    const key = `${kind}:${id}`
    if (kept.has(key)) return kept.get(key)
    const found = tasks.find({ kind, id })
    const made = found ? null : make()
    // a new one counts its turns from none: one already over when first seen — a quick one — is judged like the rest;
    // one found again, or quiet for a while before its task was made (the first start after an update), only learns
    // where it is
    const fresh = !found && recent
    const k = { task: found?.id || made.id, fresh, turns: fresh ? 0 : null, state: made?.state || null, seq: 0, files: new Set(), changed: false }
    kept.set(key, k)
    return k
  }
  const sessionOf = task => task?.links?.find(l => l.kind === 'session')?.id
  const jobOf = task => task?.links?.findLast(l => l.kind === 'job')?.id

  const offs = [
    tasks.registerSource('session', {
      revise: (task, text) => sessions.send(sessionOf(task), text, { confirm: true, from: 'person' }),
      stop: task => sessions.stop(sessionOf(task)),
      remove: task => sessions.remove(sessionOf(task)),
      timeline: (task, lang) => sessionTimeline(sessions, sessionOf(task), lang),
    }),
    tasks.registerSource('job', {
      revise: async (task, text) => { const j = store.getDoc('job', jobOf(task)); const next = await followUp(j, text, task.id); if (next) tasks.link(task.id, { kind: 'job', id: next.id }) },
      stop: task => stopJob(jobOf(task)),
    }),
  ]

  function syncSession(d) {
    if (d.removedAt || d.of?.run || d.by === 'run') return
    if (d.of?.task) return joinSession(d)
    const k = taskOf('session', d.id, () => tasks.create({ source: 'session', title: d.title, agents: [{ id: d.agent, runtime: d.runtime }], links: [{ kind: 'session', id: d.id }], state: d.state === 'working' ? 'working' : 'done' }), d.state === 'working' || Date.now() - (d.lastAt || d.createdAt || 0) < RECENT_MS)
    // what it did since the last look: the files it changed (its outputs) — a task found again starts from now
    let changed = false
    const { events = [] } = sessions.read(d.id, { after: k.seq, limit: 1000 }) || {}
    const past = k.turns === null
    for (const e of events) {
      k.seq = Math.max(k.seq, e.seq || 0)
      if (!past) follow(k, e)
      if (past || e.type !== 'tool/call' || !EDIT_TOOLS.has(e.data?.name)) continue
      changed = true
      const path = fileOf(e.data.arguments)
      if (path && !k.files.has(path)) { k.files.add(path); tasks.addOutput(k.task, { kind: 'file', title: path.split('/').pop(), ref: { session: d.id, path }, by: { session: d.id } }) }
    }
    k.changed ||= changed
    const working = d.state === 'working'
    if (working && k.state !== 'working') { tasks.update(k.task, { state: 'working', ...stepNow(k) }); k.state = 'working' }
    else if (working) { const s = stepNow(k); if (s.step) tasks.update(k.task, s) }
    const turns = d.turns || 0
    if (!working && turns !== k.turns) {
      // a turn over: what it came to (the first look at one found again only learns where it is)
      if (k.turns !== null) {
        const state = d.error ? 'failed' : k.changed ? 'to-confirm' : 'done'
        // (its totals so far: the session's own count of tokens and money — the task's usage on the 「任务」 page)
        const usage = d.tokens || d.cost ? { usage: { tokens: d.tokens || 0, ...(d.cost != null && { cost: d.cost }) } } : {}
        tasks.update(k.task, { state, ...(d.error ? { result: `✗ ${firstSentence(d.error, 80)}` } : resultOf(k)), ...usage })
        k.state = state
      }
      k.said = null
      k.turns = turns
      k.changed = false
    }
  }

  // a session doing a request of the conversation: its files and its work go to the conversation's task
  function joinSession(d) {
    const key = `session:${d.id}`
    let k = kept.get(key)
    if (!k) {
      // (a new one already done with its first turn when first seen — a quick one — has that turn judged too)
      const fresh = Date.now() - (d.createdAt || 0) < RECENT_MS, turns = d.turns || 0
      k = { task: d.of.task, joined: true, turns: d.state === 'working' || !fresh ? turns : Math.max(0, turns - 1), state: null, seq: 0, files: new Set(), changed: false }
      kept.set(key, k)
      // (linked already when the main agent started it in a turn: not twice)
      const has = tasks.get?.(k.task)?.links?.some(l => l.kind === 'session' && l.id === d.id)
      if (!has) tasks.link(k.task, { kind: 'session', id: d.id })
    }
    const { events = [] } = sessions.read(d.id, { after: k.seq, limit: 1000 }) || {}
    for (const e of events) {
      k.seq = Math.max(k.seq, e.seq || 0)
      follow(k, e)
      if (e.type !== 'tool/call' || !EDIT_TOOLS.has(e.data?.name)) continue
      k.changed = true
      const path = fileOf(e.data.arguments)
      if (path && !k.files.has(path)) { k.files.add(path); tasks.addOutput(k.task, { kind: 'file', title: path.split('/').pop(), ref: { session: d.id, path }, by: { session: d.id } }) }
    }
    const working = d.state === 'working'
    if (working && k.state !== 'working') { tasks.update(k.task, { state: 'working', ...stepNow(k) }); k.state = 'working' }
    else if (working) { const s = stepNow(k); if (s.step) tasks.update(k.task, s) }
    if (!working && (d.turns || 0) !== k.turns) {
      // a turn of it over: it made something (edited files) → the person looks at it; it failed → failed; else it is
      // done — said here, since the request was held at work from the start (startSession: 交给会话) and nothing else
      // ends it now (a file written through a shell command is not seen as made: its words say what it did)
      if (k.changed) tasks.update(k.task, { state: 'to-confirm', ...resultOf(k) })
      else if (d.error) tasks.update(k.task, { state: 'failed', result: `✗ ${firstSentence(d.error, 80)}` })
      else if (k.state === 'working') tasks.update(k.task, { state: 'done', ...resultOf(k) })
      k.said = null
      k.state = k.changed ? 'to-confirm' : 'idle'
      k.turns = d.turns || 0
      k.changed = false
    }
  }

  function syncJob(j) {
    if (j.headless || j.archivedAt) return
    if (j.taskId && tasks.get?.(j.taskId) && !tasks.find({ kind: 'job', id: j.id })) tasks.link(j.taskId, { kind: 'job', id: j.id })
    const k = taskOf('job', j.id, () => tasks.create({ source: 'job', title: j.title, agents: j.leadAgent ? [{ id: j.leadAgent, runtime: 'dsh' }] : [], links: [{ kind: 'job', id: j.id }], state: j.status === 'running' ? 'working' : 'done' }))
    const owner = tasks.get?.(k.task)
    if (owner && jobOf(owner) !== j.id) return // older jobs cannot replace the latest follow-up's state
    // A linked follow-up may finish before its first tick; its task is already at work.
    const now = j.status === 'running' ? 'working' : 'over'
    if (k.job === undefined && !(j.taskId && now === 'over' && owner?.state === 'working')) { k.job = now; return }
    if (now === k.job) return
    k.job = now
    if (now === 'working') return tasks.update(k.task, { state: 'working' })
    const state = j.status === 'done' ? 'to-confirm' : j.status === 'failed' ? 'failed' : 'stopped'
    tasks.update(k.task, { state, ...(j.report ? { result: firstSentence(j.report, 80) } : j.error ? { result: `✗ ${firstSentence(j.error, 80)}` } : {}) })
    if (state === 'to-confirm' && j.report) tasks.addOutput(k.task, { kind: 'report', title: firstSentence(j.report, 80) || j.title, ref: { job: j.id }, by: { job: j.id } })
  }

  let since = 0
  function tick() {
    const from = since
    since = Date.now()
    for (const d of store.docs('session')) if ((d.updatedAt || 0) >= from - 1000) try { syncSession(d) } catch (err) { log(`agent-hub: session ${d.id} → its task: ${err.message}`) }
    for (const j of store.docs('job')) if ((j.updatedAt || 0) >= from - 1000) try { syncJob(j) } catch (err) { log(`agent-hub: job ${j.id} → its task: ${err.message}`) }
  }
  const timer = setInterval(tick, every)
  timer.unref?.()
  return { tick, dispose() { clearInterval(timer); for (const off of offs) try { off?.() } catch { /* gone */ } } }
}
