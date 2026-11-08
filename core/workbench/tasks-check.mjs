// Tasks (lib/tasks.js) on a real store, a fake engine and a fake clock: runs from before tasks get one-off tasks, a
// one-off task runs now, a scheduled one when it is due (its request checked when it is made), a time due while the
// last run still goes is skipped, the last finished run's files go to the next one, a box that was off catches up once
// (or says it missed), Agent Hub not up yet is tried again for a while, changes, run now, archive.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './lib/store.js'
import { carryFiles, createTasks, oneOffOf } from './lib/tasks.js'
import { instantOf } from './lib/schedule.js'
import { taskTools } from '../plugins/agent-hub/task-tools.js'
import { createRunMessages } from './lib/messages.js'

const root = mkdtempSync(join(tmpdir(), 'ruyix-tasks-'))
const store = openStore(join(root, 'home'))
const TZ = 'Asia/Shanghai'
const at = (d, h, m = 0) => instantOf(2026, 10, d, h, m, TZ) // October 2026, Shanghai
let clock = at(17, 7, 0)
const timers = []
const setTimer = (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t }
const clearTimer = t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) }

let n = 0, tasks = null
const engine = {
  calls: [], down: false,
  async checkRequest(q) {
    if (q.workflow === 'nope') throw Object.assign(new Error('unknown workflow nope'), { code: 'badWorkflow' })
    if (!q.title && !q.text) throw Object.assign(new Error('give a title or a text'), { code: 'badInput' })
    return { subject: { title: q.title || '', text: q.text || '', fields: q.fields || {} } }
  },
  async startRun(a) {
    if (engine.down) throw Object.assign(new Error('the agents plugin (Agent Hub) is not running'), { code: 'noHub' })
    const id = `r${String(++n).padStart(7, '0')}`
    const dir = join(root, 'runs', id, 'work')
    mkdirSync(dir, { recursive: true })
    const files = a.seed ? a.seed(dir) : undefined
    const r = store.put('run', { id, template: a.workflow, subject: { title: a.title || '', text: a.text || '', fields: a.fields || {} }, status: 'running', dir, createdAt: clock, taskId: a.taskId || `t${id.slice(1)}`, ...(a.previous && { previous: { ...a.previous, files } }), ...(a.why === 'schedule' && { startedBy: 'schedule' }) })
    tasks.noteRun(r)
    engine.calls.push(a)
    return r
  },
}
const finish = (id, status = 'done') => store.put('run', { ...store.get('run', id), status, endedAt: clock })
const make = () => { tasks = createTasks({ store, engine, now: () => clock, setTimer, clearTimer }); return tasks }

// ── runs from before tasks: a one-off task each, once ──
store.put('run', { id: 'rold0001', template: 'blank', subject: { title: '旧的运行', text: 'x', fields: {}, attachments: [] }, status: 'done', createdAt: at(1, 9), archivedAt: at(2, 9) })
make()
assert.equal(tasks.adopt(), 1)
assert.equal(tasks.adopt(), 0, 'once')
const old = store.get('task', 'told0001')
assert.equal(store.get('run', 'rold0001').taskId, 'told0001')
assert.deepEqual([old.title, old.schedule.kind, old.runCount, old.lastRunId, !!old.archivedAt], ['旧的运行', 'once', 1, 'rold0001', true], 'an archived run: its task archived too')
assert.equal(oneOffOf({ id: 'rabc', template: 'w', subject: { text: '第一行\n第二行' }, createdAt: 1 }).title, '第一行', 'no title: the first line')

