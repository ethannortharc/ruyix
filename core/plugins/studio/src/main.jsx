// The studios' pages (docs/design/studio.md): the home page of each studio, laid out from its declaration (./page.jsx,
// its blocks ./views.jsx), each with its entry in the nav's Apps group — a page `ruyix-studio-<id>` per studio, added
// and taken away as the studios come and go. And the studios as the rest of the page knows them without importing this
// plugin — window.__ruyixStudios = [{ id, name, icon }] and the 'ruyix:studio' event (src/data.js) — for the strip's
// studio chip and the maps' places.
import css from './styles.css'
import { EVENT, call } from './data.js'
import { startDue } from './due.js'
import { catchFocus } from './focus.js'
import { studioIcon } from './icons.js'
import { StudioPage, langOf } from './page.jsx'
import { say } from './text.js'

export * from './data.js'
export { STUDIO_ICONS, studioIcon } from './icons.js'

export const inject = ['slots', 'locale']
/** A studio's page id (its nav entry's, and `page:<it>` in the open things). */
export const pageOf = id => `ruyix-studio-${id}`

async function publish() {
  try {
    const { studios } = await call('studios')
    if (JSON.stringify(studios) !== JSON.stringify(window.__ruyixStudios || [])) {
      window.__ruyixStudios = studios
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { studio: null, collection: null } }))
    }
  } catch { /* the next look */ }
}


export function apply(ctx) {
  ctx.effect(() => {
    publish()
    // (a studio added or gone — a pack turned on or off: said by the data poll; else a slow look of its own)
    const on = e => { if (e.detail?.studio === null) publish() }
    window.addEventListener(EVENT, on)
    const timer = setInterval(publish, 60000)
    return () => { clearInterval(timer); window.removeEventListener(EVENT, on); delete window.__ruyixStudios }
  }, 'ruyix-studio: the studios for the page')
  // the pages' look, once in the document (the dialogs and notes are drawn over the page)
  ctx.effect(() => {
    const el = Object.assign(document.createElement('style'), { textContent: css })
    el.dataset.ruyixStudio = ''
    document.head.appendChild(el)
    return () => el.remove()
  }, 'ruyix-studio: styles')
  const lang = () => langOf(ctx.locale)
  // a page and a nav entry for each studio, as they come and go (each slot keeps its own; taken away with the plugin)
  for (const slot of ['main', 'sidebar.panellist']) {
    ctx.slots.inject(slot, () => {
      const regs = new Map()
      const drop = off => { try { (typeof off === 'function' ? off : off?.dispose)?.call(off) } catch { /* gone already */ } }
      const sync = () => {
        const list = window.__ruyixStudios || []
        for (const [id, off] of regs) if (!list.some(s => s.id === id)) { drop(off); regs.delete(id) }
        for (const s of list) {
          if (regs.has(s.id)) continue
          const Icon = studioIcon(s.icon)
          regs.set(s.id, slot === 'main'
            ? ctx.slots.register({ name: 'main', key: pageOf(s.id), inject: () => ({ studioId: s.id, locale: ctx.locale }) }, StudioPage)
            : ctx.slots.register({ name: 'sidebar.panellist', id: pageOf(s.id), order: 24, label: () => say(s.name, lang()) }, ({ size }) => <Icon size={size || 16} strokeWidth={1.6} />))
        }
      }
      sync()
      window.addEventListener(EVENT, sync)
      return () => { window.removeEventListener(EVENT, sync); for (const off of regs.values()) drop(off); regs.clear() }
    })
  }
  // records whose time has come, on the desk as work waiting for the person (src/due.js)
  ctx.effect(() => startDue(lang), 'ruyix-studio: what is due')
  ctx.effect(() => catchFocus(), 'ruyix-studio: landing on a record')
}
