// The sidebar's foot: Settings (out of the list — it is this machine's, not a place of the work), the language and the
// appearance, who this Ruyix is (its name, box and colour: several open side by side), and the versions — this workbench's and, in a box, the nookbox's (the commit in the tooltip). The dsh it runs on is not shown: Ruyix's own record (/api/ruyix/version, ruyix status) keeps it. Wide: a
// row each; as the icon rail: three buttons, the versions in the tooltip.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Monitor, Moon, Settings, Sun } from 'lucide-react'
import { SETTINGS, TEXT } from './settings.jsx'

const THEMES = [['light', Sun], ['dark', Moon], ['system', Monitor]]
const none = { subscribe: () => () => {}, getSnapshot: () => null }

/** The appearance as the theme service has it, and a way to change it (null: no theme service). */
export function lookStore() {
  let svc = null, pref = 'system'
  const subs = new Set(), emit = () => subs.forEach(f => f())
  return {
    attach(theme) { svc = theme; try { pref = theme.getTheme().preference || 'system' } catch { /* not ready */ } emit() },
    detach() { svc = null; emit() },
    changed(p) { pref = p || 'system'; emit() },
    set(p) { try { svc?.setTheme(p) } catch { /* not ready */ } },
    subscribe: f => { subs.add(f); return () => subs.delete(f) },
    getSnapshot: () => (svc ? pref : null),
  }
}

function useVersions() {
  const [v, setV] = useState(null)
  useEffect(() => { fetch('api/ruyix/version').then(r => r.json()).then(setV, () => {}) }, [])
  return v
}

/** Who this Ruyix is (the shell's layout read: window.__ruyixLayout, 'ruyix:layout-changed'): { name, sub, color } or null. */
function useIdentity(lang) {
  const [l, setL] = useState(() => window.__ruyixLayout || null)
  useEffect(() => {
    const on = e => setL(e.detail || null)
    window.addEventListener('ruyix:layout-changed', on)
    setL(window.__ruyixLayout || null)
    return () => window.removeEventListener('ruyix:layout-changed', on)
  }, [])
  const id = l?.identity
  return id ? { name: id.name || l.presets?.find(p => p.id === l.preset)?.title?.[lang] || l.preset, sub: id.sub, color: id.color } : null
}

export function Foot({ wide, layout, locale, look }) {
  // the host's observables keep their state on themselves: called as methods
  const lang = String(useSyncExternalStore(f => locale.subscribe(f), () => locale.getSnapshot().active) || 'en').startsWith('zh') ? 'zh' : 'en'
  const info = layout.panelInfo || none
  const panel = useSyncExternalStore(f => info.subscribe(f), () => info.getSnapshot())
  const pref = useSyncExternalStore(look.subscribe, look.getSnapshot)
  const v = useVersions(), id = useIdentity(lang)
  const T = TEXT[lang], on = panel?.activePanelId === SETTINGS
  const who = id ? `${id.name} · ${id.sub}` : ''
  const open = () => { try { layout.selectPanel(SETTINGS) } catch { /* not ready */ } }
  const setLang = l => { if (l !== lang) try { locale.setLocale(l) } catch { /* that language is not loaded */ } }
  const short = v ? `v${v.ruyix}${v.box !== null && v.box !== undefined ? ` · box${v.box ? ` ${v.box}` : ''}` : ''}` : ''
  const full = v ? [`Ruyix ${v.ruyix}${__RUYIX_COMMIT__ ? ` (${__RUYIX_COMMIT__})` : ''}`, v.box !== null && v.box !== undefined && `nookbox ${v.box || '?'}`].filter(Boolean).join(' · ') : ''
  const ThemeIcon = (THEMES.find(([k]) => k === pref) || THEMES[2])[1]
  if (!wide) {
    const next = THEMES[(THEMES.findIndex(([k]) => k === pref) + 1) % THEMES.length][0]
    return (
      <div className="ruyix-foot ruyix-foot-rail">
        {id && <span className="ruyix-ident-dot" style={{ background: id.color }} title={who} role="img" aria-label={who} />}
        <button className={`ruyix-foot-btn${on ? ' on' : ''}`} onClick={open} title={[T.nav, who, full].filter(Boolean).join('\n')} aria-label={T.nav}><Settings size={17} strokeWidth={1.6} /></button>
        <button className="ruyix-foot-btn ruyix-foot-lang" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title={T.general.language} aria-label={T.general.language}>{lang === 'zh' ? '中' : 'EN'}</button>
        {pref && <button className="ruyix-foot-btn" onClick={() => look.set(next)} title={`${T.general.theme}: ${T.general.themes[pref]}`} aria-label={T.general.theme}><ThemeIcon size={16} strokeWidth={1.6} /></button>}
      </div>
    )
  }
  return (
    <div className="ruyix-foot">
      <button className={`ruyix-foot-nav${on ? ' on' : ''}`} onClick={open} aria-current={on ? 'page' : undefined}><Settings size={16} strokeWidth={1.6} /><span>{T.nav}</span></button>
      <div className="ruyix-foot-prefs">
        <div className="ruyix-seg" role="radiogroup" aria-label={T.general.language}>
          {[['zh', '中'], ['en', 'EN']].map(([k, label]) => <button key={k} role="radio" aria-checked={lang === k} className={lang === k ? 'on' : ''} onClick={() => setLang(k)}>{label}</button>)}
        </div>
        {pref && (
          <div className="ruyix-seg" role="radiogroup" aria-label={T.general.theme}>
            {THEMES.map(([k, Icon]) => <button key={k} role="radio" aria-checked={pref === k} className={pref === k ? 'on' : ''} title={T.general.themes[k]} aria-label={T.general.themes[k]} onClick={() => look.set(k)}><Icon size={13} strokeWidth={1.8} /></button>)}
          </div>
        )}
      </div>
      {id && <span className="ruyix-ident" title={who}><i style={{ background: id.color }} /><b>{id.name}</b><small>{id.sub}</small></span>}
      {short && <span className="ruyix-version" title={full}>{short}</span>}
    </div>
  )
}
