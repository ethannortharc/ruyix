// A publish card (plume_publish_<platform>): what goes out, how (X through its API, 小红书 in a browser the person
// watches, 公众号 pasted in by the person — its steps here), the checks once more (an error holds the card back), and
// once it is out, where.
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, ExternalLink, Loader2 } from 'lucide-react'
import { charCount } from '../lib/platforms.js'
import { cleanHtml } from './clean.js'
import { ReuseButton } from './reuse.jsx'
import { Issues } from './editor.jsx'
import { tr } from './locale.js'
import { API, Preview } from './previews.jsx'
import { AdaptationReview } from './adaptation.jsx'

/** Rich text to the clipboard (the 公众号 editor keeps its inline styles), plain text beside it — only cleaned HTML. */
async function copyRich(raw, text) {
  const html = cleanHtml(raw)
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
    return true
  } catch { /* an older browser, or not a secure page: the selection way */ }
  const div = Object.assign(document.createElement('div'), { contentEditable: 'true', innerHTML: html })
  Object.assign(div.style, { position: 'fixed', left: '-10000px', top: '0' })
  document.body.appendChild(div)
  const range = document.createRange(), sel = getSelection()
  range.selectNodeContents(div); sel.removeAllRanges(); sel.addRange(range)
  try { return document.execCommand('copy') }
  finally { sel.removeAllRanges(); div.remove() }
}
async function copyText(text) { try { await navigator.clipboard.writeText(text); return true } catch { return copyRich(text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]), text) } }

function CopyButton({ t, get, rich, onCopied, onReload }) {
  const [state, setState] = useState('')
  const [error, setError] = useState('')
  const go = async () => {
    setState('busy'); setError('')
    try { const v = await get(); const ok = rich ? await copyRich(v.html, v.text) : await copyText(v); if (!ok) throw new Error(t('mp.copyFailed')); setState('done'); onCopied?.() }
    catch (err) { setState('failed'); setError(err.message || t('mp.copyFailed')) }
  }
  return <span><button className="wb-btn wb-small" onClick={go} disabled={state === 'busy'}>{state === 'done' ? <Check size={12} /> : state === 'busy' ? <Loader2 size={12} className="wb-spin" /> : <Copy size={12} />}{t(state === 'done' ? 'mp.copied' : 'mp.copy')}</button>{state === 'failed' && <small className="wb-c-red" role="alert">{error} {onReload && <button className="wb-btn wb-small" onClick={onReload}>{t('pl.retry')}</button>}</small>}</span>
}

/** 公众号: the steps of pasting it in, each done once (ticked in this browser). */
function MpSteps({ t, run, p, call, open, url, setUrl, onReload }) {
  const key = `plume.mp.${run.id}.${p.digest}`
  const [ticked, setTicked] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) || {} } catch { return {} } })
  const tick = n => setTicked(x => { const y = { ...x, [n]: true }; try { localStorage.setItem(key, JSON.stringify(y)) } catch { /* private mode */ } return y })
  const cover = p.images.find(i => i.seq)
  const article = async () => { const r = await call('article', { run: run.id, digest: p.digest }); return { html: r.html, text: p.fields.body } }
  const steps = [
    { n: 1, label: t('mp.s1'), action: <a className="wb-btn wb-small" href={p.creator} target="_blank" rel="noreferrer" onClick={() => tick(1)}><ExternalLink size={12} />{t('mp.openSite')}</a> },
    { n: 2, label: `${t('mp.s2')}：${p.fields.title}`, action: <CopyButton t={t} get={() => p.fields.title} onCopied={() => tick(2)} onReload={onReload} /> },
    { n: 3, label: `${t('mp.s3')}（${charCount(p.fields.digest)}）`, action: <CopyButton t={t} get={() => p.fields.digest} onCopied={() => tick(3)} onReload={onReload} /> },
    { n: 4, label: t('mp.s4'), action: <CopyButton t={t} rich get={article} onCopied={() => tick(4)} onReload={onReload} /> },
    ...(cover ? [{ n: 5, label: t('mp.s5'), action: <a className="wb-btn wb-small" href={`${API}/file?run=${encodeURIComponent(run.id)}&seq=${cover.seq}&download=1`} onClick={() => tick(5)}><Download size={12} />{t('mp.download')}</a> }] : []),
  ]
  return (
    <ol className="pl-steps">
      {steps.map(s => <li key={s.n} className={ticked[s.n] ? 'pl-done' : ''}><span className="pl-step-n">{ticked[s.n] ? <Check size={11} /> : s.n}</span><span className="pl-step-label">{s.label}</span>{open && s.action}</li>)}
      {open && <li><span className="pl-step-n">{steps.length + 1}</span><span className="pl-step-label">{t('mp.s6')}</span>
        <input className="wb-input pl-url" value={url} placeholder={t('mp.url')} onChange={e => setUrl(e.target.value)} /></li>}
    </ol>
  )
}

