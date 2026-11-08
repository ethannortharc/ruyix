// The App Center page: the catalog's graphical apps and command-line tools (install, open, close), install by package
// name, and what to do when this Ruyix is not in a box or its box may not install. A graphical app opens as a window
// on the desktop (window.__ruyixDesk); in the classic sidebar mode it fills this page, with a way back to the list.
// A terminal (tmux, zellij) opens as a window too, drawn by xterm.js (term.jsx); closing it leaves its session running.
// The ⌘K palette (window.__ruyixPalette) gets "Open <app>" for each installed graphical app and terminal, and the App Center.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, ArrowLeft, BookOpen, Braces, Briefcase, Calculator, Check, Code, Copy, Database, Download, FileText, Film, Folder, GitBranch, Globe, Image, LayoutGrid, Loader2, Monitor, Package, Palette, PanelsTopLeft, PenTool, Play, Power, RefreshCw, Repeat, ScanText, Search, Square, SquareTerminal, Terminal, Trash2, X } from 'lucide-react'
import css from './styles.css'
import xtermCss from '@xterm/xterm/css/xterm.css'
// the product's semantic tokens (--ruyix-*), bundled so this plugin looks the same with the shell off
import tokens from '@ruyix/shell/tokens.css'
import { en, word, zh } from './locale.js'
import { PIXELS_KEY, VncView, pixelsChoice, pixelsNow } from './vnc.jsx'
import { TermView } from './term.jsx'
import { MadeSection, madeNow, startMade } from './made.jsx'
import { CATALOG, GUI_SUPPORT, PACKAGE, entry } from '../lib/catalog.js'
import { workRegistry } from '@ruyix/shell/work'
import { openRegistry } from '@ruyix/shell/open'

/** A page's site, for a tab with no title yet. */
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return String(url || '').slice(0, 60) } }
const PANEL = 'ruyix-apps'
const NS = 'ruyix-apps'
const ICONS = { BookOpen, Braces, Briefcase, Calculator, Code, Database, Download, FileText, Film, Folder, GitBranch, Globe, Image, Palette, PanelsTopLeft, PenTool, Repeat, ScanText, Search, SquareTerminal, Terminal }
/** What opens as a window: a graphical app, or a terminal drawn in the page. */
const windowed = a => a.kind === 'gui' || a.kind === 'term'
export const iconOf = name => ICONS[name] || Package
/** A made app's icon (its lucide name, when it is one here; made.jsx falls back to its own few, then a window). */
const madeIcon = name => ICONS[name]
const cx = (...n) => n.filter(Boolean).join(' ')

