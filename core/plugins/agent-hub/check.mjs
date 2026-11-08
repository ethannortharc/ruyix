// Self-check for the Host half: projections, SQLite store + delta sync, agent definitions,
// skills, the CLI stream parsers, and the runtime end to end — the agent pool, jobs started
// from a chat (one fresh Lead per job, the default agent), tasks on a fake dsh subagent
// service and fake CLIs on PATH, fallbacks, old teams joining the pool. Run: node check.mjs
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  AGENTS_KIND, TEAM_KIND, activityProjection, agentIdFor, applyActivity, apply, exportAgents, listSkills, normalizeAgent, openStore, parseModel, parseShared, reportProjection, sameAgent,
} from './index.js'
import { cliCommand, codexHomeIn, codexSandboxError, mcpViaEnvFile, parseLine, piHomeIn, runtimeStatus } from './runtimes.js'
import { PICKED_MAX, createEndpoints, endpointLaunch, endpointOfProvider, listModels, localHost, modelsToKeep, normalizeEndpoint, providersFromEndpoints } from './endpoints.js'
import { createInstaller, newer } from './install.js'
import { createLogin, loginCommand, plain } from './login.js'
import { createKeys } from './keys.js'
import { EventEmitter } from 'node:events'

const WIN = process.platform === 'win32'

