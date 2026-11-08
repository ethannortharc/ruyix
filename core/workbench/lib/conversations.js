// The conversations' record: every thread (the standing conversation, the background tasks it starts), their entries
// found by words (SQLite FTS5), the summaries of what was said, and what the conversations came to remember. One file
// (<the workbench's home>/conversations.db); `ruyix data` moves it with the runs, `ruyix chat` reads and writes it out.
// Before it, the standing conversation lived in workbench.db's `chat` table: `moveLegacy` takes those rows over, numbers
// and all.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const VERSION = 1
export const MAIN = 'main'
const DAY = 864e5
const SCHEMA = `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent TEXT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idle',
    agent TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, lane TEXT NOT NULL DEFAULT '{}');
  CREATE INDEX threads_kind ON threads (kind, updated);
  CREATE INDEX threads_parent ON threads (parent, created);
  CREATE TABLE entries (
    n INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, at INTEGER NOT NULL,
    words TEXT NOT NULL DEFAULT '', data TEXT NOT NULL);
  CREATE INDEX entries_thread ON entries (thread, n);
  CREATE INDEX entries_at ON entries (at);
  CREATE VIRTUAL TABLE entries_fts USING fts5(words, content='entries', content_rowid='n', tokenize='trigram');
  CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entries_fts (rowid, words) VALUES (new.n, new.words); END;
  CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN INSERT INTO entries_fts (entries_fts, rowid, words) VALUES ('delete', old.n, old.words); END;
  CREATE TRIGGER entries_au AFTER UPDATE OF words ON entries BEGIN
    INSERT INTO entries_fts (entries_fts, rowid, words) VALUES ('delete', old.n, old.words); INSERT INTO entries_fts (rowid, words) VALUES (new.n, new.words); END;
  CREATE TABLE summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, upto INTEGER NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
  CREATE INDEX summaries_thread ON summaries (thread, upto);
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', by TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, used INTEGER, uses INTEGER NOT NULL DEFAULT 0);
  CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='id', tokenize='trigram');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts (rowid, text) VALUES (new.id, new.text); END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
  CREATE TRIGGER memories_au AFTER UPDATE OF text ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.id, old.text); INSERT INTO memories_fts (rowid, text) VALUES (new.id, new.text); END;
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`
export const MEMORY_KINDS = ['preference', 'fact', 'decision']

