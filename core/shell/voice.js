// Voice input (the Host side): what the browser recorded (16 kHz mono WAV) goes to a speech-to-text model that speaks
// the OpenAI API (/audio/transcriptions) — by default the one Fonos uses on this Mac, omlx's Qwen3-ASR — of a model
// endpoint (dsh's model providers, Settings → 模型 «模型接入点»: the one list of where models come from — Ethan,
// 2026-10-17), with its key (in a box: the vault's placeholder, put back by the gateway; a local server's as it is). An
// http connection of the Connectors page set before still works. The page puts the words where the person was typing,
// or hands them to the main agent (src/desktop/voice.js).
// voice.json: { provider | connection, model, language, hotkey }; nothing set: a provider (then a connection) whose
// models include a speech model is found and used. hotkey: the key that starts and ends a dictation (voice-key.js).
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addressOf } from './providers.js'
import { HOTKEY_DEFAULT, checkHotkey } from './voice-key.js'

const MAX_BYTES = 24 << 20 // ~12 minutes of 16 kHz 16-bit mono: longer is not dictation
export const SPEECH = /asr|whisper|transcri|speech|sensevoice|paraformer|firered/i
const LANGS = ['auto', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es']
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status })

/** Speech models out of a /models answer, the larger ASR first: what to offer, and what to pick by itself. */
export function speechOf(body) {
  const ids = (body?.data || []).map(m => String(m.id || '')).filter(id => SPEECH.test(id))
  const size = id => Number((/(\d+(?:\.\d+)?)b\b/i.exec(id) || [])[1] || 0)
  return [...new Set(ids)].sort((a, b) => /asr/i.test(b) - /asr/i.test(a) || size(b) - size(a))
}

/**
 * providers(): dsh's model providers (llm-pi-ai); credentials(): dsh's credential store (a provider's key under its
 * apiKeyEnv); connectors(): the Connectors service (connections set before).
 */
