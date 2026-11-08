// dsh's model providers (its settings, llm-pi-ai — Settings → 模型 «模型接入点»): the one list of where models come from
// (Ethan, 2026-10-17). dsh reads them for its own models; Agent Hub shows them as the CLI agents' model endpoints; voice
// input takes a speech model of one. What the shell needs of them besides dsh: a provider's address (a provider of
// pi-ai's catalog has no `baseURL` of its own: its known one), and — in a nookbox box — a key kept in the host's vault.
import { isIP } from 'node:net'

/**
 * pi-ai's catalog providers this list knows the address of (and the protocol at it). Agent Hub's endpoints.js has the
 * same table in its own spellings (no google: no CLI runtime takes it); the check holds the hosts of the ids both have equal.
 */
export const CATALOG = {
  openai: { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
  deepseek: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1' },
  openrouter: { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' },
  groq: { api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1' },
  xai: { api: 'openai-completions', baseUrl: 'https://api.x.ai/v1' },
  mistral: { api: 'openai-completions', baseUrl: 'https://api.mistral.ai/v1' },
  google: { api: 'google', baseUrl: 'https://generativelanguage.googleapis.com' },
}
/** A provider's protocol and address ({ api, baseUrl }); null: not known. */
export function addressOf(id, p) {
  if (!p || typeof p !== 'object') return null
  if (p.baseURL) return { api: p.api || 'openai-completions', baseUrl: String(p.baseURL).replace(/\/+$/, '') }
  return CATALOG[id] || null
}
/** A host the box reaches without the gateway (an IP, localhost, *.local — a port of the host opened to the box). */
export const localHost = baseUrl => { try { const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, ''); return h === 'localhost' || h.endsWith('.local') || isIP(h) !== 0 } catch { return false } }
/**
 * The vault's name for a key in this box: after the credential it is kept under (not the provider: two providers may
 * share a key, a provider may be renamed), without a RUYIX_ — so Agent Hub's endpoints, kept under RUYIX_ENDPOINT_<ID>,
 * keep their entries CONN_<BOX>_ENDPOINT_<ID>.
 */
export const vaultName = (boxName, keyEnv) => `CONN_${String(boxName).toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40)}_${String(keyEnv).replace(/^RUYIX_/, '').toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`
/** Settings other than providers that name a key, and the hosts they send it to (dsh's DeepSeek web search: its Anthropic-shaped API). */
export const KEY_HOSTS = { 'web-search-deepseek': ['api.deepseek.com'] }
/** The search and fetch services' keys (@ruyix/web, docs/design/search.md) and the hosts each goes to. */
export const WEB_KEYS = { TAVILY_API_KEY: ['api.tavily.com'], BOCHA_API_KEY: ['api.bochaai.com'], EXA_API_KEY: ['api.exa.ai'], BRAVE_API_KEY: ['api.search.brave.com'], JINA_API_KEY: ['r.jina.ai'] }
/**
 * Where a key goes: { hosts, local } — the hosts of every provider (and setting) naming it, in dsh's settings sections
 * ([{ ns, value }]); local: one of them is a local server (the gateway is not in between: the value must stay as it is).
 */
export function keyUses(keyEnv, sections = []) {
  const hosts = new Set()
  let local = false
  for (const [id, p] of Object.entries(sections.find(s => s.ns === 'llm-pi-ai')?.value?.providers || {})) {
    if (p?.apiKeyEnv !== keyEnv) continue
    const at = addressOf(id, p)
    if (!at) continue
    if (localHost(at.baseUrl)) local = true
    else hosts.add(new URL(at.baseUrl).hostname)
  }
  for (const s of sections) if (s.ns !== 'llm-pi-ai' && s.value?.apiKeyEnv === keyEnv) for (const h of KEY_HOSTS[s.ns] || []) hosts.add(h)
  for (const h of WEB_KEYS[keyEnv] || []) hosts.add(h)
  return { hosts: [...hosts].sort(), local }
}

/**
 * A key as it is to be kept: in a box, the value goes to the host's vault for the hosts that use it (the gateway puts it
 * back on the way out there, nowhere else) and the placeholder is what is kept; one a local server uses, one whose
 * hosts are not known, or one outside a box, as it is. `box`: NOOKBOX_API. → the value to keep
 */
export async function keyToKeep({ keyEnv, sections, value, box, boxName = 'box', fetchFn = globalThis.fetch }) {
  const { hosts, local } = keyUses(keyEnv, sections)
  if (!box || local || !hosts.length) return value
  const res = await fetchFn(new URL(`/v1/secrets/${vaultName(boxName, keyEnv)}`, box), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, hosts }), signal: AbortSignal.timeout(15000) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.placeholder) throw Object.assign(new Error(`nookbox vault: ${data.error || `HTTP ${res.status}`}`), { code: 'vault' })
  return data.placeholder
}
/** A key let go: its vault entry too (in a box). */
export async function forgetKey({ keyEnv, box, boxName = 'box', fetchFn = globalThis.fetch }) {
  if (!box) return
  await fetchFn(new URL(`/v1/secrets/${vaultName(boxName, keyEnv)}`, box), { method: 'DELETE', signal: AbortSignal.timeout(15000) }).catch(() => {})
}
/** A nookbox placeholder (`<prefix>NKB<32 letters and digits>`): a key the host's vault keeps, not the box. */
export const isPlaceholder = v => /^[A-Za-z0-9._~-]{0,64}NKB[A-Za-z0-9]{32}$/.test(String(v || ''))
