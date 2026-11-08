// Sessions in a terminal (docs/design/agent-work.md §5): the sessions stay structured processes; a person reads and
// writes to them from any terminal through a mirror (the shell's `ruyix session attach <id>`: the conversation as it
// goes, what is typed sent to it). Two things here:
// - serveSessions: a Unix socket (0600, the box user's only) the mirror asks — one JSON line each way:
//   { id, op: 'list' } → { sessions } · { id, op: 'read', sid, after } → { session, events } · { id, op: 'send', sid, text }
//   → { queued } · { id, op: 'stop', sid } → { stopped }
// - createMirrors: a tmux session `ruyix-agents` (on the terminal app's tmux server, -L ruyix) with a window per session
//   running its mirror, and a Zellij session `ruyix-agents` with a tab per session when Zellij is here — kept in step with
//   the sessions. (Its own name: a person's own session called `ruyix` is never touched.)
import { execFile as nodeExecFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the socket goes: the hub's home, or — too long a path for a socket — a folder of its own in the temp, named in sessions.sock.path. */
export function sessionsSockPath(home) {
  const own = join(home, 'sessions.sock')
  if (Buffer.byteLength(own) <= 100) { rmSync(`${own}.path`, { force: true }); return own }
  const sock = join(mkdtempSync(join(tmpdir(), 'ruyix-sessions-')), 's.sock')
  writeFileSync(`${own}.path`, sock, { mode: 0o600 })
  return sock
}

export function serveSessions(sessions, sock, { log = () => {} } = {}) {
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
        Promise.resolve().then(async () => {
          switch (m.op) {
            case 'list': return { sessions: sessions.list().map(d => ({ id: d.id, title: d.title, agent: d.agent, runtime: d.runtime, cwd: d.cwd, state: d.state, process: d.process, turns: d.turns || 0, lastAt: d.lastAt })) }
            case 'read': return sessions.read(String(m.sid), { after: Number(m.after) || 0, limit: Math.min(1000, Number(m.limit) || 400) })
            case 'send': return await sessions.send(String(m.sid), m.text, { confirm: true })
            case 'stop': return sessions.stop(String(m.sid))
            default: throw Object.assign(new Error(`no op ${m.op}`), { code: 'unknownOp' })
          }
        }).then(v => reply({ ok: true, ...v }), err => reply({ error: err.message, code: err.code || 'failed' }))
      }
    })
    conn.on('error', () => {})
  })
  // (it not listening is the mirror's trouble only — said, never thrown at the hub)
  server.on('error', err => log(`agent-hub: the sessions' socket ${sock}: ${err.message}`))
  server.listen(sock, () => { try { chmodSync(sock, 0o600) } catch { /* the folder is the box user's */ } })
  server.unref()
  return () => { server.close(); try { rmSync(sock, { force: true }) } catch { /* gone */ } }
}

/** A session's window / tab name: short, its id at the end (how a window is found again). */
export const windowName = d => `${String(d.title || d.agent).replace(/[^\p{L}\p{N} _.-]+/gu, ' ').trim().slice(0, 14) || d.agent}·${d.id.slice(-5)}`

/**
 * The terminal mirrors: `attach(id)` → the command a window runs (the mirror). `sync(sessions)` makes the tmux session
 * `ruyix` (and Zellij's, when here) have a window / tab per session, and none for one that is gone. `has(bin)`: is it on
 * PATH. Errors are said (log), never thrown: a terminal not here leaves the sessions as they are.
 */
export const MIRROR_SESSION = 'ruyix-agents'

export function createMirrors({ attach, has, name = MIRROR_SESSION, run = (cmd, args) => new Promise(res => nodeExecFile(cmd, args, { timeout: 15000 }, (err, out) => res(err ? null : String(out)))), log = () => {} }) {
  let busy = false, again = false, latest = []
  const tmux = (...args) => run('tmux', ['-L', 'ruyix', ...args])
  const zellij = (...args) => run('zellij', args)
  async function syncTmux(list) {
    if ((await tmux('has-session', '-t', `=${name}`)) === null) {
      if (!list.length) return
      await tmux('new-session', '-d', '-s', name, '-n', windowName(list[0]), ...attach(list[0].id))
    }
    const have = new Map(((await tmux('list-windows', '-t', `=${name}`, '-F', '#{window_index} #{window_name}')) || '').split('\n').filter(Boolean).map(l => { const at = l.indexOf(' '); return [l.slice(at + 1), l.slice(0, at)] }))
    const want = new Map(list.map(d => [windowName(d), d]))
    for (const [win, d] of want) if (!have.has(win) && ![...have.keys()].some(n => n.endsWith(`·${d.id.slice(-5)}`))) await tmux('new-window', '-d', '-t', `=${name}:`, '-n', win, ...attach(d.id))
    for (const [win, index] of have) if (/·[\w-]{5}$/.test(win) && !list.some(d => win.endsWith(`·${d.id.slice(-5)}`))) await tmux('kill-window', '-t', `=${name}:${index}`)
  }
  async function syncZellij(list) {
    const sessions = (await zellij('list-sessions', '--short', '--no-formatting')) || ''
    const here = sessions.split('\n').some(l => l.trim() === name)
    if (!here) { if (!list.length) return; await zellij('attach', '--create-background', name) }
    // its tabs with their ids (list-tabs --json; an older Zellij: the names only, and a tab of a session gone stays)
    let tabs = null
    try { tabs = JSON.parse((await zellij('--session', name, 'action', 'list-tabs', '--json')) || 'null')?.map(t => ({ id: t.tab_id, name: t.name })) } catch { /* older */ }
    tabs ||= ((await zellij('--session', name, 'action', 'query-tab-names')) || '').split('\n').map(s => s.trim()).filter(Boolean).map(n => ({ id: null, name: n }))
    for (const d of list) if (!tabs.some(t => t.name.endsWith(`·${d.id.slice(-5)}`))) await zellij('--session', name, 'action', 'new-tab', '--name', windowName(d), '--', ...attach(d.id))
    for (const t of tabs) if (t.id != null && /·[\w-]{5}$/.test(t.name) && !list.some(d => t.name.endsWith(`·${d.id.slice(-5)}`))) await zellij('--session', name, 'action', 'close-tab', '--tab-id', String(t.id))
  }
  return {
    /** Keep the terminals in step with these sessions (the ones not removed). */
    async sync(list) {
      latest = list
      if (busy) { again = true; return }
      busy = true
      try {
        if (has('tmux')) await syncTmux(list).catch(err => log(`agent-hub: tmux mirrors: ${err.message}`))
        if (has('zellij')) await syncZellij(list).catch(err => log(`agent-hub: zellij mirrors: ${err.message}`))
      } finally { busy = false }
      if (again) { again = false; return this.sync(latest) }
    },
  }
}
