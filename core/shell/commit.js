// Writing a Ruyix's own files (<RUYIX_HOME>) as one commit: every file replaced, or none — and never over a revision someone
// else saved meanwhile (an editor takes no lock). For each file:
//   1. the new text goes into a file of its own (<path>.<tx>.new);
//   2. the file there now is moved aside (<path>.<tx>.was) — a rename, so whatever is there at that moment is what moves;
//   3. what moved is compared with what the commit expects; not it → it goes back (a link, which never replaces a file
//      someone made meanwhile) and the commit stops;
//   4. the new file is linked in place — again only where nothing is (someone saving at that moment wins, the commit stops).
// What the commit put in place is known by its identity (its inode) and its words (a hash): going back takes away only a
// file that is still both, and puts back what was moved aside only where nothing else is. Until the end, a log
// (changes/.commit.json) says what each step did; a crash leaves it for the next lock holder (lock.js): a commit not yet
// through is undone, one through (its log says "done" before its backups go) only has its leftovers cleared.
// Ruyix's own writers (the page, Settings, `ruyix changes`, `ruyix plugin`) take turns through the lock; a commit never writes
// over a file changed while no commit ran (the expected words). A writer that takes no lock and writes at the very moment
// of a commit (an editor saving into ~/.ruyix's state files mid-commit) is not coordinated with — these are Ruyix's state, not
// files to edit by hand.
// A machine that stops (power, a kernel panic) keeps only what reached the disk: every file's bytes are flushed when
// written, and the directories that name them before the log says a step counts — the log before a move, everything in
// place before "done", every leftover gone before the log goes.
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

const LOG = join('changes', '.commit.json')
const fail = (code, message) => Object.assign(new Error(message), { code })
const read = f => { try { return readFileSync(f, 'utf8') } catch (err) { if (err.code === 'ENOENT') return null; throw err } }
const inode = f => { try { return statSync(f).ino } catch (err) { if (err.code === 'ENOENT') return null; throw err } }
const gone = f => rmSync(f, { force: true })
/** A directory's names (a rename, a link, a removal) on the disk; a platform that cannot sync one (Windows) goes on. */
const syncDir = d => { let fd; try { fd = openSync(d, 'r'); fsyncSync(fd) } catch { /* not syncable here */ } finally { if (fd !== undefined) closeSync(fd) } }
const syncDirs = (home, steps) => { for (const d of new Set([home, join(home, 'changes'), ...steps.map(s => dirname(join(home, s.path)))])) syncDir(d) }
/** Link `from` at `to` only where nothing is: true when it went in. */
const place = (from, to) => { try { linkSync(from, to); return true } catch (err) { if (err.code === 'EEXIST') return false; throw err } }

const hash = t => createHash('sha256').update(t).digest('hex')
/** Undo the steps of a commit as its log says (an error halfway, or a crash): only what it put in place goes. */
function undo(home, steps) {
  for (const s of [...steps].reverse()) {
    const f = join(home, s.path)
    // what it put there — the same file (inode) with the same words (hash) — and nothing else: a file changed since stays
    if (s.ino !== null && inode(f) === s.ino && hash(read(f) ?? '') === s.sha) gone(f)
    if (s.moved && read(join(home, s.was)) !== null) { if (place(join(home, s.was), f)) gone(join(home, s.was)) } // back only where nothing is; else kept aside
    else gone(join(home, s.was))
    gone(join(home, s.new))
  }
  syncDirs(home, steps) // all of it on the disk before the log goes
}

/** A commit a crash cut short: undone, its log removed. A log that cannot be read stops everything (for a person). */
export function recover(home) {
  const t = read(join(home, LOG))
  if (t === null) return
  let log
  try { log = JSON.parse(t) } catch { throw fail('brokenLog', `${join(home, LOG)} cannot be read: look at it, then remove it`) }
  if (log?.phase === 'done') { for (const s of log.steps) { gone(join(home, s.new)); gone(join(home, s.was)) }; syncDirs(home, log.steps) } // through: only its leftovers
  else undo(home, Array.isArray(log) ? log : log.steps)
  gone(join(home, LOG)); syncDir(join(home, 'changes'))
}

/**
 * Write [path, text | null, expected?] (home-relative; null removes; `expected` — a string, or null for "absent" —
 * is what must be there, else the commit stops with code "stale"). Whole or not at all. The caller holds the lock.
 */
export function commit(home, writes, hook = null) { // hook(phase, step): a check's seam (someone saving between the steps)
  const tx = randomBytes(6).toString('hex'), logFile = join(home, LOG)
  const steps = writes.map(([path, text, expected]) => ({ path, text, expected, new: `${path}.${tx}.new`, was: `${path}.${tx}.was`, ino: null, sha: text === null ? null : hash(text), moved: false }))
  let phase = 'writing'
  const save = () => { mkdirSync(dirname(logFile), { recursive: true }); writeFileSync(`${logFile}.${tx}`, JSON.stringify({ phase, steps: steps.map(({ text, expected, ...s }) => s) }), { flush: true }); renameSync(`${logFile}.${tx}`, logFile); syncDir(dirname(logFile)) }
  try {
    for (const s of steps) if (s.text !== null) {
      mkdirSync(dirname(join(home, s.path)), { recursive: true })
      writeFileSync(join(home, s.new), s.text, { flag: 'wx', mode: 0o600, flush: true }) // every byte on the disk, or it throws
      s.ino = inode(join(home, s.new))
    }
    syncDirs(home, steps); save()
    for (const s of steps) {
      const f = join(home, s.path)
      // logged before it happens: a crash right after the move still finds what was moved aside
      s.moved = true; save()
      hook?.('move', s)
      try { renameSync(f, join(home, s.was)) } catch (err) { if (err.code !== 'ENOENT') throw err }
      hook?.('moved', s)
      const was = read(join(home, s.was))
      if (s.expected !== undefined && was !== s.expected) throw fail('stale', `${s.path} changed just now: look again, and propose it again`)
      hook?.('place', s)
      if (s.text !== null && !place(join(home, s.new), f)) throw fail('stale', `${s.path} was saved just now: look again, and propose it again`)
    }
  } catch (err) {
    try { undo(home, steps); gone(logFile) } catch { /* the log stays: the next lock holder undoes it */ }
    throw err
  }
  // through: said so before any backup goes — a crash from here on only leaves leftovers to clear
  syncDirs(home, steps); phase = 'done'; save()
  for (const s of steps) { hook?.('clean', s); gone(join(home, s.new)); gone(join(home, s.was)) }
  syncDirs(home, steps); gone(logFile); syncDir(dirname(logFile))
}
