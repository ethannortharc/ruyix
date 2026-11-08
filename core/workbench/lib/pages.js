// A web page of a run's folder, ready for the viewer's frame (src/viewer.jsx). The frame runs the page's own scripts
// with no origin of its own (sandbox without allow-same-origin): it cannot reach dsh, the person's sign-in or the page
// around it — and so it cannot fetch the files next to it either. Those its HTML names (<link>, <script>, <img>,
// <source>, <video>, <audio>, <track>, CSS url()) go in as data: URLs, within a size limit each and in all; a
// reference out of the folder, through a link, to the network or past the limit stays as it is (a public URL loads,
// nothing of dsh's does).
import { readFileSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { mimeOf } from './subject.js'
import { relPath } from './versions.js'
import { workPath } from './review.js'

export const LIMITS = { html: 4 << 20, file: 4 << 20, total: 24 << 20, depth: 32 }
const coded = (code, message, params = {}) => Object.assign(new Error(message), { code, params })
// what the general table does not say for a page's own files (a script, a stylesheet, a font)
const WEB = { css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', ico: 'image/x-icon', avif: 'image/avif', wasm: 'application/wasm' }
const typeOf = p => WEB[p.split('.').pop().toLowerCase()] || mimeOf(p)
const external = ref => !ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref.trim())

/** → { html, inlined: [paths], left: [references to the folder's files kept as they were: too big, outside it, through a link] } */
export function pageOf(run, path) {
  const rel = relPath(path), full = rel && workPath(run, rel)
  if (!full) throw coded('noFile', `${path} is not in the run's folder`, { path })
  if (statSync(full).size > LIMITS.html) throw coded('tooBig', `${rel} is over ${LIMITS.html >> 20} MB`, { path: rel })
  let total = 0, encoded = 0
  const inlined = [], left = [], expanding = new Set()
  const dataOf = (ref, from) => {
    if (external(ref)) return null
    let target
    try { target = relPath(posix.join(from, decodeURIComponent(ref.trim().split(/[?#]/)[0]))) } catch { target = null }
    const file = target && workPath(run, target)
    const size = file ? statSync(file).size : 0
    if (!file || expanding.has(target) || expanding.size >= LIMITS.depth || size > LIMITS.file || total + size > LIMITS.total) { left.push(ref); return null }
    total += size
    let body = readFileSync(file)
    const mime = typeOf(target), includedAt = inlined.length
    if (mime === 'text/css') {
      expanding.add(target)
      try { body = Buffer.from(css(body.toString('utf8'), posix.dirname(target))) } finally { expanding.delete(target) }
    }
    const prefix = `data:${mime};base64,`, sizeOf = prefix.length + 4 * Math.ceil(body.length / 3)
    if (encoded + sizeOf > LIMITS.total) { inlined.splice(includedAt); left.push(ref); return null }
    encoded += sizeOf
    inlined.splice(includedAt, 0, target)
    return prefix + body.toString('base64')
  }
  const css = (text, from) => text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, ref) => { const d = dataOf(ref, from); return d ? `url("${d}")` : m })
  const base = posix.dirname(rel)
  let html = readFileSync(full, 'utf8')
  html = html.replace(/(<(?:link|script|img|source|video|audio|track)\b[^>]*?\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, ref) => { const d = dataOf(ref, base); return d ? `${pre}${q}${d}${q}` : m })
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, text, b) => a + css(text, base) + b)
  html = html.replace(/(\sstyle\s*=\s*)(["'])([^"']*url\([^"']*)\2/gi, (m, pre, q, text) => pre + q + css(text, base) + q)
  return { html, inlined, left }
}
