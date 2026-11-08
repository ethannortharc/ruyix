// The box's own window on nookbox (http://nookbox.internal/v1): the nookbox gateway answers it for the box the request
// comes from — no token, read-only, that box only. A dsh outside any box gets no answer (code notInBox).

const TIMEOUT_MS = 8000

/** An error the panel can say in its language: code + params, the English message as the fallback. */
export const coded = (code, message, params) => Object.assign(new Error(message), { code, params })

export function boxApi(base) {
  async function get(path, query = {}) {
    if (!base) throw coded('notInBox', 'this dsh does not run in a nookbox box')
    const url = new URL(path, base)
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    let res
    try { res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }) } catch (err) {
      throw coded('notInBox', `nookbox did not answer at ${base} (${err?.cause?.code || err?.message || err})`, { api: base })
    }
    if (res.status === 404) throw coded('notFound', `nookbox has no ${url.pathname}`)
    if (!res.ok) throw coded('http', `nookbox ${url.pathname}: HTTP ${res.status}`, { status: res.status })
    return res.json()
  }
  return {
    box: () => get('/v1/box'),
    flows: ({ limit = 100, before, host } = {}) => get('/v1/flows', { limit, before, host }),
    flow: id => get(`/v1/flows/${encodeURIComponent(id)}`),
    events: ({ kinds, before, text, limit = 200 } = {}) => get('/v1/events', { kinds: Array.isArray(kinds) ? kinds.join(',') : kinds, before, text, limit }),
    usage: ({ days = 30 } = {}) => get('/v1/usage', { days }),
    stats: ({ hours = 24 } = {}) => get('/v1/stats', { hours }),
    insights: ({ hours = 24 } = {}) => get('/v1/insights', { hours }),
  }
}

// ── the shield: the box in a few numbers (the top bar's light, the desk's 「盒子」 widget) ──
/**
 * The box's health as the shield says it. nookbox's own levels are good / watch / risk (audit.rs: score ≥ 85 / ≥ 60 / below);
 * they map to ok / warn / bad. A level this code does not know (a newer nookbox): decided by the score the same way.
 */
export const shieldHealth = h => {
  const by = { good: 'ok', watch: 'warn', risk: 'bad' }[h?.level]
  if (by) return by
  const score = Number(h?.score)
  return !Number.isFinite(score) || score >= 85 ? 'ok' : score >= 60 ? 'warn' : 'bad'
}
/**
 * What the shield shows, from the three answers nookbox gave (/v1/box, /v1/stats, /v1/insights over the same window):
 * requests out since `since` (stats), how many the egress policy refused (the egress-blocked findings that happened since
 * then, summed) and the latest of those. The counts are by whole hours, so they can reach back to the hour before `since`.
 */
export function shieldOf({ box, stats, insights }, since = 0) {
  const blocked = (insights?.findings || []).filter(g => g.tag === 'egress-blocked' && (g.last ?? 0) >= since)
  const last = blocked.reduce((a, g) => (!a || g.last > a.last ? g : a), null)
  return {
    inBox: true,
    runtime: box?.box?.spec?.runtime === 'microvm' ? 'microvm' : 'container',
    state: box?.box?.state || '',
    health: shieldHealth(insights?.health),
    requests: Number(stats?.requests) || 0,
    blocked: blocked.reduce((n, g) => n + (Number(g.count) || 0), 0),
    lastBlocked: last ? { at: last.last, subject: last.subject || '', reason: last.reason || '' } : null,
  }
}

