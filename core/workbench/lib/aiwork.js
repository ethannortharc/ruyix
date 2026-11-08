// What the AI did on this machine, for the Box insights page and the assistant: every agent task Agent Hub ran (a
// workflow step's, or a job's from a chat) and every model call the workbench made itself (a model step, a translation,
// a plan for a change) — by agent, by model, by where the work came from, over a window: how
// many, tokens, cost, time, how often it worked; for a workflow step, how often its work held (passed the first time,
// was not done again). The payload's names follow nookbox's insights (input_tokens, p50_ms …) so one table shows both;
// every time is ms epoch.
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const KEEP = 20000 // lines kept in the log of the workbench's own calls
// steps whose agent runs again by design (each question asked): never "done again"
const RECURRING = new Set(['ask'])
const USAGE = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']

/** The workbench's own model calls, one JSON line each (lib/llm.js reports them). */
export function callLog(file) {
  const read = () => {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return [] }
    return text.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
  }
  return {
    // by: who made the call — a model step's "<run>:<step>" (its run and step are named on the row), a pack's own op
    add({ at, kind, model, ms, ok, usage: u, error, by }) {
      const n = k => (u && Number.isFinite(u[k]) ? u[k] : null)
      appendFileSync(file, `${JSON.stringify({
        at, kind: String(kind || '').replace(/^ruyix-workbench-/, ''), model, duration_ms: ms, ok,
        tokens: n('totalTokens') ?? ((n('inputTokens') ?? 0) + (n('outputTokens') ?? 0) || null),
        input_tokens: n('inputTokens'), output_tokens: n('outputTokens'), cache_read_tokens: n('cacheReadTokens'), cache_write_tokens: n('cacheWriteTokens'),
        cost: Number.isFinite(u?.cost?.total) ? u.cost.total : Number.isFinite(u?.cost) ? u.cost : null, ...(error && { error }), ...(by && { by: String(by).slice(0, 120) }),
      })}\n`)
    },
    read,
    /** At a start: past 4 MB, only the newest KEEP lines stay. */
    prune() {
      try { if (statSync(file).size < 4 << 20) return } catch { return }
      writeFileSync(file, `${read().slice(-KEEP).map(x => JSON.stringify(x)).join('\n')}\n`)
    },
  }
}

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d)
const sum = (xs, k) => xs.reduce((n, x) => n + (Number(x[k]) || 0), 0)
/** Counts over a list of work items (tasks and calls, as `item()` makes them). */
function tally(items) {
  const ended = items.filter(x => x.ok !== null)
  const ms = items.map(x => x.duration_ms).filter(Number.isFinite)
  const out = {
    calls: items.length, ok: ended.filter(x => x.ok).length, failed: ended.filter(x => !x.ok).length, running: items.filter(x => x.status === 'running').length,
    tokens: sum(items, 'tokens'), cost: round(sum(items, 'cost')), unpriced: items.filter(x => x.tokens && x.cost == null).length,
    p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95),
  }
  for (const k of USAGE) out[k] = items.some(x => x[k] != null) ? sum(items, k) : null // tasks from before the split was kept: none
  out.ok_rate = ended.length ? round(out.ok / ended.length, 3) : null
  return out
}
const group = (items, keyOf, extra = () => ({})) => {
  const m = new Map()
  for (const x of items) { const k = keyOf(x); if (k != null) m.set(k, [...(m.get(k) || []), x]) }
  return [...m].map(([key, xs]) => ({ key, ...tally(xs), ...extra(xs, key) })).sort((a, b) => b.calls - a.calls || b.tokens - a.tokens)
}

/**
 * The summary over [since, until):
 * - tasks: Agent Hub's tasks since `since` (hub.tasks), or null when Agent Hub is not running; agentName: id → its name
 * - runs, evidenceOf: this workbench's runs and their ledgers; success: template → the verdict that counts as done well
 * - calls: the workbench's own model calls (callLog.read())
 * → { window, available, totals, timeline, by_agent, by_model, by_source, steps, workflows, failures, tasks }
 */
