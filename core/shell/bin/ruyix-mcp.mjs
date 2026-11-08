#!/usr/bin/env node
// The whole Ruyix as an MCP server (stdio) for any agent — `ruyix mcp [--as <name>]`; Agent Hub hands it to every agent
// it starts (docs/design/agent-control.md). Its tools are this Ruyix's system tools, asked of Ruyix over its Unix socket
// (system-serve.js): open apps and pages, what is open, tasks, sessions, studios, the desk, … — the list is Ruyix's own.
// Claude Code on the person's Mac: `claude mcp add ruyix -- nookbox exec --stdio ruyix -- ruyix mcp --as "Claude Code (Mac)"` (nookbox 0.5.12+: --stdio keeps the pipes connected).
// env: RUYIX_SYS_SOCK (else <RUYIX_HOME>/system.sock, or where system.sock.path says), RUYIX_SYS_TOKEN (Agent Hub's).
import { pathToFileURL } from 'node:url'
import { createConnection } from 'node:net'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INSTRUCTIONS = [
  'This is Ruyix, the person\'s agent OS: these tools work the whole system for them — open apps, pages and files, see what is open, the tasks, the sessions of the agent pool, studios, the desk and its look, voice input.',
  'Do only what the person asked for. What can be undone is done at once and goes on record with its way back (actions_list, action_undo); what cannot be undone or reaches outside (deleting, publishing, sending, paying, approving) is not a tool here: say what you would do and leave it to them.',
  'Windows and pages open on the Ruyix page the person has open; when none is open, say so — they appear when it is.',
].join(' ')

const sockOf = () => {
  if (process.env.RUYIX_SYS_SOCK) return process.env.RUYIX_SYS_SOCK
  const home = process.env.RUYIX_HOME || join(homedir(), '.ruyix'), pointer = join(home, 'system.sock.path')
  return existsSync(pointer) ? readFileSync(pointer, 'utf8').trim() : join(home, 'system.sock')
}
const as = (() => { const i = process.argv.indexOf('--as'); return i > 0 ? String(process.argv[i + 1] || '').slice(0, 60) : '' })()

let conn = null, buf = '', seq = 0
const pending = new Map()
function ask(op, args = {}) {
  if (!conn) {
    conn = createConnection(sockOf())
    conn.setEncoding('utf8')
    conn.on('data', c => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        const p = pending.get(m.id)
        if (p) { pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error), { code: m.code })) : p.resolve(m) }
      }
    })
    const lost = err => { for (const p of pending.values()) p.reject(new Error(`Ruyix does not answer (is it running? ruyix status)${err ? `: ${err.message}` : ''}`)); pending.clear(); conn = null }
    conn.on('error', lost); conn.on('close', () => lost())
  }
  const id = ++seq
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); conn.write(`${JSON.stringify({ id, op, token: process.env.RUYIX_SYS_TOKEN || undefined, as: as || undefined, ...args })}\n`) })
}

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)
export async function handle(m, askFn = ask) {
  switch (m.method) {
    case 'initialize': return { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ruyix', version: '0.1.0' }, instructions: INSTRUCTIONS }
    case 'ping': return {}
    case 'tools/list': {
      const { tools } = await askFn('list')
      return { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters || { type: 'object', properties: {} }, annotations: { readOnlyHint: t.effect === 'read' } })) }
    }
    case 'tools/call': {
      const name = String(m.params?.name || '')
      try { return { content: [{ type: 'text', text: String((await askFn('call', { name, args: m.params?.arguments || {} })).text ?? '') }] } } catch (err) { return { content: [{ type: 'text', text: `${name}: ${err.message}` }], isError: true } }
    }
    default: throw Object.assign(new Error(`method not found: ${m.method}`), { code: -32601 })
  }
}
let mainUrl = ''
try { if (process.argv[1]) mainUrl = pathToFileURL(realpathSync(process.argv[1])).href } catch { /* a host's argv[1] need not be a file */ }
if (import.meta.url === mainUrl) {
  let inBuf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', c => {
    inBuf += c
    let i
    while ((i = inBuf.indexOf('\n')) >= 0) {
      const line = inBuf.slice(0, i).trim(); inBuf = inBuf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.id === undefined) continue // (a notification: nothing to answer)
      handle(m).then(result => send({ jsonrpc: '2.0', id: m.id, result }), err => send({ jsonrpc: '2.0', id: m.id, error: { code: err.code === -32601 ? -32601 : -32603, message: err.message } }))
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
