// One writer at a time of a Ruyix's own files (<RUYIX_HOME>: the layout, the theme, the boards, the journal of changes),
// across processes — this dsh, `ruyix changes`, `ruyix plugin` — so a check and the write after it see the same files.
//
// The kernel holds the lock: a listening socket in Linux's abstract namespace, named after the home. The kernel frees it
// the moment its process ends, so a holder that dies leaves nothing behind to take over, and a live holder is never
// taken from, however long it holds it. Elsewhere (a macOS host) a socket file stands in: one that nobody answers on
// is a dead holder's and is cleared (ponytail: two waiters clearing it at the same moment could both enter — macOS
// hosts only; boxes and Linux hosts use the abstract socket). In one process the callers queue, one after another.
//
// Taking the lock also undoes a commit a crash cut short (commit.js's recover).
import net from 'node:net'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { recover } from './commit.js'

const queues = new Map() // home → the tail of its queue in this process
const idOf = home => { let real = home; try { real = realpathSync(home) } catch { /* not made yet */ } return createHash('sha256').update(real).digest('hex').slice(0, 32) }
const listen = path => new Promise((ok, no) => {
  const srv = net.createServer(c => c.destroy())
  srv.once('error', no)
  srv.listen({ path }, () => { srv.off('error', no); srv.unref(); ok(srv) })
})
// the socket file: in the home; when that path is longer than a socket's address takes (104 bytes on macOS), in a folder
// of this user's under /tmp, named after the home — one place for every process (a TMPDIR differs from one to another)
const fileOf = home => {
  const f = join(home, '.lock.sock')
  if (Buffer.byteLength(f) < 100) return f
  const dir = `/tmp/ruyix-${process.getuid()}`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) throw Object.assign(new Error(`${dir} is not this user's own folder`), { code: 'busy' })
  return join(dir, `${idOf(home)}.sock`)
}
const answers = path => new Promise(ok => { const c = net.connect(path); c.once('connect', () => { c.destroy(); ok(true) }); c.once('error', () => ok(false)) })

async function hold(home, wait) {
  const linux = platform() === 'linux', path = linux ? `\0ruyix-lock-${idOf(home)}` : fileOf(home)
  for (const until = Date.now() + wait; ;) {
    try { return await listen(path) } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err
      if (!linux && !(await answers(path))) { rmSync(path, { force: true }); continue } // a dead holder's socket file
      if (Date.now() > until) throw Object.assign(new Error('another writer holds this Ruyix\'s files: try again in a moment'), { code: 'busy' })
      await new Promise(r => setTimeout(r, 50))
    }
  }
}

/** Run fn (sync or async) holding the lock of `home`, after finishing any commit a crash cut short there. */
export function withLock(home, fn, { wait = 10e3 } = {}) {
  const run = (queues.get(home) || Promise.resolve()).then(async () => {
    mkdirSync(home, { recursive: true })
    const srv = await hold(home, wait)
    try { recover(home); return await fn() } finally { await new Promise(r => srv.close(() => r())) }
  })
  queues.set(home, run.catch(() => {}))
  return run
}
