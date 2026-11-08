// Run history from one Ruyix to another — a host's into a nookbox box, one box into the next:
//   ruyix data export [--out ruyix-data.tar.gz]          the workbench's runs and evidence, the conversations (and what they
//                                                    remember), Agent Hub's sessions and jobs
//   ruyix data import <ruyix-data.tar.gz> [--replace]    into this home (ruyix stopped): run records and Agent Hub's take
//                                                    this home's paths; --replace when this home has runs of its own (an export from
//                                                    before the conversations had a file of their own empties this home's too)
// The configuration travels on its own (ruyix config export / import, nookbox up --config). Left out: the runs' worktrees
// (a finished run's code is on its branch), dsh's own conversation history, agent logins (nookbox login in a box).
// Evidence is sealed (each entry hashed into the next): it moves exactly as it was, the paths it names included. A run
// that had not ended arrives interrupted by the move: it never resumes on its own on the new machine, a person does.
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { realpathSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const KIND = 'ruyix-data'
// each part: its home, its database, what else moves with it, and where its records name paths. The workbench keeps its
// first product's runs in its home and every other product's in products/<id> (workbench-<id> here; on an import also
// those the export has and this home has not yet).
const store = (name, dir) => ({ name, dir, db: 'workbench.db', with: ['runs', 'assistant.json'], paths: [['docs', 'data']], count: "SELECT count(*) n FROM docs WHERE kind = 'run'",
  settle: `UPDATE docs SET data = json_set(data, '$.status', 'interrupted', '$.interruptedBy', 'move', '$.interruptedAt', ?, '$.waiting', NULL)
    WHERE kind = 'run' AND (json_extract(data, '$.status') NOT IN ('done', 'failed', 'cancelled', 'interrupted') OR json_extract(data, '$.interruptedBy') = 'restart')` })
/** The workbench's home: ~/.ruyix/workbench (before ruyix moved it: ~/.dsh-ftm-workbench, a link to it after); FTMWB_HOME moves it. */
export const workbenchHome = (home = homedir()) => {
  const old = join(home, '.dsh-ftm-workbench')
  return process.env.FTMWB_HOME || (lstatSync(old, { throwIfNoEntry: false })?.isDirectory() ? old : join(home, '.ruyix/workbench'))
}
const parts = (home, theirs = []) => {
  const wb = workbenchHome(home), products = join(wb, 'products')
  const ids = new Set([...(existsSync(products) ? readdirSync(products) : []), ...theirs.filter(n => n.startsWith('workbench-')).map(n => n.slice(10))])
  // the studios' records and materials (@ruyix/studio: <home>/.ruyix/studios/<id>/studio.db and materials/); no paths in them
  const studios = process.env.RUYIX_STUDIO_HOME || join(home, '.ruyix/studios')
  const sids = new Set([...(existsSync(studios) ? readdirSync(studios) : []), ...theirs.filter(n => n.startsWith('studio-')).map(n => n.slice(7))])
  return [
    // the conversations in one file (workbench lib/conversations.js); they name no path. Copied first: a card made between
    // two copies is open in the archive with its run in it, never made with a run the archive lacks
    { name: 'conversations', dir: wb, db: 'conversations.db', with: [], paths: [], count: 'SELECT (SELECT count(*) FROM entries) + (SELECT count(*) FROM summaries) + (SELECT count(*) FROM memories) n' },
    store('workbench', wb),
    ...[...ids].filter(id => /^[\w][\w.-]*$/.test(id)).map(id => store(`workbench-${id}`, join(products, id))),
    { name: 'agent-hub', dir: process.env.DSH_AGENT_HUB_HOME || join(home, '.ruyix/agent-hub'), db: 'hub.db', with: ['runs', 'sessions', 'skills', 'skills-mine', 'skill-packs.json'], paths: [['sessions', 'cwd'], ['sessions', 'data'], ['docs', 'data']], count: 'SELECT count(*) n FROM sessions' },
    ...[...sids].filter(id => /^[a-z][a-z0-9-]{1,31}$/.test(id)).map(id => ({ name: `studio-${id}`, dir: join(studios, id), db: 'studio.db', with: ['materials'], paths: [], count: 'SELECT count(*) n FROM records WHERE removed_at IS NULL' })),
  ]
}
const fail = message => Object.assign(new Error(message), { code: 'ruyixData' })
const count = (file, sql) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).get().n } catch { return 0 } finally { db.close() } }

