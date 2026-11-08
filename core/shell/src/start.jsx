// Home: the page Ruyix opens on. While a required step is not done it leads with the setup (each plugin's setup(), from
// /api/ruyix/setup; a step opens the panel where it is done);
// then what needs you and how the agents do (each plugin's overview(), from /api/ruyix/overview), the setup folded away.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ArrowRight, Bot, Cable, Check, ChevronRight, Copy, Download, FileUp, FolderCog, RefreshCw, Sparkles, TerminalSquare, TriangleAlert, Users } from 'lucide-react'
import { Mark } from './mark.jsx'

export const START = 'ruyix-start'

const TEXT = {
  en: {
    nav: 'Home',
    title: 'Welcome to Ruyix',
    lead: 'Your agents work here — in workflows you can see and change, every step on the record, and anything that leaves this machine waits for your approval. First, set up a few things:',
    progress: (d, n) => `${d} of ${n} required steps done`,
    ready: 'Ready to go',
    readyLead: 'Everything Ruyix needs is in place. What needs you is in the inbox; how the agents do is below.',
    remaining: n => `${n} step${n === 1 ? '' : 's'} to go`,
    continue: 'Continue setup',
    required: 'required',
    done: 'done',
    todo: 'to set up',
    optional: 'optional',
    setUp: 'Set up',
    copy: 'Copy',
    copied: 'Copied',
    open: 'Open',
    refresh: 'Check again',
    save: 'Save',
    saved: 'Saved',
    toInbox: 'Open the inbox',
    later: 'Later: open the inbox',
    setup: 'Setup',
    setupDone: n => `All ${n} required steps done`,
    runsOn: ruyix => `Ruyix ${ruyix} · ruyix upgrade takes the next release.`,
    cfg: {
      title: 'Set up from a configuration file',
      lead: 'ruyix-config.json holds the workspaces, settings, agents and connections with the credentials each needs — never a value; ruyix-secrets.env holds the values. Import both and the steps below are done; export them to set up another machine or box.',
      file: 'Configuration (ruyix-config.json)',
      values: 'Values (ruyix-secrets.env, optional)',
      choose: 'Choose…',
      import: 'Import',
      importing: 'Importing…',
      export: 'Export configuration',
      exportValues: 'Export values',
      confirmValues: 'ruyix-secrets.env holds your credentials in plain text. Keep it off git and chat. Export it?',
      inBox: 'In this box the values are placeholders; the real ones are on the host (nookbox up --config … --secrets …).',
      applied: 'Applied',
      badFile: 'That file is not a Ruyix configuration.',
    },
    error: { failed: 'Could not read the setup; check again in a moment.' },
  },
  zh: {
    nav: '首页',
    title: '欢迎使用 Ruyix',
    lead: '你的智能体在这里干活：流程看得见、改得了，每一步都有记录，任何要离开这台机器的操作都先等你批准。先完成下面几项设置：',
    progress: (d, n) => `必需的 ${n} 项已完成 ${d} 项`,
    ready: '一切就绪',
    readyLead: 'Ruyix 需要的都已准备好。需要你处理的都在收件箱里，智能体的表现见下方。',
    remaining: n => `还差 ${n} 项`,
    continue: '继续设置',
    required: '必需',
    done: '已完成',
    todo: '待设置',
    optional: '可选',
    setUp: '去设置',
    copy: '复制',
    copied: '已复制',
    open: '打开',
    refresh: '重新检查',
    save: '保存',
    saved: '已保存',
    toInbox: '进入收件箱',
    later: '稍后再说，先进入收件箱',
    setup: '设置',
    setupDone: n => `必需的 ${n} 项都已完成`,
    runsOn: ruyix => `Ruyix ${ruyix} · 用 ruyix upgrade 升级到新版本。`,
    cfg: {
      title: '用配置文件一键设置',
      lead: 'ruyix-config.json 里是工作区、各项设置、智能体和连接，以及每个连接需要的凭据——不含任何值；ruyix-secrets.env 里是这些值。两个一起导入，下面的步骤就都完成了；也可以导出，用来设置另一台机器或 box。',
      file: '配置（ruyix-config.json）',
      values: '值（ruyix-secrets.env，可选）',
      choose: '选择…',
      import: '导入',
      importing: '正在导入…',
      export: '导出配置',
      exportValues: '导出值',
      confirmValues: 'ruyix-secrets.env 里是明文的凭据，不要放进 git 或发到聊天里。确定导出吗？',
      inBox: '这个 box 里的值都是占位符，真值在宿主上（nookbox up --config … --secrets …）。',
      applied: '已应用',
      badFile: '这不是 Ruyix 的配置文件。',
    },
    error: { failed: '读取设置状态失败，请稍后重新检查。' },
  },
}
export const textOf = lang => TEXT[lang] || TEXT.en

