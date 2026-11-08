// Who is at work right now (src/activity.js): agents from the runs going — their kinds, waiting for the person, the
// lights of one run linked, a step handing over to the next, each new ledger entry a pulse (old ones are not), links
// a plugin adds, and nothing left behind when it stops.
import assert from 'node:assert/strict'

globalThis.window = new EventTarget()
globalThis.document = { hidden: false }
const { startActivity } = await import('./src/activity.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

let push = null
const ledger = new Map() // run → entries
const liveOf = new Map(), called = [] // run → its agents' activity (the run op's `live`); the other ops asked
const spaces = new Map(), msgAsks = [] // run → its agents' messages (the runMessages op), and what was asked
const call = async (op, args) => {
  if (op === 'runMessages') { msgAsks.push(args); const sp = spaces.get(args.id); return sp ? { on: true, messages: sp.filter(m => m.id > args.after), members: [] } : { on: false, messages: [], members: [] } }
  if (op !== 'run') { called.push([op, args]); return op === 'runOutcomes' ? { outcomes: { f: { text: 'Wrote the post. Then checked it.', image: 7, files: 2 }, h: { text: '', image: null, files: 0 } } } : op === 'runSummary' ? { text: 'It wrote the draft.' } : {} }
  const { id, after } = args
  assert.equal(args.live, true, 'the activity asks for what the agents are doing')
  return { evidence: (ledger.get(id) || []).filter(e => e.seq > after), live: liveOf.get(id) || {} }
}
// the list's hooks, as the registry is given them (docs/design/agent-work.md: 擦掉 and the summary of an opened lane)
const { workRegistry } = await import('@ruyix/shell/work')
const reg = workRegistry(window), plainSet = reg.set
let hooks = null
reg.set = (source, items, opts) => { if (source === 'runs' && opts) hooks = opts; return plainSet(source, items, opts) }
const subscribe = fn => { push = fn; return () => { push = null } }
const st = (key, status, extra = {}) => ({ key, status, owner: 'writer', ...extra })
const run = (id, status, stages, extra = {}) => ({ kind: 'run', id, status, stages, stage: stages.find(s => s.status === 'running')?.key, createdAt: 1, subject: { title: id }, ...extra })
let events = 0
window.addEventListener('ruyix:activity', () => events++)

let LANG = 'zh'
const stop = startActivity({ call, subscribe, lang: () => LANG })
ledger.set('a', [{ seq: 1, stage: 'draft', kind: 'tool', at: 100 }])
push({ docs: [
  run('a', 'running', [st('draft', 'running', { agent: { id: 'sonnet', runtime: 'claude', model: 'claude-sonnet-5-5' }, startedAt: 5 }), st('review', 'pending')]),
  run('b', 'running', [st('x', 'running', { agent: { id: 'codex', runtime: 'codex' } }), st('y', 'running', { owner: 'system' })]),
  run('c', 'waiting', [st('write', 'passed'), st('look', 'running', { asking: 'card1' })], { stage: 'look' }),
  run('d', 'waiting', [st('one', 'passed'), st('two', 'pending')], { stage: 'one', waiting: 'decision' }),
  run('e', 'done', [st('z', 'passed')]),
] })
await sleep(20)
let A = window.__ruyixActivity
const by = id => A.agents.find(a => a.id === id)
assert.deepEqual(A.agents.map(a => a.id), ['a:draft', 'b:x', 'b:y', 'c:look', 'd:one'], 'the runs going, oldest first; a finished run has none')
assert.equal(by('a:draft').kind, 'claude'); assert.equal(by('a:draft').name, 'sonnet'); assert.equal(by('a:draft').model, 'claude-sonnet-5-5'); assert.equal(by('a:draft').since, 5)
assert.equal(by('b:x').kind, 'codex'); assert.equal(by('b:y').kind, 'system')
assert.equal(by('c:look').kind, 'person'); assert.equal(by('c:look').state, 'waiting', 'a step asking the person')
assert.equal(by('d:one').state, 'waiting', 'waiting on decisions after a step: the person, at that step')
assert.equal(by('a:draft').pulse, undefined, 'the first look only learns where the ledger stands')
assert.deepEqual(A.links.filter(l => l.kind === 'together').map(l => [l.from, l.to]), [['b:x', 'b:y']], 'two steps of one run at once')
assert.deepEqual(A.runs.map(r => r.id), ['a', 'b', 'c', 'd'])
assert.ok(events > 0)

// a parallel block: its lanes are the agents at work (not the block itself), linked together
push({ docs: [run('f', 'running', [st('check', 'running'), st('facts', 'running', { owner: 'system' }), st('links', 'running', { owner: 'system' })], { stage: 'check', workflowDef: { steps: [{ use: 'parallel', id: 'check', lanes: [{ steps: [{ id: 'facts' }] }, { steps: [{ id: 'links' }] }] }] } })] })
await sleep(20)
A = window.__ruyixActivity
assert.deepEqual(A.agents.filter(a => a.run === 'f').map(a => a.id), ['f:facts', 'f:links'])
assert.ok(A.links.some(l => l.kind === 'together' && l.from === 'f:facts' && l.to === 'f:links'))
// the run's way: a parallel block one stretch, at work while a lane is; the one at work
assert.deepEqual(A.runs.find(r => r.id === 'f').segs.map(x => [x.key, x.st]), [['check', 'run']])
assert.equal(A.runs.find(r => r.id === 'f').cur, 0)
assert.deepEqual(A.runs.find(r => r.id === 'c').segs.map(x => x.st), ['done', 'wait'], 'a step asking the person: waiting')
// scheduled tasks not running: coming up, the soonest first; one running is not
push({ docs: [
  { kind: 'task', id: 'tlate', title: 'Weekly', schedule: { kind: 'daily', at: '09:00' }, enabled: true, nextAt: Date.now() + 9e6 },
  { kind: 'task', id: 'tsoon', title: 'Daily', schedule: { kind: 'daily', at: '08:00' }, enabled: true, nextAt: Date.now() + 1e6 },
  { kind: 'task', id: 'toff', title: 'Paused', schedule: { kind: 'daily', at: '08:00' }, enabled: false, nextAt: null },
  { kind: 'task', id: 'tonce', title: 'Once', schedule: { kind: 'once' }, enabled: false },
  run('g', 'running', [st('x', 'running')], { taskId: 'tlate' }),
] })
await sleep(20)
A = window.__ruyixActivity
assert.deepEqual(A.upcoming.map(u => u.id), ['tsoon'], 'the running one and the paused ones are not coming up')
assert.equal(A.runs.find(r => r.id === 'g').taskId, 'tlate')
// a run just over: finished, for a few seconds
push({ docs: [run('g', 'done', [st('x', 'passed')], { taskId: 'tlate', endedAt: Date.now() })] })
await sleep(20)
A = window.__ruyixActivity
assert.deepEqual(A.finished.map(x => [x.id, x.taskId, x.ok]), [['g', 'tlate', true]])
assert.deepEqual(A.upcoming.map(u => u.id), ['tsoon', 'tlate'])
push({ docs: [run('f', 'done', [])] })

// a new entry: a pulse of that step's agent; a gate entry is not one
ledger.get('a').push({ seq: 2, stage: 'draft', kind: 'command', at: Date.now() }, { seq: 3, stage: 'review', kind: 'gate', at: Date.now() })
push({ docs: [] })
await sleep(20)
A = window.__ruyixActivity
assert.equal(by('a:draft').pulse.kind, 'command')

// its lines (docs/design/agent-work.md §2): its agents' activity, a line each, in time; the ledger's commands; by rule
const T0 = Date.now() + 1000
liveOf.set('a', { draft: { agent: 'sonnet', act: { turnStartedAt: T0, recent: [{ name: 'Read', target: '/w/posts/draft.md', ok: true, ms: 5, at: T0 + 20 }, { name: 'Bash', target: 'npm test', ok: false, ms: 9, at: T0 + 30 }], tools: [{ name: 'Edit', target: '/w/posts/draft.md', at: T0 + 40 }], said: '第二段的例子换成了更短的。然后再看标题。', saidAt: T0 + 35 } } })
ledger.get('a').push({ seq: 4, stage: 'draft', kind: 'command', title: 'lint → exit 0', ok: true, at: T0 + 25 })
push({ docs: [] })
await sleep(20)
let item = window.__ruyixWork.get().find(x => x.id === 'run:a')
assert.deepEqual(item.lines.map(l => [l.agent, l.kind, l.text]), [
  ['a:draft', 'tool', '跑了 一条命令'], ['a:draft', 'tool', '读了 posts/draft.md'], ['a:draft', 'tool', '跑了 lint'], ['a:draft', 'tool', '跑了 npm test（没成）'],
  ['a:draft', 'say', '第二段的例子换成了更短的。'], ['a:draft', 'tool', '在改 posts/draft.md'],
], 'oldest first; the one at it now last')
assert.equal(item.lines.at(-1).live, true); assert.equal(item.lines[3].ok, false)
assert.ok(item.lines.every(l => item.agents.some(a => a.id === l.agent)), 'each line is of one of its agents')
LANG = 'en'
push({ docs: [] })
await sleep(20)
item = window.__ruyixWork.get().find(x => x.id === 'run:a')
assert.equal(item.lines[1].text, 'read posts/draft.md', 'in the page\'s language')
LANG = 'zh'
// waiting for the person: their light's line says for what
push({ docs: [{ kind: 'approval', id: 'card1', title: '看一下原稿', createdAt: 50 }] })
await sleep(20)
item = window.__ruyixWork.get().find(x => x.id === 'run:c')
assert.deepEqual(item.lines.map(l => [l.agent, l.kind, l.text]), [['c:look', 'wait', '等你：看一下原稿']])
assert.equal(item.wait.kind, 'approval', 'what it waits on (a card of no kind of its own: an approval)')
push({ docs: [{ kind: 'approval', id: 'card1', action: 'help', title: '一起定下角度', createdAt: 50, payload: { kind: 'chat' } }] })
await sleep(20)
assert.deepEqual(window.__ruyixWork.get().find(x => x.id === 'run:c').wait, { kind: 'chat', title: '一起定下角度' }, 'a discussion: the desk shows a chat bubble')

// the run moves on: a handoff from the step it was at to the next
push({ docs: [run('a', 'running', [st('draft', 'passed'), st('review', 'running', { agent: { id: 'opus', runtime: 'claude' } })])] })
await sleep(20)
A = window.__ruyixActivity
assert.deepEqual(A.links.filter(l => l.kind === 'handoff').map(l => [l.from, l.to]), [['a:draft', 'a:review']])

// links a plugin adds (agents messaging each other)
window.__ruyixActivityLinks = [{ from: 'a:review', to: 'b:x', at: 1 }, { from: 'a:review' }]
window.dispatchEvent(new Event('ruyix:activity-links'))
A = window.__ruyixActivity
assert.deepEqual(A.links.filter(l => l.kind === 'message').map(l => [l.from, l.to]), [['a:review', 'b:x']], 'a link without both ends is left out')

// archived and finished runs drop out
push({ docs: [run('b', 'done', [st('x', 'passed'), st('y', 'passed')]), run('c', 'waiting', [st('look', 'running', { asking: 'c1' })], { archivedAt: 9 })] })
await sleep(20)
A = window.__ruyixActivity
assert.deepEqual(A.agents.map(a => a.id), ['a:review', 'd:one'])

// the work list's runs (window.__ruyixWork, docs/design/sessions.md §3): typed ids, states, steps with titles, how to open
// one; the finished ones the person has not looked at stay (to the done place), the ones seen or archived do not
const now = Date.now()
push({ docs: [
  run('f', 'done', [st('z', 'passed', { title: 'Write' })], { endedAt: now - 1000 }),
  run('g', 'done', [st('z', 'passed')], { endedAt: now - 2000, seenAt: now - 500 }),
  run('h', 'failed', [st('z', 'failed', { title: 'Check' })], { endedAt: now - 3000 }),
  run('i', 'done', [st('z', 'passed')], { endedAt: now - 4000, verdict: { level: 'failed' } }),
  run('j', 'cancelled', [st('z', 'skipped')], { endedAt: now - 30 * 864e5 }),
] })
await sleep(20)
const W = window.__ruyixWork.get().filter(w => w.kind === 'run'), w = id => W.find(x => x.id === `run:${id}`)
assert.ok(W.every(x => /^run:/.test(x.id)), 'typed ids')
assert.equal(w('d').state, 'waiting'); assert.equal(w('a').state, 'working')
assert.ok(w('a').agents.length > 0 && w('a').agents.every(x => x.step && x.kind), 'its lights, each at its step')
assert.deepEqual(w('d').open, { event: 'ruyix-workbench:open', detail: { run: 'd', tab: 'approvals' } }, 'opening it: the run page, where it waits')
assert.deepEqual([w('f').state, w('f').ok, w('f').seen, w('f').segs], ['done', true, false, [{ title: 'Write', st: 'done' }]])
assert.equal(w('g'), undefined, 'a finished run seen: not on the desk (the records have it)')
assert.equal(w('h').state, 'failed'); assert.equal(w('i').state, 'failed', 'done but judged failed: failed'); assert.equal(w('i').ok, false)
assert.equal(w('j'), undefined, 'finished long ago: not on the desk')
// the done notes (§3): what each came to, asked once for the finished ones; its first picture; opening it: its results
await sleep(20)
const W2 = window.__ruyixWork.get(), w2 = id => W2.find(x => x.id === `run:${id}`)
assert.deepEqual(w2('f').outcome, { ok: true, text: 'Wrote the post.', thumb: 'api/ruyix-workbench/file?run=f&seq=7', open: { event: 'ruyix-workbench:view', detail: { run: 'f' } } }, 'what it made: in the viewer\'s window')
assert.deepEqual([w2('h').outcome.ok, w2('h').outcome.text, w2('h').outcome.thumb], [false, '没做成', undefined], 'nothing said: plain words')
assert.equal(w2('a').outcome, undefined, 'a run going has none')
assert.equal(w2('a').studio, undefined, 'not from a studio: no studio')
push({ docs: [run('k', 'running', [st('x', 'running')], { studio: { id: 'plume', collection: 'ideas', record: 'i1' } })] })
await sleep(20)
assert.deepEqual(window.__ruyixWork.get().find(x => x.id === 'run:k').studio, { id: 'plume', collection: 'ideas', record: 'i1' }, 'from a studio\'s record: which, on the desk too')
push({ docs: [run('k', 'done', [st('x', 'passed')], { endedAt: Date.now(), seenAt: Date.now() })] })
// its agents' messages (agent-work.md §6): links between its steps for the graph — one to everyone, to each of the
// others at work — and, new, `message` links on the maps; a workflow that does not let them talk is not asked again
{
  const t0 = Date.now()
  spaces.set('m', [{ id: 1, at: t0 - 120000, from: 'writer@draft', to: 'review', text: 'Draft is in draft.md. Two places I am unsure of' }, { id: 2, at: t0 - 500, from: 'review', to: null, text: 'Looking now.' }])
  push({ docs: [run('m', 'running', [st('draft', 'running', { agent: { id: 'w', runtime: 'claude' } }), st('review', 'running', { agent: { id: 'r', runtime: 'codex' } }), st('ship', 'pending', { title: 'Ship it' })])] })
  for (let i = 0; i < 100 && !window.__ruyixWork.get().find(x => x.id === 'run:m')?.links; i++) await sleep(10)
  const wm = window.__ruyixWork.get().find(x => x.id === 'run:m')
  assert.deepEqual(wm.links.map(l => `${l.from}>${l.to}:${l.text}`), ['m:draft>m:review:Draft is in draft.md.', 'm:review>m:draft:Looking now.'])
  assert.deepEqual(wm.peers, [], 'both at work: no other ends')
  assert.deepEqual(window.__ruyixActivity.links.filter(l => l.kind === 'message' && l.from.startsWith('m:')).map(l => `${l.from}>${l.to}`), ['m:review>m:draft'], 'on the maps only the new one')
  spaces.get('m').push({ id: 3, at: Date.now(), from: 'writer@draft', to: 'ship', text: 'Ready for you' })
  push({ docs: [] })
  for (let i = 0; i < 100 && window.__ruyixWork.get().find(x => x.id === 'run:m').links.length < 3; i++) await sleep(10)
  const wm2 = window.__ruyixWork.get().find(x => x.id === 'run:m')
  assert.equal(wm2.links.length, 3, 'the new one added')
  assert.equal(msgAsks.filter(a => a.id === 'm').at(-1).after, 2, 'only the ones after the newest seen asked for')
  assert.deepEqual(wm2.peers, [{ id: 'm:ship', kind: 'model', name: 'Ship it' }], 'a step not at work: named by its title')
  const quiet = msgAsks.filter(a => a.id === 'a').length
  push({ docs: [] }); await sleep(60)
  assert.ok(quiet <= 1 && msgAsks.filter(a => a.id === 'a').length === quiet, 'no messages in its workflow: asked once at most')
}
const asks = () => called.filter(([op]) => op === 'runOutcomes')
assert.equal(asks().filter(([, a]) => a.ids.includes('f')).length, 1, 'asked once')
const before = asks().length
push({ docs: [] })
await sleep(20)
assert.equal(asks().length, before, 'and not again')
// the hooks: 擦掉 marks seen in the box, an opened lane is summed up by the main model
await hooks.seen(['run:f', 'session:x'])
assert.deepEqual(called.at(-1), ['markSeen', { ids: ['f'] }], 'only its own')
assert.equal(await hooks.summarize('run:a'), 'It wrote the draft.')
assert.deepEqual(called.at(-1), ['runSummary', { id: 'a', lang: 'zh' }])
assert.deepEqual(window.__ruyixWork.get().map(x => x.state).filter((s, k, all) => all.indexOf(s) === k).slice(0, 3), ['waiting', 'working', 'failed'], 'the most pressing first')

stop()
assert.equal(window.__ruyixActivity, undefined, 'stopped: nothing left behind')
assert.deepEqual(window.__ruyixWork.get().filter(x => x.kind === 'run'), [], 'and its runs out of the work list')
assert.equal(push, null)
console.log('activity check: ok')
process.exit(0)
