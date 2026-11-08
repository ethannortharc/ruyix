// The conversations as the workbench keeps them (<the workbench's home>/conversations.db; workbench's lib/conversations.js),
// read as they are — Ruyix running or not:
//   ruyix chat threads                            the conversations kept: id, kind, when last said, entries, title
//   ruyix chat export [--thread ID] [--out FILE]  one conversation as Markdown; without --thread, every conversation, their
//                                                 summaries and the memories as JSON lines
//   ruyix chat memories                           what the conversations came to remember: id, kind, pinned, words
// ruyix data export moves the file with the runs, from one machine or box to the next.
import { pathToFileURL } from 'node:url'
import { realpathSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { workbenchHome } from './ruyix-data.mjs'

const fail = message => Object.assign(new Error(message), { code: 'ruyixChat' })
const when = at => new Date(at).toISOString().slice(0, 16).replace('T', ' ')
const row = r => ({ ...JSON.parse(r.data), n: r.n, at: r.at, thread: r.thread })

export function openChat(home = homedir()) {
  const file = join(workbenchHome(home), 'conversations.db')
  if (!existsSync(file)) throw fail(`no conversations here (${file})`)
  return new DatabaseSync(file, { readOnly: true })
}
export const threads = db => db.prepare('SELECT t.id, t.kind, t.title, t.updated, count(e.n) AS entries FROM threads t LEFT JOIN entries e ON e.thread = t.id GROUP BY t.id ORDER BY t.updated DESC').all()
export const memories = db => db.prepare('SELECT id, kind, text, pinned, by, created FROM memories ORDER BY pinned DESC, created DESC').all()

/** Every conversation (its entries after it), the summaries, the memories: one JSON object a line, the sessions' state left out. */
export function* jsonl(db) {
  for (const t of db.prepare('SELECT * FROM threads ORDER BY created').iterate()) {
    const { lane: _lane, ...thread } = t
    yield JSON.stringify({ type: 'thread', ...thread })
    for (const e of db.prepare('SELECT * FROM entries WHERE thread = ? ORDER BY n').iterate(t.id)) yield JSON.stringify({ type: 'entry', ...row(e) })
  }
  for (const s of db.prepare('SELECT * FROM summaries ORDER BY id').iterate()) yield JSON.stringify({ type: 'summary', ...s })
  for (const m of db.prepare('SELECT * FROM memories ORDER BY id').iterate()) yield JSON.stringify({ type: 'memory', ...m })
}

/** One conversation as Markdown: what was said, the cards and what became of them. (The same as the workbench's exportThread: checked against it.) */
export function markdown(db, id) {
  const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(String(id))
  if (!t) throw fail(`no conversation ${id} (ruyix chat threads lists them)`)
  const out = [`# ${t.title || t.id}`, '', `${t.kind} · ${when(t.created)} → ${when(t.updated)}${t.agent ? ` · ${t.agent}` : ''}`, '']
  const done = o => (o ? ` — ${o.status}${o.run ? ` ${o.run}` : ''}` : '')
  for (const e of db.prepare('SELECT * FROM entries WHERE thread = ? ORDER BY n').iterate(t.id)) {
    const i = row(e)
    if (i.kind === 'user') out.push(`**You** · ${when(i.at)}`, '', i.text, '')
    else if (i.kind === 'text') out.push(`**Assistant** · ${when(i.at)}`, '', i.text, '')
    else if (i.kind === 'draft') out.push(`> Card: ${i.args?.title || ''} (${i.args?.workflow || ''})${done(i.outcome)}`, '')
    else if (i.kind === 'workflow') out.push(`> Workflow draft: ${i.args?.title || i.args?.id || ''}`, '')
    else if (i.kind === 'run') out.push(`> Run started: ${i.args?.run || ''} ${i.args?.title || ''}`.trimEnd(), '')
    else if (i.kind === 'change') out.push(`> Change proposed: ${i.args?.summary || ''}`, '')
    else if (i.kind === 'task') out.push(`> Background task: ${i.title} — ${i.status || ''}${i.result ? `\n>\n> ${String(i.result).replace(/\n/g, '\n> ')}` : ''}`, '')
    else if (i.kind === 'topic') out.push('---', '')
    else if (i.kind === 'error') out.push(`> ${i.text}`, '')
  }
  return out.join('\n')
}

let mainUrl = ''
try { if (process.argv[1]) mainUrl = pathToFileURL(realpathSync(process.argv[1])).href } catch { /* a host's argv[1] need not be a file */ }
if (import.meta.url === mainUrl) {
  const [cmd, ...rest] = process.argv.slice(2), opt = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined }
  try {
    if (cmd === 'threads') {
      const db = openChat()
      try { for (const t of threads(db)) console.log(`${t.id}\t${t.kind}\t${when(t.updated)}\t${t.entries}\t${t.title}`) } finally { db.close() }
    } else if (cmd === 'memories') {
      const db = openChat()
      try { for (const m of memories(db)) console.log(`${m.id}\t${m.kind}${m.pinned ? '\tpinned' : '\t'}\t${m.text.replace(/\s+/g, ' ')}`) } finally { db.close() }
    } else if (cmd === 'export') {
      const db = openChat(), id = opt('--thread')
      try {
        const out = opt('--out') || (id ? `${id.replace(/[^\w.-]+/g, '-')}.md` : `ruyix-conversations-${new Date().toISOString().slice(0, 10)}.jsonl`)
        writeFileSync(resolve(out), id ? markdown(db, id) : `${[...jsonl(db)].join('\n')}\n`)
        console.log(`  ✓ ${out}`)
      } finally { db.close() }
    } else {
      console.log('ruyix chat threads | memories | export [--thread ID] [--out FILE]')
      process.exit(cmd ? 2 : 0)
    }
  } catch (err) { console.error(`✗ ${err.message}`); process.exit(1) }
}
