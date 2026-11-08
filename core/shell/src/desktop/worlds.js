// The interactive desks plugins draw (desktop.json mode `world`): window.__ruyixWorlds = [{ id, name: { zh, en }, render }]
// and a 'ruyix:worlds' event when the list changes. `render` is a React component given `api` (desktop.jsx: the pages,
// opening one, the conversation, a new task, settings, ⌘K, back to the desktop, the other maps, the wallpaper engine,
// voice input — listen() — and the whole screen — fullscreen: { on, toggle } or null).
import { useEffect, useState } from 'react'

const read = () => (Array.isArray(window.__ruyixWorlds) ? window.__ruyixWorlds.filter(w => w && w.id && typeof w.render === 'function') : [])

/**
 * What the pages wear while a map is the desk (its `theme`): { scheme?: 'dark' | 'light' (the pages kept to it),
 * tokens: { '--ruyix-…': [light, dark] } } → the CSS for <body> ('' for none). The tokens are tokens.css's: the colours,
 * lines, surfaces, the accent, and the corners' dial (`--ruyix-radius-k`: one value for both).
 */
export function themeCssOf(theme) {
  if (!theme || typeof theme !== 'object') return ''
  const ok = n => /^--ruyix-[a-z0-9-]+$/.test(n)
  const val = v => String(v).replace(/[;{}<>]/g, '')
  const vars = Object.entries(theme.tokens || {}).filter(([n]) => ok(n)).map(([n, v]) => (Array.isArray(v) ? `${n}: light-dark(${val(v[0])}, ${val(v[1])});` : `${n}: ${val(v)};`))
  if (theme.scheme === 'dark' || theme.scheme === 'light') vars.unshift(`color-scheme: ${theme.scheme};`)
  return vars.length ? `body { ${vars.join(' ')} }` : ''
}

/** The interactive desks there are now, as they come and go. */
export function useWorlds() {
  const [list, setList] = useState(read)
  useEffect(() => { const on = () => setList(read()); window.addEventListener('ruyix:worlds', on); on(); return () => window.removeEventListener('ruyix:worlds', on) }, [])
  return list
}
