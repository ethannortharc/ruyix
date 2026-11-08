// Agents → Runtimes: the CLIs agents run on (Claude Code, Codex, pi) as packages of this home — installed, updated,
// pinned and removed here; their sign-in from the page (in a box the tokens stay in the host's vault). Below them the
// model endpoints (endpoints.js): an address, its protocol, key and models, for an agent whose model is not its
// runtime's own.
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Boxes, Check, CheckCircle2, Code2, Copy, Download, ExternalLink, KeyRound, Loader2, LogOut, Pin, Plug, RefreshCw, Settings2, ShieldAlert, ShieldCheck, Sigma, Sparkles, Trash2, X } from 'lucide-react'
import { call } from './data.js'
import { cx, errorText, useT } from './ui.jsx'

const ICON = { claude: Code2, codex: Boxes, pi: Sigma }
const spring = { type: 'spring', stiffness: 380, damping: 32 }

export function RuntimesPage({ toast, onBack, onChanged }) {
  const t = useT()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState({}) // runtime → what is running
  const [checking, setChecking] = useState(false)
  const [signIn, setSignIn] = useState(null) // runtime being signed in
  const [keyFor, setKeyFor] = useState(null) // runtime getting an API key
  const load = async fresh => {
    if (fresh) setChecking(true)
    try { setData(await call('runtimes', { fresh: !!fresh })); setError('') } catch (err) { setError(err) } finally { setChecking(false) }
  }
  useEffect(() => { load(false) }, [])
  const replace = view => setData(d => ({ ...d, runtimes: d.runtimes.map(r => (r.runtime === view.runtime ? view : r)) }))
  // one action on one runtime; a refusal that a person can overrule (tasks running, another install) asks first
  const act = async (rt, what, op, args, done) => {
    setWorking(w => ({ ...w, [rt.runtime]: what })); setError('')
    try {
      replace((await call(op, { runtime: rt.runtime, ...args })).runtime)
      if (done) toast(done)
      onChanged?.()
    } catch (err) {
      if (err.code === 'runtimeBusy' && window.confirm(t('rts.forceConfirm', { name: rt.name, tasks: err.params?.tasks || '' }))) return act(rt, what, op, { ...args, force: true }, done)
      if (err.code === 'installedElsewhere' && window.confirm(t('rts.replaceConfirm', { name: rt.name, path: err.params?.path || rt.path || '' }))) return act(rt, what, op, { ...args, replace: true }, done)
      setError(err)
    } finally { setWorking(w => { const { [rt.runtime]: _, ...rest } = w; return rest }) }
  }
  const auto = async (rt, on) => {
    try { await call('runtimeAuto', { runtime: rt.runtime, on }); replace({ ...rt, autoUpdate: on }) } catch (err) { setError(err) }
  }
  return (
    <motion.div className="ah-detail-card ah-team-view ah-rts" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <div className="ah-team-head">
        {onBack && <button className="ah-icon-btn" onClick={onBack} aria-label={t('rts.back')} title={t('rts.back')}><ArrowLeft size={16} /></button>}
        <span className="ah-hero-glyph ah-small"><Sparkles size={18} /></span>
        <div className="ah-hero-title"><h2>{t('rts.title')}</h2><span className="ah-sub">{t(data?.box ? 'rts.hintBox' : 'rts.hint', { box: data?.box || '' })}</span></div>
        <div className="ah-actions">
          <button className="ah-btn" disabled={checking} onClick={() => load(true)}>{checking ? <Loader2 size={13} className="ah-spin" /> : <RefreshCw size={13} />}{t('rts.check')}</button>
        </div>
      </div>
      {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
      {!data ? <div className="ah-skeleton">{[0, 1, 2].map(i => <span key={i} />)}</div> : (
        <>
          <div className="ah-rts-grid">
            {data.runtimes.map(rt => <RuntimeCard key={rt.runtime} rt={rt} working={working[rt.runtime]} act={act} auto={auto} onSignIn={() => setSignIn(rt)} onKey={() => setKeyFor(rt)} />)}
          </div>
          <Endpoints />
        </>
      )}
      <AnimatePresence>
        {signIn && <SignInDialog key="signin" rt={signIn} box={data?.box} onClose={() => { setSignIn(null); load(false); onChanged?.() }} />}
        {keyFor && <KeyDialog key="key" rt={keyFor} box={data?.box} onClose={() => setKeyFor(null)}
          onSaved={r => { replace(r.runtime); toast(t(r.verified ? 'rts.keySaved' : 'rts.keySavedUnverified', { name: keyFor.name })); setKeyFor(null); onChanged?.() }} />}
      </AnimatePresence>
    </motion.div>
  )
}

function RuntimeCard({ rt, working, act, auto, onSignIn, onKey }) {
  const t = useT()
  const [pin, setPin] = useState('')
  const Icon = ICON[rt.runtime] || Code2
  const viaEndpoint = rt.viaEndpoint && rt.status === 'unauthenticated' // (its agents' models come from endpoints)
  // (pi has no sign-in: what it lacks is a model — a model endpoint with its key)
  const piNoModel = rt.runtime === 'pi' && rt.status === 'unauthenticated' && !viaEndpoint
  const tone = rt.status === 'ready' || viaEndpoint ? 'done' : rt.status === 'missing' ? 'idle' : 'waiting'
  const ours = rt.managed === 'ruyix'
  return (
    <div className={cx('ah-rts-card', working && 'ah-rts-busy')}>
      <div className="ah-rts-top">
        <span className={cx('ah-rts-icon', `ah-rt-${rt.runtime}`)}><Icon size={18} /></span>
        <div className="ah-rts-name"><b>{rt.name}</b><span className="ah-mono ah-sub">{rt.package}</span></div>
        <span className={cx('ah-chip', `ah-tone-${tone}`, 'ah-rts-state')} title={viaEndpoint ? t('rts.viaEndpointHint') : undefined}>{t(viaEndpoint ? 'rts.viaEndpoint' : piNoModel ? 'rts.piNoModel' : `rts.state.${rt.status}`)}</span>
      </div>
      <div className="ah-rts-facts">
        <div><span className="ah-sub">{t('rts.version')}</span>
          <b className="ah-mono">{rt.version || '—'}</b>
          {rt.updateAvailable && <span className="ah-rts-update">{t('rts.updateTo', { v: rt.latest })}</span>}
        </div>
        <div><span className="ah-sub">{t('rts.latest')}</span><span className="ah-mono">{rt.latest || '—'}</span></div>
        {rt.canKey && rt.managed && <div><span className="ah-sub">{t('rts.how')}</span>
          <span className={cx(rt.how === 'key' && 'ah-mono')}>{rt.how === 'key' ? (rt.keyTail ? t('rts.how.key', { tail: rt.keyTail }) : t('rts.how.keyEnv')) : rt.how === 'account' ? t('rts.how.account') : '—'}</span></div>}
        <div className="ah-rts-where"><span className="ah-sub">{t('rts.where')}</span>
          <span>{ours ? t('rts.managed') : rt.managed === 'elsewhere' ? t('rts.elsewhere') : t('rts.none')}</span>
          {rt.managed === 'elsewhere' && rt.path && <span className="ah-mono ah-sub ah-rts-path" title={rt.path}>{rt.path}</span>}
        </div>
      </div>
      {(rt.agents.length > 0 || rt.busy.length > 0) && (
        <div className="ah-rts-uses">
          {rt.agents.length > 0 && <span className="ah-sub">{t('rts.usedBy')}</span>}
          {rt.agents.map(id => <span key={id} className="ah-chip">{id}</span>)}
          {rt.busy.length > 0 && <span className="ah-note ah-tone-waiting">{t('rts.running', { n: rt.busy.length })}</span>}
        </div>
      )}
      <div className="ah-rts-actions">
        {working ? <span className="ah-rts-working"><Loader2 size={13} className="ah-spin" />{t(`rts.working.${working}`)}</span> : <>
          {!rt.managed && <button className="ah-btn ah-primary" onClick={() => act(rt, 'install', 'runtimeInstall', {}, t('rts.installed', { name: rt.name }))}><Download size={13} />{t('rts.install')}</button>}
          {ours && rt.updateAvailable && <button className="ah-btn ah-primary" onClick={() => act(rt, 'install', 'runtimeInstall', { version: rt.latest }, t('rts.updated', { name: rt.name, v: rt.latest }))}><Download size={13} />{t('rts.update')}</button>}
          {rt.managed === 'elsewhere' && <button className="ah-btn" onClick={() => act(rt, 'install', 'runtimeInstall', {}, t('rts.installed', { name: rt.name }))}><Download size={13} />{t('rts.takeOver')}</button>}
          {piNoModel && rt.managed && <button className="ah-btn ah-primary" title={t('rts.piSetModelHint')} onClick={openModelSettings}><Settings2 size={13} />{t('rts.piSetModel')}</button>}
          {rt.canKey && rt.managed && <>
            <button className={cx('ah-btn', rt.status !== 'ready' && 'ah-primary')} onClick={onSignIn}><KeyRound size={13} />{t(rt.how === 'key' ? 'rts.signInAccount' : rt.status === 'ready' ? 'rts.signInAgain' : 'rts.signIn')}</button>
            <button className="ah-btn" onClick={onKey}><KeyRound size={13} />{t(rt.how === 'key' ? 'rts.keyChange' : 'rts.keyUse')}</button>
            {rt.authenticated && <button className="ah-btn" onClick={() => window.confirm(t('rts.signOutConfirm', { name: rt.name })) && act(rt, 'signout', 'runtimeLogout', {}, t('rts.signedOut', { name: rt.name }))}><LogOut size={13} />{t('rts.signOut')}</button>}
          </>}
        </>}
      </div>
      <div className="ah-rts-foot">
        <form className="ah-rts-pin" onSubmit={e => { e.preventDefault(); if (pin.trim()) act(rt, 'install', 'runtimeInstall', { version: pin.trim() }, t('rts.pinned', { name: rt.name, v: pin.trim() })).then(() => setPin('')) }}>
          <input className="ah-input ah-mono" value={pin} placeholder={t('rts.pinHint')} onChange={e => setPin(e.target.value)} disabled={!!working} aria-label={t('rts.pin')} />
          <button className="ah-btn" disabled={!pin.trim() || !!working} title={t('rts.pin')}><Pin size={13} />{t('rts.pin')}</button>
        </form>
        <label className={cx('ah-rts-auto', !ours && 'ah-off')} title={ours ? t('rts.autoHint') : t('rts.autoOnlyOurs')}>
          <input type="checkbox" checked={!!rt.autoUpdate} disabled={!ours} onChange={e => auto(rt, e.target.checked)} />
          <span>{t('rts.auto')}</span>
        </label>
        {ours && <button className="ah-icon-btn ah-danger" title={t('rts.remove')} aria-label={t('rts.remove')} disabled={!!working}
          onClick={() => window.confirm(t('rts.removeConfirm', { name: rt.name })) && act(rt, 'remove', 'runtimeRemove', {}, t('rts.removed', { name: rt.name }))}><Trash2 size={14} /></button>}
      </div>
    </div>
  )
}

/** A CLI's own sign-in, shown here: Claude Code's link and the code to paste back, Codex's device code. */
function SignInDialog({ rt, box, onClose }) {
  const t = useT()
  const [st, setSt] = useState({ status: 'starting' })
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    let timer = null
    const poll = async () => {
      try { const r = await call('runtimeLoginState'); if (!alive.current) return; setSt(r); if (r.status === 'waiting' || r.status === 'starting') timer = setTimeout(poll, 1500) } catch (err) { if (alive.current) setError(err) }
    }
    call('runtimeLogin', { runtime: rt.runtime }).then(r => { if (!alive.current) return; setSt(r); timer = setTimeout(poll, 1500) }, err => alive.current && (setError(err), setSt({ status: 'failed' })))
    return () => { alive.current = false; clearTimeout(timer) }
  }, [rt.runtime])
  const close = () => { if (st.status === 'waiting' || st.status === 'starting') call('runtimeLoginStop').catch(() => {}); onClose() }
  const send = async () => {
    setError('')
    try { setSt(await call('runtimeLoginCode', { code })) } catch (err) { setError(err) }
  }
  const copy = () => navigator.clipboard?.writeText(st.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
  const waiting = st.status === 'waiting'
  return (
    <motion.div className="ah-modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={e => e.target === e.currentTarget && close()}>
      <motion.div className="ah-modal ah-modal-small ah-rts-signin" role="dialog" aria-modal="true" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={spring}>
        <div className="ah-modal-head">
          <div className="ah-hero-glyph ah-small"><KeyRound size={18} /></div>
          <div><h2>{t('rts.signInTitle', { name: rt.name })}</h2><span className="ah-sub">{t(box ? 'rts.signInBox' : 'rts.signInHost')}</span></div>
          <button className="ah-icon-btn" onClick={close} aria-label={t('close')}><X size={16} /></button>
        </div>
        {st.status === 'starting' && !error && <div className="ah-rts-step"><Loader2 size={14} className="ah-spin" />{t('rts.starting')}</div>}
        {st.url && (st.status === 'waiting' || st.status === 'done') && (
          <ol className="ah-rts-steps">
            <li>
              <span>{t(st.needsCode ? 'rts.step1Claude' : 'rts.step1Codex')}</span>
              <a className="ah-btn ah-primary" href={st.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} />{t('rts.openLink')}</a>
            </li>
            {!st.needsCode && st.code && (
              <li>
                <span>{t('rts.step2Codex')}</span>
                <div className="ah-rts-code"><b className="ah-mono">{st.code}</b>
                  <button className="ah-btn" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}{t(copied ? 'rts.copied' : 'rts.copy')}</button></div>
              </li>
            )}
            {st.needsCode && waiting && (
              <li>
                <span>{t('rts.step2Claude')}</span>
                <form className="ah-rts-codeform" onSubmit={e => { e.preventDefault(); if (code.trim()) send() }}>
                  <input className="ah-input ah-mono" autoFocus value={code} placeholder={t('rts.codeHint')} onChange={e => setCode(e.target.value)} />
                  <button className="ah-btn ah-primary" disabled={!code.trim()}>{t('rts.sendCode')}</button>
                </form>
              </li>
            )}
          </ol>
        )}
        {waiting && <div className="ah-rts-step ah-sub"><Loader2 size={13} className="ah-spin" />{t(st.needsCode ? 'rts.waitingClaude' : 'rts.waitingCodex')}</div>}
        {st.status === 'done' && (
          st.kept === 'box'
            ? <div className="ah-rts-result ah-tone-error"><ShieldAlert size={16} /><span>{t('rts.keptBox')}</span></div>
            : <div className="ah-rts-result ah-tone-done">{st.kept === 'vault' ? <ShieldCheck size={16} /> : <CheckCircle2 size={16} />}<span>{t(st.kept === 'vault' ? 'rts.keptVault' : 'rts.done', { name: rt.name })}</span></div>
        )}
        {st.status === 'failed' && !error && <div className="ah-note ah-tone-error">{st.kept === 'none' ? t('rts.keptNone') : st.error || t('rts.failed')}</div>}
        {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
        <div className="ah-modal-foot">
          <button className={cx('ah-btn', st.status === 'done' && 'ah-primary ah-big')} onClick={close}>{t(st.status === 'done' ? 'rts.close' : 'cancel')}</button>
        </div>
      </motion.div>
    </motion.div>
  )
}

