// What the page shows or copies of an article: only the tags and attributes the article renderer makes (lib/article.js),
// on an inert document — never the page's own. A second guard: the renderer escapes what was written already.
const TAGS = new Set(['SECTION', 'H1', 'H2', 'H3', 'H4', 'P', 'STRONG', 'EM', 'A', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'CODE', 'PRE', 'IMG', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'SPAN'])
const HREF = /^https?:\/\//i, SRC = /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp);base64,)/i
export function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${String(html || '')}</body>`, 'text/html')
  const walk = el => {
    for (const c of [...el.children]) {
      if (!TAGS.has(c.tagName)) { c.remove(); continue }
      for (const a of [...c.attributes]) {
        const n = a.name.toLowerCase()
        const ok = n === 'style' || n === 'alt' || (n === 'href' && c.tagName === 'A' && HREF.test(a.value)) || (n === 'src' && c.tagName === 'IMG' && SRC.test(a.value))
        if (!ok) c.removeAttribute(a.name)
      }
      walk(c)
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}
/** The article as a page of its own for a sandboxed frame (no scripts, no access to this page). */
export const framePage = html => `<!doctype html><meta charset="utf-8"><base target="_blank"><body style="margin:0;padding:12px 14px;background:#fff">${cleanHtml(html)}</body>`
