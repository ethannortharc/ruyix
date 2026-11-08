#!/usr/bin/env node
// This Ruyix's web search and page fetching for a CLI agent (Claude Code, Codex, pi): an MCP stdio server whose two
// tools ask Ruyix (lib/serve.js, over its Unix socket) — the services set in Settings → 搜索, the same every agent uses.
// env: RUYIX_WEB_SOCK.
import { pathToFileURL } from 'node:url'
import { createConnection } from 'node:net'
import { realpathSync } from 'node:fs'

let conn = null, buf = '', seq = 0
const pending = new Map()
function ask(op, args = {}) {
  if (!conn) {
    conn = createConnection(process.env.RUYIX_WEB_SOCK || '')
    conn.setEncoding('utf8')
    conn.on('data', c => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        const p = pending.get(m.id)
        if (p) { pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error), { code: m.code })) : p.resolve(m.result) }
      }
    })
    const lost = err => { for (const p of pending.values()) p.reject(new Error(`Ruyix's search does not answer${err ? `: ${err.message}` : ''}`)); pending.clear(); conn = null }
    conn.on('error', lost); conn.on('close', () => lost())
  }
  const id = ++seq
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); conn.write(`${JSON.stringify({ id, op, ...args })}\n`) })
}

/** A page's HTML as readable text: scripts and styles out, blocks on their own lines, links kept as [text](url). */
export function htmlText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => { const t = text.replace(/<[^>]+>/g, '').trim(); return t ? `[${t}](${href})` : '' })
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `).replace(/<li[^>]*>/gi, '\n- ').replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/ul|\/ol|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
const MAX_TEXT = 60000

const s = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
export const TOOLS = [
  { name: 'web_search', description: 'Search the web with the search service this Ruyix is set up with (DeepSeek, Tavily, 博查, Exa or Brave — Settings → 搜索). queries: 1–4 searches run together; each result is a title, its URL, a summary and a date. Follow up with web_fetch for a page\'s full text; cite the URLs you use.', inputSchema: s({ queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 } }, ['queries']),
    async run({ queries }) {
      const qs = [...new Set((queries || []).map(q => String(q).trim()).filter(Boolean))].slice(0, 4)
      if (!qs.length) throw new Error('give 1–4 searches')
      const out = await Promise.all(qs.map(q => ask('search', { query: q, maxResults: 8 }).then(r => ({ q, r }), err => ({ q, err }))))
      return out.map(({ q, r, err }) => [`## ${q}`, err ? `(failed: ${err.message})` : [r.content && `Answer: ${r.content}`, ...r.sources.map((x, i) => `${i + 1}. ${x.title || x.url}\n   ${x.url}${x.publishedAt ? ` · ${x.publishedAt.slice(0, 10)}` : ''}${x.snippet ? `\n   ${x.snippet.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`)].filter(Boolean).join('\n')].join('\n')).join('\n\n')
    } },
  { name: 'web_fetch', description: 'Open one web page (http/https) and read its text — directly, or through the reader services this Ruyix is set up with when a page needs them. This machine and private networks cannot be opened. Cite the URL when you use its content.', inputSchema: s({ url: { type: 'string' } }, ['url']),
    async run({ url }) {
      const r = await ask('fetch', { url })
      const text = r.body.kind === 'html' ? htmlText(r.body.content) : r.body.content
      return `${r.url} (HTTP ${r.statusCode})\n\n${text.slice(0, MAX_TEXT)}${text.length > MAX_TEXT || r.truncated ? '\n\n[… cut: the page goes on]' : ''}`
    } },
]

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)
async function handle(m) {
  switch (m.method) {
    case 'initialize': return { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ruyix-web', version: '0.1.0' } }
    case 'ping': return {}
    case 'tools/list': return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === m.params?.name)
      if (!tool) return { content: [{ type: 'text', text: `no tool ${m.params?.name}` }], isError: true }
      try { return { content: [{ type: 'text', text: String(await tool.run(m.params?.arguments || {})) }] } } catch (err) { return { content: [{ type: 'text', text: `${tool.name}: ${err.message}` }], isError: true } }
    }
    default: throw Object.assign(new Error(`method not found: ${m.method}`), { code: -32601 })
  }
}
let mainUrl = ''
try { if (process.argv[1]) mainUrl = pathToFileURL(realpathSync(process.argv[1])).href } catch { /* a host's argv[1] need not be a file */ }
if (import.meta.url === mainUrl) {
  let inBuf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', c => {
    inBuf += c
    let i
    while ((i = inBuf.indexOf('\n')) >= 0) {
      const line = inBuf.slice(0, i).trim(); inBuf = inBuf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.id === undefined) continue
      handle(m).then(result => send({ jsonrpc: '2.0', id: m.id, result }), err => send({ jsonrpc: '2.0', id: m.id, error: { code: err.code || -32603, message: err.message } }))
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
