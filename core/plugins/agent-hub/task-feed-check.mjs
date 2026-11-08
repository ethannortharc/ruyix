// The pool's work as tasks (task-feed.js): a session's turn that changed files waits for the person (to-confirm, the
// files its outputs), one that only answered is done, a failed one failed, its next message working again; a confirmed
// task stays confirmed; a job's run and its report; what was over before the first look is not brought up; 再改 and
// stop reach the session or the job.
import assert from 'node:assert/strict'
import { createTaskFeed, sessionTimeline } from './task-feed.js'
import { taskTools } from './task-tools.js'

const calls = [], made = new Map(), sources = {}
let n = 0
const tasks = {
  create: t => { const x = { id: `t${++n}`, links: t.links, ...t }; made.set(x.id, x); calls.push(['create', x.source, x.title, x.state]); return x },
  update: (id, p) => { Object.assign(made.get(id), p); calls.push(['update', id, p.state]) },
  addOutput: (id, o) => calls.push(['output', id, o.kind, o.title, JSON.stringify(o.ref)]),
  get: id => made.get(id),
  link: (id, l) => { const t=made.get(id);if(t.links?.some(x=>x.kind===l.kind&&x.id===l.id))return; t.links=[...(t.links||[]),l];calls.push(['link',id,l.kind,l.id]) },
  find: ({ kind, id }) => [...made.values()].find(t => t.links?.some(l => l.kind === kind && l.id === id)) || null,
  registerSource: (s, h) => { sources[s] = h; return () => { delete sources[s] } },
}
const docs = { session: [], job: [] }, events = new Map(), sent = []
const store = { docs: k => docs[k], getDoc: (k, id) => docs[k].find(d => d.id === id) }
const sessions = {
  read: (id, { after }) => ({ events: (events.get(id) || []).filter(e => e.seq > after) }),
  send: (id, text, o) => { sent.push(['send', id, text, o.from]); return { queued: false } },
  stop: id => sent.push(['stop', id]), remove: id => sent.push(['remove', id]),
}
const at = (d, patch) => Object.assign(d, patch, { updatedAt: Date.now() })
const ev = (id, list) => events.set(id, [...(events.get(id) || []), ...list.map((e, i) => ({ seq: (events.get(id)?.length || 0) + i + 1, ...e }))])
const followed = []
const feed = createTaskFeed({ tasks, sessions, store, every: 1e9, followUp: async (j, text, taskId) => { followed.push(j.id);const next=at({id:`${j.id}-2`,title:j.title,status:'running',goal:j.goal+'\n'+text,taskId},{});docs.job.push(next);feed.tick();return next }, stopJob: id => sent.push(['stopJob', id]) })
const last = () => calls.splice(0)

