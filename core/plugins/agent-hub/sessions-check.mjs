// Agent sessions (sessions.js) over a fake resident Claude Code (a node script speaking stream-json on stdin/stdout) and a
// fake turn-per-start CLI: turns and what they remember, a message while one is at work, the main agent's cap, an idle
// process let go and the conversation resumed, stopping, a restart, removal. Run: node sessions-check.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createSessions, residentArgs, userLine } from './sessions.js'
import { openStore } from './store.js'

const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-sessions-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (f, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(10) } }

// a resident Claude Code: one line a message; it answers with what it was told so far (its memory), `slow` takes 2 s
const cli = join(tmp, 'fake-claude.mjs')
writeFileSync(cli, `
import { createInterface } from 'node:readline'
const resume = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : null
const sid = resume || 'cli-' + process.pid
const heard = resume ? ['(resumed)'] : []
const out = o => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\\n')
if (!process.argv.includes('--input-format')) { out({ type: 'result', is_error: true, result: 'not resident' }); process.exit(1) }
createInterface({ input: process.stdin }).on('line', async line => {
  const m = JSON.parse(line), text = m.message.content[0].text
  heard.push(text)
  out({ type: 'system', subtype: 'init', model: 'fake-model' })
  if (text.includes('slow')) await new Promise(r => setTimeout(r, 2000))
  if (text.includes('die')) process.exit(3)
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + heard.length, name: 'Read', input: { file_path: 'a.txt' } }] } })
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + heard.length }] } })
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'heard: ' + heard.join(' | ') }] } })
  out({ type: 'result', subtype: 'success', result: 'heard: ' + heard.join(' | '), total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } })
})
`)

// pi in RPC mode: commands on stdin, records on stdout; its session named by get_state; `abort` stops a turn, the
// process stays; `slow` takes 2 s unless aborted
const piCli = join(tmp, 'fake-pi.mjs')
writeFileSync(piCli, `
const sid = process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : 'pi-' + process.pid
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
const heard = []
let abort = null, buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); on(JSON.parse(l)) } })
async function on(c) {
  if (c.type === 'get_state') return out({ id: c.id, type: 'response', command: 'get_state', success: true, data: { sessionId: sid } })
  if (c.type === 'abort') { abort?.(); return out({ type: 'response', command: 'abort', success: true }) }
  if (c.type !== 'prompt') return
  if (!process.argv.includes('rpc')) return out({ id: c.id, type: 'response', command: 'prompt', success: false, error: 'not rpc' })
  out({ id: c.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
  heard.push(c.message)
  out({ type: 'tool_execution_start', toolCallId: 'x' + heard.length, toolName: 'read', args: { path: 'a' } })
  out({ type: 'tool_execution_end', toolCallId: 'x' + heard.length, isError: false })
  if (c.message.includes('slow')) await new Promise(r => { abort = r; setTimeout(r, 2000) })
  out({ type: 'message_end', message: { role: 'assistant', model: 'qwen', content: [{ type: 'text', text: 'pi heard: ' + heard.join(' | ') }], usage: { totalTokens: 3 } } })
  out({ type: 'agent_end', messages: [] })
  out({ type: 'agent_settled' })
}
`)

assert.deepEqual(residentArgs(['-p', '--output-format', 'stream-json', '--model', 'm']), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'm'])
assert.deepEqual(JSON.parse(userLine('hi')), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })

