// A script step's guest: runs in a VM realm of its own — inside dsh's confined PTC process (no home, no writes, no env),
// or a worker thread of the workbench where there is none — where the script sees only `wf`: no process, require,
// import, fetch, timers, eval or new Function. Every crossing is a JSON string: nothing of this realm or the host's
// reaches the script (an object of another realm would lead back to its Function, and through it out of the VM). The
// host owns what a step does and keeps its record (lib/flow/runtime.js); the guest only asks.
import * as vm from 'node:vm'

// Built inside the script's realm, so every function and object the script can reach is the realm's own. `bridge`
// (closed over, never handed out) takes and gives JSON strings and never rejects.
const REALM_SDK = String.raw`(bridge, initJson) => {
  'use strict'
  // what the SDK uses, taken before the script runs (a script that changes JSON or String changes nothing here)
  const { parse, stringify } = JSON, S = String, freeze = Object.freeze, create = Object.create, Err = Error, isList = Array.isArray, all = Promise.all.bind(Promise)
  const init = parse(initJson)
  const call = async (op, args) => {
    const out = parse(S(await bridge(stringify({ op, args: args === undefined ? null : args }))))
    if (out.error) { const e = new Err(out.error); e.code = out.code || 'FLOW'; throw e }
    return out.value === undefined ? null : out.value
  }
  // a run goes on after a restart by running the script again: what it decides must come out the same — the time and
  // chance come from wf (kept in the run's record), never from the clock or Math.random
  const no = what => () => { throw new Error(what + ' is not allowed in a workflow script: use wf.now() (kept, so a resumed run sees the same time)') }
  Math.random = no('Math.random()')
  Date.now = no('Date.now()')
  const D = new Proxy(Date, { construct: (T, args, nt) => { if (!args.length) no('new Date()')(); return Reflect.construct(T, args, nt === D ? T : nt) }, apply: no('Date()') })
  Object.defineProperty(Date.prototype, 'constructor', { value: D, writable: false, configurable: false })
  globalThis.Date = D
  const plain = (v, what) => { try { return parse(stringify(v === undefined ? null : v)) } catch { throw new Err(what + ' must be JSON data') } }
  const handle = key => freeze({
    /** An agent of the pool does a task: role is one of the step's agents. → { ok, summary, findings, confidence } */
    agent: (role, prompt, opts) => call('agent', { key, role: S(role), prompt: S(prompt), opts: plain(opts || {}, 'agent options') }),
    /** A command in the run's folder (bash). → { code, stdout, stderr }; a non-zero exit throws unless opts.allowFail. */
    sh: (command, opts) => call('sh', { key, command: S(command), opts: plain(opts || {}, 'sh options') }),
    /** An installed script (name@version) with its arguments. → { code, stdout, stderr }, as sh. */
    script: (ref, args, opts) => call('script', { key, ref: S(ref), args: plain(args || [], 'script arguments'), opts: plain(opts || {}, 'script options') }),
    /** Something the run's record keeps (what a reviewer reads): a title and its data. */
    evidence: (title, data) => call('evidence', { key, title: S(title), data: plain(data, 'evidence') }),
    /** A person answers (input) or chooses (options): the run waits. → { answer, input, choice, by } */
    ask: (question, opts) => call('ask', { key, question: S(question), opts: plain(opts || {}, 'ask options') }),
    /** The time (ms) in this step, kept: the same when the step runs again. */
    now: () => call('now', { key }),
  })
  // a line of steps: the script's own, or one branch of a wf.parallel — each counts its steps by name (a loop's turns:
  // fix#1, fix#2), so the same step gets the same key however the branches beside it are timed
  const line = prefix => {
    const seen = create(null)
    let pars = 0, inner = 0, busy = 0 // busy: a step of this line under way (steps do not nest: a replay would shift the keys)
    /** One step: what it does goes through its handle; its result is kept (replayed after a restart). */
    const step = async (name, fn, opts) => {
      if (inner) throw new Err('inside wf.parallel each branch takes its own steps: wf.parallel([b => b.step(...), ...])')
      if (busy) throw new Err('one step at a time: steps do not nest, and each is awaited before the next (wf.parallel for several at once)')
      if (typeof name !== 'string' || !/^[a-z][\w-]{0,59}$/i.test(name)) throw new Err('a step is named with letters, digits, _ or -')
      if (typeof fn !== 'function') throw new Err('a step does its work in a function: wf.step(name, s => ...)')
      const key = prefix + name + '#' + (seen[name] = (seen[name] || 0) + 1)
      const o = plain(opts || {}, 'step options')
      busy++
      try {
        const begun = await call('stepBegin', { key, name, retries: o.retries || 0, title: o.title || null })
        if (begun.done) return begun.value
        for (let attempt = begun.attempt; ; attempt++) {
          try {
            const value = plain(await fn(handle(key)), 'a step\'s result')
            await call('stepEnd', { key, value })
            return value
          } catch (e) {
            const next = await call('stepFail', { key, attempt, error: S(e && e.message || e) })
            if (!next.retry) throw new Err('step ' + key + ' failed: ' + S(e && e.message || e))
          }
        }
      } finally { busy-- }
    }
    /** Branches at the same time, each a line of its own: wf.parallel([b => b.step('a', …), b => b.step('b', …)]). */
    const parallel = async branches => {
      if (inner) throw new Err('inside wf.parallel each branch takes its own: b.parallel([...]), b.step(...)')
      // (not inside a step either: a replay of that step would skip its numbering, and a later block take this one's keys)
      if (busy) throw new Err('one step at a time: steps do not nest, and each is awaited before the next (wf.parallel for several at once)')
      if (!isList(branches) || branches.some(b => typeof b !== 'function')) throw new Err('wf.parallel takes a list of branches: b => b.step(...)')
      const p = prefix + 'p' + (++pars) + '.'
      inner++
      try { return await all(branches.map((b, i) => { const own = line(p + i + '/'); return b(freeze({ step: own.step, parallel: own.parallel })) })) } finally { inner-- }
    }
    return { step, parallel }
  }
  const main = line('')
  const wf = freeze({
    input: freeze(init.input),
    params: freeze(init.params),
    step: main.step,
    parallel: main.parallel,
    /** The time (ms) between steps, kept: the same when a resumed run gets here again (inside a step: s.now()). */
    now: () => call('now', {}),
    phase: title => call('phase', { title: S(title) }),
    log: message => call('log', { message: S(message) }),
  })
  return wf
}`