// a session started now: working, then a turn that edited two files → to-confirm with them as outputs
const s1 = { id: 's1', title: '改登录页', agent: 'sonnet', by: 'person', state: 'working', turns: 0 }
docs.session.push(at(s1, {}))
feed.tick()
assert.deepEqual(last(), [['create', 'session', '改登录页', 'working']])
ev('s1', [{ type: 'tool/call', data: { name: 'Read', arguments: { file_path: '/w/a.js' } } }, { type: 'tool/call', data: { name: 'Edit', arguments: JSON.stringify({ file_path: '/w/a.js' }) } }, { type: 'tool/call', data: { name: 'Write', arguments: { file_path: '/w/b.css' } } }])
at(s1, { state: 'idle', turns: 1 })
feed.tick()
assert.deepEqual(last(), [['output', 't1', 'file', 'a.js', '{"session":"s1","path":"/w/a.js"}'], ['output', 't1', 'file', 'b.css', '{"session":"s1","path":"/w/b.css"}'], ['update', 't1', 'to-confirm']])
// the person confirms it (the workbench's taskConfirm); the next look leaves it so
made.get('t1').state = 'done'
at(s1, {}); feed.tick()
assert.deepEqual(last(), [], 'confirmed stays confirmed')
// 再改: the person's words to the session; it works again; a turn that only answers → done
await sources.session.revise(made.get('t1'), '按钮再大一点')
assert.deepEqual(sent.at(-1), ['send', 's1', '按钮再大一点', 'person'])
at(s1, { state: 'working' }); feed.tick()
ev('s1', [{ type: 'assistant/message', data: {} }]); at(s1, { state: 'idle', turns: 2 }); feed.tick()
assert.deepEqual(last(), [['update', 't1', 'working'], ['update', 't1', 'done']])
at(s1, { state: 'working' }); feed.tick(); at(s1, { state: 'idle', turns: 3, error: 'boom' }); feed.tick()
assert.deepEqual(last(), [['update', 't1', 'working'], ['update', 't1', 'failed']])
sources.session.stop(made.get('t1')); sources.session.remove(made.get('t1'))
assert.deepEqual(sent.slice(-2), [['stop', 's1'], ['remove', 's1']])
// a run's session is its run's task; an old session found again after a restart: its past not said again
docs.session.push(at({ id: 's2', title: 'x', by: 'run', of: { run: 'r1' }, state: 'idle', turns: 4 }, {}))
const old = tasks.create({ source: 'session', title: 'old', links: [{ kind: 'session', id: 's3' }], state: 'done' }); last()
ev('s3', [{ type: 'tool/call', data: { name: 'Edit', arguments: { file_path: '/w/old.js' } } }])
docs.session.push(at({ id: 's3', title: 'old', by: 'main', state: 'idle', turns: 9 }, {}))
feed.tick()
assert.deepEqual(last(), [], 'nothing for a run\'s session; nothing again for a found one')
assert.equal(old.id, 't2')
// a job: running → over with its report → to-confirm, the report its output; one over before the first look: quiet
const j1 = { id: 'j1', title: '查一下竞品', status: 'running', goal: 'g', cwd: '/w' }
const j0 = { id: 'j0', title: '早就做完的', status: 'done', report: 'old' }
docs.job.push(at(j1, {}), at(j0, {}))
feed.tick()
assert.deepEqual(last(), [['create', 'job', '查一下竞品', 'working'], ['create', 'job', '早就做完的', 'done']])
at(j1, { status: 'done', report: '找到了五家。细节在报告里' }); feed.tick()
assert.deepEqual(last(), [['update', 't3', 'to-confirm'], ['output', 't3', 'report', '找到了五家。', '{"job":"j1"}']])
await sources.job.revise(made.get('t3'), '再加两家')
assert.deepEqual(last(), [['link', 't3', 'job', 'j1-2']], '再改: a follow-up job, on the same task')
await sources.job.revise(made.get('t3'),'改成英文')
assert.deepEqual(followed,['j1','j1-2'],'second revision follows the latest work')
assert.deepEqual(last(),[['link','t3','job','j1-2-2']])
assert.ok(docs.job.find(j=>j.id==='j1-2-2').goal.includes('再加两家'))
assert.equal(made.size,4,'a tick during initial prompt cannot split a follow-up into a new task')
sources.job.stop(made.get('t3'))
assert.deepEqual(sent.at(-1), ['stopJob', 'j1-2-2'])
made.get('t3').state='working'
const fast=at({id:'fast-follow',taskId:'t3',title:'fast followup',status:'done',report:'fast result'},{});docs.job.push(fast);feed.tick()
assert.equal(made.get('t3').state,'to-confirm','a follow-up finished before its first tick still settles its owning task')
last();at(j1,{status:'running'});feed.tick();assert.deepEqual(last(),[],'a late older job cannot replace the newest result')
docs.job.push(at({ id: 'h', headless: true, status: 'running', title: 'a run\'s' }, {})); feed.tick()
assert.deepEqual(last(), [], 'a run\'s own job is the run\'s task')
// sessions from before (the first start after an update): their tasks made quietly, nothing judged again
const s5 = { id: 's5', title: '上周的', agent: 'sonnet', by: 'person', state: 'idle', turns: 6, lastAt: Date.now() - 7 * 864e5 }
ev('s5', [{ type: 'tool/call', data: { name: 'Edit', arguments: { file_path: '/w/old2.js' } } }])
docs.session.push(at(s5, {})); feed.tick()
assert.deepEqual(last(), [['create', 'session', '上周的', 'done']], 'made, done, its old files not brought up')
// a quick session: its first turn already over when first seen — judged all the same; a later plain answer is done
const s4 = { id: 's4', title: '快的', agent: 'sonnet', by: 'main', state: 'idle', turns: 1, lastAt: Date.now() }
ev('s4', [{ type: 'tool/call', data: { name: 'Write', arguments: { file_path: '/w/q.md' } } }])
docs.session.push(at(s4, {})); feed.tick()
assert.deepEqual(last().map(c => c.slice(0, 3)), [['create', 'session', '快的'], ['output', 't6', 'file'], ['update', 't6', 'to-confirm']])
at(s4, { state: 'working' }); feed.tick(); at(s4, { state: 'idle', turns: 2 }); feed.tick()
assert.deepEqual(last(), [['update', 't6', 'working'], ['update', 't6', 'done']], 'a turn that only answered: done (the earlier change counted once)')
// a session the main agent started for a request of the conversation: it joins that task (no task of its own) — its
// files are that task's outputs, its work makes it working, a turn that changed files to-confirm, one that did not done
{
  const chat = tasks.create({ source: 'chat', title: '写 hello.md', links: [], state: 'working' }); last()
  const sj = { id: 'sJ', title: 'hello', agent: 'sonnet', by: 'main', of: { task: chat.id }, state: 'idle', turns: 1, createdAt: Date.now() }
  ev('sJ', [{ type: 'tool/call', data: { name: 'Write', arguments: { file_path: '/tmp/x/hello.md' } } }])
  docs.session.push(at(sj, {})); feed.tick()
  assert.deepEqual(last(), [['link', chat.id, 'session', 'sJ'], ['output', chat.id, 'file', 'hello.md', '{"session":"sJ","path":"/tmp/x/hello.md"}'], ['update', chat.id, 'to-confirm']], 'quick: its first turn judged, on the conversation\'s task')
  at(sj, { state: 'working' }); feed.tick(); at(sj, { state: 'idle', turns: 2 }); feed.tick()
  assert.deepEqual(last(), [['update', chat.id, 'working'], ['update', chat.id, 'done']], 'a turn that only answered (or wrote through a shell): done from here — the request was held at work, nothing else ends it')
  at(sj, { state: 'working' }); feed.tick(); at(sj, { state: 'idle', turns: 3, error: 'boom' }); feed.tick()
  assert.deepEqual(last(), [['update', chat.id, 'working'], ['update', chat.id, 'failed']])
  assert.ok(![...made.values()].some(t => t.source === 'session' && t.links?.some(l => l.id === 'sJ')), 'no task of its own')
}
feed.dispose()
assert.deepEqual(Object.keys(sources), [])
// a session's timeline for the task center: who said what, its tools, its turns
{
  const evs = [{ seq: 1, type: 'user/message', time: 10, data: { text: '把登录页改一下。按钮大一点', from: 'person' } }, { seq: 2, type: 'tool/call', time: 11, data: { name: 'Edit', arguments: { file_path: '/w/login.jsx' } } },
    { seq: 3, type: 'assistant/message', time: 12, data: { message: { content: [{ text: '改好了。按钮现在 44px' }] } } }, { seq: 4, type: 'turn/end', time: 13, data: { ok: true, tools: 1 } }, { seq: 5, type: 'user/message', time: 14, data: { text: '再看看', from: 'main' } }]
  const ses = { get: () => ({ agent: 'sonnet', seq: 5 }), read: () => ({ events: evs }) }
  const said = tl => tl.map(e => `${e.at} ${e.kind} ${e.who.kind}${e.who.id ? `:${e.who.id}` : ''} ${e.text}`)
  assert.deepEqual(said(await sessionTimeline(ses, 'sX')), [
    '10 message person 把登录页改一下。', '11 step agent:sonnet 改了 login.jsx', '12 message agent:sonnet 改好了。', '13 state agent:sonnet 这一轮做完了（用了 1 个工具）', '14 message agent:main 再看看',
  ], 'in Chinese by default, in the words every page uses')
  assert.deepEqual(said(await sessionTimeline(ses, 'sX', 'en')).slice(1, 4), ['11 step agent:sonnet edited login.jsx', '12 message agent:sonnet 改好了。', '13 state agent:sonnet turn done (1 tool calls)'])
}
// the main agent's task tools: look, accept, change, archive (with its way back)
{
  const did = []
  const view = { id: 'tA', title: '写一条：第一年', state: 'to-confirm', source: 'run', agents: [{ id: 'writer' }], outputs: 2, updatedAt: Date.UTC(2026, 9, 18, 10) }
  const service = {
    list: a => { did.push(['list', a]); return { tasks: [{ ...view, id: 'tB', state: 'done', title: '旧的' }, view], counts: { 'to-confirm': 1, done: 1 } } },
    view: id => (id === 'tA' ? { task: view, timeline: [{ at: 1, kind: 'step', who: { kind: 'agent', id: 'writer' }, text: 'draft: passed' }], outputs: [{ kind: 'draft', title: 'draft.md' }] } : null),
    confirm: id => did.push(['confirm', id]), revise: (id, text) => did.push(['revise', id, text]), archive: (id, on) => did.push(['archive', id, on]),
  }
  const T = Object.fromEntries(taskTools({ tasks: service }).map(t => [t.name, t]))
  assert.deepEqual(Object.values(T).map(t => `${t.name}:${t.effect}`), ['task_list:read', 'task_look:read', 'task_confirm:direct', 'task_revise:direct', 'task_archive:direct', 'task_unarchive:undo'])
  const listed = (await T.task_list.run({})).text
  assert.match(listed, /^Tasks \(to-confirm 1, done 1\):\n- tA \| done, waiting for the person to accept \| run \| 写一条：第一年 \| writer \| 2 made \| run: \(none\) \| resultVersion: 0 \| 2026-10-18T10:00Z\n- tB/, 'the one waiting for the person first')
  assert.match((await T.task_look.run({ id: 'tA' })).text, /What happened:\n- .* step \(writer\): draft: passed\nWhat it made:\n- draft: draft\.md/)
  await assert.rejects(T.task_look.run({ id: 'nope' }), /no task nope/)
  assert.equal((await T.task_confirm.run({ id: 'tA', run: '', expect: 0 })).summary.zh, '确认好了：写一条：第一年')
  assert.equal((await T.task_revise.run({ id: 'tA', text: '标题短一点', run: '', expect: 0 })).summary.zh, '再改：写一条：第一年')
  const arch = await T.task_archive.run({ id: 'tA' })
  await T[arch.undo.tool].run(arch.undo.args)
  assert.deepEqual(did.slice(1), [['confirm', 'tA'], ['revise', 'tA', '标题短一点'], ['archive', 'tA', true], ['archive', 'tA', false]])
  assert.deepEqual(taskTools({ tasks: { list() {}, view() {}, confirm() {} } }).map(t => t.name), ['task_list', 'task_look', 'task_confirm'], 'no revise or archive in the service: not offered')
}
// what it is doing now and what it came to, for the task's live card: its latest tool line while at work (said once
// per change), the first sentence of its last reply when the turn is over
{
  await new Promise(r => setTimeout(r, 50)) // (the shell's tool words, loaded)
  const s9 = { id: 's9', title: '写周报', agent: 'sonnet', by: 'person', state: 'working', turns: 0 }
  docs.session.push(at(s9, {})); feed.tick(); last()
  const t9 = [...made.values()].find(t => t.links?.some(l => l.id === 's9')).id
  ev('s9', [{ type: 'tool/call', data: { name: 'Edit', arguments: { file_path: '/w/report.md' } } }]); feed.tick()
  const step = made.get(t9).step
  assert.ok(step && (typeof step === 'string' ? /report\.md/.test(step) : /report\.md/.test(step.zh) && /report\.md/.test(step.en)), JSON.stringify(step))
  last(); feed.tick(); assert.deepEqual(last(), [], 'the same step: not said again')
  ev('s9', [{ type: 'assistant/message', data: { message: { content: [{ text: '周报写好了，放在 report.md。还有几处要你看。' }] } } }])
  at(s9, { state: 'idle', turns: 1, tokens: 51234, cost: 0.12 }); feed.tick()
  assert.deepEqual([made.get(t9).state, made.get(t9).result, made.get(t9).usage], ['to-confirm', '周报写好了，放在 report.md。', { tokens: 51234, cost: 0.12 }])
  at(s9, { state: 'working' }); feed.tick(); at(s9, { state: 'idle', turns: 2, error: 'the model is down' }); feed.tick()
  assert.deepEqual([made.get(t9).state, made.get(t9).result], ['failed', '✗ the model is down'])
  docs.session.splice(docs.session.indexOf(s9), 1); last()
}
console.log('agent-hub task feed check: ok')
