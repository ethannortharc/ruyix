// The one Settings page's Host side, over dsh's own services: the model providers dsh's agents run on and dsh's default
// model (its settings service: the same profile entries dsh's Settings → Models writes), their keys (its credential
// store; never read back), the providers' models (its model discovery), the few platform settings worth a person's time
// (shell, agent loop, subagents, web search, theme) — and the plugins: the release's own and those added (ruyix plugin add).
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { plugins } from './bin/ruyix-plugin.mjs'
import { WEB_KEYS, forgetKey, isPlaceholder, keyToKeep } from './providers.js'

/** The profile entries this page reads and writes; dsh's other settings stay out of the way. */
export const SECTIONS = ['llm-pi-ai', 'agent-default-model', 'bash-sandbox', 'pwsh-sandbox', 'agent-loop', 'subagent', 'subagent-model-selection-settings', 'web-search-deepseek', 'ui-theme']
const KEY_NAME = /^[A-Z][A-Z0-9_]{1,63}$/
const SCOPE = '@ruyix/'
const json = (body, status = 200) => Response.json(body, { status })
const fail = (code, status = 400, params) => json({ error: code, ...(params && { params }) }, status)

/** A credential this page may set: one a model provider or the web search names (the providers' apiKeyEnv). */
export function keyNames(sections) {
  const pi = sections.find(s => s.ns === 'llm-pi-ai')?.value?.providers || {}
  const names = Object.values(pi).map(p => p?.apiKeyEnv).filter(Boolean)
  const web = sections.find(s => s.ns === 'web-search-deepseek')?.value
  return [...new Set([...names, web?.apiKeyEnv || 'DEEPSEEK_API_KEY'])].filter(n => KEY_NAME.test(n))
}

/** The plugins this profile has: the release's own packages and those added (Ruyix's record), with versions, and
 * whether each is on (~/.ruyix/layout.json, ruyix plugin enable / disable). */
