// Voice input's key (Ethan, 2026-10-17: it should be one you can set): which key, held or pressed, starts and ends a
// dictation — kept in voice.json (voice.js) so every browser has the same, read by the page (src/desktop/voice.js) and
// set in Settings → General → Voice input. No Node here: the page takes it too.
//   { code: a KeyboardEvent.code ('AltRight', 'F8', 'Space'…), mods: ['ctrl' | 'alt' | 'shift' | 'meta'…], mode: 'hold' | 'toggle' }
//   hold: held down, listening (a short press is not); let go, the words go. toggle: pressed once to start, again to end.
// What may be one, so typing stays typing: a modifier key alone (the right ⌥, the right ⌘…), F1–F24 alone, or a key
// with Ctrl, ⌥ or ⌘ held.

export const HOTKEY_DEFAULT = { code: 'AltRight', mods: [], mode: 'hold' }
const MODS = ['ctrl', 'alt', 'shift', 'meta']
const MOD_KEY = /^(Alt|Control|Meta|Shift)(Left|Right)$/
const FN = /^F([1-9]|1\d|2[0-4])$/

/** A key as set: checked, its modifiers in order. → { ok: true, hotkey } | { ok: false, why: 'code' | 'mode' | 'plain' } */
export function checkHotkey(h) {
  const code = String(h?.code || '')
  if (!/^[A-Za-z0-9]{1,24}$/.test(code)) return { ok: false, why: 'code' }
  const mode = h?.mode || 'hold'
  if (!['hold', 'toggle'].includes(mode)) return { ok: false, why: 'mode' }
  const mods = MOD_KEY.test(code) ? [] : MODS.filter(m => (h?.mods || []).includes(m))
  if (!MOD_KEY.test(code) && !FN.test(code) && !mods.some(m => m !== 'shift')) return { ok: false, why: 'plain' }
  return { ok: true, hotkey: { code, mods, mode } }
}

/** The modifiers a key event has (its own key's aside: holding the right ⌥ is not ⌥ + something). */
const modsOf = e => MODS.filter(m => e[`${m}Key`] && !(MOD_KEY.test(e.code) && e.code.toLowerCase().startsWith(m === 'ctrl' ? 'control' : m)))
/** Is this key event the key (its code, with exactly its modifiers)? */
export const isHotkey = (e, h) => e.code === h.code && modsOf(e).join() === h.mods.join()
/** A key event as a key to set (Settings' "press the key"): → the hotkey in `mode` (a modifier key: that key alone). */
export function hotkeyOf(e, mode = 'hold') {
  if (MOD_KEY.test(e.code)) return { code: e.code, mods: [], mode }
  return { code: e.code, mods: modsOf(e), mode }
}

const SIDE = { zh: { Left: '左', Right: '右' }, en: { Left: 'left ', Right: 'right ' } }
const NAMES = { Space: { zh: '空格', en: 'Space' }, Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Enter: { zh: '回车', en: 'Enter' }, Escape: 'Esc', Tab: 'Tab', CapsLock: 'Caps Lock' }
/** How the key reads: "按住 右 ⌥" / "Hold right ⌥"; "⌘⇧ Space" (`bare`: the key alone). `mac`: the Mac's signs, else Ctrl/Alt/Win. */
export function hotkeyLabel(h, { lang = 'zh', mac = true, bare = false } = {}) {
  const sign = { ctrl: mac ? '⌃' : 'Ctrl+', alt: mac ? '⌥' : 'Alt+', shift: mac ? '⇧' : 'Shift+', meta: mac ? '⌘' : 'Win+' }
  const m = MOD_KEY.exec(h.code)
  const key = m ? `${SIDE[lang === 'zh' ? 'zh' : 'en'][m[2]]}${lang === 'zh' ? ' ' : ''}${mac ? { Alt: '⌥', Control: '⌃', Meta: '⌘', Shift: '⇧' }[m[1]] : { Alt: 'Alt', Control: 'Ctrl', Meta: 'Win', Shift: 'Shift' }[m[1]]}`
    : h.code.startsWith('Key') ? h.code.slice(3) : h.code.startsWith('Digit') ? h.code.slice(5)
      : typeof NAMES[h.code] === 'object' ? NAMES[h.code][lang === 'zh' ? 'zh' : 'en'] : NAMES[h.code] || h.code
  const combo = `${h.mods.map(x => sign[x]).join('')}${h.mods.length && mac ? ' ' : ''}${key}`
  return bare || h.mode === 'toggle' ? combo : lang === 'zh' ? `按住 ${combo}` : `Hold ${combo}`
}
