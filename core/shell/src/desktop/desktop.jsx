// The desktop: Ruyix as an operating system in the browser. dsh shows one page at a time (its frame: one main panel);
// the desktop makes that frame a window — a title bar to move it, edges to size it, lights to close, minimize and zoom
// it — on a wallpaper with a quiet clock and widgets (what needs you, how the agents do), under a top bar (this Ruyix,
// the page you are on, what is at work, search, the conversation, the appearance, the time) and over a dock (every page,
// in the sidebar's groups). ⌘K opens the command palette: pages, settings, the look, and a question for the agent. The
// conversation is a sheet on the right that stays open across pages (the workbench draws it: the slot 'ruyix.chat').
// Drawn into document.body (a portal) from dsh's overlay layer, so the desktop is not clipped by the window it frames.
// desktop.json (desktop.js) says how it looks; 'classic' keeps dsh's sidebar and draws only the conversation's sheet.
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AppWindow, ArrowUpRight, Check, Command, Globe, Info, LayoutGrid, LayoutPanelLeft, Loader2, Maximize, Maximize2, MessageCircle, Mic, Minimize, Minus, Monitor, Moon, Palette as Swatch, PanelRight, Search, Settings, SlidersHorizontal, Sparkles, Sun, TriangleAlert, X } from 'lucide-react'
import { ACCENTS, DENSITIES, TRANSPARENCY, SCALES, THEMES, WALLPAPERS, WALLPAPER_GROUPS, scaleOf } from '../../desktop.js'
import { ThemeCards, chooseTheme } from './themes.jsx'
import { MARK_SVG } from '../../mark.js'
import { GROUPS } from '../nav.js'
import { canFullscreen, isFullscreen, subscribeFullscreen, toggleFullscreen } from './fullscreen.js'
import { DATA_SCENES, createWallpaper, paintThumb } from './wallpaper.js'
import { BAR, DOCK, GAP, SHEET, arrangeRects, firstRect, fit, follow, tileRects } from './store.js'
import { textOf } from './text.js'
import { createVoiceInput } from './voice.js'
import { hotkeyLabel } from '../../voice-key.js'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
import { Widgets } from './widgets.jsx'
import { AgentLights } from './agents.jsx'
import { GroupCards } from './groups.jsx'
import { StripDot, WorkStrip } from './strip.jsx'
import { AgentBar } from './agentbar.jsx'
import { AnswerTree } from './tree.jsx'
import { AgentSky } from './sky.jsx'
import { themeCssOf, useWorlds } from './worlds.js'
import { DRAWER_W, WinDrawer, Windows, createWindows, useDeskApi, useWindowTiles } from './windows.jsx'
import { openRegistry } from '../open.js'
import { nameOf } from '../../open-model.js'

export const CHAT_SLOT = 'ruyix.chat'
const TB = 40 // the window's title bar
const markSrc = `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}`
const cx = (...c) => c.filter(Boolean).join(' ')
const label = e => String((typeof e.options?.label === 'function' ? e.options.label() : e.options?.label) || '')
const groupOf = order => GROUPS.findIndex(g => order >= g.from && order <= g.to)

/** Whatever an entry's icon throws stays with it. */
class Contained extends Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children }
}

// ── reading the host ──
const useStore = store => useSyncExternalStore(store.subscribe, store.get)
function useLayoutRead() {
  const [l, setL] = useState(() => window.__ruyixLayout || null)
  useEffect(() => {
    const on = e => setL(e.detail || null)
    window.addEventListener('ruyix:layout-changed', on)
    setL(window.__ruyixLayout || null)
    return () => window.removeEventListener('ruyix:layout-changed', on)
  }, [])
  return l
}
function useViewport() {
  const [v, setV] = useState(() => [window.innerWidth, window.innerHeight])
  useEffect(() => { const on = () => setV([window.innerWidth, window.innerHeight]); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on) }, [])
  return v
}
/** Whether the page is on the whole screen (./fullscreen.js). */
const useFullscreen = () => useSyncExternalStore(subscribeFullscreen, isFullscreen)
function useNow(every = 10e3) {
  const [d, setD] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setD(new Date()), every); return () => clearInterval(id) }, [every])
  return d
}
/** The pages as the sidebar has them (its entries: id, label, icon, group), in the groups' order; Settings last. */
function usePages(slots, lang, hosted, extra) {
  const [, bump] = useState(0)
  useEffect(() => slots.subscribe('sidebar.panellist', () => bump(n => n + 1)), [])
  useEffect(() => { const on = () => bump(n => n + 1); window.addEventListener('ruyix:nav', on); window.addEventListener('ruyix:layout-changed', on); return () => { window.removeEventListener('ruyix:nav', on); window.removeEventListener('ruyix:layout-changed', on) } }, [])
  const l = window.__ruyixLayout, own = window.__ruyixSafe ? {} : l?.nav || {}, hidden = new Set(own.hidden || []), order = own.order || []
  const nav = window.__ruyixNav || {}
  const away = e => { const x = nav[e.options?.id] || {}; return hosted().has(e.options?.id) || (l?.preset && Array.isArray(x.for) && !x.for.includes(l.preset)) || x.shown?.() === false || !!x.into || hidden.has(e.options?.id) }
  const placed = id => { const i = order.indexOf(id); return i < 0 ? Infinity : i }
  return slots.entries('sidebar.panellist').filter(e => e.options?.id && label(e) && !away(e))
    .map(e => ({ id: String(e.options.id), label: label(e), order: e.options.order ?? 0, group: groupOf(e.options.order ?? 0), Icon: e.component, props: injected(e), badge: nav[e.options.id]?.badge, count: nav[e.options.id]?.count || nav[e.options.id]?.badge }))
    .filter(p => p.group >= 0 || p.id === extra)
    .sort((a, b) => (a.group < 0) - (b.group < 0) || a.group - b.group || (placed(a.id) === placed(b.id) ? 0 : placed(a.id) - placed(b.id)) || a.order - b.order)
}
// what an entry's registration hands its component (its `inject`: services, words) — the slot system does it in the
// sidebar; the dock draws the same icon outside it. Asked once per entry.
const injectedOf = new WeakMap()
const injected = e => {
  if (typeof e.inject !== 'function') return {}
  if (!injectedOf.has(e)) { let v = {}; try { v = e.inject() || {} } catch { /* its services are not there now */ } injectedOf.set(e, v) }
  return injectedOf.get(e)
}
const api = (path, body) => fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok || d.error) throw new Error(d.params?.message || d.error || `HTTP ${r.status}`); return d })
let deskLang = 'en' // the desktop's language now (its notes are written in it)
/**
 * Change this Ruyix's desktop (desktop.json) — the person's own choice, at once — and have the page read it again. A
 * refusal shows as a notification (a choice never just does nothing) and resolves to null.
 */
export const setDesktop = (patch, widgetsBase) => api('api/ruyix/layout', { desktop: patch, ...(widgetsBase !== undefined && { widgetsBase }) }).then(
  d => { window.dispatchEvent(new CustomEvent('ruyix:layout')); return d },
  err => {
    const T = textOf(deskLang)
    window.dispatchEvent(new CustomEvent('ruyix:layout'))
    window.dispatchEvent(new CustomEvent('ruyix:notify', { detail: { title: T.notSaved, text: err.message } }))
    return null
  })

// ── pieces ──
function PageIcon({ page, size = 22 }) {
  const I = page.Icon
  return <Contained fallback={<AppWindow size={size} strokeWidth={1.6} />}>{I ? <I {...page.props} size={size} /> : <AppWindow size={size} strokeWidth={1.6} />}</Contained>
}