/** The steps from the Host: { ruyix, dsh, steps }. */
export const loadSetup = () => fetch('api/ruyix/setup').then(r => (r.ok ? r.json() : Promise.reject(new Error(`setup ${r.status}`))))
/** The plugins' overview: { sections }. */
const loadOverview = () => fetch('api/ruyix/overview').then(r => (r.ok ? r.json() : { sections: [] }), () => ({ sections: [] }))

/** A step done by a command: what to run, where (a box's agent signs in from its host), and a copy button. */
function Command({ t, c, lang }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard?.writeText(c.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
  return (
    <div className="ruyix-cmd">
      <div className="ruyix-cmd-line"><TerminalSquare size={13} /><code>{c.text}</code>
        <button className="ruyix-btn ruyix-ghost" onClick={copy}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? t.copied : t.copy}</button></div>
      {c.where && <div className="ruyix-cmd-where">{c.where[lang] || c.where.en}</div>}
    </div>
  )
}

// each step's icon (a step from a plugin not listed here gets the sparkle)
const ICONS = { 'workbench-setup': FolderCog, 'workbench-people': Users, 'workbench-tools': TerminalSquare, 'claude-code': Bot, 'codex-cli': Bot, connectors: Cable }

/** The progress ring: the share of required steps done, green once all are. */
function Ring({ done, total }) {
  const r = 34, c = 2 * Math.PI * r, share = total ? done / total : 1, all = done === total
  return (
    <div className={`ruyix-ring${all ? ' ruyix-ring-done' : ''}`} role="img" aria-label={`${done}/${total}`}>
      <svg viewBox="0 0 84 84" width="84" height="84">
        <circle cx="42" cy="42" r={r} className="ruyix-ring-track" />
        <circle cx="42" cy="42" r={r} className="ruyix-ring-value" strokeDasharray={c} strokeDashoffset={c * (1 - share)} />
      </svg>
      <span className="ruyix-ring-label">{all ? <Check size={28} strokeWidth={2.4} /> : <span><b>{done}</b><small>/{total}</small></span>}</span>
    </div>
  )
}