const store = openStore(join(tmp, 'hub.db'))
const prepared = []
const prepare = async (d, { text, extra }) => {
  if (d.agent === 'gone') throw Object.assign(new Error('agent "gone" is no longer in the pool'), { code: 'agentGone' })
  prepared.push({ id: d.id, cli: d.cli, text, mcp: extra?.mcp?.name || null, instructions: extra?.instructions || null })
  if (d.runtime === 'claude') return { bin: process.execPath, args: [cli, '-p', '--output-format', 'stream-json', ...(d.cli ? ['--resume', d.cli] : [])], env: {}, cleanup() {} }
  if (d.runtime === 'pi') return { bin: process.execPath, args: [piCli, '-p', '--mode', 'json', ...(d.cli ? ['--session', d.cli] : [])], env: {}, cleanup() {} }
  return { bin: 'codex', args: ['exec'], input: text, env: {}, cleanup() {} }
}
// a turn-per-start CLI: what runCli hands back, line by line
const turns = []
const runTurn = async (runtime, { input, onLine, signal }) => {
  turns.push(input)
  onLine({ events: [{ type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: `codex: ${input}` }] } } }], sessionId: 'codex-thread-1', output: `codex: ${input}`, tokens: 7 })
  if (input.includes('slow')) await new Promise(r => { const t = setTimeout(r, 2000); signal.addEventListener('abort', () => { clearTimeout(t); r() }) })
  return { code: signal.aborted ? 143 : 0, stderr: '' }
}
let s = createSessions({ store, dir: join(tmp, 'sessions'), prepare, runTurn, idleMs: 300, cap: 2 })
const claude = { id: 'sonnet', runtime: 'claude', model: 'claude-sonnet-5-5' }

{ // An old process, or an async preparation, cannot write into a newer turn or resurrect a removed session.
  const db = openStore(join(tmp, 'late.db')), children = []
  const spawnFn = () => {
    const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, exitCode: null, signalCode: null })
    children.push(c); return c
  }
  const late = createSessions({ store: db, dir: join(tmp, 'late'), prepare: async () => ({ bin: 'fake', args: ['-p'] }), spawnFn })
  const d = await late.start({ agent: claude, cwd: tmp, text: 'first' })
  await until(() => children.length === 1)
  late.close(d.id)
  await late.send(d.id, 'second')
  await until(() => children.length === 2)
  const result = text => JSON.stringify({ type: 'result', subtype: 'success', result: text }) + '\n'
  children[0].stdout.write(result('stale'))
  assert.equal(late.get(d.id).state, 'working', 'the newer turn still waits for its own process')
  assert.notEqual(late.get(d.id).said, 'stale')
  late.remove(d.id)
  assert.doesNotThrow(() => children[1].stdout.write(result('after removal')))
  late.dispose(); db.close()
  for (const c of children) { c.stdout.end(); c.stderr.end(); c.emit('close', 0) }

  for (const runtime of ['claude', 'codex']) {
    let release, cleaned = 0, spawned = 0
    const gate = new Promise(r => { release = r })
    const db = openStore(join(tmp, `prepare-${runtime}.db`))
    const pending = createSessions({ store: db, dir: join(tmp, `prepare-${runtime}`), prepare: async () => { await gate; return { bin: 'fake', args: [], cleanup: () => { cleaned++ } } }, spawnFn: () => { spawned++; return spawnFn() }, runTurn: async () => { spawned++; return { code: 0 } } })
    const d = await pending.start({ agent: { id: runtime, runtime }, cwd: tmp })
    const answer = pending.ask(d.id, 'preparing')
    pending.remove(d.id)
    assert.equal((await answer).code, 'cancelled')
    release(); await until(() => cleaned === 1)
    assert.equal(spawned, 0, 'cancelled preparation never starts a CLI')
    pending.dispose(); db.close()
  }
}