/** The quiet clock on the desk; it steps aside (fades) while the window `over` (interface px, or null) lies on it. */
function Clock({ lang, over, z }) {
  const d = useNow(), T = textOf(lang), ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const b = el.getBoundingClientRect(), k = z || 1 // (the screen's pixels → the interface's)
    const under = !!over && over.x < b.right / k + 12 && over.y < b.bottom / k && over.x + over.w > b.left / k
    el.toggleAttribute('data-under', under)
  })
  return (
    <div ref={ref} className="ad-clock" aria-hidden="true">
      <div className="ad-date">{T.date(d)}</div>
      <div className="ad-time">{`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}</div>
    </div>
  )
}

/** The window's frame: its title bar (lights, the page's name, the conversation) and edges to size it. */
function WindowChrome({ lang, page, desk, chatHere, onMove, onSize }) {
  const T = textOf(lang), s = useStore(desk)
  const grab = e => { if (e.button === 0 && !e.target.closest('button')) onMove(e) }
  return (
    <>
      <div className="ad-win" aria-hidden={!s.shown}>
        <div className="ad-titlebar" onPointerDown={grab} onDoubleClick={e => !e.target.closest('button') && desk.set(x => ({ max: !x.max }))}>
          <div className="ad-lights">
            <button type="button" className="ad-c" aria-label={T.close} title={T.close} onClick={() => desk.set({ shown: false, min: false })}><X strokeWidth={3} /></button>
            <button type="button" className="ad-m" aria-label={T.minimize} title={T.minimize} onClick={() => desk.set({ shown: false, min: true })}><Minus strokeWidth={3} /></button>
            <button type="button" className="ad-z" aria-label={s.max ? T.restore : T.maximize} title={s.max ? T.restore : T.maximize} onClick={() => desk.set(x => ({ max: !x.max }))}><Maximize2 strokeWidth={3} /></button>
          </div>
          <div className="ad-title">{page && <PageIcon page={page} size={15} />}<span>{page?.label || 'Ruyix'}</span></div>
          <div className="ad-tactions">
            {chatHere && <button type="button" className={cx('ad-tbtn', s.chat && 'ad-on')} title={T.chat} aria-label={T.chat} aria-pressed={s.chat} onClick={() => desk.set(x => ({ chat: !x.chat }))}><PanelRight size={15} strokeWidth={1.7} /></button>}
          </div>
        </div>
      </div>
      {['r', 'l', 'b', 'br', 'bl'].map(edge => <div key={edge} className="ad-edge" data-edge={edge} onPointerDown={e => e.button === 0 && onSize(e, edge)} />)}
    </>
  )
}

/** The appearance, from the top bar: light or dark, the theme, the wallpaper, the accent, motion, glass. */
function LookMenu({ lang, look, desktop, onClose, at, scale }) {
  const T = textOf(lang), pref = useSyncExternalStore(look.subscribe, look.getSnapshot)
  const ref = useRef(null)
  useEffect(() => { ref.current?.querySelectorAll('canvas[data-w]').forEach(c => paintThumb(c, c.dataset.w)) }, [])
  const set = patch => setDesktop(patch).catch(() => {})
  return (
    <div className="ad-menu" style={{ right: at }} ref={ref} role="dialog" aria-label={T.look}>
      <div className="ad-sec">{T.appearance}</div>
      {pref && <div className="ad-seg" role="radiogroup">{[['light', Sun], ['dark', Moon], ['system', Monitor]].map(([k, I]) => <button key={k} type="button" role="radio" aria-checked={pref === k} className={cx(pref === k && 'ad-on')} onClick={() => look.set(k)}><I size={13} />{T.themes[k]}</button>)}</div>}
      <div className="ad-sec">{T.theme}</div>
      <ThemeCards lang={lang} T={T} desktop={desktop} small onPick={id => chooseTheme(id, set, look)} />
      <div className="ad-sec">{T.wallpaper}</div>
      <div className="ad-walls">
        {WALLPAPER_GROUPS.map(g => [
          <div key={g} className="ad-wgroup">{T.wallGroups[g]}</div>,
          ...WALLPAPERS.filter(w => w.group === g).map(w => (
            <button key={w.id} type="button" className={cx('ad-wp', desktop.wallpaper === w.id && 'ad-on')} onClick={() => set({ wallpaper: w.id })} title={w.live ? T.live : ''}>
              {w.c.length ? <canvas data-w={w.id} style={{ background: `linear-gradient(160deg, ${w.c[1]}, ${w.c[0]})` }} /> : <span className="ad-wp-pv ad-wp-plain" />}{w[lang]}
            </button>
          )),
        ])}
      </div>
      <div className="ad-sec">{T.size}<small>{desktop.scale === 'auto' ? T.sizeNow(Math.round(scale * 100)) : ''}</small></div>
      <ScalePick T={T} value={desktop.scale} set={v => set({ scale: v })} />
      <div className="ad-sec">{T.density}</div>
      <div className="ad-seg" role="radiogroup" aria-label={T.density}>
        {Object.keys(DENSITIES).map(v => <button key={v} type="button" role="radio" aria-checked={desktop.density === v} className={cx(desktop.density === v && 'ad-on')} onClick={() => set({ density: v })}>{T.densities[v]}</button>)}
      </div>
      <div className="ad-sec">{T.accent}</div>
      <div className="ad-accents" role="radiogroup">{ACCENTS.map(a => <button key={a.id} type="button" role="radio" aria-checked={desktop.accent === a.id} aria-label={a[lang]} title={a[lang]} className={cx('ad-acc', desktop.accent === a.id && 'ad-on')} style={{ background: `light-dark(${a.light}, ${a.dark})` }} onClick={() => set({ accent: a.id })} />)}</div>
      <hr />
      <div className="ad-line"><span>{T.motion}</span><button type="button" className="ad-sw" role="switch" aria-checked={desktop.motion} aria-label={T.motion} onClick={() => set({ motion: !desktop.motion })} /></div>
      <div className="ad-line"><span>{T.glass}</span><button type="button" className="ad-sw" role="switch" aria-checked={desktop.glass} aria-label={T.glass} onClick={() => set({ glass: !desktop.glass })} /></div>
      {desktop.glass && <div className="ad-seg" role="radiogroup" aria-label={T.transparency}>
        {Object.keys(TRANSPARENCY).map(v => <button key={v} type="button" role="radio" aria-checked={(desktop.transparency || 'light') === v} className={cx((desktop.transparency || 'light') === v && 'ad-on')} onClick={() => set({ transparency: v })}>{T.transparencies[v]}</button>)}
      </div>}
      <hr />
      <button type="button" className="ad-mi" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: 'general' } })) }}><SlidersHorizontal size={14} />{T.moreLook}</button>
    </div>
  )
}

/** The interface's size: automatic (the screen's), or one of the sizes. */
export function ScalePick({ T, value, set }) {
  return (
    <div className="ad-seg ad-seg-size" role="radiogroup" aria-label={T.size}>
      {SCALES.map(v => <button key={v} type="button" role="radio" aria-checked={value === v} className={cx(value === v && 'ad-on')} onClick={() => set(v)}>{v === 'auto' ? T.sizeAuto : `${Math.round(v * 100)}%`}</button>)}
    </div>
  )
}

/** This Ruyix's menu, from the mark: who it is, its versions, Settings, the language, the classic sidebar. */
function MarkMenu({ lang, layout, locale, onClose, toDesk }) {
  const T = textOf(lang), id = layout?.identity, full = useFullscreen()
  const [v, setV] = useState(null)
  useEffect(() => { fetch('api/ruyix/version').then(r => r.json()).then(setV, () => {}) }, [])
  const who = id ? (id.name || layout.presets?.find(p => p.id === layout.preset)?.title?.[lang] || layout.preset) : 'Ruyix'
  const settings = tab => { onClose(); window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab } })) }
  return (
    <div className="ad-menu" style={{ left: 8 }} role="menu" aria-label="Ruyix">
      <div className="ad-who">{id && <i style={{ background: id.color }} />}<span><b>{who}</b><small>{[id?.sub, v && `Ruyix ${v.ruyix}${__RUYIX_COMMIT__ ? ` (${__RUYIX_COMMIT__})` : ''}`, v?.box && `nookbox ${v.box}`].filter(Boolean).join(' · ')}</small></span></div>
      <hr />
      <button type="button" role="menuitem" className="ad-mi" onClick={() => { onClose(); toDesk() }}><LayoutGrid size={14} />{T.showDesk}</button>
      {canFullscreen() && <button type="button" role="menuitem" className="ad-mi" onClick={() => { onClose(); toggleFullscreen() }}>{full ? <Minimize size={14} /> : <Maximize size={14} />}{full ? T.fullOff : T.fullOn}<small>⌃⌘F</small></button>}
      <button type="button" role="menuitem" className="ad-mi" onClick={() => settings('general')}><Settings size={14} />{T.settings}<small>⌘,</small></button>
      <button type="button" role="menuitem" className="ad-mi" onClick={() => { onClose(); window.dispatchEvent(new Event('ruyix:about')) }}><Info size={14} />{T.about}</button>
      <button type="button" role="menuitem" className="ad-mi" onClick={() => { onClose(); try { locale.setLocale(lang === 'zh' ? 'en' : 'zh') } catch { /* not loaded */ } }}><Globe size={14} />{T.otherLang}</button>
      <hr />
      <button type="button" role="menuitem" className="ad-mi" onClick={() => { onClose(); setDesktop({ mode: 'classic' }).catch(() => {}) }}><PanelRight size={14} />{T.toClassic}</button>
    </div>
  )
}

/** The dock: every page, in the sidebar's groups (a hairline between groups), the one in the window marked; its name above. */
function Dock({ pages, active, shown, open, lang, wins, z = 1, narrow = false }) {
  const [tip, setTip] = useState(null), [hop, setHop] = useState(null)
  const [, tick] = useState(0)
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 5000); const on = () => tick(n => n + 1); window.addEventListener('ruyix:nav', on); return () => { clearInterval(id); window.removeEventListener('ruyix:nav', on) } }, [])
  // (the screen's pixels → the interface's: it is scaled by z)
  const show = (e, p) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ id: p.id, text: p.label, x: (r.left + r.width / 2) / z, y: r.top / z - 12 }) }
  const items = []
  pages.forEach((p, i) => {
    if (i && p.group !== pages[i - 1].group) items.push(<span key={`s${i}`} className="ad-dock-sep" aria-hidden="true" />)
    let n = 0
    try { n = Number(p.badge?.()) || 0 } catch { n = 0 }
    items.push(
      <button key={p.id} type="button" className={cx('ad-tile', active === p.id && shown && 'ad-open', hop === p.id && 'ad-hop')} aria-label={p.label}
        aria-current={active === p.id && shown ? 'page' : undefined}
        onClick={() => { setHop(null); requestAnimationFrame(() => setHop(p.id)); open(p.id) }} onAnimationEnd={() => setHop(null)}
        onPointerEnter={e => show(e, p)} onPointerLeave={() => setTip(null)} onFocus={e => show(e, p)} onBlur={() => setTip(null)}>
        <PageIcon page={p} />
        {n > 0 && <span className="ad-badge">{n > 99 ? '99+' : n}</span>}
      </button>,
    )
  })
  // the windows plugins opened (a Linux app…): after the pages, each brings its window back
  const tiles = useWindowTiles(wins)
  if (tiles.list.length) items.push(<span key="s-wins" className="ad-dock-sep" aria-hidden="true" />)
  for (const w of tiles.list) {
    const I = w.icon || AppWindow
    items.push(
      <button key={`w:${w.id}`} type="button" className={cx('ad-tile', 'ad-open', hop === w.id && 'ad-hop')} aria-label={nameOf(w, lang)}
        onClick={() => { setHop(null); requestAnimationFrame(() => setHop(w.id)); wins.focus(w.id) }} onAnimationEnd={() => setHop(null)}
        onPointerEnter={e => show(e, { id: w.id, label: nameOf(w, lang) })} onPointerLeave={() => setTip(null)} onFocus={e => show(e, { id: w.id, label: nameOf(w, lang) })} onBlur={() => setTip(null)}>
        <Contained fallback={<AppWindow size={22} strokeWidth={1.6} />}><I size={22} /></Contained>
      </button>,
    )
  }
  return (
    <>
      <div className="ad-dockwrap"><nav className="ad-dock" aria-label={textOf(lang).dock}>{items}</nav></div>
      {tip && <div className="ad-tip" style={{ left: tip.x, top: tip.y, translate: '0 -100%' }}>{tip.text}</div>}
    </>
  )
}

/** The conversation's sheet: the workbench draws the conversation (the slot 'ruyix.chat'); the sheet is its frame. */
function Sheet({ lang, open, onClose, renderSlot, has }) {
  const T = textOf(lang)
  return (
    <aside className="ad-sheet ad-mat" data-open={String(open)} aria-hidden={!open} aria-label={T.chat}>
      <header className="ad-sheet-head"><MessageCircle size={15} strokeWidth={1.8} /><span>{T.chat}</span>
        <button type="button" className="ad-tbtn" aria-label={T.closeChat} title={T.closeChat} onClick={onClose}><X size={15} /></button></header>
      <div className="ad-sheet-body">{has ? renderSlot(CHAT_SLOT, { onClose, lang }) : <p className="ad-sheet-empty">{T.noChat}</p>}</div>
    </aside>
  )
}

/**
 * What plugins put in the top bar's tray, left of the bar's own buttons: window.__ruyixTray = [{ id, order?, render({ lang }) }]
 * (render draws its button — and its own menu under it), then a 'ruyix:tray' event as each comes or goes.
 */
function useTray() {
  const read = () => (Array.isArray(window.__ruyixTray) ? window.__ruyixTray : []).filter(x => x && typeof x.render === 'function' && x.id).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
  const [list, setList] = useState(read)
  useEffect(() => { const on = () => setList(read()); window.addEventListener('ruyix:tray', on); on(); return () => window.removeEventListener('ruyix:tray', on) }, [])
  return list
}

/** ⌘K: pages, settings, the look, the window — and anything else is a question for the agent. Plugins add their own
 * items through window.__ruyixPalette: [{ id, items(query, lang) → [{ group, label, sub?, run }] }]. */
function Palette({ lang, pages, open, onClose, look, desktop, desk, toDesk, chatHere, ask, classic, wins }) {
  const T = textOf(lang)
  const [q, setQ] = useState(() => desk.get().paletteText || ''), [sel, setSel] = useState(0), [more, setMore] = useState([])
  const input = useRef(null)
  // opened with words (voice input with nothing to type into): they are the query
  useEffect(() => { desk.set({ paletteText: '' }); setSel(0); setTimeout(() => input.current?.focus(), 10) }, [])
  const base = useMemo(() => {
    const settings = tab => () => window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab } }))
    return [
      ...pages.map(p => ({ group: T.pages, label: p.label, icon: <PageIcon page={p} size={14} />, run: () => open(p.id), keys: p.id })),
      ...(classic ? [] : [
        { group: T.windowG, label: T.showDesk, icon: <LayoutGrid />, run: toDesk, keys: 'desktop desk 桌面' },
        { group: T.windowG, label: T.widgets.edit, icon: <LayoutGrid />, run: () => { toDesk(); desk.set({ wedit: true }) }, keys: 'widgets edit add 小组件 编辑 添加' },
        { group: T.windowG, label: desk.get().max ? T.restore : T.maximize, icon: <Maximize2 />, run: () => desk.set(x => ({ max: !x.max, shown: true })), keys: 'zoom maximize 最大化 还原' },
      ]),
      ...(canFullscreen() ? [{ group: T.windowG, label: isFullscreen() ? T.fullOff : T.fullOn, sub: '⌃⌘F', icon: isFullscreen() ? <Minimize /> : <Maximize />, run: toggleFullscreen, keys: T.fullKeys }] : []),
      ...wins.get().list.map(w => ({ group: T.windowG, label: T.kv(T.switchTo, nameOf(w, lang)), icon: w.icon ? <w.icon /> : <AppWindow />, run: () => wins.focus(w.id), keys: `window 窗口 ${w.id}` })),
      { group: T.windowG, label: T.arrange, icon: <LayoutPanelLeft />, run: () => window.dispatchEvent(new CustomEvent('ruyix:arrange')), keys: 'arrange tile windows 排好 窗口 排列' },
      ...(chatHere ? [{ group: T.windowG, label: T.chatToggle, icon: <MessageCircle />, run: () => desk.set(x => ({ chat: !x.chat })), keys: 'chat conversation 对话 聊天' }] : []),
      ...[['light', Sun], ['dark', Moon], ['system', Monitor]].map(([k, I]) => ({ group: T.look, label: T.kv(T.appearance, T.themes[k]), icon: <I />, run: () => look.set(k), keys: `theme appearance 外观 主题 ${k}` })),
      ...THEMES.map(th => ({ group: T.look, label: T.kv(T.theme, th[lang]), icon: <Swatch />, run: () => chooseTheme(th.id, setDesktop, look), keys: `${T.themeKeys} ${th.id} ${th.en} ${th.zh}` })),
      ...WALLPAPERS.map(w => ({ group: T.look, label: T.kv(T.wallpaper, w[lang]), sub: [T.wallGroups[w.group], w.live ? T.live : ''].filter(Boolean).join(' · '), icon: <Sparkles />, run: () => setDesktop({ wallpaper: w.id }), keys: `wallpaper 壁纸 ${w.id} ${w.en} ${w.zh} ${T.wallGroups[w.group]}` })),
      ...ACCENTS.map(a => ({ group: T.look, label: T.kv(T.accent, a[lang]), icon: <span style={{ width: 10, height: 10, borderRadius: 5, background: `light-dark(${a.light}, ${a.dark})` }} />, run: () => setDesktop({ accent: a.id }), keys: `accent colour color 强调色 颜色 ${a.id} ${a.en}` })),
      { group: T.look, label: desktop.motion ? T.motionOff : T.motionOn, icon: <Sparkles />, run: () => setDesktop({ motion: !desktop.motion }), keys: 'motion animation 动态 动画' },
      classic ? { group: T.look, label: T.toDesktop, icon: <LayoutGrid />, run: () => setDesktop({ mode: 'desktop' }), keys: 'desktop 桌面' }
        : { group: T.look, label: T.toClassic, icon: <PanelRight />, run: () => setDesktop({ mode: 'classic' }), keys: 'classic sidebar 经典 侧栏' },
      ...['general', 'models', 'plugins', 'changes', 'advanced'].map(tab => ({ group: T.settingsG, label: T.kv(T.settings, T.tabs[tab]), icon: <Settings />, run: settings(tab), keys: `settings 设置 ${tab}` })),
    ]
  }, [pages, lang, desktop, chatHere, classic])
  useEffect(() => {
    let live = true
    const providers = Array.isArray(window.__ruyixPalette) ? window.__ruyixPalette : []
    Promise.all(providers.map(p => Promise.resolve().then(() => p.items(q, lang)).catch(() => []))).then(r => { if (live) setMore(r.flat().filter(x => x?.label && typeof x.run === 'function')) })
    return () => { live = false }
  }, [q, lang])
  const needle = q.trim().toLowerCase()
  const found = [...base, ...more].filter(x => !needle || `${x.label} ${x.sub || ''} ${x.keys || ''} ${x.group}`.toLowerCase().includes(needle))
  const shown = [...found.slice(0, 40), ...(needle && chatHere ? [{ group: T.askG, label: T.ask(q.trim()), icon: <MessageCircle />, run: () => ask(q.trim()) }] : [])]
  const k = Math.min(sel, Math.max(0, shown.length - 1))
  const pick = i => { const x = shown[i]; onClose(); x?.run() }
  const key = e => {
    if (e.key === 'ArrowDown' && shown.length) { setSel((k + 1) % shown.length); e.preventDefault() }
    else if (e.key === 'ArrowUp' && shown.length) { setSel((k - 1 + shown.length) % shown.length); e.preventDefault() }
    else if (e.key === 'Enter') { e.preventDefault(); pick(k) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
  let g = ''
  return (
    <div className="ad-scrim" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="ad-pal ad-mat" role="dialog" aria-label={T.palette}>
        <div className="ad-pal-in"><Search size={18} /><input ref={input} value={q} placeholder={chatHere ? T.palHint : T.palHintNoChat} onChange={e => { setQ(e.target.value); setSel(0) }} onKeyDown={key} aria-label={T.palette} /></div>
        <div className="ad-res" role="listbox">
          {shown.length ? shown.map((x, i) => (
            <div key={`${x.group}:${x.label}:${i}`}>
              {x.group !== g && <div className="ad-res-g">{(g = x.group)}</div>}
              <button type="button" role="option" aria-selected={i === k} className={cx('ad-it', i === k && 'ad-sel')} onClick={() => pick(i)} onPointerMove={() => i !== k && setSel(i)}>
                <span className="ad-it-g">{x.icon || <Command />}</span><span className="ad-it-t">{x.label}{x.sub ? <small> · {x.sub}</small> : null}</span>
              </button>
            </div>
          )) : <div className="ad-pal-none">{T.nothing}</div>}
        </div>
        <div className="ad-pal-foot"><span><kbd>↑↓</kbd>{T.k.move}</span><span><kbd>↵</kbd>{T.k.open}</span><span><kbd>esc</kbd>{T.k.close}</span></div>
      </div>
    </div>
  )
}

/** Voice input as it goes: listening (the level), transcribing, or what went wrong — under the top bar, centred. */
function VoicePill({ voice, lang }) {
  const v = useSyncExternalStore(voice.subscribe, voice.get), T = textOf(lang)
  if (v.phase === 'idle') return null
  return (
    <div className={cx('ad-voice ad-mat', `ad-voice-${v.phase}`)} role="status" aria-live="polite">
      {v.phase === 'listening' && <><i className="ad-rec" /><span className="ad-meter">{[0.5, 0.8, 1, 0.8, 0.5].map((k, i) => <b key={i} style={{ transform: `scaleY(${0.18 + Math.min(1, v.level * k * 1.6) * 0.82})` }} />)}</span><span>{T.listening}</span></>}
      {v.phase === 'working' && <><Loader2 size={14} className="ad-spin" /><span>{T.transcribing}</span></>}
      {v.phase === 'error' && <><TriangleAlert size={14} /><span>{v.message}</span></>}
    </div>
  )
}

/** Notifications: window event 'ruyix:notify' { title, text?, panel? } — a card at the top right for a few seconds. */
function Notes({ open }) {
  const [list, setList] = useState([])
  useEffect(() => {
    const on = e => {
      const n = { id: Math.random().toString(36).slice(2), ...e.detail }
      if (!n.title) return
      setList(l => [n, ...l].slice(0, 4))
      setTimeout(() => setList(l => l.filter(x => x.id !== n.id)), 6000)
    }
    window.addEventListener('ruyix:notify', on)
    return () => window.removeEventListener('ruyix:notify', on)
  }, [])
  return (
    <div className="ad-notes" aria-live="polite">
      {list.map(n => (
        <button key={n.id} type="button" className="ad-note ad-mat" onClick={() => { setList(l => l.filter(x => x.id !== n.id)); if (n.panel) open(n.panel) }}>
          <span className="ad-it-g"><Sparkles size={15} /></span><b>{n.title}</b>{n.text && <span>{n.text}</span>}
        </button>
      ))}
    </div>
  )
}

// ── the desktop ──
export function Desktop({ slots, locale, layout: layoutSvc, look, desk, hosted, renderSlot }) {
  const lang = useSyncExternalStore(f => locale.subscribe(f), () => (String(locale.getSnapshot().active || 'en').startsWith('zh') ? 'zh' : 'en'))
  const T = textOf(lang)
  const l = useLayoutRead()
  const desktop = l?.desktop || { mode: 'desktop', wallpaper: 'satin', motion: true, accent: 'teal', glass: true }
  // dsh's frame not where the desktop looks for it (a dsh that renamed it): the classic sidebar, not a desktop over it
  const [noFrame, setNoFrame] = useState(false)
  const classic = window.__ruyixSafe || desktop.mode === 'classic' || noFrame
  const s = useStore(desk)
  // the interface's size (desktop.json: auto follows the screen): the desk is measured in its pixels, the screen's / z
  const [sw, sh] = useViewport()
  const z = classic ? 1 : scaleOf(desktop.scale, sw, sh)
  const vw = Math.round(sw / z), vh = Math.round(sh / z)
  const active = useSyncExternalStore(f => layoutSvc.panelInfo.subscribe(f), () => layoutSvc.panelInfo.getSnapshot()?.activePanelId ?? null)
  const pages = usePages(slots, lang, hosted, 'ruyix-settings')
  const page = pages.find(p => p.id === active) || null
  // the inbox is not a window that stays (Ethan, 2026-10-18): the desk does not open on it at load — what waits on you is
  // on its dock icon, and the inbox opens when you open it
  const firstPage = useRef(true)
  useEffect(() => {
    if (classic || !page || !firstPage.current) return
    firstPage.current = false
    const inbox = Object.values(window.__ruyixWorkbenches || {})[0]?.inbox
    if (inbox && page.id === inbox) desk.set({ shown: false })
  }, [page?.id, classic])
  // the windows plugins open beside the page window (./windows.jsx; window.__ruyixDesk)
  const view = useRef([vw, vh])
  view.current = [vw, vh]
  const [wins] = useState(() => createWindows(() => view.current))
  const ws = useSyncExternalStore(wins.subscribe, wins.get)
  useDeskApi(wins, !classic)
  // the main agent closed one of the open things that is a window here (open_close)
  useEffect(() => { const on = e => { const id = String(e.detail?.win || ''); if (wins.has(id)) wins.close(id) }; window.addEventListener('ruyix:close-window', on); return () => window.removeEventListener('ruyix:close-window', on) }, [wins])
  const [, bumpChat] = useState(0)
  useEffect(() => slots.subscribe(CHAT_SLOT, () => bumpChat(n => n + 1)), [])
  const chatHere = slots.entries(CHAT_SLOT).length > 0
  const [chatState, setChatState] = useState(() => window.__ruyixChat || {})
  useEffect(() => { const on = () => setChatState({ ...(window.__ruyixChat || {}) }); window.addEventListener('ruyix:chat-state', on); return () => window.removeEventListener('ruyix:chat-state', on) }, [])

  // ── opening a page: the window shows it (from the dock, the palette, a tile, another page's 'ruyix:open') ──
  const openPage = id => {
    if (id === 'ruyix-settings') return window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: 'general' } }))
    try { layoutSvc.selectPanel(id) } catch { window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: id } })) }
    desk.set({ shown: true, min: false })
    wins.front('main')
  }
  const go = o => { if (o?.event) window.dispatchEvent(new CustomEvent(o.event, { detail: o.detail })); else if (o?.panel) openPage(o.panel); desk.set({ shown: true, min: false }) }
  const toDesk = () => { desk.set({ shown: false, min: false }); wins.minimizeAll() }
  const editWidgets = on => { if (on) toDesk(); desk.set({ wedit: !!on, menu: null }) }
  useEffect(() => {
    if (classic) return
    const ui = '.ad-world, .ad-bar, .ad-dockwrap, .ad-win, .ad-xwin, .ad-wdrawer, .ad-tree, .ad-w, .ad-widgets, .ad-gallery, .ad-menu, .ad-sheet, .ad-scrim, .ad-notes, [data-slot="root"] > [class*="_frame"], input, textarea, [contenteditable]'
    const on = e => {
      if (e.target.closest?.(ui)) return
      e.preventDefault()
      const z = Number(getComputedStyle(document.body).getPropertyValue('--ruyix-scale')) || 1
      desk.set({ menu: 'desk', menuAt: [Math.round(e.clientX / z), Math.round(e.clientY / z)] })
    }
    window.addEventListener('contextmenu', on)
    return () => window.removeEventListener('contextmenu', on)
  }, [classic])
  // ── the desk's open things (../open.js): the page the main window shows (one at a time, as it shows one: another page in
  // its place, or the window closed, closes it; minimised, it is folded), and what this desk no longer has ──
  const shownPage = s.shown && page ? page : null
  const pageNow = useRef(null)
  useEffect(() => {
    const reg = openRegistry(), id = shownPage ? `page:${shownPage.id}` : null
    if (pageNow.current && pageNow.current !== id) reg.close(pageNow.current)
    pageNow.current = id
    if (shownPage) reg.add({ id, kind: 'page', title: shownPage.label, hint: shownPage.id, reopen: { event: 'ruyix:open', detail: { panel: shownPage.id } } })
  }, [shownPage?.id, shownPage?.label])
  useEffect(() => { if (pageNow.current) openRegistry().fold(pageNow.current, !!s.min) }, [s.min])
  useEffect(() => {
    const reg = openRegistry()
    // (a page not in the main window: closed; a window only this page could bring back, gone with a reload: forgotten)
    const tidy = () => {
      for (const it of reg.list()) {
        if (it.kind === 'page' && it.id !== pageNow.current) reg.close(it.id)
        else if (it.reopen?.event === 'ruyix-desk:focus' && !wins.has(it.win)) reg.forget(it.id)
      }
    }
    const focus = e => { const id = String(e.detail?.win || ''); if (wins.has(id)) wins.focus(id) }
    tidy()
    window.addEventListener('ruyix:open-things', tidy)
    window.addEventListener('ruyix-desk:focus', focus)
    return () => { window.removeEventListener('ruyix:open-things', tidy); window.removeEventListener('ruyix-desk:focus', focus) }
  }, [wins])
  // a page chosen by anything else (a link, a plugin) brings the window back
  const was = useRef(active)
  // (not the page Ruyix lands on when it loads: a desk left showing stays showing)
  useEffect(() => { if (was.current !== null && was.current !== active && active !== null) { desk.set({ shown: true, min: false }); wins.front('main') } was.current = active }, [active])
  useEffect(() => { const on = () => { desk.set({ shown: true, min: false }); wins.front('main') }; window.addEventListener('ruyix:open', on); window.addEventListener('ruyix-settings:open', on); return () => { window.removeEventListener('ruyix:open', on); window.removeEventListener('ruyix-settings:open', on) } }, [])

  // ── the conversation: opened and asked from anywhere ──
  useEffect(() => {
    const toggle = e => desk.set(x => ({ chat: typeof e.detail?.open === 'boolean' ? e.detail.open : !x.chat }))
    window.addEventListener('ruyix:chat', toggle)
    return () => window.removeEventListener('ruyix:chat', toggle)
  }, [])
  // (the palette's question: on the desk its answer grows from the main agent's line, as voice's does; elsewhere the sheet opens)
  const ask = text => { if (classic || desktop.mode === 'world') desk.set({ chat: true }); setTimeout(() => window.dispatchEvent(new CustomEvent('ruyix:chat-ask', { detail: { text } })), 60) }

  // ── voice input (./voice.js): hold the right ⌥, or the microphone in the top bar ──
  deskLang = lang
  const langRef = useRef(lang)
  langRef.current = lang
  // (with nothing to type into, spoken words go to the main agent — the chat, not opened — after a bubble to call them off)
  const [voice] = useState(() => createVoiceInput({ lang: () => langRef.current, toPalette: text => desk.set({ palette: true, paletteText: text, menu: null }),
    toAgent: text => { window.dispatchEvent(new CustomEvent('ruyix:chat-ask', { detail: { text, via: 'voice' } })); return true },
    openChat: () => window.dispatchEvent(new CustomEvent('ruyix:chat', { detail: { open: true } })) }))
  useEffect(() => () => voice.dispose(), [])
  const vstate = useSyncExternalStore(voice.subscribe, voice.get)

  // ── the window's place: maximized fills the desk (beside the sheet), else its own rect kept inside the desk ──
  const narrow = vw < 880

  // ── the open things' groups (./groups.jsx): a card each at the desk's left; one laid out side by side beside them ──
  const CARDS_W = 212 // the column of cards (16 + its 196), kept clear of the windows laid out
  const tileArea = () => (World ? { x: CARDS_W + 14, y: 16, w: vw - CARDS_W - 26, h: vh - 16 - 64 } : { x: CARDS_W + 14, y: BAR + 10, w: vw - CARDS_W - 26, h: vh - BAR - DOCK - 18 })
  // the group in front: the one the front window (or the page the main window shows) is in
  const frontGroup = (() => {
    const t = wins.top(), id = t === 'main' ? (s.shown && !s.min && page ? `page:${page.id}` : null) : t
    if (!id) return null
    return openRegistry().groups().find(g => g.items.some(i => (t === 'main' ? i.id === id : i.win === id)))?.key || null
  })()
  const expandGroup = g => {
    const reg = openRegistry(), mine = g.items.filter(i => i.win && wins.has(i.win)).map(i => i.win), pageIt = g.items.find(i => i.kind === 'page')
    // the other groups step aside (their windows minimised; a pinned one stays as it is)
    for (const o of reg.groups()) {
      if (o.key === g.key || o.pinned) continue
      for (const i of o.items) if (i.win && wins.has(i.win) && !mine.includes(i.win)) wins.patch(i.win, { min: true })
      if (o.items.some(i => i.win)) reg.foldGroup(o.key, true)
    }
    if (!pageIt && s.shown) desk.set({ shown: false, min: true })
    if (pageIt) openPage(pageIt.hint || pageIt.reopen?.detail?.panel)
    // its windows (and the page window, when a page is in it) side by side; nothing to lay out: bring its latest back
    const ids = [...(pageIt ? ['main'] : []), ...mine], rects = tileRects(ids.length, tileArea())
    ids.forEach((id, k) => (id === 'main' ? desk.set({ shown: true, min: false, max: false, rect: rects[k], at: [vw, vh] }) : wins.place(id, rects[k])))
    ids.forEach(id => wins.front(id))
    if (!ids.length && g.items[0]) reg.open(g.items[0].id)
    else { reg.foldGroup(g.key, false); if (g.items[0]) reg.use(g.items[0].id) }
  }
  const collapseGroup = g => {
    for (const i of g.items) if (i.win && wins.has(i.win)) wins.patch(i.win, { min: true })
    if (page && g.items.some(i => i.id === `page:${page.id}`) && s.shown) desk.set({ shown: false, min: true })
    openRegistry().foldGroup(g.key, true)
  }
  // an agent placing the windows (page action 'ruyix:desk-window' { win | page, action: front | max | min | restore | close |
  // tile, wins? }): `win` a window ('main' the page window; an open thing's `win`), `page` a page shown in the page window
  // first; tile lays `wins` (else every window not minimised) side by side in the desk's room
  // ── windows laid out by themselves (docs/design/agent-control.md §7; Ethan: 「窗口打开的时候，希望能排好，不要互相覆盖。或者
  // 像抽屉一样」): with desktop.json windows 'auto' (the default), at each open, close, minimise or restore the windows in view
  // share the desk's room — one fills it, two side by side, three a big one on the left and two stacked, four a 2×2, the
  // newest first; beyond four the least used go into the drawer at the room's right edge (./windows.jsx WinDrawer), a click
  // there brings one back. A window the person moved or sized stays where they put it (free) until 「排好窗口」; a maximised
  // one covers the room as before. 'free': windows open where they open.
  const auto = !classic && !narrow && (desktop.windows || 'auto') === 'auto'
  const windowsUp = (s.shown && !s.min) || ws.list.some(w => !w.min) // (a window in front of the desk)
  const opened = useRef([]), MAX_LAID = 4 // (the order they came into view: the newest last)
  const inView = [...(s.shown && !s.min ? ['main'] : []), ...ws.list.filter(w => !w.min).map(w => w.id)]
  const tucked = [...((!s.shown || s.min) && s.drawer ? ['main'] : []), ...ws.list.filter(w => w.min && w.drawer).map(w => w.id)]
  const laid = inView.filter(id => { const w = id === 'main' ? s : ws.list.find(x => x.id === id); return !w?.max && !w?.free })
  const arrangeKey = auto ? `${laid.join(',')}|${tucked.join(',')}|${vw}x${vh}|${desktop.mode}` : ''
  const same = (a, b) => !!a && ['x', 'y', 'w', 'h'].every(k => Math.round(a[k]) === Math.round(b[k]))
  useEffect(() => {
    if (!auto) return
    // (back in view: out of the drawer)
    for (const w of ws.list) if (!w.min && w.drawer) wins.patch(w.id, { drawer: false })
    if (s.shown && !s.min && s.drawer) desk.set({ drawer: false })
    opened.current = [...opened.current.filter(id => laid.includes(id)), ...laid.filter(id => !opened.current.includes(id))]
    const keep = opened.current
    if (keep.length > MAX_LAID) {
      // the least used (lowest in the stacking order) into the drawer; the next run lays out the rest
      const order = wins.get().order || [], z = id => order.indexOf(id)
      for (const id of [...keep].sort((a, b) => z(a) - z(b)).slice(0, keep.length - MAX_LAID)) (id === 'main' ? desk.set({ shown: false, min: true, drawer: true }) : wins.patch(id, { min: true, drawer: true }))
      return
    }
    const area = tileArea(), room = tucked.length ? { ...area, w: area.w - DRAWER_W - 10 } : area
    const rects = arrangeRects(keep.length, room)
    ;[...keep].reverse().forEach((id, k) => {
      if (id === 'main') { if (!same(s.rect && follow(s.rect, s.at, vw, vh), rects[k])) desk.set({ rect: rects[k], at: [vw, vh] }) }
      else { const w = wins.get().list.find(x => x.id === id); if (w && !same(w.rect, rects[k])) wins.patch(id, { rect: rects[k] }) }
    })
  }, [arrangeKey])
  /** 「排好窗口」: every window back into the layout — the ones moved by hand and the maximised ones too. */
  const arrange = () => {
    for (const w of wins.get().list) if (w.free || w.max) wins.patch(w.id, { free: false, max: false })
    desk.set({ free: false, max: false, menu: null })
  }
  // (moved by hand in 'free', then 'auto' again: laid out with the others)
  useEffect(() => { if (auto) { for (const w of wins.get().list) if (w.free) wins.patch(w.id, { free: false }); if (s.free) desk.set({ free: false }) } }, [auto])
  // ('ruyix:arrange': the map's menu, the palette; with windows 'free' a one-time side by side, after which they are free again)
  useEffect(() => { const on = () => arrangeNow.current?.(); window.addEventListener('ruyix:arrange', on); return () => window.removeEventListener('ruyix:arrange', on) }, [])
  const arrangeNow = useRef(null)
  arrangeNow.current = () => (auto ? arrange() : deskWindow.current?.({ action: 'tile' }))
  const deskWindow = useRef(null)
  deskWindow.current = d => {
    const action = String(d?.action || 'front')
    if (classic) { if (d?.page) openPage(String(d.page)); return }
    if (action === 'tile' && !Array.isArray(d.wins) && auto) return arrange() // (laid out by themselves: all of them, again)
    if (action === 'tile') {
      const want = Array.isArray(d.wins) ? d.wins.map(String) : [...(s.shown && !s.min ? ['main'] : []), ...wins.get().list.filter(w => !w.min).map(w => w.id)]
      const ids = [...new Set(want)].filter(id => id === 'main' || wins.has(id)).slice(0, 8), rects = tileRects(ids.length, tileArea())
      ids.forEach((id, k) => (id === 'main' ? desk.set({ shown: true, min: false, max: false, rect: rects[k], at: [vw, vh] }) : wins.place(id, rects[k])))
      ids.forEach(id => wins.front(id))
      return
    }
    if (d?.page) openPage(String(d.page))
    const id = d?.page ? 'main' : String(d?.win || '')
    if (id === 'main') {
      if (action === 'close') desk.set({ shown: false, min: false })
      else if (action === 'min') desk.set({ shown: false, min: true })
      else { desk.set({ shown: true, min: false, ...(action === 'max' && { max: true }), ...(action === 'restore' && { max: false }) }); wins.front('main') }
    } else if (wins.has(id)) {
      if (action === 'close') wins.close(id)
      else if (action === 'min') wins.patch(id, { min: true })
      else { wins.patch(id, { min: false, ...(action === 'max' && { max: true }), ...(action === 'restore' && { max: false }) }); wins.focus(id) }
    }
  }
  useEffect(() => {
    const on = e => deskWindow.current?.(e.detail)
    window.addEventListener('ruyix:desk-window', on)
    return () => window.removeEventListener('ruyix:desk-window', on)
  }, [])
  // groups not used for a while put themselves away: their windows only (never the page window), never a pinned one,
  // never the one in front
  const AWAY_MS = 45 * 60000
  useEffect(() => {
    if (classic) return
    const tick = setInterval(() => {
      const now = Date.now(), t = wins.top()
      for (const g of openRegistry().groups()) {
        if (g.pinned || g.folded || now - g.usedAt < AWAY_MS) continue
        const ws2 = g.items.filter(i => i.win && wins.has(i.win))
        if (!ws2.length || ws2.some(i => i.win === t)) continue
        ws2.forEach(i => wins.patch(i.win, { min: true }))
        openRegistry().foldGroup(g.key, true)
      }
    }, 60000)
    return () => clearInterval(tick)
  }, [classic])
  const cards = top => !narrow && <GroupCards lang={lang} top={top} max={Math.max(1, Math.floor(((World ? vh * 0.56 : vh - DOCK) - top - 10) / 62))} front={frontGroup} expand={expandGroup} collapse={collapseGroup} />
  // a window filling the desk (maximised, or the page window maximised): the strip is under it, so it folds to a light
  const filled = (s.shown && !s.min && !!s.max) || ws.list.some(w => w.max && !w.min)
  const own = s.rect ? follow(s.rect, s.at, vw, vh) : firstRect(vw, vh) // where it is when not maximized
  // (the conversation's sheet at the right takes room from the windows on a map; on the desk it opens over it, from the
  // main agent's line above the dock: ./agentbar.jsx)
  const sheetW = s.chat && chatHere && desktop.mode === 'world' ? Math.min(SHEET, vw - 16) + GAP : 0
  const rect = narrow ? { x: 0, y: BAR, w: vw, h: vh - BAR - DOCK + 6 }
    : s.max ? { x: 8, y: BAR + 8, w: vw - 16 - sheetW, h: vh - BAR - 8 - DOCK }
      : fit(own, vw, vh)

  // ── the page under it: attributes and variables (the stylesheet does the rest); classic: none of it ──
  useEffect(() => {
    const root = document.documentElement
    if (classic) {
      for (const a of ['data-ruyix-desk', 'data-ruyix-win', 'data-ruyix-max', 'data-ruyix-glass', 'data-ruyix-see', 'data-ruyix-narrow']) root.removeAttribute(a)
      document.body.style.removeProperty('--ruyix-scale')
      return
    }
    root.setAttribute('data-ruyix-desk', '')
    // the interface's size (the desktop and the page window's contents are zoomed by it) and the desk in its pixels
    document.body.style.setProperty('--ruyix-scale', String(z))
    root.style.setProperty('--ad-vw', `${vw}px`)
    root.style.setProperty('--ad-vh', `${vh}px`)
    root.toggleAttribute('data-ruyix-narrow', narrow)
    root.setAttribute('data-ruyix-win', s.shown ? 'shown' : s.min ? 'min' : 'hidden')
    root.toggleAttribute('data-ruyix-max', !!s.max && !narrow)
    root.setAttribute('data-ruyix-glass', desktop.glass ? '1' : '0')
    // windows one sees the desk through (desktop.json transparency; never with glass off)
    if (desktop.glass && (desktop.transparency || 'light') !== 'off') root.setAttribute('data-ruyix-see', desktop.transparency || 'light'); else root.removeAttribute('data-ruyix-see')
    for (const [k, v] of Object.entries({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })) root.style.setProperty(`--aw-${k}`, `${v}px`)
    root.style.setProperty('--ad-sheet-w', `${sheetW}px`)
  }, [classic, s.shown, s.min, s.max, narrow, desktop.glass, desktop.transparency, rect.x, rect.y, rect.w, rect.h, sheetW, z, vw, vh])
  // the page window in the stacking order: its z, and a click in it brings it to the front
  const mainZ = wins.z('main'), mainFront = wins.top() === 'main'
  useEffect(() => { document.documentElement.style.setProperty('--aw-z', String(mainZ)); document.documentElement.toggleAttribute('data-ruyix-main-back', !mainFront && ws.list.length > 0) }, [mainZ, mainFront, ws])
  useEffect(() => {
    const on = e => { if (e.target.closest?.('[data-slot="root"] > [class*="_frame"], .ad-win, .ad-edge')) wins.front('main') }
    window.addEventListener('pointerdown', on, true)
    return () => window.removeEventListener('pointerdown', on, true)
  }, [])
  useEffect(() => () => {
    const root = document.documentElement
    for (const a of ['data-ruyix-desk', 'data-ruyix-win', 'data-ruyix-max', 'data-ruyix-glass', 'data-ruyix-see', 'data-ruyix-moving', 'data-ruyix-main-back', 'data-ruyix-narrow']) root.removeAttribute(a)
    document.body.style.removeProperty('--ruyix-scale')
  }, [])
  // dsh's grid without its sidebar: its columns as dsh sets them (the conversation's right bar keeps its width), the first 0
  useEffect(() => {
    const look = () => document.querySelector('[data-slot="root"] > [class*="_frame"]')
    if (noFrame) { // looked for again now and then: a live reload may bring it back
      const id = setInterval(() => { if (look()) setNoFrame(false) }, 5000)
      return () => clearInterval(id)
    }
    if (classic) return
    const missing = setTimeout(() => { if (!look()) setNoFrame(true) }, 6000)
    let frame = null, seen = ''
    const cols = new MutationObserver(() => sync())
    const sync = () => {
      const f = document.querySelector('[data-slot="root"] > [class*="_frame"]')
      if (f !== frame) { cols.disconnect(); frame = f; if (f) cols.observe(f, { attributes: true, attributeFilter: ['style'] }) }
      const next = (frame?.style.gridTemplateColumns || '').replace(/^\s*[\d.]+px/, '0px')
      if (next && next !== seen) { seen = next; document.documentElement.style.setProperty('--ruyix-cols', next) }
    }
    const body = new MutationObserver(() => { if (!frame?.isConnected) sync() })
    body.observe(document.getElementById('root') || document.body, { childList: true, subtree: true })
    sync()
    return () => { clearTimeout(missing); cols.disconnect(); body.disconnect(); document.documentElement.style.removeProperty('--ruyix-cols') }
  }, [classic, noFrame])

  // ── moving and sizing: the variables follow the pointer; the rect is kept when it lets go ──
  const drag = (e, how) => {
    e.preventDefault()
    const sx = e.clientX / z, sy = e.clientY / z // (the interface's pixels)
    let r = { ...rect }
    if (s.max && how === 'move') { // a maximized window comes off under the pointer at its own size
      const back = fit(own, vw, vh)
      r = { ...back, x: Math.round(sx - back.w * ((sx - rect.x) / rect.w)), y: rect.y }
      desk.set({ max: false })
    }
    const start = { ...r }, root = document.documentElement
    root.setAttribute('data-ruyix-moving', '')
    const put = x => { for (const k of ['x', 'y', 'w', 'h']) root.style.setProperty(`--aw-${k}`, `${x[k]}px`) }
    const move = ev => {
      const dx = ev.clientX / z - sx, dy = ev.clientY / z - sy, n = { ...start }
      if (how === 'move') { n.x = start.x + dx; n.y = start.y + dy }
      if (how.includes('r')) n.w = start.w + dx
      if (how.includes('l')) { n.w = start.w - dx; n.x = start.x + dx }
      if (how.includes('b')) n.h = start.h + dy
      r = fit(n, vw, vh)
      if (how.includes('l')) r.x = start.x + start.w - r.w // the right edge stays where it was
      put(r)
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      root.removeAttribute('data-ruyix-moving')
      desk.set({ rect: r, at: [vw, vh], max: false, free: true }) // (moved by hand: it stays where it was put)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
  }

  // ── the wallpaper ──
  const canvas = useRef(null), wall = useRef(null), skyFeed = useRef(null)
  // the interactive desk (desktop.json mode `world`): a map a plugin draws, every page a place on it — no bar, dock,
  // widgets or wallpaper of the desk's own; the windows, ⌘K, the conversation and voice as ever (no such plugin: the desk)
  const worlds = useWorlds()
  const World = !classic && desktop.mode === 'world' ? worlds.find(w => w.id === desktop.world) || worlds[0] || null : null
  // the pages wear the map's look while it is the desk (its theme's tokens on <body>, after the desk's own)
  const worldTheme = World ? themeCssOf(World.theme) : ''
  useEffect(() => {
    if (!worldTheme) return
    const style = Object.assign(document.createElement('style'), { textContent: worldTheme })
    style.dataset.ruyix = 'world-theme'
    document.head.appendChild(style)
    return () => style.remove()
  }, [worldTheme])
  // the agents' desk: a wallpaper that draws the agents at work itself (sky.jsx) — then they are not lights over it
  const agentsDesk = !classic && DATA_SCENES.has(desktop.wallpaper)
  useEffect(() => {
    if (classic || World || !canvas.current) return
    wall.current = createWallpaper(canvas.current)
    // a data wallpaper (the agents' sky) draws what its layer gives each frame
    wall.current.set({ data: (t, W, H) => skyFeed.current?.(t, W, H) ?? null })
    return () => { wall.current?.destroy(); wall.current = null }
  }, [classic, !!World])
  const covered = s.shown && (s.max || narrow)
  useEffect(() => { wall.current?.set({ wallpaper: desktop.wallpaper, motion: desktop.motion, covered }) }, [classic, !!World, desktop.wallpaper, desktop.motion, covered])
  // the agents' liveliness on the wallpaper (the intelligence scenes answer it): listening — more as the person speaks;
  // working on what they said; and the agents at work on tasks (window.__ruyixActivity), a little more for each
  const [atWork, setAtWork] = useState(0)
  useEffect(() => { const on = () => setAtWork((window.__ruyixActivity?.agents || []).filter(a => a.state === 'working').length); window.addEventListener('ruyix:activity', on); on(); return () => window.removeEventListener('ruyix:activity', on) }, [])
  useEffect(() => {
    const voice = vstate.phase === 'listening' ? 0.3 + 0.7 * Math.min(1, vstate.level * 1.8) : vstate.phase === 'working' ? 0.5 : 0
    wall.current?.set({ energy: Math.max(voice, atWork ? Math.min(0.7, 0.22 + 0.12 * atWork) : 0) })
  }, [vstate.phase, vstate.level, atWork])

  // ── keys: ⌘K the palette; Esc closes what is open ──
  useEffect(() => {
    const on = e => {
      const own = e.target?.closest?.('[data-ruyix-keys="app"]') // an app's keyboard (a Linux app): ⌃ shortcuts are the app's
      if ((e.metaKey || (e.ctrlKey && !own)) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); desk.set(x => ({ palette: !x.palette, menu: null })) }
      else if ((e.metaKey || (e.ctrlKey && !own)) && !e.altKey && !e.shiftKey && e.key === ',') { e.preventDefault(); window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: 'general' } })) }
      // ⌃⌘F: full screen, as on a Mac (in an app's window too: no app takes ⌃⌘)
      else if (e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyF') { e.preventDefault(); e.stopPropagation(); toggleFullscreen() }
      else if (e.key === 'Escape' && desk.get().menu) desk.set({ menu: null })
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [])
  // a click outside a menu closes it
  useEffect(() => {
    if (!s.menu) return
    const on = e => { if (!e.target.closest?.('.ad-menu, [data-menu]')) desk.set({ menu: null }) }
    window.addEventListener('pointerdown', on, true)
    return () => window.removeEventListener('pointerdown', on, true)
  }, [s.menu])

  const tone = WALLPAPERS.find(w => w.id === desktop.wallpaper)?.tone || 'dark'
  const tray = useTray()
  const topWin = wins.top(), frontTitle = topWin && topWin !== 'main' ? nameOf(ws.list.find(w => w.id === topWin), lang) : s.shown && page ? page.label : T.desk
  const now = useNow(15e3), full = useFullscreen()
  const menuBtn = (id, content, extra = {}) => (
    <button type="button" className="ad-bar-btn" data-menu={id} aria-expanded={s.menu === id} onClick={() => desk.set(x => ({ menu: x.menu === id ? null : id }))} {...extra}>{content}</button>
  )
  const chatBtn = chatHere && (
    <button type="button" className={cx('ad-bar-btn ad-chatbtn')} aria-pressed={s.chat} title={`${T.chat} (⌘K → ${T.askShort})`} aria-label={T.chat} onClick={() => desk.set(x => ({ chat: !x.chat }))}>
      <MessageCircle size={15} strokeWidth={1.7} />{chatState.busy && <i className="ad-busy" />}
    </button>
  )

  if (classic) {
    return createPortal(
      <div className="ad-root" data-mode="classic">
        {chatHere && !s.chat && <button type="button" className="ad-fab" aria-label={T.chat} title={T.chat} onClick={() => desk.set({ chat: true })}><MessageCircle size={19} /></button>}
        {chatHere && <Sheet lang={lang} open={s.chat} onClose={() => desk.set({ chat: false })} renderSlot={renderSlot} has={chatHere} />}
        {s.palette && <Palette lang={lang} pages={pages} open={openPage} onClose={() => desk.set({ palette: false })} look={look} desktop={desktop} desk={desk} toDesk={toDesk} chatHere={chatHere} ask={ask} classic wins={wins} />}
        <VoicePill voice={voice} lang={lang} />
        <Notes open={openPage} />
      </div>,
      document.body,
    )
  }
  if (World) {
    // what the map is given: the pages and the ways to everything the bar and the dock otherwise hold
    const R = World.render
    const api = {
      lang, pages, active, shown: s.shown, covered, motion: desktop.motion !== false, chat: chatState, voice: vstate,
      open: openPage,
      talk: () => desk.set({ chat: true }),
      palette: () => desk.set({ palette: true, menu: null }),
      settings: (tab = 'general') => window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab } })),
      workbench: detail => window.dispatchEvent(new CustomEvent('ruyix-workbench:open', { detail })),
      toDesk,
      leave: () => setDesktop({ mode: 'desktop' }),
      worlds: worlds.map(w => ({ id: w.id, name: w.name })), world: World.id, pick: id => setDesktop({ world: id }),
      // what the top bar otherwise holds: voice input (with nothing to type into, the words go to the main agent; the
      // right ⌥ held works too) and the whole screen (⌃⌘F too)
      listen: () => voice.toggle(),
      fullscreen: canFullscreen() ? { on: full, toggle: toggleFullscreen } : null,
      createWallpaper, // the engine the map's ground is drawn with: the shell's own, so a map's plugin need not carry one
    }
    return createPortal(
      <div className="ad-root" data-mode="desktop" data-world={World.id} data-tone={World.tone || 'dark'}>
        <Contained fallback={<p className="ad-world-fail">{T.worldFailed}</p>}><R api={api} /></Contained>
        {cards(250)}
        {!narrow && (filled ? <div className="ad-strip-mapdot"><StripDot lang={lang} /></div> : <div className="ad-strip-map"><WorkStrip lang={lang} variant="map" lanes={2} notes={2} /></div>)}
        <WindowChrome lang={lang} page={page} desk={desk} chatHere={chatHere} onMove={e => drag(e, 'move')} onSize={(e, edge) => drag(e, edge)} />
        <Windows wins={wins} lang={lang} T={T} vw={vw} vh={vh} z={z} />
        {chatHere && <Sheet lang={lang} open={s.chat} onClose={() => desk.set({ chat: false })} renderSlot={renderSlot} has={chatHere} />}
        {s.palette && <Palette lang={lang} pages={pages} open={openPage} onClose={() => desk.set({ palette: false })} look={look} desktop={desktop} desk={desk} toDesk={toDesk} chatHere={chatHere} ask={ask} wins={wins} />}
        <VoicePill voice={voice} lang={lang} />
        <Notes open={openPage} />
      </div>,
      document.body,
    )
  }
  return createPortal(
    <div className="ad-root" data-mode="desktop" data-tone={tone}>
      {desktop.wallpaper === 'plain' && <div className="ad-plain" aria-hidden="true" />}
      <canvas ref={canvas} className="ad-wall" aria-hidden="true" />
      <div className="ad-grain" aria-hidden="true" />
      <Clock lang={lang} z={z} over={s.shown && !s.min ? rect : null} />
      {agentsDesk
        ? <AgentSky feed={skyFeed} redraw={() => wall.current?.redraw()} look={desktop.wallpaper} lang={lang} open={detail => window.dispatchEvent(new CustomEvent('ruyix-workbench:open', { detail }))} />
        : <AgentLights look={desktop.agents || 'icon'} motion={desktop.motion} tone={tone} lang={lang} open={(run, tab) => window.dispatchEvent(new CustomEvent('ruyix-workbench:open', { detail: { run, tab } }))} />}
      {cards(BAR + 214)}
      {!narrow && <Widgets top={<WorkStrip lang={lang} />} lang={lang} desktop={desktop} visible={!covered} edit={!!s.wedit} setEdit={editWidgets} save={list => setDesktop({ widgets: list }, desktop.widgets).catch(() => {})} offer={(list, offered) => setDesktop({ widgets: list, widgetsOffered: offered }, desktop.widgets).catch(() => {})} go={go} openPage={openPage} ask={ask} z={z} vw={vw} vh={vh} />}
      {s.menu === 'desk' && s.menuAt && (
        <div className="ad-menu ad-deskmenu" role="menu" aria-label={T.widgets.deskMenu} style={{ left: s.menuAt[0], top: s.menuAt[1] }}>
          <button type="button" role="menuitem" className="ad-mi" onClick={() => editWidgets(true)}><LayoutGrid size={14} />{T.widgets.edit}</button>
          <button type="button" role="menuitem" className="ad-mi" onClick={() => desk.set({ menu: 'look' })}><Sparkles size={14} />{T.widgets.wallpaperMenu}</button>
          <button type="button" role="menuitem" className="ad-mi" onClick={() => { desk.set({ menu: null }); arrangeNow.current?.() }}><LayoutPanelLeft size={14} />{T.arrange}</button>
          <hr />
          <button type="button" role="menuitem" className="ad-mi" onClick={() => { desk.set({ menu: null }); window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: 'general' } })) }}><Settings size={14} />{T.settings}<small>⌘,</small></button>
        </div>
      )}
      <WindowChrome lang={lang} page={page} desk={desk} chatHere={chatHere} onMove={e => drag(e, 'move')} onSize={(e, edge) => drag(e, edge)} />
      <Windows wins={wins} lang={lang} T={T} vw={vw} vh={vh} z={z} />
      {auto && tucked.length > 0 && <WinDrawer ids={tucked} wins={wins} page={page} mainIcon={page && <PageIcon page={page} size={18} />} lang={lang} T={T} at={tileArea()} back={() => { desk.set({ shown: true, min: false, drawer: false }); wins.front('main') }} />}
      <header className="ad-bar">
        {menuBtn('mark', <img src={markSrc} alt="" />, { className: 'ad-bar-btn ad-bar-mark', 'aria-label': 'Ruyix' })}
        <button type="button" className="ad-bar-btn ad-bar-app" onClick={() => (s.shown ? null : desk.set({ shown: true }))}>{frontTitle}</button>
        <span className="ad-bar-grow" />
        <div className="ad-bar-tray">
          {/* what plugins put in the tray (window.__ruyixTray): a plugin's indicator, its own menu */}
          {tray.map(x => { const R = x.render; return <Contained key={x.id} fallback={null}><R lang={lang} /></Contained> })}
          {/* the widgets column covered (a window fills the desk) or not there (a narrow screen): the strip folded to a light here */}
          {(narrow || filled) && <StripDot lang={lang} />}
          {chatState.busy && <button type="button" className="ad-bar-ind" title={T.working} onClick={() => desk.set({ chat: true })}><span className="ad-ring" /></button>}
          <button type="button" className={cx('ad-bar-btn', vstate.phase === 'listening' && 'ad-mic-on')} title={T.voiceHint(hotkeyLabel(voice.hotkey(), { lang, mac: isMac, bare: true }), voice.hotkey().mode === 'toggle')} aria-label={T.voice} aria-pressed={vstate.phase === 'listening'}
            onPointerDown={e => e.preventDefault() /* the text box keeps the focus: the words go there */} onClick={() => voice.toggle()}><Mic size={15} strokeWidth={1.7} /></button>
          <button type="button" className="ad-bar-btn" title={`${T.search} ⌘K`} aria-label={T.search} onClick={() => desk.set({ palette: true, menu: null })}><Search size={15} strokeWidth={1.7} /></button>
          {chatBtn}
          {menuBtn('look', <SlidersHorizontal size={15} strokeWidth={1.7} />, { title: T.look, 'aria-label': T.look })}
          {canFullscreen() && <button type="button" className="ad-bar-btn" title={`${full ? T.fullOff : T.fullOn} ⌃⌘F`} aria-label={full ? T.fullOff : T.fullOn} aria-pressed={full} onClick={() => toggleFullscreen()}>{full ? <Minimize size={15} strokeWidth={1.7} /> : <Maximize size={15} strokeWidth={1.7} />}</button>}
          <span className="ad-clocklet" title={now.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}>{T.barTime(now)}</span>
        </div>
      </header>
      {s.menu === 'mark' && <MarkMenu lang={lang} layout={l} locale={locale} onClose={() => desk.set({ menu: null })} toDesk={toDesk} />}
      {s.menu === 'look' && <LookMenu lang={lang} look={look} desktop={desktop} scale={z} onClose={() => desk.set({ menu: null })} at={8} />}
      <Dock pages={pages} active={active} shown={s.shown} open={openPage} lang={lang} wins={wins} z={z} narrow={narrow} />
      {/* (a window in front of the desk — the page window or another — folds the bar's waiting card and the tree: neither
          covers a window's buttons) */}
      {chatHere && <AgentBar lang={lang} chat={chatState} voice={voice} open={!!s.chat} setOpen={o => desk.set({ chat: o })} renderSlot={renderSlot} has={chatHere} covered={windowsUp} />}
      {chatHere && <AnswerTree lang={lang} hidden={!!s.chat} covered={windowsUp} voice={voice} z={z} vw={vw} vh={vh} />}
      {s.palette && <Palette lang={lang} pages={pages} open={openPage} onClose={() => desk.set({ palette: false })} look={look} desktop={desktop} desk={desk} toDesk={toDesk} chatHere={chatHere} ask={ask} wins={wins} />}
      <VoicePill voice={voice} lang={lang} />
      <Notes open={openPage} />
    </div>,
    document.body,
  )
}

