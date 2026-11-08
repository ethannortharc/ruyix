// The CLI agents' way to this Ruyix's search and fetch (web-mcp.mjs asks it): a Unix socket only the box's user can
// open, one JSON line each way — { id, op: 'search', query, maxResults } | { id, op: 'fetch', url } → { id, ok, … } | { id, error, code }.
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the socket goes: the home, or (too long a path for a socket) a folder of its own in the temp. */
export function webSockPath(home) {
  const own = join(home, 'web.sock')
  return Buffer.byteLength(own) <= 100 ? own : join(mkdtempSync(join(tmpdir(), 'ruyix-web-')), 's.sock')
}

export function serveWeb(web, sock, { log = () => {} } = {}) {
  try { rmSync(sock, { force: true }) } catch { /* not there */ }
  const server = createServer(conn => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('data', c => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let m
        try { m = JSON.parse(line) } catch { continue }
        const reply = v => { if (!conn.destroyed) conn.write(`${JSON.stringify({ id: m.id, ...v })}\n`) }
        const signal = AbortSignal.timeout(90000)
        const work = m.op === 'search' ? web.search({ query: m.query, maxResults: m.maxResults }, signal) : m.op === 'fetch' ? web.fetchPage({ url: m.url }, signal) : Promise.reject(Object.assign(new Error(`no op ${m.op}`), { code: 'unknownOp' }))
        work.then(r => reply({ ok: true, result: r }), err => reply({ error: err.message, code: err.code || 'failed' }))
      }
    })
    conn.on('error', () => {})
  })
  server.on('error', err => log(`ruyix-web: the agents' socket ${sock}: ${err.message}`))
  server.listen(sock, () => { try { chmodSync(sock, 0o600) } catch { /* the folder is the user's */ } })
  server.unref()
  return () => { server.close(); try { rmSync(sock, { force: true }) } catch { /* gone */ } }
}
