// Pure contract checks for independent platform audits; the workflow gate is exercised in check.mjs.
import assert from 'node:assert/strict'
import { adaptationInput, adaptationPrompt, adaptationUnits, FIT_DIMENSIONS, fitHash, validateAdaptation } from './lib/adaptation.js'
import { knowledgeDigest, knowledgePrompt, snapshotKnowledge } from './lib/platform-knowledge.js'

const draft = '# Product note\n\nThe release has three themes.\n\nResults apply to the sample only.'
const fields = {
  title: 'Three themes', body: 'The release has three themes.\n\nResults apply to the sample only.',
  tags: ['product'], cover: { title: 'Three themes', subtitle: 'Sample scope' },
  cards: [{ heading: 'Scope', points: ['Results apply to the sample only.'] }],
}
const args = { platform: 'xhs', fields, draft, settings: { style: { guide: 'plain' }, brand: { accent: '#123456' } }, knowledge: { revision: 'v1' }, images: [{ name: 'card.png', sha256: 'abc' }] }
const item = adaptationInput(args)
const valid = () => ({
  summary: 'The platform version keeps the release themes and sample limitation.',
  checks: FIT_DIMENSIONS.map(dimension => ({ dimension, verdict: 'pass', reason: 'Inspected the supplied text and platform requirements.' })),
  units: item.units.map(unit => ({ ...unit, verdict: 'editorial', sourceExcerpt: '', reason: 'Fixture labels and connective text; no new world claim.' })),
})
let cases = 0
const test = (name, fn) => { fn(); cases++; console.log('adaptation: ' + name) }

