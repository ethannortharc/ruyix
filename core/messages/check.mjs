// Self-check of the messages space, its tools, the command and the MCP server (no network; a throwaway folder): node check.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { LIMITS, openSpace, spacePath } from './index.js'
import { TOOL_NAMES, callTool } from './tools.js'

const dir = mkdtempSync(join(tmpdir(), 'agent-msg-check-'))
const BIN = join(import.meta.dirname, 'bin', 'agent-msg.mjs')
const env = { ...process.env, AGENT_MSG_HOME: join(dir, 'home'), AGENT_MSG_SPACE: '', AGENT_MSG_AS: '' }
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 30000 })
const refused = (fn, code) => assert.throws(fn, e => e.code === code, code)

try {
  // where a space lives: a bare name in the home, a path as it is; a name with odd characters is refused
  assert.equal(spacePath('team', { home: '/h' }), '/h/team.db')
  assert.equal(spacePath(join(dir, 'x.db')), join(dir, 'x.db'))
  refused(() => spacePath('a b'), 'badSpace')

  // two handles on one file are two agents' processes
  const file = join(dir, 'run', 'messages.db')
  const a = openSpace(file), b = openSpace(file)
  assert.equal(statSync(join(dir, 'run')).mode & 0o777, 0o700)

  // what reading gives: for me or for everyone, never my own, oldest first, and only once
  const m1 = a.post({ from: 'writer@draft', text: 'draft.md is done', files: ['draft.md'] })
  a.post({ from: 'writer@draft', to: 'adapter@adapt', text: 'section 3 is a guess', topic: 'copy' })
  a.post({ from: 'writer@draft', to: 'cards@visuals', text: 'not for the adapter' })
  assert.deepEqual(a.read({ as: 'writer@draft' }).messages, [])
  const r1 = b.read({ as: 'adapter@adapt' })
  assert.deepEqual(r1.messages.map(m => m.text), ['draft.md is done', 'section 3 is a guess'])
  assert.deepEqual(r1.messages[0].files, ['draft.md'])
  assert.equal(r1.messages[0].to, null)
  assert.equal(r1.messages[1].topic, 'copy')
  assert.deepEqual(b.read({ as: 'adapter@adapt' }).messages, [])
  // a reply, and peeking leaves the place where it was
  const back = b.post({ from: 'adapter@adapt', to: 'writer@draft', text: 'ok, I keep it short', replyTo: m1.id })
  assert.equal(a.read({ as: 'writer@draft', peek: true }).messages[0].replyTo, m1.id)
  assert.equal(a.read({ as: 'writer@draft' }).messages[0].id, back.id)
  // a long backlog comes in pages
  for (let i = 0; i < 5; i++) a.post({ from: 'bulk', text: `n${i}` })
  const p1 = b.read({ as: 'late', limit: 3 }), p2 = b.read({ as: 'late', limit: 10 })
  assert.equal(p1.more, true)
  assert.equal(p1.messages.length + p2.messages.length, 1 + 5) // to everyone: m1 and bulk ×5 (the rest are to one agent)
  assert.equal(p2.more, false)
  // who has been here
  assert.ok(['writer@draft', 'adapter@adapt', 'late', 'bulk'].every(n => a.members().some(m => m.name === n)))
  assert.equal(a.members().find(m => m.name === 'writer@draft').posted, 3)

  // refusals say what to do
  refused(() => a.post({ from: 'x', text: '  ' }), 'needText')
  refused(() => a.post({ from: '', text: 'hi' }), 'needName')
  refused(() => a.post({ from: 'two words', text: 'hi' }), 'badName')
  refused(() => a.post({ from: 'x', text: 'y'.repeat(LIMITS.text + 1) }), 'tooLong')
  refused(() => a.post({ from: 'x', text: 'hi', files: Array(LIMITS.files + 1).fill('f') }), 'badFiles')
  refused(() => a.post({ from: 'x', text: 'hi', replyTo: 'first' }), 'badReply')

  // waiting: ends when a message comes from another process, or at its timeout
  const waiting = b.wait({ as: 'cards@visuals', from: 'adapter@adapt', timeoutS: 20 })
  // (writer's message to cards@visuals, already there, does not end a wait for the adapter's — but comes with it)
  const posted = cli('post', '--space', file, '--as', 'adapter@adapt', '--to', 'cards@visuals', '--file', 'posts/x.json', 'posts are ready')
  assert.equal(posted.status, 0, posted.stderr)
  const got = await waiting
  assert.deepEqual(got.messages.map(m => m.text), ['draft.md is done', 'not for the adapter', 'n0', 'n1', 'n2', 'n3', 'n4', 'posts are ready'])
  const t0 = Date.now(), none = await b.wait({ as: 'cards@visuals', timeoutS: 1 })
  assert.equal(none.timedOut, true)
  assert.ok(Date.now() - t0 >= 900)
  const ac = new AbortController(); setTimeout(() => ac.abort(), 100)
  assert.equal((await b.wait({ as: 'cards@visuals', timeoutS: 60, signal: ac.signal })).timedOut, true)

  // the tools, as an agent reads them
  assert.deepEqual(TOOL_NAMES, ['messages_post', 'messages_read', 'messages_wait'])
  assert.match(await callTool(a, 'writer@draft', 'messages_post', { text: 'cards next', to: 'cards@visuals', files: ['cards/'] }), /^Posted #\d+ as writer@draft to cards@visuals\.$/)
  const read = await callTool(b, 'cards@visuals', 'messages_read', {})
  assert.match(read, /You are cards@visuals\. 1 new message\(s\):\n#\d+ \d\d:\d\d writer@draft → you: cards next\n {3}files: cards\//)
  assert.match(await callTool(b, 'cards@visuals', 'messages_read', {}), /^Nothing new for cards@visuals\. Others here: /)
  assert.match(await callTool(b, 'cards@visuals', 'messages_wait', { timeout_s: 1 }), /Go on with your own best judgment/)
  await assert.rejects(callTool(a, 'x', 'messages_shout', {}), /no such tool/)

  // only the newest `keep` stay
  const small = openSpace(join(dir, 'small.db'), { keep: 3 })
  for (let i = 0; i < 5; i++) small.post({ from: 'x', text: `m${i}` })
  assert.deepEqual(small.log().map(m => m.text), ['m2', 'm3', 'm4'])
  assert.deepEqual(small.log({ after: small.log()[1].id }).map(m => m.text), ['m4'], 'after: only the newer ones (what the desk asks for)')
  small.close()
  a.close(); b.close()

  // the command: a bare space name lives in the home; read needs a name; log shows all
  assert.equal(cli('post', '--space', 'team', '--as', 'claude-a', 'hello', 'codex').status, 0)
  assert.match(cli('read', '--space', 'team', '--as', 'codex-b').stdout, /claude-a → everyone: hello codex/)
  assert.match(cli('read', '--space', 'team').stderr, /say who you are/)
  assert.match(cli('log', '--space', 'team').stdout, /hello codex/)
  assert.equal(JSON.parse(cli('who', '--space', 'team', '--json').stdout).length, 2)
  assert.match(cli('setup', '--space', 'team').stdout, /claude mcp add --scope user agent-msg -- node .*agent-msg\.mjs mcp --space team/)
  statSync(join(dir, 'home', 'team.db'))

  // the MCP server: two clients on one space; without --as a client's name and a random tail; a cancelled wait stops
  const server = () => {
    const p = spawn(process.execPath, [BIN, 'mcp', '--space', 'team'], { env, stdio: ['pipe', 'pipe', 'inherit'] })
    const waits = new Map(), lines = createInterface({ input: p.stdout })
    lines.on('line', l => { const m = JSON.parse(l); waits.get(m.id)?.(m); waits.delete(m.id) })
    let n = 0
    const rpc = (method, params) => new Promise(ok => { const id = ++n; waits.set(id, ok); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) })
    return { p, rpc, notify: (method, params) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`), next: () => n + 1 }
  }
  const claude = server(), codex = server()
  const hi = await claude.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'Claude Code' } })
  assert.match(hi.result.instructions, /You are claude-code-[0-9a-f]{4}\./)
  await codex.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } })
  assert.deepEqual((await claude.rpc('tools/list', {})).result.tools.map(t => t.name), TOOL_NAMES)
  const w = codex.rpc('tools/call', { name: 'messages_wait', arguments: { timeout_s: 20 } })
  await new Promise(ok => setTimeout(ok, 300))
  // (codex's wait sees the earlier "hello codex" first — it is new for this name)
  const first = await w
  assert.match(first.result.content[0].text, /hello codex/)
  const w2 = codex.rpc('tools/call', { name: 'messages_wait', arguments: { timeout_s: 20 } })
  await claude.rpc('tools/call', { name: 'messages_post', arguments: { text: 'from claude over MCP', to: undefined } })
  assert.match((await w2).result.content[0].text, /claude-code-[0-9a-f]{4} → everyone: from claude over MCP/)
  const id = codex.next(), w3 = codex.rpc('tools/call', { name: 'messages_wait', arguments: { timeout_s: 60 } })
  await new Promise(ok => setTimeout(ok, 200))
  codex.notify('notifications/cancelled', { requestId: id })
  assert.match((await w3).result.content[0].text, /Nothing came/)
  const bad = await claude.rpc('tools/call', { name: 'messages_post', arguments: { text: '' } })
  assert.equal(bad.result.isError, true)
  for (const s of [claude, codex]) { s.p.stdin.end(); await new Promise(ok => s.p.on('exit', ok)) }

  console.log('messages: ok — space, tools, command and MCP server')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
