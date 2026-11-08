// Real Workbench + Studio + media rendering with a local Agent Hub fixture. Manual assembly never
// asks an agent; one assisted fixture exercises disclosure delivery without contacting a remote service.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, inject } from './index.js'
import { pluginContext } from './test-context.mjs'
import { command, dependencies } from './lib/media.js'
import { readJson } from './lib/files.js'

try { await dependencies() } catch (e) { if (e.code === 'missingDependency') { console.log(`video engine: SKIPPED — ${e.message}`); process.exit(0) } throw e }
const tmp = mkdtempSync(join(tmpdir(), 'ruyix-video-engine-'))
process.env.RUYIX_WORKBENCH_HOME = join(tmp, 'home')
const { createWorkbench } = await import('@ruyix/workbench')
const { toolsPost } = await import('../../core/workbench/lib/mcp-client.mjs')
const { createStudios } = await import('../../core/plugins/studio/index.js')
let wb, taskId = 0, jobId = 0, allowAssisted = false
const tasks = new Map(), jobs = new Map()
const studios = createStudios({ home: join(tmp, 'studios'), workbench: () => wb?.service }).studios
const hub = {
  agents: () => [{ id: 'sonnet', runtime: 'claude' }, { id: 'codex', runtime: 'codex' }], agent: id => ({ id, runtime: 'claude' }), defaultAgent: () => null,
  ensureAgents() {}, registerSkillPack: () => () => {}, registerAgentUses: () => () => {}, registerSkillUses: () => () => {}, skillPackVersion: () => null, skills: async () => [],
  async startJob({ cwd }) { const job = { id: `video-job-${++jobId}`, leadId: 'lead', status: 'running', cwd }; jobs.set(job.id, job); return job }, job: id => jobs.get(id), finishJob() {}, stopJob() {},
  assign(id, { role, task }, extra) {
    assert.ok(allowAssisted, 'manual assembly must not invoke an agent')
    const t = { id: `video-task-${++taskId}`, role, task, status: 'running', runtime: 'claude', mcp: extra.mcp }
    t.done = new Promise(resolve => t.finish = resolve); tasks.set(t.id, t)
    setTimeout(async () => {
      try {
        writeFileSync(join(jobs.get(id).cwd, 'edit-notes.md'), '# Editing limitations\n\nThis deterministic test did not inspect the footage. The initial assembly is preserved for human review.\n')
        t.output = (await toolsPost(t.mcp.env.RUYIXWB_URL, t.mcp.env.RUYIXWB_TOKEN, '/call', { name: 'stage_result', args: { result: { summary: 'Initial assembly retained; footage was not inspected.' } } })).text
        t.status = 'done'
      } catch (e) { t.status = 'failed'; t.error = e.stack }
      t.finish(t)
    }, 1)
    return { ...t }
  },
  whenTaskDone: id => tasks.get(id).done, task: () => undefined, cancelTask: id => { tasks.get(id).status = 'cancelled' },
}
const routes = {}, connection = { fetch: { register: route => { routes[route.path] = route } } }
const conns = { env: async () => ({}), require: () => () => {}, needs: () => [], list: async () => [] }
const ctx = {
  logger: { warn() {}, info() {}, debug() {} }, provide(k, v) { this[`_${k}`] = v },
  inject: (deps, fn) => fn({ ...Object.fromEntries(deps.map(d => [d, { agentHub: hub, connectors: conns, ruyixStudio: studios, ruyixWorkbench: wb?.service, ruyixShell: { part: () => () => {} } }[d]])), connection, effect: fn => fn() }),
  sessionController: { modelCatalog: async () => ({ providers: [] }) }, sessionProjections: { register: () => () => {}, snapshot: () => ({ values: {} }) },
  llm: null, agents: { list: () => [], get: () => null }, effect: fn => fn(), on() {}, connection,
}
const until = async (label, check) => {
  for (const end = Date.now() + 20000; Date.now() < end;) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(`Timed out: ${label}; ${JSON.stringify(wb.store.list('run').map(r => ({ status: r.status, stages: r.stages.map(s => [s.key, s.status, s.note]) })))}`)
}
const op = async (name, args = {}) => {
  const response = await routes['/api/ruyix-workbench'].fetch(new Request('http://local/api/ruyix-workbench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: name, ...args }) }))
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.error), { code: data.code })
  return data
}
try {
  await command('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(tmp, 'footage.mp4')])
  wb = createWorkbench(ctx, { home: join(tmp, 'home'), toolbox: null, browsers: { list: () => [], closeRun: async () => {}, dispose: async () => {} }, engineOptions: { settleMs: 10, resumeDelayMs: 1e9 } })
  apply(pluginContext({ connection, ruyixWorkbench: wb.service, ruyixStudio: studios }, inject))
  const project = studios.put('video', 'projects', { title: 'A verified video', sourceFolder: tmp, sourcePaths: 'footage.mp4', targetSeconds: '1', assisted: false })
  const created = await studios.start('video', 'edit', project.id)
  const cardAt = stage => until(stage, () => wb.store.list('approval').find(a => a.runId === created.id && a.payload?.stage === stage && a.status === 'pending'))
  const accept = async (card, expected) => {
    const data = await op('video.timeline', { run: created.id })
    const media = card.payload.stage === 'final-review' ? data.export : card.payload.stage === 'preview-review' ? data.preview : null
    const approved = await wb.engine.approve(card.id, { choice: card.payload.options.findIndex(o => o.action === 'accept'), videoDigest: data.digest, videoArtifactSha256: media?.sha256 || null })
    assert.equal(approved.status, 'done', `${expected}: ${approved.error}`)
  }
  const review = await cardAt('review')
  assert.equal(studios.get('video', 'projects', project.id).status, 'editing')
  assert.ok(!wb.engine.get(created.id).video.preview)
  const notViewed = await wb.engine.approve(review.id, { choice: review.payload.options.findIndex(o => o.action === 'accept') })
  assert.equal(notViewed.status, 'failed', 'acceptance requires the actually seen edit digest')
  const current = await op('video.timeline', { run: created.id })
  // A raw Viewer edit holds the same pack lease as a timeline save, before its versioned write.
  const versionEdit = wb.engine.versions.edit
  let enterRaw, finishRaw
  const enteredRaw = new Promise(resolve => enterRaw = resolve), heldRaw = new Promise(resolve => finishRaw = resolve)
  wb.engine.versions.edit = async (...args) => { enterRaw(); await heldRaw; return versionEdit(...args) }
  const rawTimeline = { ...current.timeline, title: 'Saved in the raw Viewer' }
  const raw = wb.engine.editFile(created.id, { path: 'timeline.json', content: JSON.stringify(rawTimeline) })
  try {
    await enteredRaw
    await assert.rejects(op('video.saveTimeline', { run: created.id, timeline: current.timeline, expectedDigest: current.digest }), { code: 'changedMeanwhile' })
    // (the engine's own edit hold refuses first — runBusy — or the pack's lease: either way nothing restarts)
    await assert.rejects(wb.engine.continueRun(created.id, { from: 'plan' }), e => ['runBusy', 'changedMeanwhile'].includes(e.code), 'restarting cannot race the raw edit')
  } finally { finishRaw() }
  await raw
  wb.engine.versions.edit = versionEdit
  assert.equal(readJson(wb.engine.get(created.id), 'timeline.json').title, rawTimeline.title)
  await assert.rejects(op('video.saveTimeline', { run: created.id, timeline: current.timeline, expectedDigest: current.digest }), { code: 'changedMeanwhile' })
  const currentAfterRaw = await op('video.timeline', { run: created.id })
  let checkedBlob = false
  wb.engine.versions.edit = async (run, path, content, options) => {
    assert.equal(options.blob, (await wb.engine.versions.show(run, 'WORK', path)).blob, 'the save carries its base into the serialized version CAS')
    checkedBlob = true
    return versionEdit(run, path, content, options)
  }
  const timeline = { ...currentAfterRaw.timeline, output: { ...currentAfterRaw.timeline.output, width: 320, height: 180 }, captions: [{ id: 'caption-one', start: 0.1, end: 0.8, text: 'Line one\n\nLine two' }] }
  await op('video.saveTimeline', { run: created.id, timeline, expectedDigest: currentAfterRaw.digest })
  assert.ok(checkedBlob); wb.engine.versions.edit = versionEdit
  const playback = await routes['/api/ruyix-video/source'].fetch(new Request(`http://local/api/ruyix-video/source?run=${created.id}&source=source-1`, { headers: { range: 'bytes=0-99' } }))
  assert.equal(playback.status, 206); assert.equal((await playback.arrayBuffer()).byteLength, 100)
  const refused = await routes['/api/ruyix-video/source'].fetch(new Request(`http://local/api/ruyix-video/source?run=${created.id}&source=../../private`))
  assert.equal(refused.status, 409)
  await accept(review, 'timeline review')
  const previewReview = await cardAt('preview-review')
  const previewRun = wb.engine.get(created.id)
  assert.ok(previewRun.video.preview.seq); assert.ok(!previewRun.video.export)
  await accept(previewReview, 'preview review')
  const finalReview = await cardAt('final-review')
  const rendered = wb.engine.get(created.id), artifact = wb.store.evidenceAt(created.id, rendered.video.export.seq)
  assert.equal(artifact.sha256, rendered.video.export.sha256)
  assert.equal(readJson(rendered, `${rendered.video.export.name}.manifest.json`).qa.fullDecode, true)
  assert.equal(studios.get('video', 'projects', project.id).status, 'editing', 'rendering alone does not approve a deliverable')
  const movie = await routes['/api/ruyix-workbench/file'].fetch(new Request(`http://local/api/ruyix-workbench/file?run=${created.id}&seq=${rendered.video.export.seq}`, { headers: { range: 'bytes=0-255' } }))
  assert.equal(movie.status, 206); assert.match(movie.headers.get('content-type'), /video\/mp4/); assert.equal((await movie.arrayBuffer()).byteLength, 256)
  const captions = await routes['/api/ruyix-workbench/file'].fetch(new Request(`http://local/api/ruyix-workbench/file?run=${created.id}&seq=${rendered.video.export.captionSeq}`))
  assert.match(captions.headers.get('content-type'), /text\/vtt/)
  assert.match(await captions.text(), /Line one\nLine two/, 'blank caption lines cannot terminate the cue early')
  for (const suffix of ['.vtt', '.manifest.json']) {
    const path = rendered.video.export.name + suffix, before = readFileSync(join(rendered.dir, path), 'utf8')
    await assert.rejects(op('editFile', { id: created.id, path, content: 'A misleading change to a rendered output' }), /read-only.*timeline.json/)
    assert.equal(readFileSync(join(rendered.dir, path), 'utf8'), before, 'a refusal does not alter the output')
  }
  await accept(finalReview, 'final review')
  const done = await until('finished video run', () => { const r = wb.engine.get(created.id); return ['done', 'failed'].includes(r.status) && r })
  assert.equal(done.status, 'done', JSON.stringify(done.stages))
  assert.equal(studios.get('video', 'projects', project.id).status, 'ready')
  assert.ok((await wb.service.report(created.id)).includes('done'))
  assert.equal((await wb.store.verifyAsync(created.id)).ok, true)
  assert.match(await wb.service.report(created.id), /verified/)
  assert.equal(wb.store.list('approval').filter(a => a.runId === created.id && a.status === 'done').length, 3)
  assert.equal(tasks.size, 0, 'manual mode stayed independent of model access')

  // Continuing directly to preview review must approve the preview even when a final export remains.
  const previousExport = done.video.export.sha256
  await op('continueRun', { id: created.id, from: 'preview-review' })
  const repeatedPreview = await cardAt('preview-review')
  assert.equal(wb.engine.get(created.id).video.export.sha256, previousExport)
  await accept(repeatedPreview, 'continued preview review')
  await accept(await cardAt('final-review'), 'continued final review')
  await until('continued preview completes', () => wb.engine.get(created.id).status === 'done')

  const exportCount = () => wb.store.evidence(created.id).filter(e => /^exports\/.*\.mp4$/.test(e.title || '') && !/preview/.test(e.title)).length
  const finishRevision = async () => {
    await accept(await cardAt('review'), 'revised timeline')
    await accept(await cardAt('preview-review'), 'revised preview')
    await accept(await cardAt('final-review'), 'revised final')
    await until('revision completes', () => wb.engine.get(created.id).status === 'done')
  }
  const beforeTaskRevision = exportCount(), revisionRequest = 'Cut the introduction shorter and review the new timing.'
  assert.equal(beforeTaskRevision, 2, 'both completed exports are recorded in the ledger')
  const task = wb.store.get('task', done.taskId)
  await op('taskRevise', { id: done.taskId, run: created.id, expect: task.resultVersion, text: revisionRequest })
  await cardAt('review')
  assert.ok(wb.engine.get(created.id).guidance.some(g => g.stage === 'plan' && g.text.includes(revisionRequest)))
  assert.equal(exportCount(), beforeTaskRevision, 'task revision cannot export before the edit is reviewed')
  assert.equal(wb.engine.get(created.id).video.export, null)
  await finishRevision()

  const results = await op('resultsOf', { id: created.id }), comment = 'Please revise the last cut and keep the speech intact.'
  assert.equal(results.defaultFrom, 'plan'); assert.ok(!results.steps.some(s => s.key === 'export'))
  await op('resultsSave', { id: created.id, revision: results.revision, comments: [{ id: 'c1', text: comment }] })
  await assert.rejects(op('resultsRestart', { id: created.id, from: 'export' }), { code: 'noStage' })
  assert.equal(wb.engine.get(created.id).results.comments[0].status, 'open', 'rejected destination retains the comment')
  const beforeResultsRevision = exportCount()
  await op('resultsRestart', { id: created.id })
  await cardAt('review')
  assert.ok(wb.engine.get(created.id).guidance.some(g => g.stage === 'plan' && g.text.includes(comment)))
  assert.equal(exportCount(), beforeResultsRevision, 'Results defaults to an editable stage, with no silent re-export')
  assert.equal(wb.engine.get(created.id).results.comments[0].sentTo, 'plan')
  await finishRevision()

  allowAssisted = true
  const assistedProject = studios.put('video', 'projects', { title: 'Assisted notes fixture', sourceFolder: tmp, sourcePaths: 'footage.mp4', targetSeconds: '1', assisted: true })
  const assisted = await studios.start('video', 'edit', assistedProject.id)
  await until('assisted timeline review', () => wb.store.list('approval').find(a => a.runId === assisted.id && a.payload?.stage === 'review' && a.status === 'pending'))
  const reviewed = await op('reviewOf', { id: assisted.id, stage: 'review' })
  assert.ok(reviewed.review.files.includes('edit-notes.md'), 'the actual review exposes the uninspected-footage disclosure')
  console.log('video engine: real Studio/FFmpeg lifecycle, raw-save CAS and lease, read-only outputs, gate-specific resumed preview, Tasks/Results revisions, assisted disclosures, streamed verified report: ok')
} finally {
  wb?.engine.dispose(); studios.close(); rmSync(tmp, { recursive: true, force: true })
}
// The minimal plugin host does not own a disposable MCP server lifecycle.
process.exit(0)
