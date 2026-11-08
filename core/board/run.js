// Running a dataset where its credentials are (this Ruyix, on the host or in its box). One run → one snapshot: the rows
// cut to the dataset's fields (shapeRows), their hash, the status — kept on this machine (the last good rows, the last
// run, the history points).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonical, historyPoint, parseDuration, renderParams, shapeRows } from './schema.js'

export const MAX_BYTES = 2 << 20 // the rows of one snapshot, as JSON: more is refused

/**
 * One run of a dataset. read(connection, op, params) → rows (connectors' read); script(ref, params) → rows (an
 * installed script's stdout; a host without one: none). → { dataset, version, at, status: ok|failed|too_large, rows?, count, hash,
 * error?, tookMs, bad }
 */
export async function runDataset(ds, { read, script, connection, settings = {}, now = Date.now } = {}) {
  const at = now(), base = { dataset: ds.name, version: ds.version, at }
  const done = extra => ({ ...base, tookMs: now() - at, ...extra })
  let raw
  try {
    const params = renderParams(ds.params, settings)
    const hole = Object.entries(params).find(([, v]) => v === null)
    if (hole) throw new Error(`settings: ${String(ds.params[hole[0]]).replace(/[{}\s]/g, '')} is not set`)
    if (ds.connector) {
      if (!connection) throw new Error('no connection is bound to this dataset')
      raw = await read(connection, ds.op, params)
    } else if (ds.script) {
      if (!script) throw new Error('this machine runs no dataset scripts')
      raw = await script(ds.script, params)
    } else throw new Error('a dataset needs a producer')
    if (!Array.isArray(raw)) throw new Error('the producer gave no rows')
  } catch (err) { return done({ status: 'failed', count: 0, hash: '', error: String(err.message).slice(0, 500), bad: [] }) }
  const { rows, bad } = shapeRows(raw, ds)
  const hash = createHash('sha256').update(canonical(rows, ds)).digest('hex')
  const bytes = Buffer.byteLength(JSON.stringify(rows))
  if (bytes > MAX_BYTES) return done({ status: 'too_large', count: rows.length, hash, error: `${(bytes / 1048576).toFixed(1)} MB of rows (at most 2 MB)`, bad })
  return done({ status: 'ok', rows, count: rows.length, hash, bad })
}

/** Is it time for this dataset: never run, its refresh since the last run, or someone asked after it (a refresh's at). */
export function due(ds, snap, { now = Date.now(), asked = 0 } = {}) {
  const last = snap?.last?.at || 0
  return !last || now - last >= parseDuration(ds.refresh) || asked > last
}

/**
 * This machine's snapshots, one file per dataset in `dir`: { ok: { at, count, hash, rows }, last: { at, status, error?,
 * tookMs }, history: [points] }. A failed run keeps the last good rows; history keeps `days` (the dataset's, at most 90).
 */
export function snapshotStore(dir) {
  const file = name => join(dir, `${name.replace(/[^\w.-]/g, '_')}.json`)
  const get = name => { try { return JSON.parse(readFileSync(file(name), 'utf8')) } catch { return null } }
  return {
    get,
    put(ds, run) {
      const was = get(ds.name) || {}
      const snap = {
        dataset: `${ds.name}@${ds.version}`,
        ok: run.status === 'ok' ? { at: run.at, count: run.count, hash: run.hash, rows: run.rows } : was.dataset === `${ds.name}@${ds.version}` ? was.ok : undefined,
        last: { at: run.at, status: run.status, ...(run.error && { error: run.error }), tookMs: run.tookMs },
        history: was.dataset === `${ds.name}@${ds.version}` ? was.history || [] : [], // another version's points are not this one's
      }
      if (run.status === 'ok' && ds.history) {
        const keep = Math.min(ds.history.days || 30, 90) * 864e5
        snap.history = [...snap.history.filter(h => h.at > run.at - keep), historyPoint(run.rows, ds, run.at)]
      }
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${file(ds.name)}.tmp`, JSON.stringify(snap))
      renameSync(`${file(ds.name)}.tmp`, file(ds.name))
      return snap
    },
  }
}
