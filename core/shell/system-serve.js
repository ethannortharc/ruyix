// The whole Ruyix as one MCP server for any agent (docs/design/agent-control.md; Ethan 2026-10-18: every agent of the
// pool may work the system, and Claude Code on his Mac with one command): the system tools (system.js) over a Unix socket
// only the box's user can open, one JSON line each way —
//   { id, op: 'list', token?, as? } → { id, ok, tools: [{ name, description, parameters, effect }] }
//   { id, op: 'call', token?, as?, name, args } → { id, ok, text } | { id, error, code }
// Who calls: an agent Agent Hub started carries a token it was given for that (its name and its work: the record says
// who did what); `ruyix mcp` run by hand (nookbox exec) says a name of its own (`as`). The socket's permissions are the
// gate; the token only makes the record honest. What a 'direct' tool did goes in the actions' record (actions.jsonl) with
// its way back — actions_list / action_undo here are how it is seen and undone, by the person's word.
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

const MAX_ACTIONS = 300
const CALLER_MS = 3 * 24 * 3600e3 // (a session lives on for days: its agent's token too)
const said = (zh, en) => ({ zh, en })

/** Where the socket goes: the home (`system.sock`), or — too long a path for a socket — a folder of its own in the
 * temp, named in `system.sock.path` for `ruyix mcp` to find. */
export function systemSockPath(home) {
  const own = join(home, 'system.sock')
  if (Buffer.byteLength(own) <= 100) { rmSync(join(home, 'system.sock.path'), { force: true }); return own }
  const p = join(mkdtempSync(join(tmpdir(), 'ruyix-sys-')), 's.sock')
  writeFileSync(join(home, 'system.sock.path'), `${p}\n`, { mode: 0o600 })
  return p
}

/** The agents Agent Hub started, each with its token: mint({ who, title, of }) → token; get(token) → the caller. */
export function createCallers({ now = Date.now } = {}) {
  const map = new Map()
  return {
    mint({ who, title, of = null }) {
      for (const [k, c] of map) if (now() - c.at > CALLER_MS) map.delete(k)
      while (map.size >= 1000) map.delete(map.keys().next().value)
      const token = randomBytes(24).toString('base64url')
      map.set(token, { who: String(who || 'agent').slice(0, 120), title: String(title || who || '').slice(0, 120), of: of || null, at: now() })
      return token
    },
    get: token => (token && map.get(String(token))) || null,
  }
}

/** What the system tools did for agents other than the main agent's conversation (that one keeps its own record). */
export function createActionLog({ home, now = Date.now }) {
  const file = join(home, 'actions.jsonl')
  const all = () => {
    if (!existsSync(file)) return []
    const out = []
    for (const line of readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)) } catch { /* a torn line */ } }
    // (marks come after the action: the last word on each)
    const by = new Map()
    for (const r of out) by.set(r.id, { ...by.get(r.id), ...r })
    return [...by.values()]
  }
  return {
    add(rec) {
      const r = { id: `a${now().toString(36)}${randomUUID().slice(0, 4)}`, at: now(), ...rec }
      appendFileSync(file, `${JSON.stringify(r)}\n`, { mode: 0o600 })
      const list = all()
      if (list.length > MAX_ACTIONS * 2) writeFileSync(file, `${list.slice(-MAX_ACTIONS).map(x => JSON.stringify(x)).join('\n')}\n`, { mode: 0o600 })
      return r
    },
    mark(id, fields) { appendFileSync(file, `${JSON.stringify({ id, ...fields })}\n`, { mode: 0o600 }) },
    list: ({ limit = 20 } = {}) => all().filter(r => r.tool).slice(-Math.min(Math.max(1, limit), 100)).reverse(),
    get: id => all().find(r => r.id === id && r.tool) || null,
  }
}

/** A call's record line: who, for what (their work), as the person asked. */
const byOf = c => `${c.title || c.who} (${c.who}${c.of ? `, for ${c.of}` : ''}; an agent working for the person)`

/**
 * One call of a system tool by a caller: its text, and — for a 'direct' one — the record with the way back.
 * Tools for the main agent's conversation alone (`chat: true`: cards in the chat) and the undo ones are not offered.
 */
export async function callTool({ tools, actions }, caller, name, args = {}) {
  const t = tools.get(name)
  if (!t || t.effect === 'undo' || t.chat) throw Object.assign(new Error(`no tool ${name} here (the list says which there are)`), { code: 'noTool' })
  const r = await t.run(args || {}, { by: byOf(caller), caller })
  // (a tool that acts says what it did — its summary; one that only listed, asked with nothing, did nothing to record)
  if (t.effect !== 'direct' || !r.summary) return { text: r.text }
  const rec = actions.add({ tool: t.name, title: t.title || null, summary: r.summary || t.title || said(t.name, t.name), undo: r.undo || null, by: caller.who, byTitle: caller.title || null, of: caller.of || null })
  return { text: `${r.text}${r.undo ? `\n(on record as ${rec.id}: action_undo { id: "${rec.id}" } takes it back)` : ''}` }
}

