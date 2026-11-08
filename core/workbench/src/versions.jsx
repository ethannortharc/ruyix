// A run's versions (lib/versions.js) on the page: the list of versions (one per step, a person's edits, going back), what
// each changed, a file's own versions side by side with the difference, a person's edit of a result — and the two ways
// to steer a run from a step: back to before it (the folder as it found it), or on from it with the folder as it is.
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Circle, FilePlus2, FileText, Flag, Folder, Hand, Image as ImageIcon, Loader2, MessageSquareText, Pencil, Play, RotateCcw, Save, Undo2, X, XCircle } from 'lucide-react'
import { call } from './data.js'
import { Diff } from './diff.jsx'
import { Md } from './rich.jsx'
import { ACTIVE, bytes, cx, errorText, useT, when } from './ui.jsx'

// ── words and marks ──
export const VERSION_ICON = { start: Flag, step: CheckCircle2, outside: Hand, edit: Pencil, rewind: Undo2, review: MessageSquareText, other: Circle }
const stepWord = (t, key) => t(`stage.${key}`)
/** What a version is, in words: the start, a step and how it ended, a person's edit, going back, changes outside the steps. */
export function versionWhat(t, c) {
  const m = c?.mark || {}
  if (m.kind === 'start') return t('ver.k.start')
  if (m.kind === 'step') return t('ver.k.step', { step: stepWord(t, m.step), status: t(`sst.${m.status}`) })
  if (m.kind === 'outside') return t('ver.k.outside')
  if (m.kind === 'edit') return t(m.by === 'person' ? 'ver.k.edit' : 'ver.k.editBy', { path: m.path, by: m.by })
  if (m.kind === 'rewind') return t('ver.k.rewind', { step: stepWord(t, m.step) })
  if (m.kind === 'review') return t('ver.k.review', { step: stepWord(t, m.step), n: m.round })
  return c?.subject || ''
}
const toneOf = c => (c?.mark?.kind === 'step' ? (c.mark.status === 'failed' ? 'red' : c.mark.status === 'stopped' ? 'muted' : 'green') : c?.mark?.kind === 'rewind' ? 'amber' : c?.mark?.kind === 'edit' ? 'blue' : 'muted')
export const short = c => String(c || '').slice(0, 7)
const ST = { A: 'ver.st.added', M: 'ver.st.changed', D: 'ver.st.removed', R: 'ver.st.renamed', T: 'ver.st.changed' }

/** A step's version, small: its files and a click to see them. */
export function VersionChip({ version, onOpen }) {
  const t = useT()
  if (!version?.commit) return null
  const n = (version.files?.length || 0) + (version.more || 0)
  return (
    <button className={cx('wb-ver-chip', !version.made && 'wb-ver-chip-same')} onClick={onOpen} title={t('ver.chipHint', { id: short(version.commit) })}>
      <FileText size={11} />{version.made ? t('ver.files', { n }) : t('ver.noChange')}<span className="wb-mono">{short(version.commit)}</span>
    </button>
  )
}

/** The run's versions, loaded again whenever the run changes. → { data: { on, off, commits } | null, error, reload } */
export function useVersions(run) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [n, setN] = useState(0)
  useEffect(() => {
    let off = false
    call('versions', { id: run.id }).then(d => off || (setData(d), setError('')), err => off || setError(err.message))
    return () => { off = true }
  }, [run.id, run.updatedAt, n])
  return { data, error, reload: () => setN(x => x + 1) }
}

// ── going back, going on ──
/**
 * Back to before a step: what the folder would lose and get back, then the person's yes. A run going is stopped first
 * (said). `onDone(result)`: it went back and the run goes on from the step.
 */