export async function call(op, args) {
  const res = await fetch('api/ruyix-apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...args }) })
  const data = await res.json().catch(() => ({ error: 'failed', params: { message: `HTTP ${res.status}` } }))
  if (!res.ok || data.error) throw Object.assign(new Error(data.params?.message || data.error || `HTTP ${res.status}`), { code: data.error, params: data.params || {} })
  return data
}
const errText = (t, err) => {
  const key = err?.code && `err.${err.code}`
  const text = key && t(key, err.params || {})
  return text && text !== key ? text : err?.message || String(err)
}

// ── the host's state, shared by the page and the palette: asked every few seconds while someone looks, faster while an
// install runs ──
const store = {
  value: null, error: null, subs: new Set(), timer: null, asking: null,
  get: () => store.value,
  set(v, error = null) { if (!error) store.at = Date.now(); store.value = v; store.error = error; for (const f of store.subs) f() },
  async refresh() {
    if (store.asking) return store.asking
    store.asking = call('state').then(v => store.set(v), err => store.set(store.value, err)).finally(() => { store.asking = null })
    return store.asking
  },
  subscribe(f) {
    store.subs.add(f)
    if (store.subs.size === 1) store.tick()
    return () => { store.subs.delete(f); if (!store.subs.size) { clearTimeout(store.timer); store.timer = null } }
  },
  tick() {
    clearTimeout(store.timer)
    store.refresh().finally(() => {
      if (!store.subs.size) return
      const busy = store.value?.jobs?.some(j => j.state === 'queued' || j.state === 'running')
      store.timer = setTimeout(() => store.tick(), busy ? 2000 : 8000)
    })
  },
}
const useApps = () => useSyncExternalStore(store.subscribe, store.get, store.get)
const langOf = locale => (String(locale?.getSnapshot?.().active || 'zh').startsWith('zh') ? 'zh' : 'en')

// ── opening an app: a desktop window, else this page shows it (classic mode) ──
const inline = { value: null, subs: new Set(), get: () => inline.value, set(v) { inline.value = v; for (const f of inline.subs) f() }, subscribe: f => { inline.subs.add(f); return () => inline.subs.delete(f) } }
const alive = async session => (await call('sessions')).sessions.some(s => s.id === session)
const stopSession = id => call('stop', { id }).catch(() => {}).finally(() => store.refresh())

const current = new Map() // appId → the session its desktop window shows
const contents = new Map() // window id → its Content (one component per window, so React keeps it mounted)
const deskContent = id => {
  if (!contents.has(id)) contents.set(id, props => <VncView {...props} alive={alive} onCloseWindow={() => window.__ruyixDesk?.close(id)} />)
  return contents.get(id)
}
/** The page's tone as it is drawn now (dsh's theme: light, dark, or the system's): a light-dark() colour, resolved. */
function toneNow() {
  const probe = document.createElement('i')
  probe.style.cssText = 'position:absolute;visibility:hidden;color:light-dark(rgb(0, 0, 0), rgb(255, 255, 255))'
  document.body.append(probe)
  const dark = getComputedStyle(probe).color === 'rgb(255, 255, 255)'
  probe.remove()
  return dark ? 'dark' : 'light'
}
/** Whether a terminal's session is still there (the host's word; on no answer: yes, so the window offers to reconnect). */
const termAlive = async appId => !!(await call('state')).terms?.[appId]?.running
const termContents = new Map() // window id → its Content
const termContent = (id, appId, at = null) => {
  if (!termContents.has(id)) termContents.set(id, props => <TermView {...props} at={at} alive={() => (at ? Promise.resolve(true) : termAlive(appId))} onCloseWindow={() => window.__ruyixDesk?.close(id)} />)
  return termContents.get(id)
}
/** A terminal's window (one per terminal app: tmux and zellij have tabs of their own). Closing it only detaches. */
function openTerm(app, lang, at = null) {
  const desk = window.__ruyixDesk
  if (desk) {
    // (another session or one of its windows — an agent session's mirror: a window of its own, named for it)
    const id = at ? `term:${app.id}@${at.session}${at.window != null ? `:${at.window}` : ''}` : `term:${app.id}`
    desk.open({ id, title: at?.title || app.name[lang] || app.name.en, ...(!at && { names: app.name }), icon: iconOf(app.icon), Content: termContent(id, app.id, at), props: { appId: app.id }, size: { w: 980, h: 620 },
      kind: 'term', hint: app.id, reopen: at ? { event: 'ruyix-apps:term-at', detail: { appId: app.id, ...at } } : { event: 'ruyix-apps:open', detail: { appId: app.id } }, lingers: true, // (one of the desk's open things; its session outlives the window)
      onClose: () => setTimeout(() => store.refresh(), 500) })
  } else {
    inline.set({ appId: app.id, term: true })
    window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: PANEL } }))
  }
  setTimeout(() => store.refresh(), 1500) // (its session now exists)
  return null
}
/** End a terminal's session, with everything running in it. */
export const endTerm = appId => call('end', { appId }).finally(() => store.refresh())

/** Launch `appId` and show it. Throws the host's coded error (the caller says it). */
export async function openApp(appId, lang) {
  const app = entry(appId)
  if (app?.kind === 'term') return openTerm(app, lang)
  // drawn for this screen (sharp on Retina), at the interface's size (the desktop's --ruyix-scale), light or dark as the
  // page, in the desktop's accent (window.__ruyixLayout: the shell's read of desktop.json)
  const zoom = Number(getComputedStyle(document.body).getPropertyValue('--ruyix-scale')) || 1
  const { session } = await call('launch', { appId, pixels: pixelsNow(), zoom, tone: toneNow(), accent: window.__ruyixLayout?.desktop?.accent })
  store.refresh()
  const desk = window.__ruyixDesk
  if (desk) {
    const id = `linux:${app.id}`
    current.set(app.id, session.id)
    // an open window (its app closed, opened again) only takes the new session: its onClose stops whichever is current
    desk.open({ id, title: app.name[lang] || app.name.en, names: app.name, icon: iconOf(app.icon), Content: deskContent(id), props: { session: session.id, terminal: !!app.terminal, pixels: session.pixels }, size: { w: 1100, h: 720 },
      kind: 'app', hint: app.id, reopen: { event: 'ruyix-apps:open', detail: { appId: app.id } },
      // (the agents' browser: closing its window leaves it running — an agent may be at work in it)
      ...(app.id === 'agent-browser' ? { lingers: true, onClose: () => { current.delete(app.id) } } : { onClose: () => { const sid = current.get(app.id); current.delete(app.id); if (sid) stopSession(sid) } }) })
  } else {
    inline.set({ appId: app.id, session: session.id, pixels: session.pixels })
    window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: PANEL } }))
  }
  return session
}