// ── what reads as a credential: never kept as a memory, taken out of a summary ──
// a whole private key block (first, so a label before it takes none of it); a key with its value — an Authorization
// header, key = value, "the password for the database is …", 密码是 … — taken out to the end of its line, however the
// value is written (quoted, several words, a scheme and its parameters); a bearer token, a token by its maker's prefix,
// a JWT, a URL with a password; a credential word with its value after only a space ("the staging DB password hunter2",
// "NAS 的 root 密码 Zx9!kq"), a long random-looking string (RANDOM_SRC), user:pass@ without a scheme, `-u user:pass`, mysql's
// `-p<password>`. Rather a plain sentence kept out than a credential kept.
const PEM_SRC = '-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY[A-Z ]*-----|$)'
// (a noun that follows a credential word in an ordinary sentence: "the password manager is 1Password", "a token limit")
const PLAIN_NOUN = '(?:manager|policy|policies|reset|field|fields|strength|rules?|hint|requirements?|length|change|expir\\w*|prompt|protected|vault|limit|count|budget)\\b'
// a word that is not plain letters only: a digit or a sign in it ("hunter2", "Zx9!kq")
const VALUE = '\\S*[\\d!@#$%^&*+=~/\\\\|<>?]\\S*'
const CRED_WORD = '(?:pass(?:words?|wds?|phrases?)|pwd|tokens?|secrets?|api[ _-]?keys?|access[ _-]?keys?|private[ _-]?keys?|credentials?)'
const SECRET_SRC = '(?:proxy-)?authorization["\'*_`]{0,3}\\s*[:=][^\\n]*'
  + '|(?:pass(?:words?|wds?|phrases?)?|pwd|tokens?|secrets?|api[_-]?keys?|access[_-]?keys?|private[_ -]?keys?|credentials?|auth)["\'*_`]{0,3}\\s*[:=]\\s*\\S[^\\n]*'
  + `|\\b(?:pass(?:words?|wds?|phrases?)?|tokens?|secrets?|api[ _-]?keys?|credentials?)\\b(?!\\s+${PLAIN_NOUN})[^\\n]{0,60}?(?:\\s(?:is|was|are|were)\\s|\\s*[:=])\\s*\\S[^\\n]*`
  + `|\\b${CRED_WORD}\\b(?!\\s+${PLAIN_NOUN})[ \\t]+${VALUE}`
  + `|(?:密码|口令|密钥|秘钥|私钥|令牌|凭据|凭证|访问码)[ \\t]*(?:[\\x21-\\x7e]*[\\d!@#$%^&*+=~/\\\\|<>?][\\x21-\\x7e]*|[\\x21-\\x7e]{4,})`
  + '|(?:密码|口令|密钥|秘钥|私钥|令牌|凭据|凭证|访问码)[^\\n:：=]{0,8}?(?:是|为|[:：=])\\s*\\S[^\\n]*'
  + '|\\bbearer\\s+[\\w.~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY'
  + '|\\b(?:glpat-|ghp_|gho_|github_pat_|xox[abpr]-|sk-|AKIA)[\\w-]{8,}|\\beyJ[\\w-]{10,}\\.[\\w-]{10,}|\\b[a-z][\\w+.-]*://[^\\s/:@]*:[^\\s/@]+@'
  // user:pass@host with no scheme (a mailto: address is not one)
  + '|\\b(?!mailto:)[\\w.+-]+:[^\\s:@/]{2,}@[\\w-]+(?:\\.[\\w-]+)*'
  // `-u user:pass` / `--user user:pass` (curl and the like)
  + '|(?<!\\S)(?:-u|--user)[\\s=]+[\\w.@+-]+:\\S+'
  // mysql's `-p<password>` right after the command (a space after -p asks for it: no password written)
  + '|\\b(?:mysql|mysqldump|mysqladmin|mysqlsh|mysqlcheck|mariadb|mycli)\\b[^\\n]*?\\s-p\\S+|\\bsshpass\\b[^\\n]*?\\s-p\\s*\\S+'
// a long random-looking string, as a key or a token is: 32+ hex; 20+ letters and digits that mix upper, lower and digits
// (a base64 key of 24+ has all three, with + / =). Case matters here, so it is its own pattern, not SECRET_SRC's.
const RANDOM_SRC = '(?<![\\w+/])[0-9a-fA-F]{32,}(?![\\w+/])|(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\\d)[A-Za-z0-9+/]{20,}={0,2}(?![A-Za-z0-9+/])'
// a Basic credential on its own: base64 that reads as user:password ("Basic configuration" is English)
const BASIC_SRC = '\\bbasic\\s+([A-Za-z0-9+/]{2,}={0,2})(?![\\w+/=])'
const userPass = b64 => { const s = Buffer.from(b64, 'base64').toString('utf8'); return !s.includes('�') && /^[^\x00-\x1f\x7f:]*:[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]*$/.test(s) }
export const isSecret = s => new RegExp(SECRET_SRC, 'i').test(String(s || '')) || new RegExp(RANDOM_SRC).test(String(s || '')) || [...String(s || '').matchAll(new RegExp(BASIC_SRC, 'gi'))].some(m => userPass(m[1]))
export const redact = s => String(s || '').replace(new RegExp(PEM_SRC, 'g'), '[redacted]').replace(new RegExp(SECRET_SRC, 'gi'), '[redacted]').replace(new RegExp(RANDOM_SRC, 'g'), '[redacted]')
  .replace(new RegExp(BASIC_SRC, 'gi'), (m, b64) => (userPass(b64) ? '[redacted]' : m))

/** The words an entry is found by (a message, a card's title and request, a workflow, a run, a change, a task) — never the record's own names. */
export const wordsOf = i => (['draft', 'workflow', 'run', 'change'].includes(i.kind) ? [i.args?.title, i.args?.text, i.args?.workflow, i.args?.id, i.args?.run, i.args?.summary]
  : i.kind === 'runop' ? [i.args?.run, i.args?.step, i.args?.path, i.args?.then, i.args?.note, i.args?.why]
  : i.kind === 'task' ? [i.title, i.result] : ['user', 'text', 'error'].includes(i.kind) ? [i.text] : []).filter(x => typeof x === 'string' && x).join('\n').slice(0, 20000)
