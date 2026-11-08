// A script step as the engine runs it: its script (lib/flow/runtime.js) does its work through the engine's own parts —
// an agent of the pool (askAgent, with its stage_result), a command in the run's folder, an installed script, the run's
// evidence, a person's card — each from inside one of its steps. Its journal is kept on the run (run.flows), so a run
// that stops (a restart, a crash) goes on from its first step not done; its steps show under it on the run page
// (stage.flow).
import { header } from '../../workflows/common.js'
import { dirOf } from '../subject.js'
import { both, tail } from '../tools.js'
import { guests, runFlow, stepsOf } from './runtime.js'

const minutes = (v, d, max) => Math.min(Math.max(Number(v) || d, 1), max)
const textOf = data => (typeof data === 'string' ? data : JSON.stringify(data, null, 2)).slice(0, 20000)
// a person's stop (the run ends there: no step is tried again) — and the run's own stop, or the script's end (aborted)
const stopped = message => Object.assign(new Error(message), { code: 'stopped' })
const aborted = message => Object.assign(new Error(message), { code: 'aborted' })
// a person sent the run back to a step (a decision's choice): the script ends here; the engine's after-step pass goes there
const revise = message => Object.assign(new Error(message), { code: 'revise' })
const pause = (ms, signal) => new Promise(resolve => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true }) })

/**
 * h: the workflow module's own parts — failed (the step's "on failure"), settle and deadline (a person's card), quote and
 * runner (an installed script's command), bash (the shell commands run in: null where there is none), win, always (the
 * tools every agent has).
 */
