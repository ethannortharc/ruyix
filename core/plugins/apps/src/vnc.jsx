// VncView: one app's display, drawn straight into the page by noVNC (no iframe). It fills its box; the X display follows
// the box's size (resizeSession), so the app is always drawn 1:1. A dropped connection is tried again once while the
// session lives; a session that ended says so. The app's clipboard reaches the browser's.
// The keyboard goes through a text box over the screen, not noVNC's canvas: the Mac's input method only works in a
// text box. Keys go on to the app as noVNC sends them; text (the input method's Chinese, ⌘V, dictation) is typed into
// the app character by character (keys.js). While a word is being composed the box shows it where the app was clicked.
// ⌘ is the Mac's: it never reaches the app itself; ⌘+key becomes the app's shortcut (⌃+key; ⌘←/→ Home/End; in a
// terminal only ⌘C, sent as its copy key ⌃⇧C — its ⌃C stops the program).
import { useEffect, useRef, useState } from 'react'
import { isTextKey, keysymsOf, viaClipboard } from './keys.js'
import { word } from './locale.js'
// noVNC is bundled but loaded on first use: its modules test the browser (document, WebCodecs) when they load. Its
// keyboard and key table are reached past the package's exports (build.mjs resolves them).
const loadNovnc = () => Promise.all([import('@novnc/novnc'), import('@novnc/novnc/core/input/keyboard.js'), import('@novnc/novnc/core/input/domkeytable.js')])
  .then(([rfb, kb, table]) => ({ RFB: sharp(rfb.default), Keyboard: kb.default, KEYS: table.default }))

/**
 * noVNC drawing a display of `pixels` X pixels per page pixel: it asks for `pixels` times its box's size and draws it
 * at 1/pixels, so a Retina screen shows the app pixel for pixel (its mouse follows: noVNC divides by what it draws at).
 * Two of noVNC's own methods (1.7.0), overridden.
 */
const sharp = RFB => class extends RFB {
  _screenSize() { const s = super._screenSize(), k = this.pixels || 1; return { w: s.w * k, h: s.h * k } }
  _updateScale() { this._display.scale = 1 / (this.pixels || 1); this._fixScrollbars() }
}

/** How sharp this browser draws an app: the App Center's choice (this browser's), else 2 on a Retina screen. */
export const PIXELS_KEY = 'ruyix.apps.pixels'
export const pixelsChoice = () => { try { return localStorage.getItem(PIXELS_KEY) || 'auto' } catch { return 'auto' } }
export const pixelsNow = () => { const c = pixelsChoice(); return c === '1' ? 1 : c === '2' ? 2 : (window.devicePixelRatio || 1) >= 1.5 ? 2 : 1 }

export const VNC_PATH = 'ruyix-apps/vnc'
/** The display's WebSocket, beside the page like the API (relative: a dsh served under a path prefix works too). */
export function vncUrl(session) {
  const u = new URL(`${VNC_PATH}?s=${encodeURIComponent(session)}`, document.baseURI)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.href
}

/**
 * { session, active, lang, alive(session) → Promise<boolean>, onEnded?, onCloseWindow? } — `alive` asks the host
 * whether the session still runs (after a drop: reconnect, or say the app has closed).
 */
