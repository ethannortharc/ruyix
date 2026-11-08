// Agent sessions (docs/design/sessions.md §1): an agent, a folder, one conversation and — while it is in use — one
// process that stays: a turn is a message written to it, not a CLI started (DRIVERS — Claude Code reads stream-json from
// stdin, pi takes RPC commands). Codex goes a turn per start for now (`codex exec … resume <id>`): the same conversation,
// a new process each turn. Either way a session's record is the same:
// - its document (store kind 'session'): what the pages and the main agent see — state, the CLI's own session id, usage;
// - its events, numbered, one JSON line each in <dir>/<id>.jsonl: what was asked, what it said, each tool call, each
//   turn's end (dsh-shaped like a task's: tool/call, tool/result, assistant/message; plus user/message, turn/end, note).
// A process left idle for `idleMs` ends; the session stays and the next message starts it again on the CLI's session id.
// The main agent keeps at most `cap` sessions' processes going at once: past that the least recently used idle one is
// let go, and when all are at work it has to ask the person (fail sessionCap; `confirm` goes past it).
import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { launch, stopTree, WIN } from './platform.js'
import { MCP_TOOL_TIMEOUT_MS, parseLine, runCli } from './runtimes.js'
import { LINES_KEPT, firstSentence, lineOf, withAnswers } from './session-text.js'

const LINKS_KEPT = 12

export { withAnswers }

export const SESSION_IDLE_MS = 20 * 60e3
export const MAIN_CAP = 3
const record1 = o => `${JSON.stringify(o)}\n`
/**
 * The runtimes whose process stays between messages, and how each is spoken to (from the print-mode arguments
 * cliCommand gives): `args`, `say(text, n)` a message, `ends(raw)` the end of a turn, `hello()` written once it starts,
 * `reply(raw)` → { cli } | { error } | { done } from its answers to commands, `stop()` a turn stopped with the process kept,
 * `context(raw)` the size of its prompt, in tokens (how full the conversation is: a run starts a fresh one past a cap).
 * The others start once a turn.
 */
export const DRIVERS = {
  // Claude Code: print mode reading its messages from stdin as stream-json; a turn ends with its `result`
  claude: {
    args: args => { const at = args.indexOf('-p'); return at < 0 ? args : [...args.slice(0, at + 1), '--input-format', 'stream-json', ...args.slice(at + 1)] },
    say: text => record1({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }),
    ends: raw => raw.type === 'result',
    // (a result's usage adds up the turn's model calls: one call's prompt is about that over their number)
    context: raw => { const u = raw.type === 'result' && raw.usage; return u ? ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) / Math.max(1, raw.num_turns || 1) : undefined },
  },
  // pi: RPC mode (its docs/rpc.md) — a `prompt` command a message, the turn over at `agent_settled`; `get_state` names
  // its session (to resume it); `abort` stops a turn and keeps the process
  pi: {
    args: args => args.filter((a, i) => !(a === '--mode' || args[i - 1] === '--mode')).flatMap(a => (a === '-p' ? ['--mode', 'rpc'] : [a])),
    hello: () => record1({ id: 'state', type: 'get_state' }),
    say: (text, n) => record1({ id: `m${n}`, type: 'prompt', message: text }),
    ends: raw => raw.type === 'agent_settled',
    reply: raw => {
      if (raw.type !== 'response') return null
      if (raw.command === 'get_state' && raw.success) return { cli: raw.data?.sessionId }
      if (raw.success === false) return { error: raw.error || `${raw.command} failed` }
      if (raw.command === 'prompt' && raw.data?.disposition === 'handled') return { done: true } // (no run follows)
      return null
    },
    stop: () => record1({ type: 'abort' }),
    context: raw => { const u = raw.type === 'message_end' && raw.message?.role === 'assistant' && raw.message.usage; return u ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : undefined },
  },
}
export const RESIDENT = new Set(Object.keys(DRIVERS))
/** A resident Claude Code's arguments, and one message to it. */
export const residentArgs = args => DRIVERS.claude.args(args)
export const userLine = text => DRIVERS.claude.say(text)
/** A stream's records, split on LF only (readline also splits on U+2028 / U+2029, which a JSON string may hold). */
function onRecords(stream, fn) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const r = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); fn(r) } })
  stream.on('end', () => { if (buf) fn(buf) })
}

const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
const say = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const ev = (type, data) => ({ type, time: Date.now(), data })

/**
 * `prepare(doc, { text })` → { bin, args, input, env, cwd?, codexHome?, cleanup() }: what to start for this session
 * (Agent Hub's: the agent's model, effort, access, skills, endpoint and key; `doc.cli` to resume). For a resident
 * runtime it is asked once a process, its `input` unused; for the others once a turn, `input` the message.
 */
