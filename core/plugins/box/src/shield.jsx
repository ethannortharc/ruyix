// The box in two small places outside its page: the desk's 「盒子」 widget (`box:status`) and the top bar's shield (a light
// and a menu). Both read the same thing — the host's `shield` op, polled once for the whole page and shared — so a desk with
// the widget and the bar's shield asks the host once a minute, not twice. Words: locale.js `shield.*`.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ShieldCheck, ArrowUpRight } from 'lucide-react'
import css from './shield.css'
import { en, zh } from './locale.js'

const PANEL = 'ruyix-box'
const WIDGET_TYPE = 'box:status'
const TRAY_ID = 'ruyix-box'
const EVERY = 60e3, OUT_OF_BOX_EVERY = 10 * 60e3 // outside a box nothing changes soon: ask rarely
const dict = { zh, en }
/** A word in the language (the desk hands its widgets a language, not the page's `t`). */
const word = (lang, key, p = {}) => String(dict[lang === 'en' ? 'en' : 'zh'][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => p[k] ?? '')
const stateKey = h => (h === 'bad' ? 'shield.bad' : h === 'warn' ? 'shield.warn' : 'shield.ok')
const localMidnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
const clock = (at, lang) => new Date(at).toLocaleTimeString(lang === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const openBox = () => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: PANEL } }))

// ── the shared store: one poll while anyone shows it and the page is visible; again when the page comes back ──
let state = { value: null, failed: false } // value: the host's last answer; failed: the last ask did not get one
const listeners = new Set()
let timer = null
const set = next => { state = next; for (const fn of listeners) fn() }
async function poll() {
  if (document.hidden) return
  try {
    const res = await fetch('api/ruyix-box', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'shield', since: localMidnight() }) })
    const value = await res.json()
    if (!res.ok || !value || typeof value !== 'object') throw new Error(`HTTP ${res.status}`)
    set({ value, failed: false })
  } catch { set({ value: state.value, failed: true }) }
}
const loop = () => {
  clearTimeout(timer)
  timer = setTimeout(async () => { await poll(); if (listeners.size) loop() }, state.value?.inBox === false ? OUT_OF_BOX_EVERY : EVERY)
}
const wake = () => { if (!document.hidden && listeners.size) { poll(); loop() } }
function subscribe(fn) {
  listeners.add(fn)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake)
    poll(); loop()
  }
  return () => {
    listeners.delete(fn)
    if (!listeners.size) { clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake) }
  }
}
/** The box in a few numbers since local midnight: { value, failed } — value null before the first answer; value.inBox false outside a box. */
export const useShield = () => useSyncExternalStore(subscribe, () => state)

// ── the desk's widget ──
const SAMPLE = { inBox: true, runtime: 'microvm', health: 'ok', requests: 214, blocked: 1, lastBlocked: { at: new Date().setHours(10, 42, 0, 0), subject: 'api.example.com', reason: '' } }

function Face({ s, failed, lang, size, preview }) {
  const w = (k, p) => word(lang, k, p)
  const moved = useRef(false)
  const open = () => { if (!preview) openBox() }
  const props = {
    className: 'bx-w', role: 'button', tabIndex: preview ? -1 : 0, title: preview ? undefined : w('shield.open'),
    // a press that moved the widget is not a click on it
    onPointerDown: e => { moved.current = false; const x = e.clientX, y = e.clientY; const on = ev => { if (Math.hypot(ev.clientX - x, ev.clientY - y) > 5) moved.current = true }; window.addEventListener('pointermove', on); window.addEventListener('pointerup', () => window.removeEventListener('pointermove', on), { once: true }) },
    onClick: () => { if (!moved.current) open() },
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } },
  }
  if (!s) return <p className="ad-w-p ad-w-quiet">{failed ? w('shield.failed') : w('shield.loading')}</p>
  if (s.inBox === false) return <p className="ad-w-p ad-w-quiet">{w('shield.none')}</p>
  if (s.error) return <div {...props}><div className="ad-w-cap"><span>{w('shield.title')}</span></div><p className="ad-w-p ad-w-quiet">{w('shield.failed')}</p></div>
  return (
    <div {...props}>
      <div className="ad-w-cap"><span>{w('shield.title')}</span><small>{w(`shield.${s.runtime}`)}</small></div>
      <div className="ad-w-kv"><span><i className={`ad-w-dot${s.health === 'bad' ? ' ad-bad' : s.health === 'warn' ? ' ad-wait' : ''}`} />{w(stateKey(s.health))}</span></div>
      <div className="ad-w-kv"><span>{w('shield.today')}</span><b>{s.requests}</b></div>
      <div className="ad-w-kv"><span>{w('shield.blocked')}</span><b className={s.blocked > 0 ? 'ad-wait' : undefined}>{s.blocked}</b></div>
      {size === 'md' && s.lastBlocked && <p className="bx-w-last">{w('shield.last', { time: clock(s.lastBlocked.at, lang), subject: s.lastBlocked.subject })}</p>}
    </div>
  )
}
function Live(p) { const { value, failed } = useShield(); return <Face {...p} s={value} failed={failed} /> }
function BoxWidget({ size, lang, preview }) { return preview ? <Face s={SAMPLE} lang={lang} size={size} preview /> : <Live lang={lang} size={size} /> }
const WIDGET = { type: WIDGET_TYPE, name: { zh: '盒子', en: 'Box' }, sizes: ['sm', 'md'], default: 'sm', order: 40, render: BoxWidget }

