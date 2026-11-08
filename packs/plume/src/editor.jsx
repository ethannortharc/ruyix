// The review card of each platform's version (a decision editor, payload.editor 'plume.posts'): a tab per platform with
// its preview, its checks and — while the card is open — its fields to edit. Saving writes the platform's file as a new
// version and makes its cards again; the run goes on with what the folder holds when the person approves.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, Save, XCircle } from 'lucide-react'
import { charCount, textIssues, weighted } from '../lib/platforms.js'
import { tr } from './locale.js'
import { ReuseButton } from './reuse.jsx'
import { Preview } from './previews.jsx'
import { AdaptationReview } from './adaptation.jsx'

// the fields as text a person edits, and back
const toText = {
  tags: v => (v || []).join(' '),
  cards: v => (v || []).map(c => [c.heading, ...(c.points || [])].join('\n')).join('\n\n'),
  tweets: v => (v || []).join('\n\n'),
}
const fromText = {
  tags: s => s.split(/[\s,，、#]+/).map(x => x.trim()).filter(Boolean),
  cards: s => s.split(/\n\s*\n/).map(b => b.split('\n').map(l => l.replace(/^[-•·*]\s*/, '').trim()).filter(Boolean)).filter(b => b.length).map(([heading, ...points]) => ({ heading, points })),
  tweets: s => s.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean),
}
/** A platform's fields as the form shows them: [{ key, label, kind: line | area, value, count? }]. */
function formOf(p, f, t) {
  const lim = k => p.limits.find(l => l.key === k)?.value
  if (p.id === 'xhs') return [
    { key: 'title', label: t('f.title'), kind: 'line', value: f.title, count: [charCount(f.title), lim('titleMax')] },
    { key: 'body', label: t('f.body'), kind: 'area', rows: 10, value: f.body, count: [charCount(f.body), lim('bodyMax')] },
    { key: 'tags', label: t('f.tags'), kind: 'line', value: toText.tags(f.tags) },
    { key: 'cover.title', label: t('f.coverTitle'), kind: 'line', value: f.cover?.title || '' },
    { key: 'cover.subtitle', label: t('f.coverSubtitle'), kind: 'line', value: f.cover?.subtitle || '' },
    { key: 'cards', label: t('f.cards'), kind: 'area', rows: 10, value: toText.cards(f.cards) },
  ]
  if (p.id === 'x') return [{ key: 'tweets', label: t('f.tweets'), kind: 'area', rows: 12, value: toText.tweets(f.tweets), weighted: lim('tweetMax') }]
  return [
    { key: 'title', label: t('f.title'), kind: 'line', value: f.title, count: [charCount(f.title), lim('titleMax')] },
    { key: 'digest', label: t('f.digest'), kind: 'area', rows: 2, value: f.digest, count: [charCount(f.digest), lim('digestMax')] },
    { key: 'author', label: t('f.author'), kind: 'line', value: f.author },
    { key: 'body', label: t('f.bodyMd'), kind: 'area', rows: 16, value: f.body },
  ]
}
/** A form's text back into the platform's fields. */
function fieldsFrom(p, text) {
  if (p.id === 'xhs') return { title: text.title, body: text.body, tags: fromText.tags(text.tags), cover: { title: text['cover.title'], subtitle: text['cover.subtitle'] }, cards: fromText.cards(text.cards) }
  if (p.id === 'x') return { tweets: fromText.tweets(text.tweets) }
  return { title: text.title, digest: text.digest, author: text.author, body: text.body }
}

const LEVEL = { error: XCircle, warning: AlertTriangle, info: Info }
export function Issues({ issues, lang }) {
  const t = tr(lang)
  if (!issues.length) return <div className="pl-ok"><CheckCircle2 size={13} />{t('pl.noIssues')}</div>
  return (
    <ul className="pl-issues">
      {issues.map((i, k) => { const I = LEVEL[i.level] || Info; return <li key={k} className={`pl-${i.level}`}><I size={13} /><span className="pl-level">{t(`pl.${i.level}`)}</span>{String(lang).startsWith('zh') ? i.zh : i.en}</li> })}
    </ul>
  )
}
export const toneOf = issues => (issues.some(i => i.level === 'error') ? 'error' : issues.some(i => i.level === 'warning') ? 'warning' : 'ok')

export function PostsEditor({ run, open, lang, call, onBlocked, onDirty, onPayload }) {
  const t = tr(lang)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState(null)
  const [text, setText] = useState({}) // platform → { field: text } being edited
  const [saving, setSaving] = useState('')
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(false), [stale, setStale] = useState(false)
  const current = useRef(null), request = useRef(0), owner = useRef(run.id)
  const p = data?.platforms.find(x => x.id === tab)
  const form = useMemo(() => (p ? formOf(p, p.fields, t) : []), [p, lang])
  const mine = p && (text[p.id] || Object.fromEntries(form.map(f => [f.key, f.value])))
  const dirty = p && text[p.id] && form.some(f => text[p.id][f.key] !== f.value)
  const anyDirty = Object.entries(text).some(([id, values]) => { const p = data?.platforms.find(p => p.id === id); return p && formOf(p, p.fields, t).some(f => values[f.key] !== f.value) })
  const hasErrors = data?.platforms.some(p => textIssues(p.issues).some(i => i.level === 'error'))
  current.current = { data, text, anyDirty, saving }
  const load = async (discard = false) => {
    if (owner.current !== run.id) {
      owner.current = run.id
      current.current = { data: null, text: {}, anyDirty: false, saving: '' }
      setData(null); setText({}); setSaving(''); setSaved(''); setError(''); setStale(false)
    }
    const before = current.current
    if (before.saving) return
    if (discard === true && before.anyDirty && !window.confirm(t('pl.discardDrafts'))) return
    const seq = ++request.current
    setLoading(true)
    try {
      const d = await call('posts', { run: run.id })
      if (seq !== request.current || owner.current !== run.id) return
      const now = current.current
      // Keep drafts from every platform and the exact versions they were based on. Reload cannot discard later typing.
      if (now.anyDirty && !(discard === true && now.text === before.text)) {
        const versions = data => JSON.stringify(data?.platforms.map(p => [p.id, p.digest]))
        const changed = versions(d) !== versions(now.data)
        setStale(changed)
        if (!changed) setData(d)
        return
      }
      setData(d); setText({}); setTab(x => d.platforms.some(p => p.id === x) ? x : d.platforms[0]?.id); setStale(false)
      // An automatic refresh after a failed rebuild must not hide the reason it failed.
      if (discard === true || !now.data) setError('')
    } catch (err) { if (seq === request.current) setError(err.message) }
    finally { if (seq === request.current) setLoading(false) }
  }
  const editVersion = (run.edits || []).map(e => `${e.path}:${e.version || ''}:${e.at || ''}`).join('|')
  useEffect(() => { load() }, [run.id, run.contentRevision, editVersion, saving])
  useEffect(() => () => { ++request.current }, [])
  useEffect(() => { onBlocked?.(!!open && (!data || anyDirty || !!saving || loading || stale || !!error || hasErrors)); return () => onBlocked?.(false) }, [open, !!data, anyDirty, saving, loading, stale, error, hasErrors])
  useEffect(() => { onDirty?.(!!anyDirty || !!saving); return () => onDirty?.(false) }, [anyDirty, saving])
  useEffect(() => { if (open && data) onPayload?.({ plumeDigests: Object.fromEntries(data.platforms.map(p => [p.id, p.digest])) }) }, [open, data])
  // what is being typed shows in the preview as it is typed
  const live = p && dirty ? { ...p, fields: { ...p.fields, ...fieldsFrom(p, mine) } } : p
  const set = (k, v) => setText(x => ({ ...x, [p.id]: { ...mine, [k]: v } }))
  const save = async () => {
    if (current.current.saving || stale) return
    const seq = ++request.current
    current.current = { ...current.current, saving: p.id }
    setLoading(false)
    setSaving(p.id); setError(''); setSaved('')
    try {
      const next = await call('savePost', { run: run.id, platform: p.id, fields: fieldsFrom(p, mine), expectedDigest: p.digest })
      if (seq !== request.current || owner.current !== run.id) return
      setData(d => ({ ...d, platforms: d.platforms.map(x => (x.id === next.id ? next : x)) }))
      setText(x => { if (x[p.id] !== mine) return x; const y = { ...x }; delete y[p.id]; return y })
      setSaved(p.id)
    } catch (err) { if (seq === request.current) setError(err.message) }
    finally { if (seq === request.current) { current.current = { ...current.current, saving: '' }; setSaving('') } }
  }
  if (error && !data) return <div className="wb-note wb-t-red">{error} <button className="wb-btn wb-small" disabled={loading} onClick={() => load()}>{t('pl.retry')}</button></div>
  if (!data || owner.current !== run.id) return <div className="pl-wait"><Loader2 size={14} className="wb-spin" />{t('pl.loading')}</div>
  return (
    <div className="pl-editor">
      {(error || stale) && <div className="wb-note wb-t-red" role="alert">{stale ? t('pl.staleDrafts') : error} <button className="wb-btn wb-small" disabled={!!saving || loading} onClick={() => load(true)}>{t('pl.retry')}</button></div>}
      <div className="pl-tabs" role="tablist">
        {data.platforms.map(x => <button key={x.id} role="tab" aria-selected={x.id === tab} className={x.id === tab ? 'pl-on' : ''} onClick={() => setTab(x.id)}><i className={`pl-dot pl-${toneOf(x.issues)}`} />{t(`pl.${x.id}`)}</button>)}
      </div>
      {data.reusable && <ReuseButton run={run} call={call} lang={lang} disabled={!!anyDirty || !!saving} />}
      {p && (
        <div className="pl-split">
          <div className="pl-left"><Preview run={run} p={live} accent={data.accent} /></div>
          <div className="pl-right">
            <h5>{t('pl.issues')}</h5>
            <Issues issues={p.issues} lang={lang} />
            <AdaptationReview key={`${run.id}:${p.id}`} p={p} run={run} lang={lang} call={call} dirty={!!dirty} disabled={!!anyDirty || !!saving || loading || stale || p.frozen} />
            {p.frozen && <p className="wb-note">{t('pl.frozen')}</p>}
            {(open || ['done', 'failed', 'cancelled'].includes(run.status)) && !p.frozen && (
              <div className="pl-form">
                {form.map(f => (
                  <label key={f.key} className="pl-field">
                    <span>{f.label}{f.count && f.count[1] && <em className={charCount(mine[f.key]) > f.count[1] ? 'pl-over' : ''}>{t('pl.count', { n: charCount(mine[f.key]), max: f.count[1] })}</em>}</span>
                    {f.kind === 'line'
                      ? <input className="wb-input" value={mine[f.key] ?? ''} onChange={e => set(f.key, e.target.value)} />
                      : <textarea className="wb-input" rows={f.rows} value={mine[f.key] ?? ''} onChange={e => set(f.key, e.target.value)} />}
                    {f.weighted && <small>{fromText.tweets(mine[f.key] || '').map((tw, k) => { const n = weighted(tw); return <span key={k} className={n > f.weighted ? 'pl-over' : ''}>#{k + 1} {t('pl.weighted', { n, max: f.weighted })} </span> })}</small>}
                  </label>
                ))}
                <div className="pl-form-actions">
                  {saved === p.id && !dirty && <span className="pl-ok"><CheckCircle2 size={13} />{t('pl.saved')}</span>}
                  <button className="wb-btn wb-small wb-primary" disabled={(!dirty && !p.issues.some(i => i.code === 'render.changed')) || !!saving || stale} onClick={save}>{saving === p.id ? <><Loader2 size={12} className="wb-spin" />{t('pl.saving')}</> : <><Save size={12} />{t('pl.save')}</>}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
