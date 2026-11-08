// Landing on one record of a studio (a reminder in the strip, the main agent): 'ruyix:open' { panel, studio,
// collection, record } is caught here and kept until that studio's page reads it — the page may be created by that
// very open, after the event — then the page opens the record over itself.
import { useEffect, useState } from 'react'

const pending = new Map() // studio id → { collection, record }
const EVENT = 'ruyix-studio:focus'
const PAGE = 'ruyix-studio-'

/** Catch the opens that name a record (main.jsx's apply, for the plugin's life). */
export function catchFocus() {
  const on = e => {
    const d = e.detail || {}
    if (typeof d.panel !== 'string' || !d.panel.startsWith(PAGE) || !d.record || !d.collection) return
    pending.set(String(d.studio || d.panel.slice(PAGE.length)), { collection: String(d.collection), record: String(d.record) })
    window.dispatchEvent(new CustomEvent(EVENT))
  }
  window.addEventListener('ruyix:open', on)
  return () => window.removeEventListener('ruyix:open', on)
}

/** The record a studio's page is asked to land on (null: none), and done() when it has. */
export function useFocus(studio) {
  const [focus, setFocus] = useState(() => pending.get(studio) || null)
  useEffect(() => {
    const on = () => setFocus(pending.get(studio) || null)
    on()
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [studio])
  return [focus, () => { pending.delete(studio); setFocus(null) }]
}
