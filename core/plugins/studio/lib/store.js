// A studio's own records (docs/design/studio.md): one SQLite file per studio (<home>/<id>/studio.db; WAL, so the page,
// the main agent's tools and a check can read while one writes). Each record of a collection is a JSON document with a
// revision; every change keeps the version before it (history), and a removed record stays, marked, until purged — a
// person's 「撤回」 and the main agent's mistakes both have a way back. Its materials (files people add) sit beside the
// file (<home>/<id>/materials/<id>.<ext>), listed in the same database.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const MATERIAL_MAX = 25 * 1024 * 1024
const KINDS = { image: /\.(png|jpe?g|gif|webp|avif|svg)$/i, markdown: /\.(md|markdown)$/i, pdf: /\.pdf$/i, video: /\.(mp4|mov|webm)$/i, text: /\.(txt|json|csv|ya?ml)$/i }
export const kindOf = name => Object.entries(KINDS).find(([, re]) => re.test(name))?.[0] || 'file'
export const newId = prefix => `${prefix}${randomBytes(5).toString('hex')}`

export function openStudioStore(dir, { now = Date.now } = {}) {
  mkdirSync(join(dir, 'materials'), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dir, 'studio.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS records (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, rev INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, removed_at INTEGER, PRIMARY KEY (coll, id));
    CREATE TABLE IF NOT EXISTS versions (coll TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, data TEXT, at INTEGER NOT NULL, by TEXT);
    CREATE INDEX IF NOT EXISTS versions_of ON versions (coll, id, rev);
    CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
      file TEXT NOT NULL, at INTEGER NOT NULL, by TEXT, removed_at INTEGER);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS feedback (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      run TEXT NOT NULL, stage TEXT NOT NULL, revision TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL, removed_at INTEGER);
    CREATE INDEX IF NOT EXISTS feedback_target ON feedback (run, stage, revision);
  `)
  const metaGet = db.prepare('SELECT value FROM meta WHERE key = ?'), metaSet = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  // one revision for the whole studio: a page asks "anything since N?" with one number
  const rev = () => Number(metaGet.get('rev')?.value || 0)
  const bump = () => { const r = rev() + 1; metaSet.run('rev', String(r)); return r }
  const shape = row => ({ id: row.id, ...JSON.parse(row.data), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), rev: Number(row.rev), ...(row.removed_at != null && { removedAt: Number(row.removed_at) }) })
  const one = db.prepare('SELECT * FROM records WHERE coll = ? AND id = ?')
  const upsert = db.prepare(`INSERT INTO records (coll, id, data, rev, created_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at, removed_at = NULL`)
  const keep = db.prepare('INSERT INTO versions (coll, id, rev, data, at, by) VALUES (?, ?, ?, ?, ?, ?)')
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v } catch (err) { db.exec('ROLLBACK'); throw err } }

  return {
    dir,
    rev,
    /** A collection's records, newest change first (removed ones only with `removed`). */
    list(coll, { removed = false } = {}) {
      return db.prepare(`SELECT * FROM records WHERE coll = ? ${removed ? '' : 'AND removed_at IS NULL'} ORDER BY updated_at DESC, id`).all(coll).map(shape)
    },
    get(coll, id) { const r = one.get(coll, String(id)); return r && r.removed_at == null ? shape(r) : null },
    has: (coll, id) => !!one.get(coll, String(id)) && one.get(coll, String(id)).removed_at == null,
    /** Keep a record's fields (already checked): a new one gets an id (prefix + random), a changed one its last version kept. → the record */
    put(coll, id, data, { by = 'person', prefix = 'r' } = {}) {
      return tx(() => {
        const at = now(), was = id ? one.get(coll, String(id)) : null
        const key = id ? String(id) : newId(prefix)
        if (was) keep.run(coll, key, Number(was.rev), was.data, at, by)
        const r = bump()
        upsert.run(coll, key, JSON.stringify(data), r, was ? Number(was.created_at) : at, at)
        return shape(one.get(coll, key))
      })
    },
    /** Mark it removed (its last version kept); `restore` takes it back. */
    remove(coll, id, { by = 'person' } = {}) {
      return tx(() => {
        const was = one.get(coll, String(id))
        if (!was || was.removed_at != null) return false
        const at = now()
        keep.run(coll, String(id), Number(was.rev), was.data, at, by)
        db.prepare('UPDATE records SET removed_at = ?, rev = ?, updated_at = ? WHERE coll = ? AND id = ?').run(at, bump(), at, coll, String(id))
        return true
      })
    },
    restore(coll, id, { by = 'person' } = {}) {
      return tx(() => {
        const was = one.get(coll, String(id))
        if (!was || was.removed_at == null) return null
        db.prepare('UPDATE records SET removed_at = NULL, rev = ?, updated_at = ? WHERE coll = ? AND id = ?').run(bump(), now(), coll, String(id))
        keep.run(coll, String(id), Number(was.rev), was.data, now(), by)
        return shape(one.get(coll, String(id)))
      })
    },
    /** A record's earlier versions, newest first: { rev, at, by, data }. */
    history(coll, id, { limit = 50 } = {}) {
      return db.prepare('SELECT * FROM versions WHERE coll = ? AND id = ? ORDER BY rowid DESC LIMIT ?').all(coll, String(id), Math.min(Number(limit) || 50, 500))
        .map(v => ({ rev: Number(v.rev), at: Number(v.at), by: v.by, data: v.data ? JSON.parse(v.data) : null }))
    },
    /** A note of its own (e.g. a reminder seen: which time of which record). */
    note: key => metaGet.get(`note:${key}`)?.value ?? null,
    setNote: (key, value) => metaSet.run(`note:${key}`, String(value)),
    feedback({ run = null } = {}) {
      return db.prepare(`SELECT * FROM feedback WHERE removed_at IS NULL ${run ? 'AND run = ?' : ''} ORDER BY seq DESC`)
        .all(...(run ? [run] : [])).map(r => ({ ...JSON.parse(r.data), id: r.id, at: Number(r.at), seq: Number(r.seq) }))
    },
    putFeedback(data) {
      return tx(() => {
        const id = newId('f'), at = now()
        // Replace this run/stage's current opinion, preserving the earlier version-bound event for audit.
        db.prepare('UPDATE feedback SET removed_at = ? WHERE run = ? AND stage = ? AND removed_at IS NULL').run(at, data.run, data.stage)
        const row = db.prepare('INSERT INTO feedback (id, run, stage, revision, data, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, data.run, data.stage, data.revision, JSON.stringify(data), at)
        bump()
        return { ...data, id, at, seq: Number(row.lastInsertRowid) }
      })
    },
    removeFeedback(id) {
      return tx(() => {
        const r = db.prepare('UPDATE feedback SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(now(), id)
        if (r.changes) bump()
        return !!r.changes
      })
    },
    setPreferenceLearning(enabled) { return tx(() => { metaSet.run('note:preferences:enabled', String(enabled)); bump() }) },
    /** Was this collection's first fill done (seed: once, even if its records are later all removed)? */
    seeded: coll => metaGet.get(`seeded:${coll}`)?.value === '1',
    markSeeded: coll => metaSet.run(`seeded:${coll}`, '1'),
    // ── materials: the files people add (the ones its runs made are the workbench's: listed beside, not copied) ──
    materials() {
      return db.prepare('SELECT * FROM materials WHERE removed_at IS NULL ORDER BY at DESC').all().map(m => ({ id: m.id, name: m.name, kind: m.kind, size: Number(m.size), at: Number(m.at), by: m.by }))
    },
    addMaterial(name, bytes, { by = 'person' } = {}) {
      const clean = String(name || 'file').replace(/[/\\\0]/g, '_').slice(-120) || 'file'
      if (bytes.length > MATERIAL_MAX) throw Object.assign(new Error(`a material is at most ${MATERIAL_MAX / 1024 / 1024} MB`), { code: 'tooBig' })
      const id = newId('m'), file = `${id}${extname(clean).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8)}`
      writeFileSync(join(dir, 'materials', file), bytes, { mode: 0o600 })
      db.prepare('INSERT INTO materials (id, name, kind, size, file, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, clean, kindOf(clean), bytes.length, file, now(), by)
      bump()
      return { id, name: clean, kind: kindOf(clean), size: bytes.length }
    },
    /** A material's bytes and name (null: not one of its own). */
    material(id) {
      const m = db.prepare('SELECT * FROM materials WHERE id = ? AND removed_at IS NULL').get(String(id))
      if (!m) return null
      try { return { name: m.name, kind: m.kind, bytes: readFileSync(join(dir, 'materials', m.file)) } } catch { return null }
    },
    removeMaterial(id) {
      const m = db.prepare('SELECT * FROM materials WHERE id = ? AND removed_at IS NULL').get(String(id))
      if (!m) return false
      db.prepare('UPDATE materials SET removed_at = ? WHERE id = ?').run(now(), m.id)
      bump()
      return true
    },
    /** Removed materials' files gone for good (their rows stay: a record naming one says it is gone). */
    purgeMaterials() { for (const m of db.prepare('SELECT file FROM materials WHERE removed_at IS NOT NULL').all()) rmSync(join(dir, 'materials', m.file), { force: true }) },
    close() { db.close() },
  }
}
