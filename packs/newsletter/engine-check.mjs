// Real workbench engine + Studio lifecycle; deterministic agent fixtures only, no live research.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPack } from './pack.js'
import { studio } from './studio.js'
import { edition, proseBlocks, readJSON, readText, writeJSON, writeText } from './lib/artifacts.js'
const tmp = mkdtempSync(join(tmpdir(), 'ruyix-newsletter-engine-'))
process.env.RUYIX_WORKBENCH_HOME = join(tmp, 'home')
const { createWorkbench } = await import('@ruyix/workbench')
const { toolsPost } = await import('../../core/workbench/lib/mcp-client.mjs')
const { createStudios } = await import('../../core/plugins/studio/index.js')
let wb, taskId = 0, jobId = 0
const tasks = new Map(), jobs = new Map(), audits = new Map(), failNextAudits = new Map(), writerPasses = new Map(), writerPrompts = new Map()
const disposers = []
const studios = createStudios({ home: join(tmp, 'studios'), workbench: () => wb?.service }).studios
studios.register(studio)
const hub = {
  agents: () => [{ id: 'sonnet', runtime: 'claude' }, { id: 'codex', runtime: 'codex' }], agent: id => ({ id, runtime: 'claude' }), defaultAgent: () => null,
  ensureAgents() {}, registerSkillPack: () => () => {}, registerAgentUses: () => () => {}, registerSkillUses: () => () => {}, skillPackVersion: () => null, skills: async () => [],
  async startJob({ cwd }) { const job = { id: `job-${++jobId}`, leadId: 'lead', status: 'running', cwd }; jobs.set(job.id, job); return job }, job: id => jobs.get(id),
  assign(id, { role, task }, extra) {
    const t = { id: `task-${++taskId}`, role, task, status: 'running', runtime: 'claude', mcp: extra.mcp }
    t.done = new Promise(resolve => { t.finish = resolve }); tasks.set(t.id, t)
    setTimeout(async () => { try { t.output = await fixture(t, jobs.get(id).cwd); t.status = 'done' } catch (e) { t.status = 'failed'; t.error = e.stack } t.finish(t) }, 1)
    return { ...t }
  },
  whenTaskDone: id => tasks.get(id).done, task: () => undefined, cancelTask: id => { tasks.get(id).status = 'cancelled' }, finishJob() {}, stopJob() {},
}
async function fixture(t, dir) {
  const run = wb.store.list('run').find(r => r.dir === dir)
  assert.ok(run, 'fixture is attached to a real run')
  let result = { summary: 'Deterministic fixture completed.' }
  if (t.role === 'researcher') {
    const quote = 'The release includes a local preview that editors can inspect before publishing.'
    writeText(run, 'research/sources/release.md', 'Fixture release notes at https://example.org/release. ' + quote + ' The release notes do not promise increased engagement.')
    const supplied = run.subject.attachments?.find(a => a.field === 'materials')
    if (run.subject.title === 'Supported fixture') {
      assert.ok(supplied, 'Studio materials reach the actual research run')
      assert.ok(t.task.includes(supplied.artifact), 'research can identify supplied document citations')
    }
    writeJSON(run, 'research/sources.json', [{ title: 'Release notes', ...(supplied ? { attachment: supplied.artifact } : { url: 'https://example.org/release' }), publisher: 'Example', kind: 'primary', publishedAt: null, accessedAt: new Date().toISOString(), evidencePath: 'research/sources/release.md', summary: 'A local editorial preview is available.', quotes: [quote] }])
    writeText(run, 'research/brief.md', '# Findings\n\nThe release notes document a local preview. The notes do not establish any improvement to engagement or readership, so the newsletter must avoid those unsupported implications. This is a local test fixture.\n')
  } else if (t.role === 'editor') writeText(run, 'outline.md', '# Outline\n\nExplain the new local preview [S1], its documented purpose and the limits of the available evidence. Do not infer any measured improvement to readership.\n')
  else if (t.role === 'writer') {
    writerPasses.set(run.id, (writerPasses.get(run.id) || 0) + 1)
    writerPrompts.set(run.id, t.task)
    writeText(run, 'draft.md', `# A local preview for editors · revision ${writerPasses.get(run.id)}\n\nThe release includes a local preview that editors can inspect before publishing, according to its release notes. [S1]\n\nThat documented feature gives editors a place to inspect the draft; it does not establish an increase in engagement. [S1]\n`)
    writeJSON(run, 'issue.json', { subject: 'A local editorial preview', preheader: 'What the release notes establish.', language: 'en' })
  } else {
    audits.set(run.id, (audits.get(run.id) || 0) + 1)
    const fail = run.subject.title === 'Unsupported fixture' || (failNextAudits.get(run.id) || 0) > 0
    if (failNextAudits.get(run.id)) failNextAudits.set(run.id, failNextAudits.get(run.id) - 1)
    result = { summary: 'All prose blocks checked against the fixture.', blocks: proseBlocks(edition(run).draft).map(text => ({ text, classification: 'fact', sourceIds: ['S1'], verdict: fail ? 'unsupported' : 'supported', reason: 'A deterministic audit outcome for the engine regression.' })), warnings: [] }
  }
  const out = await toolsPost(t.mcp.env.RUYIXWB_URL, t.mcp.env.RUYIXWB_TOKEN, '/call', { name: 'stage_result', args: { result } })
  return out.text
}
const conns = { env: async () => ({}), require: () => () => {}, needs: () => [], list: async () => [] }
const ctx = {
  logger: { warn() {}, info() {}, debug() {} }, provide(k, v) { this[`_${k}`] = v },
  inject: (deps, fn) => fn({ ...Object.fromEntries(deps.map(d => [d, { agentHub: hub, connectors: conns, ruyixStudio: studios, ruyixShell: { part: () => () => {} } }[d]])), effect: fn => fn() }),
  sessionController: { modelCatalog: async () => ({ providers: [] }) }, sessionProjections: { register: () => () => {}, snapshot: () => ({ values: {} }) },
  llm: null, agents: { list: () => [], get: () => null }, effect: fn => { const stop = fn(); if (typeof stop === 'function') disposers.push(stop); return stop }, on() {}, connection: { fetch: { register() {} } },
}
const until = async (label, check) => {
  for (const end = Date.now() + 20000; Date.now() < end;) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 20)) }
  throw new Error(`Timed out: ${label}; ${JSON.stringify(wb.store.list('run').map(r => ({ status: r.status, verdict: r.verdict, stages: r.stages.map(s => [s.key, s.status, s.note]) })))}`)
}
const openWorkbench = () => {
  wb = createWorkbench(ctx, { home: join(tmp, 'home'), toolbox: null, browsers: { list: () => [], closeRun: async () => {}, dispose: async () => {} }, engineOptions: { settleMs: 10, resumeDelayMs: 1e9 } })
  wb.registerPack(createPack())
}
const closeWorkbench = async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  // Let the disposed run's aborted wait unwind before reopening its persisted store.
  await new Promise(resolve => setTimeout(resolve, 30))
}
const restartAtReview = async title => {
  const idea = studios.put('newsletter', 'issues', { title })
  const run = await studios.start('newsletter', 'write', idea.id)
  const oldCard = await until('review before interruption', () => wb.store.list('approval').find(a => a.runId === run.id && a.payload?.stage === 'review' && a.status === 'pending'))
  await closeWorkbench(); openWorkbench()
  assert.equal(wb.engine.get(run.id).status, 'interrupted')
  return { idea, run, oldCard }
}
const freshReview = (run, previous) => until('fresh review after recovery', () => {
  const current = wb.engine.get(run.id)
  return wb.store.list('approval').find(a => a.runId === run.id && !previous.includes(a.id) && a.payload?.stage === 'review' && a.status === 'pending') || (['failed', 'done', 'cancelled'].includes(current.status) && current)
})
const saveReviewComment = (run, text) => {
  const { review } = wb.ops.reviewOf({ id: run.id, stage: 'review' })
  wb.ops.reviewSave({ id: run.id, stage: 'review', revision: review.commentsRevision, comments: [{ id: 'c1', file: 'draft.md', at: { lines: [3, 3] }, text }] })
}
try {
  openWorkbench()
  // A newer explicit rewrite supersedes answers given to the interrupted review, including Stop and send-back.
  for (const restart of ['taskRevise', 'continue']) for (const answer of ['accept', 'stop', 'revise']) {
    const { idea, run, oldCard } = await restartAtReview(`Interrupted ${answer} then ${restart}`)
    const beforeDigest = edition(wb.engine.get(run.id)).digest
    const oldNote = 'Obsolete card instruction: use a long opening.'
    const answered = await wb.engine.approve(oldCard.id, { choice: oldCard.payload.options.findIndex(o => o.action === answer), from: 'draft', comment: oldNote })
    assert.equal(answered.status, 'done', answered.error)
    assert.equal(answered.result.applied, false, 'the interrupted engine has not consumed the old answer')
    const note = `New ${restart} request: use a short opening and keep the source qualification.`
    if (restart === 'taskRevise') {
      const task = wb.store.get('task', run.taskId)
      await wb.ops.taskRevise({ id: run.taskId, run: run.id, expect: task.resultVersion, text: note })
    } else await wb.engine.continueRun(run.id, { from: 'draft', note })
    const gate = await freshReview(run, [oldCard.id])
    assert.equal(gate.action, 'decision', `${restart} after old ${answer} must wait for a new human review`)
    const current = wb.engine.get(run.id)
    assert.equal(current.status, 'waiting')
    assert.equal(current.newsletter.approvedDigest, null)
    assert.ok(!current.newsletter.exports)
    assert.notEqual(edition(current).digest, beforeDigest)
    assert.equal(writerPasses.get(run.id), 2, 'only the new explicit rewrite is performed')
    assert.equal(audits.get(run.id), 2)
    assert.ok(writerPrompts.get(run.id).includes(note), 'the latest rewrite request reaches the writer')
    assert.ok(!writerPrompts.get(run.id).includes(oldNote), 'a superseded card cannot reinject its older instruction')
    assert.equal(wb.store.get('approval', oldCard.id).applied, true)
    assert.equal(studios.get('newsletter', 'issues', idea.id).status, 'writing')
    await assert.rejects(wb.engine.approve(oldCard.id, { choice: 0 }), e => e.code === 'approvalDone')
    await wb.engine.approve(gate.id, { choice: gate.payload.options.findIndex(o => o.action === 'accept') })
    await until('new rewrite exports after its own approval', () => wb.engine.get(run.id).status === 'done')
    assert.equal(studios.get('newsletter', 'issues', idea.id).status, 'ready')
  }
  // An unchanged issue in an older store still needs a new gate if its accepted review has no digest binding.
  {
    const { idea, run, oldCard } = await restartAtReview('Legacy unbound acceptance')
    const saved = wb.engine.get(run.id), { reviewDigest, ...newsletter } = saved.newsletter
    wb.store.put('run', { ...saved, newsletter })
    await wb.engine.approve(oldCard.id, { choice: oldCard.payload.options.findIndex(o => o.action === 'accept') })
    wb.engine.resumeRun(run.id)
    const gate = await freshReview(run, [oldCard.id])
    assert.equal(gate.action, 'decision', 'an unbound legacy Accept cannot approve the current issue')
    assert.equal(wb.engine.get(run.id).newsletter.approvedDigest, null)
    assert.ok(!wb.engine.get(run.id).newsletter.exports)
    assert.equal(wb.engine.get(run.id).newsletter.reviewDigest, edition(wb.engine.get(run.id)).digest)
    assert.equal(studios.get('newsletter', 'issues', idea.id).status, 'writing')
    assert.equal(audits.get(run.id), 1, 'a valid audited issue needs a fresh human gate, not a redundant audit')
    await assert.rejects(wb.engine.approve(oldCard.id, { choice: 0 }), e => e.code === 'approvalDone')
    await wb.engine.approve(gate.id, { choice: gate.payload.options.findIndex(o => o.action === 'accept') })
    await until('legacy issue exports after its new approval', () => wb.engine.get(run.id).status === 'done')
  }
  const failedIdea = studios.put('newsletter', 'issues', { title: 'Unsupported fixture' })
  const failedRun = await studios.start('newsletter', 'write', failedIdea.id)
  const failed = await until('unsupported run terminates', () => { const r = wb.engine.get(failedRun.id); return ['done', 'failed', 'cancelled'].includes(r.status) && r })
  assert.equal(failed.status, 'failed', 'unsupported evidence must not produce a successful run')
  assert.equal(failed.verdict.level, 'failed')
  assert.equal(failed.newsletter.repairAttempts, 3)
  assert.equal(studios.get('newsletter', 'issues', failedIdea.id).status, 'idea', 'failed evidence must not mark the Studio issue ready')
  assert.ok(!failed.newsletter.exports)
  assert.equal(audits.get(failed.id), 3, 'initial audit plus two automatic repair audits')
  await wb.engine.continueRun(failed.id, { from: 'draft', note: 'Try a new editorial revision.' })
  const resumedFailure = await until('explicit revision exhausts its own repair budget', () => {
    const r = wb.engine.get(failed.id)
    return r.resumedAt && r.status === 'failed' && r
  })
  assert.equal(audits.get(failed.id), 6, 'explicit resume gets a new audit plus two repairs, then stops again')
  assert.equal(resumedFailure.newsletter.repairAttempts, 3)
  assert.equal(studios.get('newsletter', 'issues', failedIdea.id).status, 'idea')
  assert.ok(!resumedFailure.newsletter.exports)
  const material = studios.addMaterial('newsletter', 'release.md', Buffer.from('The release includes a local preview that editors can inspect before publishing. These supplied notes do not promise higher engagement.'))
  const goodIdea = studios.put('newsletter', 'issues', { title: 'Supported fixture', materials: [material.id] })
  const goodRun = await studios.start('newsletter', 'write', goodIdea.id)
  const card = await until('human approval gate', () => wb.store.list('approval').find(a => a.runId === goodRun.id && a.payload?.stage === 'review' && a.status === 'pending'))
  assert.equal(wb.engine.get(goodRun.id).status, 'waiting')
  assert.equal(studios.get('newsletter', 'issues', goodIdea.id).status, 'writing')
  assert.ok(!wb.engine.get(goodRun.id).newsletter.exports)
  const editing = wb.engine.get(goodRun.id), metadata = readJSON(editing, 'issue.json')
  writeText(editing, 'issue.json', '{ invalid JSON')
  const invalid = await wb.engine.approve(card.id, { choice: card.payload.options.findIndex(o => o.action === 'accept') })
  assert.equal(invalid.status, 'failed', 'an invalid manual edit must keep the approval editable')
  assert.match(invalid.error, /issue.json/)
  assert.equal(wb.engine.get(goodRun.id).status, 'waiting', 'a malformed edit must not terminate the run')
  assert.ok(!wb.engine.get(goodRun.id).newsletter.exports)
  writeJSON(editing, 'issue.json', metadata)
  writeText(editing, 'draft.md', readText(editing, 'draft.md').replace('The release includes', 'The documented release includes'))
  const approved = await wb.engine.approve(card.id, { choice: card.payload.options.findIndex(o => o.action === 'accept') })
  assert.equal(approved.status, 'done', approved.error)
  const revised = await until('edited issue gets a fresh audit and human gate', () => wb.store.list('approval').find(a => a.id !== card.id && a.runId === goodRun.id && a.payload?.stage === 'review' && a.status === 'pending'))
  assert.ok(!wb.engine.get(goodRun.id).newsletter.exports, 'an edit invalidates the previous approval')
  assert.equal(readJSON(wb.engine.get(goodRun.id), 'quality.json').digest, edition(wb.engine.get(goodRun.id)).digest)
  const finalApproval = await wb.engine.approve(revised.id, { choice: revised.payload.options.findIndex(o => o.action === 'accept') })
  assert.equal(finalApproval.status, 'done', finalApproval.error)
  const good = await until('approved export completes', () => { const r = wb.engine.get(goodRun.id); return ['done', 'failed'].includes(r.status) && r })
  assert.equal(good.status, 'done', JSON.stringify(good.stages))
  assert.equal(studios.get('newsletter', 'issues', goodIdea.id).status, 'ready')
  assert.equal(readJSON(good, 'exports/manifest.json').delivery, 'not-sent')
  assert.equal(good.newsletter.exports.length, 3)
  assert.match(readText(good, 'exports/newsletter.html'), /release\.md \(supplied document; SHA-256/)
  assert.equal(readJSON(good, 'research/sources.json')[0].documentSha256, good.subject.attachments[0].sha256)
  const completed = [good.id]
  const revisionRequest = 'Shorten the introduction and clarify its practical implication.'
  const digestBeforeRevision = edition(wb.engine.get(good.id)).digest
  const task = wb.store.get('task', good.taskId)
  await wb.ops.taskRevise({ id: good.taskId, run: good.id, expect: task.resultVersion, text: revisionRequest })
  const revisionGate = await until('task center revision returns to human review', () => {
    const fresh = wb.store.list('approval').find(a => a.runId === good.id && a.payload?.stage === 'review' && a.status === 'pending')
    const current = wb.engine.get(good.id)
    return fresh || (current.resumedAt && ['done', 'failed'].includes(current.status) && current)
  })
  assert.equal(revisionGate.action, 'decision', 'task-center revise must write and audit again, not re-export the old issue')
  assert.ok(writerPrompts.get(good.id).includes(revisionRequest), 'task-center guidance reaches the writer')
  assert.equal(wb.engine.get(good.id).newsletter.approvedDigest, null)
  assert.ok(!wb.engine.get(good.id).newsletter.exports)
  assert.notEqual(edition(wb.engine.get(good.id)).digest, digestBeforeRevision)
  const revisionApproval = await wb.engine.approve(revisionGate.id, { choice: revisionGate.payload.options.findIndex(o => o.action === 'accept') })
  assert.equal(revisionApproval.status, 'done', revisionApproval.error)
  await until('task-center revision exports only after new approval', () => wb.engine.get(good.id).status === 'done')
  assert.equal(wb.engine.get(good.id).newsletter.exports.length, 3)

  // A persisted gate answered during a restart cannot approve a later audit or automatic writer repair.
  for (const repair of [false, true]) {
    const idea = studios.put('newsletter', 'issues', { title: `Restart fixture ${repair ? 'with repair' : 'with re-audit'}` })
    const run = await studios.start('newsletter', 'write', idea.id)
    const oldCard = await until('review before shutdown', () => wb.store.list('approval').find(a => a.runId === run.id && a.payload?.stage === 'review' && a.status === 'pending'))
    const beforeDigest = edition(wb.engine.get(run.id)).digest
    await closeWorkbench()
    openWorkbench()
    assert.equal(wb.engine.get(run.id).status, 'interrupted', 'a new engine reopens the interrupted run from the same SQLite store')
    assert.equal(wb.store.get('approval', oldCard.id).status, 'pending', 'restart preserved the unanswered gate')
    await wb.engine.editFile(run.id, { path: 'draft.md', content: readText(wb.engine.get(run.id), 'draft.md').replace('The release includes', 'The documented release includes') })
    const editedDigest = edition(wb.engine.get(run.id)).digest
    assert.notEqual(editedDigest, beforeDigest)
    if (repair) failNextAudits.set(run.id, 1)
    if (repair) {
      const oldApproval = await wb.engine.approve(oldCard.id, { choice: oldCard.payload.options.findIndex(o => o.action === 'accept') })
      assert.equal(oldApproval.status, 'done', oldApproval.error)
      assert.ok(!wb.engine.get(run.id).newsletter.exports, 'answering during interruption alone cannot export')
    }
    wb.engine.resumeRun(run.id)
    if (!repair) {
      await until('old gate is superseded or wrongly still waiting', () => wb.store.get('approval', oldCard.id).applied || (wb.engine.get(run.id).status === 'waiting' && wb.engine.get(run.id).waitingFor === oldCard.id))
      await assert.rejects(wb.engine.approve(oldCard.id, { choice: oldCard.payload.options.findIndex(o => o.action === 'accept') }), e => e.code === 'approvalDone', 'a stale browser cannot approve the superseded gate')
    }
    const outcome = await until('a fresh review after restart or an erroneous early export', () => {
      const current = wb.engine.get(run.id)
      const fresh = wb.store.list('approval').find(a => a.runId === run.id && a.id !== oldCard.id && a.payload?.stage === 'review' && a.status === 'pending')
      return fresh || (['done', 'failed'].includes(current.status) && current)
    })
    assert.equal(outcome.action, 'decision', 'newly audited content must wait on a fresh human review card')
    assert.equal(wb.engine.get(run.id).status, 'waiting')
    assert.ok(!wb.engine.get(run.id).newsletter.exports)
    assert.equal(wb.engine.get(run.id).newsletter.approvedDigest, null)
    assert.equal(wb.store.get('approval', oldCard.id).applied, true, 'the previous gate is retired')
    assert.equal(audits.get(run.id), repair ? 3 : 2, 'the resumed content is independently re-audited')
    assert.equal(writerPasses.get(run.id), repair ? 2 : 1)
    if (repair) assert.notEqual(edition(wb.engine.get(run.id)).digest, editedDigest, 'the automatic repair produced a different issue')
    assert.equal(studios.get('newsletter', 'issues', idea.id).status, 'writing')
    const approved = await wb.engine.approve(outcome.id, { choice: outcome.payload.options.findIndex(o => o.action === 'accept') })
    assert.equal(approved.status, 'done', approved.error)
    await until('freshly approved issue exports', () => wb.engine.get(run.id).status === 'done')
    assert.equal(wb.engine.get(run.id).newsletter.exports.length, 3)
    assert.equal(studios.get('newsletter', 'issues', idea.id).status, 'ready')
    completed.push(run.id)
  }
  // Stop/reject are user intent, not permission to reuse an old edition. They must survive content invalidation.
  for (const answer of ['stop', 'reject']) {
    const { run, oldCard } = await restartAtReview(`Interrupted ${answer} fixture`)
    await wb.engine.editFile(run.id, { path: 'draft.md', content: readText(wb.engine.get(run.id), 'draft.md').replace('The release includes', 'The documented release includes') })
    if (answer === 'reject') wb.engine.reject(oldCard.id, 'Do not continue this issue.')
    else await wb.engine.approve(oldCard.id, { choice: oldCard.payload.options.findIndex(o => o.action === 'stop') })
    wb.engine.resumeRun(run.id)
    const outcome = await until('stop/reject ends without another audit', () => {
      const r = wb.engine.get(run.id)
      return ['failed', 'done', 'cancelled'].includes(r.status) ? r : wb.store.list('approval').find(a => a.runId === run.id && a.id !== oldCard.id && a.status === 'pending')
    })
    assert.equal(outcome.status, 'failed', `${answer} must be honored before re-auditing changed content`)
    assert.equal(audits.get(run.id), 1)
    assert.equal(writerPasses.get(run.id), 1)
    assert.ok(!outcome.newsletter.exports)
    assert.match(outcome.verdict.reason, answer === 'reject' ? /rejected by the person/ : /stopped by the person/)
  }
  for (const broken of ['issue', 'accepted-issue', 'quality', 'missing-quality']) {
    const { run, oldCard } = await restartAtReview(`Interrupted ${broken} fixture`)
    const metadata = readText(wb.engine.get(run.id), 'issue.json'), comment = 'Keep the qualification about engagement visible.'
    saveReviewComment(run, comment)
    if (broken === 'accepted-issue') await wb.engine.approve(oldCard.id, { choice: oldCard.payload.options.findIndex(o => o.action === 'accept') })
    if (broken === 'missing-quality') rmSync(join(wb.engine.get(run.id).dir, 'quality.json'))
    else await wb.engine.editFile(run.id, { path: broken.includes('issue') ? 'issue.json' : 'quality.json', content: '{ invalid JSON' })
    wb.engine.resumeRun(run.id)
    let gate = await freshReview(run, [oldCard.id])
    assert.equal(gate.action, 'decision', 'malformed recovery stays correctable instead of failing behind a stale card')
    assert.equal(wb.engine.get(run.id).status, 'waiting')
    assert.ok(wb.engine.get(run.id).reviews.review.comments.some(c => c.text === comment), 'unanswered annotations survive a replacement review card')
    await assert.rejects(wb.engine.approve(oldCard.id, { choice: 0 }), e => e.code === 'approvalDone')
    if (broken.includes('issue')) {
      const invalid = await wb.engine.approve(gate.id, { choice: gate.payload.options.findIndex(o => o.action === 'accept') })
      assert.equal(invalid.status, 'failed')
      assert.match(invalid.error, /issue.json/)
      assert.equal(wb.engine.get(run.id).status, 'waiting')
      assert.equal(audits.get(run.id), 1, 'a malformed issue does not spend an audit before it can be read')
      await wb.engine.editFile(run.id, { path: 'issue.json', content: metadata })
      const fixed = await wb.engine.approve(gate.id, { choice: gate.payload.options.findIndex(o => o.action === 'accept') })
      assert.equal(fixed.status, 'done', fixed.error)
      gate = await freshReview(run, [oldCard.id, gate.id])
      assert.equal(gate.action, 'decision', 'correcting the issue still requires a new audited approval')
    }
    assert.equal(audits.get(run.id), 2)
    assert.ok(!wb.engine.get(run.id).newsletter.exports)
    const approved = await wb.engine.approve(gate.id, { choice: gate.payload.options.findIndex(o => o.action === 'accept') })
    assert.equal(approved.status, 'done', approved.error)
    await until('recovered issue exports after fresh approval', () => wb.engine.get(run.id).status === 'done')
  }
  {
    const { run, oldCard } = await restartAtReview('Interrupted send-back fixture')
    const comment = 'Make the practical implication explicit without claiming engagement gains.'
    const typed = 'Keep the introduction short and retain the source citation.'
    saveReviewComment(run, comment)
    await wb.engine.editFile(run.id, { path: 'draft.md', content: readText(wb.engine.get(run.id), 'draft.md').replace('The release includes', 'The documented release includes') })
    await wb.engine.approve(oldCard.id, { choice: oldCard.payload.options.findIndex(o => o.action === 'revise'), from: 'draft', comment: typed })
    wb.engine.resumeRun(run.id)
    const gate = await freshReview(run, [oldCard.id])
    assert.equal(gate.action, 'decision')
    assert.equal(writerPasses.get(run.id), 2, 'the requested rewrite happens before asking for another review')
    assert.equal(audits.get(run.id), 2, 'send-back goes directly to the writer without a redundant pre-rewrite audit')
    assert.ok(writerPrompts.get(run.id).includes(comment), 'saved anchored comments reach the writer after restart')
    assert.ok(writerPrompts.get(run.id).includes(typed), 'the card text also reaches the writer after restart')
    assert.ok(wb.engine.get(run.id).decisions.some(d => d.id === oldCard.id && d.action === 'revise' && d.from === 'draft'))
    assert.ok(!wb.engine.get(run.id).newsletter.exports)
    await wb.engine.approve(gate.id, { choice: gate.payload.options.findIndex(o => o.action === 'accept') })
    await until('requested rewrite completes after review', () => wb.engine.get(run.id).status === 'done')
  }
  // Two distinct completed projects promote an explicit preference, consumed by plain and scheduled starts too.
  for (const id of completed.slice(0, 2)) {
    const target = studios.feedbackView('newsletter', id).targets.find(t => t.stage === '$final')
    studios.rate('newsletter', { run: id, stage: '$final', revision: target.revision, score: 5, choices: { tone: 'direct' }, note: 'Use direct language, with the evidence qualifiers intact.' })
  }
  assert.ok(studios.preferences('newsletter').rules.some(r => r.key === 'tone' && r.value === 'direct' && r.support === 2))
  for (const scheduled of [false, true]) {
    const request = { workflow: 'newsletter.issue', title: `${scheduled ? 'Scheduled' : 'Workbench'} preference fixture` }
    const { run } = scheduled
      ? await wb.ops.taskRunNow({ id: (await wb.ops.taskCreate({ ...request, schedule: { kind: 'every', minutes: 1440 } })).task.id })
      : await wb.ops.startRun(request)
    const linked = wb.engine.get(run.id)
    assert.deepEqual(linked.studio, { id: 'newsletter' }, 'a workflow started without a record still belongs to its unique Studio')
    assert.ok(linked.studioPreferences.rules.some(r => r.key === 'tone' && r.value === 'direct'))
    const gate = await until('recordless run reaches review', () => wb.store.list('approval').find(a => a.runId === run.id && a.payload?.stage === 'review' && a.status === 'pending'))
    assert.ok(writerPrompts.get(run.id).includes('General: tone = direct (2 confirmations'), 'the writer consumes the promoted preference snapshot')
    const view = studios.feedbackView('newsletter', run.id)
    assert.ok(view.runs.some(r => r.id === run.id), 'recordless runs appear in Studio feedback')
    const target = view.targets.find(t => t.stage === 'review')
    const rating = studios.rate('newsletter', { run: run.id, stage: target.stage, revision: target.revision, score: 4, note: 'The current issue is clear.' })
    assert.equal(rating.feedback.project, run.id, 'recordless ratings use the run as their project identity')
    assert.ok(!wb.engine.get(run.id).newsletter.exports)
    const approval = await wb.engine.approve(gate.id, { choice: gate.payload.options.findIndex(o => o.action === 'accept') })
    assert.equal(approval.status, 'done', approval.error)
    await until('recordless issue completes after approval', () => wb.engine.get(run.id).status === 'done')
  }
  console.log('newsletter engine: bounded repairs; restart-safe approval; 7 damaged-file/user-intent recovery cases; 6 explicit restart answer cases; legacy unbound acceptance; task-center revision; preferences and ratings on plain/scheduled starts; no automatic delivery')
} finally {
  await closeWorkbench(); studios.close()
  rmSync(tmp, { recursive: true, force: true })
}
// The minimal plugin host does not own a disposable MCP server lifecycle.
process.exit(0)