// ── the top bar's shield ──
function BoxTray({ lang, openInsights }) {
  const w = (k, p) => word(lang, k, p)
  const { value: s, failed } = useShield()
  const [shown, setShown] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!shown) return
    const off = e => { if (!box.current?.contains(e.target)) setShown(false) }, gone = () => setShown(false)
    window.addEventListener('pointerdown', off, true)
    window.addEventListener('ruyix:open', gone)
    return () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener('ruyix:open', gone) }
  }, [shown])
  if (s?.inBox !== true) return null // not in a box (or not known yet): no item
  const bad = s.health === 'bad', amber = !bad && (s.blocked > 0 || s.health === 'warn')
  const state = w(stateKey(s.health))
  const title = s.error || failed ? w('shield.failed') : s.blocked > 0 ? w('shield.tipBlocked', { state, n: s.blocked }) : w('shield.tip', { state })
  return (
    <span ref={box} className="bx-tray">
      <button type="button" className="ad-bar-btn" title={title} aria-label={title} aria-expanded={shown} onClick={() => setShown(v => !v)}>
        <span className="bx-ico">
          <ShieldCheck size={15} strokeWidth={1.7} />
          {!s.error && (bad || amber) && <i className={`bx-light${bad ? ' bx-bad' : ''}`} />}
        </span>
      </button>
      {shown && (
        <div className="ad-menu bx-menu" role="menu">
          <div className="bx-menu-head"><b>{w('shield.title')}</b>{!s.error && <span>{w(`shield.${s.runtime}`)} · {state}</span>}</div>
          {s.error ? <p className="bx-menu-line">{w('shield.failed')}</p> : (
            <>
              <p className="bx-menu-line">{w('shield.requests', { n: s.requests })}</p>
              <p className="bx-menu-line">{w('shield.blockedN', { n: s.blocked })}{s.lastBlocked && <small>{clock(s.lastBlocked.at, lang)} · {s.lastBlocked.subject}{s.lastBlocked.reason ? ` · ${s.lastBlocked.reason}` : ''}</small>}</p>
            </>
          )}
          <button type="button" className="ad-mi" role="menuitem" onClick={() => { setShown(false); openInsights() }}><ArrowUpRight size={14} />{w('shield.open')}</button>
        </div>
      )}
    </span>
  )
}

/** Puts the widget on the desk's list and the shield in the bar's tray (and their styles in the page); returns what takes them off. */
export function startShield({ openInsights }) {
  const style = Object.assign(document.createElement('style'), { id: 'ruyix-box-shield', textContent: css })
  document.head.appendChild(style)
  const tray = { id: TRAY_ID, order: 20, render: props => <BoxTray {...props} openInsights={openInsights} /> }
  window.__ruyixWidgetDefs = [...(window.__ruyixWidgetDefs || []).filter(d => d.type !== WIDGET_TYPE), WIDGET]
  window.__ruyixTray = [...(window.__ruyixTray || []).filter(x => x.id !== TRAY_ID), tray]
  const tell = () => { window.dispatchEvent(new CustomEvent('ruyix:widget')); window.dispatchEvent(new CustomEvent('ruyix:tray')) }
  tell()
  return () => {
    window.__ruyixWidgetDefs = (window.__ruyixWidgetDefs || []).filter(d => d !== WIDGET)
    window.__ruyixTray = (window.__ruyixTray || []).filter(x => x !== tray)
    style.remove()
    tell()
  }
}