{ // two turns in one process: the second remembers the first; usage adds up
  const d = await s.start({ agent: claude, cwd: tmp, text: 'remember 417', by: 'person' })
  await until(() => s.get(d.id).turns === 1)
  assert.equal(s.get(d.id).process, 'on')
  assert.match(s.get(d.id).cli, /^cli-\d+$/, 'the CLI\'s own session id, kept to resume')
  await s.send(d.id, 'what number?')
  await until(() => s.get(d.id).turns === 2)
  assert.equal(s.get(d.id).said, 'heard: remember 417 | what number?', 'one conversation: the second turn knew the first')
  assert.equal(prepared.filter(p => p.id === d.id).length, 1, 'one process for both turns')
  assert.deepEqual([s.get(d.id).tokens, s.get(d.id).cost, s.get(d.id).state], [30, 0.02, 'idle'])
  const kinds = s.read(d.id).events.map(e => e.type)
  assert.deepEqual(kinds, ['note', 'user/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end', 'user/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end'])
  assert.deepEqual(s.read(d.id, { after: 6 }).events.map(e => e.seq), [7, 8, 9, 10, 11], 'read from where the page was')
  // the lyric strip's lines, by rule (agent-work.md §2): each tool call and the first sentence of each reply, the last few
  assert.deepEqual(s.get(d.id).lines.map(l => (l.kind === 'tool' ? `${l.tool} ${l.arg}` : l.said)), ['Read a.txt', 'heard: remember 417', 'Read a.txt', 'heard: remember 417 | what number?'])

  // idle: the process ends, the session stays; the next message starts it again on the CLI's session id
  await until(() => s.get(d.id).process === 'off', 2000)
  const cliId = s.get(d.id).cli
  await s.send(d.id, 'still there?')
  await until(() => s.get(d.id).turns === 3)
  assert.equal(prepared.filter(p => p.id === d.id).at(-1).cli, cliId)
  assert.equal(s.get(d.id).said, 'heard: (resumed) | still there?', 'resumed on its CLI session')

  // a message while one is at work waits for it
  await s.send(d.id, 'slow one')
  assert.deepEqual(await s.send(d.id, 'after it'), { queued: true })
  assert.equal(s.get(d.id).state, 'working')
  await until(() => s.get(d.id).turns === 5, 6000)
  assert.match(s.get(d.id).said, /slow one \| after it$/)

  // stop: the turn ends as stopped, the process with it
  await s.send(d.id, 'slow again')
  await until(() => s.get(d.id).state === 'working')
  assert.deepEqual(s.stop(d.id), { stopped: true })
  assert.equal(s.read(d.id).events.at(-1).data.error, 'stopped')
  await until(() => s.get(d.id).process === 'off')
  assert.equal(s.get(d.id).state, 'idle')
}

{ // the main agent's cap (2 here): an idle one is let go for a new one; when all are at work it must ask
  const a = await s.start({ agent: claude, cwd: tmp, text: 'a', by: 'main' })
  const b = await s.start({ agent: claude, cwd: tmp, text: 'b slow', by: 'main' })
  await until(() => s.get(a.id).turns === 1)
  const c = await s.start({ agent: claude, cwd: tmp, text: 'c slow', by: 'main' })
  assert.equal(s.get(a.id).process, 'off', 'the idle one let go')
  await assert.rejects(s.start({ agent: claude, cwd: tmp, text: 'd', by: 'main' }), e => e.code === 'sessionCap')
  const d = await s.start({ agent: claude, cwd: tmp, text: 'd', by: 'main', confirm: true }) // (the person said yes)
  const p = await s.start({ agent: claude, cwd: tmp, text: 'mine', by: 'person' }) // (the person's own: no cap)
  await until(() => [b, c, d, p].every(x => s.get(x.id).turns === 1), 6000)
  for (const x of [a, b, c, d, p]) s.close(x.id)
}

{ // pi in RPC mode: one process, its session named by get_state; stopping a turn keeps the process; LF-only records
  const d = await s.start({ agent: { id: 'pi-1', runtime: 'pi' }, cwd: tmp, text: 'first\u2028line' })
  await until(() => s.get(d.id).turns === 1)
  assert.match(s.get(d.id).cli, /^pi-\d+$/)
  assert.equal(s.read(d.id).events.find(e => e.type === 'assistant/message').data.message.content[0].text, 'pi heard: first\u2028line', 'a U+2028 inside a record is not a line break')
  await s.send(d.id, 'second')
  await until(() => s.get(d.id).turns === 2)
  assert.equal(s.get(d.id).said, 'pi heard: first line | second', 'the same process, the same conversation')
  assert.equal(prepared.filter(p => p.id === d.id).length, 1)
  await s.send(d.id, 'slow')
  await until(() => s.get(d.id).state === 'working')
  s.stop(d.id)
  await until(() => s.get(d.id).turns === 3)
  assert.deepEqual([s.read(d.id).events.at(-1).data.error, s.get(d.id).process], ['stopped', 'on'], 'stopped by abort: the process stays')
  await s.send(d.id, 'after the stop')
  await until(() => s.get(d.id).turns === 4)
  assert.match(s.get(d.id).said, /\| after the stop$/)
  s.close(d.id)
}

