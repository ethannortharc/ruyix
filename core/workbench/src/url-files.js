// Files the viewer shows by their own links (docs/design/studio.md: a studio's materials) — this page's own links only.
// No React here: checked in node (viewer-check.mjs).

/** A link of this page's own (a path here, or this origin) — never another site's (`//host/…` is one). */
export const sameOrigin = (url, here = globalThis.location?.href || 'http://here.invalid/') => {
  try { return new URL(url, here).origin === new URL(here).origin } catch { return false }
}

const EXT_OF = { image: 'png', markdown: 'md', pdf: 'pdf', text: 'txt', video: 'mp4', audio: 'mp3' }
/**
 * Files by their own links (same-origin; a studio's materials): [{ url, name, kind? }] → { names (what the viewer lists:
 * the name, made to say its kind and to be one of its own), source }. Shown only: no comments, no edits.
 */
export function urlFiles(list = [], fetchFn = (...a) => fetch(...a)) {
  const names = [], byName = new Map()
  for (const [i, f] of list.entries()) {
    let name = String(f?.name || `file-${i + 1}`).replace(/[\\/]/g, '-').slice(0, 120)
    if (f?.kind && EXT_OF[f.kind] && !/\.[a-z0-9]{1,5}$/i.test(name)) name = `${name}.${EXT_OF[f.kind]}`
    if (byName.has(name)) name = `${i + 1}-${name}`
    names.push(name); byName.set(name, String(f?.url || ''))
  }
  const url = name => byName.get(name) || ''
  const source = {
    key: `urls:${names.join('|')}`, url: name => url(name),
    fileAt: async name => {
      const r = await fetchFn(url(name))
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      const text = await r.text(), size = text.length
      // Home/material routes deliberately serve SVG as text; <img> needs its inert image representation.
      if (/\.svg$/i.test(name) || /^image\/svg\+xml(?:;|$)/i.test(r.headers?.get?.('content-type') || '')) return { image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, size }
      return { text, size }
    },
    pageOf: () => Promise.reject(new Error('a web page is shown here only from a run or a session')),
  }
  return { names, source }
}
