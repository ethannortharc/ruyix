// Member runtimes besides dsh itself: Claude Code (`claude -p`), Codex (`codex exec`) and pi (`pi -p --mode json`).
// Each CLI streams JSON lines; the parsers translate them into the same events the dsh
// session log uses (tool/call, tool/result, assistant/message), so one fold renders
// every member's live activity the same way.
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { WIN, commandNames, launch, linkFile, stopTree } from './platform.js'

export const RUNTIMES = ['dsh', 'claude', 'codex', 'pi']
/** What each CLI runtime is called; all three take an MCP server (pi since 1.x: its built-in mcp extension, mcp.json). */
export const CLI = {
  claude: { name: 'Claude Code', mcp: true },
  codex: { name: 'Codex', mcp: true },
  pi: { name: 'pi', mcp: true },
}
export const ACCESS = ['read', 'write', 'full']
/** A failure the member's provider caused — a refusal, a limit, an outage — that a member's fallback may take over. */
export const FALLBACK_ON = /flagged for possible cybersecurity risk|cyber permissive safeguards|Daybreak access|usage limit|rate.?limit|quota|insufficient_quota|overloaded|model (?:is )?(?:not found|unavailable|does not exist)|not available for your (?:plan|account)|credit balance is too low/i

// Reasoning effort each CLI accepts (claude --effort, codex model_reasoning_effort).
export const EFFORTS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'], pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }

// dsh tools a read-only member must not have.
export const READ_ONLY_DENY = ['write', 'edit', 'str_replace_editor', 'bash', 'bash_persistent', 'pwsh', 'job_kill']

/** Claude Code's tools no run of ours offers: its own question to the user (nobody here sees it). */
export const NO_CLAUDE = ['AskUserQuestion']
const ARGS = {
  claude: {
    read: ['--permission-mode', 'dontAsk', '--disallowedTools', 'Edit,Write,NotebookEdit,Bash', '--allowedTools', 'WebFetch,WebSearch'],
    write: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,WebFetch,WebSearch'],
    full: ['--permission-mode', 'bypassPermissions'],
  },
  // pi's built-in tools: read, bash, edit, write, grep, find, ls
  pi: {
    read: ['--tools', 'read,grep,find,ls'],
    write: ['--tools', 'read,grep,find,ls,edit,write,bash'],
    full: [],
  },
  codex: {
    read: ['--sandbox', 'read-only'],
    write: ['--sandbox', 'workspace-write'],
    full: ['--sandbox', 'danger-full-access'],
  },
}

/** Executable on PATH (plus ~/.local/bin, where both CLIs install by default). */
export function which(name) {
  const dirs = [...String(process.env.PATH || '').split(delimiter), join(homedir(), '.local', 'bin')]
  for (const dir of dirs.filter(Boolean)) {
    for (const file of commandNames(name).map(n => join(dir, n))) {
      try { accessSync(file, constants.X_OK); return file } catch { /* next */ }
    }
  }
  return null
}

/** Check the CLI's own login state without starting a model request or returning credentials. */
export function runtimeStatus(runtime, bin = which(runtime), env = null) {
  if (!bin) return Promise.resolve({ installed: false, authenticated: false, ready: false, status: 'missing' })
  return new Promise(resolve => {
    // pi signs in per model provider: ready when it has a model it can use (a key in the environment, a /login)
    const args = runtime === 'claude' ? ['auth', 'status', '--json'] : runtime === 'pi' ? ['--list-models'] : ['login', 'status']
    const [cmd, argv] = launch(bin, args)
    const child = execFile(cmd, argv, { timeout: 10000, maxBuffer: 1 << 20, windowsHide: true, ...(env && { env: { ...process.env, ...env } }) }, (err, stdout, stderr) => {
      let authenticated = null, how = null // how: signed in with an account or an API key
      if (runtime === 'pi') authenticated = !err && !/no models available/i.test(`${stdout}\n${stderr}`)
      else if (runtime === 'claude') {
        try { const data = JSON.parse(stdout); if (typeof data.loggedIn === 'boolean') authenticated = data.loggedIn; if (data.loggedIn) how = data.authMethod === 'api_key' ? 'key' : 'account' } catch { /* old CLI or failed probe */ }
      } else if (!err && /(?:^|\n)Logged in\b/i.test(`${stdout}\n${stderr}`)) { authenticated = true; how = /API key/i.test(`${stdout}\n${stderr}`) ? 'key' : 'account' }
      else if (/not logged in/i.test(`${stdout}\n${stderr}`)) authenticated = false
      resolve({ installed: true, authenticated, ready: authenticated === true && !err, how,
        status: authenticated === false ? 'unauthenticated' : authenticated === true && !err ? 'ready' : 'unverified' })
    })
    child.stdin.end()
  })
}

