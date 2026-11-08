// AI translation of agent output (step notes, claims, reports, assistant replies) into
// Chinese or English through dsh's model service, with a configurable model. Every translation is cached by
// (model, language, text), so a run's output is translated once and reopening it is instant.
import { createHash } from 'node:crypto'
import { complete } from './llm.js'

export const LANGS = { zh: 'Simplified Chinese (简体中文)', en: 'English' }
const BATCH_CHARS = 6000
const sha = s => createHash('sha256').update(s).digest('hex')
const system = lang => [
  'You are a precise translator for working documents: reports, drafts, notes, evidence logs.',
  `Translate into ${LANGS[lang]}.`,
  'Keep unchanged: code, commands, identifiers, file paths, URLs, numbers, references like #123, Markdown syntax, table structure and line breaks.',
  `Text that is already in ${LANGS[lang]} stays as it is. Output only the translation — no notes, no quotes.`,
].join('\n')

/** One model call (lib/llm.js: its usage goes to the workbench's log of its own calls). */
async function translateCall(llm, model, lang, text, signal, onCall) {
  if (model.indexOf('/') < 1) throw new Error(model ? `the translation model must be provider/model, got "${model}"` : 'no model to translate with: the default agent of the Agents page (a dsh agent with a model) is what translation runs on')
  try {
    return (await complete({ llm, model, system: system(lang), text, kind: 'ruyix-workbench-translate', maxTokens: 8192, signal, onCall })).trim()
  } catch (err) {
    throw new Error(String(err?.message || err).replace(/^the model stopped/, 'translation stopped'))
  }
}

export function createTranslator({ llm, model, cache, onCall }) {
  const one = (lang, text, signal) => translateCall(llm(), model(), lang, `Translate:\n\n${text}`, signal, onCall)
  // Short texts travel together as a JSON array; a reply that does not parse falls back to one call each.
  const batch = async (lang, texts, signal) => {
    if (texts.length === 1) return [await one(lang, texts[0], signal)]
    const reply = await translateCall(llm(), model(), lang, `Translate every string in this JSON array. Reply with only a JSON array of the translated strings, same length and order.\n${JSON.stringify(texts)}`, signal, onCall)
    try {
      const arr = JSON.parse(reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1))
      if (Array.isArray(arr) && arr.length === texts.length && arr.every(x => typeof x === 'string')) return arr
    } catch { /* fall back below */ }
    return Promise.all(texts.map(t => one(lang, t, signal)))
  }
  return {
    /** Translations in input order; empty strings stay empty. */
    async translate(texts, lang, signal) {
      if (!LANGS[lang]) throw new Error(`unsupported language "${lang}" (zh, en)`)
      const m = model()
      const key = t => sha(`${m}\n${lang}\n${t}`)
      const out = texts.map(t => (String(t || '').trim() ? cache.get(key(t)) : String(t || '')))
      const todo = out.map((v, i) => (v == null ? i : -1)).filter(i => i >= 0)
      const groups = []
      let cur = [], size = 0
      for (const i of todo) {
        const len = texts[i].length
        if (len > BATCH_CHARS) { groups.push([i]); continue }
        if (size + len > BATCH_CHARS && cur.length) { groups.push(cur); cur = []; size = 0 }
        cur.push(i); size += len
      }
      if (cur.length) groups.push(cur)
      for (const g of groups) {
        const done = await batch(lang, g.map(i => texts[i]), signal)
        g.forEach((i, k) => { out[i] = done[k]; cache.put(key(texts[i]), done[k]) })
      }
      return out
    },
    /** A Markdown report, section by section; the evidence ledger table stays as is. */
    async markdown(md, lang, signal) {
      const parts = md.split(/\n(?=## )/)
      const keep = p => /^## (Evidence ledger|证据台账)/.test(p)
      const idx = parts.map((p, i) => (keep(p) ? -1 : i)).filter(i => i >= 0)
      const done = await this.translate(idx.map(i => parts[i]), lang, signal)
      idx.forEach((i, k) => { parts[i] = done[k] })
      return parts.join('\n')
    },
  }
}
