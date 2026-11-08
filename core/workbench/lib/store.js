// Workbench store: documents (runs, approvals) under one `rev` for the panel's delta sync, plus the evidence ledger —
// append-only, one SHA-256 hash chain per run. (The conversations are in conversations.db: lib/conversations.js.)
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const sha256 = data => createHash('sha256').update(data).digest('hex')
// The fields a hash covers, in a fixed order, so the chain can be re-checked by anyone with the db.
const sealed = e => JSON.stringify([e.run, e.seq, e.stage, e.kind, e.actor, e.at, e.title, e.input, e.output, e.code, e.ok, e.artifact, e.sha256, e.prev])
const HASH_CHUNK = 1024 * 1024
const fileHash = path => {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), chunk = Buffer.allocUnsafe(HASH_CHUNK)
  try {
    for (let n; (n = readSync(fd, chunk, 0, chunk.length, null));) hash.update(chunk.subarray(0, n))
    return hash.digest('hex')
  } finally { closeSync(fd) }
}
const fileHashAsync = async (path, signal) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: HASH_CHUNK, signal })) hash.update(chunk)
  return hash.digest('hex')
}
const artifactError = err => err.code === 'ENOENT' ? 'artifact missing' : 'artifact unreadable'

/** A run as the panel syncs it: each step's full result (a quarter of the bytes, repeating the run's own fields) is read on demand. */
const slim = d => (d.kind === 'run' && d.stages ? { ...d, stages: d.stages.map(s => (s.result ? { ...s, result: true } : s)) } : d)