/**
 * Codex enforces read/write access with bubblewrap. Where bwrap cannot start (e.g. Ubuntu's
 * kernel.apparmor_restrict_unprivileged_userns=1) every sandboxed command fails, so callers
 * refuse read/write Codex members instead of silently running them unsandboxed.
 * Resolves to null when the sandbox works, else the reason.
 */
const sandboxProbes = new Map()
export function codexSandboxError(bin = which('codex')) {
  if (!bin) return Promise.resolve('the codex CLI is not installed')
  // bubblewrap is Linux's; macOS's Seatbelt and Windows's own sandbox start with Codex (and Windows has no `true`)
  if (WIN) return Promise.resolve(null)
  if (!sandboxProbes.has(bin)) {
    sandboxProbes.set(bin, new Promise(resolve => {
      const child = execFile(bin, ['sandbox', '--', 'true'], { timeout: 20000 }, (err, _out, stderr) => {
        resolve(err ? (String(stderr).split('\n').find(l => l.trim()) || err.message).trim() : null)
      })
      child.stdin.end()
    }))
  }
  return sandboxProbes.get(bin)
}
export const codexSandboxHelp = reason => `Codex's sandbox cannot start on this machine (${reason}), so read/write access cannot be enforced. ` +
  'Give this member "full" access, or allow unprivileged user namespaces (e.g. sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0).'

/**
 * argv + stdin for one run. Instructions ride the system prompt where the CLI has one.
 * `mcp` ({ name, command, args, env }) attaches one MCP server for this run only — e.g. a
 * product workbench's tools — and allows its tools under the member's access level.
 */
const ENV_WRAPPER = join(dirname(fileURLToPath(import.meta.url)), 'mcp-env.mjs')
/**
 * What makes process.execPath a Node: under the DeepSeek Harness app it is the Electron binary, which runs as Node only
 * with ELECTRON_RUN_AS_NODE (otherwise it starts the app). The CLIs give an MCP server only the env they are told.
 */
export const NODE_ENV = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
/** An MCP server whose env (a run token) goes through a 0600 file in `dir` and mcp-env.mjs, not the CLI's argv. */
export function mcpViaEnvFile(mcp, dir) {
  if (!mcp || !Object.keys(mcp.env || {}).length) return mcp
  const file = join(dir, `${mcp.name}.env.json`)
  writeFileSync(file, JSON.stringify(mcp.env), { mode: 0o600 })
  return { ...mcp, command: process.execPath, args: [ENV_WRAPPER, file, mcp.command, ...(mcp.args || [])], env: { ...NODE_ENV } }
}