const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-check-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, what, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (fn()) return
  throw new Error(`timed out waiting for ${what}`)
}
try {
  // ── projections ─────────────────────────────────────────────────────────
  const ev = (type, time, data) => ({ type, time, data })
  let s = activityProjection.init()
  assert.equal(applyActivity(s, ev('session/title', 1, {})), s, 'ignored events keep the state reference')
  s = applyActivity(s, ev('turn/start', 1000, { turn: 1 }))
  s = applyActivity(s, ev('tool/call', 1600, { callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }))
  s = applyActivity(s, ev('tool/result', 4600, { message: { toolCallId: 'c1', isError: true } }))
  assert.deepEqual(s.recent, [{ name: 'bash', target: 'npm test', ms: 3000, ok: false, at: 4600 }], 'done: when (the desk\'s lines are in time order)')
  s = applyActivity(s, ev('turn/end', 6000, { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(s.lastEnd.kind, 'completed')
  let r = reportProjection.init()
  r = reportProjection.apply(r, ev('assistant/message', 1, { message: { content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }] } }))
  assert.equal(reportProjection.apply(r, ev('assistant/message', 2, { message: { content: [{ type: 'tool_use' }] } })).text, 'line 1\nline 2', 'a tool-only message keeps the last reply')

  // ── store: one rev for session rows and documents ───────────────────────
  const file = join(tmp, 'hub.db')
  let store = openStore(file)
  store.touch('a', row => { row.data.title = 'A' })
  store.putDoc('agent', { id: 'A', runtime: 'dsh' })
  const cursor = store.since(0).rev
  store.touch('a', row => { row.data.title = 'A2' })
  store.touch('b', row => { row.data.title = 'B, a chat that leads no job' })
  store.putDoc('job', { id: 'j1', leadId: 'a' })
  store.putDoc('task', { id: 't1', jobId: 'j1', task: 'x'.repeat(5000), output: 'short' })
  const delta = store.since(cursor)
  assert.deepEqual(delta.rows.map(x => x.data.title), ['A2'], 'only the Leads\' sessions sync')
  assert.deepEqual(delta.docs.map(d => [d.kind, d.id]), [['job', 'j1'], ['task', 't1']])
  const cutTask = delta.docs[1]
  assert.ok(cutTask.taskCut && cutTask.task.length === 2000 && !cutTask.outputCut && cutTask.output === 'short', 'a long brief is cut in sync')
  assert.equal(store.getDoc('task', 't1').task.length, 5000, 'and kept whole in the store')
  store.putDoc('job', { id: 'j0', endedAt: 1000 }); store.putDoc('task', { id: 't0', jobId: 'j0' })
  assert.equal(store.prune(5000), 1, 'a job that ended long ago is pruned')
  assert.ok(!store.getDoc('job', 'j0') && !store.getDoc('task', 't0') && store.getDoc('job', 'j1') && store.getDoc('agent', 'A'), 'with its tasks; running jobs and agents stay')
  assert.deepEqual(store.docs('task', 'j1').map(d => d.id), ['t1'], 'tasks group by job')
  store.close()
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true })
  store = openStore(file)

  // ── agent definitions ───────────────────────────────────────────────────
  assert.deepEqual(parseModel('openrouter/openai/gpt-x'), { provider: 'openrouter', model: 'openai/gpt-x' }, 'model ids may contain "/"')
  assert.throws(() => parseModel('nomodel'), /provider\/model/)
  assert.deepEqual(normalizeAgent({ id: ' Dev ', model: { provider: 'p', model: 'fast' } }),
    { id: 'dev', name: 'dev', runtime: 'dsh', model: 'p/fast', effort: null, access: null, skills: [], notes: '' }, 'dsh by default; the work brings its access')
  assert.equal(normalizeAgent({ id: 'p', runtime: 'claude', model: 'claude-fable-5-1[1m]', effort: 'xhigh' }).effort, 'xhigh')
  assert.throws(() => normalizeAgent({ id: 'x', runtime: 'codex', effort: 'max' }), /effort must be one of low, medium, high, xhigh/)
  assert.throws(() => normalizeAgent({ id: 'x', runtime: 'dsh', effort: 'high' }), /the CLI runtimes only/)
  assert.throws(() => normalizeAgent({ id: 'x', runtime: 'gemini' }), /runtime must be one of/)
  assert.throws(() => normalizeAgent({ id: 'x', runtime: 'codex', model: 'rm -rf /' }), /invalid model/)
  assert.throws(() => normalizeAgent({ id: 'lead' }), /invalid agent id/)
  assert.throws(() => normalizeAgent({ id: 'x', access: 'root' }), /access must be one of/)
  assert.deepEqual([{ runtime: 'claude', model: 'claude-opus-5-5' }, { runtime: 'claude', model: 'claude-sonnet-5-5' }, { runtime: 'codex', model: 'gpt-6.1-sol' }, { runtime: 'dsh', model: 'p/ultra' }, { runtime: 'dsh', model: 'p/deepseek-v4' }, { runtime: 'claude' }].map(agentIdFor),
    ['opus', 'sonnet', 'codex', 'ultra', 'deepseek-v4', 'claude'], 'readable ids from what runs')
  assert.ok(sameAgent({ runtime: 'codex', model: 'm', effort: 'xhigh', access: 'full' }, { runtime: 'codex', model: 'm', effort: 'xhigh', access: 'full' }) && !sameAgent({ runtime: 'codex', model: 'm', effort: 'xhigh', access: null }, { runtime: 'codex', model: 'm', effort: 'xhigh', access: 'full' }))
  const shared = exportAgents([normalizeAgent({ id: 'rev', runtime: 'claude', model: 'haiku', skills: ['lint'] })], null)
  assert.deepEqual(parseShared(`dsh-agents:${Buffer.from(JSON.stringify(shared)).toString('base64url')}`).agents.map(a => a.id), ['rev'], 'share codes round-trip')
  const gated = normalizeAgent({ id: 'gateway', runtime: 'claude', model: 'haiku', endpoint: 'gw', browser: false })
  assert.deepEqual(parseShared(JSON.stringify(exportAgents([gated], null))).agents[0], gated, 'an agent round trip keeps its endpoint and disabled browser')
  assert.deepEqual(parseShared(JSON.stringify({ kind: TEAM_KIND, name: 'Old', leadModel: 'p/smart', members: [{ name: 'a', role: 'r', runtime: 'codex', access: 'full', fallback: { runtime: 'claude', model: 'opus', access: 'read' } }, { name: 'b', role: 'r' }] })),
    { specs: [{ runtime: 'codex', model: null, effort: null, access: 'full', skills: [] }, { runtime: 'claude', model: 'opus', effort: null, access: null, skills: [] }, { runtime: 'dsh', model: null, effort: null, access: null, skills: [] }], leadModel: 'p/smart', teamName: 'Old' },
    'an old team file: its members and fallbacks, as what runs')
  assert.throws(() => parseShared('%%%'), /not valid/)
  assert.throws(() => parseShared('{"kind":"other"}'), /not an agents file/)

  // ── skills ──────────────────────────────────────────────────────────────
  const ws = join(tmp, 'ws')
  mkdirSync(join(ws, '.claude', 'skills', 'lint'), { recursive: true })
  writeFileSync(join(ws, '.claude', 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: "Lint like a pro"\n---\nALWAYS RUN THE LINTER')
  assert.equal((await listSkills(ws)).find(k => k.name === 'lint').description, 'Lint like a pro')
  assert.ok((await listSkills([join(tmp, 'elsewhere'), ws])).some(k => k.name === 'lint'), 'skills from every listed workspace')

  // ── CLI parsers ─────────────────────────────────────────────────────────
  const st = {}
  const c = line => parseLine('claude', JSON.stringify(line), st)
  assert.equal(c({ type: 'system', subtype: 'init', model: 'claude-haiku' }).model, 'claude-haiku')
  assert.deepEqual(c({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'a.py' } }] } }).events.map(e => [e.type, e.data.name]), [['tool/call', 'Read']])
  assert.deepEqual(c({ type: 'result', is_error: false, result: 'ok', total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 2 } }), { events: [], output: 'ok', error: undefined, cost: 0.01, tokens: 5, usage: { input_tokens: 3, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 } })
  const x = line => parseLine('codex', JSON.stringify(line), st)
  assert.deepEqual(x({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.py' }] } }).events.map(e => e.type), ['tool/call', 'tool/result'], 'complete-only items still show')
  assert.equal(x({ type: 'turn.failed', error: { message: 'quota' } }).error, 'quota')
  assert.ok(cliCommand('codex', { effort: 'xhigh', access: 'full', instructions: 'I', task: 'T', cwd: '/w' }).args.join(' ').includes('-c model_reasoning_effort=xhigh'))
  assert.ok(cliCommand('claude', { model: 'opus', effort: 'high', access: 'read', instructions: 'I', task: 'T' }).args.join(' ').includes('--model opus --effort high'))
  // Claude Code's own question to the user: nobody here sees it — never offered, at any access
  for (const access of ['read', 'write', 'full']) {
    const a = cliCommand('claude', { access, instructions: 'I', task: 'T' }).args, i = a.indexOf('--disallowedTools')
    assert.ok(i >= 0 && a[i + 1].split(',').includes('AskUserQuestion'), access)
    assert.equal(a.filter(x => x === '--disallowedTools').length, 1, `${access}: one list`)
  }
  assert.ok(cliCommand('claude', { access: 'read', instructions: 'I', task: 'T' }).args.join(' ').includes('--disallowedTools Edit,Write,NotebookEdit,Bash,AskUserQuestion'), 'read keeps its own')
  // a task that may search the web: Codex gets its live search, nothing else changes
  assert.ok(cliCommand('codex', { access: 'read', instructions: 'I', task: 'T', cwd: '/w', web: true }).args.includes('web_search="live"'))
  assert.ok(!cliCommand('codex', { access: 'read', instructions: 'I', task: 'T', cwd: '/w' }).args.includes('web_search="live"'))

  // ── fake CLIs on PATH ───────────────────────────────────────────────────
  const bin = join(tmp, 'bin')
  const logs = join(tmp, 'cli-logs')
  mkdirSync(bin); mkdirSync(logs)
  // a command: a node script; on Windows also <name>.cmd that runs it, the way npm's shims do (found first on PATH)
  const exe = (file, code) => {
    writeFileSync(file, code); chmodSync(file, 0o755)
    if (WIN) { writeFileSync(`${file}.js`, code); writeFileSync(`${file}.cmd`, `@"%~dp0\\${basename(file)}.js" %*\r\n`) }
    return WIN ? `${file}.cmd` : file
  }
  const fake = (name, lines) => {
    exe(join(bin, name), `#!/usr/bin/env node
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0) }
if (process.argv[2] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0) }
if (process.argv[2] === 'sandbox') { if (${JSON.stringify(name)} === 'codex-broken') { console.error('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'); process.exit(1) } process.exit(0) }
if (process.argv.includes('--input-format')) {
  require('readline').createInterface({ input: process.stdin }).on('line', l => {
    const text = JSON.parse(l).message.content[0].text
    require('fs').writeFileSync(${JSON.stringify(logs)} + '/resident-${name}-' + process.pid + '-' + Date.now() + Math.random() + '.json', JSON.stringify({ args: process.argv.slice(2), input: text, pid: process.pid }))
    for (const line of ${JSON.stringify(lines)}) console.log(JSON.stringify({ session_id: 'claude-s' + process.pid, ...line }))
  })
} else {
let input = ''
process.stdin.on('data', d => { input += d }).on('end', async () => {
  const piDir = process.env.PI_CODING_AGENT_DIR, readIn = f => { try { return JSON.parse(require('fs').readFileSync(piDir + '/' + f, 'utf8')) } catch { return null } }
  require('fs').writeFileSync(${JSON.stringify(logs)} + '/${name}-' + Date.now() + Math.random() + '.json', JSON.stringify({ args: process.argv.slice(2), input, toolTimeout: process.env.MCP_TOOL_TIMEOUT || null, codexHome: process.env.CODEX_HOME || null,
    pi: piDir ? { dir: piDir, mcp: readIn('mcp.json'), models: readIn('models.json'), sessions: process.env.PI_CODING_AGENT_SESSION_DIR } : null, endpointKey: process.env.RUYIX_ENDPOINT_KEY || null,
    pluginSkills: process.argv.includes('--plugin-dir') ? require('fs').readdirSync(process.argv[process.argv.indexOf('--plugin-dir') + 1] + '/skills').map(n => n + ':' + require('fs').existsSync(process.argv[process.argv.indexOf('--plugin-dir') + 1] + '/skills/' + n + '/SKILL.md')) : null }))
  if (input.includes('SLOW')) await new Promise(r => setTimeout(r, 20000))
  if (${JSON.stringify(name)} === 'codex' && input.includes('QUOTA')) { console.log(JSON.stringify({ type: 'turn.failed', error: { message: '429: rate limit exceeded' } })); process.exit(1) }
  for (const line of ${JSON.stringify(lines)}) console.log(JSON.stringify(line))
})
}
`)
  }
  fake('claude', [
    { type: 'system', subtype: 'init', model: 'claude-haiku-4-5' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'a.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1' }] } },
    { type: 'result', is_error: false, result: 'review: looks good', total_cost_usd: 0.002, usage: { input_tokens: 10, output_tokens: 5 } },
  ])
  fake('codex', [
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'ops: ran ls' } },
    { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } },
  ])
  fake('codex-broken', [])
  fake('pi', [
    { type: 'session', id: 'pi-s9' },
    { type: 'message_end', message: { role: 'assistant', model: 'qwen3', content: [{ type: 'text', text: 'pi: done' }], usage: { totalTokens: 9 } } },
    { type: 'agent_end', messages: [] },
  ])
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
  assert.equal((await runtimeStatus('claude')).status, 'ready')
  assert.equal((await runtimeStatus('codex')).status, 'ready')
  assert.equal((await runtimeStatus('claude', null)).status, 'missing')
  const authProbe = join(bin, 'auth-probe')
  const probe = async (runtime, code) => {
    return runtimeStatus(runtime, exe(authProbe, `#!/usr/bin/env node\n${code}`))
  }
  assert.equal((await probe('claude', "console.log(JSON.stringify({ loggedIn: false, accessToken: 'must-not-escape' })); process.exit(1)")).status, 'unauthenticated')
  assert.equal((await probe('claude', "console.error('unsupported auth command; token=must-not-escape'); process.exit(2)")).status, 'unverified')
  assert.equal((await probe('codex', "console.error('Not logged in'); process.exit(1)")).status, 'unauthenticated')
  assert.equal((await probe('codex', "console.error('bad configuration; token=must-not-escape'); process.exit(1)")).status, 'unverified')
  // an account or an API key: said apart
  assert.equal((await probe('claude', "console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }))")).how, 'key')
  assert.equal((await probe('claude', "console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))")).how, 'account')
  assert.equal((await probe('codex', "console.log('Logged in using an API key - sk-proj-***e1234')")).how, 'key')
  assert.equal((await probe('codex', "console.log('Logged in using ChatGPT')")).how, 'account')
  assert.equal(await codexSandboxError(join(bin, 'codex')), null)
  // Windows: no bubblewrap to probe (Codex's own sandbox starts with it)
  assert.equal(await codexSandboxError(join(bin, 'codex-broken')), WIN ? null : 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted')
  const cliRuns = name => readdirSync(logs).filter(f => f.startsWith(`${name}-`)).sort().map(f => JSON.parse(readFileSync(join(logs, f), 'utf8')))

  // ── plugin wiring with fake dsh ─────────────────────────────────────────
  const calls = []
  const listeners = {}
  const effects = []
  const on = (name, fn) => { (listeners[name] ||= []).push(fn); return () => {} }
  const emit = (name, payload) => (listeners[name] || []).forEach(fn => fn(payload))
  const makeAgent = (id, extra = {}) => {
    const tools = new Map()
    const restricted = []
    return {
      id, status: 'idle', session: { header: { cwd: ws, ...extra.header } },
      ctx: {
        tools: {
          register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
          view: () => ({ restrictableNames: new Set(['read', 'write', 'edit', 'bash', 'grep', 'spawn_teammate', 'team_task_list', 'send_message']) }),
          restrict: filter => { restricted.push(filter); return () => { restricted.splice(restricted.indexOf(filter), 1) } },
        },
      },
      tools, restricted,
    }
  }
  const agents = new Map()
  const chat = makeAgent('chat')
  agents.set('chat', chat)
  let route, changed, leadsMade = 0
  const llmAsked = []
  const systemTools = new Map(), hubParts = new Map()
  const subagentStarts = []
  // dsh's settings, as Agent Hub reads them: the model providers (llm-pi-ai) — the model endpoints' one list
  const dshSettings = { providers: {}, describe: () => [{ ns: 'llm-pi-ai', value: { providers: dshSettings.providers } }],
    mutate: async (ns, ops) => { for (const o of ops) if (o.op === 'set' && o.path[0] === 'providers') dshSettings.providers[o.path[1]] = o.value } }
  // the workbench's tasks, as far as a session started in a turn of the conversation needs them (no feed: no create)
  const wbTasks = { now: null, said: [], linked: [], current() { return this.now }, update(id, patch) { this.said.push([id, patch]) },
    create: t => ({ id: `wt${Math.random().toString(36).slice(2, 6)}`, ...t }), registerSource: () => () => {}, find: () => null, link(id, l) { this.linked.push([id, l]) }, addOutput() {} }
  let systemMcpOn = false
  const ctx = {
    inject: (names, fn) => {
      if (names.length === 1 && names[0] === 'settings') fn({ settings: dshSettings, effect: g => effects.push(g()) })
      if (names.length === 1 && names[0] === 'ruyixShell') fn({ ruyixShell: { part: p => { hubParts.set(p.id, p); return () => hubParts.delete(p.id) }, systemMcp: () => systemMcpOn ? { name: 'ruyix', command: 'node', args: ['/x/system.mjs'] } : null, systemTools: { register: tl => { systemTools.set(tl.name, tl); return () => systemTools.delete(tl.name) } }, pageAction() {} }, effect: g => effects.push(g()) })
      if (names.length === 1 && names[0] === 'ruyixWorkbench') fn({ ruyixWorkbench: { tasks: wbTasks }, effect: g => effects.push(g()) })
      if (names.length === 1 && names[0] === 'ruyixBrowser') fn({ ruyixBrowser: { mcp: use => ({ name: 'ruyix-browser', command: 'node', args: ['browser-mcp.mjs'], env: { RUYIX_BROWSER_WHO: use.who, RUYIX_BROWSER_OF: use.of || '' } }) }, effect: g => effects.push(g()) })
    },
    sessionController: {
      modelCatalog: async () => ({ groups: [{ id: 'p', name: 'P', models: [{ id: 'fast', name: 'Fast' }, { id: 'smart', name: 'Smart' }] }] }),
      // Like dsh: the new session's agent exists (agent/created) before create() returns.
      create: async req => {
        const lead = makeAgent(`lead-${++leadsMade}`, { header: { cwd: req.cwd ?? ws } })
        agents.set(lead.id, lead)
        emit('agent/created', { agent: lead })
        calls.push(['create', req])
        return { sessionId: lead.id }
      },
      selectModel: async req => calls.push(['model', req]),
      rename: async req => calls.push(['rename', req]),
      prompt: async req => (calls.push(['prompt', req]), { accepted: true }),
      cancel: req => calls.push(['cancel', req]),
      resolveAgent: async id => ({ agent: agents.get(id) }),
    },
    sessionProjections: {
      register: () => () => {},
      snapshot: () => ({ values: {} }),
      onChanged: fn => { changed = fn; return () => {} },
    },
    sessions: { list: () => [] },
    // dsh's model service: what the main model is asked (a lane's summary)
    llm: { async *stream(req) { llmAsked.push(req); yield { type: 'text-delta', text: '它读了 a.py，' }; yield { type: 'text-delta', text: '评审说没问题。' } } },
    connection: { fetch: { register: rr => { route = rr } } },
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    subagents: {
      // Like dsh's spawn provider: a published child whose result settles when its turn ends.
      async start(provider, req) {
        let finish
        const result = new Promise(res => { finish = res })
        const run = { id: `child-${subagentStarts.length + 1}`, provider, req, finish, disposed: false, result, dispose: async () => { run.disposed = true } }
        req.signal.addEventListener('abort', () => finish({ output: [], stopReason: 'aborted' }))
        subagentStarts.push(run)
        return run
      },
    },
    effect: fn => effects.push(fn()),
    provide: (name, value) => { provided[name] = value },
    on,
  }
  const provided = {}
  apply(ctx, {}, store)
  const hub = provided.agentHub
  assert.deepEqual(await hub.setup(), [], 'an empty pool needs no CLI installed')
  {
    // a plugin seeds the agents it needs: once each, a person's deletion or edit stays
    hub.ensureAgents([{ id: 'opus', name: 'Claude Opus', runtime: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, { id: 'codex', name: 'Codex', runtime: 'codex', access: 'full' }])
    assert.deepEqual((await hub.setup()).map(s => s.id).sort(), ['claude-code', 'codex-cli'], 'the pool\'s CLIs are required')
    const prevPath = process.env.PATH, prevHome = process.env.HOME
    try {
      process.env.PATH = ''
      process.env.HOME = join(tmp, 'fresh-home')
      assert.deepEqual((await hub.setup()).map(s => [s.id, s.status, s.ready]).sort(), [['claude-code', 'missing', false], ['codex-cli', 'missing', false]], 'a new profile without CLIs cannot appear ready')
    } finally {
      process.env.PATH = prevPath
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    }
    const original = readFileSync(join(bin, 'claude'), 'utf8')
    exe(join(bin, 'claude'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({ loggedIn: false })); process.exit(1)\n')
    try { assert.equal((await hub.setup()).find(s => s.id === 'claude-code').ready, false, 'login is checked, not just installation') }
    finally { exe(join(bin, 'claude'), original) }
    assert.equal(hub.adoptAgent({ runtime: 'codex', model: null, effort: null, access: 'full' }), 'codex', 'the same agent is found, not added again')
    store.putDoc('agent', { ...store.getDoc('agent', 'opus'), deleted: true })
    hub.ensureAgents([{ id: 'opus', runtime: 'claude', model: 'claude-opus-5-5' }])
    assert.ok(!hub.agent('opus'), 'a seed a person deleted is not brought back')
    store.putDoc('agent', { ...store.getDoc('agent', 'codex'), deleted: true })
    assert.deepEqual(await hub.setup(), [], 'no agents, no CLIs')
  }
  const call = async body => (await route.fetch(new Request('http://x/api/agent-hub', { method: 'POST', body: JSON.stringify(body) }))).json()
  const tool = (name, args, agent) => agent.tools.get(name).execute(args, { agent, signal: AbortSignal.timeout(20000) })
  const task = id => store.getDoc('task', id)
  const job = id => store.getDoc('job', id)
  const idOf = out => out.text.match(/Assigned (t\w+)/)[1]
  const prompts = sessionId => calls.filter(cc => cc[0] === 'prompt' && cc[1].sessionId === sessionId).map(cc => cc[1].content[0].text)
  // A Lead's turn: running, it says something, then goes idle.
  const leadTurn = (lead, reply) => {
    lead.status = 'running'; emit('agent/status', { agent: lead, status: 'running' })
    if (reply) changed({ id: lead.id }, 'agentReport', { text: reply })
    lead.status = 'idle'; emit('agent/status', { agent: lead, status: 'idle' })
  }

  // Chats get the job tools; task runs get nothing.
  assert.deepEqual([...chat.tools.keys()], ['list_skill_packs', 'list_agent_runtimes', 'install_agent_runtime', 'list_agent_pool', 'start_agent_job', 'wait_agent_job'])
  // none of dsh's Agent Teams tool names (its profile gives every session those): one name twice and dsh refuses the session
  const DSH_TEAM_TOOLS = ['interrupt_agent', 'list_agents', 'send_message', 'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'wait_agent']
  assert.deepEqual([...chat.tools.keys()].filter(n => DSH_TEAM_TOOLS.includes(n)), [])
  const child = makeAgent('kid', { header: { origin: 'subagent' } })
  emit('agent/created', { agent: child })
  assert.equal(child.tools.size, 0, 'task runs do not get job tools')

  // The pool: validated agents, ids that stay, a default agent that runs inside dsh.
  const bad = await call({ op: 'saveAgent', id: 'a', model: 'p/nope' })
  assert.match(bad.error, /"a": unknown dsh model/)
  assert.deepEqual([bad.code, bad.params.name, bad.params.model], ['unknownModel', 'a', 'p/nope'], 'panel errors carry a code to translate')
  for (const a of [{ id: 'dev', runtime: 'dsh', model: 'p/fast' }, { id: 'rev', runtime: 'claude', model: 'haiku', skills: ['lint'], notes: 'reviews fast' }, { id: 'ops', runtime: 'codex' }, { id: 'smart', runtime: 'dsh', model: 'p/smart' }]) {
    assert.ok((await call({ op: 'saveAgent', ...a })).agent, a.id)
  }
  assert.equal((await call({ op: 'saveAgent', id: 'rev', runtime: 'claude' })).code, 'agentExists')
  assert.equal((await call({ op: 'saveAgent', prev: 'rev', id: 'rev2', runtime: 'claude' })).code, 'idFixed')
  assert.equal(hub.suggestDefaultAgent('dev'), 'dev', 'a plugin may suggest the default agent while a person has chosen none')
  assert.equal((await call({ op: 'setDefaultAgent', id: 'rev' })).code, 'defaultDsh', 'the default agent runs inside dsh')
  assert.deepEqual(await call({ op: 'setDefaultAgent', id: 'smart' }), { defaultAgent: 'smart' })
  assert.equal(hub.defaultModel(), 'p/smart', 'the assistants\' and helpers\' model')
  assert.equal(hub.suggestDefaultAgent('dev'), 'smart', 'a person\'s choice stays')
  {
    const before = hub.agent('smart')
    const result = await call({ op: 'importAgents', text: JSON.stringify({ kind: AGENTS_KIND, agents: [{ id: 'smart', name: 'Imported replacement', runtime: 'claude', model: 'haiku' }] }) })
    assert.equal((await call({ op: 'mainGet', choices: true })).defaultAgent, 'smart', 'import cannot replace the chosen dsh default with another runtime')
    assert.equal(hub.defaultModel(), 'p/smart'); assert.equal(hub.agent('smart').revision, before.revision)
    assert.ok(result.warnings.some(w => w.includes('smart') && w.includes('default agent')))
    assert.deepEqual(result.agents, [])
  }
  assert.equal((await call({ op: 'saveAgent', prev: 'smart', id: 'smart', runtime: 'claude' })).code, 'defaultDsh')
  assert.deepEqual((await hub.setup()).map(s => [s.id, s.ready]).sort(), [['claude-code', true], ['codex-cli', true]])
  assert.match((await tool('list_agent_pool', {}, chat)).text, /- rev \(claude · haiku · skills: lint\): reviews fast[\s\S]*Default agent \(leads jobs\): smart/)
  // The main agent: any runtime; none chosen → the default agent. The main model follows it (a CLI agent's model is its
  // CLI's: then the default agent's) unless set apart, and must be a dsh model.
  assert.equal(hub.mainAgent().id, 'smart', 'none chosen: the default agent'); assert.equal(hub.mainChosen(), false)
  assert.deepEqual((await call({ op: 'mainSet', agent: 'rev' })).resolved, { agent: 'rev', runtime: 'claude', model: 'p/smart' }, 'a Claude Code main agent; small jobs on the default agent\'s model')
  assert.equal(hub.mainAgent().id, 'rev'); assert.equal(hub.mainChosen(), true)
  await call({ op: 'mainSet', agent: 'dev' })
  assert.equal(hub.mainModel(), 'p/fast', 'follows a dsh main agent')
  assert.equal((await call({ op: 'mainSet', model: 'p/nope' })).code, 'unknownModel')
  assert.equal((await call({ op: 'mainSet', model: 'just-a-name' })).code, 'badModel')
  assert.equal((await call({ op: 'mainSet', agent: 'ghost' })).code, 'noAgent')
  assert.equal((await call({ op: 'mainSet', model: 'p/smart' })).resolved.model, 'p/smart', 'set apart')
  assert.deepEqual(await call({ op: 'mainGet' }), { agent: 'dev', model: 'p/smart', chosen: true, resolved: { agent: 'dev', runtime: 'dsh', model: 'p/smart' } })
  const offer = await call({ op: 'mainGet', choices: true })
  assert.deepEqual([offer.agents.map(a => a.id).sort(), offer.defaultAgent], [['dev', 'ops', 'rev', 'smart'], 'smart'])
  assert.ok(offer.models.includes('p/smart') && offer.models.includes('p/fast'), 'dsh models to pick the main model from')
  await call({ op: 'mainSet', model: null })
  assert.equal(hub.mainModel(), 'p/fast', 'back to following')
  assert.ok((await call({ op: 'saveAgent', id: 'tmp', runtime: 'pi' })).agent)
  await call({ op: 'mainSet', agent: 'tmp' })
  assert.equal((await call({ op: 'deleteAgent', id: 'tmp' })).ok, true)
  assert.equal(hub.mainAgent().id, 'smart', 'its agent deleted: the default agent again')

  // the pool as system tools (agent-tools.js): add, change, take out, the default — each with its way back
  {
    const T = name => systemTools.get(name)
    assert.ok(['agent_list', 'agent_save', 'agent_remove', 'agent_default'].every(n => T(n)?.effect === 'direct' || T(n)?.effect === 'read'))
    const added = await T('agent_save').run({ id: 'weekly', name: '写周报', runtime: 'claude', model: 'sonnet', notes: '每周五写周报' })
    assert.equal(added.undo.tool,'agent_unadd');assert.equal(typeof added.undo.args.after,'number')
    assert.match((await T('agent_list').run()).text, /^- weekly \| 写周报 \| claude · sonnet \| 每周五写周报$/m)
    const changed = await T('agent_save').run({ id: 'weekly', model: 'opus' })
    assert.equal(hub.agents().find(a => a.id === 'weekly').notes, '每周五写周报', 'a change keeps what it did not name')
    await T(changed.undo.tool).run(changed.undo.args)
    assert.equal(hub.agents().find(a => a.id === 'weekly').model, 'sonnet', 'undone: as it was')
    await assert.rejects(T('agent_save').run({ id: 'weekly', access: 'full' }), /the person's to set/)
    // A model undo keeps later human access/notes changes, but refuses a conflicting model edit.
    let current = hub.agent('weekly')
    await call({ op: 'saveAgent', ...current, prev: current.id, access: 'full' })
    const modelAction = await T('agent_save').run({ id: 'weekly', model: 'opus' })
    const staleForm = hub.agent('weekly')
    await call({ op: 'saveAgent', ...staleForm, prev: 'weekly', expect: staleForm.revision, access: null, notes: 'new human notes' })
    await T(modelAction.undo.tool).run(modelAction.undo.args)
    current = hub.agent('weekly')
    assert.deepEqual([current.access, current.notes, current.model], [null, 'new human notes', 'sonnet'], 'undo cannot re-grant revoked access or erase later fields')
    const staleSave = await call({ op: 'saveAgent', ...staleForm, prev: 'weekly', expect: staleForm.revision, notes: 'old form' })
    assert.equal(staleSave.code, 'agentChanged'); assert.equal(hub.agent('weekly').notes, 'new human notes')
    const sameField = await T('agent_save').run({ id: 'weekly', model: 'opus' })
    await T('agent_save').run({ id: 'weekly', model: 'haiku' })
    await assert.rejects(T(sameField.undo.tool).run(sameField.undo.args), e => e.code === 'agentChanged')
    await assert.rejects(T('agent_put_back').run({ def: staleForm }), e => e.code === 'agentChanged', 'unscoped legacy snapshots fail closed')
    const catalog = ctx.sessionController.modelCatalog, realNow = Date.now; let releaseModels
    Date.now = () => realNow() + 301000
    ctx.sessionController.modelCatalog = () => new Promise(resolve => { releaseModels = async () => resolve(await catalog()) })
    const slowSave = call({ op: 'saveAgent', ...hub.agent('weekly'), prev: 'weekly', runtime: 'dsh', model: 'p/fast' })
    await until(() => releaseModels, 'model validation started')
    await T('agent_save').run({ id: 'weekly', notes: 'saved during validation' })
    releaseModels(); assert.equal((await slowSave).code, 'agentChanged', 'async validation cannot overwrite a concurrent save')
    ctx.sessionController.modelCatalog = catalog; Date.now = realNow
    const coupled = await T('agent_save').run({ id: 'weekly', model: 'opus' })
    const latest = hub.agent('weekly')
    await call({ op:'saveAgent', ...latest, prev:'weekly', runtime:'codex', model:'codex-model' })
    await assert.rejects(T(coupled.undo.tool).run(coupled.undo.args),e=>e.code==='agentChanged','a model undo cannot restore a Claude model into a later Codex agent')
    const out = await T('agent_remove').run({ id: 'weekly' })
    assert.ok(!hub.agents().some(a => a.id === 'weekly'))
    await T(out.undo.tool).run(out.undo.args)
    assert.equal(hub.agents().find(a => a.id === 'weekly')?.name, '写周报', 'back as it was')
    await assert.rejects(T(added.undo.tool).run(added.undo.args),e=>e.code==='agentChanged','old create undo preserves later agent settings')
    await T('agent_remove').run({id:'weekly'})
    assert.ok(!hub.agents().some(a => a.id === 'weekly'))
    const fresh=await T('agent_save').run({id:'fresh-undo',runtime:'claude'})
    await call({op:'mainSet',agent:'fresh-undo'});await assert.rejects(T(fresh.undo.tool).run(fresh.undo.args),e=>e.code==='agentChanged','an older create undo cannot erase a later main-agent choice')
    await call({op:'mainSet',agent:'smart'});await T(fresh.undo.tool).run(fresh.undo.args);assert.ok(!hub.agent('fresh-undo'))
    const def = await T('agent_default').run({ id: 'dev' })
    assert.equal((await call({ op: 'mainGet', choices: true })).defaultAgent, 'dev')
    await T(def.undo.tool).run(def.undo.args)
    assert.equal((await call({ op: 'mainGet', choices: true })).defaultAgent, 'smart', 'the default back')
    const staleDefault=await T('agent_default').run({id:'dev'})
    await call({op:'setDefaultAgent',id:'smart'})
    await assert.rejects(T(staleDefault.undo.tool).run(staleDefault.undo.args),e=>e.code==='agentChanged')
    assert.equal(hub.defaultAgent().id,'smart')
    const [firstDefault]=await Promise.all([T('agent_default').run({id:'dev'}),T('agent_default').run({id:'smart'})])
    assert.equal(firstDefault.undo.args.after,'dev','undo binds the value actually written, not a concurrent later default')
    await assert.rejects(T(firstDefault.undo.tool).run(firstDefault.undo.args),e=>e.code==='agentChanged')
    await call({op:'setDefaultAgent',id:'dev'});await call({op:'mainSet',agent:'dev'})
    const removedDefault=await T('agent_remove').run({id:'dev'})
    await call({op:'setDefaultAgent',id:'smart'});await call({op:'mainSet',agent:'smart'})
    await T(removedDefault.undo.tool).run(removedDefault.undo.args)
    assert.equal(hub.defaultAgent().id,'smart','restoring an agent preserves a later default choice')
    assert.equal(hub.mainAgent().id,'smart','restoring an agent preserves a later main-agent choice')
  }
  // the person's own skills (skill-tools.js): saved, given to an agent, changed (a new version), undone, taken out and back
  {
    const T = name => systemTools.get(name)
    const saved = await T('skill_save').run({ name: 'weekly-report', description: '写周报时用：按项目列出本周做了什么', body: '# 周报\n\n1. 按项目分。' })
    assert.match((await T('skill_list').run()).text, /^- mine\/weekly-report: 写周报时用/m)
    const scribe = await T('agent_save').run({ id: 'scribe', runtime: 'claude', skills: ['mine/weekly-report'] })
    assert.deepEqual(hub.agents().find(a => a.id === 'scribe').skills, ['mine/weekly-report'], 'an agent given the skill')
    await T(scribe.undo.tool).run(scribe.undo.args)
    const ver = () => hub.skillPacks?.version?.('mine') ?? null
    const before = ver()
    const changed = await T('skill_save').run({ name: 'weekly-report', description: '写周报', body: '# 周报 v2' })
    assert.ok(ver() === null || ver() !== before, 'a change: a new version')
    await T(changed.undo.tool).run(changed.undo.args)
    assert.match((await T('skill_list').run()).text, /mine\/weekly-report: 写周报时用/)
    const out = await T('skill_remove').run({ name: 'weekly-report' })
    assert.ok(!/weekly-report/.test((await T('skill_list').run()).text))
    await T(out.undo.tool).run(out.undo.args)
    assert.match((await T('skill_list').run()).text, /mine\/weekly-report/)
    await T(saved.undo.tool).run(saved.undo.args)
    assert.ok(!/weekly-report/.test((await T('skill_list').run()).text), 'the first save undone: gone')
    const staleSkill=await T('skill_save').run({name:'undo-test',description:'first',body:'first body'})
    await T('skill_save').run({name:'undo-test',description:'later',body:'person wrote this later'})
    await assert.rejects(T(staleSkill.undo.tool).run(staleSkill.undo.args),e=>e.code==='skillChanged')
    assert.match(readFileSync(join(store.dir,'skills-mine','undo-test','SKILL.md'),'utf8'),/person wrote this later/)
    await T('skill_remove').run({name:'undo-test'})
    await assert.rejects(T('skill_save').run({ name: 'Bad Name', description: 'x', body: 'y' }), /lowercase/)
  }

  // Skill packs: a team repository pinned to a commit; agents name its skills "pack/skill"; a shared agents file carries
  // the pack's source and commit, and another machine adds the pack from it.
  {
    const src = join(tmp, 'sop-src')
    mkdirSync(join(src, 'skills', 'review-sop'), { recursive: true })
    writeFileSync(join(src, 'skills', 'review-sop', 'SKILL.md'), '---\nname: review-sop\ndescription: The team review SOP\n---\nCheck the MR template.')
    for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'v1']]) execFileSync('git', a, { cwd: src })
    assert.equal((await call({ op: 'skillPackAdd', id: 'Bad Id', git: src })).code, 'badPackId')
    const { pack } = await call({ op: 'skillPackAdd', id: 'sop', git: `file://${src}`, ref: 'main', path: 'skills' })
    assert.deepEqual([pack.kind, pack.version.length, pack.skills.map(k => k.name)], ['git', 10, ['review-sop']])
    assert.match((await tool('list_skill_packs', {}, chat)).text, /## sop \(git @ \w{10}[\s\S]*- sop\/review-sop: The team review SOP/)
    await call({ op: 'saveAgent', id: 'packed', runtime: 'claude', model: 'haiku', skills: ['sop/review-sop', 'lint'] })
    const listed = await call({ op: 'skillPacks', cwds: [ws] })
    const sopPack = listed.packs.find(p => p.id === 'sop')
    assert.deepEqual(sopPack.usedBy.map(u => `${u.by} · ${u.where.en}`), ['packed · packed'], 'the page says which agent uses a pack')
    assert.deepEqual(sopPack.skills.find(k => k.name === 'review-sop').usedBy.map(u => u.by), ['packed'], '… and each skill')
    assert.equal(listed.policy.local, false, 'by default agents use skills from packs only')
    assert.ok(listed.unmanaged.some(k => k.ref === 'lint' && k.kind === 'workspace'), 'workspace skills listed apart')
    const sharedPool = await call({ op: 'exportAgents' })
    assert.deepEqual([sharedPool.file.kind, sharedPool.file.defaultAgent], [AGENTS_KIND, 'smart'])
    assert.deepEqual(sharedPool.file.skillPacks.map(p => [p.id, p.git, p.sha.length]), [['sop', `file://${src}`, 40]], 'the export carries the pack and its commit')
    const pinned = sharedPool.file.skillPacks[0].sha
    // a newer commit upstream: the update shows what changes, and the pin moves only on update
    writeFileSync(join(src, 'skills', 'review-sop', 'SKILL.md'), '---\nname: review-sop\ndescription: The team review SOP, v2\n---\nv2')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qam', 'v2'], { cwd: src })
    const check = await call({ op: 'skillPackCheck', id: 'sop' })
    assert.deepEqual([check.upToDate, check.skills, check.commits.length], [false, ['review-sop'], 1])
    // another machine: no pack yet; the import adds it at the exporter's commit (not the newer one)
    await call({ op: 'skillPackRemove', id: 'sop' })
    const imported = await call({ op: 'importAgents', text: sharedPool.code })
    assert.ok(imported.warnings.some(w => /skill packs added: sop/.test(w)))
    assert.equal((await call({ op: 'skillPackCheck', id: 'sop' })).current, pinned, 'pinned where the exporter had it')
    const { pack: newer } = await call({ op: 'skillPackUpdate', id: 'sop' })
    assert.deepEqual([newer.prev, newer.skills[0].description], [pinned, 'The team review SOP, v2'], 'update moves the pin, the old one kept for a rollback')
    // A full configuration reaches the live owner before its agents; subsequent saves retain both old and new packs.
    const { createConfigImporter, importConfig } = await import('../../shell/bin/ruyix-config.mjs')
    const applyConfig = createConfigImporter({ parts: () => [hubParts.get('agentHub')], apply: (c, secrets) => importConfig(c, secrets, { home: join(tmp, 'config-home'), env: { DSH_AGENT_HUB_HOME: store.dir }, products: {} }) })
    const configImport = { kind: 'ruyix-config', version: 2, settings: { 'agent-hub': { skillPacks: { git: { 'import-team': { id: 'import-team', git: `file://${src}`, ref: 'main', path: 'skills', sha: pinned } }, policy: { local: true } } } }, agents: { kind: AGENTS_KIND, version: 1, agents: [{ id: 'config-importer', runtime: 'dsh', model: 'p/fast', skills: ['import-team/review-sop'] }] } }
    const result = await applyConfig(configImport)
    assert.ok(result.every(r => r.ok), JSON.stringify(result))
    assert.ok(hub.agents().some(a => a.id === 'config-importer'))
    assert.equal(hub.skillPolicy().local, true)
    const importedDir = await hub.skillPackDir('import-team')
    assert.match(readFileSync(join(importedDir, 'review-sop/SKILL.md'), 'utf8'), /Check the MR template/)
    assert.equal((await call({ op: 'skillPacks', cwds: [ws] })).packs.find(p => p.id === 'import-team').sha, pinned, 'a new home fetches the exported pin, not the newer ref tip')
    await call({ op: 'skillPolicy', local: false })
    const persisted = JSON.parse(readFileSync(join(store.dir, 'skill-packs.json'), 'utf8'))
    assert.ok(persisted.git.sop && persisted.git['import-team'], 'later owner saves preserve imported and existing definitions')
    // Conflicting definitions fail visibly before consuming the accompanying agents, and can be corrected and retried.
    const conflict = structuredClone(configImport)
    conflict.settings['agent-hub'].skillPacks.git = { untouched: { id: 'untouched', git: `file://${src}`, path: 'skills' }, ...conflict.settings['agent-hub'].skillPacks.git }
    conflict.settings['agent-hub'].skillPacks.git['import-team'].git = 'https://different.invalid/skills'
    conflict.agents.agents[0].id = 'conflict-agent'
    const refused = await applyConfig(conflict)
    assert.ok(refused.some(r => !r.ok && /source or pin conflicts/.test(r.text)))
    assert.ok(!hub.agents().some(a => a.id === 'conflict-agent'))
    assert.equal(hub.skillPolicy().local, false, 'validation fails before changing policy')
    assert.ok(!(await call({ op: 'skillPacks', cwds: [ws] })).packs.some(p => p.id === 'untouched'), 'a later conflict prevents all partial adoption')
    assert.ok(existsSync(join(store.dir, 'import/skill-packs.json.processing')))
    assert.ok((await applyConfig({ ...configImport, agents: conflict.agents })).every(r => r.ok))
    assert.ok(hub.agents().some(a => a.id === 'conflict-agent'))
    for (const id of ['config-importer', 'conflict-agent']) await call({ op: 'deleteAgent', id })
    await call({ op: 'skillPackRemove', id: 'import-team' }); await call({ op: 'skillPolicy', local: false })
    for (const file of ['pool.agents.json', 'skill-packs.json']) rmSync(join(store.dir, 'import/done', file))
    // a skill no pack has stops the job before anything starts
    await call({ op: 'saveAgent', id: 'broken', runtime: 'claude', model: 'haiku', skills: ['sop/nope'] })
    await assert.rejects(hub.startJob({ goal: 'x', cwd: ws, headless: true, agents: ['broken'] }), err => err.code === 'skillMissing')
    await assert.rejects(hub.checkAgents(['nope']), err => err.code === 'noAgent')
    for (const id of ['packed', 'broken']) assert.ok((await call({ op: 'deleteAgent', id })).ok)
  }
  {
    // a declared pack this machine cannot fetch (a private repository, no credentials) keeps the reason for the Skills page
    const { createSkills } = await import('./skills.js')
    const packs = createSkills({ home: join(tmp, 'packs-unreachable') })
    packs.register({ id: 'team-sop', git: `file://${join(tmp, 'no-such-repo')}` })
    await assert.rejects(packs.dirOf('team-sop'))
    const [p] = await packs.list()
    assert.ok(p.error && !p.sha, 'the fetch failure is kept with the pack')
  }
  {
    // a workflow's pin (design: workflow = 总览): a pack this machine lacks is adopted from the source the workflow
    // carries, and its skills come from that commit — not from the pack's newer tip
    const { createSkills } = await import('./skills.js')
    const src = join(tmp, 'pin-src'), g = (...a) => execFileSync('git', ['-C', src, ...a], { stdio: 'pipe' }).toString().trim()
    mkdirSync(join(src, 'skills', 'scan'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', src])
    writeFileSync(join(src, 'skills', 'scan', 'SKILL.md'), '---\nname: scan\ndescription: v1\n---\nfirst')
    g('-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '.'); g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'one')
    const one = g('rev-parse', 'HEAD')
    writeFileSync(join(src, 'skills', 'scan', 'SKILL.md'), '---\nname: scan\ndescription: v2\n---\nsecond')
    g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qam', 'two')
    const packs = createSkills({ home: join(tmp, 'packs-pinned') })
    const pins = { sec: { id: 'sec', git: `file://${src}`, ref: 'main', path: 'skills', sha: one } }
    assert.deepEqual((await packs.check(['sec/scan'], pins)).map(x => x.status), ['fetch'], 'not here yet: fetched when needed')
    assert.deepEqual((await packs.check(['other/x'], {})).map(x => x.status), ['missing'], 'no pack and no source: missing')
    const [hit] = await packs.resolve(['sec/scan'], null, pins)
    assert.ok(!hit.missing && one.startsWith(hit.version) && readFileSync(join(hit.dir, 'SKILL.md'), 'utf8').includes('first'), 'the pinned commit, not the tip')
    assert.deepEqual((await packs.check(['sec/scan'], pins)).map(x => x.status), ['ok'])
    assert.deepEqual(await packs.ensurePins(pins), { fetched: ['sec'], failed: [] })
    assert.deepEqual(packs.pins(['sec']).map(x => [x.id, !!x.git]), [['sec', true]], 'what a workflow carries for it')
    // a bundled pack that pins its skills itself: a workflow carries its hook's word for the skills it
    // names; check, ensure and the folder at the pin are the pack's own
    const v1 = join(tmp, 'shared-v1'), cur = join(tmp, 'shared-cur')
    for (const [d, desc] of [[v1, 'one'], [cur, 'two']]) { mkdirSync(join(d, 'logs'), { recursive: true }); writeFileSync(join(d, 'logs', 'SKILL.md'), `---\nname: logs\ndescription: ${desc}\n---\nx`) }
    const ensured = []
    packs.register({ id: 'shared', dir: cur, version: 'abc', by: 'a-plugin',
      pin: names => ({ skills: Object.fromEntries(names.map(n => [n, { resource: 'r1', version: '2.0.0' }])) }),
      check: async (name, pin) => (pin?.skills?.[name]?.version === '1.0.0' ? 'fetch' : 'ok'),
      ensure: async pin => { ensured.push(pin); return true },
      dirOf: async (name, pin) => (pin?.skills?.[name]?.version === '1.0.0' ? v1 : null) })
    assert.deepEqual(packs.pins(['shared'], ['shared/logs', 'sec/scan']), [{ id: 'shared', version: 'abc', skills: { logs: { resource: 'r1', version: '2.0.0' } } }], 'only the skills the workflow names')
    const old = { shared: { id: 'shared', skills: { logs: { resource: 'r1', version: '1.0.0' } } } }
    assert.deepEqual((await packs.check(['shared/logs'], old)).map(x => x.status), ['fetch'])
    assert.deepEqual(await packs.ensurePins(old), { fetched: ['shared'], failed: [] })
    assert.equal(ensured.length, 1)
    const [atPin] = await packs.resolve(['shared/logs'], null, old)
    assert.match(readFileSync(join(atPin.dir, 'SKILL.md'), 'utf8'), /description: one/, 'the pinned version\'s folder')
    const [current] = await packs.resolve(['shared/logs'], null, {})
    assert.match(readFileSync(join(current.dir, 'SKILL.md'), 'utf8'), /description: two/, 'unpinned: the current one')
    // a skill to read: its SKILL.md and the files beside it; a file as text, a binary one said, nothing out of its folder
    mkdirSync(join(cur, 'logs', 'scripts'), { recursive: true })
    writeFileSync(join(cur, 'logs', 'scripts', 'tail.sh'), 'kubectl logs --tail=200 "$1"\n')
    writeFileSync(join(cur, 'logs', 'pic.bin'), Buffer.from([1, 0, 2]))
    const shown = await packs.show('shared/logs')
    assert.deepEqual([shown.name, shown.pack, shown.files.map(f => f.path)], ['logs', 'shared', ['SKILL.md', 'pic.bin', 'scripts/tail.sh']], 'SKILL.md first')
    assert.match(shown.doc, /description: two/)
    assert.equal((await packs.file('shared/logs', 'scripts/tail.sh')).text, 'kubectl logs --tail=200 "$1"\n')
    assert.deepEqual(await packs.file('shared/logs', 'pic.bin'), { path: 'pic.bin', binary: true, size: 3 })
    await assert.rejects(packs.file('shared/logs', '../../etc/passwd'), err => err.code === 'badPath')
    await assert.rejects(packs.show('shared/none'), err => err.code === 'noSkill')
  }

  // Local skills allowed (they are off by default): a workspace skill reaches its agent.
  assert.deepEqual(await call({ op: 'skillPolicy', local: true }), { local: true })
  // Startup and live imports share a single staged-agent-file consumer.
  {
    const dir = join(store.dir, 'import'), name = 'owner-fixture.agents.json'; mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), JSON.stringify({ kind: AGENTS_KIND, agents: [{ id: 'import-owner', name: 'Import owner', runtime: 'dsh', model: 'p/fast' }] }))
    const first = hub.takeImported(); assert.equal(hub.importing(), true); assert.equal(hub.takeImported(), first)
    writeFileSync(join(dir, name), JSON.stringify({ kind: AGENTS_KIND, agents: [{ id: 'import-owner', name: 'Newer staged owner', runtime: 'dsh', model: 'p/smart' }] }))
    await first; assert.equal(hub.importing(), false); assert.equal(hub.agent('import-owner').runtime, 'dsh')
    assert.ok(existsSync(join(dir, name)), 'consuming an older file does not archive the newer staged file')
    await hub.takeImported(); assert.equal(hub.agent('import-owner').name, 'Newer staged owner')
    writeFileSync(join(dir, `${name}.processing`), JSON.stringify({ kind: AGENTS_KIND, agents: [{ id: 'import-owner', name: 'Recovered after restart', runtime: 'dsh', model: 'p/fast' }] }))
    await hub.takeImported(); assert.equal(hub.agent('import-owner').name, 'Recovered after restart', 'an interrupted claimed file is retried')
    assert.ok(existsSync(join(dir, 'done', name))); await call({ op: 'deleteAgent', id: 'import-owner' }); rmSync(join(dir, 'done', name))
  }
  // A rejected Lead prompt settles its job instead of keeping maintenance busy forever.
  {
    const prompt = ctx.sessionController.prompt
    ctx.sessionController.prompt = async () => { throw Error('fixture Lead unavailable') }
    try {
      await assert.rejects(hub.startJob({ goal: 'Cannot start', cwd: ws }), /fixture Lead unavailable/)
      const failed = store.docs('job').find(j => j.goal === 'Cannot start')
      assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'leadFailed')
      assert.ok(!hub.busy().some(x => x.id === failed.id))
    } finally { ctx.sessionController.prompt = prompt }
  }
  // A chat starts a job: a fresh Lead session on the default agent's model, a brief with the pool.
  calls.length = 0
  const handed = await tool('start_agent_job', { task: 'Review a.py' }, chat)
  const jobId = handed.text.match(/Job (j\w+)/)[1]
  const lead = agents.get(job(jobId).leadId)
  assert.deepEqual([job(jobId).status, job(jobId).requester, job(jobId).cwd, job(jobId).leadAgent], ['running', { sessionId: 'chat' }, ws, 'smart'])
  assert.deepEqual(calls.find(cc => cc[0] === 'model')[1], { sessionId: lead.id, provider: 'p', model: 'smart' })
  assert.deepEqual(calls.find(cc => cc[0] === 'rename')[1], { sessionId: lead.id, title: 'Review a.py' })
  assert.match(prompts(lead.id)[0], /Lead of one job[\s\S]*## Job\nReview a.py[\s\S]*- rev \(claude · haiku · skills: lint\): reviews fast[\s\S]*`after`[\s\S]*final report/)
  assert.deepEqual([...lead.tools.keys()], ['assign_task', 'wait_tasks', 'job_status', 'cancel_task'], 'the new session swapped chat tools for Lead tools')
  assert.deepEqual(lead.restricted, [{ deny: ['spawn_teammate', 'team_task_list'] }], 'a job\'s Lead does not see dsh\'s own team tools')
  await assert.rejects(tool('assign_task', { agent: 'nope', task: 'x' }, lead), /no agent "nope"/)

  // Claude Code: read access flags, model, skill body, prompt on stdin; history stays within the job and the role.
  const ta = idOf(await tool('assign_task', { agent: 'rev', role: 'reviewer', access: 'read', task: 'Review a.py', title: 'review' }, lead))
  assert.match((await tool('wait_tasks', { ids: [ta] }, lead)).text, new RegExp(`### ${ta} · reviewer \\(rev\\) · done[\\s\\S]*review: looks good`))
  const [claudeRun] = cliRuns('claude')
  assert.equal(claudeRun.input, 'Review a.py')
  assert.ok(claudeRun.args.join(' ').includes('--permission-mode dontAsk --disallowedTools Edit,Write,NotebookEdit,Bash'))
  // Claude Code loads the agent's skills itself, from a plugin of this session only: an index in the instructions
  assert.match(claudeRun.args[claudeRun.args.indexOf('--append-system-prompt') + 1], /You are "reviewer"[\s\S]*Workspace: .*ws[\s\S]*## Your skills\n- lint \(lint\): Lint like a pro/)
  assert.doesNotMatch(claudeRun.args.join(' '), /ALWAYS RUN THE LINTER/, 'not the whole text')
  assert.deepEqual(claudeRun.pluginSkills, ['lint:true'], 'the skill is in the session\'s plugin while it runs')
  assert.ok(!existsSync(claudeRun.args[claudeRun.args.indexOf('--plugin-dir') + 1]), 'and the plugin is gone after it')
  assert.deepEqual([task(ta).status, task(ta).jobId, task(ta).agent, task(ta).cost, task(ta).tokens, task(ta).reported], ['done', jobId, 'rev', 0.002, 15, true])
  assert.deepEqual(task(ta).usage, { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 }, 'a task keeps its token split')
  assert.ok(hub.tasks(0).some(x => x.id === ta), 'the insights read every task since a time')
  await tool('wait_tasks', { ids: [idOf(await tool('assign_task', { agent: 'rev', role: 'reviewer', access: 'read', task: 'Review b.py' }, lead))] }, lead)
  assert.match(cliRuns('claude')[1].args.join(' '), /Your earlier work in this job[\s\S]*review \[done\]: review: looks good/)

  // Codex (write access, the default for a Lead's task); dsh as a spawn child of this job's Lead, one task of a role at a time.
  const tc = idOf(await tool('assign_task', { agent: 'ops', task: 'List files' }, lead))
  await tool('wait_tasks', { ids: [tc] }, lead)
  assert.ok(cliRuns('codex')[0].args.join(' ').includes(`-C ${ws}`) && cliRuns('codex')[0].args.join(' ').includes('--sandbox workspace-write'))
  assert.deepEqual([task(tc).status, task(tc).output, task(tc).member], ['done', 'ops: ran ls', 'ops'])
  assert.equal(cliRuns('codex')[0].codexHome, null, 'with local skills allowed, Codex runs in the user\'s own home')

  // A provider that refuses or limits the work: the task moves to its fallback agent once.
  const tq = idOf(await tool('assign_task', { agent: 'ops', task: 'QUOTA heavy', role: 'heavy' }, lead))
  await tool('wait_tasks', { ids: [tq] }, lead)
  assert.deepEqual([task(tq).status, task(tq).fallbackOf], ['failed', undefined], 'no fallback named, none taken')
  const tf = provided.agentHub.assign(jobId, { agent: 'ops', fallback: 'rev', role: 'heavy', access: 'read', task: 'QUOTA again' }, { by: 'workbench' })
  await hub.whenTaskDone(tf.id)
  assert.deepEqual([task(tf.id).status, task(tf.id).agent, task(tf.id).runtime, task(tf.id).access, task(tf.id).fallbackOf.agent, task(tf.id).fallbackOf.error], ['done', 'rev', 'claude', 'read', 'ops', '429: rate limit exceeded'])

  // Local skills off (as in a sandbox): an agent sees none of this machine's or the workspace's skills.
  assert.deepEqual(await call({ op: 'skillPolicy', local: false }), { local: false })
  const ti = idOf(await tool('assign_task', { agent: 'rev', role: 'reviewer', access: 'read', task: 'Review isolated.py' }, lead))
  await tool('wait_tasks', { ids: [ti] }, lead)
  const isoRun = cliRuns('claude').at(-1)
  assert.ok(isoRun.args.join(' ').includes('--setting-sources local'), 'Claude Code reads neither the user\'s nor the project\'s settings (their skills and plugins)')
  assert.ok(!isoRun.args.includes('--plugin-dir') && task(ti).missingSkills.includes('lint'), 'the local skill is not given to the agent, and the task says so')
  const to = idOf(await tool('assign_task', { agent: 'ops', task: 'List files again' }, lead))
  await tool('wait_tasks', { ids: [to] }, lead)
  assert.match(cliRuns('codex').at(-1).codexHome || '', /codex-home$/, 'Codex runs in its own home: none of the user\'s plugins or skills')
  // an assigner (the workbench) may give the agent skills for one task: the product's skills for a step
  const given = provided.agentHub.assign(jobId, { agent: 'rev', role: 'reviewer', instructions: 'Reviews against the standard.', access: 'read', task: 'Review with the standard', title: 'std' }, { by: 'workbench', skills: ['sop/review-sop'] })
  await tool('wait_tasks', { ids: [given.id] }, lead)
  assert.ok(task(given.id).skills.some(k => k.ref === 'sop/review-sop' && k.kind === 'git'), 'the given skill comes from its pack, pinned, and the task records it')
  assert.deepEqual(cliRuns('claude').at(-1).pluginSkills, ['review-sop:true'], 'Claude Code loads it for that session only')
  assert.match(cliRuns('claude').at(-1).args.join(' '), /Your role: Reviews against the standard\./, 'the step\'s role text reaches the agent')
  await call({ op: 'skillPolicy', local: true }) // the rest of the checks use the workspace skill

  // Dependencies: a task waits for the work it builds on and gets that report.
  const up = idOf(await tool('assign_task', { agent: 'rev', role: 'reviewer', access: 'read', task: 'Review c.py' }, lead))
  const downOut = await tool('assign_task', { agent: 'ops', task: 'Fix what the review found', after: [up] }, lead)
  assert.match(downOut.text, new RegExp(`waiting for ${up}`))
  const down = idOf(downOut)
  await tool('wait_tasks', { ids: [up, down] }, lead)
  assert.match(cliRuns('codex').at(-1).input, new RegExp(`Fix what the review found\n\n## Input from the tasks this one builds on\n### ${up} · reviewer \\(rev\\) · done[\\s\\S]*review: looks good`))
  assert.ok(task(down).startedAt >= task(up).endedAt, 'starts after its upstream finished')
  await assert.rejects(tool('assign_task', { agent: 'ops', task: 'x', after: ['tnope'] }, lead), /after: no task tnope in this job/)
  const td1 = idOf(await tool('assign_task', { agent: 'dev', task: 'Build it' }, lead))
  const td2 = idOf(await tool('assign_task', { agent: 'dev', task: 'Then test it' }, lead))
  await until(() => subagentStarts.length === 1, 'dsh task start')
  assert.equal(subagentStarts[0].req.parent, lead)
  assert.deepEqual(subagentStarts[0].req.agentOptions, { provider: 'p', model: 'fast' })
  assert.equal(task(td2).status, 'queued', 'second task of the role waits')
  changed({ id: 'child-1' }, 'agentActivity', { ...activityProjection.init(), phase: 'tool', said: 'compiling' })
  await until(() => task(td1).act?.said === 'compiling', 'dsh activity on the task card')
  subagentStarts[0].finish({ output: [{ type: 'text', text: 'built' }], stopReason: 'completed' })
  await until(() => subagentStarts.length === 2, 'queued task starts')
  calls.length = 0
  subagentStarts[1].finish({ output: [{ type: 'text', text: 'tested' }], stopReason: 'completed' })
  await until(() => prompts(lead.id).length === 1, 'batched report to the Lead', 5000)
  assert.match(prompts(lead.id)[0], new RegExp(`\\[task reports\\] 2 task\\(s\\) finished[\\s\\S]*${td1} · dev · done[\\s\\S]*${td2} · dev · done`))

  // The job settles when the Lead and every task are quiet: the Lead's last reply goes to the chat.
  calls.length = 0
  leadTurn(lead, 'FINAL: a.py is fine')
  await until(() => job(jobId).status === 'done', 'job settles', 6000)
  assert.equal(job(jobId).report, 'FINAL: a.py is fine')
  await until(() => prompts('chat').length === 1, 'report delivered to the chat')
  assert.match(prompts('chat')[0], new RegExp(`^\\[agent job\\] finished job ${jobId}[\\s\\S]*FINAL: a.py is fine`))
  // Talking to the Lead again reopens the job; its next answer is delivered too.
  leadTurn(lead, 'FINAL v2')
  await until(() => prompts('chat').length === 2, 'reopened job delivered again', 6000)
  assert.match(prompts('chat')[1], /FINAL v2/)

  // wait_agent_job: the waiting chat gets the report as the tool result, not as a pushed message.
  calls.length = 0
  const second = (await tool('start_agent_job', { task: 'Quick check', cwd: tmp }, chat)).text.match(/Job (j\w+)/)[1]
  const lead2 = agents.get(job(second).leadId)
  assert.equal(job(second).cwd, tmp, 'an explicit workspace wins over the chat\'s')
  const waiting = tool('wait_agent_job', { id: second }, chat)
  leadTurn(lead2, 'quick: ok')
  assert.match((await waiting).text, /quick: ok/)
  await sleep(300)
  assert.equal(prompts('chat').length, 0, 'not pushed while the chat was waiting')
  const stranger = makeAgent('stranger')
  emit('agent/created', { agent: stranger })
  await assert.rejects(tool('wait_agent_job', { id: second }, stranger), /no job/)

  // A job from the panel; work that builds on a cancelled task is cancelled too, and the Lead hears about it.
  const third = (await call({ op: 'startJob', goal: 'Long job', cwd: ws })).job
  const lead3 = agents.get(third.leadId)
  assert.equal(third.requester, null, 'a job started from the panel has no chat to report to')
  const busy = idOf(await tool('assign_task', { agent: 'ops', task: 'SLOW job' }, lead3))
  const queuedOps = idOf(await tool('assign_task', { agent: 'ops', task: 'after the slow one' }, lead3))
  await until(() => task(busy).status === 'running', 'slow codex start')
  assert.equal(task(queuedOps).status, 'queued')
  const downstream = idOf(await tool('assign_task', { agent: 'rev', role: 'reviewer', access: 'read', task: 'Check the slow job', after: [busy] }, lead3))
  // an agent in use (a workflow step names it) or with running work is not deleted
  {
    // sessions (sessions.js) through the plugin: a pool agent, a folder, a conversation; Claude Code stays as one process
    // reading its messages (stream-json) — the agent's model, its access (write by default), the session's instructions
    assert.deepEqual([...systemTools.keys()].filter(n => n.startsWith('session_')), ['session_list', 'session_start', 'session_send', 'session_read', 'session_stop', 'session_close'])
    assert.equal((await call({ op: 'sessionStart', agent: 'dev', text: 'x' })).code, 'sessionDsh', 'a dsh agent\'s conversations are dsh\'s own')
    const resident = () => readdirSync(logs).filter(f => f.startsWith('resident-claude-')).map(f => JSON.parse(readFileSync(join(logs, f), 'utf8')))
    const { session } = await call({ op: 'sessionStart', agent: 'rev', cwd: ws, text: 'look at a.py' })
    const until = async f => { for (let i = 0; i < 300 && !f(); i++) await sleep(20); assert.ok(f()) }
    await until(() => store.getDoc('session', session.id)?.turns === 1)
    const first = resident()[0]
    assert.ok(first.args.includes('--input-format') && first.args.includes('--model') && first.args[first.args.indexOf('--model') + 1] === 'haiku')
    // the agents' browser comes with it (the agent's switch on); its who is this session, its env in a 0600 file
    const servers = JSON.parse(first.args[first.args.indexOf('--mcp-config') + 1]).mcpServers
    assert.ok(servers['ruyix-browser'], 'the shared browser\'s tools')
    const envFile = servers['ruyix-browser'].args.find(x => x.endsWith('ruyix-browser.env.json'))
    assert.ok(envFile && !JSON.stringify(servers).includes(`session:${session.id}`), 'its env rides a file, not the command line')
    assert.match(first.args[first.args.indexOf('--allowedTools') + 1] || '', /mcp__ruyix-browser/)
    assert.match(first.args[first.args.indexOf('--append-system-prompt') + 1], /a session of Ruyix's agent pool/)
    assert.ok(!first.args.includes('--disallowedTools') || !first.args[first.args.indexOf('--disallowedTools') + 1].includes('Edit'), 'write access by default: it may edit')
    assert.deepEqual([store.getDoc('session', session.id).said, store.getDoc('session', session.id).cli], ['review: looks good', `claude-s${first.pid}`])
    // the main agent's tools: a second message to the same process; what it did, as text
    await systemTools.get('session_send').run({ id: session.id, message: 'and b.py?' })
    await until(() => store.getDoc('session', session.id)?.turns === 2)
    assert.deepEqual(resident().map(r => r.pid), [first.pid, first.pid], 'one process, two messages')
    assert.match((await systemTools.get('session_read').run({ id: session.id })).text, /> and b\.py\?[\s\S]*review: looks good[\s\S]*turn done/)
    assert.match((await systemTools.get('session_list').run({})).text, new RegExp(`${session.id} \\| look at a\\.py \\| agent rev \\(claude\\)`))
    wbTasks.now = 'k7' // (in a turn of the conversation: its request's task)
    const started = await systemTools.get('session_start').run({ agent: 'rev', folder: ws, message: 'by the main agent', title: '查 a.py' })
    wbTasks.now = null
    assert.deepEqual(started.undo.tool, 'session_close')
    assert.deepEqual(wbTasks.said.filter(([id]) => id === 'k7')[0], ['k7', { state: 'working', step: { zh: '交给会话：查 a.py', en: 'Handed to a session: 查 a.py' } }], 'the request at work at once')
    await until(() => wbTasks.linked.length)
    assert.deepEqual(wbTasks.linked[0], ['k7', { kind: 'session', id: store.docs('session').find(d => d.by === 'main' && d.title === '查 a.py').id }], 'the session on the request\'s task at once')
    const mine = store.docs('session').find(d => d.by === 'main')
    await until(() => store.getDoc('session', mine.id)?.turns === 1)
    assert.equal((await call({ op: 'sessions' })).sessions.length, 2)
    // an agent switched off the shared browser (a third-party pack's comes so): its sessions have no browser tools
    store.putDoc('agent', { ...store.getDoc('agent', 'rev'), browser: false })
    const off = await call({ op: 'sessionStart', agent: 'rev', cwd: ws, text: 'no browser here' })
    await until(() => store.getDoc('session', off.session.id)?.turns === 1)
    const offArgs = resident().at(-1).args
    assert.ok(!offArgs.includes('--mcp-config'), 'no browser tools')
    store.putDoc('agent', { ...store.getDoc('agent', 'rev'), browser: undefined })
    // the engine's way (the service): open for a run's step, wait for the turn; a failed one rejects with its code
    const run = await hub.openSession({ agent: 'rev', cwd: ws, instructions: 'Step 1 of run r9.', of: { run: 'r9', step: 'a' } })
    const said = await hub.askSession(run.id, 'step a', { of: { run: 'r9', step: 'a' } })
    assert.deepEqual([run.reused, said.output, hub.sessionInfo(run.id).by, hub.sessionInfo(run.id).runtime], [false, 'review: looks good', 'run', 'claude'])
    assert.match(resident().at(-1).args[resident().at(-1).args.indexOf('--append-system-prompt') + 1], /^Step 1 of run r9\./, 'the engine\'s instructions')
    await assert.rejects(hub.askSession(run.id, 'again', { signal: AbortSignal.abort() }), e => e.code === 'cancelled')
    await assert.rejects(hub.openSession({ agent: 'dev', cwd: ws }), e => e.code === 'sessionDsh')
    hub.closeSession(run.id)
    // a lane opened: the main model's two or three sentences, from the session's own record
    const sum = await call({ op: 'summarize', id: `session:${session.id}` })
    assert.equal(sum.text, '它读了 a.py，评审说没问题。')
    assert.match(llmAsked.at(-1).messages[0].content[0].text, /> look at a\.py[\s\S]*review: looks good/)
    assert.deepEqual((await call({ op: 'summarize', id: 'run:x' })).text, null, 'not this hub\'s')
    for (const d of store.docs('session')) await call({ op: 'sessionRemove', id: d.id })
    assert.equal((await call({ op: 'sessions' })).sessions.length, 0)
  }
  const offUses = hub.registerAgentUses(() => [{ agent: 'rev', by: 'Workbench', where: { en: 'bugfix · review', zh: 'bugfix · review' } }])
  assert.deepEqual(await call({ op: 'models', cwds: [ws] }).then(r => r.uses), [{ agent: 'rev', by: 'Workbench', where: { en: 'bugfix · review', zh: 'bugfix · review' } }])
  assert.equal((await call({ op: 'deleteAgent', id: 'rev' })).code, 'agentInUse')
  assert.equal((await call({ op: 'deleteAgent', id: 'ops' })).code, 'agentBusy')
  offUses()
  calls.length = 0
  await tool('cancel_task', { id: busy }, lead3)
  await until(() => task(downstream).status === 'cancelled', 'downstream cancelled with its upstream')
  assert.deepEqual([task(downstream).error, task(downstream).errorCode, task(downstream).errorParams], [`upstream ${busy} cancelled`, 'upstreamCancelled', { id: busy }])
  await until(() => prompts(lead3.id).some(p => p.includes(`${downstream} · reviewer (rev) · cancelled`)), 'the Lead hears about the cancelled downstream', 5000)

  // Stopping a job cancels the Lead and its tasks.
  const user = (await call({ op: 'assign', jobId: third.id, agent: 'dev', task: 'from the panel' })).task
  assert.equal(user.by, 'user')
  lead3.status = 'running'
  calls.length = 0
  assert.equal((await call({ op: 'stopJob', id: third.id })).job.status, 'cancelled')
  assert.ok(calls.some(cc => cc[0] === 'cancel' && cc[1].sessionId === lead3.id))
  await until(() => ['cancelled', 'done'].includes(task(queuedOps).status) && task(user.id).status === 'cancelled', 'job tasks cancelled')
  assert.ok(!prompts(lead3.id).some(p => p.startsWith('[task reports]')), 'a stopped job does not wake its Lead')
  lead3.status = 'idle'

  // Share: an agents file updates the same ids; another machine's models are warned about; an old team file's
  // members join the pool as agents unless the pool has the same.
  const { code } = await call({ op: 'exportAgents' })
  const again = await call({ op: 'importAgents', text: code })
  assert.deepEqual([again.agents.sort(), again.warnings], [['dev', 'ops', 'rev', 'smart'], []])
  const foreign = exportAgents([normalizeAgent({ id: 'x', model: 'other/model' })], null)
  assert.deepEqual((await call({ op: 'importAgents', text: JSON.stringify(foreign) })).warnings, ['x: model other/model'])
  const oldTeam = { kind: TEAM_KIND, version: 3, name: 'Old crew', members: [{ name: 'r', role: 'reviews', runtime: 'claude', model: 'haiku', access: 'read', skills: ['lint'] }, { name: 'n', role: 'new', runtime: 'claude', model: 'sonnet', effort: 'high' }] }
  const fromOld = await call({ op: 'importAgents', text: JSON.stringify(oldTeam) })
  assert.deepEqual(fromOld.agents, ['rev', 'sonnet'], 'the same agent is reused; a new one gets a readable id')
  assert.deepEqual((await call({ op: 'deleteAgent', id: 'x' })).ok, true)
  const synced = await call({ op: 'sync', since: 0 })
  assert.deepEqual(synced.docs.filter(d => d.kind === 'agent' && !d.deleted).map(d => d.id).sort(), ['dev', 'ops', 'rev', 'smart', 'sonnet'])
  assert.equal(synced.docs.find(d => d.kind === 'config').defaultAgent, 'smart')
  const info = await call({ op: 'models', cwds: [ws] })
  assert.deepEqual([info.clis.claude, info.clis.codex, info.skills.some(k => k.name === 'lint')], [true, true, true])

  // Service for other plugins: a headless job (no Lead prompt), a task with its own MCP server, explicit finish.
  systemMcpOn = true
  calls.length = 0
  const hj = await hub.startJob({ goal: 'Fix bug 42', title: 'bug 42', headless: true, agents: ['rev'] })
  assert.deepEqual([hj.headless, hj.title, prompts(hj.leadId).length], [true, 'bug 42', 0], 'a headless Lead gets no planning prompt')
  const mcp = { name: 'toolsrv', command: 'node', args: ['/x/mcp.mjs'], env: { TOOL_TOKEN: 'secret-token' } }
  const ht = hub.assign(hj.id, { agent: 'rev', role: 'reproducer', access: 'read', task: 'Reproduce it', title: 'repro' }, { by: 'workbench', mcp })
  assert.equal(ht.by, 'workbench')
  assert.ok(!JSON.stringify(store.getDoc('task', ht.id)).includes('secret-token'), 'the MCP token never reaches the store')
  const doneTask = await hub.whenTaskDone(ht.id)
  assert.equal(doneTask.status, 'done')
  const hargs = cliRuns('claude').at(-1).args
  assert.match(hargs.join(' '), /The service running this job assigns you tasks/, 'a headless job\'s tasks report to the service')
  const server = JSON.parse(hargs[hargs.indexOf('--mcp-config') + 1]).mcpServers.toolsrv
  assert.ok(!Object.hasOwn(JSON.parse(hargs[hargs.indexOf('--mcp-config') + 1]).mcpServers, 'ruyix'), 'a workflow step gets only its declared tools, never the system MCP')
  assert.ok(!(hargs[hargs.indexOf('--allowedTools') + 1] || '').split(',').includes('mcp__ruyix'))
  assert.ok(!hargs.join(' ').includes('secret-token') && server.args[0].endsWith('mcp-env.mjs') && server.args.slice(2).join(' ') === 'node /x/mcp.mjs', 'the token goes through a 0600 file, not the command line')
  assert.ok(!existsSync(server.args[1]), 'and the file is gone after the run')
  assert.ok(hargs[hargs.indexOf('--allowedTools') + 1].endsWith(',mcp__toolsrv'), 'the MCP tools are allowed under read access')
  assert.equal(cliRuns('claude').at(-1).toolTimeout, '2100000', 'Claude Code waits 35 min for a tool call (tests_run), not its default few minutes')
  await sleep(2800)
  assert.equal(store.getDoc('job', hj.id).status, 'running', 'a headless job does not settle by itself')
  systemMcpOn = false
  assert.equal(hub.finishJob(hj.id, { report: 'fixed' }).status, 'done')
  // a pi agent on a model endpoint, with the run's MCP server: its own folder for the run, gone afterwards
  {
    // (a model provider of dsh's settings, Settings → 模型: the endpoint an agent names)
    dshSettings.providers.local = { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'LOCAL_API_KEY', models: [{ id: 'qwen3' }] }
    assert.deepEqual((await call({ op: 'runtimes' })).endpoints.map(e => [e.id, e.api, e.baseUrl]), [['local', 'openai', 'http://127.0.0.1:9/v1']])
    assert.match((await call({ op: 'saveAgent', id: 'pie', runtime: 'claude', model: 'qwen3', endpoint: 'local' })).error, /cannot use local/, 'Claude Code takes Anthropic\'s protocol only')
    assert.match((await call({ op: 'saveAgent', id: 'pie', runtime: 'pi', endpoint: 'local' })).error, /pick a model/)
    assert.match((await call({ op: 'saveAgent', id: 'pie', runtime: 'pi', model: 'x', endpoint: 'nowhere' })).error, /no model endpoint "nowhere"/)
    assert.match((await call({ op: 'saveAgent', id: 'pie', runtime: 'dsh', model: 'p/fast', endpoint: 'local' })).error, /runs its own models/)
    assert.equal((await call({ op: 'saveAgent', id: 'pie', runtime: 'pi', model: 'qwen3', endpoint: 'local' })).agent.endpoint, 'local')
    const pj = await hub.startJob({ goal: 'On an endpoint', title: 'pi', headless: true, agents: ['pie'] })
    const pt = hub.assign(pj.id, { agent: 'pie', role: 'worker', access: 'write', task: 'Do it', title: 'pi task' }, { by: 'workbench', mcp })
    assert.equal((await hub.whenTaskDone(pt.id)).status, 'done')
    const r = cliRuns('pi').at(-1)
    assert.deepEqual(r.args.slice(r.args.indexOf('--model'), r.args.indexOf('--model') + 2), ['--model', 'ruyix/qwen3'])
    assert.deepEqual(r.pi.models.providers.ruyix, { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: '$RUYIX_ENDPOINT_KEY', models: [{ id: 'qwen3' }] })
    assert.equal(r.endpointKey, 'none', 'no key set: a placeholder the server ignores')
    const srv = r.pi.mcp.mcpServers.toolsrv
    assert.ok(srv.exposure === 'direct' && srv.args[0].endsWith('mcp-env.mjs') && !JSON.stringify(r.pi.mcp).includes('secret-token'), 'the token through its 0600 file here too')
    assert.ok(!existsSync(r.pi.dir), 'pi\'s folder for the run is gone afterwards')
    assert.equal(store.getDoc('task', pt.id).output, 'pi: done')
    assert.deepEqual((await call({ op: 'runtimes' })).usedBy, { local: ['pie'] })
    assert.match((await call({ op: 'endpointSave', endpoint: {} })).error, /unknown op/, 'kept in Settings → 模型 now, not here')
    hub.finishJob(pj.id, { report: 'ok' })
  }
  {
    const dir = mkdtempSync(join(tmp, 'mcp-')), wrapped = mcpViaEnvFile(mcp, dir)
    const argv = cliCommand('codex', { access: 'full', instructions: 'I', task: 'T', cwd: '/w', mcp: wrapped }).args.join(' ')
    assert.ok(!argv.includes('secret-token') && argv.includes('mcp-env.mjs'), 'codex too: no token in argv')
    // under a sandbox an isolated Codex would refuse the server's calls (they "need approval", it never asks): approved
    assert.ok(cliCommand('codex', { access: 'read', instructions: 'I', task: 'T', cwd: '/w', mcp: wrapped }).args.includes(`mcp_servers.${wrapped.name}.default_tools_approval_mode="approve"`))
    assert.ok(argv.includes('mcp_servers.toolsrv.tool_timeout_sec=2100'), 'a long tool call (tests) is not cut off by Codex\'s 60 s default')
    if (!WIN) assert.equal(statSync(wrapped.args[1]).mode & 0o777, 0o600) // Windows has no such bits
    assert.equal(JSON.parse(readFileSync(wrapped.args[1], 'utf8')).TOOL_TOKEN, 'secret-token')
  }

  // A Host restart cannot finish runs or Lead turns.
  store.putDoc('task', { id: 'tz', jobId: 'jz', agent: 'rev', member: 'rev', title: 'z', task: 'z', by: 'lead', status: 'running', createdAt: Date.now() })
  store.putDoc('job', { id: 'jz', leadId: 'gone', headless: true, goal: 'z', title: 'z', status: 'running', createdAt: Date.now() })
  store.putDoc('task', { id: 'tqueued', jobId: 'jz', agent: 'rev', member: 'rev', status: 'queued' })
  effects.forEach(dispose => typeof dispose === 'function' && dispose())
  const reopened = openStore(file)
  apply({ ...ctx, effect: fn => fn() }, {}, reopened)
  assert.deepEqual([reopened.getDoc('task', 'tz').status, reopened.getDoc('task', 'tz').error], ['failed', 'interrupted: dsh restarted during this run'])
  assert.match(reopened.getDoc('job', 'jz').error, /^interrupted: dsh restarted during this job/)
  assert.equal(reopened.getDoc('task', 'tqueued').status, 'failed', 'abandoned queued tasks cannot keep maintenance permanently busy')
  assert.ok(!provided.agentHub.busy().some(t => t.id === 'tqueued'))
  {
    // a configuration's agents (ruyix config import): taken in at start — the same id updated in place, an older
    // configuration's team file joining the pool
    const dir = join(reopened.dir, 'import'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.agents.json'), JSON.stringify(exportAgents([{ ...reopened.getDoc('agent', 'rev'), notes: 'from a config' }], null)))
    writeFileSync(join(dir, 'b.team.json'), JSON.stringify({ ...oldTeam, members: [{ name: 'q', role: 'r', runtime: 'claude', model: 'opus', effort: 'max' }] }))
    apply({ ...ctx, effect: fn => fn() }, {}, reopened)
    for (let i = 0; i < 100 && readdirSync(dir).some(f => f.endsWith('.json')); i++) await new Promise(r => setTimeout(r, 20))
    assert.equal(reopened.getDoc('agent', 'rev').notes, 'from a config', 'same id: updated in place')
    assert.ok(reopened.docs('agent').some(a => a.runtime === 'claude' && a.model === 'opus' && a.effort === 'max'), 'an old team\'s member joins the pool')
    assert.deepEqual(readdirSync(join(dir, 'done')).sort(), ['a.agents.json', 'b.team.json'])
  }
  reopened.close()
  {
    // an older profile: its teams' members (and fallbacks) join the pool once, the Lead model becomes the default agent
    const old = openStore(join(tmp, 'old.db'))
    old.putDoc('team', { id: 'team-1', name: 'bugfix-crew', leadModel: 'p/smart', members: [
      { name: 'triager', role: 'r', runtime: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', access: 'full', fallback: { runtime: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', access: 'read' } },
      { name: 'fixer', role: 'r', runtime: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', access: 'write', fallback: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', access: 'full' } },
      { name: 'env', role: 'r', runtime: 'dsh', model: 'p/atlas', access: 'read' },
    ] })
    const got = {}
    apply({ ...ctx, effect: fn => fn(), provide: (n, v) => { got[n] = v } }, {}, old)
    assert.deepEqual(got.agentHub.agents().map(a => [a.id, a.runtime, a.access]).sort(), [['atlas', 'dsh', null], ['codex', 'codex', 'full'], ['opus', 'claude', null], ['smart', 'dsh', null]])
    assert.equal(got.agentHub.defaultAgent().model, 'p/smart')
    assert.equal(got.agentHub.legacyTeam('Bugfix-Crew').id, 'team-1', 'the old team stays readable for its settings\' move')
    assert.equal(got.agentHub.agent('opus').name, 'opus', 'named after what runs, not after the member it came from')
    got.agentHub.ensureAgents([{ id: 'opus', name: 'Claude Opus', runtime: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', notes: 'long loops' }])
    assert.deepEqual([got.agentHub.agent('opus').name, got.agentHub.agent('opus').notes], ['Claude Opus', 'long loops'], 'a plugin\'s seed names the same agent that came from a team')
    apply({ ...ctx, effect: fn => fn(), provide: () => {} }, {}, old)
    assert.equal(old.docs('agent').length, 4, 'once: a second start adds nothing (the Lead model\'s agent included)')
    old.close()
  }
  {
    // a home from before the one list: Agent Hub's own model endpoints move into dsh's providers once (ids and key names
    // kept); one whose id a provider at another address has is renamed, and its agent and waiting task follow
    const old = openStore(join(tmp, 'eps.db'))
    old.putDoc('config', { id: 'hub', endpoints: [
      { id: 'ds', name: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4'], keyTail: '1234' },
      { id: 'gw', name: 'Gateway', api: 'anthropic', baseUrl: 'https://gw.example', models: ['m'] },
    ] })
    old.putDoc('agent', { ...normalizeAgent({ id: 'pg', runtime: 'pi', model: 'm', endpoint: 'gw' }), createdAt: 1 })
    old.putDoc('task', { id: 'tw', jobId: 'jw', agent: 'pg', endpoint: 'gw', title: 'w', task: 'w', by: 'lead', status: 'queued', createdAt: Date.now() })
    old.putDoc('task', { id: 'tf', jobId: 'jw', agent: 'pg', endpoint: 'gw', title: 'f', task: 'f', by: 'lead', status: 'failed', createdAt: Date.now() })
    old.putDoc('config', { ...old.getDoc('config', 'hub'), endpoints: [...old.getDoc('config', 'hub').endpoints, { id: 'lan', name: 'LAN', api: 'openai', baseUrl: 'http://192.168.1.9:8000/v1', models: [] }] })
    const mine = { providers: { gw: { api: 'openai-completions', baseURL: 'https://elsewhere.example/v1', apiKeyEnv: 'GW_API_KEY', models: [] }, lan: { api: 'openai-completions', baseURL: 'http://192.168.1.9:8000/v1', apiKeyEnv: 'LAN_API_KEY', models: [] } } }
    const credStore = new Map([['RUYIX_ENDPOINT_LAN', 'lan-key']]) // (the endpoint's key; the provider's own LAN_API_KEY was never set)
    const credentials = { resolve: async k => (credStore.has(k) ? { value: credStore.get(k) } : undefined) }
    const setAt = (obj, [k, ...rest], v) => { if (!rest.length) obj[k] = v; else setAt(obj[k] ||= {}, rest, v) }
    const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: mine.providers } }], mutate: async (ns, ops) => { assert.equal(ns, 'llm-pi-ai'); for (const o of ops) setAt(mine, o.path, o.value) } }
    const inject = (names, fn) => { if (names.length === 1 && names[0] === 'settings') fn({ settings, effect: g => g() }); if (names.length === 1 && names[0] === 'credentials') fn({ credentials, effect: g => g() }) }
    apply({ ...ctx, inject, effect: fn => fn(), provide: () => {} }, {}, old)
    for (let i = 0; i < 100 && !old.getDoc('config', 'hub').endpointsMoved; i++) await sleep(10)
    assert.deepEqual(Object.keys(mine.providers).sort(), ['ds', 'gw', 'gw-ep', 'lan'])
    assert.equal(mine.providers.lan.apiKeyEnv, 'RUYIX_ENDPOINT_LAN', 'the same place without a key of its own: it takes the endpoint\'s')
    assert.deepEqual(mine.providers.ds, { apiKeyEnv: 'RUYIX_ENDPOINT_DS', api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-v4' }], displayName: 'DeepSeek' })
    assert.equal(old.getDoc('agent', 'pg').endpoint, 'gw-ep'); assert.equal(old.getDoc('task', 'tw').endpoint, 'gw-ep')
    assert.equal(old.getDoc('task', 'tf').endpoint, 'gw-ep', 'a failed task too (it may come back queued)')
    assert.deepEqual(old.getDoc('config', 'hub').endpoints, [], 'kept by dsh now')
    assert.equal(old.getDoc('config', 'hub').endpointsBefore.length, 3, 'what was there, kept aside')
    apply({ ...ctx, inject, effect: fn => fn(), provide: () => {} }, {}, old)
    await sleep(30)
    assert.equal(Object.keys(mine.providers).length, 4, 'once')
    old.close()
  }
  {
    // an endpoint that came with every model its address listed (the old form kept them all): only the ones in use stay —
    // an agent's here, one dsh's settings name "<provider>/<model>"; the rest are ticked again in Settings → 模型. Once.
    const old = openStore(join(tmp, 'eps-trim.db'))
    const many = Array.from({ length: 40 }, (_, i) => `maker/m${i}`)
    old.putDoc('config', { id: 'hub', endpointsMoved: true, endpoints: [], endpointsBefore: [{ id: 'or', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: many }, { id: 'few', api: 'openai', baseUrl: 'https://few.example/v1', models: ['a', 'b'] }] })
    old.putDoc('agent', { ...normalizeAgent({ id: 'po', runtime: 'pi', model: 'maker/m3', endpoint: 'or' }), createdAt: 1 })
    old.putDoc('agent', { ...normalizeAgent({ id: 'dd', runtime: 'dsh', model: 'or/maker/m7' }), createdAt: 2 }) // (a dsh agent: "<provider>/<model>")
    const mine = { providers: {
      or: { api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'RUYIX_ENDPOINT_OR', models: many.map(id => ({ id })) },
      few: { api: 'openai-completions', baseURL: 'https://few.example/v1', apiKeyEnv: 'RUYIX_ENDPOINT_FEW', models: [{ id: 'a' }, { id: 'b' }] },
    } }
    const setAt = (obj, [k, ...rest], v) => { if (!rest.length) obj[k] = v; else setAt(obj[k] ||= {}, rest, v) }
    const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: mine.providers, defaultModel: 'or/maker/m5' } }], mutate: async (ns, ops) => { for (const o of ops) setAt(mine, o.path, o.value) } }
    const inject = (names, fn) => { if (names[0] === 'settings') fn({ settings, effect: g => g() }); if (names[0] === 'credentials') fn({ credentials: { resolve: async () => undefined }, effect: g => g() }) }
    apply({ ...ctx, inject, effect: fn => fn(), provide: () => {} }, {}, old)
    for (let i = 0; i < 100 && !old.getDoc('config', 'hub').endpointsTrimmed; i++) await sleep(10)
    assert.deepEqual(mine.providers.or.models.map(m => m.id), ['maker/m3', 'maker/m5', 'maker/m7'], 'the agents\' (on the endpoint, and a dsh one), and the one dsh names')
    assert.deepEqual(mine.providers.few.models.map(m => m.id), ['a', 'b'], 'a few: picked by hand, kept')
    mine.providers.or.models = many.map(id => ({ id })) // (ticked again, all of them: a second start leaves them)
    apply({ ...ctx, inject, effect: fn => fn(), provide: () => {} }, {}, old)
    await sleep(30)
    assert.equal(mine.providers.or.models.length, 40, 'once')
    old.close()
  }
  { const { en, zh } = await import('./src/locale.js'); assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'en and zh dictionaries carry the same keys') }
  {
    // several MCP servers at once (a run's tools and the agents' browser), on each CLI's way
    const two = [{ name: 'ruyix-workbench', command: 'node', args: ['wb.mjs'] }, { name: 'ruyix-browser', command: 'node', args: ['b.mjs'] }]
    const c = cliCommand('claude', { access: 'write', instructions: 'I', task: 'T', cwd: '/x', mcp: two })
    assert.deepEqual(Object.keys(JSON.parse(c.args[c.args.indexOf('--mcp-config') + 1]).mcpServers), ['ruyix-workbench', 'ruyix-browser'])
    assert.match(c.args[c.args.indexOf('--allowedTools') + 1], /mcp__ruyix-workbench,mcp__ruyix-browser$/)
    const x = cliCommand('codex', { access: 'write', instructions: 'I', task: 'T', cwd: '/x', mcp: two })
    assert.ok(x.args.includes('mcp_servers.ruyix-browser.command="node"') && x.args.includes('mcp_servers.ruyix-workbench.command="node"'))
    const pd = join(tmp, 'pi-two'); piHomeIn(pd, { mcp: two })
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(pd, 'mcp.json'), 'utf8')).mcpServers), ['ruyix-workbench', 'ruyix-browser'])
    assert.equal(normalizeAgent({ id: 'p', runtime: 'pi', browser: false }).browser, false)
    assert.equal('browser' in normalizeAgent({ id: 'p', runtime: 'pi', browser: true }), false, 'on is the default: not stored')
  }
  {
    // the work going on, for the desks (src/work.js): a session's turns are its ring, a job's tasks too; a run's job is the run's
    const { jobItems, sessionItems } = await import('./src/work.js')
    const ses = new Map([
      ['s1', { id: 's1', title: 'A', agent: 'rev', runtime: 'claude', state: 'working', turns: 2, seenTurns: 2, now: { tool: 'Read' }, createdAt: 1, lastAt: 5 }],
      ['s2', { id: 's2', title: 'B', agent: 'rev', runtime: 'claude', state: 'idle', turns: 3, seenTurns: 2, error: 'boom', createdAt: 1, lastAt: 6 }],
      ['s3', { id: 's3', title: 'C', agent: 'rev', runtime: 'pi', state: 'idle', turns: 0, createdAt: 1 }],
      ['s4', { id: 's4', title: 'D', agent: 'rev', runtime: 'pi', state: 'idle', turns: 1, removedAt: 9 }],
    ])
    const items = sessionItems(ses)
    assert.deepEqual(items.map(w => [w.id, w.state, w.seen, w.segs.map(x => x.st).join(','), w.cur]), [['session:s1', 'working', true, 'done,done,run', 2], ['session:s2', 'failed', false, 'done,done,fail', null]])
    assert.deepEqual([items[0].agents, items[0].open], [[{ id: 'rev', kind: 'claude', state: 'working', step: 'Read' }], { event: 'agent-hub:open', detail: { tab: 'sessions', session: 's1' } }])
    // lines by rule (worded by the page), the outcome when not at work (agent-work.md §2–3)
    ses.set('s5', { id: 's5', title: 'E', agent: 'rev', runtime: 'claude', state: 'idle', turns: 1, said: '改好了。还有两处要你看', lines: [{ at: 1, kind: 'tool', tool: 'Edit', arg: 'draft.md' }, { at: 2, kind: 'say', said: '改好了。' }], createdAt: 1, lastAt: 7 })
    const e = sessionItems(ses, 'zh').find(w => w.id === 'session:s5')
    assert.deepEqual(e.lines, [{ at: 1, agent: 'rev', text: '改了 draft.md', kind: 'tool' }, { at: 2, agent: 'rev', text: '改好了。', kind: 'say' }], 'in the words every lane uses')
    assert.deepEqual([e.outcome.ok, e.outcome.text], [true, '改好了。'])
    assert.deepEqual(e.outcome.open, { event: 'ruyix-workbench:view', detail: { session: 's5', title: 'E' } }, '「看结果」: its files, in the viewer a run\'s open in')
    assert.equal(sessionItems(ses).find(w => w.id === 'session:s1').outcome, undefined, 'at work: no outcome yet')
    // who wrote to it and whom it answered (agent-work.md §6): 'self' is its agent; the other ends named, as peers
    ses.set('s5', { ...ses.get('s5'), links: [{ from: 'main', to: 'self', at: 1, text: '查一下' }, { from: 'self', to: 'main', at: 2, text: '查好了。' }, { from: 'person', to: 'self', at: 3, text: '再看看' }] })
    const g = sessionItems(ses, 'zh').find(w => w.id === 'session:s5')
    assert.deepEqual(g.links.map(k => `${k.from}>${k.to}`), ['main>rev', 'rev>main', 'person>rev'])
    assert.deepEqual(g.peers, [{ id: 'main', kind: 'system', name: '主智能体' }, { id: 'person', kind: 'person', name: '你' }])
    assert.deepEqual(sessionItems(ses).find(w => w.id === 'session:s1').peers, [], 'no one has written to it yet')
    ses.delete('s5')
    const jobs = new Map([['j1', { id: 'j1', title: 'Fix', status: 'running', createdAt: 1 }], ['j2', { id: 'j2', title: 'Run', status: 'running', headless: true, createdAt: 1 }], ['j3', { id: 'j3', title: 'Old', status: 'done', endedAt: 1, createdAt: 0 }]])
    const tasks = new Map([['t1', { id: 't1', jobId: 'j1', title: 'plan', status: 'done', createdAt: 1 }], ['t2', { id: 't2', jobId: 'j1', title: 'code', status: 'running', agent: 'ops', runtime: 'codex', createdAt: 2 }]])
    assert.deepEqual(jobItems(jobs, tasks, 10 * 3600e3).map(w => [w.id, w.state, w.segs.map(x => `${x.title}:${x.st}`).join(','), w.cur, w.agents.map(a => `${a.id}:${a.kind}`).join()]), [['task:j1', 'working', 'plan:done,code:run', 1, 'ops:codex']])
    // a job's lines from its tasks' activity; done and not looked at until jobSeen
    tasks.set('t2', { ...tasks.get('t2'), act: { recent: [{ name: 'bash', target: 'npm test', at: 5 }], said: '测试都过了。接下来提交', saidAt: 6 }, updatedAt: 9 })
    jobs.set('j4', { id: 'j4', title: 'Done', status: 'done', report: '修好了。细节见报告', endedAt: 10 * 3600e3 - 1000, createdAt: 1 })
    const ji = jobItems(jobs, tasks, 10 * 3600e3, 'zh')
    assert.deepEqual(ji.find(w => w.id === 'task:j1').lines.map(l => `${l.agent}:${l.kind}:${l.text}`), ['ops:tool:跑了 npm test', 'ops:say:测试都过了。'])
    assert.deepEqual([ji.find(w => w.id === 'task:j4').seen, ji.find(w => w.id === 'task:j4').outcome.text], [false, '修好了。'])
    // its hand-offs: the lead gives a task to its agent, the agent reports back when it is over
    tasks.set('t3', { id: 't3', jobId: 'j1', title: 'review', status: 'done', agent: 'rev', runtime: 'claude', by: 'lead', output: '没问题。可以合', createdAt: 3, endedAt: 8 })
    const hj = jobItems(jobs, tasks, 10 * 3600e3, 'zh').find(w => w.id === 'task:j1')
    assert.deepEqual(hj.links.map(k => `${k.from}>${k.to}:${k.text}`), ['person>ops:code', 'lead>rev:review', 'rev>lead:没问题。'])
    assert.deepEqual(hj.peers.map(p => `${p.id}:${p.kind}:${p.name}`), ['person:person:你', 'lead:dsh:组长'])
    tasks.delete('t3')
    jobs.set('j4', { ...jobs.get('j4'), seenAt: 5 })
    assert.equal(jobItems(jobs, tasks, 10 * 3600e3).find(w => w.id === 'task:j4').seen, true, 'looked at')
  }
  {
    // CLI sessions: their ids are captured, and a resume continues them
    const { parseLine, cliCommand: cmd } = await import('./runtimes.js')
    assert.equal(parseLine('claude', JSON.stringify({ type: 'system', subtype: 'init', model: 'm', session_id: 's-1' }), {}).sessionId, 's-1')
    assert.equal(parseLine('codex', JSON.stringify({ type: 'thread.started', thread_id: 't-1' }), {}).sessionId, 't-1')
    assert.equal(parseLine('codex', JSON.stringify({ type: 'turn.started' }), {}).sessionId, undefined)
    const c = cmd('claude', { access: 'full', instructions: 'I', task: 'go on', cwd: '/x', resume: 's-1' })
    assert.deepEqual([c.args.slice(c.args.indexOf('--resume'), c.args.indexOf('--resume') + 2), c.input], [['--resume', 's-1'], 'go on'])
    const x = cmd('codex', { access: 'full', instructions: 'I', task: 'go on', cwd: '/x', resume: 't-1' })
    assert.deepEqual([x.args.slice(-3), x.input], [['resume', 't-1', '-'], 'go on'], 'codex: exec … resume <id> -, the nudge only')
    assert.match(cmd('codex', { access: 'full', instructions: 'I', task: 'T', cwd: '/x' }).input, /^I\n\n## Your task\nT$/)
  }
  {
    // what triggers a fallback
    const { FALLBACK_ON } = await import('./runtimes.js')
    assert.ok(FALLBACK_ON.test("This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request."))
    assert.ok(FALLBACK_ON.test('429: rate limit exceeded') && FALLBACK_ON.test('Error: model not found: gpt-x'))
    assert.ok(!FALLBACK_ON.test('codex exited with code 1') && !FALLBACK_ON.test('the check script failed'))
  }
  {
    const { shownModel } = await import('./src/model.js')
    const def = { runtime: 'codex', model: 'gpt-6.1-sol' }
    assert.equal(shownModel(def, null, { runtime: 'claude', model: 'claude-opus-5-5[1m]' }), 'gpt-6.1-sol', 'after a runtime switch the card shows the configured model, not the old one')
    assert.equal(shownModel({ runtime: 'claude' }, null, { runtime: 'claude', model: 'claude-opus-5-5[1m]' }), 'claude-opus-5-5[1m]')
    assert.equal(shownModel({ runtime: 'codex' }, null, { runtime: 'claude', model: 'opus' }), '')
  }

// ── pi: its JSON events become the panel's; read access is its read-only tools; no MCP server ──
{
  const st = {}, x = line => parseLine('pi', JSON.stringify(line), st)
  assert.equal(x({ type: 'session', version: 3, id: 'pi-s1' }).sessionId, 'pi-s1')
  assert.equal(x({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }).events[0].type, 'tool/call')
  assert.equal(x({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: {}, isError: true }).events[0].data.message.isError, true)
  const end = x({ type: 'message_end', message: { role: 'assistant', model: 'ultra', content: [{ type: 'text', text: 'Done.' }], usage: { totalTokens: 120, cost: { total: 0.01 } } } })
  assert.deepEqual([end.model, end.tokens, end.cost, end.events[0].type], ['ultra', 120, 0.01, 'assistant/message'])
  assert.deepEqual(x({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 5, output: 2, cacheRead: 1 } } }).usage, { input_tokens: 5, output_tokens: 2, cache_read_tokens: 1, cache_write_tokens: 0 })
  assert.equal(x({ type: 'agent_end', messages: [] }).output, 'Done.')
  assert.equal(x({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'no key' } }).error, 'no key')
  const cmd = cliCommand('pi', { model: 'p/ultra', effort: 'high', access: 'read', instructions: 'I', task: 'T', isolated: true })
  assert.deepEqual(cmd.args, ['-p', '--mode', 'json', '--model', 'p/ultra', '--thinking', 'high', '--tools', 'read,grep,find,ls', '--no-skills', '--no-extensions', '--no-approve', '--append-system-prompt', 'I'])
  assert.equal(cmd.input, 'T')
  assert.ok(cliCommand('pi', { access: 'full', instructions: 'I', task: 'T', resume: 'pi-s1' }).args.join(' ').includes('--session pi-s1'))
  // pi takes the run's MCP server (its folder's mcp.json, piHomeIn); without extensions the built-in mcp one is named back
  const withMcp = cliCommand('pi', { access: 'write', instructions: 'I', task: 'T', isolated: true, mcp: { name: 'toolsrv', command: 'x' } }).args
  assert.deepEqual(withMcp.slice(withMcp.indexOf('--no-skills'), withMcp.indexOf('--append-system-prompt')), ['--no-skills', '--no-extensions', '--no-approve', '-e', 'builtin:mcp'])
  assert.equal(withMcp[withMcp.indexOf('--tools') + 1], 'read,grep,find,ls,edit,write,bash,mcp__toolsrv__*', 'an allowlist of tools names the server\'s, else pi drops them')
  assert.equal(cliCommand('pi', { access: 'read', instructions: 'I', task: 'T', mcp: { name: 'ruyix-workbench', command: 'x' } }).args.join(' ').match(/--tools (\S+)/)[1], 'read,grep,find,ls,mcp__ruyix_workbench__*', '(its tools are named with _ for -)')
  assert.ok(!cliCommand('pi', { access: 'full', instructions: 'I', task: 'T', mcp: { name: 'toolsrv', command: 'x' } }).args.includes('--tools'), 'full access: no allowlist, every tool')
  assert.ok(!cliCommand('pi', { access: 'write', instructions: 'I', task: 'T', mcp: { name: 'toolsrv', command: 'x' } }).args.includes('builtin:mcp'), 'not isolated: its extensions load as they are')
  // an endpoint's model in place of the agent's own, for each runtime
  const ep = { args: ['--model', 'ruyix/qwen3'] }
  assert.deepEqual(cliCommand('pi', { model: 'p/ultra', access: 'read', instructions: 'I', task: 'T', endpoint: ep }).args.filter(a => /ultra|qwen3/.test(a)), ['ruyix/qwen3'])
  assert.ok(!cliCommand('claude', { model: 'opus', access: 'read', instructions: 'I', task: 'T', endpoint: { args: ['--model', 'm1'] } }).args.includes('opus'))
  assert.ok(cliCommand('codex', { model: 'gpt', access: 'read', instructions: 'I', task: 'T', cwd: '/w', endpoint: { args: ['-m', 'm1'] } }).args.join(' ').includes('-m m1'))
  {
    const own = mkdtempSync(join(tmpdir(), 'pi-own-')), was = process.env.PI_CODING_AGENT_DIR, wasS = process.env.PI_CODING_AGENT_SESSION_DIR
    for (const f of ['auth.json', 'models.json', 'settings.json']) writeFileSync(join(own, f), '{}')
    process.env.PI_CODING_AGENT_DIR = own; delete process.env.PI_CODING_AGENT_SESSION_DIR
    try {
      const dir = join(mkdtempSync(join(tmpdir(), 'pi-run-')), 'pi')
      assert.deepEqual(piHomeIn(dir, { mcp: { name: 'toolsrv', command: 'node', args: ['s.mjs'], env: { A: '1' } }, isolated: true }), { PI_CODING_AGENT_DIR: dir, PI_CODING_AGENT_SESSION_DIR: join(own, 'sessions') }, 'its sessions stay where the person\'s are')
      if (!WIN) assert.deepEqual(['auth.json', 'models.json'].map(f => readlinkSync(join(dir, f))), [join(own, 'auth.json'), join(own, 'models.json')], 'their sign-ins and models linked in')
      assert.ok(!existsSync(join(dir, 'settings.json')), 'isolated: none of their settings (their extensions)')
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).mcpServers.toolsrv, { command: 'node', args: ['s.mjs'], env: { A: '1' }, exposure: 'direct', timeout: 2100 }, 'declared to the model directly, a long call not cut off')
      if (!WIN) assert.equal(statSync(join(dir, 'mcp.json')).mode & 0o777, 0o600)
      const dir2 = join(mkdtempSync(join(tmpdir(), 'pi-run-')), 'pi')
      piHomeIn(dir2, { models: { providers: { ruyix: { api: 'openai-completions' } } } })
      assert.ok(statSync(join(dir2, 'models.json')).isFile() && JSON.parse(readFileSync(join(dir2, 'models.json'), 'utf8')).providers.ruyix, 'an endpoint\'s models in place of theirs')
      if (!WIN) assert.ok(existsSync(join(dir2, 'settings.json')), 'not isolated: their settings too')
    } finally { if (was === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = was; if (wasS !== undefined) process.env.PI_CODING_AGENT_SESSION_DIR = wasS }
  }
}

