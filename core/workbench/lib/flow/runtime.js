// Script steps, run durably: the script (an async body over `wf`) runs in a VM realm of its own (lib/flow/guest.mjs) —
// in dsh's confined PTC process, else a worker thread. Each wf.step is kept in a journal as it begins, ends or fails:
// run again — after a restart, a crash, on another machine — the script starts from the top and every step already done
// answers with its kept result at once (nothing done twice), so the run goes on from the first step not done. A step
// that fails is tried again up to its retries. What a step does (an agent, a command, evidence, a person's answer) is
// the host's: asked only from inside a step that is running, carried out by the engine under this machine's rules.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'

const GUEST = readFileSync(new URL('./guest.mjs', import.meta.url), 'utf8')
const PROGRAM = `const { runFlowGuest } = await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(GUEST)}`)}); return await runFlowGuest(flowHost)`
const fail = (code, message) => Object.assign(new Error(message), { code })
const STEP_VALUE_MAX = 64 << 10 // a step's kept result (the journal is part of the run's record)
/** A span in words for the step's note: "90 seconds", "2 minutes". */
const spanOf = ms => { const n = ms < 120000 ? Math.max(1, Math.round(ms / 1000)) : Math.round(ms / 60000); return `${n} ${ms < 120000 ? 'second' : 'minute'}${n === 1 ? '' : 's'}` }

/**
 * Where a guest runs. ptc(runtime, policy): dsh's PTC process — a read-only sandbox without the home or the environment
 * (a machine that cannot set one up: null, so the worker takes it); worker(): a thread of this process, stopped by
 * terminating it. Each: run({ host, signal, limitMs }) → { ok, value?, error? } | null. limitMs: how long the thread may leave the
 * host's ping unanswered (a script that spins for ever after an await — the VM's own timeout bounds only the code before its first
 * await) before it is terminated.
 */
export const guests = {
  ptc: (runtime, policy) => ({
    where: 'ptc',
    async run({ host, signal }) {
      const out = await runtime.run(runtime.resolve({ program: PROGRAM, bindings: [{ global: 'flowHost', functions: host }], cwd: policy.workspaceRoot, sandboxPolicy: policy, timeoutMs: null, signal }))
      if (out.error?.kind === 'sandbox-unavailable') return null
      return out.error ? { ok: false, error: out.error.kind === 'abort' ? 'stopped' : `${out.error.kind}: ${out.error.message}` } : out.value
    },
  }),
  worker: ({ memoryMb = 128 } = {}) => ({
    where: 'worker',
    run: ({ host, signal, limitMs }) => new Promise(resolve => {
      if (signal?.aborted) return resolve({ ok: false, error: 'stopped' })
      const w = new Worker(new URL('./worker.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: memoryMb }, env: {} })
      let over = false, heard = Date.now(), beat = null
      const end = r => { if (over) return; over = true; clearInterval(beat); signal?.removeEventListener('abort', stop); w.terminate().catch(() => {}); resolve(r) }
      if (limitMs > 0) {
        beat = setInterval(() => {
          if (Date.now() - heard > limitMs) end({ ok: false, error: `the script's thread did not answer for ${spanOf(limitMs)} (a loop that never ends?): it was stopped` })
          else w.postMessage({ ping: true })
        }, Math.max(10, Math.min(1000, limitMs / 4)))
        beat.unref?.()
      }
      const stop = () => end({ ok: false, error: 'stopped' })
      signal?.addEventListener('abort', stop, { once: true })
      w.on('message', async m => {
        heard = Date.now()
        if (m.pong) return
        if (m.done) return end(m.done)
        const value = await (m.kind === 'begin' ? host.begin() : host.call(m.payload)).catch(e => JSON.stringify({ error: String(e?.message || e) }))
        if (!over) w.postMessage({ id: m.id, value })
      })
      w.on('error', e => end({ ok: false, error: `the script's thread failed: ${e?.message || e}` }))
      w.on('exit', code => end({ ok: false, error: `the script's thread ended (${code})` }))
    }),
  }),
}

/**
 * One run of a script step. guest: where it runs (guests.ptc, falling back to guests.worker); journal: { load() →
 * journal | null, save(journal) } (written at every change: what a crash keeps); actions: { [op]: async (args,
 * { key, attempt }) → JSON } — what its steps may do. limitMs: the longest the script may go without asking the host for
 * anything while no call of its is at work (a script that spins after an await), and the longest its thread may leave a ping
 * unanswered: past it the guest is stopped and the run fails saying so. → { ok, value?, error?, journal, where }
 */
