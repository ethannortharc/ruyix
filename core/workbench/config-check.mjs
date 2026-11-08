// The workbench's configuration check: the settings model (core keys, a block per pack, the file keeps only what differs),
// workflow definitions against their base (the window for a person's steps, the cwd values, the connection levels), the
// request form, the ledger. No network, no dsh.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultsOf, expand, loadSettings, saveSettings, settingsFile, sh } from './lib/settings.js'
import { LIMITS, checkFields, checkInput, decodeAttachments, mimeOf } from './lib/subject.js'
import { openStore, sha256 } from './lib/store.js'
import { ALWAYS, TOOLS, callTool, toolDefs, validateStageResult } from './lib/tools.js'
import { GENERIC, compose, createScripts, createStore as createWorkflowStore, flatSteps, holds, library, outline, secretsOf, validate } from './lib/workflows.js'
import { definePack } from './pack.js'
import { checkSchema, createModels, jsonOf, parseModelRef } from './lib/models.js'
import { createBindings, keyOf, missingText, needsOf, packIdsOf, pinsOf, readiness, skillRefsOf } from './lib/needs.js'
import { ASKED, ASKS, WAIT, answerOf, cardOf, guidanceText } from './lib/person.js'
import { revisionStep, revisionSteps, stepsBack } from './lib/review.js'
import { HELP_ROUNDS, WAIT_HOURS, chatBrief, humanOf, needPerson, scoreOf } from './lib/human.js'
import { callLog, aiWork } from './lib/aiwork.js'
import { complete } from './lib/llm.js'
import { blocking, blocksWork, entriesOf, groupsOf, needsCount, overdue, remindersOf, toneOf } from './src/inbox.js'
import { handlesOf } from './src/wf-model.js'
import { ASK_EVENT, REFRESH_EVENT, STATE_EVENT, createChatState } from './src/chat-state.js'
import { modelSteps, stepAgent, stepAgents, stepModel, workflowAgents, workflowInfo } from './lib/workflow-info.js'
import blank from './workflows/blank.js'
import { intake, report, renderReport } from './workflows/common.js'