{ // a turn-per-start runtime (Codex): the same session, a CLI each turn on its session id; stopping aborts it
  const d = await s.start({ agent: { id: 'codex-1', runtime: 'codex' }, cwd: tmp, text: 'hello' })
  await until(() => s.get(d.id).turns === 1)
  assert.deepEqual([s.get(d.id).cli, s.get(d.id).said, s.get(d.id).process], ['codex-thread-1', 'codex: hello', 'off'])
  await s.send(d.id, 'slow')
  await until(() => s.get(d.id).state === 'working')
  s.stop(d.id)
  await until(() => s.get(d.id).turns === 2)
  assert.equal(s.read(d.id).events.at(-1).data.error, 'stopped')
}

{ // a run's steps (the workbench's engine): open with a spec, wait for turns with their events as they come, reuse
  // when the spec is the same (another run's tools restart the process on its conversation), why a turn failed
  const rev = { id: 'rev', runtime: 'claude', model: 'haiku' }
  const { id, reused } = await s.open({ agent: rev, cwd: tmp, instructions: 'You do step 1 of run r1.', mcp: { name: 'run-r1' }, of: { run: 'r1', step: 'a' }, title: 'r1 · a' })
  assert.deepEqual([reused, s.info(id).by, s.info(id).of, s.info(id).model, s.info(id).access, s.info(id).process], [false, 'run', { run: 'r1', step: 'a' }, 'haiku', 'write', 'off'])
  assert.equal(s.info(id).title, 'r1 · a', 'its title (what a line about its work calls it)')
  const seen = []
  const r1 = await s.ask(id, 'step a', { onEvent: e => seen.push(`${e.seq}:${e.type}`) })
  assert.deepEqual([r1.output, r1.error, r1.tokens, r1.cost], ['heard: step a', null, 15, 0.01])
  assert.deepEqual(seen, ['3:tool/call', '4:tool/result', '5:assistant/message', '6:turn/end'], 'the turn\'s events as they came, numbered as in its record')
  assert.equal(s.info(id).context, 10, 'how full: the prompt of its last call')
  assert.deepEqual(prepared.filter(x => x.id === id).map(x => [x.mcp, x.instructions]), [['run-r1', 'You do step 1 of run r1.']])
  // the next step of the same run: the same session, the same process; `of` follows the step
  assert.deepEqual(await s.open({ agent: rev, cwd: tmp, mcp: { name: 'run-r1' }, reuse: id, of: { run: 'r1', step: 'b' } }), { id, reused: true })
  const r2 = await s.ask(id, 'step b', { of: { run: 'r1', step: 'b' } })
  assert.deepEqual([r2.output, s.info(id).of.step, prepared.filter(x => x.id === id).length], ['heard: step a | step b', 'b', 1])
  // A running turn cannot have its process/tools replaced by an unrelated open.
  const protectedTurn = s.ask(id, 'slow protected turn')
  await until(() => s.info(id).state === 'working')
  await assert.rejects(s.open({ agent: rev, cwd: tmp, mcp: { name: 'wrong-run' }, reuse: id }), e => e.code === 'sessionMismatch' && e.params.differs === 'busy')
  assert.equal(s.info(id).state, 'working')
  s.stop(id); assert.equal((await protectedTurn).error, 'stopped')
  // another run's tools: the process starts again on the conversation; another model: no
  await s.open({ agent: rev, cwd: tmp, mcp: { name: 'run-r2' }, reuse: id })
  assert.equal((await s.ask(id, 'r2 step')).output, 'heard: (resumed) | r2 step')
  assert.equal(prepared.filter(x => x.id === id).at(-1).mcp, 'run-r2')
  await assert.rejects(s.open({ agent: { ...rev, model: 'opus' }, cwd: tmp, reuse: id }), e => e.code === 'sessionMismatch' && /model/.test(e.params.differs))
  await assert.rejects(s.open({ agent: rev, cwd: tmp, env: { GITLAB_TOKEN: 'x' }, reuse: id }), e => e.code === 'sessionMismatch' && e.params.differs === 'env')
  await assert.rejects(s.open({ agent: rev, cwd: tmp, web: true, reuse: id }), e => e.code === 'sessionMismatch' && e.params.differs === 'web', 'live web search is a start flag')
  await assert.rejects(s.open({ agent: { ...rev, endpoint: 'new-provider' }, cwd: tmp, reuse: id }), e => e.code === 'sessionMismatch' && e.params.differs === 'endpoint', 'the next step cannot send to a process using the previous model endpoint')
  // why a turn failed: timed out, stopped (also while waiting behind another), its process gone, its start failed
  assert.equal((await s.ask(id, 'slow one', { timeoutMs: 300 })).code, 'timeout')
  const ctl = new AbortController(), ctl2 = new AbortController()
  const going = s.ask(id, 'slow again', { signal: ctl.signal }), waiting = s.ask(id, 'behind it', { signal: ctl2.signal })
  await until(() => s.get(id).state === 'working')
  ctl2.abort(); assert.equal((await waiting).code, 'cancelled', 'out of the queue')
  assert.ok(!(s.get(id).queued||[]).some(e=>e.text==='behind it'),'cancelled requests leave the durable queue')
  ctl.abort(); assert.equal((await going).code, 'cancelled')
  const stopping = new AbortController()
  const interrupted = s.ask(id, 'slow with messages behind', { signal: stopping.signal })
  await until(() => s.get(id).state === 'working')
  await s.send(id, 'keep this person message')
  const behind = s.ask(id, 'keep this queued request')
  stopping.abort()
  assert.equal((await interrupted).code, 'cancelled')
  assert.match((await behind).output, /keep this person message.*keep this queued request/)
  assert.deepEqual(s.get(id).queued,[],'draining a queue clears its durable copy')
  const closing = s.ask(id, 'slow before close'), discarded = s.ask(id, 'cancel on close')
  assert.equal((await s.send(id, 'acknowledged but not delivered')).queued,true)
  s.close(id)
  assert.equal((await discarded).code, 'cancelled')
  assert.equal((await closing).code, 'cancelled')
  assert.ok(s.read(id).events.some(e=>e.type==='note'&&e.data.notDelivered&&e.data.text.includes('acknowledged but not delivered')), 'closing records an explicit undelivered notice for queued person input')
  const died = await s.ask(id, 'die now')
  assert.equal(died.code, 'processExited'); assert.match(died.error, /ended \(code 3\)/)
  const g = await s.open({ agent: { id: 'gone', runtime: 'claude' }, cwd: tmp })
  assert.equal((await s.ask(g.id, 'hello')).code, 'agentGone', 'a start\'s own code')
  s.close(id)
}