export async function runFlow({ guest, fallback, name, source, input = {}, params = {}, signal, journal: store, actions, now = Date.now, limitMs = 0 }) {
  // (gen: this journal's own — what a step asked of a person belongs to it; one started over asks again)
  const journal = store.load() || { name, gen: randomUUID().slice(0, 8), steps: {}, order: [], events: [], clock: [], runs: 0 }
  journal.gen ||= randomUUID().slice(0, 8)
  // what its actions are told: the run stopped, a person stopped it, or the script ended (nothing it left at work goes on)
  const ctl = new AbortController(), inner = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal
  journal.runs = (journal.runs || 0) + 1
  journal.clock ||= []
  // halted: a person stopped it — no step is tried again, none begins, nothing more is done
  // revised: a person sent the run back to a step (an agent's decision): the script ends there, no step tried again
  let tick = 0, halted = false, revised = null
  const active = new Set(), ticks = new Map() // this run's steps at work; each one's own clock reads
  const pending = new Set() // actions at work: waited for before the run ends (a command stopped goes no further)
  const save = () => store.save(journal)
  const event = e => { journal.events = [...journal.events, { at: now(), ...e }].slice(-200); save() }
  event({ type: journal.runs > 1 ? 'resume' : 'start' })
  const ops = {
    stepBegin({ key, name: step, retries, title }) {
      if (halted || revised) throw fail('aborted', halted ? 'a person stopped the run' : 'a person sent the run back')
      const e = journal.steps[key]
      if (e?.status === 'done') { e.replays = (e.replays || 0) + 1; save(); return { done: true, value: e.value } }
      journal.steps[key] = { key, name: step, title: title ? String(title).slice(0, 120) : null, retries: Math.max(0, Math.min(10, Number(retries) || 0)), attempts: e?.attempts || 0, errors: e?.errors || [], calls: e?.calls || [], ...e, status: 'running', startedAt: now() }
      if (!journal.order.includes(key)) journal.order.push(key)
      active.add(key)
      ticks.set(key, 0)
      save()
      return { done: false, attempt: journal.steps[key].attempts + 1 }
    },
    stepEnd({ key, value }) {
      const e = journal.steps[key]
      if (e?.status !== 'running') throw fail('notRunning', `step ${key} is not running`)
      if (JSON.stringify(value ?? null).length > STEP_VALUE_MAX) throw fail('tooLarge', `step ${key} handed back more than ${STEP_VALUE_MAX >> 10} KB: keep a summary, put the rest in evidence`)
      Object.assign(e, { status: 'done', value, attempts: e.attempts + 1, endedAt: now() })
      active.delete(key)
      save()
      return null
    },
    stepFail({ key, attempt, error }) {
      const e = journal.steps[key]
      if (e?.status !== 'running') throw fail('notRunning', `step ${key} is not running`)
      e.attempts = Number(attempt) || e.attempts + 1
      e.errors = [...e.errors, { attempt: e.attempts, error: String(error).slice(0, 2000), at: now() }].slice(-10)
      // (a run stopped meanwhile: no next try)
      const retry = !halted && !revised && !signal?.aborted && e.attempts <= e.retries
      Object.assign(e, { status: retry ? 'running' : 'failed', ...(!retry && { endedAt: now() }) })
      if (retry) ticks.set(key, 0)
      else active.delete(key)
      save()
      return { retry }
    },
    // the time, kept: between steps in the order the script reads it; inside a step, that step's own (a step that runs
    // again reads the same) — between steps while one is at work (wf.parallel) the order is not the script's: refused
    now({ key }) {
      if (key) {
        const e = journal.steps[key]
        if (!active.has(key) || e?.status !== 'running') throw fail('outsideStep', 's.now() is read inside its own step')
        const i = ticks.get(key) || 0
        ticks.set(key, i + 1)
        e.clock ||= []
        if (e.clock[i] === undefined) { e.clock[i] = now(); save() }
        return e.clock[i]
      }
      if (active.size) throw fail('inStep', 'wf.now() is read between steps: inside a step (or beside one at work) use s.now()')
      const i = tick++
      if (journal.clock[i] === undefined) { journal.clock[i] = now(); save() }
      return journal.clock[i]
    },
    phase({ title }) { event({ type: 'phase', title: String(title).slice(0, 200) }); return null },
    log({ message }) { event({ type: 'log', message: String(message).slice(0, 2000) }); return null },
  }
  // the guest asking nothing while none of its calls is at work for limitMs: it is spinning, or hung (a call at work is the
  // host's time, not the script's)
  const dog = new AbortController()
  let atWork = 0, quiet = Date.now(), watch = null, stuck = false
  const touch = () => { quiet = Date.now() }
  if (limitMs > 0) {
    watch = setInterval(() => { if (!atWork && Date.now() - quiet > limitMs) { stuck = true; dog.abort() } }, Math.max(10, Math.min(1000, limitMs / 4)))
    watch.unref?.()
  }
  const asked = async raw => {
    try {
      const { op, args } = JSON.parse(String(raw))
      if (Object.hasOwn(ops, op)) return JSON.stringify({ value: ops[op](args || {}) })
      if (!Object.hasOwn(actions, op)) throw fail('noOp', `no such workflow call: ${op}`)
      if (halted || revised) throw fail('aborted', halted ? 'a person stopped the run' : 'a person sent the run back')
      // a side effect only from a step that is running now: what a replay skips is never done again
      const e = journal.steps[args?.key]
      if (e?.status !== 'running') throw fail('outsideStep', `${op} is done inside a step: wf.step(name, s => s.${op}(…))`)
      if (inner.aborted) throw fail('aborted', 'the run was stopped')
      const started = now()
      const work = Promise.resolve().then(() => actions[op](args, { key: e.key, attempt: e.attempts + 1, signal: inner, gen: journal.gen }))
      pending.add(work)
      let value
      try { value = await work } finally { pending.delete(work) }
      e.calls = [...e.calls, { op, at: started, ms: now() - started, attempt: e.attempts + 1 }].slice(-50)
      save()
      return JSON.stringify({ value: value === undefined ? null : value })
    } catch (err) {
      // a person's stop (not the run's): nothing else of it goes on — what waits is told, the script ends with it
      if (err?.code === 'stopped' && !inner.aborted) { halted = true; ctl.abort() }
      else if (err?.code === 'revise' && !inner.aborted && !halted) { revised = String(err.message || 'sent back'); ctl.abort() }
      return JSON.stringify({ error: String(err?.message || err), code: err?.code || null })
    }
  }
  const host = {
    begin: async () => JSON.stringify({ name, source, input, params }),
    call: async raw => {
      atWork++
      try { return await asked(raw) } finally { atWork--; touch() }
    },
  }
  let where = guest.where
  const stopGuest = AbortSignal.any([inner, dog.signal])
  let r = await guest.run({ host, signal: stopGuest, limitMs })
  if (!r && fallback) { where = fallback.where; r = await fallback.run({ host, signal: stopGuest, limitMs }) }
  clearInterval(watch)
  // what its steps were doing ends before the run does — told to stop (a branch left waiting when another failed) and
  // waited for: nothing of this run acts or writes the journal after it
  ctl.abort()
  if (pending.size) await Promise.allSettled([...pending])
  for (const key of active) if (journal.steps[key]?.status === 'running') Object.assign(journal.steps[key], { status: 'stopped', endedAt: now() })
  r ||= { ok: false, error: 'the script could not be run here' }
  // the script went quiet for the whole limit (the worker's own ping says so in its error: kept)
  if (stuck && !r.ok && r.error === 'stopped' && !halted && !revised && !signal?.aborted) r = { ok: false, error: `the script asked for nothing for ${spanOf(limitMs)} and did not end (a loop that never ends?): it was stopped` }
  // a person's stop stands, whatever the script did with it
  if (halted) r = { ok: false, error: 'a person stopped the run' }
  else if (revised) r = { ok: false, error: revised }
  journal.where = where
  event({ type: r.ok ? 'end' : 'error', where, ...(r.ok ? {} : { error: String(r.error).slice(0, 2000) }) })
  journal.status = r.ok ? 'done' : signal?.aborted ? 'stopped' : 'failed'
  journal.value = r.ok ? r.value : undefined
  save()
  return { ...r, journal, where, ...(halted && { halted: true }), ...(revised && !halted && { revise: true }) }
}

/** A journal as the step's own steps (what the run page draws under it): a loop's turns each one, titled with its turn. */
const STATUS = { done: 'passed', failed: 'failed', running: 'running', stopped: 'skipped' }
export const stepsOf = journal => (journal?.order || []).map(key => {
  const e = journal.steps[key], turn = Number(key.split('#')[1]), branch = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
  const many = journal.order.some(k => k !== key && k.startsWith(`${branch ? `${branch}/` : ''}${e.name}#`))
  return { key, name: e.name, title: `${e.title || e.name}${many ? ` · ${turn}` : ''}`, ...(branch && { branch }), status: STATUS[e.status] || 'pending', attempts: e.attempts, retries: e.retries, replays: e.replays || 0,
    startedAt: e.startedAt, endedAt: e.endedAt || null, calls: e.calls.map(c => c.op), ...(e.errors.length && { error: e.errors.at(-1).error, errors: e.errors.length }) }
})