export function PublishBody({ a, run, open, call, lang, onPayload, onBlocked }) {
  const t = tr(lang)
  const id = a.payload?.platform
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(''), [refresh, setRefresh] = useState(0)
  const editVersion = (run.edits || []).map(e => `${e.path}:${e.version || ''}:${e.at || ''}`).join('|')
  useEffect(() => { let active = true; setLoadError(''); setData(null); call('posts', { run: run.id }).then(d => { if (active) setData(d) }, err => { if (active) setLoadError(err.message) }); return () => { active = false } }, [run.id, a.status, run.contentRevision, editVersion, refresh])
  const [url, setUrl] = useState('')
  const [postId, setPostId] = useState(''), [notPosted, setNotPosted] = useState(false)
  const [resolutionBusy, setResolutionBusy] = useState(false), [resolutionError, setResolutionError] = useState(''), [resolutionRecorded, setResolutionRecorded] = useState(false)
  const resolutionLock = useRef(false), resolutionRequest = useRef(0)
  useEffect(() => {
    ++resolutionRequest.current; resolutionLock.current = false
    setResolutionBusy(false); setResolutionError(''); setResolutionRecorded(false)
    return () => { ++resolutionRequest.current }
  }, [run.id, id])
  const live = data?.platforms.find(x => x.id === id)
  const p = live || (a.payload && { id, fields: a.payload.fields, images: a.payload.images || [], issues: a.payload.issues || [], limits: [], creator: '' })
  const uncertain = live?.published?.uncertain
  const resolved = !uncertain || /^\d{1,30}$/.test(postId.trim()) || notPosted
  useEffect(() => { setPostId(''); setNotPosted(false) }, [uncertain?.attempt])
  const errors = (p?.issues || []).filter(i => i.level === 'error').length
  // what is approved is what is shown here: its digest goes with the approval (changed meanwhile, the action refuses)
  useEffect(() => { if (open && live) onPayload?.({ digest: live.digest, url: url.trim(), ...(uncertain && { xResolution: { attempt: uncertain.attempt, postId: postId.trim(), notPosted } }) }) }, [open, live?.digest, url, uncertain?.attempt, postId, notPosted])
  useEffect(() => { onBlocked?.(open && (!live || errors > 0 || !resolved || resolutionBusy)); return () => onBlocked?.(false) }, [open, !!live, errors, resolved, resolutionBusy])
  const [said, setSaid] = useState('')
  const [link, setLink] = useState('')
  const mark = async () => { try { await call('markPublished', { run: run.id, platform: id, url: link.trim() }); setSaid('done'); setData(await call('posts', { run: run.id })) } catch (err) { setSaid(err.message) } }
  const recordOutcome = async () => {
    if (resolutionLock.current || !live?.digest || !uncertain || !resolved) return
    const request = ++resolutionRequest.current
    resolutionLock.current = true; setResolutionBusy(true); setResolutionError(''); setResolutionRecorded(false)
    try {
      await call('resolveXOutcome', { run: run.id, expectedDigest: live.digest, attempt: uncertain.attempt, postId: postId.trim(), notPosted })
      if (request !== resolutionRequest.current) return
      setPostId(''); setNotPosted(false); setResolutionRecorded(true); setRefresh(n => n + 1)
    } catch (err) { if (request === resolutionRequest.current) setResolutionError(err.message) }
    finally { if (request === resolutionRequest.current) { resolutionLock.current = false; setResolutionBusy(false) } }
  }
  if (!p) return null
  const pub = live?.published || a.result
  return (
    <div className="pl-publish">
      {loadError && <div className="wb-note wb-t-red">{loadError} <button className="wb-btn wb-small" onClick={() => setRefresh(n => n + 1)}>{t('pl.retry')}</button></div>}
      {data?.reusable && <ReuseButton run={run} call={call} lang={lang} />}
      {id === 'x' && <p className="pl-how">{t('pub.x', { thread: (p.fields.tweets || []).length > 1 ? t('pub.xThread', { n: p.fields.tweets.length }) : t('pub.xOne') })}</p>}
      {open && id === 'x' && uncertain && <div className="wb-note"><p>{t('pub.xUnknown')}</p><p>{uncertain.text}</p><input className="wb-input" disabled={resolutionBusy} value={postId} onChange={e => { setPostId(e.target.value); setNotPosted(false) }} placeholder={t('pub.xPostId')} /><label><input type="checkbox" disabled={resolutionBusy} checked={notPosted} onChange={e => { setNotPosted(e.target.checked); setPostId('') }} />{t('pub.xNotPosted')}</label>
        <p>{t('pub.xRecordHint')}</p><button className="wb-btn wb-small" disabled={resolutionBusy || !live?.digest || !resolved} onClick={recordOutcome}>{resolutionBusy ? <Loader2 size={12} className="wb-spin" /> : <Check size={12} />}{t('pub.xRecord')}</button>
        {resolutionError && <p className="wb-c-red" role="alert">{resolutionError}</p>}
      </div>}
      {resolutionRecorded && <p className="wb-sub" role="status">{t('pub.xRecorded')}</p>}
      {id === 'xhs' && <p className="pl-how">{t('pub.xhs')}</p>}
      {id === 'wechat_mp' && <p className="pl-how">{t('pub.mp')}</p>}
      {a.payload?.connection && id !== 'wechat_mp' && <p className="wb-sub">{t('pub.conn', { id: a.payload.connection })}</p>}
      <Issues issues={p.issues} lang={lang} />
      {live && <AdaptationReview key={`${run.id}:${id}`} p={live} run={run} lang={lang} call={call} disabled={!!live.frozen} />}
      {open && errors > 0 && <div className="wb-note wb-t-red">{t('pub.blocked', { p: id })}</div>}
      {id === 'wechat_mp' && data && <MpSteps key={`${run.id}:${p.digest}`} t={t} run={run} p={p} call={call} open={open && !!live && !errors} url={url} setUrl={setUrl} onReload={() => setRefresh(n => n + 1)} />}
      {pub?.url && /^https:\/\//.test(pub.url) && <p className="pl-ok"><Check size={13} />{t('pub.done')} <a href={pub.url} target="_blank" rel="noreferrer">{pub.url}</a></p>}
      {pub && !pub.url && pub.by && <p className="pl-ok"><Check size={13} />{t('pub.done')}</p>}
      {/* 小红书 when the browser did not see the site say so: the person says it is out */}
      {!open && a.status === 'done' && id === 'xhs' && !live?.published && (
        <div className="pl-mark">
          <span className="wb-sub">{t('pub.markHint')}</span>
          <input className="wb-input pl-url" value={link} placeholder={t('pub.markLink')} onChange={e => setLink(e.target.value)} />
          <button className="wb-btn wb-small" onClick={mark}><Check size={12} />{t('pub.mark')}</button>
          {said && said !== 'done' && <span className="wb-c-red">{said}</span>}
        </div>
      )}
      <details className="pl-peek" open={id !== 'wechat_mp'}><summary className="wb-sub">{t('pl.preview')}</summary><div className="pl-peek-body"><Preview run={run} p={p} accent={data?.accent} /></div></details>
    </div>
  )
}
