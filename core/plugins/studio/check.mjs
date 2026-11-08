// The studios (index.js, lib/): a declaration checked (an unknown field type, a ref to nothing, a start from nowhere:
// said, with where); records kept with their versions, removed and taken back; values checked by their field's type;
// the first records once (Plume's settings into its first account); starting a workflow from a record, its status
// moving on start and at the run's end; a collection of runs read from the workbench; materials kept and served.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canStartRecord, checkRecord, defineStudio } from './lib/declare.js'
import { createStudios } from './index.js'
import { studioTools } from './lib/tools.js'
import { recordPatch } from './src/record-patch.js'
import { studio as plume, accountFromSettings } from '../../../packs/plume/studio.js'
import { createEngine } from '../../workbench/lib/engine.js'
import { openStore } from '../../workbench/lib/store.js'
import { header, renderReport } from '../../workbench/workflows/common.js'

const tmp = mkdtempSync(join(tmpdir(), 'ruyix-studio-'))
const throwsCode = (fn, code, re) => assert.throws(fn, e => e.code === code && (!re || re.test(e.message)), `${code}${re ? ` ${re}` : ''}`)

// ── the declaration ──
const base = { id: 'demo', collections: { notes: { fields: [{ name: 'title', type: 'text', required: true }] } } }
const d = defineStudio(base)
assert.deepEqual([d.name, d.home.map(b => `${b.view}:${b.size}`)], [{ zh: 'demo', en: 'demo' }, ['start:full', 'working:full', 'board:full']], 'defaults: a name, a home')
throwsCode(() => defineStudio({ ...base, collections: { notes: { fields: [{ name: 'x', type: 'rating' }] } } }), 'badDeclaration', /demo\.collections\.notes\.x: no field type rating/)
throwsCode(() => defineStudio({ ...base, collections: { notes: { fields: [{ name: 'who', type: 'ref:people' }] } } }), 'badDeclaration', /ref:people — no collection people/)
throwsCode(() => defineStudio({ ...base, collections: { notes: { fields: [{ name: 's', type: 'status' }] } } }), 'badDeclaration', /a status lists its values/)
throwsCode(() => defineStudio({ ...base, start: [{ id: 'go', workflow: 'w', from: 'ideas' }] }), 'badDeclaration', /from ideas — no collection/)
throwsCode(() => defineStudio({ ...base, start: [{ id: 'go', workflow: 'w', from: 'notes', text: 'body' }] }), 'badDeclaration', /text ← body, not a field of notes/)
throwsCode(() => defineStudio({ ...base, home: ['start', { view: 'gallery' }] }), 'badDeclaration', /home\[1\]: no view gallery/)
throwsCode(() => defineStudio({ ...base, home: [{ view: 'board' }] }), 'badDeclaration', /a board shows a collection/)
throwsCode(() => defineStudio({ ...base, id: 'Bad Id' }), 'badDeclaration')
throwsCode(() => defineStudio({ ...base, icon: 'Rocket' }), 'badDeclaration', /demo\.icon: no icon Rocket/)
assert.equal(d.icon, 'Boxes', 'none given: the fallback')
assert.equal(defineStudio({ ...base, collections: { notes: { fields: [{ name: 't', type: 'text' }, { name: 's', type: 'status', values: [{ value: 'want' }, { value: 'done' }] }] } } }).collections.notes.fields[1].default, 'want', 'a status starts at its first value')
const p = defineStudio(plume)
for (const allowedStatuses of [[], 'idea', ['unknown']]) throwsCode(() => defineStudio({ ...plume, start: [{ ...plume.start[0], allowedStatuses }] }), 'badDeclaration', /allowedStatuses/)
throwsCode(() => defineStudio({ ...base, start: [{ id: 'go', workflow: 'w', from: 'notes', allowedStatuses: ['idea'] }] }), 'badDeclaration', /allowedStatuses/)
throwsCode(() => defineStudio({ ...plume, start: [{ ...plume.start[0], showForm: 'yes' }] }), 'badDeclaration', /showForm/)
assert.deepEqual(p.start[0].allowedStatuses, ['idea'])
for (const state of ['idea', 'writing', 'ready', 'posted', 'dropped']) assert.equal(canStartRecord(p.start[0], { status: state }, p.collections.ideas), state === 'idea', `start buttons respect ${state}`)
assert.deepEqual(Object.keys(p.collections), ['ideas', 'accounts', 'posts'])
assert.equal(p.start[0].statusField, 'status')
assert.equal(typeof p.seed, 'function')