// The tools must pass the generation actually shown, even after a new result exists.
{
  const api = tasks, view = api.make({ source: 'chat', title: 'tool version', state: 'to-confirm', result: 'first' })
  let revised = 0
  const off = api.registerSource('chat', { revise() { revised++ } })
  const T = Object.fromEntries(taskTools({ tasks: {
    list: a => api.list(a), view: id => ({ task: api.viewOne(api.get(id)) }),
    confirm: (id, run, expect) => api.confirm({ id, run, expect }), revise: (id, text, run, expect) => api.revise({ id, text, run, expect }),
  } }).map(t => [t.name, t]))
  const seen = api.viewOne(api.get(view.id)), text = (await T.task_look.run({ id: view.id })).text
  assert.ok(text.includes(`resultVersion: ${seen.resultVersion}`))
  api.change(view.id, { result: 'second' })
  await assert.rejects(T.task_confirm.run({ id: view.id, run: '', expect: seen.resultVersion }), e => e.code === 'changedMeanwhile')
  await assert.rejects(T.task_revise.run({ id: view.id, text: 'edit', run: '', expect: seen.resultVersion }), e => e.code === 'changedMeanwhile')
  assert.equal(revised, 0)
  await assert.rejects(T.task_confirm.run({ id: view.id }), e => e.code === 'changedMeanwhile')
  await T.task_confirm.run({ id: view.id, run: '', expect: api.get(view.id).resultVersion })
  assert.equal(api.viewOne(api.get(view.id)).state, 'done'); off(); store.remove('task', view.id)
}

// ── once: runs now, its task made for it ──
const once = await tasks.create({ workflow: 'blank', title: '写一篇短文' })
assert.equal(once.run.taskId, once.task.id)
assert.deepEqual([once.task.schedule.kind, once.task.runCount, once.task.lastRunId], ['once', 1, once.run.id])
finish(once.run.id)
// run again: the same task, a second run
const again = await tasks.runNow({ id: once.task.id })
assert.equal(again.taskId, once.task.id)
assert.equal(store.get('task', once.task.id).runCount, 2)
await assert.rejects(tasks.runNow({ id: once.task.id }), e => e.code === 'taskBusy', 'not while a run of it goes')
await assert.rejects(Promise.resolve().then(() => tasks.archive({ id: once.task.id })), e => e.code === 'archiveActive')
finish(again.id)

// ── scheduled: checked when made; due at its time ──
await assert.rejects(tasks.create({ workflow: 'nope', title: 'x', schedule: { kind: 'daily', at: '08:00' } }), e => e.code === 'badWorkflow', 'the request is checked now, not at 08:00')
await assert.rejects(tasks.create({ workflow: 'blank', title: 'x', schedule: { kind: 'daily', at: '25:00' } }), e => e.code === 'badSchedule')
await assert.rejects(tasks.create({ workflow: 'blank', title: 'x', schedule: { kind: 'daily', at: '08:00' }, tz: 'Mars/Base' }), e => e.code === 'badSchedule')
await assert.rejects(tasks.create({ workflow: 'blank', title: 'x', schedule: { kind: 'daily', at: '08:00' }, attachments: [{ name: 'a' }] }), e => e.code === 'badInput')
const daily = (await tasks.create({ workflow: 'blank', title: 'AI 行业早报', text: '今天的 AI 新闻', schedule: { kind: 'daily', at: '08:00' }, tz: TZ })).task
assert.equal(daily.nextAt, at(17, 8))
assert.deepEqual([daily.enabled, daily.catchUp, daily.carry, daily.runCount], [true, true, true, 0])
assert.ok(timers.length === 1 && timers[0].at - clock <= 60e3 && timers[0].at - clock >= 1000, 'the next look within a minute')
// before its first run it waits for its time: not at work (not queued, counted on its own)
{
  const l = tasks.list({ state: ['queued', 'working'] })
  assert.ok(!l.tasks.some(x => x.id === daily.id) && l.counts.scheduled >= 1 && l.counts.queued === tasks.list({}).tasks.filter(x => x.state === 'queued' && !(x.schedule && !x.runs)).length, 'waiting for its time is not 在做')
}

clock = at(17, 7, 59); await tasks.tick()
assert.equal(engine.calls.length, 2, 'not yet')
clock = at(17, 8, 0); await tasks.tick()
let t = store.get('task', daily.id)
const first = store.get('run', t.lastRunId)
assert.deepEqual([first.taskId, first.startedBy, t.runCount, t.nextAt], [daily.id, 'schedule', 1, at(18, 8)])
assert.equal(first.previous, undefined, 'no finished run to carry yet')

