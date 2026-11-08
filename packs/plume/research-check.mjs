import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { researchSources, checkResearchNotes } from './lib/research.js'
import { accountFromSettings, studio } from './studio.js'
import { createPack } from './pack.js'
assert.ok(accountFromSettings({ style: { language: 'English' } }), 'a language-only legacy persona is migrated')
assert.ok(accountFromSettings({ accounts: { x: 'custom-x' } }), 'a connection-only legacy persona is migrated')
assert.equal(accountFromSettings({}), null)
assert.deepEqual(studio.start[0].allowedStatuses, ['idea'])
assert.equal(studio.start[0].showForm, true)
const sources = researchSources([{ title: 'Original release', url: 'https://example.org/news?utm_source=feed#section', evidence: 'Directly observed release notes' }])
assert.equal(sources[0].url, 'https://example.org/news')
assert.throws(() => researchSources([{ title: 'A', url: 'https://example.org/?a=1&b=2' }, { title: 'B', url: 'https://example.org/?b=2&a=1#x' }]), /duplicate/)
assert.throws(() => researchSources([{ title: 'A', url: 'javascript:alert(1)' }]), /HTTP/)
assert.throws(() => researchSources([{ title: 'A', url: 'https://secret:password@example.org' }]), /credentials/)
assert.throws(() => researchSources([]), /actually read/)
const notes = '# Findings\n\nThe release adds a documented feature [1]. Its actual availability and practical limitations need verification in the product.\n\n## Sources\n[1] Original release — https://example.org/news'
assert.equal(checkResearchNotes(notes, sources), true)
assert.throws(() => checkResearchNotes(notes.replaceAll('[1]', '[2]'), sources), /valid/)
assert.throws(() => checkResearchNotes('', sources), /research.md/)
const dir = mkdtempSync(join(tmpdir(), 'ruyix-plume-research-'))
try {
  const research = createPack().workflows.post.stages.find(s => s.key === 'research')
  assert.throws(() => research.validate({ summary: 'Claimed research', sources }, { run: { dir } }), /research.md/)
  writeFileSync(join(dir, 'research.md'), notes)
  research.validate({ summary: 'Read original source', sources }, { run: { dir } })
  const draft = createPack().workflows.post.stages.find(s => s.key === 'draft')
  writeFileSync(join(dir, 'draft.md'), '# A draft')
  assert.throws(() => draft.validate({ keyPoints: ['A'] }, { run: { dir } }), /outline.md/)
  writeFileSync(join(dir, 'outline.md'), '# Reader questions and sources')
  draft.validate({ keyPoints: ['A'] }, { run: { dir } })
  const skipped = await research.run({ run: { subject: { fields: { research: false } } } })
  assert.equal(skipped.skip, true)
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('plume research check: ok')
