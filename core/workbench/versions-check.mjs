// A run's versions on their own (lib/versions.js): a shadow repository per run, the folder's own .git untouched, a version
// per step, a file's history, going back without losing what came after, a person's edit that refuses a stale copy.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BIG, createVersions, inTheWay, markOf, parseNameStatus, relPath } from './lib/versions.js'

const tmp = mkdtempSync(join(tmpdir(), 'ruyix-versions-check-'))
try {
  // ── paths: inside the folder only ──
  assert.equal(relPath('a/b.md'), 'a/b.md')
  assert.equal(relPath('./a//b.md'), 'a/b.md')
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', '.git/config', 'a/.git/HEAD', 'C:/x', '.GIT/config', '.Git/hooks/x', '.git./x', '.git /x', '.g\u200cit/config', 'GIT~1/config']) assert.equal(relPath(bad), null, bad)
  assert.deepEqual(inTheWay(['a.md', 'out', 'cfg/x'], ['a.md', 'out/node_modules/', 'out/.env', 'cfg/', 'other/', 'z.txt']), ['a.md', 'out/node_modules/', 'out/.env', 'cfg/'])
  assert.deepEqual(parseNameStatus('M\0a.md\0R087\0old.md\0new.md\0D\0gone\0'), [{ status: 'M', path: 'a.md' }, { status: 'R', from: 'old.md', path: 'new.md' }, { status: 'D', path: 'gone' }])
  assert.deepEqual(markOf('x\n\nruyix:{"kind":"step","step":"draft"}'), { kind: 'step', step: 'draft' })

  const root = join(tmp, 'home')
  const v = createVersions({ root, logger: { warn: m => console.error(m) } })
  const run = { id: 'r1', dir: join(root, 'runs', 'r1', 'work') }
  mkdirSync(run.dir, { recursive: true })
  writeFileSync(join(run.dir, 'brief.md'), 'the request\n')

  // ── one version at the start, one per step; a step that changed nothing makes none ──
  const start = await v.snapshot(run, 'Start', { kind: 'start' })
  assert.ok(start.made && /^[0-9a-f]{40}$/.test(start.commit))
  assert.deepEqual(start.files, [{ status: 'A', path: 'brief.md' }])
  assert.ok(!existsSync(join(run.dir, '.git')), 'the folder gets no .git of its own')
  writeFileSync(join(run.dir, 'draft.md'), 'first draft\nline two\n')
  const s1 = await v.snapshot(run, 'draft: passed', { kind: 'step', step: 'draft', status: 'passed' })
  assert.deepEqual(s1.files, [{ status: 'A', path: 'draft.md' }])
  const same = await v.snapshot(run, 'review: passed', { kind: 'step', step: 'review', status: 'passed' })
  assert.equal(same.made, false)
  assert.equal(same.commit, s1.commit, 'nothing changed: the version as it was')
  writeFileSync(join(run.dir, 'draft.md'), 'second draft\nline two\n')
  writeFileSync(join(run.dir, 'notes.txt'), 'n\n')
  const s2 = await v.snapshot(run, 'rewrite: passed', { kind: 'step', step: 'rewrite', status: 'passed' })
  assert.deepEqual(s2.files.map(f => `${f.status} ${f.path}`).sort(), ['A notes.txt', 'M draft.md'])

  // the log, each with what it is
  const log = await v.log(run)
  assert.deepEqual(log.map(c => c.mark.kind), ['start', 'step', 'step'])
  assert.deepEqual(log.map(c => c.mark.step || null), [null, 'draft', 'rewrite'])
  assert.equal(log[2].parent, s1.commit)
  const ch = await v.changes(run, s2.commit)
  assert.deepEqual(ch.find(f => f.path === 'draft.md'), { status: 'M', path: 'draft.md', added: 1, removed: 1 })

  // a file's history, newest first; its content at a version; the difference
  const h = await v.history(run, 'draft.md')
  assert.deepEqual(h.map(x => x.commit), [s2.commit, s1.commit])
  assert.equal((await v.show(run, s1.commit, 'draft.md')).text, 'first draft\nline two\n')
  assert.match(await v.diff(run, s1.commit, s2.commit, 'draft.md'), /-first draft\n\+second draft/)
  await assert.rejects(v.show(run, s1.commit, 'notes.txt'), { code: 'noFile' })
  await assert.rejects(v.resolve(run, 'deadbeef'), { code: 'noVersion' })
  await assert.rejects(v.resolve(run, 'HEAD~1'), { code: 'noVersion' }, 'only commit ids, no revision syntax')

  // ── going back: what the folder would lose, then the folder as it was — the later versions kept ──
  writeFileSync(join(run.dir, 'outside.txt'), 'made by hand meanwhile\n')
  const n0 = (await v.log(run)).length
  const pv = await v.preview(run, s1.commit)
  assert.deepEqual(pv.files.map(f => `${f.action} ${f.path}`).sort(), ['remove notes.txt', 'remove outside.txt', 'revert draft.md'])
  assert.equal((await v.log(run)).length, n0, 'a preview changes nothing: no version made')
  writeFileSync(join(run.dir, 'outside.txt'), 'changed after the preview\n')
  await assert.rejects(v.rewind(run, s1.commit, 'x', { kind: 'rewind' }, { expect: pv.tree }), { code: 'changedMeanwhile' }, 'what was done is what was seen')
  writeFileSync(join(run.dir, 'outside.txt'), 'made by hand meanwhile\n')
  const back = await v.rewind(run, s1.commit, 'Back to before rewrite', { kind: 'rewind', step: 'rewrite', to: s1.commit }, { expect: (await v.preview(run, s1.commit)).tree })
  assert.equal((await v.log(run)).at(-2).mark.kind, 'outside', 'what changed outside the steps got a version first')
  assert.equal(readFileSync(join(run.dir, 'draft.md'), 'utf8'), 'first draft\nline two\n')
  assert.ok(!existsSync(join(run.dir, 'notes.txt')) && !existsSync(join(run.dir, 'outside.txt')))
  assert.equal(back.target, s1.commit)
  assert.equal((await v.show(run, s2.commit, 'notes.txt')).text, 'n\n', 'the version after it is still there')
  assert.equal((await v.show(run, back.from, 'outside.txt')).text, 'made by hand meanwhile\n', 'and so is what was made by hand')

  // ── a person's edit: from the folder's copy they opened; a stale copy is refused; their file alone is theirs ──
  writeFileSync(join(run.dir, 'stray.md'), 'a step\'s output not in a version yet\n')
  writeFileSync(join(run.dir, 'draft.md'), 'newer in the folder than its last version\n')
  const head0 = await v.show(run, 'HEAD', 'draft.md'), opened = await v.show(run, 'WORK', 'draft.md')
  assert.ok(opened.work && opened.text === 'newer in the folder than its last version\n' && opened.blob !== head0.blob, 'the folder\'s copy, not the last version\'s')
  await assert.rejects(v.edit(run, 'draft.md', 'x', { blob: head0.blob }), { code: 'changedMeanwhile' })
  const e = await v.edit(run, 'draft.md', 'edited by the person\n', { blob: opened.blob })
  assert.ok(e.made)
  assert.equal(e.path, 'draft.md')
  assert.deepEqual(e.files.map(f => f.path), ['draft.md'], 'the edit is that file alone: what was pending got a version of its own first')
  assert.equal(readFileSync(join(run.dir, 'draft.md'), 'utf8'), 'edited by the person\n')
  assert.deepEqual((await v.log(run)).slice(-2).map(c => c.mark.kind), ['outside', 'edit'])
  await assert.rejects(v.edit(run, 'draft.md', 'again', { blob: opened.blob }), { code: 'changedMeanwhile' })
  await assert.rejects(v.edit(run, '../escape.md', 'x'), { code: 'badPath' })
  await assert.rejects(v.edit(run, '.GIT/config', 'x'), { code: 'badPath' })
  mkdirSync(join(tmp, 'elsewhere'))
  symlinkSync(join(tmp, 'elsewhere'), join(run.dir, 'out'))
  await assert.rejects(v.edit(run, 'out/x.md', 'x'), { code: 'badPath' }, 'a link that leads out of the folder is not followed')
  assert.ok(!existsSync(join(tmp, 'elsewhere', 'x.md')))
  rmSync(join(run.dir, 'out'))
  const fresh = await v.edit(run, 'new/file.md', 'a new file\n', { blob: null })
  assert.deepEqual(fresh.files, [{ status: 'A', path: 'new/file.md' }])

  // ── too big to keep: left out, said so; the folder's own .gitignore holds ──
  writeFileSync(join(run.dir, '.gitignore'), 'secret.env\n')
  writeFileSync(join(run.dir, 'secret.env'), 'TOKEN=x\n')
  writeFileSync(join(run.dir, 'big.bin'), '')
  truncateSync(join(run.dir, 'big.bin'), BIG + 1)
  const s3 = await v.snapshot(run, 'render: passed', { kind: 'step', step: 'render' })
  assert.deepEqual(s3.big, ['big.bin'])
  assert.deepEqual(s3.files.map(f => f.path), ['.gitignore'])
  assert.deepEqual((await v.files(run)).map(f => f.path).sort(), ['.gitignore', 'brief.md', 'draft.md', 'new/file.md', 'stray.md'])

  // ── a person's folder that is a Git repository: its own .git is never touched ──
  const own = join(tmp, 'code')
  mkdirSync(own)
  execFileSync('git', ['init', '-q', own])
  writeFileSync(join(own, 'main.js'), 'x\n')
  const before = execFileSync('git', ['-C', own, 'status', '--porcelain'], { encoding: 'utf8' })
  const r2 = { id: 'r2', dir: join(root, 'runs', 'r2', 'work'), folder: own }
  const a = await v.snapshot(r2, 'Start', { kind: 'start' })
  assert.deepEqual(a.files, [{ status: 'A', path: 'main.js' }], 'its .git is not taken in')
  assert.equal(execFileSync('git', ['-C', own, 'status', '--porcelain'], { encoding: 'utf8' }), before)
  assert.ok(!existsSync(join(own, '.git', 'refs', 'heads', 'master')) && !existsSync(join(own, '.git', 'refs', 'heads', 'main')), 'no commit lands in the person\'s repository')

  // ── no Git: no versions, said why; the run itself is not stopped ──
  const none = createVersions({ root, git: join(tmp, 'no-such-git') })
  const r3 = { id: 'r3', dir: join(root, 'runs', 'r3', 'work') }
  mkdirSync(r3.dir, { recursive: true })
  assert.equal(await none.snapshot(r3, 'Start', { kind: 'start' }), null)
  assert.match(none.off(r3), /git is not available/)
  assert.equal(none.has(r3), false)

  // ── what has no version is never lost by going back: too big, hidden by .gitignore, under a file that became a folder ──
  {
    const r4 = { id: 'r4', dir: join(root, 'runs', 'r4', 'work') }
    mkdirSync(r4.dir, { recursive: true })
    writeFileSync(join(r4.dir, 'data.csv'), 'a,b\n')
    writeFileSync(join(r4.dir, 'config.local'), 'v1\n')
    writeFileSync(join(r4.dir, 'out'), 'a file\n')
    const first = await v.snapshot(r4, 'Start', { kind: 'start' })
    truncateSync(join(r4.dir, 'data.csv'), BIG + 10)
    rmSync(join(r4.dir, 'config.local')); writeFileSync(join(r4.dir, '.gitignore'), 'config.local\n.env\n')
    rmSync(join(r4.dir, 'out')); mkdirSync(join(r4.dir, 'out')); writeFileSync(join(r4.dir, 'out', 'page.html'), '<p>'); writeFileSync(join(r4.dir, 'out', '.env'), 'KEY=1\n')
    const later = await v.snapshot(r4, 'step', { kind: 'step', step: 'build' })
    assert.deepEqual(later.big, ['data.csv'])
    // then the person writes the file the folder now hides
    writeFileSync(join(r4.dir, 'config.local'), 'PERSON SECRET WORK\n')
    const pv4 = await v.preview(r4, first.commit)
    assert.deepEqual(pv4.kept.sort(), ['config.local', 'data.csv', 'out/.env'], 'the preview says what is moved aside')
    const back4 = await v.rewind(r4, first.commit, 'back', { kind: 'rewind' }, { expect: pv4.tree })
    assert.equal(readFileSync(join(r4.dir, 'data.csv'), 'utf8'), 'a,b\n')
    assert.equal(readFileSync(join(r4.dir, 'out'), 'utf8'), 'a file\n')
    assert.equal(readFileSync(join(back4.keptDir, 'config.local'), 'utf8'), 'PERSON SECRET WORK\n', 'the person\'s ignored file is kept aside')
    assert.equal(statSync(join(back4.keptDir, 'data.csv')).size, BIG + 10, 'the big file too')
    assert.equal(readFileSync(join(back4.keptDir, 'out', '.env'), 'utf8'), 'KEY=1\n', 'and what was in the folder that became a file')
  }
  // ── a repository of its own inside the folder (an agent ran git init / cargo new): left out, named — versions go on ──
  {
    const r5 = { id: 'r5', dir: join(root, 'runs', 'r5', 'work') }
    mkdirSync(r5.dir, { recursive: true })
    writeFileSync(join(r5.dir, 'a.md'), 'a\n')
    await v.snapshot(r5, 'Start', { kind: 'start' })
    mkdirSync(join(r5.dir, 'app'))
    execFileSync('git', ['init', '-q', join(r5.dir, 'app')])
    writeFileSync(join(r5.dir, 'app', 'main.rs'), 'fn main() {}\n')
    writeFileSync(join(r5.dir, 'b.md'), 'b\n')
    const s5 = await v.snapshot(r5, 'step', { kind: 'step', step: 'scaffold' })
    assert.ok(s5, 'a nested repository does not stop the versions')
    assert.deepEqual(s5.nested, ['app'])
    assert.deepEqual(s5.files.map(f => f.path), ['b.md'])
    execFileSync('git', ['-C', join(r5.dir, 'app'), '-c', 'user.name=x', '-c', 'user.email=x@x', 'add', '-A'])
    execFileSync('git', ['-C', join(r5.dir, 'app'), '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'init'])
    writeFileSync(join(r5.dir, 'c.md'), 'c\n')
    const s6 = await v.snapshot(r5, 'step', { kind: 'step', step: 'more' })
    assert.deepEqual([s6.files.map(f => f.path), s6.nested], [['c.md'], ['app']], 'committed or not, it stays out')
    assert.equal(v.has(r5), true)
    const pv5 = await v.preview(r5, (await v.log(r5))[0].commit)
    assert.ok(pv5.kept.every(k => !k.startsWith('app')), 'a nested repository the way back does not touch stays where it is')
  }
  // a Git that fails: versions off, said why — not quietly missing from then on
  {
    const r6 = { id: 'r6', dir: join(root, 'runs', 'r6', 'work') }
    mkdirSync(r6.dir, { recursive: true })
    writeFileSync(join(r6.dir, 'a.md'), 'a')
    await v.snapshot(r6, 'Start', { kind: 'start' })
    // a lock a crashed Git left: taken away, the version made
    writeFileSync(join(v.gitDir(r6), 'index.lock'), '')
    writeFileSync(join(r6.dir, 'b.md'), 'b')
    assert.ok((await v.snapshot(r6, 'step', { kind: 'step' })).made)
    // a file Git cannot read: off, and why
    writeFileSync(join(r6.dir, 'c.md'), 'c'); chmodSync(join(r6.dir, 'c.md'), 0)
    if (process.getuid?.() !== 0) {
      assert.equal(await v.snapshot(r6, 'step', { kind: 'step' }), null)
      assert.match(v.off(r6) || '', /git add failed/)
    }
    chmodSync(join(r6.dir, 'c.md'), 0o644)
  }

  // parallel steps ending together: one Git at a time
  writeFileSync(join(run.dir, 'p1.md'), '1')
  writeFileSync(join(run.dir, 'p2.md'), '2')
  const both = await Promise.all([v.snapshot(run, 'lane a', { kind: 'step', step: 'a' }), v.snapshot(run, 'lane b', { kind: 'step', step: 'b' })])
  assert.ok(both.every(Boolean))
  // ── through the engine: a version per step, a person's edit, going on from a step, going back to before one ──
  const { openStore } = await import('./lib/store.js')
  const { createEngine } = await import('./lib/engine.js')
  const store = openStore(join(tmp, 'wb'))
  const seen = {}
  const wf = {
    id: 'demo', title: 'Demo', report: () => '# report',
    stages: [
      { key: 'draft', owner: 'system', run: async w => { writeFileSync(join(w.run.dir, 'draft.md'), 'draft 1\n'); return { ok: true } } },
      { key: 'polish', owner: 'system', run: async w => { seen.polish = readFileSync(join(w.run.dir, 'draft.md'), 'utf8'); writeFileSync(join(w.run.dir, 'final.md'), `final of: ${seen.polish}`); return { ok: true } } },
      { key: 'hold', owner: 'system', run: async w => { if (seen.hold) { while (!w.signal.aborted) await w.sleep(20) } return { ok: true } } },
    ],
  }
  const pack = { id: 'demo' }
  const engine = createEngine({ store, settings: () => ({ agentTimeoutMinutes: 1, autoResume: { enabled: false } }), hub: () => ({}), mcp: {}, workflow: id => (id === 'demo' ? wf : undefined), packOf: () => pack, callTool: () => '', resumeDelayMs: 1e9 })
  const wait = async (what, fn, ms = 8000) => { for (const t = Date.now(); !(await fn());) { if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 15)) } }
  const r = await engine.startRun({ workflow: 'demo', title: 'a demo' })
  await wait('the run ends', () => engine.get(r.id).status === 'done')
  let run1 = engine.get(r.id)
  assert.ok(run1.versions?.start, 'the start version is on the run')
  assert.deepEqual(run1.stages.map(s => s.version?.files?.map(f => f.path) || []), [['draft.md'], ['final.md'], []])
  assert.equal(run1.stages[1].version.base, run1.stages[0].version.commit, 'a step starts from the version the one before it made')
  assert.equal(run1.stages[2].version.made, false, 'a step that changed nothing makes none')
  const gate = store.evidence(r.id).find(e => e.kind === 'gate' && e.stage === 'polish')
  assert.equal(gate.input.version, run1.stages[1].version.commit, 'the ledger and the versions point at each other')
  assert.deepEqual((await engine.versionsOf(r.id)).commits.map(c => `${c.mark.kind}${c.mark.step ? ` ${c.mark.step}` : ''}`), ['start', 'step draft', 'step polish'])

  // a person's edit of draft's result, then on from polish: polish reads it; the steps after it are told
  const copy = await engine.versions.show(run1, 'HEAD', 'draft.md')
  await engine.editFile(r.id, { path: 'draft.md', content: 'draft by hand\n', blob: copy.blob })
  assert.match(engine.get(r.id).guidance.at(-1).text, /changed draft\.md by hand/)
  const continuing = engine.continueRun(r.id, { from: 'polish', note: 'shorter' })
  const unchanged = JSON.stringify(engine.get(r.id))
  assert.throws(() => engine.resumeRun(r.id, { from: 'draft' }), { code: 'runBusy' }, 'Resume cannot bypass an active rewind/continue owner')
  const losingContinue = assert.rejects(engine.continueRun(r.id, { from: 'draft', note: 'losing edit' }), { code: 'runBusy' })
  const losingRewind = assert.rejects(engine.rewindRun(r.id, { from: 'draft' }), { code: 'runBusy' })
  assert.equal(JSON.stringify(engine.get(r.id)), unchanged, 'rejected restarts change no outputs, stages or guidance')
  await Promise.all([losingContinue, losingRewind])
  await continuing
  await wait('it goes on and ends', () => engine.get(r.id).status === 'done' && engine.get(r.id).stages[2].status === 'passed')
  assert.equal(seen.polish, 'draft by hand\n')
  assert.equal(readFileSync(join(r.dir, 'final.md'), 'utf8'), 'final of: draft by hand\n')
  run1 = engine.get(r.id)
  assert.equal(run1.stages[1].history.at(-1).version.files[0].path, 'final.md', 'the attempt before keeps its version in the history')
  assert.deepEqual(run1.guidance.filter(g => g.stage === 'polish').map(g => g.text), ['shorter'])

  // back to before draft: the folder as the run began, the steps run again — the versions after it all still there
  const pv2 = await engine.rewindPreview(r.id, { from: 'draft' })
  assert.deepEqual(pv2.files.map(f => `${f.action} ${f.path}`).sort(), ['remove draft.md', 'remove final.md'])
  seen.hold = true
  await engine.rewindRun(r.id, { from: 'draft' })
  await wait('it runs again to hold', () => engine.get(r.id).stages[2].status === 'running')
  assert.equal(readFileSync(join(r.dir, 'draft.md'), 'utf8'), 'draft 1\n', 'draft ran again on the folder as it began')
  assert.ok(!engine.get(r.id).guidance.some(g => g.edit), 'the hand edit it went back over is not told any more')
  await assert.rejects(engine.editFile(r.id, { path: 'draft.md', content: 'x', blob: null }), { code: 'runBusy' })
  // going back while a step works: it is stopped first, its files kept as a version of their own
  writeFileSync(join(r.dir, 'scratch.md'), 'written by the working step\n')
  await engine.rewindRun(r.id, { from: 'hold' })
  const kinds = (await engine.versionsOf(r.id)).commits.map(c => `${c.mark.kind}${c.mark.step ? ` ${c.mark.step}` : ''}${c.mark.status ? ` ${c.mark.status}` : ''}`)
  assert.ok(kinds.includes('step hold stopped'), kinds.join(', '))
  assert.equal(kinds.filter(k => k.startsWith('rewind')).length, 2)
  assert.ok(!existsSync(join(r.dir, 'scratch.md')), 'back to before hold: what it wrote is undone')
  seen.hold = false
  await wait('it ends', () => engine.get(r.id).status === 'done')
  assert.equal((await engine.versions.show(engine.get(r.id), kinds.length ? (await engine.versionsOf(r.id)).commits.find(c => c.mark.status === 'stopped').commit : 'HEAD', 'scratch.md')).text, 'written by the working step\n')
  assert.ok(store.evidence(r.id).some(e => e.kind === 'version' && /back to before draft/.test(e.title)))
  assert.equal(store.verify(r.id).ok, true)

  // A pack's guard spans the actual asynchronous version write and releases after success or failure.
  let held = false, releases = 0
  const calls = []
  const guard = context => {
    assert.equal(context.store, store); assert.equal(context.run.id, r.id)
    assert.equal(held, false)
    calls.push(context); held = true
    return () => { assert.equal(held, true); held = false; releases++ }
  }
  pack.beforeFileMutation = guard
  const originalEdit = engine.versions.edit
  let finishEdit
  const editGate = new Promise(resolve => { finishEdit = resolve })
  engine.versions.edit = async (...args) => { assert.equal(held, true); await editGate; assert.equal(held, true); return originalEdit(...args) }
  const guardedCopy = await engine.versions.show(engine.get(r.id), 'WORK', 'draft.md')
  const editing = engine.editFile(r.id, { path: './draft.md', content: 'guarded edit\n', blob: guardedCopy.blob, by: 'demo' })
  assert.equal(held, true, 'the guard is acquired before yielding to the version write')
  assert.equal(readFileSync(join(r.dir, 'draft.md'), 'utf8'), guardedCopy.text)
  finishEdit(); await editing
  engine.versions.edit = originalEdit
  assert.equal(held, false); assert.equal(releases, 1)
  assert.deepEqual([calls[0].kind, calls[0].path, calls[0].by], ['edit', './draft.md', 'demo'])
  await assert.rejects(engine.editFile(r.id, { path: 'draft.md', content: 'stale', blob: guardedCopy.blob }), { code: 'changedMeanwhile' })
  assert.equal(held, false); assert.equal(releases, 2)

  // Refusing a rewind happens before it stops a running task or restores any files; refusal releases restart ownership.
  seen.hold = true
  await engine.continueRun(r.id, { from: 'hold' })
  assert.equal(held, false); assert.equal(releases, 3)
  assert.equal(calls.at(-1).kind, 'restart')
  await wait('guard fixture is running', () => engine.get(r.id).stages[2].status === 'running')
  pack.beforeFileMutation = () => { throw new Error('mutation refused') }
  for (let i = 0; i < 2; i++) await assert.rejects(engine.rewindRun(r.id, { from: 'draft' }), /mutation refused/)
  await assert.rejects(engine.continueRun(r.id, { from: 'draft' }), /mutation refused/)
  assert.equal(engine.active(r.id), true, 'a refused rewind did not stop the active task')
  assert.equal(readFileSync(join(r.dir, 'draft.md'), 'utf8'), 'guarded edit\n')
  seen.hold = false
  engine.stopRun(r.id)
  await wait('guard fixture stops', () => !engine.active(r.id))
  const refusedState = JSON.stringify(engine.get(r.id))
  assert.throws(() => engine.resumeRun(r.id, { from: 'draft' }), /mutation refused/)
  assert.throws(() => engine.goOn(r.id, 'draft'), /mutation refused/)
  assert.equal(JSON.stringify(engine.get(r.id)), refusedState, 'a refused public restart never resets stages or verdict')
  await assert.rejects(engine.editFile(r.id, { path: 'draft.md', content: 'refused' }), /mutation refused/)
  assert.equal(readFileSync(join(r.dir, 'draft.md'), 'utf8'), 'guarded edit\n')

  pack.beforeFileMutation = guard
  await assert.rejects(engine.rewindRun(r.id, { from: 'polish', expect: { tree: 'stale' } }), { code: 'changedMeanwhile' })
  assert.equal(held, false); assert.equal(releases, 4)
  await engine.rewindRun(r.id, { from: 'polish' })
  assert.equal(held, false); assert.equal(releases, 5)
  assert.deepEqual([calls.at(-1).kind, calls.at(-1).path, calls.at(-1).by], ['rewind', undefined, 'person'])
  await wait('guarded rewind ends', () => engine.get(r.id).status === 'done')

  // Even a broken release cannot strand the engine's restart ownership.
  pack.beforeFileMutation = () => () => { throw new Error('release failed') }
  await assert.rejects(engine.rewindRun(r.id, { from: 'polish', expect: { tree: 'stale' } }), /release failed/)
  pack.beforeFileMutation = () => { throw new Error('mutation refused again') }
  await assert.rejects(engine.rewindRun(r.id, { from: 'polish' }), /mutation refused again/)
  pack.beforeFileMutation = () => ({ release() {} })
  await assert.rejects(engine.editFile(r.id, { path: 'draft.md', content: 'invalid hook result' }), /synchronously return a release function/)

  engine.dispose()
  store.close()

  console.log('versions check: ok')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
