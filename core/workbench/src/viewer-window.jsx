// The viewer as a window of the desk (docs/design/agent-work.md §4): a run's results in a window of their own — opened
// from a done note, the records, the run page — sized by what it shows (a document tall, a picture or a video by its
// shape), the files down its left when there are several; the comments, and going on again from a step with them, as
// on the run page. A resident session's work too: the files of its folder it made or changed, to read (no comments:
// say it to the session). The window event `ruyix-workbench:view` { run | session, file? } opens it (no desk here: the
// run page's 结果).
import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, Images, Loader2, XCircle } from 'lucide-react'
import css from './styles.css'
import tokens from '@ruyix/shell/tokens.css'
import { NS, OPEN, call, useFullRun, useWbStore } from './data.js'
import { ResultsTab, useResults } from './results.jsx'
import { T, cx, errorText, useT } from './ui.jsx'
import { Viewer, sessionSource, viewOf } from './viewer.jsx'
import { sameOrigin, urlFiles } from './url-files.js'
import { hashOf } from './open-things.js'
import { namesOf } from './win-names.js'

export const VIEW = `${NS}:view`

/** How big a window shows it well: a document or a page tall, a video wide, a sound small. */
export function sizeFor(file) {
  const v = file ? viewOf(file, null) : 'markdown'
  return v === 'video' ? { w: 1120, h: 720 } : v === 'audio' ? { w: 760, h: 440 } : v === 'image' ? { w: 1000, h: 800 } : { w: 1120, h: 860 }
}

function Results({ runId, file }) {
  const t = useT()
  const [store] = useWbStore()
  const doc = store.run.get(runId)
  const run = useFullRun(doc || { id: runId })
  const [data, reload] = useResults(run)
  const [note, setNote] = useState(null)
  useEffect(() => { if (!note) return; const h = setTimeout(() => setNote(null), note.kind === 'error' ? 9000 : 4500); return () => clearTimeout(h) }, [note])
  if (!doc) return <div className="wb-empty-small">{store.ready ? t('vw.gone') : '…'}</div>
  return (
    <div className="wb-vw-body">
      <div className="wb-vw-bar">
        <span className="wb-sub">{doc.subject?.title || doc.template}</span>
        <button className="wb-linkbtn" onClick={() => window.dispatchEvent(new CustomEvent(OPEN, { detail: { run: runId, tab: 'results', ...(file && { file }) } }))}><ExternalLink size={12} />{t('vw.toRun')}</button>
      </div>
      <ResultsTab run={run} data={data} reload={reload} toast={(kind, title) => setNote({ kind, title })} initialFile={file || null} track={false} />
      {note && <div className={cx('wb-vw-note', `wb-toast-${note.kind}`)}>{note.kind === 'ok' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<span>{note.title}</span></div>}
    </div>
  )
}

/** A session's folder: what it made or changed since it began, the latest first (again every little while). */
function SessionFiles({ sessionId, file }) {
  const t = useT()
  const [data, setData] = useState(null)
  useEffect(() => {
    let off = false
    const load = () => call('sessionFiles', { id: sessionId }).then(d => off || setData(d), err => off || setData({ error: errorText(t, err) }))
    load()
    const every = setInterval(() => { if (!document.hidden) load() }, 15000)
    return () => { off = true; clearInterval(every) }
  }, [sessionId])
  if (!data) return <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div>
  if (data.error) return <div className="wb-note wb-t-red">{data.error}</div>
  return (
    <div className="wb-vw-body">
      <div className="wb-vw-bar">
        <span className="wb-sub">{data.session.title} · <span className="wb-mono" title={data.session.cwd}>{data.session.cwd.split('/').filter(Boolean).length > 2 ? `…/${data.session.cwd.split('/').filter(Boolean).slice(-2).join('/')}` : data.session.cwd}</span></span>
        <button className="wb-linkbtn" onClick={() => window.dispatchEvent(new CustomEvent('agent-hub:open', { detail: { tab: 'sessions', session: sessionId } }))}><ExternalLink size={12} />{t('vw.toSession')}</button>
      </div>
      {data.files.length
        ? <div className="wb-res"><Viewer source={sessionSource(sessionId)} files={data.files} initialPath={file || null} comments={null} onComments={() => {}} open={false} className="wb-res-viewer" /></div>
        : <div className="wb-empty-small">{t('vw.noFiles')}</div>}
    </div>
  )
}

/** Files by their own links (a studio's materials): the one asked for first, the others down the left. */
function UrlFiles({ files, file }) {
  const t = useT()
  const { names, source } = urlFiles(files)
  if (!names.length) return <div className="wb-empty-small">{t('vw.noFiles')}</div>
  return (
    <div className="wb-vw-body">
      <div className="wb-res"><Viewer source={source} files={names} initialPath={names[Number.isInteger(file) ? file : 0] || null} comments={null} onComments={() => {}} open={false} className="wb-res-viewer" /></div>
    </div>
  )
}

/** The window's body: the workbench's words and styles around the results (the desk renders it outside the page). */
export function ViewerWindow({ runId, sessionId, urls, file, t }) {
  return (
    <T.Provider value={t}>
      <div className="wb-page wb-embedded wb-vw">
        <style>{tokens + css}</style>
        {urls ? <UrlFiles files={urls} file={file} /> : sessionId ? <SessionFiles sessionId={sessionId} file={file} /> : <Results runId={runId} file={file} />}
      </div>
    </T.Provider>
  )
}

/**
 * Open a run's results in the viewer window (`desk`: the shell's window.__ruyixDesk). → false when there is no desk to
 * open it on (the caller shows the run page instead).
 */
export function openViewer({ run = null, session = null, files = null, file = null }, { desk = globalThis.window?.__ruyixDesk, t, title = '' } = {}) {
  // files by their own links (a studio's materials): one window for that set, the file asked for first
  if (Array.isArray(files) && files.length && desk?.open) {
    const list = files.slice(0, 200).map(f => ({ url: String(f?.url || ''), name: String(f?.name || ''), ...(f?.kind && { kind: String(f.kind) }) })).filter(f => sameOrigin(f.url))
    const at = Number.isInteger(file) && file >= 0 && file < list.length ? file : 0
    desk.open({
      id: `viewer:files:${hashOf(JSON.stringify(list.map(f => f.url)))}`, title: title || list[at]?.name || t('vw.title'), ...(!title && !list[at]?.name && { names: namesOf('vw.title') }), icon: Images,
      Content: ViewerWindow, props: { urls: list, file: at, t }, size: sizeFor(list[at]?.name || null),
      reopen: { event: VIEW, detail: { files: list, file: at, ...(title && { title }) } }, kind: 'file', hint: t('vw.title'),
    })
    return true
  }
  if (!desk?.open || !(run || session)) return false
  const key = session ? 'vw.sessionTitle' : 'vw.title', what = t(key)
  desk.open({
    id: session ? `viewer:session:${session}` : `viewer:${run}`, title: title ? `${title} · ${what}` : what, names: namesOf(key, title), icon: Images,
    Content: ViewerWindow, props: { runId: run, sessionId: session, file, t }, size: sizeFor(file),
    reopen: { event: VIEW, detail: { ...(session ? { session } : { run }), ...(file && { file }) } }, kind: 'file', of: session ? `session:${session}` : `run:${run}`, hint: what,
  })
  return true
}
