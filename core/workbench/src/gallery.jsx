// The run's products: the files in its ledger (kind `file`: what the agents saved, not the request's attachments).
// An image shows as it is, a video plays (<video>, streamed with Range from the file route), audio has its player,
// text and Markdown unfold in place, anything else is a download.
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Download, File, FileText, Image, Music, Video } from 'lucide-react'
import { call, fileUrl } from './data.js'
import { Md } from './rich.jsx'
import { bytes, cx, errorText, fileKind, mimeOfName, useT } from './ui.jsx'

const ICON = { image: Image, video: Video, audio: Music, markdown: FileText, text: FileText, file: File }
const TEXT_LIMIT = 20000

/** A ledger entry that holds a file → { seq, name, mime, kind, size, title } (null for one that does not). */
export const fileOf = e => {
  if (e.kind !== 'file' || !e.artifact) return null
  const name = e.input?.name || e.artifact.split('/').pop()
  const mime = e.input?.mime || mimeOfName(name)
  return { seq: e.seq, name, mime, kind: fileKind(name, mime), size: e.input?.bytes ?? null, title: e.title }
}
/** The products: the run's saved files, without the attachments the request came with. */
export const productsOf = (run, evidence) => {
  const asked = new Set((run.subject?.attachments || []).map(a => a.evidence))
  return evidence.filter(e => !asked.has(e.seq)).map(fileOf).filter(Boolean)
}

/** A text file's content, fetched when it is unfolded. */
function TextFile({ run, f }) {
  const t = useT()
  const [state, setState] = useState(null)
  useEffect(() => {
    let alive = true
    call('artifact', { id: run.id, seq: f.seq }).then(r => alive && setState({ text: r.content }), err => alive && setState({ error: errorText(t, err) }))
    return () => { alive = false }
  }, [run.id, f.seq])
  if (!state) return <div className="wb-sub">{t('loading')}</div>
  if (state.error) return <div className="wb-note wb-t-red">{state.error}</div>
  const text = state.text.length > TEXT_LIMIT ? `${state.text.slice(0, TEXT_LIMIT)}\n…` : state.text
  return f.kind === 'markdown' ? <Md text={text} /> : <pre className="wb-pre wb-pre-tall">{text || '—'}</pre>
}

/** One file as the page shows it. `onOpen(seq)` opens its ledger entry. */
export function FileCard({ run, f, onOpen }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const Icon = ICON[f.kind]
  const src = fileUrl(run.id, f.seq)
  const unfold = f.kind === 'markdown' || f.kind === 'text'
  return (
    <figure className={cx('wb-file', `wb-file-${f.kind}`)}>
      <figcaption>
        {unfold ? <button className="wb-file-name wb-file-fold" onClick={() => setOpen(!open)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Icon size={13} /><b>{f.name}</b></button>
          : <span className="wb-file-name"><Icon size={13} /><b>{f.name}</b></span>}
        {f.size !== null && <span className="wb-sub">{bytes(f.size)}</span>}
        <span className="wb-push" />
        {onOpen && <button className="wb-linkbtn wb-evref" title={t('gal.ledger')} onClick={() => onOpen(f.seq)}>#{f.seq}</button>}
        <a className="wb-icon-btn" href={fileUrl(run.id, f.seq, true)} title={t('gal.download')} aria-label={t('gal.download')}><Download size={14} /></a>
      </figcaption>
      {f.kind === 'image' && <a className="wb-file-media" href={src} target="_blank" rel="noreferrer"><img src={src} alt={f.name} loading="lazy" /></a>}
      {f.kind === 'video' && <video className="wb-file-media" controls preload="metadata" src={src} />}
      {f.kind === 'audio' && <audio className="wb-file-audio" controls preload="metadata" src={src} />}
      {unfold && open && <div className="wb-file-text"><TextFile run={run} f={f} /></div>}
    </figure>
  )
}

/** The gallery: every product of the run. */
export function Gallery({ run, evidence, onOpen }) {
  const t = useT()
  const files = productsOf(run, evidence)
  if (!files.length) return null
  return (
    <section className="wb-card wb-gallery">
      <h3><Image size={14} />{t('gal.title')}<span className="wb-count">{files.length}</span></h3>
      <div className="wb-gallery-grid">{files.map(f => <FileCard key={f.seq} run={run} f={f} onOpen={onOpen} />)}</div>
    </section>
  )
}