/** How sharp apps are drawn, for this browser: automatic (sharp on a Retina screen), standard, sharp. Next opening on. */
function Pixels({ t }) {
  const [v, setV] = useState(pixelsChoice)
  const pick = x => { try { localStorage.setItem(PIXELS_KEY, x) } catch { /* private window: this time only */ } setV(x) }
  return (
    <div className="ap-seg" role="radiogroup" aria-label={t('pixels.label')} title={t('pixels.hint')}>
      <span className="ap-seg-label">{t('pixels.label')}</span>
      {['auto', '1', '2'].map(x => <button key={x} type="button" role="radio" aria-checked={v === x} className={v === x ? 'on' : ''} onClick={() => pick(x)}>{t(`pixels.${x}`)}</button>)}
    </div>
  )
}

function CopyCmd({ t, cmd }) {
  const [done, setDone] = useState(false)
  const copy = async () => { try { await navigator.clipboard.writeText(cmd); setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* no clipboard */ } }
  return (
    <div className="ap-cmd">
      <Terminal size={13} />
      <code>{cmd}</code>
      <button className="ap-icon-btn" title={t(done ? 'copied' : 'copy')} aria-label={t(done ? 'copied' : 'copy')} onClick={copy}>{done ? <Check size={13} /> : <Copy size={13} />}</button>
    </div>
  )
}

/** One app's card: icon, name, a line, its state and the buttons that fit it. */
function Card({ t, lang, app, s, busy, onInstall, onUninstall, onOpen, onStop, onEnd }) {
  const Icon = iconOf(app.icon)
  const job = s?.jobs?.find(j => j.appId === app.id && (j.state === 'queued' || j.state === 'running'))
  const session = s?.sessions?.find(x => x.appId === app.id)
  const installed = !!s?.installed?.[app.id]
  const termOn = app.kind === 'term' && installed && !!s?.terms?.[app.id]?.running // (its session, open window or not)
  const st = job?.remove ? 'removing' : session || termOn ? 'running' : job ? (job.state === 'queued' ? 'queued' : 'installing') : installed ? 'installed' : 'none'
  const canAct = s?.inBox && s?.dpkg
  const [sure, setSure] = useState(false) // ending a terminal's session: a second click says yes
  useEffect(() => { if (!sure) return; const k = setTimeout(() => setSure(false), 4000); return () => clearTimeout(k) }, [sure])
  const [rmSure, setRmSure] = useState(false) // uninstalling: a second click says yes
  useEffect(() => { if (!rmSure) return; const k = setTimeout(() => setRmSure(false), 4000); return () => clearTimeout(k) }, [rmSure])
  return (
    <article className={cx('ap-card', `ap-${st}`)}>
      <span className="ap-card-icon"><Icon size={20} /></span>
      <div className="ap-card-text">
        <h3>{app.name[lang] || app.name.en}</h3>
        <p>{app.summary[lang] || app.summary.en}</p>
        <span className={cx('ap-state', `ap-state-${st}`)}>{(st === 'installing' || st === 'queued' || st === 'removing') && <Loader2 size={11} className="ap-spin" />}{t(`state.${st}`)}<em>· {t(`cat.${app.category}`)}</em></span>
      </div>
      <div className="ap-card-act">
        {st === 'none' && app.packages.length > 0 && <button className="ap-btn ap-primary" disabled={!canAct || s?.canInstall === false} onClick={() => onInstall(app)}><Download size={13} />{t('install')}</button>}
        {windowed(app) && (st === 'installed' || st === 'running') && (
          <button className="ap-btn ap-primary" disabled={busy === app.id} onClick={() => onOpen(app)}>{busy === app.id ? <Loader2 size={13} className="ap-spin" /> : <Play size={13} />}{t(busy === app.id ? 'opening' : 'open')}</button>
        )}
        {st === 'running' && session && <button className="ap-btn" onClick={() => onStop(session)}><Square size={12} />{t('close')}</button>}
        {(st === 'installed' || st === 'running') && app.packages.length > 0 && !app.image && (
          <button className={cx('ap-btn ap-quiet', rmSure && 'ap-danger')} title={t('uninstallHint')} disabled={!canAct || s?.canInstall === false}
            onClick={() => { if (rmSure) { setRmSure(false); onUninstall(app) } else setRmSure(true) }}>
            <Trash2 size={12} />{t(rmSure ? 'uninstallSure' : 'uninstall')}
          </button>
        )}
        {termOn && (
          <button className={cx('ap-btn', sure && 'ap-danger')} title={t('term.endHint')} onClick={() => { if (sure) { setSure(false); onEnd(app) } else setSure(true) }}>
            <Power size={12} />{t(sure ? 'term.endSure' : 'term.end')}
          </button>
        )}
      </div>
      {termOn && <p className="ap-card-note">{t('term.kept')}</p>}
      {st === 'none' && !app.packages.length && <p className="ap-card-note">{t('term.bundled')}</p>}
    </article>
  )
}

