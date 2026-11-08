// Search and fetch (index.js, lib/): no network here — each service's request and its answer turned into dsh's web
// vocabulary, against a stand-in; the services in their order (a missing key, a failure: the next); a page drawn by
// scripts fetched another way; what an agent may not fetch (this machine, private networks, the metadata address).
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSettings, createWeb } from './index.js'
import { blockedAddress, checkUrl, guardedFetch } from './lib/guard.js'
import { FETCH, SEARCH, wordsOf } from './lib/services.js'

const tmp = mkdtempSync(join(tmpdir(), 'ruyix-web-'))
const throwsCode = async (p, code) => assert.rejects(p, e => e.code === code, code)

// ── what an agent may not fetch ──
for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) assert.equal(blockedAddress(ip), true, ip)
for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '172.32.0.1']) assert.equal(blockedAddress(ip), false, ip)
for (const bad of ['file:///etc/passwd', 'http://localhost:3280/', 'http://10.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'https://user:pw@example.com/', 'http://nookbox.internal/v1', 'ftp://example.com/']) assert.throws(() => checkUrl(bad), e => e.code === 'WEB_FETCH_BLOCKED', bad)
assert.equal(checkUrl('https://example.com/a?b=1').hostname, 'example.com')
for (const ip of ['::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '0:0:0:0:0:0:7f00:1']) {
  assert.equal(blockedAddress(ip), true, ip)
  assert.throws(() => checkUrl(`http://[${ip}]/`), e => e.code === 'WEB_FETCH_BLOCKED', ip)
}
assert.throws(() => checkUrl('http://[::ffff:169.254.169.254]/'), e => e.code === 'WEB_FETCH_BLOCKED')
await throwsCode(guardedFetch('http://127.0.0.1:1/'), 'WEB_FETCH_BLOCKED')

// ── each service, against a stand-in ──
const asked = []
const answers = {
  'https://api.deepseek.com/v1/tools/search': { results: [{ title: 'DeepSeek', url: 'https://deepseek.com', snippet: 's', summary: 'the summary', date: '2026-10-17T00:00:00Z' }, { title: 'no url' }] },
  'https://api.tavily.com/search': { answer: 'An answer.', results: [{ title: 'T', url: 'https://t.example', content: 'tc', published_date: '2026-10-01' }] },
  'https://api.bochaai.com/v1/web-search': { code: 200, data: { webPages: { value: [{ name: '博查', url: 'https://b.example', snippet: 'bs', summary: '博查摘要', datePublished: '2026-10-10T08:00:00+08:00' }] } } },
  'https://api.exa.ai/search': { results: [{ title: 'E', url: 'https://e.example', highlights: ['one.', 'two.'], publishedDate: '2026-09-01' }] },
  'https://api.search.brave.com/res/v1/web/search': { web: { results: [{ title: 'B', url: 'https://br.example', description: 'a <strong>bold</strong> word', page_age: '2026-10-02' }] } },
  'https://api.deepseek.com/v1/tools/fetch': { title: 'Page', content: 'x'.repeat(300) },
}
const stand = async (url, init = {}) => {
  const u = String(url), base = u.split('?')[0]
  asked.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null })
  if (u.startsWith('https://r.jina.ai/')) return new Response('# Reader\n\n' + 'word '.repeat(80), { status: 200 })
  if (answers[base]) return Response.json(answers[base])
  return new Response('nope', { status: 500 })
}
const keys = { DEEPSEEK_API_KEY: 'dk', TAVILY_API_KEY: 'tk', BOCHA_API_KEY: 'bk', EXA_API_KEY: 'ek', BRAVE_API_KEY: 'brk' }
const last = () => asked.at(-1)
let r = await SEARCH.deepseek.search('什么是 agent OS'.repeat(20), 99, { key: 'dk', fetch: stand })
assert.deepEqual([last().method, last().headers.authorization, last().body.query.length, last().body.count], ['POST', 'Bearer dk', 128, 50], 'DeepSeek: 128 characters at most, 50 results')
assert.deepEqual(r.sources, [{ url: 'https://deepseek.com', title: 'DeepSeek', snippet: 'the summary', publishedAt: '2026-10-17T00:00:00Z' }], 'its model-oriented summary as the snippet; one without a url left out')
r = await SEARCH.tavily.search('q', 8, { key: 'tk', fetch: stand })
assert.deepEqual([last().headers.authorization, last().body.max_results, r.content, r.sources[0].snippet], ['Bearer tk', 8, 'An answer.', 'tc'])
r = await SEARCH.bocha.search('q', 10, { key: 'bk', fetch: stand })
assert.deepEqual([last().body.summary, r.sources[0]], [true, { url: 'https://b.example', title: '博查', snippet: '博查摘要', publishedAt: '2026-10-10T08:00:00+08:00' }])
r = await SEARCH.exa.search('q', 8, { key: 'ek', fetch: stand })
assert.deepEqual([last().headers['x-api-key'], last().body.numResults, r.sources[0].snippet], ['ek', 8, 'one. … two.'])
r = await SEARCH.brave.search('q x', 8, { key: 'brk', fetch: stand })
assert.deepEqual([last().url, last().headers['x-subscription-token'], r.sources[0].snippet], ['https://api.search.brave.com/res/v1/web/search?q=q+x&count=8', 'brk', 'a bold word'])
r = await FETCH.deepseek.fetch('https://x.example', { key: 'dk', fetch: stand })
assert.deepEqual([last().body, r.body.kind, r.body.content.startsWith('# Page\n\n')], [{ url: 'https://x.example' }, 'text', true])
r = await FETCH.jina.fetch('https://x.example/a', { key: null, fetch: stand })
assert.deepEqual([last().url, last().headers.authorization, r.body.kind], ['https://r.jina.ai/https://x.example/a', undefined, 'text'], 'Jina without a key: no authorization header')
await assert.rejects(SEARCH.tavily.search('q', 5, { key: 'tk', fetch: async () => Response.json({ detail: 'bad key' }, { status: 401 }) }), e => e.code === 'WEB_PROVIDER_CREDENTIAL_INVALID' && /Tavily: HTTP 401 — bad key/.test(e.message))

// ── the services in their order ──
const page = html => async () => ({ status: 200, url: 'https://p.example/', ok: true, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => Buffer.from(html) })
const web = createWeb({ home: tmp, keyOf: async n => ({ TAVILY_API_KEY: 'tk', DEEPSEEK_API_KEY: 'dk' })[n], fetch: stand, guard: page('<html><body><div id=app></div><script>render()</script></body></html>') })
assert.deepEqual(web.settings(), { search: ['deepseek'], fetch: ['direct', 'jina', 'deepseek'], results: 8 })
web.save({ search: ['exa', 'tavily'], fetch: ['direct', 'jina'], results: 5 })
r = await web.search({ query: 'q' })
assert.deepEqual([r.content, last().url], ['An answer.', 'https://api.tavily.com/search'], 'Exa has no key: Tavily answered')
web.save({ search: ['exa'] })
await assert.rejects(web.search({ query: 'q' }), e => /no search service answered — Exa: Exa has no key/.test(e.message))
r = await web.fetchPage({ url: 'https://p.example/' })
assert.deepEqual([r.body.kind, last().url], ['text', 'https://r.jina.ai/https://p.example/'], 'a page drawn by scripts: read through Jina')
const readable = createWeb({ home: tmp, fetch: stand, guard: page(`<html><body><p>${'readable words '.repeat(30)}</p></body></html>`) })
r = await readable.fetchPage({ url: 'https://p.example/' })
assert.equal(r.body.kind, 'html', 'a readable page: as it came, directly')
const blocked = createWeb({ home: tmp, fetch: stand })
await throwsCode(blocked.fetchPage({ url: 'http://192.168.1.1/admin' }), 'WEB_FETCH_BLOCKED')
assert.equal(asked.filter(a => a.url.includes('192.168')).length, 0, 'a private address: no other way tries it either')
assert.equal(wordsOf({ kind: 'html', content: '<script>var a = "lots of text here";</script><p>hi</p>' }), 2)
assert.throws(() => checkSettings({ search: ['google'] }), e => e.code === 'badService')
assert.deepEqual(createWeb({ home: tmp }).settings(), { search: ['exa'], fetch: ['direct', 'jina'], results: 5 }, 'kept in web.json')

// ── Settings' state and test ──
const st = await web.state()
assert.deepEqual(st.search.map(s => `${s.id}:${s.keySet}`), ['deepseek:true', 'tavily:true', 'bocha:false', 'exa:false', 'brave:false'])
assert.deepEqual(st.fetch.map(s => `${s.id}:${s.keySet}:${s.keyOptional}`), ['direct:true:false', 'jina:false:true', 'deepseek:true:false'])
const t = await web.test({ kind: 'search', service: 'tavily', query: 'q' })
assert.deepEqual([t.ok, t.sources.length, typeof t.ms], [true, 1, 'number'])
assert.deepEqual(await web.test({ kind: 'search', service: 'bocha' }).then(x => [x.ok, x.code]), [false, 'WEB_PROVIDER_CREDENTIAL_MISSING'])

// ── a CLI agent's way in: the MCP (web-mcp.mjs) over the socket (lib/serve.js) ──
{
  const { serveWeb } = await import('./lib/serve.js')
  const { spawn } = await import('node:child_process')
  const { htmlText } = await import('./web-mcp.mjs')
  const sock = join(tmp, 'web.sock')
  const fake = {
    search: async ({ query }) => (query === 'boom' ? Promise.reject(new Error('no search service answered')) : { content: 'An answer.', sources: [{ url: 'https://a.example', title: 'A', snippet: 'about a', publishedAt: '2026-10-17T00:00:00Z' }] }),
    fetchPage: async ({ url }) => ({ url, statusCode: 200, truncated: false, body: { kind: 'html', content: '<html><head><title>x</title></head><body><h1>Hi</h1><p>Read <a href="https://b.example">this</a>.</p><script>no()</script></body></html>' } }),
  }
  const unserve = serveWeb(fake, sock)
  await new Promise(r => setTimeout(r, 100))
  const script = join(tmp, 'web server 空格.mjs')
  copyFileSync(new URL('./web-mcp.mjs', import.meta.url), script)
  const p = spawn(process.execPath, [script], { env: { ...process.env, RUYIX_WEB_SOCK: sock } })
  let out = ''
  p.stdout.on('data', c => { out += c })
  const rpc = (id, method, params) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  rpc(1, 'initialize', {}); rpc(2, 'tools/list', {}); rpc(3, 'tools/call', { name: 'web_search', arguments: { queries: ['q1', 'boom', 'q1'] } }); rpc(4, 'tools/call', { name: 'web_fetch', arguments: { url: 'https://x.example' } })
  for (let i = 0; i < 50 && out.split('\n').filter(Boolean).length < 4; i++) await new Promise(r => setTimeout(r, 50))
  p.kill()
  const got = Object.fromEntries(out.split('\n').filter(Boolean).map(l => JSON.parse(l)).map(m => [m.id, m.result]))
  assert.deepEqual(got[2].tools.map(t => t.name), ['web_search', 'web_fetch'])
  assert.equal(got[3].content[0].text, '## q1\nAnswer: An answer.\n1. A\n   https://a.example · 2026-10-17\n   about a\n\n## boom\n(failed: no search service answered)', 'each search under its words (one repeated: once); a failed one says so')
  assert.equal(got[4].content[0].text, 'https://x.example (HTTP 200)\n\n# Hi\nRead [this](https://b.example).', 'a page as readable text, its links kept')
  assert.equal(htmlText('<ul><li>a</li><li>b</li></ul>'), '- a\n- b')
  unserve()
}

rmSync(tmp, { recursive: true, force: true })
console.log('web check: ok')
