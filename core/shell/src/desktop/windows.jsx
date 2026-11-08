// The desktop's other windows: what a plugin opens beside the page window (dsh shows one page at a time; a Linux app, a
// document, a tool can each have a window of its own). window.__ruyixDesk is the way in:
//   open({ id, title, names?, icon, Content, props, size, onClose }) — one window per id (an open one comes to the front;
//   names: { zh, en }, its title in both languages — the page can change language while it is open)
//   close(id), focus(id), has(id)
// The page window and these share one stacking order ('main' is the page window): a click brings a window to the
// front. Each remembers where it was (by id, in this browser). Every window is one of the desk's open things (../open.js):
// closed, minimised, brought up with it. One opened with `reopen` ({ event, detail }: how to bring it back; and `kind`,
// `of`, `hint`) can come back after a reload; one without only while it is here ('ruyix-desk:focus': the desk drops it
// once it is gone).
import { Component, useEffect, useState, useSyncExternalStore } from 'react'
import { AppWindow, Maximize2, Minus, X } from 'lucide-react'
import { BAR, DOCK, fit } from './store.js'
import { openRegistry } from '../open.js'
import { nameOf } from '../../open-model.js'
import { WorkMark, useWork } from './workmark.jsx'

const KEY = 'ruyix.wins'
const Z0 = 4, Z_MAX = 28 // under the sheet (30) and the bars (40)
const cx = (...c) => c.filter(Boolean).join(' ')
const rects = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {} } catch { return {} } }
const keepRect = (id, r) => { try { localStorage.setItem(KEY, JSON.stringify({ ...rects(), [id]: r })) } catch { /* private window */ } }

class Contained extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() { return this.state.error ? <p className="ad-xwin-fail">{String(this.state.error?.message || this.state.error)}</p> : this.props.children }
}

/** The windows: { list: [{ id, title, icon, Content, props, rect, max, min, onClose }], order: ['main', …ids] (back to front) }.
 * `view()`: the desk's size in the interface's pixels, [w, h]. */
export function createWindows(view = () => [window.innerWidth, window.innerHeight]) {
  let s = { list: [], order: ['main'] }
  const subs = new Set()
  const set = next => { s = next; subs.forEach(f => f()) }
  const front = id => set({ ...s, order: [...s.order.filter(x => x !== id), id] })
  const patch = (id, p) => {
    const w = s.list.find(x => x.id === id)
    if (w?.openId && 'min' in p && p.min !== w.min) openRegistry().fold(w.openId, !!p.min) // (an open thing: folded with it)
    set({ ...s, list: s.list.map(x => (x.id === id ? { ...x, ...p } : x)) })
  }
  /** One of the desk's open things (../open.js): every window; brought back by its opener's way, else only while here. */
  const thing = (o, id) => {
    const openId = String(o.openId || `win:${id}`)
    const reopen = o.reopen?.event ? o.reopen : { event: 'ruyix-desk:focus', detail: { win: id } }
    try { openRegistry().add({ id: openId, kind: o.kind || 'window', title: String(o.title || id), ...(o.names && { names: o.names }), win: id, reopen, hint: o.hint || id, ...(o.of && { of: o.of }) }) } catch { /* not one */ }
    return openId
  }
  const api = {
    get: () => s, subscribe: f => { subs.add(f); return () => subs.delete(f) },
    open(o) {
      if (!o?.id || typeof o.Content !== 'function') throw new Error('a window needs an id and a Content component')
      const id = String(o.id)
      if (s.list.some(w => w.id === id)) { patch(id, { min: false, ...(o.props && { props: o.props }) }); const was = s.list.find(w => w.id === id); if (was.openId) openRegistry().use(was.openId); return front(id) }
      const [vw, vh] = view(), n = s.list.length
      // the size asked for, at most what a desk this size shows well (most of it, the dock and bar left clear)
      const want = o.size || { w: 1000, h: 680 }
      const size = { w: Math.min(want.w, Math.round(vw * 0.8)), h: Math.min(want.h, Math.round((vh - BAR - DOCK) * 0.88)) }
      const rect = fit(rects()[id] || { x: Math.round((vw - size.w) / 2) + n * 28, y: BAR + 40 + n * 28, w: size.w, h: size.h }, vw, vh)
      set({ list: [...s.list, { id, title: String(o.title || id), ...(o.names && { names: o.names }), icon: o.icon || null, Content: o.Content, props: o.props || {}, rect, max: false, min: false, onClose: o.onClose, openId: thing(o, id), lingers: !!o.lingers }], order: [...s.order, id] })
    },
    close(id) {
      const w = s.list.find(x => x.id === id)
      if (!w) return
      set({ list: s.list.filter(x => x.id !== id), order: s.order.filter(x => x !== id) })
      // (one that lingers — a terminal's session, the agents' browser — keeps running: its item stays, folded, in the background)
      if (w.openId && w.lingers) { const reg = openRegistry(), it = reg.list().find(x => x.id === w.openId); if (it) { const { folded, usedAt, openedAt, ...keep } = it; reg.add({ ...keep, bg: true }); reg.fold(w.openId, true) } } else if (w.openId) openRegistry().close(w.openId)
      try { w.onClose?.() } catch { /* the plugin's to answer */ }
    },
    focus(id) { if (id === 'main' || s.list.some(w => w.id === id)) { if (id !== 'main') { patch(id, { min: false }); const w = s.list.find(x => x.id === id); if (w?.openId) openRegistry().use(w.openId) } front(id) } },
    has: id => s.list.some(w => w.id === id),
    patch, front,
    minimizeAll() { set({ ...s, list: s.list.map(w => ({ ...w, min: true })) }) },
    /** Put a window there (a group laid out side by side): shown, not maximised, and remembered there. */
    place(id, rect) { if (!s.list.some(w => w.id === id)) return; patch(id, { rect, max: false, min: false }); keepRect(id, rect) },
    /** The z-index of a window (its frame; its body one above). */
    z: id => Math.min(Z_MAX, Z0 + 2 * Math.max(0, s.order.indexOf(id))),
    /** The window in front that is showing (null: none of these; 'main' is the caller's to judge). */
    top: () => [...s.order].reverse().find(id => id === 'main' || s.list.some(w => w.id === id && !w.min)) || null,
  }
  return api
}

