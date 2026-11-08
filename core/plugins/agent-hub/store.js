// Local SQLite store: a mirror of dsh session state plus the hub's own documents
// (agents, jobs, tasks; the old teams), all under one global `rev` so the Web panel can
// delta-sync everything with a single cursor.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const DB_FILE = join(process.env.DSH_AGENT_HUB_HOME || join(homedir(), '.ruyix/agent-hub'), 'hub.db')
const MAX_AGE = 30 * 864e5
const CUT = 2000
/** A task as the panel syncs it: a long brief or report cut (the task op reads it whole when the task is opened). */
const slim = d => (d.kind === 'task' && (d.task?.length > CUT || d.output?.length > CUT)
  ? { ...d, ...(d.task?.length > CUT && { task: d.task.slice(0, CUT), taskCut: true }), ...(d.output?.length > CUT && { output: d.output.slice(0, CUT), outputCut: true }) }
  : d)

export function openStore(file = DB_FILE) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, parent_id TEXT, cwd TEXT, running INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS sessions_rev ON sessions (rev);
    CREATE TABLE IF NOT EXISTS docs (
      kind TEXT NOT NULL, id TEXT NOT NULL, team_id TEXT, data TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, id));
    CREATE INDEX IF NOT EXISTS docs_rev ON docs (rev);
    CREATE INDEX IF NOT EXISTS docs_team ON docs (team_id);
  `)
  let rev = Math.max(
    db.prepare('SELECT COALESCE(MAX(rev), 0) AS r FROM sessions').get().r,
    db.prepare('SELECT COALESCE(MAX(rev), 0) AS r FROM docs').get().r,
  )
  const getRow = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const putRow = db.prepare(`INSERT INTO sessions (id, parent_id, cwd, running, created_at, updated_at, rev, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, cwd = excluded.cwd,
    running = excluded.running, created_at = excluded.created_at, updated_at = excluded.updated_at, rev = excluded.rev, data = excluded.data`)
  const getDocStmt = db.prepare('SELECT data FROM docs WHERE kind = ? AND id = ?')
  const putDocStmt = db.prepare(`INSERT INTO docs (kind, id, team_id, data, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (kind, id) DO UPDATE SET team_id = excluded.team_id, data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at`)
  const pending = new Map()
  let timer = null

  const load = id => {
    if (pending.has(id)) return pending.get(id)
    const row = getRow.get(id)
    return row ? { ...row, data: JSON.parse(row.data) } : { id, parent_id: null, cwd: null, running: 0, created_at: null, updated_at: 0, data: {} }
  }
  // ponytail: one 250ms write batch for session mirror changes; per-session debounce if write volume ever matters
  const flush = () => {
    clearTimeout(timer); timer = null
    if (!pending.size) return
    db.exec('BEGIN')
    try {
      for (const row of pending.values()) {
        putRow.run(row.id, row.parent_id, row.cwd, row.running, row.created_at, row.updated_at, ++rev, JSON.stringify(row.data))
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    pending.clear()
  }
  const parseDoc = r => ({ ...JSON.parse(r.data), kind: r.kind })

  return {
    /** Merge a change into a mirrored session row (batched). */
    touch(id, change, { bump = true } = {}) {
      const row = load(id)
      change(row)
      if (bump || !row.updated_at) row.updated_at = Date.now()
      pending.set(id, row)
      timer ??= setTimeout(flush, 250)
    },
    flush,
    running: () => (flush(), db.prepare('SELECT id FROM sessions WHERE running = 1').all().map(r => r.id)),

    /** Documents (kind = agent | config | job | task | session; team, from before the pool), written immediately; grouped by job. */
    putDoc(kind, doc) {
      const data = { ...doc, ...(kind === 'agent' && { revision: rev + 1 }), updatedAt: Date.now() }
      putDocStmt.run(kind, doc.id, doc.jobId ?? doc.teamId ?? doc.id, JSON.stringify(data), ++rev, data.updatedAt)
      return data
    },
    getDoc(kind, id) {
      const r = getDocStmt.get(kind, id)
      return r ? JSON.parse(r.data) : undefined
    },
    docs(kind, teamId) {
      const rows = teamId === undefined
        ? db.prepare('SELECT data FROM docs WHERE kind = ? ORDER BY updated_at').all(kind)
        : db.prepare('SELECT data FROM docs WHERE kind = ? AND team_id = ? ORDER BY updated_at').all(kind, teamId)
      return rows.map(r => JSON.parse(r.data))
    },

    /** Everything changed after `cursor`: session rows and documents. */
    since(cursor) {
      flush()
      const floor = cursor ? 0 : Date.now() - MAX_AGE
      // only the Leads' sessions: the panel shows no other (every dsh chat's activity would ride along otherwise)
      const rows = db.prepare("SELECT * FROM sessions WHERE rev > ? AND updated_at > ? AND id IN (SELECT json_extract(data, '$.leadId') FROM docs WHERE kind = 'job') ORDER BY rev").all(cursor, floor)
      // agents, sessions and the hub's settings are standing: an agent nobody edited for a month is still in the pool
      const docs = db.prepare("SELECT * FROM docs WHERE rev > ? AND (updated_at > ? OR kind IN ('agent', 'config', 'session')) ORDER BY rev").all(cursor, floor)
      return {
        rev,
        rows: rows.map(r => ({ id: r.id, parentId: r.parent_id, cwd: r.cwd, running: !!r.running, createdAt: r.created_at, updatedAt: r.updated_at, data: JSON.parse(r.data) })),
        docs: docs.map(r => slim(parseDoc(r))),
      }
    },

    /** Jobs that ended before `before`, with their tasks, out of the store (agents stay). Returns how many jobs. */
    prune(before) {
      const old = db.prepare("SELECT id FROM docs WHERE kind = 'job' AND json_extract(data, '$.endedAt') < ?").all(before).map(r => r.id)
      const del = db.prepare("DELETE FROM docs WHERE (kind = 'task' AND team_id = ?) OR (kind = 'job' AND id = ?)")
      db.exec('BEGIN')
      try { for (const id of old) del.run(id, id); db.exec('COMMIT') } catch (err) { db.exec('ROLLBACK'); throw err }
      return old.length
    },
    dir: dirname(file),
    close: () => { flush(); db.close() },
  }
}
