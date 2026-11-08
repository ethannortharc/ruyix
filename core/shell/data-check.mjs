// ruyix data export / import between two homes: the history moves (the runs, the conversations and what they remember),
// run records take the new home's paths, evidence stays sealed as it was, a home with history of its own is kept unless
// --replace. ruyix chat reads the conversations as they are.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const tool = join(dirname(fileURLToPath(import.meta.url)), 'bin/ruyix-data.mjs'), chatTool = join(dirname(fileURLToPath(import.meta.url)), 'bin/ruyix-chat.mjs')
const dataApi = await import('./bin/ruyix-data.mjs')
const withDataHomes = fn => {
  const names = ['FTMWB_HOME', 'DSH_AGENT_HUB_HOME', 'RUYIX_STUDIO_HOME'], saved = names.map(n => process.env[n])
  for (const n of names) delete process.env[n]
  try { return fn() } finally { names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i] }) }
}
const tmp = mkdtempSync(join(tmpdir(), 'ruyix-data-check-'))
const ruyix = (home, ...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', tool, ...args], { env: { ...process.env, HOME: home, FTMWB_HOME: '', DSH_AGENT_HUB_HOME: '' }, cwd: tmp, encoding: 'utf8' })
const chat = (home, ...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', chatTool, ...args], { env: { ...process.env, HOME: home, FTMWB_HOME: '' }, cwd: tmp, encoding: 'utf8' })
const db = (file, sql) => { mkdirSync(dirname(file), { recursive: true }); const d = new DatabaseSync(file); d.exec(sql); d.close() }
const get = (file, sql) => { const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare(sql).all() } finally { d.close() } }
try {
  const src = join(tmp, 'host/home/jdoe'), dst = join(tmp, 'box/home/nook')
  db(join(src, '.dsh-ftm-workbench/workbench.db'), `CREATE TABLE docs (kind TEXT, id TEXT, run_id TEXT, data TEXT, rev INTEGER, updated_at INTEGER);
    CREATE TABLE evidence (run TEXT, seq INTEGER, data TEXT, hash TEXT);
    INSERT INTO docs VALUES ('run', 'r1', 'r1', '{"status":"done","worktree":"${src}/.dsh-ftm-workbench/worktrees/r1","config":{"workspace":"${src}/projects/ws"}}', 1, 1);
    INSERT INTO docs VALUES ('run', 'r2', 'r2', '{"status":"running","waiting":{"approval":"a1"}}', 1, 1);
    INSERT INTO evidence VALUES ('r1', 1, '{"title":"ran in ${src}/projects/ws"}', 'h1');`)
  mkdirSync(join(src, '.dsh-ftm-workbench/runs/r1'), { recursive: true })
  writeFileSync(join(src, '.dsh-ftm-workbench/runs/r1/out.log'), 'ERROR 500\n')
  // another product's runs, in its own store under the workbench's home
  db(join(src, '.dsh-ftm-workbench/products/acme/workbench.db'), `CREATE TABLE docs (kind TEXT, id TEXT, run_id TEXT, data TEXT, rev INTEGER, updated_at INTEGER);
    INSERT INTO docs VALUES ('run', 'a1', 'a1', '{"status":"done","config":{"workspace":"${src}/projects/acme"}}', 1, 1);`)
  // the conversations (workbench lib/conversations.js): a thread, what was said, a summary, a memory
  db(join(src, '.dsh-ftm-workbench/conversations.db'), `CREATE TABLE threads (id TEXT PRIMARY KEY, kind TEXT, parent TEXT, title TEXT, status TEXT, agent TEXT, created INTEGER, updated INTEGER, lane TEXT);
    CREATE TABLE entries (n INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT, key TEXT, kind TEXT, at INTEGER, words TEXT, data TEXT);
    CREATE TABLE summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT, upto INTEGER, at INTEGER, text TEXT);
    CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, text TEXT, source TEXT, by TEXT, pinned INTEGER, created INTEGER, used INTEGER, uses INTEGER);
    INSERT INTO threads VALUES ('main', 'main', NULL, 'Chat', 'idle', NULL, 1000, 2000, '{"sid":"s1"}');
    INSERT INTO entries VALUES (1, 'main', 'k1', 'user', 1000, 'what is running?', '{"kind":"user","text":"what is running?"}');
    INSERT INTO entries VALUES (2, 'main', 'k2', 'text', 2000, 'Nothing.', '{"kind":"text","text":"Nothing."}');
    INSERT INTO summaries VALUES (1, 'main', 2, 2500, 'asked what is running');
    INSERT INTO memories VALUES (1, 'preference', 'short answers', 'main', 'auto', 1, 3000, NULL, 0);`)
  db(join(src, '.ruyix/agent-hub/hub.db'), `CREATE TABLE sessions (id TEXT, parent_id TEXT, cwd TEXT, running INTEGER, created_at INTEGER, updated_at INTEGER, rev INTEGER, data TEXT);
    CREATE TABLE docs (kind TEXT, id TEXT, team_id TEXT, data TEXT, rev INTEGER, updated_at INTEGER);
    INSERT INTO sessions VALUES ('s1', NULL, '${src}/projects/ws', 0, 1, 1, 1, '{}'); INSERT INTO docs VALUES ('job', 'j1', NULL, '{"cwd":"${src}/projects/ws"}', 1, 1);`)
  // a studio's records and the files people added (@ruyix/studio)
  db(join(src, '.ruyix/studios/plume/studio.db'), `CREATE TABLE records (coll TEXT, id TEXT, data TEXT, rev INTEGER, created_at INTEGER, updated_at INTEGER, removed_at INTEGER);
    INSERT INTO records VALUES ('ideas', 'i1', '{"title":"第一年"}', 1, 1, 1, NULL); INSERT INTO records VALUES ('ideas', 'i2', '{"title":"gone"}', 2, 1, 1, 5);`)
  mkdirSync(join(src, '.ruyix/studios/plume/materials'), { recursive: true })
  writeFileSync(join(src, '.ruyix/studios/plume/materials/m1.png'), 'png')
  mkdirSync(join(src, '.ruyix/agent-hub/skills-mine/own'), { recursive: true })
  writeFileSync(join(src, '.ruyix/agent-hub/skills-mine/own/SKILL.md'), 'my portable skill')
  mkdirSync(join(src, '.ruyix/agent-hub/sessions'), { recursive: true })
  writeFileSync(join(src, '.ruyix/agent-hub/sessions/s1.jsonl'), '{"seq":1,"type":"user/message","data":{"text":"kept conversation"}}\n')
  let r = ruyix(src, 'export', '--out', join(tmp, 'h.tgz'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /conversations 4, workbench 2, workbench-acme 1, agent-hub 1, studio-plume 1/)

  // a box that started once: its own empty databases make way
  db(join(dst, '.dsh-ftm-workbench/workbench.db'), "CREATE TABLE docs (kind TEXT, id TEXT, run_id TEXT, data TEXT, rev INTEGER, updated_at INTEGER); CREATE TABLE evidence (run TEXT, seq INTEGER, data TEXT, hash TEXT);")
  writeFileSync(join(dst, '.dsh-ftm-workbench/settings.json'), '{"mine":true}')
  r = ruyix(dst, 'import', join(tmp, 'h.tgz'))
  assert.equal(r.status, 0, r.stderr)
  const run = JSON.parse(get(join(dst, '.dsh-ftm-workbench/workbench.db'), "SELECT data FROM docs WHERE id = 'r1'")[0].data)
  assert.equal(run.config.workspace, `${dst}/projects/ws`, 'a run record takes this home\'s paths')
  const moved = JSON.parse(get(join(dst, '.dsh-ftm-workbench/workbench.db'), "SELECT data FROM docs WHERE id = 'r2'")[0].data)
  assert.deepEqual([moved.status, moved.interruptedBy, moved.waiting], ['interrupted', 'move', null], 'a run that had not ended never resumes on its own after a move')
  assert.equal(run.status, 'done')
  assert.equal(JSON.parse(get(join(dst, '.dsh-ftm-workbench/products/acme/workbench.db'), "SELECT data FROM docs WHERE id = 'a1'")[0].data).config.workspace, `${dst}/projects/acme`, 'another product\'s runs move too')
  assert.equal(get(join(dst, '.dsh-ftm-workbench/workbench.db'), 'SELECT data FROM evidence')[0].data, `{"title":"ran in ${src}/projects/ws"}`, 'evidence is sealed: as it was')
  assert.equal(readFileSync(join(dst, '.ruyix/agent-hub/sessions/s1.jsonl'), 'utf8'), readFileSync(join(src, '.ruyix/agent-hub/sessions/s1.jsonl'), 'utf8'))
  assert.equal(readFileSync(join(dst, '.ruyix/agent-hub/skills-mine/own/SKILL.md'), 'utf8'), 'my portable skill')
  assert.equal(get(join(dst, '.ruyix/agent-hub/hub.db'), 'SELECT cwd FROM sessions')[0].cwd, `${dst}/projects/ws`)
  assert.match(get(join(dst, '.ruyix/agent-hub/hub.db'), 'SELECT data FROM docs')[0].data, new RegExp(`${dst}/projects/ws`))
  assert.equal(readFileSync(join(dst, '.dsh-ftm-workbench/runs/r1/out.log'), 'utf8'), 'ERROR 500\n')
  assert.deepEqual([get(join(dst, '.ruyix/studios/plume/studio.db'), "SELECT data FROM records WHERE id = 'i1'")[0].data, readFileSync(join(dst, '.ruyix/studios/plume/materials/m1.png'), 'utf8')], ['{"title":"第一年"}', 'png'], 'a studio\'s records and materials move too')
  assert.deepEqual(get(join(dst, '.dsh-ftm-workbench/conversations.db'), 'SELECT n, kind, thread FROM entries ORDER BY n').map(e => [e.n, e.kind, e.thread]), [[1, 'user', 'main'], [2, 'text', 'main']], 'the conversations moved with the runs')
  assert.equal(get(join(dst, '.dsh-ftm-workbench/conversations.db'), 'SELECT text FROM memories')[0].text, 'short answers', '… and what they remember')
  // ruyix chat: the conversations as they are, Ruyix running or not
  r = chat(dst, 'threads')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^main\tmain\t1970-01-01 00:00\t2\tChat\n$/)
  r = chat(dst, 'memories')
  assert.match(r.stdout, /^1\tpreference\tpinned\tshort answers\n$/)
  r = chat(dst, 'export', '--thread', 'main', '--out', join(tmp, 'main.md'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(join(tmp, 'main.md'), 'utf8'), /^# Chat\n\nmain · [\s\S]*\*\*You\*\* · 1970-01-01 00:00\n\nwhat is running\?\n\n\*\*Assistant\*\* · 1970-01-01 00:00\n\nNothing\.\n/)
  r = chat(dst, 'export', '--out', join(tmp, 'all.jsonl'))
  assert.deepEqual(readFileSync(join(tmp, 'all.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).type), ['thread', 'entry', 'entry', 'summary', 'memory'])
  assert.equal(JSON.parse(readFileSync(join(tmp, 'all.jsonl'), 'utf8').split('\n')[0]).lane, undefined, 'the sessions\' state stays out')
  assert.notEqual(chat(dst, 'export', '--thread', 'nope').status, 0)
  assert.notEqual(chat(join(tmp, 'nobody'), 'threads').status, 0, 'no conversations here')
  assert.equal(chat(dst).status, 0)
  assert.equal(readFileSync(join(dst, '.dsh-ftm-workbench/settings.json'), 'utf8'), '{"mine":true}', 'the box\'s own settings stay')
  assert.ok(readdirSync(join(dst, '.dsh-ftm-workbench')).some(n => n.startsWith('.before-import-')), 'what was here is kept aside')

  // a home by the new name (or a new one): the history goes to ~/.ruyix/workbench
  const dst2 = join(tmp, 'box2/home/nook')
  r = ruyix(dst2, 'import', join(tmp, 'h.tgz'))
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(dst2, '.ruyix/workbench/workbench.db')) && existsSync(join(dst2, '.ruyix/workbench/conversations.db')) && existsSync(join(dst2, '.ruyix/workbench/products/acme/workbench.db')) && !existsSync(join(dst2, '.dsh-ftm-workbench')))

  // now the box has history: a second import needs --replace
  r = ruyix(dst, 'import', join(tmp, 'h.tgz'))
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /has history of its own \(4\).*--replace/)
  assert.equal(ruyix(dst, 'import', join(tmp, 'h.tgz'), '--replace').status, 0)
  // an export from before the conversations had a file of their own (no conversations.db in it; the chat is in workbench.db): the
  // conversations here stay without --replace; with it they go aside too (an empty record), and the import says so
  {
    const old = join(tmp, 'old/home/jdoe'), mine = home => db(join(home, '.ruyix/workbench/conversations.db'), `CREATE TABLE threads (id TEXT PRIMARY KEY, kind TEXT, parent TEXT, title TEXT, status TEXT, agent TEXT, created INTEGER, updated INTEGER, lane TEXT);
      CREATE TABLE entries (n INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT, key TEXT UNIQUE, kind TEXT, at INTEGER, words TEXT, data TEXT);
      CREATE TABLE summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT, upto INTEGER, at INTEGER, text TEXT);
      CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, text TEXT, source TEXT, by TEXT, pinned INTEGER, created INTEGER, used INTEGER, uses INTEGER);
      INSERT INTO entries VALUES (1, 'main', 'now:1', 'user', 5000, 'today', '{"kind":"user","text":"today"}');`)
    db(join(old, '.ruyix/workbench/workbench.db'), `CREATE TABLE docs (kind TEXT, id TEXT, run_id TEXT, data TEXT, rev INTEGER, updated_at INTEGER); CREATE TABLE evidence (run TEXT, seq INTEGER, data TEXT, hash TEXT);
      CREATE TABLE chat (n INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT INTO docs VALUES ('run', 'o1', 'o1', '{"status":"done"}', 1, 1);
      INSERT INTO chat VALUES (1, 'as-1:0', 1000, '{"kind":"user","text":"long ago"}');`)
    r = ruyix(old, 'export', '--out', join(tmp, 'old.tgz'))
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!/conversations/.test(r.stdout), 'the export has no conversations part')
    const keep = join(tmp, 'keep/home/nook'), swap = join(tmp, 'swap/home/nook')
    mine(keep); mine(swap)
    r = ruyix(keep, 'import', join(tmp, 'old.tgz'))
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!/emptied/.test(r.stdout))
    assert.deepEqual(get(join(keep, '.ruyix/workbench/conversations.db'), 'SELECT key FROM entries').map(e => e.key), ['now:1'], 'without --replace the conversations here stay')
    r = ruyix(swap, 'import', join(tmp, 'old.tgz'), '--replace')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /conversations: emptied — this export has none/)
    assert.ok(!existsSync(join(swap, '.ruyix/workbench/conversations.db')), 'an empty record is made when ruyix starts')
    const aside = readdirSync(join(swap, '.ruyix/workbench')).find(n => n.startsWith('.before-import-'))
    assert.deepEqual(get(join(swap, '.ruyix/workbench', aside, 'conversations.db'), 'SELECT key FROM entries').map(e => e.key), ['now:1'], 'what was here is kept aside')
    assert.equal(get(join(swap, '.ruyix/workbench/workbench.db'), 'SELECT key FROM chat')[0].key, 'as-1:0', 'the old chat comes with workbench.db')
    // …and a home with no conversations of its own is left as it is
    const fresh = join(tmp, 'fresh/home/nook')
    r = ruyix(fresh, 'import', join(tmp, 'old.tgz'), '--replace')
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!/emptied/.test(r.stdout))
  }
  // Reject an aliased archive part before any rename, preserving the current run database byte for byte.
  {
    const { importData } = await import('./bin/ruyix-data.mjs')
    const own = join(tmp, 'unsafe-home'), wb = join(own, '.ruyix/workbench'), stage = join(tmp, 'unsafe-stage'), archive = join(tmp, 'unsafe.tgz')
    mkdirSync(wb, { recursive: true }); mkdirSync(stage)
    const original = Buffer.from('original run history')
    writeFileSync(join(wb, 'workbench.db'), original)
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ kind: 'ruyix-data', version: 1, home: own, parts: { workbench: {}, 'workbench-..': {} } }))
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', stage, '.']).status, 0)
    withDataHomes(() => assert.throws(() => importData(archive, { home: own, replace: true }), e => e.code === 'ruyixData' && /invalid data part/.test(e.message)))
    assert.deepEqual(readFileSync(join(wb, 'workbench.db')), original)
  }
  if (process.platform !== 'win32') {
    const { importData, exportData } = await import('./bin/ruyix-data.mjs')
    const { symlinkSync, readlinkSync } = await import('node:fs')
    const own = join(tmp, 'link-home'), stage = join(tmp, 'link-stage'), part = join(stage, 'workbench'), archive = join(tmp, 'link.tgz'), external = join(tmp, 'external.db')
    mkdirSync(part, { recursive: true }); writeFileSync(external, 'unrelated history')
    symlinkSync(external, join(part, 'workbench.db'))
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ kind: 'ruyix-data', version: 1, home: own, parts: { workbench: {} } }))
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', stage, '.']).status, 0)
    withDataHomes(() => assert.throws(() => importData(archive, { home: own, replace: true }), /database must be a regular file/))
    assert.equal(readFileSync(external, 'utf8'), 'unrelated history')
    // A relative link within the exported runs remains relative and resolves after import.
    const from = join(tmp, 'relative-from'), to = join(tmp, 'relative-to'), wb = join(from, '.ruyix/workbench')
    mkdirSync(join(wb, 'runs/r'), { recursive: true })
    const db = new DatabaseSync(join(wb, 'workbench.db')); db.exec('CREATE TABLE docs(kind TEXT, data TEXT)'); db.close()
    writeFileSync(join(wb, 'runs/r/value.txt'), 'portable'); symlinkSync('value.txt', join(wb, 'runs/r/link.txt'))
    const portable = join(tmp, 'portable.tgz')
    withDataHomes(() => {
      exportData(portable, from); importData(portable, { home: to })
      assert.equal(readlinkSync(join(to, '.ruyix/workbench/runs/r/link.txt')), 'value.txt')
      assert.equal(readFileSync(join(to, '.ruyix/workbench/runs/r/link.txt'), 'utf8'), 'portable')
    })
  }
  // Unrelated/empty archives cannot clear the current conversation; invalid databases are refused before replacement.
  withDataHomes(() => {
    const { importData } = dataApi
    for (const kind of ['agent-only', 'empty', 'corrupt', 'windows']) {
      const own = join(tmp, `next-${kind}`), wb = join(own, '.ruyix/workbench'), stage = join(tmp, `next-${kind}-stage`), archive = join(tmp, `next-${kind}.tgz`)
      mkdirSync(wb, { recursive: true }); mkdirSync(stage)
      let db = new DatabaseSync(join(wb, 'conversations.db'))
      db.exec('CREATE TABLE entries(n); CREATE TABLE summaries(n); CREATE TABLE memories(n); INSERT INTO entries VALUES(1)'); db.close()
      const originalChat = readFileSync(join(wb, 'conversations.db'))
      db = new DatabaseSync(join(wb, 'workbench.db')); db.exec('CREATE TABLE docs(kind TEXT,data TEXT)'); db.close()
      const originalRun = readFileSync(join(wb, 'workbench.db')), parts = {}
      const old = kind === 'windows' ? 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'old' : join(tmp, 'old')
      if (kind === 'agent-only') {
        mkdirSync(join(stage, 'agent-hub')); db = new DatabaseSync(join(stage, 'agent-hub/hub.db'))
        db.exec('CREATE TABLE sessions(cwd TEXT,data TEXT); CREATE TABLE docs(data TEXT)'); db.close(); parts['agent-hub'] = {}
      }
      if (kind === 'corrupt' || kind === 'windows') {
        mkdirSync(join(stage, 'workbench')); parts.workbench = {}
        if (kind === 'corrupt') writeFileSync(join(stage, 'workbench/workbench.db'), 'not SQLite')
        else {
          db = new DatabaseSync(join(stage, 'workbench/workbench.db')); db.exec('CREATE TABLE docs(kind TEXT,data TEXT)')
          db.prepare('INSERT INTO docs VALUES(?,?)').run('run', JSON.stringify({ status: 'done', config: { workspace: old + String.fromCharCode(92) + 'Projects' + String.fromCharCode(92) + 'work' } })); db.close()
        }
      }
      writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ kind: 'ruyix-data', version: 1, home: old, parts }))
      assert.equal(spawnSync('tar', ['-czf', archive, '-C', stage, '.']).status, 0)
      if (kind === 'empty' || kind === 'corrupt') {
        assert.throws(() => importData(archive, { home: own, replace: true }))
        assert.deepEqual(readFileSync(join(wb, 'conversations.db')), originalChat)
        assert.deepEqual(readFileSync(join(wb, 'workbench.db')), originalRun)
      } else {
        importData(archive, { home: own, replace: true })
        if (kind === 'agent-only') assert.deepEqual(readFileSync(join(wb, 'conversations.db')), originalChat)
        else { db = new DatabaseSync(join(wb, 'workbench.db'), { readOnly: true }); assert.equal(JSON.parse(db.prepare('SELECT data FROM docs').get().data).config.workspace, own + '/Projects/work'); db.close() }
      }
    }
  })
  // A later destination copy failure restores earlier parts, rather than leaving a half-imported profile.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const { chmodSync } = await import('node:fs')
    withDataHomes(() => {
      const own = join(tmp, 'rollback-home'), wb = join(own, '.ruyix/workbench'), hub = join(own, '.ruyix/agent-hub'), stage = join(tmp, 'rollback-stage'), archive = join(tmp, 'rollback.tgz')
      mkdirSync(wb, { recursive: true }); mkdirSync(hub, { recursive: true }); mkdirSync(join(stage, 'workbench'), { recursive: true }); mkdirSync(join(stage, 'agent-hub'))
      const makeDb = (file, sql) => { const d = new DatabaseSync(file); d.exec(sql); d.close() }
      makeDb(join(wb, 'workbench.db'), 'CREATE TABLE docs(kind TEXT,data TEXT)')
      const original = readFileSync(join(wb, 'workbench.db'))
      makeDb(join(stage, 'workbench/workbench.db'), 'CREATE TABLE docs(kind TEXT,data TEXT)')
      makeDb(join(stage, 'agent-hub/hub.db'), 'CREATE TABLE sessions(cwd TEXT,data TEXT);CREATE TABLE docs(data TEXT)')
      writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ kind: 'ruyix-data', version: 1, home: join(tmp, 'old'), parts: { workbench: {}, 'agent-hub': {} } }))
      assert.equal(spawnSync('tar', ['-czf', archive, '-C', stage, '.']).status, 0)
      chmodSync(hub, 0o500)
      try {
        assert.throws(() => dataApi.importData(archive, { home: own, replace: true }))
        assert.deepEqual(readFileSync(join(wb, 'workbench.db')), original)
      } finally { chmodSync(hub, 0o700) }
    })
  }
  writeFileSync(join(tmp, 'bad.tgz'), 'nope')
  assert.notEqual(ruyix(dst, 'import', join(tmp, 'bad.tgz')).status, 0)
  assert.ok(!existsSync(join(tmp, 'ruyix-data.tar.gz')))
  console.log('ruyix data check: ok')
} finally { rmSync(tmp, { recursive: true, force: true }) }
