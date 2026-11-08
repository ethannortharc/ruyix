// Large evidence stays bounded in memory; live verification and report writes yield to other requests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createEngine } from './lib/engine.js'
import { openStore, sha256 } from './lib/store.js'
import { renderReport, report } from './workflows/common.js'

const tmp = mkdtempSync(join(tmpdir(), 'ruyix-store-check-'))
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
try {
  let syncStore = openStore(join(tmp, 'sync'))
  try {
    const kinds = ['run', 'approval', 'task'], options = { kinds }
    syncStore.put('run', { id: 'visible-run', stages: [{ key: 'work', result: { large: 'full result is requested separately' } }] })
    syncStore.put('approval', { id: 'visible-approval', status: 'pending' })
    syncStore.put('task', { id: 'visible-task', title: 'A visible task' })
    syncStore.put('internal-fixture', { id: 'private', capture: 'x'.repeat(4 * 1024 * 1024) })
    const initial = syncStore.since(0, options)
    assert.deepEqual(initial.docs.map(d => d.kind), kinds, 'the filtered initial sync contains only consumed client kinds')
    assert.equal(initial.docs[0].stages[0].result, true, 'visible runs still use the compact sync representation')
    assert.ok(JSON.stringify(initial).length < 1000, 'a private 4 MiB document never enters the filtered response')
    assert.equal(syncStore.since(0).docs.length, 4, 'callers without a kind filter preserve the complete document stream')
    assert.equal(syncStore.since(0, { kinds: ["run') OR 1=1 --"] }).docs.length, 0, 'kind values are SQL parameters, never query text')
    assert.equal(syncStore.since(0, { kinds: ['run', 'run'] }).docs.length, 1)
    assert.deepEqual(syncStore.since(0, { kinds: [] }).docs, [], 'an empty filter selects no documents')
    assert.throws(() => syncStore.since(0, { kinds: 'run' }), /array/)
    assert.throws(() => syncStore.since(0, { kinds: [null] }), /array/)

    syncStore.put('internal-fixture', { id: 'private', capture: 'y'.repeat(4 * 1024 * 1024) })
    const hidden = syncStore.since(initial.rev, options)
    assert.deepEqual(hidden.docs, []); assert.ok(hidden.rev > initial.rev, 'hidden writes advance the global cursor')
    assert.deepEqual(syncStore.since(hidden.rev, options), { rev: hidden.rev, docs: [] }, 'the next poll does not replay hidden writes')
    syncStore.put('task', { id: 'visible-task', title: 'Updated after hidden writes' })
    const visible = syncStore.since(hidden.rev, options)
    assert.deepEqual(visible.docs.map(d => d.id), ['visible-task'])
    syncStore.remove('internal-fixture', 'private'); syncStore.remove('approval', 'visible-approval')
    const removed = syncStore.since(visible.rev, options)
    assert.deepEqual(removed.docs.map(d => [d.kind, d.id]), [['approval', 'visible-approval']])
    assert.ok(removed.docs[0].deletedAt, 'visible tombstones reach the client while hidden ones do not')
    const cursor = removed.rev
    syncStore.close(); syncStore = openStore(join(tmp, 'sync'))
    assert.deepEqual(syncStore.since(cursor, options), { rev: cursor, docs: [] }, 'filtered cursors resume after reopening SQLite')
    const reset = syncStore.since(cursor + 100, options)
    assert.equal(reset.reset, true); assert.equal(reset.rev, cursor)
    assert.deepEqual(reset.docs.map(d => d.kind).sort(), [...kinds].sort(), 'reset repopulates only selected kinds including their tombstones')
    assert.equal(reset.docs.find(d => d.id === 'visible-approval').deletedAt, removed.docs[0].deletedAt)
    console.log('sync: SQL kind filtering, private 4 MiB exclusion, global cursor progress, visible tombstones, restart and reset')
  } finally { syncStore.close() }

  const store = openStore(join(tmp, 'large'))
  try {
    const artifact = store.artifact('large', 'large.bin', '').artifact, path = store.artifactPath('large', artifact)
    const bytes = 2 * 1024 ** 3 + 1
    truncateSync(path, bytes) // real sparse file: exact size that exceeds whole-file read limits
    const zero = Buffer.alloc(1024 * 1024), expected = createHash('sha256')
    for (let left = bytes; left > 0; left -= zero.length) expected.update(zero.subarray(0, Math.min(left, zero.length)))
    const entry = store.addEvidence('large', { kind: 'file', title: 'large artifact', artifact, sha256: expected.digest('hex') })
    assert.deepEqual(store.verify('large'), { ok: true, head: entry.hash, count: 1 }, 'synchronous compatibility path reads a file larger than 2 GiB in bounded chunks')
    let beats = 0
    const timer = setInterval(() => { beats++ }, 5)
    try { assert.deepEqual(await store.verifyAsync('large'), { ok: true, head: entry.hash, count: 1 }) }
    finally { clearInterval(timer) }
    assert.ok(beats > 2, `the event loop advances throughout large-artifact verification (${beats} heartbeats)`)

    const small = store.artifact('small', 'test.txt', 'original')
    store.addEvidence('small', { kind: 'file', ...small })
    assert.deepEqual(await store.verifyAsync('small'), store.verify('small'))
    writeFileSync(store.artifactPath('small', small.artifact), 'changed')
    for (const result of [store.verify('small'), await store.verifyAsync('small')]) assert.equal(result.reason, 'artifact changed')
    rmSync(store.artifactPath('small', small.artifact))
    for (const result of [store.verify('small'), await store.verifyAsync('small')]) assert.equal(result.reason, 'artifact missing')
    assert.deepEqual(await store.verifyAsync('empty'), { ok: true, head: '', count: 0 })
    const broken = store.addEvidence('broken', { kind: 'note', title: 'sealed note' })
    const db = new DatabaseSync(join(store.dir, 'workbench.db'))
    db.prepare('UPDATE evidence SET data = ? WHERE run = ? AND seq = ?').run(JSON.stringify({ ...broken, title: 'tampered' }), 'broken', broken.seq)
    db.close()
    assert.equal((await store.verifyAsync('broken')).reason, 'hash chain broken')
    const controller = new AbortController(), pending = store.verifyAsync('large', { signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' }, 'cancellation is not misreported as a missing artifact')
    console.log(`store: 2 GiB + 1 byte verified through both APIs; ${beats} live heartbeats; changed/missing/broken evidence detected`)
  } finally { store.close() }

  const store2 = openStore(join(tmp, 'reports')), entered = gate(), release = gate(), rendered = []
  const originalVerify = store2.verifyAsync
  let calls = 0, active = 0, maxActive = 0
  store2.verifyAsync = async (...args) => {
    const call = ++calls; maxActive = Math.max(maxActive, ++active)
    try { if (call === 1) { entered.resolve(); await release.promise }; return await originalVerify(...args) }
    finally { active-- }
  }
  const workflow = { id: 'fixture', title: 'Report fixture', stages: [report], report: args => { rendered.push(args); return renderReport(args) } }
  const engine = createEngine({ store: store2, settings: () => ({ autoResume: { enabled: false } }), workflow: () => workflow, hub: () => null, mcp: {}, versions: {}, resumeDelayMs: 1e9 })
  try {
    store2.put('run', { id: 'r', template: 'fixture', status: 'running', stage: 'report', stages: [{ key: 'report', owner: 'system', status: 'running', startedAt: 10, attempt: 1 }], subject: { title: 'Report fixture' } })
    store2.addEvidence('r', { kind: 'note', title: 'initial note' })
    const first = engine.writeReport('r', 'report')
    await entered.promise
    const added = engine.annotate('r', { status: 'cancelled', stage: null, verdict: { level: 'cancelled' } }, { kind: 'note', title: 'added during verification' })
    assert.equal(added.seq, 2, 'annotation still immediately returns its evidence entry')
    const last = engine.writeReport('r')
    release.resolve()
    await first
    const markdown = await last
    assert.equal(maxActive, 1, 'report writes for a run are serialized')
    assert.ok(calls >= 4, 'a changed evidence snapshot is checked again before any report is saved')
    assert.ok(rendered.every(r => r.run.status === 'cancelled'), 'a stopped run is never reported done by an earlier closing request')
    assert.ok(rendered.every(r => r.evidence.length === 2 && r.chain.count === 2 && r.chain.head === r.evidence.at(-1).hash), 'each report displays exactly the verified current ledger')
    assert.match(markdown, /added during verification/)
    assert.match(markdown, /chain verified/)
    assert.equal(store2.readArtifact(engine.get('r').report), markdown)
    assert.equal(engine.get('r').reportSha256, sha256(markdown), 'the kept report and hash always agree')

    const blocking = gate(), unblock = gate(); let blocked = false
    store2.verifyAsync = async (...args) => { if (!blocked) { blocked = true; blocking.resolve(); await unblock.promise }; return originalVerify(...args) }
    store2.put('run', { ...engine.get('r'), status: 'running', stage: 'report', verdict: null, resumedAt: 20, stages: [{ key: 'report', owner: 'system', status: 'running', startedAt: 20, attempt: 2 }] })
    const older = engine.writeReport('r')
    await blocking.promise
    const queuedClosing = engine.writeReport('r', 'report')
    store2.put('run', { ...engine.get('r'), resumedAt: 30, stages: [{ key: 'report', owner: 'system', status: 'running', startedAt: 30, attempt: 3 }] })
    unblock.resolve(); await older; await queuedClosing
    assert.equal(rendered.at(-1).run.status, 'running', 'a queued closing request cannot mark a newer resumed attempt done')

    store2.verifyAsync = async () => { throw Error('fixture read failure') }
    await assert.rejects(engine.writeReport('r'), /fixture read failure/)
    store2.verifyAsync = originalVerify
    assert.match(await engine.writeReport('r'), /chain verified/, 'a failed write does not poison the next report')

    const waiting = gate(), done = gate()
    store2.verifyAsync = async (...args) => { waiting.resolve(); await done.promise; return originalVerify(...args) }
    const disposed = engine.writeReport('r')
    await waiting.promise
    engine.dispose(); store2.close(); done.resolve()
    await assert.rejects(disposed, { name: 'AbortError' }, 'shutdown cancels a pending report before any access to its closed store')
  } finally { engine.dispose(); try { store2.close() } catch { /* already closed for the shutdown regression */ } }

  const finish = gate(); let settled = false
  const context = { run: {}, workflow: { success: 'done' }, update(fn) { this.run = fn(this.run) }, writeReport: () => finish.promise }
  const closing = report.run(context).then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(settled, false, 'the final report step waits for asynchronous report persistence')
  finish.resolve()
  assert.equal((await closing).ok, true)
  console.log('reports: current state and verified snapshot, ordered writes, failure recovery, shutdown cancellation, final-step await')
} finally { rmSync(tmp, { recursive: true, force: true }) }