/** `resume`: a session id to continue (the CLI already has the instructions and the history; `task` is the nudge). */
// isolated: no skills of this machine or the workspace — Claude reads only its local settings layer (not the user's or
// the project's: their skills, plugins and hooks stay out), Codex gets its own home (runCli)
// web: the task may search the web — Claude Code's access levels allow it already; Codex needs its live search turned on
// endpoint: a model endpoint's arguments (endpoints.js endpointLaunch) — in place of the agent's own model
// mcp: one MCP server ({ name, command, args, env }) or several (a run's tools, the agents' browser)
export function cliCommand(runtime, { model, effort, access, instructions, task, cwd, mcp, resume, pluginDir, isolated = false, web = false, endpoint = null }) {
  const servers = [mcp].flat().filter(Boolean)
  const ownModel = flag => (endpoint ? endpoint.args : model ? [flag, model] : [])
  if (runtime === 'pi') {
    // its MCP server is in its own folder's mcp.json (piHomeIn); without extensions the built-in mcp one is named back.
    // An allowlist of tools (read, write access) drops the server's tools too unless it names them: mcp__<server>__*
    const tools = [...ARGS.pi[access]]
    if (tools[0] === '--tools') for (const m of servers) tools[1] = `${tools[1]},mcp__${m.name.replace(/[^A-Za-z0-9_]/g, '_')}__*`
    return {
      args: ['-p', '--mode', 'json', ...(resume ? ['--session', resume] : []), ...ownModel('--model'), ...(effort ? ['--thinking', effort] : []),
        ...tools, ...(isolated ? ['--no-skills', '--no-extensions', '--no-approve', ...(servers.length ? ['-e', 'builtin:mcp'] : [])] : []), '--append-system-prompt', instructions],
      input: task, // print mode reads piped stdin into the prompt
    }
  }
  if (runtime === 'claude') {
    const base = [...ARGS.claude[access]]
    // Claude Code's own question to the user (AskUserQuestion) has nobody to answer it here — not in a task, a session or
    // the conversation (the person answers on cards): never offered, so it asks in words or with a card instead
    const at = base.indexOf('--disallowedTools')
    if (at >= 0) base[at + 1] = `${base[at + 1]},${NO_CLAUDE.join(',')}`
    else base.push('--disallowedTools', NO_CLAUDE.join(','))
    const extra = []
    if (servers.length) {
      extra.push('--mcp-config', JSON.stringify({ mcpServers: Object.fromEntries(servers.map(m => [m.name, { command: m.command, args: m.args || [], env: m.env || {} }])) }))
      const names = servers.map(m => `mcp__${m.name}`).join(',')
      const at = base.indexOf('--allowedTools')
      if (at >= 0) base[at + 1] = `${base[at + 1]},${names}`
      else if (access !== 'full') base.push('--allowedTools', names)
    }
    return {
      args: ['-p', '--output-format', 'stream-json', '--verbose', ...(resume ? ['--resume', resume] : []), ...ownModel('--model'), ...(effort ? ['--effort', effort] : []),
        ...base, ...extra, ...(isolated ? ['--setting-sources', 'local'] : []), ...(pluginDir ? ['--plugin-dir', pluginDir] : []), '--append-system-prompt', instructions],
      input: task,
    }
  }
  const server = servers.flatMap(mcp => [
    '-c', `mcp_servers.${mcp.name}.command=${JSON.stringify(mcp.command)}`,
    '-c', `mcp_servers.${mcp.name}.args=${JSON.stringify(mcp.args || [])}`,
    '-c', `mcp_servers.${mcp.name}.tool_timeout_sec=${MCP_TOOL_TIMEOUT_MS / 1000}`,
    // the task's own server (the workbench's tools, scoped to this task by its token): its calls need no approval.
    // An isolated member's Codex never asks (approval_policy never), so without this every call fails under the
    // read-only and workspace-write sandboxes — the shell stays sandboxed either way.
    '-c', `mcp_servers.${mcp.name}.default_tools_approval_mode="approve"`,
    ...Object.entries(mcp.env || {}).flatMap(([k, v]) => ['-c', `mcp_servers.${mcp.name}.env.${k}=${JSON.stringify(String(v))}`]),
  ])
  return {
    args: ['exec', '--json', '--skip-git-repo-check', '-C', cwd, ...ownModel('-m'), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
      ...server, ...(web ? ['-c', 'web_search="live"'] : []), ...ARGS.codex[access], ...(resume ? ['resume', resume] : []), '-'],
    input: resume ? task : `${instructions}\n\n## Your task\n${task}`,
  }
}