const tmp = mkdtempSync(join(tmp0(), 'ruyix-workbench-config-'))
function tmp0() { return tmpdir() }
try {
  // ── settings ──
  const file = settingsFile(tmp)
  assert.equal(file, join(tmp, 'settings.json'))
  const packs = [{ id: 'notes', settings: { greeting: 'hello', limits: { chars: 500 }, tags: ['a'], free: {} } }]
  const d = defaultsOf(packs)
  assert.deepEqual(Object.keys(d).sort(), ['agentTimeoutMinutes', 'autoResume', 'chat', 'model', 'packs', 'stages', 'steps', 'workspace'])
  assert.ok(!('envs' in d) && !('defaultEnv' in d) && !('repo' in d) && !('autoRollback' in d), 'no lab and no code settings in the core')
  assert.deepEqual(d.packs, { notes: packs[0].settings }, 'a pack\'s defaults sit under packs.<id>')
  assert.notEqual(d.packs.notes, packs[0].settings, '… as a copy')
  assert.deepEqual(loadSettings(file, packs), d, 'no file: the defaults')
  assert.deepEqual(loadSettings(file, []).packs, {}, 'no pack: no block')

  const saved = saveSettings({ ...d, workspace: '~/work', agentTimeoutMinutes: 20, packs: { notes: { ...d.packs.notes, limits: { chars: 100 }, free: { anything: [1, 2] } } } }, file, packs)
  assert.equal(saved.workspace, '~/work')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { workspace: '~/work', agentTimeoutMinutes: 20, packs: { notes: { limits: { chars: 100 }, free: { anything: [1, 2] } } } }, 'the file keeps only what differs from the defaults')
  const back = loadSettings(file, packs)
  assert.equal(back.agentTimeoutMinutes, 20)
  assert.equal(back.autoResume.maxPerRun, 2, 'what the file does not say stays the default (deeply)')
  assert.deepEqual(back.packs.notes.free, { anything: [1, 2] }, 'a block the defaults leave empty is a map of its own')
  assert.equal(back.packs.notes.greeting, 'hello')
  assert.equal(expand('~/x'), join(homedir(), 'x'))
  assert.equal(expand('/abs'), '/abs')
  // a pack that is not loaded: its block stays in the file, and comes back with it
  const away = saveSettings({ ...back, packs: { notes: back.packs.notes, ghost: { n: 1 } } }, file, packs)
  assert.deepEqual(away.packs.ghost, { n: 1 })
  assert.deepEqual(loadSettings(file, []).packs.ghost, { n: 1 }, 'a block of a pack that is not loaded is kept as it is')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).packs.ghost.n, 1)
  saveSettings(back, file, packs)
  const bad = value => { try { saveSettings(value, file, packs); return '' } catch (err) { return err.message } }
  assert.match(bad({ ...d, repo: 'x' }), /unknown setting repo/)
  assert.match(bad({ ...d, envs: [] }), /unknown setting envs/)
  assert.match(bad({ ...d, agentTimeoutMinutes: '5' }), /agentTimeoutMinutes must be a number/)
  assert.match(bad({ ...d, agentTimeoutMinutes: 0 }), /agentTimeoutMinutes must be 1–1440/)
  assert.match(bad({ ...d, autoResume: { enabled: 'yes' } }), /autoResume\.enabled must be a boolean/)
  assert.match(bad({ ...d, chat: { ...d.chat, idleHours: 0 } }), /chat: idleHours is above 0/)
  assert.match(bad({ ...d, chat: { ...d.chat, maxTasks: 0 } }), /maxTasks 1–10/)
  assert.match(bad({ ...d, chat: { ...d.chat, maxTasks: 'x' } }), /chat\.maxTasks must be a number/)
  assert.deepEqual(d.chat, { idleHours: 6, keepDays: 90, maxTasks: 3, answerOpen: 'leaf' })
  assert.match(bad({ ...d, chat: { ...d.chat, answerOpen: 'popup' } }), /answerOpen is leaf, drawer or window/)
  assert.match(bad({ ...d, autoResume: { nope: 1 } }), /unknown setting autoResume\.nope/)
  assert.match(bad({ ...d, autoResume: { ...d.autoResume, maxAgeHours: 0 } }), /maxAgeHours must be above 0/)
  assert.match(bad({ ...d, packs: { notes: { greeting: 4 } } }), /packs\.notes\.greeting must be a string/)
  assert.match(bad({ ...d, packs: { notes: { limits: { chars: 'x' } } } }), /packs\.notes\.limits\.chars must be a number/)
  assert.match(bad({ ...d, packs: { notes: { tags: [1] } } }), /packs\.notes\.tags must be a list of strings/)
  assert.match(bad({ ...d, packs: { notes: { other: 1 } } }), /unknown setting packs\.notes\.other/)
  assert.match(bad({ ...d, packs: 'x' }), /packs must be an object/)
  assert.match(bad({ ...d, workspace: 4 }), /workspace must be a string/)
  assert.match(bad(null), /settings must be an object/)
  // which agent does a step, and which steps are on
  assert.equal(bad({ ...d, steps: { 'notes.publish': { draft: { agent: 'opus', fallback: '', skills: ['notes/style'] } } } }), '')
  assert.match(bad({ ...d, steps: { 'notes.publish': { draft: { agent: 'No Good' } } } }), /steps\.notes\.publish\.draft\.agent: an agent id/)
  assert.match(bad({ ...d, steps: { 'notes.publish': { draft: { agent: 'opus', mode: 'x' } } } }), /unknown field/)
  assert.match(bad({ ...d, steps: { 'notes.publish': { draft: { skills: Array(11).fill('a/b') } } } }), /up to 10 skills/)
  assert.match(bad({ ...d, steps: { __proto__x: {} } }), /steps maps each workflow to its steps/)
  assert.match(bad({ ...d, steps: { wf: 'x' } }), /steps maps each workflow to its steps/)
  assert.equal(bad({ ...d, stages: { review: false } }), '')
  assert.match(bad({ ...d, stages: { review: 'no' } }), /stages turns each optional step on or off/)
  assert.deepEqual(loadSettings(file, packs).stages, { review: false })
  rmSync(file)
  writeFileSync(file, '{ not json')
  assert.throws(() => loadSettings(file, packs), { code: 'badState' }, 'a damaged file must not silently become defaults')
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'the damaged state stays available for recovery')
  rmSync(file)

  // ── the run's commands ──
  const r = await sh('bash', ['-c', 'echo out; echo err >&2; exit 3'], { cwd: tmp })
  assert.deepEqual([r.code, r.stdout, r.stderr], [3, 'out\n', 'err\n'])
  assert.equal((await sh('bash', ['-c', 'cat'], { input: 'in' })).stdout, 'in')
  assert.equal((await sh('no-such-command-here', [])).code, -1)
  assert.equal((await sh('bash', ['-c', 'sleep 5'], { timeout: 100 })).code, 124)
  assert.equal((await sh('bash', ['-c', 'echo $RUYIX_X'], { env: { RUYIX_X: 'v' } })).stdout, 'v\n')
  // stopped: what the command started goes with it (a grandchild that ignores SIGTERM too, killed hard after 3 s)
  if (process.platform !== 'win32') {
    const ac = new AbortController(), pidFile = join(tmp, 'grandchild.pid')
    const running = sh('bash', ['-c', `(trap '' TERM; sleep 60) & echo $! > ${pidFile}; wait`], { signal: ac.signal, timeout: 30000 })
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 50))
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    ac.abort()
    const r = await running
    assert.equal(r.code, 130, r.stderr)
    assert.match(r.stderr, /\(stopped\)/)
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/, 'nothing of what it started is left')
  }

  // ── workflows: a definition against its base ──
  const bases = { blank, 'p.flow': compose({ id: 'p', title: 'P', steps: [] }, blank) }
  const agentRole = { agent: 'writer', access: 'write', text: 'Writes.' }
  const step = (key, extra = {}) => ({ key, owner: 'system', title: key, run: async () => ({ ok: true }), ...extra })
  bases['p.flow'] = { id: 'p.flow', title: 'Flow', pack: 'p', roles: { w: agentRole }, success: 'sent', insertFrom: 'draft', report: renderReport, actions: {},
    stages: [intake, step('brief'), step('draft', { owner: 'w' }), step('polish', { owner: 'w', optional: true }), step('send'), report] }
  const ctx = { bases, builtIn: Object.keys(bases), agents: ['writer', 'checker'], connectors: ['api'], scripts: ['lint@1.0.0'], tools: [...ALWAYS, 'p_tool'] }
  const v = (def, c = ctx) => validate(def, c)
  const msgs = (def, c) => v(def, c).errors.map(e => e.message)
  const on = (base, steps, extra = {}) => ({ id: 'mine', title: 'Mine', base, steps, ...extra })
  const sc = (id, extra = {}) => ({ id, use: 'script', title: id, run: 'true', ...extra })
  const ag = (id, extra = {}) => ({ id, use: 'agent', title: id, agent: 'writer', instructions: 'Do it.', ...extra })

  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, { use: 'report' }])), [])
  assert.deepEqual(GENERIC, ['agent', 'model', 'script', 'approval', 'person', 'output', 'branch', 'parallel', 'flow'])
  // the window: after the first step by default, before the first closing step
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, sc('one'), ag('two'), { id: 'ok', use: 'approval', title: 'OK', text: 'Fine?' }, { use: 'report' }])), [])
  assert.match(msgs(on('blank', [sc('first'), { use: 'intake' }, { use: 'report' }])).join(), /first must come after intake/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, { use: 'report' }, sc('last')])).join(), /last must come after intake and before report/)
  // insertFrom: the base says after which of its steps a person's steps may go
  const flow = ['intake', 'brief', 'draft', 'polish', 'send', 'report'].map(use => ({ use }))
  assert.deepEqual(msgs(on('p.flow', flow)), [])
  assert.deepEqual(msgs(on('p.flow', [...flow.slice(0, 3), sc('extra'), ...flow.slice(3)])), [])
  assert.match(msgs(on('p.flow', [...flow.slice(0, 2), sc('early'), ...flow.slice(2)])).join(), /early must come after draft and before report/)
  assert.deepEqual(msgs(on('p.flow', [...flow.slice(0, 5), sc('late'), flow[5]])), [], 'right before the closing step is fine')
  assert.match(msgs(on('p.flow', flow.filter(s => s.use !== 'draft'))).join(), /draft is a required step of p\.flow/)
  assert.deepEqual(msgs(on('p.flow', flow.filter(s => s.use !== 'polish'))), [], 'an optional step may be left out')
  assert.match(msgs(on('p.flow', [flow[0], flow[2], flow[1], ...flow.slice(3)])).join(), /brief comes before draft in p\.flow: base steps keep their order/)
  assert.match(msgs(on('p.flow', [...flow, flow[1]])).join(), /brief is listed twice/)
  assert.match(msgs(on('nothing', [])).join(), /the base is one of blank, p\.flow/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, { id: 'x1', use: 'worktree' }, { use: 'report' }])).join(), /"worktree" is not a step of blank nor one of agent, model, script/)
  // the base's agent steps: their picks
  assert.deepEqual(v(on('p.flow', flow.map(s => (s.use === 'draft' ? { ...s, agent: 'checker', fallback: 'writer', skills: ['ps/style'] } : s)))).def.steps[2], { use: 'draft', agent: 'checker', fallback: 'writer', skills: ['ps/style'] })
  assert.match(msgs(on('p.flow', flow.map(s => (s.use === 'draft' ? { ...s, agent: 'ghost' } : s)))).join(), /no agent "ghost" in the agent pool/)
  assert.deepEqual(v(on('p.flow', flow.map(s => (s.use === 'brief' ? { ...s, agent: 'ghost' } : s)))).def.steps[1], { use: 'brief' }, 'a system step takes no agent')
  // ids
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('x'), { use: 'report' }])).join(), /a step id is 2–40/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('report'), { use: 'report' }])).join(), /the step id "report" is taken/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('approval'), { use: 'report' }])).join(), /"approval" is taken/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('note'), { use: 'report' }])).join(), /"note" is taken/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('dup'), sc('dup'), { use: 'report' }])).join(), /"dup" is taken/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, { use: 'report' }], { id: 'blank' })).join(), /"blank" is a built-in workflow/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, { use: 'report' }], { id: 'p.flow' })).join(), /2–40 lowercase letters/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, { use: 'report' }], { id: 'Bad Id' })).join(), /2–40 lowercase letters/)
  // script steps: where they run, which connections, installed scripts
  assert.equal(v(on('blank', [{ use: 'intake' }, sc('here'), { use: 'report' }])).def.steps[1].cwd, 'run', 'a script runs in the run\'s folder unless it says workspace')
  assert.equal(v(on('blank', [{ use: 'intake' }, sc('there', { cwd: 'workspace' }), { use: 'report' }])).def.steps[1].cwd, 'workspace')
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('wt', { cwd: 'worktree' }), { use: 'report' }])).join(), /cwd is run or workspace/)
  assert.deepEqual(v(on('blank', [{ use: 'intake' }, sc('api', { connectors: { api: 'write' } }), { use: 'report' }])).def.steps[1].connectors, { api: 'write' })
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('lab', { connectors: { api: 'lab' } }), { use: 'report' }])).join(), /api: the level is read or write/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('nc', { connectors: { nope: 'read' } }), { use: 'report' }])).join(), /no connector "nope"/)
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, { id: 'inst', use: 'script', title: 'I', script: 'lint@1.0.0', args: ['a'] }, { use: 'report' }])), [])
  assert.match(msgs(on('blank', [{ use: 'intake' }, { id: 'inst', use: 'script', title: 'I', script: 'lint@2.0.0' }, { use: 'report' }])).join(), /lint@2\.0\.0 is not installed/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, { id: 'inst', use: 'script', title: 'I', script: 'lint' }, { use: 'report' }])).join(), /named name@version/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, { id: 'norun', use: 'script', title: 'N' }, { use: 'report' }])).join(), /needs the command to run/)
  // agent steps
  assert.match(msgs(on('blank', [{ use: 'intake' }, ag('noins', { instructions: '' }), { use: 'report' }])).join(), /needs instructions/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, ag('noag', { agent: undefined }), { use: 'report' }])).join(), /the agent is an agent of the pool/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, ag('tl', { tools: ['bash'] }), { use: 'report' }])).join(), /unknown tools: bash/)
  assert.deepEqual(v(on('blank', [{ use: 'intake' }, ag('tl', { tools: ['p_tool', 'wb_context', 'file_save'] }), { use: 'report' }])).def.steps[1].tools, ['p_tool'], 'the core six are always there, not listed')
  assert.equal(v(on('blank', [{ use: 'intake' }, ag('ro'), { use: 'report' }])).def.steps[1].access, 'read')
  // a script step (lib/flow): its script checked, never run; the agents it asks by role; its scripts; its parameters
  {
    const fl = (id, extra = {}) => ({ id, use: 'flow', title: id, source: "const r = await wf.step('a', s => s.agent('coder', 'x'))\nreturn r", agents: { coder: { agent: 'writer', access: 'write' } }, ...extra })
    const flow = (steps, c) => msgs(on('blank', [{ use: 'intake' }, ...steps, { use: 'report' }]), c).join(' | ')
    assert.equal(flow([fl('f1')]), '')
    const made = v(on('blank', [{ use: 'intake' }, fl('f1', { params: { n: { title: 'N', default: 3 }, 'bad name': {}, ok: { default: { x: 1 } } }, cli: ['jq'], onFail: 'continue', agents: { coder: { agent: 'writer', fallback: 'checker', access: 'bogus', instructions: 'Code.' } } }), { use: 'report' }]))
    assert.deepEqual(made.errors.map(e => e.message), ['"bad name" is not a parameter name'])
    assert.deepEqual([made.def.steps[1].params, made.def.steps[1].agents, made.def.steps[1].cli, made.def.steps[1].onFail], [{ n: { title: 'N', default: 3 }, ok: { title: '', default: null } }, { coder: { agent: 'writer', fallback: 'checker', access: 'read', instructions: 'Code.' } }, ['jq'], 'continue'])
    assert.match(flow([fl('f1', { agents: { coder: { agent: 'ghost' } } })]), /no agent "ghost" in the agent pool/)
    assert.match(flow([fl('f1', { agents: {} })]), /the script asks the agent "coder": add it to the step's agents/)
    assert.match(flow([fl('f1', { agents: { 'Bad Role': { agent: 'writer' }, coder: { agent: 'writer' } } })]), /"Bad Role" is not a role name/)
    assert.match(flow([fl('f1', { source: "await wf.step('a', () => Date.now())" })]), /the clock and Math\.random would make a resumed run decide differently/)
    assert.match(flow([fl('f1', { source: 'return 1' })]), /names no step/)
    assert.match(flow([fl('f1', { source: "await wf.step('a', s => s.script('lint@2.0.0', []))", agents: {} })]), /the script lint@2\.0\.0 is not installed here/)
    assert.equal(flow([fl('f1', { source: "await wf.step('a', s => s.script('lint@1.0.0', []))", agents: {} })]), '')
    // on the main line only; a branch may read what it handed back
    assert.match(msgs(on('blank', [{ use: 'intake' }, { id: 'br', use: 'branch', title: 'B', mode: 'condition', routes: [{ id: 'r1', label: 'R', when: { step: 'intake', is: 'passed' }, steps: [fl('inner')] }], otherwise: { label: 'O', steps: [] } }, { use: 'report' }])).join(), /a route holds agent, model, script, approval, person and output steps, not "flow"/)
    assert.match(msgs(on('blank', [{ use: 'intake' }, { id: 'par', use: 'parallel', title: 'P', lanes: [{ id: 'a', label: 'A', steps: [fl('inner')] }, { id: 'b', label: 'B', steps: [ag('x')] }] }, { use: 'report' }])).join(), /a parallel lane holds agent, model and script steps, not "flow"/)
    assert.equal(flow([fl('f1'), { id: 'br', use: 'branch', title: 'B', mode: 'condition', routes: [{ id: 'r1', label: 'R', when: { output: 'f1', has: 'ok' }, steps: [] }], otherwise: { label: 'O', steps: [] } }]), '')
    // the engine's view: a stage of the workflow, each role an agent of its own, the tools every agent has and no more
    const fw = compose(made.def, blank), fs = fw.stages.find(x => x.key === 'f1')
    assert.deepEqual([fs.generic, fs.owner, fs.flowRoles, fs.tools, fw.roles['f1.coder'].agent, fw.roles['f1.coder'].text, workflowAgents(fw, {}).sort()], ['flow', 'system', ['coder'], [], 'writer', 'Code.', ['checker', 'writer']])
    assert.equal(stepAgent(fw, 'f1', {}, 'f1.coder').fallback, 'checker')
    // readiness: each role's agent (its fallback gives way) and the scripts the script runs
    const rd = await readiness({ id: 'x', steps: [{ id: 'f1', use: 'flow', source: "await wf.step('a', s => s.script('lint@1.0.0'))\nawait wf.step('b', s => s.script('fmt@1.0.0'))", agents: { coder: { agent: 'ghost', fallback: 'writer' }, other: { agent: 'writer' } } }] },
      { agents: ['writer'], skills: async () => [], connections: [], bindings: createBindings(join(tmp, 'flow-bindings.json')), scripts: ['lint@1.0.0'], base: {} })
    assert.deepEqual(rd.steps[0].items.map(i => `${i.kind}:${i.ref}:${i.status}`), ['agent:ghost:missing', 'agent:writer:ok', 'agent:writer:ok', 'script:lint@1.0.0:ok', 'script:fmt@1.0.0:missing'], 'a role\'s agent, its fallback, another role\'s agent; the scripts it runs')
    // the editor's block is valid as it comes (its agent picked), and drawn as a step of its own
    const { PRESETS, blockStep, blockItem, layout: lay } = await import('./src/wf-model.js')
    const bs = blockStep(PRESETS.find(p => p.key === 'flow'), { taken: new Set(), title: 'Drive', agent: 'writer' })
    assert.deepEqual([bs.id, bs.use, Object.keys(bs.agents), bs.agents.coder.agent], ['flow-1', 'flow', ['coder'], 'writer'])
    assert.equal(flow([bs]), '', 'the template checks out')
    assert.ok(lay([blockItem(bs)]).nodes.some(nd => nd.it?.step?.id === 'flow-1'))
  }
  // the way back and the ways out
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, sc('a1'), sc('b1', { onFail: { goto: 'a1', max: 2 } }), { use: 'report' }])), [])
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1', { onFail: { goto: 'a1' } }), { use: 'report' }])).join(), /back to "a1", which is not a step before it/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1'), sc('b1', { onFail: { goto: 'later' } }), sc('later'), { use: 'report' }])).join(), /"later", which is not a step before it/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1', { onFail: 'sometimes' }), { use: 'report' }])).join(), /on failure: "stop", "continue"/)
  assert.equal(v(on('blank', [{ use: 'intake' }, sc('a1', { onFail: { goto: 'intake', max: 99 } }), { use: 'report' }])).def.steps[1].onFail.max, 10, 'a loop has a count, at most 10')
  // branches: routes by condition or by an agent; back
  const branch = (extra = {}) => ({ id: 'pick', use: 'branch', title: 'Pick', mode: 'condition', routes: [{ id: 'yes', label: 'Yes', when: { step: 'a1', is: 'passed' }, steps: [sc('r1')] }], otherwise: { label: 'No', steps: [] }, ...extra })
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, sc('a1'), branch(), { use: 'report' }])), [])
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1'), branch({ routes: [{ id: 'yes', label: 'Y', when: { step: 'ghost', is: 'passed' }, steps: [] }] }), { use: 'report' }])).join(), /looks at "ghost", which is not a step before the branch/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1'), branch({ routes: [{ id: 'yes', label: 'Y', when: { step: 'a1', is: 'failed' }, steps: [] }] }), { use: 'report' }])).join(), /waits for "a1" to fail/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1'), branch({ routes: [{ id: 'yes', label: 'Y', when: { mode: 'full' }, steps: [] }] }), { use: 'report' }])).join(), /a route needs a condition: \{ step, is \} \| \{ output, has \} \| \{ verdict \}/, 'there are no run modes any more')
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, sc('a1'), branch({ routes: [{ id: 'yes', label: 'Y', when: { verdict: 'done' }, steps: [] }] }), { use: 'report' }])), [], 'a verdict level is any word')
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, sc('a1'), branch({ routes: [{ id: 'yes', label: 'Y', when: { output: 'a1', has: 'ok' }, steps: [] }] }), { use: 'report' }])), [])
  assert.match(msgs(on('blank', [{ use: 'intake' }, branch({ mode: 'agent' }), { use: 'report' }])).join(), /the agent is an agent of the pool/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1'), branch({ routes: [{ id: 'yes', label: 'Y', when: { step: 'a1', is: 'passed' }, steps: [], back: { to: 'ghost' } }] }), { use: 'report' }])).join(), /goes back to "ghost"/)
  // a script that writes through a connection comes after a person's approval on its path
  const yes = (id = 'ok') => ({ id, use: 'approval', title: 'OK?', text: 'Write?' })
  const wr = (id = 'w1') => sc(id, { connectors: { api: 'write' } })
  assert.match(msgs(on('blank', [{ use: 'intake' }, wr(), { use: 'report' }])).join(), /w1 writes through a connection: put an approval step before it/)
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, yes(), wr(), { use: 'report' }])), [])
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, sc('reader', { connectors: { api: 'read' } }), { use: 'report' }])), [], 'reading needs no approval')
  assert.match(msgs(on('blank', [{ use: 'intake' }, wr(), yes(), { use: 'report' }])).join(), /w1 writes/, 'an approval after it is no use')
  const route = steps => branch({ routes: [{ id: 'yes', label: 'Y', when: { step: 'a1', is: 'passed' }, steps }] })
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, sc('a1'), yes(), route([wr()]), { use: 'report' }])), [], 'an approval before the branch is on the path of its routes')
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, sc('a1'), route([yes(), wr()]), { use: 'report' }])), [], 'or earlier in the route itself')
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1'), route([wr()]), { use: 'report' }])).join(), /w1 writes/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1'), branch({ routes: [{ id: 'yes', label: 'Y', when: { step: 'a1', is: 'passed' }, steps: [yes()] }], otherwise: { label: 'No', steps: [wr()] } }), { use: 'report' }])).join(), /w1 writes/, 'an approval in another route is not on its path')
  assert.match(msgs(on('blank', [{ use: 'intake' }, sc('a1'), route([yes()]), wr(), { use: 'report' }])).join(), /w1 writes/, '… nor after the branch')
  // parallel: read-only lanes
  const par = (lanes, extra = {}) => ({ id: 'fan', use: 'parallel', title: 'Fan', lanes, ...extra })
  const lane = (id, steps) => ({ id, label: id, steps })
  assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, par([lane('a', [ag('ra', { access: 'read' })]), lane('b', [sc('sb', { connectors: { api: 'read' } })])]), { use: 'report' }])), [])
  assert.match(msgs(on('blank', [{ use: 'intake' }, par([lane('a', [ag('ra')])]), { use: 'report' }])).join(), /2–5 lanes/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, par([lane('a', [ag('ra', { access: 'write' })]), lane('b', [sc('sb')])]), { use: 'report' }])).join(), /ra runs beside other lanes: give it read access/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, par([lane('a', [ag('ra')]), lane('b', [sc('sb', { connectors: { api: 'write' } })])]), { use: 'report' }])).join(), /sb runs beside other lanes: its connectors only read \(no write\)/)
  assert.match(msgs(on('blank', [{ use: 'intake' }, par([lane('a', [ag('ra')]), lane('b', [{ id: 'ap', use: 'approval', title: 'A', text: 'x' }])]), { use: 'report' }])).join(), /a parallel lane holds agent, model and script steps/)
  // compose: the steps in order, the base's, a branch's routes after it, a parallel block's lanes after it
  const defn = v(on('blank', [{ use: 'intake' }, sc('a1'), branch(), par([lane('a', [ag('ra', { access: 'read' })]), lane('b', [sc('sb')])]), { use: 'report' }])).def
  const wf = compose(defn, bases.blank)
  assert.deepEqual(wf.stages.map(s => s.key), ['intake', 'a1', 'pick', 'r1', 'fan', 'ra', 'sb', 'report'])
  assert.deepEqual([wf.id, wf.base, wf.title, wf.success, wf.def === defn], ['mine', 'blank', 'Mine', 'done', true], 'a person\'s workflow carries its base\'s success level')
  assert.equal(wf.stages.find(s => s.key === 'ra').par, 'fan')
  assert.equal(wf.stages.find(s => s.key === 'r1').lane, 'pick:0')
  assert.equal(wf.stages.find(s => s.key === 'pick').generic, 'branch')
  assert.equal(wf.roles.ra.agent, 'writer')
  assert.deepEqual(flatSteps(defn).map(s => s.id || s.use), ['intake', 'a1', 'pick', 'r1', 'fan', 'ra', 'sb', 'report'])
  const o = outline(wf)
  assert.deepEqual(o.map(s => s.key), wf.stages.map(s => s.key))
  assert.equal(o.find(s => s.key === 'report').final, true)
  const pwf = compose(v(on('p.flow', flow.map(s => (s.use === 'draft' ? { ...s, agent: 'checker' } : s)))).def, bases['p.flow'])
  assert.equal(pwf.success, 'sent')
  assert.equal(pwf.pack, 'p', 'a workflow on a pack\'s workflow belongs to that pack')
  assert.equal(pwf.insertFrom, 'draft')
  assert.deepEqual(pwf.stages.find(s => s.key === 'draft').pick, { agent: 'checker', fallback: undefined, skills: undefined })
  // what the base lists for the editor
  const lib = library(bases['p.flow'])
  assert.deepEqual(lib.map(s => s.key), ['intake', 'brief', 'draft', 'polish', 'send', 'report'])
  assert.deepEqual(lib.find(s => s.key === 'draft'), { key: 'draft', owner: 'w', optional: false, final: false, agent: agentRole, model: null })
  assert.equal(lib.find(s => s.key === 'polish').optional, true)
  assert.ok(lib.every(s => !('fullOnly' in s)))
  assert.equal(lib.find(s => s.key === 'brief').agent, null)
  // conditions
  const run = { stages: [{ key: 'a1', status: 'passed' }], outputs: { a1: { summary: 'All OK here' } }, verdict: { level: 'sent' } }
  assert.deepEqual([holds({ step: 'a1', is: 'passed' }, run), holds({ step: 'a1', is: 'failed' }, run), holds({ output: 'a1', has: 'all ok' }, run), holds({ output: 'a1', has: 'broken' }, run), holds({ verdict: 'sent' }, run), holds({ verdict: 'done' }, run), holds(null, run), holds({ mode: 'full' }, { mode: 'full' })], [true, false, true, false, true, false, false, false])

  // a person's workflows on disk; installed scripts
  const store = createWorkflowStore(tmp)
  assert.deepEqual(store.list(), [])
  const def = v(on('blank', [{ use: 'intake' }, sc('a1'), { use: 'report' }])).def
  store.put({ ...def, status: 'draft' })
  assert.equal(store.get('mine').status, 'draft')
  assert.ok(existsSync(join(tmp, 'workflows', 'mine.json')))
  assert.deepEqual(store.list().map(d => d.id), ['mine'])
  assert.equal(store.get('../x'), null)
  store.keep(def)
  assert.equal(store.list().length, 1, 'the history is not a workflow')
  writeFileSync(join(tmp, 'workflows', 'junk.json'), '{ nope')
  writeFileSync(join(tmp, 'workflows', 'other.json'), JSON.stringify({ kind: 'something-else', id: 'other' }))
  assert.deepEqual(store.list().map(d => d.id), ['mine'], 'files that are not workflows are left alone')
  store.remove('mine')
  assert.deepEqual(store.list(), [])
  mkdirSync(join(tmp, 'scripts', 'lint', '1.0.0'), { recursive: true })
  writeFileSync(join(tmp, 'scripts', 'lint', '1.0.0', 'manifest.json'), JSON.stringify({ name: 'lint', version: '1.0.0', entry: 'run.sh', description: 'lints' }))
  writeFileSync(join(tmp, 'scripts', 'lint', '1.0.0', 'run.sh'), 'echo lint')
  mkdirSync(join(tmp, 'scripts', 'bad', '1.0.0'), { recursive: true })
  writeFileSync(join(tmp, 'scripts', 'bad', '1.0.0', 'manifest.json'), JSON.stringify({ name: 'bad', version: '1.0.0', entry: '../escape.sh' }))
  const scripts = createScripts(tmp)
  assert.deepEqual(scripts.list(), ['lint@1.0.0'])
  assert.equal(scripts.get('lint@1.0.0').description, 'lints')
  assert.equal(scripts.get('lint@1.0.0').entry, join(tmp, 'scripts', 'lint', '1.0.0', 'run.sh'))
  assert.equal(scripts.get('bad@1.0.0'), null, 'an entry outside its folder is no script')
  assert.equal(scripts.get('nope@1'), null)

  // ── the request form ──
  const input = [
    { name: 'channel', type: 'select', label: 'Channel', options: ['blog', { value: 'mail', label: 'Mail' }], required: true },
    { name: 'tags', type: 'multiselect', options: ['a', 'b'] },
    { name: 'tone', type: 'text', default: 'plain' },
    { name: 'body', type: 'textarea' },
    { name: 'agree', type: 'checkbox', required: true },
    { name: 'photos', type: 'files', required: true },
  ]
  assert.deepEqual(checkInput(input), [])
  assert.deepEqual(checkInput(undefined), [])
  assert.match(checkInput('x')[0], /list of fields/)
  assert.match(checkInput([{ name: 'a b', type: 'text' }])[0], /needs a name/)
  assert.match(checkInput([{ name: 'a', type: 'date' }])[0], /type is one of/)
  assert.match(checkInput([{ name: 'a', type: 'select' }])[0], /needs options/)
  assert.match(checkInput([{ name: 'a', type: 'text' }, { name: 'a', type: 'text' }])[0], /appears twice/)
  const photo = [{ name: 'x.png', size: 3, mime: 'image/png' }]
  const ok = checkFields(input, { channel: 'mail', tags: ['a', 'a'], agree: true, body: ' text ' }, photo)
  assert.deepEqual(ok, { fields: { channel: 'mail', tags: ['a'], tone: 'plain', body: 'text', agree: true }, errors: [] })
  const err = (given, files = photo) => checkFields(input, given, files).errors.join('; ')
  assert.match(err({}), /Channel: required; agree: must be ticked/)
  assert.match(err({ channel: 'blog', agree: true }, []), /photos: attach at least one file/)
  assert.match(err({ channel: 'fax', agree: true }), /Channel: fax is not one of blog, mail/)
  assert.match(err({ channel: 'blog', agree: true, extra: 1 }), /unknown field "extra"/)
  assert.match(err({ channel: 'blog', agree: 'yes' }), /agree: yes or no/)
  assert.match(err({ channel: 'blog', agree: true, tags: ['c'] }), /c is not one of a, b/)
  assert.match(err({ channel: 'blog', agree: true, tags: 'a' }), /tags: a list of choices/)
  assert.match(err({ channel: ['blog'], agree: true }), /Channel: text/)
  assert.match(err({ channel: 'blog', agree: true, body: 'x'.repeat(LIMITS.area + 1) }), /body: too long/)
  assert.match(err({ channel: 'blog', agree: true, tone: 'x'.repeat(LIMITS.line + 1) }), /tone: too long/)
  assert.match(checkFields(input, 'x', photo).errors[0], /fields must be an object/)
  assert.deepEqual(checkFields([], undefined, []), { fields: {}, errors: [] })
  assert.deepEqual(checkFields([], null, []), { fields: {}, errors: [] })
  assert.match(checkFields([], { a: 1 }, []).errors[0], /unknown field "a"/)
  // two file fields: attachments say which they belong to
  const two = [{ name: 'a', type: 'files', required: true }, { name: 'b', type: 'files' }]
  assert.match(checkFields(two, {}, [{ name: 'x', field: 'b' }]).errors.join(), /a: attach at least one file/)
  assert.deepEqual(checkFields(two, {}, [{ name: 'x', field: 'a' }]).errors, [])
  assert.match(checkFields(two, {}, [{ name: 'x' }]).errors.join(), /a: attach/, 'with several file fields an unlabelled file belongs to none')
  // attachments from the API
  const b64 = s => Buffer.from(s).toString('base64')
  const dec = decodeAttachments([{ name: 'sub/dir/a.png', base64: b64('abc') }, { name: 'n.txt', base64: b64('hi'), mime: 'text/x-note', field: 'photos' }])
  assert.deepEqual(dec.errors, [])
  assert.deepEqual(dec.files.map(f => [f.name, f.size, f.mime, f.field]), [['a.png', 3, 'image/png', undefined], ['n.txt', 2, 'text/x-note', 'photos']], 'folders are cut off, the type comes from the name unless given')
  assert.equal(dec.files[0].bytes.toString(), 'abc')
  assert.deepEqual(decodeAttachments(undefined), { files: [], errors: [] })
  assert.match(decodeAttachments('x').errors[0], /must be a list/)
  assert.match(decodeAttachments(Array(LIMITS.files + 1).fill({ name: 'a', base64: '' })).errors[0], /at most 20 attachments/)
  assert.match(decodeAttachments([{ base64: 'YQ==' }]).errors[0], /needs a file name/)
  assert.match(decodeAttachments([{ name: '.hidden', base64: 'YQ==' }]).errors[0], /needs a file name/)
  assert.match(decodeAttachments([{ name: 'a', base64: 'a b!' }]).errors[0], /content must be base64/)
  assert.match(decodeAttachments([{ name: 'a' }]).errors[0], /content must be base64/)
  assert.equal(mimeOf('x.MOV'), 'video/quicktime')
  assert.equal(mimeOf('noext'), 'application/octet-stream')

  // ── what a step hands back ──
  const c = def => ({ stage: 's', def })
  assert.throws(() => validateStageResult(c({}), []), /result must be an object/)
  assert.throws(() => validateStageResult(c({}), null), /result must be an object/)
  assert.deepEqual(validateStageResult(c({}), { anything: 1 }), { anything: 1 }, 'a step of a pack checks its own fields (validate), the core wants an object')
  assert.throws(() => validateStageResult(c({ validate: r => { if (!r.text) throw new Error('text is required') } }), {}), /invalid stage_result \(text is required\)/)
  assert.throws(() => validateStageResult(c({ generic: 'agent' }), { ok: 'yes', summary: 'x' }), /ok must be true or false/)
  assert.throws(() => validateStageResult(c({ generic: 'agent' }), { ok: true, summary: ' ' }), /summary is required/)
  assert.throws(() => validateStageResult(c({ generic: 'flow' }), { summary: 'x' }), /ok must be true or false/, 'an agent of a script step hands back what an agent step does')
  assert.throws(() => validateStageResult(c({ generic: 'agent' }), { ok: true, summary: 'x', findings: [''] }), /findings must be an array of non-empty strings/)
  assert.ok(validateStageResult(c({ generic: 'agent' }), { ok: false, summary: 'x', findings: ['a'] }))
  assert.throws(() => validateStageResult(c({ generic: 'branch', routes: ['yes'] }), { route: 'no', reason: 'x' }), /route must be one of yes, otherwise/)
  assert.throws(() => validateStageResult(c({ generic: 'branch', routes: ['yes'] }), { route: 'yes' }), /reason is required/)

  // ── the tools ──
  assert.deepEqual(TOOLS.map(t => t.name), ['wb_context', 'evidence_get', 'claim_add', 'decision_needed', 'help_needed', 'discuss_with_person', 'file_save', 'tools_ensure', 'stage_result'])
  assert.deepEqual(ALWAYS, TOOLS.map(t => t.name))
  for (const t of TOOLS) assert.ok(t.description && t.parameters.type === 'object' && typeof t.run === 'function', t.name)
  assert.deepEqual(TOOLS.find(t => t.name === 'claim_add').parameters.properties.type.enum, ['finding', 'decision', 'risk', 'source', 'output'])
  assert.equal(TOOLS.find(t => t.name === 'decision_needed').parameters.properties.options.items.properties.from.enum, undefined, 'a step key is the workflow\'s, not a fixed list')
  const list = [...TOOLS.map(t => ({ ...t, pack: null })), { name: 'p_tool', description: p => `for ${p.id}`, parameters: { type: 'object' }, pack: { id: 'p' }, run: c => `${c.pack.id}:${c.packSettings?.k}` }]
  assert.deepEqual(toolDefs(list).at(-1), { name: 'p_tool', description: 'for p', parameters: { type: 'object' } })
  assert.equal(await callTool(list, { settings: { packs: { p: { k: 'v' } } } }, 'p_tool', {}), 'p:v')
  await assert.rejects(callTool(list, {}, 'nope', {}), /unknown tool nope/)
  const asked = []
  const ctx2 = { run: { id: 'r1' }, workflow: { stages: [{ key: 'a' }, { key: 'b' }] }, stage: 'a', actor: 'x', approval: s => { asked.push(s); return { id: 'a1' } }, record: () => ({ seq: 1 }) }
  const decide = args => callTool(list, ctx2, 'decision_needed', { question: 'Q?', why: 'W', ...args })
  const options = [{ label: 'A', does: 'a', action: 'accept' }, { label: 'B', does: 'b', action: 'revise', from: 'a' }]
  assert.match(await decide({ options }), /Asked \(a1\)/)
  assert.equal(asked[0].action, 'decision')
  await assert.rejects(decide({ options: [options[0], { label: 'B', does: 'b', action: 'revise', from: 'zzz' }] }), /"zzz" is not a step of this workflow \(steps: a, b\)/)
  await assert.rejects(decide({ options: [options[0], { label: 'B', does: 'b', action: 'check' }] }), /names the step to redo/)
  await assert.rejects(decide({ options: [options[0]] }), /2–4 labelled options/)
  await assert.rejects(callTool(list, ctx2, 'file_save', { name: '..', content: 'x' }), /give a file name/)
  await assert.rejects(callTool(list, ctx2, 'file_save', { name: 'a.bin', content: '!!', encoding: 'base64' }), /not valid base64/)
  await assert.rejects(callTool(list, ctx2, 'file_save', { name: 'a.txt', content: 'x', encoding: 'hex' }), /utf8 or base64/)

  // ── the ledger ──
  const s = openStore(join(tmp, 'db'))
  const a1 = s.addEvidence('r1', { kind: 'command', title: 'one', stage: 'x', output: 'out', ok: true })
  const a2 = s.addEvidence('r1', { kind: 'file', title: 'two', ...s.artifact('r1', 'a b.txt', Buffer.from('bytes')) })
  assert.deepEqual([a1.seq, a2.seq, a2.prev === a1.hash, a1.prev], [1, 2, true, ''])
  assert.equal(a2.artifact, 'r1/a_b.txt', 'an artifact name is made safe (a forward slash everywhere)')
  assert.equal(a2.sha256, sha256(Buffer.from('bytes')))
  const up = s.artifact('r1', '../../up.txt', 'x').artifact
  assert.match(up, /^r1\/[^/]+$/, 'and cannot leave its folder')
  assert.ok(existsSync(join(tmp, 'db', 'runs', up)))
  assert.deepEqual(s.verify('r1'), { ok: true, head: a2.hash, count: 2 })
  assert.deepEqual(s.verify('none'), { ok: true, head: '', count: 0 })
  assert.equal(s.readArtifact(a2.artifact), 'bytes')
  assert.ok(s.readArtifact(a2.artifact, null).equals(Buffer.from('bytes')))
  assert.equal(s.evidenceAt('r1', 2).title, 'two')
  assert.deepEqual(s.evidence('r1', 1).map(e => e.seq), [2])
  assert.equal(s.addEvidence('r2', { kind: 'gate', title: 'other run' }).seq, 1, 'each run has its own chain')
  writeFileSync(join(tmp, 'db', 'runs', a2.artifact), 'changed')
  assert.equal(s.verify('r1').reason, 'artifact changed')
  rmSync(join(tmp, 'db', 'runs', a2.artifact))
  assert.equal(s.verify('r1').reason, 'artifact missing')
  // documents and their sync
  const rev0 = s.revision()
  s.put('run', { id: 'r1', stages: [{ key: 'k', result: { big: 1 } }, { key: 'm' }] })
  s.put('approval', { id: 'a1', runId: 'r1' })
  assert.ok(s.revision() > rev0)
  assert.deepEqual(s.list('run').map(d => d.id), ['r1'])
  assert.equal(s.get('approval', 'a1').runId, 'r1')
  const sync = s.since(0)
  assert.deepEqual(sync.docs.map(d => d.id), ['r1', 'a1'])
  assert.equal(sync.docs[0].stages[0].result, true, 'the sync leaves each result to be read on demand')
  assert.deepEqual(s.since(sync.rev).docs, [])
  assert.equal(s.since(sync.rev + 50).reset, true, 'a cursor from a replaced database gets everything again')
  s.translations.put('k', 'v')
  assert.equal(s.translations.get('k'), 'v')
  s.close()
  const s2 = openStore(join(tmp, 'db'))
  assert.equal(s2.revision() >= sync.rev, true, 'the revision survives a restart')
  s2.close()

  // ── packs ──
  const pk = definePack({ id: 'notes', name: 'Notes' })
  assert.deepEqual([pk.name, pk.workflows, pk.tools, pk.actions, pk.agents, pk.settings, pk.skills], [{ en: 'Notes', zh: 'Notes' }, {}, [], {}, [], {}, { packs: [], uses: [] }])
  assert.deepEqual(pk.needs({}), [])
  assert.equal(pk.beforeFileMutation, null)
  const guard = () => () => {}
  assert.equal(definePack(definePack({ id: 'guarded', name: 'Guarded', beforeFileMutation: guard })).beforeFileMutation, guard)
  for (const [bad, re] of [
    [{ id: 'x', name: 'X' }, /id is 2–31/], [{ id: 'notes', name: 5 }, /name is \{ en, zh \}/], [{ id: 'notes' }, /name is \{ en, zh \}/],
    [{ id: 'notes', name: 'N', tools: [{ name: 'Bad Name' }] }, /a tool name is lowercase/],
    [{ id: 'notes', name: 'N', tools: [{ name: 'a_b', description: 'd', parameters: {} }] }, /needs description, parameters and run/],
    [{ id: 'notes', name: 'N', actions: { a: 1 } }, /the action a is a function/],
    [{ id: 'notes', name: 'N', agents: [{ id: 'a' }] }, /an agent needs an id and a runtime/],
    [{ id: 'notes', name: 'N', needs: [] }, /needs is a function/],
    [{ id: 'notes', name: 'N', beforeFileMutation: true }, /beforeFileMutation is a function/],
    [{ id: 'notes', name: 'N', beforeFileMutation: async () => {} }, /beforeFileMutation is synchronous/],
    [{ id: 'notes', name: 'N', workflows: { 'Bad Key': { title: 'T', stages: [step('a')] } } }, /workflow id/],
    [{ id: 'notes', name: 'N', workflows: { w: { stages: [step('a')] } } }, /title is required/],
    [{ id: 'notes', name: 'N', workflows: { w: { title: 'T', stages: [] } } }, /stages is a list of steps/],
    [{ id: 'notes', name: 'N', workflows: { w: { title: 'T', stages: [step('a'), step('a')] } } }, /the step a appears twice/],
    [{ id: 'notes', name: 'N', workflows: { w: { title: 'T', stages: [step('approval')] } } }, /"approval" is the engine's own name/],
    [{ id: 'notes', name: 'N', workflows: { w: { title: 'T', stages: [{ key: 'a', owner: 'system' }] } } }, /run\(w\) is required/],
    [{ id: 'notes', name: 'N', workflows: { w: { title: 'T', stages: [step('a')], insertFrom: 'zz' } } }, /insertFrom "zz"/],
    [{ id: 'notes', name: 'N', workflows: { w: { title: 'T', stages: [step('a')], reviseFrom: 'zz' } } }, /reviseFrom "zz"/],
    ...['tone', ['tone', 'tone'], ['unknown']].map(preferenceOptions => [{ id: 'notes', name: 'N', workflows: { w: { title: 'T', stages: [step('a')], preferenceOptions } } }, /preferenceOptions/]),
    [{ id: 'notes', name: 'N', workflows: { w: { title: 'T', stages: [step('a', { owner: 'r' })], roles: { r: { agent: 'a', access: 'rw' } } } } }, /access is read or write/],
  ]) assert.throws(() => definePack(bad), re)

  // "Ask for changes" must reach a creator before audit/export, and old consumed review cards stay consumed.
  {
    const stages = [{ key: 'draft', owner: 'writer' }, { key: 'quality', owner: 'auditor' }, { key: 'review', owner: 'system', person: true }, { key: 'export', owner: 'system' }]
    const wf = { stages, roles: { writer: { access: 'write' }, auditor: { access: 'read' } } }, run = { stages }
    assert.equal(revisionStep(run, wf).key, 'draft')
    assert.equal(revisionStep(run, { ...wf, reviseFrom: 'draft' }).key, 'draft')
    assert.equal(revisionStep(run, { ...wf, reviseFrom: 'missing' }), null)
    assert.deepEqual(revisionSteps(run, { ...wf, reviseFrom: 'draft' }).map(s => s.key), ['draft'], 'comments cannot go to a read-only audit or system export')
    assert.deepEqual(revisionSteps(run, wf), stepsBack(run, wf), 'undeclared workflows retain existing restart choices')
    assert.deepEqual(stepsBack(run, { ...wf, reviseFrom: 'draft' }).map(s => s.key), ['draft', 'quality', 'export'], 'continue and rewind still offer every replayable step')
    const dispatch = { key: 'compose', owner: 'system' }
    const declared = { ...wf, stages: [dispatch, ...stages], reviseFrom: 'compose' }
    assert.deepEqual(revisionSteps({ stages: declared.stages }, declared).map(s => s.key), ['compose', 'draft'], 'a declared system creation dispatcher remains eligible')
    const base = { id: 'old', runId: 'r', action: 'decision', payload: { stage: 'review', by: 'workflow' }, status: 'done' }
    for (const consumed of [{ applied: true }, { result: { applied: true } }, { status: 'pending', applied: true }]) {
      const w = { run: { id: 'r' }, store: { list: () => [{ ...base, ...consumed }] }, approval: () => ({ id: 'new' }) }
      assert.equal(cardOf(w, { id: 'review' }, 'decision', {}).id, 'new')
    }
  }

  // ── what a script step's output is cleaned of: the values, and their usual disguises ──
  {
    const kube = join(tmp, 'kubeconfig')
    writeFileSync(kube, 'apiVersion: v1\nusers:\n- name: bot\n  user:\n    token: eyJhbGciOiJSUzI1NiIs-k8s-token\n    client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVk\n')
    const vars = { KUBECONFIG: kube, API_URL: 'https://api.example.com', API_USER: 'jane', API_PASSWORD: 'p@ss word!1', API_TOKEN: 'tok-secret-123456' }
    const secrets = secretsOf(vars)
    const clean = text => secrets.reduce((t, x) => t.split(x).join('«secret»'), text)
    const basic = Buffer.from('jane:p@ss word!1').toString('base64')
    for (const leak of ['tok-secret-123456', Buffer.from('tok-secret-123456').toString('base64'), 'p@ss word!1', encodeURIComponent('p@ss word!1'), `Basic ${basic}`, basic, 'jane:p@ss word!1',
      readFileSync(kube, 'utf8').trim(), 'eyJhbGciOiJSUzI1NiIs-k8s-token', 'LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVk']) {
      assert.ok(!clean(`before ${leak} after`).includes(leak), `cleaned: ${leak.slice(0, 40)}`)
    }
    assert.equal(clean('Authorization: Basic ' + basic), 'Authorization: «secret»', 'the header goes whole')
    assert.equal(clean('user jane, namespace dev'), 'user jane, namespace dev', 'a short user name alone is not a secret (and not in the list)')
    assert.deepEqual(secretsOf({ A: 'short', B: '' }), [])
    assert.equal(secrets[0].length >= secrets.at(-1).length, true, 'longest first')
  }

  // ── model steps: one call to a model, no tools ──
  {
    assert.deepEqual(parseModelRef('openrouter:anthropic/claude-sonnet-5.5'), { ref: 'openrouter:anthropic/claude-sonnet-5.5', source: 'connection', connection: 'openrouter', model: 'anthropic/claude-sonnet-5.5' })
    assert.deepEqual(parseModelRef('dsh:deepseek-account/deepseek-flash'), { ref: 'dsh:deepseek-account/deepseek-flash', source: 'dsh', provider: 'deepseek-account', model: 'deepseek-flash' })
    for (const bad of ['', 'gpt', 'dsh:flash', 'dsh:/x', 'Open:x', 'a b:c']) assert.throws(() => parseModelRef(bad), /a (dsh )?model is/, bad)
    // the answer's schema
    const sch = { type: 'object', additionalProperties: false, required: ['title', 'tags'], properties: { title: { type: 'string', maxLength: 5 }, tags: { type: 'array', maxItems: 2, items: { type: 'string' } }, n: { type: ['integer', 'null'], minimum: 1 } } }
    assert.deepEqual(checkSchema(sch, { title: 'ok', tags: ['a'] }), [])
    assert.deepEqual(checkSchema(sch, { title: '一二三四五六', tags: ['a', 'b', 3], x: 1, n: 0 }), ['title: at most 5 characters', 'tags: at most 2 items', 'tags[2]: should be string, is integer', 'x: not a field of the answer', 'n: at least 1'])
    assert.deepEqual(checkSchema(sch, { tags: [] }), ['title: missing'])
    assert.deepEqual(jsonOf('Here:\n```json\n{"a":1}\n```'), { a: 1 })
    assert.deepEqual(jsonOf('sure {"a":{"b":2}} done'), { a: { b: 2 } })
    // the call: a connection's chat API — asked again with what was wrong, the usage summed
    const sent = []
    const answers = ['not json', '{"title":"too long here","tags":[]}', '{"title":"ok","tags":["x"]}']
    const connectors = { client: (id, o) => ({ async request(path, req) { sent.push({ id, by: o.by, path, body: req.body }); return { ok: true, json: async () => ({ choices: [{ message: { content: answers[sent.length - 1] } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } }) } } }) }
    const models = createModels({ connectors: () => connectors })
    const got = await models.call({ model: 'openrouter:m/x', system: 'Be brief.', user: 'Q', schema: sch, by: 'r1:s' })
    assert.deepEqual(got.data, { title: 'ok', tags: ['x'] })
    assert.deepEqual(got.usage, { calls: 3, input: 300, output: 60, cost: 0.003 })
    assert.deepEqual(got.tries.map(t => t.problems.length > 0), [true, true, false])
    assert.equal(sent[0].path, 'chat/completions')
    assert.equal(sent[0].id, 'openrouter')
    assert.equal(sent[0].by, 'r1:s', 'the connection\'s audit names the run and step')
    assert.deepEqual(sent[0].body.messages[0], { role: 'system', content: 'Be brief.' })
    assert.deepEqual(sent[0].body.response_format, { type: 'json_object' })
    assert.match(sent[1].body.messages[1].content, /previous answer was not accepted[\s\S]*not JSON/)
    assert.match(sent[2].body.messages[1].content, /title: at most 5 characters/)
    sent.length = 0
    answers.splice(0, 3, 'x', 'y', 'z')
    await assert.rejects(models.call({ model: 'openrouter:m/x', user: 'Q', schema: sch }), /no usable answer in 3 tries/)
    // dsh's model service: text in, text out
    const asked = []
    const llm = { async *stream(o) { asked.push(o); yield { type: 'text-delta', index: 0, text: 'hi ' }; yield { type: 'text-delta', index: 0, text: 'there' }; yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 } }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    const viaDsh = await createModels({ llm: () => llm }).call({ model: 'dsh:p/m', system: 'S', user: 'U' })
    assert.equal(viaDsh.text, 'hi there')
    assert.deepEqual(viaDsh.usage, { calls: 1, input: 10, output: 2, cost: 0 })
    assert.equal(asked[0].provider, 'p'); assert.equal(asked[0].model, 'm'); assert.equal(asked[0].system, 'S')
    assert.equal(asked[0].messages[0].content[0].text, 'U')
    const broke = { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Insufficient Balance' } } } } }
    await assert.rejects(createModels({ llm: () => broke }).call({ model: 'dsh:p/m', user: 'U' }), /error — Insufficient Balance/)

    // a base with a model role: its step takes a model, not an agent; the settings pick one
    const mb = { id: 'p.rw', title: 'Rewrite', pack: 'p', insertFrom: 'draft', success: 'done', report: renderReport, actions: {},
      roles: { w: agentRole, rw: { kind: 'model', model: 'api:fast/model', text: 'Rewrite.' } },
      stages: [intake, step('draft', { owner: 'w' }), step('rewrite', { owner: 'rw' }), report] }
    const mctx = { ...ctx, bases: { ...bases, 'p.rw': mb }, builtIn: [...ctx.builtIn, 'p.rw'] }
    assert.deepEqual(library(mb).map(x => [x.key, !!x.agent, x.model?.model || null]), [['intake', false, null], ['draft', true, null], ['rewrite', false, 'api:fast/model'], ['report', false, null]])
    assert.deepEqual(workflowAgents(mb, {}), ['writer'], 'a model step needs no agent of the pool')
    assert.equal(stepAgent(mb, 'rewrite', {}), null)
    assert.equal(stepModel(mb, 'rewrite', {}).model, 'api:fast/model')
    assert.equal(stepModel(mb, 'rewrite', { steps: { 'p.rw': { rewrite: { model: 'dsh:p/m' } } } }).model, 'dsh:p/m', 'the settings pick another model')
    assert.equal(stepModel({ ...mb, roles: { ...mb.roles, rw: { kind: 'model', text: '' } } }, 'rewrite', { model: 'api:default/m' }).model, 'api:default/m', 'no model of its own: the workbench default')
    assert.deepEqual(modelSteps(mb, {}).map(m => m.step), ['rewrite'])
    assert.deepEqual(stepAgents([mb], {})[0].steps.map(x => [x.key, x.kind, x.agent || x.model]), [['draft', 'agent', 'writer'], ['rewrite', 'model', 'api:fast/model']])
    assert.equal(workflowInfo(mb, {}, null).stages.find(x => x.key === 'rewrite').model, 'api:fast/model')
    const flowM = [{ use: 'intake' }, { use: 'draft' }, { use: 'rewrite', model: 'api:other/m' }, { use: 'report' }]
    assert.deepEqual(msgs(on('p.rw', flowM), mctx), [])
    assert.equal(compose(v(on('p.rw', flowM), mctx).def, mb).stages.find(x => x.key === 'rewrite').pick.model, 'api:other/m')
    assert.match(msgs(on('p.rw', flowM.map(x => (x.use === 'rewrite' ? { ...x, model: 'nope' } : x))), mctx).join(), /"nope" is not a model/)
    assert.match(msgs(on('p.rw', flowM.map(x => (x.use === 'rewrite' ? { ...x, model: 'ghost:m' } : x))), mctx).join(), /no connector "ghost"/)
    // a model step of one's own: instructions, a model (or the default); in a route, in a parallel lane, read by a condition
    const md1 = (id, extra = {}) => ({ id, use: 'model', title: id, instructions: 'Summarise.', ...extra })
    assert.deepEqual(msgs(on('blank', [{ use: 'intake' }, md1('sum', { model: 'api:m/x' }), md1('sum2'), { use: 'report' }])), [])
    assert.match(msgs(on('blank', [{ use: 'intake' }, md1('sum', { instructions: '' }), { use: 'report' }])).join(), /a model step needs instructions/)
    assert.match(msgs(on('blank', [{ use: 'intake' }, md1('sum', { model: 'dsh:nope' }), { use: 'report' }])).join(), /is not a model/)
    const routed = on('blank', [{ use: 'intake' }, md1('sum'),
      { id: 'pick', use: 'branch', title: 'Pick', routes: [{ id: 'yes', label: 'Yes', when: { output: 'sum', has: 'urgent' }, steps: [md1('alert')] }], otherwise: { steps: [] } },
      { id: 'both', use: 'parallel', title: 'Both', lanes: [{ id: 'a', steps: [md1('one')] }, { id: 'b', steps: [sc('two')] }] }, { use: 'report' }])
    assert.deepEqual(msgs(routed), [])
    const cw = compose(v(routed).def, blank)
    assert.deepEqual(cw.roles.sum, { kind: 'model', model: '', text: cw.roles.sum.text })
    assert.match(cw.roles.sum.text, /one step of a workflow run/)
    assert.equal(cw.stages.find(x => x.key === 'sum').owner, 'sum')
    assert.equal(cw.stages.find(x => x.key === 'sum').generic, 'model')
    assert.deepEqual(workflowAgents(cw, {}), [], 'a workflow of model steps needs no agent')
    // settings: a step's model is a model reference; so is the default
    const sfile = join(tmp, 'm-settings.json')
    assert.throws(() => saveSettings({ ...defaultsOf([]), model: 'nope' }, sfile, []), /model is "<connection>:<model>"/)
    assert.throws(() => saveSettings({ ...defaultsOf([]), steps: { 'p.rw': { rewrite: { model: 'x' } } } }, sfile, []), /steps\.p\.rw\.rewrite\.model: a model/)
    assert.equal(saveSettings({ ...defaultsOf([]), model: 'api:m/x', steps: { 'p.rw': { rewrite: { model: 'dsh:p/m' } } } }, sfile, []).model, 'api:m/x')
  }

  // ── the report of a bare run ──
  const md = renderReport({ run: { id: 'r9', template: 'blank', status: 'done', subject: { title: 'T', text: 'body', fields: {}, attachments: [] }, stages: [{ key: 'intake', owner: 'system', status: 'passed' }], claims: [], verdict: { level: 'done' }, createdAt: 0 },
    evidence: [{ seq: 1, stage: 'intake', kind: 'gate', actor: 'system', title: 'a | b', ok: true }], chain: { ok: false, seq: 1, reason: 'hash chain broken', count: 1 }, approvals: [], workflow: blank })
  assert.match(md, /^# T\n/)
  assert.match(md, /\*\*Verdict: Done\*\*/)
  assert.match(md, /a \\\| b/, 'a table cell is escaped')
  assert.match(md, /\| #1 \| intake \|/, 'the ledger table names an entry #n, which the panel turns into a link')
  assert.ok(!md.includes('<a id'), 'no HTML in the report: the panel does not render it')
  assert.match(md, /chain BROKEN at #1 \(hash chain broken\)/)
  assert.ok(!md.includes('## Claims') && !md.includes('## Approvals'), 'a section with nothing in it is left out')
  // ── what a workflow needs (lib/needs.js): bindings and readiness ──
  {
    assert.deepEqual(needsOf({ connectors: [{ type: 'http', level: 'read' }, { type: 'http', level: 'write', name: 'two' }] }).map(n => n.key), ['http', 'http:two'])
    assert.deepEqual(needsOf({ connectors: { 'blog-api': 'write' } }), [{ id: 'blog-api', level: 'write', key: 'id:blog-api' }], 'the older map: a connection by id')
    assert.equal(keyOf({ type: 'http' }), 'http')
    const file = join(tmp, 'bind', 'bindings.json')
    const b = createBindings(file)
    const conns = [{ id: 'a', type: 'http' }, { id: 'b', type: 'http' }, { id: 'c', type: 'ftp' }]
    assert.deepEqual(b.resolve({ type: 'ftp' }, 'wf', conns), { connection: 'c', how: 'only' })
    assert.deepEqual(b.resolve({ type: 'http' }, 'wf', conns), { connection: null, how: 'choose' })
    assert.deepEqual(b.resolve({ type: 'smtp' }, 'wf', conns), { connection: null, how: 'none' })
    assert.deepEqual(b.resolve({ id: 'gone', key: 'id:gone' }, 'wf', conns), { connection: null, how: 'own' })
    b.set({ key: 'http', connection: 'a' })
    b.set({ key: 'http', connection: 'b', workflow: 'wf' })
    assert.deepEqual(b.resolve({ type: 'http' }, 'wf', conns), { connection: 'b', how: 'workflow' })
    assert.deepEqual(b.resolve({ type: 'http' }, 'other', conns), { connection: 'a', how: 'default' })
    assert.deepEqual(b.resolve({ type: 'http' }, 'wf', conns.filter(c => c.id !== 'b')), { connection: 'a', how: 'default' }, 'a binding to a connection that is gone falls back')
    assert.deepEqual(createBindings(file).get(), { types: { http: 'a' }, workflows: { wf: { http: 'b' } } }, 'kept on disk')
    b.set({ key: 'http', connection: null, workflow: 'wf' })
    assert.deepEqual(b.get().workflows, {}, 'a workflow with no binding of its own leaves the file')
    const def = { id: 'wf', base: 'blank', packs: [{ id: 'p', version: '1' }], steps: [{ use: 'intake' },
      { id: 'go', use: 'agent', agent: 'x', fallback: 'gone', skills: ['p/s', 'q/t'] },
      { id: 'pick', use: 'branch', mode: 'condition', routes: [{ id: 'r', steps: [{ id: 'sc', use: 'script', script: 'tool@1', connectors: [{ type: 'smtp', level: 'write' }] }] }], otherwise: { steps: [] } },
      { id: 'sum', use: 'model', instructions: 'x' }, { use: 'report' }] }
    assert.deepEqual(packIdsOf(def), ['p', 'q'])
    assert.deepEqual(skillRefsOf(def), ['p/s', 'q/t'])
    assert.deepEqual(pinsOf(def), { p: { id: 'p', version: '1' } })
    const ctx = { agents: ['x'], skills: async (refs, pins) => refs.map(ref => ({ ref, status: ref.startsWith('q/') ? 'fetch' : pins.p ? 'ok' : 'missing' })), connections: conns, bindings: b, scripts: [], model: 'dsh:a/b', base: {} }
    const r = await readiness(def, ctx)
    assert.deepEqual(r.steps.map(x => [x.id, x.items.map(i => `${i.kind}:${i.ref}:${i.status}`)]), [
      ['go', ['agent:x:ok', 'agent:gone:noFallback', 'skill:p/s:ok', 'skill:q/t:fetch']],
      ['sc', ['connector:smtp:unbound', 'script:tool@1:missing']],
      ['sum', ['model:dsh:a/b:ok']],
    ], 'a route\'s steps too; a model step with no model of its own uses the default')
    assert.deepEqual([r.missing, r.installable, r.soft, r.ready], [2, 1, 1, false])
    assert.equal(missingText(r), 'skill q/t at go; connector smtp (write) at sc; script tool@1 at sc')
    // a base step's own agent and model (its role's default), the person's pick over it
    const r2 = await readiness({ id: 'notes.x', base: 'notes.x', steps: [{ use: 'draft', agent: 'y' }, { use: 'polish' }] }, { ...ctx, base: { draft: { agent: 'x', fallback: '' }, polish: { kind: 'model', model: 'nowhere:m' } } })
    assert.deepEqual(r2.steps.map(x => x.items.map(i => `${i.kind}:${i.ref}:${i.status}`)), [['agent:y:missing'], ['model:nowhere:m:missing']])
  }
  // ── a person step's answer, what the person said (lib/person.js) ──
  {
    assert.deepEqual(ASKS, ['review', 'input', 'decide', 'do', 'chat'])
    assert.deepEqual(WAIT, { review: 0, decide: 0, input: 24, do: 72, chat: 0 })
    // a discussion: settled, back (when it has a step to go back to), or stop; one its agent asked for: settle as well
    assert.deepEqual(answerOf({ kind: 'chat', answer: 'continue' }), { answer: 'continue', input: '' })
    assert.throws(() => answerOf({ kind: 'chat', answer: 'back' }), err => err.code === 'badAnswer', 'no step to go back to')
    assert.equal(answerOf({ kind: 'chat', answer: 'back', back: 'dig' }).answer, 'back')
    assert.throws(() => answerOf({ kind: 'chat', answer: 'retry', input: 'x' }), err => err.code === 'badAnswer')
    assert.equal(answerOf({ kind: 'agent', talk: true, answer: 'settle' }).answer, 'settle')
    assert.throws(() => answerOf({ kind: 'agent', answer: 'settle' }), err => err.code === 'badAnswer', 'only a talk settles')
    assert.deepEqual(answerOf({ kind: 'input', input: ' blue ' }), { answer: 'continue', input: 'blue' })
    assert.deepEqual(answerOf({ kind: 'do' }), { answer: 'continue', input: '' }, 'done needs no note')
    assert.throws(() => answerOf({ kind: 'input', input: '' }), err => err.code === 'needInput')
    assert.throws(() => answerOf({ answer: 'retry' }), err => err.code === 'badAnswer')
    assert.deepEqual(answerOf({ kind: 'input', answer: 'stop' }), { answer: 'stop', input: '' }, 'stopping needs no answer')
    const run = { guidance: [{ stage: 'make', text: 'Look → Ask for changes: bigger' }, { text: 'Colour: red' }, { stage: 'other', text: 'not for make' }] }
    assert.equal(guidanceText(run, 'make'), '## What the person said (build on it)\n- Look → Ask for changes: bigger\n- Colour: red (for the whole run)')
    assert.equal(guidanceText({}, 'make'), '')
  }
  // ── a step asks the person on its own (lib/human.js): its agent asked, its confidence is low, it is stuck ──
  {
    assert.deepEqual([HELP_ROUNDS, WAIT_HOURS, ASKED], [3, 24, ['agent', 'low', 'stuck']])
    assert.deepEqual(humanOf({}), { stuck: false, below: null, wait: 24 }, 'a step asks on its own only when its agent says so')
    assert.deepEqual(humanOf({ human: { stuck: true } }), { stuck: true, below: null, wait: 24 }, 'a built-in step\'s default')
    assert.deepEqual(humanOf({ human: { stuck: true }, pick: { human: { stuck: false, below: 70, wait: 0 } } }), { stuck: false, below: 70, wait: 0 }, 'a definition\'s pick over it; 0 hours: never reminded')
    assert.equal(humanOf({ human: { below: 0, wait: -1 } }).below, null)
    assert.equal(scoreOf({ outputs: { a: { confidence: 61.6 } } }, 'a'), 62)
    assert.equal(scoreOf({ outputs: { a: { summary: 'x' } } }, 'a'), null)
    const run = { outputs: { look: { confidence: 40 } } }, ok = { ok: true }
    assert.equal(needPerson({ run, key: 'look', status: 'passed', out: ok, human: humanOf({}), rounds: 0 }), null)
    const low = needPerson({ run, key: 'look', status: 'passed', out: ok, human: humanOf({ human: { below: 70 } }), rounds: 0 })
    assert.deepEqual([low.kind, low.score, low.bar, low.question], ['low', 40, 70, 'look: 40/100 is under the bar of 70'])
    assert.equal(needPerson({ run, key: 'look', status: 'passed', out: ok, human: { below: 30 }, rounds: 0 }), null, 'over the bar')
    const stuck = needPerson({ run, key: 'look', status: 'failed', out: { ok: false, verdict: 'need_info', note: 'no key', stop: true }, human: { stuck: true }, rounds: 0 })
    assert.deepEqual([stuck.kind, stuck.question], ['stuck', 'look: no key'])
    assert.match(stuck.why, /ended need_info and the run would stop here/)
    for (const out of [{ ok: false, carryOn: true }, { ok: false, goto: 'a' }, { ok: false, back: 'a' }]) assert.equal(needPerson({ run, key: 'look', status: 'failed', out, human: { stuck: true }, rounds: 0 }), null, 'a failure that goes on or back is not stuck')
    assert.equal(needPerson({ run, key: 'look', status: 'failed', out: { ok: false }, human: { stuck: false }, rounds: 0 }), null)
    const agent = needPerson({ run, key: 'look', status: 'passed', out: ok, human: {}, asked: { title: 'Which key?', payload: { why: 'tried #3' } }, rounds: 1 })
    assert.deepEqual([agent.kind, agent.question, agent.why], ['agent', 'Which key?', 'tried #3'])
    assert.equal(needPerson({ run, key: 'look', status: 'passed', out: ok, human: {}, asked: { title: 'Again?' }, rounds: HELP_ROUNDS }), null, 'a step asks three times, not a fourth')
    // the answer: retry needs words, only for a step that asked on its own
    assert.deepEqual(answerOf({ kind: 'agent', answer: 'retry', input: ' use the staging key ' }), { answer: 'retry', input: 'use the staging key' })
    assert.throws(() => answerOf({ kind: 'low', answer: 'retry' }), err => err.code === 'needInput')
    assert.deepEqual(answerOf({ kind: 'stuck' }), { answer: 'continue', input: '' }, 'go on as it is needs no words')
    assert.throws(() => answerOf({ kind: 'input', answer: 'retry', input: 'x' }), err => err.code === 'badAnswer', 'a person step has no retry')
    // the brief of the agent asked about the waiting step: read only, from the record
    const brief = chatBrief({ run: { id: 'r1', stages: [{ key: 'look', status: 'passed', note: 'could not tell', result: { ok: true } }], guidance: [{ stage: 'look', text: 'use the staging key' }] },
      key: 'look', ask: { title: 'Which key?', payload: { why: 'tried #3' } }, chat: [{ q: 'What first?', answer: 'The cache (#1).' }], question: 'Why the cache?', evidence: [{ seq: 1, kind: 'command', title: 'ls' }] })
    assert.match(brief, /^# A question about the step "look" of run r1/)
    for (const part of ['Which key?', 'tried #3', 'could not tell', '- #1 command · ls', 'use the staging key', '**The person:** What first?', 'The cache (#1).', '## The question\nWhy the cache?', 'Change nothing']) assert.ok(brief.includes(part), part)
  }
  // a definition says when a step asks (human): stuck, a bar under 1–100, hours to the reminder
  {
    const ok = def => validate(def, { bases: { blank }, builtIn: ['blank'], agents: ['writer'], tools: ALWAYS }).errors.map(e => e.message)
    const ag = human => ({ id: 'mine', title: 'Mine', base: 'blank', steps: [{ use: 'intake' }, { id: 'look', use: 'agent', title: 'Look', agent: 'writer', instructions: 'Look.', ...(human !== undefined && { human }) }, { use: 'report' }] })
    assert.deepEqual(ok(ag({ stuck: true, below: 70, wait: 2 })), [])
    assert.match(ok(ag({ below: 150 })).join(), /confidence of 1–100/)
    assert.match(ok(ag({ wait: 1000 })).join(), /0–720 hours/)
    const def = validate(ag({ stuck: true, below: 70 }), { bases: { blank }, builtIn: ['blank'], agents: ['writer'], tools: ALWAYS }).def
    assert.deepEqual(def.steps[1].human, { stuck: true, below: 70 })
    const wf = compose(def, blank)
    assert.deepEqual(humanOf(wf.stages.find(s => s.key === 'look')), { stuck: true, below: 70, wait: 24 })
    assert.equal(humanOf(wf.stages.find(s => s.key === 'intake')).stuck, false)
    assert.deepEqual(humanOf(compose(validate(ag(undefined), { bases: { blank }, builtIn: ['blank'], agents: ['writer'], tools: ALWAYS }).def, blank).stages.find(s => s.key === 'look')), { stuck: false, below: null, wait: 24 })
    // a base step carries it as a pick
    const base = { ...blank, id: 'q', roles: { w: { agent: 'writer', access: 'write', text: 'Writes.' } }, stages: [intake, { key: 'draft', owner: 'w', title: 'Draft', run: async () => ({ ok: true }) }, report] }
    const mine = validate({ id: 'mine', title: 'Mine', base: 'q', steps: [{ use: 'intake' }, { use: 'draft', human: { below: 60 } }, { use: 'report' }] }, { bases: { q: base }, builtIn: ['q'], agents: ['writer'], tools: ALWAYS })
    assert.deepEqual(mine.errors, [])
    assert.equal(humanOf(compose(mine.def, base).stages.find(s => s.key === 'draft')).below, 60)
  }
  // ── the AI work log: every call the workbench makes itself (lib/llm.js → lib/aiwork.js) ──
  {
    const log = callLog(join(tmp, 'ai-calls.jsonl'))
    const llm = { async *stream() { yield { type: 'text-delta', text: 'hi' }; yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cost: { total: 0.01 } } }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    assert.equal(await complete({ llm, model: 'p/m', system: '', text: 'x', kind: 'ruyix-workbench-translate', onCall: c => log.add(c) }), 'hi')
    await assert.rejects(complete({ llm: { async *stream() { yield { type: 'finish', reason: { kind: 'length' } } } }, model: 'p/m', text: 'x', kind: 'k', onCall: c => log.add(c) }), /the model stopped: length/)
    assert.equal(await complete({ llm, model: 'p/m', text: 'x', kind: 'k', onCall: () => { throw new Error('the log is broken') } }), 'hi', 'a log that throws never breaks a call')
    const models = createModels({ llm: () => llm, onCall: c => log.add(c) })
    await models.call({ model: 'dsh:p/m', user: 'x', by: 'r1:sum' })
    const lines = log.read()
    assert.deepEqual(lines.map(l => [l.kind, l.ok, l.tokens, l.cost, l.by || null]), [['translate', true, 12, 0.01, null], ['k', false, null, null, null], ['model', true, 12, null, 'r1:sum']])
    const w = aiWork({ tasks: null, runs: [{ id: 'r1', template: 'blank', createdAt: Date.now() - 1000, stages: [] }], evidenceOf: () => [], calls: lines, since: Date.now() - 3600e3, until: Date.now() + 1000 }) // (the calls were made this very millisecond)
    assert.deepEqual(w.tasks.filter(x => x.run_id).map(x => [x.kind, x.run_id, x.workflow, x.step]), [['model', 'r1', 'blank', 'sum']], 'a model step\'s call names its run and step')
    assert.equal(w.totals.helper_calls, 3)
  }
  { // Schedule dialogs preserve minute intervals and their anchor, including fractional hours.
    const src = readFileSync(new URL('./src/tasks.jsx', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('export const formOf ='), src.indexOf('/** The "when to run" fields:')).replaceAll('export const ', 'const ')
    const { formOf, scheduleOf } = new Function(`${body}\nreturn { formOf, scheduleOf }`)()
    for (const minutes of [15, 20, 30, 45, 90, 125, 10080]) for (const from of [undefined, Date.UTC(2026, 9, 22)]) {
      const s = { kind: 'every', minutes, ...(from !== undefined && { from }) }
      assert.deepEqual(scheduleOf(formOf(s)), s, 'opening and saving does not reschedule an unchanged interval')
    }
  }
  { // Execute the editor's initialization and serializer, rather than a separate model of its payload.
    const src = readFileSync(new URL('./src/wf-editor.jsx', import.meta.url), 'utf8')
    const head = /^  const \[head, setHead(?:Raw)?\] = .+$/m.exec(src)[0]
    const value = /^  const value = .+$/m.exec(src)[0]
    const saved = /^  const \[saved, setSaved\] = .+$/m.exec(src)[0]
    const start = { id: 'resident', title: 'Resident', base: 'blank', messages: true, sessions: true, steps: [{ id: 'read', use: 'agent' }] }
    const bindings = { start, builtIn: false, fresh: false, items: start.steps, lib: {}, useState: f => [f()], stepsOf: x => x, itemsOf: s => s.steps }
    const editor = new Function(...Object.keys(bindings), `${head}\n${value}\n${saved}\nreturn { head, value, saved: JSON.parse(saved) }`)(...Object.values(bindings))
    assert.deepEqual(editor.value(), editor.saved, 'the unchanged definition starts clean')
    editor.head.title = 'Renamed'
    assert.equal(editor.value().sessions, true, 'saving another field keeps the resident-session mode')
    assert.equal(editor.value().messages, true)
  }
  // ── the workflow canvas draws its lines unmeasured (src/wf-model.js handlesOf, src/wf-editor.jsx) ──
  {
    const hs = handlesOf(224, 76), at = id => hs.find(h => h.id === id)
    assert.deepEqual(hs.map(h => h.id), ['l', 'r', 'tt', 'ts', 'bs'])
    assert.deepEqual([at('l'), at('r')].map(h => [h.type, h.position, h.x, h.y]), [['target', 'left', 0, 38], ['source', 'right', 224, 38]], 'in on the left edge, out on the right, at half the height')
    assert.deepEqual([at('tt'), at('bs'), at('ts')].map(h => [h.type, h.position, h.x, h.y]), [['target', 'top', 112, 0], ['source', 'bottom', 112, 76], ['source', 'top', 112, 0]])
    // every handle a node draws, and every handle an edge names, is one of them; and each node that has edges carries its size
    const src = readFileSync(new URL('./src/wf-editor.jsx', import.meta.url), 'utf8')
    const drawn = [...src.matchAll(/<Handle id="(\w+)" type="(source|target)"/g)].map(m => [m[1], m[2]])
    assert.ok(drawn.length >= 10 && drawn.every(([id, type]) => at(id)?.type === type), 'a handle drawn by a node is carried by it')
    const named = [...src.matchAll(/(?:sourceHandle|targetHandle): (?:e\.cross \? )?'(\w+)'(?: : '(\w+)')?/g)].flatMap(m => m.slice(1)).filter(Boolean)
    assert.ok(named.length >= 4 && named.every(id => at(id)), 'a handle an edge names is carried')
    assert.ok(!/style: \{ width: NODE\.w/.test(src) && src.includes('handles: handlesOf(n.width, n.height)'), 'the size is the node\'s own (width, height), so its handles can be placed')
  }
  // ── the inbox as one place (src/inbox.js) ──
  { // Execute the editor's real save handler: a successful save must refresh picks before another workflow is saved.
    const src = readFileSync(new URL('./src/wf-editor.jsx', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('  const save = async enable => {'), src.indexOf('  const setStatus = async status => {'))
    const SAVED = /export const SAVED = '([^']+)'/.exec(readFileSync(new URL('./src/settings.jsx', import.meta.url), 'utf8'))[1]
    const win = new EventTarget(), events = [], toasts = [], saved = [], busy = []
    win.addEventListener(SAVED, e => events.push(e.type))
    const data = { picks: { steps: {}, stages: {} }, settingsRevision: 'r0' }, wf = { id: 'one' }, revisions = []
    let persisted = structuredClone(data.picks), reloads = 0
    let release
    const refreshed = new Promise(r => { release = r })
    const bindings = {
      busy: '', idTaken: false, saving: { current: false }, builtIn: true, builtInConfig: () => ({ steps: { writer: wf.id }, stages: {} }), items: [], data, wf,
      call: async (op, { settings, revision }) => { assert.equal(op, 'saveSettings'); revisions.push(revision); persisted = structuredClone(settings) },
      window: win, Event, SAVED, now: 'saved-version', setSaved: v => saved.push(v), setBusy: v => busy.push(v),
      toast: (...x) => toasts.push(x), t: x => x, errorText: (_, e) => e.message,
      onSaved: async () => { reloads++; if (reloads === 1) await refreshed; data.picks = structuredClone(persisted); data.settingsRevision = `r${reloads}` },
    }
    const save = new Function(...Object.keys(bindings), `${body}\nreturn save`)(...Object.values(bindings))
    const first = save(false)
    await new Promise(r => setImmediate(r))
    assert.deepEqual(busy, ['save'], 'save stays busy until its asynchronous refresh finishes')
    assert.deepEqual(saved, [], 'the draft is acknowledged only after the refresh')
    release(); await first
    wf.id = 'two'; await save(false)
    assert.deepEqual(persisted.steps, { one: { writer: 'one' }, two: { writer: 'two' } }, 'the second workflow preserves the first save')
    assert.equal(reloads, 2)
    assert.deepEqual(revisions, ['r0', 'r1'], 'each save carries the revision of its displayed base')
    assert.deepEqual(events, [SAVED, SAVED])
    assert.deepEqual(saved, ['saved-version', 'saved-version'])
    assert.deepEqual(busy, ['save', '', 'save', ''])
    assert.ok(toasts.every(([kind]) => kind === 'ok'), 'successful persistence is acknowledged without an error toast')
  }
  { // Settings refreshes keep edits made while a request is in flight and reject out-of-order responses.
    const src = readFileSync(new URL('./src/settings.jsx', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('  const load = (force = false) => {'), src.indexOf('  useEffect(() => { load();'))
    const initial = { settings: { model: '' }, revision: 'r0' }
    const current = { current: { data: initial, draft: initial.settings } }, loading = { current: 0 }, requests = [], shown = []
    const bindings = { current, loading, same: (a, b) => JSON.stringify(a) === JSON.stringify(b), call: () => new Promise(r => requests.push(r)), setData: d => { current.current.data = d; shown.push(d.revision) }, setDraft: d => { current.current.draft = d }, toast: () => assert.fail('no request failed'), errorText: (_, e) => e.message, t: x => x }
    const load = new Function(...Object.keys(bindings), `${body}\nreturn load`)(...Object.values(bindings))
    const editing = load()
    current.current.draft = { model: 'dsh:p/edited' }
    requests.shift()({ settings: { model: 'dsh:p/remote' }, revision: 'r1' }); await editing
    assert.equal(current.current.draft.model, 'dsh:p/edited', 'an event must not erase an unsaved edit')
    assert.equal(current.current.data.revision, 'r0', 'the edit keeps the base it was made against')
    current.current.draft = initial.settings
    const old = load(), recent = load()
    requests[1]({ settings: { model: 'dsh:p/recent' }, revision: 'r2' }); await recent
    requests[0](initial); await old
    assert.deepEqual(shown, ['r2'], 'a late older response cannot rewind the displayed revision')
  }
  // ── the inbox as one place (src/inbox.js) ──
  {
    const store = items => ({ subscribe: () => () => {}, getSnapshot: () => items })
    const entries = entriesOf([{ options: { id: 'b', order: 30, label: () => 'B' } }, { options: { id: 'a', order: 10, label: () => 'A' } }, { options: { id: 'none' } }, { options: {} }],
      { a: { items: store([{ key: 1, tone: 'danger', title: 'x' }, { key: 2, tone: 'info', title: 'y' }]) }, b: { items: store([{ key: 3, tone: 'amber', title: 'z' }]) }, none: { items: store([]) } })
    assert.deepEqual(entries.map(e => e.id), ['a', 'b', 'none'], 'by order; an entry without an id is left out')
    const groups = groupsOf(entries)
    assert.deepEqual(groups.map(g => [g.id, g.label, g.items.length]), [['a', 'A', 2], ['b', 'B', 1]], 'a plugin with no rows shows no group')
    assert.equal(blocking(groups), 2, 'danger and warning (amber) rows block work; info does not')
    assert.equal(needsCount(groups), 3)
    assert.deepEqual(['danger', 'warning', 'info', 'red', 'odd'].map(toneOf), ['red', 'amber', 'blue', 'red', 'amber'])
    assert.equal(blocksWork({ tone: 'info' }), false)
    const now = Date.now()
    const runs = new Map([['r1', { id: 'r1' }], ['r2', { id: 'r2', archivedAt: 1 }]])
    const late = { id: 'a1', runId: 'r1', status: 'pending', payload: { deadline: now - 10, remindedAt: now - 5 } }
    assert.equal(overdue(late, now), true)
    assert.equal(overdue({ ...late, status: 'done' }, now), false, 'an answered card is not overdue')
    assert.equal(overdue({ status: 'pending', payload: { deadline: null } }, now), false, 'no deadline: waits as long as it takes')
    assert.deepEqual(remindersOf([late, { ...late, id: 'a2', runId: 'r2' }, { ...late, id: 'a3', status: 'done' }], runs, now).map(n => [n.key, n.kind]), [['a1:remind', 'remind']], 'an archived run\'s card and an answered one are no reminder')
  }
  // ── how the conversation is doing, for the shell (src/chat-state.js): busy, unread, the palette's question ──
  {
    const events = []
    const listeners = {}
    const win = {
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
      addEventListener: (type, fn) => { (listeners[type] ||= new Set()).add(fn) },
      removeEventListener: (type, fn) => listeners[type]?.delete(fn),
      dispatchEvent: e => { events.push([e.type, e.detail]); for (const fn of listeners[e.type] || []) fn(e) },
    }
    const kept = new Map()
    const store = { get: (k, d) => (kept.has(k) ? kept.get(k) : d), set: (k, v) => kept.set(k, v) }
    let record = [{ n: 1, kind: 'user' }, { n: 2, kind: 'text' }], running = false, tasks = []
    const sent = []
    const call = async (op, a) => {
      if (op === 'chatSend') { if (a.text === 'fail') throw Object.assign(new Error('down'), { code: 'noHub' }); sent.push(a); record.push({ n: record.length + 1, kind: 'user' }); return {} }
      assert.equal(op, 'chat')
      const items = a.after !== undefined ? record.filter(i => i.n > a.after).slice(0, a.limit) : record.slice(-a.limit)
      return { items, running, tasks }
    }
    let clock = 1000
    const live = createChatState({ call, win, lang: () => 'zh', store, key: 'seen', quietMs: 1e9, busyMs: 1e9, now: () => clock })
    const stop = live.start()
    await live.poll()
    assert.deepEqual(win.__ruyixChat, { busy: false, unread: 0 }, 'a first visit: what is there counts as read')
    assert.equal(kept.get('seen'), 2)
    // the assistant says something while no view shows it: unread, told to the shell
    record.push({ n: 3, kind: 'tool' }, { n: 4, kind: 'text' }, { n: 5, kind: 'draft' })
    running = true
    await live.poll()
    assert.deepEqual(win.__ruyixChat, { busy: true, unread: 2 }, 'what it said or made, not its tool steps')
    assert.deepEqual(events.filter(e => e[0] === STATE_EVENT).at(-1), [STATE_EVENT, { busy: true, unread: 2 }])
    const told = events.length
    await live.poll()
    assert.equal(events.length, told, 'no event when nothing changed')
    // a view shows the latest: read (and stays read while it watches)
    running = false
    const unwatch = live.watch()
    record.push({ n: 6, kind: 'text' })
    await live.poll()
    assert.deepEqual(win.__ruyixChat, { busy: false, unread: 0 })
    assert.equal(kept.get('seen'), 6)
    unwatch(); unwatch()
    record.push({ n: 7, kind: 'genui' })
    await live.poll()
    assert.equal(win.__ruyixChat.unread, 1)
    live.seen(7)
    assert.equal(win.__ruyixChat.unread, 0)
    live.seen(3)
    assert.equal(kept.get('seen'), 7, 'what was read stays read')
    // a background task going is work under way (the dot), without an answer being made; its conclusion is something the assistant made
    tasks = [{ id: 't1', status: 'running' }]
    await live.poll()
    assert.deepEqual(win.__ruyixChat, { busy: true, unread: 0 })
    tasks = [{ id: 't1', status: 'done' }]
    record.push({ n: 8, kind: 'task' })
    await live.poll()
    assert.deepEqual(win.__ruyixChat, { busy: false, unread: 1 }, 'its conclusion is unread')
    live.seen(8)
    // the shell's palette asks: the message goes out in the person's language, the views read it now, busy until it is taken up
    win.dispatchEvent(new win.CustomEvent(ASK_EVENT, { detail: { text: '  what is waiting?  ' } }))
    await new Promise(r => setTimeout(r, 10))
    assert.deepEqual(sent.at(-1), { text: 'what is waiting?', lang: 'zh', tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, 'and the person\'s time zone: what their "tomorrow" means')
    assert.ok(events.some(e => e[0] === REFRESH_EVENT && !e[1].error), 'the views read what is new')
    assert.equal(win.__ruyixChat.busy, true, 'sent, not taken up yet: busy')
    record.push({ n: 10, kind: 'text' })
    await live.poll()
    assert.deepEqual(win.__ruyixChat, { busy: false, unread: 1 }, 'it answered')
    // the session never took it up: busy a minute at most
    await live.ask('again')
    assert.equal(win.__ruyixChat.busy, true)
    clock += 61000
    await live.poll()
    assert.equal(win.__ruyixChat.busy, false)
    // an empty question is no message; one that does not go out is told to the views
    assert.equal(await live.ask('   '), false)
    win.dispatchEvent(new win.CustomEvent(ASK_EVENT, { detail: { text: 'fail' } }))
    await new Promise(r => setTimeout(r, 10))
    assert.equal(events.filter(e => e[0] === REFRESH_EVENT).at(-1)[1].error.code, 'noHub')
    assert.equal(win.__ruyixChat.busy, false)
    // stopped: the palette is not heard any more
    stop()
    const before = sent.length
    win.dispatchEvent(new win.CustomEvent(ASK_EVENT, { detail: { text: 'later' } }))
    await new Promise(r => setTimeout(r, 10))
    assert.equal(sent.length, before)
    // what was read is kept in the browser: a new page does not count it again
    live.seen(record.at(-1).n)
    record.push({ n: record.length + 1, kind: 'text' })
    const again = createChatState({ call, win, store, key: 'seen', quietMs: 1e9, busyMs: 1e9 })
    await again.poll()
    assert.equal(again.snapshot().unread, 1, 'only what came after what was read')
  }
  // the conversation's task, its line and its open cards for the shell's strip; a card answered there (the window event)
  {
    const { createChatState, STATE_EVENT } = await import('./src/chat-state.js')
    const { ANSWER_EVENT } = await import('@ruyix/shell/cards-spec')
    const events = [], listeners = {}
    const win = {
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
      addEventListener: (type, fn) => { (listeners[type] ||= new Set()).add(fn) },
      removeEventListener: (type, fn) => listeners[type]?.delete(fn),
      dispatchEvent: e => { events.push([e.type, e.detail]); for (const fn of listeners[e.type] || []) fn(e) },
    }
    const pick = { type: 'choice', question: 'Which name?', options: [{ label: '小周' }, { label: '大周' }] }
    let cards = [{ kind: 'cards', n: 4, cards: [pick] }]
    const calls = []
    const call = async (op, a) => {
      calls.push([op, a])
      if (op === 'chat') return { items: [{ n: 4, kind: 'cards' }], running: false, tasks: [], task: { id: 'k1', title: 'name it', state: 'waiting' }, line: { kind: 'waiting', text: 'Which name?', at: 1 }, cards }
      if (op === 'chatCardAnswer') { cards = []; return { item: { kind: 'cards', n: a.n, cards: [pick], answered: { [a.index]: a.answer } }, handled: false } }
      return {}
    }
    const kept = new Map(), store = { get: (k, d) => (kept.has(k) ? kept.get(k) : d), set: (k, v) => kept.set(k, v) }
    const live = createChatState({ call, win, lang: () => 'zh', store, key: 'seen2', quietMs: 1e9, busyMs: 1e9 })
    const stop = live.start()
    await live.poll()
    assert.deepEqual([win.__ruyixChat.task.state, win.__ruyixChat.line.kind, win.__ruyixChat.cards[0].n], ['waiting', 'waiting', 4])
    assert.equal(events.filter(e => e[0] === STATE_EVENT).at(-1)[1].line.text, 'Which name?', 'in the event too')
    // the strip draws the card with origin { n }: the pick is kept on its entry and goes out as the person's reply
    win.dispatchEvent(new win.CustomEvent(ANSWER_EVENT, { detail: { answer: { type: 'choice', card: pick, values: ['小周'] }, origin: { n: 4 } } }))
    for (let i = 0; i < 50 && !calls.some(c => c[0] === 'chatSend'); i++) await new Promise(r => setTimeout(r, 5))
    assert.deepEqual(calls.find(c => c[0] === 'chatCardAnswer')[1], { n: 4, index: 0, answer: { type: 'choice', values: ['小周'] } })
    assert.equal(calls.find(c => c[0] === 'chatSend')[1].text, '小周')
    await live.poll()
    assert.equal(win.__ruyixChat.cards, undefined, 'answered: no longer waiting')
    // a confirm with a task, shown elsewhere: that task's 好了 / 再改
    win.dispatchEvent(new win.CustomEvent(ANSWER_EVENT, { detail: { answer: { type: 'confirm', value: 'ok', task: 't9' } } }))
    win.dispatchEvent(new win.CustomEvent(ANSWER_EVENT, { detail: { answer: { type: 'confirm', value: 'revise', text: 'shorter', task: 't9' } } }))
    await new Promise(r => setTimeout(r, 20))
    assert.deepEqual(calls.filter(c => c[0] === 'taskConfirm' || c[0] === 'taskRevise').map(c => [c[0], c[1]]), [['taskConfirm', { id: 't9' }], ['taskRevise', { id: 't9', text: 'shorter' }]])
    win.dispatchEvent(new win.CustomEvent(ANSWER_EVENT, { detail: { answer: { type: 'confirm', value: 'ok', task: 't9', run: 'r-original', expect: '7' } } }))
    await new Promise(r => setTimeout(r, 20))
    assert.deepEqual(calls.filter(c => c[0] === 'taskConfirm').at(-1)[1], { id: 't9', run: 'r-original', expect: '7' }, 'a new card carries the exact result it showed')
    stop()
    const before = calls.length
    win.dispatchEvent(new win.CustomEvent(ANSWER_EVENT, { detail: { answer: { type: 'choice', values: ['x'] } } }))
    await new Promise(r => setTimeout(r, 10))
    assert.equal(calls.length, before, 'stopped: not heard')
  }
  // the questions on the desk (docs/design/desk-answers.md): published to the shell's answers list with their hooks; a
  // leaf's card answered (origin { ask }) lands on its question; 「打开给我看」 puts the newest answer in front; one that is to
  // come up in front does, once
  {
    const { createChatState } = await import('./src/chat-state.js')
    const { ANSWER_EVENT } = await import('@ruyix/shell/cards-spec')
    const { answersRegistry, answersLayout } = await import('@ruyix/shell/answers')
    const listeners = {}
    const win = {
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
      addEventListener: (type, fn) => { (listeners[type] ||= new Set()).add(fn) },
      removeEventListener: (type, fn) => listeners[type]?.delete(fn),
      dispatchEvent: e => { for (const fn of listeners[e.type] || []) fn(e) },
    }
    const pick = { type: 'choice', question: 'Which city?', options: [{ label: '北京' }, { label: '上海' }] }
    let asks = [
      { id: 'ask:a1', question: 'weather?', state: 'answered', askedAt: 1, answeredAt: 5, lines: [], answer: { text: 'Sunny.' }, task: 'k1', open: 'leaf', seen: false },
      { id: 'ask:a2', question: 'which city to book?', state: 'answered', askedAt: 2, answeredAt: 4, lines: [], answer: { text: 'Pick one.', cards: [{ n: 9, cards: [pick] }] }, task: 'k2', open: 'leaf', seen: false },
      { id: 'ask:a3', question: 'a long one', state: 'working', askedAt: 3, lines: [{ at: 3, text: 'a long one', kind: 'ask' }], open: 'leaf', seen: false },
    ]
    const calls = [], fronts = []
    const call = async (op, a) => {
      calls.push([op, a])
      if (op === 'chat') return { items: [], running: true, tasks: [], asks }
      if (op === 'chatCardAnswer') return { item: { kind: 'cards', n: a.n, cards: [pick], answered: { 0: a.answer } }, handled: false, re: 'ask:a2' }
      if (op === 'chatAskSeen') asks = asks.filter(x => x.id !== a.id) // (seen: off the desk, as the server does)
      return {}
    }
    const kept = new Map(), store = { get: (k, d) => (kept.has(k) ? kept.get(k) : d), set: (k, v) => kept.set(k, v) }
    const live = createChatState({ call, win, lang: () => 'zh', store, key: 'seen3', quietMs: 1e9, busyMs: 1e9, onFront: id => fronts.push(id) })
    const stop = live.start()
    await live.poll()
    const reg = answersRegistry(win)
    assert.deepEqual(reg.get().map(x => x.id), ['ask:a3', 'ask:a2', 'ask:a1'], 'on the desk\'s list, the newest asked first')
    assert.deepEqual(Object.entries(answersLayout(reg.get())).map(([k, v]) => [k, v.map(x => x.id)]), [['stem', ['ask:a3']], ['leaves', ['ask:a2', 'ask:a1']], ['drawer', []]])
    // the hooks, through the list: into the drawer, seen (擦掉), in front
    reg.close('ask:a1')
    assert.deepEqual(calls.at(-1), ['chatAskOpen', { id: 'ask:a1', open: 'drawer' }])
    assert.deepEqual(answersLayout(reg.get()).drawer.map(x => x.id), ['ask:a1'])
    reg.seen('ask:a1')
    assert.deepEqual(calls.at(-1), ['chatAskSeen', { id: 'ask:a1' }])
    assert.ok(!reg.get().some(x => x.id === 'ask:a1'))
    reg.front('ask:a2')
    assert.deepEqual([fronts, calls.at(-1)], [['ask:a2'], ['chatAskOpen', { id: 'ask:a2', fronted: true }]])
    // a leaf's card: its question's cards entry; the pick goes out on that question
    win.dispatchEvent(new win.CustomEvent(ANSWER_EVENT, { detail: { answer: { type: 'choice', card: pick, values: ['北京'] }, origin: { ask: 'ask:a2', task: 'k2' } } }))
    for (let i = 0; i < 50 && !calls.some(c => c[0] === 'chatSend'); i++) await new Promise(r => setTimeout(r, 5))
    assert.deepEqual(calls.find(c => c[0] === 'chatCardAnswer')[1], { n: 9, index: 0, answer: { type: 'choice', values: ['北京'] } })
    assert.deepEqual([calls.find(c => c[0] === 'chatSend')[1].text, calls.find(c => c[0] === 'chatSend')[1].re], ['北京', 'ask:a2'])
    // 「打开给我看」 alone: the newest answer in front, nothing asked; after a question: that one's answer will be
    const sent = calls.filter(c => c[0] === 'chatSend').length
    asks = asks.map(x => (x.id === 'ask:a1' ? { ...x, answeredAt: 9 } : x)); await live.poll()
    assert.equal(await live.ask('打开给我看', 'voice'), true)
    assert.deepEqual([fronts.at(-1), calls.filter(c => c[0] === 'chatSend').length], ['ask:a2', sent], '(a1 was seen: a2 is the newest on the desk)')
    await live.ask('查一下明天的天气，打开给我看', 'voice')
    assert.deepEqual([calls.at(-1)[0] === 'chatSend' ? calls.at(-1)[1] : calls.filter(c => c[0] === 'chatSend').at(-1)[1]].map(x => [x.text, x.front]), [['查一下明天的天气', true]])
    // an answer to come up in front: once, when it is there
    asks = [...asks, { id: 'ask:a4', question: 'show me the plan', state: 'answered', askedAt: 6, answeredAt: 10, lines: [], open: 'leaf', seen: false, front: true }]
    await live.poll(); await live.poll()
    assert.equal(fronts.filter(x => x === 'ask:a4').length, 1)
    // a message on a question (a leaf's reply): `re`
    win.dispatchEvent(new win.CustomEvent('ruyix:chat-ask', { detail: { text: 'more on that', re: 'ask:a4' } }))
    for (let i = 0; i < 50 && calls.at(-1)?.[1]?.text !== 'more on that'; i++) await new Promise(r => setTimeout(r, 5))
    assert.equal(calls.filter(c => c[0] === 'chatSend').at(-1)[1].re, 'ask:a4')
    stop()
  }

  // ── a step's command-line tools (lib/toolbox.js): named in the definition, put in place by mise when needed (no root),
  // what mise cannot install said with how a person does — here against a mise stand-in (no network) ──
  {
    const { createToolbox, parseTool, howTo, which, versionIn, fits, hookProfiles, registryName } = await import('./lib/toolbox.js')
    assert.deepEqual([parseTool('golangci-lint').version, parseTool('gofmt').spec, parseTool('npm:@scope/pkg@2').bin, parseTool('asdf:x'), parseTool('a b')], [null, 'go', 'pkg', null, null])
    assert.deepEqual([howTo(parseTool('docker'), { box: 'b1' }).kind, howTo(parseTool('psql'), { box: 'b1' }).cmd, howTo(parseTool('psql'), { os: 'linux' }).cmd, howTo(parseTool('psql@16'), { box: 'b1' }).kind], ['engineBox', 'nookbox install b1 postgresql-client', 'sudo apt-get install -y postgresql-client', 'pinSystem'])
    // the definition carries them (a base step's and a step of one's own); one that is not a tool's name is an error
    const tctx = { bases: { blank }, builtIn: ['blank'], agents: ['writer'], connectors: [] }
    const lint = { id: 'lint', use: 'script', title: 'Lint', run: 'golangci-lint run', cli: ['golangci-lint', 'shellcheck@0.11.0', 'golangci-lint'] }
    const tdef = { id: 'tooled', title: 'Tooled', base: 'blank', steps: [{ use: 'intake' }, lint, { id: 'look', use: 'agent', title: 'Look', agent: 'writer', instructions: 'Look.', cli: ['jq'] }, { id: 'ask', use: 'model', title: 'Ask', instructions: 'Say.', model: 'dsh:p/m', cli: ['jq'] }, { use: 'report', cli: ['yq'] }] }
    const tv = validate(tdef, tctx)
    assert.deepEqual(tv.errors, [])
    assert.deepEqual(tv.def.steps.map(x => x.cli), [undefined, ['golangci-lint', 'shellcheck@0.11.0'], ['jq'], undefined, ['yq']], 'a model step has none; a base step may')
    const edit = (id, cli) => validate({ ...tdef, steps: tdef.steps.map(x => (x.id === id ? { ...x, cli } : x)) }, tctx).errors.map(e => e.message).join(' | ')
    assert.match(edit('lint', ['vfox:thing']), /not one: vfox:thing/)
    assert.match(edit('lint', ['docker@27']), /named without a version .*docker@27/, 'a system package\'s version is a person\'s')
    assert.match(edit('lint', Array.from({ length: 21 }, (_, i) => `tool${i}`)), /up to 20 command-line tools/)
    assert.equal(edit('lint', 'jq'), '', 'not a list: none')
    const tw = compose(tv.def, blank)
    assert.deepEqual([tw.stages.find(x => x.key === 'lint').cli, tw.stages.find(x => x.key === 'look').cli, tw.stages.find(x => x.key === 'report').cli], [['golangci-lint', 'shellcheck@0.11.0'], ['jq'], ['yq']], 'the engine sees each step\'s list')
    assert.equal(typeof tw.stages.find(x => x.key === 'lint').fail, 'function', 'a step of one\'s own fails the way its "on failure" says')

    // readiness: here, installed on the first run, only a person; and one its runs' agents asked for, suggested
    const rctx = { agents: ['writer'], skills: async () => [], connections: [], bindings: { resolve: () => ({}) }, scripts: [], base: {}, used: { lint: ['ruff', 'golangci-lint'] },
      tools: async list => list.map(ref => ({ ref, status: ref === 'jq' ? 'ok' : ref.startsWith('shellcheck') ? 'missing' : 'fetch' })) }
    const rd = await readiness(tv.def, rctx)
    assert.deepEqual(rd.steps.find(x => x.id === 'lint').items.map(i => `${i.ref}:${i.status}`), ['golangci-lint:fetch', 'shellcheck@0.11.0:missing', 'ruff:suggested'])
    assert.deepEqual([rd.missing, rd.installable], [1, 2], 'a tool a person must install is missing; the others install themselves')
    // (a step may be called constructor: no prototype's entry read as its suggestions)
    const ctor = validate({ ...tdef, steps: tdef.steps.map(x => (x.id === 'lint' ? { ...x, id: 'constructor' } : x)) }, tctx).def
    assert.ok((await readiness(ctor, { ...rctx, tools: async list => list.map(ref => ({ ref, status: 'ok' })), used: Object.create(null) })).steps.length)

    // the tool's own version, from all it says; a version fits what is asked (1 and 1.64 fit 1.64.8; no prerelease a stable)
    assert.deepEqual([versionIn('golangci-lint has version 1.64.8 built with go1.25.0'), versionIn('ShellCheck\nversion: 0.10.0'), versionIn('jq-1.7.1'), versionIn('gcc (Debian 12.2.0-14+deb12u1) 12.2.0'), versionIn('GNU bash, version 5.2.21(1)-release')], ['1.64.8', '0.10.0', '1.7.1', '12.2.0', '5.2.21'])
    assert.deepEqual([fits('1.64.8', '1'), fits('1.64.8', '1.6'), fits('1.2.3-rc.1', '1.2'), fits('1.25rc1', '1'), fits('6.0a1', '6'), fits('v0.25.0', '0.25')], [true, false, false, false, false, true])

    // the toolbox against a mise stand-in (a Unix thing: executables by mode, a PATH of directories): a registry, versions
    // side by side, `use -g` selecting one, bin-paths and env for what is selected, bin-paths --json for one version
    if (process.platform === 'win32') console.log('workbench config check: toolbox stand-in skipped on Windows (mise installs on Linux and macOS)')
    else {
      const root = mkdtempSync(join(tmp, 'tools-')), oldPath = process.env.PATH
      const sys = mkdtempSync(join(tmp, 'sys-')) // (a system directory: not the toolbox's)
      try {
        const mise = join(root, 'mise-2026.9.18', 'mise', 'bin', 'mise')
        mkdirSync(join(mise, '..'), { recursive: true }); writeFileSync(mise, '')
        const REG = { foo: 'asdf:x/foo aqua:o/foo', sc: 'aqua:k/sc', uv: 'aqua:astral-sh/uv', vonly: 'vfox:x/vonly', go: 'core:go' }
        const versions = {}, global = {}, calls = []
        let envNow = { GOROOT: '/g' }, flaky = true, flakyGo = true, dockerUp = false, flakyRg = true
        const exe = x => ({ 'npm:typescript': 'tsc' })[x] || x.split(/[:/]/).pop()
        const dirOf = (spec, v) => join(root, 'data', 'installs', spec.replace(/[:/]/g, '-'), v)
        const resolve = (spec, want) => (want === 'latest' ? (versions[spec]?.has('1.2.3') ? '1.2.3' : null) : [...(versions[spec] || [])].find(v => v === want || v.startsWith(`${want}.`)) || null)
        const put = (spec, want) => { const v = want === 'latest' ? '1.2.3' : resolve(spec, want) || want; (versions[spec] ||= new Set()).add(v); mkdirSync(dirOf(spec, v), { recursive: true }); for (const n of [exe(spec), ...(spec === 'core:go' ? ['gofmt'] : [])]) writeFileSync(join(dirOf(spec, v), n), '#!/bin/sh\n', { mode: 0o755 }); return v }
        const run = async (cmd, a0) => {
          calls.push(a0.join(' '))
          if (cmd === 'docker' && a0[0] === 'info') return dockerUp ? { code: 0, stdout: 'Server: …', stderr: '' } : { code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket' }
          if (cmd !== mise) return { code: 1, stdout: '', stderr: 'no' }
          // (mise's short name go is its core:go)
          const args = a0[0] === 'registry' ? a0 : a0.map(x => (x === 'go' || x.startsWith('go@') ? `core:${x}` : x))
          if (args[0] === 'env') return { code: 0, stdout: JSON.stringify({ PATH: '/x', ...envNow }), stderr: '' }
          if (args[0] === 'registry') return REG[args[1]] ? { code: 0, stdout: REG[args[1]], stderr: '' } : { code: 1, stdout: '', stderr: 'tool not found in registry' }
          if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify(global[args[3]] ? [{ version: global[args[3]].version, requested_version: global[args[3]].want, installed: true }] : []), stderr: '' } // (one tool's entry: ls --global --json <spec>)
          if (args[0] === 'bin-paths' && args[1] === '--json') {
            const [spec, want] = [args[2].slice(0, args[2].lastIndexOf('@')), args[2].slice(args[2].lastIndexOf('@') + 1)], v = resolve(spec, want)
            return { code: 0, stdout: JSON.stringify(v ? [exe(spec), ...(spec === 'core:go' ? ['gofmt'] : [])].map(name => ({ name, path: join(dirOf(spec, v), name) })) : []), stderr: '' }
          }
          if (args[0] === 'bin-paths') return { code: 0, stdout: Object.entries(global).map(([k, g]) => dirOf(k, g.version)).join('\n'), stderr: '' }
          if (args[0] === 'use') {
            const at = args.at(-1), [spec, want] = [at.slice(0, at.lastIndexOf('@')), at.slice(at.lastIndexOf('@') + 1)]
            if (at === 'aqua:br/ripgrep@14' && flakyRg) { flakyRg = false; return { code: 1, stdout: '', stderr: 'mise ERROR download failed' } }
            if (spec === 'aqua:o/broken' || (at === 'aqua:k/sc@0.13' && flaky) || (at === 'core:go@1.26.0' && flakyGo)) { if (at === 'core:go@1.26.0') flakyGo = false; else flaky = false; return { code: 1, stdout: '', stderr: 'mise ERROR download failed' } }
            global[spec] = { version: put(spec, want), want }
            return { code: 0, stdout: '', stderr: '' }
          }
          return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
        }
        writeFileSync(join(sys, 'psql'), '#!/bin/sh\n', { mode: 0o755 })
        process.env.PATH = sys
        const tb = createToolbox({ root, run, box: 'b1' })
        mkdirSync(join(root, 'config'), { recursive: true }); writeFileSync(join(root, 'config', 'config.toml'), '')
        const foo = await tb.need('foo')
        assert.deepEqual([foo.status, foo.spec, foo.version, foo.path], ['installed', 'aqua:o/foo', '1.2.3', join(dirOf('aqua:o/foo', '1.2.3'), 'foo')], 'from the first backend a run may use (not asdf)')
        // …in the environment of a step's processes (tb.env()) — never in this process's own: dsh's own commands (git…) stay what they were
        assert.deepEqual([process.env.PATH, process.env.RUYIX_TOOLS_PATH, process.env.GOROOT], [sys, undefined, undefined], 'dsh\'s own PATH and environment are not touched by an install')
        assert.deepEqual([tb.env().PATH.split(':')[0], tb.env().PATH.endsWith(`:${sys}`), tb.env().RUYIX_TOOLS_PATH, tb.env().GOROOT], [dirOf('aqua:o/foo', '1.2.3'), true, dirOf('aqua:o/foo', '1.2.3'), '/g'], 'what mise selected first on the PATH of what a step starts — and the variables its tools need')
        assert.equal(which('foo'), null, 'dsh itself does not find it')
        assert.equal(which('foo', tb.env().PATH), join(dirOf('aqua:o/foo', '1.2.3'), 'foo'))
        assert.equal((await tb.need('foo')).status, 'ok', 'here now')
        // what an agent asks for itself is a registry short name; an explicit backend (or any source) is refused before mise runs
        assert.deepEqual(['shellcheck', 'jq@1.7.1', 'golangci-lint@1.64', 'g++'].map(registryName), [true, true, true, true])
        assert.deepEqual(['npm:x', 'pipx:bandit', 'github:o/r', 'ubi:o/r', 'cargo:x', 'go:x', 'aqua:o/r', 'http:x', 'o/r', '@scope/pkg', '../x', 'a b', '', 'jq@1;id'].map(registryName), Array(14).fill(false))
        {
          const before = calls.length
          for (const bad of ['npm:left-pad', 'github:o/r', 'ubi:o/r', 'pipx:bandit', 'aqua:o/foo', 'http:x']) {
            const r = await tb.need(bad, { by: 'agent' })
            assert.deepEqual([r.status, /refused/.test(r.error)], ['missing', true], bad)
          }
          assert.equal(calls.length, before, 'mise was not asked: nothing from a backend is installed on an agent\'s word')
          assert.equal((await tb.need('foo', { by: 'agent' })).status, 'ok', 'a registry name is fine')
        }
        // a shell started before is brought up to date by one line: mise's directories first, the variables its tools need
        assert.equal(tb.activation(), `export PATH='${dirOf('aqua:o/foo', '1.2.3')}':"$PATH"; export RUYIX_TOOLS_PATH='${dirOf('aqua:o/foo', '1.2.3')}'; export GOROOT='/g'`)
        assert.equal((await tb.need('aqua:o/stepx', { by: 'step' })).status, 'installed', 'a person\'s workflow (the step\'s cli list) may name a backend')
        // a version named is installed and selected (one version of a tool in use at a time); without one, the selected stays
        const [a, b] = [await tb.need('sc@0.10.0'), await tb.need('sc@0.11.0')]
        assert.deepEqual([a.status, b.status, which('sc', tb.env().PATH), calls.filter(c => c.startsWith('use ')).slice(-2)], ['installed', 'installed', join(dirOf('aqua:k/sc', '0.11.0'), 'sc'), ['use -g aqua:k/sc@0.10.0', 'use -g aqua:k/sc@0.11.0']])
        const n0 = calls.filter(c => c.startsWith('use ')).length
        assert.deepEqual([(await tb.need('sc')).status, (await tb.need('sc@0.11')).status, calls.filter(c => c.startsWith('use ')).length], ['ok', 'ok', n0], 'what is selected and fits: no switch')
        assert.deepEqual((await tb.check(['sc@0.10.0', 'sc@0.12.0'])).map(x => x.status), ['ok', 'fetch'], 'installed (a switch away), or a run installs it')
        // a failure once is past when the tool is put in place after all (another request of it, a moment later)
        assert.equal((await tb.need('sc@0.13')).status, 'missing')
        assert.equal((await tb.need('sc@0.13.0')).status, 'installed')
        assert.equal((await tb.need('sc@0.13')).status, 'ok', 'not held back by the earlier failure')
        await tb.need('sc@0.11.0')
        // …through another name too: gofmt failed, go put in place brings it
        assert.equal((await tb.need('gofmt@1.26.0')).status, 'missing')
        assert.equal((await tb.need('core:go@1.26.0')).status, 'installed')
        assert.notEqual((await tb.need('gofmt@1.26.0')).status, 'missing', 'not held back by the earlier failure')
        // …and by another name of the same package (ripgrep failed; rg, its other name, put it in place)
        REG.ripgrep = 'aqua:br/ripgrep'
        assert.equal((await tb.need('ripgrep@14')).status, 'missing')
        assert.equal((await tb.need('rg@14.1.1')).status, 'installed')
        assert.notEqual((await tb.need('ripgrep@14')).status, 'missing')
        // a broad request the selected version fits is that version (not another installed one mise would resolve it to)
        const broad = await tb.need('sc@0')
        assert.deepEqual([broad.status, broad.version, broad.path, (await tb.check(['sc@0']))[0].status], ['ok', '0.11.0', join(dirOf('aqua:k/sc', '0.11.0'), 'sc'), 'ok'])
        // mise unable to say what is selected (its env unreadable): the request fails, the PATH and environment stay as they were
        {
          const pathWas = tb.env().PATH, envWas = envNow
          envNow = null
          REG.env1 = 'aqua:o/env1'
          const t2 = createToolbox({ root, run: async (cmd, args) => (cmd === mise && args[0] === 'env' ? { code: 1, stdout: '', stderr: 'mise ERROR' } : run(cmd, args)), box: 'b1' })
          const e1 = await t2.need('env1')
          assert.deepEqual([e1.status, /could not say what is selected/.test(e1.error), tb.env().PATH === pathWas, tb.env().GOROOT], ['missing', true, true, '/g'])
          assert.equal(process.env.GOROOT, undefined)
          envNow = envWas
        }
        // a package that runs as another name (typescript → tsc); a tool from pip's world takes uv first
        const ts = await tb.need('npm:typescript')
        assert.deepEqual([ts.status, ts.path], ['installed', join(dirOf('npm:typescript', '1.2.3'), 'tsc')])
        const bandit = await tb.need('pipx:bandit'), uses = calls.filter(c => c.startsWith('use ')).map(c => c.split(' ')[2])
        assert.deepEqual([bandit.status, uses.indexOf('aqua:astral-sh/uv@latest') > -1 && uses.indexOf('aqua:astral-sh/uv@latest') < uses.indexOf('pipx:bandit@latest')], ['installed', true])
        // an engine, a name mise does not know, one only a plugin offers, a system package's version: a person's, said how
        const [docker, nosuch, vonly, psql16, psql] = [await tb.need('docker'), await tb.need('nosuch'), await tb.need('vonly'), await tb.need('psql@16'), await tb.need('psql')]
        assert.deepEqual([docker.how.kind, nosuch.how.kind, nosuch.how.cmd, vonly.status, psql16.how.kind, psql.status], ['engineBox', 'unknownBox', 'nookbox install b1 nosuch', 'missing', 'pinSystem', 'ok'])
        assert.deepEqual((await tb.check(['foo', 'docker', 'nosuch', 'newone', 'psql@16'])).map(x => x.status), ['ok', 'missing', 'missing', 'missing', 'missing'], 'readiness asks, installs nothing')
        REG.newer = 'aqua:o/newer'
        assert.equal((await tb.check(['newer']))[0].status, 'fetch')
        // an engine there but not answering this user is missing, said why; answering, it is here
        writeFileSync(join(sys, 'docker'), '#!/bin/sh\n', { mode: 0o755 })
        const [down, downReady] = [await tb.need('docker'), (await tb.check(['docker']))[0]]
        assert.deepEqual([down.status, /permission denied/.test(down.error), downReady.status], ['missing', true, 'missing'])
        dockerUp = true
        assert.deepEqual([(await tb.need('docker')).status, (await tb.check(['docker']))[0].status], ['ok', 'ok'])
        rmSync(join(sys, 'docker'))
        // what mise's selection needs beside the PATH follows it: a variable no longer given goes
        envNow = {}
        await tb.refresh()
        assert.equal(tb.env().GOROOT, undefined)
        REG.broken = 'aqua:o/broken'
        const broken = await tb.need('broken')
        assert.deepEqual([broken.status, broken.how.kind, /download failed/.test(broken.error)], ['missing', 'miseFailed', true])
        const n = calls.length
        await tb.need('broken')
        assert.equal(calls.length, n, 'a tool that could not be had is not tried again at once')
        // mise itself: fetched once, its SHA-256 checked against the pinned one; without it, a tool here is still enough
        const bad = createToolbox({ root: join(root, 'fresh'), run, box: null, platform: 'linux', arch: 'x64', fetchMise: async (url, file) => { writeFileSync(file, 'not mise'); return { code: 0 } } })
        assert.match((await bad.need('newer')).error, /SHA-256 .* not the release's/)
        // a machine mise has no release for (Windows) says so, and a tool that is there is still enough
        const win = createToolbox({ root: join(root, 'win'), run, box: null, platform: 'win32', arch: 'x64' })
        assert.match((await win.need('newer')).error, /mise installs tools on Linux and macOS only/)
        assert.equal((await win.need('psql')).status, 'ok')
        // once mise is there after all (another request put it in place), a request that failed for want of it is tried again
        {
          const badRoot = join(root, 'fresh'), badMise = join(badRoot, 'mise-2026.9.18', 'mise', 'bin', 'mise')
          mkdirSync(join(badMise, '..'), { recursive: true }); writeFileSync(badMise, '')
          mkdirSync(join(badRoot, 'config'), { recursive: true }); writeFileSync(join(badRoot, 'config', 'config.toml'), '')
          const later = createToolbox({ root: badRoot, run: async (cmd, args) => run(cmd === badMise ? mise : cmd, args), box: null })
          assert.equal((await later.need('newer')).status, 'missing', 'within ten minutes: as it was')
          assert.equal((await later.need('aqua:o/fresh1')).status, 'installed')
          assert.notEqual((await later.need('newer')).status, 'missing', 'mise works now: tried again')
        }
        assert.equal((await bad.need('psql')).status, 'ok')
        // a login shell started by Ruyix keeps what mise selected first, after its profile puts ~/.local/bin first again (a real bash)
        {
          const { execFileSync } = await import('node:child_process')
          const home = mkdtempSync(join(tmp, 'home-')), tools = join(home, 'tools'), local = join(home, '.local', 'bin')
          mkdirSync(tools); mkdirSync(local, { recursive: true })
          for (const d of [tools, local]) writeFileSync(join(d, 'sc'), '#!/bin/sh\n', { mode: 0o755 })
          writeFileSync(join(home, '.profile'), 'if [ -d "$HOME/.local/bin" ] ; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n')
          hookProfiles(home); hookProfiles(home)
          const bashSees = env => execFileSync('bash', ['-lc', 'command -v sc'], { env: { HOME: home, PATH: `${tools}:/usr/bin:/bin`, ...env } }).toString().trim()
          assert.deepEqual([bashSees({ RUYIX_TOOLS_PATH: tools }), bashSees({}), readFileSync(join(home, '.profile'), 'utf8').split('# ruyix:').length - 1], [join(tools, 'sc'), join(local, 'sc'), 1], 'what Ruyix starts: its tool; a person\'s own shell: unchanged; the line added once')
        }
        // a relative directory on the PATH is never where a tool is found (each command starts elsewhere)
        { const pathWas = process.env.PATH; process.env.PATH = `.:${sys}`; assert.equal(which('psql'), join(sys, 'psql')); process.env.PATH = pathWas }
        // two toolboxes of one home (two workbenches in one dsh) share its queue and what failed
        const twin = createToolbox({ root, run, box: 'b1' })
        assert.deepEqual([(await twin.need('foo')).status, (await twin.need('broken')).error === broken.error], ['ok', true])
      } finally { process.env.PATH = oldPath; delete process.env.RUYIX_TOOLS_PATH; delete process.env.GOROOT }
    }
  }
  console.log('workbench config check: ok')
} finally {
  // Windows does not delete a database that is still open (the store's, until the process ends): left in tmp
  try { rmSync(tmp, { recursive: true, force: true }) } catch (err) { if (process.platform !== 'win32') throw err }
}

{
  const source = readFileSync(new URL('./src/wf-editor.jsx', import.meta.url), 'utf8')
  const { ALWAYS: actual } = await import('./lib/tools.js')
  const shown = new Function(source.match(/const ALWAYS = [^\n]+/)[0] + ';return ALWAYS')()
  assert.deepEqual(shown, actual, 'the editor hides every always-available tool')
  const at = source.indexOf(": { mode: 'condition', routes:"), end = source.indexOf(')}>{m', at)
  const changeMode = new Function('s', 'before', `return (${source.slice(at + 2, end)})`)
  const switched = changeMode({ routes: [{ id: 'r', hint: 'go here' }] }, [{ id: 'earlier' }])
  assert.deepEqual(switched.routes[0].when, { step: 'earlier', is: 'passed' }, 'switching modes emits a complete condition')
}

{
  const fs = (await import('node:fs')).default, { syncBuiltinESMExports } = await import('node:module')
  const { readState, writeState } = await import('./lib/settings.js')
  const dir = fs.mkdtempSync(join(tmpdir(),'ruyix-atomic-state-')), file = join(dir,'settings.json'), assistant = join(dir,'assistant.json')
  const write = fs.writeFileSync
  try {
    saveSettings({...defaultsOf([]),workspace:'kept-workspace'},file)
    const before=fs.readFileSync(file,'utf8')
    fs.writeFileSync=(target,...args)=>{if(typeof target==='number'){write(target,'{"partial":');throw Object.assign(new Error('disk full'),{code:'ENOSPC'})}return write(target,...args)}
    syncBuiltinESMExports()
    try{assert.throws(()=>saveSettings({...defaultsOf([]),workspace:'new-workspace'},file),{code:'ENOSPC'})}
    finally{fs.writeFileSync=write;syncBuiltinESMExports()}
    assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(loadSettings(file).workspace,'kept-workspace')
    assert.ok(!fs.readdirSync(dir).some(p=>p.endsWith('.tmp')))
    write(file,'{"damaged":');assert.throws(()=>loadSettings(file),{code:'badState'})
    assert.throws(()=>saveSettings(defaultsOf([]),file),{code:'badState'});assert.equal(fs.readFileSync(file,'utf8'),'{"damaged":')
    writeState(assistant,{main:{agent:'kept'}});assert.equal(readState(assistant).main.agent,'kept')
    write(assistant,'{');assert.throws(()=>readState(assistant),{code:'badState'});assert.throws(()=>writeState(assistant,{}),{code:'badState'})
  }finally{fs.writeFileSync=write;syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true})}
}