// a phrase for FTS5 (trigram: a substring of at least three characters); shorter words go through LIKE on the same column
const phrase = q => `"${q.replaceAll('"', '""')}"`
const like = q => `%${q.replace(/[%_\\]/g, m => `\\${m}`)}%`
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
// (a memory is one line: it is told inside a brief, where a line of dashes ends the brief)
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 1000)

export function openConversations(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  if (db.prepare('PRAGMA user_version').get().user_version < 1) {
    // (auto_vacuum only takes before the first table: the sweep gives back what it compacts)
    db.exec('PRAGMA auto_vacuum = INCREMENTAL')
    db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${VERSION}; COMMIT;`)
  }
  db.exec('PRAGMA journal_mode = WAL')
  const row = r => (r ? { ...JSON.parse(r.data), n: r.n, at: r.at, thread: r.thread } : undefined)
  const threadRow = r => (r ? { ...r, lane: JSON.parse(r.lane || '{}') } : undefined)
  const q = sql => db.prepare(sql)
  const addStmt = q('INSERT OR IGNORE INTO entries (n, thread, key, kind, at, words, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
  let depth = 0 // (one transaction however deep the calls go)
  const tx = fn => {
    if (depth) return fn()
    db.exec('BEGIN'); depth = 1
    try { const r = fn(); db.exec('COMMIT'); return r } catch (err) { db.exec('ROLLBACK'); throw err } finally { depth = 0 }
  }

  const c = {
    file,
    tx,
    meta: k => q('SELECT v FROM meta WHERE k = ?').get(String(k))?.v ?? null,
    setMeta: (k, v) => { q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(String(k), String(v)) },

    // ── threads ──
    thread: id => threadRow(q('SELECT * FROM threads WHERE id = ?').get(String(id))),
    /** A thread made once (its id is its own), or the one there already. */
    threadMake({ id, kind, parent = null, title = '', status = 'idle', agent = null, lane = {} }, at = Date.now()) {
      q('INSERT OR IGNORE INTO threads (id, kind, parent, title, status, agent, created, updated, lane) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(String(id), kind, parent, String(title).slice(0, 200), status, agent, at, at, JSON.stringify(lane))
      return c.thread(id)
    },
    /** Some of its fields: title, status, agent, lane (a function of the lane, or the lane). */
    threadSet(id, patch, at = Date.now()) {
      const t = c.thread(id)
      if (!t) return undefined
      const lane = typeof patch.lane === 'function' ? patch.lane(t.lane) : patch.lane ?? t.lane
      q('UPDATE threads SET title = ?, status = ?, agent = ?, lane = ?, updated = ? WHERE id = ?')
        .run(String(patch.title ?? t.title).slice(0, 200), patch.status ?? t.status, patch.agent === undefined ? t.agent : patch.agent, JSON.stringify(lane), at, t.id)
      return c.thread(id)
    },
    /** Threads of a kind, a parent's or in a state, newest first (`oldest`: oldest first). */
    threads({ kind, parent, status, oldest = false, limit = 50 } = {}) {
      const where = [kind && 'kind = :kind', parent && 'parent = :parent', status && 'status = :status'].filter(Boolean)
      return q(`SELECT * FROM threads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${oldest ? 'created' : 'updated DESC'} LIMIT :limit`)
        .all({ ...(kind && { kind }), ...(parent && { parent }), ...(status && { status }), limit: Math.min(Math.max(Number(limit) || 50, 1), 5000) }).map(threadRow)
    },
    /** How many threads of a kind are in a state — or, given a `thread`, how many entries it has. */
    count: ({ kind, status, thread }) => (thread ? q('SELECT count(*) n FROM entries WHERE thread = ?').get(String(thread)).n : q('SELECT count(*) n FROM threads WHERE kind = ? AND status = ?').get(kind, status).n),

    // ── entries ──
    /** One entry, once per key: → its number (null: that key is there already). `n`: the number it keeps, when free (a move). */
    add(thread, key, item, at = Date.now(), { n = null } = {}) {
      const { n: _n, at: _at, thread: _t, ...data } = item
      const free = n !== null && Number.isSafeInteger(Number(n)) && Number(n) > 0 && !q('SELECT 1 FROM entries WHERE n = ?').get(Number(n))
      const r = addStmt.run(free ? Number(n) : null, String(thread), String(key), String(item.kind), Number(at) || Date.now(), wordsOf(item), JSON.stringify(data))
      if (r.changes) q('UPDATE threads SET updated = MAX(updated, ?) WHERE id = ?').run(Number(at) || Date.now(), String(thread))
      return r.changes ? Number(r.lastInsertRowid) : null
    },
    get: n => row(q('SELECT * FROM entries WHERE n = ?').get(Number(n))),
    byKey: key => row(q('SELECT * FROM entries WHERE key = ?').get(String(key))),
    /** An entry changed (a card decided, a task's end). */
    set(n, item) {
      const { n: _n, at: _at, thread: _t, ...data } = item
      q('UPDATE entries SET kind = ?, words = ?, data = ? WHERE n = ?').run(String(item.kind), wordsOf(item), JSON.stringify(data), Number(n))
      return c.get(n)
    },
    /** A page of a thread, oldest first: the last `limit` before `before` (or the newest), or what came after `after` (of these kinds). */
    page(thread, { before, after, limit = 50, kinds = null } = {}) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 500), t = String(thread)
      const k = kinds ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : ''
      if (after !== undefined && after !== null) return { items: q(`SELECT * FROM entries WHERE thread = ? AND n > ?${k} ORDER BY n LIMIT ?`).all(t, Number(after) || 0, ...(kinds || []), n).map(row), more: null }
      const rows = before ? q(`SELECT * FROM entries WHERE thread = ? AND n < ?${k} ORDER BY n DESC LIMIT ?`).all(t, Number(before), ...(kinds || []), n + 1) : q(`SELECT * FROM entries WHERE thread = ?${k} ORDER BY n DESC LIMIT ?`).all(t, ...(kinds || []), n + 1)
      return { items: rows.slice(0, n).reverse().map(row), more: rows.length > n }
    },
    /** Every entry of a thread, oldest first. */
    all: thread => q('SELECT * FROM entries WHERE thread = ? ORDER BY n').all(String(thread)).map(row),
    /** The newest entry of a thread (of these kinds). */
    last(thread, kinds = null) {
      const k = kinds ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : ''
      return row(q(`SELECT * FROM entries WHERE thread = ?${k} ORDER BY n DESC LIMIT 1`).get(String(thread), ...(kinds || [])))
    },
    /** Entries whose words mention `text` (every thread, or one), newest first. */
    find(text, { thread = null, kinds = null, limit = 30 } = {}) {
      const s = String(text || '').trim()
      if (!s) return []
      const n = Math.min(Math.max(Number(limit) || 30, 1), 100), long = [...s].length >= 3
      const where = [thread && 'e.thread = :thread', kinds && `e.kind IN (${kinds.map((_, i) => `:k${i}`).join(', ')})`].filter(Boolean).map(w => ` AND ${w}`).join('')
      const sql = long
        ? `SELECT e.* FROM entries_fts f JOIN entries e ON e.n = f.rowid WHERE entries_fts MATCH :m${where} ORDER BY e.n DESC LIMIT :n`
        : `SELECT e.* FROM entries e WHERE e.words LIKE :m ESCAPE '\\'${where} ORDER BY e.n DESC LIMIT :n`
      return q(sql).all({ m: long ? phrase(s) : like(s), n, ...(thread && { thread: String(thread) }), ...Object.fromEntries((kinds || []).map((k, i) => [`k${i}`, k])) }).map(row)
    },

    // ── summaries: what a stretch of a thread came to, told to the session that follows it ──
    summaryAdd(thread, upto, text, at = Date.now()) { q('INSERT INTO summaries (thread, upto, at, text) VALUES (?, ?, ?, ?)').run(String(thread), Number(upto), at, String(text).slice(0, 8000)) },
    summaryLast: thread => q('SELECT * FROM summaries WHERE thread = ? ORDER BY upto DESC LIMIT 1').get(String(thread)) || null,

    // ── memories: what the conversations came to keep (every thread's) ──
    /** A memory, unless one with the same words is there already (or it reads as a credential): → its id (null: not added). */
    memoryAdd({ kind = 'fact', text, source = '', by = 'auto', pinned = false }, at = Date.now()) {
      const t = oneLine(text)
      if (!t || isSecret(t)) return null
      if (c.memoryFind(t, 5).some(m => norm(m.text) === norm(t))) return null
      const r = q('INSERT INTO memories (kind, text, source, by, pinned, created) VALUES (?, ?, ?, ?, ?, ?)').run(MEMORY_KINDS.includes(kind) ? kind : 'fact', t, String(source).slice(0, 200), by, pinned ? 1 : 0, at)
      return Number(r.lastInsertRowid)
    },
    /** The memories that mention any of the words (best first), or the latest ones. */
    memoryFind(text, limit = 10) {
      const n = Math.min(Math.max(Number(limit) || 10, 1), 100)
      const words = String(text || '').split(/[\s,，。;；:：]+/).filter(Boolean)
      const long = words.filter(w => [...w].length >= 3), short = words.filter(w => [...w].length < 3)
      if (!words.length) return q('SELECT * FROM memories ORDER BY pinned DESC, created DESC LIMIT ?').all(n)
      const found = long.length ? q('SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?').all(long.map(phrase).join(' OR '), n) : []
      if (short.length && found.length < n) {
        const seen = new Set(found.map(m => m.id))
        for (const m of q(`SELECT * FROM memories WHERE ${short.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ')} ORDER BY created DESC LIMIT ?`).all(...short.map(like), n)) if (!seen.has(m.id) && found.length < n) found.push(m)
      }
      return found
    },
    memories: ({ limit = 200 } = {}) => q('SELECT * FROM memories ORDER BY pinned DESC, created DESC LIMIT ?').all(Math.min(Number(limit) || 200, 1000)),
    memoryGet: id => q('SELECT * FROM memories WHERE id = ?').get(Number(id)),
    /** A memory changed: its words (never to a credential), its kind, pinned or not. */
    memorySet(id, { text, kind, pinned }) {
      const m = c.memoryGet(id)
      if (!m) return undefined
      const t = text === undefined ? m.text : oneLine(text) || m.text
      if (t !== m.text && isSecret(t)) return m
      q('UPDATE memories SET text = ?, kind = ?, pinned = ? WHERE id = ?').run(t, MEMORY_KINDS.includes(kind) ? kind : m.kind, pinned === undefined ? m.pinned : pinned ? 1 : 0, m.id)
      return c.memoryGet(id)
    },
    memoryDelete: id => q('DELETE FROM memories WHERE id = ?').run(Number(id)).changes > 0,
    memoryUsed(ids, at = Date.now()) { for (const id of ids) q('UPDATE memories SET used = ?, uses = uses + 1 WHERE id = ?').run(at, Number(id)) },
    /** What a new session is told it remembers: the pinned ones, then the most lately used or made, within `budget` characters. */
    memoryBrief(budget = 2000) {
      const out = []
      let size = 0
      for (const m of q('SELECT * FROM memories ORDER BY pinned DESC, COALESCE(used, created) DESC LIMIT 60').all()) {
        const l = `- (${m.kind}) ${m.text}`
        if (size + l.length > budget) break
        out.push(l); size += l.length + 1
      }
      return out.join('\n')
    },

    // ── keeping it in order ──
    /**
     * The record kept in order: past `keepDays` an entry keeps its words (a message, a card and what became of it) and
     * loses the rest (its tool calls, a board's rows). Summaries and memories stay. → what it did.
     */
    sweep({ keepDays = 90, at = Date.now() } = {}) {
      const old = at - keepDays * DAY
      const r = tx(() => ({
        tools: q("DELETE FROM entries WHERE kind = 'tool' AND at < ?").run(old).changes,
        boards: q("UPDATE entries SET data = json_set(json_remove(data, '$.args.data'), '$.compact', 1) WHERE kind = 'genui' AND at < ? AND json_extract(data, '$.compact') IS NULL").run(old).changes,
      }))
      db.exec('PRAGMA incremental_vacuum')
      return r
    },
    /** One thread as Markdown. */
    exportThread(id) {
      const t = c.thread(id)
      if (!t) return null
      return markdownOf(t, q('SELECT * FROM entries WHERE thread = ? ORDER BY n').iterate(t.id), row)
    },
    /** Every thread (its entries after it), the summaries and the memories: one JSON object a line, the sessions' state left out. */
    *exportAll() {
      for (const t of q('SELECT * FROM threads ORDER BY created').iterate()) {
        const { lane: _lane, ...thread } = t
        yield JSON.stringify({ type: 'thread', ...thread })
        for (const e of q('SELECT * FROM entries WHERE thread = ? ORDER BY n').iterate(t.id)) yield JSON.stringify({ type: 'entry', ...row(e) })
      }
      for (const s of q('SELECT * FROM summaries ORDER BY id').iterate()) yield JSON.stringify({ type: 'summary', ...s })
      for (const m of q('SELECT * FROM memories ORDER BY id').iterate()) yield JSON.stringify({ type: 'memory', ...m })
    },
    close: () => db.close(),
  }
  return c
}