function Jobs({ t, jobs }) {
  if (!jobs?.length) return null
  const shown = [...jobs].reverse().slice(0, 6)
  return (
    <section className="ap-sec">
      <h2>{t('job.title')}</h2>
      {jobs.some(j => j.state === 'running') && <p className="ap-sub">{t('job.slow')}</p>}
      <div className="ap-jobs">
        {shown.map(j => (
          <div key={j.id} className={cx('ap-job', `ap-job-${j.state}`)}>
            <div className="ap-job-head">
              {j.state === 'running' || j.state === 'queued' ? <Loader2 size={13} className="ap-spin" /> : j.state === 'done' ? <Check size={13} /> : <AlertTriangle size={13} />}
              <b>{t(`job.${j.remove ? 'rm.' : ''}${j.state}`)}</b><code>{j.packages.join(' ')}</code>
            </div>
            {j.state === 'failed' && <p className="ap-job-err">{errText(t, { code: j.code, params: j.params, message: j.error })}</p>}
            {j.state === 'failed' && j.code === 'notAllowed' && j.params?.allow && <CopyCmd t={t} cmd={j.params.allow} />}
            {j.state === 'failed' && j.output && <details><summary>{t('job.output')}</summary><pre>{j.output}</pre></details>}
          </div>
        ))}
      </div>
    </section>
  )
}

function ByName({ t, s, onInstall }) {
  const [text, setText] = useState('')
  const names = text.split(/[\s,]+/).filter(Boolean)
  const bad = names.find(n => !PACKAGE.test(n))
  const go = e => { e.preventDefault(); if (names.length && !bad) { onInstall(null, names); setText('') } }
  return (
    <section className="ap-sec">
      <h2>{t('sec.byName')}</h2>
      <p className="ap-sub">{t('sec.byNameSub')}</p>
      <form className="ap-byname" onSubmit={go}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder={t('byName.placeholder')} aria-label={t('sec.byName')} spellCheck={false} autoCapitalize="off" />
        <button className="ap-btn ap-primary" type="submit" disabled={!names.length || !!bad || !s?.inBox || s?.canInstall === false}><Download size={13} />{t('install')}</button>
      </form>
      {bad && <p className="ap-warn">{t('byName.bad', { name: bad })}</p>}
    </section>
  )
}

/** The classic mode's view of a running app: the whole page, a way back. */
function Inline({ t, lang, v, s }) {
  const app = entry(v.appId)
  const Icon = iconOf(app?.icon)
  const live = v.term || s?.sessions?.some(x => x.id === v.session)
  return (
    <div className="ap-inline">
      <header className="ap-inline-bar">
        <button className="ap-btn" onClick={() => inline.set(null)}><ArrowLeft size={14} />{t('back')}</button>
        <span className="ap-inline-title"><Icon size={15} />{app?.name[lang] || v.appId}</span>
        <span className="ap-grow" />
        {live && !v.term && <button className="ap-btn" onClick={() => { stopSession(v.session); inline.set(null) }}><X size={13} />{t('close')}</button>}
      </header>
      <div className="ap-inline-body">{v.term
        ? <TermView appId={v.appId} active lang={lang} alive={() => termAlive(v.appId)} onCloseWindow={() => inline.set(null)} />
        : <VncView session={v.session} pixels={v.pixels} terminal={!!app?.terminal} active lang={lang} alive={alive} onCloseWindow={() => inline.set(null)} />}</div>
    </div>
  )
}

