// Files and formats owned by Newsletter. Sources are captured by the research agent; this module never fetches URLs.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export function pathIn(run, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('\\') || name.split('/').some(s => !s || s === '..' || s.startsWith('.'))) throw new Error(`Unsafe newsletter path: ${name}`)
  const root = realpathSync(run.folder || run.dir), full = join(root, name)
  let parent = dirname(full)
  while (!existsSync(parent)) parent = dirname(parent)
  const real = realpathSync(parent), rel = relative(root, real)
  if (rel.startsWith('..') || isAbsolute(rel) || real !== parent || lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Newsletter file must stay inside its run: ${name}`)
  return full
}
export function readText(run, name) {
  const path = pathIn(run, name), st = lstatSync(path)
  if (!st.isFile() || st.size > 2 * 1024 * 1024) throw new Error(`${name}: expected a text file no larger than 2 MiB`)
  return readFileSync(path, 'utf8')
}
export function readJSON(run, name) {
  try { return JSON.parse(readText(run, name)) } catch (error) { throw new Error(`${name}: ${error.message}`) }
}
export function writeText(run, name, text) {
  const path = pathIn(run, name)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(temp, text, { flag: 'wx' }); renameSync(temp, path) } finally { rmSync(temp, { force: true }) }
}
export const writeJSON = (run, name, data) => writeText(run, name, JSON.stringify(data, null, 2) + '\n')
const requireText = (value, label, max = 5000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}: nonempty text, at most ${max} characters`)
  return value.trim()
}
export function canonicalURL(input) {
  let url
  try { url = new URL(input) } catch { throw new Error(`Invalid source URL: ${input}`) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Sources must use http(s) URLs without credentials')
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key)
  url.searchParams.sort()
  return url.href
}
const iso = (s, label) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s)) || Date.parse(s) > Date.now() + 300000) throw new Error(`${label}: an actual ISO retrieval timestamp, not a future date`)
  return s
}
/** A supplied document is bound to the engine's immutable attachment manifest, never an arbitrary local path. */
function documentSource(raw, run) {
  if (raw.url) throw new Error('A source uses either url or attachment, not both')
  const attachment = (run.subject?.attachments || []).find(a => a.artifact === raw.attachment)
  if (!attachment) throw new Error('Unknown source attachment: choose a supplied document artifact')
  const root = realpathSync(run.dir), rel = relative(resolve(run.dir), attachment.path || '')
  const full = join(root, rel)
  if (!rel.startsWith(`attachments${sep}`) || rel.split(sep).includes('..') || realpathSync(full) !== full || lstatSync(full).isSymbolicLink()) throw new Error('Source attachment must stay inside the run attachments folder')
  const stat = lstatSync(full)
  if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('Source attachment must be a file no larger than 25 MiB')
  const digest = sha256(readFileSync(full))
  if (digest !== attachment.sha256) throw new Error('Source attachment changed since intake: start a new issue with the updated document')
  return { attachment: attachment.artifact, documentName: attachment.name, documentSha256: digest }
}
/** Normalize before outlining, so every later citation refers to deduplicated, stable S1… identifiers. */
export function normalizeSources(input, run) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 80) throw new Error('sources.json: 1–80 source records required')
  const seen = new Set(), out = []
  for (const raw of input) {
    const origin = raw?.attachment ? documentSource(raw, run) : { url: canonicalURL(raw?.url) }
    const key = origin.attachment ? `attachment:${origin.attachment}` : origin.url
    if (seen.has(key)) continue
    const evidencePath = requireText(raw.evidencePath, 'evidencePath', 200)
    if (!/^research\/sources\/[a-zA-Z0-9_-]+\.(md|txt)$/.test(evidencePath)) throw new Error('evidencePath must name research/sources/<name>.md or .txt')
    const captured = readText(run, evidencePath)
    if (captured.trim().length < 80) throw new Error(`${evidencePath}: capture useful source text, not only its URL`)
    const summary = requireText(raw.summary, 'source summary', 4000)
    const quotes = raw.quotes
    if (!Array.isArray(quotes) || !quotes.length || quotes.length > 12 || quotes.some(q => typeof q !== 'string' || !q.trim() || !captured.includes(q))) throw new Error(`${evidencePath}: 1–12 exact evidence quotes must occur in the captured source text`)
    if (!['primary', 'secondary'].includes(raw.kind)) throw new Error('source kind is primary or secondary')
    const accessedAt = iso(raw.accessedAt, 'accessedAt')
    if (raw.publishedAt != null && (typeof raw.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.publishedAt) || !Number.isFinite(Date.parse(raw.publishedAt)))) throw new Error('publishedAt: YYYY-MM-DD when the publisher provides it, otherwise null')
    out.push({ id: `S${out.length + 1}`, title: requireText(raw.title, 'source title', 300), ...origin, publisher: requireText(raw.publisher, 'publisher', 200), kind: raw.kind, publishedAt: raw.publishedAt || null, accessedAt, evidencePath, evidenceSha256: sha256(captured), summary, quotes })
    seen.add(key)
  }
  return out
}
export function sourceSet(run) {
  const sources = readJSON(run, 'research/sources.json')
  if (!Array.isArray(sources) || !sources.length) throw new Error('Research sources are missing')
  const normalized = normalizeSources(sources, run)
  if (!run.newsletter?.researchDigest || sha256(JSON.stringify(sources)) !== run.newsletter.researchDigest || sources.length !== normalized.length || JSON.stringify(sources) !== JSON.stringify(normalized)) throw new Error('Research source manifest or captured evidence changed: run research again')
  return sources
}
export const citations = text => [...new Set([...text.matchAll(/\[(S\d+)\]/g)].map(m => m[1]))]
// One parser defines both audit coverage and export boundaries, including adjacent Markdown blocks.
function markdownBlocks(text) {
  const result = [], lines = text.replace(/\r\n/g, '\n').trim().split('\n')
  const typeOf = line => /^(#{1,6}) +\S/.test(line) ? 'heading' : /^\s*[-*] +\S/.test(line) ? 'ul' : /^\s*\d+\. +\S/.test(line) ? 'ol' : 'paragraph'
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue }
    const type = typeOf(lines[i]), start = i++
    if (type !== 'heading') while (i < lines.length && lines[i].trim() && typeOf(lines[i]) === type) i++
    result.push({ type, text: lines.slice(start, i).join('\n') })
  }
  return result
}
export const proseBlocks = text => markdownBlocks(text).filter(b => b.type !== 'heading').map(b => b.text)

