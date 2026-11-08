// The conversations' record (lib/conversations.js), on its own: entries once per key, paged back and forward, found by
// their words (FTS5 and, for a word of one or two characters, LIKE), threads, summaries, memories (a credential is never
// one), the kept days, the export — and the move of the standing conversation out of workbench.db's old `chat` table.
// Run by check.mjs; no dsh.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MAIN, isSecret, openConversations, moveLegacy, redact } from './lib/conversations.js'
import { openStore } from './lib/store.js'

const tmp = mkdtempSync(join(tmpdir(), 'ruyix-conversations-check-'))
try {
  const conv = openConversations(join(tmp, 'conversations.db'))
  conv.threadMake({ id: MAIN, kind: 'main', title: 'Chat' }, 50)
  assert.equal(conv.threadMake({ id: MAIN, kind: 'main', title: 'again' }, 60).title, 'Chat', 'a thread is made once')

  // ── entries: once per key, paged, found ──
  assert.equal(conv.add(MAIN, 's:0', { kind: 'user', text: 'first' }, 100), 1)
  assert.equal(conv.add(MAIN, 's:0', { kind: 'user', text: 'again' }), null, 'a key is taken once')
  for (let k = 1; k < 12; k++) conv.add(MAIN, `s:${k}`, { kind: k % 2 ? 'text' : 'user', text: `line ${k}` }, 100 + k)
  conv.add(MAIN, 'card', { kind: 'draft', args: { workflow: 'blank', title: 'A 50% look_at', text: 'the request' } })
  const all = conv.page(MAIN, { limit: 200 }).items.map(i => i.n) // (an ignored key may leave a gap in the numbers)
  assert.equal(all.length, 13)
  assert.ok(all.every((n, k) => !k || n > all[k - 1]), 'oldest first')
  const newest = conv.page(MAIN, { limit: 5 })
  assert.deepEqual([newest.items.map(i => i.n), newest.more], [all.slice(-5), true], 'the newest page')
  assert.deepEqual(conv.page(MAIN, { before: all.at(-5), limit: 5 }).items.map(i => i.n), all.slice(-10, -5))
  assert.deepEqual([conv.page(MAIN, { before: all[2], limit: 5 }).items.map(i => i.n), conv.page(MAIN, { before: all[2], limit: 5 }).more], [all.slice(0, 2), false])
  assert.deepEqual(conv.page(MAIN, { after: all.at(-4) }).items.map(i => i.n), all.slice(-3))
  assert.equal(conv.page(MAIN, { after: all.at(-4) }).more, null)
  assert.deepEqual(conv.page(MAIN, { kinds: ['draft'] }).items.map(i => i.n), [all.at(-1)], 'of these kinds')
  assert.deepEqual(conv.get(1), { kind: 'user', text: 'first', n: 1, at: 100, thread: MAIN })
  const card = all.at(-1)
  conv.set(card, { ...conv.get(card), outcome: { status: 'dismissed' } })
  assert.equal(conv.get(card).outcome.status, 'dismissed')
  assert.equal(conv.last(MAIN).n, card)
  assert.equal(conv.last(MAIN, ['user']).text, 'line 10')
  assert.deepEqual(conv.find('LINE 1').map(i => i.text), ['line 11', 'line 10', 'line 1'], 'words, any case, newest first')
  assert.deepEqual(conv.find('50%').map(i => i.n), [card], 'a card by its title')
  assert.deepEqual(conv.find('request').map(i => i.n), [card], '… and its request')
  assert.deepEqual(conv.find('%').map(i => i.n), [card], 'LIKE\'s signs are plain characters')
  assert.deepEqual(conv.find('_').map(i => i.n), [card])
  assert.deepEqual(conv.find('user'), [], 'the record\'s own names are not words')
  assert.deepEqual(conv.find('"line"').length, 0, 'a quote is plain too')
  assert.equal(conv.find('line', { limit: 3 }).length, 3)
  assert.equal(conv.find('line', { kinds: ['user'] }).length, 5, 'of these kinds')
  assert.equal(conv.find('line', { thread: 'nowhere' }).length, 0, 'in this thread')
  conv.add(MAIN, 'zh', { kind: 'user', text: '上海的天气怎么样' }, 200)
  assert.equal(conv.find('天气').length, 1, 'two characters: found by LIKE')
  assert.equal(conv.find('上海的天').length, 1, 'more: by the index')
  // a change to an entry's words is found by the new ones, not the old
  conv.set(conv.byKey('s:0').n, { kind: 'user', text: 'changed words' })
  assert.deepEqual([conv.find('first').length, conv.find('changed').length], [0, 1])

  // ── threads and a thread's tasks ──
  conv.threadMake({ id: 'task-1', kind: 'task', parent: MAIN, title: 'Look', status: 'running', lane: { task: 'x' } }, 300)
  conv.threadMake({ id: 'task-2', kind: 'task', parent: MAIN, title: 'Then', status: 'queued' }, 310)
  assert.deepEqual(conv.threads({ parent: MAIN }).map(t => t.id), ['task-2', 'task-1'], 'newest first')
  assert.deepEqual(conv.threads({ kind: 'task', status: 'queued', oldest: true }).map(t => t.id), ['task-2'])
  assert.equal(conv.count({ kind: 'task', status: 'running' }), 1)
  assert.deepEqual(conv.threadSet('task-1', { status: 'done', lane: l => ({ ...l, result: 'ok' }) }, 400).lane, { task: 'x', result: 'ok' })
  assert.equal(conv.thread('task-1').status, 'done')
  assert.equal(conv.thread('nope'), undefined)

  // ── summaries ──
  assert.equal(conv.summaryLast(MAIN), null)
  conv.summaryAdd(MAIN, 5, 'first stretch', 500)
  conv.summaryAdd(MAIN, 9, 'second stretch', 600)
  assert.equal(conv.summaryLast(MAIN).text, 'second stretch')

  // ── memories: kept once, found, pinned first, never a credential ──
  const id = conv.memoryAdd({ kind: 'preference', text: 'Answers in short bullet lists', by: 'auto' }, 700)
  assert.ok(id)
  assert.equal(conv.memoryAdd({ text: '  answers   in short bullet lists ' }), null, 'the same words are kept once')
  assert.equal(conv.memoryAdd({ text: 'the password for the staging database is hunter2' }), null, 'a credential is not kept')
  assert.equal(conv.memoryAdd({ text: '' }), null)
  const fact = conv.memoryAdd({ kind: 'nonsense', text: 'The nightly report goes out at 7', pinned: true, by: 'person' }, 710)
  assert.equal(conv.memoryGet(fact).kind, 'fact', 'an unknown kind is a fact')
  assert.deepEqual(conv.memories().map(m => m.id), [fact, id], 'pinned first')
  assert.deepEqual(conv.memoryFind('bullet').map(m => m.id), [id])
  assert.deepEqual(conv.memoryFind('nightly 7').map(m => m.id), [fact], 'a word of three characters or more by the index, shorter ones by LIKE')
  assert.deepEqual(conv.memoryFind('').map(m => m.id), [fact, id], 'no words: the latest')
  assert.equal(conv.memorySet(id, { text: 'api key: sk-abcdefghijkl' }).text, 'Answers in short bullet lists', 'not changed into a credential')
  assert.equal(conv.memorySet(id, { text: 'Answers in plain words', kind: 'decision', pinned: true }).kind, 'decision')
  assert.deepEqual(conv.memoryFind('plain').map(m => m.id), [id], 'found by its new words')
  assert.deepEqual(conv.memoryFind('bullet'), [])
  conv.memoryUsed([id], 800)
  assert.equal(conv.memoryGet(id).uses, 1)
  assert.match(conv.memoryBrief(), /^- \(decision\) Answers in plain words\n- \(fact\) The nightly/, 'pinned, the lately used first')
  assert.equal(conv.memoryBrief(40).split('\n').length, 1, 'within its budget')
  assert.equal(conv.memoryDelete(fact), true)
  assert.equal(conv.memoryDelete(fact), false)
  assert.deepEqual(conv.memoryFind('nightly'), [])

  // what reads as a credential
  for (const s of ['password: hunter2', 'the token is abc123', 'Authorization: Bearer abcdefghijkl', 'my api_key = x9', '密码是 123456', 'sk-abcdefghij1234', 'https://u:p@host/x', 'ghp_abcdefghijklmnop',
    'Basic dXNlcjpwYXNz', '-----BEGIN RSA PRIVATE KEY-----']) assert.ok(isSecret(s), s)
  for (const s of ['Basic configuration', 'prefers dark mode', 'the report goes out at 7']) assert.ok(!isSecret(s), s)
  assert.equal(redact('keep this\npassword: hunter2\nand this'), 'keep this\n[redacted]\nand this')
  // …in the other forms people write one: a word and its value after only a space, a long random string, user:pass@ and -u user:pass
  // without a scheme, mysql's -p<password>
  for (const s of ['The staging DB password hunter2', 'NAS 的 root 密码 Zx9!kq', 'use token 3f9a1b2c3d4e5f60718293a4b5c6d7e8f9012345', 'AWS secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'curl -u admin:hunter2 https://x', 'mysql -phunter2', 'https://user:pass@host/x', 'mysql -h db -uroot -phunter2 app', 'admin:hunter2@db.internal:3306', 'curl --user admin:pw https://x',
    'sshpass -p hunter2 ssh x', 'pwd = abc', 'the passphrase correct9horse', '密钥 K8s9Xx', 'key 8Qp2Zr7LmN4xT9vB3cY6wA1sD5', 'the client secret: 0123456789abcdef0123456789abcdef']) assert.ok(isSecret(s), s)
  // …while an ordinary sentence stays usable as a memory
  for (const s of ['I prefer short posts', 'the password manager is 1Password', 'Use a password manager for the team', 'I reset my password yesterday', '密码管理器用 1Password', '密钥长度很重要',
    'He went to the token ring meeting', 'a token limit of 4096 per answer', 'Mail joe@example.com about the plan', 'Reach me at mailto:joe@example.com', 'The config is in core/workbench/lib/conversations.js',
    'psql -p 5432 mydb', 'mysql -p asks for the password when it starts', 'Prefers the workbench runs list', 'Answers in short bullet lists']) assert.ok(!isSecret(s), s)
  assert.equal(redact('call curl -u admin:hunter2 https://x now\nthe db password hunter2 ok\nuse 3f9a1b2c3d4e5f60718293a4b5c6d7e8f9012345 here'), 'call curl [redacted] https://x now\nthe db [redacted] ok\nuse [redacted] here')

  // ── keeping it in order: past the kept days the words stay, the tool calls and a board's rows go ──
  const day = 864e5, at = 1000 * day
  conv.add(MAIN, 'old-tool', { kind: 'tool', name: 'workbench_runs', target: '' }, at - 100 * day)
  conv.add(MAIN, 'new-tool', { kind: 'tool', name: 'workbench_runs', target: '' }, at - day)
  conv.add(MAIN, 'old-board', { kind: 'genui', args: { title: 'Runs', widgets: [{ view: 'count' }], data: { runs: { fields: {}, rows: [{ id: 1 }] } } } }, at - 100 * day)
  conv.add(MAIN, 'old-text', { kind: 'text', text: 'old words stay' }, at - 100 * day)
  assert.deepEqual(conv.sweep({ keepDays: 90, at }), { tools: 1, boards: 1 })
  assert.equal(conv.byKey('old-tool'), undefined)
  assert.ok(conv.byKey('new-tool'))
  assert.deepEqual([conv.byKey('old-board').compact, conv.byKey('old-board').args.data, conv.byKey('old-board').args.widgets.length], [1, undefined, 1], 'a board keeps its shape, not its rows')
  assert.equal(conv.byKey('old-text').text, 'old words stay')
  assert.deepEqual(conv.sweep({ keepDays: 90, at }), { tools: 0, boards: 0 }, 'once')
  assert.equal(conv.memories().length, 1, 'memories stay')
  assert.ok(conv.summaryLast(MAIN), 'summaries stay')

  // ── export: one thread as Markdown, everything as JSON lines (the sessions' state left out) ──
  const md = conv.exportThread(MAIN)
  assert.match(md, /^# Chat\n\nmain · [\d-]+ [\d:]+ → [\d-]+ [\d:]+\n\n\*\*You\*\* · 1970-01-01 00:00\n\nchanged words/)
  assert.match(md, /> Card: A 50% look_at \(blank\) — dismissed\n/)
  assert.equal(conv.exportThread('nope'), null)
  const lines = [...conv.exportAll()].map(l => JSON.parse(l))
  assert.deepEqual([...new Set(lines.map(l => l.type))], ['thread', 'entry', 'summary', 'memory'])
  assert.ok(lines.filter(l => l.type === 'thread').every(l => !('lane' in l)))
  assert.equal(lines.filter(l => l.type === 'entry' && l.thread === MAIN).length, conv.all(MAIN).length)
  // (`ruyix chat export` reads the file on its own: the same Markdown)
  const { markdown, threads, memories, jsonl } = await import('../shell/bin/ruyix-chat.mjs')
  const ro = new DatabaseSync(conv.file, { readOnly: true })
  assert.equal(markdown(ro, MAIN), md, 'the CLI writes what the workbench would')
  assert.deepEqual(threads(ro).map(t => t.id).sort(), [MAIN, 'task-1', 'task-2'])
  assert.equal(threads(ro).find(t => t.id === MAIN).entries, conv.all(MAIN).length)
  assert.equal(memories(ro).length, 1)
  assert.deepEqual([...jsonl(ro)], [...conv.exportAll()], 'and every conversation as the same JSON lines')
  ro.close()
  conv.close()

  // ── a home from before: the standing conversation in workbench.db's chat table is taken over, numbers and all ──
  const dir = join(tmp, 'legacy')
  openStore(dir).close() // (a store made now has no chat table)
  assert.deepEqual(openStore(dir).chatRows(), [], 'none: nothing to take over')
  const old = new DatabaseSync(join(dir, 'workbench.db'))
  old.exec('CREATE TABLE chat (n INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, data TEXT NOT NULL)')
  const put = old.prepare('INSERT INTO chat (n, key, at, data) VALUES (?, ?, ?, ?)')
  put.run(1, 'as-1:0', 1000, JSON.stringify({ kind: 'user', text: 'what is running?', sid: 'as-1' }))
  put.run(2, 'as-1:1', 1001, JSON.stringify({ kind: 'text', text: 'Two runs.', sid: 'as-1' }))
  put.run(5, 'as-1:2', 1002, JSON.stringify({ kind: 'draft', seq: 4, args: { workflow: 'blank', title: 'Look into it' }, sid: 'as-1' })) // (a gap in the numbers)
  put.run(6, 'topic:1:abc', 1003, JSON.stringify({ kind: 'topic' }))
  old.close()
  const store = openStore(dir)
  const rows = store.chatRows()
  assert.deepEqual(rows.map(r => r.n), [1, 2, 5, 6])
  const dest = openConversations(join(dir, 'conversations.db'))
  assert.equal(moveLegacy(dest, rows, 'fp1', 5000), 4)
  const moved = dest.page(MAIN).items
  assert.deepEqual(moved.map(i => [i.n, i.kind, i.at]), [[1, 'user', 1000], [2, 'text', 1001], [5, 'draft', 1002], [6, 'topic', 1003]], 'the same numbers, kinds and times')
  assert.equal(moved[0].text, 'what is running?')
  assert.equal(dest.thread(MAIN).kind, 'main')
  assert.equal(dest.find('running').length, 1, 'found by its words at once')
  assert.equal(dest.add(MAIN, 'as-1:3', { kind: 'text', text: 'next' }), 7, 'new entries go on after the last number')
  assert.equal(dest.add(MAIN, 'as-1:1', { kind: 'text', text: 'the session says it again' }), null, 'a session\'s entry read again is not made twice')
  assert.equal(moveLegacy(dest, rows, 'fp1', 5000), 0, 'moved once')
  // the card was decided meanwhile in the old record, the archive imported over this home: moved again, taking what became of it
  const again = rows.map(r => (r.n === 5 ? { ...r, data: JSON.stringify({ ...JSON.parse(r.data), outcome: { status: 'started', run: 'r1' } }) } : r))
  assert.equal(moveLegacy(dest, again, 'fp2', 6000), 4)
  assert.equal(dest.get(5).outcome.run, 'r1')
  assert.equal(dest.page(MAIN, { limit: 200 }).items.length, 5, 'nothing made twice')
  assert.equal(moveLegacy(dest, [], 'fp3'), 0, 'no old record: nothing')
  assert.equal(dest.meta('migrated'), 'fp2')
  dest.close()

  // an older archive imported over a home whose main thread has entries of its own: its chat does not mix into the main thread and
  // is not numbered after the newest message — it is a thread of its own, the main thread as it was
  const mine = openConversations(join(dir, 'mine.db'))
  mine.threadMake({ id: MAIN, kind: 'main', title: 'Chat' }, 10)
  for (let k = 1; k <= 8; k++) mine.add(MAIN, `now:${k}`, { kind: k % 2 ? 'user' : 'text', text: `today ${k}` }, 9000 + k)
  const before = mine.all(MAIN).map(i => [i.n, i.text])
  assert.equal(moveLegacy(mine, rows, 'fp9', Date.UTC(2026, 9, 12)), 4)
  assert.deepEqual(mine.all(MAIN).map(i => [i.n, i.text]), before, 'the main thread is as it was')
  const earlier = mine.thread('archive-fp9')
  assert.deepEqual([earlier.kind, earlier.title], ['archive', 'Earlier conversation (imported 2026-10-12)'])
  assert.deepEqual(mine.all('archive-fp9').map(i => [i.kind, i.at]), [['user', 1000], ['text', 1001], ['draft', 1002], ['topic', 1003]], 'in its own order, its own times')
  const nums = mine.all('archive-fp9').map(i => i.n)
  assert.ok(nums.every((n, k) => !k || n > nums[k - 1]) && nums[0] > 8, 'their numbers (1, 2, 5, 6) are taken here: numbered after the newest, in order')
  assert.equal(mine.find('running').length, 1, 'still found by its words')
  assert.equal(moveLegacy(mine, rows, 'fp9', 1), 0, 'moved once')
  // …the same chat imported again, all of it there already: no thread is made for nothing; a free number is kept when all are free
  assert.equal(moveLegacy(mine, rows, 'fp10', 2), 4)
  assert.deepEqual([mine.threads({ kind: 'archive' }).length, mine.all(MAIN).length], [1, 8])
  const spare = openConversations(join(dir, 'spare.db'))
  spare.threadMake({ id: MAIN, kind: 'main', title: 'Chat' }, 10)
  spare.add(MAIN, 'now:1', { kind: 'user', text: 'today' }, 9001, { n: 20 })
  assert.equal(moveLegacy(spare, rows, 'fp11', 3), 4)
  assert.deepEqual(spare.all('archive-fp11').map(i => i.n), [1, 2, 5, 6], 'their own numbers, when all are free')
  mine.close(); spare.close()
  store.close()
  console.log('conversations check: ok')
} finally { rmSync(tmp, { recursive: true, force: true }) }
