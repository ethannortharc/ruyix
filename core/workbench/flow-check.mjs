// Script steps (lib/flow): the realm a script runs in, the journal that makes a run go on after a stop, and the static
// check. In a worker thread always; in dsh's confined PTC process too when this machine has it (DSH_ROOT: the folder of
// dsh's packages, else dsh's profile). `node flow-check.mjs`
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { guests, runFlow, stepsOf } from './lib/flow/runtime.js'
import { checkFlow } from './lib/flow/check.js'
import { FLOW_TEMPLATE } from './lib/flow/names.js'

const memory = () => { let j = null; return { load: () => (j ? structuredClone(j) : null), save: x => { j = structuredClone(x) }, get: () => j } }

async function suite(guest, label) {
  // a run that stops half way goes on from the first step not done: nothing done twice, a flaky step tried again
  {
    const journal = memory(), calls = []
    let flaky = 0
    const actions = {
      sh: async ({ command }) => { if (command === 'up') return actions.up(); calls.push(command); return { code: 0, stdout: `ran ${command}`, stderr: '' } },
      up: async () => { if (++flaky < 2) throw new Error('not yet'); return 'up' },
      evidence: async ({ title }) => { calls.push(`evidence:${title}`); return null },
    }
    const source = `
      const a = await wf.step('build', s => s.sh('make'))
      const b = await wf.step('upload', s => s.sh('up'), { retries: 2 })
      const turns = []
      for (let i = 0; i < 2; i++) turns.push(await wf.step('fix', s => s.sh('fix ' + i)))
      await wf.step('report', s => s.evidence('done', { a: a.stdout, b, turns: turns.length }))
      return { at: await wf.now(), b }`
    const stop = new AbortController()
    const half = { ...actions, sh: async a => { const r = await actions.sh(a); if (a.command === 'fix 0') stop.abort(); return r } }
    const first = await runFlow({ guest, name: 'demo', source, signal: stop.signal, journal, actions: half })
    assert.equal(first.ok, false, `${label}: stopped half way`)
    assert.deepEqual(journal.get().order, ['build#1', 'upload#1', 'fix#1'])
    assert.equal(journal.get().steps['upload#1'].attempts, 2, 'the flaky step was tried again')
    const second = await runFlow({ guest, name: 'demo', source, journal, actions })
    assert.equal(second.ok, true, second.error)
    assert.deepEqual(calls, ['make', 'fix 0', 'fix 0', 'fix 1', 'evidence:done'], 'done steps answer from the record; the interrupted one runs again')
    assert.deepEqual(stepsOf(journal.get()).map(s => [s.title, s.status]), [['build', 'passed'], ['upload', 'passed'], ['fix · 1', 'passed'], ['fix · 2', 'passed'], ['report', 'passed']])
    const third = await runFlow({ guest, name: 'demo', source, journal, actions })
    assert.equal(third.value.at, second.value.at, 'wf.now() is kept: a resumed run sees the same time')
    assert.equal(calls.length, 5, 'all done: nothing runs again')
  }
  // what a script may not do: reach out of its realm, act outside a step, decide by the clock
  {
    const source = `
      const r = {}
      const t = (k, f) => { try { r[k] = 'REACHED ' + String(f()) } catch (e) { r[k] = 'blocked' } }
      t('process', () => { if (typeof process === 'undefined') throw new ReferenceError(); return typeof process })
      t('require', () => { if (typeof require === 'undefined') throw new ReferenceError(); return typeof require })
      t('fetch', () => { if (typeof fetch === 'undefined') throw new ReferenceError(); return typeof fetch })
      t('setTimeout', () => { if (typeof setTimeout === 'undefined') throw new ReferenceError(); return 'timer' })
      t('eval', () => eval('1 + 1'))
      t('Function', () => Function('return 1')())
      t('wf.step ctor', () => wf.step.constructor('return process')())
      t('this ctor', () => this.constructor.constructor('return process')())
      t('Date.now', () => Date.now())
      t('new Date', () => new Date())
      t('Math.random', () => Math.random())
      try { await import('node:fs'); r.import = 'REACHED' } catch (e) { r.import = 'blocked' }
      try { await wf.step('x', s => s.agent('a', 'b')) } catch (e) { t('host error ctor', () => e.constructor.constructor('return process')()) }
      try { await wf.step('y', s => s.nope()) } catch (e) { r.unknownOp = 'blocked' }
      let keep
      await wf.step('z', s => { keep = s; return 1 })
      try { await keep.sh('late') } catch (e) { r.outside = e.message.includes('inside a step') ? 'blocked' : e.message }
      return { r, dateZero: new Date(0).getTime() }`
    const r = await runFlow({ guest, name: 'escape', source, journal: memory(), actions: { agent: async () => { throw new Error('agent refused') }, sh: async () => 'ran' } })
    assert.equal(r.ok, true, r.error)
    for (const [k, v] of Object.entries(r.value.r)) assert.equal(v, 'blocked', `${label}: ${k} is ${v}`)
    assert.deepEqual([Object.keys(r.value.r).length, r.value.dateZero], [15, 0], 'every probe ran; a given date still works')
  }
  // a person's stop is not tried again; a result too large is refused; a script that does not parse says so
  {
    const journal = memory()
    let asked = 0
    const r = await runFlow({ guest, name: 'stop', source: `await wf.step('ask', s => s.ask('go on?'), { retries: 3 })`, journal,
      actions: { ask: async () => { asked++; throw Object.assign(new Error('stopped by the person'), { code: 'stopped' }) } } })
    assert.deepEqual([r.ok, r.halted, asked], [false, true, 1], `${label}: a person's stop ends it`)
    const big = await runFlow({ guest, name: 'big', source: `await wf.step('big', () => 'x'.repeat(70000))`, journal: memory(), actions: {} })
    assert.match(big.error, /more than 64 KB/)
    const bad = await runFlow({ guest, name: 'bad', source: 'await wf.step(', journal: memory(), actions: {} })
    assert.match(bad.error, /does not parse/)
  }
  // branches at the same time: each branch's steps are its own (a resumed run gives each branch its own results, however
  // they were timed); the script's own wf.step inside a branch is refused
  {
    const journal = memory()
    let first = true
    const actions = { sh: async ({ command }) => { if (first && command === 'read a') await new Promise(r => setTimeout(r, 150)); if (first && command === 'write b') throw new Error('interrupted'); return command } }
    const source = `return await wf.parallel(['a', 'b'].map(x => async b => { await b.step('read', s => s.sh('read ' + x)); return b.step('write', s => s.sh('write ' + x)) }))`
    await runFlow({ guest, name: 'par', journal, source, actions })
    first = false
    const r = await runFlow({ guest, name: 'par', journal, source, actions })
    assert.deepEqual([r.ok, r.value], [true, ['write a', 'write b']], `${label}: each branch its own results: ${r.error}`)
    assert.ok(journal.get().order.every(k => /^p1\.[01]\//.test(k)))
    const own = await runFlow({ guest, name: 'par2', journal: memory(), source: `await wf.parallel([() => wf.step('a', () => 1)])`, actions: {} })
    assert.match(own.error, /each branch takes its own steps/)
    // steps do not nest, nor overlap in one line (a replay would hand a later step an inner one's result)
    const nested = await runFlow({ guest, name: 'nest', journal: memory(), source: `await wf.step('outer', async () => wf.step('check', () => 1))`, actions: {} })
    assert.match(nested.error, /one step at a time/)
    // a person sending the run back (an agent's decision: revise): the script ends there — no try again, no later step
    let tries = 0
    const sentBack = await runFlow({ guest, name: 'revise', journal: memory(), source: `await wf.step('plan', s => s.agent('a', 'b'), { retries: 3 })\nawait wf.step('after', s => s.sh('x'))`,
      actions: { agent: async () => { tries++; throw Object.assign(new Error('back to the analysis'), { code: 'revise' }) }, sh: async () => { throw new Error('must not run') } } })
    assert.deepEqual([sentBack.ok, sentBack.revise, sentBack.halted, tries, /back to the analysis/.test(sentBack.error)], [false, true, undefined, 1, true])
    const parInStep = await runFlow({ guest, name: 'parin', journal: memory(), source: `await wf.step('outer', () => wf.parallel([b => b.step('a', () => 1)]))`, actions: {} })
    assert.match(parInStep.error, /one step at a time/)
    const overlap = await runFlow({ guest, name: 'overlap', journal: memory(), source: `await Promise.all([wf.step('a', () => 1), wf.step('b', () => 2)])`, actions: {} })
    assert.match(overlap.error, /one step at a time/)
    const after = await runFlow({ guest, name: 'after', journal: memory(), source: `try { await wf.step('a', () => { throw new Error('x') }) } catch {}\nreturn await wf.step('b', () => 2)`, actions: {} })
    assert.deepEqual([after.ok, after.value], [true, 2], 'a failed step leaves the line free for the next')
  }
  // stopped while a command runs: the command is told (the action's signal), the run waits for it to end and then writes
  // nothing more; what was at work shows stopped
  {
    const journal = memory(), stop = new AbortController()
    let told = false, saves = 0
    const counted = { load: journal.load, save: x => { saves++; journal.save(x) } }
    const r = await runFlow({ guest, name: 'fence', source: `await wf.step('long', s => s.sh('sleep'))`, signal: stop.signal, journal: counted,
      actions: { sh: (_, { signal }) => { setTimeout(() => stop.abort(), 20); return new Promise(res => signal.addEventListener('abort', () => { told = true; setTimeout(() => res('late'), 100) })) } } })
    const after = saves
    await new Promise(res => setTimeout(res, 200))
    assert.deepEqual([r.ok, told, saves === after, journal.get().steps['long#1'].status, stepsOf(journal.get())[0].status], [false, true, true, 'stopped', 'skipped'], label)
  }
  // one branch failing while another waits on a person: the run ends (what waits is told); a person's stop in one branch
  // tells what another is doing; the parent's wf.parallel inside a branch is refused; a journal started over is a new one
  {
    const waits = { ask: (_, { signal }) => new Promise((res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { code: 'aborted' })))) }
    const failed = await runFlow({ guest, name: 'p-fail', journal: memory(), actions: waits,
      source: `await wf.parallel([b => b.step('ask', s => s.ask('go?')), b => b.step('boom', () => { throw new Error('boom') })])` })
    assert.match(failed.error, /boom/, `${label}: ended, not left waiting`)
    let told = false
    const halted = await runFlow({ guest, name: 'p-stop', journal: memory(), actions: {
      ask: async () => { await new Promise(r => setTimeout(r, 50)); throw Object.assign(new Error('stopped by the person'), { code: 'stopped' }) },
      sh: (_, { signal }) => new Promise(res => signal.addEventListener('abort', () => { told = true; res('stopped') })) },
      source: `await wf.parallel([b => b.step('ask', s => s.ask('go?')), b => b.step('long', s => s.sh('long'))])` })
    assert.deepEqual([halted.ok, halted.halted, told], [false, true, true], `${label}: a person's stop tells the other branch`)
    const nested = await runFlow({ guest, name: 'p-nest', journal: memory(), actions: {}, source: `await wf.parallel([async b => wf.parallel([c => c.step('x', () => 1)])])` })
    assert.match(nested.error, /each branch takes its own/)
    const gens = []
    for (let i = 0; i < 2; i++) await runFlow({ guest, name: 'gen', journal: memory(), actions: { evidence: async (_, { gen }) => { gens.push(gen) } }, source: `await wf.step('a', s => s.evidence('x', 1))` })
    assert.ok(gens[0] && gens[1] && gens[0] !== gens[1], 'a journal started over has a generation of its own')
  }
  // a person's stop stands even when the script catches it: no step begins after it, nothing more is done
  {
    const done = []
    const r = await runFlow({ guest, name: 'catch', journal: memory(), source: `try { await wf.step('ask', s => s.ask('go?')) } catch {}\ntry { await wf.step('ship', s => s.sh('ship')) } catch {}\nreturn 'shipped'`,
      actions: { ask: async () => { throw Object.assign(new Error('stopped by the person'), { code: 'stopped' }) }, sh: async ({ command }) => { done.push(command); return 'ok' } } })
    assert.deepEqual([r.ok, r.halted, done], [false, true, []], `${label}: a caught stop still stops`)
  }
  // the time: between steps in the script's order, inside a step its own — both the same when the run comes back
  {
    const journal = memory()
    let clock = 1000, fail = true
    const source = `const a = await wf.step('a', async s => s.now())\nconst t = await wf.now()\nreturn await wf.step('b', async s => { const x = await s.now(); await s.sh('x'); return [a, t, x] })`
    const actions = { sh: async () => { if (fail) throw new Error('interrupted'); return 'ok' } }
    await runFlow({ guest, name: 'clock', journal, source, actions, now: () => clock++ })
    fail = false
    const r = await runFlow({ guest, name: 'clock', journal, source, actions, now: () => clock++ })
    const first = journal.get().steps['b#1'].clock[0]
    assert.deepEqual([r.ok, r.value[1], r.value[2]], [true, journal.get().clock[0], first], `${label}: a resumed run reads the same times`)
    const inStep = await runFlow({ guest, name: 'clock2', journal: memory(), source: `await wf.step('a', async () => wf.now())`, actions: {} })
    assert.match(inStep.error, /use s\.now\(\)/)
  }
  // what the script changes in its realm changes nothing in how it talks to the host; the clock stays out of reach
  {
    const r = await runFlow({ guest, name: 'tamper', journal: memory(), actions: { sh: async () => 'ran' },
      source: `JSON.stringify = () => '{"op":"nope"}'; JSON.parse = () => ({}); String = () => 'x'\nconst v = await wf.step('a', s => s.sh('x'))\nlet d = 'blocked'\ntry { new (Date.prototype.constructor)(); d = 'reached' } catch {}\ntry { new (new Date(0).constructor)(); d = 'reached' } catch {}\nreturn [v, d]` })
    assert.deepEqual([r.ok, r.value], [true, ['ran', 'blocked']], r.error)
  }
  // stopped while a step waits: the run ends at once
  {
    const stop = new AbortController()
    const t0 = Date.now()
    setTimeout(() => stop.abort(), 100)
    const r = await runFlow({ guest, name: 'wait', source: `await wf.step('wait', s => s.sh('sleep'))`, signal: stop.signal, journal: memory(), actions: { sh: (_, { signal }) => new Promise(res => signal.addEventListener('abort', () => res('stopped'))) } })
    assert.equal(r.ok, false)
    assert.ok(Date.now() - t0 < 5000, `${label}: stopped at once`)
  }
}

