// The Skills page: the skills in use — each with where it is used (the steps whose scripts run it, the steps whose
// member gets it, the team members that name it) — the packs they come from (bundled with a plugin, or a team
// repository pinned to a commit: check, update, roll back), and the switch that keeps members to packs only. Skills no
// step or member uses are folded away; local skills show only when a member names one.
import { useEffect, useState } from 'react'
import {
  AlertTriangle, ArrowDownToLine, Bot, ChevronRight, Cog, FileCode2, FileText, GitBranch, Loader2, Lock, Package, Plus, RefreshCw, RotateCcw, ShieldCheck, Trash2, Users, Wand2, Workflow, X,
} from 'lucide-react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { call, useSnapshot } from './data.js'
import { T, cx, errorText } from './ui.jsx'

const KIND_ICON = { script: Cog, step: Bot, member: Users }
const size = n => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
/** A markdown file as its page shows it: its front matter (name, description, tools…) as it is, then the text. */
function Md({ t, text }) {
  const fm = FRONT.exec(String(text || ''))
  return (
    <div className="ah-skd-md">
      {fm && <pre className="ah-skd-fm">{fm[1].trim()}</pre>}
      <MarkdownText text={String(text || '').replace(FRONT, '').trim()} labels={{ code: { copyLabel: t('sk.copy'), copiedLabel: t('sk.copied') }, footnotes: t('sk.footnotes') }} />
    </div>
  )
}

/**
 * One skill to read: its files (SKILL.md first) beside what the one picked holds — SKILL.md as the agents get it, a
 * script or a reference as text, a binary one only said — and where it is used.
 */
