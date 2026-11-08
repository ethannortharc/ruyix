// Host half of Agent Hub:
// 1. Session projections — `agentActivity` (what each agent is doing) and `agentReport`
//    (a Lead's last full reply);
// 2. a local SQLite store (store.js) the Web panel delta-syncs from;
// 3. the agent pool: agents are runtimes (dsh / Claude Code / Codex) with a model, effort and skills; the work
//    — its role, the access it needs — comes with each task. A job gets a fresh Lead session (the default agent)
//    that assigns tasks to pool agents (each a fresh run); the Lead's final reply goes back to whoever started it.
//    A service (the workbench) runs a headless job and assigns its steps' tasks itself;
// 4. shareable agent files (.agents.json); old team files are read, their members joining the pool.
import { agentTools } from './agent-tools.js'
import { MINE, minePack, skillTools } from './skill-tools.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PACKAGES, createInstaller, newer } from './install.js'
import { createLogin } from './login.js'
import { KEYS as KEY_LOGINS, createKeys } from './keys.js'
import { PICKED_MAX, RUNTIME_APIS, createEndpoints, endpointLaunch, modelsToKeep, providersFromEndpoints } from './endpoints.js'
import { ACCESS, CLI, EFFORTS, READ_ONLY_DENY, RUNTIMES, cliCommand, codexHomeIn, codexSandboxError, codexSandboxHelp, mcpViaEnvFile, piHomeIn, runCli, runtimeStatus, which, FALLBACK_ON } from './runtimes.js'
import { linkDir } from './platform.js'
import { openStore } from './store.js'
import { createSessions, sessionTools, transcript } from './sessions.js'
import { createMirrors, serveSessions, sessionsSockPath } from './mirror.js'
import { createTaskFeed } from './task-feed.js'
import { taskTools } from './task-tools.js'
import { createRequire } from 'node:module'
import { dirname as dirOf } from 'node:path'
import { createSkills } from './skills.js'

export { openStore }
export const inject = ['sessionController', 'sessionProjections', 'sessions', 'connection', 'agents', 'subagents', 'llm']

// Projection keys the panel renders; everything else stays in dsh.
export const KEYS = ['agentActivity', 'sessionStats', 'tokenUsage', 'contextPressure', 'modelSelection', 'title', 'turnOutline', 'inbox']
const RECENT = 6
/** An error the panel can show in its own language: `code` + `params` pick a dictionary entry; `message` stays English for agents and logs. */
const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
// the runtimes a conversation can run on (its tools come over MCP; pi takes none — dsh's own runs in its session)
const CHAT_RUNTIMES = ['claude', 'codex', 'pi']
const say = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

// ── agentActivity projection ────────────────────────────────────────────────
const TARGET_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'target', 'name', 'subject', 'task_id', 'description', 'prompt']
export function toolTarget(args) {
  let parsed
  try { parsed = JSON.parse(args) } catch { return '' }
  if (!parsed || typeof parsed !== 'object') return ''
  for (const key of TARGET_KEYS) {
    if (typeof parsed[key] === 'string' && parsed[key].trim()) return say(parsed[key], 90)
  }
  return ''
}

const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text').map(block => block.text).join(' ')

const EMPTY = { phase: 'idle', turn: 0, step: 0, turnStartedAt: null, tools: [], recent: [], toolCount: 0, said: '', lastEnd: null }

/** Pure fold of durable Session events into the agent's current working state. */
export function applyActivity(state, event) {
  const d = event.data
  switch (event.type) {
    case 'turn/start':
      return { ...EMPTY, phase: 'thinking', turn: d.turn, turnStartedAt: event.time, lastEnd: state.lastEnd }
    case 'step/start':
      return { ...state, phase: state.tools.length ? 'tool' : 'thinking', step: d.step }
    case 'tool/call':
      return {
        ...state,
        phase: 'tool',
        toolCount: state.toolCount + 1,
        tools: [...state.tools, { callId: d.callId, name: d.name, target: toolTarget(d.arguments), at: event.time }],
      }
    case 'tool/result': {
      const callId = d.message?.toolCallId ?? d.message?.source?.callId
      const call = state.tools.find(t => t.callId === callId)
      if (!call) return state
      const tools = state.tools.filter(t => t !== call)
      const done = { name: call.name, target: call.target, ms: Math.max(0, event.time - call.at), ok: !d.message.isError, at: event.time }
      return { ...state, phase: tools.length ? 'tool' : 'thinking', tools, recent: [...state.recent, done].slice(-RECENT) }
    }
    case 'assistant/message': {
      const said = say(textOf(d.message?.content), 160)
      return said && said !== state.said ? { ...state, said, saidAt: event.time } : state
    }
    case 'turn/end': {
      const r = d.reason || {}
      return {
        ...state,
        phase: 'idle',
        tools: [],
        // No `error: undefined`: projection values travel to the browser as strict JSON, and an undefined
        // field makes dsh refuse to resume the session ("argument 0 is not lossless JSON data").
        lastEnd: { kind: r.kind || 'completed', at: event.time, ...(r.kind === 'error' && { error: say(r.error?.message, 160) }) },
      }
    }
    default:
      return state
  }
}

// The registry only needs `.parse`; the fold above is the sole writer of this shape.
const activitySchema = {
  parse(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.tools) || !Array.isArray(value.recent)) {
      throw new Error('invalid agentActivity state')
    }
    return value
  },
}

export const activityProjection = {
  key: 'agentActivity',
  stateVersion: 1,
  stateSchema: activitySchema,
  init: () => EMPTY,
  apply: applyActivity,
  wire: { viewSchema: activitySchema, view: state => state },
}


/** The Lead's last full reply: a job's deliverable. Folded like agentActivity, read once when the job settles. */
const reportSchema = {
  parse(value) {
    if (!value || typeof value !== 'object' || typeof value.text !== 'string') throw new Error('invalid agentReport state')
    return value
  },
}
export const reportProjection = {
  key: 'agentReport',
  stateVersion: 1,
  stateSchema: reportSchema,
  init: () => ({ text: '' }),
  apply(state, event) {
    if (event.type !== 'assistant/message') return state
    const text = (Array.isArray(event.data.message?.content) ? event.data.message.content : [])
      .filter(block => block?.type === 'text').map(block => block.text).join('\n').trim()
    return text ? { text: text.slice(0, 40000) } : state
  },
  wire: { viewSchema: reportSchema, view: state => state },
}

// ── agents: the pool every job draws on; one shareable format for files and the configuration ──
export const AGENTS_KIND = 'dsh-agents'
export const TEAM_KIND = 'dsh-agent-team' // the old team files: still read (their members join the pool), no longer written
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CLI_MODEL = /^[\w.:@/[\]-]{1,100}$/
// a skill: "<pack>/<skill>" (a versioned skill pack, portable) or a bare folder name (looked up where this machine has it)
const SKILL = /^(?:[a-z0-9][a-z0-9-]{1,40}\/)?[\w.-]{1,64}$/

/** "provider/model" or {provider, model} → {provider, model}; the model id may itself contain "/". */
export function parseModel(value) {
  if (!value) return null
  if (typeof value === 'object') return value.provider && value.model ? { provider: String(value.provider), model: String(value.model) } : null
  const text = String(value).trim()
  const cut = text.indexOf('/')
  if (cut <= 0 || cut === text.length - 1) throw fail('modelFormat', { model: text }, `model "${text}" must look like provider/model`)
  return { provider: text.slice(0, cut), model: text.slice(cut + 1) }
}
const modelText = m => (m ? `${m.provider}/${m.model}` : null)

/** What runs: the runtime, its model and effort (an agent's, or an old team member's). */
export function runtimeFields(name, m) {
  const runtime = m.runtime || 'dsh'
  if (!RUNTIMES.includes(runtime)) throw fail('badRuntime', { name }, `"${name}": runtime must be one of ${RUNTIMES.join(', ')}`)
  let model = null
  if (runtime === 'dsh') model = modelText(parseModel(m.model))
  else if (m.model) {
    model = String(m.model).trim()
    if (!CLI_MODEL.test(model)) throw fail('badModel', { name, model }, `"${name}": invalid model "${model}"`)
  }
  const effort = m.effort ? String(m.effort).trim() : null
  if (effort && !EFFORTS[runtime]?.includes(effort)) {
    throw fail(EFFORTS[runtime] ? 'badEffort' : 'effortRuntime', { name, levels: EFFORTS[runtime]?.join(', ') },
      `"${name}": ${EFFORTS[runtime] ? `effort must be one of ${EFFORTS[runtime].join(', ')}` : 'effort applies to the CLI runtimes only'}`)
  }
  return { runtime, model, effort }
}

/**
 * An agent of the pool: a runtime and its model, with the skills it always has. What it does — the role, the access
 * the work needs — comes with each task; `access` is set only when this agent must always run so (Codex, whose
 * read-only sandbox blocks MCP tools or cannot start here: "full").
 */
export function normalizeAgent(def) {
  if (!def || typeof def !== 'object') throw fail('notObject', {}, 'an agent must be a JSON object')
  const id = String(def.id || '').trim().toLowerCase()
  if (!NAME.test(id) || id.length > 40 || id === 'lead') throw fail('badAgentId', { id }, `invalid agent id "${id}": lowercase letters, digits and dashes`)
  const skills = [...new Set((Array.isArray(def.skills) ? def.skills : []).map(s => String(s).trim()).filter(Boolean))]
  if (skills.length > 10 || skills.some(s => !SKILL.test(s))) throw fail('badSkills', { name: id }, `"${id}": up to 10 skills, as pack/skill or a folder name`)
  const access = def.access ? String(def.access) : null
  if (access && !ACCESS.includes(access)) throw fail('badAccess', { name: id }, `"${id}": access must be one of ${ACCESS.join(', ')}`)
  // a model endpoint (endpoints.js) in place of the runtime's own sign-in: a CLI runtime's, with a model of it
  const endpoint = def.endpoint ? String(def.endpoint).trim().toLowerCase() : null
  if (endpoint && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(endpoint)) throw fail('badEndpointId', { id: endpoint }, `"${id}": invalid endpoint "${endpoint}"`)
  const fields = runtimeFields(id, def)
  if (endpoint && !RUNTIME_APIS[fields.runtime]?.length) throw fail('endpointRuntime', { runtime: fields.runtime }, `"${id}": ${fields.runtime} runs its own models — a model endpoint is for pi, Claude Code or Codex`)
  if (endpoint && !fields.model) throw fail('endpointModel', { endpoint }, `"${id}": pick a model of the endpoint "${endpoint}"`)
  // browser: the agents' browser (shared, the person's logins in it) — on unless set off
  return { id, name: String(def.name || id).trim().slice(0, 60) || id, ...fields, ...(endpoint && { endpoint }), access, skills, notes: String(def.notes || '').trim().slice(0, 500), ...(def.browser === false && { browser: false }) }
}

/** A readable id for an agent of this runtime and model: opus, sonnet, codex, deepseek-v4… */
export function agentIdFor({ runtime, model }) {
  const tail = String(model || '').split('/').pop().replace(/^claude-/, '').replace(/-\d[\w.-]*$/, '')
  const base = runtime === 'codex' ? 'codex' : tail || runtime || 'agent'
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'agent'
}
/** The same agent: what runs, and whether it always runs with full access. */
export const sameAgent = (a, b) => a.runtime === (b.runtime || 'dsh') && (a.model || null) === (b.model || null) && (a.endpoint || null) === (b.endpoint || null) && (a.effort || null) === (b.effort || null) && (a.access === 'full') === (b.access === 'full')

export const exportAgents = (agents, defaultAgent) => ({
  kind: AGENTS_KIND, version: 1, defaultAgent: defaultAgent || null,
  agents: agents.map(({ id, name, runtime, model, effort, access, skills, notes, endpoint, browser }) => ({ id, name, runtime, model, effort, access, skills, notes, ...(endpoint && { endpoint }), ...(browser === false && { browser: false }) })),
})

/** A shared file's skill packs: their git source and the exporter's commit. */
export function sharedPacks(text) {
  const raw = String(text || '').trim()
  try { return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw.replace(/^dsh-(?:team|agents):/, ''), 'base64url').toString('utf8')).skillPacks || [] } catch { return [] }
}

/**
 * Pasted JSON, a share code or a file: an agents file → { agents, defaultAgent }; an old team file → { specs } (each
 * member and its fallback as runtime fields, which join the pool as agents unless the pool has the same already).
 */
export function parseShared(text) {
  const raw = String(text || '').trim()
  if (!raw) throw fail('emptyShare', {}, 'paste an agents file or share code')
  let json = raw
  if (!raw.startsWith('{')) {
    try { json = Buffer.from(raw.replace(/^dsh-(?:team|agents):/, ''), 'base64url').toString('utf8') } catch { throw fail('badShare', {}, 'not a valid share code') }
  }
  let def
  try { def = JSON.parse(json) } catch { throw fail('badJson', {}, 'not valid JSON or a share code') }
  if (def?.kind === AGENTS_KIND) {
    if (!Array.isArray(def.agents)) throw fail('notAgents', {}, 'the file lists no agents')
    return { agents: def.agents.map(normalizeAgent), defaultAgent: def.defaultAgent ? String(def.defaultAgent) : null }
  }
  if (def?.kind === TEAM_KIND || (def && Array.isArray(def.members))) {
    const specs = []
    for (const m of def.members) {
      for (const [who, x] of [[m?.name || 'member', m], [`${m?.name || 'member'} (fallback)`, m?.fallback]]) {
        if (!x?.runtime && x !== m) continue
        specs.push({ ...runtimeFields(who, x || {}), access: x?.access === 'full' ? 'full' : null, skills: x === m ? (m.skills || []) : [] })
      }
    }
    return { specs, leadModel: def.leadModel || null, teamName: String(def.name || '') }
  }
  throw fail('notAgents', { kind: def?.kind }, `not an agents file (kind "${def?.kind}")`)
}

