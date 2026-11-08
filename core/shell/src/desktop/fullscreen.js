// Full screen: the whole page on the whole screen — the browser's tabs and address bar and the Mac's menu bar out of the
// way, Ruyix's own top bar the only one, like an operating system. The Fullscreen API on the page (WebKit's prefixed
// one in an older Safari); a browser allows it only from a click or a key, so it is a button, a menu item and ⌃⌘F.
// While full screen, Chrome and Edge also lock the keys a browser would take for itself (the Keyboard Lock API): ⌘W, ⌘T
// and ⌘N reach Ruyix and its apps instead of closing the tab or opening another, and Esc closes a menu instead of the
// full screen (holding Esc leaves it, the browser says so). Safari and Firefox have no keyboard lock: Esc leaves there.
const LOCKED = ['Escape', 'KeyW', 'KeyT', 'KeyN']

const doc = () => (typeof document === 'undefined' ? null : document)

/** Whether this browser can put the page on the whole screen (not an iPhone's Safari, not a frame that forbids it). */
export const canFullscreen = () => { const d = doc(); return !!(d && (d.fullscreenEnabled || d.webkitFullscreenEnabled)) }

/** Whether the page is on the whole screen now. */
export const isFullscreen = () => { const d = doc(); return !!(d && (d.fullscreenElement || d.webkitFullscreenElement)) }

/** Calls `f` whenever the page enters or leaves full screen (→ unsubscribe). */
export function subscribeFullscreen(f) {
  const d = doc()
  if (!d) return () => {}
  d.addEventListener('fullscreenchange', f)
  d.addEventListener('webkitfullscreenchange', f)
  return () => { d.removeEventListener('fullscreenchange', f); d.removeEventListener('webkitfullscreenchange', f) }
}

/** Enter full screen, or leave it. Resolves to whether the page is full screen after; a browser that refused says nothing. */
export async function toggleFullscreen() {
  const d = doc()
  if (!d) return false
  try {
    if (isFullscreen()) {
      await (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.())
      return false
    }
    const el = d.documentElement
    // (no navigation UI: on a phone or tablet that would draw its own bar over the top bar)
    await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.())
    // the keys the browser would take; let go of by the browser itself when the page leaves full screen
    try { await navigator.keyboard?.lock?.(LOCKED) } catch { /* not allowed here: the browser keeps them */ }
  } catch { /* refused (not from a click, or not allowed in this frame) */ }
  return isFullscreen()
}