export function flowStage(s, base, h) {
  return {
    ...base,
    owner: 'system',
    // the roles its script asks (an agent of the pool each: roles["<step>.<role>"] of the workflow)
    flowRoles: Object.keys(s.agents || {}),
    async run(w) {
      const round = w.run.round || 0, kept = w.run.flows?.[s.id]
      // (its journal is what goes on after a stop: an agent call starts fresh, never resuming another one's session)
      if (w.run.stages.find(x => x.key === s.id)?.resume) w.update(r => ({ ...r, stages: r.stages.map(x => (x.key === s.id ? { ...x, resume: null } : x)) }))
      // where it runs: dsh's confined process when the workbench has one, else a worker thread of its own
      const g = w.services?.flowGuest?.() || { guest: guests.worker() }
      let where = g.guest.where
      const journal = {
        load: () => (kept?.round === round ? kept : null),
        save: j => {
          const kept = { ...j, round }
          w.update(r => ({ ...r, flows: { ...(r.flows || {}), [s.id]: kept }, stages: r.stages.map(x => (x.key === s.id ? { ...x, flow: { steps: stepsOf(kept), events: kept.events.slice(-30), where: kept.where || where } } : x)) }))
        },
      }
      // one agent at a time (an agent's stage_result lands on this step), one person's card at a time (the run waits on one);
      // one waiting its turn when the run stops does not start
      const queue = () => {
        let last = Promise.resolve()
        return (signal, fn) => { const go = () => (signal.aborted ? Promise.reject(aborted('the run was stopped')) : fn()); const p = last.then(go, go); last = p.catch(() => {}); return p }
      }
      const one = queue(), oneAsk = queue()
      const cwdOf = o => (o?.cwd === 'workspace' ? w.workspace : dirOf(w.run))
      const shell = async (title, cmd, o, extra = {}, vars = {}, signal = w.signal) => {
        const bash = h.bash()
        if (!bash) throw new Error('a script step runs commands in bash, and this Windows machine has none: install Git for Windows (git-scm.com), or set RUYIX_BASH to a bash.exe')
        const cwd = cwdOf(o)
        // (Git Bash's login profile goes to $HOME unless told to stay where it was started)
        const r = await w.exec(bash, ['-lc', `${w.tools?.shell?.() || ''}${cmd}`], { cwd, env: { ...vars, ...(h.win && { CHERE_INVOKING: '1' }) }, timeout: minutes(o?.timeoutMinutes, 10, 120) * 60000, signal })
        if (signal.aborted) throw aborted('the run was stopped')
        w.command(title, r, { cwd, ...extra })
        const out = { code: r.code, stdout: tail(String(r.stdout || ''), 8000), stderr: tail(String(r.stderr || ''), 4000) }
        if (r.code !== 0 && !o?.allowFail) throw new Error(`exit ${r.code}: ${tail(both(r), 300).replace(/\s+/g, ' ')}`)
        return out
      }
      const actions = {
        agent: ({ role, prompt, opts = {} }, { key, signal }) => {
          const a = s.agents?.[role]
          if (!a) throw new Error(`no agent "${role}" in ${s.title}: add it to the step's agents`)
          const brief = [
            header(w, s.id),
            `## Your task${opts.title ? `: ${opts.title}` : ''}\n${a.instructions ? `${a.instructions}\n\n` : ''}${prompt}`,
            `Tools for this step: ${h.always.join(', ')}. A command-line tool you need that is not here: tools_ensure if this step may change files (never sudo or an installer of your own).`,
            'Then call stage_result with {"ok": true | false (false: the task could not be done or found a problem), "summary": "the outcome in Markdown, citing evidence (#n)", "findings": ["…"], "confidence": 0–100 (how sure you are — honest: a low one asks a person to look)}.',
          ].join('\n\n')
          return one(signal, async () => {
            const { result, report } = await w.agent(`${s.id}.${role}`, brief, { title: `${opts.title || s.title} (${key})`.slice(0, 120), access: a.access, step: s.id, signal })
            // a blocking decision its agent asked: the script waits for the person before its next step; a choice other
            // than going on ends the step here — the engine's after-step pass takes it (back to a step, or the run stops)
            const asked = () => w.store.list('approval').filter(x => x.runId === w.run.id && x.action === 'decision' && x.payload?.blocking && x.payload?.stage === s.id && !x.payload?.flowKey)
            const waiting = () => asked().filter(x => ['pending', 'failed', 'running'].includes(x.status))
            if (waiting().length) {
              w.update({ status: 'waiting', waiting: 'decision', waitingFor: waiting()[0].id })
              while (waiting().length && !signal.aborted) await pause(3000, signal)
              if (!signal.aborted) w.update({ status: 'running', waiting: null, waitingFor: null })
            }
            if (signal.aborted) throw aborted('the run was stopped')
            const other = asked().find(x => !x.applied && !x.result?.applied && (x.status === 'rejected' || (x.status === 'done' && x.result?.option && x.result.option.action !== 'accept')))
            if (other?.status === 'rejected' || other?.result?.option?.action === 'stop') throw stopped(`${s.title}: "${String(other.title).slice(0, 200)}" — the person chose to stop`)
            if (other) throw revise(`${s.title}: "${String(other.title).slice(0, 200)}" — the person chose "${other.result.option.label}"`)
            return { ok: result?.ok === true, summary: String(result?.summary || report || '').slice(0, 20000), findings: Array.isArray(result?.findings) ? result.findings.slice(0, 30).map(String) : [],
              ...(typeof result?.confidence === 'number' && { confidence: Math.max(0, Math.min(100, Math.round(result.confidence))) }) }
          })
        },
        sh: ({ command, opts }, { key, signal }) => shell(`${s.title} · ${key}: ${String(command).split('\n')[0].slice(0, 120)}`, String(command), opts, { flow: key }, {}, signal),
        script: async ({ ref, args = [], opts }, { key, signal }) => {
          const installed = w.script(ref)
          if (!installed) throw new Error(`the script ${ref} is not installed here`)
          const cmd = [h.runner(installed.entry), h.quote(installed.entry), ...args.slice(0, 20).map(a => h.quote(String(a).slice(0, 500)))].filter(Boolean).join(' ')
          return shell(`${s.title} · ${key}: ${ref}`, cmd, opts, { flow: key, script: ref, args }, { SCRIPT_DIR: installed.dir }, signal)
        },
        evidence: ({ title, data }, { key }) => { w.evidence({ actor: 'workflow', kind: 'note', title: String(title).slice(0, 200), input: { flow: key }, output: textOf(data), ok: true }); return null },
        // a person's card: each ask of a step its own (the step's nth, this round's); the step run again after a restart
        // finds it — still open, it waits on it; answered, its answer stands; put away when the run ended, it asks again
        ask: ({ question, opts = {} }, { key, attempt, signal, gen }) => oneAsk(signal, async () => {
          const n = (asked.get(`${key}:${attempt}`) || 0) + 1
          asked.set(`${key}:${attempt}`, n)
          const id = `${gen}:${key}~${n}`
          const options = Array.isArray(opts.options) ? opts.options.slice(0, 6).map(o => String(o?.label ?? o).slice(0, 60)).filter(Boolean) : []
          const decide = options.length >= 2
          const mine = w.store.list('approval').filter(a => a.runId === w.run.id && a.payload?.stage === s.id && a.payload?.flowKey === id && (a.payload?.round ?? 0) === round)
            .filter(a => !(a.status === 'rejected' && /^the run ended/.test(String(a.reason || ''))))
          const open = mine.at(-1)
          const wait = minutes(opts.waitHours, decide ? 0 : 24, 720)
          const card = open || (decide
            ? w.approval({ action: 'decision', title: String(question).slice(0, 300), payload: { why: String(question).slice(0, 2000), options: [...options.map(label => ({ label, action: 'accept' })), { label: 'Stop the run', action: 'stop' }], recommended: null, blocking: true, stage: s.id, flowKey: id, round, by: 'workflow', person: 'decide', deadline: opts.waitHours ? h.deadline(wait) : null } })
            : w.approval({ action: 'help', title: String(question).slice(0, 300), payload: { kind: 'input', why: String(question).slice(0, 2000), stage: s.id, flowKey: id, round, blocking: true, by: 'workflow', wait, deadline: h.deadline(wait) } }))
          // (waiting is told of a stop too: the run's, a person's elsewhere, the script having ended)
          const a = ['done', 'rejected'].includes(card.status) ? card : await h.settle(Object.create(w, { signal: { value: signal } }), card.id, decide ? 'decision' : 'person')
          if (!a) {
            // left unanswered: put away (nothing waits on it — the run's after-step pass would), asked again if the run goes on
            const left = w.store.get('approval', card.id)
            if (left && ['pending', 'failed'].includes(left.status)) w.store.put('approval', { ...left, status: 'rejected', reason: 'the run ended (the script step stopped)', decidedAt: Date.now(), applied: true })
            throw aborted('the run was stopped')
          }
          if (decide) w.store.put('approval', { ...a, applied: true, ...(a.result && { result: { ...a.result, applied: true } }) })
          const ans = a.result || {}, choice = ans.option?.label || null
          if (a.status === 'rejected' || ans.answer === 'stop' || ans.option?.action === 'stop') throw stopped(`${s.title}: stopped by the person`)
          // (once per card: one found again after a restart and answered since still brings its words)
          if (ans.input && !(w.run.guidance || []).some(g => g.card === a.id)) w.update(r => ({ ...r, guidance: [...(r.guidance || []), { card: a.id, from: s.id, text: `${s.title}: ${String(ans.input).slice(0, 4000)}`, at: Date.now() }] }))
          return { answer: ans.answer || (choice ? 'choice' : 'continue'), input: ans.input || '', choice, by: null }
        }),
      }
      const asked = new Map() // step:attempt → how many asks it made so far
      // what it starts from: the request, the run as far as it got, what the steps before it handed back (never its own: a
      // resumed run starts from the same), its parameters (the run's over the defaults)
      const r0 = w.run, req = r0.subject || {}, before = new Set(r0.stages.slice(0, Math.max(0, r0.stages.findIndex(x => x.key === s.id))).map(x => x.key))
      const input = {
        run: { id: r0.id, title: req.title || null, template: r0.template },
        request: { title: req.title || '', text: String(req.text || '').slice(0, 20000), fields: req.fields || {} },
        outputs: Object.fromEntries(Object.entries(r0.outputs || {}).filter(([k]) => before.has(k)).map(([k, v]) => [k, { ok: v?.ok !== false, summary: String(v?.summary ?? v?.output ?? '').slice(0, 4000) }])),
      }
      const given = r0.params?.[s.id] || {}
      const params = Object.fromEntries(Object.entries(s.params || {}).map(([k, p]) => [k, given[k] !== undefined ? given[k] : p.default ?? null]))
      const out = await runFlow({ guest: g.guest, fallback: g.fallback, name: s.id, source: s.source, input, params, signal: w.signal, journal, actions, limitMs: w.agentTimeoutMs })
      where = out.where
      if (w.signal.aborted) return { ok: false, note: 'stopped' }
      const steps = stepsOf(out.journal)
      if (out.ok) {
        const v = out.value, summary = typeof v === 'string' ? v : v?.summary ? String(v.summary) : `${steps.length} steps done`
        w.update(r => ({ ...r, outputs: { ...(r.outputs || {}), [s.id]: { summary: summary.slice(0, 20000), ok: true, result: v ?? null } } }))
        return { ok: true, note: summary.replace(/\s+/g, ' ').slice(0, 300) }
      }
      w.update(r => ({ ...r, outputs: { ...(r.outputs || {}), [s.id]: { summary: String(out.error).slice(0, 4000), ok: false } } }))
      if (out.halted) return { ok: false, stop: true, verdict: 'failed', note: String(out.error).slice(0, 600) }
      // (sent back by the person's choice: the engine's after-step pass takes the run to that step — not the step's failure)
      if (out.revise) return { ok: false, note: String(out.error).slice(0, 600) }
      return h.failed(w, s, String(out.error).slice(0, 500))
    },
  }
}