function SkillDetail({ t, skill, cwds, source, uses, onClose }) {
  const [d, setD] = useState(null)
  const [error, setError] = useState('')
  const [file, setFile] = useState('SKILL.md')
  const [content, setContent] = useState(null)
  useEffect(() => { call('skillShow', { ref: skill.ref, cwds }).then(setD, err => setError(errorText(t, err))) }, [skill.ref])
  useEffect(() => {
    if (!d || file === 'SKILL.md') { setContent(null); return }
    setContent(undefined)
    call('skillFile', { ref: skill.ref, path: file, cwds }).then(setContent, err => setContent({ error: errorText(t, err) }))
  }, [d, file])
  useEffect(() => { const k = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [])
  const busy = <div className="ah-sub"><Loader2 size={13} className="ah-spin" /> {t('loading')}</div>
  return (
    <div className="ah-modal-backdrop ah-skd-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="ah-modal ah-skd" role="dialog" aria-modal="true" aria-label={skill.name}>
        <header className="ah-skd-head">
          <span className="ah-skc-icon"><Wand2 size={16} /></span>
          <div className="ah-skd-title"><b>{skill.name}</b><span className="ah-mono">{skill.ref}</span></div>
          <span className="ah-skc-src">{source}</span>
          <button className="ah-icon-btn" onClick={onClose} aria-label={t('close')}><X size={15} /></button>
        </header>
        {!d && skill.description && <p className="ah-skd-desc">{skill.description}</p>}
        {error ? <div className="ah-note ah-tone-error"><AlertTriangle size={13} /> {error}</div> : !d ? busy : (
          <div className="ah-skd-body">
            <nav className="ah-skd-files" aria-label={t('sk.files')}>
              <span className="ah-skd-files-h">{t('sk.files')} · {d.files.length}</span>
              {d.files.map(f => (
                <button key={f.path} className={cx('ah-skd-file', file === f.path && 'ah-on')} onClick={() => setFile(f.path)} title={f.path}>
                  {f.path.endsWith('.md') ? <FileText size={13} /> : <FileCode2 size={13} />}<span className="ah-mono">{f.path}</span><small>{size(f.size)}</small>
                </button>
              ))}
            </nav>
            <div className="ah-skd-view">
              {file === 'SKILL.md' ? <Md t={t} text={d.doc} />
                : content === undefined ? busy
                  : content?.error ? <div className="ah-note ah-tone-error"><AlertTriangle size={13} /> {content.error}</div>
                    : content?.binary ? <p className="ah-sub">{t('sk.binary', { size: size(content.size) })}</p>
                      : content && <>{content.cut && <p className="ah-sub">{t('sk.cut')}</p>}{/\.(md|markdown)$/i.test(file) ? <Md t={t} text={content.text} /> : <pre className="ah-skd-code">{content.text}</pre>}</>}
            </div>
          </div>
        )}
        {uses}
      </div>
    </div>
  )
}

export function SkillsPage({ t, workspaces, style }) {
  const ws = useSnapshot(workspaces)
  const cwds = ws.items.map(w => w.path)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [check, setCheck] = useState({}) // pack → its update check
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ id: '', git: '', ref: 'main', path: 'skills' })
  const [open, setOpen] = useState(null) // the skill being read
  const load = () => call('skillPacks', { cwds }).then(d => { setData(d); setError('') }, err => setError(errorText(t, err)))
  useEffect(() => { load() }, [cwds.join('\n')])
  const act = async (key, fn) => {
    setBusy(key); setError('')
    try { await fn(); await load() } catch (err) { setError(errorText(t, err)) }
    setBusy('')
  }
  const lang = t('sk.lang')
  const L = x => x?.[lang] || x?.en || ''
  const useText = u => `${u.by} · ${L(u.where)}`
  const who = list => list.map(useText).join(', ')
  const add = () => act('add', async () => { await call('skillPackAdd', form); setAdding(false); setForm({ id: '', git: '', ref: 'main', path: 'skills' }) })
  const checkPack = id => act(`check:${id}`, async () => { const c = await call('skillPackCheck', { id }); setCheck(x => ({ ...x, [id]: c })) })
  const update = (id, to) => act(`update:${id}`, async () => { await call('skillPackUpdate', { id, to }); setCheck(x => ({ ...x, [id]: null })) })
  const remove = p => window.confirm(p.usedBy?.length ? t('sk.removeUsed', { id: p.id, n: p.usedBy.length, who: who(p.usedBy) }) : t('sk.removeConfirm', { id: p.id })) && act(`remove:${p.id}`, () => call('skillPackRemove', { id: p.id }))
  const spin = key => busy === key ? <Loader2 size={13} className="ah-spin" /> : null
  const local = !!data?.policy?.local
  // in use first: a skill shows when a step or a member uses it; the rest folds away
  const packs = data?.packs || []
  const used = packs.flatMap(p => p.skills.filter(s => s.usedBy?.length).map(s => ({ ...s, pack: p })))
  const unused = packs.flatMap(p => p.skills.filter(s => !s.usedBy?.length).map(s => ({ ...s, pack: p })))
  const packsInUse = packs.filter(p => p.skills.some(s => s.usedBy?.length) || (p.kind === 'git' && !p.sha))
  const otherPacks = packs.filter(p => !packsInUse.includes(p))
  const localNamed = (data?.unmanaged || []).filter(s => s.usedBy?.length)
  const steps = new Set(used.flatMap(s => s.usedBy.flatMap(u => (u.steps || []).map(L))))

  const packRow = p => {
    const c = check[p.id]
    return (
      <div key={p.id} className="ah-skp-row" data-pack={p.id}>
        <span className="ah-skp-icon"><Package size={15} /></span>
        <div className="ah-skp-main">
          <div className="ah-skp-name"><b className="ah-mono">{p.id}</b>
            <span className={cx('ah-skp-kind', `ah-skp-${p.kind}`)}>{t(`sk.kind.${p.kind}`)}</span>
            {p.version ? <span className="ah-skp-ver ah-mono" title={p.sha || ''}>{p.version}</span> : p.kind === 'git' && <span className="ah-chip ah-tone-waiting">{t('sk.notFetched')}</span>}
          </div>
          <div className="ah-sub ah-skp-src">{p.kind === 'git' ? `${p.git} · ${p.ref}${p.path ? ` · ${p.path}/` : ''}` : t('sk.by', { by: p.by || '—' })} · {t('sk.skillsN', { n: p.skills.length })}</div>
          {p.kind === 'git' && !p.sha && p.error && <div className="ah-note ah-tone-error"><AlertTriangle size={13} /> {t('sk.fetchFailed', { error: p.error })}</div>}
          {c && (c.upToDate
            ? <div className="ah-note ah-tone-done">{t('sk.upToDate', { sha: c.current.slice(0, 10) })}</div>
            : <div className="ah-note ah-tone-waiting ah-sk-update">
                <div>{t('sk.newer', { n: c.commits.length, skills: c.skills.join(', ') || '—' })}</div>
                <ul>{c.commits.map(line => <li key={line} className="ah-mono">{line}</li>)}</ul>
                {p.usedBy?.length > 0 && <div className="ah-sub">{t('sk.affects', { who: who(p.usedBy) })}</div>}
                <button className="ah-btn ah-small ah-primary" disabled={!!busy} onClick={() => update(p.id, c.tip)}>{spin(`update:${p.id}`) || <ArrowDownToLine size={12} />}{t('sk.updateTo', { sha: c.tip.slice(0, 10) })}</button>
              </div>)}
        </div>
        <span className="ah-skp-actions">
          {p.kind === 'git' && !p.sha && <button className="ah-btn ah-small" disabled={!!busy} onClick={() => update(p.id)}>{spin(`update:${p.id}`) || <ArrowDownToLine size={12} />}{t('sk.fetch')}</button>}
          {p.kind === 'git' && p.sha && <button className="ah-btn ah-small" disabled={!!busy} onClick={() => checkPack(p.id)}>{spin(`check:${p.id}`) || <RefreshCw size={12} />}{t('sk.check')}</button>}
          {p.kind === 'git' && p.prev && <button className="ah-btn ah-small" disabled={!!busy} title={t('sk.rollbackHint', { sha: p.prev.slice(0, 10) })} onClick={() => update(p.id, p.prev)}><RotateCcw size={12} />{t('sk.rollback')}</button>}
          {p.kind === 'git' && <button className="ah-icon-btn" disabled={!!busy} title={t('sk.remove')} onClick={() => remove(p)}><Trash2 size={13} /></button>}
        </span>
      </div>
    )
  }

  // where a skill is used: the steps whose scripts run it, the steps whose member gets it, the members that name it
  const usesOf = s => s.usedBy.map((u, i) => {
    const kind = u.kind || 'member', Icon = KIND_ICON[kind] || Users
    return (
      <div key={i} className={cx('ah-skc-use', `ah-skc-${kind}`)}>
        <span className="ah-skc-kind"><Icon size={11} />{t(`sk.k.${kind}`)}</span>
        <div className="ah-skc-steps">
          {(u.steps || []).map(st => <span key={L(st)} className="ah-skc-step">{L(st)}</span>)}
          {kind === 'member' && <span className="ah-skc-step ah-skc-who">{u.by} · {u.member || L(u.where)}</span>}
        </div>
        {u.what && <div className="ah-skc-what">{L(u.what)}</div>}
      </div>
    )
  })
  const sourceOf = s => `${t(`sk.kind.${s.pack.kind}`)}${s.pack.version ? ` · ${s.pack.version}` : ''}`

  const actions = (
    <div className="ah-header-actions">
      <button className="ah-btn" onClick={() => act('reload', load)}>{spin('reload') || <RefreshCw size={13} />}{t('sk.reload')}</button>
      <button className="ah-btn ah-primary" onClick={() => setAdding(x => !x)}><Plus size={13} />{t('sk.add')}</button>
    </div>
  )

  return (
    <T.Provider value={t}>
      <div className="ah-page">
        <style>{style}</style>
        <header className="ah-header">
          <div className="ah-brand">
            <span className="ah-brand-glyph"><Wand2 size={18} /></span>
            <div><h1>{t('sk.title')}</h1><span className="ah-sub">{t('sk.subtitle')}</span></div>
          </div>
          {actions}
        </header>
        <div className="ah-sk-body">
          {error && <div className="ah-note ah-tone-error"><AlertTriangle size={13} /> {error}</div>}
          {!data ? <div className="ah-sub"><Loader2 size={13} className="ah-spin" /> {t('loading')}</div> : (
            <>
              {/* the summary: what is in use, from where, and the switch that keeps members to packs */}
              <section className="ah-skh">
                <div className="ah-skh-num"><b>{used.length}</b><span>{t('sk.inUse')}</span></div>
                <div className="ah-skh-facts">
                  <span><Package size={13} />{t('sk.fromPacks', { n: packsInUse.length })}</span>
                  <span><Workflow size={13} />{t('sk.stepsN', { n: steps.size })}</span>
                  <span><Lock size={13} />{t('sk.pinned')}</span>
                </div>
                <button type="button" role="switch" aria-checked={!local} disabled={!!busy} className={cx('ah-skh-policy', !local && 'ah-on')}
                  onClick={() => act('policy', () => call('skillPolicy', { local: !local }))} title={t(local ? 'sk.policyOff' : 'sk.policyOn')}>
                  <ShieldCheck size={16} /><span><b>{t('sk.policyTitle')}</b><small>{t(local ? 'sk.policyShortOff' : 'sk.policyShortOn')}</small></span>
                  {spin('policy') || <i className="ah-switch" aria-hidden="true" />}
                </button>
                <details className="ah-skh-how"><summary>{t('sk.how')}<ChevronRight size={12} /></summary><p className="ah-sub">{t(local ? 'sk.policyOff' : 'sk.policyOn')}</p></details>
              </section>

              {localNamed.length > 0 && (
                <div className="ah-note ah-tone-waiting"><AlertTriangle size={13} />
                  <span>{t(local ? 'sk.localNamed' : 'sk.localNamedOff')} {localNamed.map(s => <span key={s.ref} className="ah-mono"> {s.ref} ({who(s.usedBy)})</span>)}</span></div>
              )}

              {/* the skills in use, each with where */}
              <h2 className="ah-sk-h2">{t('sk.inUseTitle')}</h2>
              {used.length === 0 ? <div className="ah-empty-small">{t('sk.noneUsed')}</div> : (
                <div className="ah-skg">
                  {used.map(s => (
                    <article key={`${s.pack.id}/${s.name}`} className="ah-skc ah-skc-open" data-skill={`${s.pack.id}/${s.name}`} role="button" tabIndex={0} title={t('sk.view')}
                      onClick={() => setOpen(s)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(s))}>
                      <header>
                        <span className="ah-skc-icon"><Wand2 size={16} /></span>
                        <div className="ah-skc-title"><b>{s.name}</b><span className="ah-mono">{s.pack.id}/{s.name}</span></div>
                        <span className="ah-skc-src">{sourceOf(s)}</span>
                      </header>
                      <p className="ah-skc-desc" title={s.description}>{s.description}</p>
                      <div className="ah-skc-uses">{usesOf(s)}</div>
                    </article>
                  ))}
                </div>
              )}
              {/* where they come from */}
              <h2 className="ah-sk-h2">{t('sk.packsTitle')}</h2>
              {adding && (
                <section className="ah-sk-card ah-sk-form">
                  <h3><GitBranch size={14} />{t('sk.addTitle')}</h3>
                  <div className="ah-sk-grid">
                    <label><span>{t('sk.id')}</span><input className="ah-input" value={form.id} placeholder="team-sop" onChange={e => setForm({ ...form, id: e.target.value.toLowerCase() })} /></label>
                    <label className="ah-sk-wide"><span>{t('sk.git')}</span><input className="ah-input" value={form.git} placeholder="https://git.example.com/team/skills.git" onChange={e => setForm({ ...form, git: e.target.value })} /></label>
                    <label><span>{t('sk.ref')}</span><input className="ah-input" value={form.ref} onChange={e => setForm({ ...form, ref: e.target.value })} /></label>
                    <label><span>{t('sk.path')}</span><input className="ah-input" value={form.path} onChange={e => setForm({ ...form, path: e.target.value })} /></label>
                  </div>
                  <p className="ah-sub">{t('sk.addHint')}</p>
                  <div className="ah-actions"><button className="ah-btn ah-primary" disabled={!form.id || !form.git || !!busy} onClick={add}>{spin('add') || <ArrowDownToLine size={12} />}{t('sk.fetchPin')}</button>
                    <button className="ah-btn" onClick={() => setAdding(false)}>{t('cancel')}</button></div>
                </section>
              )}
              <div className="ah-skp">{packsInUse.length ? packsInUse.map(packRow) : <div className="ah-empty-small">{t('sk.noPacks')}</div>}</div>

              {/* what no step or member uses: folded */}
              {(unused.length > 0 || otherPacks.length > 0) && (
                <details className="ah-sk-more">
                  <summary><ChevronRight size={13} />{t('sk.unusedN', { n: unused.length })}</summary>
                  <p className="ah-sub">{t('sk.unusedHint')}</p>
                  <ul className="ah-sk-list">
                    {unused.map(s => <li key={`${s.pack.id}/${s.name}`} data-skill={`${s.pack.id}/${s.name}`} className="ah-skc-open" role="button" tabIndex={0} title={t('sk.view')}
                      onClick={() => setOpen(s)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(s))}><Wand2 size={12} /><span className="ah-mono">{s.pack.id}/{s.name}</span><span className="ah-sub">{s.description}</span></li>)}
                  </ul>
                  {otherPacks.length > 0 && <div className="ah-skp ah-skp-dim">{otherPacks.map(packRow)}</div>}
                </details>
              )}
            </>
          )}
        </div>
        {open && <SkillDetail t={t} skill={{ ...open, ref: `${open.pack.id}/${open.name}` }} cwds={cwds} source={sourceOf(open)} onClose={() => setOpen(null)}
          uses={open.usedBy?.length > 0 && <div className="ah-skd-uses"><span className="ah-skd-files-h">{t('sk.usedHere')}</span><div className="ah-skc-uses">{usesOf(open)}</div></div>} />}
      </div>
    </T.Provider>
  )
}