const ev = (type, data) => ({ type, time: Date.now(), data })
const call = (callId, name, args) => ev('tool/call', { callId, name, arguments: JSON.stringify(args ?? {}) })
const result = (callId, isError) => ev('tool/result', { message: { toolCallId: callId, isError: !!isError } })
const said = text => ev('assistant/message', { message: { content: [{ type: 'text', text }] } })

/**
 * Parse one JSON line into dsh-shaped events plus run facts
 * ({ model, output, tokens, cost, error }). `state` carries per-run memory.
 */
export function parseLine(runtime, line, state) {
  let msg
  try { msg = JSON.parse(line) } catch { return { events: [] } }
  const out = runtime === 'claude' ? claudeLine(msg) : runtime === 'pi' ? piLine(msg, state) : codexLine(msg, state)
  // The CLI's own session (Claude: every line; Codex: thread.started; pi: its header) — a task cut short can resume it.
  const sessionId = runtime === 'claude' ? msg.session_id : runtime === 'pi' ? (msg.type === 'session' ? msg.id : undefined) : msg.type === 'thread.started' ? msg.thread_id : undefined
  return sessionId ? { ...out, sessionId } : out
}

function claudeLine(msg) {
  const content = Array.isArray(msg.message?.content) ? msg.message.content : []
  switch (msg.type) {
    case 'system':
      return { events: [], model: msg.subtype === 'init' ? msg.model : undefined }
    case 'assistant':
      return {
        events: content.flatMap(b => (b.type === 'tool_use' ? [call(b.id, b.name, b.input)] : b.type === 'text' && b.text.trim() ? [said(b.text)] : [])),
      }
    case 'user':
      return { events: content.filter(b => b.type === 'tool_result').map(b => result(b.tool_use_id, b.is_error)) }
    case 'result': {
      const u = msg.usage || {}
      return {
        events: [],
        output: typeof msg.result === 'string' ? msg.result : undefined,
        error: msg.is_error ? String(msg.result || msg.subtype || 'claude run failed') : undefined,
        cost: msg.total_cost_usd,
        tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0),
        usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_tokens: u.cache_read_input_tokens || 0, cache_write_tokens: u.cache_creation_input_tokens || 0 },
      }
    }
    default:
      return { events: [] }
  }
}

// a run's token usage so far, split the way nookbox counts a model call's (input, output, cache read, cache write)
const addUsage = (a = {}, b) => Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map(k => [k, (a[k] || 0) + (Number(b[k]) || 0)]))

// pi's event stream (docs/json.md): tools start and end by call id; an assistant message ends whole, with its usage
function piLine(msg, state) {
  switch (msg.type) {
    case 'tool_execution_start': return { events: [call(msg.toolCallId, msg.toolName, msg.args)] }
    case 'tool_execution_end': return { events: [result(msg.toolCallId, msg.isError)] }
    case 'message_end': {
      const m = msg.message || {}
      if (m.role !== 'assistant') return { events: [] }
      const text = (Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
      const u = m.usage || {}
      state.tokens = (state.tokens || 0) + (u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0))
      state.cost = (state.cost || 0) + (u.cost?.total || 0)
      state.usage = addUsage(state.usage, { input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite })
      if (text) state.last = text
      return {
        events: text ? [said(text)] : [], model: m.model, tokens: state.tokens, usage: state.usage, ...(state.cost && { cost: state.cost }),
        ...(m.stopReason === 'error' && { error: m.errorMessage || 'pi run failed' }),
      }
    }
    case 'agent_end': return { events: [], output: state.last }
    default: return { events: [] }
  }
}