const when = at => new Date(at).toISOString().slice(0, 16).replace('T', ' ')
/** A thread as Markdown: what was said, the cards and what became of them (`rows` and `row`: the entries as the database has them). */
export function markdownOf(t, rows, row) {
  const done = o => (o ? ` — ${o.status}${o.run ? ` ${o.run}` : ''}` : '')
  const out = [`# ${t.title || t.id}`, '', `${t.kind} · ${when(t.created)} → ${when(t.updated)}${t.agent ? ` · ${t.agent}` : ''}`, '']
  for (const e of rows) {
    const i = row(e)
    if (i.kind === 'user') out.push(`**You** · ${when(i.at)}`, '', i.text, '')
    else if (i.kind === 'text') out.push(`**Assistant** · ${when(i.at)}`, '', i.text, '')
    else if (i.kind === 'draft') out.push(`> Card: ${i.args?.title || ''} (${i.args?.workflow || ''})${done(i.outcome)}`, '')
    else if (i.kind === 'workflow') out.push(`> Workflow draft: ${i.args?.title || i.args?.id || ''}`, '')
    else if (i.kind === 'runop') out.push(`> Card: ${i.args?.op === 'rewind' ? `back to before ${i.args?.step}` : i.args?.op === 'edit' ? `change ${i.args?.path}` : `go on from ${i.args?.step}`} in run ${i.args?.run || ''}${done(i.outcome)}`, '')
    else if (i.kind === 'run') out.push(`> Run started: ${i.args?.run || ''} ${i.args?.title || ''}`.trimEnd(), '')
    else if (i.kind === 'change') out.push(`> Change proposed: ${i.args?.summary || ''}`, '')
    else if (i.kind === 'task') out.push(`> Background task: ${i.title} — ${i.status || ''}${i.result ? `\n>\n> ${String(i.result).replace(/\n/g, '\n> ')}` : ''}`, '')
    else if (i.kind === 'topic') out.push('---', '')
    else if (i.kind === 'error') out.push(`> ${i.text}`, '')
  }
  return out.join('\n')
}

