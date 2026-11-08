// @ruyix/web — searching the web and fetching pages, as this Ruyix is set up to (docs/design/search.md). Two providers on
// dsh's web capability (`ctx.web`), which its cordis.patch.yml makes dsh's own: `ruyix-search` runs the search service
// chosen in Settings → 搜索 (DeepSeek, Tavily, 博查, Exa, Brave), the next one when it fails; `ruyix-fetch` fetches a
// page directly (safely: lib/guard.js), then through Jina Reader or DeepSeek Fetch when that does not give a readable
// page. Every agent that has dsh's web_search / web_fetch uses them; the CLI agents get the same two through an MCP
// (web-mcp.mjs). Keys are the person's credentials (Settings → 搜索 stores them as model keys are: in a box, the host's
// vault) — resolved for each call, never kept here.
//   ~/.ruyix/web.json: { search: [service…] (first used, the rest in turn), fetch: [service…], results }
//   /api/ruyix-web: state · save · test
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWeb, webSockPath } from './lib/serve.js'
import { FETCH, SEARCH, wordsOf } from './lib/services.js'

export const inject = ['connection']
export const HOME = join(process.env.RUYIX_HOME || join(homedir(), '.ruyix'))
export const DEFAULTS = { search: ['deepseek'], fetch: ['direct', 'jina', 'deepseek'], results: 8 }
const coded = (code, message, params = {}) => Object.assign(new Error(message), { code, params })
const MIN_WORDS = 200 // a fetched page with fewer readable characters was drawn by scripts: the next way is tried

/** The settings, checked: known services, in order, no repeats. */
export function checkSettings(s = {}) {
  const list = (v, known, d) => { const out = [...new Set((Array.isArray(v) ? v : []).map(String))]; const bad = out.find(x => !Object.hasOwn(known, x)); if (bad) throw coded('badService', `no service ${bad} (${Object.keys(known).join(', ')})`, { service: bad }); return out.length ? out : d }
  return { search: list(s.search, SEARCH, DEFAULTS.search), fetch: list(s.fetch, FETCH, DEFAULTS.fetch), results: Math.min(20, Math.max(1, Number(s.results) || DEFAULTS.results)) }
}

/**
 * The web for this Ruyix: `keyOf(name)` → the key (or undefined), `fetch` (the services'), `guard` (direct fetches).
 * → { search(request, signal), fetchPage(request, signal), settings(), save(s), test(…) }
 */