export function createSessions({ store, dir, prepare, logger, idleMs = SESSION_IDLE_MS, cap = MAIN_CAP, spawnFn = spawn, runTurn = runCli, now = Date.now }) {
  mkdirSync(dir, { recursive: true })
  const live = new Map() // id → { child?, queue: [text], busy, idle?, controller?, state, cleanup? }
  let disposed = false // (after dispose the store may be closed: late process ends change nothing)
  const saving = new Map()
  const doc = id => store.getDoc('session', id)
  const put = (id, patch) => { const d = { ...doc(id), ...patch }; store.putDoc('session', d); return d }
  const queued = l => l.queue.map(({ text, from }) => ({ text, from }))
  const saveQueue = id => put(id, { queued: queued(live.get(id) || { queue: [] }), seq: live.get(id)?.seq ?? doc(id)?.seq ?? 0 })
  const enqueue = (id, l, entry) => {
    l.queue.push(entry)
    try { saveQueue(id) } catch (err) { l.queue.splice(l.queue.indexOf(entry), 1); throw err }
  }
  const saveSoon = (id, patch) => {
    const l = live.get(id)
    if (l) Object.assign(l.pending ||= {}, patch)
    if (saving.has(id)) return
    saving.set(id, setTimeout(() => { saving.delete(id); const p = live.get(id)?.pending; if (p && doc(id)) { live.get(id).pending = null; put(id, p) } }, 500))
  }
  const flush = id => { clearTimeout(saving.get(id)); saving.delete(id); const p = live.get(id)?.pending; if (p && doc(id)) { live.get(id).pending = null; put(id, p) } }
  const logOf = id => join(dir, `${id}.jsonl`)
  const record = (id, e) => {
    const seq = (live.get(id)?.seq ?? doc(id)?.seq ?? 0) + 1
    if (live.get(id)) live.get(id).seq = seq
    appendFileSync(logOf(id), `${JSON.stringify({ seq, ...e })}\n`)
    return seq
  }

  // a restart: no process survived it; a turn that was going is over
  for (const d of store.docs('session')) {
    const pending = Array.isArray(d.queued) ? d.queued : [], interrupted = d.process === 'on' || d.state === 'working'
    if (interrupted || pending.length) {
      const text = existsSync(logOf(d.id)) ? readFileSync(logOf(d.id), 'utf8') : ''
      let seq = d.seq || 0
      for (const line of text.split('\n')) { try { const e = JSON.parse(line); if (Number.isSafeInteger(e.seq)) seq = Math.max(seq, e.seq) } catch { /* a crash may leave a partial last line */ } }
      if (text && !text.endsWith('\n')) appendFileSync(logOf(d.id), '\n')
      const note = data => appendFileSync(logOf(d.id), `${JSON.stringify({ seq: ++seq, ...ev('note', data) })}\n`)
      if (interrupted) note({ text: d.state === 'working' ? 'stopped: Ruyix restarted during this turn' : 'Ruyix restarted' })
      for (const e of pending) note({ text: `Not delivered (Ruyix restarted): ${e.text}`, from: e.from, notDelivered: true })
      store.putDoc('session', { ...d, process: 'off', state: 'idle', now: null, queued: [], seq, ...(d.state === 'working' && { error: 'stopped: Ruyix restarted during this turn' }) })
    }
  }

  const list = () => store.docs('session').sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  const mainOn = except => list().filter(d => d.by === 'main' && (d.process === 'on' || (RESIDENT.has(d.runtime) && live.get(d.id)?.busy)) && d.id !== except)

  /** Room for one more process of the main agent's: let the least recently used idle one go, else ask. */
  const makeRoom = (d, confirm) => {
    if (d.by !== 'main' || confirm) return
    const on = mainOn(d.id)
    if (on.length < cap) return
    const idle = on.filter(x => x.state !== 'working').sort((a, b) => (a.lastAt || 0) - (b.lastAt || 0))[0]
    if (idle) { endProcess(idle.id, 'let go for a new one (at most ' + cap + ' at once)'); return }
    throw fail('sessionCap', { cap, sessions: on.map(x => x.id).join(', ') }, `${on.length} sessions are at work (${on.map(x => x.title || x.id).join(', ')}): ask the person before starting another`)
  }

  const endProcess = (id, why) => {
    const l = live.get(id)
    if (!l) return
    clearTimeout(l.idle)
    if (l.child) { const c = l.child; l.child = null; stopTree(c, 'SIGTERM'); setTimeout(() => c.exitCode === null && c.signalCode === null && stopTree(c, 'SIGKILL'), 5000).unref?.() }
    l.controller?.abort()
    l.cleanup?.(); l.cleanup = null
    if (doc(id)?.process === 'on') { flush(id); put(id, { process: 'off', ...(l.busy ? {} : { state: 'idle' }) }) }
    if (why) record(id, ev('note', { text: why }))
  }

  const idleSoon = id => {
    const l = live.get(id)
    clearTimeout(l?.idle)
    if (l?.child) { l.idle = setTimeout(() => { if (!l.busy) endProcess(id, `idle for ${idleMs >= 60e3 ? `${Math.round(idleMs / 60e3)} min` : `${Math.round(idleMs / 1000)} s`}: the process ended (the next message starts it again)`) }, idleMs); l.idle.unref?.() }
  }

  /** One parsed line of the CLI (parseLine's): its events recorded, the turn's facts kept. */
  const onParsed = (id, r) => {
    const l = live.get(id)
    if (disposed || !l) return
    const t = l.turn ||= { at: now(), tools: 0 }
    for (const e of r.events) {
      const seq = record(id, e)
      t.onEvent?.({ seq, ...e })
      addLine(id, e)
      if (e.type === 'tool/call') { t.tools++; saveSoon(id, { now: { phase: 'tool', tool: e.data.name } }) }
      if (e.type === 'assistant/message') saveSoon(id, { now: { phase: 'thinking', said: say(e.data.message?.content?.[0]?.text, 160) } })
    }
    if (r.sessionId) saveSoon(id, { cli: r.sessionId })
    if (r.model) saveSoon(id, { model: r.model })
    for (const k of ['output', 'error', 'tokens', 'usage', 'cost']) if (r[k] !== undefined && r[k] !== null) t[k] = r[k]
  }
  /** One line of a resident CLI: its events, its answers to commands, the end of a turn (DRIVERS). */
  const onLine = (id, runtime, line, state) => {
    let raw
    try { raw = JSON.parse(line) } catch { return }
    const drv = DRIVERS[runtime], l = live.get(id)
    onParsed(id, parseLine(runtime, line, state))
    const r = drv.reply?.(raw)
    const size = drv.context?.(raw)
    if (size && l?.turn) l.turn.context = Math.round(size)
    if (r?.cli) saveSoon(id, { cli: r.cli })
    if ((r?.error || r?.done) && l?.busy) return endTurn(id, r.error)
    if (drv.ends(raw)) endTurn(id)
  }

  /** A turn over: `code` why it failed when that is known (cancelled, timeout, processExited, a prepare error's own). */
  const endTurn = (id, error, code) => {
    if (disposed) return
    const l = live.get(id), d = doc(id)
    if (!l?.busy || !d) return
    const t = l.turn
    if (error && !t.error) t.error = error
    if (t.error) t.code ||= code || 'turnFailed'
    l.busy = false
    clearTimeout(t.timer)
    const end = ev('turn/end', { ok: !t.error, ...(t.error && { error: say(t.error, 600), code: t.code }), output: say(t.output, 4000), tokens: t.tokens || 0, cost: t.cost ?? null, tools: t.tools, ms: now() - t.at })
    const seq = record(id, end) // (not inside onEvent?.(…): without one its arguments are never evaluated)
    t.onEvent?.({ seq, ...end })
    addLine(id, end)
    flush(id)
    put(id, {
      state: 'idle', now: null, turns: (d.turns || 0) + 1, lastAt: now(), seq: l.seq,
      tokens: (d.tokens || 0) + (t.tokens || 0), cost: Math.round(((d.cost || 0) + (t.cost || 0)) * 1e6) / 1e6,
      ...(t.error ? { error: say(t.error, 600) } : { error: null }), said: say(t.output, 300) || d.said || null,
      ...(t.context && { context: t.context }),
      ...(!t.error && t.output && { links: link(id, 'self', t.from, t.output) }), // (its answer, back to whoever asked)
    })
    flush(id) // (the turn's last line)
    t.resolve?.({ output: t.output ?? null, error: t.error || null, code: t.code || null, tokens: t.tokens || 0, cost: t.cost ?? null, usage: t.usage || null, cli: doc(id)?.cli || null })
    const next = l.queue.shift()
    if (next) begin(id, next).catch(err => endTurn(id, err.message, err.code))
    else idleSoon(id)
  }

  /** A resident process for this session (started when there is none). */
  const currentTurn = (id, l, turn) => !disposed && live.get(id) === l && l.busy && l.turn === turn
  const ensureProcess = async (id, turn) => {
    const l = live.get(id)
    if (l.child) return l.child
    const d = doc(id)
    const p = await prepare(d, { extra: l.extra })
    if (!currentTurn(id, l, turn)) { p.cleanup?.(); return null }
    const env = { ...process.env, ...p.env }
    if (!env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS)
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT // (a nested Claude Code refuses to start otherwise)
    const drv = DRIVERS[d.runtime]
    const [cmd, argv] = launch(p.bin, drv.args(p.args))
    const child = spawnFn(cmd, argv, { cwd: p.cwd || d.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !WIN, windowsHide: true })
    l.child = child; l.cleanup = p.cleanup
    const raw = createWriteStream(join(dir, `${id}.raw.jsonl`), { flags: 'a' }) // (the CLI's own lines, for a post-mortem)
    raw.on('error', () => { /* removed meanwhile: the post-mortem copy only */ })
    let stderr = ''
    const state = l.pstate = {}
    child.stdin.on('error', () => {})
    child.on('error', err => { stderr += String(err.message); })
    onRecords(child.stdout, line => {
      if (disposed || live.get(id) !== l || l.child !== child) return
      raw.write(`${line}\n`)
      if (line.trim()) onLine(id, d.runtime, line, state)
    })
    if (drv.hello) child.stdin.write(drv.hello())
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-4000) })
    child.on('close', code => {
      raw.end()
      // let go on purpose (endProcess): all done there — and a newer process may already be at a newer turn
      if (disposed || live.get(id) !== l || l.child !== child) return
      l.child = null; l.cleanup?.(); l.cleanup = null
      const why = `the ${d.runtime} process ended (code ${code})${stderr.trim() ? `: ${say(stderr, 400)}` : ''}`
      if (l.busy) endTurn(id, why, 'processExited')
      flush(id); put(id, { process: 'off' })
      record(id, ev('note', { text: why }))
    })
    put(id, { process: 'on' })
    return child
  }

  /** A turn ({ text, resolve? }): the message to the process (resident) or a CLI started for it (the others). */
  const begin = async (id, { text, from = 'person', resolve, onEvent, timeoutMs }) => {
    const l = live.get(id), d = doc(id)
    l.busy = true
    const turn = l.turn = { at: now(), tools: 0, from, resolve, onEvent }
    if (timeoutMs) turn.timer = setTimeout(() => { if (l.turn === turn && l.busy) { turn.code = 'timeout'; turn.error ||= `no answer within ${Math.round(timeoutMs / 1000)} s`; stop(id) } }, timeoutMs)
    put(id, { state: 'working', queued: queued(l), now: { phase: 'thinking' }, lastAt: now() })
    try {
      if (RESIDENT.has(d.runtime)) {
        const child = await ensureProcess(id, turn)
        if (!child || !currentTurn(id, l, turn)) return
        clearTimeout(l.idle)
        for (const k of ['tokens', 'usage', 'cost', 'last']) delete l.pstate?.[k] // (a turn's own: pi adds up per process)
        child.stdin.write(DRIVERS[d.runtime].say(text, l.n = (l.n || 0) + 1))
        return
      }
      const p = await prepare(d, { text, extra: l.extra })
      if (!currentTurn(id, l, turn)) { p.cleanup?.(); return }
      const controller = l.controller = new AbortController()
      try {
        const { code, stderr } = await runTurn(d.runtime, { bin: p.bin, cwd: p.cwd || d.cwd, args: p.args, input: p.input, signal: controller.signal, logFile: join(dir, `${id}.raw.jsonl`), codexHome: p.codexHome, env: p.env, onLine: r => { if (currentTurn(id, l, turn)) onParsed(id, r) } })
        if (currentTurn(id, l, turn)) {
          if (code !== 0 && !turn.error) turn.error = controller.signal.aborted ? 'stopped' : say(stderr, 600) || `${d.runtime} exited with code ${code}`
          if (controller.signal.aborted) turn.code ||= 'cancelled'
        }
      } finally { p.cleanup?.(); if (l.controller === controller) l.controller = null }
      if (currentTurn(id, l, turn)) endTurn(id)
    } catch (err) { if (currentTurn(id, l, turn)) endTurn(id, err.message, err.code) }
  }
  const liveOf = id => { if (!live.has(id)) live.set(id, { queue: [], busy: false, seq: doc(id)?.seq || 0, lines: doc(id)?.lines || [] }); return live.get(id) }
  /** Its last few lines (the desk's lyric strip: session-text.js lineOf), on its document. */
  const addLine = (id, e) => {
    const ln = lineOf(e), l = live.get(id)
    if (!ln || !l) return
    l.lines = [...(l.lines || []), ln].slice(-LINES_KEPT)
    saveSoon(id, { lines: l.lines })
  }

  /**
   * Who wrote to it and whom it answered (the collaboration graph's links, agent-work.md §6): { from, to, at, text },
   * one end 'self' (the session's agent), the other 'person' (the page, a terminal's mirror), 'main' (the main agent) or
   * 'run:<id>' (a run's step); the last LINKS_KEPT.
   */
  const link = (id, from, to, body) => {
    const l = live.get(id)
    l.links = [...(l.links || doc(id)?.links || []), { from, to, at: now(), text: firstSentence(body, 60) }].slice(-LINKS_KEPT)
    return l.links
  }
  /** A message: now when the session is free, after the turn going otherwise (queued). → { queued } */
  const send = async (id, text, { confirm = false, from = 'person' } = {}) => {
    const d = doc(id)
    if (!d || d.removedAt) throw fail('noSession', { id }, `no session ${id}`)
    const body = String(text ?? '').trim()
    if (!body) throw fail('emptyMessage', {}, 'nothing to send')
    const l = liveOf(id)
    if (RESIDENT.has(d.runtime) && !l.child && !l.busy) makeRoom(d, confirm)
    record(id, ev('user/message', { text: body, from }))
    put(id, { lastAt: now(), seq: l.seq, links: link(id, from, 'self', body) })
    if (l.busy) { enqueue(id, l, { text: body, from }); return { queued: true } }
    begin(id, { text: body, from }).catch(err => { if (l.busy) endTurn(id, err.message, err.code); else put(id, { state: 'idle', error: say(err.message, 600) }) })
    return { queued: false }
  }
  const NOTHING = { output: null, tokens: 0, cost: null, usage: null }

  /**
   * A session for a run's step (docs/design/sessions.md §2a): a new one, or `reuse` one whose spec is the same — another
   * run's MCP (its token) restarts the process on its conversation; any other difference fails sessionMismatch.
   * `instructions`, `skills`, `pins`, `env`, `mcp`, `web` (live web search) go to its CLI at the start of its process: env and
 * mcp only in memory.
   * → { id, reused }
   */
  const open = async ({ agent, runtime, model, effort, access, cwd, instructions = null, skills = [], pins = null, env = null, mcp = null, web = false, title, of = null, reuse = null, by = 'run' }) => {
    const spec = specOf({ runtime: runtime || agent?.runtime, model: model ?? agent?.model, endpoint: agent?.endpoint || null, effort: effort ?? agent?.effort, access: access || agent?.access, cwd, env, skills, web })
    const extra = { instructions, skills, pins, env, mcp, web: !!web }
    if (reuse) {
      const d = doc(reuse)
      if (!d || d.removedAt) throw fail('noSession', { id: reuse }, `no session ${reuse}`)
      const differs = Object.keys(spec).filter(k => JSON.stringify(d.spec?.[k] ?? null) !== JSON.stringify(spec[k]))
      if (differs.length) throw fail('sessionMismatch', { id: reuse, differs: differs.join(', ') }, `session ${reuse} differs in ${differs.join(', ')}: open a fresh one`)
      const l = liveOf(reuse)
      if (JSON.stringify(l.extra?.mcp ?? null) !== JSON.stringify(mcp) || JSON.stringify(l.extra?.env ?? null) !== JSON.stringify(env)) {
        if (l.busy) throw fail('sessionMismatch', { id: reuse, differs: 'busy' }, `session ${reuse} is working: open a fresh one for different tools`)
        if (l.child) endProcess(reuse, 'restarted for changed tools or environment')
      }
      l.extra = extra
      put(reuse, { ...(of && { of }) })
      return { id: reuse, reused: true }
    }
    if (!agent?.id) throw fail('noAgent', {}, 'a session needs an agent of the pool')
    const d = await api.start({ agent: { ...agent, runtime: spec.runtime, model: spec.model, effort: spec.effort, access: spec.access }, cwd, title, by, of })
    put(d.id, { spec })
    liveOf(d.id).extra = extra
    return { id: d.id, reused: false }
  }
  /** What a run's engine decides by: its state, spec, how full its conversation is. */
  const info = id => {
    const d = doc(id)
    if (!d || d.removedAt) return null
    return { id: d.id, title: d.title || '', agent: d.agent, state: d.state, process: d.process, ...d.spec, context: d.context || 0, turns: d.turns || 0, by: d.by, of: d.of, error: d.error || null, cli: d.cli || null }
  }
  /**
   * A message whose turn is waited for (a run's step): → its { output, error, code, tokens, cost, usage, cli }.
   * `signal` stops it (code cancelled), `timeoutMs` too (code timeout); `onEvent(e)` sees each of the turn's events as it
   * comes (with its seq); `of` is what the session works on from now (a run's step).
   */
  const ask = (id, text, { signal, onEvent, timeoutMs, of } = {}) => new Promise((resolve, reject) => {
    const d = doc(id)
    if (!d || d.removedAt) return reject(fail('noSession', { id }, `no session ${id}`))
    const body = String(text ?? '').trim()
    if (!body) return reject(fail('emptyMessage', {}, 'nothing to send'))
    const from = of?.run ? `run:${of.run}` : doc(id).of?.run ? `run:${doc(id).of.run}` : 'run'
    const l = liveOf(id), entry = { text: body, from, resolve, onEvent, timeoutMs }
    record(id, ev('user/message', { text: body, from }))
    put(id, { lastAt: now(), seq: l.seq, ...(of && { of }), links: link(id, from, 'self', body) })
    const cancelled = () => ({ ...NOTHING, error: 'stopped', code: 'cancelled', cli: doc(id)?.cli || null })
    signal?.addEventListener('abort', () => {
      const at = l.queue.indexOf(entry)
      if (at >= 0) {
        l.queue.splice(at, 1)
        try { saveQueue(id) } catch (err) { logger?.warn?.(`agent-hub: queued message cancellation: ${err?.message || err}`) }
        resolve(cancelled())
      } else if (l.busy && l.turn?.resolve === resolve) { l.turn.code = 'cancelled'; stop(id) }
    }, { once: true })
    if (signal?.aborted) return resolve(cancelled())
    if (l.busy) enqueue(id, l, entry)
    else begin(id, entry).catch(err => { if (l.busy) endTurn(id, err.message, err.code); else resolve({ ...NOTHING, error: err.message, code: err.code || 'turnFailed', cli: null }) })
  })
  /**
   * Stop the turn going: a CLI that can (pi) is told and keeps its process (the turn ends at its settling — or, if it does
   * not within 10 s, with the process); Claude Code's process ends (the next message resumes its conversation).
   */
  const stop = id => {
    const l = live.get(id)
    if (!l?.busy) return { stopped: false }
    l.turn.code ||= 'cancelled'
    const drv = DRIVERS[doc(id)?.runtime]
    if (l.child && drv?.stop) {
      l.turn.error ||= 'stopped'
      l.child.stdin.write(drv.stop())
      const turn = l.turn
      setTimeout(() => { if (l.busy && l.turn === turn) { endProcess(id); endTurn(id, 'stopped') } }, 10000).unref?.()
    } else if (l.child) { endProcess(id); endTurn(id, 'stopped') }
    else if (l.controller) l.controller.abort()
    else endTurn(id, 'stopped', 'cancelled') // preparation has not produced a process to stop yet
    return { stopped: true }
  }
  const discardQueue = (id, reason) => {
    for (const e of live.get(id)?.queue.splice(0) || []) {
      if (e.resolve) e.resolve({ ...NOTHING, error: 'stopped', code: 'cancelled', cli: doc(id)?.cli || null })
      else record(id, ev('note', { text: `Not delivered (${reason}): ${e.text}`, from: e.from, notDelivered: true }))
    }
    saveQueue(id)
  }
  /** Let its process go; the session stays (the next message starts it again). */
  const close = id => {
    if (!doc(id)) throw fail('noSession', { id }, `no session ${id}`)
    discardQueue(id, 'session closed')
    stop(id)
    endProcess(id, 'closed')
    endTurn(id, 'stopped', 'cancelled')
    return doc(id)
  }

  const api = {
    open,
    info,
    ask,
    list: () => list().filter(d => !d.removedAt),
    get: doc,
    /** A new session: { agent: { id, runtime, model? }, cwd, title?, text?, by: main | person | run | task, of?, confirm? } */
    async start({ agent, cwd, title, text, by = 'person', of = null, confirm = false }) {
      if (!agent?.id || !agent.runtime) throw fail('noAgent', {}, 'a session needs an agent of the pool')
      if (!cwd) throw fail('sessionNeedsFolder', {}, 'a session needs a folder')
      const id = `s${randomUUID().replace(/-/g, '').slice(0, 9)}`
      const d = { id, agent: agent.id, runtime: agent.runtime, model: agent.model || null, cwd, title: say(title || text || agent.id, 80), by, of, state: 'idle', process: 'off', cli: null, turns: 0, tokens: 0, cost: 0, seq: 0, createdAt: now(), lastAt: now(),
        spec: specOf({ runtime: agent.runtime, model: agent.model, effort: agent.effort, access: agent.access, cwd }) }
      if (text && RESIDENT.has(d.runtime)) makeRoom(d, confirm)
      store.putDoc('session', d)
      liveOf(id)
      record(id, ev('note', { text: `started by ${by}${of ? ` for ${JSON.stringify(of)}` : ''}` }))
      put(id, { seq: live.get(id).seq })
      if (text) await send(id, text, { confirm: true, from: by === 'main' ? 'main' : 'person' })
      return doc(id)
    },
    send,
    /** Its events after `after` (at most `limit`, the newest when cut). */
    read(id, { after = 0, limit = 400 } = {}) {
      const d = doc(id)
      if (!d) throw fail('noSession', { id }, `no session ${id}`)
      const lines = existsSync(logOf(id)) ? readFileSync(logOf(id), 'utf8').split('\n').filter(Boolean) : []
      const events = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(e => e && e.seq > after)
      return { session: d, events: events.slice(-limit), more: events.length > limit }
    },
    stop,
    close,
    /** Its answers so far looked at (the desks count the unseen). */
    seen(id) { const d = doc(id); if (!d) throw fail('noSession', { id }, `no session ${id}`); if ((d.seenTurns || 0) < (d.turns || 0)) put(id, { seenTurns: d.turns }); return { seen: true } },
    /** Out of the list (its record and log go; the document stays, marked, so every page's sync learns of it). */
    remove(id) {
      const d = doc(id)
      if (!d || d.removedAt) return { removed: false }
      close(id)
      live.delete(id)
      put(id, { removedAt: now(), title: d.title, state: 'idle', process: 'off' })
      rmSync(logOf(id), { force: true }); rmSync(join(dir, `${id}.raw.jsonl`), { force: true })
      return { removed: true }
    },
    /** The runtimes with a session's process going (an update waits for them). */
    busyRuntimes: () => new Set(list().filter(d => !d.removedAt && (d.process === 'on' || d.state === 'working')).map(d => d.runtime)),
    dispose() { for (const id of live.keys()) discardQueue(id, 'Ruyix stopped'); for (const id of live.keys()) { stop(id); endProcess(id); endTurn(id, 'stopped', 'cancelled') } for (const t of saving.values()) clearTimeout(t); for (const l of live.values()) clearTimeout(l.idle); disposed = true },
  }
  return api
}

