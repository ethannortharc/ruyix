// The themes (../../desktop.js THEMES) as cards to choose from: each its wallpaper with a small window over it in the
// theme's tint, corners and accent, light or dark as the theme is — the top bar's appearance menu and Settings → General.
// Choosing one writes its keys (themePatch) and puts this browser in its light or dark; a key changed after it keeps the
// theme, said under its name.
import { useEffect, useRef } from 'react'
import { ACCENTS, CORNERS, THEMES, TINTS, WALLPAPERS, themeOf, themePatch } from '../../desktop.js'
import { paintThumb } from './wallpaper.js'

const cx = (...c) => c.filter(Boolean).join(' ')
// Ruyix's own grounds (tokens.css), for a theme with the neutral tint: [light, dark]
const NEUTRAL = { '--ruyix-surface': ['#ffffff', '#2b333f'], '--ruyix-line': ['#dfe4eb', '#424e5e'], '--ruyix-text-dim': ['#5d6d82', '#9eacc0'] }

/** The small window's colours for a theme, in its own light or dark (light when it leaves that to the browser). */
function windowOf(th) {
  const i = th.appearance === 'dark' ? 1 : 0, tint = TINTS[th.tint] || {}, pick = n => (tint[n] || NEUTRAL[n])[i]
  const a = ACCENTS.find(x => x.id === th.accent)
  return { '--th-surface': pick('--ruyix-surface'), '--th-line': pick('--ruyix-line'), '--th-dim': pick('--ruyix-text-dim'), '--th-accent': i ? a.dark : a.light, '--th-r': `${Math.round(5 * CORNERS[th.corners])}px` }
}

/** Choose a theme: its keys through `save` (the page's setDesktop), and this browser's light or dark to the theme's. */
export function chooseTheme(id, save, look) {
  const patch = themePatch(id), th = THEMES.find(x => x.id === id)
  if (!patch) return
  save(patch)
  if (th.appearance) look?.set(th.appearance)
}

/** The cards. `T` has theme, themeChanged(keys) and keyNames; `small`: the top bar's menu (three a row). */
export function ThemeCards({ lang, T, desktop, onPick, small = false }) {
  const ref = useRef(null)
  useEffect(() => { ref.current?.querySelectorAll('canvas[data-w]').forEach(c => paintThumb(c, c.dataset.w)) }, [])
  const { theme, changed } = themeOf(desktop)
  return (
    <div className={cx('ruyix-themes', small && 'ruyix-themes-sm')} ref={ref} role="radiogroup" aria-label={T.theme}>
      {THEMES.map(th => {
        const on = theme?.id === th.id, w = WALLPAPERS.find(x => x.id === th.wallpaper)
        return (
          <button key={th.id} type="button" role="radio" aria-checked={on} className={cx('ruyix-theme', on && 'ruyix-on')} onClick={() => onPick(th.id)}
            title={on && changed.length ? T.themeChanged(changed.map(k => T.keyNames[k]).join(lang === 'zh' ? '、' : ', ')) : th[lang]}>
            <span className="ruyix-theme-pv">
              <canvas data-w={th.wallpaper} style={{ background: `linear-gradient(160deg, ${w.c[1]}, ${w.c[0]})` }} />
              <span className="ruyix-theme-win" style={windowOf(th)}><i /><i /><i /><b /></span>
            </span>
            <span className="ruyix-theme-name">{th[lang]}{on && changed.length > 0 && <small>{T.changedShort}</small>}</span>
          </button>
        )
      })}
    </div>
  )
}