function AppsPage({ t, locale }) {
  const lang = langOf(locale)
  const s = useApps()
  const v = useSyncExternalStore(inline.subscribe, inline.get, inline.get)
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('') // the app being opened
  const [, rerender] = useState(0)
  // the desktop coming or going changes how an app opens
  useEffect(() => { const on = () => rerender(n => n + 1); addEventListener('ruyix:desk', on); return () => removeEventListener('ruyix:desk', on) }, [])
  const fail = err => setError(errText(t, err))
  const install = useCallback((app, packages) => {
    setError('')
    call('install', app ? { appId: app.id } : packages === 'support' ? { support: true } : { packages }).then(() => store.refresh(), fail)
  }, [t])
  const uninstall = useCallback(app => {
    setError('')
    call('uninstall', { appId: app.id }).then(() => store.refresh(), fail)
  }, [t])
  const open = useCallback(app => {
    setError(''); setBusy(app.id)
    openApp(app.id, lang).catch(fail).finally(() => setBusy(''))
  }, [lang, t])
  const end = useCallback(app => { setError(''); endTerm(app.id).catch(fail) }, [t])
  const stop = useCallback(session => { if (window.__ruyixDesk?.has(`linux:${session.appId}`)) window.__ruyixDesk.close(`linux:${session.appId}`); else stopSession(session.id) }, [])
  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => CATALOG.filter(a => !needle || `${a.id} ${a.name.zh} ${a.name.en} ${a.summary.zh} ${a.summary.en} ${a.packages.join(' ')}`.toLowerCase().includes(needle)), [needle])
  const gui = shown.filter(windowed), cli = shown.filter(a => a.kind === 'cli')
  const supportJob = s?.jobs?.find(j => j.appId === 'support' && (j.state === 'queued' || j.state === 'running'))
  const cards = list => <div className="ap-grid">{list.map(a => <Card key={a.id} t={t} lang={lang} app={a} s={s} busy={busy} onInstall={install} onUninstall={uninstall} onOpen={open} onStop={stop} onEnd={end} />)}</div>
  return (
    <div className="ap-page">
      <style>{tokens}</style>
      {v && !window.__ruyixDesk ? <Inline t={t} lang={lang} v={v} s={s} /> : (
        <>
          <header className="ap-header">
            <span className="ap-glyph"><LayoutGrid size={18} /></span>
            <div className="ap-head-text"><h1>{t('title')}</h1><span className="ap-sub">{t('subtitle')}</span></div>
            <span className="ap-grow" />
            <Pixels t={t} />
            <label className="ap-search"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={t('search')} aria-label={t('search')} /></label>
            <button className="ap-btn" onClick={() => store.refresh()} aria-label={t('refresh')} title={t('refresh')}><RefreshCw size={14} /></button>
          </header>
          <main className="ap-main">
            <div>
              {(error || (store.error && !s)) && <div className="ap-alert"><AlertTriangle size={14} />{error || errText(t, store.error)}</div>}
              {s && !s.inBox && (
                <section className="ap-note">
                  <Monitor size={18} /><div><h3>{t('out.title')}</h3><p>{t('out.body')}</p>{!s.dpkg && <p className="ap-sub">{t('nodpkg')}</p>}</div>
                </section>
              )}
              {s?.inBox && s.canInstall === false && (
                <section className="ap-note ap-note-warn">
                  <AlertTriangle size={18} />
                  <div>
                    <h3>{t('deny.title')}</h3><p>{t('deny.body')}</p>
                    <CopyCmd t={t} cmd={`nookbox update ${s.box || '<box>'} --self-install true`} />
                    <p>{t('deny.or')}</p>
                    <CopyCmd t={t} cmd={`nookbox install ${s.box || '<box>'} <${lang === 'zh' ? '软件包' : 'packages'}>`} />
                  </div>
                </section>
              )}
              {s?.inBox && s.dpkg && !s.support.ready && (
                <section className="ap-note">
                  <Monitor size={18} />
                  <div>
                    <h3>{t('support.title')}</h3><p>{t('support.body', { n: GUI_SUPPORT.length, missing: s.support.missing.join(' ') })}</p>
                    <button className="ap-btn ap-primary" disabled={!!supportJob || s.canInstall === false} onClick={() => install(null, 'support')}>
                      {supportJob ? <Loader2 size={13} className="ap-spin" /> : <Download size={13} />}{t(supportJob ? 'state.installing' : 'support.install')}
                    </button>
                  </div>
                </section>
              )}
              <Jobs t={t} jobs={s?.jobs} />
              <MadeSection lang={lang} needle={needle} iconOf={madeIcon} />
              {gui.length > 0 && <section className="ap-sec"><h2>{t('sec.gui')}</h2><p className="ap-sub">{t('sec.guiSub')}</p>{cards(gui)}</section>}
              {cli.length > 0 && <section className="ap-sec"><h2>{t('sec.cli')}</h2><p className="ap-sub">{t('sec.cliSub')}</p>{cards(cli)}</section>}
              {!shown.length && <p className="ap-sub ap-empty">{t('nothing')}</p>}
              <ByName t={t} s={s} onInstall={install} />
            </div>
          </main>
        </>
      )}
    </div>
  )
}

// ── the ⌘K palette: "Open <app>" for each installed graphical app, and this page ──
/**
 * The desk's widget of Linux apps (the desktop's widgets, window.__ruyixWidgetDefs): the installed graphical apps, a
 * click opens one, a dot marks those open. Small: four, as icons; medium: eight, named. In the gallery's preview: the
 * catalog's first ones.
 */