{ // a restart: a process that was going is gone, a turn that was going is over; removal hides it everywhere
  const d = await s.start({ agent: claude, cwd: tmp, text: 'slow at restart' })
  await until(() => s.get(d.id).process === 'on')
  s.dispose()
  store.putDoc('session', { ...s.get(d.id), process: 'on', state: 'working' }) // (as a crash would leave it)
  s = createSessions({ store, dir: join(tmp, 'sessions'), prepare, runTurn, idleMs: 300 })
  assert.deepEqual([s.get(d.id).process, s.get(d.id).state], ['off', 'idle'])
  assert.match(s.read(d.id).events.at(-1).data.text, /restarted/)
  assert.deepEqual(s.remove(d.id), { removed: true })
  assert.ok(!s.list().some(x => x.id === d.id) && s.get(d.id).removedAt, 'gone from the list, marked for the pages\' sync')
}

{ // in a terminal (mirror.js): the socket the mirror asks, `ruyix session list / attach` through it, the tmux and Zellij
  // windows kept in step — with fake commands: a machine's own tmux and Zellij are never touched by a check
  const { createMirrors, serveSessions, sessionsSockPath, windowName } = await import('./mirror.js')
  const { spawn } = await import('node:child_process')
  const home = join(tmp, 'hub'); (await import('node:fs')).mkdirSync(home)
  const sock = join(home, 'sessions.sock')
  const unserve = serveSessions(s, sock)
  const d = await s.start({ agent: { id: 'sonnet', runtime: 'claude', model: 'm' }, cwd: tmp, title: '查一下竞品', text: 'look around' })
  await until(() => s.get(d.id).turns === 1)
  // who wrote to it and whom it answered (the collaboration graph's links): the person's message, its answer back
  assert.deepEqual(s.get(d.id).links.map(k => `${k.from}>${k.to}:${k.text}`), ['person>self:look around', 'self>person:heard: look around'])
  await s.ask(d.id, 'and the next step', { of: { run: 'r9', stage: 'draft' } })
  assert.deepEqual(s.get(d.id).links.slice(-2).map(k => `${k.from}>${k.to}`), ['run:r9>self', 'self>run:r9'], 'a run\'s step asks: the answer goes back to the run')
  const bin = new URL('../../shell/bin/ruyix-session.mjs', import.meta.url).pathname
  const runBin = (args, ms) => new Promise(res => { const p = spawn(process.execPath, [bin, ...args], { env: { ...process.env, DSH_AGENT_HUB_HOME: home, RUYIX_LANG: 'zh' } }); let out = ''; p.stdout.on('data', c => { out += c }); p.stderr.on('data', c => { out += c }); const t = ms && setTimeout(() => p.kill(), ms); p.on('close', () => { clearTimeout(t); res(out) }) })
  assert.match(await runBin(['list']), new RegExp(`${d.id}\\s+○ sonnet\\s+查一下竞品`))
  {
    const { mkdirSync, rmSync } = await import('node:fs')
    const homeDir = join(tmp, 'socket-home'), hubDir = join(homeDir, '.ruyix/agent-hub'); mkdirSync(hubDir, { recursive: true })
    const stop = serveSessions(s, sessionsSockPath(hubDir))
    try {
      const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, RUYIX_HOME: join(homeDir, 'custom'), RUYIX_LANG: 'zh' }; delete env.DSH_AGENT_HUB_HOME
      const result = await new Promise(resolve => { const p = spawn(process.execPath, [bin, 'list'], { env }); let text = ''; p.stdout.on('data', b => { text += b }); p.stderr.on('data', b => { text += b }); p.on('close', code => resolve({ code, text })) })
      assert.equal(result.code, 0, result.text); assert.ok(result.text.includes(d.id), 'CLI uses the same hub home as the socket server')
    } finally { stop(); rmSync(homeDir, { recursive: true, force: true }) }
  }
  const shown = await runBin(['attach', '查一下'], 1500)
  assert.match(shown, /查一下竞品 · sonnet/)
  assert.match(shown, /› look around[\s\S]*读了 a\.txt[\s\S]*heard: look around[\s\S]*这一轮完了（1 次工具）/, 'its conversation, in words a person reads')
  assert.match(await runBin(['attach', 'nope']), /没有会话「nope」/)
  // the windows: one per session, none for one gone; Zellij likewise when it is here
  const ran = []
  let windows = [], tabs = []
  const run = async (cmd, args) => {
    ran.push(`${cmd} ${args.join(' ')}`)
    if (args.includes('has-session')) return windows.length ? '' : null
    if (args.includes('new-session')) { windows.push(`0 ${args[args.indexOf('-n') + 1]}`); return '' }
    if (args.includes('list-windows')) return windows.join('\n')
    if (args.includes('new-window')) { windows.push(`${windows.length} ${args[args.indexOf('-n') + 1]}`); return '' }
    if (args.includes('kill-window')) { const at = args.at(-1).split(':').pop(); windows = windows.filter(w => !w.startsWith(`${at} `)); return '' }
    if (args.includes('list-sessions')) return 'mine\nruyix\n'
    if (args.includes('list-tabs')) return JSON.stringify([{ tab_id: 0, name: 'Tab #1' }, ...tabs])
    if (args.includes('new-tab')) { tabs.push({ tab_id: tabs.length + 1, name: args[args.indexOf('--name') + 1] }); return '' }
    if (args.includes('close-tab')) { tabs = tabs.filter(t => String(t.tab_id) !== args.at(-1)); return '' }
    return ''
  }
  const m = createMirrors({ attach: id => ['node', 'mirror', id], has: () => true, run })
  const two = [{ id: 'sAAAAA11111', title: '写稿', agent: 'a' }, { id: 'sBBBBB22222', title: '复查', agent: 'b' }]
  await m.sync(two)
  assert.deepEqual(windows.map(w => w.split(' ')[1]), two.map(windowName))
  assert.ok(ran.includes(`tmux -L ruyix new-window -d -t =ruyix-agents: -n ${windowName(two[1])} node mirror sBBBBB22222`))
  assert.ok(ran.includes('zellij attach --create-background ruyix-agents') && !ran.some(r => /--session ruyix /.test(r)), 'its own Zellij session: never a person\'s `ruyix`')
  await m.sync([two[1]])
  assert.deepEqual(windows.map(w => w.split(' ')[1]), [windowName(two[1])], 'a session gone: its window too')
  assert.deepEqual(tabs.map(t => t.name), [windowName(two[1])], 'and its Zellij tab')
  unserve()
}