export function openStore(dir) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'workbench.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (
      kind TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT, data TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, id));
    CREATE INDEX IF NOT EXISTS docs_rev ON docs (rev);
    CREATE TABLE IF NOT EXISTS evidence (
      run TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (run, seq));
    CREATE TABLE IF NOT EXISTS translations (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);
  `)
  let rev = db.prepare('SELECT COALESCE(MAX(rev), 0) AS r FROM docs').get().r
  const putStmt = db.prepare(`INSERT INTO docs (kind, id, run_id, data, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (kind, id) DO UPDATE SET run_id = excluded.run_id, data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at`)
  const getStmt = db.prepare('SELECT data FROM docs WHERE kind = ? AND id = ?')
  const lastStmt = db.prepare('SELECT seq, hash FROM evidence WHERE run = ? ORDER BY seq DESC LIMIT 1')
  const addStmt = db.prepare('INSERT INTO evidence (run, seq, data, hash) VALUES (?, ?, ?, ?)')
  const artifacts = join(dir, 'runs')

  const store = {
    dir,
    put(kind, doc) {
      const data = { ...doc, kind, updatedAt: Date.now() }
      putStmt.run(kind, doc.id, doc.runId ?? doc.id, JSON.stringify(data), ++rev, data.updatedAt)
      return data
    },
    get(kind, id) {
      const r = getStmt.get(kind, String(id))
      const d = r ? JSON.parse(r.data) : undefined
      return d?.deletedAt ? undefined : d
    },
    list(kind) {
      return db.prepare('SELECT data FROM docs WHERE kind = ? ORDER BY updated_at DESC').all(kind).map(r => JSON.parse(r.data)).filter(d => !d.deletedAt)
    },
    /**
     * A document gone (a task the person deleted, its runs): what is left is a mark, so every page's sync learns of it and
     * lets it go; get and list no longer see it. → whether there was one
     */
    remove(kind, id) {
      if (!store.get(kind, id)) return false
      const data = { id: String(id), kind, deletedAt: Date.now(), updatedAt: Date.now() }
      putStmt.run(kind, String(id), String(id), JSON.stringify(data), ++rev, data.updatedAt)
      return true
    },
    /** A deleted run's ledger and the files it kept (its artifacts) — gone. */
    purgeRun(run) {
      db.prepare('DELETE FROM evidence WHERE run = ?').run(String(run))
      const at = resolve(artifacts, String(run))
      if (at.startsWith(resolve(artifacts) + sep)) rmSync(at, { recursive: true, force: true })
    },
    /** The standing conversation as this db kept it before conversations.db (a `chat` table, only in homes from before): its rows, oldest first. */
    chatRows() {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat'").get()) return []
      return db.prepare('SELECT n, key, at, data FROM chat ORDER BY n').all()
    },
    /** The store's change counter: anything written (a document, an evidence entry) moves it on. */
    revision: () => rev,
    since(cursor, { kinds } = {}) {
      if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some(kind => typeof kind !== 'string'))) throw new TypeError('since kinds must be an array of document kind strings')
      // a cursor from before the db was replaced (ahead of it) gets everything again, not nothing forever
      const c = Number(cursor) || 0, from = c > rev ? 0 : c
      // Filter in SQL so internal documents are not read/decoded for a client that never consumes them.
      // The global cursor still advances through hidden writes, including when this page has no changed documents.
      const wanted = kinds === undefined ? null : [...new Set(kinds)]
      const rows = wanted?.length === 0 ? [] : db.prepare(`SELECT data FROM docs WHERE rev > ?${wanted ? ` AND kind IN (${wanted.map(() => '?').join(', ')})` : ''} ORDER BY rev`).all(from, ...(wanted || []))
      return { rev, ...(from !== c && { reset: true }), docs: rows.map(r => slim(JSON.parse(r.data))) }
    },

    /** Full output (text or bytes) goes to a file under runs/<run>/; the ledger keeps its path (run/name, with a forward
     * slash on every system: the ledger is sealed and moves between machines) and hash. */
    artifact(run, name, content) {
      const rel = `${run}/${name.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_')}`
      mkdirSync(join(artifacts, run), { recursive: true })
      writeFileSync(join(artifacts, rel), content)
      return { artifact: rel, sha256: sha256(content) }
    },
    readArtifact: (rel, encoding = 'utf8') => readFileSync(join(artifacts, rel), encoding),
    /** A run's artifact path on disk, or null when `rel` is not inside that run's folder under runs/. */
    artifactPath(run, rel) {
      const dir = resolve(artifacts, String(run)), full = resolve(artifacts, String(rel || ''))
      return dir !== artifacts && dirname(dir) === resolve(artifacts) && full.startsWith(dir + sep) ? full : null
    },

    /** Append one piece of evidence; `prev` links it to the run's previous entry. */
    addEvidence(run, entry) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const last = lastStmt.get(run)
        const e = {
          run, seq: (last?.seq ?? 0) + 1, stage: entry.stage ?? null, kind: entry.kind, actor: entry.actor ?? 'system', at: Date.now(),
          title: String(entry.title || entry.kind), input: entry.input ?? null, output: entry.output ?? '', code: entry.code ?? null, ok: entry.ok ?? null,
          artifact: entry.artifact ?? null, sha256: entry.sha256 ?? null, prev: last?.hash ?? '',
        }
        e.hash = sha256(sealed(e))
        addStmt.run(run, e.seq, JSON.stringify(e), e.hash)
        db.exec('COMMIT')
        ++rev
        return e
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    /** One entry by its number (not the rest of the ledger after it). */
    evidenceAt(run, seq) {
      const r = db.prepare('SELECT data FROM evidence WHERE run = ? AND seq = ?').get(run, Number(seq) || 0)
      return r ? JSON.parse(r.data) : undefined
    },
    evidence(run, after = 0) {
      return db.prepare('SELECT data FROM evidence WHERE run = ? AND seq > ? ORDER BY seq').all(run, Number(after) || 0).map(r => JSON.parse(r.data))
    },
    /** Re-derive every hash and re-read every artifact: any edit after the fact breaks the chain. */
    verify(run) {
      let prev = ''
      const all = store.evidence(run)
      for (const e of all) {
        const { hash, ...rest } = e
        if (rest.prev !== prev || sha256(sealed(rest)) !== hash) return { ok: false, seq: e.seq, reason: 'hash chain broken', count: all.length }
        if (e.artifact) {
          let digest
          try { digest = fileHash(join(artifacts, e.artifact)) } catch (err) { return { ok: false, seq: e.seq, reason: artifactError(err), count: all.length } }
          if (digest !== e.sha256) return { ok: false, seq: e.seq, reason: 'artifact changed', count: all.length }
        }
        prev = hash
      }
      return { ok: true, head: prev, count: all.length }
    },
    /** Live requests and reports stream a fixed-size chunk at a time, leaving the event loop free between reads.
     * A caller may supply the captured ledger it will display; the result verifies exactly that snapshot. */
    async verifyAsync(run, { evidence = store.evidence(run), signal } = {}) {
      let prev = ''
      for (const e of evidence) {
        signal?.throwIfAborted()
        const { hash, ...rest } = e
        if (rest.prev !== prev || sha256(sealed(rest)) !== hash) return { ok: false, seq: e.seq, reason: 'hash chain broken', count: evidence.length }
        if (e.artifact) {
          let digest
          try { digest = await fileHashAsync(join(artifacts, e.artifact), signal) }
          catch (err) { signal?.throwIfAborted(); return { ok: false, seq: e.seq, reason: artifactError(err), count: evidence.length } }
          if (digest !== e.sha256) return { ok: false, seq: e.seq, reason: 'artifact changed', count: evidence.length }
        }
        prev = hash
      }
      signal?.throwIfAborted()
      return { ok: true, head: prev, count: evidence.length }
    },
    /** Translation cache (not synced, not evidence): key = hash of model, language and text. */
    translations: {
      get: k => db.prepare('SELECT v FROM translations WHERE k = ?').get(k)?.v,
      put: (k, v) => { db.prepare('INSERT OR REPLACE INTO translations (k, v, at) VALUES (?, ?, ?)').run(k, v, Date.now()) },
    },
    close: () => db.close(),
  }
  return store
}

