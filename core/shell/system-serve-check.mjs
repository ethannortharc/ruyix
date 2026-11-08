// Self-check: the whole Ruyix as one MCP server (system-serve.js + bin/ruyix-mcp.mjs) — an agent's MCP client over the
// real socket: the tools it is offered (not the conversation's cards, not the undo ones), a call that acts going on
// record with its way back under the caller's name, taking it back, a caller with no token, a home too long for a socket.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSystemTools } from './system.js'
import { actionTools, createActionLog, createCallers, serveSystem, systemSockPath } from './system-serve.js'

const home = mkdtempSync(join(tmpdir(), 'ruyix-sys-'))
const tools = createSystemTools(), did = []
const s = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
tools.register({ name: 'lamp_get', title: { zh: '看灯', en: 'See the lamp' }, effect: 'read', description: 'the lamp', parameters: s({}), run: async () => ({ text: `lamp: ${did.at(-1) || 'off'}` }) })
tools.register({ name: 'lamp_set', title: { zh: '开灯', en: 'Set the lamp' }, effect: 'direct', description: 'turn it', parameters: s({ to: { type: 'string' } }, ['to']),
  run: async ({ to }, { by }) => { did.push(to); return { text: `lamp ${to}`, summary: { zh: `灯：${to}`, en: `lamp: ${to}` }, undo: { tool: 'lamp_back', args: { to: 'off' } }, by } } })
tools.register({ name: 'lamp_back', effect: 'undo', description: '', parameters: s({}), run: async ({ to }) => { did.push(to); return { text: `lamp ${to}` } } })
tools.register({ name: 'lamp_list', effect: 'direct', description: 'lists, or picks one', parameters: s({ pick: { type: 'string' } }), run: async ({ pick }) => (pick ? { text: `picked ${pick}`, summary: { zh: `选了 ${pick}`, en: `picked ${pick}` } } : { text: 'red, blue' }) })
tools.register({ name: 'card_show', effect: 'read', chat: true, description: 'cards', parameters: s({}), run: async () => ({ text: '' }) })
for (const t of actionTools({ tools, actions: createActionLog({ home }) })) tools.register(t)

const callers = createCallers(), actions = createActionLog({ home })
const sock = systemSockPath(home)
const stop = serveSystem({ tools, callers, actions, sock })
await new Promise(r => setTimeout(r, 100))

// an agent's MCP client: the bridge as Agent Hub starts it (its token in its env)
function client(env, args = []) {
  const p = spawn(process.execPath, [fileURLToPath(new URL('./bin/ruyix-mcp.mjs', import.meta.url)), ...args], { env: { ...process.env, RUYIX_SYS_SOCK: '', RUYIX_SYS_TOKEN: '', ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = '', n = 0
  const waits = new Map()
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); waits.delete(m.id) } })
  const rpc = (method, params = {}) => new Promise(r => { const id = ++n; waits.set(id, r); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) })
  const call = async (name, a = {}) => { const r = (await rpc('tools/call', { name, arguments: a })).result; return { text: r.content[0].text, isError: !!r.isError } }
  return { rpc, call, end: () => p.kill() }
}