s.dispose()
{
  let release,cleaned=0;const gate=new Promise(r=>{release=r}),db=openStore(join(tmp,'cap-pending.db'))
  const pending=createSessions({store:db,dir:join(tmp,'cap-pending'),cap:1,prepare:async()=>{await gate;return {bin:'unused',args:[],cleanup(){cleaned++}}},spawnFn:()=>assert.fail('cancelled preparation must not spawn')})
  const first=await pending.start({agent:{id:'cap-agent',runtime:'claude'},cwd:tmp,text:'one',by:'main'})
  await assert.rejects(pending.start({agent:{id:'cap-agent',runtime:'claude'},cwd:tmp,text:'two',by:'main'}),e=>e.code==='sessionCap','preparing process counts toward the cap')
  assert.equal((await pending.send(first.id,'queued in the owned slot')).queued,true)
  pending.close(first.id);release();await until(()=>cleaned===1);pending.dispose();db.close()
}
// A resident CLI must restart when the values of a step's environment change (without persisting secrets).
{
  const { spawn } = await import('node:child_process'), db = openStore(join(tmp, 'env-refresh.db')), seen = []
  const session = createSessions({ store: db, dir: join(tmp, 'env-refresh'), prepare: async (_, { extra }) => ({ bin: process.execPath, args: [cli, '-p', '--output-format', 'stream-json'], env: extra.env }), spawnFn: (bin, args, opts) => { seen.push(opts.env); return spawn(bin, args, opts) }, idleMs: 10000 })
  const base = { agent: claude, cwd: tmp, mcp: { token: 'same-run' }, env: { PATH: '/a', RUYIX_TOOLS_PATH: '/a' } }
  try {
    const opened = await session.open(base); assert.match((await session.ask(opened.id, 'first')).output, /first/)
    await session.open({ ...base, reuse: opened.id, env: { PATH: '/a:/b', RUYIX_TOOLS_PATH: '/a:/b' } }); assert.match((await session.ask(opened.id, 'second')).output, /second/)
    assert.equal(seen.length, 2, 'the old process cannot acquire a changed PATH in place'); assert.equal(seen[1].PATH, '/a:/b')
    assert.equal(db.getDoc('session', opened.id).spec.env, 'PATH,RUYIX_TOOLS_PATH', 'only variable names are persisted')
    const pending = session.ask(opened.id, 'slow work'); await until(() => session.get(opened.id).state === 'working')
    await assert.rejects(session.open({ ...base, reuse: opened.id, env: { PATH: '/c', RUYIX_TOOLS_PATH: '/c' } }), e => e.code === 'sessionMismatch')
    session.close(opened.id); await pending
  } finally { session.dispose(); db.close() }
}

