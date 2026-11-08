// A unified diff as the page shows it: per file, its hunks, each line with its old and new line numbers, added lines green,
// removed lines red. Long unchanged stretches stay as Git cut them (three lines around a change).
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cx, useT } from './ui.jsx'

/** Unified diff text → [{ path, from, hunks: [{ head, lines: [{ type: add | del | ctx | note, text, a, b }] }], added, removed, binary }]. */
export function parseDiff(text) {
  const files = []
  let f = null, h = null, a = 0, b = 0
  const start = path => { f = { path, from: null, hunks: [], added: 0, removed: 0, binary: false }; files.push(f); h = null }
  for (const line of String(text || '').replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git ')) { const m = line.match(/ b\/(.*)$/); start(m ? m[1] : line.slice(11)); continue }
    if (!f) start('')
    if (line.startsWith('rename from ')) { f.from = line.slice(12); continue }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const p = line.slice(4)
      if (line.startsWith('+++ ') && p !== '/dev/null' && !f.path) f.path = p.replace(/^b\//, '')
      continue
    }
    if (/^(index |new file mode|deleted file mode|similarity index|rename to |old mode|new mode)/.test(line)) continue
    if (line.startsWith('Binary files')) { f.binary = true; continue }
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (m) { a = Number(m[1]); b = Number(m[2]); h = { head: m[3].trim(), lines: [] }; f.hunks.push(h); continue }
    if (!h) continue
    if (line.startsWith('+')) { h.lines.push({ type: 'add', text: line.slice(1), b: b++ }); f.added++ }
    else if (line.startsWith('-')) { h.lines.push({ type: 'del', text: line.slice(1), a: a++ }); f.removed++ }
    else if (line.startsWith('\\')) h.lines.push({ type: 'note', text: line.slice(2) })
    else if (line !== '' || h.lines.length) h.lines.push({ type: 'ctx', text: line.slice(1), a: a++, b: b++ })
  }
  return files.filter(x => x.path || x.hunks.length)
}

/** One file's change: its hunks (folded past `max` lines, unfolded on a click). `label`: the path shown, when the diff has none of its own. */
export function DiffFile({ file, label, max = 400 }) {
  const t = useT()
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState(true)
  let n = 0
  return (
    <div className="wb-diff-file">
      <button className="wb-diff-head" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="wb-mono">{label || file.path}{file.from && file.from !== file.path && <span className="wb-dim"> ← {file.from}</span>}</span>
        <span className="wb-diff-n"><b className="wb-c-green">+{file.added}</b> <b className="wb-c-red">−{file.removed}</b></span>
      </button>
      {open && (file.binary ? <div className="wb-diff-empty">{t('ver.binary')}</div> : !file.hunks.length ? <div className="wb-diff-empty">{t('ver.noLines')}</div> : (
        <div className="wb-diff-body">
          {file.hunks.map((h, i) => {
            if (!all && n > max) return null
            return (
              <div key={i} className="wb-diff-hunk">
                {h.head && <div className="wb-diff-hunk-head">{h.head}</div>}
                {h.lines.map((l, j) => {
                  if (!all && ++n > max) return null
                  return (
                    <div key={j} className={cx('wb-diff-line', `wb-diff-${l.type}`)}>
                      <span className="wb-diff-num">{l.a ?? ''}</span><span className="wb-diff-num">{l.b ?? ''}</span>
                      <span className="wb-diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</span>
                      <span className="wb-diff-text">{l.text || ' '}</span>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {!all && n > max && <button className="wb-linkbtn wb-diff-more" onClick={() => setAll(true)}>{t('ver.showAll')}</button>}
        </div>
      ))}
    </div>
  )
}

/** A whole diff (one file or several). */
export function Diff({ text, label, skip }) {
  const t = useT()
  const files = useMemo(() => parseDiff(text).filter(f => !skip?.includes(f.path)), [text, skip])
  if (!files.length) return <div className="wb-diff-empty">{t('ver.same')}</div>
  return <div className="wb-diff">{files.map((f, i) => <DiffFile key={`${f.path}-${i}`} file={f} label={files.length === 1 ? label : undefined} />)}</div>
}
