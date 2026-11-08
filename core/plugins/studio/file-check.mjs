// The generic Studio file field through the real engine attachment boundary. No model, socket or user's home.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStudios } from './index.js'
import { defineStudio, checkRecord } from './lib/declare.js'
import { createEngine } from '../../workbench/lib/engine.js'
import { openStore } from '../../workbench/lib/store.js'

const root = mkdtempSync(join(tmpdir(), 'ruyix-studio-files-'))
const store = openStore(join(root, 'engine'))
const declaration = id => ({ id, collections: { projects: { fields: [
  { name: 'title', type: 'text', required: true },
  { name: 'footage', type: 'file', multiple: true },
  { name: 'reference', type: 'file' },
  { name: 'cover', type: 'image' },
  { name: 'status', type: 'status', values: [{ value: 'idea' }, { value: 'working' }, { value: 'done' }] },
] } }, start: [{ id: 'create', workflow: 'file-fixture', from: 'projects', title: 'title',
  fields: { sources: 'footage', reference: 'reference', cover: 'cover' }, status: { start: 'working', done: 'done', failed: 'idea' } }], home: ['start'] })
const wf = { id: 'file-fixture', title: 'Attachment fixture', roles: {},
  input: [{ name: 'sources', type: 'files', required: true }, { name: 'reference', type: 'files' }, { name: 'cover', type: 'files' }],
  stages: [{ key: 'inspect', owner: 'system', run: async () => ({ ok: true }) }] }
let engine
const { studios } = createStudios({ home: join(root, 'studios'), workbench: () => ({
  startRun: args => engine.startRun(args),
  runsOf: ({ studio, collection, record }) => ({ runs: store.list('run').filter(r => r.studio?.id === studio && (!collection || r.studio.collection === collection) && (!record || r.studio.record === record)) }),
}) })
engine = createEngine({ store, settings: () => ({ autoResume: { enabled: false }, stages: {}, packs: {}, steps: {} }),
  hub: () => ({}), mcp: { name: 'file-check' }, workflow: id => id === wf.id ? wf : null,
  services: { studio: () => studios }, onRunEnd: run => studios.onRunEnd(run), versions: { snapshot: async () => null } })
const finish = async id => {
  for (let n = 0; n < 100 && ['queued', 'running'].includes(engine.get(id).status); n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(engine.get(id).status, 'done')
}
try {
  const d = defineStudio(declaration('files-one')), coll = d.collections.projects
  assert.equal(coll.fields.find(f => f.name === 'footage').multiple, true)
  assert.deepEqual(checkRecord(coll, { title: 'Files', footage: 'm1', reference: ['m2'] }).footage, ['m1'])
  for (const footage of [4, [{}], ['https://example.org/movie.mp4']]) assert.throws(() => checkRecord(coll, { title: 'Files', footage }), e => e.code === 'badValue')
  studios.register(d); studios.register(declaration('files-two'))

  const first = Buffer.from('first video bytes'), second = Buffer.from('second video bytes'), pdf = Buffer.from('%PDF fixture'), png = Buffer.from([137, 80, 78, 71])
  const a = studios.addMaterial('files-one', '剪辑.mp4', first)
  const b = studios.addMaterial('files-one', '剪辑.mp4', second)
  const reference = studios.addMaterial('files-one', 'brief.pdf', pdf)
  const cover = studios.addMaterial('files-one', 'cover.png', png)
  const record = studios.put('files-one', 'projects', { title: 'Mapped attachments', footage: [a.id, b.id], reference: reference.id, cover: cover.id })
  const run = await studios.start('files-one', 'create', record.id)
  await finish(run.id)
  const attachments = engine.get(run.id).subject.attachments
  assert.deepEqual(engine.get(run.id).subject.fields, {}, 'material IDs are not leaked into workflow form values')
  assert.deepEqual(attachments.map(a => [a.name, a.field, a.mime]), [
    ['剪辑.mp4', 'sources', 'video/mp4'], ['剪辑.mp4', 'sources', 'video/mp4'], ['brief.pdf', 'reference', 'application/pdf'], ['cover.png', 'cover', 'image/png'],
  ])
  assert.equal(new Set(attachments.map(a => a.path)).size, 4, 'duplicate filenames keep separate run copies')
  for (const [i, bytes] of [first, second, pdf, png].entries()) assert.deepEqual(readFileSync(attachments[i].path), bytes)
  studios.removeMaterial('files-one', a.id)
  assert.deepEqual(readFileSync(attachments[0].path), first, 'removing a library material does not destroy the started run copy')
  assert.equal(studios.get('files-one', 'projects', record.id).status, 'done')

  const foreign = studios.addMaterial('files-two', 'private.mp4', Buffer.from('other studio'))
  for (const [label, ids] of [['removed', [a.id]], ['foreign', [foreign.id]], ['missing', ['not-a-material']]]) {
    const bad = studios.put('files-one', 'projects', { title: label, footage: ids })
    const before = store.list('run').length
    await assert.rejects(studios.start('files-one', 'create', bad.id), e => e.code === 'noMaterial')
    assert.equal(store.list('run').length, before)
    assert.equal(studios.get('files-one', 'projects', bad.id).status, 'idea', 'invalid attachment cannot partially start its record')
  }
  const noFiles = studios.put('files-one', 'projects', { title: 'Required files absent', reference: reference.id })
  await assert.rejects(studios.start('files-one', 'create', noFiles.id), /attach at least one file/)
  assert.equal(studios.get('files-one', 'projects', noFiles.id).status, 'idea')
  const tooMany = studios.put('files-one', 'projects', { title: 'Attachment cap', footage: Array(21).fill(b.id) })
  await assert.rejects(studios.start('files-one', 'create', tooMany.id), /at most 20 attachments/)
  assert.equal(studios.get('files-one', 'projects', tooMany.id).status, 'idea')
  console.log('studio files: declarations → own-material lookup → real engine copies/field mapping; duplicate names, image compatibility, isolation, missing files and count limits passed')
} finally { engine.dispose(); studios.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