await suite(guests.worker(), 'worker')
// a script that never yields is stopped with its thread
{
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 200)
  const r = await runFlow({ guest: guests.worker(), name: 'spin', source: `await wf.step('a', () => 1); for (;;) {}`, signal: stop.signal, journal: memory(), actions: {} })
  assert.equal(r.error, 'stopped')
}

// …and one that spins after an await with nobody stopping it: the host ends the thread when it has been silent for the limit (the
// settings' agent timeout), the step fails saying so. The limit here is short.
{
  const t0 = Date.now(), journal = memory()
  const r = await runFlow({ guest: guests.worker(), name: 'spin2', source: `await wf.now(); for (;;) {}`, journal, actions: {}, limitMs: 600 })
  assert.equal(r.ok, false)
  assert.match(r.error, /^the script('s thread did not answer for| asked for nothing for) \d+ seconds? .*\(a loop that never ends\?\)/)
  assert.ok(Date.now() - t0 < 8000, 'stopped within moments of the limit')
  assert.deepEqual([journal.get().status, journal.get().events.at(-1).type], ['failed', 'error'])
  // …while another branch of a wf.parallel waits on the host (a call at work): the thread's silence still shows
  const slow = new AbortController()
  const t1 = Date.now()
  const p = await runFlow({ guest: guests.worker(), name: 'spin3', journal: memory(), limitMs: 600, actions: { sh: (_, { signal }) => new Promise(res => signal.addEventListener('abort', () => res('stopped'), { once: true })) },
    source: `await wf.parallel([b => b.step('wait', s => s.sh('sleep')), b => b.step('spin', async s => { await s.now(); for (;;) {} })])` })
  slow.abort()
  assert.equal(p.ok, false)
  assert.match(p.error, /^the script's thread did not answer for \d+ seconds? \(a loop/, 'the thread\'s silence shows even while another branch waits on the host')
  assert.ok(Date.now() - t1 < 8000)
  // a script that is only waiting (a call at work longer than the limit) is not stopped; nor is one that goes on asking
  const w = await runFlow({ guest: guests.worker(), name: 'patient', journal: memory(), limitMs: 400, actions: { sh: async () => { await new Promise(res => setTimeout(res, 900)); return 'ok' } },
    source: `const a = await wf.step('a', s => s.sh('slow'))\nfor (let i = 0; i < 3; i++) await wf.step('s', s => s.now())\nreturn a` })
  assert.deepEqual([w.ok, w.value], [true, 'ok'], w.error)
  // the PTC guest cannot be pinged: a script that asks for nothing while no call of its is at work is stopped by the host's own watch
  let spins = 0
  const silent = { where: 'ptc', run: async ({ host, signal }) => { await host.call(JSON.stringify({ op: 'now', args: {} })); spins++; return new Promise(res => signal.addEventListener('abort', () => res({ ok: false, error: 'stopped' }), { once: true })) } }
  const keep = setInterval(() => {}, 100) // (the host's watch does not hold a process open by itself)
  const q = await runFlow({ guest: silent, name: 'quiet', journal: memory(), actions: {}, source: '', limitMs: 500 })
  clearInterval(keep)
  assert.deepEqual([spins, q.ok], [1, false])
  assert.match(q.error, /^the script asked for nothing for \d+ seconds? and did not end/)
}

const DSH = [process.env.DSH_ROOT, join(homedir(), '.dsh/profiles/node_modules'), join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai')].find(d => d && existsSync(join(d, 'dsh-ptc-runtime-node/lib/index.js')))
if (DSH) {
  const load = async name => (await import(join(DSH, name, 'lib/index.js'))).default
  const { Context } = await import(join(DSH, 'cordis/lib/index.js'))
  const ctx = new Context(), workspaceRoot = mkdtempSync(join(tmpdir(), 'flow-check-'))
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot }) })
  for (const [name, config] of [['dsh-fs-local', { cwd: workspaceRoot }], ['dsh-subprocess-local', {}], ['dsh-sandbox-local', {}], ['dsh-ptc-runtime-node', {}]]) await ctx.plugin(await load(name), config)
  const runtime = await new Promise(resolve => ctx.inject(['ptcRuntime'], c => resolve(c.ptcRuntime)))
  await suite(guests.ptc(runtime, { mode: 'read-only', workspaceRoot }), 'ptc')
  // a machine where the sandbox cannot be set up: the worker takes it
  const none = { where: 'ptc', run: async () => null }
  const r = await runFlow({ guest: none, fallback: guests.worker(), name: 'fb', source: `return await wf.step('a', () => 2)`, journal: memory(), actions: {} })
  assert.deepEqual([r.ok, r.value, r.where], [true, 2, 'worker'])
  rmSync(workspaceRoot, { recursive: true, force: true })
  console.log('flow (ptc): ok')
} else console.log('flow (ptc): skipped — this dsh has no PTC runtime')