// Only portable data may be copied: never open a database through an archive-supplied link, or carry links outside
// the copied part. Keep relative internal links verbatim so they still refer to the imported data after temp cleanup.
function portablePart(stage, p) {
  const part = join(stage, p.name), st = lstatSync(part, { throwIfNoEntry: false })
  if (!st?.isDirectory() || st.isSymbolicLink()) throw fail(`invalid data folder: ${p.name}`)
  const db = lstatSync(join(part, p.db), { throwIfNoEntry: false })
  if (!db?.isFile() || db.isSymbolicLink()) throw fail(`data database must be a regular file: ${p.name}/${p.db}`)
  const root = realpathSync(part), roots = new Set([p.db, ...p.with])
  const walk = path => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path)
      let target
      try { target = realpathSync(path) } catch { throw fail(`broken data link: ${path}`) }
      if (isAbsolute(link) || !target.startsWith(root + sep) || !roots.has(relative(root, target).split(sep)[0])) throw fail(`data link is outside the exported part: ${path}`)
    } else if (stat.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)) }
    else if (!stat.isFile()) throw fail(`unsupported data file: ${path}`)
  }
  walk(part)
}

export function exportData(out, home = homedir()) {
  const stage = mkdtempSync(join(tmpdir(), 'ruyix-data-')), manifest = { kind: KIND, version: 1, home, host: hostname(), at: Date.now(), parts: {} }
  try {
    for (const p of parts(home)) {
      const db = join(p.dir, p.db)
      if (!existsSync(db)) continue
      mkdirSync(join(stage, p.name))
      const src = new DatabaseSync(db, { readOnly: true })
      try { src.exec(`VACUUM INTO '${join(stage, p.name, p.db).replaceAll("'", "''")}'`) } finally { src.close() } // a consistent copy, while ruyix runs
      for (const w of p.with) if (existsSync(join(p.dir, w))) cpSync(join(p.dir, w), join(stage, p.name, w), { recursive: true, verbatimSymlinks: true })
      portablePart(stage, p)
      manifest.parts[p.name] = { records: count(join(stage, p.name, p.db), p.count) }
    }
    if (!Object.keys(manifest.parts).length) throw fail('nothing to export: this home has no workbench or Agent Hub data')
    writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    execFileSync('tar', ['-czf', resolve(out), '-C', stage, '.'])
    return manifest
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

// Decode JSON before rewriting paths: Windows separators are escaped in the stored JSON bytes.
function movedPaths(value, before, after) {
  if (typeof value === 'string') {
    const windows = /^[a-z]:[\\/]/i.test(before) || before.startsWith('\\\\')
    const targetWindows = /^[a-z]:[\\/]/i.test(after) || after.startsWith('\\\\')
    const from = (windows ? before.replaceAll('\\', '/') : before).replace(/\/+$/, '')
    const to = (targetWindows ? after.replaceAll('\\', '/') : after).replace(/\/+$/, '')
    const path = windows ? value.replaceAll('\\', '/') : value
    if (from && path === from) return targetWindows && /^[a-z]:$/i.test(to) ? to + '/' : to || '/'
    if (path.startsWith(from + '/')) return to + path.slice(from.length)
    if (!from) return value
    return value.replaceAll(before.replace(/[\\/]+$/, '') + (windows ? '\\' : '/'), to + '/').replaceAll(from + '/', to + '/')
  }
  if (Array.isArray(value)) return value.map(v => movedPaths(v, before, after))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, movedPaths(v, before, after)]))
  return value
}