export function LauncherWidget({ size, lang = 'zh', preview = false }) {
  const s = useApps()
  const t = k => word(lang, k)
  const gui = CATALOG.filter(windowed)
  const apps = (preview ? gui : gui.filter(a => s?.installed?.[a.id])).slice(0, size === 'sm' ? 4 : 8)
  const open = a => { if (!preview) openApp(a.id, lang).catch(() => {}) }
  const short = shortName(lang)
  const center = () => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: PANEL } }))
  return (
    <div className={`ap-wl ap-wl-${size}`}>
      {size !== 'sm' && <div className="ad-w-cap"><span>{t('widget.title')}</span><button type="button" onClick={center}>{t('widget.more')}</button></div>}
      {apps.length ? (
        <div className="ap-wl-grid">
          {apps.map(a => {
            const Icon = iconOf(a.icon), on = !preview && (s?.sessions?.some(x => x.appId === a.id) || !!s?.terms?.[a.id]?.running)
            return (
              <button key={a.id} type="button" className="ap-wl-app" title={a.name[lang] || a.name.en} onClick={() => open(a)}>
                <span className="ap-wl-icon"><Icon size={size === 'sm' ? 20 : 18} />{on && <i />}</span>
                {size !== 'sm' && <span className="ap-wl-name">{short(a)}</span>}
              </button>
            )
          })}
        </div>
      ) : <button type="button" className="ap-wl-none" onClick={center}>{t('widget.none')}</button>}
    </div>
  )
}
/**
 * An app's short name under its icon: its name before the brackets — or, when another app shares that, what is in
 * them (终端 · Zellij · GNOME 控制台 · xterm, not four 终端).
 */
export function shortName(lang) {
  const full = a => a.name[lang] || a.name.en
  const before = a => full(a).split(/[（(]/)[0].trim()
  const inside = a => (/[（(]([^）)]+)[）)]/.exec(full(a)) || [])[1]?.trim()
  const seen = {}
  for (const a of CATALOG.filter(windowed)) seen[before(a)] = (seen[before(a)] || 0) + 1
  return a => (seen[before(a)] > 1 && inside(a)) || before(a)
}
const WIDGET = { type: 'apps:launcher', name: { zh: 'Linux 应用', en: 'Linux apps' }, sizes: ['sm', 'md'], render: LauncherWidget }

export function paletteProvider() {
  return {
    id: PANEL,
    async items(_query, lang) {
      const l = lang === 'en' ? 'en' : 'zh'
      const group = word(l, 'pal.group')
      const s = store.value && Date.now() - (store.at || 0) < 5000 ? store.value : await call('state').catch(() => null)
      const apps = CATALOG.filter(a => windowed(a) && s?.installed?.[a.id])
      const Grid = LayoutGrid
      return [
        ...madeNow().map(a => ({ group, label: word(l, 'pal.open', { name: a.name }), keys: `${a.id} ${a.name} ${a.summary || ''} made 我做的 open 打开`, run: () => window.__ruyixMade?.open(a.id) })),
        ...apps.map(a => {
          const I = iconOf(a.icon)
          return { group, label: word(l, 'pal.open', { name: a.name[l] }), icon: <I size={14} />, keys: `${a.id} ${a.name.zh} ${a.name.en} ${a.kind === 'term' ? `${a.mux} shell 命令行` : ''} open 打开`, run: () => openApp(a.id, l).catch(err => window.dispatchEvent(new CustomEvent('ruyix:notify', { detail: { title: a.name[l], text: errText((k, p) => word(l, k, p), err), panel: PANEL } }))) }
        }),
        { group, label: word(l, 'pal.center'), icon: <Grid size={14} />, keys: 'app center apps install 应用中心 安装 软件', run: () => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: PANEL } })) },
      ]
    },
  }
}