// the static check: what an author (or the assistant) hears before saving
{
  const ok = checkFlow(`const r = await wf.step('build', s => s.agent('coder', 'build it'))\nawait wf.step('lint', s => s.script('lint@1.0.0', ['src']))`)
  assert.deepEqual([ok.errors, ok.steps, ok.roles, ok.scripts], [[], ['build', 'lint'], ['coder'], ['lint@1.0.0']])
  const bad = checkFlow(`const t = Date.now(); require('fs'); await wf.step('a', s => s.agent(role, 'x')); process.exit(1)`)
  assert.equal(bad.errors.length, 4, bad.errors.join(' | '))
  // what is text is not code: a command or a comment that mentions what a script may not call, a step named in a prompt
  const text = checkFlow(`// Date.now() is refused\nawait wf.step('a', s => s.sh("node -e 'process.exit(0)'"))\nawait wf.parallel([b => b.step('b', s => s.agent('coder', "then wf.step('fake', ...)"))])`)
  assert.deepEqual([text.errors, text.steps, text.roles], [[], ['a', 'b'], ['coder']])
  assert.deepEqual(checkFlow('await wf.step("a", async s => `out: ${(await s.script("lint@1.0.0", [])).stdout}`)').scripts, ['lint@1.0.0'], 'what a template\'s ${…} runs is code')
  assert.deepEqual(checkFlow('const x = `${"a}b".replace(/}/g, "")}`\nawait wf.step("a", s => s.script("lint@1.0.0"))').scripts, ['lint@1.0.0'], 'a regular expression\'s } is not the end of a ${…}')
  assert.deepEqual(checkFlow('const x = `${(() => { if (y) /}/.test(z); return 1 })()}`\nawait wf.step("a", s => s.script("lint@1.0.0"))').scripts, ['lint@1.0.0'], 'a regular expression after if (…)')
  assert.deepEqual(checkFlow('let n = 1\nconst h = n++ / 2 + (4) / 2\nawait wf.step("b", s => s.script("fmt@2.0.0"))').scripts, ['fmt@2.0.0'], 'a division after n++ or (…)')
  assert.match(checkFlow('wf.step(').errors[0], /does not parse/)
  assert.match(checkFlow('return 1').errors[0], /names no step/)
}
// what the editor starts from and the skill's example check out and run through (every agent, command and person a stand-in)
{
  const stub = { agent: async () => ({ ok: true, summary: 'done', findings: [] }), sh: async () => ({ code: 0, stdout: 'ok', stderr: '' }), evidence: async () => null, ask: async () => ({ answer: 'continue', input: '', choice: 'Go on', by: null }) }
  const skill = readFileSync(new URL('./skills/workflow-create/SKILL.md', import.meta.url), 'utf8')
  const example = JSON.parse(skill.match(/```json\n(\{ "id": "fix-until-green"[\s\S]*?)\n```/)[1])
  for (const [label, source, params] of [['template', FLOW_TEMPLATE, {}], ['skill example', example.source, { tries: 2 }]]) {
    assert.deepEqual(checkFlow(source).errors, [], label)
    const r = await runFlow({ guest: guests.worker(), name: label, source, params, journal: memory(), actions: stub })
    assert.equal(r.ok, true, `${label}: ${r.error}`)
  }
  assert.deepEqual(Object.keys(example.agents), checkFlow(example.source).roles, 'the example names the roles it asks')
}
console.log('flow check: ok')
process.exit(0)
