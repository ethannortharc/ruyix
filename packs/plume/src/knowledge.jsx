import { useEffect, useRef, useState } from 'react'
import { BookOpen, History, Loader2, Pause, Play, RefreshCw, Search } from 'lucide-react'
import { tr } from './locale.js'

const PLATFORMS = ['xhs', 'x', 'wechat_mp']
const WORKFLOW = 'plume.platform-research'
export const openRun = run => window.dispatchEvent(new CustomEvent('ruyix-workbench:open', { detail: { run } }))
// Old pinned versions remain traceable, but cannot inherit the newer research review's approval.
export const knowledgeUsable = profile => profile?.source === 'seed' || (profile?.source === 'reviewed' && profile.auditContract === 2)
export const knowledgeStale = profile => !!profile?.stale || !Number.isFinite(Date.parse(profile?.expiresAt)) || Date.parse(profile.expiresAt) <= Date.now()
export const dateText = (value, lang) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', ...(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) && { timeZone: 'UTC' }) }) : '—'
}
const safeUrl = value => {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null } catch { return null }
}
export async function workbenchCall(op, args = {}) {
  const response = await fetch('api/ruyix-workbench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...args }) })
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
  if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`)
  return result
}
const packCall = (op, args) => workbenchCall(`plume.${op}`, args)

function Sources({ sources = [], lang }) {
  const t = tr(lang)
  return <ol className="pl-knowledge-sources">{sources.map(source => {
    const url = safeUrl(source.url)
    return <li key={source.id}>
      <span className="pl-knowledge-tag">{t(`knowledge.${source.authority}`)}</span>{' '}
      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title}</a> : <span>{source.title}</span>}
      <small>{source.publisher}{source.publisher && ' · '}{t('knowledge.accessed')} {dateText(source.accessedAt, lang)}{source.publishedAt && ` · ${t('knowledge.published')} ${dateText(source.publishedAt, lang)}`}{source.availability !== 'read' && ` · ${t(`knowledge.${source.availability}`)}`}</small>
    </li>
  })}</ol>
}

function Profile({ profile, lang, call, history = true }) {
  const t = tr(lang), [versions, setVersions] = useState(null), [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const live = useRef(true), pending = useRef(false)
  const stale = knowledgeStale(profile), usable = knowledgeUsable(profile)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const showHistory = async () => {
    if (pending.current) return
    if (versions) { setExpanded(v => !v); return }
    pending.current = true; setBusy(true); setError('')
    try { const result = await call('knowledgeHistory', { platform: profile.platform }); if (live.current) { setVersions(result.versions); setExpanded(true) } }
    catch (e) { if (live.current) setError(e.message) }
    finally { pending.current = false; if (live.current) setBusy(false) }
  }
  return <article className="pl-knowledge-profile">
    <header><h3>{t(`pl.${profile.platform}`)}</h3><span>{t('knowledge.version')} {profile.revision}</span><span className={stale || !usable ? 'pl-knowledge-stale' : 'pl-knowledge-fresh'}>{t(!usable ? 'knowledge.excluded' : stale ? 'knowledge.stale' : 'knowledge.fresh')}</span></header>
    <p className="pl-knowledge-meta">{t(!usable ? 'knowledge.historical' : profile.source === 'seed' ? 'knowledge.seed' : 'knowledge.reviewed')} · {t('knowledge.updated')} {dateText(profile.researchedAt, lang)} · {t('knowledge.refreshBy')} {dateText(profile.expiresAt, lang)}</p>
    {!usable ? <p className="pl-knowledge-caveat">{t('knowledge.unverifiedSnapshot')}</p> : <><p>{profile.summary}</p>
    <ul className="pl-knowledge-observations">{(profile.observations || []).map(item => <li key={item.id}>
      <span className="pl-knowledge-tag">{t(`knowledge.${item.authority}`)}</span> <strong>{t(`dimension.${item.dimension}`)}</strong>
      <p>{item.statement}</p>{item.limitations && <small>{item.limitations}</small>}
      {!!item.sourceIds?.length && <small>{t('knowledge.basedOn')} {item.sourceIds.map(id => profile.sources.find(source => source.id === id)?.title || id).join(' · ')}</small>}
    </li>)}</ul>
    {!!profile.conflicts?.length && <div className="pl-knowledge-caveat"><strong>{t('knowledge.conflicts')}</strong><ul>{profile.conflicts.map((text, i) => <li key={i}>{typeof text === 'string' ? text : text.summary || text.statement}</li>)}</ul></div>}
    {!!profile.unknowns?.length && <div className="pl-knowledge-caveat"><strong>{t('knowledge.unknowns')}</strong><ul>{profile.unknowns.map((text, i) => <li key={i}>{typeof text === 'string' ? text : text.summary || text.statement}</li>)}</ul></div>}
    <details><summary>{t('knowledge.sources')} ({profile.sources?.length || 0})</summary><Sources sources={profile.sources} lang={lang} /></details></>}
    {history && <div className="pl-knowledge-history"><button className="st-btn st-btn-sm" disabled={busy} onClick={showHistory} aria-expanded={expanded}>{busy ? <Loader2 size={12} /> : <History size={12} />}{t('knowledge.history')}</button>
      {error && <p className="st-bad" role="alert">{error}</p>}
      {expanded && <div>{versions?.length ? versions.map(version => <details key={version.digest || version.revision}><summary>{t('knowledge.version')} {version.revision} · {dateText(version.researchedAt, lang)}</summary><Profile profile={version} lang={lang} call={call} history={false} /></details>) : <p className="st-quiet">{t('knowledge.noHistory')}</p>}</div>}
    </div>}
  </article>
}

/** A pack-owned Studio view: research is explicit; weekly work uses the workbench's ordinary task scheduler. */
export function PlatformKnowledge({ lang = 'zh', call = packCall, tasksCall = workbenchCall }) {
  const t = tr(lang), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [platform, setPlatform] = useState('')
  const [data, setData] = useState(null), [schedules, setSchedules] = useState(null), [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(''), [scheduleError, setScheduleError] = useState(''), [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(''), [lastRun, setLastRun] = useState(null), [notice, setNotice] = useState('')
  const seq = useRef(0), taskSeq = useRef(0), locked = useRef(false), live = useRef(true)
  const load = async (quiet = false) => {
    const id = ++seq.current
    if (!quiet) setLoading(true)
    try { const result = await call('knowledge', { query: search, ...(platform && { platform }) }); if (live.current && seq.current === id) { setData(result); setLoadError('') } }
    catch (e) { if (live.current && seq.current === id) setLoadError(e.message) }
    finally { if (live.current && seq.current === id) setLoading(false) }
  }
  const loadSchedules = async () => {
    const id = ++taskSeq.current
    try { const result = await call('knowledgeSchedules'); if (live.current && taskSeq.current === id) { setSchedules(result.tasks); setScheduleError('') }; return result.tasks }
    catch (e) { if (live.current && taskSeq.current === id) setScheduleError(e.message); throw e }
  }
  useEffect(() => { live.current = true; return () => { live.current = false; ++seq.current; ++taskSeq.current } }, [])
  useEffect(() => {
    load(); loadSchedules().catch(() => {})
    const update = () => { if (!document.hidden) { load(true); loadSchedules().catch(() => {}) } }
    const timer = setInterval(update, 30000)
    window.addEventListener('focus', update); window.addEventListener('ruyix:tasks', update)
    return () => { ++seq.current; ++taskSeq.current; clearInterval(timer); window.removeEventListener('focus', update); window.removeEventListener('ruyix:tasks', update) }
  }, [search, platform, call])
  const act = async (key, task) => {
    if (locked.current) return
    locked.current = true; setBusy(key); setActionError(''); setNotice('')
    try {
      const result = task ? await tasksCall('taskUpdate', { id: task.id, enabled: !task.enabled })
        : key === 'weekly' ? await call('ensureKnowledgeSchedule', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
          : await tasksCall('taskCreate', {
            workflow: WORKFLOW, title: t('knowledge.researchTitle'), fields: { platforms: !platform ? PLATFORMS : [platform] },
            carry: false, catchUp: false, schedule: { kind: 'once' },
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone, runNow: false,
          })
      if (!live.current) return
      if (result.run) setLastRun(result.run)
      setNotice(t(task ? (task.enabled ? 'knowledge.paused' : 'knowledge.resumed') : key === 'weekly' ? (result.created ? 'knowledge.weeklyEnabled' : 'knowledge.existingSchedule') : 'knowledge.started'))
      await loadSchedules()
      window.dispatchEvent(new CustomEvent('ruyix:tasks', { detail: { ids: result.task?.id ? [result.task.id] : [] } }))
    } catch (e) { if (live.current) setActionError(e.message) }
    finally { locked.current = false; if (live.current) setBusy('') }
  }
  return <section className="st-block st-full pl-knowledge">
    <header className="st-block-head"><h2><BookOpen size={15} />{t('knowledge.title')}</h2></header>
    <div className="st-block-body">
      <p className="st-quiet">{t('knowledge.intro')}</p>
      <form className="pl-knowledge-search" onSubmit={e => { e.preventDefault(); query === search ? load() : setSearch(query) }}>
        <label><span>{t('knowledge.searchLabel')}</span><input className="st-in" value={query} maxLength={200} onChange={e => setQuery(e.target.value)} placeholder={t('knowledge.searchHint')} /></label>
        <label><span>{t('knowledge.platform')}</span><select className="st-in" aria-label={t('knowledge.platform')} value={platform} onChange={e => setPlatform(e.target.value)}><option value="">{t('knowledge.all')}</option>{PLATFORMS.map(id => <option key={id} value={id}>{t(`pl.${id}`)}</option>)}</select></label>
        <button className="st-btn" type="submit" disabled={loading}><Search size={13} />{t('knowledge.search')}</button>
      </form>
      <div className="pl-knowledge-actions"><button className="st-btn" disabled={!!busy} onClick={() => act('refresh')}><RefreshCw size={13} />{t('knowledge.refresh')}</button>
        {schedules?.length === 0 && <button className="st-btn" disabled={!!busy} onClick={() => act('weekly')}>{t('knowledge.weekly')}</button>}
        {lastRun && <button className="st-link" onClick={() => openRun(lastRun.id)}>{t('knowledge.openResearch')}</button>}
      </div>
      {notice && <p className="st-quiet" role="status">{notice}</p>}{actionError && <p className="st-bad" role="alert">{actionError}</p>}
      {scheduleError && <p className="st-bad" role="alert">{scheduleError} <button className="st-link" onClick={() => loadSchedules().catch(() => {})}>{t('pl.retry')}</button></p>}
      {!!schedules?.length && <div className="pl-knowledge-schedules"><h3>{t('knowledge.schedules')}</h3>{schedules.map(task => <div key={task.id}>
        <span><strong>{task.title}</strong><small>{(task.fields?.platforms || PLATFORMS).map(id => t(`pl.${id}`)).join(' · ')} · {task.enabled ? `${t('knowledge.next')} ${dateText(task.nextAt, lang)}` : t('knowledge.paused')}{task.tz && ` · ${task.tz}`}</small></span>
        <button className="st-btn st-btn-sm" disabled={!!busy} onClick={() => act(task.id, task)}>{task.enabled ? <Pause size={12} /> : <Play size={12} />}{t(task.enabled ? 'knowledge.pause' : 'knowledge.resume')}</button>
        {task.lastRunId && <button className="st-link" onClick={() => openRun(task.lastRunId)}>{t('knowledge.lastRun')}</button>}
      </div>)}</div>}
      {loadError && <p className="st-bad" role="alert">{loadError} <button className="st-link" disabled={loading} onClick={() => load()}>{t('pl.retry')}</button></p>}
      {loading && <p className="st-quiet" role="status">{t('knowledge.loading')}</p>}
      {data && <div className="pl-knowledge-results" aria-busy={loading}>{data.profiles.length ? data.profiles.map(profile => <Profile key={`${profile.platform}:${profile.digest}`} profile={profile} lang={lang} call={call} />) : <p className="st-quiet">{t('knowledge.noResults')}</p>}</div>}
    </div>
  </section>
}
