// A session's events as the page and the main agent read them (sessions.js writes them): no Node here, the page takes it too.

/**
 * A turn's answer that no message of its own carried (a CLI may give it only in its end): shown as said, before the end.
 * → the events with those answers in
 */
export function withAnswers(events) {
  const out = []
  let said = null
  for (const e of events) {
    if (e.type === 'user/message') said = null
    if (e.type === 'assistant/message') said = (e.data?.message?.content || []).map(c => c.text || '').join('').trim()
    if (e.type === 'turn/end' && e.data?.output && e.data.output.trim() !== said) out.push({ ...e, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: e.data.output }] } }, answer: true })
    out.push(e)
  }
  return out
}

/** The thing a tool call is about, short: a file's name, a command's start, an address's host and path, a query. */
export function targetOf(args) {
  let a = args
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { return '' } }
  if (!a || typeof a !== 'object') return ''
  const cut = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof a[k] === 'string' && a[k]) return a[k].split(/[\\/]/).filter(Boolean).pop() || a[k]
  if (typeof a.command === 'string' && a.command) return cut(a.command, 48)
  if (typeof a.url === 'string' && a.url) { try { const u = new URL(/^[a-z]+:/i.test(a.url) ? a.url : `https://${a.url}`); return cut(`${u.host}${u.pathname === '/' ? '' : u.pathname}`, 48) } catch { return cut(a.url, 48) } }
  for (const k of ['query', 'pattern', 'description', 'why', 'text', 'key', 'ref']) if (typeof a[k] === 'string' && a[k]) return cut(a[k], 48)
  return ''
}
/** A reply's first sentence (what a line shows of it). */
export function firstSentence(text, max = 80) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  const m = /^(.+?[。！？!?]|.+?\.(?=\s|$))/.exec(t)
  const s = (m ? m[1] : t).trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
/** A tool's name without its MCP server: mcp__ruyix-browser__browser_open → browser_open. */
export const toolName = name => String(name || '').replace(/^mcp__[^_]+(?:[-_][^_]+)*__/, '')
/**
 * One event of an agent's work as a line of the desk's lyric strip (agent-work.md §2), made by rule — no model call: a
 * tool call (its name and what it is about), the first sentence of a reply, a turn that failed. → { at, kind, tool?, arg?,
 * said? } (the page words it in the person's language) or null
 */
export function lineOf(e) {
  const d = e?.data || {}
  if (e?.type === 'tool/call') return { at: e.time, kind: 'tool', tool: toolName(d.name), arg: targetOf(d.arguments) }
  if (e?.type === 'assistant/message') { const said = firstSentence((d.message?.content || []).map(c => c.text || '').join('')); return said ? { at: e.time, kind: 'say', said } : null }
  if (e?.type === 'turn/end' && d.ok === false) return { at: e.time, kind: 'say', said: `✗ ${firstSentence(d.error, 60)}` }
  return null
}
export const LINES_KEPT = 6