{
  let release, count=0
  const raceHome=mkdtempSync(join(tmpdir(),'ruyix-undo-race-')),registry=createSystemTools(),records=createActionLog({home:raceHome})
  registry.register({name:'slow_back',effect:'undo',parameters:s({}),run:async(_args,context)=>{assert.equal(context.undo,true);count++;await new Promise(r=>{release=r});return {text:'once'}}})
  const rec=records.add({tool:'fixture',undo:{tool:'slow_back',args:{}},summary:{en:'fixture',zh:'测试'}})
  const undo=actionTools({tools:registry,actions:records}).find(t=>t.name==='action_undo')
  const first=undo.run({id:rec.id}),second=undo.run({id:rec.id})
  while(!release)await new Promise(r=>setTimeout(r,0));release();await Promise.all([first,second]);assert.equal(count,1);rmSync(raceHome,{recursive:true,force:true})
}
try {
  const token = callers.mint({ who: 'session:abc', title: '写周报', of: 'session:abc' })
  const a = client({ RUYIX_SYS_SOCK: sock, RUYIX_SYS_TOKEN: token })
  const init = (await a.rpc('initialize', { protocolVersion: '2025-06-18' })).result
  assert.equal(init.serverInfo.name, 'ruyix'); assert.match(init.instructions, /Do only what the person asked/)
  const listed = (await a.rpc('tools/list')).result.tools
  assert.deepEqual(listed.map(t => t.name).sort(), ['action_undo', 'actions_list', 'lamp_get', 'lamp_list', 'lamp_set'], 'not the conversation\'s cards, not the undo ones')
  // one that acts but, asked with nothing, only listed: nothing on record
  assert.equal((await a.call('lamp_list')).text, 'red, blue'); assert.equal(actions.list().length, 0, 'a listing is no action')
  assert.match((await a.call('lamp_list', { pick: 'red' })).text, /^picked red/); assert.equal(actions.list().length, 1)
  assert.equal(listed.find(t => t.name === 'lamp_get').annotations.readOnlyHint, true)
  assert.deepEqual(listed.find(t => t.name === 'lamp_set').inputSchema.required, ['to'])

  // one that acts: done, on record under its name and work, with the way back
  const set = await a.call('lamp_set', { to: 'on' })
  const id = /on record as (a\w+)/.exec(set.text)?.[1]
  assert.ok(id, set.text); assert.deepEqual(did, ['on'])
  const rec = actions.get(id)
  assert.deepEqual([rec.tool, rec.by, rec.byTitle, rec.of, rec.summary.zh, rec.undo.tool], ['lamp_set', 'session:abc', '写周报', 'session:abc', '灯：on', 'lamp_back'])
  assert.match((await a.call('actions_list')).text, new RegExp(`${id} · .* · 写周报: lamp: on$`, 'm'))
  // taken back (as the person says); a second time: said so; the undo tool itself is no tool of theirs
  assert.match((await a.call('action_undo', { id })).text, /Taken back: lamp: on/)
  assert.deepEqual(did, ['on', 'off'])
  assert.match((await a.call('action_undo', { id })).text, /taken back already/)
  assert.match((await a.call('actions_list')).text, /\(undone\)/)
  const no = await a.call('lamp_back', { to: 'x' })
  assert.equal(no.isError, true); assert.match(no.text, /no tool lamp_back/)
  assert.equal((await a.call('card_show')).isError, true, 'cards: the conversation\'s only')
  a.end()

  // `ruyix mcp --as …` by hand (no token): on record by the name it gave; the socket found from the home
  const b = client({ RUYIX_HOME: home }, ['--as', 'Claude Code (Mac)'])
  await b.rpc('initialize')
  assert.match((await b.call('lamp_set', { to: 'dim' })).text, /lamp dim/)
  assert.deepEqual([actions.list({ limit: 1 })[0].by, actions.list({ limit: 1 })[0].byTitle], ['outside:Claude Code (Mac)', 'Claude Code (Mac)'])
  assert.match(readFileSync(join(home, 'actions.jsonl'), 'utf8'), /"by":"outside:Claude Code \(Mac\)"/)
  b.end()

  // Ruyix not running: the agent is told so
  const c = client({ RUYIX_SYS_SOCK: join(home, 'none.sock') })
  assert.match((await c.call('lamp_get')).text, /Ruyix does not answer/)
  c.end()

  // a home too long for a socket: one in the temp, named where `ruyix mcp` looks
  const deep = join(home, 'x'.repeat(90)); (await import('node:fs')).mkdirSync(deep)
  const far = systemSockPath(deep)
  assert.ok(far.startsWith(tmpdir()) && readFileSync(join(deep, 'system.sock.path'), 'utf8').trim() === far)
} finally {
  stop()
  rmSync(home, { recursive: true, force: true })
}
console.log('shell system-serve check: ok')
