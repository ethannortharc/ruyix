// The viewer: a run's files, each shown by its kind — a document, lines of text, an image, a video or a sound, a PDF
// page by page, a web page running in a frame of its own — with the person's comments where they point (a passage,
// some lines, a part of an image or of a PDF page, a moment) or on the whole. One viewer for what a review shows
// (src/review.jsx) and for a run's results (src/results.jsx): the page around it says what the comments are for.
// Comments are the parent's: the viewer hands back the whole list as it changes (useSaved saves it a moment later).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, Clock, Download, FileText, Image as ImageIcon, Loader2, MessageSquarePlus, MessageSquareText, Pencil, RotateCcw, Save, Trash2 } from 'lucide-react'
import { API, call } from './data.js'
import { Diff } from './diff.jsx'
import { Md } from './rich.jsx'
import { cx, errorText, mimeOfName, useT } from './ui.jsx'
import { openedFile } from './open-things.js'

export const workUrl = (runId, path, download = false) => `${API}/work?run=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`
/**
 * Where the viewer reads its files: a run's folder (the default) or a resident session's (docs/design/agent-work.md §4):
 * { key, fileAt(path), url(path, download?), pageOf(path) }.
 */
export const runSource = run => ({ key: `run:${run.id}`, fileAt: path => call('fileAt', { id: run.id, commit: 'WORK', path }), url: (path, dl) => workUrl(run.id, path, dl), pageOf: path => call('pageOf', { id: run.id, path }) })
export const sessionSource = id => ({
  key: `session:${id}`, fileAt: path => call('sessionFileAt', { id, path }), pageOf: path => call('sessionPageOf', { id, path }),
  url: (path, dl) => `${API}/sfile?session=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}${dl ? '&download=1' : ''}`,
})
const NO_COMMENTS = []
export { urlFiles } from './url-files.js'
export const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${s % 1 >= 0.05 ? `.${Math.min(9, Math.round((s % 1) * 10))}` : ''}`
export const nextId = list => `c${Math.max(0, ...list.map(c => Number(String(c.id).slice(1)) || 0)) + 1}`
/** How a file is shown: by its name, then by what fileAt gave (text or not). */
export const viewOf = (path, file) => {
  const m = mimeOfName(path)
  if (m === 'text/markdown') return 'markdown'
  if (m === 'text/html') return 'html'
  if (m === 'application/pdf') return 'pdf'
  if (/^image\//.test(m)) return 'image'
  if (/^video\//.test(m)) return 'video'
  if (/^audio\//.test(m)) return 'audio'
  return typeof file?.text === 'string' ? 'text' : 'file'
}
/** Where a comment points, in words. */
export function where(t, c) {
  const a = c.at
  if (!a) return t(c.file ? 'rv.wholeFile' : 'rv.whole')
  if (a.quote) return `“${a.quote.replace(/\s+/g, ' ').slice(0, 80)}${a.quote.length > 80 ? '…' : ''}”`
  if (a.lines) return a.lines[0] === a.lines[1] ? t('rv.line', { a: a.lines[0] }) : t('rv.lines', { a: a.lines[0], b: a.lines[1] })
  if (a.field) return t('rv.field', { f: a.field })
  if (a.box) return a.page ? t('rv.pageBox', { n: a.page }) : t('rv.box')
  if (a.time !== undefined) return t('rv.at', { t: clock(a.time) })
  return ''
}

/**
 * Comments saved a moment after they change (`save(list)` → the list as kept). → { comments, change(list), state, flush, reset }
 * state: '' | 'saving' | 'saved' | an error's words.
 */
export function useSaved(initial, save, initialRevision) {
  const t = useT()
  const [comments, setComments] = useState(initial)
  const [state, setState] = useState('')
  const revision = useRef(initialRevision)
  const timer = useRef(null), latest = useRef(initial), dirty = useRef(false), version = useRef(0), sending = useRef(null)
  const send = async () => {
    timer.current = null
    if (sending.current) await sending.current
    if (!dirty.current) return
    const seq = version.current, list = latest.current
    setState('saving')
    const job = Promise.resolve().then(() => save(list.map(({ id, file, at, text, status }) => ({ id, file, at, text, status })), revision.current)).then(result => {
      const kept = Array.isArray(result) ? result : result?.comments
      if (result && !Array.isArray(result)) revision.current = result.revision
      if (seq === version.current) { dirty.current = false; if (kept) { latest.current = kept; setComments(kept) } }
      setState(dirty.current ? '' : 'saved')
    }).catch(err => { setState(errorText(t, err)); throw err }).finally(() => { if (sending.current === job) sending.current = null })
    sending.current = job
    return job
  }
  const change = useCallback(list => { latest.current = list; dirty.current = true; ++version.current; setComments(list); clearTimeout(timer.current); timer.current = setTimeout(() => send().catch(() => {}), 500) }, [save])
  const flush = async () => { clearTimeout(timer.current); timer.current = null; if (sending.current) await sending.current; while (dirty.current) await send() }
  const reset = (list, nextRevision) => { if (!dirty.current && !sending.current) { revision.current = nextRevision; latest.current = list; setComments(list) } }
  useEffect(() => () => { clearTimeout(timer.current); if (dirty.current) send().catch(() => {}) }, [])
  return { comments, change, state, flush, reset }
}

// ── text: a passage by its words and a few around it, found again in what is shown (CSS highlights: the page's DOM is
// React's and is not touched; a browser without them shows no highlight, the comments still work) ──
const HL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined'
function quoteOf(box) {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  if (!box.contains(r.commonAncestorContainer)) return null
  const quote = r.toString()
  if (!quote.trim()) return null
  const before = document.createRange(), after = document.createRange()
  before.selectNodeContents(box); before.setEnd(r.startContainer, r.startOffset)
  after.selectNodeContents(box); after.setStart(r.endContainer, r.endOffset)
  return { at: { quote: quote.slice(0, 1000), prefix: before.toString().slice(-60), suffix: after.toString().slice(0, 60) }, rect: r.getBoundingClientRect() }
}
function rangeOf(box, at) {
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT), nodes = []
  let all = ''
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { nodes.push([n, all.length]); all += n.data }
  if (!nodes.length) return null
  const tries = [[at.prefix + at.quote + at.suffix, at.prefix.length], [at.prefix + at.quote, at.prefix.length], [at.quote + at.suffix, 0], [at.quote, 0]]
  let start = -1
  for (const [s, off] of tries) { const i = s && all.indexOf(s); if (i >= 0) { start = i + off; break } }
  if (start < 0) return null
  const end = start + at.quote.length, pos = k => { const e = nodes.findLast(([, o]) => o <= k) || nodes[0]; return [e[0], Math.min(k - e[1], e[0].data.length)] }
  const r = document.createRange()
  r.setStart(...pos(start)); r.setEnd(...pos(end))
  return r
}
function useHighlights(box, comments, active, deps) {
  useEffect(() => {
    if (!HL || !box.current) return
    const all = [], on = []
    for (const c of comments) {
      if (!c.at?.quote) continue
      const r = rangeOf(box.current, c.at)
      if (r) (c.id === active ? on : all).push(r)
    }
    CSS.highlights.set('wb-rv', new Highlight(...all))
    CSS.highlights.set('wb-rv-on', new Highlight(...on))
    if (on[0]) on[0].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return () => { CSS.highlights.delete('wb-rv'); CSS.highlights.delete('wb-rv-on') }
  }, [comments, active, ...deps])
}

/** The button that floats by a selection: write a comment on it. */
function Pick({ pick, onAdd, t }) {
  if (!pick) return null
  return (
    <button className="wb-btn wb-small wb-primary wb-rv-pick" style={{ top: pick.rect.bottom + 6, left: Math.max(8, pick.rect.left) }} onMouseDown={e => e.preventDefault()} onClick={() => onAdd(pick.at)}>
      <MessageSquarePlus size={12} />{t('rv.addHere')}
    </button>
  )
}

function TextView({ kind, file, comments, active, onPick, onAt, lines }) {
  const box = useRef(null)
  useHighlights(box, comments, active, [file?.text])
  const up = () => setTimeout(() => onPick(box.current && quoteOf(box.current)), 0)
  if (kind === 'markdown') return <div className="wb-rv-doc" ref={box} onMouseUp={up}><Md text={file.text} /></div>
  const rows = String(file.text).split('\n'), marked = new Set(comments.filter(c => c.at?.lines).flatMap(c => Array.from({ length: c.at.lines[1] - c.at.lines[0] + 1 }, (_, k) => c.at.lines[0] + k)))
  return (
    <div className="wb-rv-lines" ref={box} onMouseUp={up}>
      {rows.map((line, i) => {
        const n = i + 1, on = lines && n >= lines[0] && n <= lines[1]
        return (
          <div key={i} className={cx('wb-rv-line', on && 'wb-on', marked.has(n) && 'wb-rv-marked')}>
            <button className="wb-rv-ln" onClick={e => onAt(e.shiftKey && lines ? [Math.min(lines[0], n), Math.max(lines[1], n)] : [n, n])}>{n}</button>
            <code>{line || ' '}</code>
          </div>
        )
      })}
    </div>
  )
}

/** Something to draw boxes on (an image, a PDF page): drag a box to comment on that part; the comments' boxes on it. */
function Boxes({ comments, active, onBox, children, className }) {
  const box = useRef(null), [drag, setDrag] = useState(null)
  const at = e => { const r = box.current.getBoundingClientRect(); return [Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)] }
  const rect = d => [Math.min(d[0], d[2]), Math.min(d[1], d[3]), Math.abs(d[2] - d[0]), Math.abs(d[3] - d[1])]
  const style = b => ({ left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${b[2] * 100}%`, height: `${b[3] * 100}%` })
  return (
    <div className={cx('wb-rv-img', className)} ref={box}
      onMouseDown={e => { if (!onBox) return; e.preventDefault(); const p = at(e); setDrag([...p, ...p]) }}
      onMouseMove={e => drag && setDrag([drag[0], drag[1], ...at(e)])}
      onMouseUp={() => { if (drag) { const b = rect(drag); if (b[2] > 0.01 && b[3] > 0.01) onBox(b); setDrag(null) } }}>
      {children}
      {comments.filter(c => c.at?.box).map(c => <span key={c.id} className={cx('wb-rv-box', c.id === active && 'wb-on')} style={style(c.at.box)}><b>{c.id.slice(1)}</b></span>)}
      {drag && <span className="wb-rv-box wb-rv-drawing" style={style(rect(drag))} />}
    </div>
  )
}

