// How the workbench's MCP bridge is asked: a POST to its endpoint — `unix:<socket>` (the workbench's own; a TCP port in a
// microVM box may refuse connections) or http(s)://… — with a step's (or a conversation turn's) token.
import { request } from 'node:http'

/** POST `body` to `path` of the tools endpoint at `url` → its JSON (an error carries the endpoint's own words). timeout 0: none. */
export function toolsPost(url, token, path, body, { timeout = 20000 } = {}) {
  const data = JSON.stringify(body), headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${token}` }
  const at = String(url || '')
  if (!at.startsWith('unix:')) {
    return fetch(at + path, { method: 'POST', headers, body: data, ...(timeout && { signal: AbortSignal.timeout(timeout) }) })
      .then(async res => { const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`); return j })
  }
  return new Promise((ok, no) => {
    // (its own connection, its timeout as given — 0 none: the default agent's keep-alive would end a long call at 5 s)
    const req = request({ socketPath: at.slice(5), path, method: 'POST', headers, agent: false, timeout }, res => {
      const bufs = []
      res.on('data', c => bufs.push(c)).on('error', no).on('end', () => {
        let j; try { j = JSON.parse(Buffer.concat(bufs).toString('utf8')) } catch { j = { error: `HTTP ${res.statusCode}` } }
        if (res.statusCode >= 400 || j.error) no(new Error(j.error || `HTTP ${res.statusCode}`)); else ok(j)
      })
    })
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeout / 1000} s`))).on('error', no)
    // the body first, end() once it is written: Node 22's end(data) sends an empty chunk after a body too big for one write;
    // the endpoint has the whole body by then, answers and closes, and on macOS that 0-byte write fails with EPIPE
    req.write(data, err => { if (!err) req.end() })
  })
}