export function importData(file, { replace = false, home = homedir() } = {}) {
  const stage = mkdtempSync(join(tmpdir(), 'ruyix-data-'))
  try {
    execFileSync('tar', ['-xzf', resolve(file), '-C', stage])
    let manifest
    try { manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8')) } catch { throw fail(`${file} is not a ruyix data export`) }
    if (manifest.kind !== KIND || manifest.version !== 1) throw fail(`${file} is not a ruyix data export (version 1)`)
    if (typeof manifest.home !== 'string' || !manifest.home) throw fail('the export has no source home')
    const names = Object.keys(manifest.parts || {})
    if (!names.length) throw fail('the export has no data parts')
    for (const name of names) if (!['workbench', 'conversations', 'agent-hub'].includes(name) && !/^workbench-[\w][\w.-]*$/.test(name) && !/^studio-[a-z][a-z0-9-]{1,31}$/.test(name)) throw fail(`invalid data part: ${name}`)
    const todo = parts(home, names).filter(p => manifest.parts[p.name])
    const canonical = dir => existsSync(dir) ? realpathSync(dir) : join(canonical(dirname(dir)), basename(dir))
    const seen = new Set(), products = canonical(join(workbenchHome(home), 'products')), studios = canonical(process.env.RUYIX_STUDIO_HOME || join(home, '.ruyix/studios'))
    for (const p of todo) {
      const target = canonical(p.dir), root = p.name.startsWith('workbench-') ? products : p.name.startsWith('studio-') ? studios : null
      if (root && !target.startsWith(root + sep)) throw fail(`data part is outside its home: ${p.name}`)
      for (const f of [p.db, `${p.db}-wal`, `${p.db}-shm`, ...p.with]) { const key = join(target, f); if ([...seen].some(other => key === other || key.startsWith(other + sep) || other.startsWith(key + sep))) throw fail(`data parts share a target: ${p.name}`); seen.add(key) }
    }
    for (const p of todo) portablePart(stage, p)
    for (const p of todo) { // nothing is touched until every part may go in
      const here = join(p.dir, p.db)
      if (!replace && existsSync(here) && count(here, p.count) > 0) throw fail(`${p.dir} has history of its own (${count(here, p.count)}): ruyix data import ${file} --replace keeps it aside and takes the export's`)
    }
    // Prepare every database in the temporary archive before touching this home's files.
    const counts = new Map()
    for (const p of todo) {
      const file = join(stage, p.name, p.db), db = new DatabaseSync(file)
      try {
        if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw fail(`invalid database: ${p.name}`)
        for (const [table, col] of p.paths) {
          const rows = db.prepare(`SELECT rowid AS move_id, ${col} AS value FROM ${table}`).iterate()
          const put = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`)
          for (const row of rows) {
            if (row.value == null) continue
            const value = col === 'data' ? JSON.parse(row.value) : row.value
            const moved = movedPaths(value, manifest.home, home)
            const text = col === 'data' ? JSON.stringify(moved) : moved
            if (text !== row.value) put.run(text, row.move_id)
          }
        }
        if (p.settle) db.prepare(p.settle).run(Date.now())
      } finally { db.close() }
      counts.set(p.name, count(file, p.count))
    }
    const aside = `.before-import-${Date.now()}-${randomUUID().slice(0, 8)}`, done = {}, moved = [], placed = [], folders = new Set()
    const clear = replace && manifest.parts.workbench && !manifest.parts.conversations ? parts(home).filter(p => p.name === 'conversations' && existsSync(join(p.dir, p.db)) && count(join(p.dir, p.db), p.count) > 0) : []
    const backup = p => {
      const folder = join(p.dir, aside)
      mkdirSync(folder, { recursive: true }); folders.add(folder)
      for (const f of [p.db, `${p.db}-wal`, `${p.db}-shm`, ...p.with]) if (existsSync(join(p.dir, f))) {
        const original = join(p.dir, f), saved = join(folder, f)
        renameSync(original, saved); moved.push([original, saved])
      }
    }
    try {
      for (const p of todo) {
        backup(p)
        for (const f of [p.db, ...p.with]) if (existsSync(join(stage, p.name, f))) {
          const dest = join(p.dir, f); placed.push(dest)
          cpSync(join(stage, p.name, f), dest, { recursive: true, verbatimSymlinks: true })
        }
        done[p.name] = { records: counts.get(p.name), aside: join(p.dir, aside) }
      }
      // A legacy workbench import replaces legacy chat; unrelated parts leave the current conversation alone.
      for (const p of clear) { backup(p); done[p.name] = { records: 0, aside: join(p.dir, aside), emptied: true } }
      return { from: { host: manifest.host, home: manifest.home, at: manifest.at }, parts: done }
    } catch (err) {
      const errors = []
      for (const path of placed.reverse()) { try { rmSync(path, { recursive: true, force: true }) } catch (e) { errors.push(e.message) } }
      for (const [original, saved] of moved.reverse()) { try { renameSync(saved, original) } catch (e) { errors.push(`${saved}: ${e.message}`) } }
      if (!errors.length) for (const folder of folders) { try { if (!readdirSync(folder).length) rmSync(folder, { recursive: true }) } catch { /* an empty backup directory may stay */ } }
      if (errors.length) err.message += `; restore the originals kept aside: ${errors.join('; ')}`
      throw err
    }
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

let mainUrl = ''
try { if (process.argv[1]) mainUrl = pathToFileURL(realpathSync(process.argv[1])).href } catch { /* a host's argv[1] need not be a file */ }
if (import.meta.url === mainUrl) {
  const [cmd, ...rest] = process.argv.slice(2), opt = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined }
  try {
    if (cmd === 'export') {
      const out = opt('--out') || 'ruyix-data.tar.gz', m = exportData(out)
      console.log(`  ✓ ${out}: ${Object.entries(m.parts).map(([k, v]) => `${k} ${v.records}`).join(', ')} (from ${m.home})`)
    } else if (cmd === 'import' && rest[0] && !rest[0].startsWith('--')) {
      const r = importData(rest[0], { replace: rest.includes('--replace') })
      for (const [k, v] of Object.entries(r.parts)) console.log(v.emptied ? `  ✓ ${k}: emptied — this export has none, so the ones here do not mix with its chat (what was here: ${v.aside})` : `  ✓ ${k}: ${v.records} (what was here: ${v.aside})`)
      console.log(`  ✓ from ${r.from.host} (${r.from.home}), exported ${new Date(r.from.at).toISOString().slice(0, 16)}`)
    } else {
      console.log('ruyix data export [--out ruyix-data.tar.gz] | ruyix data import <ruyix-data.tar.gz> [--replace]')
      process.exit(cmd ? 2 : 0)
    }
  } catch (err) { console.error(`✗ ${err.message}`); process.exit(1) }
}
