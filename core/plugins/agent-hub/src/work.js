// Agent Hub's part of the work going on (the shell's work list, @ruyix/shell/work; docs/design/sessions.md §3): its
// sessions, and the pool's jobs that are not a workflow run's steps (a headless job is a run's: the workbench publishes
// the run). Built from the page's synced documents — no other plugin's data.

import { keepLines, linesOf, sayText, toolText } from '@ruyix/shell/work-lines'
import { firstSentence } from '../session-text.js'

const TASK_ST = { queued: 'todo', running: 'run', done: 'done', failed: 'fail', cancelled: 'skip' }
/** A session's kept lines (sessions.js: { at, kind, tool, arg } | { at, kind, said }) in the words every lane uses (work-lines). */
const worded = (lines, agent, lang) => keepLines(lines.map(l => (l.kind === 'tool'
  ? { at: l.at || 0, agent, text: toolText({ name: l.tool, target: l.arg }, lang), kind: 'tool' }
  : { at: l.at || 0, agent, text: sayText(l.said), kind: 'say' })).filter(l => l.text))
const RECENT_MS = 10 * 60e3 // a job over this long ago is no longer the desk's
const DONE_ST = new Set(['done', 'failed', 'cancelled'])
const LINKS_SHOWN = 12 // a job's last tasks whose hand-offs the graph draws

/**
 * A session: its turns are the ring's segments (the last 8); at work → working; its last turn failed → failed; else done.
 * Its lines (agent-work.md §2: the last few things it did, by rule) and, when not at work, its outcome.
 */
export function sessionItems(sessions = new Map(), lang = 'en') {
  return [...sessions.values()].filter(d => !d.removedAt && (d.turns || d.state === 'working')).map(d => {
    const working = d.state === 'working', turns = d.turns || 0
    const n = Math.min(8, turns + (working ? 1 : 0))
    const first = turns + (working ? 1 : 0) - n
    const segs = Array.from({ length: n }, (_, i) => ({ title: `#${first + i + 1}`, st: working && i === n - 1 ? 'run' : !working && i === n - 1 && d.error ? 'fail' : 'done' }))
    return {
      id: `session:${d.id}`, kind: 'session', title: d.title,
      agents: [{ id: d.agent, kind: d.runtime, state: working ? 'working' : 'idle', step: d.now?.tool || null }],
      state: working ? 'working' : d.error ? 'failed' : 'done', segs, cur: working ? n - 1 : null,
      startedAt: d.createdAt, lastAt: d.lastAt, endedAt: working ? null : d.lastAt, ok: !d.error, seen: working || (d.seenTurns || 0) >= turns,
      open: { event: 'agent-hub:open', detail: { tab: 'sessions', session: d.id } },
      lines: worded(d.lines || [], d.agent, lang),
      // who wrote to it, whom it answered (the collaboration graph, agent-work.md §6: <CollabGraph agents={[...agents,
      // ...peers]} links />) — 'self' is its agent
      links: (d.links || []).map(k => ({ from: k.from === 'self' ? d.agent : k.from, to: k.to === 'self' ? d.agent : k.to, at: k.at, text: k.text })),
      peers: peersOf(d.links || [], lang),
      // (「看结果」: the files it made or changed, in the same viewer window as a run's — the workbench's viewer-window.jsx)
      ...(!working && turns && { outcome: { ok: !d.error, text: firstSentence(d.error || d.said || ''), open: { event: 'ruyix-workbench:view', detail: { session: d.id, title: d.title } } } }),
    }
  })
}

/**
 * A job of the pool's own (a Lead's, not a run's): its tasks are the segments; while it runs, and a while after — until
 * looked at (jobSeen). Each task's agent: its last few tool calls and what it last said; when over, its outcome.
 */
const PEER = { person: { kind: 'person', zh: '你', en: 'you' }, main: { kind: 'system', zh: '主智能体', en: 'main agent' }, run: { kind: 'system', zh: '工作流', en: 'workflow' }, lead: { kind: 'dsh', zh: '组长', en: 'lead' } }
/** The other ends of an item's links (not its agents): the person, the main agent, a run — each once, with a name. */
export function peersOf(links, lang = 'en', own = new Set(['self'])) {
  const ids = [...new Set(links.flatMap(k => [k.from, k.to]))].filter(id => id && !own.has(id))
  return ids.map(id => { const p = PEER[id.split(':')[0]] || PEER.run; return { id, kind: p.kind, name: p[lang] || p.en } })
}

export function jobItems(jobs = new Map(), tasks = new Map(), now = Date.now(), lang = 'en') {
  const all = [...tasks.values()]
  return [...jobs.values()].filter(j => !j.headless && !j.archivedAt && (j.status === 'running' || now - (j.endedAt || 0) < RECENT_MS)).map(j => {
    const ts = all.filter(t => t.jobId === j.id).sort((a, b) => a.createdAt - b.createdAt)
    const segs = ts.slice(-8).map(t => ({ title: t.title, st: TASK_ST[t.status] || 'todo' }))
    const at = segs.findIndex(s => s.st === 'run')
    return {
      id: `task:${j.id}`, kind: 'task', title: j.title,
      agents: ts.filter(t => t.status === 'running').map(t => ({ id: t.agent || t.member, kind: t.runtime, state: 'working', step: t.title })),
      state: j.status === 'running' ? 'working' : j.status === 'failed' ? 'failed' : j.status === 'done' ? 'done' : 'stopped', segs, cur: at < 0 ? null : at,
      startedAt: j.createdAt, endedAt: j.endedAt || null, ok: j.status === 'done', seen: j.status === 'running' || !!j.seenAt,
      open: { event: 'agent-hub:open', detail: { tab: 'tasks', select: { kind: 'job', id: j.id } } },
      lines: keepLines(ts.filter(t => t.act).flatMap(t => linesOf(t.act, t.agent || t.member, lang))),
      // the hand-offs (agent-work.md §6): the lead (or the person) gives each task to its agent; the agent's report back
      ...((links => links.length && { links, peers: peersOf(links, lang, new Set(ts.map(t => t.agent || t.member))) })(ts.filter(t => t.agent || t.member).slice(-LINKS_SHOWN).flatMap(t => {
        const who = t.agent || t.member, boss = t.by === 'lead' ? 'lead' : 'person'
        const out = [{ from: boss, to: who, at: t.createdAt, text: t.title }]
        if (DONE_ST.has(t.status) && t.endedAt) out.push({ from: who, to: boss, at: t.endedAt, text: firstSentence(t.error || t.result || t.output || t.status, 60) })
        return out
      }).sort((a, b) => a.at - b.at))),
      ...(j.status !== 'running' && { outcome: { ok: j.status === 'done', text: firstSentence(j.report || j.error || ''), open: { event: 'agent-hub:open', detail: { tab: 'tasks', select: { kind: 'job', id: j.id } } } } }),
    }
  })
}