// the next day, the first still going: skipped, said, not stacked
clock = at(18, 8, 0); await tasks.tick()
t = store.get('task', daily.id)
assert.deepEqual([t.runCount, t.skipped, t.nextAt], [1, { at: at(18, 8), why: 'running' }, at(19, 8)])

// it finishes with files: the next run gets them in previous/ (not its attachments, nothing hidden, no links, no big file)
mkdirSync(join(first.dir, 'attachments'), { recursive: true }); writeFileSync(join(first.dir, 'attachments', 'in.pdf'), 'x')
mkdirSync(join(first.dir, 'sources')); writeFileSync(join(first.dir, 'sources', 'list.md'), '- a')
writeFileSync(join(first.dir, 'brief.md'), '# 10 月 17 日'); writeFileSync(join(first.dir, '.secret'), 'no')
writeFileSync(join(first.dir, 'big.bin'), Buffer.alloc(3 << 20)); symlinkSync('/etc/hosts', join(first.dir, 'link'))
finish(first.id)
clock = at(19, 8, 0); await tasks.tick()
t = store.get('task', daily.id)
const second = store.get('run', t.lastRunId)
assert.notEqual(second.id, first.id)
assert.deepEqual([second.previous.id, second.previous.files, second.previous.schedule], [first.id, 2, 'every day at 08:00'])
assert.deepEqual(readdirSync(join(second.dir, 'previous')).sort(), ['brief.md', 'sources'])
assert.equal(t.skipped, null, 'a run that started clears the skip')
finish(second.id)

// ── the box was off three days: one catch-up run on waking; without catch-up, said missed, the next time waited for ──
tasks.dispose()
const lazy = (await make().create({ workflow: 'blank', title: '周报', schedule: { kind: 'daily', at: '09:00' }, tz: TZ, catchUp: false })).task
tasks.dispose()
clock = at(23, 12, 0)
const before = engine.calls.length
make()
assert.equal(store.get('task', daily.id).nextAt, clock, 'catch-up: due now')
t = store.get('task', lazy.id)
assert.deepEqual([t.nextAt, t.skipped], [at(24, 9), { at: at(23, 9), why: 'off' }])
await tasks.tick()
assert.equal(engine.calls.length, before + 1, 'once for the three days, not three times')
t = store.get('task', daily.id)
assert.equal(t.nextAt, at(24, 8))
finish(t.lastRunId)

// ── Agent Hub not up yet: tried again for a while; then said on the task and the next time waited for ──
engine.down = true
clock = at(24, 8, 0); await tasks.tick()
assert.equal(store.get('task', daily.id).nextAt, at(24, 8), 'still due')
clock = at(24, 8, 10); await tasks.tick()
assert.ok(!store.get('task', daily.id).error, 'still trying, nothing said yet')
clock = at(24, 8, 40); await tasks.tick()
t = store.get('task', daily.id)
assert.equal(t.error.code, 'noHub')
assert.equal(t.nextAt, at(25, 8))
engine.down = false

// ── changes: off, on, another time, every N hours counted from when it was set ──
t = tasks.update({ id: daily.id, enabled: false })
assert.equal(t.nextAt, null)
t = tasks.update({ id: daily.id, enabled: true, schedule: { kind: 'daily', at: '18:30', days: [1, 2, 3, 4, 5] } })
assert.equal(t.nextAt, at(26, 18, 30), 'Saturday the 24th → Monday the 26th')
assert.equal(t.error, null)
t = tasks.update({ id: daily.id, schedule: { kind: 'every', minutes: 360 } })
assert.deepEqual([t.schedule.from, t.nextAt], [clock, clock + 6 * 3600e3])
clock += 3600e3
t = tasks.update({ id: daily.id, schedule: { kind: 'every', minutes: 360 } })
assert.equal(t.schedule.from, clock - 3600e3, 'the same interval keeps counting from when it was set')
// a one-off made to repeat
t = tasks.update({ id: once.task.id, schedule: { kind: 'daily', at: '07:00' }, tz: TZ })
assert.deepEqual([t.enabled, t.nextAt], [true, at(25, 7)])