// ── the CLI runtimes as packages of this home: install, pin, a failure keeps the old one, another's install left alone ──
{
  const home = mkdtempSync(join(tmpdir(), 'agent-hub-inst-'))
  let published = '2.0.0', failNext = false, hold = false, releaseInstall
  const run = async (cmd, args) => {
    if (cmd === 'npm' && args[0] === 'view') return { stdout: `${published}\n` }
    if (cmd === 'npm' && args[0] === 'install') {
      if (hold) { hold = false; await new Promise(r => { releaseInstall = r }) }
      if (failNext) { failNext = false; throw Object.assign(new Error('npm failed'), { stderr: 'npm ERR! 404 Not Found' }) }
      const prefix = args[2], [pkg, v] = args[3].split(/@(?=[^@]*$)/), ver = v === 'latest' ? published : v
      mkdirSync(join(prefix, 'node_modules', pkg), { recursive: true }); mkdirSync(join(prefix, 'node_modules', '.bin'), { recursive: true })
      writeFileSync(join(prefix, 'node_modules', pkg, 'package.json'), JSON.stringify({ version: ver }))
      writeFileSync(join(prefix, 'node_modules', '.bin', { '@anthropic-ai/claude-code': 'claude', '@openai/codex': 'codex' }[pkg] || 'pi'), '#!/bin/sh\n'); return { stdout: '' }
    }
    if (args[0] === '--version') return { stdout: 'claude 9.9.9 (native)\n' }
    throw new Error(`unexpected ${cmd} ${args}`)
  }
  const which = bin => (existsSync(join(home, '.local/bin', bin)) ? join(home, '.local/bin', bin) : null)
  // the Unix way on every machine (a symlink in ~/.local/bin); Windows' .cmd is checked below
  const inst = createInstaller({ home, run, which, npm: 'npm', win: false })
  assert.deepEqual(await inst.status('pi'), { runtime: 'pi', name: 'pi', package: '@earendil-works/pi-coding-agent', managed: null, version: null, path: null })
  assert.equal((await inst.install('pi')).version, '2.0.0', 'the latest')
  assert.equal((await inst.status('pi')).managed, 'ruyix')
  assert.equal(readlinkSync(join(home, '.local/bin/pi')), join(inst.root, 'pi/node_modules/.bin/pi'))
  assert.equal((await inst.install('pi', { version: '1.5.0' })).version, '1.5.0', 'pinned (also a rollback)')
  hold = true; const updating = inst.install('pi', { version: '1.6.0' })
  try {
    assert.equal(typeof releaseInstall, 'function')
    await assert.rejects(inst.remove('pi'), e => e.code === 'runtimeInstalling', 'removal cannot be reported done during an update')
    await assert.rejects(inst.install('pi'), e => e.code === 'runtimeInstalling', 'direct installer callers share the same owner')
  } finally { releaseInstall(); await updating }
  await inst.install('pi', { version: '1.5.0' })
  failNext = true
  await assert.rejects(inst.install('pi', { version: '9.0.0' }), e => e.code === 'installFailed' && /404/.test(e.params.detail))
  assert.equal((await inst.status('pi')).version, '1.5.0', 'a failed install leaves what was there')
  assert.equal((await inst.install('pi', { version: '1.5.0' })).version, '1.5.0', 'a failed install releases its owner')
  await assert.rejects(inst.install('pi', { version: 'latest; rm -rf /' }), e => e.code === 'badVersion')
  // a command installed by something else: left alone unless replaced
  mkdirSync(join(home, '.local/share/claude'), { recursive: true }); writeFileSync(join(home, '.local/share/claude/claude'), '#!/bin/sh\n')
  symlinkSync(join(home, '.local/share/claude/claude'), join(home, '.local/bin/claude'))
  assert.deepEqual([(await inst.status('claude')).managed, (await inst.status('claude')).version], ['elsewhere', '9.9.9'])
  await assert.rejects(inst.install('claude'), e => e.code === 'installedElsewhere')
  await assert.rejects(inst.remove('claude'), e => e.code === 'notManaged')
  assert.equal((await inst.install('claude', { replace: true })).managed, 'ruyix')
  const removing = inst.remove('pi')
  await assert.rejects(inst.install('pi'), e => e.code === 'runtimeInstalling', 'installation cannot overtake a pending removal')
  assert.equal((await removing).managed, null)
  assert.ok(!existsSync(join(inst.root, 'pi')))
  assert.equal(await inst.latest('pi'), '2.0.0'); published = '2.1.0'
  assert.equal(await inst.latest('pi'), '2.0.0', 'cached for hours'); assert.equal(await inst.latest('pi', { fresh: true }), '2.1.0')
  assert.ok(newer('2.1.0', '2.0.9') && newer('1.0.0', '1.0.0-beta.2') && !newer('1.0.0-beta.2', '1.0.0') && newer('0.10.0', '0.9.9') && !newer('1.0.0', '1.0.0'))
  await assert.rejects(inst.install('nope'), e => e.code === 'badRuntime')
  rmSync(home, { recursive: true, force: true })
}
{
  // Windows: the command is a .cmd that calls npm's (a symlink would need administrator rights)
  const home = mkdtempSync(join(tmpdir(), 'agent-hub-inst-win-'))
  const pkg = '@earendil-works/pi-coding-agent'
  const run = async (cmd, args) => {
    assert.equal(cmd, 'npm.cmd')
    if (args[0] === 'view') return { stdout: '1.0.0\n' }
    const prefix = args[2]
    mkdirSync(join(prefix, 'node_modules', pkg), { recursive: true }); mkdirSync(join(prefix, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(prefix, 'node_modules', pkg, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    writeFileSync(join(prefix, 'node_modules', '.bin', 'pi.cmd'), '@echo pi\r\n')
    return { stdout: '' }
  }
  const which = b => (existsSync(join(home, '.local/bin', `${b}.cmd`)) ? join(home, '.local/bin', `${b}.cmd`) : null)
  const inst = createInstaller({ home, run, which, npm: 'npm.cmd', win: true })
  assert.equal((await inst.install('pi')).managed, 'ruyix')
  assert.equal(readFileSync(join(home, '.local/bin/pi.cmd'), 'utf8'), `@"${join(inst.root, 'pi', 'node_modules', '.bin', 'pi.cmd')}" %*\r\n`)
  assert.equal((await inst.remove('pi')).managed, null)
  assert.ok(!existsSync(join(home, '.local/bin/pi.cmd')))
  rmSync(home, { recursive: true, force: true })
}

// ── a CLI's sign-in from the page: Claude's link and pasted code, Codex's device code; in a box the capture first, the tokens checked ──
{
const py = script => spawn('python3', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] })
const home = mkdtempSync(join(tmpdir(), 'agent-hub-login-'))
mkdirSync(join(home, '.claude')); mkdirSync(join(home, '.codex'))
const claude = (writes) => py(`import sys
print("Opening browser to sign in…")
print("If the browser didn't open, visit: \\x1b]8;;https://claude.com/cai/oauth/authorize?code=true&state=s1\\x1b\\\\https://claude.com/cai/oauth/authorize?code=true&state=s1\\x1b]8;;\\x1b\\\\", flush=True)
print("Paste code here if prompted > ", end="", flush=True)
code = input()
open(${JSON.stringify(join(home, '.claude/.credentials.json'))}, "w").write(${JSON.stringify(writes)})
sys.exit(0 if code == "abc#state-code-1" else 1)`)
const codex = py => () => spawn('python3', ['-c', `import time
print("1. Open this link in your browser and sign in to your account\\n   https://auth.openai.com/codex/device\\n\\n2. Enter this one-time code (expires in 15 minutes)\\n   P8DL-2TSL8", flush=True)
time.sleep(0.3)
open(${JSON.stringify(join(home, '.codex/auth.json'))}, "w").write('{"tokens":{"refresh_token":"NKB' + 'a'*32 + '"}}')`], { stdio: ['pipe', 'pipe', 'pipe'] })
const which = name => `/opt/${name}`
const until = async f => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 50)) }
// on a host: Claude's link (out of a terminal hyperlink), the pasted code, done
// Claude's login gets a terminal from script(1); Windows has none to give, the CLI starts as it is
assert.deepEqual(loginCommand('claude', '/a path/claude', 'darwin'), ['script', ['-q', '/dev/null', '/a path/claude', 'auth', 'login']])
assert.deepEqual(loginCommand('claude', '/opt/claude', 'linux'), ['script', ['-q', '-c', "'/opt/claude' auth login", '/dev/null']])
let l = createLogin({ which, home, box: null, spawn: (cmd, args) => { assert.deepEqual([cmd, args], loginCommand('claude', '/opt/claude')); return claude('{"claudeAiOauth":{"refreshToken":"real"}}') } })
const st = await l.start('claude')
assert.deepEqual([st.status, st.url, st.needsCode], ['waiting', 'https://claude.com/cai/oauth/authorize?code=true&state=s1', true])
assert.throws(() => l.code('x'), e => e.code === 'badCode')
l.code('abc#state-code-1')
await until(() => l.state().status !== 'waiting')
assert.deepEqual([l.state().status, l.state().kept], ['done', 'here'])
// in a box: the capture bound first; Codex's device code; the tokens kept in the host's vault (placeholders here)
const asked = []
l = createLogin({ which, home, box: 'http://box.test', fetchFn: async url => { asked.push(String(url)); return { ok: true } }, spawn: codex() })
const cx = await l.start('codex')
assert.deepEqual([cx.url, cx.code, cx.needsCode], ['https://auth.openai.com/codex/device', 'P8DL-2TSL8', false])
assert.deepEqual(asked, ['http://box.test/v1/logins/codex'])
await until(() => l.state().status === 'done')
assert.equal(l.state().kept, 'vault')
// in a box whose login left real tokens in the box: said
l = createLogin({ which, home, box: 'http://box.test', fetchFn: async () => ({ ok: true }), spawn: () => claude('{"claudeAiOauth":{"refreshToken":"real-token"}}') })
await l.start('claude'); l.code('abc#state-code-1')
await until(() => l.state().status === 'done')
assert.equal(l.state().kept, 'box', 'real tokens in the box are reported')
// a login that exits 0 but saved empty tokens has not signed in (not "real tokens in the box")
l = createLogin({ which, home, box: 'http://box.test', fetchFn: async () => ({ ok: true }), spawn: () => claude('{"claudeAiOauth":{"accessToken":"","refreshToken":""}}') })
await l.start('claude'); l.code('abc#state-code-1')
await until(() => l.state().status !== 'waiting')
assert.deepEqual([l.state().status, l.state().kept], ['failed', 'none'])
// an old nookbox: no capture to bind → refused before any login starts
l = createLogin({ which, home, box: 'http://box.test', fetchFn: async () => ({ ok: false, status: 501 }), spawn: () => assert.fail('no login without the capture') })
await assert.rejects(l.start('codex'), e => e.code === 'needLoginCapture')
// a CLI that fails before its link: the start rejects with what it said
l = createLogin({ which, home, box: null, spawn: () => py('import sys\nprint("Error: not supported here", file=sys.stderr)\nsys.exit(2)') })
await assert.rejects(l.start('codex'), e => e.code === 'loginFailed' && /not supported here/.test(e.params.detail))
await assert.rejects(createLogin({ which, home }).start('pi'), e => e.code === 'noLogin')
assert.equal(plain('a\x1b]8;;https://x\x1b\\https://x\x1b]8;;\x1b\\ \x1b[1mb\x1b[0m'), 'ahttps://x b')
}