function MediaView({ kind, src, comments, active, onTime, t }) {
  const el = useRef(null), [now, setNow] = useState(0)
  useEffect(() => { const c = comments.find(x => x.id === active && x.at?.time !== undefined); if (c && el.current) el.current.currentTime = c.at.time }, [active])
  const Tag = kind === 'audio' ? 'audio' : 'video'
  return (
    <div className="wb-rv-media">
      <Tag ref={el} src={src} controls preload="metadata" onTimeUpdate={e => setNow(e.currentTarget.currentTime)} />
      <div className="wb-rv-times">
        {onTime && <button className="wb-btn wb-small wb-primary" onClick={() => onTime(Math.round((el.current?.currentTime || 0) * 10) / 10)}><Clock size={12} />{t('rv.timeHere', { t: clock(now) })}</button>}
        {comments.filter(c => c.at?.time !== undefined).sort((a, b) => a.at.time - b.at.time).map(c => (
          <button key={c.id} className={cx('wb-tag wb-rv-time', c.id === active && 'wb-on')} onClick={() => { if (el.current) el.current.currentTime = c.at.time }}>{clock(c.at.time)} · {c.id.slice(1)}</button>
        ))}
      </div>
    </div>
  )
}

// ── PDF: pdf.js (vendor/pdfjs), loaded the first time a PDF is shown; each page drawn to fit, boxes drawn on it ──
let pdfjs = null
const loadPdf = async () => {
  if (!pdfjs) {
    const base = new URL(`${API}/pdfjs/`, document.baseURI).href
    const mod = await import(/* @vite-ignore */ `${base}pdf.min.mjs`)
    mod.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`
    pdfjs = mod
  }
  return pdfjs
}
const PDF_PAGES = 60
function PdfPage({ doc, n, comments, active, onBox }) {
  const canvas = useRef(null), holder = useRef(null)
  useEffect(() => {
    let task = null, off = false
    doc.getPage(n).then(page => {
      if (off || !canvas.current) return
      const width = holder.current?.clientWidth || 800, plain = page.getViewport({ scale: 1 })
      const vp = page.getViewport({ scale: (width / plain.width) * (window.devicePixelRatio || 1) })
      canvas.current.width = vp.width; canvas.current.height = vp.height
      task = page.render({ canvasContext: canvas.current.getContext('2d'), viewport: vp })
    }).catch(() => {})
    return () => { off = true; task?.cancel?.() }
  }, [doc, n])
  return (
    <div className="wb-rv-pdf-page" ref={holder} data-page={n}>
      <Boxes comments={comments} active={active} onBox={onBox}><canvas ref={canvas} /></Boxes>
      <span className="wb-sub wb-rv-pdf-n">{n}</span>
    </div>
  )
}
function PdfView({ src, comments, active, onBox, t }) {
  const [doc, setDoc] = useState(null), [error, setError] = useState('')
  useEffect(() => {
    let off = false, task = null
    setDoc(null); setError('')
    loadPdf().then(p => { task = p.getDocument({ url: src, withCredentials: true }); return task.promise }).then(d => off || setDoc(d), err => off || setError(err?.message || String(err)))
    return () => { off = true; task?.destroy?.() }
  }, [src])
  useEffect(() => { const c = comments.find(x => x.id === active && x.at?.page); if (c) document.querySelector(`.wb-rv-pdf-page[data-page="${c.at.page}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [active])
  if (error) return <div className="wb-note wb-t-red">{t('rv.pdfError', { error })} <a href={src} target="_blank" rel="noreferrer">{t('rv.openPdf')}</a></div>
  if (!doc) return <Loader2 size={14} className="wb-spin" />
  return (
    <div className="wb-rv-pdf">
      <p className="wb-sub">{t('rv.pdfHint', { n: doc.numPages })}</p>
      {Array.from({ length: Math.min(doc.numPages, PDF_PAGES) }, (_, i) => i + 1).map(n => (
        <PdfPage key={n} doc={doc} n={n} comments={comments.filter(c => c.at?.page === n)} active={active} onBox={onBox && (box => onBox({ page: n, box }))} />
      ))}
      {doc.numPages > PDF_PAGES && <p className="wb-sub">{t('rv.pdfMore', { n: doc.numPages - PDF_PAGES })} <a href={src} target="_blank" rel="noreferrer">{t('rv.openPdf')}</a></p>}
    </div>
  )
}

/** A web page of the folder, running in a frame with no origin of its own (lib/pages.js put its files in). */
function PageView({ src, path, t }) {
  const [page, setPage] = useState(null)
  useEffect(() => {
    let off = false
    setPage(null)
    src.pageOf(path).then(p => off || setPage(p), err => off || setPage({ error: errorText(t, err) }))
    return () => { off = true }
  }, [src.key, path])
  if (!page) return <Loader2 size={14} className="wb-spin" />
  if (page.error) return <div className="wb-note wb-t-red">{page.error}</div>
  return (
    <div className="wb-rv-site">
      <p className="wb-sub">{t('rv.pageHint')}{page.left.length > 0 && ` ${t('rv.pageLeft', { n: page.left.length })}`}</p>
      <iframe className="wb-rv-page" sandbox="allow-scripts allow-forms" srcDoc={page.html} title={path} />
    </div>
  )
}

/** One comment in the list: where it points, its words, the agent's answer; the person's to change while unsent, to open again once answered or sent. */
function Comment({ c, open, active, onFocus, onText, onDrop, onReopen, sentTo, t }) {
  const sent = !!c.sentIn || !open, status = c.status === 'open' && c.reopenedIn ? 'reopened' : c.status
  const [editing, setEditing] = useState(false)
  return (
    <li className={cx('wb-rv-c', c.id === active && 'wb-on', `wb-rv-${status}`)} onClick={() => onFocus(c)}>
      <div className="wb-rv-c-head">
        <b className="wb-rv-n">{c.id.slice(1)}</b>
        <span className="wb-rv-where">{c.file && <span className="wb-mono">{c.file.split('/').pop()}</span>} {where(t, c)}</span>
        {(c.sentIn || c.reopenedIn) && <span className={cx('wb-tag', status === 'done' ? 'wb-t-green' : status === 'declined' ? 'wb-t-amber' : 'wb-t-blue')}>{status === 'sent' ? t('rv.st.sent', { step: sentTo?.(c.sentTo) || c.sentTo || '' }) : t(`rv.st.${status}`)}</span>}
      </div>
      {editing && !sent
        ? <textarea className="wb-input" rows={3} autoFocus value={c.text} onClick={e => e.stopPropagation()} onChange={e => onText(c.id, e.target.value)} onBlur={() => setEditing(false)}
          onKeyDown={e => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.stopPropagation(); setEditing(false) } }} />
        : <p className="wb-rv-c-text">{c.text}</p>}
      {c.reply && <p className="wb-rv-reply"><MessageSquareText size={11} /> {c.reply}</p>}
      <div className="wb-rv-c-acts">
        {!sent && !editing && <button className="wb-linkbtn" onClick={e => { e.stopPropagation(); setEditing(true) }}><Pencil size={11} /> {t('rv.change')}</button>}
        {!sent && <button className="wb-linkbtn" onClick={e => { e.stopPropagation(); onDrop(c.id) }}><Trash2 size={11} /> {t('rv.delete')}</button>}
        {open && c.sentIn && c.status !== 'open' && <button className="wb-linkbtn" onClick={e => { e.stopPropagation(); onReopen(c.id) }}><RotateCcw size={11} /> {t('rv.reopen')}</button>}
      </div>
    </li>
  )
}