// ── archive: not run any more; back again ──
t = tasks.archive({ id: daily.id })
assert.ok(t.archivedAt && t.nextAt === null)
assert.throws(() => tasks.update({ id: daily.id, title: 'x' }), e => e.code === 'taskArchived')
t = tasks.archive({ id: daily.id, archived: false })
assert.ok(!t.archivedAt && t.nextAt > clock)

// ── carryFiles alone: the limits ──
const src = join(root, 'src'), dst = join(root, 'dst')
mkdirSync(src); mkdirSync(dst)
for (let i = 0; i < 305; i++) writeFileSync(join(src, `f${String(i).padStart(3, '0')}.txt`), 'x')
assert.equal(carryFiles(src, dst), 300, 'at most 300 files')
assert.equal(carryFiles(join(root, 'none'), join(root, 'dst2')), 0, 'no folder: nothing')

// Starting a run waits for preparation: a second click, a scheduler tick or archive must still see it as busy.
{
  const startRun = engine.startRun
  let release
  const prepared = new Promise(resolve => { release = resolve })
  engine.startRun = async a => { await prepared; return startRun(a) }
  try {
    const pending = tasks.runNow({ id: once.task.id })
    await assert.rejects(tasks.runNow({ id: once.task.id }), e => e.code === 'taskBusy')
    assert.throws(() => tasks.archive({ id: once.task.id }), e => e.code === 'archiveActive')
    await assert.rejects(tasks.remove({ id: once.task.id }), e => e.code === 'taskBusy')
    release()
    finish((await pending).id)
  } finally { release(); engine.startRun = startRun }
  engine.down = true
  await assert.rejects(tasks.runNow({ id: once.task.id }), e => e.code === 'noHub')
  engine.down = false
  finish((await tasks.runNow({ id: once.task.id })).id)
}

// A timer rearmed while preparation is pending cannot start a second scheduler pass.
{
  const startRun = engine.startRun
  let release, calls = 0
  const prepared = new Promise(resolve => { release = resolve })
  engine.startRun = async a => { calls++; await prepared; return startRun(a) }
  store.put('task', { ...tasks.get(once.task.id), nextAt: clock })
  try {
    const pending = tasks.tick()
    await tasks.tick()
    assert.equal(calls, 1)
    release()
    await pending
    finish(tasks.get(once.task.id).lastRunId)
    assert.equal(timers.length, 1, 'the scheduler arms its next timer after preparation')
  } finally { release(); engine.startRun = startRun }
}