{ // model endpoints (endpoints.js): checked; which runtime takes which; what a run gets; the models listed; the key kept apart
  const t = (fn, code) => assert.throws(fn, e => e.code === code, code)
  assert.deepEqual(normalizeEndpoint({ id: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1/', models: ['deepseek-v4', 'deepseek-v4', ' r2 '] }),
    { id: 'deepseek', name: 'deepseek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4', 'r2'] })
  t(() => normalizeEndpoint({ id: 'x', api: 'grpc', baseUrl: 'https://a' }), 'badEndpointApi')
  t(() => normalizeEndpoint({ id: 'x', api: 'openai', baseUrl: 'ftp://a' }), 'badEndpointUrl')
  t(() => normalizeEndpoint({ id: 'x', api: 'openai', baseUrl: 'https://u:p@a' }), 'badEndpointUrl')
  t(() => normalizeEndpoint({ id: 'x y', api: 'openai', baseUrl: 'https://a' }), 'badEndpointId')
  t(() => normalizeEndpoint({ id: 'x', api: 'openai', baseUrl: 'https://a', models: ['a b'] }), 'badEndpointModels')
  assert.deepEqual(['http://192.168.64.1:8000/v1', 'http://localhost:11434/v1', 'https://api.deepseek.com/v1'].map(localHost), [true, true, false])
  const oa = { id: 'ds', name: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: [] }
  const an = { id: 'an', name: 'Anthropic-like', api: 'anthropic', baseUrl: 'https://api.example.com/anthropic', models: [] }
  const rs = { id: 'rs', name: 'Responses', api: 'openai-responses', baseUrl: 'https://api.example.com/v1', models: [] }
  const pi = endpointLaunch('pi', oa, 'deepseek-v4', 'k1')
  assert.deepEqual([pi.args, pi.env, pi.piModels.providers.ruyix], [['--model', 'ruyix/deepseek-v4'], { RUYIX_ENDPOINT_KEY: 'k1' },
    { baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', apiKey: '$RUYIX_ENDPOINT_KEY', models: [{ id: 'deepseek-v4' }] }], 'pi: its models.json reads the key from the environment, not the file')
  assert.equal(endpointLaunch('pi', an, 'm', '').piModels.providers.ruyix.api, 'anthropic-messages')
  const cl = endpointLaunch('claude', an, 'm2', 'k2')
  assert.deepEqual([cl.args, cl.env.ANTHROPIC_BASE_URL, cl.env.ANTHROPIC_API_KEY, cl.env.ANTHROPIC_SMALL_FAST_MODEL], [['--model', 'm2'], 'https://api.example.com/anthropic', 'k2', 'm2'])
  const cx = endpointLaunch('codex', rs, 'm3', 'k3')
  assert.ok(cx.args.join(' ').includes('model_provider="ruyix"') && cx.args.join(' ').includes('model_providers.ruyix.base_url="https://api.example.com/v1"') && cx.args.join(' ').includes('wire_api="responses"') && cx.env.RUYIX_ENDPOINT_KEY === 'k3' && !cx.args.join(' ').includes('k3'))
  t(() => endpointLaunch('claude', oa, 'm', 'k'), 'endpointRuntime')
  t(() => endpointLaunch('codex', oa, 'm', 'k'), 'endpointRuntime')
  t(() => endpointLaunch('pi', oa, null, 'k'), 'endpointModel')
  // the models it lists: OpenAI's /models (Bearer), Anthropic's /v1/models (x-api-key); a refused key, no list
  const asked = []
  const fetchList = (status, body) => async (url, { headers }) => { asked.push([url, headers]); return { status, ok: status === 200, json: async () => body } }
  assert.deepEqual(await listModels(oa, 'k1', fetchList(200, { data: [{ id: 'b' }, { id: 'a' }] })), ['a', 'b'])
  assert.deepEqual(asked.at(-1), ['https://api.deepseek.com/v1/models', { authorization: 'Bearer k1' }])
  assert.deepEqual(await listModels(an, 'k2', fetchList(200, { data: [{ id: 'm2' }] })), ['m2'])
  assert.equal(asked.at(-1)[0], 'https://api.example.com/anthropic/v1/models?limit=200')
  assert.equal(asked.at(-1)[1]['x-api-key'], 'k2')
  await assert.rejects(listModels(oa, 'bad', fetchList(401, {})), e => e.code === 'endpointKeyRefused')
  await assert.rejects(listModels(oa, 'k', fetchList(200, { nothing: 1 })), e => e.code === 'endpointNoList')
  await assert.rejects(listModels(oa, 'k', async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }) }), e => e.code === 'endpointUnreachable' && /ECONNREFUSED/.test(e.message))
  // the endpoints: a view of dsh's model providers — the protocol mapped, a catalog provider at its known address, one
  // no CLI runtime can use left out; the key the provider's (its apiKeyEnv), read from dsh's credential store
  assert.deepEqual(endpointOfProvider('omlx', { api: 'openai-completions', baseURL: 'http://192.168.64.1:8000/v1/', apiKeyEnv: 'OMLX_API_KEY', models: [{ id: 'qwen3-asr' }, { id: 'qwen3' }] }),
    { id: 'omlx', name: 'omlx', api: 'openai', baseUrl: 'http://192.168.64.1:8000/v1', models: ['qwen3-asr', 'qwen3'], keyEnv: 'OMLX_API_KEY' })
  assert.equal(endpointOfProvider('ant', { api: 'anthropic-messages', baseURL: 'https://api.example.com/anthropic', models: [] }).api, 'anthropic')
  assert.equal(endpointOfProvider('gw', { api: 'openai-completions', baseURL: 'https://gw/v1', displayName: 'Gateway' }).name, 'Gateway', 'its name as Settings shows it')
  assert.deepEqual([endpointOfProvider('deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4' }] }).baseUrl, endpointOfProvider('deepseek', {}).api], ['https://api.deepseek.com/v1', 'openai'], 'pi-ai\'s catalog: its known address')
  assert.equal(endpointOfProvider('google', { models: [] }), null, 'a provider no CLI runtime can be pointed at: dsh\'s alone')
  assert.equal(endpointOfProvider('x', { api: 'openai-completions' }), null, 'no address')
  // (the shell's rule, providers.js: an address of its own without a protocol is OpenAI's chat completions; a catalog id
  // that names a protocol but no address is at the catalog's)
  assert.deepEqual([endpointOfProvider('mine', { baseURL: 'https://mine.example/v1' }).api, endpointOfProvider('deepseek', { api: 'openai-completions' }).baseUrl], ['openai', 'https://api.deepseek.com/v1'])
  assert.equal(endpointOfProvider('g', { api: 'google-generative-ai', baseURL: 'https://g.example' }), null, 'a protocol no CLI runtime takes')
  const kept = new Map([['DEEPSEEK_API_KEY', 'sk-NKBplaceholder'], ['OMLX_API_KEY', 'local-key']])
  const credentials = () => ({ resolve: async k => (kept.has(k) ? { value: kept.get(k) } : undefined) })
  const provs = { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4' }] }, omlx: { api: 'openai-completions', baseURL: 'http://192.168.64.1:8000/v1', apiKeyEnv: 'OMLX_API_KEY', models: [] }, google: { models: [] }, bare: { api: 'openai-completions', baseURL: 'https://bare.example/v1', apiKeyEnv: 'BARE_API_KEY', models: [] } }
  const eps = createEndpoints({ providers: () => provs, credentials, fetchFn: fetchList(200, { data: [{ id: 'listed' }] }) })
  assert.deepEqual(eps.list().map(e => e.id), ['bare', 'deepseek', 'omlx'])
  assert.equal(await eps.key('deepseek'), 'sk-NKBplaceholder', 'in a box: the vault\'s placeholder, as the shell kept it')
  assert.equal(await eps.key('omlx'), 'local-key')
  assert.equal(await eps.key('bare'), '', 'no key set: none')
  assert.deepEqual(await eps.test('omlx'), { models: ['listed'] })
  await assert.rejects(eps.test('google'), e => e.code === 'noEndpoint')
  assert.ok(!('save' in eps) && !('remove' in eps), 'kept by dsh\'s settings: Settings → 模型 adds and changes them')
  // before the one list: Agent Hub's own endpoints become providers — ids and key names kept; the same address is the
  // provider it already is; an id taken at another address is renamed
  const moved = providersFromEndpoints([
    { id: 'ds', name: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4'] },
    { id: 'omlx', name: 'omlx', api: 'openai', baseUrl: 'http://192.168.64.1:8000/v1', models: [] },
    { id: 'bare', name: 'Elsewhere', api: 'anthropic', baseUrl: 'https://other.example', models: ['m'] },
  ], provs)
  assert.deepEqual(moved.add, [
    { id: 'ds', value: { apiKeyEnv: 'RUYIX_ENDPOINT_DS', api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-v4' }], displayName: 'DeepSeek' } },
    { id: 'bare-ep', value: { apiKeyEnv: 'RUYIX_ENDPOINT_BARE', api: 'anthropic-messages', baseURL: 'https://other.example', models: [{ id: 'm' }], displayName: 'Elsewhere' } },
  ])
  assert.deepEqual(moved.renamed, { bare: 'bare-ep' })
  assert.deepEqual(moved.same, [{ id: 'omlx', keyEnv: 'RUYIX_ENDPOINT_OMLX', has: 'OMLX_API_KEY' }], 'the provider it already is: its key name may have to be this one\'s')
  assert.ok(!JSON.stringify(moved).includes('sk-'), 'no key moves: the provider names the credential it was kept under')
  // every model its address listed (more than PICKED_MAX): the ones in use only
  const lots = Array.from({ length: PICKED_MAX + 1 }, (_, i) => `x/m${i}`)
  assert.deepEqual(providersFromEndpoints([{ id: 'or', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: lots }], {}, { or: new Set(['x/m2']) }).add[0].value.models, [{ id: 'x/m2' }])
  assert.deepEqual(modelsToKeep(['a', 'b'], new Set()), ['a', 'b'], 'a few: picked by hand')
  assert.equal(modelsToKeep(lots, new Set(['elsewhere'])).length, lots.length, 'none of them in use: all, nothing to go by')
}

{ // API keys (keys.js): checked with the provider first; in a box the vault keeps the value and the CLI its placeholder; a sign-out lets it go
  const kept = new Map(), credentials = () => ({ set: async (k, v) => { kept.set(k, v) }, unset: async k => { kept.delete(k) }, resolve: async k => (kept.has(k) ? { value: kept.get(k) } : undefined) })
  const spawned = [], calls = []
  const spawn = (bin, args) => {
    const c = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter()
    c.stdin = { on() {}, end: x => { spawned.push([bin, args.join(' '), String(x || '').trim()]); setImmediate(() => c.emit('close', 0)) } }
    return c
  }
  let answer = 200
  const PH = `NKB${'p'.repeat(32)}`
  const fetchFn = async (url, o = {}) => {
    calls.push([o.method || 'GET', String(url), JSON.stringify(o.headers || {}), o.body || ''])
    return String(url).includes('/v1/secrets/') ? { ok: true, status: 200, json: async () => ({ placeholder: PH }) } : { status: answer }
  }
  const which = n => `/opt/${n}`, had = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    // on a host: Claude Code's key in the store, checked first; a refused one is not kept
    let k = createKeys({ which, credentials, box: null, spawn, fetchFn })
    await assert.rejects(k.set('claude', 'short'), e => e.code === 'badKey')
    answer = 401
    await assert.rejects(k.set('claude', `sk-ant-api03-${'x'.repeat(20)}`), e => e.code === 'keyRejected')
    assert.equal(kept.size, 0, 'a refused key is not kept')
    answer = 200
    const key = `sk-ant-api03-${'x'.repeat(16)}abcd`
    assert.deepEqual(await k.set('claude', key), { verified: true, tail: 'abcd' })
    assert.deepEqual(await k.env('claude'), { ANTHROPIC_API_KEY: key }, 'each run gets the key')
    assert.equal(await k.env('codex'), null, 'Codex reads its own auth.json')
    await k.signOut('claude')
    assert.deepEqual(spawned.at(-1).slice(0, 2), ['/opt/claude', 'auth logout'])
    assert.equal(await k.env('claude'), null, 'signed out: the key let go')
    // in a box: the value to the host's vault; the check and Codex's own login with the placeholder only
    calls.length = 0
    k = createKeys({ which, credentials, box: 'http://box.test', boxName: 'ruyix-ops', spawn, fetchFn })
    await k.set('codex', `sk-proj-${'y'.repeat(20)}`)
    // checked under a name of its own, then kept under this box's name
    assert.deepEqual(calls.map(c => `${c[0]} ${c[1].replace('http://box.test', '')}`), ['PUT /v1/secrets/CONN_RUYIX_OPS_OPENAI_KEY_NEXT', 'GET https://api.openai.com/v1/models', 'DELETE /v1/secrets/CONN_RUYIX_OPS_OPENAI_KEY_NEXT', 'PUT /v1/secrets/CONN_RUYIX_OPS_OPENAI_KEY'])
    assert.match(calls[0][3], /"hosts":\["api\.openai\.com"\]/)
    assert.match(calls[1][2], new RegExp(`Bearer ${PH}`))
    assert.deepEqual(spawned.at(-1), ['/opt/codex', 'login --with-api-key', PH])
    assert.ok(!JSON.stringify(spawned).includes('y'.repeat(20)), 'the real key never reaches the box\'s CLI')
    await k.signOut('codex')
    assert.deepEqual([spawned.at(-1)[1], calls.at(-1)[0], calls.at(-1)[1]], ['logout', 'DELETE', 'http://box.test/v1/secrets/CONN_RUYIX_OPS_OPENAI_KEY'])
    // a key refused in a box: only its trial cleared — the key in use is not touched
    answer = 401; calls.length = 0
    await assert.rejects(k.set('claude', `sk-ant-api03-${'z'.repeat(20)}`), e => e.code === 'keyRejected')
    assert.deepEqual(calls.map(c => `${c[0]} ${c[1].replace(/.*\/v1\/secrets\//, '')}`), ['PUT CONN_RUYIX_OPS_ANTHROPIC_KEY_NEXT', 'GET https://api.anthropic.com/v1/models', 'DELETE CONN_RUYIX_OPS_ANTHROPIC_KEY_NEXT'])
    // dsh's own Anthropic key (its models) is not this one: never handed to runs as ours, never let go by a sign-out
    kept.set('ANTHROPIC_API_KEY', 'dsh-own')
    assert.equal(await k.env('claude'), null)
    await k.signOut('claude')
    assert.equal(kept.get('ANTHROPIC_API_KEY'), 'dsh-own')
    await assert.rejects(k.set('pi', 'x'.repeat(30)), e => e.code === 'noKeyLogin')
  } finally { if (had !== undefined) process.env.ANTHROPIC_API_KEY = had }
}
// (a symlink to a file that is not there yet: Unix's; Windows links the file once it exists)
if (!WIN) { // an isolated Codex home after a sign-out: the link left dangling is kept, not made again (EEXIST)
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-codex-')), was = process.env.CODEX_HOME
  process.env.CODEX_HOME = join(dir, 'user')
  try {
    mkdirSync(join(dir, 'user')); writeFileSync(join(dir, 'user', 'auth.json'), '{}')
    codexHomeIn(dir)
    rmSync(join(dir, 'user', 'auth.json')) // codex logout
    codexHomeIn(dir)
    writeFileSync(join(dir, 'user', 'auth.json'), '{"auth_mode":"apikey"}') // signed in again
    assert.equal(readFileSync(join(dir, 'codex-home', 'auth.json'), 'utf8'), '{"auth_mode":"apikey"}')
  } finally { if (was === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = was; rmSync(dir, { recursive: true, force: true }) }
}

// Windows: an npm .cmd shim starts as node <its script> (cmd.exe would mangle arguments); the installer's own .cmd, which
// only calls npm's, is followed to it; elsewhere a command starts as it is
{
  const { launch } = await import('./platform.js')
  const dir = mkdtempSync(join(tmpdir(), 'hub-shim-'))
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  const npmShim = join(dir, 'node_modules', '.bin', 'codex.cmd')
  writeFileSync(npmShim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\..\\@openai\\codex\\bin\\codex.js" %*\r\n')
  const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  assert.deepEqual(launch(npmShim, ['exec', '-'], true), [process.execPath, [script, 'exec', '-']])
  const own = join(dir, 'codex.cmd')
  writeFileSync(own, `@"${npmShim}" %*\r\n`)
  assert.deepEqual(launch(own, ['login'], true), [process.execPath, [script, 'login']], 'the installer\'s .cmd is followed to npm\'s')
  writeFileSync(join(dir, 'odd.cmd'), '@echo hi\r\n')
  assert.equal(launch(join(dir, 'odd.cmd'), ['x'], true)[1].slice(0, 3).join(' '), '/d /s /c', 'anything else through cmd.exe')
  assert.deepEqual(launch('/usr/bin/codex', ['x'], false), ['/usr/bin/codex', ['x']])
  rmSync(dir, { recursive: true, force: true })
}

console.log('agent-hub check: ok')
} finally {
  // Windows does not delete a database file that is still open (the hub's, until the process ends): left in tmp
  try { rmSync(tmp, { recursive: true, force: true }) } catch (err) { if (process.platform !== 'win32') throw err }
}


// A sync queued during slow terminal I/O uses the latest session list.
{
  const { createMirrors, windowName } = await import('./mirror.js')
  let release, first = true; const windows = new Map()
  const old = { id: 'session-old01', title: 'Old' }, latest = { id: 'session-new02', title: 'New' }
  const mirrors = createMirrors({ attach: id => ['mirror', id], has: bin => bin === 'tmux', run: async (_cmd, args) => {
    const op = args[2]
    if (first) { first = false; await new Promise(resolve => { release = resolve }) }
    if (op === 'list-windows') return [...windows].map(([name, i]) => `${i} ${name}`).join('\n')
    if (op === 'new-window') windows.set(args[args.indexOf('-n') + 1], String(windows.size + 1))
    if (op === 'kill-window') { const i = args.at(-1).split(':').at(-1); for (const [name, n] of windows) if (n === i) windows.delete(name) }
    return ''
  } })
  const running = mirrors.sync([old]); await Promise.resolve()
  await mirrors.sync([latest]); release(); await running
  assert.deepEqual([...windows.keys()], [windowName(latest)])
}

// A box capture is asynchronous: cancelling its reservation never spawns an orphaned login.
{
  const {EventEmitter}=await import('node:events'),captures=[],children=[]
  const fakeChild=()=>{
    const p=new EventEmitter();p.stdin=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdin.write=()=>{}
    p.kill=()=>{p.killed=true;setTimeout(()=>p.emit('close',1),5)};children.push(p)
    setTimeout(()=>p.stdout.emit('data','https://auth.openai.com/codex/device ABCD-1234'),0)
    return p
  }
  const l=createLogin({which:n=>n,box:'http://box.test',fetchFn:()=>new Promise(resolve=>captures.push(resolve)),spawn:fakeChild})
  const first=l.start('codex'),cancelled=assert.rejects(first,{code:'loginFailed'}),second=l.start('codex')
  captures[0]({ok:true});await cancelled;assert.equal(children.length,0)
  captures[1]({ok:true});assert.equal((await second).status,'waiting');assert.equal(children.length,1)
  const third=l.start('codex');captures[2]({ok:true});assert.equal((await third).status,'waiting')
  await new Promise(r=>setTimeout(r,15));assert.equal(l.state().status,'waiting','an old child close cannot fail the current sign-in');assert.equal(children[0].killed,true)
  l.stop();assert.equal(children[1].killed,true)
}

{
  const { createSkills } = await import('./skills.js')
  const base = mkdtempSync(join(tmpdir(), 'ruyix-pin-cache-')), src = join(base, 'src'), home = join(base, 'home')
  try {
    mkdirSync(join(src, 'skills', 'one'), { recursive: true })
    writeFileSync(join(src, 'skills/one/SKILL.md'), '---\ndescription: offline\n---\nkept')
    const git = a => execFileSync('git', a, { cwd: src, encoding: 'utf8' })
    git(['init', '-q', '-b', 'main']); git(['add', '.']); git(['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'one'])
    const sha = git(['rev-parse', 'HEAD']).trim()
    let running = 0, peak = 0
    const packs = createSkills({ home, run: async args => {
      running++; peak = Math.max(peak, running)
      try { await new Promise(r => setTimeout(r, 5)); return git(args) } finally { running-- }
    } })
    packs.adopt([{ id: 'cached', git: src, path: 'skills', sha }])
    const pin = { sha }
    await Promise.all([1, 2, 3].map(() => packs.dirAt('cached', pin)))
    assert.equal(peak, 1, 'waiters never fetch into a shared git repository concurrently')
    const pending = packs.dirOf('cached'), rejected = assert.rejects(pending, e => e.code === 'skillPackChanged')
    packs.remove('cached'); await rejected
    assert.deepEqual(packs.sources(['cached']), [], 'a pending cached fetch never revives a removed pack')
    packs.adopt([{ id: 'cached', git: src, path: 'skills', sha }])
    let releaseFetch
    const blockedHome = join(base, 'fetching'), blocked = createSkills({ home: blockedHome, run: args => new Promise(resolve => { releaseFetch = () => resolve(git(args)) }) })
    blocked.adopt([{ id: 'cached', git: src, path: 'skills', sha }])
    const fetching = blocked.dirOf('cached')
    assert.throws(() => blocked.remove('cached'), e => e.code === 'skillGitBusy', 'removal never deletes a live git repository')
    // Let each real git command finish, including archive, without removing its files underneath it.
    let finished = false; fetching.finally(() => { finished = true })
    while (!finished) { const release = releaseFetch; releaseFetch = null; release?.(); await new Promise(r => setTimeout(r, 0)) }
    await fetching; blocked.remove('cached')
    await Promise.all([1, 2, 3].map(() => packs.dirOf('cached')))
    const offline = createSkills({ home, run: async () => assert.fail('cached pins must not need git or a network') })
    const resolved = await offline.resolve(['cached/one'], src, { cached: pin })
    assert.equal(resolved[0].missing, undefined)
    assert.ok(resolved[0].dir.endsWith('skills/one'))
    // Older full-config imports wrote a pin without a snapshot: report fetchable and restore that exact commit.
    const restoredHome = join(base, 'restored')
    mkdirSync(restoredHome)
    writeFileSync(join(restoredHome, 'skill-packs.json'), JSON.stringify({ git: { cached: { id: 'cached', git: src, ref: 'main', path: 'skills', sha } }, policy: { local: false } }))
    const restored = createSkills({ home: restoredHome })
    assert.equal((await restored.check(['cached/one']))[0].status, 'fetch')
    assert.equal((await restored.resolve(['cached/one']))[0].missing, undefined)
    assert.equal(restored.sources(['cached'])[0].sha, sha)
    // A CLI import while the service runs cannot be erased by the live owner's next save.
    const { importConfig } = await import('../../shell/bin/ruyix-config.mjs')
    await importConfig({ kind: 'ruyix-config', version: 2, settings: { 'agent-hub': { skillPacks: { git: { staged: { id: 'staged', git: src, path: 'skills', sha } }, policy: { local: true } } } } }, {}, { home: base, env: { DSH_AGENT_HUB_HOME: restoredHome }, products: {} })
    restored.setPolicy({ local: false })
    assert.ok(existsSync(join(restoredHome, 'import/skill-packs.json')))
    assert.ok(restored.takeImport().every(r => r.ok))
    assert.equal(restored.policy().local, true)
    assert.equal((await restored.resolve(['staged/one']))[0].missing, undefined)
    restored.setPolicy({ local: false })
    const kept = JSON.parse(readFileSync(join(restoredHome, 'skill-packs.json'), 'utf8'))
    assert.ok(kept.git.cached && kept.git.staged)
    await importConfig({ kind: 'ruyix-config', version: 2, settings: { 'agent-hub': { skillPacks: { git: { prototype: { id: 'prototype', git: src, path: 'skills', sha } } } } } }, {}, { home: base, env: { DSH_AGENT_HUB_HOME: restoredHome }, products: {} })
    assert.ok(restored.takeImport().every(r => r.ok), 'prototype is a valid ordinary pack id')
    assert.equal((await restored.resolve(['prototype/one']))[0].missing, undefined)
  } finally { rmSync(base, { recursive: true, force: true }) }
}
// The public service also excludes removal against background or cross-page installation.
{
const src=readFileSync(new URL('./index.js',import.meta.url),'utf8'),a=src.indexOf('  async function installRuntime('),b=src.indexOf('  async function runtimeView(',a),r=src.indexOf('    runtimeRemove:'),end=src.indexOf('    /** A CLI\'s own sign-in',r)
const remove=src.slice(r,end).trim().replace(/^runtimeRemove:\s*/,'').replace(/,$/,'')
const env={installing:'pi',busyWith:()=>[],CLI:{pi:{name:'pi'}},fail:(code,params,message)=>Object.assign(new Error(message),{code,params}),installer:{install:async()=>{},remove:async()=>{}},runtimeView:async()=>({})}
const ops=new Function('env','with(env){'+src.slice(a,b)+';return {installRuntime,remove:('+remove+')}}')(env)
await assert.rejects(ops.remove({runtime:'pi',force:true}),e=>e.code==='runtimeInstalling','force applies to active tasks, not another runtime mutation')
env.installing=null;let release;env.installer.remove=()=>new Promise(r=>{release=r})
const removing=ops.remove({runtime:'pi'});try{assert.equal(env.installing,'pi');await assert.rejects(ops.installRuntime('pi'),e=>e.code==='runtimeInstalling')}finally{release();await removing}
assert.equal(env.installing,null)
env.installer.remove=async()=>{throw new Error('fixture failure')};await assert.rejects(ops.remove({runtime:'pi'}),/fixture failure/);assert.equal(env.installing,null);await ops.installRuntime('pi')
console.log('runtime service mutation ownership: ok')
}