// Codex item types → the tool names the panel already has icons for.
const codexTool = item => {
  switch (item.type) {
    case 'command_execution': return ['bash', { command: item.command }]
    case 'file_change': return ['edit', { path: (item.changes || []).map(c => c.path).join(', ') }]
    case 'mcp_tool_call': return [`${item.server}.${item.tool}`, item.arguments]
    case 'web_search': return ['web_search', { query: item.query }]
    default: return null
  }
}

function codexLine(msg, state) {
  const item = msg.item
  switch (msg.type) {
    case 'item.started': {
      const tool = item && codexTool(item)
      if (!tool) return { events: [] }
      state.started ??= new Set()
      state.started.add(item.id)
      return { events: [call(item.id, ...tool)] }
    }
    case 'item.completed': {
      if (item?.type === 'agent_message') return { events: item.text?.trim() ? [said(item.text)] : [], output: item.text }
      const tool = item && codexTool(item)
      if (!tool) return { events: [] }
      const failed = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0) || !!item.error
      // Some items (file changes) only ever complete; show them as an instant call.
      const events = state.started?.has(item.id) ? [] : [call(item.id, ...tool)]
      return { events: [...events, result(item.id, failed)] }
    }
    case 'turn.completed': {
      const u = msg.usage || {}
      state.tokens = (state.tokens || 0) + (u.input_tokens || 0) + (u.output_tokens || 0)
      // codex's input_tokens count the cached ones too
      state.usage = addUsage(state.usage, { input_tokens: (u.input_tokens || 0) - (u.cached_input_tokens || 0), output_tokens: u.output_tokens, cache_read_tokens: u.cached_input_tokens })
      return { events: [], tokens: state.tokens, usage: state.usage }
    }
    case 'turn.failed':
      return { events: [], error: msg.error?.message || 'codex turn failed' }
    // codex also reports transient trouble here ("Reconnecting… 1/5"): a warning, the failure only if the run fails
    case 'error':
      return { events: [], warning: msg.message || 'codex error' }
    default:
      return { events: [] }
  }
}

/**
 * Run one CLI member to completion. `onLine(parsed)` sees every parsed line; the raw stream
 * is kept in `logFile` for post-mortems. Resolves with the exit code and stderr tail.
 */
const CLI_LIMIT_MS = 3 * 3600e3
// A member's MCP tool call (e.g. the workbench's tests_run, up to 30 min) may take this long: the CLIs' own defaults
// (Claude Code a few minutes, Codex 60 s) cut long test runs off and leave the member polling a background job.
export const MCP_TOOL_TIMEOUT_MS = 35 * 60e3
/**
 * An isolated Codex member's home (CODEX_HOME): the user's sign-in linked in, an empty config — none of their plugins,
 * skills or MCP servers. Its sessions stay there, so a member's session resumes. ponytail: Codex still reads
 * ~/.agents/skills (it cannot be switched off yet); a sandbox has none.
 */
export function codexHomeIn(dir) {
  const home = join(dir, 'codex-home')
  mkdirSync(home, { recursive: true })
  const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  let linked = true
  try { lstatSync(join(home, 'auth.json')) } catch { linked = false } // a link left dangling by a sign-out is still there
  if (!linked && (!WIN || existsSync(auth))) linkFile(auth, join(home, 'auth.json')) // (a symlink to where the sign-in will be: one made later is seen too; Windows' hard link or copy needs the file)
  if (!existsSync(join(home, 'config.toml'))) writeFileSync(join(home, 'config.toml'), '# Agent Hub members: no plugins, skills or MCP servers of the user\n')
  return home
}

/**
 * pi's own folder for one run (PI_CODING_AGENT_DIR): the person's sign-ins linked in (auth.json — a /login made there
 * lands in theirs), their own models (models.json) — or a model endpoint's, written here —, their settings unless the
 * member is isolated, and the run's MCP server (mcp.json: declared to the model directly, with the long timeout the
 * others get). Its sessions stay where the person's are (PI_CODING_AGENT_SESSION_DIR), so a member's session resumes.
 * → the run's environment for it
 */