export function createWeb({ home = HOME, keyOf = async () => undefined, fetch = globalThis.fetch, guard, log = () => {} } = {}) {
  const file = join(home, 'web.json')
  let current = (() => { try { return checkSettings(JSON.parse(readFileSync(file, 'utf8'))) } catch { return { ...DEFAULTS } } })()
  const keyFor = async svc => (svc.key ? await keyOf(svc.key) : undefined)

  async function searchWith(id, query, n, signal) {
    const svc = SEARCH[id]
    const key = await keyFor(svc)
    if (!key) throw coded('WEB_PROVIDER_CREDENTIAL_MISSING', `${svc.name} has no key: Settings → 搜索`)
    return svc.search(query, n, { key, fetch, signal })
  }
  async function fetchWith(id, url, signal) {
    const svc = FETCH[id]
    const key = await keyFor(svc)
    if (svc.key && !key && !svc.keyOptional) throw coded('WEB_PROVIDER_CREDENTIAL_MISSING', `${svc.name} has no key: Settings → 搜索`)
    return svc.fetch(url, { key, fetch, signal, ...(guard && { guard }) })
  }

  const web = {
    settings: () => ({ ...current }),
    /** Change some of them (what is not given stays). */
    save(s) {
      current = checkSettings({ ...current, ...(s || {}) })
      mkdirSync(home, { recursive: true })
      writeFileSync(`${file}.tmp`, `${JSON.stringify(current, null, 2)}\n`)
      renameSync(`${file}.tmp`, file)
      return web.settings()
    },
    /** One search, by the services in their order: the first that answers. → dsh's WebSearchResult (without `truncated`) */
    async search({ query, maxResults }, signal) {
      const q = String(query || '').trim()
      if (!q) throw coded('WEB_INVALID_REQUEST', 'an empty search')
      const errors = []
      for (const id of current.search) {
        try { return await searchWith(id, q, maxResults || current.results, signal) } catch (err) {
          if (signal?.aborted) throw err
          errors.push(`${SEARCH[id].name}: ${err.message}`)
          log(`ruyix-web: search with ${id}: ${err.message}`)
        }
      }
      throw coded('WEB_PROVIDER_ERROR', `no search service answered — ${errors.join(' · ')}`)
    },
    /** One page, by the ways in their order: the first that gives a readable page (a page drawn by scripts, a refusal: the next). */
    async fetchPage({ url }, signal) {
      const errors = []
      let last = null
      for (const id of current.fetch) {
        try {
          const r = await fetchWith(id, String(url || ''), signal)
          if (r.statusCode >= 200 && r.statusCode < 300 && wordsOf(r.body) >= MIN_WORDS) return r
          last ||= r
          errors.push(`${FETCH[id].name}: ${r.statusCode >= 300 ? `HTTP ${r.statusCode}` : 'almost no text (drawn by scripts?)'}`)
        } catch (err) {
          if (signal?.aborted || err.code === 'WEB_FETCH_BLOCKED' || err.code === 'WEB_FETCH_INVALID_URL') throw err // (no other way may reach it either)
          errors.push(`${FETCH[id].name}: ${err.message}`)
          log(`ruyix-web: fetch with ${id}: ${err.message}`)
        }
      }
      if (last) return last // (what one way did get: a non-2xx page is a result, not an error)
      throw coded('WEB_PROVIDER_ERROR', `the page could not be fetched — ${errors.join(' · ')}`)
    },
    /** Try one service (or the chain) once, for Settings: { ok, ms, sources? | text?, error? } */
    async test({ kind, service, query, url }) {
      const t0 = Date.now(), signal = AbortSignal.timeout(60000)
      try {
        if (kind === 'search') {
          const r = service ? await searchWith(service, String(query || 'DeepSeek'), 5, signal) : await web.search({ query: query || 'DeepSeek', maxResults: 5 }, signal)
          return { ok: true, ms: Date.now() - t0, ...(r.content && { content: r.content.slice(0, 600) }), sources: r.sources.slice(0, 5) }
        }
        const r = service ? await fetchWith(service, String(url || 'https://example.com'), signal) : await web.fetchPage({ url: url || 'https://example.com' }, signal)
        return { ok: r.statusCode < 400, ms: Date.now() - t0, status: r.statusCode, kind: r.body.kind, chars: r.body.content.length, words: wordsOf(r.body), text: r.body.content.replace(/<(script|style|noscript|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) }
      } catch (err) { return { ok: false, ms: Date.now() - t0, error: err.message, code: err.code || null } }
    },
    /** What Settings shows: each service, whether its key is there (never the key). */
    async state() {
      const keyed = async svc => (svc.key ? !!(await keyOf(svc.key)) : true)
      const row = async (id, svc) => ({ id, name: svc.name, key: svc.key || null, keyOptional: !!svc.keyOptional, keySet: await keyed(svc), keyUrl: svc.keyUrl || null, host: svc.host || null })
      return {
        settings: web.settings(),
        search: await Promise.all(Object.entries(SEARCH).map(([id, s]) => row(id, s))),
        fetch: await Promise.all(Object.entries(FETCH).map(([id, s]) => row(id, s))),
      }
    },
  }
  return web
}

export function apply(ctx) {
  const keyOf = async name => {
    try { const c = ctx.get?.('credentials'); if (c) { const v = (await c.resolve(name))?.value; if (v) return v } } catch { /* none there */ }
    return process.env[name] || undefined
  }
  const web = createWeb({ keyOf, log: m => ctx.logger?.warn?.(m) })
  // dsh's web capability: the two providers its config (cordis.patch.yml) chooses
  ctx.inject?.(['web'], inner => {
    inner.effect(() => inner.web.registerSearchProvider({ id: 'ruyix-search', available: () => true, search: (req, signal) => web.search(req, signal) }), 'ruyix-web: search')
    inner.effect(() => inner.web.registerFetchProvider({ id: 'ruyix-fetch', available: () => true, fetch: (req, signal) => web.fetchPage(req, signal) }), 'ruyix-web: fetch')
  })
  const ops = {
    state: () => web.state(),
    save: ({ settings }) => ({ settings: web.save(settings) }),
    test: args => web.test(args || {}),
  }
  ctx.connection.fetch.register({
    path: '/api/ruyix-web',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const { op, ...args } = await request.json()
        if (!Object.hasOwn(ops, op)) return Response.json({ error: `unknown op ${op}` }, { status: 400 })
        return Response.json(await ops[op](args))
      } catch (err) {
        return Response.json({ error: err?.message || String(err), code: err?.code, params: err?.params }, { status: err?.code === 'badService' ? 400 : 500 })
      }
    },
  })
  // the CLI agents' way in (web-mcp.mjs over lib/serve.js's socket), and the service for other plugins (Agent Hub gives
  // every CLI agent the MCP: web_search, web_fetch beside their own)
  let sock = null, unserve = () => {}
  try { mkdirSync(HOME, { recursive: true }); sock = webSockPath(HOME); unserve = serveWeb(web, sock, { log: m => ctx.logger?.warn?.(m) }) } catch (err) { ctx.logger?.warn?.(`ruyix-web: the agents' socket: ${err.message}`) }
  ctx.effect?.(() => () => unserve(), 'ruyix-web: the agents\' socket')
  ctx.provide?.('ruyixWeb', {
    search: (q, s) => web.search(q, s), fetch: (r, s) => web.fetchPage(r, s), settings: () => web.settings(),
    /** The MCP server for a CLI agent: { name, command, args, env } (null: no socket). */
    mcp: () => (sock ? { name: 'ruyix-web', command: process.execPath, args: [fileURLToPath(new URL('./web-mcp.mjs', import.meta.url))], env: { RUYIX_WEB_SOCK: sock } } : null),
  })
}