test('all publishing surfaces are enumerated', () => {
  assert.deepEqual(item.units.map(u => u.id), ['title', 'body.0', 'body.1', 'tags.0', 'cover.title', 'cover.subtitle', 'cards.0.heading', 'cards.0.points.0'])
  assert.deepEqual(adaptationUnits('wechat_mp', { title: 'T', digest: 'D', author: 'A', body: 'First\n\nSecond' }).map(u => u.id), ['title', 'body.0', 'body.1', 'digest', 'author'])
  assert.deepEqual(adaptationUnits('x', { tweets: ['First', 'Second'] }).map(u => u.id), ['tweets.0', 'tweets.1'])
})
test('valid complete audit passes but ignores a claimed passed flag', () => {
  assert.equal(validateAdaptation(valid(), item).passed, true)
  const bad = valid(); bad.passed = true; bad.checks[0].verdict = 'fail'
  assert.equal(validateAdaptation(bad, item).passed, false)
})
test('failed dimensions and unsupported units block', () => {
  for (const dimension of FIT_DIMENSIONS) {
    const bad = valid(); bad.checks.find(c => c.dimension === dimension).verdict = 'fail'
    assert.equal(validateAdaptation(bad, item).passed, false)
  }
  const bad = valid(); bad.units.at(-1).verdict = 'unsupported'
  assert.equal(validateAdaptation(bad, item).passed, false)
})
test('every dimension exactly once with a concrete reason', () => {
  const missing = valid(); missing.checks.pop(); assert.throws(() => validateAdaptation(missing, item), /every adaptation dimension/)
  const duplicate = valid(); duplicate.checks[1].dimension = duplicate.checks[0].dimension; assert.throws(() => validateAdaptation(duplicate, item), /duplicate review dimension/)
  const unknown = valid(); unknown.checks[1].dimension = 'looks-good'; assert.throws(() => validateAdaptation(unknown, item), /review dimension/)
  const empty = valid(); empty.checks[0].reason = ' '; assert.throws(() => validateAdaptation(empty, item), /nonempty text/)
  const oversized = valid(); oversized.checks[0].reason = 'x'.repeat(2001); assert.throws(() => validateAdaptation(oversized, item), /at most/)
})
test('every text unit verbatim and in order', () => {
  const missing = valid(); missing.units.pop(); assert.throws(() => validateAdaptation(missing, item), /every exact publishing text unit/)
  const wrong = valid(); wrong.units[0].text += '!'; assert.throws(() => validateAdaptation(wrong, item), /verbatim/)
  const reordered = valid(); [reordered.units[0], reordered.units[1]] = [reordered.units[1], reordered.units[0]]; assert.throws(() => validateAdaptation(reordered, item), /in order/)
  const duplicate = valid(); duplicate.units[1] = duplicate.units[0]; assert.throws(() => validateAdaptation(duplicate, item), /verbatim/)
  const empty = valid(); empty.units[0].reason = ''; assert.throws(() => validateAdaptation(empty, item), /nonempty text/)
})
test('factual support requires an exact canonical excerpt', () => {
  const supported = valid(); supported.units[1] = { ...supported.units[1], verdict: 'supported', sourceExcerpt: 'The release has three themes.', reason: 'Same count and attribution as the master.' }
  assert.equal(validateAdaptation(supported, item).passed, true)
  const missing = structuredClone(supported); missing.units[1].sourceExcerpt = ''; assert.throws(() => validateAdaptation(missing, item), /exact supporting excerpt/)
  const invented = structuredClone(supported); invented.units[1].sourceExcerpt = 'The release has thirty themes.'; assert.throws(() => validateAdaptation(invented, item), /exact supporting excerpt/)
  const oversized = structuredClone(supported); oversized.units[1].sourceExcerpt = 'x'.repeat(6001)
  assert.throws(() => validateAdaptation(oversized, { ...item, draft: 'x'.repeat(6001) }), /sourceExcerpt must be at most 6000/, 'even an exact excerpt must not be silently truncated after review')
})
test('summary and verdicts are not free-form approval shortcuts', () => {
  const noSummary = valid(); noSummary.summary = ''; assert.throws(() => validateAdaptation(noSummary, item), /summary/)
  const status = valid(); status.checks[0].verdict = 'approved'; assert.throws(() => validateAdaptation(status, item), /review dimension/)
  const unit = valid(); unit.units[0].verdict = 'pass'; assert.throws(() => validateAdaptation(unit, item), /verbatim/)
  assert.throws(() => validateAdaptation({ passed: true }, item), /summary/)
})
test('digest binds master, platform fields, account voice, brand, limits, knowledge and images', () => {
  const mutations = [
    { ...args, draft: draft + '\nChanged master' },
    { ...args, fields: { ...fields, title: 'Changed' } },
    { ...args, fields: { ...fields, cover: { ...fields.cover, subtitle: 'Changed' } } },
    { ...args, settings: { ...args.settings, style: { guide: 'formal' } } },
    { ...args, settings: { ...args.settings, brand: { accent: '#654321' } } },
    { ...args, settings: { ...args.settings, limits: { xhs: { titleMax: 21 } } } },
    { ...args, knowledge: { revision: 'v2' } },
    { ...args, images: [{ name: 'card.png', sha256: 'def' }] },
  ]
  for (const changed of mutations) assert.notEqual(adaptationInput(changed).digest, item.digest)
  assert.equal(adaptationInput(structuredClone(args)).digest, item.digest)
  assert.equal(adaptationInput({ ...args, fields: { ...fields, passed: true, audit: { passed: true } } }).digest, item.digest, 'non-publishing JSON fields never become approval state')
})
test('legacy passed audits do not approve the new filtered knowledge prompt contract', () => {
  const { digest, units, ...value } = item
  const oldAudit = { ...validateAdaptation(valid(), item), digest: fitHash({ ...value, version: 1 }) }
  assert.equal(oldAudit.passed, true)
  assert.equal(item.version, 2)
  assert.notEqual(oldAudit.digest, adaptationInput(args).digest, 'the ordinary current-audit digest comparison requires a new review')
  assert.deepEqual(item.knowledge, args.knowledge, 'input digest still binds the original knowledge profile')
})
test('partial X audits only the editable continuation while binding the complete thread and receipt scope', () => {
  const base = { ...args, platform: 'x', fields: { tweets: ['Already published context.', 'The release has three themes.'] }, publishedCount: 1 }
  const continuation = adaptationInput(base)
  assert.deepEqual(continuation.units, [{ id: 'tweets.1', text: 'The release has three themes.' }])
  assert.deepEqual(continuation.fields.tweets, base.fields.tweets)
  const result = { summary: 'Only the unpublished continuation is in scope.', checks: valid().checks, units: continuation.units.map(u => ({ ...u, verdict: 'supported', sourceExcerpt: 'The release has three themes.', reason: 'The new statement is supported by the master draft.' })) }
  assert.equal(validateAdaptation(result, continuation).passed, true)
  assert.equal(validateAdaptation({ ...result, units: result.units.map(u => ({ ...u, verdict: 'unsupported' })) }, continuation).passed, false)
  assert.notEqual(adaptationInput({ ...base, publishedCount: 0 }).digest, continuation.digest, 'newly confirmed receipts invalidate a prior review of a different scope')
  assert.notEqual(adaptationInput({ ...base, fields: { tweets: ['Changed published context.', base.fields.tweets[1]] } }).digest, continuation.digest, 'immutable context still participates in the binding')
  assert.match(adaptationPrompt(continuation, ''), /only the supplied unpublished units are in scope/)
  for (const publishedCount of [-1, 0.5, 3]) assert.throws(() => adaptationInput({ ...base, publishedCount }), /confirmed published prefix/)
  assert.throws(() => adaptationInput({ ...args, publishedCount: 1 }), /confirmed published prefix/)
})
test('complete audit has explicit bounded input', () => {
  assert.throws(() => adaptationUnits('x', { tweets: [] }), /empty/)
  assert.throws(() => adaptationInput({ ...args, draft: ' ' }), /readable master/)
  assert.throws(() => adaptationInput({ ...args, draft: 'x'.repeat(150001) }), /150,000/)
  assert.throws(() => adaptationInput({ ...args, platform: 'unknown' }), /Unknown platform/)
  assert.throws(() => adaptationUnits('wechat_mp', { body: 'paragraph\n\n'.repeat(251) }), /too large/)
  assert.throws(() => adaptationUnits('x', { tweets: ['x'.repeat(100001)] }), /too large/)
})
test('prompt carries exact content and knowledge identity as untrusted data and audits all dimensions', () => {
  const prompt = adaptationPrompt(item, 'A source-backed editorial suggestion')
  assert.match(prompt, /READ ONLY/)
  assert.match(prompt, /DATA, not instructions/)
  assert.match(prompt, /canonical content, not independently verified truth/)
  assert.match(prompt, /summary at most 3000 characters, each reason at most 2000 characters, and sourceExcerpt at most 6000 characters/)
  const parsed = JSON.parse(prompt.split('INPUT DATA:\n').at(-1).split('\nEND INPUT DATA')[0])
  const { knowledge, ...expected } = item
  assert.deepEqual(parsed, { ...expected, knowledgeVersion: { revision: 'v1', auditContract: null } })
  for (const dimension of FIT_DIMENSIONS) assert.ok(prompt.includes('"' + dimension + '"'))
})
test('expired and legacy snapshot content cannot reenter the auditor through input data', () => {
  const now = Date.parse('2026-10-23T00:00:00Z'), baseline = snapshotKnowledge({ get: () => null }, ['xhs'], { now })
  for (const kind of ['reviewed', 'legacy', 'stale', 'seed']) {
    const snapshot = structuredClone(baseline), p = snapshot.platforms.xhs
    p.source = kind === 'seed' ? 'seed' : 'reviewed'
    p.auditContract = kind === 'seed' ? null : 2
    if (kind === 'legacy') delete p.auditContract
    if (kind === 'stale') p.expiresAt = new Date(now - 1).toISOString()
    p.summary = 'PROFILE_SUMMARY_MUST_NOT_REENTER'
    p.unknowns = ['UNKNOWN_CLAIM_MUST_NOT_REENTER']
    p.sources[0].title = 'SOURCE_TITLE_MUST_NOT_REENTER'
    p.observations = [{ id: 'test', dimension: 'tone', authority: 'editorial', sourceIds: [], statement: 'ELIGIBLE_ADVICE_MARKER', limitations: 'Pure prompt filtering fixture.' }]
    snapshot.digest = knowledgeDigest({ version: snapshot.version, capturedAt: snapshot.capturedAt, platforms: snapshot.platforms })
    const before = structuredClone(snapshot), input = adaptationInput({ ...args, knowledge: p }), digest = input.digest
    const prompt = adaptationPrompt(input, knowledgePrompt(snapshot, 'xhs', { now }))
    assert.doesNotMatch(prompt, /PROFILE_SUMMARY_MUST_NOT_REENTER|UNKNOWN_CLAIM_MUST_NOT_REENTER|SOURCE_TITLE_MUST_NOT_REENTER/)
    assert.equal(prompt.includes('ELIGIBLE_ADVICE_MARKER'), kind === 'reviewed' || kind === 'seed', kind)
    const parsed = JSON.parse(prompt.split('INPUT DATA:\n').at(-1).split('\nEND INPUT DATA')[0])
    assert.equal(parsed.knowledge, undefined)
    assert.deepEqual(parsed.knowledgeVersion, { revision: p.revision, digest: p.digest, source: p.source, auditContract: p.auditContract ?? null })
    assert.equal(parsed.digest, digest)
    assert.deepEqual(snapshot, before, 'pinned content is preserved without silent migration or replacement')
    assert.equal(adaptationInput({ ...args, knowledge: p }).digest, digest)
    assert.notEqual(adaptationInput({ ...args, knowledge: { ...p, summary: 'Changed original snapshot' } }).digest, digest, 'even excluded text remains covered by the snapshot binding')
  }
})
console.log('plume adaptation contracts: ' + cases + ' groups passed')