/**
 * The standing conversation as workbench.db's `chat` table kept it (rows { n, key, at, data }), taken into the main thread
 * with its numbers and keys — a run's tag, a link, a page's place all name them. Moved again when what it is moved from is
 * another (an archive from before, imported over it): `fingerprint` says which it was; an entry there already takes what
 * became of its card meanwhile, never made twice. A main thread that has entries of its own is not mixed with an older
 * archive's: the rows it lacks go into a thread of their own ("Earlier conversation (imported <date>)", kind `archive`),
 * with their numbers when all are free, else after the newest (entry numbers are one sequence for every thread; their order
 * is kept). → how many rows were looked at.
 */
export function moveLegacy(conv, rows, fingerprint, now = Date.now()) {
  if (!rows.length || conv.meta('migrated') === fingerprint) return 0
  conv.tx(() => {
    const had = conv.count({ thread: MAIN }) > 0 // (before this move: the main thread has a record of its own)
    conv.threadMake({ id: MAIN, kind: 'main', title: 'Chat' }, now)
    const into = had ? `archive-${fingerprint}` : MAIN
    const keep = !had || rows.every(r => !conv.get(r.n))
    for (const r of rows) {
      const item = JSON.parse(r.data)
      // (made with its first row: an archive whose rows are all there already makes none)
      if (had && !conv.byKey(r.key)) conv.threadMake({ id: into, kind: 'archive', title: `Earlier conversation (imported ${new Date(now).toISOString().slice(0, 10)})`, status: 'done' }, now)
      if (conv.add(into, r.key, item, r.at, { n: keep ? r.n : null }) !== null) continue
      const there = conv.byKey(r.key)
      if (there && !there.outcome && item.outcome) conv.set(there.n, { ...there, outcome: item.outcome })
    }
    conv.setMeta('migrated', fingerprint)
  })
  return rows.length
}