// A compound cursor preserves every output and record when timestamps tie at a page boundary.
{
  const task = tasks.make({ source: 'chat', title: 'pagination fixture', state: 'done' })
  const outputs = Array.from({ length: 45 }, (_, i) => ({ id: `tie-${String(i).padStart(2, '0')}`, title: 'file', kind: 'file', final: true, at: 777 }))
  store.put('task', { ...tasks.get(task.id), outputs })
  const first = await tasks.outputs({ q: 'pagination fixture', limit: 40 })
  const second = await tasks.outputs({ q: 'pagination fixture', limit: 40, before: first.cursor })
  assert.equal(first.outputs.length, 40); assert.equal(second.outputs.length, 5)
  assert.equal(new Set([...first.outputs, ...second.outputs].map(x => x.id)).size, 45)
  const { recordsOf } = await import('./lib/records.js')
  const rows = outputs.map(o => ({ ...o, kind: 'run', agents: [], title: 'tie' }))
  const a = recordsOf(rows, { limit: 40 }), b = recordsOf(rows, { limit: 40, before: a.cursor })
  assert.equal(new Set([...a.items, ...b.items].map(x => x.id)).size, 45)
}
// Renaming the scheduled request also renames what its next run is asked to do.
{
  const made = await tasks.create({ workflow: 'blank', title: 'A', schedule: { kind: 'daily', at: '08:00' }, tz: TZ })
  tasks.update({ id: made.task.id, title: 'B' })
  const run = await tasks.runNow({ id: made.task.id })
  assert.equal(run.subject.title, 'B')
}
tasks.dispose()
{
  const task = tasks.make({ source: 'chat', title: 'two versions' })
  const base = { template: 'blank', subject: { title: 'version', fields: {} }, status: 'done', taskId: task.id }
  store.put('run', { ...base, id: 'rversion-old', createdAt: clock + 1 })
  store.put('run', { ...base, id: 'rversion-new', createdAt: clock + 2 })
  assert.throws(() => tasks.confirm({ id: task.id, run: 'rversion-old' }), { code: 'changedMeanwhile' })
  await assert.rejects(tasks.revise({ id: task.id, text: 'change the first version', run: 'rversion-old' }), { code: 'changedMeanwhile' })
  assert.equal(tasks.get(task.id).confirmedRunId, undefined)
  tasks.confirm({ id: task.id, run: 'rversion-new' })
  assert.equal(tasks.get(task.id).confirmedRunId, 'rversion-new')
  const previous=tasks.get(task.id).resultVersion
  tasks.runEnded(store.get('run','rversion-old'))
  assert.equal(tasks.get(task.id).resultVersion,previous,'an older run finishing cannot invalidate the latest accepted result')
  tasks.runEnded(store.get('run','rversion-new'))
  assert.equal(tasks.viewOne(tasks.get(task.id)).state,'to-confirm','a new result of the same run needs a fresh acceptance')
  assert.equal(tasks.get(task.id).confirmedRunId,null)
  tasks.confirm({id:task.id,run:'rversion-new',expect:tasks.get(task.id).resultVersion})
  assert.equal(tasks.viewOne(tasks.get(task.id)).state,'done')
}

{
  const t = tasks.make({ source: 'chat', title: 'non-workflow versions' })
  tasks.change(t.id, { state: 'to-confirm', result: 'first result' })
  const first = tasks.viewOne(tasks.get(t.id)).resultVersion
  tasks.change(t.id, { state: 'working', result: null })
  tasks.change(t.id, { state: 'to-confirm', result: 'second result' })
  const second = tasks.viewOne(tasks.get(t.id)).resultVersion
  assert.ok(second > first, 'result versions advance even at exactly the same clock time')
  assert.throws(() => tasks.confirm({ id: t.id, run: '', expect: first }), { code: 'changedMeanwhile' })
  await assert.rejects(tasks.revise({ id: t.id, run: '', expect: first, text: 'edit the first result' }), { code: 'changedMeanwhile' })
  assert.equal(tasks.viewOne(tasks.get(t.id)).state, 'to-confirm')
  tasks.confirm({ id: t.id, run: '', expect: second })
  assert.equal(tasks.viewOne(tasks.get(t.id)).state, 'done')
  const earlier = tasks.get(t.id).resultVersion
  tasks.runEnded({ taskId: t.id, id: 'same-run' })
  tasks.runEnded({ taskId: t.id, id: 'same-run' })
  assert.equal(tasks.get(t.id).resultVersion, earlier + 2, 'reruns of one run id have distinct completed results')
}

// Failed source admission leaves the original result generation confirmable; later source results survive failure.
{
  const t = tasks.make({source:'session',title:'failed revise',state:'to-confirm'}), version=tasks.get(t.id).resultVersion
  let off=tasks.registerSource('session',{revise(){throw new Error('session gone')}})
  await assert.rejects(tasks.revise({id:t.id,text:'edit',expect:version}),/session gone/)
  assert.equal(tasks.get(t.id).resultVersion,version)
  tasks.confirm({id:t.id,expect:version});assert.equal(tasks.viewOne(tasks.get(t.id)).state,'done');off()
  off=tasks.registerSource('session',{revise(){tasks.change(t.id,{state:'to-confirm',result:'new source result'});throw new Error('late failure')}})
  await assert.rejects(tasks.revise({id:t.id,text:'edit again'}),/late failure/)
  assert.equal(tasks.viewOne(tasks.get(t.id)).state,'to-confirm');assert.equal(tasks.get(t.id).result.en,'new source result');off()
}

