// Model endpoints: where a CLI agent's model comes from when it is not the runtime's own sign-in — dsh's model providers
// (Settings → 模型, the one list of where models come from; Agents → Runtimes shows them): an address that speaks
// OpenAI's Chat Completions, OpenAI's Responses or Anthropic's Messages, its key, its models. An agent of the pool names
// one (`endpoint`, the provider's id) and a model of it. Which runtime takes which: pi all three (its models.json),
// Claude Code Anthropic's (ANTHROPIC_BASE_URL), Codex OpenAI's Responses (a model provider of its config); dsh reads the
// providers itself. The key: the provider's, in dsh's credential store — in a nookbox box the host vault's placeholder
// there (the shell puts the value in the vault, bound to the provider's host, when it is set; the gateway puts it back
// on the way out to that host, nowhere else; a local server — an IP or localhost, a port the host opened to the box —
// keeps the value: the gateway does not stand between them). A run gets it in its own environment only: never in a
// file, never on a command line.
import { isIP } from 'node:net'

export const APIS = ['openai', 'openai-responses', 'anthropic']
/** The protocols each runtime can work with (none: only its own sign-in or models). */
export const RUNTIME_APIS = { pi: APIS, claude: ['anthropic'], codex: ['openai-responses'], dsh: [] }
const PI_API = { openai: 'openai-completions', 'openai-responses': 'openai-responses', anthropic: 'anthropic-messages' }
/** The variable a run reads its endpoint's key from (pi's models.json and Codex's provider name it; Claude Code has its own). */
export const KEY_ENV = 'RUYIX_ENDPOINT_KEY'
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const fail = (code, params, message) => Object.assign(new Error(message), { code, params })

/** An endpoint as kept (config.endpoints): { id, name, api, baseUrl, models }; the key is kept apart. */
export function normalizeEndpoint(def) {
  if (!def || typeof def !== 'object') throw fail('notObject', {}, 'an endpoint must be a JSON object')
  const id = String(def.id || '').trim().toLowerCase()
  if (!ID.test(id) || id.length > 32) throw fail('badEndpointId', { id }, `invalid endpoint id "${id}": lowercase letters, digits and dashes (at most 32)`)
  const api = String(def.api || '')
  if (!APIS.includes(api)) throw fail('badEndpointApi', { api }, `the protocol is one of ${APIS.join(', ')}`)
  let url
  try { url = new URL(String(def.baseUrl || '').trim()) } catch { throw fail('badEndpointUrl', {}, 'the address is a full URL, such as https://api.deepseek.com/v1') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('badEndpointUrl', {}, 'the address is http(s), without a user, a query or a #')
  const models = [...new Set((Array.isArray(def.models) ? def.models : []).map(m => String(m).trim()).filter(Boolean))]
  if (models.length > 200 || models.some(m => m.length > 120 || /\s/.test(m))) throw fail('badEndpointModels', {}, 'at most 200 models, each an id without spaces')
  return { id, name: String(def.name || id).trim().slice(0, 60) || id, api, baseUrl: url.href.replace(/\/+$/, ''), models }
}
/** A host the box reaches without the gateway: the key goes in as it is. */
export const localHost = baseUrl => { const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, ''); return h === 'localhost' || h.endsWith('.local') || isIP(h) !== 0 }

/**
 * What a run on an endpoint gets, by runtime: CLI arguments (in place of the agent's own --model), its environment, and
 * for pi the models.json of its own folder. → { args, env, piModels? }
 */