/** What a session's process is started with, as compared for reuse: env by its names only (the values are a run's). */
function specOf({ runtime, model, endpoint = null, effort, access, cwd, env = null, skills = [], web = false }) {
  return { runtime, model: model || null, endpoint, effort: effort || null, access: access || 'write', cwd, env: Object.keys(env || {}).sort().join(','), skills: [...(skills || [])].sort(), web: !!web }
}

const said = (zh, en) => ({ zh, en })
const toolSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
/** A session's events as text for an agent: what was asked, said and done, one line each. */
export function transcript(events, max = 12000) {
  const lines = withAnswers(events).map(e => {
    const d = e.data || {}
    switch (e.type) {
      case 'user/message': return `[${e.seq}] > ${d.text}`
      case 'assistant/message': return `[${e.seq}] ${(d.message?.content || []).map(c => c.text || '').join('').trim()}`
      case 'tool/call': return `[${e.seq}] · ${d.name} ${say(d.arguments, 120)}`
      case 'turn/end': return `[${e.seq}] — turn ${d.ok ? 'done' : `failed: ${d.error}`} (${d.tools} tool calls, ${d.tokens} tokens)`
      case 'note': return `[${e.seq}] (${d.text})`
      default: return null
    }
  }).filter(Boolean)
  const text = lines.join('\n')
  return text.length > max ? `…\n${text.slice(-max)}` : text
}
const line = d => `- ${d.id} | ${d.title} | agent ${d.agent} (${d.runtime}) | ${d.cwd} | ${d.state}${d.process === 'on' ? ', process on' : ''} | ${d.turns} turns | by ${d.by}${d.said ? ` | last: ${say(d.said, 160)}` : ''}${d.error ? ` | error: ${say(d.error, 160)}` : ''}`

