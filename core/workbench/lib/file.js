// A run's artifact file over HTTP, for the panel's <img>, <video> and <audio>: streamed, with Range (a video can be
// scrubbed), and only what the ledger names — the caller resolves the path from a ledger entry, never from the request.
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { mimeOf } from './subject.js'

/**
 * A file or folder of the home folder, for the person's viewer (open_file): `~/…`, a path in it, or one relative to it —
 * inside it (links followed, then checked), nothing hidden on the way (no dot-folder: keys, settings, the box's own).
 * → { full, rel, dir } — or it throws (code noFile | outside | hidden)
 */
export function homeEntry(p, home = homedir()) {
  const s = String(p || '').trim()
  const want = s === '~' ? home : s.startsWith('~/') ? join(home, s.slice(2)) : isAbsolute(s) ? s : join(home, s)
  const fail = (code, message) => Object.assign(new Error(message), { code })
  let full, root
  try { full = realpathSync(want); root = realpathSync(home) } catch { throw fail('noFile', `no such file or folder: ${s}`) }
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw fail('outside', 'only what is in the home folder opens here')
  if (rel.split(sep).some(x => x.startsWith('.'))) throw fail('hidden', 'a hidden file or folder does not open here')
  return { full, rel, dir: statSync(full).isDirectory() }
}

/** "bytes=a-b" | "bytes=a-" | "bytes=-n" against a size → { start, end } (inclusive), null (no usable header: send it all) or false (not satisfiable). */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start, end
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1 } else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
  return start > end || start >= size ? false : { start, end }
}

// Types a browser would run if opened on its own: shown as plain text (and every answer is sandboxed anyway).
const ACTIVE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml)$/

/**
 * → a Response for the file at `path`: 200, 206 for a satisfiable Range, 416 for one that is not.
 * `name` is the file's own name (the type comes from it); `download` asks the browser to save it.
 */
export function fileResponse(path, { name, range, download = false } = {}) {
  let size
  try { const st = statSync(path); if (!st.isFile()) throw new Error('not a file'); size = st.size } catch { return Response.json({ error: 'the file is gone' }, { status: 404 }) }
  const wanted = mimeOf(name || path)
  const type = ACTIVE.test(wanted) ? 'text/plain' : wanted
  const base = {
    'content-type': /^(text|application\/json)/.test(type) ? `${type}; charset=utf-8` : type,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    // whatever the file is, opening it in a tab runs nothing
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'",
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(String(name || 'file').replace(/[\r\n]/g, ' '))}`,
    'cache-control': 'private, max-age=3600',
  }
  const r = parseRange(range, size)
  if (r === false) return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } })
  const [from, to] = r ? [r.start, r.end] : [0, size - 1]
  if (!size) return new Response(null, { status: 200, headers: { ...base, 'content-length': '0' } })
  return new Response(Readable.toWeb(createReadStream(path, { start: from, end: to })), {
    status: r ? 206 : 200,
    headers: { ...base, 'content-length': String(to - from + 1), ...(r && { 'content-range': `bytes ${from}-${to}/${size}` }) },
  })
}