export function pluginsOf(profileDir, ruyixHome) {
  let added = {}
  try { added = JSON.parse(readFileSync(join(ruyixHome, 'plugins.json'), 'utf8')).plugins || {} } catch { /* none */ }
  let deps = {}
  try { deps = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies || {} } catch { /* not a profile */ }
  const version = name => { try { return JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')).version } catch { return null } }
  const state = Object.fromEntries(plugins(ruyixHome, profileDir).map(x => [x.name, { on: x.on, core: x.core, default: x.default }]))
  // the release this is (all of Ruyix's packages share one version) and where it comes from: a source checkout, the
  // box's image, or a release installed into this home (ruyix install / ruyix upgrade)
  const shell = `${SCOPE}shell`
  let at = '', image = process.env.RUYIX_IMAGE || ''
  try { at = realpathSync(join(profileDir, 'node_modules', shell)) } catch { /* not installed */ }
  try { if (image) image = realpathSync(image) } catch { /* as given */ }
  const from = String(deps[shell] || '').startsWith('link:') && !(image && at.startsWith(image)) ? 'source' : image && at.startsWith(image) ? 'image' : 'release'
  return {
    release: { version: version(shell), from },
    builtin: Object.keys(deps).filter(n => n.startsWith(SCOPE) && !added[n]).sort().map(name => ({ name, version: version(name), linked: String(deps[name]).startsWith('link:'), ...state[name] })),
    added: Object.entries(added).map(([name, e]) => ({ name, version: version(name) || e.version, available: e.available?.version || null, id: e.id || null, thirdParty: !name.startsWith(SCOPE), ...state[name] })),
  }
}

/** ruyix, which changes the profile's plugins: on the PATH, in ~/.local/bin (ruyix install), or the image's. */
const ruyixBin = () => [...String(process.env.PATH || '').split(':').filter(Boolean), join(homedir(), '.local/bin'), '/usr/local/bin'].map(d => join(d, 'ruyix')).find(existsSync)

export function registerSettings(ctx, { profile }) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'), ruyixHome = process.env.RUYIX_HOME || join(homedir(), '.ruyix')
  const profileDir = join(dshHome, 'profiles', profile), inBox = !!process.env.RUYIX_IMAGE
  const services = { settings: null, credentials: null, llm: null }
  for (const name of Object.keys(services)) {
    ctx.inject([name], inner => {
      services[name] = inner[name]
      inner.effect(() => () => { services[name] = null }, `ruyix: ${name}`)
    })
  }
  const sections = () => services.settings.describe({ redactSecrets: true }).filter(s => SECTIONS.includes(s.ns))
    .map(s => ({ ns: s.ns, value: s.value, user: s.user, revision: s.revision, secrets: s.secrets }))
  const route = (path, methods, fetch) => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch: async request => {
    try { return await fetch(request) } catch (err) {
      // a page read before someone else's write is refused (dsh: settings-conflict) and shown again; anything else says what failed
      const message = String(err?.message || err).slice(0, 300)
      return fail(err?.code === 'settings-conflict' || /changed since it was read/.test(message) ? 'conflict' : 'failed', 400, { message })
    }
  } })

  // the sections, and each provider key's state ({ NAME: true | false }); a write is one section's path edits
  route('/api/ruyix/settings', ['GET', 'POST'], async request => {
    if (!services.settings) return fail('noSettings', 503)
    if (request.method === 'GET') {
      const all = sections(), keys = {}, kept = {}
      for (const n of keyNames(all)) keys[n] = !!(await services.credentials?.describe(n).catch(() => null))?.configured
      // in a box: which keys the box itself holds (set before the vault was used for them) — set once more, the host keeps it
      if (process.env.NOOKBOX_API) for (const n of Object.keys(keys).filter(k => keys[k])) kept[n] = isPlaceholder((await services.credentials?.resolve?.(n).catch(() => null))?.value) ? 'vault' : 'box'
      return json({ writable: services.settings.writable !== false, sections: all, keys, kept })
    }
    const { ns, ops, revision } = await request.json()
    if (!SECTIONS.includes(ns)) return fail('notHere', 400, { ns })
    if (!Array.isArray(ops) || !ops.length || ops.some(o => !['set', 'unset'].includes(o?.op) || !Array.isArray(o.path))) return fail('badEdit')
    await services.settings.mutate(ns, ops, revision)
    return json({ ok: true })
  })
  // a provider's key: set (never read back) or removed. In a nookbox box the value goes to the host's vault for the
  // provider's host and only its placeholder is kept (providers.js: the gateway puts it back on the way out there); a
  // local server's (a host port, like omlx) as it is — the gateway is not between the box and the host
  route('/api/ruyix/credential', ['POST'], async request => {
    const { name, value } = await request.json()
    if (!services.credentials || !services.settings) return fail('noCredentials', 503)
    // (a model's key, or a search service's: Settings → 搜索, @ruyix/web)
    if (!keyNames(sections()).includes(name) && !Object.hasOwn(WEB_KEYS, name)) return fail('notAKey', 400, { name })
    const box = process.env.NOOKBOX_API || null, boxName = process.env.NOOKBOX_NAME || 'box'
    if (value == null || value === '') { await services.credentials.unset(name); await forgetKey({ keyEnv: name, box, boxName }); return json({ ok: true, set: false }) }
    const key = String(value).trim()
    if (key.length > 1024 || /\s/.test(key)) return fail('badKey')
    await services.credentials.set(name, await keyToKeep({ keyEnv: name, sections: sections(), value: key, box, boxName }))
    return json({ ok: true, set: true })
  })
  // the models a provider serves: its catalog, or its endpoint asked (a key typed in the form wins over the stored one)
  route('/api/ruyix/models', ['POST'], async request => {
    if (!services.llm?.discoverModels) return fail('noDiscovery', 503)
    const body = await request.json()
    // a provider already kept at an address of its own: what that address lists now, asked with its key (dsh lists from an
    // address only when it is told it, and a catalog id — openrouter — it answers from pi-ai's own list, which lags);
    // a catalog provider without an address: by its name
    const kept = body.provider && !body.baseURL ? sections().find(x => x.ns === 'llm-pi-ai')?.value?.providers?.[body.provider] : null
    const keyOf = async name => (name ? (await services.credentials?.resolve?.(name).catch(() => null))?.value : undefined)
    const { provider, baseURL, api, apiKey } = kept?.baseURL ? { baseURL: kept.baseURL, api: kept.api, apiKey: await keyOf(kept.apiKeyEnv) } : body
    const models = await services.llm.discoverModels('llm-pi-ai', { ...(provider && { provider }), ...(baseURL && { baseURL }), ...(api && { api }), ...(apiKey && { apiKey }) }, AbortSignal.timeout(20000))
    return json({ models: models.map(m => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens })) })
  })
  // the plugins; removing one or taking a newer checked version is Ruyix's (it restarts dsh once nothing is at work)
  route('/api/ruyix/plugins', ['GET', 'POST'], async request => {
    const now = pluginsOf(profileDir, ruyixHome)
    if (request.method === 'GET') return json({ ...now, inBox })
    const { action, name } = await request.json()
    // on or off (any plugin but the always-on ones): ruyix writes the layout and restarts dsh once nothing is at work
    const toggle = { enable: 'enable', disable: 'disable', default: 'default' }[action]
    const any = [...now.builtin, ...now.added].find(x => x.name === name)
    if (toggle && (!any || any.core)) return fail('notToggle', 400, { name })
    const p = now.added.find(x => x.name === name)
    if (!toggle && !p) return fail('notAdded', 400, { name })
    let record = {}
    try { record = JSON.parse(readFileSync(join(ruyixHome, 'plugins.json'), 'utf8')).plugins?.[name] || {} } catch { /* gone meanwhile */ }
    const args = toggle ? ['plugin', toggle, name]
      : action === 'remove' ? ['plugin', 'remove', name]
      : action === 'upgrade' && record.available ? ['plugin', 'add', `${name}@${record.available.version}`, '--integrity', record.available.integrity, '--registry', record.available.registry || record.registry, ...(record.id ? ['--id', record.id] : []), ...(inBox ? [] : ['--on-host'])]
      : null
    if (!args) return fail('badAction', 400, { action })
    const ruyix = ruyixBin()
    if (!ruyix) return fail('noRuyix', 503)
    mkdirSync(ruyixHome, { recursive: true })
    const log = join(ruyixHome, `plugin-${action}.log`), out = openSync(log, 'w')
    // its own session: ruyix stops this dsh on the way
    spawn(ruyix, args, { detached: true, stdio: ['ignore', out, out] }).unref()
    closeSync(out)
    return json({ started: true, log })
  })
}