/**
 * The main agent's tools over sessions (the shell's system tools, docs/design/main-agent.md). `start(args)` starts one
 * as the main agent's (by 'main'); the rest are the sessions' own (createSessions).
 */
export function sessionTools({ sessions, start, agents }) {
  return [
    {
      name: 'session_list',
      title: said('看会话', 'Sessions'),
      effect: 'read',
      description: 'The pool\'s sessions: long-running conversations with a CLI agent (Claude Code, Codex, pi) in a folder — id, title, agent, folder, state (idle / working), whether its process is on, turns, its last answer. Also the agents a session can take.',
      parameters: toolSchema({}),
      async run() {
        const list = sessions.list()
        return { text: [
          list.length ? 'Sessions (most recently used first):' : 'No sessions yet.', ...list.slice(0, 30).map(line),
          'Agents a session can take:', ...agents().filter(a => a.runtime !== 'dsh').map(a => `- ${a.id} (${a.runtime}${a.model ? `, ${a.model}` : ''})${a.role ? `: ${say(a.role, 100)}` : ''}`),
        ].join('\n') }
      },
    },
    {
      name: 'session_start',
      title: said('开一个会话', 'Start a session'),
      effect: 'direct',
      description: 'Start a session: a conversation with a CLI agent of the pool that goes on, in a folder, and give it its first message. Use one for work that takes several turns or should keep its context; prefer sending to an existing session (session_send) when the work follows on from what that session did in the same folder. Start a new one for unrelated or parallel work, or when a fresh look is wanted (a review: never the session that wrote the work). For a project, give each session its own git worktree folder. At most 3 of your sessions run at once: when the tool says they are all at work, ask the person whether to start another, and only when they say yes call it again with confirm: true. Closing it is its undo.',
      parameters: toolSchema({ agent: { type: 'string', description: 'the pool agent\'s id (session_list)' }, folder: { type: 'string', description: 'absolute path; the home folder when left out' }, title: { type: 'string' }, message: { type: 'string', description: 'its first message: the whole task, self-contained' }, confirm: { type: 'boolean', description: 'only after the person agreed to a 4th session' } }, ['agent', 'message']),
      async run({ agent, folder, title, message, confirm }) {
        try {
          const d = await start({ agent, cwd: folder, title, text: message, by: 'main', confirm: !!confirm })
          return { text: `Started session ${d.id} (${d.agent} in ${d.cwd}); it is working on the message. session_read ${d.id} shows what it does.`, summary: said(`开了会话：${d.title}`, `Started a session: ${d.title}`), undo: { tool: 'session_close', args: { id: d.id } } }
        } catch (err) {
          if (err.code === 'sessionCap') return { text: `${err.message}. Ask the person: "3 sessions are at work — start another one?" and call session_start again with confirm: true only if they say yes.` }
          throw err
        }
      },
    },
    {
      name: 'session_send',
      title: said('给会话发消息', 'Message a session'),
      effect: 'direct',
      description: 'Send a message to a session (session_list). When it is at work, the message waits for the turn under way.',
      parameters: toolSchema({ id: { type: 'string' }, message: { type: 'string' }, confirm: { type: 'boolean', description: 'only after the person agreed to a 4th session (when its process has to start again)' } }, ['id', 'message']),
      async run({ id, message, confirm }) {
        const d = sessions.get(String(id))
        if (!d || d.removedAt) throw new Error(`no session ${id} (session_list)`)
        try {
          const r = await sessions.send(d.id, message, { confirm: !!confirm, from: 'main' })
          return { text: r.queued ? `Queued: ${d.id} is at work; it reads the message after this turn.` : `Sent to ${d.id}; it is working on it.`, summary: said(`给会话发了消息：${d.title}`, `Messaged a session: ${d.title}`) }
        } catch (err) {
          if (err.code === 'sessionCap') return { text: `${err.message}. Ask the person before waking this one (confirm: true), or wait for one to finish.` }
          throw err
        }
      },
    },
    {
      name: 'session_read',
      title: said('看会话做了什么', 'Read a session'),
      effect: 'read',
      description: 'What a session was asked, said and did: one line per message, tool call and turn end, numbered. after: only what came after that number (from an earlier read).',
      parameters: toolSchema({ id: { type: 'string' }, after: { type: 'number' } }, ['id']),
      async run({ id, after }) {
        const { session: d, events } = sessions.read(String(id), { after: Number(after) || 0, limit: 300 })
        return { text: `${line(d)}\n\n${transcript(events) || '(nothing new)'}` }
      },
    },
    {
      name: 'session_stop',
      title: said('停下会话这一轮', 'Stop a session\'s turn'),
      effect: 'direct',
      description: 'Stop the turn a session is at (it keeps its conversation; the next message goes on from there). Only when the person asks, or the session is clearly going wrong.',
      parameters: toolSchema({ id: { type: 'string' } }, ['id']),
      async run({ id }) {
        const r = sessions.stop(String(id))
        return { text: r.stopped ? `Stopped ${id}'s turn.` : `${id} was not at work.`, ...(r.stopped && { summary: said(`停下了会话：${sessions.get(String(id))?.title}`, `Stopped a session: ${sessions.get(String(id))?.title}`) }) }
      },
    },
    {
      name: 'session_close',
      title: said('关掉会话的进程', 'Close a session'),
      effect: 'direct',
      description: 'Let a session\'s process go (it stops a turn under way); the session and its conversation stay — a later message starts it again. Use it when the work is done, to make room.',
      parameters: toolSchema({ id: { type: 'string' } }, ['id']),
      async run({ id }) {
        const d = sessions.close(String(id))
        return { text: `Closed ${d.id}'s process; the session stays.`, summary: said(`关掉了会话：${d.title}`, `Closed a session: ${d.title}`) }
      },
    },
  ]
}