export function piHomeIn(dir, { mcp = null, models = null, isolated = false } = {}) {
  const own = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // (a link to where the sign-ins will be: one made later is seen too; Windows' hard link or copy needs the file)
  if (!WIN || existsSync(join(own, 'auth.json'))) linkFile(join(own, 'auth.json'), join(dir, 'auth.json'))
  if (models) writeFileSync(join(dir, 'models.json'), JSON.stringify(models, null, 2), { mode: 0o600 })
  else if (existsSync(join(own, 'models.json'))) linkFile(join(own, 'models.json'), join(dir, 'models.json'))
  if (!isolated && existsSync(join(own, 'settings.json'))) linkFile(join(own, 'settings.json'), join(dir, 'settings.json'))
  const servers = [mcp].flat().filter(Boolean)
  if (servers.length) {
    const entry = m => ({ command: m.command, args: m.args || [], env: m.env || {}, exposure: 'direct', timeout: MCP_TOOL_TIMEOUT_MS / 1000 })
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(servers.map(m => [m.name, entry(m)])) }, null, 2), { mode: 0o600 })
  }
  return { PI_CODING_AGENT_DIR: dir, PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR || join(own, 'sessions') }
}

// codexHome: an isolated Codex member's own home (the sign-in linked in, none of the user's plugins or config)
export function runCli(runtime, { bin, cwd, args, input, signal, logFile, onLine, codexHome, env: extra }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extra, ...(runtime === 'codex' && codexHome && { CODEX_HOME: codexHome }) }
    if (runtime === 'claude' && !env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS)
    // Nested Claude Code refuses to start when it thinks it is inside another session.
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT
    // its own process group (on Windows its process tree): stopping the task stops what the CLI started too (tests, dev
    // servers, MCP servers)
    const [cmd, argv] = launch(bin, args)
    const child = spawn(cmd, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !WIN, windowsHide: true })
    const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null // a resumed or retried task appends
    let stderr = ''
    const state = {}
    const signalAll = sig => stopTree(child, sig)
    const kill = () => {
      signalAll('SIGTERM')
      setTimeout(() => child.exitCode === null && child.signalCode === null && signalAll('SIGKILL'), 5000).unref()
    }
    signal?.addEventListener('abort', kill, { once: true })
    if (signal?.aborted) kill() // stopped while the task was still getting ready (skills, sandbox probe)
    // ponytail: a fixed ceiling for a hung CLI (network, MCP server); the workbench sets its own, shorter one
    const ceiling = setTimeout(() => { stderr = `${stderr}\nstopped after ${CLI_LIMIT_MS / 3600e3} h without finishing`.slice(-4000); kill() }, CLI_LIMIT_MS)
    ceiling.unref()
    // ENOENT is also what a missing working directory gives: say which one it is
    child.on('error', err => reject(err.code === 'ENOENT' ? new Error(cwd && !existsSync(cwd) ? `the working directory ${cwd} does not exist` : `${runtime} CLI not found (${bin})`) : err))
    child.stdin.on('error', () => { /* the CLI may exit before reading everything */ })
    child.stdin.end(input)
    createInterface({ input: child.stdout }).on('line', line => {
      log?.write(line + '\n')
      if (line.trim()) onLine(parseLine(runtime, line, state))
    })
    child.stderr.on('data', chunk => {
      log?.write(chunk)
      stderr = (stderr + chunk).slice(-4000)
    })
    child.on('close', code => {
      clearTimeout(ceiling)
      signal?.removeEventListener('abort', kill)
      log?.end()
      resolve({ code, stderr: stderr.replace(/Reading additional input from stdin\.\.\.\s*/g, '').trim() })
    })
  })
}