export async function runFlowGuest(host) {
  const initJson = String(await host.begin('{}'))
  const { source, name } = JSON.parse(initJson)
  // bindings answer JSON strings; a binding that throws becomes an error answer (never a rejection into the realm)
  const bridge = async req => { try { return String(await host.call(req)) } catch (e) { return JSON.stringify({ error: String(e?.message || e) }) } }
  const context = vm.createContext(Object.create(null), { name: `flow:${name}`, codeGeneration: { strings: false, wasm: false } })
  const wf = new vm.Script(`(${REALM_SDK})`, { filename: 'flow-sdk.js' }).runInContext(context)(bridge, initJson)
  context.wf = wf
  // the result's encoder, taken before the script runs (it may change JSON in its realm)
  const toJson = new vm.Script('(s => v => s(v === undefined ? null : v))(JSON.stringify)').runInContext(context)
  let script
  try { script = new vm.Script(`(async () => {\n${source}\n})()`, { filename: `flow:${name}`, lineOffset: -1 }) } catch (e) { return { ok: false, error: `the script does not parse: ${e.message}` } }
  try {
    // the result crosses as a JSON string made inside the realm
    const done = await script.runInContext(context, { timeout: 5000 })
    return { ok: true, value: JSON.parse(String(toJson(done))) }
  } catch (e) {
    // a realm error read as text only (its stack is a string)
    let error
    try { error = String(e?.message ?? e) } catch { error = 'the script failed' }
    return { ok: false, error }
  }
}
