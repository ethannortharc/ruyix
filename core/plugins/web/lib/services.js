// The search and fetch services (docs/design/search.md), each by its own published API, answered in dsh's web vocabulary
// (@deepseek-ai/dsh-web: a search → { content?, sources: [{ url, title?, snippet?, publishedAt? }] }; a fetch → { url,
// statusCode, body: { kind: 'html' | 'text', content }, truncated }). A key comes in already resolved (in a box: the
// vault's placeholder, put back by the gateway on its way to the service's host — `host` here says which).
import { guardedFetch } from './guard.js'

const fail = (code, message) => Object.assign(new Error(message), { code })
/** A service's answer as JSON, or a throw saying what went wrong (the status, the service's own message). */
async function json(res, name) {
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  if (!res.ok) {
    const said = body?.error?.message || body?.message || body?.detail || (typeof body?.error === 'string' ? body.error : '') || text.slice(0, 200)
    throw fail(res.status === 401 || res.status === 403 ? 'WEB_PROVIDER_CREDENTIAL_INVALID' : res.status === 402 ? 'WEB_PROVIDER_QUOTA' : res.status === 429 ? 'WEB_PROVIDER_RATE_LIMITED' : 'WEB_PROVIDER_ERROR', `${name}: HTTP ${res.status}${said ? ` — ${String(said).slice(0, 200)}` : ''}`)
  }
  if (!body) throw fail('WEB_PROVIDER_ERROR', `${name}: the answer is not JSON`)
  return body
}
const clamp = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.round(n) : d))
const clean = s => (typeof s === 'string' && s.trim() ? s.trim() : undefined)
const source = ({ url, title, snippet, publishedAt }) => ({ url, ...(clean(title) && { title: clean(title) }), ...(clean(snippet) && { snippet: clean(snippet).slice(0, 1200) }), ...(clean(publishedAt) && { publishedAt: clean(publishedAt) }) })

/** The search services: { name, key (its credential's name), host, keyUrl (where to get one), search(query, n, { key, fetch, signal }) } */
export const SEARCH = {
  deepseek: {
    name: 'DeepSeek', key: 'DEEPSEEK_API_KEY', host: 'api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys',
    async search(query, n, { key, fetch, signal }) {
      const res = await fetch('https://api.deepseek.com/v1/tools/search', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: query.slice(0, 128), count: clamp(n, 1, 50, 10) }), signal })
      const { results = [] } = await json(res, 'DeepSeek search')
      return { sources: results.filter(r => r?.url).map(r => source({ url: r.url, title: r.title, snippet: r.summary || r.snippet, publishedAt: r.date })) }
    },
  },
  tavily: {
    name: 'Tavily', key: 'TAVILY_API_KEY', host: 'api.tavily.com', keyUrl: 'https://app.tavily.com',
    async search(query, n, { key, fetch, signal }) {
      const res = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, max_results: clamp(n, 1, 20, 8), search_depth: 'basic', include_answer: true }), signal })
      const { answer, results = [] } = await json(res, 'Tavily')
      return { ...(clean(answer) && { content: clean(answer) }), sources: results.filter(r => r?.url).map(r => source({ url: r.url, title: r.title, snippet: r.content, publishedAt: r.published_date })) }
    },
  },
  bocha: {
    name: '博查', key: 'BOCHA_API_KEY', host: 'api.bochaai.com', keyUrl: 'https://open.bochaai.com',
    async search(query, n, { key, fetch, signal }) {
      const res = await fetch('https://api.bochaai.com/v1/web-search', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, count: clamp(n, 1, 50, 10), summary: true, freshness: 'noLimit' }), signal })
      const body = await json(res, '博查')
      if (body.code && body.code !== 200) throw fail('WEB_PROVIDER_ERROR', `博查: ${body.msg || body.message || body.code}`)
      const list = body.data?.webPages?.value || []
      return { sources: list.filter(r => r?.url).map(r => source({ url: r.url, title: r.name, snippet: r.summary || r.snippet, publishedAt: r.datePublished || r.dateLastCrawled })) }
    },
  },
  exa: {
    name: 'Exa', key: 'EXA_API_KEY', host: 'api.exa.ai', keyUrl: 'https://dashboard.exa.ai/api-keys',
    async search(query, n, { key, fetch, signal }) {
      const res = await fetch('https://api.exa.ai/search', { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ query, numResults: clamp(n, 1, 25, 8), contents: { highlights: { numSentences: 3, highlightsPerUrl: 2 } } }), signal })
      const { results = [] } = await json(res, 'Exa')
      return { sources: results.filter(r => r?.url).map(r => source({ url: r.url, title: r.title, snippet: (r.highlights || []).join(' … ') || r.summary || r.text, publishedAt: r.publishedDate })) }
    },
  },
  brave: {
    name: 'Brave Search', key: 'BRAVE_API_KEY', host: 'api.search.brave.com', keyUrl: 'https://api-dashboard.search.brave.com/app/keys',
    async search(query, n, { key, fetch, signal }) {
      const u = new URL('https://api.search.brave.com/res/v1/web/search')
      u.searchParams.set('q', query); u.searchParams.set('count', String(clamp(n, 1, 20, 8)))
      const res = await fetch(u, { headers: { 'x-subscription-token': key, accept: 'application/json' }, signal })
      const body = await json(res, 'Brave Search')
      return { sources: (body.web?.results || []).filter(r => r?.url).map(r => source({ url: r.url, title: r.title, snippet: String(r.description || '').replace(/<\/?strong>/g, ''), publishedAt: r.page_age || r.age })) }
    },
  },
}