export function aiWork({ tasks, agentName = id => id, runs = [], evidenceOf = () => [], success = {}, calls = [], since, until = Date.now(), maxTasks = 2000 }) {
  const inWindow = at => at >= since && at < until
  // the workbench's side: a run's job, each agent step it ran (its ledger), how each step ended
  const runOfJob = new Map(runs.filter(r => r.jobId).map(r => [r.jobId, r]))
  const steps = new Map(), stepOf = new Map() // Agent Hub task id → { run, stage, actor, held }
  const workflowRuns = []
  for (const r of runs) {
    if ((r.endedAt && r.endedAt < since) || (r.createdAt || 0) >= until) continue
    const agentEv = evidenceOf(r.id).filter(e => e.kind === 'agent' && !e.carriedFrom)
    const byStage = new Map()
    for (const e of agentEv) byStage.set(e.stage, [...(byStage.get(e.stage) || []), e])
    for (const [stage, es] of byStage) {
      const passed = r.stages?.find(s => s.key === stage)?.status === 'passed'
      es.forEach((e, i) => {
        const held = RECURRING.has(stage) ? null : passed && i === es.length - 1
        if (e.input?.task) stepOf.set(e.input.task, { run: r.id, workflow: r.workflowDef?.id || r.template, stage, actor: e.actor, held })
        if (!inWindow(e.at)) return
        const s = steps.get(stage) || steps.set(stage, { step: stage, actors: new Set(), tasks: 0, runs: 0, first_pass: 0, redone: 0, tokens: 0, cost: 0 }).get(stage)
        s.actors.add(e.actor); s.tasks++; s.tokens += Number(e.input?.tokens) || 0; s.cost += Number(e.input?.cost) || 0
      })
      if (es.some(e => inWindow(e.at))) {
        const s = steps.get(stage)
        s.runs++
        if (!RECURRING.has(stage)) { s.redone += es.length - 1; if (passed && es.length === 1) s.first_pass++ }
      }
    }
    if (inWindow(r.createdAt || 0)) workflowRuns.push({ r, tokens: sum(agentEv.map(e => e.input || {}), 'tokens'), cost: sum(agentEv.map(e => e.input || {}), 'cost') })
  }

  // every piece of AI work as one row: an Agent Hub task, or (without Agent Hub) a step from the ledger, or a helper call;
  // a task from before the agent pool has no agent: its crew member and runtime name it
  const fromHub = tasks ? tasks.filter(t => t.status === 'running' || inWindow(t.endedAt || t.createdAt || 0)).map(t => {
    const s = stepOf.get(t.id), run = s?.run || runOfJob.get(t.jobId)?.id || null
    return {
      id: t.id, source: s || runOfJob.has(t.jobId) ? 'workflow' : 'job', agent: t.agent || null, name: (t.agent && agentName(t.agent)) || t.agent || (t.member ? `${t.member} · ${t.runtime || '?'}` : null), runtime: t.runtime || null, model: t.model || null,
      run_id: run, workflow: s?.workflow || runOfJob.get(t.jobId)?.template || null, step: s?.stage || null, actor: s?.actor || t.member || null, held: s ? s.held : null,
      at: t.startedAt || t.createdAt || null, ended_at: t.endedAt || null, status: t.status, ok: t.status === 'done' ? true : t.status === 'failed' ? false : null,
      error_code: t.errorCode || null, error: t.status === 'failed' ? String(t.error || '').slice(0, 300) : null,
      duration_ms: t.startedAt && t.endedAt ? t.endedAt - t.startedAt : null, tokens: Number(t.tokens) || 0, ...Object.fromEntries(USAGE.map(k => [k, t.usage?.[k] ?? null])),
      cost: Number.isFinite(t.cost) ? t.cost : null, fallback: !!t.fallbackOf, resumed: !!t.resumedVia,
    }
  }) : runs.flatMap(r => evidenceOf(r.id).filter(e => e.kind === 'agent' && !e.carriedFrom && inWindow(e.at)).map(e => ({
    id: e.input?.task || `${r.id}#${e.seq}`, source: 'workflow', agent: e.input?.agent || null, name: (e.input?.agent && agentName(e.input.agent)) || e.input?.agent || e.actor, runtime: e.input?.runtime || null,
    model: e.input?.model || null, run_id: r.id, workflow: r.workflowDef?.id || r.template, step: e.stage, actor: e.actor, held: stepOf.get(e.input?.task)?.held ?? null,
    at: e.at, ended_at: e.at, status: e.ok ? 'done' : 'failed', ok: !!e.ok, error_code: null, error: e.ok ? null : String(e.output || '').slice(0, 300),
    duration_ms: null, tokens: Number(e.input?.tokens) || 0, ...Object.fromEntries(USAGE.map(k => [k, null])), cost: Number.isFinite(e.input?.cost) ? e.input.cost : null, fallback: false, resumed: false,
  })))
  // a call a run's step made (a model step: by "<run>:<step>") names that run and step; it stays the workbench's own call
  const runById = new Map(runs.map(r => [r.id, r]))
  const madeBy = c => { const i = String(c.by || '').indexOf(':'), r = i > 0 ? runById.get(c.by.slice(0, i)) : null; return r ? { run_id: r.id, workflow: r.workflowDef?.id || r.template, step: c.by.slice(i + 1) || null } : { run_id: null, workflow: null, step: null } }
  const helper = calls.filter(c => inWindow(c.at)).map(c => ({
    id: null, source: 'helper', kind: c.kind, agent: null, name: null, runtime: String(c.model || '').startsWith('dsh:') || !String(c.model || '').includes(':') ? 'dsh' : 'connection', model: c.model || null, ...madeBy(c), actor: null, held: null,
    at: c.at, ended_at: c.at + (c.duration_ms || 0), status: c.ok ? 'done' : 'failed', ok: !!c.ok, error_code: null, error: c.error || null,
    duration_ms: c.duration_ms ?? null, tokens: c.tokens || 0, ...Object.fromEntries(USAGE.map(k => [k, c[k] ?? null])), cost: c.cost ?? null, fallback: false, resumed: false,
  }))
  const all = [...fromHub, ...helper]

  // the time line: hours up to two days, days beyond
  const bucket = until - since <= 48 * 3600e3 ? 3600e3 : 24 * 3600e3
  const start = Math.floor(since / bucket) * bucket
  const timeline = Array.from({ length: Math.ceil((until - start) / bucket) }, (_, i) => ({ at: start + i * bucket, calls: 0, failed: 0, tokens: 0, cost: 0 }))
  for (const x of all) {
    const b = timeline[Math.floor(((x.ended_at || x.at || since) - start) / bucket)]
    if (!b) continue
    b.calls++; if (x.ok === false) b.failed++; b.tokens += x.tokens || 0; b.cost += x.cost || 0
  }
  for (const b of timeline) b.cost = round(b.cost)

  const agentRows = fromHub
  return {
    window: { since, until, bucket_ms: bucket },
    available: { hub: !!tasks },
    totals: { ...tally(all), agent_tasks: agentRows.length, helper_calls: helper.length },
    timeline,
    by_agent: group(agentRows, x => x.agent || x.name, xs => {
      const steps = xs.filter(x => x.held !== null)
      const last = xs.reduce((a, b) => ((b.at || 0) > (a.at || 0) ? b : a))
      return {
        agent: last.agent, name: last.name, runtime: last.runtime, model: last.model, fallbacks: xs.filter(x => x.fallback).length, resumed: xs.filter(x => x.resumed).length,
        steps: Object.fromEntries(group(xs.filter(x => x.step), x => x.step).map(g => [g.key, g.calls])),
        held: steps.filter(x => x.held).length, held_rate: steps.length ? round(steps.filter(x => x.held).length / steps.length, 3) : null,
      }
    }).map(({ key: _k, ...g }) => g),
    by_model: group(all, x => x.model || (x.runtime ? `${x.runtime} (default)` : null), xs => ({ agent_tasks: xs.filter(x => x.source !== 'helper').length, helper_calls: xs.filter(x => x.source === 'helper').length }))
      .map(({ key, ...g }) => ({ model: key, ...g })),
    by_source: Object.fromEntries(['workflow', 'job', 'helper'].map(s => [s, tally(all.filter(x => x.source === s))])),
    helper_kinds: group(helper, x => x.kind).map(({ key, ...g }) => ({ kind: key, ...g })),
    steps: [...steps.values()].map(s => ({ ...s, actors: [...s.actors], cost: round(s.cost), ...(RECURRING.has(s.step) ? { first_pass: null, redone: null, first_pass_rate: null, recurring: true } : { first_pass_rate: s.runs ? round(s.first_pass / s.runs, 3) : null }) })).sort((a, b) => b.tasks - a.tasks),
    workflows: Object.values(workflowRuns.reduce((m, { r, tokens, cost }) => {
      const k = r.workflowDef?.id || r.template
      const w = m[k] ||= { workflow: k, base: r.workflowDef?.base || r.template, runs: 0, finished: 0, succeeded: 0, tokens: 0, cost: 0, minutes: [] }
      w.runs++; w.tokens += tokens; w.cost += cost
      if (['done', 'failed'].includes(r.status) && r.endedAt) { w.finished++; w.minutes.push((r.endedAt - r.createdAt) / 60000) }
      if (r.verdict?.level && r.verdict.level === success[r.workflowDef?.base || r.template]) w.succeeded++
      return m
    }, {})).map(({ minutes, ...w }) => ({ ...w, cost: round(w.cost), success_rate: w.finished && success[w.base] ? round(w.succeeded / w.finished, 3) : null, cost_per_run: w.runs ? round(w.cost / w.runs) : null,
      cost_per_success: w.succeeded ? round(w.cost / w.succeeded) : null, tokens_per_run: w.runs ? Math.round(w.tokens / w.runs) : null, p50_minutes: round(pct(minutes, 0.5), 1) })),
    failures: all.filter(x => x.ok === false).sort((a, b) => (b.ended_at || b.at || 0) - (a.ended_at || a.at || 0)).slice(0, 30),
    // every row, newest first: what the insights join nookbox's findings against (the work running at that moment)
    tasks: all.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, maxTasks),
  }
}
