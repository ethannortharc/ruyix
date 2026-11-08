// A 公众号 article: its Markdown as HTML a person pastes into the editor. The editor drops <style> and class names, so
// every element carries its style inline (Plume did it with marked + juice; this is the same look, written out). The
// Markdown it reads: headings, paragraphs, **bold**, *italic*, `code`, fenced code, lists, quotes, rules, tables, links
// and images — what an agent writes for an article.

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const CJK = /[⺀-鿿＀-￯]/
const SAFE_HREF = /^https?:\/\/[^\s"'<>`]+$/i
const SAFE_SRC = /^(https?:\/\/[^\s"'<>`]+|data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+)$/i
/** The styles, by tag; `a`: the accent colour. */
export const styles = a => ({
  section: 'font-size:16px;line-height:1.8;color:#333;letter-spacing:0.5px;word-break:break-word;',
  h1: 'font-size:22px;font-weight:bold;margin:1.2em 0 0.8em;',
  h2: `font-size:18px;font-weight:bold;margin:1.6em 0 0.8em;padding-left:10px;border-left:4px solid ${a};`,
  h3: `font-size:16px;font-weight:bold;margin:1.4em 0 0.6em;color:${a};`,
  h4: 'font-size:16px;font-weight:bold;margin:1.2em 0 0.5em;',
  p: 'margin:0 0 1em;',
  strong: `color:${a};font-weight:bold;`,
  em: 'font-style:italic;',
  a: `color:${a};text-decoration:none;border-bottom:1px solid ${a};`,
  blockquote: 'margin:1em 0;padding:10px 14px;background:#f7f7f7;border-left:3px solid #ccc;color:#666;',
  ul: 'margin:0 0 1em;padding-left:1.4em;', ol: 'margin:0 0 1em;padding-left:1.4em;', li: 'margin:0.3em 0;',
  code: 'font-family:Menlo,Consolas,monospace;font-size:14px;background:#f3f3f3;padding:2px 4px;border-radius:3px;color:#c7254e;',
  pre: 'background:#f6f8fa;padding:12px;border-radius:6px;overflow-x:auto;margin:0 0 1em;',
  precode: 'font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.6;color:#333;',
  img: 'max-width:100%;display:block;margin:1em auto;border-radius:4px;',
  hr: 'border:none;border-top:1px solid #eee;margin:2em 0;',
  table: 'border-collapse:collapse;width:100%;margin:0 0 1em;font-size:14px;',
  th: 'border:1px solid #ddd;padding:6px 10px;background:#f7f7f7;', td: 'border:1px solid #ddd;padding:6px 10px;',
})

/**
 * One line's inline Markdown → HTML, in one pass from left to right: code, images, links, **bold**, *italic*, and text —
 * each piece escaped as it is taken, never a pattern run over HTML already made (what an agent wrote stays text: no
 * markup, no attribute of its own). A link's text may hold bold and italic, not another link or an image.
 */
export function inline(text, st, { links = true } = {}) {
  const s = String(text ?? '')
  let out = ''
  for (let i = 0; i < s.length;) {
    const rest = s.slice(i)
    let m
    if (s[i] === '`' && (m = /^`([^`]+)`/.exec(rest))) { out += `<code style="${st.code}">${esc(m[1])}</code>`; i += m[0].length; continue }
    if (links && (m = /^!\[([^\][]*)\]\(([^()\s]+)\)/.exec(rest))) {
      out += SAFE_SRC.test(m[2]) ? `<img src="${esc(m[2])}" alt="${esc(m[1])}" style="${st.img}">` : esc(m[1])
      i += m[0].length; continue
    }
    if (links && (m = /^\[([^\][]+)\]\(([^()\s]+)\)/.exec(rest))) {
      const t = inline(m[1], st, { links: false })
      out += SAFE_HREF.test(m[2]) ? `<a href="${esc(m[2])}" style="${st.a}">${t}</a>` : t
      i += m[0].length; continue
    }
    if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) { out += `<strong style="${st.strong}">${inline(m[2], st, { links })}</strong>`; i += m[0].length; continue }
    if ((m = /^\*(?=[^*\s])([^*]*[^*\s])\*(?!\*)/.exec(rest))) { out += `<em style="${st.em}">${inline(m[1], st, { links })}</em>`; i += m[0].length; continue }
    // plain text up to the next character that may start something
    const n = rest.slice(1).search(/[`![*_]/)
    const take = n < 0 ? rest : rest.slice(0, n + 1)
    out += esc(take)
    i += take.length
  }
  return out
}
/** Lines of one paragraph, joined: no space between two CJK characters. */
const join = lines => lines.map(l => l.trim()).reduce((acc, l) => (!acc ? l : CJK.test(acc.at(-1)) && CJK.test(l[0]) ? acc + l : `${acc} ${l}`), '')
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

/** Markdown → the article's HTML, every style inline. opts.accent: the colour of headings, bold and links. */
export function renderArticle(md, { accent = '#d4380d' } = {}) {
  const st = styles(accent)
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      const body = []
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i])
      i++
      out.push(`<pre style="${st.pre}"><code style="${st.precode}">${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (h) { const n = Math.min(h[1].length, 4); out.push(`<h${n} style="${st[`h${n}`]}">${inline(h[2], st)}</h${n}>`); i++; continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(`<hr style="${st.hr}">`); i++; continue }
    if (/^\s*>/.test(line)) {
      const q = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''))
      const paras = q.join('\n').split(/\n\s*\n/).map(p => `<p style="margin:0;">${inline(join(p.split('\n')), st)}</p>`)
      out.push(`<blockquote style="${st.blockquote}">${paras.join('')}</blockquote>`)
      continue
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/
    if (item.test(line)) {
      const ordered = !!line.match(item)[2], items = []
      for (; i < lines.length; i++) {
        const m = lines[i].match(item)
        if (m && !!m[2] === ordered) items.push([m[3]])
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items.at(-1).push(lines[i])
        else break
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag} style="${st[tag]}">${items.map(t => `<li style="${st.li}">${inline(join(t), st)}</li>`).join('')}</${tag}>`)
      continue
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      const head = cells(line), rows = []
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]))
      out.push(`<table style="${st.table}"><thead><tr>${head.map(c => `<th style="${st.th}">${inline(c, st)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td style="${st.td}">${inline(c, st)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const para = []
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*(```|~~~)|\s*([-*+]|\d+[.)])\s)/.test(lines[i]); i++) para.push(lines[i])
    if (!para.length) { para.push(line); i++ }
    out.push(`<p style="${st.p}">${inline(join(para), st)}</p>`)
  }
  return `<section style="${st.section}">${out.join('')}</section>`
}