// ── skills: folders with a SKILL.md, project scope first ───────────────────
const skillRoots = cwds => [
  ...[cwds].flat().filter(Boolean).flatMap(cwd => [join(cwd, '.claude', 'skills'), join(cwd, '.dsh', 'skills')]),
  join(homedir(), '.claude', 'skills'), join(homedir(), '.dsh', 'skills'), join(homedir(), '.codex', 'skills'),
]
/** Skills visible from one workspace (or several, for the team editor). */
export async function listSkills(cwds) {
  const found = new Map()
  for (const root of skillRoots(cwds)) {
    let entries = []
    try { entries = await readdir(root, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (found.has(e.name) || !(e.isDirectory() || e.isSymbolicLink())) continue
      const dir = join(root, e.name)
      try {
        const head = (await readFile(join(dir, 'SKILL.md'), 'utf8')).slice(0, 4000)
        const description = head.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '')
        found.set(e.name, { name: e.name, description: say(description, 200), dir })
      } catch { /* not a skill folder */ }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ── prompts ─────────────────────────────────────────────────────────────────
const ACCESS_TEXT = {
  read: 'read-only — inspect and report; do not modify any files',
  write: 'write — you may edit files and run commands inside the workspace',
  full: 'full — unrestricted',
}
const agentLine = a => `- ${a.id}${a.name && a.name !== a.id ? ` "${a.name}"` : ''} (${a.runtime}${a.model ? ` · ${a.model}` : ''}${a.effort ? ` @ ${a.effort}` : ''}` +
  `${a.access ? ` · always ${a.access} access` : ''}${a.skills.length ? ` · skills: ${a.skills.join(', ')}` : ''})${a.notes ? `: ${a.notes}` : ''}`
const poolText = agents => `Agents you can assign work to:\n${agents.map(agentLine).join('\n') || '(none — the user adds agents on the Agents page)'}`
const leadText = (job, agents) => `You are the Lead of one job.\n\n## Job\n${job.goal}\n\n## ${poolText(agents)}\n\n## How to work\n` +
  'Delegate with assign_task: one agent, one self-contained task, with the role it plays in it ("reviewer", "tester"…) and the access the work needs ' +
  '("read" to inspect and report, "write" to change files). Agents do not see this conversation, so include paths, context and acceptance criteria. ' +
  'Tasks with different roles run in parallel; tasks of one role run one at a time. ' +
  'To chain work, pass `after` (task ids): the task waits for them and receives their reports automatically. ' +
  'Call wait_tasks to wait for reports, or end your turn: finished reports are delivered to you automatically. job_status shows progress; cancel_task stops a task.\n\n' +
  'Plan the work, assign it, wait for the reports and review them. End with your final report as your last message: it is the job\'s deliverable and goes back to whoever started the job.'

function taskInstructions(job, m, skills, history) {
  return [
    `You are "${m.name}". ${job.headless ? 'The service running this job' : 'A Lead agent coordinates the current job and'} assigns you tasks; ` +
      'you do not see its conversation, so everything you need is in the task.',
    m.role && `Your role: ${m.role}`,
    `Workspace: ${job.cwd}`,
    `Access: ${ACCESS_TEXT[m.access]}`,
    `When you finish, reply with a concise, self-contained report for ${job.headless ? 'the service' : 'the Lead'}: what you did, key findings, files changed, open issues.`,
    skills.length ? `## Your skills\n${skills.map(s => `- ${s.name} (${s.ref}${s.version ? ` @ ${s.version}` : ''}): ${s.description || ''} — files in ${s.dir}`).join('\n')}${skills.some(s => s.body) ? '' : '\nThey are loaded as skills of this session: use them when a task needs them.'}` : '',
    ...skills.filter(s => s.body).map(s => `## Skill: ${s.name}\n\n${s.body}`),
    history.length ? `## Your earlier work in this job\n${history.map(t => `- ${t.title} [${t.status}]: ${say(t.output || t.error, 600)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

/** A session's standing instructions (sessions.js): a conversation that goes on, a message at a time. */
function sessionInstructions(d, m, skills) {
  return [
    `You are "${m.name}", a session of Ruyix's agent pool: one conversation that goes on. The person, or Ruyix's main agent ` +
      'on their behalf, writes to you a message at a time; what you did earlier in this conversation is still yours to build on.',
    m.role && `Your role: ${m.role}`,
    `Folder: ${d.cwd}`,
    `Access: ${ACCESS_TEXT[m.access]}`,
    'Answer each message with what you did and what is still open, short. When a message is unclear, ask back instead of guessing.',
    skillsText(skills),
  ].filter(Boolean).join('\n\n')
}
/** A session's skills as its instructions say them (their text too, for a CLI that does not load them itself). */
const skillsText = skills => [
  skills.length ? `## Your skills\n${skills.map(s => `- ${s.name} (${s.ref}${s.version ? ` @ ${s.version}` : ''}): ${s.description || ''} — files in ${s.dir}`).join('\n')}` : '',
  ...skills.filter(s => s.body).map(s => `## Skill: ${s.name}\n\n${s.body}`),
].filter(Boolean).join('\n\n')

const DONE = new Set(['done', 'failed', 'cancelled'])
// dsh's own Agent Teams tools: a Lead would otherwise juggle two ways of delegating.
const NATIVE_TEAM_TOOLS = ['spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']
const ago = ms => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`)
const who = t => (t.agent && t.member !== t.agent ? `${t.member} (${t.agent})` : t.member)
const resultText = (t, max = 12000) => [
  `### ${t.id} · ${who(t)} · ${t.status}`,
  `Task: ${t.title}`,
  t.error && `Error: ${t.error}`,
  t.output && `Report:\n${t.output.length > max ? `${t.output.slice(0, max)}\n…(truncated)` : t.output}`,
].filter(Boolean).join('\n')
const briefText = t => `- ${t.id} · ${who(t)} · ${t.status}${t.after?.length ? ` (after ${t.after.join(', ')})` : ''}` +
  (t.startedAt ? ` · ${ago((t.endedAt || Date.now()) - t.startedAt)}` : '') + ` · ${t.title}` +
  (DONE.has(t.status) && (t.output || t.error) ? `\n  → ${say(t.error || t.output, 300)}` : '')
const jobText = j => `[agent job] ${j.status === 'done' ? 'finished' : j.status} job ${j.id}.\nJob: ${j.title}\n\n` + (j.report || j.error || '(the Lead left no report)')

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const textResult = { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value.text }] }
const byCreated = (a, b) => a.createdAt - b.createdAt
const shortId = prefix => `${prefix}${randomUUID().slice(0, 7)}`
// What `codex exec` uses when an agent names no model.
const codexModel = () => readFile(join(homedir(), '.codex', 'config.toml'), 'utf8').then(s => s.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null, () => null)

// ── plugin ──────────────────────────────────────────────────────────────────
export function apply(ctx, _config, store = openStore()) {
  // versioned skill packs (skills.js): what a member's skills are, on any machine, and which version a task used
  const skillPacks = createSkills({ home: store.dir, log: text => ctx.logger?.info?.(`agent-hub: ${text}`) })
  // the person's own skills (skill-tools.js): the pack "mine", told again with its new version after each change
  const mine = minePack(store.dir)
  let unMine = () => {}
  const registerMine = () => { unMine(); unMine = skillPacks.register({ id: MINE, title: '我的技能 · My skills', dir: mine.dir, version: mine.version(), by: 'the person' }) }
  registerMine()
  ctx.effect?.(() => () => unMine(), 'agent-hub: my skills')
  const skillUses = new Set() // other plugins' registerSkillUses
  /** A one-session Claude Code plugin holding these skills (links to their pack snapshots), under the hub's own tmp. */
  const skillPlugin = list => {
    mkdirSync(join(store.dir, 'tmp'), { recursive: true })
    const dir = mkdtempSync(join(store.dir, 'tmp', 'skills-'))
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'team-skills', version: '1.0.0', description: 'The skills Agent Hub hands this task', author: { name: 'Agent Hub' } }))
    mkdirSync(join(dir, 'skills'))
    const seen = new Set()
    for (const s of list) if (!seen.has(s.name)) { seen.add(s.name); linkDir(s.dir, join(dir, 'skills', s.name)) }
    return dir
  }
  const sc = ctx.sessionController
  const cleanup = []
  ctx.effect(() => ctx.sessionProjections.register(activityProjection), 'agent-hub: activity projection')
  ctx.effect(() => ctx.sessionProjections.register(reportProjection), 'agent-hub: report projection')
  ctx.effect(() => () => { for (const fn of cleanup) fn(); store.close() }, 'agent-hub: store and runs')

  // ── session mirror ──
  const fromSession = (row, session) => {
    row.cwd ??= session.header?.cwd ?? null
    row.created_at ??= session.header?.createdAt ?? null
  }
  // Rows left "running" by a previous Host process belong to turns that will never end.
  for (const id of store.running()) {
    if (ctx.agents.get(id)?.status === 'running') continue
    store.touch(id, row => {
      row.running = 0
      const act = row.data.agentActivity
      if (act && act.phase !== 'idle') row.data.agentActivity = { ...act, phase: 'idle', tools: [], lastEnd: { kind: 'interrupted', at: Date.now() } }
    }, { bump: false })
  }
  for (const session of ctx.sessions.list()) {
    try {
      const { values } = ctx.sessionProjections.snapshot(session, KEYS)
      store.touch(session.id, row => {
        fromSession(row, session)
        Object.assign(row.data, values)
        row.running = ctx.agents.get(session.id)?.status === 'running' ? 1 : 0
      }, { bump: false })
    } catch { /* a session that cannot fold yet is picked up by its next change */ }
  }

  // ── documents ──
  const agent = id => { const a = store.getDoc('agent', String(id || '')); return a && !a.deleted ? a : undefined }
  const agents = () => store.docs('agent').filter(a => !a.deleted).sort((a, b) => a.createdAt - b.createdAt)
  const config = () => store.getDoc('config', 'hub') || { id: 'hub' }
  const setConfig = patch => store.putDoc('config', { ...config(), ...patch })
  /** The agent that leads ad-hoc jobs and answers for this hub (a dsh agent: it runs inside dsh); none = dsh's default model. */
  const defaultAgent = () => { const a = agent(config().defaultAgent); return a?.runtime === 'dsh' ? a : undefined }
  /**
   * The main agent: any agent of the pool (dsh, Claude Code, Codex, pi) — the one Ruyix hands what the person asks (the
   * chat, ⌘K, voice) unless a conversation picks another for itself. None chosen: the default agent.
   */
  const mainAgent = () => agent(config().mainAgent) || defaultAgent()
  /**
   * The main model ("provider/model", a dsh model): Ruyix's own small jobs — a conversation's title, summaries and
   * memories, tidying spoken text. Unset: it follows the main agent (its model when it runs inside dsh; a CLI agent's
   * model is its CLI's, so then the default agent's); '' — dsh's default model.
   */
  const mainModel = () => config().mainModel || (mainAgent()?.runtime === 'dsh' ? mainAgent().model : '') || defaultAgent()?.model || ''
  const agentUses = new Set() // other plugins' registerAgentUses: fn → [{ agent, by, where: { en, zh } }]
  const usesOf = async () => {
    const out = []
    for (const fn of agentUses) for (const u of (await Promise.resolve().then(fn).catch(() => [])) || []) out.push(u)
    return out
  }
  // Old teams stay (read-only) for the tasks and jobs that name them; their members joined the pool (migrate below).
  const team = id => store.getDoc('team', id)
  const job = id => store.getDoc('job', id)
  const tasksOf = jobId => store.docs('task', jobId).sort(byCreated)
  const leads = new Map(store.docs('job').map(j => [j.leadId, j.id])) // Lead session id → job id
  const reports = new Map() // Lead session id → its latest full reply

  /** Add an agent (the id taken when free, else a free variant of it); it is stored as given, checked by normalizeAgent. */
  const addAgent = def => {
    let id = String(def.id || agentIdFor(def))
    const taken = x => !!store.getDoc('agent', x) && !store.getDoc('agent', x).deleted
    if (taken(id)) { const base = `${id}-${def.effort || 'alt'}`.slice(0, 38); id = base; for (let n = 2; taken(id); n++) id = `${base}-${n}` }
    return store.putDoc('agent', { ...normalizeAgent({ ...def, id }), createdAt: Date.now() })
  }
  /** The pool's agent that runs like this (runtime, model, effort, full access or not), added when there is none. */
  const adoptAgent = spec => agents().find(a => sameAgent(a, spec)) || addAgent({
    id: agentIdFor(spec), name: '', runtime: spec.runtime, model: spec.model, effort: spec.effort, access: spec.access === 'full' ? 'full' : null, skills: [],
  })
  // Once: every old team's members (and their fallbacks) join the pool; a Lead model becomes the default agent.
  if (!config().migrated) {
    for (const t of store.docs('team').filter(x => !x.deleted)) {
      for (const m of t.members || []) {
        try { adoptAgent(m); if (m.fallback?.runtime) adoptAgent(m.fallback) } catch (err) { ctx.logger?.warn?.(`agent-hub: ${t.name}/${m.name}: ${err?.message || err}`) }
      }
      if (t.leadModel && !config().defaultAgent) { try { setConfig({ defaultAgent: adoptAgent({ runtime: 'dsh', model: t.leadModel }).id }) } catch { /* not a model this dsh has */ } }
    }
    setConfig({ migrated: Date.now() })
  }

  const childTask = new Map() // dsh member run session id → its live task
  ctx.effect(() => ctx.sessionProjections.onChanged((session, key, value) => {
    if (key === 'agentReport') { if (leads.has(session.id)) reports.set(session.id, value?.text || ''); return }
    const t = childTask.get(session.id)
    if (t) {
      // A dsh member's own session drives its task card, like the CLI parsers do for theirs.
      if (key === 'agentActivity') t.act = value
      if (key === 'tokenUsage' && value) {
        t.tokens = value.uncachedInputTokens + value.cacheReadTokens + value.cacheWriteTokens + value.outputTokens
        t.usage = { input_tokens: value.uncachedInputTokens, output_tokens: value.outputTokens, cache_read_tokens: value.cacheReadTokens, cache_write_tokens: value.cacheWriteTokens }
      }
      saveSoon(t)
      return
    }
    if (!KEYS.includes(key)) return
    store.touch(session.id, row => {
      fromSession(row, session)
      row.data[key] = value
    })
  }), 'agent-hub: projection mirror')
  ctx.on('agent/status', ({ agent, status }) => {
    store.touch(agent.id, row => { row.running = status === 'running' ? 1 : 0 })
    const jobId = leads.get(agent.id)
    if (!jobId) return
    // A job runs while its Lead works; it settles once the Lead and every member are quiet.
    if (status === 'running') {
      clearTimeout(settleTimers.get(jobId))
      const j = job(jobId)
      // a job taken up again (the Lead messaged after a restart) carries on with the member work still queued
      if (j && j.status !== 'running') { store.putDoc('job', { ...j, status: 'running', endedAt: null, delivered: false }); pump(jobId) }
    } else settleSoon(jobId)
  })

  let catalog = null
  const models = async () => {
    // The catalog asks every provider; cache it rather than pay seconds per panel open.
    if (!catalog || Date.now() - catalog.at > 300000) {
      const c = await sc.modelCatalog()
      catalog = { at: Date.now(), models: c.groups.flatMap(g => g.models.map(m => ({ provider: g.id, model: m.id, label: `${g.name} / ${m.name}` }))) }
    }
    return catalog.models
  }
  const unknownModel = async wanted => {
    const known = new Set((await models()).map(m => `${m.provider}/${m.model}`))
    const bad = wanted.find(([, model]) => !known.has(model))
    if (bad) throw fail(bad[0] ? 'unknownModel' : 'unknownLeadModel', { name: bad[0], model: bad[1], available: [...known].join(', ') },
      `${bad[0] ? `"${bad[0]}"` : 'the Lead'}: unknown dsh model "${bad[1]}" (available: ${[...known].join(', ')})`)
  }
  const checkCodexSandbox = async list => {
    const sandboxed = list.filter(m => m.runtime === 'codex' && m.access !== 'full')
    const reason = sandboxed.length && await codexSandboxError()
    if (reason) {
      throw fail('codexSandbox', { names: sandboxed.map(m => m.name || m.id).join(', '), reason },
        `${sandboxed.map(m => `"${m.name || m.id}"`).join(', ')}: ${codexSandboxHelp(reason)}`)
    }
  }
  /**
   * Everything that would stop these agents running here — an unknown model, a missing CLI, Codex without its sandbox
   * (unless the agent always runs with full access), a skill pack that is gone — checked before a job creates
   * anything. `ids`: the agents a job will use (a workflow's steps and their fallbacks).
   */
  const checkAgents = async (ids, { cwd } = {}) => {
    const list = [...new Set(ids.filter(Boolean))].map(id => agent(id) || (() => { throw fail('noAgent', { id }, `no agent "${id}" in the agent pool (the Agents page)`) })())
    await unknownModel(list.filter(a => a.runtime === 'dsh' && a.model).map(a => [a.id, a.model]))
    const missing = list.filter(a => a.runtime !== 'dsh' && !which(a.runtime))
    if (missing.length) {
      throw fail('cliMissing', { names: missing.map(a => `${a.id} (${a.runtime})`).join(', ') },
        missing.map(a => `agent "${a.id}": the ${a.runtime} CLI is not installed`).join('; '))
    }
    await checkCodexSandbox(list)
    for (const a of list) endpointOf(a) // its model endpoint there, and one its runtime can use
    // a "pack/skill" must resolve here (a bare name that does not — a local skill while local skills are off — is a
    // warning on the task: the agent runs without it)
    const refs = [...new Set(list.flatMap(a => a.skills).filter(s => s.includes('/')))]
    const gone = (await skillPacks.resolve(refs, cwd)).filter(s => s.missing)
    if (gone.length) throw fail('skillMissing', { list: gone.map(s => s.ref).join(', ') }, `skills not available here: ${gone.map(s => `${s.ref}${s.error ? ` (${s.error})` : ''}`).join('; ')} — add or fetch the pack under Skills`)
  }

  const live = id => ctx.agents.get(id)
  const liveAgent = async id => {
    const agent = live(id)
    if (agent) return agent
    const resolved = await sc.resolveAgent(id)
    if (resolved.error) throw resolved.error
    return resolved.agent
  }
  const text = value => {
    const t = String(value || '').trim()
    if (!t) throw fail('emptyMessage', {}, 'message is empty')
    return [{ type: 'text', text: t }]
  }
  const tell = (sessionId, body) => sc.prompt({
    requestId: randomUUID(), sessionId, mode: live(sessionId)?.status === 'running' ? 'steer' : 'queue', content: [{ type: 'text', text: body }],
  }, AbortSignal.timeout(60000))

  // ── waiting: tasks and jobs share one deferred table ──
  const finished = new Map() // "kind:id" → { promise, resolve }
  const whenDone = (kind, id) => {
    if (DONE.has(store.getDoc(kind, id)?.status)) return Promise.resolve()
    const key = `${kind}:${id}`
    if (!finished.has(key)) {
      let done
      const promise = new Promise(r => { done = r })
      finished.set(key, { promise, resolve: done })
    }
    return finished.get(key).promise
  }
  const settle = (kind, id) => { finished.get(`${kind}:${id}`)?.resolve(); finished.delete(`${kind}:${id}`) }
  const awaited = new Map() // "kind:id" → active wait calls covering it; their results go back through the wait
  const waitFor = async (kind, ids, limit, signal) => {
    const keys = ids.map(id => `${kind}:${id}`)
    let timer
    for (const key of keys) awaited.set(key, (awaited.get(key) || 0) + 1)
    try {
      await Promise.race([
        Promise.all(ids.map(id => whenDone(kind, id))),
        new Promise(r => { timer = setTimeout(r, Math.min(Math.max(Number(limit) || 900, 10), 3600) * 1000) }),
        new Promise(r => signal?.addEventListener('abort', r, { once: true })),
      ])
    } finally {
      clearTimeout(timer)
      for (const key of keys) awaited.get(key) > 1 ? awaited.set(key, awaited.get(key) - 1) : awaited.delete(key)
    }
    return ids.map(id => store.getDoc(kind, id))
  }

  // ── member task runtime ──
  const runDir = join(store.dir, 'runs')
  mkdirSync(runDir, { recursive: true })
  // retention, once per start: CLI run logs for two weeks; jobs (with their tasks) for 90 days after they ended
  for (const f of readdirSync(runDir)) { const p = join(runDir, f); try { if (Date.now() - statSync(p).mtimeMs > 14 * 864e5) rmSync(p) } catch { /* in use or gone */ } }
  try { const n = store.prune(Date.now() - 90 * 864e5); if (n) ctx.logger?.info?.(`agent-hub: pruned ${n} job(s) older than 90 days`) } catch (err) { ctx.logger?.warn?.(`agent-hub: prune: ${err?.message || err}`) }
  const runs = new Map() // task id → { t, controller }
  const saving = new Map()
  const save = t => {
    if (disposed) return // a CLI line after SIGTERM: the db is closed
    clearTimeout(saving.get(t.id))
    saving.delete(t.id)
    return store.putDoc('task', t)
  }
  // Activity lands many times a second; the panel only needs it about once a second.
  const saveSoon = t => { if (!disposed && !saving.has(t.id)) saving.set(t.id, setTimeout(() => save(t), 700)) }
  let disposed = false
  cleanup.push(() => {
    disposed = true
    for (const timer of [...saving.values(), ...reportTimers.values(), ...settleTimers.values()]) clearTimeout(timer)
    for (const { t, controller } of runs.values()) {
      controller.abort()
      store.putDoc('task', { ...t, status: 'failed', error: 'interrupted: the hub was reloaded', errorCode: 'interruptedReload', endedAt: Date.now(), reported: true })
    }
    // whoever waits (the workbench's whenTaskDone, a Lead's wait_tasks) hears now, not at its timeout
    for (const { resolve } of finished.values()) resolve()
    finished.clear()
  })

  // Per-task extras from service callers (e.g. an MCP server with a run token): memory only, never stored or synced.
  const taskExtras = new Map()
  const ROLE = /^[\w .:/-]{1,40}$/
  /**
   * A task for one pool agent: `role` names what it does here (its lane on the board: one task of a role runs at a time),
   * `instructions` say how (a workflow step's role text), `access` what the work may change (the agent's own "full"
   * wins), `fallback` the agent that takes over when this one's provider refuses or cannot serve it.
   */
  const assign = (jobId, { agent: ref, fallback, role, instructions, access, task, title, after }, by, extra) => {
    const j = job(jobId)
    if (!j) throw fail('noJob', { id: jobId }, `no job ${jobId}`)
    const a = agent(ref)
    if (!a) throw fail('noAgent', { id: ref, agents: agents().map(x => x.id).join(', ') }, `no agent "${ref}" (agents: ${agents().map(x => x.id).join(', ') || 'none'})`)
    const fb = fallback ? agent(fallback) : null
    if (fallback && !fb) throw fail('noAgent', { id: fallback, agents: agents().map(x => x.id).join(', ') }, `no fallback agent "${fallback}"`)
    const lane = String(role || a.id).trim().slice(0, 40)
    if (!ROLE.test(lane)) throw fail('badRole', { role: lane }, 'the role is a short name: letters, digits, spaces, - _ . : /')
    const need = access || 'write'
    if (!ACCESS.includes(need)) throw fail('badAccess', { name: a.id }, `access must be one of ${ACCESS.join(', ')}`)
    const body = String(task || '').trim()
    if (!body) throw fail('emptyTask', {}, 'the task is empty')
    const deps = [...new Set((Array.isArray(after) ? after : after ? [after] : []).map(id => String(id).trim()).filter(Boolean))]
    for (const id of deps) if (store.getDoc('task', id)?.jobId !== jobId) throw fail('afterMissing', { id }, `after: no task ${id} in this job`)
    const t = store.putDoc('task', {
      id: shortId('t'), jobId, agent: a.id, member: lane, role: say(instructions, 4000) || null, fallback: fb?.id || null, title: say(title || body, 80), task: body, by, after: deps,
      status: 'queued', runtime: a.runtime, model: a.model, ...(a.endpoint && { endpoint: a.endpoint }), effort: a.effort, access: a.access || need, need, createdAt: Date.now(),
    })
    if (extra) taskExtras.set(t.id, extra)
    // Continuing an interrupted task: its CLI session when it has one (L3), else a fresh run with the caller's handoff (L2).
    if (extra?.resume) store.putDoc('task', { ...store.getDoc('task', t.id), resumeOf: extra.resume.taskId || null, resumedVia: extra.resume.sessionId ? 'session' : 'handoff' })
    pump(jobId)
    return store.getDoc('task', t.id)
  }
  // One run at a time per member within a job, members in parallel, oldest ready task first.
  // A task waits for its `after` tasks; if one of them did not finish, it is cancelled for the Lead to re-plan.
  const pump = jobId => {
    if (disposed) return
    const all = tasksOf(jobId)
    const byId = new Map(all.map(t => [t.id, t]))
    const busy = new Set(all.filter(t => t.status === 'running').map(t => t.member))
    for (const t of all) {
      if (t.status !== 'queued') continue
      const deps = (t.after || []).map(id => byId.get(id)).filter(Boolean)
      const broken = deps.find(d => d.status === 'failed' || d.status === 'cancelled')
      if (broken) {
        store.putDoc('task', {
          ...t, status: 'cancelled', error: `upstream ${broken.id} ${broken.status}`, errorCode: broken.status === 'failed' ? 'upstreamFailed' : 'upstreamCancelled', errorParams: { id: broken.id },
          endedAt: Date.now(), reported: t.by !== 'lead',
        })
        settle('task', t.id)
        if (t.by === 'lead') reportSoon(jobId)
        continue
      }
      if (busy.has(t.member) || deps.some(d => d.status !== 'done')) continue
      busy.add(t.member)
      start(t)
    }
  }
  const start = queued => {
    const t = { ...queued, status: 'running', startedAt: Date.now(), act: applyActivity(EMPTY, { type: 'turn/start', time: Date.now(), data: { turn: 1 } }) }
    save(t)
    const controller = new AbortController()
    runs.set(t.id, { t, controller })
    const stopped = () => (controller.signal.aborted ? 'cancelled' : 'failed')
    execute(t, controller.signal).then(
      r => Object.assign(t, r, { status: r.error ? stopped() : 'done' }),
      err => Object.assign(t, { status: stopped(), error: say(err?.message || String(err), 2000), errorCode: err?.code, errorParams: err?.params }),
    ).then(() => {
      runs.delete(t.id)
      const extras = taskExtras.get(t.id)
      taskExtras.delete(t.id)
      if (disposed) return
      // The session could not be resumed (gone, or it failed): the same task runs fresh with the caller's handoff (L3 → L2).
      if (t.status === 'failed' && t.resumedVia === 'session' && !t.resumeFallback) {
        Object.assign(t, { status: 'queued', resumedVia: 'handoff', resumeFallback: { error: say(t.error, 400) }, error: undefined, output: undefined, startedAt: undefined })
        const { resume, ...rest } = extras || {}
        taskExtras.set(t.id, rest)
        save(t)
        pump(t.jobId)
        return
      }
      // the step's fallback agent (a task queued before the pool: its old team member's fallback)
      const fb = t.fallback ? agent(t.fallback) : t.agent ? null : team(t.teamId)?.members.find(x => x.name === t.member)?.fallback
      if (t.status === 'failed' && fb && !t.fallbackOf && FALLBACK_ON.test(t.error || '')) {
        Object.assign(t, {
          status: 'queued', fallbackOf: { agent: t.agent, runtime: t.runtime, model: t.model, error: say(t.error, 600) }, agent: fb.id || t.agent,
          runtime: fb.runtime, model: fb.model ?? null, ...(fb.endpoint && { endpoint: fb.endpoint }), effort: fb.effort ?? null, access: fb.access === 'full' ? 'full' : t.need || fb.access || t.access,
          error: undefined, output: undefined, startedAt: undefined,
        })
        if (extras) taskExtras.set(t.id, extras)
        save(t)
        pump(t.jobId)
        return
      }
      t.endedAt = Date.now()
      if (t.status === 'cancelled') t.error ||= 'cancelled'
      if (t.error === 'cancelled') t.errorCode = 'cancelled'
      if (t.output) t.output = t.output.trim().slice(0, 40000)
      const kind = t.status === 'done' ? 'completed' : t.status === 'cancelled' ? 'aborted' : 'error'
      t.act = applyActivity({ ...EMPTY, ...t.act }, { type: 'turn/end', time: t.endedAt, data: { reason: { kind, error: { message: t.error } } } })
      if (t.cancelledBy === 'lead' || t.by !== 'lead') t.reported = true
      save(t)
      settle('task', t.id)
      if (!t.reported) reportSoon(t.jobId)
      pump(t.jobId)
      settleSoon(t.jobId)
    })
  }

  const execute = async (t, signal) => {
    const j = job(t.jobId)
    if (!j) throw fail('noJob', { id: t.jobId }, `no job ${t.jobId}`)
    if (t.agent && !agent(t.agent)) throw fail('agentGone', { agent: t.agent }, `agent "${t.agent}" is no longer in the pool`)
    // a task queued before the pool ran as an old team's member: its role and skills are there
    const old = t.agent ? null : team(t.teamId)?.members.find(x => x.name === t.member)
    const m = { id: t.agent, name: t.member, role: t.role ?? old?.role ?? '', runtime: t.runtime, model: t.model, endpoint: t.endpoint || null, effort: t.effort, access: t.access }
    // the agent's own skills, and those the assigner gives it for this task (the workbench: the product's skills for a step)
    const resolved = await skillPacks.resolve([...new Set([...(agent(t.agent)?.skills || old?.skills || []), ...(taskExtras.get(t.id)?.skills || [])])], j.cwd, taskExtras.get(t.id)?.pins)
    t.missingSkills = resolved.filter(s => s.missing).map(s => s.ref)
    const found = resolved.filter(s => !s.missing)
    // which version of each skill this task ran with (a run can be explained, and repeated, later)
    t.skills = found.map(s => ({ ref: s.ref, kind: s.kind, version: s.version }))
    // Claude Code loads them natively (--plugin-dir, this session only); the others get the text in their instructions
    const native = m.runtime === 'claude'
    const skills = await Promise.all(found.map(async s => ({ ...s, body: native ? null : (await readFile(join(s.dir, 'SKILL.md'), 'utf8').catch(() => '')).slice(0, 20000) })))
    const history = tasksOf(t.jobId).filter(x => x.member === m.name && x.id !== t.id && DONE.has(x.status)).slice(-3)
    const instructions = taskInstructions(j, m, skills, history)
    const inputs = (t.after || []).map(id => store.getDoc('task', id)).filter(Boolean)
    const brief = inputs.length
      ? `${t.task}\n\n## Input from the tasks this one builds on\n${inputs.map(x => resultText(x, 8000)).join('\n\n')}`
      : t.task
    // a step's connections (its env: in a box, placeholders) reach a CLI's commands; dsh runs in this process, without them
    const stepEnv = taskExtras.get(t.id)?.env
    if (m.runtime === 'dsh' && stepEnv) throw fail('envNeedsCli', {}, 'this step works with connections: give it an agent that runs a CLI (Claude Code, Codex, pi), not dsh')
    if (m.runtime === 'dsh') { if (taskExtras.get(t.id)?.resume) t.resumedVia = 'handoff'; return runDsh(t, m, j, instructions, brief, signal) }

    const bin = which(m.runtime)
    if (!bin) throw fail('cliNotInstalled', { cli: CLI[m.runtime].name }, `${CLI[m.runtime].name} is not installed (Agents → Runtimes installs it)`)
    await checkCodexSandbox([m])
    const resume = taskExtras.get(t.id)?.resume
    const session = resume?.sessionId && resume.runtime === m.runtime ? resume.sessionId : null
    if (resume && !session) t.resumedVia = 'handoff'
    // local skills off: the member sees only its own skills (below) — none of this machine's or the workspace's
    const isolated = !skillPacks.policy().local
    t.isolated = isolated
    // the MCP server's token rides a 0600 file (in a 0700 dir) for this run, never the CLI's command line; pi's folder, an endpoint
    const ex = taskExtras.get(t.id) || {}
    const browserUse = (j.headless ? ex.browser : true) && browserFor(agent(t.agent), { who: `task:${t.id}`, title: t.title, of: ex.of || (j.headless ? null : `task:${j.id}`), dirs: [j.cwd, ...(ex.dirs || [])] })
    const run = await prepareCli(m, [ex.mcp, browserUse, webFor(agent(t.agent)), !j.headless && systemFor(agent(t.agent), { who: `task:${t.id}`, title: t.title, of: ex.of || `task:${j.id}` })], isolated)
    // the member's skills as a plugin of this session only (Claude Code's --plugin-dir), never installed globally
    const pluginDir = native && skills.length ? skillPlugin(skills) : null
    const { args, input } = cliCommand(m.runtime, { isolated, model: m.model, effort: m.effort, access: m.access, instructions, task: session ? resume.prompt || brief : brief, cwd: j.cwd, mcp: run.mcp, resume: session, pluginDir, web: !!taskExtras.get(t.id)?.web, endpoint: run.endpoint })
    let output = ''
    let error = '', warning = ''
    const runEnv = await runtimeEnv(m.runtime)
    const { code, stderr } = await runCli(m.runtime, {
      bin, cwd: j.cwd, args, input, signal, logFile: join(runDir, `${t.id}.jsonl`), codexHome: isolated ? codexHomeIn(store.dir) : undefined, env: { ...(runEnv || {}), ...(stepEnv || {}), ...run.env },
      onLine(r) {
        for (const e of r.events) t.act = applyActivity(t.act, e)
        if (r.model) t.model = r.model
        if (r.sessionId) t.sessionId = r.sessionId
        if (r.output !== undefined) output = r.output
        if (r.error) error = r.error
        if (r.warning) warning = r.warning
        if (r.tokens) t.tokens = r.tokens
        if (r.usage) t.usage = r.usage
        if (r.cost !== undefined) t.cost = r.cost
        saveSoon(t)
      },
    }).finally(() => { for (const d of [run.dir, pluginDir]) if (d) rmSync(d, { recursive: true, force: true }) })
    if (!error && code !== 0) error = signal.aborted ? 'cancelled' : warning || say(stderr, 2000) || `${m.runtime} exited with code ${code}`
    return { output, error: error || undefined }
  }

  const runDsh = async (t, m, j, instructions, brief, signal) => {
    const parent = await liveAgent(j.leadId)
    const model = parseModel(m.model)
    // restrict() rejects names this profile never registered, so deny only tools that exist:
    // write tools for read-only members, dsh's own team tools for every member.
    let known
    try { known = parent.ctx.tools.view(parent).restrictableNames } catch { /* older registry */ }
    // and dsh's own skill tool when local skills are off: its catalog is this machine's skills (the member's own are in its instructions)
    const wanted = [...(m.access === 'read' ? READ_ONLY_DENY : []), ...NATIVE_TEAM_TOOLS, ...(skillPacks.policy().local ? [] : ['skill'])]
    const deny = known ? wanted.filter(name => known.has(name)) : m.access === 'read' ? ['write', 'edit', 'bash'] : []
    const run = await ctx.subagents.start('spawn', {
      label: `${m.name}: ${t.title}`,
      prompt: [{ type: 'text', text: brief }],
      parent,
      signal,
      persona: instructions,
      ...(model ? { agentOptions: model } : {}),
      ...(deny.length ? { toolFilter: { deny } } : {}),
    })
    t.sessionId = run.id
    childTask.set(run.id, t)
    saveSoon(t)
    try {
      const res = await run.result
      const ok = res.stopReason === 'completed'
      // the model's own error (rate limit, overload…): the fallback decision reads it, "run ended: error" alone matches nothing
      const why = say(res.error?.message || (typeof res.error === 'string' ? res.error : '') || t.act?.lastEnd?.error || '', 600)
      return { output: textOf(res.output), error: ok ? undefined : signal.aborted ? 'cancelled' : `run ended: ${res.stopReason}${why ? ` — ${why}` : ''}` }
    } finally {
      childTask.delete(run.id)
      await run.dispose().catch(() => {})
    }
  }

  const cancel = (id, by) => {
    const t = store.getDoc('task', id)
    if (!t) throw fail('noTask', { id }, `no task ${id}`)
    const running = runs.get(id)
    if (running) {
      running.t.cancelledBy = by
      running.controller.abort()
    } else if (t.status === 'queued') {
      store.putDoc('task', { ...t, status: 'cancelled', error: 'cancelled', errorCode: 'cancelled', endedAt: Date.now(), reported: by === 'lead' || t.by !== 'lead' })
      settle('task', id)
      if (by !== 'lead' && t.by === 'lead') reportSoon(t.jobId)
      pump(t.jobId) // tasks that were waiting for this one
      settleSoon(t.jobId)
    }
    return store.getDoc('task', id)
  }

  // Member reports for a job's Lead, batched: everything that finished in the last moment goes in one message. The
  // moment starts again at each finish (a task ending just after its sibling still joins it), 10 s after the first at most.
  const reportTimers = new Map(), reportSince = new Map()
  const reportSoon = jobId => {
    if (disposed) return
    const since = reportSince.get(jobId) ?? Date.now()
    clearTimeout(reportTimers.get(jobId))
    reportSince.set(jobId, since)
    reportTimers.set(jobId, setTimeout(() => {
      reportTimers.delete(jobId)
      reportSince.delete(jobId)
      report(jobId).catch(err => ctx.logger?.warn?.(`agent-hub: could not report to the Lead of ${jobId}: ${err?.message || err}`))
    }, Math.max(0, Math.min(1500, since + 10000 - Date.now()))))
  }
  const markReported = tasks => { for (const t of tasks) if (!t.reported) store.putDoc('task', { ...t, reported: true }) }
  const report = async jobId => {
    const due = tasksOf(jobId).filter(t => t.by === 'lead' && DONE.has(t.status) && !t.reported && !awaited.has(`task:${t.id}`))
    if (!due.length) return
    markReported(due)
    const open = tasksOf(jobId).filter(t => !DONE.has(t.status)).length
    const body = `[task reports] ${due.length} task(s) finished${open ? `, ${open} still open` : ''}.\n\n${due.map(t => resultText(t)).join('\n\n')}`
    try {
      await sc.prompt({ requestId: randomUUID(), sessionId: job(jobId).leadId, mode: 'queue', content: [{ type: 'text', text: body }] }, AbortSignal.timeout(60000))
    } catch (err) {
      // not delivered: unmarked, so the next report (or the Lead's wait_tasks) still carries these results
      for (const t of due) { const cur = store.getDoc('task', t.id); if (cur) store.putDoc('task', { ...cur, reported: false }) }
      throw err
    }
  }

  // ── jobs: one Lead session per job ──
  // The Lead is the default agent: it plans the job and assigns pool agents. `headless`: a service (the workbench)
  // assigns the tasks itself — the Lead session exists only as the tasks' parent, gets no planning prompt, and the job
  // ends when the service finishes it. `agents`: the ones the job will use, checked before anything starts.
  const startJob = async ({ goal, cwd, requester, headless, title, taskId, agents: using = [] }) => {
    const brief = String(goal || '').trim()
    if (!brief) throw fail('needGoal', {}, 'the job needs a goal')
    const dir = String(cwd || '').trim() || requester?.cwd || undefined
    await checkAgents(using, { cwd: dir })
    const head = defaultAgent()
    if (head?.model) await unknownModel([[null, head.model]])
    const { sessionId } = await sc.create({ cwd: dir })
    const leadModel = parseModel(head?.model)
    if (leadModel) await sc.selectModel({ sessionId, provider: leadModel.provider, model: leadModel.model })
    await sc.rename({ sessionId, title: say(title || brief, 60) })
    const lead = await liveAgent(sessionId)
    const j = store.putDoc('job', {
      id: shortId('j'), goal: brief, title: say(title || brief, 80), cwd: lead.session?.header?.cwd ?? dir ?? null, leadId: sessionId, leadAgent: head?.id || null,
      requester: requester?.sessionId ? { sessionId: requester.sessionId } : null, ...(taskId && { taskId }), status: 'running', createdAt: Date.now(), headless: !!headless || undefined,
    })
    if (taskId) taskLink(taskId, { kind: 'job', id: j.id })
    leads.set(sessionId, j.id)
    equip(lead)
    if (!headless) {
      try { await sc.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: leadText(j, agents()) }] }, AbortSignal.timeout(60000)) }
      catch (err) {
        const current = job(j.id)
        if (current?.status === 'running') finishJob({ ...current, status: 'failed', error: `the Lead could not be started: ${err?.message || err}`, errorCode: 'leadFailed' })
        throw err
      }
    }
    return j
  }
  const settleTimers = new Map()
  const settleSoon = jobId => {
    if (disposed || !jobId) return
    clearTimeout(settleTimers.get(jobId))
    settleTimers.set(jobId, setTimeout(() => { settleTimers.delete(jobId); settleJob(jobId) }, 2500))
  }
  const settleJob = jobId => {
    const j = job(jobId)
    if (disposed || !j || j.status !== 'running' || j.headless || live(j.leadId)?.status === 'running') return
    const tasks = tasksOf(jobId)
    // Open member work, or a report about to wake the Lead: the job is not over yet.
    if (tasks.some(t => !DONE.has(t.status))) return
    if (reportTimers.has(jobId) || tasks.some(t => t.by === 'lead' && !t.reported)) return settleSoon(jobId)
    const lead = live(j.leadId)
    let end = null
    try { end = lead && ctx.sessionProjections.snapshot(lead.session, ['agentActivity']).values.agentActivity?.lastEnd } catch { /* no fold yet */ }
    let text = reports.get(j.leadId)
    if (text === undefined) {
      try { text = ctx.sessionProjections.snapshot(lead.session, ['agentReport']).values.agentReport?.text } catch { /* no fold yet */ }
    }
    const status = end?.kind === 'error' ? 'failed' : end?.kind === 'aborted' ? 'cancelled' : 'done'
    finishJob({ ...j, status, report: text || j.report || '', error: status === 'failed' ? end.error || 'the Lead\'s turn failed' : undefined, ...(status === 'failed' && !end.error && { errorCode: 'leadFailed' }) })
  }
  const finishJob = j => {
    const done = store.putDoc('job', { ...j, endedAt: Date.now() })
    settle('job', done.id)
    deliver(done.id).catch(err => ctx.logger?.warn?.(`agent-hub: could not deliver job ${done.id}: ${err?.message || err}`))
  }
  // The chat that handed the job over gets the deliverable, unless it is waiting for it right now.
  const deliver = async jobId => {
    const j = job(jobId)
    if (!j?.requester?.sessionId || j.delivered || awaited.has(`job:${jobId}`)) return
    store.putDoc('job', { ...j, delivered: true })
    try { await tell(j.requester.sessionId, jobText(j)) } catch (err) { store.putDoc('job', { ...job(jobId), delivered: false }); throw err }
  }
  const stopJob = id => {
    const j = job(id)
    if (!j) throw fail('noJob', { id }, `no job ${id}`)
    if (live(j.leadId)?.status === 'running') sc.cancel({ sessionId: j.leadId })
    for (const t of tasksOf(id)) if (!DONE.has(t.status)) cancel(t.id, 'lead')
    if (j.status === 'running') finishJob({ ...job(id), status: 'cancelled', error: 'stopped by the user', errorCode: 'stopped' })
    return job(id)
  }

  const statusText = jobId => {
    const j = job(jobId)
    if (!j) return 'This conversation is not leading a job.'
    return `${poolText(agents())}\n\nTasks of job ${j.id}:\n${tasksOf(jobId).map(briefText).join('\n') || '(none yet)'}`
  }

  // ── agent tools: a job's Lead assigns pool agents; any other chat can start a job ──
  const leadTools = () => [
    {
      name: 'assign_task',
      description: 'Give one agent of the pool one self-contained task. It starts right away in a fresh run (or queues behind the task of the same role that is running). ' +
        'The agent does not see this conversation: include paths, context and acceptance criteria. Returns the task id.',
      parameters: schema({
        agent: { type: 'string', description: 'Agent id (see job_status)' },
        task: { type: 'string', description: 'The full task brief' },
        role: { type: 'string', description: 'The role it plays here, a short name ("reviewer", "tester"); default: the agent id' },
        access: { type: 'string', enum: ['read', 'write'], description: '"read": inspect and report; "write": may change files (default)' },
        title: { type: 'string', description: 'Short title for the board (optional)' },
        after: { type: 'array', items: { type: 'string' }, description: 'Task ids this task builds on: it starts once they are done, with their reports attached' },
      }, ['agent', 'task']),
      output: textResult,
      async execute({ agent: ref, task, role, access, title, after }, exec) {
        const t = assign(leads.get(exec.agent.id), { agent: ref, task, role, access: access === 'read' ? 'read' : 'write', title, after }, 'lead')
        const waiting = t.status === 'queued' && t.after.length ? `, waiting for ${t.after.join(', ')}` : ''
        return { text: `Assigned ${t.id} to ${who(t)} (${t.status}${waiting}). Use wait_tasks to collect the report, or end your turn and it will be delivered to you.` }
      },
    },
    {
      name: 'wait_tasks',
      description: 'Wait until tasks finish and return their reports. Without ids, waits for every open task of this job.',
      parameters: schema({
        ids: { type: 'array', items: { type: 'string' }, description: 'Task ids to wait for (default: all open tasks)' },
        timeout_seconds: { type: 'number', description: 'Give up waiting after this long (default 900, max 3600). Tasks keep running.' },
      }),
      output: textResult,
      async execute({ ids, timeout_seconds: limit }, exec) {
        const jobId = leads.get(exec.agent.id)
        const all = tasksOf(jobId)
        const targets = ids?.length
          ? ids.map(id => all.find(t => t.id === id) ?? (() => { throw new Error(`no task ${id} in this job`) })())
          : all.filter(t => !DONE.has(t.status))
        if (!targets.length) return { text: 'No open tasks.' }
        const now = await waitFor('task', targets.map(t => t.id), limit, exec.signal)
        const done = now.filter(t => DONE.has(t.status))
        markReported(done)
        const open = now.filter(t => !DONE.has(t.status))
        // Anything still open is no longer waited on: its report will be pushed when it lands.
        if (open.length) reportSoon(jobId)
        return { text: [...done.map(t => resultText(t)), open.length ? `Still open:\n${open.map(briefText).join('\n')}` : ''].filter(Boolean).join('\n\n') }
      },
    },
    {
      name: 'job_status',
      description: 'Show the agents you can assign and every task of this job with its status and a short result.',
      parameters: schema({}),
      output: textResult,
      execute: async (_args, exec) => ({ text: statusText(leads.get(exec.agent.id)) }),
    },
    {
      name: 'cancel_task',
      description: 'Cancel a queued or running task.',
      parameters: schema({ id: { type: 'string', description: 'Task id' } }, ['id']),
      output: textResult,
      async execute({ id }, exec) {
        if (store.getDoc('task', id)?.jobId !== leads.get(exec.agent.id)) throw new Error(`no task ${id} in this job`)
        return { text: `${id}: ${cancel(id, 'lead').status}` }
      },
    },
  ]
  const chatTools = () => [
    {
      name: 'list_skill_packs',
      description: 'List the skill packs this machine has (bundled with a plugin, a team git repository pinned to a commit) and their skills, as agents name them ("pack/skill"). Read-only: packs are added and updated by the user under Skills.',
      parameters: schema({}),
      output: textResult,
      execute: async () => ({
        text: (await skillPacks.list()).map(p => `## ${p.id} (${p.kind}${p.version ? ` @ ${p.version}` : ''}${p.git ? ` · ${p.git} ${p.ref}` : ''})\n${p.skills.map(k => `- ${p.id}/${k.name}: ${k.description}`).join('\n') || (p.kind === 'git' && !p.sha ? '- (not fetched yet)' : '- (no skills)')}`).join('\n\n') || 'No skill packs.',
      }),
    },
    {
      name: 'list_agent_runtimes',
      description: 'The CLI runtimes agents run on (Claude Code, Codex, pi): installed here or by something else, the version and the latest release, signed in or not, which agents use each, and whether it updates itself.',
      parameters: schema({}),
      output: textResult,
      execute: async () => ({
        text: (await ops.runtimes({ fresh: true })).runtimes.map(r => `- ${r.name} (${r.package}): ${r.managed ? `${r.version || '?'}${r.managed === 'elsewhere' ? ' — installed by something else' : ''}` : 'not installed'}`
          + `${r.latest ? ` · latest ${r.latest}${r.updateAvailable ? ' (update available)' : ''}` : ''} · ${r.status}${r.agents.length ? ` · used by ${r.agents.join(', ')}` : ''}${r.autoUpdate ? ' · updates itself' : ''}${r.busy.length ? ` · ${r.busy.length} task(s) running` : ''}`).join('\n'),
      }),
    },
    {
      name: 'install_agent_runtime',
      description: 'Install, update or pin one CLI runtime (claude, codex, pi) in this home — only when the user asks. version: a release like 1.2.3, or latest. Waits for nothing: refuses while a task of that runtime runs.',
      parameters: schema({ runtime: { type: 'string', enum: Object.keys(PACKAGES) }, version: { type: 'string', description: 'latest (default) or a release like 1.2.3' } }, ['runtime']),
      output: textResult,
      execute: async ({ runtime, version }) => { const r = (await ops.runtimeInstall({ runtime, version })).runtime; return { text: `${r.name} ${r.version} installed (${r.status}).` } },
    },
    {
      name: 'list_agent_pool', // (not list_agents: dsh's Agent Teams tool has that name — two in one session refuse to start it)
      description: 'List the agent pool (runtime, model, effort, skills) and the default agent, which leads the jobs start_agent_job starts.',
      parameters: schema({}),
      output: textResult,
      execute: async () => ({ text: `${poolText(agents())}\n\nDefault agent (leads jobs): ${defaultAgent()?.id || 'none — dsh\'s default model'}` }),
    },
    {
      name: 'start_agent_job',
      description: 'Start a job: a fresh Lead (the default agent) plans the work, assigns it to agents of the pool and reviews their reports. ' +
        'Its final report is delivered back to this conversation when it finishes (or call wait_agent_job). ' +
        'Use when the user asks for agents to do something. The Lead does not see this conversation: write a self-contained brief.',
      parameters: schema({
        task: { type: 'string', description: 'The full job brief: goal, context, links/paths, the deliverable expected' },
        cwd: { type: 'string', description: 'Workspace for this job (default: this conversation\'s)' },
      }, ['task']),
      output: textResult,
      async execute({ task, cwd }, exec) {
        const j = await startJob({ goal: task, cwd, requester: { sessionId: exec.agent.id, cwd: exec.agent.session?.header?.cwd } })
        return { text: `Job ${j.id} started in ${j.cwd}. Its final report will be delivered to this conversation when it finishes; or call wait_agent_job.` }
      },
    },
    {
      name: 'wait_agent_job',
      description: 'Wait for a job you started and return its final report.',
      parameters: schema({
        id: { type: 'string', description: 'Job id from start_agent_job' },
        timeout_seconds: { type: 'number', description: 'Give up waiting after this long (default 900, max 3600). The job keeps running.' },
      }, ['id']),
      output: textResult,
      async execute({ id, timeout_seconds: limit }, exec) {
        const j = job(id)
        if (!j || j.requester?.sessionId !== exec.agent.id) throw new Error(`no job ${id} from this conversation`)
        const [now] = await waitFor('job', [id], limit, exec.signal)
        if (!DONE.has(now.status)) return { text: `Job ${id} is still running.` }
        store.putDoc('job', { ...now, delivered: true })
        return { text: jobText(now) }
      },
    },
  ]
  // Each top-level agent gets one tool set; a session becomes a Lead right after it is created.
  const equipped = new Map()
  const hideNativeTeamTools = agent => {
    let known
    try { known = agent.ctx.tools.view(agent).restrictableNames } catch { return null }
    const deny = NATIVE_TEAM_TOOLS.filter(name => known.has(name))
    return deny.length ? agent.ctx.tools.restrict({ deny }) : null
  }
  const equip = agent => {
    if (agent.session?.header?.origin === 'subagent') return
    const kind = leads.has(agent.id) ? 'lead' : 'chat'
    const current = equipped.get(agent)
    if (current?.kind === kind) return
    current?.dispose()
    const disposers = (kind === 'lead' ? leadTools() : chatTools()).map(tool => agent.ctx.tools.register(tool))
    if (kind === 'lead') disposers.push(hideNativeTeamTools(agent))
    equipped.set(agent, { kind, dispose: () => disposers.forEach(dispose => dispose?.()) })
  }
  for (const agent of ctx.agents.list()) equip(agent)
  ctx.on('agent/created', ({ agent }) => equip(agent))
  ctx.on('agent/disposed', ({ agent }) => { equipped.get(agent)?.dispose(); equipped.delete(agent) })
  cleanup.push(() => { for (const { dispose } of equipped.values()) dispose(); equipped.clear() })

  // A previous Host process cannot finish its runs or Lead turns; queued member work simply continues.
  for (const t of store.docs('task')) {
    if (t.status === 'running') store.putDoc('task', { ...t, status: 'failed', error: 'interrupted: dsh restarted during this run', errorCode: 'interruptedTask', endedAt: Date.now(), reported: true, act: t.act && { ...t.act, phase: 'idle', tools: [] } })
  }
  for (const j of store.docs('job')) {
    if (j.status === 'running' && live(j.leadId)?.status !== 'running') {
      store.putDoc('job', { ...j, status: 'failed', error: 'interrupted: dsh restarted during this job — message the Lead to continue', errorCode: 'interruptedJob', endedAt: Date.now(), delivered: true })
      for (const t of store.docs('task', j.id).filter(t => t.status === 'queued')) store.putDoc('task', { ...t, status: 'failed', error: 'interrupted: dsh restarted during this job', errorCode: 'interruptedTask', endedAt: Date.now(), reported: true })
    }
    else pump(j.id)
  }

  /** What would not run here, said once per agent (an import from another machine keeps its agents anyway). */
  const warningsFor = async list => {
    const known = new Set((await models().catch(() => [])).map(m => `${m.provider}/${m.model}`))
    const sandbox = which('codex') && list.some(a => a.runtime === 'codex' && a.access !== 'full') ? await codexSandboxError() : null
    return list.flatMap(a => [
      ...(a.runtime === 'dsh' && a.model && !known.has(a.model) ? [`${a.id}: model ${a.model}`] : []),
      ...(a.runtime !== 'dsh' && !which(a.runtime) ? [`${a.id}: ${a.runtime} CLI not installed`] : []),
      ...(a.runtime === 'codex' && a.access !== 'full' && sandbox ? [`${a.id}: codex sandbox unavailable, needs "full" access`] : []),
    ])
  }
  /**
   * An agents file (or an old team file) taken in: an agent of the same id is updated, a new one added; an old team's
   * members join the pool unless it has the same agent already. The file's default agent is taken when there is none.
   */
  let takingImports = null
  const importShared = async text => {
    const parsed = parseShared(text)
    const adopted = skillPacks.adopt(sharedPacks(text)) // fetched (at the exporter's commit) on first use
    const touched = [], skipped = []
    if (parsed.agents) {
      for (const a of parsed.agents) {
        if (a.id === config().defaultAgent && a.runtime !== 'dsh') { skipped.push(`${a.id}: the default agent runs inside dsh — not changed; pick another default first`); continue }
        touched.push(store.putDoc('agent', { ...a, createdAt: agent(a.id)?.createdAt ?? Date.now() }))
      }
      if (parsed.defaultAgent && !defaultAgent() && agent(parsed.defaultAgent)?.runtime === 'dsh') setConfig({ defaultAgent: parsed.defaultAgent })
    } else {
      for (const spec of parsed.specs) touched.push(adoptAgent(spec))
      if (parsed.leadModel && !defaultAgent()) setConfig({ defaultAgent: adoptAgent({ runtime: 'dsh', model: parsed.leadModel }).id })
    }
    const list = [...new Map(touched.map(a => [a.id, a])).values()]
    const warnings = [...skipped, ...await warningsFor(list)]
    if (adopted.length) warnings.push(`skill packs added: ${adopted.join(', ')} (fetched on first use, under Skills)`)
    return { agents: list.map(a => a.id), warnings }
  }

  // A CLI runtime's sign-in: on a host its own login command; in a nookbox box the host's `nookbox login <agent> <box>` —
  // the login runs in the box while the gateway keeps the tokens in the host's vault (the box gets placeholders)
  let boxName = null
  const myBox = async () => {
    if (!process.env.NOOKBOX_API) return null
    boxName ||= await fetch(new URL('/v1/box', process.env.NOOKBOX_API), { signal: AbortSignal.timeout(5000) }).then(r => r.json()).then(v => v?.box?.name || null, () => null)
    return boxName || 'ruyix'
  }
  async function signIns() {
    const box = await myBox()
    const runtimes = [...new Set(agents().map(a => a.runtime))].filter(r => r !== 'dsh')
    // a runtime whose agents all take their model from an endpoint needs it installed, not signed in
    const own = runtime => agents().some(a => a.runtime === runtime && !a.endpoint)
    return Promise.all(runtimes.map(async runtime => {
      const st = await runtimeStatus(runtime)
      return { runtime, box, ...st, ...(!own(runtime) && st.status === 'unauthenticated' && { status: 'ready', ready: true, viaEndpoint: true }),
        command: runtime === 'pi' ? 'Settings → Models: a model endpoint (address + API key), picked in the pi agent' : box ? `nookbox login ${runtime} ${box}` : runtime === 'claude' ? 'claude auth login' : 'codex login' }
    }))
  }

  // dsh's credential store, while there is one: Claude Code's API key (keys.js) is kept in it
  let creds = null
  let moveEndpointsSoon = () => {} // (the move of the old endpoints, below: tried again when the credential store comes)
  ctx.inject?.(['credentials'], inner => { creds = inner.credentials; moveEndpointsSoon(); inner.effect(() => () => { creds = null }, 'agent-hub: credentials') })
  const runtimeEnv = rt => keys.env(rt) // Claude Code on an API key: the key with each run
  const login = createLogin({ which })
  // Claude Code and Codex on an API key instead of an account (keys.js): set, changed, let go from Agents → Runtimes
  const keys = createKeys({ which, credentials: () => creds })
  // model endpoints (Agents → Runtimes): an address, its protocol, key and models — what a CLI agent's model may come from
  // the model endpoints: dsh's model providers (its settings, llm-pi-ai) — the one list of where models come from
  let settingsSvc = null
  const providers = () => { try { return settingsSvc?.describe?.({ redactSecrets: true })?.find(s => s.ns === 'llm-pi-ai')?.value?.providers || {} } catch { return {} } }
  const endpoints = createEndpoints({ providers, credentials: () => creds })
  // once: the endpoints Agent Hub kept itself before (config.endpoints) become dsh's providers — ids and key names kept;
  // an id another provider had at another address becomes <id>-ep, and the agents and waiting tasks naming it follow
  let moving = null
  const moveEndpoints = () => (moving ||= moveNow().finally(() => { moving = null }))
  /** endpoint (provider) id → the Set of its models in use: by an agent here, or named "<provider>/<model>" in dsh's settings */
  const modelsInUse = () => {
    const used = {}
    const add = (id, m) => { if (id && m) (used[id] ||= new Set()).add(m) }
    const walk = v => {
      if (typeof v === 'string') { const m = /^([\w.-]+)\/(\S+)$/.exec(v); if (m) add(m[1], m[2]) } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
    }
    // an agent on an endpoint names its model bare; a dsh agent (and the main model) "<provider>/<model>"
    for (const a of agents()) { add(a.endpoint, a.model); if (!a.endpoint) walk(a.model) }
    walk(config().mainModel)
    // (not the providers' own model lists: an OpenRouter model is "<maker>/<model>" too)
    walk((settingsSvc?.describe?.() || []).map(s => (s.ns === 'llm-pi-ai' ? { ...s.value, providers: undefined } : s.value)))
    return used
  }
  const moveNow = async () => {
    const old = config().endpoints || []
    // (moved before the models were picked: an endpoint that came with all its address listed keeps the ones in use)
    if (config().endpointsMoved && !config().endpointsTrimmed && settingsSvc?.mutate) {
      const used = modelsInUse(), ops = []
      for (const e of config().endpointsBefore || []) {
        for (const id of [e.id, `${e.id}-ep`]) {
          const p = providers()[id]
          if (!p || !String(p.apiKeyEnv || '').startsWith('RUYIX_ENDPOINT_') || (p.models || []).length <= PICKED_MAX) continue
          const keep = new Set(modelsToKeep(p.models.map(m => m.id), used[id]))
          ops.push({ op: 'set', path: ['providers', id, 'models'], value: p.models.filter(m => keep.has(m.id)) })
          ctx.logger?.info?.(`agent-hub: model endpoint ${id}: ${p.models.length} models listed, kept the ${keep.size} in use`)
        }
      }
      if (ops.length) await settingsSvc.mutate('llm-pi-ai', ops)
      setConfig({ endpointsTrimmed: true })
    }
    if (config().endpointsMoved || !old.length || !settingsSvc?.mutate) return
    const { add, renamed, same } = providersFromEndpoints(old, providers(), modelsInUse())
    if (same.length && !creds) return // (whose key is set is asked of dsh's credential store: once it is here)
    // the provider it already is (same address): when it has no key of its own, it takes the one the endpoint had (kept
    // under RUYIX_ENDPOINT_<ID>) — the agents naming it would otherwise run with none
    const keyed = async name => !!name && !!(await creds?.resolve?.(name).catch(() => null))?.value
    const adopt = []
    for (const s of same) if (!(await keyed(s.has)) && (await keyed(s.keyEnv))) adopt.push(s)
    const ops = [...add.map(x => ({ op: 'set', path: ['providers', x.id], value: x.value })), ...adopt.map(s => ({ op: 'set', path: ['providers', s.id, 'apiKeyEnv'], value: s.keyEnv }))]
    if (ops.length) await settingsSvc.mutate('llm-pi-ai', ops)
    for (const s of adopt) ctx.logger?.info?.(`agent-hub: model endpoint ${s.id}: the provider of that address takes its key (${s.keyEnv})`)
    // (every task that names it: a failed one may come back queued, carrying its endpoint; a finished one only shows it)
    for (const [from, to] of Object.entries(renamed)) {
      for (const a of agents().filter(x => x.endpoint === from)) store.putDoc('agent', { ...a, endpoint: to })
      for (const t of store.docs('task').filter(x => x.endpoint === from)) store.putDoc('task', { ...t, endpoint: to })
    }
    setConfig({ endpointsMoved: true, endpointsTrimmed: true, endpointsBefore: old, endpoints: [] })
    ctx.logger?.info?.(`agent-hub: ${add.length} model endpoint(s) moved to Settings → 模型${Object.keys(renamed).length ? ` (renamed: ${JSON.stringify(renamed)})` : ''}`)
  }
  moveEndpointsSoon = () => { if (settingsSvc) moveEndpoints().catch(err => ctx.logger?.warn?.(`agent-hub: moving the model endpoints: ${err?.message || err}`)) }
  ctx.inject?.(['settings'], inner => {
    settingsSvc = inner.settings
    moveEndpointsSoon()
    inner.effect(() => () => { settingsSvc = null }, 'agent-hub: settings')
  })
  /** endpoint id → the agents that take their model from it */
  const endpointUses = () => agents().filter(a => a.endpoint).reduce((m, a) => ({ ...m, [a.endpoint]: [...(m[a.endpoint] || []), a.id] }), {})
  /** An agent's endpoint, there and fit for its runtime (else why not). */
  const endpointOf = a => {
    if (!a.endpoint) return null
    const ep = endpoints.get(a.endpoint)
    if (!ep) throw fail('noEndpoint', { id: a.endpoint }, `agent "${a.id}": no model endpoint "${a.endpoint}" (Agents → Runtimes)`)
    if (!RUNTIME_APIS[a.runtime]?.includes(ep.api)) throw fail('endpointRuntime', { runtime: a.runtime, api: ep.api }, `agent "${a.id}": ${CLI[a.runtime]?.name || a.runtime} cannot use ${ep.name} (${ep.api})`)
    return ep
  }
  /**
   * What a CLI run of member m gets besides its own arguments: its MCP server with the token in a 0600 file, pi's own
   * folder for the run (its MCP server, an endpoint's models), and a model endpoint's arguments and environment.
   * → { mcp, endpoint, env, dir } (dir: removed when the run is over)
   */
  // (rawMcp: one MCP server or several — a run's tools, the agents' browser; each one's env rides a 0600 file)
  const prepareCli = async (m, rawMcp, isolated) => {
    const ep = endpointOf(m)
    const endpoint = ep ? endpointLaunch(m.runtime, ep, m.model, await endpoints.key(ep.id)) : null
    const list = [rawMcp].flat().filter(Boolean), withEnv = x => Object.keys(x.env || {}).length > 0
    const dir = list.some(withEnv) || (m.runtime === 'pi' && (list.length || endpoint)) ? mkdtempSync(join(tmpdir(), 'agent-hub-run-')) : null
    const mcp = list.map(x => (dir && withEnv(x) ? mcpViaEnvFile(x, dir) : x))
    const env = { ...(m.runtime === 'pi' && (mcp.length || endpoint) ? piHomeIn(join(dir, 'pi'), { mcp, models: endpoint?.piModels, isolated }) : {}), ...(endpoint?.env || {}) }
    return { mcp, endpoint, env, dir }
  }
  // ── the agents' browser (the App Center's: docs/design/browser.md): its tools for an agent's CLI, when the agent's
  // switch is on (an agent is on unless set off — a third-party pack's agents come off) and the browser is here ──
  let browserSvc = null
  ctx.inject?.(['ruyixBrowser'], inner => { browserSvc = inner.ruyixBrowser; inner.effect(() => () => { browserSvc = null }, 'agent-hub: the agents\' browser') })
  /** { who, title, of, dirs } → the browser's MCP server for this agent, or null */
  const browserFor = (a, use) => (a && a.browser !== false && browserSvc?.mcp?.(use)) || null
  // this Ruyix's web search and page fetching (@ruyix/web, docs/design/search.md): web_search / web_fetch for every CLI
  // agent, beside their own search (Ethan: both)
  let webSvc = null
  ctx.inject?.(['ruyixWeb'], inner => { webSvc = inner.ruyixWeb; inner.effect(() => () => { webSvc = null }, 'agent-hub: web search') })
  const webFor = a => (a && webSvc?.mcp?.()) || null
  // the whole Ruyix as tools (the shell's system tools: docs/design/agent-control.md — Ethan: every agent of the pool may
  // work the system), its name and work on the record of what it did
  let shellSvc = null
  ctx.inject?.(['ruyixShell'], inner => { shellSvc = inner.ruyixShell; inner.effect(() => () => { shellSvc = null }, 'agent-hub: the system tools') })
  // (not a workflow's step: what a step may use is its workflow's to say — the engine's tools for it)
  /** { who, title, of } → the system tools' MCP server for this agent, or null */
  const systemFor = (a, use) => (a && shellSvc?.systemMcp?.(use)) || null

  // ── sessions (sessions.js, docs/design/sessions.md): an agent, a folder, one conversation, a process that stays ──
  /** What a session's CLI is started with: its agent's model, effort, access, skills, endpoint and key; its CLI session to resume. */
  // (a run's step: `extra` = the engine's instructions, the step's skills and pins, its env and the run's MCP — openSession)
  const prepareSession = async (d, { text, extra }) => {
    const a = agent(d.agent)
    if (!a) throw fail('agentGone', { agent: d.agent }, `agent "${d.agent}" is no longer in the pool`)
    const sp = d.spec || {}
    const m = { id: a.id, name: a.name || a.id, role: a.role || '', runtime: sp.runtime || a.runtime, model: sp.model ?? a.model, endpoint: a.endpoint || null, effort: sp.effort ?? a.effort, access: sp.access || a.access || 'write' }
    const bin = which(m.runtime)
    if (!bin) throw fail('cliNotInstalled', { cli: CLI[m.runtime].name }, `${CLI[m.runtime].name} is not installed (Agents → Runtimes installs it)`)
    await checkCodexSandbox([m])
    const native = m.runtime === 'claude'
    const found = (await skillPacks.resolve([...new Set([...(a.skills || []), ...(extra?.skills || [])])], d.cwd, extra?.pins)).filter(s => !s.missing)
    const skills = await Promise.all(found.map(async s => ({ ...s, body: native ? null : (await readFile(join(s.dir, 'SKILL.md'), 'utf8').catch(() => '')).slice(0, 20000) })))
    const isolated = !skillPacks.policy().local
    const browserUse = (extra ? extra.browser : true) && browserFor(a, { who: `session:${d.id}`, title: d.title, of: d.of?.run ? `run:${d.of.run}` : `session:${d.id}`, dirs: [d.cwd] })
    const run = await prepareCli(m, [extra?.mcp, browserUse, webFor(a), !extra && systemFor(a, { who: `session:${d.id}`, title: d.title, of: d.of?.run ? `run:${d.of.run}` : `session:${d.id}` })], isolated)
    const pluginDir = native && skills.length ? skillPlugin(skills) : null
    const instructions = extra?.instructions ? [extra.instructions, skillsText(skills)].filter(Boolean).join('\n\n') : sessionInstructions(d, m, skills)
    const { args, input } = cliCommand(m.runtime, { isolated, model: m.model, effort: m.effort, access: m.access, instructions, task: text || '', cwd: d.cwd, mcp: run.mcp, resume: d.cli, pluginDir, endpoint: run.endpoint, web: !!extra?.web })
    return {
      bin, args, input, env: { ...((await runtimeEnv(m.runtime)) || {}), ...(extra?.env || {}), ...run.env }, codexHome: isolated ? codexHomeIn(store.dir) : undefined,
      cleanup: () => { for (const x of [run.dir, pluginDir]) if (x) rmSync(x, { recursive: true, force: true }) },
    }
  }
  const agentSessions = createSessions({ store, dir: join(store.dir, 'sessions'), prepare: prepareSession, logger: ctx.logger })
  cleanup.push(() => agentSessions.dispose())
  // ── the sessions in a terminal (mirror.js; agent-work.md §5): a socket for `ruyix session attach`, and a tmux session
  // `ruyix` (a Zellij one too, when Zellij is here) with a window per session running that mirror ──
  try { const unserve = serveSessions(agentSessions, sessionsSockPath(store.dir), { log: m => ctx.logger?.warn?.(m) }); cleanup.push(unserve) } catch (err) { ctx.logger?.warn?.(`agent-hub: the sessions' socket: ${err.message}`) }
  let mirrorBin = null
  try { mirrorBin = join(dirOf(createRequire(import.meta.url).resolve('@ruyix/shell/package.json')), 'bin', 'ruyix-session.mjs') } catch { /* no shell here: no terminal mirrors */ }
  // (in a box, or when asked — RUYIX_MIRRORS=1: a machine's own tmux and Zellij are its person's, a check's never touched)
  const mirrors = mirrorBin && (process.env.RUYIX_IMAGE || process.env.RUYIX_MIRRORS === '1') && createMirrors({ attach: id => [process.execPath, mirrorBin, 'attach', id], has: bin => !!which(bin), log: m => ctx.logger?.warn?.(m) })
  const mirrorSoon = () => { if (mirrors) mirrors.sync(agentSessions.list()).catch(() => {}) }
  mirrorSoon()
  { const timer = setInterval(mirrorSoon, 60000); timer.unref?.(); cleanup.push(() => clearInterval(timer)) }
  /** A new session: { agent (its id), cwd (home when none), title?, text?, by, of?, confirm? } */
  let chatTask = () => null // the conversation's task while a turn of it runs (the workbench's tasks.current(), below)
  let taskSay = () => {} // (its update: a session handed this request's work says so at once — the turn's end keeps it at work)
  let taskLink = () => {} // (and its link: the session is on the task from the first second — its name for the closing line, the page)
  const startSession = ({ agent: id, cwd, title, text, by = 'person', of = null, confirm = false }) => {
    // one piece of work, one task: a session the main agent starts in a turn of the conversation is that request's work
    // (the conversation's task: the workbench's tasks.current()), not a task of its own (task-feed.js)
    if (by === 'main' && !of) { const task = chatTask(); if (task) of = { task } }
    const a = agent(String(id || ''))
    if (!a) throw fail('noAgent', { agent: id }, `no agent "${id}" in the pool`)
    if (a.runtime === 'dsh') throw fail('sessionDsh', { agent: a.id }, `${a.id} is a dsh agent: its conversations are dsh's own (the chat); a session takes Claude Code, Codex or pi`)
    const dir = String(cwd || '').trim() || homedir()
    mkdirSync(dir, { recursive: true })
    const started = agentSessions.start({ agent: a, cwd: dir, title, text, by, of, confirm })
    // (the request is at work in the session now: so its card says, rather than settling while the session still writes)
    if (of?.task && by === 'main') {
      const what = title || a.name || a.id
      taskSay(of.task, { state: 'working', step: { zh: `交给会话：${what}`, en: `Handed to a session: ${what}` } })
      Promise.resolve(started).then(d => { if (d?.id) taskLink(of.task, { kind: 'session', id: d.id }) }, () => {})
    }
    return started
  }
  // ── a lane opened on the desk (agent-work.md §2): the main model says, in two or three sentences, what it has done ──
  const SUMMARY_SYSTEM = 'Say in two or three sentences what this piece of agents\' work has done so far, where it stands and what is left or went wrong. Only those sentences: no title, no list. Write in the language of the work itself (usually Simplified Chinese).'
  async function summarizeWork(id) {
    const model = mainModel()
    if (!ctx.llm?.stream || !model || model.indexOf('/') < 1) return { text: null, why: 'noMainModel' }
    let text = ''
    if (id.startsWith('session:')) {
      const { session: d, events } = agentSessions.read(id.slice(8), { limit: 300 })
      text = `Session: ${d.title} (agent ${d.agent}, in ${d.cwd})\n\n${transcript(events, 12000)}`
    } else if (id.startsWith('task:')) {
      const j = job(id.slice(5))
      if (!j) return { text: null, why: 'noJob' }
      text = `Job: ${j.title}\nGoal: ${say(j.goal, 1500)}\nStatus: ${j.status}\n\n${tasksOf(j.id).map(t => `- ${who(t)} · ${t.status} · ${t.title}${t.output || t.error ? `: ${say(t.error || t.output, 800)}` : ''}`).join('\n')}`
    } else return { text: null, why: 'notMine' }
    const cut = model.indexOf('/')
    let out = ''
    for await (const c of ctx.llm.stream({ provider: model.slice(0, cut), model: model.slice(cut + 1), system: SUMMARY_SYSTEM, maxTokens: 600, signal: AbortSignal.timeout(90000),
      messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'agent-hub-summary' } }] })) if (c.type === 'text-delta') out += c.text
    return { text: out.trim() || null }
  }

  // the main agent's tools over them (the shell's system tools: on record, with the way back)
  ctx.inject?.(['ruyixShell'], inner => {
    const sh = inner.ruyixShell
    if (!sh?.systemTools) return
    for (const tool of sessionTools({ sessions: agentSessions, start: startSession, agents })) inner.effect(() => sh.systemTools.register(tool), `agent-hub: tool ${tool.name}`)
    // the sessions and the pool's agents, for the shell's find
    if (sh.finders) {
      inner.effect(() => sh.finders.register({
        kind: 'session', title: { zh: '会话', en: 'Sessions' },
        find: () => agentSessions.list().map(d => ({ id: d.id, title: d.title || d.id, hint: `${d.agent} · ${d.cwd || ''}`, at: d.lastAt, how: `session_read { id: "${d.id}" } / session_send { id: "${d.id}", message }` })),
      }), 'agent-hub: sessions found')
      inner.effect(() => sh.finders.register({
        kind: 'agent', title: { zh: '智能体', en: 'Agents' },
        find: () => agents().map(a => ({ id: a.id, title: a.name || a.id, hint: `${a.runtime || 'dsh'}${a.role ? ` · ${a.role}` : ''}`, text: `${a.description || ''} 智能体 agent`, how: `session_start { agent: "${a.id}", message }` })),
      }), 'agent-hub: agents found')
    }
  })

  // ── the pool's work as the person's tasks (task-feed.js; docs/design/agent-tasks.md): the sessions people and the main
  // agent started and the jobs, each a task of the workbench's, kept in step — when the workbench's tasks are there ──
  ctx.inject?.(['ruyixWorkbench'], inner => {
    const t = inner.ruyixWorkbench?.tasks
    if (!t?.create || !t.registerSource) return
    if (t.current) { chatTask = () => { try { return t.current() || null } catch { return null } }; inner.effect(() => () => { chatTask = () => null }, 'agent-hub: the conversation\'s task') }
    if (t.link) { taskLink = (id, l) => { try { t.link(id, l) } catch (err) { ctx.logger?.warn?.(`agent-hub: task ${id}: ${err?.message || err}`) } }; inner.effect(() => () => { taskLink = () => {} }, 'agent-hub: linking a request\'s session') }
    if (t.update) { taskSay = (id, patch) => { try { t.update(id, patch) } catch (err) { ctx.logger?.warn?.(`agent-hub: task ${id}: ${err?.message || err}`) } }; inner.effect(() => () => { taskSay = () => {} }, 'agent-hub: saying a request\'s session') }
    inner.effect(() => {
      const feed = createTaskFeed({
        tasks: t, sessions: agentSessions, store, stopJob: id => stopJob(String(id)), log: m => ctx.logger?.warn?.(m),
        followUp: (j, text, taskId) => j && startJob({ taskId, goal: `${j.goal}\n\nGo on from job ${j.id}, as the person asked: ${text}`, cwd: j.cwd || undefined, title: j.title }),
      })
      feed.tick()
      return () => feed.dispose()
    }, 'agent-hub: sessions and jobs as tasks')
  })

  // the main agent's tools for the person's tasks (task-tools.js): look, accept, change, archive — on the shell's system tools
  ctx.inject?.(['ruyixShell', 'ruyixWorkbench'], inner => {
    const sh = inner.ruyixShell, t = inner.ruyixWorkbench?.tasks
    if (!sh?.systemTools || !t?.list) return
    for (const tool of taskTools({ tasks: t })) inner.effect(() => sh.systemTools.register(tool), `agent-hub: tool ${tool.name}`)
    // the person's tasks, for the shell's find (the task center's own search narrows them first)
    if (sh.finders) inner.effect(() => sh.finders.register({
      kind: 'task', title: { zh: '任务', en: 'Tasks' },
      find: async q => {
        const seen = new Map()
        for (const r of await Promise.all([t.list({ q, limit: 40 }), t.list({ limit: 80 })].map(p => p.catch(() => ({}))))) for (const x of r.tasks || []) seen.set(x.id, x)
        return [...seen.values()].map(x => ({ id: x.id, title: x.title, hint: `${x.state}${x.archived ? ' · archived' : ''} · ${x.source}`, text: `${x.source} 任务 task`, at: x.updatedAt, how: `task_look { id: "${x.id}" }` }))
      },
    }), 'agent-hub: tasks found')
  })

  // ── the CLI runtimes as packages of this home (Agents → Runtimes): versions, updates (off unless turned on), removal ──
  const installer = createInstaller({ which })
  const busyWith = rt => [
    ...store.docs('task').filter(t => ['running', 'queued'].includes(t.status) && t.runtime === rt).map(t => t.id),
    ...agentSessions.list().filter(d => d.runtime === rt && (d.process === 'on' || d.state === 'working')).map(d => d.id),
  ]
  let installing = null // one install or removal at a time
  async function installRuntime(runtime, { version, replace = false, force = false } = {}) {
    if (installing) throw fail('runtimeInstalling', { runtime: installing }, `${CLI[installing]?.name || installing} is being installed or removed: try again when it is done`)
    const busy = busyWith(runtime)
    if (busy.length && !force) throw fail('runtimeBusy', { runtime, tasks: busy.join(', ') }, `${CLI[runtime]?.name || runtime} has tasks running (${busy.join(', ')}): update when they are done`)
    installing = runtime
    try { return await installer.install(runtime, { version: version || 'latest', replace }) } finally { installing = null }
  }
  async function runtimeView(rt, fresh = false) {
    const st = await installer.status(rt), latest = await installer.latest(rt, { fresh })
    return {
      ...st, latest, updateAvailable: !!(st.version && latest && newer(latest, st.version)), autoUpdate: !!config().runtimes?.[rt]?.autoUpdate,
      ...(st.managed ? await runtimeStatus(rt, undefined, await runtimeEnv(rt)) : { installed: false, authenticated: false, ready: false, status: 'missing' }),
      keyTail: config().runtimes?.[rt]?.keyTail || null, canKey: !!KEY_LOGINS[rt],
      agents: agents().filter(a => a.runtime === rt).map(a => a.id), busy: busyWith(rt), installing: installing === rt,
      // its agents all take their model from an endpoint: its own sign-in is not needed
      viaEndpoint: agents().some(a => a.runtime === rt) && agents().filter(a => a.runtime === rt).every(a => a.endpoint),
    }
  }
  // turned on per runtime: the latest release once nothing of it is running, checked every six hours
  const autoUpdate = async () => {
    for (const rt of Object.keys(PACKAGES).filter(r => config().runtimes?.[r]?.autoUpdate)) {
      const v = await runtimeView(rt, true).catch(() => null)
      if (!v || v.managed !== 'ruyix' || !v.updateAvailable || v.busy.length || installing) continue
      await installRuntime(rt, { version: v.latest }).then(r => ctx.logger?.info?.(`agent-hub: ${v.name} updated to ${r.version}`), err => ctx.logger?.warn?.(`agent-hub: ${v.name} update: ${err.message}`))
    }
  }
  // first start (a fresh box, a new machine): the CLIs the pool's agents use that are nowhere here get installed — the
  // image carries none of them, and a person's own install (on PATH, ~/.local/bin) is left as it is
  const firstInstall = setTimeout(async () => {
    for (const rt of [...new Set(agents().map(a => a.runtime))].filter(r => PACKAGES[r] && !which(PACKAGES[r].bin))) {
      await installRuntime(rt).then(r => ctx.logger?.info?.(`agent-hub: ${r.name} ${r.version} installed (the pool uses it)`), err => ctx.logger?.warn?.(`agent-hub: ${PACKAGES[rt].name} not installed: ${err.message}`))
    }
  }, 15000)
  firstInstall.unref?.()
  ctx.effect?.(() => () => clearTimeout(firstInstall), 'agent-hub: first install')
  const autoTimer = setInterval(autoUpdate, 6 * 3600e3)
  autoTimer.unref?.()
  ctx.effect?.(() => () => clearInterval(autoTimer), 'agent-hub: runtime updates')

  const keyTail = (rt, tail) => setConfig({ runtimes: { ...config().runtimes, [rt]: { ...config().runtimes?.[rt], keyTail: tail } } })

  const ops = {
    sync: ({ since }) => store.since(Number(since) || 0),
    // ── sessions (sessions.js): the page's are the person's ──
    sessions: () => ({ sessions: agentSessions.list() }),
    sessionStart: async ({ agent: id, cwd, title, text }) => { const session = await startSession({ agent: id, cwd, title, text, by: 'person' }); mirrorSoon(); return { session } },
    sessionSend: ({ id, text }) => agentSessions.send(String(id), text, { confirm: true }),
    sessionRead: ({ id, after, limit }) => agentSessions.read(String(id), { after: Number(after) || 0, ...(limit && { limit: Math.min(2000, Number(limit)) }) }),
    sessionStop: ({ id }) => agentSessions.stop(String(id)),
    sessionSeen: ({ id }) => agentSessions.seen(String(id)),
    /** A pool job looked at (the desk's 擦掉): it leaves the desk. */
    jobSeen: ({ id }) => { const j = job(String(id)); if (j && !j.seenAt) store.putDoc('job', { ...j, seenAt: Date.now() }); return { seen: !!j } },
    /** The main model's account of a session or a pool job so far (a lane of the desk opened): → { text } (null: no main model) */
    summarize: ({ id }) => summarizeWork(String(id)),
    sessionClose: ({ id }) => ({ session: agentSessions.close(String(id)) }),
    sessionRemove: ({ id }) => { const r = agentSessions.remove(String(id)); mirrorSoon(); return r },
    /** One task whole (sync cuts long briefs and reports). */
    task: ({ id }) => ({ task: store.getDoc('task', String(id)) || null }),

    /** The pool's CLI runtimes: installed, signed in, and the command that signs one in (in a box: on its host). */
    logins: async () => ({ runtimes: await signIns() }),
    /** Agents → Runtimes: every CLI runtime, installed here or elsewhere, its version and the latest, signed in or not. */
    runtimes: async ({ fresh } = {}) => ({ runtimes: await Promise.all(Object.keys(PACKAGES).map(rt => runtimeView(rt, !!fresh))), box: await myBox(), root: installer.root, endpoints: endpoints.list(), usedBy: endpointUses() }),
    // ── model endpoints (endpoints.js) ──
    /** Reach it with its key and list its models. */
    endpointTest: ({ id }) => endpoints.test(String(id)),
    /** Install, update or pin a version (`replace`: take over a command installed elsewhere; `force`: even with tasks running). */
    runtimeInstall: async ({ runtime, version, replace, force }) => { await installRuntime(String(runtime), { version, replace: !!replace, force: !!force }); return { runtime: await runtimeView(String(runtime)) } },
    runtimeRemove: async ({ runtime, force }) => {
      if (installing) throw fail('runtimeInstalling', { runtime: installing }, `${CLI[installing]?.name || installing} is being installed or removed: try again when it is done`)
      const busy = busyWith(String(runtime))
      if (busy.length && !force) throw fail('runtimeBusy', { runtime, tasks: busy.join(', ') }, `${CLI[runtime]?.name || runtime} has tasks running (${busy.join(', ')})`)
      installing = String(runtime)
      try { await installer.remove(String(runtime)) } finally { installing = null }
      return { runtime: await runtimeView(String(runtime)) }
    },
    /** A CLI's own sign-in from the page: Claude Code (a link, then the pasted code), Codex (a device code). In a box the tokens stay in the host's vault. */
    runtimeLogin: ({ runtime }) => login.start(String(runtime)),
    runtimeLoginState: async () => {
      const v = login.state()
      // signed in with the account: a key kept before is let go (it would shadow the account)
      if (v.status === 'done' && config().runtimes?.[v.runtime]?.keyTail) { await keys.drop(v.runtime).catch(() => {}); keyTail(v.runtime, null) }
      return v
    },
    /** Claude Code or Codex on an API key (checked with its provider; in a box the host's vault keeps it). */
    runtimeKey: async ({ runtime, value }) => {
      const r = await keys.set(String(runtime), value)
      keyTail(String(runtime), r.tail)
      return { verified: r.verified, runtime: await runtimeView(String(runtime)) }
    },
    /** Signed out: the CLI's own logout, its key let go (`force`: even with tasks running on it). */
    runtimeLogout: async ({ runtime, force }) => {
      const busy = busyWith(String(runtime))
      if (busy.length && !force) throw fail('runtimeBusy', { runtime, tasks: busy.join(', ') }, `${CLI[runtime]?.name || runtime} has tasks running (${busy.join(', ')})`)
      await keys.signOut(String(runtime))
      keyTail(String(runtime), null)
      return { runtime: await runtimeView(String(runtime)) }
    },
    runtimeLoginCode: ({ code }) => login.code(code),
    runtimeLoginStop: () => login.stop(),
    runtimeAuto: ({ runtime, on }) => {
      if (!PACKAGES[runtime]) throw fail('badRuntime', { runtime }, `no installable runtime "${runtime}"`)
      setConfig({ runtimes: { ...config().runtimes, [runtime]: { ...config().runtimes?.[runtime], autoUpdate: !!on } } })
      return { runtime, autoUpdate: !!on }
    },
    async models({ cwd, cwds }) {
      return {
        models: await models().catch(() => []),
        skills: await skillPacks.catalog(cwds ?? cwd), // pack/skill first (portable), then the workspace's and this machine's
        clis: { claude: !!which('claude'), codex: !!which('codex'), pi: !!which('pi'), codexModel: await codexModel(), codexSandbox: !which('codex') || !(await codexSandboxError()) },
        uses: await usesOf(), // which plugin uses which agent, for what (the workbench: a workflow's steps)
        endpoints: endpoints.list(), apis: RUNTIME_APIS, // the model endpoints an agent may take (no key: only its last four)
      }
    },

    // ── the agent pool ──
    /** Add an agent, or change one (`prev`: its id, which never changes — workflows name it). */
    async saveAgent({ prev, expect, ...fields }) {
      const def = normalizeAgent(fields)
      const old = prev ? agent(String(prev)) : undefined
      const changed = () => fail('agentChanged', { id: def.id }, 'this agent changed elsewhere: reopen it before saving')
      if (expect !== undefined && Number(expect) !== (old?.revision || 0)) throw changed()
      if (def.runtime === 'dsh' && def.model) await unknownModel([[def.id, def.model]])
      endpointOf(def)
      // Model validation may await: another surface must not be overwritten meanwhile.
      if (prev && (!!agent(String(prev)) !== !!old || (agent(String(prev))?.revision || 0) !== (old?.revision || 0))) throw changed()
      if (prev && !old) throw fail('noAgent', { id: prev }, `no agent "${prev}"`)
      if (old && old.id !== def.id) throw fail('idFixed', { id: old.id }, 'an agent\'s id cannot change (workflows name it): add another agent instead')
      if (!old && agent(def.id)) throw fail('agentExists', { id: def.id }, `an agent "${def.id}" already exists`)
      if (old && config().defaultAgent === old.id && def.runtime !== 'dsh') throw fail('defaultDsh', { id: def.id }, 'the default agent runs inside dsh: pick another default agent first')
      return { agent: store.putDoc('agent', { ...def, createdAt: old?.createdAt ?? Date.now() }) }
    },
    async deleteAgent({ id, expect, unused = false }) {
      const a = agent(String(id))
      if (!a) throw fail('noAgent', { id }, `no agent "${id}"`)
      if (expect !== undefined && expect !== (a.revision || 0)) throw fail('agentChanged', { id }, 'this agent changed since')
      const using = (await usesOf()).filter(u => u.agent === a.id)
      if (!agent(a.id) || agent(a.id).revision !== a.revision) throw fail('agentChanged', { id }, 'this agent changed while its uses were checked')
      if (unused && (config().defaultAgent === a.id || config().mainAgent === a.id)) throw fail('agentChanged', { id }, 'this agent was chosen for the system since it was created')
      if (using.length) throw fail('agentInUse', { id: a.id, list: [...new Set(using.map(u => `${u.by} · ${u.where?.en || ''}`))].slice(0, 6).join(', ') }, `"${a.id}" is used by ${[...new Set(using.map(u => `${u.by} ${u.where?.en || ''}`))].slice(0, 6).join(', ')}: pick other agents there first`)
      if (store.docs('task').some(t => t.agent === a.id && ['running', 'queued'].includes(t.status))) throw fail('agentBusy', { id: a.id }, `"${a.id}" has running tasks`)
      if (config().defaultAgent === a.id) setConfig({ defaultAgent: null })
      if (config().mainAgent === a.id) setConfig({ mainAgent: null })
      store.putDoc('agent', { ...a, deleted: true })
      return { ok: true }
    },
    /** The default agent: it leads jobs and is the assistants' and the AI helpers' model (a dsh agent; null: dsh's default). */
    setDefaultAgent({ id }) {
      if (id) {
        const a = agent(String(id))
        if (!a) throw fail('noAgent', { id }, `no agent "${id}"`)
        if (a.runtime !== 'dsh') throw fail('defaultDsh', { id: a.id }, 'the default agent runs inside dsh: pick a dsh agent')
      }
      setConfig({ defaultAgent: id ? String(id) : null, defaultChosen: true })
      return { defaultAgent: id ? String(id) : null }
    },
    /** The main agent and model as chosen (null: not chosen — the default agent; following the main agent), and what they are now. */
    mainGet: async ({ choices = false } = {}) => ({
      agent: config().mainAgent || null, model: config().mainModel || null, chosen: !!config().mainChosen,
      resolved: { agent: mainAgent()?.id || null, runtime: mainAgent()?.runtime || null, model: mainModel() },
      // what Settings offers: the pool's agents, dsh's models, the default agent (what "none chosen" is)
      ...(choices && {
        agents: agents().map(a => ({ id: a.id, name: a.name || a.id, runtime: a.runtime, model: a.model || '', endpoint: a.endpoint || null })),
        models: (await models().catch(() => [])).map(m => `${m.provider}/${m.model}`),
        defaultAgent: defaultAgent()?.id || null,
      }),
    }),
    /** { agent?, model? }: agent — any agent of the pool (null: the default agent); model — "provider/model" (null: follow the main agent). */
    async mainSet({ agent: id, model } = {}) {
      const patch = { mainChosen: true }
      if (id !== undefined) {
        if (id && !agent(String(id))) throw fail('noAgent', { id }, `no agent "${id}"`)
        patch.mainAgent = id ? String(id) : null
      }
      if (model !== undefined) {
        if (model && !/^[^/\s]+\/\S+$/.test(String(model))) throw fail('badModel', { model }, 'the main model is provider/model (a dsh model)')
        if (model) await unknownModel([['main model', String(model)]])
        patch.mainModel = model ? String(model) : null
      }
      setConfig(patch)
      return ops.mainGet()
    },
    exportAgents() {
      const list = agents()
      const packs = [...new Set(list.flatMap(a => a.skills).filter(x => x.includes('/')).map(x => x.split('/')[0]))]
      const file = { ...exportAgents(list, config().defaultAgent), ...(packs.length && { skillPacks: skillPacks.sources(packs) }) }
      return { file, code: `dsh-agents:${Buffer.from(JSON.stringify(file)).toString('base64url')}` }
    },
    importAgents: ({ text: shared }) => importShared(shared),

    // ── skill packs (the Skills page) ──
    async skillPacks({ cwds }) {
      const [packs, catalog] = await Promise.all([skillPacks.list(), skillPacks.catalog(cwds)])
      // who uses what: each agent that names a skill, and what other plugins say they use it for (the workbench:
      // a step's scripts, a stage's member) — { by, where: { en, zh } }; a pack that is removed or updated says what it touches
      const uses = {}
      const add = (ref, use) => (uses[ref] ||= []).push(use)
      for (const a of agents()) for (const ref of a.skills) add(ref, { by: a.name, kind: 'agent', agent: a.id, where: { en: a.id, zh: a.id } })
      for (const provider of skillUses) for (const u of (await Promise.resolve(provider()).catch(() => [])) || []) add(u.ref, u)
      const of = ref => uses[ref] || []
      return {
        policy: skillPacks.policy(),
        packs: packs.map(p => ({ ...p, dir: undefined, skills: p.skills.map(s => ({ ...s, dir: undefined, usedBy: of(`${p.id}/${s.name}`) })), usedBy: Object.entries(uses).filter(([r]) => r.startsWith(`${p.id}/`)).flatMap(([, w]) => w) })),
        unmanaged: catalog.filter(s => !s.pack).map(s => ({ ...s, dir: undefined, usedBy: of(s.ref) })),
      }
    },
    /** Whether agents may use skills only on this machine or in a workspace (off: packs only, as in a sandbox). */
    skillPolicy: ({ local }) => skillPacks.setPolicy({ local }),
    skillPackAdd: args => skillPacks.add(args).then(pack => ({ pack })),
    skillPackCheck: ({ id }) => skillPacks.checkUpdate(String(id)),
    skillPackUpdate: ({ id, to }) => skillPacks.update(String(id), to ? String(to) : undefined).then(pack => ({ pack })),
    skillPackRemove: ({ id }) => skillPacks.remove(String(id)),
    skillShow: ({ ref, cwds }) => skillPacks.show(String(ref || ''), cwds),
    skillFile: ({ ref, path, cwds }) => skillPacks.file(String(ref || ''), String(path || ''), cwds),

    startJob: async ({ goal, cwd }) => ({ job: await startJob({ goal, cwd }) }),
    stopJob: ({ id }) => ({ job: stopJob(String(id)) }),
    assign: ({ jobId, agent: ref, role, access, task, after }) => ({ task: assign(String(jobId), { agent: ref, role, access, task, after }, 'user') }),
    cancelTask: ({ id }) => ({ task: cancel(String(id), 'user') }),

    // Human words to a job's Lead: a queued prompt when idle, a steer when busy.
    async message({ sessionId, text: value }) {
      const content = text(value)
      const delivery = live(sessionId)?.status === 'running' ? 'steer' : 'queue'
      await sc.prompt({ requestId: randomUUID(), sessionId, mode: delivery, content }, AbortSignal.timeout(60000))
      return { delivery }
    },
  }

  // One of Ruyix's parts: the shell asks it what is at work, what its setup lacks, and hands it an imported configuration.
  let service = null
  ctx.inject?.(['ruyixShell'], inner => inner.effect(() => inner.ruyixShell?.part?.({
    id: 'agentHub', name: { en: 'Agents', zh: '智能体' }, panel: 'agent-hub', order: 40,
    busy: () => service?.busy() || [], setup: () => service?.setup() || [], imported: () => service?.takeImported(), importing: () => service?.importing?.() || false, caps: { workflows: ['agents'] },
  }), 'agent-hub: ruyix part'))
  // For other plugins (the workbench, the dashboards, the cloud node): the pool, jobs, tasks and their results.
  ctx.provide('agentHub', service = {
    // ── sessions for a run's steps (sessions.js, docs/design/sessions.md §2a): the workbench's engine decides which ──
    /** → { id, agent, state, process, runtime, model, effort, access, cwd, env, skills, context, turns, by, of, error, cli } | null */
    sessionInfo: id => agentSessions.info(String(id)),
    /** { agent, runtime?, model?, effort?, access?, cwd, instructions, skills, pins, env, mcp, web, title, of, reuse? } → { id, reused } */
    openSession: async ({ agent: id, ...rest }) => {
      const a = id ? agent(String(id)) : null
      if (!a && !rest.reuse) throw fail('noAgent', { agent: id }, `no agent "${id}" in the pool`)
      if ((rest.runtime || a?.runtime) === 'dsh') throw fail('sessionDsh', { agent: a?.id }, 'a session takes Claude Code, Codex or pi')
      if (rest.cwd) mkdirSync(rest.cwd, { recursive: true })
      return agentSessions.open({ agent: a, ...rest })
    },
    /**
     * A message, its turn waited for: → { output, tokens, cost, usage, cli }; a failed turn rejects with its code —
     * cancelled, timeout, processExited, turnFailed (the CLI's own words: FALLBACK_ON reads them), or a start's own.
     * opts: { signal, onEvent(e), timeoutMs, of }
     */
    askSession: async (id, text, opts = {}) => {
      const r = await agentSessions.ask(String(id), text, opts)
      if (r.error) throw Object.assign(new Error(r.error), { code: r.code || 'turnFailed', params: { session: String(id), cli: r.cli }, result: r })
      return r
    },
    readSession: (id, opts) => agentSessions.read(String(id), opts),
    closeSession: id => agentSessions.close(String(id)),
    // skill packs: a plugin registers the skills it ships (bundled) or a team repository it needs (git); the
    // workbench asks where a pack is (its pinned snapshot, fetched when there is none) and which version
    registerSkillPack: pack => skillPacks.register(pack),
    // what a plugin uses skills for, shown with each skill on the Skills page: fn → [{ ref: 'pack/skill', by, where: { en, zh } }]
    registerSkillUses: fn => { skillUses.add(fn); return () => skillUses.delete(fn) },
    // which agents a plugin uses, for what: fn → [{ agent, by, where: { en, zh } }] (shown with each agent; an agent in use is not deleted)
    registerAgentUses: fn => { agentUses.add(fn); return () => agentUses.delete(fn) },
    skillPolicy: () => skillPacks.policy(),
    /** The skills a step or an agent can be given here: pack/skill first, then the workspace's and this machine's. */
    skills: cwds => skillPacks.catalog(cwds),
    skillPackDir: id => skillPacks.dirOf(id),
    // a workflow's packs (design: workflow = 总览): what it carries for them, how its skills stand here, fetching its pins
    skillPins: (ids, refs) => skillPacks.pins(ids, refs),
    skillCheck: (refs, pins) => skillPacks.check(refs, pins),
    skillEnsure: pins => skillPacks.ensurePins(pins),
    skillPackVersion: id => skillPacks.version(id),
    agents: () => agents(),
    agent: id => agent(id) || null,
    defaultAgent: () => defaultAgent() || null,
    /** "provider/model" of the default agent ('' — none: dsh's default model): what an assistant or an AI helper runs on. */
    defaultModel: () => defaultAgent()?.model || '',
    /** The main agent (any runtime; none chosen: the default agent) — the chat, ⌘K and voice go to it. */
    mainAgent: () => mainAgent() || null,
    /** "provider/model" for Ruyix's own small jobs ('' — dsh's default model): follows the main agent unless set apart. */
    mainModel: () => mainModel(),
    /** Whether the person chose the main agent (else a conversation's older pick may be carried over once). */
    mainChosen: () => !!config().mainChosen,
    setMain: args => ops.mainSet(args),
    /**
     * One turn of a conversation on a CLI agent of the pool (Claude Code, Codex) — no job, no task: the workbench's Chat.
     * Read-only (it looks, it does not change files); resume: the CLI's session to go on with (its history and
     * instructions); mcp: the conversation's tools; onEvent(e): each event as it comes (dsh's shapes: tool/call,
     * assistant/message). → { sessionId, output, error }
     */
    async chatTurn({ agent: id, cwd, instructions, prompt, resume = null, mcp = null, skills: extra = [], signal, onEvent = () => {} }) {
      const m = agent(String(id))
      if (!m) throw fail('noAgent', { agent: id }, `no agent ${id}`)
      if (!CHAT_RUNTIMES.includes(m.runtime)) throw fail('chatRuntime', { runtime: m.runtime }, 'a conversation runs on dsh, Claude Code, Codex or pi')
      const bin = which(m.runtime)
      if (!bin) throw fail('cliNotInstalled', { cli: CLI[m.runtime].name }, `${CLI[m.runtime].name} is not installed (Agents → Runtimes installs it)`)
      await checkCodexSandbox([{ ...m, access: 'read' }])
      // the agent's own skills and the conversation's (`skills`: the main agent's), as a member task gets them: Claude Code
      // natively (a plugin of this session), Codex as text
      const found = (await skillPacks.resolve([...new Set([...(m.skills || []), ...extra])], cwd)).filter(s => !s.missing)
      const native = m.runtime === 'claude'
      const skills = native ? found : await Promise.all(found.map(async s => ({ ...s, body: (await readFile(join(s.dir, 'SKILL.md'), 'utf8').catch(() => '')).slice(0, 20000) })))
      const told = skills.length ? [instructions, `## Your skills\n${skills.map(s => `- ${s.name} (${s.ref}): ${s.description || ''} — files in ${s.dir}`).join('\n')}`, ...skills.filter(s => s.body).map(s => `## Skill: ${s.name}\n\n${s.body}`)].join('\n\n') : instructions
      const pluginDir = native && found.length ? skillPlugin(found) : null
      // the MCP server's token rides a 0600 file (in a 0700 dir), never the CLI's command line; pi's folder, an endpoint
      const isolated = !skillPacks.policy().local
      const run = await prepareCli(m, [mcp, browserFor(agent(id), { who: 'main', title: 'main agent', of: null, dirs: [cwd] }), webFor(agent(id))], isolated)
      const { args, input } = cliCommand(m.runtime, { isolated, model: m.model, effort: m.effort, access: 'read', instructions: told, task: prompt, cwd, mcp: run.mcp, resume, pluginDir, endpoint: run.endpoint })
      let sessionId = resume, output = '', error = '', warning = '', tokens = 0, cost = null // (what it used, as the CLI counts it so far)
      const runEnv = await runtimeEnv(m.runtime)
      const { code, stderr } = await runCli(m.runtime, {
        bin, cwd, args, input, signal, codexHome: isolated ? codexHomeIn(store.dir) : undefined, env: { ...(runEnv || {}), ...run.env },
        onLine(r) {
          for (const e of r.events) { try { onEvent(e) } catch { /* the listener's own trouble */ } }
          if (r.sessionId) sessionId = r.sessionId
          if (r.output !== undefined) output = r.output
          if (r.error) error = r.error
          if (r.warning) warning = r.warning
          if (Number(r.tokens) > tokens) tokens = Number(r.tokens)
          if (Number.isFinite(r.cost)) cost = r.cost
        },
      }).finally(() => { for (const d of [run.dir, pluginDir]) if (d) rmSync(d, { recursive: true, force: true }) })
      if (!error && code !== 0) error = signal?.aborted ? 'cancelled' : warning || say(stderr, 2000) || `${m.runtime} exited with code ${code}`
      return { sessionId, output, error: error || undefined, tokens, ...(cost !== null && { cost }) }
    },
    /** Agents a plugin needs, added once each (one a person deleted or edited stays so). */
    /** `thirdParty`: a pack not shipped with Ruyix — its agents come without the agents' browser (the person may turn it on). */
    ensureAgents(defs, { thirdParty = false } = {}) {
      const seeded = new Set(config().seeded || [])
      for (const d of defs) {
        if (seeded.has(d.id)) continue
        const a = agent(d.id)
        if (!a) store.putDoc('agent', { ...normalizeAgent({ ...d, ...(thirdParty && { browser: false }) }), createdAt: Date.now() })
        // the same agent, joined from an old team before the plugin asked: it takes the plugin's name and notes
        else if (a.name === a.id && !a.notes && sameAgent(a, normalizeAgent(d))) store.putDoc('agent', { ...a, name: normalizeAgent(d).name, notes: normalizeAgent(d).notes })
        seeded.add(d.id)
      }
      setConfig({ seeded: [...seeded] })
    },
    /** A plugin's choice of default agent (a dsh agent of the pool), taken only while a person has chosen none. */
    suggestDefaultAgent(id) {
      const a = agent(id)
      if (!config().defaultChosen && !defaultAgent() && a?.runtime === 'dsh') setConfig({ defaultAgent: a.id })
      return defaultAgent()?.id || null
    },
    /** The pool's agent that runs like this spec (an old team member's), added when there is none: its id. */
    adoptAgent: spec => adoptAgent(spec).id,
    checkAgents: (ids, opts) => checkAgents(ids, opts),
    /** An old team, by name (a plugin moving its old crew settings to agents). */
    legacyTeam: name => store.docs('team').find(t => !t.deleted && t.name.toLowerCase() === String(name || '').toLowerCase()) || null,
    // a configuration's agents, taken in now (they are also at every start)
    takeImported: () => takeImported(),
    importing: () => !!takingImports,
    startJob: args => startJob(args),
    assign: (jobId, args, { by = 'service', ...extra } = {}) => assign(String(jobId), args, by, extra),
    task: id => store.getDoc('task', id),
    tasksOf: jobId => tasksOf(jobId),
    /** Every task that ran, or still runs, since a time (ms epoch): what the insights count. */
    tasks: since => store.docs('task').filter(t => t.status === 'running' || (t.endedAt || t.createdAt || 0) >= (Number(since) || 0)),
    /** The resident sessions (not removed), the latest used first: the workbench's records list them. */
    sessions: () => agentSessions.list(),
    job: id => job(id),
    whenTaskDone: id => whenDone('task', id).then(() => store.getDoc('task', id)),
    cancelTask: id => cancel(String(id), 'lead'),
    finishJob: (id, patch = {}) => { const j = job(id); if (j && j.status === 'running') finishJob({ ...j, status: 'done', ...patch }); return job(id) },
    stopJob: id => stopJob(String(id)),
    // A follow-up for a job's Lead (queued when it is idle, steering when it works).
    message: (jobId, text) => ops.message({ sessionId: job(String(jobId))?.leadId, text }),
    // What a dsh restart would cut short now (ruyix upgrade waits until it is empty).
    busy: () => [
      ...store.docs('job').filter(j => j.status === 'running').map(j => `Agent Hub job ${j.id}: running`),
      ...store.docs('task').filter(t => ['running', 'queued'].includes(t.status)).map(t => `Agent Hub task ${t.id} (${t.member || '?'}): ${t.status}`),
    ],
    // The pool's CLI runtimes are required: a job's Lead may assign any agent, a workflow step names one.
    setup: async () => (await signIns()).map((x, i) => {
      const name = CLI[x.runtime]?.name || x.runtime
      const where = x.box ? { en: 'on the host (not in this box): the login runs inside the box, the tokens stay in the host\'s vault', zh: '在主机上运行（不是在这个 box 里）：登录在 box 里进行，令牌留在主机的 vault' } : { en: 'in a terminal on this machine', zh: '在这台机器的终端里运行' }
      const detail = x.status === 'ready'
        ? { en: 'Installed and signed in; provider availability is checked when a task runs', zh: '已安装并登录；任务运行时检查服务是否可用' }
        : x.status === 'missing' ? { en: 'Not installed: Agents → Runtimes installs it, then sign in', zh: '还没安装：在「智能体 → 运行时」安装，然后登录' }
          : x.status === 'unauthenticated' ? { en: 'Installed, not signed in', zh: '已安装，尚未登录' }
            : { en: 'Could not verify sign-in; update the CLI and sign in again', zh: '无法确认登录状态；请更新 CLI 后重新登录' }
      // not ready: the command that signs it in, where to run it (a box's agents sign in from its host: nookbox login)
      return { id: { claude: 'claude-code', codex: 'codex-cli', pi: 'pi-cli' }[x.runtime] || x.runtime, order: 40 + i, required: true, installed: x.installed, authenticated: x.authenticated, ready: x.ready, status: x.status,
        panel: 'agent-hub', title: { en: name, zh: name }, detail, ...(!x.ready && x.status !== 'missing' && { command: { text: x.command, where } }) }
    }),
  })

  // Agents a configuration brought (ruyix config import → <hub home>/import/*.agents.json; an older configuration's
  // *.team.json), taken in at start; each file then moves to import/done.
  const readImported = async () => {
    const report = skillPacks.takeImport()
    if (report.some(r => !r.ok)) { ctx.logger?.warn?.(report.filter(r => !r.ok).map(r => r.text).join('; ')); return report }
    const dir = join(store.dir, 'import')
    let files = []
    try { files = [...new Set(readdirSync(dir).filter(f => /\.(agents|team)\.json(?:\.processing)?$/.test(f)).map(f => f.replace(/\.processing$/, '')))] } catch { return report }
    for (const f of files) {
      try {
        const staged = join(dir, f), active = `${staged}.processing`
        if (existsSync(staged)) renameSync(staged, active) // a newer file supersedes an interrupted retry
        const r = await importShared(readFileSync(active, 'utf8'))
        mkdirSync(join(dir, 'done'), { recursive: true })
        renameSync(active, join(dir, 'done', f))
        ctx.logger?.info?.(`agent-hub: agents ${r.agents.join(', ')} from ${f}${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}`)
        report.push({ ok: true, text: `Agent Hub agents from ${f}: ${r.agents.join(', ')}` })
      } catch (err) {
        ctx.logger?.warn?.(`agent-hub: agents file ${f}: ${err?.message || err}`)
        report.push({ ok: false, text: `Agent Hub agents from ${f}: ${err?.message || err}` })
      }
    }
    return report
  }
  const takeImported = () => {
    if (!takingImports) takingImports = readImported().finally(() => { takingImports = null })
    return takingImports
  }
  const imported = takeImported()

  // the agent pool as the shell's system tools (agent-tools.js): see, add, change, take out, the default (after ops: they use them)
  ctx.inject?.(['ruyixShell'], inner => {
    const sh = inner.ruyixShell
    if (!sh?.systemTools) return
    for (const tool of [...agentTools({ ops, agent, agents, config, store }), ...skillTools({ skills: skillPacks, pack: mine, reregister: registerMine })]) inner.effect(() => sh.systemTools.register(tool), `agent-hub: tool ${tool.name}`)
  })
  ctx.connection.fetch.register({
    path: '/api/agent-hub',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const { op, ...args } = await request.json()
        if (!Object.hasOwn(ops, op)) return Response.json({ error: `unknown op ${op}` }, { status: 400 })
        return Response.json(await ops[op](args))
      } catch (err) {
        return Response.json({ error: err?.message || String(err), code: err?.code, params: err?.params }, { status: 500 })
      }
    },
  })
}