// A purged run releases its actual SQLite handle, and a later same-id space is a fresh database.
{
  const messages = createRunMessages(root), first = messages.of('purged')
  first.post({ from:'writer', text:'before deletion' })
  messages.close('purged')
  assert.throws(() => first.log(), /closed|open/i)
  rmSync(join(root,'runs','purged'),{recursive:true,force:true})
  assert.deepEqual(messages.log('purged'),{messages:[],members:[]})
  assert.notEqual(messages.of('purged'),first);messages.close()
}

store.close()
rmSync(root, { recursive: true, force: true })
// the Runs page's scopes (src/task-scope.js): a once-only task whose run was archived on its page is put away with it;
// a repeating one only as a task (its next runs still come)
{
  const { inTaskScope } = await import('./src/task-scope.js')
  const once = { id: 'o', schedule: { kind: 'once' } }, daily = { id: 'd', schedule: { kind: 'daily' } }
  const r = archived => ({ status: 'done', ...(archived && { archivedAt: 1 }) })
  const at = (t, runs) => ['all', 'archived'].filter(sc => inTaskScope(t, runs, sc))
  assert.deepEqual(at(once, [r(true)]), ['archived'], 'its run archived: the task is put away')
  assert.deepEqual(at(once, [r(true), r(false)]), ['all'], 'not while one of its runs is still out')
  assert.deepEqual(at(daily, [r(true)]), ['all'], 'a repeating task stays: its next runs still come')
  assert.deepEqual(at({ ...daily, archivedAt: 1 }, [r(false)]), ['archived'])
  assert.deepEqual(at(once, []), ['all'], 'no run yet: out')
}
console.log('tasks check: ok')

// ── what the tasks used, by the hour (lib/usage-hours.js; the desk's 「今天」) ──
{
  const { createUsageHours } = await import('./lib/usage-hours.js')
  const hs = openStore(mkdtempSync(join(tmpdir(), 'ruyix-usage-hours-')))
  const H = 3600e3, day = Date.UTC(2026, 9, 19), t = (h, m = 0) => day + h * H + m * 60e3
  let clockU = t(10, 20), seen = new Map([['a', { tokens: 1000, cost: 0.1, at: t(9, 10) }]])
  const u = createUsageHours({ store: hs, read: () => seen, now: () => clockU })
  u.sample() // the first read: what task a used so far goes to the hour it last moved
  assert.equal(u.since(day).tokens, 1000)
  assert.equal(u.since(day, 12).hours.find(x => x.at === t(9)).tokens, 1000, 'at the hour it last moved')
  clockU = t(11, 5)
  seen = new Map([['a', { tokens: 1500, cost: 0.15, at: t(11) }], ['b', { tokens: 200, cost: null, at: t(11) }]])
  u.sample() // what grew goes to this hour; a task seen for the first time, to the hour it last moved
  const d = u.since(day, 12)
  assert.equal(d.tokens, 1700); assert.equal(d.cost, 0.15)
  assert.equal(d.hours.length, 12); assert.equal(d.hours.at(-1).at, t(11)); assert.equal(d.hours.at(-1).tokens, 700)
  assert.equal(u.since(t(11)).tokens, 700, 'since a later time: only the hours from it')
  clockU = t(11, 40)
  seen = new Map([['a', { tokens: 100, cost: 0.01, at: t(11) }]]) // a total that went down (reset, deleted): nothing taken back
  u.sample()
  assert.equal(u.since(day).tokens, 1700)
  console.log('usage by the hour: ok')
}