export function edition(run) {
  const sources = sourceSet(run), draft = readText(run, 'draft.md'), meta = readJSON(run, 'issue.json')
  if (!/^# [^\n]+\n/.test(draft) || draft.trim().length < 100 || draft.length > 100000) throw new Error('draft.md needs a title and a complete article (100–100000 characters)')
  if (!proseBlocks(draft).length) throw new Error('draft.md needs substantive prose, not only headings')
  if (/\b(?:TODO|TBD)\b|【待补充|\[INSERT\b/i.test(draft)) throw new Error('Resolve draft placeholders before review')
  const ids = new Set(sources.map(s => s.id)), used = citations(draft)
  if (!used.length || used.some(id => !ids.has(id))) throw new Error('draft.md must cite known sources as [S1], [S2], …')
  // A constrained, readable Markdown subset makes the HTML/plain-text export predictable and avoids active markup.
  if (/```|^\|.*\|\s*$|!\[|\]\(|<\/?[a-z][^>]*>/im.test(draft)) throw new Error('Use headings, paragraphs, lists, **bold**, *emphasis*, and [S1] citations; raw HTML, links, images, tables and code blocks are not supported')
  const metadata = { subject: requireText(meta?.subject, 'email subject', 180), preheader: requireText(meta?.preheader, 'preheader', 300), language: requireText(meta?.language, 'language', 40) }
  if (Object.values(metadata).some(s => /[\r\n]/.test(s))) throw new Error('Issue metadata must stay on a single line')
  return { draft, metadata, sources, digest: sha256(JSON.stringify({ draft, metadata, sources })) }
}
export function validateOutline(run) {
  const sources = sourceSet(run), text = readText(run, 'outline.md'), ids = new Set(sources.map(s => s.id)), used = citations(text)
  if (text.trim().length < 80 || !used.length || used.some(id => !ids.has(id))) throw new Error('outline.md: a substantive outline with known [S1] citations is required')
  return text
}
/** Exact block coverage is mechanical; semantic support remains the independent reviewer's judgment. */
export function validateAudit(result, item) {
  requireText(result?.summary, 'audit summary')
  const blocks = proseBlocks(item.draft), audit = result?.blocks, known = new Set(item.sources.map(s => s.id))
  if (!blocks.length) throw new Error('An evidence audit needs at least one substantive prose block')
  if (!Array.isArray(audit) || audit.length !== blocks.length) throw new Error(`audit.blocks must cover all ${blocks.length} prose blocks in order, verbatim`)
  for (const [i, block] of audit.entries()) {
    if (block.text !== blocks[i]) throw new Error(`audit.blocks[${i}].text must exactly match the draft's paragraph/list block`)
    if (!['fact', 'analysis', 'opinion', 'transition'].includes(block.classification) || !['supported', 'qualified', 'unsupported'].includes(block.verdict)) throw new Error(`audit.blocks[${i}]: invalid classification/verdict`)
    if (!Array.isArray(block.sourceIds) || block.sourceIds.some(id => !known.has(id))) throw new Error(`audit.blocks[${i}]: use known sourceIds`)
    const cited = citations(block.text)
    if (cited.some(id => !block.sourceIds.includes(id))) throw new Error(`audit.blocks[${i}]: check every citation`)
    if (block.classification === 'fact' && (!cited.length || !block.sourceIds.length)) throw new Error(`audit.blocks[${i}]: factual paragraphs need citations`)
    requireText(block.reason, `audit.blocks[${i}].reason`, 3000)
  }
  if (!Array.isArray(result.warnings) || result.warnings.some(w => typeof w !== 'string')) throw new Error('audit.warnings must be a list of strings (may be empty)')
  return { summary: result.summary, blocks: audit, warnings: result.warnings, passed: audit.every(b => b.verdict !== 'unsupported') }
}
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const inline = text => escape(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\[(S\d+)\]/g, '<a href="#source-$1" style="color:#176456">[$1]</a>')
export function renderHTML(item) {
  const blocks = markdownBlocks(item.draft).map(({ type, text }) => {
    if (type === 'heading') {
      const [, marks, title] = /^(#{1,6}) +(.+)$/.exec(text)
      return `<h${marks.length} style="line-height:1.25;margin:28px 0 14px">${inline(title)}</h${marks.length}>`
    }
    if (type === 'ul' || type === 'ol') return `<${type}${type === 'ol' ? ` start="${/^\s*(\d+)/.exec(text)[1]}"` : ''} style="padding-left:24px">${text.split('\n').map(line => `<li style="margin-bottom:8px">${inline(line.replace(/^\s*(?:[-*]|\d+\.) +/, ''))}</li>`).join('')}</${type}>`
    return `<p style="margin:0 0 18px">${inline(text).replace(/\n/g, '<br>')}</p>`
  }).join('\n')
  const used = new Set(citations(item.draft)), sources = item.sources.filter(s => used.has(s.id))
  return `<!doctype html>\n<html lang="${escape(item.metadata.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(item.metadata.subject)}</title></head><body style="margin:0;background:#f4f1e9;color:#222b27;font:17px/1.65 Georgia,serif"><div style="display:none;max-height:0;overflow:hidden">${escape(item.metadata.preheader)}</div><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:28px 16px"><main style="max-width:660px;margin:auto;background:#fffdf8;padding:32px;overflow-wrap:anywhere;border-top:4px solid #176456">${blocks}<hr style="border:0;border-top:1px solid #d8ddd7;margin:32px 0"><h2 style="font-size:20px">${/^zh|中文|简体/i.test(item.metadata.language) ? '来源' : 'Sources'}</h2><ol style="font:13px/1.6 system-ui,sans-serif;padding-left:24px">${sources.map(s => `<li id="source-${s.id}" style="margin-bottom:10px">[${s.id}] ${s.url ? `<a href="${escape(s.url)}" style="color:#176456">${escape(s.title)}</a>` : `${escape(s.title)} · ${escape(s.documentName)} (supplied document; SHA-256 ${s.documentSha256})`} — ${escape(s.publisher)}${s.publishedAt ? ` · ${escape(s.publishedAt)}` : ''}</li>`).join('')}</ol></main></td></tr></table></body></html>\n`
}
const sourceHeading = item => /^zh|中文|简体/i.test(item.metadata.language) ? '来源' : 'Sources'
const citedSources = item => { const used = new Set(citations(item.draft)); return item.sources.filter(s => used.has(s.id)) }
// Source titles come from retrieved pages: preserve them as text, never Markdown/HTML authored by the source.
const markdownText = text => escape(String(text).replace(/[\r\n]/g, ' ')).replace(/[\\`*_[\]{}()#+.!|~-]/g, '\\$&')
export function renderMarkdown(item) {
  return `${item.draft.trim()}\n\n## ${sourceHeading(item)}\n\n${citedSources(item).map(s => `- [${s.id}] ${markdownText(s.title)} — ${s.url ? `<${s.url.replace(/&/g, '&amp;')}>` : `${markdownText(s.documentName)} (supplied document; SHA-256 ${s.documentSha256})`}${s.publishedAt ? ` (${s.publishedAt})` : ''}`).join('\n')}\n`
}
export function renderPlain(item) {
  const body = item.draft.trim().replace(/^#{1,6}\s/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
  return `${body}\n\n${sourceHeading(item)}\n\n${citedSources(item).map(s => `- [${s.id}] ${s.title.replace(/[\r\n]/g, ' ')} — ${s.url || `${s.documentName} (supplied document; SHA-256 ${s.documentSha256})`}${s.publishedAt ? ` (${s.publishedAt})` : ''}`).join('\n')}\n`
}
/** A derived preview must show the exact bytes the exporter will produce. Missing previews need regeneration. */
export function previewMatches(run, item) {
  try { return readText(run, 'preview.html') === renderHTML(item) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
export function keepFile(w, path) {
  const full = readText(w.run, path)
  return w.evidence({ kind: 'file', title: path, input: { path, bytes: Buffer.byteLength(full) }, output: full.slice(0, 1500), full, name: path.split('/').pop(), ok: true })
}
export function exportEdition(w) {
  const item = edition(w.run)
  if (w.run.newsletter?.approvedDigest !== item.digest) throw new Error('The issue changed after approval: review the current files before export')
  if (!previewMatches(w.run, item)) throw new Error('The HTML preview changed after approval: regenerate and review it before export; edit draft.md or issue.json for content changes')
  const audit = readJSON(w.run, 'quality.json')
  if (audit.digest !== item.digest || !validateAudit(audit, item).passed) throw new Error('The evidence audit is stale or contains unsupported claims')
  const outputs = { 'exports/newsletter.md': renderMarkdown(item), 'exports/newsletter.txt': renderPlain(item), 'exports/newsletter.html': renderHTML(item) }
  const manifest = { version: 1, runId: w.run.id, title: item.metadata.subject, ...item.metadata, approvedDigest: item.digest, exportedAt: new Date().toISOString(), delivery: 'not-sent', sourceCount: item.sources.length, files: Object.entries(outputs).map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) })) }
  for (const [path, bytes] of Object.entries(outputs)) { writeText(w.run, path, bytes); keepFile(w, path) }
  writeJSON(w.run, 'exports/manifest.json', manifest); keepFile(w, 'exports/manifest.json')
  return manifest
}
