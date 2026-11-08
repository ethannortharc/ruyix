// AI translation in the panel, on demand: a run page's agent-written texts go in one batch to the Host
// (which caches per text and model), and are remembered here for the session.
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { call } from './data.js'

const memo = new Map() // `${lang}\n${text}` → translation
const subscribers = new Set()
let pending = null
const flush = async () => {
  const batch = pending
  pending = null
  for (const [lang, texts] of batch) {
    const list = [...texts]
    try {
      const { texts: out } = await call('translate', { texts: list, lang })
      list.forEach((t, i) => memo.set(`${lang}\n${t}`, out[i]))
    } catch (err) {
      list.forEach(t => memo.set(`${lang}\n${t}`, { error: err.message }))
    }
  }
  for (const fn of subscribers) fn()
}
const request = (lang, texts) => {
  pending ??= new Map()
  const set = pending.get(lang) || new Set()
  for (const t of texts) set.add(t)
  pending.set(lang, set)
  setTimeout(() => pending && flush(), 30) // collect a render's worth of texts into one call
}

/** Where a translation goes: Chinese text → English, anything else (the agents write English) → Chinese. */
export function targetFor(text) {
  const s = String(text || '')
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length
  const latin = (s.match(/[A-Za-z]/g) || []).length
  return cjk > latin * 0.3 ? 'en' : 'zh'
}

export const TrCtx = createContext({ lang: 'off', tx: t => t, busy: false })
export const useTx = () => useContext(TrCtx)

/** `tx(text)` → the translation once it arrived (else the original); `busy` while some are on their way. */
export function useTranslated(texts, lang) {
  const [, bump] = useState(0)
  useEffect(() => { const fn = () => bump(n => n + 1); subscribers.add(fn); return () => subscribers.delete(fn) }, [])
  const wanted = useMemo(() => (lang === 'off' ? [] : [...new Set(texts.filter(t => t && t.trim()))]), [lang, texts.join('\u0001')])
  const missing = wanted.filter(t => !memo.has(`${lang}\n${t}`))
  useEffect(() => { if (missing.length) { missing.forEach(t => memo.set(`${lang}\n${t}`, null)); request(lang, missing) } }, [lang, missing.join('\u0001')])
  const tx = t => {
    if (lang === 'off' || !t) return t
    const v = memo.get(`${lang}\n${t}`)
    return typeof v === 'string' ? v : t
  }
  const errors = wanted.map(t => memo.get(`${lang}\n${t}`)).filter(v => v && typeof v === 'object')
  return { lang, tx, busy: wanted.some(t => memo.get(`${lang}\n${t}`) === null), error: errors[0]?.error || '' }
}