export function RewindDialog({ run, step, onClose, onDone, toast }) {
  const t = useT()
  const [p, setP] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [n0, setN0] = useState(0)
  useEffect(() => { setP(null); call('rewindPreview', { id: run.id, from: step }).then(setP, err => setError(errorText(t, err))) }, [run.id, step, n0])
  const go = async () => {
    setBusy(true); setError('')
    try {
      // what is done is what this preview showed: the folder changed since, and it says so (look again)
      const r = await call('rewindRun', { id: run.id, from: step, expect: { tree: p.tree, target: p.target } })
      toast?.('ok', r.kept?.length ? t('ver.rewoundKept', { step: stepWord(t, r.from), n: r.kept.length }) : t('ver.rewound', { step: stepWord(t, r.from) })); onDone?.(r); onClose()
    } catch (err) { setError(errorText(t, err)); if (err.code === 'changedMeanwhile') setN0(x => x + 1) }
    setBusy(false)
  }
  const n = useMemo(() => (p?.files || []).reduce((m, f) => ({ ...m, [f.action]: (m[f.action] || 0) + 1 }), {}), [p])
  return (
    <Modal title={t('ver.rewindTitle', { step: stepWord(t, step) })} onClose={onClose}>
      <p className="wb-ver-explain">{t('ver.rewindExplain')}</p>
      {ACTIVE.has(run.status) && <div className="wb-note wb-t-amber"><AlertTriangle size={13} /> {t('ver.stopsFirst')}</div>}
      {run.folder && <div className="wb-note wb-t-amber"><Folder size={13} /> {t('ver.ownFolder', { path: run.folder })}</div>}
      {error && <div className="wb-note wb-t-red">{error}</div>}
      {!p && !error && <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div>}
      {p && (p.files.length ? (
        <>
          <div className="wb-ver-sum">
            {n.revert > 0 && <span className="wb-tag">{t('ver.a.revertN', { n: n.revert })}</span>}
            {n.remove > 0 && <span className="wb-tag">{t('ver.a.removeN', { n: n.remove })}</span>}
            {n.restore > 0 && <span className="wb-tag">{t('ver.a.restoreN', { n: n.restore })}</span>}
          </div>
          <ul className="wb-ver-files wb-ver-files-scroll">
            {p.files.map(f => <li key={f.path}><span className={cx('wb-ver-act', `wb-ver-act-${f.action}`)}>{t(`ver.a.${f.action}`)}</span><span className="wb-mono">{f.path}</span></li>)}
          </ul>
        </>
      ) : <p className="wb-sub">{t('ver.rewindNoFiles')}</p>)}
      {p?.kept?.length > 0 && (
        <div className="wb-note wb-t-amber wb-note-stack"><span><AlertTriangle size={13} /> {t('ver.keptAside', { n: p.kept.length })}</span>
          <ul className="wb-ver-files wb-ver-files-scroll">{p.kept.map(k => <li key={k}><span className="wb-ver-act wb-ver-act-keep">{t('ver.a.keep')}</span><span className="wb-mono">{k}</span></li>)}</ul></div>
      )}
      <p className="wb-sub">{t('ver.kept')}</p>
      <div className="wb-actions wb-modal-actions">
        <button className="wb-btn" onClick={onClose}>{t('cancel')}</button>
        <button className="wb-btn wb-primary" disabled={!p || busy} onClick={go}>{busy ? <Loader2 size={13} className="wb-spin" /> : <Undo2 size={13} />}{t('ver.rewindGo')}</button>
      </div>
    </Modal>
  )
}

/** On from a step with the folder as it is: optionally what that step should do differently (its agent is told). */
export function ContinueDialog({ run, step, onClose, onDone, toast, steps }) {
  const t = useT()
  const [from, setFrom] = useState(step)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true); setError('')
    try { const r = await call('continueRun', { id: run.id, from, note }); toast?.('ok', t('ver.goneOn', { step: stepWord(t, r.from) })); onDone?.(r); onClose() } catch (err) { setError(errorText(t, err)) }
    setBusy(false)
  }
  return (
    <Modal title={t('ver.continueTitle', { step: stepWord(t, from) })} onClose={onClose}>
      <p className="wb-ver-explain">{t('ver.continueExplain')}</p>
      {steps?.length > 1 && (
        <label className="wb-field"><span>{t('ver.fromStep')}</span>
          <select className="wb-input" value={from} onChange={e => setFrom(e.target.value)}>{steps.map(k => <option key={k} value={k}>{stepWord(t, k)}</option>)}</select>
        </label>
      )}
      <label className="wb-field"><span>{t('ver.note')}</span>
        <textarea className="wb-input" rows={3} value={note} placeholder={t('ver.notePh')} onChange={e => setNote(e.target.value)} />
      </label>
      {ACTIVE.has(run.status) && <div className="wb-note wb-t-amber"><AlertTriangle size={13} /> {t('ver.stopsFirst')}</div>}
      {error && <div className="wb-note wb-t-red">{error}</div>}
      <div className="wb-actions wb-modal-actions">
        <button className="wb-btn" onClick={onClose}>{t('cancel')}</button>
        <button className="wb-btn wb-primary" disabled={busy} onClick={go}>{busy ? <Loader2 size={13} className="wb-spin" /> : <Play size={13} />}{t('ver.continueGo')}</button>
      </div>
    </Modal>
  )
}