export const inject = ['slots', 'locale', 'layout']
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'apps: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS, inject: () => ({ t, locale: ctx.locale }) }, AppsPage))
  // with the shell: in the System group, after the connections
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 42, locale: NS, label: () => t('panel') }, ({ size }) => <LayoutGrid size={size || 16} strokeWidth={1.6} />))
  // the app windows are drawn by the desktop, outside this page: their look goes in the document once
  ctx.effect(() => {
    const el = document.createElement('style')
    el.dataset.ruyixApps = ''
    el.textContent = `${xtermCss}\n${css}`
    document.head.appendChild(el)
    return () => el.remove()
  }, 'apps: window styles')
  // the person's own apps (made.jsx): the list, their windows and widgets, the main agent's asks about them
  ctx.effect(() => startMade({ call, iconOf: madeIcon, lang: () => langOf(ctx.locale) }), 'apps: the person\'s own apps')
  // the desk's widget (the desktop's widgets read window.__ruyixWidgetDefs; the event says the list changed)
  ctx.effect(() => {
    window.__ruyixWidgetDefs = [...(window.__ruyixWidgetDefs || []).filter(d => d.type !== WIDGET.type), WIDGET]
    window.dispatchEvent(new CustomEvent('ruyix:widget'))
    return () => { window.__ruyixWidgetDefs = (window.__ruyixWidgetDefs || []).filter(d => d !== WIDGET); window.dispatchEvent(new CustomEvent('ruyix:widget')) }
  }, 'apps: desk widget')
  // the agents' browser (lib/browser.js) on the desk: its window goes with the work using it; a hand-off is a work item
  // waiting for the person, told once and its window brought up; who has it, for whatever shows it
  // (window.__ruyixBrowser: { holder, queue, person, giveBack() } and 'ruyix:browser')
  ctx.effect(() => {
    let told = null, key = ''
    const look = async () => {
      if (document.hidden) return
      const b = (await call('browserState').catch(() => null))?.browser
      if (!b) return
      const now = JSON.stringify(b)
      if (now === key) return
      key = now
      window.__ruyixBrowser = { ...b, giveBack: () => call('browserPersonDone').then(look, () => {}) }
      window.dispatchEvent(new Event('ruyix:browser'))
      const reg = openRegistry(), it = reg.list().find(x => x.id === 'win:linux:agent-browser')
      const of = b.holder?.of || undefined
      if (it && (it.of || undefined) !== of) reg.add({ id: it.id, kind: 'app', title: it.title, ...(it.names && { names: it.names }), hint: 'agent-browser', win: it.win, reopen: it.reopen, ...(of && { of }) })
      const h = b.holder
      workRegistry().set('browser', h?.waiting ? [{
        id: `browser:${h.who}`, kind: 'browser', title: h.title, state: 'waiting', segs: [{ title: h.waiting, st: 'wait' }], cur: 0,
        agents: [{ id: h.who, kind: 'browser', state: 'waiting', step: h.waiting }], startedAt: h.since, seen: false,
        open: { event: 'ruyix-apps:open', detail: { appId: 'agent-browser' } },
      }] : [])
      // (a run's hand-off is its blocking decision: the inbox tells him — one notice, not two)
      if (h?.waiting && told !== `${h.who}:${h.waiting}` && !String(h.of || '').startsWith('run:')) {
        told = `${h.who}:${h.waiting}`
        const l = langOf(ctx.locale)
        window.dispatchEvent(new CustomEvent('ruyix:notify', { detail: { title: word(l, 'browser.yourTurn'), text: h.waiting } }))
        window.dispatchEvent(new CustomEvent('ruyix-desk:focus', { detail: { win: 'linux:agent-browser' } }))
      }
    }
    // the terminals' sessions (every third look): one running with no item gets one, in the background; one in the
    // background whose session ended goes (Ethan: a closed window whose session runs on is still one of the open things)
    let n = 0
    const lookTerms = async () => {
      const r = await call('terms').catch(() => null)
      if (!r?.terms) return
      const reg = openRegistry(), desk = window.__ruyixDesk, l = langOf(ctx.locale)
      // (an app's row kept from before it had both names: the catalog's, so the desk says it in the page's language)
      for (const a of CATALOG) for (const id of [`win:term:${a.id}`, `win:linux:${a.id}`]) if (reg.list().some(x => x.id === id && !x.names)) reg.rename?.(id, { names: a.name })
      for (const a of CATALOG.filter(x => x.kind === 'term')) {
        const id = `win:term:${a.id}`, it = reg.list().find(x => x.id === id), on = !!r.terms[a.id]?.running, shown = !!desk?.has?.(`term:${a.id}`)
        if (on && !it) { reg.add({ id, kind: 'term', title: a.name[l] || a.name.en, names: a.name, hint: a.id, win: `term:${a.id}`, reopen: { event: 'ruyix-apps:open', detail: { appId: a.id } }, bg: true }); reg.fold(id, true) }
        else if (!on && it && !shown) reg.close(id)
      }
      // every other session, each a row: the person's own in the terminals' group; an agent session's mirror window
      // (Agent Hub's ruyix-agents: one window per session, named «title·<its id's last 5>») with that session's work
      const ss = (await call('termSessions').catch(() => null))?.sessions
      if (!ss) return
      const agentSessions = Object.values(await fetch('api/agent-hub', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'sessions' }) }).then(r => r.json()).then(j => j.sessions || [], () => []))
      const here = new Set()
      for (const a of CATALOG.filter(x => x.kind === 'term')) {
        for (const s of ss[a.id] || []) {
          if (s.session === 'main') continue // (the app's own: its window's row above)
          const rows = s.session === 'ruyix-agents' ? s.windows.filter(w => /·[\w-]{5}$/.test(w.name)).map(w => {
            const tail = w.name.slice(-5), d = agentSessions.find(x => String(x.id).endsWith(tail))
            return { id: `tsess:${a.id}:${s.session}:${w.index}`, title: w.name.slice(0, -6).trim() || w.name, of: d ? `session:${d.id}` : undefined, at: { session: s.session, window: w.index } }
          }) : [{ id: `tsess:${a.id}:${s.session}`, title: `${a.mux === 'zellij' ? 'Zellij' : 'tmux'}：${s.session}`, at: { session: s.session } }]
          for (const r of rows) {
            here.add(r.id)
            const it = reg.list().find(x => x.id === r.id)
            if (!it || it.title !== r.title || (it.of || undefined) !== r.of) reg.add({ id: r.id, kind: 'term', title: r.title, hint: a.id, ...(r.of && { of: r.of }), bg: true, reopen: { event: 'ruyix-apps:term-at', detail: { appId: a.id, ...r.at, title: r.title } } })
          }
        }
      }
      for (const x of reg.list()) if (x.id.startsWith('tsess:') && !here.has(x.id)) reg.forget(x.id)
      // the folders the file managers have open, each a row of the files' group; a click shows that window
      const fw = (await call('fileWindows').catch(() => null))?.windows
      if (!fw) return
      const seen = new Set()
      for (const w of fw) {
        const id = `fwin:${w.appId}:${w.win}`
        seen.add(id)
        const it = reg.list().find(x => x.id === id)
        if (!it || it.title !== w.folder) reg.add({ id, kind: 'file', icon: 'Folder', title: w.folder, hint: w.appId, reopen: { event: 'ruyix-apps:win', detail: { appId: w.appId, session: w.session, win: w.win } } })
      }
      for (const x of reg.list()) if (x.id.startsWith('fwin:') && !seen.has(x.id)) reg.forget(x.id)
    }
    // the browser's tabs, each one of the open things (Ethan: a tab an agent opened for a piece of work is with that work;
    // his own are rows of the browser's group): kept in step every other look — a tab gone, its row too
    const lookTabs = async () => {
      const r = await call('browserTabs').catch(() => null)
      if (!r?.tabs) return
      const reg = openRegistry(), here = new Set()
      for (const t of r.tabs) {
        const id = `tab:${t.id}`, title = t.title || hostOf(t.url), of = t.of || undefined
        here.add(id)
        const it = reg.list().find(x => x.id === id)
        if (!it || it.title !== title || it.hint !== t.url || (it.of || undefined) !== of) reg.add({ id, kind: 'web', title, hint: t.url, ...(of && { of }), reopen: { event: 'ruyix-apps:tab', detail: { tab: t.id } } })
      }
      for (const x of reg.list()) if (x.id.startsWith('tab:') && !here.has(x.id)) reg.forget(x.id)
    }
    const tick = () => { look(); if (n % 2 === 0 && !document.hidden) lookTabs(); if (n++ % 3 === 0 && !document.hidden) lookTerms() }
    tick()
    const timer = setInterval(tick, 3000)
    return () => clearInterval(timer)
  }, 'apps: the agents\' browser and the terminals on the desk')
  // what the main agent asked of this page (the shell's page actions): an app's window opened, or closed
  ctx.effect(() => {
    const lang = () => langOf(ctx.locale)
    const open = e => { const id = String(e.detail?.appId || ''); if (entry(id)) openApp(id, lang()).catch(err => window.dispatchEvent(new CustomEvent('ruyix:notify', { detail: { title: entry(id).name[lang()], text: errText((k, p) => word(lang(), k, p), err), panel: PANEL } }))) }
    const close = e => { const id = String(e.detail?.appId || ''), desk = window.__ruyixDesk; for (const w of [`linux:${id}`, `term:${id}`]) if (desk?.has(w)) desk.close(w) }
    // a tab of the agents' browser (one of the open things): its window up, that tab in front
    const tab = e => { const id = String(e.detail?.tab || ''); openApp('agent-browser', lang()).then(() => call('browserFocus', { tab: id })).catch(() => {}) }
    // a terminal session other than the app's own (or one of its windows): a window attached there
    const termAt = e => { const d = e.detail || {}, app = entry(String(d.appId || '')); if (app?.kind === 'term' && d.session) openTerm(app, lang(), { session: String(d.session), ...(d.window != null && { window: Number(d.window) }), ...(d.title && { title: String(d.title) }) }) }
    window.addEventListener('ruyix-apps:term-at', termAt)
    // one of a file manager's windows: the app's window up, that folder's window in front
    const win = e => { const d = e.detail || {}; openApp(String(d.appId || ''), lang()).then(() => call('fileWindowFocus', { session: d.session, win: d.win })).catch(() => {}) }
    window.addEventListener('ruyix-apps:win', win)
    window.addEventListener('ruyix-apps:open', open)
    window.addEventListener('ruyix-apps:close', close)
    window.addEventListener('ruyix-apps:tab', tab)
    return () => { window.removeEventListener('ruyix-apps:open', open); window.removeEventListener('ruyix-apps:close', close); window.removeEventListener('ruyix-apps:tab', tab); window.removeEventListener('ruyix-apps:term-at', termAt); window.removeEventListener('ruyix-apps:win', win) }
  }, 'apps: the main agent\'s asks')
  ctx.effect(() => {
    const p = paletteProvider()
    const list = Array.isArray(window.__ruyixPalette) ? window.__ruyixPalette : (window.__ruyixPalette = [])
    list.push(p)
    return () => { const at = list.indexOf(p); if (at >= 0) list.splice(at, 1) }
  }, 'apps: palette')
}