store.close()
rmSync(tmp, { recursive: true, force: true })
// Disposal preserves every queued input as undelivered and never starts a replacement turn.
{
  const db = openStore(join(tmp, 'dispose-queue.db')), dir = join(tmp, 'dispose-queue'); let preparations = 0, running = false
  const config = { store: db, dir, prepare: async () => { preparations++; return { bin: 'fixture', args: [] } }, runTurn: async (_, { signal }) => { running = true; await new Promise(r => signal.addEventListener('abort', r, { once: true })); return { code: 143 } } }
  const pending = createSessions(config)
  const first = await pending.start({ agent: { id: 'a', runtime: 'codex' }, cwd: tmp, text: 'one' })
  await until(() => running)
  await pending.send(first.id, 'two'); await pending.send(first.id, 'three')
  const waiting = pending.ask(first.id, 'four')
  const before = preparations; pending.dispose()
  assert.equal((await waiting).code, 'cancelled'); await new Promise(r => setTimeout(r, 0)); assert.equal(preparations, before)
  const restarted = createSessions(config)
  assert.deepEqual(restarted.read(first.id).events.filter(e => e.data.notDelivered).map(e => e.data.text), ['Not delivered (Ruyix stopped): two', 'Not delivered (Ruyix stopped): three'])
  restarted.dispose(); db.close()
}