// ── values, by their field's type ──
const ideas = p.collections.ideas
assert.deepEqual(checkRecord(ideas, { title: ' 写点什么 ' }), { title: '写点什么', platforms: ['xhs', 'x', 'wechat_mp'], research: false, status: 'idea' }, 'trimmed; the defaults filled in')
throwsCode(() => checkRecord(ideas, { notes: 'x' }), 'required', /ideas\.title: needed/)
throwsCode(() => checkRecord(ideas, { title: 't', mood: 'x' }), 'unknownField', /no field mood/)
throwsCode(() => checkRecord(ideas, { title: 't', platforms: ['tiktok'] }), 'badValue', /only xhs, x, wechat_mp/)
throwsCode(() => checkRecord(ideas, { title: 't', status: 'done' }), 'badValue', /one of idea, writing, ready, posted, dropped/)
throwsCode(() => checkRecord(ideas, { title: 't', images: ['https://evil.example/x.png'] }), 'badValue', /a material of the studio/)
throwsCode(() => checkRecord(p.collections.accounts, { name: 'a', accent: 'red' }), 'badValue', /#rrggbb/)
throwsCode(() => checkRecord(ideas, { title: 't', account: 'a1' }, { exists: () => false }), 'badRef', /no accounts a1/)
assert.equal(checkRecord(ideas, { title: 't', when: '2026-10-19T09:00:00+08:00' }).when, Date.parse('2026-10-19T09:00:00+08:00'))
assert.deepEqual(checkRecord(ideas, { status: 'writing' }, { before: { title: 'kept', status: 'idea', research: true } }), { title: 'kept', status: 'writing', research: true }, 'a patch keeps the rest')
throwsCode(() => checkRecord(p.collections.posts, { title: 'x' }), 'readOnly')

// ── Plume's first account: from its settings, once ──
assert.equal(accountFromSettings({}), null, 'nothing set: no account made up')
const settings = { style: { name: '小周', positioning: '写给独立开发者', guide: '短句', language: '简体中文' }, brand: { accent: '#0a7d5a', background: '#fffaf3', signature: '— 小周' }, x: { premium: true }, accounts: { x: 'x-main' } }
const started = [], runs = []
const wb = {
  workflows: () => [{ id: 'plume.post' }, { id: 'blank' }], packSettings: id => (id === 'plume' ? settings : null),
  startRun: async args => { started.push(args); const r = { id: `r${started.length}`, template: args.workflow, status: 'running', studio: args.studio, createdAt: Date.now(), subject: { title: args.title } }; runs.push(r); return r },
  // (the workbench's runsOf: { runs } of a studio, of a workflow, the latest first)
  runsOf: ({ studio, workflow, collection, record }) => ({ runs: runs.filter(r => r.studio?.id === studio && (!workflow || r.template === workflow) && (!collection || r.studio.collection === collection) && (!record || r.studio.record === record)).map(r => ({ id: r.id, title: r.subject.title, workflow: r.template, status: r.status, verdict: null, studio: r.studio, createdAt: r.createdAt, endedAt: null })).reverse() }),
}
const { studios, ops } = createStudios({ home: tmp, workbench: () => wb })
const changes = []
studios.onChange(c => changes.push(c))
const off = studios.register(plume)
assert.equal(studios.workflowStudio('plume.post', 'plume'), 'plume')
assert.equal(studios.workflowStudio('unknown.flow'), null)
const offAlias = studios.register({ ...base, id: 'alias', start: [{ id: 'write', workflow: 'plume.post', from: 'notes' }] })
assert.equal(studios.workflowStudio('plume.post', 'plume'), 'plume', 'pack ownership remains explicit even when another Studio hosts the workflow')
assert.equal(studios.workflowStudio('plume.post', 'alias', { explicit: true }), 'alias', 'an explicit start retains the chosen Studio')
offAlias()
assert.equal(studios.workflowStudio('plume.post', 'plume'), 'plume')
assert.equal(studios.onRunEnd({ id: 'plain-run', studio: { id: 'plume' }, status: 'done' }), false, 'record-less feedback links never update a Studio record')
assert.deepEqual(studios.studios(), [{ id: 'plume', name: { zh: 'Plume 工作室', en: 'Plume Studio' }, icon: 'Feather' }])
const [acct] = studios.list('plume', 'accounts')
assert.deepEqual([acct.name, acct.positioning, acct.accent, acct.signature, acct.xPremium, acct.xConnection, acct.xhsConnection], ['小周', '写给独立开发者', '#0a7d5a', '— 小周', true, 'x-main', 'xhs'])
assert.match(acct.id, /^a[0-9a-f]{10}$/)
studios.remove('plume', 'accounts', acct.id)
off(); studios.register(plume)
assert.equal(studios.list('plume', 'accounts').length, 0, 'seeded once: removed, it does not come back')
studios.restore('plume', 'accounts', acct.id)

// ── records: kept, versioned, removed and taken back ──
const idea = studios.put('plume', 'ideas', { title: '独立开发的第一年', account: acct.id, platforms: ['xhs', 'x'] })
assert.equal(idea.status, 'idea')
throwsCode(() => studios.put('plume', 'ideas', { title: 'x', account: 'nobody' }), 'badRef')
throwsCode(() => studios.put('plume', 'ideas', { id: 'i-none', title: 'x' }), 'noRecord')
const edited = studios.put('plume', 'ideas', { id: idea.id, notes: '收入、时间、心态' })
assert.deepEqual([edited.title, edited.notes, edited.rev > idea.rev, edited.createdAt === idea.createdAt], ['独立开发的第一年', '收入、时间、心态', true, true])
assert.deepEqual(studios.history('plume', 'ideas', idea.id).map(v => v.data.notes ?? null), [null], 'the version before kept')
assert.equal(studios.remove('plume', 'ideas', idea.id), true)
assert.deepEqual(studios.list('plume', 'ideas'), [])
assert.equal(studios.restore('plume', 'ideas', idea.id).notes, '收入、时间、心态')
assert.ok(changes.some(c => c.studio === 'plume' && c.collection === 'ideas'), 'changes are said')

// ── starting its workflow from a record; the status moving with the run ──
const run = await studios.start('plume', 'write', idea.id)
assert.deepEqual(started.at(-1), { workflow: 'plume.post', title: '独立开发的第一年', text: '收入、时间、心态', fields: { platforms: ['xhs', 'x'], research: false, account: acct.id }, studio: { id: 'plume', collection: 'ideas', record: idea.id } })
assert.equal(studios.get('plume', 'ideas', idea.id).status, 'writing', 'started: 在写')
assert.deepEqual(studios.list('plume', 'posts').map(x => [x.id, x.title, x.record]), [[run.id, '独立开发的第一年', idea.id]], 'its posts: its runs (the workbench\'s)')
run.status = 'cancelled'
assert.equal(studios.onRunEnd(run), true)
assert.equal(studios.get('plume', 'ideas', idea.id).status, 'idea', 'stopped: back to 想到, to be picked again')
const finished = await studios.start('plume', 'write', idea.id)
finished.status = 'done'
assert.equal(studios.onRunEnd(finished), true)
assert.equal(studios.get('plume', 'ideas', idea.id).status, 'ready', 'generation finished: publishing is still pending')
assert.equal(studios.history('plume', 'ideas', idea.id)[0].by, `run:${finished.id}`, 'who moved it')
const notePatch = recordPatch(ideas, { ...edited, notes: 'new notes' }, edited)
assert.deepEqual(notePatch, { id: idea.id, notes: 'new notes' })
assert.equal(studios.put('plume', 'ideas', notePatch).status, 'ready', 'saving a stale form\'s notes preserves the newer run-owned status')
assert.equal(studios.get('plume', 'ideas', idea.id).notes, 'new notes')
assert.equal(studios.onRunEnd({ ...run, status: 'done' }), false, 'an older run cannot change the record')
assert.equal(studios.onRunEnd({ id: 'x', status: 'done' }), false, 'a run of no studio: nothing')
await assert.rejects(studios.start('plume', 'nope', idea.id), e => e.code === 'noStart')
throwsCode(() => studios.list('nope', 'ideas'), 'noStudio')

{ // API/tool callers cannot bypass the home page's allowed statuses or omit its record.
  const count = started.length
  for (const status of ['ready', 'posted', 'dropped']) {
    const rec = studios.put('plume', 'ideas', { title: '已结束的选题', status })
    await assert.rejects(studios.start('plume', 'write', rec.id), e => e.code === 'recordState')
    assert.equal(studios.get('plume', 'ideas', rec.id).status, status)
    studios.remove('plume', 'ideas', rec.id)
  }
  await assert.rejects(studios.start('plume', 'write'), e => e.code === 'recordState')
  assert.equal(started.length, count, 'blocked starts create no run')
}

{ // A record is claimed before preparation waits; late completion belongs only to its own run.
  const rec = studios.put('plume', 'ideas', { title: '并发开始' }), original = wb.startRun
  let release
  const gate = new Promise(r => { release = r })
  wb.startRun = async args => { await gate; return original(args) }
  const first = studios.start('plume', 'write', rec.id)
  await assert.rejects(studios.start('plume', 'write', rec.id), e => e.code === 'recordBusy')
  release()
  const a = await first
  await assert.rejects(studios.start('plume', 'write', rec.id), e => e.code === 'recordBusy')
  a.status = 'cancelled'; studios.onRunEnd(a)
  wb.startRun = original
  const b = await studios.start('plume', 'write', rec.id)
  assert.equal(studios.onRunEnd({ ...a, status: 'done' }), false)
  assert.equal(studios.setRunStatus(a, 'posted'), false, 'old publish callbacks cannot own the newer record')
  assert.equal(studios.get('plume', 'ideas', rec.id).status, 'writing')
  b.status = 'done'; studios.onRunEnd(b)
  assert.equal(studios.setRunStatus(b, 'posted'), true, 'confirmed publishing can finish the current record')
  assert.equal(studios.onRunEnd(b), false, 'a duplicate generation callback cannot undo confirmed publication')
  studios.remove('plume', 'ideas', rec.id)
}

{ // Stops, failures and restarts preserve system ownership, while explicit status edits revoke it.
  const rec = studios.put('plume', 'ideas', { title: 'Lifecycle restart' })
  const active = await studios.start('plume', 'write', rec.id)
  for (const status of ['cancelled', 'failed', 'done']) {
    // RecordDialog.clean uses this exact patch builder with its full draft, including the unchanged writing status.
    const formBefore = studios.get('plume', 'ideas', rec.id)
    const formPayload = recordPatch(ideas, { ...formBefore, notes: `notes while writing before ${status}` }, formBefore)
    assert.deepEqual(formPayload, { id: rec.id, notes: `notes while writing before ${status}` })
    studios.put('plume', 'ideas', formPayload)
    active.status = status
    assert.equal(studios.onRunEnd(active), true)
    assert.equal(studios.get('plume', 'ideas', rec.id).status, status === 'done' ? 'ready' : 'idea')
    studios.put('plume', 'ideas', { id: rec.id, notes: `notes after ${status}` })
    assert.equal(studios.onRunResume(active), true, 'a notes-only edit does not revoke the run-owned status')
    assert.equal(studios.get('plume', 'ideas', rec.id).status, 'writing')
    assert.equal(studios.onRunResume(active), false, 'repeated resume does not write the same status again')
  }
  active.status = 'cancelled'; studios.onRunEnd(active)
  studios.put('plume', 'ideas', { id: rec.id, status: 'idea' })
  assert.equal(studios.onRunResume(active), false, 'even choosing the same status explicitly is a manual choice')
  assert.equal(studios.get('plume', 'ideas', rec.id).status, 'idea')
  studios.put('plume', 'ideas', { id: rec.id, status: 'writing' })
  assert.equal(studios.onRunEnd({ ...active, status: 'done' }), false, 'completion does not override a manually chosen writing status')
  const beforeStatusEdit = studios.get('plume', 'ideas', rec.id)
  studios.put('plume', 'ideas', recordPatch(ideas, { ...beforeStatusEdit, status: 'dropped' }, beforeStatusEdit))
  assert.equal(studios.onRunResume(active), false)
  assert.equal(studios.onRunEnd({ ...active, status: 'done' }), false)
  assert.equal(studios.get('plume', 'ideas', rec.id).status, 'dropped')
  studios.put('plume', 'ideas', { id: rec.id, status: 'idea' })
  const replacement = await studios.start('plume', 'write', rec.id)
  assert.equal(studios.onRunResume(active), false, "an older run cannot reclaim a newer run's record")
  assert.equal(studios.get('plume', 'ideas', rec.id).status, 'writing')
  studios.setRunStatus(replacement, 'posted')
  assert.equal(studios.onRunResume(replacement), false, 'a confirmed publication is not a generated done/failed state')
  studios.remove('plume', 'ideas', rec.id)
}

// ── the page's API and materials ──
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const { material } = ops.upload({ studio: 'plume', name: '../../封面.png', data: png.toString('base64') })
// an idea's pictures go to its run as attachments (the run keeps its own copies), not as ids in its form
const withPic = studios.put('plume', 'ideas', { title: '带图的', images: [material.id] })
await studios.start('plume', 'write', withPic.id)
assert.deepEqual([started.at(-1).fields.images, started.at(-1).attachments.map(a => [a.name, a.mime, a.field, Buffer.from(a.base64, 'base64').equals(png)])], [undefined, [['.._.._封面.png', 'image/png', 'images', true]]])
studios.remove('plume', 'ideas', withPic.id)
assert.deepEqual([material.name, material.kind], ['.._.._封面.png', 'image'], 'a name, never a path')
const [m] = ops.materials({ studio: 'plume' }).materials
assert.equal(m.url, `api/ruyix-studio/file?studio=plume&id=${m.id}`)
assert.deepEqual(studios.material('plume', m.id).bytes, png)
assert.equal(studios.material('plume', 'm-other'), null)
assert.equal(ops.items({ studio: 'plume', collection: 'ideas' }).items.length, 1)
assert.ok(ops.revs().revs.plume > 0)
assert.equal(ops.studio({ id: 'plume' }).studio.seed, undefined, 'a page never gets its functions')
assert.equal(ops.removeMaterial({ studio: 'plume', id: m.id }).removed, true)
assert.equal(studios.material('plume', m.id), null)

// ── what is due: a record whose time has come waits for the person on the desk, until seen (for that time) ──
{
  const { dueItem } = await import('./src/due-item.js')
  const t0 = Date.now()
  const late = studios.put('plume', 'ideas', { title: '到点的', when: t0 - 60000 })
  studios.put('plume', 'ideas', { title: '还没到', when: t0 + 3600e3 })
  studios.put('plume', 'ideas', { title: '发过了', when: t0 - 60000, status: 'posted' })
  assert.deepEqual(studios.due(t0).map(x => [x.title, x.status, x.run]), [['到点的', 'idea', null]], 'its time come, not done: only that one')
  const item = dueItem(studios.due(t0)[0], 'zh')
  assert.deepEqual([item.id, item.state, item.wait.title, item.lines[0].text, item.open.detail.panel], [`studio:plume:ideas:${late.id}`, 'waiting', '到点了：到点的', '到点了：到点的 · 还没开写', 'ruyix-studio-plume'])
  assert.equal(dueItem({ ...studios.due(t0)[0], run: { id: 'r', status: 'waiting' } }, 'zh').segs[0].title, '写好了，去发布', 'its run waits for the person: publish it')
  assert.equal(dueItem({ ...studios.due(t0)[0], run: { id: 'r', status: 'done' } }, 'zh').segs[0].title, '写好了，去发布', 'generation done still needs publication')
  assert.equal(ops.dueSeen({ items: [{ studio: 'plume', collection: 'ideas', id: late.id }] }).seen, 1)
  assert.deepEqual(studios.due(t0), [], 'seen: not again')
  studios.put('plume', 'ideas', { id: late.id, when: t0 - 1000 })
  assert.equal(studios.due(t0).length, 1, 'a new time: a new reminder')
  for (const x of studios.list('plume', 'ideas').filter(r => ['到点的', '还没到', '发过了'].includes(r.title))) studios.remove('plume', 'ideas', x.id)
  throwsCode(() => defineStudio({ ...plume, remind: [{ collection: 'ideas', at: 'title' }] }), 'badDeclaration', /at title — not a datetime field of ideas/)
}

// ── the main agent's tools: look, add / change / take out with the way back, start, make a studio of the person's own ──
const tools = Object.fromEntries(studioTools({ studios, icons: ['Feather', 'Boxes'] }).map(t => [t.name, t]))
const use = (name, args) => tools[name].run(args, { by: 'main' })
const undo = r => use(r.undo.tool, r.undo.args)
assert.deepEqual(Object.values(tools).map(t => `${t.name}:${t.effect}`), ['studio_list:read', 'studio_items:read', 'studio_put:direct', 'studio_put_back:undo', 'studio_remove:direct', 'studio_restore:undo', 'studio_start:direct', 'studio_create:direct', 'studio_declaration_back:undo', 'studio_drop:undo'])
assert.match((await use('studio_list', {})).text, /## plume — Plume 工作室[\s\S]*- ideas \(选题\): title \(text, needed\), notes \(textarea\)[\s\S]*status \(status: idea\/writing\/ready\/posted\/dropped\) — 1 now[\s\S]*- posts \(成品\): the runs of plume\.post[\s\S]*- start write \(写一条\): plume\.post from a record of ideas \(its status: start → writing, done → ready, failed → idea\)/)
const added = await use('studio_put', { studio: 'plume', collection: 'ideas', fields: { title: 'AI 写作的三个误区', platforms: ['xhs'], when: '2026-10-19T09:00:00+08:00' } })
assert.deepEqual([added.summary.zh, added.undo.tool], ['记了一条选题：AI 写作的三个误区', 'studio_remove'])
const newId = added.undo.args.id
assert.match((await use('studio_items', { studio: 'plume', collection: 'ideas', status: 'idea' })).text, new RegExp(`- ${newId} \\| title: AI 写作的三个误区 \\| platforms: \\["xhs"\\] \\| research: false \\| when: 2026-10-19T01:00Z \\| status: idea`))
const changed = await use('studio_put', { studio: 'plume', collection: 'ideas', id: newId, fields: { platforms: ['xhs', 'x'] } })
assert.deepEqual(changed.undo, { tool: 'studio_put_back', args: { studio: 'plume', collection: 'ideas', id: newId, before: { platforms: ['xhs'] }, after: { platforms: ['xhs','x'] } } })
await undo(changed)
assert.deepEqual(studios.get('plume', 'ideas', newId).platforms, ['xhs'], 'its undo: as it was')
const staleField=await use('studio_put',{studio:'plume',collection:'ideas',id:newId,fields:{platforms:['x']}})
studios.put('plume','ideas',{id:newId,platforms:['xhs','x']})
await assert.rejects(undo(staleField),e=>e.code==='recordChanged')
assert.deepEqual(studios.get('plume','ideas',newId).platforms,['xhs','x'])
await assert.rejects(tools.studio_put.run({studio:'plume',collection:'ideas',id:newId,fields:{platforms:['x']}},{undo:true}),e=>e.code==='recordChanged','old journal undo without a snapshot fails closed')

const removed = await use('studio_remove', { studio: 'plume', collection: 'ideas', id: newId })
assert.equal(studios.get('plume', 'ideas', newId), null)
await undo(removed)
assert.equal(studios.get('plume', 'ideas', newId).title, 'AI 写作的三个误区', 'taken out, brought back')
await assert.rejects(undo(added),e=>e.code==='recordChanged','stale create undo preserves the record changed since')
await use('studio_remove',{studio:'plume',collection:'ideas',id:newId})
const freshRecord=await use('studio_put',{studio:'plume',collection:'ideas',fields:{title:'fresh control'}});await undo(freshRecord)
assert.equal(studios.get('plume','ideas',freshRecord.undo.args.id),null)
await assert.rejects(use('studio_put', { studio: 'plume', collection: 'ideas', fields: { title: 'x', mood: 'happy' } }), /no field mood/)
await assert.rejects(use('studio_start', { studio: 'plume', start: 'write', record: idea.id }), e => e.code === 'recordState')
const toolIdea = studios.put('plume', 'ideas', { title: '工具新选题' })
const st = await use('studio_start', { studio: 'plume', start: 'write', record: toolIdea.id })
assert.match(st.text, /^Started run r\d+ from i/)
// a studio of the person's own: checked (its workflows must be here), kept, back after a restart, changed, taken out
const mine = { id: 'reading', name: { zh: '读书笔记', en: 'Reading notes' }, icon: 'Feather', collections: { books: { title: { zh: '书' }, fields: [{ name: 'title', type: 'text', required: true }, { name: 'state', type: 'status', values: [{ value: 'want' }, { value: 'reading' }, { value: 'done' }] }] } }, start: [{ id: 'notes', label: '写笔记', workflow: 'blank', from: 'books', title: 'title', status: { start: 'reading', done: 'done' } }] }
await assert.rejects(use('studio_create', { declaration: { ...mine, start: [{ ...mine.start[0], workflow: 'nope.flow' }] } }), /start notes: no workflow nope\.flow here \(plume\.post, blank\)/)
await assert.rejects(use('studio_create', { declaration: { ...mine, icon: 'Rocket' } }), /reading\.icon: no icon Rocket/)
await assert.rejects(use('studio_create', { declaration: { ...mine, id: 'plume' } }), e => e.code === 'packStudio')
const made = await use('studio_create', { declaration: mine })
assert.deepEqual([made.summary.zh, made.undo], ['建了工作室：读书笔记', { tool: 'studio_drop', args: { id: 'reading', after: {declaration:mine,rev:0} } }])
assert.ok(studios.studios().some(s => s.id === 'reading') && studios.isOwn('reading'))
studios.create({ id: 'profile', name: { zh: '资料', en: 'Profile' }, icon: 'Feather', collections: { info: { single: true, title: { zh: '资料', en: 'Profile' }, fields: [{ name: 'name', type: 'text' }] } } })
await use('studio_put', { studio: 'profile', collection: 'info', fields: { name: 'A' } })
const singleEdit = await use('studio_put', { studio: 'profile', collection: 'info', fields: { name: 'B' } })
assert.equal(singleEdit.undo.tool, 'studio_put_back')
await undo(singleEdit)
assert.equal(studios.get('profile', 'info', 'main').name, 'A', 'singleton undo restores the prior fields')
await use('studio_put', { studio: 'reading', collection: 'books', fields: { title: '置身事内' } })
studios.close()
const again = createStudios({ home: tmp, workbench: () => wb }).studios
assert.deepEqual([again.isOwn('reading'), again.list('reading', 'books').map(b => b.title)], [true, ['置身事内']], 'after a restart: the studio and its records')
const tools2 = Object.fromEntries(studioTools({ studios: again }).map(t => [t.name, t]))
const renamed = await tools2.studio_create.run({ declaration: { ...mine, name: { zh: '读书', en: 'Books' } } })
assert.equal(renamed.undo.tool, 'studio_declaration_back', 'changed: its undo puts the old one back')
await tools2[renamed.undo.tool].run(renamed.undo.args)
assert.equal(again.declaration('reading').name.zh, '读书笔记')
await assert.rejects(tools2.studio_drop.run(made.undo.args),e=>e.code==='studioChanged','records added after creation prevent an old undo from hiding the studio')
const staleDeclaration=await tools2.studio_create.run({declaration:{...mine,name:{zh:'旧修改',en:'Old edit'}}})
again.put('reading','books',{title:'later work'})
await assert.rejects(tools2[staleDeclaration.undo.tool].run(staleDeclaration.undo.args),e=>e.code==='studioChanged','later records also guard a declaration undo')
again.create({...mine,name:{zh:'后来改的',en:'Later edit'}})
await assert.rejects(tools2[staleDeclaration.undo.tool].run(staleDeclaration.undo.args),e=>e.code==='studioChanged')
assert.equal(again.declaration('reading').name.en,'Later edit')
await assert.rejects(tools2.studio_create.run({declaration:mine},{undo:true}),e=>e.code==='studioChanged')
await assert.rejects(tools2.studio_drop.run(made.undo.args),e=>e.code==='studioChanged','old creation undo preserves a later declaration')
await tools2.studio_drop.run({ id: 'reading', after: {declaration:again.ownDeclaration('reading'),rev:again.rev('reading')} })
assert.ok(!again.studios().some(s => s.id === 'reading'))
assert.throws(() => again.drop('plume'), e => e.code === 'notOwn', 'a pack\'s studio is not the person\'s to take out')
again.close()
// Real engine/SQLite boundary: hosting a general workflow does not confer ownership over unrelated tasks.
{
  const store = openStore(join(tmp, 'ownership-engine')), briefs = new Map()
  const stage = { key: 'work', owner: 'system', async run(w) { briefs.set(w.run.id, header(w, 'Work')); return { ok: true } } }
  const workflows = Object.fromEntries(['task', 'blank', 'newsletter.issue'].map(id => [id, { id, title: id, roles: {}, stages: [stage], report: renderReport, ...(id === 'newsletter.issue' && { pack: 'newsletter', preferenceOptions: ['detail', 'tone'] }) }]))
  const custom = { id: 'personal-flow', base: 'blank', title: 'Personal flow', steps: [{ use: 'work' }] }
  let engine
  const service = createStudios({ home: join(tmp, 'ownership-studios'), workbench: () => ({
    workflows: () => Object.values(workflows), startRun: args => engine.startRun(args), run: id => engine.get(id), workflowOf: run => engine.workflowFor(run),
    runsOf: ({ studio }) => ({ runs: store.list('run').filter(r => r.studio?.id === studio).map(r => ({ ...r, title: r.subject.title })) }),
  }) }).studios
  engine = createEngine({ store, workflow: id => workflows[id], custom: id => id === custom.id ? custom : null, packOf: wf => wf?.pack ? { id: wf.pack } : null,
    settings: () => ({ autoResume: { enabled: false }, stages: {}, steps: {}, packs: {} }), hub: () => ({}), mcp: { name: 'ownership-check' },
    services: { studio: () => service }, versions: { snapshot: async () => null } })
  const finish = async run => { for (let i = 0; i < 200 && engine.get(run.id).status === 'running'; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(engine.get(run.id).status, 'done'); return engine.get(run.id) }
  const declaration = (id, workflow) => ({ id, collections: { notes: { fields: [{ name: 'title', type: 'text' }] } }, start: [{ id: 'go', workflow }] })
  try {
    service.create({ ...declaration('reading', 'task'), start: [{ id: 'go', workflow: 'task' }, { id: 'blank', workflow: 'blank' }] })
    for (let i = 0; i < 2; i++) {
      const run = await finish(await service.start('reading', 'go', null, { fields: {} }))
      assert.deepEqual(run.studio, { id: 'reading' }, 'explicit record-less Studio starts are honored')
      const target = service.feedbackView('reading', run.id).targets.find(t => t.stage === '$final')
      service.rate('reading', { run: run.id, stage: target.stage, revision: target.revision, score: 5, choices: { tone: 'narrative' }, note: 'Reading notes should tell a story' })
    }
    assert.ok(service.preferences('reading', { workflow: workflows.task }).rules.some(r => r.key === 'tone'))
    for (const workflow of ['task', 'personal-flow']) {
      const run = await finish(await engine.startRun({ workflow, title: 'Unrelated repository work' }))
      assert.equal(run.studio, undefined); assert.equal(run.studioPreferences, undefined)
      assert.doesNotMatch(briefs.get(run.id), /Studio preferences|Reading notes should tell a story/)
      assert.ok(!service.feedbackView('reading').runs.some(r => r.id === run.id))
    }
    assert.equal(service.workflowStudio('task', 'reading'), null, 'a person-made Studio cannot become an inferred pack owner')
    service.register(declaration('newsletter', 'newsletter.issue'))
    service.create(declaration('letters', 'newsletter.issue'))
    for (let i = 0; i < 2; i++) {
      const run = await finish(await service.start('letters', 'go'))
      assert.deepEqual(run.studio, { id: 'letters' })
      const target = service.feedbackView('letters', run.id).targets[0]
      service.rate('letters', { run: run.id, stage: target.stage, revision: target.revision, score: 5, choices: { tone: 'direct' } })
    }
    const explicit = await finish(await service.start('letters', 'go'))
    assert.deepEqual(explicit.studio, { id: 'letters' }); assert.match(briefs.get(explicit.id), /tone = direct/)
    assert.ok(service.feedbackView('letters').runs.some(r => r.id === explicit.id))
    const ordinary = await finish(await engine.startRun({ workflow: 'newsletter.issue', title: 'Pack-owned ordinary run' }))
    assert.deepEqual(ordinary.studio, { id: 'newsletter' }); assert.ok(ordinary.studioPreferences)
    assert.doesNotMatch(briefs.get(ordinary.id), /tone = direct/)
    assert.ok(!service.feedbackView('letters').runs.some(r => r.id === ordinary.id))
  } finally { engine.dispose(); service.close(); store.close() }
}
rmSync(tmp, { recursive: true, force: true })
console.log('studio check: ok')