export function endpointLaunch(runtime, ep, model, key) {
  if (!RUNTIME_APIS[runtime]?.includes(ep.api)) throw fail('endpointRuntime', { runtime, api: ep.api }, `${runtime} cannot use a ${ep.api} endpoint`)
  if (!model) throw fail('endpointModel', { endpoint: ep.id }, `pick a model of ${ep.name}`)
  if (runtime === 'pi') {
    return {
      args: ['--model', `ruyix/${model}`], env: { [KEY_ENV]: key || 'none' },
      piModels: { providers: { ruyix: { baseUrl: ep.baseUrl, api: PI_API[ep.api], apiKey: `$${KEY_ENV}`, models: [{ id: model }] } } },
    }
  }
  if (runtime === 'claude') {
    // (the small model Claude Code uses on the side is the same one: an endpoint has no Haiku of Anthropic's)
    return { args: ['--model', model], env: { ANTHROPIC_BASE_URL: ep.baseUrl, ANTHROPIC_API_KEY: key || 'none', ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model } }
  }
  return {
    args: ['-c', 'model_provider="ruyix"', '-c', `model_providers.ruyix.name=${JSON.stringify(ep.name)}`, '-c', `model_providers.ruyix.base_url=${JSON.stringify(ep.baseUrl)}`,
      '-c', `model_providers.ruyix.env_key="${KEY_ENV}"`, '-c', 'model_providers.ruyix.wire_api="responses"', '-m', model],
    env: { [KEY_ENV]: key || 'none' },
  }
}