/** The desk's open things (../open.js), as they change. */
function useOpenItems() {
  const [list, setList] = useState(() => openRegistry().list())
  useEffect(() => { const on = () => setList(openRegistry().list()); window.addEventListener('ruyix:open-things', on); on(); return () => window.removeEventListener('ruyix:open-things', on) }, [])
  return list
}
const AGENT_NAME = { claude: 'Claude', codex: 'Codex', pi: 'pi', dsh: 'dsh', model: 'dsh' }
/**
 * Who works in a window now: the work its open thing belongs to (`of`; the agents' browser while an agent holds it) —
 * its mark and the agent's name in the title bar; amber when it waits for the person (a hand-off: the last click is theirs).
 * Only while someone is at it: a window of work that is done, failed, stopped or queued (a finished run's results, an
 * idle session's files) has nobody driving it, so it says nothing.
 */
function Holder({ work, T }) {
  if (work.state !== 'working' && work.state !== 'waiting') return null
  const a = work.agents?.[0], who = a?.name || AGENT_NAME[a?.kind] || (a?.kind === 'person' ? T.holderYou : T.holderAgent)
  const step = work.segs?.[Number.isInteger(work.cur) && work.cur >= 0 ? work.cur : work.segs.findIndex(s => s.st === 'wait' || s.st === 'run')]?.title
  const text = work.state === 'waiting' ? T.holderWaits(step || work.title) : T.holderWorks(who)
  return <span className="ad-tholder" title={`${work.title} · ${text}`}><WorkMark item={work} size={16} /><span>{text}</span></span>
}

/** One window a plugin opened: a title bar like the page window's, the plugin's Content in its body. */
function XWindow({ w, wins, z, front, lang, T, drag, vw, vh, work }) {
  const I = w.icon || AppWindow
  const r = w.max ? { x: 8, y: BAR + 8, w: vw - 16, h: vh - BAR - 8 - DOCK } : fit(w.rect, vw, vh) // (kept in view when the desk shrinks)
  const grab = e => { if (e.button === 0 && !e.target.closest('button')) drag(e, 'move', w) }
  return (
    <section className={cx('ad-xwin', w.min && 'ad-xwin-min', front && 'ad-front')} data-win={w.id} aria-label={nameOf(w, lang)} aria-hidden={w.min}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: z }} onPointerDownCapture={() => wins.front(w.id)}>
      <div className={cx('ad-titlebar', work?.state === 'waiting' && 'ad-titlebar-wait')} onPointerDown={grab} onDoubleClick={e => !e.target.closest('button') && wins.patch(w.id, { max: !w.max })}>
        <div className="ad-lights">
          <button type="button" className="ad-c" aria-label={T.closeApp} title={T.closeApp} onClick={() => wins.close(w.id)}><X strokeWidth={3} /></button>
          <button type="button" className="ad-m" aria-label={T.minimize} title={T.minimize} onClick={() => wins.patch(w.id, { min: true })}><Minus strokeWidth={3} /></button>
          <button type="button" className="ad-z" aria-label={w.max ? T.restore : T.maximize} title={w.max ? T.restore : T.maximize} onClick={() => wins.patch(w.id, { max: !w.max })}><Maximize2 strokeWidth={3} /></button>
        </div>
        <div className="ad-title"><I size={15} /><span>{nameOf(w, lang)}</span></div>
        <div className="ad-tright">{work && <Holder work={work} T={T} />}</div>
      </div>
      <div className="ad-xwin-body"><Contained><w.Content {...w.props} active={front} lang={lang} /></Contained></div>
      {!w.max && ['r', 'l', 'b', 'br', 'bl'].map(edge => <div key={edge} className="ad-xedge" data-edge={edge} onPointerDown={e => e.button === 0 && drag(e, edge, w)} />)}
    </section>
  )
}