export function VncView({ session, active, lang = 'zh', alive, onCloseWindow, terminal = false, pixels = 1 }) {
  const box = useRef(null), rfb = useRef(null), ime = useRef(null), composing = useRef(false)
  const [compose, setCompose] = useState(false)
  const [at, setAt] = useState({ x: 24, y: 24 }) // where the input box sits: the last click in the app
  const [status, setStatus] = useState('connecting') // connecting | live | reconnecting | ended | lost
  const [round, setRound] = useState(0) // a new value connects again
  const tries = useRef(0)
  useEffect(() => { tries.current = 0 }, [session])
  useEffect(() => {
    if (!box.current || !session) return
    let gone = false, connectedAt = 0, r = null, keys = null
    if (status === 'ended' || status === 'lost') setStatus('connecting') // a new session in the same window
    const connect = ({ RFB, Keyboard, KEYS }) => {
      r = new RFB(box.current, vncUrl(session), { shared: true, wsProtocols: ['binary'] })
      rfb.current = r
      r.pixels = pixels === 2 ? 2 : 1 // (as the session was started: its apps are scaled for it)
      r.resizeSession = true // the X display takes the window's size
      r.scaleViewport = false // (drawn at 1/pixels: sharp)
      r.clipViewport = false
      r.focusOnClick = false // the input box takes the keyboard, not the canvas
      r.background = 'transparent'
      keys = textBox(ime.current, r, { Keyboard, named: k => k in KEYS || k === 'Unidentified' || k === 'Process' || k === 'Dead', composing, setCompose, terminal })
      r.addEventListener('connect', () => { connectedAt = Date.now(); setStatus('live') })
      r.addEventListener('clipboard', e => { navigator.clipboard?.writeText?.(e.detail.text).catch(() => { /* the page is not focused, or no permission */ }) })
      r.addEventListener('disconnect', async () => {
        if (gone) return
        rfb.current = null
        // a connection that held for a while may be tried again once more
        if (connectedAt && Date.now() - connectedAt > 10000) tries.current = 0
        const live = await Promise.resolve(alive?.(session)).catch(() => true)
        if (gone) return
        if (!live) { setStatus('ended'); return }
        if (tries.current >= 1) { setStatus('lost'); return }
        tries.current += 1
        setStatus('reconnecting')
        setTimeout(() => { if (!gone) setRound(n => n + 1) }, 800)
      })
    }
    loadNovnc().then(m => { if (!gone && box.current && ime.current) connect(m) }, err => { if (!gone) { console.error('apps: noVNC did not load', err); setStatus('lost') } })
    return () => { gone = true; rfb.current = null; keys?.(); try { r?.disconnect() } catch { /* already gone */ } }
  }, [session, round])
  // the window coming to the front: the keyboard goes to the app
  useEffect(() => { if (active && status === 'live') ime.current?.focus({ preventScroll: true }) }, [active, status])
  // a click in the app: the keyboard comes back to it, and a word being composed shows there (where its cursor likely
  // is). On the way down (capture): noVNC stops the click at its canvas.
  const press = e => {
    const b = box.current?.getBoundingClientRect()
    if (b && !composing.current) setAt({ x: Math.max(4, Math.min(e.clientX - b.left, b.width - 160)), y: Math.max(4, Math.min(e.clientY - b.top - 14, b.height - 34)) })
    e.preventDefault() // (the click would otherwise take the focus off the input box)
    ime.current?.focus({ preventScroll: true })
  }
  const w = k => word(lang, k)
  return (
    <div className="ap-vnc">
      <div className="ap-vnc-screen" ref={box} onMouseDownCapture={press} />
      <textarea ref={ime} className={compose ? 'ap-vnc-ime ap-vnc-ime-on' : 'ap-vnc-ime'} style={{ left: at.x, top: at.y }} rows={1} aria-label={w('vnc.typeHere')}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} tabIndex={-1} data-ruyix-keys="app" />
      {status !== 'live' && (
        <div className="ap-vnc-note" role="status">
          <span>{w(`vnc.${status}`)}</span>
          {status === 'lost' && <button className="ap-btn" onClick={() => { tries.current = 0; setStatus('connecting'); setRound(n => n + 1) }}>{w('vnc.retry')}</button>}
          {status === 'ended' && onCloseWindow && <button className="ap-btn" onClick={onCloseWindow}>{w('vnc.closeWindow')}</button>}
        </div>
      )}
    </div>
  )
}

const XK_SHIFT_L = 0xffe1, XK_INSERT = 0xff63, XK_HOME = 0xff50, XK_END = 0xff57
const CTRL = [0xffe3, 'ControlLeft'], SHIFT = [XK_SHIFT_L, 'ShiftLeft']
const GATHER_MS = 15 // text arriving this close together is one text
const CLIP_MS = 400 // after a paste, the next text waits this long

/**
 * The input box's keyboard: keys go to noVNC's own keyboard handling (its Keyboard, fed from here), except what the
 * browser should handle — the input method composing, ⌘V pasting, a key that carries text noVNC would send wrong
 * (isTextKey). Text that lands in the box is typed into the app and the box emptied. Returns the undo.
 */