export function createVoice({ home, connectors = () => null, providers = () => ({}), credentials = () => null, fetchFn = globalThis.fetch }) {
  const file = join(home, 'voice.json')
  const own = () => { try { return JSON.parse(readFileSync(file, 'utf8')) || {} } catch { return {} } }
  const write = v => { writeFileSync(`${file}.tmp`, `${JSON.stringify(v, null, 2)}\n`); renameSync(`${file}.tmp`, file) }
  // the providers that speak OpenAI's chat completions (the API /audio/transcriptions belongs to), with their address and key name
  const openai = () => Object.entries(providers() || {}).map(([id, p]) => ({ id, p, at: addressOf(id, p) })).filter(x => x.at?.api === 'openai-completions')
  const keyOf = async p => (p?.apiKeyEnv ? (await credentials()?.resolve?.(p.apiKeyEnv).catch(() => null))?.value || '' : '')
  const auth = key => (key ? { authorization: `Bearer ${key}` } : {})
  /** The model endpoints and the connections there are, each with the speech models it offers (asked of each, a few seconds at most). */
  async function choices() {
    const fromProviders = await Promise.all(openai().map(async ({ id, p, at }) => {
      let models = []
      try {
        const res = await fetchFn(`${at.baseUrl}/models`, { headers: auth(await keyOf(p)), signal: AbortSignal.timeout(8000) })
        if (res.ok) models = speechOf(await res.json())
      } catch { /* not reachable now */ }
      // (what the provider keeps, for one that does not list its models)
      if (!models.length) models = speechOf({ data: (p.models || []).map(m => ({ id: m?.id ?? m })) })
      return { kind: 'provider', id, name: id, baseUrl: at.baseUrl, models }
    }))
    const svc = connectors()
    const http = svc ? (await svc.list().catch(() => [])).filter(c => c.type === 'http' && !c.unknownType) : []
    const fromConnections = await Promise.all(http.map(async c => {
      let models = []
      try { const res = await svc.client(c.id, { by: 'voice' }).request('models', { timeout: 8000 }); if (res.ok) models = speechOf(await res.json()) } catch { /* not reachable now */ }
      return { kind: 'connection', id: c.id, name: c.name || c.id, baseUrl: c.baseUrl, models }
    }))
    return [...fromProviders, ...fromConnections]
  }
  /** What is used now: what was set, else the first model endpoint (then connection) with a speech model, and that model. */
  async function resolve() {
    const o = own(), language = o.language || 'auto'
    if (o.provider && o.model) return { provider: o.provider, model: o.model, language, chosen: true }
    if (o.connection && o.model) return { connection: o.connection, model: o.model, language, chosen: true }
    const all = await choices()
    const found = all.find(c => (o.provider ? c.kind === 'provider' && c.id === o.provider : o.connection ? c.kind === 'connection' && c.id === o.connection : true) && c.models.length)
    return found ? { [found.kind]: found.id, model: o.model || found.models[0], language, chosen: false } : null
  }
  return {
    async config() { return { set: own(), using: await resolve().catch(() => null), choices: await choices(), languages: LANGS, hotkey: own().hotkey || HOTKEY_DEFAULT } },
    /** Where the words come from ({ provider | connection, model, language }), or only the key ({ hotkey }): the rest kept. */
    async save(v, { replace = false, expect } = {}) {
      if (expect !== undefined && JSON.stringify(own()) !== JSON.stringify(expect)) throw fail('changedMeanwhile', 'voice settings changed elsewhere: look at them again')
      if (!replace && v && 'hotkey' in v && Object.keys(v).length === 1) {
        const o = own()
        if (v.hotkey === null) { const { hotkey, ...rest } = o; write(rest); return this.config() }
        const c = checkHotkey(v.hotkey)
        if (!c.ok) throw fail('badHotkey', c.why === 'plain' ? 'a key alone would stop typing: a modifier key alone, F1–F24, or a key with Ctrl, ⌥ or ⌘' : `hotkey: ${c.why}`)
        write({ ...o, hotkey: c.hotkey })
        return this.config()
      }
      const hotkey = replace ? v.hotkey : own().hotkey
      if (hotkey && !checkHotkey(hotkey).ok) throw fail('badHotkey', 'invalid voice shortcut')
      const next = { ...(hotkey && { hotkey: checkHotkey(hotkey).hotkey }) }
      if (v.provider) { if (!ID.test(String(v.provider))) throw fail('badVoice', 'provider: a model endpoint\'s id'); next.provider = String(v.provider) }
      else if (v.connection) { if (!ID.test(String(v.connection))) throw fail('badVoice', 'connection: a connection\'s id'); next.connection = String(v.connection) }
      if (v.model) { if (String(v.model).length > 120 || /[\u0000-\u001f]/.test(v.model)) throw fail('badVoice', 'model: up to 120 characters'); next.model = String(v.model) }
      if (v.language) { if (!LANGS.includes(v.language)) throw fail('badVoice', `language: one of ${LANGS.join(', ')}`); next.language = v.language }
      write(next)
      return this.config()
    },
    /** WAV bytes → { text }. */
    async transcribe(bytes) {
      if (!bytes?.byteLength) throw fail('empty', 'no audio')
      if (bytes.byteLength > MAX_BYTES) throw fail('tooLong', 'longer than dictation: up to about 12 minutes')
      const use = await resolve()
      if (!use) throw fail('noEngine', 'no speech-to-text yet: add a model endpoint with a speech model (Settings → General → Voice input)', 409)
      const form = new FormData() // as Fonos sends it (the same engine answers both): the file, the model, the language
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'speech.wav')
      form.append('model', use.model)
      if (use.language && use.language !== 'auto') form.append('language', use.language)
      let res, who
      if (use.provider) {
        const x = openai().find(e => e.id === use.provider)
        if (!x) throw fail('noEngine', `the model endpoint ${use.provider} is not there (or does not speak the OpenAI API): Settings → General → Voice input`, 409)
        who = use.provider
        res = await fetchFn(`${x.at.baseUrl}/audio/transcriptions`, { method: 'POST', headers: auth(await keyOf(x.p)), body: form, signal: AbortSignal.timeout(120000) })
      } else {
        const svc = connectors()
        if (!svc) throw fail('noConnectors', 'the connectors plugin is not loaded', 503)
        who = use.connection
        res = await svc.client(use.connection, { by: 'voice input' }).request('audio/transcriptions', { method: 'POST', body: form, timeout: 120000 })
      }
      if (!res.ok) throw fail('engine', `${who} answered ${res.status}: ${String(await res.text()).replace(/\s+/g, ' ').slice(0, 200)}`, 502)
      const body = await res.json().catch(() => ({}))
      return { text: String(body.text ?? '').trim(), model: use.model }
    },
  }
}