/** An API key instead of an account: checked with the provider, kept in dsh's credential store (in a box: the host's vault). */
function KeyDialog({ rt, box, onClose, onSaved }) {
  const t = useT()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setBusy(true); setError('')
    try { onSaved(await call('runtimeKey', { runtime: rt.runtime, value })) } catch (err) { setError(err); setBusy(false) }
  }
  return (
    <motion.div className="ah-modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={e => e.target === e.currentTarget && !busy && onClose()}>
      <motion.div className="ah-modal ah-modal-small ah-rts-signin" role="dialog" aria-modal="true" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={spring}
        onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}>
        <div className="ah-modal-head">
          <div className="ah-hero-glyph ah-small"><KeyRound size={18} /></div>
          <div><h2>{t('rts.keyTitle', { name: rt.name })}</h2><span className="ah-sub">{t(box ? 'rts.keyBox' : 'rts.keyHost')}</span></div>
          <button className="ah-icon-btn" onClick={onClose} disabled={busy} aria-label={t('close')}><X size={16} /></button>
        </div>
        <form className="ah-rts-codeform" onSubmit={e => { e.preventDefault(); if (value.trim() && !busy) save() }}>
          <input className="ah-input ah-mono" type="password" autoComplete="off" spellCheck={false} autoFocus value={value} placeholder={t(`rts.keyPh.${rt.runtime}`)}
            aria-label={t('rts.keyTitle', { name: rt.name })} onChange={e => setValue(e.target.value)} />
          <button className="ah-btn ah-primary" disabled={!value.trim() || busy}>{busy ? <Loader2 size={13} className="ah-spin" /> : <ShieldCheck size={13} />}{t('rts.keySave')}</button>
        </form>
        <p className="ah-sub ah-rts-keyhint">{t('rts.keyHint')}</p>
        {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
      </motion.div>
    </motion.div>
  )
}

// ── model endpoints: dsh's model providers (Settings → 模型, the one list of where models come from, for the whole
// Ruyix): not listed here any more — a line to there ──
/** Settings → 模型: where they are kept. */
export const openModelSettings = () => window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: 'models' } }))

/** Where the models come from: kept in Settings → 模型 (the one list, for the whole Ruyix), not here. */
function Endpoints() {
  const t = useT()
  return (
    <section className="ah-eps">
      <div className="ah-eps-head">
        <div><h3><Plug size={15} />{t('ep.title')}</h3><span className="ah-sub">{t('ep.moved')}</span></div>
        <button className="ah-btn" onClick={openModelSettings}><Settings2 size={13} />{t('ep.manage')}</button>
      </div>
    </section>
  )
}