function textBox(el, r, { Keyboard, named, composing, setCompose, terminal }) {
  // noVNC's Keyboard listens on a target: this one hands its listeners to us, so we choose what it sees
  const to = {}
  const kb = new Keyboard({ addEventListener: (t, f) => { to[t] = f }, removeEventListener: t => { delete to[t] } })
  kb.onkeyevent = (keysym, code, down) => r.sendKey(keysym, code, down)
  kb.grab()
  const letGo = () => { kb.ungrab(); kb.grab() } // every key the app thinks is held is let go (ungrab sends the releases)
  const composingKey = e => composing.current || e.isComposing || e.keyCode === 229 // (229: a key the input method took)
  // text is gathered a moment (dictation types a sentence as several quick pieces), then sent in one go; a key for
  // noVNC sends what is gathered first, so the order holds
  let gathered = '', timer = 0, clipFree = 0
  const send = (now = false) => {
    clearTimeout(timer); timer = 0
    const text = gathered.replace(/\r\n?/g, '\n'), ks = keysymsOf(text)
    if (!ks.length) { gathered = ''; return }
    // after a paste, the app fetches the clipboard a moment after Shift+Insert: the next text waits for that (in order)
    if (!now && Date.now() < clipFree) { timer = setTimeout(send, clipFree - Date.now()); return }
    gathered = ''
    const clip = viaClipboard(ks)
    letGo() // ⌘ is the app's Alt: text typed with ⌘ still held (⌘V) would arrive as Alt+…
    if (clip) {
      r.clipboardPasteFrom(text)
      r.sendKey(XK_SHIFT_L, 'ShiftLeft', true); r.sendKey(XK_INSERT, 'Insert'); r.sendKey(XK_SHIFT_L, 'ShiftLeft', false)
      clipFree = Date.now() + CLIP_MS
    } else for (const k of ks) { r.sendKey(k, 'Unidentified', true); r.sendKey(k, 'Unidentified', false) } // (no scancode: the keysym is what counts)
  }
  // a key pressed with modifiers held for it (the modifiers let go after, in reverse)
  const chord = (keysym, code, mods) => {
    for (const [k, c] of mods) r.sendKey(k, c, true)
    r.sendKey(keysym, code, true); r.sendKey(keysym, code, false)
    for (const [k, c] of [...mods].reverse()) r.sendKey(k, c, false)
  }
  // ⌘+key → the app's shortcut. Not ⌘V (the browser pastes), nor what the desktop took already (⌘K, ⌘,)
  const shortcut = e => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.code === 'KeyV' || e.defaultPrevented) return
    e.preventDefault() // (not the browser's: save the page, find, print…)
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') return chord(e.code === 'ArrowLeft' ? XK_HOME : XK_END, e.code === 'ArrowLeft' ? 'Home' : 'End', [])
    // (the keysym must say what the modifiers make: Xvnc gives the app exactly that keysym, letting go of Shift for a
    // lower-case one — ⌃⇧c would arrive as ⌃c, which stops a terminal's program)
    if (terminal) { if (e.code === 'KeyC') chord(0x43, 'KeyC', e.shiftKey ? [CTRL] : [CTRL, SHIFT]); return }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') return chord(e.code === 'ArrowUp' ? XK_HOME : XK_END, e.code === 'ArrowUp' ? 'Home' : 'End', [CTRL])
    // Shift, if held, is held in the app already (⌘⇧Z is ⌃⇧Z): a letter's keysym is its capital then
    const k = e.key.length === 1 ? e.key : '', letter = /^[a-z]$/i.test(k)
    const ch = letter ? (e.shiftKey ? k.toUpperCase() : k.toLowerCase()).codePointAt(0) : k.codePointAt(0) || 0
    if (ch > 0x20 && ch < 0x7f) chord(ch, e.code, [CTRL])
  }
  const flush = () => {
    const t = el.value
    el.value = ''
    if (!t) return
    gathered += t
    clearTimeout(timer)
    timer = setTimeout(send, GATHER_MS)
  }
  const on = {
    keydown: e => {
      if (composingKey(e) || (e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyV') || isTextKey(e, named)) return
      if (gathered) send(true)
      if (e.code === 'MetaLeft' || e.code === 'MetaRight') return // ⌘ alone: nothing for the app
      if (e.metaKey) { shortcut(e); return }
      to.keydown?.(e)
    },
    keyup: e => { if (!composingKey(e) && e.code !== 'MetaLeft' && e.code !== 'MetaRight') to.keyup?.(e) },
    compositionstart: () => { composing.current = true; setCompose(true) },
    compositionend: () => { composing.current = false; setCompose(false); flush() },
    input: e => { if (!e.isComposing && !composing.current) flush() },
    blur: () => { letGo(); if (!composing.current) el.value = '' },
  }
  for (const [t, f] of Object.entries(on)) el.addEventListener(t, f)
  return () => {
    for (const [t, f] of Object.entries(on)) el.removeEventListener(t, f)
    if (gathered) send(true)
    clearTimeout(timer)
    kb.ungrab()
    composing.current = false
    setCompose(false)
  }
}
