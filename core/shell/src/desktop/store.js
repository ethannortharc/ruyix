// The desktop's state in this browser: whether the window is shown, maximized, where it is, whether the conversation's
// sheet is open — kept across reloads (localStorage), so a reload comes back to the same desk. What the desktop looks like
// (desktop.json: wallpaper, accent…) is this Ruyix's, read with its layout; this is only where things are here.
const KEY = 'ruyix.desk'
// v2: the interface stopped growing on a large screen, so a place kept before then (as large as that made it) is dropped
const V = 2
const read = () => {
  try {
    const was = JSON.parse(localStorage.getItem(KEY)) || {}
    return was.v === V ? was : { shown: was.shown, max: was.max, chat: was.chat }
  } catch { return {} }
}
const write = s => { try { localStorage.setItem(KEY, JSON.stringify({ v: V, shown: s.shown, max: s.max, rect: s.rect, at: s.at, chat: s.chat })) } catch { /* private window */ } }

/** The desk's geometry: the area between the top bar and the dock (px, the interface's own: scaled with it). */
// (the room kept at the bottom: the dock's own, and the main agent's line above it — ./agentbar.jsx)
export const DOCK_BASE = 92, AGENT_BAR = 48
export const BAR = 34, DOCK = DOCK_BASE + AGENT_BAR, SHEET = 420, GAP = 12, WIDGETS = 272

/** A window's rect kept inside the desk (at least a title bar's worth in view). */
export function fit(r, vw, vh) {
  const top = BAR + 8, bottom = vh - DOCK
  const w = Math.min(Math.max(r.w, 560), vw - 16), h = Math.min(Math.max(r.h, 360), bottom - top)
  const x = Math.min(Math.max(r.x, 120 - w), vw - 120), y = Math.min(Math.max(r.y, top), bottom - 40)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}
/** The largest the page window opens at (interface px): beyond it a page only spreads out; a large desk gets room around it. */
export const ROOMY = { w: 1440, h: 940 }
/**
 * Where the page window sits until it is moved: a small desk is all window; a wide one keeps the widgets' column in
 * view (right) and centres the window in the rest, no larger than ROOMY (a little above the middle, as a Mac opens one).
 */
export const firstRect = (vw, vh) => {
  if (vw < 1180) return fit({ x: 8, y: BAR + 8, w: vw - 16, h: vh - BAR - 8 - DOCK }, vw, vh)
  const side = vw >= 1500 ? WIDGETS + 22 + 20 : 0, top = BAR + 10, room = vh - DOCK - top - 6
  const w = Math.min(vw - side - 48, ROOMY.w), h = Math.min(room, ROOMY.h)
  return fit({ x: Math.round((vw - side - w) / 2), y: top + Math.round((room - h) * 0.4), w, h }, vw, vh)
}
/**
 * A rect kept on a desk of `at` = [w, h], on a desk of vw × vh (the browser grew or shrank): it keeps its size (a window
 * is as large as it was made, not as the screen), smaller only as far as the desk needs, and its middle keeps its place
 * in proportion, the whole window on the desk.
 */
export function follow(r, at, vw, vh) {
  if (!Array.isArray(at) || !(at[0] > 0 && at[1] > 0) || (at[0] === vw && at[1] === vh)) return r
  const top = BAR + 8, bottom = vh - DOCK
  const w = Math.min(r.w, vw - 16), h = Math.min(r.h, bottom - top)
  const cx = (r.x + r.w / 2) * vw / at[0], cy = BAR + (r.y + r.h / 2 - BAR) * (vh - BAR) / (at[1] - BAR)
  const x = Math.min(Math.max(cx - w / 2, 8), vw - 8 - w), y = Math.min(Math.max(cy - h / 2, top), bottom - h)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

export function createDesk() {
  const was = read()
  let s = { shown: was.shown !== false, min: false, max: !!was.max, rect: was.rect || null, at: was.at || null, chat: !!was.chat, palette: false, menu: null }
  const subs = new Set()
  const set = patch => {
    const next = { ...s, ...(typeof patch === 'function' ? patch(s) : patch) }
    if (Object.keys(next).every(k => next[k] === s[k])) return
    s = next
    write(s)
    subs.forEach(f => f())
  }
  return { get: () => s, set, subscribe: f => { subs.add(f); return () => subs.delete(f) } }
}

/**
 * Where n windows go in `area` ({ x, y, w, h }, the interface's pixels), side by side: one large; two halves; three as
 * one tall and two stacked; more in a grid. A gap between them. Pure (checked in node: check.mjs).
 */
/** The windows laid out by themselves (desktop.json windows 'auto'): 1 fills the room, 2 halves, 3 a big one on the left and
 * two stacked, 4 a 2×2 (more go into the drawer first). The first rect is the newest window's. */
export function arrangeRects(n, area, gap = 12) {
  const { x, y, w, h } = area
  if (n <= 0) return []
  if (n === 1) return [{ x, y, w, h }]
  if (n === 4) {
    const cw = Math.floor((w - gap) / 2), ch = Math.floor((h - gap) / 2)
    return [0, 1, 2, 3].map(i => ({ x: x + (i % 2) * (cw + gap), y: y + Math.floor(i / 2) * (ch + gap), w: i % 2 ? w - cw - gap : cw, h: i < 2 ? ch : h - ch - gap }))
  }
  return tileRects(n, area, gap)
}

export function tileRects(n, area, gap = 12) {
  const { x, y, w, h } = area
  if (n <= 0) return []
  if (n === 1) { const ww = Math.min(w, Math.max(720, Math.round(w * 0.9))); return [{ x: x + Math.round((w - ww) / 2), y, w: ww, h }] }
  if (n === 2) { const ww = Math.floor((w - gap) / 2); return [{ x, y, w: ww, h }, { x: x + ww + gap, y, w: w - ww - gap, h }] }
  if (n === 3) {
    const ww = Math.floor((w - gap) * 0.56), hh = Math.floor((h - gap) / 2)
    return [{ x, y, w: ww, h }, { x: x + ww + gap, y, w: w - ww - gap, h: hh }, { x: x + ww + gap, y: y + hh + gap, w: w - ww - gap, h: h - hh - gap }]
  }
  const cols = Math.ceil(Math.sqrt(n * (w / h) / 1.4)), rows = Math.ceil(n / cols)
  const cw = Math.floor((w - gap * (cols - 1)) / cols), ch = Math.floor((h - gap * (rows - 1)) / rows)
  return Array.from({ length: n }, (_, i) => ({ x: x + (i % cols) * (cw + gap), y: y + Math.floor(i / cols) * (ch + gap), w: cw, h: ch }))
}