export const offered = tools => tools.list().filter(t => !t.chat).map(t => ({ name: t.name, description: t.description, parameters: t.parameters, effect: t.effect }))

export function serveSystem({ tools, callers, actions, sock, log = () => {} }) {
  try { rmSync(sock, { force: true }) } catch { /* not there */ }
  const server = createServer(conn => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('data', c => {
      buf += c
      if (buf.length > 4e6) { conn.destroy(); return }
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let m
        try { m = JSON.parse(line) } catch { continue }
        const reply = v => { if (!conn.destroyed) conn.write(`${JSON.stringify({ id: m.id, ...v })}\n`) }
        // (no token: someone of this user's running `ruyix mcp` by hand, by the name it gives)
        const caller = callers.get(m.token) || { who: `outside:${String(m.as || 'ruyix mcp').replace(/[^\p{L}\p{N}_ .@()-]/gu, '').slice(0, 60) || 'ruyix mcp'}`, title: String(m.as || '').slice(0, 60) || null, of: null }
        const work = m.op === 'list' ? Promise.resolve({ tools: offered(tools) })
          : m.op === 'call' ? callTool({ tools, actions }, caller, String(m.name || ''), m.args)
            : Promise.reject(Object.assign(new Error(`no op ${m.op}`), { code: 'badOp' }))
        work.then(r => reply({ ok: true, ...r }), err => reply({ error: String(err?.message || err).slice(0, 2000), code: err?.code || 'failed' }))
      }
    })
    conn.on('error', () => {})
  })
  server.on('error', err => log(`ruyix: the system tools' socket ${sock}: ${err.message}`))
  server.listen(sock, () => { try { chmodSync(sock, 0o600) } catch { /* the folder is the user's */ } })
  server.unref()
  return () => { server.close(); try { rmSync(sock, { force: true }) } catch { /* gone */ } }
}

/** The record's own tools: what agents did lately, and taking one back (as the person says). */
export function actionTools({ tools, actions }) {
  const undoing = new Map()
  const s = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
  const line = r => `${r.id} · ${new Date(r.at).toISOString()} · ${r.byTitle || r.by}: ${r.summary?.en || r.tool}${r.undone ? ' (undone)' : r.undo ? '' : ' (no way back)'}`
  return [
    {
      name: 'actions_list',
      title: said('看智能体做过的操作', 'See what agents did'),
      effect: 'read',
      description: 'What agents other than the conversation did in this Ruyix with the system tools, newest first: who, what, and whether it can be taken back (action_undo). The conversation\'s own actions are in its work record.',
      parameters: s({ limit: { type: 'integer', minimum: 1, maximum: 100, description: 'how many (default 20)' } }),
      async run({ limit = 20 } = {}) {
        const list = actions.list({ limit })
        return { text: list.length ? list.map(line).join('\n') : 'No agent has done anything with the system tools yet.' }
      },
    },
    {
      name: 'action_undo',
      title: said('撤销智能体的一个操作', 'Undo an agent\'s action'),
      effect: 'direct',
      description: 'Take back one thing an agent did (an id from actions_list) — only when the person says so.',
      parameters: s({ id: { type: 'string' } }, ['id']),
      async run({ id }, { by } = {}) {
        const r = actions.get(String(id || ''))
        if (!r) throw Object.assign(new Error(`no action ${id} on record`), { code: 'noAction' })
        if (r.undone) return { text: `${id} was taken back already.` }
        if (!r.undo?.tool || !tools.get(r.undo.tool)) throw Object.assign(new Error(`${id} has no way back`), { code: 'noUndo' })
        if (undoing.has(r.id)) return undoing.get(r.id)
        const work = Promise.resolve().then(async () => {
          const out = await tools.get(r.undo.tool).run(r.undo.args || {}, { by, undo: true })
          actions.mark(r.id, { undone: Date.now(), undoneBy: by || null })
          return { text: `Taken back: ${r.summary?.en || r.tool}. ${out.text || ''}`.trim(), summary: said(`撤销了：${r.summary?.zh || r.tool}`, `Undid: ${r.summary?.en || r.tool}`) }
        })
        undoing.set(r.id, work)
        try { return await work } finally { if (undoing.get(r.id) === work) undoing.delete(r.id) }
      },
    },
  ]
}
