import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definePack } from '../../core/workbench/pack.js'
import { checkInput } from '../../core/workbench/lib/subject.js'
import { defineStudio } from '../../core/plugins/studio/lib/declare.js'
import { createPack } from './pack.js'
import { studio } from './studio.js'
import { canonicalURL, edition, exportEdition, normalizeSources, pathIn, proseBlocks, readJSON, readText, renderHTML, renderMarkdown, renderPlain, sha256, validateAudit, writeJSON, writeText } from './lib/artifacts.js'

const root = mkdtempSync(join(tmpdir(), 'ruyix-newsletter-check-'))
const pack = definePack(createPack()), workflow = pack.workflows.issue
assert.deepEqual(checkInput(workflow.input), [])
assert.equal(defineStudio(studio).id, 'newsletter')
assert.equal(workflow.roles.auditor.access, 'read')
assert.equal(canonicalURL('https://example.org/news?utm_source=mail&b=2&a=1#top'), 'https://example.org/news?a=1&b=2')
assert.throws(() => canonicalURL('javascript:alert(1)'), /http/)
assert.throws(() => canonicalURL('https://secret:password@example.org'), /credentials/)

const draft = '# A useful product update\n\nThe documented release introduces a local preview and a review step before publication. [S1]\n\n## Why this matters\n\nFor an editor, this offers a practical opportunity to compare an issue with its sources before sharing it. [S1]\n'
const capture = 'Example Publisher release notes, retrieved from https://example.org/news. The documented release introduces a local preview and a review step before publication. The preview can be reviewed before sharing.'
const record = { title: 'Example release notes', url: 'https://example.org/news?utm_source=test', publisher: 'Example Publisher', kind: 'primary', publishedAt: '2026-10-01', accessedAt: new Date().toISOString(), evidencePath: 'research/sources/release.md', summary: 'The release introduces a preview and editorial review step.', quotes: ['The documented release introduces a local preview and a review step before publication.'] }
const auditOf = item => ({ summary: 'The cited claims match the captured release notes.', blocks: proseBlocks(item.draft).map(text => ({ text, classification: 'fact', sourceIds: ['S1'], verdict: 'supported', reason: 'This wording matches the retrieved release notes; the final paragraph is a qualified implication.' })), warnings: ['This is a deterministic fixture, not a live external research result.'] })
try {
  const run = { id: 'newsletter-fixture', dir: join(root, 'run'), subject: { title: 'Product newsletter', text: 'Write an evidence-backed update.', fields: {} }, stages: workflow.stages.map(s => ({ key: s.key, owner: s.owner, status: 'pending' })) }
  mkdirSync(run.dir)
  const evidence = [], cards = new Map(), calls = []
  let seq = 0, editedAtReview = false, reviewMode = 'accept', reviewBack = 'draft', unsupported = false
  const w = {
    run, workflow, pack, packSettings: pack.settings, stage: '',
    update(change) { this.run = typeof change === 'function' ? change(this.run) : { ...this.run, ...change } },
    evidence(item) { const entry = { ...item, seq: ++seq }; evidence.push(entry); return entry },
    writeReport() {},
    store: { list: () => [...cards.values()], get: (_kind, id) => cards.get(id), put: (_kind, value) => cards.set(value.id, value) },
    approval(spec) { const card = { ...spec, id: `approval-${cards.size}`, runId: this.run.id, status: 'pending' }; cards.set(card.id, card); return card },
    async sleep() {
      const card = [...cards.values()].find(c => c.status === 'pending')
      assert.ok(card, 'review must wait on a pending human card')
      assert.ok(!this.run.newsletter?.exports, 'no export while waiting for approval')
      if (reviewMode === 'edit' && !editedAtReview) { writeText(this.run, 'draft.md', readText(this.run, 'draft.md').replace('a practical opportunity', 'a useful opportunity')); editedAtReview = true }
      if (reviewMode === 'previewEdit') writeText(this.run, 'preview.html', readText(this.run, 'preview.html') + '<p>Changed only in the preview</p>')
      cards.set(card.id, { ...card, payload: { ...card.payload, from: reviewBack }, status: 'done', result: { option: reviewMode === 'revise' ? { label: 'Ask for changes', action: 'revise', from: 'draft' } : { label: 'Approve', action: 'accept' } } })
    },
    async agent(role, prompt) {
      calls.push({ role, prompt })
      let result = { summary: `Fixture ${role} completed` }
      if (role === 'researcher') {
        writeText(this.run, 'research/sources/release.md', capture)
        writeJSON(this.run, 'research/sources.json', [record, { ...record, url: 'https://example.org/news#top' }])
        writeText(this.run, 'research/brief.md', '# Research\n\nThe release notes establish the preview feature. No quantitative impact has been independently measured, so the issue will not claim a productivity increase. Two retrieved URL variants refer to the same source.\n')
      } else if (role === 'editor') writeText(this.run, 'outline.md', '# Outline\n\nExplain the preview feature and review gate in the release notes [S1], then distinguish the documented functionality from editorial interpretation.\n')
      else if (role === 'writer') {
        writeText(this.run, 'draft.md', draft)
        writeJSON(this.run, 'issue.json', { subject: 'A preview & a review', preheader: 'The documented release, with practical implications.', language: 'en' })
      } else {
        result = auditOf(edition(this.run))
        if (unsupported) result.blocks[0].verdict = 'unsupported'
      }
      workflow.stages.find(s => s.key === this.stage).validate(result, this)
      return { result }
    },
  }
  const stage = async key => {
    w.stage = key
    const def = workflow.stages.find(s => s.key === key), out = await def.run(w)
    w.update(r => ({ ...r, stages: r.stages.map(s => s.key === key ? { ...s, status: out.ok ? 'passed' : 'failed' } : s) }))
    return out
  }
  await stage('intake'); await stage('research')
  assert.equal(readJSON(w.run, 'research/sources.json').length, 1, 'tracking variants are deduplicated before citation IDs are assigned')
  assert.equal(readJSON(w.run, 'research/sources.json')[0].id, 'S1')
  assert.ok(evidence.some(e => e.title === 'research/sources/release.md' && e.full === capture), 'captured evidence is a durable artifact')
  await stage('outline'); await stage('draft')
  const item = edition(w.run)
  assert.throws(() => exportEdition(w), /approval/)
  assert.throws(() => validateAudit({ ...auditOf(item), blocks: [] }, item), /all 2 prose blocks/)
  const missingCitation = auditOf(item); missingCitation.blocks[0].sourceIds = []
  assert.throws(() => validateAudit(missingCitation, item), /every citation/)
  assert.equal((await stage('quality')).ok, true)
  assert.ok(readText(w.run, 'preview.html').includes('A preview &amp; a review'))
  const initialCards = cards.size
  writeText(w.run, 'preview.html', '<html>Stale preview</html>')
  assert.equal((await stage('review')).goto, 'quality', 'a stale preview cannot enter human review')
  assert.equal(cards.size, initialCards, 'no approval card is opened for stale derived HTML')
  assert.equal((await stage('quality')).ok, true)
  rmSync(join(w.run.dir, 'preview.html'))
  assert.equal((await stage('review')).goto, 'quality', 'a missing preview requires regeneration')
  assert.equal((await stage('quality')).ok, true)
  reviewMode = 'previewEdit'
  assert.equal((await stage('review')).goto, 'quality', 'editing only the preview cannot approve an export with different bytes')
  assert.equal(w.run.newsletter.approvedDigest, null)
  assert.equal((await stage('quality')).ok, true)
  assert.equal(readText(w.run, 'preview.html'), renderHTML(edition(w.run)))
  reviewMode = 'edit'
  assert.equal((await stage('review')).goto, 'quality', 'manual edits require a new audit and human review')
  assert.equal(w.run.newsletter.approvedDigest, null)
  assert.equal((await stage('quality')).ok, true)
  reviewMode = 'accept'
  assert.equal((await stage('review')).ok, true)
  const approvedPreview = readText(w.run, 'preview.html')
  writeText(w.run, 'preview.html', approvedPreview + '<p>Edited after approval</p>')
  assert.throws(() => exportEdition(w), /HTML preview changed after approval/)
  writeText(w.run, 'preview.html', approvedPreview)
  assert.equal((await stage('export')).ok, true)
  assert.equal(readText(w.run, 'exports/newsletter.html'), approvedPreview, 'export HTML exactly matches the reviewed generated preview')
  const manifest = readJSON(w.run, 'exports/manifest.json')
  assert.equal(manifest.delivery, 'not-sent')
  for (const f of manifest.files) assert.equal(sha256(readText(w.run, f.path)), f.sha256)
  assert.match(readText(w.run, 'exports/newsletter.md'), /https:\/\/example.org\/news/)
  assert.match(readText(w.run, 'exports/newsletter.html'), /id="source-S1"/)
  assert.ok(evidence.filter(e => e.title.startsWith('exports/')).length === 4)
  assert.ok(calls.some(c => c.role === 'researcher' && c.prompt.includes('never invent evidence')))
  const was = readText(w.run, 'draft.md')
  writeText(w.run, 'draft.md', was.replace('useful opportunity', 'another useful opportunity'))
  assert.throws(() => exportEdition(w), /changed after approval/)
  writeText(w.run, 'draft.md', was)
  writeText(w.run, record.evidencePath, capture + ' A changed source.')
  assert.throws(() => edition(w.run), /manifest or captured evidence changed/)
  writeText(w.run, record.evidencePath, capture)
  const originalSources = readJSON(w.run, 'research/sources.json')
  writeJSON(w.run, 'research/sources.json', originalSources.map(s => ({ ...s, url: 'https://other.example.org/forged' })))
  assert.throws(() => edition(w.run), /manifest or captured evidence changed/, 'a canonical URL change cannot rewrite the research snapshot')
  writeText(w.run, record.evidencePath, capture + ' Fabricated addition.')
  writeJSON(w.run, 'research/sources.json', originalSources.map(s => ({ ...s, evidenceSha256: sha256(capture + ' Fabricated addition.') })))
  assert.throws(() => edition(w.run), /manifest or captured evidence changed/, 'changing a capture and its hash together cannot rewrite the research snapshot')
  writeJSON(w.run, 'research/sources.json', originalSources)
  writeText(w.run, record.evidencePath, capture)
  assert.throws(() => normalizeSources([{ ...record, quotes: ['invented quote'] }], w.run), /exact evidence quotes/)
  assert.throws(() => normalizeSources([{ ...record, accessedAt: '2099-01-01T00:00:00Z' }], w.run), /future date/)
  for (const path of ['../escape.md', '.git/config', '/tmp/escape.md', 'research/../../x', 'research\\evil']) assert.throws(() => pathIn(w.run, path), /Unsafe/)
  const outside = join(root, 'outside'); mkdirSync(outside)
  symlinkSync(outside, join(w.run.dir, 'linked'))
  assert.throws(() => writeText(w.run, 'linked/escape.md', 'oops'), /inside/)
  symlinkSync(join(outside, 'missing'), join(w.run.dir, 'leaf.md'))
  assert.throws(() => writeText(w.run, 'leaf.md', 'oops'), /inside/)
  const hostile = { ...edition(w.run), metadata: { subject: '"><script>alert(1)</script>', preheader: '<img src=x onerror=alert(1)>', language: 'en" onload="alert(1)' } }
  assert.ok(!/<script|<img|"\sonload="/.test(renderHTML(hostile)), 'metadata is escaped into inert text/attributes')
  const hostileTitle = '<img src=x onerror=alert(1)> [click](javascript:alert(1)) **not bold** & source'
  const hostileSource = { ...item, sources: item.sources.map(source => ({ ...source, title: hostileTitle })) }
  const safeMarkdown = renderMarkdown(hostileSource)
  assert.ok(!safeMarkdown.includes('<img'), 'source title cannot inject raw HTML into Markdown')
  assert.ok(!safeMarkdown.includes('[click](javascript:'), 'source title cannot inject a Markdown link')
  assert.ok(safeMarkdown.includes('\\[click\\]\\(javascript:alert'), 'link syntax is represented as literal label text')
  assert.ok(safeMarkdown.includes('&lt;img'), 'HTML title remains visible as escaped label text')
  assert.ok(renderPlain(hostileSource).includes(hostileTitle), 'plain text preserves source labels without Markdown escape artifacts')
  writeText(w.run, 'draft.md', '# Title\n\n## ' + 'Only a heading '.repeat(10) + '[S1]\n')
  assert.throws(() => edition(w.run), /substantive prose/)
  assert.throws(() => validateAudit({ summary: 'checked', blocks: [], warnings: [] }, { ...item, draft: '# Title\n' }), /substantive prose/)
  writeText(w.run, 'draft.md', was + '\n<script>alert(1)</script>\n')
  assert.throws(() => edition(w.run), /raw HTML/)
  writeText(w.run, 'draft.md', was)
  const compact = '# Title\nA factual paragraph with no blank line after its title. [S1]\n#### Detail\n- First supported fact. [S1]\n- Second supported fact. [S1]\n##### More detail\n1. Another supported fact. [S1]\n###### Conclusion\nA final paragraph. [S1]\n'
  const compactItem = { ...item, draft: compact }
  assert.deepEqual(proseBlocks(compact), ['A factual paragraph with no blank line after its title. [S1]', '- First supported fact. [S1]\n- Second supported fact. [S1]', '1. Another supported fact. [S1]', 'A final paragraph. [S1]'])
  const compactHTML = renderHTML(compactItem)
  for (const tag of ['h1', 'h4', 'h5', 'h6', 'ul', 'ol']) assert.match(compactHTML, new RegExp(`<${tag}[ >]`))
  assert.equal(validateAudit(auditOf(compactItem), compactItem).passed, true)
  const omittedList = auditOf(compactItem); omittedList.blocks.splice(1, 1)
  assert.throws(() => validateAudit(omittedList, compactItem), /all 4 prose blocks/)
  mkdirSync(join(w.run.dir, 'attachments'))
  const attachmentPath = join(w.run.dir, 'attachments', 'source.md')
  writeFileSync(attachmentPath, capture)
  w.run.subject.attachments = [{ artifact: `${w.run.id}/a1-source.md`, path: attachmentPath, name: 'source.md', sha256: sha256(capture) }]
  const { url: _url, ...documentRecord } = record
  documentRecord.attachment = w.run.subject.attachments[0].artifact
  const documents = normalizeSources([documentRecord, documentRecord], w.run)
  assert.equal(documents.length, 1, 'duplicate document references collapse to one citation')
  assert.equal(documents[0].documentSha256, sha256(capture))
  assert.equal(documents[0].url, undefined, 'supplied material never invents a public URL')
  const documentItem = { ...item, sources: documents }
  for (const render of [renderHTML, renderPlain, renderMarkdown]) {
    assert.match(render(documentItem), /source\.md|source\\\.md/)
    assert.ok(render(documentItem).includes(sha256(capture)))
    assert.ok(!render(documentItem).includes('href="undefined"'))
  }
  assert.throws(() => normalizeSources([{ ...record, attachment: documentRecord.attachment }], w.run), /either url or attachment/)
  assert.throws(() => normalizeSources([{ ...documentRecord, attachment: '../../other' }], w.run), /Unknown source attachment/)
  writeFileSync(attachmentPath, capture + ' Changed')
  assert.throws(() => normalizeSources([documentRecord], w.run), /changed since intake/)
  rmSync(attachmentPath)
  symlinkSync(join(outside, 'external.md'), attachmentPath)
  writeFileSync(join(outside, 'external.md'), capture)
  assert.throws(() => normalizeSources([documentRecord], w.run), /inside the run/)
  rmSync(attachmentPath)
  writeFileSync(attachmentPath, capture)
  unsupported = true
  const exhaustRepairs = async () => {
    assert.equal((await stage('quality')).goto, 'draft')
    await stage('draft')
    assert.equal((await stage('quality')).goto, 'draft')
    await stage('draft')
    assert.equal((await stage('quality')).verdict, 'failed', 'automatic draft/quality loops remain bounded at two repairs')
    assert.equal(w.run.newsletter.repairAttempts, 3)
    assert.throws(() => exportEdition(w), /approval|unsupported/)
  }
  await exhaustRepairs()
  unsupported = false
  assert.equal((await stage('quality')).ok, true)
  reviewMode = 'revise'
  assert.equal((await stage('review')).goto, 'draft')
  assert.equal(w.run.newsletter.repairAttempts, 0, 'a new human-requested rewrite has a fresh repair budget')
  await stage('draft')
  unsupported = true
  await exhaustRepairs()
  for (const back of ['outline', 'quality']) {
    // A human can choose any prior stage in the shared review card's actual payload.from selector.
    unsupported = false
    assert.equal((await stage('quality')).ok, true)
    reviewMode = 'revise'; reviewBack = back
    assert.equal((await stage('review')).goto, back)
    assert.equal(w.run.newsletter.repairAttempts, 0, `human send-back to ${back} starts a new repair budget`)
    if (back === 'outline') { await stage('outline'); await stage('draft') }
    unsupported = true
    await exhaustRepairs()
  }
  unsupported = false
  assert.equal((await stage('quality')).ok, true)
  reviewMode = 'edit'; editedAtReview = false
  assert.equal((await stage('review')).goto, 'quality')
  assert.equal(w.run.newsletter.repairAttempts, 0, 'manually edited content starts a new audit round')
  unsupported = true
  await exhaustRepairs()
  w.update(r => ({ ...r, resumedAt: Date.now() }))
  await exhaustRepairs()
  // Pack defense independent of the engine's restart-card retirement: only this audited review round may accept.
  unsupported = false; reviewMode = 'accept'
  await stage('quality'); await stage('review')
  for (const legacy of [false, true]) {
    const old = [...cards.values()].at(-1), priorDigest = edition(w.run).digest
    cards.set(old.id, { ...old, applied: false, result: { ...old.result, applied: false } })
    if (legacy) w.update(r => { const { reviewDigest, ...newsletter } = r.newsletter; return { ...r, newsletter } })
    else writeText(w.run, 'draft.md', readText(w.run, 'draft.md').replace('# A useful product update', '# A revised product update'))
    await stage('quality') // the new audit/preview now match; this alone cannot rebind the older answer
    if (!legacy) assert.notEqual(edition(w.run).digest, priorDigest)
    const count = cards.size
    assert.equal((await stage('review')).ok, true)
    assert.equal(cards.size, count + 1, legacy ? 'a legacy answer without a digest requires a new human card' : 'a rewritten and re-audited issue cannot consume an older Accept')
    assert.equal(cards.get(old.id).applied, true)
    assert.equal(w.run.newsletter.reviewDigest, edition(w.run).digest)
  }
  console.log('newsletter: evidence, complete audit, digest-bound approval, re-review, exports, safe paths, and bounded repair checks passed')
} finally { rmSync(root, { recursive: true, force: true }) }
