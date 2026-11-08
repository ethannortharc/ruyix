import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openStore } from '../../core/workbench/lib/store.js'
import { currentKnowledgeRevision, isOfficialKnowledgeSource, KNOWLEDGE_AUDIT_CONTRACT, knowledgeAuditMetadata, knowledgeDigest, knowledgeOps, knowledgePrompt, knowledgeURL, knowledgeUsable, publishKnowledge, readKnowledgeCandidate, readKnowledgeFile, snapshotKnowledge, validateKnowledgeAudit } from './lib/platform-knowledge.js'
import { platformResearchWorkflow } from './lib/platform-research.js'
import { PLATFORM_SEEDS } from './lib/platform-seeds.js'
import { zh, en } from './src/locale.js'

const home = mkdtempSync(join(tmpdir(), 'plume-knowledge-')), work = join(home, 'work'), db = join(home, 'db'), now = Date.now()
mkdirSync(join(work, 'platform-research/sources'), { recursive: true })
let store = openStore(db)
const run = { id: 'research-one', folder: work, dir: work, template: 'plume.platform-research', subject: { title: 'Refresh X', fields: { platforms: ['x'] } } }
const evidence = 'Source: https://docs.x.com/fundamentals/counting-characters\nAccessed at the actual retrieval time.\nURLs are transformed to 23 characters. This capture gives the surrounding context and applicability for the API post counter.'
const rawProfile = () => ({ platform: 'x', summary: 'Character counting with explicit evidence; editorial guidance remains optional.', sources: [{ id: 'S1', title: 'Counting characters', url: 'https://docs.x.com/fundamentals/counting-characters?utm_source=unused', publisher: 'X', authority: 'official', availability: 'read', accessedAt: new Date(now).toISOString(), publishedAt: null, summary: 'URL counting is documented.', evidencePath: 'platform-research/sources/x.md', quotes: ['URLs are transformed to 23 characters.'] }], observations: [{ id: 'O1', dimension: 'format', statement: 'Check URL contributions using the documented weighted counter.', authority: 'official', sourceIds: ['S1'], limitations: 'This concerns the post counter, not recommendations about reach.' }, { id: 'O2', dimension: 'opening', statement: 'Make the first post understandable without the rest of its thread.', authority: 'editorial', sourceIds: [], limitations: 'Optional editorial judgment, not a mandatory platform rule.' }], conflicts: [], unknowns: ['No algorithmic reach claim.'] })
const write = (profile = rawProfile()) => { writeFileSync(join(work, 'platform-research/sources/x.md'), evidence); writeFileSync(join(work, 'platform-research/research.json'), JSON.stringify({ profiles: [profile] })) }
const validAudit = candidate => ({ summary: 'Independently checked every observation and displayed metadata.', profileChecks: knowledgeAuditMetadata(candidate).map(({ platform, metadataDigest }) => ({ platform, metadataDigest, verdict: 'supported', reason: 'Checked profile claims, limitations and every source identity/availability field against captured evidence.' })), checks: candidate.profiles.flatMap(p => p.observations.map(o => ({ platform: p.platform, id: o.id, statement: o.statement, authority: o.authority, sourceIds: o.sourceIds, classification: o.authority === 'editorial' ? 'recommendation' : 'fact', verdict: o.authority === 'editorial' ? 'editorial' : 'supported', reason: 'Compared the statement and limitation to the cited source context.' }))), warnings: [] })
let groups = 0
const test = async (name, fn) => { await fn(); groups++; console.log(`ok ${name}`) }
try {
  await test('source capture hashes and bounded structured content', () => {
    write(); const c = readKnowledgeCandidate(run, { now }), s = c.profiles[0].sources[0]
    assert.equal(s.evidenceSha256, createHash('sha256').update(readFileSync(join(work, s.evidencePath))).digest('hex'))
    assert.equal(s.url, 'https://docs.x.com/fundamentals/counting-characters')
    assert.equal(c.profiles[0].observations.length, 2)
  })
  await test('invalid authority, evidence, dates, URLs, duplicate coverage and no-evidence refresh are refused', () => {
    const cases = [p => { p.sources[0].url = 'https://fake.example/x' }, p => { p.sources[0].availability = 'index-only' }, p => { p.sources[0].quotes = ['not present'] }, p => { p.sources[0].publishedAt = '2026-02-30' }, p => { p.sources[0].accessedAt = new Date(now + 864e5).toISOString() }, p => { p.sources[0].accessedAt = new Date(now - 31 * 864e5).toISOString() }, p => { p.sources.push({ ...p.sources[0], id: 'S2' }) }, p => { p.observations[0].sourceIds = ['missing'] }, p => { p.observations.push(p.observations[0]) }, p => { p.sources = []; p.observations = [p.observations[1]] }]
    for (const change of cases) { const p = rawProfile(); change(p); write(p); assert.throws(() => readKnowledgeCandidate(run, { now })) }
    for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/x', 'https://a:b@docs.x.com/x', 'file:///etc/passwd', 'https://fake.local/x']) assert.throws(() => knowledgeURL(url))
    write()
  })
  await test('official documentation routes retain seed provenance while platform-hosted UGC cannot claim official authority', () => {
    for (const [platform, seed] of Object.entries(PLATFORM_SEEDS)) for (const source of seed.sources.filter(s => s.authority === 'official')) assert.equal(isOfficialKnowledgeSource(platform, source.url, source), true, source.url)
    const rejected = [
      ['x', 'https://x.com/arbitrary-user/status/123'], ['x', 'https://twitter.com/arbitrary-user/status/123'],
      ['x', 'https://docs.x.com.evil.test/fundamentals/counting-characters'], ['x', 'https://foreign.docs.x.com/fundamentals/counting-characters'],
      ['x', 'https://github.com/twitter/twitter-text/issues/123'], ['x', 'https://github.com/twitter/twitter-text/discussions/123'],
      ['x', 'https://github.com/twitter/twitter-text/pull/123'], ['x', 'https://github.com/twitter/other-repo/blob/master/config/v3.json'],
      ['x', 'https://github.com/twitter/twitter-text/blob/arbitrary-user-ref/config/v3.json'], ['x', 'http://docs.x.com/fundamentals/counting-characters'],
      ['wechat_mp', 'https://mp.weixin.qq.com/s/arbitrary-public-article'], ['wechat_mp', 'https://developers.weixin.qq.com/community/develop/doc/123'],
      ['xhs', 'https://www.xiaohongshu.com/explore/123'], ['xhs', 'https://creator.xiaohongshu.com/'], ['xhs', 'https://foreign.pgy.xiaohongshu.com/help/detail?id=1'],
    ]
    for (const [platform, url] of rejected) {
      const p = rawProfile(); p.platform = platform; p.sources[0].url = url
      write(p); const oneRun = { ...run, subject: { fields: { platforms: [platform] } } }
      assert.throws(() => readKnowledgeCandidate(oneRun, { now }), /approved platform documentation/, url)
      p.sources[0].authority = 'observed'; p.observations[0].authority = 'observed'; write(p)
      assert.equal(readKnowledgeCandidate(oneRun, { now }).profiles[0].sources[0].authority, 'observed', `${url} remains usable as explicitly observed evidence`)
    }
    for (const url of ['https://docs.x.com/x-api/posts/manage-tweets/introduction', 'https://help.x.com/en/using-x/create-a-thread', 'https://github.com/twitter/twitter-text/blob/master/config/v3.json']) {
      const p = rawProfile(); p.sources[0].url = url; write(p)
      assert.equal(readKnowledgeCandidate(run, { now }).profiles[0].sources[0].authority, 'official')
    }
    write()
  })
  await test('safe reads reject traversal, leaf/directory links, special files and oversized or invalid UTF-8', () => {
    for (const path of ['../secret', '.git/config', '/etc/passwd', 'platform-research/../research.json', 'platform-research\\sources\\x.md']) assert.throws(() => readKnowledgeFile(run, path))
    symlinkSync(join(work, 'platform-research/sources/x.md'), join(work, 'leaf.md'))
    symlinkSync(join(work, 'platform-research/sources'), join(work, 'alias'))
    symlinkSync(tmpdir(), join(work, 'outside'))
    for (const path of ['leaf.md', 'alias/x.md', 'outside/anything', 'platform-research/sources']) assert.throws(() => readKnowledgeFile(run, path))
    writeFileSync(join(work, 'large.txt'), Buffer.alloc(65537)); assert.throws(() => readKnowledgeFile(run, 'large.txt'))
    writeFileSync(join(work, 'invalid.txt'), Buffer.from([0xff])); assert.throws(() => readKnowledgeFile(run, 'invalid.txt'))
  })
  await test('audit requires exact full coverage and cannot be forged by files or untrusted objects', () => {
    const c = readKnowledgeCandidate(run, { now }), good = validAudit(c)
    assert.throws(() => validateKnowledgeAudit({ ...good, checks: good.checks.slice(1) }, c))
    assert.throws(() => validateKnowledgeAudit({ ...good, checks: [...good.checks].reverse() }, c))
    assert.throws(() => validateKnowledgeAudit({ ...good, checks: [{ ...good.checks[0], verdict: 'editorial' }, good.checks[1]] }, c))
    assert.throws(() => publishKnowledge(store, { candidate: c, audit: { ...good, passed: true, digest: c.digest }, runId: run.id, expected: { x: null }, now }))
    const audited = validateKnowledgeAudit(good, c)
    assert.equal(audited.contract, KNOWLEDGE_AUDIT_CONTRACT)
    assert.throws(() => { audited.passed = false })
    assert.throws(() => { audited.checks[0].verdict = 'unsupported' })
  })
  await test('profile summary, conflicts, unknowns and full source provenance need exact independent coverage', () => {
    const c = readKnowledgeCandidate(run, { now }), good = validAudit(c)
    assert.throws(() => validateKnowledgeAudit({ ...good, profileChecks: undefined }, c), /profile audit/)
    assert.throws(() => validateKnowledgeAudit({ ...good, profileChecks: [] }, c), /profile audit/)
    assert.throws(() => validateKnowledgeAudit({ ...good, profileChecks: [{ ...good.profileChecks[0], metadataDigest: 'old' }] }, c), /exact metadata/)
    const edits = [p => { p.summary = 'Unchecked invented guarantee' }, p => { p.conflicts.push('Unchecked conflict') }, p => { p.unknowns.push('Unchecked claim disguised as an unknown') }, p => { p.sources[0].title = 'Wrong title' }, p => { p.sources[0].publisher = 'Wrong publisher' }, p => { p.sources[0].summary = 'Wrong attributed claim' }, p => { p.sources[0].availability = 'index-only' }, p => { p.sources[0].authority = 'observed' }, p => { p.observations[0].limitations = 'Removed its original limitation' }]
    for (const edit of edits) {
      const next = structuredClone(c); edit(next.profiles[0]); next.digest = knowledgeDigest(next.profiles)
      assert.throws(() => validateKnowledgeAudit(good, next), /exact metadata/)
    }
    const rejectedMetadata = { ...good, profileChecks: [{ ...good.profileChecks[0], verdict: 'unsupported', reason: 'The summary promises a reach guarantee unsupported by any source.' }] }
    const checked = validateKnowledgeAudit(rejectedMetadata, c)
    assert.equal(checked.passed, false)
    assert.throws(() => publishKnowledge(store, { candidate: c, audit: checked, runId: run.id, expected: { x: null }, now }), /independent audit/)
    assert.equal(currentKnowledgeRevision(store, 'x'), null)
  })
  await test('editorial labels and verdicts cannot launder factual assertions', () => {
    const c = readKnowledgeCandidate(run, { now }), good = validAudit(c)
    for (const patch of [{ classification: 'fact', verdict: 'editorial' }, { classification: 'fact', verdict: 'supported' }, { classification: 'recommendation', verdict: 'supported' }]) {
      const result = structuredClone(good); Object.assign(result.checks[1], patch)
      assert.throws(() => validateKnowledgeAudit(result, c), /editorial/)
    }
    const detected = structuredClone(good); Object.assign(detected.checks[1], { classification: 'fact', verdict: 'unsupported', reason: 'This supposedly editorial item makes an unsubstantiated factual claim.' })
    assert.equal(validateKnowledgeAudit(detected, c).passed, false)
    const misclassified = structuredClone(good); misclassified.checks[0].classification = 'recommendation'
    assert.throws(() => validateKnowledgeAudit(misclassified, c), /factual claims/)
  })
  let initialRevision
  await test('reviewed versions survive SQLite restart and source work folder edits', () => {
    const c = readKnowledgeCandidate(run, { now }), a = validateKnowledgeAudit(validAudit(c), c)
    const [v] = publishKnowledge(store, { candidate: c, audit: a, runId: run.id, expected: { x: null }, now }); initialRevision = v.revision
    const before = snapshotKnowledge(store, ['x'], { now })
    assert.equal(before.platforms.x.auditContract, KNOWLEDGE_AUDIT_CONTRACT)
    store.close(); store = openStore(db)
    assert.deepEqual(snapshotKnowledge(store, ['x'], { now }), before)
    writeFileSync(join(work, 'platform-research/sources/x.md'), 'changed outside the knowledge store')
    assert.deepEqual(snapshotKnowledge(store, ['x'], { now }), before)
    assert.equal(before.platforms.x.sources[0].capture, undefined)
    write()
  })
  await test('stale knowledge stays visible but cannot influence automatic prompts', () => {
    const fresh = snapshotKnowledge(store, ['x'], { now }), old = snapshotKnowledge(store, ['x'], { now: now + 31 * 864e5 })
    assert.equal(old.platforms.x.stale, true)
    assert.match(knowledgePrompt(fresh, 'x', { now }), /Check URL contributions/)
    assert.doesNotMatch(knowledgePrompt(old, 'x', { now: now + 31 * 864e5 }), /Check URL contributions/)
    assert.doesNotMatch(knowledgePrompt(fresh, 'x', { now: now + 31 * 864e5 }), /Check URL contributions/)
    fresh.platforms.x.observations[0].statement = 'modified'; assert.throws(() => knowledgePrompt(fresh))
  })
  await test('legacy pinned snapshots stay intact but cannot inherit the current audit contract', () => {
    const fresh = snapshotKnowledge(store, ['x'], { now }), legacy = structuredClone(fresh)
    delete legacy.platforms.x.auditContract
    const { digest, ...content } = legacy; legacy.digest = knowledgeDigest(content)
    const preserved = structuredClone(legacy)
    assert.equal(knowledgeUsable(fresh.platforms.x), true)
    assert.equal(knowledgeUsable(legacy.platforms.x), false)
    assert.doesNotMatch(knowledgePrompt(legacy, 'x', { now }), /Check URL contributions/)
    assert.deepEqual(legacy, preserved, 'original run snapshot is neither replaced nor re-sealed')
    const future = structuredClone(fresh); future.platforms.x.auditContract = KNOWLEDGE_AUDIT_CONTRACT + 1
    future.digest = knowledgeDigest({ version: future.version, capturedAt: future.capturedAt, platforms: future.platforms })
    assert.doesNotMatch(knowledgePrompt(future, 'x', { now }), /Check URL contributions/)
    const seed = snapshotKnowledge({ get: () => null }, ['x'], { now: Date.parse('2026-10-23T00:00:00Z') })
    assert.equal(seed.platforms.x.auditContract, null)
    assert.equal(knowledgeUsable(seed.platforms.x), true)
    assert.ok(JSON.parse(knowledgePrompt(seed, 'x', { now: Date.parse('2026-10-23T00:00:00Z') }).split('\n').at(-1)).length)
  })
  await test('failed review and racing older writers cannot replace a newer profile', () => {
    const c = readKnowledgeCandidate(run, { now }), bad = validAudit(c); bad.checks[0].verdict = 'unsupported'
    assert.throws(() => publishKnowledge(store, { candidate: c, audit: validateKnowledgeAudit(bad, c), runId: 'bad', expected: { x: initialRevision }, now: now + 100 }))
    const next = publishKnowledge(store, { candidate: c, audit: validateKnowledgeAudit(validAudit(c), c), runId: 'newer', expected: { x: initialRevision }, now: now + 200 })[0]
    assert.throws(() => publishKnowledge(store, { candidate: c, audit: validateKnowledgeAudit(validAudit(c), c), runId: 'slower', expected: { x: initialRevision }, now: now + 300 }), /another research run/)
    assert.equal(currentKnowledgeRevision(store, 'x'), next.revision)
    assert.equal(knowledgeOps({ store, now: () => now }).knowledgeHistory({ platform: 'x' }).versions.length, 2)
  })
  await test('search, history and bounded schedule discovery expose only the appropriate data', () => {
    const ops = knowledgeOps({ store, now: () => now })
    assert.equal(ops.knowledge({ query: 'URL weighted', platform: 'x' }).profiles.length, 1)
    assert.equal(ops.knowledge({ query: 'unfindable phrase', platform: 'x' }).profiles.length, 0)
    assert.throws(() => ops.knowledge({ query: 'a'.repeat(201) }))
    assert.throws(() => ops.knowledgeHistory({ platform: '__proto__' }))
    store.put('task', { id: 'weekly', workflow: 'plume.platform-research', title: 'Weekly', enabled: false, schedule: { kind: 'every', minutes: 10080 }, request: { fields: { platforms: ['x'] }, note: 'private' } })
    store.put('task', { id: 'other', workflow: 'plume.post', schedule: { kind: 'daily' } })
    assert.deepEqual(ops.knowledgeSchedules().tasks.map(t => t.id), ['weekly'])
    assert.equal(ops.knowledgeSchedules().tasks[0].note, undefined)
  })
  await test('search indexes visible wording and bilingual labels, never schema keys or internal identifiers', () => {
    const ops = knowledgeOps({ store: { get: () => null }, now: () => now })
    for (const query of ['语气', 'Voice', 'images']) assert.deepEqual(ops.knowledge({ query }).profiles.map(p => p.platform), ['xhs', 'x', 'wechat_mp'], query)
    assert.deepEqual(ops.knowledge({ query: '小红书', platform: 'xhs' }).profiles.map(p => p.platform), ['xhs'])
    assert.equal(ops.knowledge({ query: '官方资料' }).profiles.length, 3)
    for (const query of ['sourceIds', 'auditContract', 'evidenceSha256', 'seed-2026-10-22', 'xhs-visuals']) assert.equal(ops.knowledge({ query }).profiles.length, 0, query)
    const live = knowledgeOps({ store, now: () => now }), current = live.knowledge({ platform: 'x' }).profiles[0]
    for (const query of [current.digest, current.revision]) assert.equal(live.knowledge({ query, platform: 'x' }).profiles.length, 0)
    assert.equal(live.knowledge({ query: 'images', platform: 'x' }).profiles.length, 0, 'dimension labels are only indexed when that profile contains the dimension')
  })
  await test('every displayed platform name, category label and search-hint example is searchable in both UI languages', () => {
    const ops = knowledgeOps({ store: { get: () => null }, now: () => now })
    for (const labels of [zh, en]) {
      for (const [platform, seed] of Object.entries(PLATFORM_SEEDS)) {
        const keys = [`pl.${platform}`, ...seed.observations.flatMap(o => [`dimension.${o.dimension}`, `knowledge.${o.authority}`]), ...seed.sources.flatMap(s => [`knowledge.${s.authority}`, `knowledge.${s.availability}`])]
        for (const key of new Set(keys)) {
          assert.ok(labels[key], `missing display label: ${key}`)
          assert.deepEqual(ops.knowledge({ query: labels[key], platform }).profiles.map(p => p.platform), [platform], labels[key])
        }
      }
      const examples = labels['knowledge.searchHint'].split(/[:：]/).slice(1).join(':').split(/[,、]/).map(v => v.trim()).filter(Boolean)
      assert.equal(examples.length, 4, 'exercise every example from the actual UI hint')
      for (const query of examples) assert.ok(ops.knowledge({ query }).profiles.length, query)
    }
    assert.ok(ops.knowledge({ query: en['pl.wechat_mp'] }).profiles.some(p => p.platform === 'wechat_mp'))
    assert.deepEqual(ops.knowledge({ query: 'article', platform: 'wechat_mp' }).profiles.map(p => p.platform), ['wechat_mp'])
  })
  await test('multi-platform compare-and-publish preflights all platforms and interrupted publication recovers idempotently', () => {
    write(); const one = readKnowledgeCandidate(run, { now }), xhs = rawProfile()
    xhs.platform = 'xhs'; xhs.sources[0].authority = 'observed'; xhs.observations[0].authority = 'observed'
    writeFileSync(join(work, 'platform-research/research.json'), JSON.stringify({ profiles: [xhs, rawProfile()] }))
    const both = readKnowledgeCandidate({ ...run, subject: { fields: { platforms: ['xhs', 'x'] } } }, { now }), old = currentKnowledgeRevision(store, 'x')
    const newer = publishKnowledge(store, { candidate: one, audit: validateKnowledgeAudit(validAudit(one), one), runId: 'race-winner', expected: { x: old }, now: now + 500 })[0]
    assert.throws(() => publishKnowledge(store, { candidate: both, audit: validateKnowledgeAudit(validAudit(both), both), runId: 'race-loser', expected: { x: old, xhs: null }, now: now + 600 }), /another research run/)
    assert.equal(currentKnowledgeRevision(store, 'xhs'), null)
    const recovered = publishKnowledge(store, { candidate: one, audit: validateKnowledgeAudit(validAudit(one), one), runId: 'race-winner', expected: { x: old }, now: now + 700 })[0]
    assert.equal(recovered.revision, newer.revision)
    assert.equal(knowledgeOps({ store }).knowledgeHistory({ platform: 'x' }).versions.length, 3)
    write()
  })
  await test('changed stored content falls back honestly to checked-in baseline', () => {
    const pointer = store.get('plume-platform-current', 'x'), v = store.get('plume-platform-version', pointer.versionId)
    store.put('plume-platform-version', { ...v, summary: 'tampered summary' })
    const p = snapshotKnowledge(store, ['x'], { now }).platforms.x
    assert.equal(p.source, 'seed'); assert.match(p.unknowns.join(' '), /unavailable or changed/)
    const legacy = structuredClone(v); delete legacy.audit.profileChecks
    const { id, kind, updatedAt, digest, ...legacyContent } = legacy
    store.put('plume-platform-version', { ...legacy, digest: knowledgeDigest(legacyContent) })
    assert.equal(snapshotKnowledge(store, ['x'], { now }).platforms.x.source, 'seed', 'an older correctly sealed observation-only audit cannot masquerade as a full reviewed profile')
    const metadataOnly = structuredClone(v); delete metadataOnly.audit.contract
    const { id: oldId, kind: oldKind, updatedAt: oldUpdatedAt, digest: oldDigest, ...oldContent } = metadataOnly
    store.put('plume-platform-version', { ...metadataOnly, digest: knowledgeDigest(oldContent) })
    assert.equal(snapshotKnowledge(store, ['x'], { now }).platforms.x.source, 'seed', 'a sealed version without the current contract does not become current advice')
    assert.ok(knowledgeOps({ store, now: () => now }).knowledgeHistory({ platform: 'x' }).versions.every(p => p.revision !== v.revision), 'unrecognized legacy versions are not presented as reviewed history')
    assert.equal(store.get('plume-platform-version', v.id).summary, v.summary, 'legacy record remains retained')
    store.put('plume-platform-version', v)
  })
  await test('workflow uses actual independent result, retains prior on failure, and rejects mid-audit file changes', async () => {
    const [research, audit] = platformResearchWorkflow.stages
    let mode = 'fail', prompts = []
    const w = {
      get run() { return store.get('run', run.id) }, store, workflow: { ...platformResearchWorkflow, id: 'plume.platform-research' }, stage: 'research', pack: {}, packSettings: {}, toolNames: [],
      update(fn) { return store.put('run', fn(w.run)) },
      evidence(entry) { return store.addEvidence(run.id, { ...entry, full: undefined }) },
      async agent(role, prompt, options) {
        prompts.push({ role, prompt, options })
        if (role === 'platformResearcher') { write(); return { result: { summary: 'Actual researcher response.' } } }
        assert.equal(options.access, 'read'); const candidate = readKnowledgeCandidate(w.run), result = validAudit(candidate)
        if (mode === 'fail') result.checks[0].verdict = 'unsupported'
        if (mode === 'tamper') writeFileSync(join(work, 'platform-research/sources/x.md'), `${evidence}\nUnreviewed later change.`)
        return { result }
      },
    }
    store.put('run', run); await research.run(w)
    assert.match(prompts[0].prompt, /Earlier profiles/); assert.match(prompts[0].prompt, /Check URL contributions/)
    const before = currentKnowledgeRevision(store, 'x')
    writeFileSync(join(work, 'platform-research/audit.json'), JSON.stringify({ passed: true }))
    const failed = await audit.run(w); assert.equal(failed.ok, false); assert.equal(currentKnowledgeRevision(store, 'x'), before)
    mode = 'tamper'; await assert.rejects(() => audit.run(w), /changed during review/); assert.equal(currentKnowledgeRevision(store, 'x'), before)
    mode = 'pass'; await research.run(w); const success = await audit.run(w)
    assert.equal(success.ok, true); assert.notEqual(currentKnowledgeRevision(store, 'x'), before)
    assert.equal(w.run.plumeKnowledge.published.length, 1)
  })
  console.log(`platform knowledge check: ${groups} groups passed`)
} finally { store.close(); rmSync(home, { recursive: true, force: true }) }