/** The endpoint's models as it lists them (`GET …/models`) → [ids]; a refused key or no answer throws. */
export async function listModels(ep, key, fetchFn = globalThis.fetch) {
  const [url, headers] = ep.api === 'anthropic'
    ? [`${ep.baseUrl}/v1/models?limit=200`, { 'x-api-key': key || '', 'anthropic-version': '2023-06-01' }]
    : [`${ep.baseUrl}/models`, key ? { authorization: `Bearer ${key}` } : {}]
  let res
  try { res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15000) }) } catch (err) { throw fail('endpointUnreachable', { detail: err.cause?.code || err.message }, `${ep.name} does not answer (${err.cause?.code || err.message})`) }
  if (res.status === 401 || res.status === 403) throw fail('endpointKeyRefused', { name: ep.name }, `${ep.name} refused the key`)
  if (!res.ok) throw fail('endpointError', { status: res.status }, `${ep.name} answered HTTP ${res.status}`)
  const body = await res.json().catch(() => null)
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null
  if (!list) throw fail('endpointNoList', { name: ep.name }, `${ep.name} gave no list of models: write the model ids yourself`)
  return [...new Set(list.map(m => String(m?.id ?? m?.name ?? '').replace(/^models\//, '')).filter(Boolean))].sort().slice(0, 200)
}

/**
 * dsh's provider protocols (llm-pi-ai's `api`) as an endpoint's, and back: what a CLI runtime can be pointed at.
 * A provider of pi-ai's catalog (no `api` of its own: "deepseek", "openai"…) is reached at its known address.
 */
export const FROM_DSH = { 'openai-completions': 'openai', 'openai-responses': 'openai-responses', 'anthropic-messages': 'anthropic' }
export const TO_DSH = { openai: 'openai-completions', 'openai-responses': 'openai-responses', anthropic: 'anthropic-messages' }
// (the shell's core/shell/providers.js has the same table in dsh's spellings — google too, which no CLI runtime takes;
// the hosts of the ids both have are checked equal there)
export const CATALOG = {
  openai: { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { api: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  deepseek: { api: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  openrouter: { api: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  groq: { api: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
  xai: { api: 'openai', baseUrl: 'https://api.x.ai/v1' },
  mistral: { api: 'openai', baseUrl: 'https://api.mistral.ai/v1' },
}
/** A provider of dsh's settings as an endpoint ({ id, name, api, baseUrl, models, keyEnv }); null: none a CLI runtime can use. */
export function endpointOfProvider(id, p) {
  if (!p || typeof p !== 'object') return null
  // (the shell's rule, providers.js addressOf: an address of its own → its protocol, OpenAI's chat completions when it says
  // none; no address → the catalog's)
  const known = p.baseURL ? (FROM_DSH[p.api || 'openai-completions'] ? { api: FROM_DSH[p.api || 'openai-completions'], baseUrl: String(p.baseURL).replace(/\/+$/, '') } : null) : CATALOG[id] || null
  if (!known) return null
  return { id, name: p.displayName || id, api: known.api, baseUrl: known.baseUrl, models: (p.models || []).map(m => String(m?.id ?? m)).filter(Boolean), keyEnv: p.apiKeyEnv || null }
}

/**
 * The model endpoints: a view of dsh's model providers (Settings → 模型, the one list of where models come from —
 * Ethan, 2026-10-17), kept by dsh's settings with their keys in dsh's credential store under each provider's `apiKeyEnv`
 * (in a nookbox box: the vault's placeholder there, put by the shell when the key is set). providers(): llm-pi-ai's
 * `providers` ({ id: { api, baseURL, apiKeyEnv, models } }); credentials: () => dsh's credential store.
 * → { list, get, key, test }
 */
export function createEndpoints({ providers = () => ({}), credentials = () => null, fetchFn = globalThis.fetch }) {
  const all = () => Object.entries(providers() || {}).map(([id, p]) => endpointOfProvider(id, p)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
  const get = id => all().find(e => e.id === id) || null
  /** The key a run gets: the provider's (the placeholder in a box; the value for a local server). '' when none is set. */
  const key = id => { const ep = get(id); return ep?.keyEnv ? (credentials()?.resolve?.(ep.keyEnv).then(r => r?.value || '', () => '') ?? Promise.resolve('')) : Promise.resolve('') }
  return {
    list: all,
    get,
    key,
    /** Reach it with its key and list its models. → { models } (kept: Settings → 模型 picks which the provider keeps) */
    async test(id) {
      const ep = get(id)
      if (!ep) throw fail('noEndpoint', { id }, `no model endpoint "${id}"`)
      return { models: await listModels(ep, await key(id), fetchFn) }
    },
  }
}

/**
 * Before the one list: endpoints kept by Agent Hub (its config.endpoints, keys under RUYIX_ENDPOINT_<ID>) → dsh's
 * providers, once, ids and key names kept (agents and queued tasks name them; the key — or a box's placeholder — stays
 * where it is: the provider names it). → [{ id, value }] to set under llm-pi-ai's providers (one whose id is taken by
 * a provider at the same address is that provider; at another address it is kept as <id>-ep — `renamed`).
 */
/**
 * An endpoint's models as they are kept (Ethan, 2026-10-17: only the ticked ones are shown; more are ticked any time in
 * Settings → 模型): more than PICKED_MAX were not picked — the old form kept all its address listed — so then only the ones
 * in use (`used`: a Set of model ids); none in use, all (nothing to go by — and a catalog provider without models of its
 * own would show the whole catalog).
 */
export const PICKED_MAX = 30
export const modelsToKeep = (models = [], used = new Set()) => {
  const inUse = models.length > PICKED_MAX ? models.filter(m => used.has(m)) : []
  return inUse.length ? inUse : models
}

/** `used`: endpoint id → the Set of its models in use (modelsToKeep). */
export function providersFromEndpoints(endpoints = [], providers = {}, used = {}) {
  const out = [], renamed = {}, same = [] // same: [{ id, keyEnv, has }] — the provider it already is; its key name may have to be this one's
  for (const e of endpoints) {
    const value = { apiKeyEnv: `RUYIX_ENDPOINT_${e.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, api: TO_DSH[e.api], baseURL: e.baseUrl, models: modelsToKeep(e.models, used[e.id]).map(m => ({ id: m })), ...(e.name && e.name !== e.id && { displayName: e.name }) }
    const taken = providers[e.id]
    if (!taken) { out.push({ id: e.id, value }); continue }
    if (String(taken.baseURL || '').replace(/\/+$/, '') === e.baseUrl) { same.push({ id: e.id, keyEnv: value.apiKeyEnv, has: taken.apiKeyEnv || null }); continue } // (the same place: the provider it already is)
    let id = `${e.id}-ep`.slice(0, 40)
    for (let n = 2; providers[id] || out.some(x => x.id === id); n++) id = `${e.id.slice(0, 34)}-ep${n}`
    renamed[e.id] = id
    out.push({ id, value })
  }
  return { add: out, renamed, same }
}