const BODY_MAX = 2_000_000
/** The fetch services: { name, key?, keyOptional?, host?, fetch(url, { key, fetch, signal, guard }) } */
export const FETCH = {
  direct: {
    name: '直接抓', key: null,
    async fetch(url, { signal, guard = guardedFetch }) {
      const res = await guard(url, { signal, headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; Ruyix/1.0; +https://github.com/ethannortharc/ruyix)' } })
      const type = String(res.headers.get('content-type') || '')
      if (!/text\/|html|xml|json/.test(type)) throw fail('WEB_UNSUPPORTED_CONTENT', `not a page or text (${type || 'no type'})`)
      const buf = Buffer.from(await res.arrayBuffer())
      const content = buf.subarray(0, BODY_MAX).toString('utf8')
      return { url: res.url || url, statusCode: res.status, body: /html|xml/.test(type) ? { kind: 'html', content } : { kind: 'text', content }, truncated: buf.length > BODY_MAX }
    },
  },
  jina: {
    name: 'Jina Reader', key: 'JINA_API_KEY', keyOptional: true, host: 'r.jina.ai', keyUrl: 'https://jina.ai/reader',
    async fetch(url, { key, fetch, signal }) {
      const res = await fetch(`https://r.jina.ai/${url}`, { headers: { ...(key && { authorization: `Bearer ${key}` }), accept: 'text/plain', 'x-return-format': 'markdown' }, signal })
      const text = await res.text()
      if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 'WEB_PROVIDER_CREDENTIAL_INVALID' : res.status === 429 ? 'WEB_PROVIDER_RATE_LIMITED' : 'WEB_PROVIDER_ERROR', `Jina Reader: HTTP ${res.status} — ${text.slice(0, 200)}`)
      return { url, statusCode: 200, body: { kind: 'text', content: text.slice(0, BODY_MAX) }, truncated: text.length > BODY_MAX }
    },
  },
  deepseek: {
    name: 'DeepSeek Fetch', key: 'DEEPSEEK_API_KEY', host: 'api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys',
    async fetch(url, { key, fetch, signal }) {
      const res = await fetch('https://api.deepseek.com/v1/tools/fetch', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ url }), signal })
      if (res.status === 404 || res.status === 403) { const b = await res.json().catch(() => ({})); throw fail('WEB_FETCH_EMPTY', `DeepSeek Fetch: ${b?.error?.message || `HTTP ${res.status}`}`) }
      const { title, content = '' } = await json(res, 'DeepSeek Fetch')
      const text = `${clean(title) ? `# ${clean(title)}\n\n` : ''}${content}`
      return { url, statusCode: 200, body: { kind: 'text', content: text.slice(0, BODY_MAX) }, truncated: text.length > BODY_MAX }
    },
  },
}

/** The words a fetched page has (tags and scripts out): a page with almost none was drawn by scripts — worth another try. */
export function wordsOf(body) {
  const s = body.kind === 'html' ? body.content.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ') : body.content
  return s.replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length
}