// Abrupt process death cannot turn acknowledged queued messages into apparently delivered work.
{
 const {fork}=await import('node:child_process'),{once}=await import('node:events')
 const sessionsURL=new URL('./sessions.js',import.meta.url).href,storeURL=new URL('./store.js',import.meta.url).href
for(const mode of ['working','idle']){
 const home=mkdtempSync(join(tmpdir(),'ruyix-session-crash-')),file=join(home,'child.mjs'),dbFile=join(home,'hub.db'),dir=join(home,'logs')
 const source=`import {createSessions} from ${JSON.stringify(sessionsURL)};import {openStore} from ${JSON.stringify(storeURL)};import {appendFileSync}from'node:fs';import{join}from'node:path';
const db=openStore(process.argv[2]),dir=process.argv[3],s=createSessions({store:db,dir,prepare:async()=>({bin:process.execPath,args:[],env:{}}),runTurn:()=>new Promise(()=>{})});
const first=await s.start({agent:{id:'fixture',runtime:'codex'},cwd:dir,text:'first'});await s.send(first.id,'second queued message');s.ask(first.id,'third queued request');
const d=db.getDoc('session',first.id),after=d.seq+10;appendFileSync(join(dir,first.id+'.jsonl'),JSON.stringify({seq:after,type:'note',data:{text:'progress not yet mirrored'}})+'\\n'+JSON.stringify({seq:after+1}).slice(0,-1));
if(process.argv[4]==='idle')db.putDoc('session',{...d,state:'idle',process:'off'});
process.send({id:first.id,after});setInterval(()=>{},1000);`
 writeFileSync(file,source);const child=fork(file,[dbFile,dir,mode],{silent:true,execArgv:[]});let stderr='';child.stderr.on('data',d=>{stderr+=d});let db,recovered,timer
 try{
  const data=await Promise.race([once(child,'message').then(([x])=>x),once(child,'exit').then(([code])=>{throw Error('fixture child exited '+code+': '+stderr)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('crash fixture timed out: '+stderr)),10000)})]);clearTimeout(timer)
  const dead=once(child,'exit');child.kill('SIGKILL');await dead
  db=openStore(dbFile);const config={store:db,dir,prepare:async()=>{throw Error('recovery must not resend') }};recovered=createSessions(config)
  const notes=recovered.read(data.id,{after:data.after}).events.filter(e=>e.data.notDelivered)
  assert.equal(notes.length,2,mode+': every acknowledged queued message is visibly marked undelivered after a hard crash')
  assert.ok(notes.some(e=>e.data.text.includes('second queued message')));assert.ok(notes.some(e=>e.data.text.includes('third queued request')))
  assert.deepEqual(db.getDoc('session',data.id).queued,[]);recovered.dispose();recovered=createSessions(config)
  assert.equal(recovered.read(data.id).events.filter(e=>e.data.notDelivered).length,2,'recovery does not repeat the warning or resend')
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const dead=once(child,'exit');child.kill('SIGKILL');await dead}recovered?.dispose();db?.close();rmSync(home,{recursive:true,force:true})}
}

}

console.log('agent-hub sessions check: ok')