/** Token counts by model over the rows /v1/usage returns (one per model and day). */
export function usageByModel(rows) {
  const by = new Map()
  for (const r of rows || []) {
    const k = `${r.provider}/${r.model}`
    const t = by.get(k) || { provider: r.provider, model: r.model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    t.requests += r.requests; t.input += r.input_tokens; t.output += r.output_tokens
    t.cacheRead += r.cache_read_tokens; t.cacheWrite += r.cache_write_tokens
    by.set(k, t)
  }
  return [...by.values()].sort((a, b) => b.input + b.output - (a.input + a.output))
}

const kb = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`)

/** The box's insights (`/v1/insights`) as text, for the assistants: health, findings, clients, what looks off. */
export function insightsText(x, hours) {
  const pct = v => `${Math.round((v || 0) * 1000) / 10}%`
  const lines = [`Last ${hours} h: health ${x.health.score}/100 (${x.health.level})${x.health.reasons.length ? ` — ${x.health.reasons.map(r => `${r.code} ${r.n} (−${r.cost})`).join(', ')}` : ''}`]
  lines.push('Findings:', ...(x.findings.length ? x.findings.slice(0, 20).map(g => `- ${g.risk} ${g.tag}${g.subject ? ` · ${g.subject}` : ''}: ${g.count}× — ${g.reason}; last: ${g.example?.summary || ''}`) : ['- none']))
  lines.push('Clients:', ...(x.clients.length ? x.clients.map(c => `- ${c.client}: ${c.requests} requests, ${pct(c.error_rate)} failed, p50 ${c.p50_ms ?? '?'} ms, p95 ${c.p95_ms ?? '?'} ms${c.ai_requests ? `, ${c.ai_requests} model calls, in ${c.input_tokens} out ${c.output_tokens} tokens, cache hit ${c.cache_hit == null ? 'unknown' : pct(c.cache_hit)}` : ''}`) : ['- none']))
  lines.push('What looks off:', ...(x.anomalies.length ? x.anomalies.map(a => `- ${a.code}${a.host ? ` ${a.host}` : ''}${a.request ? ` ${a.request}` : ''}${a.status ? ` (${a.status})` : ''}: ${a.count}${a.usual !== undefined ? ` (usual ${a.usual})` : ''}`) : ['- nothing']))
  if (x.new_hosts.length) lines.push(`New destinations: ${x.new_hosts.map(h => h.host).join(', ')}`)
  if (x.activity.p50_ms != null) lines.push(`Latency: p50 ${x.activity.p50_ms} ms, p95 ${x.activity.p95_ms} ms (mean ${x.activity.avg_ms} ms)`)
  const dest = d => `- ${d.host}: ${d.requests} requests, ${pct(d.error_rate)} failed, p50 ${d.p50_ms ?? '?'} ms, p95 ${d.p95_ms ?? '?'} ms, ↑${kb(d.sent)} ↓${kb(d.received)}; ${d.clients.join(', ')}`
  if (x.destinations?.length) {
    lines.push('Destinations (busiest):', ...x.destinations.slice(0, 10).map(dest))
    const slow = [...x.destinations].filter(d => d.p95_ms != null).sort((p, q) => q.p95_ms - p.p95_ms).slice(0, 3)
    if (slow.length) lines.push('Slowest (p95):', ...slow.map(dest))
  }
  lines.push(`Activity: ${Object.entries(x.activity.kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`)
  return lines.join('\n')
}

/** One line per HTTP exchange, for the assistants. */
export function flowLine(f) {
  const ai = f.model ? ` · ${f.model} in ${f.input_tokens} out ${f.output_tokens}` : ''
  const creds = f.secrets?.length ? ` · credentials ${f.secrets.join(', ')}` : ''
  return `${new Date(f.ts).toISOString()} ${f.method} ${f.scheme}://${f.host}${f.port && ![80, 443].includes(f.port) ? `:${f.port}` : ''}${f.path} → ${f.error ? `error ${f.error}` : f.status} ${f.duration_ms}ms ↑${kb(f.req_bytes)} ↓${kb(f.resp_bytes)}${creds}${ai}`
}

// ── the AI work (the workbench's aiWork) beside what the box saw ──
const AGENTS = new Set(['claude', 'codex', 'dsh', 'pi']) // nookbox's client names that are Agent Hub runtimes too
const SLACK_MS = 60e3 // the box's clock and the workbench's may be a little apart: a task a minute off still counts
/** When a finding or an anomaly happened: an hour's burst, a finding's first to last, else its last. */
export const spanOf = x => (x.hour != null ? { from: x.hour, to: x.hour + 3600e3 - 1 } : { from: x.first ?? x.last, to: x.last })
/**
 * The AI work running in [from, to] (aiWork's rows, newest first): the agents' tasks before the workbench's own calls;
 * when the box's client is an agent runtime (claude, codex, dsh, pi), only that runtime's.
 */
export function atWork(tasks, { from, to = from, client }, now = Date.now()) {
  if (from == null) return []
  const end = x => x.ended_at ?? (x.status === 'running' ? now : x.at)
  return (tasks || [])
    .filter(x => x.at != null && x.at - SLACK_MS <= to && end(x) + SLACK_MS >= from && (!AGENTS.has(client) || x.runtime === client))
    .sort((a, b) => (a.source === 'helper') - (b.source === 'helper'))
}
/** One task in a few words: who, and which step, job or helper call. */
export const taskLine = x => [x.name || x.runtime || '?', x.source === 'helper' ? `workbench ${x.kind || 'call'}` : x.step ? `${x.workflow || 'workflow'}/${x.step}` : 'chat job', x.run_id].filter(Boolean).join(' · ')

/** The AI work (aiWork) as text, for the assistants: by agent, by model, and what ran when the box saw something. */
export function aiWorkText(w, ins, hours) {
  const pct = v => (v == null ? '-' : `${Math.round(v * 1000) / 10}%`)
  const usd = v => (v ? `, $${v.toFixed(2)}` : '') // unpriced or free: nothing said
  const t = w.totals
  const lines = [`Last ${hours} h: ${t.agent_tasks} agent tasks, ${t.helper_calls} workbench model calls; ${t.ok} done, ${t.failed} failed, ${t.running} running (success ${pct(t.ok_rate)}); ${t.tokens} tokens${usd(t.cost)}`]
  if (!w.available.hub) lines.push('Agent Hub is not running: only the workflow steps in the workbench ledger are known.')
  lines.push('By agent:', ...(w.by_agent.length ? w.by_agent.map(a => `- ${a.name || a.agent} (${a.runtime || '?'}${a.model ? ` ${a.model}` : ''}): ${a.calls} tasks, success ${pct(a.ok_rate)}, work kept ${pct(a.held_rate)}, ${a.tokens} tokens${usd(a.cost)}, p50 ${a.p50_ms ?? '?'} ms${Object.keys(a.steps || {}).length ? `; steps ${Object.entries(a.steps).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`) : ['- none']))
  lines.push('By model:', ...(w.by_model.length ? w.by_model.map(m => `- ${m.model}: ${m.calls} (${m.agent_tasks} agent tasks, ${m.helper_calls} workbench calls), success ${pct(m.ok_rate)}, ${m.tokens} tokens${usd(m.cost)}`) : ['- none']))
  if (ins) {
    const seen = [...ins.findings.map(g => [`${g.risk} ${g.tag}${g.subject ? ` · ${g.subject}` : ''}`, g]), ...ins.anomalies.map(a => [`${a.code}${a.host ? ` ${a.host}` : ''}${a.client ? ` (${a.client})` : ''}`, a])]
    lines.push('Running when the box saw something:', ...(seen.length ? seen.slice(0, 30).map(([what, x]) => {
      const hits = atWork(w.tasks, { ...spanOf(x), client: x.client })
      return `- ${what}: ${hits.length ? `${hits.slice(0, 5).map(taskLine).join('; ')}${hits.length > 5 ? `; +${hits.length - 5} more` : ''}` : 'no AI work'}`
    }) : ['- the box saw nothing']))
  }
  return lines.join('\n')
}