/**
 * The files and the comments. run; files (paths in its folder); comments + onComments(list); open: comments can be
 * written; editable: a text file can be changed in place (a version of the person's); compare: { n, from, to } — the
 * round before (versions) to show the difference with; display: a pack's own view ({ Editor, props }) listed first;
 * side: what goes above the comments; sentTo(key): a step's name, for comments sent along.
 */
export function Viewer({ run, source = null, files, initialPath = null, comments = null, onComments, onDirty, onSaving, open = true, editable = false, compare = null, display = null, side = null, sentTo, className, track = true }) {
  const t = useT()
  // (no comments at all — `comments` null, a session's files: read only — no comments column either)
  const bare = comments === null
  if (bare) comments = NO_COMMENTS
  // (a session's folder: `source`; else the run's)
  const src = useMemo(() => source || runSource(run), [source?.key, run?.id])
  const [path, setPath] = useState(display ? null : (initialPath && files.includes(initialPath) ? initialPath : files[0] || null))
  useEffect(() => { if (initialPath && files.includes(initialPath)) setPath(initialPath) }, [initialPath])
  // a file looked at: one of the things open, under its run (the desk brings it back here) — not in the viewer's own
  // window (`track` false): the window is that thing
  useEffect(() => { if (track && !source && path && run?.id) openedFile(run, path) }, [path, run?.id, track])
  const [file, setFile] = useState(null) // fileAt('WORK') — or { url } for what streams
  const [error, setError] = useState('')
  const [active, setActive] = useState(null)
  const [pick, setPick] = useState(null)
  const [lines, setLines] = useState(null)
  const [draft, setDraft] = useState(null)
  const [whole, setWhole] = useState('')
  const [diffOn, setDiffOn] = useState(false), [diff, setDiff] = useState(null)
  const [edit, setEdit] = useState(null), [editState, setEditState] = useState('')
  const saving = editState === 'saving'
  const dirty = saving || (edit !== null && edit !== file?.text)
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty, onDirty])
  useEffect(() => { onSaving?.(saving); return () => onSaving?.(false) }, [saving, onSaving])
  const goTo = next => { if (!saving && next !== path && (!dirty || window.confirm(t('rv.discardEditor')))) setPath(next) }
  const kind = path ? viewOf(path, file) : null
  const openN = comments.filter(c => c.status === 'open').length
  useEffect(() => { if (path && !files.includes(path) && files[0]) setPath(files[0]) }, [files.join('\n')])
  useEffect(() => {
    if (!path) { setFile(null); return }
    let off = false
    setFile(null); setError(''); setEdit(null); setLines(null); setPick(null)
    const v = viewOf(path, null)
    if (['video', 'audio', 'pdf', 'html'].includes(v) || (v === 'image' && !path.endsWith('.svg'))) { setFile({ url: src.url(path) }); return }
    src.fileAt(path).then(f => off || setFile(f), err => off || setError(errorText(t, err)))
    return () => { off = true }
  }, [path, src.key, compare?.to])
  useEffect(() => {
    if (!diffOn || !path || !compare) { setDiff(null); return }
    let off = false
    call('fileDiff', { id: run.id, from: compare.from, to: compare.to, path }).then(r => off || setDiff(r.diff), () => off || setDiff(''))
    return () => { off = true }
  }, [diffOn, path, compare?.from, compare?.to])
  const add = (f, at) => { setPick(null); setLines(null); setDraft({ file: f, at, text: '' }); window.getSelection()?.removeAllRanges() }
  const keep = () => {
    if (!draft?.text.trim()) return
    const c = { id: nextId(comments), file: draft.file, at: draft.at, text: draft.text.trim(), status: 'open' }
    onComments([...comments, c]); setDraft(null); setActive(c.id)
  }
  const addWhole = () => { if (!whole.trim()) return; onComments([...comments, { id: nextId(comments), file: null, at: null, text: whole.trim(), status: 'open' }]); setWhole('') }
  const focus = c => { setActive(c.id); if (c.file && c.file !== path) goTo(c.file) }
  const saveEdit = async () => {
    setEditState('saving')
    try {
      await call('editFile', { id: run.id, path, content: edit, blob: file.blob })
      setEdit(null); setEditState('')
      setFile(await call('fileAt', { id: run.id, commit: 'WORK', path }))
    } catch (err) { setEditState(errorText(t, err)) }
  }
  const here = comments.filter(c => c.file === path)
  const can = open ? { onBox: box => add(path, { box }), onTime: time => add(path, { time }) } : {}
  return (
    <div className={cx('wb-rv-body', bare && 'wb-rv-nocomments', className)}>
      <nav className="wb-rv-files">
        <h5>{t('rv.files')}</h5>
        {display && <button className={cx('wb-rv-file', !path && 'wb-on')} disabled={saving} onClick={() => goTo(null)}><ImageIcon size={12} />{t('rv.display')}</button>}
        {files.map(f => {
          const n = comments.filter(c => c.file === f && c.status === 'open').length
          return <button key={f} disabled={saving} className={cx('wb-rv-file', f === path && 'wb-on')} onClick={() => goTo(f)} title={f}><FileText size={12} /><span>{f.startsWith('review/') ? t('rv.note') : f}</span>{n > 0 && <b className="wb-count">{n}</b>}</button>
        })}
        {!files.length && !display && <p className="wb-sub">{t('rv.nothing')}</p>}
      </nav>
      <main className="wb-rv-main">
        {/* Keep the pack editor mounted when inspecting evidence; switching files must not discard its draft. */}
        {display && <div hidden={!!path}><display.Editor {...display.props} visible={!path} /></div>}
        {path && (
          <>
            <div className="wb-rv-tools">
              <span className="wb-mono wb-rv-path">{path}</span>
              {compare && <button className={cx('wb-btn wb-small', diffOn && 'wb-on')} onClick={() => setDiffOn(v => !v)}><ArrowLeftRight size={12} />{t('rv.compare', { n: compare.n })}</button>}
              {editable && ['markdown', 'text'].includes(kind) && edit === null && file?.text !== undefined && <button className="wb-btn wb-small" onClick={() => setEdit(file.text)}><Pencil size={12} />{t('rv.edit')}</button>}
              {open && lines && <button className="wb-btn wb-small wb-primary" onClick={() => add(path, { lines })}><MessageSquarePlus size={12} />{t('rv.onLines', { a: lines[0], b: lines[1] })}</button>}
              <a className="wb-btn wb-small" href={src.url(path, true)} title={t('rv.download')}><Download size={12} /></a>
            </div>
            {error && <div className="wb-note wb-t-red">{error}</div>}
            {diffOn && (diff === null ? <Loader2 size={14} className="wb-spin" /> : diff ? <Diff text={diff} /> : <p className="wb-sub">{t('rv.sameAsBefore')}</p>)}
            {!diffOn && edit !== null && (
              <div className="wb-rv-edit">
                <textarea disabled={saving} className="wb-input wb-mono" value={edit} onChange={e => setEdit(e.target.value)} />
                {editState && editState !== 'saving' && <div className="wb-note wb-t-red">{editState}</div>}
                <div className="wb-actions"><button className="wb-btn wb-small" disabled={saving} onClick={() => setEdit(null)}>{t('rv.cancel')}</button><button className="wb-btn wb-small wb-primary" disabled={edit === file.text || editState === 'saving'} onClick={saveEdit}><Save size={12} />{t('rv.editSave')}</button></div>
              </div>
            )}
            {!diffOn && edit === null && !file && !error && <Loader2 size={14} className="wb-spin" />}
            {!diffOn && edit === null && file && (
              ['markdown', 'text'].includes(kind) ? <TextView kind={kind} file={file} comments={here} active={active} onPick={open ? setPick : () => {}} onAt={open ? setLines : () => {}} lines={lines} />
                : kind === 'image' ? <div className="wb-rv-media">{open && <p className="wb-sub">{t('rv.drawHint')}</p>}<Boxes comments={here} active={active} onBox={can.onBox}><img src={file.url || file.image} alt="" draggable={false} /></Boxes></div>
                  : ['video', 'audio'].includes(kind) ? <MediaView kind={kind} src={file.url} comments={here} active={active} onTime={can.onTime} t={t} />
                    : kind === 'pdf' ? <PdfView src={file.url} comments={here} active={active} onBox={open ? (({ page, box }) => add(path, { page, box })) : null} t={t} />
                      : kind === 'html' ? <PageView src={src} path={path} t={t} />
                        : <p className="wb-sub">{t('rv.noShow')}</p>
            )}
          </>
        )}
        {open && <Pick pick={pick} onAdd={at => add(path, at)} t={t} />}
      </main>
      {!bare && <aside className="wb-rv-side">
        {side}
        {draft && (
          <div className="wb-rv-draft">
            <span className="wb-sub">{draft.file ? `${draft.file.split('/').pop()} · ` : ''}{where(t, draft)}</span>
            <textarea className="wb-input" rows={3} autoFocus value={draft.text} placeholder={t('rv.draftHint')} onChange={e => setDraft({ ...draft, text: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) keep(); if (e.key === 'Escape') { e.stopPropagation(); setDraft(null) } }} />
            <div className="wb-actions"><button className="wb-btn wb-small" onClick={() => setDraft(null)}>{t('rv.cancel')}</button><button className="wb-btn wb-small wb-primary" disabled={!draft.text.trim()} onClick={keep}>{t('rv.add')}</button></div>
          </div>
        )}
        <h5>{t('rv.comments')} {comments.length > 0 && <span className="wb-dim">{t('rv.openN', { n: openN })}</span>}</h5>
        {comments.length ? (
          <ol className="wb-rv-list">
            {comments.map(c => <Comment key={c.id} c={c} open={open} active={active} t={t} onFocus={focus} sentTo={sentTo}
              onText={(id, text) => onComments(comments.map(x => (x.id === id ? { ...x, text } : x)))}
              onDrop={id => onComments(comments.filter(x => x.id !== id))}
              onReopen={id => onComments(comments.map(x => (x.id === id ? { ...x, status: 'open' } : x)))} />)}
          </ol>
        ) : <p className="wb-sub">{t(path && open ? 'rv.selectHint' : 'rv.none')}</p>}
        {open && (
          <div className="wb-rv-whole">
            <textarea className="wb-input" rows={2} value={whole} placeholder={t('rv.wholeHint')} onChange={e => setWhole(e.target.value)} />
            <button className="wb-btn wb-small" disabled={!whole.trim()} onClick={addWhole}><MessageSquarePlus size={12} />{t('rv.add')}</button>
          </div>
        )}
      </aside>}
    </div>
  )
}