/** One plugin's section of the overview: its title, a link to more, and its tiles (each opening what it counts). */
function Section({ s, lang, go }) {
  const text = x => (x ? x[lang] || x.en : '')
  return (
    <section className="ruyix-ov">
      <div className="ruyix-ov-head">
        <h2>{text(s.title)}</h2>
        {s.sub && <span>{text(s.sub)}</span>}
        {s.more && <button className="ruyix-btn ruyix-link ruyix-ov-more" onClick={() => go(s.more.open)}>{text(s.more.label)}<ChevronRight size={14} /></button>}
      </div>
      <div className="ruyix-tiles">
        {s.tiles.map(x => (
          <button key={x.id} type="button" className={`ruyix-tile ruyix-tone-${x.tone || 'neutral'}`} disabled={!x.open} onClick={() => go(x.open)}>
            <b>{x.value}</b><span>{text(x.label)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

const download = (name, text) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
/** Import or export the one configuration file (and its values) — the shell's /api/ruyix/config. */
function ConfigCard({ t, onApplied }) {
  const [files, setFiles] = useState({ config: null, secrets: null })
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [inBox, setInBox] = useState(false)
  useEffect(() => { fetch('api/ruyix/config').then(r => r.json()).then(d => setInBox(!!d.inBox), () => {}) }, [])
  const pick = key => e => setFiles(f => ({ ...f, [key]: e.target.files?.[0] || null }))
  const run = async () => {
    setBusy(true); setError(''); setReport(null)
    try {
      const config = await files.config.text()
      try { if (JSON.parse(config).kind !== 'ruyix-config') throw new Error() } catch { throw new Error(t.cfg.badFile) }
      const secrets = files.secrets ? await files.secrets.text() : undefined
      const r = await fetch('api/ruyix/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, secrets }) }).then(x => x.json())
      if (r.error) throw new Error(r.error)
      setReport(r.report); onApplied()
    } catch (err) { setError(err.message) }
    setBusy(false)
  }
  const exp = async values => {
    if (values && !window.confirm(t.cfg.confirmValues)) return
    const d = await fetch(`api/ruyix/config${values ? '?values=1' : ''}`).then(r => r.json())
    if (values) download('ruyix-secrets.env', d.secrets || '')
    else download('ruyix-config.json', `${JSON.stringify(d.config, null, 2)}\n`)
  }
  return (
    <section className="ruyix-config">
      <div className="ruyix-config-head"><FileUp size={17} strokeWidth={1.8} /><b>{t.cfg.title}</b></div>
      <p>{t.cfg.lead}</p>
      <div className="ruyix-config-row">
        <label className="ruyix-file"><span>{t.cfg.file}</span><input type="file" accept=".json,application/json" onChange={pick('config')} /><em>{files.config?.name || t.cfg.choose}</em></label>
        <label className="ruyix-file"><span>{t.cfg.values}</span><input type="file" accept=".env,text/plain" onChange={pick('secrets')} /><em>{files.secrets?.name || t.cfg.choose}</em></label>
        <button className="ruyix-btn ruyix-cta" disabled={!files.config || busy} onClick={run}>{busy ? t.cfg.importing : t.cfg.import}</button>
      </div>
      {error && <div className="ruyix-note"><TriangleAlert size={13} /> {error}</div>}
      {report && <ul className="ruyix-config-report">{report.map((r, i) => <li key={i} className={r.ok ? 'ruyix-ok' : 'ruyix-warn'}>{r.ok ? <Check size={12} strokeWidth={2.6} /> : <TriangleAlert size={12} />}{r.text}</li>)}</ul>}
      <div className="ruyix-config-row ruyix-config-export">
        <button className="ruyix-btn ruyix-ghost" onClick={() => exp(false)}><Download size={13} />{t.cfg.export}</button>
        <button className="ruyix-btn ruyix-ghost" disabled={inBox} onClick={() => exp(true)}><Download size={13} />{t.cfg.exportValues}</button>
        {inBox && <small>{t.cfg.inBox}</small>}
      </div>
    </section>
  )
}

export function StartPage({ locale, layout, home, open: openPage }) {
  const lang = useSyncExternalStore(fn => locale.subscribe(fn), () => (String(locale.getSnapshot().active || 'en').startsWith('zh') ? 'zh' : 'en'))
  const active = useSyncExternalStore(fn => layout.panelInfo.subscribe(fn), () => layout.panelInfo.getSnapshot().activePanelId)
  const t = textOf(lang)
  const [setup, setSetup] = useState(null)
  const [overview, setOverview] = useState(null)
  const [failed, setFailed] = useState(false)
  const [checking, setChecking] = useState(false)
  const reload = () => {
    setChecking(true)
    loadOverview().then(o => setOverview(o.sections))
    return loadSetup().then(s => { setSetup(s); setFailed(false) }, () => setFailed(true)).finally(() => setChecking(false))
  }
  // again whenever the page is shown or the window comes back: a step is usually done in another panel or a terminal
  useEffect(() => { if (active === START) reload() }, [active])
  useEffect(() => { window.addEventListener('focus', reload); return () => window.removeEventListener('focus', reload) }, [])
  const open = panel => { if (openPage) return openPage(panel); try { layout.selectPanel(panel) } catch { /* that plugin is off */ } }
  // a tile opens its panel, or asks its plugin's page to show a view (an event that page listens to)
  const go = o => { if (o?.event) window.dispatchEvent(new CustomEvent(o.event, { detail: o.detail })); else if (o?.panel) open(o.panel) }
  const required = setup?.steps.filter(s => s.required) || []
  const done = required.filter(s => s.ready).length
  const all = !!setup && done === required.length
  const next = setup?.steps.find(s => s.required && !s.ready)
  const toNext = () => document.getElementById(`ruyix-step-${next?.id}`)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' })
  const steps = setup && (
    <ol className="ruyix-steps">
      {setup.steps.map((s, i) => {
        const Icon = ICONS[s.id] || Sparkles
        const state = s.ready ? 'done' : s.required ? 'todo' : 'optional'
        return (
          <li key={s.id} id={`ruyix-step-${s.id}`} className={`ruyix-step ruyix-step-${state}${next?.id === s.id ? ' ruyix-step-next' : ''}`} style={{ '--i': i }}>
            <div className="ruyix-step-top">
              <span className="ruyix-step-icon"><Icon size={18} strokeWidth={1.8} /></span>
              <span className={`ruyix-pill ruyix-pill-${state}`}>{s.ready ? <><Check size={12} strokeWidth={2.6} />{t.done}</> : s.required ? t.todo : t.optional}</span>
            </div>
            <div className="ruyix-step-title">{s.title[lang] || s.title.en}</div>
            <div className="ruyix-step-detail">{s.detail[lang] || s.detail.en}</div>
            {/* a step done by a command (an agent's sign-in): the command, where to run it, a copy button */}
            {s.command && !s.ready && <Command t={t} c={s.command} lang={lang} />}
            {(s.panel || s.open) && (s.ready || !s.command) && <button className="ruyix-btn ruyix-ghost ruyix-step-go" onClick={() => (s.open ? go(s.open) : open(s.panel))}>{s.ready ? t.open : t.setUp}<ArrowRight size={13} /></button>}
          </li>
        )
      })}
    </ol>
  )
  const sections = overview?.length > 0 && overview.map(s => <Section key={s.id} s={s} lang={lang} go={go} />)
  return (
    <div className="ruyix-start-host"><div className="ruyix-start">
      <header className={`ruyix-hero${all ? ' ruyix-hero-done' : ''}`}>
        <div className="ruyix-hero-main">
          <span className="ruyix-hero-mark"><Mark size={all ? 36 : 44} /></span>
          <h1>{t.title}</h1>
          <p>{all ? t.readyLead : t.lead}</p>
          {setup && (
            <div className="ruyix-hero-actions">
              {all
                ? <button className="ruyix-btn ruyix-cta" onClick={() => open(home())}>{t.toInbox}<ArrowRight size={15} /></button>
                : <button className="ruyix-btn ruyix-cta" onClick={toNext}>{t.continue}<ArrowRight size={15} /></button>}
              <button className="ruyix-btn ruyix-ghost" disabled={checking} onClick={reload}><RefreshCw size={13} className={checking ? 'ruyix-spin' : ''} />{t.refresh}</button>
              {!all && <button className="ruyix-btn ruyix-link" onClick={() => open(home())}>{t.later}</button>}
            </div>
          )}
        </div>
        {setup && (
          <div className="ruyix-hero-side">
            <Ring done={done} total={required.length} />
            <div className="ruyix-hero-status">
              <b>{all ? t.ready : t.remaining(required.length - done)}</b>
              <span>{t.progress(done, required.length)}</span>
            </div>
          </div>
        )}
      </header>
      {failed && <div className="ruyix-note">{t.error.failed}</div>}
      {/* setup first while it is not done; once it is, what needs you and how the agents do, the setup folded away */}
      {!all && setup && <ConfigCard t={t} onApplied={reload} />}
      {!all && steps}
      {sections}
      {all && (
        <details className="ruyix-setup">
          <summary><Check size={14} strokeWidth={2.4} /><b>{t.setup}</b><span>{t.setupDone(required.length)}</span><ChevronRight size={14} className="ruyix-setup-chev" /></summary>
          <ConfigCard t={t} onApplied={reload} />
          {steps}
        </details>
      )}
      {setup && <footer><small>{t.runsOn(setup.ruyix)}</small></footer>}
    </div></div>
  )
}
