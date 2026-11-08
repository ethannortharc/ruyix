// Messages between agents: one space is one SQLite file that every agent working together writes to and reads from — a
// hand-off, a decision that touches someone else's part, a question to another agent. Not a record of the work: no hash
// chain, nothing kept as evidence; a space goes when its run goes. Nothing here knows dsh: Ruyix gives each run a space
// (runs/<id>/messages.db), and agents on a Mac (Claude Code, Codex, …) share one through bin/agent-msg.mjs (its MCP
// server or its commands). Several processes use one file at once (WAL; a writer waits for another up to 5 s).
// Who reads what: every name has its own place (`cursors`): reading gives the messages after it that are for that name
// or for everyone, never its own, and moves the place on.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const LIMITS = { text: 4000, files: 20, path: 500, name: 64, topic: 64, read: 200, keep: 10000, waitS: 600 }
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sender TEXT NOT NULL, recipient TEXT,
    topic TEXT NOT NULL DEFAULT 'general', text TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]', reply_to INTEGER);
  CREATE INDEX IF NOT EXISTS messages_recipient ON messages (recipient, id);
  CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, upto INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL);`
const POLL_MS = 500

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const nameOf = (v, what) => {
  const s = String(v ?? '').trim()
  if (!s) fail('needName', `say who ${what === 'to' ? 'the message is for' : 'you are'}`)
  if (s.length > LIMITS.name || /\s/.test(s)) fail('badName', `${what}: one word of at most ${LIMITS.name} characters (${JSON.stringify(s.slice(0, 80))})`)
  return s
}
const shape = r => ({ id: Number(r.id), at: Number(r.at), from: r.sender, to: r.recipient ?? null, topic: r.topic, text: r.text, files: JSON.parse(r.files), replyTo: r.reply_to == null ? null : Number(r.reply_to) })

/** Where a space named on the command line or in AGENT_MSG_SPACE lives: a path as it is, a bare name in ~/.agent-messages (AGENT_MSG_HOME). */
export function spacePath(space = process.env.AGENT_MSG_SPACE || 'default', { home = process.env.AGENT_MSG_HOME || join(homedir(), '.agent-messages') } = {}) {
  const s = String(space)
  if (isAbsolute(s) || s.includes('/') || s.endsWith('.db')) return resolve(s)
  if (!/^[\w.-]{1,64}$/.test(s)) fail('badSpace', `a space is a name (letters, digits, . _ -) or a path: ${JSON.stringify(s.slice(0, 80))}`)
  return join(home, `${s}.db`)
}

/**
 * One space (its file made if it is not there; the folder only its owner's). keep: the newest this many messages stay
 * (older ones go as new ones come). → { file, post, read, wait, log, members, close }
 */
export function openSpace(file, { now = Date.now, keep = LIMITS.keep, pollMs = POLL_MS } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  const seen = db.prepare('INSERT INTO cursors (name, upto, seen) VALUES (?, 0, ?) ON CONFLICT (name) DO UPDATE SET seen = excluded.seen')
  const cursor = db.prepare('SELECT upto FROM cursors WHERE name = ?')
  const moveTo = db.prepare('UPDATE cursors SET upto = MAX(upto, ?) WHERE name = ?')
  const insert = db.prepare('INSERT INTO messages (at, sender, recipient, topic, text, files, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const unread = db.prepare(`SELECT * FROM messages WHERE id > ? AND sender <> ? AND (recipient IS NULL OR recipient = ?) AND (? IS NULL OR sender = ?) ORDER BY id LIMIT ?`)
  const trim = db.prepare('DELETE FROM messages WHERE id <= (SELECT MAX(id) FROM messages) - ?')

  const me = as => { const n = nameOf(as, 'as'); seen.run(n, now()); return n }
  const pending = (n, from, limit) => {
    const rows = unread.all(cursor.get(n)?.upto ?? 0, n, n, from, from, limit + 1)
    return { messages: rows.slice(0, limit).map(shape), more: rows.length > limit }
  }

  const space = {
    file,
    /** Post one message (to: one name; none: everyone). → the message */
    post({ from, to = null, topic = 'general', text, files = [], replyTo = null }) {
      const sender = me(from)
      const recipient = to == null || to === '' ? null : nameOf(to, 'to')
      const body = String(text ?? '').trim()
      if (!body) fail('needText', 'say something: the message is empty')
      if (body.length > LIMITS.text) fail('tooLong', `a message is at most ${LIMITS.text} characters (this one: ${body.length}) — put long text in a file and name the file`)
      const t = String(topic || 'general').trim()
      if (t.length > LIMITS.topic) fail('badTopic', `a topic is at most ${LIMITS.topic} characters`)
      if (!Array.isArray(files)) fail('badFiles', 'files: a list of paths')
      if (files.length > LIMITS.files) fail('badFiles', `at most ${LIMITS.files} files in one message`)
      const paths = files.map(f => String(f).trim()).filter(Boolean)
      if (paths.some(p => p.length > LIMITS.path)) fail('badFiles', `a path is at most ${LIMITS.path} characters`)
      const reply = replyTo == null || replyTo === '' ? null : Number(replyTo)
      if (reply !== null && !Number.isInteger(reply)) fail('badReply', 'replyTo: the number of the message this answers')
      const { lastInsertRowid } = insert.run(now(), sender, recipient, t, body, JSON.stringify(paths), reply)
      trim.run(keep)
      return shape(db.prepare('SELECT * FROM messages WHERE id = ?').get(lastInsertRowid))
    },
    /** What is new for `as` (for it or for everyone, not its own), oldest first; moves its place on unless `peek`. → { messages, more } */
    read({ as, limit = 50, peek = false }) {
      const n = me(as)
      const r = pending(n, null, Math.min(Math.max(1, Number(limit) || 50), LIMITS.read))
      if (!peek && r.messages.length) moveTo.run(r.messages.at(-1).id, n)
      return r
    },
    /**
     * Until something new is there for `as` (from one name, if given), at most `timeoutS` seconds (≤ 10 min: two agents
     * waiting on each other are not held for ever) or until `signal` aborts. → read()'s answer — everything new, not only
     * what `from` sent (one place per name: what is skipped would never be read) —, with timedOut when nothing came.
     */
    async wait({ as, from = null, timeoutS = 120, limit = 50, signal } = {}) {
      const n = me(as), who = from == null || from === '' ? null : nameOf(from, 'from')
      const until = Date.now() + Math.min(Math.max(1, Number(timeoutS) || 120), LIMITS.waitS) * 1000
      for (;;) {
        if (pending(n, who, 1).messages.length) return space.read({ as: n, limit })
        if (signal?.aborted || Date.now() >= until) return { messages: [], more: false, timedOut: true }
        await new Promise(ok => setTimeout(ok, Math.min(pollMs, Math.max(1, until - Date.now()))))
      }
    },
    /** Everything in the space (the newest `limit`, oldest first; before: only older than that number; after: only newer). */
    log({ topic = null, limit = 100, before = null, after = null } = {}) {
      const rows = db.prepare(`SELECT * FROM messages WHERE (? IS NULL OR topic = ?) AND (? IS NULL OR id < ?) AND (? IS NULL OR id > ?) ORDER BY id DESC LIMIT ?`)
        .all(topic, topic, before, before, after, after, Math.min(Math.max(1, Number(limit) || 100), 1000))
      return rows.reverse().map(shape)
    },
    /** Who has used the space: name, when last seen, how many it posted. */
    members() {
      return db.prepare(`SELECT c.name, c.seen, (SELECT COUNT(*) FROM messages m WHERE m.sender = c.name) AS posted FROM cursors c ORDER BY c.seen DESC`)
        .all().map(r => ({ name: r.name, seen: Number(r.seen), posted: Number(r.posted) }))
    },
    close() { db.close() },
  }
  return space
}