export function Modal({ title, onClose, children, wide }) {
  const t = useT()
  useEffect(() => { const k = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  return (
    <div className="wb-modal-wrap" onClick={onClose}>
      <div className={cx('wb-modal', wide && 'wb-modal-wide')} role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="wb-drawer-head"><h3>{title}</h3><button className="wb-icon-btn" onClick={onClose} title={t('close')}><X size={16} /></button></div>
        {children}
      </div>
    </div>
  )
}

// ── the files tab ──
/**
 * The run's folder through its versions: on the left the versions (or the files of the latest), on the right what the
 * chosen version changed — or one file: its versions, its content at one, the difference between two, and an edit.
 * `focus`: { commit } or { path } to open on (a step's chip, a card).
 */
export function FilesTab({ run, focus, toast, onContinue }) {
  const t = useT()
  const { data, error, reload } = useVersions(run)
  const [side, setSide] = useState(focus?.path ? 'files' : 'versions')
  const [sel, setSel] = useState(focus || null)
  useEffect(() => { if (focus) { setSel(focus); setSide(focus.path ? 'files' : 'versions') } }, [focus])
  const commits = data?.commits || []
  const latest = commits.at(-1)?.commit
  // (nothing chosen yet: the latest version)
  const shown = sel || (latest ? { commit: latest } : null)
  if (error) return <div className="wb-note wb-t-red">{error}</div>
  if (!data) return <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div>
  if (!data.on) return <div className="wb-empty-small">{data.off ? t('ver.off', { why: data.off }) : t('ver.none')}</div>
  return (
    <div className="wb-files">
      <aside className="wb-files-side">
        <div className="wb-seg">
          <button className={cx(side === 'versions' && 'wb-on')} onClick={() => setSide('versions')}>{t('ver.versions', { n: commits.length })}</button>
          <button className={cx(side === 'files' && 'wb-on')} onClick={() => setSide('files')}>{t('ver.allFiles')}</button>
        </div>
        {side === 'versions'
          ? <VersionList commits={commits} selected={shown?.commit && !shown.path ? shown.commit : null} onPick={c => setSel({ commit: c })} />
          : <FileList run={run} at={latest} selected={shown?.path} onPick={p => setSel({ path: p })} />}
      </aside>
      <section className="wb-files-main">
        {shown?.path
          ? <FileView key={shown.path} run={run} path={shown.path} commits={commits} toast={toast} onSaved={reload} onContinue={onContinue} at={shown.commit} />
          : shown?.commit && <VersionView run={run} commit={shown.commit} commits={commits} onFile={p => setSel({ path: p, commit: shown.commit })} />}
      </section>
    </div>
  )
}

/** The versions, newest on top: what each is, when, and where going back went to. */
export function VersionList({ commits, selected, onPick }) {
  const t = useT()
  const [hover, setHover] = useState(null)
  const list = [...commits].reverse()
  return (
    <ol className="wb-vers">
      {list.map((c, i) => {
        const Icon = c.mark?.kind === 'step' && c.mark.status === 'failed' ? XCircle : VERSION_ICON[c.mark?.kind] || Circle
        const target = c.mark?.kind === 'rewind' ? c.mark.to : null
        return (
          <li key={c.commit} className={cx('wb-ver', `wb-t-${toneOf(c)}`, selected === c.commit && 'wb-on', hover && hover === c.commit && 'wb-ver-target', i === 0 && 'wb-ver-head')}>
            <button onClick={() => onPick(c.commit)} onMouseEnter={() => target && setHover(target)} onMouseLeave={() => setHover(null)}>
              <span className="wb-ver-dot"><Icon size={12} /></span>
              <span className="wb-ver-main">
                <b>{versionWhat(t, c)}</b>
                <span className="wb-sub">{when(c.at)} · <span className="wb-mono">{short(c.commit)}</span>{target && <> · <RotateCcw size={10} /> {t('ver.backTo', { id: short(target) })}</>}{i === 0 && <span className="wb-tag">{t('ver.now')}</span>}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/** The files of the latest version, by folder. */
function FileList({ run, at, selected, onPick }) {
  const t = useT()
  const [files, setFiles] = useState(null)
  useEffect(() => { call('versionFiles', { id: run.id, commit: 'HEAD' }).then(r => setFiles(r.files), () => setFiles([])) }, [run.id, at])
  if (!files) return <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div>
  if (!files.length) return <div className="wb-empty-small">{t('ver.noFiles')}</div>
  let last = ''
  return (
    <ul className="wb-file-list">
      {files.map(f => {
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
        const head = dir !== last ? (last = dir, dir) : null
        const name = f.path.slice(dir ? dir.length + 1 : 0)
        return [
          head !== null && head !== '' && <li key={`d:${dir}`} className="wb-file-dir"><Folder size={12} />{dir}/</li>,
          <li key={f.path}><button className={cx(selected === f.path && 'wb-on', dir && 'wb-file-in')} onClick={() => onPick(f.path)}>
            {/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name) ? <ImageIcon size={12} /> : <FileText size={12} />}<span>{name}</span>{f.size !== null && <span className="wb-dim">{bytes(f.size)}</span>}
          </button></li>,
        ]
      })}
    </ul>
  )
}

/** One version: what it is, what it changed (each file's difference), each file a click away from its own versions. */
function VersionView({ run, commit, commits, onFile }) {
  const t = useT()
  const [files, setFiles] = useState(null)
  const [diff, setDiff] = useState(null)
  const [error, setError] = useState('')
  const c = commits.find(x => x.commit === commit)
  const images = useMemo(() => (files || []).filter(f => f.status !== 'D' && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.path)).map(f => f.path), [files])
  useEffect(() => {
    let off = false
    setFiles(null); setDiff(null); setError('')
    call('versionChanges', { id: run.id, commit }).then(r => off || setFiles(r.files), err => off || setError(errorText(t, err)))
    call('fileDiff', { id: run.id, to: commit }).then(r => off || setDiff(r.diff), () => off || setDiff(''))
    return () => { off = true }
  }, [run.id, commit])
  return (
    <div className="wb-ver-view">
      <div className={cx('wb-ver-title', `wb-t-${toneOf(c)}`)}>
        <span className="wb-ver-dot">{(() => { const I = VERSION_ICON[c?.mark?.kind] || Circle; return <I size={13} /> })()}</span>
        <div><h3>{versionWhat(t, c)}</h3><span className="wb-sub">{c && when(c.at)} · <span className="wb-mono">{short(commit)}</span>{c?.mark?.big?.length > 0 && <> · {t('ver.bigLeft', { n: c.mark.big.length })}</>}</span></div>
      </div>
      {error && <div className="wb-note wb-t-red">{error}</div>}
      {files && (files.length ? (
        <ul className="wb-ver-files">
          {files.map(f => (
            <li key={f.path}>
              <span className={cx('wb-ver-st', `wb-ver-st-${f.status}`)}>{t(ST[f.status] || 'ver.st.changed')}</span>
              <button className="wb-linkbtn wb-mono" onClick={() => onFile(f.path)}>{f.path}</button>
              {f.from && <span className="wb-dim wb-mono">← {f.from}</span>}
              {f.added !== null && <span className="wb-diff-n"><b className="wb-c-green">+{f.added}</b> <b className="wb-c-red">−{f.removed}</b></span>}
            </li>
          ))}
        </ul>
      ) : <p className="wb-sub">{t('ver.noFilesChanged')}</p>)}
      {images.length > 0 && <VersionImages run={run} commit={commit} paths={images} onFile={onFile} />}
      {diff === null ? <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div> : diff && <Diff text={diff} skip={images} />}
    </div>
  )
}

/** The images a version added or changed, as pictures (their difference is not lines). */
function VersionImages({ run, commit, paths, onFile }) {
  const [shown, setShown] = useState({})
  useEffect(() => {
    let off = false
    setShown({})
    for (const p of paths.slice(0, 12)) call('fileAt', { id: run.id, commit, path: p }).then(f => off || setShown(x => ({ ...x, [p]: f.image || null })), () => {})
    return () => { off = true }
  }, [run.id, commit, paths.join('|')])
  return (
    <div className="wb-ver-imgs">
      {paths.slice(0, 12).map(p => (
        <button key={p} type="button" className="wb-ver-img" onClick={() => onFile(p)} title={p}>
          {shown[p] ? <img src={shown[p]} alt={p} /> : <span className="wb-ver-img-wait"><ImageIcon size={16} /></span>}
          <small className="wb-mono">{p.split('/').pop()}</small>
        </button>
      ))}
    </div>
  )
}

/**
 * One file: its versions as a strip (each a step, an edit), its content at the chosen one, the difference between two,
 * and — at the latest — an edit that is kept as a version of its own, then the step to go on from.
 */
function FileView({ run, path, commits, toast, onSaved, onContinue, at }) {
  const t = useT()
  const [history, setHistory] = useState(null)
  const [pick, setPick] = useState(at || null) // the version shown
  const [other, setOther] = useState(null) // a second one: the difference
  const [file, setFile] = useState(null)
  const [diff, setDiff] = useState(null)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState(null) // the text being edited
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(null) // the version an edit made: go on from a step?
  const [n, setN] = useState(0)
  const [work, setWork] = useState(null) // the file as the folder holds it now (what an edit starts from)
  const [editBlob, setEditBlob] = useState(null)
  useEffect(() => { call('fileHistory', { id: run.id, path }).then(r => setHistory(r.history), err => setError(errorText(t, err))) }, [run.id, path, n, commits.length])
  useEffect(() => { setWork(null); call('fileAt', { id: run.id, commit: 'WORK', path }).then(setWork, () => setWork(false)) }, [run.id, path, n, commits.length])
  const versions = history || []
  const shownId = pick && versions.some(v => v.commit === pick) ? pick : versions[0]?.commit
  const atLatest = shownId && shownId === versions[0]?.commit
  const gone = versions[0]?.status === 'D'
  useEffect(() => {
    if (!shownId) return
    let off = false
    setFile(null); setDiff(null)
    const v = versions.find(x => x.commit === shownId)
    if (v?.status === 'D') { setFile({ removed: true }); return }
    call('fileAt', { id: run.id, commit: shownId, path: v?.path || path }).then(f => off || setFile(f), err => off || setError(errorText(t, err)))
    if (other) call('fileDiff', { id: run.id, from: other, to: shownId, path: v?.path || path }).then(r => off || setDiff(r.diff), err => off || setError(errorText(t, err)))
    return () => { off = true }
  }, [run.id, shownId, other, history])
  const save = async () => {
    setBusy(true); setError('')
    try {
      const v = await call('editFile', { id: run.id, path, content: edit, blob: editBlob })
      setEdit(null); setPick(null); setOther(null); setN(x => x + 1); onSaved?.()
      if (v.made) setSaved(v); else toast?.('ok', t('ver.unchanged'))
    } catch (err) { setError(errorText(t, err)) }
    setBusy(false)
  }
  // the step to go on from after an edit: the one after the step that made the file's last version
  const maker = versions.find(v => v.mark?.kind === 'step')?.mark?.step
  const keys = run.stages.map(s => s.key)
  const next = maker ? keys[keys.indexOf(maker) + 1] : null
  const md = /\.(md|markdown)$/i.test(path)
  // (an edit: of the latest version, a text file, while no step works in the folder — a run waiting for the person is fine)
  const canEdit = atLatest && !gone && (work ? work.text !== undefined && !work.cut : file?.text !== undefined && !file.cut) && edit === null && (!ACTIVE.has(run.status) || run.status === 'waiting')
  return (
    <div className="wb-file-view">
      <div className="wb-file-head">
        <FileText size={15} /><h3 className="wb-mono">{path}</h3>
        {file?.size !== undefined && <span className="wb-dim">{bytes(file.size)}</span>}
        <span className="wb-push" />
        {canEdit && <button className="wb-btn wb-small" onClick={() => { setEdit(work?.text ?? file.text); setEditBlob(work ? work.blob : file.blob); setSaved(null) }}><Pencil size={12} />{t('ver.edit')}</button>}
        {versions.length > 1 && !edit && <button className={cx('wb-btn wb-small', other && 'wb-on')} onClick={() => setOther(other ? null : versions.find(v => v.commit !== shownId && v.status !== 'D')?.commit || null)}><ArrowLeftRight size={12} />{other ? t('ver.hideDiff') : t('ver.compare')}</button>}
      </div>
      {error && <div className="wb-note wb-t-red">{error}</div>}
      {atLatest && work && file?.blob && work.blob !== file.blob && <div className="wb-note wb-t-amber"><AlertTriangle size={13} /> {t('ver.newerInFolder')}</div>}
      {saved && (
        <div className="wb-note wb-t-green wb-ver-saved">
          <CheckCircle2 size={13} /> {t('ver.saved', { id: short(saved.commit) })}
          {/* a run waiting for the person: the steps after the wait read the change once they answer — nothing to restart */}
          {run.status === 'waiting'
            ? <span>{t('ver.savedWaiting', { step: stepWord(t, run.stage) })}</span>
            : <>
              {next && <button className="wb-btn wb-small wb-primary" onClick={() => onContinue?.(next)}><Play size={12} />{t('ver.goOnFrom', { step: stepWord(t, next) })}</button>}
              <button className="wb-btn wb-small" onClick={() => onContinue?.(next || keys[0])}>{t('ver.goOnOther')}</button>
            </>}
          <button className="wb-icon-btn" onClick={() => setSaved(null)} title={t('close')}><X size={13} /></button>
        </div>
      )}
      {/* the file's versions: newest on the right, each named by what made it */}
      {versions.length > 0 && (
        <div className="wb-strip" role="list">
          {[...versions].reverse().map(v => (
            <button key={v.commit} role="listitem" className={cx('wb-strip-dot', `wb-t-${toneOf(v)}`, v.commit === shownId && 'wb-on', v.commit === other && 'wb-strip-other')}
              onClick={e => (e.shiftKey || other) && v.commit !== shownId ? setOther(v.commit) : setPick(v.commit)} title={`${versionWhat(t, v)} · ${when(v.at)}`}>
              <span className="wb-strip-mark">{v.status === 'A' ? <FilePlus2 size={11} /> : v.status === 'D' ? <X size={11} /> : (() => { const I = VERSION_ICON[v.mark?.kind] || Circle; return <I size={11} /> })()}</span>
              <small>{versionWhat(t, v)}</small>
            </button>
          ))}
        </div>
      )}
      {versions.length > 1 && <p className="wb-sub">{t(other ? 'ver.diffHint' : 'ver.stripHint')}</p>}
      {edit !== null ? (
        <div className="wb-editor">
          <textarea className="wb-input wb-mono" value={edit} onChange={e => setEdit(e.target.value)} spellCheck={false} />
          <div className="wb-actions">
            <span className="wb-sub">{t('ver.editHint')}</span>
            <span className="wb-push" />
            <button className="wb-btn" onClick={() => setEdit(null)}>{t('cancel')}</button>
            <button className="wb-btn wb-primary" disabled={busy || edit === file?.text} onClick={save}>{busy ? <Loader2 size={13} className="wb-spin" /> : <Save size={13} />}{t('ver.save')}</button>
          </div>
        </div>
      ) : other ? (diff === null ? <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div> : <Diff text={diff} label={path} />)
        : !file ? (history && !versions.length ? <div className="wb-empty-small">{t('ver.noHistory')}</div> : <div className="wb-empty-small"><Loader2 size={14} className="wb-spin" /></div>)
          : file.removed ? <div className="wb-empty-small">{t('ver.removedHere')}</div>
            : file.image ? <img className="wb-shot" src={file.image} alt={path} />
              : file.binary ? <div className="wb-empty-small">{t('ver.binarySize', { size: bytes(file.size) })}</div>
                : md ? <div className="wb-md"><Md text={file.text} /></div> : <pre className="wb-pre wb-pre-tall">{file.text}</pre>}
      {file?.cut && <p className="wb-sub">{t('ver.cut')}</p>}
    </div>
  )
}