/** Every window a plugin opened, in their stacking order; the moving and sizing (the element follows, kept on let go). */
export function Windows({ wins, lang, T, vw, vh, z: scale = 1 }) {
  const s = useSyncExternalStore(wins.subscribe, wins.get)
  const top = wins.top()
  // who works in each window (its open thing's `of` in the work list)
  const items = useOpenItems(), work = useWork()
  const workOf = id => { const of = items.find(i => i.win === id)?.of; return of ? work.find(x => x.id === of) || null : null }
  const drag = (e, how, w) => {
    e.preventDefault()
    const el = e.currentTarget.closest('.ad-xwin'), sx = e.clientX / scale, sy = e.clientY / scale // (the interface's pixels)
    const start = w.max ? { x: 8, y: BAR + 8, w: vw - 16, h: vh - BAR - 8 - DOCK } : fit(w.rect, vw, vh)
    if (w.max && how === 'move') { Object.assign(start, w.rect, { x: Math.round(sx - w.rect.w * ((sx - start.x) / start.w)) }); wins.patch(w.id, { max: false }) }
    let r = start
    document.documentElement.setAttribute('data-ruyix-moving', '')
    const move = ev => {
      const dx = ev.clientX / scale - sx, dy = ev.clientY / scale - sy, n = { ...start }
      if (how === 'move') { n.x += dx; n.y += dy }
      if (how.includes('r')) n.w += dx
      if (how.includes('l')) { n.w -= dx; n.x += dx }
      if (how.includes('b')) n.h += dy
      r = fit(n, vw, vh)
      if (how.includes('l')) r.x = start.x + start.w - r.w
      Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      document.documentElement.removeAttribute('data-ruyix-moving')
      wins.patch(w.id, { rect: r, max: false, free: true }); keepRect(w.id, r) // (moved by hand: it stays where it was put)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
  }
  return s.list.map(w => <XWindow key={w.id} w={w} wins={wins} z={wins.z(w.id)} front={top === w.id} lang={lang} T={T} drag={drag} vw={vw} vh={vh} work={workOf(w.id)} />)
}

/** The drawer at the room's right edge: the windows put aside when more than four were in view (desktop.json windows
 * 'auto'). Each one an icon; pointed at, the strip pulls out with their titles; a click brings one back (and the least
 * used of those in view goes in instead). `back`: the page window's way back; `mainIcon`: its icon, drawn. */
export const DRAWER_W = 48
export function WinDrawer({ ids, wins, page, mainIcon, lang, T, at, back }) {
  const list = wins.get().list
  return (
    <nav className="ad-wdrawer" aria-label={T.drawerWins} style={{ top: at.y, left: at.x + at.w - DRAWER_W }}>
      {ids.map(id => {
        const w = id === 'main' ? null : list.find(x => x.id === id), I = w?.icon || AppWindow
        const title = id === 'main' ? page?.label || T.desk : (w && nameOf(w, lang)) || id
        return (
          <button key={id} type="button" className="ad-wd-item" title={title} aria-label={title} onClick={() => (id === 'main' ? back() : wins.focus(id))}>
            <span className="ad-wd-icon">{id === 'main' && mainIcon ? mainIcon : <Contained><I size={18} /></Contained>}</span><span className="ad-wd-title">{title}</span>
          </button>
        )
      })}
    </nav>
  )
}

/** window.__ruyixDesk while the desktop is on (and 'ruyix:desk' when it comes or goes). */
export function useDeskApi(wins, on) {
  useEffect(() => {
    if (!on) return
    window.__ruyixDesk = { open: o => wins.open(o), close: id => wins.close(String(id)), focus: id => wins.focus(String(id)), has: id => wins.has(String(id)) }
    window.dispatchEvent(new CustomEvent('ruyix:desk', { detail: { on: true } }))
    // a window called to the front ('ruyix-desk:focus' { win }): the agents' browser handing the person the last click
    const focus = e => { const id = String(e.detail?.win || ''); if (wins.has(id)) wins.focus(id) }
    window.addEventListener('ruyix-desk:focus', focus)
    return () => { window.removeEventListener('ruyix-desk:focus', focus); delete window.__ruyixDesk; window.dispatchEvent(new CustomEvent('ruyix:desk', { detail: { on: false } })) }
  }, [on])
}

/** The windows' tiles in the dock (after the pages): each brings its window back to the front. */
export function useWindowTiles(wins) {
  const s = useSyncExternalStore(wins.subscribe, wins.get)
  return { list: s.list, top: wins.top() }
}
