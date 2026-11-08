// Text typed into an app on its display, as X keysyms: each character the keysym that means it. TigerVNC's Xvnc gives a
// character its keyboard has no key for (Chinese, say) a spare key code of its own, so any app takes it as typed. This
// is how the Mac's input method, a paste and dictation reach an app (vnc.jsx).
// Xvnc has about 19 spare key codes and lends them round and round; an app reads a key code with the meaning it has
// when the app gets to it, so a burst with more new characters than that comes out as the last ones. Such a text goes
// through the clipboard instead (pasted with Shift+Insert): viaClipboard.

export const XK_RETURN = 0xff0d
export const XK_TAB = 0xff09

/** The keysym for one character (0: not typed — a control character). Latin-1 keeps its own code, the rest are Unicode keysyms. */
export function keysymOf(ch) {
  if (ch === '\n') return XK_RETURN
  if (ch === '\t') return XK_TAB
  const c = ch.codePointAt(0)
  if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return 0
  return c < 0x100 ? c : 0x01000000 + c
}

/** The keysyms of a text, in order (a Windows or old Mac line end is one Return). */
export const keysymsOf = text => [...String(text ?? '').replace(/\r\n?/g, '\n')].map(keysymOf).filter(Boolean)

/** The most characters needing a spare key code (distinct, beyond ASCII) that one text may type; more go by clipboard. */
export const SPARE = 16
const spare = k => k > 0x7e && (k < 0xff00 || k > 0xffff) // not on the display's US keyboard (Return, Tab… are)

/** Whether these keysyms should reach the app as a paste rather than typed, one by one. */
export const viaClipboard = ks => new Set(ks.filter(spare)).size > SPARE

/**
 * Whether a key press carries text that noVNC would send wrong, so the browser should put it in the input box instead
 * (and from there it is typed): several characters at once (dictation that types, like Fonos) or one character that is
 * not plain ASCII (noVNC sends where the key sits, and the display's US keyboard reads another character there).
 * Shortcuts (⌃ ⌘ ⌥ held) and named keys (`named(key)`: Enter, ArrowLeft…) stay noVNC's.
 */
export function isTextKey(e, named) {
  const k = e.key
  if (typeof k !== 'string' || !k || e.ctrlKey || e.metaKey || e.altKey || named(k)) return false
  const chars = [...k]
  return chars.length > 1 || chars[0].codePointAt(0) > 0x7e
}
